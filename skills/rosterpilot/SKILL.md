---
name: rosterpilot
description: Build, inspect, modify, validate, explain, and export Warhammer 40,000 army rosters for any build-supported faction through the RosterPilot MCP server. Use for faction or unit research, natural-language roster requests, collection-constrained army planning, legality checks, printable HTML, and mapped New Recruit .ros/.rosz handoffs.
---

# RosterPilot

Use RosterPilot as the source of truth for roster data, points, and legality. Do not calculate points or infer that a list is legal from model knowledge.

## Workflow

1. Call `get_data_status` before substantial roster work. State the pinned data version when freshness matters.
2. Use `search_factions`, `compare_factions`, or `search_units` to answer research questions. Clearly distinguish browsable factions from build-supported factions.
3. Call `build_roster` with the user’s prompt and explicit constraints. Include point limit, named-character preference, Legends preference, collection ids, detachment, or disposition when provided.
4. Use `modify_roster` for changes. Never edit stored totals, ordinals, or legality fields by hand.
5. Call `validate_roster` after every build or modification.
6. Call `explain_roster` only after validation so the explanation includes current cautions.
7. Call `export_roster` only for a validated roster.
8. When the user asks for New Recruit delivery, call
   `prepare_new_recruit_handoff` after validation. Prefer its `.rosz` artifact
   for editing and its HTML artifact for local printing.
9. Call `deliver_roster_to_new_recruit` only when the user explicitly asks to
   upload, import, or send the roster to New Recruit. Use
   `get_new_recruit_connection_status` first. If local automation is
   unavailable, fall back to `prepare_new_recruit_handoff`.

## Validation rules

- Say a roster is legal only when `validate_roster.ok` is true and `violations` is empty.
- Treat `warnings` as visible caveats, not as hidden failures.
- If the tool returns `UNSUPPORTED_FACTION`, explain which priced-unit or
  matched-play-detachment coverage requirement is missing.
- Preserve the roster’s `sourceData` version. Rebuild or revalidate when `DATA_VERSION_CHANGED` appears.
- Treat community data as a planning source; remind users to confirm event-specific rulings.

## Export safety

- Prefer `html` for universal printing. Use `.rosz` for New Recruit only when
  the faction has a complete catalogue mapping; currently that mapping is
  available for Adeptus Custodes.
- Treat `NEW_RECRUIT_MAPPING_UNAVAILABLE` as a capability boundary, not a
  roster-legality failure. Offer printable HTML or roster JSON.
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

## Example requests

- “Build a 1,000-point fast Custodes army with no named characters.”
- “Build a fast 1,000-point Aeldari army that can capture objectives.”
- “Compare Custodes and Space Marines, then show mobile units.”
- “Replace this unit with a more durable option and revalidate.”
- “Export the validated list as `.rosz` and printable HTML.”
- “Prepare this roster for New Recruit and give me both files.”
- “Upload this validated roster to New Recruit and download Pretty HTML.”
