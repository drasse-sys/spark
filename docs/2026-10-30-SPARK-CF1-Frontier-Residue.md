# Spark CF1 — Frontier residue on top of LF1

- Base: `lf1-local-first-20261030` @ `4c63598` (LF1 handoff: `docs/2026-10-30-SPARK-LF1-Local-First-Improvement-Batch.md`), baseline `d853149`.
- Branch: `cf1-frontier-residue-20261030`. Not merged, not deployed.
- LF1 repairs were consumed as delivered (diff inspected, 218/218 re-run here). None were redone.

## Decisions implemented

### 1. Imported verification evidence (trust boundary)
A learning copy is parent-supplied data. No file can prove that this device's checker produced its `verified:true` events, so an import is **history, not authority**:

- `L.quarantine(memory, now)` (called by `validateImport`) moves every skill's `ev`/`observations` into `imported` (≤16, kept and shown), and clears `independentAt`, `firstColdAt`, `retainedAt`, `lastAt`, `lastSession`. Credit totals restart at 0.
- Practised skills keep box 1 and are **due at import time**, so the restored child is offered local revalidation straight away. Words keep their text and history, box 1, due now.
- Imported session summaries are flagged `imported:true`: listed in the parent view as "fra kopi, ikke bekreftet på denne enheten" and excluded from the verified-answers chart.
- `state()` never reads `imported` (a skill with only imported history reads `ØVER`). Imported times never anchor delay credit. Mastery comes back only from local verified checks, along the normal path (task → delayed check → second delayed check ≥ 7 days later).
- No keys, signing or identity were added. Device `localStorage` stays the trust root, as before.
- **Deferred:** signed exports, so a restore can keep authority. That needs a key-management decision (where the per-family key lives, how a new phone gets it, rotation/revocation). Recommendation for a later package: an HMAC by the Worker over the export digest with a dedicated `EXPORT_SIGNING_SECRET`, checked on import through an authenticated endpoint. A valid signature restores authority. Unsigned or invalid copies keep today's quarantine path.

### 2. Clock boundary
`L.event(memory, skill, e, now = e.t)` takes an explicit reference time. The learning core still reads no clock.
- A small backwards step (≤ `CLOCK_SKEW` = 1 day) clamps to the last time, as in LF1: the evidence is kept and the event is never "delayed".
- A stored time more than `CLOCK_SKEW` ahead of `now` is not an anchor. The event re-anchors at its own time and earns no credit. One far-future event can no longer pin the skill or push its schedule out.
- If the clock comes back across an earlier jump (the highest retained time becomes plausible again while it is well above the last time), the event gets no delay credit and clamps to that peak. A clock that was far behind and is then corrected therefore cannot manufacture credit.
- Any discontinuity restarts the retention interval (`firstColdAt = null`), observations included.
- `due`/`dueWords` treat a due date more than the longest spacing (60 d) + skew past `now` as due now. This repairs schedules that were already pinned.
- Residual (documented, bounded): a forward clock jump at the moment of the event cannot be told apart from real elapsed time without an external reference. Device time is trusted for live events, as before.

### 3. Gemini chain policy (`chainAdvance`)
| Outcome | Policy |
|---|---|
| 500/502/503/504, overload text (incl. 429 "high demand") | next model |
| retired / not-found model | next model |
| timeout | next model, within the chain budget |
| transient network (`TypeError`, connection lost/reset) | next model |
| empty / non-JSON 200 reply | next model |
| safety-blocked prompt or reply | stop (content-determined) |
| 429 rate / quota (minute or daily) | stop (honour back-off; daily still goes to the backup hook, which stays `none`) |
| other 4xx | stop |
| 401/403 | stop |

The chain is bounded by 6 models **and** a 45 s budget per walk. Each attempt keeps its 20 s cap and no attempt starts with < 5 s left. Worst case with the reconciliation retry is about 90 s, below the app's 150 s timeout.
Client error bodies now carry only Spark text per `kind` (no provider `message`/`details`). Spark-authored guidance (the image/backup case) still passes through. The app's quota detection still works on the controlled texts (tested end to end).
**Deferred:** moving to the next model on a per-model daily quota. That is a quota-budget decision.

### 4. Worker observability
`backend/wrangler.toml` has `[observability.logs] enabled = true, invocation_logs = false, head_sampling_rate = 1`. With this, the only persisted logs are the Worker's own `console.log` line (`chat_provider_failure`: category, status, models tried, backup). Invocation logs (request metadata) and traces stay off. This was checked against the pinned Wrangler 4.152 config schema and `deploy --dry-run`. The current Cloudflare docs could not be fetched from the cloud session. Takes effect on the next Worker deploy.

### 5. General unit-bearing answers — deferred
Only the `money`/`change` skills own a unit (kr), and LF1 handles that. No other generated skill has a unit in its answer key: `length` has no generator, and homework checks are unit-free `[[SJEKK]]` arithmetic. Opening kg/cm/m first needs a product decision: which skill owns each unit, which units and conversions are accepted (e.g. 1 m = 100 cm), and whether a missing or wrong unit is an error. Until then, rejecting units is the deterministic behaviour.

Service-worker cache: `spark-learning-20261030-cf1`.
