import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraAnalysisConfiguration,
  TesseraMatchupReport,
  TesseraScenarioCell,
  TesseraScenarioResult,
  TesseraUnitInstance,
} from "../lib/rosterpilot";
import type { TesseraBrowserResult } from "../local/tessera/browser";
import {
  consolidateBrowserScenarios,
  selectedAttachmentReportingUnits,
} from "../local/tessera/companion";
import { renderTesseraMatchupReportHtml } from "../local/tessera/report";

function unit(
  side: "player" | "opponent",
  instanceId: string,
  name: string,
): TesseraUnitInstance {
  return {
    instanceId,
    selectionId: instanceId,
    side,
    name,
    label: name,
    ordinal: 1,
    modelCount: 1,
    points: 100,
    tags: [],
  };
}

function cell(
  attacker: ReturnType<typeof unit>,
  target: ReturnType<typeof unit>,
  wipeProbability: number,
): TesseraScenarioCell {
  return {
    attacker,
    target,
    values: {
      wipeProbability,
      halfWipeProbability: wipeProbability,
      meanKills: wipeProbability,
      meanDamage: wipeProbability * 10,
      damagePer100Points: wipeProbability * 10,
    },
    uncertainty: {
      "wipe-probability": {
        sampleCount: 10_000,
        standardDeviation: null,
        standardError: null,
        completeness: "complete",
      },
    },
    confidence: "high",
    warningRefs: [],
  };
}

function scenario(
  phase: "shooting" | "fight",
  direction: "player-to-opponent" | "opponent-to-player",
  value: number,
): TesseraScenarioResult {
  const player = unit("player", "player-1", "Allarus");
  const opponent = unit("opponent", "opponent-1", "Eightbound");
  return {
    scenarioId: `${phase}-${direction}`,
    opponentName: "Pressure list",
    phase,
    direction,
    metrics: [
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ],
    iterations: 10_000,
    settings: { phase },
    cells: [
      direction === "player-to-opponent"
        ? cell(player, opponent, value)
        : cell(opponent, player, value),
    ],
    status: "complete",
    warnings: [],
  };
}

function report(): TesseraMatchupReport {
  const summary = (
    rosterName: string,
    factionName: string,
    totalPoints: number,
  ) => ({
    rosterName,
    factionName,
    totalPoints,
    generatedBy: "RosterPilot",
    profileCount: 1,
    weaponProfileCount: 1,
    units: [],
  });
  return {
    schemaVersion: 4,
    runId: "report-fixture",
    generatedAt: "2026-08-13T00:00:00.000Z",
    source: "tessera-local-engine",
    status: "complete",
    comparisonClass: "unmatched",
    configuration: {
      analysisMode: "full",
      phases: ["shooting", "fight"],
      metrics: [
        "wipe-probability",
        "half-wipe-probability",
        "mean-kills",
        "mean-damage",
      ],
      directions: ["player-to-opponent", "opponent-to-player"],
      pointsTolerancePercent: 5,
      allowPointMismatch: true,
      includeChangeCandidates: false,
    },
    pointsComparisons: [{
      playerPoints: 485,
      opponentPoints: 450,
      pointsLimit: 500,
      difference: 35,
      differencePercent: 7,
      tolerancePercent: 5,
      matched: false,
      classification: "unmatched",
    }],
    player: {
      rosterId: "player",
      rosterName: "Countercharge",
      listUrl: null,
      sourceRoszPath: "player.json",
      enrichedRoszPath: "player.json",
      summary: summary("Countercharge", "Adeptus Custodes", 485),
    },
    opponents: [{
      kind: "roster",
      rosterName: "Pressure list",
      enrichedRoszPath: "opponent.json",
      summary: summary("Pressure list", "World Eaters", 450),
    }],
    simulation: {
      requested: true,
      experimental: true,
      settings: {},
      scenarios: [
        scenario("shooting", "player-to-opponent", 0.11),
        scenario("shooting", "opponent-to-player", 0.22),
        scenario("fight", "player-to-opponent", 0.77),
        scenario("fight", "opponent-to-player", 0.88),
      ],
      matrices: [],
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    limitations: ["Directional combat outcomes only."],
    warnings: [],
    artifacts: [],
  };
}

test("portable Tessera report contains deterministic directional heat-map controls", () => {
  const html = renderTesseraMatchupReportHtml(report());
  assert.match(html, /Adeptus Custodes vs World Eaters combat heat maps/);
  assert.match(html, /<option value="fight" selected>Fight<\/option>/);
  assert.doesNotMatch(html, /id="direction-filter"/);
  assert.match(html, /panel\("player-to-opponent", filtered, metric\)/);
  assert.match(html, /panel\("opponent-to-player", filtered, metric\)/);
  assert.match(html, /Directions remain separate so values cannot be mixed or overwritten/);
  assert.match(html, /main\{[^}]*overflow-x:clip/);
  assert.match(html, /@media\(max-width:820px\).*\.heatmap-grid\{grid-template-columns:1fr/);
});

test("selected attachment formations use formation-sized report completeness", () => {
  const player = unit("player", "player-1", "Player");
  const leader = {
    ...unit("opponent", "leader-1", "Commissar"),
    points: 40,
  };
  const bodyguard = {
    ...unit("opponent", "bodyguard-1", "Death Korps of Krieg"),
    modelCount: 10,
    points: 75,
  };
  const secondKorps = {
    ...unit("opponent", "korps-2", "Death Korps of Krieg"),
    ordinal: 2,
    modelCount: 10,
    points: 75,
  };
  const thirdKorps = {
    ...unit("opponent", "korps-3", "Death Korps of Krieg"),
    ordinal: 3,
    modelCount: 10,
    points: 75,
  };
  const artillery = unit("opponent", "artillery-1", "Artillery Team");
  const centaur = unit("opponent", "centaur-1", "Centaur RSV");
  const heavy = unit(
    "opponent",
    "heavy-1",
    "Krieg Heavy Weapons Squad",
  );
  const opponentUnits = [
    leader,
    artillery,
    centaur,
    bodyguard,
    heavy,
    secondKorps,
    thirdKorps,
  ];
  const bindings = [{
    side: "opponent" as const,
    leaderSelectionId: leader.selectionId!,
    bodyguardSelectionId: bodyguard.selectionId!,
    supportingSelectionIds: [],
  }];
  const reportingUnits = selectedAttachmentReportingUnits(
    opponentUnits,
    "opponent",
    bindings,
  );
  assert.equal(reportingUnits.length, 6);
  assert.deepEqual(
    reportingUnits.map((candidate) => candidate.name),
    [
      "Artillery Team",
      "Centaur RSV",
      "Death Korps of Krieg + Commissar",
      "Krieg Heavy Weapons Squad",
      "Death Korps of Krieg",
      "Death Korps of Krieg",
    ],
  );
  assert.deepEqual(
    reportingUnits.find((candidate) =>
      candidate.name === "Death Korps of Krieg + Commissar"
    ),
    {
      instanceId: reportingUnits[2].instanceId,
      selectionId: "bodyguard-1",
      side: "opponent",
      name: "Death Korps of Krieg + Commissar",
      label:
        "Death Korps of Krieg + Commissar — 11 models — 115 pts — Unit 1",
      ordinal: 1,
      modelCount: 11,
      points: 115,
      tags: [],
    },
  );

  const rawCell = (
    target: string,
    targetOccurrence: number,
    targetIndex: number,
  ) => ({
    attacker: "Player",
    target,
    direction: "player-to-opponent" as const,
    killProbability: null,
    expectedDamage: 1,
    damagePer100Points: 1,
    attackerIndex: 0,
    targetIndex,
    attackerOccurrence: 1,
    targetOccurrence,
    metricValue: 1,
    uncertainty: {
      sampleCount: 10,
      standardDeviation: 0,
      standardError: 0,
      completeness: "complete" as const,
    },
  });
  const browserResult = {
    settings: { provider: "local-engine" },
    cells: [],
    scenarios: [{
      id: "shooting:player-to-opponent:mean-damage",
      phase: "shooting",
      direction: "player-to-opponent",
      metric: "mean-damage",
      settings: { provider: "local-engine", phase: "shooting" },
      iterations: 10,
      cells: [
        rawCell("Artillery Team", 1, 0),
        rawCell("Centaur RSV", 1, 1),
        rawCell("Death Korps of Krieg + Commissar", 1, 2),
        rawCell("Krieg Heavy Weapons Squad", 1, 3),
        rawCell("Death Korps of Krieg", 2, 4),
        rawCell("Death Korps of Krieg", 3, 5),
      ],
    }],
    importWarnings: { player: [], opponent: [] },
    warnings: [],
  } satisfies TesseraBrowserResult;
  const configuration = {
    analysisMode: "full",
    phases: ["shooting"],
    metrics: ["mean-damage"],
    directions: ["player-to-opponent"],
    pointsTolerancePercent: 5,
    allowPointMismatch: true,
    includeChangeCandidates: false,
  } satisfies TesseraAnalysisConfiguration;
  const scenarios = consolidateBrowserScenarios(
    browserResult,
    [player],
    opponentUnits,
    "Opponent",
    configuration,
    bindings,
  );
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].status, "complete");
  assert.equal(scenarios[0].cells.length, 6);
  assert.deepEqual(scenarios[0].warnings, []);
  assert.deepEqual(
    scenarios[0].cells
      .filter((candidate) =>
        candidate.target.name === "Death Korps of Krieg"
      )
      .map((candidate) => candidate.target.selectionId),
    ["korps-2", "korps-3"],
  );

  const ambiguous = consolidateBrowserScenarios(
    {
      ...browserResult,
      scenarios: [{
        ...browserResult.scenarios[0],
        cells: [rawCell("Death Korps of Krieg", 1, 0)],
      }],
    },
    [player],
    [
      bodyguard,
      { ...secondKorps, ordinal: 1 },
    ],
    "Opponent",
    configuration,
  );
  assert.equal(ambiguous[0].status, "partial");
  assert.equal(ambiguous[0].cells.length, 0);
  assert.match(
    ambiguous[0].warnings[0],
    /labels could not be mapped exactly/,
  );
});
