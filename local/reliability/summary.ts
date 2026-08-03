import {
  TimingSpanNamesV1,
  WorkflowReliabilityOutcomeV1Schema,
  type TimingMetricSummaryV1,
  type TimingSpanNameV1,
  type WorkflowReliabilityAggregateSummaryV1,
  type WorkflowReliabilityHistory,
  type WorkflowReliabilityRefV1,
  type WorkflowReliabilitySummaryV1,
} from "./types";
import type { WorkflowReliabilityEventStore } from "./store";

function metricSummary(values: number[]): TimingMetricSummaryV1 {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return {
      sampleCount: 0,
      totalMs: 0,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    };
  }
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  const percentile = (ratio: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
  return {
    sampleCount: sorted.length,
    totalMs,
    meanMs: totalMs / sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? null,
  };
}

function completedDurations(
  history: WorkflowReliabilityHistory,
  spanKind: "queue" | "execution" | "evidence" | "recovery",
): number[] {
  return history.events.flatMap((event) =>
    event.timings
      .filter(
        (span) =>
          span.spanKind === spanKind &&
          span.endedAt !== null &&
          span.durationMs !== null,
      )
      .map((span) => span.durationMs as number),
  );
}

function durationsForName(
  history: WorkflowReliabilityHistory,
  name: TimingSpanNameV1,
): number[] {
  return history.events.flatMap((event) =>
    event.timings
      .filter(
        (span) =>
          span.name === name &&
          span.endedAt !== null &&
          span.durationMs !== null,
      )
      .map((span) => span.durationMs as number),
  );
}

function executionToEvidenceLags(
  history: WorkflowReliabilityHistory,
): number[] {
  const values: number[] = [];
  for (const event of history.events) {
    const executionEnds = event.timings
      .filter(
        (span) =>
          span.spanKind === "execution" && span.endedAt !== null,
      )
      .map((span) => Date.parse(span.endedAt as string));
    const evidenceEnds = event.timings
      .filter(
        (span) => span.spanKind === "evidence" && span.endedAt !== null,
      )
      .map((span) => Date.parse(span.endedAt as string));
    if (executionEnds.length === 0 || evidenceEnds.length === 0) continue;
    const executionEnd = Math.max(...executionEnds);
    const evidenceEnd = Math.max(...evidenceEnds);
    if (evidenceEnd >= executionEnd) values.push(evidenceEnd - executionEnd);
  }
  return values;
}

function normalizedEventKind(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_]+/g, "-");
}

function numericAttribute(
  attributes: Record<string, unknown>,
  key: string,
): number {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function repairDurations(
  history: WorkflowReliabilityHistory,
): number[] {
  const events = [...history.events].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );
  const durations: number[] = [];
  let failureAt: number | null = null;
  for (const event of events) {
    if (event.outcome === "failed") {
      failureAt ??= Date.parse(event.occurredAt);
      continue;
    }
    const kind = normalizedEventKind(event.eventKind);
    if (
      failureAt !== null &&
      (
        kind.includes("repair-applied") ||
        kind === "verification" ||
        event.outcome === "recovered" ||
        event.outcome === "succeeded"
      )
    ) {
      durations.push(Math.max(0, Date.parse(event.occurredAt) - failureAt));
      failureAt = null;
    }
  }
  return durations;
}

export function summarizeWorkflowReliabilityHistory(
  history: WorkflowReliabilityHistory,
): WorkflowReliabilitySummaryV1 {
  const outcomes = Object.fromEntries(
    WorkflowReliabilityOutcomeV1Schema.options.map((outcome) => [outcome, 0]),
  ) as WorkflowReliabilitySummaryV1["outcomes"];
  for (const event of history.events) outcomes[event.outcome] += 1;
  const occurred = history.events
    .map((event) => event.occurredAt)
    .sort((left, right) => left.localeCompare(right));
  const byName = Object.fromEntries(
    TimingSpanNamesV1.map((name) => [
      name,
      metricSummary(durationsForName(history, name)),
    ]),
  ) as Record<TimingSpanNameV1, TimingMetricSummaryV1>;
  const attempts = new Set(
    history.events.flatMap((event) =>
      event.execution.attempt === null
        ? []
        : [event.execution.attempt],
    ),
  );
  const firstAttemptSucceeded = history.events.some(
    (event) =>
      event.execution.attempt === 1 &&
      (event.execution.status === "succeeded" ||
        event.execution.status === "degraded"),
  );
  const failedIndex = history.events.findIndex(
    (event) => event.outcome === "failed",
  );
  const recoverySucceeded =
    failedIndex >= 0 &&
    history.events.slice(failedIndex + 1).some(
      (event) =>
        event.outcome === "recovered" ||
        event.outcome === "succeeded",
    );
  const recurrenceByErrorCode: Record<string, number> = {};
  for (const event of history.events) {
    if (!event.error?.code) continue;
    recurrenceByErrorCode[event.error.code] =
      (recurrenceByErrorCode[event.error.code] ?? 0) + 1;
  }
  const eventKinds = history.events.map((event) => ({
    event,
    kind: normalizedEventKind(event.eventKind),
  }));
  const verifiedEvidenceEvents = history.events.filter(
    (event) => event.evidence.status === "verified",
  ).length;
  const invalidEvidenceEvents = history.events.filter(
    (event) => event.evidence.status === "invalid",
  ).length;
  const last = history.events.at(-1) ?? null;
  const trustedEvidenceSucceeded = Boolean(
    history.verification.ok &&
      last &&
      ["succeeded", "degraded", "recovered"].includes(last.outcome) &&
      last.evidence.status === "verified",
  );
  const evidenceConfidence = !history.verification.ok || invalidEvidenceEvents > 0
    ? "low" as const
    : trustedEvidenceSucceeded
      ? "high" as const
      : verifiedEvidenceEvents > 0
        ? "review" as const
        : "none" as const;
  const receiptEvents = eventKinds.filter(({ kind }) =>
    kind.includes("receipt"),
  );
  return {
    schemaVersion: 1,
    summaryKind: "workflow-reliability-summary",
    workflow: history.workflow,
    integrity: history.verification.ok ? "verified" : "invalid",
    eventCount: history.events.length,
    firstOccurredAt: occurred[0] ?? null,
    lastOccurredAt: occurred.at(-1) ?? null,
    lastOutcome: history.events.at(-1)?.outcome ?? null,
    outcomes,
    failures: history.events.filter((event) => event.outcome === "failed")
      .length,
    retryableFailures: history.events.filter(
      (event) => event.outcome === "failed" && event.error?.retryable,
    ).length,
    verifiedEvidenceEvents,
    retainedArtifactCount: history.events.reduce(
      (sum, event) => sum + event.evidence.artifactCount,
      0,
    ),
    executionSuccess: {
      attemptCount: attempts.size,
      firstAttemptSucceeded,
      recoverySucceeded,
      finalExecutionStatus: last?.execution.status ?? null,
    },
    trustedEvidenceSuccess: {
      succeeded: trustedEvidenceSucceeded,
      confidence: evidenceConfidence,
      verifiedEvents: verifiedEvidenceEvents,
      invalidEvents: invalidEvidenceEvents,
    },
    repair: {
      offered: eventKinds.filter(({ kind }) =>
        kind.includes("repair-offered"),
      ).length,
      applied: eventKinds.filter(({ kind }) =>
        kind.includes("repair-applied"),
      ).length,
      verified: eventKinds.filter(
        ({ kind, event }) =>
          (kind === "verification" || kind.includes("repair-verified")) &&
          event.evidence.status === "verified",
      ).length,
      duration: metricSummary(repairDurations(history)),
    },
    recurrenceByErrorCode: Object.fromEntries(
      Object.entries(recurrenceByErrorCode).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    userActions: eventKinds.filter(({ kind }) =>
      ["approval", "confirmation", "user-action"].some((token) =>
        kind.includes(token),
      ),
    ).length,
    cacheReuseEvents: eventKinds.reduce(
      (sum, { kind, event }) =>
        sum +
        (kind.includes("artifact-reuse") || kind.includes("cache-reuse")
          ? 1
          : 0) +
        numericAttribute(event.attributes, "cacheReuses"),
      0,
    ),
    externalMutations: eventKinds.reduce(
      (sum, { kind, event }) =>
        sum +
        (kind.includes("external-mutation") ? 1 : 0) +
        numericAttribute(event.attributes, "externalMutations"),
      0,
    ),
    duplicateMutations: eventKinds.reduce(
      (sum, { kind, event }) =>
        sum +
        (kind.includes("duplicate-mutation") ? 1 : 0) +
        numericAttribute(event.attributes, "duplicateMutations"),
      0,
    ),
    receiptValidity: {
      verified: receiptEvents.filter(
        ({ event }) => event.evidence.status === "verified",
      ).length,
      invalid: receiptEvents.filter(
        ({ event }) => event.evidence.status === "invalid",
      ).length,
      unknown: receiptEvents.filter(
        ({ event }) =>
          event.evidence.status !== "verified" &&
          event.evidence.status !== "invalid",
      ).length,
    },
    timing: {
      queue: metricSummary(completedDurations(history, "queue")),
      execution: metricSummary(completedDurations(history, "execution")),
      evidence: metricSummary(completedDurations(history, "evidence")),
      recovery: metricSummary(completedDurations(history, "recovery")),
      executionToEvidenceLag: metricSummary(
        executionToEvidenceLags(history),
      ),
      byName,
    },
  };
}

export async function readWorkflowReliabilitySummary(
  store: WorkflowReliabilityEventStore,
  workflow: WorkflowReliabilityRefV1,
): Promise<WorkflowReliabilitySummaryV1> {
  return summarizeWorkflowReliabilityHistory(await store.history(workflow));
}

export async function listWorkflowReliabilitySummaries(
  store: WorkflowReliabilityEventStore,
): Promise<WorkflowReliabilitySummaryV1[]> {
  const workflows = await store.listWorkflowRefs();
  const summaries = await Promise.all(
    workflows.map((workflow) =>
      readWorkflowReliabilitySummary(store, workflow),
    ),
  );
  return summaries.sort((left, right) =>
    (right.lastOccurredAt ?? "").localeCompare(left.lastOccurredAt ?? ""),
  );
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function summarizeWorkflowReliabilityHistories(
  histories: WorkflowReliabilityHistory[],
  options: { workflowKind?: string } = {},
): WorkflowReliabilityAggregateSummaryV1 {
  const selected = histories
    .filter(
      (history) =>
        options.workflowKind === undefined ||
        history.workflow.workflowKind === options.workflowKind,
    )
    .sort((left, right) =>
      `${left.workflow.workflowKind}\0${left.workflow.workflowId}`.localeCompare(
        `${right.workflow.workflowKind}\0${right.workflow.workflowId}`,
      ),
    );
  const summaries = selected.map(summarizeWorkflowReliabilityHistory);
  const outcomes = Object.fromEntries(
    WorkflowReliabilityOutcomeV1Schema.options.map((outcome) => [outcome, 0]),
  ) as WorkflowReliabilityAggregateSummaryV1["outcomes"];
  const workflowKinds: Record<string, number> = {};
  const recurrenceByErrorCode: Record<string, number> = {};
  const confidence: WorkflowReliabilityAggregateSummaryV1[
    "trustedEvidenceSuccess"
  ]["confidence"] = {
    high: 0,
    review: 0,
    low: 0,
    none: 0,
  };
  const occurredAt: string[] = [];
  for (const [index, summary] of summaries.entries()) {
    const history = selected[index];
    workflowKinds[history.workflow.workflowKind] =
      (workflowKinds[history.workflow.workflowKind] ?? 0) + 1;
    for (const outcome of WorkflowReliabilityOutcomeV1Schema.options) {
      outcomes[outcome] += summary.outcomes[outcome];
    }
    for (const [code, count] of Object.entries(
      summary.recurrenceByErrorCode,
    )) {
      recurrenceByErrorCode[code] =
        (recurrenceByErrorCode[code] ?? 0) + count;
    }
    confidence[summary.trustedEvidenceSuccess.confidence] += 1;
    occurredAt.push(
      ...history.events.map((event) => event.occurredAt),
    );
  }
  occurredAt.sort((left, right) => left.localeCompare(right));
  const workflowsWithAttempts = summaries.filter(
    (summary) => summary.executionSuccess.attemptCount > 0,
  ).length;
  const firstAttemptSucceeded = summaries.filter(
    (summary) =>
      summary.executionSuccess.attemptCount > 0 &&
      summary.executionSuccess.firstAttemptSucceeded,
  ).length;
  const workflowsWithFailures = summaries.filter(
    (summary) => summary.failures > 0,
  ).length;
  const recoverySucceeded = summaries.filter(
    (summary) =>
      summary.failures > 0 && summary.executionSuccess.recoverySucceeded,
  ).length;
  const trustedEvidenceSucceeded = summaries.filter(
    (summary) => summary.trustedEvidenceSuccess.succeeded,
  ).length;
  const timingValues = (
    selector: (history: WorkflowReliabilityHistory) => number[],
  ) => selected.flatMap(selector);
  const sum = (
    selector: (summary: WorkflowReliabilitySummaryV1) => number,
  ) => summaries.reduce((total, summary) => total + selector(summary), 0);
  return {
    schemaVersion: 1,
    summaryKind: "workflow-reliability-aggregate-summary",
    filter: {
      workflowKind: options.workflowKind ?? null,
    },
    workflowCount: selected.length,
    workflowKinds: Object.fromEntries(
      Object.entries(workflowKinds).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    integrity: {
      verifiedWorkflows: summaries.filter(
        (summary) => summary.integrity === "verified",
      ).length,
      invalidWorkflows: summaries.filter(
        (summary) => summary.integrity === "invalid",
      ).length,
    },
    eventCount: sum((summary) => summary.eventCount),
    firstOccurredAt: occurredAt[0] ?? null,
    lastOccurredAt: occurredAt.at(-1) ?? null,
    outcomes,
    failures: sum((summary) => summary.failures),
    retryableFailures: sum((summary) => summary.retryableFailures),
    retainedArtifactCount: sum(
      (summary) => summary.retainedArtifactCount,
    ),
    executionSuccess: {
      workflowsWithAttempts,
      firstAttemptSucceeded,
      firstAttemptSuccessRate: rate(
        firstAttemptSucceeded,
        workflowsWithAttempts,
      ),
      workflowsWithFailures,
      recoverySucceeded,
      recoverySuccessRate: rate(
        recoverySucceeded,
        workflowsWithFailures,
      ),
    },
    trustedEvidenceSuccess: {
      succeeded: trustedEvidenceSucceeded,
      successRate: rate(trustedEvidenceSucceeded, selected.length),
      verifiedEvents: sum(
        (summary) => summary.trustedEvidenceSuccess.verifiedEvents,
      ),
      invalidEvents: sum(
        (summary) => summary.trustedEvidenceSuccess.invalidEvents,
      ),
      confidence,
    },
    repair: {
      offered: sum((summary) => summary.repair.offered),
      applied: sum((summary) => summary.repair.applied),
      verified: sum((summary) => summary.repair.verified),
      duration: metricSummary(timingValues(repairDurations)),
    },
    recurrenceByErrorCode: Object.fromEntries(
      Object.entries(recurrenceByErrorCode).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    userActions: sum((summary) => summary.userActions),
    cacheReuseEvents: sum((summary) => summary.cacheReuseEvents),
    externalMutations: sum((summary) => summary.externalMutations),
    duplicateMutations: sum((summary) => summary.duplicateMutations),
    receiptValidity: {
      verified: sum((summary) => summary.receiptValidity.verified),
      invalid: sum((summary) => summary.receiptValidity.invalid),
      unknown: sum((summary) => summary.receiptValidity.unknown),
    },
    timing: {
      queue: metricSummary(
        timingValues((history) => completedDurations(history, "queue")),
      ),
      execution: metricSummary(
        timingValues((history) => completedDurations(history, "execution")),
      ),
      evidence: metricSummary(
        timingValues((history) => completedDurations(history, "evidence")),
      ),
      recovery: metricSummary(
        timingValues((history) => completedDurations(history, "recovery")),
      ),
      executionToEvidenceLag: metricSummary(
        timingValues(executionToEvidenceLags),
      ),
      byName: Object.fromEntries(
        TimingSpanNamesV1.map((name) => [
          name,
          metricSummary(
            timingValues((history) => durationsForName(history, name)),
          ),
        ]),
      ) as Record<TimingSpanNameV1, TimingMetricSummaryV1>,
    },
  };
}

export async function readWorkflowReliabilityAggregateSummary(
  store: WorkflowReliabilityEventStore,
  options: { workflowKind?: string } = {},
): Promise<WorkflowReliabilityAggregateSummaryV1> {
  const workflows = (await store.listWorkflowRefs()).filter(
    (workflow) =>
      options.workflowKind === undefined ||
      workflow.workflowKind === options.workflowKind,
  );
  const histories = await Promise.all(
    workflows.map((workflow) => store.history(workflow)),
  );
  return summarizeWorkflowReliabilityHistories(histories, options);
}
