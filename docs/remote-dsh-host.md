# 远端 DSH 在 Windows Desktop 内嵌运行（v1.6）

## 直接使用

1. Windows DSH Desktop 选择「新建项目 → SSH 服务器」，选择已有的 SSH Config 主机及 Linux 项目路径。
2. 点击「连接完整远端 DSH」。这是主要入口；旁边「兼容：在 Desktop 打开工作区」仍是旧版 Windows 文件桥接模式。
3. 插件通过经过身份验证的 SSH 连接，检查 Linux Node.js、必要时下载固定版本的官方 DSH CLI，启动或复用远端 DSH Web，并自动创建仅绑定 Windows 127.0.0.1 的 SSH TCP 转发。
4. 远端 DSH 在现有 Windows Desktop 窗口的主要工作区域显示；Agent、Git、Session、Terminal 和 Worktree 属于 Linux DSH 运行时。
5. 顶部「返回本地」关闭内嵌视图，不停止 Linux DSH；重新进入同一工作目录时可继续使用原远端会话。

不需要手动运行 dsh web、不需要复制 token、不需要外部浏览器或配置 ssh -L。

## 运行条件

- Linux SSH 登录可用，并允许 SSH direct-tcpip（AllowTcpForwarding）。第一次信任服务器仍需从可信渠道核验 SHA256 主机密钥指纹。
- Linux 环境 Node.js 至少为 24.9.0，git 已安装；如要 GitHub PR 状态，建议安装 gh 并登录。插件不会静默升级 Node 或更改 sshd。
- 优先执行远端已有的 dsh；若没有，用户点击连接即授权执行官方固定版本的 npx 命令：npx -y @deepseek-ai/dsh@0.2.2-rc.1 web --no-open --host 127.0.0.1 --port <随机端口>。首次下载需要访问 npm registry。
- 仅适用于 Windows DSH Desktop 的授权 Electron Browser Guest；普通 Web Profile 不支持这个原生桌面内嵌入口。

## 安全与进程生命周期

- Linux DSH 只监听服务器回环地址 127.0.0.1；Windows 隧道只监听本机 127.0.0.1 的随机端口，不对外公开服务。
- 远端 helper 位于其私有 SHA256 校验目录，Web 进程的 PID、端口和启动日志位于 ~/.cache/dsh-remote-ssh/web/v1/<项目SHA256>/。日志可能包含 DSH Web 启动 token，必须当作敏感数据。
- 含 token 的启动 URL 仅在受认证的插件 API 应答中短暂返回给 Desktop WebView，不写入插件持久配置、不送入 Agent 聊天。完成首个登录后，官方 DSH 会将 token 换成 Session Cookie。
- Desktop 内嵌 WebView 通过官方 dshDesktop.browser.acquire 和 release 获取受控 Electron Guest Lease；与本地 Host 的 cookie、Node API 和 Agent 进程隔离。
- 断线或启动失败时显示错误，可重试；不能在后台将远程 Agent 意外转为 Windows 本地执行。

## 与真正修改 Desktop Core 的区别

这条路线不修改 DSH Desktop Core：插件将完整 Linux DSH Web Client 嵌入 Desktop 主窗口。**本地和远端的 Session Store 不合并**，不同主机仍是独立的 DSH 实例。Linux Web 内的 Git/Agent 由 Linux Host 执行，但原 Windows DSH 自己的 Git 侧栏仍属于本地 Session。

## 验证与排障

- GitHub CI 测试客户端脚本语法、原生 UI 槽注册、Web URL 验证、HTTP/SSH 隧道逻辑；Node24 smoke 测试在 Linux 启动假的 dsh 进程并验证复用/URL。**还需要在真实 Windows Electron 与 Linux 官方 DSH Web 中验收登录、Agent、Git 和连接恢复。**
- 若报 Node 版本不足：在服务器检查 node -v，应为 24.9 或更高。
- 若报 SSH forwarding 失败：检查服务端 SSHD 的 AllowTcpForwarding，以及任何 SSH ProxyCommand / 跳板限制；不要把 DSH Web 暴露到公网。
- 若提示 starting 持续很久或 failed：查看服务器私有运行目录中的启动日志，分享日志前务必删去完整含 token 的 URL。
- 若 Git 仍显示本地路径：确认进入了「连接完整远端 DSH」而非旧版「兼容」模式。

## 参考

- DSH Web 官方说明：https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/web-app
- DSH Desktop Browser Guest：https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/browser-guests.ts
- 插件 README：https://github.com/WeipengMO/dsh-plugin-remote-ssh
