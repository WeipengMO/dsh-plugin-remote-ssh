# 第三方组件与许可证

## 内置 SSH 运行时

- **ssh2 v1.17.0** — Brian White (mscdex) 及贡献者；MIT License；[上游项目](https://github.com/mscdex/ssh2)。
- 内置代码：`vendor/ssh2/lib/**/*.js`；许可证：`vendor/ssh2/LICENSE`。
- 当前快照保留上游 JavaScript 运行时，**未包含** `lib/protocol/crypto/src/binding.cc` 与 `binding.gyp` 等可选原生编译文件。运行时使用上游的纯 JavaScript 后备路径。

内置依赖不表示插件拥有第三方代码的版权；发布时必须保留相关许可证。维护者应持续跟踪上游 SSH / 密码学组件的安全修复和兼容更新，特别是 `ssh2`、其依赖以及宿主自带的 OpenSSH。

仓库其余依赖版本以 [package.json](../package.json) 和 [pnpm-lock.yaml](../pnpm-lock.yaml) 为准；此处不替代完整的软件成分分析或供应链安全审计。
