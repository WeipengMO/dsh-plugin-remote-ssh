# 远端 DSH Host：Linux 原生开发（推荐）

## 设计目标与边界

本方案不再使用 Windows 本地占位目录伪装 Linux Git checkout。**完整的 DSH Host 在 Linux 服务器上运行**，它拥有真正的项目文件、Git、Shell、Agent、会话与模型配置；Windows 上原来的 DSH Desktop 只提供 SSH 主机管理、环回隧道和浏览器入口。两个 DSH Host 的会话与配置**不会自动同步**。

本插件的「远端 DSH」标签提供：SSH 环境检测、启动命令指引、Desktop-only 本地环回访问隧道、一次性的访问 URL 输入及浏览器跳转。插件**不负责远端 DSH 安装、更新或启动**，不会持久化、转发或打印 Web 访问令牌，也不假装把 Desktop 当前 Agent 迁移到 Linux。旧版「文件浏览（兼容）」仍可使用，但原生 Git、Forge worktree 等跨系统接口不保证兼容。

## 条件

- 本地 Windows 安装 DSH Desktop 和本插件；SSH 主机已经配置并经过**独立确认的 Host Key 指纹**验证。
- 远端为 Linux，Node.js **≥24.9.0**；Git 已安装。查看/操作 GitHub PR 建议安装并登录 \`gh\`。
- 远端 SSH 服务器允许 \`direct-tcpip\` / \`AllowTcpForwarding\`，并允许从 SSH 服务器连接它自己的 \`127.0.0.1:3080\`。
- 如果 DSH Web 进程没有启动，插件不会绕过认证而自动启动一个守护进程。必须在远端独立 SSH 终端运行。

## 首次部署

1. 在 Windows DSH → 设置 → Remote SSH → 选择已经验证过的服务器 → **远端 DSH**，点击 **检查环境**。检查输出中的 Node、Git 和 \`dsh\`；\`command -v dsh\` 为空并不等于 npx 无法使用。
2. 在 Linux SSH 终端执行：
   \`\`\`bash
   node -v
   npx -y @deepseek-ai/dsh --profile web --no-open --port 3080
   \`\`\`
   \`npx\` 可能需要下载包，首次启动前应核对官方源及版本。也可先按官方指南安装，再用 \`dsh --profile web --no-open --port 3080\`。
3. 保持远端进程运行。终端将打印 \`dsh web:\` 及**携带启动令牌**的访问 URL，**不要公开、提交到 Git 或发在聊天中**。
4. Windows DSH Desktop 的「远端 DSH」标签点击 **建立本机隧道**。插件使用已经验证的 SSH 连接访问远端的 \`127.0.0.1:3080\`，本机仅绑定 \`127.0.0.1\` 的**随机可用端口**。请求携带 SSH 的数据通道加密，没有额外公网监听端口。
5. 将 Linux 终端打印的完整启动 URL 粘贴到页面的密码输入框，点击 **在浏览器打开远端 DSH**。插件只在浏览器端把原 URL 的本地地址和端口换成本机隧道地址，原路径、查询参数、片段不变。令牌**不经** \`/api/remote-ssh\` 传输或落盘。
6. 在新打开的远端 DSH Web 中直接选择真实的 Linux Git 项目目录。按需要在 **Plugins → Official → Change requests & worktrees** 中启用 Git 面板；此插件不会跨 DSH Host 同步插件设置。GitHub PR 检测需要远端 \`gh auth login\`。

## DSH Web Profile / 非同机浏览器

如果本插件运行在 Web Profile（例如 DSH Host 在 WSL/另一台服务器上），**不启用托管本机隧道**：\`127.0.0.1\` 属于 DSH Host，不一定是浏览器所在的电脑。此时需在**实际使用的 Windows 电脑**执行：

\`\`\`powershell
ssh -N -L 13080:127.0.0.1:3080 <服务器SSH别名>
\`\`\`

然后将远端启动 URL 的 \`127.0.0.1:3080\` 改为 \`127.0.0.1:13080\` 并保留令牌。手动隧道不由插件管理，也不会出现在插件隧道状态列表中。

## 状态、断开与安全

- 点击「关闭通道」会关闭本地 TCP listener 与活动连接，**不会结束 Linux DSH**。关闭 Windows DSH 或卸载插件时也会清理托管隧道。
- 只允许远端端口 1024–65535；绑定 \`127.0.0.1\`，不使用 \`0.0.0.0\`、公网 URL 或代理到其他主机。用户可以有多个已验证 SSH 主机，每个主机最多一个托管通道。
- Web 访问 URL 是 bearer credential：只粘贴官方在远端 SSH 终端打印的 \`http://127.0.0.1:<port>/...\`。客户端会拒绝外部域名、HTTPS、包含用户名或不匹配端口的 URL，以防止把令牌发送到非预期主机。
- 远端 DSH 应保持 loopback 监听，不应为了远程访问而直接暴露 Web 端口到公网。
- 若服务器要求保留长期会话，使用 \`tmux\` 或受控 systemd 用户服务启动 Linux DSH；**不要**把启动令牌写入不受保护的日志。
- 插件中旧版 SSH 占位目录的内容不是同步的源文件；迁移时重新打开**服务器上的真实目录**，不要复制本机占位目录充当源码。
- DSH Web 会话、插件、模型、账号和文件历史与 Windows Desktop DSH 是**两个实例**，不会自动迁移；请按照 DSH 官方方式逐项配置。

## 常见问题

**建立隧道提示失败：** 检查 \`dsh --profile web\` 是否仍在运行、端口是否一致，以及远端 SSHD 的 \`AllowTcpForwarding\`。服务端不允许 \`direct-tcpip\` 时，需要管理员调整策略；不要关闭主机密钥验证。

**浏览器访问出现未授权：** 必须使用完整的带令牌 URL，不能只访问 \`http://127.0.0.1:<本地端口>/\`。在 Linux 终端核对启动输出。不要将令牌发给第三方。

**仍然看到「无法读取 Git 信息」：** 核对你是不是仍在 **Windows DSH 的旧版 SSH 工作区会话**。需要在新打开的 **Linux DSH Web** 中打开真实的 Linux Git checkout，并确认已启用 Forge 插件。

**Git 能读但 PR 不显示：** 检查远端的 \`gh auth status\` 和当前分支的 upstream；官方 Forge 组件依赖 Linux Host 的 Git/gh 环境。

**浏览器在另一台设备：** 此插件 Desktop 托管的 loopback 端口只供本机使用。请使用该设备自己的 SSH 本地转发，不应将其暴露到 LAN。

## 官方架构参考

- [DSH Web 文档](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/web-app)
- [官方 Forge（变更请求和 worktrees）](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/forge-bundle)
- [官方 POSIX SSH Provider（另一种 headless 组合方式）](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/ssh/ssh)
