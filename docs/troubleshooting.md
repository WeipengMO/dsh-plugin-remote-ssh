# 测试与排障

## 读取 SSH Config 报 `method not allowed`（v1.0.5 前）

现象：添加主机时选择 `~/.ssh/config` 别名，面板显示 `method not allowed` / 405；`/state` 缺少 `effective` 等字段。

原因：DSH 进程启动时把 host 插件模块加载进 Node ESM 缓存。之后执行 `dsh plugin --profile … add <tgz>` 只会替换磁盘上的文件，**不会重载正在运行进程内的 HTTP handler**。浏览器刷新会从磁盘读到新版 `lib/client.js`（v1.0.4+ 会请求 `GET /api/remote-ssh/config/resolve`），而进程内仍是旧 handler（只有 `GET /state`、`GET /browse`），该 GET 落到 `if (req.method !== 'POST')` 返回 405 `method not allowed`。

判断方法：对比 DSH 进程启动时间与 `~/.dsh/profiles/<profile>/node_modules/dsh-plugin-remote-ssh/` 的文件修改时间；若文件晚于进程启动，就是错配。

解决：**完全退出 DSH 客户端进程（托盘退出，不是关窗口），重新启动，再 `Ctrl+F5` 硬刷新页面**。不需要重新打包或重装 —— 磁盘上已经是新版本。反复重装 + 刷新页面不会解决，因为只更新了前端那一半。

v1.0.5 起：`/state` 会返回 `version`，面板检测到前端/服务端版本不一致会直接给出重启提示；`/config/resolve` 同时接受 GET 和 POST；405 信息会带上 method、route 与重启提示。

## 设置中没有 Remote SSH

检查安装的 profile 是否与当前 DSH 客户端一致（Web 用 `web`，桌面客户端用 `desktop`），完全重启相应客户端。插件包必须同时含 `dist/index.js`、`lib/client.js` 和 `cordis.patch.yml`。不能仅复制 `src` 到 profile。插件依赖宿主 `webServer` 和 `connection`；如果该 profile 没有这些服务，Host 插件会拒绝启动并记录错误。

## 提示没有 Agent 会话

先在对应的 DSH 会话发送一条消息，让 `agent/created` 事件产生有效实例，再在本面板点「刷新」。目前插件无法直接列出 DSH 所有尚未激活的历史会话，不能假装已切换它们。

## SSH 认证失败

检查客户端的 `~/.ssh/config`、`IdentityFile`、ssh-agent 可用性、用户名、服务器公钥认证配置。首次连接先在可信渠道核对 SHA256 Host Key 指纹，再确认面板中的完整指纹。若服务器密钥发生变化，请调查是否发生重建或劫持，不要盲目覆盖记录。

## SFTP 可用但 Agent bash 失败

DSH 的远程 shell 路由使用操作系统 OpenSSH。执行 `ssh -V` 检查是否可用。Windows 请在「可选功能」中安装 OpenSSH Client，确保 `ssh.exe` 在 `PATH`；若安装目录不同，可在 DSH 进程的环境变量中设置 `DSH_SSH_BIN`。

## 本地复现

```bash
npm install
npm test
```

集成测试中 `ssh2` 的内存 SSH/SFTP 服务器不要求外网及真实 SSH 主机；`ssh` 可执行文件不存在时会跳过系统 OpenSSH 实际执行子测试。DSH 宿主运行时、Electron/IPC 与真实远程服务器仍需在用户机器上做最终验收。

## Windows `ERR_PNPM_IGNORED_BUILDS` (v1.0.0)

1.0.0 引入 ssh2/cpu-features 可选原生编译脚本，在 DSH pnpm strictDepBuilds 模式下安装失败。1.0.1 将 ssh2 1.17.0 JS 运行时内置到 `vendor/ssh2` 并移除它的可选原生依赖，避免触发构建脚本。**无需**批准未知安装脚本或修改全局 pnpm 安全设置。使用 `dsh plugin --profile web add .\dsh-plugin-remote-ssh-1.0.3.tgz` 重新安装即可。

## v1.0.7：选好了远程目录却「没加载」/ 无法返回本地

现象：在设置面板浏览并选中远程目录、点「使用此目录」后，DSH 界面仍显示本地工作区；或者切过去之后 `glob`/`grep` 报错、「返回本地」无效。

原因（已核对 DSH 宿主源码与会话事件流）：

1. **会话维度错位**。`/api/remote-ssh/workspace/open` 只改 `sessionId` 指定的那个 Agent 会话的 cwd 投影（`workingDirectory.set()`），不是整个 DSH。下拉里选的是哪个会话就只切哪个；新建/刷新出来的会话由 `header.cwd`（本地工作区）初始化，自然还是本地。插件自己的 `~/.dsh/remote-ssh/workspaces.json` 与 DSH 会话状态无关。
2. **DSH 宿主把 cwd 当作真实 OS 目录，且这部分绕过插件的 `ctx.fs`**。`dsh-tool-fs-search` 把 `workingDirectory.ensure()` 的返回值作为 ripgrep 子进程的 `cwd`；`dsh-workspace` 用原生 `realpath`/`stat` 注册工作区。虚拟 UNC 路径 `\\dsh-ssh\<token>\...` 在本机不是真实目录，于是 `glob`/`grep` 报 `ripgrep provider failure`，GUI 的工作区列表也不会出现远程目录。**这是宿主限制：第三方插件无法让 DSH 把不存在的本地路径当成 Workspace 加载**；能做到的上限是让该会话的 `read`/`write`/`edit`/`glob`/`grep` 走 SFTP。
3. **`set()` 的硬契约**：宿主 `directory(path, cwd)` 一定用 `cwd: 当前虚拟路径` 调 `fs.resolve`。旧版 fs-router 因 `looksVirtual(opts.cwd)` 把本地 `C:\...` 也交给远程解析器并拒绝，导致 `remote_workspace_close`、面板「返回本地」、`working_directory cd` 全部失败，会话卡在远程 cwd。

v1.0.7 修复：

- `fs.resolve`/`fs.lstat`：虚拟路径走 SFTP；**绝对本地路径无论 cwd 是否虚拟都走原 provider**；只有相对路径跟随虚拟 cwd。close/cd/恢复本地恢复可用。
- `guardWorkingDirectory`：远程目录不可用时不再抛错（`ensure()` 在每次系统提示组装时运行，抛错会让会话卡死），改为用真实的 `workingDirectory.set()` 显式恢复会话原始本地目录，并保留 DSH 自己的提示。
- `installRemoteSearchShadow`：改为在共享 `ToolsService.view()` 上就地包装 `glob`/`grep`（与 `ctx.fs` 同一 seam），远程 cwd 时走 SFTP 遍历，本地 cwd 时委托原生工具；定义用 WeakMap 缓存保证工具视图引用稳定。
- `/state` 给会话加 `latest` 标记，`/workspace/open` 在 `sessionId` 省略/`auto` 时默认作用于最近创建的 Agent；面板默认选中它，成功后明确显示切换的是哪个会话，并注明 DSH 工作区列表仍是本地目录。
- `remote_ssh_hosts` 输出过滤 `undefined` 字段，修复 `value is not lossless JSON`。

使用建议：在**目标会话**里发一条消息（让 `agent/created` 产生 Agent），再在面板选该会话点「使用此目录」；看到成功提示后切到该会话使用。若会话列表没有目标会话，先刷新。要退出远程工作区用面板「返回本地」或 `remote_workspace_close`。

升级后必须**完全退出 DSH 客户端并重启**（ESM 缓存不会重载 host 插件），然后硬刷新页面。
