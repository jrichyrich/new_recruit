import {
  buildRoster,
  exportRoster,
  listDetachments,
  validateRoster,
} from "./engine";
import { getNewRecruitFactionCatalogue } from "./catalogue";
import { analyzeMissionReadiness } from "./mission-readiness";
import {
  knownBlockedUnitIds,
  rosterExecutionFingerprint,
} from "./stress-portfolio";
import type {
  BuildRosterInput,
  PreferenceTag,
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
  TesseraMissionReadinessReport,
} from "./types";

export type DeterministicRosterRepairResult = {
  roster: RosterDraftV1;
  initialFingerprint: string;
  repaired: boolean;
  candidatesEvaluated: number;
  missionReadiness: TesseraMissionReadinessReport;
  ranking: {
    exportable: true;
    redDimensions: number;
    overallBand: TesseraMissionReadinessReport["overallBand"];
    pointsUtilization: number;
    preferenceBreadth: number;
    roleBreadth: number;
    stableFingerprint: string;
  };
};

function issue(code: string, message: string): RosterIssue {
  return { code, message, severity: "error" };
}

function preferenceVariants(
  preferences: PreferenceTag[],
): PreferenceTag[][] {
  const mixed = ["shooting", "melee"] satisfies PreferenceTag[];
  const mission = [
    "objective",
    "mobility",
    "durability",
  ] satisfies PreferenceTag[];
  const variants: PreferenceTag[][] = [
    preferences,
    [...preferences, ...mission],
    [...preferences, ...mixed],
    [...preferences, ...mission, ...mixed],
    ["objective", "mobility", "durability", "shooting", "melee"],
  ].map((values) => [
    ...new Set<PreferenceTag>(values as PreferenceTag[]),
  ]);
  return variants.filter(
    (candidate, index) =>
      variants.findIndex(
        (other) =>
          [...other].sort().join(",") === [...candidate].sort().join(","),
      ) === index,
  );
}

function bandRank(
  band: TesseraMissionReadinessReport["overallBand"],
): number {
  if (band === "green") return 3;
  if (band === "amber") return 2;
  if (band === "unknown") return 1;
  return 0;
}

function compareCandidates(
  left: DeterministicRosterRepairResult,
  right: DeterministicRosterRepairResult,
): number {
  return (
    left.ranking.redDimensions - right.ranking.redDimensions ||
    bandRank(right.ranking.overallBand) -
      bandRank(left.ranking.overallBand) ||
    right.ranking.pointsUtilization -
      left.ranking.pointsUtilization ||
    right.ranking.preferenceBreadth -
      left.ranking.preferenceBreadth ||
    right.ranking.roleBreadth - left.ranking.roleBreadth ||
    left.ranking.stableFingerprint.localeCompare(
      right.ranking.stableFingerprint,
    )
  );
}

function candidateResult(
  roster: RosterDraftV1,
  initialFingerprint: string,
  candidatesEvaluated: number,
  readiness: TesseraMissionReadinessReport,
): DeterministicRosterRepairResult {
  const stableFingerprint = rosterExecutionFingerprint(roster);
  return {
    roster,
    initialFingerprint,
    repaired: stableFingerprint !== initialFingerprint,
    candidatesEvaluated,
    missionReadiness: readiness,
    ranking: {
      exportable: true,
      redDimensions: readiness.dimensions.filter(
        (dimension) => dimension.band === "red",
      ).length,
      overallBand: readiness.overallBand,
      pointsUtilization:
        roster.totalPoints / Math.max(1, roster.pointsLimit),
      preferenceBreadth: new Set(
        roster.units.flatMap((unit) =>
          unit.tags.filter((tag) => roster.preferences.includes(tag)),
        ),
      ).size,
      roleBreadth: new Set(roster.units.map((unit) => unit.role)).size,
      stableFingerprint,
    },
  };
}

/**
 * Bounded deterministic search for a legal, New Recruit-exportable roster.
 * The comparator follows the workflow's quality-gate order and never mutates
 * the caller's initial draft.
 */
export async function repairRosterDeterministically(
  buildInput: BuildRosterInput,
): Promise<ResultEnvelope<DeterministicRosterRepairResult>> {
  const initial = buildRoster(buildInput);
  if (!initial.ok || !initial.data) {
    return {
      ok: false,
      data: null,
      violations: initial.violations,
      warnings: initial.warnings,
    };
  }
  const initialFingerprint = rosterExecutionFingerprint(initial.data);
  const factionId = initial.data.factionId;
  const detachments = listDetachments(factionId)
    .map((detachment) => detachment.id)
    .sort();
  const mapping = getNewRecruitFactionCatalogue(factionId);
  const blocked = knownBlockedUnitIds(factionId);
  const requestedCollection = initial.data.constraints.collectionUnitIds
    ? new Set(initial.data.constraints.collectionUnitIds)
    : null;
  const exportableCollection = Object.keys(mapping?.units ?? {})
    .filter((unitId) => !blocked.has(unitId))
    .filter((unitId) => !requestedCollection || requestedCollection.has(unitId))
    .sort();
  const variants = preferenceVariants(initial.data.preferences);
  const candidateInputs: BuildRosterInput[] = [];
  for (const detachmentId of detachments) {
    for (const preferences of variants) {
      candidateInputs.push({
        ...buildInput,
        playerFaction: factionId,
        faction: factionId,
        pointsLimit: initial.data.pointsLimit,
        preferences,
        detachmentId,
        allowNamedCharacters:
          initial.data.constraints.allowNamedCharacters,
        allowLegends: initial.data.constraints.allowLegends,
        collectionUnitIds: exportableCollection,
        requiredUnitIds:
          initial.data.constraints.requiredUnitIds ??
          buildInput.requiredUnitIds,
        excludedUnitIds:
          initial.data.constraints.excludedUnitIds ??
          buildInput.excludedUnitIds,
        requiredWarlordUnitId:
          initial.data.constraints.requiredWarlordUnitId ??
          buildInput.requiredWarlordUnitId,
      });
    }
  }
  const unique = new Map<string, DeterministicRosterRepairResult>();
  let evaluated = 0;
  for (const input of candidateInputs.slice(0, 120)) {
    const built = buildRoster(input);
    evaluated += 1;
    if (!built.ok || !built.data || !validateRoster(built.data).ok) continue;
    const exported = await exportRoster(built.data, "rosz");
    if (!exported.ok || !exported.data) continue;
    const readiness = analyzeMissionReadiness(built.data);
    if (!readiness.ok || !readiness.data) continue;
    const candidate = candidateResult(
      built.data,
      initialFingerprint,
      evaluated,
      readiness.data,
    );
    const current = unique.get(candidate.ranking.stableFingerprint);
    if (!current || compareCandidates(candidate, current) < 0) {
      unique.set(candidate.ranking.stableFingerprint, candidate);
    }
  }
  const ranked = [...unique.values()].sort(compareCandidates);
  if (ranked.length === 0) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "ROSTER_REPAIR_NO_EXPORTABLE_CANDIDATE",
          "The deterministic repair search did not find a legal New Recruit-exportable roster.",
        ),
      ],
      warnings: initial.warnings,
    };
  }
  const winner = ranked[0];
  winner.candidatesEvaluated = evaluated;
  return {
    ok: true,
    data: winner,
    violations: [],
    warnings: initial.warnings,
  };
}
