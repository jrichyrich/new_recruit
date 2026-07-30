import { units } from "@alpaca-software/40kdc-data";

import {
  analyzeMissionReadiness,
  assessMissionReadinessRevisionGuardrail,
  exportRoster,
  modifyRoster,
  rosterHasNamedCharacter,
  validateRoster,
  type ModifyRosterOperation,
  type RosterDraftV1,
  type TesseraMissionReadinessBand,
  type TesseraMissionReadinessReport,
} from "../../lib/rosterpilot";

export const MINIMUM_CHANGE_CANDIDATE_UTILIZATION = 0.98;

function sameIds(
  left: string[] | null | undefined,
  right: string[] | null | undefined,
): boolean {
  const leftIds = [...new Set(left ?? [])].sort();
  const rightIds = [...new Set(right ?? [])].sort();
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
  );
}

export function preservesRosterHardConstraints(
  baseline: RosterDraftV1,
  revised: RosterDraftV1,
): boolean {
  const before = baseline.constraints;
  const after = revised.constraints;
  if (
    before.allowNamedCharacters !== after.allowNamedCharacters ||
    before.allowLegends !== after.allowLegends ||
    before.requiredWarlordUnitId !== after.requiredWarlordUnitId ||
    before.opponentFactionId !== after.opponentFactionId ||
    !sameIds(before.collectionUnitIds, after.collectionUnitIds) ||
    !sameIds(before.requiredUnitIds, after.requiredUnitIds) ||
    !sameIds(before.excludedUnitIds, after.excludedUnitIds)
  ) {
    return false;
  }

  const selectedUnitIds = new Set(
    revised.units.map((selection) => selection.unitId),
  );
  if (
    (before.requiredUnitIds ?? []).some(
      (unitId) => !selectedUnitIds.has(unitId),
    ) ||
    (before.excludedUnitIds ?? []).some((unitId) =>
      selectedUnitIds.has(unitId),
    ) ||
    (
      before.collectionUnitIds &&
      revised.units.some(
        (selection) =>
          !before.collectionUnitIds?.includes(selection.unitId),
      )
    )
  ) {
    return false;
  }
  if (
    before.requiredWarlordUnitId &&
    !revised.units.some(
      (selection) =>
        selection.unitId === before.requiredWarlordUnitId &&
        selection.isWarlord,
    )
  ) {
    return false;
  }
  if (
    !before.allowNamedCharacters &&
    rosterHasNamedCharacter(revised)
  ) {
    return false;
  }
  if (
    !before.allowLegends &&
    revised.units.some(
      (selection) =>
        units.getAny(selection.unitId)?.raw.is_legend === true,
    )
  ) {
    return false;
  }
  return true;
}

function bandRank(band: TesseraMissionReadinessBand): number {
  if (band === "green") return 3;
  if (band === "amber") return 2;
  if (band === "red") return 1;
  return 0;
}

export function missionReadinessIsNoWorse(
  baseline: TesseraMissionReadinessReport,
  revised: TesseraMissionReadinessReport,
): boolean {
  if (bandRank(revised.overallBand) < bandRank(baseline.overallBand)) {
    return false;
  }
  if (
    baseline.dimensions.some((before) => {
      const after = revised.dimensions.find(
        (candidate) => candidate.id === before.id,
      );
      return !after || bandRank(after.band) < bandRank(before.band);
    })
  ) {
    return false;
  }
  return !baseline.primaryMissions.some((before) => {
    const after = revised.primaryMissions.find(
      (candidate) => candidate.matchupId === before.matchupId,
    );
    return !after || bandRank(after.band) < bandRank(before.band);
  });
}

export async function qualifyRosterChangeCandidate(
  baselineRoster: RosterDraftV1,
  baselineReadiness: TesseraMissionReadinessReport,
  operation: ModifyRosterOperation,
): Promise<{
  roster: RosterDraftV1;
  readiness: TesseraMissionReadinessReport;
} | null> {
  const modified = modifyRoster(baselineRoster, operation);
  if (
    !modified.ok ||
    !modified.data ||
    !preservesRosterHardConstraints(baselineRoster, modified.data) ||
    !validateRoster(modified.data).ok
  ) {
    return null;
  }
  if (
    modified.data.totalPoints /
      Math.max(1, modified.data.pointsLimit) <
    MINIMUM_CHANGE_CANDIDATE_UTILIZATION
  ) {
    return null;
  }
  const exported = await exportRoster(modified.data, "rosz");
  if (!exported.ok || !exported.data) return null;
  const readiness = analyzeMissionReadiness(modified.data);
  if (!readiness.ok || !readiness.data) return null;
  const guardrail = assessMissionReadinessRevisionGuardrail(
    baselineReadiness,
    readiness.data,
  );
  if (
    !guardrail.accepted ||
    !missionReadinessIsNoWorse(baselineReadiness, readiness.data)
  ) {
    return null;
  }
  return {
    roster: modified.data,
    readiness: readiness.data,
  };
}
