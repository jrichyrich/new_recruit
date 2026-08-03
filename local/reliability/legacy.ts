import {
  reliabilityIsoDateSchema,
  reliabilitySha256Schema,
  type AppendWorkflowReliabilityEventInput,
  type LegacyWorkflowReliabilitySnapshotV1,
  type WorkflowReliabilityAppendResult,
  type WorkflowReliabilityExecutionV1,
  type WorkflowReliabilityOutcomeV1,
} from "./types";
import type { WorkflowReliabilityEventStore } from "./store";
import { createTimingSpanV1 } from "./timing";

function legacyOutcome(status: string): WorkflowReliabilityOutcomeV1 {
  switch (status.trim().toLowerCase()) {
    case "complete":
    case "completed":
    case "ready":
    case "success":
    case "succeeded":
      return "succeeded";
    case "degraded":
      return "degraded";
    case "inconclusive":
      return "inconclusive";
    case "action-required":
    case "needs-input":
    case "ready-for-web":
      return "needs-input";
    case "blocked":
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "in-progress":
    case "queued":
    case "running":
      return "in-progress";
    default:
      return "observed";
  }
}

function legacyExecutionStatus(
  outcome: WorkflowReliabilityOutcomeV1,
): WorkflowReliabilityExecutionV1["status"] {
  switch (outcome) {
    case "started":
    case "in-progress":
      return "running";
    case "succeeded":
    case "recovered":
      return "succeeded";
    case "degraded":
      return "degraded";
    case "inconclusive":
      return "inconclusive";
    case "needs-input":
      return "needs-input";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "not-started";
  }
}

function completedLegacySpan(
  spanKind: "execution" | "evidence",
  name: "workflow-total" | "evidence-verification",
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
) {
  if (!startedAt || !endedAt) return null;
  return createTimingSpanV1({
    spanKind,
    name,
    startedAt,
    endedAt,
    clock: "legacy",
  });
}

function assertLegacySnapshotDates(
  snapshot: LegacyWorkflowReliabilitySnapshotV1,
): void {
  for (const [name, value] of Object.entries({
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    executionStartedAt: snapshot.executionStartedAt,
    executionCompletedAt: snapshot.executionCompletedAt,
    evidenceObservedAt: snapshot.evidenceObservedAt,
  })) {
    if (value !== null && value !== undefined) {
      reliabilityIsoDateSchema.parse(value, { path: [name] });
    }
  }
  if (snapshot.evidenceSha256) {
    reliabilitySha256Schema.parse(snapshot.evidenceSha256, {
      path: ["evidenceSha256"],
    });
  }
}

/**
 * Converts a mutable legacy snapshot into deterministic append intents. The
 * source snapshot remains authoritative; these events only make its observed
 * lifecycle available to the reliability history API.
 */
export function synthesizeLegacyWorkflowReliabilityEvents(
  snapshot: LegacyWorkflowReliabilitySnapshotV1,
): AppendWorkflowReliabilityEventInput[] {
  assertLegacySnapshotDates(snapshot);
  const sourcePrefix = `legacy:${snapshot.sourceKind}:${snapshot.sourceId}`;
  const outcome = legacyOutcome(snapshot.status);
  const executionTiming = completedLegacySpan(
    "execution",
    "workflow-total",
    snapshot.executionStartedAt ?? snapshot.createdAt,
    snapshot.executionCompletedAt,
  );
  const evidenceTiming = completedLegacySpan(
    "evidence",
    "evidence-verification",
    snapshot.executionCompletedAt ?? snapshot.executionStartedAt ??
      snapshot.createdAt,
    snapshot.evidenceObservedAt,
  );
  const evidenceSha256 = snapshot.evidenceSha256 ?? null;
  const artifactCount = snapshot.artifactCount ?? 0;
  const evidenceStatus = evidenceSha256
    ? "verified" as const
    : artifactCount > 0
      ? "partial" as const
      : "none" as const;
  const snapshotIdentity = snapshot.sourceSha256 ?? snapshot.updatedAt;

  return [
    {
      workflow: snapshot.workflow,
      idempotencyKey: `${sourcePrefix}:started`,
      eventKind: "legacy-workflow-observed",
      stage: "legacy-import",
      provider: snapshot.provider ?? null,
      outcome: "started",
      occurredAt: snapshot.createdAt,
      execution: {
        status: "running",
        attempt: snapshot.attempt ?? null,
      },
      attributes: {
        legacy: true,
        sourceKind: snapshot.sourceKind,
        sourceId: snapshot.sourceId,
      },
    },
    {
      workflow: snapshot.workflow,
      idempotencyKey: `${sourcePrefix}:snapshot:${snapshotIdentity}`,
      eventKind: "legacy-workflow-snapshot",
      stage: snapshot.stage ?? "legacy-import",
      provider: snapshot.provider ?? null,
      outcome,
      occurredAt: snapshot.updatedAt,
      timings: [executionTiming, evidenceTiming].filter(
        (timing): timing is NonNullable<typeof timing> => timing !== null,
      ),
      execution: {
        status: legacyExecutionStatus(outcome),
        attempt: snapshot.attempt ?? null,
      },
      evidence: {
        status: evidenceStatus,
        artifactCount,
        evidenceSha256,
      },
      error: snapshot.error ?? null,
      attributes: {
        legacy: true,
        sourceKind: snapshot.sourceKind,
        sourceId: snapshot.sourceId,
        sourceSha256: snapshot.sourceSha256 ?? null,
        legacyStatus: snapshot.status,
        snapshot: snapshot.attributes ?? null,
      },
    },
  ];
}

export async function appendLegacyWorkflowReliabilitySnapshot(
  store: WorkflowReliabilityEventStore,
  snapshot: LegacyWorkflowReliabilitySnapshotV1,
): Promise<WorkflowReliabilityAppendResult[]> {
  const events = synthesizeLegacyWorkflowReliabilityEvents(snapshot);
  const results: WorkflowReliabilityAppendResult[] = [];
  for (const event of events) results.push(await store.append(event));
  return results;
}
