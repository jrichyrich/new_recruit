import {
  normalizeName,
} from "@alpaca-software/40kdc-data";
import type { UnitView } from "@alpaca-software/40kdc-data";

import { validateRoster } from "./engine";
import {
  missionCards,
  missionMatchups,
  missions,
  units,
} from "./runtime-dataset";
import { rosterExecutionFingerprint } from "./stress-portfolio";
import type {
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
  TesseraConfidence,
  TesseraMissionDemand,
  TesseraMissionReadinessBand,
  TesseraMissionReadinessDimension,
  TesseraMissionReadinessDimensionId,
  TesseraMissionReadinessGuardrail,
  TesseraMissionReadinessMetric,
  TesseraMissionReadinessReport,
  TesseraPrimaryMissionReadiness,
  TesseraSecondaryCardDemand,
} from "./types";

const DIMENSION_LABELS: Record<
  TesseraMissionReadinessDimensionId,
  string
> = {
  "scoring-breadth": "Scoring breadth",
  "control-depth": "Control depth",
  reach: "Reach",
  "action-economy": "Action economy",
  "durable-contesting": "Durable contesting",
  "home-continuity": "Home continuity",
};

const DEMAND_DIMENSIONS: Record<
  TesseraMissionDemand,
  TesseraMissionReadinessDimensionId[]
> = {
  control: ["scoring-breadth", "control-depth"],
  projection: ["reach", "action-economy"],
  action: ["action-economy", "reach"],
  hold: ["durable-contesting", "home-continuity", "control-depth"],
  attrition: [],
};

type ResolvedSelection = {
  selection: RosterDraftV1["units"][number];
  unit: UnitView | null;
  movement: number;
  toughness: number;
  wounds: number;
  save: number;
  invulnerableSave: number | null;
  objectiveControl: number;
  totalWounds: number;
  totalObjectiveControl: number;
  keywords: string[];
  fast: boolean;
  reachable: boolean;
  abilitySourcePaths: string[];
};

function issue(
  code: string,
  message: string,
  severity: "error" | "warn" = "error",
): RosterIssue {
  return { code, message, severity };
}

function resolveUnit(
  roster: RosterDraftV1,
  selection: RosterDraftV1["units"][number],
): UnitView | null {
  return (
    units
      .byFaction(roster.factionId)
      .find((unit) => unit.id === selection.unitId) ??
    units.all.find(
      (unit) =>
        unit.id === selection.unitId &&
        normalizeName(unit.name) === normalizeName(selection.name),
    ) ??
    units.getAny(selection.unitId) ??
    null
  );
}

function effectContainsType(value: unknown, type: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => effectContainsType(entry, type));
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === type) return true;
  return Object.values(record).some((entry) =>
    effectContainsType(entry, type),
  );
}

function mobilityAbilitySources(unit: UnitView): string[] {
  const paths: string[] = [];
  for (const abilityId of unit.raw.ability_ids ?? []) {
    const normalizedId = normalizeName(abilityId);
    if (
      normalizedId === "deep strike" ||
      normalizedId === "infiltrators" ||
      normalizedId.startsWith("scouts ")
    ) {
      paths.push(`/units/${unit.id}/ability_ids/${abilityId}`);
      continue;
    }
    const ability = unit.abilities.find(
      (candidate) => candidate.id === abilityId,
    );
    if (
      ability &&
      (effectContainsType(ability.raw.effect, "deep-strike") ||
        effectContainsType(
          ability.raw.effect,
          "strategic-reserves-arrival",
        ))
    ) {
      paths.push(`/abilities/${abilityId}/effect/type`);
    }
  }
  return paths;
}

function resolvedSelections(roster: RosterDraftV1): {
  selections: ResolvedSelection[];
  unresolvedSelectionIds: string[];
} {
  const unresolvedSelectionIds: string[] = [];
  const selections = roster.units.map((selection) => {
    const unit = resolveUnit(roster, selection);
    if (!unit) unresolvedSelectionIds.push(selection.selectionId);
    const profile = unit?.profileAt();
    const movement = Number(profile?.M ?? 0);
    const toughness = Number(profile?.T ?? 0);
    const wounds = Number(profile?.W ?? 0);
    const save = Number(profile?.Sv ?? 7);
    const invulnerableSave =
      profile?.invuln_sv == null
        ? null
        : Number(profile.invuln_sv);
    const objectiveControl = Number(profile?.OC ?? 0);
    const keywords = [
      ...(unit?.raw.keywords ?? []),
      ...(unit?.raw.faction_keywords ?? []),
    ].map(normalizeName);
    const abilitySourcePaths = unit ? mobilityAbilitySources(unit) : [];
    const fast =
      movement >= 10 ||
      keywords.includes("fly") ||
      keywords.includes("mounted") ||
      abilitySourcePaths.length > 0;
    return {
      selection,
      unit,
      movement,
      toughness,
      wounds,
      save,
      invulnerableSave,
      objectiveControl,
      totalWounds: wounds * selection.modelCount,
      totalObjectiveControl:
        objectiveControl * selection.modelCount,
      keywords,
      fast,
      reachable: fast || movement >= 7,
      abilitySourcePaths,
    };
  });
  return { selections, unresolvedSelectionIds };
}

function bandForThresholds(
  value: number,
  redBelow: number,
  greenAtOrAbove: number,
): TesseraMissionReadinessBand {
  if (value < redBelow) return "red";
  if (value >= greenAtOrAbove) return "green";
  return "amber";
}

function worstBand(
  bands: TesseraMissionReadinessBand[],
): TesseraMissionReadinessBand {
  if (bands.length === 0 || bands.every((band) => band === "unknown")) {
    return "unknown";
  }
  if (bands.includes("red")) return "red";
  if (bands.includes("unknown")) return "unknown";
  if (bands.includes("amber")) return "amber";
  return "green";
}

function metric(
  input: Omit<TesseraMissionReadinessMetric, "selectionIds" | "sourcePaths"> & {
    providers: ResolvedSelection[];
    source: (provider: ResolvedSelection) => string[];
  },
): TesseraMissionReadinessMetric {
  return {
    id: input.id,
    label: input.label,
    value: input.value,
    normalizedValue: input.normalizedValue,
    unit: input.unit,
    ...(input.redBelow === undefined
      ? {}
      : { redBelow: input.redBelow }),
    ...(input.greenAtOrAbove === undefined
      ? {}
      : { greenAtOrAbove: input.greenAtOrAbove }),
    selectionIds: input.providers.map(
      (provider) => provider.selection.selectionId,
    ),
    sourcePaths: input.providers.flatMap(input.source),
  };
}

function dimension(
  id: TesseraMissionReadinessDimensionId,
  band: TesseraMissionReadinessBand,
  confidence: TesseraConfidence,
  metrics: TesseraMissionReadinessMetric[],
  providers: ResolvedSelection[],
  evidence: string[],
): TesseraMissionReadinessDimension {
  return {
    id,
    label: DIMENSION_LABELS[id],
    band,
    confidence,
    metrics,
    providerSelectionIds: [
      ...new Set(
        providers.map((provider) => provider.selection.selectionId),
      ),
    ],
    evidence,
  };
}

function structuredTokens(value: unknown): Set<string> {
  const tokens = new Set<string>();
  const visit = (candidate: unknown, key = "") => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, key);
      return;
    }
    if (!candidate || typeof candidate !== "object") {
      if (
        typeof candidate === "string" &&
        key !== "name" &&
        key !== "text" &&
        key !== "description"
      ) {
        tokens.add(normalizeName(candidate));
      }
      return;
    }
    for (const [childKey, entry] of Object.entries(
      candidate as Record<string, unknown>,
    )) {
      if (
        childKey === "name" ||
        childKey === "text" ||
        childKey === "description"
      ) {
        continue;
      }
      visit(entry, childKey);
    }
  };
  visit(value);
  return tokens;
}

function demandsForCard(card: unknown): TesseraMissionDemand[] {
  const tokens = structuredTokens(card);
  const demands = new Set<TesseraMissionDemand>();
  const hasAny = (...values: string[]) =>
    values.some((value) => tokens.has(normalizeName(value)));

  if (
    hasAny(
      "controlled-objective",
      "controlled-non-home-objective",
      "controlled-objective-in-enemy-territory",
      "controls-objective",
      "objective-majority",
      "objective-control",
      "objective-newly-controlled-this-turn",
    )
  ) {
    demands.add("control");
  }
  if (
    hasAny(
      "enemy-territory",
      "opponent-deployment-zone",
      "controlled-objective-in-enemy-territory",
      "central",
      "controlled-non-home-objective",
      "objective-newly-controlled-this-turn",
    )
  ) {
    demands.add("projection");
  }
  if (
    hasAny(
      "action-completed",
      "perform-action",
      "terrain-area-tag",
      "objective-tag",
      "unit-tag",
    )
  ) {
    demands.add("action");
  }
  if (
    hasAny(
      "your-home",
      "central",
      "end-of-phase",
      "command",
      "end-of-turn",
    ) &&
    demands.has("control")
  ) {
    demands.add("hold");
  }
  if (
    hasAny(
      "destroyed-unit",
      "destroyed-model",
      "models-destroyed",
      "units-destroyed",
      "wounds-inflicted",
      "unit-destroyed",
    )
  ) {
    demands.add("attrition");
  }
  const cardRecord =
    card && typeof card === "object"
      ? (card as Record<string, unknown>)
      : null;
  if (
    Array.isArray(cardRecord?.actions) &&
    cardRecord.actions.length > 0
  ) {
    demands.add("action");
  }
  return [...demands];
}

function dimensionsForDemands(
  demands: TesseraMissionDemand[],
): TesseraMissionReadinessDimensionId[] {
  const result: TesseraMissionReadinessDimensionId[] = [];
  for (const demand of demands) {
    for (const id of DEMAND_DIMENSIONS[demand]) {
      if (!result.includes(id)) result.push(id);
    }
  }
  return result;
}

function primaryMissionReadiness(
  roster: RosterDraftV1,
  dimensions: TesseraMissionReadinessDimension[],
): TesseraPrimaryMissionReadiness[] {
  return missionMatchups.all
    .filter(
      (matchup) =>
        matchup.disposition === roster.forceDispositionId,
    )
    .sort((left, right) =>
      left.opponent_disposition.localeCompare(
        right.opponent_disposition,
      ),
    )
    .map((matchup) => {
      const mission = missions.get(matchup.mission_id);
      const card = missionCards.get(matchup.mission_id);
      const demands = card ? demandsForCard(card) : [];
      const dimensionIds = dimensionsForDemands(demands);
      const relevant = dimensionIds
        .map((id) => dimensions.find((entry) => entry.id === id))
        .filter(
          (
            entry,
          ): entry is TesseraMissionReadinessDimension =>
            entry !== undefined,
        );
      return {
        matchupId: matchup.id,
        missionId: matchup.mission_id,
        missionName:
          mission?.name ?? card?.name ?? matchup.mission_id,
        opponentDispositionId: matchup.opponent_disposition,
        demands,
        dimensionIds,
        band: worstBand(relevant.map((entry) => entry.band)),
        confidence:
          card && demands.length > 0 ? "high" : "ambiguous",
        sourcePaths: [
          `/mission-matchups/${matchup.id}`,
          ...(card ? [`/mission-cards/${card.id}`] : []),
        ],
      };
    });
}

function secondaryCardDemands(): TesseraSecondaryCardDemand[] {
  return missionCards.all
    .filter((card) => card.card_type !== "primary")
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    )
    .map((card) => {
      const demands = demandsForCard(card);
      return {
        cardId: card.id,
        cardName: card.name,
        demands,
        confidence: demands.length > 0 ? "high" : "ambiguous",
        sourcePaths: [`/mission-cards/${card.id}`],
      };
    });
}

export function analyzeMissionReadiness(
  roster: RosterDraftV1,
): ResultEnvelope<TesseraMissionReadinessReport> {
  const validation = validateRoster(roster);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }
  const { selections, unresolvedSelectionIds } =
    resolvedSelections(roster);
  const scale = Math.max(0.1, roster.pointsLimit / 1000);
  const confidence: TesseraConfidence =
    unresolvedSelectionIds.length === 0 ? "high" : "review";
  const scoreable = selections.filter(
    (entry) => entry.totalObjectiveControl > 0,
  );
  const controlThree = selections.filter(
    (entry) => entry.totalObjectiveControl >= 3,
  );
  const fast = selections.filter((entry) => entry.fast);
  const reachable = selections.filter((entry) => entry.reachable);
  const cheap = selections.filter(
    (entry) =>
      entry.selection.points <= roster.pointsLimit * 0.15 &&
      entry.reachable &&
      !entry.keywords.includes("aircraft") &&
      !entry.keywords.includes("fortification"),
  );
  const cheapAndFast = cheap.filter((entry) => entry.fast);
  const durable = selections.filter(
    (entry) =>
      entry.totalObjectiveControl >= 3 &&
      (entry.toughness >= 7 ||
        entry.totalWounds >= 10 ||
        entry.save <= 2 ||
        (entry.invulnerableSave !== null &&
          entry.invulnerableSave <= 4) ||
        entry.selection.modelCount >= 10),
  );
  const budgetHolders = selections.filter(
    (entry) =>
      entry.totalObjectiveControl > 0 &&
      entry.selection.points <= roster.pointsLimit * 0.1,
  );
  const durableHolders = durable.filter(
    (entry) => entry.totalObjectiveControl > 0,
  );

  const scoringNormalized = scoreable.length / scale;
  const totalObjectiveControl = selections.reduce(
    (sum, entry) => sum + entry.totalObjectiveControl,
    0,
  );
  const objectiveControlNormalized = totalObjectiveControl / scale;
  const controlThreeNormalized = controlThree.length / scale;
  const reachableNormalized = reachable.length / scale;
  const fastNormalized = fast.length / scale;
  const cheapNormalized = cheap.length / scale;
  const cheapFastNormalized = cheapAndFast.length / scale;
  const durableNormalized = durable.length / scale;

  const dimensions: TesseraMissionReadinessDimension[] = [
    dimension(
      "scoring-breadth",
      bandForThresholds(scoringNormalized, 4, 6),
      confidence,
      [
        metric({
          id: "scoreable-units",
          label: "Scoreable units",
          value: scoreable.length,
          normalizedValue: scoringNormalized,
          unit: "units",
          redBelow: 4,
          greenAtOrAbove: 6,
          providers: scoreable,
          source: (entry) => [
            `/units/${entry.selection.selectionId}/profiles/0/OC`,
          ],
        }),
      ],
      scoreable,
      [
        `${scoreable.length} selections have positive Objective Control.`,
      ],
    ),
    dimension(
      "control-depth",
      objectiveControlNormalized < 14 ||
        controlThreeNormalized < 2
        ? "red"
        : objectiveControlNormalized >= 24 &&
            controlThreeNormalized >= 3
          ? "green"
          : "amber",
      confidence,
      [
        metric({
          id: "total-objective-control",
          label: "Total Objective Control",
          value: totalObjectiveControl,
          normalizedValue: objectiveControlNormalized,
          unit: "objective-control",
          redBelow: 14,
          greenAtOrAbove: 24,
          providers: scoreable,
          source: (entry) => [
            `/units/${entry.selection.selectionId}/profiles/0/OC`,
            `/roster/units/${entry.selection.selectionId}/modelCount`,
          ],
        }),
        metric({
          id: "oc-three-units",
          label: "Selections with at least 3 total OC",
          value: controlThree.length,
          normalizedValue: controlThreeNormalized,
          unit: "units",
          redBelow: 2,
          greenAtOrAbove: 3,
          providers: controlThree,
          source: (entry) => [
            `/units/${entry.selection.selectionId}/profiles/0/OC`,
            `/roster/units/${entry.selection.selectionId}/modelCount`,
          ],
        }),
      ],
      [...new Set([...scoreable, ...controlThree])],
      [
        `${totalObjectiveControl} total OC across ${controlThree.length} selections with at least 3 total OC.`,
      ],
    ),
    dimension(
      "reach",
      reachableNormalized < 2 || fastNormalized < 1
        ? "red"
        : reachableNormalized >= 3 && fastNormalized >= 2
          ? "green"
          : "amber",
      confidence,
      [
        metric({
          id: "reachable-units",
          label: "Reachable units",
          value: reachable.length,
          normalizedValue: reachableNormalized,
          unit: "units",
          redBelow: 2,
          greenAtOrAbove: 3,
          providers: reachable,
          source: (entry) => [
            `/units/${entry.selection.selectionId}/profiles/0/M`,
            `/units/${entry.selection.selectionId}/keywords`,
            ...entry.abilitySourcePaths,
          ],
        }),
        metric({
          id: "fast-units",
          label: "Fast units",
          value: fast.length,
          normalizedValue: fastNormalized,
          unit: "units",
          redBelow: 1,
          greenAtOrAbove: 2,
          providers: fast,
          source: (entry) => [
            `/units/${entry.selection.selectionId}/profiles/0/M`,
            `/units/${entry.selection.selectionId}/keywords`,
            ...entry.abilitySourcePaths,
          ],
        }),
      ],
      reachable,
      [
        `${reachable.length} reachable selections, including ${fast.length} fast selections.`,
      ],
    ),
    dimension(
      "action-economy",
      cheapNormalized < 2 || cheapFastNormalized < 1
        ? "red"
        : cheapNormalized >= 3 && cheapFastNormalized >= 2
          ? "green"
          : "amber",
      confidence,
      [
        metric({
          id: "cheap-action-units",
          label: "Cheap action units",
          value: cheap.length,
          normalizedValue: cheapNormalized,
          unit: "units",
          redBelow: 2,
          greenAtOrAbove: 3,
          providers: cheap,
          source: (entry) => [
            `/roster/units/${entry.selection.selectionId}/points`,
            `/units/${entry.selection.selectionId}/profiles/0/M`,
            `/units/${entry.selection.selectionId}/keywords`,
          ],
        }),
        metric({
          id: "cheap-fast-action-units",
          label: "Cheap and fast action units",
          value: cheapAndFast.length,
          normalizedValue: cheapFastNormalized,
          unit: "units",
          redBelow: 1,
          greenAtOrAbove: 2,
          providers: cheapAndFast,
          source: (entry) => [
            `/roster/units/${entry.selection.selectionId}/points`,
            `/units/${entry.selection.selectionId}/profiles/0/M`,
            `/units/${entry.selection.selectionId}/keywords`,
            ...entry.abilitySourcePaths,
          ],
        }),
      ],
      cheap,
      [
        `${cheap.length} cheap mobile selections, including ${cheapAndFast.length} fast selections.`,
      ],
    ),
    dimension(
      "durable-contesting",
      bandForThresholds(durableNormalized, 1, 2),
      confidence,
      [
        metric({
          id: "durable-contesters",
          label: "Durable contesting units",
          value: durable.length,
          normalizedValue: durableNormalized,
          unit: "units",
          redBelow: 1,
          greenAtOrAbove: 2,
          providers: durable,
          source: (entry) => [
            `/units/${entry.selection.selectionId}/profiles/0`,
            `/roster/units/${entry.selection.selectionId}/modelCount`,
          ],
        }),
      ],
      durable,
      [
        `${durable.length} selections meet the structured durability and OC thresholds.`,
      ],
    ),
    dimension(
      "home-continuity",
      budgetHolders.length === 0 || durableHolders.length === 0
        ? "red"
        : new Set([
              ...budgetHolders.map(
                (entry) => entry.selection.selectionId,
              ),
              ...durableHolders.map(
                (entry) => entry.selection.selectionId,
              ),
            ]).size >= 2
          ? "green"
          : "amber",
      confidence,
      [
        metric({
          id: "budget-holders",
          label: "Budget home holders",
          value: budgetHolders.length,
          normalizedValue: budgetHolders.length / scale,
          unit: "units",
          redBelow: 1,
          greenAtOrAbove: 1,
          providers: budgetHolders,
          source: (entry) => [
            `/roster/units/${entry.selection.selectionId}/points`,
            `/units/${entry.selection.selectionId}/profiles/0/OC`,
          ],
        }),
        metric({
          id: "durable-holders",
          label: "Durable home holders",
          value: durableHolders.length,
          normalizedValue: durableHolders.length / scale,
          unit: "units",
          redBelow: 1,
          greenAtOrAbove: 1,
          providers: durableHolders,
          source: (entry) => [
            `/units/${entry.selection.selectionId}/profiles/0`,
            `/roster/units/${entry.selection.selectionId}/modelCount`,
          ],
        }),
      ],
      [...budgetHolders, ...durableHolders],
      [
        `${budgetHolders.length} budget holders and ${durableHolders.length} durable holders.`,
      ],
    ),
  ];

  const warnings =
    unresolvedSelectionIds.length === 0
      ? []
      : [
          `Could not resolve structured profile data for ${unresolvedSelectionIds.length} roster selections.`,
        ];
  return {
    ok: true,
    data: {
      schemaVersion: 1,
      scoreDefinitionVersion: "mission-readiness-v1",
      rosterFingerprint: rosterExecutionFingerprint(roster),
      overallBand: worstBand(
        dimensions.map((entry) => entry.band),
      ),
      dimensions,
      primaryMissions: primaryMissionReadiness(roster, dimensions),
      secondaryCards: secondaryCardDemands(),
      sourceData: roster.sourceData,
      warnings,
    },
    violations: [],
    warnings: [
      ...validation.warnings,
      ...warnings.map((message) =>
        issue("MISSION_READINESS_DATA_INCOMPLETE", message, "warn"),
      ),
    ],
  };
}

function bandRank(band: TesseraMissionReadinessBand): number {
  if (band === "green") return 3;
  if (band === "amber") return 2;
  if (band === "red") return 1;
  return 0;
}

export function assessMissionReadinessRevisionGuardrail(
  baseline: TesseraMissionReadinessReport,
  revised: TesseraMissionReadinessReport,
): TesseraMissionReadinessGuardrail {
  const reasons: string[] = [];
  const newRedDimensions = revised.dimensions
    .filter((candidate) => {
      const before = baseline.dimensions.find(
        (dimension) => dimension.id === candidate.id,
      );
      return (
        candidate.band === "red" &&
        before !== undefined &&
        before.band !== "red"
      );
    })
    .map((dimension) => dimension.id);
  if (newRedDimensions.length > 0) {
    reasons.push(
      `Revision creates red readiness dimensions: ${newRedDimensions.join(", ")}.`,
    );
  }

  const baselineRedCount = baseline.dimensions.filter(
    (dimension) => dimension.band === "red",
  ).length;
  const revisedRedCount = revised.dimensions.filter(
    (dimension) => dimension.band === "red",
  ).length;
  if (revisedRedCount > baselineRedCount) {
    reasons.push("Revision increases the number of red dimensions.");
  }
  if (
    bandRank(revised.overallBand) < bandRank(baseline.overallBand)
  ) {
    reasons.push("Revision downgrades overall mission readiness.");
  }

  for (const mission of revised.primaryMissions) {
    const before = baseline.primaryMissions.find(
      (candidate) => candidate.matchupId === mission.matchupId,
    );
    if (
      before &&
      before.band !== "red" &&
      mission.band === "red"
    ) {
      reasons.push(
        `Revision turns primary mission ${mission.missionName} red.`,
      );
    }
  }

  // Provider selection ids are intentionally not compared across rebuilt
  // drafts: ids are instance-local and can change without changing mission
  // capability. Dimension bands and structured metrics are the guardrail.
  const removedEssentialProviders: string[] = [];

  for (const revisedDimension of revised.dimensions) {
    const before = baseline.dimensions.find(
      (dimension) => dimension.id === revisedDimension.id,
    );
    if (
      before?.band === "red" &&
      revisedDimension.band !== "red" &&
      revisedDimension.confidence !== "high"
    ) {
      reasons.push(
        `${revisedDimension.label} relies on non-high-confidence data to avoid red.`,
      );
    }
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    baselineBand: baseline.overallBand,
    revisedBand: revised.overallBand,
    newRedDimensions,
    removedEssentialProviders: [
      ...new Set(removedEssentialProviders),
    ],
  };
}
