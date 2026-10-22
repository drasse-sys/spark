# Spark C3 — Learning Evolution A+B+C

Date: 2026-10-22 (Europe/Oslo). Disposition: **LEARNING_EVOLUTION_COMPLETE**, tested local candidate; not deployed. Design authority: `2026-10-22-SPARK-S7-Learning-Science-Product-Blueprint.md`. Baseline: `STABILIZATION-C2.md`, Git `51b052a0e420ad4dd841342a33771bc00046f65a`.

The product objective is later independent performance with less assistance. A+B+C form one package. There are no points, streaks, rankings, emotional profiles, statistical learner models, cloud sync or raw-audio recording.

## Architecture and files

The existing single-page app keeps ownership of profiles, pairing, photos, navigation, Norwegian voices, archives and provider requests. Four small classic scripts extend it:

| File | Responsibility |
|---|---|
| `arithmetic.js` | Shared bounded exact rational parser, numeric answer comparison and model-marker inspection. Imported by the Worker and loaded by the client. |
| `learning.js` | Versioned catalogue, support maximum, evidence/state rules, item generation, scheduling, activity aggregation, migration and retention. Pure code, no network. |
| `visuals.js` | Seven allowlisted numeric schemas and deterministic responsive SVG rendering. |
| `learning-ui.js` | Task loop, transfer/review, word items, parent view, reflection, reading and learning-only backup controls. |
| `spark.html` | Integration into accepted session, archive, speech and UI flows. |
| `backend/src/index.js` | Server prompt `v5.4-c3r1`; allowlisted learning context; common arithmetic guard for Gemini and backups. Health generation `c3r1-20261022`. |
| `sw.js` | Cache generation `spark-learning-20261022-c3r1`; all four scripts included in the offline shell. |

Authentication, token verification, pairing, rate limits, provider secrets, mode allowlist and provider fallback selection are unchanged. Targeted R1/R2 regression tests still run. Learning context remains inside the existing 300-character `sessionState` contract: the Worker parses JSON and reconstructs only allowlisted values, ignoring arbitrary instructions or unknown properties.

## Package A: independence loop

Each active session has a stable ID and a separate learning object, retained outside the trimmed chat payload. Each task has a code-owned ID, skill, maximum support, attempt count and completion flag. The child starts a new homework subtask with **Neste deloppgave**; deterministic checks also create a fresh task. Switching child clears transient task, reading and visual state. Restoring a session restores its own support evidence.

S0 means no content help; S1 is a checking reminder; S2 is a strategy hint; S3 is smaller steps; S4 is a fully modelled parallel example. Buttons raise the maximum immediately. Model `STØTTE` markers can raise it, never lower it. Malformed markers cannot create evidence. Because arbitrary tutor prose cannot be proven hint-free, tutor-generated content conservatively has a floor of S2. S0 recognition is therefore reserved for locally checked work before tutor help. This intentionally avoids optimistic independence claims from a model's self-report.

The visible ladder has a soft first-attempt invitation at age 8+, with a second tap proceeding. Younger children are not blocked. **Jeg vet ikke** proceeds directly to help. **Pause / for vanskelig** saves the session and returns to the start screen without another AI call.

After supported completion, the child can accept or skip one similar generated transfer item. There is at most one transfer offer per session, never an automatic series. The initial answer receives no hint. Incorrect answers record the actual evidence, offer a gentle S1 check, and let the child request ordinary teaching or skip. Supported non-numeric work can offer a bounded `PRØV` proposal in the existing tutor reply, but its outcome remains an unverified tutor observation.

The header's star counter and model-awarded points are removed; old numeric `stars` values remain inert for safe migration. **Klarte selv** is attached to a checked S0 success, never accumulated into a score. Guessed cold answers do not receive the independence badge. The child can open **Ting jeg kan nå**, showing the same evidence available to parents.

One optional strategy reflection is available in the session. It costs no AI call, appears in the parent aggregate and can retain a strategy associated with a checked independent completion. Closing summaries do not change task support or mastery.

## Skill and event schema

`kid.learning.version = 3`, catalogue v1 (36 closed IDs). Unknown model IDs map to `annet`, which has no generated review. The catalogue includes grade bands, labels, generator availability and suggested representations. Words/glosses are separate items, not new skill IDs.

Events retain numeric epoch milliseconds (`t`), support (`s`), outcome (`ok`), kind (`task`, `prøv`, `cold`, `word`), bounded error/confidence fields, session/task-attempt identity, deterministic-verification status and delayed status. Per-skill verified history is capped at eight events, with up to eight separate non-authoritative observations. Small checkpoints retain first independence, first qualifying delayed check, retention date, last practice/session, review box and due date when older events leave the cap. The closed catalogue bounds skill count.

| Derived state | Rule |
|---|---|
| NY | No usable events. |
| ØVER | Latest verified answer incorrect, guessed, or needs S3–S4; also the initial practice label when only observations exist. |
| MED_STØTTE | Latest checked success at S2. |
| SELVSTENDIG | Latest checked success at S0–S1 without the required retained evidence. |
| SITTER | A qualifying cold success at least one day after previous practice, in another session, and a second qualifying cold success at least seven days after the first. |

Verified supported or unsuccessful evidence removes retained status conservatively. Model observations cannot promote or demote verified mastery, change its box/due date, or clear its checkpoints. Recent observed practice still prevents premature delayed-evidence classification. Reading comprehension observations remain explicitly labelled as tutor observations; word-list exact matching does not claim broad comprehension mastery. `due` is a scheduling property, never a mastery state. Duplicate attempt IDs do not add evidence.

## Exact arithmetic and quota

Grammar: bounded integers (up to six digits per literal), decimal comma (up to three decimal places), unary sign, parentheses and `+ - − * × · / ÷ :`. Evaluation uses reduced BigInt fractions. Limits: 160 characters, six nested parentheses, 20 operations and reduced numerator/denominator bounded by 10^12. Division by zero, scientific notation, thousands separators, decimal points, implicit multiplication, units, variables, ambiguous digit spacing, code and unsupported input are rejected. No `eval` or dynamically executed model code is used.

Transfer and review own explicit local answer targets. Single-expression homework uses the local exact checker only after the child selects “Sjekk svaret på [expression]”; otherwise numeric replies reach the tutor without verified evidence. Original-expression ownership clears on help, tutor replies, task/session/child changes and restore (the child can select it again). A simple photographed expression can use its extracted transcript. The transcript's interpretation still comes from the model: arithmetic verification does not verify OCR or a word problem's modelling.

The Worker inspects `SJEKK` markers for every provider. Contradictory, malformed or unsupported checks cause at most one reconciliation generation. If that fails, the child receives a neutral response, with only any bounded photo transcript preserved. For supported checks, code renders the verdict and bounded STEG teaching intents, preserving validated learning markers. Narrow exact legacy arithmetic sentences are also retained. Arbitrary verdict prose is discarded. Reconciliation cannot swap an initially supported expression or child answer. Internal reconciliation text is never returned.

**No-marker limitation:** open-ended tutor reasoning without a check marker cannot be proven arithmetically correct. Such a reply is not marked verified and cannot confer checked independence. Tests cover compliant, contradictory, missing and malformed markers; no live model marker-compliance rate is claimed.

Quota behavior:

- Generated maths, review scheduling, answer checking, word practice, reflection, analytics and visuals: **zero additional AI calls**.
- Deterministic practice completion: **zero AI calls**, including its archive summary.
- Requested teaching and reading dialogue use the existing next-turn call; ordinary homework closing retains its existing summary call.
- A rejected arithmetic marker adds at most one reconciliation generation. Existing overload/retired-model fallback may make multiple provider HTTP attempts within either generation. Backup routing remains daily-quota-only. Intervention counts are retained locally per session.

## Package B: review, parent information and retention

The Leitner schedule is 1, 3, 7, 21, 60 days. Skills enter after checked S0–S2 success. Qualifying delayed S0–S1 success advances one box, S2 holds it, and a wrong/S3–S4 answer drops one box with a floor of one. A correct guess does not advance. The optional warm-up offers at most three distinct due skills/items; skipping creates no success or failure. Confidence is optional for age 8+ and reset for every item.

Generators cover number/place-value, number friends, doubling/halving, bounded add/subtract variants, times tables, exact division, clock and money. Same-type transfer avoids the preceding item identity. Practice entry points are three-item warm-up, multiplication and typed word/gloss lists. Lists are entered as `word | explanation`; reading vocabulary can be added explicitly. Exact word matching checks recall of that saved word, not whether a synonym is semantically wrong. No new open-chat mode was added.

Parent data comes from retained structured session aggregates, independently of the transcript store. Each contains session ID, numeric start/end times, raw interaction timestamps, active milliseconds, mode, task evidence, optional reflection and verifier interventions. Retries collapse to one task record at its highest support for the chart. Legacy sessions have explicitly unknown times rather than invented precise dates.

Activity counts only visible interaction gaps no longer than three minutes. Longer gaps contribute zero; backgrounding and restoring break the interval. After 25 active minutes the child sees a pause suggestion. Time is contextual information, not a target or score.

The parent area shows skill state/dates, support, review dates, recent sessions, active minutes, four weeks of verified-success bars grouped by support, delayed-check counts, recurring support across sessions and a deterministic conversation suggestion. Transcript text is not rendered in this view. The separate archive remains an explicit family action. There are no grades, rankings or sibling comparisons.

The latest eight transcript archives (up to 40 messages each) are retained; their messages expire after 30 days. The latest 120 lightweight aggregate sessions remain, each capped at 120 event records and 240 raw interaction timestamps. Running active duration and skill checkpoints do not depend on these pruned arrays. Active-session evidence/timestamp arrays use the same nested bounds. Legacy archives with no trustworthy machine time get a 30-day migration grace period. Abandoned active sessions expire after 30 days of inactivity. Images continue to be removed once the transcript is available. Migrating recovery copies also expire after 30 days. Deleting one child's history removes that child's recovery content and leaves siblings intact. Nothing is synced to a cloud.

## Migration, export and recovery

Migration ID **spark-c3-learning-v1** is written only after the converted profiles are durable. Before mutation, a learning-only recovery envelope stores the old `spark_kids`, indexed active sessions and the old legacy session key. Credential, server-token and provider-secret storage keys are not read into it. Index positions are retained, including malformed child slots, so session ownership does not change. Known valid notes and old sessions survive; malformed source material remains in the recovery envelope during its retention period.

Migration is idempotent. Backup or profile-write failure preserves the source and blocks new learning writes with a visible storage message; a completion-marker failure can be retried without overwriting the original recovery copy. Existing paired devices need no re-pairing.

The parent area can restore recoverable old profiles as **new** profiles, avoiding silent merges. Learning JSON exports explicitly select learning/profile fields and exclude pairing credentials. Import validates the version and events, preserves normalized schedules/checkpoints/word evidence and appends new profiles. Existing children are untouched; a failed profile write rolls back the in-memory append. Invalid/corrupt source text is not guessed into valid learning evidence.

## Package C: visual tools and reading

`VIS` accepts only bounded JSON for number line, ten frame, base-ten blocks, array, fraction strip, clock and Norwegian coins. The client reconstructs every SVG from validated numbers; model HTML/SVG is never executed. Every tool has a title, accessible label and visible text equivalent. Rendering is deterministic, responsive and quota-free. Invalid specs are discarded. Visual assistance raises support to at least S2; question diagrams for clock/money checks are the question itself, without an added computed-total caption.

The reading companion remains inside `lesing`: a short passage, retell, main idea, one prediction/check flow and explicitly chosen vocabulary review items. The parent controls **Les for meg** per child; it is offered only for comprehension, not decoding practice. Existing Norwegian voice selection is reused. The passage is spoken sentence by sentence with sentence highlighting, guarded against stale callbacks when navigating or changing child.

Speech recognition is opt-in text input, not assessment. The recognized draft stays editable before sending, with an uncertainty notice. Missing speech support retains the complete text workflow. There is no per-word interruption, fluency scoring, emotional inference or audio recording/storage. The prompt asks for one gentle content response and one useful missing element after a passage, rather than questions after every sentence.

## Verification

**206/206 automated tests pass: the reviewed 153-test suite plus 53 maintained consolidated-repair regressions.** The suite additionally loops over 2,280 small-integer arithmetic comparisons and 150 seeds for every implemented generator. No real AI provider is called.

Coverage includes migration fixtures with multiple children, malformed slots/records, notes and old active sessions; idempotence and interrupted writes; recovery/export/import; deletion isolation; support and history trimming; exact positive/negative/injection-like arithmetic; Worker retries and backup-provider checking; delayed mastery and scheduling; skip/guess behavior; retention/activity; parent transcript exclusion; exact visual quantities/bounds/accessibility; reading fallback/highlighting; and deterministic zero-call flows.

Real Chromium acceptance passes:

- Existing baseline 390×844 flow: pairing, chat, restore, finish/archive, child separation and real service-worker offline root navigation.
- C3 at widths **320, 390 and 768**: supported task → transfer → checked S0 success, reflection restore, parent view, zero-call practice, delayed review, reading vocabulary, all seven accessible visual tools and offline module/practice loading.
- Zero browser page errors and no horizontal overflow. Screenshots were inspected locally; `tests/artifacts/` is intentionally untracked.
- Wrangler **4.152.0** dry-run bundles successfully with the existing bindings and no configuration warnings. No deployment was performed.

Reproduce from the project root:

```powershell
npm --prefix tests ci
npm --prefix tests test
npm --prefix backend ci
$env:WRANGLER_LOG_PATH = "$PWD/tests/artifacts/wrangler"
npm --prefix backend run deploy -- --dry-run --outdir ../tests/artifacts/worker-c3
# Optional browser dependency, test-only:
npm --prefix tests install --no-save playwright
$env:SPARK_CHROMIUM_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests/browser-check.mjs
node tests/browser-learning-check.mjs
```

## Queue V4, lineage and review

Deterministic source inspection and the baseline suite preceded implementation. The active Queue V4 admission registry still contains only `mars-20261016-camera` and `mars-20261016-terrain`. The established C2 Spark refusal is `ROUTINE_JOB_INELIGIBLE:MALFORMED_OR_SECURITY:UNREGISTERED_SNAPSHOT`; it was recorded once and **not re-probed**. This mission submitted zero jobs and consumed zero qwen results. No registry, policy, provider port, qualification or infrastructure change was made. Deterministic tools and frontier reasoning handled the remaining work.

The active source directory is not itself a Git checkout. The candidate is committed on a dedicated branch in the already-established `.stabilization/repo` checkout, preserving baseline ancestry; changed candidate files are byte-identical to the active project. No Historic files were used as implementation sources. No push or deployment is included.

**One independent review is warranted before controlled deployment**, specifically for migration/recovery ownership, the evidence/checkpoint rules, and arithmetic reconciliation across providers. This is a completed engineering candidate, not an independent-review PASS.

Remaining real-device checks (at most five):

1. On an already paired phone, photo → tutor → text continuation → finish/archive; confirm no re-pairing.
2. Listen to Norwegian sentence playback/highlighting; switch reading goal and stop playback.
3. Dictate a short retell, edit the uncertain draft, send; verify permission-denied fallback. No actual microphone/audio quality was verified here.
4. Complete a transfer and skip a warm-up; reload and confirm the correct child's support/evidence and reflection.
5. Update the installed PWA and launch offline; check the ladder and visuals on the actual phone.

Recommended next action: one independent review of this complete commit, then one controlled rollout of the Worker and all frontend assets together. `tests/live-check.mjs --require-worker-candidate` is prepared for post-deployment verification of all ten public assets and the new Worker generation; it has not been run against the still-C2 production site.


## C3R1 consolidated S8 repair — 2026-10-22

Reviewed base: `1dfc7d014f4c51f99783863a3370cdc5f60b340a`, branch `learning-c3-20261022`. All six actionable findings are repaired together; the accepted A+B+C architecture and security boundaries remain unchanged. No deployment or live provider calls occurred.

| Finding | Repair and regression invariant |
|---|---|
| B-1 | Code owns the arithmetic verdict. Up to three STEG intents render verified arithmetic facts, one arithmetic question and/or allowlisted hints. Narrow legacy arithmetic sentence forms survive; arbitrary verdict prose does not. Valid VIS, LOGG, PROFIL, PRØV, ORD, OPPGAVE and STØTTE survive reconciliation. VIS uses the existing shared validator; support takes the maximum across attempts and its outcome is reconciled. At most one retry; supported target/answer identity cannot change on retry. Repeated rejection yields the existing neutral fallback with bounded photo transcript. |
| B-2 | Explicit original-expression check UI binds answer ownership to child, session, task and expression. Ordinary tutor sub-step answers pass through. Transfer/practice retain their app-owned targets. Help, cancel, navigation and completion invalidate ownership. |
| I-1 | Unverified events enter a separate eight-observation ring, never the verified event ring or mastery transition. Verified state, box, due date, independence and delayed checkpoints survive model observations. Normalization separates legacy mixed events. Recent observations conservatively affect whether future evidence is truly delayed, without rewriting prior mastery. |
| I-2 | Hidden clock captions, aria labels and SVG titles describe dial positions, including between-hour and small-tick positions. They never decode the minute/time answer. The hand geometry is unchanged. |
| I-3 | Per child: 8 transcript archives × 40 messages; 120 recent aggregate sessions × 120 event records × 240 interaction timestamps (the latter two are separate arrays). Verified skill evidence remains 8 events per closed skill plus compact checkpoints; observations have their own 8-event bound. Words remain capped at 60 with 8 events each. Oldest entries leave first, independent of device clock. Cleanup runs at normalization, save, archive and export/import; it is idempotent and preserves sibling isolation and failed-archive rollback. 120 recent sessions supports the four-week parent view at several sessions per day; unusually frequent use can shorten chart coverage. |
| I-4 | Chart bars count only verified, correct, non-guessed outcomes, grouped by maximum support. Green means S0/S1 success, with S1 explicitly described as a small cue. Failed or unverified attempts receive neutral session labels. Supported success is never labelled unaided. |

Schema remains version 3 and migration ID remains `spark-c3-learning-v1`: this is backward-compatible normalization, with an optional observations field and bounded existing arrays. No credentials, pairing keys or children are reindexed. Existing migration backups remain unchanged. Pruning aggregate/transcript history cannot remove skill checkpoints or the verified ring used to compute mastery. Learning export/import preserves these fields and enforces the same bounds. Previously erased historical checkpoints cannot be reconstructed from absent data.

Quota: zero additional calls for explicit checks, storage, charts or clock rendering; ambiguous numeric tutor replies now correctly use the ordinary tutoring turn. The existing one-reconciliation-generation ceiling remains. Tightly coupled unit repair: Worker SJEKK accepts only a numeric answer followed by `kr` or `kroner`, checks the numeric value, and does not claim unit/model verification. The shared strict arithmetic parser is unchanged; other units remain unsupported.

Validation: baseline **153/153** before repair; expanded suite **206/206** afterward, including **53/53** dedicated B-1/B-2/I-1–I-4 fixtures. These include Worker/provider reconciliation, answer ownership, delayed mastery, migration/reload/export/import, archive failure rollback, 2,000-session storage growth, chart labels, all clock skills and exact hand geometry. Syntax, manifest/TOML, R1/R2, fallback, voices, photos, autosave, archive and service-worker regressions pass. Wrangler 4.152.0 dry-run passes with unchanged bindings. Maintained browser checks pass at 320/390/768 widths, with sub-step routing, explicit ownership, positional clock accessibility, existing C2 flows and real offline service-worker loading; no page errors or horizontal overflow. No real microphone/audio-quality assessment was performed.

The service-worker cache generation is bumped solely to install the repaired frontend assets coherently; Worker health/prompt identifiers and the future live-check target identify C3R1. Queue V4 was not re-probed: the known unregistered-snapshot boundary remains; no Queue/provider infrastructure was changed. Source-mirror comparisons showed only pre-existing line-ending differences from the reviewed base before synchronization.

Deferred S8 nonblocking notes: backwards device clocks; cleanup of active sessions for children never opened; the legacy recovery-copy history edge; trust in parent-imported verified claims; generator variety; word items with `due:null` treated as due. General unit-bearing answers (including local money entry) remain numeric-only; only the tightly coupled Worker currency-marker case above was repaired.

**Focused independent re-review is READY**, limited to the six S8 findings and their maintained regressions, especially the bounded STEG/marker reconciliation and observation/checkpoint separation. Review this consolidated commit before any controlled deployment.
