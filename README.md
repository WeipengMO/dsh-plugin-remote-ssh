# DSH Remote SSH

[![Build](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml/badge.svg)](https://github.com/WeipengMO/dsh-plugin-remote-ssh/actions/workflows/build.yml)

在 Windows [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中管理 Linux SSH 主机。**v1.4 开始推荐「远端 DSH Host」模式**：在 Linux 上运行完整 DSH Web，让 Git、Agent、Shell 和文件系统都运行在服务器；Windows DSH Desktop 负责管理 SSH 连接及建立访问通道。旧 SSH 工作区 / SFTP / 原生终端功能保留为兼容模式。

## 两种工作方式

| | 远端 DSH Host（推荐） | SSH 工作区（兼容） |
|---|---|---|
| Agent 执行 | Linux DSH Host 原生执行 | Windows DSH 的 Agent 通过 SSH 发送命令 |
| Git / Forge | 远端 DSH 直接读取真实 Linux checkout | Windows 占位目录 + 只读 Git 查询桥接，兼容性有限 |
| 文件与终端 | 远端 DSH 原生文件工具和终端 | SFTP、Shell、SSH PTY 转发 |
| 界面 | Windows 浏览器中的独立 Linux DSH Web | Windows DSH Desktop 本身 |
| 会话/模型配置 | 独立的 Linux DSH 实例 | 原 Windows DSH 实例 |

> **重点：**「远端 DSH Host」不是把现有 Windows Agent/Session 切换到另一台电脑，而是打开一个独立的 Linux DSH Web 实例。未连接前不要期待原 Windows DSH 的右侧 Git 面板能够显示服务器 Git 状态。

## 安装插件

在 [GitHub Releases](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases) 下载带 \`dsh-plugin-remote-ssh-X.Y.Z.tgz\` 的构建包，完全退出 DSH Desktop（含托盘）后在 Windows PowerShell 运行：

\`\`\`powershell
dsh plugin --profile desktop add "C:\path\to\dsh-plugin-remote-ssh-X.Y.Z.tgz"
\`\`\`

重启 DSH Desktop。Web Profile 需使用 \`--profile web\` 分别安装；两个 profile 不共享插件或会话状态。

## 快速开始：远端 DSH Host

1. 在 **设置 → Remote SSH** 导入 \`~/.ssh/config\` 或添加主机，**独立核对** SSH Host Key SHA256 指纹并确认。
2. 选中主机 → **远端 DSH** → **检查环境**。远端 Linux 推荐 Node.js ≥24.9、Git。原生 PR 功能需 \`gh\`。
3. 在独立 SSH 终端运行：
   \`\`\`bash
   npx -y @deepseek-ai/dsh --profile web --no-open --port 3080
   \`\`\`
   终端会打印含访问令牌的 \`dsh web:\` URL；令牌不应分享到任何聊天、Git 或公开日志。
4. 插件页面点击 **建立本机隧道**。此按钮只在 Windows DSH Desktop 同机浏览器模式可用，通道仅监听本机 \`127.0.0.1\`。远端 DSH 必须已启动并允许 SSH TCP forwarding。
5. 粘贴远端 DSH 启动时打印的完整 URL，点击 **在浏览器打开远端 DSH**。在新页面中打开真实 Linux 项目并在 Official 插件中启用 **Change requests & worktrees**。

[完整部署指南、手动 SSH 转发、安全边界与故障排查](docs/remote-dsh-host.md)

## 保留的 SSH 工作区兼容功能

**文件浏览（兼容）**：浏览远端文件并将目录登记为 Windows DSH 的工作区。Agent 文件工具/Shell、原生终端在现有实现中通过 SSH 路由；远程 Git 查询有只读桥接，但 Windows 占位路径与 Linux 真实 Git 路径跨系统映射不保证完整的 Forge 功能。可用来编辑文件、运行命令，不建议用它承载复杂 Git worktrees。

**快速命令**：在选定 Linux 目录执行一次性命令；不等同于远端 DSH Web 的完整 Agent。SSH 主机支持严格指纹校验、密钥/ssh-agent、SSH Config 和受限 ProxyCommand；最近目录历史可以单独清理，不会删除远程文件。

## 安全和限制

- Windows Desktop 托管的 DSH Web TCP 隧道**仅绑定 127.0.0.1 的随机端口**；不会公开监听、不会自动启动 DSH、不会持久化 Web token。浏览器 URL token 只在 UI 内存中转换。
- 本地隧道关闭或插件退出不会结束远端 DSH。远端 DSH Web 保持 loopback 监听，并应使用 SSH 转发而不是开放公网端口。
- 对于非同机浏览器（DSH Web/WSL 等），必须在浏览器所在的机器建立手动 \`ssh -L\` 转发；插件不会错把 Host 的 loopback 当作浏览器的 loopback。
- Windows 与 Linux 的 DSH Host 之间**不共享**模型配置、会话、插件和 Agent 状态。
- 推荐的 Linux Web 路线不依赖旧占位目录，但并未移除老功能；不应把占位目录内的空内容当作远端真实源码。

## 开发

\`\`\`bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm pack
\`\`\`

发布包必须包含最新 \`dist/\`、\`lib/client.js\` 和 \`cordis.patch.yml\`。GitHub Actions 构建并运行测试，main 提交成功后发布开发预览包。

- [远端 DSH Host 详细指南](docs/remote-dsh-host.md)
- [架构](docs/architecture.md)
- [排障](docs/troubleshooting.md)
- [许可证](LICENSE)
