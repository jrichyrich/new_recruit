import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  BuildAndAnalyzeRosterInput,
  BuildAndAnalyzeRosterResult,
  BuildAndStressRosterInput,
  BuildAndStressRosterResult,
  ProfilePolicyV1,
  ResultEnvelope,
  RosterDraftV1,
  RuntimeProvenance,
  TesseraMatchupReport,
  TesseraPreparedRoster,
  TesseraProviderCompatibilityEnvelope,
  TesseraRevisionComparisonReport,
  TesseraSimulationProvider,
  TesseraSimulationProviderIdentity,
  TesseraStressRunReport,
  TesseraStressRevisionReport,
} from "../../lib/rosterpilot";
import { previewFactionStressPortfolio } from "../../lib/rosterpilot";
import {
  retainDataBundleReference,
} from "../../lib/rosterpilot/data-operations";
import { projectRoot } from "../agent/paths";
import {
  getLocalAgentStatus,
  LocalAgentError,
  startTesseraRunThroughLocalAgent,
} from "../agent/client";
import { getRuntimeProvenance } from "../runtime-provenance";
import { buildAndAnalyzeRosterMatchup } from "./exact-full-loop";
import { buildAndStressRosterAgainstFaction } from "./full-loop";
import {
  analyzeRosterMatchup,
  compareRosterRevision,
  type TesseraAnalysisOptions,
  type TesseraOpponentInput,
} from "./companion";
import {
  aggregateProfileRequirements,
  ProfilePolicySchema,
  profilePolicyScaffold,
  validateProfilePolicy,
} from "./profile-policy";
import {
  compareRosterStressRevision,
  runRosterStressTest,
  type TesseraStressOptions,
  verifyAndMigrateTesseraStressManifest,
} from "./stress";
import {
  createExactReportReceipt,
  exactReportReceiptPath,
  verifyExactReportReceipt,
} from "./exact-report-integrity";
import {
  assertTesseraScenarioContractProvider,
  assertTesseraScenarioContractScope,
  TESSERA_SCENARIO_METRICS,
  TESSERA_SCENARIO_PHASES,
  tesseraScenarioContractSha256,
} from "./scenario-contract";
import {
  providerCompatibilityEnvelopeSha256,
} from "./provider-compatibility";
import {
  associateWorkflowReliabilityIdentities,
  createTimingSpanV1,
  createWorkflowReliabilityRecorder,
  getWorkflowReliabilityEventStore,
  type TimingSpanV1,
  type WorkflowReliabilityOutcomeV1,
} from "../reliability";

const execFileAsync = promisify(execFile);
const sha256Pattern = /^[0-9a-f]{64}$/;
const workerReservationStaleMs = 30_000;
const controlLeaseStaleMs = 30_000;
const controlLeaseWaitMs = 5_000;
const automaticAttemptLimit = 3;
const lifetimeAttemptLimit = 5;

type TesseraRunInputArtifact = {
  kind:
    | "opponent-rosz"
    | "profile-policy"
    | "baseline-report"
    | "baseline-artifact"
    | "stress-manifest";
  filename: string;
  path: string;
  sha256: string;
};

type TesseraProfileResolutionState = {
  violationCode:
    | "TESSERA_PROFILE_POLICY_REQUIRED"
    | "TESSERA_PROFILE_POLICY_REQUIRED_AFTER_ENRICHMENT";
  scaffoldPath: string | null;
  scaffoldSha256: string | null;
  scaffold: ProfilePolicyV1 | null;
  requirements: Array<{
    faction: string;
    unit: string;
    unitOccurrence?: number;
    modelCount?: number;
    weaponGroup: string;
    phase: "shooting" | "fight";
    availableProfiles: string[];
    activeCount: number;
  }>;
};

type TesseraDataPinReceipt = {
  role: "player" | "opponent" | "portfolio";
  sourceData: RosterDraftV1["sourceData"];
  sha256: string;
};

type TesseraRunArtifactReceipt = {
  kind:
    | "result"
    | "workflow-manifest"
    | "profile-scaffold"
    | "report-receipt";
  attempt: number;
  path: string;
  sha256: string;
};

type TesseraRunAttemptProvenance = {
  attempt: number;
  simulationStage: number;
  trigger: "start" | "resume" | "restart-from";
  retryClass: "automatic" | "lifetime-explicit";
  status: TesseraRunStatus;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  requestSha256: string;
  dataPinSha256: string;
  profilePolicySha256: string | null;
  runtime: RuntimeProvenance;
  runtimeIdentitySha256: string;
  resultSha256: string | null;
  manifestSha256: string | null;
  artifactSha256s: string[];
  connectorReceiptSha256: string | null;
  /** Complete outer data/provider envelope set retained by this attempt. */
  providerCompatibilitySha256: string | null;
  tesseraUiIdentity: string | null;
  /** Concrete provider actually selected for this attempt. */
  simulationBackend?: TesseraSimulationProvider | null;
  /** Immutable provider identity returned with this attempt's report. */
  simulationProviderIdentity?: TesseraSimulationProviderIdentity | null;
  errorCode: string | null;
};

type TesseraRunSimulationProviderPin = {
  selectedBackend: TesseraSimulationProvider;
  providerIdentity: TesseraSimulationProviderIdentity | null;
  providerIdentitySha256: string | null;
  tesseraUiIdentity: string | null;
  providerCompatibilitySha256: string | null;
  sourceAttempt: number;
};

type TesseraRunRetryBudget = {
  automaticAttemptLimit: 3;
  lifetimeAttemptLimit: 5;
  automaticAttemptsRemaining: number;
  lifetimeAttemptsRemaining: number;
  exhausted: boolean;
  explicitRestartRequired: boolean;
};

type TesseraRunRestartReceipt = {
  runId: string;
  attempt: number;
  simulationStage: number;
  jobSha256: string;
};

type TesseraRunPreparedCheckpoint = {
  sourceAttempt: number;
  player: TesseraPreparedRoster;
  opponent: TesseraPreparedRoster | null;
};

export type TesseraRunKind =
  | "exact"
  | "stress"
  | "build-and-stress"
  | "build-and-analyze"
  | "exact-revision"
  | "stress-revision";

export type TesseraRunRequest =
  | {
      kind: "exact";
      playerRoster: RosterDraftV1;
      opponent: Exclude<
        TesseraOpponentInput,
        { kind: "faction-archetypes" }
      >;
      options?: TesseraAnalysisOptions;
    }
  | {
      kind: "stress";
      playerRoster: RosterDraftV1;
      factionId: string;
      options?: TesseraStressOptions;
    }
  | {
      kind: "build-and-stress";
      input: BuildAndStressRosterInput;
      options?: TesseraStressOptions;
    }
  | {
      kind: "build-and-analyze";
      input: BuildAndAnalyzeRosterInput;
      options?: TesseraAnalysisOptions;
    }
  | {
      kind: "exact-revision";
      baselineReportPath: string;
      revisedRoster: RosterDraftV1;
      options?: TesseraAnalysisOptions;
    }
  | {
      kind: "stress-revision";
      baselineReportPath: string;
      revisedRoster: RosterDraftV1;
      options?: TesseraStressOptions;
    };

export type TesseraRunResult =
  | ResultEnvelope<TesseraMatchupReport>
  | ResultEnvelope<TesseraStressRunReport>
  | ResultEnvelope<BuildAndStressRosterResult>
  | ResultEnvelope<BuildAndAnalyzeRosterResult>
  | ResultEnvelope<TesseraRevisionComparisonReport>
  | ResultEnvelope<TesseraStressRevisionReport>;

export type TesseraRunStatus =
  | "queued"
  | "running"
  | "needs-input"
  | "complete"
  | "degraded"
  | "inconclusive"
  | "failed"
  | "cancelled";

export type TesseraRunJob = {
  schemaVersion: 1;
  jobKind: "rosterpilot-tessera-run";
  runId: string;
  runKind: TesseraRunKind;
  /** Immutable lineage to a terminal job blocked on older data. */
  supersedesRunId?: string | null;
  status: TesseraRunStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  attempt: number;
  workerPid: number | null;
  workerTokenSha256: string | null;
  jobDirectory: string;
  rootDirectory: string;
  requestPath: string;
  resultPath: string;
  manifestPath: string | null;
  profilePolicyPath: string | null;
  inputArtifacts: TesseraRunInputArtifact[];
  requestSha256: string;
  dataPins: TesseraDataPinReceipt[];
  dataPinSha256: string;
  profilePolicySha256: string | null;
  scenarioContractSha256?: string | null;
  artifactReceipts: TesseraRunArtifactReceipt[];
  preparedCheckpoint: TesseraRunPreparedCheckpoint | null;
  runtimeProvenance: RuntimeProvenance;
  runtimeIdentitySha256: string;
  simulationStage: number;
  restartFrom: TesseraRunRestartReceipt | null;
  retryBudget: TesseraRunRetryBudget;
  attemptHistory: TesseraRunAttemptProvenance[];
  timingSpans?: TimingSpanV1[];
  journalReference?: {
    workflowId: string;
    workflowKind: "tessera-run";
    lastEventSha256: string | null;
  } | null;
  reliabilityWarnings?: string[];
  /**
   * First concrete provider selected in this simulation stage. Retries are
   * forced through this provider and must reproduce its exact identity.
   */
  simulationProviderPin?: TesseraRunSimulationProviderPin | null;
  profileResolution: TesseraProfileResolutionState | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  nextAction: string | null;
};

export type TesseraRunProgress = {
  phase:
    | "queued"
    | "preflight"
    | "preparation"
    | "simulation"
    | "screening"
    | "deep-dive"
    | "validation"
    | "persistence"
    | "complete"
    | "stopped";
  completedWork: number;
  totalWork: number;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  estimateSource: "timing-derived" | "insufficient-evidence" | "terminal";
};

type TesseraRunJobDocument = TesseraRunJob & {
  request: TesseraRunRequest;
};

export type StartTesseraRunOptions = {
  outputDirectory?: string;
  rootDir?: string;
  allowOutsideRoot?: boolean;
  launch?: boolean;
  supersedesRunId?: string | null;
};

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    )
  );
}

function publicJob(document: TesseraRunJobDocument): TesseraRunJob {
  const job = { ...document } as Record<string, unknown>;
  delete job.request;
  return job as TesseraRunJob;
}

function reliabilityOutcomeForStatus(
  status: TesseraRunStatus,
): WorkflowReliabilityOutcomeV1 {
  switch (status) {
    case "queued":
      return "started";
    case "running":
      return "in-progress";
    case "complete":
      return "succeeded";
    case "degraded":
      return "degraded";
    case "inconclusive":
      return "inconclusive";
    case "needs-input":
      return "needs-input";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function reliabilityExecutionStatus(
  status: TesseraRunStatus,
) {
  return status === "queued"
    ? "not-started" as const
    : status === "running"
      ? "running" as const
      : status === "complete"
        ? "succeeded" as const
        : status;
}

function closeTimingSpan(
  spans: TimingSpanV1[],
  name: TimingSpanV1["name"],
  endedAt: string,
): TimingSpanV1[] {
  return spans.map((span) =>
    span.name === name && span.endedAt === null
      ? createTimingSpanV1({
          spanKind: span.spanKind,
          name: span.name,
          startedAt: span.startedAt,
          endedAt,
          clock: span.clock,
        })
      : span,
  );
}

async function projectTesseraReliabilityEvent(
  jobPath: string,
  document: TesseraRunJobDocument,
  eventKind: string,
  stage: string,
): Promise<TesseraRunJobDocument> {
  const workflow = {
    workflowId: document.runId,
    workflowKind: "tessera-run" as const,
  };
  const association = await associateWorkflowReliabilityIdentities({
    workflow,
    identities: [
      { kind: "tessera-run-id", value: document.runId },
      ...(document.supersedesRunId
        ? [
            {
              kind: "successor-run-id" as const,
              value: document.runId,
            },
          ]
        : []),
    ],
    predecessorWorkflowId: document.supersedesRunId ?? null,
  });
  const recorder = createWorkflowReliabilityRecorder(
    getWorkflowReliabilityEventStore(),
    {
      workflow,
      provider:
        document.simulationProviderPin?.selectedBackend ?? null,
      attributes: {
        runKind: document.runKind,
        runId: document.runId,
      },
    },
  );
  const result = await recorder.record({
    idempotencyKey: [
      document.runId,
      document.simulationStage,
      document.attempt,
      eventKind,
      document.updatedAt,
    ].join(":"),
    eventKind,
    stage,
    outcome: reliabilityOutcomeForStatus(document.status),
    occurredAt: document.updatedAt,
    timings: document.timingSpans ?? [],
    execution: {
      status: reliabilityExecutionStatus(document.status),
      attempt: document.attempt,
    },
    evidence: {
      status:
        document.status === "complete" ||
        document.status === "degraded" ||
        document.status === "inconclusive"
          ? document.artifactReceipts.length > 0
            ? "verified"
            : "partial"
          : document.artifactReceipts.length > 0
            ? "partial"
            : "none",
      artifactCount: document.artifactReceipts.length,
      evidenceSha256:
        document.artifactReceipts.length > 0
          ? canonicalSha256(
              document.artifactReceipts.map((receipt) => ({
                kind: receipt.kind,
                attempt: receipt.attempt,
                sha256: receipt.sha256,
              })),
            )
          : null,
    },
    error: document.error,
    attributes: {
      journeyId: null,
      attempt: document.attempt,
      simulationStage: document.simulationStage,
      supersedesRunId: document.supersedesRunId ?? null,
      requestSha256: document.requestSha256,
      dataPinSha256: document.dataPinSha256,
      profilePolicySha256: document.profilePolicySha256,
      runtime: {
        buildId: document.runtimeProvenance.buildId,
        gitHead: document.runtimeProvenance.gitHead,
        sourceFingerprint:
          document.runtimeProvenance.sourceFingerprintNow,
        tesseraJobWorkerSha256:
          document.runtimeProvenance.tesseraJobWorkerSha256 ?? null,
      },
      receipts: document.artifactReceipts.map((receipt) => ({
        kind: receipt.kind,
        attempt: receipt.attempt,
        filename: path.basename(receipt.path),
        sha256: receipt.sha256,
      })),
    },
  });
  const warnings = [
    ...(document.reliabilityWarnings ?? []),
    ...(!association.ok && association.warning
      ? [association.warning]
      : []),
    ...(!result.ok
      ? [
          `Reliability journal warning: ${result.error.code}: ${result.error.message}`,
        ]
      : []),
  ];
  const projected: TesseraRunJobDocument = {
    ...document,
    journalReference: result.ok
      ? {
          ...workflow,
          lastEventSha256: result.data.event.eventSha256,
        }
      : document.journalReference ?? null,
    reliabilityWarnings: [...new Set(warnings)].slice(-20),
  };
  await writeJsonAtomic(jobPath, projected);
  return projected;
}

function jobError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string | null {
  return (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
    )
    ? error.code
    : null;
}

function contentSha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return contentSha256(JSON.stringify(canonicalValue(value)));
}

function runtimeIdentitySha256(
  runtime: RuntimeProvenance,
): string {
  return canonicalSha256({
    rosterPilotVersion: runtime.rosterPilotVersion,
    rulesPackageVersion: runtime.rulesPackageVersion,
    stressGeneratorVersion: runtime.stressGeneratorVersion,
    gitHead: runtime.gitHead,
    sourceFingerprintAtStart:
      runtime.sourceFingerprintAtStart,
    sourceFingerprintNow: runtime.sourceFingerprintNow,
    buildId: runtime.buildId,
    nodeVersion: runtime.nodeVersion ?? null,
    platform: runtime.platform ?? null,
    architecture: runtime.architecture ?? null,
    chromeVersion: runtime.chromeVersion ?? null,
    playwrightVersion: runtime.playwrightVersion ?? null,
    brokerBuildId: runtime.brokerBuildId ?? null,
    tesseraJobWorkerSha256:
      runtime.tesseraJobWorkerSha256 ?? null,
    tesseraJobWorkerSourceSha256:
      runtime.tesseraJobWorkerSourceSha256 ?? null,
    macOsVersion: runtime.macOsVersion ?? null,
    localAgentExpectedProtocolVersion:
      runtime.localAgentExpectedProtocolVersion ?? null,
    localAgentExpectedVersion:
      runtime.localAgentExpectedVersion ?? null,
    localAgentObservedStatus:
      runtime.localAgentObservedStatus ?? null,
    localAgentProcessIdentity:
      runtime.localAgentProcessIdentity ?? null,
    mcpBuildId: runtime.mcpBuildId ?? null,
    dataReleaseId: runtime.dataReleaseId ?? null,
    dataFreshnessCheckedAt:
      runtime.dataFreshnessCheckedAt ?? null,
    dataGeneratedAt: runtime.dataGeneratedAt ?? null,
  });
}

export function durableTesseraRuntimeAdmissionIssue(
  runtime: RuntimeProvenance,
): { code: string; message: string } | null {
  if (runtime.stale) {
    return {
      code: "RUNTIME_RESTART_REQUIRED",
      message:
        "RosterPilot source changed after this MCP or CLI process started. Restart the MCP process and run `rosterpilot agent ensure-current` before starting Tessera; no job or external mutation was launched.",
    };
  }
  if (
    !runtime.tesseraJobWorkerSha256 ||
    !runtime.tesseraJobWorkerSourceSha256
  ) {
    return {
      code: "TESSERA_WORKER_BUILD_MISSING",
      message:
        "The precompiled Tessera job worker is missing or failed its build receipt. Run `npm run tessera:worker:build`, restart the local agent and MCP process, then start the run again; no external activity was launched.",
    };
  }
  const agent = runtime.localAgentObservedStatus;
  if (!agent?.available) return null;
  const buildChanged =
    agent.runtimeBuildId !== null &&
    agent.runtimeBuildId !== runtime.buildId;
  const sourceChanged =
    agent.runtimeSourceFingerprint !== null &&
    agent.runtimeSourceFingerprint !==
      runtime.sourceFingerprintNow;
  const workerMissing =
    !agent.tesseraJobWorkerSha256 ||
    !agent.tesseraJobWorkerSourceSha256;
  const workerChanged =
    agent.tesseraJobWorkerSha256 !== null &&
    agent.tesseraJobWorkerSha256 !== undefined &&
    agent.tesseraJobWorkerSha256 !==
      runtime.tesseraJobWorkerSha256;
  const workerSourceChanged =
    agent.tesseraJobWorkerSourceSha256 !== null &&
    agent.tesseraJobWorkerSourceSha256 !== undefined &&
    agent.tesseraJobWorkerSourceSha256 !==
      runtime.tesseraJobWorkerSourceSha256;
  if (
    buildChanged ||
    sourceChanged ||
    workerMissing ||
    workerChanged ||
    workerSourceChanged
  ) {
    return {
      code:
        workerMissing || workerChanged || workerSourceChanged
          ? "TESSERA_WORKER_BUILD_MISMATCH"
          : "RUNTIME_RESTART_REQUIRED",
      message:
        "The local agent and this MCP or CLI process were built from different RosterPilot source. Run `rosterpilot agent ensure-current`, restart the MCP process, and start the Tessera run again; no job or external mutation was launched.",
    };
  }
  return null;
}

function assertDurableRuntimeAdmission(
  runtime: RuntimeProvenance,
): void {
  const issue = durableTesseraRuntimeAdmissionIssue(runtime);
  if (issue) throw jobError(issue.code, issue.message);
}

async function jobRuntimeProvenance(): Promise<RuntimeProvenance> {
  const runtime = getRuntimeProvenance();
  try {
    const status = await getLocalAgentStatus({
      timeoutMs: 1_000,
    });
    return {
      ...runtime,
      localAgentObservedStatus: {
        available: status.available,
        version: status.version,
        protocolVersion: status.protocolVersion,
        protocolCompatible: status.protocolCompatible,
        projectDirectory: status.projectDirectory,
        nodeExecutable: status.nodeExecutable,
        browserAvailable: status.browserAvailable,
        brokerAvailable: status.brokerAvailable,
        runtimeBuildId: status.runtime?.buildId ?? null,
        runtimeSourceFingerprint:
          status.runtime?.sourceFingerprintNow ?? null,
        tesseraJobWorkerSha256:
          status.runtime?.tesseraJobWorkerSha256 ?? null,
        tesseraJobWorkerSourceSha256:
          status.runtime?.tesseraJobWorkerSourceSha256 ?? null,
        statusErrorCode: null,
      },
    };
  } catch (error) {
    return {
      ...runtime,
      localAgentObservedStatus: {
        available: false,
        version: null,
        protocolVersion: null,
        protocolCompatible: false,
        projectDirectory: null,
        nodeExecutable: null,
        browserAvailable: null,
        brokerAvailable: null,
        runtimeBuildId: null,
        runtimeSourceFingerprint: null,
        tesseraJobWorkerSha256: null,
        tesseraJobWorkerSourceSha256: null,
        statusErrorCode:
          error instanceof LocalAgentError
            ? error.code
            : errorCode(error) ??
              "LOCAL_AGENT_STATUS_UNAVAILABLE",
      },
    };
  }
}

function dataPinsForRequest(
  request: TesseraRunRequest,
): TesseraDataPinReceipt[] {
  const candidates: Array<{
    role: TesseraDataPinReceipt["role"];
    roster: RosterDraftV1 | undefined;
  }> = [];
  if (request.kind === "exact") {
    candidates.push({
      role: "player",
      roster: request.playerRoster,
    });
    if (request.opponent.kind === "roster") {
      candidates.push({
        role: "opponent",
        roster: request.opponent.roster,
      });
    } else {
      candidates.push({
        role: "opponent",
        roster: request.options?.opponentRosterContext,
      });
    }
  } else if (request.kind === "stress") {
    candidates.push({
      role: "player",
      roster: request.playerRoster,
    });
  } else if (request.kind === "build-and-analyze") {
    candidates.push({
      role: "opponent",
      roster: request.input.opponentRoster,
    });
  } else if (
    request.kind === "exact-revision" ||
    request.kind === "stress-revision"
  ) {
    candidates.push({
      role: "player",
      roster: request.revisedRoster,
    });
  }
  const receipts = candidates
    .filter(
      (
        candidate,
      ): candidate is {
        role: TesseraDataPinReceipt["role"];
        roster: RosterDraftV1;
      } => candidate.roster !== undefined,
    )
    .map(({ role, roster }) => ({
      role,
      sourceData: structuredClone(roster.sourceData),
      sha256: canonicalSha256(roster.sourceData),
    }));
  const preview =
    request.kind === "stress" ||
    request.kind === "build-and-stress"
      ? request.options?.portfolioPreview
      : undefined;
  if (preview?.portfolio.sourceData) {
    receipts.push({
      role: "portfolio",
      sourceData: structuredClone(
        preview.portfolio.sourceData,
      ),
      sha256: canonicalSha256(
        preview.portfolio.sourceData,
      ),
    });
  }
  return receipts.sort(
    (left, right) =>
      left.role.localeCompare(right.role) ||
      left.sha256.localeCompare(right.sha256),
  );
}

function requestScenarioContractSha256(
  request: TesseraRunRequest,
): string | null {
  return request.options?.scenarioContract
    ? tesseraScenarioContractSha256(
        request.options.scenarioContract,
      )
    : null;
}

function normalizeRequestScenarioContract(
  request: TesseraRunRequest,
): TesseraRunRequest {
  if (!request.options?.scenarioContract) return request;
  if (
    request.kind === "exact-revision" ||
    request.kind === "stress-revision"
  ) {
    throw jobError(
      "TESSERA_SCENARIO_CONTRACT_MISMATCH",
      "Paired revisions replay the baseline scenario contract and cannot accept a caller-supplied replacement.",
    );
  }
  const normalized = structuredClone(request);
  const options = normalized.options!;
  const executionMode =
    normalized.kind === "build-and-stress" ||
    normalized.kind === "build-and-analyze"
      ? normalized.input.executionMode ??
        options.executionMode ??
        (normalized.input.experimental || options.experimental
          ? "simulate"
          : "prepare-only")
      : options.executionMode ??
        (options.experimental ? "simulate" : "prepare-only");
  if (executionMode !== "simulate") {
    throw jobError(
      "TESSERA_SCENARIO_CONTRACT_MISMATCH",
      "A Tessera scenario contract requires executionMode=simulate.",
    );
  }
  const backend =
    normalized.kind === "build-and-stress" ||
    normalized.kind === "build-and-analyze"
      ? normalized.input.simulationBackend ??
        options.simulationBackend ??
        "auto"
      : options.simulationBackend ?? "auto";
  const phases =
    normalized.kind === "exact"
      ? normalized.options?.phases?.length
        ? normalized.options.phases
        : normalized.options?.analysisMode === "quick"
          ? (["shooting"] as const)
          : TESSERA_SCENARIO_PHASES
      : TESSERA_SCENARIO_PHASES;
  const metrics =
    normalized.kind === "exact"
      ? normalized.options?.metrics?.length
        ? normalized.options.metrics
        : normalized.options?.analysisMode === "quick"
          ? (["wipe-probability"] as const)
          : TESSERA_SCENARIO_METRICS
      : TESSERA_SCENARIO_METRICS;
  options.scenarioContract =
    assertTesseraScenarioContractScope(
      options.scenarioContract!,
      phases,
      metrics,
    );
  assertTesseraScenarioContractProvider(
    options.scenarioContract,
    backend,
  );
  return normalized;
}

function retryBudgetFor(
  attempt: number,
  status: TesseraRunStatus,
): TesseraRunRetryBudget {
  const automaticAttemptsRemaining = Math.max(
    0,
    automaticAttemptLimit - attempt,
  );
  const lifetimeAttemptsRemaining = Math.max(
    0,
    lifetimeAttemptLimit - attempt,
  );
  const exhausted = lifetimeAttemptsRemaining === 0;
  return {
    automaticAttemptLimit,
    lifetimeAttemptLimit,
    automaticAttemptsRemaining,
    lifetimeAttemptsRemaining,
    exhausted,
    explicitRestartRequired:
      exhausted &&
      status !== "complete" &&
      status !== "degraded",
  };
}

function attemptProvenance(input: {
  attempt: number;
  simulationStage: number;
  trigger: TesseraRunAttemptProvenance["trigger"];
  status: TesseraRunStatus;
  at: string;
  requestSha256: string;
  dataPinSha256: string;
  profilePolicySha256: string | null;
  runtime: RuntimeProvenance;
}): TesseraRunAttemptProvenance {
  return {
    attempt: input.attempt,
    simulationStage: input.simulationStage,
    trigger: input.trigger,
    retryClass:
      input.attempt <= automaticAttemptLimit
        ? "automatic"
        : "lifetime-explicit",
    status: input.status,
    queuedAt: input.at,
    startedAt: null,
    completedAt: null,
    requestSha256: input.requestSha256,
    dataPinSha256: input.dataPinSha256,
    profilePolicySha256: input.profilePolicySha256,
    runtime: input.runtime,
    runtimeIdentitySha256:
      runtimeIdentitySha256(input.runtime),
    resultSha256: null,
    manifestSha256: null,
    artifactSha256s: [],
    connectorReceiptSha256: null,
    providerCompatibilitySha256: null,
    tesseraUiIdentity: null,
    simulationBackend: null,
    simulationProviderIdentity: null,
    errorCode: null,
  };
}

function updateCurrentAttempt(
  history: TesseraRunAttemptProvenance[],
  attempt: number,
  changes: Partial<TesseraRunAttemptProvenance>,
): TesseraRunAttemptProvenance[] {
  return history.map((entry) =>
    entry.attempt === attempt
      ? { ...entry, ...changes }
      : entry,
  );
}

async function fileSha256(filename: string): Promise<string> {
  return contentSha256(await readFile(filename));
}

function profilePolicySha256For(
  profilePolicyPath: string | null,
  artifacts: TesseraRunInputArtifact[],
): string | null {
  if (!profilePolicyPath) return null;
  return (
    artifacts.find(
      (artifact) =>
        artifact.kind === "profile-policy" &&
        path.resolve(artifact.path) ===
          path.resolve(profilePolicyPath),
    )?.sha256 ?? null
  );
}

async function artifactReceipt(
  document: TesseraRunJobDocument,
  kind: TesseraRunArtifactReceipt["kind"],
  filename: string | null,
): Promise<TesseraRunArtifactReceipt | null> {
  if (!filename) return null;
  const resolved = await assertFilesystemPathInsideJob(
    document.jobDirectory,
    filename,
    `${kind} artifact`,
  );
  if (resolved === path.resolve(document.requestPath)) return null;
  try {
    const metadata = await lstat(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    return {
      kind,
      attempt: document.attempt,
      path: path.relative(document.jobDirectory, resolved),
      sha256: await fileSha256(resolved),
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function artifactReceiptsForResult(
  document: TesseraRunJobDocument,
  profileResolution: TesseraProfileResolutionState | null,
  result: TesseraRunResult,
): Promise<TesseraRunArtifactReceipt[]> {
  const reportReceiptPaths =
    await verifiedExactReportReceiptPaths(document, result);
  const receipts = await Promise.all([
    artifactReceipt(document, "result", document.resultPath),
    artifactReceipt(
      document,
      "workflow-manifest",
      document.manifestPath,
    ),
    artifactReceipt(
      document,
      "profile-scaffold",
      profileResolution?.scaffoldPath ?? null,
    ),
    ...reportReceiptPaths.map((filename) =>
      artifactReceipt(
        document,
        "report-receipt",
        filename,
      ),
    ),
  ]);
  return receipts.filter(
    (
      receipt,
    ): receipt is TesseraRunArtifactReceipt => receipt !== null,
  );
}

async function verifiedExactReportReceiptPaths(
  document: TesseraRunJobDocument,
  result: TesseraRunResult,
): Promise<string[]> {
  const receiptPaths: string[] = [];
  for (const resultReport of exactReportsFromResult(result)) {
    const inventory = Array.isArray(resultReport.artifacts)
      ? resultReport.artifacts
      : [];
    const reportArtifact = inventory.find(
      (artifact) => artifact.format === "matchup-json",
    );
    const receiptArtifact = inventory.find(
      (artifact) => artifact.format === "matchup-receipt",
    );
    if (!reportArtifact && !receiptArtifact) continue;
    if (!reportArtifact || !receiptArtifact) {
      throw jobError(
        "TESSERA_JOB_REPORT_RECEIPT_INVALID",
        "An exact report result did not retain both its report and sidecar receipt.",
      );
    }
    const reportPath = await assertFilesystemPathInsideJob(
      document.jobDirectory,
      reportArtifact.written,
      "Exact report artifact",
    );
    const receiptPath =
      await assertFilesystemPathInsideJob(
        document.jobDirectory,
        receiptArtifact.written,
        "Exact report receipt artifact",
      );
    let serializedReport: string;
    let parsedReport: TesseraMatchupReport;
    let parsedReceipt: unknown;
    try {
      serializedReport = await readFile(reportPath, "utf8");
      parsedReport = JSON.parse(
        serializedReport,
      ) as TesseraMatchupReport;
      parsedReceipt = JSON.parse(
        await readFile(receiptPath, "utf8"),
      );
    } catch (error) {
      throw jobError(
        "TESSERA_JOB_REPORT_RECEIPT_INVALID",
        `An exact report or sidecar receipt is unreadable: ${
          error instanceof Error
            ? error.message
            : "artifact unreadable"
        }`,
      );
    }
    const issue = verifyExactReportReceipt(
      reportPath,
      serializedReport,
      parsedReport,
      parsedReceipt,
    );
    if (issue) {
      throw jobError(
        "TESSERA_JOB_REPORT_RECEIPT_INVALID",
        issue,
      );
    }
    receiptPaths.push(receiptPath);
  }
  return [...new Set(receiptPaths)];
}

function connectorEventsFromReport(
  report: Record<string, unknown>,
): unknown[] {
  if (Array.isArray(report.connectorEvents)) {
    return report.connectorEvents;
  }
  if (
    report.preparation &&
    typeof report.preparation === "object" &&
    Array.isArray(
      (report.preparation as Record<string, unknown>)
        .connectorEvents,
    )
  ) {
    return (
      report.preparation as Record<string, unknown>
    ).connectorEvents as unknown[];
  }
  return [];
}

function reportProviderCompatibilitySha256(
  report: Record<string, unknown>,
): string | null {
  const candidates = [
    ...(Array.isArray(report.providerCompatibilityEnvelopes)
      ? report.providerCompatibilityEnvelopes
      : []),
    ...(report.providerCompatibility &&
    typeof report.providerCompatibility === "object"
      ? [report.providerCompatibility]
      : []),
  ];
  if (candidates.length === 0) return null;
  const hashes = new Set<string>();
  let complete = true;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      throw jobError(
        "TESSERA_PROVIDER_COMPATIBILITY_INVALID",
        "The Tessera result contains a malformed provider-compatibility envelope.",
      );
    }
    const envelope = candidate as TesseraProviderCompatibilityEnvelope;
    const { envelopeSha256, ...withoutDigest } = envelope;
    if (
      !sha256Pattern.test(envelopeSha256) ||
      providerCompatibilityEnvelopeSha256(withoutDigest) !==
        envelopeSha256
    ) {
      throw jobError(
        "TESSERA_PROVIDER_COMPATIBILITY_INVALID",
        "The Tessera result's provider-compatibility envelope does not match its content digest.",
      );
    }
    hashes.add(envelopeSha256);
    complete &&= envelope.complete && envelope.issues.length === 0;
  }
  return complete
    ? canonicalSha256([...hashes].sort())
    : null;
}

type TesseraReportSimulationProvenance = {
  simulationBackend: TesseraSimulationProvider | null;
  simulationProviderIdentity: TesseraSimulationProviderIdentity | null;
  tesseraUiIdentity: string | null;
  providerCompatibilitySha256: string | null;
};

function canonicalLegacyTesseraUiIdentity(
  value: string | null,
): string | null {
  if (value === null || !value.includes("|")) return value;
  const identities = value.split("|");
  const canonical = identities[0];
  if (
    canonical &&
    identities.every((identity) => identity === canonical)
  ) {
    return canonical;
  }
  throw jobError(
    "TESSERA_PROVIDER_PROVENANCE_DRIFT",
    "The legacy Tessera UI identity contains more than one distinct website identity.",
  );
}

function parsedSimulationProviderIdentity(
  value: unknown,
): TesseraSimulationProviderIdentity | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object") {
    throw jobError(
      "TESSERA_PROVIDER_PROVENANCE_INVALID",
      "The Tessera result contains a malformed simulation-provider identity.",
    );
  }
  const identity = value as Record<string, unknown>;
  const commonValid =
    identity.schemaVersion === 1 &&
    typeof identity.adapterVersion === "string" &&
    identity.adapterVersion.length > 0;
  if (
    commonValid &&
    identity.provider === "website" &&
    identity.engine === "tessera-ui" &&
    (
      identity.uiIdentity === null ||
      typeof identity.uiIdentity === "string"
    )
  ) {
    return value as TesseraSimulationProviderIdentity;
  }
  if (
    commonValid &&
    identity.provider === "local-engine" &&
    identity.engine === "tessera-engine" &&
    identity.repository === "Tessera-cmd/tessera-engine" &&
    typeof identity.commit === "string" &&
    /^[0-9a-f]{40,64}$/.test(identity.commit) &&
    typeof identity.tree === "string" &&
    /^[0-9a-f]{40,64}$/.test(identity.tree) &&
    typeof identity.sourceSha256 === "string" &&
    sha256Pattern.test(identity.sourceSha256) &&
    typeof identity.compilerVersion === "string" &&
    identity.compilerVersion.length > 0 &&
    identity.inputSchemaVersion === 1 &&
    typeof identity.capabilityManifestSha256 === "string" &&
    sha256Pattern.test(identity.capabilityManifestSha256) &&
    (
      identity.promotion === "candidate" ||
      identity.promotion === "promoted"
    ) &&
    (
      identity.licenseState === "evaluation-only" ||
      identity.licenseState === "approved"
    )
  ) {
    return value as TesseraSimulationProviderIdentity;
  }
  throw jobError(
    "TESSERA_PROVIDER_PROVENANCE_INVALID",
    "The Tessera result contains a malformed simulation-provider identity.",
  );
}

function reportSimulationProvenance(
  report: Record<string, unknown>,
): TesseraReportSimulationProvenance {
  const simulation =
    report.simulation && typeof report.simulation === "object"
      ? report.simulation as Record<string, unknown>
      : null;
  const selected = simulation?.selectedBackend;
  if (
    selected !== undefined &&
    selected !== "local-engine" &&
    selected !== "website"
  ) {
    throw jobError(
      "TESSERA_PROVIDER_PROVENANCE_INVALID",
      "The Tessera result contains an invalid selected simulation backend.",
    );
  }
  const providerIdentity = parsedSimulationProviderIdentity(
    simulation?.providerIdentity,
  );
  if (
    selected !== undefined &&
    providerIdentity &&
    providerIdentity.provider !== selected
  ) {
    throw jobError(
      "TESSERA_PROVIDER_PROVENANCE_DRIFT",
      "The selected simulation backend does not match the retained provider identity.",
    );
  }
  const source =
    typeof report.source === "string" ? report.source : null;
  const legacyBackend: TesseraSimulationProvider | null =
    source === "tessera-local-engine" ||
    source === "tessera-local-engine-failed"
      ? "local-engine"
      : source === "tessera-ui" ||
          source === "tessera-ui-failed"
        ? "website"
        : null;
  const simulationBackend =
    (selected as TesseraSimulationProvider | undefined) ??
    providerIdentity?.provider ??
    legacyBackend;
  if (
    simulationBackend &&
    legacyBackend &&
    simulationBackend !== legacyBackend
  ) {
    throw jobError(
      "TESSERA_PROVIDER_PROVENANCE_DRIFT",
      "The Tessera report source does not match its selected simulation backend.",
    );
  }
  const legacyUiIdentity = canonicalLegacyTesseraUiIdentity(
    typeof report.tesseraUiIdentity === "string"
      ? report.tesseraUiIdentity
      : null,
  );
  const providerUiIdentity =
    providerIdentity?.provider === "website"
      ? providerIdentity.uiIdentity
      : null;
  if (
    legacyUiIdentity &&
    providerUiIdentity &&
    legacyUiIdentity !== providerUiIdentity
  ) {
    throw jobError(
      "TESSERA_PROVIDER_PROVENANCE_DRIFT",
      "The legacy Tessera UI identity does not match the website-provider identity.",
    );
  }
  return {
    simulationBackend,
    simulationProviderIdentity: providerIdentity,
    tesseraUiIdentity:
      providerUiIdentity ?? legacyUiIdentity,
    providerCompatibilitySha256:
      reportProviderCompatibilitySha256(report),
  };
}

function commonReportSimulationProvenance(
  reports: Record<string, unknown>[],
): TesseraReportSimulationProvenance {
  const provenances = reports.map(reportSimulationProvenance);
  const withBackend = provenances.filter(
    (
      provenance,
    ): provenance is TesseraReportSimulationProvenance & {
      simulationBackend: TesseraSimulationProvider;
    } => provenance.simulationBackend !== null,
  );
  const backends = new Set(
    withBackend.map((provenance) => provenance.simulationBackend),
  );
  if (backends.size > 1) {
    throw jobError(
      "TESSERA_PROVIDER_PROVENANCE_DRIFT",
      "One durable result contains evidence from more than one simulation backend.",
    );
  }
  const identities = withBackend
    .map((provenance) => provenance.simulationProviderIdentity)
    .filter(
      (
        identity,
      ): identity is TesseraSimulationProviderIdentity => identity !== null,
    );
  const identityHashes = new Set(
    identities.map((identity) => canonicalSha256(identity)),
  );
  if (identityHashes.size > 1) {
    throw jobError(
      "TESSERA_PROVIDER_PROVENANCE_DRIFT",
      "One durable result contains more than one simulation-provider identity.",
    );
  }
  const uiIdentities = withBackend
    .map((provenance) => provenance.tesseraUiIdentity)
    .filter((identity): identity is string => identity !== null);
  if (new Set(uiIdentities).size > 1) {
    throw jobError(
      "TESSERA_PROVIDER_PROVENANCE_DRIFT",
      "One durable result contains more than one Tessera UI identity.",
    );
  }
  const providerCompatibilityHashes = provenances.map(
    (provenance) => provenance.providerCompatibilitySha256,
  );
  return {
    simulationBackend: withBackend[0]?.simulationBackend ?? null,
    simulationProviderIdentity:
      identities.length === withBackend.length
        ? identities[0] ?? null
        : null,
    tesseraUiIdentity:
      uiIdentities.length === withBackend.length
        ? uiIdentities[0] ?? null
        : null,
    providerCompatibilitySha256:
      providerCompatibilityHashes.length > 0 &&
      providerCompatibilityHashes.every(
        (value): value is string => value !== null,
      )
        ? canonicalSha256(providerCompatibilityHashes.sort())
        : null,
  };
}

function reportProvenance(result: TesseraRunResult): {
  connectorReceiptSha256: string | null;
  providerCompatibilitySha256: string | null;
  tesseraUiIdentity: string | null;
  simulationBackend: TesseraSimulationProvider | null;
  simulationProviderIdentity: TesseraSimulationProviderIdentity | null;
} {
  const data =
    result.data && typeof result.data === "object"
      ? result.data as Record<string, unknown>
      : null;
  const nested =
    data &&
    (
      (
        data.matchupReport &&
        typeof data.matchupReport === "object"
      )
        ? data.matchupReport
        : (
            data.stressReport &&
            typeof data.stressReport === "object"
          )
          ? data.stressReport
          : data
    ) as Record<string, unknown> | null;
  const revisedReports =
    data && Array.isArray(data.revisedReports)
      ? data.revisedReports.filter(
          (
            report,
          ): report is Record<string, unknown> =>
            report !== null &&
            typeof report === "object",
        )
      : [];
  const stressRevisionReports = data
    ? [data.baseline, data.revised].filter(
        (
          report,
        ): report is Record<string, unknown> =>
          report !== null && typeof report === "object",
      )
    : [];
  if (stressRevisionReports.length > 0) {
    const connectorEvents = stressRevisionReports.flatMap(
      connectorEventsFromReport,
    );
    return {
      connectorReceiptSha256:
        connectorEvents.length > 0
          ? canonicalSha256(connectorEvents)
          : null,
      ...commonReportSimulationProvenance(
        stressRevisionReports,
      ),
    };
  }
  if (revisedReports.length > 0) {
    const connectorEvents = revisedReports.flatMap(
      connectorEventsFromReport,
    );
    const simulationProvenance =
      commonReportSimulationProvenance(revisedReports);
    return {
      connectorReceiptSha256:
        connectorEvents.length > 0
          ? canonicalSha256(connectorEvents)
          : null,
      ...simulationProvenance,
    };
  }
  const connectorEvents = nested
    ? connectorEventsFromReport(nested)
    : [];
  const simulationProvenance = nested
    ? reportSimulationProvenance(nested)
    : {
        simulationBackend: null,
        simulationProviderIdentity: null,
        tesseraUiIdentity: null,
        providerCompatibilitySha256: null,
      };
  return {
    connectorReceiptSha256: connectorEvents.length > 0
      ? canonicalSha256(connectorEvents)
      : null,
    ...simulationProvenance,
  };
}

function assertScenarioContractResultMatches(
  expectedSha256: string | null | undefined,
  result: TesseraRunResult,
): void {
  if (!expectedSha256) return;
  const data =
    result.data && typeof result.data === "object"
      ? result.data as Record<string, unknown>
      : null;
  const nested =
    data &&
    (
      data.matchupReport && typeof data.matchupReport === "object"
        ? data.matchupReport
        : data.stressReport && typeof data.stressReport === "object"
          ? data.stressReport
          : data
    ) as Record<string, unknown> | null;
  if (
    nested?.status !== "complete" &&
    nested?.status !== "degraded"
  ) {
    return;
  }
  const reportedSha256 = nested.scenarioContractSha256;
  if (
    typeof reportedSha256 !== "string" ||
    !sha256Pattern.test(reportedSha256) ||
    reportedSha256 !== expectedSha256
  ) {
    throw jobError(
      "TESSERA_SCENARIO_CONTRACT_MISMATCH",
      "The completed Tessera report does not match the durable job's frozen scenario-contract SHA-256.",
    );
  }
  if (nested.scenarioContract !== undefined) {
    let observedSha256: string;
    try {
      observedSha256 = tesseraScenarioContractSha256(
        nested.scenarioContract as Parameters<
          typeof tesseraScenarioContractSha256
        >[0],
      );
    } catch {
      throw jobError(
        "TESSERA_SCENARIO_CONTRACT_MISMATCH",
        "The completed Tessera report contains an invalid canonical scenario contract.",
      );
    }
    if (observedSha256 !== expectedSha256) {
      throw jobError(
        "TESSERA_SCENARIO_CONTRACT_MISMATCH",
        "The completed Tessera report's canonical scenario contract does not match its durable job binding.",
      );
    }
  }
}

function simulationProviderPinFromProvenance(
  provenance: ReturnType<typeof reportProvenance>,
  sourceAttempt: number,
): TesseraRunSimulationProviderPin | null {
  if (!provenance.simulationBackend) return null;
  return {
    selectedBackend: provenance.simulationBackend,
    providerIdentity: provenance.simulationProviderIdentity,
    providerIdentitySha256: provenance.simulationProviderIdentity
      ? canonicalSha256(provenance.simulationProviderIdentity)
      : null,
    tesseraUiIdentity: provenance.tesseraUiIdentity,
    providerCompatibilitySha256:
      provenance.providerCompatibilitySha256,
    sourceAttempt,
  };
}

function assertSimulationProviderPinMatchesResult(
  pin: TesseraRunSimulationProviderPin | null | undefined,
  provenance: ReturnType<typeof reportProvenance>,
): void {
  if (!pin || !provenance.simulationBackend) return;
  if (pin.selectedBackend !== provenance.simulationBackend) {
    throw jobError(
      "TESSERA_SIMULATION_PROVIDER_CHANGED",
      `The durable simulation stage is pinned to ${pin.selectedBackend}, but this attempt returned ${provenance.simulationBackend}. Use restart-from to begin a new simulation stage.`,
    );
  }
  if (
    pin.providerIdentity &&
    (
      !provenance.simulationProviderIdentity ||
      canonicalSha256(pin.providerIdentity) !==
        canonicalSha256(provenance.simulationProviderIdentity)
    )
  ) {
    throw jobError(
      "TESSERA_SIMULATION_PROVIDER_CHANGED",
      "The immutable Tessera provider identity changed within a durable simulation stage. Use restart-from before accepting evidence from the new provider identity.",
    );
  }
  if (
    pin.tesseraUiIdentity &&
    (
      !provenance.tesseraUiIdentity ||
      pin.tesseraUiIdentity !== provenance.tesseraUiIdentity
    )
  ) {
    throw jobError(
      "TESSERA_SIMULATION_PROVIDER_CHANGED",
      "The Tessera website identity changed within a durable simulation stage. Use restart-from before accepting evidence from the new website identity.",
    );
  }
  if (
    pin.providerCompatibilitySha256 &&
    (
      !provenance.providerCompatibilitySha256 ||
      pin.providerCompatibilitySha256 !==
        provenance.providerCompatibilitySha256
    )
  ) {
    throw jobError(
      "TESSERA_SIMULATION_PROVIDER_CHANGED",
      "The complete provider-compatibility envelope changed within a durable simulation stage. Use restart-from before accepting evidence from the new data/provider/import identity.",
    );
  }
}

function inferredSimulationProviderPin(
  history: TesseraRunAttemptProvenance[],
): TesseraRunSimulationProviderPin | null {
  const source = [...history]
    .reverse()
    .find(
      (entry) =>
        entry.simulationBackend !== null &&
        entry.simulationBackend !== undefined,
    );
  if (!source?.simulationBackend) return null;
  const providerIdentity =
    source.simulationProviderIdentity ?? null;
  return {
    selectedBackend: source.simulationBackend,
    providerIdentity,
    providerIdentitySha256: providerIdentity
      ? canonicalSha256(providerIdentity)
      : null,
    tesseraUiIdentity: source.tesseraUiIdentity,
    providerCompatibilitySha256:
      source.providerCompatibilitySha256 ?? null,
    sourceAttempt: source.attempt,
  };
}

function exactReportsFromResult(
  result: TesseraRunResult,
): TesseraMatchupReport[] {
  const data =
    result.data && typeof result.data === "object"
      ? result.data as Record<string, unknown>
      : null;
  if (!data) return [];
  const reports: TesseraMatchupReport[] = [];
  const exact = exactMatchupReport(result);
  if (exact) reports.push(exact);
  if (Array.isArray(data.revisedReports)) {
    for (const candidate of data.revisedReports) {
      if (
        candidate &&
        typeof candidate === "object" &&
        "player" in candidate &&
        "opponents" in candidate &&
        Array.isArray(
          (candidate as Record<string, unknown>).opponents,
        )
      ) {
        reports.push(candidate as TesseraMatchupReport);
      }
    }
  }
  return reports;
}

function exactMatchupReport(
  result: TesseraRunResult,
): TesseraMatchupReport | null {
  const data =
    result.data && typeof result.data === "object"
      ? result.data as Record<string, unknown>
      : null;
  if (!data) return null;
  const candidate =
    data.matchupReport &&
    typeof data.matchupReport === "object"
      ? data.matchupReport
      : data;
  return (
      candidate &&
      typeof candidate === "object" &&
      "player" in candidate &&
      "opponents" in candidate &&
      Array.isArray(candidate.opponents)
    )
    ? candidate as TesseraMatchupReport
    : null;
}

function exactOutputDirectory(
  request: TesseraRunRequest,
): string | null {
  if (request.kind === "exact") {
    return request.options?.outputDirectory ?? null;
  }
  if (request.kind === "build-and-analyze") {
    return (
      request.input.outputDirectory ??
      request.options?.outputDirectory ??
      null
    );
  }
  return null;
}

async function preparedCheckpointFromResult(
  document: TesseraRunJobDocument,
  result: TesseraRunResult,
): Promise<TesseraRunPreparedCheckpoint | null> {
  if (
    document.runKind !== "exact" &&
    document.runKind !== "build-and-analyze"
  ) {
    return null;
  }
  const report = exactMatchupReport(result);
  const outputDirectory = exactOutputDirectory(document.request);
  const opponent = report?.opponents[0];
  if (
    !report ||
    !outputDirectory ||
    !report.player.fingerprint ||
    !report.player.sourceRoszSha256 ||
    !report.player.enrichedRoszSha256
  ) {
    return document.preparedCheckpoint;
  }
  const absolute = (filename: string): string =>
    path.isAbsolute(filename)
      ? filename
      : path.resolve(outputDirectory, filename);
  const player: TesseraPreparedRoster = {
    ...report.player,
    listUrl: null,
    sourceRoszPath: absolute(report.player.sourceRoszPath),
    enrichedRoszPath: absolute(
      report.player.enrichedRoszPath,
    ),
    ...(report.player.simulationInput?.kind ===
    "rosterpilot-local-engine-input"
      ? {
          simulationInput: {
            ...report.player.simulationInput,
            path: absolute(report.player.enrichedRoszPath),
          },
        }
      : {}),
    cacheReused: true,
    connectorEvents: [],
  };
  let preparedOpponent: TesseraPreparedRoster | null = null;
  if (
    opponent?.sourceRoszPath &&
    opponent.sourceRoszSha256 &&
    opponent.enrichedRoszSha256 &&
    opponent.fingerprint
  ) {
    preparedOpponent = {
      rosterId: opponent.fingerprint,
      rosterName: opponent.rosterName,
      factionId:
        document.request.kind === "exact" &&
        document.request.opponent.kind === "roster"
          ? document.request.opponent.roster.factionId
          : document.request.kind === "build-and-analyze"
            ? document.request.input.opponentRoster.factionId
            : undefined,
      listUrl: null,
      sourceRoszPath: absolute(opponent.sourceRoszPath),
      enrichedRoszPath: absolute(
        opponent.enrichedRoszPath,
      ),
      sourceRoszSha256: opponent.sourceRoszSha256,
      enrichedRoszSha256: opponent.enrichedRoszSha256,
      simulationInput: opponent.simulationInput,
      summary: opponent.summary,
      fingerprint: opponent.fingerprint,
      units: opponent.units,
      cacheReused: true,
      connectorEvents: [],
      catalogueProvenance:
        opponent.catalogueProvenance,
      constraints:
        document.request.kind === "exact" &&
        document.request.opponent.kind === "roster"
          ? document.request.opponent.roster.constraints
          : document.request.kind === "build-and-analyze"
            ? document.request.input.opponentRoster.constraints
            : undefined,
      ...(opponent.simulationInput?.kind ===
      "rosterpilot-local-engine-input"
        ? {
            simulationInput: {
              ...opponent.simulationInput,
              path: absolute(opponent.enrichedRoszPath),
            },
          }
        : {}),
    };
  }
  const checkpoint: TesseraRunPreparedCheckpoint = {
    sourceAttempt: document.attempt,
    player,
    opponent: preparedOpponent,
  };
  for (const prepared of [
    checkpoint.player,
    checkpoint.opponent,
  ].filter(
    (candidate): candidate is TesseraPreparedRoster =>
      candidate !== null,
  )) {
    for (const [filename, expectedSha256] of [
      [prepared.sourceRoszPath, prepared.sourceRoszSha256],
      [
        prepared.enrichedRoszPath,
        prepared.enrichedRoszSha256,
      ],
    ] as const) {
      if (!expectedSha256) return document.preparedCheckpoint;
      const resolved =
        await assertFilesystemPathInsideJob(
          document.jobDirectory,
          filename,
          "Prepared exact-run checkpoint",
        );
      const metadata = await lstat(resolved);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (await fileSha256(resolved)) !== expectedSha256
      ) {
        throw jobError(
          "TESSERA_PREPARED_ARTIFACT_DRIFT",
          "A prepared exact-run checkpoint changed before it could be frozen.",
        );
      }
    }
  }
  return checkpoint;
}

async function copyPreparedCheckpointForRestart(
  checkpoint: TesseraRunPreparedCheckpoint,
  destinationJobDirectory: string,
): Promise<TesseraRunPreparedCheckpoint> {
  const copyPrepared = async (
    role: "player" | "opponent",
    prepared: TesseraPreparedRoster,
  ): Promise<TesseraPreparedRoster> => {
    const copyArchive = async (
      kind: "source" | "enriched",
      filename: string,
      expectedSha256: string | undefined,
    ): Promise<string> => {
      if (!expectedSha256 || !sha256Pattern.test(expectedSha256)) {
        throw jobError(
          "TESSERA_PREPARED_ARTIFACT_DRIFT",
          `The ${role} ${kind} checkpoint is missing its content hash.`,
        );
      }
      const content = await readFile(filename);
      if (contentSha256(content) !== expectedSha256) {
        throw jobError(
          "TESSERA_PREPARED_ARTIFACT_DRIFT",
          `The ${role} ${kind} checkpoint changed before restart-from.`,
        );
      }
      const destination = path.join(
        destinationJobDirectory,
        "artifacts",
        "prepared",
        `${role}-${kind}-${expectedSha256}.${
          prepared.simulationInput?.kind ===
          "rosterpilot-local-engine-input"
            ? "json"
            : "rosz"
        }`,
      );
      await mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      try {
        await writeFile(destination, content, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      if ((await fileSha256(destination)) !== expectedSha256) {
        throw jobError(
          "TESSERA_PREPARED_ARTIFACT_DRIFT",
          `The copied ${role} ${kind} checkpoint failed verification.`,
        );
      }
      return destination;
    };
    const [sourceRoszPath, enrichedRoszPath] =
      await Promise.all([
        copyArchive(
          "source",
          prepared.sourceRoszPath,
          prepared.sourceRoszSha256,
        ),
        copyArchive(
          "enriched",
          prepared.enrichedRoszPath,
          prepared.enrichedRoszSha256,
        ),
      ]);
    return {
      ...prepared,
      listUrl: null,
      sourceRoszPath,
      enrichedRoszPath,
      ...(prepared.simulationInput?.kind ===
      "rosterpilot-local-engine-input"
        ? {
            simulationInput: {
              ...prepared.simulationInput,
              path: enrichedRoszPath,
              sha256: prepared.enrichedRoszSha256!,
            },
          }
        : {}),
      cacheReused: true,
      connectorEvents: [],
    };
  };
  return {
    sourceAttempt: 1,
    player: await copyPrepared("player", checkpoint.player),
    opponent: checkpoint.opponent
      ? await copyPrepared("opponent", checkpoint.opponent)
      : null,
  };
}

async function writeJsonAtomic(
  filename: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(value, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await rename(temporary, filename);
}

function assertPathInsideJob(
  jobDirectory: string,
  candidate: string,
  label: string,
): string {
  const resolved = path.resolve(candidate);
  if (!pathInside(jobDirectory, resolved)) {
    throw jobError(
      "TESSERA_JOB_PATH_INVALID",
      `${label} must remain inside the Tessera run directory.`,
    );
  }
  return resolved;
}

async function filesystemPathInside(
  root: string,
  candidate: string,
): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const physicalRoot = await realpath(resolvedRoot);
  let existingAncestor = resolvedCandidate;
  while (true) {
    try {
      const physicalAncestor = await realpath(existingAncestor);
      const unresolvedSuffix = path.relative(
        existingAncestor,
        resolvedCandidate,
      );
      return pathInside(
        physicalRoot,
        path.resolve(physicalAncestor, unresolvedSuffix),
      );
    } catch (error) {
      if (
        errorCode(error) !== "ENOENT" &&
        errorCode(error) !== "ENOTDIR"
      ) {
        throw error;
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return false;
      existingAncestor = parent;
    }
  }
}

async function assertFilesystemPathInsideJob(
  jobDirectory: string,
  candidate: string,
  label: string,
): Promise<string> {
  const resolved = assertPathInsideJob(
    jobDirectory,
    candidate,
    label,
  );
  if (!(await filesystemPathInside(jobDirectory, resolved))) {
    throw jobError(
      "TESSERA_JOB_PATH_INVALID",
      `${label} resolves outside the Tessera run directory.`,
    );
  }
  return resolved;
}

function requestPathEntries(
  request: TesseraRunRequest,
): Array<{
  label: string;
  value: string | undefined;
  kind:
    | "output"
    | "profile-policy"
    | "opponent-rosz"
    | "manifest"
    | "baseline-report"
    | "root";
}> {
  if (request.kind === "exact") {
    return [
      {
        label: "Exact output directory",
        value: request.options?.outputDirectory,
        kind: "output",
      },
      {
        label: "Exact write root",
        value: request.options?.rootDir,
        kind: "root",
      },
      {
        label: "Exact profile policy",
        value: request.options?.profilePolicyPath,
        kind: "profile-policy",
      },
      ...(request.opponent.kind === "rosz"
        ? [
            {
              label: "Exact opponent ROSZ",
              value: request.opponent.path,
              kind: "opponent-rosz" as const,
            },
          ]
        : []),
    ];
  }
  if (request.kind === "stress") {
    return [
      {
        label: "Stress output directory",
        value: request.options?.outputDirectory,
        kind: "output",
      },
      {
        label: "Stress write root",
        value: request.options?.rootDir,
        kind: "root",
      },
      {
        label: "Stress profile policy",
        value: request.options?.profilePolicyPath,
        kind: "profile-policy",
      },
      {
        label: "Stress resume manifest",
        value: request.options?.resumeManifestPath,
        kind: "manifest",
      },
      {
        label: "Stress restart manifest",
        value: request.options?.restartManifestPath,
        kind: "manifest",
      },
    ];
  }
  if (request.kind === "build-and-stress") {
    return [
      {
        label: "Build-and-stress input output directory",
        value: request.input.outputDirectory,
        kind: "output",
      },
      {
        label: "Build-and-stress option output directory",
        value: request.options?.outputDirectory,
        kind: "output",
      },
      {
        label: "Build-and-stress write root",
        value: request.options?.rootDir,
        kind: "root",
      },
      {
        label: "Build-and-stress input profile policy",
        value: request.input.profilePolicyPath,
        kind: "profile-policy",
      },
      {
        label: "Build-and-stress option profile policy",
        value: request.options?.profilePolicyPath,
        kind: "profile-policy",
      },
      {
        label: "Build-and-stress input resume manifest",
        value: request.input.resumeManifestPath,
        kind: "manifest",
      },
      {
        label: "Build-and-stress option resume manifest",
        value: request.options?.resumeManifestPath,
        kind: "manifest",
      },
      {
        label: "Build-and-stress input restart manifest",
        value: request.input.restartManifestPath,
        kind: "manifest",
      },
      {
        label: "Build-and-stress option restart manifest",
        value: request.options?.restartManifestPath,
        kind: "manifest",
      },
    ];
  }
  if (
    request.kind === "exact-revision" ||
    request.kind === "stress-revision"
  ) {
    return [
      {
        label: "Paired-revision output directory",
        value: request.options?.outputDirectory,
        kind: "output",
      },
      {
        label: "Paired-revision write root",
        value: request.options?.rootDir,
        kind: "root",
      },
      {
        label: "Paired-revision profile policy",
        value: request.options?.profilePolicyPath,
        kind: "profile-policy",
      },
      {
        label: "Frozen paired-revision baseline",
        value: request.baselineReportPath,
        kind: "baseline-report",
      },
    ];
  }
  return [
    {
      label: "Build-and-analyze input output directory",
      value: request.input.outputDirectory,
      kind: "output",
    },
    {
      label: "Build-and-analyze option output directory",
      value: request.options?.outputDirectory,
      kind: "output",
    },
    {
      label: "Build-and-analyze write root",
      value: request.options?.rootDir,
      kind: "root",
    },
    {
      label: "Build-and-analyze input profile policy",
      value: request.input.profilePolicyPath,
      kind: "profile-policy",
    },
    {
      label: "Build-and-analyze option profile policy",
      value: request.options?.profilePolicyPath,
      kind: "profile-policy",
    },
  ];
}

function requestPreparedReuse(
  request: TesseraRunRequest,
): TesseraAnalysisOptions["preparedReuse"] | undefined {
  if (
    request.kind === "exact" ||
    request.kind === "build-and-analyze"
  ) {
    return request.options?.preparedReuse;
  }
  return undefined;
}

function stripSerializedAnalysisCapabilities(
  request: TesseraRunRequest,
): TesseraRunRequest {
  const stripped = structuredClone(request);
  if (stripped.options) {
    const options = stripped.options as unknown as
      Record<string, unknown>;
    delete options.uploadedArtifactProvenanceVerified;
    delete options.verifiedUploadedArtifactCapability;
  }
  return stripped;
}

async function validateJobDocumentPaths(
  document: TesseraRunJobDocument,
  actualJobPath: string,
  verifyInputs: boolean,
  verifyArtifacts = verifyInputs,
): Promise<void> {
  const jobDirectory = path.dirname(actualJobPath);
  if (
    path.resolve(document.jobDirectory) !== jobDirectory ||
    path.resolve(document.rootDirectory) !== jobDirectory ||
    path.resolve(document.requestPath) !== actualJobPath ||
    path.resolve(jobPathFor(document)) !== actualJobPath
  ) {
    throw jobError(
      "TESSERA_JOB_PATH_INVALID",
      "The Tessera job identity or write root was changed.",
    );
  }
  await assertFilesystemPathInsideJob(
    jobDirectory,
    actualJobPath,
    "Job path",
  );
  await assertFilesystemPathInsideJob(
    jobDirectory,
    document.resultPath,
    "Result path",
  );
  if (document.manifestPath) {
    await assertFilesystemPathInsideJob(
      jobDirectory,
      document.manifestPath,
      "Manifest path",
    );
  }
  if (document.profilePolicyPath) {
    await assertFilesystemPathInsideJob(
      jobDirectory,
      document.profilePolicyPath,
      "Profile-policy path",
    );
  }
  const inputByPath = new Map<string, TesseraRunInputArtifact>();
  const writeOptions = [document.request.options];
  if (
    writeOptions.some(
      (options) => options?.allowOutsideRoot === true,
    )
  ) {
    throw jobError(
      "TESSERA_JOB_PATH_INVALID",
      "Durable Tessera jobs cannot enable writes outside their run directory.",
    );
  }
  for (const artifact of document.inputArtifacts) {
    const artifactPath = await assertFilesystemPathInsideJob(
      path.join(jobDirectory, "inputs"),
      artifact.path,
      "Frozen input path",
    );
    if (
      artifact.filename !== path.basename(artifactPath) ||
      !sha256Pattern.test(artifact.sha256)
    ) {
      throw jobError(
        "TESSERA_JOB_INPUT_INVALID",
        "A frozen Tessera input receipt is malformed.",
      );
    }
    inputByPath.set(artifactPath, artifact);
    if (verifyInputs) {
      let metadata;
      try {
        metadata = await lstat(artifactPath);
      } catch {
        throw jobError(
          "TESSERA_INPUT_ARTIFACT_CHANGED",
          `Frozen input ${artifact.filename} is missing.`,
        );
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (await fileSha256(artifactPath)) !== artifact.sha256
      ) {
        throw jobError(
          "TESSERA_INPUT_ARTIFACT_CHANGED",
          `Frozen input ${artifact.filename} no longer matches its receipt.`,
        );
      }
    }
  }
  for (const entry of requestPathEntries(document.request)) {
    if (!entry.value) continue;
    const resolved = await assertFilesystemPathInsideJob(
      jobDirectory,
      entry.value,
      entry.label,
    );
    if (entry.kind === "root" && resolved !== jobDirectory) {
      throw jobError(
        "TESSERA_JOB_PATH_INVALID",
        `${entry.label} must equal the run directory.`,
      );
    }
    if (
      entry.kind === "profile-policy" ||
      entry.kind === "opponent-rosz" ||
      entry.kind === "baseline-report"
    ) {
      const receipt = inputByPath.get(resolved);
      const expectedKind =
        entry.kind === "profile-policy"
          ? "profile-policy"
          : entry.kind === "opponent-rosz"
            ? "opponent-rosz"
            : "baseline-report";
      if (!receipt || receipt.kind !== expectedKind) {
        throw jobError(
          "TESSERA_JOB_INPUT_INVALID",
          `${entry.label} is not backed by a frozen input receipt.`,
        );
      }
    }
  }
  if (document.profilePolicyPath) {
    const receipt = inputByPath.get(
      path.resolve(document.profilePolicyPath),
    );
    if (!receipt || receipt.kind !== "profile-policy") {
      throw jobError(
        "TESSERA_JOB_INPUT_INVALID",
        "The active profile policy is not a frozen job input.",
      );
    }
  }
  if (
    document.requestSha256 !==
      canonicalSha256(document.request) ||
    document.dataPinSha256 !==
      canonicalSha256(document.dataPins) ||
    canonicalSha256(document.dataPins) !==
      canonicalSha256(dataPinsForRequest(document.request)) ||
    document.profilePolicySha256 !==
      profilePolicySha256For(
        document.profilePolicyPath,
        document.inputArtifacts,
      ) ||
    document.scenarioContractSha256 !==
      requestScenarioContractSha256(document.request) ||
    document.runtimeIdentitySha256 !==
      runtimeIdentitySha256(document.runtimeProvenance) ||
    !Number.isInteger(document.simulationStage) ||
    document.simulationStage < 1
  ) {
    throw jobError(
      "TESSERA_JOB_PROVENANCE_CHANGED",
      "The Tessera request, data pin, profile policy, scenario contract, runtime, or simulation-stage provenance changed.",
    );
  }
  const expectedBudget = retryBudgetFor(
    document.attempt,
    document.status,
  );
  if (
    canonicalSha256(document.retryBudget) !==
    canonicalSha256(expectedBudget)
  ) {
    throw jobError(
      "TESSERA_JOB_RETRY_BUDGET_CHANGED",
      "The Tessera retry budget no longer matches its attempt history.",
    );
  }
  const currentAttempt = document.attemptHistory.find(
    (entry) => entry.attempt === document.attempt,
  );
  for (const entry of document.attemptHistory) {
    if (
      entry.simulationBackend !== null &&
      entry.simulationBackend !== undefined &&
      entry.simulationBackend !== "local-engine" &&
      entry.simulationBackend !== "website"
    ) {
      throw jobError(
        "TESSERA_JOB_ATTEMPT_HISTORY_CHANGED",
        "A Tessera attempt contains an invalid selected simulation backend.",
      );
    }
    const providerIdentity = parsedSimulationProviderIdentity(
      entry.simulationProviderIdentity,
    );
    if (
      providerIdentity &&
      entry.simulationBackend !== providerIdentity.provider
    ) {
      throw jobError(
        "TESSERA_JOB_ATTEMPT_HISTORY_CHANGED",
        "A Tessera attempt's selected backend does not match its provider identity.",
      );
    }
  }
  if (
    !currentAttempt ||
    document.attemptHistory.some(
      (entry, index, history) =>
        !Number.isInteger(entry.attempt) ||
        entry.attempt < 1 ||
        history.findIndex(
          (candidate) => candidate.attempt === entry.attempt,
        ) !== index ||
        !Number.isInteger(entry.simulationStage) ||
        entry.simulationStage < 1 ||
        !sha256Pattern.test(entry.requestSha256) ||
        !sha256Pattern.test(entry.dataPinSha256) ||
        (
          entry.profilePolicySha256 !== null &&
          !sha256Pattern.test(entry.profilePolicySha256)
        ) ||
        !sha256Pattern.test(entry.runtimeIdentitySha256) ||
        entry.runtimeIdentitySha256 !==
          runtimeIdentitySha256(entry.runtime) ||
        (
          entry.resultSha256 !== null &&
          !sha256Pattern.test(entry.resultSha256)
        ) ||
        (
          entry.manifestSha256 !== null &&
          !sha256Pattern.test(entry.manifestSha256)
        ) ||
        (
          entry.providerCompatibilitySha256 !== null &&
          !sha256Pattern.test(
            entry.providerCompatibilitySha256,
          )
        ),
    ) ||
    currentAttempt.status !== document.status ||
    currentAttempt.simulationStage !==
      document.simulationStage ||
    currentAttempt.requestSha256 !==
      document.requestSha256 ||
    currentAttempt.dataPinSha256 !==
      document.dataPinSha256 ||
    currentAttempt.profilePolicySha256 !==
      document.profilePolicySha256
  ) {
    throw jobError(
      "TESSERA_JOB_ATTEMPT_HISTORY_CHANGED",
      "The Tessera attempt provenance is incomplete or inconsistent.",
    );
  }
  if (document.simulationProviderPin) {
    const pin = document.simulationProviderPin;
    const providerIdentity = parsedSimulationProviderIdentity(
      pin.providerIdentity,
    );
    const sourceAttempt = document.attemptHistory.find(
      (entry) => entry.attempt === pin.sourceAttempt,
    );
    if (
      (pin.selectedBackend !== "local-engine" &&
        pin.selectedBackend !== "website") ||
      !Number.isInteger(pin.sourceAttempt) ||
      pin.sourceAttempt < 1 ||
      pin.sourceAttempt > document.attempt ||
      !sourceAttempt ||
      sourceAttempt.simulationBackend !== pin.selectedBackend ||
      (
        providerIdentity !== null &&
        providerIdentity.provider !== pin.selectedBackend
      ) ||
      (
        providerIdentity === null
          ? pin.providerIdentitySha256 !== null
          : pin.providerIdentitySha256 !==
            canonicalSha256(providerIdentity)
      ) ||
      canonicalSha256(
        sourceAttempt.simulationProviderIdentity ?? null,
      ) !== canonicalSha256(providerIdentity) ||
      sourceAttempt.tesseraUiIdentity !== pin.tesseraUiIdentity ||
      (
        pin.providerCompatibilitySha256 !== null &&
        !sha256Pattern.test(pin.providerCompatibilitySha256)
      ) ||
      sourceAttempt.providerCompatibilitySha256 !==
        pin.providerCompatibilitySha256
    ) {
      throw jobError(
        "TESSERA_JOB_PROVIDER_PIN_CHANGED",
        "The durable Tessera simulation-provider pin no longer matches its source attempt.",
      );
    }
  }
  if (
    document.restartFrom &&
    (
      typeof document.restartFrom.runId !== "string" ||
      !Number.isInteger(document.restartFrom.attempt) ||
      document.restartFrom.attempt < 1 ||
      !Number.isInteger(
        document.restartFrom.simulationStage,
      ) ||
      document.restartFrom.simulationStage < 1 ||
      !sha256Pattern.test(document.restartFrom.jobSha256)
    )
  ) {
    throw jobError(
      "TESSERA_JOB_RESTART_PROVENANCE_CHANGED",
      "The Tessera restart-from receipt is malformed.",
    );
  }
  for (const receipt of document.artifactReceipts) {
    if (
      path.isAbsolute(receipt.path) ||
      receipt.path.length === 0 ||
      !Number.isInteger(receipt.attempt) ||
      receipt.attempt < 1 ||
      !sha256Pattern.test(receipt.sha256)
    ) {
      throw jobError(
        "TESSERA_JOB_ARTIFACT_CHANGED",
        "A Tessera artifact receipt is malformed.",
      );
    }
    const artifactPath = await assertFilesystemPathInsideJob(
      jobDirectory,
      path.join(jobDirectory, receipt.path),
      `${receipt.kind} artifact`,
    );
    if (
      verifyArtifacts &&
      !(
        document.status === "running" &&
        receipt.kind === "workflow-manifest"
      )
    ) {
      let matches = false;
      try {
        const metadata = await lstat(artifactPath);
        matches =
          metadata.isFile() &&
          !metadata.isSymbolicLink() &&
          (await fileSha256(artifactPath)) === receipt.sha256;
      } catch {
        matches = false;
      }
      if (!matches) {
        throw jobError(
          "TESSERA_JOB_ARTIFACT_CHANGED",
          `The retained ${receipt.kind} artifact changed after it was recorded.`,
        );
      }
    }
  }
  if (document.preparedCheckpoint) {
    if (
      !Number.isInteger(
        document.preparedCheckpoint.sourceAttempt,
      ) ||
      document.preparedCheckpoint.sourceAttempt < 1 ||
      document.preparedCheckpoint.sourceAttempt >
        document.attempt
    ) {
      throw jobError(
        "TESSERA_PREPARED_ARTIFACT_DRIFT",
        "The exact-run prepared checkpoint has invalid attempt provenance.",
      );
    }
    for (const prepared of [
      document.preparedCheckpoint.player,
      document.preparedCheckpoint.opponent,
    ].filter(
      (candidate): candidate is TesseraPreparedRoster =>
        candidate !== null,
    )) {
      if (
        !prepared.fingerprint ||
        !sha256Pattern.test(prepared.fingerprint) ||
        !prepared.sourceRoszSha256 ||
        !sha256Pattern.test(prepared.sourceRoszSha256) ||
        !prepared.enrichedRoszSha256 ||
        !sha256Pattern.test(prepared.enrichedRoszSha256)
      ) {
        throw jobError(
          "TESSERA_PREPARED_ARTIFACT_DRIFT",
          "The exact-run prepared checkpoint is missing a frozen roster or archive identity.",
        );
      }
      for (const [label, filename, expectedSha256] of [
        [
          "source",
          prepared.sourceRoszPath,
          prepared.sourceRoszSha256,
        ],
        [
          "enriched",
          prepared.enrichedRoszPath,
          prepared.enrichedRoszSha256,
        ],
      ] as const) {
        const preparedPath =
          await assertFilesystemPathInsideJob(
            jobDirectory,
            filename,
            `Prepared ${label} roster artifact`,
          );
        if (verifyArtifacts) {
          let matches = false;
          try {
            const metadata = await lstat(preparedPath);
            matches =
              metadata.isFile() &&
              !metadata.isSymbolicLink() &&
              (await fileSha256(preparedPath)) === expectedSha256;
          } catch {
            matches = false;
          }
          if (!matches) {
            throw jobError(
              "TESSERA_PREPARED_ARTIFACT_DRIFT",
              `The retained prepared ${label} roster artifact changed after it was recorded.`,
            );
          }
        }
      }
    }
    const requestedReuse = requestPreparedReuse(document.request);
    if (
      (document.status === "queued" ||
        document.status === "running") &&
      (
        !requestedReuse ||
        canonicalSha256(requestedReuse) !==
          canonicalSha256({
            player: document.preparedCheckpoint.player,
            opponent:
              document.preparedCheckpoint.opponent,
            sourceAttempt:
              document.preparedCheckpoint.sourceAttempt,
          })
      )
    ) {
      throw jobError(
        "TESSERA_PREPARED_ARTIFACT_DRIFT",
        "The active exact-run request does not match its frozen prepared checkpoint.",
      );
    }
  }
  if (document.profileResolution?.scaffoldPath) {
    const scaffoldPath = await assertFilesystemPathInsideJob(
      jobDirectory,
      document.profileResolution.scaffoldPath,
      "Profile scaffold path",
    );
    if (
      !document.profileResolution.scaffoldSha256 ||
      !sha256Pattern.test(
        document.profileResolution.scaffoldSha256,
      )
    ) {
      throw jobError(
        "TESSERA_PROFILE_SCAFFOLD_CHANGED",
        "The retained profile scaffold has no valid content receipt.",
      );
    }
    if (verifyArtifacts) {
      let scaffoldMatches = false;
      try {
        const metadata = await lstat(scaffoldPath);
        scaffoldMatches =
          metadata.isFile() &&
          !metadata.isSymbolicLink() &&
          (await fileSha256(scaffoldPath)) ===
            document.profileResolution.scaffoldSha256;
      } catch {
        scaffoldMatches = false;
      }
      if (!scaffoldMatches) {
        throw jobError(
          "TESSERA_PROFILE_SCAFFOLD_CHANGED",
          "The retained profile scaffold changed after the run paused.",
        );
      }
    }
  }
}

async function readJobDocument(
  jobPath: string,
  options: {
    verifyInputs?: boolean;
    verifyArtifacts?: boolean;
  } = {},
): Promise<TesseraRunJobDocument> {
  const resolvedJobPath = path.resolve(jobPath);
  const parsed = JSON.parse(
    await readFile(resolvedJobPath, "utf8"),
  ) as TesseraRunJobDocument;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.jobKind !== "rosterpilot-tessera-run" ||
    typeof parsed.runId !== "string" ||
    !parsed.request ||
    parsed.runKind !== parsed.request.kind ||
    typeof parsed.jobDirectory !== "string" ||
    typeof parsed.requestPath !== "string" ||
    typeof parsed.resultPath !== "string" ||
    ![
      "queued",
      "running",
      "needs-input",
      "complete",
      "degraded",
      "inconclusive",
      "failed",
      "cancelled",
    ].includes(parsed.status) ||
    !Number.isInteger(parsed.attempt) ||
    parsed.attempt < 1 ||
    (
      parsed.workerPid !== null &&
      (
        !Number.isInteger(parsed.workerPid) ||
        parsed.workerPid <= 0
      )
    )
  ) {
    throw jobError(
      "TESSERA_JOB_MALFORMED",
      "The Tessera run job is malformed.",
    );
  }
  parsed.rootDirectory ??= parsed.jobDirectory;
  parsed.workerTokenSha256 ??= null;
  parsed.inputArtifacts ??= [];
  parsed.timingSpans ??= [];
  parsed.journalReference ??= null;
  parsed.reliabilityWarnings ??= [];
  parsed.profileResolution ??= null;
  parsed.requestSha256 ??= canonicalSha256(parsed.request);
  parsed.dataPins ??= dataPinsForRequest(parsed.request);
  parsed.dataPinSha256 ??= canonicalSha256(parsed.dataPins);
  parsed.profilePolicySha256 ??=
    profilePolicySha256For(
      parsed.profilePolicyPath,
      parsed.inputArtifacts,
    );
  parsed.scenarioContractSha256 ??=
    requestScenarioContractSha256(parsed.request);
  parsed.artifactReceipts ??= [];
  parsed.preparedCheckpoint ??= null;
  parsed.runtimeProvenance ??= getRuntimeProvenance();
  parsed.runtimeIdentitySha256 ??=
    runtimeIdentitySha256(parsed.runtimeProvenance);
  parsed.simulationStage ??= 1;
  parsed.restartFrom ??= null;
  parsed.retryBudget ??= retryBudgetFor(
    parsed.attempt,
    parsed.status,
  );
  parsed.attemptHistory ??= [
    {
      ...attemptProvenance({
        attempt: parsed.attempt,
        simulationStage: parsed.simulationStage,
        trigger: parsed.attempt === 1 ? "start" : "resume",
        status: parsed.status,
        at: parsed.createdAt,
        requestSha256: parsed.requestSha256,
        dataPinSha256: parsed.dataPinSha256,
        profilePolicySha256: parsed.profilePolicySha256,
        runtime: parsed.runtimeProvenance,
      }),
      startedAt: parsed.startedAt,
      completedAt: parsed.completedAt,
      errorCode: parsed.error?.code ?? null,
    },
  ];
  for (const entry of parsed.attemptHistory) {
    entry.providerCompatibilitySha256 ??= null;
    const providerIdentity = parsedSimulationProviderIdentity(
      entry.simulationProviderIdentity,
    );
    entry.simulationProviderIdentity = providerIdentity;
    entry.simulationBackend ??=
      providerIdentity?.provider ??
      (entry.tesseraUiIdentity ? "website" : null);
  }
  if (parsed.simulationProviderPin) {
    parsed.simulationProviderPin.providerCompatibilitySha256 ??= null;
  } else {
    parsed.simulationProviderPin = inferredSimulationProviderPin(
      parsed.attemptHistory,
    );
  }
  if (
    parsed.profileResolution &&
    !Array.isArray(parsed.profileResolution.requirements)
  ) {
    parsed.profileResolution.requirements = [];
  }
  if (
    !Array.isArray(parsed.inputArtifacts) ||
    !Array.isArray(parsed.dataPins) ||
    !Array.isArray(parsed.artifactReceipts) ||
    !Array.isArray(parsed.attemptHistory) ||
    !Array.isArray(parsed.timingSpans) ||
    !Array.isArray(parsed.reliabilityWarnings) ||
    typeof parsed.rootDirectory !== "string" ||
    !parsed.runtimeProvenance ||
    typeof parsed.runtimeProvenance !== "object"
  ) {
    throw jobError(
      "TESSERA_JOB_MALFORMED",
      "The Tessera input receipts or write root are malformed.",
    );
  }
  if (
    parsed.workerTokenSha256 !== null &&
    !sha256Pattern.test(parsed.workerTokenSha256)
  ) {
    throw jobError(
      "TESSERA_JOB_MALFORMED",
      "The Tessera worker identity is malformed.",
    );
  }
  await validateJobDocumentPaths(
    parsed,
    resolvedJobPath,
    options.verifyInputs !== false,
    options.verifyArtifacts ??
      options.verifyInputs !== false,
  );
  return parsed;
}

function jobPathFor(job: TesseraRunJob): string {
  return path.join(job.jobDirectory, "tessera-run.json");
}

function lockPathFor(job: TesseraRunJob): string {
  return path.join(job.jobDirectory, "worker.lock");
}

type WorkerReservation = {
  runId: string;
  attempt: number;
  jobPath: string;
  tokenSha256: string;
  pid: number | null;
  processStartedAt: string | null;
  reservedAt: string;
};

type ControlLease = {
  token: string;
  pid: number;
  acquiredAt: string;
  processStartedAt: string | null;
};

type TesseraJobProcessDependencies = {
  processCommand?: (pid: number) => Promise<string | null>;
  processStartIdentity?: (
    pid: number,
  ) => Promise<string | null>;
};

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function processCommand(pid: number): Promise<string | null> {
  if (!processExists(pid)) return null;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "command="],
      { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function processStartIdentity(
  pid: number,
): Promise<string | null> {
  if (!processExists(pid)) return null;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "lstart="],
      { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function workerProcessMatches(
  pid: number,
  jobPath: string,
  tokenSha256: string,
  expectedProcessStart: string | null,
  dependencies: TesseraJobProcessDependencies = {},
): Promise<"matched" | "not-running" | "mismatched" | "unverifiable"> {
  if (!processExists(pid)) return "not-running";
  const [command, liveProcessStart] = await Promise.all([
    (dependencies.processCommand ?? processCommand)(pid),
    expectedProcessStart
      ? (
          dependencies.processStartIdentity ??
          processStartIdentity
        )(pid)
      : Promise.resolve(null),
  ]);
  if (!command) return "unverifiable";
  if (
    expectedProcessStart &&
    (
      !liveProcessStart ||
      liveProcessStart !== expectedProcessStart
    )
  ) {
    return liveProcessStart ? "mismatched" : "unverifiable";
  }
  const workerPath = path.join(
    projectRoot,
    "local",
    "tessera",
    "job-worker.ts",
  );
  const tokenMatches = (
    command.match(/\b[0-9a-f]{64}\b/g) ?? []
  ).some((candidate) => contentSha256(candidate) === tokenSha256);
  return (
    command.includes(workerPath) &&
    command.includes(jobPath) &&
    tokenMatches
  )
    ? "matched"
    : "mismatched";
}

async function readWorkerReservation(
  document: TesseraRunJob,
): Promise<WorkerReservation | null> {
  try {
    const parsed = JSON.parse(
      await readFile(lockPathFor(document), "utf8"),
    ) as Partial<WorkerReservation>;
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.attempt !== "number" ||
      !Number.isInteger(parsed.attempt) ||
      parsed.attempt < 1 ||
      typeof parsed.jobPath !== "string" ||
      typeof parsed.tokenSha256 !== "string" ||
      !sha256Pattern.test(parsed.tokenSha256) ||
      (
        parsed.pid !== null &&
        (
          typeof parsed.pid !== "number" ||
          !Number.isInteger(parsed.pid) ||
          parsed.pid <= 0
        )
      ) ||
      (
        parsed.processStartedAt !== undefined &&
        parsed.processStartedAt !== null &&
        typeof parsed.processStartedAt !== "string"
      ) ||
      typeof parsed.reservedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.reservedAt))
    ) {
      throw jobError(
        "TESSERA_RUN_LOCK_MALFORMED",
        "The Tessera worker reservation is malformed.",
      );
    }
    parsed.processStartedAt ??= null;
    return parsed as WorkerReservation;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function removeWorkerReservation(
  document: TesseraRunJob,
  tokenSha256?: string,
): Promise<void> {
  const reservation = await readWorkerReservation(document);
  if (!reservation) return;
  if (
    tokenSha256 &&
    reservation.tokenSha256 !== tokenSha256
  ) return;
  await rm(lockPathFor(document), { force: true });
}

async function recoverStaleWorkerReservation(
  document: TesseraRunJobDocument,
): Promise<boolean> {
  let reservation: WorkerReservation | null;
  try {
    reservation = await readWorkerReservation(document);
  } catch (error) {
    const metadata = await stat(lockPathFor(document)).catch(() => null);
    if (
      metadata &&
      Date.now() - metadata.mtimeMs > workerReservationStaleMs
    ) {
      await rm(lockPathFor(document), { force: true });
      return false;
    }
    throw error;
  }
  if (!reservation) return false;
  if (
    path.resolve(reservation.jobPath) !==
      path.resolve(document.requestPath) ||
    reservation.runId !== document.runId ||
    reservation.attempt !== document.attempt ||
    reservation.tokenSha256 !== document.workerTokenSha256
  ) {
    if (
      reservation.pid !== null &&
      !processExists(reservation.pid)
    ) {
      await removeWorkerReservation(
        document,
        reservation.tokenSha256,
      );
      return false;
    }
    const age =
      Date.now() - Date.parse(reservation.reservedAt);
    if (Number.isFinite(age) && age > workerReservationStaleMs) {
      await removeWorkerReservation(
        document,
        reservation.tokenSha256,
      );
      return false;
    }
    throw jobError(
      "TESSERA_RUN_LOCK_MISMATCH",
      "The worker reservation does not belong to this Tessera run.",
    );
  }
  if (reservation.pid === null) {
    const age =
      Date.now() - Date.parse(reservation.reservedAt);
    if (Number.isFinite(age) && age > workerReservationStaleMs) {
      await removeWorkerReservation(
        document,
        reservation.tokenSha256,
      );
      return false;
    }
    return true;
  }
  const identity = await workerProcessMatches(
    reservation.pid,
    document.requestPath,
    reservation.tokenSha256,
    reservation.processStartedAt,
  );
  if (identity === "matched" || identity === "unverifiable") {
    return true;
  }
  await removeWorkerReservation(document, reservation.tokenSha256);
  return false;
}

async function acquireControlLease(
  jobDirectory: string,
): Promise<() => Promise<void>> {
  const lockPath = path.join(jobDirectory, "job-control.lock");
  const token = randomUUID();
  const deadline = Date.now() + controlLeaseWaitMs;
  const ownerStartIdentity = await processStartIdentity(process.pid);
  while (true) {
    const lease: ControlLease = {
      token,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      processStartedAt: ownerStartIdentity,
    };
    try {
      await writeFile(lockPath, `${JSON.stringify(lease)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return async () => {
        try {
          const current = JSON.parse(
            await readFile(lockPath, "utf8"),
          ) as Partial<ControlLease>;
          if (current.token === token) {
            await rm(lockPath, { force: true });
          }
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      let observed:
        | {
            contentSha256: string;
            device: number;
            inode: number;
            lease: Partial<ControlLease> | null;
            modifiedAtMs: number;
          }
        | null = null;
      try {
        const [content, metadata] = await Promise.all([
          readFile(lockPath),
          lstat(lockPath),
        ]);
        let current: Partial<ControlLease> | null = null;
        try {
          current = JSON.parse(
            content.toString("utf8"),
          ) as Partial<ControlLease>;
        } catch {
          current = null;
        }
        observed = {
          contentSha256: contentSha256(content),
          device: metadata.dev,
          inode: metadata.ino,
          lease: current,
          modifiedAtMs: metadata.mtimeMs,
        };
      } catch (inspectionError) {
        if (errorCode(inspectionError) === "ENOENT") continue;
        throw inspectionError;
      }
      const current = observed.lease;
      const validOwner =
        current !== null &&
        typeof current.token === "string" &&
        current.token.length > 0 &&
        typeof current.pid === "number" &&
        Number.isInteger(current.pid) &&
        current.pid > 0 &&
        typeof current.acquiredAt === "string" &&
        Number.isFinite(Date.parse(current.acquiredAt));
      let stale =
        !validOwner &&
        Date.now() - observed.modifiedAtMs >
          controlLeaseStaleMs;
      if (validOwner) {
        if (!processExists(current.pid!)) {
          stale = true;
        } else {
          const observedStart =
            typeof current.processStartedAt === "string"
              ? current.processStartedAt
              : null;
          const liveStart = observedStart
            ? await processStartIdentity(current.pid!)
            : null;
          stale =
            observedStart !== null &&
            liveStart !== null &&
            observedStart !== liveStart;
        }
      }
      if (stale) {
        let unchanged = false;
        try {
          const [latestContent, latestMetadata] =
            await Promise.all([
              readFile(lockPath),
              lstat(lockPath),
            ]);
          unchanged =
            latestMetadata.dev === observed.device &&
            latestMetadata.ino === observed.inode &&
            contentSha256(latestContent) ===
              observed.contentSha256;
        } catch (inspectionError) {
          if (errorCode(inspectionError) === "ENOENT") continue;
          throw inspectionError;
        }
        if (unchanged) {
          await rm(lockPath, { force: true });
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw jobError(
          "TESSERA_JOB_CONTROL_LOCKED",
          "Timed out waiting for another Tessera job operation.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function reserveWorker(
  job: TesseraRunJob,
  tokenSha256: string,
): Promise<void> {
  const reservation: WorkerReservation = {
    runId: job.runId,
    attempt: job.attempt,
    jobPath: job.requestPath,
    tokenSha256,
    pid: null,
    processStartedAt: null,
    reservedAt: new Date().toISOString(),
  };
  await writeFile(
    lockPathFor(job),
    `${JSON.stringify(reservation)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

async function updateWorkerReservationPid(
  document: TesseraRunJob,
  tokenSha256: string,
  pid: number,
): Promise<void> {
  const reservation = await readWorkerReservation(document);
  if (
    !reservation ||
    reservation.tokenSha256 !== tokenSha256 ||
    reservation.runId !== document.runId ||
    reservation.attempt !== document.attempt
  ) {
    throw jobError(
      "TESSERA_RUN_LOCK_MISMATCH",
      "The worker reservation changed before launch completed.",
    );
  }
  await writeJsonAtomic(lockPathFor(document), {
    ...reservation,
    pid,
    processStartedAt: await processStartIdentity(pid),
  });
}

async function launchWorker(
  document: TesseraRunJobDocument,
): Promise<TesseraRunJobDocument> {
  const workerToken = randomBytes(32).toString("hex");
  const workerTokenSha256 = contentSha256(workerToken);
  let reservedDocument: TesseraRunJobDocument = {
    ...document,
    workerPid: null,
    workerTokenSha256,
    updatedAt: new Date().toISOString(),
  };
  let workerPid: number | null = null;
  try {
    await writeJsonAtomic(
      jobPathFor(reservedDocument),
      reservedDocument,
    );
    await reserveWorker(reservedDocument, workerTokenSha256);
    const launched = await startTesseraRunThroughLocalAgent(
      jobPathFor(reservedDocument),
      workerToken,
      { timeoutMs: 10_000 },
    );
    workerPid = launched.workerPid;
    await updateWorkerReservationPid(
      reservedDocument,
      workerTokenSha256,
      workerPid,
    );
    reservedDocument = {
      ...reservedDocument,
      workerPid,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(
      jobPathFor(reservedDocument),
      reservedDocument,
    );
    return reservedDocument;
  } catch (error) {
    if (workerPid !== null && processExists(workerPid)) {
      try {
        process.kill(workerPid, "SIGTERM");
      } catch {
        // The failed worker may already have exited.
      }
    }
    await removeWorkerReservation(
      reservedDocument,
      workerTokenSha256,
    );
    const reset: TesseraRunJobDocument = {
      ...reservedDocument,
      status: "queued",
      workerPid: null,
      workerTokenSha256: null,
      updatedAt: new Date().toISOString(),
      error: {
        code:
          errorCode(error) ??
          "TESSERA_JOB_LAUNCH_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The local agent could not launch the Tessera worker.",
        retryable: true,
      },
      nextAction:
        "The durable run is retained. Repair or restart the local agent, then resume this same queued attempt.",
    };
    await writeJsonAtomic(jobPathFor(reset), reset);
    return projectTesseraReliabilityEvent(
      jobPathFor(reset),
      reset,
      "failure",
      "worker-launch",
    );
  }
}

async function refreshUnstartedQueuedRuntime(
  document: TesseraRunJobDocument,
): Promise<TesseraRunJobDocument> {
  if (
    document.status !== "queued" ||
    document.startedAt !== null ||
    document.workerPid !== null ||
    document.workerTokenSha256 !== null
  ) {
    return document;
  }
  const runtimeProvenance = await jobRuntimeProvenance();
  assertDurableRuntimeAdmission(runtimeProvenance);
  const runtimeIdentity =
    runtimeIdentitySha256(runtimeProvenance);
  const refreshed: TesseraRunJobDocument = {
    ...document,
    runtimeProvenance,
    runtimeIdentitySha256: runtimeIdentity,
    updatedAt: new Date().toISOString(),
    attemptHistory: updateCurrentAttempt(
      document.attemptHistory,
      document.attempt,
      {
        runtime: runtimeProvenance,
        runtimeIdentitySha256: runtimeIdentity,
      },
    ),
    error: null,
    nextAction:
      "Wait for the background run or inspect its status.",
  };
  await writeJsonAtomic(document.requestPath, refreshed);
  return refreshed;
}

async function writeFrozenInput(
  jobDirectory: string,
  kind: TesseraRunInputArtifact["kind"],
  sourceFilename: string,
  content: Buffer,
): Promise<TesseraRunInputArtifact> {
  if (kind === "profile-policy") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.toString("utf8"));
    } catch {
      throw jobError(
        "TESSERA_PROFILE_POLICY_INVALID",
        `Profile policy ${sourceFilename} is not valid JSON.`,
      );
    }
    const validation = ProfilePolicySchema.safeParse(parsed);
    if (!validation.success) {
      throw jobError(
        "TESSERA_PROFILE_POLICY_INVALID",
        `Profile policy ${sourceFilename} is invalid: ${validation.error.issues[0]?.message ?? "schema validation failed"}.`,
      );
    }
  }
  const sha256 = contentSha256(content);
  const extension =
    kind === "opponent-rosz" ||
    kind === "baseline-artifact"
      ? path.extname(sourceFilename) || ".bin"
      : ".json";
  const filename = `${kind}-${sha256}${extension}`;
  const inputDirectory = path.join(jobDirectory, "inputs");
  const frozenPath = path.join(inputDirectory, filename);
  await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(frozenPath, content, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      errorCode(error) !== "EEXIST" ||
      (await fileSha256(frozenPath)) !== sha256
    ) {
      throw error;
    }
  }
  return {
    kind,
    filename,
    path: frozenPath,
    sha256,
  };
}

function bundlePathValue(
  value: unknown,
  sourceRoot: string,
  destinationRoot: string,
  key = "",
  parentKey = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      bundlePathValue(
        entry,
        sourceRoot,
        destinationRoot,
        key,
        parentKey,
      ),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        bundlePathValue(
          entry,
          sourceRoot,
          destinationRoot,
          entryKey,
          key,
        ),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  const pathBearing =
    key === "outputDirectory" ||
    key.endsWith("Path") ||
    key === "reportPath" ||
    key === "written" ||
    (
      parentKey === "finalArtifacts" &&
      (key === "json" || key === "html")
    );
  if (!pathBearing || !path.isAbsolute(value)) return value;
  if (!pathInside(sourceRoot, value)) {
    throw jobError(
      "TESSERA_BASELINE_BUNDLE_INVALID",
      `A frozen recovery artifact points outside its source bundle: ${value}.`,
    );
  }
  return path.join(
    destinationRoot,
    path.relative(sourceRoot, value),
  );
}

async function copyVerifiedBundle(
  sourceRoot: string,
  destinationRoot: string,
  receiptKind: "baseline-artifact" | "stress-manifest",
  excludedRoots: string[] = [],
): Promise<TesseraRunInputArtifact[]> {
  const receipts: TesseraRunInputArtifact[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const copyDirectory = async (
    sourceDirectory: string,
    destinationDirectory: string,
  ): Promise<void> => {
    await mkdir(destinationDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const entries = await readdir(sourceDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const source = path.join(sourceDirectory, entry.name);
      if (
        excludedRoots.some(
          (excluded) =>
            path.resolve(source) === path.resolve(excluded) ||
            pathInside(excluded, source),
        )
      ) {
        continue;
      }
      const destination = path.join(
        destinationDirectory,
        entry.name,
      );
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink()) {
        throw jobError(
          "TESSERA_BASELINE_BUNDLE_INVALID",
          `Recovery bundles cannot contain symbolic links (${source}).`,
        );
      }
      if (metadata.isDirectory()) {
        await copyDirectory(source, destination);
        continue;
      }
      if (!metadata.isFile()) {
        throw jobError(
          "TESSERA_BASELINE_BUNDLE_INVALID",
          `Recovery bundles may contain only regular files and directories (${source}).`,
        );
      }
      fileCount += 1;
      totalBytes += metadata.size;
      if (fileCount > 20_000 || totalBytes > 2 * 1024 * 1024 * 1024) {
        throw jobError(
          "TESSERA_BASELINE_BUNDLE_TOO_LARGE",
          "The recovery bundle exceeds the durable-job file or size limit.",
        );
      }
      const content = await readFile(source);
      await mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(destination, content, {
        flag: "wx",
        mode: 0o600,
      });
      receipts.push({
        kind: receiptKind,
        filename: path.basename(destination),
        path: destination,
        sha256: contentSha256(content),
      });
    }
  };
  await copyDirectory(sourceRoot, destinationRoot);
  return receipts;
}

async function rewriteJsonBundleFile(
  filename: string,
  sourceRoot: string,
  destinationRoot: string,
): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(
    await readFile(filename, "utf8"),
  ) as Record<string, unknown>;
  const rewritten = bundlePathValue(
    parsed,
    sourceRoot,
    destinationRoot,
  ) as Record<string, unknown>;
  await writeJsonAtomic(filename, rewritten);
  return rewritten;
}

async function freezeStressRecoveryBundle(
  sourceManifestPath: string,
  jobDirectory: string,
): Promise<{
  workingManifestPath: string;
  artifacts: TesseraRunInputArtifact[];
}> {
  const sourceManifest = path.resolve(sourceManifestPath);
  const sourceRoot = path.dirname(sourceManifest);
  const relativeManifest = path.relative(
    sourceRoot,
    sourceManifest,
  );
  const immutableRoot = path.join(
    jobDirectory,
    "inputs",
    "stress-recovery-source",
  );
  const workingRoot = path.join(
    jobDirectory,
    "artifacts",
    "stress-recovery",
  );
  const artifacts = await copyVerifiedBundle(
    sourceRoot,
    immutableRoot,
    "stress-manifest",
    [jobDirectory],
  );
  await copyVerifiedBundle(
    sourceRoot,
    workingRoot,
    "stress-manifest",
    [jobDirectory],
  );
  const workingManifestPath = path.join(
    workingRoot,
    relativeManifest,
  );
  await rewriteJsonBundleFile(
    workingManifestPath,
    sourceRoot,
    workingRoot,
  );
  await verifyAndMigrateTesseraStressManifest(
    workingManifestPath,
  );
  return { workingManifestPath, artifacts };
}

async function freezeExactRevisionBaseline(
  sourceReportPath: string,
  jobDirectory: string,
): Promise<{
  baselineReportPath: string;
  artifacts: TesseraRunInputArtifact[];
}> {
  const sourceReport = path.resolve(sourceReportPath);
  const serializedBaseline = await readFile(
    sourceReport,
    "utf8",
  );
  const baseline = JSON.parse(
    serializedBaseline,
  ) as TesseraMatchupReport;
  if (
    !baseline.player ||
    !Array.isArray(baseline.opponents) ||
    baseline.opponents.length === 0
  ) {
    throw jobError(
      "TESSERA_BASELINE_INCOMPATIBLE",
      "The exact paired-revision baseline has no complete player and opponent inventory.",
    );
  }
  let sourceReceipt: unknown;
  try {
    sourceReceipt = JSON.parse(
      await readFile(
        exactReportReceiptPath(sourceReport),
        "utf8",
      ),
    );
  } catch (error) {
    throw jobError(
      "TESSERA_BASELINE_RECEIPT_MISSING",
      `The exact paired-revision baseline receipt is missing or unreadable: ${
        error instanceof Error
          ? error.message
          : "receipt unreadable"
      }`,
    );
  }
  const receiptIssue = verifyExactReportReceipt(
    sourceReport,
    serializedBaseline,
    baseline,
    sourceReceipt,
  );
  if (receiptIssue) {
    throw jobError(
      "TESSERA_BASELINE_INTEGRITY_CHANGED",
      receiptIssue,
    );
  }
  const sourceDirectory = path.dirname(sourceReport);
  const baselineRoot = path.join(
    jobDirectory,
    "inputs",
    "exact-revision-baseline",
  );
  const archiveRoot = path.join(baselineRoot, "archives");
  await mkdir(archiveRoot, {
    recursive: true,
    mode: 0o700,
  });
  const artifacts: TesseraRunInputArtifact[] = [];
  const freezeArchive = async (input: {
    role: "player" | "opponent";
    ordinal: number;
    archiveKind: "source" | "enriched";
    rosterName: string;
    filename: string | undefined;
    sha256: string | undefined;
  }): Promise<string> => {
    if (
      !input.filename ||
      !input.sha256 ||
      !sha256Pattern.test(input.sha256)
    ) {
      throw jobError(
        "TESSERA_BASELINE_INCOMPATIBLE",
        `The exact paired-revision baseline is missing the ${input.archiveKind} archive receipt for ${input.rosterName}.`,
      );
    }
    const source = path.isAbsolute(input.filename)
      ? input.filename
      : path.resolve(
          sourceDirectory,
          input.filename,
        );
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw jobError(
        "TESSERA_BASELINE_ARTIFACT_INVALID",
        `The ${input.archiveKind} archive for ${input.rosterName} is not a regular file.`,
      );
    }
    const content = await readFile(source);
    if (contentSha256(content) !== input.sha256) {
      throw jobError(
        input.role === "player"
          ? "TESSERA_BASELINE_PLAYER_ARTIFACT_CHANGED"
          : "TESSERA_BASELINE_OPPONENT_ARTIFACT_CHANGED",
        `The frozen ${input.archiveKind} archive for ${input.rosterName} changed before the paired revision was queued.`,
      );
    }
    const destination = path.join(
      archiveRoot,
      `${input.role}-${input.ordinal}-${input.archiveKind}-${input.sha256}.rosz`,
    );
    await writeFile(destination, content, {
      flag: "wx",
      mode: 0o600,
    });
    artifacts.push({
      kind: "baseline-artifact",
      filename: path.basename(destination),
      path: destination,
      sha256: input.sha256,
    });
    return path.relative(baselineRoot, destination);
  };
  const freezeRoster = async <
    T extends {
      rosterName: string;
      sourceRoszPath?: string;
      sourceRoszSha256?: string;
      enrichedRoszPath: string;
      enrichedRoszSha256?: string;
    },
  >(
    roster: T,
    role: "player" | "opponent",
    ordinal: number,
  ): Promise<T> => {
    const sourceRoszPath = await freezeArchive({
      role,
      ordinal,
      archiveKind: "source",
      rosterName: roster.rosterName,
      filename: roster.sourceRoszPath,
      sha256: roster.sourceRoszSha256,
    });
    const enrichedRoszPath = await freezeArchive({
      role,
      ordinal,
      archiveKind: "enriched",
      rosterName: roster.rosterName,
      filename: roster.enrichedRoszPath,
      sha256: roster.enrichedRoszSha256,
    });
    return {
      ...roster,
      sourceRoszPath,
      enrichedRoszPath,
    };
  };
  const frozenPlayer = await freezeRoster(
    baseline.player,
    "player",
    1,
  );
  const frozenOpponents = await Promise.all(
    baseline.opponents.map((opponent, index) =>
      freezeRoster(
        opponent,
        "opponent",
        index + 1,
      ),
    ),
  );
  const frozenReportPath = path.join(
    baselineRoot,
    path.basename(sourceReport),
  );
  const frozenReceiptPath =
    exactReportReceiptPath(frozenReportPath);
  const frozenBaseline: TesseraMatchupReport = {
    ...baseline,
    player: frozenPlayer,
    opponents: frozenOpponents,
    artifacts: [
      {
        format: "matchup-json",
        written: path.basename(frozenReportPath),
      },
      {
        format: "matchup-receipt",
        written: path.basename(frozenReceiptPath),
      },
    ],
  };
  const baselineContent =
    `${JSON.stringify(frozenBaseline, null, 2)}\n`;
  await writeFile(frozenReportPath, baselineContent, {
    flag: "wx",
    mode: 0o600,
  });
  const rewrittenReceipt = createExactReportReceipt(
    frozenReportPath,
    baselineContent,
    frozenBaseline,
  );
  const serializedReceipt =
    `${JSON.stringify(rewrittenReceipt, null, 2)}\n`;
  await writeFile(frozenReceiptPath, serializedReceipt, {
    flag: "wx",
    mode: 0o600,
  });
  const rewrittenReceiptIssue = verifyExactReportReceipt(
    frozenReportPath,
    await readFile(frozenReportPath, "utf8"),
    frozenBaseline,
    JSON.parse(await readFile(frozenReceiptPath, "utf8")),
  );
  if (rewrittenReceiptIssue) {
    throw jobError(
      "TESSERA_BASELINE_BUNDLE_INVALID",
      `The rewritten exact baseline receipt failed verification: ${rewrittenReceiptIssue}`,
    );
  }
  const reportReceipt: TesseraRunInputArtifact = {
    kind: "baseline-report",
    filename: path.basename(frozenReportPath),
    path: frozenReportPath,
    sha256: contentSha256(baselineContent),
  };
  const sidecarReceipt: TesseraRunInputArtifact = {
    kind: "baseline-artifact",
    filename: path.basename(frozenReceiptPath),
    path: frozenReceiptPath,
    sha256: contentSha256(serializedReceipt),
  };
  return {
    baselineReportPath: frozenReportPath,
    artifacts: [
      ...artifacts,
      reportReceipt,
      sidecarReceipt,
    ],
  };
}

async function freezeStressRevisionBaseline(
  sourceReportPath: string,
  jobDirectory: string,
): Promise<{
  baselineReportPath: string;
  artifacts: TesseraRunInputArtifact[];
}> {
  const sourceReport = path.resolve(sourceReportPath);
  const baseline = JSON.parse(
    await readFile(sourceReport, "utf8"),
  ) as {
    artifacts?: Array<{
      format?: string;
      written?: string;
      sha256?: string | null;
    }>;
  };
  const manifestArtifact = baseline.artifacts?.find(
    (artifact) => artifact.format === "stress-manifest",
  );
  if (!manifestArtifact?.written) {
    throw jobError(
      "TESSERA_STRESS_BASELINE_PROVENANCE_INVALID",
      "The stress paired-revision baseline has no frozen manifest.",
    );
  }
  const sourceManifest = path.isAbsolute(manifestArtifact.written)
    ? manifestArtifact.written
    : path.resolve(
        path.dirname(sourceReport),
        manifestArtifact.written,
      );
  const sourceRoot = path.dirname(sourceManifest);
  if (!pathInside(sourceRoot, sourceReport)) {
    throw jobError(
      "TESSERA_BASELINE_BUNDLE_INVALID",
      "The stress baseline report and manifest must share one portable run bundle.",
    );
  }
  const destinationRoot = path.join(
    jobDirectory,
    "inputs",
    "stress-revision-baseline",
  );
  const artifacts = await copyVerifiedBundle(
    sourceRoot,
    destinationRoot,
    "baseline-artifact",
    [jobDirectory],
  );
  const frozenReport = path.join(
    destinationRoot,
    path.relative(sourceRoot, sourceReport),
  );
  const frozenManifest = path.join(
    destinationRoot,
    path.relative(sourceRoot, sourceManifest),
  );
  const rewrittenReport = await rewriteJsonBundleFile(
    frozenReport,
    sourceRoot,
    destinationRoot,
  );
  const rewrittenManifest = await rewriteJsonBundleFile(
    frozenManifest,
    sourceRoot,
    destinationRoot,
  ) as {
    finalArtifacts?: {
      json?: string;
      jsonSha256?: string | null;
    } | null;
  };
  const reportArtifacts = Array.isArray(rewrittenReport.artifacts)
    ? rewrittenReport.artifacts as Array<Record<string, unknown>>
    : [];
  for (const artifact of reportArtifacts) {
    if (artifact.format === "stress-manifest") {
      artifact.written = frozenManifest;
      artifact.sha256 = null;
    }
  }
  await writeJsonAtomic(frozenReport, rewrittenReport);
  const reportSha256 = await fileSha256(frozenReport);
  if (!rewrittenManifest.finalArtifacts) {
    throw jobError(
      "TESSERA_STRESS_BASELINE_PROVENANCE_INVALID",
      "The stress baseline manifest has no completed report receipt.",
    );
  }
  rewrittenManifest.finalArtifacts.json = frozenReport;
  rewrittenManifest.finalArtifacts.jsonSha256 = reportSha256;
  await writeJsonAtomic(frozenManifest, rewrittenManifest);
  await verifyAndMigrateTesseraStressManifest(frozenManifest);
  const refreshedArtifacts = artifacts.map((artifact) => {
    if (path.resolve(artifact.path) === path.resolve(frozenReport)) {
      return {
        ...artifact,
        kind: "baseline-report" as const,
        sha256: reportSha256,
      };
    }
    if (path.resolve(artifact.path) === path.resolve(frozenManifest)) {
      return {
        ...artifact,
        kind: "stress-manifest" as const,
        sha256: "",
      };
    }
    return artifact;
  });
  for (const artifact of refreshedArtifacts) {
    if (
      artifact.sha256.length === 0 ||
      path.resolve(artifact.path) === path.resolve(frozenReport) ||
      path.resolve(artifact.path) === path.resolve(frozenManifest)
    ) {
      artifact.sha256 = await fileSha256(artifact.path);
    }
  }
  return {
    baselineReportPath: frozenReport,
    artifacts: refreshedArtifacts,
  };
}

async function freezeRequestInputs(
  request: TesseraRunRequest,
  jobDirectory: string,
): Promise<{
  request: TesseraRunRequest;
  artifacts: TesseraRunInputArtifact[];
  profilePolicyPath: string | null;
}> {
  const frozen = stripSerializedAnalysisCapabilities(request);
  const artifactsByPath = new Map<string, TesseraRunInputArtifact>();
  const sourceCache = new Map<string, TesseraRunInputArtifact>();
  const freezePath = async (
    filename: string,
    kind: TesseraRunInputArtifact["kind"],
    sourceRoot = process.cwd(),
  ): Promise<string> => {
    const source = path.resolve(sourceRoot, filename);
    const cacheKey = `${kind}:${source}`;
    let artifact = sourceCache.get(cacheKey);
    if (!artifact) {
      artifact = await writeFrozenInput(
        jobDirectory,
        kind,
        path.basename(source),
        await readFile(source),
      );
      sourceCache.set(cacheKey, artifact);
      artifactsByPath.set(artifact.path, artifact);
    }
    return artifact.path;
  };
  const freezeOptionsPolicy = async (
    options:
      | TesseraAnalysisOptions
      | TesseraStressOptions
      | undefined,
    sourceRoot = process.cwd(),
  ): Promise<void> => {
    if (options?.profilePolicyPath) {
      options.profilePolicyPath = await freezePath(
        options.profilePolicyPath,
        "profile-policy",
        sourceRoot,
      );
    }
  };
  if (frozen.kind === "exact") {
    if (frozen.opponent.kind === "rosz") {
      frozen.opponent.path = await freezePath(
        frozen.opponent.path,
        "opponent-rosz",
      );
    }
    await freezeOptionsPolicy(frozen.options);
  } else if (frozen.kind === "stress") {
    const recoveryPath =
      frozen.options?.resumeManifestPath ??
      frozen.options?.restartManifestPath;
    if (recoveryPath) {
      const recovery = await freezeStressRecoveryBundle(
        path.resolve(
          frozen.options?.rootDir ?? process.cwd(),
          recoveryPath,
        ),
        jobDirectory,
      );
      if (frozen.options?.resumeManifestPath) {
        frozen.options.resumeManifestPath =
          recovery.workingManifestPath;
      } else if (frozen.options?.restartManifestPath) {
        frozen.options.restartManifestPath =
          recovery.workingManifestPath;
      }
      for (const artifact of recovery.artifacts) {
        artifactsByPath.set(artifact.path, artifact);
      }
    }
    await freezeOptionsPolicy(
      frozen.options,
      frozen.options?.rootDir ?? process.cwd(),
    );
  } else if (frozen.kind === "build-and-stress") {
    const recoveryPath =
      frozen.input.resumeManifestPath ??
      frozen.input.restartManifestPath ??
      frozen.options?.resumeManifestPath ??
      frozen.options?.restartManifestPath;
    if (recoveryPath) {
      const recovery = await freezeStressRecoveryBundle(
        path.resolve(
          frozen.options?.rootDir ?? process.cwd(),
          recoveryPath,
        ),
        jobDirectory,
      );
      if (
        frozen.input.resumeManifestPath ||
        frozen.options?.resumeManifestPath
      ) {
        frozen.input.resumeManifestPath =
          recovery.workingManifestPath;
        if (frozen.options?.resumeManifestPath) {
          frozen.options.resumeManifestPath =
            recovery.workingManifestPath;
        }
      } else {
        frozen.input.restartManifestPath =
          recovery.workingManifestPath;
        if (frozen.options?.restartManifestPath) {
          frozen.options.restartManifestPath =
            recovery.workingManifestPath;
        }
      }
      for (const artifact of recovery.artifacts) {
        artifactsByPath.set(artifact.path, artifact);
      }
    }
    if (frozen.input.profilePolicyPath) {
      frozen.input.profilePolicyPath = await freezePath(
        frozen.input.profilePolicyPath,
        "profile-policy",
        frozen.options?.rootDir ?? process.cwd(),
      );
    }
    await freezeOptionsPolicy(
      frozen.options,
      frozen.options?.rootDir ?? process.cwd(),
    );
  } else if (frozen.kind === "build-and-analyze") {
    if (frozen.input.profilePolicyPath) {
      frozen.input.profilePolicyPath = await freezePath(
        frozen.input.profilePolicyPath,
        "profile-policy",
      );
    }
    await freezeOptionsPolicy(frozen.options);
  } else {
    const baseline =
      frozen.kind === "exact-revision"
        ? await freezeExactRevisionBaseline(
            frozen.baselineReportPath,
            jobDirectory,
          )
        : await freezeStressRevisionBaseline(
            frozen.baselineReportPath,
            jobDirectory,
          );
    frozen.baselineReportPath =
      baseline.baselineReportPath;
    for (const artifact of baseline.artifacts) {
      artifactsByPath.set(artifact.path, artifact);
    }
    await freezeOptionsPolicy(frozen.options);
  }
  const profilePolicyPath =
    frozen.kind === "exact" ||
    frozen.kind === "stress" ||
    frozen.kind === "exact-revision" ||
    frozen.kind === "stress-revision"
      ? frozen.options?.profilePolicyPath ?? null
      : frozen.input.profilePolicyPath ??
        frozen.options?.profilePolicyPath ??
        null;
  return {
    request: frozen,
    artifacts: [...artifactsByPath.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    profilePolicyPath,
  };
}

function optionsOutputDirectory(
  request: TesseraRunRequest,
  jobDirectory: string,
  attempt = 1,
): TesseraRunRequest {
  const artifactRoot = path.join(jobDirectory, "artifacts");
  if (request.kind === "exact") {
    const outputDirectory = path.join(
      artifactRoot,
      `attempt-${attempt}`,
    );
    return {
      ...request,
      options: {
        ...request.options,
        outputDirectory,
        rootDir: jobDirectory,
        allowOutsideRoot: false,
        overwrite: false,
      },
    };
  }
  if (request.kind === "stress") {
    return {
      ...request,
      options: {
        ...request.options,
        outputDirectory: artifactRoot,
        rootDir: jobDirectory,
        allowOutsideRoot: false,
      },
    };
  }
  if (request.kind === "build-and-stress") {
    return {
      ...request,
      input: {
        ...request.input,
        outputDirectory: artifactRoot,
      },
      options: {
        ...request.options,
        outputDirectory: artifactRoot,
        rootDir: jobDirectory,
        allowOutsideRoot: false,
      },
    };
  }
  if (
    request.kind === "exact-revision" ||
    request.kind === "stress-revision"
  ) {
    return {
      ...request,
      options: {
        ...request.options,
        outputDirectory: path.join(
          artifactRoot,
          `attempt-${attempt}`,
        ),
        rootDir: jobDirectory,
        allowOutsideRoot: false,
        overwrite: false,
        executionMode: "simulate",
        experimental: false,
      },
    };
  }
  const outputDirectory = path.join(
    artifactRoot,
    `attempt-${attempt}`,
  );
  return {
    ...request,
    input: {
      ...request.input,
      outputDirectory,
    },
    options: {
      ...request.options,
      outputDirectory,
      rootDir: jobDirectory,
      allowOutsideRoot: false,
      overwrite: false,
    },
  };
}

function stressManifestPathForRequest(
  request: TesseraRunRequest,
  jobDirectory: string,
): string | null {
  if (request.kind === "stress") {
    return (
      request.options?.resumeManifestPath ??
      path.join(
        jobDirectory,
        "artifacts",
        "stress-manifest.json",
      )
    );
  }
  if (request.kind === "build-and-stress") {
    return (
      request.input.resumeManifestPath ??
      request.options?.resumeManifestPath ??
      path.join(
        jobDirectory,
        "artifacts",
        "stress-manifest.json",
      )
    );
  }
  return null;
}

async function bindFrozenStressPortfolio(
  request: TesseraRunRequest,
): Promise<TesseraRunRequest> {
  if (
    request.kind === "stress" &&
    request.options?.portfolioPreview
  ) {
    if (
      request.options.resumeManifestPath ||
      request.options.restartManifestPath
    ) {
      throw jobError(
        "TESSERA_RUN_RESUME_CONFLICT",
        "A resume or restart manifest is authoritative for its frozen portfolio; do not also supply a portfolio preview.",
      );
    }
    const preview = request.options.portfolioPreview;
    if (
      preview.schemaVersion !== 1 ||
      preview.previewKind !== "tessera-stress-portfolio" ||
      !preview.portfolio ||
      !Array.isArray(preview.portfolio.items) ||
      !Array.isArray(preview.items) ||
      !preview.gates ||
      preview.portfolio.factionId !== request.factionId ||
      preview.portfolio.pointsLimit !==
        request.playerRoster.pointsLimit ||
      preview.portfolio.suite !==
        (request.options.suite ?? "diverse-9")
    ) {
      throw jobError(
        "TESSERA_STRESS_FROZEN_PORTFOLIO_MISMATCH",
        "The supplied frozen portfolio preview is malformed or does not match the requested opponent faction, points limit, and suite.",
      );
    }
    return request;
  }
  if (
    request.kind !== "stress" ||
    request.options?.resumeManifestPath ||
    request.options?.restartManifestPath
  ) {
    return request;
  }
  const preview = await previewFactionStressPortfolio({
    faction: request.factionId,
    pointsLimit: request.playerRoster.pointsLimit,
    suite: request.options?.suite,
    pointsTolerancePercent: 5,
    allowLegends: false,
    artifactMode:
      request.options?.simulationBackend === "local-engine"
        ? "canonical"
        : "new-recruit",
  });
  if (!preview.ok || !preview.data) {
    throw jobError(
      preview.violations[0]?.code ??
        "PORTFOLIO_CONTRACT_UNMET",
      preview.violations[0]?.message ??
        "The opponent portfolio could not be frozen before the durable run was created.",
    );
  }
  return {
    ...request,
    options: {
      ...request.options,
      portfolioPreview: preview.data,
    },
  };
}

function knownPrequeueRosters(
  request: TesseraRunRequest,
): RosterDraftV1[] | null {
  if (request.kind === "exact") {
    const opponent =
      request.opponent.kind === "roster"
        ? request.opponent.roster
        : request.options?.opponentRosterContext;
    return opponent
      ? [request.playerRoster, opponent]
      : null;
  }
  if (request.kind === "stress") {
    const portfolio = request.options?.portfolioPreview?.portfolio;
    if (!portfolio) return null;
    const opponents = portfolio.items.flatMap((item) =>
      item.status === "ready" && item.roster ? [item.roster] : [],
    );
    return opponents.length > 0
      ? [request.playerRoster, ...opponents]
      : null;
  }
  return null;
}

async function prequeueProfileResolution(
  request: TesseraRunRequest,
  profilePolicyPath: string | null,
  jobDirectory: string,
): Promise<TesseraProfileResolutionState | null> {
  if (
    (request.kind !== "exact" && request.kind !== "stress") ||
    request.options?.executionMode !== "simulate"
  ) {
    return null;
  }
  const rosters = knownPrequeueRosters(request);
  if (!rosters) return null;
  const requirements = aggregateProfileRequirements(rosters);
  if (requirements.length === 0) return null;
  const policy = profilePolicyPath
    ? ProfilePolicySchema.parse(
        JSON.parse(await readFile(profilePolicyPath, "utf8")),
      )
    : null;
  const validation = validateProfilePolicy(requirements, policy);
  if (validation.valid) return null;
  const scaffold = profilePolicyScaffold(requirements);
  const scaffoldPath = path.join(
    jobDirectory,
    "profile-policy.scaffold.json",
  );
  const scaffoldContent = `${JSON.stringify(scaffold, null, 2)}\n`;
  await writeFile(scaffoldPath, scaffoldContent, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    violationCode: "TESSERA_PROFILE_POLICY_REQUIRED",
    scaffoldPath,
    scaffoldSha256: contentSha256(scaffoldContent),
    scaffold,
    requirements: requirements.map((requirement) => ({
      faction: requirement.faction,
      unit: requirement.unit,
      ...(requirement.unitOccurrence === undefined
        ? {}
        : { unitOccurrence: requirement.unitOccurrence }),
      ...(requirement.modelCount === undefined
        ? {}
        : { modelCount: requirement.modelCount }),
      weaponGroup: requirement.weaponGroup,
      phase: requirement.phase,
      availableProfiles: [...requirement.availableProfiles],
      activeCount: requirement.activeCount,
    })),
  };
}

export async function startTesseraRun(
  request: TesseraRunRequest,
  options: StartTesseraRunOptions = {},
): Promise<TesseraRunJob> {
  if (
    options.supersedesRunId != null &&
    !/^[0-9a-f-]{36}$/i.test(options.supersedesRunId)
  ) {
    throw jobError(
      "TESSERA_SUPERSEDED_RUN_ID_INVALID",
      "A superseded Tessera run ID must be an exact UUID.",
    );
  }
  if (requestPreparedReuse(request)) {
    throw jobError(
      "TESSERA_JOB_INPUT_INVALID",
      "Prepared exact-run checkpoints are created and verified by the durable coordinator; callers cannot inject them.",
    );
  }
  request = normalizeRequestScenarioContract(request);
  const runId = randomUUID();
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const requestedBase = path.resolve(
    options.outputDirectory ??
      path.join(rootDir, "exports", "tessera", "runs"),
  );
  if (
    !options.allowOutsideRoot &&
    !pathInside(rootDir, requestedBase)
  ) {
    throw Object.assign(
      new Error(
        "The Tessera job output directory is outside the allowed write root.",
      ),
      { code: "TESSERA_OUTPUT_OUTSIDE_ROOT" },
    );
  }
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  if (
    !options.allowOutsideRoot &&
    !(await filesystemPathInside(rootDir, requestedBase))
  ) {
    throw jobError(
      "TESSERA_OUTPUT_OUTSIDE_ROOT",
      "The Tessera job output directory resolves outside the allowed write root.",
    );
  }
  const jobDirectory = path.join(requestedBase, `run-${runId}`);
  await mkdir(requestedBase, { recursive: true, mode: 0o700 });
  if (
    !options.allowOutsideRoot &&
    !(await filesystemPathInside(rootDir, requestedBase))
  ) {
    throw jobError(
      "TESSERA_OUTPUT_OUTSIDE_ROOT",
      "The Tessera job output directory resolves outside the allowed write root.",
    );
  }
  await mkdir(jobDirectory, { recursive: false, mode: 0o700 });
  let manifestPublished = false;
  try {
    const requestWithFrozenPortfolio =
      await bindFrozenStressPortfolio(request);
    const frozenInputs = await freezeRequestInputs(
      requestWithFrozenPortfolio,
      jobDirectory,
    );
    const requestWithOutput = optionsOutputDirectory(
      frozenInputs.request,
      jobDirectory,
      1,
    );
    const now = new Date().toISOString();
    const profileResolution = await prequeueProfileResolution(
      requestWithOutput,
      frozenInputs.profilePolicyPath,
      jobDirectory,
    );
    const initialStatus: TesseraRunStatus = profileResolution
      ? "needs-input"
      : "queued";
    const requestSha256 = canonicalSha256(requestWithOutput);
    const dataPins = dataPinsForRequest(requestWithOutput);
    const dataPinSha256 = canonicalSha256(dataPins);
    const profilePolicySha256 = profilePolicySha256For(
      frozenInputs.profilePolicyPath,
      frozenInputs.artifacts,
    );
    const scenarioContractSha256 =
      requestScenarioContractSha256(requestWithOutput);
    const runtimeProvenance = await jobRuntimeProvenance();
    if (options.launch !== false && initialStatus === "queued") {
      assertDurableRuntimeAdmission(runtimeProvenance);
    }
    const jobPath = path.join(jobDirectory, "tessera-run.json");
    let document: TesseraRunJobDocument = {
      schemaVersion: 1,
      jobKind: "rosterpilot-tessera-run",
      runId,
      runKind: request.kind,
      supersedesRunId: options.supersedesRunId ?? null,
      status: initialStatus,
      createdAt: now,
      startedAt: null,
      completedAt: profileResolution ? now : null,
      updatedAt: now,
      attempt: 1,
      workerPid: null,
      workerTokenSha256: null,
      jobDirectory,
      rootDirectory: jobDirectory,
      requestPath: jobPath,
      resultPath: path.join(jobDirectory, "result.json"),
      manifestPath:
        stressManifestPathForRequest(
          requestWithOutput,
          jobDirectory,
        ) ?? jobPath,
      profilePolicyPath: frozenInputs.profilePolicyPath,
      inputArtifacts: frozenInputs.artifacts,
      requestSha256,
      dataPins,
      dataPinSha256,
      profilePolicySha256,
      scenarioContractSha256,
      artifactReceipts: profileResolution?.scaffoldPath
        ? [
            {
              kind: "profile-scaffold",
              attempt: 1,
              path: path.relative(
                jobDirectory,
                profileResolution.scaffoldPath,
              ),
              sha256: profileResolution.scaffoldSha256!,
            },
          ]
        : [],
      preparedCheckpoint: null,
      runtimeProvenance,
      runtimeIdentitySha256:
        runtimeIdentitySha256(runtimeProvenance),
      simulationStage: 1,
      restartFrom: null,
      retryBudget: retryBudgetFor(1, initialStatus),
      attemptHistory: [
        attemptProvenance({
          attempt: 1,
          simulationStage: 1,
          trigger: "start",
          status: initialStatus,
          at: now,
          requestSha256,
          dataPinSha256,
          profilePolicySha256,
          runtime: runtimeProvenance,
        }),
      ],
      timingSpans: [
        createTimingSpanV1({
          spanKind: "queue",
          name: "queue-wait",
          startedAt: now,
          ...(profileResolution ? { endedAt: now } : {}),
        }),
      ],
      journalReference: null,
      reliabilityWarnings: [],
      simulationProviderPin: null,
      profileResolution,
      error: profileResolution
        ? {
            code: profileResolution.violationCode,
            message:
              "Explicit weapon-profile choices are required before this durable run can start.",
            retryable: false,
          }
        : null,
      nextAction:
        profileResolution
          ? `Complete ${profileResolution.scaffoldPath}, resolve the retained profile choices, then resume this same run.`
          : "Wait for the background run or inspect its status.",
      request: requestWithOutput,
    };
    if (
      document.manifestPath &&
      document.manifestPath !== jobPath
    ) {
      try {
        const metadata = await lstat(document.manifestPath);
        if (metadata.isFile() && !metadata.isSymbolicLink()) {
          document.artifactReceipts.push({
            kind: "workflow-manifest",
            attempt: 1,
            path: path.relative(
              document.jobDirectory,
              document.manifestPath,
            ),
            sha256: await fileSha256(document.manifestPath),
          });
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    await writeFile(
      jobPath,
      `${JSON.stringify(document, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await validateJobDocumentPaths(document, jobPath, true);
    document = await projectTesseraReliabilityEvent(
      jobPath,
      document,
      "transition",
      initialStatus,
    );
    for (const bundleId of new Set(
      dataPins.map((entry) => entry.sourceData.bundleId),
    )) {
      await retainDataBundleReference(
        `tessera-job:${runId}:${bundleId}`,
        bundleId,
      );
    }
    manifestPublished = true;
    if (options.launch === false || initialStatus === "needs-input") {
      return publicJob(document);
    }
    return publicJob(await launchWorker(document));
  } catch (error) {
    if (!manifestPublished) {
      await rm(jobDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

async function refreshDeadWorkerStatus(
  resolvedJobPath: string,
  initial: TesseraRunJobDocument,
): Promise<TesseraRunJobDocument> {
  if (
    initial.status !== "queued" &&
    initial.status !== "running"
  ) {
    return initial;
  }
  if (
    initial.status === "queued" &&
    initial.workerPid === null &&
    initial.workerTokenSha256 === null
  ) {
    return initial;
  }
  const release = await acquireControlLease(
    initial.jobDirectory,
  );
  try {
    const latest = await readJobDocument(resolvedJobPath);
    if (
      latest.status !== "queued" &&
      latest.status !== "running"
    ) {
      return latest;
    }
    const activeReservation =
      await recoverStaleWorkerReservation(latest);
    if (activeReservation) return latest;
    let identity:
      | "matched"
      | "not-running"
      | "mismatched"
      | "unverifiable" = "not-running";
    if (
      latest.workerPid !== null &&
      latest.workerTokenSha256 !== null
    ) {
      identity = await workerProcessMatches(
        latest.workerPid,
        latest.requestPath,
        latest.workerTokenSha256,
        null,
      );
    }
    if (identity === "matched" || identity === "unverifiable") {
      return latest;
    }
    if (
      latest.status === "queued" &&
      latest.workerPid === null &&
      latest.workerTokenSha256 === null
    ) {
      return latest;
    }
    const now = new Date().toISOString();
    const failed: TesseraRunJobDocument = {
      ...latest,
      status: "failed",
      completedAt: now,
      updatedAt: now,
      workerPid: null,
      workerTokenSha256: null,
      retryBudget: retryBudgetFor(
        latest.attempt,
        "failed",
      ),
      attemptHistory: updateCurrentAttempt(
        latest.attemptHistory,
        latest.attempt,
        {
          status: "failed",
          completedAt: now,
          errorCode: "TESSERA_WORKER_EXITED",
        },
      ),
      error: {
        code: "TESSERA_WORKER_EXITED",
        message:
          "The Tessera worker exited without finalizing this attempt.",
        retryable: true,
      },
      nextAction:
        latest.attempt >= lifetimeAttemptLimit
          ? "The lifetime retry budget is exhausted. Use restart-from to begin a fresh simulation stage."
          : "Resume this run to retry the interrupted attempt without trusting partial simulation evidence.",
    };
    await writeJsonAtomic(resolvedJobPath, failed);
    return projectTesseraReliabilityEvent(
      resolvedJobPath,
      failed,
      "failure",
      "worker-exit",
    );
  } finally {
    await release();
  }
}

function terminalRunStatus(status: TesseraRunStatus): boolean {
  return [
    "complete",
    "degraded",
    "inconclusive",
    "failed",
    "cancelled",
    "needs-input",
  ].includes(status);
}

async function tesseraRunProgress(
  document: TesseraRunJobDocument,
): Promise<TesseraRunProgress> {
  const now = document.completedAt
    ? Date.parse(document.completedAt)
    : Date.now();
  const elapsedMs = Math.max(0, now - Date.parse(document.createdAt));
  const terminal = terminalRunStatus(document.status);
  let phase: TesseraRunProgress["phase"] =
    document.status === "queued"
      ? "queued"
      : terminal
        ? document.status === "complete" ||
          document.status === "degraded" ||
          document.status === "inconclusive"
          ? "complete"
          : "stopped"
        : "simulation";
  let completedWork = terminal ? 1 : 0;
  let totalWork = 1;
  if (
    document.runKind === "stress" ||
    document.runKind === "build-and-stress" ||
    document.runKind === "stress-revision"
  ) {
    try {
      const manifest = JSON.parse(
        await readFile(document.manifestPath ?? "", "utf8"),
      ) as {
        batchPreflight?: unknown;
        preparedPlayer?: unknown;
        preparedOpponents?: Record<string, unknown>;
        portfolio?: {
          items?: Array<{
            templateId?: string;
            status?: string;
            roster?: unknown;
          }>;
        };
        configuration?: { analysisStrategy?: string };
        representatives?: Array<{ templateId?: string }>;
        screening?: Record<string, { status?: string }>;
        deepDive?: Record<string, { status?: string }>;
        finalArtifacts?: unknown;
      };
      const readyIds = (manifest.portfolio?.items ?? [])
        .filter(
          (item) => item.status === "ready" && item.roster !== null,
        )
        .flatMap((item) =>
          typeof item.templateId === "string"
            ? [item.templateId]
            : [],
        );
      const fullAll =
        manifest.configuration?.analysisStrategy === "full-all";
      const representativeIds = (manifest.representatives ?? [])
        .flatMap((entry) =>
          typeof entry.templateId === "string"
            ? [entry.templateId]
            : [],
        );
      const expectedDeepDive = fullAll
        ? []
        : representativeIds.length > 0
          ? representativeIds
          : readyIds.slice(0, Math.min(3, readyIds.length));
      const preparationTotal = 1 + readyIds.length;
      const preparationCompleted =
        (manifest.preparedPlayer ? 1 : 0) +
        Object.keys(manifest.preparedOpponents ?? {}).length;
      const screeningCompleted = readyIds.filter(
        (templateId) =>
          manifest.screening?.[templateId]?.status === "complete",
      ).length;
      const deepDiveCompleted = expectedDeepDive.filter(
        (templateId) =>
          manifest.deepDive?.[templateId]?.status === "complete",
      ).length;
      totalWork =
        1 +
        preparationTotal +
        readyIds.length +
        expectedDeepDive.length +
        1;
      completedWork =
        (manifest.batchPreflight ? 1 : 0) +
        preparationCompleted +
        screeningCompleted +
        deepDiveCompleted +
        (manifest.finalArtifacts ? 1 : 0);
      phase = !manifest.batchPreflight
        ? "preflight"
        : preparationCompleted < preparationTotal
          ? "preparation"
          : screeningCompleted < readyIds.length
            ? "screening"
            : deepDiveCompleted < expectedDeepDive.length
              ? "deep-dive"
              : manifest.finalArtifacts
                ? terminal
                  ? "complete"
                  : "persistence"
                : "validation";
    } catch {
      // A not-yet-created or legacy manifest falls back to job-level progress.
    }
  }
  if (terminal) {
    if (
      document.status === "complete" ||
      document.status === "degraded" ||
      document.status === "inconclusive"
    ) {
      completedWork = totalWork;
      phase = "complete";
    } else {
      phase = "stopped";
    }
  }
  const estimatedRemainingMs =
    terminal
      ? 0
      : completedWork > 0 && completedWork < totalWork
        ? Math.max(
            0,
            Math.round(
              (elapsedMs / completedWork) *
                (totalWork - completedWork),
            ),
          )
        : null;
  return {
    phase,
    completedWork,
    totalWork,
    elapsedMs,
    estimatedRemainingMs,
    estimateSource: terminal
      ? "terminal"
      : estimatedRemainingMs === null
        ? "insufficient-evidence"
        : "timing-derived",
  };
}

export async function getTesseraRunStatus(
  jobPath: string,
  includeResult = false,
): Promise<{
  job: TesseraRunJob;
  result: TesseraRunResult | null;
  progress: TesseraRunProgress;
}> {
  const resolved = path.resolve(jobPath);
  const document = await refreshDeadWorkerStatus(
    resolved,
    await readJobDocument(resolved),
  );
  let result: TesseraRunResult | null = null;
  if (
    includeResult &&
    document.artifactReceipts.some(
      (receipt) =>
        receipt.kind === "result" &&
        receipt.attempt === document.attempt,
    )
  ) {
    try {
      const metadata = await lstat(document.resultPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw jobError(
          "TESSERA_JOB_PATH_INVALID",
          "The Tessera result is not a regular run-local file.",
        );
      }
      result = JSON.parse(
        await readFile(document.resultPath, "utf8"),
      ) as TesseraRunResult;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
  }
  return {
    job: publicJob(document),
    result,
    progress: await tesseraRunProgress(document),
  };
}

function withResumePolicy(
  request: TesseraRunRequest,
  profilePolicyPath: string | null,
  manifestPath: string | null | undefined,
  preparedCheckpoint: TesseraRunPreparedCheckpoint | null,
): TesseraRunRequest {
  if (request.kind === "stress") {
    const options = {
      ...request.options,
      profilePolicyPath:
        profilePolicyPath ??
        request.options?.profilePolicyPath,
    };
    if (manifestPath === null) {
      delete options.resumeManifestPath;
    } else if (manifestPath !== undefined) {
      options.resumeManifestPath = manifestPath;
    }
    if (options.resumeManifestPath) {
      delete options.restartManifestPath;
    }
    return {
      ...request,
      options,
    };
  }
  if (request.kind === "build-and-stress") {
    const input = {
      ...request.input,
      profilePolicyPath:
        profilePolicyPath ??
        request.input.profilePolicyPath,
    };
    const options = {
      ...request.options,
    };
    const resumeManifestPath =
      manifestPath === undefined
        ? input.resumeManifestPath ?? options.resumeManifestPath
        : manifestPath ?? undefined;
    if (resumeManifestPath) {
      input.resumeManifestPath = resumeManifestPath;
    } else if (manifestPath === null) {
      delete input.resumeManifestPath;
      delete options.resumeManifestPath;
    }
    if (resumeManifestPath) {
      delete input.restartManifestPath;
      if (
        options.resumeManifestPath ||
        options.restartManifestPath
      ) {
        options.resumeManifestPath = resumeManifestPath;
      }
      delete options.restartManifestPath;
    }
    return {
      ...request,
      input,
      options,
    };
  }
  if (request.kind === "exact") {
    return {
      ...request,
      options: {
        ...request.options,
        profilePolicyPath:
          profilePolicyPath ??
          request.options?.profilePolicyPath,
        preparedReuse:
          preparedCheckpoint
            ? {
                player: preparedCheckpoint.player,
                opponent: preparedCheckpoint.opponent,
                sourceAttempt:
                  preparedCheckpoint.sourceAttempt,
              }
            : request.options?.preparedReuse,
      },
    };
  }
  if (
    request.kind === "exact-revision" ||
    request.kind === "stress-revision"
  ) {
    return {
      ...request,
      options: {
        ...request.options,
        profilePolicyPath:
          profilePolicyPath ??
          request.options?.profilePolicyPath,
      },
    };
  }
  return {
    ...request,
    input: {
      ...request.input,
      profilePolicyPath:
        profilePolicyPath ?? request.input.profilePolicyPath,
    },
    options: {
      ...request.options,
      preparedReuse:
        preparedCheckpoint
          ? {
              player: preparedCheckpoint.player,
              opponent: preparedCheckpoint.opponent,
              sourceAttempt:
                preparedCheckpoint.sourceAttempt,
            }
          : request.options?.preparedReuse,
    },
  };
}

async function resumableWorkflowManifestPath(
  document: TesseraRunJobDocument,
): Promise<string | null> {
  if (
    !document.manifestPath ||
    path.resolve(document.manifestPath) ===
      path.resolve(document.requestPath)
  ) {
    return null;
  }
  const resolved = await assertFilesystemPathInsideJob(
    document.jobDirectory,
    document.manifestPath,
    "Workflow manifest",
  );
  const receipt = document.artifactReceipts.find(
    (candidate) =>
      candidate.kind === "workflow-manifest" &&
      path.resolve(
        document.jobDirectory,
        candidate.path,
      ) === resolved,
  );
  try {
    const metadata = await lstat(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw jobError(
        "TESSERA_RUN_MANIFEST_DRIFT",
        "The retained Tessera workflow manifest is not a regular file.",
      );
    }
    if (!receipt) {
      throw jobError(
        "TESSERA_RUN_MANIFEST_DRIFT",
        "The retained Tessera workflow manifest has no durable hash receipt.",
      );
    }
    if ((await fileSha256(resolved)) !== receipt.sha256) {
      throw jobError(
        "TESSERA_RUN_MANIFEST_DRIFT",
        "The retained Tessera workflow manifest changed after it was receipted.",
      );
    }
    return resolved;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    if (receipt) {
      throw jobError(
        "TESSERA_RUN_MANIFEST_DRIFT",
        "The receipted Tessera workflow manifest is missing.",
      );
    }
    return null;
  }
}

function assertResumeControlOptionsMatch(
  document: TesseraRunJobDocument,
  options: {
    outputDirectory?: string;
    allowOutsideRoot?: boolean;
  },
): void {
  const authoritativeOutputDirectory = path.dirname(
    document.jobDirectory,
  );
  if (
    options.outputDirectory !== undefined &&
    path.resolve(options.outputDirectory) !==
      path.resolve(authoritativeOutputDirectory)
  ) {
    throw jobError(
      "TESSERA_RUN_RESUME_CONFLICT",
      "The requested output directory conflicts with the existing Tessera job. Resume without an output override, or use restart-from to create a new run.",
    );
  }
  if (
    options.allowOutsideRoot !== undefined &&
    options.allowOutsideRoot !== false
  ) {
    throw jobError(
      "TESSERA_RUN_RESUME_CONFLICT",
      "The requested outside-root write policy conflicts with the existing Tessera job. Resume inherits the job's frozen run-local write policy.",
    );
  }
}

function freshSimulationRequest(
  request: TesseraRunRequest,
): TesseraRunRequest {
  const fresh = stripSerializedAnalysisCapabilities(request);
  if (fresh.kind === "exact") {
    if (fresh.options) {
      delete fresh.options.sessionId;
      delete fresh.options.frozenProfileRequirements;
      delete fresh.options.frozenScenarioContract;
      delete fresh.options.preparedReuse;
    }
    return fresh;
  }
  if (fresh.kind === "stress") {
    if (fresh.options) {
      delete fresh.options.resumeManifestPath;
      delete fresh.options.restartManifestPath;
      fresh.options.forceRetry = false;
    }
    return fresh;
  }
  if (fresh.kind === "build-and-stress") {
    delete fresh.input.resumeManifestPath;
    delete fresh.input.restartManifestPath;
    fresh.input.forceRetry = false;
    if (fresh.options) {
      delete fresh.options.resumeManifestPath;
      delete fresh.options.restartManifestPath;
      fresh.options.forceRetry = false;
    }
    return fresh;
  }
  if (fresh.kind === "exact-revision") {
    if (fresh.options) {
      delete fresh.options.sessionId;
      delete fresh.options.frozenProfileRequirements;
      delete fresh.options.frozenScenarioContract;
      delete fresh.options.preparedReuse;
    }
    return fresh;
  }
  if (fresh.kind === "stress-revision") {
    if (fresh.options) {
      delete fresh.options.resumeManifestPath;
      delete fresh.options.restartManifestPath;
      fresh.options.forceRetry = false;
    }
    return fresh;
  }
  if (fresh.options) {
    delete fresh.options.sessionId;
    delete fresh.options.frozenProfileRequirements;
    delete fresh.options.frozenScenarioContract;
    delete fresh.options.preparedReuse;
  }
  return fresh;
}

export async function restartTesseraRunFrom(
  jobPath: string,
  options: StartTesseraRunOptions = {},
): Promise<TesseraRunJob> {
  const resolved = path.resolve(jobPath);
  const preflight = await readJobDocument(resolved, {
    verifyInputs: true,
    verifyArtifacts: false,
  });
  const release = await acquireControlLease(
    preflight.jobDirectory,
  );
  try {
    const source = await readJobDocument(resolved, {
      verifyInputs: true,
      verifyArtifacts: false,
    });
    const activeWorker =
      await recoverStaleWorkerReservation(source);
    if (
      activeWorker ||
      source.status === "running" ||
      source.status === "queued"
    ) {
      throw jobError(
        "TESSERA_RUN_ACTIVE",
        "An active or queued Tessera run must be completed or cancelled before restart-from.",
      );
    }
    if (options.launch !== false) {
      assertDurableRuntimeAdmission(
        await jobRuntimeProvenance(),
      );
    }
    const sourceJobSha256 = await fileSha256(resolved);
    const restarted = await startTesseraRun(
      freshSimulationRequest(source.request),
      {
        outputDirectory:
          options.outputDirectory ??
          path.dirname(source.jobDirectory),
        rootDir:
          options.rootDir ??
          path.dirname(source.jobDirectory),
        allowOutsideRoot: options.allowOutsideRoot,
        launch: false,
      },
    );
    let restartedDocument = await readJobDocument(
      restarted.requestPath,
    );
    const simulationStage = source.simulationStage + 1;
    const preparedCheckpoint = source.preparedCheckpoint
      ? await copyPreparedCheckpointForRestart(
          source.preparedCheckpoint,
          restartedDocument.jobDirectory,
        )
      : null;
    const restartedRequest = preparedCheckpoint
      ? withResumePolicy(
          restartedDocument.request,
          restartedDocument.profilePolicyPath,
          null,
          preparedCheckpoint,
        )
      : restartedDocument.request;
    const requestSha256 = canonicalSha256(restartedRequest);
    const dataPins = dataPinsForRequest(restartedRequest);
    const dataPinSha256 = canonicalSha256(dataPins);
    restartedDocument = {
      ...restartedDocument,
      request: restartedRequest,
      requestSha256,
      dataPins,
      dataPinSha256,
      preparedCheckpoint,
      simulationStage,
      restartFrom: {
        runId: source.runId,
        attempt: source.attempt,
        simulationStage: source.simulationStage,
        jobSha256: sourceJobSha256,
      },
      attemptHistory: restartedDocument.attemptHistory.map(
        (entry) => ({
          ...entry,
          simulationStage,
          trigger: "restart-from",
          requestSha256,
          dataPinSha256,
        }),
      ),
      nextAction:
        preparedCheckpoint
          ? "A fresh simulation stage was created with copied, hash-verified prepared rosters; no prior simulation evidence was carried forward."
          : "A fresh simulation stage was created from hash-verified frozen inputs; no prior simulation evidence was carried forward.",
    };
    await validateJobDocumentPaths(
      restartedDocument,
      restarted.requestPath,
      true,
    );
    await writeJsonAtomic(
      restarted.requestPath,
      restartedDocument,
    );
    if (options.launch === false) {
      return publicJob(restartedDocument);
    }
    return publicJob(
      await launchWorker(
        await refreshUnstartedQueuedRuntime(restartedDocument),
      ),
    );
  } finally {
    await release();
  }
}

export async function resumeTesseraRun(
  jobPath: string,
  options: {
    launch?: boolean;
    restartFrom?: boolean;
    outputDirectory?: string;
    rootDir?: string;
    allowOutsideRoot?: boolean;
  } = {},
): Promise<TesseraRunJob> {
  if (options.restartFrom) {
    return restartTesseraRunFrom(jobPath, options);
  }
  const resolved = path.resolve(jobPath);
  const preflight = await readJobDocument(resolved);
  const release = await acquireControlLease(
    preflight.jobDirectory,
  );
  try {
    const document = await readJobDocument(resolved);
    assertResumeControlOptionsMatch(document, options);
    const activeWorker = await recoverStaleWorkerReservation(document);
    if (
      document.status === "running" ||
      document.status === "queued"
    ) {
      if (activeWorker) {
        return publicJob(document);
      }
      if (
        document.status === "queued" &&
        document.workerPid === null &&
        document.workerTokenSha256 === null
      ) {
        if (options.launch === false) {
          return publicJob(document);
        }
        return publicJob(
          await launchWorker(
            await refreshUnstartedQueuedRuntime(document),
          ),
        );
      }
    } else if (activeWorker) {
      throw jobError(
        "TESSERA_RUN_LOCKED",
        "This Tessera run still has an active worker.",
      );
    }
    if (
      document.status === "complete" ||
      document.status === "degraded" ||
      document.status === "inconclusive"
    ) {
      return publicJob(document);
    }
    if (document.attempt >= lifetimeAttemptLimit) {
      throw jobError(
        "TESSERA_RUN_RETRY_BUDGET_EXHAUSTED",
        "The five-attempt lifetime budget is exhausted. Use restart-from to create a fresh simulation stage from verified frozen inputs.",
      );
    }
    const runtimeProvenance = await jobRuntimeProvenance();
    if (options.launch !== false) {
      assertDurableRuntimeAdmission(runtimeProvenance);
    }
    const currentRuntimeIdentity =
      runtimeIdentitySha256(runtimeProvenance);
    const priorAttempt = document.attemptHistory.find(
      (entry) => entry.attempt === document.attempt,
    );
    if (
      priorAttempt &&
      priorAttempt.runtimeIdentitySha256 !==
        currentRuntimeIdentity
    ) {
      throw jobError(
        "TESSERA_RUN_RUNTIME_CHANGED",
        "Runtime identity changed after this simulation stage began. Use restart-from so evidence from different runtimes is not mixed.",
      );
    }
    const resumableManifestPath =
      await resumableWorkflowManifestPath(document);
    const nextAttempt = document.attempt + 1;
    const resumedRequest = optionsOutputDirectory(
      withResumePolicy(
        document.request,
        document.profilePolicyPath,
        resumableManifestPath,
        document.preparedCheckpoint,
      ),
      document.jobDirectory,
      nextAttempt,
    );
    const now = new Date().toISOString();
    const requestSha256 = canonicalSha256(resumedRequest);
    const dataPins = dataPinsForRequest(resumedRequest);
    const dataPinSha256 = canonicalSha256(dataPins);
    const profilePolicySha256 = profilePolicySha256For(
      document.profilePolicyPath,
      document.inputArtifacts,
    );
    let resumed: TesseraRunJobDocument = {
      ...document,
      request: resumedRequest,
      status: "queued",
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      attempt: nextAttempt,
      workerPid: null,
      workerTokenSha256: null,
      requestSha256,
      dataPins,
      dataPinSha256,
      profilePolicySha256,
      artifactReceipts:
        document.artifactReceipts.filter(
          (receipt) =>
            receipt.kind === "profile-scaffold" ||
            receipt.kind === "workflow-manifest",
        ),
      runtimeProvenance,
      runtimeIdentitySha256: currentRuntimeIdentity,
      retryBudget: retryBudgetFor(nextAttempt, "queued"),
      attemptHistory: [
        ...document.attemptHistory,
        {
          ...attemptProvenance({
            attempt: nextAttempt,
            simulationStage: document.simulationStage,
            trigger: "resume",
            status: "queued",
            at: now,
            requestSha256,
            dataPinSha256,
            profilePolicySha256,
            runtime: runtimeProvenance,
          }),
          simulationBackend:
            document.simulationProviderPin?.selectedBackend ?? null,
          simulationProviderIdentity:
            document.simulationProviderPin?.providerIdentity ?? null,
          tesseraUiIdentity:
            document.simulationProviderPin?.tesseraUiIdentity ?? null,
          providerCompatibilitySha256:
            document.simulationProviderPin
              ?.providerCompatibilitySha256 ?? null,
        },
      ],
      error: null,
      nextAction:
        nextAttempt <= automaticAttemptLimit
          ? "Wait for the resumed background run."
          : "This explicit lifetime retry is running after the three-attempt automatic budget.",
    };
    await validateJobDocumentPaths(resumed, resolved, true);
    await writeJsonAtomic(resolved, resumed);
    resumed = await projectTesseraReliabilityEvent(
      resolved,
      resumed,
      "transition",
      "queued",
    );
    if (options.launch === false) return publicJob(resumed);
    return publicJob(await launchWorker(resumed));
  } finally {
    await release();
  }
}

export async function resolveTesseraRunProfiles(
  jobPath: string,
  policy: ProfilePolicyV1,
): Promise<TesseraRunJob> {
  const resolved = path.resolve(jobPath);
  const preflight = await readJobDocument(resolved);
  const release = await acquireControlLease(
    preflight.jobDirectory,
  );
  try {
    const document = await readJobDocument(resolved);
    const activeWorker = await recoverStaleWorkerReservation(document);
    if (
      activeWorker ||
      document.status === "running" ||
      document.status === "queued"
    ) {
      throw jobError(
        "TESSERA_RUN_ACTIVE",
        "Profile choices cannot change while a Tessera worker is active.",
      );
    }
    if (document.status !== "needs-input" || !document.profileResolution) {
      throw jobError(
        "TESSERA_PROFILE_RESOLUTION_NOT_REQUIRED",
        "Profile choices can be resolved only for a retained needs-input job with exact structured requirements.",
      );
    }
    const parsed = ProfilePolicySchema.parse(policy);
    const policyValidation = validateProfilePolicy(
      document.profileResolution.requirements.map((requirement) => ({
        ...requirement,
        selectionId: null,
        selectedProfile: null,
      })),
      parsed,
    );
    if (!policyValidation.valid) {
      throw jobError(
        "TESSERA_PROFILE_POLICY_INVALID",
        policyValidation.errors[0] ??
          "The profile policy does not resolve every retained requirement exactly.",
      );
    }
    const artifact = await writeFrozenInput(
      document.jobDirectory,
      "profile-policy",
      "resolved-profile-policy.json",
      Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8"),
    );
    const inputArtifacts = [
      ...document.inputArtifacts.filter(
        (candidate) =>
          !(
            candidate.kind === "profile-policy" &&
            candidate.path === artifact.path
          ),
      ),
      artifact,
    ].sort((left, right) => left.path.localeCompare(right.path));
    const resumableManifestPath =
      await resumableWorkflowManifestPath(document);
    const updatedRequest = withResumePolicy(
      document.request,
      artifact.path,
      resumableManifestPath,
      document.preparedCheckpoint,
    );
    const requestSha256 = canonicalSha256(updatedRequest);
    const dataPins = dataPinsForRequest(updatedRequest);
    const dataPinSha256 = canonicalSha256(dataPins);
    let updated: TesseraRunJobDocument = {
      ...document,
      profilePolicyPath: artifact.path,
      inputArtifacts,
      request: updatedRequest,
      requestSha256,
      dataPins,
      dataPinSha256,
      profilePolicySha256: artifact.sha256,
      retryBudget: retryBudgetFor(
        document.attempt,
        document.status,
      ),
      attemptHistory: updateCurrentAttempt(
        document.attemptHistory,
        document.attempt,
        {
          requestSha256,
          dataPinSha256,
          profilePolicySha256: artifact.sha256,
        },
      ),
      updatedAt: new Date().toISOString(),
      nextAction:
        "Resume this run to apply the frozen profile choices.",
    };
    await validateJobDocumentPaths(updated, resolved, true);
    await writeJsonAtomic(resolved, updated);
    updated = await projectTesseraReliabilityEvent(
      resolved,
      updated,
      "approval",
      "profile-resolution",
    );
    return publicJob(updated);
  } finally {
    await release();
  }
}

export async function cancelTesseraRun(
  jobPath: string,
  dependencies: TesseraJobProcessDependencies = {},
): Promise<TesseraRunJob> {
  const resolved = path.resolve(jobPath);
  const preflight = await readJobDocument(resolved);
  const release = await acquireControlLease(
    preflight.jobDirectory,
  );
  try {
    const document = await readJobDocument(resolved);
    if (
      document.status === "complete" ||
      document.status === "degraded"
    ) {
      return publicJob(document);
    }
    const reservation = await readWorkerReservation(document);
    const candidatePid = document.workerPid ?? reservation?.pid ?? null;
    let workerIdentity:
      | "matched"
      | "not-running"
      | "mismatched"
      | "unverifiable" = "not-running";
    if (candidatePid !== null && processExists(candidatePid)) {
      if (
        !reservation ||
        reservation.pid !== candidatePid ||
        reservation.runId !== document.runId ||
        reservation.attempt !== document.attempt ||
        reservation.tokenSha256 !==
          document.workerTokenSha256 ||
        path.resolve(reservation.jobPath) !== resolved
      ) {
        throw jobError(
          "TESSERA_WORKER_IDENTITY_MISMATCH",
          "Refusing to signal a process that is not proven to own this Tessera run.",
        );
      }
      workerIdentity = await workerProcessMatches(
        candidatePid,
        resolved,
        reservation.tokenSha256,
        reservation.processStartedAt,
        dependencies,
      );
      if (
        workerIdentity === "mismatched" ||
        workerIdentity === "unverifiable"
      ) {
        throw jobError(
          "TESSERA_WORKER_IDENTITY_MISMATCH",
          "Refusing to signal a process whose command identity does not match this Tessera worker.",
        );
      }
    }
    const now = new Date().toISOString();
    let cancelled: TesseraRunJobDocument = {
      ...document,
      status: "cancelled",
      completedAt: now,
      updatedAt: now,
      retryBudget: retryBudgetFor(
        document.attempt,
        "cancelled",
      ),
      attemptHistory: updateCurrentAttempt(
        document.attemptHistory,
        document.attempt,
        {
          status: "cancelled",
          completedAt: now,
          errorCode: null,
        },
      ),
      timingSpans: closeTimingSpan(
        closeTimingSpan(
          document.timingSpans ?? [],
          "queue-wait",
          now,
        ),
        "workflow-total",
        now,
      ),
      error: null,
      nextAction:
        "Prepared remote lists are retained in the New Recruit run inventory; cancellation never deletes them.",
    };
    await writeJsonAtomic(resolved, cancelled);
    if (
      candidatePid !== null &&
      workerIdentity === "matched"
    ) {
      try {
        process.kill(candidatePid, "SIGTERM");
      } catch (error) {
        if (errorCode(error) !== "ESRCH") throw error;
      }
      const deadline = Date.now() + 2_000;
      while (processExists(candidatePid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (processExists(candidatePid)) {
        throw jobError(
          "TESSERA_WORKER_CANCEL_PENDING",
          "The verified Tessera worker has not exited yet; its reservation was retained.",
        );
      }
    }
    await removeWorkerReservation(
      document,
      reservation?.tokenSha256,
    );
    cancelled = {
      ...cancelled,
      workerPid: null,
      workerTokenSha256: null,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(resolved, cancelled);
    cancelled = await projectTesseraReliabilityEvent(
      resolved,
      cancelled,
      "transition",
      "cancelled",
    );
    return publicJob(cancelled);
  } finally {
    await release();
  }
}

function finalStatus(result: TesseraRunResult): TesseraRunStatus {
  const data = result.data as
    | TesseraMatchupReport
    | TesseraStressRunReport
    | BuildAndStressRosterResult
    | BuildAndAnalyzeRosterResult
    | TesseraRevisionComparisonReport
    | TesseraStressRevisionReport
    | null;
  const nestedStatus =
    data && "status" in data
      ? data.status
      : data && "stressReport" in data
        ? data.stressReport?.status
        : data && "matchupReport" in data
          ? data.matchupReport?.status
          : null;
  if (nestedStatus === "degraded") return "degraded";
  if (nestedStatus === "inconclusive") return "inconclusive";
  if (result.ok) return "complete";
  if (
    result.violations.some(
      (violation) =>
        violation.code === "TESSERA_PROFILE_POLICY_REQUIRED" ||
        violation.code ===
          "TESSERA_PROFILE_POLICY_REQUIRED_AFTER_ENRICHMENT",
    )
  ) {
    return "needs-input";
  }
  return "failed";
}

const retryableRunCodes = new Set([
  "LOCAL_AGENT_TIMEOUT",
  "LOCAL_AGENT_UNAVAILABLE",
  "TESSERA_BROWSER_UNAVAILABLE",
  "TESSERA_BROWSER_TIMEOUT",
  "TESSERA_BROWSER_SESSION_CLOSED",
  "TESSERA_BROWSER_NAVIGATION_FAILED",
  "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
  "TESSERA_PREMIUM_STILL_LOCKED",
  "TESSERA_MATRIX_MISSING",
  "TESSERA_MATRIX_STALE",
  "TESSERA_STALE_MATRIX",
  "TESSERA_INCOMPLETE_MATRIX",
  "TESSERA_SCENARIOS_INCOMPLETE",
  "TESSERA_EVIDENCE_INCOMPLETE",
  "TESSERA_PHASE_MATRIX_ALIAS",
  "TESSERA_METRIC_MATRIX_ALIAS",
  "TESSERA_PROXY_MATRIX_ALIAS",
  "TESSERA_MATRIX_FINGERPRINT_MISSING",
  "TESSERA_WORKER_EXITED",
]);

function resultFailureCollections(
  result: TesseraRunResult,
): Array<Array<{ retryable?: unknown; code?: unknown }>> {
  const data =
    result.data && typeof result.data === "object"
      ? result.data as Record<string, unknown>
      : null;
  if (!data) return [];
  const reports = [
    data,
    data.matchupReport,
    data.stressReport,
  ].filter(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate && typeof candidate === "object"),
  );
  return reports.flatMap((report) =>
    Array.isArray(report.failures)
      ? [
          report.failures.filter(
            (
              failure,
            ): failure is {
              retryable?: unknown;
              code?: unknown;
            } => Boolean(failure && typeof failure === "object"),
          ),
        ]
      : [],
  );
}

function resultIsRetryable(result: TesseraRunResult): boolean {
  if (
    resultFailureCollections(result)
      .flat()
      .some(
        (failure) =>
          typeof failure.code === "string" &&
          retryableRunCodes.has(failure.code),
      )
  ) {
    return true;
  }
  return result.violations.some(
    (violation) =>
      retryableRunCodes.has(violation.code),
  );
}

function profileRequirementCode(
  result: TesseraRunResult,
): TesseraProfileResolutionState["violationCode"] | null {
  const violation = result.violations.find(
    (candidate) =>
      candidate.code === "TESSERA_PROFILE_POLICY_REQUIRED" ||
      candidate.code ===
        "TESSERA_PROFILE_POLICY_REQUIRED_AFTER_ENRICHMENT",
  );
  return violation
    ? (
        violation.code as TesseraProfileResolutionState["violationCode"]
      )
    : null;
}

async function retainedProfileResolution(
  document: TesseraRunJobDocument,
  result: TesseraRunResult,
): Promise<TesseraProfileResolutionState | null> {
  const violationCode = profileRequirementCode(result);
  if (!violationCode) return null;
  const outputDirectories = requestPathEntries(document.request)
    .filter(
      (
        entry,
      ): entry is typeof entry & { value: string } =>
        entry.kind === "output" && Boolean(entry.value),
    )
    .map((entry) => path.resolve(entry.value));
  const candidateNames = [
    "profile-policy.enriched.scaffold.json",
    "profile-policy.scaffold.json",
    "tessera-profile-policy.scaffold.json",
  ];
  for (const directory of [...new Set(outputDirectories)]) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(directory, candidateName);
      await assertFilesystemPathInsideJob(
        document.jobDirectory,
        candidate,
        "Profile scaffold",
      );
      try {
        const metadata = await lstat(candidate);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        const content = await readFile(candidate);
        const parsed = ProfilePolicySchema.safeParse(
          JSON.parse(content.toString("utf8")),
        );
        return {
          violationCode,
          scaffoldPath: candidate,
          scaffoldSha256: contentSha256(content),
          scaffold: parsed.success ? parsed.data : null,
          requirements: parsed.success
            ? parsed.data.entries.map((entry) => ({
                faction: entry.faction,
                unit: entry.unit,
                ...(entry.unitOccurrence === undefined
                  ? {}
                  : { unitOccurrence: entry.unitOccurrence }),
                ...(entry.modelCount === undefined
                  ? {}
                  : { modelCount: entry.modelCount }),
                weaponGroup: entry.weaponGroup,
                phase: entry.phase,
                availableProfiles: entry.selectedProfile.startsWith(
                  "SELECT_ONE_OF: ",
                )
                  ? entry.selectedProfile
                      .slice("SELECT_ONE_OF: ".length)
                      .split("|")
                      .map((profile) => profile.trim())
                      .filter(Boolean)
                  : [],
                activeCount: entry.activeCount,
              }))
            : [],
        };
      } catch (error) {
        if (
          errorCode(error) === "ENOENT" ||
          error instanceof SyntaxError
        ) continue;
        throw error;
      }
    }
  }
  return {
    violationCode,
    scaffoldPath: null,
    scaffoldSha256: null,
    scaffold: null,
    requirements: [],
  };
}

async function executeRequest(
  request: TesseraRunRequest,
): Promise<TesseraRunResult> {
  if (request.kind === "exact") {
    return analyzeRosterMatchup(
      request.playerRoster,
      request.opponent,
      request.options,
    );
  }
  if (request.kind === "stress") {
    return runRosterStressTest(
      request.playerRoster,
      { kind: "faction", factionId: request.factionId },
      {
        ...request.options,
        retryOwner: "durable-job",
      },
    );
  }
  if (request.kind === "build-and-stress") {
    return buildAndStressRosterAgainstFaction(
      request.input,
      {
        ...request.options,
        retryOwner: "durable-job",
      },
    );
  }
  if (request.kind === "build-and-analyze") {
    return buildAndAnalyzeRosterMatchup(
      request.input,
      request.options,
    );
  }
  if (request.kind === "exact-revision") {
    return compareRosterRevision(
      request.baselineReportPath,
      request.revisedRoster,
      {
        ...request.options,
        executionMode: "simulate",
        experimental: false,
      },
    );
  }
  return compareRosterStressRevision(
    request.baselineReportPath,
    request.revisedRoster,
    {
      ...request.options,
      executionMode: "simulate",
      experimental: false,
      retryOwner: "durable-job",
    },
  );
}

function requestForDurableExecution(
  request: TesseraRunRequest,
  runId: string,
  attempt: number,
  simulationProviderPin?: TesseraRunSimulationProviderPin | null,
): TesseraRunRequest {
  const simulationBackend =
    simulationProviderPin?.selectedBackend;
  if (request.kind === "exact") {
    return {
      ...request,
      options: {
        ...request.options,
        sessionId: request.options?.sessionId ?? runId,
        simulationBackend:
          simulationBackend ?? request.options?.simulationBackend,
      },
    };
  }
  if (request.kind === "stress") {
    return {
      ...request,
      options: {
        ...request.options,
        retryOwner: "durable-job",
        durableAttemptNumber: attempt,
        simulationBackend:
          simulationBackend ?? request.options?.simulationBackend,
      },
    };
  }
  if (request.kind === "build-and-stress") {
    return {
      ...request,
      input: {
        ...request.input,
        simulationBackend:
          simulationBackend ?? request.input.simulationBackend,
      },
      options: {
        ...request.options,
        retryOwner: "durable-job",
        durableAttemptNumber: attempt,
        simulationBackend:
          simulationBackend ?? request.options?.simulationBackend,
      },
    };
  }
  if (request.kind === "build-and-analyze") {
    return {
      ...request,
      input: {
        ...request.input,
        simulationBackend:
          simulationBackend ?? request.input.simulationBackend,
      },
      options: {
        ...request.options,
        sessionId: request.options?.sessionId ?? runId,
        simulationBackend:
          simulationBackend ?? request.options?.simulationBackend,
      },
    };
  }
  if (request.kind === "exact-revision") {
    return {
      ...request,
      options: {
        ...request.options,
        executionMode: "simulate",
        experimental: false,
        sessionId: request.options?.sessionId ?? runId,
        simulationBackend:
          simulationBackend ?? request.options?.simulationBackend,
      },
    };
  }
  if (request.kind === "stress-revision") {
    return {
      ...request,
      options: {
        ...request.options,
        executionMode: "simulate",
        experimental: false,
        retryOwner: "durable-job",
        durableAttemptNumber: attempt,
        simulationBackend:
          simulationBackend ?? request.options?.simulationBackend,
      },
    };
  }
  return request;
}

async function claimWorkerReservation(
  document: TesseraRunJobDocument,
  workerToken: string,
): Promise<string> {
  const tokenSha256 = contentSha256(workerToken);
  if (document.workerTokenSha256 !== tokenSha256) {
    throw jobError(
      "TESSERA_WORKER_IDENTITY_MISMATCH",
      "The worker launch token does not match this Tessera run.",
    );
  }
  const deadline = Date.now() + 5_000;
  while (true) {
    const reservation = await readWorkerReservation(document);
    const current = await readJobDocument(document.requestPath);
    if (
      reservation &&
      reservation.runId === document.runId &&
      reservation.attempt === document.attempt &&
      path.resolve(reservation.jobPath) ===
        path.resolve(document.requestPath) &&
      reservation.tokenSha256 === tokenSha256 &&
      reservation.pid === process.pid &&
      current.workerPid === process.pid &&
      current.workerTokenSha256 === tokenSha256 &&
      current.attempt === document.attempt
    ) {
      return tokenSha256;
    }
    if (Date.now() >= deadline) {
      throw jobError(
        "TESSERA_WORKER_IDENTITY_MISMATCH",
        "The worker could not claim its matching run reservation.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function executeTesseraRunJob(
  jobPath: string,
  workerToken: string,
  overrides: {
    executeRequest?: (
      request: TesseraRunRequest,
    ) => Promise<TesseraRunResult>;
    automaticRetry?: boolean;
    scheduleAutomaticRetry?: (
      jobPath: string,
    ) => Promise<void>;
  } = {},
): Promise<void> {
  const resolved = path.resolve(jobPath);
  let document = await readJobDocument(resolved);
  let shouldScheduleAutomaticRetry = false;
  const workerTokenSha256 = await claimWorkerReservation(
    document,
    workerToken,
  );
  const releaseStart = await acquireControlLease(
    document.jobDirectory,
  );
  try {
    const latest = await readJobDocument(resolved);
    if (
      latest.workerTokenSha256 !== workerTokenSha256 ||
      latest.attempt !== document.attempt
    ) {
      throw jobError(
        "TESSERA_WORKER_IDENTITY_MISMATCH",
        "The Tessera run changed before its worker started.",
      );
    }
    if (latest.status === "cancelled") {
      await removeWorkerReservation(
        latest,
        workerTokenSha256,
      );
      return;
    }
    const startedAt = new Date().toISOString();
    const runtimeProvenance = await jobRuntimeProvenance();
    const runtimeIdentity =
      runtimeIdentitySha256(runtimeProvenance);
    if (runtimeIdentity !== latest.runtimeIdentitySha256) {
      const failedAt = new Date().toISOString();
      document = {
        ...latest,
        status: "failed",
        completedAt: failedAt,
        updatedAt: failedAt,
        workerPid: null,
        workerTokenSha256: null,
        retryBudget: retryBudgetFor(
          latest.attempt,
          "failed",
        ),
        attemptHistory: updateCurrentAttempt(
          latest.attemptHistory,
          latest.attempt,
          {
            status: "failed",
            completedAt: failedAt,
            errorCode: "TESSERA_RUN_RUNTIME_CHANGED",
          },
        ),
        timingSpans: closeTimingSpan(
          latest.timingSpans ?? [],
          "queue-wait",
          failedAt,
        ),
        error: {
          code: "TESSERA_RUN_RUNTIME_CHANGED",
          message:
            "The local-agent, source, build, browser, broker, or data identity changed after this attempt was queued. Restart-from is required before external mutation.",
          retryable: false,
        },
        nextAction:
          "Use restart-from to create a fresh simulation stage with the currently observed runtime identity.",
      };
      await writeJsonAtomic(resolved, document);
      document = await projectTesseraReliabilityEvent(
        resolved,
        document,
        "failure",
        "runtime-admission",
      );
      await removeWorkerReservation(
        document,
        workerTokenSha256,
      );
      return;
    }
    document = {
      ...latest,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      runtimeProvenance,
      runtimeIdentitySha256: runtimeIdentity,
      retryBudget: retryBudgetFor(
        latest.attempt,
        "running",
      ),
      attemptHistory: updateCurrentAttempt(
        latest.attemptHistory,
        latest.attempt,
        {
          status: "running",
          startedAt,
          runtime: runtimeProvenance,
          runtimeIdentitySha256: runtimeIdentity,
        },
      ),
      timingSpans: [
        ...closeTimingSpan(
          latest.timingSpans ?? [],
          "queue-wait",
          startedAt,
        ),
        createTimingSpanV1({
          spanKind: "execution",
          name: "worker-startup",
          startedAt: latest.createdAt,
          endedAt: startedAt,
        }),
        createTimingSpanV1({
          spanKind: "execution",
          name: "workflow-total",
          startedAt,
        }),
      ],
      nextAction: null,
    };
    await writeJsonAtomic(resolved, document);
    document = await projectTesseraReliabilityEvent(
      resolved,
      document,
      "transition",
      "running",
    );
  } finally {
    await releaseStart();
  }
  try {
    const executionRequest =
      requestForDurableExecution(
        document.request,
        document.runId,
        document.attempt,
        document.simulationProviderPin,
      );
    const result = await (
      overrides.executeRequest ?? executeRequest
    )(executionRequest);
    const releaseFinish = await acquireControlLease(
      document.jobDirectory,
    );
    try {
      const latest = await readJobDocument(resolved);
      if (
        latest.status === "cancelled" ||
        latest.workerTokenSha256 !== workerTokenSha256 ||
        latest.attempt !== document.attempt
      ) return;
      const retainedProvenance = reportProvenance(result);
      assertScenarioContractResultMatches(
        latest.scenarioContractSha256,
        result,
      );
      assertSimulationProviderPinMatchesResult(
        latest.simulationProviderPin,
        retainedProvenance,
      );
      const simulationProviderPin =
        latest.simulationProviderPin &&
        latest.simulationProviderPin.providerCompatibilitySha256 === null &&
        retainedProvenance.providerCompatibilitySha256 !== null
          ? simulationProviderPinFromProvenance(
              retainedProvenance,
              latest.attempt,
            )
          : latest.simulationProviderPin ??
            simulationProviderPinFromProvenance(
              retainedProvenance,
              latest.attempt,
            );
      await writeJsonAtomic(latest.resultPath, result);
      const status = finalStatus(result);
      const now = new Date().toISOString();
      const first = result.violations[0];
      const profileResolution =
        status === "needs-input"
          ? await retainedProfileResolution(latest, result)
          : null;
      const artifactReceipts =
        await artifactReceiptsForResult(
          latest,
          profileResolution,
          result,
        );
      const resultReceipt = artifactReceipts.find(
        (receipt) => receipt.kind === "result",
      );
      const manifestReceipt = artifactReceipts.find(
        (receipt) =>
          receipt.kind === "workflow-manifest",
      );
      const preparedCheckpoint =
        await preparedCheckpointFromResult(latest, result);
      const retryable = resultIsRetryable(result);
      shouldScheduleAutomaticRetry =
        status === "failed" &&
        retryable &&
        latest.attempt < automaticAttemptLimit;
      document = {
        ...latest,
        status,
        completedAt: now,
        updatedAt: now,
        workerPid: null,
        workerTokenSha256: null,
        artifactReceipts,
        preparedCheckpoint,
        profileResolution,
        simulationProviderPin,
        retryBudget: retryBudgetFor(latest.attempt, status),
        attemptHistory: updateCurrentAttempt(
          latest.attemptHistory,
          latest.attempt,
          {
            status,
            completedAt: now,
            resultSha256: resultReceipt?.sha256 ?? null,
            manifestSha256:
              manifestReceipt?.sha256 ?? null,
            artifactSha256s: artifactReceipts
              .map((receipt) => receipt.sha256)
              .sort(),
            connectorReceiptSha256:
              retainedProvenance.connectorReceiptSha256,
            providerCompatibilitySha256:
              retainedProvenance.providerCompatibilitySha256 ??
              simulationProviderPin?.providerCompatibilitySha256 ??
              null,
            tesseraUiIdentity:
              retainedProvenance.tesseraUiIdentity ??
              simulationProviderPin?.tesseraUiIdentity ??
              null,
            simulationBackend:
              retainedProvenance.simulationBackend ??
              simulationProviderPin?.selectedBackend ??
              null,
            simulationProviderIdentity:
              retainedProvenance.simulationProviderIdentity ??
              simulationProviderPin?.providerIdentity ??
              null,
            errorCode:
              status === "failed"
                ? first?.code ?? null
                : null,
          },
        ),
        timingSpans: closeTimingSpan(
          latest.timingSpans ?? [],
          "workflow-total",
          now,
        ),
        error:
          status === "failed" && first
            ? {
                code: first.code,
                message: first.message,
                retryable,
              }
            : null,
        nextAction:
          status === "needs-input"
            ? "Resolve the retained structured profile scaffold, then resume this run."
            : status === "inconclusive"
              ? "The statistical result is complete but does not separate the compared choices. Keep the baseline or approve a new, explicitly different candidate; do not resume this completed evidence."
            : status === "failed"
              ? shouldScheduleAutomaticRetry
                ? `Automatic retry ${latest.attempt + 1} of ${automaticAttemptLimit} is being scheduled from the frozen run manifest.`
                : latest.attempt >= lifetimeAttemptLimit
                ? "The lifetime retry budget is exhausted. Use restart-from to begin a fresh simulation stage from verified frozen inputs."
                : "Inspect the retained result and resume only after correcting the reported failure."
              : "Open the retained result and artifact bundle.",
      };
      await writeJsonAtomic(resolved, document);
      document = await projectTesseraReliabilityEvent(
        resolved,
        document,
        status === "failed" ? "failure" : "finalization",
        status,
      );
    } finally {
      await releaseFinish();
    }
  } catch (error) {
    const releaseFailure = await acquireControlLease(
      document.jobDirectory,
    );
    try {
      const latest = await readJobDocument(resolved, {
        verifyInputs: false,
      });
      if (
        latest.status === "cancelled" ||
        latest.workerTokenSha256 !== workerTokenSha256 ||
        latest.attempt !== document.attempt
      ) return;
      const now = new Date().toISOString();
      const workerErrorCode =
        errorCode(error) ??
        "TESSERA_RUN_WORKER_FAILED";
      const retryable =
        retryableRunCodes.has(workerErrorCode) ||
        /TIMEOUT|TRANSIENT|SESSION_CLOSED|NAVIGATION_FAILED/.test(
          workerErrorCode,
        );
      shouldScheduleAutomaticRetry =
        retryable &&
        latest.attempt < automaticAttemptLimit;
      document = {
        ...latest,
        status: "failed",
        completedAt: now,
        updatedAt: now,
        workerPid: null,
        workerTokenSha256: null,
        retryBudget: retryBudgetFor(
          latest.attempt,
          "failed",
        ),
        attemptHistory: updateCurrentAttempt(
          latest.attemptHistory,
          latest.attempt,
          {
            status: "failed",
            completedAt: now,
            errorCode: workerErrorCode,
          },
        ),
        timingSpans: closeTimingSpan(
          latest.timingSpans ?? [],
          "workflow-total",
          now,
        ),
        error: {
          code: workerErrorCode,
          message:
            error instanceof Error
              ? error.message
              : "The Tessera run worker failed.",
          retryable,
        },
        nextAction:
          shouldScheduleAutomaticRetry
            ? `Automatic retry ${latest.attempt + 1} of ${automaticAttemptLimit} is being scheduled after the transient worker failure.`
            : latest.attempt >= lifetimeAttemptLimit
            ? "The lifetime retry budget is exhausted. Use restart-from to begin a fresh simulation stage from verified frozen inputs."
            : "Inspect the worker failure and resume after correcting the cause.",
      };
      await writeJsonAtomic(resolved, document);
      document = await projectTesseraReliabilityEvent(
        resolved,
        document,
        "failure",
        "worker",
      );
    } finally {
      await releaseFailure();
    }
  } finally {
    await removeWorkerReservation(
      document,
      workerTokenSha256,
    );
  }
  if (
    shouldScheduleAutomaticRetry &&
    overrides.automaticRetry !== false
  ) {
    if (overrides.scheduleAutomaticRetry) {
      await overrides.scheduleAutomaticRetry(resolved);
    } else {
      await resumeTesseraRun(resolved);
    }
  }
}
