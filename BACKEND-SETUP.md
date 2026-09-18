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
3. Lim inn Worker-adressen under **Privat Spark-server**.
4. Skriv familiekoden.
5. Trykk **Koble denne enheten**.
6. Lagre.

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

## 7. Hvis en telefon blir borte

Den enkleste fullstendige tilbakekallingen er å rotere `DEVICE_SIGNING_SECRET`. Da blir alle eksisterende telefoner logget ut og må pares på nytt. Provider-nøklene trenger ikke endres.

For senere versjoner kan vi legge til individuell enhetsliste/revokering uten å påvirke de andre telefonene.
