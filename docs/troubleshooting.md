# 安装、使用与故障排查

适用于 DSH Remote SSH v1.1.0；正式发布版功能以实际安装的版本为准。

## 安装后找不到 Remote SSH 设置

1. 确认安装到正在使用的 profile：Windows DSH Desktop 使用 `--profile desktop`，Web Host 使用 `--profile web`。
2. 完全退出并重新启动 DSH Host；Windows 仅关闭窗口可能不会退出托盘进程。
3. 确认安装包中包含 `package.json`、`dist/index.js`、`lib/client.js`、`cordis.patch.yml` 和 `vendor/ssh2/`。仅复制 `src/` 无法运行。
4. 检查 Host 日志。此插件需要 DSH `fs`、`shell`、`tools`、`workingDirectory`、`systemPrompt`、`webServer`、`connection` 服务；缺少必需服务时会拒绝加载。

## 插件升级后报 405 / method not allowed

DSH Host 可能仍在运行旧版插件的 ESM 模块，而页面已经读取新版 `lib/client.js`。因此刷新网页或反复安装不一定会刷新服务端 HTTP handler。

处理方式：**完全重启 DSH Host**，随后刷新 Web / Desktop 页面。可通过 `/api/remote-ssh/state` 返回的版本与已安装 `package.json` 版本判断是否匹配。`/config/resolve` 当前支持 GET 与 POST。

## 从 GitHub 安装失败 / prepare 被 pnpm 拦截

DSH CLI 支持 Git 来源安装，但 Git 构建脚本可能受到 pnpm 安全策略限制。本项目的 Git 地址安装尚未完成独立 Windows Desktop 端到端验证。

推荐从 [v1.1.0 Release](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases/tag/v1.1.0) 下载正式 `.tgz` 安装包。不要为了规避构建保护而全局放宽 pnpm 的安全策略。

若错误出现 `ECONNREFUSED`、`ETIMEDOUT` 或 `registry.npmjs.org` 连接失败，通常是 npm Registry 网络访问问题；即使下载了本地 `.tgz`，安装器仍可能需要联网解析依赖。先检查系统代理、网络防火墙、Registry 可达性与 DSH 进程实际使用的代理设置，再重试；这不是 SSH 远程服务器连接错误。

## SSH 连接失败、主机指纹不匹配

- 检查主机名 / 端口、`~/.ssh/config` 别名、用户名、`IdentityFile` 与 ssh-agent；目标 Linux 主机必须有可用的 SSH 和 SFTP 服务。
- 首次连接出现未知 Host Key 时，**通过可信的第二渠道**核对完整 SHA256 指纹后再确认信任。
- `HOST KEY MISMATCH` / revoked 表示信任记录与服务器不一致。先调查主机是否迁移或更换密钥，不要盲目覆盖。
- 插件主要使用公钥或 ssh-agent，不依赖交互式密码登录。
- 使用 Cloudflare Access 时，目前只支持受限的 `cloudflared access ssh --hostname %h` ProxyCommand 写法；普通自定义 ProxyCommand 不保证兼容。

## 远程文件能打开，但 Agent Bash 命令失败

文件路由走 `ssh2`/SFTP，而 Agent Shell 走运行 DSH Host 的本地 OpenSSH 客户端，因此可能出现 SFTP 成功但 Shell 失败。

在运行 DSH Host 的机器上检查 `ssh -V`；Windows 需要安装 OpenSSH Client，并确认 `ssh.exe` 可被 DSH 进程找到。必要时用环境变量 `DSH_SSH_BIN` 指向其路径。目标 Linux 主机需要 Bash；远程工作区执行的 Shell 语法是 Bash/POSIX，**不是 Windows PowerShell**。

## 远程工作区的工具卡片仍显示 bash 或 pwsh

v1.1.3-beta.3 测试版同时包含 PR #24 的 macOS/Linux `bash` 及 Windows `pwsh` 远程 Agent 隐藏修复。仅在 DSH 支持 Agent 级 `tools.restrict()` 时隐藏它们；本地会话不受影响，历史工具卡片不会重命名。

- 确认安装的是 v1.1.3-beta.3 测试包，并完全退出 DSH Host 后重新启动，再创建新的远程 Agent 会话。
- 远程 Linux 命令应只调用 `remote_bash`，不要调用宿主原生 `bash/pwsh`；旧宿主可能仍显示它们，但远程原生 Shell 执行仍按现有安全路由拒绝。
- `remote_bash` 仅支持前台命令执行，超时会返回 `timedOut: true`；原生 `bash/pwsh` 远端执行默认阻止。
- 可让 Agent 调用 `remote_ssh_status` 确认 `remote: true`，并在 `remote_bash` 中执行 `pwd; uname -s` 验证实际平台。
- 如果 `remote_bash` 提示当前不是 SSH 工作区，检查会话的当前工作目录是否已正确切换；工具不会静默退回本地执行。

## remote_bash 报 SSH_APPROVAL_DENIED 或 read-only

远端 Linux Bash 不受本机 DSH Sandbox 保护，因此新代码默认首次运行时请求 Agent 会话/SSH 工作区级别的审批。审批策略为 never、无交互审批服务或用户拒绝时会拒绝执行，不会回退本地命令。DSH read-only 模式始终拒绝通过远端 Bash 执行任何命令。

插件配置：`remoteBashApproval: 'session' | 'command' | 'off'`，默认 session；off 关闭额外审批但仍执行只读限制。旧原生 pwsh SSH 兼容需显式设置 `allowLegacyRemoteShell: true`，可能绕过插件的会话审批，不推荐。

## 远程 read/write 结果里显示的路径

远端文件读写工具会展示 Linux POSIX 路径供 Agent 后续使用，路由内部仍采用 Windows UNC / 虚拟路径标识；不要修改本地空占位目录。若路径不匹配，先调用 remote_ssh_status 检查工作区归属。

## 右侧原生终端或 Git 面板不显示远程内容

原生终端适配需要 DSH Host 提供 `subprocess.spawnTerminal()`；原生 Git 子进程适配需要 `subprocess.spawn()`。缺失相应服务时，Host 日志会提示功能不可用，但 SSH/SFTP 文件路由与设置中的远程 Git 状态查询可以分别工作。

进入远程项目后检查当前会话与项目是否对应。不同会话或本地项目的终端不应该被转接到错误的 SSH 主机。需要排查 Git 工作区状态时，优先使用 **设置 → Remote SSH → Git 状态**，而不是把右侧 **变更请求**（Pull Request）面板视为未提交文件列表。

## 切换目录未生效 / 没有可选 Agent 会话

- **新建项目**：选择 SSH 主机和目录后，插件返回真实的本地**空占位目录**，交给 DSH 原生项目流程登记；不要期待 Windows 文件管理器能在该目录看到远端文件。
- **已有会话切换**：需要真实的 Agent 实例。先在目标 DSH 会话发送消息以激活 Agent，再刷新 Remote SSH 面板；选择对应会话进行切换。
- 会话切换是**会话级别**的，不是全局修改所有项目。旧会话与新会话可能处在不同工作目录。
- 如果发现工作区映射失效，请重新打开目标项目或重新选择远程目录；不要手动修改 `~/.dsh/remote-ssh/workspaces.json`。
- 远程目录不可用时应报错或显式恢复，不能默默把写入指向本地相似路径。

## 本地验证

要求 Node.js 22 和 pnpm 10：

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm pack
```

`pnpm test` 构建插件并运行本地单元 / 集成测试；测试使用模拟 SSH/SFTP 服务，无须使用真实 SSH 私钥。最终仍应在实际 DSH Desktop/Web Host 和 Linux 服务器上验证新建项目、Agent 读写、Shell、终端与 Git 集成。

若怀疑包内遗漏构建产物，可检查 `.tgz` 内是否存在 `package/dist/index.js`、`package/lib/client.js`、`package/cordis.patch.yml` 与 `package/vendor/ssh2/`。

## 反馈问题时请附上

- DSH Host 版本、操作系统及 DSH profile（`desktop` 或 `web`）。
- Remote SSH 插件版本、具体步骤、完整的**非敏感**错误代码或日志片段。
- 出问题的是文件 / 搜索 / Shell / 原生终端 / 原生 Git 中的哪一项。
- 是否使用 SSH Config、ssh-agent 或 Cloudflare Access。

**发布日志前请删去用户名、主机地址、内网 IP、远端路径、Token、密钥内容和其他不希望公开的信息。** 可在 [GitHub Issues](https://github.com/WeipengMO/dsh-plugin-remote-ssh/issues) 提交经过脱敏的复现信息。

## v1.1.3 正式版：审批、搜索与安装安全

本版本正式整合 PR #24、#29、#30。Jupyter Viewer 的 PR #25 继续独立开发，**不包含在本版安装包中**。

**安装和升级：** 从 [v1.1.3 GitHub Release](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases/tag/v1.1.3) 下载已检验的 `dsh-plugin-remote-ssh-1.1.3.tgz`，校验 Release/CI 提供的 SHA-256，然后 `dsh plugin --profile desktop add ./dsh-plugin-remote-ssh-1.1.3.tgz`。完全退出 DSH Desktop（包括后台 Host）后重启。npm 安装以 Registry 实际可用情况为准。

**Chrome 安全提示：** CI 通过高危依赖审计、更新病毒库的 ClamAV 对包本体及解压内容扫描，并使用直接 `.tgz` 分发和下载 SHA-256 校验。这不构成无恶意软件证明，也不能保证 Chrome 不拦截；若仍提示危险，请先核查原因，不要绕过浏览器保护。

**远程工具隔离：** 只有 `remote_bash` 用于远端 Linux Shell。支持 Agent-scoped 限制的 DSH 宿主会对远程 Agent 隐藏原生 `bash/pwsh`，本地工作区继续使用原生 Shell；旧宿主即使仍显示原生 Shell，远程未授权调用也必须拒绝。禁止把 `run_code danger-full-access` 当作 SSH 审批替代品。

**审批耗时：** DSH PTC `run_code` 的总时间包含审批等待。插件记录等待开始、超过 20 秒的诊断警告、最终审批结果和执行耗时（不打印命令及密钥）；弹窗是否出现由 DSH Desktop 管理。审批取消不自动重试，调用方中止后的迟到许可不会执行命令，也不会缓存授权。

**远程目录：** `workdir` 省略或写 `.`；登录目录不一定是当前远程项目根目录。越过项目根目录的 `workdir` 必须被拒绝，但项目根目录限制不构成 SSH 进程沙箱。

**glob 语义：** `*.py` 在指定目录中只检查一层，`**/*.py` 显式递归，`projects/**/*.py` 使用字面前缀剪枝。递归 SFTP 搜索最多 8 并发，内置 20 秒 / 50,000 条目预算；超限输出 `SSH_SEARCH_TIMEOUT` / `SSH_SEARCH_LIMIT`，请缩小 `path`，避免对同一巨大工作区反复重试。SFTP 搜索不需要远端 Bash 审批。

**验证范围：** 自动测试涵盖远程文件路由、授权安全、浅层与递归匹配、并发预算、SSH 功能；真实 Git 仓库、右侧原生终端以及不同 DSH Host 版本仍建议单独验证。不要把 CI 通过当成完整跨平台端到端验收。
