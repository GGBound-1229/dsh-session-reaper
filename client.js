window.__ModuleLoader__.load({
  id: 'dsh-session-reaper',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /**
     * dsh-session-reaper — 客户端半边。
     *
     * 三处注册：
     *   - `sidebar.workspaces.session.menu.item`（order 500）：会话「⋯」菜单里的「删除」；
     *   - `shell.overlay`：删除确认框，以及回收站面板；
     *   - `sidebar.footer.action`：侧栏底部一个回收站入口。
     *
     * 约束：客户端插件只能 require('react') / require('react-dom')，
     * 拿不到 primitives 组件库，也拿不到内置包的 hooks，
     * 因此这里的 UI 用原生元素自绘，状态用一个模块级 store 自己维护。
     */

    const ROUTE_BASE = '/dsh-session-reaper'
    const NS = 'dsh-session-reaper'

    /** 模块级状态：菜单项与 overlay 之间唯一的通信通道。 */
    const store = {
      pending: null, // { sessionId, title, bytes }
      binOpen: false,
      version: 0,
      listeners: new Set(),
    }

    function emit() {
      store.version += 1
      for (const fn of store.listeners) {
        try {
          fn(store.version)
        } catch {
          /* 单个订阅者失败不影响其它 */
        }
      }
    }

    function subscribe(fn) {
      store.listeners.add(fn)
      return () => store.listeners.delete(fn)
    }

    /** 订阅 store 的 hook。 */
    function useReaper() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => subscribe(force), [])
      return store
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /** 调宿主端点。失败时抛出带可读信息的错误。 */
    async function call(method, path, payload) {
      const response = await fetch(ROUTE_BASE + path, {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error('宿主返回了无法解析的响应（HTTP ' + response.status + '）')
      }
      if (!response.ok || body.ok !== true) {
        throw new Error(body && body.error ? body.error : 'HTTP ' + response.status)
      }
      return body
    }

    //#region 样式
    const CSS = `
      .dsr-scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}
      .dsr-dialog{width:min(520px,100%);max-height:80vh;overflow:auto;border-radius:12px;background:var(--dsh-surface,#1f2023);color:var(--dsh-text,#e8e8ea);border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 64px rgba(0,0,0,.45);font-size:13px;line-height:1.6}
      .dsr-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08)}
      .dsr-head strong{font-size:14px;font-weight:600}
      .dsr-body{padding:14px 16px}
      .dsr-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08)}
      .dsr-btn{appearance:none;border:1px solid rgba(255,255,255,.16);background:transparent;color:inherit;border-radius:7px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit}
      .dsr-btn:hover{background:rgba(255,255,255,.07)}
      .dsr-btn:disabled{opacity:.5;cursor:default}
      .dsr-btn-danger{background:#c0392b;border-color:#c0392b;color:#fff}
      .dsr-btn-danger:hover{background:#a93226}
      .dsr-row{padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)}
      .dsr-row:last-child{border-bottom:none}
      .dsr-title{font-weight:500;word-break:break-all}
      .dsr-meta{color:rgba(255,255,255,.55);font-size:12px;margin-top:2px;word-break:break-all}
      .dsr-warn{margin-top:10px;padding:9px 11px;border-radius:8px;background:rgba(192,57,43,.14);border:1px solid rgba(192,57,43,.4);font-size:12px}
      .dsr-empty{color:rgba(255,255,255,.5);text-align:center;padding:24px 0}
      .dsr-err{margin-top:10px;color:#ff8a80;font-size:12px;word-break:break-all}
      .dsr-input{width:100%;box-sizing:border-box;margin-top:8px;padding:7px 9px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:inherit;font-family:inherit;font-size:13px}
      .dsr-close{appearance:none;border:none;background:transparent;color:inherit;font-size:18px;cursor:pointer;padding:0 4px;opacity:.6}
      .dsr-close:hover{opacity:1}
      .dsr-footer-btn{appearance:none;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:6px 10px;border-radius:6px;opacity:.75;width:100%;text-align:left;display:flex;align-items:center;gap:7px}
      .dsr-footer-btn:hover{opacity:1;background:rgba(255,255,255,.07)}
      .dsr-badge{display:inline-block;min-width:16px;padding:0 5px;border-radius:9px;background:rgba(192,57,43,.85);font-size:11px;line-height:16px;text-align:center}
      .dsr-menu{appearance:none;border:none;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;width:100%;text-align:left;padding:6px 12px;border-radius:6px;display:flex;align-items:center;gap:8px}
      .dsr-menu:hover{background:rgba(231,76,60,.16)}
      .dsr-menu.dsr-danger{color:#ff8a80}
    `

    function useStyles() {
      React.useEffect(() => {
        const id = 'dsh-session-reaper-styles'
        if (document.getElementById(id)) return
        const el = document.createElement('style')
        el.id = id
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }
    //#endregion

    //#region 菜单项
    /** 会话「⋯」菜单里的删除条目。 */
    function DeleteSessionMenuItem(props) {
      useStyles()
      const sessionId = props && props.sessionId
      if (!sessionId) return null

      const onSelect = (event) => {
        try {
          event.preventDefault()
          event.stopPropagation()
          // 菜单由内置包管理，外部拿不到它的关闭函数；
          // 点完后按 Esc 等价的路径处理：先收起当前菜单，再开确认框。
          if (typeof document !== 'undefined') {
            const active = document.activeElement
            if (active && typeof active.blur === 'function') active.blur()
            document.body.click()
          }
        } catch {
          /* 收菜单失败也要继续 */
        }
        store.pending = {
          sessionId,
          title: (props && (props.title || props.sessionTitle)) || '',
        }
        emit()
      }

      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'dsr-menu dsr-danger',
          onClick: onSelect,
          title: '把这个会话移入回收站',
        },
        h('span', { 'aria-hidden': 'true' }, '🗑'),
        h('span', null, '删除会话…'),
      )
    }
    //#endregion

    //#region 删除确认框
    function DeleteConfirmDialog() {
      useStyles()
      const state = useReaper()
      const pending = state.pending
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      if (!pending) return null

      const close = () => {
        if (busy) return
        store.pending = null
        emit()
      }

      const confirm = async () => {
        setBusy(true)
        setError('')
        try {
          await call('POST', '/delete', { sessionId: pending.sessionId })
          store.pending = null
          emit()
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        {
          className: 'dsr-scrim',
          onMouseDown: (e) => {
            if (e.target === e.currentTarget) close()
          },
        },
        h(
          'div',
          { className: 'dsr-dialog', role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dsr-head' },
            h('strong', null, '删除这个会话？'),
            h('button', { type: 'button', className: 'dsr-close', onClick: close, disabled: busy, 'aria-label': '取消' }, '×'),
          ),
          h(
            'div',
            { className: 'dsr-body' },
            h('div', { className: 'dsr-title' }, pending.title || '未命名会话'),
            h('div', { className: 'dsr-meta' }, pending.sessionId),
            h(
              'div',
              { className: 'dsr-warn' },
              '会话日志会被移入回收站，不会立刻销毁。你可以在侧栏底部的「回收站」里恢复它，或在回收站面板里彻底删除。',
            ),
            error ? h('div', { className: 'dsr-err' }, error) : null,
          ),
          h(
            'div',
            { className: 'dsr-foot' },
            h('button', { type: 'button', className: 'dsr-btn', onClick: close, disabled: busy }, '取消'),
            h('button', { type: 'button', className: 'dsr-btn dsr-btn-danger', onClick: confirm, disabled: busy }, busy ? '正在移入回收站…' : '移入回收站'),
          ),
        ),
      )
    }
    //#endregion

    //#region 回收站面板
    function TrashPanel() {
      useStyles()
      const state = useReaper()
      const [entries, setEntries] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busyId, setBusyId] = React.useState('')
      const [purging, setPurging] = React.useState(null) // entryId
      const [typed, setTyped] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const body = await call('GET', '/list')
          setEntries(Array.isArray(body.entries) ? body.entries : [])
          setError('')
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
          setEntries([])
        }
      }, [])

      React.useEffect(() => {
        if (state.binOpen) load()
      }, [state.binOpen, load])

      if (!state.binOpen) return null

      const close = () => {
        store.binOpen = false
        emit()
      }

      const restore = async (entryId) => {
        setBusyId(entryId)
        setError('')
        try {
          await call('POST', '/restore', { entryId })
          await load()
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusyId('')
        }
      }

      const purge = async (entryId) => {
        setBusyId(entryId)
        setError('')
        try {
          await call('POST', '/purge', { entryId })
          setPurging(null)
          setTyped('')
          await load()
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusyId('')
        }
      }

      const total = Array.isArray(entries) ? entries.reduce((sum, item) => sum + (item.bytes || 0), 0) : 0

      return h(
        'div',
        {
          className: 'dsr-scrim',
          onMouseDown: (e) => {
            if (e.target === e.currentTarget) close()
          },
        },
        h(
          'div',
          { className: 'dsr-dialog', role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dsr-head' },
            h('strong', null, '会话回收站'),
            h('button', { type: 'button', className: 'dsr-close', onClick: close, 'aria-label': '关闭' }, '×'),
          ),
          h(
            'div',
            { className: 'dsr-body' },
            entries === null
              ? h('div', { className: 'dsr-empty' }, '正在读取…')
              : entries.length === 0
                ? h('div', { className: 'dsr-empty' }, '回收站是空的。')
                : h(
                    'div',
                    null,
                    h('div', { className: 'dsr-meta', style: { marginBottom: '6px' } }, '共 ' + entries.length + ' 项，合计 ' + formatBytes(total)),
                    ...entries.map((entry) =>
                      h(
                        'div',
                        { className: 'dsr-row', key: entry.entryId },
                        h('div', { className: 'dsr-title' }, entry.title || '未命名会话'),
                        h(
                          'div',
                          { className: 'dsr-meta' },
                          entry.sessionId + ' · ' + formatBytes(entry.bytes) + (entry.deletedAt ? ' · 删除于 ' + entry.deletedAt.replace('T', ' ').slice(0, 19) : ''),
                        ),
                        entry.workspacePath ? h('div', { className: 'dsr-meta' }, entry.workspacePath) : null,
                        purging === entry.entryId
                          ? h(
                              'div',
                              { style: { marginTop: '8px' } },
                              h('div', { className: 'dsr-warn' }, '彻底删除后无法恢复。请在下方输入 DELETE 确认。'),
                              h('input', {
                                className: 'dsr-input',
                                value: typed,
                                placeholder: 'DELETE',
                                onChange: (e) => setTyped(e.target.value),
                                autoFocus: true,
                              }),
                              h(
                                'div',
                                { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'dsr-btn dsr-btn-danger',
                                    disabled: typed !== 'DELETE' || busyId === entry.entryId,
                                    onClick: () => purge(entry.entryId),
                                  },
                                  busyId === entry.entryId ? '正在删除…' : '彻底删除',
                                ),
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'dsr-btn',
                                    onClick: () => {
                                      setPurging(null)
                                      setTyped('')
                                    },
                                  },
                                  '取消',
                                ),
                              ),
                            )
                          : h(
                              'div',
                              { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsr-btn',
                                  disabled: busyId === entry.entryId,
                                  onClick: () => restore(entry.entryId),
                                },
                                busyId === entry.entryId ? '正在恢复…' : '恢复',
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsr-btn',
                                  onClick: () => {
                                    setPurging(entry.entryId)
                                    setTyped('')
                                  },
                                },
                                '彻底删除…',
                              ),
                            ),
                      ),
                    ),
                  ),
            error ? h('div', { className: 'dsr-err' }, error) : null,
          ),
          h(
            'div',
            { className: 'dsr-foot' },
            h('button', { type: 'button', className: 'dsr-btn', onClick: load }, '刷新'),
            h('button', { type: 'button', className: 'dsr-btn', onClick: close }, '关闭'),
          ),
        ),
      )
    }
    //#endregion

    //#region 侧栏底部入口
    function TrashFooterButton() {
      useStyles()
      const state = useReaper()
      const [count, setCount] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        call('GET', '/list')
          .then((body) => {
            if (alive && Array.isArray(body.entries)) setCount(body.entries.length)
          })
          .catch(() => {
            /* 读不到就不显示角标 */
          })
        return () => {
          alive = false
        }
      }, [state.binOpen, state.version])

      return h(
        'button',
        {
          type: 'button',
          className: 'dsr-footer-btn',
          title: '打开会话回收站',
          onClick: () => {
            store.binOpen = true
            emit()
          },
        },
        h('span', { 'aria-hidden': 'true' }, '🗑'),
        h('span', null, '回收站'),
        count > 0 ? h('span', { className: 'dsr-badge' }, String(count)) : null,
      )
    }
    //#endregion

    /** Cordis 客户端插件入口。 */
    function apply(ctx) {
      try {
        ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
          yield ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'delete-session',
              order: 500,
            },
            DeleteSessionMenuItem,
          )
        })

        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({ name: 'shell.overlay', id: 'reaper-delete-confirm' }, DeleteConfirmDialog)
          yield ctx.slots.register({ name: 'shell.overlay', id: 'reaper-trash-panel' }, TrashPanel)
        })

        ctx.slots.inject('sidebar.footer.action', function* () {
          yield ctx.slots.register({ name: 'sidebar.footer.action', id: 'reaper-trash-entry' }, TrashFooterButton)
        })
      } catch (error) {
        try {
          console.warn('[dsh-session-reaper] client apply failed:', error)
        } catch {
          /* noop */
        }
      }
    }

    exports.apply = apply
    exports.name = NS
    exports.inject = ['slots']
    return module.exports
  },
})
