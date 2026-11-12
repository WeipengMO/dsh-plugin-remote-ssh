# Changelog

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
