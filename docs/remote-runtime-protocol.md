# Remote Helper v1：SSH 控制平面协议

## 目的

这是启动独立 Linux DSH 的 SSH 控制层：插件在 Linux 上安装内容哈希可验证的请求式 Helper，检测环境、提供只读 Git 查询并按需启动 DSH Web。Helper 本身不承载 Agent 会话。

## 自动引导流程

1. Desktop 原生目录选择器读取既有 SSH Config/主机；未知 SSH 主机仍需从可信渠道核对指纹。
2. 插件在 `/runtime/web/open` 中完成 SFTP 工作区路径验证后，通过 `RemoteHostRuntimePool` 引导 Helper。只有一个 host 级安装任务，重叠请求共享。
3. 通过已有 ssh2 的 host-key-verified `SshConnection` 依次检查 `uname -s` 为 `Linux`，`node --version` 的主版本 ≥20。
4. SFTP 在 Home 下逐级创建或验证 `.cache/dsh-remote-ssh/agents/v1/<sha256>`，要求目录非 symlink 且没有 group/other 写权限。
5. 若版本对应的 `agent.mjs` 不存在，以随机文件名写入，SFTP rename，随后重新读取完整内容比对 SHA-256 和权限。存在但哈希不匹配时直接拒绝执行，不静默覆盖。
6. 通过 SSH exec 运行 `node '<路径>' '<base64url JSON>'`，得到带相同请求 ID 的单行 JSON 响应；`hello` 包含远端 Node/platform/arch/Helper 自身 SHA-256，用于协议协商和一致性校验。
7. `inspect` 在真实远端项目目录中调用固定、限时、只读的 Git 命令。`web.ensure` 可启动或复用回环 DSH Web；Helper 不提供自由 Shell 接口。
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
- `POST /api/remote-ssh/runtime/web/open`：校验目录并启动或复用 Linux DSH Web，返回启动状态和经本机 SSH 隧道重写的登录 URL。该 URL 包含敏感令牌。

所有接口沿用现有 Host 认证和防 CSRF 逻辑。版本无匹配或远端 helper 受损时失败关闭，而不是退回 Windows 本地执行。

Agent、审批、Git 和其他开发功能由独立 Linux DSH 提供。参见 [架构](architecture.md) 与 [旧工作区兼容性](desktop-ssh-runtime.md)。

## v1.6：Web Host 自动启动（web.ensure）

经严格验证的 SSH Host 与已通过 SFTP 规范化的远端 cwd 才可调用 web.ensure。请求为 {protocol:1,id,method:'web.ensure',cwd:'/real/Linux/cwd',installIfMissing:true}，响应 phase 为 starting、ready 或 failed；ready 含远端回环端口与官方带 ?token= 的启动 URL。控制层校验远端 URL authority、端口和令牌存在，再通过仅绑定本机 127.0.0.1 的 SSH TCP 转发交付给 Desktop WebView。用户主动打开远程 DSH 才允许 npx 下载固定官方 CLI。敏感 token 不存储在 Windows 插件配置，远端私有日志含 token，需保护；Node ≥24.9 和 SSH TCP forwarding 为前提。独立 DSH Agent/Session 仍由远端 Web Host 管理，不会重新绑定本地 Core Connection。详见 [remote-dsh-host.md](remote-dsh-host.md)。
