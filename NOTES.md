# Notes

## 2026-09-05

- Symptom: quota windows can appear after launch and disappear later in the same HUD session. Cause: Codex tracing logs have bounded retention, and an endpoint refresh treated an evicted request/init row as proof that the endpoint became unknown. Fix: retain the last confirmed endpoint when a refresh has no newer positive evidence; still replace it when a newer endpoint is observed.
