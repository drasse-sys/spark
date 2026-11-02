# SPARK UX1 — mobile touch and interaction hardening (2026-11-02)

Baseline: `main` 3120ff3219e23028074715eb384e71301a32a391 (identical to production GitHub Pages assets, verified by blob hash).

## Real-phone report

Android (Vivaldi/Chromium), child Olav, mode Matte, ladder label «Et hint · velg hjelp når du vil». The quick choices
«1. Lite puff … Pause / for vanskelig» did not respond to taps; typed text worked.

## Diagnosis

Reproduced in real Chromium (Playwright, `isMobile`, `hasTouch`, touchscreen taps at hit-tested coordinates) with the
exact assistant message and a mocked provider.

| Candidate cause | Result |
| --- | --- |
| Handler binding / stale handlers after re-render | Ruled out. Handlers are rebound on every render; enabled buttons receive real taps. |
| Re-render during the finger press (TTS `onstart`/`onend` call `render()`) | Ruled out. 0/10 taps lost with `render()` forced between touchstart and touchend; Chromium hit-tests the tap at gesture time. |
| Overlay / hit testing / stacking at 320–412 px | Ruled out. `elementFromPoint` at five points per control finds the control itself; quick, doneBar and footer do not overlap. |
| Service worker / stale assets | Ruled out. Production assets are byte-identical to `main`; the SW is network-first. |
| **Disabled-state policy with invisible disabled state** | **Confirmed.** See below. |
| **Busy state with wrong semantics** | **Confirmed.** See below. |

The screen state is S2 with no attempt yet (the default profile age is 8). Under the existing policy
(`n > 2 && s < n-1 && !attempts` locks rung n):

| Control | Policy state | Before UX1 |
| --- | --- | --- |
| 1. Lite puff | ENABLED (first tap at age 8+ is the existing soft guard: local «Prøv ett steg først?», no provider call) | works |
| 2. Lite hint | ENABLED (same soft guard) | works |
| 3. Mindre steg | ENABLED (same soft guard) | works |
| 4. Vis et eksempel | **DISABLED** until the child has tried once | natively disabled but **looked identical** to the enabled buttons; a tap silently did nothing |
| Jeg vet ikke | ENABLED | works |
| Pause / for vanskelig | ENABLED | works |

While a reply is pending (`busy`), which on a mobile network or during provider fallback can take many seconds:

* rungs 1–4 were natively disabled but looked enabled;
* «Jeg vet ikke» and «Pause» were **not disabled at all** — they looked and announced as active, but their handlers return early;
* «Sjekk svaret», «Prøv én lignende», «Hopp over/Ferdig med denne», «Neste deloppgave» and the reading prompts were the same;
* header back/new/settings and the microphone were disabled with no visual difference.

Root cause: controls that cannot act were indistinguishable from controls that can, and several were not even
semantically disabled. A tap on any of them is a silent no-op. Enabled controls were not broken; we could not
reproduce a failure of an enabled control on a real-touch Chromium pipeline.

## Repair (no policy change)

* `learning-ui.js`: every control whose handler would ignore the tap is rendered with native `disabled`
  («Jeg vet ikke» on busy/pendingFinal, «Pause» on busy, learning-panel and reading actions on busy). Handler guards are kept.
* `spark.html`: `.qb:disabled` is dashed, grey and dimmed with `cursor:not-allowed`; `.qb:active` no longer animates a
  disabled button; `.hbtn:disabled`, `.mic:disabled` and `.send:disabled` are dimmed.
* `sw.js`: cache generation bumped so installed PWAs refresh the changed assets.

## Regression coverage

`tests/browser-mobile-touch-check.mjs` (added to CI) uses touchscreen taps only, at the hit-tested centre of each
control, after asserting that the control is unobscured at five points, inside `#app`, inside the viewport and at
least 24 px. It reproduces the observed state, asserts the policy table above, verifies that the disabled rung is
visually distinct and inert, that every busy control is disabled and inert, and that every enabled control produces
exactly one action per tap. It covers the chat, learning panel, start screen and header controls listed in the brief,
a 320–412 px width matrix with the chat scrolled away from the bottom, and desktop mouse plus keyboard Enter/Space/Tab.

Negative controls (new test against modified product code):

1. Unmodified `main`: fails «4. Vis et eksempel: disabled control is not dimmed (opacity 1)».
2. CSS repair only: fails «Jeg vet ikke: must be disabled while a reply is pending».
3. Busy semantics only: fails «4. Vis et eksempel: disabled control is not dimmed».
4. doneBar shifted 24 px over the quick bar: fails «pause (busy): covered … by #doneBtn».
5. `.quick{pointer-events:none}`: fails «4. Vis et eksempel (disabled): covered … by #app».

## Residual limits

* Real Android TTS, virtual keyboard, OS font scaling and Vivaldi chrome cannot be reproduced in headless Chromium.
* The age 8+ soft guard answers the first help tap locally by design; a child may read it as «nothing happened».
* A help tap replaces any unsent draft in the message box with the canned help request (existing behaviour, unchanged).
* The policy-locked rung gives no visible reason why it is locked.
