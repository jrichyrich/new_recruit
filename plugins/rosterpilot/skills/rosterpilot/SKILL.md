---
name: rosterpilot
description: Build, inspect, modify, validate, explain, export, and optionally compare Warhammer 40,000 army rosters through the RosterPilot MCP server. Use for faction or unit research, natural-language roster requests, collection-constrained army planning, legality checks, printable HTML, mapped New Recruit .ros/.rosz handoffs, and explicitly requested local Tessera matchups.
---

# RosterPilot

Use RosterPilot as the source of truth for roster data, points, and legality. Do not calculate points or infer that a list is legal from model knowledge.

## Workflow

1. Call `get_data_status` and `get_data_update_status` before substantial
   roster work. Report the bundle currently in use separately from the latest
   verified bundle, latest upstream candidate, any quarantined scopes, the
   `dataTrust` state, and persistent-versus-memory durability.
   `check_data_freshness` is an optional live-source diagnostic; use it when
   the user asks whether Games Workshop, 40kdc-data, or BSData has moved. A
   live-source result never changes the bundle leased by an operation.
2. When the user explicitly asks to apply the newest verified data immediately,
   call `refresh_data_now`. A successful activation affects only future
   requests; the current operation and durable jobs retain their immutable
   bundle snapshots. If the update provider is unavailable, continue from the
   application release's compiled data and report that signed updates are not
   configured. Call it a verified signed bootstrap only when status confirms
   that its manifest, shards, and public key were verified.
3. Before modifying, validating, exporting, or simulating a stored V1/V2/V3
   roster, call `rebase_roster`. Use the returned roster for `current` or
   `compatible-rebased`. For `review-required`, show the exact changed units,
   equipment, detachments, mappings, or other scopes and do not change
   selections automatically. Call `rollback_data_bundle` only for an explicit
   operator request to restore an exact archived bundle; rollback also affects
   only future requests.
4. Use `search_factions`, `compare_factions`, or `search_units` to answer research questions. Clearly distinguish browsable factions from build-supported factions.
5. Prefer `run_roster_workflow` for a natural-language request that composes
   build, validation, coaching, an export-safe handoff, explicit New Recruit
   delivery, or approval-gated optimization. It resolves the player and
   opponent under one immutable bundle lease and never treats a capability
   question as delivery authority. Use the lower-level tools when the user is
   inspecting or operating on an existing roster or asks for only one step.
   Faction resolution is fail-closed: canonical names, IDs, and reviewed
   aliases may resolve, but fuzzy or voice-like suggestions require user
   confirmation and must never fall back to Custodes or another faction.
   Call `build_roster` with the user’s prompt and explicit constraints when a
   standalone build is appropriate. Include
   point limit, named-character preference, collection ids, detachment, or
   disposition when provided. For Legends, prefer `legendsPolicy` plus a
   structured `playContext`; keep `allowLegends` only for compatibility.
   Questions such as “are Legends allowed?” do not opt a roster in. Casual,
   narrative, and open-play context may allow verified, build-supported
   Legends. A named event requires an explicit `allowed` ruling with
   identifiable `event-pack` or `organizer-ruling` evidence; otherwise exclude
   Legends even if the user requested `allow`. Never override a sourced event
   denial.
   Treat plain analysis, Tessera, math-hammer, paired-test, and stress-test
   language as `analyze`. Enter `optimize` only when the user explicitly asks
   to improve, revise, change, or optimize the roster. Keep opponent style
   assumptions separate from player preferences.
   For work that may need recovery across turns, use the local durable journey
   tools: `start_roster_workflow`, `get_roster_workflow_status`,
   `continue_roster_workflow`, and `choose_roster_workflow_action`.
6. Use `modify_roster` for changes. Never edit stored totals, ordinals, or legality fields by hand.
7. Call `validate_roster` after every build or modification.
8. Call `explain_roster` only after validation so the explanation includes current cautions.
9. Call `export_roster` only for a validated roster.
10. Before `.ros/.rosz` export, call `get_new_recruit_capability` for the
   roster faction. Use `list_data_conflicts` when the capability is partial or
   the build reports `DATA_SOURCE_CONFLICT`.
11. When the user asks for New Recruit delivery, call
   `prepare_new_recruit_handoff` after validation. Prefer its `.rosz` artifact
   for editing and its HTML artifact for local printing.
12. Call `deliver_roster_to_new_recruit` only when the user explicitly asks to
   upload, import, or send the roster to New Recruit. Use
   `get_new_recruit_connection_status` first. If local automation is
   unavailable, fall back to `prepare_new_recruit_handoff`. Direct delivery
   always verifies a profile-rich enriched archive and its observed
   game-system/faction-catalogue identity against the roster's frozen bundle.
   Treat catalogue drift or missing identity as a scoped delivery failure;
   report that the remote outcome was inventoried and do not retry by creating
   another list.
13. Treat Tessera as a separate, optional workflow. Call
    `get_tessera_connection_status` first, then route the opponent explicitly:
    - Known faction, unknown list: call
      `preview_faction_stress_portfolio`, resolve any structured profile
      requirements, then start `stress` with `start_tessera_run`, passing the
      returned full preview `data` object as `request.portfolioPreview`. The durable job
      freezes and hashes that exact preview; do not regenerate or summarize
      it before starting.
    - Known canonical roster or `.rosz`: resolve its exact provenance and
      profile requirements, then start `exact` with `start_tessera_run`.
    - Build against a known canonical roster: use
      `build_and_analyze_roster_matchup`, which scores against that roster
      rather than the faction catalogue.
    A standalone exact or known-faction Tessera request still requires that
    opponent scope and reports `OPPONENT_SCOPE_REQUIRED` rather than guessing.
    An explicit `run_roster_workflow` optimize request with no opponent may
    instead use its frozen six-archetype general portfolio at 1,000 or 2,000
    points; other limits require a named faction or exact roster.
    Set `verifiedCatalogueDriftDiagnostic: true` only when the user explicitly
    asks to test through a verified forward game-system-revision mismatch.
    Never infer this permission. Require the same game-system ID, exact
    faction-catalogue identity and revision, complete provenance, and complete
    per-unit model and weapon profiles. Preserve the diagnostic warning and
    both identities; do not describe the artifact as trusted or its
    characteristic values as frozen-rule verified.
14. Prefer durable simulation jobs over waiting synchronously. After
    `start_tessera_run`, poll `get_tessera_run_status`. For `needs-input`, show
    the structured choices, call `resolve_tessera_profiles`, and then
    `resume_tessera_run`. Resume with the manifest’s frozen suite, strategy,
    `bundleId`, immutable data snapshot, artifacts, and policy; do not invent
    omitted overrides. Use `restartFrom: true` only after retry exhaustion or
    verified runtime drift; it opens a fresh simulation stage and may copy only
    hash-verified frozen inputs, never prior simulation evidence. Use
    `cancel_tessera_run` only when the user asks to stop the run. Cancellation
    retains the run bundle and never deletes New Recruit lists.
    If a pre-recovery job instead stops with
    `NEW_RECRUIT_MUTATION_ALREADY_CREATED`, do not deliver again. When the exact
    originating `tessera-run.json` and unchanged roster are available, use
    `restore_tessera_new_recruit_artifact` to verify and migrate the retained
    hash-bound ROSZ pair locally, surface its warnings, and then resume only if
    the user still wants the run continued. This repair never opens New Recruit
    or Tessera and never starts a simulation.
    Put the diagnostic choice on the initial `start_tessera_run` request. Never
    add it during resume or restart. If an earlier default job stopped on
    qualifying drift, start a new diagnostic job so it can reuse the
    provisional artifact without another New Recruit mutation.
15. For an explicit local-engine-versus-Tessera-Web parity request, use one
    paired exact workflow rather than comparing unrelated result files:
    - Start the website exact durable run first with the validated canonical
      player and opponent rosters, an explicit `simulationBackend="website"`,
      and one frozen profile policy. Wait for a terminal result and require a
      complete report, exact-report receipt, signed-bundle compatibility
      envelope, website deployment asset digest, imported-semantics digest,
      and complete scenario-state bindings.
    - Read that report's observed `scenarioContract`, call
      `rebind_tessera_scenario_contract_provider` with source `website` and
      target `local-engine`, then start a separate exact durable run with the
      same canonical rosters and profile policy, explicit
      `simulationBackend="local-engine"`, and the rebound contract. This
      preserves the gameplay settings and iteration counts while changing
      only reviewed provider metadata.
    - After both jobs complete, call `compare_tessera_providers` with their
      exact report paths. Report its canonical classification, per-metric
      uncertainty, canonical winner, provider-specific strengths and
      weaknesses, and JSON/HTML/checksum paths. A parity pass requires at
      least 98% agreement for every required metric and zero cells beyond the
      2x tolerance; missing, stale, mismatched, or unverified evidence is
      ineligible or incomplete, never a numerical pass.
    Never compare stress aggregates, screenshots, manually copied numbers, or
    old reports lacking their receipts, frozen contracts, compatibility
    envelopes, and uncertainty. Resolve data/input drift before interpreting
    model drift. The daily live canary observes three distinct passing
    rotations before the separate numerical-parity enforcement latch may be
    enabled; a release must re-certify the exact retained run rather than
    trusting a branch-local summary.
16. Explain that Tessera preparation may create verified New Recruit list
    copies to obtain profile-rich `.rosz` files. Never describe a client or
    Codex timeout as a failed workflow; return the run ID and current durable
    status.
17. Do not apply a Tessera change candidate automatically. Guided optimization
    requires two approvals: first the candidate batch (at most three), then the
    exact paired-test winner or the unchanged baseline. Recheck the frozen
    baseline, bundle, portfolio, profile-policy, heuristic, and runtime hashes
    at every transition; drift invalidates the approval. `recommend-only`
    findings are unpaired and cannot authorize a revision. After explicit
    approval, modify and validate a new canonical roster, then call
    `compare_roster_revision` or `compare_stress_test_revision` against the
    exact frozen baseline only when the user asks for the before/after run.
    On the local MCP, use `start_tessera_optimizer`,
    `approve_tessera_optimizer_candidates`, the returned paired revision
    requests, `record_tessera_optimizer_comparison`, and then either
    `approve_tessera_optimizer_winner` or
    `retain_tessera_optimizer_baseline`. Finalization records delivery intent
    but does not deliver. Call
    `deliver_tessera_optimizer_winner_to_new_recruit` only after a finalized
    `deliver-new-recruit` intent and a new explicit `confirmDelivery=true`.
    For a general six-archetype run, use the separate
    `start_tessera_general_optimizer` lifecycle after all six exact baselines
    complete. It requires the frozen portfolio, canonical player roster, and
    exactly one report per archetype. Approve at most three candidates with
    `approve_tessera_general_optimizer_candidates`; run all six returned
    request-SHA-bound revisions per candidate; record each with
    `record_tessera_general_optimizer_comparison`; then separately approve the
    aggregate no-regression Pareto winner or retain the baseline. Finalize and
    call `deliver_tessera_general_optimizer_winner_to_new_recruit` only with
    the same finalized intent and fresh `confirmDelivery=true` gate. Never
    substitute six independent single-baseline optimizer conclusions for the
    aggregate coordinator.
    All paired comparison requests return durable job references; follow them with the
    same status, profile-resolution, resume, and restart flow above.

## Validation rules

- Say a roster is legal only when `validate_roster.ok` is true and `violations` is empty.
- Treat `warnings` as visible caveats, not as hidden failures.
- If the tool returns `UNSUPPORTED_FACTION`, explain which priced-unit or
  matched-play-detachment coverage requirement is missing.
- Preserve the roster’s complete schema-v3 `sourceData`: exact `bundleId`,
  source provenance, engine-data schema, `rosterRulesHash`,
  `factionRulesHash`, selected `mappingHash`, and entity hashes. Do not replace
  those fields with a release label or Git commit.
- Treat `DATA_PROVENANCE_CHANGED` as compatible when `rebase_roster` returns
  `compatible-rebased`. Treat `DATA_SEMANTICS_CHANGED` and
  `ROSTER_DATA_REVIEW_REQUIRED` as review gates; report the returned changed
  scopes and never silently update roster selections. Older data-version
  warning codes are deprecated compatibility aliases.
- Do not hide `DATA_SOURCE_CONFLICT`, `PROVISIONAL_POINTS`,
  `OFFICIAL_UPDATE_PENDING`, `OFFICIAL_AUTHORITY_UNAVAILABLE`, or
  `DATA_FRESHNESS_UNKNOWN` warnings.
- Games Workshop publications override community values when they are
  machine-verifiable. 40kdc-data supplies structured units, weapons, stats,
  and community-authored mechanics. BSData supplies New Recruit catalogue
  identities, selection paths, constraints, and export structure. Unresolved
  official/community conflicts fail closed at the affected scope; remind users
  to confirm event-specific rulings.
- Treat the verified signed RosterPilot bundle and its separate semantic
  roster, faction, mapping, and portfolio hashes as the canonical rules/data
  snapshot. New Recruit's observed game-system and faction-catalogue IDs and
  revisions prove which catalogue produced an enriched `.rosz`; they are
  compatibility evidence, not a second canonical points source. Tessera Web's
  captured same-origin script-asset digest, imported-semantics digest, and
  scenario-state bindings identify the deployed simulator behavior when the
  site exposes no trustworthy semantic release identifier. Do not force these
  independent systems into one global release string. A mismatch is a real
  scoped compatibility issue, but it should block only the affected handoff or
  parity comparison until the identities are reconciled or an explicit
  diagnostic run is authorized.
- Treat Games Workshop faction packs as the Legends-classification authority.
  The points manual and BSData labels do not prove membership. Check the
  `get_data_status.legends` coverage and authority counts, and use
  `search_units(includeLegends=true)` when the user wants the inventory.
  Clearly label `legendBuildSupported=false` results as inventory-only; do not
  build them or synthesize missing profiles. Surface
  `LEGENDS_CLASSIFICATION_UNVERIFIED`, `LEGENDS_POLICY_UNKNOWN`,
  `LEGENDS_BUILD_SUPPORT_UNAVAILABLE`, and `LEGENDS_INCLUDED` without hiding
  them.
- When collection quantities are omitted, label counter-build advice
  `open-catalog`. Use `collectionProfile.mode="owned"` with per-unit
  `maxUnits` and `maxModels` when quantities are known; do not imply that
  unowned or Forge World models are practical recommendations.

## Export safety

- Prefer `html` for universal printing. Use `.rosz` only when the selected
  configuration, units, models, and wargear are all mapped and conflict-free.
  Capability is evaluated per roster; do not infer it from the faction name.
- Treat `NEW_RECRUIT_MAPPING_UNAVAILABLE` as a capability boundary, not a
  roster-legality failure. Offer printable HTML or roster JSON.
- A blocked optional delivery or simulation is `action-required`; it does not
  invalidate a legal retained roster. Prefer `continue_roster_workflow` with
  `safe-auto` for typed read-only/local recovery, or provide the exact action
  requiring approval.
- Explicit local-engine exact, known-faction, and general-threat analysis uses
  canonical bundle-native rosters and must not invoke New Recruit. Website
  preparation evaluates ROSZ compatibility only after provider selection.
- Inspect an uncertain New Recruit outcome with
  `inspect_new_recruit_mutation`. Never retry `pending`, `uncertain`,
  `created`, or `reused` outcomes.
- Treat `NEW_RECRUIT_LEGENDS_CONFIGURATION_UNAVAILABLE` as a scoped ROS/ROSZ
  failure: the selected roster is still valid, but New Recruit's exact Legends
  visibility branch is not mapped for that frozen catalogue. Offer text,
  printable HTML, or canonical JSON and do not guess the selection path.
- Treat `NEW_RECRUIT_DATA_CONFLICT` as a fail-closed export result. Report the
  named conflicts and offer printable HTML or canonical roster JSON.
- Omit `outputPath` when the user only wants content returned to the chat.
- Supply `outputPath` only when the user asked to create a file.
- Do not set `overwrite: true` unless the user explicitly approved replacing that exact file.
- Default to file handoff; importing into New Recruit is not required for a
  successful export.
- Browser-assisted import is allowed only when the user explicitly asks to
  upload or import the roster and browser control is available.
- Treat `TESSERA_INPUT_NOT_PROFILE_RICH` and
  `TESSERA_INPUT_PROFILES_INCOMPLETE` as terminal handoff failures. Never
  manually substitute the source `.rosz` for the enriched archive.
- Credential configuration and removal are manual terminal operations. Never
  ask the user to place a password in chat or an MCP argument.
- The macOS companion may request Keychain authorization when its dedicated
  browser session has expired. A cancelled prompt cancels delivery.
- For browser assistance, open New Recruit My Lists, import the generated
  `.rosz`, verify the roster name, faction, points, and units, and optionally
  use Export > Pretty > Save as HTML.
- Never inspect credentials, cookies, browser storage, or access tokens. Never
  call New Recruit's private RPC endpoints.
- Never include a login page in diagnostics or screenshots.
- Imports must create a new list copy. Do not replace, delete, or mutate an
  existing New Recruit list without a separate explicit request.
- A completed build or export must not trigger New Recruit delivery or Tessera
  analysis. Each external action requires its own explicit request.
- Data status, refresh, rebase, rollback, activation, and garbage collection
  are local data operations. They must never create, replace, or delete a New
  Recruit list.
- Tessera results are directional combat math, not game win probability.
  Preserve partial scenarios and visible warnings; never infer missing cells.

## Example requests

- “Build a 1,000-point fast Custodes army with no named characters.”
- “Build a fast 1,000-point Aeldari army that can capture objectives.”
- “Compare Custodes and Space Marines, then show mobile units.”
- “Replace this unit with a more durable option and revalidate.”
- “Export the validated list as `.rosz` and printable HTML.”
- “Prepare this roster for New Recruit and give me both files.”
- “Upload this validated roster to New Recruit and download Pretty HTML.”
- “Compare these two validated armies in Tessera and return the HTML report.”
- “Run the same exact matchup in Tessera Web and the local engine, then produce
  a receipt-bound provider-parity report.”
- “Stress-test this list against nine frozen Aeldari proxies and let me resume
  it if the client disconnects.”
- “Build a Custodes roster against this exact Aeldari roster, respecting my
  owned-model quantities, then start a durable Tessera run.”
- “Build a 1,000-point Custodes army, coach me on its competitive roles, test
  it against the six general threat archetypes, and show me candidate changes
  for approval.”
