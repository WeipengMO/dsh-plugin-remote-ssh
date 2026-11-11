# Remote Helper v1：SSH 控制平面协议

## 目的

这是 Windows DSH Desktop → Linux DSH Remote Host 的**第一段可部署代码**：Linux 上自动安装一个固定版本、内容哈希可验证的请求式 Helper，支持真实 Linux 环境检测和安全的 Git 只读查询。**不等于完整 DSH Host，不承载 Agent Session，不代理全部 Forge 或 Debug。**

## 自动引导流程

1. Desktop 原生目录选择器读取既有 SSH Config/主机；未知 SSH 主机仍需从可信渠道核对指纹。
2. 插件在 `/workspace/prepare` 中完成 SFTP 工作区路径验证后，调用 `RemoteHostRuntimePool.connect(host)`。只有一个 host 级安装任务，重叠请求共享。
3. 通过已有 ssh2 的 host-key-verified `SshConnection` 依次检查 `uname -s` 为 `Linux`，`node --version` 的主版本 ≥20。
4. SFTP 在 Home 下逐级创建或验证 `.cache/dsh-remote-ssh/agents/v1/<sha256>`，要求目录非 symlink 且没有 group/other 写权限。
5. 若版本对应的 `agent.mjs` 不存在，以随机文件名写入，SFTP rename，随后重新读取完整内容比对 SHA-256 和权限。存在但哈希不匹配时直接拒绝执行，不静默覆盖。
6. 通过 SSH exec 运行 `node '<路径>' '<base64url JSON>'`，得到带相同请求 ID 的单行 JSON 响应；`hello` 包含远端 Node/platform/arch/Helper 自身 SHA-256，用于协议协商和一致性校验。
7. `inspect` 在真实远端项目目录中调用固定、限时、只读的 Git 命令。服务器端 Helper 不提供自由 Shell、安装、写文件、删除、开放监听端口等功能。
8. Desktop 请求结束后 Helper 进程自动退出。SSH 断开时后续请求会通过现有 SshConnection 重连机制恢复，已部署的内容地址文件可以复用。

## 协议

请求（通过 SSH 命令参数传入，不经过浏览器）：

```json
{"protocol":1,"id":"<request-id>","method":"hello"}
{"protocol":1,"id":"<request-id>","method":"inspect","cwd":"/data/project"}
{"protocol":1,"id":"<request-id>","method":"dsh.version"}
```

响应：

```json
{"protocol":1,"id":"<request-id>","ok":true,"result":{"platform":"linux"}}
{"protocol":1,"id":"<request-id>","ok":false,"error":{"code":"REMOTE_HELPER_ERROR","message":"unsupported method"}}
```

`id` 必须与请求一致；没有显式协议版本、返回身份错误、输出截断、非零退出、超时都会失败。接口使用 15 秒总执行超时，每个 Git 子进程限制 8 秒，单项输出上限 64 KiB。

`inspect`：`git rev-parse`、`symbolic-ref`、`status --porcelain`、`worktree list --porcelain`、`diff --stat`、`rev-parse HEAD`。Git 运行环境关闭 optional locks、hooks、fsmonitor、终端认证提示；不接受用户提供的 Git argv。在浏览器 API `/runtime/inspect` 中只接受已登记的 workspace token；由服务端解析真实 cwd，防止浏览器任意指定服务器路径。

`dsh.version` 只检测 `dsh --version`，不自动安装 DSH。节点启用 Helper 不会自动建立 DSH Agent 会话。

## 插件 API

- `GET /api/remote-ssh/state`：增加 `remoteRuntime.phase` 和已校验 Host 列表。
- `POST /api/remote-ssh/runtime/connect`：`{host: "<registered-host-id>"}`，自动引导并报告平台、Helper digest 和远端 DSH 版本是否存在。
- `POST /api/remote-ssh/runtime/inspect`：`{token: "<registered-workspace-token>"}`，返回真实 Git 信息；不得传入任意 shell/cwd。
- `POST /api/remote-ssh/workspace/prepare`：在原生工作区创建流程中尝试自动启动/检查 Helper，返回 `runtime.state=verified-helper|unavailable`；不可用时保留现有 SSH 文件工具但明确披露错误。

所有接口沿用现有 Host 认证和防 CSRF 逻辑。版本无匹配或远端 helper 受损时失败关闭，而不是退回 Windows 本地执行。

## 后续协议扩展

完整的 DSH Remote Host 不应靠 Helper 持续增加自由命令；下一步必须在 Desktop Core 中引入每 Workspace/Session 的 Host 身份和连接选择，将 DSH Client Connection 的 unary/stream/RPC 与远端正式 DSH Host 对接。Helper 只负责版本协商、下载/校验/启动、健康检查、停机/清理这类**引导职责**。完整 Agent、审批、Forge、worktree、Debug Adapter 等必须经过 DSH Core 已定义的权限和远端服务接口。

参见 [README 架构](../README.md#架构目标与当前实现) 与 [Core 改造方案](desktop-ssh-runtime.md)。
