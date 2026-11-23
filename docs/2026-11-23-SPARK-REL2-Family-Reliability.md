# SPARK REL2 Family Reliability

## Baseline

- Canonical `origin/main` at `f4f55af9fd72c5f30a7dc9ade97a01cefa06c48a`.
- Branch `rel2-family-reliability-20261123` starts at that commit and excludes the experimental multi-device work.

## Confirmed defects and repairs

| Area | Observed failure | Repair and regression coverage |
| --- | --- | --- |
| Storage reads and expiry | A failed startup read could lead to writes based on empty state. A failed aggregate write could leave an old session looking committed in memory, so a second read could remove its only durable copy. | Block writes after a failed read until reload. Keep old work recoverable until its aggregate saves. Controlled read and write failures reproduce both. The existing 30-day retention rule still applies. |
| Requests and unfinished sessions | Failed and interrupted turns had no retry for the original input. The timeout ended at response headers. | Save pending input before sending, retry the original payload, and keep the deadline through JSON body receipt. Cover 503, malformed replies, stalled bodies, failed autosave, photo payload retry and tab closure in flight. |
| Drafts, pause and navigation | Chat drafts disappeared on reopen. Pause claimed a successful save on storage failure. A one-message new-task flow bypassed archiving. | Restore the saved chat draft, flush on navigation and backgrounding, require a successful write before claiming pause, and offer the existing archive confirmation for one-message sessions. Browser Back and offline reload retain the draft. |
| Completion | The parent log could commit ahead of the archive. A reload while waiting for the closing summary lost the completion intent. | Save completion intent first. Commit the archive, learning aggregate and parent log together. Exercise failed archive, restart and repeated completion. |
| Restore and child ownership | Restore could leave profiles without their legacy work or report failure after profiles were already saved. Failed learning-data deletion could drop a session before saving the profile. | Commit the family independently of the active-child pointer. Stage legacy sessions with matching profile identities and roll back on failure. Commit deletion before cleanup. Pending imports from a detached settings screen are discarded. The app supports child addition, child switching and per-child learning-data deletion. It has no whole-profile deletion control. Backup schemas, trust and append behavior are unchanged. |
| Photo and microphone | A late photo could apply after leaving and reentering the start screen. A second mic tap during startup could start another recognizer, and delayed recognition could replace typed text. | Invalidate photo work on navigation or target changes and release the preview when starting a task. Cancel the active recognizer and protect drafts from delayed callbacks. Browser coverage includes invalid data and downscaling a 2600×1600 photo to 1100 px. |
| PWA update | Network-first refresh could mix releases and activate an update during homework. | Cache one verified set of executable files, wait for existing clients to close, and accept a missing file from the network only if its hash matches. Test offline opening, update waiting and activation, and recovery from a missing file. |

## Verification and review

- **306 of 306 Node tests passed.** All 10 new REL2 Node regressions failed on the canonical baseline and passed on the candidate. Service-worker tests also cover mixed-install rejection and matching-file recovery.
- **Five browser suites passed** in Chromium with zero page errors. The suites cover general acceptance, learning, trusted backup and restore, touch and keyboard behavior, and REL2 recovery. Mobile touch coverage spans 320–412 px. AI and speech events used fixtures.
- JavaScript syntax, manifest and Worker configuration parsing, Worker dry-run, and `git diff --check` passed.
- Focused review covered data loss, child attribution, duplicate actions, failed saves, mobile lifecycle, network recovery, restore atomicity, and cache generation boundaries. The review added the startup read guard and the old-session aggregate failure regression. Prepared photo data is released after start and discarded from live request history once a transcript is available.
- Production read-only check against the baseline matched all nine Pages assets and passed Worker health, CORS, preflight and unauthorized-request probes. The optional strict deployment check found the already-deployed Worker at `c3r1-20261022`, while canonical main declares `rh1-20261031`. REL2 changes no Worker code.
- GitHub CI passed on implementation commit `98fd70e6adf38a5e2acbf7699c43073650789b34`, including all five browser suites. [Implementation CI run](https://github.com/drasse-sys/spark/actions/runs/45235885078). A documentation-only follow-up records this result. [PR #8 checks](https://github.com/drasse-sys/spark/pull/8/checks).

## Follow-up

- Verify Android camera permissions, microphone permissions, Norwegian voices and OS process eviction on a physical phone. Chromium exercises the browser lifecycle and simulated speech events.
- Consider durable drafts on the task-creation screen and a single transaction for in-progress learning evidence and its matching chat snapshot. The current turn and profile snapshots still use separate storage records.
- For future PWA releases, bump `CACHE` in `sw.js` and refresh the SHA-256 pins in `CODE` for changed HTML or script files. Compute pins from UTF-8 text with CRLF normalized to LF. The service-worker install tests check the pins. Verify the first upgrade from the production network-first worker after publication.
