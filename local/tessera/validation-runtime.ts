import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  rosterExecutionFingerprint,
  type ProfilePolicyV1,
  type RosterDraftV1,
  type TesseraMatchupReport,
  type TesseraMetric,
  type TesseraScenarioCell,
  type TesseraScenarioResult,
  type TesseraStressPortfolio,
  type TesseraStressRunReport,
  type TesseraStressTestReport,
} from "../../lib/rosterpilot";
import {
  closeNewRecruitLocalAgentSession,
  closeTesseraLocalAgentSession,
} from "../agent/client";
import {
  rosterPilotSupportDirectory,
} from "../agent/paths";
import {
  getTesseraRunStatus,
  resumeTesseraRun,
  startTesseraRun,
  type StartTesseraRunOptions,
  type TesseraRunJob,
  type TesseraRunRequest,
  type TesseraRunResult,
} from "./jobs";
import {
  TESSERA_SCENARIO_METRICS,
  TESSERA_SCENARIO_PHASES,
} from "./scenario-contract";
import {
  TESSERA_WEB_CAPTURES_PER_OPPONENT,
  advanceTesseraValidationWorkflow,
  confirmTesseraValidationRemainingSix,
  confirmTesseraValidationSuccessor,
  createTesseraValidationWorkflow,
  readTesseraValidationWorkflow,
  type AdvanceTesseraValidationWorkflowResult,
  type CreateTesseraValidationWorkflowInput,
  type TesseraValidationJobExecutionStatus,
  type TesseraValidationJobReference,
  type TesseraValidationLocalJobSnapshot,
  type TesseraValidationLocalLaunchRequest,
  type TesseraValidationWebBatchKind,
  type TesseraValidationWebJobSnapshot,
  type TesseraValidationWebLaunchRequest,
  type TesseraValidationWorkflowDependencies,
  type TesseraValidationWorkflowDocumentV1,
} from "./validation-workflow";

const sha256Pattern = /^[0-9a-f]{64}$/;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const batchLockStaleMs = 30_000;
const batchLockWaitMs = 5_000;

const webMetrics = [...TESSERA_SCENARIO_METRICS] satisfies TesseraMetric[];

export type TesseraValidationRuntimeOptions = {
  storeRoot?: string;
  runRoot?: string;
  startRun?: (
    request: TesseraRunRequest,
    options?: StartTesseraRunOptions,
  ) => Promise<TesseraRunJob>;
  getRunStatus?: typeof getTesseraRunStatus;
  resumeRun?: typeof resumeTesseraRun;
  closeNewRecruitSession?: typeof closeNewRecruitLocalAgentSession;
  closeTesseraSession?: typeof closeTesseraLocalAgentSession;
  now?: () => string;
};

export type TesseraValidationWebBatchStatus =
  | "queued"
  | "running"
  | "complete"
  | "degraded"
  | "inconclusive"
  | "failed";

export type TesseraValidationWebExactReceiptV1 = {
  templateId: string;
  rosterFingerprint: string;
  jobPath: string;
  runId: string;
  launchedAt: string;
  completedAt: string | null;
  status: TesseraValidationJobExecutionStatus;
  requestSha256: string;
  resultSha256: string | null;
  reportSha256: string | null;
  deploymentIdentitySha256: string | null;
  playerSemanticSha256: string | null;
  trustedEvidence: boolean;
  errorCode: string | null;
};

export type TesseraValidationWebBatchDocumentV1 = {
  schemaVersion: 1;
  documentKind: "tessera-validation-web-batch";
  batchId: string;
  workflowId: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  status: TesseraValidationWebBatchStatus;
  batchKind: TesseraValidationWebBatchKind;
  portfolioSha256: string;
  playerFingerprint: string;
  playerRoster: RosterDraftV1;
  profilePolicy: ProfilePolicyV1 | null;
  portfolio: TesseraStressPortfolio;
  templateIds: string[];
  representativeTemplateIds: string[];
  sessionId: string;
  localJob: TesseraValidationJobReference;
  successorOf: TesseraValidationJobReference | null;
  exactJobs: TesseraValidationWebExactReceiptV1[];
  completedTemplateIds: string[];
  expectedCaptureCount: number;
  capturedScenarioCount: number;
  deploymentIdentitySha256: string | null;
  playerSemanticSha256: string | null;
  comparison:
    | "within-local-bands"
    | "material-divergence"
    | "inconclusive"
    | "not-evaluated";
  trustedEvidence: boolean;
  requiresSuccessor: boolean;
  errorCode: string | null;
  sessionsClosedAt: string | null;
  warnings: string[];
};

type WebBatchRevisionV1 = {
  schemaVersion: 1;
  revisionKind: "tessera-validation-web-batch-revision";
  batchId: string;
  sequence: number;
  previousRevision: {
    filename: string;
    sha256: string;
  } | null;
  stateSha256: string;
  state: TesseraValidationWebBatchDocumentV1;
  revisionSha256: string;
};

type WebBatchHeadV1 = {
  schemaVersion: 1;
  headKind: "tessera-validation-web-batch-head";
  batchId: string;
  sequence: number;
  revisionFilename: string;
  revisionSha256: string;
  headSha256: string;
};

export type TesseraValidationWebBatchVerification = {
  state: TesseraValidationWebBatchDocumentV1;
  head: WebBatchHeadV1;
  revisionCount: number;
};

type RuntimeAdapters = Required<
  Pick<
    TesseraValidationRuntimeOptions,
    | "startRun"
    | "getRunStatus"
    | "resumeRun"
    | "closeNewRecruitSession"
    | "closeTesseraSession"
    | "now"
  >
> & {
  storeRoot: string;
  runRoot: string;
};

type TrustedExactReport = {
  report: TesseraMatchupReport;
  resultSha256: string;
  reportSha256: string;
  scenarioCount: number;
  deploymentIdentitySha256: string;
  playerSemanticSha256: string;
};

type DiagnosticComparison = {
  status:
    | "within-local-bands"
    | "material-divergence"
    | "inconclusive";
  comparableCells: number;
  outsideBandCells: number;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function valueSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function nowIso(adapters: RuntimeAdapters): string {
  const value = adapters.now();
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("The validation runtime clock returned an invalid time.");
  }
  return value;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = uniqueSorted(left);
  const normalizedRight = uniqueSorted(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (value, index) => value === normalizedRight[index],
    )
  );
}

function assertSafeId(value: string, label: string): void {
  if (!safeIdPattern.test(value)) {
    throw new Error(`${label} is not safe.`);
  }
}

export function defaultTesseraValidationStoreRoot(): string {
  return path.join(
    rosterPilotSupportDirectory(),
    "tessera-validation",
    "workflows",
  );
}

export function defaultTesseraValidationRunRoot(): string {
  return path.join(
    rosterPilotSupportDirectory(),
    "tessera-validation",
    "runs",
  );
}

function runtimeAdapters(
  options: TesseraValidationRuntimeOptions = {},
): RuntimeAdapters {
  return {
    storeRoot: path.resolve(
      options.storeRoot ?? defaultTesseraValidationStoreRoot(),
    ),
    runRoot: path.resolve(
      options.runRoot ?? defaultTesseraValidationRunRoot(),
    ),
    startRun: options.startRun ?? startTesseraRun,
    getRunStatus: options.getRunStatus ?? getTesseraRunStatus,
    resumeRun: options.resumeRun ?? resumeTesseraRun,
    closeNewRecruitSession:
      options.closeNewRecruitSession ?? closeNewRecruitLocalAgentSession,
    closeTesseraSession:
      options.closeTesseraSession ?? closeTesseraLocalAgentSession,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

async function writeAtomic(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${canonicalJson(value)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, filename);
}

async function writeProfilePolicy(
  directory: string,
  policy: ProfilePolicyV1 | null,
): Promise<string | undefined> {
  if (!policy) return undefined;
  const filename = path.join(directory, "profile-policy.json");
  await writeAtomic(filename, policy);
  return filename;
}

function batchDirectory(runRoot: string, batchId: string): string {
  assertSafeId(batchId, "The Web batch ID");
  return path.join(runRoot, "web-batches", batchId);
}

function batchHeadPath(runRoot: string, batchId: string): string {
  return path.join(batchDirectory(runRoot, batchId), "head.json");
}

function batchRevisionsDirectory(runRoot: string, batchId: string): string {
  return path.join(batchDirectory(runRoot, batchId), "revisions");
}

function batchIdFromReference(
  reference: TesseraValidationJobReference,
): string {
  if (!reference.runId) {
    throw new Error("The Web batch reference has no batch identity.");
  }
  assertSafeId(reference.runId, "The Web batch reference");
  return reference.runId;
}

function headPayload(
  head: WebBatchHeadV1,
): Omit<WebBatchHeadV1, "headSha256"> {
  return {
    schemaVersion: head.schemaVersion,
    headKind: head.headKind,
    batchId: head.batchId,
    sequence: head.sequence,
    revisionFilename: head.revisionFilename,
    revisionSha256: head.revisionSha256,
  };
}

function revisionPayload(
  revision: WebBatchRevisionV1,
): Omit<WebBatchRevisionV1, "revisionSha256"> {
  return {
    schemaVersion: revision.schemaVersion,
    revisionKind: revision.revisionKind,
    batchId: revision.batchId,
    sequence: revision.sequence,
    previousRevision: revision.previousRevision,
    stateSha256: revision.stateSha256,
    state: revision.state,
  };
}

function parseBatchHead(value: unknown): WebBatchHeadV1 {
  const head = value as Partial<WebBatchHeadV1>;
  if (
    head.schemaVersion !== 1 ||
    head.headKind !== "tessera-validation-web-batch-head" ||
    typeof head.batchId !== "string" ||
    typeof head.sequence !== "number" ||
    typeof head.revisionFilename !== "string" ||
    typeof head.revisionSha256 !== "string" ||
    typeof head.headSha256 !== "string" ||
    !sha256Pattern.test(head.revisionSha256) ||
    !sha256Pattern.test(head.headSha256)
  ) {
    throw new Error("The Tessera validation Web batch head is malformed.");
  }
  assertSafeId(head.batchId, "The Web batch ID");
  if (valueSha256(headPayload(head as WebBatchHeadV1)) !== head.headSha256) {
    throw new Error("The Tessera validation Web batch head seal is invalid.");
  }
  return head as WebBatchHeadV1;
}

function readyPortfolioItems(
  portfolio: TesseraStressPortfolio,
): Array<
  TesseraStressPortfolio["items"][number] & { roster: RosterDraftV1 }
> {
  return portfolio.items.filter(
    (
      item,
    ): item is TesseraStressPortfolio["items"][number] & {
      roster: RosterDraftV1;
    } => item.status === "ready" && item.roster !== null,
  );
}

function parseBatchState(
  value: unknown,
): TesseraValidationWebBatchDocumentV1 {
  const state = value as Partial<TesseraValidationWebBatchDocumentV1>;
  if (
    state.schemaVersion !== 1 ||
    state.documentKind !== "tessera-validation-web-batch" ||
    typeof state.batchId !== "string" ||
    typeof state.workflowId !== "string" ||
    typeof state.sequence !== "number" ||
    !Array.isArray(state.templateIds) ||
    !Array.isArray(state.exactJobs) ||
    !Array.isArray(state.completedTemplateIds) ||
    !Array.isArray(state.warnings)
  ) {
    throw new Error("The Tessera validation Web batch is malformed.");
  }
  assertSafeId(state.batchId, "The Web batch ID");
  assertSafeId(state.workflowId, "The validation workflow ID");
  const parsed = state as TesseraValidationWebBatchDocumentV1;
  const items = readyPortfolioItems(parsed.portfolio);
  const itemIds = new Set(items.map((item) => item.templateId));
  const expectedTemplateCount =
    parsed.batchKind === "representative-three"
      ? 3
      : parsed.batchKind === "exhaustive-nine"
        ? 9
        : 6;
  if (
    !sha256Pattern.test(parsed.portfolioSha256) ||
    valueSha256(parsed.portfolio) !== parsed.portfolioSha256 ||
    !sha256Pattern.test(parsed.playerFingerprint) ||
    rosterExecutionFingerprint(parsed.playerRoster) !==
      parsed.playerFingerprint ||
    !safeIdPattern.test(parsed.sessionId) ||
    parsed.templateIds.length !== expectedTemplateCount ||
    uniqueSorted(parsed.templateIds).length !== parsed.templateIds.length ||
    parsed.templateIds.some((templateId) => !itemIds.has(templateId)) ||
    parsed.completedTemplateIds.some(
      (templateId) => !parsed.templateIds.includes(templateId),
    ) ||
    parsed.exactJobs.length > parsed.templateIds.length ||
    parsed.exactJobs.some(
      (receipt, index) =>
        receipt.templateId !== parsed.templateIds[index] ||
        !sha256Pattern.test(receipt.rosterFingerprint) ||
        !sha256Pattern.test(receipt.requestSha256) ||
        (receipt.resultSha256 !== null &&
          !sha256Pattern.test(receipt.resultSha256)) ||
        (receipt.reportSha256 !== null &&
          !sha256Pattern.test(receipt.reportSha256)),
    ) ||
    parsed.expectedCaptureCount !==
      parsed.templateIds.length * TESSERA_WEB_CAPTURES_PER_OPPONENT
  ) {
    throw new Error("The Tessera validation Web batch is inconsistent.");
  }
  return parsed;
}

function parseBatchRevision(value: unknown): WebBatchRevisionV1 {
  const revision = value as Partial<WebBatchRevisionV1>;
  if (
    revision.schemaVersion !== 1 ||
    revision.revisionKind !==
      "tessera-validation-web-batch-revision" ||
    typeof revision.batchId !== "string" ||
    typeof revision.sequence !== "number" ||
    typeof revision.stateSha256 !== "string" ||
    typeof revision.revisionSha256 !== "string" ||
    !sha256Pattern.test(revision.stateSha256) ||
    !sha256Pattern.test(revision.revisionSha256)
  ) {
    throw new Error("A Tessera validation Web batch revision is malformed.");
  }
  if (
    revision.previousRevision !== null &&
    (typeof revision.previousRevision !== "object" ||
      typeof revision.previousRevision.filename !== "string" ||
      typeof revision.previousRevision.sha256 !== "string" ||
      !sha256Pattern.test(revision.previousRevision.sha256))
  ) {
    throw new Error("A Web batch revision link is malformed.");
  }
  const state = parseBatchState(revision.state);
  if (
    state.batchId !== revision.batchId ||
    state.sequence !== revision.sequence ||
    valueSha256(state) !== revision.stateSha256 ||
    valueSha256(revisionPayload(revision as WebBatchRevisionV1)) !==
      revision.revisionSha256
  ) {
    throw new Error("A Tessera validation Web batch revision seal is invalid.");
  }
  return revision as WebBatchRevisionV1;
}

async function appendBatchRevision(
  runRoot: string,
  state: TesseraValidationWebBatchDocumentV1,
  previous: WebBatchHeadV1 | null,
): Promise<WebBatchHeadV1> {
  const unsignedRevision = {
    schemaVersion: 1 as const,
    revisionKind: "tessera-validation-web-batch-revision" as const,
    batchId: state.batchId,
    sequence: state.sequence,
    previousRevision: previous
      ? {
          filename: previous.revisionFilename,
          sha256: previous.revisionSha256,
        }
      : null,
    stateSha256: valueSha256(state),
    state,
  };
  const revisionSha256 = valueSha256(unsignedRevision);
  const revision: WebBatchRevisionV1 = {
    ...unsignedRevision,
    revisionSha256,
  };
  const filename = `${String(state.sequence).padStart(8, "0")}-${revisionSha256}.json`;
  const revisionPath = path.join(
    batchRevisionsDirectory(runRoot, state.batchId),
    filename,
  );
  await mkdir(path.dirname(revisionPath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(revisionPath, `${canonicalJson(revision)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = parseBatchRevision(
      JSON.parse(await readFile(revisionPath, "utf8")),
    );
    if (existing.revisionSha256 !== revisionSha256) throw error;
  }
  const unsignedHead = {
    schemaVersion: 1 as const,
    headKind: "tessera-validation-web-batch-head" as const,
    batchId: state.batchId,
    sequence: state.sequence,
    revisionFilename: filename,
    revisionSha256,
  };
  const head: WebBatchHeadV1 = {
    ...unsignedHead,
    headSha256: valueSha256(unsignedHead),
  };
  await writeAtomic(batchHeadPath(runRoot, state.batchId), head);
  return head;
}

async function readBatchVerification(
  runRoot: string,
  batchId: string,
): Promise<TesseraValidationWebBatchVerification> {
  const head = parseBatchHead(
    JSON.parse(
      await readFile(batchHeadPath(runRoot, batchId), "utf8"),
    ),
  );
  if (head.batchId !== batchId) {
    throw new Error("The Web batch head has the wrong identity.");
  }
  let filename: string | null = head.revisionFilename;
  let expectedSha256: string | null = head.revisionSha256;
  let expectedSequence = head.sequence;
  let newestState: TesseraValidationWebBatchDocumentV1 | null = null;
  let revisionCount = 0;
  const visited = new Set<string>();
  while (filename !== null && expectedSha256 !== null) {
    if (path.basename(filename) !== filename || visited.has(filename)) {
      throw new Error("The Web batch revision chain is unsafe.");
    }
    visited.add(filename);
    const revision = parseBatchRevision(
      JSON.parse(
        await readFile(
          path.join(batchRevisionsDirectory(runRoot, batchId), filename),
          "utf8",
        ),
      ),
    );
    if (
      revision.batchId !== batchId ||
      revision.revisionSha256 !== expectedSha256 ||
      revision.sequence !== expectedSequence
    ) {
      throw new Error("The Web batch revision chain has a gap.");
    }
    newestState ??= revision.state;
    revisionCount += 1;
    filename = revision.previousRevision?.filename ?? null;
    expectedSha256 = revision.previousRevision?.sha256 ?? null;
    expectedSequence -= 1;
  }
  if (!newestState || expectedSequence !== 0 || revisionCount !== head.sequence) {
    throw new Error("The Web batch revision chain is incomplete.");
  }
  const directory = batchDirectory(runRoot, batchId);
  for (const receipt of newestState.exactJobs) {
    const relative = path.relative(directory, path.resolve(receipt.jobPath));
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("A Web batch exact-job path escaped its batch directory.");
    }
  }
  return { state: newestState, head, revisionCount };
}

async function withBatchLock<T>(
  runRoot: string,
  batchId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const directory = batchDirectory(runRoot, batchId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".lock");
  const deadline = Date.now() + batchLockWaitMs;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const observed = await stat(lock);
        if (Date.now() - observed.mtimeMs > batchLockStaleMs) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the Web batch lease.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function jobStatus(
  status: TesseraRunJob["status"],
): TesseraValidationJobExecutionStatus {
  return status;
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{2,128}$/.test(error.code)
  ) {
    return error.code;
  }
  return "TESSERA_VALIDATION_RUNTIME_FAILED";
}

function currentResultReceipt(job: TesseraRunJob): string | null {
  return (
    job.artifactReceipts.find(
      (receipt) =>
        receipt.kind === "result" && receipt.attempt === job.attempt,
    )?.sha256 ?? null
  );
}

function stressReportFromResult(
  result: TesseraRunResult | null,
): TesseraStressRunReport | null {
  const data = result?.data;
  if (
    !data ||
    typeof data !== "object" ||
    !("reportKind" in data) ||
    (data.reportKind !== "tessera-stress-test" &&
      data.reportKind !== "tessera-stress-preparation-failure")
  ) {
    return null;
  }
  return data as TesseraStressRunReport;
}

function completedLocalTemplates(
  report: TesseraStressTestReport,
): string[] {
  const deepDive = report.stageProvenance.deepDive;
  if (!deepDive) return [];
  const expectedScenarioKeys = new Set(
    TESSERA_SCENARIO_PHASES.flatMap((phase) =>
      ["player-to-opponent", "opponent-to-player"].flatMap((direction) =>
        TESSERA_SCENARIO_METRICS.map(
          (metric) => `${phase}:${direction}:${metric}`,
        ),
      ),
    ),
  );
  return uniqueSorted(
    deepDive.proxyRuns.flatMap((proxy) => {
      const keys = new Set(
        proxy.scenarios.map(
          (scenario) =>
            `${scenario.phase}:${scenario.direction}:${scenario.metric}`,
        ),
      );
      return keys.size === expectedScenarioKeys.size &&
        [...expectedScenarioKeys].every((key) => keys.has(key))
        ? [proxy.templateId]
        : [];
    }),
  );
}

function manifestSupportsTrustedLocalReport(
  value: unknown,
  report: TesseraStressTestReport,
  job: TesseraRunJob,
): boolean {
  const manifest = value as {
    schemaVersion?: unknown;
    reportKind?: unknown;
    runId?: unknown;
    portfolioSha256?: unknown;
    configuration?: { analysisStrategy?: unknown };
    finalArtifacts?: { jsonSha256?: unknown };
  };
  return (
    manifest.schemaVersion === 7 &&
    manifest.reportKind === "tessera-stress-manifest" &&
    manifest.runId === report.runId &&
    manifest.portfolioSha256 === report.portfolioSha256 &&
    manifest.configuration?.analysisStrategy === "full-all" &&
    Boolean(
      job.artifactReceipts.find(
        (receipt) =>
          receipt.kind === "workflow-manifest" &&
          receipt.attempt === job.attempt,
      ),
    )
  );
}

async function trustedLocalSnapshot(
  reference: TesseraValidationJobReference,
  adapters: RuntimeAdapters,
): Promise<TesseraValidationLocalJobSnapshot> {
  let status: Awaited<ReturnType<typeof getTesseraRunStatus>>;
  try {
    status = await adapters.getRunStatus(reference.jobId, true);
  } catch (error) {
    return {
      executionStatus: "failed",
      trustedEvidence: false,
      portfolioSha256: null,
      completedTemplateIds: [],
      representatives: [],
      errorCode: errorCode(error),
    };
  }
  if (reference.runId && status.job.runId !== reference.runId) {
    return {
      executionStatus: "failed",
      trustedEvidence: false,
      portfolioSha256: null,
      completedTemplateIds: [],
      representatives: [],
      errorCode: "TESSERA_VALIDATION_LOCAL_JOB_IDENTITY_CHANGED",
    };
  }
  const executionStatus = jobStatus(status.job.status);
  if (["queued", "running"].includes(executionStatus)) {
    return {
      executionStatus,
      trustedEvidence: false,
      portfolioSha256: null,
      completedTemplateIds: [],
      representatives: [],
      errorCode: null,
    };
  }
  const report = stressReportFromResult(status.result);
  if (
    !report ||
    report.reportKind !== "tessera-stress-test" ||
    !status.result?.ok ||
    !["complete", "degraded"].includes(status.job.status) ||
    !["complete", "degraded"].includes(report.status) ||
    report.source !== "tessera-local-engine" ||
    report.suite !== "diverse-9" ||
    report.configuration.analysisStrategy !== "full-all" ||
    report.integrity.status !== "verified" ||
    report.simulation?.status !== "complete" ||
    report.simulation.selectedBackend !== "local-engine" ||
    report.simulation.trustedMatrices <
      report.portfolio.items.length * TESSERA_WEB_CAPTURES_PER_OPPONENT ||
    !currentResultReceipt(status.job) ||
    !status.job.manifestPath
  ) {
    return {
      executionStatus,
      trustedEvidence: false,
      portfolioSha256:
        report?.reportKind === "tessera-stress-test"
          ? report.portfolioSha256
          : null,
      completedTemplateIds: [],
      representatives: [],
      errorCode:
        status.job.error?.code ?? "TESSERA_VALIDATION_LOCAL_EVIDENCE_INVALID",
    };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(status.job.manifestPath, "utf8"));
  } catch {
    return {
      executionStatus,
      trustedEvidence: false,
      portfolioSha256: report.portfolioSha256,
      completedTemplateIds: [],
      representatives: [],
      errorCode: "TESSERA_VALIDATION_LOCAL_MANIFEST_UNAVAILABLE",
    };
  }
  const completedTemplateIds = completedLocalTemplates(report);
  const frozenTemplateIds = readyPortfolioItems(report.portfolio).map(
    (item) => item.templateId,
  );
  const trustedEvidence =
    manifestSupportsTrustedLocalReport(manifest, report, status.job) &&
    sameStrings(completedTemplateIds, frozenTemplateIds) &&
    report.frozenOpponentArtifacts.length === frozenTemplateIds.length;
  return {
    executionStatus,
    trustedEvidence,
    portfolioSha256: report.portfolioSha256,
    completedTemplateIds,
    representatives: trustedEvidence ? report.representatives : [],
    errorCode: trustedEvidence
      ? null
      : "TESSERA_VALIDATION_LOCAL_EVIDENCE_INVALID",
  };
}

function exactScenarioKeys(report: TesseraMatchupReport): Set<string> {
  return new Set(
    (report.simulation.scenarios ?? []).flatMap((scenario) =>
      (scenario.metricRuns ?? []).map(
        (run) =>
          `${scenario.phase}:${scenario.direction}:${run.metric}`,
      ),
    ),
  );
}

function exactScenarioRunCount(report: TesseraMatchupReport): number {
  return (report.simulation.scenarios ?? []).reduce(
    (total, scenario) => total + (scenario.metricRuns?.length ?? 0),
    0,
  );
}

function trustedExactReport(
  job: TesseraRunJob,
  result: TesseraRunResult | null,
  expectedPlayerFingerprint: string,
  expectedOpponentFingerprint: string,
): TrustedExactReport | null {
  const report = result?.data;
  if (
    !result?.ok ||
    !report ||
    typeof report !== "object" ||
    !("simulation" in report) ||
    !("opponents" in report) ||
    !("player" in report)
  ) {
    return null;
  }
  const matchup = report as TesseraMatchupReport;
  const evidence = matchup.simulation.providerEvidence;
  const envelope = matchup.providerCompatibility;
  const resultSha256 = currentResultReceipt(job);
  const scenarioKeys = exactScenarioKeys(matchup);
  if (
    !["complete", "degraded"].includes(job.status) ||
    !["complete", "degraded"].includes(matchup.status) ||
    matchup.source !== "tessera-ui" ||
    matchup.simulation.status !== "complete" ||
    matchup.simulation.selectedBackend !== "website" ||
    !resultSha256 ||
    matchup.player.fingerprint !== expectedPlayerFingerprint ||
    matchup.opponents.length !== 1 ||
    matchup.opponents[0]?.fingerprint !== expectedOpponentFingerprint ||
    !evidence?.deployment.complete ||
    !evidence.deployment.identitySha256 ||
    !evidence.importSemantics.complete ||
    !evidence.importSemantics.playerSha256 ||
    !evidence.importSemantics.stateBindings?.player ||
    !evidence.importSemantics.stateBindings.opponent ||
    !envelope?.complete ||
    !sha256Pattern.test(envelope.envelopeSha256 ?? "") ||
    scenarioKeys.size !== TESSERA_WEB_CAPTURES_PER_OPPONENT ||
    exactScenarioRunCount(matchup) !== TESSERA_WEB_CAPTURES_PER_OPPONENT ||
    (matchup.simulation.scenarios ?? []).some(
      (scenario) => scenario.status !== "complete",
    )
  ) {
    return null;
  }
  return {
    report: matchup,
    resultSha256,
    reportSha256: valueSha256(matchup),
    scenarioCount: scenarioKeys.size,
    deploymentIdentitySha256: evidence.deployment.identitySha256,
    playerSemanticSha256: evidence.importSemantics.playerSha256,
  };
}

function scenarioMetricValue(
  cell: TesseraScenarioCell,
  metric: TesseraMetric,
): number | null {
  switch (metric) {
    case "wipe-probability":
      return cell.values.wipeProbability;
    case "half-wipe-probability":
      return cell.values.halfWipeProbability;
    case "mean-kills":
      return cell.values.meanKills;
    case "mean-damage":
      return cell.values.meanDamage;
  }
}

function scenarioCellKey(cell: TesseraScenarioCell): string {
  const unitKey = (unit: TesseraScenarioCell["attacker"]): string =>
    `${unit.selectionId ?? unit.name}:${unit.ordinal}:${unit.modelCount}`;
  return `${unitKey(cell.attacker)}>${unitKey(cell.target)}`;
}

function scenarioRunMap(
  report: TesseraMatchupReport,
  opponentName: string,
): Map<string, { scenario: TesseraScenarioResult; metric: TesseraMetric }> {
  const output = new Map<
    string,
    { scenario: TesseraScenarioResult; metric: TesseraMetric }
  >();
  for (const scenario of report.simulation.scenarios ?? []) {
    if (scenario.opponentName !== opponentName) continue;
    for (const run of scenario.metricRuns ?? []) {
      const key = `${scenario.phase}:${scenario.direction}:${run.metric}`;
      if (output.has(key)) return new Map();
      output.set(key, { scenario, metric: run.metric });
    }
  }
  return output;
}

function diagnosticReportComparison(
  localReport: TesseraMatchupReport,
  webReport: TesseraMatchupReport,
  expectedOpponentFingerprint: string,
): DiagnosticComparison {
  const localOpponent = localReport.opponents.find(
    (opponent) => opponent.fingerprint === expectedOpponentFingerprint,
  );
  const webOpponent = webReport.opponents.find(
    (opponent) => opponent.fingerprint === expectedOpponentFingerprint,
  );
  if (!localOpponent || !webOpponent) {
    return { status: "inconclusive", comparableCells: 0, outsideBandCells: 0 };
  }
  const localRuns = scenarioRunMap(localReport, localOpponent.rosterName);
  const webRuns = scenarioRunMap(webReport, webOpponent.rosterName);
  if (
    localRuns.size !== TESSERA_WEB_CAPTURES_PER_OPPONENT ||
    webRuns.size !== TESSERA_WEB_CAPTURES_PER_OPPONENT ||
    !sameStrings([...localRuns.keys()], [...webRuns.keys()])
  ) {
    return { status: "inconclusive", comparableCells: 0, outsideBandCells: 0 };
  }
  let comparableCells = 0;
  let outsideBandCells = 0;
  for (const [runKey, localRun] of localRuns) {
    const webRun = webRuns.get(runKey)!;
    const localCells = new Map(
      localRun.scenario.cells.map((cell) => [scenarioCellKey(cell), cell]),
    );
    const webCells = new Map(
      webRun.scenario.cells.map((cell) => [scenarioCellKey(cell), cell]),
    );
    if (!sameStrings([...localCells.keys()], [...webCells.keys()])) {
      return {
        status: "inconclusive",
        comparableCells,
        outsideBandCells,
      };
    }
    for (const [cellKey, localCell] of localCells) {
      const webCell = webCells.get(cellKey)!;
      const localValue = scenarioMetricValue(localCell, localRun.metric);
      const webValue = scenarioMetricValue(webCell, webRun.metric);
      if (
        localValue === null ||
        webValue === null ||
        !Number.isFinite(localValue) ||
        !Number.isFinite(webValue)
      ) {
        return {
          status: "inconclusive",
          comparableCells,
          outsideBandCells,
        };
      }
      const standardError =
        localCell.uncertainty?.[localRun.metric]?.standardError ?? null;
      const fallbackTolerance =
        localRun.metric === "wipe-probability" ||
        localRun.metric === "half-wipe-probability"
          ? 0.05
          : Math.max(0.25, Math.abs(localValue) * 0.1);
      const tolerance =
        standardError !== null && Number.isFinite(standardError)
          ? Math.max(fallbackTolerance, standardError * 2)
          : fallbackTolerance;
      comparableCells += 1;
      if (Math.abs(webValue - localValue) > tolerance) {
        outsideBandCells += 1;
      }
    }
  }
  if (comparableCells === 0) {
    return { status: "inconclusive", comparableCells: 0, outsideBandCells: 0 };
  }
  const materialThreshold = Math.max(1, Math.ceil(comparableCells * 0.1));
  return {
    status:
      outsideBandCells >= materialThreshold
        ? "material-divergence"
        : "within-local-bands",
    comparableCells,
    outsideBandCells,
  };
}

function localChildReport(
  report: TesseraStressTestReport,
): TesseraMatchupReport | null {
  return report.deepDiveReport ?? report.screeningReport;
}

async function readTrustedLocalStressReport(
  reference: TesseraValidationJobReference,
  adapters: RuntimeAdapters,
): Promise<TesseraStressTestReport | null> {
  const snapshot = await trustedLocalSnapshot(reference, adapters);
  if (!snapshot.trustedEvidence) return null;
  const status = await adapters.getRunStatus(reference.jobId, true);
  const report = stressReportFromResult(status.result);
  return report?.reportKind === "tessera-stress-test" ? report : null;
}

function unsafeTerminalFailure(
  job: TesseraRunJob,
  result: TesseraRunResult | null,
): boolean {
  const codes = [
    job.error?.code,
    ...(result?.violations.map((violation) => violation.code) ?? []),
  ].filter((code): code is string => Boolean(code));
  return (
    codes.some((code) =>
      /UNCERTAIN|UNKNOWN|MUTATION|RECEIPT|SEMANTIC_DRIFT|CATALOGUE.*CHANGED/.test(
        code,
      ),
    ) ||
    (job.startedAt !== null &&
      ["failed", "cancelled"].includes(job.status))
  );
}

async function closeBatchSessions(
  state: TesseraValidationWebBatchDocumentV1,
  adapters: RuntimeAdapters,
): Promise<TesseraValidationWebBatchDocumentV1> {
  if (state.sessionsClosedAt) return state;
  const settled = await Promise.allSettled([
    adapters.closeNewRecruitSession(state.sessionId),
    adapters.closeTesseraSession(state.sessionId),
  ]);
  const warnings = [...state.warnings];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      warnings.push(
        index === 0
          ? "NEW_RECRUIT_BATCH_SESSION_CLOSE_FAILED"
          : "TESSERA_BATCH_SESSION_CLOSE_FAILED",
      );
    }
  });
  return {
    ...state,
    sessionsClosedAt: nowIso(adapters),
    warnings: uniqueSorted(warnings),
  };
}

async function compareCompletedBatch(
  state: TesseraValidationWebBatchDocumentV1,
  adapters: RuntimeAdapters,
): Promise<DiagnosticComparison> {
  const local = await readTrustedLocalStressReport(state.localJob, adapters);
  const child = local ? localChildReport(local) : null;
  if (!child) {
    return { status: "inconclusive", comparableCells: 0, outsideBandCells: 0 };
  }
  let comparableCells = 0;
  let outsideBandCells = 0;
  let inconclusive = false;
  for (const receipt of state.exactJobs) {
    if (!receipt.trustedEvidence) {
      inconclusive = true;
      continue;
    }
    const status = await adapters.getRunStatus(receipt.jobPath, true);
    const trusted = trustedExactReport(
      status.job,
      status.result,
      state.playerFingerprint,
      receipt.rosterFingerprint,
    );
    if (!trusted || trusted.reportSha256 !== receipt.reportSha256) {
      inconclusive = true;
      continue;
    }
    const comparison = diagnosticReportComparison(
      child,
      trusted.report,
      receipt.rosterFingerprint,
    );
    comparableCells += comparison.comparableCells;
    outsideBandCells += comparison.outsideBandCells;
    if (comparison.status === "inconclusive") inconclusive = true;
  }
  if (inconclusive || comparableCells === 0) {
    return { status: "inconclusive", comparableCells, outsideBandCells };
  }
  const materialThreshold = Math.max(1, Math.ceil(comparableCells * 0.1));
  return {
    status:
      outsideBandCells >= materialThreshold
        ? "material-divergence"
        : "within-local-bands",
    comparableCells,
    outsideBandCells,
  };
}

async function createWebBatch(
  request: TesseraValidationWebLaunchRequest,
  adapters: RuntimeAdapters,
): Promise<TesseraValidationJobReference> {
  if (!request.playerRoster) {
    throw new Error("A frozen player roster is required for Web validation.");
  }
  if (valueSha256(request.portfolio) !== request.portfolioSha256) {
    throw new Error("The frozen Web portfolio hash no longer matches.");
  }
  if (
    rosterExecutionFingerprint(request.playerRoster) !==
    request.playerFingerprint
  ) {
    throw new Error("The frozen player roster fingerprint no longer matches.");
  }
  if (
    request.expectedCaptureCount !==
    request.templateIds.length * TESSERA_WEB_CAPTURES_PER_OPPONENT
  ) {
    throw new Error("The Web batch capture contract is inconsistent.");
  }
  const local = await trustedLocalSnapshot(request.localJob, adapters);
  if (
    !local.trustedEvidence ||
    local.portfolioSha256 !== request.portfolioSha256
  ) {
    throw new Error(
      "Trusted local diverse-nine evidence is required before Web validation.",
    );
  }
  const readyById = new Map(
    readyPortfolioItems(request.portfolio).map((item) => [
      item.templateId,
      item,
    ]),
  );
  if (
    uniqueSorted(request.templateIds).length !== request.templateIds.length ||
    request.templateIds.some((templateId) => !readyById.has(templateId))
  ) {
    throw new Error("The Web batch does not match the frozen portfolio.");
  }
  const batchId = randomUUID();
  const sessionId = `validation-${batchId}`;
  const now = nowIso(adapters);
  const state: TesseraValidationWebBatchDocumentV1 = {
    schemaVersion: 1,
    documentKind: "tessera-validation-web-batch",
    batchId,
    workflowId: request.workflowId,
    sequence: 1,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    batchKind: request.batchKind,
    portfolioSha256: request.portfolioSha256,
    playerFingerprint: request.playerFingerprint,
    playerRoster: structuredClone(request.playerRoster),
    profilePolicy: structuredClone(request.profilePolicy),
    portfolio: structuredClone(request.portfolio),
    templateIds: [...request.templateIds],
    representativeTemplateIds: [...request.representativeTemplateIds],
    sessionId,
    localJob: structuredClone(request.localJob),
    successorOf: structuredClone(request.successorOf),
    exactJobs: [],
    completedTemplateIds: [],
    expectedCaptureCount: request.expectedCaptureCount,
    capturedScenarioCount: 0,
    deploymentIdentitySha256: null,
    playerSemanticSha256: null,
    comparison: "not-evaluated",
    trustedEvidence: false,
    requiresSuccessor: false,
    errorCode: null,
    sessionsClosedAt: null,
    warnings: [],
  };
  await withBatchLock(adapters.runRoot, batchId, async () => {
    await appendBatchRevision(adapters.runRoot, state, null);
  });
  return {
    jobId: batchHeadPath(adapters.runRoot, batchId),
    runId: batchId,
  };
}

async function predecessorExactRunId(
  state: TesseraValidationWebBatchDocumentV1,
  templateId: string,
  adapters: RuntimeAdapters,
): Promise<string | null> {
  if (!state.successorOf) return null;
  const predecessorId = batchIdFromReference(state.successorOf);
  if (
    path.resolve(state.successorOf.jobId) !==
    path.resolve(batchHeadPath(adapters.runRoot, predecessorId))
  ) {
    throw new Error("The predecessor Web batch reference path changed.");
  }
  const predecessor = (
    await readBatchVerification(adapters.runRoot, predecessorId)
  ).state;
  if (
    predecessor.workflowId !== state.workflowId ||
    predecessor.portfolioSha256 !== state.portfolioSha256 ||
    predecessor.status !== "failed" ||
    predecessor.requiresSuccessor !== true
  ) {
    throw new Error("The predecessor Web batch is not a valid successor source.");
  }
  return (
    predecessor.exactJobs.find(
      (receipt) => receipt.templateId === templateId,
    )?.runId ?? null
  );
}

async function launchNextExact(
  state: TesseraValidationWebBatchDocumentV1,
  adapters: RuntimeAdapters,
): Promise<TesseraValidationWebBatchDocumentV1> {
  const templateId = state.templateIds[state.exactJobs.length];
  if (!templateId) return state;
  const item = readyPortfolioItems(state.portfolio).find(
    (candidate) => candidate.templateId === templateId,
  );
  if (!item) {
    return closeBatchSessions(
      {
        ...state,
        sequence: state.sequence + 1,
        updatedAt: nowIso(adapters),
        status: "failed",
        errorCode: "TESSERA_VALIDATION_WEB_TEMPLATE_MISSING",
      },
      adapters,
    );
  }
  const batchRoot = batchDirectory(adapters.runRoot, state.batchId);
  const profilePolicyPath = await writeProfilePolicy(
    batchRoot,
    state.profilePolicy,
  );
  const request: TesseraRunRequest = {
    kind: "exact",
    playerRoster: structuredClone(state.playerRoster),
    opponent: {
      kind: "roster",
      roster: structuredClone(item.roster),
    },
    options: {
      simulationBackend: "website",
      executionMode: "simulate",
      analysisMode: "full",
      phases: [...TESSERA_SCENARIO_PHASES],
      metrics: [...webMetrics],
      profilePolicy: structuredClone(state.profilePolicy),
      ...(profilePolicyPath ? { profilePolicyPath } : {}),
      sessionId: state.sessionId,
      providerCompatibilityMode: "enforce",
      fallbackMode: "none",
      includeChangeCandidates: false,
    },
  };
  try {
    const supersedesRunId = await predecessorExactRunId(
      state,
      templateId,
      adapters,
    );
    const job = await adapters.startRun(request, {
      outputDirectory: path.join(batchRoot, "exact-runs"),
      rootDir: batchRoot,
      allowOutsideRoot: false,
      // Commit the exact job reference into the batch before any browser
      // worker can start. The next coordinator advance launches it through
      // the idempotent durable-job resume path.
      launch: false,
      supersedesRunId,
    });
    const now = nowIso(adapters);
    const receipt: TesseraValidationWebExactReceiptV1 = {
      templateId,
      rosterFingerprint: rosterExecutionFingerprint(item.roster),
      jobPath: job.requestPath,
      runId: job.runId,
      launchedAt: now,
      completedAt: null,
      status: jobStatus(job.status),
      requestSha256: job.requestSha256,
      resultSha256: null,
      reportSha256: null,
      deploymentIdentitySha256: null,
      playerSemanticSha256: null,
      trustedEvidence: false,
      errorCode: job.error?.code ?? null,
    };
    if (job.status === "needs-input") {
      return closeBatchSessions(
        {
          ...state,
          sequence: state.sequence + 1,
          updatedAt: now,
          status: "failed",
          exactJobs: [...state.exactJobs, receipt],
          errorCode:
            job.error?.code ?? "TESSERA_VALIDATION_PROFILE_POLICY_REQUIRED",
          requiresSuccessor: false,
        },
        adapters,
      );
    }
    return {
      ...state,
      sequence: state.sequence + 1,
      updatedAt: now,
      status: "running",
      exactJobs: [...state.exactJobs, receipt],
      errorCode: null,
    };
  } catch (error) {
    const now = nowIso(adapters);
    return closeBatchSessions(
      {
        ...state,
        sequence: state.sequence + 1,
        updatedAt: now,
        status: "failed",
        errorCode: errorCode(error),
        requiresSuccessor: false,
      },
      adapters,
    );
  }
}

async function pollActiveExact(
  state: TesseraValidationWebBatchDocumentV1,
  adapters: RuntimeAdapters,
): Promise<TesseraValidationWebBatchDocumentV1> {
  const active = state.exactJobs.at(-1);
  if (!active || active.completedAt) return state;
  let observed: Awaited<ReturnType<typeof getTesseraRunStatus>>;
  try {
    observed = await adapters.getRunStatus(active.jobPath, true);
  } catch (error) {
    return closeBatchSessions(
      {
        ...state,
        sequence: state.sequence + 1,
        updatedAt: nowIso(adapters),
        status: "failed",
        errorCode: errorCode(error),
        requiresSuccessor: true,
      },
      adapters,
    );
  }
  if (observed.job.runId !== active.runId) {
    return closeBatchSessions(
      {
        ...state,
        sequence: state.sequence + 1,
        updatedAt: nowIso(adapters),
        status: "failed",
        errorCode: "TESSERA_VALIDATION_EXACT_JOB_IDENTITY_CHANGED",
        requiresSuccessor: true,
      },
      adapters,
    );
  }
  if (observed.job.status === "queued") {
    try {
      const resumed = await adapters.resumeRun(active.jobPath);
      const now = nowIso(adapters);
      const updatedReceipt: TesseraValidationWebExactReceiptV1 = {
        ...active,
        status: jobStatus(resumed.status),
        errorCode: resumed.error?.code ?? null,
      };
      if (resumed.status === "needs-input") {
        return closeBatchSessions(
          {
            ...state,
            sequence: state.sequence + 1,
            updatedAt: now,
            status: "failed",
            exactJobs: [
              ...state.exactJobs.slice(0, -1),
              updatedReceipt,
            ],
            errorCode:
              resumed.error?.code ??
              "TESSERA_VALIDATION_PROFILE_POLICY_REQUIRED",
            requiresSuccessor: false,
          },
          adapters,
        );
      }
      return {
        ...state,
        sequence: state.sequence + 1,
        updatedAt: now,
        exactJobs: [
          ...state.exactJobs.slice(0, -1),
          updatedReceipt,
        ],
      };
    } catch (error) {
      return closeBatchSessions(
        {
          ...state,
          sequence: state.sequence + 1,
          updatedAt: nowIso(adapters),
          status: "failed",
          errorCode: errorCode(error),
          // A launcher exception can occur after the local agent accepted the
          // worker. Stop here and require a successor instead of guessing.
          requiresSuccessor: true,
        },
        adapters,
      );
    }
  }
  if (observed.job.status === "running") return state;
  const now = nowIso(adapters);
  const trusted = trustedExactReport(
    observed.job,
    observed.result,
    state.playerFingerprint,
    active.rosterFingerprint,
  );
  const updatedReceipt: TesseraValidationWebExactReceiptV1 = {
    ...active,
    completedAt: now,
    status: jobStatus(observed.job.status),
    resultSha256: trusted?.resultSha256 ?? currentResultReceipt(observed.job),
    reportSha256: trusted?.reportSha256 ?? null,
    deploymentIdentitySha256:
      trusted?.deploymentIdentitySha256 ?? null,
    playerSemanticSha256: trusted?.playerSemanticSha256 ?? null,
    trustedEvidence: trusted !== null,
    errorCode: observed.job.error?.code ?? null,
  };
  const exactJobs = [
    ...state.exactJobs.slice(0, -1),
    updatedReceipt,
  ];
  const deploymentChanged = Boolean(
    trusted &&
      state.deploymentIdentitySha256 &&
      state.deploymentIdentitySha256 !== trusted.deploymentIdentitySha256,
  );
  const playerSemanticChanged = Boolean(
    trusted &&
      state.playerSemanticSha256 &&
      state.playerSemanticSha256 !== trusted.playerSemanticSha256,
  );
  if (!trusted || deploymentChanged || playerSemanticChanged) {
    const unsafe =
      deploymentChanged ||
      playerSemanticChanged ||
      unsafeTerminalFailure(observed.job, observed.result);
    return closeBatchSessions(
      {
        ...state,
        sequence: state.sequence + 1,
        updatedAt: now,
        status: unsafe ? "failed" : "inconclusive",
        exactJobs,
        requiresSuccessor: unsafe,
        errorCode: deploymentChanged
          ? "TESSERA_VALIDATION_DEPLOYMENT_CHANGED"
          : playerSemanticChanged
            ? "TESSERA_VALIDATION_PLAYER_SEMANTICS_CHANGED"
            : observed.job.error?.code ??
              "TESSERA_VALIDATION_WEB_EVIDENCE_INVALID",
      },
      adapters,
    );
  }
  const completedTemplateIds = [
    ...state.completedTemplateIds,
    active.templateId,
  ];
  const capturedScenarioCount =
    state.capturedScenarioCount + trusted.scenarioCount;
  const completedState: TesseraValidationWebBatchDocumentV1 = {
    ...state,
    sequence: state.sequence + 1,
    updatedAt: now,
    exactJobs,
    completedTemplateIds,
    capturedScenarioCount,
    deploymentIdentitySha256:
      state.deploymentIdentitySha256 ?? trusted.deploymentIdentitySha256,
    playerSemanticSha256:
      state.playerSemanticSha256 ?? trusted.playerSemanticSha256,
  };
  if (completedTemplateIds.length < state.templateIds.length) {
    return completedState;
  }
  const comparison = await compareCompletedBatch(completedState, adapters);
  const degraded = exactJobs.some((receipt) => receipt.status === "degraded");
  return closeBatchSessions(
    {
      ...completedState,
      status:
        comparison.status === "inconclusive"
          ? "inconclusive"
          : degraded
            ? "degraded"
            : "complete",
      comparison: comparison.status,
      trustedEvidence: true,
      errorCode:
        comparison.status === "inconclusive"
          ? "TESSERA_VALIDATION_COMPARISON_INCONCLUSIVE"
          : null,
    },
    adapters,
  );
}

export async function verifyTesseraValidationWebBatch(
  reference: TesseraValidationJobReference,
  options: TesseraValidationRuntimeOptions = {},
): Promise<TesseraValidationWebBatchVerification> {
  const adapters = runtimeAdapters(options);
  const batchId = batchIdFromReference(reference);
  const expectedHead = batchHeadPath(adapters.runRoot, batchId);
  if (path.resolve(reference.jobId) !== path.resolve(expectedHead)) {
    throw new Error("The Web batch reference path changed.");
  }
  return readBatchVerification(adapters.runRoot, batchId);
}

export async function readTesseraValidationWebBatch(
  reference: TesseraValidationJobReference,
  options: TesseraValidationRuntimeOptions = {},
): Promise<TesseraValidationWebBatchDocumentV1> {
  return (await verifyTesseraValidationWebBatch(reference, options)).state;
}

export async function advanceTesseraValidationWebBatch(
  reference: TesseraValidationJobReference,
  options: TesseraValidationRuntimeOptions = {},
): Promise<TesseraValidationWebBatchDocumentV1> {
  const adapters = runtimeAdapters(options);
  const batchId = batchIdFromReference(reference);
  return withBatchLock(adapters.runRoot, batchId, async () => {
    const verification = await readBatchVerification(adapters.runRoot, batchId);
    const state = verification.state;
    if (["complete", "degraded", "inconclusive", "failed"].includes(state.status)) {
      return state;
    }
    let next: TesseraValidationWebBatchDocumentV1;
    const active = state.exactJobs.at(-1);
    if (active && active.completedAt === null) {
      next = await pollActiveExact(state, adapters);
    } else {
      next = await launchNextExact(state, adapters);
    }
    if (next === state) return state;
    if (next.sequence !== state.sequence + 1) {
      throw new Error("A Web batch checkpoint must advance one sequence.");
    }
    await appendBatchRevision(adapters.runRoot, next, verification.head);
    return next;
  });
}

function webBatchSnapshot(
  state: TesseraValidationWebBatchDocumentV1,
): TesseraValidationWebJobSnapshot {
  return {
    executionStatus: state.status,
    trustedEvidence: state.trustedEvidence,
    completedTemplateIds: [...state.completedTemplateIds],
    comparison: state.comparison,
    requiresSuccessor: state.requiresSuccessor,
    errorCode: state.errorCode,
  };
}

async function launchLocalNine(
  request: TesseraValidationLocalLaunchRequest,
  adapters: RuntimeAdapters,
): Promise<TesseraValidationJobReference> {
  if (!request.playerRoster || !request.portfolioPreview) {
    throw new Error(
      "A frozen player roster and portfolio preview are required for local validation.",
    );
  }
  if (
    rosterExecutionFingerprint(request.playerRoster) !==
      request.playerFingerprint ||
    valueSha256(request.portfolio) !== request.portfolioSha256 ||
    valueSha256(request.portfolioPreview.portfolio) !==
      request.portfolioSha256 ||
    !sameStrings(request.templateIds, readyPortfolioItems(request.portfolio).map(
      (item) => item.templateId,
    ))
  ) {
    throw new Error("The frozen local validation inputs changed.");
  }
  const workflowRoot = path.join(
    adapters.runRoot,
    "local",
    request.workflowId,
  );
  await mkdir(workflowRoot, { recursive: true, mode: 0o700 });
  const profilePolicyPath = await writeProfilePolicy(
    workflowRoot,
    request.profilePolicy,
  );
  const job = await adapters.startRun(
    {
      kind: "stress",
      playerRoster: structuredClone(request.playerRoster),
      factionId: request.portfolio.factionId,
      options: {
        simulationBackend: "local-engine",
        executionMode: "simulate",
        suite: "diverse-9",
        analysisStrategy: "full-all",
        portfolioPreview: structuredClone(request.portfolioPreview),
        profilePolicyPath,
        experimental: false,
        providerCompatibilityMode: "observe",
        retryOwner: "durable-job",
      },
    },
    {
      outputDirectory: path.join(workflowRoot, "jobs"),
      rootDir: workflowRoot,
      allowOutsideRoot: false,
      // The workflow revision must retain the job reference before the
      // durable worker is allowed to perform external activity.
      launch: false,
    },
  );
  return { jobId: job.requestPath, runId: job.runId };
}

export function createTesseraValidationRuntimeDependencies(
  options: TesseraValidationRuntimeOptions = {},
): TesseraValidationWorkflowDependencies {
  const adapters = runtimeAdapters(options);
  return {
    async launchLocalNine(request) {
      return launchLocalNine(request, adapters);
    },
    async pollLocalNine(reference) {
      try {
        const observed = await adapters.getRunStatus(reference.jobId, false);
        if (
          observed.job.status === "queued" &&
          (!reference.runId || observed.job.runId === reference.runId)
        ) {
          await adapters.resumeRun(reference.jobId);
        }
      } catch (error) {
        return {
          executionStatus: "failed",
          trustedEvidence: false,
          portfolioSha256: null,
          completedTemplateIds: [],
          representatives: [],
          errorCode: errorCode(error),
        };
      }
      return trustedLocalSnapshot(reference, adapters);
    },
    async launchWebBatch(request) {
      return createWebBatch(request, adapters);
    },
    async pollWebBatch(reference) {
      const state = await advanceTesseraValidationWebBatch(reference, {
        ...options,
        storeRoot: adapters.storeRoot,
        runRoot: adapters.runRoot,
      });
      return webBatchSnapshot(state);
    },
    now: adapters.now,
  };
}

export type StartTesseraValidationRuntimeInput = Omit<
  CreateTesseraValidationWorkflowInput,
  "storeRoot" | "playerFingerprint"
> & {
  playerRoster: RosterDraftV1;
  playerFingerprint?: string;
};

export async function startTesseraValidationRuntime(
  input: StartTesseraValidationRuntimeInput,
  options: TesseraValidationRuntimeOptions = {},
): Promise<AdvanceTesseraValidationWorkflowResult> {
  const adapters = runtimeAdapters(options);
  const playerFingerprint = rosterExecutionFingerprint(input.playerRoster);
  if (
    input.playerFingerprint &&
    input.playerFingerprint !== playerFingerprint
  ) {
    throw new Error("The supplied player fingerprint does not match the roster.");
  }
  const state = await createTesseraValidationWorkflow({
    ...input,
    storeRoot: adapters.storeRoot,
    playerFingerprint,
  });
  return advanceTesseraValidationWorkflow(
    adapters.storeRoot,
    state.workflowId,
    createTesseraValidationRuntimeDependencies({
      ...options,
      storeRoot: adapters.storeRoot,
      runRoot: adapters.runRoot,
    }),
  );
}

export async function readTesseraValidationRuntime(
  workflowId: string,
  options: TesseraValidationRuntimeOptions = {},
): Promise<TesseraValidationWorkflowDocumentV1> {
  const adapters = runtimeAdapters(options);
  return readTesseraValidationWorkflow(adapters.storeRoot, workflowId);
}

export async function advanceTesseraValidationRuntime(
  workflowId: string,
  options: TesseraValidationRuntimeOptions = {},
): Promise<AdvanceTesseraValidationWorkflowResult> {
  const adapters = runtimeAdapters(options);
  return advanceTesseraValidationWorkflow(
    adapters.storeRoot,
    workflowId,
    createTesseraValidationRuntimeDependencies({
      ...options,
      storeRoot: adapters.storeRoot,
      runRoot: adapters.runRoot,
    }),
  );
}

export async function confirmTesseraValidationRemainingSixRuntime(
  workflowId: string,
  expectedOfferSequence: number,
  options: TesseraValidationRuntimeOptions = {},
): Promise<TesseraValidationWorkflowDocumentV1> {
  const adapters = runtimeAdapters(options);
  return confirmTesseraValidationRemainingSix(
    adapters.storeRoot,
    workflowId,
    expectedOfferSequence,
    nowIso(adapters),
  );
}

export async function confirmTesseraValidationSuccessorRuntime(
  workflowId: string,
  failedJobId: string,
  expectedOfferSequence: number,
  options: TesseraValidationRuntimeOptions = {},
): Promise<TesseraValidationWorkflowDocumentV1> {
  const adapters = runtimeAdapters(options);
  return confirmTesseraValidationSuccessor(
    adapters.storeRoot,
    workflowId,
    failedJobId,
    expectedOfferSequence,
    nowIso(adapters),
  );
}
