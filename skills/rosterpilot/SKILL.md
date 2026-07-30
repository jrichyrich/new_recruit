---
name: rosterpilot
description: Build, inspect, modify, validate, explain, export, and optionally compare Warhammer 40,000 army rosters through the RosterPilot MCP server. Use for faction or unit research, natural-language roster requests, collection-constrained army planning, legality checks, printable HTML, mapped New Recruit .ros/.rosz handoffs, and explicitly requested local Tessera matchups.
---

# RosterPilot

Use RosterPilot as the source of truth for roster data, points, and legality. Do not calculate points or infer that a list is legal from model knowledge.

## Workflow

1. Call `get_data_status` before substantial roster work. Call
   `check_data_freshness` when the user asks whether data is current; every
   `build_roster` response already includes the cached freshness warning state.
   State the pinned release ID and live-check result separately.
2. Use `search_factions`, `compare_factions`, or `search_units` to answer research questions. Clearly distinguish browsable factions from build-supported factions.
3. Call `build_roster` with the user’s prompt and explicit constraints. Include point limit, named-character preference, Legends preference, collection ids, detachment, or disposition when provided.
4. Use `modify_roster` for changes. Never edit stored totals, ordinals, or legality fields by hand.
5. Call `validate_roster` after every build or modification.
6. Call `explain_roster` only after validation so the explanation includes current cautions.
7. Call `export_roster` only for a validated roster.
8. Before `.ros/.rosz` export, call `get_new_recruit_capability` for the
   roster faction. Use `list_data_conflicts` when the capability is partial or
   the build reports `DATA_SOURCE_CONFLICT`.
9. When the user asks for New Recruit delivery, call
   `prepare_new_recruit_handoff` after validation. Prefer its `.rosz` artifact
   for editing and its HTML artifact for local printing.
10. Call `deliver_roster_to_new_recruit` only when the user explicitly asks to
   upload, import, or send the roster to New Recruit. Use
   `get_new_recruit_connection_status` first. If local automation is
   unavailable, fall back to `prepare_new_recruit_handoff`.
11. Treat Tessera as a separate, optional workflow. Call
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
12. Prefer durable simulation jobs over waiting synchronously. After
    `start_tessera_run`, poll `get_tessera_run_status`. For `needs-input`, show
    the structured choices, call `resolve_tessera_profiles`, and then
    `resume_tessera_run`. Resume with the manifest’s frozen suite, strategy,
    data pin, artifacts, and policy; do not invent omitted overrides. Use
    `restartFrom: true` only after retry exhaustion or verified runtime drift;
    it opens a fresh simulation stage and may copy only hash-verified frozen
    inputs, never prior simulation evidence. Use
    `cancel_tessera_run` only when the user asks to stop the run. Cancellation
    retains the run bundle and never deletes New Recruit lists.
13. Explain that Tessera preparation may create verified New Recruit list
    copies to obtain profile-rich `.rosz` files. Never describe a client or
    Codex timeout as a failed workflow; return the run ID and current durable
    status.
14. Do not apply a Tessera change candidate automatically. After explicit
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
- Preserve the roster’s complete `sourceData` provenance. Rebuild or
  revalidate when `DATA_VERSION_CHANGED`, `DATA_RELEASE_CHANGED`, or
  `CATALOGUE_VERSION_CHANGED` appears.
- Distinguish `DATA_UPDATE_AVAILABLE` from a build failure: the current roster
  is reproducible from its pin, but a newer release awaits review.
- Do not hide `DATA_SOURCE_CONFLICT`, `PROVISIONAL_POINTS`,
  `OFFICIAL_UPDATE_PENDING`, or `DATA_FRESHNESS_UNKNOWN` warnings.
- Treat community data as a planning source; remind users to confirm event-specific rulings.
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
