import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendLegacyWorkflowReliabilitySnapshot,
  appendWorkflowReliabilityEventSafely,
  createTimingSpanV1,
  createWorkflowReliabilityEventStore,
  readWorkflowReliabilityAggregateSummary,
  readWorkflowReliabilitySummary,
  synthesizeLegacyWorkflowReliabilityEvents,
  workflowReliabilityStorePaths,
  type AppendWorkflowReliabilityEventInput,
  type WorkflowReliabilityRefV1,
} from "../local/reliability";

const workflow: WorkflowReliabilityRefV1 = {
  workflowId: "run-fixture",
  workflowKind: "tessera-web",
};
const occurredAt = "2026-08-03T12:00:00.000Z";

function eventInput(
  idempotencyKey: string,
  overrides: Partial<AppendWorkflowReliabilityEventInput> = {},
): AppendWorkflowReliabilityEventInput {
  return {
    workflow,
    idempotencyKey,
    eventKind: "fixture-observed",
    outcome: "observed",
    occurredAt,
    ...overrides,
  };
}

async function temporaryStore() {
  const rootDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-reliability-"),
  );
  return {
    rootDirectory,
    store: createWorkflowReliabilityEventStore({ rootDirectory }),
  };
}

test("reliability verification detects immutable event tampering", async () => {
  const fixture = await temporaryStore();
  try {
    await fixture.store.append(eventInput("tamper-1"));
    await fixture.store.append(eventInput("tamper-2"));
    const paths = workflowReliabilityStorePaths(
      fixture.rootDirectory,
      workflow,
    );
    const filename = (await readdir(paths.eventsDirectory)).sort()[0];
    const event = JSON.parse(
      await readFile(path.join(paths.eventsDirectory, filename), "utf8"),
    ) as Record<string, unknown>;
    event.attributes = { tampered: true };
    await writeFile(
      path.join(paths.eventsDirectory, filename),
      `${JSON.stringify(event)}\n`,
    );

    const verification = await fixture.store.verify(workflow);
    assert.equal(verification.ok, false);
    assert.ok(
      verification.issues.some(
        (issue) => issue.code === "EVENT_HASH_MISMATCH",
      ),
    );
    await assert.rejects(
      fixture.store.append(eventInput("tamper-3")),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "RELIABILITY_EVENT_CHAIN_INVALID",
        ),
    );
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});

test("reliability verification detects sequence gaps", async () => {
  const fixture = await temporaryStore();
  try {
    await fixture.store.append(eventInput("gap-1"));
    await fixture.store.append(eventInput("gap-2"));
    await fixture.store.append(eventInput("gap-3"));
    const paths = workflowReliabilityStorePaths(
      fixture.rootDirectory,
      workflow,
    );
    const filenames = (await readdir(paths.eventsDirectory)).sort();
    await rm(path.join(paths.eventsDirectory, filenames[1]));

    const verification = await fixture.store.verify(workflow);
    assert.equal(verification.ok, false);
    assert.ok(
      verification.issues.some(
        (issue) => issue.code === "EVENT_SEQUENCE_GAP",
      ),
    );
    assert.ok(
      verification.issues.some(
        (issue) => issue.code === "EVENT_PREVIOUS_HASH_MISMATCH",
      ),
    );
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});

test("concurrent reliability appends produce one contiguous hash chain", async () => {
  const fixture = await temporaryStore();
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        fixture.store.append(
          eventInput(`concurrent-${index}`, {
            attributes: { index },
          }),
        ),
      ),
    );
    assert.equal(results.filter((result) => result.created).length, 20);
    const history = await fixture.store.history(workflow);
    assert.equal(history.verification.ok, true);
    assert.deepEqual(
      history.events.map((event) => event.sequence),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    assert.equal(new Set(history.events.map((event) => event.eventId)).size, 20);
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});

test("reconciliation recovers an event persisted before head update", async () => {
  const rootDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-reliability-interrupted-"),
  );
  let interrupt = true;
  const interrupted = createWorkflowReliabilityEventStore({
    rootDirectory,
    dependencies: {
      onEventPersisted: () => {
        if (interrupt) {
          interrupt = false;
          throw new Error("simulated interruption");
        }
      },
    },
  });
  const input = eventInput("interrupted-head");
  try {
    await assert.rejects(interrupted.append(input), /simulated interruption/);
    const before = await interrupted.verify(workflow);
    assert.equal(before.eventCount, 1);
    assert.ok(before.issues.some((issue) => issue.code === "HEAD_MISSING"));
    assert.ok(
      before.issues.some((issue) => issue.code === "REGISTRY_MISSING"),
    );

    const restarted = createWorkflowReliabilityEventStore({ rootDirectory });
    const reconciled = await restarted.reconcile(workflow);
    assert.equal(reconciled.repairedHead, true);
    assert.equal(reconciled.repairedRegistry, true);
    assert.equal(reconciled.verification.ok, true);

    const retry = await restarted.append(input);
    assert.equal(retry.created, false);
    assert.equal(retry.event.sequence, 1);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("idempotent append reuses an event and rejects conflicting intent", async () => {
  const fixture = await temporaryStore();
  try {
    const input = eventInput("stable-idempotency-key");
    const first = await fixture.store.append(input);
    const second = await fixture.store.append(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.event.eventId, first.event.eventId);

    await assert.rejects(
      fixture.store.append({
        ...input,
        eventKind: "different-intent",
      }),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "RELIABILITY_IDEMPOTENCY_CONFLICT",
        ),
    );
    assert.equal((await fixture.store.history(workflow)).events.length, 1);
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});

test("legacy snapshots synthesize deterministic lifecycle history", async () => {
  const fixture = await temporaryStore();
  const snapshot = {
    workflow,
    sourceKind: "tessera-job-v2",
    sourceId: "legacy-run",
    sourceSha256: "a".repeat(64),
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:03:00.000Z",
    executionStartedAt: "2026-08-03T10:00:10.000Z",
    executionCompletedAt: "2026-08-03T10:02:00.000Z",
    evidenceObservedAt: "2026-08-03T10:03:00.000Z",
    status: "failed",
    stage: "website-automation",
    provider: "tessera-web",
    attempt: 2,
    artifactCount: 1,
    evidenceSha256: "b".repeat(64),
    error: {
      code: "LEGACY_FAILURE",
      message: "Legacy failure",
      retryable: true,
    },
    attributes: { migrated: true },
  } as const;
  try {
    const synthesized = synthesizeLegacyWorkflowReliabilityEvents(snapshot);
    assert.equal(synthesized.length, 2);
    assert.equal(synthesized[0].outcome, "started");
    assert.equal(synthesized[1].outcome, "failed");
    assert.deepEqual(
      synthesized[1].timings?.map((span) => span.spanKind),
      ["execution", "evidence"],
    );

    const first = await appendLegacyWorkflowReliabilitySnapshot(
      fixture.store,
      snapshot,
    );
    const retry = await appendLegacyWorkflowReliabilitySnapshot(
      fixture.store,
      snapshot,
    );
    assert.deepEqual(first.map((result) => result.created), [true, true]);
    assert.deepEqual(retry.map((result) => result.created), [false, false]);
    const history = await fixture.store.history(workflow);
    assert.equal(history.events.length, 2);
    assert.equal(history.events[1].evidence.status, "verified");
    assert.equal(history.events[1].execution.status, "failed");
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});

test("reliability records sanitize secrets, credentials, and user paths", async () => {
  const fixture = await temporaryStore();
  const cyclic: Record<string, unknown> = {
    token: "secret-one",
    detail: "Authorization: Bearer secret-two at /Users/jasricha/private",
    url: "https://name:password@example.test/path",
  };
  cyclic.self = cyclic;
  try {
    await fixture.store.append(
      eventInput("sanitize", {
        attributes: cyclic,
        error: {
          code: "AUTH_FAILURE",
          message: "password=secret-three in /Users/jasricha/profile",
          retryable: false,
        },
      }),
    );
    const serialized = JSON.stringify(
      (await fixture.store.history(workflow)).events,
    );
    assert.doesNotMatch(serialized, /secret-one|secret-two|secret-three/);
    assert.doesNotMatch(serialized, /jasricha|name:password/);
    assert.match(serialized, /\[redacted\]/);
    assert.match(serialized, /\[circular\]/);
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});

test("summary keeps execution time separate from evidence collection time", async () => {
  const fixture = await temporaryStore();
  try {
    await fixture.store.append(
      eventInput("timing-separation", {
        outcome: "succeeded",
        timings: [
          createTimingSpanV1({
            spanKind: "execution",
            name: "per-proxy-simulation",
            startedAt: "2026-08-03T12:00:00.000Z",
            endedAt: "2026-08-03T12:00:00.100Z",
          }),
          createTimingSpanV1({
            spanKind: "evidence",
            name: "evidence-verification",
            startedAt: "2026-08-03T12:00:00.100Z",
            endedAt: "2026-08-03T12:00:01.100Z",
          }),
        ],
        evidence: {
          status: "verified",
          artifactCount: 2,
          evidenceSha256: "c".repeat(64),
        },
      }),
    );

    const summary = await readWorkflowReliabilitySummary(
      fixture.store,
      workflow,
    );
    assert.equal(summary.timing.execution.totalMs, 100);
    assert.equal(summary.timing.evidence.totalMs, 1_000);
    assert.equal(summary.timing.executionToEvidenceLag.totalMs, 1_000);
    assert.equal(
      summary.timing.byName["per-proxy-simulation"].totalMs,
      100,
    );
    assert.equal(
      summary.timing.byName["evidence-verification"].totalMs,
      1_000,
    );
    assert.equal(summary.retainedArtifactCount, 2);
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});

test("summary separates recovered execution from trusted final evidence and repair activity", async () => {
  const fixture = await temporaryStore();
  try {
    await fixture.store.append(
      eventInput("failed-attempt", {
        eventKind: "failure",
        outcome: "failed",
        occurredAt: "2026-08-03T12:00:00.000Z",
        execution: { status: "failed", attempt: 1 },
        error: {
          code: "WEB_RUNTIME_FAILURE",
          message: "The Web companion stopped before evidence capture.",
          retryable: true,
        },
      }),
    );
    await fixture.store.append(
      eventInput("repair-offered", {
        eventKind: "repair-offered",
        outcome: "needs-input",
        occurredAt: "2026-08-03T12:01:00.000Z",
        execution: { status: "needs-input", attempt: 1 },
      }),
    );
    await fixture.store.append(
      eventInput("repair-approved", {
        eventKind: "approval",
        outcome: "observed",
        occurredAt: "2026-08-03T12:02:00.000Z",
        attributes: { cacheReuses: 2 },
      }),
    );
    await fixture.store.append(
      eventInput("repair-applied", {
        eventKind: "repair-applied",
        outcome: "recovered",
        occurredAt: "2026-08-03T12:03:00.000Z",
        execution: { status: "succeeded", attempt: 2 },
      }),
    );
    await fixture.store.append(
      eventInput("receipt-verified", {
        eventKind: "new-recruit-receipt-verified",
        outcome: "succeeded",
        occurredAt: "2026-08-03T12:04:00.000Z",
        execution: { status: "succeeded", attempt: 2 },
        evidence: {
          status: "verified",
          artifactCount: 3,
          evidenceSha256: "d".repeat(64),
        },
        attributes: { externalMutations: 1, duplicateMutations: 0 },
      }),
    );

    const summary = await readWorkflowReliabilitySummary(
      fixture.store,
      workflow,
    );
    assert.deepEqual(summary.executionSuccess, {
      attemptCount: 2,
      firstAttemptSucceeded: false,
      recoverySucceeded: true,
      finalExecutionStatus: "succeeded",
    });
    assert.deepEqual(summary.trustedEvidenceSuccess, {
      succeeded: true,
      confidence: "high",
      verifiedEvents: 1,
      invalidEvents: 0,
    });
    assert.equal(summary.repair.offered, 1);
    assert.equal(summary.repair.applied, 1);
    assert.equal(summary.repair.duration.totalMs, 180_000);
    assert.deepEqual(summary.recurrenceByErrorCode, {
      WEB_RUNTIME_FAILURE: 1,
    });
    assert.equal(summary.userActions, 1);
    assert.equal(summary.cacheReuseEvents, 2);
    assert.equal(summary.externalMutations, 1);
    assert.equal(summary.duplicateMutations, 0);
    assert.deepEqual(summary.receiptValidity, {
      verified: 1,
      invalid: 0,
      unknown: 0,
    });
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});

test("aggregate summary combines workflow outcomes, rates, evidence, recurrence, and timing", async () => {
  const fixture = await temporaryStore();
  const secondWorkflow: WorkflowReliabilityRefV1 = {
    workflowId: "run-second",
    workflowKind: "tessera-web",
  };
  const dataWorkflow: WorkflowReliabilityRefV1 = {
    workflowId: "update-one",
    workflowKind: "data-update",
  };
  try {
    await fixture.store.append(
      eventInput("aggregate-failure", {
        eventKind: "failure",
        outcome: "failed",
        execution: { status: "failed", attempt: 1 },
        error: {
          code: "WEB_RUNTIME_FAILURE",
          message: "The first website attempt failed.",
          retryable: true,
        },
      }),
    );
    await fixture.store.append(
      eventInput("aggregate-recovery", {
        eventKind: "repair-applied",
        outcome: "recovered",
        occurredAt: "2026-08-03T12:01:00.000Z",
        execution: { status: "succeeded", attempt: 2 },
        evidence: {
          status: "verified",
          artifactCount: 2,
          evidenceSha256: "e".repeat(64),
        },
        timings: [
          createTimingSpanV1({
            spanKind: "recovery",
            name: "recovery",
            startedAt: "2026-08-03T12:00:00.000Z",
            endedAt: "2026-08-03T12:01:00.000Z",
          }),
        ],
      }),
    );
    await fixture.store.append(
      eventInput("aggregate-first-pass", {
        workflow: secondWorkflow,
        eventKind: "finalization",
        outcome: "succeeded",
        execution: { status: "succeeded", attempt: 1 },
        evidence: {
          status: "verified",
          artifactCount: 1,
          evidenceSha256: "f".repeat(64),
        },
      }),
    );
    await fixture.store.append(
      eventInput("aggregate-update", {
        workflow: dataWorkflow,
        eventKind: "transition",
        outcome: "observed",
      }),
    );

    const aggregate = await readWorkflowReliabilityAggregateSummary(
      fixture.store,
    );
    assert.equal(aggregate.workflowCount, 3);
    assert.deepEqual(aggregate.workflowKinds, {
      "data-update": 1,
      "tessera-web": 2,
    });
    assert.equal(aggregate.eventCount, 4);
    assert.equal(aggregate.failures, 1);
    assert.deepEqual(aggregate.executionSuccess, {
      workflowsWithAttempts: 2,
      firstAttemptSucceeded: 1,
      firstAttemptSuccessRate: 0.5,
      workflowsWithFailures: 1,
      recoverySucceeded: 1,
      recoverySuccessRate: 1,
    });
    assert.equal(aggregate.trustedEvidenceSuccess.succeeded, 2);
    assert.equal(aggregate.trustedEvidenceSuccess.successRate, 2 / 3);
    assert.deepEqual(aggregate.recurrenceByErrorCode, {
      WEB_RUNTIME_FAILURE: 1,
    });
    assert.equal(aggregate.repair.duration.totalMs, 60_000);
    assert.equal(aggregate.timing.recovery.totalMs, 60_000);
    assert.equal(aggregate.retainedArtifactCount, 3);

    const filtered = await readWorkflowReliabilityAggregateSummary(
      fixture.store,
      { workflowKind: "tessera-web" },
    );
    assert.equal(filtered.workflowCount, 2);
    assert.deepEqual(filtered.workflowKinds, { "tessera-web": 2 });
    assert.equal(filtered.eventCount, 3);
    assert.equal(filtered.trustedEvidenceSuccess.successRate, 1);
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});

test("non-throwing reliability adapters return stable error envelopes", async () => {
  const fixture = await temporaryStore();
  try {
    const invalid = await appendWorkflowReliabilityEventSafely(
      fixture.store,
      eventInput("", { eventKind: "invalid" }),
    );
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.data, null);
      assert.equal(invalid.error.code, "RELIABILITY_ADAPTER_FAILED");
      assert.match(invalid.error.message, /at least 1 character/i);
    }
  } finally {
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  }
});
