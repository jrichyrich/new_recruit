# Architecture

RosterPilot has one application boundary: `RosterPilotService` in `lib/rosterpilot/service.ts`. The CLI and MCP server are adapters. They must not implement roster rules, validation, data loading, export logic, or side-effect policy.

```text
CLI ─┐
     ├─ RosterPilotService ─ deterministic roster engine
MCP ─┘                    ├ immutable DataBundleProvider lease
                          ├ persisted operations/rosters/artifacts
                          ├ New Recruit adapter
                          └ Tessera local or Website stress adapter
```

## Contracts

The public workflow uses three verbs:

- `run` creates an operation.
- `inspect` reads compact state or a reference.
- `act` applies one revision-checked action.

Operations are durable V1 documents. Roster payloads are stored in a V4 envelope and exposed as `rosterpilot://rosters/{id}`. Large output is stored once as a content-addressed artifact and exposed through `rosterpilot://artifacts/{id}`. Normal results contain summaries and references, not duplicate content.

The service uses optimistic revisions. An `act` call with a stale revision fails closed. Authenticated New Recruit upload and Tessera Website stress execution require `confirm=true`. An uncertain external mutation is never retried automatically.

## Boundaries

Shared domain behavior belongs in `lib/rosterpilot/`. Local integrations belong in `local/`. `mcp/` and `cli/` only translate inputs and results.

Tessera stress supports two explicit backends. `local-engine` runs without remote mutation. `website` stages an action, then uses the authenticated local companion after confirmation. Optimizers, parity certification, Web UI hosting, REST routes, and Cloudflare delivery are outside the product boundary.

Data-consuming work acquires one immutable provider snapshot. A refresh can replace the snapshot used by future operations but cannot change an operation already in flight. Durable state retains its exact bundle identity.

## Token budget

The MCP catalogue must remain under 16 KB and expose exactly `run`, `inspect`, and `act`. Routine results must remain under 4 KB. The skill teaches sequencing and references; it does not restate tool schemas or domain rules.
