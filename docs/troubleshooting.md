# 安装、迁移与故障排查

适用范围：**DSH Remote SSH v1.1.3 及其当前文档描述的功能**。推荐通过 [npm 包](https://www.npmjs.com/package/dsh-plugin-remote-ssh) 安装；实际行为以安装版本与 DSH Host 能力为准。返回 [README](../README.md)。

## 1. 安装 / 升级

Desktop：

```powershell
# 完全退出 DSH Desktop（含 Windows 托盘进程）
dsh plugin --profile desktop add dsh-plugin-remote-ssh
dsh plugin --profile desktop list
# 已经是 npm 安装时更新单个插件
dsh plugin --profile desktop update dsh-plugin-remote-ssh
```

Web Host：

```bash
# 先停止正在运行的 DSH Web Host
dsh plugin --profile web add dsh-plugin-remote-ssh
dsh plugin --profile web list
dsh plugin --profile web update dsh-plugin-remote-ssh
```

安装或更新之后**完全重启 DSH Host**（仅刷新页面不足以换掉旧的服务端模块）；Web 页面可再强制刷新。可用 `npm view dsh-plugin-remote-ssh version` 检查 Registry 对外提供的版本，该命令不会安装插件。

**从旧 `.tgz` 安装迁移：** 先备份 profile 与 `~/.dsh/remote-ssh/` 下的插件数据，关闭 Host，再在原 profile 执行 `dsh plugin --profile desktop add dsh-plugin-remote-ssh@latest`（Web 改 `web`）；重启，核实已保存的 SSH 主机、项目映射及原来的会话。不要通过直接删除配置目录“重装”解决问题。固定回退版本可用 `add dsh-plugin-remote-ssh@1.1.3` 或可信 Release 包。

## 2. 安装后没有 Remote SSH 设置

- 检查是否装到正确 profile：Desktop 是 `desktop`，Web Host 是 `web`；Desktop profile 应先由应用初始化。
- 完全退出重启；Windows 需检查托盘进程是否仍存在。看到 405 / Method Not Allowed、旧页面配新版 Host 或版本不匹配时尤其如此。
- 插件需要 DSH 的 `fs`、`shell`、`tools`、`workingDirectory`、`webServer`、`connection` 等服务；缺少必需服务的 DSH Host 无法加载。查看非敏感 Host 日志。
- 使用本地 tarball 时检查包内 `dist/index.js`、`lib/client.js`、`cordis.patch.yml`、`vendor/ssh2/` 是否存在，单复制 `src/` 无法运行。

## 3. npm 网络错误、无法更新 / 依赖警告

- `ECONNREFUSED`、`ETIMEDOUT`、无法连接 `registry.npmjs.org`：先排查运行 DSH CLI 的机器的网络、代理和 Registry；这不是远端 SSH 握手错误。
- `[WARN] Issues with peer dependencies`：这是需要检查的依赖提示，**本身不等于安装失败**；继续核实插件是否出现在 profile、是否成功加载。
- 更新按钮缺失：确认之前是否从 npm 安装，而非本地 `.tgz` / `github:`；检查宿主是否支持版本检查与更新 UI。CLI 可用 `dsh plugin --profile <profile> update dsh-plugin-remote-ssh`。
- 安装成功但前端仍旧：先完全退出 Host，再重启并刷新；如果是旧 `lib/client.js` 与新版服务端混用，可通过 `/api/remote-ssh/state`（在已登录的 DSH 会话中）检查 Host 插件版本。

## 3.1 Linux DSH Web 选择“本地电脑”时目录选择器报错

- 报错 `directoryPicker.pick needs the native capability; the composed picker serves "browse"` 表示 DSH Host 提供了网页内目录浏览能力，而不是操作系统原生目录选框；**不属于 SSH 故障**。
- 在包含此修复的插件构建中，点击 **新建项目 → 源文件夹 → 本地电脑 → 选择本地文件夹** 时会先尝试原生选框；若 Host 明确表示只有 `browse` 能力，插件会**留在原弹窗内**切换为目录浏览器，可按目录进入、编辑绝对路径、显示隐藏文件夹及新建目录。
- 这里的“本地”是 **运行 DSH Web Host 的 Linux 服务器**，不是浏览器所在的 Windows/macOS 电脑。无法通过浏览器拿到访问者机器上任意绝对路径；要使用访问者机器上的项目，应在该机器运行 DSH Desktop，或通过 SSH/文件同步访问项目。
- Desktop 原生目录选择成功、用户取消、其他原生错误的行为保持不变；只有“native capability 不可用”才会自动使用网页浏览。DSH Host 必须同时提供 `uiWorkspace.listDirectory` 对应的 browse 后端，才能列出目录。

## 4. SSH 连接、Host Key 与认证

- 核实 `~/.ssh/config` 别名解析、HostName、端口、用户、IdentityFile、ssh-agent；服务器需要 sshd 和 SFTP。快速导入会填充已解析字段，编辑已保存主机不会强行覆盖其自定义值。
- 首次出现未知 Host Key：必须通过可信的第二渠道确认完整 SHA256 指纹后再信任；`HOST KEY MISMATCH` / revoked 时先调查服务器是否真正换过密钥，**不要关闭 Host Key 校验**。
- 插件以公钥/ssh-agent 为主，不提供依赖交互输入密码的通用 SSH 登录流程。
- `ProxyCommand` 仅支持受限的 `cloudflared access ssh --hostname %h` 形式，不能假定任意 ProxyJump / 自定义脚本都可使用。
- `Connection lost before handshake`、ssh2 重复 error：检查端口、网络、服务端日志及 SSH 握手。v1.1.1 起包含握手中断时的保护修复；仍可能因服务器或链路问题而无法连接。

## 5. SFTP 可以访问，但 remote_bash 失败

文件操作使用 `ssh2` / SFTP，而 `remote_bash` 使用 **DSH Host 本机的 OpenSSH 客户端**。前者成功不代表后者可用。

- 在运行 DSH Host 的电脑检查 `ssh -V` 与 SSH 配置。Windows 需要可用的 OpenSSH Client；必要时用 `DSH_SSH_BIN` 指向 `ssh.exe`。
- 远端是 Linux Bash/POSIX 命令，不是 Windows PowerShell。使用 `remote_ssh_status` 确认会话处于远程工作区，然后 `remote_bash` 执行 `pwd; uname -s`。
- `SSH_APPROVAL_DENIED`、没有审批弹窗：审批拒绝、缺少 Approval 服务、会话策略不允许或用户取消都可能使操作失败，不能自动退回本机执行。DSH `read-only` 会话始终拒绝远程 Bash。
- 默认 `remoteBashApproval: 'session'`：每个 Agent 会话和远程工作区批准一次；可改成 `'command'`。设为 `'off'` 或开启 `allowLegacyRemoteShell` 会降低保护，不建议作为排障捷径。
- `remote_bash` 为前台执行，超时可能返回 `timedOut: true`；在 PTC `run_code` 内，审批等待也会计入整体耗时。取消审批不应被自动重试。
- `workdir` 默认是当前远程项目目录，不要凭 SSH 登录后的 `$HOME` 猜测项目根目录；超出映射工作区的 `workdir` 会被拒绝。

## 6. 原生 bash / pwsh 仍显示，或工具路由错误

v1.1.3 在**支持 Agent 级 `tools.restrict()` 的 DSH Host** 中对远程会话隐藏本机 `bash` / `pwsh`，切回本地项目后恢复。旧 Host 或历史工具卡片可能仍显示原生名称；这不等于它们可获得远程执行权限。

远程 Agent 应使用 `remote_bash`，本地 Agent 使用宿主原生 Shell。若发现仍调用本机 Shell，请确认当前 Agent 会话的远程目录映射并更新/重启插件；未经批准的旧路由默认拒绝 SSH 执行，不能改成本地继续跑。

## 7. 远程目录、文件搜索与 Git/终端

- 本地工作区目录是**空占位目录**，不是远端源码的文件系统挂载。不要在系统文件管理器里对占位目录进行源码编辑。
- 会话切换要求已存在且激活的 Agent。切换为会话级行为，不是全局重定向所有项目；映射失效时重新打开项目，避免手改 `~/.dsh/remote-ssh/workspaces.json`。
- `glob({pattern: "*.py", path: "."})` 只搜索当前层；`**/*.py` 才递归。递归搜索最多 8 个并发 SFTP 目录列举，有 20 秒 / 50,000 条目预算；`SSH_SEARCH_TIMEOUT` 或 `SSH_SEARCH_LIMIT` 表示需要缩小 `path` 或模式。不会为了搜索自动调用 Bash。
- 右侧原生终端需要 Host 提供 `subprocess.spawnTerminal()`，原生 Git 兼容适配需要 `subprocess.spawn()`；缺失时插件设置页的远端 Git 状态查询仍可独立使用。DSH“变更请求”面板不是未提交文件列表。

## 8. 本地复现与提交 Issue

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm pack
```

测试覆盖本地模拟 SSH/SFTP 和若干原生路由回归，不代表所有实际 Windows/macOS/Linux Host、终端及 Git 场景都经过实机验收。

提交 [Issue](https://github.com/WeipengMO/dsh-plugin-remote-ssh/issues) 时请注明：DSH 版本、插件版本、系统/profile、触发步骤、功能类型（SFTP/搜索/Bash/终端/Git）、相关错误代码。**务必遮盖用户名、主机/IP、路径、Token、私钥和其他敏感信息。**

详情见 [架构与安全](architecture.md)。
