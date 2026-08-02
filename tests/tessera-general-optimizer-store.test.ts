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
  buildGeneralThreatPortfolio,
  buildRoster,
  GeneralThreatArchetypeIds,
  rosterExecutionFingerprint,
  type GeneralThreatArchetype,
  type GeneralThreatPortfolio,
  type RosterDraftV1,
  type RuntimeProvenance,
  type TesseraChangeCandidate,
  type TesseraMatchupReport,
  type TesseraRevisionComparisonReport,
} from "../lib/rosterpilot";
import {
  approveAndMaterializeTesseraGeneralOptimizerCandidates,
  approveStoredTesseraGeneralOptimizerWinner,
  finalizeStoredTesseraGeneralOptimizer,
  getTesseraGeneralOptimizerStatus,
  recordStoredTesseraGeneralOptimizerComparison,
  startTesseraGeneralOptimizer,
} from "../local/tessera/general-optimizer-store";

const createdAt = "2026-08-01T18:00:00.000Z";

const runtime: RuntimeProvenance = {
  rosterPilotVersion: "general-optimizer-store-test",
  rulesPackageVersion: "general-optimizer-store-test",
  stressGeneratorVersion: "general-optimizer-store-test",
  processStartedAt: createdAt,
  gitHead: null,
  sourceFingerprintAtStart: "general-optimizer-store-source",
  sourceFingerprintNow: "general-optimizer-store-source",
  buildId: "general-optimizer-store-build",
  stale: false,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
};

function fixtureRoster(): RosterDraftV1 {
  const result = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "General optimizer durable fixture",
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

function fixturePortfolio(): GeneralThreatPortfolio {
  const result = buildGeneralThreatPortfolio({ pointsLimit: 1_000 });
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
    candidateId: "general-durable-warlord-candidate",
    title: "Retain the exact warlord",
    rationale: "Deterministic six-way persistence fixture.",
    operation: {
      type: "set-warlord",
      selectionId: warlord.selectionId,
    },
    beforePoints: roster.totalPoints,
    afterPoints: roster.totalPoints,
    rosterFingerprint: rosterExecutionFingerprint(roster),
    evidenceFindingIds: ["general-durable-fixture"],
  };
}

function fixtureBaseline(
  roster: RosterDraftV1,
  portfolio: GeneralThreatPortfolio,
  archetypeId: GeneralThreatArchetype,
  candidate: TesseraChangeCandidate,
): TesseraMatchupReport {
  const opponent = portfolio.items.find(
    (item) => item.archetypeId === archetypeId,
  );
  assert.ok(opponent);
  const fingerprint = rosterExecutionFingerprint(roster);
  const opponentFingerprint = rosterExecutionFingerprint(opponent.roster);
  return {
    schemaVersion: 3,
    runId: `general-baseline-${archetypeId}`,
    generatedAt: createdAt,
    source: "tessera-ui",
    status: "complete",
    runtime,
    tesseraUiIdentity: "general-durable-tessera-ui",
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
        rosterName: opponent.label,
        sourceRoszPath: `${archetypeId}-source.rosz`,
        enrichedRoszPath: `${archetypeId}-enriched.rosz`,
        summary: {
          rosterName: opponent.roster.name,
          factionName: opponent.roster.factionName,
        },
        fingerprint: opponentFingerprint,
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
          scenarioId: `general-scenario-${archetypeId}`,
          opponentName: opponent.roster.name,
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
    suggestions: [`Run the ${archetypeId} paired candidate.`],
    findings: [],
    changeCandidates: [candidate],
    limitations: [],
    warnings: [],
    artifacts: [],
  };
}

function fixtureComparison(
  baseline: TesseraMatchupReport,
  baselineReportPath: string,
  candidate: TesseraChangeCandidate,
  archetypeId: GeneralThreatArchetype,
  improved: boolean,
): TesseraRevisionComparisonReport {
  return {
    schemaVersion: 2,
    runId: `general-comparison-${archetypeId}`,
    generatedAt: "2026-08-01T18:03:00.000Z",
    baselineReportPath,
    baselineRunId: baseline.runId,
    revisedRosterFingerprint: candidate.rosterFingerprint,
    revisedReports: [
      {
        ...structuredClone(baseline),
        runId: `general-revised-${archetypeId}`,
        changeCandidates: [],
      },
    ],
    deltas: [],
    aggregates: [
      {
        metric: "mean-damage",
        direction: "player-to-opponent",
        opponentNames: [baseline.opponents[0]!.rosterName],
        phases: ["shooting"],
        expectedScenarios: 1,
        applicableScenarios: 1,
        baselineCells: 1,
        revisedCells: 1,
        before: 4,
        after: improved ? 5 : 4,
        directionalChange: improved ? 0.25 : 0,
        materialityThreshold: 0.01,
        classification: improved ? "improved" : "unchanged",
      },
    ],
    summary: {
      improved: improved ? 1 : 0,
      worsened: 0,
      unchanged: improved ? 0 : 1,
      ambiguous: 0,
      aggregateCounts: {
        improved: improved ? 1 : 0,
        worsened: 0,
        unchanged: improved ? 0 : 1,
        ambiguous: 0,
        applicable: 1,
        total: 1,
      },
      conclusionBasis: "trusted-roster-aggregates",
      conclusion: improved ? "improved" : "unchanged",
    },
    limitations: [],
    warnings: [],
    artifacts: [],
  };
}

test("general optimizer store freezes six independent comparison artifacts", {
  timeout: 120_000,
}, async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-general-optimizer-store-"),
  );
  try {
    const roster = fixtureRoster();
    const portfolio = fixturePortfolio();
    const candidate = fixtureCandidate(roster);
    const baselines = GeneralThreatArchetypeIds.map((archetypeId) => ({
      archetypeId,
      report: fixtureBaseline(
        roster,
        portfolio,
        archetypeId,
        candidate,
      ),
    }));
    const started = await startTesseraGeneralOptimizer({
      optimizerRunId: "general-durable-store-fixture",
      createdAt,
      baselineRoster: roster,
      portfolio,
      baselines,
      evaluationRuntime: runtime,
      rootDir: temporaryRoot,
      outputDirectory: path.join(temporaryRoot, "general-optimizers"),
    });
    assert.equal(started.ok, true, started.violations[0]?.message);
    assert.ok(started.data);
    assert.equal(started.data.baselineReportArtifacts.length, 6);
    assert.equal(started.data.state.stateRevision, 0);
    const statePath = started.data.statePath;

    const status = await getTesseraGeneralOptimizerStatus(statePath, {
      evaluationRuntime: runtime,
    });
    assert.equal(status.ok, true, status.violations[0]?.message);

    const stale =
      await approveAndMaterializeTesseraGeneralOptimizerCandidates(
        statePath,
        {
          expectedStateRevision: 1,
          candidateIds: [candidate.candidateId],
          approvalId: "stale-general-batch",
          approvedBy: "fixture-user",
          evaluationRuntime: runtime,
        },
      );
    assert.equal(stale.ok, false);
    assert.equal(
      stale.violations[0]?.code,
      "TESSERA_GENERAL_OPTIMIZER_STALE_STATE_REVISION",
    );

    let qualifierCalls = 0;
    const approved =
      await approveAndMaterializeTesseraGeneralOptimizerCandidates(
        statePath,
        {
          expectedStateRevision: 0,
          candidateIds: [candidate.candidateId],
          approvalId: "general-durable-batch",
          approvedBy: "fixture-user",
          approvedAt: "2026-08-01T18:01:00.000Z",
          evaluationRuntime: runtime,
          qualifyCandidate: async (_baselineRoster, readiness) => {
            qualifierCalls += 1;
            return {
              roster: structuredClone(roster),
              readiness: structuredClone(readiness),
            };
          },
        },
      );
    assert.equal(approved.ok, true, approved.violations[0]?.message);
    assert.equal(qualifierCalls, 1);
    assert.equal(approved.data?.state.stateRevision, 2);
    assert.equal(approved.data?.comparisonRequests.length, 6);
    assert.equal(approved.data?.candidateRosterArtifacts.length, 1);

    let current = approved;
    for (const [index, archetypeId] of
      [...GeneralThreatArchetypeIds].reverse().entries()) {
      const request = current.data?.comparisonRequests.find(
        (entry) => entry.archetypeId === archetypeId,
      );
      assert.ok(request);
      const baselineArtifact = current.data?.baselineReportArtifacts.find(
        (artifact) => artifact.archetypeId === archetypeId,
      );
      assert.ok(baselineArtifact);
      const baseline = baselines.find(
        (entry) => entry.archetypeId === archetypeId,
      )!.report;
      current = await recordStoredTesseraGeneralOptimizerComparison(
        statePath,
        {
          expectedStateRevision: 2 + index,
          candidateId: candidate.candidateId,
          archetypeId,
          requestSha256: request.requestSha256,
          report: fixtureComparison(
            baseline,
            baselineArtifact.path,
            candidate,
            archetypeId,
            index === GeneralThreatArchetypeIds.length - 1,
          ),
          recordedAt: `2026-08-01T18:0${3 + index}:00.000Z`,
          evaluationRuntime: runtime,
        },
      );
      assert.equal(current.ok, true, current.violations[0]?.message);
    }
    assert.equal(current.data?.state.stateRevision, 8);
    assert.equal(current.data?.state.stage, "pareto-ready");
    assert.deepEqual(
      current.data?.state.pareto?.frontierCandidateIds,
      [candidate.candidateId],
    );
    assert.equal(current.data?.comparisonArtifacts.length, 6);
    assert.equal(
      new Set(current.data?.comparisonArtifacts.map((artifact) =>
        `${artifact.candidateId}:${artifact.archetypeId}`
      )).size,
      6,
    );

    const winner = await approveStoredTesseraGeneralOptimizerWinner(
      statePath,
      {
        expectedStateRevision: 8,
        candidateId: candidate.candidateId,
        approvalId: "general-durable-winner",
        approvedBy: "fixture-user",
        approvedAt: "2026-08-01T18:10:00.000Z",
        evaluationRuntime: runtime,
      },
    );
    assert.equal(winner.ok, true, winner.violations[0]?.message);
    assert.equal(winner.data?.state.stateRevision, 9);

    const finalized = await finalizeStoredTesseraGeneralOptimizer(
      statePath,
      {
        expectedStateRevision: 9,
        deliveryIntent: {
          kind: "prepare-handoff",
          intentId: "general-durable-handoff-intent",
          recordedBy: "fixture-user",
          recordedAt: "2026-08-01T18:11:00.000Z",
        },
        finalizedAt: "2026-08-01T18:11:00.000Z",
        evaluationRuntime: runtime,
      },
    );
    assert.equal(finalized.ok, true, finalized.violations[0]?.message);
    assert.equal(finalized.data?.state.stage, "finalized");
    assert.equal(finalized.data?.state.stateRevision, 10);
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

    await writeFile(
      finalized.data!.comparisonArtifacts[0]!.path,
      "{}\n",
    );
    const tampered = await getTesseraGeneralOptimizerStatus(statePath, {
      evaluationRuntime: runtime,
    });
    assert.equal(tampered.ok, false);
    assert.equal(
      tampered.violations[0]?.code,
      "TESSERA_GENERAL_OPTIMIZER_ARTIFACT_CHANGED",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
