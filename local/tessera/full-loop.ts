import { readFile } from "node:fs/promises";

import {
  buildRoster,
  previewFactionStressPortfolio,
  repairRosterDeterministically,
  type BuildAndStressRosterInput,
  type BuildAndStressRosterResult,
  type BuildRosterInput,
  type DeterministicRosterRepairResult,
  type ResultEnvelope,
  type RosterIssue,
  type TesseraStressPortfolioPreview,
  type TesseraStressRunReport,
} from "../../lib/rosterpilot";
import {
  runRosterStressTest,
  type TesseraStressDependencies,
  type TesseraStressOptions,
} from "./stress";

export type {
  BuildAndStressRosterInput,
  BuildAndStressRosterResult,
} from "../../lib/rosterpilot";
export {
  compactBuildAndStressResult,
} from "../../lib/rosterpilot";

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

function stagedResult(
  rosterRepair: DeterministicRosterRepairResult,
  portfolioPreview: TesseraStressPortfolioPreview | null,
  stressReport: TesseraStressRunReport | null,
  failureDetail: BuildAndStressRosterResult["failure"],
): BuildAndStressRosterResult {
  return {
    schemaVersion: 2,
    resultKind: "tessera-build-and-stress",
    generatedAt: new Date().toISOString(),
    stage: failureDetail
      ? "failed"
      : stressReport
        ? "stress-complete"
        : portfolioPreview
          ? "portfolio-previewed"
          : "roster-repaired",
    rosterRepair,
    portfolioPreview,
    stressReport,
    failure: failureDetail,
    automaticRevisionApplied: false,
    revisionCandidatesRequireAuthorization: true,
  };
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
    playerFaction: input.playerFaction,
    pointsLimit: input.pointsLimit,
    legendsPolicy: input.legendsPolicy,
    allowLegends: input.allowLegends,
    playContext: input.playContext,
    requiredUnitIds: input.requiredUnitIds,
    excludedUnitIds: input.excludedUnitIds,
    requiredWarlordUnitId: input.requiredWarlordUnitId,
    opponentContext: {
      kind: "known-faction",
      factionId: input.againstFaction,
    },
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
    playerFaction: seed.data.factionId,
    faction: seed.data.factionId,
    pointsLimit,
    name: stableRosterName(
      seed.data.factionName,
      pointsLimit,
      opponentSeed.data.factionName,
    ),
    preferences: seed.data.preferences,
    allowNamedCharacters: seed.data.constraints.allowNamedCharacters,
    legendsPolicy: input.legendsPolicy,
    allowLegends: input.allowLegends,
    playContext: input.playContext,
    requiredUnitIds:
      seed.data.constraints.requiredUnitIds ??
      input.requiredUnitIds,
    excludedUnitIds:
      seed.data.constraints.excludedUnitIds ??
      input.excludedUnitIds,
    requiredWarlordUnitId:
      seed.data.constraints.requiredWarlordUnitId ??
      input.requiredWarlordUnitId,
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
    const message = `The repaired roster uses ${Math.round(utilization * 1000) / 10}% of its points and has ${repaired.data.missionReadiness.overallBand} mission readiness. No New Recruit or Tessera activity was started. Use --allow-readiness-warnings only after reviewing the gate evidence.`;
    return {
      ok: false,
      data: stagedResult(
        repaired.data,
        null,
        null,
        {
          stage: "readiness",
          code: "TESSERA_BUILD_READINESS_GATE_FAILED",
          message,
          retryable: false,
        },
      ),
      violations: [
        {
          code: "TESSERA_BUILD_READINESS_GATE_FAILED",
          message,
          severity: "error",
        },
      ],
      warnings: uniqueIssues(repaired.warnings),
    };
  }
  let suite = input.suite;
  const recoveryManifestPath =
    input.resumeManifestPath ?? input.restartManifestPath;
  if (!suite && recoveryManifestPath) {
    try {
      const persisted = JSON.parse(
        await readFile(recoveryManifestPath, "utf8"),
      ) as {
        configuration?: {
          suite?: "core-3" | "diverse-9";
        };
      };
      suite = persisted.configuration?.suite;
    } catch {
      // The stress coordinator returns the structured unreadable-manifest
      // failure; preview keeps its normal default only for this preflight.
    }
  }
  const preview = await previewFactionStressPortfolio({
    faction: opponentSeed.data.factionId,
    pointsLimit,
    suite: suite ?? "diverse-9",
    pointsTolerancePercent: 5,
    allowLegends: false,
  });
  if (!preview.ok || !preview.data) {
    return {
      ok: false,
      data: stagedResult(
        repaired.data,
        preview.data,
        null,
        {
          stage: "portfolio",
          code:
            preview.violations[0]?.code ??
            "STRESS_PORTFOLIO_PREVIEW_FAILED",
          message:
            preview.violations[0]?.message ??
            "The opponent portfolio is not viable.",
          retryable: false,
        },
      ),
      violations: preview.violations,
      warnings: uniqueIssues([
        ...seed.warnings,
        ...repaired.warnings,
        ...preview.warnings,
      ]),
    };
  }
  const outputDirectory =
    input.outputDirectory ?? options.outputDirectory;
  const stress = await runRosterStressTest(
    repaired.data.roster,
    { kind: "faction", factionId: opponentSeed.data.factionId },
    {
      ...options,
      outputDirectory,
      suite,
      analysisStrategy: input.analysisStrategy,
      profilePolicyPath: input.profilePolicyPath,
      resumeManifestPath: input.resumeManifestPath,
      restartManifestPath: input.restartManifestPath,
      forceRetry: input.forceRetry,
      executionMode: input.executionMode,
      experimental: input.experimental,
      portfolioPreview: preview.data,
    },
    dependencies,
  );
  if (!stress.ok || !stress.data) {
    return {
      ok: false,
      data: stagedResult(
        repaired.data,
        preview.data,
        stress.data,
        {
          stage: "stress",
          code:
            stress.violations[0]?.code ??
            "TESSERA_STRESS_FAILED",
          message:
            stress.violations[0]?.message ??
            "The stress workflow failed after portfolio preflight.",
          retryable: stress.violations.some((violation) =>
            /TIMEOUT|SESSION|NAVIGATION|STALE/i.test(violation.code),
          ),
        },
      ),
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
    data: stagedResult(
      repaired.data,
      preview.data,
      stress.data,
      null,
    ),
    violations: [],
    warnings: uniqueIssues([
      ...seed.warnings,
      ...repaired.warnings,
      ...preview.warnings,
      ...stress.warnings,
    ]),
  };
}
