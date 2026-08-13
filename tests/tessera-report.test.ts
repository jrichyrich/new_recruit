import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraMatchupReport,
  TesseraScenarioCell,
  TesseraScenarioResult,
  TesseraUnitInstance,
} from "../lib/rosterpilot";
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
