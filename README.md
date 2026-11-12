# DSH Remote SSH

[![Build](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml/badge.svg)](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml)
[![MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**直接在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 中打开远程 Linux 项目。** 通过 SSH/SFTP 让 Agent 的文件读写、代码搜索和 Shell 操作运行在服务器上；同时将 DSH 右侧的原生终端连接到当前远程项目。无需把源码同步到本机，也不需要 VS Code Server。

## 主要功能

- **原生工作区**：新建 DSH 项目时选择「远程 SSH」主机和源文件夹，之后像本地项目一样从侧边栏打开。
- **SSH 主机管理**：支持导入 `~/.ssh/config`、SSH 密钥与 ssh-agent、服务器指纹核验；支持受限的 Cloudflare Access 代理。
- **远程开发**：Agent 的 `read`、`write`、`edit`、`glob`、`grep`、Shell 和右侧 xterm 终端访问同一个远程文件系统。
- **本地/远程隔离**：只有已确认属于远程 SSH 项目的终端才走 SSH；本地项目仍使用 DSH 原来的 Windows/WSL 终端。
- **安全清理**：从 DSH 删除远程工作区时，仅尝试清理已识别且为空的本机占位目录，不删除服务器上的项目。

## 安装

在 [GitHub Releases](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases) 下载最新的 `dsh-plugin-remote-ssh-X.Y.Z.tgz`（预览版 Release 也包含安装包）。

完全退出 DSH 桌面客户端（包括托盘进程），在 Windows PowerShell 中运行：

```powershell
dsh plugin --profile desktop add "C:\path\to\dsh-plugin-remote-ssh-X.Y.Z.tgz"
```

如果使用 DSH Web 服务，则在运行 Web 服务的电脑上安装：

```bash
dsh plugin --profile web add /path/to/dsh-plugin-remote-ssh-X.Y.Z.tgz
```

`desktop` 与 `web` 是独立的插件 profile。安装或更新后，**完全重启对应的 DSH 进程**；如果界面和 Host 版本不一致，检查是否安装到了正确的 profile。

## 使用方法

**1. 添加服务器。** 打开 **设置 → Remote SSH → 添加主机**。可以选择 `~/.ssh/config` 中的别名，也可以手动填写地址、用户名、端口和私钥路径。点击「测试连接」，首次连接时核对主机 SHA256 指纹。

示例 SSH Config：

```sshconfig
Host nansha
    HostName 192.0.2.10
    User researcher
    IdentityFile ~/.ssh/id_ed25519
```

**2. 打开远程项目。** 点击 DSH **新建项目 → 源文件夹 → 远程 SSH**，选择主机和 Linux 目录（如 `/home/researcher/project`），点击「使用此远程文件夹」并创建项目。也可从设置页浏览远程目录后添加为工作区。「最近使用的远程目录」支持**清空历史**，只删除访问记录，不影响已添加的工作区或服务器文件。

**3. 使用原生终端。** 打开远程项目，在 DSH 右侧点击 **「+」新建终端**。终端应直接进入所选 Linux 项目目录。用 `pwd; uname -s; hostname` 核对位置；本地工作区应打开本地终端，而不是连接 SSH。

### 终端快捷键

| 操作 | 行为 |
| --- | --- |
| Ctrl+C（选中了终端文本） | 复制选中文本 |
| Ctrl+C（没有选中） | 向正在运行的命令发送中断 |
| Ctrl+V | 从系统剪贴板粘贴到终端 |
| Ctrl+Shift+V | 保留 xterm/系统原生粘贴方式 |
| 光标 | DSH 右侧原生终端显示竖线光标 |

快捷键处理仅在 DSH 原生**终端区域**生效，不覆盖聊天输入框或其他页面。剪贴板读写须获得桌面客户端/浏览器允许；如果 Ctrl+V 受系统权限限制，可尝试 Ctrl+Shift+V。

## 工作原理与安全限制

DSH 需要本地项目路径，因此插件会登记一个 **本机占位目录**（`~/.dsh/remote-ssh-workspaces/<token>`），将它映射到 SSH 服务器上的真实目录。**占位目录不是源码副本**；不要在其中存放自己的文件。

插件使用已认证的 SSH/SFTP 连接路由文件、搜索及 Shell 操作。原生终端按会话与工作区身份决定运行位置，避免误将本地命令发到服务器。SSH 映射失效时不会静默回退为本地执行。

注意以下边界：

- 使用前核对 SSH 服务器指纹；Windows 私钥路径必须对当前运行 DSH 的系统有效。
- 远程账号可能读取工作区以外的服务器文件；SSH 账户权限才是真正的访问控制。
- SSH 断线后可能需要重新打开终端；本插件不是完整的 VS Code Server/远程 DSH Host。
- DSH Host 如果运行在 WSL，原生 Shell 列表可能只显示 Linux Shell；本插件不会修改 PowerShell 等本地 Shell 的发现逻辑。
- 当前未提供完整远程调试器、扩展宿主或可视化端口转发管理。避免与其他接管同一 DSH 工作区选择器的 Remote SSH 插件同时启用。

## 开发与发布

环境：Node.js 22、pnpm 10。

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm pack
```

GitHub Actions 在 **PR** 中构建并测试；推送 `main` 成功后自动发布附带 `.tgz` 的 **GitHub Releases 预览版**；推送与 `package.json` 版本一致的 `vX.Y.Z` 标签会生成正式 Release。**不使用 GitHub Packages**。

进一步了解：[架构](docs/architecture.md) · [常见问题](docs/troubleshooting.md) · [第三方组件](docs/THIRD_PARTY.md)

[MIT License](LICENSE)

### 远程 Git 与命令环境

远程工作区的原生 Git 状态查询通过 SSH 访问服务器上的实际仓库，不会在本地占位目录创建假 `.git`。当前仅路由 DSH 原生面板的只读 Git 探测；涉及 Git 写入、worktree 创建等操作请使用远端 Agent Shell。SSH 会话的 Agent 会自动收到 POSIX 环境提示，本地会话不注入此提示。终端使用闪烁竖线光标。

