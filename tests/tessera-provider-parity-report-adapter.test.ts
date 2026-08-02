import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraCellUncertainty,
  TesseraMatchupReport,
  TesseraMetric,
  TesseraMetricValues,
  TesseraUnitInstance,
} from "../lib/rosterpilot/types";
import {
  compareTesseraProviderParity,
  type TesseraParityProvider,
} from "../local/tessera/provider-parity";
import { adaptTesseraMatchupReportToProviderParityRun } from "../local/tessera/provider-parity-report-adapter";
import {
  providerParityModelCapabilityFixture,
  providerParityNamedCombatSnapshotFixture,
} from "./fixtures/tessera-provider-parity-combat";

const NORMALIZED_INPUT_SHA256 = "a".repeat(64);

function unit(
  instanceId: string,
  side: "player" | "opponent",
  name: string,
): TesseraUnitInstance {
  return {
    instanceId,
    selectionId: instanceId,
    side,
    name,
    label: name,
    ordinal: 1,
    modelCount: 5,
    points: 50,
    tags: [],
  };
}

function values(metric: TesseraMetric, value: number): TesseraMetricValues {
  return {
    wipeProbability: metric === "wipe-probability" ? value : null,
    halfWipeProbability:
      metric === "half-wipe-probability" ? value : null,
    meanKills: metric === "mean-kills" ? value : null,
    meanDamage: metric === "mean-damage" ? value : null,
    damagePer100Points: null,
  };
}

function completeReport(options: {
  provider: TesseraParityProvider;
  metric: TesseraMetric;
  value: number;
  uncertainty?: TesseraCellUncertainty;
}): TesseraMatchupReport {
  const attacker = unit(
    "custodes-witchseekers-1",
    "player",
    "Witchseekers",
  );
  const target = unit("aeldari-troupe-1", "opponent", "Troupe");
  const scenarioId = `shooting:player-to-opponent:${options.metric}`;
  return {
    schemaVersion: 4,
    runId: `${options.provider}-fixture`,
    generatedAt: "2026-08-02T00:00:00.000Z",
    source:
      options.provider === "local-engine"
        ? "tessera-local-engine"
        : "tessera-ui",
    status: "complete",
    profilePolicyHash: "profile-policy-v1",
    player: {} as TesseraMatchupReport["player"],
    opponents: [],
    simulation: {
      requested: true,
      executionMode: "simulate",
      experimental: true,
      status: "complete",
      selectedBackend: options.provider,
      providerIdentity:
        options.provider === "local-engine"
          ? {
              schemaVersion: 1,
              provider: "local-engine",
              engine: "tessera-engine",
              repository: "Tessera-cmd/tessera-engine",
              commit: "1".repeat(40),
              tree: "2".repeat(40),
              sourceSha256: "3".repeat(64),
              adapterVersion: "fixture-v1",
              compilerVersion: "fixture-v1",
              inputSchemaVersion: 1,
              capabilityManifestSha256: "4".repeat(64),
              promotion: "candidate",
              licenseState: "evaluation-only",
            }
          : {
              schemaVersion: 1,
              provider: "website",
              engine: "tessera-ui",
              uiIdentity: "ui-fixture",
              adapterVersion: "fixture-v1",
            },
      engine:
        options.provider === "local-engine"
          ? "tessera-engine"
          : "tessera-ui",
      settings: { iterations: "10000", rules: "matched-play" },
      scenarios: [
        {
          scenarioId,
          opponentName: "Aeldari fixture",
          phase: "shooting",
          direction: "player-to-opponent",
          metrics: [options.metric],
          metricRuns: [
            {
              metric: options.metric,
              iterations: 10_000,
              settings: {
                iterations: "10000",
                rules: "matched-play",
              },
            },
          ],
          iterations: 10_000,
          settings: { iterations: "10000", rules: "matched-play" },
          cells: [
            {
              attacker,
              target,
              values: values(options.metric, options.value),
              ...(options.uncertainty
                ? { uncertainty: { [options.metric]: options.uncertainty } }
                : {}),
              confidence: "high",
              warningRefs: [],
            },
          ],
          status: "complete",
          warnings: [],
        },
      ],
      matrices: [],
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    limitations: [],
    warnings: [],
    artifacts: [],
  };
}

function adapterOptions(provider: TesseraParityProvider) {
  return {
    provider,
    providerIdentity:
      provider === "local-engine" ? "commit:fixture" : "ui:fixture",
    dataBundleId: "bundle-verified-fixture",
    normalizedInputSha256: NORMALIZED_INPUT_SHA256,
    modelCapabilityEnvelope: providerParityModelCapabilityFixture(),
    combatSnapshot: providerParityNamedCombatSnapshotFixture(),
  };
}

test("complete report adapter produces runs usable by provider parity", () => {
  const local = adaptTesseraMatchupReportToProviderParityRun(
    completeReport({
      provider: "local-engine",
      metric: "wipe-probability",
      value: 0.5,
    }),
    adapterOptions("local-engine"),
  );
  const website = adaptTesseraMatchupReportToProviderParityRun(
    completeReport({
      provider: "website",
      metric: "wipe-probability",
      value: 0.505,
    }),
    adapterOptions("website"),
  );

  assert.equal(local.ok, true);
  assert.equal(website.ok, true);
  if (!local.ok || !website.ok) return;
  assert.equal(local.run.cells[0].sampleCount, 10_000);
  assert.equal(local.run.cells[0].sampleVariance, undefined);
  const parity = compareTesseraProviderParity(local.run, website.run);
  assert.equal(parity.outcome, "pass");
});

test("report adapter retains mean variance without inventing standard error", () => {
  const adapted = adaptTesseraMatchupReportToProviderParityRun(
    completeReport({
      provider: "local-engine",
      metric: "mean-damage",
      value: 5,
      uncertainty: {
        sampleCount: 10_000,
        standardDeviation: 2,
        standardError: null,
        completeness: "complete",
      },
    }),
    adapterOptions("local-engine"),
  );

  assert.equal(adapted.ok, true);
  if (!adapted.ok) return;
  assert.equal(adapted.run.cells[0].sampleVariance, 4);
  assert.equal(adapted.run.cells[0].standardError, undefined);
});

test("report adapter rejects mean cells when uncertainty is absent", () => {
  const adapted = adaptTesseraMatchupReportToProviderParityRun(
    completeReport({
      provider: "website",
      metric: "mean-kills",
      value: 2,
    }),
    adapterOptions("website"),
  );

  assert.equal(adapted.ok, false);
  if (adapted.ok) return;
  assert.equal(adapted.run, null);
  assert.ok(
    adapted.issues.some(
      (entry) => entry.code === "REPORT_CELL_UNCERTAINTY_INCOMPLETE",
    ),
  );
});

test("report adapter rejects partial reports before building parity evidence", () => {
  const report = completeReport({
    provider: "local-engine",
    metric: "wipe-probability",
    value: 0.5,
  });
  report.status = "partial";
  const adapted = adaptTesseraMatchupReportToProviderParityRun(
    report,
    adapterOptions("local-engine"),
  );

  assert.equal(adapted.ok, false);
  if (adapted.ok) return;
  assert.ok(
    adapted.issues.some((entry) => entry.code === "REPORT_NOT_COMPLETE"),
  );
});
