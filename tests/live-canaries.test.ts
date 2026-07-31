import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
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
  for (const canaryId of LIVE_CANARY_IDS) {
    assert.ok(
      workflow.includes(`- ${canaryId}`),
      `${canaryId} is missing from the daily rotation`,
    );
  }
  assert.doesNotMatch(
    workflow.slice(
      workflow.indexOf("daily-canary:"),
      workflow.indexOf("weekly-rotation:"),
    ),
    /renamed-mirror|--tier live --faction/,
  );
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
