import {
  buildRoster,
  exportRoster,
  factionHasLegalNamedAnchor,
  listDetachments,
  rosterHasNamedCharacter,
  rosterProfileRequirements,
  namedAnchorCollectionVariants,
  validateRoster,
} from "./engine";
import { getNewRecruitFactionCatalogue } from "./catalogue";
import {
  conflictsForRoster,
  getNewRecruitCapability,
  newRecruitCatalogue,
} from "./catalogue-summary";
import { newRecruitRos } from "./new-recruit";
import { resolveNewRecruitUnit } from "./new-recruit-resolver";
import type {
  GenerateFactionStressPortfolioInput,
  PreferenceTag,
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
  TesseraArchetype,
  TesseraStressComposition,
  TesseraStressPortfolio,
  TesseraStressPortfolioItem,
  TesseraStressPortfolioTraits,
  TesseraStressPortfolioPreview,
} from "./types";

export const TESSERA_STRESS_GENERATOR_VERSION = "faction-stress-v1";

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
      (
        unit.tags.includes("elite") &&
        unit.modelCount <= 3 &&
        unit.points >= 100
      )
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
  return (
    traits.eliteHeavyPointsPercent >= 0.45 &&
    traits.modelCount <= 18
  );
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
      (selection.isWarlord && !mapping.warlord) ||
      (selection.enhancementId &&
        !mapping.enhancements[selection.enhancementId]) ||
      (mapping &&
        !resolveNewRecruitUnit(mapping, selection).ok) ||
      blockingConflicts.some(
        (conflict) =>
          conflict.entityId === selection.unitId ||
          conflict.entityId.startsWith(`${selection.unitId}:`),
      )
    ) {
      blocked.add(selection.unitId);
    }
  }
  return [...blocked];
}

function knownBlockedUnitIds(factionId: string): Set<string> {
  const blocked = new Set<string>();
  const mapping = getNewRecruitFactionCatalogue(factionId);
  const unitIds = Object.keys(mapping?.units ?? {});
  const conflicts =
    newRecruitCatalogue.factions[factionId]?.conflicts ?? [];
  for (const conflict of conflicts) {
    if (
      !conflict.blocking ||
      !["unit", "points", "equipment"].includes(conflict.entityType)
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
  const factionSeed = buildRoster(input);
  const factionId = factionSeed.data?.factionId;
  if (!factionId) return null;
  const catalogue = getNewRecruitFactionCatalogue(factionId);
  if (!catalogue) return null;
  const allowed = new Set(
    Object.keys(catalogue.units).filter(
      (unitId) => !knownBlocked.has(unitId),
    ),
  );
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const built = buildRoster({
      ...input,
      collectionUnitIds: [...allowed].sort(),
    });
    if (!built.ok || !built.data) return null;
    try {
      newRecruitRos(built.data);
      return built.data;
    } catch {
      const blocked = unexportableUnitIds(built.data);
      const changed = blocked.some((unitId) => {
        knownBlocked.add(unitId);
        return allowed.delete(unitId);
      });
      if (!changed) return null;
    }
  }
  return null;
}

function candidateRosters(
  factionId: string,
  factionName: string,
  pointsLimit: number,
  posture: TesseraArchetype,
  composition: TesseraStressComposition,
  allowLegends: boolean,
  pointsTolerancePercent: number,
  knownBlocked: Set<string>,
): Array<{
  roster: RosterDraftV1;
  traits: TesseraStressPortfolioTraits;
  fit: number;
}> {
  const results = new Map<
    string,
    {
      roster: RosterDraftV1;
      traits: TesseraStressPortfolioTraits;
      fit: number;
    }
  >();
  const detachments = listDetachments(factionId).sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.name.localeCompare(right.name),
  ).slice(0, 2);
  const preferencesList = preferenceVariants(posture, composition);
  candidateSearch: for (const [detachmentIndex, detachment] of detachments.entries()) {
    const namedOptions =
      posture === "balanced-control" && composition === "mixed"
        ? [true, false]
        : [false, true];
    for (const allowNamedCharacters of namedOptions) {
      for (const [preferenceIndex, preferences] of preferencesList.entries()) {
        const namedCollections =
          allowNamedCharacters &&
          posture === "balanced-control" &&
          composition === "mixed" &&
          detachmentIndex === 0 &&
          preferenceIndex === 0
            ? namedAnchorCollectionVariants(factionId, pointsLimit).slice(0, 1)
            : [];
        const collectionVariants = [
          undefined,
          ...namedCollections,
        ];
        for (const collectionUnitIds of collectionVariants) {
          const roster = buildExportableRoster(
            {
              faction: factionId,
              pointsLimit,
              name: `${factionName} ${posture} ${composition}`,
              preferences,
              allowNamedCharacters,
              allowLegends,
              detachmentId: detachment.id,
              collectionUnitIds,
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
          if (!compositionSatisfied(composition, traits)) continue;
          const fingerprint = rosterSimulationFingerprint(roster);
          const candidate = {
            roster,
            traits,
            fit: templateFit(roster, posture, composition),
          };
          const current = results.get(fingerprint);
          if (
            !current ||
            candidate.fit > current.fit ||
            (candidate.fit === current.fit &&
              candidate.roster.name.localeCompare(current.roster.name) < 0)
          ) {
            results.set(fingerprint, candidate);
          }
          if (results.size >= 8) break candidateSearch;
        }
      }
    }
  }
  return [...results.values()]
    .sort(
      (left, right) =>
        right.fit - left.fit ||
        right.traits.pointsUtilization -
          left.traits.pointsUtilization ||
        rosterStructuralFingerprint(left.roster).localeCompare(
          rosterStructuralFingerprint(right.roster),
        ),
    )
    .slice(0, 12);
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
  const compositions =
    suite === "core-3"
      ? (["mixed"] satisfies TesseraStressComposition[])
      : COMPOSITIONS;
  const selected: TesseraStressPortfolioItem[] = [];
  const knownBlocked = knownBlockedUnitIds(factionId);

  for (const posture of POSTURES) {
    for (const composition of compositions) {
      const candidates = candidateRosters(
        factionId,
        factionName,
        pointsLimit,
        posture,
        composition,
        input.allowLegends ?? false,
        pointsTolerancePercent,
        knownBlocked,
      );
      if (candidates.length === 0) {
        const threshold =
          composition === "mass"
            ? "25% of points and 40% of models in horde-tagged units, with elite anchors capped at 55%"
            : composition === "elite-heavy"
              ? "45% of points in elite, Vehicle, or Monster units and no more than 18 models"
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
        alreadySelectedItems.map((item) => item.simulationFingerprint),
      );
      const distinctCandidates = candidates.filter(
        (candidate) =>
          !selectedFingerprints.has(
            rosterSimulationFingerprint(candidate.roster),
          ),
      );
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
                    rosterStructuralDistance(candidate.roster, roster),
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
      const templateId = `${posture}:${composition}`;
      selected.push({
        templateId,
        posture,
        composition,
        status: "ready",
        roster: chosen.roster,
        fingerprint: rosterStructuralFingerprint(chosen.roster),
        simulationFingerprint:
          rosterSimulationFingerprint(chosen.roster),
        structuralDistance: chosen.minimumDistance,
        detachmentId: chosen.roster.detachmentId,
        allowNamedCharacters:
          chosen.roster.constraints.allowNamedCharacters,
        traits: chosen.traits,
        compositionEvidence: compositionEvidence(
          composition,
          chosen.traits,
        ),
        containsNamedCharacter:
          rosterHasNamedCharacter(chosen.roster),
        omissionReason: null,
        warnings: validateRoster(chosen.roster).warnings.map(
          (warning) => ({
            ...warning,
            message: `[${templateId}] ${warning.message}`,
          }),
        ),
      });
    }
  }

  const readyItems = selected.filter((item) => item.status === "ready");
  const selectedNamedAnchor = readyItems.some(
    (item) => item.containsNamedCharacter === true,
  );
  const namedAnchorCandidates = namedAnchorCollectionVariants(
    factionId,
    pointsLimit,
  );
  if (
    !selectedNamedAnchor &&
    namedAnchorCandidates.length > 0 &&
    readyItems[0]
  ) {
    readyItems[0].warnings.push(
      issue(
        "STRESS_NAMED_ANCHOR_UNAVAILABLE",
        `[${readyItems[0].templateId}] ${factionName} named anchors were deliberately evaluated, but none produced a distinct legal New Recruit-exportable proxy under the frozen composition and points gates.`,
        "warn",
      ),
    );
  }
  const representedPostures = POSTURES.filter((posture) =>
    readyItems.some((item) => item.posture === posture),
  );
  const representedCompositions = COMPOSITIONS.filter((composition) =>
    readyItems.some((item) => item.composition === composition),
  );
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
      representedCompositions,
      uniqueSimulationPayloads: new Set(
        readyItems
          .map((item) => item.simulationFingerprint)
          .filter(Boolean),
      ).size,
      namedCharacterCoverage:
        selectedNamedAnchor ||
        namedAnchorCandidates.length === 0 ||
        !factionHasLegalNamedAnchor(
          factionId,
          pointsLimit,
          knownBlocked,
        ) ||
        readyItems.some((item) =>
          item.warnings.some(
            (warning) =>
              warning.code === "STRESS_NAMED_ANCHOR_UNAVAILABLE",
          ),
        ),
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
  const minimumUniqueRequired =
    generated.data.suite === "diverse-9" ? 6 : 3;
  const uniqueSimulationPayloads = new Set(
    previewItems
      .map((item) => item.simulationFingerprint)
      .filter((value): value is string => value !== null),
  ).size;
  const allPosturesRepresented =
    generated.data.coverage.representedPostures.length === 3;
  const namedCharacterCoverage =
    generated.data.coverage.namedCharacterCoverage;
  const exportable = previewItems.filter((item) => item.exportable).length;
  const accepted =
    uniqueSimulationPayloads >= minimumUniqueRequired &&
    allPosturesRepresented &&
    namedCharacterCoverage &&
    exportable >= minimumUniqueRequired;
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
        allPosturesRepresented,
        namedCharacterCoverage,
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
            `The portfolio has ${uniqueSimulationPayloads} unique payloads, ${exportable} exportable proxies, posture coverage=${allPosturesRepresented}, named-character coverage=${namedCharacterCoverage}.`,
          ),
        ],
    warnings: generated.warnings,
  };
}
