import { exportRoster, validateRoster } from "./engine";
import type {
  ExportArtifact,
  NewRecruitHandoff,
  ResultEnvelope,
  RosterDraftV1,
} from "./types";

export const NEW_RECRUIT_IMPORT_URL =
  "https://www.newrecruit.eu/app/MyLists" as const;

export function prepareNewRecruitHandoff(
  draft: RosterDraftV1,
  includeHtml = true,
): ResultEnvelope<NewRecruitHandoff> {
  const validation = validateRoster(draft);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }

  const formats = includeHtml ? (["rosz", "html"] as const) : (["rosz"] as const);
  const artifacts: ExportArtifact[] = [];
  for (const format of formats) {
    const exported = exportRoster(draft, format);
    if (!exported.ok || !exported.data) {
      return {
        ok: false,
        data: null,
        violations: exported.violations,
        warnings: exported.warnings,
      };
    }
    artifacts.push(exported.data);
  }

  return {
    ok: true,
    data: {
      rosterId: draft.id,
      rosterName: draft.name,
      totalPoints: draft.totalPoints,
      pointsLimit: draft.pointsLimit,
      importUrl: NEW_RECRUIT_IMPORT_URL,
      artifacts,
      instructions: [
        "Download the .rosz artifact.",
        "Open New Recruit My Lists and choose Import List.",
        "Select the .rosz file; New Recruit will create a new list copy.",
        "Use New Recruit Export > Pretty when its full profile-and-rules HTML is required.",
      ],
    },
    violations: [],
    warnings: validation.warnings,
  };
}
