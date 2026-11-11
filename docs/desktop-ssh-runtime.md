# Windows DSH Desktop SSH：目标、现状与技术边界

## 真正的目标

用户希望像 Codex SSH 一样，在 Windows DSH Desktop 的**原生工作区与会话 UI** 内选择 SSH 服务器和远程源目录；所有 Agent 文件操作、Shell、终端、Git、worktree 与沙箱使用同一个 Linux 执行位置。不能把打开另一套浏览器 DSH Web 伪装成 Desktop 连接能力。

## 本版本做了什么

1. 使用 DSH 原生 `conversation.hero.workspace.directoryFlow` 和 `sidebar.workspaces.directoryFlow` 插槽直接打开 SSH 项目选择器。
2. 同一主机列表中合并已有记录和 Windows `~/.ssh/config` 中明确声明的 Host 别名。点击未登记的别名时，客户端调用鉴权的 `/host/quick-add`；后端再次从自己的 SSH Config 检查确实存在该别名，避免任意字符串变成 SSH 目标。
3. 首次 SSH Host Key 未知时，在原生选择器中调用已有 `/test` 与 `/trust` 流程，要求人工通过可信渠道核对完整 SHA256 指纹。无静默信任。
4. 用 SFTP 浏览真实的远端目录，选择后调用工作区注册接口，把本地**占位目录**映射为远端源目录。Agent FS / Shell / 原生终端沿已有桥接工作；Windows 本地会话原有路由不变。

## 为什么此时不能承诺完整 Git/Forge

DSH 官方 Forge 在运行 Git 前会调用 `ctx.subprocess.resolveExecutable()`、`ctx.sandbox.confine()` 和 `ctx.subprocess.spawn()`，并使用 `ctx.fs` 进行规范化处理。Windows 沙箱可能把 Git 命令包装为另一段执行脚本；Linux 返回的绝对路径也必须稳定转换为远端工作区的虚拟路径。当前插件基于本地占位目录和少量 Git 只读拦截进行桥接，无法保证支持 Git/Forge 的全部路径、命令和工作树行为。

DSH 官方的 [SSH Provider](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/ssh) 采用共享的 remote FS、subprocess 与 sandbox 接口；其文档注明目前仅支持 POSIX Host（Linux/macOS），不提供 Windows 端自动部署与完整 Desktop 工作区集成。

## 下一阶段：实现真正的 Codex 式运行时

需要在 DSH Desktop Host / Core 中增加**会话级 Remote Runtime**，而不仅仅给 Git 命令放行：

- Windows 本地 Client 管理 SSH Host、工作区切换与 Session；Linux helper 管理真实文件、进程、PTY、Git 与沙箱。
- 首次连接自动识别平台，安全协商远端 helper 版本并校验摘要；不要求用户手工安装第二套 DSH 或建立转发隧道。
- Core 的 `fs.resolve` / `processPath`、`subprocess.resolveExecutable` / `spawn` / PTY、sandbox、Git/Forge、文件 watcher / LSP 和工作树均遵循同一执行位置与权限策略。
- 完整的连接、取消、超时、断线重连和清理生命周期；严禁故障时在本地空占位目录执行写操作。
- Windows + Linux 真实 SSH 端到端验收，包括只读与工作区写入模式、Git 差异比较、Agent 会话、重连、远端路径规范化与安全测试。

仅改一个 Python/TypeScript 插件里的 `git` 白名单，无法替代上述工作。此版本的 Git 面板不可声称完全兼容。

## 安全

`/host/quick-add` 只接受 SSH Config 精确列出的具体 Host 别名；不接受通配 Host，也不接受任意外部主机地址。SSH 指纹在首次访问时必须人工核对。不能因为想要“一键连接”而自动信任未知主机。Web 访问令牌、SSH 私钥材料不被此流程收集。

## 交付进度

当前：**原生 UI 简化、自动导入 Host、首次身份确认集成、原有 SSH 文件/Shell/PTY 桥接**。未完成：**跨平台 Remote Runtime 全栈、完整原生 Forge/worktree/LSP/sandbox**。

## v1.5 新实现：版本校验的 Linux Helper

新增 `runtime/agent.mjs` 和 `src/remote-host-runtime.ts`。Windows Desktop 的 SSH 工作区打开后，插件会通过已验证主机身份的 SFTP 自动部署一份以 SHA-256 命名的 Helper，使用一次性 SSH exec 的 JSON 协议进行 Linux 平台检查、Node 版本协商、真实 Git 状态/worktree/Diff-stat 查询及 DSH CLI 存在性检测。无需独立浏览器、HTTP 端口或手动部署。Helper 不允许自由执行 Shell 命令，不能代替完整 DSH Host 的 Agent Session。

这一阶段解决的是可复用的 Remote Runtime **bootstrap/control-plane**。真正的 Host-Scoped RPC、Agent 事件和原生 Forge 接管仍需要修改 [官方 Desktop 启动/Host 绑定代码](https://github.com/deepseek-ai/deepseek-harness/blob/main/apps/desktop/src/main.ts)、[Client Connection 实现](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/connection/src/client/index.ts) 与 Core API，见本文件现有的后续任务。具体协议与错误处理见 [remote-runtime-protocol.md](remote-runtime-protocol.md)。
