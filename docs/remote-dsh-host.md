# 在 Desktop 打开 Linux DSH

在 **设置 → Remote SSH** 添加或导入 SSH 主机，首次连接时独立核对完整指纹。选择主机并浏览项目目录，点击 **打开远程 DSH**；也可从新建项目的 **SSH 服务器** 入口选择目录。Linux 需要 Node.js ≥24.9、Git 和允许 TCP 转发的 SSH 服务。首次没有 DSH 时，插件可通过官方固定版本的 npm 包启动。

每个项目在单独的 WebView 和 Linux DSH 中运行，顶部标签切换项目，**返回本地**隐藏远程页面并保留它，右下角的项目按钮可重新打开。**重新连接**重新建立该页面；关闭标签释放该页面，远端 DSH 不会因此停止。Desktop 重启后重新选择目录即可访问远端保存的会话。不同 Host 的会话列表不会合并。

连接失败时先在设置页测试 SSH，并检查服务器 Node 版本及 `sshd` 的 `AllowTcpForwarding`。若远端 DSH 启动失败，可检查服务器私有 `~/.cache/dsh-remote-ssh/web/` 下的日志；日志和启动 URL 可能包含可复用的进程认证令牌，分享前必须去除。不要将 Linux DSH 的监听端口公开到网络。

插件只在本机与远端回环地址建立隧道。WebView 的 DSH 会话与 Windows 本地 DSH 分开；在 Windows 原有会话的 Git 面板看不到远端状态是预期行为，请在远程 DSH 页面操作。旧占位目录工作区不会自动迁移。

测试与安装命令见 [README](../README.md)。真实 SSH 检查覆盖连接与会话恢复，不能代替实际 Desktop 中的界面和开发功能验收。
