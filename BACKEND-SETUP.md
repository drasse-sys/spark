# Spark v5.3 — privat backend uten API-nøkler på telefonene

Spark v5.3 bruker én liten Cloudflare Worker mellom telefonene og Gemini.
API-nøklene lagres som Cloudflare Secrets og sendes aldri til telefonene.

## Resultatet

- Samme backend kan brukes av 3 telefoner (eller flere).
- Hver telefon pares én gang med en familiekode.
- Familiekoden lagres ikke i Spark etter paring.
- Telefonen får et begrenset enhetstoken som bare gir tilgang til Spark-serveren.
- Gemini/OpenRouter/Groq-nøkler finnes bare på serveren.
- Chat er begrenset til 30 kall/minutt per paret enhet.
- Paring er begrenset til 6 forsøk/minutt per nettadresse/IP.
- Alle telefoner deler i tillegg en grense på 40 chat-kall/minutt og 20 koblingsforsøk/minutt.
- Produksjonsserveren `https://spark-family-api.drasse.workers.dev` er standard i appen. Ingen hemmeligheter ligger i adressen.

> Profiler, stjerner, lærehistorikk og tidligere økter ligger foreløpig lokalt på hver telefon. De synkroniseres ikke mellom telefonene i v5.3.

## 1. Host Spark som vanlig

Legg `spark.html`, `manifest.json`, `sw.js` og ikonene på GitHub Pages eller en annen HTTPS-side.
Noter origin-adressen, for eksempel:

`https://brukernavn.github.io`

Hvis Spark ligger på `https://brukernavn.github.io/Spark/spark.html`, er origin fortsatt `https://brukernavn.github.io`.

## 2. Klargjør Worker

Åpne PowerShell i mappen `backend`:

```powershell
npm install
npx wrangler login
```

Åpne `wrangler.toml` og endre:

```toml
ALLOWED_ORIGINS = "https://YOUR-GITHUB-USERNAME.github.io"
```

til den faktiske Spark-origin-adressen.

## 3. Lag tre hemmeligheter

Du trenger:

- `GEMINI_API_KEY` — Gemini-nøkkelen.
- `FAMILY_CODE` — en privat familiekode du bruker én gang på hver telefon. Bruk helst minst 10–12 tegn.
- `DEVICE_SIGNING_SECRET` — en lang tilfeldig streng som signerer telefonenes enhetstoken.

En enkel måte å lage de to siste på hvis Python er installert:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(18))"
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Første resultat kan brukes som `FAMILY_CODE`, andre som `DEVICE_SIGNING_SECRET`.

Opprett deretter en fil kalt `.env.production` i `backend`-mappen:

```text
GEMINI_API_KEY=din_gemini_nokkel
FAMILY_CODE=din_familiekode
DEVICE_SIGNING_SECRET=din_lange_tilfeldige_signeringshemmelighet
```

Filen er allerede ignorert av Git. Ikke legg den i GitHub.

## 4. Deploy

Fra `backend`-mappen:

```powershell
npx wrangler deploy --secrets-file .env.production
```

Wrangler skriver ut Worker-adressen, omtrent:

`https://spark-family-api.<konto>.workers.dev`

Når deployen er ferdig kan du slette `.env.production` lokalt hvis du vil. Cloudflare beholder verdiene som krypterte Secrets.

## 5. Koble telefonene

På hver telefon:

1. Åpne Spark.
2. Trykk ⚙️.
3. Skriv familiekoden.
4. Trykk **Koble denne enheten**.
5. Lagre.

Vanlige familietelefoner trenger ikke skrive serveradressen. En annen server kan settes under **Avansert: serveradresse** for utvikling/testing. HTTPS kreves, bortsett fra lokal testing på localhost.

Gjør det samme på Olavs telefon, lillebrors telefon og eventuell foreldremobil. API-nøklene skal aldri skrives inn på telefonene.

## 6. Valgfri reserve

Gemini er standard. Hvis du vil ha reserve ved faktisk dagskvote, kan Worker også bruke OpenRouter eller Groq.

I `wrangler.toml`, sett én av:

```toml
BACKUP_PROVIDER = "openrouter"
```

eller:

```toml
BACKUP_PROVIDER = "groq"
```

OpenRouter bruker som standard `openrouter/free`, som velger blant tilgjengelige gratismodeller. Groq bruker `openai/gpt-oss-120b`.

Legg den aktuelle nøkkelen inn som Cloudflare Secret, ikke i `wrangler.toml`:

```powershell
npx wrangler secret put OPENROUTER_API_KEY
```

eller:

```powershell
npx wrangler secret put GROQ_API_KEY
```

## 6b. Valgfritt: bekreftede sikkerhetskopier (TR1)

Uten denne hemmeligheten fungerer alt som før: læringskopier lastes ned ubekreftet og gjenopprettes som historikk, og ferdighetene bekreftes på nytt på den nye telefonen.

Med hemmeligheten blir kopien fra en paret telefon bekreftet av Spark-serveren. Den kan da gjenopprettes med ferdighetsnivåene i behold på en ny telefon. Bekreftelsen gjøres alltid av serveren som er bygd inn i appen (`DEFAULT_SERVER_URL`), aldri av en adresse fra innstillingene. Bruker familien sin egen kopi av appen, må den adressen peke på familiens egen Worker. Serveren får bare et sjekksum-fingeravtrykk av kopien, aldri selve innholdet.

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
npx wrangler secret put EXPORT_SIGNING_SECRET
```

Bruk en ny, lang verdi (minst 32 tegn) som ikke er lik noen annen Spark-hemmelighet. Ta vare på den. Bytter du den uten å beholde den gamle som `EXPORT_PREVIOUS_SECRET` (med `EXPORT_PREVIOUS_KID`), kan eldre kopier bare gjenopprettes som historikk, og de vises som «endret». Ved bytte: legg den gamle verdien i `EXPORT_PREVIOUS_SECRET` med `EXPORT_PREVIOUS_KID=k1`, og sett den nye med `EXPORT_SIGNING_KID=k2`. En bekreftet kopi er som en nøkkel til barnets læringshistorikk. Alle som har filen kan gjenopprette den, så oppbevar den like trygt som andre private filer. Detaljer: `docs/2026-11-02-SPARK-TR1-Trusted-Backup-Restore.md`.

## 7. Hvis en telefon blir borte

Den eksisterende `REVOKE_BEFORE`-innstillingen kan tilbakekalle alle token utstedt før et valgt tidspunkt (epoch-millisekunder). Eldre token uten `iat` blir også avvist når grensen er satt. Token som utstedes etter grensen fortsetter å fungere. Dette krever en bevisst serverendring av forelderen; vanlig oppdatering av Spark krever ingen endring av hemmeligheter.

For senere versjoner kan vi legge til individuell enhetsliste/revokering uten å påvirke de andre telefonene.

## Stabiliseringskandidat 22. oktober 2026

Installer den låste deploy-verktøyversjonen med `npm ci` i `backend`. Wrangler 4.152.0 forstår den eksisterende `[secrets].required`-konfigurasjonen; 4.36.0 ignorerer den med en advarsel.

Eksisterende Cloudflare Secrets beholdes ved vanlig `npm run deploy`. Ikke opprett eller hent hemmeligheter for denne oppdateringen. Etter deploy viser `/health` (med godkjent Origin-header) `generation: c2-20261022`. Se `docs/STABILIZATION-C2.md` for verifikasjon og hva som fortsatt må prøves på telefon.

## Læringskandidat C3 (ikke deployet)

Neste samlede kandidat bruker `generation: c3-20261022` og `promptVersion: v5.4-c3`. Worker importerer den delte `../arithmetic.js` fra prosjektroten (relativt til backend-mappen); behold hele prosjektstrukturen ved bygging. Ingen nye bindings eller secrets er nødvendige.

Rull ut hele A+B+C samlet etter gjennomgang: Worker, `spark.html`, de fire nye JavaScript-filene og oppdatert `sw.js`. Ikke publiser bare én pakke. `node tests/live-check.mjs --require-worker-candidate` kontrollerer alle ti offentlige filer og Worker-generasjonen etter utrulling, uten token eller AI-kall. Kjør den først når kandidaten faktisk er publisert.
