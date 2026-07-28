import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraMatchupReport,
  TesseraRevisionComparisonReport,
  TesseraUnitInstance,
} from "../lib/rosterpilot";
import {
  renderTesseraMatchupReportHtml,
  renderTesseraRevisionComparisonHtml,
} from "../local/tessera/report";

function unit(
  instanceId: string,
  side: "player" | "opponent",
  label: string,
): TesseraUnitInstance {
  return {
    instanceId,
    selectionId: instanceId,
    side,
    name: label,
    label,
    ordinal: 1,
    modelCount: 2,
    points: 110,
    tags: [],
  };
}

function v2Report(): TesseraMatchupReport {
  const attacker = unit(
    "player-allarus-1",
    "player",
    "Allarus Custodians — 2 models — Unit 1",
  );
  const target = unit(
    "opponent-guard-1",
    "opponent",
    'Custodian Guard <script>alert("target")</script>',
  );
  return {
    schemaVersion: 2,
    runId: "safe-run",
    generatedAt: "2026-07-28T16:00:00.000Z",
    source: "tessera-ui",
    status: "complete",
    comparisonClass: "matched",
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
      allowPointMismatch: false,
      includeChangeCandidates: true,
    },
    pointsComparisons: [
      {
        playerPoints: 1000,
        opponentPoints: 995,
        pointsLimit: 1000,
        difference: 5,
        differencePercent: 0.5,
        tolerancePercent: 5,
        matched: true,
        classification: "matched",
      },
    ],
    player: {
      rosterId: "player",
      rosterName: "Solar & Spearhead",
      listUrl: null,
      sourceRoszPath: "/tmp/player.rosz",
      enrichedRoszPath: "/tmp/player-enriched.rosz",
      fingerprint: "player-fingerprint",
      summary: {
        rosterName: "Solar & Spearhead",
        factionName: "Adeptus Custodes",
        totalPoints: 1000,
        generatedBy: "New Recruit",
        profileCount: 20,
        weaponProfileCount: 10,
        units: [{ name: "Allarus Custodians", modelCount: 2 }],
      },
      units: [attacker],
    },
    opponents: [
      {
        kind: "rosz",
        rosterName: "Mirror Match",
        enrichedRoszPath: "/tmp/opponent.rosz",
        fingerprint: "opponent-fingerprint",
        summary: {
          rosterName: "Mirror Match",
          factionName: "Adeptus Custodes",
          totalPoints: 995,
          generatedBy: "New Recruit",
          profileCount: 20,
          weaponProfileCount: 10,
          units: [{ name: "Custodian Guard", modelCount: 5 }],
        },
        units: [target],
      },
    ],
    simulation: {
      requested: true,
      experimental: true,
      settings: {
        iterations: "1000",
        licenseKey: "never-render-this-premium-key",
        browserProfileDirectory: "/tmp/secret-profile",
      },
      matrices: [],
      scenarios: [
        {
          scenarioId: "mirror-shooting-player",
          opponentName: "Mirror Match",
          phase: "shooting",
          direction: "player-to-opponent",
          metrics: [
            "wipe-probability",
            "half-wipe-probability",
            "mean-kills",
            "mean-damage",
          ],
          iterations: 1000,
          settings: {
            phase: "Shooting",
            premiumKey: "also-never-render",
          },
          status: "complete",
          warnings: [],
          cells: [
            {
              attacker,
              target,
              values: {
                wipeProbability: 0.61,
                halfWipeProbability: 0.83,
                meanKills: 3.2,
                meanDamage: 8.4,
                damagePer100Points: 7.63,
              },
              confidence: "high",
              warningRefs: [],
            },
          ],
        },
      ],
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    findings: [
      {
        findingId: "finding-1",
        kind: "reliable-coverage",
        severity: "info",
        confidence: "high",
        summary:
          'Allarus have reliable coverage.</script><script>alert("finding")</script>',
        unitInstanceIds: ["player-allarus-1"],
        evidence: [
          {
            scenarioId: "mirror-shooting-player",
            attackerInstanceId: "player-allarus-1",
            targetInstanceId: "opponent-guard-1",
            phase: "shooting",
            direction: "player-to-opponent",
            values: {
              wipeProbability: 0.61,
              halfWipeProbability: 0.83,
              meanKills: 3.2,
              meanDamage: 8.4,
              damagePer100Points: 7.63,
            },
          },
        ],
      },
    ],
    changeCandidates: [
      {
        candidateId: "candidate-1",
        title: "Resize the Allarus unit",
        rationale: "Free points for screening.",
        operation: {
          type: "set-model-count",
          selectionId: "player-allarus-1",
          modelCount: 3,
        },
        beforePoints: 1000,
        afterPoints: 995,
        rosterFingerprint: "candidate-fingerprint",
        evidenceFindingIds: ["finding-1"],
      },
    ],
    limitations: ["Terrain and missions are excluded."],
    warnings: [
      'Review Vaultswords </script><script>alert("warning")</script>',
    ],
    artifacts: [],
  };
}

test("renders an interactive v2 matchup report with safe embedded data", () => {
  const html = renderTesseraMatchupReportHtml(v2Report());

  assert.match(html, /Points match/);
  assert.match(html, /Simulation configuration/);
  assert.match(html, /Evidence-backed findings/);
  assert.match(html, /Proposed legal changes/);
  assert.match(html, /Provenance/);
  assert.match(html, /id="opponent-filter"/);
  assert.match(html, /id="phase-filter"/);
  assert.match(html, /id="metric-filter"/);
  assert.match(html, /id="direction-filter"/);
  assert.match(html, /id="confidence-filter"/);
  assert.match(html, /Allarus Custodians — 2 models — Unit 1/);
  assert.match(html, /Solar &amp; Spearhead/);
  assert.doesNotMatch(html, /<\/script><script>alert\(/i);
  assert.match(html, /\\u003c\/script\\u003e/);
  assert.doesNotMatch(html, /never-render-this-premium-key/);
  assert.doesNotMatch(html, /also-never-render/);
  assert.doesNotMatch(html, /secret-profile/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});

test("falls back to legacy matrices and findings", () => {
  const report = v2Report();
  report.schemaVersion = undefined;
  report.configuration = undefined;
  report.pointsComparisons = undefined;
  report.simulation.scenarios = undefined;
  report.simulation.matrices = [
    {
      opponentName: "Legacy opponent",
      cells: [
        {
          attacker: "Blade Champion",
          target: "Immortals",
          direction: "player-to-opponent",
          killProbability: 0.52,
          expectedDamage: 6.1,
          damagePer100Points: 5.4,
        },
      ],
    },
  ];
  report.findings = undefined;
  report.changeCandidates = undefined;
  report.strengths = ["Blade Champion is the best attacker."];

  const html = renderTesseraMatchupReportHtml(report);
  assert.match(html, /Legacy opponent/);
  assert.match(html, /Blade Champion is the best attacker/);
  assert.match(html, /Legacy report/);
  assert.match(html, /Legacy matrix data/);
});

test("renders revision summary, before/after sections, and safe deltas", () => {
  const report: TesseraRevisionComparisonReport = {
    schemaVersion: 2,
    runId: "revision-run",
    generatedAt: "2026-07-28T17:00:00.000Z",
    baselineReportPath: "/private/tmp/baseline-report.json",
    baselineRunId: "safe-run",
    revisedRosterFingerprint: "revised-fingerprint",
    revisedReports: [v2Report()],
    deltas: [
      {
        opponentName: "Mirror Match",
        phase: "fight",
        metric: "mean-damage",
        direction: "player-to-opponent",
        attackerInstanceId: "player-allarus-1",
        targetInstanceId: "opponent-guard-1",
        before: 7.1,
        after: 8.4,
        change: 1.3,
        classification: "improved",
      },
    ],
    summary: {
      improved: 1,
      worsened: 0,
      unchanged: 0,
      ambiguous: 0,
    },
    limitations: ["Directional calculations only."],
    warnings: [],
    artifacts: [],
  };

  const html = renderTesseraRevisionComparisonHtml(report);
  assert.match(html, /Delta summary/);
  assert.match(html, /id="before"/);
  assert.match(html, /id="after"/);
  assert.match(html, /Before\/after deltas/);
  assert.match(html, /Revised matchup heatmap/);
  assert.match(html, /id="delta-result-filter"/);
  assert.match(html, /baseline-report\.json/);
  assert.match(html, /"classification":"improved"/);
  assert.doesNotMatch(html, /\/private\/tmp\/baseline-report\.json/);
  assert.doesNotMatch(html, /<\/script><script>alert\(/i);
});
