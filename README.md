# RosterPilot

RosterPilot is a deterministic Warhammer 40,000 roster engine with four surfaces:

- a browser-based army builder;
- the `rosterpilot` terminal command;
- a local stdio MCP server for Codex, Claude Desktop, and other MCP clients;
- authenticated REST/OpenAPI and Streamable HTTP MCP endpoints for remote agents.

See [Architecture](docs/architecture.md) for system boundaries, delivery
workflow, authentication state, and credential flow diagrams. See the
[Workflow guide](docs/workflows.md) for a task-oriented setup and command
reference.

All 35 embedded Warhammer 40,000 11th Edition faction entries are searchable
and buildable, including Space Marine chapter entries that inherit their parent
datasheet pool. Points and legality come from pinned
[`@alpaca-software/40kdc-data`](https://github.com/wn-mitch/40kdc-data), not
from an LLM.

## Choose your workflow

RosterPilot does not force a pipeline. Building and validating a roster is a
complete workflow; file export, New Recruit delivery, exact-list Tessera
comparison, and known-faction stress testing are separate, explicit branches.

| What you want to do | Setup | Platforms |
| --- | --- | --- |
| Build, validate, print, save JSON, or export `.rosz` | `npm run setup -- --profile core` | macOS, Linux, Windows |
| Use the local MCP server | `npm run setup -- --profile mcp` | macOS, Linux, Windows |
| Upload and verify a New Recruit list | `npm run setup -- --profile new-recruit` | macOS |
| Compare two known armies in Tessera | `npm run setup -- --profile tessera` | macOS |
| Stress-test a roster against an unknown list from a known faction | `npm run setup -- --profile tessera` | macOS |

Run `npm run rosterpilot -- workflows` at any time for machine-specific
readiness and the next command for each path. The macOS restriction applies
only to credential-backed browser automation; the engine and file handoffs are
portable.

## Run locally

Requires Node.js 22.13 or newer. The repository includes `.nvmrc` for the
Node 22.13 baseline used by automation.

```bash
nvm use
npm ci
npm run dev
```

For a guided first-time setup that installs the locked dependencies, verifies
the pinned roster data, checks live freshness, and optionally configures local
MCP or New Recruit automation, run:

```bash
npm run setup
```

Useful commands:

```bash
npm run doctor -- --profile core --refresh skip
npm run rosterpilot -- status
npm run rosterpilot -- freshness
npm run rosterpilot -- conflicts --faction adeptus-custodes --blocking true
npm run rosterpilot -- search custodes
npm run rosterpilot -- search praetors --faction adeptus-custodes
npm run rosterpilot -- build --prompt "Build a 1,000 point fast Custodes army with no named characters" --out roster.json
npm run rosterpilot -- build --faction aeldari --points 1000 --preferences mobility,shooting,objective --out aeldari.json
npm run rosterpilot -- validate --file roster.json
npm run rosterpilot -- export --file roster.json --format rosz --out roster.rosz
npm run rosterpilot -- tessera stress-test --file roster.json --against-faction necrons --experimental --out-dir exports/necrons-stress
npm run mcp
npm run data:check
npm run data:check-latest
npm run data:sync-check
```

File writes stay within the current directory unless `--allow-outside-root` is supplied. Existing files are never replaced unless `--overwrite` is supplied.

## New computer setup

A fresh clone already contains the reviewed source manifest and generated
catalogue data for its pinned release. First-time setup verifies that release;
it does not silently advance the repository to newer upstream data.

```bash
git clone <repository-url>
cd new_recruit
nvm use
npm run setup
```

The interactive setup offers cumulative profiles:

- `core` installs dependencies and verifies the engine and pinned data;
- `mcp` also creates a machine-local Codex MCP configuration;
- `new-recruit` also builds and optionally configures the macOS delivery
  companion.
- `tessera` also prepares the New Recruit enrichment dependency and optionally
  configures the Tessera licence key.

Repeatable noninteractive examples:

```bash
npm run setup -- --profile core --non-interactive --refresh check
npm run setup -- --profile mcp --non-interactive --refresh skip
npm run setup -- --profile new-recruit --non-interactive --refresh skip
npm run setup -- --profile tessera --non-interactive --refresh skip
```

`--refresh check` checks live sources and reports newer data without changing
the release in a noninteractive run. `--refresh apply` is the explicit
maintainer path: it requires a clean tracked worktree, prepares the update,
regenerates the catalogue overlay, and validates the result. It never commits
or pushes.

Use Doctor after setup to diagnose the selected profile without installing
dependencies, rebuilding the companion, opening credential dialogs, or
applying updates:

```bash
npm run doctor -- --profile core --refresh skip
npm run doctor -- --profile mcp --refresh check
```

Setup and Doctor detect missing prerequisites and explain what to install, but
never invoke Homebrew, `nvm`, or another system package manager.

If the checkout or active Node installation moves, rerun the selected setup
profile. Credential-backed status fails closed when the running local agent
belongs to another checkout, instead of using stale worker code.

## Local MCP setup

This repository is the authoritative source for the RosterPilot engine, MCP
server, skill, data manifests, and generated catalogue overlay. Run the MCP
profile to generate configuration using the active Node executable and the
absolute path of the current checkout:

```bash
npm run setup -- --profile mcp
```

If `.codex/config.toml` does not exist, setup creates it as an ignored,
machine-local file. It never overwrites an existing Codex configuration.
Setup also prints a ready-to-copy Claude Desktop JSON block but does not edit
Claude's global configuration.

The server exposes:

`get_data_status`, `check_data_freshness`, `list_data_conflicts`,
`get_new_recruit_capability`, `search_factions`, `compare_factions`,
`search_units`, `build_roster`, `modify_roster`, `validate_roster`,
`explain_roster`, `export_roster`, and `prepare_new_recruit_handoff`.

Every MCP build consults a 15-minute live freshness cache. The result warns
when npm, BSData, or the official points app moved, but the roster remains
pinned to its recorded release so repeated builds stay reproducible.

The repository-contained Codex skill is in `skills/rosterpilot`. To make it globally discoverable, copy that folder to `~/.codex/skills/rosterpilot`, or keep it version-controlled and invoke it from this repository.

## Remote agents

Remote access is disabled until the hosted environment has:

```text
ROSTERPILOT_API_TOKEN=<long random token>
ROSTERPILOT_ALLOWED_ORIGINS=https://allowed-client.example
```

Clients send `Authorization: Bearer <token>`. Non-browser MCP clients may omit `Origin`; browser requests must match the site origin or `ROSTERPILOT_ALLOWED_ORIGINS`.

- Streamable HTTP MCP: `/mcp`
- OpenAPI document: `/openapi.json`
- REST base: `/api/v1`

REST routes include data status, freshness, conflict and New Recruit coverage,
faction/unit search, and roster build, modify, validate, explain, export, and
New Recruit handoff. Remote exports are always returned inline; remote agents
cannot write server files.

## New Recruit handoff

Every validated faction can export New Recruit-shaped JSON, canonical roster
JSON, text, and print-ready HTML. `.ros/.rosz` import at
[New Recruit](https://www.newrecruit.eu/app/MyLists) uses mappings generated
from the exact pinned `BSData/wh40k-11e` commit. Export is enabled per roster
when every selected configuration, unit, model, and wargear reference is
mapped and conflict-free. Unmapped factions fail with
`NEW_RECRUIT_MAPPING_UNAVAILABLE`; selected source disagreements fail with
`NEW_RECRUIT_DATA_CONFLICT`.

For a mapped faction, `prepare_new_recruit_handoff` returns the editable
`.rosz` and, by default, a printable HTML companion in one validated response.
Local stdio clients may write both artifacts to a directory; remote clients
receive inline content.

### Local automated delivery on macOS

For mapped factions, the local stdio MCP and terminal CLI can optionally use a dedicated Chrome
profile plus a dedicated credential in the traditional macOS login Keychain to
import a validated roster and download New Recruit's Pretty HTML. These tools
are intentionally absent from hosted MCP, REST, OpenAPI, and the public
website.

Install the per-user local agent, then configure the credential through its
secure macOS dialog:

```bash
npm run companion:build
npm run rosterpilot -- agent install
npm run rosterpilot -- new-recruit configure
npm run rosterpilot -- new-recruit status
```

The LaunchAgent starts when the user signs in and exposes a user-only local
socket. Restricted workspaces that cannot connect to local sockets use an
atomic `0700` file queue under `/private/tmp` instead. CLI, stdio MCP, New
Recruit delivery, and Tessera preparation send high-level roster jobs through
the agent; neither transport can request or return the saved password. Use
`npm run rosterpilot -- agent status` for sanitized diagnostics, or `agent
restart` and `agent uninstall` to manage it. Uninstalling preserves the
Keychain item and dedicated Chrome profile.

Then deliver a canonical RosterPilot JSON draft:

```bash
npm run rosterpilot -- new-recruit deliver \
  --file roster.json \
  --enriched \
  --out-dir exports/new-recruit
```

`--enriched` additionally downloads and verifies New Recruit's profile-rich
`.rosz`; this is the preferred Tessera handoff. Use `--no-pretty` to import
without downloading HTML. Existing files are never
replaced unless `--overwrite` is supplied. Use
`npm run rosterpilot -- new-recruit forget` to delete the dedicated credential.

The local MCP additionally exposes `get_new_recruit_connection_status` and
`deliver_roster_to_new_recruit`. Delivery is non-idempotent and must only be
called after an explicit request to upload, import, or send the roster. V1
always creates a new New Recruit list and never replaces or deletes one.

The companion:

- installs its native Keychain broker under
  `~/Library/Application Support/RosterPilot/bin/` instead of trusting a
  checkout-specific build path;
- serializes browser jobs through a per-user LaunchAgent, using a `0600`
  socket or a `0700` atomic file queue when a workspace sandbox blocks sockets;
- uses a visible, isolated Chrome profile under
  `~/Library/Application Support/RosterPilot/NewRecruitChrome`;
- reuses the signed-in session and reads the credential only when login is
  needed;
- stores the credential as a dedicated generic-password item protected by the
  login Keychain and a broker-specific application ACL;
- enters credentials only on the exact New Recruit origin;
- returns paths, list URLs, and verification results—not credentials, cookies,
  browser storage, or access tokens;
- validates the imported name, faction, points, and unit counts before
  downloading Pretty HTML or an enriched `.rosz`;
- verifies the enriched archive's generator, roster metadata, exact model
  multiset, and embedded model/weapon profiles.

Automatic credential access is available only while the user is signed in and
the macOS login Keychain is unlocked. Credential configuration and removal
remain manual terminal operations and are never exposed as MCP tools.

### Tessera matchup handoff

RosterPilot's local MCP and CLI can prepare New Recruit-enriched `.rosz` files
for [Tessera](https://playtessera.gg/), compare known armies, and stress-test a
roster against an unknown list from a known faction. These are independent from
ordinary roster building and New Recruit export: they run only after an
explicit `tessera prepare`, `tessera analyze`, `tessera stress-test`, or local
MCP request. These capabilities remain inside the RosterPilot plugin:

```bash
npm run rosterpilot -- tessera status
npm run rosterpilot -- tessera configure
npm run rosterpilot -- tessera prepare \
  --file roster.json \
  --out-dir exports/tessera
npm run rosterpilot -- tessera analyze \
  --file roster.json \
  --opponent-faction necrons \
  --experimental \
  --out-dir exports/tessera
```

Use `--opponent-file enemy.rosz` for an exported list or
`--opponent-roster enemy.json` for another canonical RosterPilot draft.
Faction archetypes are deterministic balanced, ranged-pressure, and
assault-pressure proxies—not claims about the current tournament meta.

The default `full` analysis runs 16 raw Tessera scenarios per opponent: Shooting
and Fight, four metrics (wipe probability, half-wipe probability, mean kills,
and mean damage), and both attack directions. RosterPilot consolidates those
matrices by phase and direction, calculates mean damage per 100 attacker
points, and preserves the visible iteration count and simulator settings.
For a faster smoke test, quick mode runs Shooting wipe probability in both
directions:

```bash
npm run rosterpilot -- tessera analyze \
  --file roster.json \
  --opponent-file enemy.rosz \
  --analysis-mode quick \
  --experimental \
  --out-dir exports/tessera-quick
```

`--phases` and `--metrics` can select an explicit subset. `--experimental`
opts into local Tessera UI automation; without it, analysis returns verified
handoff files and a partial report.

#### Known faction, unknown list

Use a faction stress test when you know the opposing faction but not the
opponent's exact roster:

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

`build-and-stress` is the explicit full loop. It preserves opponent context
and mixed-threat intent, deterministically repairs the roster, requires at
least 98% points utilization with no red overall mission-readiness result,
previews the portfolio, checks weapon-profile policy, reuses verified New
Recruit artifacts when possible, and only then starts Tessera. Use
`--allow-readiness-warnings` only after reviewing a failed gate. The command
never applies a post-simulation change; it returns candidates for a separately
authorized paired revision.

To stress-test an existing roster instead:

```bash
npm run rosterpilot -- tessera stress-test \
  --file roster.json \
  --against-faction aeldari \
  --suite diverse-9 \
  --analysis staged \
  --profile-policy profiles.json \
  --experimental \
  --out-dir exports/aeldari-stress
```

The default `diverse-9` suite attempts nine legal, exportable proxies:
balanced-control, ranged-pressure, and assault-pressure postures crossed with
mixed, mass, and elite-heavy compositions. A faction may proceed with six to
eight only when the Tessera payloads are materially distinct and all three
postures remain represented; weights are renormalized and the result is capped
at `degraded`. Fewer than six fails preflight. `core-3` requires three unique
proxies covering all postures. Detachment-only differences do not count as
distinct payloads, and named anchors are deliberately tested where legal.
Every survivor is weighted equally; this is a coverage sample, not an estimate
of what players are likely to bring.

The default `staged` strategy screens every available proxy with half-wipe
probability in Shooting and Fight, in both directions. It then chooses three
frozen representatives—stress, central, and contrast—and runs wipe
probability, mean kills, and mean damage on those representatives. `full-all`
runs all four metrics, both phases, and both directions for every available
proxy. On a complete `diverse-9` suite, staged analysis captures 72 raw
directional scenarios; `full-all` captures 144.

Before external activity, RosterPilot scans the player and frozen proxies for
multi-profile weapons. If any choice is unresolved, it returns
`TESSERA_PROFILE_POLICY_REQUIRED`, writes
`tessera-profile-policy.scaffold.json`, and stops before New Recruit or
Tessera. Complete each entry with the intended profile and active count, then
rerun with `--profile-policy`. The validated canonical policy hash is frozen
into the manifest and report; changing it invalidates resume and paired
revision. After New Recruit enrichment, the complete profile inventory is
verified again.

`--experimental` is required to run Tessera simulation. Omitting it still
performs the explicitly requested New Recruit enrichment and returns a
handoff-only, partial report; it never fabricates simulation values. A first
uncached `diverse-9` run can create one player copy plus six to nine proxy
copies. Verified enriched artifacts are cached by execution fingerprint and
pinned source data, with their content hash and exact summary checked before
reuse. Staged deep dives reuse those same copies. Remote list URLs are retained
in a local inventory; RosterPilot never deletes remote lists automatically.

Each run writes a `stress-manifest.json` beside the JSON and interactive HTML
reports. Resume an interrupted run without repeating completed stages:

```bash
npm run rosterpilot -- tessera stress-test \
  --file roster.json \
  --against-faction necrons \
  --suite diverse-9 \
  --analysis staged \
  --experimental \
  --resume \
  --out-dir exports/necrons-stress
```

Bare `--resume` reads `<out-dir>/stress-manifest.json`; pass
`--resume path/to/stress-manifest.json` to select it explicitly. Resume accepts
only the same player fingerprint, opponent faction, data pin, suite, analysis
strategy, simulation setting, and profile-policy hash. Schema-v1 manifests are
migrated in memory and rewritten as v2 only when resumed. Every v2 stage
records attempt count, first/last attempt time, structured error code,
retryability, and next action. Transient failures receive three automatic
attempts with bounded backoff and up to five lifetime attempts through explicit
resume; terminal failures require `--force-retry`. Completed child reports are
reused only after their hashes, roster identities, and requested scenario
cells validate. A mismatch fails closed rather than mixing runs. If delivery
began but its verified receipt was not persisted before a crash, resume stops
instead of risking a duplicate New Recruit list.

Stress reports summarize directional offensive coverage, incoming threat
exposure, coverage margin, phase dependence, and unit answer breadth across the
frozen proxies. They do not report a whole-game win probability. Deterministic
mission readiness is shown separately and acts as a guardrail for roster-change
suggestions; it is never blended into the combat robustness score. Stress
report and manifest schema v2 distinguish:

- `partial`: required preparation or simulation work is missing or failed;
- `inconclusive`: capture finished, but analytical confidence is insufficient;
- `degraded`: at least six confident unique `diverse-9` proxies cover all
  postures and all three deep dives completed;
- `complete`: all nine unique confident proxies and all three deep dives
  completed (`core-3` requires its three).

Missing estimates are `null`. Below-threshold observations remain separately
under `provisional` with their point coverage. `partial` takes precedence when
capture and confidence failures occur together. Shareable JSON and HTML use
relative artifact references and can be moved as a bundle; only the local
manifest stores absolute paths. CLI progress goes to stderr and stdout is a
compact JSON summary by default. Use `--full-json` for the nested payload.

Player and opponent totals must differ by no more than 5% of the player's
points limit. Exact rosters outside that inclusive tolerance fail with
`TESSERA_POINTS_MISMATCH`; generated faction proxies outside it are omitted.
`--allow-point-mismatch` permits an intentionally mismatched directional run,
but the report is labeled `unmatched` and RosterPilot suppresses roster-change
candidates.

Schema-v2 reports use stable unit-instance labels and evidence-backed findings
for reliable coverage, enemy threats, coverage gaps, inefficient attacks,
overqualified trades, and phase role gaps. When the comparison is matched and
scenarios were captured, RosterPilot may propose up to three legal
single-operation changes: add a unit, resize a unit, or replace a unit. Each
candidate is validated, fingerprinted, and linked to its evidence. Candidates
are suggestions only; RosterPilot never changes, imports, or simulates a
revised roster without explicit approval. Use `--no-change-candidates` to omit
them. Tessera import issues are tied to side, unit, weapon group, available
profiles, and phase. Only cells involving the affected attacking unit are
ambiguous and excluded from confident findings.

After approving and saving a revised canonical roster, rerun the baseline
opponents and settings and produce a before/after delta report:

```bash
npm run rosterpilot -- tessera compare-revision \
  --baseline-report exports/tessera/roster-matchup.json \
  --revised-roster revised-roster.json \
  --experimental \
  --out-dir exports/tessera-revision
```

Revision comparison requires a schema-v2 baseline with captured scenarios and
a valid revised roster from the same faction. It fails before delivery if the
baseline is partial or local browser analysis was not explicitly enabled. It
reuses the baseline's
validated opponent `.rosz` files and simulator configuration, then classifies
each comparable cell as improved, worsened, unchanged, or ambiguous.

For a faction stress-test baseline, use the paired stress revision command:

```bash
npm run rosterpilot -- tessera compare-stress-revision \
  --baseline-report exports/necrons-stress/roster-vs-necrons-stress-test.json \
  --revised-roster revised-roster.json \
  --experimental \
  --out-dir exports/necrons-stress-revision
```

The revised roster must have the same player faction, points limit, and pinned
data release. RosterPilot reuses the baseline's exact enriched proxy rosters,
suite, analysis strategy, simulator settings, and representative selections;
it does not regenerate the portfolio or choose easier opponents. Missing
or changed baseline artifacts, execution-fingerprint mismatches, or
insufficient simulated coverage stop the comparison before a rerun. The
revised run must reproduce the recorded Tessera settings and iteration counts
for every exact phase/metric/direction scenario. Margin changes smaller than one
percentage point are treated as unchanged. The paired conclusion uses the
screening half-wipe robustness metric; deep-dive wipe, kill, and damage results
are supporting evidence. The conclusion is suppressed when the separate
mission-readiness guardrail fails.

The local MCP exposes `get_tessera_connection_status`,
`prepare_roster_for_tessera`, `analyze_roster_matchup`, and
`compare_roster_revision`, plus
`stress_test_roster_against_faction` and
`compare_stress_test_revision`,
`preview_faction_stress_portfolio`, and
`build_and_stress_roster_against_faction`. Hosted MCP, REST, OpenAPI, and the
website omit all of them; there is no public stress-test UI. Each stress run
uses one isolated local Tessera session state across proxy requests and removes
it on completion or after a 30-minute expiry. The orchestrator never receives
or returns the premium key. `tessera
configure` collects the key in a native secure dialog and stores it as a
dedicated login-Keychain item; only the short-lived Tessera worker can retrieve
it, and only to fill Tessera's Licence key field on the exact
`https://playtessera.gg` origin. Use `tessera forget` to remove it.

If Tessera is disabled, unavailable, or its UI changes after the enriched
rosters are prepared, RosterPilot preserves those verified handoff artifacts
and emits a `partial` report with warnings instead of inventing missing cells.
Reports are directional combat math, not game win probability; movement,
terrain geometry, missions, scoring, deployment, sequencing, player decisions,
and unmodeled stratagems are excluded.

ROS/ROSZ exports use versioned BSData catalogue references for configuration,
units, models, and wargear. If a selected item has no catalogue mapping,
RosterPilot rejects the export instead of emitting a file that New Recruit
would import as an empty roster.

The website stores versioned draft history in browser `localStorage`. It does
not inspect New Recruit credentials, call New Recruit's private APIs, automate
cross-origin browser mutations, or use a cloud roster database. Agent clients
with browser control may import the generated `.rosz` only when the user
explicitly asks for that assisted workflow.

Fixture-based Chrome tests are opt-in because they launch an actual isolated
browser process:

```bash
ROSTERPILOT_BROWSER_TESTS=1 \
  node --import tsx --test tests/new-recruit-companion.test.ts
```

## Data and verification

`data/sources.json` records the release ID, exact rules package, exact
`BSData/wh40k-11e` commit, and official MFM version/content hash. Generated
catalogue mappings and structured conflicts live in
`data/generated/new-recruit-catalogues.json`.

`npm run data:check` verifies the cross-faction build matrix, manifest
consistency, provisional point coverage, legal acceptance rosters, and both
Custodes and cross-faction `.rosz` export. `npm run data:check-latest` checks
all three live source classes without mutating the release.
`npm run data:sync-check` regenerates from the pinned BSData commit and fails
if the checked-in overlay differs. The daily `Roster data freshness` workflow
uses `npm run data:prepare-update` to open a reviewable update pull request; it
never auto-merges.

Community data is pinned for reproducibility. Confirm event-specific rulings before play. Public deployments must display the included “Powered by 40kdc-data” attribution.
