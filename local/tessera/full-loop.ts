import path from "node:path";

import {
  buildRoster,
  previewFactionStressPortfolio,
  repairRosterDeterministically,
  type BuildRosterInput,
  type DeterministicRosterRepairResult,
  type ResultEnvelope,
  type RosterIssue,
  type TesseraStressAnalysisStrategy,
  type TesseraStressPortfolioPreview,
  type TesseraStressSuite,
  type TesseraStressTestReport,
} from "../../lib/rosterpilot";
import {
  runRosterStressTest,
  type TesseraStressDependencies,
  type TesseraStressOptions,
} from "./stress";

export type BuildAndStressRosterInput = {
  prompt: string;
  againstFaction: string;
  pointsLimit?: number;
  suite?: TesseraStressSuite;
  analysisStrategy?: TesseraStressAnalysisStrategy;
  profilePolicyPath?: string;
  outputDirectory?: string;
  resumeManifestPath?: string;
  allowReadinessWarnings?: boolean;
  forceRetry?: boolean;
  experimental?: boolean;
};

export type BuildAndStressRosterResult = {
  schemaVersion: 1;
  resultKind: "tessera-build-and-stress";
  generatedAt: string;
  rosterRepair: DeterministicRosterRepairResult;
  portfolioPreview: TesseraStressPortfolioPreview;
  stressReport: TesseraStressTestReport;
  automaticRevisionApplied: false;
  revisionCandidatesRequireAuthorization: true;
};

function failure<T>(
  code: string,
  message: string,
  warnings: RosterIssue[] = [],
): ResultEnvelope<T> {
  return {
    ok: false,
    data: null,
    violations: [{ code, message, severity: "error" }],
    warnings,
  };
}

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

function stableRosterName(
  factionName: string,
  pointsLimit: number,
  opponentFactionName: string,
): string {
  return `${factionName} ${pointsLimit} vs ${opponentFactionName}`;
}

export async function buildAndStressRosterAgainstFaction(
  input: BuildAndStressRosterInput,
  options: TesseraStressOptions = {},
  dependencies: TesseraStressDependencies = {},
): Promise<ResultEnvelope<BuildAndStressRosterResult>> {
  const seed = buildRoster({
    prompt: input.prompt,
    pointsLimit: input.pointsLimit,
  });
  if (!seed.ok || !seed.data) {
    return {
      ok: false,
      data: null,
      violations: seed.violations,
      warnings: uniqueIssues(seed.warnings),
    };
  }
  const opponentSeed = buildRoster({
    faction: input.againstFaction,
    pointsLimit: input.pointsLimit ?? seed.data.pointsLimit,
    name: "RosterPilot opponent naming seed",
  });
  if (!opponentSeed.ok || !opponentSeed.data) {
    return {
      ok: false,
      data: null,
      violations: opponentSeed.violations,
      warnings: uniqueIssues(opponentSeed.warnings),
    };
  }
  const pointsLimit = input.pointsLimit ?? seed.data.pointsLimit;
  const buildInput: BuildRosterInput = {
    prompt: input.prompt,
    faction: seed.data.factionId,
    pointsLimit,
    name: stableRosterName(
      seed.data.factionName,
      pointsLimit,
      opponentSeed.data.factionName,
    ),
    preferences: seed.data.preferences,
    allowNamedCharacters: seed.data.constraints.allowNamedCharacters,
    allowLegends: seed.data.constraints.allowLegends,
    opponentContext: {
      kind: "known-faction",
      factionId: opponentSeed.data.factionId,
    },
    mixedThreatIntent: true,
  };
  const repaired = await repairRosterDeterministically(buildInput);
  if (!repaired.ok || !repaired.data) {
    return {
      ok: false,
      data: null,
      violations: repaired.violations,
      warnings: uniqueIssues([
        ...seed.warnings,
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
    return failure(
      "TESSERA_BUILD_READINESS_GATE_FAILED",
      `The repaired roster uses ${Math.round(utilization * 1000) / 10}% of its points and has ${repaired.data.missionReadiness.overallBand} mission readiness. No New Recruit or Tessera activity was started. Use --allow-readiness-warnings only after reviewing the gate evidence.`,
      uniqueIssues(repaired.warnings),
    );
  }
  const preview = await previewFactionStressPortfolio({
    faction: opponentSeed.data.factionId,
    pointsLimit,
    suite: input.suite ?? "diverse-9",
    pointsTolerancePercent: 5,
    allowLegends: false,
  });
  if (!preview.ok || !preview.data) {
    return {
      ok: false,
      data: null,
      violations: preview.violations,
      warnings: uniqueIssues([
        ...seed.warnings,
        ...repaired.warnings,
        ...preview.warnings,
      ]),
    };
  }
  const outputDirectory =
    input.outputDirectory ??
    path.join(
      "exports",
      `${repaired.data.roster.factionId}-vs-unknown-${opponentSeed.data.factionId}-${pointsLimit}`,
    );
  const stress = await runRosterStressTest(
    repaired.data.roster,
    { kind: "faction", factionId: opponentSeed.data.factionId },
    {
      ...options,
      outputDirectory,
      suite: input.suite ?? "diverse-9",
      analysisStrategy: input.analysisStrategy ?? "staged",
      profilePolicyPath: input.profilePolicyPath,
      resumeManifestPath: input.resumeManifestPath,
      forceRetry: input.forceRetry,
      experimental: input.experimental,
    },
    dependencies,
  );
  if (!stress.ok || !stress.data) {
    return {
      ok: false,
      data: null,
      violations: stress.violations,
      warnings: uniqueIssues([
        ...seed.warnings,
        ...repaired.warnings,
        ...preview.warnings,
        ...stress.warnings,
      ]),
    };
  }
  return {
    ok: true,
    data: {
      schemaVersion: 1,
      resultKind: "tessera-build-and-stress",
      generatedAt: new Date().toISOString(),
      rosterRepair: repaired.data,
      portfolioPreview: preview.data,
      stressReport: stress.data,
      automaticRevisionApplied: false,
      revisionCandidatesRequireAuthorization: true,
    },
    violations: [],
    warnings: uniqueIssues([
      ...seed.warnings,
      ...repaired.warnings,
      ...preview.warnings,
      ...stress.warnings,
    ]),
  };
}
