import {
  buildRoster,
  exportRoster,
  factionHasLegalNamedAnchor,
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

export const TESSERA_STRESS_GENERATOR_VERSION = "faction-stress-v4";

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
  for (const unit of roster.units) {
    modelCount += unit.modelCount;
    for (const tag of unit.tags) {
      tagCounts[tag] += 1;
    }
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
  return {
    modelCount,
    unitCount: roster.units.length,
    roleCount: new Set(roster.units.map((unit) => unit.role)).size,
    pointsUtilization: roster.totalPoints / Math.max(1, roster.pointsLimit),
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
  return templateFit(roster, posture, "mixed");
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
): StressCandidate[] {
  const factionUnits = searchUnits({
    faction: factionId,
    includeLegends: allowLegends,
    limit: 100,
  }).data ?? [];
  const characterIds = factionUnits
    .filter((unit) => unit.role === "Character")
    .map((unit) => unit.id);
  const results = new Map<string, StressCandidate>();
  const detachments = listDetachments(factionId).sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.name.localeCompare(right.name),
  );
  if (detachments.length === 0) return [];

  type Recipe = {
    composition: TesseraStressComposition;
    preferences: PreferenceTag[];
    collectionUnitIds: string[] | undefined;
    requiredUnitIds?: string[];
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
        .slice(0, 12)
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
  const scheduledRecipes = [...forcedRecipes, ...recipes];
  const initialAttemptBudget = Math.min(
    scheduledRecipes.length,
    Math.max(12, Math.min(16, detachments.length)),
  );
  const hardAttemptBudget = Math.min(
    scheduledRecipes.length,
    Math.max(initialAttemptBudget, Math.min(18, detachments.length * 2)),
  );

  for (
    let attempt = 0;
    attempt < hardAttemptBudget;
    attempt += 1
  ) {
    if (
      attempt >= initialAttemptBudget &&
      results.size >= 6
    ) {
      break;
    }
    const recipe = scheduledRecipes[attempt];
    const detachment = detachments[attempt % detachments.length];
    const roster = buildExportableRoster(
      {
        faction: factionId,
        pointsLimit,
        name: `${factionName} ${posture} candidate ${attempt + 1}`,
        preferences: recipe.preferences,
        allowNamedCharacters: false,
        allowLegends,
        detachmentId: detachment.id,
        collectionUnitIds: recipe.collectionUnitIds,
        requiredUnitIds: recipe.requiredUnitIds,
      },
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
    if (
      !COMPOSITIONS.some((composition) =>
        compositionSatisfied(composition, traits),
      )
    ) {
      continue;
    }
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
    compositionEvidence: compositionEvidence(
      composition,
      candidate.traits,
    ),
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
            rosterStructuralDistance(
              candidates[0].roster,
              candidates[1].roster,
            ),
            rosterStructuralDistance(
              candidates[0].roster,
              candidates[2].roster,
            ),
            rosterStructuralDistance(
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
            rosterStructuralDistance(candidate.roster, other.roster),
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
                rosterStructuralDistance(candidate.roster, roster),
              ),
            ),
      ),
    );
  }
  return selected;
}

function unavailableItem(
  posture: TesseraArchetype,
  composition: TesseraStressComposition,
  reason: string,
): TesseraStressPortfolioItem {
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
        "STRESS_TEMPLATE_UNAVAILABLE",
        `[${posture}:${composition}] ${reason}`,
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

  const selected: TesseraStressPortfolioItem[] =
    suite === "core-3"
      ? selectCorePortfolio(candidatePools)
      : [];
  if (suite === "diverse-9") {
    for (const posture of POSTURES) {
      for (const composition of COMPOSITIONS) {
        const candidates = (candidatePools.get(posture) ?? [])
          .filter((candidate) =>
            compositionSatisfied(composition, candidate.traits),
          )
          .map((candidate) => ({
            ...candidate,
            fit: templateFit(
              candidate.roster,
              posture,
              composition,
            ),
          }));
        if (candidates.length === 0) {
          const threshold =
            composition === "mass"
              ? "25% of points and 40% of models in horde-tagged units, with elite anchors capped at 55%"
              : composition === "elite-heavy"
                ? "45% of points in elite-tagged, Vehicle, or Monster units"
                : "three represented roles with bounded mass and elite shares";
          selected.push(
            unavailableItem(
              posture,
              composition,
              `${factionName} could not produce a legal ${posture}/${composition} proxy satisfying ${threshold}.`,
            ),
          );
          continue;
        }

        const alreadySelectedItems = selected
        .filter(
          (
            item,
          ): item is TesseraStressPortfolioItem & {
            roster: RosterDraftV1;
          } => item.status === "ready" && item.roster !== null,
        );
        const alreadySelected = alreadySelectedItems.map(
          (item) => item.roster,
        );
        const selectedFingerprints = new Set(
          alreadySelectedItems.map(
            (item) => item.simulationFingerprint,
          ),
        );
        let distinctCandidates = candidates.filter(
          (candidate) =>
            !selectedFingerprints.has(
              rosterSimulationFingerprint(candidate.roster),
            ),
        );
        if (distinctCandidates.length === 0) {
          const exclusionCandidates = [
            ...new Set(
              alreadySelected
                .flatMap((roster) => roster.units)
                .sort(
                  (left, right) =>
                    right.points - left.points ||
                    left.unitId.localeCompare(right.unitId),
                )
                .map((unit) => unit.unitId),
            ),
          ];
          for (const excludedUnitId of exclusionCandidates.slice(0, 4)) {
            const roster = buildExportableRoster(
              {
                faction: factionId,
                pointsLimit,
                name: `${factionName} ${posture} ${composition}`,
                preferences: uniqueTags([
                  ...POSTURE_TAGS[posture],
                  ...COMPOSITION_TAGS[composition],
                ]),
                allowNamedCharacters: false,
                allowLegends: input.allowLegends ?? false,
                excludedUnitIds: [excludedUnitId],
              },
              knownBlocked,
            );
            if (!roster) continue;
            const pointDifference =
              Math.abs(pointsLimit - roster.totalPoints) /
              Math.max(1, pointsLimit);
            const traits = traitsFor(roster);
            if (
              pointDifference > pointsTolerancePercent / 100 ||
              !compositionSatisfied(composition, traits) ||
              selectedFingerprints.has(
                rosterSimulationFingerprint(roster),
              )
            ) {
              continue;
            }
            distinctCandidates = [
              {
                roster,
                traits,
                fit: templateFit(roster, posture, composition),
              },
            ];
            break;
          }
        }
        if (distinctCandidates.length === 0) {
          selected.push(
            unavailableItem(
              posture,
              composition,
              `${factionName} produced only roster structures already used by another stress-test template.`,
            ),
          );
          continue;
        }
        const ranked = distinctCandidates
          .map((candidate) => {
            const minimumDistance =
              alreadySelected.length === 0
                ? 1
                : Math.min(
                    ...alreadySelected.map((roster) =>
                      rosterStructuralDistance(
                        candidate.roster,
                        roster,
                      ),
                    ),
                  );
            return {
              ...candidate,
              minimumDistance,
              score:
                candidate.fit * 0.65 +
                candidate.traits.pointsUtilization * 0.1 +
                minimumDistance * 0.25 +
                (
                  !alreadySelectedItems.some(
                    (item) => item.containsNamedCharacter === true,
                  ) &&
                  rosterHasNamedCharacter(candidate.roster)
                    ? 10
                    : 0
                ),
            };
          })
          .sort(
            (left, right) =>
              right.score - left.score ||
              right.minimumDistance - left.minimumDistance ||
              rosterSimulationFingerprint(left.roster).localeCompare(
                rosterSimulationFingerprint(right.roster),
              ),
          );
        const chosen = ranked[0];
        selected.push(
          readyItem(
            posture,
            composition,
            chosen,
            chosen.minimumDistance,
          ),
        );
      }
    }
  }

  const readyItems = selected.filter((item) => item.status === "ready");
  const selectedNamedAnchor = Boolean(
    namedSpecialistCandidate,
  );
  let namedCharacterCoverageStatus:
    TesseraNamedCharacterCoverageStatus;
  let namedCharacterCoverageReason: string | null;
  if (selectedNamedAnchor) {
    namedCharacterCoverageStatus = "included";
    namedCharacterCoverageReason = null;
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
        namedCharacterCoverageStatus !==
        "unavailable-after-evaluation",
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
                rosterStructuralDistance(item.roster!, candidate.roster),
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
  const minimumUniqueRequired = 2;
  const completeUniqueRequired =
    generated.data.suite === "diverse-9" ? 9 : 3;
  const uniqueSimulationPayloads = new Set(
    previewItems
      .map((item) => item.simulationFingerprint)
      .filter((value): value is string => value !== null),
  ).size;
  const allPosturesRepresented =
    generated.data.coverage.missingPostures.length === 0;
  const namedCharacterCoverage =
    generated.data.coverage.namedCharacterCoverage;
  const namedCharacterCoverageStatus =
    generated.data.coverage.namedCharacterCoverageStatus;
  const exportable = previewItems.filter((item) => item.exportable).length;
  const executionViable =
    uniqueSimulationPayloads >= minimumUniqueRequired &&
    generated.data.coverage.representedPostures.length >= 2 &&
    exportable >= minimumUniqueRequired;
  const completeCoverage =
    uniqueSimulationPayloads >= completeUniqueRequired &&
    allPosturesRepresented &&
    generated.data.coverage.missingCells.length === 0 &&
    exportable >= completeUniqueRequired;
  const accepted = executionViable;
  return {
    ok: accepted,
    data: {
      schemaVersion: 1,
      previewKind: "tessera-stress-portfolio",
      generatedAt: new Date().toISOString(),
      portfolio: generated.data,
      items: previewItems,
      gates: {
        minimumUniqueRequired,
        uniqueSimulationPayloads,
        executionViable,
        completeCoverage,
        allPosturesRepresented,
        representedPostures:
          generated.data.coverage.representedPostures,
        missingPostures:
          generated.data.coverage.missingPostures,
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
        accepted,
      },
      warnings: generated.warnings.map((warning) => warning.message),
    },
    violations: accepted
      ? []
      : [
          issue(
            "STRESS_PORTFOLIO_PREVIEW_FAILED",
            `The portfolio has ${uniqueSimulationPayloads} unique payloads and ${exportable} exportable proxies; at least ${minimumUniqueRequired} distinct payloads across two postures are required to run a degraded test. Represented cells=${generated.data.coverage.representedCells.map((cell) => cell.templateId).join(", ") || "none"}, missing cells=${generated.data.coverage.missingCells.map((cell) => cell.templateId).join(", ") || "none"}, posture coverage=${allPosturesRepresented}, named-character status=${namedCharacterCoverageStatus}.`,
          ),
        ],
    warnings: generated.warnings,
  };
}
