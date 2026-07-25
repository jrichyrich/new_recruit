# RosterPilot

RosterPilot is a deterministic Warhammer 40,000 roster engine with four surfaces:

- a browser-based army builder;
- the `rosterpilot` terminal command;
- a local stdio MCP server for Codex, Claude Desktop, and other MCP clients;
- authenticated REST/OpenAPI and Streamable HTTP MCP endpoints for remote agents.

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

`get_data_status`, `search_factions`, `compare_factions`, `search_units`, `build_roster`, `modify_roster`, `validate_roster`, `explain_roster`, and `export_roster`.

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

REST routes include faction/unit search and roster build, modify, validate, explain, and export. Remote exports are always returned inline; remote agents cannot write server files.

## New Recruit handoff

Validate first, then export `.rosz` or `.ros` and import the file at [New Recruit](https://www.newrecruit.eu/app/MyLists). RosterPilot also exports New Recruit-shaped JSON, canonical roster JSON, text, and print-ready HTML.

ROS/ROSZ exports use versioned BSData catalogue references for configuration,
units, models, and wargear. If a selected item has no catalogue mapping,
RosterPilot rejects the export instead of emitting a file that New Recruit
would import as an empty roster.

The website stores versioned draft history in browser `localStorage`. It does not inspect New Recruit credentials, automate browser mutations, or use a cloud roster database.

## Data and verification

`npm run data:check` verifies Custodes point coverage, a legal natural-language acceptance roster, and all interoperable export formats. `npm run data:check-latest` additionally checks the npm registry but does not update anything automatically.

Community data is pinned for reproducibility. Confirm event-specific rulings before play. Public deployments must display the included “Powered by 40kdc-data” attribution.
