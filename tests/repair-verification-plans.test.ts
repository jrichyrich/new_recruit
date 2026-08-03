import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  associatePendingRepairVerificationCommits,
  associateRepairVerificationCommit,
  captureRepairVerificationSourceState,
  createRepairVerificationPlanRunner,
  listRepairVerificationPlans,
  parseRepairVerificationTestCounts,
  RepairVerificationRecordV1Schema,
  verifyRepairVerificationRecord,
  type RepairVerificationPlanRuntime,
  type RepairVerificationSourceStateV1,
  type RepairVerificationStepResultV1,
  type RepairVerificationToolchainV1,
} from "../local/reliability/verification-plans";
import { createWorkflowReliabilityEventStore } from "../local/reliability/store";

const execFileAsync = promisify(execFile);
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

function sourceState(
  sourceFingerprint = digestA,
): RepairVerificationSourceStateV1 {
  return {
    gitHead: "1".repeat(40),
    clean: false,
    changedFiles: [
      { path: "local/example.ts", sha256: digestB, kind: "file" },
    ],
    dirtyDiffSha256: digestC,
    sourceFingerprint,
  };
}

function toolchain(): RepairVerificationToolchainV1 {
  return {
    nodeVersion: "v22.13.0",
    npmVersion: "10.9.2",
    typescriptVersion: "5.9.3",
    tsxVersion: "4.20.6",
    eslintVersion: "9.39.4",
    gitVersion: "git version 2.51.0",
    platform: "darwin",
    architecture: "arm64",
    packageJsonSha256: digestA,
    packageLockSha256: digestB,
  };
}

function successfulStep(stepId: string): RepairVerificationStepResultV1 {
  return {
    schemaVersion: 1,
    stepId,
    tool: "node",
    startedAt: "2026-08-03T12:00:01.000Z",
    endedAt: "2026-08-03T12:00:02.000Z",
    durationMs: 1_000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    spawnError: null,
    passed: true,
    testCounts: {
      tests: 7,
      passed: 7,
      failed: 0,
      skipped: 0,
      todo: 0,
      suites: 1,
    },
    stdout: {
      boundedSha256: digestA,
      bytesObserved: 256,
      bytesHashed: 256,
      truncated: false,
    },
    stderr: {
      boundedSha256: digestB,
      bytesObserved: 0,
      bytesHashed: 0,
      truncated: false,
    },
  };
}

function fakeRuntime(options: {
  before?: RepairVerificationSourceStateV1;
  after?: RepairVerificationSourceStateV1;
  failStep?: boolean;
  observedStepIds?: string[];
} = {}): RepairVerificationPlanRuntime {
  const dates = [
    new Date("2026-08-03T12:00:00.000Z"),
    new Date("2026-08-03T12:00:03.000Z"),
  ];
  let dateIndex = 0;
  let sourceIndex = 0;
  return {
    now: () => dates[Math.min(dateIndex++, dates.length - 1)],
    captureSourceState: async () => {
      const value =
        sourceIndex++ === 0
          ? options.before ?? sourceState()
          : options.after ?? sourceState();
      return structuredClone(value);
    },
    captureToolchain: async () => toolchain(),
    executeStep: async (step) => {
      options.observedStepIds?.push(step.stepId);
      const result = successfulStep(step.stepId);
      if (options.failStep) {
        result.exitCode = 1;
        result.passed = false;
        result.testCounts = {
          tests: 7,
          passed: 6,
          failed: 1,
          skipped: 0,
          todo: 0,
          suites: 1,
        };
      }
      return result;
    },
  };
}

test("repair verification exposes named plans without command injection fields", () => {
  const plans = listRepairVerificationPlans();
  assert.ok(plans.length >= 8);
  assert.ok(plans.some((plan) => plan.planName === "batch-preflight"));
  assert.ok(plans.some((plan) => plan.planName === "complete-suite"));
  for (const plan of plans) {
    assert.deepEqual(Object.keys(plan).sort(), [
      "description",
      "planName",
      "stepIds",
    ]);
    assert.ok(plan.stepIds.every((stepId) => stepId.length > 0));
  }
});

test("unknown repair verification plans fail before any step executes", async () => {
  const observedStepIds: string[] = [];
  const runner = createRepairVerificationPlanRunner(
    fakeRuntime({ observedStepIds }),
  );
  await assert.rejects(
    runner.run({
      planName: "node -e arbitrary-code" as never,
      repositoryRoot: process.cwd(),
    }),
  );
  assert.deepEqual(observedStepIds, []);
});

test("repair verification seals source, toolchain, tests, and bounded output hashes", async () => {
  const runner = createRepairVerificationPlanRunner(fakeRuntime());
  const result = await runner.run({
    planName: "reliability-journal",
    repositoryRoot: process.cwd(),
  });

  assert.equal(result.record.passed, true);
  assert.equal(result.record.sourceChangedDuringVerification, false);
  assert.equal(result.record.sourceAfter.changedFiles[0].path, "local/example.ts");
  assert.equal(result.record.steps[0].testCounts?.tests, 7);
  assert.equal(result.record.steps[0].stdout.bytesHashed, 256);
  assert.equal(result.record.toolchain.typescriptVersion, "5.9.3");
  assert.equal(result.journal.attempted, false);
  assert.deepEqual(
    verifyRepairVerificationRecord(result.record),
    RepairVerificationRecordV1Schema.parse(result.record),
  );

  const tampered = structuredClone(result.record);
  tampered.steps[0].testCounts!.passed = 6;
  assert.throws(
    () => verifyRepairVerificationRecord(tampered),
    /record hash does not match/,
  );
});

test("source changes during a verification make otherwise passing tests fail", async () => {
  const result = await createRepairVerificationPlanRunner(
    fakeRuntime({ after: sourceState("d".repeat(64)) }),
  ).run({
    planName: "reliability-journal",
    repositoryRoot: process.cwd(),
  });
  assert.equal(result.record.steps[0].passed, true);
  assert.equal(result.record.sourceChangedDuringVerification, true);
  assert.equal(result.record.passed, false);
});

test("verification events are appended without storing raw command output", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-repair-verification-"),
  );
  const store = createWorkflowReliabilityEventStore({
    rootDirectory: directory,
  });
  const workflow = {
    workflowId: "repair-fixture",
    workflowKind: "tessera-run",
  };
  try {
    const result = await createRepairVerificationPlanRunner(fakeRuntime()).run({
      planName: "reliability-journal",
      repositoryRoot: process.cwd(),
      journal: { store, workflow },
    });
    assert.equal(result.journal.attempted, true);
    assert.equal(result.journal.appended, true);
    const history = await store.history(workflow);
    assert.equal(history.verification.ok, true);
    assert.equal(history.events.length, 1);
    assert.equal(history.events[0].eventKind, "verification");
    assert.equal(history.events[0].evidence.status, "verified");
    const serialized = JSON.stringify(history.events[0]);
    assert.equal(serialized.includes("stdout"), true);
    assert.equal(serialized.includes("Authorization: Bearer"), false);
    assert.equal(serialized.includes("rawOutput"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TAP summaries expose observable test counts", () => {
  const parsed = parseRepairVerificationTestCounts(`TAP version 13
# tests 12
# suites 2
# pass 10
# fail 1
# cancelled 0
# skipped 1
# todo 0
`);
  assert.deepEqual(parsed, {
    tests: 12,
    passed: 10,
    failed: 1,
    skipped: 1,
    todo: 0,
    suites: 2,
  });
  assert.equal(
    parseRepairVerificationTestCounts("Build completed successfully."),
    null,
  );
  assert.deepEqual(
    parseRepairVerificationTestCounts(`ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ skipped 0
ℹ todo 0
`),
    {
      tests: 3,
      passed: 3,
      failed: 0,
      skipped: 0,
      todo: 0,
      suites: 0,
    },
  );
});

test("a later clean commit is associated only when repaired file hashes match", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-repair-commit-"),
  );
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "RosterPilot Test"], {
      cwd: directory,
    });
    await execFileAsync(
      "git",
      ["config", "user.email", "rosterpilot@example.invalid"],
      { cwd: directory },
    );
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({ name: "rosterpilot" })}\n`,
    );
    await writeFile(path.join(directory, "repair.txt"), "before\n");
    await execFileAsync("git", ["add", "package.json", "repair.txt"], {
      cwd: directory,
    });
    await execFileAsync("git", ["commit", "-qm", "initial"], {
      cwd: directory,
    });
    await writeFile(path.join(directory, "repair.txt"), "after\n");

    const dates = [
      new Date("2026-08-03T12:00:00.000Z"),
      new Date("2026-08-03T12:00:03.000Z"),
    ];
    let dateIndex = 0;
    const runtime: RepairVerificationPlanRuntime = {
      now: () => dates[Math.min(dateIndex++, dates.length - 1)],
      captureSourceState: captureRepairVerificationSourceState,
      captureToolchain: async () => toolchain(),
      executeStep: async (step) => successfulStep(step.stepId),
    };
    const verification = await createRepairVerificationPlanRunner(runtime).run({
      planName: "reliability-journal",
      repositoryRoot: directory,
    });
    assert.equal(verification.record.passed, true);
    assert.deepEqual(
      verification.record.sourceAfter.changedFiles.map((entry) => entry.path),
      ["repair.txt"],
    );

    await execFileAsync("git", ["add", "repair.txt"], { cwd: directory });
    await execFileAsync("git", ["commit", "-qm", "repair source"], {
      cwd: directory,
    });
    const associated = await associateRepairVerificationCommit({
      record: verification.record,
      repositoryRoot: directory,
    });
    assert.equal(associated.matched, true);
    assert.equal(associated.reason, "matched");
    assert.match(associated.commit ?? "", /^[0-9a-f]{40}$/);

    await writeFile(path.join(directory, "repair.txt"), "different\n");
    const dirty = await associateRepairVerificationCommit({
      record: verification.record,
      repositoryRoot: directory,
    });
    assert.equal(dirty.matched, false);
    assert.equal(dirty.reason, "worktree-not-clean");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup reconciliation automatically associates pending verified repairs", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-automatic-repair-commit-"),
  );
  const reliabilityDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-automatic-reliability-"),
  );
  const workflow = {
    workflowId: "automatic-commit-fixture",
    workflowKind: "tessera-run",
  };
  const store = createWorkflowReliabilityEventStore({
    rootDirectory: reliabilityDirectory,
  });
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "RosterPilot Test"], {
      cwd: directory,
    });
    await execFileAsync(
      "git",
      ["config", "user.email", "rosterpilot@example.invalid"],
      { cwd: directory },
    );
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({ name: "rosterpilot" })}\n`,
    );
    await writeFile(path.join(directory, "repair.txt"), "before\n");
    await execFileAsync("git", ["add", "package.json", "repair.txt"], {
      cwd: directory,
    });
    await execFileAsync("git", ["commit", "-qm", "initial"], {
      cwd: directory,
    });
    await writeFile(path.join(directory, "repair.txt"), "after\n");

    const dates = [
      new Date("2026-08-03T12:00:00.000Z"),
      new Date("2026-08-03T12:00:03.000Z"),
    ];
    let dateIndex = 0;
    const runtime: RepairVerificationPlanRuntime = {
      now: () => dates[Math.min(dateIndex++, dates.length - 1)],
      captureSourceState: captureRepairVerificationSourceState,
      captureToolchain: async () => toolchain(),
      executeStep: async (step) => successfulStep(step.stepId),
    };
    const verification = await createRepairVerificationPlanRunner(runtime).run({
      planName: "reliability-journal",
      repositoryRoot: directory,
      journal: { store, workflow },
    });
    assert.equal(verification.record.passed, true);
    const deferred = await associatePendingRepairVerificationCommits({
      store,
      repositoryRoot: directory,
    });
    assert.equal(deferred.verificationCandidates, 0);
    assert.match(deferred.warnings[0] ?? "", /checkout is clean/);
    assert.equal((await store.history(workflow)).events.length, 1);
    await execFileAsync("git", ["add", "repair.txt"], { cwd: directory });
    await execFileAsync("git", ["commit", "-qm", "repair source"], {
      cwd: directory,
    });

    const automatic = await associatePendingRepairVerificationCommits({
      store,
      repositoryRoot: directory,
    });
    assert.equal(automatic.verificationCandidates, 1);
    assert.equal(automatic.associated.length, 1);
    assert.equal(automatic.skipped.length, 0);
    const history = await store.history(workflow);
    assert.deepEqual(
      history.events.map((event) => event.eventKind),
      ["verification", "commit-association"],
    );
    assert.equal(history.events[1].attributes.automatic, true);
    assert.equal(
      history.events[1].attributes.verificationRecordSha256,
      verification.record.recordSha256,
    );

    const repeated = await associatePendingRepairVerificationCommits({
      store,
      repositoryRoot: directory,
    });
    assert.equal(repeated.verificationCandidates, 0);
    assert.equal(repeated.alreadyAssociated, 1);
    assert.equal(repeated.associated.length, 0);
    assert.equal((await store.history(workflow)).events.length, 2);

    await writeFile(path.join(directory, "repair.txt"), "verified-state\n");
    const secondVerification =
      await createRepairVerificationPlanRunner(runtime).run({
        planName: "reliability-journal",
        repositoryRoot: directory,
        journal: { store, workflow },
      });
    assert.equal(secondVerification.record.passed, true);
    await writeFile(path.join(directory, "repair.txt"), "different-state\n");
    await execFileAsync("git", ["add", "repair.txt"], { cwd: directory });
    await execFileAsync("git", ["commit", "-qm", "different source"], {
      cwd: directory,
    });
    const mismatched = await associatePendingRepairVerificationCommits({
      store,
      repositoryRoot: directory,
    });
    assert.equal(mismatched.verificationCandidates, 1);
    assert.equal(mismatched.associated.length, 0);
    assert.equal(mismatched.skipped[0]?.reason, "file-state-mismatch");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(reliabilityDirectory, { recursive: true, force: true });
  }
});
