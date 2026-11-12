# Remote SSH 架构

插件 Host 使用经主机密钥校验的 SSH 连接部署内容寻址 helper，并通过 `/runtime/web/open` 启动或复用真实 Linux DSH Web。远端 helper 在同一 Linux HOME 下维护唯一 v2 Host registry，所有项目均复用同一 DSH Web 进程；插件按 SSH Host ID 建立一个 `127.0.0.1` TCP listener，经 SSH `direct-tcpip` 转发到 Linux 回环地址。不同 SSH Host 仍独立。老 v1 逐项目进程不会被静默接管或杀掉。

Desktop Client 在 `shell.overlay` 中为每个已打开的 SSH Host 保留一个由 `dshDesktop.browser.acquire` 创建的受控 Electron WebView。每个 SSH Host 使用自己的 guest partition、DSH Client 和官方 Core Connection；该远端 Client 中的多个 Session 共享同一个 Host。打开同 Host 的其他项目不会重新装载 WebView；用户须在远端 UI 内选择 Workspace。切换时隐藏而不卸载页面。返回本地只隐藏远程视图；关闭标签释放 guest，插件卸载时关闭其隧道。远端 DSH 进程和持久会话不由标签生命周期删除。

所有远程 DSH 请求由相应 WebView 直接经过自己的 SSH 隧道到达 Linux DSH。插件不包装本地 Desktop 的 `fetch`、WebSocket 或 Connection，不合并本地与远端会话，也不按会话猜测 Host。**这不是 Windows 原生 Session 的 Connection 级切换**：当前 Core Connection 是一个 Client Context 级服务且其 Generation Source 为独占，不能由插件安全地替换成每 Session 的多 Host 路由。Git、worktree、沙箱、终端和文件监视由 Linux DSH 的对应服务负责，是否可用取决于远端版本和环境。

`/api/remote-ssh` 在处理请求前调用 DSH `Connection.requestRejection()`，再检查 Origin、Host、`sec-fetch-site`、修改请求头和 JSON。启动 URL 中的进程级令牌经认证 API 传到本地渲染进程并用于 WebView 登录；它不出现在状态接口或插件配置中。该令牌可以复用，必须作为凭证保护。

新增不使用 WebView 的「远端 Sessions」独立主面板：Windows Host 层按 SSH Host 隔离官方 DSH Connection HTTP RPC，验证响应 `rpcId`、将浏览器 Cookie 封存在 Node，并将会话绑定成不可跨 Host 复用的 opaque ref；页面使用 React 读取远端列表与历史、发送 prompt。该页面尚未替换官方 `ctx.sessions` 与 `ctx.workspaces` 的根服务，不能声称所有原生 Session 工具或完整事件流已接通。

已有本地占位目录使用的文件、Shell、终端和 Git 兼容路由暂时保留，确保升级不破坏已有工作区；新的项目选择流程不再创建此类工作区。两种模式的会话不自动迁移。
