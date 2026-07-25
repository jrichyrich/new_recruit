---
name: rosterpilot
description: Build, inspect, modify, validate, explain, and export Warhammer 40,000 army rosters through the RosterPilot MCP server. Use for faction or unit research, natural-language Adeptus Custodes roster requests, collection-constrained army planning, legality checks, and New Recruit .ros/.rosz/JSON handoffs.
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

## Validation rules

- Say a roster is legal only when `validate_roster.ok` is true and `violations` is empty.
- Treat `warnings` as visible caveats, not as hidden failures.
- If the tool returns `UNSUPPORTED_FACTION`, offer faction research or explain that deterministic building is currently Custodes-only.
- Preserve the roster’s `sourceData` version. Rebuild or revalidate when `DATA_VERSION_CHANGED` appears.
- Treat community data as a planning source; remind users to confirm event-specific rulings.

## Export safety

- Prefer `.rosz` for New Recruit file handoff and `html` for printing.
- Omit `outputPath` when the user only wants content returned to the chat.
- Supply `outputPath` only when the user asked to create a file.
- Do not set `overwrite: true` unless the user explicitly approved replacing that exact file.
- Do not automate New Recruit clicks, inspect credentials, or modify an existing New Recruit list as part of this workflow.

## Example requests

- “Build a 1,000-point fast Custodes army with no named characters.”
- “Compare Custodes and Space Marines, then show mobile Custodes units.”
- “Replace this unit with a more durable option and revalidate.”
- “Export the validated list as `.rosz` and printable HTML.”
