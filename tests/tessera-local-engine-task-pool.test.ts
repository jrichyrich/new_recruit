import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultLocalEngineTaskPoolSize,
  LocalEngineTaskPoolError,
  runLocalEngineTaskPool,
  type LocalEngineTaskPoolTask,
} from "../local/tessera/local-engine-task-pool";

const fixtureModule = new URL(
  "./fixtures/local-engine-task-pool-worker.mjs",
  import.meta.url,
);

type FixtureInput = {
  label: string;
  spinMs: number;
  fail?: boolean;
  crash?: boolean;
  attemptLogPath?: string;
  tamperInputFile?: boolean;
  nested: { value: number };
};

type FixtureResult = {
  label: string;
  nestedValue: number;
  checksum: number;
  processId: number;
  startedAt: number;
  finishedAt: number;
};

type DeterministicInput = {
  id: string;
  values: number[];
  seed: number;
  spinMs: number;
  globalFailure?: boolean;
};

type DeterministicResult = {
  id: string;
  sum: number;
  seed: number;
};

function maximumConcurrentProcesses(
  results: readonly { startedAt: number; finishedAt: number }[],
): number {
  const boundaries = results.flatMap((result) => [
    { at: result.startedAt, delta: 1 },
    { at: result.finishedAt, delta: -1 },
  ]);
  boundaries.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const boundary of boundaries) {
    active += boundary.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

test("local-engine task-pool defaults reserve one CPU and cap at three workers", () => {
  assert.equal(defaultLocalEngineTaskPoolSize(1), 1);
  assert.equal(defaultLocalEngineTaskPoolSize(2), 1);
  assert.equal(defaultLocalEngineTaskPoolSize(3), 2);
  assert.equal(defaultLocalEngineTaskPoolSize(4), 3);
  assert.equal(defaultLocalEngineTaskPoolSize(64), 3);
  assert.equal(defaultLocalEngineTaskPoolSize(Number.NaN), 1);
});

test("local-engine process-pool freezes isolated inputs and returns canonical order", async () => {
  const nested = { value: 7 };
  const results = await runLocalEngineTaskPool<FixtureInput, FixtureResult>(
    [
      {
        id: "z-task",
        orderKey: "20:last",
        payload: { label: "z", spinMs: 150, nested },
      },
      {
        id: "b-task",
        orderKey: "10:first",
        payload: { label: "b", spinMs: 150, nested },
      },
      {
        id: "a-task",
        orderKey: "10:first",
        payload: { label: "a", spinMs: 150, nested },
      },
      {
        id: "m-task",
        orderKey: "15:middle",
        payload: { label: "m", spinMs: 150, nested },
      },
    ],
    {
      poolSize: 2,
      workerModule: fixtureModule,
      workerExport: "runFixtureTask",
    },
  );

  assert.deepEqual(
    results.map((entry) => entry.id),
    ["a-task", "b-task", "m-task", "z-task"],
  );
  assert.deepEqual(
    results.map((entry) => entry.value.label),
    ["a", "b", "m", "z"],
  );
  assert.equal(nested.value, 7);
  const processIds = new Set(results.map((entry) => entry.value.processId));
  assert.equal(processIds.size, 2);
  assert.equal(
    maximumConcurrentProcesses(results.map((entry) => entry.value)),
    2,
  );
  assert.equal(Object.isFrozen(results), true);
  assert.equal(Object.isFrozen(results[0].value), true);
});

test("local-engine process-pool is canonically equivalent in serial and parallel execution", async () => {
  const tasks = [
    {
      id: "contrast",
      orderKey: "30:contrast",
      payload: { id: "contrast", values: [8, 13], seed: 103, spinMs: 40 },
    },
    {
      id: "stress",
      orderKey: "10:stress",
      payload: { id: "stress", values: [2, 3], seed: 101, spinMs: 40 },
    },
    {
      id: "central",
      orderKey: "20:central",
      payload: { id: "central", values: [5, 7], seed: 102, spinMs: 40 },
    },
  ] satisfies LocalEngineTaskPoolTask<DeterministicInput>[];
  const serial = await runLocalEngineTaskPool<
    DeterministicInput,
    DeterministicResult
  >(tasks, {
    poolSize: 1,
    workerModule: fixtureModule,
    workerExport: "runDeterministicTask",
  });
  const parallel = await runLocalEngineTaskPool<
    DeterministicInput,
    DeterministicResult
  >(tasks, {
    poolSize: 3,
    workerModule: fixtureModule,
    workerExport: "runDeterministicTask",
  });

  assert.deepEqual(parallel, serial);
  assert.deepEqual(
    parallel.map((entry) => entry.id),
    ["stress", "central", "contrast"],
  );
});

test("local-engine task-pool rejects the complete batch on one worker failure", async () => {
  await assert.rejects(
    runLocalEngineTaskPool<FixtureInput, FixtureResult>(
      [
        {
          id: "failure",
          orderKey: "a",
          payload: {
            label: "broken",
            spinMs: 0,
            fail: true,
            nested: { value: 1 },
          },
        },
        {
          id: "other",
          orderKey: "b",
          payload: {
            label: "other",
            spinMs: 500,
            nested: { value: 2 },
          },
        },
      ],
      {
        poolSize: 2,
        workerModule: fixtureModule,
        workerExport: "runFixtureTask",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof LocalEngineTaskPoolError);
      assert.equal(error.code, "LOCAL_ENGINE_POOL_TASK_FAILED");
      assert.equal(error.taskId, "failure");
      assert.equal(error.remoteCode, "FIXTURE_FAILURE");
      return true;
    },
  );
});

test("local-engine process-pool fails closed on a provider-wide task failure", async () => {
  await assert.rejects(
    runLocalEngineTaskPool<DeterministicInput, DeterministicResult>(
      [
        {
          id: "provider-failure",
          orderKey: "a",
          payload: {
            id: "provider-failure",
            values: [1],
            seed: 1,
            spinMs: 0,
            globalFailure: true,
          },
        },
        {
          id: "queued-after-failure",
          orderKey: "b",
          payload: {
            id: "queued-after-failure",
            values: [2],
            seed: 2,
            spinMs: 500,
          },
        },
      ],
      {
        poolSize: 1,
        workerModule: fixtureModule,
        workerExport: "runDeterministicTask",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof LocalEngineTaskPoolError);
      assert.equal(error.code, "LOCAL_ENGINE_POOL_TASK_FAILED");
      assert.equal(error.taskId, "provider-failure");
      assert.equal(error.remoteCode, "FIXTURE_PROVIDER_UNAVAILABLE");
      return true;
    },
  );
});

test("local-engine task-pool cancellation terminates synchronous CPU workers", async () => {
  const controller = new AbortController();
  const running = runLocalEngineTaskPool<FixtureInput, FixtureResult>(
    [
      {
        id: "long-running",
        orderKey: "a",
        payload: {
          label: "long-running",
          spinMs: 2_000,
          nested: { value: 1 },
        },
      },
    ],
    {
      poolSize: 1,
      signal: controller.signal,
      workerModule: fixtureModule,
      workerExport: "runFixtureTask",
    },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, (error: unknown) => {
    assert.ok(error instanceof LocalEngineTaskPoolError);
    assert.equal(error.code, "LOCAL_ENGINE_POOL_ABORTED");
    return true;
  });
});

test("local-engine task-pool rejects duplicate task identities before spawning", async () => {
  await assert.rejects(
    runLocalEngineTaskPool(
      [
        { id: "same", orderKey: "a", payload: { value: 1 } },
        { id: "same", orderKey: "b", payload: { value: 2 } },
      ],
      {
        workerModule: fixtureModule,
        workerExport: "runFixtureTask",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof LocalEngineTaskPoolError);
      assert.equal(error.code, "LOCAL_ENGINE_POOL_INVALID_TASK");
      return true;
    },
  );
});

test("local-engine process-pool detects child mutation of a sealed task file", async () => {
  await assert.rejects(
    runLocalEngineTaskPool<FixtureInput, FixtureResult>(
      [
        {
          id: "tampered-input",
          orderKey: "a",
          payload: {
            label: "tampered",
            spinMs: 0,
            tamperInputFile: true,
            nested: { value: 1 },
          },
        },
      ],
      {
        poolSize: 1,
        workerModule: fixtureModule,
        workerExport: "runFixtureTask",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof LocalEngineTaskPoolError);
      assert.equal(error.code, "LOCAL_ENGINE_POOL_PROTOCOL_ERROR");
      assert.equal(error.taskId, "tampered-input");
      return true;
    },
  );
});

test("local-engine process-pool owns and bounds process-exit retries", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "rosterpilot-pool-retry-test-"),
  );
  const attemptLogPath = path.join(directory, "attempts.log");
  try {
    await assert.rejects(
      runLocalEngineTaskPool<FixtureInput, FixtureResult>(
        [
          {
            id: "crashing-child",
            orderKey: "a",
            payload: {
              label: "crash",
              spinMs: 0,
              crash: true,
              attemptLogPath,
              nested: { value: 1 },
            },
          },
        ],
        {
          poolSize: 1,
          maxTaskAttempts: 2,
          workerModule: fixtureModule,
          workerExport: "runFixtureTask",
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof LocalEngineTaskPoolError);
        assert.equal(error.code, "LOCAL_ENGINE_POOL_WORKER_EXITED");
        assert.equal(error.taskId, "crashing-child");
        return true;
      },
    );
    const attempts = (await readFile(attemptLogPath, "utf8"))
      .trim()
      .split("\n");
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts).size, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
