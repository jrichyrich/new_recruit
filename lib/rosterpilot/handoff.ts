import { exportRoster, validateRoster } from "./engine";
import type {
  ExportArtifact,
  NewRecruitHandoff,
  ResultEnvelope,
  RosterDraftV1,
} from "./types";

export const NEW_RECRUIT_IMPORT_URL =
  "https://www.newrecruit.eu/app/MyLists" as const;

export async function prepareNewRecruitHandoff(
  draft: RosterDraftV1,
  includeHtml = true,
  dependencies: {
    exportRoster?: typeof exportRoster;
  } = {},
): Promise<ResultEnvelope<NewRecruitHandoff>> {
  const validation = validateRoster(draft);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }

  const formats = includeHtml
    ? (["rosz", "roster-json", "text", "html"] as const)
    : (["rosz"] as const);
  const artifacts: ExportArtifact[] = [];
  const violations = [];
  const warnings = [...validation.warnings];
  for (const format of formats) {
    const exported = await (dependencies.exportRoster ?? exportRoster)(
      draft,
      format,
    );
    if (!exported.ok || !exported.data) {
      violations.push(...exported.violations);
      warnings.push(...exported.warnings);
      continue;
    }
    artifacts.push(exported.data);
  }

  if (artifacts.length === 0) {
    return {
      ok: false,
      data: null,
      violations,
      warnings,
    };
  }

  const hasRosz = artifacts.some((artifact) => artifact.format === "rosz");

  return {
    ok: violations.length === 0,
    data: {
      rosterId: draft.id,
      rosterName: draft.name,
      totalPoints: draft.totalPoints,
      pointsLimit: draft.pointsLimit,
      importUrl: NEW_RECRUIT_IMPORT_URL,
      artifacts,
      instructions: hasRosz
        ? [
            "Download the .rosz artifact.",
            "Open New Recruit My Lists and choose Import List.",
            "Select the .rosz file; New Recruit will create a new list copy.",
            "Use New Recruit Export > Pretty when its full profile-and-rules HTML is required.",
          ]
        : [
            "New Recruit import is unavailable for this roster snapshot.",
            "Use the canonical JSON, text, or printable HTML artifact while preserving the roster for later retry.",
          ],
    },
    violations,
    warnings,
  };
}
