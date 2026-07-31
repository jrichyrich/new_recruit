# Live run: 2,000-point Custodes vs unknown Aeldari

> Historical evidence snapshot. Results and commands below describe the
> recorded 2026-07-30 run; use [Architecture](./architecture.md),
> [Workflow guide](./workflows.md), and [Certification](./certification.md) for
> the current product contract.

Date: 2026-07-30  
Result: complete baseline, complete paired revision, two focused workflow fixes

## Goal

Exercise the local RosterPilot workflow from natural-language roster creation
through validation, unknown-faction portfolio generation, New Recruit
enrichment, Tessera screening/deep dives, evidence-linked roster revision, and
paired comparison against the exact frozen opponents.

This run is directional combat math, not a game win probability. Terrain,
movement, mission sequencing, stratagem timing, player decisions, and
unmodeled rules remain outside Tessera.

## Data and runtime

- Pinned release: `2026-07-30.1`
- Rules package: `@alpaca-software/40kdc-data` `1.2.1`
- Official points: MFM `1.1`, content hash matched the live check
- New Recruit pin: `419a80d35346cd9bf26d32f69b4a5df404beb95d`
- Live New Recruit head: `21b4efa69d7212cb206fdcbf98aa606ee49f78a2`
- Freshness result: `update-available` because New Recruit advanced; the rules
  package and official points content did not
- Tessera and local-agent build after restart: `09baf64ccb9a7e93334a`

The roster and reports remain reproducible from the recorded pin. The newer
New Recruit commit still requires the normal reviewed data-update workflow.

## Baseline roster

RosterPilot built and validated this Shield Host roster at 1,995/2,000 points:

| Selection | Models | Points |
| --- | ---: | ---: |
| Shield-Captain, warlord | 1 | 110 |
| Custodian Guard with Adrasite and Pyrithite Spears | 5 | 250 |
| Agamatus Custodians | 6 | 450 |
| Witchseekers | 10 | 100 |
| Vertus Praetors | 3 | 215 |
| Aquilon Custodians | 6 | 390 |
| Aquilon Custodians | 6 | 390 |
| Witchseekers | 6 | 90 |

Validation returned `legal: true` with no violations. The only roster warning
was five unused points.

The list is a valid stress-test baseline, but it is not a collection-neutral
recommendation: 1,230 points are concentrated in two large Aquilon units and
one large Agamatus unit. A player-facing build should accept collection
constraints before treating this as a practical purchase or event list.

## Frozen Aeldari portfolio

The `core-3` preview produced three legal, exportable, exactly 2,000-point
proxies with unique simulation fingerprints:

| Proxy | Composition | Models | Distinguishing pressure |
| --- | --- | ---: | --- |
| balanced-control | mixed | 70 | Mobile bodies, Troupes, mounted units, Ghostglaive Wraithknight |
| ranged-pressure | mixed | 83 | Rangers, support characters, Troupes, mounted units, ranged Wraithknight |
| assault-pressure | elite-heavy | 44 | Three Troupes, Ghostglaive Wraithknight, Crimson Hunter, Fire Prisms, Night Spinners |

Named-character specialist evidence was evaluated separately from the three
core payloads, as designed.

The frozen weapon-profile policy selected:

- `Focused lances` for both Fire Prisms
- `Strike` for the Wraithknight's Titanic ghostglaive

## Baseline Tessera result

All three screening captures and all three staged deep dives completed on their
first attempts with verified matrix integrity.

| Proxy | Offensive coverage | Threat exposure | Coverage margin |
| --- | ---: | ---: | ---: |
| balanced-control | 81.00% | 25.81% | 55.19% |
| ranged-pressure | 80.75% | 10.03% | 70.72% |
| assault-pressure | 81.00% | 20.80% | 60.20% |

Key findings:

- Both six-model Aquilon units were robust answers across all three proxies.
- The Pyrithite Guard and Agamatus unit also had broad answer coverage.
- The Shield-Captain and six-model Witchseeker unit were materially exposed
  across all three proxies.
- Vertus Praetors were materially exposed into the balanced and elite-heavy
  proxies.
- Overall mission readiness was amber: strong control depth and reach, but
  only amber scoring breadth/action economy across the primary matrix.
- Evidence confidence remained `review` because Tessera warned that imported
  11th-edition combat effects were matched but not independently verified.

## Revised roster and paired result

RosterPilot proposed one evidence-linked, legality-checked operation:

`Witchseekers unit 2: 6 models -> 9 models`

The unit remains 90 points within its point bracket, so the revised roster is
still legal at 1,995 points. The paired comparison reused the exact three
frozen Aeldari archives and simulator settings.

| Proxy | Exposure before | Exposure after | Margin change | Classification |
| --- | ---: | ---: | ---: | --- |
| balanced-control | 25.81% | 25.81% | 0.00 pp | unchanged |
| ranged-pressure | 10.03% | 5.51% | +4.51 pp | improved |
| assault-pressure | 20.80% | 16.29% | +4.51 pp | improved |

Paired conclusion: `better` — two improved, zero worsened, one unchanged.
Offensive coverage did not regress, and the mission-readiness guardrail
remained accepted at amber.

## Issues and outcomes

### RP-LIVE-2K-01 — stale local agent blocked Tessera

Initial Tessera status returned `RUNTIME_RESTART_REQUIRED`: the MCP process
used build `09baf64ccb9a7e93334a`, while the local agent used an older source
fingerprint.

Outcome: the first restricted restart attempt was denied by the operating
environment; an approved per-user agent restart succeeded. The follow-up
status reported matching builds and ready New Recruit/Tessera credentials.

Classification: recoverable operational issue. The failure was explicit and
no external mutation started.

### RP-LIVE-2K-02 — weapon profiles required an explicit policy

The first full-loop attempt stopped with
`TESSERA_PROFILE_POLICY_REQUIRED` and wrote a scaffold before New Recruit or
Tessera activity.

Outcome: completed the policy with matchup-appropriate profiles, then reran.

Classification: intentional fail-closed behavior. A future interactive surface
could make this choice easier, but the engine must not guess silently.

### RP-LIVE-2K-03 — the initial staged MCP call exceeded five minutes

The `core-3` staged run used three quick screening browser passes followed by
three full deep-dive passes. New Recruit preparation plus those six passes
pushed the synchronous MCP call beyond its 300-second response limit. The
local agent completed the final deep dive and wrote a verified report after the
client timed out.

Recovery test: resuming from the completed manifest returned `complete` in
about 37 seconds, reused the player and all three prepared opponents, and
created no duplicate lists or Tessera attempts.

Fix: `core-3` now defaults to `full-all` when the caller does not specify a
strategy. Every core proxy is necessarily a representative, so one full pass
per proxy preserves the same required 48-scenario evidence while cutting the
browser-pass count from six to three. Explicit `staged` remains available for
recovery testing; `diverse-9` still defaults to staged analysis.

### RP-LIVE-2K-04 — paired recovery underreported frozen opponents

The paired revision hash-verified and reused three frozen opponent archives,
but its recovery summary reported `verifiedPreparedOpponents: 0` because it
counted only receipts stored in the new revision manifest.

Fix: the recovery summary now includes verified frozen-opponent paths. The
preparation summary remains separate and truthful: only the revised player was
newly prepared, with no opponent mutation.

### RP-LIVE-2K-05 — default list is legal but collection-skewed

Without collection constraints, the builder selected Forge World-heavy large
units. That is legal under the pin and performed well in Tessera, but it is a
poor universal default if the user does not own those models.

Follow-up: ask for or discover collection constraints before presenting a list
as practical. Keep unrestricted lists labeled as planning/stress candidates.

### RP-LIVE-2K-06 — proxy labels need human interpretation

The elite-heavy `assault-pressure` proxy includes meaningful Troupe and
Ghostglaive pressure, but also a large ranged vehicle package. The label is a
deterministic coverage posture, not a metagame claim or a promise that most
points are melee-only.

Follow-up: keep composition evidence visible beside posture labels. Consider a
future threat-share metric based on modeled weapon profiles rather than unit
tags alone.

## Verification

The focused changes passed:

- `tests/stress-core.test.ts`: 9 passed
- `tests/tessera-stress-orchestration.test.ts`: 6 passed
- ESLint on `local/tessera/stress.ts` and
  `tests/tessera-stress-orchestration.test.ts`: passed

The live baseline and paired revision both reported verified integrity and no
simulation failures. Community data remains a planning source; event-specific
rulings should still be confirmed before play.
