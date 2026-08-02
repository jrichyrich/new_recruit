import type { DeterministicRosterRepairResult } from "./roster-repair";
import type {
  LegendsPlayContext,
  LegendsPolicy,
} from "./legends-policy";
import type {
  CollectionProfile,
  ResultEnvelope,
  RosterDraftV1,
  TesseraMatchupReport,
  TesseraSimulationBackend,
} from "./types";

export type BuildAndAnalyzeRosterInput = {
  prompt: string;
  playerFaction?: string;
  pointsLimit?: number;
  opponentRoster: RosterDraftV1;
  legendsPolicy?: LegendsPolicy;
  /** Compatibility input for callers that predate `legendsPolicy`. */
  allowLegends?: boolean;
  playContext?: LegendsPlayContext;
  collectionProfile?: CollectionProfile;
  requiredUnitIds?: string[];
  excludedUnitIds?: string[];
  requiredWarlordUnitId?: string;
  allowReadinessWarnings?: boolean;
  profilePolicyPath?: string;
  outputDirectory?: string;
  simulationBackend?: TesseraSimulationBackend;
  executionMode?: "prepare-only" | "simulate";
  experimental?: boolean;
};

export type BuildAndAnalyzeRosterResult = {
  schemaVersion: 1;
  resultKind: "tessera-build-and-analyze";
  generatedAt: string;
  stage: "roster-repaired" | "analysis-complete" | "failed";
  rosterRepair: DeterministicRosterRepairResult;
  opponent: {
    id: string;
    name: string;
    factionId: string;
    factionName: string;
    points: number;
    pointsLimit: number;
  };
  matchupReport: TesseraMatchupReport | null;
  collectionMode: "open-catalog" | "owned";
  failure: {
    stage: "readiness" | "analysis";
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  automaticRevisionApplied: false;
  revisionCandidatesRequireAuthorization: true;
};

export function compactBuildAndAnalyzeResult(
  result: ResultEnvelope<BuildAndAnalyzeRosterResult>,
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
  return {
    ok: result.ok,
    data: {
      schemaVersion: result.data.schemaVersion,
      resultKind: result.data.resultKind,
      stage: result.data.stage,
      status:
        result.data.matchupReport?.status ??
        (result.data.failure ? "failed" : result.data.stage),
      player: {
        name: result.data.rosterRepair.roster.name,
        factionId: result.data.rosterRepair.roster.factionId,
        factionName: result.data.rosterRepair.roster.factionName,
        points: result.data.rosterRepair.roster.totalPoints,
        pointsLimit: result.data.rosterRepair.roster.pointsLimit,
      },
      opponent: result.data.opponent,
      collectionMode: result.data.collectionMode,
      rosterRepair: {
        repaired: result.data.rosterRepair.repaired,
        candidatesEvaluated:
          result.data.rosterRepair.candidatesEvaluated,
        missionReadinessBand:
          result.data.rosterRepair.missionReadiness.overallBand,
        rosterFingerprint:
          result.data.rosterRepair.ranking.stableFingerprint,
      },
      failure: result.data.failure,
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
