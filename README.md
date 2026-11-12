# DSH Remote SSH

在 Windows DSH Desktop 中通过 SSH 打开 Linux 上的完整 DSH。每台 SSH 主机使用一个内嵌远端 DSH Client/Core Connection；远端 Host 的多个 Workspace 与 Session 由同一个 Linux DSH 进程管理。本地 DSH 保持独立。无需修改或重新打包 Desktop Core。

## 使用

1. 在 **设置 → Remote SSH** 添加服务器或从 Windows `~/.ssh/config` 导入。首次连接时，通过独立可信渠道核对完整 SHA-256 主机密钥指纹并确认。
2. 在设置页选择服务器，浏览 Linux 目录，点击 **打开远程 DSH**。也可以在新建项目的目录选择器中选择 **SSH 服务器**，再打开所选目录。
3. 插件验证并部署 helper，启动或复用该 SSH 账户的**唯一 Linux DSH Web Host**，并经 SSH 建立本机回环隧道。首次未安装 DSH 时会使用固定版本的官方 CLI，可能需要下载。
4. 同一 SSH 主机仅保留一个远端页面。打开该主机的另一个目录会复用页面和 Core Connection；**必须在远端 DSH 内选择目标 Workspace**，不会自动改动既有 Session 的工作目录。**返回本地**保留远端页面，**重新连接**重建页面连接，关闭标签不会停止 Linux DSH 进程。

远程界面中的工作区、会话、Agent、Git、worktree、终端和文件监视由同一 SSH 账户的 Linux DSH Host 管理。Windows 与 Linux 的会话列表不合并，切换标签不会迁移会话。关闭 Desktop 后，下次需重新从项目目录打开远程界面；Linux DSH 的持久会话由远端保存。

## Windows 原生多 Host Sessions（实验性）

DSH Desktop 左侧新增「远端 Sessions」原生导航入口。此界面是同一 Windows React/Cordis Shell 内的 `main` 面板，**不是** WebView/iframe；支持选择不同 SSH Host、创建真实 Linux Session、查看最近历史、发送 prompt 和取消任务；同一 Host 的 15 秒连接缓存减少了重复 SSH Helper 调用。同一 Linux Host 保留共享进程和 SSH tunnel，远端的 Agent 在 Linux 上执行。插件 Host 通过 DSH 官方 `/api/session/*` Connection RPC 协议与远端交互，短期签名 Cookie 仅保留在 Windows Node 进程内，浏览器只持有绑定 Host+Session 的不透明引用。SSH PTY 简易终端及只读 Git 状态已作为原生面板的工作区工具接入（不是官方 Session 的 `terminalController`、Git/worktree UI）。完整任务流式推送、工具审批和原生 Session 级 Git/终端仍需 Core API 适配，目前不是与官方内置 `ctx.sessions` 的统一列表。

## Core Connection 集成边界

此版本复用的是**远端 DSH Client 树内的 Core Connection**，不是把 Windows Desktop 原生 Session 直接绑定到远端 Host。官方 `ctx.connection` 属于整个 Client Context、只允许一个 Generation Source；原生 Windows 会话的透明跨 Host 切换仍需要 Core 提供 Session → Host 选择/多 Context 装载接口，不能依靠修改插件 HTTP 路由实现。本仓库不会偷偷全局替换连接、拦截 RPC 或声称完成此功能。

## 前提与安全

- Linux 主机需要 Node.js ≥24.9、Git、可用的 DSH CLI 或访问 npm 的能力；SSH 服务需允许 `direct-tcpip` 转发。
- 远端 DSH 和本地转发均绑定回环地址。首次信任或密钥变更必须认真核验；插件不会自动信任新密钥。
- DSH 的启动 URL 含进程级认证令牌，会经受认证的插件 API 传到 Desktop 渲染进程并加载到隔离的 WebView；不要将 URL 或远端启动日志分享给他人。令牌不是一次性的。插件不将其写入配置或状态接口。
- 旧版本地占位目录与 SSH 文件桥接仍保留以兼容已有工作区，新建项目不再使用它。打开已有旧工作区不会自动迁移到远端 DSH。

## 构建和验证

```sh
pnpm build
pnpm run test:inprocess
node scripts/package-plugin.mjs
dsh plugin --profile desktop add /path/to/dsh-plugin-remote-ssh-2.3.0.tgz
```

完全退出 Desktop 后，用其自带的 `dsh` 插件管理器安装打包脚本输出的绝对路径，再重新打开 Desktop；单纯刷新页面不会重载 Host 的 ESM 模块。插件管理器会更新 profile 的依赖与锁文件，不会替换 Desktop Core。保留安装包，以便以后重新安装依赖。

可用 `DSH_REMOTE_SSH_E2E=1 node scripts/verify-real-ssh.mjs` 对已保存的 SSH 主机运行真实连接、helper、Web 认证与会话恢复检查。脚本默认不运行真实连接；目标没有会话时可能创建一个空测试会话。该脚本不代替 Desktop 界面、Git、worktree、沙箱和文件监视验收。

详细信息：[使用与故障排查](docs/remote-dsh-host.md) · [架构](docs/architecture.md) · [Helper 协议](docs/remote-runtime-protocol.md) · [旧工作区兼容说明](docs/desktop-ssh-runtime.md)。
