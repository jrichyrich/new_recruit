import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraDirection,
  TesseraMatchupReport,
  TesseraPhase,
  TesseraScenarioResult,
  TesseraStressPortfolio,
  TesseraUnitInstance,
} from "../lib/rosterpilot";
import { computeStressRobustness } from "../local/tessera/stress-analysis";

function unit(
  instanceId: string,
  side: "player" | "opponent",
  points: number | null,
): TesseraUnitInstance {
  return {
    instanceId,
    selectionId: instanceId,
    side,
    name: instanceId,
    label: instanceId,
    ordinal: 1,
    modelCount: 1,
    points,
    tags: [],
  };
}

function scenario(
  phase: TesseraPhase,
  direction: TesseraDirection,
  playerUnits: TesseraUnitInstance[],
  opponentUnits: TesseraUnitInstance[],
): TesseraScenarioResult {
  const attackers =
    direction === "player-to-opponent"
      ? playerUnits
      : opponentUnits;
  const targets =
    direction === "player-to-opponent"
      ? opponentUnits
      : playerUnits;
  return {
    scenarioId: `${phase}:${direction}`,
    opponentName: "Opponent",
    phase,
    direction,
    metrics: ["half-wipe-probability"],
    iterations: 1_000,
    settings: { iterations: "1000" },
    cells: attackers.flatMap((attacker) =>
      targets.map((target) => ({
        attacker,
        target,
        values: {
          wipeProbability: null,
          halfWipeProbability:
            direction === "player-to-opponent" ? 0.6 : 0.4,
          meanKills: null,
          meanDamage: null,
          damagePer100Points: null,
        },
        confidence: "high" as const,
        warningRefs: [],
      })),
    ),
    status: "complete",
    warnings: [],
  };
}

function report(
  playerUnits: TesseraUnitInstance[],
  opponentUnits: TesseraUnitInstance[],
  scenarios: TesseraScenarioResult[],
): TesseraMatchupReport {
  return {
    schemaVersion: 2,
    runId: "stress-analysis",
    generatedAt: "2026-07-28T00:00:00.000Z",
    source: "tessera-ui",
    status: "complete",
    comparisonClass: "matched",
    configuration: {
      analysisMode: "quick",
      phases: ["shooting", "fight"],
      metrics: ["half-wipe-probability"],
      directions: [
        "player-to-opponent",
        "opponent-to-player",
      ],
      pointsTolerancePercent: 5,
      allowPointMismatch: false,
      includeChangeCandidates: true,
    },
    pointsComparisons: [],
    player: {
      rosterId: "player",
      rosterName: "Player",
      factionId: "adeptus-custodes",
      listUrl: null,
      sourceRoszPath: "/tmp/player.rosz",
      enrichedRoszPath: "/tmp/player-enriched.rosz",
      summary: {
        rosterName: "Player",
        factionName: "Adeptus Custodes",
        totalPoints: 100,
        generatedBy: "fixture",
        profileCount: 1,
        weaponProfileCount: 1,
        units: [],
      },
      units: playerUnits,
    },
    opponents: [
      {
        kind: "roster",
        rosterName: "Opponent",
        enrichedRoszPath: "/tmp/opponent.rosz",
        summary: {
          rosterName: "Opponent",
          factionName: "Aeldari",
          totalPoints: 100,
          generatedBy: "fixture",
          profileCount: 1,
          weaponProfileCount: 1,
          units: [],
        },
        units: opponentUnits,
      },
    ],
    simulation: {
      requested: true,
      experimental: true,
      settings: { iterations: "1000" },
      matrices: [],
      scenarios,
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    findings: [],
    changeCandidates: [],
    limitations: [],
    warnings: [],
    artifacts: [],
  };
}

function portfolio(): TesseraStressPortfolio {
  return {
    schemaVersion: 1,
    generatorVersion: "fixture",
    suite: "core-3",
    factionId: "aeldari",
    factionName: "Aeldari",
    pointsLimit: 100,
    pointsTolerancePercent: 5,
    sourceData: {} as TesseraStressPortfolio["sourceData"],
    items: [
      {
        templateId: "balanced-control:mixed",
        posture: "balanced-control",
        composition: "mixed",
        status: "ready",
        roster: {
          name: "Opponent",
        } as TesseraStressPortfolio["items"][number]["roster"],
        fingerprint: "opponent",
        simulationFingerprint: "opponent",
        structuralDistance: 1,
        detachmentId: "fixture",
        allowNamedCharacters: false,
        traits: null,
        compositionEvidence: [],
        containsNamedCharacter: false,
        omissionReason: null,
        warnings: [],
      },
    ],
    coverage: {
      intended: 1,
      ready: 1,
      unavailable: 0,
      representedPostures: ["balanced-control"],
      representedCompositions: ["mixed"],
      uniqueSimulationPayloads: 1,
      namedCharacterCoverage: true,
    },
  };
}

test("stress confidence requires independent shooting and fight coverage", () => {
  const playerUnits = [unit("player-1", "player", 100)];
  const opponentUnits = [unit("opponent-1", "opponent", 100)];
  const result = computeStressRobustness(
    report(
      playerUnits,
      opponentUnits,
      [
        scenario(
          "shooting",
          "player-to-opponent",
          playerUnits,
          opponentUnits,
        ),
        scenario(
          "shooting",
          "opponent-to-player",
          playerUnits,
          opponentUnits,
        ),
      ],
    ),
    portfolio(),
  );

  assert.equal(result.samples[0].status, "ambiguous");
  assert.equal(result.samples[0].opponentPointCoverage, 0);
  assert.equal(result.samples[0].playerPointCoverage, 0);
});

test("unknown target points remain in the expected points denominator", () => {
  const playerUnits = [unit("player-1", "player", 100)];
  const opponentUnits = [
    unit("opponent-known", "opponent", 50),
    unit("opponent-unknown", "opponent", null),
  ];
  const scenarios = (["shooting", "fight"] as const).flatMap(
    (phase) =>
      (
        [
          "player-to-opponent",
          "opponent-to-player",
        ] as const
      ).map((direction) =>
        scenario(
          phase,
          direction,
          playerUnits,
          opponentUnits,
        ),
      ),
  );
  const result = computeStressRobustness(
    report(playerUnits, opponentUnits, scenarios),
    portfolio(),
  );

  assert.equal(result.samples[0].offensiveCoverage, null);
  assert.equal(result.samples[0].provisional?.offensiveCoverage, 0.5);
  assert.equal(result.samples[0].opponentPointCoverage, 0.5);
  assert.equal(result.samples[0].status, "ambiguous");
});
