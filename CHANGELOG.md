# Changelog

## Unreleased — 1.1.2-shellfix.1 test build

### Fixed
- Hide native `bash` (macOS/Linux) and `pwsh` (Windows) from Agents in remote SSH workspaces when DSH supports Agent-scoped tool restrictions.
- Restore native shell tools when returning to a local project; keep other local Agents unaffected.
- Direct remote commands exclusively to `remote_bash`, correcting stale workspace and system prompt instructions.
- Add tests for native tool hiding, Agent lifecycle events, local/remote transitions, and older Hosts without scoped restrictions.
- Keep remote execution approval, read-only protection, and native shell rejection unchanged.

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
