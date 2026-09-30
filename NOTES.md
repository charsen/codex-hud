# Notes

## 2026-09-30

- Shared app-server sessions can defer the rollout file until the first message, beyond the ten-second startup discovery window. After releasing the launch lock, keep discovering within that launch's thread-start interval; file creation time alone cannot distinguish a delayed earlier launch from a later launch.

## 2026-09-29

- A new-session rollout can appear more than one second after shared Codex app-server startup. The TUI process's logs may not identify the server-owned thread, so retain the ten-second discovery window with the existing launch snapshot and lock.

## 2026-09-06

- Account quota reads can work in a shell but fail after a cmux HUD pane respawn: GUI panes can inherit a minimal PATH with a Codex forwarding script but without Homebrew. The quota reader must prefer the configured or managed Codex executable and provide the running HUD's Node directory for npm's launcher.
