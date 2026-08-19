# Spark — installere som ordentlig app

Foreløpig kjører Spark som en fil i nettleseren. Det er derfor ting forsvinner:
Android åpner filen på en `content://`-adresse, og der er nettleserens lagring
upålitelig. Legger du filene på en ekte nettadresse, blir alt løst:
appen kan installeres, økter huskes, og den virker uten nett.

Alt er gratis og tar rundt ti minutter, én gang.

---

## Filene

| Fil | Hva den gjør |
|---|---|
| `spark.html` | Selve appen |
| `manifest.json` | Gjør den installerbar (navn, ikon, farger) |
| `sw.js` | Service worker — offline-støtte |
| `icon-192.png`, `icon-512.png` | Appikon |

Alle fire må ligge i samme mappe.

---

## GitHub Pages (anbefalt)

1. Opprett konto på **github.com** hvis du ikke har.
2. **New repository** → navn `spark` → **Public** → Create.
3. **Add file → Upload files** → dra inn alle fem filene → Commit.
4. **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main`, mappe `/ (root)` → Save.
5. Vent 1–2 minutter. Adressen blir:

   ```
   https://BRUKERNAVN.github.io/spark/spark.html
   ```

6. Åpne den adressen i **Chrome på telefonen**.
7. Meny (⋮) → **Installer app** (eller «Legg til på startskjerm»).

Nå ligger Spark som et ekte appikon, uten adresselinje.

**Merk:** repoet er offentlig, så ikke legg API-nøkkelen i filene.
Nøkkelen skrives inn i appen på telefonen og blir liggende der.

---

## Alternativ: Netlify Drop

Enda raskere hvis du ikke vil ha GitHub-konto:

1. Gå til **app.netlify.com/drop**
2. Dra mappa med alle fem filene inn i nettleservinduet
3. Du får en adresse med det samme

Ulempen er at adressen er tilfeldig og vanskelig å huske.

---

## Når du oppdaterer spark.html senere

Service workeren cacher gammel versjon. Åpne `sw.js` og øk tallet:

```js
const CACHE = 'spark-v4';   →   const CACHE = 'spark-v5';
```

Last opp begge filene. Appen henter da den nye versjonen.

---

## Om dagskvoten

Gratis-kvoten hos Google gjelder per **Google-konto**, ikke per telefon.
Har dere to barn som bruker Spark mye samtidig, kan én konto bli trang.
Du kan lage en API-nøkkel til på en annen Google-konto og bytte under ⚙️
hvis dere går tom midt i leksene.

Den nye versjonen bruker uansett langt mindre kvote enn før: bildet av
oppgaven sendes bare én gang, ikke på nytt for hver melding.
