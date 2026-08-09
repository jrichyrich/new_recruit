import crypto from "node:crypto";

import type {
  PreferenceTag,
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
} from "./types";

const PROFILE_TAGS = [
  "mobility",
  "durability",
  "objective",
  "shooting",
  "melee",
  "elite",
  "horde",
] as const satisfies readonly PreferenceTag[];

type MatchupProfile = {
  points: number;
  models: number;
  units: number;
  largestUnitShare: number;
  tags: Record<PreferenceTag, number>;
};

export type LocalMatchupFinding = {
  title: string;
  direction: "advantage" | "risk" | "plan";
  confidence: "high" | "medium";
  summary: string;
};

export type LocalMatchupReport = {
  schemaVersion: 1;
  resultKind: "exact-roster-matchup";
  generatedAt: string;
  playerRosterId: string;
  opponentRosterId: string;
  fingerprint: string;
  profiles: {
    player: MatchupProfile;
    opponent: MatchupProfile;
  };
  findings: LocalMatchupFinding[];
  targetPriority: Array<{
    selectionId: string;
    name: string;
    points: number;
    reason: string;
  }>;
  gamePlan: string[];
  limitation: string;
};

function roundedShare(value: number, total: number): number {
  return total > 0 ? Number((value / total).toFixed(3)) : 0;
}

function profile(roster: RosterDraftV1): MatchupProfile {
  const tagPoints = Object.fromEntries(
    PROFILE_TAGS.map((tag) => [tag, 0]),
  ) as Record<PreferenceTag, number>;
  for (const unit of roster.units) {
    for (const tag of new Set(unit.tags)) tagPoints[tag] += unit.points;
  }
  const largestUnit = Math.max(0, ...roster.units.map((unit) => unit.points));
  return {
    points: roster.totalPoints,
    models: roster.units.reduce((sum, unit) => sum + unit.modelCount, 0),
    units: roster.units.length,
    largestUnitShare: roundedShare(largestUnit, roster.totalPoints),
    tags: Object.fromEntries(
      PROFILE_TAGS.map((tag) => [
        tag,
        roundedShare(tagPoints[tag], roster.totalPoints),
      ]),
    ) as Record<PreferenceTag, number>,
  };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function strongestTag(profileValue: MatchupProfile): PreferenceTag {
  return PROFILE_TAGS.reduce((best, tag) =>
    profileValue.tags[tag] > profileValue.tags[best] ? tag : best
  );
}

function fingerprint(player: RosterDraftV1, opponent: RosterDraftV1): string {
  const selections = (roster: RosterDraftV1) => roster.units.map((unit) => ({
    unitId: unit.unitId,
    models: unit.modelCount,
    points: unit.points,
    equipment: unit.equipment.map((item) => [item.itemId, item.count]),
  }));
  return crypto.createHash("sha256").update(JSON.stringify({
    player: selections(player),
    opponent: selections(opponent),
  })).digest("hex");
}

function warning(code: string, message: string): RosterIssue {
  return { code, message, severity: "warn" };
}

export async function analyzeExactRosterMatchup(
  player: RosterDraftV1,
  opponent: RosterDraftV1,
  options: { allowPointMismatch: boolean },
): Promise<ResultEnvelope<LocalMatchupReport>> {
  const pointDifference = Math.abs(player.pointsLimit - opponent.pointsLimit);
  if (pointDifference > 0 && !options.allowPointMismatch) {
    return {
      ok: false,
      data: null,
      violations: [{
        code: "MATCHUP_POINT_LIMIT_MISMATCH",
        message: "Exact-roster matchup analysis requires equal point limits.",
        severity: "error",
      }],
      warnings: [],
    };
  }

  const playerProfile = profile(player);
  const opponentProfile = profile(opponent);
  const playerStrength = strongestTag(playerProfile);
  const opponentStrength = strongestTag(opponentProfile);
  const mobilityDelta = playerProfile.tags.mobility -
    opponentProfile.tags.mobility;
  const bodyDelta = playerProfile.models - opponentProfile.models;
  const targetPriority = [...opponent.units]
    .sort((left, right) => right.points - left.points ||
      left.name.localeCompare(right.name))
    .slice(0, 3)
    .map((unit) => ({
      selectionId: unit.selectionId,
      name: unit.name,
      points: unit.points,
      reason: unit.isWarlord
        ? "High-value warlord selection."
        : `${pct(roundedShare(unit.points, opponent.totalPoints))} of the opposing roster.`,
    }));

  const findings: LocalMatchupFinding[] = [
    {
      title: "Primary plan",
      direction: "plan",
      confidence: "high",
      summary:
        `Lean on ${playerStrength}; ${pct(playerProfile.tags[playerStrength])} of your points carry that role tag.`,
    },
    {
      title: "Opponent pressure",
      direction: "risk",
      confidence: "high",
      summary:
        `The opponent's strongest declared role is ${opponentStrength} at ${pct(opponentProfile.tags[opponentStrength])} of points.`,
    },
    {
      title: "Board access",
      direction: mobilityDelta >= 0 ? "advantage" : "risk",
      confidence: "medium",
      summary: mobilityDelta >= 0
        ? `Your mobility-tag share is ${pct(mobilityDelta)} higher; stage for early scoring without exposing the whole army.`
        : `Your mobility-tag share is ${pct(Math.abs(mobilityDelta))} lower; screen lanes and trade onto objectives deliberately.`,
    },
    {
      title: "Model pressure",
      direction: bodyDelta >= 0 ? "advantage" : "risk",
      confidence: "medium",
      summary: bodyDelta >= 0
        ? `You have ${bodyDelta} more models for screens and actions.`
        : `You have ${Math.abs(bodyDelta)} fewer models; protect small utility units and avoid low-value trades.`,
    },
  ];

  const warnings: RosterIssue[] = [];
  if (player.sourceData.bundleId !== opponent.sourceData.bundleId) {
    warnings.push(warning(
      "MATCHUP_BUNDLE_MISMATCH",
      "The exact rosters were created from different rules snapshots.",
    ));
  }
  if (pointDifference > 0) {
    warnings.push(warning(
      "MATCHUP_POINT_LIMIT_MISMATCH_ALLOWED",
      `Point limits differ by ${pointDifference}; interpret the comparison accordingly.`,
    ));
  }

  return {
    ok: true,
    data: {
      schemaVersion: 1,
      resultKind: "exact-roster-matchup",
      generatedAt: new Date().toISOString(),
      playerRosterId: player.id,
      opponentRosterId: opponent.id,
      fingerprint: fingerprint(player, opponent),
      profiles: { player: playerProfile, opponent: opponentProfile },
      findings,
      targetPriority,
      gamePlan: [
        `Stage the ${targetPriority[0]?.name ?? "highest-value target"} matchup before committing your main damage package.`,
        mobilityDelta >= 0
          ? "Use the mobility edge to score first, then force the opponent to expose units."
          : "Deny direct lanes and make the opponent spend movement to reach valuable targets.",
        `Preserve units tagged for ${playerStrength} until they can create a favorable trade.`,
      ],
      limitation:
        "Deterministic exact-roster composition analysis; it does not estimate whole-game win probability or resolve table geometry.",
    },
    violations: [],
    warnings,
  };
}
