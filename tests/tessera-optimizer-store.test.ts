import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRoster,
  rosterExecutionFingerprint,
  type RosterDraftV1,
  type RuntimeProvenance,
  type TesseraChangeCandidate,
  type TesseraMatchupReport,
  type TesseraRevisionComparisonReport,
} from "../lib/rosterpilot";
import {
  approveAndMaterializeTesseraOptimizerCandidates,
  approveStoredTesseraOptimizerWinner,
  finalizeStoredTesseraOptimizer,
  getTesseraOptimizerStatus,
  recordStoredTesseraOptimizerComparison,
  startTesseraOptimizer,
} from "../local/tessera/optimizer-store";

const createdAt = "2026-08-01T16:00:00.000Z";

const runtime: RuntimeProvenance = {
  rosterPilotVersion: "optimizer-store-test",
  rulesPackageVersion: "optimizer-store-test",
  stressGeneratorVersion: "optimizer-store-test",
  processStartedAt: createdAt,
  gitHead: null,
  sourceFingerprintAtStart: "optimizer-store-source",
  sourceFingerprintNow: "optimizer-store-source",
  buildId: "optimizer-store-build",
  stale: false,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
};

function fixtureRoster(): RosterDraftV1 {
  const result = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Durable optimizer fixture",
    requiredUnitIds: ["shield-captain"],
  });
  assert.equal(
    result.ok,
    true,
    result.violations.map(({ message }) => message).join("\n"),
  );
  assert.ok(result.data);
  return result.data;
}

function fixtureCandidate(roster: RosterDraftV1): TesseraChangeCandidate {
  const warlord = roster.units.find((unit) => unit.isWarlord);
  assert.ok(warlord);
  return {
    candidateId: "durable-warlord-candidate",
    title: "Retain the exact warlord",
    rationale: "Deterministic persistence fixture.",
    operation: {
      type: "set-warlord",
      selectionId: warlord.selectionId,
    },
    beforePoints: roster.totalPoints,
    afterPoints: roster.totalPoints,
    rosterFingerprint: rosterExecutionFingerprint(roster),
    evidenceFindingIds: ["durable-fixture"],
  };
}

function fixtureBaseline(
  roster: RosterDraftV1,
  candidate: TesseraChangeCandidate,
): TesseraMatchupReport {
  const fingerprint = rosterExecutionFingerprint(roster);
  return {
    schemaVersion: 3,
    runId: "durable-baseline-run",
    generatedAt: createdAt,
    source: "tessera-ui",
    status: "complete",
    runtime,
    tesseraUiIdentity: "durable-tessera-ui",
    profilePolicyHash: null,
    frozenProfileRequirements: [],
    pinnedData: roster.sourceData,
    configuration: {
      analysisMode: "full",
      phases: ["shooting"],
      metrics: ["mean-damage"],
      directions: ["player-to-opponent"],
      pointsTolerancePercent: 5,
      allowPointMismatch: false,
      includeChangeCandidates: true,
    },
    player: {
      rosterId: roster.id,
      rosterName: roster.name,
      factionId: roster.factionId,
      listUrl: null,
      sourceRoszPath: "player-source.rosz",
      enrichedRoszPath: "player-enriched.rosz",
      summary: {
        rosterName: roster.name,
        factionName: roster.factionName,
      },
      fingerprint,
    } as TesseraMatchupReport["player"],
    opponents: [
      {
        kind: "rosz",
        rosterName: "Aeldari persistence fixture",
        sourceRoszPath: "opponent-source.rosz",
        enrichedRoszPath: "opponent-enriched.rosz",
        summary: {
          rosterName: "Aeldari persistence fixture",
          factionName: "Aeldari",
        },
        fingerprint: "a".repeat(64),
      } as TesseraMatchupReport["opponents"][number],
    ],
    simulation: {
      requested: true,
      executionMode: "simulate",
      experimental: false,
      status: "complete",
      engine: "tessera-ui",
      settings: { iterations: "10000" },
      scenarios: [
        {
          scenarioId: "durable-scenario",
          opponentName: "Aeldari persistence fixture",
          phase: "shooting",
          direction: "player-to-opponent",
          metrics: ["mean-damage"],
          status: "complete",
          settings: { iterations: "10000" },
          iterations: 10_000,
          cells: [],
          warnings: [],
        },
      ],
      matrices: [],
    },
    strengths: [],
    weaknesses: [],
    suggestions: ["Run the approved paired candidate."],
    findings: [],
    changeCandidates: [candidate],
    limitations: [],
    warnings: [],
    artifacts: [],
  };
}

function fixtureComparison(
  baseline: TesseraMatchupReport,
  candidate: TesseraChangeCandidate,
  baselineReportPath: string,
): TesseraRevisionComparisonReport {
  return {
    schemaVersion: 2,
    runId: "durable-comparison-run",
    generatedAt: "2026-08-01T16:03:00.000Z",
    baselineReportPath,
    baselineRunId: baseline.runId,
    revisedRosterFingerprint: candidate.rosterFingerprint,
    revisedReports: [
      {
        ...structuredClone(baseline),
        runId: "durable-revised-child",
        changeCandidates: [],
      },
    ],
    deltas: [],
    aggregates: [
      {
        metric: "mean-damage",
        direction: "player-to-opponent",
        opponentNames: ["Aeldari persistence fixture"],
        phases: ["shooting"],
        expectedScenarios: 1,
        applicableScenarios: 1,
        baselineCells: 1,
        revisedCells: 1,
        before: 4,
        after: 5,
        directionalChange: 0.25,
        materialityThreshold: 0.01,
        classification: "improved",
      },
    ],
    summary: {
      improved: 1,
      worsened: 0,
      unchanged: 0,
      ambiguous: 0,
      aggregateCounts: {
        improved: 1,
        worsened: 0,
        unchanged: 0,
        ambiguous: 0,
        applicable: 1,
        total: 1,
      },
      conclusionBasis: "trusted-roster-aggregates",
      conclusion: "improved",
    },
    limitations: [],
    warnings: [],
    artifacts: [],
  };
}

test("durable optimizer store freezes artifacts and gates every revision", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-optimizer-store-"),
  );
  try {
    const roster = fixtureRoster();
    const candidate = fixtureCandidate(roster);
    const baseline = fixtureBaseline(roster, candidate);
    const started = await startTesseraOptimizer({
      optimizerRunId: "durable-store-fixture",
      createdAt,
      baselineReport: baseline,
      baselineRoster: roster,
      evaluationRuntime: runtime,
      rootDir: temporaryRoot,
      outputDirectory: path.join(temporaryRoot, "optimizers"),
    });
    assert.equal(started.ok, true, started.violations[0]?.message);
    assert.ok(started.data);
    const statePath = started.data.statePath;
    assert.equal(started.data.state.stateRevision, 0);
    assert.equal(
      JSON.parse(
        await readFile(
          started.data.baselineReportArtifact.path,
          "utf8",
        ),
      ).runId,
      baseline.runId,
    );

    const status = await getTesseraOptimizerStatus(statePath, {
      evaluationRuntime: runtime,
    });
    assert.equal(status.ok, true, status.violations[0]?.message);

    const stale =
      await approveAndMaterializeTesseraOptimizerCandidates(
        statePath,
        {
          expectedStateRevision: 1,
          candidateIds: [candidate.candidateId],
          approvalId: "stale-batch",
          approvedBy: "fixture-user",
          evaluationRuntime: runtime,
        },
      );
    assert.equal(stale.ok, false);
    assert.equal(
      stale.violations[0]?.code,
      "TESSERA_OPTIMIZER_STALE_STATE_REVISION",
    );

    const approved =
      await approveAndMaterializeTesseraOptimizerCandidates(
        statePath,
        {
          expectedStateRevision: 0,
          candidateIds: [candidate.candidateId],
          approvalId: "durable-batch",
          approvedBy: "fixture-user",
          approvedAt: "2026-08-01T16:01:00.000Z",
          evaluationRuntime: runtime,
          qualifyCandidate: async (_baselineRoster, readiness) => ({
            roster: structuredClone(roster),
            readiness: structuredClone(readiness),
          }),
        },
      );
    assert.equal(approved.ok, true, approved.violations[0]?.message);
    assert.equal(approved.data?.state.stateRevision, 2);
    assert.equal(approved.data?.comparisonRequests.length, 1);
    assert.equal(approved.data?.candidateRosterArtifacts.length, 1);

    const compared = await recordStoredTesseraOptimizerComparison(
      statePath,
      {
        expectedStateRevision: 2,
        candidateId: candidate.candidateId,
        report: fixtureComparison(
          baseline,
          candidate,
          approved.data!.baselineReportArtifact.path,
        ),
        recordedAt: "2026-08-01T16:03:00.000Z",
        evaluationRuntime: runtime,
      },
    );
    assert.equal(compared.ok, true, compared.violations[0]?.message);
    assert.equal(compared.data?.state.stage, "pareto-ready");
    assert.equal(compared.data?.state.stateRevision, 3);
    assert.equal(compared.data?.comparisonArtifacts.length, 1);

    const winner = await approveStoredTesseraOptimizerWinner(
      statePath,
      {
        expectedStateRevision: 3,
        candidateId: candidate.candidateId,
        approvalId: "durable-winner",
        approvedBy: "fixture-user",
        approvedAt: "2026-08-01T16:04:00.000Z",
        evaluationRuntime: runtime,
      },
    );
    assert.equal(winner.ok, true, winner.violations[0]?.message);
    assert.equal(winner.data?.state.stateRevision, 4);

    const finalized = await finalizeStoredTesseraOptimizer(
      statePath,
      {
        expectedStateRevision: 4,
        deliveryIntent: {
          kind: "prepare-handoff",
          intentId: "durable-handoff-intent",
          recordedBy: "fixture-user",
          recordedAt: "2026-08-01T16:05:00.000Z",
        },
        finalizedAt: "2026-08-01T16:05:00.000Z",
        evaluationRuntime: runtime,
      },
    );
    assert.equal(finalized.ok, true, finalized.violations[0]?.message);
    assert.equal(finalized.data?.state.stage, "finalized");
    assert.ok(finalized.data?.finalRosterArtifact);
    assert.equal(
      JSON.parse(
        await readFile(
          finalized.data!.finalRosterArtifact!.path,
          "utf8",
        ),
      ).id,
      roster.id,
    );

    const finalStatus = await getTesseraOptimizerStatus(statePath, {
      evaluationRuntime: runtime,
    });
    assert.equal(finalStatus.ok, true, finalStatus.violations[0]?.message);
    assert.equal(finalStatus.data?.state.stateRevision, 5);

    await writeFile(
      finalized.data!.finalRosterArtifact!.path,
      "{}\n",
    );
    const tampered = await getTesseraOptimizerStatus(statePath, {
      evaluationRuntime: runtime,
    });
    assert.equal(tampered.ok, false);
    assert.equal(
      tampered.violations[0]?.code,
      "TESSERA_OPTIMIZER_ARTIFACT_CHANGED",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("optimizer store refuses to publish against a different active bundle", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-optimizer-bundle-"),
  );
  try {
    const roster = fixtureRoster();
    roster.sourceData.bundleId = "f".repeat(64);
    const candidate = fixtureCandidate(roster);
    const baseline = fixtureBaseline(roster, candidate);
    const result = await startTesseraOptimizer({
      optimizerRunId: "stale-bundle-fixture",
      baselineReport: baseline,
      baselineRoster: roster,
      evaluationRuntime: runtime,
      rootDir: temporaryRoot,
      outputDirectory: path.join(temporaryRoot, "optimizers"),
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.violations[0]?.code,
      "TESSERA_OPTIMIZER_IDENTITY_INVALIDATED",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
