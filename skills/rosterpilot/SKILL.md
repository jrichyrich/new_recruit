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
5. Call `build_roster` with the user’s prompt and explicit constraints. Include point limit, named-character preference, Legends preference, collection ids, detachment, or disposition when provided.
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
    A missing faction and missing exact roster is not enough scope; report
    `OPPONENT_SCOPE_REQUIRED` instead of choosing a faction.
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
    Put the diagnostic choice on the initial `start_tessera_run` request. Never
    add it during resume or restart. If an earlier default job stopped on
    qualifying drift, start a new diagnostic job so it can reuse the
    provisional artifact without another New Recruit mutation.
15. Explain that Tessera preparation may create verified New Recruit list
    copies to obtain profile-rich `.rosz` files. Never describe a client or
    Codex timeout as a failed workflow; return the run ID and current durable
    status.
16. Do not apply a Tessera change candidate automatically. After explicit
    approval, modify and validate a new canonical roster, then call
    `compare_roster_revision` or `compare_stress_test_revision` against the
    exact frozen baseline only when the user asks for the before/after run.
    Both comparison tools return durable job references; follow them with the
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
- “Stress-test this list against nine frozen Aeldari proxies and let me resume
  it if the client disconnects.”
- “Build a Custodes roster against this exact Aeldari roster, respecting my
  owned-model quantities, then start a durable Tessera run.”
