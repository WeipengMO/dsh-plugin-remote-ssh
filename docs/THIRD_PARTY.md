# Vendored third-party runtime

- **ssh2 v1.17.0**, by Brian White (mscdex) and contributors, **MIT License**. Upstream: https://github.com/mscdex/ssh2
- Files: `vendor/ssh2/lib/**/*.js`; license: `vendor/ssh2/LICENSE`.
- Change: excludes `lib/protocol/crypto/src/binding.cc` and `binding.gyp` from the distribution; JavaScript sources remain unchanged. The upstream JS implementation already detects absence of native binding and CPU feature module and falls back.
- Review/update this snapshot when upstream ssh2 publishes security or interoperability fixes.
