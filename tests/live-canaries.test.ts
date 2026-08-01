import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRoster,
  type RuntimeProvenance,
  type TesseraStressPortfolioPreview,
} from "../lib/rosterpilot";
import type { LocalAgentStatus } from "../local/agent/contracts";
import {
  LIVE_CANARY_DEFINITIONS,
  LIVE_CANARY_FIXTURE_ENV,
  LIVE_CANARY_IDS,
  LIVE_CANARY_PROFILE_POLICY_ENV,
  createLiveCanaryRunRequest,
  evaluateLiveCanaryReadiness,
  liveCanaryDefinition,
} from "../local/certification/live-canaries";
import {
  runRotatingLiveCanary,
  sourcePinsCompatible,
  writeRotatingLiveCanaryReport,
} from "../local/certification/live-canary-runner";

const runtime: RuntimeProvenance = {
  rosterPilotVersion: "test",
  rulesPackageVersion: "test",
  stressGeneratorVersion: "test",
  processStartedAt: "2026-07-30T00:00:00.000Z",
  gitHead: "a".repeat(40),
  sourceFingerprintAtStart: "b".repeat(64),
  sourceFingerprintNow: "b".repeat(64),
  buildId: "live-canary-test-build",
  stale: false,
};

function readyAgent(projectDirectory: string): LocalAgentStatus {
  return {
    available: true,
    version: "test",
    protocolVersion: 10,
    protocolCompatible: true,
    runtime,
    platform: "darwin",
    projectDirectory,
    nodeExecutable: "/usr/bin/node",
    browserAvailable: true,
    brokerAvailable: true,
    activeJob: false,
    queuedJobs: 0,
    providers: [
      {
        providerId: "new-recruit",
        credentialMode: "keychain",
        credentialState: "ready",
        ready: true,
      },
      {
        providerId: "tessera",
        credentialMode: "keychain",
        credentialState: "ready",
        ready: true,
      },
    ],
  };
}

test("cross-faction canaries compare the shared release pin rather than faction catalogue revisions", () => {
  const deathGuard = buildRoster({
    faction: "death-guard",
    pointsLimit: 1_000,
  }).data;
  const orks = buildRoster({
    faction: "orks",
    pointsLimit: 1_000,
  }).data;
  assert.ok(deathGuard);
  assert.ok(orks);
  assert.notEqual(
    deathGuard.sourceData.newRecruit.catalogueRevision,
    orks.sourceData.newRecruit.catalogueRevision,
  );
  assert.equal(sourcePinsCompatible(deathGuard, orks), true);

  const staleOrks = structuredClone(orks);
  staleOrks.sourceData.releaseId = "stale-release";
  assert.equal(
    sourcePinsCompatible(deathGuard, staleOrks),
    false,
  );

  const staleDeathGuard = structuredClone(deathGuard);
  staleDeathGuard.sourceData.newRecruit.catalogueRevision =
    (staleDeathGuard.sourceData.newRecruit.catalogueRevision ?? 0) +
    1;
  assert.equal(
    sourcePinsCompatible(deathGuard, staleDeathGuard),
    false,
  );
});

function builtRoster(
  faction: string,
  pointsLimit: number,
) {
  const result = buildRoster({
    faction,
    pointsLimit,
    name: `${faction} live-canary test`,
  });
  assert.equal(
    result.ok,
    true,
    result.violations
      .map((violation) => violation.message)
      .join("\n"),
  );
  assert.ok(result.data);
  return result.data;
}

test("rotating live canaries define the three source-backed routes", () => {
  assert.deepEqual(Object.keys(LIVE_CANARY_DEFINITIONS), [
    ...LIVE_CANARY_IDS,
  ]);
  const stress = liveCanaryDefinition(
    "custodes-vs-adaptive-nine-aeldari-2000",
  );
  assert.equal(stress.route, "adaptive-nine-stress");
  assert.equal(stress.playerFactionId, "adeptus-custodes");
  assert.equal(stress.opponentFactionId, "aeldari");
  assert.equal(stress.pointsLimit, 2_000);
  assert.ok(
    stress.assertions.some(
      (assertion) =>
        assertion.id === "forced-client-timeout",
    ),
  );
  assert.ok(
    stress.assertions.some(
      (assertion) => assertion.id === "resume-same-run",
    ),
  );

  const exact = liveCanaryDefinition(
    "death-guard-vs-orks-exact-1000",
  );
  assert.equal(exact.route, "distinct-faction-exact");
  assert.notEqual(
    exact.playerFactionId,
    exact.opponentFactionId,
  );

  const uploaded = liveCanaryDefinition(
    "uploaded-multiprofile-exact-paired-revision",
  );
  assert.equal(
    uploaded.route,
    "uploaded-multiprofile-paired-revision",
  );
  assert.deepEqual(
    new Set(uploaded.requiredPathEnvironment),
    new Set([
      LIVE_CANARY_PROFILE_POLICY_ENV,
      ...Object.values(LIVE_CANARY_FIXTURE_ENV),
    ]),
  );
});

test("the daily workflow serially routes every named live canary", async () => {
  const workflow = await readFile(
    path.resolve(
      ".github",
      "workflows",
      "certification-live.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /max-parallel:\s+1/);
  assert.match(workflow, /npm run certify:canary --/);
  assert.match(workflow, /--require-live/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /--expected-bundle-id/);
  assert.doesNotMatch(workflow, /31 10 \* \* \*/);
  assert.match(workflow, /live-release-prerequisites:/);
  assert.match(workflow, /application-release\.yml/);
  assert.match(
    workflow,
    /Require trusted signed bootstrap and hosted copies[\s\S]*data:bundle:verify-release/,
  );
  assert.match(
    workflow,
    /Install the verified application data release[\s\S]*actions\/download-artifact@v4/,
  );
  const postActivation = workflow.slice(
    workflow.indexOf("post-activation-bundle:"),
    workflow.indexOf("live-release-prerequisites:"),
  );
  assert.match(
    postActivation,
    /inputs\.cadence == 'release'/,
  );
  const livePrerequisites = workflow.slice(
    workflow.indexOf("live-release-prerequisites:"),
    workflow.indexOf("daily-canary:"),
  );
  assert.match(
    livePrerequisites,
    /inputs\.cadence == 'release'/,
  );
  assert.match(
    workflow,
    /npm run data:rollback-after-canary --/,
  );
  assert.match(
    workflow,
    /git -C "\$channel_root" add channels quarantines/,
  );
  for (const canaryId of LIVE_CANARY_IDS) {
    assert.ok(
      workflow.includes(`- ${canaryId}`),
      `${canaryId} is missing from the daily rotation`,
    );
  }
  const dailyWorkflow = workflow.slice(
    workflow.indexOf("daily-canary:"),
    workflow.indexOf("weekly-rotation:"),
  );
  assert.doesNotMatch(dailyWorkflow, /continue-on-error/);
  assert.doesNotMatch(
    dailyWorkflow,
    /renamed-mirror|--tier live --faction/,
  );
  assert.doesNotMatch(
    dailyWorkflow,
    /--verified-catalogue-drift-diagnostic/,
  );
  const releaseQuality = workflow.slice(
    workflow.indexOf("release-quality:"),
    workflow.indexOf("release-tessera-smoke:"),
  );
  assert.match(releaseQuality, /npm run verify/);
  const releaseSmoke = workflow.slice(
    workflow.indexOf("release-tessera-smoke:"),
    workflow.indexOf("release-certification:"),
  );
  assert.match(
    releaseSmoke,
    /--canary death-guard-vs-orks-exact-1000/,
  );
  assert.match(
    releaseSmoke,
    /needs:\s+- post-activation-bundle\s+- live-release-prerequisites\s+- release-quality/,
  );
  assert.match(
    releaseSmoke,
    /--verified-catalogue-drift-diagnostic/,
  );
  assert.match(releaseSmoke, /--require-live/);
  assert.match(
    releaseSmoke,
    /\.certification\/release-smoke/,
  );
  const releaseCertification = workflow.slice(
    workflow.indexOf("release-certification:"),
  );
  assert.match(
    releaseCertification,
    /needs:\s+- release-tessera-smoke/,
  );
});

test("bundle-provider preflight failures emit checksummed unavailable release evidence", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-preflight-"),
  );
  try {
    const trustedKeysFile = path.join(
      root,
      "trusted-keys.json",
    );
    await writeFile(
      trustedKeysFile,
      `${JSON.stringify({ schemaVersion: 1, keys: [] })}\n`,
    );
    const expectedBundleId = "a".repeat(64);
    const command = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("scripts", "live-canary.ts"),
        "--canary",
        "death-guard-vs-orks-exact-1000",
        "--out-dir",
        root,
        "--expected-bundle-id",
        expectedBundleId,
        "--verified-catalogue-drift-diagnostic",
        "--require-live",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          ROSTERPILOT_CERTIFICATION_LIVE: "1",
          ROSTERPILOT_DATA_TRUSTED_KEYS_FILE:
            trustedKeysFile,
        },
      },
    );
    assert.equal(
      command.status,
      2,
      command.stderr || command.stdout,
    );
    const canaryDirectory = path.join(
      root,
      "death-guard-vs-orks-exact-1000",
    );
    const filenames = await readdir(canaryDirectory);
    const reportName = filenames.find(
      (filename) =>
        filename.endsWith(".json") &&
        !filename.endsWith(".sha256"),
    );
    assert.ok(reportName);
    const reportContent = await readFile(
      path.join(canaryDirectory, reportName),
      "utf8",
    );
    const report = JSON.parse(reportContent);
    assert.equal(report.status, "unavailable");
    assert.equal(report.evidenceKind, "none");
    assert.equal(
      report.failure?.code,
      "LIVE_CANARY_DATA_PROVIDER_UNAVAILABLE",
    );
    assert.deepEqual(report.releaseEvidence, {
      kind: "bundle-bound",
      expectedBundleId,
    });
    const checksum = crypto
      .createHash("sha256")
      .update(reportContent)
      .digest("hex");
    assert.equal(
      await readFile(
        path.join(canaryDirectory, `${reportName}.sha256`),
        "utf8",
      ),
      `${checksum}  ${reportName}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("require-live refuses unbound release evidence and still writes a report", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-unbound-"),
  );
  try {
    const command = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("scripts", "live-canary.ts"),
        "--canary",
        "death-guard-vs-orks-exact-1000",
        "--out-dir",
        root,
        "--require-live",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          ROSTERPILOT_CERTIFICATION_LIVE: "1",
        },
      },
    );
    assert.equal(
      command.status,
      2,
      command.stderr || command.stdout,
    );
    const canaryDirectory = path.join(
      root,
      "death-guard-vs-orks-exact-1000",
    );
    const reportName = (await readdir(canaryDirectory)).find(
      (filename) => filename.endsWith(".json"),
    );
    assert.ok(reportName);
    const report = JSON.parse(
      await readFile(
        path.join(canaryDirectory, reportName),
        "utf8",
      ),
    );
    assert.equal(report.status, "unavailable");
    assert.equal(
      report.failure?.code,
      "LIVE_CANARY_RELEASE_BUNDLE_REQUIRED",
    );
    assert.deepEqual(report.releaseEvidence, {
      kind: "ad-hoc",
      expectedBundleId: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live canary requests route through durable stress and exact modes", () => {
  const custodes = builtRoster(
    "adeptus-custodes",
    2_000,
  );
  const deathGuard = builtRoster("death-guard", 1_000);
  const orks = builtRoster("orks", 1_000);
  const preview = {
    previewKind: "tessera-stress-portfolio",
  } as unknown as TesseraStressPortfolioPreview;

  const stress = createLiveCanaryRunRequest({
    id: "custodes-vs-adaptive-nine-aeldari-2000",
    playerRoster: custodes,
    portfolioPreview: preview,
    profilePolicyPath: "/fixtures/policy.json",
  });
  assert.equal(stress.kind, "stress");
  assert.equal(stress.factionId, "aeldari");
  assert.equal(stress.options?.suite, "diverse-9");
  assert.equal(stress.options?.analysisStrategy, "staged");
  assert.equal(stress.options?.executionMode, "simulate");
  assert.equal(stress.options?.experimental, false);
  assert.equal(stress.options?.catalogueDriftMode, "reject");
  assert.equal(stress.options?.portfolioPreview, preview);

  const exact = createLiveCanaryRunRequest({
    id: "death-guard-vs-orks-exact-1000",
    playerRoster: deathGuard,
    opponentRoster: orks,
    profilePolicyPath: "/fixtures/policy.json",
  });
  assert.equal(exact.kind, "exact");
  assert.equal(exact.opponent.kind, "roster");
  if (exact.opponent.kind === "roster") {
    assert.equal(exact.opponent.roster.factionId, "orks");
  }
  assert.notEqual(
    exact.playerRoster.factionId,
    exact.opponent.kind === "roster"
      ? exact.opponent.roster.factionId
      : exact.playerRoster.factionId,
  );
  assert.equal(exact.options?.catalogueDriftMode, "reject");

  const diagnosticExact = createLiveCanaryRunRequest({
    id: "death-guard-vs-orks-exact-1000",
    playerRoster: deathGuard,
    opponentRoster: orks,
    profilePolicyPath: "/fixtures/policy.json",
    catalogueDriftMode: "diagnostic",
  });
  assert.equal(
    diagnosticExact.options?.catalogueDriftMode,
    "diagnostic",
  );

  const uploaded = createLiveCanaryRunRequest({
    id: "uploaded-multiprofile-exact-paired-revision",
    playerRoster: deathGuard,
    opponentRosterContext: orks,
    opponentRoszPath: "/fixtures/opponent.rosz",
    profilePolicyPath: "/fixtures/policy.json",
  });
  assert.equal(uploaded.kind, "exact");
  assert.deepEqual(uploaded.opponent, {
    kind: "rosz",
    path: "/fixtures/opponent.rosz",
  });
  assert.equal(
    uploaded.options?.opponentRosterContext,
    orks,
  );
  assert.equal(
    uploaded.options?.catalogueDriftMode,
    "reject",
  );
});

test("readiness is explicit about missing live authority, runtime, credentials, and fixtures", () => {
  const definition = liveCanaryDefinition(
    "uploaded-multiprofile-exact-paired-revision",
  );
  const requiredPaths = Object.fromEntries(
    definition.requiredPathEnvironment.map((requirement) => [
      requirement,
      {
        configured: false,
        readable: false,
        basename: null,
      },
    ]),
  );
  const readiness = evaluateLiveCanaryReadiness({
    definition,
    liveOptIn: false,
    platform: "linux",
    expectedProjectDirectory: "/repo",
    runtime,
    agentStatus: null,
    requiredPaths,
  });
  assert.equal(readiness.status, "unavailable");
  const codes = new Set(
    readiness.reasons.map((reason) => reason.code),
  );
  assert.ok(codes.has("LIVE_OPT_IN_REQUIRED"));
  assert.ok(codes.has("LIVE_MACOS_REQUIRED"));
  assert.ok(codes.has("LIVE_REQUIRED_PATH_UNSET"));
  assert.ok(codes.has("LIVE_LOCAL_AGENT_UNAVAILABLE"));
  assert.equal(
    readiness.reasons.filter(
      (reason) =>
        reason.code === "LIVE_REQUIRED_PATH_UNSET",
    ).length,
    definition.requiredPathEnvironment.length,
  );
});

test("readiness becomes ready only for the current Mac runtime and both providers", () => {
  const definition = liveCanaryDefinition(
    "custodes-vs-adaptive-nine-aeldari-2000",
  );
  const readiness = evaluateLiveCanaryReadiness({
    definition,
    liveOptIn: true,
    platform: "darwin",
    expectedProjectDirectory: "/repo",
    runtime,
    agentStatus: readyAgent("/repo"),
    requiredPaths: {
      [LIVE_CANARY_PROFILE_POLICY_ENV]: {
        configured: true,
        readable: true,
        basename: "policy.json",
      },
    },
  });
  assert.equal(readiness.status, "ready");
  assert.deepEqual(readiness.reasons, []);
});

test("an unavailable canary never starts a durable job or claims a live pass", async () => {
  let starts = 0;
  const report = await runRotatingLiveCanary(
    {
      canaryId:
        "custodes-vs-adaptive-nine-aeldari-2000",
      outputDirectory: "/unused",
      environment: {
        NODE_ENV: "test",
      },
    },
    {
      getRuntime: () => runtime,
      getAgentStatus: async () => {
        throw new Error("fixture agent unavailable");
      },
      startRun: async (...args) => {
        starts += 1;
        throw new Error(
          `unexpected start ${JSON.stringify(args)}`,
        );
      },
    },
  );
  assert.equal(starts, 0);
  assert.equal(report.status, "unavailable");
  assert.equal(report.livePass, false);
  assert.equal(report.evidenceKind, "none");
  assert.ok(
    report.assertions.every(
      (assertion) => assertion.status === "not-run",
    ),
  );
  assert.ok(
    report.readiness.reasons.some(
      (reason) =>
        reason.code === "LIVE_LOCAL_AGENT_UNAVAILABLE",
    ),
  );
});

test("an expected bundle mismatch stops before any durable live mutation", async () => {
  let starts = 0;
  const report = await runRotatingLiveCanary(
    {
      canaryId:
        "custodes-vs-adaptive-nine-aeldari-2000",
      outputDirectory: "/unused",
      expectedBundleId: "a".repeat(64),
      environment: {
        NODE_ENV: "test",
      },
    },
    {
      getRuntime: () => runtime,
      getActiveBundleManifest: () => null,
      getAgentStatus: async () => {
        throw new Error("fixture agent unavailable");
      },
      startRun: async (...args) => {
        starts += 1;
        throw new Error(
          `unexpected start ${JSON.stringify(args)}`,
        );
      },
    },
  );
  assert.equal(starts, 0);
  assert.equal(report.status, "fail");
  assert.equal(
    report.failure?.code,
    "LIVE_CANARY_DATA_BUNDLE_MISMATCH",
  );
  assert.equal(report.dataBundle, null);
});

test("live-canary reports are emitted with a detached checksum", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-canary-"),
  );
  try {
    const report = await runRotatingLiveCanary(
      {
        canaryId:
          "death-guard-vs-orks-exact-1000",
        outputDirectory: root,
        environment: {
          NODE_ENV: "test",
        },
      },
      {
        getRuntime: () => runtime,
        getAgentStatus: async () => {
          throw new Error("fixture agent unavailable");
        },
      },
    );
    const written =
      await writeRotatingLiveCanaryReport(report, root);
    const content = await readFile(written.reportPath);
    const checksum = await readFile(
      written.checksumPath,
      "utf8",
    );
    assert.equal(
      checksum,
      `${written.sha256}  ${path.basename(
        written.reportPath,
      )}\n`,
    );
    assert.equal(
      JSON.parse(content.toString("utf8")).livePass,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
