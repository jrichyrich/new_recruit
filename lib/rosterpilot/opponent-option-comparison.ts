import crypto from "node:crypto";

import type {
  AlliedRule,
  UnitView,
} from "@alpaca-software/40kdc-data";

import { baselineDamageCells } from "./baseline-damage";
import {
  buildRoster,
  internalAllianceControlledUnitKeys,
  internalFactionUnitInventory,
  opponentRosterFingerprint,
  validateRoster,
} from "./engine";
import { analyzeMissionReadiness } from "./mission-readiness";
import {
  dataset,
  detachments,
  factions,
  units,
} from "./runtime-dataset";
import {
  inspectStressPortfolioTraits,
  rosterSimulationDistance,
  rosterSimulationFingerprint,
  rosterStructuralFingerprint,
} from "./stress-portfolio";
import { portfolioCapabilityHash } from "./portfolio-capability";
import type {
  BuildRosterInput,
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
  TesseraArchetype,
  TesseraMissionReadinessBand,
  TesseraStressComposition,
  UnitSummary,
} from "./types";

export type OpponentComparisonRoster = {
  templateId: string;
  roster: RosterDraftV1;
  posture?: TesseraArchetype;
  composition?: TesseraStressComposition;
};

export type OpponentOptionComparisonInput = {
  buildInput: BuildRosterInput;
  baselineRoster?: RosterDraftV1;
  opponents: OpponentComparisonRoster[];
  opponentPortfolioHash?: string | null;
  maximumBuilds?: number;
  maximumAlternatives?: number;
};

export type OpponentOptionCandidate = {
  roster: RosterDraftV1;
  structuralFingerprint: string;
  simulationFingerprint: string;
  anchorUnitIds: string[];
  source: "baseline" | "catalogue-anchor";
  pointsUtilization: number;
  readinessBand: TesseraMissionReadinessBand;
  readinessRedDimensions: number;
  evidenceCompleteness: number;
  worstArchetypeScore: number;
  medianArchetypeScore: number;
  massScore: number | null;
  eliteHeavyScore: number | null;
  mobilityScore: number | null;
  matchupScores: Array<{
    templateId: string;
    posture: TesseraArchetype | null;
    composition: TesseraStressComposition | null;
    score: number;
    outgoingTradeValue: number;
    incomingTradeValue: number;
    evidenceCompleteness: number;
    evidencedCellCount: number;
    missingProfileCellCount: number;
    profileEvidenceCount: number;
  }>;
};

export type OpponentOptionLedgerEntry = {
  entryKey: string;
  origin: "faction-native" | "allied-rule";
  sourceFactionId: string;
  unitId: string;
  unitName: string;
  role: string;
  pointsFrom: number;
  alliedRuleId: string | null;
  eligibleDetachmentIds: string[];
  pricingBasis: "native" | "allied";
  alliedPriceHostKey: string | null;
  pricingAmbiguous: boolean;
  status:
    | "candidate"
    | "duplicate-candidate"
    | "ineligible"
    | "build-failed"
    | "budget-not-expanded"
    | "inventory-only";
  reasonCode: string | null;
  reason: string | null;
  structuralFingerprint: string | null;
  simulationFingerprint: string | null;
  detachmentId: string | null;
  warlordUnitId: string | null;
};

export type OpponentOptionComparisonAudit = {
  schemaVersion: 1;
  resultKind: "opponent-option-comparison";
  method: "stratified-catalogue-axis-comparison-v3";
  comparisonFingerprint: string;
  deterministic: true;
  source: {
    bundleId: string;
    playerFactionId: string;
    playerFactionRulesHash: string | null;
    opponentFactionId: string;
    opponentFactionRulesHash: string | null;
    opponentPortfolioHash: string | null;
    alliedInventoryHash: string | null;
  };
  coverage: {
    catalogueRows: number;
    catalogueComplete: boolean;
    catalogueMayBeTruncated: boolean;
    coverageMode: "complete" | "bounded" | "source-truncated";
    terminalLedgerRows: number;
    eligible: number;
    preScreenedIneligible: number;
    attempted: number;
    buildFailures: number;
    legal: number;
    uniqueCandidates: number;
    opponentRosters: number;
    maximumBuilds: number;
    budgetExhausted: boolean;
    notExpanded: number;
    expansionComplete: boolean;
    stratification: "role-and-cost-band-round-robin-v1";
    allied: {
      rulesOffered: number;
      ruleRows: number;
      uniqueDatasheets: number;
      inventoryOnly: number;
      selectable: 0;
      attempted: 0;
      expansionSupported: false;
      rules: Array<{
        ruleId: string;
        ruleName: string;
        label: string;
        eligibleDetachmentIds: string[];
        sourceFactionId: string | null;
        sourceKeywords: string[];
        sourceDatasheetIds: string[];
        requiredKeywords: string[];
        excludedKeywords: string[];
        roles: string[];
        poolRows: number;
        pointsLimits: Array<{
          battleSize: "incursion" | "strike-force" | "onslaught";
          maxPoints: number;
        }>;
        keywordLimits: Array<{
          keyword: string;
          battleSize: "incursion" | "strike-force" | "onslaught";
          maxCount: number;
        }>;
        maxUnits: number | null;
        cannotBeWarlord: boolean;
        cannotTakeEnhancements: boolean;
        warlordRequiredKeyword: string | null;
        warlordDatasheetIds: string[];
        removesAbilityIds: string[];
        battlelineRatioKeywords: string[];
      }>;
    };
    detachments: {
      mode: "pinned" | "enumerated";
      eligibleIds: string[];
      evaluatedIds: string[];
      successfulIds: string[];
      failures: Array<{
        detachmentId: string;
        reasonCode: string;
        reason: string;
      }>;
      assignment: "pinned" | "least-used-compatible-v1";
    };
    warlords: {
      mode: "pinned" | "stratified";
      eligibleIds: string[];
      evaluatedIds: string[];
      successfulIds: string[];
      assignment: "pinned" | "least-used-compatible-v1";
    };
  };
  opponents: Array<{
    templateId: string;
    posture: TesseraArchetype | null;
    composition: TesseraStressComposition | null;
    rosterId: string;
    rosterName: string;
    structuralFingerprint: string;
    simulationFingerprint: string;
    factionRulesHash: string | null;
  }>;
  recommendation: {
    structuralFingerprint: string;
    simulationFingerprint: string;
    rosterId: string;
    anchorUnitIds: string[];
  };
  alternatives: Array<{
    structuralFingerprint: string;
    simulationFingerprint: string;
    rosterId: string;
    anchorUnitIds: string[];
    contrast: "anti-mass" | "anti-elite-heavy" | "mobility" | "robust";
  }>;
  candidates: Array<{
    structuralFingerprint: string;
    simulationFingerprint: string;
    rosterId: string;
    rosterName: string;
    source: OpponentOptionCandidate["source"];
    anchorUnitIds: string[];
    totalPoints: number;
    pointsUtilization: number;
    readinessBand: TesseraMissionReadinessBand;
    readinessRedDimensions: number;
    evidenceCompleteness: number;
    worstArchetypeScore: number;
    medianArchetypeScore: number;
    massScore: number | null;
    eliteHeavyScore: number | null;
    mobilityScore: number | null;
    matchupScores: OpponentOptionCandidate["matchupScores"];
    units: Array<{
      unitId: string;
      name: string;
      modelCount: number;
      points: number;
      equipment: Array<{ itemId: string; name: string; count: number }>;
    }>;
  }>;
  ledger: OpponentOptionLedgerEntry[];
  limitations: string[];
};

export type OpponentOptionComparisonResult = {
  recommended: OpponentOptionCandidate;
  alternatives: Array<{
    candidate: OpponentOptionCandidate;
    contrast: "anti-mass" | "anti-elite-heavy" | "mobility" | "robust";
  }>;
  candidates: OpponentOptionCandidate[];
  audit: OpponentOptionComparisonAudit;
};

function issue(
  code: string,
  message: string,
  severity: "error" | "warn" = "error",
): RosterIssue {
  return { code, message, severity };
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function semanticHash(
  source: RosterDraftV1["sourceData"],
  field: "factionRulesHash",
): string | null {
  return field in source && typeof source[field] === "string"
    ? source[field]
    : null;
}

function stableSha256(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return rounded(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : rounded((ordered[middle - 1] + ordered[middle]) / 2);
}

function readinessRank(band: TesseraMissionReadinessBand): number {
  if (band === "green") return 4;
  if (band === "amber") return 3;
  if (band === "unknown") return 2;
  return 1;
}

function compareCandidates(
  left: OpponentOptionCandidate,
  right: OpponentOptionCandidate,
): number {
  return (
    right.evidenceCompleteness - left.evidenceCompleteness ||
    left.readinessRedDimensions - right.readinessRedDimensions ||
    Number(right.pointsUtilization >= 0.98) -
      Number(left.pointsUtilization >= 0.98) ||
    readinessRank(right.readinessBand) -
      readinessRank(left.readinessBand) ||
    right.worstArchetypeScore - left.worstArchetypeScore ||
    right.medianArchetypeScore - left.medianArchetypeScore ||
    right.pointsUtilization - left.pointsUtilization ||
    left.structuralFingerprint.localeCompare(
      right.structuralFingerprint,
    )
  );
}

function directionTradeValue(
  cells: ReturnType<typeof baselineDamageCells>,
  attackerSelectionIds: Set<string>,
  target: RosterDraftV1,
): number {
  return rounded(target.units.reduce((total, selection) => {
    const killed = cells
      .filter(
        (cell) =>
          attackerSelectionIds.has(cell.attackerSelectionId) &&
          cell.targetSelectionId === selection.selectionId,
      )
      .reduce(
        (sum, cell) => sum + Math.max(0, cell.expectedModelsKilled),
        0,
      );
    const valuePerModel =
      selection.points / Math.max(1, selection.modelCount);
    return total +
      Math.min(selection.points, killed * valuePerModel);
  }, 0));
}

function scoreCandidate(
  roster: RosterDraftV1,
  anchorUnitIds: string[],
  source: OpponentOptionCandidate["source"],
  opponents: OpponentComparisonRoster[],
): OpponentOptionCandidate | null {
  const readiness = analyzeMissionReadiness(roster);
  if (!readiness.ok || !readiness.data) return null;
  const playerTraits = inspectStressPortfolioTraits(roster);
  const playerSelectionIds = new Set(
    roster.units.map((selection) => selection.selectionId),
  );
  const matchupScores = opponents.map((opponent) => {
    const cells = baselineDamageCells(roster, opponent.roster);
    const opponentSelectionIds = new Set(
      opponent.roster.units.map((selection) => selection.selectionId),
    );
    const outgoingTradeValue = directionTradeValue(
      cells,
      playerSelectionIds,
      opponent.roster,
    );
    const incomingTradeValue = directionTradeValue(
      cells,
      opponentSelectionIds,
      roster,
    );
    const opponentTraits = inspectStressPortfolioTraits(opponent.roster);
    const playerObjectiveShare =
      playerTraits.tagCounts.objective /
      Math.max(1, playerTraits.unitCount);
    const opponentObjectiveShare =
      opponentTraits.tagCounts.objective /
      Math.max(1, opponentTraits.unitCount);
    const expectedCellCount =
      roster.units.length * opponent.roster.units.length * 4;
    const evidencedCellCount = cells.filter(
      (cell) => cell.weaponProfiles.length > 0,
    ).length;
    const evidenceCompleteness = expectedCellCount === 0
      ? 0
      : Math.min(1, evidencedCellCount / expectedCellCount);
    const score = Math.max(
      0,
      Math.min(
        100,
        50 +
          55 *
            (outgoingTradeValue /
              Math.max(1, opponent.roster.totalPoints)) -
          45 *
            (incomingTradeValue / Math.max(1, roster.totalPoints)) +
          10 *
            ((playerTraits.mobilityPressurePercent ?? 0) -
              (opponentTraits.mobilityPressurePercent ?? 0)) +
          8 * (playerObjectiveShare - opponentObjectiveShare),
      ),
    );
    return {
      templateId: opponent.templateId,
      posture: opponent.posture ?? null,
      composition: opponent.composition ?? null,
      score: rounded(score),
      outgoingTradeValue,
      incomingTradeValue,
      evidenceCompleteness: rounded(evidenceCompleteness),
      evidencedCellCount,
      missingProfileCellCount: Math.max(
        0,
        expectedCellCount - evidencedCellCount,
      ),
      profileEvidenceCount: cells.reduce(
        (sum, cell) => sum + cell.weaponProfiles.length,
        0,
      ),
    };
  });
  const scores = matchupScores.map((matchup) => matchup.score);
  const byComposition = (composition: TesseraStressComposition) =>
    matchupScores
      .filter((matchup) => matchup.composition === composition)
      .map((matchup) => matchup.score);
  return {
    roster,
    structuralFingerprint: rosterStructuralFingerprint(roster),
    simulationFingerprint: rosterSimulationFingerprint(roster),
    anchorUnitIds: [...new Set(anchorUnitIds)].sort(),
    source,
    pointsUtilization: rounded(
      roster.totalPoints / Math.max(1, roster.pointsLimit),
    ),
    readinessBand: readiness.data.overallBand,
    readinessRedDimensions: readiness.data.dimensions.filter(
      (dimension) => dimension.band === "red",
    ).length,
    evidenceCompleteness: rounded(Math.min(
      ...matchupScores.map((matchup) => matchup.evidenceCompleteness),
    )),
    worstArchetypeScore: rounded(Math.min(...scores)),
    medianArchetypeScore: rounded(median(scores)),
    massScore: average(byComposition("mass")),
    eliteHeavyScore: average(byComposition("elite-heavy")),
    mobilityScore: rounded(
      (playerTraits.mobilityPressurePercent ?? 0) * 100,
    ),
    matchupScores,
  };
}

type CatalogueEntry = {
  summary: UnitSummary;
  unit: UnitView | null;
};

type FullCatalogue = {
  entries: CatalogueEntry[];
  complete: boolean;
  warnings: RosterIssue[];
};

function factionAncestryIds(factionId: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current = factions.get(factionId);
  while (current && !seen.has(current.id)) {
    result.push(current.id);
    seen.add(current.id);
    const parentId = current.raw.parent_faction_id;
    current = parentId ? factions.get(parentId) : undefined;
  }
  return result;
}

function factionInventory(factionId: string): UnitView[] {
  const seen = new Set<string>();
  const result: UnitView[] = [];
  const allianceControlled = internalAllianceControlledUnitKeys(
    factionId,
  );
  for (const sourceFactionId of factionAncestryIds(factionId)) {
    for (const unit of units.byFaction(sourceFactionId)) {
      if (
        allianceControlled.has(
          `${unit.raw.faction_id}\u0000${unit.id}`,
        )
      ) {
        continue;
      }
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      result.push(unit);
    }
  }
  return result;
}

function fallbackRole(unit: UnitView): string {
  const role = unit.raw.role;
  if (role === "battleline") return "Battleline";
  if (role === "character") return "Character";
  if (role === "dedicated-transport") return "Dedicated Transport";
  if (role === "epic-hero") return "Epic Hero";
  if (role === "fortification") return "Fortification";
  const keywords = [
    ...(unit.raw.keywords ?? []),
    ...(unit.raw.faction_keywords ?? []),
  ].map((keyword) => keyword.toLocaleLowerCase());
  if (keywords.includes("character")) return "Character";
  if (keywords.includes("vehicle")) return "Vehicle";
  if (keywords.includes("mounted")) return "Mounted";
  if (keywords.includes("infantry")) return "Infantry";
  return "Unit";
}

function fallbackSummary(unit: UnitView): UnitSummary {
  const points = (unit.raw.points ?? [])
    .map((tier) => tier.cost)
    .filter((cost): cost is number => Number.isFinite(cost));
  const modelCounts = [
    ...(unit.raw.points ?? []).flatMap((tier) => [
      tier.models,
      ...(tier.models_max ? [tier.models_max] : []),
    ]),
    ...(unit.raw.model_count?.min ? [unit.raw.model_count.min] : []),
  ].filter((count): count is number => Number.isInteger(count) && count > 0);
  const keywords = [
    ...(unit.raw.keywords ?? []),
    ...(unit.raw.faction_keywords ?? []),
  ];
  const normalizedKeywords = keywords.map((keyword) =>
    keyword.toLocaleLowerCase()
  );
  return {
    id: unit.id,
    name: unit.name,
    factionId: unit.raw.faction_id,
    role: fallbackRole(unit),
    pointsFrom: points.length > 0 ? Math.min(...points) : 0,
    pointsKnown: points.some((cost) => cost > 0),
    modelCounts: [...new Set(modelCounts)].sort((left, right) => left - right),
    tags: [],
    keywords,
    isNamedCharacter:
      normalizedKeywords.includes("epic hero") ||
      normalizedKeywords.includes("named character"),
    isLegend: unit.raw.is_legend === true,
    legendBuildSupported: unit.raw.is_legend !== true,
    supported: false,
  };
}

type AlliedCoverageRule =
  OpponentOptionComparisonAudit["coverage"]["allied"]["rules"][number];

type AlliedInventory = {
  ledger: OpponentOptionLedgerEntry[];
  rules: AlliedCoverageRule[];
  inventoryHash: string | null;
};

type NativeLedgerState = Omit<
  OpponentOptionLedgerEntry,
  | "entryKey"
  | "origin"
  | "sourceFactionId"
  | "alliedRuleId"
  | "eligibleDetachmentIds"
  | "pricingBasis"
  | "alliedPriceHostKey"
  | "pricingAmbiguous"
>;

function pricingKey(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function alliedPriceEvidence(
  unit: UnitView,
  hostFactionId: string,
): {
  pointsFrom: number;
  pricingBasis: "native" | "allied";
  alliedPriceHostKey: string | null;
  pricingAmbiguous: boolean;
} {
  const host = factions.get(hostFactionId);
  const hostKeys = new Set(
    [
      hostFactionId,
      ...(host?.raw.keywords ?? []),
    ].map(pricingKey),
  );
  const matching = (unit.raw.allied_points ?? []).filter((tier) =>
    hostKeys.has(pricingKey(tier.host_faction))
  );
  if (matching.length === 0) {
    const nativeCosts = (unit.raw.points ?? [])
      .map((tier) => tier.cost)
      .filter((cost): cost is number => Number.isFinite(cost));
    return {
      pointsFrom: nativeCosts.length > 0 ? Math.min(...nativeCosts) : 0,
      pricingBasis: "native",
      alliedPriceHostKey: null,
      pricingAmbiguous: false,
    };
  }
  const hostGroups = new Map<string, typeof matching>();
  for (const tier of matching) {
    const key = pricingKey(tier.host_faction);
    const group = hostGroups.get(key) ?? [];
    group.push(tier);
    hostGroups.set(key, group);
  }
  const signatures = new Set(
    [...hostGroups.values()].map((tiers) =>
      JSON.stringify(
        tiers
          .map((tier) => [
            tier.models,
            tier.models_max ?? tier.models,
            tier.cost,
            tier.unit_count_min ?? null,
            tier.unit_count_max ?? null,
          ])
          .sort((left, right) =>
            Number(left[0]) - Number(right[0]) ||
            Number(left[2]) - Number(right[2])
          ),
      )
    ),
  );
  const matchingCosts = matching
    .map((tier) => tier.cost)
    .filter((cost): cost is number => Number.isFinite(cost));
  return {
    pointsFrom: matchingCosts.length > 0
      ? Math.min(...matchingCosts)
      : 0,
    pricingBasis: "allied",
    alliedPriceHostKey: [...hostGroups.keys()].sort()[0] ?? null,
    pricingAmbiguous: signatures.size > 1,
  };
}

function alliedRuleEvidence(
  rule: AlliedRule,
  eligibleDetachmentIds: string[],
  poolRows: number,
): AlliedCoverageRule {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    label: rule.label ?? rule.name,
    eligibleDetachmentIds: [...eligibleDetachmentIds].sort(),
    sourceFactionId: rule.source_faction_id ?? null,
    sourceKeywords: [...(rule.source_keywords ?? [])].sort(),
    sourceDatasheetIds: [...(rule.source_datasheet_ids ?? [])].sort(),
    requiredKeywords: [...(rule.required_keywords ?? [])].sort(),
    excludedKeywords: [...(rule.excluded_keywords ?? [])].sort(),
    roles: [...(rule.roles ?? [])].sort(),
    poolRows,
    pointsLimits: [...(rule.points_limits ?? [])]
      .map((limit) => ({
        battleSize: limit.battle_size,
        maxPoints: limit.max_points,
      }))
      .sort((left, right) =>
        left.battleSize.localeCompare(right.battleSize)
      ),
    keywordLimits: [...(rule.keyword_limits ?? [])]
      .map((limit) => ({
        keyword: limit.keyword,
        battleSize: limit.battle_size,
        maxCount: limit.max_count,
      }))
      .sort(
        (left, right) =>
          left.keyword.localeCompare(right.keyword) ||
          left.battleSize.localeCompare(right.battleSize),
      ),
    maxUnits: rule.max_units ?? null,
    cannotBeWarlord: rule.cannot_be_warlord === true,
    cannotTakeEnhancements:
      rule.cannot_take_enhancements === true,
    warlordRequiredKeyword: rule.warlord_required_keyword ?? null,
    warlordDatasheetIds: [...(rule.warlord_datasheet_ids ?? [])]
      .sort(),
    removesAbilityIds: [...(rule.removes_ability_ids ?? [])].sort(),
    battlelineRatioKeywords: [
      ...(rule.battleline_ratio_keywords ?? []),
    ].sort(),
  };
}

function alliedInventory(
  hostFactionId: string,
  eligibleDetachmentIds: string[],
): AlliedInventory {
  const detachmentIdsByRule = new Map<string, Set<string>>();
  const rulesById = new Map<string, AlliedRule>();
  for (const detachmentId of eligibleDetachmentIds) {
    for (const rule of dataset.alliesFor(
      hostFactionId,
      [detachmentId],
    )) {
      rulesById.set(rule.id, rule);
      const ids = detachmentIdsByRule.get(rule.id) ?? new Set<string>();
      ids.add(detachmentId);
      detachmentIdsByRule.set(rule.id, ids);
    }
  }
  const rules: AlliedCoverageRule[] = [];
  const ledger: OpponentOptionLedgerEntry[] = [];
  for (const rule of [...rulesById.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    const eligibleIds = [
      ...(detachmentIdsByRule.get(rule.id) ?? new Set<string>()),
    ].sort();
    const pool = dataset.allyUnitsFor(rule.id);
    rules.push(alliedRuleEvidence(rule, eligibleIds, pool.length));
    for (const unit of pool) {
      const summary = fallbackSummary(unit);
      const price = alliedPriceEvidence(unit, hostFactionId);
      ledger.push({
        entryKey:
          `allied-rule:${rule.id}:${unit.raw.faction_id}:${unit.id}`,
        origin: "allied-rule",
        sourceFactionId: unit.raw.faction_id,
        unitId: unit.id,
        unitName: unit.name,
        role: summary.role,
        pointsFrom: price.pointsFrom,
        alliedRuleId: rule.id,
        eligibleDetachmentIds: eligibleIds,
        pricingBasis: price.pricingBasis,
        alliedPriceHostKey: price.alliedPriceHostKey,
        pricingAmbiguous: price.pricingAmbiguous,
        status: "inventory-only",
        reasonCode: "ALLIED_CONSTRUCTION_UNSUPPORTED",
        reason:
          "The active AlliedRule offers this datasheet, but allied selections are not yet carried through host pricing, canonical validation, combat resolution, and export.",
        structuralFingerprint: null,
        simulationFingerprint: null,
        detachmentId: eligibleIds.length === 1 ? eligibleIds[0] : null,
        warlordUnitId: null,
      });
    }
  }
  ledger.sort(
    (left, right) =>
      (left.alliedRuleId ?? "").localeCompare(
        right.alliedRuleId ?? "",
      ) ||
      left.unitName.localeCompare(right.unitName) ||
      left.sourceFactionId.localeCompare(right.sourceFactionId) ||
      left.unitId.localeCompare(right.unitId),
  );
  return {
    ledger,
    rules,
    inventoryHash: ledger.length > 0
      ? stableSha256({ rules, ledger })
      : null,
  };
}

/**
 * Public unit search is intentionally capped for compact research results.
 * Comparison coverage binds the complete runtime inventory to one uncapped
 * internal summary snapshot.
 */
function fullFactionCatalogue(factionId: string): FullCatalogue {
  const inventory = factionInventory(factionId);
  const inventoryResult = internalFactionUnitInventory({
    faction: factionId,
    includeLegends: true,
  });
  const summaries = new Map(
    (inventoryResult.data ?? []).map((summary) => [summary.id, summary]),
  );
  const warnings = [...inventoryResult.warnings];
  let complete = inventoryResult.ok && inventoryResult.data !== null;
  const entries = inventory.map((unit) => {
    let summary = summaries.get(unit.id);
    if (!summary) {
      complete = false;
      summary = fallbackSummary(unit);
      warnings.push(issue(
        "CATALOGUE_SUMMARY_UNAVAILABLE",
        `${unit.name} is present in the runtime faction inventory but could not be resolved through the build summary path.`,
        "warn",
      ));
    }
    return { summary, unit };
  });
  entries.sort(
    (left, right) =>
      left.summary.role.localeCompare(right.summary.role) ||
      left.summary.pointsFrom - right.summary.pointsFrom ||
      left.summary.name.localeCompare(right.summary.name) ||
      left.summary.id.localeCompare(right.summary.id),
  );
  return { entries, complete, warnings };
}

type DetachmentOption = ReturnType<
  typeof detachments.byFaction
>[number];

function matchedPlayDetachmentOptions(
  factionId: string,
  pointsLimit: number,
): DetachmentOption[] {
  const cap = pointsLimit <= 1000 ? 2 : 3;
  const seen = new Set<string>();
  const result: DetachmentOption[] = [];
  for (const sourceFactionId of factionAncestryIds(factionId)) {
    for (const detachment of detachments.byFaction(sourceFactionId)) {
      if (seen.has(detachment.id)) continue;
      const matchedPlay =
        !detachment.game_modes ||
        detachment.game_modes.includes("matched-play");
      const withinCap =
        detachment.detachment_points == null ||
        detachment.detachment_points <= cap;
      if (!matchedPlay || !withinCap) continue;
      seen.add(detachment.id);
      result.push(detachment);
    }
  }
  return result.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

function isCharacter(unit: UnitView): boolean {
  return (
    unit.raw.role === "character" ||
    unit.raw.role === "epic-hero" ||
    [
      ...(unit.raw.keywords ?? []),
      ...(unit.raw.faction_keywords ?? []),
    ].some((keyword) => keyword.toLocaleLowerCase() === "character")
  );
}

function costBand(points: number, pointsLimit: number): 0 | 1 | 2 | 3 {
  const share = points / Math.max(1, pointsLimit);
  if (share <= 0.1) return 0;
  if (share <= 0.2) return 1;
  if (share <= 0.35) return 2;
  return 3;
}

function stratifiedExpansionOrder(
  entries: CatalogueEntry[],
  pointsLimit: number,
): CatalogueEntry[] {
  const buckets = new Map<string, CatalogueEntry[]>();
  for (const entry of entries) {
    const band = costBand(entry.summary.pointsFrom, pointsLimit);
    const key = `${band}\u0000${entry.summary.role}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort(
      (left, right) =>
        left.summary.pointsFrom - right.summary.pointsFrom ||
        left.summary.name.localeCompare(right.summary.name) ||
        left.summary.id.localeCompare(right.summary.id),
    );
  }
  const bucketKeys = [...buckets.keys()].sort((left, right) => {
    const [leftBand, leftRole] = left.split("\u0000");
    const [rightBand, rightRole] = right.split("\u0000");
    return Number(leftBand) - Number(rightBand) ||
      leftRole.localeCompare(rightRole);
  });
  const result: CatalogueEntry[] = [];
  let found = true;
  while (found) {
    found = false;
    for (const key of bucketKeys) {
      const next = buckets.get(key)?.shift();
      if (!next) continue;
      result.push(next);
      found = true;
    }
  }
  return result;
}

function exclusionReason(
  unit: UnitSummary,
  input: BuildRosterInput,
  pointsLimit: number,
): { code: string; message: string } | null {
  if (!unit.supported || !unit.pointsKnown) {
    return {
      code: "BUILD_DATA_UNAVAILABLE",
      message: "The active bundle does not contain complete deterministic build data.",
    };
  }
  if (unit.pointsFrom <= 0) {
    return {
      code: "NON_POSITIVE_POINTS",
      message: "The active bundle does not contain a positive matched-play points value for this datasheet.",
    };
  }
  if (unit.isLegend && input.allowLegends !== true) {
    return {
      code: "LEGENDS_EXCLUDED",
      message: "Legends are excluded by the resolved build policy.",
    };
  }
  if (unit.isNamedCharacter && input.allowNamedCharacters === false) {
    return {
      code: "NAMED_CHARACTER_EXCLUDED",
      message: "Named characters are excluded by the build request.",
    };
  }
  if ((input.excludedUnitIds ?? []).includes(unit.id)) {
    return {
      code: "USER_EXCLUDED",
      message: "The unit is explicitly excluded by the user.",
    };
  }
  const collectionIds = input.collectionProfile?.mode === "owned"
    ? input.collectionProfile.units.map((entry) => entry.unitId)
    : input.collectionUnitIds;
  if (collectionIds && !collectionIds.includes(unit.id)) {
    return {
      code: "OUTSIDE_COLLECTION",
      message: "The unit is not present in the declared collection.",
    };
  }
  if (unit.pointsFrom > pointsLimit) {
    return {
      code: "OVER_POINTS_LIMIT",
      message: `The cheapest supported unit costs ${unit.pointsFrom} points.`,
    };
  }
  return null;
}

function buildScopeExclusionReason(
  entry: CatalogueEntry,
  input: BuildRosterInput,
  baseline: RosterDraftV1,
): { code: string; message: string } | null {
  const base = exclusionReason(entry.summary, input, baseline.pointsLimit);
  if (base) return base;
  const unit = entry.unit;
  if (!unit) {
    return {
      code: "BUILD_SUMMARY_UNAVAILABLE",
      message: "The runtime datasheet could not be bound to deterministic build data.",
    };
  }
  if (
    unit.raw.game_modes &&
    !unit.raw.game_modes.includes("matched-play")
  ) {
    return {
      code: "MATCHED_PLAY_EXCLUDED",
      message: "The datasheet is not available in matched play.",
    };
  }
  if (entry.summary.modelCounts.length === 0) {
    return {
      code: "MODEL_COUNT_UNAVAILABLE",
      message: "No deterministic model-count tier is available.",
    };
  }
  const factionKeywords = new Set(
    factions.get(baseline.factionId)?.raw.keywords ?? [],
  );
  if (
    (unit.raw.excluded_faction_keywords ?? []).some((keyword) =>
      factionKeywords.has(keyword)
    )
  ) {
    return {
      code: "FACTION_KEYWORD_EXCLUDED",
      message: "The datasheet excludes the selected faction keyword.",
    };
  }
  return null;
}

function detachmentExclusionReason(
  entry: CatalogueEntry,
  detachment: DetachmentOption,
): { code: string; message: string } | null {
  const unit = entry.unit;
  if (!unit) {
    return {
      code: "BUILD_SUMMARY_UNAVAILABLE",
      message: "The runtime datasheet could not be inspected for detachment compatibility.",
    };
  }
  const unitKeywords = new Set([
    ...(unit.raw.keywords ?? []),
    ...(unit.raw.faction_keywords ?? []),
  ]);
  if (
    (detachment.restrictions?.required_keywords ?? []).some(
      (keyword) => !unitKeywords.has(keyword),
    )
  ) {
    return {
      code: "DETACHMENT_KEYWORD_REQUIRED",
      message: `${detachment.name} requires a keyword this datasheet does not have.`,
    };
  }
  if (
    (detachment.restrictions?.excluded_keywords ?? []).some((keyword) =>
      unitKeywords.has(keyword)
    )
  ) {
    return {
      code: "DETACHMENT_KEYWORD_EXCLUDED",
      message: `${detachment.name} excludes this datasheet's keyword.`,
    };
  }
  return null;
}

function minimumRosterFitExclusion(
  anchor: CatalogueEntry,
  entries: CatalogueEntry[],
  staticExclusions: ReadonlyMap<string, { code: string; message: string } | null>,
  baseline: RosterDraftV1,
): { code: string; message: string } | null {
  const byId = new Map(entries.map((entry) => [entry.summary.id, entry]));
  const requiredIds = new Set([
    ...(baseline.constraints.requiredUnitIds ?? []),
    ...(baseline.constraints.requiredWarlordUnitId
      ? [baseline.constraints.requiredWarlordUnitId]
      : []),
    anchor.summary.id,
  ]);
  const requiredEntries = [...requiredIds].flatMap((unitId) => {
    const entry = byId.get(unitId);
    return entry ? [entry] : [];
  });
  let minimumPoints = requiredEntries.reduce(
    (sum, entry) => sum + Math.max(0, entry.summary.pointsFrom),
    0,
  );
  if (!requiredEntries.some((entry) => entry.unit && isCharacter(entry.unit))) {
    const cheapestWarlord = entries
      .filter(
        (entry) =>
          staticExclusions.get(entry.summary.id) === null &&
          entry.unit !== null &&
          isCharacter(entry.unit),
      )
      .sort(
        (left, right) =>
          left.summary.pointsFrom - right.summary.pointsFrom ||
          left.summary.name.localeCompare(right.summary.name) ||
          left.summary.id.localeCompare(right.summary.id),
      )[0];
    if (!cheapestWarlord) {
      return {
        code: "NO_WARLORD_CANDIDATE",
        message: "No eligible Character can accompany this exploration anchor.",
      };
    }
    minimumPoints += cheapestWarlord.summary.pointsFrom;
  }
  if (minimumPoints > baseline.pointsLimit) {
    return {
      code: "MINIMUM_ROSTER_POINTS_OVER",
      message: `The anchor plus required units and the cheapest eligible Warlord require at least ${minimumPoints} points.`,
    };
  }
  return null;
}

function minimumPointsWithWarlord(
  anchor: CatalogueEntry,
  warlord: CatalogueEntry,
  entries: CatalogueEntry[],
  baseline: RosterDraftV1,
): number {
  const byId = new Map(entries.map((entry) => [entry.summary.id, entry]));
  const unitIds = new Set([
    ...(baseline.constraints.requiredUnitIds ?? []),
    anchor.summary.id,
    warlord.summary.id,
  ]);
  return [...unitIds].reduce((sum, unitId) => {
    const entry = byId.get(unitId);
    return sum + Math.max(0, entry?.summary.pointsFrom ?? 0);
  }, 0);
}

function resolvedComparisonBuildInput(
  input: BuildRosterInput,
  baseline: RosterDraftV1,
): BuildRosterInput {
  return {
    ...input,
    playerFaction: baseline.factionId,
    faction: baseline.factionId,
    pointsLimit: baseline.pointsLimit,
    allowNamedCharacters: baseline.constraints.allowNamedCharacters,
    allowLegends: baseline.constraints.allowLegends,
    collectionUnitIds:
      baseline.constraints.collectionUnitIds ?? undefined,
    collectionProfile:
      baseline.constraints.collectionProfile ?? undefined,
    requiredUnitIds: baseline.constraints.requiredUnitIds ?? [],
    excludedUnitIds: baseline.constraints.excludedUnitIds ?? [],
    requiredWarlordUnitId:
      baseline.constraints.requiredWarlordUnitId ?? undefined,
    detachmentId: baseline.detachmentId,
    forceDispositionId: baseline.forceDispositionId,
  };
}

function normalizedFactionId(query: string): string | null {
  const normalized = query
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return factions.all.find((faction) =>
    faction.id === query ||
    faction.id.replace(/-/g, " ") === normalized ||
    faction.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ===
      normalized ||
    (faction.raw.aliases ?? []).some((alias) =>
      alias.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ===
        normalized
    )
  )?.id ?? null;
}

function sameStrings(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
): boolean {
  return JSON.stringify([...(left ?? [])].sort()) ===
    JSON.stringify([...(right ?? [])].sort());
}

function includesStrings(
  actual: readonly string[] | null | undefined,
  expected: readonly string[] | null | undefined,
): boolean {
  const actualValues = new Set(actual ?? []);
  return [...(expected ?? [])].every((value) => actualValues.has(value));
}

function normalizedCollectionProfile(
  value: BuildRosterInput["collectionProfile"] |
    RosterDraftV1["constraints"]["collectionProfile"],
): unknown {
  if (!value || value.mode !== "owned") return value ?? null;
  return {
    ...value,
    units: [...value.units].sort((left, right) =>
      left.unitId.localeCompare(right.unitId)
    ),
  };
}

function baselineInputScopeViolation(
  input: BuildRosterInput,
  baseline: RosterDraftV1,
): RosterIssue | null {
  const factionQuery = input.playerFaction ?? input.faction;
  if (factionQuery) {
    const factionId = normalizedFactionId(factionQuery);
    if (!factionId || factionId !== baseline.factionId) {
      return issue(
        "OPPONENT_COMPARISON_BASELINE_INPUT_MISMATCH",
        "The supplied baseline faction does not match the requested player faction.",
      );
    }
  }
  if (
    input.pointsLimit !== undefined &&
    Math.max(100, Math.min(input.pointsLimit, 5000)) !== baseline.pointsLimit
  ) {
    return issue(
      "OPPONENT_COMPARISON_BASELINE_INPUT_MISMATCH",
      "The supplied baseline points limit does not match the build request.",
    );
  }
  const constraints = baseline.constraints;
  const checks: Array<[boolean, string]> = [
    [
      input.preferences === undefined ||
        includesStrings(baseline.preferences, input.preferences),
      "preferences",
    ],
    [
      input.allowNamedCharacters === undefined ||
        input.allowNamedCharacters === constraints.allowNamedCharacters,
      "named-character policy",
    ],
    [
      input.allowLegends === undefined ||
        input.allowLegends === constraints.allowLegends,
      "Legends policy",
    ],
    [
      input.collectionUnitIds === undefined ||
        sameStrings(input.collectionUnitIds, constraints.collectionUnitIds),
      "collection unit IDs",
    ],
    [
      input.collectionProfile === undefined ||
        stableSha256(normalizedCollectionProfile(input.collectionProfile)) ===
          stableSha256(normalizedCollectionProfile(
            constraints.collectionProfile,
          )),
      "collection profile",
    ],
    [
      input.requiredUnitIds === undefined ||
        includesStrings(constraints.requiredUnitIds, input.requiredUnitIds),
      "required units",
    ],
    [
      input.excludedUnitIds === undefined ||
        sameStrings(input.excludedUnitIds, constraints.excludedUnitIds),
      "excluded units",
    ],
    [
      input.requiredWarlordUnitId === undefined ||
        input.requiredWarlordUnitId ===
          constraints.requiredWarlordUnitId,
      "required Warlord",
    ],
    [
      input.detachmentId === undefined ||
        input.detachmentId === baseline.detachmentId,
      "detachment",
    ],
    [
      input.forceDispositionId === undefined ||
        input.forceDispositionId === baseline.forceDispositionId,
      "force disposition",
    ],
  ];
  const mismatch = checks.find(([matches]) => !matches);
  return mismatch
    ? issue(
        "OPPONENT_COMPARISON_BASELINE_INPUT_MISMATCH",
        `The supplied baseline does not preserve the build request's ${mismatch[1]} axis.`,
      )
    : null;
}

function mergeCandidate(
  candidates: Map<string, OpponentOptionCandidate>,
  candidate: OpponentOptionCandidate,
): { candidate: OpponentOptionCandidate; duplicate: boolean } {
  const current = candidates.get(candidate.structuralFingerprint);
  if (!current) {
    candidates.set(candidate.structuralFingerprint, candidate);
    return { candidate, duplicate: false };
  }
  current.anchorUnitIds = [
    ...new Set([...current.anchorUnitIds, ...candidate.anchorUnitIds]),
  ].sort();
  return { candidate: current, duplicate: true };
}

function selectAlternatives(
  candidates: OpponentOptionCandidate[],
  recommended: OpponentOptionCandidate,
  limit: number,
): Array<{
  candidate: OpponentOptionCandidate;
  contrast: "anti-mass" | "anti-elite-heavy" | "mobility" | "robust";
}> {
  const selected: Array<{
    candidate: OpponentOptionCandidate;
    contrast: "anti-mass" | "anti-elite-heavy" | "mobility" | "robust";
  }> = [];
  const distinct = (candidate: OpponentOptionCandidate) =>
    candidate.simulationFingerprint !==
      recommended.simulationFingerprint &&
    rosterSimulationDistance(candidate.roster, recommended.roster) >= 0.2 &&
    selected.every(
      (item) =>
        rosterSimulationDistance(candidate.roster, item.candidate.roster) >=
          0.2,
    );
  const addBest = (
    contrast: "anti-mass" | "anti-elite-heavy" | "mobility",
    metric: "massScore" | "eliteHeavyScore" | "mobilityScore",
  ) => {
    if (selected.length >= limit) return;
    const candidate = [...candidates]
      .filter(
        (item) =>
          item[metric] !== null &&
          item.readinessRedDimensions === 0 &&
          item.pointsUtilization >= 0.98 &&
          distinct(item),
      )
      .sort(
        (left, right) =>
          (right[metric] ?? 0) - (left[metric] ?? 0) ||
          compareCandidates(left, right),
      )[0];
    if (candidate) selected.push({ candidate, contrast });
  };
  addBest("anti-mass", "massScore");
  addBest("anti-elite-heavy", "eliteHeavyScore");
  addBest("mobility", "mobilityScore");
  for (const candidate of [...candidates].sort(compareCandidates)) {
    if (selected.length >= limit) break;
    if (distinct(candidate)) {
      selected.push({ candidate, contrast: "robust" });
    }
  }
  return selected;
}

/**
 * Deterministically expands one legal roster per eligible catalogue anchor,
 * then compares every unique result against the same frozen opponent set.
 * This is an evidence-producing build comparison, not a win-probability model
 * and not a history-dependent list rotator.
 */
export function compareOpponentRosterOptions(
  input: OpponentOptionComparisonInput,
): ResultEnvelope<OpponentOptionComparisonResult> {
  if (input.opponents.length === 0) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_EMPTY",
        "At least one exact opponent roster is required for option comparison.",
      )],
      warnings: [],
    };
  }
  if (input.opponents.length > 9) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_LIMIT_EXCEEDED",
        "Opponent option comparison accepts at most nine frozen rosters.",
      )],
      warnings: [],
    };
  }
  const seenTemplateIds = new Set<string>();
  for (const opponent of input.opponents) {
    if (seenTemplateIds.has(opponent.templateId)) {
      return {
        ok: false,
        data: null,
        violations: [issue(
          "OPPONENT_COMPARISON_DUPLICATE_TEMPLATE_ID",
          `Opponent template ID ${opponent.templateId} appears more than once.`,
        )],
        warnings: [],
      };
    }
    seenTemplateIds.add(opponent.templateId);
  }
  const templateByStructuralFingerprint = new Map<string, string>();
  for (const opponent of input.opponents) {
    const validation = validateRoster(opponent.roster);
    if (!validation.ok) {
      return {
        ok: false,
        data: null,
        violations: [
          issue(
            "OPPONENT_COMPARISON_ROSTER_INVALID",
            `Opponent template ${opponent.templateId} must validate before comparison.`,
          ),
          ...validation.violations,
        ],
        warnings: validation.warnings,
      };
    }
    const structuralFingerprint = rosterStructuralFingerprint(
      opponent.roster,
    );
    const priorTemplateId = templateByStructuralFingerprint.get(
      structuralFingerprint,
    );
    if (priorTemplateId) {
      return {
        ok: false,
        data: null,
        violations: [issue(
          "OPPONENT_COMPARISON_DUPLICATE_STRUCTURAL_FINGERPRINT",
          `Opponent templates ${priorTemplateId} and ${opponent.templateId} have the same structural roster fingerprint.`,
        )],
        warnings: [],
      };
    }
    templateByStructuralFingerprint.set(
      structuralFingerprint,
      opponent.templateId,
    );
  }
  const internalBuildCacheToken = {};
  const baselineResult = input.baselineRoster
    ? {
        ok: validateRoster(input.baselineRoster).ok,
        data: input.baselineRoster,
        violations: validateRoster(input.baselineRoster).violations,
        warnings: validateRoster(input.baselineRoster).warnings,
      }
    : buildRoster({
        ...input.buildInput,
        internalExplorationAnchorUnitIds: undefined,
        internalBuildCacheToken,
      });
  if (!baselineResult.ok || !baselineResult.data) {
    return {
      ok: false,
      data: null,
      violations: baselineResult.violations,
      warnings: baselineResult.warnings,
    };
  }
  const baseline = baselineResult.data;
  const baselineScopeViolation = baselineInputScopeViolation(
    input.buildInput,
    baseline,
  );
  if (baselineScopeViolation) {
    return {
      ok: false,
      data: null,
      violations: [baselineScopeViolation],
      warnings: [],
    };
  }
  const opponentFactionIds = [
    ...new Set(input.opponents.map((opponent) => opponent.roster.factionId)),
  ];
  if (opponentFactionIds.length !== 1) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_FACTION_CONFLICT",
        "Every frozen opponent roster must belong to the same faction.",
      )],
      warnings: [],
    };
  }
  const opponentFactionId = opponentFactionIds[0];
  if (
    baseline.constraints.opponentFactionId !== opponentFactionId
  ) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_BASELINE_OPPONENT_MISMATCH",
        "The supplied baseline was not built against the frozen opponent faction.",
      )],
      warnings: [],
    };
  }
  const opponentContext = input.buildInput.opponentContext;
  if (!opponentContext) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_OPPONENT_CONTEXT_REQUIRED",
        "Opponent option comparison requires the build input's frozen opponent context.",
      )],
      warnings: [],
    };
  }
  const contextFactionId = opponentContext.kind === "known-roster"
    ? opponentContext.roster.factionId
    : opponentContext.factionId;
  if (contextFactionId !== opponentFactionId) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_OPPONENT_CONTEXT_MISMATCH",
        "The build input's opponent context does not match the frozen opponent set.",
      )],
      warnings: [],
    };
  }
  if (opponentContext.kind === "known-roster") {
    if (
      input.opponents.length !== 1 ||
      rosterStructuralFingerprint(opponentContext.roster) !==
        rosterStructuralFingerprint(input.opponents[0].roster) ||
      baseline.constraints.opponentRosterFingerprint !==
        opponentRosterFingerprint(opponentContext.roster)
    ) {
      return {
        ok: false,
        data: null,
        violations: [issue(
          "OPPONENT_COMPARISON_OPPONENT_CONTEXT_MISMATCH",
          "The exact opponent context, baseline fingerprint, and frozen opponent roster must identify the same roster.",
        )],
        warnings: [],
      };
    }
  } else {
    const contextPortfolioHash = opponentContext.portfolioHash ?? null;
    if (
      baseline.constraints.opponentPortfolioHash !== contextPortfolioHash ||
      (input.opponentPortfolioHash ?? null) !== contextPortfolioHash
    ) {
      return {
        ok: false,
        data: null,
        violations: [issue(
          "OPPONENT_COMPARISON_OPPONENT_CONTEXT_MISMATCH",
          "The known-faction context, baseline, and comparison must share one portfolio hash.",
        )],
        warnings: [],
      };
    }
    if (opponentContext.representativeRosters) {
      const contextFingerprints = opponentContext.representativeRosters
        .map(rosterStructuralFingerprint)
        .sort();
      const frozenFingerprints = input.opponents
        .map((opponent) => rosterStructuralFingerprint(opponent.roster))
        .sort();
      if (
        JSON.stringify(contextFingerprints) !==
        JSON.stringify(frozenFingerprints)
      ) {
        return {
          ok: false,
          data: null,
          violations: [issue(
            "OPPONENT_COMPARISON_OPPONENT_CONTEXT_MISMATCH",
            "The known-faction representatives do not match the frozen opponent set.",
          )],
          warnings: [],
        };
      }
    }
  }
  if (
    input.opponentPortfolioHash !== undefined &&
    input.opponentPortfolioHash !== null &&
    input.opponentPortfolioHash !==
      portfolioCapabilityHash(opponentFactionId)
  ) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_PORTFOLIO_HASH_MISMATCH",
        "The supplied opponent portfolio hash is not bound to the active faction rules and portfolio methodology.",
      )],
      warnings: [],
    };
  }
  const mismatchedBundle = input.opponents.find(
    (opponent) =>
      opponent.roster.sourceData.bundleId !==
      baseline.sourceData.bundleId,
  );
  if (mismatchedBundle) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_BUNDLE_MISMATCH",
        `Opponent template ${mismatchedBundle.templateId} is not bound to the player's active data bundle.`,
      )],
      warnings: [],
    };
  }
  const mismatchedPoints = input.opponents.find(
    (opponent) => opponent.roster.pointsLimit !== baseline.pointsLimit,
  );
  if (mismatchedPoints) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_POINTS_LIMIT_MISMATCH",
        `Opponent template ${mismatchedPoints.templateId} does not use the player's ${baseline.pointsLimit}-point game limit.`,
      )],
      warnings: [],
    };
  }

  const maximumBuilds = Math.max(
    1,
    Math.min(500, Math.floor(input.maximumBuilds ?? 48)),
  );
  const maximumAlternatives = Math.max(
    0,
    Math.min(3, Math.floor(input.maximumAlternatives ?? 3)),
  );
  const fullCatalogue = fullFactionCatalogue(baseline.factionId);
  const catalogue = fullCatalogue.entries;
  const comparisonBuildInput = {
    ...resolvedComparisonBuildInput(
      input.buildInput,
      baseline,
    ),
    internalBuildCacheToken,
  };
  const warnings: RosterIssue[] = [...fullCatalogue.warnings];
  const detachmentMode = input.buildInput.detachmentId
    ? ("pinned" as const)
    : ("enumerated" as const);
  const allDetachments = matchedPlayDetachmentOptions(
    baseline.factionId,
    baseline.pointsLimit,
  );
  const eligibleDetachments = input.buildInput.detachmentId
    ? allDetachments.filter(
        (detachment) => detachment.id === input.buildInput.detachmentId,
      )
    : allDetachments;
  if (
    input.buildInput.detachmentId &&
    baseline.detachmentId !== input.buildInput.detachmentId
  ) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_BASELINE_DETACHMENT_MISMATCH",
        "The supplied baseline does not use the explicitly pinned detachment.",
      )],
      warnings,
    };
  }
  if (eligibleDetachments.length === 0) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_DETACHMENT_EMPTY",
        "No matched-play detachment within the battle-size DP cap is available for comparison.",
      )],
      warnings,
    };
  }
  const allied = alliedInventory(
    baseline.factionId,
    eligibleDetachments.map((detachment) => detachment.id),
  );
  const candidates = new Map<string, OpponentOptionCandidate>();
  const baselineCandidate = scoreCandidate(
    baseline,
    [],
    "baseline",
    input.opponents,
  );
  if (!baselineCandidate) {
    return {
      ok: false,
      data: null,
      violations: [issue(
        "OPPONENT_COMPARISON_READINESS_FAILED",
        "The baseline roster could not be evaluated for mission readiness.",
      )],
      warnings: [],
    };
  }
  mergeCandidate(candidates, baselineCandidate);
  const detachmentEvaluatedIds = new Set<string>([baseline.detachmentId]);
  const detachmentSuccessfulIds = new Set<string>([baseline.detachmentId]);
  const detachmentFailureById = new Map<
    string,
    OpponentOptionComparisonAudit["coverage"]["detachments"]["failures"][number]
  >();
  const warlordEvaluatedIds = new Set<string>();
  const warlordSuccessfulIds = new Set<string>();
  const baselineWarlordId = baseline.units.find(
    (selection) => selection.isWarlord,
  )?.unitId;
  if (baselineWarlordId) {
    warlordEvaluatedIds.add(baselineWarlordId);
    warlordSuccessfulIds.add(baselineWarlordId);
  }

  const ledgerByUnitId = new Map<string, NativeLedgerState>();
  let attempted = 0;
  let legal = 0;
  const staticExclusions = new Map<
    string,
    { code: string; message: string } | null
  >();
  for (const entry of catalogue) {
    staticExclusions.set(
      entry.summary.id,
      buildScopeExclusionReason(entry, comparisonBuildInput, baseline),
    );
  }
  const eligibleEntries: CatalogueEntry[] = [];
  for (const entry of catalogue) {
    const unit = entry.summary;
    const excluded = staticExclusions.get(unit.id) ??
      minimumRosterFitExclusion(
        entry,
        catalogue,
        staticExclusions,
        baseline,
      );
    const compatibleDetachments = eligibleDetachments.filter(
      (detachment) => detachmentExclusionReason(entry, detachment) === null,
    );
    const resolvedExclusion = excluded ??
      (compatibleDetachments.length === 0
        ? {
            code: "NO_COMPATIBLE_DETACHMENT",
            message:
              "No eligible matched-play detachment permits this datasheet.",
          }
        : null);
    if (resolvedExclusion) {
      ledgerByUnitId.set(unit.id, {
        unitId: unit.id,
        unitName: unit.name,
        role: unit.role,
        pointsFrom: unit.pointsFrom,
        status: "ineligible",
        reasonCode: resolvedExclusion.code,
        reason: resolvedExclusion.message,
        structuralFingerprint: null,
        simulationFingerprint: null,
        detachmentId: null,
        warlordUnitId: null,
      });
      continue;
    }
    eligibleEntries.push(entry);
  }

  const pinnedWarlordId = comparisonBuildInput.requiredWarlordUnitId;
  const warlordMode = pinnedWarlordId
    ? ("pinned" as const)
    : ("stratified" as const);
  const eligibleWarlordEntries = eligibleEntries
    .filter((entry) => entry.unit && isCharacter(entry.unit))
    .filter(
      (entry) =>
        !pinnedWarlordId || entry.summary.id === pinnedWarlordId,
    )
    .sort(
      (left, right) =>
        left.summary.pointsFrom - right.summary.pointsFrom ||
        left.summary.name.localeCompare(right.summary.name) ||
        left.summary.id.localeCompare(right.summary.id),
    );
  const detachmentUsage = new Map<string, number>([
    [baseline.detachmentId, 1],
  ]);
  const warlordUsage = new Map<string, number>(
    baselineWarlordId ? [[baselineWarlordId, 1]] : [],
  );
  const assignments = new Map<
    string,
    { detachmentId: string; warlordUnitId: string }
  >();
  const compatibleWarlordsByEntryAndDetachment = new Map<
    string,
    Map<string, CatalogueEntry[]>
  >();
  const orderedEntries = stratifiedExpansionOrder(
    eligibleEntries,
    baseline.pointsLimit,
  );
  for (const entry of orderedEntries) {
    const byDetachment = new Map<string, CatalogueEntry[]>();
    for (const detachment of eligibleDetachments) {
      if (detachmentExclusionReason(entry, detachment)) continue;
      const warlords = (
        !pinnedWarlordId && entry.unit && isCharacter(entry.unit)
          ? [entry]
          : eligibleWarlordEntries
      ).filter(
        (warlord) =>
          detachmentExclusionReason(warlord, detachment) === null &&
          minimumPointsWithWarlord(
            entry,
            warlord,
            catalogue,
            baseline,
          ) <= baseline.pointsLimit,
      );
      if (warlords.length > 0) {
        byDetachment.set(detachment.id, warlords);
      }
    }
    if (byDetachment.size === 0) {
      ledgerByUnitId.set(entry.summary.id, {
        unitId: entry.summary.id,
        unitName: entry.summary.name,
        role: entry.summary.role,
        pointsFrom: entry.summary.pointsFrom,
        status: "ineligible",
        reasonCode: "NO_COMPATIBLE_WARLORD_AXIS",
        reason:
          "No compatible detachment and Warlord combination fits with this anchor and the required units.",
        structuralFingerprint: null,
        simulationFingerprint: null,
        detachmentId: null,
        warlordUnitId: pinnedWarlordId ?? null,
      });
      continue;
    }
    compatibleWarlordsByEntryAndDetachment.set(
      entry.summary.id,
      byDetachment,
    );
  }

  const scheduledEntries: CatalogueEntry[] = [];
  const remainingEntries = orderedEntries.filter((entry) =>
    compatibleWarlordsByEntryAndDetachment.has(entry.summary.id)
  );
  while (remainingEntries.length > 0) {
    const detachmentOrder = [...eligibleDetachments].sort(
      (left, right) =>
        (detachmentUsage.get(left.id) ?? 0) -
          (detachmentUsage.get(right.id) ?? 0) ||
        left.id.localeCompare(right.id),
    );
    let selectedEntryIndex = -1;
    let selectedDetachment: DetachmentOption | null = null;
    for (const detachment of detachmentOrder) {
      const entryIndex = remainingEntries.findIndex((entry) =>
        compatibleWarlordsByEntryAndDetachment
          .get(entry.summary.id)
          ?.has(detachment.id)
      );
      if (entryIndex < 0) continue;
      selectedEntryIndex = entryIndex;
      selectedDetachment = detachment;
      break;
    }
    if (selectedEntryIndex < 0 || !selectedDetachment) {
      throw new Error(
        "Comparison axis scheduler could not assign a compatible detachment.",
      );
    }
    const [entry] = remainingEntries.splice(selectedEntryIndex, 1);
    const compatibleWarlords = [
      ...(compatibleWarlordsByEntryAndDetachment
        .get(entry.summary.id)
        ?.get(selectedDetachment.id) ?? []),
    ].sort(
      (left, right) =>
        (warlordUsage.get(left.summary.id) ?? 0) -
          (warlordUsage.get(right.summary.id) ?? 0) ||
        left.summary.pointsFrom - right.summary.pointsFrom ||
        left.summary.name.localeCompare(right.summary.name) ||
        left.summary.id.localeCompare(right.summary.id),
    );
    const selectedWarlord = compatibleWarlords[0];
    if (!selectedWarlord) {
      throw new Error(
        "Comparison axis scheduler could not assign a compatible Warlord.",
      );
    }
    assignments.set(entry.summary.id, {
      detachmentId: selectedDetachment.id,
      warlordUnitId: selectedWarlord.summary.id,
    });
    detachmentUsage.set(
      selectedDetachment.id,
      (detachmentUsage.get(selectedDetachment.id) ?? 0) + 1,
    );
    warlordUsage.set(
      selectedWarlord.summary.id,
      (warlordUsage.get(selectedWarlord.summary.id) ?? 0) + 1,
    );
    scheduledEntries.push(entry);
  }

  const recordDetachmentFailure = (
    detachmentId: string,
    reasonCode: string,
    reason: string,
  ) => {
    if (detachmentSuccessfulIds.has(detachmentId)) return;
    detachmentFailureById.set(detachmentId, {
      detachmentId,
      reasonCode,
      reason,
    });
  };
  for (const entry of scheduledEntries) {
    const unit = entry.summary;
    const assignment = assignments.get(unit.id)!;
    // The budget caps full build attempts, not only successful results. This
    // keeps worst-case work bounded even when a catalogue contains many
    // invalid or unsupported combinations; every skipped row still receives
    // an explicit terminal ledger reason.
    if (attempted >= maximumBuilds) {
      ledgerByUnitId.set(unit.id, {
        unitId: unit.id,
        unitName: unit.name,
        role: unit.role,
        pointsFrom: unit.pointsFrom,
        status: "budget-not-expanded",
        reasonCode: "COMPARISON_BUILD_BUDGET",
        reason: `The deterministic comparison budget is ${maximumBuilds} anchor builds.`,
        structuralFingerprint: null,
        simulationFingerprint: null,
        detachmentId: assignment.detachmentId,
        warlordUnitId: assignment.warlordUnitId,
      });
      continue;
    }
    attempted += 1;
    detachmentEvaluatedIds.add(assignment.detachmentId);
    warlordEvaluatedIds.add(assignment.warlordUnitId);
    const built = buildRoster({
      ...comparisonBuildInput,
      detachmentId: assignment.detachmentId,
      forceDispositionId:
        assignment.detachmentId === baseline.detachmentId
          ? baseline.forceDispositionId
          : undefined,
      internalExplorationAnchorUnitIds: [unit.id],
      internalExplorationWarlordUnitId: pinnedWarlordId
        ? undefined
        : assignment.warlordUnitId,
    });
    if (!built.ok || !built.data) {
      const first = built.violations[0];
      const reasonCode = first?.code ?? "ANCHOR_BUILD_FAILED";
      const reason = first?.message ??
        "No legal roster could be completed around this anchor.";
      recordDetachmentFailure(
        assignment.detachmentId,
        reasonCode,
        reason,
      );
      ledgerByUnitId.set(unit.id, {
        unitId: unit.id,
        unitName: unit.name,
        role: unit.role,
        pointsFrom: unit.pointsFrom,
        status: "build-failed",
        reasonCode,
        reason,
        structuralFingerprint: null,
        simulationFingerprint: null,
        detachmentId: assignment.detachmentId,
        warlordUnitId: assignment.warlordUnitId,
      });
      continue;
    }
    const validation = validateRoster(built.data);
    const anchored = built.data.units.some(
      (selection) => selection.unitId === unit.id,
    );
    if (!validation.ok || !anchored) {
      const reasonCode = !anchored
        ? "EXPLORATION_ANCHOR_MISSING"
        : validation.violations[0]?.code ?? "ANCHOR_BUILD_INVALID";
      const reason = !anchored
        ? "The comparison anchor was not present in the constructed roster."
        : validation.violations[0]?.message ??
          "The anchored roster did not validate.";
      recordDetachmentFailure(
        assignment.detachmentId,
        reasonCode,
        reason,
      );
      ledgerByUnitId.set(unit.id, {
        unitId: unit.id,
        unitName: unit.name,
        role: unit.role,
        pointsFrom: unit.pointsFrom,
        status: "build-failed",
        reasonCode,
        reason,
        structuralFingerprint: null,
        simulationFingerprint: null,
        detachmentId: assignment.detachmentId,
        warlordUnitId: assignment.warlordUnitId,
      });
      continue;
    }
    const scored = scoreCandidate(
      built.data,
      [unit.id],
      "catalogue-anchor",
      input.opponents,
    );
    if (!scored) {
      recordDetachmentFailure(
        assignment.detachmentId,
        "ANCHOR_READINESS_UNAVAILABLE",
        "The anchored roster could not be evaluated for mission readiness.",
      );
      ledgerByUnitId.set(unit.id, {
        unitId: unit.id,
        unitName: unit.name,
        role: unit.role,
        pointsFrom: unit.pointsFrom,
        status: "build-failed",
        reasonCode: "ANCHOR_READINESS_UNAVAILABLE",
        reason: "The anchored roster could not be evaluated for mission readiness.",
        structuralFingerprint: null,
        simulationFingerprint: null,
        detachmentId: assignment.detachmentId,
        warlordUnitId: assignment.warlordUnitId,
      });
      continue;
    }
    legal += 1;
    const merged = mergeCandidate(candidates, scored);
    const selectedWarlordId = built.data.units.find(
      (selection) => selection.isWarlord,
    )?.unitId ?? assignment.warlordUnitId;
    warlordSuccessfulIds.add(selectedWarlordId);
    detachmentSuccessfulIds.add(built.data.detachmentId);
    detachmentFailureById.delete(built.data.detachmentId);
    ledgerByUnitId.set(unit.id, {
      unitId: unit.id,
      unitName: unit.name,
      role: unit.role,
      pointsFrom: unit.pointsFrom,
      status: merged.duplicate
        ? "duplicate-candidate"
        : "candidate",
      reasonCode: merged.duplicate ? "DUPLICATE_STRUCTURAL_PAYLOAD" : null,
      reason: merged.duplicate
        ? "This anchor produced the same structural roster as another evaluated option."
        : null,
      structuralFingerprint: merged.candidate.structuralFingerprint,
      simulationFingerprint: merged.candidate.simulationFingerprint,
      detachmentId: built.data.detachmentId,
      warlordUnitId: selectedWarlordId,
    });
    warnings.push(...built.warnings);
  }
  const nativeLedger: OpponentOptionLedgerEntry[] = catalogue.map((entry) => {
    const result = ledgerByUnitId.get(entry.summary.id);
    if (!result) {
      throw new Error(
        `Comparison ledger did not reach a terminal state for ${entry.summary.id}.`,
      );
    }
    return {
      ...result,
      entryKey:
        `faction-native:${entry.summary.factionId}:${entry.summary.id}`,
      origin: "faction-native",
      sourceFactionId: entry.summary.factionId,
      alliedRuleId: null,
      eligibleDetachmentIds: result.detachmentId
        ? [result.detachmentId]
        : [],
      pricingBasis: "native",
      alliedPriceHostKey: null,
      pricingAmbiguous: false,
    };
  });
  const ledger = [...nativeLedger, ...allied.ledger];
  const eligible = scheduledEntries.length;

  const ranked = [...candidates.values()].sort(compareCandidates);
  const recommended = ranked[0];
  const alternatives = selectAlternatives(
    ranked,
    recommended,
    maximumAlternatives,
  );
  const opponentFactionRulesHashes = [
    ...new Set(
      input.opponents
        .map((opponent) =>
          semanticHash(opponent.roster.sourceData, "factionRulesHash")
        )
        .filter((value): value is string => value !== null),
    ),
  ];
  const opponentEvidence = input.opponents.map((opponent) => ({
    templateId: opponent.templateId,
    posture: opponent.posture ?? null,
    composition: opponent.composition ?? null,
    rosterId: opponent.roster.id,
    rosterName: opponent.roster.name,
    structuralFingerprint: rosterStructuralFingerprint(opponent.roster),
    simulationFingerprint: rosterSimulationFingerprint(opponent.roster),
    factionRulesHash: semanticHash(
      opponent.roster.sourceData,
      "factionRulesHash",
    ),
  }));
  const candidateEvidence = ranked.map((candidate) => ({
    structuralFingerprint: candidate.structuralFingerprint,
    simulationFingerprint: candidate.simulationFingerprint,
    rosterId: candidate.roster.id,
    rosterName: candidate.roster.name,
    source: candidate.source,
    anchorUnitIds: candidate.anchorUnitIds,
    totalPoints: candidate.roster.totalPoints,
    pointsUtilization: candidate.pointsUtilization,
    readinessBand: candidate.readinessBand,
    readinessRedDimensions: candidate.readinessRedDimensions,
    evidenceCompleteness: candidate.evidenceCompleteness,
    worstArchetypeScore: candidate.worstArchetypeScore,
    medianArchetypeScore: candidate.medianArchetypeScore,
    massScore: candidate.massScore,
    eliteHeavyScore: candidate.eliteHeavyScore,
    mobilityScore: candidate.mobilityScore,
    matchupScores: candidate.matchupScores,
    units: candidate.roster.units.map((selection) => ({
      unitId: selection.unitId,
      name: selection.name,
      modelCount: selection.modelCount,
      points: selection.points,
      equipment: selection.equipment.map((entry) => ({
        itemId: entry.itemId,
        name: entry.name,
        count: entry.count,
      })),
    })),
  }));
  const budgetExhausted = ledger.some(
    (entry) => entry.status === "budget-not-expanded",
  );
  const notExpanded = ledger.filter(
    (entry) => entry.status === "budget-not-expanded",
  ).length;
  const preScreenedIneligible = ledger.filter(
    (entry) => entry.status === "ineligible",
  ).length;
  const coverage: OpponentOptionComparisonAudit["coverage"] = {
    catalogueRows: catalogue.length,
    catalogueComplete: fullCatalogue.complete,
    catalogueMayBeTruncated: !fullCatalogue.complete,
    coverageMode: !fullCatalogue.complete
      ? "source-truncated"
      : budgetExhausted
        ? "bounded"
        : "complete",
    terminalLedgerRows: ledger.length,
    eligible,
    preScreenedIneligible,
    attempted,
    buildFailures: attempted - legal,
    legal,
    uniqueCandidates: ranked.length,
    opponentRosters: input.opponents.length,
    maximumBuilds,
    budgetExhausted,
    notExpanded,
    expansionComplete: !budgetExhausted,
    stratification: "role-and-cost-band-round-robin-v1",
    allied: {
      rulesOffered: allied.rules.length,
      ruleRows: allied.ledger.length,
      uniqueDatasheets: new Set(
        allied.ledger.map((entry) =>
          `${entry.sourceFactionId}\u0000${entry.unitId}`
        ),
      ).size,
      inventoryOnly: allied.ledger.length,
      selectable: 0,
      attempted: 0,
      expansionSupported: false,
      rules: allied.rules,
    },
    detachments: {
      mode: detachmentMode,
      eligibleIds: eligibleDetachments.map((detachment) => detachment.id),
      evaluatedIds: [...detachmentEvaluatedIds].sort(),
      successfulIds: [...detachmentSuccessfulIds].sort(),
      failures: [...detachmentFailureById.values()].sort((left, right) =>
        left.detachmentId.localeCompare(right.detachmentId)
      ),
      assignment: detachmentMode === "pinned"
        ? "pinned"
        : "least-used-compatible-v1",
    },
    warlords: {
      mode: warlordMode,
      eligibleIds: [...new Set(
        eligibleWarlordEntries.map((entry) => entry.summary.id),
      )].sort(),
      evaluatedIds: [...warlordEvaluatedIds].sort(),
      successfulIds: [...warlordSuccessfulIds].sort(),
      assignment: warlordMode === "pinned"
        ? "pinned"
        : "least-used-compatible-v1",
    },
  };
  const comparisonFingerprint = stableSha256({
    bundleId: baseline.sourceData.bundleId,
    opponentPortfolioHash: input.opponentPortfolioHash ?? null,
    opponents: opponentEvidence,
    candidates: candidateEvidence,
    ledger,
    coverage,
  });
  const audit: OpponentOptionComparisonAudit = {
    schemaVersion: 1,
    resultKind: "opponent-option-comparison",
    method: "stratified-catalogue-axis-comparison-v3",
    comparisonFingerprint,
    deterministic: true,
    source: {
      bundleId: baseline.sourceData.bundleId,
      playerFactionId: baseline.factionId,
      playerFactionRulesHash: semanticHash(
        baseline.sourceData,
        "factionRulesHash",
      ),
      opponentFactionId: opponentFactionIds[0],
      opponentFactionRulesHash:
        opponentFactionRulesHashes.length === 1
          ? opponentFactionRulesHashes[0]
          : null,
      opponentPortfolioHash: input.opponentPortfolioHash ?? null,
      alliedInventoryHash: allied.inventoryHash,
    },
    coverage,
    opponents: opponentEvidence,
    recommendation: {
      structuralFingerprint: recommended.structuralFingerprint,
      simulationFingerprint: recommended.simulationFingerprint,
      rosterId: recommended.roster.id,
      anchorUnitIds: recommended.anchorUnitIds,
    },
    alternatives: alternatives.map(({ candidate, contrast }) => ({
      structuralFingerprint: candidate.structuralFingerprint,
      simulationFingerprint: candidate.simulationFingerprint,
      rosterId: candidate.roster.id,
      anchorUnitIds: candidate.anchorUnitIds,
      contrast,
    })),
    candidates: candidateEvidence,
    ledger,
    limitations: [
      "Equal-weight representative opponent rosters test coverage; they do not estimate metagame prevalence or whole-game win probability.",
      "Selected-profile expected-damage and mission-readiness evidence do not model terrain, deployment, player decisions, or full game sequencing.",
      "Faction rules, detachment abilities, Stratagem sequencing, Leader synergies, and Enhancement effects remain unscored dimensions; their configurations are recorded as bounded rather than treated as zero value.",
      "Damage cells without resolved weapon-profile evidence are counted as incomplete, not as complete zero-output observations.",
      "Complete catalogue ledger coverage is distinct from bounded anchored-roster expansion; budget-not-expanded rows were inventoried but not built.",
      "AlliedRule datasheets are recorded as provenance-rich inventory-only rows. They are not selectable, built, validated, or scored until source-faction identity, host pricing, allied quotas, combat resolution, and export are supported end to end.",
      "Anchored builds are assigned to the least-used compatible detachment and Warlord axes; bounded runs report unevaluated axes instead of constructing a full Cartesian product.",
      "Open-catalogue options are availability evidence, not a claim that the player owns those models.",
    ],
  };
  return {
    ok: true,
    data: {
      recommended,
      alternatives,
      candidates: ranked,
      audit,
    },
    violations: [],
    warnings: [
      ...new Map(
        warnings.map((warning) => [
          `${warning.code}:${warning.message}:${warning.selectionId ?? ""}`,
          warning,
        ]),
      ).values(),
    ],
  };
}
