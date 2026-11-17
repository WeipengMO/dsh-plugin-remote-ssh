# DSH Remote SSH

[![Build & tests](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml)
[![ClamAV & dependency audit](https://img.shields.io/github/actions/workflow/status/WeipengMO/dsh-plugin-remote-ssh/build.yml?branch=main&label=ClamAV%20%26%20dependency%20audit)](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml)
[![Gitleaks secret scan](https://img.shields.io/github/actions/workflow/status/WeipengMO/dsh-plugin-remote-ssh/security.yml?branch=main&label=Gitleaks%20secret%20scan)](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/security.yml)
[![npm](https://img.shields.io/npm/v/dsh-plugin-remote-ssh?label=npm)](https://www.npmjs.com/package/dsh-plugin-remote-ssh)
[![GitHub Release](https://img.shields.io/github/v/release/WeipengMO/dsh-plugin-remote-ssh)](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases/latest)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**将远程 Linux 项目接入 DeepSeek Harness（DSH）工作区。** 通过 SSH/SFTP 使用 DSH 原生项目入口、Agent 文件工具、远程 Bash、Git/终端（取决于宿主能力），并直接预览本地或远程 Jupyter Notebook。无需在 SSH 服务器上另外部署 DSH，也不需要将整个远程仓库同步到本机。

*Remote Linux workspaces for DeepSeek Harness, with SSH/SFTP, approval-gated Bash, Git integration and a read-only Notebook Viewer.*

> **正式版本：v1.2.0** · [npm](https://www.npmjs.com/package/dsh-plugin-remote-ssh/v/1.2.0) · [Release / 安装包](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases/tag/v1.2.0) · [更新日志](CHANGELOG.md)  
> 社区维护的插件，不是 DeepSeek 官方内置组件。以下介绍适用于 v1.2.0；部分集成功能受 DSH Host 版本与可用 API 限制。

## 功能概览

| 功能 | 实现 |
| --- | --- |
| SSH 主机管理 | 在 **设置 → Remote SSH** 添加/编辑主机；从 `~/.ssh/config` 快速导入，支持密钥和 ssh-agent、SSH Host Key 指纹核验 |
| 远程工作区 | 通过 DSH 的“新建项目 → 源文件夹”选择 SSH 主机和远端 Linux 目录；本地使用空占位目录登记映射，而非同步源码 |
| Agent 文件与搜索 | 经 SSH/SFTP 路由文件读取、写入、编辑、`glob`、`grep`；支持远端项目路径 |
| 远程 Bash | 提供 `remote_bash`，默认按 Agent 会话/工作区审批；read-only 会话不允许执行 |
| Git 与终端 | 查看远端 Git 状态、Diff 统计、近期提交；原生 Git / SSH PTY 的可用性取决于宿主的 `subprocess` 能力 |
| Linux Web 本地目录选择 | 在无原生目录选择器时使用页面内的目录浏览器，支持目录导航、路径输入、刷新、隐藏目录和新建文件夹 |
| Jupyter Notebook Viewer | 在工作区文件树打开 `.ipynb`，只读展示 Markdown、代码行号与 Python 高亮、DataFrame 表格、文本/错误输出及静态图片 |

## 安装与升级

推荐从 **npm Registry** 获取正式版，并通过 **DSH 插件管理器** 安装，不要将插件 `npm install -g` 到全局 Node.js。请将插件安装到实际运行 DSH 的 profile：Desktop 使用 `desktop`，Linux Web Host 使用 `web`。

### Windows / macOS — DSH Desktop

首次使用 Desktop 时先启动一次以初始化 profile，然后完全退出 Desktop（Windows 还需退出托盘进程）：

```bash
dsh plugin --profile desktop add dsh-plugin-remote-ssh@1.2.0
dsh plugin --profile desktop list
```

### Linux — DSH Web Host

先停止正在运行的 DSH Web Host，再执行：

```bash
dsh plugin --profile web add dsh-plugin-remote-ssh@1.2.0
dsh plugin --profile web list
```

安装后**重新启动 DSH Host**，并刷新 Web 页面。仅刷新浏览器不会重新加载服务端插件。

### 从现有版本升级

如果此前通过 npm 安装，可更新单个插件：

```bash
dsh plugin --profile desktop update dsh-plugin-remote-ssh
# Linux Web：
dsh plugin --profile web update dsh-plugin-remote-ssh
```

也可以用 `add dsh-plugin-remote-ssh@latest` 选择 Registry 最新正式版，或用 `@1.2.0` 锁定本次版本。

**原先安装的是测试 `.tgz`？** 本地安装源不一定会自动切换为 npm。先备份 profile 及 `~/.dsh/remote-ssh/` 配置，停止 Host，再使用正确 profile 的 `add dsh-plugin-remote-ssh@1.2.0` 重新指定安装来源。重启后检查已保存主机、工作区映射和会话；不要通过删除数据目录进行“重装”。

### GitHub Release 安装包（备用）

如果 npm 无法访问，可从 [v1.2.0 Release](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases/tag/v1.2.0) 下载 `dsh-plugin-remote-ssh-1.2.0.tgz`，然后安装：

```bash
# Linux Web
dsh plugin --profile web add /path/to/dsh-plugin-remote-ssh-1.2.0.tgz
```

```powershell
# Windows Desktop
dsh plugin --profile desktop add "C:\path\to\dsh-plugin-remote-ssh-1.2.0.tgz"
```

官方发布流程会检查自动化测试、生产依赖、ClamAV 扫描和安装包摘要；离线 `.tgz` 仍可能需要从 Registry 获取依赖。更多内容见 [安装与排障](docs/troubleshooting.md)。

## 快速开始：连接远程 Linux 项目

1. 在 **设置 → Remote SSH** 添加 SSH 主机，或从 `~/.ssh/config` 导入。核对主机名、用户名、端口及身份文件。首次连接时，务必通过可信渠道核对 SSH Host Key SHA-256 指纹。
2. 进入 **新建项目 → 源文件夹 → 远程 SSH**，选择主机及 Linux 项目目录，创建工作区。插件只创建用于映射的本地空占位目录，**不会复制远端项目源码**。
3. 打开项目 Agent 会话，使用 `remote_ssh_status` 检查连接和工作区映射。
4. 需要执行命令时使用 `remote_bash`，例如 `pwd; uname -s; hostname`。默认需要审批，未批准不会执行。
5. 通过 DSH 文件工具浏览、搜索与编辑远程项目；在 **设置 → Remote SSH → Git 状态** 查看远端仓库信息。

### Linux Web：“本地电脑”指哪里？

在 Linux DSH Web 里，“本地电脑”指**运行 Web Host 的 Linux 机器**，不是你打开浏览器的 Windows/macOS 电脑。

- Desktop 保留系统原生目录选择器。
- Web Host 如果只提供 `browse` 而没有 `native` 选择能力，插件会在原工作区弹窗中切换到页面内目录浏览器，不再直接抛出 `directoryPicker.pick needs the native capability` 错误。
- 可以进入/返回目录、直接输入绝对路径、刷新、显示隐藏目录、新建文件夹；确认的是 Host 上选中的目录。
- 要访问浏览器所在电脑的本地文件夹，应在那台电脑运行 DSH Desktop，或通过 SSH/文件同步将项目提供给 Web Host；网页浏览器不能任意读取客户端本地目录。

## Jupyter Notebook Viewer（v1.2.0）

在 DSH **工作区文件树**中打开 `.ipynb` 文件，Notebook 会在文档标签页中以只读方式显示。本地项目通过 DSH 原生文件读取器读取，远程项目通过现有 SSH 文件路由读取，**不需要启动 Jupyter Server 或 Python kernel**。

**显示能力**

- Markdown 标题、基本行内格式、列表、引用及代码块。
- 代码 Cell 显示 `In [n]:`（位于代码框上方）、代码行号和 Python 语法高亮；长代码行可横向滚动，布局适应窄屏。
- pandas `text/html` 表格以受限、安全的表格节点展示；典型对齐的 `text/plain` DataFrame 也会尝试转为表格。其他普通文本保持原样。
- stdout/stderr、异常输出、PNG/JPEG/GIF 图片和 `text/markdown` 输出。

**边界与限制**

- **仅预览，不执行或编辑 Notebook。** 不提供内核、运行按钮、变量状态或交互式 widget。
- 不执行 HTML/JavaScript/SVG。对 HTML 输出仅提取符合白名单的表格结构和纯文本单元格内容，不载入脚本、样式、外链或图片。
- 支持 nbformat 4；单文件上限 **12 MiB**，最多 **2,000 个单元格**。Markdown、LaTeX 和复杂富媒体输出不保证完整保真。
- 正式包包含可选 Cordis 组件 `dsh-plugin-remote-ssh/notebook`：它提供经过 Cookie/同源校验的远程只读 SFTP 接口；工作区文档预览本身通过 DSH 已有的文件读取与扩展渲染能力工作。

## 发布安全检查

每次 `main` 更新或提交 Pull Request，GitHub Actions 会执行以下安全检查；**上方徽章反映的是 CI 工作流状态，不代表独立机构安全认证，也不能保证软件不存在漏洞或恶意行为**。

| 检查 | 运行位置 | 作用 |
| --- | --- | --- |
| ClamAV 病毒扫描 | [Build and release](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml) | 更新病毒特征库后，扫描生成的 `.tgz` 安装包与解包文件；扫描失败会阻止本次构建/发布 |
| 生产依赖审计 | [Build and release](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml) | `pnpm audit --prod --audit-level high`；检测高危或严重的已知依赖漏洞 |
| Gitleaks 密钥扫描 | [Secret scanning](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/security.yml) | 检查提交历史中的凭据和敏感信息泄漏 |
| SHA-256 安装包校验 | [Build and release](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml) | 校验 CI 下载的安装包与扫描过的构建产物字节一致，防止发布前意外替换 |

> **如何解读徽章？**「ClamAV & dependency audit」共用构建工作流的整体状态，不是两份独立的实时扫描报告；展开 [Actions 运行记录](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions) 才能查看各步骤的通过/失败情况。历史版本的检查应以对应版本发布时的日志为准。

目前**未启用 VirusTotal 第三方扫描**，因此不会展示 VirusTotal「已认证」或「0 检出」标识。VirusTotal 的文件上传需要 API Key，且会向外部服务提交安装包；正式接入后应仅针对可公开分发的发布包运行，并公开实际结果链接。参考 [VirusTotal 上传 API 文档](https://docs.virustotal.com/reference/files-scan)。

## 系统要求与安全说明

- **宿主：** DSH Host 必须提供插件所需的 `fs`、`shell`、`tools`、`workingDirectory`、`webServer`、`connection` 等服务；可选原生 Git/终端与文档预览还依赖相应宿主能力。插件包声明 Node.js **>=20**。不同 DSH 版本的实际兼容性需按宿主提供的 API 验证。
- **远端：** Linux SSH 服务及 SFTP；密钥或 ssh-agent 认证。运行 DSH Host 的机器需要可用的 OpenSSH 客户端（`ssh`），远程命令运行需要 Bash。
- **审批：** `remoteBashApproval` 默认为 `session`，也可设为 `command`；`off` 和 `allowLegacyRemoteShell: true` 会降低保护。DSH read-only 会话不允许运行远程 Bash。
- **权限：** 经批准的远程 Bash 以 SSH 账号权限执行，**不受本地 DSH 沙箱约束**，因此远端账号应遵循最小权限原则。SSH Host Key 变化应调查原因，不要盲目跳过验证。
- **搜索：** `*.py` 只匹配当前目录，`**/*.py` 才递归；递归最多 8 个并发 SFTP 目录读取，预算为 **20 秒 / 50,000 条目**，超限时应缩小范围。
- **不会静默回退：** SSH/SFTP 或审批失败不得改为在本地同名目录或本地 Shell 执行。原生终端/Git 需要宿主提供合适的 `subprocess` 能力；设置页 Git 状态不等于 DSH 的“变更请求”面板。

## 文档与开发

- [安装、迁移与故障排查](docs/troubleshooting.md)
- [架构、安全与工作区映射](docs/architecture.md)
- [版本发布、npm Trusted Publishing](docs/releasing.md)
- [更新日志](CHANGELOG.md) · [第三方许可](docs/THIRD_PARTY.md) · [提交 Issue](https://github.com/WeipengMO/dsh-plugin-remote-ssh/issues)

本地开发与回归测试：

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm pack
```

CI 测试包含模拟 SSH/SFTP、浏览器 UI 及路由回归，但不代表所有 Desktop/Web 版本、操作系统和 SSH 服务器组合都已完成实机端到端验证。项目采用 [MIT License](LICENSE)。
