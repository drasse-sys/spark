# Spark CF2 — Release handoff (CF1 on the CI1 baseline)

Status: **release-ready, not merged, not deployed.** Merge and deploy are controlled manual steps.

## Evidence
| Item | Value |
|---|---|
| `main` (CI1 baseline) | `7dbf5f8db00b752b3f185347666a763e33848081` |
| Original CF1 candidate | `2780b431454709da6281cc1ba0bfb6d68af7216c` |
| Integrated code head | `25af5cbf3ee203082a840044758a71ef185032d8` (normal merge of `main`; no conflicts; only CI1's 3 files added: `.github/workflows/ci.yml`, `tests/package.json`, `tests/package-lock.json`) |
| PR | [drasse-sys/spark#1](https://github.com/drasse-sys/spark/pull/1), `cf1-frontier-residue-20261030` → `main` |
| GitHub CI on `25af5cb` | run `41185103119`: **success** (all steps: lockfile installs, 266/266 tests, syntax checks, Worker dry-run, Chromium install, both browser checks), [run 41185103119](https://github.com/drasse-sys/spark/actions/runs/41185103119) |
| Automated tests | 266/266 (same as pre-integration; CI1 added no tests) |
| Syntax / manifest | `node --check` on all JS/MJS and `manifest.json` parse pass |
| `wrangler deploy --dry-run` | OK, 55.61 KiB / gzip 20.23 KiB |
| Browser checks | `browser-check.mjs` and `browser-learning-check.mjs` PASS (local run in preinstalled Chromium; CI runs them in lockfile-pinned Chromium) |
| `git diff --check`, secret scan of the diff | clean |

The commit that adds this document is documentation only. CI re-runs on it, and the result is on the PR.

## What the release contains (CF1, reviewed)
- **Import trust:** an imported learning copy keeps its history but carries no verification authority and cannot create mastery, credit or retention. Practised skills and words are due for local revalidation.
- **Clock:** explicit reference time (`L.event(..., now)`), deterministic, no hidden clock reads. Backwards and far-future timestamps are covered.
- **Gemini chain:** advances on 5xx/overload, retired model, timeout, rejected outbound fetch, and empty/non-object/malformed reply. Stops on 401/403, 429, other 4xx and safety blocks. 45 s budget per walk. Client errors carry Spark text only.
- **Observability:** `[observability.logs] enabled, invocation_logs=false`, `[observability.traces] enabled=false`. The only persisted line is the content-free `chat_provider_failure`.
- Service-worker cache `spark-learning-20261030-cf1`.
- Design and residuals: `docs/2026-10-30-SPARK-CF1-Frontier-Residue.md`.

## Deploy order (controlled, manual)
1. **Merge PR #1** after CI is green on its final head. Merging pushes to `main`, which also triggers the repo's `pages build and deployment` (see the note below).
2. **Deploy the Worker** from the merged `main`: `cd backend && npx wrangler deploy`. Check that the deploy output lists the observability setting, and record the new version ID.
3. **Verify Worker health and CORS.**
   - `GET /health` returns `ok:true`. **`/health` is unchanged by CF1** (`generation:'c3r1-20261022'`), so it cannot show which version is live. Confirm the version from the deploy output or `wrangler deployments list`.
   - `OPTIONS /chat` with `Origin: https://drasse-sys.github.io` returns 204. A different origin returns 403.
4. **Verify content-free provider logging.** In the Cloudflare dashboard, check that Workers Logs is on for `spark-family-api`, and run `npx wrangler tail` during the phone smoke. A failure on the real provider cannot be provoked safely, so a healthy smoke may log nothing. If a `chat_provider_failure` line does appear, it must contain only `evt,kind,reason,status,tried[],backup,t`, with no prompt, text, token or body. Also confirm that no per-request invocation logs appear.
5. **GitHub Pages publishes the frontend.** This starts automatically at step 1 (see the note). Wait for the `pages build and deployment` run to complete.
6. **Verify public generation and assets.** Fetch `https://drasse-sys.github.io/spark/sw.js` and confirm `CACHE = 'spark-learning-20261030-cf1'`. Confirm `spark.html`, `learning.js`, `learning-ui.js` and `arithmetic.js` return 200.
7. **Real paired-phone smoke** (checklist below).

**Pages timing note:** the existing Pages workflow publishes on every push to `main`, so merging publishes the frontend before the Worker deploy in step 2. The reviewed analysis found the old Worker with the new frontend, and the new Worker with the old cached frontend, both compatible. To enforce Worker-first, deploy the Worker from the PR branch before merging.

## Manual phone smoke checklist
- [ ] Launch or update the PWA, then reload once so the new service worker takes over.
- [ ] Simple text tutor request gets a sensible reply.
- [ ] Photo task is read and answered.
- [ ] Text follow-up to the photo task works.
- [ ] Norwegian playback (Les for meg or speaking) plays in Norwegian.
- [ ] "Ferdig med leksa" finishes and gives a summary.
- [ ] Archive and history show the finished session.
- [ ] Learning state persists after closing and reopening the app, and the parent view shows it.
- [ ] Optional: export a learning copy and import it as a new profile. Its skills should show "tidligere historikk fra kopi", not mastery.

## Repository hygiene (observed; nothing changed)
- CI runs on pull requests to `main` and on pushes to `main`, with read-only permissions, a 15-minute timeout and cancel-in-progress per PR. Both the push to main and the first PR run passed.
- **Not verifiable from here:** whether branch protection requires the `ci` check before merge. This session cannot read repository settings.
- Actions are pinned to tags (`actions/checkout@v4`, `actions/setup-node@v4`), not commit SHAs.
- CI does not gate Pages publishing. Pages deploys on any push to `main`, whatever the CI result.

## Future candidates (not started)
1. Require the `ci` check on `main` through branch protection or a ruleset. This is a settings change for the repo owner.
2. Pin the Actions to commit SHAs.
3. Make `/health` report a deploy-specific generation (e.g. `cf1-20261030`) so a deploy can be verified remotely.
4. Signed learning exports, so a restore can keep verification authority. Design: a Worker HMAC with a dedicated secret.
5. Provider quota policy: hop models on per-model daily quota, and decide whether and when to turn on a backup provider.
6. Unit semantics for general unit-bearing answers (kg/cm/m): which task owns each unit, which conversions are accepted, and how dimensional correctness is checked.
7. Gate Pages publishing on CI (for example by publishing from a workflow after CI passes).
