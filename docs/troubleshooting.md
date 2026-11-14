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

## 测试版 v1.1.3-beta.2：远程审批与 glob 性能优化

本测试版在 v1.1.2 Worker 修复基础上，改进 remote_bash 审批阶段诊断与远程工作区动态指引。**测试分支仅产出 GitHub Actions 安装包，不自动发布到 npm 或正式 GitHub Release。**

1. 打开该测试分支 Pull Request 的 GitHub Actions「Test and package (Node 22)」构建，确认 CI 全部通过。
2. 在该 Actions 页面 Artifacts 直接下载 `dsh-plugin-remote-ssh-1.1.3-beta.2.tgz`，**没有额外 ZIP**。仅在依赖漏洞检查和 ClamAV 病毒扫描均通过后才提供该测试产物。若 Chrome 仍将文件判断为危险，请保留拦截并反馈，不要绕过保护。
3. 在 DSH Desktop 所在机器上，使用 `dsh plugin --profile desktop add ./dsh-plugin-remote-ssh-1.1.3-beta.2.tgz`（注意 `./` 表示本地路径），然后**完全退出并重新启动 DSH Host**。

**审批等待不是 SSH 执行超时。** DSH 的 PTC `run_code` 总时间预算包含嵌套工具和用户审批等待。插件现在在 Host 日志中记录 `awaiting user approval`、审批结果/耗时和命令执行阶段（不记录原始命令或主机信息）；但是否显示审批弹窗、是否让父级 `run_code` 超时，仍由 DSH 宿主控制。不要把扩大 `run_code` 的 `danger-full-access` 权限当成远端 SSH 审批的替代方案。

**工作目录：** 默认不传 `workdir` 或传 `.`。登录目录（例如 `/home/user`）不一定等于所选项目根目录；显式指定的 `workdir` 必须位于当前远程项目内。注意工作目录范围检查**不构成远程进程沙箱**：获批的命令仍使用 SSH 账号本身的权限。

测试推荐：先在远程项目内执行 `console.log("worker alive")`、`remote_ssh_status`、`remote_bash pwd`，再测试首次审批允许/拒绝/取消；最后在单独的临时测试目录验证远程文件读写、只读 Git 状态和原生终端。不要以这组单元测试替代真实 Desktop → SSH 端到端验证。

### Beta 安装包完整性与 Chrome 安全提示

CI 使用 `actions/upload-artifact@v7` 的 `archive: false` 直接分发 `.tgz`；发布流程中使用 `actions/download-artifact@v8` 下载同一份测试通过的文件。构建会检查生产依赖高危漏洞，并使用更新签名的 ClamAV 扫描打包文件及解压内容。扫描中断、病毒命中或依赖审计失败时，流程会拒绝上传测试安装包。

GitHub Actions 页面显示的 SHA-256 是本次上传的 `.tgz` 本体，可与本地 `shasum -a 256 dsh-plugin-remote-ssh-1.1.3-beta.2.tgz` 比较。扫描通过**不保证**浏览器一定解除拦截，也不构成无恶意代码证明；如 Chrome 仍报危险内容，不要强制保留，优先调查具体警告和下载 URL。

### v1.1.3-beta.2 新增修复

- 普通 glob 文件名模式（例如 `*.ts`、`.dsh-ssh-smoke.*`）仅搜索当前目录，`src/*.ts` 等带路径模式按指定层级扫描；需要递归搜索请显式使用 `**/*.ts`。此变化使单层搜索不再意外扫描全部子目录。
- 远程 glob 设置 20 秒搜索预算与最多 50,000 个文件项限制，并支持取消正在等待的 SFTP readdir。到达时间预算返回 `SSH_SEARCH_TIMEOUT`，而非外层泛化的工具超时。
- `remote_bash` 等待审批 20 秒仍未完成时，在 DSH Host 日志记录诊断警告。用户取消或外层 `run_code` 中止后，即使审批延迟返回允许，也不会执行命令或缓存授权。Agent 指引明确报告每次审批尝试。
- 本版本不会改变原有远程执行权限边界；单独的 SSH 审批和工作目录限制保持启用。审批弹窗本身仍由 DSH Desktop 控制。

## v1.1.3-beta.3 集成测试与搜索说明

此版本同时整合 [PR #24](https://github.com/WeipengMO/dsh-plugin-remote-ssh/pull/24) 与 [PR #29](https://github.com/WeipengMO/dsh-plugin-remote-ssh/pull/29)，并加速递归 `glob` 搜索。此测试分支不会自动发布 npm 或正式 Release。

- 下载 `dsh-plugin-remote-ssh-1.1.3-beta.3.tgz` 并核对 CI SHA-256；如 Chrome 仍提示危险下载不要绕过。
- 只读 SFTP 浅层搜索仍使用 `*.py`。递归搜索显式使用 `**/*.py`，目录前缀可缩小不必要的遍历。
- 测试大目录搜索时依次验证 `**/*.py`、`src/**/*.py`、取消正在运行的工具，以及缩小 path 之后的行为。确保没有未经用户批准的远程命令执行。
- 旧版本 20 秒搜索预算与最多 50,000 文件项限制继续保留；超时必须明确报告 `SSH_SEARCH_TIMEOUT`，不能将结果静默截断为完整搜索。
