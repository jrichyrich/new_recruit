import assert from "node:assert/strict";
import {
  lstat,
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  sha256Hex,
} from "../lib/rosterpilot/semantic-hash";
import {
  LOCAL_SOURCE_CHECK_INTERVAL_MS,
  LOCAL_SOURCE_CERTIFICATION_TIMEOUT_MS,
  LOCAL_SOURCE_FULL_CERTIFICATION_SHARDS,
  LOCAL_SOURCE_MINIMUM_CERTIFICATION_STATUS,
  LOCAL_SOURCE_INITIAL_RETRY_MS,
  LOCAL_SOURCE_MAX_RETRY_MS,
  LocalSourcePipelineError,
  assertSafeBsDataCheckout,
  createDefaultLocalSourceUpdatePipeline,
  createLocalSourceUpdateCoordinator,
  evaluateLocalSourceUpdateDue,
  localSourceRetryDelayMs,
  runBoundedCommand,
  type LocalSourceUpdatePipeline,
  type BoundedCommandRunner,
} from "../local/data-bundles/local-source-updater";
import type {
  LocalSourceCandidateReference,
  LocalSourceObservationV1,
} from "../local/data-bundles/local-source-candidate";
import {
  verifyLocalSourceCandidate,
  writeLocalSourceBundleArtifacts,
} from "../local/data-bundles/local-source-candidate";
import type {
  DataBundleManifestDraftV1,
  DataBundleShardV1,
} from "../lib/rosterpilot/data-bundle";
import {
  semanticHash,
} from "../lib/rosterpilot/semantic-hash";
import type {
  RuntimeDataBundleBuild,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  createWorkflowReliabilityEventStore,
  resolveWorkflowReliabilityIdentity,
} from "../local/reliability";

const digest = (character: string) => character.repeat(64);
const NPM_INTEGRITY = `sha512-${"A".repeat(86)}==`;
const LATEST_BSDATA_COMMIT =
  "21b4efa69d7212cb206fdcbf98aa606ee49f78a2";
const HISTORICAL_BSDATA_COMMIT =
  "419a80d35346cd9bf26d32f69b4a5df404beb95d";

test("full local certification is bounded and split across isolated shards", () => {
  assert.equal(LOCAL_SOURCE_CERTIFICATION_TIMEOUT_MS, 60 * 60_000);
  assert.equal(LOCAL_SOURCE_FULL_CERTIFICATION_SHARDS, 4);
  assert.equal(LOCAL_SOURCE_MINIMUM_CERTIFICATION_STATUS, "degraded");
});

function observation(checkedAt: string): LocalSourceObservationV1 {
  return {
    checkedAt,
    rules: {
      package: "@alpaca-software/40kdc-data",
      version: "1.2.2",
      registryUrl:
        "https://registry.npmjs.org/@alpaca-software%2F40kdc-data/latest",
      distIntegrity: NPM_INTEGRITY,
      tarballUrl:
        "https://registry.npmjs.org/@alpaca-software/40kdc-data/-/40kdc-data-1.2.2.tgz",
    },
    newRecruit: {
      repository: "BSData/wh40k-11e",
      url: "https://github.com/BSData/wh40k-11e.git",
      branch: "main",
      commit: LATEST_BSDATA_COMMIT,
      latestCommit: LATEST_BSDATA_COMMIT,
    },
    official: {
      downloadsUrl:
        "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
      mfmUrl: "https://mfm.warhammer-community.com/en",
      observedVersion: "1.2",
      observedContentSha256: digest("a"),
      retainedVersion: "1.1",
      retainedContentSha256: digest("b"),
      disposition: "update-pending",
    },
  };
}

function candidate(root: string): LocalSourceCandidateReference {
  const bundleId = digest("c");
  const directory = path.join(root, "candidate", bundleId);
  return {
    bundleId,
    directory,
    manifestPath: path.join(directory, "manifest.json"),
    receiptPath: path.join(directory, "local-build-receipt.json"),
    classification: "mapping-only",
    affectedFactions: ["aeldari"],
  };
}

async function pipelineFixtureBuild(
  createdAt: string,
  bsDataCommit = LATEST_BSDATA_COMMIT,
): Promise<RuntimeDataBundleBuild> {
  const shard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "global",
    kind: "global",
    factionIds: [],
    data: { payloadKind: "test-global", sequence: 1 },
  };
  const descriptor: DataBundleManifestDraftV1["shards"][number] = {
    shardId: "global",
    kind: "global",
    factionIds: [],
    dependencyShardIds: [],
    path: "shards/global.json",
    contentSha256: await sha256Hex(canonicalJson(shard)),
    semanticHash: await semanticHash(shard.data),
    byteLength: new TextEncoder().encode(canonicalJson(shard)).byteLength,
    mediaType: "application/vnd.rosterpilot.data-shard+json",
  };
  return {
    draft: {
      schemaVersion: 1,
      engineDataSchemaVersion: 2,
      createdAt,
      provenance: {
        official: {
          authority: "games-workshop",
          version: "1.1",
          contentSha256: digest("b"),
          downloadsUrl:
            "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
          dataUrl: "https://mfm.warhammer-community.com/en",
          checkedAt: createdAt,
        },
        rules: {
          provider: "40kdc-data",
          package: "@alpaca-software/40kdc-data",
          version: "1.2.2",
          sourceSha256: digest("d"),
          edition: "11th",
          dataslate: "launch",
        },
        newRecruit: {
          provider: "bsdata",
          repository: "BSData/wh40k-11e",
          branch: "main",
          commit: bsDataCommit,
        },
      },
      semanticHashes: {
        globalHash: digest("e"),
        methodologyHash: digest("f"),
        factions: {},
      },
      shards: [descriptor],
    },
    shards: [shard] as RuntimeDataBundleBuild["shards"],
    officialReconciliation: null,
  };
}

async function treeInventory(
  root: string,
  relative = "",
): Promise<Array<{ path: string; sha256: string }>> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const inventory: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      inventory.push(...(await treeInventory(root, child)));
    } else if (entry.isFile()) {
      inventory.push({
        path: child.split(path.sep).join("/"),
        sha256: await sha256Hex(await readFile(path.join(root, child))),
      });
    }
  }
  return inventory;
}

async function createMinimalPipelineProject(root: string): Promise<void> {
  for (const directory of [
    "data/generated",
    "lib/rosterpilot",
    "local/data-bundles",
    "scripts",
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  const summary = {
    releaseId: "2026-07-31.1",
    summary: {
      factionCount: 0,
      exportCapableFactions: 0,
      completeFactions: 0,
      conflicts: 0,
      blockingConflicts: 0,
      uniqueConflicts: 0,
      uniqueBlockingConflicts: 0,
    },
    factions: {},
  };
  const files: Record<string, unknown> = {
    "package.json": { name: "fixture", private: true },
    "package-lock.json": { name: "fixture", lockfileVersion: 3 },
    "tsconfig.json": { compilerOptions: {} },
    "data/sources.json": {
      schemaVersion: 1,
      releaseId: "2026-07-31.1",
      rules: {
        package: "@alpaca-software/40kdc-data",
        version: "1.2.1",
        edition: "11th",
        dataslate: "launch",
      },
      newRecruit: {
        repository: "BSData/wh40k-11e",
        url: "https://github.com/BSData/wh40k-11e.git",
        branch: "main",
        commit: "419a80d35346cd9bf26d32f69b4a5df404beb95d",
      },
      official: {
        downloadsUrl:
          "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
        mfmUrl: "https://mfm.warhammer-community.com/en",
        mfmVersion: "1.1",
        updatedAt: "2026-07-22",
        contentSha256: digest("b"),
        checkedAt: "2026-07-31T12:00:00.000Z",
      },
    },
    "data/certification-manifest.json": { schemaVersion: 1, factions: [] },
    "data/generated/new-recruit-summary.json": summary,
  };
  for (const filename of [
    "scripts/build-local-source-candidate.ts",
    "scripts/sync-bsdata.ts",
    "scripts/check-roster-data.ts",
    "scripts/certify.ts",
    "scripts/sync-certification-manifest.ts",
    "local/data-bundles/local-source-candidate.ts",
    "lib/rosterpilot/fixture.ts",
  ]) {
    files[filename] = "fixture";
  }
  for (const [relativePath, value] of Object.entries(files)) {
    const filename = path.join(root, relativePath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(
      filename,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  }
}

test("local-source scheduling uses a daily interval and bounded retry backoff", () => {
  assert.equal(localSourceRetryDelayMs(1), LOCAL_SOURCE_INITIAL_RETRY_MS);
  assert.equal(localSourceRetryDelayMs(2), 2 * LOCAL_SOURCE_INITIAL_RETRY_MS);
  assert.equal(localSourceRetryDelayMs(3), 4 * LOCAL_SOURCE_INITIAL_RETRY_MS);
  assert.equal(localSourceRetryDelayMs(4), LOCAL_SOURCE_MAX_RETRY_MS);
  assert.equal(localSourceRetryDelayMs(20), LOCAL_SOURCE_MAX_RETRY_MS);

  const never = evaluateLocalSourceUpdateDue(
    {
      activeJobId: null,
      lastAttemptAt: null,
      nextAutomaticAttemptAt: null,
      consecutiveFailures: 0,
    },
    new Date("2026-08-02T12:00:00.000Z"),
  );
  assert.deepEqual(never, {
    due: true,
    reason: "never-checked",
    nextAutomaticAttemptAt: null,
  });
  const notDue = evaluateLocalSourceUpdateDue(
    {
      activeJobId: null,
      lastAttemptAt: "2026-08-02T12:00:00.000Z",
      nextAutomaticAttemptAt: null,
      consecutiveFailures: 0,
    },
    new Date(
      new Date("2026-08-02T12:00:00.000Z").getTime() +
        LOCAL_SOURCE_CHECK_INTERVAL_MS -
        1,
    ),
  );
  assert.equal(notDue.due, false);
  assert.equal(notDue.reason, "not-due");
  const forced = evaluateLocalSourceUpdateDue(
    {
      activeJobId: null,
      lastAttemptAt: "2026-08-02T12:00:00.000Z",
      nextAutomaticAttemptAt: "2026-08-03T12:00:00.000Z",
      consecutiveFailures: 0,
    },
    new Date("2026-08-02T12:01:00.000Z"),
    true,
  );
  assert.equal(forced.due, true);
  assert.equal(forced.reason, "forced");
});

test("coordinator keeps one queued job, records every stage, and activates through a separate consumer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-coordinator-"));
  let clock = new Date("2026-08-02T12:00:00.000Z");
  const stages: string[] = [];
  const consumerForces: boolean[] = [];
  const fixtureCandidate = candidate(root);
  const pipeline: LocalSourceUpdatePipeline = {
    async run(input) {
      for (const status of [
        "checking",
        "fetching",
        "building",
        "certifying",
      ] as const) {
        stages.push(status);
        await input.onProgress(status, `Entered ${status}.`);
      }
      return {
        kind: "candidate",
        observation: observation(clock.toISOString()),
        officialReconciliation: "pending",
        candidate: fixtureCandidate,
        evidence: [],
      };
    },
  };
  try {
    const coordinator = createLocalSourceUpdateCoordinator({
      rootDirectory: root,
      projectRoot: process.cwd(),
      pipeline,
      now: () => new Date(clock),
      consumeCandidate: async (selected, context) => {
        assert.equal(selected.bundleId, fixtureCandidate.bundleId);
        consumerForces.push(context.force);
        return { installed: true, activated: true };
      },
    });
    const [first, second] = await Promise.all([
      coordinator.enqueue({ trigger: "startup" }),
      coordinator.enqueue({ trigger: "startup" }),
    ]);
    assert.ok(first.job || second.job);
    const jobIds = [first.job?.jobId, second.job?.jobId].filter(Boolean);
    assert.equal(new Set(jobIds).size, 1);
    assert.equal([first.queued, second.queued].filter(Boolean).length, 1);

    const completed = await coordinator.runNext();
    assert.equal(completed?.status, "activated");
    assert.deepEqual(stages, ["checking", "fetching", "building", "certifying"]);
    const status = await coordinator.getStatus();
    assert.equal(status.state.activeJobId, null);
    assert.equal(status.state.latestCandidate?.bundleId, fixtureCandidate.bundleId);
    assert.equal(status.state.consecutiveFailures, 0);
    assert.equal(status.state.latestObservation?.official.disposition, "update-pending");
    assert.equal(status.due.due, false);
    const reliabilityRoot = path.join(root, "reliability");
    const history = await createWorkflowReliabilityEventStore({
      rootDirectory: reliabilityRoot,
    }).history({
      workflowId: completed!.jobId,
      workflowKind: "local-data-update",
    });
    assert.equal(history.verification.ok, true);
    assert.equal(history.events[0]?.stage, "queued");
    assert.equal(history.events.at(-1)?.stage, "activated");
    assert.equal(history.events.at(-1)?.outcome, "succeeded");
    assert.deepEqual(
      await resolveWorkflowReliabilityIdentity(
        { kind: "data-update-job-id", value: completed!.jobId },
        { rootDirectory: reliabilityRoot },
      ),
      {
        workflowId: completed!.jobId,
        workflowKind: "local-data-update",
      },
    );

    const skipped = await coordinator.enqueue({ trigger: "scheduled" });
    assert.equal(skipped.queued, false);
    clock = new Date(clock.getTime() + 1_000);
    const forced = await coordinator.enqueue({
      trigger: "manual",
      force: true,
    });
    assert.equal(forced.queued, true);
    const candidatesRoot = path.join(root, "v1", "candidates");
    const expired = path.join(candidatesRoot, "expired");
    const recent = path.join(candidatesRoot, "recent");
    await mkdir(expired, { recursive: true });
    await mkdir(recent, { recursive: true });
    await utimes(
      expired,
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z"),
    );
    await coordinator.runNext();
    await assert.rejects(lstat(expired), (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT",
      ),
    );
    assert.equal((await lstat(recent)).isDirectory(), true);
    assert.deepEqual(consumerForces, [false, true]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local updates complete and retain a warning when journal append fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-journal-warning-"));
  const reliabilityRoot = path.join(root, "reliability");
  const failingStore = createWorkflowReliabilityEventStore({
    rootDirectory: reliabilityRoot,
    dependencies: {
      onEventPersisted: () => {
        throw new Error("simulated updater journal interruption");
      },
    },
  });
  const pipeline: LocalSourceUpdatePipeline = {
    async run() {
      return {
        kind: "current",
        observation: observation("2026-08-02T12:00:00.000Z"),
        officialReconciliation: "verified",
        candidate: null,
        evidence: [],
      };
    },
  };
  try {
    const coordinator = createLocalSourceUpdateCoordinator({
      rootDirectory: root,
      projectRoot: process.cwd(),
      pipeline,
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      reliability: {
        store: failingStore,
        rootDirectory: reliabilityRoot,
      },
    });
    const queued = await coordinator.enqueue({
      trigger: "manual",
      force: true,
    });
    assert.equal(queued.job?.status, "queued");
    assert.equal(
      queued.job?.reliabilityWarnings?.[0]?.code,
      "RELIABILITY_ADAPTER_FAILED",
    );

    const completed = await coordinator.runJob(queued.job!.jobId);
    assert.equal(completed.status, "activated");
    assert.ok((completed.reliabilityWarnings?.length ?? 0) >= 1);
    const retained = await coordinator.getJob(completed.jobId);
    assert.equal(retained.status, "activated");
    assert.deepEqual(retained.reliabilityWarnings, completed.reliabilityWarnings);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility jobs persist an exact historical commit and install without changing global update state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-compatibility-"));
  const clock = new Date("2026-08-02T12:00:00.000Z");
  const fixtureCandidate = candidate(root);
  let observedOverride: string | null = null;
  let consumerContext:
    | {
        trigger: string;
        activate: boolean;
        bsDataCommitOverride: string | null;
      }
    | undefined;
  const pipeline: LocalSourceUpdatePipeline = {
    async run(input) {
      observedOverride = input.bsDataCommitOverride;
      return {
        kind: "candidate",
        observation: {
          ...observation(clock.toISOString()),
          newRecruit: {
            ...observation(clock.toISOString()).newRecruit,
            commit: HISTORICAL_BSDATA_COMMIT,
          },
        },
        officialReconciliation: "pending",
        candidate: fixtureCandidate,
        evidence: [],
      };
    },
  };
  try {
    const coordinator = createLocalSourceUpdateCoordinator({
      rootDirectory: root,
      projectRoot: process.cwd(),
      pipeline,
      now: () => new Date(clock),
      consumeCandidate: async (_selected, context) => {
        consumerContext = context;
        return { installed: true, activated: false };
      },
    });
    const initialState = await coordinator.getState();
    const queued = await coordinator.enqueue({
      trigger: "compatibility",
      force: true,
      bsDataCommitOverride: HISTORICAL_BSDATA_COMMIT,
    });
    assert.equal(queued.job?.bsDataCommitOverride, HISTORICAL_BSDATA_COMMIT);
    const completed = await coordinator.runJob(queued.job!.jobId);
    assert.equal(completed.status, "installed");
    assert.equal(observedOverride, HISTORICAL_BSDATA_COMMIT);
    assert.deepEqual(consumerContext, {
      jobId: queued.job!.jobId,
      trigger: "compatibility",
      activate: false,
      force: true,
      bsDataCommitOverride: HISTORICAL_BSDATA_COMMIT,
    });
    const finalState = await coordinator.getState();
    assert.equal(finalState.latestCandidate, initialState.latestCandidate);
    assert.equal(finalState.latestObservation, initialState.latestObservation);
    assert.equal(finalState.lastAttemptAt, initialState.lastAttemptAt);
    assert.equal(
      finalState.nextAutomaticAttemptAt,
      initialState.nextAutomaticAttemptAt,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retryable update failures back off without replacing the active candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-retry-"));
  let clock = new Date("2026-08-02T12:00:00.000Z");
  const pipeline: LocalSourceUpdatePipeline = {
    async run(input) {
      await input.onProgress("fetching", "Fetching failed.");
      throw new LocalSourcePipelineError(
        "LOCAL_SOURCE_NETWORK_FAILED",
        "The upstream source is temporarily unavailable.",
        {
          retryable: true,
          observation: observation(clock.toISOString()),
        },
      );
    },
  };
  try {
    const coordinator = createLocalSourceUpdateCoordinator({
      rootDirectory: root,
      projectRoot: process.cwd(),
      pipeline,
      now: () => new Date(clock),
    });
    const first = await coordinator.enqueue({ trigger: "startup" });
    const failed = await coordinator.runJob(first.job!.jobId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.retryable, true);
    assert.equal(
      failed.retryAt,
      new Date(clock.getTime() + LOCAL_SOURCE_INITIAL_RETRY_MS).toISOString(),
    );
    let state = await coordinator.getState();
    assert.equal(state.consecutiveFailures, 1);
    assert.equal(state.latestCandidate, null);

    clock = new Date(failed.retryAt!);
    const second = await coordinator.enqueue({ trigger: "scheduled" });
    assert.equal(second.queued, true);
    const secondFailure = await coordinator.runJob(second.job!.jobId);
    assert.equal(
      secondFailure.retryAt,
      new Date(clock.getTime() + 2 * LOCAL_SOURCE_INITIAL_RETRY_MS).toISOString(),
    );
    state = await coordinator.getState();
    assert.equal(state.consecutiveFailures, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation failures quarantine the candidate scope and preserve automatic recovery state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-quarantine-"));
  const clock = new Date("2026-08-02T12:00:00.000Z");
  const pipeline: LocalSourceUpdatePipeline = {
    async run(input) {
      await input.onProgress("certifying", "Certification failed.");
      throw new LocalSourcePipelineError(
        "LOCAL_SOURCE_CERTIFICATION_FAILED",
        "Aeldari export smoke failed.",
        {
          quarantinedScopes: ["faction:aeldari:certification"],
          observation: observation(clock.toISOString()),
        },
      );
    },
  };
  try {
    const coordinator = createLocalSourceUpdateCoordinator({
      rootDirectory: root,
      projectRoot: process.cwd(),
      pipeline,
      now: () => new Date(clock),
    });
    const queued = await coordinator.enqueue({ trigger: "startup" });
    const quarantined = await coordinator.runJob(queued.job!.jobId);
    assert.equal(quarantined.status, "quarantined");
    assert.deepEqual(quarantined.quarantinedScopes, [
      "faction:aeldari:certification",
    ]);
    assert.equal(quarantined.retryAt, null);
    const state = await coordinator.getState();
    assert.equal(state.latestCandidate, null);
    assert.equal(state.consecutiveFailures, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an installed stage without completion is recovered to the same queued job", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-crash-"));
  const clock = new Date("2026-08-02T12:00:00.000Z");
  const pipeline: LocalSourceUpdatePipeline = {
    async run() {
      throw new Error("not reached");
    },
  };
  try {
    const coordinator = createLocalSourceUpdateCoordinator({
      rootDirectory: root,
      projectRoot: process.cwd(),
      pipeline,
      now: () => new Date(clock),
      isProcessAlive: () => false,
    });
    const queued = await coordinator.enqueue({ trigger: "startup" });
    const jobId = queued.job!.jobId;
    const durableRoot = path.join(root, "v1");
    const jobPath = path.join(durableRoot, "jobs", jobId, "job.json");
    const job = JSON.parse(await readFile(jobPath, "utf8")) as Record<string, unknown>;
    delete job.integritySha256;
    job.status = "installed";
    job.revision = Number(job.revision) + 1;
    job.progress = "Interrupted build";
    job.integritySha256 = await sha256Hex(canonicalJson(job));
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);
    const workerLock = path.join(durableRoot, "worker.lock");
    await mkdir(workerLock, { recursive: true });
    await writeFile(
      path.join(workerLock, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 12345,
        token: "ad25f3f0-fd0b-4bea-b3b5-9f425b50e84e",
        acquiredAt: clock.toISOString(),
      })}\n`,
    );

    const recovered = await coordinator.recoverInterrupted();
    assert.equal(recovered?.jobId, jobId);
    assert.equal(recovered?.status, "queued");
    assert.equal(recovered?.recoveryCount, 1);
    assert.match(recovered?.progress ?? "", /Recovered an interrupted/);
    assert.equal((await coordinator.getState()).activeJobId, jobId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy sealed jobs without a BSData override recover after upgrade", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-legacy-job-"));
  const clock = new Date("2026-08-02T12:00:00.000Z");
  const pipeline: LocalSourceUpdatePipeline = {
    async run() {
      throw new Error("not reached");
    },
  };
  try {
    const coordinator = createLocalSourceUpdateCoordinator({
      rootDirectory: root,
      projectRoot: process.cwd(),
      pipeline,
      now: () => new Date(clock),
      isProcessAlive: () => false,
    });
    const queued = await coordinator.enqueue({ trigger: "startup" });
    const jobId = queued.job!.jobId;
    const durableRoot = path.join(root, "v1");
    const jobPath = path.join(durableRoot, "jobs", jobId, "job.json");
    const job = JSON.parse(
      await readFile(jobPath, "utf8"),
    ) as Record<string, unknown>;
    delete job.integritySha256;
    delete job.bsDataCommitOverride;
    job.status = "certifying";
    job.revision = Number(job.revision) + 1;
    job.progress = "Interrupted legacy certification";
    job.integritySha256 = await sha256Hex(canonicalJson(job));
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);
    const workerLock = path.join(durableRoot, "worker.lock");
    await mkdir(workerLock, { recursive: true });
    await writeFile(
      path.join(workerLock, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 12345,
        token: "7b13cc47-a2d4-40ea-866b-2572daea94d1",
        acquiredAt: clock.toISOString(),
      })}\n`,
    );

    const recovered = await coordinator.recoverInterrupted();
    assert.equal(recovered?.jobId, jobId);
    assert.equal(recovered?.status, "queued");
    assert.equal(recovered?.bsDataCommitOverride, null);
    assert.equal(recovered?.recoveryCount, 1);
    assert.equal((await coordinator.getJob(jobId))?.bsDataCommitOverride, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed terminal work is reconciled into durable coordinator state after a crash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-terminal-recovery-"));
  const clock = new Date("2026-08-02T12:00:00.000Z");
  const completedAt = "2026-08-02T12:30:00.000Z";
  const fixtureCandidate = candidate(root);
  const pipeline: LocalSourceUpdatePipeline = {
    async run() {
      throw new Error("not reached");
    },
  };
  try {
    const coordinator = createLocalSourceUpdateCoordinator({
      rootDirectory: root,
      projectRoot: process.cwd(),
      pipeline,
      now: () => new Date(clock),
    });
    const queued = await coordinator.enqueue({ trigger: "startup" });
    const jobPath = path.join(
      root,
      "v1",
      "jobs",
      queued.job!.jobId,
      "job.json",
    );
    const job = JSON.parse(
      await readFile(jobPath, "utf8"),
    ) as Record<string, unknown>;
    delete job.integritySha256;
    job.status = "activated";
    job.progress = "Activated before coordinator state reconciliation.";
    job.startedAt = clock.toISOString();
    job.completedAt = completedAt;
    job.candidate = fixtureCandidate;
    job.observation = observation(clock.toISOString());
    job.revision = Number(job.revision) + 1;
    job.integritySha256 = await sha256Hex(canonicalJson(job));
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);

    const recovered = await coordinator.recoverInterrupted();
    assert.equal(recovered?.status, "activated");
    const state = await coordinator.getState();
    assert.equal(state.activeJobId, null);
    assert.equal(state.latestCandidate?.bundleId, fixtureCandidate.bundleId);
    assert.equal(state.lastAttemptAt, clock.toISOString());
    assert.equal(state.lastSuccessAt, completedAt);
    assert.equal(
      state.nextAutomaticAttemptAt,
      new Date(
        new Date(completedAt).getTime() + LOCAL_SOURCE_CHECK_INTERVAL_MS,
      ).toISOString(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default pipeline stages allowlisted sources outside the checkout with a sanitized environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-isolated-"));
  const projectRoot = path.join(root, "project");
  const supportRoot = path.join(root, "support");
  const jobDirectory = path.join(root, "job");
  const checkedAt = "2026-08-02T12:00:00.000Z";
  await createMinimalPipelineProject(projectRoot);
  const before = await treeInventory(projectRoot);
  const seenEnvironments: NodeJS.ProcessEnv[] = [];
  const seenCommands: Array<{
    command: string;
    args: string[];
    timeoutMs: number;
  }> = [];
  let checkedOutCommit: string | undefined;
  const runner: BoundedCommandRunner = async (
    command,
    args,
    options,
  ) => {
    seenEnvironments.push(options.env);
    const values = [...args];
    seenCommands.push({
      command,
      args: values,
      timeoutMs: options.timeoutMs,
    });
    let output = Buffer.from("ok\n");
    if (command === "git" && values.includes("--mirror")) {
      await mkdir(values.at(-1)!, { recursive: true });
    } else if (
      command === "git" &&
      values.includes("clone") &&
      values.includes("--no-checkout")
    ) {
      await mkdir(values.at(-1)!, { recursive: true });
    } else if (command === "git" && values.includes("rev-parse")) {
      output = Buffer.from(`${LATEST_BSDATA_COMMIT}\n`);
    } else if (command === "git" && values[0] === "checkout") {
      checkedOutCommit = values.at(-1);
    } else if (command === "npm" && values[0] === "install") {
      const packageDirectory = path.join(
        options.cwd,
        "node_modules",
        "@alpaca-software",
        "40kdc-data",
      );
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        path.join(packageDirectory, "package.json"),
        `${JSON.stringify({
          name: "@alpaca-software/40kdc-data",
          version: "1.2.2",
        })}\n`,
      );
      await writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify({
          name: "fixture",
          lockfileVersion: 3,
          packages: {
            "node_modules/@alpaca-software/40kdc-data": {
              version: "1.2.2",
              resolved:
                "https://registry.npmjs.org/@alpaca-software/40kdc-data/-/40kdc-data-1.2.2.tgz",
              integrity: NPM_INTEGRITY,
            },
          },
        })}\n`,
      );
    } else if (
      command === process.execPath &&
      values.includes("scripts/sync-bsdata.ts")
    ) {
      const baseline = await readFile(
        path.join(projectRoot, "data", "generated", "new-recruit-summary.json"),
      );
      const generated = path.join(
        options.cwd,
        "data",
        "generated",
        "new-recruit-summary.json",
      );
      await mkdir(path.dirname(generated), { recursive: true });
      await writeFile(generated, baseline);
    } else if (
      command === process.execPath &&
      values.includes("scripts/build-local-source-candidate.ts")
    ) {
      const outIndex = values.indexOf("--out-dir");
      await writeLocalSourceBundleArtifacts(
        await pipelineFixtureBuild(checkedAt, HISTORICAL_BSDATA_COMMIT),
        values[outIndex + 1],
      );
    }
    return {
      command,
      args: values,
      exitCode: 0,
      output,
      durationMs: 1,
    };
  };
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org")) {
      return new Response(
        JSON.stringify({
          name: "@alpaca-software/40kdc-data",
          version: "1.2.2",
          dist: {
            integrity: NPM_INTEGRITY,
            tarball:
              "https://registry.npmjs.org/@alpaca-software/40kdc-data/-/40kdc-data-1.2.2.tgz",
          },
        }),
      );
    }
    if (url.includes("api.github.com")) {
      return new Response(
        JSON.stringify({
          sha: LATEST_BSDATA_COMMIT,
        }),
      );
    }
    if (url === "https://mfm.warhammer-community.com/en") {
      return new Response("<h2>v1.2</h2>");
    }
    if (
      url ===
      "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/"
    ) {
      return new Response("<h1>Warhammer 40,000 downloads</h1>");
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const pipeline = createDefaultLocalSourceUpdatePipeline({
      fetch: fetchImpl,
      runCommand: runner,
      now: () => new Date(checkedAt),
    });
    const stages: string[] = [];
    const result = await pipeline.run({
      jobId: "f2885fa0-1c30-4df3-af65-2c71a84b15dc",
      jobDirectory,
      projectRoot,
      supportRoot,
      latestCandidate: null,
      bsDataCommitOverride: HISTORICAL_BSDATA_COMMIT,
      onProgress: async (status) => {
        stages.push(status);
      },
    });
    assert.equal(result.kind, "candidate");
    assert.equal(result.officialReconciliation, "pending");
    assert.equal(result.observation.newRecruit.commit, HISTORICAL_BSDATA_COMMIT);
    assert.equal(result.observation.newRecruit.latestCommit, LATEST_BSDATA_COMMIT);
    assert.equal(checkedOutCommit, HISTORICAL_BSDATA_COMMIT);
    assert.deepEqual(stages, [
      "checking",
      "fetching",
      "building",
      "certifying",
      "certifying",
    ]);
    const certificationCommands = seenCommands.filter(
      ({ command, args }) =>
        command === "npm" &&
        args[0] === "run" &&
        args[1] === "certify",
    );
    assert.equal(
      certificationCommands.length,
      LOCAL_SOURCE_FULL_CERTIFICATION_SHARDS,
    );
    assert.deepEqual(
      certificationCommands
        .map(({ args }) => args[args.indexOf("--shard") + 1])
        .sort(),
      ["1/4", "2/4", "3/4", "4/4"],
    );
    assert.ok(
      certificationCommands.every(
        ({ args, timeoutMs }) =>
          args.includes("--portfolio") &&
          args[args.indexOf("--require-status") + 1] ===
            LOCAL_SOURCE_MINIMUM_CERTIFICATION_STATUS &&
          timeoutMs === LOCAL_SOURCE_CERTIFICATION_TIMEOUT_MS,
      ),
    );
    assert.equal(
      new Set(
        certificationCommands.map(
          ({ args }) => args[args.indexOf("--out-dir") + 1],
        ),
      ).size,
      LOCAL_SOURCE_FULL_CERTIFICATION_SHARDS,
    );
    assert.ok(result.candidate);
    const verified = await verifyLocalSourceCandidate(result.candidate!.directory, {
      expectedBuilderRoot: projectRoot,
    });
    assert.ok(
      verified.buildEvidence.builder.files.some(
        (entry) => entry.path === "package.json",
      ),
    );
    assert.ok(
      verified.buildEvidence.builder.files.some(
        (entry) => entry.path === "package-lock.json",
      ),
    );
    assert.deepEqual(await treeInventory(projectRoot), before);
    assert.ok(seenEnvironments.length > 0);
    for (const environment of seenEnvironments) {
      assert.equal(environment.NPM_TOKEN, undefined);
      assert.equal(
        environment.ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK,
        undefined,
      );
      assert.equal(environment.npm_config_ignore_scripts, "true");
      assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
    }
    await writeFile(
      path.join(projectRoot, "package.json"),
      `${JSON.stringify({ name: "tampered-builder" })}\n`,
    );
    await assert.rejects(
      verifyLocalSourceCandidate(result.candidate!.directory, {
        expectedBuilderRoot: projectRoot,
      }),
      /built by different source code than the expected checkout/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default pipeline rejects a 40kdc tarball outside the allowlisted registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-allowlist-"));
  const projectRoot = path.join(root, "project");
  await createMinimalPipelineProject(projectRoot);
  let commandCount = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org")) {
      return new Response(
        JSON.stringify({
          name: "@alpaca-software/40kdc-data",
          version: "1.2.2",
          dist: {
            integrity: NPM_INTEGRITY,
            tarball: "https://example.invalid/40kdc-data.tgz",
          },
        }),
      );
    }
    if (url.includes("api.github.com")) {
      return new Response(
        JSON.stringify({
          sha: LATEST_BSDATA_COMMIT,
        }),
      );
    }
    return new Response("<h2>v1.2</h2>");
  };
  try {
    const pipeline = createDefaultLocalSourceUpdatePipeline({
      fetch: fetchImpl,
      runCommand: async () => {
        commandCount += 1;
        throw new Error("must not run");
      },
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    await assert.rejects(
      pipeline.run({
        jobId: "25f4de44-397b-4ef6-a147-c6d85f197068",
        jobDirectory: path.join(root, "job"),
        projectRoot,
        supportRoot: path.join(root, "support"),
        latestCandidate: null,
        bsDataCommitOverride: null,
        onProgress: async () => {},
      }),
      (error: unknown) =>
        error instanceof LocalSourcePipelineError &&
        error.code === "LOCAL_SOURCE_UPDATE_FAILED" &&
        /outside the allowlisted npm registry/.test(error.message),
    );
    assert.equal(commandCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default pipeline rejects redirects outside each source allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-redirect-"));
  const projectRoot = path.join(root, "project");
  await createMinimalPipelineProject(projectRoot);
  let commandCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "manual");
    const url = String(input);
    if (url.includes("registry.npmjs.org")) {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://example.invalid/latest" },
      });
    }
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ sha: LATEST_BSDATA_COMMIT }));
    }
    return new Response("<h2>v1.2</h2>");
  };
  try {
    const pipeline = createDefaultLocalSourceUpdatePipeline({
      fetch: fetchImpl,
      runCommand: async () => {
        commandCount += 1;
        throw new Error("must not run");
      },
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    await assert.rejects(
      pipeline.run({
        jobId: "a6c55242-81ac-4c31-9943-fe8444220b43",
        jobDirectory: path.join(root, "job"),
        projectRoot,
        supportRoot: path.join(root, "support"),
        latestCandidate: null,
        bsDataCommitOverride: null,
        onProgress: async () => {},
      }),
      (error: unknown) =>
        error instanceof LocalSourcePipelineError &&
        error.code === "LOCAL_SOURCE_UPDATE_FAILED" &&
        /outside the allowlisted upstream hosts/.test(error.message),
    );
    assert.equal(commandCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BSData checkout validation rejects symbolic links before source reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-bsdata-link-"));
  try {
    await writeFile(path.join(root, "catalogue.json"), "{}\n");
    await symlink("catalogue.json", path.join(root, "linked-catalogue.json"));
    await assert.rejects(
      assertSafeBsDataCheckout(root),
      /unsupported symbolic link: linked-catalogue\.json/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "bounded commands kill descendant processes when the timeout expires",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-source-process-group-"));
    const marker = path.join(root, "descendant-survived");
    const descendant =
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 500);";
    const parent = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ${JSON.stringify(marker)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    try {
      await assert.rejects(
        runBoundedCommand(process.execPath, ["-e", parent], {
          cwd: root,
          env: { PATH: process.env.PATH, NODE_ENV: "test" },
          timeoutMs: 100,
          maxOutputBytes: 1_024,
        }),
        /exceeded its 100 ms time limit/,
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      await assert.rejects(lstat(marker), (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
