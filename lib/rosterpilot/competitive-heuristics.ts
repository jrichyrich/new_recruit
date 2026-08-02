/**
 * User-supplied competitive-play guidance, represented as calibrated coaching
 * heuristics rather than Games Workshop rules. The content hash is kept
 * separate from roster-rules identity so updating advice cannot silently
 * change legality or invalidate a canonical roster.
 */

export type CompetitiveHeuristicPack = {
  schemaVersion: 1;
  packKind: "competitive-coaching-heuristics";
  id: string;
  title: string;
  version: string;
  authority: {
    kind: "user-supplied-reference";
    officialRules: false;
    treatment: "calibrated-heuristics";
  };
  applicability: {
    gameEditions: readonly ["11th"];
    missionSpecificAdviceRequiresContext: true;
    terrainSpecificAdviceRequiresContext: true;
    opponentSpecificTradeAdviceRequiresSimulation: true;
  };
  thresholds: {
    contextualOcPerPointBenchmark: number;
    techPieceMaxRosterShare: number;
    budgetHolderMaxRosterShare: number;
    reachableMovement: number;
    fastMovement: number;
    durableContesterMinTotalOc: number;
    durableContesterMinToughness: number;
    durableContesterMinTotalWounds: number;
    durableContesterSaveAtMost: number;
    durableContesterInvulnerableSaveAtMost: number;
    durableContesterMinModels: number;
    reliableTradeMinWipeProbability: number;
    favorableTradeRatio: number;
  };
  principles: readonly {
    id: string;
    category:
      | "resource-conversion"
      | "unit-role"
      | "variance"
      | "action-economy"
      | "spatial-control"
      | "turn-zero"
      | "mission-clock"
      | "datasheet-evaluation";
    statement: string;
    calibration: string;
  }[];
};

export const FOUNDATION_CODEX_V2_HEURISTIC_PACK = {
  schemaVersion: 1,
  packKind: "competitive-coaching-heuristics",
  id: "foundation-codex-v2",
  title:
    "Warhammer 40k Competitive First Principles: Foundation Codex V2",
  version: "2.0.0",
  authority: {
    kind: "user-supplied-reference",
    officialRules: false,
    treatment: "calibrated-heuristics",
  },
  applicability: {
    gameEditions: ["11th"],
    missionSpecificAdviceRequiresContext: true,
    terrainSpecificAdviceRequiresContext: true,
    opponentSpecificTradeAdviceRequiresSimulation: true,
  },
  thresholds: {
    contextualOcPerPointBenchmark: 0.15,
    techPieceMaxRosterShare: 0.15,
    budgetHolderMaxRosterShare: 0.1,
    reachableMovement: 7,
    fastMovement: 10,
    durableContesterMinTotalOc: 3,
    durableContesterMinToughness: 7,
    durableContesterMinTotalWounds: 10,
    durableContesterSaveAtMost: 2,
    durableContesterInvulnerableSaveAtMost: 4,
    durableContesterMinModels: 10,
    reliableTradeMinWipeProbability: 0.9,
    favorableTradeRatio: 1.25,
  },
  principles: [
    {
      id: "vp-resource-conversion",
      category: "resource-conversion",
      statement:
        "Prefer activations that generate victory points, deny opposing victory points, or protect a future scoring activation.",
      calibration:
        "A decision aid, not a rule: damage and positioning may have indirect value that is not visible from the roster alone.",
    },
    {
      id: "economic-role-taxonomy",
      category: "unit-role",
      statement:
        "Describe selections with the multi-label roles trading piece, anvil, tech piece, and force multiplier.",
      calibration:
        "Roles are inferred from structured profiles and roster context; fixed point bands are contextual examples rather than universal cutoffs.",
    },
    {
      id: "variance-floor",
      category: "variance",
      statement:
        "When a trade is essential to scoring, judge reliability below the mean and allocate enough resources to survive poor outcomes.",
      calibration:
        "Roster coaching cannot certify a trade. The initial reliable-trade proxy requires matchup simulation with at least 90% wipe probability.",
    },
    {
      id: "action-tax",
      category: "action-economy",
      statement:
        "Prefer inexpensive, mobile selections for mission actions so higher-output pieces retain combat activations.",
      calibration:
        "A combat unit may still be the correct action performer when mission timing, survival, or opportunity cost favors it.",
    },
    {
      id: "staging-and-screening",
      category: "spatial-control",
      statement:
        "Use staging, screening, and model footprints to constrain opposing threat projection while preserving your own scoring routes.",
      calibration:
        "Specific distances and ruin interactions require the active rules, mission, terrain format, and physical layout.",
    },
    {
      id: "defender-aggressor",
      category: "turn-zero",
      statement:
        "Compare passive scoring plans before deployment to identify which army must initiate interaction.",
      calibration:
        "Requires both armies plus mission context; it cannot be inferred from one roster in isolation.",
    },
    {
      id: "reverse-five-round-clock",
      category: "mission-clock",
      statement:
        "Plan scoring milestones backward from the final round and assign units to the required activations.",
      calibration:
        "Exact primary and secondary milestones must come from the active mission pack, not a fixed universal schedule.",
    },
    {
      id: "objective-control-efficiency",
      category: "datasheet-evaluation",
      statement:
        "Use Objective Control per point as one indicator of holding efficiency.",
      calibration:
        "The 0.15 OC-per-point value is a contextual benchmark, not a legality rule or universal quality threshold.",
    },
    {
      id: "trade-efficiency",
      category: "datasheet-evaluation",
      statement:
        "Compare reliably destroyed target value with the points committed to a trade.",
      calibration:
        "The 1.25 trade ratio is a coaching target and requires matchup simulation; roster profiles alone do not establish it.",
    },
  ],
} as const satisfies CompetitiveHeuristicPack;

/**
 * SHA-256 of canonicalJson(FOUNDATION_CODEX_V2_HEURISTIC_PACK). A regression
 * test recomputes this value so edits must deliberately version and re-pin it.
 */
export const FOUNDATION_CODEX_V2_HEURISTIC_PACK_SHA256 =
  "9550a59d69db9d7e1029118988ade91732f1c4fcd73321b863fcba3ca34c57b9";
