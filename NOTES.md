# Notes

## 2026-09-06

- Symptom: account quota reads work in a shell but fail after a cmux HUD pane respawn. Cause: GUI-spawned panes can inherit a minimal system `PATH` with a cmux Codex forwarding script but without Homebrew; npm's real Codex launcher also requires `node` on PATH. Fix: the quota reader prefers an explicit executable override or the executable recorded in managed installation metadata before PATH lookup, and prepends the running HUD's Node directory to its child PATH. Installation lookup rejects excluded paths and managed shims to avoid recursion.

## 2026-09-05

- Symptom: quota windows can appear after launch and disappear later in the same HUD session or after the HUD renderer restarts. Cause: Codex tracing logs have bounded retention, and an endpoint refresh treated an evicted request/init row as proof that the endpoint became unknown; the last positive evidence existed only in process memory. Fix: retain positive evidence, persist only the normalized per-session origin with private permissions, and replace it only when newer positive log evidence exists. If endpoint evidence is unavailable, a verified local ChatGPT token may trust that session's own rollout limits, while API-key and custom-provider sessions remain conservative. `doctor --json` exposes the trust decision, source, observation time, schema compatibility, and hidden reason.
