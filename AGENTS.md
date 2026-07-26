# Repository Guidelines

## Project Structure & Module Organization

RosterPilot exposes one deterministic roster engine through several interfaces. Keep shared rules, validation, and export logic in `lib/rosterpilot/`; do not duplicate it in a transport. The Next.js UI and HTTP routes live in `app/`, MCP implementations in `mcp/`, terminal behavior in `cli/` and `bin/`, and the Cloudflare entry point in `worker/`. Local-only New Recruit automation is under `local/new-recruit/`, with its macOS keychain broker in `native/`. Tests and fixtures are in `tests/`; operational utilities belong in `scripts/`. See `docs/architecture.md` before changing trust boundaries or delivery behavior.

## Build, Test, and Development Commands

- `npm install` installs the pinned Node dependencies (Node 22.13+).
- `npm run dev` starts the local Vinext development server.
- `npm run build` produces the deployable application build.
- `npm test` runs TypeScript tests, builds the app, then validates rendered HTML.
- `npm run lint` applies the Next.js ESLint configuration.
- `npm run data:check` verifies faction builds and export coverage.
- `npm run rosterpilot -- status` exercises the CLI; `npm run mcp` starts the stdio MCP server.

Run `npm run companion:build` only when changing the macOS automation companion. Browser-backed companion tests are opt-in; use the command documented in `README.md`.

## Coding Style & Naming Conventions

Use TypeScript with strict types, ES modules, two-space indentation, double quotes, and trailing commas where supported. Follow existing naming: `camelCase` for values/functions, `PascalCase` for components and types, and kebab-case for scripts or generated artifact names. Prefer small transport adapters over business logic outside `lib/rosterpilot/`. Run `npm run lint` before submitting changes.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Name files `*.test.ts`; reserve `*.test.mjs` for JavaScript build-output checks. Add focused regression tests near the affected surface and reusable data under `tests/fixtures/`. Deterministic roster changes should assert legality, points, and stable selections. There is no numeric coverage threshold, but new behavior must cover success and fail-closed paths.

## Commit & Pull Request Guidelines

Use concise, imperative commit subjects consistent with history, such as `Fix New Recruit roster exports`. Keep commits scoped and avoid checking in credentials, browser profiles, `.env*`, or incidental exports. Pull requests should explain behavior and architecture impact, list verification commands, link relevant issues, and include screenshots for UI changes. Call out data-source, authentication, or non-idempotent delivery changes explicitly.
