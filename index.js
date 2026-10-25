/**
 * dsh-session-reaper — 宿主半边。
 *
 * 依据真实探测到的宿主 API 编写（见 dsh-probe-results.log）：
 *   - workspaceRegistry.list() -> WorkspaceEntity[]，实体上有 detachSession(id) / attachSession(id)
 *   - workspaceRegistry.stopSessionActivity(id)
 *   - sessionPersistence.root / list() / flush() / locate(id)
 *   - webServer.register(options) + connection.requestRejection(req)
 *
 * 设计约束（改动前请先读 README）：
 *   1. 不注册任何 HTTP 路由以外的入口，不给模型注册任何工具；
 *   2. 会话日志只「移入回收站」，代码里不存在删除会话目录的路径，
 *      除非用户从回收站面板显式「彻底删除」；
 *   3. 文件操作对象必须落在 sessionsRoot 或回收站之内；
 *   4. 每个依赖单独 ctx.inject 声明 —— 一次性声明多个时，任一服务缺失
 *      会让整个插件被 Cordis 拒绝挂载，探测阶段已经踩过这个坑；
 *   5. apply 全程 try/catch，本插件任何故障都不得影响 DSH 启动。
 *
 * @module dsh-session-reaper
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'session-reaper'
export const inject = []

/** 所有端点的命名空间。 */
export const ROUTE_BASE = '/dsh-session-reaper'

const SESSION_ID_RE = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return error.message ?? String(error)
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** 判断 child 是否严格位于 parent 之内。 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function directoryBytes(dir) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) total += directoryBytes(full)
      else total += fs.statSync(full).size
    } catch {
      /* 量体积失败不影响删除 */
    }
  }
  return total
}

/**
 * 回收站：
 *   <root>/index.json         条目索引
 *   <root>/entries/<entryId>/ 移过来的会话目录
 * entryId = `<ISO时间戳>__<sessionId>`
 */
class RecycleBin {
  constructor(root) {
    this.root = root
    this.entriesDir = path.join(root, 'entries')
    this.indexFile = path.join(root, 'index.json')
  }

  ensure() {
    fs.mkdirSync(this.entriesDir, { recursive: true })
  }

  readIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  writeIndex(entries) {
    this.ensure()
    const temp = this.indexFile + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(entries, null, 2), 'utf8')
    fs.renameSync(temp, this.indexFile)
  }

  add(entry) {
    const entries = this.readIndex().filter((item) => item.entryId !== entry.entryId)
    entries.push(entry)
    this.writeIndex(entries)
  }

  remove(entryId) {
    this.writeIndex(this.readIndex().filter((item) => item.entryId !== entryId))
  }

  list() {
    let present = []
    try {
      present = fs.readdirSync(this.entriesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
    const indexed = new Map(this.readIndex().map((item) => [item.entryId, item]))
    return present
      .map((entryId) => {
        const stored = indexed.get(entryId) ?? {}
        const bytes = typeof stored.bytes === 'number'
          ? stored.bytes
          : directoryBytes(path.join(this.entriesDir, entryId))
        return {
          entryId,
          sessionId: stored.sessionId ?? entryId.split('__').slice(1).join('__'),
          title: stored.title ?? '',
          workspacePath: stored.workspacePath ?? '',
          workspaceId: stored.workspaceId ?? null,
          deletedAt: stored.deletedAt ?? '',
          bytes,
        }
      })
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
  }

  entryDir(entryId) {
    const full = path.join(this.entriesDir, entryId)
    if (!isInside(this.entriesDir, full)) throw new Error('rejected: entry escapes the recycle bin')
    return full
  }

  has(entryId) {
    try {
      return fs.statSync(this.entryDir(entryId)).isDirectory()
    } catch {
      return false
    }
  }
}

class Reaper {
  constructor(options) {
    this.registry = options.registry
    this.persistence = options.persistence
    this.sessionsRoot = path.resolve(options.sessionsRoot)
    this.bin = new RecycleBin(options.recycleBinRoot)
    this.log = options.log
  }

  /** 从持久化层拿到全部会话行（含 header.cwd 与 sizeBytes）。 */
  async rows() {
    if (!this.persistence || typeof this.persistence.list !== 'function') return []
    try {
      const rows = await this.persistence.list()
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      this.log('persistence.list() failed: ' + messageOf(error))
      return []
    }
  }

  async rowFor(sessionId) {
    const wanted = new Set([sessionId, sessionId.startsWith('session-') ? sessionId.slice(8) : 'session-' + sessionId])
    const rows = await this.rows()
    return rows.find((row) => row && row.header && wanted.has(String(row.header.id)))
  }

  /**
   * 定位会话在磁盘上的目录。
   * 先用持久化层的 locate()，失败再在 sessionsRoot 下按 id 扫描。
   */
  async findDir(sessionId) {
    if (this.persistence && typeof this.persistence.locate === 'function') {
      try {
        const located = await this.persistence.locate(sessionId)
        const candidate = typeof located === 'string'
          ? located
          : located && typeof located.dir === 'string'
            ? located.dir
            : located && typeof located.directory === 'string'
              ? located.directory
              : undefined
        if (typeof candidate === 'string' && fs.existsSync(candidate)) {
          const dir = fs.statSync(candidate).isDirectory() ? candidate : path.dirname(candidate)
          if (isInside(this.sessionsRoot, dir)) return dir
        }
      } catch {
        /* 退回扫描 */
      }
    }

    const row = await this.rowFor(sessionId)
    const wanted = new Set()
    for (const id of [sessionId, row && row.header && row.header.id]) {
      if (typeof id !== 'string') continue
      wanted.add(id)
      wanted.add(id.startsWith('session-') ? id.slice(8) : 'session-' + id)
    }

    let projects = []
    try {
      projects = fs.readdirSync(this.sessionsRoot, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const projectDir = path.join(this.sessionsRoot, project.name)
      let sessionDirs = []
      try {
        sessionDirs = fs.readdirSync(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue
        if (wanted.has(sessionDir.name)) return path.join(projectDir, sessionDir.name)
      }
    }
    return undefined
  }

  workspaceOf(sessionId) {
    if (!this.registry || typeof this.registry.list !== 'function') return undefined
    const wanted = new Set([sessionId, sessionId.startsWith('session-') ? sessionId.slice(8) : 'session-' + sessionId])
    for (const workspace of this.registry.list()) {
      const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      if (ids.some((id) => wanted.has(String(id)))) return workspace
    }
    return undefined
  }

  /** 停掉会话上仍在运行的工作，再把待写数据落盘。 */
  async quiesce(sessionId, canonicalId) {
    const notes = []
    const target = canonicalId ?? sessionId
    if (this.registry && typeof this.registry.stopSessionActivity === 'function') {
      for (const id of new Set([target, sessionId])) {
        try {
          await this.registry.stopSessionActivity(id)
          notes.push('stopped session activity (' + id + ')')
          break
        } catch (error) {
          notes.push('stopSessionActivity(' + id + '): ' + messageOf(error))
        }
      }
    }
    if (this.persistence && typeof this.persistence.flush === 'function') {
      try {
        await this.persistence.flush()
        notes.push('flushed persistence')
      } catch (error) {
        notes.push('flush: ' + messageOf(error))
      }
    }
    return notes
  }

  /**
   * 把会话计入归档集合。
   *
   * 归档只影响「可见性」，不会移动日志、也不改 workspace 记账，
   * 所以它可以在删除流程里安全地当一个「让界面立刻别再显示它」的开关用。
   * 失败不算致命：最坏情况是界面上暂时多一个未分组条目，重启后自愈。
   */
  async archiveSession(sessionId) {
    const notes = []
    if (!this.registry) {
      notes.push('no registry; skipped archiving')
      return notes
    }
    if (typeof this.registry.archiveSession !== 'function') {
      notes.push('registry has no archiveSession(); skipped archiving')
      return notes
    }
    try {
      await this.registry.archiveSession(sessionId)
      notes.push('archived ' + sessionId + ' so the client hides it immediately')
    } catch (error) {
      notes.push('archive skipped (' + messageOf(error) + '); the row may linger as ungrouped until restart')
    }
    return notes
  }

  /** 恢复时把会话从归档集合里摘掉，否则它仍然不可见。 */
  async unarchiveSession(sessionId) {
    const notes = []
    if (!this.registry || typeof this.registry.unarchiveSession !== 'function') {
      notes.push('registry has no unarchiveSession(); skipped')
      return notes
    }
    try {
      await this.registry.unarchiveSession(sessionId)
      notes.push('unarchived ' + sessionId)
    } catch (error) {
      notes.push('unarchive skipped (' + messageOf(error) + ')')
    }
    return notes
  }

  moveIntoBin(dir, entryId) {    const target = this.bin.entryDir(entryId)
    this.bin.ensure()
    if (fs.existsSync(target)) throw new Error('recycle bin already holds ' + entryId)
    try {
      fs.renameSync(dir, target)
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        fs.cpSync(dir, target, { recursive: true, dereference: false })
        fs.rmSync(dir, { recursive: true, force: true })
      } else {
        throw error
      }
    }
    return target
  }

  /**
   * 删除一个会话。
   *
   * 顺序必须固定：先停活动、刷盘、移走日志，最后才解绑记账。
   * WorkspaceRegistry.bootstrap() 在启动时会按 cwd 重新枚举持久化层里的 header
   * 给工作区记账；日志目录先消失，下次启动就扫不到它，不会被复活。
   * 反过来先解绑再移目录，中途崩溃会让这个会话在下次启动时重新挂回去。
   */
  async remove(sessionId) {
    const raw = String(sessionId ?? '').trim()
    if (!SESSION_ID_RE.test(raw)) throw new Error('rejected: not a session id: ' + raw)

    const row = await this.rowFor(raw)
    const canonicalId = (row && row.header && String(row.header.id)) || raw

    const dir = await this.findDir(raw)
    const workspace = this.workspaceOf(canonicalId) ?? this.workspaceOf(raw)
    if (dir === undefined && workspace === undefined) {
      throw new Error('nothing to delete: ' + raw + ' is neither on disk nor attached to a workspace')
    }
    if (dir !== undefined && !isInside(this.sessionsRoot, dir)) {
      throw new Error('rejected: session directory escapes the sessions root')
    }

    const notes = await this.quiesce(raw, canonicalId)

    const now = new Date()
    const entryId = stamp(now) + '__' + canonicalId
    let moved = null

    if (dir !== undefined) {
      const bytes = directoryBytes(dir)
      const target = this.moveIntoBin(dir, entryId)
      moved = { entryId, from: dir, to: target, bytes }
      this.bin.add({
        entryId,
        sessionId: canonicalId,
        requestedId: raw,
        title: String((row && row.header && (row.header.title ?? row.header.name)) ?? ''),
        workspaceId: workspace ? workspace.id : null,
        workspacePath: workspace ? String(workspace.path ?? '') : '',
        deletedAt: now.toISOString(),
        bytes,
        originalDir: dir,
      })
      notes.push('moved ' + dir + ' -> ' + target)
    }

    if (workspace !== undefined) {
      if (typeof workspace.detachSession !== 'function') {
        notes.push('workspace has no detachSession(); accounting untouched')
      } else {
        try {
          await workspace.detachSession(canonicalId)
          notes.push('detached from workspace ' + String(workspace.path ?? workspace.id))
        } catch (error) {
          // 解绑失败就把日志搬回去，不留下「文件没了但记账还在」的半死状态
          if (moved) {
            try {
              fs.renameSync(moved.to, moved.from)
              this.bin.remove(entryId)
              notes.push('rolled back the move after detach failure')
            } catch (rollbackError) {
              notes.push('ROLLBACK FAILED: ' + messageOf(rollbackError))
            }
          }
          throw new Error('detach failed: ' + messageOf(error))
        }
      }
    }

    // 关键：把会话计入归档集合。
    //
    // 客户端的会话投影（list.ids）由独立的数据流维护，不会因为我们移走了日志就
    // 立刻知道这个会话没了。而侧栏分组是按 workspace.sessionIds 归并的，
    // 凡是不在任何 workspace 里、又仍然可见的会话，都会被塞进「未分组」那一组
    // （owningGroupKey 找不到归属时返回空串，空串就是未分组的 key）。
    // 结果就是：服务端已经删干净了，界面上却多出一个「未分组」并挂着这个会话，
    // 直到下次启动会话投影重建才恢复。
    //
    // 归档是唯一能立刻把会话从列表里隐藏、又不依赖投影重建的机制：
    // sessionVisible() 对 default 过滤器直接返回 !archived.has(id)。
    // 所以删除时一并归档，恢复时再取消归档。
    const archiveNotes = await this.archiveSession(canonicalId)
    notes.push(...archiveNotes)

    return { sessionId: canonicalId, moved: moved !== null, notes, deletedAt: now.toISOString() }
  }

  async restore(entryId) {
    if (!this.bin.has(entryId)) throw new Error('recycle bin has no entry ' + entryId)
    const indexed = this.bin.readIndex().find((item) => item.entryId === entryId)
    if (!indexed || typeof indexed.originalDir !== 'string' || indexed.originalDir === '') {
      throw new Error('entry carries no original path; restore it by hand')
    }
    const originalDir = indexed.originalDir
    if (!isInside(this.sessionsRoot, originalDir)) {
      throw new Error('rejected: original path escapes the sessions root')
    }
    if (fs.existsSync(originalDir)) throw new Error('cannot restore: ' + originalDir + ' already exists')

    const entryDir = this.bin.entryDir(entryId)
    fs.mkdirSync(path.dirname(originalDir), { recursive: true })
    try {
      fs.renameSync(entryDir, originalDir)
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        fs.cpSync(entryDir, originalDir, { recursive: true, dereference: false })
        fs.rmSync(entryDir, { recursive: true, force: true })
      } else {
        throw error
      }
    }

    const notes = ['moved back to ' + originalDir]
    // 先取消归档：删除时是靠归档把这一行从列表里藏起来的，
    // 不取消的话日志虽然回到了正确位置，界面上仍然看不到它。
    notes.push(...(await this.unarchiveSession(indexed.sessionId)))

    const workspaceId = indexed.workspaceId
    if (typeof workspaceId === 'string' && this.registry && typeof this.registry.get === 'function') {
      try {
        const workspace = this.registry.get(workspaceId)
        if (workspace && typeof workspace.attachSession === 'function') {
          await workspace.attachSession(indexed.sessionId)
          notes.push('re-attached to workspace ' + workspaceId)
        }
      } catch (error) {
        notes.push('re-attach failed (' + messageOf(error) + '); the log is on disk and will be re-indexed on next start')
      }
    }

    this.bin.remove(entryId)
    return { entryId, restoredTo: originalDir, notes }
  }

  async purge(entryId) {
    if (!this.bin.has(entryId)) throw new Error('recycle bin has no entry ' + entryId)
    const indexed = this.bin.readIndex().find((item) => item.entryId === entryId)
    fs.rmSync(this.bin.entryDir(entryId), { recursive: true, force: true })
    this.bin.remove(entryId)
    // 会话彻底没了，归档集合里不该再留着它的 id
    if (indexed && typeof indexed.sessionId === 'string') {
      await this.unarchiveSession(indexed.sessionId)
    }
    return { entryId }
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function resolveHome(rawConfig) {
  if (typeof rawConfig?.dshHome === 'string' && rawConfig.dshHome !== '') return path.resolve(rawConfig.dshHome)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') return path.resolve(process.env.DSH_HOME)
  return path.join(os.homedir(), '.dsh')
}

function makeReaper(scoped, home, rawConfig, log) {
  let registry
  try {
    registry = scoped.get('workspaceRegistry')
  } catch {
    registry = undefined
  }
  let persistence
  try {
    persistence = scoped.get('sessionPersistence')
  } catch {
    persistence = undefined
  }
  const sessionsRoot = persistence && typeof persistence.root === 'string' && persistence.root !== ''
    ? path.resolve(persistence.root)
    : path.join(home, 'sessions')
  return new Reaper({
    registry,
    persistence,
    sessionsRoot,
    recycleBinRoot: path.resolve(
      typeof rawConfig?.recycleBin === 'string' && rawConfig.recycleBin !== ''
        ? rawConfig.recycleBin
        : path.join(home, 'session-reaper'),
    ),
    log,
  })
}

export function apply(ctx, rawConfig) {
  const log = (line) => {
    try {
      ctx.logger?.info?.('[session-reaper] ' + line)
    } catch {
      /* 记日志失败不影响功能 */
    }
  }

  try {
    if (rawConfig?.enabled === false) {
      log('disabled by config; nothing registered')
      return
    }
    const home = resolveHome(rawConfig)
    // 共享装配结果：三个依赖各自到齐时都可能刷新它
    const state = { reaper: undefined }

    const ensure = (scoped) => {
      if (!state.reaper) state.reaper = makeReaper(scoped, home, rawConfig, log)
      return state.reaper
    }

    ctx.inject(['sessionPersistence'], (scoped) => {
      try {
        const reaper = ensure(scoped)
        reaper.persistence = scoped.get('sessionPersistence')
        if (reaper.persistence && typeof reaper.persistence.root === 'string') {
          reaper.sessionsRoot = path.resolve(reaper.persistence.root)
        }
        log('sessionPersistence ready; sessionsRoot=' + reaper.sessionsRoot)
      } catch (error) {
        log('setup via sessionPersistence failed: ' + messageOf(error))
      }
    })

    ctx.inject(['workspaceRegistry'], (scoped) => {
      try {
        const reaper = ensure(scoped)
        reaper.registry = scoped.get('workspaceRegistry')
        log('workspaceRegistry ready')
      } catch (error) {
        log('setup via workspaceRegistry failed: ' + messageOf(error))
      }
    })

    ctx.inject(['webServer'], (scoped) => {
      try {
        // 与已验证插件保持一致：服务通过 scoped.webServer 访问
        const server = scoped.webServer
        if (!server || typeof server.register !== 'function') {
          log('webServer.register unavailable; no endpoints')
          return
        }
        const reaper = ensure(scoped)

        const guard = (req, res) => {
          try {
            const connection = scoped.connection
            if (connection && typeof connection.requestRejection === 'function') {
              const rejection = connection.requestRejection(req)
              if (rejection !== undefined) {
                if (typeof rejection === 'number') {
                  res.writeHead(rejection)
                  res.end()
                } else {
                  sendJson(res, 403, { ok: false, error: 'request rejected by the host trust fence' })
                }
                return true
              }
            }
          } catch {
            /* 取不到 connection 时不额外拦截 */
          }
          return false
        }

        const route = (method, suffix, run) => {
          const full = ROUTE_BASE + suffix
          try {
            scoped.effect(() =>
              server.register({
                kind: 'exact',
                path: full,
                handler: (req, res) => {
                  if (guard(req, res)) return
                  if (req.method !== method) {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  Promise.resolve()
                    .then(() => run(req, res))
                    .catch((error) => {
                      log('route ' + full + ' failed: ' + messageOf(error))
                      sendJson(res, 400, { ok: false, error: messageOf(error) })
                    })
                },
              }),
            )
            log('registered ' + method + ' ' + full)
          } catch (error) {
            log('register ' + full + ' failed: ' + messageOf(error))
          }
        }

        route('GET', '/list', async (req, res) => {
          sendJson(res, 200, { ok: true, entries: reaper.bin.list() })
        })

        route('POST', '/delete', async (req, res) => {
          const body = JSON.parse((await readBody(req, 8192)) || '{}')
          sendJson(res, 200, { ok: true, result: await reaper.remove(body.sessionId) })
        })

        route('POST', '/restore', async (req, res) => {
          const body = JSON.parse((await readBody(req, 8192)) || '{}')
          sendJson(res, 200, { ok: true, result: await reaper.restore(String(body.entryId ?? '')) })
        })

        route('POST', '/purge', async (req, res) => {
          const body = JSON.parse((await readBody(req, 8192)) || '{}')
          sendJson(res, 200, { ok: true, result: await reaper.purge(String(body.entryId ?? '')) })
        })
      } catch (error) {
        log('webServer setup failed: ' + messageOf(error))
      }
    })
  } catch (error) {
    log('DISABLED after error: ' + messageOf(error))
    try {
      console.warn('[dsh-session-reaper] disabled after error:', error)
    } catch {
      /* noop */
    }
  }
}
