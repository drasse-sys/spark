# Spark INT1 — RH1 + UX1 + TR1 integration handoff (2026-11-03)

Status: all three packages are merged into `main` and CI-green. **Nothing is deployed.** `EXPORT_SIGNING_SECRET` does not exist yet.

## SHAs
| Item | SHA |
|---|---|
| Starting main (CF1) | `3120ff3219e23028074715eb384e71301a32a391` |
| RH1 (PR #3) head → merge | `f867935…` → `5ca20853dcadf45c45a35fe8f3ddfa86da9b064f` |
| UX1 (PR #4) original head → integrated head → merge | `b372954…` → `b30d93d23fbab873723317af61c5b0f66456eadf` → `19d9b91fa3e63f77e26d0e88dda2a34859a129df` |
| TR1 (PR #5) original head → integrated head → merge | `1256398…` → `21e504c5c8ba66df2228d122f59769e45ecd29b6` → `7b6c86d51c61cf7e159318360d25c0e92170c6eb` |
| Final code main | `7b6c86d51c61cf7e159318360d25c0e92170c6eb` (this document is added by a docs-only PR after it) |

All merges are normal merge commits, history preserved, no force-push.

## Conflicts and resolutions
- PR #3 and PR #4: **none** (UX1 merged with RH1 cleanly; RH1 never touched `sw.js`).
- PR #5 (`origin/main` into TR1):
  - `.github/workflows/ci.yml`: kept both added steps, TR1 "Browser trusted backup/restore check" then UX1 "Browser mobile touch check"; RH1 SHA pins untouched. Result: 11 steps, the union of both parents.
  - `sw.js`: one new id `spark-learning-20261103-int1` (predecessors: `…20261030-cf1` main, `…20261102-ux1`, `…20261102-tr1`).
  - `backend/src/index.js`, `spark.html`, `learning-ui.js`, tests, package files: auto-merged. `backend/src/index.js` differs from the TR1 head only by the RH1 `GENERATION` lines. Package files are identical to main (no new or duplicate dependencies).

## Results
- Node suite: **295 / 295** pass (UX1-integrated intermediate: 267 / 267). TR1 file: 28 tests.
- Syntax, manifest parse, `wrangler deploy --dry-run` (60.89 KiB), `git diff --check`, secret scan: clean.
- Browsers (Chromium): `browser-check`, `browser-learning-check`, `browser-mobile-touch-check`, `browser-trusted-restore-check`: all PASS, no page errors.
- Negative controls:
  - TR1: 8 automated controls in `tests/tr1-trusted-backup.test.mjs` pass on the merged source (MAC compare, domain separation, device auth, local digest compare, strict reply check, settings-chosen verifier / fake server, verification result ignored, normalization and invariants). A missing patch target fails the control, so none is vacuous.
  - UX1: re-run by hand on the integrated tree. Reverting the busy-disabled JS fails "Jeg vet ikke: must be disabled while a reply is pending". Removing only `.qb:disabled` CSS fails "4. Vis et eksempel: disabled control is not dimmed (opacity 1)". Tree restored afterwards.
- Fresh narrow security review of `21e504c` (integration risk only): 7/7 PASS, **no blockers**. Nits: (a) `GENERATION` still reads `rh1-20261031` though the Worker now includes `/backup/*`; (b) `RELEASE-CHECKLIST.md` step 1 says "both browser checks" but CI runs four.

## Final identities
- Service-worker cache: `spark-learning-20261103-int1`
- Worker `GENERATION`: `rh1-20261031` (unchanged, never deployed; the live Worker still reports `c3r1-20261022`). Bump it at release if you want the label to say TR1 (checklist step 2); `live-check.mjs` reads it from source.

## GitHub runs
| Run | What | Result |
|---|---|---|
| 41194158491 / 41536435167 / 41542059541 | original PR #3 / #4 / #5 heads | success |
| 41630754823, pages 41630753993 | main after RH1 (`5ca2085`) | success |
| 41630923973 | PR #4 integrated head `b30d93d` | success |
| 41631133139, pages 41631132588 | main after UX1 (`19d9b91`) | success |
| 41631742696 | PR #5 integrated head `21e504c` (all 4 browser steps + dry-run visible) | success |
| 41631943577, pages 41631942978 | final main `7b6c86d` | success |

## Not done (by design)
No Worker deploy, no `wrangler secret put`, no production secret created, printed or read.

## Manual production steps (local PC)
1. Pull final `main`.
2. Create a dedicated strong `EXPORT_SIGNING_SECRET` (≥32 chars, distinct from every other Spark secret).
3. `cd backend && npx wrangler secret put EXPORT_SIGNING_SECRET`.
4. Deploy the Worker from final `main`.
5. Capture the Worker Version ID (and the previous one for rollback).
6. Verify `/health`, CORS (allowed origin 204, other 403) and `generation`.
7. Verify live `/backup/sign` and `/backup/verify` without exposing backup content (digest/signature only).
8. Verify Pages and the service-worker version (`sw.js` shows `spark-learning-20261103-int1`).
9. Real phone smoke: normal chat; mobile quick controls; export a signed backup; restore into a clean browser profile or second phone; a tampered backup becomes history-only or is refused; a legacy unsigned backup quarantines; session and history persist.
