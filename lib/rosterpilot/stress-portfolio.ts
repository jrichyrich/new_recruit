import {
  buildRoster,
  exportRoster,
  factionHasLegalNamedAnchor,
  inspectRosterUnitThreatProperties,
  listDetachments,
  rosterHasNamedCharacter,
  rosterProfileRequirements,
  searchUnits,
  validateRoster,
} from "./engine";
import { getNewRecruitFactionCatalogue } from "./catalogue";
import {
  conflictBlocksAllUnitConfigurations,
  conflictsForRoster,
  getNewRecruitCapability,
  newRecruitCatalogue,
} from "./catalogue-summary";
import { newRecruitRos } from "./new-recruit";
import {
  newRecruitEquipmentSignature,
  resolveNewRecruitUnit,
} from "./new-recruit-resolver";
import type {
  BuildRosterInput,
  GenerateFactionStressPortfolioInput,
  PreferenceTag,
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
  TesseraArchetype,
  TesseraNamedCharacterCoverageStatus,
  TesseraStressComposition,
  TesseraStressPortfolio,
  TesseraStressPortfolioItem,
  TesseraStressPortfolioTraits,
  TesseraStressPortfolioPreview,
} from "./types";

export const TESSERA_STRESS_GENERATOR_VERSION = "faction-stress-v6";

const POSTURES: TesseraArchetype[] = [
  "balanced-control",
  "ranged-pressure",
  "assault-pressure",
];

const COMPOSITIONS: TesseraStressComposition[] = [
  "mixed",
  "mass",
  "elite-heavy",
];

function stableFingerprint(value: string): string {
  const seeds = [
    0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35,
    0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5,
  ];
  return seeds
    .map((seed, seedIndex) => {
      let hash = seed;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index) + seedIndex;
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

const POSTURE_TAGS: Record<TesseraArchetype, PreferenceTag[]> = {
  "balanced-control": ["objective"],
  "ranged-pressure": ["shooting"],
  "assault-pressure": ["melee", "mobility"],
};

const COMPOSITION_TAGS: Record<
  TesseraStressComposition,
  PreferenceTag[]
> = {
  mixed: [],
  mass: ["horde", "objective"],
  "elite-heavy": ["elite", "durability"],
};

function issue(
  code: string,
  message: string,
  severity: "error" | "warn" = "error",
): RosterIssue {
  return { code, message, severity };
}

function uniqueTags(tags: PreferenceTag[]): PreferenceTag[] {
  return [...new Set(tags)];
}

function sortedEquipmentSignature(
  unit: RosterDraftV1["units"][number],
): string {
  return unit.equipment
    .map((entry) => `${entry.itemId}:${entry.count}`)
    .sort()
    .join(",");
}

function structuralTokens(roster: RosterDraftV1): Map<string, number> {
  const tokens = new Map<string, number>();
  const add = (token: string) =>
    tokens.set(token, (tokens.get(token) ?? 0) + 1);
  add(`detachment:${roster.detachmentId}`);
  for (const unit of roster.units) {
    add(
      [
        "unit",
        unit.unitId,
        unit.modelCount,
        unit.enhancementId ?? "-",
        sortedEquipmentSignature(unit),
      ].join(":"),
    );
  }
  return tokens;
}

function simulationTokens(roster: RosterDraftV1): Map<string, number> {
  const tokens = new Map<string, number>();
  const add = (token: string) =>
    tokens.set(token, (tokens.get(token) ?? 0) + 1);
  for (const unit of roster.units) {
    add(
      [
        "unit",
        unit.unitId,
        unit.modelCount,
        unit.points,
        unit.isWarlord ? "warlord" : "not-warlord",
        unit.enhancementId ?? "-",
        sortedEquipmentSignature(unit),
      ].join(":"),
    );
  }
  return tokens;
}

/**
 * Stable list identity for paired runs and portfolio deduplication. Presentation
 * fields, selection ids, ordinals, force disposition, and timestamps are
 * intentionally excluded.
 */
export function rosterStructuralFingerprint(
  roster: RosterDraftV1,
): string {
  const units = roster.units
    .map((unit) => ({
      unitId: unit.unitId,
      modelCount: unit.modelCount,
      enhancementId: unit.enhancementId,
      equipment: unit.equipment
        .map((entry) => ({ itemId: entry.itemId, count: entry.count }))
        .sort(
          (left, right) =>
            left.itemId.localeCompare(right.itemId) ||
            left.count - right.count,
        ),
    }))
    .sort(
      (left, right) =>
        left.unitId.localeCompare(right.unitId) ||
        left.modelCount - right.modelCount ||
        (left.enhancementId ?? "").localeCompare(
          right.enhancementId ?? "",
        ) ||
        JSON.stringify(left.equipment).localeCompare(
          JSON.stringify(right.equipment),
        ),
    );
  return stableFingerprint(
    JSON.stringify({
      factionId: roster.factionId,
      pointsLimit: roster.pointsLimit,
      detachmentId: roster.detachmentId,
      units,
    }),
  );
}

/**
 * Identity of the payload Tessera can materially distinguish. Detachment and
 * presentation-only fields are excluded; selected units, model counts,
 * equipment, and enhancements are frozen.
 */
export function rosterSimulationFingerprint(
  roster: RosterDraftV1,
): string {
  const units = roster.units
    .map((unit) => ({
      unitId: unit.unitId,
      modelCount: unit.modelCount,
      enhancementId: unit.enhancementId,
      equipment: unit.equipment
        .filter((entry) => entry.count > 0)
        .map((entry) => ({
          itemId: entry.itemId,
          count: entry.count,
        }))
        .sort(
          (left, right) =>
            left.itemId.localeCompare(right.itemId) ||
            left.count - right.count,
        ),
    }))
    .sort(
      (left, right) =>
        left.unitId.localeCompare(right.unitId) ||
        left.modelCount - right.modelCount ||
        (left.enhancementId ?? "").localeCompare(
          right.enhancementId ?? "",
        ) ||
        JSON.stringify(left.equipment).localeCompare(
          JSON.stringify(right.equipment),
        ),
    );
  return stableFingerprint(
    JSON.stringify({
      factionId: roster.factionId,
      pointsLimit: roster.pointsLimit,
      units,
    }),
  );
}

/**
 * Stable execution identity for prepared artifacts and resumable runs. Unlike
 * the structural diversity fingerprint, this includes rule-bearing roster
 * state and the pinned data release.
 */
export function rosterExecutionFingerprint(
  roster: RosterDraftV1,
): string {
  const units = roster.units
    .map((unit) => ({
      unitId: unit.unitId,
      modelCount: unit.modelCount,
      points: unit.points,
      isWarlord: unit.isWarlord,
      enhancementId: unit.enhancementId,
      equipment: unit.equipment
        .map((entry) => ({ itemId: entry.itemId, count: entry.count }))
        .sort(
          (left, right) =>
            left.itemId.localeCompare(right.itemId) ||
            left.count - right.count,
        ),
    }))
    .sort(
      (left, right) =>
        left.unitId.localeCompare(right.unitId) ||
        left.modelCount - right.modelCount ||
        left.points - right.points ||
        Number(left.isWarlord) - Number(right.isWarlord) ||
        (left.enhancementId ?? "").localeCompare(
          right.enhancementId ?? "",
        ) ||
        JSON.stringify(left.equipment).localeCompare(
          JSON.stringify(right.equipment),
        ),
    );
  return stableFingerprint(
    JSON.stringify({
      gameSystem: roster.gameSystem,
      factionId: roster.factionId,
      pointsLimit: roster.pointsLimit,
      totalPoints: roster.totalPoints,
      detachmentId: roster.detachmentId,
      forceDispositionId: roster.forceDispositionId,
      sourceData: roster.sourceData,
      units,
    }),
  );
}

export type TesseraStressPortfolioContractEvaluation = {
  accepted: boolean;
  maximumResultStatus: "complete" | "degraded" | null;
  minimumUniqueRequired: number;
  completeUniqueRequired: number;
  minimumPosturesRequired: 3;
  usable: number;
  uniqueSimulationPayloads: number;
  representedPostures: TesseraArchetype[];
  missingPostures: TesseraArchetype[];
  allPosturesRepresented: boolean;
  executionViable: boolean;
  completeCoverage: boolean;
  missingTemplateIds: string[];
  reviewedNotApplicableTemplateIds: string[];
  unreviewedMissingTemplateIds: string[];
  violation: RosterIssue | null;
};

type DiversePortfolioReviewContract = {
  sourceReleaseId: string;
  reviewedNotApplicableTemplateIds: readonly string[];
  threatLensesReviewed?: boolean;
};

/**
 * Human review is bound to the exact pinned data release. A missing cell never
 * becomes acceptable merely because an unavailable item carries a warning.
 * The registry is intentionally empty until a faction review records a real
 * exception against a concrete release.
 */
const REVIEWED_NOT_APPLICABLE_DIVERSE_CELLS: Readonly<
  Record<string, DiversePortfolioReviewContract>
> = {};

function expectedDiversePortfolioContract(
  factionId: string,
  sourceReleaseId: string,
  lensDefinition?: NonNullable<
    TesseraStressPortfolio["contract"]
  >["lensDefinition"],
): NonNullable<TesseraStressPortfolio["contract"]> {
  const reviewed = REVIEWED_NOT_APPLICABLE_DIVERSE_CELLS[factionId];
  const reviewedNotApplicableTemplateIds =
    reviewed?.sourceReleaseId === sourceReleaseId
      ? [...reviewed.reviewedNotApplicableTemplateIds].sort()
      : [];
  const binding = {
    schemaVersion: 1 as const,
    methodology: "adaptive-threat-lenses-v1" as const,
    sourceReleaseId,
    reviewedNotApplicableTemplateIds,
    ...(lensDefinition
      ? {
          lensDefinition: {
            ...lensDefinition,
            reviewStatus:
              reviewed?.sourceReleaseId === sourceReleaseId &&
              reviewed.threatLensesReviewed === true
                ? ("reviewed" as const)
                : ("generated-pending-review" as const),
          },
        }
      : {}),
  };
  return {
    ...binding,
    fingerprint: stableFingerprint(JSON.stringify(binding)),
  };
}

function portfolioReviewContractMatchesRegistry(
  portfolio: TesseraStressPortfolio,
): boolean {
  if (portfolio.suite !== "diverse-9" || !portfolio.contract) {
    return false;
  }
  const expected = expectedDiversePortfolioContract(
    portfolio.factionId,
    portfolio.sourceData.releaseId,
    portfolio.contract.lensDefinition,
  );
  const requiresLensDefinition =
    portfolio.generatorVersion ===
    TESSERA_STRESS_GENERATOR_VERSION;
  return (
    portfolio.contract.schemaVersion === expected.schemaVersion &&
    portfolio.contract.methodology === expected.methodology &&
    portfolio.contract.sourceReleaseId === expected.sourceReleaseId &&
    portfolio.contract.fingerprint === expected.fingerprint &&
    (
      !requiresLensDefinition ||
      (
        portfolio.contract.lensDefinition !== undefined &&
        portfolio.contract.lensDefinition.postures.length ===
          POSTURES.length
      )
    ) &&
    JSON.stringify(
      [...portfolio.contract.reviewedNotApplicableTemplateIds].sort(),
    ) ===
      JSON.stringify(expected.reviewedNotApplicableTemplateIds)
  );
}

/**
 * One fail-closed contract for every portfolio consumer. Callers performing an
 * additional capability check, such as .rosz export, can restrict the usable
 * set without mutating the frozen portfolio.
 */
export function evaluateTesseraStressPortfolioContract(
  portfolio: TesseraStressPortfolio,
  options: {
    usableTemplateIds?: ReadonlySet<string>;
  } = {},
): TesseraStressPortfolioContractEvaluation {
  const isDiverse = portfolio.suite === "diverse-9";
  const minimumUniqueRequired = isDiverse ? 6 : 3;
  const completeUniqueRequired = isDiverse ? 9 : 3;
  const expectedDiverseTemplateIds = new Set(
    POSTURES.flatMap((posture) =>
      COMPOSITIONS.map(
        (composition) => `${posture}:${composition}`,
      ),
    ),
  );
  const usableItems = portfolio.items.filter(
    (item) =>
      item.status === "ready" &&
      item.roster !== null &&
      (
        options.usableTemplateIds === undefined ||
        options.usableTemplateIds.has(item.templateId)
      ),
  );
  const fingerprints = usableItems.map((item) => {
    try {
      return rosterExecutionFingerprint(item.roster!);
    } catch {
      return null;
    }
  });
  const executionFingerprintErrors =
    fingerprints.filter((fingerprint) => fingerprint === null).length;
  const uniqueSimulationPayloads =
    new Set(
      fingerprints.filter(
        (fingerprint): fingerprint is string =>
          fingerprint !== null,
      ),
    ).size;
  const representedPostures = POSTURES.filter((posture) =>
    usableItems.some((item) => item.posture === posture),
  );
  const allPosturesRepresented =
    representedPostures.length === POSTURES.length;
  const missingPostures = POSTURES.filter(
    (posture) => !representedPostures.includes(posture),
  );
  const templateCounts = new Map<string, number>();
  for (const item of portfolio.items) {
    templateCounts.set(
      item.templateId,
      (templateCounts.get(item.templateId) ?? 0) + 1,
    );
  }
  const duplicateTemplateIds = [...templateCounts.entries()]
    .filter(([, count]) => count !== 1)
    .map(([templateId]) => templateId)
    .sort();
  const unexpectedTemplateIds = isDiverse
    ? [...templateCounts.keys()]
        .filter(
          (templateId) =>
            !expectedDiverseTemplateIds.has(templateId),
        )
        .sort()
    : [];
  const expectedTemplateIds = isDiverse
    ? [...expectedDiverseTemplateIds]
    : [];
  const missingTemplateIds = expectedTemplateIds.filter(
    (templateId) =>
      !usableItems.some(
        (item) => item.templateId === templateId,
      ),
  );
  const reviewContractMatches =
    portfolioReviewContractMatchesRegistry(portfolio);
  const contractedReviewedIds = new Set(
    reviewContractMatches
      ? portfolio.contract!.reviewedNotApplicableTemplateIds
      : [],
  );
  const reviewedNotApplicableTemplateIds =
    missingTemplateIds.filter((templateId) => {
      const matching = portfolio.items.filter(
        (item) => item.templateId === templateId,
      );
      return (
        contractedReviewedIds.has(templateId) &&
        matching.length === 1 &&
        matching[0].status === "unavailable" &&
        matching[0].warnings.some(
          (warning) =>
            warning.code ===
            "STRESS_TEMPLATE_NOT_APPLICABLE",
        )
      );
    });
  const reviewedSet = new Set(
    reviewedNotApplicableTemplateIds,
  );
  const unreviewedMissingTemplateIds =
    missingTemplateIds.filter(
      (templateId) => !reviewedSet.has(templateId),
    );
  const payloadsAreDistinct =
    executionFingerprintErrors === 0 &&
    uniqueSimulationPayloads === usableItems.length;
  const executionViable =
    usableItems.length >= minimumUniqueRequired &&
    uniqueSimulationPayloads >= minimumUniqueRequired &&
    allPosturesRepresented;
  const commonShapeValid =
    duplicateTemplateIds.length === 0 &&
    payloadsAreDistinct &&
    (
      !isDiverse ||
      portfolio.contract === undefined ||
      reviewContractMatches
    );
  const completeCoverage = isDiverse
    ? commonShapeValid &&
      portfolio.items.length === completeUniqueRequired &&
      unexpectedTemplateIds.length === 0 &&
      missingTemplateIds.length === 0 &&
      usableItems.length === completeUniqueRequired &&
      uniqueSimulationPayloads === completeUniqueRequired &&
      allPosturesRepresented
    : commonShapeValid &&
      portfolio.items.length === completeUniqueRequired &&
      usableItems.length === completeUniqueRequired &&
      uniqueSimulationPayloads === completeUniqueRequired &&
      allPosturesRepresented;
  const degradedCoverage =
    isDiverse &&
    !completeCoverage &&
    commonShapeValid &&
    portfolio.items.length === completeUniqueRequired &&
    unexpectedTemplateIds.length === 0 &&
    executionViable &&
    missingTemplateIds.length > 0 &&
    unreviewedMissingTemplateIds.length === 0;
  const accepted = completeCoverage || degradedCoverage;
  const maximumResultStatus = completeCoverage
    ? "complete"
    : degradedCoverage
      ? "degraded"
      : null;
  const detail = [
    `usable=${usableItems.length}`,
    `unique=${uniqueSimulationPayloads}`,
    `postures=${representedPostures.join(", ") || "none"}`,
    `missing=${missingTemplateIds.join(", ") || "none"}`,
    `unreviewed=${unreviewedMissingTemplateIds.join(", ") || "none"}`,
    `duplicate templates=${duplicateTemplateIds.join(", ") || "none"}`,
    `unexpected templates=${unexpectedTemplateIds.join(", ") || "none"}`,
    `unfingerprintable=${executionFingerprintErrors}`,
    `review contract=${
      reviewContractMatches
        ? "bound"
        : portfolio.contract
          ? "invalid"
          : "absent"
    }`,
  ].join("; ");
  const contractDescription = isDiverse
    ? "diverse-9 requires nine execution-distinct payloads for a complete portfolio, or at least six execution-distinct payloads across all three postures with every missing cell present in the faction's release-bound reviewed-not-applicable contract"
    : "core-3 requires exactly three distinct payloads covering balanced-control, ranged-pressure, and assault-pressure";

  return {
    accepted,
    maximumResultStatus,
    minimumUniqueRequired,
    completeUniqueRequired,
    minimumPosturesRequired: 3,
    usable: usableItems.length,
    uniqueSimulationPayloads,
    representedPostures,
    missingPostures,
    allPosturesRepresented,
    executionViable,
    completeCoverage,
    missingTemplateIds,
    reviewedNotApplicableTemplateIds,
    unreviewedMissingTemplateIds,
    violation: accepted
      ? null
      : issue(
          "PORTFOLIO_CONTRACT_UNMET",
          `The ${portfolio.suite} portfolio contract is unmet: ${contractDescription}. Observed ${detail}.`,
        ),
  };
}

/**
 * Multiset Jaccard distance in the inclusive [0, 1] range.
 */
export function rosterStructuralDistance(
  left: RosterDraftV1,
  right: RosterDraftV1,
): number {
  const leftTokens = structuralTokens(left);
  const rightTokens = structuralTokens(right);
  const keys = new Set([...leftTokens.keys(), ...rightTokens.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const leftCount = leftTokens.get(key) ?? 0;
    const rightCount = rightTokens.get(key) ?? 0;
    intersection += Math.min(leftCount, rightCount);
    union += Math.max(leftCount, rightCount);
  }
  return union === 0 ? 0 : 1 - intersection / union;
}

/**
 * Multiset Jaccard distance over the payload Tessera can execute. Unlike the
 * legacy structural distance, this deliberately ignores detachment and other
 * presentation-only differences so a portfolio cannot claim diversity from a
 * detachment-only roster change.
 */
export function rosterSimulationDistance(
  left: RosterDraftV1,
  right: RosterDraftV1,
): number {
  const leftTokens = simulationTokens(left);
  const rightTokens = simulationTokens(right);
  const keys = new Set([...leftTokens.keys(), ...rightTokens.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const leftCount = leftTokens.get(key) ?? 0;
    const rightCount = rightTokens.get(key) ?? 0;
    intersection += Math.min(leftCount, rightCount);
    union += Math.max(leftCount, rightCount);
  }
  return union === 0 ? 0 : 1 - intersection / union;
}

function traitsFor(roster: RosterDraftV1): TesseraStressPortfolioTraits {
  const tagCounts = Object.fromEntries(
    (
      [
        "mobility",
        "durability",
        "objective",
        "shooting",
        "melee",
        "elite",
        "horde",
      ] satisfies PreferenceTag[]
    ).map((tag) => [tag, 0]),
  ) as Record<PreferenceTag, number>;
  let modelCount = 0;
  let hordeModelCount = 0;
  let hordePoints = 0;
  let eliteHeavyPoints = 0;
  let eliteHeavyModelCount = 0;
  let infantryPoints = 0;
  let vehiclePoints = 0;
  let monsterPoints = 0;
  let rangedPressure = 0;
  let meleePressure = 0;
  let mobilityPressurePoints = 0;
  let maximumUnitPoints = 0;
  for (const unit of roster.units) {
    modelCount += unit.modelCount;
    maximumUnitPoints = Math.max(maximumUnitPoints, unit.points);
    for (const tag of unit.tags) {
      tagCounts[tag] += 1;
    }
    const threat = inspectRosterUnitThreatProperties(
      roster.factionId,
      unit.unitId,
      unit.equipment,
    );
    const normalizedRole = unit.role.toLowerCase();
    if (
      threat?.infantry === true ||
      normalizedRole === "infantry"
    ) {
      infantryPoints += unit.points;
    }
    if (
      threat?.vehicle === true ||
      normalizedRole === "vehicle"
    ) {
      vehiclePoints += unit.points;
    }
    if (
      threat?.monster === true ||
      normalizedRole === "monster"
    ) {
      monsterPoints += unit.points;
    }
    rangedPressure +=
      threat?.rangedPressure ??
      (unit.tags.includes("shooting") ? unit.points : 0);
    meleePressure +=
      threat?.meleePressure ??
      (unit.tags.includes("melee") ? unit.points : 0);
    mobilityPressurePoints +=
      unit.points *
      Math.min(
        1,
        (threat?.mobilityPressure ??
          (unit.tags.includes("mobility") ? 12 : 0)) /
          18,
      );
    if (unit.tags.includes("horde")) {
      hordeModelCount += unit.modelCount;
      hordePoints += unit.points;
    }
    if (
      unit.role.toLowerCase() === "vehicle" ||
      unit.role.toLowerCase() === "monster" ||
      unit.tags.includes("elite")
    ) {
      eliteHeavyPoints += unit.points;
      eliteHeavyModelCount += unit.modelCount;
    }
  }
  const totalPoints = Math.max(1, roster.totalPoints);
  const totalCombatPressure = Math.max(
    1,
    rangedPressure + meleePressure,
  );
  return {
    modelCount,
    unitCount: roster.units.length,
    roleCount: new Set(roster.units.map((unit) => unit.role)).size,
    pointsUtilization: roster.totalPoints / Math.max(1, roster.pointsLimit),
    pointsPerModel: roster.totalPoints / Math.max(1, modelCount),
    infantryPointsPercent: infantryPoints / totalPoints,
    vehiclePointsPercent: vehiclePoints / totalPoints,
    monsterPointsPercent: monsterPoints / totalPoints,
    rangedPressurePercent:
      rangedPressure / totalCombatPressure,
    meleePressurePercent:
      meleePressure / totalCombatPressure,
    mobilityPressurePercent:
      mobilityPressurePoints / totalPoints,
    unitConcentrationPercent:
      maximumUnitPoints / totalPoints,
    hordeModelCount,
    hordePoints,
    hordePointsPercent: hordePoints / totalPoints,
    eliteHeavyPoints,
    eliteHeavyPointsPercent: eliteHeavyPoints / totalPoints,
    eliteHeavyModelCount,
    tagCounts,
  };
}

export function inspectStressPortfolioTraits(
  roster: RosterDraftV1,
): TesseraStressPortfolioTraits {
  return traitsFor(roster);
}

function compositionSatisfied(
  composition: TesseraStressComposition,
  traits: TesseraStressPortfolioTraits,
): boolean {
  if (composition === "mixed") {
    return (
      traits.roleCount >= 3 &&
      traits.hordePointsPercent < 0.45 &&
      traits.eliteHeavyPointsPercent >= 0.15 &&
      traits.eliteHeavyPointsPercent <= 0.7
    );
  }
  if (composition === "mass") {
    return (
      traits.hordePointsPercent >= 0.25 &&
      traits.modelCount > 0 &&
      traits.hordeModelCount / traits.modelCount >= 0.4 &&
      traits.eliteHeavyPointsPercent <= 0.55
    );
  }
  return traits.eliteHeavyPointsPercent >= 0.45;
}

function compositionEvidence(
  composition: TesseraStressComposition,
  traits: TesseraStressPortfolioTraits,
): string[] {
  const modelShare =
    traits.modelCount === 0
      ? 0
      : traits.hordeModelCount / traits.modelCount;
  return [
    `${composition} posture evidence`,
    `${traits.roleCount} represented roles`,
    `${Math.round(traits.hordePointsPercent * 100)}% horde-tagged points`,
    `${Math.round(modelShare * 100)}% horde-tagged models`,
    `${Math.round(traits.eliteHeavyPointsPercent * 100)}% elite/Vehicle/Monster points`,
    `${traits.modelCount} total models`,
  ];
}

function templateFit(
  roster: RosterDraftV1,
  posture: TesseraArchetype,
  composition: TesseraStressComposition,
): number {
  const desired = uniqueTags([
    ...POSTURE_TAGS[posture],
    ...COMPOSITION_TAGS[composition],
  ]);
  if (desired.length === 0 || roster.totalPoints <= 0) return 0;
  const coverage = desired.reduce((sum, tag) => {
    const taggedPoints = roster.units
      .filter((unit) => unit.tags.includes(tag))
      .reduce((points, unit) => points + unit.points, 0);
    return sum + Math.min(1, taggedPoints / roster.totalPoints);
  }, 0);
  return coverage / desired.length;
}

function postureFit(
  roster: RosterDraftV1,
  posture: TesseraArchetype,
): number {
  const traits = traitsFor(roster);
  const ranged =
    traits.rangedPressurePercent ??
    templateFit(roster, "ranged-pressure", "mixed");
  const melee =
    traits.meleePressurePercent ??
    templateFit(roster, "assault-pressure", "mixed");
  const mobility =
    traits.mobilityPressurePercent ??
    templateFit(roster, "assault-pressure", "mixed");
  if (posture === "ranged-pressure") {
    return ranged * 0.8 + mobility * 0.2;
  }
  if (posture === "assault-pressure") {
    return melee * 0.75 + mobility * 0.25;
  }
  const objectivePoints = roster.units
    .filter((unit) => unit.tags.includes("objective"))
    .reduce((sum, unit) => sum + unit.points, 0);
  const objectiveShare =
    objectivePoints / Math.max(1, roster.totalPoints);
  const pressureBalance =
    1 - Math.min(1, Math.abs(ranged - melee));
  return (
    pressureBalance * 0.35 +
    objectiveShare * 0.3 +
    mobility * 0.15 +
    (1 - (traits.unitConcentrationPercent ?? 1)) * 0.2
  );
}

function preferenceVariants(
  posture: TesseraArchetype,
  composition: TesseraStressComposition,
): PreferenceTag[][] {
  const required = uniqueTags([
    ...POSTURE_TAGS[posture],
    ...COMPOSITION_TAGS[composition],
  ]);
  return [
    required,
    uniqueTags([...required, "objective"]),
    uniqueTags([...required, "mobility"]),
    uniqueTags([...required, "durability"]),
    uniqueTags([
      ...required,
      posture === "assault-pressure" ? "shooting" : "melee",
    ]),
    ...(composition === "mixed"
      ? [
          uniqueTags([...required, "horde", "durability"]),
          uniqueTags([...required, "horde", "mobility"]),
        ]
      : []),
  ].filter(
    (candidate, index, all) =>
      all.findIndex(
        (other) =>
          [...other].sort().join(",") === [...candidate].sort().join(","),
      ) === index,
  );
}

function unexportableUnitIds(roster: RosterDraftV1): string[] {
  const faction = getNewRecruitFactionCatalogue(roster.factionId);
  if (!faction) return roster.units.map((unit) => unit.unitId);
  const blocked = new Set<string>();
  const blockingConflicts = conflictsForRoster(roster).filter(
    (conflict) => conflict.blocking,
  );
  for (const selection of roster.units) {
    const mapping = faction.units[selection.unitId];
    if (
      !mapping ||
      blockingConflicts.some(
        (conflict) =>
          conflictBlocksAllUnitConfigurations(conflict) &&
          (
            conflict.entityId === selection.unitId ||
            conflict.entityId.startsWith(`${selection.unitId}:`)
          ),
      )
    ) {
      blocked.add(selection.unitId);
    }
  }
  return [...blocked];
}

type InternalSelectionExclusion = NonNullable<
  BuildRosterInput["internalSelectionExclusions"]
>[number];

function selectionExclusionKey(
  exclusion: InternalSelectionExclusion,
): string {
  return [
    exclusion.unitId,
    exclusion.modelCount,
    exclusion.equipmentSignature ?? "*",
    exclusion.unitOrdinalMin ?? 1,
    exclusion.unitOrdinalMax ?? "*",
  ].join("|");
}

function unexportableSelectionExclusions(
  roster: RosterDraftV1,
): InternalSelectionExclusion[] {
  const faction = getNewRecruitFactionCatalogue(roster.factionId);
  if (!faction) {
    return roster.units.map((selection) => ({
      unitId: selection.unitId,
      modelCount: selection.modelCount,
      equipmentSignature:
        newRecruitEquipmentSignature(selection.equipment),
      unitOrdinalMin: selection.ordinal,
      unitOrdinalMax: selection.ordinal,
    }));
  }
  const blockingConflicts = conflictsForRoster(roster).filter(
    (conflict) => conflict.blocking,
  );
  return roster.units
    .filter((selection) => {
      const mapping = faction.units[selection.unitId];
      return (
        !mapping ||
        (selection.isWarlord && !mapping.warlord) ||
        (selection.enhancementId &&
          !mapping.enhancements[selection.enhancementId]) ||
        (
          mapping &&
          !resolveNewRecruitUnit(mapping, selection).ok
        ) ||
        blockingConflicts.some(
          (conflict) =>
            conflict.entityId === selection.unitId ||
            conflict.entityId.startsWith(
              `${selection.unitId}:`,
            ),
        )
      );
    })
    .map((selection) => ({
      unitId: selection.unitId,
      modelCount: selection.modelCount,
      equipmentSignature:
        newRecruitEquipmentSignature(selection.equipment),
      unitOrdinalMin: selection.ordinal,
      unitOrdinalMax: selection.ordinal,
    }));
}

export function knownBlockedSelectionExclusions(
  factionId: string,
): InternalSelectionExclusion[] {
  const mapping = getNewRecruitFactionCatalogue(factionId);
  if (!mapping) return [];
  const unitIds = Object.keys(mapping.units);
  const exclusions: InternalSelectionExclusion[] = [];
  for (
    const conflict of
      newRecruitCatalogue.factions[factionId]?.conflicts ?? []
  ) {
    if (
      !conflict.blocking ||
      conflictBlocksAllUnitConfigurations(conflict)
    ) {
      continue;
    }
    const unitId = unitIds.find(
      (candidate) =>
        conflict.entityId === candidate ||
        conflict.entityId.startsWith(`${candidate}:`),
    );
    if (!unitId) continue;
    const scopes =
      conflict.scope?.selectionScopes ??
      (
        conflict.scope?.modelCount !== undefined
          ? [{
              modelCount: conflict.scope.modelCount,
              equipmentSignature:
                conflict.scope.equipmentSignature,
              unitOrdinalMin:
                conflict.scope.unitOrdinalMin,
              unitOrdinalMax:
                conflict.scope.unitOrdinalMax,
            }]
          : []
      );
    for (const scope of scopes) {
      exclusions.push({
        unitId,
        modelCount: scope.modelCount,
        equipmentSignature: scope.equipmentSignature,
        unitOrdinalMin: scope.unitOrdinalMin,
        unitOrdinalMax: scope.unitOrdinalMax,
      });
    }
  }
  return [
    ...new Map(
      exclusions.map((exclusion) => [
        selectionExclusionKey(exclusion),
        exclusion,
      ]),
    ).values(),
  ];
}

export function knownBlockedUnitIds(factionId: string): Set<string> {
  const blocked = new Set<string>();
  const mapping = getNewRecruitFactionCatalogue(factionId);
  const unitIds = Object.keys(mapping?.units ?? {});
  const conflicts =
    newRecruitCatalogue.factions[factionId]?.conflicts ?? [];
  for (const conflict of conflicts) {
    if (
      !conflictBlocksAllUnitConfigurations(conflict)
    ) {
      continue;
    }
    const unitId = unitIds.find(
      (candidate) =>
        conflict.entityId === candidate ||
        conflict.entityId.startsWith(`${candidate}:`),
    );
    if (unitId) blocked.add(unitId);
  }
  return blocked;
}

function buildExportableRoster(
  input: Parameters<typeof buildRoster>[0],
  knownBlocked: Set<string>,
): RosterDraftV1 | null {
  const explicitFactionId = input.playerFaction ?? input.faction;
  const factionId =
    explicitFactionId &&
    getNewRecruitFactionCatalogue(explicitFactionId)
      ? explicitFactionId
      : buildRoster(input).data?.factionId;
  if (!factionId) return null;
  const catalogue = getNewRecruitFactionCatalogue(factionId);
  if (!catalogue) return null;
  const requestedCollection = input.collectionUnitIds
    ? new Set(input.collectionUnitIds)
    : null;
  const allowed = new Set(
    Object.keys(catalogue.units).filter(
      (unitId) =>
        !knownBlocked.has(unitId) &&
        (!requestedCollection || requestedCollection.has(unitId)),
    ),
  );
  const selectionExclusions = new Map(
    [
      ...(input.internalSelectionExclusions ?? []),
      ...knownBlockedSelectionExclusions(factionId),
    ].map((exclusion) => [
      selectionExclusionKey(exclusion),
      exclusion,
    ]),
  );
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const built = buildRoster({
      ...input,
      collectionUnitIds: [...allowed].sort(),
      internalSelectionExclusions: [
        ...selectionExclusions.values(),
      ],
    });
    if (!built.ok || !built.data) return null;
    try {
      newRecruitRos(built.data);
      return built.data;
    } catch {
      const globallyBlocked = new Set(
        unexportableUnitIds(built.data),
      );
      const locallyBlocked =
        unexportableSelectionExclusions(built.data);
      let changed = false;
      for (const unitId of globallyBlocked) {
        knownBlocked.add(unitId);
        changed = allowed.delete(unitId) || changed;
      }
      for (const exclusion of locallyBlocked) {
        const key = selectionExclusionKey(exclusion);
        if (!selectionExclusions.has(key)) {
          selectionExclusions.set(key, exclusion);
          changed = true;
        }
      }
      if (!changed) return null;
    }
  }
  return null;
}

export function buildExportableRosterCandidate(
  input: Parameters<typeof buildRoster>[0],
): RosterDraftV1 | null {
  const explicitFactionId = input.playerFaction ?? input.faction;
  if (!explicitFactionId) return null;
  const detachments = input.detachmentId
    ? [input.detachmentId]
    : listDetachments(explicitFactionId).map(
        (detachment) => detachment.id,
      );
  for (const detachmentId of detachments) {
    const candidate = buildExportableRoster(
      { ...input, detachmentId },
      knownBlockedUnitIds(explicitFactionId),
    );
    if (candidate) return candidate;
  }
  return null;
}

interface StressCandidate {
  roster: RosterDraftV1;
  traits: TesseraStressPortfolioTraits;
}

interface AdaptiveDensityLens {
  candidates: StressCandidate[];
  percentileByFingerprint: Map<string, number>;
  maximumRoleCount: number;
}

function pointsPerModel(candidate: StressCandidate): number {
  return (
    candidate.traits.pointsPerModel ??
    candidate.roster.totalPoints /
      Math.max(1, candidate.traits.modelCount)
  );
}

/**
 * Build a faction/posture-relative density scale. A small elite faction and a
 * high-model-count faction should both be able to expose low-, central-, and
 * high-density threats without pretending that a faction has horde-tagged
 * units it does not actually possess.
 */
function adaptiveDensityLens(
  candidates: StressCandidate[],
): AdaptiveDensityLens {
  const ordered = [...candidates].sort(
    (left, right) =>
      left.traits.modelCount - right.traits.modelCount ||
      pointsPerModel(right) - pointsPerModel(left) ||
      right.traits.eliteHeavyPointsPercent -
        left.traits.eliteHeavyPointsPercent ||
      rosterSimulationFingerprint(left.roster).localeCompare(
        rosterSimulationFingerprint(right.roster),
      ),
  );
  const percentileByFingerprint = new Map<string, number>();
  for (const [index, candidate] of ordered.entries()) {
    percentileByFingerprint.set(
      rosterSimulationFingerprint(candidate.roster),
      ordered.length <= 1 ? 0.5 : index / (ordered.length - 1),
    );
  }
  return {
    candidates: ordered,
    percentileByFingerprint,
    maximumRoleCount: Math.max(
      1,
      ...ordered.map((candidate) => candidate.traits.roleCount),
    ),
  };
}

function threatLensDefinition(
  pools: ReadonlyMap<TesseraArchetype, StressCandidate[]>,
): NonNullable<
  NonNullable<TesseraStressPortfolio["contract"]>["lensDefinition"]
> {
  const range = (
    candidates: StressCandidate[],
    value: (candidate: StressCandidate) => number,
  ): [number, number] => {
    const values = candidates.map(value);
    return values.length === 0
      ? [0, 0]
      : [Math.min(...values), Math.max(...values)];
  };
  return {
    schemaVersion: 1,
    metricVersion: "roster-threat-properties-v1",
    reviewStatus: "generated-pending-review",
    metrics: [
      "model-density",
      "points-per-model",
      "infantry-share",
      "vehicle-monster-share",
      "ranged-pressure",
      "melee-pressure",
      "mobility",
      "unit-concentration",
    ],
    postures: POSTURES.map((posture) => {
      const candidates = pools.get(posture) ?? [];
      return {
        posture,
        candidateCount: candidates.length,
        ranges: {
          modelCount: range(
            candidates,
            (candidate) => candidate.traits.modelCount,
          ),
          pointsPerModel: range(candidates, pointsPerModel),
          infantryPointsPercent: range(
            candidates,
            (candidate) =>
              candidate.traits.infantryPointsPercent ?? 0,
          ),
          vehicleMonsterPointsPercent: range(
            candidates,
            (candidate) =>
              (candidate.traits.vehiclePointsPercent ?? 0) +
              (candidate.traits.monsterPointsPercent ?? 0),
          ),
          rangedPressurePercent: range(
            candidates,
            (candidate) =>
              candidate.traits.rangedPressurePercent ?? 0,
          ),
          meleePressurePercent: range(
            candidates,
            (candidate) =>
              candidate.traits.meleePressurePercent ?? 0,
          ),
          mobilityPressurePercent: range(
            candidates,
            (candidate) =>
              candidate.traits.mobilityPressurePercent ?? 0,
          ),
          unitConcentrationPercent: range(
            candidates,
            (candidate) =>
              candidate.traits.unitConcentrationPercent ?? 0,
          ),
        },
      };
    }),
  };
}

function densityPercentile(
  candidate: StressCandidate,
  lens: AdaptiveDensityLens,
): number {
  return (
    lens.percentileByFingerprint.get(
      rosterSimulationFingerprint(candidate.roster),
    ) ?? 0.5
  );
}

function adaptiveCompositionEligible(
  candidate: StressCandidate,
  composition: TesseraStressComposition,
  lens: AdaptiveDensityLens,
): boolean {
  if (lens.candidates.length < 3) return false;
  const percentile = densityPercentile(candidate, lens);
  if (composition === "mass") return percentile >= 1 / 3;
  if (composition === "elite-heavy") return percentile <= 2 / 3;
  // The central lens prefers the middle of the distribution through its
  // score, but remains assignment-capable across the full reviewed candidate
  // pool. This prevents a narrow elite faction from becoming impossible only
  // because several legal lists tie on model density.
  return true;
}

function adaptiveCompositionFit(
  candidate: StressCandidate,
  composition: TesseraStressComposition,
  lens: AdaptiveDensityLens,
): number {
  const percentile = densityPercentile(candidate, lens);
  const roleBreadth =
    candidate.traits.roleCount / lens.maximumRoleCount;
  const eliteShare = candidate.traits.eliteHeavyPointsPercent;
  const infantryShare =
    candidate.traits.infantryPointsPercent ?? 0;
  const vehicleMonsterShare =
    (candidate.traits.vehiclePointsPercent ?? 0) +
    (candidate.traits.monsterPointsPercent ?? 0);
  const concentration =
    candidate.traits.unitConcentrationPercent ?? 1;
  const ranged =
    candidate.traits.rangedPressurePercent ?? 0.5;
  const melee =
    candidate.traits.meleePressurePercent ?? 0.5;
  if (composition === "mass") {
    return (
      percentile * 0.35 +
      (1 - Math.min(1, pointsPerModel(candidate) / 100)) * 0.1 +
      infantryShare * 0.2 +
      (1 - Math.min(1, vehicleMonsterShare)) * 0.1 +
      (1 - concentration) * 0.25
    );
  }
  if (composition === "elite-heavy") {
    return (
      (1 - percentile) * 0.25 +
      eliteShare * 0.2 +
      Math.min(1, pointsPerModel(candidate) / 100) * 0.1 +
      Math.min(1, vehicleMonsterShare) * 0.2 +
      concentration * 0.25
    );
  }
  return (
    (1 - Math.abs(percentile - 0.5) * 2) * 0.25 +
    roleBreadth * 0.15 +
    (1 - Math.abs(eliteShare - 0.5) * 2) * 0.1 +
    (1 - Math.abs(ranged - melee)) * 0.2 +
    (1 - concentration) * 0.2 +
    (
      1 -
      Math.min(1, Math.abs(infantryShare - vehicleMonsterShare))
    ) *
      0.1
  );
}

function adaptiveCompositionEvidence(
  composition: TesseraStressComposition,
  candidate: StressCandidate,
  lens: AdaptiveDensityLens,
): string[] {
  const percentile = Math.round(
    densityPercentile(candidate, lens) * 100,
  );
  const label =
    composition === "mass"
      ? "high-density"
      : composition === "elite-heavy"
        ? "low-density/elite"
        : "central-density combined-arms";
  return [
    `${composition} adaptive lens: ${label}`,
    `${percentile}th faction/posture-relative density percentile across ${lens.candidates.length} legal exportable candidates`,
    `${candidate.traits.modelCount} total models at ${pointsPerModel(candidate).toFixed(1)} points per model`,
    `${candidate.traits.roleCount} represented roles`,
    `${Math.round(candidate.traits.eliteHeavyPointsPercent * 100)}% elite/Vehicle/Monster points`,
    `${Math.round((candidate.traits.infantryPointsPercent ?? 0) * 100)}% Infantry points; ${Math.round(((candidate.traits.vehiclePointsPercent ?? 0) + (candidate.traits.monsterPointsPercent ?? 0)) * 100)}% Vehicle/Monster points`,
    `${Math.round((candidate.traits.rangedPressurePercent ?? 0) * 100)}% ranged and ${Math.round((candidate.traits.meleePressurePercent ?? 0) * 100)}% melee selected-weapon pressure`,
    `${Math.round((candidate.traits.mobilityPressurePercent ?? 0) * 100)}% mobility pressure; ${Math.round((candidate.traits.unitConcentrationPercent ?? 0) * 100)}% largest-unit concentration`,
    `${Math.round(candidate.traits.hordePointsPercent * 100)}% horde-tagged points (context only; not a gate)`,
  ];
}

function compositionCollections(
  composition: TesseraStressComposition,
  factionUnits: NonNullable<ReturnType<typeof searchUnits>["data"]>,
  characterIds: string[],
  pointsLimit: number,
): Array<string[] | undefined> {
  const collection =
    composition === "mixed"
      ? [
          ...new Set([
            ...characterIds,
            ...factionUnits
              .filter(
                (unit) =>
                  !unit.tags.includes("elite") ||
                  unit.pointsFrom <= pointsLimit * 0.22,
              )
              .map((unit) => unit.id),
          ]),
        ].sort()
      : composition === "mass"
        ? [
            ...new Set([
              ...characterIds,
              ...factionUnits
                .filter(
                  (unit) =>
                    unit.tags.includes("horde") ||
                    unit.tags.includes("objective") ||
                    unit.pointsFrom <= pointsLimit * 0.12,
                )
                .map((unit) => unit.id),
            ]),
          ].sort()
        : [
            ...new Set([
              ...characterIds,
              ...factionUnits
                .filter((unit) => unit.tags.includes("elite"))
                .map((unit) => unit.id),
            ]),
          ].sort();
  return collection.length > 0 ? [collection, undefined] : [undefined];
}

/**
 * Build one broad, deterministic pool for a posture before assigning any
 * composition cell. Attempt scheduling is interleaved across compositions and
 * every detachment, avoiding the old behavior where the first four builds all
 * came from the first one or two lexicographic detachments.
 */
function candidateRosterPool(
  factionId: string,
  factionName: string,
  pointsLimit: number,
  posture: TesseraArchetype,
  allowLegends: boolean,
  pointsTolerancePercent: number,
  knownBlocked: Set<string>,
  expanded = false,
): StressCandidate[] {
  const factionUnits = searchUnits({
    faction: factionId,
    includeLegends: allowLegends,
    limit: 100,
  }).data ?? [];
  const characterIds = factionUnits
    .filter(
      (unit) =>
        unit.role === "Character" || unit.isNamedCharacter,
    )
    .map((unit) => unit.id);
  const results = new Map<string, StressCandidate>();
  const detachments = listDetachments(factionId).sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.name.localeCompare(right.name),
  );
  if (detachments.length === 0) return [];
  const unnamedAnchor = buildExportableRoster(
    {
      faction: factionId,
      pointsLimit,
      name: `${factionName} ${posture} unnamed-anchor probe`,
      preferences: POSTURE_TAGS[posture],
      allowNamedCharacters: false,
      allowLegends,
    },
    new Set(knownBlocked),
  );
  const requiresNamedCharacterAnchor = unnamedAnchor === null;
  const portfolioAnchor =
    unnamedAnchor ??
    buildExportableRoster(
      {
        faction: factionId,
        pointsLimit,
        name: `${factionName} ${posture} named-anchor probe`,
        preferences: POSTURE_TAGS[posture],
        allowNamedCharacters: true,
        allowLegends,
      },
      new Set(knownBlocked),
    );

  type Recipe = {
    composition: TesseraStressComposition;
    preferences: PreferenceTag[];
    collectionUnitIds: string[] | undefined;
    requiredUnitIds?: string[];
    excludedUnitIds?: string[];
  };
  const recipesByComposition = new Map<
    TesseraStressComposition,
    Recipe[]
  >();
  for (const composition of COMPOSITIONS) {
    const recipes: Recipe[] = [];
    for (const preferences of preferenceVariants(posture, composition)) {
      for (const collectionUnitIds of compositionCollections(
        composition,
        factionUnits,
        characterIds,
        pointsLimit,
      )) {
        recipes.push({
          composition,
          preferences,
          collectionUnitIds,
        });
      }
    }
    recipesByComposition.set(composition, recipes);
  }

  const recipes: Recipe[] = [];
  const longestRecipeList = Math.max(
    ...[...recipesByComposition.values()].map((entries) => entries.length),
  );
  for (let index = 0; index < longestRecipeList; index += 1) {
    for (const composition of COMPOSITIONS) {
      const recipe = recipesByComposition.get(composition)?.[index];
      if (recipe) recipes.push(recipe);
    }
  }

  const mappedUnitIds = new Set(
    Object.keys(getNewRecruitFactionCatalogue(factionId)?.units ?? {}),
  );
  const forcedUnitIds = [
    ...new Set([
      ...factionUnits
        .filter(
          (unit) =>
            !unit.isNamedCharacter &&
            mappedUnitIds.has(unit.id) &&
            !knownBlocked.has(unit.id) &&
            unit.pointsFrom <= pointsLimit,
        )
        .sort(
          (left, right) =>
            right.tags.filter((tag) =>
              POSTURE_TAGS[posture].includes(tag),
            ).length -
              left.tags.filter((tag) =>
                POSTURE_TAGS[posture].includes(tag),
              ).length ||
            right.pointsFrom - left.pointsFrom ||
            left.id.localeCompare(right.id),
        )
        .slice(0, 24)
        .map((unit) => unit.id),
    ]),
  ];
  const forcedRecipes: Recipe[] = forcedUnitIds.map(
    (unitId, index) => {
      const unit = factionUnits.find(
        (candidate) => candidate.id === unitId,
      );
      const composition =
        unit?.tags.includes("horde")
          ? "mass"
          : unit?.tags.includes("elite")
            ? "elite-heavy"
            : COMPOSITIONS[index % COMPOSITIONS.length];
      return {
        composition,
        preferences: uniqueTags([
          ...POSTURE_TAGS[posture],
          ...COMPOSITION_TAGS[composition],
          ...(unit?.tags ?? []),
        ]),
        collectionUnitIds: undefined,
        requiredUnitIds: [unitId],
      };
    },
  );
  const unitById = new Map(
    factionUnits.map((unit) => [unit.id, unit]),
  );
  const forcedPairRecipes: Recipe[] = expanded
    ? forcedUnitIds
        .flatMap((unitId, index) =>
          forcedUnitIds
            .slice(index + 1)
            .map((partnerId) => ({
              unitId,
              partnerId,
              unit: unitById.get(unitId),
              partner: unitById.get(partnerId),
            })),
        )
        .filter(
          (
            pair,
          ): pair is typeof pair & {
            unit: NonNullable<typeof pair.unit>;
            partner: NonNullable<typeof pair.partner>;
          } =>
            pair.unit !== undefined &&
            pair.partner !== undefined &&
            pair.unit.pointsFrom + pair.partner.pointsFrom <=
              pointsLimit * 0.9,
        )
        .sort(
          (left, right) =>
            right.unit.pointsFrom +
              right.partner.pointsFrom -
              (left.unit.pointsFrom +
                left.partner.pointsFrom) ||
            left.unitId.localeCompare(right.unitId) ||
            left.partnerId.localeCompare(right.partnerId),
        )
        .slice(0, 72)
        .map((pair, index) => {
          const composition =
            COMPOSITIONS[
              (index + POSTURES.indexOf(posture)) %
                COMPOSITIONS.length
            ];
          return {
            composition,
            preferences: uniqueTags([
              ...POSTURE_TAGS[posture],
              ...COMPOSITION_TAGS[composition],
              ...pair.unit.tags,
              ...pair.partner.tags,
            ]),
            collectionUnitIds: undefined,
            requiredUnitIds: [
              pair.unitId,
              pair.partnerId,
            ],
          };
        })
    : [];
  const anchorRecipes = [
    ...forcedRecipes,
    ...forcedPairRecipes,
  ];
  const anchorUnitPoints = new Map<string, number>();
  for (const unit of portfolioAnchor?.units ?? []) {
    anchorUnitPoints.set(
      unit.unitId,
      (anchorUnitPoints.get(unit.unitId) ?? 0) + unit.points,
    );
  }
  const anchorUnitIds = [...anchorUnitPoints.keys()];
  const pairedExclusionUnitIds =
    expanded && requiresNamedCharacterAnchor
      ? anchorUnitIds
          .filter(
            (unitId) =>
              (anchorUnitPoints.get(unitId) ?? pointsLimit) <=
              pointsLimit * 0.15,
          )
          .sort(
            (left, right) =>
              (anchorUnitPoints.get(left) ?? 0) -
                (anchorUnitPoints.get(right) ?? 0) ||
              left.localeCompare(right),
          )
          .flatMap((unitId, index, unitIds) =>
            unitIds
              .slice(index + 1)
              .map((partnerId) => [unitId, partnerId]),
          )
      : [];
  const exclusionUnitIds = [
    ...pairedExclusionUnitIds,
    ...anchorUnitIds.map((unitId) => [unitId]),
  ];
  const exclusionRecipes: Recipe[] =
    requiresNamedCharacterAnchor && portfolioAnchor
      ? exclusionUnitIds.map((excludedUnitIds, index) => {
          const excludedUnits = excludedUnitIds
            .map((unitId) =>
              factionUnits.find(
                (candidate) => candidate.id === unitId,
              ),
            )
            .filter(
              (
                unit,
              ): unit is NonNullable<typeof unit> =>
                unit !== undefined,
            );
          const composition =
            excludedUnits.some((unit) =>
              unit.tags.includes("horde"),
            )
              ? "mass"
              : excludedUnits.some((unit) =>
                    unit.tags.includes("elite"),
                  )
                ? "elite-heavy"
                : COMPOSITIONS[index % COMPOSITIONS.length];
          return {
            composition,
            preferences: uniqueTags([
              ...POSTURE_TAGS[posture],
              ...COMPOSITION_TAGS[composition],
            ]),
            collectionUnitIds: undefined,
            excludedUnitIds,
          };
        })
      : [];
  const scheduledRecipes =
    exclusionRecipes.length === 0
      ? [...anchorRecipes, ...recipes]
      : Array.from(
          {
            length: Math.max(
              anchorRecipes.length,
              exclusionRecipes.length,
              recipes.length,
            ),
          },
          (_, index) => [
            anchorRecipes[index],
            exclusionRecipes[index],
            recipes[index],
          ].filter((recipe): recipe is Recipe => recipe !== undefined),
        ).flat();
  const initialAttemptBudget = Math.min(
    scheduledRecipes.length,
    Math.max(12, Math.min(16, detachments.length)),
  );
  const hardAttemptBudget = expanded
    ? Math.min(
        scheduledRecipes.length,
        Math.max(initialAttemptBudget, 72),
      )
    : Math.min(
        scheduledRecipes.length,
        Math.max(
          initialAttemptBudget,
          Math.min(18, detachments.length * 2),
        ),
      );

  for (
    let attempt = 0;
    attempt < hardAttemptBudget;
    attempt += 1
  ) {
    if (
      attempt >= initialAttemptBudget &&
      results.size >= (expanded ? 12 : 6)
    ) {
      break;
    }
    const recipe = scheduledRecipes[attempt];
    const detachment = detachments[attempt % detachments.length];
    const rosterInput: BuildRosterInput = {
      faction: factionId,
      pointsLimit,
      name: `${factionName} ${posture} candidate ${attempt + 1}`,
      preferences: recipe.preferences,
      allowNamedCharacters:
        requiresNamedCharacterAnchor,
      allowLegends,
      collectionUnitIds: recipe.collectionUnitIds,
      requiredUnitIds: recipe.requiredUnitIds,
      excludedUnitIds: recipe.excludedUnitIds,
    };
    const roster =
      buildExportableRoster(
        {
          ...rosterInput,
          detachmentId: detachment.id,
        },
        knownBlocked,
      ) ??
      buildExportableRoster(
        rosterInput,
        knownBlocked,
      );
    if (!roster) continue;
    const validation = validateRoster(roster);
    if (!validation.ok) continue;
    const pointDifference =
      Math.abs(pointsLimit - roster.totalPoints) /
      Math.max(1, pointsLimit);
    if (pointDifference > pointsTolerancePercent / 100) continue;
    const traits = traitsFor(roster);
    if (traits.modelCount <= 0) continue;
    const fingerprint = rosterSimulationFingerprint(roster);
    const candidate = { roster, traits };
    const current = results.get(fingerprint);
    if (
      !current ||
      candidate.traits.pointsUtilization >
        current.traits.pointsUtilization ||
      (candidate.traits.pointsUtilization ===
        current.traits.pointsUtilization &&
        rosterStructuralFingerprint(candidate.roster).localeCompare(
          rosterStructuralFingerprint(current.roster),
        ) < 0)
    ) {
      results.set(fingerprint, candidate);
    }
  }

  return [...results.values()]
    .sort(
      (left, right) =>
        right.traits.pointsUtilization -
          left.traits.pointsUtilization ||
        rosterStructuralFingerprint(left.roster).localeCompare(
          rosterStructuralFingerprint(right.roster),
        ),
    )
    .slice(0, 24);
}

function namedCharacterSpecialistCandidate(
  factionId: string,
  factionName: string,
  pointsLimit: number,
  allowLegends: boolean,
  pointsTolerancePercent: number,
  knownBlocked: Set<string>,
  namedAnchorIds: readonly string[],
): StressCandidate | null {
  const buildCandidate = (
    anchorId: string,
    requiredWarlordUnitId?: string,
  ): StressCandidate | null => {
    const roster = buildExportableRoster(
      {
        faction: factionId,
        pointsLimit,
        name: `${factionName} named-character specialist`,
        preferences: ["objective", "durability"],
        allowNamedCharacters: true,
        allowLegends,
        requiredUnitIds: [anchorId],
        requiredWarlordUnitId,
      },
      new Set(knownBlocked),
    );
    if (!roster || !rosterHasNamedCharacter(roster)) return null;
    const pointDifference =
      Math.abs(pointsLimit - roster.totalPoints) /
      Math.max(1, pointsLimit);
    if (pointDifference > pointsTolerancePercent / 100) return null;
    return {
      roster,
      traits: traitsFor(roster),
    };
  };

  let escortWarlordUnitId: string | null | undefined;
  for (const anchorId of namedAnchorIds) {
    const direct = buildCandidate(anchorId);
    if (direct) return direct;

    if (escortWarlordUnitId === undefined) {
      const escortRoster = buildExportableRoster(
        {
          faction: factionId,
          pointsLimit,
          name: `${factionName} named-character specialist escort`,
          preferences: ["objective", "durability"],
          allowNamedCharacters: false,
          allowLegends,
        },
        new Set(knownBlocked),
      );
      escortWarlordUnitId =
        escortRoster?.units.find((unit) => unit.isWarlord)
          ?.unitId ?? null;
    }

    if (!escortWarlordUnitId) continue;
    const escorted = buildCandidate(
      anchorId,
      escortWarlordUnitId,
    );
    if (escorted) return escorted;
  }
  return null;
}

function satisfiedCompositions(
  candidate: StressCandidate,
): TesseraStressComposition[] {
  return COMPOSITIONS.filter((composition) =>
    compositionSatisfied(composition, candidate.traits),
  );
}

function preferredComposition(
  candidate: StressCandidate,
  posture: TesseraArchetype,
  desired: TesseraStressComposition,
): TesseraStressComposition {
  const satisfied = satisfiedCompositions(candidate);
  if (satisfied.includes(desired)) return desired;
  return [...satisfied].sort(
    (left, right) =>
      templateFit(candidate.roster, posture, right) -
        templateFit(candidate.roster, posture, left) ||
      COMPOSITIONS.indexOf(left) - COMPOSITIONS.indexOf(right),
  )[0] ?? desired;
}

function readyItem(
  posture: TesseraArchetype,
  composition: TesseraStressComposition,
  candidate: StressCandidate,
  structuralDistance: number,
  evidence?: string[],
): TesseraStressPortfolioItem {
  const templateId = `${posture}:${composition}`;
  return {
    templateId,
    posture,
    composition,
    status: "ready",
    roster: candidate.roster,
    fingerprint: rosterStructuralFingerprint(candidate.roster),
    simulationFingerprint:
      rosterSimulationFingerprint(candidate.roster),
    structuralDistance,
    detachmentId: candidate.roster.detachmentId,
    allowNamedCharacters:
      candidate.roster.constraints.allowNamedCharacters,
    traits: candidate.traits,
    compositionEvidence:
      evidence ??
      compositionEvidence(composition, candidate.traits),
    containsNamedCharacter:
      rosterHasNamedCharacter(candidate.roster),
    omissionReason: null,
    warnings: validateRoster(candidate.roster).warnings.map(
      (warning) => ({
        ...warning,
        message: `[${templateId}] ${warning.message}`,
      }),
    ),
  };
}

function selectCorePortfolio(
  pools: Map<TesseraArchetype, StressCandidate[]>,
): TesseraStressPortfolioItem[] {
  type Selection = {
    candidates: StressCandidate[];
    compositions: TesseraStressComposition[];
    minimumPostureFit: number;
    postureFit: number;
    modelSpan: number;
    minimumModelGap: number;
    compositionCoverage: number;
    minimumStructuralDistance: number;
    fit: number;
    pointsUtilization: number;
    fingerprint: string;
  };
  let best: Selection | null = null;
  const isBetterSelection = (
    candidate: Selection,
    current: Selection | null,
  ): boolean => {
    if (!current) return true;
    const candidateMetrics = [
      candidate.minimumPostureFit,
      candidate.postureFit,
      candidate.minimumStructuralDistance,
      candidate.modelSpan,
      candidate.minimumModelGap,
      candidate.compositionCoverage,
      candidate.fit,
      candidate.pointsUtilization,
    ];
    const currentMetrics = [
      current.minimumPostureFit,
      current.postureFit,
      current.minimumStructuralDistance,
      current.modelSpan,
      current.minimumModelGap,
      current.compositionCoverage,
      current.fit,
      current.pointsUtilization,
    ];
    for (const [index, metric] of candidateMetrics.entries()) {
      if (metric !== currentMetrics[index]) {
        return metric > currentMetrics[index];
      }
    }
    return candidate.fingerprint.localeCompare(current.fingerprint) < 0;
  };
  const posturePools = POSTURES.map((posture) => pools.get(posture) ?? []);
  if (posturePools.every((pool) => pool.length > 0)) {
    for (const balanced of posturePools[0]) {
      for (const ranged of posturePools[1]) {
        for (const assault of posturePools[2]) {
          const candidates = [balanced, ranged, assault];
          const simulationFingerprints = candidates.map((candidate) =>
            rosterSimulationFingerprint(candidate.roster),
          );
          if (new Set(simulationFingerprints).size !== candidates.length) {
            continue;
          }
          const densityOrder = candidates
            .map((candidate, index) => ({
              candidate,
              index,
              fingerprint: simulationFingerprints[index],
            }))
            .sort(
              (left, right) =>
                left.candidate.traits.modelCount -
                  right.candidate.traits.modelCount ||
                left.fingerprint.localeCompare(right.fingerprint),
            );
          const desiredByDensity: TesseraStressComposition[] = [
            "elite-heavy",
            "mixed",
            "mass",
          ];
          const compositions = Array<TesseraStressComposition>(3);
          for (const [densityIndex, entry] of densityOrder.entries()) {
            compositions[entry.index] = preferredComposition(
              entry.candidate,
              POSTURES[entry.index],
              desiredByDensity[densityIndex],
            );
          }
          const modelCounts = densityOrder.map(
            (entry) => entry.candidate.traits.modelCount,
          );
          const pairwiseDistances = [
            rosterSimulationDistance(
              candidates[0].roster,
              candidates[1].roster,
            ),
            rosterSimulationDistance(
              candidates[0].roster,
              candidates[2].roster,
            ),
            rosterSimulationDistance(
              candidates[1].roster,
              candidates[2].roster,
            ),
          ];
          const postureFits = candidates.map((candidate, index) =>
            postureFit(candidate.roster, POSTURES[index]),
          );
          const selection: Selection = {
            candidates,
            compositions,
            minimumPostureFit: Math.min(...postureFits),
            postureFit: postureFits.reduce(
              (sum, value) => sum + value,
              0,
            ),
            modelSpan: modelCounts[2] - modelCounts[0],
            minimumModelGap: Math.min(
              modelCounts[1] - modelCounts[0],
              modelCounts[2] - modelCounts[1],
            ),
            compositionCoverage: new Set(compositions).size,
            minimumStructuralDistance: Math.min(...pairwiseDistances),
            fit: candidates.reduce(
              (sum, candidate, index) =>
                sum +
                templateFit(
                  candidate.roster,
                  POSTURES[index],
                  compositions[index],
                ),
              0,
            ),
            pointsUtilization: candidates.reduce(
              (sum, candidate) =>
                sum + candidate.traits.pointsUtilization,
              0,
            ),
            fingerprint: simulationFingerprints.join(":"),
          };
          if (isBetterSelection(selection, best)) best = selection;
        }
      }
    }
  }

  if (best) {
    return best.candidates.map((candidate, index) => {
      const otherCandidates = best!.candidates.filter(
        (_, otherIndex) => otherIndex !== index,
      );
      return readyItem(
        POSTURES[index],
        best!.compositions[index],
        candidate,
        Math.min(
          ...otherCandidates.map((other) =>
            rosterSimulationDistance(candidate.roster, other.roster),
          ),
        ),
      );
    });
  }

  const selected: TesseraStressPortfolioItem[] = [];
  const selectedFingerprints = new Set<string>();
  const desiredByPosture: TesseraStressComposition[] = [
    "elite-heavy",
    "mixed",
    "mass",
  ];
  for (const [postureIndex, posture] of POSTURES.entries()) {
    const candidates = (pools.get(posture) ?? [])
      .filter(
        (candidate) =>
          !selectedFingerprints.has(
            rosterSimulationFingerprint(candidate.roster),
          ),
      )
      .sort(
        (left, right) =>
          (postureIndex === 0
            ? left.traits.modelCount - right.traits.modelCount
            : postureIndex === POSTURES.length - 1
              ? right.traits.modelCount - left.traits.modelCount
              : Math.abs(left.traits.modelCount - 30) -
                Math.abs(right.traits.modelCount - 30)) ||
          rosterSimulationFingerprint(left.roster).localeCompare(
            rosterSimulationFingerprint(right.roster),
          ),
      );
    const candidate = candidates[0];
    if (!candidate) {
      selected.push(
        unavailableItem(
          posture,
          desiredByPosture[postureIndex],
          `No unique legal and New Recruit-exportable ${posture} proxy was available.`,
        ),
      );
      continue;
    }
    selectedFingerprints.add(
      rosterSimulationFingerprint(candidate.roster),
    );
    const composition = preferredComposition(
      candidate,
      posture,
      desiredByPosture[postureIndex],
    );
    const priorRosters = selected
      .filter(
        (
          item,
        ): item is TesseraStressPortfolioItem & {
          roster: RosterDraftV1;
        } => item.status === "ready" && item.roster !== null,
      )
      .map((item) => item.roster);
    selected.push(
      readyItem(
        posture,
        composition,
        candidate,
        priorRosters.length === 0
          ? 1
          : Math.min(
              ...priorRosters.map((roster) =>
                rosterSimulationDistance(candidate.roster, roster),
              ),
            ),
      ),
    );
  }
  return selected;
}

type DiversePortfolioCell = {
  templateId: string;
  posture: TesseraArchetype;
  composition: TesseraStressComposition;
  lens: AdaptiveDensityLens;
  options: Array<{
    candidate: StressCandidate;
    baseScore: number;
  }>;
};

function diverseCellReviewStatus(
  factionId: string,
  templateId: string,
  sourceReleaseId: string,
): "unreviewed" | "reviewed-not-applicable" {
  const reviewed = REVIEWED_NOT_APPLICABLE_DIVERSE_CELLS[factionId];
  return reviewed?.sourceReleaseId === sourceReleaseId &&
    reviewed.reviewedNotApplicableTemplateIds.includes(templateId)
    ? "reviewed-not-applicable"
    : "unreviewed";
}

function selectDiversePortfolio(
  factionId: string,
  factionName: string,
  sourceReleaseId: string,
  pools: Map<TesseraArchetype, StressCandidate[]>,
): TesseraStressPortfolioItem[] {
  const canonicalCells: DiversePortfolioCell[] = POSTURES.flatMap(
    (posture) => {
      const lens = adaptiveDensityLens(pools.get(posture) ?? []);
      return COMPOSITIONS.map((composition) => ({
        templateId: `${posture}:${composition}`,
        posture,
        composition,
        lens,
        options: lens.candidates
          .filter((candidate) =>
            adaptiveCompositionEligible(
              candidate,
              composition,
              lens,
            ),
          )
          .map((candidate) => ({
            candidate,
            baseScore:
              adaptiveCompositionFit(
                candidate,
                composition,
                lens,
              ) *
                0.65 +
              postureFit(candidate.roster, posture) * 0.25 +
              candidate.traits.pointsUtilization * 0.1,
          }))
          .sort(
            (left, right) =>
              right.baseScore - left.baseScore ||
              rosterSimulationFingerprint(
                left.candidate.roster,
              ).localeCompare(
                rosterSimulationFingerprint(
                  right.candidate.roster,
                ),
              ),
          ),
      }));
    },
  );
  const searchCells = [...canonicalCells].sort(
    (left, right) =>
      left.options.length - right.options.length ||
      POSTURES.indexOf(left.posture) -
        POSTURES.indexOf(right.posture) ||
      COMPOSITIONS.indexOf(left.composition) -
        COMPOSITIONS.indexOf(right.composition),
  );
  const chosen = new Map<
    string,
    DiversePortfolioCell["options"][number]
  >();
  const used = new Set<string>();
  let best = new Map(chosen);
  let bestScore = Number.NEGATIVE_INFINITY;
  let visits = 0;
  const visitLimit = 250_000;

  const search = (
    index: number,
    score: number,
  ): boolean => {
    visits += 1;
    if (visits > visitLimit) return false;
    if (
      chosen.size > best.size ||
      (chosen.size === best.size && score > bestScore)
    ) {
      best = new Map(chosen);
      bestScore = score;
    }
    if (chosen.size === canonicalCells.length) return true;
    if (index >= searchCells.length) return false;
    if (
      chosen.size + (searchCells.length - index) <
      best.size
    ) {
      return false;
    }

    const cell = searchCells[index];
    const chosenRosters = [...chosen.values()].map(
      (entry) => entry.candidate.roster,
    );
    const ranked = cell.options
      .filter(
        (option) =>
          !used.has(
            rosterSimulationFingerprint(
              option.candidate.roster,
            ),
          ),
      )
      .map((option) => {
        const minimumDistance =
          chosenRosters.length === 0
            ? 1
            : Math.min(
                ...chosenRosters.map((roster) =>
                  rosterSimulationDistance(
                    option.candidate.roster,
                    roster,
                  ),
                ),
              );
        return {
          ...option,
          score: option.baseScore + minimumDistance * 0.35,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          rosterSimulationFingerprint(
            left.candidate.roster,
          ).localeCompare(
            rosterSimulationFingerprint(
              right.candidate.roster,
            ),
          ),
      );
    for (const option of ranked) {
      const fingerprint = rosterSimulationFingerprint(
        option.candidate.roster,
      );
      chosen.set(cell.templateId, option);
      used.add(fingerprint);
      if (search(index + 1, score + option.score)) return true;
      used.delete(fingerprint);
      chosen.delete(cell.templateId);
    }

    // Retain the best truthful partial portfolio when this cell cannot be
    // filled. The missing cell remains explicitly unreviewed unless a faction
    // contract says otherwise.
    return search(index + 1, score);
  };

  search(0, 0);
  if (best.size < canonicalCells.length) {
    // The score-oriented search above is deliberately bounded. Complete the
    // cardinality proof with deterministic bipartite matching so a large
    // candidate pool cannot be mistaken for an impossible portfolio merely
    // because the scoring search exhausted its visit budget.
    const cellsByTemplateId = new Map(
      searchCells.map((cell) => [cell.templateId, cell]),
    );
    const matchedCellByFingerprint = new Map<string, string>();
    const matchedOptionByCell = new Map<
      string,
      DiversePortfolioCell["options"][number]
    >();
    const match = (
      cell: DiversePortfolioCell,
      visitedFingerprints: Set<string>,
    ): boolean => {
      for (const option of cell.options) {
        const fingerprint = rosterSimulationFingerprint(
          option.candidate.roster,
        );
        if (visitedFingerprints.has(fingerprint)) continue;
        visitedFingerprints.add(fingerprint);
        const occupiedCellId =
          matchedCellByFingerprint.get(fingerprint);
        const occupiedCell = occupiedCellId
          ? cellsByTemplateId.get(occupiedCellId)
          : undefined;
        if (
          occupiedCell &&
          !match(occupiedCell, visitedFingerprints)
        ) {
          continue;
        }
        matchedCellByFingerprint.set(
          fingerprint,
          cell.templateId,
        );
        matchedOptionByCell.set(cell.templateId, option);
        return true;
      }
      return false;
    };
    for (const cell of searchCells) {
      match(cell, new Set());
    }
    if (matchedOptionByCell.size > best.size) {
      best = matchedOptionByCell;
    }
  }
  const selectedRosters = [...best.values()].map(
    (entry) => entry.candidate.roster,
  );
  return canonicalCells.map((cell) => {
    const option = best.get(cell.templateId);
    if (!option) {
      return unavailableItem(
        cell.posture,
        cell.composition,
        `${factionName} produced ${cell.options.length} candidates for the adaptive ${cell.composition} density lens, but no unique execution payload could be retained for this cell.`,
        diverseCellReviewStatus(
          factionId,
          cell.templateId,
          sourceReleaseId,
        ),
      );
    }
    const otherRosters = selectedRosters.filter(
      (roster) =>
        rosterSimulationFingerprint(roster) !==
        rosterSimulationFingerprint(option.candidate.roster),
    );
    return readyItem(
      cell.posture,
      cell.composition,
      option.candidate,
      otherRosters.length === 0
        ? 1
        : Math.min(
            ...otherRosters.map((roster) =>
              rosterSimulationDistance(
                option.candidate.roster,
                roster,
              ),
            ),
          ),
      adaptiveCompositionEvidence(
        cell.composition,
        option.candidate,
        cell.lens,
      ),
    );
  });
}

function unavailableItem(
  posture: TesseraArchetype,
  composition: TesseraStressComposition,
  reason: string,
  reviewStatus: "unreviewed" | "reviewed-not-applicable" =
    "unreviewed",
): TesseraStressPortfolioItem {
  const reviewMessage =
    reviewStatus === "reviewed-not-applicable"
      ? "This missing cell is explicitly reviewed and not applicable."
      : "This missing cell is not covered by a reviewed faction exception.";
  return {
    templateId: `${posture}:${composition}`,
    posture,
    composition,
    status: "unavailable",
    roster: null,
    fingerprint: null,
    simulationFingerprint: null,
    structuralDistance: null,
    detachmentId: null,
    allowNamedCharacters: null,
    traits: null,
    compositionEvidence: [],
    containsNamedCharacter: null,
    omissionReason: reason,
    warnings: [
      issue(
        reviewStatus === "reviewed-not-applicable"
          ? "STRESS_TEMPLATE_NOT_APPLICABLE"
          : "STRESS_TEMPLATE_UNREVIEWED",
        `[${posture}:${composition}] ${reason} ${reviewMessage}`,
        "warn",
      ),
    ],
  };
}

export function generateFactionStressPortfolio(
  input: GenerateFactionStressPortfolioInput,
): ResultEnvelope<TesseraStressPortfolio> {
  const pointsLimit = Math.max(100, Math.min(input.pointsLimit, 5000));
  const suite = input.suite ?? "diverse-9";
  const pointsTolerancePercent = Math.max(
    0,
    Math.min(input.pointsTolerancePercent ?? 5, 100),
  );
  const seed = buildRoster({
    faction: input.faction,
    pointsLimit,
    name: "RosterPilot stress portfolio seed",
    allowLegends: input.allowLegends ?? false,
  });
  if (!seed.data) {
    return {
      ok: false,
      data: null,
      violations: seed.violations,
      warnings: seed.warnings,
    };
  }

  const factionId = seed.data.factionId;
  const factionName = seed.data.factionName;
  const capability = getNewRecruitCapability(factionId);
  if (!capability.available) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "STRESS_NEW_RECRUIT_UNAVAILABLE",
          `${factionName} cannot be used for a Tessera stress portfolio because its New Recruit mapping is unavailable. ${capability.reason ?? ""}`.trim(),
        ),
      ],
      warnings: seed.warnings,
    };
  }
  const knownBlocked = knownBlockedUnitIds(factionId);
  const legalNamedAnchorExists = factionHasLegalNamedAnchor(
    factionId,
    pointsLimit,
  );
  const namedAnchorIds = [
    ...new Map(
      ["epic hero", "named character"]
        .flatMap(
          (query) =>
            searchUnits({
              faction: factionId,
              query,
              includeLegends: input.allowLegends ?? false,
              limit: 100,
            }).data ?? [],
        )
        .filter(
          (unit) =>
            unit.isNamedCharacter &&
            unit.pointsFrom <= pointsLimit,
        )
        .map((unit) => [unit.id, unit] as const),
    ).values(),
  ]
    .map((unit) => unit.id)
    .sort();
  const candidatePools = new Map<
    TesseraArchetype,
    StressCandidate[]
  >();
  for (const posture of POSTURES) {
    candidatePools.set(
      posture,
      candidateRosterPool(
        factionId,
        factionName,
        pointsLimit,
        posture,
        input.allowLegends ?? false,
        pointsTolerancePercent,
        knownBlocked,
      ),
    );
  }
  const namedSpecialistCandidate =
    legalNamedAnchorExists
      ? namedCharacterSpecialistCandidate(
          factionId,
          factionName,
          pointsLimit,
          input.allowLegends ?? false,
          pointsTolerancePercent,
          knownBlocked,
          namedAnchorIds,
        )
      : null;
  const includeNamedSpecialist = () => {
    if (suite !== "diverse-9" || !namedSpecialistCandidate) return;
    const namedFingerprint = rosterSimulationFingerprint(
      namedSpecialistCandidate.roster,
    );
    for (const posture of POSTURES) {
      const pool = candidatePools.get(posture) ?? [];
      if (
        pool.some(
          (candidate) =>
            rosterSimulationFingerprint(candidate.roster) ===
            namedFingerprint,
        )
      ) {
        continue;
      }
      candidatePools.set(posture, [
        ...pool,
        namedSpecialistCandidate,
      ]);
    }
  };

  let selected: TesseraStressPortfolioItem[] =
    suite === "core-3"
      ? selectCorePortfolio(candidatePools)
      : selectDiversePortfolio(
          factionId,
          factionName,
          seed.data.sourceData.releaseId,
          candidatePools,
        );
  if (
    suite === "diverse-9" &&
    selected.some((item) => item.status === "unavailable")
  ) {
    // A globally unique nine-cell assignment can move a scarce candidate
    // from one posture to another. Expand every posture together so the
    // second assignment is not constrained by whichever cells happened to
    // be missing from the first pass.
    for (const posture of POSTURES) {
      candidatePools.set(
        posture,
        candidateRosterPool(
          factionId,
          factionName,
          pointsLimit,
          posture,
          input.allowLegends ?? false,
          pointsTolerancePercent,
          knownBlocked,
          true,
        ),
      );
    }
    includeNamedSpecialist();
    selected = selectDiversePortfolio(
      factionId,
      factionName,
      seed.data.sourceData.releaseId,
      candidatePools,
    );
  }

  const readyItems = selected.filter((item) => item.status === "ready");
  const selectedNamedAnchor = readyItems.some(
    (item) => item.containsNamedCharacter === true,
  );
  let namedCharacterCoverageStatus:
    TesseraNamedCharacterCoverageStatus;
  let namedCharacterCoverageReason: string | null;
  if (selectedNamedAnchor) {
    namedCharacterCoverageStatus = "included";
    namedCharacterCoverageReason = null;
  } else if (namedSpecialistCandidate) {
    namedCharacterCoverageStatus = "buildable-not-simulated";
    namedCharacterCoverageReason =
      `${factionName} produced a legal, New Recruit-exportable named-character specialist, but that roster is capability evidence only and is not one of the simulated ${suite} portfolio payloads.`;
  } else if (!legalNamedAnchorExists) {
    namedCharacterCoverageStatus = "not-applicable";
    namedCharacterCoverageReason =
      `${factionName} has no legal named-character anchor within the ${pointsLimit}-point limit under the pinned source data.`;
  } else {
    namedCharacterCoverageStatus =
      "unavailable-after-evaluation";
    namedCharacterCoverageReason =
      `${factionName} has legal named-character anchors, but none of the ${namedAnchorIds.length} evaluated anchors produced a legal, New Recruit-exportable specialist proxy within ${pointsTolerancePercent}% of ${pointsLimit} points. This does not reduce core-3 posture coverage.`;
  }
  const representedPostures = POSTURES.filter((posture) =>
    readyItems.some((item) => item.posture === posture),
  );
  const requestedCompositions =
    suite === "diverse-9"
      ? COMPOSITIONS
      : [];
  const representedCompositions = COMPOSITIONS.filter((composition) =>
    readyItems.some((item) => item.composition === composition),
  );
  const missingPostures = POSTURES.filter(
    (posture) => !representedPostures.includes(posture),
  );
  const missingCompositions = requestedCompositions.filter(
    (composition) => !representedCompositions.includes(composition),
  );
  const representedCells = readyItems.map((item) => ({
    templateId: item.templateId,
    posture: item.posture,
    composition: item.composition,
  }));
  const missingCells = selected
    .filter((item) => item.status === "unavailable")
    .map((item) => ({
      templateId: item.templateId,
      posture: item.posture,
      composition: item.composition,
      reason:
        item.omissionReason ??
        "The intended portfolio cell is unavailable.",
    }));
  const uniqueSimulationPayloads = new Set(
    readyItems
      .map((item) => item.simulationFingerprint)
      .filter(Boolean),
  ).size;
  const portfolio: TesseraStressPortfolio = {
    schemaVersion: 1,
    generatorVersion: TESSERA_STRESS_GENERATOR_VERSION,
    contract:
      suite === "diverse-9"
        ? expectedDiversePortfolioContract(
            factionId,
            seed.data.sourceData.releaseId,
            threatLensDefinition(candidatePools),
          )
        : undefined,
    suite,
    factionId,
    factionName,
    pointsLimit,
    pointsTolerancePercent,
    sourceData: seed.data.sourceData,
    items: selected,
    coverage: {
      intended: selected.length,
      ready: readyItems.length,
      unavailable: selected.length - readyItems.length,
      representedPostures,
      missingPostures,
      representedCompositions,
      missingCompositions,
      representedCells,
      missingCells,
      uniqueSimulationPayloads,
      namedCharacterCoverage:
        namedCharacterCoverageStatus === "included" ||
        namedCharacterCoverageStatus === "not-applicable",
      namedCharacterCoverageStatus,
      namedCharacterCoverageReason,
      namedCharacterSpecialistStructuralFingerprint:
        namedSpecialistCandidate
          ? rosterStructuralFingerprint(
              namedSpecialistCandidate.roster,
            )
          : null,
      namedCharacterSpecialistSimulationFingerprint:
        namedSpecialistCandidate
          ? rosterSimulationFingerprint(
              namedSpecialistCandidate.roster,
            )
          : null,
      maximumResultStatus:
        (
          uniqueSimulationPayloads < selected.length ||
          missingPostures.length > 0 ||
          (
            suite === "diverse-9" &&
            missingCompositions.length > 0
          ) ||
          missingCells.length > 0
        )
          ? "degraded"
          : "complete",
    },
  };
  const warnings = selected.flatMap((item) => item.warnings);
  return {
    ok: readyItems.length > 0,
    data: portfolio,
    violations:
      readyItems.length === 0
        ? [
            issue(
              "STRESS_PORTFOLIO_EMPTY",
              `${factionName} did not produce any usable stress-test proxies.`,
            ),
          ]
        : [],
    warnings,
  };
}

export async function previewFactionStressPortfolio(
  input: GenerateFactionStressPortfolioInput,
): Promise<ResultEnvelope<TesseraStressPortfolioPreview>> {
  const generated = generateFactionStressPortfolio(input);
  if (!generated.ok || !generated.data) {
    return {
      ok: false,
      data: null,
      violations: generated.violations,
      warnings: generated.warnings,
    };
  }
  const ready = generated.data.items.filter(
    (
      item,
    ): item is TesseraStressPortfolioItem & {
      roster: RosterDraftV1;
    } => item.status === "ready" && item.roster !== null,
  );
  const previewItems: TesseraStressPortfolioPreview["items"] = [];
  for (const item of generated.data.items) {
    if (!item.roster || item.status !== "ready") {
      previewItems.push({
        templateId: item.templateId,
        structuralFingerprint: null,
        simulationFingerprint: null,
        minimumPairwiseDiversity: null,
        compositionEvidence: item.compositionEvidence,
        profileRequirements: [],
        containsNamedCharacter: item.containsNamedCharacter,
        exportable: false,
        exportError: item.omissionReason,
      });
      continue;
    }
    const others = ready.filter(
      (candidate) => candidate.templateId !== item.templateId,
    );
    const exported = await exportRoster(item.roster, "rosz");
    previewItems.push({
      templateId: item.templateId,
      structuralFingerprint: rosterStructuralFingerprint(item.roster),
      simulationFingerprint: rosterSimulationFingerprint(item.roster),
      minimumPairwiseDiversity:
        others.length === 0
          ? null
          : Math.min(
              ...others.map((candidate) =>
                rosterSimulationDistance(item.roster!, candidate.roster),
              ),
            ),
      compositionEvidence: item.compositionEvidence,
      profileRequirements: rosterProfileRequirements(item.roster),
      containsNamedCharacter: rosterHasNamedCharacter(item.roster),
      exportable: exported.ok && exported.data !== null,
      exportError:
        exported.ok && exported.data
          ? null
          : exported.violations[0]?.message ??
            "New Recruit export failed.",
    });
  }
  const exportableTemplateIds = new Set(
    previewItems
      .filter((item) => item.exportable)
      .map((item) => item.templateId),
  );
  const contract = evaluateTesseraStressPortfolioContract(
    generated.data,
    { usableTemplateIds: exportableTemplateIds },
  );
  const namedCharacterCoverage =
    generated.data.coverage.namedCharacterCoverage;
  const namedCharacterCoverageStatus =
    generated.data.coverage.namedCharacterCoverageStatus;
  const exportable = previewItems.filter((item) => item.exportable).length;
  generated.data.coverage.uniqueSimulationPayloads =
    contract.uniqueSimulationPayloads;
  generated.data.coverage.maximumResultStatus =
    contract.maximumResultStatus ?? "degraded";
  return {
    ok: contract.accepted,
    data: {
      schemaVersion: 1,
      previewKind: "tessera-stress-portfolio",
      generatedAt: new Date().toISOString(),
      portfolio: generated.data,
      items: previewItems,
      gates: {
        minimumUniqueRequired:
          contract.minimumUniqueRequired,
        uniqueSimulationPayloads:
          contract.uniqueSimulationPayloads,
        executionViable: contract.executionViable,
        completeCoverage: contract.completeCoverage,
        allPosturesRepresented:
          contract.allPosturesRepresented,
        representedPostures: contract.representedPostures,
        missingPostures: contract.missingPostures,
        representedCompositions:
          generated.data.coverage.representedCompositions,
        missingCompositions:
          generated.data.coverage.missingCompositions,
        representedCells:
          generated.data.coverage.representedCells,
        missingCells: generated.data.coverage.missingCells,
        namedCharacterCoverage,
        namedCharacterCoverageStatus,
        namedCharacterCoverageReason:
          generated.data.coverage.namedCharacterCoverageReason,
        namedCharacterSpecialistStructuralFingerprint:
          generated.data.coverage
            .namedCharacterSpecialistStructuralFingerprint,
        namedCharacterSpecialistSimulationFingerprint:
          generated.data.coverage
            .namedCharacterSpecialistSimulationFingerprint,
        maximumResultStatus:
          generated.data.coverage.maximumResultStatus,
        exportable,
        accepted: contract.accepted,
      },
      warnings: generated.warnings.map((warning) => warning.message),
    },
    violations: contract.accepted
      ? []
      : [contract.violation!],
    warnings: generated.warnings,
  };
}
