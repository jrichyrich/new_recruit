import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import type {
  ProfilePolicyV1,
  RosterDraftV1,
  TesseraStressPortfolio,
  TesseraStressPortfolioPreview,
  TesseraStressRepresentative,
} from "../../lib/rosterpilot/types";

const sha256Pattern = /^[0-9a-f]{64}$/;
const workflowIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const lockStaleMs = 30_000;
const lockWaitMs = 5_000;

export const TESSERA_WEB_CAPTURES_PER_OPPONENT = 16;

export type TesseraValidationDepth = "standard" | "exhaustive";

export type TesseraValidationExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "degraded"
  | "failed";

export type TesseraValidationEvidenceStatus =
  | "pending"
  | "trusted"
  | "incomplete"
  | "untrusted";

export type TesseraValidationWorkflowStatus =
  | "created"
  | "local-running"
  | "web-ready"
  | "web-running"
  | "remaining-six-offered"
  | "remaining-six-ready"
  | "needs-successor-confirmation"
  | "complete"
  | "needs-review";

export type TesseraValidationJobExecutionStatus =
  | "queued"
  | "running"
  | "complete"
  | "degraded"
  | "inconclusive"
  | "failed"
  | "cancelled"
  | "needs-input";

export type TesseraValidationComparison =
  | "within-local-bands"
  | "material-divergence"
  | "inconclusive"
  | "not-evaluated";

export type TesseraValidationJobReference = {
  jobId: string;
  runId: string | null;
};

export type TesseraValidationLocalJobSnapshot = {
  executionStatus: TesseraValidationJobExecutionStatus;
  trustedEvidence: boolean;
  portfolioSha256: string | null;
  completedTemplateIds: string[];
  representatives: TesseraStressRepresentative[];
  errorCode: string | null;
};

export type TesseraValidationWebJobSnapshot = {
  executionStatus: TesseraValidationJobExecutionStatus;
  trustedEvidence: boolean;
  completedTemplateIds: string[];
  comparison: TesseraValidationComparison;
  requiresSuccessor: boolean;
  errorCode: string | null;
};

export type TesseraValidationWebBatchKind =
  | "representative-three"
  | "exhaustive-nine"
  | "remaining-six";

export type TesseraValidationWorkflowDependencies = {
  launchLocalNine: (
    request: TesseraValidationLocalLaunchRequest,
  ) => Promise<TesseraValidationJobReference>;
  pollLocalNine: (
    reference: TesseraValidationJobReference,
  ) => Promise<TesseraValidationLocalJobSnapshot>;
  launchWebBatch: (
    request: TesseraValidationWebLaunchRequest,
  ) => Promise<TesseraValidationJobReference>;
  pollWebBatch: (
    reference: TesseraValidationJobReference,
  ) => Promise<TesseraValidationWebJobSnapshot>;
  now?: () => string;
};

export type TesseraValidationLocalLaunchRequest = {
  workflowId: string;
  playerFingerprint: string;
  playerRoster: RosterDraftV1 | null;
  profilePolicy: ProfilePolicyV1 | null;
  portfolio: TesseraStressPortfolio;
  portfolioPreview: TesseraStressPortfolioPreview | null;
  portfolioSha256: string;
  templateIds: string[];
  suite: "diverse-9";
  analysisStrategy: "full-all";
  metrics: "full-supported";
};

export type TesseraValidationWebLaunchRequest = {
  workflowId: string;
  playerFingerprint: string;
  playerRoster: RosterDraftV1 | null;
  profilePolicy: ProfilePolicyV1 | null;
  portfolio: TesseraStressPortfolio;
  portfolioPreview: TesseraStressPortfolioPreview | null;
  portfolioSha256: string;
  batchKind: TesseraValidationWebBatchKind;
  templateIds: string[];
  representativeTemplateIds: string[];
  localJob: TesseraValidationJobReference;
  successorOf: TesseraValidationJobReference | null;
  metrics: "full-supported";
  comparisonMode: "diagnostic-cross-provider";
  expectedCaptureCount: number;
};

export type TesseraValidationRepresentativeCoverage = {
  representedPostures: string[];
  representedCompositions: string[];
  adequate: boolean;
};

export type TesseraValidationJobAttemptV1 = {
  batchKind: TesseraValidationWebBatchKind;
  templateIds: string[];
  reference: TesseraValidationJobReference;
  successorOf: TesseraValidationJobReference | null;
  launchedAt: string;
  completedAt: string | null;
  executionStatus: TesseraValidationJobExecutionStatus;
  trustedEvidence: boolean;
  completedTemplateIds: string[];
  comparison: TesseraValidationComparison;
  errorCode: string | null;
};

export type TesseraValidationWorkflowEventV1 = {
  sequence: number;
  at: string;
  event:
    | "created"
    | "local-started"
    | "local-completed"
    | "local-rejected"
    | "web-plan-frozen"
    | "web-started"
    | "web-completed"
    | "web-evidence-rejected"
    | "remaining-six-offered"
    | "remaining-six-confirmed"
    | "successor-offered"
    | "successor-confirmed"
    | "completed";
  jobId: string | null;
  detailCode: string | null;
};

export type TesseraValidationWorkflowDocumentV1 = {
  schemaVersion: 1;
  documentKind: "tessera-validation-workflow";
  workflowId: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  status: TesseraValidationWorkflowStatus;
  validationDepth: TesseraValidationDepth;
  exhaustiveExplicitlyConfirmed: boolean;
  playerFingerprint: string;
  playerRoster: RosterDraftV1 | null;
  profilePolicy: ProfilePolicyV1 | null;
  portfolio: TesseraStressPortfolio;
  portfolioPreview: TesseraStressPortfolioPreview | null;
  portfolioSha256: string;
  frozenTemplateIds: string[];
  local: {
    reference: TesseraValidationJobReference | null;
    execution: TesseraValidationExecutionStatus;
    evidence: TesseraValidationEvidenceStatus;
    completedTemplateIds: string[];
    errorCode: string | null;
  };
  representatives: TesseraStressRepresentative[];
  representativeCoverage: TesseraValidationRepresentativeCoverage | null;
  web: {
    plannedBatchKind: TesseraValidationWebBatchKind | null;
    plannedTemplateIds: string[];
    plannedCaptureCount: number;
    attempts: TesseraValidationJobAttemptV1[];
    execution: TesseraValidationExecutionStatus;
    evidence: TesseraValidationEvidenceStatus;
    comparison: TesseraValidationComparison;
    completedTemplateIds: string[];
    pendingSuccessorOf: TesseraValidationJobReference | null;
  };
  remainingSix: {
    templateIds: string[];
    offeredAt: string | null;
    confirmedAt: string | null;
  };
  pendingAction:
    | "start-local-nine"
    | "poll-local-nine"
    | "start-web-batch"
    | "poll-web-batch"
    | "confirm-remaining-six"
    | "confirm-successor"
    | "review-evidence"
    | "none";
  events: TesseraValidationWorkflowEventV1[];
};

type WorkflowRevisionV1 = {
  schemaVersion: 1;
  revisionKind: "tessera-validation-workflow-revision";
  workflowId: string;
  sequence: number;
  previousRevision: {
    filename: string;
    sha256: string;
  } | null;
  stateSha256: string;
  state: TesseraValidationWorkflowDocumentV1;
  revisionSha256: string;
};

type WorkflowHeadV1 = {
  schemaVersion: 1;
  headKind: "tessera-validation-workflow-head";
  workflowId: string;
  sequence: number;
  revisionFilename: string;
  revisionSha256: string;
  headSha256: string;
};

export type TesseraValidationWorkflowVerification = {
  state: TesseraValidationWorkflowDocumentV1;
  head: WorkflowHeadV1;
  revisionCount: number;
};

export type CreateTesseraValidationWorkflowInput = {
  storeRoot: string;
  workflowId?: string;
  playerFingerprint?: string;
  playerRoster?: RosterDraftV1 | null;
  profilePolicy?: ProfilePolicyV1 | null;
  portfolio: TesseraStressPortfolio;
  portfolioPreview?: TesseraStressPortfolioPreview | null;
  validationDepth?: TesseraValidationDepth;
  exhaustiveConfirmation?: boolean;
  now?: string;
};

export type AdvanceTesseraValidationWorkflowResult = {
  state: TesseraValidationWorkflowDocumentV1;
  changed: boolean;
  action:
    | "local-started"
    | "local-pending"
    | "local-completed"
    | "local-rejected"
    | "web-plan-frozen"
    | "web-started"
    | "web-pending"
    | "web-completed"
    | "remaining-six-offered"
    | "successor-confirmation-required"
    | "awaiting-confirmation"
    | "needs-review"
    | "complete";
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function valueSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function assertWorkflowId(workflowId: string): void {
  if (!workflowIdPattern.test(workflowId)) {
    throw new Error("The Tessera validation workflow ID is not safe.");
  }
}

function assertJobReference(
  reference: TesseraValidationJobReference,
): void {
  if (
    typeof reference.jobId !== "string" ||
    reference.jobId.trim().length === 0 ||
    (reference.runId !== null &&
      (typeof reference.runId !== "string" ||
        reference.runId.trim().length === 0))
  ) {
    throw new Error("The validation job launcher returned an invalid reference.");
  }
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

function terminalJobStatus(
  status: TesseraValidationJobExecutionStatus,
): boolean {
  return !["queued", "running"].includes(status);
}

function workflowDirectory(storeRoot: string, workflowId: string): string {
  assertWorkflowId(workflowId);
  return path.join(path.resolve(storeRoot), workflowId);
}

function headPath(storeRoot: string, workflowId: string): string {
  return path.join(workflowDirectory(storeRoot, workflowId), "head.json");
}

function revisionsDirectory(storeRoot: string, workflowId: string): string {
  return path.join(workflowDirectory(storeRoot, workflowId), "revisions");
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

async function withWorkflowLock<T>(
  storeRoot: string,
  workflowId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const directory = workflowDirectory(storeRoot, workflowId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".lock");
  const deadline = Date.now() + lockWaitMs;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const observed = await stat(lock);
        if (Date.now() - observed.mtimeMs > lockStaleMs) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the validation workflow lease.");
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

function headPayload(head: WorkflowHeadV1): Omit<WorkflowHeadV1, "headSha256"> {
  return {
    schemaVersion: head.schemaVersion,
    headKind: head.headKind,
    workflowId: head.workflowId,
    sequence: head.sequence,
    revisionFilename: head.revisionFilename,
    revisionSha256: head.revisionSha256,
  };
}

function revisionPayload(
  revision: WorkflowRevisionV1,
): Omit<WorkflowRevisionV1, "revisionSha256"> {
  return {
    schemaVersion: revision.schemaVersion,
    revisionKind: revision.revisionKind,
    workflowId: revision.workflowId,
    sequence: revision.sequence,
    previousRevision: revision.previousRevision,
    stateSha256: revision.stateSha256,
    state: revision.state,
  };
}

function parseHead(value: unknown): WorkflowHeadV1 {
  const head = value as Partial<WorkflowHeadV1>;
  if (
    head.schemaVersion !== 1 ||
    head.headKind !== "tessera-validation-workflow-head" ||
    typeof head.workflowId !== "string" ||
    typeof head.sequence !== "number" ||
    typeof head.revisionFilename !== "string" ||
    typeof head.revisionSha256 !== "string" ||
    typeof head.headSha256 !== "string" ||
    !sha256Pattern.test(head.revisionSha256) ||
    !sha256Pattern.test(head.headSha256)
  ) {
    throw new Error("The Tessera validation workflow head is malformed.");
  }
  assertWorkflowId(head.workflowId);
  if (valueSha256(headPayload(head as WorkflowHeadV1)) !== head.headSha256) {
    throw new Error("The Tessera validation workflow head seal is invalid.");
  }
  return head as WorkflowHeadV1;
}

function parseState(value: unknown): TesseraValidationWorkflowDocumentV1 {
  const state = value as Partial<TesseraValidationWorkflowDocumentV1>;
  if (
    state.schemaVersion !== 1 ||
    state.documentKind !== "tessera-validation-workflow" ||
    typeof state.workflowId !== "string" ||
    typeof state.sequence !== "number" ||
    !Array.isArray(state.frozenTemplateIds) ||
    !Array.isArray(state.events)
  ) {
    throw new Error(
      "The Tessera validation workflow document needs a supported migration.",
    );
  }
  assertWorkflowId(state.workflowId);
  const parsed = state as TesseraValidationWorkflowDocumentV1;
  parsed.playerRoster ??= null;
  parsed.profilePolicy ??= null;
  parsed.portfolioPreview ??= null;
  if (
    !sha256Pattern.test(parsed.portfolioSha256 ?? "") ||
    valueSha256(parsed.portfolio) !== parsed.portfolioSha256 ||
    !sameStrings(
      readyPortfolioTemplateIds(parsed.portfolio),
      parsed.frozenTemplateIds,
    ) ||
    parsed.events.length !== parsed.sequence ||
    parsed.events.some(
      (event, index) => event.sequence !== index + 1,
    )
  ) {
    throw new Error("The Tessera validation workflow document is inconsistent.");
  }
  return parsed;
}

function parseRevision(value: unknown): WorkflowRevisionV1 {
  const revision = value as Partial<WorkflowRevisionV1>;
  if (
    revision.schemaVersion !== 1 ||
    revision.revisionKind !== "tessera-validation-workflow-revision" ||
    typeof revision.workflowId !== "string" ||
    typeof revision.sequence !== "number" ||
    typeof revision.stateSha256 !== "string" ||
    typeof revision.revisionSha256 !== "string" ||
    !sha256Pattern.test(revision.stateSha256) ||
    !sha256Pattern.test(revision.revisionSha256)
  ) {
    throw new Error("A Tessera validation workflow revision is malformed.");
  }
  if (
    revision.previousRevision !== null &&
    (typeof revision.previousRevision !== "object" ||
      typeof revision.previousRevision.filename !== "string" ||
      typeof revision.previousRevision.sha256 !== "string" ||
      !sha256Pattern.test(revision.previousRevision.sha256))
  ) {
    throw new Error("A Tessera validation workflow revision link is malformed.");
  }
  const parsedState = parseState(revision.state);
  if (
    parsedState.workflowId !== revision.workflowId ||
    parsedState.sequence !== revision.sequence ||
    valueSha256(parsedState) !== revision.stateSha256 ||
    valueSha256(revisionPayload(revision as WorkflowRevisionV1)) !==
      revision.revisionSha256
  ) {
    throw new Error("A Tessera validation workflow revision seal is invalid.");
  }
  return revision as WorkflowRevisionV1;
}

function revisionFilename(sequence: number, revisionSha256: string): string {
  return `${String(sequence).padStart(8, "0")}-${revisionSha256}.json`;
}

async function appendRevisionUnlocked(
  storeRoot: string,
  state: TesseraValidationWorkflowDocumentV1,
  previous: WorkflowHeadV1 | null,
): Promise<WorkflowHeadV1> {
  const stateSha256 = valueSha256(state);
  const previousRevision = previous
    ? {
        filename: previous.revisionFilename,
        sha256: previous.revisionSha256,
      }
    : null;
  const unsignedRevision = {
    schemaVersion: 1 as const,
    revisionKind: "tessera-validation-workflow-revision" as const,
    workflowId: state.workflowId,
    sequence: state.sequence,
    previousRevision,
    stateSha256,
    state,
  };
  const revisionSha256 = valueSha256(unsignedRevision);
  const revision: WorkflowRevisionV1 = {
    ...unsignedRevision,
    revisionSha256,
  };
  const filename = revisionFilename(state.sequence, revisionSha256);
  const revisionPath = path.join(
    revisionsDirectory(storeRoot, state.workflowId),
    filename,
  );
  await mkdir(path.dirname(revisionPath), {
    recursive: true,
    mode: 0o700,
  });
  try {
    await writeFile(revisionPath, `${canonicalJson(revision)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = parseRevision(
      JSON.parse(await readFile(revisionPath, "utf8")),
    );
    if (existing.revisionSha256 !== revision.revisionSha256) throw error;
  }
  const unsignedHead = {
    schemaVersion: 1 as const,
    headKind: "tessera-validation-workflow-head" as const,
    workflowId: state.workflowId,
    sequence: state.sequence,
    revisionFilename: filename,
    revisionSha256,
  };
  const head: WorkflowHeadV1 = {
    ...unsignedHead,
    headSha256: valueSha256(unsignedHead),
  };
  await writeAtomic(headPath(storeRoot, state.workflowId), head);
  return head;
}

async function readVerificationUnlocked(
  storeRoot: string,
  workflowId: string,
): Promise<TesseraValidationWorkflowVerification> {
  const head = parseHead(
    JSON.parse(await readFile(headPath(storeRoot, workflowId), "utf8")),
  );
  if (head.workflowId !== workflowId) {
    throw new Error("The validation workflow head has the wrong identity.");
  }
  let filename: string | null = head.revisionFilename;
  let expectedSha256: string | null = head.revisionSha256;
  let expectedSequence = head.sequence;
  let newestState: TesseraValidationWorkflowDocumentV1 | null = null;
  let revisionCount = 0;
  const visited = new Set<string>();
  while (filename !== null && expectedSha256 !== null) {
    if (path.basename(filename) !== filename || visited.has(filename)) {
      throw new Error("The validation workflow revision chain is unsafe.");
    }
    visited.add(filename);
    const revision = parseRevision(
      JSON.parse(
        await readFile(
          path.join(revisionsDirectory(storeRoot, workflowId), filename),
          "utf8",
        ),
      ),
    );
    if (
      revision.workflowId !== workflowId ||
      revision.revisionSha256 !== expectedSha256 ||
      revision.sequence !== expectedSequence
    ) {
      throw new Error("The validation workflow revision chain has a gap.");
    }
    newestState ??= revision.state;
    revisionCount += 1;
    filename = revision.previousRevision?.filename ?? null;
    expectedSha256 = revision.previousRevision?.sha256 ?? null;
    expectedSequence -= 1;
  }
  if (!newestState || expectedSequence !== 0 || revisionCount !== head.sequence) {
    throw new Error("The validation workflow revision chain is incomplete.");
  }
  return { state: newestState, head, revisionCount };
}

function nowFrom(dependencies: TesseraValidationWorkflowDependencies): string {
  const value = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("The validation workflow clock returned an invalid time.");
  }
  return value;
}

function readyPortfolioTemplateIds(
  portfolio: TesseraStressPortfolio,
): string[] {
  if (portfolio.suite !== "diverse-9") {
    throw new Error(
      "Cross-provider validation requires a frozen diverse-nine portfolio.",
    );
  }
  const ready = portfolio.items.filter(
    (item) => item.status === "ready" && item.roster !== null,
  );
  const templateIds = ready.map((item) => item.templateId);
  if (ready.length !== 9 || uniqueSorted(templateIds).length !== 9) {
    throw new Error(
      "Cross-provider validation requires exactly nine unique ready opponents.",
    );
  }
  const postures = uniqueSorted(ready.map((item) => item.posture));
  const compositions = uniqueSorted(
    ready.map((item) => item.composition),
  );
  const cells = uniqueSorted(
    ready.map((item) => `${item.posture}/${item.composition}`),
  );
  if (postures.length !== 3 || compositions.length !== 3 || cells.length !== 9) {
    throw new Error(
      "The diverse-nine portfolio does not cover all posture/composition cells.",
    );
  }
  if (
    ready.some(
      (item) =>
        typeof (item.fingerprint ?? item.simulationFingerprint) !== "string" ||
        (item.fingerprint ?? item.simulationFingerprint)!.length === 0,
    )
  ) {
    throw new Error("Every frozen validation opponent needs a fingerprint.");
  }
  return templateIds;
}

function representativeCoverage(
  portfolio: TesseraStressPortfolio,
  representatives: TesseraStressRepresentative[],
): TesseraValidationRepresentativeCoverage {
  const byId = new Map(
    portfolio.items.map((item) => [item.templateId, item]),
  );
  const representedPostures = uniqueSorted(
    representatives.flatMap((representative) => {
      const item = byId.get(representative.templateId);
      return item ? [item.posture] : [];
    }),
  );
  const representedCompositions = uniqueSorted(
    representatives.flatMap((representative) => {
      const item = byId.get(representative.templateId);
      return item ? [item.composition] : [];
    }),
  );
  return {
    representedPostures,
    representedCompositions,
    adequate:
      representedPostures.length >= 2 &&
      representedCompositions.length >= 2,
  };
}

export function validateTesseraValidationRepresentatives(
  portfolio: TesseraStressPortfolio,
  representatives: TesseraStressRepresentative[],
  completedTemplateIds: string[],
): TesseraValidationRepresentativeCoverage {
  const expectedKinds = ["central", "contrast", "stress"];
  const kinds = uniqueSorted(
    representatives.map((representative) => representative.kind),
  );
  const templateIds = representatives.map(
    (representative) => representative.templateId,
  );
  const frozenIds = new Set(readyPortfolioTemplateIds(portfolio));
  const completedIds = new Set(completedTemplateIds);
  if (
    representatives.length !== 3 ||
    !sameStrings(kinds, expectedKinds) ||
    uniqueSorted(templateIds).length !== 3 ||
    representatives.some(
      (representative) =>
        !frozenIds.has(representative.templateId) ||
        !completedIds.has(representative.templateId) ||
        representative.rationale.trim().length === 0,
    )
  ) {
    throw new Error(
      "Local evidence did not produce distinct stress, central, and contrast representatives from the frozen portfolio.",
    );
  }
  const coverage = representativeCoverage(portfolio, representatives);
  if (!coverage.adequate) {
    throw new Error(
      "The three representatives do not provide adequate posture and composition coverage.",
    );
  }
  return coverage;
}

function executionProjection(
  status: TesseraValidationJobExecutionStatus,
): TesseraValidationExecutionStatus {
  if (["queued", "running"].includes(status)) return "running";
  if (status === "complete") return "succeeded";
  if (status === "degraded" || status === "inconclusive") {
    return "degraded";
  }
  return "failed";
}

function withEvent(
  state: TesseraValidationWorkflowDocumentV1,
  now: string,
  event: TesseraValidationWorkflowEventV1["event"],
  jobId: string | null,
  detailCode: string | null,
  patch: Partial<TesseraValidationWorkflowDocumentV1>,
): TesseraValidationWorkflowDocumentV1 {
  const sequence = state.sequence + 1;
  return {
    ...state,
    ...patch,
    sequence,
    updatedAt: now,
    events: [
      ...state.events,
      { sequence, at: now, event, jobId, detailCode },
    ],
  };
}

async function updateWorkflow(
  storeRoot: string,
  workflowId: string,
  updater: (
    state: TesseraValidationWorkflowDocumentV1,
  ) => Promise<TesseraValidationWorkflowDocumentV1>,
): Promise<TesseraValidationWorkflowDocumentV1> {
  return withWorkflowLock(storeRoot, workflowId, async () => {
    const verification = await readVerificationUnlocked(
      storeRoot,
      workflowId,
    );
    const next = await updater(verification.state);
    if (next === verification.state) return next;
    if (next.sequence !== verification.state.sequence + 1) {
      throw new Error("A validation workflow update must append one revision.");
    }
    await appendRevisionUnlocked(storeRoot, next, verification.head);
    return next;
  });
}

export async function createTesseraValidationWorkflow(
  input: CreateTesseraValidationWorkflowInput,
): Promise<TesseraValidationWorkflowDocumentV1> {
  const workflowId = input.workflowId ?? randomUUID();
  assertWorkflowId(workflowId);
  const playerFingerprint = input.playerFingerprint?.trim() ?? "";
  if (playerFingerprint.length === 0) {
    throw new Error("A frozen player fingerprint is required.");
  }
  const validationDepth = input.validationDepth ?? "standard";
  if (
    validationDepth === "exhaustive" &&
    input.exhaustiveConfirmation !== true
  ) {
    throw new Error(
      "Exhaustive Web-nine validation must be explicitly confirmed.",
    );
  }
  const frozenTemplateIds = readyPortfolioTemplateIds(input.portfolio);
  const portfolioSha256 = valueSha256(input.portfolio);
  const now = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) {
    throw new Error("The validation workflow creation time is invalid.");
  }
  const state: TesseraValidationWorkflowDocumentV1 = {
    schemaVersion: 1,
    documentKind: "tessera-validation-workflow",
    workflowId,
    sequence: 1,
    createdAt: now,
    updatedAt: now,
    status: "created",
    validationDepth,
    exhaustiveExplicitlyConfirmed: validationDepth === "exhaustive",
    playerFingerprint,
    playerRoster: structuredClone(input.playerRoster ?? null),
    profilePolicy: structuredClone(input.profilePolicy ?? null),
    portfolio: structuredClone(input.portfolio),
    portfolioPreview: structuredClone(input.portfolioPreview ?? null),
    portfolioSha256,
    frozenTemplateIds: [...frozenTemplateIds],
    local: {
      reference: null,
      execution: "pending",
      evidence: "pending",
      completedTemplateIds: [],
      errorCode: null,
    },
    representatives: [],
    representativeCoverage: null,
    web: {
      plannedBatchKind: null,
      plannedTemplateIds: [],
      plannedCaptureCount: 0,
      attempts: [],
      execution: "pending",
      evidence: "pending",
      comparison: "not-evaluated",
      completedTemplateIds: [],
      pendingSuccessorOf: null,
    },
    remainingSix: {
      templateIds: [],
      offeredAt: null,
      confirmedAt: null,
    },
    pendingAction: "start-local-nine",
    events: [
      {
        sequence: 1,
        at: now,
        event: "created",
        jobId: null,
        detailCode:
          validationDepth === "exhaustive"
            ? "EXHAUSTIVE_EXPLICIT"
            : "STANDARD_DEFAULT",
      },
    ],
  };
  return withWorkflowLock(input.storeRoot, workflowId, async () => {
    try {
      await readFile(headPath(input.storeRoot, workflowId), "utf8");
      throw new Error(`Validation workflow ${workflowId} already exists.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await appendRevisionUnlocked(input.storeRoot, state, null);
    return state;
  });
}

export async function verifyTesseraValidationWorkflow(
  storeRoot: string,
  workflowId: string,
): Promise<TesseraValidationWorkflowVerification> {
  assertWorkflowId(workflowId);
  return readVerificationUnlocked(storeRoot, workflowId);
}

export async function readTesseraValidationWorkflow(
  storeRoot: string,
  workflowId: string,
): Promise<TesseraValidationWorkflowDocumentV1> {
  return (await verifyTesseraValidationWorkflow(storeRoot, workflowId))
    .state;
}

function activeWebAttempt(
  state: TesseraValidationWorkflowDocumentV1,
): TesseraValidationJobAttemptV1 | null {
  return state.web.attempts.at(-1) ?? null;
}

function webOfferState(
  state: TesseraValidationWorkflowDocumentV1,
  snapshot: TesseraValidationWebJobSnapshot,
  attempt: TesseraValidationJobAttemptV1,
  now: string,
): TesseraValidationWorkflowDocumentV1 {
  const allCompleted = uniqueSorted([
    ...state.web.completedTemplateIds,
    ...snapshot.completedTemplateIds,
  ]);
  const remainingSix = state.frozenTemplateIds.filter(
    (templateId) => !state.web.plannedTemplateIds.includes(templateId),
  );
  const updatedAttempt: TesseraValidationJobAttemptV1 = {
    ...attempt,
    completedAt: now,
    executionStatus: snapshot.executionStatus,
    trustedEvidence: snapshot.trustedEvidence,
    completedTemplateIds: uniqueSorted(snapshot.completedTemplateIds),
    comparison: snapshot.comparison,
    errorCode: snapshot.errorCode,
  };
  return withEvent(
    state,
    now,
    "remaining-six-offered",
    attempt.reference.jobId,
    snapshot.comparison === "material-divergence"
      ? "MATERIAL_DIVERGENCE"
      : snapshot.comparison === "inconclusive"
        ? "INCONCLUSIVE_COMPARISON"
        : "INCOMPLETE_WEB_EVIDENCE",
    {
      status: "remaining-six-offered",
      web: {
        ...state.web,
        attempts: [
          ...state.web.attempts.slice(0, -1),
          updatedAttempt,
        ],
        execution: executionProjection(snapshot.executionStatus),
        evidence: snapshot.trustedEvidence ? "incomplete" : "untrusted",
        comparison: snapshot.comparison,
        completedTemplateIds: allCompleted,
        pendingSuccessorOf: null,
      },
      remainingSix: {
        templateIds: remainingSix,
        offeredAt: now,
        confirmedAt: null,
      },
      pendingAction: "confirm-remaining-six",
    },
  );
}

async function advanceCreated(
  state: TesseraValidationWorkflowDocumentV1,
  dependencies: TesseraValidationWorkflowDependencies,
): Promise<{
  state: TesseraValidationWorkflowDocumentV1;
  action: AdvanceTesseraValidationWorkflowResult["action"];
}> {
  const reference = await dependencies.launchLocalNine({
    workflowId: state.workflowId,
    playerFingerprint: state.playerFingerprint,
    playerRoster: structuredClone(state.playerRoster),
    profilePolicy: structuredClone(state.profilePolicy),
    portfolio: structuredClone(state.portfolio),
    portfolioPreview: structuredClone(state.portfolioPreview),
    portfolioSha256: state.portfolioSha256,
    templateIds: [...state.frozenTemplateIds],
    suite: "diverse-9",
    analysisStrategy: "full-all",
    metrics: "full-supported",
  });
  assertJobReference(reference);
  const now = nowFrom(dependencies);
  return {
    state: withEvent(
      state,
      now,
      "local-started",
      reference.jobId,
      null,
      {
        status: "local-running",
        local: {
          ...state.local,
          reference,
          execution: "running",
        },
        pendingAction: "poll-local-nine",
      },
    ),
    action: "local-started",
  };
}

async function advanceLocalRunning(
  state: TesseraValidationWorkflowDocumentV1,
  dependencies: TesseraValidationWorkflowDependencies,
): Promise<{
  state: TesseraValidationWorkflowDocumentV1;
  action: AdvanceTesseraValidationWorkflowResult["action"];
}> {
  if (!state.local.reference) {
    throw new Error("The local-nine workflow lost its job reference.");
  }
  const snapshot = await dependencies.pollLocalNine(state.local.reference);
  if (!terminalJobStatus(snapshot.executionStatus)) {
    return { state, action: "local-pending" };
  }
  const now = nowFrom(dependencies);
  const localExecution = executionProjection(snapshot.executionStatus);
  let coverage: TesseraValidationRepresentativeCoverage;
  try {
    if (
      !["complete", "degraded"].includes(snapshot.executionStatus) ||
      !snapshot.trustedEvidence ||
      snapshot.portfolioSha256 !== state.portfolioSha256 ||
      !sameStrings(snapshot.completedTemplateIds, state.frozenTemplateIds)
    ) {
      throw new Error("Local diverse-nine evidence is incomplete or untrusted.");
    }
    coverage = validateTesseraValidationRepresentatives(
      state.portfolio,
      snapshot.representatives,
      snapshot.completedTemplateIds,
    );
  } catch {
    return {
      state: withEvent(
        state,
        now,
        "local-rejected",
        state.local.reference.jobId,
        snapshot.errorCode ?? "LOCAL_EVIDENCE_GATE_FAILED",
        {
          status: "needs-review",
          local: {
            ...state.local,
            execution: localExecution,
            evidence: snapshot.trustedEvidence ? "incomplete" : "untrusted",
            completedTemplateIds: uniqueSorted(
              snapshot.completedTemplateIds,
            ),
            errorCode: snapshot.errorCode,
          },
          pendingAction: "review-evidence",
        },
      ),
      action: "local-rejected",
    };
  }
  const representatives = structuredClone(snapshot.representatives);
  const representativeIds = representatives.map(
    (representative) => representative.templateId,
  );
  const plannedBatchKind =
    state.validationDepth === "exhaustive"
      ? "exhaustive-nine"
      : "representative-three";
  const plannedTemplateIds =
    plannedBatchKind === "exhaustive-nine"
      ? [...state.frozenTemplateIds]
      : representativeIds;
  return {
    state: withEvent(
      state,
      now,
      "web-plan-frozen",
      state.local.reference.jobId,
      plannedBatchKind,
      {
        status: "web-ready",
        local: {
          ...state.local,
          execution: localExecution,
          evidence: "trusted",
          completedTemplateIds: uniqueSorted(snapshot.completedTemplateIds),
          errorCode: null,
        },
        representatives,
        representativeCoverage: coverage,
        web: {
          ...state.web,
          plannedBatchKind,
          plannedTemplateIds,
          plannedCaptureCount:
            plannedTemplateIds.length *
            TESSERA_WEB_CAPTURES_PER_OPPONENT,
        },
        pendingAction: "start-web-batch",
      },
    ),
    action: "web-plan-frozen",
  };
}

async function advanceWebReady(
  state: TesseraValidationWorkflowDocumentV1,
  dependencies: TesseraValidationWorkflowDependencies,
): Promise<{
  state: TesseraValidationWorkflowDocumentV1;
  action: AdvanceTesseraValidationWorkflowResult["action"];
}> {
  if (
    !state.local.reference ||
    !state.web.plannedBatchKind ||
    state.web.plannedTemplateIds.length === 0
  ) {
    throw new Error("The validation workflow has no complete Web plan.");
  }
  const successorOf = state.web.pendingSuccessorOf;
  const reference = await dependencies.launchWebBatch({
    workflowId: state.workflowId,
    playerFingerprint: state.playerFingerprint,
    playerRoster: structuredClone(state.playerRoster),
    profilePolicy: structuredClone(state.profilePolicy),
    portfolio: structuredClone(state.portfolio),
    portfolioPreview: structuredClone(state.portfolioPreview),
    portfolioSha256: state.portfolioSha256,
    batchKind: state.web.plannedBatchKind,
    templateIds: [...state.web.plannedTemplateIds],
    representativeTemplateIds: state.representatives.map(
      (representative) => representative.templateId,
    ),
    localJob: state.local.reference,
    successorOf,
    metrics: "full-supported",
    comparisonMode: "diagnostic-cross-provider",
    expectedCaptureCount:
      state.web.plannedTemplateIds.length *
      TESSERA_WEB_CAPTURES_PER_OPPONENT,
  });
  assertJobReference(reference);
  const now = nowFrom(dependencies);
  const attempt: TesseraValidationJobAttemptV1 = {
    batchKind: state.web.plannedBatchKind,
    templateIds: [...state.web.plannedTemplateIds],
    reference,
    successorOf,
    launchedAt: now,
    completedAt: null,
    executionStatus: "queued",
    trustedEvidence: false,
    completedTemplateIds: [],
    comparison: "not-evaluated",
    errorCode: null,
  };
  return {
    state: withEvent(
      state,
      now,
      "web-started",
      reference.jobId,
      state.web.plannedBatchKind,
      {
        status: "web-running",
        web: {
          ...state.web,
          attempts: [...state.web.attempts, attempt],
          execution: "running",
          evidence: "pending",
          pendingSuccessorOf: null,
        },
        pendingAction: "poll-web-batch",
      },
    ),
    action: "web-started",
  };
}

async function advanceWebRunning(
  state: TesseraValidationWorkflowDocumentV1,
  dependencies: TesseraValidationWorkflowDependencies,
): Promise<{
  state: TesseraValidationWorkflowDocumentV1;
  action: AdvanceTesseraValidationWorkflowResult["action"];
}> {
  const attempt = activeWebAttempt(state);
  if (!attempt) throw new Error("The Web workflow lost its active attempt.");
  const snapshot = await dependencies.pollWebBatch(attempt.reference);
  if (!terminalJobStatus(snapshot.executionStatus)) {
    return { state, action: "web-pending" };
  }
  const now = nowFrom(dependencies);
  const unexpectedTemplateIds = snapshot.completedTemplateIds.filter(
    (templateId) => !attempt.templateIds.includes(templateId),
  );
  const plannedComplete = sameStrings(
    snapshot.completedTemplateIds,
    attempt.templateIds,
  );
  const updatedAttempt: TesseraValidationJobAttemptV1 = {
    ...attempt,
    completedAt: now,
    executionStatus: snapshot.executionStatus,
    trustedEvidence: snapshot.trustedEvidence,
    completedTemplateIds: uniqueSorted(snapshot.completedTemplateIds),
    comparison: snapshot.comparison,
    errorCode: snapshot.errorCode,
  };
  if (snapshot.requiresSuccessor) {
    return {
      state: withEvent(
        state,
        now,
        "successor-offered",
        attempt.reference.jobId,
        snapshot.errorCode ?? "WEB_SUCCESSOR_REQUIRED",
        {
          status: "needs-successor-confirmation",
          web: {
            ...state.web,
            attempts: [
              ...state.web.attempts.slice(0, -1),
              updatedAttempt,
            ],
            execution: executionProjection(snapshot.executionStatus),
            evidence: "untrusted",
            comparison: snapshot.comparison,
            completedTemplateIds: uniqueSorted([
              ...state.web.completedTemplateIds,
              ...snapshot.completedTemplateIds,
            ]),
            pendingSuccessorOf: attempt.reference,
          },
          pendingAction: "confirm-successor",
        },
      ),
      action: "successor-confirmation-required",
    };
  }
  const isRepresentativeBatch = attempt.batchKind === "representative-three";
  const executionUsable = ["complete", "degraded"].includes(
    snapshot.executionStatus,
  );
  if (
    isRepresentativeBatch &&
    unexpectedTemplateIds.length === 0 &&
    (["complete", "degraded", "inconclusive"].includes(
      snapshot.executionStatus,
    )) &&
    (!plannedComplete ||
      !snapshot.trustedEvidence ||
      snapshot.executionStatus === "inconclusive" ||
      snapshot.comparison === "inconclusive" ||
      snapshot.comparison === "not-evaluated" ||
      snapshot.comparison === "material-divergence")
  ) {
    return {
      state: webOfferState(state, snapshot, attempt, now),
      action: "remaining-six-offered",
    };
  }
  const evidenceTrusted =
    executionUsable &&
    snapshot.trustedEvidence &&
    plannedComplete &&
    unexpectedTemplateIds.length === 0 &&
    snapshot.comparison !== "not-evaluated" &&
    snapshot.comparison !== "inconclusive";
  const allCompleted = uniqueSorted([
    ...state.web.completedTemplateIds,
    ...snapshot.completedTemplateIds,
  ]);
  if (!evidenceTrusted) {
    return {
      state: withEvent(
        state,
        now,
        "web-evidence-rejected",
        attempt.reference.jobId,
        snapshot.errorCode ?? "WEB_EVIDENCE_GATE_FAILED",
        {
          status: "needs-review",
          web: {
            ...state.web,
            attempts: [
              ...state.web.attempts.slice(0, -1),
              updatedAttempt,
            ],
            execution: executionProjection(snapshot.executionStatus),
            evidence: snapshot.trustedEvidence ? "incomplete" : "untrusted",
            comparison: snapshot.comparison,
            completedTemplateIds: allCompleted,
            pendingSuccessorOf: null,
          },
          pendingAction: "review-evidence",
        },
      ),
      action: "needs-review",
    };
  }
  return {
    state: withEvent(
      state,
      now,
      "completed",
      attempt.reference.jobId,
      snapshot.comparison,
      {
        status: "complete",
        web: {
          ...state.web,
          attempts: [
            ...state.web.attempts.slice(0, -1),
            updatedAttempt,
          ],
          execution: executionProjection(snapshot.executionStatus),
          evidence: "trusted",
          comparison: snapshot.comparison,
          completedTemplateIds: allCompleted,
          pendingSuccessorOf: null,
        },
        pendingAction: "none",
      },
    ),
    action: "web-completed",
  };
}

export async function advanceTesseraValidationWorkflow(
  storeRoot: string,
  workflowId: string,
  dependencies: TesseraValidationWorkflowDependencies,
): Promise<AdvanceTesseraValidationWorkflowResult> {
  let action: AdvanceTesseraValidationWorkflowResult["action"] =
    "needs-review";
  const before = await readTesseraValidationWorkflow(storeRoot, workflowId);
  if (
    [
      "remaining-six-offered",
      "needs-successor-confirmation",
      "needs-review",
      "complete",
    ].includes(before.status)
  ) {
    return {
      state: before,
      changed: false,
      action:
        before.status === "complete"
          ? "complete"
          : before.status === "needs-review"
            ? "needs-review"
            : "awaiting-confirmation",
    };
  }
  const state = await updateWorkflow(
    storeRoot,
    workflowId,
    async (current) => {
      let result: {
        state: TesseraValidationWorkflowDocumentV1;
        action: AdvanceTesseraValidationWorkflowResult["action"];
      };
      if (current.status === "created") {
        result = await advanceCreated(current, dependencies);
      } else if (current.status === "local-running") {
        result = await advanceLocalRunning(current, dependencies);
      } else if (
        current.status === "web-ready" ||
        current.status === "remaining-six-ready"
      ) {
        result = await advanceWebReady(current, dependencies);
      } else if (current.status === "web-running") {
        result = await advanceWebRunning(current, dependencies);
      } else {
        result = { state: current, action: "needs-review" };
      }
      action = result.action;
      return result.state;
    },
  );
  return {
    state,
    changed: state.sequence !== before.sequence,
    action,
  };
}

export async function confirmTesseraValidationRemainingSix(
  storeRoot: string,
  workflowId: string,
  expectedOfferSequence: number,
  now = new Date().toISOString(),
): Promise<TesseraValidationWorkflowDocumentV1> {
  return updateWorkflow(storeRoot, workflowId, async (state) => {
    if (
      state.status !== "remaining-six-offered" ||
      state.sequence !== expectedOfferSequence ||
      state.remainingSix.templateIds.length !== 6
    ) {
      throw new Error(
        "The remaining-six offer changed or is no longer confirmable.",
      );
    }
    return withEvent(
      state,
      now,
      "remaining-six-confirmed",
      activeWebAttempt(state)?.reference.jobId ?? null,
      "EXPLICIT_CONFIRMATION",
      {
        status: "remaining-six-ready",
        web: {
          ...state.web,
          plannedBatchKind: "remaining-six",
          plannedTemplateIds: [...state.remainingSix.templateIds],
          plannedCaptureCount:
            state.remainingSix.templateIds.length *
            TESSERA_WEB_CAPTURES_PER_OPPONENT,
          pendingSuccessorOf: null,
        },
        remainingSix: {
          ...state.remainingSix,
          confirmedAt: now,
        },
        pendingAction: "start-web-batch",
      },
    );
  });
}

export async function confirmTesseraValidationSuccessor(
  storeRoot: string,
  workflowId: string,
  failedJobId: string,
  expectedOfferSequence: number,
  now = new Date().toISOString(),
): Promise<TesseraValidationWorkflowDocumentV1> {
  return updateWorkflow(storeRoot, workflowId, async (state) => {
    const predecessor = state.web.pendingSuccessorOf;
    if (
      state.status !== "needs-successor-confirmation" ||
      state.sequence !== expectedOfferSequence ||
      !predecessor ||
      predecessor.jobId !== failedJobId
    ) {
      throw new Error(
        "The successor offer changed or is no longer confirmable.",
      );
    }
    return withEvent(
      state,
      now,
      "successor-confirmed",
      failedJobId,
      "EXPLICIT_CONFIRMATION",
      {
        status: "web-ready",
        web: {
          ...state.web,
          pendingSuccessorOf: predecessor,
        },
        pendingAction: "start-web-batch",
      },
    );
  });
}

export async function listTesseraValidationWorkflows(
  storeRoot: string,
): Promise<string[]> {
  try {
    const entries = await readdir(path.resolve(storeRoot), {
      withFileTypes: true,
    });
    return entries
      .filter(
        (entry) => entry.isDirectory() && workflowIdPattern.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
