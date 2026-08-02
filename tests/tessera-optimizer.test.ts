import assert from "node:assert/strict";
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
  approveTesseraOptimizerCandidateBatch,
  approvedTesseraOptimizerComparisonRequests,
  approveTesseraOptimizerWinner,
  createTesseraOptimizerState,
  finalizeTesseraOptimizer,
  materializeApprovedTesseraOptimizerCandidates,
  paretoTesseraOptimizerCandidates,
  recordTesseraOptimizerComparison,
  retainTesseraOptimizerBaseline,
  verifyTesseraOptimizerState,
} from "../local/tessera/optimizer";

const createdAt = "2026-08-01T12:00:00.000Z";

const runtime: RuntimeProvenance = {
  rosterPilotVersion: "optimizer-test",
  rulesPackageVersion: "optimizer-test",
  stressGeneratorVersion: "optimizer-test",
  processStartedAt: createdAt,
  gitHead: null,
  sourceFingerprintAtStart: "optimizer-test-source",
  sourceFingerprintNow: "optimizer-test-source",
  buildId: "optimizer-test-build",
  stale: false,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
};

function fixtureRoster(): RosterDraftV1 {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Tessera optimizer fixture",
    requiredUnitIds: ["shield-captain"],
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map(({ message }) => message).join("\n"),
  );
  assert.ok(built.data);
  return built.data;
}

function fixtureCandidate(roster: RosterDraftV1): TesseraChangeCandidate {
  const warlord = roster.units.find((unit) => unit.isWarlord);
  assert.ok(warlord);
  return {
    candidateId: "keep-exact-warlord",
    title: "Keep the exact warlord configuration",
    rationale: "A deterministic no-shape candidate for coordinator tests.",
    operation: {
      type: "set-warlord",
      selectionId: warlord.selectionId,
    },
    beforePoints: roster.totalPoints,
    afterPoints: roster.totalPoints,
    rosterFingerprint: rosterExecutionFingerprint(roster),
    evidenceFindingIds: ["fixture-finding"],
  };
}

function fixtureBaseline(
  roster: RosterDraftV1,
  candidate: TesseraChangeCandidate,
): TesseraMatchupReport {
  const fingerprint = rosterExecutionFingerprint(roster);
  return {
    schemaVersion: 3,
    runId: "exact-baseline-run",
    generatedAt: createdAt,
    source: "tessera-ui",
    status: "complete",
    runtime,
    tesseraUiIdentity: "tessera-ui-fixture",
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
        rosterName: "Aeldari fixture",
        sourceRoszPath: "aeldari-source.rosz",
        enrichedRoszPath: "aeldari-enriched.rosz",
        summary: {
          rosterName: "Aeldari fixture",
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
          scenarioId: "fixture-scenario",
          opponentName: "Aeldari fixture",
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
    suggestions: ["Test the candidate with paired evidence."],
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
): TesseraRevisionComparisonReport {
  return {
    schemaVersion: 2,
    runId: "exact-revision-run",
    generatedAt: "2026-08-01T12:04:00.000Z",
    baselineReportPath: "artifacts/exact-baseline.json",
    baselineRunId: baseline.runId,
    revisedRosterFingerprint: candidate.rosterFingerprint,
    revisedReports: [
      {
        ...structuredClone(baseline),
        runId: "revised-child-run",
        changeCandidates: [],
      },
    ],
    deltas: [],
    aggregates: [
      {
        metric: "mean-damage",
        direction: "player-to-opponent",
        opponentNames: ["Aeldari fixture"],
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

test("guided optimizer gates revision requests and finalization with exact approvals", async () => {
  const roster = fixtureRoster();
  const candidate = fixtureCandidate(roster);
  const baseline = fixtureBaseline(roster, candidate);
  const created = createTesseraOptimizerState({
    optimizerRunId: "optimizer-guided-fixture",
    createdAt,
    baselineReportPath: "artifacts/exact-baseline.json",
    baselineReport: baseline,
    baselineRoster: roster,
    evaluationRuntime: runtime,
  });
  assert.equal(created.ok, true, created.violations[0]?.message);
  assert.ok(created.data);
  let state = created.data;
  assert.equal(state.mode, "guided");
  assert.equal(state.baselineSuggestions.pairing, "unpaired");
  assert.equal(state.candidates[0]?.pairing, "unpaired-baseline-suggestion");

  assert.equal(
    approvedTesseraOptimizerComparisonRequests(
      state,
      state.frozenIdentities,
    ).ok,
    false,
  );
  const batch = approveTesseraOptimizerCandidateBatch(state, {
    currentIdentities: state.frozenIdentities,
    expectedStateRevision: state.stateRevision,
    candidateIds: [candidate.candidateId],
    approvalId: "batch-approval-1",
    approvedBy: "fixture-user",
    approvedAt: "2026-08-01T12:01:00.000Z",
  });
  assert.equal(batch.ok, true, batch.violations[0]?.message);
  assert.ok(batch.data);
  state = batch.data;
  assert.equal(state.approvals[0]?.approvalKind, "candidate-evaluation-batch");
  assert.equal(
    state.approvals[0]?.frozenIdentities.contextSha256,
    state.frozenIdentities.contextSha256,
  );

  const materialized = await materializeApprovedTesseraOptimizerCandidates(
    state,
    {
      currentIdentities: state.frozenIdentities,
      materializedAt: "2026-08-01T12:02:00.000Z",
      qualifyCandidate: async (_baseline, readiness) => ({
        roster: structuredClone(roster),
        readiness: structuredClone(readiness),
      }),
    },
  );
  assert.equal(
    materialized.ok,
    true,
    materialized.violations[0]?.message,
  );
  assert.ok(materialized.data);
  state = materialized.data;
  const requests = approvedTesseraOptimizerComparisonRequests(
    state,
    state.frozenIdentities,
  );
  assert.equal(requests.ok, true, requests.violations[0]?.message);
  assert.equal(requests.data?.length, 1);
  assert.equal(requests.data?.[0].runRequest.kind, "exact-revision");
  assert.equal(
    requests.data?.[0].runRequest.options?.executionMode,
    "simulate",
  );

  const compared = recordTesseraOptimizerComparison(state, {
    currentIdentities: state.frozenIdentities,
    candidateId: candidate.candidateId,
    report: fixtureComparison(baseline, candidate),
    recordedAt: "2026-08-01T12:04:00.000Z",
  });
  assert.equal(compared.ok, true, compared.violations[0]?.message);
  assert.ok(compared.data);
  state = compared.data;
  assert.equal(state.stage, "pareto-ready");
  const pareto = paretoTesseraOptimizerCandidates(
    state,
    state.frozenIdentities,
  );
  assert.equal(pareto.ok, true, pareto.violations[0]?.message);
  assert.deepEqual(pareto.data?.frontierCandidateIds, [candidate.candidateId]);

  const retained = retainTesseraOptimizerBaseline(state, {
    currentIdentities: state.frozenIdentities,
    expectedStateRevision: state.stateRevision,
    approvalId: "retain-baseline-1",
    approvedBy: "fixture-user",
    approvedAt: "2026-08-01T12:05:00.000Z",
  });
  assert.equal(retained.ok, true, retained.violations[0]?.message);
  assert.equal(retained.data?.stage, "baseline-retained");
  const retainedFinal = finalizeTesseraOptimizer(retained.data!, {
    currentIdentities: retained.data!.frozenIdentities,
    deliveryIntent: {
      kind: "none",
      intentId: null,
      recordedBy: null,
      recordedAt: "2026-08-01T12:05:30.000Z",
    },
  });
  assert.equal(retainedFinal.ok, true, retainedFinal.violations[0]?.message);
  assert.equal(
    retainedFinal.data?.finalization?.disposition,
    "baseline-retained",
  );

  assert.equal(
    finalizeTesseraOptimizer(state, {
      currentIdentities: state.frozenIdentities,
      deliveryIntent: {
        kind: "none",
        intentId: null,
        recordedBy: null,
        recordedAt: "2026-08-01T12:05:00.000Z",
      },
    }).ok,
    false,
  );
  const winner = approveTesseraOptimizerWinner(state, {
    currentIdentities: state.frozenIdentities,
    expectedStateRevision: state.stateRevision,
    candidateId: candidate.candidateId,
    approvalId: "winner-approval-1",
    approvedBy: "fixture-user",
    approvedAt: "2026-08-01T12:06:00.000Z",
  });
  assert.equal(winner.ok, true, winner.violations[0]?.message);
  assert.ok(winner.data);
  state = winner.data;
  const finalized = finalizeTesseraOptimizer(state, {
    currentIdentities: state.frozenIdentities,
    deliveryIntent: {
      kind: "deliver-new-recruit",
      intentId: "delivery-intent-1",
      recordedBy: "fixture-user",
      recordedAt: "2026-08-01T12:07:00.000Z",
    },
    finalizedAt: "2026-08-01T12:07:00.000Z",
  });
  assert.equal(finalized.ok, true, finalized.violations[0]?.message);
  assert.equal(finalized.data?.stage, "finalized");
  assert.equal(
    finalized.data?.finalization?.deliveryIntent.kind,
    "deliver-new-recruit",
  );
  assert.equal(
    verifyTesseraOptimizerState(
      finalized.data!,
      finalized.data!.frozenIdentities,
    ).ok,
    true,
  );
});

test("recommend-only retains baseline and identity drift invalidates guided state", () => {
  const roster = fixtureRoster();
  const candidate = fixtureCandidate(roster);
  const baseline = fixtureBaseline(roster, candidate);
  const recommend = createTesseraOptimizerState({
    mode: "recommend-only",
    optimizerRunId: "optimizer-recommend-fixture",
    createdAt,
    baselineReportPath: "artifacts/exact-baseline.json",
    baselineReport: baseline,
    baselineRoster: roster,
    evaluationRuntime: runtime,
  });
  assert.ok(recommend.data);
  assert.equal(
    approveTesseraOptimizerCandidateBatch(recommend.data, {
      currentIdentities: recommend.data.frozenIdentities,
      expectedStateRevision: 0,
      candidateIds: [candidate.candidateId],
      approvalId: "not-allowed",
      approvedBy: "fixture-user",
      approvedAt: "2026-08-01T12:01:00.000Z",
    }).ok,
    false,
  );
  const retained = finalizeTesseraOptimizer(recommend.data, {
    currentIdentities: recommend.data.frozenIdentities,
    deliveryIntent: {
      kind: "none",
      intentId: null,
      recordedBy: null,
      recordedAt: "2026-08-01T12:02:00.000Z",
    },
  });
  assert.equal(retained.ok, true, retained.violations[0]?.message);
  assert.equal(retained.data?.finalization?.disposition, "baseline-retained");

  const guided = createTesseraOptimizerState({
    optimizerRunId: "optimizer-drift-fixture",
    createdAt,
    baselineReportPath: "artifacts/exact-baseline.json",
    baselineReport: baseline,
    baselineRoster: roster,
    evaluationRuntime: runtime,
  });
  assert.ok(guided.data);
  const drifted = structuredClone(guided.data.frozenIdentities);
  drifted.runtime.evaluationSha256 = "f".repeat(64);
  const rejected = approveTesseraOptimizerCandidateBatch(guided.data, {
    currentIdentities: drifted,
    expectedStateRevision: 0,
    candidateIds: [candidate.candidateId],
    approvalId: "stale-context",
    approvedBy: "fixture-user",
    approvedAt: "2026-08-01T12:03:00.000Z",
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.data?.stage, "invalidated");
  assert.equal(
    rejected.violations[0]?.code,
    "TESSERA_OPTIMIZER_IDENTITY_INVALIDATED",
  );
});

test("guided optimizer caps one evaluation batch at three candidates", () => {
  const roster = fixtureRoster();
  const first = fixtureCandidate(roster);
  const candidates = Array.from({ length: 4 }, (_, index) => ({
    ...structuredClone(first),
    candidateId: `candidate-${index + 1}`,
  }));
  const baseline = fixtureBaseline(roster, first);
  baseline.changeCandidates = candidates;
  const created = createTesseraOptimizerState({
    optimizerRunId: "optimizer-batch-cap-fixture",
    createdAt,
    baselineReportPath: "artifacts/exact-baseline.json",
    baselineReport: baseline,
    baselineRoster: roster,
    evaluationRuntime: runtime,
  });
  assert.ok(created.data);
  const rejected = approveTesseraOptimizerCandidateBatch(created.data, {
    currentIdentities: created.data.frozenIdentities,
    expectedStateRevision: 0,
    candidateIds: candidates.map(({ candidateId }) => candidateId),
    approvalId: "too-many-candidates",
    approvedBy: "fixture-user",
    approvedAt: "2026-08-01T12:08:00.000Z",
  });
  assert.equal(rejected.ok, false);
  assert.equal(
    rejected.violations[0]?.code,
    "TESSERA_OPTIMIZER_BATCH_APPROVAL_INVALID",
  );
});
