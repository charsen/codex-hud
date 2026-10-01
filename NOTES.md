# Notes

## 2026-09-30

- Quota polling can accumulate marketplace upgrade copies when a plugin-enabled app-server is terminated after reading quota. Disable plugins for the quota reader only, close stdin normally, and terminate its process group on timeout to include npm descendants.
- Shared app-server rollouts may not appear until the first message, beyond the startup window. Continue discovery using a bounded thread-start window; bind explicitly requested resume UUIDs directly rather than inferring them from file updates.

## 2026-09-29

- A new-session rollout can appear more than one second after shared Codex app-server startup. The TUI process's logs may not identify the server-owned thread, so retain the ten-second discovery window with the existing launch snapshot and lock.

## 2026-09-06

- Account quota reads can work in a shell but fail after a cmux HUD pane respawn: GUI panes can inherit a minimal PATH with a Codex forwarding script but without Homebrew. The quota reader must prefer the configured or managed Codex executable and provide the running HUD's Node directory for npm's launcher.
