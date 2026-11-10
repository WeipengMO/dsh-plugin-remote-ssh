# DSH Remote SSH · 设置页原生 SSH 工作区

> **v1.0.5 · SSH Config 自动解析与导入 + 版本错配自检**。面向 DeepSeek Harness（DSH）的原生客户端插件体系（Web profile 已做模拟验证，Desktop 待真机验证）。**在 DSH 设置页注册「Remote SSH」独立设置项**，以单列浅色响应式布局展示 SSH 主机和远程工作区；不再添加主侧边栏入口，也不再使用全屏浮层。无须修改 DSH 源码，也不依赖原版 8788 端口。

## 安装（推荐）

下载构建好的 `dsh-plugin-remote-ssh-1.0.5.tgz` 后，在 DSH 所在的机器运行：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-plugin-remote-ssh-1.0.5.tgz
dsh web
```

**Windows PowerShell** 示例（把路径改成实际下载位置）：

```powershell
dsh plugin --profile web add "C:\Users\YOUR_USER\Downloads\dsh-plugin-remote-ssh-1.0.5.tgz"
dsh web
```

**升级插件后必须完全退出并重启 DSH 进程，再硬刷新页面。** `dsh plugin add` 只替换磁盘文件，正在运行的进程会继续持有旧的 host 插件模块（Node ESM 缓存）；只刷新页面会得到「新前端 + 旧后端」的错配，读取 SSH Config 时报 `method not allowed`。v1.0.5 起面板会直接显示版本不一致的重启提示。进入 **设置 → Remote SSH**，出现主机管理和远程目录面板表示前端插件已加载；此时还需实际测试 SSH 连接和工作区切换。

**桌面客户端说明：** 本版 `settings.section` UI 使用与 DSH Web 相同的原生插件 Slot；然而 SSH 管理接口仍使用 Web Host 的同源 `/api/remote-ssh` 与 `webServer`/`connection` 会话认证。Electron 端的 Host 通道和路由尚未实测，**安装或显示设置项不代表桌面 SSH 已能使用**。在桌面客户端先退出进程，可尝试 `--profile desktop` 安装；若接口不可用，需要后续针对官方 Desktop API/IPC 适配。建议 Node.js 22+。Agent Shell 路由依赖系统 OpenSSH 客户端。

## 使用方法

1. 进入「设置」→「**Remote SSH**」，点击「添加主机」。填写主机别名/IP、端口、用户名、可选 `IdentityFile`；或使用页面中自动读取的 `~/.ssh/config` 别名。
2. 点击「测试连接」。**首次连接**会显示服务器 SHA256 host key 指纹；从服务器控制台或管理员独立核实后，完整抄写指纹并勾选确认。不得直接盲信本面板的值。
3. 在「文件浏览」中打开远程目录（支持 `~` 和绝对路径），可进入各级文件夹。
4. **先在 DSH 中创建/启动一个 Agent 会话**，刷新设置页 Remote SSH 面板；在「Agent 工作区」下拉框选中该会话。若列表为空，请在所需 DSH 会话先发一条消息，使 Agent 实例创建，然后刷新。
5. 点击「**使用此目录**」。这是对 DSH `workingDirectory.set(agent, virtualPath)` 的**真实调用**。成功后，此 Agent 的 `read/write/edit/glob/grep/bash/pwsh` 等受支持原生工具通过远程 FS/Shell Router 操作服务器目录，**无需复制整个项目到本地**。
6. 点击「**返回本地**」可恢复该会话此前的本地工作目录。最近工作区会保存在用户目录的插件状态文件中。

内置的「快速命令」页能通过同一连接执行 `pwd`、`git status`、`nvidia-smi` 等一条条命令，每条最多 30 秒、200 KB 输出。这**不是**完整交互式 PTY/xterm 终端；需要 `vim`、`tmux`、交互 REPL 时使用外部 SSH 终端。不要把它误认为已实现 Codex SSH 的全部功能。

## 与旧版的差异

| 维度 | 旧版 | 重构版 |
|---|---|---|
| 入口 | 独立 `127.0.0.1:8788` 网页 | **DSH 设置页 `settings.section`** |
| 主要界面 | 单独浏览器页面 | DSH 设置页内嵌 React 主机管理 / 远程目录工作台 |
| UI 工作区切换 | 仅记录 Local/Remote 意图 | **调用真正的 Agent workingDirectory 服务**，失败即显示失败 |
| Host 管理与 Agent 工具 | 两套不同数据入口 | 共用 **同一个 RemoteSshManager / SSH 连接池** |
| SSH Config | 需手动填 | **自动解析 `~/.ssh/config` 的 HostName / User / Port / IdentityFile / 保活 / cloudflared ProxyCommand，并在表单实时预览；不必再手动补全** |
| 文件目录 | 浏览器 UI 与 Agent 分离 | 实际 SFTP 列表 / 项目切换一致 |
| 安全性 | 独立 loopback API | **DSH 已登录会话认证** + Origin/CSRF 校验 + SSH 主机指纹校验 |
| 安装 | 手工 profile 改写脚本 | **`dsh plugin --profile web add <tgz>`** |

## 技术架构

```text
DSH Client / Web Settings
 └── settings.section ─────> Remote SSH 设置区 (React)
                                 │  同源 fetch + DSH 认证会话（Web）
                                 ▼
DSH Web Host
 ├── connection.requestRejection(req)   【先认证】
 ├── webServer.register('/api/remote-ssh')
 └── RemoteSshManager (单一注册表、连接池)
       ├── ssh2 + SFTP：主机探测、真实目录列表、文件操作
       ├── system OpenSSH：DSH 原生远程 bash/pwsh
       ├── FS/Shell Router：根据虚拟 cwd 自动路由
       ├── agent/created：维护可切换 Agent 会话引用
       └── workingDirectory.set(agent, virtualPath)：真正切换
```

主要实现：
- `src/index.ts`：DSH Host/Cordis 插件、真实工作区服务、注册 DSH API。
- `src/http-api.ts`：带 DSH 认证、输入约束和 CSRF 的同源管理 API。
- `src/client-web.js` + `src/client.css`：原生设置页 Slot、嵌入式面板、对话框。
- `src/ssh-config.ts`、`src/proxy-command.ts`：解析 SSH Host / Include 和受限 Cloudflare Access 代理连接。
- `src/manager.ts`、`src/connection.ts`、`src/{fs,remote-fs,shell}-router.ts`：沿用审阅过的远程文件与 SSH 底层实现。
- `src/tools.ts` + `src/remote-search.ts`：DSH Agent 的远程管理和搜索工具。
- `cordis.patch.yml` + `package.json#dsh`：DSH 官方 package/profile 安装元数据。

## 重新构建与测试

```bash
npm install
npm test
npm pack
```

**Windows 安装修复（v1.0.1）：** 本插件内置 `ssh2@1.17.0` 的纯 JavaScript 运行时代码（MIT，见 `vendor/ssh2/LICENSE`），不再把 `ssh2` 或 `cpu-features` 作为 npm/pnpm 依赖。原版需要执行的安装脚本只是**可选**原生加速，SSH2 自身具有 JS 兼容回退。因此此版不需要 Windows C++ 构建工具，也不需要执行 `pnpm approve-builds` 或关闭 pnpm 的安装脚本保护。首次安装 v1.0.0 遇到 `ERR_PNPM_IGNORED_BUILDS`，请直接安装 v1.0.5 tarball 完成升级。

**来源与更新责任：** `vendor/ssh2` 是 ssh2 1.17.0 的 JS 运行时代码，未包含本不需要的 C++ 编译源码；将来若 ssh2 存在安全更新，需要同步此内置副本。此版本仍需要原始的 `asn1` / `bcrypt-pbkdf` 纯 JS 依赖。

`npm test` 会先编译 TypeScript，再构建 `lib/client.js` 并执行单元/集成测试。测试覆盖：原生 Slot 注册、Dsh 插件清单、认证/CSRF、主机 CRUD、SSH Host Key 流程、SFTP 浏览、快速命令、真实工作目录修改/恢复、原始 FS/SSH2 协议集成。测试需要 Node.js 20+。如果测试环境没有系统 OpenSSH `ssh`，只有涉及调用系统 `ssh` 的子测试会跳过；若没有 DSH 官方运行时，也会跳过其校验测试。

## 安全边界与限制

- 本项目使用 SSH 公钥/ssh-agent 认证，不读取网页输入的密码、不在 UI 存储私钥正文。
- 认证使用 DSH `connection.requestRejection`：任何未登录/不可信浏览器请求均拒绝；不能用一个独立启动的匿名 Web 服务替代。
- **安全提醒：** 用户自己授权的 DSH 会话可以修改远程文件、运行远程命令。请只在可信环境使用；首次连接核对主机指纹。
- 没有远程 VS Code Extension Host、端口转发 UI、交互式 PTY、远程调试器，以及真正的多窗口状态同步；这些与 Codex 原生 SSH 工作区仍有差距。
- 如果浏览器 DSH 使用反向代理子路径而不是根路径，当前客户端 `/api/remote-ssh` 绝对路径需要部署者在代理层正确映射。
- 已在隔离环境验证单元/SSH2 模拟服务器；**没有你的 DSH 安装环境、服务器凭据或真实远程机器，不能声称已完成你的实际桌面/SSH 端到端验收**。

详细说明见 [设计与安全](docs/architecture.md)、[测试与排障](docs/troubleshooting.md)。

## 参考

- [DeepSeek Harness 的官方 WebServer 路由](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md)
- [DSH Connection 浏览器认证](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
- [dsh-ssh/dsh-ssh](https://github.com/dsh-ssh/dsh-ssh)（`settings.section` 和设置页管理 SSH 主机的原生插件模式）
- [JesmonX/dsh-web-shell](https://github.com/JesmonX/dsh-web-shell)（交互式终端单独插件的参考）


## 桌面安装与迁移说明

首先完全退出 Electron 桌面客户端，再安装：

```powershell
dsh plugin --profile desktop add .\dsh-plugin-remote-ssh-1.0.5.tgz
```

重新启动客户端，进入 **设置 → Remote SSH**。如果设置项存在但请求 `/api/remote-ssh` 失败，这是尚未适配完成的 Desktop Host API 问题，不能通过切回 `sidebar.footer.action` 修复。

Web profile 与 Desktop profile 相互独立，分别安装才能在对应运行环境看到入口。

`@dsh-ssh/dsh-ssh` 与本插件管理主机的服务和数据各自独立；若同时安装，设置页会显示两个 SSH 相关设置项，避免混淆建议仅启用其中一个。

## v1.0.3 UI 重设计

- 针对 DSH 设置弹窗内容区设计，不再按独立工作台的双栏宽屏布局绘制。
- 移除深色面板和多层卡片；使用与设置页相近的浅色表单和轻分隔线。
- SSH 主机列表默认只展示紧凑条目；超过 4 台才出现搜索框；SSH Config 别名和最近目录按需折叠。
- 连接状态、操作按钮、Agent 会话、文件浏览按阅读顺序排列；连接反馈显示在顶部。
- 将原来整页高度的空状态改为小尺寸说明；命令输出仍保留深色等宽终端区。
- 所有插件样式都限定在 `.rss-settings-container` 中，并处理了编辑主机/指纹确认弹窗的样式变量继承。
- 在模拟 DSH 设置宽度 551px 和 373px 下使用 Chromium 检查了视觉效果与横向溢出。

**限制：** 这些模拟截图用于 UI 检查，不等于实际 DSH Electron 端 SSH API 的端到端验收。

## v1.0.4：SSH Config 直接导入

在设置页点「添加主机」，在「从 ~/.ssh/config 选择主机」下拉框选 `nansha`、`ipf`、`txcloud` 等别名：

- 立即预览解析出的 `User@HostName:Port`、`IdentityFile` 和受支持的代理配置。自动填充的字段用「来自 SSH Config」标记，未手动改动时不会复制存储，所以后续修改 `~/.ssh/config` 会继续生效。
- 正确处理 `Host` 通配符、`IdentityFile` 多次出现、`Include`（含部分通配符）、Windows 路径与标准引号。手动覆盖字段仍优先生效；编辑已有主机时可点「清除手动覆盖」恢复继承。
- `ProxyCommand cloudflared access ssh --hostname %h` 可用于 ssh2/SFTP 和系统 OpenSSH 命令路由，执行方式为**严格限制的可执行文件加参数**，没有任意 shell 执行。其他 ProxyCommand、ProxyJump 仍会明确拒绝，不偷偷尝试直连。
- DSH 运行的 Windows 机器必须安装 `cloudflared` 且可从 PATH 调用；Cloudflare Access 的登录、授权由用户的 cloudflared 环境负责。
- **私钥路径必须在运行 DSH 的电脑上真实存在。** 例如配置中的 `/home/windz/.ssh/key/txcloud.pem` 是 Linux 路径，在 Windows DSH 上一般无效，应改为 `C:\Users\windz\.ssh\key\txcloud.pem` 或其他真实 Windows 文件路径。配置解析预览会提示路径不存在。

本版会继承 `HostName` / `User` / `Port` / `IdentityFile` / `ServerAliveInterval` / `ServerAliveCountMax`，但尚未实现 OpenSSH `Match`、任意 ProxyCommand、ProxyJump 全套语义；测试样例覆盖上述三个真实风格的主机配置，未连接用户真实服务器。可用 `ssh -G nansha` 对照系统 OpenSSH 的最终展开结果。

## v1.0.5：版本错配自检（修复 `method not allowed`）

排查发现：DSH 进程启动时把 host 插件模块加载进 ESM 缓存，之后用 `dsh plugin add` 升级只会替换磁盘文件，**不会重载进程内的 handler**。此时浏览器刷新会拿到新的 `lib/client.js`（会请求 `GET /api/remote-ssh/config/resolve`），而进程内仍是旧 handler（没有该 GET 路由），请求落到 `if (req.method !== 'POST')` 返回 405 `method not allowed`。反复重装、刷新页面都不会修好，唯一解法是**完全退出并重启 DSH 客户端**。

本版加入防护与兼容性：

- `/state` 返回插件构建版本（读自 `package.json`）；`lib/client.js` 的版本由构建脚本注入。两者不一致时面板顶部显示「服务端插件版本与界面不一致，请完全退出并重启 DSH 客户端」的警告，而不是让人面对一句裸的 405。
- `GET/POST /api/remote-ssh/config/resolve` 均可解析 SSH Config，容忍新旧前端的请求方式差异；仍只返回解析后的公开连接参数与密钥**路径**，不返回私钥内容。
- 405 错误现在带上报错误 method、route 与「重启 DSH」提示，便于定位。
- 客户端遇到 405 / `method not allowed` 时给出可直接照做的中文提示。

**升级到本版仍需完全重启 DSH 进程一次**，之后错配即可消除；以后再出现同类问题会直接显示可操作提示。
