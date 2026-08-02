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
  buildGeneralThreatPortfolio,
  type GeneralThreatArchetype,
  type GeneralThreatPortfolio,
} from "../lib/rosterpilot/general-threat-portfolio";
import {
  approveTesseraGeneralOptimizerCandidateBatch,
  approvedTesseraGeneralOptimizerComparisonRequests,
  approveTesseraGeneralOptimizerWinner,
  createTesseraGeneralOptimizerState,
  finalizeTesseraGeneralOptimizer,
  materializeApprovedTesseraGeneralOptimizerCandidates,
  recordTesseraGeneralOptimizerComparison,
  retainTesseraGeneralOptimizerBaseline,
  type TesseraGeneralOptimizerState,
} from "../local/tessera/general-optimizer";

const createdAt = "2026-08-01T12:00:00.000Z";
const runtime: RuntimeProvenance = {
  rosterPilotVersion: "general-optimizer-test",
  rulesPackageVersion: "general-optimizer-test",
  stressGeneratorVersion: "general-optimizer-test",
  processStartedAt: createdAt,
  gitHead: null,
  sourceFingerprintAtStart: "general-optimizer-source",
  sourceFingerprintNow: "general-optimizer-source",
  buildId: "general-optimizer-build",
  stale: false,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
};

function playerRoster(): RosterDraftV1 {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "General optimizer player",
    requiredUnitIds: ["shield-captain"],
  });
  assert.ok(built.ok && built.data, built.violations[0]?.message);
  return built.data;
}

function candidateFor(roster: RosterDraftV1): TesseraChangeCandidate {
  const warlord = roster.units.find(({ isWarlord }) => isWarlord);
  assert.ok(warlord);
  return {
    candidateId: "general-keep-warlord",
    title: "Retain the exact warlord",
    rationale: "A deterministic materialization fixture.",
    operation: {
      type: "set-warlord",
      selectionId: warlord.selectionId,
    },
    beforePoints: roster.totalPoints,
    afterPoints: roster.totalPoints,
    rosterFingerprint: rosterExecutionFingerprint(roster),
    evidenceFindingIds: ["candidate-evidence"],
  };
}

function baselineReport(
  player: RosterDraftV1,
  portfolio: GeneralThreatPortfolio,
  archetypeId: GeneralThreatArchetype,
  candidate: TesseraChangeCandidate,
): TesseraMatchupReport {
  const item = portfolio.items.find(
    (entry) => entry.archetypeId === archetypeId,
  );
  assert.ok(item);
  return {
    schemaVersion: 3,
    runId: `baseline-${archetypeId}`,
    generatedAt: createdAt,
    source: "tessera-ui",
    status: "complete",
    runtime,
    tesseraUiIdentity: "general-optimizer-ui",
    profilePolicyHash: null,
    frozenProfileRequirements: [],
    pinnedData: player.sourceData,
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
      rosterId: player.id,
      rosterName: player.name,
      factionId: player.factionId,
      listUrl: null,
      sourceRoszPath: "player.rosz",
      enrichedRoszPath: "player-enriched.rosz",
      summary: {
        rosterName: player.name,
        factionName: player.factionName,
      },
      fingerprint: rosterExecutionFingerprint(player),
    } as TesseraMatchupReport["player"],
    opponents: [{
      kind: "rosz",
      rosterName: item.roster.name,
      sourceRoszPath: `${archetypeId}.rosz`,
      enrichedRoszPath: `${archetypeId}-enriched.rosz`,
      summary: {
        rosterName: item.roster.name,
        factionName: item.roster.factionName,
      },
      fingerprint: rosterExecutionFingerprint(item.roster),
    } as TesseraMatchupReport["opponents"][number]],
    simulation: {
      requested: true,
      executionMode: "simulate",
      experimental: false,
      status: "complete",
      engine: "tessera-ui",
      settings: { iterations: "10000" },
      scenarios: [{
        scenarioId: `scenario-${archetypeId}`,
        opponentName: item.roster.name,
        phase: "shooting",
        direction: "player-to-opponent",
        metrics: ["mean-damage"],
        status: "complete",
        settings: { iterations: "10000" },
        iterations: 10_000,
        cells: [],
        warnings: [],
      }],
      matrices: [],
    },
    strengths: [],
    weaknesses: [],
    suggestions: [`Evaluate ${archetypeId}.`],
    findings: [],
    changeCandidates: [structuredClone(candidate)],
    limitations: [],
    warnings: [],
    artifacts: [],
  };
}

function comparisonReport(
  baseline: TesseraMatchupReport,
  candidate: TesseraChangeCandidate,
  archetypeId: GeneralThreatArchetype,
  classification: "improved" | "worsened" | "unchanged",
): TesseraRevisionComparisonReport {
  const improved = classification === "improved" ? 1 : 0;
  const worsened = classification === "worsened" ? 1 : 0;
  const unchanged = classification === "unchanged" ? 1 : 0;
  const directionalChange = classification === "improved"
    ? 0.25
    : classification === "worsened"
    ? -0.25
    : 0;
  return {
    schemaVersion: 2,
    runId: `revision-${archetypeId}-${classification}`,
    generatedAt: "2026-08-01T12:04:00.000Z",
    baselineReportPath: `artifacts/${archetypeId}.json`,
    baselineRunId: baseline.runId,
    revisedRosterFingerprint: candidate.rosterFingerprint,
    revisedReports: [{
      ...structuredClone(baseline),
      runId: `revised-child-${archetypeId}-${classification}`,
      player: {
        ...structuredClone(baseline.player),
        fingerprint: candidate.rosterFingerprint,
      },
      changeCandidates: [],
    }],
    deltas: [],
    aggregates: [{
      metric: "mean-damage",
      direction: "player-to-opponent",
      opponentNames: [baseline.opponents[0]!.rosterName],
      phases: ["shooting"],
      expectedScenarios: 1,
      applicableScenarios: 1,
      baselineCells: 1,
      revisedCells: 1,
      before: 4,
      after: 4 * (1 + directionalChange),
      directionalChange,
      materialityThreshold: 0.01,
      classification,
    }],
    summary: {
      improved,
      worsened,
      unchanged,
      ambiguous: 0,
      aggregateCounts: {
        improved,
        worsened,
        unchanged,
        ambiguous: 0,
        applicable: 1,
        total: 1,
      },
      conclusionBasis: "trusted-roster-aggregates",
      conclusion: classification,
    },
    limitations: [],
    warnings: [],
    artifacts: [],
  };
}

async function recordSix(
  initial: TesseraGeneralOptimizerState,
  baselines: Map<GeneralThreatArchetype, TesseraMatchupReport>,
  candidate: TesseraChangeCandidate,
  regressedArchetype: GeneralThreatArchetype | null,
): Promise<TesseraGeneralOptimizerState> {
  let state = structuredClone(initial);
  const requests = approvedTesseraGeneralOptimizerComparisonRequests(
    state,
    state.frozenIdentities,
  );
  assert.ok(requests.ok && requests.data);
  const shuffled = [...requests.data].reverse();
  for (const [index, request] of shuffled.entries()) {
    const classification = request.archetypeId === regressedArchetype
      ? "worsened"
      : index === shuffled.length - 1
      ? "improved"
      : "unchanged";
    const report = comparisonReport(
      baselines.get(request.archetypeId)!,
      candidate,
      request.archetypeId,
      classification,
    );
    const recorded = recordTesseraGeneralOptimizerComparison(state, {
      currentIdentities: state.frozenIdentities,
      expectedStateRevision: state.stateRevision,
      candidateId: candidate.candidateId,
      archetypeId: request.archetypeId,
      requestSha256: request.requestSha256,
      report,
      reportArtifactSha256: `${index + 1}`.repeat(64),
      recordedAt: `2026-08-01T12:${10 + index}:00.000Z`,
    });
    assert.ok(recorded.ok && recorded.data, recorded.violations[0]?.message);
    state = recorded.data;
    if (index < shuffled.length - 1) {
      assert.equal(state.pareto, null);
    }
  }
  return state;
}

test("general-six optimizer fans one materialization into six paired requests and preserves two approvals", {
  timeout: 120_000,
}, async () => {
  const player = playerRoster();
  const candidate = candidateFor(player);
  const builtPortfolio = buildGeneralThreatPortfolio({ pointsLimit: 1_000 });
  assert.ok(
    builtPortfolio.ok && builtPortfolio.data,
    builtPortfolio.violations[0]?.message,
  );
  const portfolio = builtPortfolio.data;
  const reports = new Map<GeneralThreatArchetype, TesseraMatchupReport>();
  const baselines = portfolio.items.map((item, index) => {
    const report = baselineReport(
      player,
      portfolio,
      item.archetypeId,
      candidate,
    );
    reports.set(item.archetypeId, report);
    return {
      archetypeId: item.archetypeId,
      reportPath: `artifacts/${item.archetypeId}.json`,
      report,
      reportArtifactSha256: `${index + 1}`.repeat(64),
    };
  }).reverse();
  const created = await createTesseraGeneralOptimizerState({
    optimizerRunId: "general-six-fixture",
    createdAt,
    baselineRoster: player,
    portfolio,
    portfolioArtifactSha256: "a".repeat(64),
    baselines,
    evaluationRuntime: runtime,
  });
  assert.ok(created.ok && created.data, created.violations[0]?.message);
  assert.deepEqual(
    created.data.baselines.map(({ archetypeId }) => archetypeId),
    portfolio.items.map(({ archetypeId }) => archetypeId),
  );
  const approved = approveTesseraGeneralOptimizerCandidateBatch(
    created.data,
    {
      currentIdentities: created.data.frozenIdentities,
      expectedStateRevision: 0,
      candidateIds: [candidate.candidateId],
      approvalId: "general-batch",
      approvedBy: "fixture-user",
      approvedAt: "2026-08-01T12:01:00.000Z",
    },
  );
  assert.ok(approved.ok && approved.data, approved.violations[0]?.message);
  let qualifierCalls = 0;
  const materialized = await materializeApprovedTesseraGeneralOptimizerCandidates(
    approved.data,
    {
      currentIdentities: approved.data.frozenIdentities,
      materializedAt: "2026-08-01T12:02:00.000Z",
      qualifyCandidate: async (_baseline, readiness) => {
        qualifierCalls += 1;
        return {
          roster: structuredClone(player),
          readiness: structuredClone(readiness),
        };
      },
    },
  );
  assert.ok(
    materialized.ok && materialized.data,
    materialized.violations[0]?.message,
  );
  assert.equal(qualifierCalls, 1);
  const requests = approvedTesseraGeneralOptimizerComparisonRequests(
    materialized.data,
    materialized.data.frozenIdentities,
  );
  assert.ok(requests.ok && requests.data);
  assert.equal(requests.data.length, 6);
  assert.equal(
    new Set(requests.data.map(({ revisedRosterSha256 }) => revisedRosterSha256)).size,
    1,
  );
  assert.equal(
    new Set(requests.data.map(({ archetypeId }) => archetypeId)).size,
    6,
  );

  const pending = structuredClone(materialized.data);
  let state = await recordSix(pending, reports, candidate, null);
  assert.equal(state.stage, "pareto-ready");
  assert.deepEqual(state.pareto?.frontierCandidateIds, [candidate.candidateId]);
  assert.equal(
    finalizeTesseraGeneralOptimizer(state, {
      currentIdentities: state.frozenIdentities,
      expectedStateRevision: state.stateRevision,
      deliveryIntent: {
        kind: "none",
        intentId: null,
        recordedBy: null,
        recordedAt: "2026-08-01T12:20:00.000Z",
      },
    }).ok,
    false,
  );
  const winner = approveTesseraGeneralOptimizerWinner(state, {
    currentIdentities: state.frozenIdentities,
    expectedStateRevision: state.stateRevision,
    candidateId: candidate.candidateId,
    approvalId: "general-winner",
    approvedBy: "fixture-user",
    approvedAt: "2026-08-01T12:21:00.000Z",
  });
  assert.ok(winner.ok && winner.data, winner.violations[0]?.message);

  state = await recordSix(pending, reports, candidate, "horde");
  assert.deepEqual(state.pareto?.frontierCandidateIds, []);
  assert.deepEqual(state.pareto?.disqualifiedCandidateIds, [candidate.candidateId]);
  assert.equal(state.stage, "pareto-ready");
  const retained = retainTesseraGeneralOptimizerBaseline(state, {
    currentIdentities: state.frozenIdentities,
    expectedStateRevision: state.stateRevision,
    approvalId: "general-retain",
    approvedBy: "fixture-user",
    approvedAt: "2026-08-01T12:22:00.000Z",
  });
  assert.ok(retained.ok && retained.data, retained.violations[0]?.message);
  assert.equal(retained.data.stage, "baseline-retained");
});
