import { z } from "zod";

export const reliabilitySha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const reliabilityIsoDateSchema = z.string().datetime({ offset: true });

export const TimingSpanNamesV1 = [
  "queue-wait",
  "worker-startup",
  "bundle-lease",
  "preflight",
  "cache-lookup",
  "new-recruit-preparation",
  "browser-startup",
  "browser-authentication",
  "import",
  "per-proxy-simulation",
  "per-scenario-capture",
  "validation",
  "persistence",
  "report-generation",
  "evidence-verification",
  "recovery",
  "workflow-total",
] as const;

export const TimingSpanNameV1Schema = z.enum(TimingSpanNamesV1);
export type TimingSpanNameV1 = z.infer<typeof TimingSpanNameV1Schema>;

export type ReliabilityJsonPrimitive = string | number | boolean | null;
export type ReliabilityJsonValue =
  | ReliabilityJsonPrimitive
  | ReliabilityJsonValue[]
  | { [key: string]: ReliabilityJsonValue };
export type ReliabilityJsonObject = {
  [key: string]: ReliabilityJsonValue;
};

export const TimingSpanV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    spanKind: z.enum([
      "queue",
      "execution",
      "evidence",
      "recovery",
    ]),
    name: TimingSpanNameV1Schema,
    startedAt: reliabilityIsoDateSchema,
    endedAt: reliabilityIsoDateSchema.nullable(),
    durationMs: z.number().finite().nonnegative().nullable(),
    clock: z.enum([
      "wall-clock",
      "monotonic-derived",
      "legacy",
    ]),
  })
  .strict()
  .superRefine((span, context) => {
    if ((span.endedAt === null) !== (span.durationMs === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A timing span must provide both endedAt and durationMs, or neither.",
      });
    }
    if (
      span.endedAt !== null &&
      Date.parse(span.endedAt) < Date.parse(span.startedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A timing span cannot end before it starts.",
      });
    }
  });

export type TimingSpanV1 = z.infer<typeof TimingSpanV1Schema>;

export const WorkflowReliabilityRefV1Schema = z
  .object({
    workflowId: z.string().min(1).max(256),
    workflowKind: z.string().min(1).max(128),
  })
  .strict();

export type WorkflowReliabilityRefV1 = z.infer<
  typeof WorkflowReliabilityRefV1Schema
>;

export const WorkflowReliabilityOutcomeV1Schema = z.enum([
  "observed",
  "started",
  "in-progress",
  "succeeded",
  "degraded",
  "inconclusive",
  "needs-input",
  "failed",
  "cancelled",
  "recovered",
]);

export type WorkflowReliabilityOutcomeV1 = z.infer<
  typeof WorkflowReliabilityOutcomeV1Schema
>;

export const WorkflowReliabilityExecutionV1Schema = z
  .object({
    status: z.enum([
      "not-started",
      "running",
      "succeeded",
      "degraded",
      "inconclusive",
      "needs-input",
      "failed",
      "cancelled",
    ]),
    attempt: z.number().int().positive().nullable(),
  })
  .strict();

export type WorkflowReliabilityExecutionV1 = z.infer<
  typeof WorkflowReliabilityExecutionV1Schema
>;

export const WorkflowReliabilityEvidenceV1Schema = z
  .object({
    status: z.enum([
      "none",
      "pending",
      "partial",
      "verified",
      "invalid",
    ]),
    artifactCount: z.number().int().nonnegative(),
    evidenceSha256: reliabilitySha256Schema.nullable(),
  })
  .strict();

export type WorkflowReliabilityEvidenceV1 = z.infer<
  typeof WorkflowReliabilityEvidenceV1Schema
>;

export const WorkflowReliabilityErrorV1Schema = z
  .object({
    code: z.string().min(1).max(256),
    message: z.string().min(1).max(4_096),
    retryable: z.boolean(),
  })
  .strict();

export type WorkflowReliabilityErrorV1 = z.infer<
  typeof WorkflowReliabilityErrorV1Schema
>;

export const WorkflowReliabilityEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("workflow-reliability-event"),
    workflow: WorkflowReliabilityRefV1Schema,
    sequence: z.number().int().positive(),
    eventId: reliabilitySha256Schema,
    idempotencyKey: z.string().min(1).max(512),
    idempotencySha256: reliabilitySha256Schema,
    eventKind: z.string().min(1).max(256),
    stage: z.string().min(1).max(256).nullable(),
    provider: z.string().min(1).max(128).nullable(),
    outcome: WorkflowReliabilityOutcomeV1Schema,
    occurredAt: reliabilityIsoDateSchema,
    recordedAt: reliabilityIsoDateSchema,
    timings: z.array(TimingSpanV1Schema).max(32),
    execution: WorkflowReliabilityExecutionV1Schema,
    evidence: WorkflowReliabilityEvidenceV1Schema,
    error: WorkflowReliabilityErrorV1Schema.nullable(),
    attributes: z.record(z.string(), z.unknown()),
    previousEventSha256: reliabilitySha256Schema.nullable(),
    eventSha256: reliabilitySha256Schema,
  })
  .strict();

export type WorkflowReliabilityEventV1 = z.infer<
  typeof WorkflowReliabilityEventV1Schema
> & {
  attributes: ReliabilityJsonObject;
};

export type AppendWorkflowReliabilityEventInput = {
  workflow: WorkflowReliabilityRefV1;
  idempotencyKey: string;
  eventKind: string;
  stage?: string | null;
  provider?: string | null;
  outcome: WorkflowReliabilityOutcomeV1;
  occurredAt?: string;
  timings?: TimingSpanV1[];
  execution?: Partial<WorkflowReliabilityExecutionV1>;
  evidence?: Partial<WorkflowReliabilityEvidenceV1>;
  error?: WorkflowReliabilityErrorV1 | null;
  attributes?: unknown;
};

export const WorkflowReliabilityHeadV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("workflow-reliability-head"),
    workflow: WorkflowReliabilityRefV1Schema,
    workflowKey: reliabilitySha256Schema,
    eventCount: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
    lastEventSha256: reliabilitySha256Schema.nullable(),
    updatedAt: reliabilityIsoDateSchema,
    integritySha256: reliabilitySha256Schema,
  })
  .strict();

export type WorkflowReliabilityHeadV1 = z.infer<
  typeof WorkflowReliabilityHeadV1Schema
>;

export const WorkflowReliabilityRegistryEntryV1Schema = z
  .object({
    workflow: WorkflowReliabilityRefV1Schema,
    workflowKey: reliabilitySha256Schema,
    directory: reliabilitySha256Schema,
    eventCount: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
    lastEventSha256: reliabilitySha256Schema.nullable(),
    updatedAt: reliabilityIsoDateSchema,
  })
  .strict();

export type WorkflowReliabilityRegistryEntryV1 = z.infer<
  typeof WorkflowReliabilityRegistryEntryV1Schema
>;

export const WorkflowReliabilityRegistryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("workflow-reliability-registry"),
    entries: z.array(WorkflowReliabilityRegistryEntryV1Schema),
    integritySha256: reliabilitySha256Schema,
  })
  .strict();

export type WorkflowReliabilityRegistryV1 = z.infer<
  typeof WorkflowReliabilityRegistryV1Schema
>;

export type WorkflowReliabilityVerificationIssueCode =
  | "EVENT_DIRECTORY_MISSING"
  | "EVENT_INVALID"
  | "EVENT_FILENAME_INVALID"
  | "EVENT_FILENAME_MISMATCH"
  | "EVENT_SEQUENCE_GAP"
  | "EVENT_WORKFLOW_MISMATCH"
  | "EVENT_ID_MISMATCH"
  | "EVENT_HASH_MISMATCH"
  | "EVENT_PREVIOUS_HASH_MISMATCH"
  | "HEAD_MISSING"
  | "HEAD_INVALID"
  | "HEAD_DIVERGED"
  | "REGISTRY_MISSING"
  | "REGISTRY_INVALID"
  | "REGISTRY_DIVERGED";

export type WorkflowReliabilityVerificationIssue = {
  code: WorkflowReliabilityVerificationIssueCode;
  message: string;
  sequence: number | null;
  filename: string | null;
};

export type WorkflowReliabilityVerification = {
  ok: boolean;
  workflow: WorkflowReliabilityRefV1;
  eventCount: number;
  lastSequence: number;
  lastEventSha256: string | null;
  head: WorkflowReliabilityHeadV1 | null;
  issues: WorkflowReliabilityVerificationIssue[];
};

export type WorkflowReliabilityHistory = {
  workflow: WorkflowReliabilityRefV1;
  events: WorkflowReliabilityEventV1[];
  verification: WorkflowReliabilityVerification;
};

export type TimingMetricSummaryV1 = {
  sampleCount: number;
  totalMs: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export type WorkflowReliabilitySummaryV1 = {
  schemaVersion: 1;
  summaryKind: "workflow-reliability-summary";
  workflow: WorkflowReliabilityRefV1;
  integrity: "verified" | "invalid";
  eventCount: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  lastOutcome: WorkflowReliabilityOutcomeV1 | null;
  outcomes: Record<WorkflowReliabilityOutcomeV1, number>;
  failures: number;
  retryableFailures: number;
  verifiedEvidenceEvents: number;
  retainedArtifactCount: number;
  executionSuccess: {
    attemptCount: number;
    firstAttemptSucceeded: boolean;
    recoverySucceeded: boolean;
    finalExecutionStatus: WorkflowReliabilityExecutionV1["status"] | null;
  };
  trustedEvidenceSuccess: {
    succeeded: boolean;
    confidence: "high" | "review" | "low" | "none";
    verifiedEvents: number;
    invalidEvents: number;
  };
  repair: {
    offered: number;
    applied: number;
    verified: number;
    duration: TimingMetricSummaryV1;
  };
  recurrenceByErrorCode: Record<string, number>;
  userActions: number;
  cacheReuseEvents: number;
  externalMutations: number;
  duplicateMutations: number;
  receiptValidity: {
    verified: number;
    invalid: number;
    unknown: number;
  };
  timing: {
    queue: TimingMetricSummaryV1;
    execution: TimingMetricSummaryV1;
    evidence: TimingMetricSummaryV1;
    recovery: TimingMetricSummaryV1;
    executionToEvidenceLag: TimingMetricSummaryV1;
    byName: Record<TimingSpanNameV1, TimingMetricSummaryV1>;
  };
};

export type WorkflowReliabilityAggregateSummaryV1 = {
  schemaVersion: 1;
  summaryKind: "workflow-reliability-aggregate-summary";
  filter: {
    workflowKind: string | null;
  };
  workflowCount: number;
  workflowKinds: Record<string, number>;
  integrity: {
    verifiedWorkflows: number;
    invalidWorkflows: number;
  };
  eventCount: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  outcomes: Record<WorkflowReliabilityOutcomeV1, number>;
  failures: number;
  retryableFailures: number;
  retainedArtifactCount: number;
  executionSuccess: {
    workflowsWithAttempts: number;
    firstAttemptSucceeded: number;
    firstAttemptSuccessRate: number | null;
    workflowsWithFailures: number;
    recoverySucceeded: number;
    recoverySuccessRate: number | null;
  };
  trustedEvidenceSuccess: {
    succeeded: number;
    successRate: number | null;
    verifiedEvents: number;
    invalidEvents: number;
    confidence: Record<"high" | "review" | "low" | "none", number>;
  };
  repair: {
    offered: number;
    applied: number;
    verified: number;
    duration: TimingMetricSummaryV1;
  };
  recurrenceByErrorCode: Record<string, number>;
  userActions: number;
  cacheReuseEvents: number;
  externalMutations: number;
  duplicateMutations: number;
  receiptValidity: {
    verified: number;
    invalid: number;
    unknown: number;
  };
  timing: {
    queue: TimingMetricSummaryV1;
    execution: TimingMetricSummaryV1;
    evidence: TimingMetricSummaryV1;
    recovery: TimingMetricSummaryV1;
    executionToEvidenceLag: TimingMetricSummaryV1;
    byName: Record<TimingSpanNameV1, TimingMetricSummaryV1>;
  };
};

export type WorkflowReliabilityAppendResult = {
  created: boolean;
  event: WorkflowReliabilityEventV1;
  head: WorkflowReliabilityHeadV1;
};

export type WorkflowReliabilityReconciliationResult = {
  workflow: WorkflowReliabilityRefV1;
  repairedHead: boolean;
  repairedRegistry: boolean;
  verification: WorkflowReliabilityVerification;
};

export type LegacyWorkflowReliabilitySnapshotV1 = {
  workflow: WorkflowReliabilityRefV1;
  sourceKind: string;
  sourceId: string;
  sourceSha256?: string | null;
  createdAt: string;
  updatedAt: string;
  executionStartedAt?: string | null;
  executionCompletedAt?: string | null;
  evidenceObservedAt?: string | null;
  status: string;
  stage?: string | null;
  provider?: string | null;
  attempt?: number | null;
  artifactCount?: number;
  evidenceSha256?: string | null;
  error?: WorkflowReliabilityErrorV1 | null;
  attributes?: unknown;
};
