import { normalizeName } from "@alpaca-software/40kdc-data";
import type { UnitView } from "@alpaca-software/40kdc-data";

import {
  FOUNDATION_CODEX_V2_HEURISTIC_PACK,
  FOUNDATION_CODEX_V2_HEURISTIC_PACK_SHA256,
} from "./competitive-heuristics";
import { resolveFactionUnit } from "./engine";
import { analyzeMissionReadiness } from "./mission-readiness";
import type {
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
  TesseraMissionReadinessDimension,
  TesseraMissionReadinessReport,
} from "./types";

export type CompetitiveCoachingMode = "concise" | "full";

export type CompetitiveCoachingOptions = {
  mode?: CompetitiveCoachingMode;
  missionContext?: {
    missionPackId: string;
    missionId?: string;
  };
  terrainContext?: {
    formatId: string;
    layoutId?: string;
  };
};

export type CompetitiveEconomicRole =
  | "trading-piece"
  | "anvil"
  | "tech-piece"
  | "force-multiplier";

export type CompetitiveCoachingConfidence =
  | "high"
  | "medium"
  | "low"
  | "review";

export type CompetitiveRoleAssignment = {
  role: CompetitiveEconomicRole;
  confidence: CompetitiveCoachingConfidence;
  rationale: string;
  heuristicIds: string[];
  sourcePaths: string[];
};

export type CompetitiveUnitCoaching = {
  selectionId: string;
  unitId: string;
  name: string;
  modelCount: number;
  points: number;
  pointsShare: number;
  roles: CompetitiveRoleAssignment[];
  metrics: {
    totalObjectiveControl: number | null;
    objectiveControlPerPoint: number | null;
    objectiveControlPer100Points: number | null;
    totalWounds: number | null;
    woundsPerPoint: number | null;
    woundsPer100Points: number | null;
    contextualOcBenchmark: {
      value: number;
      comparison: "above-or-equal" | "below" | "unavailable";
      authority: "contextual-heuristic";
    };
  };
  mobility: {
    movement: number | null;
    reachable: boolean;
    fast: boolean;
    mobilityRuleIds: string[];
    evidence: string[];
    sourcePaths: string[];
  };
  actionEconomy: {
    candidate: boolean;
    budgetHolderCandidate: boolean;
    reasons: string[];
    sourcePaths: string[];
  };
  expectedOperationalLifecycle: string;
  caveats: string[];
};

export type CoachingApplicabilityStatus =
  | "applied"
  | "not-applicable-edition"
  | "omitted-mode"
  | "omitted-missing-context"
  | "omitted-invalid-context";

export type CoachingApplicability = {
  status: CoachingApplicabilityStatus;
  reason: string;
};

export type CompetitiveCoachingAdvice = {
  id: string;
  category:
    | "resource-conversion"
    | "role-coverage"
    | "mission-readiness"
    | "variance"
    | "mission"
    | "terrain";
  priority: "high" | "medium" | "low";
  confidence: CompetitiveCoachingConfidence;
  text: string;
  selectionIds: string[];
  heuristicIds: string[];
  sourcePaths: string[];
};

export type CompetitiveCoachingReport = {
  schemaVersion: 1;
  reportKind: "competitive-coaching";
  mode: CompetitiveCoachingMode;
  rosterFingerprint: string;
  heuristicPack: {
    id: "foundation-codex-v2";
    title: string;
    version: "2.0.0";
    packKind: "competitive-coaching-heuristics";
    authority: "user-supplied-reference";
    officialRules: false;
    contentSha256: string;
    gameEdition: "11th";
  };
  applicability: {
    generic: CoachingApplicability;
    missionSpecific: CoachingApplicability;
    terrainSpecific: CoachingApplicability;
    opponentSpecificTrade: CoachingApplicability;
  };
  summary: {
    totalPoints: number;
    selectionCount: number;
    totalObjectiveControl: number;
    objectiveControlPerPoint: number | null;
    totalWounds: number;
    woundsPerPoint: number | null;
    selectionActivationUpperBound: number;
    activationEstimateBasis: "roster-selections-before-attachments";
    reachableSelectionCount: number;
    fastSelectionCount: number;
    actionCandidateCount: number;
    roleCounts: Record<CompetitiveEconomicRole, number>;
    missionReadinessBand: TesseraMissionReadinessReport["overallBand"];
  };
  units: CompetitiveUnitCoaching[];
  missionReadiness: TesseraMissionReadinessReport;
  advice: CompetitiveCoachingAdvice[];
  disclaimer: string;
  warningCodes: string[];
};

type ResolvedCoachingSelection = {
  selection: RosterDraftV1["units"][number];
  unit: UnitView | null;
  movement: number | null;
  toughness: number | null;
  wounds: number | null;
  save: number | null;
  invulnerableSave: number | null;
  objectiveControl: number | null;
  totalWounds: number | null;
  totalObjectiveControl: number | null;
  pointsShare: number;
  keywords: string[];
  abilityIds: string[];
  mobilityRuleIds: string[];
  supportAbilityIds: string[];
  selectedWeaponIds: string[];
  fast: boolean;
  reachable: boolean;
};

const ROLE_ORDER: CompetitiveEconomicRole[] = [
  "trading-piece",
  "anvil",
  "tech-piece",
  "force-multiplier",
];

function issue(
  code: string,
  message: string,
  severity: "error" | "warn" = "error",
): RosterIssue {
  return { code, message, severity };
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function profileNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function resolveUnit(
  roster: RosterDraftV1,
  selection: RosterDraftV1["units"][number],
): UnitView | null {
  return resolveFactionUnit(
    selection.unitId,
    roster.factionId,
  ) ?? null;
}

function isMobilityAbility(abilityId: string): boolean {
  const normalized = normalizeName(abilityId);
  return (
    normalized === "deep strike" ||
    normalized === "infiltrators" ||
    normalized.startsWith("scouts ") ||
    normalized.includes("redeploy") ||
    normalized.includes("strategic reserves")
  );
}

function isSupportAbility(abilityId: string): boolean {
  const normalized = normalizeName(abilityId);
  return (
    normalized === "leader" ||
    normalized.includes("aura") ||
    normalized.includes("banner") ||
    normalized.includes("vexilla") ||
    normalized.includes("command") ||
    normalized.includes("orders")
  );
}

function resolveSelection(
  roster: RosterDraftV1,
  selection: RosterDraftV1["units"][number],
): ResolvedCoachingSelection {
  const unit = resolveUnit(roster, selection);
  const profile = unit?.profileAt();
  const movement = profileNumber(profile?.M);
  const toughness = profileNumber(profile?.T);
  const wounds = profileNumber(profile?.W);
  const save = profileNumber(profile?.Sv);
  const invulnerableSave = profileNumber(profile?.invuln_sv);
  const objectiveControl = profileNumber(profile?.OC);
  const keywords = [
    ...(unit?.raw.keywords ?? []),
    ...(unit?.raw.faction_keywords ?? []),
  ].map(normalizeName);
  const abilityIds = [...(unit?.raw.ability_ids ?? [])].sort();
  const mobilityRuleIds = abilityIds.filter(isMobilityAbility);
  const supportAbilityIds = abilityIds.filter(isSupportAbility);
  const selectedWeaponIds = selection.equipment
    .filter((equipment) =>
      unit?.weapons.some((weapon) => weapon.id === equipment.itemId),
    )
    .map((equipment) => equipment.itemId)
    .sort();
  const fast =
    (movement ?? 0) >=
      FOUNDATION_CODEX_V2_HEURISTIC_PACK.thresholds.fastMovement ||
    keywords.includes("fly") ||
    keywords.includes("mounted") ||
    mobilityRuleIds.length > 0;
  const reachable =
    fast ||
    (movement ?? 0) >=
      FOUNDATION_CODEX_V2_HEURISTIC_PACK.thresholds
        .reachableMovement;
  return {
    selection,
    unit,
    movement,
    toughness,
    wounds,
    save,
    invulnerableSave,
    objectiveControl,
    totalWounds:
      wounds === null ? null : wounds * selection.modelCount,
    totalObjectiveControl:
      objectiveControl === null
        ? null
        : objectiveControl * selection.modelCount,
    pointsShare:
      roster.pointsLimit > 0
        ? round(selection.points / roster.pointsLimit)
        : 0,
    keywords,
    abilityIds,
    mobilityRuleIds,
    supportAbilityIds,
    selectedWeaponIds,
    fast,
    reachable,
  };
}

function sourcePath(
  selection: ResolvedCoachingSelection,
  field: string,
): string {
  return `/runtime/units/${selection.selection.unitId}/${field}`;
}

function roleAssignment(
  role: CompetitiveEconomicRole,
  confidence: CompetitiveCoachingConfidence,
  rationale: string,
  selection: ResolvedCoachingSelection,
  extraSourcePaths: string[] = [],
): CompetitiveRoleAssignment {
  return {
    role,
    confidence,
    rationale,
    heuristicIds: ["economic-role-taxonomy"],
    sourcePaths: [
      `/roster/units/${selection.selection.selectionId}`,
      ...extraSourcePaths,
    ],
  };
}

function classifyRoles(
  selection: ResolvedCoachingSelection,
  actionProviderIds: ReadonlySet<string>,
  durableProviderIds: ReadonlySet<string>,
): CompetitiveRoleAssignment[] {
  const assignments: CompetitiveRoleAssignment[] = [];
  const id = selection.selection.selectionId;
  const aircraftOrFortification =
    selection.keywords.includes("aircraft") ||
    selection.keywords.includes("fortification");
  const budgetHolder =
    (selection.totalObjectiveControl ?? 0) > 0 &&
    selection.pointsShare <=
      FOUNDATION_CODEX_V2_HEURISTIC_PACK.thresholds
        .budgetHolderMaxRosterShare;
  const actionCandidate = actionProviderIds.has(id);
  const durable = durableProviderIds.has(id);
  const hasOffensiveEvidence =
    selection.selectedWeaponIds.length > 0 ||
    selection.selection.tags.includes("shooting") ||
    selection.selection.tags.includes("melee");
  const tradingPiece =
    hasOffensiveEvidence &&
    !aircraftOrFortification &&
    (selection.fast ||
      selection.pointsShare <=
        FOUNDATION_CODEX_V2_HEURISTIC_PACK.thresholds
          .techPieceMaxRosterShare ||
      !durable);
  const forceMultiplier =
    selection.selection.enhancementId !== null ||
    (selection.keywords.includes("character") &&
      selection.supportAbilityIds.length > 0);

  if (tradingPiece) {
    assignments.push(
      roleAssignment(
        "trading-piece",
        selection.selectedWeaponIds.length > 0 ? "medium" : "low",
        "Its selected offensive profiles can be committed to an exchange, but target value and reliability still require matchup simulation.",
        selection,
        selection.selectedWeaponIds.map(
          (weaponId) =>
            `/runtime/weapons/${weaponId}/profiles`,
        ),
      ),
    );
  }
  if (durable) {
    assignments.push(
      roleAssignment(
        "anvil",
        "high",
        "It meets the existing structured mission-readiness thresholds for a durable Objective Control provider.",
        selection,
        [
          sourcePath(selection, "profiles/0"),
          `/roster/units/${id}/modelCount`,
        ],
      ),
    );
  }
  if (actionCandidate || budgetHolder) {
    assignments.push(
      roleAssignment(
        "tech-piece",
        actionCandidate ? "high" : "medium",
        actionCandidate
          ? "Its cost and structured reach make it a candidate for mission actions or positional scoring."
          : "Its low roster share and positive Objective Control make it a candidate for a protected holding assignment.",
        selection,
        [
          sourcePath(selection, "profiles/0/M"),
          sourcePath(selection, "profiles/0/OC"),
          `/roster/units/${id}/points`,
        ],
      ),
    );
  }
  if (forceMultiplier) {
    assignments.push(
      roleAssignment(
        "force-multiplier",
        selection.supportAbilityIds.length > 0 ? "high" : "medium",
        "Its structured Leader/support evidence or selected enhancement indicates that preserving its support window may improve other selections.",
        selection,
        [
          ...selection.supportAbilityIds.map(
            (abilityId) => `/runtime/abilities/${abilityId}`,
          ),
          ...(selection.selection.enhancementId
            ? [
                `/roster/units/${id}/enhancementId`,
              ]
            : []),
        ],
      ),
    );
  }

  if (assignments.length === 0) {
    assignments.push(
      roleAssignment(
        "trading-piece",
        "low",
        "No stronger structured economic role was detected; treat this as a provisional exchange role and review its datasheet and matchup purpose.",
        selection,
        [sourcePath(selection, "profiles/0")],
      ),
    );
  }
  return assignments.sort(
    (left, right) =>
      ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role),
  );
}

function lifecycleForRoles(
  roles: CompetitiveRoleAssignment[],
): string {
  const ids = new Set(roles.map((entry) => entry.role));
  const steps: string[] = [];
  if (ids.has("force-multiplier")) {
    steps.push("preserve its support window while beneficiaries remain active");
  }
  if (ids.has("tech-piece")) {
    steps.push("assign it a scoring, screening, or action task before exposing it");
  }
  if (ids.has("anvil")) {
    steps.push("stage safely, then contest an objective across multiple activations");
  }
  if (ids.has("trading-piece")) {
    steps.push("commit it only when the exchange advances or protects the scoring plan");
  }
  return `${steps.join("; ")}.`;
}

function dimension(
  report: TesseraMissionReadinessReport,
  id: TesseraMissionReadinessDimension["id"],
): TesseraMissionReadinessDimension | null {
  return report.dimensions.find((entry) => entry.id === id) ?? null;
}

function buildUnitCoaching(
  selection: ResolvedCoachingSelection,
  actionProviderIds: ReadonlySet<string>,
  durableProviderIds: ReadonlySet<string>,
): CompetitiveUnitCoaching {
  const roles = classifyRoles(
    selection,
    actionProviderIds,
    durableProviderIds,
  );
  const totalObjectiveControl = selection.totalObjectiveControl;
  const totalWounds = selection.totalWounds;
  const objectiveControlPerPoint =
    totalObjectiveControl === null
      ? null
      : ratio(totalObjectiveControl, selection.selection.points);
  const woundsPerPoint =
    totalWounds === null
      ? null
      : ratio(totalWounds, selection.selection.points);
  const benchmark =
    FOUNDATION_CODEX_V2_HEURISTIC_PACK.thresholds
      .contextualOcPerPointBenchmark;
  const budgetHolderCandidate =
    (totalObjectiveControl ?? 0) > 0 &&
    selection.pointsShare <=
      FOUNDATION_CODEX_V2_HEURISTIC_PACK.thresholds
        .budgetHolderMaxRosterShare;
  const actionCandidate = actionProviderIds.has(
    selection.selection.selectionId,
  );
  const actionReasons: string[] = [];
  if (actionCandidate) {
    actionReasons.push(
      "Existing mission-readiness analysis identifies this selection as a cheap mobile provider.",
    );
  }
  if (budgetHolderCandidate) {
    actionReasons.push(
      "Positive OC at no more than 10% of the roster budget supports a protected holding assignment.",
    );
  }
  if (!actionCandidate && !budgetHolderCandidate) {
    actionReasons.push(
      "It does not meet the current cheap-mobile or budget-holder heuristic; this is not a prohibition on performing actions.",
    );
  }
  const mobilityEvidence = [
    ...(selection.movement === null
      ? []
      : [`Movement ${selection.movement}.`]),
    ...(selection.keywords.includes("fly") ? ["FLY keyword."] : []),
    ...(selection.keywords.includes("mounted")
      ? ["MOUNTED keyword."]
      : []),
    ...selection.mobilityRuleIds.map(
      (abilityId) => `Mobility rule ${abilityId}.`,
    ),
  ];
  return {
    selectionId: selection.selection.selectionId,
    unitId: selection.selection.unitId,
    name: selection.selection.name,
    modelCount: selection.selection.modelCount,
    points: selection.selection.points,
    pointsShare: selection.pointsShare,
    roles,
    metrics: {
      totalObjectiveControl,
      objectiveControlPerPoint,
      objectiveControlPer100Points:
        objectiveControlPerPoint === null
          ? null
          : round(objectiveControlPerPoint * 100),
      totalWounds,
      woundsPerPoint,
      woundsPer100Points:
        woundsPerPoint === null
          ? null
          : round(woundsPerPoint * 100),
      contextualOcBenchmark: {
        value: benchmark,
        comparison:
          objectiveControlPerPoint === null
            ? "unavailable"
            : objectiveControlPerPoint >= benchmark
              ? "above-or-equal"
              : "below",
        authority: "contextual-heuristic",
      },
    },
    mobility: {
      movement: selection.movement,
      reachable: selection.reachable,
      fast: selection.fast,
      mobilityRuleIds: selection.mobilityRuleIds,
      evidence: mobilityEvidence,
      sourcePaths: [
        sourcePath(selection, "profiles/0/M"),
        sourcePath(selection, "keywords"),
        ...selection.mobilityRuleIds.map(
          (abilityId) => `/runtime/abilities/${abilityId}`,
        ),
      ],
    },
    actionEconomy: {
      candidate: actionCandidate,
      budgetHolderCandidate,
      reasons: actionReasons,
      sourcePaths: [
        `/roster/units/${selection.selection.selectionId}/points`,
        sourcePath(selection, "profiles/0/M"),
        sourcePath(selection, "profiles/0/OC"),
      ],
    },
    expectedOperationalLifecycle: lifecycleForRoles(roles),
    caveats: [
      "Economic roles are calibrated coaching labels, not official battlefield roles.",
      ...(selection.unit
        ? []
        : [
            "Structured datasheet data could not be resolved; metrics and roles require review.",
          ]),
    ],
  };
}

function applicability(
  status: CoachingApplicabilityStatus,
  reason: string,
): CoachingApplicability {
  return { status, reason };
}

function contextString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function buildAdvice(
  mode: CompetitiveCoachingMode,
  report: TesseraMissionReadinessReport,
  unitCoaching: CompetitiveUnitCoaching[],
  missionContext: CompetitiveCoachingOptions["missionContext"] | undefined,
  terrainContext: CompetitiveCoachingOptions["terrainContext"] | undefined,
): CompetitiveCoachingAdvice[] {
  const advice: CompetitiveCoachingAdvice[] = [];
  const action = dimension(report, "action-economy");
  const reach = dimension(report, "reach");
  const control = dimension(report, "control-depth");
  const durable = dimension(report, "durable-contesting");

  advice.push({
    id: "protect-scoring-plan",
    category: "resource-conversion",
    priority: "medium",
    confidence: "medium",
    text:
      "Assign each selection a scoring, denial, screening, support, or trading purpose before deployment; damage without a scoring consequence is not automatically efficient.",
    selectionIds: unitCoaching.map((entry) => entry.selectionId),
    heuristicIds: ["vp-resource-conversion"],
    sourcePaths: ["/roster/units"],
  });

  for (const candidate of [action, reach, control, durable]) {
    if (!candidate || candidate.band === "green") continue;
    advice.push({
      id: `readiness-${candidate.id}`,
      category: "mission-readiness",
      priority: candidate.band === "red" ? "high" : "medium",
      confidence:
        candidate.confidence === "high" ? "high" : "review",
      text: `${candidate.label} is ${candidate.band}; review the named providers before relying on this roster for that mission demand.`,
      selectionIds: candidate.providerSelectionIds,
      heuristicIds:
        candidate.id === "action-economy"
          ? ["action-tax"]
          : ["vp-resource-conversion"],
      sourcePaths: candidate.metrics.flatMap(
        (metric) => metric.sourcePaths,
      ),
    });
  }

  for (const role of ROLE_ORDER) {
    if (
      unitCoaching.some((unit) =>
        unit.roles.some((assignment) => assignment.role === role),
      )
    ) {
      continue;
    }
    advice.push({
      id: `role-gap-${role}`,
      category: "role-coverage",
      priority: role === "tech-piece" || role === "anvil" ? "medium" : "low",
      confidence: "medium",
      text: `No selection has a confident ${role.replaceAll("-", " ")} label; verify whether another unit can cover that economic function before changing the list.`,
      selectionIds: [],
      heuristicIds: ["economic-role-taxonomy"],
      sourcePaths: ["/roster/units"],
    });
  }

  if (mode === "full") {
    advice.push({
      id: "simulate-reliable-trades",
      category: "variance",
      priority: "medium",
      confidence: "high",
      text:
        "Do not infer reliable trades from these roster metrics. Use paired Tessera matchup analysis; the heuristic target is at least 90% wipe probability and a 1.25 favorable trade ratio.",
      selectionIds: unitCoaching
        .filter((unit) =>
          unit.roles.some(
            (assignment) => assignment.role === "trading-piece",
          ),
        )
        .map((unit) => unit.selectionId),
      heuristicIds: ["variance-floor", "trade-efficiency"],
      sourcePaths: ["/roster/units"],
    });

    const missionPackId = contextString(
      missionContext?.missionPackId,
    );
    const missionId = contextString(missionContext?.missionId);
    if (missionPackId) {
      advice.push({
        id: "mission-clock-plan",
        category: "mission",
        priority: "medium",
        confidence: "review",
        text: `For mission pack ${missionPackId}${
          missionId ? `, mission ${missionId}` : ""
        }, map scoring tasks to the readiness providers and verify exact timing against the official mission rules before assigning five-round milestones.`,
        selectionIds: unitCoaching.map((entry) => entry.selectionId),
        heuristicIds: ["reverse-five-round-clock"],
        sourcePaths: ["/mission-readiness"],
      });
    }

    const formatId = contextString(terrainContext?.formatId);
    const layoutId = contextString(terrainContext?.layoutId);
    if (formatId) {
      advice.push({
        id: "terrain-staging-plan",
        category: "terrain",
        priority: "medium",
        confidence: "review",
        text: `For terrain format ${formatId}${
          layoutId ? `, layout ${layoutId}` : ""
        }, map obscuring footprints, staging lanes, and screening gaps using the active terrain and movement rules; this heuristic pack does not certify distances or line of sight.`,
        selectionIds: unitCoaching
          .filter((unit) => unit.mobility.reachable)
          .map((unit) => unit.selectionId),
        heuristicIds: ["staging-and-screening"],
        sourcePaths: ["/roster/units"],
      });
    }
  }

  return advice;
}

function uniqueIssues(issues: RosterIssue[]): RosterIssue[] {
  return issues.filter(
    (candidate, index, all) =>
      all.findIndex(
        (entry) =>
          entry.code === candidate.code &&
          entry.message === candidate.message &&
          entry.selectionId === candidate.selectionId,
      ) === index,
  );
}

/**
 * Analyze one roster that is expected to have already passed validation.
 * The mission-readiness call validates again at this trust boundary so a
 * stale or malformed roster never receives authoritative-looking coaching.
 */
export function analyzeCompetitiveCoaching(
  roster: RosterDraftV1,
  options: CompetitiveCoachingOptions = {},
): ResultEnvelope<CompetitiveCoachingReport> {
  if (
    options.mode !== undefined &&
    options.mode !== "concise" &&
    options.mode !== "full"
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "INVALID_COACHING_MODE",
          'Competitive coaching mode must be "concise" or "full".',
        ),
      ],
      warnings: [],
    };
  }
  const mode = options.mode ?? "concise";
  const readiness = analyzeMissionReadiness(roster);
  if (!readiness.ok || !readiness.data) {
    return {
      ok: false,
      data: null,
      violations: readiness.violations,
      warnings: readiness.warnings,
    };
  }

  const editionApplicable =
    FOUNDATION_CODEX_V2_HEURISTIC_PACK.applicability.gameEditions.includes(
      roster.sourceData.edition,
    );
  const missionPackId = contextString(
    options.missionContext?.missionPackId,
  );
  const terrainFormatId = contextString(
    options.terrainContext?.formatId,
  );
  const missionContextInvalid =
    options.missionContext !== undefined && missionPackId === null;
  const terrainContextInvalid =
    options.terrainContext !== undefined && terrainFormatId === null;
  const coachingWarnings: RosterIssue[] = [];

  if (roster.sourceData.official.authority?.status !== "verified") {
    coachingWarnings.push(
      issue(
        "COACHING_RULES_AUTHORITY_UNVERIFIED",
        "Competitive coaching uses the roster's active structured data, whose official-source authority is not verified.",
        "warn",
      ),
    );
  }
  if (mode === "full" && !missionPackId) {
    coachingWarnings.push(
      issue(
        missionContextInvalid
          ? "COACHING_MISSION_CONTEXT_INVALID"
          : "COACHING_MISSION_CONTEXT_REQUIRED",
        missionContextInvalid
          ? "Mission-specific coaching was omitted because missionPackId is blank."
          : "Mission-specific coaching was omitted because no mission-pack context was supplied.",
        "warn",
      ),
    );
  }
  if (mode === "full" && !terrainFormatId) {
    coachingWarnings.push(
      issue(
        terrainContextInvalid
          ? "COACHING_TERRAIN_CONTEXT_INVALID"
          : "COACHING_TERRAIN_CONTEXT_REQUIRED",
        terrainContextInvalid
          ? "Terrain-specific coaching was omitted because formatId is blank."
          : "Terrain-specific coaching was omitted because no terrain-format context was supplied.",
        "warn",
      ),
    );
  }

  const actionProviderIds = new Set(
    dimension(readiness.data, "action-economy")
      ?.providerSelectionIds ?? [],
  );
  const durableProviderIds = new Set(
    dimension(readiness.data, "durable-contesting")
      ?.providerSelectionIds ?? [],
  );
  const resolved = roster.units.map((selection) =>
    resolveSelection(roster, selection),
  );
  const unresolved = resolved.filter((selection) => !selection.unit);
  if (unresolved.length > 0) {
    coachingWarnings.push(
      issue(
        "COACHING_UNIT_PROFILE_UNRESOLVED",
        `Competitive coaching could not resolve structured profiles for ${unresolved.length} roster selections.`,
        "warn",
      ),
    );
  }
  const unitCoaching = resolved.map((selection) =>
    buildUnitCoaching(
      selection,
      actionProviderIds,
      durableProviderIds,
    ),
  );
  const totalObjectiveControl = unitCoaching.reduce(
    (sum, selection) =>
      sum + (selection.metrics.totalObjectiveControl ?? 0),
    0,
  );
  const totalWounds = unitCoaching.reduce(
    (sum, selection) => sum + (selection.metrics.totalWounds ?? 0),
    0,
  );
  const roleCounts = Object.fromEntries(
    ROLE_ORDER.map((role) => [
      role,
      unitCoaching.filter((unit) =>
        unit.roles.some((assignment) => assignment.role === role),
      ).length,
    ]),
  ) as Record<CompetitiveEconomicRole, number>;

  const genericApplicability = editionApplicable
    ? applicability(
        "applied",
        "The roster edition matches the heuristic pack; generic advice is calibrated and non-official.",
      )
    : applicability(
        "not-applicable-edition",
        `The roster edition ${roster.sourceData.edition} is not supported by this heuristic pack.`,
      );
  const contextualApplicability = (
    kind: "mission" | "terrain",
    contextPresent: boolean,
    contextInvalid: boolean,
  ): CoachingApplicability => {
    if (!editionApplicable) {
      return applicability(
        "not-applicable-edition",
        `${kind === "mission" ? "Mission" : "Terrain"}-specific advice is disabled because the roster edition is not supported.`,
      );
    }
    if (mode !== "full") {
      return applicability(
        "omitted-mode",
        `${kind === "mission" ? "Mission" : "Terrain"}-specific advice is available only in full coaching mode.`,
      );
    }
    if (contextInvalid) {
      return applicability(
        "omitted-invalid-context",
        `${kind === "mission" ? "Mission" : "Terrain"}-specific advice was omitted because the supplied context identifier is blank.`,
      );
    }
    if (!contextPresent) {
      return applicability(
        "omitted-missing-context",
        `${kind === "mission" ? "Mission" : "Terrain"}-specific advice requires explicit context.`,
      );
    }
    return applicability(
      "applied",
      `${kind === "mission" ? "Mission" : "Terrain"}-specific coaching is contextual and must be checked against the active official rules.`,
    );
  };

  const warnings = uniqueIssues([
    ...readiness.warnings,
    ...coachingWarnings,
  ]);
  const report: CompetitiveCoachingReport = {
    schemaVersion: 1,
    reportKind: "competitive-coaching",
    mode,
    rosterFingerprint: readiness.data.rosterFingerprint,
    heuristicPack: {
      id: FOUNDATION_CODEX_V2_HEURISTIC_PACK.id,
      title: FOUNDATION_CODEX_V2_HEURISTIC_PACK.title,
      version: FOUNDATION_CODEX_V2_HEURISTIC_PACK.version,
      packKind: FOUNDATION_CODEX_V2_HEURISTIC_PACK.packKind,
      authority:
        FOUNDATION_CODEX_V2_HEURISTIC_PACK.authority.kind,
      officialRules:
        FOUNDATION_CODEX_V2_HEURISTIC_PACK.authority.officialRules,
      contentSha256:
        FOUNDATION_CODEX_V2_HEURISTIC_PACK_SHA256,
      gameEdition: "11th",
    },
    applicability: {
      generic: genericApplicability,
      missionSpecific: contextualApplicability(
        "mission",
        missionPackId !== null,
        missionContextInvalid,
      ),
      terrainSpecific: contextualApplicability(
        "terrain",
        terrainFormatId !== null,
        terrainContextInvalid,
      ),
      opponentSpecificTrade: applicability(
        "omitted-missing-context",
        "Reliable target trades require an explicit opponent and Tessera matchup simulation; roster coaching does not infer them.",
      ),
    },
    summary: {
      totalPoints: roster.totalPoints,
      selectionCount: roster.units.length,
      totalObjectiveControl,
      objectiveControlPerPoint: ratio(
        totalObjectiveControl,
        roster.totalPoints,
      ),
      totalWounds,
      woundsPerPoint: ratio(totalWounds, roster.totalPoints),
      selectionActivationUpperBound: roster.units.length,
      activationEstimateBasis:
        "roster-selections-before-attachments",
      reachableSelectionCount: unitCoaching.filter(
        (selection) => selection.mobility.reachable,
      ).length,
      fastSelectionCount: unitCoaching.filter(
        (selection) => selection.mobility.fast,
      ).length,
      actionCandidateCount: unitCoaching.filter(
        (selection) => selection.actionEconomy.candidate,
      ).length,
      roleCounts,
      missionReadinessBand: readiness.data.overallBand,
    },
    units: unitCoaching,
    missionReadiness: readiness.data,
    advice: buildAdvice(
      mode,
      readiness.data,
      unitCoaching,
      options.missionContext,
      options.terrainContext,
    ),
    disclaimer:
      "Competitive coaching is a calibrated, user-supplied heuristic layer. It is not an official rule, legality judgment, tournament ruling, or whole-game win probability. The activation figure is a pre-attachment selection upper bound, not the number of Attached units that will activate in play.",
    warningCodes: warnings.map((warning) => warning.code),
  };
  return {
    ok: true,
    data: report,
    violations: [],
    warnings,
  };
}
