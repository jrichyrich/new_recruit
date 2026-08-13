---
name: rosterpilot
description: Build, inspect, modify, validate, export, upload, and stress-test Warhammer 40,000 rosters through RosterPilot's compact three-tool MCP interface.
---

# RosterPilot

Use RosterPilot as the authority for roster data, points, legality, exports, and Tessera results. Never calculate points or declare legality from model memory.

## Tools

- `run` starts work: `research`, `build`, `modify`, `export`, `matchup`, `stress`, or `sync`.
- `inspect` reads data status, New Recruit status, operations, rosters, or artifacts by reference.
- `act` performs one explicit next action using the operation ID and current revision.

Pass `rosterpilot://` references between calls. Do not copy full roster or artifact documents into later tool inputs. Read a resource only when its full content is needed.

## Workflow

1. Use `run research` when faction or unit identity is unclear.
2. Use `run build` with the player's faction, point limit, collection, and preferences. Treat an opponent named in prose as opponent context, not the player's faction.
3. Use the returned `rosterRef` for modifications, matchup analysis, stress tests, and exports. RosterPilot validates after every build or change.
4. Use `run export` only with a validated roster. Prefer ROSZ for New Recruit editing; use HTML for printing.
5. New Recruit upload is a side effect. Select the returned `new-recruit.upload` action with `act`, the exact operation revision, and `confirm=true` only after the user explicitly asks to upload.
6. For deterministic exact-roster composition analysis, call `run matchup` with player and opponent roster refs.
7. For Tessera stress testing, call `run stress` with `options.opponentFaction`, `suite` (`core-3` or `diverse-9`), `strategy` (`staged` or `full-all`), and:
   - `backend="local-engine"` to execute locally.
   - `backend="website"` to stage authenticated Web upload. Then call `act` with `tessera.stress.run` and `confirm=true` after explicit user approval.
   - For an exact local matchup, pass `selectedPlayerAbilityIds` to apply named bundle-native optional abilities, or `activationMode="envelope"` to inspect every discovered optional activation. Do not combine them.
   Catalogue drift defaults to `reject`. Use `options.catalogueDriftMode="diagnostic"` only when the user explicitly requests a provisional diagnostic; `force` is not supported.
8. After exact Tessera stress completes, present its `matchup-html` artifact for heat maps and probabilities. Prefer this durable report over constructing a one-off visualization; it preserves phase, direction, points tolerance, uncertainty, provenance, warnings, and limitations.
9. Use `run sync` only when the user asks to refresh data now. A refresh affects future leases, never the snapshot already held by an operation.

If an operation is `action-required`, present its concise choices. If it fails, report its violation codes and do not invent a workaround. Never retry an uncertain external mutation automatically.
