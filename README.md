# dsh-session-reaper

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

给 DSH Web 侧栏的会话加上「删除」，并且删得可回退。

DSH 本身没有删除会话的能力：`ui-workspace` 的已知限制里写明「sessions can be archived
but never deleted」，持久化层也明确不留删除 API。归档只是把会话从列表里藏起来，
日志仍留在 `~/.dsh/sessions` 下持续占盘。这个插件补上这段缺口。

## 行为

- 会话行「⋯」菜单里多一项 **删除会话…**（order 500，排在归档之后）；
- 点它弹确认框，显示标题与 session id；
- 确认后会话日志**整体移入回收站**，不是就地删除；
- 侧栏底部有 **回收站** 入口，带数量角标；
- 回收站里可以逐条 **恢复** 或 **彻底删除**（需输入 `DELETE` 二次确认）。

不做批量删除，不做自动过期清理——回收站只在你手动清理时变小。

## 安装

从 GitHub 安装：

```powershell
# Windows：用 DSH 自带的 pnpm
cd $env:USERPROFILE\.dsh\profiles\desktop
node "D:\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" `
     "D:\dsh\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs" `
     add github:GGBound-1229/dsh-session-reaper
```

然后在 `package.json` 的 `dsh.profile.bundles` 数组末尾加上包名：

```json
"bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-session-reaper"
]
```

**两步都要做。** 只加 `dependencies` 不加 `bundles`，包在磁盘上但 DSH 不会加载它；
只加 `bundles` 不加 `dependencies`，DSH 找不到包。

改完重启 DSH。

## 删除的执行顺序（不要改动）

1. `workspaceRegistry.stopSessionActivity(id)` —— 停掉这个会话上还在跑的工作；
2. `sessionPersistence.flush()` —— 把待写数据落盘，避免移走目录后仍有写句柄；
3. 校验路径确实落在 `sessionsRoot` 之内；
4. 整个会话目录 `rename` 进回收站（跨卷时退化为复制+删除）；
5. `workspace.detachSession(id)` —— 走官方实体写路径解绑记账；
6. `workspaceRegistry.archiveSession(id)` —— 计入归档集合，让客户端立刻隐藏这一行。

这个顺序是有原因的。`WorkspaceRegistry.bootstrap()` 在启动时会按 cwd 重新枚举持久化层里
所有 header，给工作区重新记账。所以**日志目录必须先消失**，否则下次启动这个会话会从磁盘
被重新扫回来、重新挂到工作区——看起来就是「删了又复活」。反过来（先解绑、再移目录）如果
中途失败，就会留下「记账没了但文件还在」的半死状态，下次启动一样会复活。

第 5 步失败时，第 4 步的移动会被回滚，不留下两边不一致的状态。

第 6 步解决的是纯客户端问题，不是可有可无的收尾，见下节。

## 为什么删除后要顺手归档

删完会话，服务端数据是对的：日志进了回收站、`workspace.json` 里也没有它了。
但界面上会冒出一个「未分组」分组，里面挂着刚删掉的会话，直到下次启动才消失。

原因在客户端。侧栏分组用的是 `owningGroupKey()`：拿会话 id 去各 workspace 的
`sessionIds` 里找归属，找不到就返回空串，而**空串正是「未分组」的 key**。
与此同时，客户端的会话投影（`list.ids`）由另一条数据流维护，它不会因为我们移走了
日志就立刻知道这个会话没了。于是这个会话「可见但无归属」，正好落进
`groupByWorkspace()` 收集 `stray` 的那一支。

归档是唯一能立刻把会话从列表里藏起来、又不依赖投影重建的机制——
`sessionVisible()` 对默认过滤器直接返回 `!archived.has(id)`。
所以删除时一并归档，恢复时取消归档，彻底删除时把 id 从集合里摘掉免得无限增长。

归档只影响可见性，不动日志、不改工作区记账，当「界面上的临时开关」用是安全的。
归档失败也不致命：界面上会暂时多一个未分组条目，重启后自愈。

## 存储

- 会话日志：`~/.dsh/sessions/--<normalized-cwd>--/session-<uuid>/`
- 回收站：`~/.dsh/session-reaper/`
  - `entries/<ISO时间戳>__<sessionId>/` —— 移过来的会话目录本身
  - `index.json` —— 条目索引（标题、原路径、大小、删除时间）

恢复需要 `index.json` 里的 `originalDir`，所以要手工恢复请用它，别只搬目录。

## 端点

全部挂在 `/dsh-session-reaper` 下，每个都过 `connection.requestRejection` 信任围栏：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/list` | 列出回收站 |
| POST | `/delete` | `{sessionId}` 移入回收站 |
| POST | `/restore` | `{entryId}` 从回收站恢复 |
| POST | `/purge` | `{entryId}` 彻底删除 |

## 安全边界

- **不给模型注册任何工具**，模型无法自己调用这个插件；
- 只接受本机已认证客户端（`connection.requestRejection`）；
- session id 必须匹配 `^session-[0-9a-f-]{36}$`；
- 所有文件路径 `path.resolve` 后必须落在 `sessionsRoot` 或回收站之内；
- 删除路径里**不存在**对会话目录的递归删除，只有 `rename`；递归删除只出现在
  「从回收站彻底删除」这一处，且需要输入 `DELETE`；
- 零第三方运行时依赖，只用 `node:fs` / `node:path` / `node:os`；
- `apply()` 全程 try/catch，插件任何故障只记一行日志，DSH 照常启动。

## 已知坑（踩过，别再踩）

**Cordis 的 `ctx.inject` 必须一个服务一个声明。** 一次性声明多个时，只要其中一个服务
不存在，整个插件会被拒绝挂载，而且不报错。所以这里对
`sessionPersistence` / `workspaceRegistry` / `webServer` 各调一次 `ctx.inject`。

**客户端插件只能 `require('react')` / `require('react-dom')`。** 拿不到
`@deepseek-ai/dsh-client-ui-primitives`，也拿不到内置包注入的 hooks（比如菜单的
`useMenuOpenState`）。所以 UI 用原生元素自绘，菜单项与对话框之间用一个模块级 store 通信。

**安装后要跑一次 `pnpm install`。** profile 里的 `file:` 依赖由 pnpm 复制进
`node_modules`，手工建 junction 不会被登记，DSH 的 bundle 解析器不认识这个包。

## 关闭

在 profile 的 `cordis.patch.yml` 里给这一行加上 `enabled: false`：

```yaml
- id: dsh-session-reaper
  name: dsh-session-reaper
  config:
    enabled: false
```

或者直接从 profile `package.json` 的 `dsh.profile.bundles` 里删掉本包名。
