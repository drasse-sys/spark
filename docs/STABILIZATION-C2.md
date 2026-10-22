# Spark C2 stabilization — 2026-10-22

The active source is `Spark-v5.3-complete/Spark_v5_3`. This is a stabilization package, with no new Spark version. The GitHub repository previously had the accepted frontend but a stale pre-R1/R2 backend; the candidate synchronizes the accepted current Worker before applying the bounded repairs below.

## Repaired behavior

- Automatic voice selection filters language first: nb-NO, no-NO, nb, no, nn-NO, then other nb/no regional tags. Foreign default/local/name matches cannot enter the automatic list. Manual voiceURI selections and legacy saved names survive delayed voice population. No Norwegian voice produces a Norwegian message instead of arbitrary audio. Voice events preserve unsaved settings.
- New phones use the stable production Worker URL. An advanced HTTPS override remains available (HTTP localhost is allowed for local testing). Provider keys and the family code are never saved in frontend settings.
- Autosave keeps the original image until a transcript exists, including the initial pending request. Transcript-only continuation supports the Worker's existing 20,000-character limit. Resume validates stored data and keeps each child's session separate.
- Navigation is locked during asynchronous chat/finish/pair operations. Child changes clear unsent drafts. Stopped speech recognition cannot write into a different child's input. Read-only archives cannot send requests.
- Storage errors are visible. Failed archive writes retain the conversation and summary; saving again does not call the provider twice. Local session IDs prevent a successfully archived session from resurfacing if cleanup fails. The existing rolling limit of eight archives remains unchanged.
- Worker validation rejects malformed/empty message parts and checks actual request bytes even without Content-Length. Token suffixes are rejected. Missing pairing configuration fails closed. Existing R1 global/per-device/per-IP limits, legacy-token compatibility, revocation, R2 prompt ownership and eight-note cap remain intact.
- Gemini 500/503/504, overload/high-demand and retired-model fallback remains. Upstream 401/403 do not walk the chain or invalidate a phone's device token. Ordinary unsupported request fields do not masquerade as retired models. Bare 429 is classified as minute quota. Provider requests and browser requests have deadlines. Daily-only OpenRouter/Groq fallback and secret redaction remain.
- Service worker caches only app assets/navigation, keeps unrelated caches, excludes remote API traffic, never caches unsuccessful responses, bypasses HTTP cache during installation, and uses the offline shell after 3.5 seconds of slow network. Root offline launch works. Cache generation is `spark-stabilization-20261022-c2`.
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
node tests/live-check.mjs
```

This checks all six public assets against local content hashes and verifies Worker health, allowed/denied Origin, preflight and unauthenticated chat rejection. Add `--require-worker-candidate` after Worker deployment to require its `c2-20261022` health marker. It uses no family code/token and triggers no AI inference.

## Deployment disposition

The frontend remains compatible with the currently live R2 Worker and can ship independently. The new Worker candidate builds successfully, but Wrangler reports no authenticated account; it has not been deployed by this mission. Existing production secrets must be retained. After authenticating Cloudflare, deploy the existing Worker from this package's `backend` directory and run the safe live check with `--require-worker-candidate`.

Queue V4 source-read job `spark-c2-20261022-voice-read` was attempted through the installed Spark client. It refused with `ROUTINE_JOB_INELIGIBLE:MALFORMED_OR_SECURITY:UNREGISTERED_SNAPSHOT`. No model output was accepted, no direct model port was used, and no infrastructure policy was modified. Deterministic tools and frontier reasoning handled the residue. No WAIT/YIELD event occurred.

## Remaining device checks

1. On Vivaldi, listen to automatic Norwegian and a saved manual Bokmål voice after closing/reopening the app.
2. On both phones, take a real homework photo, resume after reload, then continue using text.
3. Check microphone permission, dictation, stop and retry on each supported phone browser.
4. Open/update the installed PWA online, then reopen offline; confirm settings/profile retention.

One independent review is warranted for the combined persistence and Worker boundary changes. No review PASS is claimed here. Cross-device sync, mastery, analytics/activity charts, reading-aloud correction, Gemini natural TTS and large gamification remain deferred; no new release number is recommended just for this package.
