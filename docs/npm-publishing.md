# npm Registry + GitHub Releases 双渠道发布

目标：每次创建新的正式版本时，保留 **GitHub Release + CI 检验过的 `.tgz`**，同时将**同一份 `.tgz`** 发布到 npm Registry。这样通过 npm 包名安装的 DSH 插件才具备宿主插件管理器的版本检查/更新条件；原先使用本地 `.tgz` 安装的用户需要自行迁移来源。

## 发布架构

- `.github/workflows/build.yml` 中的 `build`：在 GitHub Actions Node.js 22 上安装依赖、编译、运行测试、验证已提交 `lib/client.js` 的版本、执行 `pnpm pack`，上传经过测试的 `.tgz`。
- `release`：仅在主仓库正式发布新版本时，为 `main` 上的新版本生成 `vX.Y.Z` Tag，创建 GitHub Release，上传同一 CI Artifact。
- `npm_publish`：**在 GitHub Release 成功创建之后**，且仓库 Actions 变量 `NPM_PUBLISH_ENABLED` 恰好为字符串 `true`，才下载相同 CI Artifact，通过 npm OIDC Trusted Publishing 发布为 `latest`。PR、手动运行、Tag 推送、旧版本号重复推送不会发布。
- 发布任务不会调用任意 SSH Host，也不需要 `NPM_TOKEN`。使用 Node.js 24 + npm CLI 11.21.0，并对 tarball 内的包名、版本与 GitHub 源码仓库进行校验；目标 npm 版本已存在则不重复发布。

**注意：变更工作流但不递增 `package.json.version` 时不会重新发布已存在的 `v1.1.2`。** 此机制是有意设计的，防止 GitHub Release 和 npm 同名版本的内容不同。

## 一次性启用：必须由 npm 包所有者完成

### 1. 核实包名及所有权

拟发布的 **npm 包名** 为 `dsh-plugin-remote-ssh`（保持与现有 GitHub Release 中的包名一致）。

在拥有 npm 账号的终端运行：

```bash
npm view dsh-plugin-remote-ssh version --registry=https://registry.npmjs.org
```

- **如果包名未注册**：必须先通过 npm 账号登录并**首次人工发布**，npm 才允许设置 Trusted Publisher。可使用已经由 GitHub CI 验证的 [v1.1.2 Release](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases/tag/v1.1.2) 中的 `dsh-plugin-remote-ssh-1.1.2.tgz`；下载后在所在目录运行：

  ```bash
  npm login --registry=https://registry.npmjs.org
  npm publish ./dsh-plugin-remote-ssh-1.1.2.tgz --access public --tag latest --registry=https://registry.npmjs.org
  ```

  按 npm 提示完成账号登录/2FA。上述首次发布不通过 GitHub Actions；不要将 npm Token 写入仓库或聊天记录。
- **如果该名称已存在且归你所有**：检查当前 npm 最新版本、已发布内容和拥有的权限；切勿重发已被注册的相同版本。
- **如果名称已被其他人占用**：**停止**。应先选择并确认一个有权发布的新包名（例如使用本人实际拥有的 npm scope），同步调整源代码打包、CI 校验和安装文档。不能发布到其他人的包名。

首次发布后核对：

```bash
npm view dsh-plugin-remote-ssh version --registry=https://registry.npmjs.org
```

### 2. 在 npmjs.com 设置 Trusted Publisher

登录 [npmjs.com](https://www.npmjs.com/)，打开自己拥有的 `dsh-plugin-remote-ssh` 包，进入 **Settings → Trusted publishing**，添加 GitHub Actions：

| 字段 | 值 |
|---|---|
| Organization / user | `WeipengMO` |
| Repository | `dsh-plugin-remote-ssh` |
| Workflow filename | `build.yml` |
| Environment name | **留空** |
| Allowed action | **允许 `npm publish`** |

新发布者设置默认可能只允许 `npm stage publish`，本工作流选择直接 `npm publish`，因此**必须显式启用该权限**。GitHub workflow 在 npm 第一次成功 OIDC 发布后即可校验是否配置正确。根据 npm 文档，新建 Trusted Publisher 必须在 **两天内完成第一次成功发布**，否则需要删除已失效配置并重新创建。

建议配置成功后在 npm 包 Settings → Publishing access 设为禁止传统 Token 进行发布，避免长期凭据风险。这不影响 OIDC。

### 3. 启用 GitHub 发布变量

在 **GitHub 仓库 → Settings → Secrets and variables → Actions → Variables** 中添加：

```text
NPM_PUBLISH_ENABLED = true
```

这是 Actions **变量（Variable）**，不是 Secret，不必添加 `NPM_TOKEN`。请在 npm 包已注册、Trusted Publisher 已正确配置，并准备好发布新版本后再启用。

### 4. 验证未来新版本

提交真正的新版本（例如 `1.1.3`，必须同步更新 `lib/client.js` 和 Changelog），待 PR 测试通过后合并 `main`。工作流按顺序：

1. 测试、打包；
2. GitHub Release `v1.1.3` 和 `.tgz`；
3. OIDC 发布同一 `.tgz` 至 npm，检查 `npm view dsh-plugin-remote-ssh@1.1.3 version`。

GitHub Release 与 npm 是两个分离的发布系统。如果 npm OIDC 失败，GitHub Release 仍然可能成功；此时需要排查 npm Trusted Publisher 和 CI 日志。**npm 的版本不可覆盖已发布内容；不要尝试用同号不同包重发。**

## DSH 安装与更新

npm 渠道开通并确认可用后，**新安装**：

```bash
dsh plugin --profile desktop add dsh-plugin-remote-ssh
# 或 Web Host:
dsh plugin --profile web add dsh-plugin-remote-ssh
```

通过 **Registry 来源** 安装的插件，DSH 插件管理器才有条件检查新的兼容版本并显示版本更新操作。原先从 GitHub Release `.tgz` 文件安装的插件不会自动变成 Registry 来源；迁移前建议备份 DSH Profile，确认插件自有主机配置数据仍在 `~/.dsh/remote-ssh`。

如果继续使用本地安装包，仍可从 GitHub Releases 下载新 `.tgz` 并手动升级。不同 DSH 版本的界面及更新操作会有所不同。

## 故障排查

- **工作流 npm job 被跳过**：核对 `NPM_PUBLISH_ENABLED` 是否为 `true`，以及本次 `main` push 是否**首次**发布了新版本。
- **OIDC 权限错误 / ENEEDAUTH**：检查 npm 包所有权、GitHub 名称大小写、`build.yml`、Environment 留空、允许 `npm publish`、是否创建过期的 Trusted Publisher。不要靠提交 Token 解决。
- **npm 包名或版本已存在**：核实 Registry 内容和所有权。不同包内容不能以相同版本覆盖。
- **DSH 没有更新按钮**：检查是否以 npm 包名安装、Host 是否认为该 Bundle 可更新、当前 npm Registry 选择、版本及 DSH Peer 依赖兼容性；只用 `.tgz` 安装不会自动产生 npm Registry 的更新列表。

npm 官方依据：[Trusted publishing](https://docs.npmjs.com/trusted-publishers/)；DSH 官方依据：[UI plugin manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md)。
