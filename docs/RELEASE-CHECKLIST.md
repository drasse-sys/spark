# Spark release checklist (reusable)

Manual, controlled steps. Details and rationale: [CF2 handoff](2026-10-31-SPARK-CF2-Release-Handoff.md) (deploy order, Pages timing note, phone smoke list).

1. [ ] **CI green** on the PR's final head (`ci` job: installs, tests, syntax, Worker dry-run, both browser checks).
2. [ ] **Bump identities** if the release changes them: `GENERATION` in `backend/src/index.js` (Worker, shown by `/health`) and `CACHE` in `sw.js` (frontend).
3. [ ] **Worker dry-run:** `cd backend && npx wrangler deploy --dry-run`.
4. [ ] **Worker deploy:** `cd backend && npx wrangler deploy` (output must list the observability setting).
5. [ ] **Capture the Worker Version ID** from the deploy output; record it with the previous ID (see rollback).
6. [ ] **Health / CORS:** `GET /health` -> `ok:true` and `generation` equals `GENERATION`; `OPTIONS /chat` from `https://drasse-sys.github.io` -> 204; other origin -> 403. `node tests/live-check.mjs --require-worker-candidate` covers these.
7. [ ] **Content-free logging:** Workers Logs on, invocation logs off; `npx wrangler tail` during smoke shows no prompt, text, token or body (only `chat_provider_failure` fields `evt,kind,reason,status,tried[],backup,t`).
8. [ ] **Pages publication:** the `pages build and deployment` run finished after the merge to `main`.
9. [ ] **Service-worker generation:** `https://drasse-sys.github.io/spark/sw.js` shows the expected `CACHE`; `spark.html`, `learning.js`, `learning-ui.js`, `arithmetic.js` return 200.
10. [ ] **Paired-phone smoke:** the checklist in the CF2 handoff.
11. [ ] **Rollback reference:** previous Worker Version ID noted (`npx wrangler rollback <version-id>` or `npx wrangler deployments list`); frontend rollback = revert on `main` (Pages republishes); the old service-worker cache is replaced on next load.

## Recommended GitHub settings for `main` (repo owner; not applied by code)
Current state is **not verified** from the repository. Suggested (Settings -> Branches, or a ruleset):
- Protect `main`; require a pull request before merging.
- Require status check **`ci`** (workflow `CI`) to pass, with branches up to date.
- Block force pushes and branch deletion.
- Note: Pages publishes on every push to `main` regardless of CI; protection plus PR-only merges is what keeps untested code out.
