# RosterPilot

RosterPilot is a local-first Warhammer 40,000 roster engine with two interfaces: a command-line tool and a compact MCP server. Both call the same deterministic application service, use the same immutable data snapshot per operation, and persist references instead of returning large documents inline.

## What remains

- Faction and unit research
- Deterministic build and modify workflows that automatically rebase stored inputs when required, validate every result, and return compact explanations
- ROS, ROSZ, JSON, text, and printable HTML artifacts
- New Recruit export and handoff artifacts
- Exact-roster local matchup assessment
- Tessera stress testing with the local engine
- Daily/on-demand Games Workshop, 40kdc, and BSData refresh support

The retired hosted web application, REST surface, Cloudflare worker, optimizers, certification runners, parity rollout tools, and durable Tessera job variants are intentionally absent.

## Install and run

Requirements: Node.js 22.13 or newer. New Keychain credential release and
browser sign-in are temporarily unavailable because the broker fails closed
until an authenticated native consumer exists. A previously authenticated New
Recruit browser profile may remain active, so revoke that session separately
if a full browser shutdown is required.

```sh
npm ci
npm run rosterpilot -- status
npm run mcp
```

Build a roster:

```sh
npm run rosterpilot -- build "1,000 point Adeptus Custodes roster" \
  --faction adeptus-custodes --points 1000 --pretty
```

The result contains a `rosterpilot://rosters/...` reference. Reuse that reference:

```sh
npm run rosterpilot -- export --roster <roster-ref> --format rosz
npm run rosterpilot -- matchup --roster <player-ref> --opponent <opponent-ref>
```

Run Tessera locally:

```sh
npm run rosterpilot -- stress --roster <roster-ref> \
  --opponent-faction world-eaters --backend local-engine \
  --suite core-3 --strategy staged
```

The retained Website adapter still enforces revision-checked confirmation and
catalogue-drift policy, but its credential gate currently reports `disabled`.
Use `--backend local-engine`; it requires no remote upload or reusable secret.

## MCP contract

RosterPilot exposes exactly three tools:

- `run`: research, build, modify, export, matchup, stress, or sync
- `inspect`: read compact status or a stored reference
- `act`: confirm one typed external action

Full rosters and artifacts are MCP resources. The tool catalogue is budgeted below 16 KB, and routine tool results below 4 KB.

## Data and state

Each operation leases one immutable `DataBundleProvider` snapshot. Refreshes affect only future leases. Stored rosters use the local V4 envelope while accepting legacy V1–V3 imports at the boundary. Operations, rosters, and content-addressed artifacts live under `ROSTERPILOT_SUPPORT_DIRECTORY` or the macOS Application Support directory.

See [architecture](docs/architecture.md) and [data bundles](docs/data-bundles.md).

## Development

```sh
npm run typecheck
npm run wiring:check
npm test
npm run tessera:engine:check
npm run verify
npm run data:check
npm run companion:build
```

The focused suite is limited to high-value service/MCP contracts, engine behavior, data snapshots and refresh, New Recruit mutation safety, and both Tessera execution foundations. `npm run verify` also checks every TypeScript script, repository wiring, the pinned Tessera engine provenance, and the 18-file test cap.
