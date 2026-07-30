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
import {
  computeStressRobustness,
  stressFindings,
} from "../local/tessera/stress-analysis";
import { assessScreeningIntegrity } from "../local/tessera/stress";

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
        containsNamedCharacter: true,
        omissionReason: null,
        warnings: [],
      },
    ],
    coverage: {
      intended: 1,
      ready: 1,
      unavailable: 0,
      representedPostures: ["balanced-control"],
      missingPostures: [],
      representedCompositions: ["mixed"],
      missingCompositions: [],
      representedCells: [
        {
          templateId: "balanced-control:mixed",
          posture: "balanced-control",
          composition: "mixed",
        },
      ],
      missingCells: [],
      uniqueSimulationPayloads: 1,
      namedCharacterCoverage: true,
      namedCharacterCoverageStatus: "included",
      namedCharacterCoverageReason: null,
      maximumResultStatus: "complete",
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

test("complete quantitative coverage retains review-grade evidence confidence", () => {
  const playerUnits = [unit("player-1", "player", 100)];
  const opponentUnits = [unit("opponent-1", "opponent", 100)];
  const retainedWarning = "Imported profile requires review.";
  const scenarios = (["shooting", "fight"] as const).flatMap(
    (phase) =>
      (
        [
          "player-to-opponent",
          "opponent-to-player",
        ] as const
      ).map((direction) => {
        const base = scenario(
          phase,
          direction,
          playerUnits,
          opponentUnits,
        );
        return {
          ...base,
          warnings: [retainedWarning, retainedWarning],
          cells: base.cells.map((cell) => ({
            ...cell,
            confidence: "review" as const,
            warningRefs: [retainedWarning, retainedWarning],
            values: {
              ...cell.values,
              halfWipeProbability: 0.4,
            },
          })),
        };
      }),
  );

  const frozenPortfolio = portfolio();
  const robustness = computeStressRobustness(
    report(playerUnits, opponentUnits, scenarios),
    frozenPortfolio,
  );
  const sample = robustness.samples[0];

  assert.equal(sample.status, "confident");
  assert.equal(sample.coverageCompleteness, "complete");
  assert.equal(sample.evidenceConfidence, "review");
  assert.deepEqual(sample.warningRefs, [retainedWarning]);
  assert.equal(robustness.confidence, "complete");
  assert.equal(robustness.coverageCompleteness, "complete");
  assert.equal(robustness.evidenceConfidence, "review");
  assert.equal(robustness.offense.evidenceConfidence, "review");
  assert.equal(robustness.exposure.evidenceConfidence, "review");
  assert.equal(robustness.margin.evidenceConfidence, "review");
  assert.match(
    robustness.warnings.join("\n"),
    /aggregate evidence confidence is review/,
  );

  const universalGap = stressFindings(
    robustness,
    frozenPortfolio,
  ).find((finding) => finding.kind === "universal-gap");
  assert.equal(universalGap?.confidence, "review");
});

test("archetype risks cite only exposed templates and preserve equal-weight metadata", () => {
  const playerUnits = [unit("player-1", "player", 100)];
  const opponentA = [unit("opponent-a-unit", "opponent", 100)];
  const opponentB = [unit("opponent-b-unit", "opponent", 100)];
  const scenarioWithValue = (
    opponentName: string,
    phase: TesseraPhase,
    direction: TesseraDirection,
    opponentUnits: TesseraUnitInstance[],
    halfWipeProbability: number,
  ): TesseraScenarioResult => {
    const base = scenario(
      phase,
      direction,
      playerUnits,
      opponentUnits,
    );
    return {
      ...base,
      opponentName,
      cells: base.cells.map((cell) => ({
        ...cell,
        values: {
          ...cell.values,
          halfWipeProbability,
        },
      })),
    };
  };
  const scenarios = (["shooting", "fight"] as const).flatMap(
    (phase) => [
      scenarioWithValue(
        "Opponent A",
        phase,
        "player-to-opponent",
        opponentA,
        0.6,
      ),
      scenarioWithValue(
        "Opponent A",
        phase,
        "opponent-to-player",
        opponentA,
        0.4,
      ),
      scenarioWithValue(
        "Opponent B",
        phase,
        "player-to-opponent",
        opponentB,
        0.4,
      ),
      scenarioWithValue(
        "Opponent B",
        phase,
        "opponent-to-player",
        opponentB,
        0.6,
      ),
    ],
  );
  const matchup = report(playerUnits, opponentA, scenarios);
  const opponentTemplate = matchup.opponents[0];
  matchup.opponents = [
    {
      ...opponentTemplate,
      rosterName: "Opponent A",
      fingerprint: "opponent-a",
      units: opponentA,
      summary: {
        ...opponentTemplate.summary,
        rosterName: "Opponent A",
      },
    },
    {
      ...opponentTemplate,
      rosterName: "Opponent B",
      fingerprint: "opponent-b",
      units: opponentB,
      summary: {
        ...opponentTemplate.summary,
        rosterName: "Opponent B",
      },
    },
  ];
  const frozenPortfolio = portfolio();
  const itemTemplate = frozenPortfolio.items[0];
  frozenPortfolio.items = [
    {
      ...itemTemplate,
      templateId: "balanced-control:mixed",
      roster: {
        ...itemTemplate.roster!,
        name: "Opponent A",
      },
      fingerprint: "opponent-a",
      simulationFingerprint: "opponent-a",
    },
    {
      ...itemTemplate,
      templateId: "ranged-pressure:mixed",
      posture: "ranged-pressure",
      roster: {
        ...itemTemplate.roster!,
        name: "Opponent B",
      },
      fingerprint: "opponent-b",
      simulationFingerprint: "opponent-b",
    },
  ];
  frozenPortfolio.coverage.intended = 2;
  frozenPortfolio.coverage.ready = 2;
  frozenPortfolio.coverage.uniqueSimulationPayloads = 2;
  frozenPortfolio.coverage.representedPostures = [
    "balanced-control",
    "ranged-pressure",
  ];

  const robustness = computeStressRobustness(
    matchup,
    frozenPortfolio,
  );
  const player = robustness.units[0];
  assert.deepEqual(player.supportingTemplateIds, [
    "balanced-control:mixed",
  ]);
  assert.deepEqual(player.exposedTemplateIds, [
    "ranged-pressure:mixed",
  ]);
  assert.equal(robustness.samples.length, frozenPortfolio.coverage.ready);
  assert.equal(
    player.exposedTemplateIds.length / frozenPortfolio.coverage.ready,
    player.exposedWeight,
  );
  const risk = stressFindings(robustness, frozenPortfolio).find(
    (finding) =>
      finding.kind === "archetype-risk" &&
      finding.unitInstanceIds.includes(player.instanceId),
  );
  assert.ok(risk);
  assert.deepEqual(risk.templateIds, ["ranged-pressure:mixed"]);
});

test("distinct proxy payloads may legitimately produce identical matrix values", () => {
  const playerUnits = [unit("player-1", "player", 100)];
  const opponentUnits = [unit("opponent-1", "opponent", 100)];
  const baseScenarios = (["shooting", "fight"] as const).flatMap(
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
  const withHashes = (
    matrixSha256: string,
  ): TesseraScenarioResult[] =>
    baseScenarios.map((entry) => ({
      ...entry,
      metricRuns: [
        {
          metric: "half-wipe-probability",
          iterations: 1_000,
          settings: { iterations: "1000" },
          matrixSha256,
          integrity: {
            status: "trusted",
            issueCodes: [],
            aliasedScenarioIds: [],
          },
        },
      ],
    }));
  const frozenPortfolio = portfolio();
  const first = frozenPortfolio.items[0];
  frozenPortfolio.items.push({
    ...first,
    templateId: "ranged-pressure:mixed",
    posture: "ranged-pressure",
    fingerprint: "opponent-two",
    simulationFingerprint: "opponent-two",
  });
  frozenPortfolio.coverage.ready = 2;
  frozenPortfolio.coverage.intended = 2;
  frozenPortfolio.coverage.uniqueSimulationPayloads = 2;
  const integrity = assessScreeningIntegrity(
    new Map([
      [
        "balanced-control:mixed",
        report(
          playerUnits,
          opponentUnits,
          withHashes("a".repeat(64)),
        ),
      ],
      [
        "ranged-pressure:mixed",
        report(
          playerUnits,
          opponentUnits,
          withHashes("b".repeat(64)),
        ),
      ],
    ]),
    frozenPortfolio,
    true,
  );

  assert.equal(integrity.status, "verified");
  assert.deepEqual(integrity.issues, []);
});

test("requested screening with no complete matrices is inconclusive", () => {
  const frozenPortfolio = portfolio();
  const integrity = assessScreeningIntegrity(
    new Map(),
    frozenPortfolio,
    true,
  );

  assert.equal(integrity.status, "inconclusive");
  assert.deepEqual(
    integrity.issues.map((entry) => entry.code),
    ["TESSERA_EVIDENCE_INCOMPLETE"],
  );
  assert.deepEqual(
    integrity.issues[0]?.templateIds,
    ["balanced-control:mixed"],
  );
});
