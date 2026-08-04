# RosterPilot

RosterPilot is a deterministic Warhammer 40,000 roster engine with five delivery surfaces:

- a browser-based army builder;
- the `rosterpilot` terminal command;
- an installable ChatGPT/Codex personal plugin backed by the local stdio MCP
  server;
- standalone local stdio MCP configuration for Codex, Claude Desktop, and
  other MCP clients;
- authenticated REST/OpenAPI and Streamable HTTP MCP endpoints for remote agents.

See [Architecture](docs/architecture.md) for system boundaries, delivery
workflow, authentication state, and credential flow diagrams. See the
[Workflow guide](docs/workflows.md) for a task-oriented setup and command
reference, and [Local ChatGPT/Codex plugin setup](docs/chatgpt-codex-plugin.md)
for the machine installation and ownership model.

All 35 embedded Warhammer 40,000 11th Edition faction entries are searchable
and buildable, including Space Marine chapter entries that inherit their parent
datasheet pool. Machine-verifiable Games Workshop publications are
authoritative for published rules such as points and leader links;
[`@alpaca-software/40kdc-data`](https://github.com/wn-mitch/40kdc-data)
supplies structured units, weapons, stats, and community-authored mechanics.
Points and legality never come from an LLM.

## Choose your workflow

RosterPilot does not force a pipeline. Building and validating a roster is a
complete workflow; file export, New Recruit delivery, exact-list Tessera
comparison, and known-faction stress testing are separate, explicit branches.

| What you want to do | Setup | Platforms |
| --- | --- | --- |
| Build, validate, print, save JSON, or export `.rosz` | `npm run setup -- --profile core` | macOS, Linux, Windows |
| Use the ChatGPT/Codex personal plugin | `npm run setup -- --profile core`, then `npm run plugin:local:install` | macOS owner machine |
| Use a standalone local MCP client | `npm run setup -- --profile mcp` | macOS, Linux, Windows |
| Upload and verify a New Recruit list | `npm run setup -- --profile new-recruit` | macOS |
| Compare two known armies in Tessera | `npm run setup -- --profile tessera` | macOS |
| Stress-test a roster against an unknown list from a known faction | `npm run setup -- --profile tessera` | macOS |
| Build and analyze a roster against one exact known army | `npm run setup -- --profile tessera` | macOS |

Run `npm run rosterpilot -- workflows` at any time for machine-specific
readiness and the next command for each path. The macOS restriction applies
only to credential-backed browser automation; the engine and file handoffs are
portable.

Opponent scope is explicit. An exact comparison accepts a canonical opponent
roster or `.rosz`; a faction stress test requires the known opposing faction;
and counter-building requires a canonical opponent roster. Passing only a
faction to the CLI exact-list command fails with `OPPONENT_SCOPE_REQUIRED`
and directs the caller to faction stress testing. If neither a roster nor a
faction is known, RosterPilot does not guess one.

## Run locally

Requires Node.js 22.13 or newer. The repository includes `.nvmrc` for the
Node 22.13 baseline used by automation.

```bash
nvm use
npm ci
npm run dev
```

For a guided first-time setup that installs the locked dependencies, verifies
the compiled release data, checks live freshness, and optionally configures a
standalone local MCP client, New Recruit, or Tessera automation, run:

```bash
npm run setup
```

Useful commands:

```bash
npm run doctor -- --profile core --refresh skip
npm run rosterpilot -- agent ensure-current
npm run rosterpilot -- status
npm run rosterpilot -- freshness
npm run rosterpilot -- data update-status
npm run rosterpilot -- data refresh
npm run rosterpilot -- data start-local-update
npm run rosterpilot -- data update-job --job <job-id>
npm run rosterpilot -- data rollback --bundle <retained-bundle-id>
npm run rosterpilot -- conflicts --faction adeptus-custodes --blocking true
npm run rosterpilot -- search custodes
npm run rosterpilot -- search praetors --faction adeptus-custodes
npm run rosterpilot -- build --prompt "Build a 1,000 point fast Custodes army with no named characters" --out roster.json
npm run rosterpilot -- build --faction aeldari --points 1000 --preferences mobility,shooting,objective --out aeldari.json
npm run rosterpilot -- validate --file roster.json
npm run rosterpilot -- rebase --file roster.json --out rebased.json
npm run rosterpilot -- export --file roster.json --format rosz --out roster.rosz
npm run rosterpilot -- tessera stress-test --file roster.json --against-faction necrons --execution-mode simulate --out-dir exports/necrons-stress
npm run mcp
npm run plugin:local:check
npm run plugin:local:install
npm run data:check
npm run data:check-latest
npm run data:sync-check
```

The data status commands are always safe to run. A cloned or self-hosted Node
installation defaults to `local-source`: it needs no signing key, public-key
registry, signed bootstrap, or RosterPilot data-channel account. On startup it
continues immediately from the compiled application snapshot, queues a
background source check when due, and activates only a fully certified local
snapshot for future operations. `data refresh` forces that durable check now
and returns without waiting for downloads or compilation; `data update-status`
shows the latest job and its progress. For troubleshooting or automation,
`data start-local-update` returns the durable job ID and `data update-job`
inspects that exact job; normal recovery queues and follows these jobs for the
user automatically.

File writes stay within the current directory unless `--allow-outside-root` is supplied. Existing files are never replaced unless `--overwrite` is supplied.

## New computer setup

A fresh clone already contains the reviewed source manifest and generated
compiled data for its application-release snapshot. First-time setup verifies
that snapshot and starts the local updater in the background. Roster work does
not wait for the first source build, and the updater never rewrites tracked
checkout files.

```bash
git clone <repository-url>
cd new_recruit
nvm use
npm run setup
```

The interactive setup offers cumulative profiles:

- `core` installs dependencies and verifies the engine and compiled release data;
- `mcp` also creates a machine-local standalone Codex MCP configuration unless
  `rosterpilot@personal` is already registered;
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

`--refresh check` compares live sources without changing the active snapshot.
`--refresh apply` queues the same durable local-source job used by the daily
updater. It never rewrites the checkout, publishes a release bundle, commits,
or pushes. When the network or updater is unavailable, setup continues from
compiled release data and reports a clear Doctor action. A later successful
job atomically activates its `locally-verified` snapshot for new work only.

Use Doctor after setup to diagnose the selected profile without installing
dependencies, rebuilding the companion, opening credential dialogs, or
applying updates:

```bash
npm run doctor -- --profile core --refresh skip
npm run doctor -- --profile mcp --refresh check
npm run doctor -- --profile tessera --refresh skip
```

Doctor runs local checks independently and reports structured next steps.
`--refresh skip` performs no network-backed BSData synchronization or live
freshness check; `--refresh check` reports those remote checks separately, and
an offline result does not hide browser or local-agent failures. Setup and
Doctor detect missing prerequisites and explain what to install, but never
invoke Homebrew, `nvm`, or another system package manager.

If the checkout or active Node installation moves, rerun the selected setup
profile. Credential-backed status fails closed when the running local agent
belongs to another checkout, instead of using stale worker code.
`npm run rosterpilot -- agent ensure-current` verifies checkout, protocol,
build identity, and runtime freshness, then uses the supported restart or
installation lifecycle to repair the agent. Its result retains the original
mismatch and the repair actions it performed.

For ChatGPT/Codex on a fresh owner Mac, install the plugin before an
MCP-inclusive browser-automation profile. This keeps the standalone
`.codex/config.toml` path from shadowing the plugin-owned server:

```bash
npm run setup -- --profile core --refresh check
npm run plugin:local:install
npm run setup -- --profile tessera --refresh skip
npm run rosterpilot -- agent ensure-current
npm run plugin:local:check
```

Use `--profile new-recruit` instead of `tessera` when appropriate. Verify New
Recruit and Tessera separately with their `status` commands, then open a new
ChatGPT/Codex task. See the
[personal-plugin guide](docs/chatgpt-codex-plugin.md) for prerequisites,
switching from standalone MCP, and recovery.

## Local MCP and ChatGPT/Codex setup

### Standalone MCP clients

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
Claude's global configuration. This standalone Codex entry is an alternative
to `rosterpilot@personal`: a project-local server with the same name takes
precedence over the plugin.

The server exposes shared tools for rules and data status, faction and unit
research, deterministic build/modify/validate/explain workflows, export and
New Recruit handoff preparation, rebase and bundle controls, batch jobs, and
optimization. The local stdio transport conditionally adds New Recruit and
Tessera tools when their independently managed macOS agent is ready. The tool
set is capability-driven and may grow; clients should discover it through MCP
instead of relying on a fixed count.

Local CLI, MCP, agent, and writable self-hosted Node runtimes default to the
same durable `local-source` provider. Startup queues a non-blocking check when
the last attempt is more than 24 hours old; the macOS companion wakes hourly
and queues only when due. A changed source is fetched and built in isolated
temporary storage, certified, written as an immutable local snapshot, and then
activated atomically. Failed automatic checks retry with bounded backoff while
the last usable snapshot remains active. Every data-consuming operation leases
one immutable snapshot, so activation affects only later operations. Status,
refresh, and rollback are control-plane operations and do not acquire a roster
data lease. `check_data_freshness` is a separate raw-upstream diagnostic; it
cannot certify or activate data.

The repository-contained Codex skill is in `skills/rosterpilot`. Setup installs
or updates a hash-marked managed copy without touching unrelated skills:

```bash
npm run skill:check
npm run skill:install
```

An existing unmanaged target is never overwritten. Plugin-cache copies are
reported separately because Codex owns that cache. The installable plugin
source lives in `plugins/rosterpilot`; `npm run plugin:check` proves that its
packaged skill and base version match this repository, while
`npm run plugin:sync` repairs a stale source package atomically. A personal or
published plugin must then be republished and reinstalled through its
marketplace so Codex creates a new cache version; setup never edits cached
plugin files in place. Start a new Codex task after reinstalling so the new
skill instructions are loaded.

### ChatGPT/Codex personal plugin

On the Mac that owns the default personal marketplace, use the supported local
lifecycle commands instead of copying plugin files or editing Codex config by
hand:

```bash
npm run plugin:local:check
npm run plugin:local:install
```

The `personal` marketplace must already map `rosterpilot` from
`./plugins/rosterpilot`, which resolves to `~/plugins/rosterpilot`, and the
checkout must not contain a shadowing `[mcp_servers.rosterpilot]` entry. The
installer verifies those preconditions, publishes a unique immutable cache
version, probes the checkout-bound MCP server, and rolls back its managed state
if publication fails. It does not create the marketplace, edit Codex's cache,
or install/restart the New Recruit and Tessera LaunchAgent. Run `agent
ensure-current` for those browser-backed capabilities, and open a new task (or
restart the app) after publication. The complete order, ownership table, and
recovery procedure are in the
[personal-plugin guide](docs/chatgpt-codex-plugin.md).

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

REST routes include data status, update status, refresh, rollback, roster
rebase, freshness, conflict and New Recruit coverage, faction/unit search, and
roster build, modify, validate, explain, export, and New Recruit handoff.
Remote exports are always returned inline; remote agents cannot write server
files.

## New Recruit handoff

Every validated faction can export New Recruit-shaped JSON, canonical roster
JSON, text, and print-ready HTML. `.ros/.rosz` import at
[New Recruit](https://www.newrecruit.eu/app/MyLists) uses mappings generated
from the exact `BSData/wh40k-11e` provenance recorded by the active verified
snapshot. Export compatibility is governed by the selected semantic
`mappingHash`, so a metadata-only BSData commit change does not invalidate an
unchanged export. Export is enabled per roster when every selected
configuration, unit, model, and wargear reference is mapped and conflict-free.
Unmapped factions fail with
`NEW_RECRUIT_MAPPING_UNAVAILABLE`; selected source disagreements fail with
`NEW_RECRUIT_DATA_CONFLICT`.

Mapping reports distinguish raw occurrences from unique root causes and attach
an explicit remediation owner. A `bsdata` owner means the exact pinned
catalogue selection is missing, ambiguous, or divergent; a `reconciler` owner
means RosterPilot cannot safely evaluate that catalogue structure yet. This is
diagnostic ownership, not a claim about which community project is “wrong.”

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

The supported first-time path is `npm run setup -- --profile new-recruit` (or
`--profile tessera` when both providers are needed). For lower-level repair,
install the per-user local agent and configure the credential through its
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
`npm run rosterpilot -- agent status` for sanitized diagnostics. Use `agent
ensure-current` when checkout, protocol, build, or stale-runtime diagnostics
fail; use `agent restart` and `agent uninstall` for explicit lifecycle
management. Uninstalling preserves the Keychain item and dedicated Chrome
profile.

Then deliver a canonical RosterPilot JSON draft:

```bash
npm run rosterpilot -- new-recruit deliver \
  --file roster.json \
  --out-dir exports/new-recruit
```

Every canonical delivery downloads and verifies New Recruit's profile-rich
`.rosz`. RosterPilot compares the live game-system and faction-catalogue
identity in that archive with the immutable bundle used to build the roster;
a lagging or otherwise mismatched New Recruit catalogue is rejected for
downstream use. When the only mismatch is a newer game-system revision and the
archive has exact faction-catalogue identity plus complete per-unit profiles,
it is retained separately as provisional recovery evidence. Ordinary delivery
and trusted-cache reuse remain blocked. Use
`--no-pretty` to import without downloading HTML. Existing files are never
replaced unless `--overwrite` is supplied. Use
`npm run rosterpilot -- new-recruit forget` to delete the dedicated credential.

The local MCP additionally exposes `get_new_recruit_connection_status` and
`deliver_roster_to_new_recruit`. Delivery is non-idempotent and must only be
called after an explicit request to upload, import, or send the roster. V1
creates a new New Recruit list and never replaces or deletes one. A durable
mutation receipt inventories a confirmed or uncertain remote outcome and
blocks an automatic replay that could create a duplicate.

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
  multiset, embedded model/weapon profiles, and live catalogue identity.

Automatic credential access is available only while the user is signed in and
the macOS login Keychain is unlocked. Credential configuration and removal
remain manual terminal operations and are never exposed as MCP tools.

### Tessera matchup handoff

RosterPilot's local MCP and CLI can prepare New Recruit-enriched `.rosz` files
for [Tessera](https://playtessera.gg/), compare known armies, and stress-test a
roster against an unknown list from a known faction. Matchup work has three
explicit routes:

| Opponent information | Route |
| --- | --- |
| Exact canonical roster or existing `.rosz` | `tessera analyze` / `analyze_roster_matchup` |
| Known faction, unknown exact list | `tessera stress-test` / `stress_test_roster_against_faction` |
| Exact canonical roster and a request to build a counter-roster | `tessera build-and-analyze` / `build_and_analyze_roster_matchup` |

These routes are independent from ordinary roster building and New Recruit
export. They run only after the corresponding explicit CLI or local MCP
request. Use `npm run setup -- --profile tessera` for first-time local-agent
and credential preparation; the commands below are status, repair, and
operation controls:

```bash
npm run rosterpilot -- tessera status
npm run rosterpilot -- tessera configure
npm run rosterpilot -- tessera prepare \
  --file roster.json \
  --out-dir exports/tessera
npm run rosterpilot -- tessera analyze \
  --file roster.json \
  --opponent-roster enemy.json \
  --simulation-backend auto \
  --execution-mode simulate \
  --out-dir exports/tessera
```

Simulation requests accept `--simulation-backend auto|local-engine|website`;
the same `simulationBackend` field is available through local MCP and durable
jobs.

| Selection | Current behavior |
| --- | --- |
| `auto` (default) | Uses the website until the current machine, local provider identity, data bundle, and bidirectional covering suite have an active personal parity attestation. After attestation it may select the local engine, subject to the same preflight and exact-evidence checks. |
| `website` | Forces the existing `playtessera.gg` browser route and its premium-key boundary. |
| `local-engine` | Explicitly runs the pinned engine from canonical bundle-native inputs when both rosters fit its declared capability manifest. It does not use New Recruit and never silently falls back to the website. |

The explicit local route compiles canonical roster data without opening New
Recruit or Tessera Web and without retrieving a premium key. It fails closed
for unsupported characteristics and keywords, unresolved alternate profiles,
mixed defensive profiles, ambiguous PISTOL or melee weapon choices, and
combat-relevant abilities or selected rules that cannot be classified by its
declared capability.
Every result records the requested and selected backend plus its provider
identity. Local scenarios also bind deterministic seed, execution, and
projection hashes.

The local route compiles canonical rosters into schema-v2 local inputs with
exact unit, weapon, equipment, profile, bearer, loadout-group, and range
identities. Those inputs feed a provider-neutral `rosterpilot-combat-bridge`
v3 artifact. One immutable bundle snapshot supplies the roster, faction,
mapping, and entity identities; the community
`@alpaca-software/40kdc-data` `effectToBuffs` and `resolveBuffs` compiler turns
structured rules into a stable effect vocabulary; and the Tessera adapter is a
separate projection over that artifact. Army and detachment rules, datasheet
abilities, enhancements, stratagems, wargear, and attached-unit plans are
therefore researched and mapped once instead of being inferred from either
provider's UI.

Bridge v3 adds a strict combat-corpus admission step. Every structured effect
leaf must have complete traversal, a reviewed disposition, phase evidence, and
an exact binding to the corpus inventory and reviewed overlay. A combat effect
that is approximated, omitted, unresolved, stale, or merely unreviewed blocks
decision-grade compilation. Effects explicitly reviewed as outside the
directional attack calculator remain recorded as such; they are not silently
treated as zero. The bridge also binds its legacy projection, corpus hashes,
scenario-v3 hash, and both local-input-v2 hashes so a replay cannot mix rules,
profiles, range, or physical state.

Every admitted bridge-v3 run publishes the corpus inventory, overlay,
conformance report, translation ledger, and a
`combat-corpus-admitted-<n>-<opponent>-parity-suite-manifest.json` artifact.
That manifest supplies the exact corpus identity and attacker/defender mechanics
used by the deterministic parity-suite builder.

The bridge's `semanticAuthority` distinguishes verified bundle semantics from
retained roster assertions. `bundle-manifest-verified` means the semantic
hashes were recomputed from and matched to the operation's leased immutable
bundle manifest. `roster-asserted` means a captured Dataset retained the two
rosters' semantic hashes without a manifest that could independently verify
them; that artifact remains replayable, but its coverage is forced provisional
and can never support a decision-grade claim.

Fresh decision-grade local runs freeze a physical scenario/policy contract v3.
It binds the actual player and opponent selections, attached formations,
battle round and timing, resources, unit state, activations, and every
attacker/target pair. Shooting pairs carry exact distance, visibility,
indirect-fire, in-range, Rapid Fire, Melta, and Conversion state. Execution
derives weapon eligibility from each profile's exact numeric range and rejects
a contradictory selected state. Attachments are pooled as one physical
attacker or target instead of being evaluated as unrelated datasheets.

All state, activation, and attachment dimensions must be selected before one
scalar result can support a roster conclusion. An envelope contract with an
unknown dimension remains useful diagnostic evidence, but only its
minimum/median/maximum range may be reported. Mechanically equivalent source
variants retain their provenance while sharing one `executionSha256`, so
aliases cannot overweight the median. Legacy v1/v2 contracts may be migrated
only when ownership and physical state can be resolved without guessing.

`auto` is deliberately conservative. A local provider that is missing,
unavailable, unpromoted, or fails preflight is not run; the request selects the
website and records the selection reason. If a future promoted local provider
fails preflight or execution, RosterPilot discards all local evidence and
returns a hash-bound Web-fallback offer. It does not start New Recruit or
Tessera Web until that exact frozen request is explicitly confirmed; an altered
request or stale confirmation is rejected. An explicit `local-engine` or
`website` request never crosses providers. This is separate from `--fallback
baseline-damage-v1`, which adds a supplemental deterministic analysis rather
than changing the simulation provider.

Website-fallback confirmation is available only for exact analysis. Copy the
offer's lowercase 64-character `requestSha256`, rerun the otherwise unchanged
`tessera analyze` command, and add
`--website-fallback-confirmation-sha256 <offer.requestSha256>`. The equivalent
durable surface is `tessera start-run --run-kind exact`; local MCP exposes the
same exact-only confirmation field. Stress and build commands reject the flag
because their request hashes have different scopes. Without an active personal
attestation, `auto` selects the website initially and does not exercise this
promoted-local failure path.

The local dependency is pinned to upstream
commit `16ab4365bbd97ef592b061c5a9babe5e44f00e80`, and its commit, tree,
archive digests, package metadata, and licence state are tracked in
[`local/tessera/tessera-engine-provenance.json`](local/tessera/tessera-engine-provenance.json).
For this single-user, single-machine path, a written-license record is not a
promotion gate. Automatic selection and local-engine-derived coaching remain
disabled until complete local-versus-Web parity evidence produces three
consecutive passing `observe` rotations followed by one passing `enforce`
rotation for the same machine, provider identity, data bundle, and bidirectional
covering suite. Explicit local runs may retain diagnostic matrices before that
point, but substantive findings and roster-change candidates stay suppressed.
Changing any bound identity invalidates the attestation and returns `auto` to
Tessera Web.

See [Personal local Tessera parity](docs/personal-local-tessera-parity.md) for
the evidence chain, rotation commands, and fail-closed boundaries.

Use `--opponent-file enemy.rosz` for an exported list or
`--opponent-roster enemy.json` for another canonical RosterPilot draft.
Without canonical opponent context, an uploaded `.rosz` must expose
game-system and faction catalogue revisions compatible with the operation's
frozen bundle plus complete
per-unit profiles. RosterPilot fingerprints its full rule-bearing selection
tree and verifies enrichment did not change it, while explicitly warning that
roster legality and the exact source commit cannot be proven from the archive
alone.
The bundle-native rules compiler is stricter: a local run of an uploaded
opponent requires its matching canonical roster context, because an archive
alone cannot prove the bundle rule, mapping, enhancement, attachment, and
selected-option identities. Missing context stops before New Recruit,
credential, or browser activity.
The exact command intentionally does not accept faction archetypes. A legacy
`tessera analyze --opponent-faction ...` request returns
`OPPONENT_SCOPE_REQUIRED`; use the faction stress route instead. RosterPilot
also returns no invented matchup when both the exact roster and faction scope
are unknown.

The default `full` analysis runs 16 raw Tessera scenarios per opponent: Shooting
and Fight, four metrics (wipe probability, half-wipe probability, mean kills,
and mean damage), and both attack directions. RosterPilot consolidates those
matrices by phase and direction, calculates mean damage per 100 attacker
points, and preserves the selected provider identity, iteration count, and
simulator settings.

#### Standard local + Web validation

The durable combined validation workflow has two depths. `standard` is the
default: it freezes a legal diverse-nine opponent portfolio, runs all nine
locally with every supported metric, then selects the frozen stress, central,
and contrast representatives from complete trusted local evidence. Only those
three opponents are prepared for New Recruit and run on Tessera Web. At 16 Web
captures per opponent, this reduces the normal website pass from 144 captures
to 48 without reducing the broad local sample.

`exhaustive` runs all nine opponents on Tessera Web and must be requested and
confirmed explicitly. Existing single-provider commands remain explicit and
keep their current behavior. Standard local and Web reports are presented
side-by-side as different provider evidence; they are not labeled strict
numerical parity. If the representative website pass is incomplete,
inconclusive, or materially crosses the local result bands, RosterPilot retains
the completed evidence and offers **Run remaining six**. It does not start
those runs automatically. A repaired successor Web job likewise requires a
fresh confirmation and leaves its predecessor unchanged.

Before either path can mutate New Recruit, one sealed batch preflight validates
the player and all nine opponents under the same bundle lease. It checks
legality, points, exact mappings, ROSZ round trips, model and loadout structure,
leader allocation, catalogue identity, complete profile choices, verified
cache hits, and mutation receipts. Cache and receipt checks are read-only and
concurrent. Missing profile choices return `needs-input` before a worker or
browser starts. Actual New Recruit misses remain serial; one uncertain outcome
stops the batch rather than trying another delivery path.

Local work uses up to three isolated child processes by default and a
hash-verified result cache bound to provider, bundle, both rosters, profile
policy, scenario contract, iterations, seed, compiler, and adapter identity.
Website controls remain serial so every matrix refresh can be proven. The
precompiled durable worker is built by `npm run build` and
`npm run plugin:local:install`; a worker/agent/MCP hash mismatch stops before
external activity.

For a faster smoke test, quick mode runs Shooting wipe probability in both
directions:

```bash
npm run rosterpilot -- tessera analyze \
  --file roster.json \
  --opponent-file enemy.rosz \
  --analysis-mode quick \
  --execution-mode simulate \
  --out-dir exports/tessera-quick
```

`--phases` and `--metrics` can select an explicit subset.
`--execution-mode simulate` opts into the selected simulation provider;
`--execution-mode prepare-only` returns verified handoff files with
`status: prepared`. The old `--experimental` flag remains a deprecated
compatibility alias for simulation.

For a deterministic replay, pass a canonical JSON scenario contract with
`--scenario-contract <file>`. Each entry fixes one phase, direction, metric,
complete simulator-settings object, and positive iteration count; the file
must exactly cover the requested phase/metric scope. The report and durable
job retain its SHA-256, and resume cannot change it. For the explicit local
engine, `--iterations <positive-int>` is a shortcut that generates the same
baseline settings for every selected scenario at the requested sampling
depth. It is local-engine-only. The two flags are mutually exclusive and
require `--execution-mode simulate`.

Website reports also retain provider-compatibility evidence. RosterPilot does
not assume that Tessera Web has a public semantic-data version: any declared
version is advisory, while the fetched bytes of same-origin scripts and the
normalized imported army/unit/weapon/effect snapshots are content-hashed.
Those hashes are bound to the accepted manifest, its provider mode and trust
origin, current update-provider identity, canonical
roster inputs, observed New Recruit catalogue identities, profile policy, and
scenario contract. Syntax-valid roster hashes without verified runtime bundle
trust remain incomplete. New Recruit observations prove handoff compatibility
only; they never replace the accepted snapshot as the rules source.

Provider compatibility defaults to `observe`: reports retain failures without
changing the legacy simulation-completeness decision. Use
`--enforce-provider-compatibility` only after the live rollout gate has
activated; it makes missing website deployment/import evidence fail closed.
`npm run certify:provider-compatibility` verifies retained canary artifacts and
switches the release gate after three consecutive complete rotations. The live
workflow then creates the durable repository tag
`rosterpilot-provider-compatibility-enforced-v1`. Later canaries and releases
read that tag, run with enforcement enabled, and block if current evidence or
retained history is unavailable; expiring Actions artifacts cannot silently
return the system to observation mode. A live runtime can apply the same latch
with `ROSTERPILOT_PROVIDER_COMPATIBILITY_ENFORCED=true`.

When comparing website and local results, an identity or normalized-input
difference is data/input or deployment drift and must be resolved before
numerical parity is evaluated. Model drift means the identities match but a
cell exceeds the uncertainty-aware tolerance or the canonical winner differs
outside its uncertainty boundary. Reports retain sample counts and available
variance/standard error so ordinary Monte Carlo noise is not confused with a
model disagreement.

Build and verify a bidirectional covering suite from an admitted-run manifest:

```bash
npm run rosterpilot -- tessera parity-suite build \
  --manifest combat-corpus-admitted-1-opponent-parity-suite-manifest.json \
  --out covering-suite.json

npm run rosterpilot -- tessera parity-suite verify \
  --suite covering-suite.json
```

Run both providers with the same exact case binding by adding
`--provider-parity-suite covering-suite.json --provider-parity-case <case-id>`
to each simulated `tessera analyze` command. Both flags are required together.
Even a website-selected parity run first acquires the immutable local bundle,
validates the selected physical scenario, compiles both local-input-v2 payloads,
admits the corpus, and compiles bridge v3. Failure stops before New Recruit or
Tessera Web activity and retains review artifacts.

Compare a completed local exact report with the corresponding completed
Tessera Web exact report using only evidence bound into those report bundles:

```bash
npm run rosterpilot -- tessera compare-providers \
  --local-report exports/tessera/local/army-matchup.json \
  --website-report exports/tessera/web/army-matchup.json \
  --out-dir exports/tessera/parity
```

Each input must have its adjacent `*.receipt.json`, exactly one opponent, a
complete provider-compatibility envelope, complete sample uncertainty, and
the provider-specific evidence needed to derive the same neutral combat
snapshot. Local evidence is rebuilt from hash-verified local-engine inputs
inside the report bundle. Web evidence is rebuilt only from the captured
deployment, selected-list state bindings, and visible import semantics; hidden
characteristics or effects are never filled from RosterPilot data. The command
writes canonical `tessera-provider-parity.json`, its detached
`tessera-provider-parity.json.sha256`, and a printable HTML comparison with
strengths, weaknesses, the largest cell differences, and next actions. The
canonical artifact does not embed machine-absolute paths. It identifies each
source by portable filename, run ID, report/receipt SHA-256, and receipt
evidence SHA-256; a downstream gate resolves the originals within an explicit
reports root and re-verifies their exact receipts before recomputing parity.

The personal path uses exact provider-parity v2 evidence inside both source
reports. It binds the same scenario-v3 contract, local-input-v2 profile/range
identities, combat-bridge-v3 exactness evidence, physical combat-state hashes,
and one deterministic bidirectional covering-suite case per comparison.
Tessera Web is the
comparison authority until this evidence is attested: visible Web deployment,
import, selected-list, profile, and range semantics must all be complete, and
RosterPilot never fills an opaque Web field from its local bundle.

The suite's `corpusInventorySha256` freezes the mechanic inventory used to plan
set cover. Each exact case separately retains `coverageWitnesses`: role
requirements need executable cells, and every mechanic requirement needs at
least one relevant leaf from that case's admitted bridge. The case-evidence
hash binds those witnesses to the case ID, bridge-v3 hash, and conformance
report, so a faction label or suite hash alone cannot claim coverage.

For a one-case suite, a passing comparison can directly write one private,
machine-bound rotation record:

```bash
npm run rosterpilot -- tessera compare-providers \
  --local-report exports/tessera/local/army-matchup.json \
  --website-report exports/tessera/web/army-matchup.json \
  --personal-rotation-id rotation-1 \
  --personal-rotation-mode observe \
  --personal-rotation-record exports/tessera/parity/rotation-1.json \
  --out-dir exports/tessera/parity
```

For a multi-case suite, create one passing `tessera-provider-parity.json` per
case, then aggregate exactly one comparison for every case:

```bash
npm run rosterpilot -- tessera personal-rotation aggregate \
  --covering-suite covering-suite.json \
  --comparison case-1/tessera-provider-parity.json \
  --comparison case-2/tessera-provider-parity.json \
  --rotation-id rotation-1 \
  --mode observe \
  --record exports/tessera/parity/rotation-1.json
```

Aggregation rejects missing, duplicate, or extra cases and requires one suite,
bundle, local provider identity, and Web provider identity. It hashes the
sorted per-case exact receipts and parity results into the rotation record. The
same aggregate command accepts a one-case suite, while the direct comparison
flags remain the shorter single-case path.

Repeat the complete suite against fresh exact report pairs for three
consecutive `observe` rotations and a fourth `enforce` rotation. Then create
the local attestation from exactly those four verified records:

```bash
npm run rosterpilot -- tessera personal-attestation create \
  --rotation exports/tessera/parity/rotation-1.json \
  --rotation exports/tessera/parity/rotation-2.json \
  --rotation exports/tessera/parity/rotation-3.json \
  --rotation exports/tessera/parity/rotation-4.json \
  --covering-suite covering-suite.json

npm run rosterpilot -- tessera personal-attestation status \
  --covering-suite covering-suite.json
```

Creation verifies the complete suite artifact against all four rotations and
retains an owner-only copy beside the private attestation; the hash alone is no
longer sufficient. Status re-verifies the supplied current suite and the
retained copy. The attestation is valid only for the same machine, provider
identity, bundle, and suite.

Every promoted local matchup also proves that its current exact bridge executes
only roles and mechanics declared by that retained suite. An undeclared current
mechanic fails local preflight with no scalar claim or automatic local run; add
the mechanic to a new suite and complete three new `observe` rotations plus one
new `enforce` rotation before promotion can resume. An offline local
verification or test run reads no Tessera credential and never launches New
Recruit or Tessera Web. A Web comparison is a separate, explicitly requested
operation; an automatic fallback is only an offer until its exact request hash
is confirmed.

Raw simulator settings remain in each source report. For parity, RosterPilot
maps only known gameplay settings (cover, charging, rapid-fire and melta range,
stationary state, and indirect fire) into one provider-neutral contract. It
strips the provider-only `provider` label, while an unknown setting name or
value fails with an actionable mapping error. This permits an observed Web
contract and the local engine's baseline contract to prove semantic equality
without falsely claiming their provider-specific settings objects are byte
identical.

To turn a portable paired comparison into strict certification evidence, keep
the comparison's `.sha256` plus both exact reports and adjacent receipts, then
run `npm run certify:provider-parity -- --comparison <comparison.json>
--reports-root <downloaded-report-root> --rotation-id <run-id>
--expected-bundle-id <bundle-id> --expected-git-head <commit>`. The gate relocates reports by hash,
run ID, and provider; independently recomputes parity; rejects fixture-only
evidence; and emits `pass`, `fail`, `incomplete`, `ineligible`, or
`unavailable` with its own detached checksum. See
[`docs/certification.md`](docs/certification.md#live-numerical-parity-gate) for
the required bundle layout. The distinct-faction Death Guard/Orks exact canary
produces the live local/Web pair. Its certificates remain observational until
three consecutive verified passes activate the separate
`rosterpilot-live-numerical-parity-enforced-v1` latch; once active, missing,
stale, or current non-pass evidence blocks release. An enforced application
release takes only the exact live-certification run ID: it verifies the source
workflow, default branch, successful conclusion, release commit, artifact
uniqueness and expiry, then derives the prepared bundle ID and reruns the gate
instead of trusting operator-supplied hashes. Both rollout checks require that
exact run as `--current-rotation-id`, preventing an older retained pass from
masking absent current evidence. A claimed passing certificate is rederived
from its exact comparison, reports, and receipts; its detached checksum alone
is never treated as proof that a live execution occurred.

This action intentionally compares two already completed reports rather than
launching both providers as one transaction. The Web half depends on signed-in
New Recruit/Tessera state and external mutations, while the local half uses
bundle-native immutable inputs; treating two independently failing executions
as atomic would leave ambiguous evidence. Run each exact matchup against the
same canonical rosters, profile policy, scope, and iteration count, then use
`compare-providers` as the fail-closed pairing step.

For an explicitly authorized live-deployment diagnostic, add
`--verified-catalogue-drift-diagnostic` to the Tessera command:

```bash
npm run rosterpilot -- tessera stress-test \
  --file roster.json \
  --against-faction aeldari \
  --execution-mode simulate \
  --verified-catalogue-drift-diagnostic
```

This is not a general drift override. It accepts only an observed newer
game-system revision while the game-system ID, exact faction-catalogue identity
and revision, all provenance fields, roster identity, and complete per-unit
Unit and weapon profiles still verify. The result keeps both identities and a
provisional warning; embedded characteristics remain live New Recruit evidence,
not frozen-rule verification. This flag applies only to Tessera workflows, not
`new-recruit deliver`.

#### Build against an exact known roster

Use `build-and-analyze` when the requested army should be constructed from the
actual opposing roster rather than a faction-wide heuristic:

```bash
npm run rosterpilot -- tessera build-and-analyze \
  --prompt "Build a durable 2,000 point Custodes counter-roster" \
  --player-faction adeptus-custodes \
  --opponent-roster enemy.json \
  --execution-mode simulate \
  --out-dir exports/custodes-vs-exact
```

The opponent must be a valid canonical RosterPilot roster. RosterPilot
fingerprints its full selection payload and derives a versioned aggregate
threat context from the selected model counts, points, unit tags, and
vehicle/monster keywords. Tessera remains responsible for the later
unit-to-unit combat math. Unless `--allow-readiness-warnings` is explicit, the
built roster must use at least 98% of its points and cannot have red overall
mission readiness. The workflow may return revision candidates, but it never
applies one automatically.

With no collection argument the result is labeled `open-catalog`: the faction's
full eligible build-supported catalogue remains available under the ordinary
named-character, Legends, and detachment constraints, including models the
player may not own. To constrain construction to owned models, pass a
quantity-aware collection profile:

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

```bash
npm run rosterpilot -- tessera build-and-analyze \
  --prompt "Build from my collection" \
  --player-faction adeptus-custodes \
  --opponent-roster enemy.json \
  --collection owned-collection.json \
  --execution-mode simulate
```

In `owned` mode, units absent from the profile are unavailable. `maxUnits`
limits selected unit instances and `maxModels` limits the total selected
models for that unit ID. Duplicate unit IDs and conflicting collection inputs
fail closed.

#### Durable background runs

Long exact, stress, build-and-stress, and build-and-analyze workflows can run
through a persistent local job document instead of holding one CLI or MCP call
open:

```bash
npm run rosterpilot -- tessera start-run \
  --run-kind exact \
  --file roster.json \
  --opponent-roster enemy.json \
  --execution-mode simulate \
  --out-dir exports/tessera/runs
```

Put `--verified-catalogue-drift-diagnostic` on `tessera start-run` when that
narrow diagnostic is explicitly authorized. The choice is frozen with the job
and cannot be added by `run-resume` or `--restart-from`. For MCP, set
`start_tessera_run.request.verifiedCatalogueDriftDiagnostic` to `true`. A fresh
diagnostic job can reuse a revalidated provisional artifact instead of
uploading the same list again.

The start command returns immediately with a generated
`run-<uuid>/tessera-run.json` job path. Use that exact path for later actions:

```bash
npm run rosterpilot -- tessera run-status \
  --job exports/tessera/runs/run-<uuid>/tessera-run.json \
  --full-json

npm run rosterpilot -- tessera run-resume \
  --job exports/tessera/runs/run-<uuid>/tessera-run.json

# After retry exhaustion or verified runtime drift, open a fresh stage:
npm run rosterpilot -- tessera run-resume \
  --job exports/tessera/runs/run-<uuid>/tessera-run.json \
  --restart-from \
  --out-dir exports/tessera/restarted-runs

npm run rosterpilot -- tessera resolve-profiles \
  --job exports/tessera/runs/run-<uuid>/tessera-run.json \
  --profile-policy profiles.json

npm run rosterpilot -- tessera run-cancel \
  --job exports/tessera/runs/run-<uuid>/tessera-run.json
```

Job status is one of `queued`, `running`, `needs-input`, `complete`,
`degraded`, `inconclusive`, `failed`, or `cancelled`. `run-status --full-json`
includes the retained result when one exists. A `needs-input` job accepts a
validated structured profile policy through `resolve-profiles`; resume then
uses that frozen policy. Stress manifest schema v8 freezes each stage's v2
scenario/policy contract and an aggregate SHA-256. A supplied legacy
manifest (v1-v7) is copied and verified before recovery; website and
prepare-only manifests may be migrated to v8, but a pre-v8 manifest
that requested a local-engine simulation is rejected because its missing v2
policy cannot be reconstructed without changing combat semantics. Start a new
stress run for that case. Completed predecessor jobs are never rewritten.
Exact and stress paired revisions are durable jobs as well. The outer
coordinator owns the first three automatic attempts; each stress stage advances
at most once per outer attempt, while attempts four and five require explicit
resume. The lifetime ceiling is five. After exhaustion, `--restart-from`
creates a new run and simulation stage from hash-verified frozen inputs without
carrying prior simulation evidence. Exact jobs freeze and reverify their
prepared player and opponent archives so retry and resume do not redeliver them; exact
simulation remains one analytical stage rather than the stress workflow's
per-opponent screening/deep-dive stages. Cancelling stops the local worker and
retains job state, artifacts, and New Recruit inventory; it never deletes
remote lists.

Each attempt freezes observable runtime provenance: macOS, Node,
Chrome/Playwright and broker versions, the required local-agent
protocol/version plus its actual status response and observed launchd process identity, the MCP source
build identity, and the frozen `bundleId` and source provenance with their
available generation/freshness timestamps. Unavailable observations remain `null`;
RosterPilot does not substitute guessed values.

The equivalent local MCP tools are `start_tessera_run`,
`get_tessera_run_status`, `resume_tessera_run`,
`resolve_tessera_profiles`, `restore_tessera_new_recruit_artifact`, and
`cancel_tessera_run`. Existing simulate-mode
matchup tools return an in-progress durable job reference instead of treating
a client timeout as workflow failure. MCP restart uses
`resume_tessera_run` with `restartFrom: true`.

For a fresh direct stress job, bind the reviewed preview instead of asking the
worker to regenerate it:

```bash
npm run rosterpilot -- tessera preview-portfolio \
  --against-faction aeldari \
  --points 2000 \
  --suite diverse-9 \
  --full-json > aeldari-2000-preview.json

npm run rosterpilot -- tessera start-run \
  --run-kind stress \
  --file roster.json \
  --against-faction aeldari \
  --suite diverse-9 \
  --portfolio-preview aeldari-2000-preview.json \
  --execution-mode simulate
```

The job validates, freezes, and hashes that exact preview before launch.
When no preview is supplied for a fresh stress job, the coordinator generates
one once and freezes it into the request. Resume always inherits the
manifest’s existing portfolio and rejects a competing preview.
Compatibility commands and tools remain available for short workflows. The
CLI reads profile choices from `--profile-policy`; the MCP profile-resolution
tool accepts the validated policy object directly.

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
  --execution-mode simulate \
  --out-dir exports/custodes-vs-aeldari
```

`preview-portfolio` is local-only and does not create New Recruit lists or open
Tessera. It shows the proposed proxy payload fingerprints, composition
evidence, represented and missing coverage cells, named-character status,
exportability, and profile-policy requirements before any external mutation.

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
  --execution-mode simulate \
  --out-dir exports/aeldari-stress
```

The default `diverse-9` suite attempts nine legal, exportable proxies:
balanced-control, ranged-pressure, and assault-pressure postures crossed with
the stable wire labels `mixed`, `mass`, and `elite-heavy`. Those composition
labels represent faction- and posture-relative threat lenses bound to the
portfolio methodology hash, not universal horde quotas. Selection ranks actual
roster model density, points per
model, Infantry and Vehicle/Monster share, selected-weapon ranged and melee
pressure, mobility, and largest-unit concentration. The frozen portfolio
records each faction/posture candidate range and its review status; horde-tag
share is context only and never a gate. Generated lens contracts remain
`generated-pending-review` until a human review is bound to the exact faction
and portfolio semantic hashes. Impossible cells are marked unavailable rather
than forcing a fictional horde. Only all nine requested cells can produce
`status: complete`. A
degraded portfolio is accepted only when every missing cell is recorded in the
faction's reviewed-not-applicable contract for those exact semantic hashes, at
least six
execution-distinct proxies remain, and all three postures are represented.
Any unreviewed gap stops before New Recruit with
`PORTFOLIO_CONTRACT_UNMET`. Detachment-only differences do not count as
distinct payloads, and named anchors are deliberately tested where legal.
Every survivor is weighted equally; this is a coverage sample, not an estimate
of what players are likely to bring.

`diverse-9` defaults to staged analysis. `core-3` defaults to `full-all`
because all three proxies are necessarily selected for complete evidence; one
full pass per proxy avoids repeating browser setup while preserving the same
required scenario set. Pass `--analysis staged` explicitly when testing that
recovery path.

The default `staged` strategy screens every available proxy with half-wipe
probability in Shooting and Fight, in both directions. It then chooses three
frozen representatives—stress, central, and contrast—and runs wipe
probability, mean kills, and mean damage on those representatives. `full-all`
runs all four metrics, both phases, and both directions for every available
proxy. On a complete `diverse-9` suite, staged analysis captures 72 raw
directional scenarios; `full-all` captures 144. Staged analysis does not select
or run deep dives until every required screening capture is complete and
integrity-clean, with at least six confident `diverse-9` proxies (all three for
`core-3`) spanning every posture before representative selection can begin.
A degraded `diverse-9` portfolio uses at least six reviewed,
execution-distinct proxies across all three postures. Final `complete` still
requires confident evidence for all nine cells. Representative selection is
frozen only after that stable screen, so a resumed incomplete screen cannot
invalidate work that started too early.

Before external activity, RosterPilot scans the player and frozen proxies for
multi-profile weapons. If any choice is unresolved, it returns
`TESSERA_PROFILE_POLICY_REQUIRED`, writes
`tessera-profile-policy.scaffold.json`, and stops before New Recruit or
Tessera. Complete each entry with the intended profile and active count, then
rerun with `--profile-policy`. The validated canonical policy hash is frozen
into the manifest and report; changing it invalidates resume and paired
revision. After New Recruit enrichment, the complete profile inventory is
verified again. If New Recruit exposes an additional decision, the run freezes
that inventory, writes an updated scaffold, stops before Tessera, and can
resume with the completed policy without creating the lists again.

After the local-agent metadata check, the first screening proxy is also the
live premium-unlock and matrix readiness probe. Infrastructure-wide failures
stop later proxies for that invocation instead of repeating the same broken
browser action across the portfolio.

`--execution-mode simulate` is required to run Tessera simulation.
`prepare-only` performs the selected provider's preparation and returns a
successful `prepared` report; the local route writes bundle-native JSON, while
the website route performs New Recruit enrichment. It never fabricates
simulation values.
A requested simulation with no trusted matrices returns `ok: false`, preserves
preparation data, and records structured failures. A first
uncached `diverse-9` run can create one player copy plus six to nine proxy
copies. Verified enriched artifacts are cached by execution fingerprint and
roster export compatibility identity, with their relevant semantic hashes,
content hash, and exact summary checked before reuse. Raw provenance movement
alone does not invalidate a compatible trusted entry. Revision-only provisional
artifacts live in a separate integrity-sealed store and are never returned by
the trusted-cache loader. Both the local agent and isolated worker reopen the
player and opponent archives before Tessera browser or licence-key activity;
every top-level unit must have embedded Unit and weapon profiles. Never use the
profileless source `.rosz` as a substitute. Staged deep dives reuse the same
verified copies. Remote list URLs are retained
in `~/Library/Application Support/RosterPilot/new-recruit-run-inventory.json`;
RosterPilot never deletes remote lists automatically. To clean them up, inspect
that inventory, open the recorded URLs in New Recruit, and delete only the
lists you separately authorize.

Each run writes a `stress-manifest.json` beside the JSON and interactive HTML
reports. Resume an interrupted run without repeating completed stages:

```bash
npm run rosterpilot -- tessera stress-test \
  --file roster.json \
  --against-faction necrons \
  --suite diverse-9 \
  --analysis staged \
  --execution-mode simulate \
  --resume \
  --out-dir exports/necrons-stress
```

Bare `--resume` reads `<out-dir>/stress-manifest.json`; pass
`--resume path/to/stress-manifest.json` to select it explicitly. Resume accepts
only the same player fingerprint, opponent faction, `bundleId`, semantic
roster identity, suite, analysis
strategy, requested and selected simulation backend, simulation setting,
profile-policy hash, exact frozen portfolio SHA-256, and schema-v8 per-stage v2
scenario/policy contracts and aggregate hash. Schema-v1 through schema-v7
manifests are verified before any migration. A legacy website or prepare-only
manifest may be rewritten as v8, but a pre-v8 manifest that requested and
selected `local-engine` simulation fails closed; start a new stress run so its
rules-aware v2 policy is frozen before execution. Completed predecessor jobs
are never rewritten.
Every stage records attempt count, first/last attempt time,
structured error code, retryability, and next action. Transient failures receive three automatic
attempts with bounded backoff and up to five lifetime attempts through explicit
resume; terminal failures require `--force-retry`. Completed child reports are
reused only after their hashes, roster identities, and requested scenario
cells validate. A mismatch fails closed rather than mixing runs. If delivery
began but its verified receipt was not persisted before a crash, resume stops
instead of risking a duplicate New Recruit list.

After the five-attempt lifetime budget is exhausted, start a new run from the
old manifest and use a different output directory:

```bash
npm run rosterpilot -- tessera stress-test \
  --file roster.json \
  --against-faction necrons \
  --suite diverse-9 \
  --analysis staged \
  --execution-mode simulate \
  --restart-from exports/necrons-stress/stress-manifest.json \
  --out-dir exports/necrons-stress-restart
```

`--resume` continues the same run ID, manifest, stage history, and lifetime
attempt budget. `--restart-from` creates a new run ID and fresh simulation
stages while carrying forward only frozen inputs and prepared New Recruit
artifacts whose file hashes and enriched summaries still verify. It requires a
new `--out-dir`, never rewrites the source run, and cannot be combined with
`--resume`. This is the recovery path after attempt exhaustion; `--force-retry`
does not bypass the five-attempt lifetime ceiling. The same mutually exclusive
recovery flags are available on `build-and-stress`; its rebuilt-and-repaired
player fingerprint must still match the source manifest.

Every captured Tessera table has a SHA-256 fingerprint over its headers,
dimensions, and values for provenance. After a phase, metric, or direction
change, RosterPilot requires the requested exclusive control state plus a
matrix-table replacement or matrix-subtree mutation, followed by three stable
reads. Numeric content is allowed to remain equal: two valid controls or two
distinct proxy payloads can legitimately produce the same result, especially
an all-zero matrix. A control change with no matrix refresh is rejected as
stale. Captured evidence is preserved for diagnosis, but missing fingerprints
or stale matrices make the analytical result `inconclusive` rather than
allowing plausible-looking probabilities through. Duplicate proxy payloads are
rejected separately during portfolio preflight.

Stress reports summarize directional offensive coverage, incoming threat
exposure, coverage margin, phase dependence, and unit answer breadth across the
frozen proxies. They do not report a whole-game win probability. Deterministic
mission readiness is shown separately and acts as a guardrail for roster-change
suggestions; it is never blended into the combat robustness score. Stress
report schema v3 distinguishes:

- `prepared`: verified New Recruit preparation completed and simulation was
  not requested;
- `failed`: requested simulation produced no trusted matrices;
- `inconclusive`: capture exists, but a required stage or analytical confidence
  is insufficient;
- `degraded`: the executable requested postures completed, but full frozen
  portfolio coverage was unavailable under reviewed exceptions bound to the
  exact faction and portfolio semantic hashes,
  with at least six unique proxies across all three postures;
- `complete`: every requested unique proxy and deep dive completed.

Missing estimates are `null`. Below-threshold observations remain separately
under `provisional` with their point coverage. Shareable JSON and HTML use
relative artifact references and can be moved as a bundle; only the local
manifest stores absolute paths. CLI progress goes to stderr and stdout is a
compact JSON summary by default. Use `--full-json` for the nested payload.

Player and opponent totals must differ by no more than 5% of the player's
points limit. Exact rosters outside that inclusive tolerance fail with
`TESSERA_POINTS_MISMATCH`; generated faction proxies outside it are omitted.
`--allow-point-mismatch` permits an intentionally mismatched directional run,
but the report is labeled `unmatched` and RosterPilot suppresses roster-change
candidates.

Schema-v3 exact reports use stable unit-instance labels and evidence-backed findings
for reliable coverage, enemy threats, coverage gaps, inefficient attacks,
overqualified trades, and phase role gaps. When the comparison is matched and
scenarios were captured, RosterPilot may propose up to three legal
single-operation changes: add a unit, resize a unit, or replace a unit. A
candidate is returned only when the resulting roster is legal, New
Recruit-exportable, uses at least 98% of its points, and is no worse across the
mission-readiness guardrails. Its evidence must identify the affected player
unit or a role gap. RosterPilot does not recommend replacing a unit that the
same evidence classifies as a reliable or portfolio-wide robust answer; it
returns no candidate rather than an underfilled or contradictory roster.
Candidates are fingerprinted suggestions only. RosterPilot never changes,
imports, or simulates a revised roster without explicit approval. Use
`--no-change-candidates` to omit them. Tessera import issues are tied to side,
unit, weapon group, available profiles, and phase. Only cells involving the
affected attacking unit are ambiguous and excluded from confident findings.

After approving and saving a revised canonical roster, rerun the baseline
opponents and settings and produce a before/after delta report:

```bash
npm run rosterpilot -- tessera compare-revision \
  --baseline-report exports/tessera/roster-matchup.json \
  --revised-roster revised-roster.json \
  --out-dir exports/tessera-revision
```

Revision comparison requires a schema-v3 baseline with captured scenarios and
a valid revised roster from the same faction. It always starts a durable
simulate-mode job and fails before delivery unless the baseline is complete
and simulation was explicitly enabled. It freezes and verifies the
opponent artifacts, source identities, points contract, profile policy,
scenarios, iterations, settings, selected backend, and provider identity, then
classifies each comparable cell as improved, worsened, unchanged, or
ambiguous. The roster-level conclusion is `improved` only when at least one
applicable trusted aggregate improves and none materially worsen; otherwise it
is `worsened`,
`mixed`, or `unchanged`. Materiality is five percentage points for wipe
probabilities, the greater of 0.5 model or 10% for mean kills, and the greater
of one wound or 10% for mean damage. Ambiguous aggregate coverage cannot vote
for an improvement.

For a faction stress-test baseline, use the paired stress revision command:

```bash
npm run rosterpilot -- tessera compare-stress-revision \
  --baseline-report exports/necrons-stress/roster-vs-necrons-stress-test.json \
  --revised-roster revised-roster.json \
  --out-dir exports/necrons-stress-revision
```

The revised roster must have the same player faction, points limit, frozen
`bundleId`, and relevant semantic roster identities. RosterPilot reuses the
baseline's exact enriched proxy rosters,
suite, analysis strategy, simulator settings, and representative selections;
it does not regenerate the portfolio or choose easier opponents. Missing
or changed baseline artifacts, execution-fingerprint mismatches, or
insufficient simulated coverage stop the comparison before a rerun. The
revised run actively reapplies the recorded Tessera settings and iteration
count before capture, then verifies them for every exact
phase/metric/direction scenario. Margin changes smaller than one percentage
point are treated as unchanged. The paired conclusion uses the
screening half-wipe robustness metric; deep-dive wipe, kill, and damage results
are supporting evidence. The conclusion is suppressed when the separate
mission-readiness guardrail fails.

The local MCP exposes `get_tessera_connection_status`,
`prepare_roster_for_tessera`, `analyze_roster_matchup`, and
`compare_roster_revision`, plus
`build_and_analyze_roster_matchup`,
`stress_test_roster_against_faction` and
`compare_stress_test_revision`,
`preview_faction_stress_portfolio`, and
`build_and_stress_roster_against_faction`. Durable background control is
available through `start_tessera_run`, `get_tessera_run_status`,
`resume_tessera_run`, `resolve_tessera_profiles`,
`restore_tessera_new_recruit_artifact`, and `cancel_tessera_run`. The restore
tool performs a hash-bound, local-only migration of a retained pre-recovery
Tessera artifact into the support-owned, content-addressed recovery store; it
cannot upload, create a list, or simulate. Hosted MCP,
REST, OpenAPI, and the website omit all of
them; there is no public stress-test UI. Each stress run
that selects `website` uses one isolated, session-scoped Tessera worker across
proxy requests. That
worker owns one live browser context and retains the premium key only in its
memory. Explicit session close or seven days of inactivity removes its
user-only browser profile. Local-agent shutdown closes the worker and browser
context but retains that `0700` run profile so a verified certification resume
can select the exact existing Tessera lists after restart. Transient browser,
session, and navigation failures reset the context without deleting the
profile before the next attempt.
The orchestrator never receives or returns the premium key. `tessera configure`
collects the key in a native secure dialog and stores it as a dedicated
login-Keychain item; only the isolated Tessera worker can retrieve it, and only
to fill Tessera's Licence key field on the exact `https://playtessera.gg`
origin. Use `tessera forget` to remove it.

If the selected provider is unavailable or fails after the enriched rosters
are prepared, including a website UI change, RosterPilot preserves those
verified handoff artifacts.
A requested simulation with no trusted matrices is `failed`; captured evidence
that cannot support analytical confidence is `inconclusive`. Missing cells are
never invented.
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

### Durable roster journeys

Local CLI and stdio MCP workflows can retain a hash-sealed journey instead of
ending at the first blocked optional action. Use `workflow start`, `status`,
`continue --policy safe-auto`, `choose`, and `doctor`, or the corresponding
`start_roster_workflow`, `get_roster_workflow_status`,
`continue_roster_workflow`, and `choose_roster_workflow_action` MCP tools.

When Tessera Web reports newer New Recruit catalogue revisions, the retained
journey has a guided recovery path instead of ending at the mismatch:

```bash
npm run rosterpilot -- workflow repair-web \
  --journey <journey-id> \
  --new-recruit-game-revision 8 \
  --new-recruit-catalogue-revision 7 \
  --predecessor-job <tessera-run.json>
```

The repair records the exact New Recruit game-system and faction-catalogue
identity, then selects the newest retained snapshot that matches it. If none
matches, RosterPilot searches a bounded BSData history and queues a local
compatibility build using the exact catalogue commit and the newest certified
40kdc rules source. The journey may report `updating-local-data`,
`waiting-for-compatible-source`, `needs-data-review`, or `ready-for-web`; the
roster, failed job, and mutation receipts remain safely retained throughout.
It does not start Tessera or create another New Recruit list. If selections
changed, use `workflow approve-data-migration` only after reviewing the exact
difference. When status becomes `ready-for-web`, use
`workflow start-repaired-web --confirm-external-preparation` as a separate
user-approved action. The successor records the failed job as its predecessor;
the frozen failed job is never rewritten.

This recovery is automatic for ordinary local users. They do not edit source
files, delete receipts, configure signing keys, or publish a RosterPilot data
bundle. Doctor reports a concrete action only when the machine is missing a
local prerequisite such as Node, npm, Git, writable application-support
storage, or upstream connectivity.

Analysis is distinct from optimization. Local-engine analysis compiles the
player and opponent portfolios directly from canonical bundle data and has no
New Recruit dependency. Website analysis performs its profile-rich New
Recruit preparation only after that provider is selected. If ROSZ preparation
is blocked, canonical JSON, text, and printable HTML remain available. A
blocked optional upload or simulation is reported as `action-required`, while
the dedicated mutation tools continue to fail closed.

Verify the reviewed local-engine dependency and the provider contracts with:

```bash
npm run tessera:engine:check
node --import tsx --test \
  tests/tessera-engine-provenance.test.ts \
  tests/tessera-local-engine-companion.test.ts \
  tests/tessera-local-engine.test.ts \
  tests/tessera-simulation-provider.test.ts \
  tests/tessera-provider-parity.test.ts \
  tests/tessera-provider-parity-report-adapter.test.ts \
  tests/tessera-provider-parity-scenario-contract.test.ts \
  tests/tessera-provider-parity-workflow.test.ts \
  tests/tessera-website-provider-parity-evidence.test.ts \
  tests/tessera-provider-compatibility.test.ts \
  tests/tessera-scenario-contract.test.ts \
  tests/tessera-stress-local-provider.test.ts
```

`npm run verify` also includes the provenance check after the normal lint and
test suite. To verify separately downloaded source bytes, add
`-- --archive /absolute/path/tessera-engine.tar.gz` to
`npm run tessera:engine:check`. These deterministic tests do not contact the
website. The parity tests validate completeness, provider-neutral combat and
model-capability identities, normalized-input and scenario-contract identity,
retained sampling uncertainty, metric-specific Monte Carlo tolerances, and
winner-classification behavior. The compatibility tests validate the outer
bundle/New Recruit/provider/import envelope. They do not themselves constitute
live promotion evidence.

Fixture-based Chrome tests are opt-in because they launch an actual isolated
browser process:

```bash
ROSTERPILOT_BROWSER_TESTS=1 \
  node --import tsx --test tests/new-recruit-companion.test.ts
```

Those tests use recorded local pages; they do not contact New Recruit or
Tessera and do not read Keychain credentials. For a credential-backed live
Tessera smoke test, first confirm the local agent and both providers report
`ready`, then supply an already verified profile-rich New Recruit archive. If
the archive contains alternate weapon profiles, also supply a matching
canonical v1 profile policy:

```bash
npm run rosterpilot -- agent status
npm run rosterpilot -- new-recruit status
npm run rosterpilot -- tessera status

ROSTERPILOT_TESSERA_LIVE_TESTS=1 \
ROSTERPILOT_TESSERA_PLAYER_ROSZ=exports/player-new-recruit-enriched.rosz \
ROSTERPILOT_TESSERA_PROFILE_POLICY_PATH=exports/profile-policy.json \
  node --import tsx --test --test-concurrency=1 tests/tessera-live.test.ts
```

The live test uses the Tessera credential only inside the local agent on the
exact Tessera origin, imports a renamed mirror of the supplied roster, and
requires all 16 full-mode scenarios. It does not contact New Recruit or create
a New Recruit list. The profile-policy variable may be omitted only when the
archive has no alternate-profile decisions. Full live certification remains
the test for New Recruit delivery plus Tessera simulation.

## Data and verification

Faction-wide roster, New Recruit, and Tessera certification is documented in
[`docs/certification.md`](docs/certification.md). The deterministic tier covers
all 35 factions without browser activity; recorded connector fixtures run on
macOS, while real New Recruit and Tessera mutations remain guarded and
scheduled separately. Live certification accepts an explicit
`--profile-policy <path>`, freezes its hashes and portable artifact, and
validates it against the exact enriched roster before Tessera starts. A resume
reuses only fingerprint- and hash-verified preparation evidence and never
redelivers a missing prior artifact.

`npm run certify:canary -- --canary <id> --expected-bundle-id <bundle-id>` runs
the bundle-bound source-backed live matchup rotation: Custodes versus
adaptive-nine Aeldari at 2,000 points with a
forced client-timeout/resume check, Death Guard versus an independently built
Orks exact roster, or an uploaded multi-profile exact matchup followed by a
paired revision. Release-evidence runs also require
`ROSTERPILOT_DATA_CHANNEL_URL`, explicit live authorization, and runner-local
policy/fixture files. Missing readiness returns a structured
`unavailable` report with `livePass: false`; deterministic and recorded browser
fixtures can never satisfy a live canary. See
[`docs/certification.md`](docs/certification.md#rotating-source-backed-live-canaries)
for the required variables and evidence contract.

`npm run certify:connector` executes the exact registered local browser tests
and embeds hash-verifiable execution evidence in its report. Skipped or
unexecuted Chrome fixtures fail certification; source text alone cannot satisfy
the connector gate.

Runtime rules use content-addressed global and faction data snapshots. Each
snapshot records exact Games Workshop, 40kdc-data, and `BSData/wh40k-11e`
provenance while separate semantic hashes decide whether a roster, export,
cache, or certification remains compatible. The checked-in
`data/sources.json` and generated catalogue overlay form the compiled startup
snapshot. Routine local refreshes build outside the checkout and rewrite none
of those tracked files. See [`docs/data-bundles.md`](docs/data-bundles.md).

Local installations accept a completed snapshot only with an unsigned local
build receipt that binds the manifest and every shard hash, exact upstream
commit or npm integrity, builder source hash, engine-data schema, validation
plan, certification evidence, and parent snapshot. RosterPilot re-verifies all
of that evidence whenever it loads the snapshot from disk. This establishes
reproducibility and corruption detection on a machine whose user trusts the
cloned code and allowlisted sources; it is not publisher authentication.

`npm run data:check` verifies the cross-faction build matrix, manifest
consistency, provisional point coverage, legal acceptance rosters, and both
Custodes and cross-faction `.rosz` export. `npm run data:check-latest` checks
all three live source classes without mutating the release.
`npm run data:sync-check` regenerates the compiled catalogue overlay in a
temporary checkout from its pinned BSData commit and fails if the application
release copy differs. Local updates likewise stage all fetching, generation,
and certification outside the checkout. They fetch only allowlisted npm and
BSData sources, disable npm lifecycle scripts, use a persistent bare Git
cache, and preserve the active snapshot on any failed or ambiguous candidate.
Games Workshop pages are checked for change detection only. A detected change
reports `official-update-pending` and retains the last usable official values;
it never claims that new official material was automatically interpreted or
reconciled.

The runtime update flow is intentionally separate from publishing:

1. `rosterpilot data update-status` distinguishes the snapshot in use, provider
   mode, trust, latest upstream and locally certified identities, background
   job progress, service-compatible snapshots, official reconciliation, and
   quarantined scopes.
2. `rosterpilot data refresh` queues an immediate durable local-source check
   and returns promptly. A successful candidate activates atomically for future
   operations.
3. `rosterpilot data start-local-update` and `data update-job --job <id>` are
   explicit local-only controls for scripts and troubleshooting. Ordinary
   compatibility repair invokes them automatically.
4. `rosterpilot rebase --file roster.json --out rebased.json` updates only
   compatible provenance. If relevant rules or mappings changed, it returns
   `review-required` with exact scopes and does not change selections.
5. `rosterpilot data rollback --bundle <bundle-id>` selects one exact retained
   verified snapshot for future work. Existing requests and durable jobs remain
   on their frozen snapshots.

Schema-v3 rosters record their exact `bundleId`, engine-data schema,
`rosterRulesHash`, `factionRulesHash`, selected `mappingHash`, and entity
hashes. They also freeze `sourceData.official.authority`; community-only or
legacy-unverified authority produces `OFFICIAL_AUTHORITY_UNAVAILABLE` on build
and validation instead of looking officially reconciled. Durable Tessera jobs
reacquire their archived bundle on resume rather than mixing evidence across
updates. If no local snapshot exists yet, or a network/update attempt fails,
builds continue from compiled release data. Status labels that fallback
`compiled-unverified` rather than pretending it is locally certified.

For New Recruit and Tessera Web, the globally newest snapshot is not blindly
forced onto the service. RosterPilot records the exact observed New Recruit
game-system and faction-catalogue IDs and revisions, selects the newest retained
matching snapshot per faction, and may search up to 500 relevant BSData history
commits to build a compatibility snapshot. If no exact historical source is
found, it preserves the roster and receipts and reports
`waiting-for-compatible-source`. It never probes compatibility by creating a
list, deletes a mutation receipt, or duplicates an uncertain import.

### Repair history and performance evidence

Local workflows keep a separate append-only reliability history under the
RosterPilot application-support directory. It links authoritative journey,
Tessera, data-update, and New Recruit receipt transitions to failures,
diagnoses, repairs, verification, cache or artifact reuse, successor runs, and
final evidence. Every event and journal head is hash-sealed. A journal failure
adds a warning but never reverses the authoritative operation; the reconciler
repairs missing head and registry projections from the specialized stores.
Interrupted authoritative jobs append `recovered-after-crash` only when they
can be requeued without replaying uncertain external activity.

Inspect one workflow from the CLI:

```bash
npm run rosterpilot -- reliability history \
  --workflow <workflow-id> \
  --kind tessera-run
npm run rosterpilot -- reliability summary \
  --workflow <workflow-id> \
  --kind tessera-run
```

The local MCP equivalents are `get_workflow_repair_history` and
`get_reliability_summary`. Tessera run status also reports its current phase,
completed and total work, elapsed time, and a timing-derived estimate when
enough evidence exists. Summaries keep execution success separate from
trusted-evidence success and expose recovery rate, recurrence, user actions,
cache reuse, duplicate-mutation evidence, receipt validity, and confidence.

Repair tests are selected from a fixed allowlist rather than accepting shell
commands. List and run them with:

```bash
npm run rosterpilot -- reliability plans
npm run rosterpilot -- reliability verify \
  --plan batch-preflight \
  --workflow <workflow-id> \
  --kind tessera-run
```

Available plans cover the reliability journal, batch preflight, workers/local
pool/cache, browser evidence, standard cross-provider orchestration, lint,
plugin parity, application build, and the complete suite. Each verification
record contains bounded-output hashes, test counts, timestamps, toolchain and
source fingerprints, changed-file hashes, and the dirty-diff hash—not raw
logs. `reliability associate-commit --record <verification.json>` associates a
later clean commit only when its file hashes match that verified repair.

The current non-gating performance targets for a heavy 2,000-point standard
workflow are approximately 6–7 minutes for local diverse-nine, under 10
minutes for the representative Web three, and roughly 15 minutes end to end.
Warm queue-to-running should remain below 15 seconds and cold startup below 30
seconds. These are measured from local timing spans rather than enforced as
brittle CI wall-clock assertions.

### Hosted deployment and release operators

The following signed-channel workflow is optional for local users. It remains
the authenticated distribution path for stateless hosted deployments,
maintainer release canaries, and promotion evidence. Local `local-source` mode
never falls back to it automatically.

Run `npm run data:prepare-update -- --help` to inspect the command without a
freshness check, dependency install, staged generation, signing, or
publication. Release signing uses
`ROSTERPILOT_DATA_SIGNING_KEY_ID` and
`ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK`; private material is never accepted as
a command-line argument. A changed official publication additionally requires
the overlay, the exact downloaded source artifact, and a content-addressed
inventory receipt signed by a reviewed extractor key. Without all three, or
when the key is absent from `data/official-extractor-trusted-keys.json`, the
candidate is quarantined. Once a verified binding exists, the signed global
shard retains its exact normalized official overlay and receipt-bound authority
hashes. BSData-only updates carry the effective snapshot without manual
evidence re-supply. If 40kdc changes while the Games Workshop version and
content hash remain unchanged, the publisher reapplies that exact retained
overlay to the new structured data, revalidates every reference and official
value, and recomputes conflicts. A Games Workshop source change—or a legacy
bundle without the retained overlay—still requires new reviewed evidence. The
former tracked-file publisher is retained as the explicit
`data:prepare-update:legacy-direct-sync` maintenance command.

Application releases use a separate fail-closed path:

```bash
npm run data:official-overlay -- template --out /secure/review/official-overlay.json
npm run data:official-overlay -- check \
  --file /secure/review/official-overlay.json \
  --source-artifact /secure/review/official-source \
  --receipt /secure/review/official-extraction-receipt.json
npm run data:bundle:prepare-release -- \
  --official-reconciliation-evidence /secure/review/official-overlay.json \
  --official-source-artifact /secure/review/official-source \
  --official-extraction-receipt /secure/review/official-extraction-receipt.json
npm run build:release
```

The template is deliberately non-publishable until an externally reviewed
extractor fills it and signs a one-to-one scope/entity receipt over the exact
source bytes and normalized overlay. This repository intentionally ships no
trusted extractor key: an application owner must review the extractor, add its
public Ed25519 key and review reference to the registry, and keep its private
key outside the release job. The first trusted bootstrap will fail until that
evidence exists. If an application must intentionally ship without official
reconciliation, the release command requires
`--official-authority-unavailable <reviewable-reason>` and signs that degraded
status instead of silently claiming authority. `build:release` verifies that
the trusted-key registry, local bootstrap, and same-origin hosted copy are
signed, complete, and identical before building. The manual `Application
release assets` workflow performs the same sequence with CI-held signing
material and preserves the verified assets for deployment.

For an offline or repeated local verification, set
`ROSTERPILOT_BSDATA_CHECKOUT` to an existing checkout at the exact pinned
commit. The same revision check runs before the local checkout is trusted.

Every data-consuming operation leases one immutable verified snapshot for
reproducibility. Update status, refresh, and rollback coordinate the provider without
claiming a roster-data lease.
Confirm event-specific rulings before play. Public deployments must display
the included “Powered by 40kdc-data” attribution.

Hosted signed-channel refresh must not be advertised until the deployment includes a signed
bootstrap bundle, a pinned Ed25519 public-key registry, a signed stable-channel
URL, and writable bundle storage. Publishers also require the CI-only signing
key ID/private JWK, immutable bundle hosting, and stable-pointer publication
permission. Local clones do not need any of these signing settings. Signing material never ships to clients. Data refresh, activation,
rebase, rollback, quarantine, and retention never create, replace, or delete a
New Recruit list.

Hosted deployments serve the immutable bootstrap manifest and shards under
`/data-bundles/bootstrap/` and the public verification registry at
`/data-bundles/trusted-keys.json` by default. Override those locations with
`ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_MANIFEST_URL` and
`ROSTERPILOT_DATA_TRUSTED_KEYS_URL`, or provide the public registry inline as
`ROSTERPILOT_DATA_TRUSTED_KEYS_JSON`. `ROSTERPILOT_DATA_CHANNEL_URL` is still
required. Missing or untrusted release assets leave compiled offline data
active; they never partially initialize runtime refresh.
