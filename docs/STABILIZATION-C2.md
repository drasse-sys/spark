# Spark C2 stabilization — 2026-10-22

The active source is `Spark-v5.3-complete/Spark_v5_3`. This is a stabilization package, with no new Spark version. The GitHub repository previously had the accepted frontend but a stale pre-R1/R2 backend; the candidate synchronizes the accepted current Worker before applying the bounded repairs below.

## Repaired behavior

- Automatic voice selection filters language first: nb-NO, no-NO, nb, no, other nb/no regional tags, and finally nn-NO. Foreign default/local/name matches cannot enter the automatic list. Manual voiceURI matches take priority over legacy saved names and survive delayed voice population. No Norwegian voice produces a Norwegian message instead of arbitrary audio. Voice events preserve unsaved settings.
- New phones use the stable production Worker URL. An advanced HTTPS override remains available (HTTP localhost is allowed for local testing). Provider keys and the family code are never saved in frontend settings.
- Autosave keeps the original image until a transcript exists, including the initial pending request. Transcript-only continuation supports the Worker's existing 20,000-character limit. Resume validates stored data and keeps each child's session separate.
- Navigation is locked during asynchronous chat/finish/pair operations. Child changes clear unsent drafts. Stopped speech recognition cannot write into a different child's input. Read-only archives cannot send requests.
- Storage errors are visible. Failed archive writes retain the conversation and summary; saving again does not call the provider twice. Local session IDs prevent a successfully archived session from resurfacing if cleanup fails. The existing rolling limit of eight archives remains unchanged.
- Worker validation rejects malformed/empty message parts and checks actual request bytes even without Content-Length. Token suffixes are rejected. Missing pairing configuration fails closed. Existing R1 global/per-device/per-IP limits, legacy-token compatibility, revocation, R2 prompt ownership and eight-note cap remain intact.
- Gemini 500/503/504, overload/high-demand and retired-model fallback remains. Upstream 401/403 do not walk the chain or invalidate a phone's device token. Ordinary unsupported request fields do not masquerade as retired models. Bare 429 is classified as minute quota. Provider requests and browser requests have deadlines. Daily-only OpenRouter/Groq fallback and secret redaction remain.
- Service worker caches only app assets/navigation, keeps unrelated caches, excludes remote API traffic, never caches unsuccessful responses, bypasses HTTP cache during installation, and uses the offline shell after 3.5 seconds of slow network. Root offline launch works. Cache generation is `spark-stabilization-20261022-c2-final`.
- Mobile zoom is enabled. Header touch targets, keyboard-accessible selectors and icon/input labels are repaired. The public root redirect is included in the active local package.

## Reproducible checks

Verified using Node 26.2.0 and Python 3.13 (TOML parsing requires Python 3.11+):

```powershell
npm --prefix tests ci
npm --prefix tests test
npm --prefix backend ci
npm --prefix backend run deploy -- --dry-run
```

Wrangler is pinned to 4.152.0 so the existing required-secret configuration is understood.

The suite covers syntax, manifest/config/static paths, frontend request contracts, R1/R2 controls, voice selection, persistence, multi-child flows, final summary/archive recovery, quota/fallback/redaction and service-worker behavior. Fixtures contain synthetic credentials only. No tests call a real AI provider.

Final local result: **45/45 checks pass** from a clean locked dependency install. Real Chromium at 390×844 passed the core-flow/offline smoke with zero page errors and no horizontal overflow. Worker dry-run under the locked Wrangler completed without configuration warnings. Both dependency installs reported zero known vulnerabilities at execution time.

Optional real Chromium smoke (Playwright is test-only):

```powershell
npm --prefix tests install --no-save playwright
npx --prefix tests playwright install chromium
node tests/browser-check.mjs
```

`SPARK_CHROMIUM_EXECUTABLE` can point to an already-installed Chromium binary. The smoke test uses its own local server and isolated browser storage, mocks the Worker and verifies mobile layout, pairing, chat, restore, finish/archive, child separation and actual service-worker offline root navigation. Audio quality is not verified by headless Chromium.

Safe public checks, after Pages publishes:

```powershell
node tests/live-check.mjs --require-worker-candidate
```

This checks all six public assets against local content hashes and verifies Worker health, allowed/denied Origin, preflight and unauthenticated chat rejection. `--require-worker-candidate` also requires the deployed `c2-20261022` health marker. It uses no family code/token and triggers no AI inference.

## Deployment disposition

The compatible frontend has been pushed to `drasse-sys/spark` main and published on GitHub Pages. Public checks verified content equality for the app, service worker, manifest, redirect and both icons. A separate isolated mobile browser verified public new-phone setup, the default Worker URL, actual browser CORS health and offline root launch, with zero page errors and no pairing/provider POSTs. Worker health returned 200, permitted preflight 204, denied Origin 403 and unauthenticated chat 401.

**Disposition: STABILIZATION_COMPLETE.** The Cloudflare deployment blocker is resolved. The operator confirmed successful deployment of `spark-family-api`, version `b14b3cd8-920d-46a1-80e4-81eb34805e45`, to `https://spark-family-api.drasse.workers.dev`. The operator's deployed binding report matches the candidate: chat 30/60s, pairing 6/60s, global chat 40/60s, global pairing 20/60s, production GitHub Pages Origin, and `BACKUP_PROVIDER=none`. No secret rotation or new production resource was needed.

Post-deployment verification on 2026-10-22 passed:

- Live `/health`: HTTP 200, `generation=c2-20261022`, `promptVersion=v5.3-r2`, `backup=none`, approved Origin echoed and `cache-control: no-store`.
- Approved preflight 204; untrusted Origin and untrusted preflight 403; missing Origin 403; unauthenticated `/chat` 401.
- Malformed JSON sent to `/pair` returns 400 with the new JSON-validation message. A streamed oversized `/pair` body, sent without Content-Length, returns 413. These two validation probes included no family-code guess, issued no token and invoked no provider.
- All six public assets still match the tested source at frontend implementation commit `36d6fa6b4897239d39ad2088b1a3f05eff2afe9f`. No frontend or Worker implementation changes were made during deployment closeout.
- An isolated mobile Chromium check against the public site passed setup/default URL, actual browser CORS health against the new Worker and offline root launch, with zero page errors and zero pairing/provider POSTs.

The retained tested Worker bundle's source map embeds the exact current `backend/src/index.js`. Normalized Worker source SHA-256: `0f35068fcad2c872ad3cadcbdb992ceafa3536319e18c71fb87dedb972f75eac`; tested bundle SHA-256: `2ab8fef4f85b179d52575d89b53823550151081334b0ade91ca1f418a5fa8941`. Artifact inspection confirms the 500/503/504 and high-demand/overload chain, controlled non-overload failures, provider-auth status normalization, byte limits, deadlines, R1 global limits/revocation, arbitrary-system rejection, eight-note cap and secret redaction are in that candidate. These behaviors already passed the 45-test suite; completed local tests were not repeated for deployment closeout.

Evidence boundary: the version ID and deployed binding report come from the operator's successful Wrangler deployment. Live generation and the new validation behavior independently confirm the candidate is serving. Wrangler version-metadata access remains unauthenticated in this agent environment, and no authenticated Cloudflare browser was available; a remote source checksum was not retrieved. No real Gemini inference or forced production overload was attempted. Provider execution/fallback remains supported by the tested artifact and deterministic runtime tests, with one real paired-phone smoke remaining below.

Queue V4 source-read job `spark-c2-20261022-voice-read` was attempted through the installed Spark client. It refused with `ROUTINE_JOB_INELIGIBLE:MALFORMED_OR_SECURITY:UNREGISTERED_SNAPSHOT`. No model output was accepted, no direct model port was used, and no infrastructure policy was modified. Deterministic tools and frontier reasoning handled the residue. No WAIT/YIELD event occurred.

## Remaining manual smoke

On an already paired phone: photograph a real task → receive a Gemini answer → send a text follow-up → press «Ferdig med leksa» and confirm the archived summary. Listen to Norwegian playback during this smoke; real-device audio quality and microphone behavior cannot be established by headless checks. This is a final real-device smoke, not an outstanding deployment blocker.

One independent review is warranted for the combined persistence and Worker boundary changes. No review PASS is claimed here. Cross-device sync, mastery, analytics/activity charts, reading-aloud correction, Gemini natural TTS and large gamification remain deferred; no new release number is recommended just for this package.
