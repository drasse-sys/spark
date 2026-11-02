# Spark TR1 — Trusted Backup & Restore V1

Status: **PR candidate. Not merged, not deployed. No real `EXPORT_SIGNING_SECRET` has been created.**
Baseline: `main` at `3120ff3219e23028074715eb384e71301a32a391` (CF1 release).

## 1. Why
CF1 made every imported learning copy history only. Imported verification evidence has no authority, imports cannot create mastery, and skills are revalidated on the new device. That stops an arbitrary JSON file from creating verified mastery. It also means a family that moves Spark to a new phone loses verified learning state.

TR1 lets a copy that Spark itself exported, and that the family's Worker signed, keep its authority on restore. Everything else still takes the CF1 path unchanged: unsigned, legacy, edited, forged, unverifiable, and offline-unverified copies.

## 2. Exact security claim
> A signed Spark backup proves that an authenticated Spark installation (a holder of a valid device token for this family's Worker) requested a signature for this exact export digest at the Worker time `signedAt`, under key `kid`. It also proves that the payload has not changed since signing.

This gives trusted transport and restore integrity across devices under Spark's existing client trust model. The browser client stays inside the trusted application boundary.

**It does not prove:**
- that the child's answers originally happened, or that the local checker produced the evidence. The server never sees learning events.
- anything about a client that was modified before it asked for a signature. A device-token holder can get a signature for any digest, including one for a hand-written file. That holder can already write arbitrary mastery into the phone's own `localStorage`, so TR1 gives them no capability they lacked. What TR1 does stop is a file from anywhere else: files from outside the family, edited files, and files from other Spark deployments (each family runs its own Worker and key).

**It does not protect against:**
- a malicious user changing a compromised client before it requests a signature;
- theft of a valid signed backup. A signed backup is a **portable bearer artifact**: anyone who has the file can restore it, on any phone, as often as they like. The file is plaintext JSON, so it was already readable by whoever held it before TR1. TR1 does not change confidentiality. It only adds authority on restore;
- compromise of the Worker signing key. Whoever has `EXPORT_SIGNING_SECRET` can sign anything.

Under the privacy model in `BACKEND-SETUP.md` (data is local, each family hosts its own Worker, and backups are files the parent handles), bearer semantics are acceptable. No one-time server state was added.

## 3. Protocol and envelope (V1)
```
signed container (file "spark-laeringskopi-bekreftet.json")
{
  "schema": "spark-signed-backup-v1",
  "payload": "<the exact export text: JSON.stringify of the spark-learning-export-v3 object>",
  "signature": {
    "protocol": "SPARK-EXPORT-V1", "digestAlg": "SHA-256", "sigAlg": "HMAC-SHA-256",
    "kid": "k1", "signedAt": <Worker ms epoch>,
    "digest": "<base64url, unpadded, SHA-256 of UTF-8(payload)>",
    "mac":    "<base64url, unpadded, HMAC-SHA-256>"
  }
}
```
- **Exact bytes, no canonicalisation.** The payload is stored as a JSON *string*. Parsing the container gives back exactly the string that was hashed, so restore hashes the same bytes. Trust never comes from re-serialising parsed JSON. Reformatting the outer container does not change the payload.
- **Injective encoding.** UTF-8 encoding turns a lone surrogate into U+FFFD, so two different strings could share a digest. A payload with a lone surrogate is never trusted. `JSON.stringify` output never has one.
- **Digest syntax.** Exactly 43 base64url characters, and the last character must have its 2 spare bits at zero (`[AEIMQUYcgkosw048]`), so each 32-byte value has exactly one spelling.
- **Signed message (domain-separated, unambiguous):**
  `"SPARK-EXPORT-V1\nSHA-256\nHMAC-SHA-256\n" + kid + "\n" + signedAt + "\n" + digest`.
  Each field has a strict syntax with no newline (kid `^k[1-9][0-9]{0,2}$`, signedAt a decimal safe integer, digest as above), so a different field tuple cannot produce the same bytes. The device-token HMAC signs a base64url JSON blob under another secret, so the two are separated by key and by domain.
- **Primitives:** Web Crypto `SHA-256` in the browser, and Worker `crypto.subtle` HMAC-SHA-256 `sign`/`verify`. `subtle.verify` does the constant-time comparison. No custom cryptography.
- **Only the client computes the digest.** On restore, the client recomputes the digest from the payload. If it differs from `signature.digest`, the copy is marked *invalid* locally, before any network request. The Worker never sees the payload.

## 4. Endpoints
Both endpoints are CORS-restricted like `/chat` and `/pair`, use Spark-owned error text, have no logging, and never call a provider.

| | `POST /backup/sign` | `POST /backup/verify` |
|---|---|---|
| Auth | Device token (`Authorization: Bearer`), same check as `/chat` (signature, expiry, `REVOKE_BEFORE`) → 401 | None. It reveals one bit and no key material, so a new phone can restore before it is paired |
| Rate limit | `CHAT_LIMITER`, key `backup-sign:<deviceId>` (own counter) | `PAIR_GLOBAL_LIMITER` key `backup-verify`, `PAIR_LIMITER` key `backup-verify:<ip>` (own counters, so pairing keeps its budget) |
| Body | exactly `{v:1, digest}`; ≤ 512 bytes (streamed byte count) | exactly `{v:1, protocol, digestAlg, sigAlg, kid, signedAt, digest, mac}`; ≤ 1024 bytes |
| Extra keys | 400, so child data cannot be sent | 400 |
| Reply | `{protocol, digestAlg, sigAlg, kid, signedAt, digest, mac}` | `{valid:true}`, `{valid:false, reason:'signature'}`, or `{valid:false, reason:'key'}` for an unknown or retired kid |
| Secret missing / < 32 chars / reused | 503 `Bekreftede sikkerhetskopier er ikke satt opp på serveren.` | 503 (the phone shows "cannot confirm" and offers history only) |

The secret counts as **reused** if it equals `DEVICE_SIGNING_SECRET`, `FAMILY_CODE`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` or `GROQ_API_KEY`. A reused secret is treated as absent. Both export secrets are added to `redactSecrets`.

## 5. Key rotation (decision)
V1 uses an explicit key id and a bounded key ring: the **current** key (`EXPORT_SIGNING_SECRET`, id `EXPORT_SIGNING_KID`, default `k1`) and **at most one previous** key (`EXPORT_PREVIOUS_SECRET`, id `EXPORT_PREVIOUS_KID`). New signatures always use the current key. Verification picks the key by `kid`.

Rotation procedure (manual): put the old secret into `EXPORT_PREVIOUS_SECRET` with `EXPORT_PREVIOUS_KID=k1`, then set the new `EXPORT_SIGNING_SECRET` with `EXPORT_SIGNING_KID=k2`.

**Consequence, stated plainly:** a backup signed under a key that is no longer configured **cannot be verified**. Verify answers `reason:'key'`, and the phone treats that as "cannot confirm", not as "tampered". The copy still restores as **history only** (the CF1 path). No data is lost, but verified authority is lost for that file. To keep years-old backups verifiable, keep the old secret configured as the previous key. More than one previous key would need a small extension (for example a JSON map secret). That was left out on purpose.

`REVOKE_BEFORE` revokes device tokens, so it stops new signatures from those devices. It does not invalidate backups already signed.

## 6. Restore semantics
The client (`readLearningCopy`) builds the new profiles and decides trust **before** anything is committed. The parent always confirms. Only then are profiles appended and saved, and a failed save rolls back the in-memory list.

| Copy | Parent sees | Result |
|---|---|---|
| **Valid signed** (local digest matches, Worker `{valid:true}`) | "Denne sikkerhetskopien er bekreftet av Spark. …Ferdighetene beholdes." | Authority preserved (bounded, see §7) |
| **Unsigned / legacy** (`spark-learning-export-v3`) | "Denne kopien er ikke bekreftet av Spark. … som historikk? Ferdighetene bekreftes på nytt …" | CF1 quarantine, byte-for-byte the CF1 result (test 12 compares with the released function) |
| **Invalid / tampered** (payload edited, digest/MAC/kid/time changed, malformed envelope, extra container keys, lone surrogate, Worker `reason:'signature'`) | "Advarsel: Kopien er endret … kan bare legges til som historikk … som historikk?" (the parent must choose) | CF1 quarantine only if the parent accepts; otherwise nothing changes |
| **Verification unavailable** (offline, timeout, any non-200, malformed reply, `{valid:"true"}`, extra fields, Worker 503, retired kid, no valid server URL) | "Spark kunne ikke bekrefte kopien nå … Avbryt for å prøve igjen senere, eller legg til … som historikk nå" | Fail closed: CF1 quarantine if accepted; cancel leaves storage untouched |

Only an exact `200 {"valid":true}` counts as trusted. Nothing fails open.

**Export:** when the phone is paired and signing works, the file is `spark-laeringskopi-bekreftet.json`. If signing is unavailable (not paired, offline, secret missing, or a bad reply), the parent is asked, and only on yes downloads the unchanged unsigned format `spark-laeringskopi.json` (history only on restore). A backup is never impossible.

## 7. Authority preserved vs quarantined (signed path)
A signature does not override validation. A signed payload goes through **all** of the CF1 import checks: schema `v3`, at most 20 profiles, age 4–16, learning `version 3`, a known skill catalogue, and every evidence event replayed through `L.event`. Profile fields, notes, logs and archives are bounded as before. Then `L.normalizeMemory` applies the same bounds, enums, retention limits and clamping that native load uses. Finally the new `L.trust(memory, signedAt, now)` applies invariants that hold for any state `L.event` can produce:

- **Preserved** (as native normalized state): verified evidence `ev`, observations, `box`/`due`, `independentAt`, `firstColdAt`, `retainedAt`, `helped`, `seenObs`, totals (clamped `independentCold ≤ cold`), word schedule, non-imported sessions.
- **Quarantined per skill** (the CF1 operation on that record alone: evidence moves to `imported`, checkpoints are cleared, box drops to 1, due now): any time in evidence or checkpoints later than `signedAt + CLOCK_SKEW`; `due` beyond that plus the longest spacing; `box > 1` or any checkpoint with no verified evidence; `retainedAt`/`firstColdAt` without `independentAt`.
- **Per word:** a time after the signing bound resets that word to box 1, due now. **Per session:** a time after the bound marks the session `imported` (shown, never counted).
- History that the file already marks as `imported` is never promoted to evidence. Out-of-range events are dropped, not clamped into evidence. Unknown fields are dropped.

`signedAt` is the only trusted clock in the file, because it comes from the Worker. Evidence that claims to come after it cannot be the signed device's own state at signing time.

## 8. What the backup contains
The export allowlist is unchanged: `name, age, interests, notes, log, sessions, learning, readAloud`. The envelope adds only the seven signature fields. Tests 17 and the browser check confirm that neither the signed file nor the fallback file contains the device token or any part of it, the `spark_device_*` / `spark_server_url` keys, `Bearer`, the server URL, `EXPORT_SIGNING_SECRET`, `DEVICE_SIGNING_SECRET`, `FAMILY_CODE`, or provider keys.

## 9. Evidence
- `tests/tr1-trusted-backup.test.mjs` has 26 tests. They cover the 18 required cases, fail-closed secret handling, rotation, UX messages, and 7 **negative controls**. Each control removes exactly one trust check from the evaluated source (Worker MAC compare, domain separation, device auth, client local digest compare, fail-closed verifier, use of the verification result, normalization/invariants) and shows that the attack the matching test blocks then succeeds. A missing patch target fails the control, so a refactor cannot make it pass vacuously.
- `tests/browser-trusted-restore-check.mjs` (real Chromium, real page Web Crypto; `/backup/*` answered by the real Worker code in-process with a fixture secret) covers: signed export, digest parity between browser and Node, no secrets in the file, a digest-only sign request, signed restore on an unpaired phone keeping `SITTER`, a verify request with no credentials and no child data, a tampered payload caught locally without a request, a re-digested forgery refused by the Worker, a legacy unsigned file quarantined, verify offline (cancel leaves storage untouched, accept gives history only), and the export fallback when signing is unavailable. It runs in CI as its own step.
- The service-worker cache generation is now `spark-learning-20261102-tr1`.

## 10. Manual deploy steps (not run)
1. Generate a secret locally: `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
2. From `backend/`: `npx wrangler secret put EXPORT_SIGNING_SECRET` (it must differ from every other Spark secret and be at least 32 characters).
3. `npx wrangler deploy` from the merged branch.
4. Smoke test: export from a paired phone gives `spark-laeringskopi-bekreftet.json`. Restoring it on a second phone shows "Denne sikkerhetskopien er bekreftet av Spark." and keeps the skill states. Editing one character in the file gives the "Advarsel" prompt.

The package is safe before step 2: signing and verification answer 503, export offers the history-only copy, and restore uses CF1 quarantine.

## 11. Interaction with open PRs
- **drasse-sys/spark#3 (RH1)** touches `.github/workflows/ci.yml` (pins actions), `backend/src/index.js` (`GENERATION` constant, `/health`), `tests/worker.test.mjs`, `tests/live-check.mjs`, and `docs/RELEASE-CHECKLIST.md`. TR1 edits other regions of `index.js` and adds a CI step at the end of the file. Expect a clean or trivial merge. If RH1 lands first, its release convention asks for a `GENERATION` bump for a Worker-deploying release, which TR1 is.
- **drasse-sys/spark#4 (UX1)** touches `learning-ui.js` (other functions), `spark.html` (other lines), `sw.js` (the `CACHE` line, which **conflicts**), and `ci.yml` (adds a step at the same place, which **conflicts**). Resolution: keep both CI steps, and choose one new cache generation newer than both (for example `spark-learning-<date>-tr1ux1`).
- Merge order: either order works. The second PR to merge needs a trivial conflict resolution in `sw.js` and `ci.yml`, then a full CI rerun.
