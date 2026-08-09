# Repository Guidelines

## Structure

RosterPilot exposes one deterministic application service through two adapters. Shared workflow, rules, validation, export, persistence, and side-effect policy belong in `lib/rosterpilot/`. The CLI lives in `cli/` and `bin/`; the three-tool MCP adapter lives in `mcp/`. Local data, New Recruit, and Tessera integrations live in `local/`. The macOS keychain broker is in `native/`.

Do not add a web application, REST transport, Cloudflare worker, transport-specific domain logic, optimizer, certification runner, or additional MCP tool. Read `docs/architecture.md` before changing boundaries.

## Data safety

Every data-consuming operation uses one immutable `DataBundleProvider` lease. Preserve raw Games Workshop, 40kdc, and BSData provenance separately from semantic roster, faction, mapping, and portfolio hashes. Refresh and rollback affect future leases only. Do not rewrite tracked generated data during routine refresh. See `docs/data-bundles.md`.

Authenticated New Recruit upload and Tessera Website stress runs require an explicit, revision-checked `act` confirmation. Never retry an uncertain external mutation automatically. The Tessera local-engine stress backend remains available without remote upload.

## Commands

- `npm ci` installs Node 22.13+ dependencies.
- `npm run typecheck` checks the retained product.
- `npm test` runs the focused Node test suite.
- `npm run verify` runs type checks, tests, data checks, and plugin parity.
- `npm run rosterpilot -- status` exercises the CLI.
- `npm run mcp` starts the stdio MCP server.
- `npm run data:sync` requests an on-demand data refresh.
- `npm run companion:build` rebuilds the macOS keychain broker.

## Style

Use strict TypeScript, ES modules, two-space indentation, double quotes, and trailing commas. Use `camelCase` for values/functions, `PascalCase` for types/components, and kebab-case for scripts and generated artifacts.

Keep normal MCP results under 4 KB, the complete tool catalogue under 16 KB, and the canonical skill under 600 words. Return `rosterpilot://` references for full rosters and artifacts.

## Tests

Tests use `node:test` and `node:assert/strict`. Keep no more than 18 high-value `*.test.ts` files. Cover success and fail-closed paths at the service boundary, immutable data snapshots, New Recruit mutation receipts, and both Tessera stress backends. Avoid duplicate transport-parity test matrices.

## Changes

Use concise imperative commits. Never commit credentials, browser profiles, `.env*`, scratch experiments, or incidental exports. Explain data-source, authentication, and non-idempotent delivery changes explicitly.
