import {
  repairRosterDeterministically,
  validateRoster,
  type BuildAndAnalyzeRosterInput,
  type BuildAndAnalyzeRosterResult,
  type ResultEnvelope,
  type RosterIssue,
} from "../../lib/rosterpilot";
import {
  analyzeRosterMatchup,
  type TesseraAnalysisOptions,
  type TesseraDependencies,
} from "./companion";

function uniqueIssues(issues: RosterIssue[]): RosterIssue[] {
  return issues.filter(
    (issue, index) =>
      issues.findIndex(
        (candidate) =>
          candidate.code === issue.code &&
          candidate.message === issue.message &&
          candidate.severity === issue.severity,
      ) === index,
  );
}

function resultData(
  input: BuildAndAnalyzeRosterInput,
  rosterRepair: BuildAndAnalyzeRosterResult["rosterRepair"],
  matchupReport: BuildAndAnalyzeRosterResult["matchupReport"],
  failure: BuildAndAnalyzeRosterResult["failure"],
): BuildAndAnalyzeRosterResult {
  return {
    schemaVersion: 1,
    resultKind: "tessera-build-and-analyze",
    generatedAt: new Date().toISOString(),
    stage: failure
      ? "failed"
      : matchupReport
        ? "analysis-complete"
        : "roster-repaired",
    rosterRepair,
    opponent: {
      id: input.opponentRoster.id,
      name: input.opponentRoster.name,
      factionId: input.opponentRoster.factionId,
      factionName: input.opponentRoster.factionName,
      points: input.opponentRoster.totalPoints,
      pointsLimit: input.opponentRoster.pointsLimit,
    },
    matchupReport,
    collectionMode:
      input.collectionProfile?.mode ?? "open-catalog",
    failure,
    automaticRevisionApplied: false,
    revisionCandidatesRequireAuthorization: true,
  };
}

/**
 * Build a deterministic player roster against one exact canonical opponent,
 * then hand both validated rosters to the exact Tessera workflow. Suggestions
 * remain proposals and never mutate the built roster.
 */
export async function buildAndAnalyzeRosterMatchup(
  input: BuildAndAnalyzeRosterInput,
  options: TesseraAnalysisOptions = {},
  dependencies: TesseraDependencies = {},
): Promise<ResultEnvelope<BuildAndAnalyzeRosterResult>> {
  const opponentValidation = validateRoster(input.opponentRoster);
  if (!opponentValidation.ok) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "OPPONENT_ROSTER_INVALID",
          message:
            "The exact opponent roster must validate before roster construction or external activity.",
          severity: "error",
        },
        ...opponentValidation.violations,
      ],
      warnings: opponentValidation.warnings,
    };
  }
  if (
    input.pointsLimit !== undefined &&
    input.pointsLimit !== input.opponentRoster.pointsLimit
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_POINTS_LIMIT_MISMATCH",
          message:
            "The requested player points limit must equal the exact opponent roster's declared points limit.",
          severity: "error",
        },
      ],
      warnings: opponentValidation.warnings,
    };
  }
  const collectionProfile =
    input.collectionProfile ?? { mode: "open-catalog" as const };
  const repaired = await repairRosterDeterministically({
    prompt: input.prompt,
    playerFaction: input.playerFaction,
    pointsLimit:
      input.pointsLimit ?? input.opponentRoster.pointsLimit,
    name: `${input.playerFaction ?? "Roster"} vs ${input.opponentRoster.name}`,
    collectionProfile,
    legendsPolicy: input.legendsPolicy,
    allowLegends: input.allowLegends,
    playContext: input.playContext,
    requiredUnitIds: input.requiredUnitIds,
    excludedUnitIds: input.excludedUnitIds,
    requiredWarlordUnitId: input.requiredWarlordUnitId,
    opponentContext: {
      kind: "known-roster",
      roster: input.opponentRoster,
    },
  });
  if (!repaired.ok || !repaired.data) {
    return {
      ok: false,
      data: null,
      violations: repaired.violations,
      warnings: uniqueIssues([
        ...opponentValidation.warnings,
        ...repaired.warnings,
      ]),
    };
  }
  const utilization =
    repaired.data.roster.totalPoints /
    Math.max(1, repaired.data.roster.pointsLimit);
  if (
    !input.allowReadinessWarnings &&
    (
      utilization < 0.98 ||
      repaired.data.missionReadiness.overallBand === "red"
    )
  ) {
    const message =
      utilization < 0.98
        ? `The repaired roster uses ${(utilization * 100).toFixed(1)}% of its points; exact build-and-analyze requires at least 98%.`
        : "The repaired roster has red overall mission readiness.";
    const violation: RosterIssue = {
      code: "TESSERA_BUILD_READINESS_GATE_FAILED",
      message,
      severity: "error",
    };
    return {
      ok: false,
      data: resultData(input, repaired.data, null, {
        stage: "readiness",
        code: violation.code,
        message,
        retryable: false,
      }),
      violations: [violation],
      warnings: uniqueIssues([
        ...opponentValidation.warnings,
        ...repaired.warnings,
      ]),
    };
  }
  const executionMode =
    input.executionMode ??
    options.executionMode ??
    (
      input.experimental || options.experimental
        ? "simulate"
        : undefined
    );
  const analysis = await analyzeRosterMatchup(
    repaired.data.roster,
    { kind: "roster", roster: input.opponentRoster },
    {
      ...options,
      outputDirectory:
        input.outputDirectory ?? options.outputDirectory,
      profilePolicyPath:
        input.profilePolicyPath ?? options.profilePolicyPath,
      executionMode,
      experimental: false,
      includeChangeCandidates: true,
    },
    dependencies,
  );
  if (!analysis.ok || !analysis.data) {
    const code =
      analysis.violations[0]?.code ??
      "TESSERA_EXACT_ANALYSIS_FAILED";
    const message =
      analysis.violations[0]?.message ??
      "The exact matchup analysis did not complete.";
    return {
      ok: false,
      data: resultData(input, repaired.data, analysis.data, {
        stage: "analysis",
        code,
        message,
        retryable:
          analysis.data?.failures?.some(
            (failure) => failure.retryable,
          ) ?? false,
      }),
      violations: analysis.violations,
      warnings: uniqueIssues([
        ...opponentValidation.warnings,
        ...repaired.warnings,
        ...analysis.warnings,
      ]),
    };
  }
  return {
    ok: true,
    data: resultData(input, repaired.data, analysis.data, null),
    violations: [],
    warnings: uniqueIssues([
      ...opponentValidation.warnings,
      ...repaired.warnings,
      ...analysis.warnings,
    ]),
  };
}
