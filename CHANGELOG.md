# Changelog

## v1.1.3 — 2026-11-14

### Added / improved
- Combine the SSH shell compatibility fixes from PR #24 with the remote approval, workspace guidance and SFTP search improvements from PR #29/#30.
- In remote Agent sessions, hide host-native `bash` (macOS/Linux) and `pwsh` (Windows) where Agent-scoped tool restrictions are supported; restore local shell tools upon switching back to a local workspace.
- Improve `remote_bash` approval diagnostics: waiting/outcome/duration logs, cancellation handling, late permission safeguards and clear instructions for DSH PTC nested tool calls and remote project roots.
- Speed up explicit recursive `glob` with up to eight concurrent read-only SFTP directory listings and literal-prefix pruning; make basename-only globs shallow. Preserve 20-second and 50,000-entry budgets with consistent error markers.
- Distribute verified installer `.tgz` directly (no wrapping ZIP) with production dependency auditing, ClamAV scanning and download SHA-256 round-trip checks before stable release.
- Keep remote Git and native terminal integration optional according to host capabilities; do not claim full cross-host end-to-end coverage.

### Security and operational notes
- The DSH local sandbox does not constrain an approved command running as the SSH account. Remote Bash keeps its own approval and read-only protections, and a selected project root is not a full remote process sandbox.
- Repo-wide recursive searches may still reach their resource budget. Use narrower `path` or prefixed glob patterns; no unapproved remote shell fallback occurs.
- A new plugin installation or upgrade requires fully restarting the DSH Host. npm publication is conditional on trusted publishing being configured, independent of GitHub Release.
- Jupyter Notebook Viewer (PR #25) is intentionally **not included** in this release.

## v1.1.2 — 2026-11-14

### Fixed
- Quick-import SSH aliases from the Settings page now automatically resolve `~/.ssh/config` parameters on modal open (HostName, username, port, and identity file), without requiring a second dropdown selection.
- A saved SSH host can still be edited without silently overwriting its existing configuration; manually adding a host does not trigger auto-import.
- Quick-import chips exclude aliases already saved under `sshAlias`, rather than only comparing resolved HostName.
- Generic display-name and username placeholders replace project-specific examples.
- Missing identity-file guidance works across macOS/Linux/Windows.
- Add UI regression tests for automatic prefill and manual editing.

## v1.1.1 — 2026-11-13

### Fixed
- Prevent a failed SSH transport handshake from crashing the DSH Web process when ssh2 reports repeated or late error events.
- Improve cleanup and recovery when an SSH connection closes before SFTP initialization; clarify handshake-failure diagnostics.
- Detect browser/host incompatibility using the API compatibility revision rather than requiring identical plugin package versions, avoiding misleading warnings on host-only changes.
- Synchronize the checked-in browser bundle with the package version and make CI reject stale generated browser bundles.

### Verification
- Added automated SSH handshake/disconnect/reconnect tests and browser/host version-compatibility tests.
- Validated build, test, client bundle consistency and installer packaging in GitHub Actions.

## v1.1.0 — 2026-11-12

### Added
- An SSH-aware `remote_bash` tool with Linux Bash/POSIX command schema rather than the Windows `pwsh` schema.
- Conditional Agent tool visibility so local Windows projects continue to use `pwsh` while remote Linux projects use `remote_bash`.
- Remote Bash authorization through the DSH approval service, defaulting to once per Agent session and remote SSH workspace.
- Separate `remoteBashApproval: 'session' | 'command' | 'off'` plugin configuration and explicit `allowLegacyRemoteShell` compatibility option.
- Regression coverage for local/remote tool switching, read-only mode, denied approval, timeouts, truncation, non-zero exits, SFTP create/read/edit/delete, and workspace isolation.

### Fixed
- Agent-facing file read/write results now show Linux POSIX paths instead of Windows-style SSH virtual placeholders (internal SSH mapping remains unchanged).
- Unapproved legacy `pwsh` calls are blocked from entering the remote SSH executor by default.
- Remote shell commands do not silently fall back to local execution when SSH routing fails.

### Security / compatibility notes
- **Behavior change:** Remote shell execution now asks for approval by default; if approval is unavailable or denied, `remote_bash` fails closed.
- DSH `read-only` sessions cannot run `remote_bash` commands.
- The local DSH sandbox does **not** confine a remote Linux Bash process: remote commands execute with the permissions of the SSH account. Avoid privileged SSH accounts.
- Existing v1.0.0 installations are not updated automatically. Download and install `dsh-plugin-remote-ssh-1.1.0.tgz`, then restart the DSH Host. A warning about optional peer dependencies is not by itself an installation failure.
- Remote shell commands remain foreground-only; live Windows Desktop/remote SSH integration should be validated in the target DSH build.

## v1.0.0 — 2026-11-12

Initial stable release of the remote Linux workspace integration:
- SSH/SFTP file operations and search
- Remote Agent shell routing and optional native terminal integration
- SSH host management, verified host keys, and remote Git status
