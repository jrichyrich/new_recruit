# RosterPilot workflow guide

RosterPilot has four independent operations: build and validate, export or
deliver, compare known lists, and stress-test against an unknown list from a
known faction. A validated roster is a complete result. No later operation
starts unless that specific action is requested.

The first recorded live unknown-list faction run and its evidence-backed repair
plan are documented in
[Live-run postmortem: Custodes vs unknown Aeldari](./live-run-postmortem-custodes-vs-unknown-aeldari-2026-07-28.md).

## Choose a workflow

| Goal | Setup profile | Platforms | External side effect |
| --- | --- | --- | --- |
| Build, edit, validate, print, or save a roster | `core` | macOS, Linux, Windows | None |
| Use RosterPilot through a local MCP client | `mcp` | macOS, Linux, Windows | None |
| Export `.rosz` for manual New Recruit import | `core` | macOS, Linux, Windows | None until the player imports it |
| Upload and verify a new New Recruit list | `new-recruit` | macOS | Creates a new list only after an explicit delivery command |
| Compare known armies and collect Tessera simulations | `tessera` | macOS | Creates verified New Recruit list copies during profile enrichment, then runs Tessera only with `--experimental` |
| Test a roster against an unknown list from a known faction | `tessera` | macOS | Creates one player copy plus three `core-3` or six-to-nine `diverse-9` proxy copies when the verified cache cannot satisfy them; runs Tessera only with `--experimental` |

The macOS limitation belongs only to credential-backed browser automation. The
deterministic engine, web app, CLI, local MCP, validation, and file exports are
portable.

## First-time setup

From a fresh clone:

```bash
nvm use
npm run setup -- --profile core
```

Use the smallest cumulative profile that includes the surface you need:

```bash
npm run setup -- --profile mcp
npm run setup -- --profile new-recruit
npm run setup -- --profile tessera
```

`new-recruit` includes `core` and `mcp`. `tessera` includes those capabilities
plus New Recruit enrichment because Tessera needs profile-rich `.rosz` files.
Installing a profile does not run a delivery or simulation.

Check the current machine without changing it:

```bash
npm run doctor -- --profile core --refresh skip
npm run rosterpilot -- workflows
```

If the repository or Node installation moves, rerun the selected setup profile.
The local-agent status rejects an agent installed from another checkout instead
of silently using stale worker code.

## Workflow 1: build and stop

Build a canonical roster:

```bash
npm run rosterpilot -- build \
  --faction aeldari \
  --points 1000 \
  --preferences mobility,shooting,objective \
  --out aeldari.json
```

Then validate, explain, or export it independently:

```bash
npm run rosterpilot -- validate --file aeldari.json
npm run rosterpilot -- explain --file aeldari.json
npm run rosterpilot -- export --file aeldari.json --format html --out aeldari.html
```

Nothing is uploaded. The browser builder provides the same build, edit,
validation, JSON, text, and print workflow with device-local draft history.

## Workflow 2: New Recruit

For a manual handoff on any core platform:

```bash
npm run rosterpilot -- export \
  --file aeldari.json \
  --format rosz \
  --out aeldari.rosz
```

This succeeds only when every selected reference is mapped and conflict-free.
It does not open New Recruit or create a list.

On a configured Mac, direct delivery is a separate explicit action:

```bash
npm run rosterpilot -- new-recruit deliver \
  --file aeldari.json \
  --enriched \
  --out-dir exports/new-recruit
```

Delivery creates a new list, verifies its name, faction, points, and units, and
optionally downloads Pretty HTML and an enriched `.rosz`. It never replaces or
deletes an existing list.

## Workflow 3: exact-list Tessera comparison

Tessera accepts one canonical player roster and exactly one opponent source:

- `--opponent-roster enemy.json` for another RosterPilot roster;
- `--opponent-file enemy.rosz` for an existing exported list;
- `--opponent-faction necrons` for deterministic faction proxies.

Run a quick directional smoke comparison:

```bash
npm run rosterpilot -- tessera analyze \
  --file aeldari.json \
  --opponent-roster enemy.json \
  --analysis-mode quick \
  --experimental \
  --out-dir exports/tessera-quick
```

Use the default `full` mode for both phases, all four metrics, and both attack
directions. The output directory contains preserved handoff files, a
machine-readable report, and an interactive HTML report.

Tessera preparation uses New Recruit to obtain verified profile-rich archives,
so it creates new list copies as part of this explicitly requested workflow.
Without `--experimental`, RosterPilot stops after the verified handoff and
returns a labeled partial report. A comparison never edits the source roster;
change candidates remain suggestions until a revised roster is explicitly
saved and compared.

## Workflow 4: known-faction stress test

Use a stress test when the player's roster is known but the opponent's exact
list is not. The faction is required:

```bash
npm run rosterpilot -- tessera preview-portfolio \
  --against-faction aeldari \
  --points 1000 \
  --suite diverse-9

npm run rosterpilot -- tessera build-and-stress \
  --prompt "Build a mobile, durable 1,000 point Custodes army" \
  --against-faction aeldari \
  --suite diverse-9 \
  --analysis staged \
  --profile-policy profiles.json \
  --experimental \
  --out-dir exports/custodes-vs-aeldari
```

The full-loop command builds and validates, performs a bounded deterministic
repair, gates mission readiness and 98% points utilization, previews portfolio
uniqueness, checks explicit profile choices, prepares or reuses New Recruit
artifacts, runs Tessera, and writes a portable report. It never applies the
reported roster-change candidates. Use `--allow-readiness-warnings` only after
reviewing the gate.

For an existing roster, start directly at stress testing:

```bash
npm run rosterpilot -- tessera stress-test \
  --file aeldari.json \
  --against-faction necrons \
  --profile-policy profiles.json \
  --experimental \
  --out-dir exports/aeldari-vs-necrons-stress
```

The defaults are `--suite diverse-9` and `--analysis staged`. The suite
options are:

- `core-3`: balanced-control, ranged-pressure, and assault-pressure postures,
  all with mixed composition;
- `diverse-9`: those three postures crossed with mixed, mass, and elite-heavy
  composition.

RosterPilot builds each proxy deterministically from the pinned data release.
Every proxy must be legal, exportable, within 5% of the points limit, and
distinct by its modeled unit/model/equipment/enhancement payload; changing only
the detachment is not enough. `core-3` requires all three unique postures.
`diverse-9` targets nine and may continue with six to eight only when all three
postures remain represented. It renormalizes equal weights and caps the result
at `degraded`; fewer than six fails before external activity.

The analysis strategies are:

- `staged`: screen every available proxy with half-wipe probability in
  Shooting and Fight, in both directions, then run wipe probability, mean
  kills, and mean damage on three frozen stress, central, and contrast
  representatives;
- `full-all`: run all four metrics, both phases, and both directions against
  every available proxy.

A complete `diverse-9` run therefore contains 72 raw scenarios in staged mode
or 144 in full-all mode. Use the smaller suite for a smoke test:

```bash
npm run rosterpilot -- tessera stress-test \
  --file aeldari.json \
  --against-faction necrons \
  --suite core-3 \
  --analysis full-all \
  --experimental \
  --out-dir exports/necrons-core
```

Before delivery, the command scans multi-profile equipment. Unresolved choices
return `TESSERA_PROFILE_POLICY_REQUIRED` and a
`tessera-profile-policy.scaffold.json`. Complete its `selectedProfile` values
and active counts, then rerun with `--profile-policy`. RosterPilot validates
each choice against the enriched inventory and freezes the policy hash. It
never silently picks the first profile.

The command requires `--experimental` to drive Tessera. Without it, the
explicit stress request can still create and verify the New Recruit-enriched
handoffs, but the result is a handoff-only partial report with no invented
simulation values. Verified enriched files can be reused from the local
content-addressed cache only after their hash and exact summary match. New
Recruit list URLs remain in a local run inventory; deletion always requires a
separate action.

The output directory includes machine-readable JSON, an interactive HTML
report, underlying per-proxy reports, verified handoffs, and
`stress-manifest.json`. Resume an interrupted run:

```bash
npm run rosterpilot -- tessera stress-test \
  --file aeldari.json \
  --against-faction necrons \
  --suite diverse-9 \
  --analysis staged \
  --experimental \
  --resume \
  --out-dir exports/aeldari-vs-necrons-stress
```

Bare `--resume` selects `<out-dir>/stress-manifest.json`. A path may follow the
flag when the manifest is elsewhere. Completed stages are reused only after
their hashes, identities, and requested scenario cells validate. Simulated
partial stages are retried; a completed run returns idempotently, and an
interrupted final report write is repaired without repeating simulation. The
player fingerprint, data pin, opponent faction, suite, strategy, and simulation
setting must match; the report also records settings and iteration counts
against each exact phase/metric/direction scenario. The frozen profile-policy
hash must also match. V2 stages preserve attempts, timestamps, structured error
codes, retryability, and next action. Transient work gets three automatic
attempts and up to five lifetime attempts through explicit resume; terminal
failures need `--force-retry`. Otherwise resume fails closed. If the process stopped
after starting a New Recruit delivery but before persisting its verified
receipt, resume reports the uncertain outcome instead of risking a duplicate
list.

The report describes directional combat robustness: offensive coverage,
incoming threat exposure, coverage margin, distribution tails, phase
dependence, and unit answer breadth. It is not a win-probability model and does
not model terrain geometry, movement, deployment, scoring, sequencing, player
decisions, or every stratagem. Mission readiness is a separate deterministic
report and change-suggestion guardrail; it is not folded into the robustness
score. The v2 result statuses are `partial` for missing/failed required work,
`inconclusive` for completed but insufficiently confident capture, `degraded`
for six to eight confident unique `diverse-9` proxies across every posture plus
three completed deep dives, and `complete` for all nine. Missing estimates are
`null`; below-threshold observations remain under `provisional` with their
point coverage.

Progress is written to stderr. The stdout result is a compact JSON summary
under 50 KB with the complete report path; add `--full-json` to print the full
nested payload. JSON and HTML use portable basenames, while the local manifest
keeps the absolute recovery paths.

After explicitly approving and saving a revised roster, rerun it against the
exact frozen baseline:

```bash
npm run rosterpilot -- tessera compare-stress-revision \
  --baseline-report exports/aeldari-vs-necrons-stress/aeldari-vs-necrons-stress-test.json \
  --revised-roster revised-aeldari.json \
  --experimental \
  --out-dir exports/aeldari-vs-necrons-revision
```

The paired run requires the same player faction, points limit, and pinned data
release. It reuses the exact enriched opponents, configuration, and three
representatives from the baseline; it does not regenerate or reselect the
portfolio. Missing or changed baseline artifacts, execution-fingerprint
mismatches, insufficient simulated coverage, or changed Tessera settings and
iteration counts stop the comparison. Margin changes below one percentage
point are treated as unchanged. The better/worse conclusion is based on the
screening half-wipe robustness deltas; deep-dive metrics remain supporting
evidence. If mission readiness regresses, RosterPilot preserves the combat
deltas but suppresses that conclusion.

Stress testing and paired stress revisions are local-only. The terminal CLI
and local stdio MCP expose them as `tessera stress-test`,
`tessera preview-portfolio`, `tessera build-and-stress`,
`tessera compare-stress-revision`,
`stress_test_roster_against_faction`,
`preview_faction_stress_portfolio`,
`build_and_stress_roster_against_faction`, and
`compare_stress_test_revision`. Hosted MCP, REST, OpenAPI, and the public
website do not expose these operations.

## Safe recovery

- Invalid rosters stop before any browser opens.
- Stress testing preflights the player, every proxy mapping, and output paths
  before external activity; fewer than three unique `core-3` or six unique
  `diverse-9` proxies stops the run.
- Missing mappings still allow canonical JSON, text, and printable HTML.
- Missing local automation still preserves the source `.rosz`.
- Tessera UI changes preserve verified handoff files and mark missing results
  as partial.
- Resume never mixes a different roster, data pin, faction, suite, strategy,
  or simulation setting into an existing stress result; uncertain delivery
  outcomes fail closed rather than creating a duplicate list.
- Paired stress revisions reuse frozen opponents and fail if their enriched
  artifacts are missing, changed, or no longer match their execution
  fingerprints. Each rerun must also preserve the baseline's exact
  phase/metric/direction settings and iteration counts.
- Output files are not overwritten unless `--overwrite` is supplied.
- Writes outside the current directory require `--allow-outside-root`.
