import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraStressRevisionReport,
  TesseraStressTestReport,
} from "../lib/rosterpilot/types";
import {
  renderTesseraStressRevisionReportHtml,
  renderTesseraStressTestReportHtml,
} from "../local/tessera/stress-report";

function stressReport(): TesseraStressTestReport {
  const maliciousTemplate =
    'balanced-mixed</script><script>alert("embedded")</script>';
  return {
    schemaVersion: 2,
    reportKind: "tessera-stress-test",
    runId: 'stress</script><script>alert("run")</script>',
    generatedAt: "2026-07-28T19:00:00.000Z",
    source: "tessera-ui",
    status: "degraded",
    player: {
      rosterId: "player",
      rosterName: "Auric & Bastion",
      listUrl: "https://example.test/list",
      sourceRoszPath: "/tmp/player.rosz",
      enrichedRoszPath: "/tmp/player-enriched.rosz",
      fingerprint: "player-safe-fingerprint",
      summary: {
        rosterName: "Auric & Bastion",
        factionName: "Adeptus Custodes",
        totalPoints: 1000,
        generatedBy: "New Recruit",
        profileCount: 20,
        weaponProfileCount: 10,
        units: [{ name: "Allarus Custodians", modelCount: 3 }],
      },
      units: [],
    },
    opponentFactionId: "aeldari",
    configuration: {
      suite: "diverse-9",
      analysisStrategy: "staged",
      pointsTolerancePercent: 5,
      proxyWeights: "equal",
      screeningMetric: "half-wipe-probability",
      screeningPhases: ["shooting", "fight"],
      screeningDirections: [
        "player-to-opponent",
        "opponent-to-player",
      ],
      revisionMateriality: 0.01,
      premiumKey: "never-render-premium-key",
    },
    suite: "diverse-9",
    portfolio: {
      schemaVersion: 1,
      generatorVersion: "stress-portfolio-v1",
      suite: "diverse-9",
      factionId: "aeldari",
      factionName: "Aeldari",
      pointsLimit: 1000,
      pointsTolerancePercent: 5,
      sourceData: {
        package: "@alpaca-software/40kdc-data",
        version: "1.2.0",
        edition: "11th",
        dataslate: "2026-Q3",
        releaseId: "2026-07-28.1",
        newRecruit: {
          repository: "BSData/wh40k-11e",
          commit: "2ce1f8b000000000000000000000000000000000",
          gameSystemRevision: 1,
          catalogueRevision: 2,
        },
        official: {
          mfmVersion: "3.1",
          updatedAt: "2026-07-28",
          contentSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        browserProfileDirectory: "/tmp/never-render-profile",
      },
      items: [
        {
          templateId: maliciousTemplate,
          posture: "balanced-control",
          composition: "mixed",
          status: "ready",
          roster: {
            name: "Balanced Aeldari",
            totalPoints: 995,
          },
          fingerprint: "opponent-safe-fingerprint",
          structuralDistance: 0.7,
          detachmentId: "battle-host",
          allowNamedCharacters: false,
          traits: {
            modelCount: 28,
            unitCount: 8,
            pointsUtilization: 0.995,
            hordeModelCount: 10,
            hordePoints: 200,
            hordePointsPercent: 0.2,
            eliteHeavyPoints: 390,
            eliteHeavyPointsPercent: 0.39,
            tagCounts: {
              mobility: 3,
              durability: 2,
              objective: 4,
              shooting: 4,
              melee: 1,
              elite: 2,
              horde: 1,
            },
          },
          omissionReason: null,
          warnings: [],
        },
        {
          templateId: "assault-mass",
          posture: "assault-pressure",
          composition: "mass",
          status: "unavailable",
          roster: null,
          fingerprint: null,
          structuralDistance: null,
          detachmentId: null,
          allowNamedCharacters: null,
          traits: null,
          omissionReason: "No legal mapped roster met the mass threshold.",
          warnings: [],
        },
      ],
      coverage: {
        intended: 9,
        ready: 8,
        unavailable: 1,
        representedPostures: [
          "balanced-control",
          "ranged-pressure",
          "assault-pressure",
        ],
        representedCompositions: ["mixed", "mass", "elite-heavy"],
      },
    },
    frozenOpponentArtifacts: [
      {
        templateId: maliciousTemplate,
        rosterFingerprint: "frozen-roster-fingerprint",
        enrichedRoszPath:
          "/private/tmp/never-render-frozen/aeldari-enriched.rosz",
        sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
    stageProvenance: {
      screening: {
        analysisMode: "quick",
        phases: ["shooting", "fight"],
        metrics: ["half-wipe-probability"],
        directions: [
          "player-to-opponent",
          "opponent-to-player",
        ],
        settings: {
          diceMode: "balanced",
          cacheFile:
            "/private/tmp/never-render-settings/screening-cache.json",
          premiumKey: "never-render-stage-premium-key",
          browserProfileDirectory:
            "/private/tmp/never-render-stage-profile",
        },
        iterations: [1000],
        proxyRuns: [
          {
            templateId: maliciousTemplate,
            settings: {
              terrain: "dense",
              authorization: "never-render-authorization",
            },
            iterations: [1000],
            scenarios: [
              {
                phase: "shooting",
                metric: "half-wipe-probability",
                direction: "player-to-opponent",
                settings: {
                  terrain: "dense",
                  token: "never-render-scenario-token",
                },
                iterations: 1000,
              },
              {
                phase: "fight",
                metric: "half-wipe-probability",
                direction: "opponent-to-player",
                settings: { terrain: "dense" },
                iterations: 1000,
              },
            ],
          },
        ],
      },
      deepDive: {
        analysisMode: "full",
        phases: ["shooting", "fight"],
        metrics: ["wipe-probability", "mean-kills", "mean-damage"],
        directions: [
          "player-to-opponent",
          "opponent-to-player",
        ],
        settings: {
          diceMode: "balanced",
          token: "never-render-stage-token",
        },
        iterations: [2000],
        proxyRuns: [
          {
            templateId: maliciousTemplate,
            settings: { terrain: "dense" },
            iterations: [2000],
            scenarios: [
              {
                phase: "shooting",
                metric: "mean-damage",
                direction: "player-to-opponent",
                settings: { terrain: "dense" },
                iterations: 2000,
              },
              {
                phase: "fight",
                metric: "mean-damage",
                direction: "opponent-to-player",
                settings: { terrain: "dense" },
                iterations: 2000,
              },
            ],
          },
        ],
      },
    },
    screeningReport: null,
    deepDiveReport: null,
    representatives: [
      {
        kind: "stress",
        templateId: maliciousTemplate,
        rationale: "Highest combined coverage deficit and exposure.",
      },
    ],
    robustness: {
      scoreDefinitionVersion: "stress-robustness-v1",
      halfWipeThreshold: 0.5,
      samples: [
        {
          templateId: maliciousTemplate,
          posture: "balanced-control",
          composition: "mixed",
          weight: 0.125,
          status: "confident",
          offensiveCoverage: 0.68,
          threatExposure: 0.42,
          coverageMargin: 0.26,
          shootingCoverage: 0.61,
          fightCoverage: 0.68,
          shootingExposure: 0.42,
          fightExposure: 0.31,
          playerPointCoverage: 1,
          opponentPointCoverage: 0.95,
          warningRefs: [],
        },
      ],
      offense: {
        sampleCount: 8,
        usableWeight: 1,
        worst: 0.41,
        lowerTail: 0.44,
        median: 0.64,
        mean: 0.62,
        best: 0.81,
      },
      exposure: {
        sampleCount: 8,
        usableWeight: 1,
        worst: 0.67,
        lowerTail: 0.63,
        median: 0.44,
        mean: 0.46,
        best: 0.2,
      },
      margin: {
        sampleCount: 8,
        usableWeight: 1,
        worst: -0.22,
        lowerTail: -0.18,
        median: 0.18,
        mean: 0.16,
        best: 0.52,
      },
      phaseDependence: {
        shootingCoverageMean: 0.48,
        fightCoverageMean: 0.62,
        shootingExposureMean: 0.43,
        fightExposureMean: 0.39,
      },
      units: [
        {
          instanceId: "player-allarus-1",
          label: "Allarus Custodians",
          points: 330,
          answerBreadth: 0.75,
          exposedWeight: 0.25,
          supportingTemplateIds: [maliciousTemplate],
        },
      ],
      confidence: "review",
      warnings: [],
    },
    missionReadiness: {
      schemaVersion: 1,
      scoreDefinitionVersion: "mission-readiness-v1",
      rosterFingerprint: "player-safe-fingerprint",
      overallBand: "amber",
      dimensions: [
        {
          id: "scoring-breadth",
          label: "Scoring breadth",
          band: "green",
          confidence: "high",
          metrics: [
            {
              id: "scoreable-units",
              label: "Scoreable units",
              value: 6,
              normalizedValue: 6,
              unit: "units",
              redBelow: 4,
              greenAtOrAbove: 6,
              selectionIds: ["player-allarus-1"],
              sourcePaths: ["roster.units"],
            },
          ],
          providerSelectionIds: ["player-allarus-1"],
          evidence: ["Six independent scoring units."],
        },
      ],
      primaryMissions: [],
      secondaryCards: [],
      sourceData: {
        package: "@alpaca-software/40kdc-data",
        version: "1.2.0",
        edition: "11th",
        dataslate: "2026-Q3",
        releaseId: "2026-07-28.1",
        newRecruit: {
          repository: "BSData/wh40k-11e",
          commit: "2ce1f8b000000000000000000000000000000000",
          gameSystemRevision: 1,
          catalogueRevision: 2,
        },
        official: {
          mfmVersion: "3.1",
          updatedAt: "2026-07-28",
          contentSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      warnings: [],
    },
    findings: [
      {
        findingId: "finding-1",
        kind: "robust-answer",
        severity: "info",
        confidence: "high",
        summary:
          'Allarus remain effective.</script><script>alert("finding")</script>',
        templateIds: [maliciousTemplate],
        supportingWeight: 0.75,
        unitInstanceIds: ["player-allarus-1"],
      },
    ],
    changeCandidates: [
      {
        candidateId: "candidate-1",
        title: "Add a second mobile scoring unit",
        rationale: "Improves reach without creating a mission-readiness red.",
        operation: {
          type: "set-model-count",
          selectionId: "player-allarus-1",
          modelCount: 2,
        },
        beforePoints: 1000,
        afterPoints: 995,
        rosterFingerprint: "candidate-fingerprint",
        evidenceFindingIds: ["finding-1"],
      },
    ],
    limitations: ["Directional combat math only."],
    warnings: ["secret token=never-render-warning"],
    artifacts: [],
  } as unknown as TesseraStressTestReport;
}

test("renders a complete, safe faction stress-test report", () => {
  const html = renderTesseraStressTestReportHtml(stressReport());

  assert.match(html, /Suite coverage/);
  assert.match(html, /Robustness ranges/);
  assert.match(html, /Coverage versus exposure/);
  assert.match(html, /Representative deep dives/);
  assert.match(html, /Phase dependence/);
  assert.match(html, /Mission readiness/);
  assert.match(html, /Unit robustness/);
  assert.match(html, /Cross-proxy findings/);
  assert.match(html, /Candidate roster changes/);
  assert.match(html, /Provenance/);
  assert.match(html, /Simulation stage provenance/);
  assert.match(html, /Scenario pairing/);
  assert.match(
    html,
    /Shooting \/ Half Wipe Probability \/ Player To Opponent/,
  );
  assert.match(html, /Frozen opponent artifacts/);
  assert.match(html, /Revision materiality/);
  assert.match(html, /1%/);
  assert.match(html, /Half Wipe Probability/);
  assert.match(html, /1000/);
  assert.match(html, /2000/);
  assert.match(html, /frozen-roster-fingerprint/);
  assert.match(
    html,
    /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/,
  );
  assert.match(html, /aeldari-enriched\.rosz/);
  assert.match(html, /screening-cache\.json/);
  assert.match(html, /Warnings/);
  assert.match(html, /Limitations/);
  assert.match(html, /Allarus Custodians/);
  assert.match(html, /Auric &amp; Bastion/);
  assert.match(html, /id="coverage-chart"/);
  assert.match(html, /id="report-data"/);
  assert.match(html, /\\u003c\/script\\u003e/);
  assert.doesNotMatch(html, /<\/script><script>alert\(/i);
  assert.doesNotMatch(html, /never-render-premium-key/);
  assert.doesNotMatch(html, /never-render-profile/);
  assert.doesNotMatch(html, /never-render-warning/);
  assert.doesNotMatch(html, /never-render-frozen/);
  assert.doesNotMatch(html, /never-render-settings/);
  assert.doesNotMatch(html, /never-render-stage-premium-key/);
  assert.doesNotMatch(html, /never-render-stage-profile/);
  assert.doesNotMatch(html, /never-render-authorization/);
  assert.doesNotMatch(html, /never-render-stage-token/);
  assert.doesNotMatch(html, /never-render-scenario-token/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});

test("renders paired stress revision deltas and the mission guardrail", () => {
  const baseline = stressReport();
  const revised = structuredClone(baseline);
  revised.runId = "stress-revised";
  revised.player.fingerprint = "revised-safe-fingerprint";
  if (revised.robustness) {
    revised.robustness.offense.mean = 0.67;
    revised.robustness.exposure.mean = 0.41;
    revised.robustness.margin.mean = 0.26;
    revised.robustness.samples[0].offensiveCoverage = 0.67;
    revised.robustness.samples[0].threatExposure = 0.4;
    revised.robustness.samples[0].coverageMargin = 0.27;
  }
  revised.missionReadiness.overallBand = "green";

  const report = {
    schemaVersion: 2,
    reportKind: "tessera-stress-revision",
    runId: "revision-run",
    generatedAt: "2026-07-28T20:00:00.000Z",
    baselineReportPath: "/private/tmp/private-baseline.json",
    baselineRunId: baseline.runId,
    revisedRosterFingerprint: "revised-safe-fingerprint",
    baseline,
    revised,
    sampleDeltas: [
      {
        templateId: "balanced-mixed",
        before: baseline.robustness?.samples[0] ?? null,
        after: revised.robustness?.samples[0] ?? null,
        offenseChange: -0.01,
        exposureChange: -0.02,
        marginChange: 0.01,
        classification: "improved",
      },
    ],
    missionReadinessGuardrail: {
      accepted: false,
      reasons: ["The revision removed the sole home-objective holder."],
      baselineBand: "amber",
      revisedBand: "green",
      newRedDimensions: ["home-continuity"],
      removedEssentialProviders: ["player-home-1"],
    },
    summary: {
      improved: 1,
      worsened: 0,
      unchanged: 0,
      ambiguous: 0,
      conclusion: "suppressed",
    },
    limitations: ["No win probability is calculated."],
    warnings: [],
    artifacts: [],
  } satisfies TesseraStressRevisionReport;

  const html = renderTesseraStressRevisionReportHtml(report);

  assert.match(html, /Frozen portfolio pairing/);
  assert.match(html, /Aggregate robustness deltas/);
  assert.match(html, /Paired opponent deltas/);
  assert.match(html, /Offensive coverage/);
  assert.match(html, /Threat exposure/);
  assert.match(
    html,
    /balanced-mixed · Offensive coverage<\/th>\s*<td>68%<\/td><td>67%<\/td><td>-1%<\/td><td><span class="badge warn">worsened/,
  );
  assert.match(
    html,
    /balanced-mixed · Threat exposure<\/th>\s*<td>42%<\/td><td>40%<\/td><td>-2%<\/td><td><span class="badge good">improved/,
  );
  assert.match(
    html,
    /balanced-mixed · Coverage margin<\/th>\s*<td>26%<\/td><td>27%<\/td><td>1%<\/td><td><span class="badge good">improved/,
  );
  assert.match(html, /Mission-readiness changes/);
  assert.match(html, /Guardrail result/);
  assert.match(html, /Rejected/);
  assert.match(html, /home-objective holder/);
  assert.match(html, /private-baseline\.json/);
  assert.match(html, /Baseline stage provenance/);
  assert.match(html, /Revised stage provenance/);
  assert.match(html, /Frozen opponent artifacts/);
  assert.match(html, /Revision materiality/);
  assert.match(html, /aeldari-enriched\.rosz/);
  assert.doesNotMatch(html, /\/private\/tmp\/private-baseline\.json/);
  assert.doesNotMatch(html, /never-render-frozen/);
  assert.doesNotMatch(html, /never-render-stage-premium-key/);
  assert.doesNotMatch(html, /never-render-premium-key/);
  assert.doesNotMatch(html, /<\/script><script>alert\(/i);
});
