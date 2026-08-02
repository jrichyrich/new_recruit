import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRoster,
  type RuntimeProvenance,
  type TesseraMatchupReport,
  type TesseraProviderCompatibilityEnvelope,
} from "../lib/rosterpilot";
import {
  createExactReportReceipt,
  exactReportReceiptPath,
  verifyExactReportReceipt,
} from "../local/tessera/exact-report-integrity";
import {
  cancelTesseraRun,
  durableTesseraRuntimeAdmissionIssue,
  executeTesseraRunJob,
  getTesseraRunStatus,
  resolveTesseraRunProfiles,
  resumeTesseraRun,
  startTesseraRun,
  type TesseraRunJob,
  type TesseraRunRequest,
  type TesseraRunResult,
} from "../local/tessera/jobs";
import {
  providerCompatibilityEnvelopeSha256,
} from "../local/tessera/provider-compatibility";

type JobDocumentFixture = TesseraRunJob & {
  request: TesseraRunRequest;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  return sha256(JSON.stringify(canonicalValue(value)));
}

async function readJobDocument(
  filename: string,
): Promise<JobDocumentFixture> {
  return JSON.parse(
    await readFile(filename, "utf8"),
  ) as JobDocumentFixture;
}

async function writeJobDocument(
  filename: string,
  value: JobDocumentFixture,
): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function refreshRequestProvenance(
  document: JobDocumentFixture,
): void {
  document.requestSha256 = canonicalSha256(document.request);
  const currentAttempt = document.attemptHistory.find(
    (entry) => entry.attempt === document.attempt,
  );
  assert.ok(currentAttempt);
  currentAttempt.requestSha256 = document.requestSha256;
}

async function executeMockedAttempt(
  jobPath: string,
  result: TesseraRunResult,
  options: {
    automaticRetry?: boolean;
    scheduleAutomaticRetry?: (
      jobPath: string,
    ) => Promise<void>;
    inspectRequest?: (
      request: TesseraRunRequest,
    ) => void | Promise<void>;
  } = {},
): Promise<void> {
  const document = await readJobDocument(jobPath);
  const workerToken = `mocked-attempt-${document.attempt}`;
  const workerTokenSha256 = sha256(workerToken);
  document.workerPid = process.pid;
  document.workerTokenSha256 = workerTokenSha256;
  await writeJobDocument(jobPath, document);
  await writeFile(
    path.join(document.jobDirectory, "worker.lock"),
    `${JSON.stringify({
      runId: document.runId,
      attempt: document.attempt,
      jobPath,
      tokenSha256: workerTokenSha256,
      pid: process.pid,
      processStartedAt: null,
      reservedAt: new Date().toISOString(),
    })}\n`,
  );
  await executeTesseraRunJob(jobPath, workerToken, {
    executeRequest: async (request) => {
      await options.inspectRequest?.(request);
      return result;
    },
    automaticRetry: options.automaticRetry ?? false,
    scheduleAutomaticRetry:
      options.scheduleAutomaticRetry,
  });
}

function hasErrorCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === expected,
    );
}

test("durable Tessera runtime admission rejects stale or mismatched launchers", () => {
  const runtime: RuntimeProvenance = {
    rosterPilotVersion: "fixture",
    rulesPackageVersion: "fixture",
    stressGeneratorVersion: "fixture",
    processStartedAt: "2026-07-31T00:00:00.000Z",
    gitHead: "fixture",
    sourceFingerprintAtStart: "source",
    sourceFingerprintNow: "source",
    buildId: "build",
    stale: false,
    localAgentObservedStatus: {
      available: true,
      version: "fixture",
      protocolVersion: 10,
      protocolCompatible: true,
      projectDirectory: "/fixture",
      nodeExecutable: "/fixture/node",
      browserAvailable: true,
      brokerAvailable: true,
      runtimeBuildId: "build",
      runtimeSourceFingerprint: "source",
      statusErrorCode: null,
    },
  };
  assert.equal(durableTesseraRuntimeAdmissionIssue(runtime), null);
  assert.equal(
    durableTesseraRuntimeAdmissionIssue({
      ...runtime,
      stale: true,
    })?.code,
    "RUNTIME_RESTART_REQUIRED",
  );
  assert.equal(
    durableTesseraRuntimeAdmissionIssue({
      ...runtime,
      localAgentObservedStatus: {
        ...runtime.localAgentObservedStatus!,
        runtimeBuildId: "different-build",
      },
    })?.code,
    "RUNTIME_RESTART_REQUIRED",
  );
  assert.equal(
    durableTesseraRuntimeAdmissionIssue({
      ...runtime,
      localAgentObservedStatus: {
        ...runtime.localAgentObservedStatus!,
        available: false,
      },
    }),
    null,
  );
});

test("durable Tessera jobs reserve isolated bundles and retain guided recovery state", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Durable job fixture",
  });
  assert.ok(built.ok && built.data);

  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        suite: "core-3",
        executionMode: "prepare-only",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  assert.equal(job.status, "queued");
  assert.match(job.runId, /^[0-9a-f-]{36}$/);
  assert.ok(job.manifestPath?.endsWith("stress-manifest.json"));
  assert.match(job.requestSha256, /^[0-9a-f]{64}$/);
  assert.match(job.dataPinSha256, /^[0-9a-f]{64}$/);
  assert.equal(job.dataPins[0]?.role, "player");
  assert.match(job.runtimeIdentitySha256, /^[0-9a-f]{64}$/);
  assert.equal(job.simulationStage, 1);
  assert.equal(job.retryBudget.automaticAttemptLimit, 3);
  assert.equal(job.retryBudget.lifetimeAttemptLimit, 5);
  assert.equal(job.retryBudget.automaticAttemptsRemaining, 2);
  assert.equal(job.retryBudget.lifetimeAttemptsRemaining, 4);
  assert.equal(job.attemptHistory[0]?.trigger, "start");

  const initial = await getTesseraRunStatus(job.requestPath);
  assert.equal(initial.job.runId, job.runId);
  assert.equal(initial.result, null);

  const cancelled = await cancelTesseraRun(job.requestPath);
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.nextAction ?? "", /never deletes/i);

  await assert.rejects(
    resolveTesseraRunProfiles(job.requestPath, {
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: [],
    }),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "TESSERA_PROFILE_RESOLUTION_NOT_REQUIRED",
  );

  const resumed = await resumeTesseraRun(job.requestPath, {
    launch: false,
  });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.profilePolicyPath, null);
  const resumedDocument = await readJobDocument(job.requestPath);
  assert.equal(resumedDocument.request.kind, "stress");
  if (resumedDocument.request.kind !== "stress") {
    throw new Error("Expected a resumed stress request.");
  }
  assert.equal(
    resumedDocument.request.options?.resumeManifestPath,
    undefined,
  );
  await executeMockedAttempt(
    job.requestPath,
    {
      ok: true,
      data: null,
      violations: [],
      warnings: [],
    },
    {
      inspectRequest: (request) => {
        assert.equal(request.kind, "stress");
        if (request.kind !== "stress") {
          throw new Error("Expected an executed stress request.");
        }
        assert.equal(
          request.options?.resumeManifestPath,
          undefined,
        );
        assert.equal(request.options?.profilePolicyPath, undefined);
      },
    },
  );
  assert.equal(
    (await getTesseraRunStatus(job.requestPath)).job.status,
    "complete",
  );
});

test("durable Tessera resume rejects an unreceipted workflow manifest", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-unreceipted-manifest-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Unreceipted manifest fixture",
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        suite: "core-3",
        executionMode: "prepare-only",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  await cancelTesseraRun(job.requestPath);
  assert.ok(job.manifestPath);
  await mkdir(path.dirname(job.manifestPath!), { recursive: true });
  await writeFile(
    job.manifestPath!,
    `${JSON.stringify({
      schemaVersion: 3,
      manifestKind: "tessera-stress-run",
    })}\n`,
  );
  await assert.rejects(
    resumeTesseraRun(job.requestPath, { launch: false }),
    (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "TESSERA_RUN_MANIFEST_DRIFT",
      ),
  );
});

test("fresh stress jobs bind one frozen portfolio through execution and recovery", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-frozen-portfolio-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Frozen portfolio player",
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        suite: "diverse-9",
        analysisStrategy: "staged",
        executionMode: "prepare-only",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const initial = await readJobDocument(job.requestPath);
  assert.equal(initial.request.kind, "stress");
  if (initial.request.kind !== "stress") {
    throw new Error("Expected a frozen stress request.");
  }
  const frozenPreview =
    initial.request.options?.portfolioPreview;
  assert.ok(frozenPreview);
  assert.equal(
    frozenPreview.portfolio.factionId,
    "aeldari",
  );
  assert.equal(frozenPreview.portfolio.suite, "diverse-9");
  assert.equal(frozenPreview.gates.accepted, true);
  const frozenPreviewSha256 = canonicalSha256(frozenPreview);
  assert.equal(
    initial.requestSha256,
    canonicalSha256(initial.request),
  );
  const requestWithoutPreview = structuredClone(initial.request);
  if (requestWithoutPreview.kind !== "stress") {
    throw new Error("Expected a stress request clone.");
  }
  delete requestWithoutPreview.options?.portfolioPreview;
  assert.notEqual(
    initial.requestSha256,
    canonicalSha256(requestWithoutPreview),
  );
  assert.equal(
    initial.dataPins.find((receipt) => receipt.role === "portfolio")
      ?.sha256,
    canonicalSha256(frozenPreview.portfolio.sourceData),
  );

  let executedPreviewSha256: string | null = null;
  await executeMockedAttempt(
    job.requestPath,
    {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_TEST_STOPPED",
          message: "Synthetic stop after request inspection.",
          severity: "error",
        },
      ],
      warnings: [],
    },
    {
      inspectRequest: (request) => {
        assert.equal(request.kind, "stress");
        if (request.kind !== "stress") {
          throw new Error("Expected a stress worker request.");
        }
        assert.deepEqual(
          request.options?.portfolioPreview,
          frozenPreview,
        );
        executedPreviewSha256 = canonicalSha256(
          request.options?.portfolioPreview,
        );
      },
    },
  );
  assert.equal(executedPreviewSha256, frozenPreviewSha256);

  const restarted = await resumeTesseraRun(job.requestPath, {
    restartFrom: true,
    outputDirectory: path.join(root, "restarted-runs"),
    rootDir: root,
    launch: false,
  });
  const restartedDocument = await readJobDocument(
    restarted.requestPath,
  );
  assert.equal(restartedDocument.request.kind, "stress");
  if (restartedDocument.request.kind !== "stress") {
    throw new Error("Expected a restarted stress request.");
  }
  assert.equal(
    canonicalSha256(
      restartedDocument.request.options?.portfolioPreview,
    ),
    frozenPreviewSha256,
  );

  const resumed = await resumeTesseraRun(job.requestPath, {
    launch: false,
  });
  assert.equal(resumed.attempt, 2);
  const resumedDocument = await readJobDocument(job.requestPath);
  assert.equal(resumedDocument.request.kind, "stress");
  if (resumedDocument.request.kind !== "stress") {
    throw new Error("Expected a resumed stress request.");
  }
  assert.equal(
    canonicalSha256(
      resumedDocument.request.options?.portfolioPreview,
    ),
    frozenPreviewSha256,
  );
});

test("manifest recovery requests bypass fresh portfolio generation", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-recovery-preview-"),
  );
  const recoveryRoot = path.join(root, "recovery");
  await mkdir(recoveryRoot);
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);

  for (const recoveryKind of [
    "resumeManifestPath",
    "restartManifestPath",
  ] as const) {
    await assert.rejects(
      startTesseraRun(
        {
          kind: "stress",
          playerRoster: built.data,
          factionId: "not-a-real-faction",
          options: {
            [recoveryKind]: path.join(
              recoveryRoot,
              `${recoveryKind}.json`,
            ),
          },
        },
        {
          outputDirectory: path.join(root, `${recoveryKind}-runs`),
          rootDir: root,
          launch: false,
        },
      ),
      hasErrorCode("ENOENT"),
    );
  }
});

test("durable Tessera jobs reject output paths outside their root", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-root-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);

  await assert.rejects(
    startTesseraRun(
      {
        kind: "exact",
        playerRoster: built.data,
        opponent: { kind: "roster", roster: built.data },
      },
      {
        outputDirectory: path.join(
          os.tmpdir(),
          "outside-rosterpilot-job-root",
        ),
        rootDir: root,
        launch: false,
      },
    ),
    /outside the allowed write root/i,
  );
});

test("resume inherits the existing job output and write policy", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-resume-policy-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        suite: "diverse-9",
        analysisStrategy: "staged",
        executionMode: "prepare-only",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  await cancelTesseraRun(job.requestPath);

  await assert.rejects(
    resumeTesseraRun(job.requestPath, {
      outputDirectory: path.join(root, "different-runs"),
      launch: false,
    }),
    hasErrorCode("TESSERA_RUN_RESUME_CONFLICT"),
  );
  await assert.rejects(
    resumeTesseraRun(job.requestPath, {
      allowOutsideRoot: true,
      launch: false,
    }),
    hasErrorCode("TESSERA_RUN_RESUME_CONFLICT"),
  );
  const unchanged = await getTesseraRunStatus(job.requestPath);
  assert.equal(unchanged.job.status, "cancelled");
  assert.equal(unchanged.job.attempt, 1);

  const resumed = await resumeTesseraRun(job.requestPath, {
    launch: false,
  });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.attempt, 2);
  const document = await readJobDocument(job.requestPath);
  assert.equal(document.request.kind, "stress");
  if (document.request.kind !== "stress") {
    throw new Error("Expected a resumed stress fixture.");
  }
  assert.equal(document.request.options?.suite, "diverse-9");
  assert.equal(
    document.request.options?.analysisStrategy,
    "staged",
  );
});

test("stress resume converts frozen restart recovery into one resume policy", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-recovery-policy-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        suite: "diverse-9",
        analysisStrategy: "staged",
        executionMode: "prepare-only",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  await cancelTesseraRun(job.requestPath);
  const cancelled = await readJobDocument(job.requestPath);
  assert.equal(cancelled.request.kind, "stress");
  assert.ok(cancelled.manifestPath);
  if (cancelled.request.kind !== "stress" || !cancelled.manifestPath) {
    throw new Error("Expected a stress recovery fixture.");
  }
  await mkdir(path.dirname(cancelled.manifestPath), {
    recursive: true,
  });
  const manifestContent = `${JSON.stringify({
      schemaVersion: 3,
      manifestKind: "tessera-stress-run",
    })}\n`;
  await writeFile(cancelled.manifestPath, manifestContent);
  cancelled.artifactReceipts.push({
    kind: "workflow-manifest",
    attempt: cancelled.attempt,
    path: path.relative(
      cancelled.jobDirectory,
      cancelled.manifestPath,
    ),
    sha256: sha256(manifestContent),
  });
  cancelled.request.options = {
    ...cancelled.request.options,
    restartManifestPath: cancelled.manifestPath,
  };
  delete cancelled.request.options.resumeManifestPath;
  refreshRequestProvenance(cancelled);
  await writeJobDocument(job.requestPath, cancelled);

  await resumeTesseraRun(job.requestPath, { launch: false });
  const resumed = await readJobDocument(job.requestPath);
  assert.equal(resumed.request.kind, "stress");
  if (resumed.request.kind !== "stress") {
    throw new Error("Expected a resumed stress recovery fixture.");
  }
  assert.equal(
    resumed.request.options?.resumeManifestPath,
    cancelled.manifestPath,
  );
  assert.equal(
    resumed.artifactReceipts.some(
      (receipt) => receipt.kind === "workflow-manifest",
    ),
    true,
  );
  assert.equal(
    "restartManifestPath" in (resumed.request.options ?? {}),
    false,
  );
  assert.equal(resumed.request.options?.suite, "diverse-9");
  assert.equal(
    resumed.request.options?.analysisStrategy,
    "staged",
  );
});

test("build-and-stress resume removes restart recovery from both request layers", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-build-stress-recovery-policy-"),
  );
  const job = await startTesseraRun(
    {
      kind: "build-and-stress",
      input: {
        prompt: "Build a durable 1,000 point Custodes roster",
        playerFaction: "adeptus-custodes",
        againstFaction: "aeldari",
        pointsLimit: 1000,
        suite: "diverse-9",
        analysisStrategy: "staged",
        executionMode: "prepare-only",
      },
      options: {
        suite: "diverse-9",
        analysisStrategy: "staged",
        executionMode: "prepare-only",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  await cancelTesseraRun(job.requestPath);
  const cancelled = await readJobDocument(job.requestPath);
  assert.equal(cancelled.request.kind, "build-and-stress");
  assert.ok(cancelled.manifestPath);
  if (
    cancelled.request.kind !== "build-and-stress" ||
    !cancelled.manifestPath
  ) {
    throw new Error("Expected a build-and-stress recovery fixture.");
  }
  await mkdir(path.dirname(cancelled.manifestPath), {
    recursive: true,
  });
  const manifestContent = `${JSON.stringify({
      schemaVersion: 3,
      manifestKind: "tessera-stress-run",
    })}\n`;
  await writeFile(cancelled.manifestPath, manifestContent);
  cancelled.artifactReceipts.push({
    kind: "workflow-manifest",
    attempt: cancelled.attempt,
    path: path.relative(
      cancelled.jobDirectory,
      cancelled.manifestPath,
    ),
    sha256: sha256(manifestContent),
  });
  cancelled.request.input.restartManifestPath =
    cancelled.manifestPath;
  delete cancelled.request.input.resumeManifestPath;
  cancelled.request.options = {
    ...cancelled.request.options,
    restartManifestPath: cancelled.manifestPath,
  };
  delete cancelled.request.options.resumeManifestPath;
  refreshRequestProvenance(cancelled);
  await writeJobDocument(job.requestPath, cancelled);

  await resumeTesseraRun(job.requestPath, { launch: false });
  const resumed = await readJobDocument(job.requestPath);
  assert.equal(resumed.request.kind, "build-and-stress");
  if (resumed.request.kind !== "build-and-stress") {
    throw new Error(
      "Expected a resumed build-and-stress recovery fixture.",
    );
  }
  assert.equal(
    resumed.request.input.resumeManifestPath,
    cancelled.manifestPath,
  );
  assert.equal(
    resumed.request.options?.resumeManifestPath,
    cancelled.manifestPath,
  );
  assert.equal(
    "restartManifestPath" in resumed.request.input,
    false,
  );
  assert.equal(
    "restartManifestPath" in (resumed.request.options ?? {}),
    false,
  );
  assert.equal(resumed.request.input.suite, "diverse-9");
  assert.equal(resumed.request.input.analysisStrategy, "staged");
});

test("durable Tessera jobs reject symlink escapes before and after start", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-symlink-"),
  );
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-outside-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const redirect = path.join(root, "redirect");
  await symlink(outside, redirect, "dir");
  await assert.rejects(
    startTesseraRun(
      {
        kind: "exact",
        playerRoster: built.data,
        opponent: { kind: "roster", roster: built.data },
      },
      {
        outputDirectory: path.join(redirect, "runs"),
        rootDir: root,
        launch: false,
      },
    ),
    hasErrorCode("TESSERA_OUTPUT_OUTSIDE_ROOT"),
  );

  const job = await startTesseraRun(
    {
      kind: "exact",
      playerRoster: built.data,
      opponent: { kind: "roster", roster: built.data },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  await symlink(outside, path.join(job.jobDirectory, "artifacts"), "dir");
  await assert.rejects(
    getTesseraRunStatus(job.requestPath),
    hasErrorCode("TESSERA_JOB_PATH_INVALID"),
  );
});

test("durable Tessera jobs freeze ROSZ and profile-policy bytes before returning", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-inputs-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const sourceRosz = path.join(root, "opponent.rosz");
  const sourcePolicy = path.join(root, "profile-policy.json");
  const originalRosz = "frozen ROSZ fixture";
  const originalPolicy = `${JSON.stringify({
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: [],
  })}\n`;
  await writeFile(sourceRosz, originalRosz);
  await writeFile(sourcePolicy, originalPolicy);

  const unsafeRequest: TesseraRunRequest = {
    kind: "exact",
    playerRoster: built.data,
    opponent: { kind: "rosz", path: sourceRosz },
    options: {
      executionMode: "prepare-only",
      profilePolicyPath: sourcePolicy,
      verifiedUploadedArtifactCapability: {},
    },
  };
  (
    unsafeRequest.options as unknown as
      Record<string, unknown>
  ).uploadedArtifactProvenanceVerified = true;
  const job = await startTesseraRun(
    unsafeRequest,
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const document = await readJobDocument(job.requestPath);
  assert.equal(document.request.kind, "exact");
  if (document.request.kind !== "exact") {
    throw new Error("Expected an exact job fixture.");
  }
  if (document.request.opponent.kind !== "rosz") {
    throw new Error("Expected a frozen ROSZ opponent.");
  }
  assert.equal(
    "verifiedUploadedArtifactCapability" in
      (document.request.options ?? {}),
    false,
  );
  assert.equal(
    "uploadedArtifactProvenanceVerified" in
      (document.request.options ?? {}),
    false,
  );
  const frozenRosz = document.request.opponent.path;
  const frozenPolicy =
    document.request.options?.profilePolicyPath;
  assert.ok(frozenPolicy);
  assert.ok(frozenRosz.startsWith(path.join(job.jobDirectory, "inputs")));
  assert.ok(
    frozenPolicy.startsWith(path.join(job.jobDirectory, "inputs")),
  );
  assert.equal(document.inputArtifacts.length, 2);
  assert.equal(await readFile(frozenRosz, "utf8"), originalRosz);
  assert.equal(await readFile(frozenPolicy, "utf8"), originalPolicy);

  await writeFile(sourceRosz, "changed after start");
  await writeFile(
    sourcePolicy,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: [
        {
          faction: "A",
          unit: "B",
          weaponGroup: "C",
          phase: "shooting",
          selectedProfile: "D",
          activeCount: 1,
        },
      ],
    })}\n`,
  );
  const unchanged = await getTesseraRunStatus(job.requestPath);
  assert.equal(unchanged.job.runId, job.runId);
  assert.equal(await readFile(frozenRosz, "utf8"), originalRosz);

  await cancelTesseraRun(job.requestPath);
  const restarted = await resumeTesseraRun(job.requestPath, {
    restartFrom: true,
    launch: false,
  });
  const restartedDocument = await readJobDocument(
    restarted.requestPath,
  );
  assert.equal(restartedDocument.request.kind, "exact");
  if (restartedDocument.request.kind !== "exact") {
    throw new Error("Expected an exact restarted job fixture.");
  }
  assert.equal(
    restartedDocument.request.opponent.kind,
    "rosz",
  );
  if (restartedDocument.request.opponent.kind !== "rosz") {
    throw new Error("Expected a restarted ROSZ opponent.");
  }
  assert.equal(
    "verifiedUploadedArtifactCapability" in
      (restartedDocument.request.options ?? {}),
    false,
  );
  assert.equal(
    "uploadedArtifactProvenanceVerified" in
      (restartedDocument.request.options ?? {}),
    false,
  );
  assert.notEqual(
    restartedDocument.request.opponent.path,
    frozenRosz,
  );
  assert.equal(
    await readFile(
      restartedDocument.request.opponent.path,
      "utf8",
    ),
    originalRosz,
  );
  assert.equal(restarted.inputArtifacts.length, 2);
  assert.equal(restarted.simulationStage, 2);

  await writeFile(frozenRosz, "tampered frozen input");
  await assert.rejects(
    getTesseraRunStatus(job.requestPath),
    hasErrorCode("TESSERA_INPUT_ARTIFACT_CHANGED"),
  );
  await assert.rejects(
    resumeTesseraRun(job.requestPath, {
      restartFrom: true,
      launch: false,
    }),
    hasErrorCode("TESSERA_INPUT_ARTIFACT_CHANGED"),
  );
});

test("stress jobs freeze relative profile policies from the declared write root", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-relative-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const policyDirectory = path.join(root, "policies");
  const relativePolicy = path.join(
    "policies",
    "profile-policy.json",
  );
  await mkdir(policyDirectory);
  await writeFile(
    path.join(root, relativePolicy),
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: [],
    })}\n`,
  );

  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        rootDir: root,
        profilePolicyPath: relativePolicy,
        executionMode: "prepare-only",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const document = await readJobDocument(job.requestPath);
  assert.equal(document.request.kind, "stress");
  if (document.request.kind !== "stress") {
    throw new Error("Expected a stress job fixture.");
  }
  assert.ok(
    document.request.options?.profilePolicyPath?.startsWith(
      path.join(job.jobDirectory, "inputs"),
    ),
  );
  assert.equal(document.inputArtifacts.length, 1);
});

test("durable Tessera jobs reject tampered job-controlled paths", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-path-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "exact",
      playerRoster: built.data,
      opponent: { kind: "roster", roster: built.data },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const document = await readJobDocument(job.requestPath);
  document.resultPath = path.join(root, "escaped-result.json");
  await writeJobDocument(job.requestPath, document);
  await assert.rejects(
    getTesseraRunStatus(job.requestPath, true),
    hasErrorCode("TESSERA_JOB_PATH_INVALID"),
  );
});

test("durable Tessera jobs recover stale reservations and serialize concurrent resumes", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-lock-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: { executionMode: "prepare-only" },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  await cancelTesseraRun(job.requestPath);
  const cancelled = await readJobDocument(job.requestPath);
  const workerLock = path.join(job.jobDirectory, "worker.lock");
  await writeFile(
    workerLock,
    `${JSON.stringify({
      runId: job.runId,
      attempt: cancelled.attempt,
      jobPath: job.requestPath,
      tokenSha256: "0".repeat(64),
      pid: null,
      reservedAt: "2000-01-01T00:00:00.000Z",
    })}\n`,
  );
  const recovered = await resumeTesseraRun(job.requestPath, {
    launch: false,
  });
  assert.equal(recovered.attempt, 2);
  await assert.rejects(access(workerLock), hasErrorCode("ENOENT"));

  await cancelTesseraRun(job.requestPath);
  await writeFile(
    path.join(job.jobDirectory, "job-control.lock"),
    `${JSON.stringify({
      token: "stale-control-lease",
      pid: 2_147_483_647,
      acquiredAt: "2000-01-01T00:00:00.000Z",
      processStartedAt: null,
    })}\n`,
  );
  const resumed = await Promise.all([
    resumeTesseraRun(job.requestPath, { launch: false }),
    resumeTesseraRun(job.requestPath, { launch: false }),
  ]);
  assert.deepEqual(
    resumed.map((entry) => entry.attempt),
    [3, 3],
  );
  const final = await getTesseraRunStatus(job.requestPath);
  assert.equal(final.job.attempt, 3);
  assert.equal(final.job.status, "queued");
});

test("a live control-lease owner is not evicted based on age alone", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-live-lock-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: { executionMode: "prepare-only" },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  await cancelTesseraRun(job.requestPath);
  const controlLock = path.join(
    job.jobDirectory,
    "job-control.lock",
  );
  await writeFile(
    controlLock,
    `${JSON.stringify({
      token: "live-control-lease",
      pid: process.pid,
      acquiredAt: "2000-01-01T00:00:00.000Z",
      processStartedAt: null,
    })}\n`,
  );
  const externalRelease = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      rm(controlLock, { force: true }).then(resolve, reject);
    }, 100);
  });
  const startedAt = Date.now();
  const resumed = await resumeTesseraRun(job.requestPath, {
    launch: false,
  });
  await externalRelease;
  assert.equal(resumed.attempt, 2);
  assert.ok(Date.now() - startedAt >= 75);
});

test("an unavailable local-agent launcher releases its reservation and can retry the same queued attempt", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-spawn-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: { executionMode: "prepare-only" },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const previousSocket =
    process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET;
  process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET = path.join(
    root,
    "missing-agent.sock",
  );
  try {
    let retained = await resumeTesseraRun(job.requestPath);
    assert.equal(retained.status, "queued");
    assert.equal(retained.attempt, 1);
    assert.equal(retained.error?.retryable, true);
    assert.equal(
      retained.error?.code,
      "LOCAL_AGENT_UNAVAILABLE",
    );
    await assert.rejects(
      access(path.join(job.jobDirectory, "worker.lock")),
      hasErrorCode("ENOENT"),
    );
    let queued = await readJobDocument(job.requestPath);
    assert.equal(queued.status, "queued");
    assert.equal(queued.attempt, 1);
    assert.equal(queued.workerPid, null);
    assert.equal(queued.workerTokenSha256, null);

    retained = await resumeTesseraRun(job.requestPath);
    assert.equal(retained.status, "queued");
    assert.equal(retained.attempt, 1);
    queued = await readJobDocument(job.requestPath);
    assert.equal(queued.attempt, 1);
  } finally {
    if (previousSocket === undefined) {
      delete process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET;
    } else {
      process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET =
        previousSocket;
    }
  }
});

test("a launcher failure after publication retains the new durable run", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-published-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const previousSocket =
    process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET;
  process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET = path.join(
    root,
    "missing-agent.sock",
  );
  try {
    const job = await startTesseraRun(
      {
        kind: "stress",
        playerRoster: built.data,
        factionId: "aeldari",
        options: { executionMode: "simulate" },
      },
      {
        outputDirectory: path.join(root, "runs"),
        rootDir: root,
      },
    );
    assert.equal(job.status, "queued");
    assert.equal(job.attempt, 1);
    assert.equal(job.error?.retryable, true);
    assert.equal(
      job.error?.code,
      "LOCAL_AGENT_UNAVAILABLE",
    );
    await access(job.requestPath);
    assert.equal(
      job.runtimeProvenance.localAgentObservedStatus
        ?.available,
      false,
    );
  } finally {
    if (previousSocket === undefined) {
      delete process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET;
    } else {
      process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET =
        previousSocket;
    }
  }
});

test("exact paired-revision jobs freeze the baseline and opponent bytes", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-revision-"),
  );
  const revised = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(revised.ok && revised.data);
  const sourceFiles = {
    playerSource: path.join(root, "player-source.rosz"),
    playerEnriched: path.join(root, "player-enriched.rosz"),
    opponentSource: path.join(root, "opponent-source.rosz"),
    opponentEnriched: path.join(root, "opponent-enriched.rosz"),
  };
  const sourceContents = {
    playerSource: "paired player source fixture",
    playerEnriched: "paired player enriched fixture",
    opponentSource: "paired opponent source fixture",
    opponentEnriched: "paired opponent enriched fixture",
  };
  await Promise.all(
    Object.entries(sourceFiles).map(([key, filename]) =>
      writeFile(
        filename,
        sourceContents[key as keyof typeof sourceContents],
      ),
    ),
  );
  const baselinePath = path.join(root, "baseline.json");
  const summary = {
    rosterName: "Frozen fixture",
    factionName: "Fixture faction",
    totalPoints: 1000,
    generatedBy: "https://newrecruit.eu",
    profileCount: 1,
    weaponProfileCount: 1,
    units: [],
  };
  const baseline: TesseraMatchupReport = {
    schemaVersion: 3,
    runId: "exact-revision-baseline-fixture",
    generatedAt: "2026-07-30T00:00:00.000Z",
    source: "tessera-ui",
    status: "complete",
    profilePolicyHash: null,
    tesseraUiIdentity: sha256("fixture-tessera-ui"),
    pinnedData: revised.data.sourceData,
    comparisonClass: "matched",
    configuration: {
      analysisMode: "quick",
      phases: ["shooting"],
      metrics: ["wipe-probability"],
      directions: [
        "player-to-opponent",
        "opponent-to-player",
      ],
      pointsTolerancePercent: 5,
      allowPointMismatch: false,
      includeChangeCandidates: false,
    },
    pointsComparisons: [
      {
        playerPoints: 1000,
        opponentPoints: 1000,
        pointsLimit: 1000,
        difference: 0,
        differencePercent: 0,
        tolerancePercent: 5,
        matched: true,
        classification: "matched",
      },
    ],
    player: {
      rosterId: revised.data.id,
      rosterName: revised.data.name,
      factionId: revised.data.factionId,
      listUrl: null,
      sourceRoszPath: sourceFiles.playerSource,
      enrichedRoszPath: sourceFiles.playerEnriched,
      sourceRoszSha256: sha256(
        sourceContents.playerSource,
      ),
      enrichedRoszSha256: sha256(
        sourceContents.playerEnriched,
      ),
      summary,
      fingerprint: sha256("fixture-player"),
    },
    opponents: [
      {
        kind: "rosz",
        rosterName: "Frozen opponent",
        sourceRoszPath: sourceFiles.opponentSource,
        enrichedRoszPath: sourceFiles.opponentEnriched,
        sourceRoszSha256: sha256(
          sourceContents.opponentSource,
        ),
        enrichedRoszSha256: sha256(
          sourceContents.opponentEnriched,
        ),
        summary,
        fingerprint: sha256("fixture-opponent"),
      },
    ],
    simulation: {
      requested: true,
      executionMode: "simulate",
      experimental: true,
      status: "complete",
      engine: "tessera-ui",
      settings: {},
      matrices: [],
      scenarios: [],
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    limitations: [],
    warnings: [],
    artifacts: [
      {
        format: "matchup-json",
        written: path.basename(baselinePath),
      },
      {
        format: "matchup-receipt",
        written: path.basename(
          exactReportReceiptPath(baselinePath),
        ),
      },
    ],
  };
  const serializedBaseline =
    `${JSON.stringify(baseline, null, 2)}\n`;
  await writeFile(baselinePath, serializedBaseline);
  const baselineReceipt = createExactReportReceipt(
    baselinePath,
    serializedBaseline,
    baseline,
  );
  await writeFile(
    exactReportReceiptPath(baselinePath),
    `${JSON.stringify(baselineReceipt, null, 2)}\n`,
  );
  const job = await startTesseraRun(
    {
      kind: "exact-revision",
      baselineReportPath: baselinePath,
      revisedRoster: revised.data,
      options: { executionMode: "simulate" },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const document = await readJobDocument(job.requestPath);
  assert.equal(document.request.kind, "exact-revision");
  if (document.request.kind !== "exact-revision") {
    throw new Error("Expected an exact-revision job.");
  }
  assert.ok(
    document.request.baselineReportPath.startsWith(
      path.join(job.jobDirectory, "inputs"),
    ),
  );
  const frozen = JSON.parse(
    await readFile(
      document.request.baselineReportPath,
      "utf8",
    ),
  ) as TesseraMatchupReport;
  const frozenDirectory = path.dirname(
    document.request.baselineReportPath,
  );
  const frozenPaths = [
    frozen.player.sourceRoszPath,
    frozen.player.enrichedRoszPath,
    frozen.opponents[0]!.sourceRoszPath!,
    frozen.opponents[0]!.enrichedRoszPath,
  ];
  assert.ok(
    frozenPaths.every(
      (filename) =>
        !path.isAbsolute(filename) &&
        path.resolve(frozenDirectory, filename).startsWith(
          path.join(job.jobDirectory, "inputs"),
        ),
    ),
  );
  assert.deepEqual(
    await Promise.all(
      frozenPaths.map((filename) =>
        readFile(
          path.resolve(frozenDirectory, filename),
          "utf8",
        ),
      ),
    ),
    [
      sourceContents.playerSource,
      sourceContents.playerEnriched,
      sourceContents.opponentSource,
      sourceContents.opponentEnriched,
    ],
  );
  const frozenSerialized = await readFile(
    document.request.baselineReportPath,
    "utf8",
  );
  const frozenReceiptPath = exactReportReceiptPath(
    document.request.baselineReportPath,
  );
  const frozenReceipt = JSON.parse(
    await readFile(frozenReceiptPath, "utf8"),
  );
  assert.equal(
    verifyExactReportReceipt(
      document.request.baselineReportPath,
      frozenSerialized,
      frozen,
      frozenReceipt,
    ),
    null,
  );
  assert.equal(document.inputArtifacts.length, 6);
  assert.ok(
    document.inputArtifacts.some(
      (artifact) =>
        artifact.path === frozenReceiptPath &&
        artifact.kind === "baseline-artifact",
    ),
  );
  const connectorEvents = [
    {
      schemaVersion: 1 as const,
      eventId: "revision-connector-a",
      recordedAt: "2026-07-30T00:01:00.000Z",
      provider: "new-recruit" as const,
      action: "prepare" as const,
      origin: "new-remote" as const,
      outcome: "verified" as const,
      remoteId: "fixture-a",
      contentSha256: sha256("fixture-a"),
    },
    {
      schemaVersion: 1 as const,
      eventId: "revision-connector-b",
      recordedAt: "2026-07-30T00:02:00.000Z",
      provider: "tessera" as const,
      action: "simulate" as const,
      origin: "in-memory" as const,
      outcome: "verified" as const,
      remoteId: null,
      contentSha256: sha256("fixture-b"),
    },
  ];
  const revisedReports: TesseraMatchupReport[] = [
    {
      ...baseline,
      runId: "revised-report-a",
      connectorEvents: connectorEvents.slice(0, 1),
      artifacts: [],
    },
    {
      ...baseline,
      runId: "revised-report-b",
      connectorEvents: connectorEvents.slice(1),
      artifacts: [],
    },
  ];
  const executionRequests: TesseraRunRequest[] = [];
  await executeMockedAttempt(
    job.requestPath,
    {
      ok: true,
      data: {
        schemaVersion: 2,
        runId: "revision-comparison-fixture",
        generatedAt: "2026-07-30T00:03:00.000Z",
        baselineReportPath:
          document.request.baselineReportPath,
        baselineRunId: baseline.runId,
        revisedRosterFingerprint: sha256(
          "revised-roster-fixture",
        ),
        revisedReports,
        deltas: [],
        aggregates: [],
        summary: {
          improved: 0,
          worsened: 0,
          unchanged: 0,
          ambiguous: 0,
        },
        limitations: [],
        warnings: [],
        artifacts: [],
      },
      violations: [],
      warnings: [],
    },
    {
      inspectRequest: async (request) => {
        executionRequests.push(request);
        assert.equal(request.kind, "exact-revision");
        if (request.kind !== "exact-revision") return;
        const serialized = await readFile(
          request.baselineReportPath,
          "utf8",
        );
        const report = JSON.parse(
          serialized,
        ) as TesseraMatchupReport;
        const reportDirectory = path.dirname(
          request.baselineReportPath,
        );
        await Promise.all(
          [
            report.player.sourceRoszPath,
            report.player.enrichedRoszPath,
            ...report.opponents.flatMap((opponent) => [
              opponent.sourceRoszPath!,
              opponent.enrichedRoszPath,
            ]),
            exactReportReceiptPath(
              request.baselineReportPath,
            ),
          ].map((filename) =>
            access(
              path.isAbsolute(filename)
                ? filename
                : path.resolve(reportDirectory, filename),
            ),
          ),
        );
        const receipt = JSON.parse(
          await readFile(
            exactReportReceiptPath(
              request.baselineReportPath,
            ),
            "utf8",
          ),
        );
        assert.equal(
          verifyExactReportReceipt(
            request.baselineReportPath,
            serialized,
            report,
            receipt,
          ),
          null,
        );
      },
    },
  );
  const executionRequest = executionRequests[0];
  assert.equal(executionRequest?.kind, "exact-revision");
  if (
    !executionRequest ||
    executionRequest.kind !== "exact-revision"
  ) {
    throw new Error(
      "Expected an exact-revision execution request.",
    );
  }
  assert.equal(
    executionRequest.options?.sessionId,
    job.runId,
  );
  await Promise.all([
    writeFile(
      sourceFiles.opponentEnriched,
      "changed opponent",
    ),
    writeFile(baselinePath, "{}\n"),
  ]);
  const retained = await getTesseraRunStatus(job.requestPath);
  assert.equal(retained.job.runId, job.runId);
  assert.match(
    retained.job.attemptHistory[0]
      ?.connectorReceiptSha256 ?? "",
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    retained.job.attemptHistory[0]?.tesseraUiIdentity,
    baseline.tesseraUiIdentity,
  );
});

test("status classifies a verifiably dead worker and preserves retry provenance", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-dead-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: { executionMode: "prepare-only" },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const document = await readJobDocument(job.requestPath);
  const startedAt = new Date().toISOString();
  const workerTokenSha256 = sha256("dead-worker");
  document.status = "running";
  document.startedAt = startedAt;
  document.workerPid = 2_147_483_647;
  document.workerTokenSha256 = workerTokenSha256;
  document.attemptHistory[0] = {
    ...document.attemptHistory[0]!,
    status: "running",
    startedAt,
  };
  await writeJobDocument(job.requestPath, document);
  const workerLock = path.join(job.jobDirectory, "worker.lock");
  await writeFile(
    workerLock,
    `${JSON.stringify({
      runId: job.runId,
      attempt: 1,
      jobPath: job.requestPath,
      tokenSha256: workerTokenSha256,
      pid: 2_147_483_647,
      processStartedAt: null,
      reservedAt: new Date().toISOString(),
    })}\n`,
  );

  const status = await getTesseraRunStatus(job.requestPath);
  assert.equal(status.job.status, "failed");
  assert.equal(status.job.error?.code, "TESSERA_WORKER_EXITED");
  assert.equal(
    status.job.attemptHistory[0]?.errorCode,
    "TESSERA_WORKER_EXITED",
  );
  assert.equal(status.job.retryBudget.lifetimeAttemptsRemaining, 4);
  await assert.rejects(access(workerLock), hasErrorCode("ENOENT"));
});

test("retryable worker results automatically queue attempts two and three", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-auto-retry-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  let job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: { executionMode: "prepare-only" },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const transientResult: TesseraRunResult = {
    ok: false,
    data: null,
    violations: [
      {
        code: "TESSERA_BROWSER_TIMEOUT",
        message: "Synthetic transient browser timeout.",
        severity: "error",
      },
    ],
    warnings: [],
  };
  let schedules = 0;
  const scheduleWithoutLaunching = async (
    jobPath: string,
  ): Promise<void> => {
    schedules += 1;
    await resumeTesseraRun(jobPath, { launch: false });
  };

  await executeMockedAttempt(job.requestPath, transientResult, {
    automaticRetry: true,
    scheduleAutomaticRetry: scheduleWithoutLaunching,
  });
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.equal(job.attempt, 2);
  assert.equal(job.status, "queued");
  assert.equal(job.attemptHistory[0]?.status, "failed");
  assert.equal(job.attemptHistory[1]?.retryClass, "automatic");

  await executeMockedAttempt(job.requestPath, transientResult, {
    automaticRetry: true,
    scheduleAutomaticRetry: scheduleWithoutLaunching,
  });
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.equal(job.attempt, 3);
  assert.equal(job.status, "queued");

  await executeMockedAttempt(job.requestPath, transientResult, {
    automaticRetry: true,
    scheduleAutomaticRetry: scheduleWithoutLaunching,
  });
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.equal(job.attempt, 3);
  assert.equal(job.status, "failed");
  assert.equal(schedules, 2);
  assert.equal(job.retryBudget.automaticAttemptsRemaining, 0);
  assert.equal(job.error?.retryable, true);
});

test("durable workers are the sole automatic retry owner for stress stages", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-retry-owner-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        executionMode: "simulate",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const observedRequests: TesseraRunRequest[] = [];
  await executeMockedAttempt(
    job.requestPath,
    {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BROWSER_TIMEOUT",
          message: "Synthetic retry-owner fixture.",
          severity: "error",
        },
      ],
      warnings: [],
    },
    {
      inspectRequest: (request) => {
        observedRequests.push(request);
      },
    },
  );
  const observed = observedRequests[0];
  assert.equal(observed?.kind, "stress");
  if (!observed || observed.kind !== "stress") {
    throw new Error("Expected a coordinated stress request.");
  }
  assert.equal(
    observed.options?.retryOwner,
    "durable-job",
  );
  assert.equal(observed.options?.durableAttemptNumber, 1);
  const resumed = await resumeTesseraRun(job.requestPath, {
    launch: false,
  });
  const secondRequests: TesseraRunRequest[] = [];
  await executeMockedAttempt(
    resumed.requestPath,
    {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BROWSER_TIMEOUT",
          message: "Synthetic second retry-owner fixture.",
          severity: "error",
        },
      ],
      warnings: [],
    },
    {
      inspectRequest: (request) => {
        secondRequests.push(request);
      },
    },
  );
  const second = secondRequests[0];
  assert.equal(second?.kind, "stress");
  if (!second || second.kind !== "stress") {
    throw new Error("Expected a second coordinated stress request.");
  }
  assert.equal(second.options?.durableAttemptNumber, 2);
});

test("exact job resumes bind the last hash-verified prepared checkpoint", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-exact-checkpoint-"),
  );
  const player = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Exact checkpoint player",
  });
  const opponent = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    name: "Exact checkpoint opponent",
  });
  assert.ok(player.ok && player.data);
  assert.ok(opponent.ok && opponent.data);
  let job = await startTesseraRun(
    {
      kind: "exact",
      playerRoster: player.data,
      opponent: { kind: "roster", roster: opponent.data },
      options: { executionMode: "simulate" },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const document = await readJobDocument(job.requestPath);
  assert.equal(document.request.kind, "exact");
  if (document.request.kind !== "exact") {
    throw new Error("Expected an exact checkpoint fixture.");
  }
  const outputDirectory =
    document.request.options?.outputDirectory;
  assert.ok(outputDirectory);
  const artifactDirectory = path.join(
    outputDirectory,
    "checkpoint",
  );
  await mkdir(artifactDirectory, { recursive: true });
  const paths = {
    playerSource: path.join(artifactDirectory, "player-source.rosz"),
    playerEnriched: path.join(artifactDirectory, "player-enriched.rosz"),
    opponentSource: path.join(artifactDirectory, "opponent-source.rosz"),
    opponentEnriched: path.join(
      artifactDirectory,
      "opponent-enriched.rosz",
    ),
  };
  await Promise.all(
    Object.entries(paths).map(([label, filename]) =>
      writeFile(filename, `${label}-fixture`),
    ),
  );
  const digest = async (filename: string): Promise<string> =>
    sha256(await readFile(filename, "utf8"));
  const summary = {
    rosterName: "Checkpoint",
    factionName: "Fixture",
    totalPoints: 1000,
    generatedBy: "https://newrecruit.eu",
    unitCount: 1,
    profileCount: 1,
    weaponProfileCount: 1,
    units: [],
  };
  const checkpointReportPath = path.join(
    outputDirectory,
    "checkpoint.json",
  );
  const reportReceiptPath = path.join(
    outputDirectory,
    "checkpoint.receipt.json",
  );
  const checkpointReport: TesseraMatchupReport = {
    schemaVersion: 3,
    runId: "checkpoint-run",
    generatedAt: "2026-07-30T00:00:00.000Z",
    source: "tessera-ui-failed",
    status: "failed",
    player: {
      rosterId: player.data.id,
      rosterName: player.data.name,
      factionId: player.data.factionId,
      listUrl: null,
      sourceRoszPath: paths.playerSource,
      enrichedRoszPath: paths.playerEnriched,
      sourceRoszSha256: await digest(paths.playerSource),
      enrichedRoszSha256: await digest(paths.playerEnriched),
      summary,
      fingerprint: sha256("player-fingerprint"),
    },
    opponents: [
      {
        kind: "roster",
        rosterName: opponent.data.name,
        sourceRoszPath: paths.opponentSource,
        enrichedRoszPath: paths.opponentEnriched,
        sourceRoszSha256: await digest(paths.opponentSource),
        enrichedRoszSha256: await digest(
          paths.opponentEnriched,
        ),
        summary,
        fingerprint: sha256("opponent-fingerprint"),
      },
    ],
    failures: [
      {
        stage: "simulation",
        code: "TESSERA_BROWSER_TIMEOUT",
        message: "Synthetic timeout after preparation.",
        opponentName: opponent.data.name,
        retryable: true,
      },
    ],
    simulation: {
      requested: true,
      executionMode: "simulate",
      experimental: true,
      status: "failed",
      engine: "tessera-ui",
      settings: {},
      matrices: [],
      scenarios: [],
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    limitations: [],
    warnings: [],
    artifacts: [
      {
        format: "matchup-json",
        written: checkpointReportPath,
      },
      {
        format: "matchup-receipt",
        written: reportReceiptPath,
      },
    ],
  };
  const serializedCheckpointReport =
    `${JSON.stringify(checkpointReport, null, 2)}\n`;
  await writeFile(
    checkpointReportPath,
    serializedCheckpointReport,
  );
  await writeFile(
    reportReceiptPath,
    `${JSON.stringify(
      createExactReportReceipt(
        checkpointReportPath,
        serializedCheckpointReport,
        checkpointReport,
      ),
      null,
      2,
    )}\n`,
  );
  const transientResult: TesseraRunResult = {
    ok: false,
    data: checkpointReport,
    violations: [
      {
        code: "TESSERA_BROWSER_TIMEOUT",
        message: "Synthetic timeout after preparation.",
        severity: "error",
      },
    ],
    warnings: [],
  };
  await executeMockedAttempt(
    job.requestPath,
    transientResult,
  );
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.equal(job.status, "failed");
  assert.equal(
    job.artifactReceipts.some(
      (receipt) =>
        receipt.kind === "report-receipt" &&
        path.resolve(
          job.jobDirectory,
          receipt.path,
        ) === reportReceiptPath,
    ),
    true,
  );
  assert.equal(job.preparedCheckpoint?.sourceAttempt, 1);
  assert.equal(
    job.preparedCheckpoint?.opponent?.sourceRoszPath,
    paths.opponentSource,
  );

  const restarted = await resumeTesseraRun(job.requestPath, {
    restartFrom: true,
    launch: false,
  });
  assert.notEqual(restarted.runId, job.runId);
  assert.equal(restarted.simulationStage, 2);
  assert.equal(restarted.preparedCheckpoint?.sourceAttempt, 1);
  assert.ok(
    restarted.preparedCheckpoint?.player.sourceRoszPath.startsWith(
      restarted.jobDirectory,
    ),
  );
  assert.notEqual(
    restarted.preparedCheckpoint?.player.sourceRoszPath,
    paths.playerSource,
  );
  const restartedDocument = await readJobDocument(
    restarted.requestPath,
  );
  assert.equal(restartedDocument.request.kind, "exact");
  if (restartedDocument.request.kind !== "exact") {
    throw new Error("Expected a restarted exact checkpoint fixture.");
  }
  assert.equal(
    restartedDocument.request.options?.preparedReuse
      ?.player.sourceRoszPath,
    restarted.preparedCheckpoint?.player.sourceRoszPath,
  );

  job = await resumeTesseraRun(job.requestPath, {
    launch: false,
  });
  assert.equal(job.attempt, 2);
  const resumed = await readJobDocument(job.requestPath);
  assert.equal(resumed.request.kind, "exact");
  if (resumed.request.kind !== "exact") {
    throw new Error("Expected a resumed exact checkpoint fixture.");
  }
  assert.equal(
    resumed.request.options?.preparedReuse?.sourceAttempt,
    1,
  );
  assert.equal(
    resumed.request.options?.preparedReuse?.player.sourceRoszPath,
    paths.playerSource,
  );
  assert.equal(
    resumed.request.options?.preparedReuse?.opponent
      ?.enrichedRoszPath,
    paths.opponentEnriched,
  );
});

test("retry budgets stop at five attempts and restart-from opens a fresh simulation stage", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-budget-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  let job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: { executionMode: "prepare-only" },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const failedResult: TesseraRunResult = {
    ok: false,
    data: null,
    violations: [
      {
        code: "TESSERA_TRANSIENT_TEST_FAILURE",
        message: "Synthetic retryable worker result.",
        severity: "error",
      },
    ],
    warnings: [],
  };

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await executeMockedAttempt(job.requestPath, failedResult);
    job = (await getTesseraRunStatus(job.requestPath)).job;
    assert.equal(job.attempt, attempt);
    assert.equal(job.status, "failed");
    assert.match(
      job.attemptHistory[attempt - 1]?.resultSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.equal(
      job.artifactReceipts.find(
        (receipt) => receipt.kind === "result",
      )?.attempt,
      attempt,
    );
    if (attempt === 3) {
      assert.equal(
        job.retryBudget.automaticAttemptsRemaining,
        0,
      );
      assert.equal(job.retryBudget.lifetimeAttemptsRemaining, 2);
    }
    if (attempt < 5) {
      job = await resumeTesseraRun(job.requestPath, {
        launch: false,
      });
      assert.equal(job.attempt, attempt + 1);
    }
  }
  assert.equal(job.retryBudget.exhausted, true);
  assert.equal(job.retryBudget.explicitRestartRequired, true);
  assert.equal(
    job.attemptHistory[3]?.retryClass,
    "lifetime-explicit",
  );
  await assert.rejects(
    resumeTesseraRun(job.requestPath, { launch: false }),
    hasErrorCode("TESSERA_RUN_RETRY_BUDGET_EXHAUSTED"),
  );

  const restarted = await resumeTesseraRun(job.requestPath, {
    restartFrom: true,
    launch: false,
  });
  assert.notEqual(restarted.runId, job.runId);
  assert.equal(restarted.attempt, 1);
  assert.equal(restarted.simulationStage, 2);
  assert.equal(restarted.restartFrom?.runId, job.runId);
  assert.equal(
    restarted.attemptHistory[0]?.trigger,
    "restart-from",
  );
  assert.equal(restarted.retryBudget.lifetimeAttemptsRemaining, 4);
  assert.equal(restarted.artifactReceipts.length, 0);
});

test("worker lifecycle retains enriched profile requirements as needs-input", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-profile-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "exact",
      playerRoster: built.data,
      opponent: { kind: "roster", roster: built.data },
      options: { executionMode: "simulate" },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const document = await readJobDocument(job.requestPath);
  assert.equal(document.request.kind, "exact");
  if (document.request.kind !== "exact") {
    throw new Error("Expected an exact job fixture.");
  }
  const workerToken = "mocked-worker-token";
  const workerTokenSha256 = sha256(workerToken);
  document.workerPid = process.pid;
  document.workerTokenSha256 = workerTokenSha256;
  await writeJobDocument(job.requestPath, document);
  await writeFile(
    path.join(job.jobDirectory, "worker.lock"),
    `${JSON.stringify({
      runId: job.runId,
      attempt: job.attempt,
      jobPath: job.requestPath,
      tokenSha256: workerTokenSha256,
      pid: process.pid,
      reservedAt: new Date().toISOString(),
    })}\n`,
  );
  const outputDirectory =
    document.request.options?.outputDirectory;
  assert.ok(outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const scaffold = {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: [
      {
        faction: "Adeptus Custodes",
        unit: "Allarus Custodians",
        weaponGroup: "Balistus grenade launcher",
        phase: "shooting",
        selectedProfile: "SELECT_ONE_OF: focused | dispersed",
        activeCount: 1,
      },
    ],
  };
  await writeFile(
    path.join(
      outputDirectory,
      "profile-policy.enriched.scaffold.json",
    ),
    `${JSON.stringify(scaffold, null, 2)}\n`,
  );
  await executeTesseraRunJob(
    job.requestPath,
    workerToken,
    {
      executeRequest: async () => ({
        ok: false,
        data: null,
        violations: [
          {
            code:
              "TESSERA_PROFILE_POLICY_REQUIRED_AFTER_ENRICHMENT",
            message: "Expanded profile choices are required.",
            severity: "error",
          },
        ],
        warnings: [],
      }),
    },
  );
  const status = await getTesseraRunStatus(job.requestPath, true);
  assert.equal(status.job.status, "needs-input");
  assert.equal(
    status.job.profileResolution?.violationCode,
    "TESSERA_PROFILE_POLICY_REQUIRED_AFTER_ENRICHMENT",
  );
  assert.equal(
    status.job.profileResolution?.scaffold?.entries[0]
      ?.selectedProfile,
    scaffold.entries[0].selectedProfile,
  );
  assert.deepEqual(
    status.job.profileResolution?.requirements[0]
      ?.availableProfiles,
    ["focused", "dispersed"],
  );
  assert.match(
    status.job.profileResolution?.scaffoldSha256 ?? "",
    /^[0-9a-f]{64}$/,
  );
  await assert.rejects(
    access(path.join(job.jobDirectory, "worker.lock")),
    hasErrorCode("ENOENT"),
  );
  await resolveTesseraRunProfiles(job.requestPath, {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: [
      {
        faction: "Adeptus Custodes",
        unit: "Allarus Custodians",
        weaponGroup: "Balistus grenade launcher",
        phase: "shooting",
        selectedProfile: "focused",
        activeCount: 1,
      },
    ],
  });
  const resumed = await resumeTesseraRun(job.requestPath, {
    launch: false,
  });
  assert.equal(resumed.attempt, 2);
  const resumedDocument = await readJobDocument(job.requestPath);
  assert.equal(resumedDocument.request.kind, "exact");
  if (resumedDocument.request.kind !== "exact") {
    throw new Error("Expected an exact resumed job fixture.");
  }
  assert.ok(
    resumedDocument.request.options?.outputDirectory?.endsWith(
      path.join("artifacts", "attempt-2"),
    ),
  );
  assert.notEqual(
    resumedDocument.request.options?.outputDirectory,
    outputDirectory,
  );
});

test("durable retries retain and enforce the selected local provider identity", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-provider-pin-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  let job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        executionMode: "simulate",
        simulationBackend: "auto",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const localIdentity = {
    schemaVersion: 1 as const,
    provider: "local-engine" as const,
    engine: "tessera-engine" as const,
    repository: "Tessera-cmd/tessera-engine" as const,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceSha256: "c".repeat(64),
    adapterVersion: "fixture-adapter-v1",
    compilerVersion: "fixture-compiler-v1",
    inputSchemaVersion: 1 as const,
    capabilityManifestSha256: "d".repeat(64),
    promotion: "candidate" as const,
    licenseState: "evaluation-only" as const,
  };
  const localFailure = {
    ok: false,
    data: {
      reportKind: "tessera-stress-test",
      source: "tessera-local-engine-failed",
      status: "failed",
      simulation: {
        requested: true,
        status: "failed",
        selectedBackend: "local-engine",
        providerIdentity: localIdentity,
      },
    },
    violations: [
      {
        code: "TESSERA_BROWSER_TIMEOUT",
        message: "Synthetic retryable provider fixture.",
        severity: "error",
      },
    ],
    warnings: [],
  } as unknown as TesseraRunResult;
  await executeMockedAttempt(job.requestPath, localFailure);
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.equal(job.status, "failed");
  assert.equal(
    job.simulationProviderPin?.selectedBackend,
    "local-engine",
  );
  assert.deepEqual(
    job.simulationProviderPin?.providerIdentity,
    localIdentity,
  );
  assert.equal(
    job.attemptHistory[0]?.simulationBackend,
    "local-engine",
  );

  job = await resumeTesseraRun(job.requestPath, { launch: false });
  assert.equal(
    job.attemptHistory[1]?.simulationBackend,
    "local-engine",
  );
  const websiteIdentity = {
    schemaVersion: 1 as const,
    provider: "website" as const,
    engine: "tessera-ui" as const,
    uiIdentity: "fixture-ui-v2",
    adapterVersion: "website-browser-v1",
  };
  const websiteFailure = {
    ...localFailure,
    data: {
      reportKind: "tessera-stress-test",
      source: "tessera-ui-failed",
      status: "failed",
      simulation: {
        requested: true,
        status: "failed",
        selectedBackend: "website",
        providerIdentity: websiteIdentity,
      },
    },
  } as unknown as TesseraRunResult;
  await executeMockedAttempt(job.requestPath, websiteFailure, {
    inspectRequest: (request) => {
      assert.equal(request.options?.simulationBackend, "local-engine");
    },
  });
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.equal(job.status, "failed");
  assert.equal(
    job.error?.code,
    "TESSERA_SIMULATION_PROVIDER_CHANGED",
  );
  assert.equal(
    job.attemptHistory[1]?.simulationBackend,
    "local-engine",
  );
  assert.deepEqual(
    job.simulationProviderPin?.providerIdentity,
    localIdentity,
  );
});

test("durable retries pin the first complete provider compatibility envelope set", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-compatibility-pin-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  let job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        executionMode: "simulate",
        simulationBackend: "local-engine",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const localIdentity = {
    schemaVersion: 1 as const,
    provider: "local-engine" as const,
    engine: "tessera-engine" as const,
    repository: "Tessera-cmd/tessera-engine" as const,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceSha256: "c".repeat(64),
    adapterVersion: "fixture-adapter-v1",
    compilerVersion: "fixture-compiler-v1",
    inputSchemaVersion: 1 as const,
    capabilityManifestSha256: "d".repeat(64),
    promotion: "candidate" as const,
    licenseState: "evaluation-only" as const,
  };
  const envelope = (
    marker: string,
  ): TesseraProviderCompatibilityEnvelope => {
    const withoutDigest = {
      schemaVersion: 1 as const,
      kind: "rosterpilot-provider-compatibility" as const,
      data: { marker },
      rosters: [],
      tessera: { provider: "local-engine" },
      profilePolicyHash: null,
      scenarioContractSha256: "e".repeat(64),
      complete: true,
      issues: [],
    };
    return {
      ...withoutDigest,
      envelopeSha256: providerCompatibilityEnvelopeSha256(
        withoutDigest as never,
      ),
    } as unknown as TesseraProviderCompatibilityEnvelope;
  };
  const result = (
    compatibility: TesseraProviderCompatibilityEnvelope,
  ): TesseraRunResult => ({
    ok: false,
    data: {
      reportKind: "tessera-stress-test",
      source: "tessera-local-engine-failed",
      status: "failed",
      providerCompatibilityEnvelopes: [compatibility],
      simulation: {
        requested: true,
        status: "failed",
        selectedBackend: "local-engine",
        providerIdentity: localIdentity,
      },
    },
    violations: [
      {
        code: "TESSERA_BROWSER_TIMEOUT",
        message: "Synthetic retryable compatibility fixture.",
        severity: "error",
      },
    ],
    warnings: [],
  }) as unknown as TesseraRunResult;

  await executeMockedAttempt(job.requestPath, result(envelope("first")));
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.match(
    job.simulationProviderPin?.providerCompatibilitySha256 ?? "",
    /^[a-f0-9]{64}$/,
  );

  job = await resumeTesseraRun(job.requestPath, { launch: false });
  await executeMockedAttempt(job.requestPath, result(envelope("changed")));
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.equal(job.status, "failed");
  assert.equal(
    job.error?.code,
    "TESSERA_SIMULATION_PROVIDER_CHANGED",
  );
});

test("legacy website reports pin compatible retries to the website backend", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-legacy-ui-pin-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  let job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
      options: {
        executionMode: "simulate",
        simulationBackend: "auto",
      },
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const legacyWebsiteFailure = {
    ok: false,
    data: {
      reportKind: "tessera-stress-test",
      source: "tessera-ui-failed",
      status: "failed",
      tesseraUiIdentity: "legacy-ui-fixture",
    },
    violations: [
      {
        code: "TESSERA_BROWSER_TIMEOUT",
        message: "Synthetic legacy website retry.",
        severity: "error",
      },
    ],
    warnings: [],
  } as unknown as TesseraRunResult;
  await executeMockedAttempt(job.requestPath, legacyWebsiteFailure);
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.equal(
    job.simulationProviderPin?.selectedBackend,
    "website",
  );
  assert.equal(
    job.simulationProviderPin?.providerIdentity,
    null,
  );
  assert.equal(
    job.attemptHistory[0]?.tesseraUiIdentity,
    "legacy-ui-fixture",
  );

  job = await resumeTesseraRun(job.requestPath, { launch: false });
  await executeMockedAttempt(job.requestPath, legacyWebsiteFailure, {
    inspectRequest: (request) => {
      assert.equal(request.options?.simulationBackend, "website");
    },
  });
  job = (await getTesseraRunStatus(job.requestPath)).job;
  assert.equal(job.error?.code, "TESSERA_BROWSER_TIMEOUT");
  assert.equal(job.attemptHistory[1]?.simulationBackend, "website");
});

test("durable jobs canonicalize duplicate legacy UI identities and reject mixed composites", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-legacy-ui-composite-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const uiIdentity = "fixture-ui-composite";
  const providerIdentity = {
    schemaVersion: 1 as const,
    provider: "website" as const,
    engine: "tessera-ui" as const,
    uiIdentity,
    adapterVersion: "website-browser-v1",
  };
  const result = (legacyUiIdentity: string): TesseraRunResult => ({
    ok: true,
    data: {
      reportKind: "tessera-stress-test",
      source: "tessera-ui",
      status: "complete",
      tesseraUiIdentity: legacyUiIdentity,
      simulation: {
        selectedBackend: "website",
        providerIdentity,
      },
    },
    violations: [],
    warnings: [],
  }) as unknown as TesseraRunResult;
  const start = () =>
    startTesseraRun(
      {
        kind: "stress",
        playerRoster: built.data!,
        factionId: "aeldari",
        options: {
          executionMode: "simulate",
          simulationBackend: "website",
        },
      },
      {
        outputDirectory: path.join(root, "runs"),
        rootDir: root,
        launch: false,
      },
    );

  let accepted = await start();
  await executeMockedAttempt(
    accepted.requestPath,
    result(`${uiIdentity}|${uiIdentity}`),
  );
  accepted = (await getTesseraRunStatus(accepted.requestPath)).job;
  assert.equal(accepted.status, "complete");
  assert.equal(
    accepted.attemptHistory[0]?.tesseraUiIdentity,
    uiIdentity,
  );
  assert.equal(
    accepted.simulationProviderPin?.tesseraUiIdentity,
    uiIdentity,
  );

  let rejected = await start();
  await executeMockedAttempt(
    rejected.requestPath,
    result(`${uiIdentity}|fixture-ui-different`),
  );
  rejected = (await getTesseraRunStatus(rejected.requestPath)).job;
  assert.equal(rejected.status, "failed");
  assert.equal(
    rejected.error?.code,
    "TESSERA_PROVIDER_PROVENANCE_DRIFT",
  );
  assert.equal(
    rejected.attemptHistory[0]?.errorCode,
    "TESSERA_PROVIDER_PROVENANCE_DRIFT",
  );
});

test("cancel verifies the worker path, job path, and launch token before signaling", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-job-cancel-"),
  );
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const job = await startTesseraRun(
    {
      kind: "stress",
      playerRoster: built.data,
      factionId: "aeldari",
    },
    {
      outputDirectory: path.join(root, "runs"),
      rootDir: root,
      launch: false,
    },
  );
  const document = await readJobDocument(job.requestPath);
  const workerPath = path.resolve(
    "local",
    "tessera",
    "job-worker.ts",
  );
  const matchingToken = "1".repeat(64);
  const wrongToken = "2".repeat(64);
  const tokenSha256 = sha256(matchingToken);
  const wrongWorker = spawn(
    process.execPath,
    [
      "-e",
      "setInterval(() => {}, 1000)",
      workerPath,
      job.requestPath,
      wrongToken,
    ],
    { stdio: "ignore" },
  );
  await new Promise<void>((resolve, reject) => {
    wrongWorker.once("spawn", resolve);
    wrongWorker.once("error", reject);
  });
  assert.ok(wrongWorker.pid);
  document.workerPid = wrongWorker.pid;
  document.workerTokenSha256 = tokenSha256;
  await writeJobDocument(job.requestPath, document);
  await writeFile(
    path.join(job.jobDirectory, "worker.lock"),
    `${JSON.stringify({
      runId: job.runId,
      attempt: job.attempt,
      jobPath: job.requestPath,
      tokenSha256,
      pid: wrongWorker.pid,
      processStartedAt: null,
      reservedAt: new Date().toISOString(),
    })}\n`,
  );
  try {
    await assert.rejects(
      cancelTesseraRun(job.requestPath, {
        processCommand: async () =>
          `${process.execPath} --import tsx ${workerPath} ${job.requestPath} ${wrongToken}`,
      }),
      hasErrorCode("TESSERA_WORKER_IDENTITY_MISMATCH"),
    );
    assert.equal(processExistsForTest(wrongWorker.pid), true);
  } finally {
    const wrongWorkerExit = new Promise<void>((resolve) => {
      wrongWorker.once("exit", () => resolve());
    });
    wrongWorker.kill("SIGTERM");
    await wrongWorkerExit;
  }

  const matchingWorker = spawn(
    process.execPath,
    [
      "-e",
      "setInterval(() => {}, 1000)",
      workerPath,
      job.requestPath,
      matchingToken,
    ],
    { stdio: "ignore" },
  );
  await new Promise<void>((resolve, reject) => {
    matchingWorker.once("spawn", resolve);
    matchingWorker.once("error", reject);
  });
  assert.ok(matchingWorker.pid);
  const matchingDocument = await readJobDocument(job.requestPath);
  matchingDocument.workerPid = matchingWorker.pid;
  matchingDocument.workerTokenSha256 = tokenSha256;
  await writeJobDocument(job.requestPath, matchingDocument);
  await writeFile(
    path.join(job.jobDirectory, "worker.lock"),
    `${JSON.stringify({
      runId: job.runId,
      attempt: job.attempt,
      jobPath: job.requestPath,
      tokenSha256,
      pid: matchingWorker.pid,
      processStartedAt: null,
      reservedAt: new Date().toISOString(),
    })}\n`,
  );
  const matchingWorkerExit = new Promise<void>((resolve) => {
    matchingWorker.once("exit", () => resolve());
  });
  let cancelled: TesseraRunJob;
  try {
    cancelled = await cancelTesseraRun(job.requestPath, {
      processCommand: async () =>
        `${process.execPath} --import tsx ${workerPath} ${job.requestPath} ${matchingToken}`,
    });
  } finally {
    if (processExistsForTest(matchingWorker.pid)) {
      matchingWorker.kill("SIGTERM");
    }
  }
  await matchingWorkerExit;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(processExistsForTest(matchingWorker.pid), false);
});

function processExistsForTest(pid = process.pid): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
