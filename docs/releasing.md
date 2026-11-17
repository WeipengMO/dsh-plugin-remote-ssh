# 维护者指南：版本发布与 npm / GitHub Releases

此文档面向维护者。**npm 包 `dsh-plugin-remote-ssh` 已作为正式安装渠道使用**；旧版“首次人工发布 / 尚未开通 npm”的筹备步骤不再属于日常发布流程。用户安装与升级请看 [README](../README.md)。

## 发行渠道与规则

- **npm Registry（面向用户的首选）**：[dsh-plugin-remote-ssh](https://www.npmjs.com/package/dsh-plugin-remote-ssh)，DSH 安装命令为 `dsh plugin --profile desktop add dsh-plugin-remote-ssh`（Web 用 `web`）。
- **GitHub Releases（备用/可复现安装包）**：[Releases](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases)，提供构建后经过检查的同一 `.tgz` 包。
- `.github/workflows/build.yml` 先在 Node 22 / pnpm 10 执行构建与测试、Client bundle 版本一致性检查、生产依赖审计及 ClamAV 包扫描；将验证后的 tarball 上传为 CI artifact，并用于 GitHub Release 和可选的 npm Trusted Publishing。
- npm job 通过 **OIDC Trusted Publishing** 发布，不应把 `NPM_TOKEN` 或 SSH 私钥写入 GitHub Actions/仓库。该 job 取决于 `NPM_PUBLISH_ENABLED=true`（**Repository variable**）、Trusted Publisher 配置及发行资格；GitHub Release 成功不代表 npm 发布一定成功。
- npm 版本是不可变工件；workflow 会检查已存在的 Tag/Release 以及 tarball 摘要，并验证 npm 上公开的版本与 sha1 tarball digest。遇到 npm staged/传播延迟时会等待可见性，不允许不同工件覆盖相同版本。

## 发布新正式版本

1. 从 `main` 创建功能/修复分支，完成代码和测试。需要发布新包时升级 `package.json.version`，同步更新生成的 `lib/client.js`（`pnpm build`）和 `CHANGELOG.md`。
2. 本地检查：
   ```bash
   corepack enable
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm test
   pnpm pack
   ```
3. 通过 PR 让 GitHub Actions 的构建测试通过，再合并到 `main`。发布工作流在主分支检测新版本，创建 `vX.Y.Z` 标签与 GitHub Release，并在满足发布条件时向 npm 提交相同 CI 验证包。
4. 分别检查 GitHub Release 的 `.tgz` 和 npm Registry：
   ```bash
   npm view dsh-plugin-remote-ssh version --registry=https://registry.npmjs.org
   npm view dsh-plugin-remote-ssh@X.Y.Z dist.shasum --registry=https://registry.npmjs.org
   ```
   对照 Actions 日志的 tarball 校验结果，并用干净 DSH profile 安装/升级测试。
5. 检查 README 中固定的版本示例、[CHANGELOG](../CHANGELOG.md) 和 GitHub Release 说明是否需要更新（文档修订本身不需要重新发布包）。

**重要：** 仅更新 README 或 CI 配置但不递增 `package.json.version` 时，旧版本不会自动重新发布到 npm 或生成同名新 Release。不要为了文档更新而重发已存在的 npm 版本。

## Trusted Publisher 与开关（维护/排障）

npm 包所有者在 npm 包 **Settings → Trusted publishing** 中绑定：GitHub 用户 `WeipengMO`、仓库 `dsh-plugin-remote-ssh`、工作流 `build.yml`，按实际流程配置对 `npm publish` 的授权。仓库 **Settings → Secrets and variables → Actions → Variables** 中的 `NPM_PUBLISH_ENABLED` 必须为字符串 `true` 才会运行 npm job；它是 Repository variable，不是 Environment variable 或 secret。

如果 npm job 被跳过，依次检查主分支事件、版本/Tag 是否已有对应发行物、GitHub Release tarball digest 是否符合验证、变量开关和工作流结果。遇到 `ENEEDAUTH` / OIDC 错误，检查包所有权、Trusted Publisher 与 workflow 名称，不要改为提交长期 npm Token。若同版本已上架但 digest 不一致，应停止发布并排查，不要强制覆盖。

当前发布目标为 `v1.2.0`（Notebook Viewer 与 Linux Web 目录选择回退）；之后的正式版本以 `package.json`、[npm](https://www.npmjs.com/package/dsh-plugin-remote-ssh) 和 [Releases](https://github.com/WeipengMO/dsh-plugin-remote-ssh/releases) 为准。

参考：[npm Trusted publishing](https://docs.npmjs.com/trusted-publishers/) · [DSH CLI 插件管理](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)
