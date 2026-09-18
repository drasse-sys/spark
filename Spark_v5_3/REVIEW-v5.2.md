# Spark v5.2 — review og endringer

## Problem: samme interesse ble brukt for ofte

v5.1 instruerte modellen om å bruke barnets interesser aktivt i eksempler. Med Roblox i profilen gjorde dette Roblox til et standardeksempel nesten uansett faglig behov.

v5.2 beholder interessebasert personalisering, men gjør den sparsom og bevisst:

- samme interesse skal ikke brukes i to lærermeldinger på rad
- modellen skal se på de siste fire lærermeldingene før den velger en personlig referanse
- vanlig hverdagskontekst foretrekkes når den er like god eller bedre
- hobbyreferanser brukes bare når de faktisk gjør begrepet lettere

## Problem: samtalestilen kunne bli formelpreget

Nye språkregler reduserer gjentakende «Kjempebra», «Bra jobbet», «Hehe» og overdreven bruk av barnets navn. Kort, konkret prosessros brukes når barnet faktisk har brukt en god strategi.

## Problem: stemmen var unødvendig kunstig

v5.1 brukte rate 0.9 og pitch 1.1 og tok i praksis første norske stemme den fant.

v5.2:

- rate 0.96
- pitch 1.0
- prioriterer nb-NO og enhetens standardstemme
- håndterer `voiceschanged`
- lar forelder velge mellom norske stemmer installert på den aktuelle telefonen
- har en «Prøv stemmen»-knapp
- sier prosent, kroner, centimeter, millimeter, kilo, desiliter og liter mer naturlig

## Problem: API-nøkler på telefonen

v5.2 er server-only. Gamle provider-nøkler slettes fra localStorage ved migrering. Frontenden har ingen felt for Gemini/OpenRouter/Groq-nøkler.

Cloudflare Worker:

- lagrer provider-nøkler som Secrets
- parer hver telefon med familiekode og et HMAC-signert enhetstoken
- begrenser chat til 30 requests/minutt per enhet
- begrenser paring til 6 forsøk/minutt per IP
- begrenser tillatte web-origins
- validerer størrelse og form på forespørsler
- holder Gemini-modell-fallback server-side
- kan bruke OpenRouter/Groq som tekstreserve ved dagskvote

## Ikke bygget i v5.2

- synk av barneprofiler og historikk mellom telefoner
- individuell liste/revokering av parede enheter
- Gemini cloud TTS / Live voice

De to første passer naturlig i backend senere. Cloud TTS er bevisst utsatt fordi gratis device-TTS er enklere, raskere og ikke bruker ekstra AI-kvote.
