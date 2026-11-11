# DSH Remote SSH — Windows Desktop 原生 SSH 工作区

[![Build](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml/badge.svg)](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml)

## 目标

**在 Windows DSH Desktop 的现有项目列表里打开 Linux 服务器上的源代码目录。** 不需要另外打开浏览器，也不需要在服务器安装第二套 DSH、手动创建 SSH 隧道或复制代码。

### 当前已经支持

- **DSH 原生工作区选择器**：新建项目 / 添加工作区 → 源文件夹 → SSH 服务器 → 远端目录 → 在 Desktop 打开工作区。
- **自动发现 SSH 主机**：下拉菜单合并已保存主机及 Windows `~/.ssh/config` 的 Host 别名；选中一个已存在的 Host 别名时自动登记，不需逐项输入 IP、用户、端口或密钥路径。
- **最少必要验证**：已信任的主机不再提示；未知 SSH Host Key 时在同一项目选择器中要求从独立渠道核对完整 SHA256 指纹，不会悄悄信任未知主机。
- **远程文件/Agent/终端**：Agent 的文件工具、Shell 以及右侧原生终端沿现有桥接在服务器执行；本地项目保持 Windows/WSL 行为。
- **SSH Config、历史目录和断线重连能力**：复用现有连接配置与工作区登记。

### 仍有限制：尚未达到完整 Codex SSH 运行时

这是通过插件对 DSH Desktop 本地 Host 的文件和进程接口进行桥接，**仍需要一个 Windows 本地工作区占位目录**。它不是完整的 Linux 远端 Extension Host。DSH Forge 的原生 Git/变更请求、worktree、沙箱、LSP、文件监听等并未全部完成跨平台适配。远端 Git 本身可在 Agent Shell / SSH 终端使用；原生 Git 面板可能仍显示错误。

**不能把 Git 面板标为已修复，也不能因为工作区可添加就说已经实现了 Codex SSH 全部能力。** 具体差距和后续架构方案见 [Desktop 原生 SSH 运行时设计](docs/desktop-ssh-runtime.md)。

## 安装

从 [Releases](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases) 下载安装包，完整退出 DSH Desktop（含托盘）后在 Windows PowerShell 中安装：

```powershell
dsh plugin --profile desktop add "C:\path\to\dsh-plugin-remote-ssh-1.4.1.tgz"
```

完整重启 DSH Desktop。只刷新页面不能重载已在 Node ESM 缓存中的 Host 模块。

## 使用

1. Windows 电脑已有一个可以通过 SSH 公钥连接的主机，如 `ssh nansha`，主机信息可写在 `~/.ssh/config`。不需要提前在插件中手工填写这些字段。
2. DSH Desktop → **新建项目 / 添加工作区 → 源文件夹 → SSH 服务器**。自动出现 `~/.ssh/config` 中的别名和已经登记的 SSH 主机。如果只有一台主机，选择器会直接尝试读取其 Home。
3. 首次连接时，从服务器控制台或管理员处独立核对并输入 SHA256 Host Key 指纹；已有信任记录则跳过。
4. 选择远端文件夹，点击 **在 Desktop 打开工作区**，然后在左侧工作区中打开会话。

核对远端 Git：

```bash
pwd
git rev-parse --show-toplevel
git status --short --branch
```

如果这些命令成功而 DSH「变更请求」面板仍报错，属于 DSH 原生 Git 与插件桥接的兼容性问题，并非服务器没有 Git。

## 其他工作方式

v1.4.0 增加的 **Web（可选）** 功能仍保留，但不再是默认或推荐的 SSH 工作区流程。它会打开另一套 DSH，**不是**用户希望的 Desktop 工作区。

## 开发与安全

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm pack
```

发布包必须含新编译的 `dist/`、`lib/client.js`、`cordis.patch.yml`。SSH Host Key 验证不会因为一键操作而被关闭。

- [Desktop SSH 运行时设计与限制](docs/desktop-ssh-runtime.md)
- [插件架构](docs/architecture.md)
- [故障排查](docs/troubleshooting.md)
