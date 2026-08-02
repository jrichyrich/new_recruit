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
| Use the ChatGPT/Codex personal plugin | `core`, then `plugin:local:install` | macOS owner machine | Installs a new local plugin version; no game-service action |
| Use RosterPilot through a standalone local MCP client | `mcp` | macOS, Linux, Windows | None |
| Export `.rosz` for manual New Recruit import | `core` | macOS, Linux, Windows | None until the player imports it |
| Upload and verify a new New Recruit list | `new-recruit` | macOS | Creates a new list only after an explicit delivery command |
| Compare known armies and collect Tessera simulations | `tessera` | Local CLI or stdio MCP; macOS for the website provider | `website` creates verified New Recruit copies; explicit `local-engine` compiles bundle-native JSON with zero remote mutations. Simulation still requires `--execution-mode simulate` |
| Test a roster against an unknown list from a known faction | `tessera` | Local CLI or stdio MCP; macOS for the website provider | `website` creates the required verified list copies; explicit `local-engine` compiles the player and frozen proxies locally and creates no remote lists |
| Build and analyze against one exact known roster | `tessera` | Local CLI or stdio MCP; macOS for the website provider | Builds locally first; provider preparation starts only after validation and readiness gates pass. Local-engine preparation has no web side effect |
| Approval-gated roster optimization | `tessera` | macOS | Starts only from a complete paired baseline; website comparisons retain explicit enrichment side effects, and candidate local-engine evidence is not eligible for optimizer decisions |

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

`new-recruit` includes `core` and local MCP readiness. `tessera` includes the
browser-backed New Recruit and Tessera website prerequisites as well as the
pinned local evaluation engine. The website provider needs profile-rich
`.rosz` files; the explicit local provider does not. Installing a profile does
not run a delivery, local compilation, or simulation.

Choose one Codex MCP delivery path. `npm run setup -- --profile mcp` creates a
project-local standalone entry when no personal plugin is registered. The
supported ChatGPT/Codex owner-Mac path instead starts with core setup and then
publishes the personal plugin:

```bash
npm run setup -- --profile core --refresh check
npm run plugin:local:install
```

The operator-owned `~/.agents/plugins/marketplace.json` must be named
`personal` and map `rosterpilot` to `./plugins/rosterpilot`. The installer
verifies but never edits that registry or Codex's immutable cache. It also
refuses a project-local `[mcp_servers.rosterpilot]` entry because that entry
would take precedence over the plugin. See
[Local ChatGPT/Codex personal plugin](./chatgpt-codex-plugin.md) for the exact
prerequisites and switching procedure.

Install browser-backed profiles only after the personal plugin is registered;
setup then detects the plugin and does not create a shadowing standalone entry:

```bash
npm run setup -- --profile tessera --refresh skip
npm run rosterpilot -- agent ensure-current
npm run plugin:local:check
npm run doctor -- --profile tessera --refresh skip
npm run rosterpilot -- new-recruit status
npm run rosterpilot -- tessera status
```

Use `--profile new-recruit` when Tessera is not needed. Plugin verification and
browser readiness are separate gates: `plugin:local:check` audits the canonical
skill, tracked package, managed skill, marketplace source, immutable cache,
plugin registration, and MCP startup; it does not verify Keychain credentials
or local-agent freshness. Start a new ChatGPT/Codex task after installation
because existing tasks retain their original skill and tool snapshot.

For repository and CI checks, `npm run plugin:check` proves only that the
portable tracked plugin packages the canonical skill. `npm run skill:check`
inspects the marker-protected standalone skill. Neither command publishes the
machine-local personal plugin.

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

## Unified conversation and CLI workflow

`run_roster_workflow` is the MCP entry point for the common path. The CLI
equivalent is `rosterpilot workflow`. One invocation resolves the player and
opponent factions, leases one immutable data snapshot, builds, validates,
explains, adds calibrated competitive coaching, and prepares any artifact the
explicitly requested next step needs.

```bash
npm run rosterpilot -- workflow \
  --prompt "Build a 1,000 point Custodes army to battle Aeldari" \
  --coaching concise \
  --out custodes-vs-aeldari.json
```

Faction resolution is fail-closed. Canonical names, IDs, and reviewed aliases
resolve automatically. A voice-like or fuzzy name such as `Death Gourd` or
`Coto del Darri` returns suggestions and creates no roster. A prompt that names
both sides distinguishes the player's army from the opponent; unresolved or
conflicting sides require an explicit `--player-faction` or
`--opponent-faction`.

Competitive coaching defaults to `concise`; use `--coaching full` for
per-selection evidence or `--coaching none` to omit it. The pinned Foundation
Codex V2 pack is a user-supplied heuristic layer, not an official rule source.
It reports economic roles, OC/point, wounds/point, a roster-selection activation
upper bound, action economy, mobility, and mission readiness. Mission- and terrain-specific advice
is omitted unless the caller supplies the corresponding context. Reliable
trade claims still require opponent-specific paired evidence.

New Recruit preparation and delivery remain different authorities:

```bash
# Writes an export-safe handoff; does not open New Recruit.
npm run rosterpilot -- workflow \
  --prompt "Build 2,000 points of Death Guard and export it for New Recruit" \
  --out-dir exports/new-recruit

# Explicitly authorizes a new-list mutation in this same request.
npm run rosterpilot -- workflow \
  --prompt "Build 2,000 points of Death Guard and upload it to New Recruit" \
  --out-dir exports/new-recruit
```

A capability question such as “Can you upload this to New Recruit?” never
authorizes delivery. Direct delivery first probes the local companion, creates
a new list rather than replacing one, and verifies the result. When the local
capability is unavailable, the response retains the validated `.rosz` manual
handoff and reports the delivery failure explicitly.

Artifact-backed builds constrain construction to conflict-free New Recruit
mappings and require at least 98% point use. If a required unit or loadout is
unmapped, the workflow names the blocking required selection instead of
silently removing it. Without an owned collection profile, construction uses
the open catalogue and labels that fact. Legends remain excluded by default
when permission or verified classification is unavailable; they are advisory
and are not a prerequisite for the main workflow.

An explicit optimize request defaults to approval-gated guided mode:

```bash
npm run rosterpilot -- workflow \
  --prompt "Build a 1,000 point Custodes army and Tessera optimize it" \
  --optimizer-mode guided \
  --out custodes-optimizer-baseline.json \
  --portfolio-out general-threat-portfolio.json \
  --tessera-out-dir exports/tessera
```

The CLI optimize intent starts durable Tessera baseline work immediately. An
exact opponent starts one exact job, a known faction starts one stress job with
the already-frozen `diverse-9` preview, and the general robustness target
starts six separately inventoried exact jobs. The response returns compact run
IDs and manifest paths. A failed client wait does not erase those jobs. A
website-provider source `.rosz` is not described as profile-rich: that job must
still complete New Recruit enrichment and Tessera before it is eligible to
become an optimizer baseline. An explicit local-engine job instead freezes
bundle-native JSON and its limitation warnings. While the local provider is
`candidate` and `evaluation-only`, its evidence remains ineligible for optimizer
decisions even when the run itself completes.

With an exact opponent, the target is that frozen roster. With only a known
faction, it uses the existing frozen faction stress portfolio. When no opponent
is supplied, 1,000- and 2,000-point workflows deterministically build six
legal, New Recruit-exportable robustness lenses: horde, elite infantry,
armour/monsters, fast scoring MSU, ranged pressure, and melee pressure. The
portfolio hash binds the six simulation payloads. Other points limits require
a named faction or exact opponent.

Guided optimization is two-stage: the user first approves at most three
candidate revisions, each revision is compared against the same frozen
baseline inputs, and the user then approves the exact Pareto-ranked winner (or
keeps the baseline) before delivery. For the general target, each candidate is
materialized once and compared against all six frozen exact baselines. It
qualifies only when at least one trusted archetype aggregate improves, none
worsen or remain ambiguous, and mission readiness does not regress. Any
bundle, portfolio, profile-policy, heuristic, runtime, or baseline identity
drift invalidates approval.
`recommend-only` stops with unpaired findings and cannot authorize roster
changes. Combat outputs remain directional math-hammer, never a whole-game win
probability.

After an exact or known-faction baseline job completes, create the durable
approval coordinator from that verified report and the exact canonical player
roster:

```bash
npm run rosterpilot -- tessera optimizer-start \
  --baseline-report exports/tessera/run-.../result.json \
  --file custodes-optimizer-baseline.json \
  --mode guided

npm run rosterpilot -- tessera optimizer-status \
  --optimizer exports/tessera/optimizers/optimizer-.../tessera-optimizer.json
```

The optimizer directory freezes its own baseline report, optional profile
policy, candidate rosters, paired comparison reports, approval receipts, and
final roster. Every mutating command requires the exact current state revision:

```bash
npm run rosterpilot -- tessera optimizer-approve-candidates \
  --optimizer <state.json> --expected-revision 0 \
  --candidate <candidate-id> --approval-id <approval-id> \
  --approved-by <name>

# Run the returned exact-revision or stress-revision request as a durable
# Tessera comparison, then record its completed report.
npm run rosterpilot -- tessera optimizer-record-comparison \
  --optimizer <state.json> --expected-revision 2 \
  --candidate <candidate-id> --report <comparison-report.json>

npm run rosterpilot -- tessera optimizer-approve-winner \
  --optimizer <state.json> --expected-revision 3 \
  --candidate <candidate-id> --approval-id <winner-approval-id> \
  --approved-by <name>

# Or explicitly keep the frozen baseline at the same Pareto revision.
npm run rosterpilot -- tessera optimizer-retain-baseline \
  --optimizer <state.json> --expected-revision 3 \
  --approval-id <baseline-decision-id> --approved-by <name>

npm run rosterpilot -- tessera optimizer-finalize \
  --optimizer <state.json> --expected-revision 4 \
  --delivery-intent none
```

Revision numbers after recording comparisons depend on the number of approved
candidates; always read the current status instead of copying the example
literally. Finalization only records an independently identified handoff or
delivery intent and writes `final-roster.json`; it never uploads to New Recruit.
After a separately approved `deliver-new-recruit` intent, the CLI delivery
remains an explicit command against that exact frozen artifact:

```bash
npm run rosterpilot -- new-recruit deliver \
  --file exports/tessera/optimizers/optimizer-.../final-roster.json
```

After all six general baseline jobs complete, start the aggregate coordinator
with the portfolio written by `--portfolio-out` and one report keyed to each
archetype (argument order is irrelevant):

```bash
npm run rosterpilot -- tessera general-optimizer-start \
  --file custodes-optimizer-baseline.json \
  --portfolio general-threat-portfolio.json \
  --baseline horde=<horde-result.json> \
  --baseline elite=<elite-result.json> \
  --baseline ranged-pressure=<ranged-result.json> \
  --baseline armour-monster=<armour-result.json> \
  --baseline fast-scoring-msu=<msu-result.json> \
  --baseline melee-pressure=<melee-result.json>

npm run rosterpilot -- tessera general-optimizer-approve-candidates \
  --optimizer <state.json> --expected-revision 0 \
  --candidate <candidate-id> --approval-id <approval-id> \
  --approved-by <name>

# Run each returned exact-revision request, then bind its report to the
# candidate/archetype/request tuple.
npm run rosterpilot -- tessera general-optimizer-record-comparison \
  --optimizer <state.json> --expected-revision <current-revision> \
  --candidate <candidate-id> --archetype horde \
  --request-sha256 <request-sha256> --report <comparison.json>
```

After every approved candidate has six terminal comparisons, use
`general-optimizer-approve-winner` or
`general-optimizer-retain-baseline`, followed by
`general-optimizer-finalize`. The durable store keeps separate
`(candidate, archetype)` artifacts and request hashes while producing one
no-regression aggregate Pareto decision.

The local stdio MCP mirrors the durable lifecycle with
`start_tessera_optimizer`, `get_tessera_optimizer_status`, candidate approval,
comparison recording, exact winner or baseline-retention approval, and
finalization tools. Finalization only records intent. Direct delivery is a
separate `deliver_tessera_optimizer_winner_to_new_recruit` call, requires a
finalized `deliver-new-recruit` receipt plus `confirmDelivery=true`, probes the
companion first, and sends only the exact frozen final roster.

The aggregate MCP lifecycle uses the parallel
`start_tessera_general_optimizer`, status, candidate approval, comparison,
winner/retention, finalization, and
`deliver_tessera_general_optimizer_winner_to_new_recruit` tools. Starting it
requires the full frozen portfolio (or its path), exactly six keyed baseline
reports, and the canonical player roster. Recording a comparison additionally
requires its returned `requestSha256`, preventing evidence from one archetype
or candidate from being attached to another.

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

Force the repository-pinned local engine when both sides are canonical rosters:

```bash
npm run rosterpilot -- tessera analyze \
  --file aeldari.json \
  --opponent-roster enemy.json \
  --simulation-backend local-engine \
  --analysis-mode quick \
  --execution-mode simulate \
  --out-dir exports/tessera-local-quick
```

This flag is deliberate: while the local provider remains an unpromoted
candidate, `--simulation-backend auto` selects the website path. An exact
opponent supplied only as an already enriched `.rosz` uses the compatible
legacy archive reader; supply a canonical opponent roster when the goal is a
fully bundle-native run.

Use the default `full` mode for both phases, all four metrics, and both attack
directions. The output directory contains preserved handoff files, a
machine-readable report, and an interactive HTML report.

Preparation follows the frozen provider:

- `website` exports mapped ROSZ, uses New Recruit to obtain verified
  profile-rich archives, and therefore creates new list copies when no verified
  cached artifact can satisfy the request;
- `local-engine` validates each canonical roster and compiles content-addressed
  source JSON plus `rosterpilot-local-engine-input` JSON directly from the
  exact active data bundle. It reports preparation source
  `rosterpilot-data-bundle`, `remoteMutations: 0`, `cacheReuses: 0`, and no list
  URL. It does not open New Recruit or Tessera web, and it never falls back to
  them after a local compilation failure.

The local input freezes its SHA-256, `bundleId`, roster execution fingerprint,
compiler version, profile requirements, and optional profile-policy hash.
Preflight and execution verify all of them. A durable job restores that exact
bundle before compiling or reusing the artifact; a changed or missing artifact,
wrong active bundle, changed compiler, invalid schema, or roster mismatch fails
closed.

`--execution-mode prepare-only` stops after the provider-specific verified
handoff and returns `status: prepared`. For the local route, this is only local
JSON compilation. A requested simulation with no trusted matrices returns
`ok: false` with the preparation stage retained. A comparison never edits the
source roster; change candidates remain suggestions until a revised roster is
explicitly saved and compared. `--experimental` remains a deprecated
compatibility alias for simulation.

Local results are explicitly `base-profile-evaluation-v1`. They model unit and
weapon profiles and supported intrinsic weapon keywords, but not army or
detachment rules, datasheet abilities, enhancements, non-weapon wargear,
stratagems, attached-unit interactions, or range and distance-dependent effects
such as Conversion. The JSON and report warnings list
omitted abilities and wargear, unsupported keywords, and frozen alternate
profile, pistol/non-pistol, melee-set, and mixed-defence choices. Treat these as
directional profile math, not full-rules evidence; they remain ineligible for
substantive coaching and optimizer decisions while the provider is
evaluation-only.

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
uniqueness, checks explicit profile choices, prepares or reuses the selected
provider's artifacts, runs the selected simulator, and writes a portable
report. Website preparation uses New Recruit; explicit local-engine preparation
compiles all canonical player and proxy inputs from the frozen bundle with zero
remote mutations. It never applies the reported roster-change candidates. Use
`--allow-readiness-warnings` only after reviewing the gate.

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
  --simulation-backend local-engine \
  --suite core-3 \
  --analysis full-all \
  --execution-mode simulate \
  --out-dir exports/necrons-core
```

This explicit local smoke route still enforces the portfolio's legal,
New Recruit-exportable proxy contract, but the exportability check is local and
the generated ROSZ is not uploaded or used as the simulation input. Each
canonical roster is compiled to hash-bound local JSON instead.

Before provider preparation, the command scans multi-profile equipment.
Unresolved choices return `TESSERA_PROFILE_POLICY_REQUIRED` and a
`tessera-profile-policy.scaffold.json`. Complete its `selectedProfile` values
and active counts, then rerun with `--profile-policy`. RosterPilot freezes the
policy hash. The website path validates each choice against the enriched
inventory; the local path validates it against the exact bundle profiles and
embeds the requirements in the compiled JSON. It never silently picks the
first alternate profile. If website enrichment exposes a decision that was
absent from the frozen bundle inventory, the command writes an updated scaffold
and stops before Tessera. Resume the same manifest with that completed policy
to reuse the already verified provider inputs.

The command requires `--execution-mode simulate` to drive Tessera.
`prepare-only` creates and verifies New Recruit-enriched handoffs for `website`
or bundle-native JSON for `local-engine`, then returns a successful `prepared`
report with no invented simulation values. Local preparation creates no remote
list and reports zero remote mutations and zero New Recruit cache reuses.
A requested simulation with no trusted matrices returns `ok: false` while
retaining preparation and structured failure details. Verified provider files
can be reused only after their discriminator, hash, and exact identities match.
Website New Recruit list URLs remain in a local run inventory; deletion always
requires a separate action. On macOS the inventory is
`~/Library/Application Support/RosterPilot/new-recruit-run-inventory.json`.
Inspect its recorded URLs and remove lists through New Recruit only after a
separate cleanup decision; the stress workflow never performs that mutation.

For the website provider, the metadata readiness check is followed by a live
probe using the first screening capture: it must unlock premium, select the
exact imported lists, and return a fresh matrix. A browser, credential, unlock,
or missing-matrix failure stops later proxies for that invocation. The local
provider instead reparses and verifies both JSON inputs before its first
capture. Resume continues within the same bounded lifetime retry budget.

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
failures need `--force-retry`. Otherwise resume fails closed. If a website run
stopped after starting a New Recruit delivery but before persisting its verified
receipt, resume reports the uncertain outcome instead of risking a duplicate
list. Local preparation has no corresponding uncertain-remote-outcome state.

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
It reuses the frozen portfolio, profile policy, and provider-specific prepared
artifacts only when their kind, identities, content hashes, and summaries still
match. Local inputs must additionally retain the exact bundle, compiler, and
roster fingerprint. The source run remains unchanged. A restart requires a
different `--out-dir`; `--resume` and `--restart-from` cannot be combined, and
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
score. The schema-v3 result statuses are `prepared` when provider-specific
preparation completed without a simulation request, `failed` when required
work produced no trusted
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
bundle and roster semantic identities. It reuses the exact prepared opponent
inputs, configuration, and three
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
hash-verified stress manifest. Before a worker performs any data-consuming
work, it restores and activates the job's exact archived `bundleId`; refresh or
rollback affects only other future leases. The first three attempts are the
automatic tier and five attempts is the lifetime ceiling. `--restart-from` is
explicit recovery after exhaustion or runtime drift: it creates a new run/stage
from hash-verified frozen inputs and carries no old simulation evidence. Exact
jobs freeze and reverify their prepared player and opponent artifacts so retry
and resume do not repeat preparation. Website artifacts are ROSZ pairs;
canonical local artifacts are source/local-input JSON pairs. Their simulation
remains one analytical stage rather than the stress workflow's per-opponent
screening/deep-dive stages. Cancellation retains the job, artifacts, website
prepared-list inventory, and any remote lists.

The matching local MCP tools are `start_tessera_run`,
`get_tessera_run_status`, `resume_tessera_run`,
`resolve_tessera_profiles`, `restore_tessera_new_recruit_artifact`, and
`cancel_tessera_run`. The job path is opaque caller state and must be copied
exactly from the start response. The CLI reads the policy from
`--profile-policy`; the MCP resolution tool accepts the validated structured
policy object. The restore tool is only for a legacy
`NEW_RECRUIT_MUTATION_ALREADY_CREATED` receipt: pass the unchanged roster and
the exact retained `tessera-run.json`. It verifies the job binding, mutation
receipt, gameplay identity, and both sealed ROSZ hashes before writing local
recovery state. It never contacts New Recruit or Tessera and never starts a
simulation.
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
`compare_stress_test_revision`, plus the six job tools above. Hosted MCP,
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
- `NEW_RECRUIT_MUTATION_ARTIFACT_REUSED` means the ordinary cache was missing,
  but the created-mutation receipt's content-addressed, support-owned
  source/enriched pair was rehashed, identity-checked, and reused without a new
  remote list. This applies to canonical rosters and uploaded opponent ROSZ
  subjects.
- `NEW_RECRUIT_LEGACY_ARTIFACT_RESTORED` means an explicitly supplied legacy
  Tessera job matched the created receipt and both sealed ROSZ hashes, and its
  artifact was migrated into local recovery state without New Recruit,
  Tessera, upload, or simulation activity. Missing, changed, or ambiguous
  evidence remains blocked.
- `TESSERA_INPUT_NOT_PROFILE_RICH` and
  `TESSERA_INPUT_PROFILES_INCOMPLETE` stop before Tessera browser or licence-key
  activity; never substitute the source `.rosz` for the enriched archive.
- A local input whose schema, SHA-256, `bundleId`, compiler version, roster
  fingerprint, selected profile, unit, weapon, or required characteristic does
  not verify stops before simulation. Explicit local-engine execution does not
  invoke New Recruit or use website fallback to repair it.
- `TESSERA_LOCAL_BASE_PROFILE_EVALUATION`, omitted-ability or wargear warnings,
  unsupported-keyword warnings, and frozen-choice warnings describe modeled
  limits. They are retained with the result and never promoted to full-rules
  evidence.
- Older prepared-roster documents keep the field names `sourceRoszPath` and
  `enrichedRoszPath`. When `simulationInput.kind` is
  `rosterpilot-local-engine-input`, those fields point to source and compiled
  JSON. Consumers must follow the discriminator and hashes, not assume ZIP
  content from the legacy names.
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
- Paired stress revisions reuse frozen opponents and fail if their prepared
  provider artifacts are missing, changed, or no longer match their execution
  fingerprints. Each rerun must also preserve the baseline's exact
  phase/metric/direction settings and iteration counts.
- Paired exact revisions likewise preserve the opponent, bundle and semantic
  identities, points contract, profile policy, scenario contract, simulator
  settings, and selected provider identity; incomplete trusted aggregates remain
  ambiguous rather than producing a roster-level improvement.
- Output files are not overwritten unless `--overwrite` is supplied.
- Writes outside the current directory require `--allow-outside-root`.
