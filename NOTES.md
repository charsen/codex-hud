# Notes

## 2026-10-09

- Symptom: a HUD remains unbound when the first message creates a rollout minutes after launch. Cause: the managed app-server writes logs below the npm wrapper and native Codex process, while process lookup inspected only direct children. Fix: inspect a single bounded PID/PPID snapshot and follow descendants; reject ambiguous root threads instead of selecting one from a shared server. The startup time window remains bounded to avoid borrowing neighboring launches.

## 2026-10-03

- Symptom: a long-running HUD displays an older conversation after the active root thread changes. Cause: the renderer reads its binding only before the first rollout is attached; shared app-server threads cannot be attributed to the TUI by process logs. Fix: reread explicit binding updates during rendering and use `bind` with the confirmed root ID, preserving the Codex process and refusing foreign-project/subagent targets.

- Symptom: a confirmed ChatGPT session loses quota display after moving to WebSocket transport. Cause: endpoint discovery only recognizes HTTP client request logs. Fix: accept successful connections from `codex_api::endpoint::responses_websocket`, normalize their transport URL to its HTTP counterpart, and order them alongside HTTP observations for the same thread; connection attempts and relay origins do not grant subscription trust.

## 2026-09-30

- Symptom: minute-by-minute quota reads accumulate marketplace upgrade copies in Codex temporary storage. Cause: the quota reader starts app-server with plugin loading enabled and immediately SIGKILLs its launcher after a response. Fix: disable local and remote plugins for that reader only, close stdin normally, and bound shutdown with process-group termination so npm descendants are included.

- Symptom: an explicit resume command leaves the HUD showing only project and elapsed time after the first reply. Cause: UUID arguments were ignored and shared-server resumes were inferred from rollout updates within ten seconds. Fix: resolve the requested root UUID directly, preserving process cleanup and excluding other sessions.

- Symptom: the Warp HUD remains without session data when the first message is sent more than ten seconds after launch. Cause: the shared app-server defers the rollout file until that message, and TUI process logs cannot identify the server-owned thread. Fix: release the startup discovery lock after ten seconds and keep discovering only threads started within that launch window; thread timestamps prevent borrowing delayed earlier or later launches.

## 2026-09-29

- Symptom: a Warp tmux HUD shows only the project and elapsed time after Codex starts. Cause: new-session discovery stopped after one second, before Codex's shared app-server created the rollout; the TUI process's logs did not identify the server-owned thread. Fix: allow the existing ten-second discovery window for new sessions as well as resumes, retaining the launch snapshot and discovery lock. An already-running affected HUD can recover by binding its confirmed rollout without restarting Codex.

## 2026-09-06

- Symptom: account quota reads work in a shell but fail after a cmux HUD pane respawn. Cause: GUI-spawned panes can inherit a minimal system `PATH` with a cmux Codex forwarding script but without Homebrew; npm's real Codex launcher also requires `node` on PATH. Fix: the quota reader prefers an explicit executable override or the executable recorded in managed installation metadata before PATH lookup, and prepends the running HUD's Node directory to its child PATH. Installation lookup rejects excluded paths and managed shims to avoid recursion.

## 2026-09-05

- Symptom: quota windows can appear after launch and disappear later in the same HUD session or after the HUD renderer restarts. Cause: Codex tracing logs have bounded retention, and an endpoint refresh treated an evicted request/init row as proof that the endpoint became unknown; the last positive evidence existed only in process memory. Fix: retain positive evidence, persist only the normalized per-session origin with private permissions, and replace it only when newer positive log evidence exists. If endpoint evidence is unavailable, a verified local ChatGPT token may trust that session's own rollout limits, while API-key and custom-provider sessions remain conservative. `doctor --json` exposes the trust decision, source, observation time, schema compatibility, and hidden reason.
