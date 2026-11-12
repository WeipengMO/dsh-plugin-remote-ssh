# Windows Desktop → 多 Linux DSH Host Backend（v2.5.0 实验版）

## 核心目标与参考

参考 [Yan-Zero/dsh-remote-ssh](https://github.com/Yan-Zero/dsh-remote-ssh) 的 **Full Remote Backend** 分层思路：独立的 Host Backend、每 Host 一条长期逻辑连接、持久 Session、对本地功能透明隔离、断线后按协议恢复。**本仓库未复制其源代码，也没有下载或执行第三方 dsh-host。** Linux 端继续运行官方 DSH Web/Host，通过官方 Typert Session RPC 通信。

TUI 有公开的 \`tuiBackends\` provider。当前 Windows DSH Desktop 没有等价接口，所以本分支增加一个**可撤销的 Workspace 导航兼容适配器**。这不是将官方 Conversation UI 的 \`ctx.connection\` 改造成多 Host，也不是部署第三方 Host 程序。

## 已实现的路径

\`\`\`text
DSH Desktop（Windows）
  官方侧边栏：Local Workspace / Linux-A Workspace / Linux-B Workspace
        │
        ├── Local → 原本的 ctx.uiWorkspace.openWorkspace() → Windows Agent
        │
        └── SSH Workspace → 验证 Host 映射（DSH WorkspaceRegistry）
                │
                ▼
          Host Backend Router（仅替换 Workspace 导航方法）
                │
          main 原生 React 插件面板（不是 WebView）
                │
          /api/remote-ssh/runtime/native/*
                │
          NativeHostSessions（Host/Workspace/Session 不透明引用）
                │
          per-Host SSH tunnel + DSH /connect v2 API Peer cookie
                │
          Linux DSH Web Host → Session/Agent/工具运行在 Linux
\`\`\`

- 设置 → Remote SSH 中选 Linux 目录 →「添加到左侧工作区」：\`workspaceRegistry.create()\` 创建稳定原生 Workspace 记录。
- 点击左侧该 Workspace 时，插件根据认证的 \`/state.registeredWorkspaces\` 在本机 Workspace ID 上查出 Linux Host+cwd，调用 \`openNativeHostSessions\`；**不调用 Windows 的 \`uiWorkspace.openWorkspace()\` 创建本地 Agent**。
- 自动恢复该 Linux cwd 最近的 Session；若没有，则在 Linux Host 用 \`session/create({ cwd })\` 创建 Session；点击「新会话」产生新的 Linux Session。
- 旧的本地 Workspace 及 Session 继续使用 DSH 原有服务，不改变其 RPC、工作目录或 UI。
- \`Session ref\` 由 Node 插件 Host 生成，绑定 SSH Host + 规范 Linux cwd + Host SessionId + 配置版本；浏览器不能选择别人的 SessionId，也拿不到 Host 启动 token、API Peer Cookie。
- 登录遵守官方 \`/connect?interactions=none\` → HTTP 302 + v2 Peer cookie，\`session/list\` 发送 \`_request\`，其他接口发送 \`request\`。
- 同一 SSH Host 复用 Linux Host 进程、SSH tunnel、认证 Cookie；不同 Host 完全分开。Session list 按实际 Linux \`cwd\` 过滤，不混入同 Host 的其他 Workspace。
- 物理 SSH tunnel 掉线：\`list/events\` 作为被动只读请求可在一次重连后重试；\`create/prompt/cancel\` **不重试不确定是否提交的请求**，避免重复运行 Agent。
- 断线、配置删除和无效 Workspace 映射拒绝回退 Windows Agent。选择不同 Workspace 的异步竞态有世代令牌保护。

## 限制：仍不是完整官方 Conversation UI 多 Backend

目前 Host Session 在 DSH Desktop 的 **原生 main 槽位内由插件自己的 React 面板展示**，而不是官方 \`UiConversation\` 组件。它可以显示文本历史、发送文本 Prompt、取消请求，并有简单的 SSH PTY / 只读 Git 小工具。

尚未实现：
- 官方 Conversation 的实时 token、工具执行/审批、问答交互、附件与引用、模型选择以及上下文状态同步；
- 由 Linux Host 所有的 Session 直接出现在官方左侧 Session 子列表，官方 Git/worktree/terminalController 的会话级投影；
- 本地 \`ctx.sessions\`、\`ctx.workspaces\`、\`ctx.connection\` 真正的多 Host 重绑定。

尤其是 **\`interactions=none\` 表示此插件无法应答需用户确认的远端工具请求**。不要把这个实验版用于要求人工审批、敏感生产环境或长时间无人值守的任务。遇到审批可改用独立 Linux DSH WebView 备用入口。

## 下一步要改的 Core 接缝

推荐向官方 Desktop 提议一个与 \`tuiBackends\` 对等的 \`workspaceBackends\`（名称仅示意）：

\`\`\`ts
interface WorkspaceBackendProvider {
  accepts(workspaceId: string): boolean
  open(workspaceId: string, signal: AbortSignal): Promise<{
    backendId: string
    sessionId: string
    connection: ClientConnectionRpc
    dispose(): Promise<void>
  }>
}
\`\`\`

让 **Workspace → Backend → Session → Connection** 由官方 \`UiWorkspaceService\` 和 \`UiConversation\` 按 Session 所有权选择，而不是插件 monkeypatch 方法。还需要 Host Event stream、Pending Interaction、模型/工具/终端 Git 上下文等所有客户端 service 的 per-Backend 隔离。仅暴露上述接口并不足以完成全部功能。

当前兼容适配器仅拦截 \`uiWorkspace.openWorkspace\`、\`startSession(workspaceId)\`、\`connectWorkspace\`，插件卸载恢复原方法；远端 ID 的 \`connectWorkspace\` 会明确拒绝，而不是生成假的本地 Session ID。

## 验收及风险

自动化测试覆盖：两台 Host 同 SessionId、不同 Linux 工作目录过滤、Local/Remote 导航委派、异步竞态、配置丢失 fail closed、断线只重试只读、丢失 Prompt 回执绝不重复提交，以及官方 Node24.9 Linux Web 启动 smoke。

**还没有真实 Windows Desktop + 两台 Linux 主机的端到端验收**；首次安装请在非关键仓库试用，验证主机指纹、实际执行位置、不同 Host 之间不会串话，尤其不要把模拟测试当作生产稳定性证明。

插件的 SSH 兼容文件/终端/Git 路由暂时保留供已有工作区或调试使用，不代表本分支主要采用挂载执行架构。
