# RosterPilot workflow guide

RosterPilot keeps building, delivery, and matchup work independent. Matchups
have three explicit opponent modes: exact roster versus exact roster, known
faction with an unknown exact list, and build a new roster against one exact
canonical opponent. A validated roster is a complete result. No later
operation starts unless that specific action is requested.

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
| Compare known armies and collect Tessera simulations | `tessera` | macOS | Creates verified New Recruit list copies during profile enrichment, then runs Tessera only with `--execution-mode simulate` (the deprecated `--experimental` alias is still accepted) |
| Test a roster against an unknown list from a known faction | `tessera` | macOS | Creates one player copy plus the unique exportable proxy copies required by the selected suite when the verified cache cannot satisfy them; runs Tessera only with `--execution-mode simulate` |
| Build and analyze against one exact known roster | `tessera` | macOS | Builds locally first; profile enrichment creates verified New Recruit list copies only after validation and readiness gates pass |

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

Setup also installs the repository's RosterPilot Codex skill into its
hash-marked managed directory. Use `npm run skill:check` to inspect it and
`npm run skill:install` to repair it. Setup never overwrites an unrelated
unmanaged skill or edits a Codex plugin cache. The tracked installable plugin
package is checked separately with `npm run plugin:check`; after publishing a
new plugin version, reinstall it through its marketplace and start a new Codex
task so the updated workflow is loaded.

Check the current machine without changing it:

```bash
npm run doctor -- --profile core --refresh skip
npm run rosterpilot -- workflows
npm run rosterpilot -- agent ensure-current
```

If the repository or Node installation moves, rerun the selected setup profile.
Doctor continues independent local checks even when a remote source is
unavailable. `--refresh skip` performs no remote pinned-source or live
freshness check. Local-agent status rejects a different checkout, protocol,
build, or stale runtime instead of silently using old worker code;
`agent ensure-current` repairs that state through the supported restart or
installation lifecycle and reports what it changed.

## Data lifecycle before any workflow

RosterPilot separates four questions that older pin-based workflows often
collapsed into one:

1. `rosterpilot status` reports the rules snapshot used by the engine.
2. `rosterpilot data update-status` reports the bundle currently in use, the
   newest verified bundle, the newest signed-channel candidate, its semantic
   classification, quarantined scopes, `dataTrust`, and whether rollback
   archives are process-memory or persistent.
3. `rosterpilot freshness` compares raw upstream Games Workshop, 40kdc-data,
   and BSData provenance. It is diagnostic only and never changes active data.
4. `rosterpilot data refresh` explicitly verifies the signed channel and makes
   a safe candidate available to future data-consuming operations. It never
   changes a build or durable job already in progress.

Use this sequence when opening an existing roster:

```bash
npm run rosterpilot -- data update-status
npm run rosterpilot -- rebase --file roster.json --out rebased.json
```

`current` means the roster already uses the active semantic data.
`compatible-rebased` changes provenance only because every referenced rule and
mapping hash is unchanged. `review-required` names the exact changed units,
equipment, detachments, enhancements, or mappings and never edits selections.
Review and modify the roster deliberately before validating or exporting it.

Rollback is an operator recovery action, not a way to suppress a roster review:

```bash
npm run rosterpilot -- data rollback --bundle <retained-bundle-id>
```

Rollback affects only future data-consuming operations. A durable Tessera job
continues to use the exact archived `bundleId` recorded in its manifest.
Control-plane update-status, refresh, and rollback calls do not themselves acquire a
roster-data lease and never call New Recruit.

When signed runtime updates are not configured, status says so explicitly and
RosterPilot continues from the application release's compiled data. A release
may advertise that fallback as a verified signed bootstrap only when the
bootstrap manifest, shards, and installed public key have actually been
verified. Network failure never changes data mid-operation.

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
  --out-dir exports/new-recruit
```

Delivery creates a new list, verifies its name, faction, points, and units, and
always downloads a profile-rich `.rosz` to compare New Recruit's observed
game-system and faction-catalogue revisions with the build's frozen data
bundle. Delivery rejects all catalogue drift by default after recording the
remote outcome. When the only mismatch is an observed newer game-system
revision, the game-system ID and exact faction-catalogue identity and revision
still match, no provenance field is missing, and every top-level unit has
embedded Unit and weapon profiles, RosterPilot also retains an integrity-sealed
provisional artifact. It is not placed in the trusted cache and does not
authorize Tessera by itself. The mutation receipt prevents a retry from
creating a duplicate list. Pretty HTML remains optional. Delivery never
replaces or deletes an existing list.

## Workflow 3: exact-list Tessera comparison

Tessera accepts one canonical player roster and exactly one opponent source:

- `--opponent-roster enemy.json` for another RosterPilot roster;
- `--opponent-file enemy.rosz` for an existing exported list.

A standalone `.rosz` must expose game-system and faction catalogue revisions
compatible with the operation's frozen bundle and complete per-unit profiles.
Its full
rule-bearing selection tree is fingerprinted and compared before/after any
enrichment. Without canonical context, the report keeps an explicit warning
that archive-only checks cannot prove roster legality or the exact source
provenance.

The exact route does not accept a faction proxy. Supplying
`--opponent-faction` to `tessera analyze` fails with
`OPPONENT_SCOPE_REQUIRED` and directs the caller to Workflow 5. If neither an
exact opponent nor a faction is known, RosterPilot does not choose one.

Run a quick directional smoke comparison:

```bash
npm run rosterpilot -- tessera analyze \
  --file aeldari.json \
  --opponent-roster enemy.json \
  --analysis-mode quick \
  --execution-mode simulate \
  --out-dir exports/tessera-quick
```

Use the default `full` mode for both phases, all four metrics, and both attack
directions. The output directory contains preserved handoff files, a
machine-readable report, and an interactive HTML report.

Tessera preparation uses New Recruit to obtain verified profile-rich archives,
so it creates new list copies as part of this explicitly requested workflow.
`--execution-mode prepare-only` stops after the verified handoff and returns
`status: prepared`. A requested simulation with no trusted matrices returns
`ok: false` with the preparation stage retained. A comparison never edits the
source roster; change candidates remain suggestions until a revised roster is
explicitly saved and compared. `--experimental` remains a deprecated
compatibility alias for simulation.

For an explicitly requested live-deployment diagnostic, pass
`--verified-catalogue-drift-diagnostic`. This is not a general drift override:
older revisions, faction-catalogue drift, identity mismatches, missing
provenance, and incomplete per-unit profiles still fail closed. Accepted
archives and results retain both frozen and observed identities plus
`TESSERA_VERIFIED_CATALOGUE_DRIFT_DIAGNOSTIC`; embedded characteristic values
are live New Recruit evidence, not proof that they equal the frozen rules
bundle.

After explicitly approving and saving a revised canonical roster, start the
paired exact comparison against the baseline's frozen opponent, profile policy,
scenario contract, simulator settings, and artifact hashes:

```bash
npm run rosterpilot -- tessera compare-revision \
  --baseline-report exports/tessera-quick/roster-matchup.json \
  --revised-roster revised-aeldari.json \
  --out-dir exports/tessera-revision
```

This command always starts a durable simulate-mode job and returns its job
path; follow it with `tessera run-status` and the same profile-resolution or
resume flow described below. The baseline must be a complete schema-v3 exact
report, and every frozen opponent, source identity, points contract, profile
policy, scenario, iteration setting, and Tessera UI identity must still verify.
The roster-level conclusion is `improved` only when at least one applicable
trusted aggregate improves and none materially worsen; otherwise it is
`worsened`, `mixed`, or `unchanged`. Materiality is five percentage points for
wipe probabilities, the greater of 0.5 model or 10% for mean kills, and the
greater of one wound or 10% for mean damage. Ambiguous or incomplete aggregate
coverage is retained explicitly and cannot vote for an improvement.

These outputs are directional unit-to-unit combat math, not a whole-game win
probability. They exclude movement, terrain geometry, missions, scoring,
deployment, sequencing, player decisions, and unmodeled stratagems.

## Workflow 4: build against an exact known roster

Use the canonical opponent roster as structured threat context when building
the player's army:

```bash
npm run rosterpilot -- tessera build-and-analyze \
  --prompt "Build a durable 2,000 point Custodes counter-roster" \
  --player-faction adeptus-custodes \
  --opponent-roster enemy.json \
  --execution-mode simulate \
  --out-dir exports/custodes-vs-exact
```

The opponent validates before construction or browser activity, and an
explicit player points limit must equal the opponent's declared limit. The
engine fingerprints the complete selection payload and derives an aggregate
threat context from selected model counts, points, unit tags, and
vehicle/monster keywords. Tessera supplies the later unit-to-unit combat math.
Deterministic repair must reach at least 98% points utilization and avoid red
overall mission readiness unless
`--allow-readiness-warnings` is explicit. Suggested revisions remain proposals
and are never applied automatically.

The default collection mode is `open-catalog`, which leaves the faction's full
eligible build-supported catalogue available under ordinary build constraints
and does not imply ownership. Use `--collection owned-collection.json` for a
quantity-aware constraint:

```json
{
  "mode": "owned",
  "units": [
    {
      "unitId": "custodian-guard",
      "maxUnits": 2,
      "maxModels": 10
    },
    {
      "unitId": "blade-champion",
      "maxUnits": 1,
      "maxModels": 1
    }
  ]
}
```

In `owned` mode, omitted unit IDs are unavailable. `maxUnits` limits unit
instances and `maxModels` limits total selected models for that unit ID.
Duplicate unit IDs fail closed. The result records `open-catalog` or `owned`
so a catalogue-wide suggestion cannot be mistaken for a collection-aware
recommendation.

This workflow uses the exact-matchup analysis route after construction. Its
report remains directional combat math rather than game win probability.

## Workflow 5: known-faction stress test

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
  --execution-mode simulate \
  --out-dir exports/custodes-vs-aeldari
```

`preview-portfolio` performs no external work. Use it to inspect proxy payload
fingerprints, composition evidence, represented and missing coverage cells,
named-character status, New Recruit exportability, and unresolved profile
requirements before approving a run.

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
  --execution-mode simulate \
  --out-dir exports/aeldari-vs-necrons-stress
```

The defaults are `--suite diverse-9` and `--analysis staged`. The suite
options are:

- `core-3`: three distinct balanced-control, ranged-pressure, and
  assault-pressure proxies. Composition is descriptive and is used to maximize
  feasible diversity; it is not a required coverage dimension;
- `diverse-9`: those three postures crossed with the stable wire labels
  `mixed`, `mass`, and `elite-heavy`. These are faction- and posture-relative
  threat lenses bound to the portfolio methodology hash. Evidence includes
  model density, points per
  model, Infantry and Vehicle/Monster share, selected-weapon ranged/melee
  pressure, mobility, role breadth, and largest-unit concentration. The
  portfolio freezes the observed ranges, bundle identity, and review status
  for each posture.
  Horde tags are contextual evidence, never a universal gate.

RosterPilot builds each proxy deterministically from one leased immutable data
bundle.
Every proxy must be legal, exportable, within 5% of the points limit, and
distinct by its modeled unit/model/equipment/enhancement payload; changing only
the detachment is not enough. Full `core-3` coverage requires all three
postures and three unique simulation fingerprints. Full `diverse-9` coverage
requires every requested posture/composition cell.
When some cells are infeasible, a degraded run may continue only when each
missing cell is bound to the faction's reviewed-not-applicable contract for the
exact faction and portfolio semantic hashes, at least six unique exportable
payloads remain, and all
three postures are represented. An unreviewed gap returns
`PORTFOLIO_CONTRACT_UNMET` before New Recruit.

The analysis strategies are:

- `staged`: screen every available proxy with half-wipe probability in
  Shooting and Fight, in both directions, then run wipe probability, mean
  kills, and mean damage on three frozen stress, central, and contrast
  representatives; all required captures must first be complete and
  integrity-clean. Complete portfolios require at least six confident
  `diverse-9` screens across all three postures (all three for `core-3`) before
  representative selection; degraded portfolios require the same six-proxy,
  three-posture analytical floor, so deep dives do not begin against a
  still-changing representative set;
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
  --execution-mode simulate \
  --out-dir exports/necrons-core
```

Before delivery, the command scans multi-profile equipment. Unresolved choices
return `TESSERA_PROFILE_POLICY_REQUIRED` and a
`tessera-profile-policy.scaffold.json`. Complete its `selectedProfile` values
and active counts, then rerun with `--profile-policy`. RosterPilot validates
each choice against the enriched inventory and freezes the policy hash. It
never silently picks the first profile. If enrichment exposes a decision that
was absent from the frozen bundle inventory, the command writes an updated
scaffold and stops
before Tessera. Resume the same manifest with that completed policy to reuse
the already verified New Recruit files.

The command requires `--execution-mode simulate` to drive Tessera.
`prepare-only` can still create and verify the New Recruit-enriched handoffs
and returns a successful `prepared` report with no invented simulation values.
A requested simulation with no trusted matrices returns `ok: false` while
retaining preparation and structured failure details. Verified enriched files
can be reused from the local
content-addressed cache only after their hash and exact summary match. New
Recruit list URLs remain in a local run inventory; deletion always requires a
separate action. On macOS the inventory is
`~/Library/Application Support/RosterPilot/new-recruit-run-inventory.json`.
Inspect its recorded URLs and remove lists through New Recruit only after a
separate cleanup decision; the stress workflow never performs that mutation.

The metadata readiness check is followed by a live probe using the first
screening capture: it must unlock premium, select the exact imported lists, and
return a fresh matrix. A browser, credential, unlock, or missing-matrix failure
stops later proxies for that invocation; resume continues within the bounded
lifetime retry budget.

The output directory includes machine-readable JSON, an interactive HTML
report, underlying per-proxy reports, verified handoffs, and
`stress-manifest.json`. Absolute paths and remote New Recruit list URLs remain
in the local manifest/inventory; shareable JSON and HTML contain portable
basenames instead. Resume an interrupted run:

```bash
npm run rosterpilot -- tessera stress-test \
  --file aeldari.json \
  --against-faction necrons \
  --suite diverse-9 \
  --analysis staged \
  --execution-mode simulate \
  --resume \
  --out-dir exports/aeldari-vs-necrons-stress
```

Bare `--resume` selects `<out-dir>/stress-manifest.json`. A path may follow the
flag when the manifest is elsewhere. Completed stages are reused only after
their hashes, identities, and requested scenario cells validate. Simulated
partial stages are retried; a completed run returns idempotently, and an
interrupted final report write is repaired without repeating simulation. The
player fingerprint, `bundleId`, semantic roster identity, opponent faction,
suite, strategy, and simulation setting must match; the report also records
settings and iteration counts
against each exact phase/metric/direction scenario. The frozen profile-policy
hash and the manifest's SHA-256 over the complete frozen portfolio must also
match. Schema-v1 and schema-v2 manifests are upgraded to schema v3 when
resumed. Stages preserve attempts, timestamps, structured error codes,
retryability, and next action. Transient work gets three automatic
attempts and up to five lifetime attempts through explicit resume; terminal
failures need `--force-retry`. Otherwise resume fails closed. If the process stopped
after starting a New Recruit delivery but before persisting its verified
receipt, resume reports the uncertain outcome instead of risking a duplicate
list.

Resume keeps the same run and lifetime attempt budget. If that budget reaches
five attempts, create a clean run from the old manifest with a new output
directory:

```bash
npm run rosterpilot -- tessera stress-test \
  --file aeldari.json \
  --against-faction necrons \
  --suite diverse-9 \
  --analysis staged \
  --execution-mode simulate \
  --restart-from exports/aeldari-vs-necrons-stress/stress-manifest.json \
  --out-dir exports/aeldari-vs-necrons-restart
```

`--restart-from` creates a new run ID, manifest, and empty simulation stages.
It reuses the frozen portfolio, profile policy, and verified New Recruit
artifacts only when their identities, content hashes, and enriched summaries
still match. The source run remains unchanged. A restart requires a different
`--out-dir`; `--resume` and `--restart-from` cannot be combined, and
`--force-retry` never raises the five-attempt lifetime limit. Both recovery
modes also work with `build-and-stress`, provided its deterministic rebuilt
player matches the manifest fingerprint.

Each raw result table is fingerprinted from its headers, dimensions, and
values. After changing a phase, metric, or direction, RosterPilot requires the
exclusive selected control, a replacement or mutation of the matrix table, and
three stable reads. Equal numeric matrices remain valid when that refresh is
observed; content equality alone is not evidence of stale UI or a duplicate
proxy. A control change without a matrix refresh is stale. Stale or missing
fingerprints preserve diagnostic captures but make the report `inconclusive`.
Duplicate simulation payloads are rejected separately during portfolio
preflight.

The report describes directional combat robustness: offensive coverage,
incoming threat exposure, coverage margin, distribution tails, phase
dependence, and unit answer breadth. It is not a win-probability model and does
not model terrain geometry, movement, deployment, scoring, sequencing, player
decisions, or every stratagem. Mission readiness is a separate deterministic
report and change-suggestion guardrail; it is not folded into the robustness
score. The schema-v3 result statuses are `prepared` when enrichment completed
without a simulation request, `failed` when required work produced no trusted
matrix evidence, `inconclusive` when capture exists but confidence or integrity
is insufficient, `degraded` for six to eight confident unique `diverse-9`
proxies across every posture plus three completed deep dives only when every
omitted cell has a reviewed-not-applicable exception bound to the exact
faction and portfolio semantic hashes, and
`complete` for all nine (`core-3` requires all three). Missing estimates are
`null`; below-threshold observations remain under `provisional` with their
point coverage.

Progress is written to stderr. The stdout result is a compact JSON summary
under 50 KB with status explanation, portfolio and integrity coverage,
recovery state, representatives, and the complete report path; add
`--full-json` to print the full nested payload. JSON and HTML use portable
basenames, while the local manifest keeps the absolute recovery paths.

Change candidates are fail-closed suggestions. The resulting roster must be
legal, New Recruit-exportable, use at least 98% of its points, and be no worse
across mission-readiness guardrails. Evidence must identify the affected player
unit or a role gap, and a reliable or portfolio-wide robust answer is not
offered as a replacement. RosterPilot returns no candidate rather than a
severely underfilled or contradictory roster, and never applies a candidate
automatically.

After explicitly approving and saving a revised roster, rerun it against the
exact frozen baseline:

```bash
npm run rosterpilot -- tessera compare-stress-revision \
  --baseline-report exports/aeldari-vs-necrons-stress/aeldari-vs-necrons-stress-test.json \
  --revised-roster revised-aeldari.json \
  --out-dir exports/aeldari-vs-necrons-revision
```

The paired run requires the same player faction, points limit, and frozen
bundle and roster semantic identities. It reuses the exact enriched opponents,
configuration, and three
representatives from the baseline; it does not regenerate or reselect the
portfolio. Missing or changed baseline artifacts, execution-fingerprint
mismatches, insufficient simulated coverage, or changed Tessera settings and
iteration counts stop the comparison. The browser actively reapplies the
frozen setting and iteration contract before capture and verifies every
scenario afterward. Margin changes below one percentage point are treated as
unchanged. The better/worse conclusion is based on the
screening half-wipe robustness deltas; deep-dive metrics remain supporting
evidence. If mission readiness regresses, RosterPilot preserves the combat
deltas but suppresses that conclusion.

## Durable background execution

Use a background job when a Tessera operation may outlive one CLI or MCP
request. `start-run` supports `exact`, `stress`, `build-and-stress`, and
`build-and-analyze`:

```bash
npm run rosterpilot -- tessera start-run \
  --run-kind stress \
  --file aeldari.json \
  --against-faction necrons \
  --execution-mode simulate \
  --out-dir exports/tessera/runs
```

Set `--verified-catalogue-drift-diagnostic` when the durable run is started if
the user explicitly authorized that narrow diagnostic. The choice is frozen
and hash-bound with the request; `run-resume` and `--restart-from` cannot enable
or change it. For MCP, set
`start_tessera_run.request.verifiedCatalogueDriftDiagnostic` to `true`. A job
started without it must be replaced by a newly started diagnostic job, which
can reuse the revalidated provisional artifact without another New Recruit
upload.

The response contains the generated
`run-<uuid>/tessera-run.json`. That job document is the authority for later
operations:

```bash
npm run rosterpilot -- tessera run-status --job <job-path> --full-json
npm run rosterpilot -- tessera run-resume --job <job-path>
npm run rosterpilot -- tessera run-resume \
  --job <job-path> \
  --restart-from \
  --out-dir exports/tessera/restarted-runs
npm run rosterpilot -- tessera resolve-profiles \
  --job <job-path> \
  --profile-policy profiles.json
npm run rosterpilot -- tessera run-cancel --job <job-path>
```

Statuses are `queued`, `running`, `needs-input`, `complete`, `degraded`,
`inconclusive`, `failed`, or `cancelled`. `--full-json` includes the retained
result when available. Profile choices cannot change while a worker is active;
`resolve-profiles` validates and freezes a structured policy into a stopped
job, then `run-resume` applies it. Stress jobs additionally inherit the
hash-verified stress manifest. The first three attempts are the automatic tier
and five attempts is the lifetime ceiling. `--restart-from` is explicit
recovery after exhaustion or runtime drift: it creates a new run/stage from
hash-verified frozen inputs and carries no old simulation evidence. Exact jobs
freeze and reverify their prepared player and opponent archives so retry and
resume do not redeliver them; their simulation remains one analytical stage
rather than the stress workflow's per-opponent screening/deep-dive stages.
Cancellation retains the job, artifacts, prepared-list inventory, and any
remote lists.

The matching local MCP tools are `start_tessera_run`,
`get_tessera_run_status`, `resume_tessera_run`,
`resolve_tessera_profiles`, and `cancel_tessera_run`. The job path is opaque
caller state and must be copied exactly from the start response. The CLI reads
the policy from `--profile-policy`; the MCP resolution tool accepts the
validated structured policy object.
Simulate-mode compatibility commands use this same background coordinator and
return an in-progress job reference; losing the initiating CLI/MCP client does
not mark the workflow failed. MCP restart is
`resume_tessera_run({restartFrom: true, ...})`.

For a direct stress job, pass the full `data` object returned by
`preview_faction_stress_portfolio` as
`start_tessera_run.request.portfolioPreview`. The CLI equivalent is
`tessera start-run --portfolio-preview <full-preview.json>`. The durable
coordinator validates and hashes that exact preview before launch. If a fresh
stress start omits it, the coordinator generates exactly one preview and
freezes it into the job; resume inherits the manifest portfolio and rejects a
competing preview.

Exact comparison, exact-aware construction, stress testing, paired revisions,
and durable jobs are local-only. The terminal CLI and local stdio MCP expose
them as `tessera analyze`, `tessera build-and-analyze`, `tessera stress-test`,
`tessera preview-portfolio`, `tessera build-and-stress`,
`tessera compare-revision`, `tessera compare-stress-revision`,
`analyze_roster_matchup`, `compare_roster_revision`,
`build_and_analyze_roster_matchup`, `stress_test_roster_against_faction`,
`preview_faction_stress_portfolio`,
`build_and_stress_roster_against_faction`, and
`compare_stress_test_revision`, plus the five job tools above. Hosted MCP,
REST, OpenAPI, and the public website do not expose these operations.

## Safe recovery

- Invalid rosters stop before any browser opens.
- Stress testing preflights the player, every proxy mapping, and output paths
  before external activity; fewer than three unique `core-3` or six unique
  `diverse-9` proxies stops the run.
- Missing mappings still allow canonical JSON, text, and printable HTML.
- Missing local automation still preserves the source `.rosz`.
- `NEW_RECRUIT_PROVISIONAL_CACHE_REUSED` means a hash- and
  profile-revalidated provisional artifact was reused and no new remote list
  was created.
- `TESSERA_INPUT_NOT_PROFILE_RICH` and
  `TESSERA_INPUT_PROFILES_INCOMPLETE` stop before Tessera browser or licence-key
  activity; never substitute the source `.rosz` for the enriched archive.
- A checkout, protocol, build, or stale-runtime mismatch directs the user to
  `agent ensure-current`; the original mismatch remains visible after repair.
- Tessera UI changes preserve verified handoff files. A requested simulation
  with no trusted matrix evidence is `failed`; captured evidence that cannot
  support confidence is `inconclusive`.
- Stale Tessera matrices are retained for diagnosis but cannot
  produce a confident result.
- Resume never mixes a different roster, `bundleId`, semantic roster identity,
  faction, suite, strategy, or simulation setting into an existing stress
  result; uncertain delivery
  outcomes fail closed rather than creating a duplicate list.
- Restart requires a new output directory and copies only verified preparation
  state into a fresh run; it never resets or rewrites the source run's attempt
  history.
- Cancelling a durable job stops its worker without deleting prepared
  artifacts, inventory records, or remote New Recruit lists.
- Paired stress revisions reuse frozen opponents and fail if their enriched
  artifacts are missing, changed, or no longer match their execution
  fingerprints. Each rerun must also preserve the baseline's exact
  phase/metric/direction settings and iteration counts.
- Paired exact revisions likewise preserve the opponent, bundle and semantic
  identities, points contract, profile policy, scenario contract, simulator
  settings, and Tessera UI identity; incomplete trusted aggregates remain
  ambiguous rather than producing a roster-level improvement.
- Output files are not overwritten unless `--overwrite` is supplied.
- Writes outside the current directory require `--allow-outside-root`.
