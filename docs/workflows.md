# RosterPilot workflow guide

RosterPilot has three independent user workflows. A validated roster is a
complete result: exporting it, sending it to New Recruit, or comparing it in
Tessera happens only when that specific action is requested.

## Choose a workflow

| Goal | Setup profile | Platforms | External side effect |
| --- | --- | --- | --- |
| Build, edit, validate, print, or save a roster | `core` | macOS, Linux, Windows | None |
| Use RosterPilot through a local MCP client | `mcp` | macOS, Linux, Windows | None |
| Export `.rosz` for manual New Recruit import | `core` | macOS, Linux, Windows | None until the player imports it |
| Upload and verify a new New Recruit list | `new-recruit` | macOS | Creates a new list only after an explicit delivery command |
| Compare armies and collect Tessera simulations | `tessera` | macOS | Creates verified New Recruit list copies during profile enrichment, then runs Tessera only with `--experimental` |

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

`new-recruit` includes `core` and `mcp`. `tessera` includes those capabilities
plus New Recruit enrichment because Tessera needs profile-rich `.rosz` files.
Installing a profile does not run a delivery or simulation.

Check the current machine without changing it:

```bash
npm run doctor -- --profile core --refresh skip
npm run rosterpilot -- workflows
```

If the repository or Node installation moves, rerun the selected setup profile.
The local-agent status rejects an agent installed from another checkout instead
of silently using stale worker code.

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
  --enriched \
  --out-dir exports/new-recruit
```

Delivery creates a new list, verifies its name, faction, points, and units, and
optionally downloads Pretty HTML and an enriched `.rosz`. It never replaces or
deletes an existing list.

## Workflow 3: Tessera comparison

Tessera accepts one canonical player roster and exactly one opponent source:

- `--opponent-roster enemy.json` for another RosterPilot roster;
- `--opponent-file enemy.rosz` for an existing exported list;
- `--opponent-faction necrons` for deterministic faction proxies.

Run a quick directional smoke comparison:

```bash
npm run rosterpilot -- tessera analyze \
  --file aeldari.json \
  --opponent-roster enemy.json \
  --analysis-mode quick \
  --experimental \
  --out-dir exports/tessera-quick
```

Use the default `full` mode for both phases, all four metrics, and both attack
directions. The output directory contains preserved handoff files, a
machine-readable report, and an interactive HTML report.

Tessera preparation uses New Recruit to obtain verified profile-rich archives,
so it creates new list copies as part of this explicitly requested workflow.
Without `--experimental`, RosterPilot stops after the verified handoff and
returns a labeled partial report. A comparison never edits the source roster;
change candidates remain suggestions until a revised roster is explicitly
saved and compared.

## Safe recovery

- Invalid rosters stop before any browser opens.
- Missing mappings still allow canonical JSON, text, and printable HTML.
- Missing local automation still preserves the source `.rosz`.
- Tessera UI changes preserve verified handoff files and mark missing results
  as partial.
- Output files are not overwritten unless `--overwrite` is supplied.
- Writes outside the current directory require `--allow-outside-root`.
