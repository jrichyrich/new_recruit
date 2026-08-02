import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  StartTesseraRunOptions,
  TesseraRunJob,
  TesseraRunRequest,
  TesseraRunResult,
} from "../local/tessera/jobs";
import type {
  TesseraOptimizerDeliveryIntent,
  TesseraOptimizerMode,
} from "../local/tessera/optimizer";
import type {
  StartTesseraOptimizerInput,
  TesseraOptimizerStoreResult,
} from "../local/tessera/optimizer-store";
import type {
  StartTesseraGeneralOptimizerInput,
  TesseraGeneralOptimizerStoreResult,
} from "../local/tessera/general-optimizer-store";
import type {
  RunTesseraProviderParityWorkflowOptions,
  RunTesseraProviderParityWorkflowResult,
} from "../local/tessera/provider-parity-workflow";
import {
  tesseraScenarioContractSha256,
  TesseraScenarioContractSchema,
} from "../local/tessera/scenario-contract";
import {
  rebindTesseraScenarioContractProvider,
} from "../local/tessera/provider-parity-scenario-contract";

import {
  buildRoster,
  bytesToBase64,
  checkDataFreshness,
  compactBuildAndStressResult,
  compactBuildAndAnalyzeResult,
  compactStressResult,
  compactStressRevisionResult,
  compareFactions,
  explainRoster,
  exportRoster,
  getNewRecruitCapability,
  getDataStatus,
  getDataUpdateStatus,
  listDataConflicts,
  modifyRoster,
  modifyRosterBatch,
  prepareRosterWorkflow,
  prepareNewRecruitHandoff,
  rebaseRosterWithProvider,
  refreshDataNow,
  rollbackDataBundle,
  searchFactions,
  searchUnits,
  setCachedDataFreshness,
  validateRoster,
  withDataBundleSnapshotLease,
  CollectionProfileSchema,
  GeneralThreatArchetypeIds,
  LegendsPlayContextSchema,
  LegendsPolicySchema,
  ModifyRosterOperationSchema,
  RosterArtifactRequirementSchema,
  RosterCoachingModeSchema,
  RosterDraftSchema,
  RosterOptimizerModeSchema,
  RosterWorkflowIntentSchema,
  type ExportArtifact,
  type ExportFormat,
  type GeneralThreatArchetype,
  type GeneralThreatPortfolio,
  type BuildAndStressRosterInput,
  type BuildAndStressRosterResult,
  type BuildAndAnalyzeRosterInput,
  type BuildAndAnalyzeRosterResult,
  type DataBundleProvider,
  type LiveDataFreshness,
  type ModifyRosterOperation,
  type NewRecruitConnectionStatus,
  type NewRecruitDelivery,
  type NewRecruitHandoff,
  type PreferenceTag,
  type ResultEnvelope,
  type RosterDraftV1,
  type RosterWorkflowResult,
  type RuntimeProvenance,
  type TesseraConnectionStatus,
  type TesseraFrozenScenarioContract,
  type TesseraMatchupReport,
  type TesseraMetric,
  type TesseraPhase,
  type TesseraPreparedRoster,
  type TesseraRevisionComparisonReport,
  type TesseraSimulationBackend,
  type TesseraStressAnalysisStrategy,
  type TesseraStressPortfolioPreview,
  type TesseraStressRunReport,
  type TesseraStressRevisionReport,
  type TesseraStressSuite,
} from "../lib/rosterpilot/index";

type ArtifactWriter = (
  artifact: ExportArtifact,
  outputPath: string,
  overwrite: boolean,
) => Promise<string>;

type HandoffWriter = (
  artifacts: ExportArtifact[],
  outputDirectory: string,
  overwrite: boolean,
) => Promise<string[]>;

type ServerOptions = {
  runtimeProvenance?: () => RuntimeProvenance;
  artifactWriter?: ArtifactWriter;
  handoffWriter?: HandoffWriter;
  newRecruitCompanion?: {
    status: () => Promise<ResultEnvelope<NewRecruitConnectionStatus>>;
    deliver: (
      roster: RosterDraftV1,
      options: {
        downloadEnrichedRosz: boolean;
        downloadPrettyHtml: boolean;
        outputDirectory: string;
        overwrite: boolean;
      },
    ) => Promise<ResultEnvelope<NewRecruitDelivery>>;
  };
  tesseraCompanion?: {
    status: () => Promise<ResultEnvelope<TesseraConnectionStatus>>;
    prepare: (
      roster: RosterDraftV1,
      options: {
        outputDirectory: string;
        overwrite: boolean;
        catalogueDriftMode?: "reject" | "diagnostic";
      },
    ) => Promise<ResultEnvelope<TesseraPreparedRoster>>;
    analyze: (
      playerRoster: RosterDraftV1,
      opponent:
        | { kind: "roster"; roster: RosterDraftV1 }
        | { kind: "rosz"; path: string },
      options: {
        outputDirectory: string;
        overwrite: boolean;
        simulationBackend?: TesseraSimulationBackend;
        executionMode?: "prepare-only" | "simulate";
        fallbackMode?: "none" | "baseline-damage-v1";
        profilePolicyPath?: string;
        experimental: boolean;
        analysisMode: "quick" | "full";
        phases?: TesseraPhase[];
        metrics?: TesseraMetric[];
        allowPointMismatch: boolean;
        includeChangeCandidates: boolean;
        scenarioContract?: TesseraFrozenScenarioContract[];
        opponentRosterContext?: RosterDraftV1;
        catalogueDriftMode?: "reject" | "diagnostic";
      },
    ) => Promise<ResultEnvelope<TesseraMatchupReport>>;
    compare?: (
      baselineReportPath: string,
      revisedRoster: RosterDraftV1,
      options: {
        outputDirectory: string;
        overwrite: boolean;
        profilePolicyPath?: string;
        executionMode?: "simulate";
        experimental: boolean;
        catalogueDriftMode?: "reject" | "diagnostic";
      },
    ) => Promise<ResultEnvelope<TesseraRevisionComparisonReport>>;
    buildAndAnalyze?: (
      input: BuildAndAnalyzeRosterInput,
      options: {
        outputDirectory?: string;
        overwrite: boolean;
        simulationBackend?: TesseraSimulationBackend;
        catalogueDriftMode?: "reject" | "diagnostic";
      },
    ) => Promise<ResultEnvelope<BuildAndAnalyzeRosterResult>>;
    stressTest?: (
      playerRoster: RosterDraftV1,
      opponent: {
        kind: "faction";
        factionId: string;
      },
      options: {
        simulationBackend?: TesseraSimulationBackend;
        suite?: TesseraStressSuite;
        analysisStrategy?: TesseraStressAnalysisStrategy;
        resumeManifestPath?: string;
        restartManifestPath?: string;
        profilePolicyPath?: string;
        forceRetry?: boolean;
        executionMode?: "prepare-only" | "simulate";
        outputDirectory?: string;
        overwrite: boolean;
        experimental: boolean;
        catalogueDriftMode?: "reject" | "diagnostic";
      },
    ) => Promise<ResultEnvelope<TesseraStressRunReport>>;
    previewPortfolio?: (input: {
      faction: string;
      pointsLimit: number;
      suite?: TesseraStressSuite;
      pointsTolerancePercent: number;
      allowLegends: boolean;
    }) => Promise<ResultEnvelope<TesseraStressPortfolioPreview>>;
    buildAndStress?: (
      input: BuildAndStressRosterInput,
      options: {
        outputDirectory?: string;
        overwrite: boolean;
        simulationBackend?: TesseraSimulationBackend;
        catalogueDriftMode?: "reject" | "diagnostic";
      },
    ) => Promise<ResultEnvelope<BuildAndStressRosterResult>>;
    compareStressRevision?: (
      baselineReportPath: string,
      revisedRoster: RosterDraftV1,
      options: {
        outputDirectory?: string;
        overwrite: boolean;
        executionMode?: "simulate";
        experimental: boolean;
        catalogueDriftMode?: "reject" | "diagnostic";
      },
    ) => Promise<ResultEnvelope<TesseraStressRevisionReport>>;
    compareProviders?: (
      options: RunTesseraProviderParityWorkflowOptions,
    ) => Promise<RunTesseraProviderParityWorkflowResult>;
  };
  tesseraRunJobs?: {
    start: (
      request: TesseraRunRequest,
      options?: StartTesseraRunOptions,
    ) => Promise<TesseraRunJob>;
    status: (
      jobPath: string,
      includeResult?: boolean,
    ) => Promise<{
      job: TesseraRunJob;
      result: TesseraRunResult | null;
    }>;
    resume: (
      jobPath: string,
      options?: {
        restartFrom?: boolean;
        outputDirectory?: string;
      },
    ) => Promise<TesseraRunJob>;
    resolveProfiles: (
      jobPath: string,
      policy: {
        schemaVersion: 1;
        policyKind: "tessera-profile-policy";
        entries: Array<{
          faction: string;
          unit: string;
          unitOccurrence?: number;
          modelCount?: number;
          weaponGroup: string;
          phase: TesseraPhase;
          selectedProfile: string;
          activeCount: number;
        }>;
      },
    ) => Promise<TesseraRunJob>;
    restoreNewRecruitArtifact?: (
      roster: RosterDraftV1,
      jobPath: string,
    ) => Promise<ResultEnvelope<NewRecruitDelivery>>;
    cancel: (jobPath: string) => Promise<TesseraRunJob>;
  };
  tesseraOptimizerStore?: {
    start: (
      input: StartTesseraOptimizerInput,
    ) => Promise<TesseraOptimizerStoreResult>;
    status: (
      statePath: string,
    ) => Promise<TesseraOptimizerStoreResult>;
    approveCandidates: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        candidateIds: string[];
        approvalId: string;
        approvedBy: string;
        approvedAt?: string;
      },
    ) => Promise<TesseraOptimizerStoreResult>;
    recordComparison: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        candidateId: string;
        reportPath: string;
        recordedAt?: string;
      },
    ) => Promise<TesseraOptimizerStoreResult>;
    approveWinner: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        candidateId: string;
        approvalId: string;
        approvedBy: string;
        approvedAt?: string;
      },
    ) => Promise<TesseraOptimizerStoreResult>;
    retainBaseline: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        approvalId: string;
        approvedBy: string;
        approvedAt?: string;
      },
    ) => Promise<TesseraOptimizerStoreResult>;
    finalize: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        deliveryIntent: TesseraOptimizerDeliveryIntent;
        finalizedAt?: string;
      },
    ) => Promise<TesseraOptimizerStoreResult>;
  };
  tesseraGeneralOptimizerStore?: {
    start: (
      input: StartTesseraGeneralOptimizerInput,
    ) => Promise<TesseraGeneralOptimizerStoreResult>;
    status: (
      statePath: string,
    ) => Promise<TesseraGeneralOptimizerStoreResult>;
    approveCandidates: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        candidateIds: string[];
        approvalId: string;
        approvedBy: string;
        approvedAt?: string;
      },
    ) => Promise<TesseraGeneralOptimizerStoreResult>;
    recordComparison: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        candidateId: string;
        archetypeId: GeneralThreatArchetype;
        requestSha256: string;
        reportPath: string;
        recordedAt?: string;
      },
    ) => Promise<TesseraGeneralOptimizerStoreResult>;
    approveWinner: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        candidateId: string;
        approvalId: string;
        approvedBy: string;
        approvedAt?: string;
      },
    ) => Promise<TesseraGeneralOptimizerStoreResult>;
    retainBaseline: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        approvalId: string;
        approvedBy: string;
        approvedAt?: string;
      },
    ) => Promise<TesseraGeneralOptimizerStoreResult>;
    finalize: (
      statePath: string,
      input: {
        expectedStateRevision: number;
        deliveryIntent: TesseraOptimizerDeliveryIntent;
        finalizedAt?: string;
      },
    ) => Promise<TesseraGeneralOptimizerStoreResult>;
  };
  freshnessChecker?: () => Promise<ResultEnvelope<LiveDataFreshness>>;
  freshnessCacheMs?: number;
  dataBundleProvider?: DataBundleProvider;
};

const GeneralThreatArchetypeSchema = z.enum(
  GeneralThreatArchetypeIds,
);

const GeneralThreatPortfolioInputSchema = z.object({
  schemaVersion: z.literal(1),
  portfolioKind: z.literal("general-threat-portfolio"),
  version: z.literal("general-threat-portfolio-v1"),
  pointsLimit: z.union([z.literal(1000), z.literal(2000)]),
  generatedFrom: z.literal("active-data-bundle"),
  portfolioHash: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(z.object({
    archetypeId: GeneralThreatArchetypeSchema,
    label: z.string().min(1),
    purpose: z.string().min(1),
    representativeFactionId: z.string().min(1),
    representativeFactionName: z.string().min(1),
    roster: RosterDraftSchema,
    simulationFingerprint: z.string().min(1),
    traits: z.unknown(),
    score: z.number(),
    selectionEvidence: z.array(z.string()),
  })).length(6),
  limitations: z.array(z.string()),
});

function serializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resultContent<T>(result: ResultEnvelope<T>) {
  const normalized = serializable(result) as unknown as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(normalized, null, 2) }],
    structuredContent: normalized,
    isError: !result.ok,
  };
}

function opponentScopeRequired() {
  return {
    ok: false,
    data: null,
    violations: [
      {
        code: "OPPONENT_SCOPE_REQUIRED",
        message:
          "Provide an exact opponent roster or .rosz, or use the faction stress workflow when only the opponent faction is known.",
        severity: "error" as const,
      },
    ],
    warnings: [],
  };
}

function valueContent(value: unknown) {
  const normalized = serializable(value) as Record<string, unknown>;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(normalized, null, 2),
      },
    ],
    structuredContent: normalized,
  };
}

function shouldStartDurableTesseraRun(
  executionMode: "prepare-only" | "simulate" | undefined,
  experimental: boolean,
  recoveryRequested = false,
): boolean {
  return (
    recoveryRequested ||
    executionMode === "simulate" ||
    (executionMode === undefined && experimental)
  );
}

function requestedCatalogueDriftMode(
  requested: boolean | undefined,
  inheritFrozenPolicy = false,
): "reject" | "diagnostic" | undefined {
  if (requested === true) return "diagnostic";
  return inheritFrozenPolicy ? undefined : "reject";
}

function inProgressJobContent(job: TesseraRunJob) {
  return valueContent({
    status: "in-progress",
    runId: job.runId,
    manifestPath: job.manifestPath,
    job,
  });
}

function detailedResultContent<T>(
  result: ResultEnvelope<T>,
  responseDetail: "compact" | "full",
  compact: (result: ResultEnvelope<T>) => Record<string, unknown>,
) {
  if (responseDetail === "full") return resultContent(result);
  const normalized = serializable(compact(result));
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(normalized, null, 2),
      },
    ],
    structuredContent: normalized,
    isError: !result.ok,
  };
}

function inlineArtifact(result: ResultEnvelope<ExportArtifact>) {
  if (!result.data) return resultContent(result);
  const artifact = result.data;
  const data = serializableArtifact(artifact);
  return resultContent({
    ok: result.ok,
    data,
    violations: result.violations,
    warnings: result.warnings,
  });
}

function serializableArtifact(artifact: ExportArtifact) {
  return {
    format: artifact.format,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    encoding: artifact.encoding === "binary" ? "base64" : "utf8",
    content:
      typeof artifact.content === "string"
        ? artifact.content
        : bytesToBase64(artifact.content),
  };
}

function inlineHandoff(result: ResultEnvelope<NewRecruitHandoff>) {
  if (!result.data) return resultContent(result);
  const data = {
    ...result.data,
    artifacts: result.data.artifacts.map(serializableArtifact),
  };
  return resultContent({
    ok: result.ok,
    data,
    violations: result.violations,
    warnings: result.warnings,
  });
}

function serializableRosterWorkflow(
  workflow: RosterWorkflowResult,
  responseDetail: "compact" | "full" = "compact",
) {
  const serialized = {
    ...workflow,
    newRecruit: {
      ...workflow.newRecruit,
      handoff: workflow.newRecruit.handoff
        ? {
            ...workflow.newRecruit.handoff,
            artifacts:
              workflow.newRecruit.handoff.artifacts.map(
                serializableArtifact,
              ),
          }
        : null,
    },
  };
  if (responseDetail === "full") return serialized;
  const target = workflow.optimization?.target;
  return {
    ...serialized,
    explanation: workflow.explanation
      ? {
          summary: workflow.explanation.summary,
          choices: workflow.explanation.choices,
          cautions: workflow.explanation.cautions,
        }
      : null,
    coaching: workflow.coaching
      ? {
          schemaVersion: workflow.coaching.schemaVersion,
          reportKind: workflow.coaching.reportKind,
          mode: workflow.coaching.mode,
          rosterFingerprint:
            workflow.coaching.rosterFingerprint,
          heuristicPack: workflow.coaching.heuristicPack,
          applicability: workflow.coaching.applicability,
          summary: workflow.coaching.summary,
          unitRoles: workflow.coaching.units.map((unit) => ({
            selectionId: unit.selectionId,
            name: unit.name,
            roles: unit.roles.map((role) => role.role),
          })),
          advice: workflow.coaching.advice,
          disclaimer: workflow.coaching.disclaimer,
          warningCodes: workflow.coaching.warningCodes,
        }
      : null,
    optimization: workflow.optimization
      ? {
          ...workflow.optimization,
          target:
            target?.kind === "general-six-archetype"
              ? {
                  kind: target.kind,
                  portfolioHash: target.portfolio.portfolioHash,
                  pointsLimit: target.portfolio.pointsLimit,
                  items: target.portfolio.items.map((item) => ({
                    archetypeId: item.archetypeId,
                    label: item.label,
                    representativeFactionId:
                      item.representativeFactionId,
                    representativeFactionName:
                      item.representativeFactionName,
                    simulationFingerprint:
                      item.simulationFingerprint,
                    selectionEvidence: item.selectionEvidence,
                  })),
                  limitations: target.portfolio.limitations,
                }
              : target?.kind === "known-faction"
                ? {
                    kind: target.kind,
                    factionId: target.factionId,
                    portfolioHash:
                      target.portfolioPreview.portfolio.contract
                        ?.portfolioHash ?? null,
                    gates: target.portfolioPreview.gates,
                    items: target.portfolioPreview.items,
                  }
                : target?.kind === "exact-opponent"
                  ? {
                      kind: target.kind,
                      factionId: target.factionId,
                      rosterId: target.roster.id,
                      rosterName: target.roster.name,
                    }
                  : null,
        }
      : null,
  };
}

function compactTesseraOptimizerStoreResult(
  result: TesseraOptimizerStoreResult,
): Record<string, unknown> {
  const snapshot = result.data;
  if (!snapshot) {
    return {
      ok: result.ok,
      data: null,
      violations: result.violations,
      warnings: result.warnings,
    };
  }
  const { state } = snapshot;
  return {
    ok: result.ok,
    data: {
      statePath: snapshot.statePath,
      optimizerDirectory: snapshot.optimizerDirectory,
      optimizerRunId: state.optimizerRunId,
      mode: state.mode,
      stage: state.stage,
      stateRevision: state.stateRevision,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      contextSha256: state.frozenIdentities.contextSha256,
      baseline: {
        kind: state.baseline.kind,
        runId: state.baseline.runId,
        reportPath: state.baseline.reportPath,
        rosterId: state.baseline.roster.id,
        rosterName: state.baseline.roster.name,
        factionId: state.baseline.roster.factionId,
        points: `${state.baseline.roster.totalPoints}/${state.baseline.roster.pointsLimit}`,
      },
      baselineSuggestions: state.baselineSuggestions,
      candidates: state.candidates.map((candidate) => ({
        candidateId: candidate.candidate.candidateId,
        operation: candidate.candidate.operation,
        status: candidate.status,
        beforePoints: candidate.candidate.beforePoints,
        afterPoints: candidate.candidate.afterPoints,
        localRejection: candidate.localRejection,
        comparisonRequestSha256:
          candidate.comparisonRequest?.requestSha256 ?? null,
        comparison: candidate.comparison,
      })),
      pareto: state.pareto,
      finalization: state.finalization
        ? {
            disposition: state.finalization.disposition,
            candidateId: state.finalization.candidateId,
            rosterId: state.finalization.roster.id,
            rosterName: state.finalization.roster.name,
            deliveryIntent: state.finalization.deliveryIntent,
            finalizedAt: state.finalization.finalizedAt,
            finalizationSha256:
              state.finalization.finalizationSha256,
          }
        : null,
      invalidation: state.invalidation,
      comparisonRequests: snapshot.comparisonRequests,
      artifacts: {
        baselineReport: snapshot.baselineReportArtifact,
        profilePolicy: snapshot.profilePolicyArtifact,
        candidateRosters: snapshot.candidateRosterArtifacts,
        comparisons: snapshot.comparisonArtifacts,
        finalRoster: snapshot.finalRosterArtifact,
      },
    },
    violations: result.violations,
    warnings: result.warnings,
  };
}

function tesseraOptimizerStoreContent(
  result: TesseraOptimizerStoreResult,
  responseDetail: "compact" | "full",
) {
  if (responseDetail === "full") return resultContent(result);
  const compact = compactTesseraOptimizerStoreResult(result);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(compact, null, 2),
      },
    ],
    structuredContent: compact,
    isError: !result.ok,
  };
}

function compactTesseraGeneralOptimizerStoreResult(
  result: TesseraGeneralOptimizerStoreResult,
): Record<string, unknown> {
  const snapshot = result.data;
  if (!snapshot) {
    return {
      ok: result.ok,
      data: null,
      violations: result.violations,
      warnings: result.warnings,
    };
  }
  const { state } = snapshot;
  return {
    ok: result.ok,
    data: {
      statePath: snapshot.statePath,
      optimizerDirectory: snapshot.optimizerDirectory,
      optimizerRunId: state.optimizerRunId,
      mode: state.mode,
      stage: state.stage,
      stateRevision: state.stateRevision,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      contextSha256: state.frozenIdentities.contextSha256,
      portfolio: {
        pointsLimit: state.portfolio.pointsLimit,
        portfolioHash: state.portfolio.portfolioHash,
        archetypes: state.baselines.map((baseline) => ({
          archetypeId: baseline.archetypeId,
          label: baseline.label,
          runId: baseline.runId,
          reportPath: baseline.reportPath,
        })),
      },
      baselineRoster: {
        rosterId: state.baselineRoster.id,
        rosterName: state.baselineRoster.name,
        factionId: state.baselineRoster.factionId,
        points:
          `${state.baselineRoster.totalPoints}/${state.baselineRoster.pointsLimit}`,
      },
      baselineSuggestions: state.baselineSuggestions,
      candidates: state.candidates.map((candidate) => ({
        candidateId: candidate.candidate.candidateId,
        operation: candidate.candidate.operation,
        status: candidate.status,
        beforePoints: candidate.candidate.beforePoints,
        afterPoints: candidate.candidate.afterPoints,
        sources: candidate.sources,
        localRejection: candidate.localRejection,
        comparisonRequests: candidate.comparisonRequests.map(
          (request) => ({
            archetypeId: request.archetypeId,
            requestSha256: request.requestSha256,
            runRequest: request.runRequest,
          }),
        ),
        comparisonCount: candidate.comparisons.length,
      })),
      pareto: state.pareto,
      finalization: state.finalization
        ? {
            disposition: state.finalization.disposition,
            candidateId: state.finalization.candidateId,
            rosterId: state.finalization.roster.id,
            rosterName: state.finalization.roster.name,
            deliveryIntent: state.finalization.deliveryIntent,
            finalizedAt: state.finalization.finalizedAt,
            finalizationSha256:
              state.finalization.finalizationSha256,
          }
        : null,
      invalidation: state.invalidation,
      comparisonRequests: snapshot.comparisonRequests,
      artifacts: {
        portfolio: snapshot.portfolioArtifact,
        baselineReports: snapshot.baselineReportArtifacts,
        profilePolicies: snapshot.profilePolicyArtifacts,
        candidateRosters: snapshot.candidateRosterArtifacts,
        comparisons: snapshot.comparisonArtifacts,
        finalRoster: snapshot.finalRosterArtifact,
      },
    },
    violations: result.violations,
    warnings: result.warnings,
  };
}

function tesseraGeneralOptimizerStoreContent(
  result: TesseraGeneralOptimizerStoreResult,
  responseDetail: "compact" | "full",
) {
  if (responseDetail === "full") return resultContent(result);
  const compact = compactTesseraGeneralOptimizerStoreResult(result);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(compact, null, 2),
      },
    ],
    structuredContent: compact,
    isError: !result.ok,
  };
}

export function createRosterPilotMcpServer(
  options: ServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "rosterpilot",
    version: "0.2.0",
  });
  const registerTool = server.registerTool.bind(server);
  (
    server as unknown as {
      registerTool: (...args: unknown[]) => unknown;
    }
  ).registerTool = (...args: unknown[]) => {
    const toolName =
      typeof args[0] === "string" ? args[0] : "";
    const controlPlaneTool =
      toolName === "get_data_update_status" ||
      toolName === "refresh_data_now" ||
      toolName === "rollback_data_bundle";
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof handler === "function" && !controlPlaneTool) {
      args[handlerIndex] = (...handlerArgs: unknown[]) =>
        withDataBundleSnapshotLease(
          () => Reflect.apply(handler, undefined, handlerArgs),
          options.dataBundleProvider ?? null,
        );
    }
    return Reflect.apply(registerTool, server, args);
  };
  let freshnessCache:
    | {
        expiresAt: number;
        result: ResultEnvelope<LiveDataFreshness>;
      }
    | undefined;

  async function currentFreshness(
    force = false,
  ): Promise<ResultEnvelope<LiveDataFreshness>> {
    if (!force && freshnessCache && freshnessCache.expiresAt > Date.now()) {
      return freshnessCache.result;
    }
    const result = await (options.freshnessChecker ?? checkDataFreshness)();
    const cacheMs = options.freshnessCacheMs ?? 15 * 60_000;
    freshnessCache = {
      expiresAt: Date.now() + cacheMs,
      result,
    };
    setCachedDataFreshness(result, cacheMs);
    return result;
  }

  server.registerTool(
    "get_data_status",
    {
      title: "Get roster data status",
      description:
        "Return the active leased-data identity, exact source provenance, buildable factions, coverage, update-provider state, and attribution.",
      inputSchema: {},
    },
    async () => {
      const result = getDataStatus();
      const updateStatus = await getDataUpdateStatus(
        options.dataBundleProvider,
      );
      return resultContent({
        ...result,
        data:
          result.data
            ? {
                ...result.data,
                ...(updateStatus.data
                  ? { dataBundle: updateStatus.data }
                  : {}),
                ...(options.runtimeProvenance
                  ? { runtime: options.runtimeProvenance() }
                  : {}),
              }
            : result.data,
        warnings: [
          ...result.warnings,
          ...updateStatus.warnings,
          ...updateStatus.violations.map((violation) => ({
            ...violation,
            severity: "warn" as const,
          })),
        ],
      });
    },
  );

  server.registerTool(
    "check_data_freshness",
    {
      title: "Check live roster data freshness",
      description:
        "Compare the active bundle's exact source provenance with the current rules package, BSData commit, and official publication. This diagnostic is cached for 15 minutes unless force is true and never activates data.",
      inputSchema: {
        force: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ force }) => resultContent(await currentFreshness(force)),
  );

  server.registerTool(
    "get_data_update_status",
    {
      title: "Get signed data update status",
      description:
        "Distinguish the bundle currently in use from the latest verified bundle and latest upstream candidate, including scoped quarantines.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      resultContent(
        await getDataUpdateStatus(options.dataBundleProvider),
      ),
  );

  server.registerTool(
    "refresh_data_now",
    {
      title: "Refresh signed roster data",
      description:
        "Check the signed stable channel now, verify and classify a candidate, and atomically activate only safe scopes for future requests.",
      inputSchema: {
        force: z.boolean().default(true),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ force }) =>
      resultContent(
        await refreshDataNow(
          { force },
          options.dataBundleProvider,
        ),
      ),
  );

  server.registerTool(
    "rollback_data_bundle",
    {
      title: "Roll back roster data",
      description:
        "Atomically select an archived, verified bundle for future requests. Existing roster builds and durable jobs retain their leased bundle.",
      inputSchema: {
        bundleId: z.string().regex(/^[a-f0-9]{64}$/),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ bundleId }) =>
      resultContent(
        await rollbackDataBundle(
          bundleId,
          options.dataBundleProvider,
        ),
      ),
  );

  server.registerTool(
    "list_data_conflicts",
    {
      title: "List roster data conflicts",
      description:
        "List explicit unit, points, equipment, detachment, enhancement, or catalogue disagreements in the active leased bundle between official-first roster rules and the New Recruit interoperability source.",
      inputSchema: {
        factionId: z.string().optional(),
        entityType: z
          .enum([
            "catalogue",
            "unit",
            "points",
            "equipment",
            "detachment",
            "enhancement",
          ])
          .optional(),
        blocking: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().nonnegative().default(0),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => resultContent({
      ok: true,
      data: listDataConflicts(input),
      violations: [],
      warnings: [],
    }),
  );

  server.registerTool(
    "get_new_recruit_capability",
    {
      title: "Get New Recruit export coverage",
      description:
        "Report current catalogue, unit, loadout, detachment, and conflict coverage for one faction.",
      inputSchema: {
        factionId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ factionId }) => resultContent({
      ok: true,
      data: getNewRecruitCapability(factionId),
      violations: [],
      warnings: [],
    }),
  );

  server.registerTool(
    "search_factions",
    {
      title: "Search factions",
      description:
        "Search all embedded 11th-edition factions and report deterministic build support.",
      inputSchema: {
        query: z.string().default(""),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ query, limit }) => resultContent(searchFactions(query, limit)),
  );

  server.registerTool(
    "compare_factions",
    {
      title: "Compare factions",
      description: "Compare faction unit coverage and inferred play-style tags.",
      inputSchema: {
        factions: z.array(z.string()).min(2).max(8),
      },
    },
    async ({ factions: factionQueries }) =>
      resultContent(compareFactions(factionQueries)),
  );

  server.registerTool(
    "search_units",
    {
      title: "Search units",
      description:
        "Search units by faction, name, keyword, role, and structured preference tags.",
      inputSchema: {
        faction: z.string().default("adeptus-custodes"),
        query: z.string().default(""),
        tags: z
          .array(
            z.enum([
              "mobility",
              "durability",
              "objective",
              "shooting",
              "melee",
              "elite",
              "horde",
            ]),
          )
          .default([]),
        includeLegends: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(30),
      },
    },
    async (input) =>
      resultContent(
        searchUnits({
          ...input,
          tags: input.tags as PreferenceTag[],
        }),
      ),
  );

  server.registerTool(
    "run_roster_workflow",
    {
      title: "Build, coach, and optionally hand off a roster",
      description:
        "Resolve the player faction without fuzzy fallback, build and validate under one data-bundle lease, add calibrated competitive coaching, and prepare artifact-safe New Recruit or Tessera inputs. Direct New Recruit delivery occurs only when this same call explicitly requests deliver-new-recruit or uses an unambiguous upload/import instruction.",
      inputSchema: {
        prompt: z.string().optional(),
        intent: RosterWorkflowIntentSchema.optional(),
        artifactRequirement:
          RosterArtifactRequirementSchema.optional(),
        coachingMode: RosterCoachingModeSchema.optional(),
        optimizerMode: RosterOptimizerModeSchema.optional(),
        playerFaction: z.string().optional(),
        faction: z.string().optional(),
        opponentFaction: z.string().optional(),
        opponentRoster: RosterDraftSchema.optional(),
        pointsLimit: z.number().int().min(100).max(5000).optional(),
        name: z.string().optional(),
        preferences: z
          .array(
            z.enum([
              "mobility",
              "durability",
              "objective",
              "shooting",
              "melee",
              "elite",
              "horde",
            ]),
          )
          .optional(),
        allowNamedCharacters: z.boolean().optional(),
        legendsPolicy: LegendsPolicySchema.optional(),
        allowLegends: z.boolean().optional(),
        playContext: LegendsPlayContextSchema.optional(),
        collectionUnitIds: z.array(z.string().min(1)).optional(),
        collectionProfile: CollectionProfileSchema.optional(),
        requiredUnitIds: z.array(z.string().min(1)).optional(),
        excludedUnitIds: z.array(z.string().min(1)).optional(),
        requiredWarlordUnitId: z.string().min(1).optional(),
        detachmentId: z.string().min(1).optional(),
        forceDispositionId: z.string().min(1).optional(),
        missionContext: z
          .object({
            missionPackId: z.string().min(1),
            missionId: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        terrainContext: z
          .object({
            formatId: z.string().min(1),
            layoutId: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        downloadPrettyHtml: z.boolean().default(true),
        outputDirectory: z
          .string()
          .min(1)
          .default("exports/new-recruit"),
        tesseraOutputDirectory: z
          .string()
          .min(1)
          .default("exports/tessera"),
        simulationBackend: z
          .enum(["auto", "local-engine", "website"])
          .optional(),
        overwrite: z.boolean().default(false),
        responseDetail: z
          .enum(["compact", "full"])
          .default("compact"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      downloadPrettyHtml,
      outputDirectory,
      tesseraOutputDirectory,
      simulationBackend,
      overwrite,
      responseDetail,
      opponentRoster,
      ...input
    }) => {
      const prepared = await prepareRosterWorkflow({
        ...input,
        opponentContext: opponentRoster
          ? {
              kind: "known-roster",
              roster: opponentRoster as RosterDraftV1,
            }
          : undefined,
        preferences:
          input.preferences as PreferenceTag[] | undefined,
      });
      if (!prepared.data) return resultContent(prepared);
      const workflow = serializableRosterWorkflow(
        prepared.data,
        responseDetail,
      );
      let tesseraBaselineExecution:
        | {
            status: "not-requested";
          }
        | {
            status: "unavailable";
            reason: string;
          }
        | {
            status: "in-progress";
            targetKind: RosterWorkflowResult["optimization"] extends
              { target: infer Target }
              ? Target extends { kind: infer Kind }
                ? Kind
                : string
              : string;
            jobs: Array<
              (TesseraRunJob & {
                targetId: string;
                targetLabel: string;
              }) | {
                targetId: string;
                targetLabel: string;
                runId: string;
                runKind: string;
                status: string;
                requestPath: string;
                resultPath: string;
              }
            >;
          } = { status: "not-requested" };
      if (
        prepared.ok &&
        prepared.data.optimization &&
        prepared.data.roster
      ) {
        if (!options.tesseraRunJobs) {
          const reason =
            "This transport cannot start durable Tessera runs. Use the local MCP/CLI transport; the source ROSZ is prepared, but no profile-rich archive or paired baseline exists yet.";
          tesseraBaselineExecution = {
            status: "unavailable",
            reason,
          };
          return resultContent({
            ok: false,
            data: {
              ...workflow,
              execution: {
                newRecruitDelivery: {
                  status: "not-run",
                  reason:
                    "Optimization defers New Recruit winner delivery until an exact winner approval.",
                },
                tesseraBaseline: tesseraBaselineExecution,
              },
            },
            violations: [
              {
                code: "TESSERA_DURABLE_RUNNER_UNAVAILABLE",
                message: reason,
                severity: "error" as const,
              },
            ],
            warnings: prepared.warnings,
          });
        }
        const target = prepared.data.optimization.target;
        const commonExactOptions = {
          outputDirectory: tesseraOutputDirectory,
          overwrite: false,
          executionMode: "simulate" as const,
          fallbackMode: "none" as const,
          simulationBackend,
          experimental: false,
          analysisMode: "full" as const,
          allowPointMismatch: false,
          includeChangeCandidates: true,
          catalogueDriftMode: "reject" as const,
        };
        const requests: Array<{
          targetId: string;
          targetLabel: string;
          request: TesseraRunRequest;
        }> =
          target.kind === "exact-opponent"
            ? [
                {
                  targetId: target.roster.id,
                  targetLabel: target.roster.name,
                  request: {
                    kind: "exact",
                    playerRoster: prepared.data.roster,
                    opponent: {
                      kind: "roster",
                      roster: target.roster,
                    },
                    options: commonExactOptions,
                  },
                },
              ]
            : target.kind === "known-faction"
              ? [
                  {
                    targetId: target.factionId,
                    targetLabel:
                      target.portfolioPreview.portfolio.factionName,
                    request: {
                      kind: "stress",
                      playerRoster: prepared.data.roster,
                      factionId: target.factionId,
                      options: {
                        outputDirectory: tesseraOutputDirectory,
                        overwrite: false,
                        suite: "diverse-9",
                        analysisStrategy: "staged",
                        executionMode: "simulate",
                        simulationBackend,
                        experimental: false,
                        catalogueDriftMode: "reject",
                        portfolioPreview: target.portfolioPreview,
                      },
                    },
                  },
                ]
              : target.portfolio.items.map((item) => ({
                  targetId: item.archetypeId,
                  targetLabel:
                    `${item.label} (${item.representativeFactionName})`,
                  request: {
                    kind: "exact" as const,
                    playerRoster: prepared.data!.roster!,
                    opponent: {
                      kind: "roster" as const,
                      roster: item.roster,
                    },
                    options: commonExactOptions,
                  },
                }));
        const jobs: Array<{
          targetId: string;
          targetLabel: string;
          job: TesseraRunJob;
        }> = [];
        try {
          for (const entry of requests) {
            jobs.push({
              targetId: entry.targetId,
              targetLabel: entry.targetLabel,
              job: await options.tesseraRunJobs.start(entry.request, {
                outputDirectory: tesseraOutputDirectory,
              }),
            });
          }
        } catch (error) {
          return resultContent({
            ok: false,
            data: {
              ...workflow,
              execution: {
                newRecruitDelivery: {
                  status: "not-run",
                  reason:
                    "Optimization defers New Recruit winner delivery until an exact winner approval.",
                },
                tesseraBaseline: {
                  status: "failed",
                  targetKind: target.kind,
                  startedJobs: jobs.map((entry) => ({
                    targetId: entry.targetId,
                    targetLabel: entry.targetLabel,
                    ...entry.job,
                  })),
                  reason:
                    error instanceof Error
                      ? error.message
                      : "A durable Tessera baseline run could not be started.",
                },
              },
            },
            violations: [
              {
                code: "TESSERA_BASELINE_START_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : "A durable Tessera baseline run could not be started.",
                severity: "error" as const,
              },
            ],
            warnings: prepared.warnings,
          });
        }
        tesseraBaselineExecution = {
          status: "in-progress",
          targetKind: target.kind,
          jobs:
            responseDetail === "full"
              ? jobs.map((entry) => ({
                  targetId: entry.targetId,
                  targetLabel: entry.targetLabel,
                  ...entry.job,
                }))
              : jobs.map((entry) => ({
                  targetId: entry.targetId,
                  targetLabel: entry.targetLabel,
                  runId: entry.job.runId,
                  runKind: entry.job.runKind,
                  status: entry.job.status,
                  requestPath: entry.job.requestPath,
                  resultPath: entry.job.resultPath,
                })),
        };
      }
      if (
        !prepared.ok ||
        !prepared.data.newRecruit.delivery.authorized
      ) {
        return resultContent({
          ...prepared,
          data: {
            ...workflow,
            execution: {
              newRecruitDelivery: {
                status: "not-run",
                reason: prepared.data.newRecruit.delivery.authorized
                  ? "Roster preparation did not complete."
                  : "Delivery was not explicitly authorized by this request.",
              },
              tesseraBaseline: tesseraBaselineExecution,
            },
          },
        });
      }
      if (!options.newRecruitCompanion) {
        return resultContent({
          ok: false,
          data: {
            ...workflow,
            execution: {
              newRecruitDelivery: {
                status: "unavailable",
                reason:
                  "This transport has no local New Recruit companion. Use the included .rosz handoff for manual import.",
              },
            },
          },
          violations: [
            {
              code: "NEW_RECRUIT_COMPANION_UNAVAILABLE",
              message:
                "Direct delivery is unavailable on this transport; the validated .rosz handoff remains available for manual import.",
              severity: "error",
            },
          ],
          warnings: prepared.warnings,
        });
      }
      const connection =
        await options.newRecruitCompanion.status();
      if (
        !connection.ok ||
        !connection.data?.available
      ) {
        return resultContent({
          ok: false,
          data: {
            ...workflow,
            execution: {
              newRecruitDelivery: {
                status: "unavailable",
                connection: connection.data,
                reason:
                  connection.violations[0]?.message ??
                  connection.warnings[0]?.message ??
                  "The New Recruit companion is not ready.",
              },
            },
          },
          violations:
            connection.violations.length > 0
              ? connection.violations
              : [
                  {
                    code: "NEW_RECRUIT_CONNECTION_UNAVAILABLE",
                    message:
                      "Direct delivery was requested, but the New Recruit companion is not ready. The .rosz handoff remains available.",
                    severity: "error" as const,
                  },
                ],
          warnings: [
            ...prepared.warnings,
            ...connection.warnings,
          ],
        });
      }
      const delivered =
        await options.newRecruitCompanion.deliver(
          prepared.data.roster!,
          {
            downloadEnrichedRosz: true,
            downloadPrettyHtml,
            outputDirectory,
            overwrite,
          },
        );
      return resultContent({
        ok: delivered.ok,
        data: {
          ...workflow,
          status: delivered.ok ? "complete" : "failed",
          newRecruit: {
            ...workflow.newRecruit,
            delivery: {
              authorized: true,
              status: delivered.ok ? "delivered" : "failed",
            },
          },
          execution: {
            newRecruitDelivery: {
              status: delivered.ok ? "delivered" : "failed",
              connection: connection.data,
              result: delivered.data,
            },
          },
        },
        violations: delivered.violations,
        warnings: [
          ...prepared.warnings,
          ...connection.warnings,
          ...delivered.warnings,
        ],
      });
    },
  );

  if (options.tesseraOptimizerStore) {
    server.registerTool(
      "start_tessera_optimizer",
      {
        title: "Start a durable Tessera optimizer",
        description:
          "Freeze one completed, integrity-verified exact or faction-stress Tessera baseline into a durable optimizer state. Baseline suggestions remain unpaired until the candidate batch is explicitly approved and each revision is rerun against the frozen scenario contract.",
        inputSchema: {
          baselineReportPath: z.string().min(1),
          baselineRoster: RosterDraftSchema,
          mode: z
            .enum(["guided", "recommend-only"])
            .default("guided"),
          profilePolicyPath: z.string().min(1).optional(),
          outputDirectory: z
            .string()
            .min(1)
            .default("exports/tessera/optimizers"),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        baselineReportPath,
        baselineRoster,
        mode,
        profilePolicyPath,
        outputDirectory,
        responseDetail,
      }) =>
        tesseraOptimizerStoreContent(
          await options.tesseraOptimizerStore!.start({
            baselineReportPath,
            baselineRoster: baselineRoster as RosterDraftV1,
            mode: mode as TesseraOptimizerMode,
            profilePolicyPath,
            outputDirectory,
          }),
          responseDetail,
        ),
    );

    server.registerTool(
      "get_tessera_optimizer_status",
      {
        title: "Get durable Tessera optimizer status",
        description:
          "Verify the durable optimizer document, frozen artifacts, runtime identity, approvals, and current stage before taking another action.",
        inputSchema: {
          statePath: z.string().min(1),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ statePath, responseDetail }) =>
        tesseraOptimizerStoreContent(
          await options.tesseraOptimizerStore!.status(statePath),
          responseDetail,
        ),
    );

    server.registerTool(
      "approve_tessera_optimizer_candidates",
      {
        title: "Approve Tessera candidates for paired testing",
        description:
          "Approve one to three exact frozen baseline suggestions, materialize only locally legal/exportable revisions, and emit durable paired Tessera comparison requests. This does not approve a winner.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          candidateIds: z.array(z.string().min(1)).min(1).max(3),
          approvalId: z.string().min(1),
          approvedBy: z.string().min(1),
          approvedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        candidateIds,
        approvalId,
        approvedBy,
        approvedAt,
        responseDetail,
      }) =>
        tesseraOptimizerStoreContent(
          await options.tesseraOptimizerStore!.approveCandidates(
            statePath,
            {
              expectedStateRevision,
              candidateIds,
              approvalId,
              approvedBy,
              approvedAt,
            },
          ),
          responseDetail,
        ),
    );

    server.registerTool(
      "record_tessera_optimizer_comparison",
      {
        title: "Record a paired Tessera comparison",
        description:
          "Verify and freeze one completed paired revision report for an approved candidate. Once every candidate reaches a terminal result, the optimizer computes the deterministic Pareto frontier or retains the baseline.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          candidateId: z.string().min(1),
          reportPath: z.string().min(1),
          recordedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        candidateId,
        reportPath,
        recordedAt,
        responseDetail,
      }) =>
        tesseraOptimizerStoreContent(
          await options.tesseraOptimizerStore!.recordComparison(
            statePath,
            {
              expectedStateRevision,
              candidateId,
              reportPath,
              recordedAt,
            },
          ),
          responseDetail,
        ),
    );

    server.registerTool(
      "approve_tessera_optimizer_winner",
      {
        title: "Approve the exact Tessera optimizer winner",
        description:
          "Approve exactly one candidate on the current paired-tested Pareto frontier. This freezes a second approval receipt but still performs no New Recruit delivery.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          candidateId: z.string().min(1),
          approvalId: z.string().min(1),
          approvedBy: z.string().min(1),
          approvedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        candidateId,
        approvalId,
        approvedBy,
        approvedAt,
        responseDetail,
      }) =>
        tesseraOptimizerStoreContent(
          await options.tesseraOptimizerStore!.approveWinner(
            statePath,
            {
              expectedStateRevision,
              candidateId,
              approvalId,
              approvedBy,
              approvedAt,
            },
          ),
          responseDetail,
        ),
    );

    server.registerTool(
      "retain_tessera_optimizer_baseline",
      {
        title: "Approve retaining the Tessera baseline",
        description:
          "Explicitly choose the original baseline instead of a non-empty Pareto frontier. This is a separate approval and performs no New Recruit delivery.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          approvalId: z.string().min(1),
          approvedBy: z.string().min(1),
          approvedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        approvalId,
        approvedBy,
        approvedAt,
        responseDetail,
      }) =>
        tesseraOptimizerStoreContent(
          await options.tesseraOptimizerStore!.retainBaseline(
            statePath,
            {
              expectedStateRevision,
              approvalId,
              approvedBy,
              approvedAt,
            },
          ),
          responseDetail,
        ),
    );

    server.registerTool(
      "finalize_tessera_optimizer",
      {
        title: "Finalize a Tessera optimizer result",
        description:
          "Freeze the approved winner (or retain the baseline when no candidate qualifies) and record an explicit delivery intent. Recording intent does not itself mutate New Recruit.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          deliveryKind: z
            .enum(["none", "prepare-handoff", "deliver-new-recruit"])
            .default("none"),
          intentId: z.string().min(1).optional(),
          recordedBy: z.string().min(1).optional(),
          recordedAt: z.string().min(1).optional(),
          finalizedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        deliveryKind,
        intentId,
        recordedBy,
        recordedAt,
        finalizedAt,
        responseDetail,
      }) => {
        if (
          deliveryKind !== "none" &&
          (!intentId || !recordedBy)
        ) {
          return resultContent({
            ok: false,
            data: null,
            violations: [
              {
                code: "TESSERA_OPTIMIZER_DELIVERY_INTENT_REQUIRED",
                message:
                  "A non-empty delivery intent requires intentId and recordedBy.",
                severity: "error" as const,
              },
            ],
            warnings: [],
          });
        }
        const at = recordedAt ?? new Date().toISOString();
        const deliveryIntent: TesseraOptimizerDeliveryIntent =
          deliveryKind === "none"
            ? {
                kind: "none",
                intentId: null,
                recordedBy: null,
                recordedAt: at,
              }
            : {
                kind: deliveryKind,
                intentId: intentId!,
                recordedBy: recordedBy!,
                recordedAt: at,
              };
        return tesseraOptimizerStoreContent(
          await options.tesseraOptimizerStore!.finalize(
            statePath,
            {
              expectedStateRevision,
              deliveryIntent,
              finalizedAt,
            },
          ),
          responseDetail,
        );
      },
    );

    server.registerTool(
      "deliver_tessera_optimizer_winner_to_new_recruit",
      {
        title: "Deliver a finalized Tessera winner to New Recruit",
        description:
          "After two optimizer approvals and finalization with deliver-new-recruit intent, explicitly deliver that exact frozen winner through the local New Recruit companion.",
        inputSchema: {
          statePath: z.string().min(1),
          confirmDelivery: z.literal(true),
          outputDirectory: z
            .string()
            .min(1)
            .default("exports/new-recruit"),
          downloadPrettyHtml: z.boolean().default(true),
          overwrite: z.boolean().default(false),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        statePath,
        outputDirectory,
        downloadPrettyHtml,
        overwrite,
      }) => {
        const stored = await options.tesseraOptimizerStore!.status(
          statePath,
        );
        const finalization = stored.data?.state.finalization;
        if (
          !stored.ok ||
          stored.data?.state.stage !== "finalized" ||
          !finalization ||
          finalization.deliveryIntent.kind !==
            "deliver-new-recruit"
        ) {
          return resultContent({
            ok: false,
            data: stored.data
              ? compactTesseraOptimizerStoreResult(stored).data
              : null,
            violations:
              stored.violations.length > 0
                ? stored.violations
                : [
                    {
                      code:
                        "TESSERA_OPTIMIZER_DELIVERY_NOT_AUTHORIZED",
                      message:
                        "The optimizer must be finalized with an exact approved winner and deliver-new-recruit intent before delivery.",
                      severity: "error" as const,
                    },
                  ],
            warnings: stored.warnings,
          });
        }
        if (!options.newRecruitCompanion) {
          return resultContent({
            ok: false,
            data: {
              optimizerRunId: stored.data!.state.optimizerRunId,
              statePath,
              finalRosterArtifact:
                stored.data!.finalRosterArtifact,
              delivery: null,
            },
            violations: [
              {
                code: "NEW_RECRUIT_COMPANION_UNAVAILABLE",
                message:
                  "This transport cannot deliver to New Recruit. The exact finalized roster artifact remains available for manual handoff.",
                severity: "error" as const,
              },
            ],
            warnings: stored.warnings,
          });
        }
        const connection =
          await options.newRecruitCompanion.status();
        if (!connection.ok || !connection.data?.available) {
          return resultContent({
            ok: false,
            data: {
              optimizerRunId: stored.data!.state.optimizerRunId,
              statePath,
              finalRosterArtifact:
                stored.data!.finalRosterArtifact,
              connection: connection.data,
              delivery: null,
            },
            violations:
              connection.violations.length > 0
                ? connection.violations
                : [
                    {
                      code:
                        "NEW_RECRUIT_CONNECTION_UNAVAILABLE",
                      message:
                        "The finalized winner is approved, but the New Recruit companion is not ready.",
                      severity: "error" as const,
                    },
                  ],
            warnings: [
              ...stored.warnings,
              ...connection.warnings,
            ],
          });
        }
        const delivered =
          await options.newRecruitCompanion.deliver(
            finalization.roster,
            {
              downloadEnrichedRosz: true,
              downloadPrettyHtml,
              outputDirectory,
              overwrite,
            },
          );
        return resultContent({
          ok: delivered.ok,
          data: {
            optimizerRunId: stored.data!.state.optimizerRunId,
            statePath,
            candidateId: finalization.candidateId,
            finalizationSha256:
              finalization.finalizationSha256,
            finalRosterArtifact:
              stored.data!.finalRosterArtifact,
            connection: connection.data,
            delivery: delivered.data,
          },
          violations: delivered.violations,
          warnings: [
            ...stored.warnings,
            ...connection.warnings,
            ...delivered.warnings,
          ],
        });
      },
    );
  }

  if (options.tesseraGeneralOptimizerStore) {
    server.registerTool(
      "start_tessera_general_optimizer",
      {
        title: "Start a durable general-six Tessera optimizer",
        description:
          "Freeze one player roster, the six-archetype portfolio, and exactly six completed exact Tessera baselines into one aggregate optimizer. Suggestions remain unpaired until candidate approval and all six paired revisions complete.",
        inputSchema: {
          baselineRoster: RosterDraftSchema,
          portfolio: GeneralThreatPortfolioInputSchema.optional(),
          portfolioPath: z.string().min(1).optional(),
          baselines: z.array(z.object({
            archetypeId: GeneralThreatArchetypeSchema,
            reportPath: z.string().min(1),
            profilePolicyPath: z.string().min(1).optional(),
          })).length(6),
          mode: z
            .enum(["guided", "recommend-only"])
            .default("guided"),
          outputDirectory: z
            .string()
            .min(1)
            .default("exports/tessera/general-optimizers"),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        baselineRoster,
        portfolio,
        portfolioPath,
        baselines,
        mode,
        outputDirectory,
        responseDetail,
      }) => {
        if (!portfolio && !portfolioPath) {
          return resultContent({
            ok: false,
            data: null,
            violations: [
              {
                code: "TESSERA_GENERAL_OPTIMIZER_PORTFOLIO_REQUIRED",
                message:
                  "Starting a general-six optimizer requires the frozen portfolio object or its JSON path.",
                severity: "error" as const,
              },
            ],
            warnings: [],
          });
        }
        return tesseraGeneralOptimizerStoreContent(
          await options.tesseraGeneralOptimizerStore!.start({
            baselineRoster: baselineRoster as RosterDraftV1,
            portfolio: portfolio as GeneralThreatPortfolio | undefined,
            portfolioPath,
            baselines,
            mode: mode as TesseraOptimizerMode,
            outputDirectory,
          }),
          responseDetail,
        );
      },
    );

    server.registerTool(
      "get_tessera_general_optimizer_status",
      {
        title: "Get general-six Tessera optimizer status",
        description:
          "Verify the aggregate optimizer, six baseline artifacts, candidate/archetype receipts, runtime identity, approvals, and current stage.",
        inputSchema: {
          statePath: z.string().min(1),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ statePath, responseDetail }) =>
        tesseraGeneralOptimizerStoreContent(
          await options.tesseraGeneralOptimizerStore!.status(
            statePath,
          ),
          responseDetail,
        ),
    );

    server.registerTool(
      "approve_tessera_general_optimizer_candidates",
      {
        title: "Approve general-six candidates for paired testing",
        description:
          "Approve one to three aggregate candidates, materialize each legal/exportable roster once, and emit six request-SHA-bound paired revision requests per candidate. This does not approve a winner.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          candidateIds: z.array(z.string().min(1)).min(1).max(3),
          approvalId: z.string().min(1),
          approvedBy: z.string().min(1),
          approvedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        candidateIds,
        approvalId,
        approvedBy,
        approvedAt,
        responseDetail,
      }) =>
        tesseraGeneralOptimizerStoreContent(
          await options.tesseraGeneralOptimizerStore!
            .approveCandidates(statePath, {
              expectedStateRevision,
              candidateIds,
              approvalId,
              approvedBy,
              approvedAt,
            }),
          responseDetail,
        ),
    );

    server.registerTool(
      "record_tessera_general_optimizer_comparison",
      {
        title: "Record one general-six paired comparison",
        description:
          "Verify and freeze one completed candidate/archetype paired revision report. The request SHA prevents a result from being attached to another candidate, archetype, or baseline.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          candidateId: z.string().min(1),
          archetypeId: GeneralThreatArchetypeSchema,
          requestSha256: z.string().regex(/^[0-9a-f]{64}$/),
          reportPath: z.string().min(1),
          recordedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        candidateId,
        archetypeId,
        requestSha256,
        reportPath,
        recordedAt,
        responseDetail,
      }) =>
        tesseraGeneralOptimizerStoreContent(
          await options.tesseraGeneralOptimizerStore!
            .recordComparison(statePath, {
              expectedStateRevision,
              candidateId,
              archetypeId,
              requestSha256,
              reportPath,
              recordedAt,
            }),
          responseDetail,
        ),
    );

    server.registerTool(
      "approve_tessera_general_optimizer_winner",
      {
        title: "Approve the aggregate Tessera optimizer winner",
        description:
          "Approve exactly one no-regression candidate on the aggregate six-archetype Pareto frontier. This is the second approval and performs no New Recruit delivery.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          candidateId: z.string().min(1),
          approvalId: z.string().min(1),
          approvedBy: z.string().min(1),
          approvedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        candidateId,
        approvalId,
        approvedBy,
        approvedAt,
        responseDetail,
      }) =>
        tesseraGeneralOptimizerStoreContent(
          await options.tesseraGeneralOptimizerStore!.approveWinner(
            statePath,
            {
              expectedStateRevision,
              candidateId,
              approvalId,
              approvedBy,
              approvedAt,
            },
          ),
          responseDetail,
        ),
    );

    server.registerTool(
      "retain_tessera_general_optimizer_baseline",
      {
        title: "Approve retaining the general-six baseline",
        description:
          "Explicitly retain the original roster after the aggregate comparisons. This separate approval performs no New Recruit delivery.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          approvalId: z.string().min(1),
          approvedBy: z.string().min(1),
          approvedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        approvalId,
        approvedBy,
        approvedAt,
        responseDetail,
      }) =>
        tesseraGeneralOptimizerStoreContent(
          await options.tesseraGeneralOptimizerStore!.retainBaseline(
            statePath,
            {
              expectedStateRevision,
              approvalId,
              approvedBy,
              approvedAt,
            },
          ),
          responseDetail,
        ),
    );

    server.registerTool(
      "finalize_tessera_general_optimizer",
      {
        title: "Finalize a general-six Tessera optimizer result",
        description:
          "Freeze the separately approved aggregate winner or retained baseline and record delivery intent. Finalization alone does not mutate New Recruit.",
        inputSchema: {
          statePath: z.string().min(1),
          expectedStateRevision: z.number().int().nonnegative(),
          deliveryKind: z
            .enum(["none", "prepare-handoff", "deliver-new-recruit"])
            .default("none"),
          intentId: z.string().min(1).optional(),
          recordedBy: z.string().min(1).optional(),
          recordedAt: z.string().min(1).optional(),
          finalizedAt: z.string().min(1).optional(),
          responseDetail: z
            .enum(["compact", "full"])
            .default("compact"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({
        statePath,
        expectedStateRevision,
        deliveryKind,
        intentId,
        recordedBy,
        recordedAt,
        finalizedAt,
        responseDetail,
      }) => {
        if (
          deliveryKind !== "none" &&
          (!intentId || !recordedBy)
        ) {
          return resultContent({
            ok: false,
            data: null,
            violations: [
              {
                code:
                  "TESSERA_GENERAL_OPTIMIZER_DELIVERY_INTENT_REQUIRED",
                message:
                  "A non-empty delivery intent requires intentId and recordedBy.",
                severity: "error" as const,
              },
            ],
            warnings: [],
          });
        }
        const at = recordedAt ?? new Date().toISOString();
        const deliveryIntent: TesseraOptimizerDeliveryIntent =
          deliveryKind === "none"
            ? {
                kind: "none",
                intentId: null,
                recordedBy: null,
                recordedAt: at,
              }
            : {
                kind: deliveryKind,
                intentId: intentId!,
                recordedBy: recordedBy!,
                recordedAt: at,
              };
        return tesseraGeneralOptimizerStoreContent(
          await options.tesseraGeneralOptimizerStore!.finalize(
            statePath,
            {
              expectedStateRevision,
              deliveryIntent,
              finalizedAt,
            },
          ),
          responseDetail,
        );
      },
    );

    server.registerTool(
      "deliver_tessera_general_optimizer_winner_to_new_recruit",
      {
        title: "Deliver a finalized general-six winner to New Recruit",
        description:
          "After aggregate candidate and winner approvals plus finalization with deliver-new-recruit intent, explicitly deliver that exact frozen roster through the local companion.",
        inputSchema: {
          statePath: z.string().min(1),
          confirmDelivery: z.literal(true),
          outputDirectory: z
            .string()
            .min(1)
            .default("exports/new-recruit"),
          downloadPrettyHtml: z.boolean().default(true),
          overwrite: z.boolean().default(false),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        statePath,
        outputDirectory,
        downloadPrettyHtml,
        overwrite,
      }) => {
        const stored =
          await options.tesseraGeneralOptimizerStore!.status(
            statePath,
          );
        const finalization = stored.data?.state.finalization;
        if (
          !stored.ok ||
          stored.data?.state.stage !== "finalized" ||
          !finalization ||
          finalization.deliveryIntent.kind !==
            "deliver-new-recruit"
        ) {
          return resultContent({
            ok: false,
            data: stored.data
              ? compactTesseraGeneralOptimizerStoreResult(stored).data
              : null,
            violations:
              stored.violations.length > 0
                ? stored.violations
                : [
                    {
                      code:
                        "TESSERA_GENERAL_OPTIMIZER_DELIVERY_NOT_AUTHORIZED",
                      message:
                        "The general-six optimizer must be finalized with an approved result and deliver-new-recruit intent before delivery.",
                      severity: "error" as const,
                    },
                  ],
            warnings: stored.warnings,
          });
        }
        if (!options.newRecruitCompanion) {
          return resultContent({
            ok: false,
            data: {
              optimizerRunId: stored.data!.state.optimizerRunId,
              statePath,
              finalRosterArtifact:
                stored.data!.finalRosterArtifact,
              delivery: null,
            },
            violations: [
              {
                code: "NEW_RECRUIT_COMPANION_UNAVAILABLE",
                message:
                  "This transport cannot deliver to New Recruit. The aggregate optimizer's exact finalized roster remains available for manual handoff.",
                severity: "error" as const,
              },
            ],
            warnings: stored.warnings,
          });
        }
        const connection =
          await options.newRecruitCompanion.status();
        if (!connection.ok || !connection.data?.available) {
          return resultContent({
            ok: false,
            data: {
              optimizerRunId: stored.data!.state.optimizerRunId,
              statePath,
              finalRosterArtifact:
                stored.data!.finalRosterArtifact,
              connection: connection.data,
              delivery: null,
            },
            violations:
              connection.violations.length > 0
                ? connection.violations
                : [
                    {
                      code: "NEW_RECRUIT_CONNECTION_UNAVAILABLE",
                      message:
                        "The aggregate winner is approved, but the New Recruit companion is not ready.",
                      severity: "error" as const,
                    },
                  ],
            warnings: [
              ...stored.warnings,
              ...connection.warnings,
            ],
          });
        }
        const delivered =
          await options.newRecruitCompanion.deliver(
            finalization.roster,
            {
              downloadEnrichedRosz: true,
              downloadPrettyHtml,
              outputDirectory,
              overwrite,
            },
          );
        return resultContent({
          ok: delivered.ok,
          data: {
            optimizerRunId: stored.data!.state.optimizerRunId,
            statePath,
            candidateId: finalization.candidateId,
            finalizationSha256:
              finalization.finalizationSha256,
            finalRosterArtifact:
              stored.data!.finalRosterArtifact,
            connection: connection.data,
            delivery: delivered.data,
          },
          violations: delivered.violations,
          warnings: [
            ...stored.warnings,
            ...connection.warnings,
            ...delivered.warnings,
          ],
        });
      },
    );
  }

  server.registerTool(
    "build_roster",
    {
      title: "Build a deterministic roster",
      description:
        "Build any supported faction roster from natural language and/or structured constraints. Points and legality are calculated by the engine, never by the model.",
      inputSchema: {
        prompt: z.string().optional(),
        playerFaction: z.string().optional(),
        faction: z.string().optional(),
        pointsLimit: z.number().int().min(100).max(5000).optional(),
        name: z.string().optional(),
        preferences: z
          .array(
            z.enum([
              "mobility",
              "durability",
              "objective",
              "shooting",
              "melee",
              "elite",
              "horde",
            ]),
          )
          .optional(),
        allowNamedCharacters: z.boolean().optional(),
        legendsPolicy: LegendsPolicySchema.optional(),
        allowLegends: z.boolean().optional(),
        playContext: LegendsPlayContextSchema.optional(),
        collectionUnitIds: z.array(z.string()).optional(),
        requiredUnitIds: z.array(z.string()).optional(),
        excludedUnitIds: z.array(z.string()).optional(),
        requiredWarlordUnitId: z.string().optional(),
        opponentFaction: z.string().optional(),
        detachmentId: z.string().optional(),
        forceDispositionId: z.string().optional(),
      },
    },
    async (input) => {
      const result = buildRoster({
          ...input,
          preferences: input.preferences as PreferenceTag[] | undefined,
          opponentContext: input.opponentFaction
            ? {
                kind: "known-faction",
                factionId: input.opponentFaction,
              }
            : undefined,
      });
      return resultContent(result);
    },
  );

  server.registerTool(
    "modify_roster",
    {
      title: "Modify a roster",
      description:
        "Apply one explicit add, remove, replace, model-count, warlord, equipment, enhancement, detachment, or disposition operation and revalidate.",
      inputSchema: {
        roster: RosterDraftSchema,
        operation: ModifyRosterOperationSchema,
      },
    },
    async ({ roster, operation }) =>
      resultContent(
        modifyRoster(
          roster as RosterDraftV1,
          operation as ModifyRosterOperation,
        ),
      ),
  );

  server.registerTool(
    "modify_roster_batch",
    {
      title: "Modify a roster atomically",
      description:
        "Apply an ordered batch of roster operations to one working draft, then validate only the final roster. Structurally invalid operations still fail closed.",
      inputSchema: {
        roster: RosterDraftSchema,
        operations: z.array(ModifyRosterOperationSchema).min(1).max(32),
      },
    },
    async ({ roster, operations }) =>
      resultContent(
        modifyRosterBatch(
          roster as RosterDraftV1,
          operations as ModifyRosterOperation[],
        ),
      ),
  );

  server.registerTool(
    "validate_roster",
    {
      title: "Validate a roster",
      description:
        "Recalculate points and run loadout and army-construction legality checks under one immutable active-bundle lease.",
      inputSchema: { roster: RosterDraftSchema },
    },
    async ({ roster }) => resultContent(validateRoster(roster as RosterDraftV1)),
  );

  server.registerTool(
    "rebase_roster",
    {
      title: "Check or rebase roster data",
      description:
        "Compare a V1, V2, or V3 roster with the active semantic bundle. Provenance-only changes rebase automatically; relevant rule or mapping changes return exact review-required scopes without changing selections.",
      inputSchema: { roster: RosterDraftSchema },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ roster }) =>
      resultContent(
        await rebaseRosterWithProvider(
          roster,
          options.dataBundleProvider ?? null,
        ),
      ),
  );

  server.registerTool(
    "explain_roster",
    {
      title: "Explain a roster",
      description:
        "Explain how each selection supports the requested preferences and include every validation caution.",
      inputSchema: { roster: RosterDraftSchema },
    },
    async ({ roster }) => resultContent(explainRoster(roster as RosterDraftV1)),
  );

  server.registerTool(
    "export_roster",
    {
      title: "Export a roster",
      description:
        "Export a validated roster as New Recruit JSON, canonical roster JSON, text, or printable HTML. ROS/ROSZ is available when every selected New Recruit catalogue reference is mapped and conflict-free. Writing requires an explicit path and never overwrites by default.",
      inputSchema: {
        roster: RosterDraftSchema,
        format: z.enum([
          "ros",
          "rosz",
          "newrecruit-json",
          "roster-json",
          "text",
          "html",
        ]),
        outputPath: z.string().optional(),
        overwrite: z.boolean().default(false),
      },
    },
    async ({ roster, format, outputPath, overwrite }) => {
      const result = await exportRoster(
        roster as RosterDraftV1,
        format as ExportFormat,
      );
      if (!result.data || !outputPath) return inlineArtifact(result);
      if (!options.artifactWriter) {
        return resultContent({
          ok: false,
          data: null,
          violations: [
            {
              code: "FILE_WRITES_DISABLED",
              message:
                "This MCP transport does not permit filesystem writes; omit outputPath to receive inline content.",
              severity: "error",
            },
          ],
          warnings: result.warnings,
        });
      }
      try {
        const written = await options.artifactWriter(
          result.data,
          outputPath,
          overwrite,
        );
        return resultContent({
          ok: true,
          data: {
            format: result.data.format,
            filename: result.data.filename,
            mimeType: result.data.mimeType,
            written,
          },
          violations: [],
          warnings: result.warnings,
        });
      } catch (error) {
        return resultContent({
          ok: false,
          data: null,
          violations: [
            {
              code: "WRITE_FAILED",
              message: error instanceof Error ? error.message : "Write failed.",
              severity: "error",
            },
          ],
          warnings: result.warnings,
        });
      }
    },
  );

  server.registerTool(
    "prepare_new_recruit_handoff",
    {
      title: "Prepare a New Recruit handoff",
      description:
        "Validate a roster and prepare an editable .rosz plus optional printable HTML. Local stdio may write both files to a directory; remote transports return inline content.",
      inputSchema: {
        roster: RosterDraftSchema,
        includeHtml: z.boolean().default(true),
        outputDirectory: z.string().optional(),
        overwrite: z.boolean().default(false),
      },
    },
    async ({ roster, includeHtml, outputDirectory, overwrite }) => {
      const result = await prepareNewRecruitHandoff(
        roster as RosterDraftV1,
        includeHtml,
      );
      if (!result.data || !outputDirectory) return inlineHandoff(result);
      if (!options.handoffWriter) {
        return resultContent({
          ok: false,
          data: null,
          violations: [
            {
              code: "FILE_WRITES_DISABLED",
              message:
                "This MCP transport does not permit filesystem writes; omit outputDirectory to receive inline content.",
              severity: "error",
            },
          ],
          warnings: result.warnings,
        });
      }
      try {
        const written = await options.handoffWriter(
          result.data.artifacts,
          outputDirectory,
          overwrite,
        );
        return resultContent({
          ok: true,
          data: {
            rosterId: result.data.rosterId,
            rosterName: result.data.rosterName,
            totalPoints: result.data.totalPoints,
            pointsLimit: result.data.pointsLimit,
            importUrl: result.data.importUrl,
            instructions: result.data.instructions,
            artifacts: result.data.artifacts.map((artifact, index) => ({
              format: artifact.format,
              filename: artifact.filename,
              mimeType: artifact.mimeType,
              written: written[index],
            })),
          },
          violations: [],
          warnings: result.warnings,
        });
      } catch (error) {
        return resultContent({
          ok: false,
          data: null,
          violations: [
            {
              code: "WRITE_FAILED",
              message: error instanceof Error ? error.message : "Write failed.",
              severity: "error",
            },
          ],
          warnings: result.warnings,
        });
      }
    },
  );

  if (options.newRecruitCompanion) {
    server.registerTool(
      "get_new_recruit_connection_status",
      {
        title: "Get local New Recruit connection status",
        description:
          "Check whether the macOS-only New Recruit companion, dedicated Chrome profile, and login-Keychain credential are ready. Never returns credentials or browser storage.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => resultContent(await options.newRecruitCompanion!.status()),
    );

    server.registerTool(
      "deliver_roster_to_new_recruit",
      {
        title: "Deliver a roster to New Recruit",
        description:
          "After an explicit user request, validate a roster, import it into New Recruit as a new list, verify the result, and optionally download Pretty HTML. This is a non-idempotent external action.",
        inputSchema: {
          roster: RosterDraftSchema,
          downloadPrettyHtml: z.boolean().default(true),
          outputDirectory: z.string().default("exports/new-recruit"),
          overwrite: z.boolean().default(false),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        roster,
        downloadPrettyHtml,
        outputDirectory,
        overwrite,
      }) =>
        resultContent(
          await options.newRecruitCompanion!.deliver(
            roster as RosterDraftV1,
            {
              downloadEnrichedRosz: true,
              downloadPrettyHtml,
              outputDirectory,
              overwrite,
            },
          ),
        ),
    );
  }

  if (options.tesseraCompanion) {
    server.registerTool(
      "get_tessera_connection_status",
      {
        title: "Get local Tessera connection status",
        description:
          "Check the retained website adapter and pinned local-engine evaluation provider. Never returns premium keys, browser storage, or credentials.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => resultContent(await options.tesseraCompanion!.status()),
    );

    server.registerTool(
      "prepare_roster_for_tessera",
      {
        title: "Prepare a roster for Tessera",
        description:
          "After an explicit user request, import a validated roster into New Recruit, verify it, and download New Recruit's profile-rich .rosz for Tessera.",
        inputSchema: {
          roster: RosterDraftSchema,
          outputDirectory: z.string().default("exports/tessera"),
          overwrite: z.boolean().default(false),
          verifiedCatalogueDriftDiagnostic: z
            .boolean()
            .default(false),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        roster,
        outputDirectory,
        overwrite,
        verifiedCatalogueDriftDiagnostic,
      }) =>
        resultContent(
          await options.tesseraCompanion!.prepare(
            roster as RosterDraftV1,
            {
              outputDirectory,
              overwrite,
              catalogueDriftMode:
                verifiedCatalogueDriftDiagnostic
                  ? "diagnostic"
                  : "reject",
            },
          ),
        ),
    );

    const tesseraPhaseSchema = z.enum(["shooting", "fight"]);
    const tesseraSimulationBackendSchema = z.enum([
      "auto",
      "local-engine",
      "website",
    ]);
    const tesseraMetricSchema = z.enum([
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ]);
    server.registerTool(
      "analyze_roster_matchup",
      {
        title: "Prepare or analyze a roster matchup",
        description:
          "Prepare New Recruit-enriched player and opponent rosters and optionally run the selected Tessera website or local-engine provider. Results are directional combat math, not game win probability; candidate local evidence cannot drive coaching.",
        inputSchema: {
          playerRoster: RosterDraftSchema,
          opponent: z
            .union([
              z.object({
                kind: z.literal("roster"),
                roster: RosterDraftSchema,
              }),
              z.object({
                kind: z.literal("rosz"),
                path: z.string().min(1),
                rosterContext: RosterDraftSchema.optional(),
              }),
            ])
            .optional(),
          outputDirectory: z.string().default("exports/tessera"),
          overwrite: z.boolean().default(false),
          simulationBackend:
            tesseraSimulationBackendSchema.optional(),
          executionMode: z
            .enum(["prepare-only", "simulate"])
            .optional(),
          fallbackMode: z
            .enum(["none", "baseline-damage-v1"])
            .default("none"),
          profilePolicyPath: z.string().min(1).optional(),
          experimental: z.boolean().default(false),
          analysisMode: z.enum(["quick", "full"]).default("full"),
          phases: z.array(tesseraPhaseSchema).min(1).max(2).optional(),
          metrics: z.array(tesseraMetricSchema).min(1).max(4).optional(),
          allowPointMismatch: z.boolean().default(false),
          includeChangeCandidates: z.boolean().default(true),
          scenarioContract: TesseraScenarioContractSchema.optional(),
          verifiedCatalogueDriftDiagnostic: z
            .boolean()
            .default(false),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        playerRoster,
        opponent,
        outputDirectory,
        overwrite,
        simulationBackend,
        executionMode,
        fallbackMode,
        profilePolicyPath,
        experimental,
        analysisMode,
        phases,
        metrics,
        allowPointMismatch,
        includeChangeCandidates,
        scenarioContract,
        verifiedCatalogueDriftDiagnostic,
      }) => {
        if (!opponent) {
          return resultContent(opponentScopeRequired());
        }
        const normalizedPlayer = playerRoster as RosterDraftV1;
        const normalizedOpponent = opponent as
          | { kind: "roster"; roster: RosterDraftV1 }
          | {
              kind: "rosz";
              path: string;
              rosterContext?: RosterDraftV1;
            };
        const opponentRosterContext =
          normalizedOpponent.kind === "rosz"
            ? normalizedOpponent.rosterContext
            : undefined;
        const executionOpponent =
          normalizedOpponent.kind === "rosz"
            ? {
                kind: "rosz" as const,
                path: normalizedOpponent.path,
              }
            : normalizedOpponent;
        if (
          options.tesseraRunJobs &&
          shouldStartDurableTesseraRun(
            executionMode,
            experimental,
          )
        ) {
          const job = await options.tesseraRunJobs.start(
            {
              kind: "exact",
              playerRoster: normalizedPlayer,
              opponent: executionOpponent,
              options: {
                outputDirectory,
                overwrite,
                simulationBackend,
                executionMode: "simulate",
                fallbackMode,
                profilePolicyPath,
                experimental: false,
                analysisMode,
                phases,
                metrics,
                allowPointMismatch,
                ...(scenarioContract
                  ? { scenarioContract }
                  : {}),
                catalogueDriftMode:
                  verifiedCatalogueDriftDiagnostic
                    ? "diagnostic"
                    : "reject",
                includeChangeCandidates,
                opponentRosterContext,
              },
            },
            { outputDirectory },
          );
          return inProgressJobContent(job);
        }
        return resultContent(
          await options.tesseraCompanion!.analyze(
            normalizedPlayer,
            executionOpponent,
            {
              outputDirectory,
              overwrite,
              simulationBackend,
              executionMode,
              fallbackMode,
              profilePolicyPath,
              experimental,
              analysisMode,
              phases,
              metrics,
              allowPointMismatch,
              includeChangeCandidates,
              ...(scenarioContract
                ? { scenarioContract }
                : {}),
              catalogueDriftMode:
                verifiedCatalogueDriftDiagnostic
                  ? "diagnostic"
                  : "reject",
              ...(opponentRosterContext
                ? { opponentRosterContext }
                : {}),
            },
          ),
        );
      },
    );

    if (options.tesseraCompanion.buildAndAnalyze) {
      server.registerTool(
        "build_and_analyze_roster_matchup",
        {
          title: "Build and analyze against an exact roster",
          description:
            "Build and deterministically repair a player roster against the supplied validated opponent roster, enforce readiness, then run the exact Tessera workflow. It never applies suggested changes.",
          inputSchema: {
            prompt: z.string().min(1),
            playerFaction: z.string().min(1).optional(),
            pointsLimit: z.number().int().min(100).max(5000).optional(),
            opponentRoster: RosterDraftSchema,
            legendsPolicy: LegendsPolicySchema.optional(),
            allowLegends: z.boolean().optional(),
            playContext: LegendsPlayContextSchema.optional(),
            collectionProfile: CollectionProfileSchema.optional(),
            requiredUnitIds: z.array(z.string().min(1)).optional(),
            excludedUnitIds: z.array(z.string().min(1)).optional(),
            requiredWarlordUnitId: z.string().min(1).optional(),
            allowReadinessWarnings: z.boolean().default(false),
            profilePolicyPath: z.string().min(1).optional(),
            outputDirectory: z.string().min(1).optional(),
            simulationBackend:
              tesseraSimulationBackendSchema.optional(),
            executionMode: z
              .enum(["prepare-only", "simulate"])
              .optional(),
            responseDetail: z
              .enum(["compact", "full"])
              .default("compact"),
            overwrite: z.boolean().default(false),
            experimental: z.boolean().default(false),
            verifiedCatalogueDriftDiagnostic: z
              .boolean()
              .default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          prompt,
          playerFaction,
          pointsLimit,
          opponentRoster,
          legendsPolicy,
          allowLegends,
          playContext,
          collectionProfile,
          requiredUnitIds,
          excludedUnitIds,
          requiredWarlordUnitId,
          allowReadinessWarnings,
          profilePolicyPath,
          outputDirectory,
          simulationBackend,
          executionMode,
          responseDetail,
          overwrite,
          experimental,
          verifiedCatalogueDriftDiagnostic,
        }) => {
          if (
            options.tesseraRunJobs &&
            shouldStartDurableTesseraRun(
              executionMode,
              experimental,
            )
          ) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "build-and-analyze",
                input: {
                  prompt,
                  playerFaction,
                  pointsLimit,
                  opponentRoster:
                    opponentRoster as RosterDraftV1,
                  legendsPolicy,
                  allowLegends,
                  playContext,
                  collectionProfile,
                  requiredUnitIds,
                  excludedUnitIds,
                  requiredWarlordUnitId,
                  allowReadinessWarnings,
                  profilePolicyPath,
                  outputDirectory,
                  simulationBackend,
                  executionMode: "simulate",
                  experimental: false,
                },
                options: {
                  outputDirectory,
                  overwrite,
                  simulationBackend,
                  executionMode: "simulate",
                  experimental: false,
                  catalogueDriftMode:
                    requestedCatalogueDriftMode(
                      verifiedCatalogueDriftDiagnostic,
                    ),
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          const result =
            await options.tesseraCompanion!.buildAndAnalyze!(
              {
                prompt,
                playerFaction,
                pointsLimit,
                opponentRoster: opponentRoster as RosterDraftV1,
                legendsPolicy,
                allowLegends,
                playContext,
                collectionProfile,
                requiredUnitIds,
                excludedUnitIds,
                requiredWarlordUnitId,
                allowReadinessWarnings,
                profilePolicyPath,
                outputDirectory,
                simulationBackend,
                executionMode,
                experimental,
              },
              {
                outputDirectory,
                overwrite,
                simulationBackend,
                catalogueDriftMode:
                  requestedCatalogueDriftMode(
                    verifiedCatalogueDriftDiagnostic,
                  ),
              },
            );
          return detailedResultContent(
            result,
            responseDetail,
            compactBuildAndAnalyzeResult,
          );
        },
      );
    }

    if (options.tesseraCompanion.compare) {
      server.registerTool(
        "compare_roster_revision",
        {
          title: "Compare an approved roster revision",
          description:
            "After explicit user approval, validate a revised roster, reuse the baseline opponent and Tessera settings, and produce a directional before-and-after comparison. This is not a game win probability.",
          inputSchema: {
            baselineReportPath: z.string().min(1),
            revisedRoster: RosterDraftSchema,
            outputDirectory: z.string().default("exports/tessera"),
            overwrite: z.boolean().default(false),
            profilePolicyPath: z.string().min(1).optional(),
            executionMode: z
              .enum(["simulate"])
              .optional(),
            experimental: z.boolean().default(false),
            verifiedCatalogueDriftDiagnostic: z
              .boolean()
              .default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          baselineReportPath,
          revisedRoster,
          outputDirectory,
          overwrite,
          profilePolicyPath,
          executionMode,
          experimental,
          verifiedCatalogueDriftDiagnostic,
        }) => {
          if (options.tesseraRunJobs) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "exact-revision",
                baselineReportPath,
                revisedRoster:
                  revisedRoster as RosterDraftV1,
                options: {
                  outputDirectory,
                  profilePolicyPath,
                  executionMode: "simulate",
                  experimental: false,
                  catalogueDriftMode:
                    requestedCatalogueDriftMode(
                      verifiedCatalogueDriftDiagnostic,
                    ),
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          return resultContent(
            await options.tesseraCompanion!.compare!(
              baselineReportPath,
              revisedRoster as RosterDraftV1,
              {
                outputDirectory,
                overwrite,
                ...(profilePolicyPath
                  ? { profilePolicyPath }
                  : {}),
                ...(executionMode
                  ? { executionMode }
                  : {}),
                experimental,
                catalogueDriftMode:
                  requestedCatalogueDriftMode(
                    verifiedCatalogueDriftDiagnostic,
                  ),
              },
            ),
          );
        },
      );
    }

    if (options.tesseraCompanion.previewPortfolio) {
      server.registerTool(
        "preview_faction_stress_portfolio",
        {
          title: "Preview a known-faction unknown-list portfolio",
          description:
            "Build and validate a local-only opponent portfolio preview with simulation fingerprints, pairwise diversity, composition evidence, profile requirements, named-character coverage, and New Recruit exportability. This performs no external mutation.",
          inputSchema: {
            factionId: z.string().min(1),
            pointsLimit: z.number().int().min(100).max(5000).default(1000),
            suite: z.enum(["core-3", "diverse-9"]).optional(),
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ factionId, pointsLimit, suite }) =>
          resultContent(
            await options.tesseraCompanion!.previewPortfolio!({
              faction: factionId,
              pointsLimit,
              suite,
              pointsTolerancePercent: 5,
              allowLegends: false,
            }),
          ),
      );
    }

    if (options.tesseraCompanion.buildAndStress) {
      server.registerTool(
        "build_and_stress_roster_against_faction",
        {
          title: "Build and stress-test against a known faction's unknown list",
          description:
            "Build and deterministically repair a roster, enforce mission-readiness and portfolio gates, prepare verified artifacts, then run the staged Tessera stress workflow. It never applies post-simulation roster changes.",
          inputSchema: {
            prompt: z.string().min(1),
            playerFaction: z.string().min(1).optional(),
            againstFaction: z.string().min(1),
            pointsLimit: z.number().int().min(100).max(5000).optional(),
            legendsPolicy: LegendsPolicySchema.optional(),
            allowLegends: z.boolean().optional(),
            playContext: LegendsPlayContextSchema.optional(),
            requiredUnitIds: z.array(z.string().min(1)).optional(),
            excludedUnitIds: z.array(z.string().min(1)).optional(),
            requiredWarlordUnitId: z.string().min(1).optional(),
            suite: z.enum(["core-3", "diverse-9"]).optional(),
            analysisStrategy: z
              .enum(["staged", "full-all"])
              .optional(),
            profilePolicyPath: z.string().min(1).optional(),
            resumeManifestPath: z.string().min(1).optional(),
            restartManifestPath: z.string().min(1).optional(),
            outputDirectory: z.string().min(1).optional(),
            responseDetail: z
              .enum(["compact", "full"])
              .default("compact"),
            allowReadinessWarnings: z.boolean().default(false),
            forceRetry: z.boolean().default(false),
            simulationBackend:
              tesseraSimulationBackendSchema.optional(),
            executionMode: z
              .enum(["prepare-only", "simulate"])
              .optional(),
            overwrite: z.boolean().default(false),
            experimental: z.boolean().default(false),
            verifiedCatalogueDriftDiagnostic: z
              .boolean()
              .default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          prompt,
          playerFaction,
          againstFaction,
          pointsLimit,
          legendsPolicy,
          allowLegends,
          playContext,
          requiredUnitIds,
          excludedUnitIds,
          requiredWarlordUnitId,
          suite,
          analysisStrategy,
          profilePolicyPath,
          resumeManifestPath,
          restartManifestPath,
          outputDirectory,
          responseDetail,
          allowReadinessWarnings,
          forceRetry,
          simulationBackend,
          executionMode,
          overwrite,
          experimental,
          verifiedCatalogueDriftDiagnostic,
        }) => {
          if (
            options.tesseraRunJobs &&
            shouldStartDurableTesseraRun(
              executionMode,
              experimental,
              Boolean(
                resumeManifestPath ||
                restartManifestPath,
              ),
            )
          ) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "build-and-stress",
                input: {
                  prompt,
                  playerFaction,
                  againstFaction,
                  pointsLimit,
                  legendsPolicy,
                  allowLegends,
                  playContext,
                  requiredUnitIds,
                  excludedUnitIds,
                  requiredWarlordUnitId,
                  suite,
                  analysisStrategy,
                  profilePolicyPath,
                  resumeManifestPath,
                  restartManifestPath,
                  outputDirectory,
                  allowReadinessWarnings,
                  forceRetry,
                  simulationBackend,
                  executionMode: "simulate",
                  experimental: false,
                },
                options: {
                  outputDirectory,
                  overwrite,
                  simulationBackend,
                  executionMode: "simulate",
                  experimental: false,
                  catalogueDriftMode:
                    requestedCatalogueDriftMode(
                      verifiedCatalogueDriftDiagnostic,
                      Boolean(
                        resumeManifestPath ||
                        restartManifestPath,
                      ),
                    ),
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          const result =
            await options.tesseraCompanion!.buildAndStress!(
              {
                prompt,
                playerFaction,
                againstFaction,
                pointsLimit,
                legendsPolicy,
                allowLegends,
                playContext,
                requiredUnitIds,
                excludedUnitIds,
                requiredWarlordUnitId,
                suite,
                analysisStrategy,
                profilePolicyPath,
                resumeManifestPath,
                restartManifestPath,
                outputDirectory,
                allowReadinessWarnings,
                forceRetry,
                simulationBackend,
                executionMode,
                experimental,
              },
              {
                outputDirectory,
                overwrite,
                simulationBackend,
                catalogueDriftMode:
                  requestedCatalogueDriftMode(
                    verifiedCatalogueDriftDiagnostic,
                    Boolean(
                      resumeManifestPath ||
                      restartManifestPath,
                    ),
                  ),
              },
            );
          return detailedResultContent(
            result,
            responseDetail,
            (value) =>
              compactBuildAndStressResult(
                value,
                outputDirectory,
              ),
          );
        },
      );
    }

    if (options.tesseraCompanion.stressTest) {
      server.registerTool(
        "stress_test_roster_against_faction",
        {
          title: "Stress-test a roster against an opponent faction",
          description:
            "After an explicit user request, generate a deterministic faction portfolio, prepare it through New Recruit, and measure the roster's directional combat robustness in Tessera. This is not a game win probability.",
          inputSchema: {
            playerRoster: RosterDraftSchema,
            factionId: z.string().min(1),
            suite: z.enum(["core-3", "diverse-9"]).optional(),
            analysisStrategy: z
              .enum(["staged", "full-all"])
              .optional(),
            resumeManifestPath: z.string().min(1).optional(),
            restartManifestPath: z.string().min(1).optional(),
            profilePolicyPath: z.string().min(1).optional(),
            forceRetry: z.boolean().default(false),
            simulationBackend:
              tesseraSimulationBackendSchema.optional(),
            executionMode: z
              .enum(["prepare-only", "simulate"])
              .optional(),
            outputDirectory: z.string().min(1).optional(),
            responseDetail: z
              .enum(["compact", "full"])
              .default("compact"),
            overwrite: z.boolean().default(false),
            experimental: z.boolean().default(false),
            verifiedCatalogueDriftDiagnostic: z
              .boolean()
              .default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          playerRoster,
          factionId,
          suite,
          analysisStrategy,
          resumeManifestPath,
          restartManifestPath,
          profilePolicyPath,
          forceRetry,
          simulationBackend,
          executionMode,
          outputDirectory,
          responseDetail,
          overwrite,
          experimental,
          verifiedCatalogueDriftDiagnostic,
        }) => {
          if (
            options.tesseraRunJobs &&
            shouldStartDurableTesseraRun(
              executionMode,
              experimental,
              Boolean(
                resumeManifestPath ||
                restartManifestPath,
              ),
            )
          ) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "stress",
                playerRoster:
                  playerRoster as RosterDraftV1,
                factionId,
                options: {
                  suite,
                  analysisStrategy,
                  resumeManifestPath,
                  restartManifestPath,
                  profilePolicyPath,
                  forceRetry,
                  simulationBackend,
                  executionMode: "simulate",
                  outputDirectory,
                  overwrite,
                  experimental: false,
                  catalogueDriftMode:
                    requestedCatalogueDriftMode(
                      verifiedCatalogueDriftDiagnostic,
                      Boolean(
                        resumeManifestPath ||
                        restartManifestPath,
                      ),
                    ),
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          const result =
            await options.tesseraCompanion!.stressTest!(
              playerRoster as RosterDraftV1,
              { kind: "faction", factionId },
              {
                suite,
                analysisStrategy,
                resumeManifestPath,
                restartManifestPath,
                profilePolicyPath,
                forceRetry,
                simulationBackend,
                executionMode,
                outputDirectory,
                overwrite,
                experimental,
                catalogueDriftMode:
                  requestedCatalogueDriftMode(
                    verifiedCatalogueDriftDiagnostic,
                    Boolean(
                      resumeManifestPath ||
                      restartManifestPath,
                    ),
                  ),
              },
            );
          return detailedResultContent(
            result,
            responseDetail,
            (value) =>
              compactStressResult(value, outputDirectory),
          );
        },
      );
    }

    if (options.tesseraCompanion.compareStressRevision) {
      server.registerTool(
        "compare_stress_test_revision",
        {
          title: "Compare a roster revision against a stress-test portfolio",
          description:
            "After explicit user approval, validate a revised roster and compare it against the exact frozen opponents and settings from a baseline faction stress test. This is not a game win probability.",
          inputSchema: {
            baselineReportPath: z.string().min(1),
            revisedRoster: RosterDraftSchema,
            outputDirectory: z.string().min(1).optional(),
            responseDetail: z
              .enum(["compact", "full"])
              .default("compact"),
            overwrite: z.boolean().default(false),
            executionMode: z
              .enum(["simulate"])
              .optional(),
            experimental: z.boolean().default(false),
            verifiedCatalogueDriftDiagnostic: z
              .boolean()
              .default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          baselineReportPath,
          revisedRoster,
          outputDirectory,
          responseDetail,
          overwrite,
          executionMode,
          experimental,
          verifiedCatalogueDriftDiagnostic,
        }) => {
          if (options.tesseraRunJobs) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "stress-revision",
                baselineReportPath,
                revisedRoster:
                  revisedRoster as RosterDraftV1,
                options: {
                  outputDirectory,
                  executionMode: "simulate",
                  experimental: false,
                  catalogueDriftMode:
                    requestedCatalogueDriftMode(
                      verifiedCatalogueDriftDiagnostic,
                      true,
                    ),
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          const result =
            await options.tesseraCompanion!.compareStressRevision!(
              baselineReportPath,
              revisedRoster as RosterDraftV1,
              {
                outputDirectory,
                overwrite,
                ...(executionMode
                  ? { executionMode }
                  : {}),
                experimental,
                catalogueDriftMode:
                  requestedCatalogueDriftMode(
                    verifiedCatalogueDriftDiagnostic,
                    true,
                  ),
              },
            );
          return detailedResultContent(
            result,
            responseDetail,
            (value) =>
              compactStressRevisionResult(
                value,
                outputDirectory,
              ),
          );
        },
      );
    }

    if (options.tesseraCompanion.compareProviders) {
      server.registerTool(
        "compare_tessera_providers",
        {
          title: "Compare local and website Tessera providers",
          description:
            "Verify and compare one completed local-engine report and one completed Tessera website report produced from the same frozen exact matchup. Writes canonical JSON, printable HTML, and a detached checksum; incomplete or mismatched evidence fails closed.",
          inputSchema: {
            localReportPath: z.string().min(1),
            websiteReportPath: z.string().min(1),
            outputDirectory: z
              .string()
              .default("exports/tessera/parity"),
            overwrite: z.boolean().default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async ({
          localReportPath,
          websiteReportPath,
          outputDirectory,
          overwrite,
        }) =>
          resultContent(
            await options.tesseraCompanion!.compareProviders!({
              localReportPath,
              websiteReportPath,
              outputDirectory,
              overwrite,
            }),
          ),
      );
    }

    server.registerTool(
      "rebind_tessera_scenario_contract_provider",
      {
        title: "Rebind a Tessera scenario contract",
        description:
          "Convert a provider-observed frozen scenario contract for replay by the other Tessera provider. Only reviewed provider-neutral gameplay settings are retained; unknown settings and source-provider conflicts fail closed.",
        inputSchema: {
          scenarioContract: TesseraScenarioContractSchema,
          sourceProvider: z.enum(["local-engine", "website"]),
          targetProvider: z.enum(["local-engine", "website"]),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({
        scenarioContract,
        sourceProvider,
        targetProvider,
      }) => {
        const rebound = rebindTesseraScenarioContractProvider(
          scenarioContract,
          sourceProvider,
          targetProvider,
        );
        return valueContent({
          schemaVersion: 1,
          sourceProvider,
          targetProvider,
          scenarioContract: rebound,
          scenarioContractSha256:
            tesseraScenarioContractSha256(rebound),
        });
      },
    );
  }

  if (options.tesseraRunJobs) {
    const jobSimulationBackendSchema = z.enum([
      "auto",
      "local-engine",
      "website",
    ]);
    const jobProfilePolicySchema = z.object({
      schemaVersion: z.literal(1),
      policyKind: z.literal("tessera-profile-policy"),
      entries: z.array(
        z.object({
          faction: z.string().min(1),
          unit: z.string().min(1),
          unitOccurrence: z.number().int().positive().optional(),
          modelCount: z.number().int().positive().optional(),
          weaponGroup: z.string().min(1),
          phase: z.enum(["shooting", "fight"]),
          selectedProfile: z.string().min(1),
          activeCount: z.number().int().positive(),
        }),
      ),
    });
    const jobExecutionModeSchema = z
      .enum(["prepare-only", "simulate"])
      .optional();
    const jobRequestSchema = z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("exact"),
        playerRoster: RosterDraftSchema,
        opponent: z
          .union([
            z.object({
              kind: z.literal("roster"),
              roster: RosterDraftSchema,
            }),
            z.object({
              kind: z.literal("rosz"),
              path: z.string().min(1),
              rosterContext: RosterDraftSchema.optional(),
            }),
          ])
          .optional(),
        executionMode: jobExecutionModeSchema,
        simulationBackend:
          jobSimulationBackendSchema.optional(),
        profilePolicyPath: z.string().min(1).optional(),
        analysisMode: z.enum(["quick", "full"]).default("full"),
        allowPointMismatch: z.boolean().default(false),
        scenarioContract: TesseraScenarioContractSchema.optional(),
        verifiedCatalogueDriftDiagnostic: z
          .boolean()
          .default(false),
      }),
      z.object({
        kind: z.literal("stress"),
        playerRoster: RosterDraftSchema,
        factionId: z.string().min(1),
        suite: z.enum(["core-3", "diverse-9"]).optional(),
        analysisStrategy: z
          .enum(["staged", "full-all"])
          .optional(),
        portfolioPreview: z.unknown().optional(),
        executionMode: jobExecutionModeSchema,
        simulationBackend:
          jobSimulationBackendSchema.optional(),
        profilePolicyPath: z.string().min(1).optional(),
        resumeManifestPath: z.string().min(1).optional(),
        restartManifestPath: z.string().min(1).optional(),
        scenarioContract: TesseraScenarioContractSchema.optional(),
        verifiedCatalogueDriftDiagnostic: z
          .boolean()
          .default(false),
      }),
      z.object({
        kind: z.literal("build-and-stress"),
        prompt: z.string().min(1),
        playerFaction: z.string().min(1).optional(),
        againstFaction: z.string().min(1),
        pointsLimit: z.number().int().min(100).max(5000).optional(),
        legendsPolicy: LegendsPolicySchema.optional(),
        allowLegends: z.boolean().optional(),
        playContext: LegendsPlayContextSchema.optional(),
        requiredUnitIds: z.array(z.string().min(1)).optional(),
        excludedUnitIds: z.array(z.string().min(1)).optional(),
        requiredWarlordUnitId: z.string().min(1).optional(),
        suite: z.enum(["core-3", "diverse-9"]).optional(),
        analysisStrategy: z
          .enum(["staged", "full-all"])
          .optional(),
        executionMode: jobExecutionModeSchema,
        simulationBackend:
          jobSimulationBackendSchema.optional(),
        profilePolicyPath: z.string().min(1).optional(),
        allowReadinessWarnings: z.boolean().default(false),
        resumeManifestPath: z.string().min(1).optional(),
        restartManifestPath: z.string().min(1).optional(),
        scenarioContract: TesseraScenarioContractSchema.optional(),
        verifiedCatalogueDriftDiagnostic: z
          .boolean()
          .default(false),
      }),
      z.object({
        kind: z.literal("build-and-analyze"),
        prompt: z.string().min(1),
        playerFaction: z.string().min(1).optional(),
        pointsLimit: z.number().int().min(100).max(5000).optional(),
        opponentRoster: RosterDraftSchema,
        legendsPolicy: LegendsPolicySchema.optional(),
        allowLegends: z.boolean().optional(),
        playContext: LegendsPlayContextSchema.optional(),
        collectionProfile: CollectionProfileSchema.optional(),
        requiredUnitIds: z.array(z.string().min(1)).optional(),
        excludedUnitIds: z.array(z.string().min(1)).optional(),
        requiredWarlordUnitId: z.string().min(1).optional(),
        executionMode: jobExecutionModeSchema,
        simulationBackend:
          jobSimulationBackendSchema.optional(),
        profilePolicyPath: z.string().min(1).optional(),
        allowReadinessWarnings: z.boolean().default(false),
        scenarioContract: TesseraScenarioContractSchema.optional(),
        verifiedCatalogueDriftDiagnostic: z
          .boolean()
          .default(false),
      }),
      z.object({
        kind: z.literal("exact-revision"),
        baselineReportPath: z.string().min(1),
        revisedRoster: RosterDraftSchema,
        profilePolicyPath: z.string().min(1).optional(),
        verifiedCatalogueDriftDiagnostic: z
          .boolean()
          .default(false),
      }),
      z.object({
        kind: z.literal("stress-revision"),
        baselineReportPath: z.string().min(1),
        revisedRoster: RosterDraftSchema,
        verifiedCatalogueDriftDiagnostic: z
          .boolean()
          .default(false),
      }),
    ]);

    server.registerTool(
      "start_tessera_run",
      {
        title: "Start a durable Tessera run",
        description:
          "Reserve a run bundle and start exact, stress, or build-and-analyze work in a background worker. Returns immediately with a durable job path.",
        inputSchema: {
          request: jobRequestSchema,
          outputDirectory: z.string().min(1).optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ request, outputDirectory }) => {
        let normalized: TesseraRunRequest;
        if (request.kind === "exact") {
          if (!request.opponent) {
            return resultContent(opponentScopeRequired());
          }
          normalized = {
            kind: "exact",
            playerRoster: request.playerRoster as RosterDraftV1,
            opponent:
              request.opponent.kind === "roster"
                ? {
                    kind: "roster",
                    roster:
                      request.opponent.roster as RosterDraftV1,
                  }
                : request.opponent,
            options: {
              executionMode: request.executionMode,
              simulationBackend: request.simulationBackend,
              profilePolicyPath: request.profilePolicyPath,
              analysisMode: request.analysisMode,
              allowPointMismatch: request.allowPointMismatch,
              ...(request.scenarioContract
                ? { scenarioContract: request.scenarioContract }
                : {}),
              catalogueDriftMode:
                request.verifiedCatalogueDriftDiagnostic
                  ? "diagnostic"
                  : "reject",
              opponentRosterContext:
                request.opponent.kind === "rosz"
                  ? (
                      request.opponent
                        .rosterContext as RosterDraftV1 | undefined
                    )
                  : undefined,
            },
          };
        } else if (request.kind === "stress") {
          normalized = {
            kind: "stress",
            playerRoster: request.playerRoster as RosterDraftV1,
            factionId: request.factionId,
            options: {
              suite: request.suite,
              analysisStrategy: request.analysisStrategy,
              portfolioPreview:
                request.portfolioPreview as
                  | TesseraStressPortfolioPreview
                  | undefined,
              executionMode: request.executionMode,
              simulationBackend: request.simulationBackend,
              profilePolicyPath: request.profilePolicyPath,
              resumeManifestPath: request.resumeManifestPath,
              restartManifestPath:
                request.restartManifestPath,
              ...(request.scenarioContract
                ? { scenarioContract: request.scenarioContract }
                : {}),
              catalogueDriftMode:
                requestedCatalogueDriftMode(
                  request.verifiedCatalogueDriftDiagnostic,
                  Boolean(
                    request.resumeManifestPath ||
                    request.restartManifestPath,
                  ),
                ),
            },
          };
        } else if (request.kind === "build-and-stress") {
          normalized = {
            kind: "build-and-stress",
            input: {
              prompt: request.prompt,
              playerFaction: request.playerFaction,
              againstFaction: request.againstFaction,
              pointsLimit: request.pointsLimit,
              legendsPolicy: request.legendsPolicy,
              allowLegends: request.allowLegends,
              playContext: request.playContext,
              requiredUnitIds: request.requiredUnitIds,
              excludedUnitIds: request.excludedUnitIds,
              requiredWarlordUnitId:
                request.requiredWarlordUnitId,
              suite: request.suite,
              analysisStrategy: request.analysisStrategy,
              simulationBackend: request.simulationBackend,
              executionMode: request.executionMode,
              profilePolicyPath: request.profilePolicyPath,
              allowReadinessWarnings:
                request.allowReadinessWarnings,
              resumeManifestPath: request.resumeManifestPath,
              restartManifestPath:
                request.restartManifestPath,
            },
            options: {
              simulationBackend: request.simulationBackend,
              ...(request.scenarioContract
                ? { scenarioContract: request.scenarioContract }
                : {}),
              catalogueDriftMode:
                requestedCatalogueDriftMode(
                  request.verifiedCatalogueDriftDiagnostic,
                  Boolean(
                    request.resumeManifestPath ||
                    request.restartManifestPath,
                  ),
                ),
            },
          };
        } else if (request.kind === "build-and-analyze") {
          normalized = {
            kind: "build-and-analyze",
            input: {
              prompt: request.prompt,
              playerFaction: request.playerFaction,
              pointsLimit: request.pointsLimit,
              opponentRoster:
                request.opponentRoster as RosterDraftV1,
              legendsPolicy: request.legendsPolicy,
              allowLegends: request.allowLegends,
              playContext: request.playContext,
              collectionProfile: request.collectionProfile,
              requiredUnitIds: request.requiredUnitIds,
              excludedUnitIds: request.excludedUnitIds,
              requiredWarlordUnitId:
                request.requiredWarlordUnitId,
              executionMode: request.executionMode,
              simulationBackend: request.simulationBackend,
              profilePolicyPath: request.profilePolicyPath,
              allowReadinessWarnings:
                request.allowReadinessWarnings,
            },
            options: {
              simulationBackend: request.simulationBackend,
              ...(request.scenarioContract
                ? { scenarioContract: request.scenarioContract }
                : {}),
              catalogueDriftMode:
                request.verifiedCatalogueDriftDiagnostic
                  ? "diagnostic"
                  : "reject",
            },
          };
        } else if (request.kind === "exact-revision") {
          normalized = {
            kind: "exact-revision",
            baselineReportPath: request.baselineReportPath,
            revisedRoster:
              request.revisedRoster as RosterDraftV1,
            options: {
              executionMode: "simulate",
              experimental: false,
              profilePolicyPath: request.profilePolicyPath,
              catalogueDriftMode:
                request.verifiedCatalogueDriftDiagnostic
                  ? "diagnostic"
                  : "reject",
            },
          };
        } else {
          normalized = {
            kind: "stress-revision",
            baselineReportPath: request.baselineReportPath,
            revisedRoster:
              request.revisedRoster as RosterDraftV1,
            options: {
              executionMode: "simulate",
              experimental: false,
              catalogueDriftMode:
                requestedCatalogueDriftMode(
                  request.verifiedCatalogueDriftDiagnostic,
                  true,
                ),
            },
          };
        }
        return valueContent(
          await options.tesseraRunJobs!.start(normalized, {
            outputDirectory,
          }),
        );
      },
    );

    server.registerTool(
      "get_tessera_run_status",
      {
        title: "Get Tessera run status",
        description:
          "Read a durable background Tessera job without changing it.",
        inputSchema: {
          jobPath: z.string().min(1),
          includeResult: z.boolean().default(false),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ jobPath, includeResult }) =>
        valueContent(
          await options.tesseraRunJobs!.status(
            jobPath,
            includeResult,
          ),
        ),
    );

    server.registerTool(
      "resume_tessera_run",
      {
        title: "Resume a Tessera run",
        description:
          "Resume a stopped durable run using its frozen request, manifest, artifacts, and profile policy.",
        inputSchema: {
          jobPath: z.string().min(1),
          restartFrom: z.boolean().default(false),
          outputDirectory: z.string().min(1).optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ jobPath, restartFrom, outputDirectory }) =>
        valueContent(
          await options.tesseraRunJobs!.resume(jobPath, {
            restartFrom,
            outputDirectory,
          }),
        ),
    );

    server.registerTool(
      "resolve_tessera_profiles",
      {
        title: "Resolve Tessera profile choices",
        description:
          "Freeze explicit structured weapon-profile choices into a stopped durable run before resuming it.",
        inputSchema: {
          jobPath: z.string().min(1),
          policy: jobProfilePolicySchema,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ jobPath, policy }) =>
        valueContent(
          await options.tesseraRunJobs!.resolveProfiles(
            jobPath,
            policy,
          ),
        ),
    );

    if (options.tesseraRunJobs.restoreNewRecruitArtifact) {
      server.registerTool(
        "restore_tessera_new_recruit_artifact",
        {
          title: "Restore a retained New Recruit artifact",
          description:
            "Repair a legacy created-mutation receipt from one exact durable Tessera job. This verifies sealed hashes and writes only local recovery state; it never opens New Recruit or Tessera, creates a list, uploads a roster, or starts a simulation.",
          inputSchema: {
            roster: RosterDraftSchema,
            jobPath: z.string().min(1),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ roster, jobPath }) => {
          try {
            return resultContent(
              await options.tesseraRunJobs!.restoreNewRecruitArtifact!(
                roster as RosterDraftV1,
                jobPath,
              ),
            );
          } catch (error) {
            const coded = error as { code?: unknown };
            return resultContent({
              ok: false,
              data: null,
              violations: [
                {
                  code:
                    typeof coded.code === "string"
                      ? coded.code
                      : "NEW_RECRUIT_LEGACY_ARTIFACT_RESTORE_FAILED",
                  message:
                    error instanceof Error
                      ? error.message
                      : "The retained legacy artifact could not be restored.",
                  severity: "error" as const,
                },
              ],
              warnings: [],
            });
          }
        },
      );
    }

    server.registerTool(
      "cancel_tessera_run",
      {
        title: "Cancel a Tessera run",
        description:
          "Stop the local worker while retaining manifests, prepared artifacts, and the New Recruit inventory. It never deletes remote lists.",
        inputSchema: {
          jobPath: z.string().min(1),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ jobPath }) =>
        valueContent(
          await options.tesseraRunJobs!.cancel(jobPath),
        ),
    );
  }

  return server;
}
