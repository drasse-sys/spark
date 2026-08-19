# Spark — status og veikart

Sist oppdatert: 19. august 2026

---

## Gjort

- Kamera → bilde av leksa → veiledning på norsk
- Fire fagmoduser: Matte, Lesing, Annet, Quiz
- Talesyntese på norsk, med av/på og gjenles-knapp
- Stjerner, per barn
- Profil per barn: navn, alder, interesser — styrer språknivå og eksempler
- Læringsnotater som samles opp mellom økter (observasjoner, aldri merkelapper)
- Undervisningslogg foreldre kan lese
- Automatisk lagring — økta overlever feiltrykk, tilbakeknapp og krasj
- Arkiv over tidligere økter
- Avskrift av oppgaven, så bildet sendes bare én gang (sparer kvote)
- Reserve-tjeneste når Geminis dagskvote er tom
- Automatisk modellbytte når Google pensjonerer en modell
- PWA-filer klare for hosting

---

## Neste steg

### 1. Legg appen på nett — gjør denne først
Alt annet blir bedre av dette. Se `LES-MEG.md`.
Løser: installering, at ting forsvinner, offline, oppdateringer.
Tid: ~10 min på PC.

### 2. Test reserven før dere trenger den
Sett opp OpenRouter-nøkkel under ⚙️ mens alt fungerer.
Å oppdage at reserven ikke virker midt i matteleksa er dårlig timing.

### 3. Spør Olav om disse
- Ga Spark noen gang svaret rett ut når den ikke burde?
- Regnet den noe feil?
- Ble den kjedelig? Hvor?
- Sa den noe rart eller barnslig for en tiåring?

---

## Ideer, ikke bestemt

### Repetisjon over tid
Det ene forskningsfunnet som gir mest igjen: hent fram igjen gloser og
tallfakta etter 1 dag, 3 dager, 1 uke.

Men: dette er en annen app. Spark er en lekseøkt-app; repetisjon er en
femminutters daglig drill. Vurder først når Spark faktisk brukes jevnlig
i en måned. Bygger du planleggeren først, har du ingenting å planlegge.

### Tale inn
Ville løst det største hullet for seksåringen — han skriver for sakte til
å bruke Spark alene. Android har talegjenkjenning innebygd i nettleseren.
Verdt å prøve etter hosting.

Merk: dette gjør ikke at Spark kan vurdere høytlesing. Å høre om et barn
leser flytende er noe annet enn å gjøre om tale til tekst.

### Foreldre-oppsummering
Ukentlig: hva har barna jobbet med, hva sitter, hva sliter de med.
Dataene finnes allerede i loggen.

### Skriv-modus
Rettskriving og setninger. Krever egen pedagogikk — ikke bare en ny fane.

---

## Ting som er vurdert og valgt bort

**Capacitor / React Native.** Bygger en verktøykjede for å oppnå det PWA
allerede gir. Ingen gevinst her.

**Læringsstiler (visuell / auditiv / kinestetisk).** Godt undersøkt og
faller igjennom hver gang. Profilen holder på observasjoner
(«telling funket bedre enn tegning»), aldri merkelapper.

**Groq/OpenRouter som hovedtjeneste.** Gratismodellene der ser stort sett
ikke bilder, og kameraet er det beste med Spark. De hører hjemme som
reserve, ikke som hovedvalg.

**Poeng-konkurranse mellom barna.** Stjerner er per barn med vilje.
Sammenligning mellom søsken gjør noe annet enn å motivere.

---

## Verdt å huske

**Kvoten gjelder per Google-konto**, ikke per telefon. To barn på samme
nøkkel deler pott. En ekstra nøkkel på en annen konto er den enkleste
løsningen hvis det blir trangt.

**Gratis-nivået trener på det dere sender inn.** Greit for lekser.
Ikke fotografer ark med fullt navn og adresse.

**Seksåringen er ikke en soloburker.** Han leser og skriver for sakte.
Spark er en ting dere gjør sammen — og for en på seks er nok det bedre
uansett.

**Loggen finnes fordi modellen kan ta feil.** Et barn på seks fanger ikke
opp en feil forklaring. Les den innimellom.
