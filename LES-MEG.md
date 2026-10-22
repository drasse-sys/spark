# Spark v5.3

Leksehjelper for barn som veileder i stedet for å gi ferdige svar.

## Læringskandidat C3 — 22. oktober 2026

Samlet A+B+C-kandidat: synlig hjelpestige, valgfri «Prøv selv», kontrollert regning, ferdighetsminne, korte øverunder og foreldreoversikt. Lesefølget støtter forståelse og gjenfortelling, med foreldrevalgt opplesing og usikre tekstforslag fra mikrofonen. Ingen poeng eller automatisk vurdering av uttale.

Samtaletekst beholdes i 30 dager. Ferdighetshendelser og øktoppsummeringer blir liggende lokalt. Innstillinger har læringskopi, gjenoppretting og sletting per barn; ingen automatisk synkronisering. Gamle profiler og koblede enheter beholdes ved migrering.

Kandidaten er ikke produksjonsdeployet. Implementasjon, testkommandoer, grenser og samlet kontrollert utrulling: `docs/2026-10-22-SPARK-C3-Learning-Evolution-A-B-C.md`.

## Nytt i v5.3

- Ingen Gemini/OpenRouter/Groq-nøkler på telefonen.
- Én privat backend kan deles av flere telefoner.
- Enheter pares med en familiekode én gang.
- Gamle API-nøkler fra v5.1 slettes automatisk fra browser storage ved første oppstart.
- Mindre repetitiv personalisering: Roblox/Minecraft/fotball osv. brukes bare når det faktisk hjelper forklaringen.
- Spark varierer eksempler mellom interesser, hverdagsliv, mat, penger, klokke, dyr, natur, bygging, sport, romfart og konkrete ting rundt barnet.
- Mer naturlig norsk samtalestil og mindre automatisk «Bra jobbet!».
- Ros er mer konkret og handler om strategi/innsats, ikke om at barnet «er flink».
- Ny stemmevelger viser de norske stemmene som faktisk finnes på den enkelte telefonen.
- Talehastighet og pitch er gjort mer nøytrale for mindre robot-/barne-TV-preg.
- Tale leser flere matte- og måleenhetssymboler naturlig.
- ✅ Ferdig med leksa lager fortsatt sluttoppsummering og arkiverer økten.

### Pedagogikken i v5.3
Spark tilpasser nå undervisningen etter observert forkunnskap, feiltype, støttebehov og hva som faktisk fungerte — ikke etter faste «læringstyper» eller personlighetsetiketter. Hjelpen fades gradvis ut når barnet mestrer mer. Spark bruker små doser metakognisjon og gjenhenting fra minnet, og kan modellere et kort eksempel tidlig når stoffet er helt nytt i stedet for å tvinge fram gjentatte bomforsøk.

## Viktig om flere telefoner

Tre telefoner kan bruke samme backend helt fint. Selve AI-tilgangen deles, men barneprofiler og tidligere økter er i v5.3 fortsatt lagret lokalt på hver telefon. Hvis samme barn bruker flere forskjellige telefoner, følger ikke historikken automatisk med ennå.

Se `BACKEND-SETUP.md` for oppsett uten API-nøkler på telefonene.

Stabiliseringspakken fra 22. oktober 2026 beholder versjonsnummeret. Den retter norsk stemmevalg, standard serveroppsett, gjenopptak av bildeøkter, profilskille, lagringsfeil og offline-cache. Tester og deploy-status er dokumentert i `docs/STABILIZATION-C2.md`.
