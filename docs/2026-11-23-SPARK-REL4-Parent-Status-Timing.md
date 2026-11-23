# SPARK REL4 Parent Status and Response Timing

Base `877c21b83c21b822d6b6174dda0a81749275adb0` on canonical `main`.

## Parent status

Settings → **Spark-status** separates the running app release, a waiting update, and the configured Worker's health. Opening the section or tapping **Sjekk på nytt** checks the saved server address with a credential-free, 4.5-second `/health` request. Reconnect checks again. The connection row reflects the phone's local pairing. Health describes service reachability and the reported backup mode. The latest AI result separately shows quota, temporary service problems, timeouts, and network failures.

The `spark-release` meta tag in `spark.html` names the running app. For a frontend release, update that tag and run `node scripts/sync-pwa.mjs` to generate the cache name and file hashes. Tests verify the generated values. A waiting worker appears in Settings while the current tab keeps running its own release. Closing all Spark tabs allows the update to take over.

## Timing, privacy and storage

- Phone timing measures an AI turn through receipt of the reply and includes Spark's automatic short-term quota wait. A manual retry begins a fresh timer. A failed request keeps its own elapsed time.
- Parent-only thresholds follow the 20-second single-provider timeout and the possibility of multiple attempts. **Raskt** under 5 s, **Normalt** 5 to under 20 s, **Sakte** 20 to under 60 s, **Svært sakte** 60 s or longer.
- The device keeps one successful result and one failed result. It stores milliseconds, timestamps and normalized categories. The Worker supplies the provider, a recognized public model when available, approximate server time, and a multiple-attempt flag. The attempt flag includes fallback and arithmetic reconciliation calls.
- The storage check reads the existing profile and session keys without applying recovery side effects. It writes, reads and removes a reserved temporary key. Copy uses only the displayed operational fields and falls back to selectable text if clipboard access is refused. Tests seed child names, homework, chat, notes, transcripts and identifiers and check they are absent from both copy paths.
- Related fixes cover daily quota when the Worker supplies only the normalized kind, stale timing after another tab records a response, and the otherwise hidden automatic wait in a successful turn's duration.

## Local AI and phone follow-up

A future local provider can enter the Worker's provider dispatch beside `callGemini` and `callBackup`. Return the same reply shape, count each upstream call, and pass the reply through `checkedReply` and the existing response formatter. Publish only explicitly approved provider or model names.

After rollout, verify the waiting-update notice with two tabs on Android/Vivaldi, test clipboard access and its fallback, and compare a real slow or quota-limited turn with the parent readout.
