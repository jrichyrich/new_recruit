# Local ChatGPT/Codex personal plugin

This guide is the supported path for using the checkout as the
`rosterpilot@personal` plugin on the owner Mac. It configures the Codex desktop
plugin runtime; it does not install RosterPilot into hosted ChatGPT or expose
local New Recruit or Tessera credentials to a hosted service.

## Choose one Codex delivery path

RosterPilot supports two local Codex delivery paths. They must not register the
same `rosterpilot` MCP name in one checkout.

| Path | Use it for | Setup |
| --- | --- | --- |
| Personal plugin | ChatGPT/Codex skill plus the checkout-bound local MCP server | `npm run plugin:local:install` |
| Standalone MCP | Codex without the plugin, Claude Desktop, or another MCP client | `npm run setup -- --profile mcp` |

A project-local `[mcp_servers.rosterpilot]` entry takes precedence over the
plugin-owned server. The personal-plugin installer therefore refuses to run
while that entry exists in `.codex/config.toml`. Remove or rename only that
RosterPilot entry before switching paths; do not discard unrelated local
configuration.

## Prerequisites

- Run from a complete RosterPilot checkout with Node 22.13 or newer and locked
  dependencies installed.
- Make the `codex` command available to the installer.
- Bootstrap the operator-owned personal marketplace at
  `~/.agents/plugins/marketplace.json`. It must be named `personal` and contain
  a local `rosterpilot` entry whose source path is
  `./plugins/rosterpilot`. From that registry, the source resolves to
  `~/plugins/rosterpilot`.
- Ensure `.codex/config.toml` does not also contain
  `[mcp_servers.rosterpilot]`.

The installer verifies the marketplace mapping but never creates or edits the
registry. It also never edits or deletes Codex's immutable plugin cache.

## First installation

Start with the core profile so setup does not create the alternative
standalone MCP entry:

```bash
nvm use
npm run setup -- --profile core --refresh check
npm run plugin:local:install
```

If browser-backed New Recruit and Tessera workflows are needed, install the
smallest matching profile after the plugin is registered. Setup detects the
registered plugin and skips the project-local MCP entry that would shadow it:

```bash
npm run setup -- --profile tessera --refresh skip
npm run rosterpilot -- agent ensure-current
```

Use `--profile new-recruit` instead when Tessera is not required. Installing a
profile prepares the capability; it does not upload a roster or run a
simulation.

Verify the plugin and browser-backed capabilities separately:

```bash
npm run plugin:local:check
npm run doctor -- --profile tessera --refresh skip
npm run rosterpilot -- agent status
npm run rosterpilot -- new-recruit status
npm run rosterpilot -- tessera status
```

`plugin:local:check` verifies skill/package parity, marketplace source, cache,
plugin registration, checkout-bound MCP configuration, startup, and baseline
tool discovery. It does not prove Keychain credentials, browser readiness,
local-source update readiness, or local-agent freshness; Doctor and the provider
status commands cover those separate boundaries.

Open a new ChatGPT/Codex task after every successful plugin installation. An
existing task retains the skill instructions and MCP tool snapshot captured
when it began; restarting the app is the stronger refresh when a new task is
not sufficient.

## Ownership and generated state

| Layer | Owner and rule |
| --- | --- |
| `skills/rosterpilot/` | Repository-owned canonical workflow guidance |
| `plugins/rosterpilot/` | Repository-owned portable package; it contains no machine-specific MCP path |
| `~/.agents/plugins/marketplace.json` | Operator-owned registry; verified read-only by RosterPilot |
| `~/plugins/rosterpilot` | Installer-owned generated personal source with a unique build-metadata version and machine-local `.mcp.json` |
| `$CODEX_HOME/plugins/cache/personal/rosterpilot/<version>` | Codex-owned immutable cache created through `codex plugin add` |
| `$CODEX_HOME/skills/rosterpilot` | Marker-protected standalone skill synchronized in the publication transaction |
| Active ChatGPT/Codex task | App-owned skill and tool snapshot; refreshed only by a new task or app restart |
| Per-user RosterPilot LaunchAgent | Separate local-automation lifecycle managed by setup and `agent ensure-current` |

The generated `.mcp.json` contains absolute local paths, `local-source`
provider selection, and machine-local support configuration, so it is never
committed. It contains no signing key, trust registry, signed bootstrap, or
central RosterPilot data-channel requirement. Hosted/operator signed-channel
settings are a separate deployment concern and are not generated for the
personal plugin.

## Local data updates

The plugin uses the same local-first provider as the CLI and local agent. A new
task can work immediately from compiled data while the first certified local
snapshot builds in the background. Thereafter startup checks only when the last
attempt is more than 24 hours old; the macOS companion wakes hourly and queues
a check only when due. Updates are built outside the checkout and accepted as
`locally-verified` only after their receipt, manifest, shards, exact upstream
identities, builder hash, validation plan, and certification evidence pass.

Users normally do nothing. `get_data_update_status` (or
`npm run rosterpilot -- data update-status`) shows progress, and
`refresh_data_now` (or `data refresh`) queues a forced check without holding
the task open through compilation. Doctor checks Node, npm, Git, writable
application-support storage, and upstream connectivity. It never asks a local
user to create a signing key or bootstrap a central data channel.

If New Recruit or Tessera Web observes a different catalogue revision, the
durable repair journey selects a retained compatible snapshot or searches
bounded BSData history and queues a compatibility build. It preserves the
roster, failed job, and mutation receipts; semantic changes require approval,
and a successor Tessera Web job still requires separate confirmation.

## Updates and recovery

After pulling source changes, moving the checkout, or changing the Node
installation, republish and then refresh the local agent when browser-backed
tools are used:

```bash
npm run plugin:local:install
npm run rosterpilot -- agent ensure-current
npm run plugin:local:check
```

Publication validates all required paths and probes MCP startup before asking
Codex to register the new version. If publication fails, it restores the prior
personal source and managed skill and asks Codex to restore the previous
registration. If Codex cannot complete that rollback, the error names the
verified recovery copy retained on disk.

Do not repair drift by editing a cached plugin version. Run
`npm run plugin:local:install`; the command publishes a new immutable version
and verifies the resulting registration. A nonzero `plugin:local:check` result
lists the stale layer and leaves machine state unchanged.
