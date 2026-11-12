# Remote SSH 架构

插件 Host 使用经主机密钥校验的 SSH 连接部署内容寻址 helper，并通过 `/runtime/web/open` 启动或复用真实 Linux DSH Web。按 SSH 主机和规范化项目目录生成的 key 为每个远程项目分配独立的 `127.0.0.1` TCP listener；字节通过 SSH `direct-tcpip` 转发到 Linux 回环地址。多个项目即使属于同一 SSH 主机，也不会因为打开另一个项目而替换隧道。

Desktop Client 在 `shell.overlay` 中为每个打开的项目保留一个由 `dshDesktop.browser.acquire` 创建的受控 Electron WebView。每个项目使用自己的 guest partition 和 DSH Client，切换时隐藏而不卸载页面。返回本地只隐藏远程视图；关闭标签释放 guest，插件卸载时关闭其隧道。远端 DSH 进程和持久会话不由标签生命周期删除。

所有远程 DSH 请求由相应 WebView 直接经过自己的 SSH 隧道到达 Linux DSH。插件不包装本地 Desktop 的 `fetch`、WebSocket 或 Connection，不合并本地与远端会话，也不按会话猜测 Host。Git、worktree、沙箱、终端和文件监视由 Linux DSH 的对应服务负责，是否可用取决于远端版本和环境。

`/api/remote-ssh` 在处理请求前调用 DSH `Connection.requestRejection()`，再检查 Origin、Host、`sec-fetch-site`、修改请求头和 JSON。启动 URL 中的进程级令牌经认证 API 传到本地渲染进程并用于 WebView 登录；它不出现在状态接口或插件配置中。该令牌可以复用，必须作为凭证保护。

已有本地占位目录使用的文件、Shell、终端和 Git 兼容路由暂时保留，确保升级不破坏已有工作区；新的项目选择流程不再创建此类工作区。两种模式的会话不自动迁移。
