# DSH Remote SSH

[![Build](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml/badge.svg)](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

让 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 直接打开 SSH 服务器上的项目。支持在 **DSH 桌面客户端和 Web 客户端**内管理 SSH 主机、浏览远程目录，并在创建项目时选择远程源文件夹；Agent 的受支持文件、搜索与 Shell 工具通过 SSH 操作服务器，无需同步整份源码到本机。

> **推荐入口：** 在 DSH「新建项目 → 源文件夹 → 远程 SSH」选择服务器与目录。**设置 → Remote SSH** 主要用于添加主机和检查连接，不需要手动选择活动 Agent 会话。

## 功能

- **原生 DSH 集成**：在设置页提供主机管理，在新建项目的源文件夹选择器中提供「本地电脑 / 远程 SSH」选项。
- **远程工作区**：选择远程文件夹即可登记为 DSH 项目；已登记的项目可从 DSH 工作区列表重新打开。
- **SSH Config**：读取本机 `~/.ssh/config` 的主机别名，并填充 `HostName`、`User`、`Port` 和 `IdentityFile`；保留原始别名以匹配已支持的高级选项。
- **SSH / SFTP**：公钥、ssh-agent、服务器主机密钥指纹验证、远程文件浏览与文件操作。
- **交互式远程 Shell**：将 DSH 原生右侧终端按工作区定向到 SSH PTY；本地工作区继续使用原提供者。
- **自动清理**：DSH 删除远程工作区时安全清理已知且为空的本地占位目录。
- **Agent 远程工具**：通过 SSH 路由 `read`、`write`、`edit`、`glob`、`grep` 和 Shell 命令；本地项目仍由 DSH 原生工具处理。
- **受限代理支持**：支持特定形式的 `cloudflared access ssh --hostname %h`；不执行任意 `ProxyCommand` Shell 脚本。
- **本地/远程隔离**：不同 SSH 项目使用各自的工作区映射，而非把远程文件复制到 Windows 目录。

## 安装

### 前提条件

1. 已安装 DSH，并可使用 `dsh` 命令。
2. 运行 DSH 的电脑可以通过 SSH 连接目标服务器，已准备公钥/私钥或 ssh-agent。
3. 本机可调用 **OpenSSH 客户端**（`ssh -V`）。如使用 Cloudflare Access，还需在本机安装并配置 `cloudflared`。

### 桌面客户端（Windows）

1. 在 [GitHub Releases](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases) 下载 `dsh-plugin-remote-ssh-<version>.tgz`。如果尚无 Release，可到 [Actions 构建记录](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml) 下载成功运行中的 **Artifacts** ZIP，解压得到 `.tgz`。
2. 完全退出 DSH 桌面客户端（包括系统托盘）。
3. 在 PowerShell 中安装下载的文件：

   ```powershell
   dsh plugin --profile desktop add "C:\path\to\dsh-plugin-remote-ssh-X.Y.Z.tgz"
   ```

4. 重新打开 DSH，在 **设置 → Remote SSH** 中检查插件入口。

### Web 客户端

```bash
dsh plugin --profile web add /path/to/dsh-plugin-remote-ssh-X.Y.Z.tgz
dsh web
```

`desktop` 和 `web` 是不同的插件 profile，安装到其中一个不会自动安装到另一个。**更新插件后也必须完全重启对应 DSH 进程**，以免界面和后端加载了不同版本。

### GitHub Releases 自动发布

安装包统一发布在 [GitHub Releases](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases)，文件名为 `dsh-plugin-remote-ssh-X.Y.Z.tgz`，可直接通过 `dsh plugin --profile desktop add <tgz>`（或 `--profile web`）安装。

- **每次推送到 `main`**：自动编译、运行测试、生成 `.tgz`，并创建带安装包的 **Development prerelease**（标签如 `dev-23-1`）。预览版不会被标记为最新正式版。
- **推送 `vX.Y.Z` 标签**：检查标签必须与 `package.json` 版本一致，测试通过后创建**正式 GitHub Release**，附件为同一格式的 `.tgz` 安装包。
- **Pull Request 和手动运行**：只编译、测试、上传 Actions Artifact，不创建 Release。

该项目**不再通过 GitHub Packages/npm Registry 发布**。开发预览版与正式版共用原始 DSH 插件包名；安装时不需要 npm Registry 权限或 Token。

## 使用

### 1. 添加 SSH 主机

进入 **设置 → Remote SSH → 添加主机**，选择 `~/.ssh/config` 中已有的 `Host` 别名，或直接填写服务器地址、用户名、端口和私钥路径。导入别名后，参数会填入普通、可编辑的输入框。

例如：

```sshconfig
Host nansha
  HostName 192.0.2.10
  User researcher
  IdentityFile ~/.ssh/id_ed25519
```

点击 **测试连接**。首次连接时，应先通过独立可信渠道核对服务器 SHA256 主机密钥指纹，再在插件中确认。不要仅凭弹窗提示就直接信任未知密钥。

**Windows 提醒：** `IdentityFile` 指向的私钥必须真实存在于运行 DSH 的 Windows 电脑上；服务器或 WSL 中的 Linux 路径不一定适用于 Windows 桌面客户端。

### 2. 将远程文件夹添加到 DSH 工作区

1. 在 DSH 中点击 **新建项目**。
2. 在 **源文件夹**中切换为 **远程 SSH**。
3. 选择已配置的 SSH 主机，浏览或输入远程路径（例如 `/home/researcher/project`）。
4. 点击 **使用此远程文件夹**，正常完成 DSH 项目创建。
5. 从 DSH 项目/工作区列表打开项目，并创建对话。Agent 的受支持操作会通过 SSH 访问这个目录。

也可以在 **设置 → Remote SSH** 浏览目录后，选择 **添加此文件夹** 以登记项目。**无需先启动 Agent、再手动切换它的 cwd**。

### 3. 在 DSH 原生终端标签直接使用 SSH

进入已添加的远程 SSH 项目，点击 DSH 右侧栏 **新建终端（+）**。插件在宿主侧识别当前终端创建请求的工作目录：

- **远程工作区**：`subprocess.spawnTerminal` 会改由已校验指纹的 SSH 连接创建远程 Linux PTY，首次 Shell 直接位于所选远程目录；输出原样交给 DSH 内置 **xterm** 标签渲染，支持 ANSI 颜色、光标移动、实时输入和窗口尺寸调整。
- **本地工作区**：完整委托给 DSH 自带的本地 Windows/WSL subprocess 提供者，不会意外连接上次使用的 SSH 主机。
- **远程映射丢失或 SSH 失败**：报错并拒绝回退到本地终端，以免误在 Windows 本地执行你以为是服务器上的命令。

**验证方法：** 在 DSH 右侧新建终端后执行 `pwd; uname -s; hostname`，期待 `pwd` 返回远程 Linux 项目目录、`uname -s` 返回 `Linux`。若仍显示 `/mnt/c/Users/...`，说明当前 DSH 版本没有通过该插件所包装的 subprocess 提供者，需保留原始日志反馈，不要假定终端已远程化。

**已知边界：** 纯 SSH PTY 不直接提供远端内核的前台进程组 ID，DSH 顶层的“发送前台信号”操作可能不被支持；在终端内敲 `Ctrl+C` / `Ctrl+Z` 可正常发送相应 PTY 控制字符。远程 SSH 断线后的终端需要重新打开；本实现不是 VS Code Server 或完整远程 DSH Host。

### 4. 删除工作区与本地占位目录

在 DSH 中删除已登记的远程工作区后，插件会监听 DSH 工作区变更事件，清除其对应的**空**本地占位目录以及已保存的路由记录。仅删除插件自己的直接子目录；如果占位目录中存在任何文件，或存在异常路径、符号链接，则保留目录并记录警告，避免误删数据。已登记的工作区映射可以在 DSH 重启后恢复用于清理。

不要在占位目录存储自己的业务文件。删除 DSH 工作区并不会删除 SSH 服务器上的源码，也不会自动删除 DSH 保留的对话历史。

### 5. 验证是否真正远程执行

在已创建的远程项目对话中，请 Agent 运行：

```bash
pwd
uname -s
hostname
ls -la
```

`pwd` 应显示**服务器上的 Linux 路径**，而不是 `C:\Users\...` 或本地占位目录。再用 Agent 的 `read` / `write` / `edit` 工具操作专用测试文件，并从远程 Shell 读取验证，即可确认文件工具与 Shell 是否访问同一份远程数据。

## 工作原理

```text
DSH 客户端
├── 设置 → Remote SSH（主机管理 / 测试连接）
└── 新建项目 → 源文件夹 → 远程 SSH
                        │
                        ▼
         DSH 本地项目登记目录（占位符）
         ~/.dsh/remote-ssh-workspaces/<token>
                        │
                        ▼
           RemoteSshManager / SSH 路由
             ├── ssh2 + SFTP：文件操作、目录浏览
             ├── 搜索路由：glob / grep
             └── OpenSSH：远程 Shell 命令
                        │
                        ▼
                 远程 Linux 项目目录
```

占位目录是 DSH 项目注册所需的**真实本地文件夹**，不是源码镜像；远程文件不会自动下载到占位目录。不要手动往占位目录里写业务文件。插件的 SSH 工作区记录用于将该本地目录稳定映射回服务器目录。

实现入口：`src/index.ts`（DSH Host 插件）、`src/client-web.js`（设置页和项目选择器）、`src/workspace-registration.ts`（原生工作区登记）、`src/manager.ts`（SSH 连接与工作区映射）、`src/remote-fs.ts`、`src/fs-router.ts`、`src/remote-search.ts` 和 `src/shell-router.ts`（远程工具路由）。

## 限制与安全说明

- 本插件使用**本地 DSH + SSH 路由**，并非在服务器上运行 VS Code Server 或 DSH 完整远程宿主；原生 xterm 已按 SSH 工作区路由到远端 PTY，但远程助手/扩展宿主并未迁移；远程扩展宿主、远程调试器和通用端口转发界面不在当前功能范围内。
- 在远程 Linux 工作区，DSH 可能仍将 Shell 工具显示为 `pwsh`，但命令实际上由服务器上的 **bash** 执行；请使用 POSIX/Linux 命令，而非 PowerShell cmdlet。
- `write` / `edit` 不会自动创建缺失的父目录；需事先明确创建目录。递归 `grep` 默认跳过隐藏条目，显式指定隐藏文件或目录可以搜索。
- SSH 身份有权访问的项目**外部路径也可能被 Agent 访问**（如 `../other.py`）。占位目录不是权限沙盒；如需强隔离，请使用专用远程账户与文件系统权限。
- 仅在受信任环境中授权 Agent 读写远程文件和执行 Shell。服务器指纹改变时先排查原因，不要盲目信任。
- 如同时安装其他占用 DSH 远程源文件夹选择器的插件（例如 `@dsh-ssh/dsh-ssh`），建议只启用一套远程工作区实现，避免路由冲突。

## 开发与自动构建

需要 Node.js 22 和 pnpm 10。克隆仓库后：

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm pack
```

`pnpm test` 包含 TypeScript/客户端构建、单元测试和 SSH/SFTP 模拟集成测试；真实 Windows DSH + 服务器操作仍应进行端到端验收。

工作流位于 [`.github/workflows/build.yml`](.github/workflows/build.yml)：

- **PR / 手动运行**：编译、测试并上传 `.tgz` Actions Artifact。
- **推送到 `main`**：通过全部检查后自动创建 GitHub Releases 的预览版，并附上 `.tgz`。
- **推送 `vX.Y.Z` 标签**：版本检查通过后自动创建正式 GitHub Release，并附上 `.tgz`。

下载入口：[Releases](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases)；构建记录：[Actions](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml)。发布使用 Actions 自动提供的 `GITHUB_TOKEN`，无需配置个人 Token。

更多信息：[架构说明](docs/architecture.md) · [排障文档](docs/troubleshooting.md) · [第三方组件](docs/THIRD_PARTY.md)

## License

[MIT](LICENSE)
