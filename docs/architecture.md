# 架构与安全边界

本文档描述 `main` 分支代码（包含 v1.0.0 之后尚未发布的改进）。正式发布包以对应版本标签为准。

## 组件和职责

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| Host 插件 | `dist/index.js`（源代码 `src/index.ts`） | 管理 SSH 连接，接管远程文件 / Shell 路由，注册工具和 HTTP API |
| Web Client | `lib/client.js`（源代码 `src/client-web.js`） | 在原生 Settings 与新建项目界面注入 SSH 配置、目录选择等 UI |
| SSH 管理器 | `src/manager.ts`、`src/connection.ts` | 解析主机配置、复用连接、执行 Host Key 校验 |
| 文件与搜索路由 | `src/fs-router.ts`、`src/remote-fs.ts`、`src/remote-search.ts` | 根据工作区映射将远程读写与 `glob` / `grep` 转发至 SFTP |
| Shell 路由 | `src/shell-router.ts` | 通过本地 OpenSSH 在远端 Linux 工作目录执行 Bash |
| 模型工具语义及作用域 | `src/tools.ts` | 条件注册远程 `remote_bash` Schema，在可用的 Agent scope 中隐藏本地 `pwsh`，工作区恢复时撤销限制 |
| 可选原生终端 / Git 适配 | `src/native-terminal-router.ts`、`src/native-git-router.ts` | 接入 DSH 已存在的 `subprocess` API；缺少服务时功能降级 |
| 项目登记与清理 | `src/workspace-registration.ts`、`src/workspace-cleanup.ts` | 维护不包含源码的本地占位目录及工作区映射 |

Host 与 Web Client 通过 **DSH Host 同源 HTTP API** `/api/remote-ssh` 通信。浏览器不直接建立 SSH 连接，远端不必运行 DSH CLI/Core 或独立 Web 服务。

## 工作区如何映射

DSH 项目登记流程需要一个本机真实目录，因此插件在 `~/.dsh/remote-ssh-workspaces/` 下创建稳定的空目录。远端 Linux 路径和 SSH 主机 ID 映射为工作区 token，而不是把远端文件下载到本机。

- 在新建项目的目录选择器中，`/workspace/prepare` 验证远程目录，返回本地占位目录供 DSH 正常注册。
- 文件、搜索和 Shell 路由识别已登记的占位路径或虚拟路径，将实际请求交给对应 SSH 主机。
- 原本的本地目录由原生实现处理；远程路由失败时不能偷偷改在本地相似路径执行。
- 会话内主动切换可通过 `/workspace/open` 或 `remote_workspace_open` 进行；需要已存在的 Agent 会话。`/workspace/close` / `remote_workspace_close` 可恢复先前的本地工作目录。
- 远程目录失效时，工作目录保护逻辑在可恢复的情况下通过 DSH 的真实 `workingDirectory.set()` 显式恢复，而非无提示继续操作本地文件。
- 删除占位工作区只会尝试清理经验证的空占位目录，**不删除远端项目文件**。

这是一种工作区路由，不是操作系统级挂载。直接使用 Windows 文件管理器打开占位目录不会显示远端源码。

## 远程执行和原生 UI

- Agent 读取、修改与搜索远端文件：使用已验证 Host Key 的 `ssh2` / SFTP 连接。
- Agent Shell：远程项目优先使用 `remote_bash` 工具，其输入 Schema 描述 Linux Bash 和 POSIX 路径；通过本机 `ssh` 执行远端 `bash -lc`，启用 `StrictHostKeyChecking=yes`、`BatchMode=yes` 并禁用密码交互、Agent 转发等功能。
- 模型工具隔离：使用 DSH `tools.register(definition, { when })` 只向远程会话声明 `remote_bash`；尝试通过 Agent scoped `tools.restrict({deny:['pwsh']})` 屏蔽不合语义的 Windows 工具，目录切回本地即恢复。宿主不支持时降级为双工具可见、系统提示优先 `remote_bash`。旧 `pwsh` SSH 路由默认拒绝，必要时可通过显式且不推荐的 `allowLegacyRemoteShell: true` 开启兼容。
- `remote_bash` 只允许在当前 SSH 工作区内设置 `workdir`，不支持新开后台 job；超时及输出截断字段显式返回。
- 远端 Linux Bash 不受本地 DSH Shell Sandbox 约束；默认向 DSH Approval 请求一次 Agent 会话/工作区级别的远端执行授权，拒绝或无审批服务时失败关闭。DSH `read-only` 会话禁止远端 Bash。授权不跨会话持久化，`remoteBashApproval` 可配置逐命令审批，`'off'` 需自行承担风险。
- 仅经过授权的 `remote_bash` ShellSpec 可以进入 SSH 执行器，旧的 `pwsh` 路由默认被阻止。可通过 `allowLegacyRemoteShell: true` 显式恢复不安全兼容。请注意：这里的批准不是远程沙箱，Bash 命令仍可访问 SSH 账号权限范围内的其它目录。
- 文件系统的 `processPath()` 向原生 read/write 模型输出真实 Linux POSIX 路径；内部 `displayPath`、`targetKey` 和 SFTP 映射保持不变。
- DSH 右侧终端：当宿主提供 `subprocess.spawnTerminal()` 时，按会话归属和工作区映射连接 SSH PTY；普通本地终端仍委托原生实现。
- Git：设置页提供通过 SSH 查询的只读 `git status`、Diff 与近期提交；可选的 `subprocess.spawn()` 适配负责兼容部分原生 Git 入口，是否完整取决于 DSH 宿主接口。
- 插件没有自建第二套终端页面，也不承诺替换 DSH Desktop Core。

## HTTP 权限边界

`src/http-api.ts` 先使用 DSH `connection.requestRejection(req)` 做会话准入，再执行同源检查、修改请求的专用请求头与 JSON 校验。不能仅凭 `webServer.register()` 就假定 API 已经完成认证；缺少 DSH `connection` 授权服务时插件应拒绝加载。

Web API 可以管理 SSH 主机、选择远程路径和切换工作区，因此授权 DSH operator 仍拥有相应的远端操作能力。不要将未经保护的 DSH Host 暴露给不可信访问者。

## 凭据、配置与边界

- 本机私钥在认证时读取或由 ssh-agent 提供；插件的 `hosts.json` 保存的是私钥**路径**，不是密钥正文。
- 插件数据和 Host Key 信任记录存放在 `~/.dsh/remote-ssh/` 下，写入时尽力使用限制性权限（Windows 的 ACL 行为取决于宿主环境）。
- 未知或变化的 SSH Host Key 必须显式核验；不能自动信任。
- `ProxyCommand` 仅接受受限的 `cloudflared access ssh --hostname %h` 格式，不执行任意 shell ProxyCommand。
- 运行时命令和错误信息仍可能包含路径、主机名或上游传入的环境变量。不要把 SSH 连接日志或完整配置文件当作可公开材料。
- 插件并不提供多租户隔离；远程执行能力由运行 DSH Host 的账户权限及远端 SSH 用户权限决定。

第三方依赖与许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。安装和宿主兼容问题见 [troubleshooting.md](troubleshooting.md)。
