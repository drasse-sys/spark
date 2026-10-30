# Spark LF1 — Local-first improvement batch (handoff)

- Baseline: `d853149` (origin/main, Learning Evolution production record)
- Branch: `lf1-local-first-20261030` (pushed, **not merged, not deployed**)
- Last code commit: `09e0d41`; the handoff commit that adds this file is the branch HEAD.
- Tests: 206 → **218/218** (`cd tests && node --test *.test.mjs`). Worker `wrangler deploy --dry-run`: OK (54.13 KiB). Real Chromium: `browser-check.mjs` PASS (390×844), `browser-learning-check.mjs` PASS (320/390/768). No secrets in the diff (pattern scan clean).

## Backlog closed (each has a regression test that fails with the fix disabled)

| Item | Change |
|---|---|
| STEG answer disclosure | `teachingSteps(text,checks)` drops a `fakta` step (JSON or legacy prose) whose expression has the same exact value as any supported SJEKK expression. Smaller sub-facts remain. Existing test that pinned the old behaviour was flipped. |
| Duplicate/contradictory SJEKK | `SparkArithmetic.inspect` collapses identical duplicates (expression-normalised, same answer text and verdict), flags same-expression markers with a different answer/verdict as `repair` (→ existing one-retry reconciliation, then neutral fallback). Returns `raw` marker count; `inspectReply` compares against it. |
| Backwards clock | `L.event` clamps `t` to the skill's last-seen time instead of discarding the evidence. A clamped event can never be `delayed`, so it cannot create delayed-check credit or promote mastery. |
| Unopened-child cleanup | `sweepSessions()` at startup runs `loadSession(i)` for every child, so abandoned (≥30 d) sessions of never-opened children expire and keep their aggregates. |
| Legacy recovery edge | “Gjenopprett” now stamps recovered sessions (list and stored session blob) with `migratedAt`, validates and caps `log` at 20, and prunes — recovered transcripts previously had no timestamp and never expired. |
| Generator variety | `double`/`half` now cover 1–20 (were 9 items). New `L.round(id,seed,n)` returns distinct-key items; default practice uses it for `times2510`. |
| `due:null` words | New `L.dueWords`; null/missing `due` is **not** due (was `null<=now` → true). Both call sites use it. |
| Unit-bearing numeric answers | Narrow: local `money`/`change` items accept a trailing `kr`/`kroner` (value-only check). All other units remain rejected; shared parser unchanged. |
| Provider observability | Worker logs one JSON line per non-recovered provider failure: `{evt,kind,reason,status,tried[],backup,t}` and adds `reason` to the error body. `reason` ∈ `timeout, network, empty, http_<status>, other`. No prompt/text/image/session content, keys or tokens (asserted in a test). |

Also: service-worker cache renamed `spark-learning-20261030-lf1` so clients refetch the changed client files.

## Intentionally deferred (frontier/cloud residue)

1. **Imported verification claims.** `validateImport` trusts `verified:true` events from a parent-supplied learning copy. Any fix (demote imports to observations, or sign exports) trades off against legitimately restoring a child's own history on a new phone, and signing needs a key-management decision. Not changed.
2. **General unit-bearing answers** (kg, cm, m, …): needs a product/semantic decision on unit equivalence; only the money case above was done.
3. **Forward clock jump.** The clamp makes one far-future timestamp pin `lastAt` into the future (later events clamp to it; `due` is pushed out). `L` is clock-free by design; a bound needs `now` passed in from the UI layer.
4. **Gemini chain semantics.** `callGemini` advances to the next model only on retired/overloaded; a timeout, network error, empty reply or non-retired 4xx aborts the chain at the first model and surfaces as `provider_error` → “AI-tjenesten er midlertidig utilgjengelig”. This is the likeliest source of the extended outage that recovered without a deploy. The new log line will show it; whether to advance the chain on timeout/empty (extra latency, extra quota) is a provider-policy call.
5. **Backup provider** is still `BACKUP_PROVIDER=none`; not touched. Activating one needs secrets and a privacy decision.
6. **Cloudflare observability.** The log line is visible via `wrangler tail`; persisting it needs `[observability] enabled = true` in `backend/wrangler.toml` (a Cloudflare config change — not made).
7. Production deploy of this branch (Worker first, then Pages) is not done.

## Notes

- Files changed: `arithmetic.js`, `backend/src/index.js`, `learning.js`, `learning-ui.js`, `spark.html`, `sw.js`, `tests/{consolidated-repair,learning,worker}.test.mjs`, `tests/helpers.mjs` (captures `console.log` in the Worker harness), this document.
- Browser checks here need `SPARK_TEST_MODULE_ROOT` (Playwright install) and `SPARK_CHROMIUM_EXECUTABLE` (cached Chromium 1223) because the installed Playwright expects a different build.
