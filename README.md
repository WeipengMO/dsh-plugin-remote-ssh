# DSH Remote SSH

**Windows DSH Desktop → 多个 Linux DSH Host 的原生工作区 Backend（实验版 v2.5.0）。**

参考 [Yan-Zero/dsh-remote-ssh](https://github.com/Yan-Zero/dsh-remote-ssh) 的 Full Remote Backend 分层设计，当前版本让你在 **DSH 原有左侧工作区** 中打开 SSH Workspace 时，转到 **Linux DSH Host 自己的 Agent Session**，不再因打开远端工作区而新建 Windows 本地 Agent。Local Workspace 原样委派给官方服务。

这不是 SSHFS 或“Agent 在 Windows、Shell 在 Linux”的模式；但目前仍是 **DSH 原生 main 槽位中的插件 Conversation 面板**，尚未将远端 Session 接入官方内置 Conversation 的全部功能。请先阅读 [实现边界](docs/native-multihost-backend.md)。

## 安装与使用

1. 在 **设置 → Remote SSH** 添加 SSH 主机，或从 Windows \`~/.ssh/config\` 导入。首次连接时通过可信渠道核对 SSH 主机公钥 SHA-256 指纹。
2. 在设置页浏览远端 Linux 目录，点击 **「添加到左侧工作区」**。插件通过 Windows DSH 的 \`workspaceRegistry.create()\` 登记稳定的工作区 ID（本地占位目录只用于识别工作区，**不是**复制/镜像工程代码）。
3. 点击左侧 DSH 原生工作区列表中的该远端 Workspace：插件查询权威的 Host 映射，并在原生主面板中连接 **对应 Linux Host 的真实 Session**；优先恢复该目录最近的会话，没有时在 Linux 上创建。切换本地 Workspace 仍由 Windows DSH 自己管理。
4. 在远端主面板直接发送文字 Prompt、查看历史、取消任务；点击「新会话」在对应 Linux Host 新建 Session。简易 SSH PTY 与只读 Git 状态作为辅助工具。
5. 遇到需要复杂人工工具审批、实时流式推送或官方高级工具 UI 的任务，请先使用设置里的 **WebView 备用**，它运行完整的远端 DSH Web 界面。

**注意：** 目前未实现完整的官方 Conversation 流式展示、权限审批/提问、附件、模型设置及会话级 Git/worktree/terminalController。由于 API Peer 使用 \`interactions=none\`，不要用实验面板运行必须由用户批准危险操作的任务；Windows Desktop 也尚未提供与 \`tuiBackends\` 对等的正式 Backend Provider 接口。

## 为什么要重构

- **v2.4.0 以前**：插件使用 SSH 文件、Shell、Git/PTY 路由，左侧虽然能列出 SSH Workspace，但点开仍会由 Windows DSH Host 创建本地 Agent。独立远端 RPC 面板与官方左侧 Workspace 点击未关联。
- **v2.5.0**：为 Windows \`uiWorkspace.openWorkspace\`、\`startSession(workspaceId)\` 增加可卸载的 Host 路由兼容适配层。远端 Workspace 点开后使用 Linux Host Session；本地 Workspace 原函数完全保留。无法确定 SSH Host 的情况下**拒绝回退到 Windows Agent**。
- 复用官方 Linux DSH Web Host、SSH loopback 隧道和 Typert Session RPC：\`session/list\` 发送 \`_request\`，其他方法发送 \`request\`；通过 \`/connect\` 领取 v2 API Peer cookie。Cookie 和启动 token 不传给浏览器。
- 同 Host 不同目录按真实 cwd 隔离 Session，跨 Host 的 SessionID 不发生冲突。Host 隧道断开时只重试安全只读请求；写操作失败且回执不确定时不自动重放，避免重复执行任务。

## Core / Desktop 兼容边界

本版本 **没有修改或重新打包 DSH Core**，也没有使用或部署第三方 \`dsh-host\`。当前 Windows Desktop 的 \`ctx.connection\` 是整个 Client Context 拥有的连接，且 \`uiWorkspace\` 没有与 TUI \`tuiBackends\` 同等的公开多 Backend 机制。

插件采用明确标注的 **兼容性导航方法包装**，在卸载时恢复官方原方法；它是走向真正多 Host 客户端的阶段性方案，**不等于**远端 Session 已变成官方 \`ctx.sessions\` 中的对象，也未替换官方 \`UiConversation\`。未来若要完全原生，需要 Core/Desktop 提供 WorkspaceBackend Provider，统一加载 Session、订阅事件、权限交互、Git/worktree/terminal 等 service。详见 [架构与待办](docs/native-multihost-backend.md)。

## 前提、安全和验证

- Linux 主机：Node.js ≥24.9、Git、可用的 DSH CLI（或安装官方 DSH 的网络能力）；SSH 必须允许 localhost \`direct-tcpip\` 端口转发。
- 插件绝不自动信任未知 SSH Host key。令牌和 API Peer cookie 留在 Windows Host 进程；WebView 备用入口仍需谨慎保护独立 DSH 启动 URL。
- 本地/远端 Workspace 的原生导航适配应先在非重要项目里验证；连接/映射失效时不应在本地运行远端任务。
- 自动化 CI 测试包括跨主机身份隔离、只读重连、丢失写回执不重试、导航竞态，以及 Node 24.9 Linux DSH 启动 smoke。**尚未完成真实 Windows Desktop ↔ 多 Linux Host 端到端验收。**
- 旧 SSH 文件路由及 WebView 兼容入口仍保留，但不应将它们当作本版本的 Full Remote Backend。

构建、测试与打包：

\`\`\`sh
pnpm build
pnpm test
node scripts/package-plugin.mjs
dsh plugin --profile desktop add /path/to/dsh-plugin-remote-ssh-2.5.0.tgz
\`\`\`

请使用 Desktop 自带的 \`dsh\` 命令安装，并**完全退出、重启 Desktop**；刷新 UI 不能重载 Windows Host 插件模块。

更多：[多 Host Backend 设计与测试](docs/native-multihost-backend.md) · [SSH 使用与故障排查](docs/remote-dsh-host.md) · [Helper 协议](docs/remote-runtime-protocol.md) · [旧版路由兼容](docs/desktop-ssh-runtime.md)。
