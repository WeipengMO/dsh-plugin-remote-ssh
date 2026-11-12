# DSH Remote SSH

在 Windows DSH Desktop 中通过 SSH 打开 Linux 上的完整 DSH。每个远程项目使用独立的内嵌界面、连接和会话；本地 DSH 保持独立。无需修改或重新打包 Desktop Core。

## 使用

1. 在 **设置 → Remote SSH** 添加服务器或从 Windows `~/.ssh/config` 导入。首次连接时，通过独立可信渠道核对完整 SHA-256 主机密钥指纹并确认。
2. 在设置页选择服务器，浏览 Linux 目录，点击 **打开远程 DSH**。也可以在新建项目的目录选择器中选择 **SSH 服务器**，再打开所选目录。
3. 插件验证并部署 helper，启动或复用该目录的 Linux DSH Web，并经 SSH 建立本机回环隧道。首次未安装 DSH 时会使用固定版本的官方 CLI，可能需要下载。
4. 远程界面的顶部标签可在已经打开的项目之间切换；**返回本地**保留远程页面，在右下角点击相应项目可再次进入。**重新连接**重新建立该页面的连接，关闭标签不会停止 Linux DSH 进程。

远程界面中的工作区、会话、Agent、Git、worktree、终端和文件监视由对应 Linux DSH 管理。Windows 与 Linux 的会话列表不合并，切换标签不会迁移会话。关闭 Desktop 后，下次需重新从项目目录打开远程界面；Linux DSH 的持久会话由远端保存。

## 前提与安全

- Linux 主机需要 Node.js ≥24.9、Git、可用的 DSH CLI 或访问 npm 的能力；SSH 服务需允许 `direct-tcpip` 转发。
- 远端 DSH 和本地转发均绑定回环地址。首次信任或密钥变更必须认真核验；插件不会自动信任新密钥。
- DSH 的启动 URL 含进程级认证令牌，会经受认证的插件 API 传到 Desktop 渲染进程并加载到隔离的 WebView；不要将 URL 或远端启动日志分享给他人。令牌不是一次性的。插件不将其写入配置或状态接口。
- 旧版本地占位目录与 SSH 文件桥接仍保留以兼容已有工作区，新建项目不再使用它。打开已有旧工作区不会自动迁移到远端 DSH。

## 构建和验证

```sh
pnpm build
pnpm run test:inprocess
node scripts/package-plugin.mjs
dsh plugin --profile desktop add /path/to/dsh-plugin-remote-ssh-2.1.3.tgz
```

完全退出 Desktop 后，用其自带的 `dsh` 插件管理器安装打包脚本输出的绝对路径，再重新打开 Desktop；单纯刷新页面不会重载 Host 的 ESM 模块。插件管理器会更新 profile 的依赖与锁文件，不会替换 Desktop Core。保留安装包，以便以后重新安装依赖。

可用 `DSH_REMOTE_SSH_E2E=1 node scripts/verify-real-ssh.mjs` 对已保存的 SSH 主机运行真实连接、helper、Web 认证与会话恢复检查。脚本默认不运行真实连接；目标没有会话时可能创建一个空测试会话。该脚本不代替 Desktop 界面、Git、worktree、沙箱和文件监视验收。

详细信息：[使用与故障排查](docs/remote-dsh-host.md) · [架构](docs/architecture.md) · [Helper 协议](docs/remote-runtime-protocol.md) · [旧工作区兼容说明](docs/desktop-ssh-runtime.md)。
