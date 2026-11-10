# Native Web 架构 / 技术审查

## 两部分不可混用

Host Cordis 插件通过 `dist/index.js` 装载，与 DSH Agent 共享 `ctx.fs`、`ctx.shell`、`ctx.workingDirectory` 和单个 RemoteSshManager。Web Client 通过 `lib/client.js` 装载，使用 DSH `slots` 注入，不直接建立 SSH 连接。Host/Client 之间由 Host 的同源 HTTP API 连通。

`ctx.webServer.register({kind:'prefix', path:'/api/remote-ssh', handler})` 会比 DSH 的 `/api` 通配路由更具体。**WebServer 的路由本身不附带登录认证**。必须先调用 DSH `ctx.connection.requestRejection(req)` 才能继续处理 API；之后再做 `sec-fetch-site`、Origin/Host 比对、自定义请求头和 JSON 输入约束。本实现添加了 `connection` 的硬依赖，认证服务不存在就拒绝加载。

## Agent 切换逻辑

`agent/created` 事件收集真实的 Agent 对象。Web UI 列出可用 session ID；`/workspace/open` 首先通过 `manager.openWorkspace(hostId,path)` 校验 remote directory，再调用 `workingDirectory.set(agent, opened.virtualPath)`；仅当 set 成功才返回 `ok: true`。`previousCwd` 只保存第一次从本地切远程前的本地目录；`/workspace/close` 恢复并清理记录。未知 session 直接返回 409，不伪造“切换成功”。

## 旧代码清理

- 删除原 `ui/` 的独立网页及 `src/web-plugin.ts` loopback companion。
- 删除需要直接写入本机 DSH profile 的 `install.mjs`；改为官方 `dsh plugin --profile web add` 管理。
- 旧的 `test/ui.test.js` / `test/loader.test.js` 面向旧连接/安装架构，替换为 `test/native.test.js`。

## 安全边界

- SFTP 路由使用经过验证的 Host Key 和已连接的 ssh2 transport。
- Agent 文件操作继续使用远程文件根目录 containment 与版本检查。
- Shell Router 使用 OpenSSH `StrictHostKeyChecking=yes`、`BatchMode=yes`，禁用密码、交互认证与端口转发。
- Remote 工作区验证失败不会自动落回本地，防止将远程任务错误地写到本地工作区。
- 本插件不是浏览器多用户访问控制系统；拥有可写 Agent 会话的已授权 DSH operator 自然拥有相应远程 SSH 执行权限。
