# Remote SSH 架构（v2.5.0）

请先看 [native-multihost-backend.md](native-multihost-backend.md)，这是本版本的主要架构及兼容边界。

## Backend 组件

- **SSH Host 配置**：RemoteSshManager 保存独立 Host ID、已验证 SSH 主机密钥、远端 cwd 映射，不替换系统 OpenSSH 配置。
- **Linux Host 生命周期**：RemoteHostRuntimePool 在 Linux HOME 下启动/复用官方 DSH Web Host；RemoteDshWebTunnelPool 按 Host ID 管理 SSH localhost forward。
- **NativeHostSessions**：Windows Node Host 用官方 \`GET /connect\` 领 API Peer cookie；Typert RPC 的 \`session/list\`、\`session/create\`、\`session/events\`、\`session/prompt\`、\`session/cancel\` 发给 Linux Host，不向渲染进程暴露 cookie/token/raw Session ID。支持 Host config generation 检查、Workspace cwd 过滤、同 Host 连接缓存、物理断线后的只读请求一次重试；写操作禁止自动重试。
- **Workspace Registry**：\`workspaceRegistry.create()\` 登记稳定的 Windows DSH Workspace ID 和受限占位目录，后者不是文件镜像。服务端 \`/state.registeredWorkspaces\` 提供经过认证的 Workspace ID → Linux Host/root 映射。
- **Desktop Backend 导航**：在官方 \`uiWorkspace\` 未提供多 Backend Provider 的前提下，用可卸载兼容适配器拦截特定 \`openWorkspace\`、\`startSession\`，将 SSH Workspace 路由到 Linux Host Session。Local Workspace 委派给原函数，Host 映射缺失/失联拒绝本地回退。Desktop 仍使用原生 \`main\` Slot，但远端会话面板属于插件实现。

## 安全边界

所有本机插件 API 首先通过 DSH \`Connection.requestRejection()\`，再检查 Origin、Host、\`sec-fetch-site\`、自定义头和 JSON。远端 Typert RPC 的响应以 \`rpcId\` 关联，Host+cwd+SessionID 使用不透明随机引用，配置更新废弃旧绑定。SSH 隧道和 Linux DSH HTTP listener 均只绑定 loopback。

认证会声明 \`interactions=none\`，因此 **当前远端面板不能处理官方人工工具审批**。不要通过绕过权限或自动批准的方式弥补这一空缺。

## 兼容部分

原有 SSH fs/shell/subprocess/PTY/Git 路由保留用于旧 Workspace 和简单辅助工具。WebView 备用模式仍为每个 SSH Host 挂载一个独立 Linux DSH Web Client，能使用完整官方远端会话界面但不是 Windows 原生 Conversation。

当前代码**没有**实现 stock \`ctx.sessions\`/stock \`UiConversation\` 对不同 Linux Connection 的 per-Session 派发。最终方案需要 DSH Desktop 提供多 Backend/Client Context 正式接口并重新处理事件、交互和会话服务依赖。
