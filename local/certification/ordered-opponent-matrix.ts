import {
  buildRoster,
  explainRoster,
  rosterExecutionFingerprint,
  rosterStructuralFingerprint,
  validateRoster,
  type PreferenceTag,
  type RosterIssue,
} from "../../lib/rosterpilot";

export type OrderedOpponentMatrixPlayerInput = {
  playerFactionId: string;
  playerFactionName: string;
  opponentFactionId: string;
  opponentFactionName: string;
  pointsLimit: number;
  preferences: PreferenceTag[];
  allowNamedCharacters: boolean;
  allowLegends: boolean;
};

export type OrderedOpponentMatrixPlayerEvidence = {
  playerFactionId: string;
  opponentFactionId: string;
  buildInput: {
    playerFaction: string;
    opponentContext: {
      kind: "known-faction";
      factionId: string;
    };
    pointsLimit: number;
    preferences: PreferenceTag[];
    allowNamedCharacters: boolean;
    allowLegends: boolean;
  };
  roster: {
    name: string;
    factionId: string;
    opponentFactionId: string;
    pointsLimit: number;
    totalPoints: number;
    unitCount: number;
    detachmentId: string;
    unitRoles: string[];
    rosterFingerprint: string;
    executionFingerprint: string;
  };
  validation: {
    ok: true;
    violations: RosterIssue[];
    warnings: RosterIssue[];
  };
  opponentScoring: {
    generatorVersion: "beam-search-v1";
    scoreOrder: string[];
    targetCoverage: {
      opponentFactionId: string;
      eliteShare: number;
      hordeShare: number;
      mobilityShare: number;
      vehicleMonsterShare: number;
      selectedCoverageScore: number;
    };
    selectedCandidates: Array<{
      selectionId: string;
      unitId: string;
      unitName: string;
      modelCount: number;
      points: number;
      components: {
        preference: number;
        pointsUtilization: number;
        missionReadiness: number;
        opponentCoverage: number;
        modelValue: number;
        duplicationPenalty: number;
        extraCharacterPenalty: number;
        pointsCostPenalty: number;
        total: number;
      };
    }>;
  };
};

function orderedMatrixError(
  code: string,
  message: string,
): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

/**
 * Builds the player side of one ordered faction pair. Opponent portfolio
 * previews may be cached separately, but this player build and its scoring
 * explanation are deliberately pair-specific.
 */
export function buildOrderedOpponentMatrixPlayer(
  input: OrderedOpponentMatrixPlayerInput,
): OrderedOpponentMatrixPlayerEvidence {
  const buildInput = {
    playerFaction: input.playerFactionId,
    opponentContext: {
      kind: "known-faction" as const,
      factionId: input.opponentFactionId,
    },
    pointsLimit: input.pointsLimit,
    name: `RP ordered matrix ${input.playerFactionName} vs ${input.opponentFactionName}`,
    preferences: [...input.preferences],
    allowNamedCharacters: input.allowNamedCharacters,
    allowLegends: input.allowLegends,
  };
  const built = buildRoster(buildInput);
  if (!built.ok || !built.data) {
    orderedMatrixError(
      built.violations[0]?.code ??
        "CERTIFICATION_ORDERED_MATRIX_PLAYER_BUILD_FAILED",
      built.violations.map((issue) => issue.message).join(" ") ||
        `No ${input.playerFactionName} roster was built against ${input.opponentFactionName}.`,
    );
  }
  const roster = built.data;
  if (
    roster.factionId !== input.playerFactionId ||
    roster.constraints.opponentFactionId !==
      input.opponentFactionId
  ) {
    orderedMatrixError(
      "CERTIFICATION_ORDERED_MATRIX_CONTEXT_MISMATCH",
      `The ordered ${input.playerFactionName} versus ${input.opponentFactionName} build did not preserve both faction identities.`,
    );
  }

  const validation = validateRoster(roster);
  if (!validation.ok || validation.violations.length > 0) {
    orderedMatrixError(
      validation.violations[0]?.code ??
        "CERTIFICATION_ORDERED_MATRIX_PLAYER_VALIDATION_FAILED",
      validation.violations
        .map((issue) => issue.message)
        .join(" ") ||
        `The ordered ${input.playerFactionName} roster did not validate.`,
    );
  }
  const explanation = explainRoster(roster);
  if (!explanation.ok || !explanation.data) {
    orderedMatrixError(
      explanation.violations[0]?.code ??
        "CERTIFICATION_ORDERED_MATRIX_SCORING_UNAVAILABLE",
      explanation.violations
        .map((issue) => issue.message)
        .join(" ") ||
        `Opponent scoring was unavailable for ${input.playerFactionName} against ${input.opponentFactionName}.`,
    );
  }
  const targetCoverage =
    explanation.data.optimizer.targetProfileCoverage;
  if (
    !targetCoverage ||
    targetCoverage.opponentFactionId !== input.opponentFactionId
  ) {
    orderedMatrixError(
      "CERTIFICATION_ORDERED_MATRIX_TARGET_COVERAGE_MISMATCH",
      `Opponent target coverage did not retain ${input.opponentFactionName}.`,
    );
  }
  if (
    explanation.data.optimizer.selectedCandidates.length !==
    roster.units.length
  ) {
    orderedMatrixError(
      "CERTIFICATION_ORDERED_MATRIX_SCORING_INCOMPLETE",
      `Opponent scoring covered ${explanation.data.optimizer.selectedCandidates.length}/${roster.units.length} selected units.`,
    );
  }

  return {
    playerFactionId: input.playerFactionId,
    opponentFactionId: input.opponentFactionId,
    buildInput: {
      playerFaction: buildInput.playerFaction,
      opponentContext: buildInput.opponentContext,
      pointsLimit: buildInput.pointsLimit,
      preferences: buildInput.preferences,
      allowNamedCharacters: buildInput.allowNamedCharacters,
      allowLegends: buildInput.allowLegends,
    },
    roster: {
      name: roster.name,
      factionId: roster.factionId,
      opponentFactionId:
        roster.constraints.opponentFactionId,
      pointsLimit: roster.pointsLimit,
      totalPoints: roster.totalPoints,
      unitCount: roster.units.length,
      detachmentId: roster.detachmentId,
      unitRoles: [
        ...new Set(roster.units.map((unit) => unit.role)),
      ].sort(),
      rosterFingerprint:
        rosterStructuralFingerprint(roster),
      executionFingerprint:
        rosterExecutionFingerprint(roster),
    },
    validation: {
      ok: true,
      violations: validation.violations,
      warnings: validation.warnings,
    },
    opponentScoring: {
      generatorVersion:
        explanation.data.optimizer.generatorVersion,
      scoreOrder: explanation.data.optimizer.scoreOrder,
      targetCoverage,
      selectedCandidates:
        explanation.data.optimizer.selectedCandidates,
    },
  };
}
