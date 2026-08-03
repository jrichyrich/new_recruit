import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
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
  validateRoster,
  type RuntimeProvenance,
  type RosterDraftV1,
  type TesseraFrozenScenarioContract,
  type TesseraMatchupReport,
  type TesseraStressPortfolioPreview,
} from "../lib/rosterpilot";
import type { LocalAgentStatus } from "../local/agent/contracts";
import { projectRoot } from "../local/agent/paths";
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
import type {
  TesseraRunJob,
  TesseraRunRequest,
  TesseraRunResult,
} from "../local/tessera/jobs";
import {
  aggregateProfileRequirements,
} from "../local/tessera/profile-policy";
import type {
  RunTesseraProviderParityWorkflowResult,
} from "../local/tessera/provider-parity-workflow";
import {
  tesseraScenarioContractSha256,
} from "../local/tessera/scenario-contract";

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
    protocolVersion: 11,
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

function distinctCanaryRosters(): {
  player: RosterDraftV1;
  opponent: RosterDraftV1;
} {
  const player = buildRoster({
    faction: "death-guard",
    pointsLimit: 1_000,
    name: "Live Canary Death Guard 1000",
    allowNamedCharacters: false,
    collectionUnitIds: [
      "daemon-prince-of-nurgle-with-wings",
      "daemon-prince-of-nurgle",
      "icon-bearer",
      "plague-surgeon",
      "biologus-putrifier",
      "malignant-plaguecaster",
      "noxious-blightbringer",
      "tallyman",
      "foul-blightspawn",
      "lord-of-poxes",
      "chaos-spawn",
      "poxwalkers",
      "lord-of-virulence",
      "lord-of-contagion",
    ],
  });
  const opponent = buildRoster({
    faction: "orks",
    pointsLimit: 1_000,
    name: "Live Canary Orks 1000",
  });
  assert.equal(player.ok, true);
  assert.equal(opponent.ok, true);
  assert.ok(player.data);
  assert.ok(opponent.data);
  return {
    player: player.data,
    opponent: opponent.data,
  };
}

async function writeDistinctCanaryPolicy(
  root: string,
  rosters: ReturnType<typeof distinctCanaryRosters>,
): Promise<string> {
  const policyPath = path.join(root, "profile-policy.json");
  const entries = aggregateProfileRequirements([
    rosters.player,
    rosters.opponent,
  ]).map((requirement) => ({
    faction: requirement.faction,
    unit: requirement.unit,
    unitOccurrence: requirement.unitOccurrence,
    modelCount: requirement.modelCount,
    weaponGroup: requirement.weaponGroup,
    phase: requirement.phase,
    selectedProfile: requirement.availableProfiles[0],
    activeCount: requirement.activeCount,
  }));
  assert.ok(
    entries.every((entry) => entry.selectedProfile),
  );
  await writeFile(
    policyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries,
    })}\n`,
  );
  return policyPath;
}

function websiteScenarioContract(): TesseraFrozenScenarioContract[] {
  return (["player-to-opponent", "opponent-to-player"] as const)
    .flatMap((direction) =>
      ([
        "wipe-probability",
        "half-wipe-probability",
        "mean-kills",
        "mean-damage",
      ] as const).map((metric) => ({
        phase: "shooting" as const,
        direction,
        metric,
        settings: {
          provider: "website",
          "Target in cover": "No",
          "Attacker charging": "Off",
          "Rapid fire range": "false",
          "Melta range": "0",
          Stationary: "disabled",
          "Indirect fire": "No",
        },
        iterations: 10_000,
      })),
    );
}

function exactCanaryReport(input: {
  provider: "local-engine" | "website";
  runId: string;
  reportPath: string;
  scenarioContract: TesseraFrozenScenarioContract[];
}): TesseraMatchupReport {
  const source = input.provider === "website"
    ? "tessera-ui"
    : "tessera-local-engine";
  return {
    schemaVersion: 3,
    runId: input.runId,
    status: "complete",
    source,
    comparisonClass: "matched",
    configuration: {
      analysisMode: "full",
      phases: ["shooting"],
      directions: [
        "player-to-opponent",
        "opponent-to-player",
      ],
      metrics: [
        "wipe-probability",
        "half-wipe-probability",
        "mean-kills",
        "mean-damage",
      ],
    },
    opponents: [{ rosterName: "Live Canary Orks 1000" }],
    simulation: {
      requested: true,
      executionMode: "simulate",
      selectedBackend: input.provider,
      status: "complete",
      scenarios: ([
        "player-to-opponent",
        "opponent-to-player",
      ] as const).map((direction) => ({
        scenarioId: `shooting:${direction}`,
        opponentName: "Live Canary Orks 1000",
        phase: "shooting",
        direction,
        metrics: [
          "wipe-probability",
          "half-wipe-probability",
          "mean-kills",
          "mean-damage",
        ],
        metricRuns: [],
        iterations: 10_000,
        settings: {},
        cells: [],
        status: "complete",
        warnings: [],
      })),
    },
    scenarioContract: input.scenarioContract,
    scenarioContractSha256: tesseraScenarioContractSha256(
      input.scenarioContract,
    ),
    tesseraUiIdentity:
      input.provider === "website"
        ? "website-live-identity"
        : null,
    connectorEvents:
      input.provider === "website"
        ? [
            {
              provider: "new-recruit",
              action: "prepare",
              outcome: "verified",
            },
            {
              provider: "tessera",
              action: "simulate",
              outcome: "verified",
            },
          ]
        : [],
    artifacts: [{
      format: "matchup-json",
      written: input.reportPath,
    }],
  } as unknown as TesseraMatchupReport;
}

function fakeExactJob(input: {
  root: string;
  provider: "local-engine" | "website";
}): TesseraRunJob {
  const jobDirectory = path.join(
    input.root,
    "runs",
    input.provider,
  );
  return {
    runId: `${input.provider}-run`,
    status: "complete",
    attempt: 1,
    jobDirectory,
    requestPath: path.join(jobDirectory, "tessera-run.json"),
    manifestPath: path.join(jobDirectory, "tessera-manifest.json"),
    error: null,
  } as unknown as TesseraRunJob;
}

async function runPairedExactCanaryFixture(input: {
  root: string;
  numericalParityMode?: "observe" | "enforce";
  environmentEnforced?: boolean;
  comparison:
    | "pass"
    | "throw";
}): Promise<{
  report: Awaited<ReturnType<typeof runRotatingLiveCanary>>;
  requests: TesseraRunRequest[];
  comparisonOutputDirectory: string | null;
}> {
  const rosters = distinctCanaryRosters();
  const policyPath = await writeDistinctCanaryPolicy(
    input.root,
    rosters,
  );
  const websiteJob = fakeExactJob({
    root: input.root,
    provider: "website",
  });
  const localJob = fakeExactJob({
    root: input.root,
    provider: "local-engine",
  });
  const websiteReportPath = path.join(
    websiteJob.jobDirectory,
    "website-matchup.json",
  );
  const localReportPath = path.join(
    localJob.jobDirectory,
    "local-matchup.json",
  );
  const websiteContract = websiteScenarioContract();
  const websiteReport = exactCanaryReport({
    provider: "website",
    runId: websiteJob.runId,
    reportPath: websiteReportPath,
    scenarioContract: websiteContract,
  });
  const localReport = exactCanaryReport({
    provider: "local-engine",
    runId: localJob.runId,
    reportPath: localReportPath,
    scenarioContract: websiteContract.map((entry) => ({
      ...entry,
      settings: {
        charging: "false",
        indirectFire: "false",
        provider: "local-engine",
        remainedStationary: "false",
        targetInCover: "false",
        withinMeltaRange: "false",
        withinRapidFireRange: "false",
      },
    })),
  });
  for (const filename of [
    websiteJob.requestPath,
    websiteJob.manifestPath,
    localJob.requestPath,
    localJob.manifestPath,
    websiteReportPath,
    localReportPath,
  ].filter((filename): filename is string => filename !== null)) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, "{}\n");
  }
  const requests: TesseraRunRequest[] = [];
  let comparisonOutputDirectory: string | null = null;
  const report = await runRotatingLiveCanary(
    {
      canaryId: "death-guard-vs-orks-exact-1000",
      outputDirectory: input.root,
      profilePolicyPath: policyPath,
      numericalParityMode: input.numericalParityMode,
      providerCompatibilityMode: "observe",
      environment: {
        NODE_ENV: "test",
        ROSTERPILOT_CERTIFICATION_LIVE: "1",
        ...(input.environmentEnforced
          ? {
              ROSTERPILOT_LIVE_NUMERICAL_PARITY_ENFORCED:
                "true",
            }
          : {}),
      },
      pollMs: 1,
      maxWaitMs: 1_000,
    },
    {
      platform: "darwin",
      getRuntime: () => runtime,
      getAgentStatus: async () => readyAgent(projectRoot),
      getActiveBundleManifest: () => null,
      captureBundleTrust: async () => ({}) as never,
      build: (options) => options.faction === "death-guard"
        ? {
            ok: true,
            data: rosters.player,
            violations: [],
            warnings: [],
          }
        : {
            ok: true,
            data: rosters.opponent,
            violations: [],
            warnings: [],
          },
      validate: validateRoster,
      startRun: async (request) => {
        requests.push(request);
        return request.kind === "exact" &&
          request.options?.simulationBackend === "local-engine"
          ? localJob
          : websiteJob;
      },
      getRunStatus: async (jobPath) =>
        jobPath === localJob.requestPath
          ? {
              job: localJob,
              result: {
                ok: true,
                data: localReport,
                violations: [],
                warnings: [],
              } as TesseraRunResult,
              progress: {
                phase: "complete" as const,
                completedWork: 1,
                totalWork: 1,
                elapsedMs: 1,
                estimatedRemainingMs: 0,
                estimateSource: "terminal" as const,
              },
            }
          : {
              job: websiteJob,
              result: {
                ok: true,
                data: websiteReport,
                violations: [],
                warnings: [],
              } as TesseraRunResult,
              progress: {
                phase: "complete" as const,
                completedWork: 1,
                totalWork: 1,
                elapsedMs: 1,
                estimatedRemainingMs: 0,
                estimateSource: "terminal" as const,
              },
            },
      compareProviders: async (options) => {
        comparisonOutputDirectory =
          options.outputDirectory ?? null;
        assert.equal(options.websiteReportPath, websiteReportPath);
        assert.equal(options.localReportPath, localReportPath);
        if (input.comparison === "throw") {
          throw Object.assign(
            new Error("fixture parity unavailable"),
            { code: "FIXTURE_PARITY_UNAVAILABLE" },
          );
        }
        const outputDirectory = options.outputDirectory!;
        await mkdir(outputDirectory, { recursive: true });
        const artifacts = [
          {
            format: "provider-parity-json" as const,
            written: path.join(
              outputDirectory,
              "tessera-provider-parity.json",
            ),
          },
          {
            format: "provider-parity-html" as const,
            written: path.join(
              outputDirectory,
              "tessera-provider-parity.html",
            ),
          },
          {
            format: "provider-parity-sha256" as const,
            written: path.join(
              outputDirectory,
              "tessera-provider-parity.json.sha256",
            ),
          },
        ];
        await Promise.all(
          artifacts.map((artifact) =>
            writeFile(artifact.written, "fixture\n"),
          ),
        );
        return {
          ok: true,
          data: {
            outcome: "pass",
            classification: "parity-pass",
            parity: {
              eligible: true,
              complete: true,
            },
            artifacts,
          },
          violations: [],
          warnings: [],
        } as unknown as RunTesseraProviderParityWorkflowResult;
      },
      wait: async () => {},
    },
  );
  return { report, requests, comparisonOutputDirectory };
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
  assert.match(
    workflow,
    /rosterpilot-provider-compatibility-enforced-v1/,
  );
  assert.match(
    workflow,
    /ROSTERPILOT_PROVIDER_COMPATIBILITY_ENFORCED:/,
  );
  assert.match(
    workflow,
    /rosterpilot-live-numerical-parity-enforced-v1/,
  );
  assert.match(
    workflow,
    /ROSTERPILOT_LIVE_NUMERICAL_PARITY_ENFORCED:/,
  );
  assert.match(
    workflow,
    /npm run certify:provider-parity --[\s\S]*--expected-bundle-id[\s\S]*--expected-git-head[\s\S]*--rotation-id/,
  );
  assert.match(
    workflow,
    /npm run certify:provider-parity-rollout --[\s\S]*--current-rotation-id \$\{\{ github\.run_id \}\}[\s\S]*--enforcement-latch/,
  );
  assert.match(
    workflow,
    /live-numerical-parity-evidence-\$\{\{ github\.run_id \}\}/,
  );
  assert.match(
    workflow,
    /Download the paired exact-canary evidence bundle\s+continue-on-error: true/,
  );
  assert.match(
    workflow,
    /live-numerical-parity-rollout-\$\{\{ github\.run_id \}\}/,
  );
  assert.match(
    workflow,
    /--enforcement-latch \$\{\{/,
  );
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
    workflow.indexOf("quarantine-failed-bundle:"),
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
  const applicationRelease = await readFile(
    path.resolve(
      ".github",
      "workflows",
      "application-release.yml",
    ),
    "utf8",
  );
  assert.match(
    applicationRelease,
    /rosterpilot-provider-compatibility-enforced-v1/,
  );
  assert.match(
    applicationRelease,
    /--enforcement-latch \$\{\{ steps\.provider-compatibility-latch\.outputs\.mode \}\}/,
  );
  assert.match(
    applicationRelease,
    /live_numerical_parity_run_id:/,
  );
  assert.doesNotMatch(
    applicationRelease,
    /live_numerical_parity_(?:rollout_sha256|bundle_id):/,
  );
  assert.match(
    applicationRelease,
    /run\.path !== "\.github\/workflows\/certification-live\.yml"[\s\S]*run\.head_branch !== defaultBranch[\s\S]*run\.conclusion !== "success"[\s\S]*run\.head_sha !== context\.sha/,
  );
  assert.match(
    applicationRelease,
    /Re-certify exact live numerical parity for this release[\s\S]*--expected-bundle-id "\$bundle_id"[\s\S]*--expected-git-head "\$GITHUB_SHA"[\s\S]*--current-rotation-id "\$NUMERICAL_PARITY_RUN_ID"[\s\S]*--enforcement-latch enforce/,
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
          ROSTERPILOT_SUPPORT_DIRECTORY: root,
          ROSTERPILOT_LOCAL_UPDATE_WORKER: "1",
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
  assert.equal(stress.options?.providerCompatibilityMode, "observe");
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
  assert.equal(
    Object.hasOwn(exact.options ?? {}, "simulationBackend"),
    false,
  );
  assert.equal(
    Object.hasOwn(exact.options ?? {}, "scenarioContract"),
    false,
  );

  const diagnosticExact = createLiveCanaryRunRequest({
    id: "death-guard-vs-orks-exact-1000",
    playerRoster: deathGuard,
    opponentRoster: orks,
    profilePolicyPath: "/fixtures/policy.json",
    catalogueDriftMode: "diagnostic",
    providerCompatibilityMode: "enforce",
  });
  assert.equal(
    diagnosticExact.options?.catalogueDriftMode,
    "diagnostic",
  );
  assert.equal(
    diagnosticExact.options?.providerCompatibilityMode,
    "enforce",
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

test("the distinct-faction canary runs website first, replays locally, and records portable parity", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-provider-pair-"),
  );
  try {
    const result = await runPairedExactCanaryFixture({
      root,
      numericalParityMode: "enforce",
      comparison: "pass",
    });
    assert.equal(result.report.status, "pass");
    assert.equal(result.requests.length, 2);
    const [website, local] = result.requests;
    assert.equal(website.kind, "exact");
    assert.equal(local.kind, "exact");
    if (website.kind !== "exact" || local.kind !== "exact") return;
    assert.equal(
      website.options?.simulationBackend,
      "website",
    );
    assert.equal(
      local.options?.simulationBackend,
      "local-engine",
    );
    assert.strictEqual(
      website.playerRoster,
      local.playerRoster,
    );
    assert.equal(website.opponent.kind, "roster");
    assert.equal(local.opponent.kind, "roster");
    if (
      website.opponent.kind !== "roster" ||
      local.opponent.kind !== "roster"
    ) return;
    assert.strictEqual(
      website.opponent.roster,
      local.opponent.roster,
    );
    assert.equal(
      website.options?.profilePolicyPath,
      local.options?.profilePolicyPath,
    );
    assert.ok(local.options?.scenarioContract);
    assert.ok(
      local.options.scenarioContract.every(
        (entry) =>
          entry.settings.provider === "local-engine" &&
          entry.settings.targetInCover === "false" &&
          entry.settings.charging === "false",
      ),
    );
    assert.equal(
      result.comparisonOutputDirectory,
      path.join(root, "provider-parity"),
    );
    assert.deepEqual(result.report.providerParity, {
      policy:
        "live-numerical-parity-observe-then-enforce-v1",
      mode: "enforce",
      status: "pass",
      complete: true,
      eligible: true,
      websiteRun: {
        runId: "website-run",
        jobPath: "runs/website/tessera-run.json",
        initialAttempt: 1,
        finalAttempt: 1,
        finalStatus: "complete",
        manifestPath: "runs/website/tessera-manifest.json",
      },
      localRun: {
        runId: "local-engine-run",
        jobPath: "runs/local-engine/tessera-run.json",
        initialAttempt: 1,
        finalAttempt: 1,
        finalStatus: "complete",
        manifestPath:
          "runs/local-engine/tessera-manifest.json",
      },
      sourceReports: [
        {
          provider: "local-engine",
          reportPath:
            "runs/local-engine/local-matchup.json",
          receiptPath:
            "runs/local-engine/local-matchup.receipt.json",
        },
        {
          provider: "website",
          reportPath: "runs/website/website-matchup.json",
          receiptPath:
            "runs/website/website-matchup.receipt.json",
        },
      ],
      comparison: {
        outcome: "pass",
        classification: "parity-pass",
        jsonPath:
          "provider-parity/tessera-provider-parity.json",
        checksumPath:
          "provider-parity/tessera-provider-parity.json.sha256",
        htmlPath:
          "provider-parity/tessera-provider-parity.html",
      },
      failure: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("numerical parity is fail-open while observed and fail-closed when enforced", async () => {
  const observeRoot = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-parity-observe-"),
  );
  const enforceRoot = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-parity-enforce-"),
  );
  try {
    const observed = await runPairedExactCanaryFixture({
      root: observeRoot,
      numericalParityMode: "observe",
      comparison: "throw",
    });
    assert.equal(observed.report.status, "pass");
    assert.equal(observed.report.failure, null);
    assert.equal(
      observed.report.providerParity?.status,
      "unavailable",
    );
    assert.equal(
      observed.report.providerParity?.failure?.code,
      "FIXTURE_PARITY_UNAVAILABLE",
    );

    const enforced = await runPairedExactCanaryFixture({
      root: enforceRoot,
      environmentEnforced: true,
      comparison: "throw",
    });
    assert.equal(enforced.report.status, "fail");
    assert.equal(enforced.report.livePass, false);
    assert.equal(
      enforced.report.failure?.code,
      "LIVE_CANARY_NUMERICAL_PARITY_REQUIRED",
    );
    assert.equal(
      enforced.report.providerParity?.failure?.code,
      "FIXTURE_PARITY_UNAVAILABLE",
    );
  } finally {
    await Promise.all([
      rm(observeRoot, { recursive: true, force: true }),
      rm(enforceRoot, { recursive: true, force: true }),
    ]);
  }
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
