# RosterPilot

RosterPilot is a deterministic Warhammer 40,000 roster engine with four surfaces:

- a browser-based army builder;
- the `rosterpilot` terminal command;
- a local stdio MCP server for Codex, Claude Desktop, and other MCP clients;
- authenticated REST/OpenAPI and Streamable HTTP MCP endpoints for remote agents.

See [Architecture](docs/architecture.md) for system boundaries, delivery
workflow, authentication state, and credential flow diagrams.

Warhammer 40,000 11th Edition Adeptus Custodes is the first build-supported faction. Every embedded faction remains searchable. Points and legality come from pinned [`@alpaca-software/40kdc-data`](https://github.com/wn-mitch/40kdc-data), not from an LLM.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run rosterpilot -- status
npm run rosterpilot -- search custodes
npm run rosterpilot -- search praetors --faction adeptus-custodes
npm run rosterpilot -- build --prompt "Build a 1,000 point fast Custodes army with no named characters" --out roster.json
npm run rosterpilot -- validate --file roster.json
npm run rosterpilot -- export --file roster.json --format rosz --out roster.rosz
npm run mcp
npm run data:check
npm run data:check-latest
```

File writes stay within the current directory unless `--allow-outside-root` is supplied. Existing files are never replaced unless `--overwrite` is supplied.

## Local MCP setup

Use the absolute path to this checkout in client configuration.

Codex project `.codex/config.toml`:

```toml
[mcp_servers.rosterpilot]
command = "/opt/homebrew/bin/node"
args = ["--import", "/Users/jasricha/Documents/Github_Personal/new_recruit/node_modules/tsx/dist/loader.mjs", "/Users/jasricha/Documents/Github_Personal/new_recruit/mcp/stdio.ts"]
cwd = "/Users/jasricha/Documents/Github_Personal/new_recruit"
```

Claude Desktop configuration:

```json
{
  "mcpServers": {
    "rosterpilot": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "--import",
        "/Users/jasricha/Documents/Github_Personal/new_recruit/node_modules/tsx/dist/loader.mjs",
        "/Users/jasricha/Documents/Github_Personal/new_recruit/mcp/stdio.ts"
      ],
      "cwd": "/Users/jasricha/Documents/Github_Personal/new_recruit"
    }
  }
}
```

The server exposes:

`get_data_status`, `search_factions`, `compare_factions`, `search_units`, `build_roster`, `modify_roster`, `validate_roster`, `explain_roster`, `export_roster`, and `prepare_new_recruit_handoff`.

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

REST routes include faction/unit search and roster build, modify, validate,
explain, export, and New Recruit handoff. Remote exports are always returned
inline; remote agents cannot write server files.

## New Recruit handoff

Validate first, then export `.rosz` or `.ros` and import the file at [New Recruit](https://www.newrecruit.eu/app/MyLists). RosterPilot also exports New Recruit-shaped JSON, canonical roster JSON, text, and print-ready HTML.

`prepare_new_recruit_handoff` returns the editable `.rosz` and, by default, a
printable HTML companion in one validated response. Local stdio clients may
write both artifacts to a directory; remote clients receive inline content.

### Local automated delivery on macOS

The local stdio MCP and terminal CLI can optionally use a dedicated Chrome
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

`npm run data:check` verifies Custodes point coverage, a legal natural-language acceptance roster, and all interoperable export formats. `npm run data:check-latest` additionally checks the npm registry but does not update anything automatically.

Community data is pinned for reproducibility. Confirm event-specific rulings before play. Public deployments must display the included “Powered by 40kdc-data” attribution.
