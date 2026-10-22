# Spark S7 — Learning-Science Product Blueprint

Date: 2026-10-22
Role: learning-science research + product architecture (no implementation)
Baseline: `Spark-v5.3-complete/Spark_v5_3`, prompt `v5.3-r2`, Worker generation `c2-20261022` (see `docs/STABILIZATION-C2.md`)
Status: design proposal. Nothing in this document is implemented, accepted or deployed.

---

## 0. How to read this document

Evidence labels used throughout:

| Label | Meaning |
|---|---|
| **STRONG** | Multiple meta-analyses / systematic reviews or well-powered RCTs agree, and the population is reasonably close to primary-age children. |
| **PROMISING** | Positive RCT or meta-analytic evidence, but with a population gap (older learners, lab settings), a single trial, or unreviewed working papers. |
| **INFERENCE** | A design conclusion reasoned from stronger evidence plus Spark's specific constraints. Not directly tested. |
| **SPECULATIVE** | A plausible idea with no direct evidence. Only allowed where cheap and reversible. |

Source references to current code use `file:line` against the baseline. Where I relied on an abstract or secondary summary rather than the full paper, the evidence register (§15) says so.

---

## 1. Executive conclusion

Spark's current pedagogy is already better than most commercial AI tutors. It refuses to hand over answers, scaffolds gradually, distinguishes slips from misconceptions, avoids learning-style labels and is honest about not being able to hear a child read. **The prompt is not the main problem.**

The main gap is that **Spark cannot see whether the child is becoming less dependent on it.** Today Spark records:

- free-text parent log lines with a date but no time (`spark.html:518`),
- free-text "what helped" notes (`spark.html:527-535`),
- an LLM-awarded star counter (`spark.html:551-553`),
- up to eight archived transcripts (`spark.html:430-438`).

It records nothing about **how much help each success needed**. Nothing checks whether a skill is still there days later without help. "Fade support after mastery" exists only as a prompt instruction (`backend/src/index.js:211-212`). Nothing measures it.

The strongest new evidence makes this gap the central design issue:

- **Unguarded AI help can harm later unaided performance.** In a field experiment with about 1,000 students, an unrestricted GPT-4 tutor raised practice grades by 48% but lowered unaided exam grades by 17%. A guard-railed tutor raised practice grades by 127%, yet **only matched the control group on the exam** (Bastani et al., PNAS 2025). Help during practice is not learning.
- **In-session mastery is not durable learning.** In a 2026 trial with over 6,000 students, AI help was most useful just after errors. Hitting "three correct in a row" during a session did not, on its own, improve delayed learning (Oreopoulos et al., NBER w35621, working paper). This is the long-established learning/performance distinction (Soderstrom & Bjork, 2015).

**Blueprint thesis:** Spark should become a *closed-loop independence tutor*. It needs four things:

1. Spark **measures support level** on every task (S0 unaided → S4 fully modelled).
2. Every task ends with **one small unaided "Prøv selv" item**, and later sessions open with **optional unaided cold checks** of earlier skills. These give Spark evidence of independence and retention.
3. A **small, skill-specific evidence memory** records *observed performance at a support level over time*. It records nothing about personality. Spark uses it to fade help across sessions, and the parent view uses it to show "can now do alone".
4. **Deterministic code** handles everything that must be exactly right or exactly repeatable: arithmetic correctness, item generation for core number skills, review scheduling, visual manipulatives and parent statistics. The LLM handles dialogue, diagnosis and explanation.

The primary success metric becomes **Delayed Independent Success (DIS)**: the share of cold checks, at least one day after the skill was last practised, that the child solves at support level S0–S1. A secondary metric is the trend in median support level per skill. Time-in-app is explicitly *not* a success metric. It is a guardrail that should stay flat or fall.

The recommended next implementation package is **Package A, "Selvstendighetsløkka" (the independence loop)** (§14).

---

## 2. Evidence-backed design principles

| # | Principle | Evidence | Label |
|---|---|---|---|
| P1 | **Optimise for delayed, unaided performance, not in-session success.** Performance during supported practice is a poor and sometimes inverted signal of learning. | Soderstrom & Bjork 2015 (learning vs performance review); Bastani et al. 2025 PNAS; NBER w35621 (2026 WP) | STRONG (principle) / PROMISING (AI-specific) |
| P2 | **Give the least help that works, and withdraw it.** Use hint ladders with a bottom-out guard. Learners who are novices with the material benefit from worked examples. Learners with more expertise benefit from problem solving (expertise reversal). | VanLehn 2011; Kalyuga 2007; Renkl & Atkinson 2003 (fading); Barbieri et al. 2023 worked-example meta g = 0.48 | STRONG |
| P3 | **Hint abuse is real. Mild friction on fast bottom-out help is justified, but not for children who avoid asking.** | Aleven et al. 2006 (help abuse on ~36% of actions in a geometry tutor); gaming-the-system literature (Baker et al.); delayed hints may help those who game | PROMISING |
| P4 | **Retrieval beats re-exposure, and spacing beats massing.** Retrieval should be short, low-stakes and spread across days. | Adesope et al. 2017; Agarwal, Nunes & Blunt 2021 (50 classroom experiments; mostly secondary and university); Cepeda et al. 2006; distributed maths practice in grade 3 (Kassel study; benefit visible at 1-week test) | STRONG (general) / PROMISING (primary age) |
| P5 | **Interleave related problem types in review.** Do not interleave during first learning. | Rohrer et al. 2020, grade 7 cluster RCT, d ≈ 0.83 at 1 month (WWC: meets standards) | STRONG for grade 7 / INFERENCE for younger |
| P6 | **Feedback should be about the task, the process and self-regulation, never about the person.** Many feedback interventions *reduce* performance. | Kluger & DeNisi 1996; Hattie & Timperley 2007; Wisniewski, Zierer & Hattie 2020 (d = 0.48, highly heterogeneous); Mueller & Dweck 1998; Cimpian et al. 2007 | STRONG |
| P7 | **Expected, contingent tangible rewards undermine intrinsic motivation. Informational verbal feedback does not.** | Deci, Koestner & Ryan 1999 meta-analysis | STRONG |
| P8 | **Small, real choices support autonomy. Too many choices do not.** | Patall, Cooper & Robinson 2008 meta-analysis (choice effects); SDT intervention meta-analyses | PROMISING–STRONG |
| P9 | **Teach metacognition explicitly but in small doses, tied to the task.** | EEF Toolkit: metacognition ≈ +8 months (2025 update); Dignath & Büttner 2008 (primary-age effects) | STRONG |
| P10 | **Concrete → representation → abstract, with the representation explicitly linked and then faded.** | EEF early maths / KS2 guidance; Carbonneau et al. 2013 manipulatives meta-analysis (d ≈ 0.37, moderated by instruction); Siegler & Ramani 2008 (number line) | STRONG |
| P11 | **Reading = decoding × language comprehension.** Fluency needs a human or a reliable listener. Comprehension strategies can be coached in text. | Simple View of Reading (Gough & Tunmer); EEF KS1/KS2 literacy guidance; NRP 2000 (guided repeated oral reading) | STRONG |
| P12 | **Children's self-monitoring is immature and usually overconfident. It can be trained with feedback on calibration.** | Roebers and colleagues (multiple studies of ages 6–12) | PROMISING |
| P13 | **Explaining to someone (teach-back) produces learning, especially when the exchange is interactive.** | Kobayashi 2019 meta-analysis: g = 0.35 for preparing to teach, g = 0.56 for teaching; mostly older learners | PROMISING for children |
| P14 | **Parents help most by supporting autonomy. Control and content-teaching help little or harm.** | Three-level meta-analysis of parental homework involvement: overall r = −0.064, autonomy support positive; Pomerantz, Moorman & Litwack 2007; Moroni et al. 2015 | STRONG (direction) |
| P15 | **Children's data, emotional inference and companion-like AI need special restraint.** | UNICEF Guidance on AI and Children v3 (2025); EU AI Act Art. 5(1)(f) bans biometric emotion inference in education institutions; Common Sense Media 2025 (AI companions "unacceptable" for minors) | STRONG (normative) |
| P16 | **Learning styles are not a basis for instruction.** | Pashler et al. 2008; APA 2019 summary (already cited in `PEDAGOGIKK-v5.3.md`) | STRONG |
| P17 | **For two children, a transparent simple model beats a sophisticated learner model.** Choosing the threshold and the *data source* matters more than choosing the modelling technique. | Pelánek & Řihák 2017/2018 (mastery criteria analyses) | PROMISING → INFERENCE |

---

## 3. Audit of Spark's current pedagogy

The source was inspected directly: `backend/src/index.js` (`buildSystemPrompt`, lines 150–366) and `spark.html` (harvest, archive, quick buttons, finish flow, speech). The current source is **consistent with the accepted baseline**: prompt `v5.3-r2`, generation `c2-20261022`, R2 server-owned prompt and the eight-note cap are all present. No stop condition was triggered.

### 3.1 KEEP

| Behaviour | Where | Why |
|---|---|---|
| Never gives the final answer in homework/maths modes; hint ladder before modelling | `index.js:209, 225-233, 243, 316-318` | P2. This is the guardrail that, in Bastani et al., kept the guard-railed tutor from causing the harm the unrestricted tutor caused. |
| Adaptive choice between "try first" and "model first" for genuinely new material | `index.js:205-207` | Expertise reversal; worked examples g = 0.48. |
| Diagnoses slip vs fact vs method vs misconception; slips get "check the last step" | `index.js:208, 251-257` | P6: specific task-level feedback. Treating slips as misconceptions wastes effort and is demoralising. |
| Explicit ban on learning-style and personality labels; notes are hypotheses | `index.js:194-202, 330-333, 338-346` | P16. Already aligned with the evidence. |
| Process praise only, no default "Bra jobbet!", one question per turn | `index.js:171-180, 190-192` | P6/P7. |
| Selective self-explanation ("only when it reveals understanding") | `index.js:213-215` | Barbieri 2023 found that adding self-explanation prompts to worked examples was a *negative* moderator. Selective use is right. |
| Honest reading limitation: "I can't hear you read" | `index.js:269-272` | Prevents fake fluency feedback (see §7). |
| Text vs inference distinction and "where does it say that?" in reading | `index.js:274-286` | Strong comprehension practice (EEF). |
| Do not stop at every unknown word; explain briefly when context is weak | `index.js:288-291` | Matches the vocabulary evidence. |
| Quiz mode gives the answer with an explanation after the ladder | `index.js:304-310` | In general-knowledge mode, holding back the answer has no learning payoff. |
| Shorter turns and an assumed adult for age ≤ 7 | `index.js:159-163` | Matches the cognitive load of young readers. |
| Image → transcript → text-only continuation | `index.js:348-351`, `spark.html:364-375` | Saves quota and improves privacy, because the image is not re-sent. |
| Interests used occasionally as a bridge, with anti-repetition rules | `index.js:322-329` | Context personalisation is PROMISING (Walkington; Høgheim & Reber 2015 in Norwegian lower-secondary). Overuse becomes noise. |
| Server-owned prompt; client sends structured fields only | `index.js:115-149` (R2) | Prevents Spark from becoming an open general chatbot (§12). |

### 3.2 IMPROVE

| Issue | Where | Problem | Direction |
|---|---|---|---|
| **No support-level measurement** | entire flow | "Fade help after mastery" cannot be checked or carried across sessions. | Instrument S0–S4 per task (§4.2). |
| **`sessionState` is a dead channel** | validated at `index.js:122-123`, always sent as `''` at `spark.html:495`, never put into the prompt | The R2 contract already reserves 300 sanitised characters, but the prompt ignores them. | Use it for skill context ("skill X: SUPPORTED, last helped: number line") so fading can carry across sessions. Needs only a prompt-template change plus a client change. |
| **Arithmetic correctness relies on the LLM checking itself** | `index.js:245-249` | "Regn alltid ut selv" is a request, not a guarantee. A wrong "riktig!" teaches a wrong fact and damages trust. | Deterministic verifier (§6.1). |
| **Retrieval only within a session** | `index.js:216-217` | Retrieval inside the same session is barely spaced, so Spark loses most of the benefit. | Cross-session cold checks from skill memory (§5). |
| **Transfer step is optional and unmeasured** | `index.js:222-223` | This is the most direct independence evidence Spark could collect. | Make "Prøv selv" a standard, short and unaided end-of-task step (§4.3). |
| **Help buttons are flat** | `spark.html:877-894` | "Gi meg et hint" does not say *how much* help. In quiz mode, "Vis svaret" jumps straight to the bottom. | Make the help ladder explicit in the UI, with a soft bottom-out guard (§4.4). |
| **Metacognition is not dosed by age** | `index.js:218-219` | "Hva gjør du først?" is fine at 9 but abstract at 6. | Age ≤ 7: checking only, as concrete actions. Age 8+: plan for multi-step tasks, plus a one-tap end-of-session reflection (§9). |
| **Parent log has no time, duration or support information** | `spark.html:512-521, 432` | Parents cannot see when, for how long, or with how much help. | Timestamps and active duration (§10). |
| **PROFIL notes are not tied to skills** | `spark.html:527-535` | "tosifret pluss: tierramme ga selvstendig neste steg" is good, but it floats free, the 12-note cap pushes old notes out, and Spark cannot retrieve notes by skill. | Attach "what helped" to a skill record (§5). |
| **Persona wording** | `index.js:156` "læringsvenn" | Fine, but there is no guard against companion-like dependency ("I missed you") or claiming feelings. | Add an explicit rule: Spark is a learning helper and does not claim feelings or friendship (§12). |
| **"Bra jobbet!" on finishing** | `spark.html:1024` | Contradicts the prompt's own rule at `index.js:175`. Minor. | Use a neutral or process wording, for example "Økten er lagret. Du jobbet deg gjennom X oppgaver." |
| **Mic input disclosure** | `spark.html:1032-1056` (`webkitSpeechRecognition`, `nb-NO`) | In Chrome-based browsers, Web Speech recognition is typically processed by a cloud service. The child's voice may leave the device. | Tell parents in setup. Do not widen use of the mic to reading assessment. |

### 3.3 REMOVE / AVOID

| Item | Where | Why |
|---|---|---|
| **⭐ POENG cumulative star counter, awarded by the LLM** | prompt `index.js:235-237`; harvest `spark.html:551-553`; header `spark.html:126` | It contradicts the project's own `TODO.md` ("Bevisst ikke prioritert: Poengtavler…"). It is an expected, performance-contingent reward (P7). The LLM awards it inconsistently, so it is unfair. With two siblings it invites comparison. It rewards *correctness*, not *independence*. **Replace** it with deterministic "Klarte selv" evidence (§8). Keep no running total in the header. |
| Any move toward fixed traits ("visuell", "utålmodig") | already banned | Keep it banned. Also ban storing affect ("was frustrated on Tuesday"). |
| Within-session "quiz regime" | — | Retrieval belongs at the start of the *next* session and should take minutes. |

---

## 4. Recommended learning model

### 4.1 The loop

```
 ┌─ (optional) Warm-up: 1–3 cold checks from review queue, unaided ─┐
 │                                                                   │
 ▼                                                                   │
 Task from homework (photo / text)                                   │
   1. Activate: try first OR short model (by skill state + novelty)  │
   2. Diagnose: interpretation / fact / method / concept / slip      │
   3. Minimum useful support: S1 → S2 → S3 → S4                       │
   4. Child completes the meaningful part                             │
   5. "Prøv selv": one near-transfer item, unaided (S0 target)       │
   6. Record skill event (skill, max support, outcome, error type)   │
 ▼                                                                   │
 End of session: one-tap reflection ("hva hjalp?") → parent summary  │
 ▼                                                                   │
 Scheduler updates review dates ─────────────────────────────────────┘
```

### 4.2 Support-level scale (the core measurement)

| Level | Name | Definition (observable) |
|---|---|---|
| **S0** | Selv | Correct with no Spark content help (encouragement or "send it" does not count). |
| **S1** | Puff | Attention or check prompt only: "sjekk siste ledd", "les oppgaven en gang til". No strategy content. |
| **S2** | Hint | A strategy hint: "prøv å dele opp 38 i 30 og 8". |
| **S3** | Stillas | The task was broken into steps, or a partial worked example was given. |
| **S4** | Modellert | Spark modelled the full method or showed the answer, and the child completed only the last bit. |

**How it is measured** (deterministic first, LLM second):

- The client records help-button presses (each rung of the explicit ladder maps to S2/S3/S4) and "Vis svaret" (S4).
- The LLM emits one hidden marker per completed task: `[[STØTTE: S0–S4 | ferdighet-id | utfall: riktig/feil | feiltype]]`.
- The client stores `max(client level, LLM level)`. The LLM can only *raise* the level above what the buttons show, never lower it. This protects the metric from an over-optimistic model.

**Evidence:** INFERENCE, built on STRONG scaffolding and fading evidence. Support level is the operational form of "independence". It is what the product principle needs to measure.

### 4.3 "Prøv selv" (independent near-transfer)

After a homework task is completed, Spark offers one item that looks slightly different and asks for it unaided ("Nå prøver du en helt selv — jeg hjelper ikke på denne."). Rules:

- One item. Skippable. Never when the child is visibly stuck or tired, or when the homework set is long.
- For skills with a deterministic generator (core arithmetic, clock, money), the item and answer key come from code. Spark needs zero LLM calls to generate or check them.
- For other skills, the LLM proposes the item inside the same reply (`[[PRØV: …]]`), so no extra call is needed. Checking the child's answer uses the normal next turn.
- If the child fails, Spark gives *one* S1 nudge and then debriefs. It does not start a new ladder. The event is recorded honestly.

**Evidence:** retrieval and transfer practice (STRONG). Single-item unaided checks as independence evidence (INFERENCE).

### 4.4 Explicit help ladder in the UI

Replace the flat "Gi meg et hint" with a ladder the child can see:

`💡 Lite hint` → `🪜 Mindre steg` → `👀 Vis meg et eksempel`

- The next rung unlocks after the previous one is used, or after one attempt. Rungs are never time-locked.
- **Soft bottom-out guard (age ≥ 8):** before the first attempt on a task, the first tap shows "Prøv ett steg først? Skriv hva du tror — det er lov å bomme." with a second tap that proceeds anyway. Age ≤ 7 gets no friction, because help avoidance is the bigger risk at that age and an adult is assumed present.
- "Jeg vet ikke" stays. It means the child is stuck, not hint-hunting, and goes straight to S2 or S3.
- Add a child-controlled **"Pause / for vanskelig"** button. Spark then lowers demand immediately (one quick success, then offer to stop). This is *self-report*, so Spark does not have to *infer* frustration (§12).

**Evidence:** PROMISING (help-abuse and gaming literature) combined with INFERENCE for age split.

### 4.5 Fading across sessions

The skill state (§5) is passed through `sessionState` to steer the opening move:

| Skill state | Opening move |
|---|---|
| NY | Short model or worked example is allowed if the material is new (`index.js:205-207` already permits this). |
| ØVER | Try first, with S2 available quickly. Reuse "what helped last time". |
| MED_STØTTE | Try first. Start the ladder at S1, not S2. |
| SELVSTENDIG / SITTER | "Du har klart denne før — prøv selv." Spark says nothing until the child answers. |

### 4.6 Teach-back ("Forklar for Spark") — sparingly

Once per session at most, and only after an S0–S1 success, Spark may say: "Kan du forklare for meg hvordan du gjorde det? Jeg later som jeg ikke kan det." For age ≤ 7, the answer can be oral (via the mic) or "vis med fingrene / tegn". The better version is *teach a parent* (§10): it is interactive, it is human, and it avoids loading the AI with more dialogue.

**Evidence:** PROMISING (Kobayashi 2019: g = 0.56, larger when interactive; mostly older learners).

---

## 5. Recommended mastery-memory model

### 5.1 Verdict on the proposed states

The suggested NEW / LEARNING / SUPPORTED / INDEPENDENT / REVIEW_DUE is close but mixes two different things:

- **REVIEW_DUE** is a *scheduling attribute*, not a knowledge state. A skill can be INDEPENDENT *and* due.
- It has **no state for "still independent after a delay"**. The evidence (P1, NBER w35621) says that delayed state is what matters. Without it, in-session success gets promoted to "mastered".

### 5.2 Recommended model: evidence log + derived state + Leitner schedule

**Store events, derive state.** The LLM never writes a state, only events. Code computes the state deterministically, so it is auditable and resettable.

**Skill record (per child, local storage):**

```json
"skills": {
  "add_tierovergang_2": {
    "ev": [ {"t": 1761150000000, "s": 2, "ok": true,  "k": "task",     "e": ""},
            {"t": 1761150300000, "s": 0, "ok": true,  "k": "prøv",     "e": ""},
            {"t": 1761409500000, "s": 0, "ok": false, "k": "cold",     "e": "slurv", "c": "sikker"} ],
    "box": 2,
    "due": 1761668700000,
    "helped": "tallinje"
  }
}
```

- `k` is the event kind: `task` (homework), `prøv` (end-of-task transfer), `cold` (delayed check).
- `s` is support level 0–4, `e` the error type, `c` the optional confidence rating (age ≥ 8).
- `helped` holds *one* strategy that produced an S0–S1 success. This replaces free-floating PROFIL notes for skills that are in the catalogue.
- Caps: 8 events per skill, about 80 skills per child. That is roughly 20 KB, which fits easily in `localStorage`.

**Derived state:**

| State | Rule (computed) | Meaning to show the child or parent |
|---|---|---|
| **NY** (new) | No events | — |
| **ØVER** (learning) | Latest outcome needed S3–S4, or was wrong | "Øver på" |
| **MED_STØTTE** (supported) | Latest success at S2 | "Klarer med et hint" |
| **SELVSTENDIG** (independent today) | Latest success at S0–S1, but not yet on a delayed check | "Klarte selv" |
| **SITTER** (retained) | An S0–S1 success on a `cold` check at least 1 day after the last instructed event, **and** another at least 7 days later | "Sitter" |

**Review schedule (Leitner, deterministic):**

- Box 1 → due after 1 day; box 2 → 3 days; box 3 → 7 days; box 4 → 21 days; box 5 → about 60 days (occasional sampling only).
- S0–S1 success on a cold check moves the skill up one box. S2 keeps it in the same box. S3–S4 or a wrong answer moves it down one box (gentle; never back to box 1 for a single slip).
- A correct answer tagged "gjetter" (guessing) does not move the skill up.
- A skill enters the queue (box 1) only after it has an S0–S2 success. Spark does not review things the child never did.
- Session warm-up offers at most 3 due items, interleaved across skills, and takes about 2–5 minutes. It is **always optional**.

**Why not BKT / DKT / FSRS?** Two children and a few dozen skills give far too little data to fit parameters. A transparent rule that the parent can read and reset is more valuable. Pelánek's mastery-criteria work found that the data source and threshold matter more than the model. Here the key choice is the data source: *delayed unaided* attempts. (PROMISING → INFERENCE.)

**Confidence calibration (age ≥ 8, cold checks only):** before seeing the result, the child taps 👍 sikker / 🤷 litt usikker / 🎲 gjetter. Spark then gives brief calibration feedback: "Du var sikker og hadde rett", or "Du gjettet og fikk det til — kanskje du kan mer enn du tror". This trains monitoring (PROMISING: Roebers et al.) and keeps lucky guesses from promoting a skill. Under age 8 it is not used, because 6–7-year-olds discriminate poorly and the tap adds load.

### 5.3 Skill catalogue (versioned, static, in the app)

The LLM chooses from a **closed list** of IDs. The client validates the ID and stores an unknown one as `annet` with no review. This prevents skill names fragmenting ("plussing med tier", "tierovergang pluss" and so on). Catalogue v1 is small (about 30–40 skills), grounded in LK20 grades 1–4 and **in the children's actual homework**, not the full curriculum:

- **Number:** tall 0–20 / 0–100 / 0–1000 (plassverdi), tallvenner 10 / 100, dobling–halvering
- **Add/sub:** without/with regrouping (1- and 2-digit), standard written method
- **Mult/div:** gangetabell 2-5-10 / 3-4 / 6-9, deling som likedeling / målingsdivisjon
- **Fractions:** del av helhet, brøk på tallinje, sammenligne brøker
- **Measure:** klokke (hel/halv/kvart/minutter, analog ↔ digital), penger (telle, veksle), lengde
- **Problem solving:** tekstoppgave → velge regneart
- **Reading comprehension:** finne informasjon, finne belegg, ord fra kontekst, slutning, hovedidé, gjenfortelling
- **Word lists:** ukeord/gloser are stored as *items*, not skills (§6.5, §11).

Each catalogue entry has: `id`, Norwegian label, grade band, `generator` (if deterministic), suggested representations, and typical misconceptions.

### 5.4 What the memory must never contain

No personality, temperament, mood, frustration history, diagnoses, "learning type", free-text judgements about the child, sibling comparisons or raw transcripts. Only skill events, which observe a *performance at a support level at a time*.

---

## 6. Recommended maths evolution

### 6.1 Deterministic arithmetic verification (P0)

**Problem:** the prompt asks the LLM to compute and double-check (`index.js:245-249`), but nothing enforces it. Even an occasional false "riktig" teaches an error and makes Spark less trustworthy.

**Design:**

- Whenever the model judges a numeric answer, it emits `[[SJEKK: uttrykk | barnets svar | vurdering]]`, for example `[[SJEKK: 47+38 | 75 | feil]]`.
- **The Worker** evaluates the expression with a small exact parser: integers, decimal comma, `+ − · × ÷ / :`, parentheses, simple fractions, exact rational arithmetic, no `eval`. Using the Worker keeps the check provider-independent across Gemini, OpenRouter and Groq, and it can be tested in `tests/worker.test.mjs`.
- If the computed truth contradicts the model's verdict, the Worker re-asks the provider **once** with a short correction note. If that still fails, it returns a safe neutral reply: "La oss regne det sammen…". It never forwards a verified-false claim.
- Markers are stripped before display and TTS (`speechText` already strips `[[…]]` families; extend its regex).
- **Telemetry (local only):** count verifier interventions per session, for tuning.

**Limits to state honestly:** the verifier catches arithmetic errors, not *modelling* errors. If a word problem was translated into the wrong expression, the arithmetic can check out while the answer is still wrong. Judgements without a marker are not caught. The test corpus should measure marker compliance.

### 6.2 Deterministic visual representations (P1)

The LLM requests a representation, and code draws it as an SVG:

```
[[VIS: tallinje 0-100 start=47 hopp=+30,+8]]
[[VIS: tierramme 7]]          [[VIS: tiere 4 enere 7]]
[[VIS: rutenett 3x4]]         [[VIS: brøk 3/4 strimmel]]
[[VIS: klokke 07:45]]         [[VIS: penger 20,10,5,1,1]]
```

- The client validates ranges and silently drops invalid specs. Rendered SVG is accessible (`aria-label` with a spoken description).
- Why deterministic: LLM-generated images or ASCII diagrams are unreliable and expensive, and a wrong number line is worse than none. Code-drawn representations are exactly right, quota-free and consistent.
- **Fading:** after an S0–S1 success with a representation, prompt rules tell Spark to stop offering it for that skill. The skill record (`helped`) remembers it as a fallback.
- **Evidence:** STRONG for linked representations and number lines (EEF; Siegler & Ramani; Fuchs fraction number-line work). PROMISING for manipulatives in general (d ≈ 0.37, strongly moderated by explicit linking).
- Interactive manipulatives (dragging jumps, filling a ten frame) are **P2**. Static, correct representations deliver most of the value first.

### 6.3 Misconception vs slip — make it data

Already in the prompt. The improvement is to record the error type (`e`) in the skill event. A *recurring* misconception (same skill, same type, two or more sessions) becomes the parent view's "recurring difficulty". A one-off slip never does.

### 6.4 Worked examples and fading

- For skills in state NY and clearly new material: one short worked example ("se hvordan jeg gjør 36 + 7"), then a **completion problem** where the child does the last step, then the child does a full problem. This is Renkl-style backward fading.
- Self-explanation prompts on worked examples should be used **sparingly** (Barbieri 2023: negative moderator), and only for conceptual steps such as "hvorfor ble det en ny tier?".

### 6.5 Deterministic item generators

For catalogue skills that can be generated (tallvenner, ±regrouping, gangetabell, klokke, penger, place value): generator functions produce an item, an answer key and a representation spec. They feed "Prøv selv", cold checks and review mode **with zero LLM calls**. The LLM is called only when the child gets an item wrong and wants help.

### 6.6 What stays LLM

Interpreting photographed homework, diagnosing *why*, word problems, explaining in child language, choosing which representation to request, and conversation.

---

## 7. Recommended reading evolution

### 7.1 Separate the components (Simple View of Reading)

| Component | Can Spark help reliably? | How |
|---|---|---|
| Decoding / word reading | **Not by listening.** | A human listener, or (later) a parent-mediated routine. |
| Fluency (accuracy, rate, prosody) | **No live automated assessment.** | Repeated reading *with a parent*; Spark structures it (P2). |
| Vocabulary | Yes | Brief explanation and child-friendly use when context is weak. Words go into the review queue as items. |
| Comprehension (literal, evidence, inference, main idea, retell) | **Yes — Spark's strength** | Keep the current question types. Add structured retell and prediction. |

### 7.2 Why Spark should NOT live-interrupt on possible misreads

1. **Recognition error dwarfs the signal.** Child speech is hard for ASR. The best recent Dutch child read-speech results report word error rates of about 10–15%. For *miscue detection*, the best precision was about **0.52**: roughly half of flagged "errors" were words the child read correctly. Low WER does not mean accurate error detection. Comparable Norwegian child-speech benchmarks were not found, and Norwegian dialect variation makes things worse (INFERENCE). Live correction would therefore *often correct the child for reading correctly*.
2. **Interrupting pre-empts self-correction.** Self-correcting is a sign of good monitoring. Interrupting at the first deviation takes that chance away and teaches the child to wait for the listener (INFERENCE from the reading-instruction literature, e.g. the "pause, prompt, praise" approach used by tutors).
3. **Interrupting breaks comprehension and prosody.** It moves attention to single words and fragments the meaning the child is building (INFERENCE).
4. **Emotional cost and trust.** Repeated false or trivial corrections of a young reader are discouraging. Children may stop reading aloud or start doubting correct readings (INFERENCE, consistent with feedback research P6).
5. **Even purpose-built systems struggled with false alarms.** Project LISTEN's Reading Tutor treated false alarms as a central design problem: an early prototype detected about half of misread words, with a false-alarm rate under 4%. Spark has neither a purpose-built recogniser nor the reference text alignment.
6. **Privacy.** Browser speech recognition typically sends audio to a cloud service. Continuous listening to a child reading widens that exposure for little benefit.

**Rule:** no live interruption. If any listening feature is ever built, it must give feedback only **after the passage**, mention at most one or two *meaning-changing* words, phrase them as uncertain ("Jeg hørte kanskje «hus» — står det det?"), and the child or parent must be able to switch it off. This stays **DO NOT BUILD** for now (§13).

### 7.3 Reading companion (P1)

- **"Les for meg":** TTS reads the photographed text sentence by sentence with highlighting. It is offered for *comprehension* tasks (fagtekst, questions to a text), **not** for the decoding or reading-practice homework itself, because that would remove the practice. A parent toggle controls it per child.
  Evidence: Wood et al. 2018 found g ≈ 0.35 for TTS/read-aloud on comprehension in students with reading difficulties. A 2023 reading-while-listening meta-analysis found only g ≈ 0.18 overall, with no reliable benefit when the reader controlled the pace. PROMISING as an access aid, not as a reading-skill builder.
- **Structured retell:** the child retells in their own words (typed or spoken). Spark checks *coverage*: who/what/problem/outcome for stories, main idea plus one or two supporting details for fagtekst. It asks for one missing element and does not list everything missed.
- **Prediction → check:** before the final paragraph, "Hva tror du skjer?" and afterwards "Stemte det? Hvilket spor brukte du?". Use at most once per text.
- **Vocabulary:** 1–3 words that blocked understanding are added to the review queue with the sentence they came from.

### 7.4 Correction timing for reading (in text interaction)

Correct *meaning* errors (literal misunderstanding of what the text says) at once, gently, using "hvor står det?". Do not correct spelling in a child's typed answers in reading mode, except when the question is about spelling (this matches the existing ≤ 7 rule at `index.js:163`).

---

## 8. Recommended feedback and motivation behaviour

### 8.1 Spark SHOULD

- Give **task feedback** ("47 + 38: tierne stemmer, sjekk enerne") and **process feedback** ("å dele opp 38 gjorde det enklere").
- Give **self-regulation feedback** that names what the child did to manage their work ("du sjekket svaret selv og fant feilen — det er akkurat det gode regnere gjør").
- **Make independence visible:** "Den klarte du helt selv. Forrige uke trengte du tallinjen." This is informational feedback based on the evidence log. Self-determination theory supports it as competence information (P7: informational, not controlling).
- **Offer small real choices** (two options) when the child has capacity: method, order of tasks, read aloud or not, warm-up now or skip.
- **Calibrate challenge** using skill state (§4.5) and the "Pause / for vanskelig" button.
- Use **interests** occasionally as a bridge (keep the current rules).
- Say a short, honest "good enough" when the homework is done. **Ending is a success state.**

### 8.2 Spark SHOULD NOT

- Praise the person ("du er så flink / smart") or use generic praise as a default opener (already in the prompt).
- Award **points, stars, coins, streaks or levels** for correctness or time. Spark should also not show running totals or compare siblings.
- Use **variable or surprise rewards**, countdown pressure, or "don't lose your streak" messages.
- Prolong a session to "test more" after the homework is done (already in the prompt at `index.js:222-223`). Keep it that way.
- Claim feelings ("jeg er så stolt av deg", "jeg savnet deg").

### 8.3 Replacing ⭐ POENG

- **Remove** the cumulative header counter and the LLM-awarded `⭐ POENG!` marker.
- **Replace** with **"Klarte selv" marks**, derived *deterministically* from S0–S1 events (`prøv` or `cold`) and attached to the task in the chat ("✓ Klarte selv"). They are not added up into a score.
- **Child view "Ting jeg kan nå":** a list of skills in SELVSTENDIG/SITTER, with dates. It celebrates competence, not points.
- Existing `stars` values can be retained silently in storage (no migration risk) and simply not displayed.

**Evidence:** STRONG on contingent rewards. INFERENCE for the specific replacement.

---

## 9. Metacognition without interrogation

Dose rule: **at most one metacognitive prompt per task, and none on trivial steps.** Age bands:

| Phase | Age ≤ 7 | Age 8+ |
|---|---|---|
| **Plan** | Not as a question. Spark models it briefly ("først teller vi tierne"). | Only for multi-step tasks: "Hva gjør du først?" |
| **Monitor** | — | During a long task: "Virker planen?" (rarely) |
| **Check** | A concrete action: "Tell på fingrene / se på tallinja om det stemmer" | "Hvordan kan du sjekke det?"; deterministic estimation check: "Er svaret nærmere 80 eller 800?" |
| **Reflect** | End of session: one tap from 3 pictures: "Hva hjalp i dag?" | End of session: one tap (tallinje / dele opp / tegne / hint / prøve igjen) + optional "hva var vanskelig?" |
| **Calibrate** | — | Confidence tap on cold checks only (§5.2) |

The end-of-session reflection costs no LLM call (it is a UI tap). It feeds `helped` in the skill record and the parent summary. EEF's +8-month estimate comes from *explicit, embedded* strategy teaching, not from repeated questioning. Spark should **model the strategy aloud first** and only later ask the child to use it.

---

## 10. Recommended parent experience

### 10.1 Purpose

Parents should use the view to have a **better five-minute conversation with their child**, not to grade or monitor. The evidence (P14) says autonomy support helps, while control and content-teaching help little or harm.

### 10.2 Content (per child, behind the existing ⚙️ parent area)

1. **This week**
   - A list of sessions with date, start time, **active minutes**, mode and topic.
   - Active minutes are computed from message timestamps, and gaps longer than 3 minutes are not counted.
   - Minutes are shown as plain numbers, not as a headline chart.
2. **Klarte selv / Sitter:** skills with their first independent date and their retained date. This is the headline.
3. **Øver på:** skills with a recurring S3–S4 need or a recurring misconception type across two or more sessions, with "what helped" (one strategy).
4. **Support trend (lightweight chart):** a small inline-SVG weekly stacked bar of completed tasks by highest support level, grouped as S0–S1 / S2 / S3–S4. It answers the product question: "is help going down?"
5. **Samtaleforslag (one per week):** generated deterministically from templates with no LLM call. It is autonomy-supportive and child-led, for example:
   - "Be Olav vise deg hvordan han bruker tallinja på tierovergang — la ham være læreren."
   - "Spør: hva var vanskeligst denne uka, og hva gjorde du da?"

   This also turns teach-back into human interaction (§4.6).
6. **Practical notes:** "Spark kan ikke høre opplesing — les høyt sammen med en voksen" whenever reading-aloud homework appeared.

### 10.3 What the parent view must NOT contain

- Grades, percentages correct as a score, predicted results or sibling comparison.
- Real-time monitoring or notifications during a session.
- Mood or frustration history.
- Full transcripts *by default*. The existing "Tidligere økter" archive stays available for the child and family, but the parent summary is built from structured data.

### 10.4 Transparency to the child

The child view "Ting jeg kan nå" shows the same skill evidence in child language. **Nothing about the child should be hidden from the child.** UNICEF v3 asks for transparency and children's best interests.

---

## 11. Recommended new modes

Test applied: **does the mode produce more unaided performance per minute of use than the current four modes, without widening Spark into open chat?** Most candidate modes fail this test or are already covered. They are best handled as *entry points* into the same loop, not as new prompt modes. The Worker allow-list (`lekse|matte|lesing|quiz`) should grow only where the prompt contract really differs.

| Candidate | Verdict | Reason |
|---|---|---|
| **5-minute review ("oppvarming")** | **Build (P1, Package B)** | It is the consumer of skill memory and the main source of DIS evidence. Mostly deterministic, with no new Worker mode: generated items need no LLM, and other skills use one `matte`/`lekse` call. |
| **Øv til prøve: ukeord/gloser + gangetabell** | **Build (P1, Package B)** | Matches real Norwegian homework. Pure retrieval and spacing, so it is cheap and exact. It is a client mode, with one transcription call per word list. |
| **Reading companion** | **Build (P1, Package C)** as an upgrade of `lesing` | It improves an existing mode (Les for meg, retell, vocabulary), so no new Worker mode is needed. |
| **Explain my mistake** | **Fold in (P2)** | The existing diagnosis flow already does this. At most add a quick button "Hvorfor ble det feil?" after a wrong answer. |
| **Test preparation** | **Fold into review** | A "prøve på fredag" flag can raise the review priority for selected skills. It is not a separate mode. |
| **Vocabulary** | **Fold into reading + review** | Words become review items. A standalone vocabulary mode would detach the words from the texts where they matter. |
| **Learn something new** | **P2, bounded** | Valuable for curiosity but drifts toward open chat. If built, it needs a topic picker, a maximum of about 10 minutes, a worked-example start and an unaided "Prøv selv" at the end. |
| **Curiosity / science ("Hvorfor?")** | **P2, bounded** | The existing `quiz` mode already covers general knowledge. A bounded variant must end in "spør en voksen / let sammen". Not a companion. |
| **Oral quiz** | **Do not build now** | It depends on child-speech ASR accuracy for scoring (§7.2). Spoken *answers* already work through the mic in normal chat, where misrecognition is visible and can be edited. |
| **Spelling as free dictation with speech scoring** | **Do not build** | Typed dictation (inside Øv til prøve) gives exact checking. Speech scoring does not. |

Net: **two genuinely new entry points** (review and Øv til prøve), **one mode upgrade** (reading companion) and **no new open-ended modes.**

---

## 12. Privacy, safety and dependency guardrails

| Risk | Current state | Guardrail |
|---|---|---|
| **Storing inferred traits** | PROMPT bans labels; notes are free text (`index.js:338-346`) | Skill memory holds only performance events. PROFIL notes are kept for non-catalogue observations but stay strategy + effect only. Add a client-side length/keyword filter that rejects notes containing trait words ("type", "personlighet", "lat", "sint" …). Keep the parent reset (`spark.html:720`). |
| **Excessive transcript retention** | 8 archived sessions × 40 messages, indefinitely (`spark.html:430-438`) | Archived transcripts are kept 30 days, then reduced to summary + skill events. Images are never stored after the transcript exists (already true). Add "Slett all historikk for barnet" in one place. |
| **Cross-device sync** | Not built; local only | If built (P2), sync **structured skill memory and summaries only, never transcripts or images**. Use a per-family Worker store with a delete endpoint and 90-day TTL on inactive records. Simpler alternative: export/import a JSON file between phones. Only build sync if the children actually switch devices. |
| **Emotional inference** | The prompt adapts to "lei, sint eller stille" in-turn (`index.js:232`) | Allowed **only ephemerally** inside the turn, and it must never be stored, labelled or shown to parents. Prefer child **self-report** (the "Pause / for vanskelig" button). **Never** build voice- or face-based emotion detection. The EU AI Act bans biometric emotion inference in educational institutions; a family app is outside that scope, but the principle applies. |
| **Open-ended general chat** | Prevented by R2 mode allow-list (`index.js:118`) | Keep. Any curiosity mode must be bounded: a topic, a time cap of about 10 minutes, and a return to "ask a grown-up / look it up together". |
| **Companion dependency** | "læringsvenn" persona | Prompt rule: Spark is a learning helper. It does not claim feelings, friendship or memory of the child "as a person". It does not encourage secrets from parents, and it directs serious topics to a trusted adult (already at `index.js:184-185`). |
| **Reward dependency** | ⭐ POENG counter | Remove (§8.3). No streaks or notifications. |
| **Overuse** | No time awareness | After about 25 active minutes, suggest a pause or "ferdig" ("Nå har du jobbet lenge — vil du ta pause eller avslutte?"). An optional parent-set daily soft limit is P2. Session length must never be a target. |
| **Replacing parent/teacher** | Prompt sends serious matters to an adult | Parent conversation prompts (§10). Reading-aloud homework → "les for en voksen". Ambiguous task instructions → "spør læreren hva de mener med…" rather than guessing. |
| **Voice data** | Web Speech mic input (`spark.html:1038`) | Disclose in setup that speech may be processed by the browser vendor's cloud. Keep the mic opt-in. Do not extend it to continuous listening. |
| **AI correctness** | LLM self-check | Deterministic verifier (§6.1). Show the child that Spark "checks with a calculator" only where it actually does. |

---

## 13. Feature ranking

### 12.1 Summary

| Rank | Feature | Package |
|---|---|---|
| **P0** | F1 Support-level instrumentation (S0–S4) and independence metrics | A |
| **P0** | F2 "Prøv selv" unaided near-transfer at task end | A |
| **P0** | F3 Deterministic arithmetic verifier (Worker) | A |
| **P0** | F4 Explicit help ladder UI with soft bottom-out guard + "Pause / for vanskelig" | A |
| **P0** | F5 Skill-evidence memory v1 (catalogue, event log, derived states) + `sessionState` fading | A |
| **P0** | F6 Reward reform: retire ⭐ POENG counter → deterministic "Klarte selv" | A |
| **P0** | F7 Prompt v5.4 contract (markers, persona guard, age-dosed metacognition) + timestamps | A |
| **P1** | F8 Spaced review queue + "5-minutters oppvarming" (cold checks, interleaving, confidence tap) | B |
| **P1** | F9 Deterministic generators for core number/clock/money skills | A (core) / B (breadth) |
| **P1** | F10 Parent view v2 (timeline, active minutes, skills, support trend, conversation prompt) | B |
| **P1** | F11 "Øv til prøve": ukeord/gloser + gangetabell practice (TTS dictation, deterministic checking, spaced) | B |
| **P1** | F12 Retention and minimisation policy (30-day transcripts, one-place delete, mic disclosure) | B |
| **P1** | F13 Deterministic visual representations (number line, ten frame, base-ten, array, fraction strip, clock, coins) | C |
| **P1** | F14 Reading companion (Les for meg, structured retell, prediction, vocabulary → review) | C |
| **P1** | F15 End-of-session one-tap reflection + teach-back prompt | A (tap) / B (parent link) |
| **P2** | Cross-device sync of structured memory (or JSON export/import first) | — |
| **P2** | Interactive manipulatives (drag on number line, fill ten frame) | — |
| **P2** | Parent-mediated repeated reading routine (Spark structures it; parent listens) | — |
| **P2** | Natural TTS via Gemini (quota cost; test system voices first, per `TODO.md`) | — |
| **P2** | Bounded curiosity mode ("Hvorfor-spørsmål", 10-min cap) | — |
| **P2** | "Forklar feilen min" quick button (largely covered by existing flow) | — |
| **P2** | Parent-set soft daily limit | — |
| **P2** | Local-only "hør deg selv" reading recording (no upload, no scoring) | — |
| **DO NOT BUILD** | Live ASR miscue interruption or automated fluency scoring | — |
| **DO NOT BUILD** | Voice/face/camera emotion detection; stored mood or frustration history | — |
| **DO NOT BUILD** | Learning-style, personality or "type" profiles | — |
| **DO NOT BUILD** | Streaks, leaderboards, points economies, sibling comparison, variable rewards | — |
| **DO NOT BUILD** | Open-ended general chat or companion persona features | — |
| **DO NOT BUILD** | Automatic grading or grade prediction | — |
| **DO NOT BUILD** | Time-in-app as a success metric; engagement push notifications | — |
| **DO NOT BUILD** | Default full-transcript parent dashboards or real-time parent monitoring | — |
| **DO NOT BUILD** | BKT/DKT/FSRS-style fitted learner models (insufficient data; opaque) | — |
| **DO NOT BUILD** | LLM-generated diagrams/images for maths | — |

### 12.2 P0 feature specifications

#### F1 — Support-level instrumentation and independence metrics

| Field | Specification |
|---|---|
| Learning problem | Spark cannot tell whether help is fading. Its "fade support" behaviour is unverified, and dependence cannot be detected. |
| Evidence strength | STRONG for scaffolding and fading as practice. INFERENCE for S0–S4 as a metric. |
| Expected value | Very high: every other feature (memory, review, parent view, success metric) depends on it. |
| Child UX | Invisible apart from the help ladder (F4). No scores. |
| Architecture impact | New hidden marker `[[STØTTE: …]]` parsed in `harvest()`. Client tracks ladder presses per task. Per-message timestamps are added to `chatMsgs`. A task-boundary heuristic uses the marker. |
| API/quota impact | None: piggybacks on existing replies. |
| Privacy impact | Low: numeric levels per skill, local only. |
| Failure modes | The LLM omits or misjudges the marker. Mitigation: `max(client, LLM)`, never lower. Task boundaries can be ambiguous on multi-task photo sheets. Mitigation: one marker per completed sub-task, unknown → `annet`. |
| Minimal viable form | Button-derived level + LLM marker; stored per task in the session; summarised at finish. |
| Success metric | ≥ 90% of completed tasks in test transcripts carry a valid marker. The parent view can show the weekly S0–S1 share. The **DIS** metric becomes computable. |

#### F2 — "Prøv selv" unaided near-transfer

| Field | Specification |
|---|---|
| Learning problem | Success with help is mistaken for learning. There is no unaided evidence within the session. |
| Evidence strength | STRONG (retrieval/transfer practice). INFERENCE for the single-item format. |
| Expected value | High: generates independence evidence at almost no cost and gives the child visible competence ("Klarte selv"). |
| Child UX | "Nå tar du en helt selv 💪 (du kan hoppe over)". One item, then a short debrief. Never after a frustrating task or a long homework set. |
| Architecture impact | Generator functions for catalogue skills (F9 core). `[[PRØV: …]]` marker for LLM-proposed items. Event kind `prøv`. |
| API/quota impact | Zero for generated items. For LLM items, zero extra for generation plus one normal turn for the child's answer. |
| Privacy impact | Low. |
| Failure modes | Fatigue or "extra homework" feeling. Mitigation: skippable, max one per task, suppressed after 25 active minutes, and suppressed when the homework set has more than about 4 tasks (offer it once at the end instead). Items can be too far a transfer. Mitigation: near transfer only (same skill, new numbers or context). |
| Minimal viable form | Generated items for the arithmetic catalogue only; LLM items for other skills later. |
| Success metric | Opt-in rate ≥ 60% without a rise in "Pause / for vanskelig" presses. Share of S0 success on `prøv` items rises over weeks for the same skill. |

#### F3 — Deterministic arithmetic verifier

| Field | Specification |
|---|---|
| Learning problem | A false correctness verdict teaches errors and erodes trust. The LLM self-check is not enforceable. |
| Evidence strength | INFERENCE (the risk is LLM arithmetic fallibility, which is well documented; the remedy is engineering). |
| Expected value | High in maths mode: correctness is the minimum requirement. |
| Child UX | Invisible. At most one additional second on rare corrections. |
| Architecture impact | Worker: an exact-rational expression parser, a `[[SJEKK]]` marker contract, a one-shot re-ask on contradiction and a safe fallback. Prompt version bump. New Worker tests. |
| API/quota impact | An extra provider call **only** when a contradiction is detected (expected to be rare). Zero otherwise. |
| Privacy impact | None. |
| Failure modes | The marker is omitted, so the error goes uncaught. Mitigation: test-corpus compliance checks and a prompt rule. Modelling errors pass. Mitigation: state this limit and do not over-claim. Parser edge cases (mixed numbers, units). Mitigation: unsupported syntax means skip, not block. A provider fallback model may ignore markers. Mitigation: the verifier still runs on whatever markers exist. |
| Minimal viable form | Integers and decimals with `+ − × ÷` and parentheses; verdict check; one re-ask. |
| Success metric | 0 verified-false verdicts reach the child in a seeded test corpus. Marker compliance ≥ 95% on maths judgements. |

#### F4 — Explicit help ladder UI, soft bottom-out guard, "Pause / for vanskelig"

| Field | Specification |
|---|---|
| Learning problem | Flat help buttons allow skipping to answers, and the level of help is opaque. Frustration has to be inferred. |
| Evidence strength | PROMISING (help-abuse literature). INFERENCE for the age split. |
| Expected value | High: makes fading visible to the child and gives F1 clean data. |
| Child UX | Three rungs (💡 → 🪜 → 👀). For age ≥ 8, the first tap before any attempt asks "Prøv ett steg først?", and a second tap proceeds anyway. "Pause / for vanskelig" is always available. |
| Architecture impact | `renderQuick()` rewrite. Each rung sends a canonical message the prompt recognises. Rung state is kept per task. |
| API/quota impact | None. |
| Privacy impact | None. |
| Failure modes | Help avoidance: a child who will not ask suffers in silence. Mitigation: no friction for ≤ 7, "Jeg vet ikke" stays frictionless, and Spark offers help after two wrong attempts. Friction feels punitive. Mitigation: one gentle prompt only, never a lock. |
| Minimal viable form | Three buttons with a staged unlock, plus the pause button. |
| Success metric | The share of tasks reaching S4 without any attempt falls. Pause presses are followed by session completion or a clean stop, not abandonment. |

#### F5 — Skill-evidence memory v1 and cross-session fading

| Field | Specification |
|---|---|
| Learning problem | Each session starts from zero. Spark cannot fade across days, review or report "can now do alone". |
| Evidence strength | STRONG for mastery learning and spacing in principle. PROMISING for simple mastery criteria. INFERENCE for this exact model. |
| Expected value | Very high: this is the substrate for review, the parent view and fading. |
| Child UX | "Du har klart denne før — prøv selv." The "Ting jeg kan nå" list. |
| Architecture impact | `kid.skills` structure (§5.2). A static catalogue file (`skills-v1` in `spark.html` or a small JSON asset; the service-worker cache list must include it if separate). Deterministic state derivation. `sessionState` (≤ 300 chars) carries the current skill context to the Worker. The Worker prompt template inserts it as sanitised data (the contract is already validated at `index.js:122-123`). Parent reset per child. |
| API/quota impact | None: the context goes in an existing field. |
| Privacy impact | Low–moderate: a structured learning record about a child. Local only, resettable, visible to the child, and with no traits. |
| Failure modes | LLM skill mis-mapping. Mitigation: closed catalogue, `annet` fallback, and the parent can delete a record. Catalogue too broad or too narrow. Mitigation: v1 limited to the skills seen in the children's homework, versioned. Storage failure. Mitigation: reuse the existing visible storage-warning path. |
| Minimal viable form | Catalogue of about 30 skills, an event log with derived state, and `sessionState` injection. No scheduler yet. |
| Success metric | After 4 weeks, skill records exist for the main homework topics. The parent can recognise them as accurate (a qualitative check). The opening support level for repeat skills is lower than at first exposure. |

#### F6 — Reward reform: retire ⭐ POENG → "Klarte selv"

| Field | Specification |
|---|---|
| Learning problem | An LLM-awarded, cumulative, correctness-contingent point counter. It contradicts the stated product rule, risks overjustification and sibling comparison, and rewards the wrong thing. |
| Evidence strength | STRONG (Deci, Koestner & Ryan 1999). |
| Expected value | Medium–high: aligns the motivation system with independence. |
| Child UX | A "✓ Klarte selv" tag on S0–S1 items and the "Ting jeg kan nå" list. No header counter. |
| Architecture impact | Remove the POENG section from the prompt (`index.js:235-237`) and the counter display (`spark.html:126, 576`). Keep `stars` silently in storage. Derive the tags from F1 events. |
| API/quota impact | None. |
| Privacy impact | None. |
| Failure modes | The child misses the stars. Mitigation: introduce "Klarte selv" in the same release and frame it positively. Parent explanation in the release note. |
| Minimal viable form | Counter removed, tags shown. |
| Success metric | No drop in voluntary session starts. Child-reported enjoyment unchanged (informal family check). |

#### F7 — Prompt v5.4 contract + timestamps

| Field | Specification |
|---|---|
| Learning problem | Several pedagogy improvements need coordinated prompt rules and markers. There is no time data. |
| Evidence strength | Inherits from F1–F6 and §9/§12. |
| Expected value | High (enabling). |
| Child UX | Fewer metacognitive questions for young children; clearer helper persona. |
| Architecture impact | `PROMPT_VERSION` bump. New marker contract (`STØTTE`, `PRØV`, `SJEKK`, later `VIS`). Persona guard. Age-dosed metacognition. "Prøv selv" rule. Remove POENG. `speechText()` and `harvest()` strip new markers. Message timestamps (`ts`) and archive start/end times replace the date-only `toLocaleDateString` (`spark.html:432, 518`). Tests: prompt snapshot, marker parsing, stripping in TTS. |
| API/quota impact | A slightly longer system prompt (a few hundred tokens). Negligible. |
| Privacy impact | Timestamps reveal usage times. Local only, shown to the family. |
| Failure modes | Marker leakage into displayed or spoken text. Mitigation: a single strip function with tests. Older cached clients. Mitigation: R2 rejection and the existing "Oppdater Spark-appen" path. Prompt regressions. Mitigation: a smoke corpus across all four modes. |
| Minimal viable form | As described. No new modes. |
| Success metric | All four modes pass the smoke corpus. No `[[` leaks in display or TTS tests. Timestamps are present in all new archives. |

### 12.3 P1 feature specifications

#### F8 — Spaced review queue + "5-minutters oppvarming"

| Field | Specification |
|---|---|
| Learning problem | Skills fade between homework topics. Within-session retrieval is not spaced. |
| Evidence strength | STRONG (retrieval, spacing). PROMISING at primary age. STRONG/INFERENCE for interleaving (grade 7). |
| Expected value | High: the main producer of DIS evidence and of retention. |
| Child UX | The start screen shows an optional card, "3 kjappe fra før? (2 min)". Unaided items, interleaved, with a confidence tap for 8+. Right answers get "✓ Klarte selv". Wrong answers get a one-line debrief and an offer: "vil du øve den nå?". |
| Architecture impact | Leitner scheduler (§5.2); a review-mode UI with no chat; generators (F9); a fallback that asks the LLM to generate items for non-generatable skills (one call per review session). |
| API/quota impact | Zero for generated skills. At most one call per review session otherwise. |
| Privacy impact | Low. |
| Failure modes | Feels like extra homework. Mitigation: optional, capped at 3 items, skippable, never a streak. Items get stale. Mitigation: generators vary numbers. Child guesses. Mitigation: the "gjetter" tap blocks promotion. |
| Minimal viable form | Scheduler + generated items for arithmetic skills + confidence tap. |
| Success metric | **DIS** (share of cold checks at S0–S1) is computable and trends upward per skill. Warm-up acceptance is at least 40% with no negative child feedback. |

#### F9 — Deterministic item generators

| Field | Specification |
|---|---|
| Learning problem | Review and transfer items need exact answers and zero quota. |
| Evidence strength | INFERENCE (engineering in support of STRONG retrieval practice). |
| Expected value | High leverage, low risk. |
| Child UX | Varied, age-appropriate items. |
| Architecture impact | Pure functions per catalogue skill: `{prompt, answer, accept[], vis?}`. Unit-tested. |
| API/quota impact | Reduces API use. |
| Privacy impact | None. |
| Failure modes | The answer format is ambiguous ("kvart over 7" vs "07:15"). Mitigation: an `accept` list and normalisation. Too easy or too hard. Mitigation: difficulty parameter tied to box. |
| Minimal viable form | Generators for 10–12 core skills. |
| Success metric | 100% of generated items pass unit validation. Children's error rate on box-1 items lands roughly in the 20–40% range (desirable difficulty). |

#### F10 — Parent view v2

| Field | Specification |
|---|---|
| Learning problem | Parents cannot see progress in independence or talk to their child about it productively. The current log is free text with a date only. |
| Evidence strength | STRONG direction (autonomy support > control). INFERENCE for the specific UI. |
| Expected value | High for family dynamics. Turns Spark data into human interaction. |
| Child UX | The child sees the same data as "Ting jeg kan nå". |
| Architecture impact | Read-only aggregation of `skills`, archives and timestamps. Inline SVG chart (no library). Deterministic conversation templates. |
| API/quota impact | None. |
| Privacy impact | Moderate: a structured progress view of a child. Mitigation: no grades, no mood, no transcripts by default, child-visible, and resettable. |
| Failure modes | Becomes surveillance or grading. Mitigation: content limits in §10.3 and conversation framing. Misread charts. Mitigation: one simple chart with plain-language labels. |
| Minimal viable form | Weekly list with times and minutes, Klarte selv / Øver på, one support-trend chart and one conversation prompt. |
| Success metric | Parent reports using the conversation prompt at least weekly (self-report). No increase in controlling help (qualitative). |

#### F11 — "Øv til prøve": ukeord/gloser and gangetabell

| Field | Specification |
|---|---|
| Learning problem | Norwegian primary homework often includes weekly word lists and fact practice. These are pure retrieval and spacing tasks where LLM dialogue adds little. |
| Evidence strength | STRONG (retrieval and spacing). PROMISING for spelling-specific practice. |
| Expected value | High practical value at very low cost. |
| Child UX | Photograph the word list (one LLM call to transcribe it), confirm it, then practise: TTS says the word and a sentence, the child types it, and the app checks it exactly. Words the child misses come back sooner. Gangetabell works the same way with generators. |
| Architecture impact | List items stored per child with Leitner boxes; dictation UI; reuse of the existing TTS voice selection. |
| API/quota impact | One call per new list. |
| Privacy impact | Low. |
| Failure modes | TTS mispronounces a word. Mitigation: show the word briefly *after* the attempt, and offer a parent "say it yourself" option. Typing burden for ≤ 7. Mitigation: letter-tile input or parent-mediated mode. |
| Minimal viable form | One word list per child; type-to-answer; Leitner within the week. |
| Success metric | The child spells the list correctly unaided on the last practice before the school test. Parent confirms the test result informally. |

#### F12 — Retention and minimisation policy

| Field | Specification |
|---|---|
| Learning problem | Not a learning problem but a safety one: transcripts of children are retained indefinitely, and voice handling is not disclosed. |
| Evidence strength | STRONG normative (UNICEF v3; GDPR data-minimisation principle). |
| Expected value | Medium: reduces risk before memory and sync grow. |
| Child UX | None. |
| Architecture impact | Prune archived `msgs` after 30 days (keep summary and events). One-place "Slett alt om barnet". Mic disclosure text in setup. |
| API/quota impact | None. |
| Privacy impact | Positive. |
| Failure modes | A parent wants old transcripts. Mitigation: an optional "behold samtaler" toggle, default off. |
| Minimal viable form | Pruning + delete + disclosure. |
| Success metric | No archive older than 30 days contains `msgs` (test). |

#### F13 — Deterministic visual representations

| Field | Specification |
|---|---|
| Learning problem | Spark describes number lines and ten frames in words, which is a heavy load for young children. LLM-drawn diagrams are unreliable. |
| Evidence strength | STRONG (linked representations, number lines). PROMISING (manipulatives in general). |
| Expected value | High for the younger child and for new concepts. |
| Child UX | A small, clear SVG appears in the chat bubble, with a spoken description for TTS. |
| Architecture impact | A `[[VIS: …]]` mini-DSL, a validator, and SVG renderers (number line, ten frame, base-ten, array, fraction strip, clock, coins). Markers stripped from TTS. Prompt rules for when to request and when to fade. |
| API/quota impact | None. |
| Privacy impact | None. |
| Failure modes | The LLM requests a wrong spec (for example the wrong jump). Mitigation: validate against the `SJEKK` expression where present. Over-use becomes a crutch. Mitigation: fading rule plus `helped`. Small-screen legibility. Mitigation: tested at 390 px. |
| Minimal viable form | Number line, ten frame and clock. |
| Success metric | Representation-supported tasks reach S0–S1 on "Prøv selv" without the representation within 2–3 sessions for that skill. |

#### F14 — Reading companion

| Field | Specification |
|---|---|
| Learning problem | Comprehension coaching is strong but unstructured. Long texts overload decoding for weaker readers. Vocabulary does not persist. |
| Evidence strength | STRONG (comprehension strategies, vocabulary). PROMISING (TTS as access aid). |
| Expected value | Medium–high. |
| Child UX | "📖 Les for meg" (sentence highlighting, child-paced). A retell prompt with one missing-element question. Prediction once per text. Words saved to review. |
| Architecture impact | A text view of the transcript with sentence segmentation, TTS sequencing, retell rubric markers and vocabulary items into the review queue. A parent toggle for read-aloud per child. |
| API/quota impact | No extra calls (the existing transcript is reused). |
| Privacy impact | Low (no listening). |
| Failure modes | Read-aloud used on decoding homework. Mitigation: off for "lesing høyt" tasks, plus the parent toggle. TTS quality. Mitigation: the existing voice selector; natural TTS is P2. |
| Minimal viable form | Les for meg + structured retell. |
| Success metric | Retell coverage improves across texts. Vocabulary items are retrieved on cold checks. |

#### F15 — One-tap reflection + teach-back

| Field | Specification |
|---|---|
| Learning problem | Reflection is either absent or an interrogation. Strategy knowledge is not consolidated. |
| Evidence strength | STRONG (metacognition, when explicit and light). PROMISING (teach-back). |
| Expected value | Medium. |
| Child UX | At the end: "Hva hjalp i dag?" with 3–5 picture buttons. Occasionally: "Forklar for meg / for mamma eller pappa". |
| Architecture impact | A UI tap at finish feeds `helped`; teach-back is a prompt rule plus a parent conversation template. |
| API/quota impact | None. |
| Privacy impact | None. |
| Failure modes | Tap fatigue. Mitigation: skippable, at most once per session. |
| Minimal viable form | The tap. |
| Success metric | Reflection is answered in at least 50% of sessions, and `helped` matches later S0 successes. |

---

## 14. Roadmap — three implementation packages

### Package A — "Selvstendighetsløkka" (the independence loop) ⟵ **recommended next**

**Contents:** F1, F2, F3, F4, F5 (memory v1 + `sessionState` fading, no scheduler), F6, F7, F9 (core generators for about 10 arithmetic, clock and money skills), F15 (tap only).

**Why first:** it fixes the measurement gap that blocks everything else. It removes the one pedagogical contradiction in the shipped product (POENG). It adds the most important safety-of-correctness control (the verifier). It costs essentially no extra quota. After A, Spark can answer the product question: *"Is the child doing more with less help?"*

**Endpoint (one Codex endpoint-first mission):**

- Prompt `v5.4` deployed behind the existing R2 contract.
- Worker verifier with tests.
- Client markers, ladder, "Prøv selv", skill log, state derivation, "Klarte selv", timestamps.
- Test suite extended from 45 checks to cover marker parsing and stripping, verifier truth tables, state derivation, generator validity, `sessionState` sanitisation and no-POENG.
- One real paired-phone smoke for each child.

**Non-goals:** scheduler/review mode, parent view v2, visuals, reading companion, sync.

### Package B — "Husk og vis" (remember and show)

**Contents:** F8 review queue and warm-up (cold checks, interleaving, confidence tap), F9 breadth, F10 parent view v2, F11 "Øv til prøve", F12 retention policy, F15 parent teach-back link, and a 25-minute pause suggestion.

**Endpoint:**

- DIS metric live.
- Parent view with timeline, support trend and conversation prompt.
- Word-list and times-table practice.
- 30-day transcript pruning.

### Package C — "Se og les" (see and read)

**Contents:** F13 deterministic visual representations, F14 reading companion. Optionally JSON export/import between phones, if real use shows device switching. Cross-device sync is considered only after that evidence exists.

**Endpoint:**

- `[[VIS]]` renderer with number line, ten frame, base-ten, array, fraction strip, clock and coins.
- Les for meg with highlighting.
- Structured retell.
- Vocabulary into review.

**Single recommended next package: Package A.**

---

## 15. Evidence register

Verification legend:

- **V**: verified in this mission against an abstract, the publisher page or primary-source metadata.
- **S**: verified only via a secondary summary in this mission.
- **K**: established literature cited from prior knowledge and not re-fetched in this mission.

### AI tutoring

- Bastani, H. et al. (2025). Generative AI without guardrails can harm learning: Evidence from high school mathematics. *PNAS* 122(26). <https://ideas.repec.org/a/nas/journl/v122y2025pe2422633122.html>; <https://knowledge.wharton.upenn.edu/article/without-guardrails-generative-ai-can-harm-education>. **V** (abstract and coverage).
- Oreopoulos, Liut, Sungu & Low (2026). Making AI Tutoring Productive: Evidence from a Mastery-Based Math Practice Experiment. NBER w35621. <https://www.nber.org/papers/w35621>. Working paper, not peer-reviewed. **V/S**.
- Oreopoulos & Low (2026). One Click Away: AI Tutoring with Khanmigo in a Two-Year School Experiment. NBER w35620. About 0.06–0.08 SD per year; engagement was the binding constraint. <https://www.nber.org/papers/w35620>. Working paper. **V/S**.
- World Bank (2025). From Chalkboards to Chatbots (Nigeria, GPT-4 after-school tutoring, about 0.3 SD overall, about 0.23 SD English; teacher-facilitated). <https://blogs.worldbank.org/en/education/From-chalkboards-to-chatbots-Transforming-learning-in-Nigeria>; <https://voxdev.org/topic/education/how-ai-tutors-improved-learning-nigeria>. **S**.
- Kestin, G. et al. (2025). AI tutoring outperforms in-class active learning. *Scientific Reports* 15:17458 (Harvard undergraduates, crossover RCT). <https://pmc.ncbi.nlm.nih.gov/articles/PMC12179260/>. **V** (metadata).
- Tutor CoPilot (Wang et al., 2024), human-AI tutoring RCT. <https://edworkingpapers.com/sites/default/files/ai24_1054_v2.pdf>. **S**.
- Course-integrated GenAI tutor lowering final grades among undergraduates (EdWorkingPaper ai26-1598). <https://edworkingpapers.com/sites/default/files/ai26-1598.pdf>. **S**.
- VanLehn (2011), relative effectiveness of human tutoring, ITS and other tutoring. Kulik & Fletcher (2016), ITS meta-analysis. **K**.
- Help abuse and gaming: LearnLab "Help abuse" (Aleven et al. 2006 figures). <https://learnlab.org/research/wiki/index.php/Help_abuse>. **S**. Baker et al. (2004/2008). **K**.

### Learning science

- Soderstrom & Bjork (2015). Learning versus performance. *Perspectives on Psychological Science*. **K**.
- Agarwal, Nunes & Blunt (2021). Retrieval practice consistently benefits student learning. *Educational Psychology Review* 33. <https://remix.berklee.edu/faculty-works/12>. **V** (note: classroom studies mostly secondary and university).
- Adesope, Trevisan & Sundararajan (2017), practice-testing meta-analysis. Cepeda et al. (2006), distributed practice. Dunlosky et al. (2013). **K**.
- Distributing mathematical practice of third and seventh graders (Kassel). <https://kobra.bibliothek.uni-kassel.de/handle/123456789/11972>. **S**.
- Rohrer, Dedrick, Hartwig & Cheung (2020). Interleaved practice improves mathematics learning. *Journal of Educational Psychology* 112(1), d ≈ 0.83. <https://ies.ed.gov/ncee/wwc/Study/88770>. **V/S**.
- Barbieri, Miller-Cotto, Clerjuste & Chawla (2023). Worked examples meta-analysis, g = 0.48. *Educational Psychology Review*. <https://oaks.kent.edu/hcri/meta-analysis-worked-examples-effect-mathematics-performance>. **V**.
- Renkl & Atkinson (2003), fading. Kalyuga (2007), expertise reversal. Bisra et al. (2018), self-explanation meta-analysis. **K**.
- Kobayashi (2019). Learning by preparing-to-teach and teaching: a meta-analysis. *Japanese Psychological Research* 61. **V** (abstract via search).
- Pelánek & Řihák, mastery-criteria analyses. <https://is.muni.cz/publication/1448696>. **S**.
- Corbett & Anderson (1995), BKT. Kulik, Kulik & Bangert-Drowns (1990), mastery learning. **K**.

### Feedback and motivation

- Wisniewski, Zierer & Hattie (2020). The power of feedback revisited, d = 0.48. *Frontiers in Psychology* 10:3087. <https://pmc.ncbi.nlm.nih.gov/articles/PMC6987456>. **V**.
- Kluger & DeNisi (1996). Hattie & Timperley (2007). Mueller & Dweck (1998). Cimpian et al. (2007). **K**.
- Deci, Koestner & Ryan (1999), rewards and intrinsic motivation meta-analysis. Patall, Cooper & Robinson (2008), choice meta-analysis. **K**.
- Høgheim & Reber (2015), context personalisation in Norwegian mathematics. <https://www.sv.uio.no/psi/personer/vit/rolfreb/>. **S** (listing only). Reber, Canning & Harackiewicz (2018). **K**.

### Metacognition

- EEF Toolkit update (2025): metacognition +8 months. <https://educationendowmentfoundation.org.uk/news/updates-ten-strands-toolkit>. **V**.
- EEF guidance reports already cited in `PEDAGOGIKK-v5.3.md` (metacognition, feedback, early maths, KS2–3 maths, KS1 literacy). **K**.
- Roebers and colleagues on children's overconfidence and monitoring. <https://cris.maastrichtuniversity.nl/en/publications/why-are-children-overconfident-developmental-differences-in-the-i/>; <https://boris.unibe.ch/173049/1/journal.pone.0274460.pdf>. **S**.

### Maths representations

- Carbonneau, Marley & Selig (2013), manipulatives meta-analysis. Siegler & Ramani (2008). Fuchs et al., fraction number-line interventions. Siegler et al. (2010), IES fractions practice guide. **K**.

### Reading and speech

- Simple View of Reading (Gough & Tunmer 1986). National Reading Panel (2000). **K**.
- Wood et al. (2018), text-to-speech/read-aloud meta-analysis, g ≈ 0.35. <https://pmc.ncbi.nlm.nih.gov/articles/PMC5494021/>. **V**. Reading-while-listening meta-analysis (2023), g ≈ 0.18 overall. **S**.
- Dutch child-speech ASR benchmarking: word error rate about 9.8%, miscue-detection precision at best about 0.52. <https://arxiv.org/pdf/2406.07060v1>. **S**. Low WER does not mean accurate error detection: <https://arxiv.org/pdf/2306.03444>. **S**. Dutch primary read speech, about 14.8% WER: <https://clin33.uantwerpen.be/abstract/automatic-speech-recognition-of-dutch-child-speech-for-language-learning-applications>. **S**.
- Project LISTEN false-alarm work. <https://www.isca-archive.org/eurospeech_2003/banerjee03_eurospeech.html>; <https://www.ri.cmu.edu/publications/why-and-how-our-automated-reading-tutor-listens>. **S**.

### Parents

- Three-level meta-analysis of parental homework involvement: r = −0.064 overall, autonomy support positive. <https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1218534/full>. **S**.
- Pomerantz, Moorman & Litwack (2007). Moroni et al. (2015). **K**.

### Child safety and regulation

- UNICEF (2025). Guidance on AI and Children, v3.0 (10 requirements; adds AI companions). <https://www.unicef.org/innocenti/reports/policy-guidance-ai-children>. **V/S**.
- EU AI Act Art. 5(1)(f), emotion recognition in workplace and education. <https://fpf.org/blog/red-lines-under-eu-ai-act-unpacking-the-prohibition-of-emotion-recognition-in-the-workplace-and-education-institutions/>. **S**. Applies to biometric-based inference in institutions; Spark is a family app and text-based, so it is a principle here, not a direct legal constraint. Not legal advice.
- Common Sense Media (2025). AI companions risk assessment. <https://www.commonsensemedia.org/press-releases/ai-companions-decoded-common-sense-media-recommends-ai-companion-safety-standards>. **S**.
- Learning styles: Pashler et al. (2008). APA (2019). **K**.

**Evidence boundary:** the 2026 NBER papers are unreviewed working papers. Several items were checked only through abstracts or secondary summaries (**S**). No source is used to claim more than its label allows. No AI-tutoring RCT with Norwegian primary-age children was found. Every claim about Spark's specific users is therefore INFERENCE until Packages A and B produce DIS data.

---

## 16. Method and local-offload record

- **Deterministic pass:** direct source inspection with grep and range reads of `spark.html`, `backend/src/index.js`, `PEDAGOGIKK-v5.3.md`, `TODO.md`, `REVIEW-v5.3.md`, `LES-MEG.md` and `docs/STABILIZATION-C2.md`. Feature inventory and line references were produced deterministically.
- **Queue V4:** eligibility was checked against the activation records (`C:\AI_ONE_LAB\handoffs\QUEUE_V4_*`) and the launcher contracts (`SNAPSHOT_ADMISSIONS.json`, client interface contract).
  - The only read path is the `APPROVED_SNAPSHOT_READ_ONLY_V1` guard, with two registered admissions (`mars-20261016-camera`, `mars-20261016-terrain`; 8 KB limits).
  - Spark source is not a registered snapshot. The C2 attempt was refused with `UNREGISTERED_SNAPSHOT`.
  - Registering a Spark admission would change the registry or policy, which this mission forbids.
  - Totals: **jobs submitted 0, qwen3.5 results 0, qwen3.8 results 0, direct model-port access 0, infrastructure or qualification changes 0.** Frontier reasoning handled the residue.
- **No application code was modified. Nothing was deployed.** The 45-check suite was not re-run, because this mission made no code changes.
