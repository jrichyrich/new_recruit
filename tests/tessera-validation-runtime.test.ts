import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRoster,
  canonicalJson,
  rosterExecutionFingerprint,
  type RosterDraftV1,
  type TesseraMatchupReport,
  type TesseraStressPortfolio,
  type TesseraStressRepresentative,
  type TesseraStressTestReport,
} from "../lib/rosterpilot";
import type {
  StartTesseraRunOptions,
  TesseraRunJob,
  TesseraRunRequest,
  TesseraRunResult,
} from "../local/tessera/jobs";
import {
  TESSERA_SCENARIO_METRICS,
  TESSERA_SCENARIO_PHASES,
} from "../local/tessera/scenario-contract";
import {
  advanceTesseraValidationWebBatch,
  createTesseraValidationRuntimeDependencies,
  readTesseraValidationWebBatch,
  verifyTesseraValidationWebBatch,
  type TesseraValidationRuntimeOptions,
} from "../local/tessera/validation-runtime";
import type {
  TesseraValidationWebLaunchRequest,
} from "../local/tessera/validation-workflow";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function valueHash(value: unknown): string {
  return hash(canonicalJson(value));
}

function roster(faction: string, name: string): RosterDraftV1 {
  const built = buildRoster({ faction, pointsLimit: 1_000, name });
  assert.ok(built.ok && built.data);
  return built.data;
}

const postures = [
  "balanced-control",
  "ranged-pressure",
  "assault-pressure",
] as const;
const compositions = ["mixed", "mass", "elite-heavy"] as const;

function portfolio(opponent: RosterDraftV1): TesseraStressPortfolio {
  const items = postures.flatMap((posture, postureIndex) =>
    compositions.map((composition, compositionIndex) => {
      const templateId = `${posture}-${composition}`;
      return {
        templateId,
        posture,
        composition,
        status: "ready" as const,
        roster: structuredClone(opponent),
        fingerprint: hash(`structural-${templateId}`),
        simulationFingerprint: hash(`simulation-${templateId}`),
        structuralDistance: postureIndex + compositionIndex / 10,
        detachmentId: `detachment-${postureIndex}`,
        allowNamedCharacters: false,
        traits: null,
        compositionEvidence: [`${posture}/${composition}`],
        containsNamedCharacter: false,
        omissionReason: null,
        warnings: [],
      };
    }),
  );
  return {
    schemaVersion: 1,
    generatorVersion: "runtime-test-v1",
    suite: "diverse-9",
    factionId: opponent.factionId,
    factionName: opponent.factionName,
    pointsLimit: 1_000,
    pointsTolerancePercent: 5,
    sourceData: opponent.sourceData,
    items,
    coverage: {
      intended: 9,
      ready: 9,
      unavailable: 0,
      representedPostures: [...postures],
      missingPostures: [],
      representedCompositions: [...compositions],
      missingCompositions: [],
      representedCells: items.map((item) => ({
        templateId: item.templateId,
        posture: item.posture,
        composition: item.composition,
      })),
      missingCells: [],
      uniqueSimulationPayloads: 9,
      namedCharacterCoverage: false,
      namedCharacterCoverageStatus: "not-applicable",
      namedCharacterCoverageReason: null,
      maximumResultStatus: "complete",
    },
  };
}

function representatives(): TesseraStressRepresentative[] {
  return [
    {
      kind: "stress",
      templateId: "balanced-control-mixed",
      rationale: "Highest retained local risk.",
    },
    {
      kind: "central",
      templateId: "ranged-pressure-mass",
      rationale: "Central retained local result.",
    },
    {
      kind: "contrast",
      templateId: "assault-pressure-elite-heavy",
      rationale: "Contrasting retained local result.",
    },
  ];
}

function scenarios(opponentName: string) {
  return TESSERA_SCENARIO_PHASES.flatMap((phase) =>
    (["player-to-opponent", "opponent-to-player"] as const).flatMap(
      (direction) =>
        TESSERA_SCENARIO_METRICS.map((metric) => ({
          scenarioId: `${phase}-${direction}-${metric}`,
          opponentName,
          phase,
          direction,
          metrics: [metric],
          metricRuns: [
            {
              metric,
              iterations: 10_000,
              settings: { provider: "fixture" },
              matrixSha256: hash(`${opponentName}-${phase}-${direction}-${metric}`),
              integrity: {
                status: "trusted" as const,
                issueCodes: [],
                aliasedScenarioIds: [],
              },
            },
          ],
          iterations: 10_000,
          settings: { provider: "fixture" },
          cells: [],
          status: "complete" as const,
          warnings: [],
        })),
    ),
  );
}

function exactReport(
  player: RosterDraftV1,
  opponent: RosterDraftV1,
): TesseraMatchupReport {
  const playerFingerprint = rosterExecutionFingerprint(player);
  const opponentFingerprint = rosterExecutionFingerprint(opponent);
  return {
    schemaVersion: 4,
    runId: `report-${hash(opponent.name).slice(0, 12)}`,
    generatedAt: "2026-08-03T12:00:00.000Z",
    source: "tessera-ui",
    status: "complete",
    providerCompatibility: {
      complete: true,
      envelopeSha256: hash(`envelope-${opponentFingerprint}`),
    },
    player: {
      fingerprint: playerFingerprint,
    },
    opponents: [
      {
        rosterName: opponent.name,
        fingerprint: opponentFingerprint,
      },
    ],
    simulation: {
      requested: true,
      experimental: true,
      status: "complete",
      selectedBackend: "website",
      providerEvidence: {
        schemaVersion: 1,
        deployment: {
          identitySha256: hash("shared-deployment"),
          declaredVersion: "fixture",
          assets: [],
          complete: true,
          completeness: "complete",
          declarationSha256: hash("declaration"),
          incompleteReasons: [],
        },
        importSemantics: {
          combinedSha256: hash(`combined-${opponentFingerprint}`),
          playerSha256: hash("shared-player-semantics"),
          opponentSha256: hash(`opponent-${opponentFingerprint}`),
          complete: true,
          completeness: "complete",
          unresolvedEffectCount: 0,
          playerSnapshot: null,
          opponentSnapshot: null,
          stateBindings: {
            player: { stateSha256: hash("player-state") },
            opponent: { stateSha256: hash(`state-${opponentFingerprint}`) },
          },
          incompleteReasons: [],
        },
      },
      settings: {},
      matrices: [],
      scenarios: scenarios(opponent.name),
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    limitations: [],
    warnings: [],
    artifacts: [],
  } as unknown as TesseraMatchupReport;
}

function localReport(
  frozen: TesseraStressPortfolio,
  player: RosterDraftV1,
  opponent: RosterDraftV1,
): TesseraStressTestReport {
  const child = exactReport(player, opponent);
  child.source = "tessera-local-engine";
  child.simulation.selectedBackend = "local-engine";
  delete child.simulation.providerEvidence;
  const proxyRuns = frozen.items.map((item) => ({
    templateId: item.templateId,
    settings: {},
    iterations: [10_000],
    scenarios: scenarios(opponent.name).map((scenario) => ({
      phase: scenario.phase,
      direction: scenario.direction,
      metric: scenario.metrics[0],
      settings: scenario.settings,
      iterations: scenario.iterations,
      matrixSha256: scenario.metricRuns?.[0]?.matrixSha256,
    })),
  }));
  return {
    schemaVersion: 4,
    reportKind: "tessera-stress-test",
    runId: "local-report-run",
    generatedAt: "2026-08-03T12:00:00.000Z",
    source: "tessera-local-engine",
    status: "complete",
    statusExplanation: "Fixture local evidence is complete.",
    simulation: {
      requested: true,
      status: "complete",
      selectedBackend: "local-engine",
      engine: "tessera-engine",
      trustedMatrices: 144,
    },
    integrity: { status: "verified", issues: [] },
    recovery: {
      manifest: "fixture-manifest.json",
      screeningAttempts: 1,
      deepDiveAttempts: 1,
      exhaustedTemplates: [],
      nextActions: [],
      verifiedPreparedPlayer: true,
      verifiedPreparedOpponents: 9,
    },
    player: { fingerprint: rosterExecutionFingerprint(player) },
    opponentFactionId: frozen.factionId,
    configuration: {
      suite: "diverse-9",
      analysisStrategy: "full-all",
    },
    suite: "diverse-9",
    portfolioSha256: valueHash(frozen),
    portfolio: frozen,
    frozenOpponentArtifacts: frozen.items.map((item) => ({
      templateId: item.templateId,
      rosterFingerprint: rosterExecutionFingerprint(opponent),
      enrichedRoszPath: `${item.templateId}.json`,
      sha256: hash(item.templateId),
    })),
    stageProvenance: {
      screening: {
        analysisMode: "full",
        phases: [...TESSERA_SCENARIO_PHASES],
        metrics: [...TESSERA_SCENARIO_METRICS],
        directions: ["player-to-opponent", "opponent-to-player"],
        settings: {},
        iterations: [10_000],
        profilePolicyHash: null,
        proxyRuns,
      },
      deepDive: {
        analysisMode: "full",
        phases: [...TESSERA_SCENARIO_PHASES],
        metrics: [...TESSERA_SCENARIO_METRICS],
        directions: ["player-to-opponent", "opponent-to-player"],
        settings: {},
        iterations: [10_000],
        profilePolicyHash: null,
        proxyRuns,
      },
    },
    screeningReport: child,
    deepDiveReport: child,
    representatives: representatives(),
    robustness: null,
    missionReadiness: {},
    findings: [],
    changeCandidates: [],
    limitations: [],
    warnings: [],
    artifacts: [],
  } as unknown as TesseraStressTestReport;
}

function jobFixture(input: {
  runId: string;
  requestPath: string;
  status: TesseraRunJob["status"];
  resultSha256?: string;
  manifestPath?: string | null;
  startedAt?: string | null;
  errorCode?: string | null;
}): TesseraRunJob {
  return {
    schemaVersion: 1,
    jobKind: "rosterpilot-tessera-run",
    runId: input.runId,
    runKind: "exact",
    status: input.status,
    attempt: 1,
    startedAt: input.startedAt ?? null,
    error: input.errorCode
      ? { code: input.errorCode, message: "fixture", retryable: false }
      : null,
    requestPath: input.requestPath,
    requestSha256: hash(`request-${input.runId}`),
    manifestPath: input.manifestPath ?? null,
    artifactReceipts: input.resultSha256
      ? [
          {
            kind: "result",
            attempt: 1,
            path: "result.json",
            sha256: input.resultSha256,
          },
          ...(input.manifestPath
            ? [
                {
                  kind: "workflow-manifest" as const,
                  attempt: 1,
                  path: "stress-manifest.json",
                  sha256: hash("manifest"),
                },
              ]
            : []),
        ]
      : [],
  } as unknown as TesseraRunJob;
}

async function runtimeHarness(root: string) {
  const player = roster("adeptus-custodes", "Runtime Player");
  const opponent = roster("aeldari", "Runtime Opponent");
  const frozen = portfolio(opponent);
  const stress = localReport(frozen, player, opponent);
  const manifestPath = path.join(root, "local-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 8,
      reportKind: "tessera-stress-manifest",
      runId: stress.runId,
      portfolioSha256: stress.portfolioSha256,
      configuration: { analysisStrategy: "full-all" },
    })}\n`,
  );
  const localResult = {
    ok: true,
    data: stress,
    violations: [],
    warnings: [],
  } as TesseraRunResult;
  const localJob = jobFixture({
    runId: "local-run",
    requestPath: "local-job",
    status: "complete",
    resultSha256: hash(canonicalJson(localResult)),
    manifestPath,
    startedAt: "2026-08-03T12:00:00.000Z",
  });
  const exacts = new Map<
    string,
    { job: TesseraRunJob; result: TesseraRunResult; launched: boolean }
  >();
  const launches: Array<{
    request: TesseraRunRequest;
    options: StartTesseraRunOptions;
  }> = [];
  const closedNewRecruit: string[] = [];
  const closedTessera: string[] = [];
  const progress = {
    phase: "complete" as const,
    completedWork: 1,
    totalWork: 1,
    elapsedMs: 0,
    estimatedRemainingMs: 0,
    estimateSource: "terminal" as const,
  };
  let exactNumber = 0;
  const options: TesseraValidationRuntimeOptions = {
    storeRoot: path.join(root, "workflows"),
    runRoot: path.join(root, "runs"),
    async startRun(request, startOptions = {}) {
      launches.push({ request: structuredClone(request), options: startOptions });
      assert.equal(request.kind, "exact");
      assert.equal(request.opponent.kind, "roster");
      exactNumber += 1;
      const runId = `exact-${exactNumber}`;
      const requestPath = path.join(
        startOptions.outputDirectory ?? root,
        `run-${runId}`,
        "tessera-run.json",
      );
      const report = exactReport(player, request.opponent.roster);
      const result = {
        ok: true,
        data: report,
        violations: [],
        warnings: [],
      } as TesseraRunResult;
      const job = jobFixture({
        runId,
        requestPath,
        status: "complete",
        resultSha256: hash(canonicalJson(result)),
        startedAt: "2026-08-03T12:00:00.000Z",
      });
      exacts.set(requestPath, { job, result, launched: false });
      return { ...job, status: "queued", artifactReceipts: [] };
    },
    async getRunStatus(jobPath) {
      if (jobPath === "local-job") {
        return {
          job: localJob,
          result: localResult,
          progress,
        } as Awaited<ReturnType<NonNullable<TesseraValidationRuntimeOptions["getRunStatus"]>>>;
      }
      const exact = exacts.get(jobPath);
      assert.ok(exact);
      if (!exact.launched) {
        return {
          job: {
            ...exact.job,
            status: "queued",
            startedAt: null,
            artifactReceipts: [],
          },
          result: null,
          progress,
        } as Awaited<ReturnType<NonNullable<TesseraValidationRuntimeOptions["getRunStatus"]>>>;
      }
      return {
        job: exact.job,
        result: exact.result,
        progress,
      } as Awaited<ReturnType<NonNullable<TesseraValidationRuntimeOptions["getRunStatus"]>>>;
    },
    async resumeRun(jobPath) {
      const exact = exacts.get(jobPath);
      assert.ok(exact);
      exact.launched = true;
      return {
        ...exact.job,
        status: "running",
        artifactReceipts: [],
      };
    },
    async closeNewRecruitSession(sessionId) {
      closedNewRecruit.push(sessionId);
      return { action: "close", applied: true };
    },
    async closeTesseraSession(sessionId) {
      closedTessera.push(sessionId);
      return { closed: true };
    },
    now: () => "2026-08-03T12:00:00.000Z",
  };
  const request: TesseraValidationWebLaunchRequest = {
    workflowId: "runtime-workflow",
    playerFingerprint: rosterExecutionFingerprint(player),
    playerRoster: player,
    profilePolicy: null,
    portfolio: frozen,
    portfolioPreview: null,
    portfolioSha256: valueHash(frozen),
    batchKind: "representative-three",
    templateIds: representatives().map((entry) => entry.templateId),
    representativeTemplateIds: representatives().map(
      (entry) => entry.templateId,
    ),
    localJob: { jobId: "local-job", runId: "local-run" },
    successorOf: null,
    metrics: "full-supported",
    comparisonMode: "diagnostic-cross-provider",
    expectedCaptureCount: 48,
  };
  return {
    options,
    request,
    player,
    opponent,
    frozen,
    launches,
    closedNewRecruit,
    closedTessera,
    exacts,
  };
}

test("local validation launches one frozen diverse-nine full-all job", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "tessera-validation-runtime-local-"),
  );
  try {
    const harness = await runtimeHarness(root);
    let capturedRequest: TesseraRunRequest | null = null;
    const options: TesseraValidationRuntimeOptions = {
      ...harness.options,
      async startRun(request, startOptions = {}) {
        capturedRequest = structuredClone(request);
        return jobFixture({
          runId: "frozen-local-run",
          requestPath: path.join(
            startOptions.outputDirectory ?? root,
            "run-frozen-local",
            "tessera-run.json",
          ),
          status: "queued",
        });
      },
    };
    const dependencies = createTesseraValidationRuntimeDependencies(options);
    const preview = {
      schemaVersion: 1 as const,
      previewKind: "tessera-stress-portfolio" as const,
      generatedAt: "2026-08-03T12:00:00.000Z",
      portfolio: harness.frozen,
      items: [],
      gates: {},
      warnings: [],
    } as unknown as NonNullable<
      Parameters<
        typeof dependencies.launchLocalNine
      >[0]["portfolioPreview"]
    >;
    const reference = await dependencies.launchLocalNine({
      workflowId: "local-runtime-workflow",
      playerFingerprint: rosterExecutionFingerprint(harness.player),
      playerRoster: harness.player,
      profilePolicy: null,
      portfolio: harness.frozen,
      portfolioPreview: preview,
      portfolioSha256: valueHash(harness.frozen),
      templateIds: harness.frozen.items.map((item) => item.templateId),
      suite: "diverse-9",
      analysisStrategy: "full-all",
      metrics: "full-supported",
    });

    assert.equal(reference.runId, "frozen-local-run");
    const observed = capturedRequest as TesseraRunRequest | null;
    assert.ok(observed);
    assert.equal(observed.kind, "stress");
    assert.equal(observed.options?.simulationBackend, "local-engine");
    assert.equal(observed.options?.executionMode, "simulate");
    assert.equal(observed.options?.suite, "diverse-9");
    assert.equal(observed.options?.analysisStrategy, "full-all");
    assert.equal(
      valueHash(observed.options?.portfolioPreview?.portfolio),
      valueHash(harness.frozen),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Web validation runs exact jobs serially in one shared session", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "tessera-validation-runtime-"),
  );
  try {
    const harness = await runtimeHarness(root);
    const dependencies = createTesseraValidationRuntimeDependencies(
      harness.options,
    );
    const reference = await dependencies.launchWebBatch(harness.request);

    for (let expectedLaunches = 1; expectedLaunches <= 3; expectedLaunches += 1) {
      const launched = await advanceTesseraValidationWebBatch(
        reference,
        harness.options,
      );
      assert.equal(harness.launches.length, expectedLaunches);
      assert.equal(launched.exactJobs.length, expectedLaunches);
      assert.equal(launched.completedTemplateIds.length, expectedLaunches - 1);

      const resumed = await advanceTesseraValidationWebBatch(
        reference,
        harness.options,
      );
      assert.equal(harness.launches.length, expectedLaunches);
      assert.equal(resumed.completedTemplateIds.length, expectedLaunches - 1);

      const completed = await advanceTesseraValidationWebBatch(
        reference,
        harness.options,
      );
      assert.equal(completed.completedTemplateIds.length, expectedLaunches);
    }

    const final = await readTesseraValidationWebBatch(
      reference,
      harness.options,
    );
    assert.equal(final.status, "inconclusive");
    assert.equal(final.trustedEvidence, true);
    assert.equal(final.capturedScenarioCount, 48);
    assert.equal(final.requiresSuccessor, false);
    assert.equal(harness.closedNewRecruit.length, 1);
    assert.equal(harness.closedTessera.length, 1);
    assert.equal(
      new Set(
        harness.launches.map((entry) =>
          entry.request.kind === "exact"
            ? entry.request.options?.sessionId
            : null,
        ),
      ).size,
      1,
    );
    for (const launch of harness.launches) {
      assert.equal(launch.request.kind, "exact");
      assert.deepEqual(
        launch.request.options?.phases,
        TESSERA_SCENARIO_PHASES,
      );
      assert.deepEqual(
        launch.request.options?.metrics,
        TESSERA_SCENARIO_METRICS,
      );
      assert.equal(launch.request.options?.simulationBackend, "website");
    }
    const verification = await verifyTesseraValidationWebBatch(
      reference,
      harness.options,
    );
    assert.equal(verification.revisionCount, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unsafe exact-job failure stops the batch and requires a successor", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "tessera-validation-runtime-failure-"),
  );
  try {
    const harness = await runtimeHarness(root);
    const originalGet = harness.options.getRunStatus!;
    harness.options.getRunStatus = async (jobPath, includeResult) => {
      if (jobPath === "local-job") {
        return originalGet(jobPath, includeResult);
      }
      const original = await originalGet(jobPath, includeResult);
      if (original.job.status === "queued") return original;
      const exact = harness.exacts.get(jobPath);
      assert.ok(exact);
      return {
        job: {
          ...exact.job,
          status: "failed",
          error: {
            code: "NEW_RECRUIT_MUTATION_OUTCOME_UNKNOWN",
            message: "fixture",
            retryable: false,
          },
        },
        result: null,
        progress: {
          phase: "stopped",
          completedWork: 0,
          totalWork: 1,
          elapsedMs: 0,
          estimatedRemainingMs: 0,
          estimateSource: "terminal",
        },
      } as Awaited<ReturnType<NonNullable<TesseraValidationRuntimeOptions["getRunStatus"]>>>;
    };
    const dependencies = createTesseraValidationRuntimeDependencies(
      harness.options,
    );
    const reference = await dependencies.launchWebBatch(harness.request);
    await advanceTesseraValidationWebBatch(reference, harness.options);
    await advanceTesseraValidationWebBatch(reference, harness.options);
    const failed = await advanceTesseraValidationWebBatch(
      reference,
      harness.options,
    );

    assert.equal(failed.status, "failed");
    assert.equal(failed.requiresSuccessor, true);
    assert.equal(failed.errorCode, "NEW_RECRUIT_MUTATION_OUTCOME_UNKNOWN");
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.closedNewRecruit.length, 1);
    assert.equal(harness.closedTessera.length, 1);

    harness.options.getRunStatus = originalGet;
    const successorDependencies =
      createTesseraValidationRuntimeDependencies(harness.options);
    const successor = await successorDependencies.launchWebBatch({
      ...harness.request,
      successorOf: reference,
    });
    await advanceTesseraValidationWebBatch(successor, harness.options);
    assert.equal(harness.launches.length, 2);
    assert.equal(harness.launches[1].options.supersedesRunId, "exact-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed Web batch head seal is rejected", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "tessera-validation-runtime-tamper-"),
  );
  try {
    const harness = await runtimeHarness(root);
    const dependencies = createTesseraValidationRuntimeDependencies(
      harness.options,
    );
    const reference = await dependencies.launchWebBatch(harness.request);
    const tampered = JSON.parse(
      await readFile(reference.jobId, "utf8"),
    ) as Record<string, unknown>;
    tampered.sequence = 99;
    await writeFile(reference.jobId, `${JSON.stringify(tampered)}\n`);

    await assert.rejects(
      verifyTesseraValidationWebBatch(reference, harness.options),
      /head seal is invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
