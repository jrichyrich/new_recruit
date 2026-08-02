import { compactStressResult } from "./stress-summary";
import type { DeterministicRosterRepairResult } from "./roster-repair";
import type {
  LegendsPlayContext,
  LegendsPolicy,
} from "./legends-policy";
import type {
  ResultEnvelope,
  TesseraStressAnalysisStrategy,
  TesseraStressPortfolioPreview,
  TesseraStressRunReport,
  TesseraStressSuite,
  TesseraSimulationBackend,
} from "./types";

export type BuildAndStressRosterInput = {
  prompt: string;
  playerFaction?: string;
  againstFaction: string;
  pointsLimit?: number;
  legendsPolicy?: LegendsPolicy;
  /** Compatibility input for callers that predate `legendsPolicy`. */
  allowLegends?: boolean;
  playContext?: LegendsPlayContext;
  requiredUnitIds?: string[];
  excludedUnitIds?: string[];
  requiredWarlordUnitId?: string;
  suite?: TesseraStressSuite;
  analysisStrategy?: TesseraStressAnalysisStrategy;
  profilePolicyPath?: string;
  outputDirectory?: string;
  simulationBackend?: TesseraSimulationBackend;
  resumeManifestPath?: string;
  restartManifestPath?: string;
  allowReadinessWarnings?: boolean;
  forceRetry?: boolean;
  executionMode?: "prepare-only" | "simulate";
  experimental?: boolean;
};

export type BuildAndStressRosterResult = {
  schemaVersion: 2;
  resultKind: "tessera-build-and-stress";
  generatedAt: string;
  stage:
    | "roster-repaired"
    | "portfolio-previewed"
    | "stress-complete"
    | "failed";
  rosterRepair: DeterministicRosterRepairResult;
  portfolioPreview: TesseraStressPortfolioPreview | null;
  stressReport: TesseraStressRunReport | null;
  failure: {
    stage: "readiness" | "portfolio" | "stress";
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  automaticRevisionApplied: false;
  revisionCandidatesRequireAuthorization: true;
};

export function compactBuildAndStressResult(
  result: ResultEnvelope<BuildAndStressRosterResult>,
  outputDirectory?: string,
): Record<string, unknown> {
  if (!result.data) {
    return {
      ok: result.ok,
      data: null,
      violations: result.violations,
      warnings: result.warnings.slice(0, 20),
      warningCount: result.warnings.length,
    };
  }
  const stress = result.data.stressReport
    ? compactStressResult(
        {
          ok: result.ok,
          data: result.data.stressReport,
          violations: result.violations,
          warnings: result.warnings,
        },
        outputDirectory,
      )
    : null;
  const stressData =
    stress &&
    typeof stress.data === "object" &&
    stress.data !== null
      ? stress.data as Record<string, unknown>
      : null;
  return {
    ok: result.ok,
    data: {
      schemaVersion: result.data.schemaVersion,
      resultKind: result.data.resultKind,
      stage: result.data.stage,
      status:
        stressData?.status ??
        (
          result.data.failure
            ? "failed"
            : result.data.stage
        ),
      player: {
        name: result.data.rosterRepair.roster.name,
        factionId:
          result.data.rosterRepair.roster.factionId,
        factionName:
          result.data.rosterRepair.roster.factionName,
        points:
          result.data.rosterRepair.roster.totalPoints,
        pointsLimit:
          result.data.rosterRepair.roster.pointsLimit,
      },
      opponent: result.data.portfolioPreview
        ? {
            factionId:
              result.data.portfolioPreview.portfolio.factionId,
            factionName:
              result.data.portfolioPreview.portfolio.factionName,
            pointsLimit:
              result.data.portfolioPreview.portfolio.pointsLimit,
          }
        : null,
      rosterRepair: {
        repaired: result.data.rosterRepair.repaired,
        candidatesEvaluated:
          result.data.rosterRepair.candidatesEvaluated,
        missionReadinessBand:
          result.data.rosterRepair.missionReadiness.overallBand,
        rosterFingerprint:
          result.data.rosterRepair.ranking.stableFingerprint,
      },
      portfolioCoverage:
        stressData?.portfolioCoverage ??
        result.data.portfolioPreview?.portfolio.coverage ??
        null,
      integrity: stressData?.integrity ?? null,
      failures: [
        ...(
          result.data.failure
            ? [result.data.failure]
            : []
        ),
        ...(
          Array.isArray(stressData?.failures)
            ? stressData.failures
            : []
        ),
      ],
      recovery: stressData?.recovery ?? null,
      artifactPaths: stressData?.artifactPaths ?? [],
      automaticRevisionApplied:
        result.data.automaticRevisionApplied,
      revisionCandidatesRequireAuthorization:
        result.data.revisionCandidatesRequireAuthorization,
    },
    violations: result.violations,
    warnings: result.warnings.slice(0, 20),
    warningCount: result.warnings.length,
  };
}
