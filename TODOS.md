# TODOs

- [x] Discover delayed managed app-server rollouts through descendant processes, with concurrent-thread isolation and bounded process inspection.

- [x] Repair the current stale session binding and make running renderers follow explicit binding updates without borrowing concurrent threads.
- [x] Recognize successful WebSocket endpoint observations and restore this session's trusted ChatGPT quota display.

- [x] Stop quota polling from creating marketplace upgrade copies and refresh running HUD renderers.

- [x] Apply and verify the explicit resume-ID binding fix in the managed runtime.

- [x] Discover first-message rollouts beyond the startup window without blocking or borrowing subsequent launches.

- [x] Restore the rollout discovery window for delayed shared app-server startup in Warp and verify existing-session exclusion and child cleanup.

- [x] Refresh ChatGPT account quota independently of rollout activity; verify shared polling, failure freshness, account isolation, and monotonic observations.

- [x] Make quota windows stable and persist trusted per-session endpoint evidence across HUD processes.
- [x] Add usage provenance, trust, freshness, and hidden-reason diagnostics to `doctor`.
- [x] Align Full/Essential presets, setup prompts, and English/Chinese documentation with actual defaults.
- [x] Replace authoritative-looking prompt-cache TTL and fixed context claims with explicit estimates/provenance.
- [x] Harden relay credential transport and redact sensitive live tool targets.
- [x] Add Codex-version compatibility fixtures, schema probes, and macOS/cmux CI coverage.
- [x] Reduce idle polling and cold/resume transcript parsing overhead.
- [x] Complete Simplified Chinese UI strings and add HUD/runtime/plugin version integrity diagnostics.
- [x] Remove flaky wall-clock test gates, add coverage reporting, and run the complete verification matrix.
