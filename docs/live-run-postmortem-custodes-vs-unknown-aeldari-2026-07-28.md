# Live-run postmortem: Custodes vs unknown Aeldari

> Historical evidence snapshot. Issue states and commands below describe the
> recorded 2026-07-28 run; use [Architecture](./architecture.md),
> [Workflow guide](./workflows.md), and [Certification](./certification.md) for
> the current product contract.

The reusable, credential-free regression evidence from this run is preserved
in
`tests/fixtures/tessera-v2/unknown-aeldari-live-run.sanitized.json`. It covers
the alternate-profile decisions, premium unlock failures, duplicate payload
signal, zero-confident evidence shape, and bounded retry state without remote
list URLs, local paths, or credentials.

Date: 2026-07-28
Run ID: `0fdc8bd1-bf2d-4c77-ae68-8f30f769a50a`
Pinned release: `2026-07-28.1`
Workflow: 1,000-point Adeptus Custodes build followed by a `diverse-9`,
staged Tessera stress test against an unknown Aeldari list

## Repair implementation status

Implemented as the schema-v2 reliability upgrade:

- LR-01/02/15: canonical intent parsing, structured opponent context,
  deterministic roster repair, readiness/points gating, and descriptive names;
- LR-03/07/08: explicit profile policies, unit-local ambiguity,
  null-versus-provisional estimates, and truthful status precedence;
- LR-04/09/10: bounded unlock polling, distinct failure codes, retry metadata
  and ceilings, and run-scoped isolated Tessera session state;
- LR-05/06/12: simulation-payload uniqueness, stronger composition rules,
  deliberate named-anchor coverage, and template-prefixed warnings;
- LR-11/13/14: compact CLI output, portable report references,
  content-addressed verified New Recruit reuse, and a non-destructive remote
  list inventory.
- Follow-up live-run hardening: content fingerprints preserve matrix
  provenance, while observed table replacement or matrix-subtree mutation
  proves a control refresh. Equal numeric results remain valid; a control
  transition with no table refresh is retained only as `inconclusive`
  diagnostic evidence.
- Staged orchestration now freezes representatives only after every required
  screen is complete and confident. Five-attempt runs can be restarted into a
  new output directory while reusing only verified preparation artifacts.
- Change candidates now require causal evidence, legal New Recruit export,
  at least 98% points utilization, non-regressing mission readiness, and
  protection for units already classified as reliable or robust answers.

The historical outcome below describes the original schema-v1 run and is
retained as regression evidence. It is not the behavior of the repaired
workflow.

## Outcome

The end-to-end workflow successfully built and validated a legal Custodes
roster, created and verified one player list and nine frozen Aeldari proxy
lists through New Recruit, ran seven complete screening simulations, persisted
all receipts and hashes, retried the two partial simulations without creating
duplicate lists, and produced JSON, HTML, and resume-manifest artifacts.

The combat result was inconclusive. RosterPilot correctly withheld robustness
aggregates and change recommendations because none of the nine proxies reached
the required 80% non-ambiguous point coverage. No representative deep dives
were selected.

The final report calls the run `degraded`, but zero usable samples and no deep
dives make `partial` or an explicit `inconclusive` outcome more accurate.

## Artifacts

- Player roster:
  `exports/custodes-vs-unknown-aeldari-1000/custodes-1000.json`
- Printable player roster:
  `exports/custodes-vs-unknown-aeldari-1000/custodes-1000.html`
- Stress report:
  `exports/custodes-vs-unknown-aeldari-1000/stress/RosterPilot-Draft-vs-aeldari-stress-test.json`
- Interactive report:
  `exports/custodes-vs-unknown-aeldari-1000/stress/RosterPilot-Draft-vs-aeldari-stress-test.html`
- Resume manifest:
  `exports/custodes-vs-unknown-aeldari-1000/stress/stress-manifest.json`

These artifacts are local operational evidence, not committed fixtures. Any
future regression fixture derived from them must remove list URLs, absolute
paths, and unrelated matrix cells.

## What worked and must remain true

1. Data and legality stayed pinned. The roster and all proxies used release
   `2026-07-28.1`; the Custodes roster validated with no violations.
2. The full `diverse-9` portfolio was buildable and New Recruit-exportable.
   All nine intended templates were prepared.
3. Remote mutations were bounded. The first run created one player copy and
   nine opponent copies. Resume reused those receipts and enriched files.
4. Resume retried only the two partial screening entries. Their report
   timestamps changed to `17:36:54` and `17:36:57`; the other seven reports
   retained their original timestamps.
5. The system failed closed. Ambiguous profile imports did not become confident
   probabilities, representatives, deep dives, or roster-change advice.
6. Mission readiness remained separate from combat results and identified a
   real roster weakness: action economy was red while control depth, reach,
   durable contesting, and home continuity were green.
7. The report stated that its proxy weights are coverage weights, not
   metagame-frequency or game-win probabilities.

## Issues observed

### LR-01 — Requested build intent was lost

Priority: P1

The prompt requested mobility, objective control, durability, and mixed threat
coverage. The stored roster retained only `objective` in `preferences`.
`parseRosterPrompt` recognizes aliases such as `mobile` and `durable`, but not
the canonical nouns `mobility` and `durability`; it also has no structured
concept for `mixed threat coverage` or an opponent faction.

Impact:

- The build was a generic objective roster, not an explicit anti-Aeldari or
  all-comers roster.
- The four-selection result concentrated 780 points in two units.
- The expensive live workflow started before checking whether the roster
  reflected the user's full intent.

Relevant code:

- `lib/rosterpilot/engine.ts` — `PREFERENCE_ALIASES`,
  `parseRosterPrompt`, and `normalizeBuildInput`
- `cli/rosterpilot.ts` — build argument construction

### LR-02 — The initial roster was legal but not workflow-ready

Priority: P1

The roster was 965/1,000 points with 35 points unused:

- Blade Champion — 110
- Prosecutors — 75
- Allarus Custodians, six models — 330
- Agamatus Custodians, six models — 450

Mission readiness was red because only one cheap action unit was available.
Three of five primary mission matchups were red. The workflow nevertheless
spent time creating ten remote lists before surfacing this deterministic
guardrail.

Impact:

- The roster used only four selections and had fragile action economy.
- A deterministic, inexpensive warning was discovered after expensive browser
  preparation rather than before it.
- The greedy builder did not backtrack, consider enhancements, or optimize
  mission readiness after reaching 965 points.

Relevant code:

- `lib/rosterpilot/engine.ts` — greedy candidate selection
- `lib/rosterpilot/mission-readiness.ts`
- `local/tessera/stress.ts` — mission analysis currently occurs after
  simulation

### LR-03 — Alternate-profile warnings invalidated every combat sample

Priority: P0 for usefulness, although the current fail-closed behavior is
correct

The Custodes Blade Champion imported with an alternate Vaultswords profile.
Seven completed Aeldari proxies also imported either a Titanic Ghostglaive or
Prism Cannon alternate profile. The current consolidation assigns the entire
attacking side the confidence implied by any import warning. One ambiguous
weapon profile therefore marks every cell for that side ambiguous.

Impact:

- All nine samples had zero non-ambiguous point coverage.
- No robustness aggregate, representative, deep dive, unit conclusion, or
  change candidate could be produced.
- A warning tied to one weapon profile invalidated unrelated units.

This is both a workflow gap and an over-broad confidence model. RosterPilot
must not silently choose a profile, but it can localize uncertainty to the
affected unit and support an explicit, reproducible profile-selection policy.

Relevant code:

- `local/tessera/companion.ts` — `warningConfidence` and
  `consolidateBrowserScenarios`
- `local/tessera/browser.ts` — imported warning capture
- `local/tessera/stress-analysis.ts` — 80% point-coverage gate

### LR-04 — Tessera premium unlock had a race and misleading error

Priority: P1

The first seven proxies completed, while the final two repeatedly returned:

`Tessera Army vs Army requires a configured premium key.`

Preflight and post-run agent status both showed the Tessera credential as
configured and ready. `openArmyMatrix` calls `unlockPremium`, then immediately
recurses with `licenseKey` set to `undefined`. If the UI still appears locked
for a moment, the recursive call reports that no key is configured even though
the key was just supplied.

Impact:

- `assault-pressure:mass` and `assault-pressure:elite-heavy` captured zero
  scenarios.
- Resume retried them, but the same race recurred.
- The message incorrectly directed diagnosis toward credential setup.

Relevant code:

- `local/tessera/browser.ts` — `unlockPremium` and `openArmyMatrix`
- `local/tessera/worker.ts` — per-job key retrieval
- `local/agent/server.ts` — one fresh browser worker/profile per proxy

### LR-05 — Portfolio labels overstated list diversity

Priority: P1

Five of the nine proxy templates used the same unit/model payload:

`Farseer Skyrunner, Starweaver, Ynnari Raider, Voidweaver, Falcon,
Wraithknight with Ghostglaive, Night Spinner`

They differed mainly by detachment and disposition. Two mass templates also
shared the same unit payload. Structural deduplication includes detachment, so
these lists count as distinct even when the Tessera combat payload is nearly
identical.

The `mixed` composition has no positive constraints, while `elite-heavy`
requires only 40% elite/Vehicle/Monster points. The observed `mixed` lists were
100% elite-heavy by that measure. The mass lists had 40–44 models but still
spent 82–91% of their points on elite-heavy units.

Impact:

- Equal weighting overrepresented repeated combat payloads.
- `mixed`, `elite-heavy`, and some posture labels did not describe materially
  different simulated armies.
- Nine prepared lists did not equal nine independent coverage cases.

Relevant code:

- `lib/rosterpilot/stress-portfolio.ts` — `structuralTokens`,
  `rosterStructuralFingerprint`, `compositionSatisfied`, `templateFit`, and
  candidate selection

### LR-06 — Named-character uncertainty was not represented

Priority: P2

All nine selected Aeldari proxies had `allowNamedCharacters: false`, despite
the candidate search permitting both values. Unknown Aeldari lists can include
named anchors, but the frozen suite represented none.

Impact:

- The suite omitted a meaningful faction-list axis.
- Candidate ordering, rather than an explicit coverage decision, determined
  named-character coverage.

Relevant code:

- `lib/rosterpilot/stress-portfolio.ts` — candidate search and suite selection

### LR-07 — Zero evidence was rendered as a numeric zero

Priority: P1

For seven proxies, cells existed but every cell was ambiguous.
`directionalCoverage` returned `0` for offensive coverage and exposure because
known non-ambiguous points were zero. The sample status was `ambiguous`, but a
numeric zero can be graphed or read as “no offensive capability” rather than
“no usable evidence.”

Impact:

- Machine consumers can misinterpret an absence of evidence as measured zero.
- The HTML report can visually anchor users on a false zero even though the
  aggregate correctly excludes the sample.

Relevant code:

- `local/tessera/stress-analysis.ts` — `directionalCoverage` and
  `sampleForItem`
- `local/tessera/stress-report.ts` — ambiguous-sample rendering

### LR-08 — Run status overstated completion

Priority: P1

The final report status was `degraded` even though:

- zero of nine samples were confident;
- two screening proxies had zero scenarios;
- no representatives were selected; and
- no deep-dive stage ran.

`executionStatus` grants `degraded` based on six complete scenario sets across
three postures without checking usable confidence or whether staged deep dives
occurred. In `full-all`, `deepComplete` is automatically true, so a fully
captured but entirely ambiguous run could potentially be called `complete`.

Impact:

- `degraded` sounds decision-usable when the result is actually inconclusive.
- Automation may treat the report as a usable baseline even though paired
  revision admission later rejects it.

Relevant code:

- `local/tessera/stress.ts` — `executionStatus`
- `local/tessera/stress-analysis.ts` — robustness confidence

### LR-09 — Retry state lost the actionable error code

Priority: P2

The child report retained only a warning string. The stress manifest converted
both failures into the generic message:

`Tessera did not capture every requested scenario; resume will retry this
proxy.`

The manifest does not record attempt count, last error code, retryability,
first/last attempt time, or a retry ceiling.

Impact:

- A premium unlock race, a changed UI, and an incomplete matrix all look alike.
- Repeated resume can retry a terminal problem indefinitely.
- Operators cannot distinguish “retry later” from “fix configuration/code.”

Relevant code:

- `local/tessera/companion.ts` — browser error to report-warning conversion
- `local/tessera/stress.ts` — stage manifest entries and `runStage`

### LR-10 — Bulk Tessera execution was unnecessarily fragile

Priority: P2

Each proxy used a fresh temporary browser profile and a new worker. That
required repeated premium unlocks and repeated UI initialization.

Impact:

- Nine screens create nine opportunities for unlock and timing failures.
- Startup work dominates a short screening scenario.
- A batch cannot share a verified live readiness state.

Relevant code:

- `local/tessera/companion.ts` — per-opponent temporary profile
- `local/agent/server.ts` — per-request temporary Tessera worker

### LR-11 — CLI output was too large for an operational command

Priority: P2

Each stress command printed the complete nested report. The output exceeded
one megabyte and was truncated by the calling environment. The useful summary
and artifact paths were buried inside portfolio rosters and matrix cells.

Impact:

- Humans cannot monitor progress or quickly understand the outcome.
- CI and agent logs become noisy and expensive.
- Truncation can hide the final warnings even though files are intact.

Relevant code:

- `cli/rosterpilot.ts` — `print` and stress-test command output

### LR-12 — Warnings lacked proxy context

Priority: P2

The top-level report contained bare warnings such as `5 points remain unused`
and `15 points remain unused` without naming the affected Aeldari proxy.

Impact:

- The user must search nested portfolio entries to identify the list.
- Deduplicated warning text can hide how many proxies share an issue.

Relevant code:

- `local/tessera/stress.ts` — top-level warning aggregation

### LR-13 — Shareable JSON was not portable

Priority: P2

The machine-readable report includes user-specific absolute paths to prepared
rosters and run artifacts. The manifest requires local paths, but a shareable
report should not.

Impact:

- Reports expose local directory structure.
- Moving the output directory breaks path references.
- A downloaded repository or shared report is less portable.

Relevant code:

- `local/tessera/stress.ts` — report assembly and artifact references
- `lib/rosterpilot/types.ts` — prepared roster/report types

### LR-14 — Repeated live runs can clutter New Recruit

Priority: P2

This run correctly created ten new lists and did not delete or replace any
existing list. That is safe, but future uncached runs will create another ten.
The run records their URLs but offers no inventory or explicit cleanup
handoff.

Impact:

- Repeated development and comparison runs accumulate remote lists.
- Users cannot easily identify which copies belong to an expired run.

Deletion must remain separately authorized. The improvement should be content
reuse, run-scoped naming, and a cleanup inventory—not automatic deletion.

### LR-15 — Generated names were generic

Priority: P3

The player list and report were called `RosterPilot Draft`, even though the
request and output directory clearly described Custodes versus unknown
Aeldari.

Impact:

- New Recruit list management and report discovery are harder.
- Multiple runs can have visually identical player names.

### LR-16 — Runtime warning added noise

Priority: P3

Every CLI invocation printed the Node `module.register()` deprecation warning.
The setup doctor also noted that local Node 26 differs from the Node 22.13 CI
baseline.

Impact:

- Real workflow warnings are easier to miss.
- Local behavior is not running on the exact supported baseline.

## Repair plan

### Phase 0 — Preserve this run as a sanitized regression case

1. Add small fixtures for:
   - one complete scenario with a localized alternate-profile warning;
   - one zero-scenario `TESSERA_PREMIUM_REQUIRED` result;
   - nine portfolio metadata records showing repeated combat payloads;
   - a zero-confident-sample aggregate; and
   - a two-entry partial resume manifest.
2. Remove list URLs, absolute paths, credentials, and unnecessary matrix cells.
3. Add a test that reconstructs the observed outcome before changing logic.

Exit criteria:

- The fixture reproduces zero confident samples, two retryable entries, no
  representatives, and the current misleading status.
- No private path or remote list URL is committed.

### Phase 1 — Correct result semantics before improving automation

1. Change `directionalCoverage` to return `null`, not `0`, when no
   non-ambiguous target points are known.
2. Keep provisional ratios separate from confident ratios when point coverage
   is below 80%.
3. Make run status depend on both capture completeness and analytical
   confidence:
   - `complete`: every required stage is complete and confidence requirements
     are satisfied;
   - `degraded`: at least six confident `diverse-9` samples cover all three
     postures and all three deep dives are complete;
   - `partial` or `inconclusive`: insufficient confident coverage, missing
     representatives, or skipped deep dives.
4. Ensure `full-all` cannot be `complete` with zero confident samples.
5. Render a prominent “No combat conclusion” state and exclude ambiguous nulls
   from charts.

Exit criteria:

- This captured run is classified `partial`/`inconclusive`.
- Its ambiguous samples contain null combat values.
- No report or API consumer can infer a measured zero.

### Phase 2 — Add explicit alternate-profile handling

1. Parse import warnings into structured records containing side, unit,
   weapon, available profiles, and affected phases.
2. Assign ambiguity only to affected unit/profile cells, not the entire side.
3. Add a pre-simulation profile-resolution step:
   - apply a committed deterministic choice only when data identifies an
     unambiguous default;
   - accept an explicit profile-policy file for known multi-profile weapons;
   - otherwise stop before bulk simulation with an actionable list of choices.
4. Freeze selected profiles in the manifest, execution fingerprint, stage
   provenance, and paired revision comparison.
5. Add a non-interactive policy mode that is explicit about its rule, such as
   `first-profile`, but never make it the silent default.

Exit criteria:

- A Blade Champion warning affects only the Blade Champion.
- The user can resolve Vaultswords, Prism Cannon, and Ghostglaive profiles once
  and reuse those choices across all proxies and revisions.
- A rerun cannot change profile selections without failing provenance checks.

### Phase 3 — Fix Tessera premium unlock and batch reliability

1. Keep the license key available across the post-unlock recheck.
2. Wait for a positive unlocked UI state before recurring; do not infer
   “missing key” from a delayed UI update.
3. Emit distinct structured codes for:
   - key absent;
   - key rejected;
   - unlock timed out;
   - premium UI still locked;
   - matrix unavailable; and
   - scenario capture incomplete.
4. Add bounded retries with backoff for unlock timing only.
5. Add a batch Tessera agent operation that reuses one isolated browser context
   for a stress stage, retrieving the key once and processing multiple frozen
   opponents.
6. Run a live unlock/matrix probe before starting a large batch.

Exit criteria:

- A delayed unlock test never becomes `TESSERA_PREMIUM_REQUIRED`.
- The final two proxies complete under an injected delayed UI transition.
- A real absent key fails before any simulation and names the exact remedy.

### Phase 4 — Make the opponent portfolio materially diverse

1. Introduce a simulation-payload fingerprint based on units, model counts,
   equipment, enhancements, and only those rule selections Tessera actually
   models.
2. Deduplicate and distance-rank on that fingerprint in addition to the
   rule-bearing execution fingerprint.
3. Define positive composition constraints:
   - `mixed`: neither mass nor elite-heavy; require meaningful role and points
     spread;
   - `mass`: require a substantial model/body share and cap elite-anchor share;
   - `elite-heavy`: require a high elite/Vehicle/Monster points share and a low
     body-count band.
4. Make posture fit use combat-relevant weapon/unit traits rather than broad
   unit tags alone.
5. Require explicit named-character coverage for factions where legal named
   anchors exist.
6. If nine materially distinct payloads cannot be built, mark templates
   unavailable or collapse their weight; do not present repeated payloads as
   nine independent lists.
7. Add a dry-run portfolio preview showing payload fingerprints, pairwise
   distance, named-character coverage, profile-policy requirements, and
   New Recruit exportability before remote mutation.

Exit criteria:

- `mixed` and `elite-heavy` cannot select the same unit/model payload.
- No two equal-weight proxies share the same simulation-payload fingerprint.
- The Aeldari suite either contains named-character coverage or explains why
  it is unavailable.
- Template labels match measured composition traits.

### Phase 5 — Make roster building readiness-aware

1. Recognize canonical preference names (`mobility`, `durability`, and so on)
   in natural-language prompts.
2. Add structured opponent intent instead of relying on unparsed prose:
   `--against-faction aeldari`.
3. Represent mixed-threat intent explicitly.
4. Replace or augment the greedy fill with bounded backtracking/knapsack search
   to improve points utilization and unit-role breadth.
5. Run mission readiness immediately after build and before New Recruit.
6. Add a configurable preflight gate for action economy and minimum points
   utilization.
7. Generate a descriptive default name from faction, points, and opponent
   intent.
8. Provide deterministic repair suggestions when the gate fails instead of
   silently proceeding.

Exit criteria:

- The original prompt retains mobility, durability, objective, and mixed
  threat intent.
- A 1,000-point build uses at least 980 points unless the report proves no
  legal improvement exists.
- The preflight identifies red action economy before any remote list is
  created.
- The output and New Recruit list have a descriptive run-scoped name.

### Phase 6 — Make retries auditable and bounded

1. Extend each manifest stage entry with attempt count, first/last attempt
   times, structured error code, retryable flag, and next action.
2. Preserve child browser error codes instead of reducing them to warning text.
3. Retry only classified transient errors and cap automatic attempts.
4. Keep explicit `--resume` for a user-authorized new retry window.
5. Include retry history in the final report without including secrets.

Exit criteria:

- The two observed premium failures show their actual code and attempt count.
- A terminal error does not loop on resume.
- Resume still creates no duplicate New Recruit lists.

### Phase 7 — Improve CLI and artifact portability

1. Print a compact stress summary by default: run ID, status, prepared/complete/
   confident counts, representatives, mission band, warnings, and artifact
   paths.
2. Add an explicit flag for the complete nested JSON payload.
3. Emit progress events for preparation, screening, retries, deep dives, and
   finalization.
4. Prefix portfolio warnings with their template IDs.
5. Keep absolute paths in the local manifest only. Use relative artifact
   references or sanitized basenames in shareable JSON and HTML.
6. Add a portable bundle/export command.
7. Record a run-scoped New Recruit inventory and support reuse by content hash.
   Offer cleanup instructions, but require separate authorization for deletion.
8. Align local development with Node 22.13 or update the loader before adopting
   Node 26.

Exit criteria:

- Default CLI output stays below 50 KB for `diverse-9`.
- No shareable report contains the user's home or checkout path.
- Every warning identifies its roster or template.
- A repeated frozen run can reuse prepared content without new remote lists.

## Test plan

### Unit tests

- Prompt parser recognizes canonical preference nouns and opponent intent.
- Builder search improves or proves maximal points utilization.
- `directionalCoverage` returns null for zero known points.
- `executionStatus` rejects zero-confidence and missing-deep-dive runs.
- Warning localization affects only the named unit/profile.
- Composition predicates reject the observed mislabeled Aeldari lists.
- Simulation-payload fingerprint collapses the five repeated payloads.
- Named-character coverage is selected intentionally.
- Manifest retry metadata and terminal/transient classification are stable.

### Integration tests

- Tessera unlock UI changes state after a delay.
- One metric/profile warning does not contaminate unrelated cells.
- Two partial proxies resume without another New Recruit delivery.
- A terminal key failure stops before the nine-proxy stage.
- Compact CLI output points to a complete on-disk report.
- Portable report round-trips after moving its output directory.

### Live acceptance sequence

1. Run `core-3` against Aeldari as a smoke test.
2. Confirm live premium readiness and all required profile selections.
3. Preview and approve the materially distinct `diverse-9` portfolio.
4. Run staged screening.
5. Require at least six confident proxies covering all three postures before
   choosing stress, central, and contrast representatives.
6. Complete all three deep dives.
7. Resume one deliberately interrupted proxy and verify no duplicate New
   Recruit list appears.
8. Run a frozen paired roster revision and verify exact profile, setting,
   iteration, and opponent-artifact parity.

## Definition of done

The repair is complete when a fresh 1,000-point Custodes-versus-unknown-Aeldari
run:

- preserves all build intent and passes preflight readiness or clearly stops;
- prepares a materially diverse, auditable opponent suite;
- resolves or localizes alternate-profile uncertainty;
- completes at least six confident screens across all three postures;
- selects and completes three representative deep dives;
- reports null rather than zero for missing evidence;
- uses a truthful complete/degraded/inconclusive/partial status;
- survives a delayed premium unlock and a resumed partial proxy;
- creates no duplicate list during resume;
- prints a compact terminal summary;
- produces portable shareable artifacts; and
- passes lint, the full test/build suite, data checks, and the live acceptance
  sequence above.
