# RosterPilot

RosterPilot is a deterministic Warhammer 40,000 roster engine with four surfaces:

- a browser-based army builder;
- the `rosterpilot` terminal command;
- a local stdio MCP server for Codex, Claude Desktop, and other MCP clients;
- authenticated REST/OpenAPI and Streamable HTTP MCP endpoints for remote agents.

See [Architecture](docs/architecture.md) for system boundaries, delivery
workflow, authentication state, and credential flow diagrams.

All 35 embedded Warhammer 40,000 11th Edition faction entries are searchable
and buildable, including Space Marine chapter entries that inherit their parent
datasheet pool. Points and legality come from pinned
[`@alpaca-software/40kdc-data`](https://github.com/wn-mitch/40kdc-data), not
from an LLM.

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

Repeatable noninteractive examples:

```bash
npm run setup -- --profile core --non-interactive --refresh check
npm run setup -- --profile mcp --non-interactive --refresh skip
npm run setup -- --profile new-recruit --non-interactive --refresh skip
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

Build the native broker and configure the credential through its secure macOS
dialog:

```bash
npm run companion:build
npm run rosterpilot -- new-recruit configure
npm run rosterpilot -- new-recruit status
```

Then deliver a canonical RosterPilot JSON draft:

```bash
npm run rosterpilot -- new-recruit deliver \
  --file roster.json \
  --out-dir exports/new-recruit
```

Use `--no-pretty` to import without downloading HTML. Existing files are never
replaced unless `--overwrite` is supplied. Use
`npm run rosterpilot -- new-recruit forget` to delete the dedicated credential.

The local MCP additionally exposes `get_new_recruit_connection_status` and
`deliver_roster_to_new_recruit`. Delivery is non-idempotent and must only be
called after an explicit request to upload, import, or send the roster. V1
always creates a new New Recruit list and never replaces or deletes one.

The companion:

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
  downloading Pretty HTML.

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
