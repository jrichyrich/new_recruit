import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraFrozenScenarioContract,
  TesseraMatchupReport,
} from "../lib/rosterpilot";
import {
  normalizeTesseraReportScenarioContractForParity,
  rebindTesseraScenarioContractProvider,
} from "../local/tessera/provider-parity-scenario-contract";
import {
  tesseraScenarioContractSha256,
} from "../local/tessera/scenario-contract";

function reportWithSettings(
  settings: Record<string, string>,
): TesseraMatchupReport {
  const contract: TesseraFrozenScenarioContract[] = [{
    phase: "shooting",
    direction: "player-to-opponent",
    metric: "wipe-probability",
    settings,
    iterations: 10_000,
  }];
  return {
    scenarioContract: contract,
    scenarioContractSha256: tesseraScenarioContractSha256(contract),
    simulation: {
      scenarios: [{
        scenarioId: "shooting:player-to-opponent",
        opponentName: "Aeldari",
        phase: "shooting",
        direction: "player-to-opponent",
        metrics: ["wipe-probability"],
        metricRuns: [{
          metric: "wipe-probability",
          settings: { ...settings },
          iterations: 10_000,
        }],
        settings: { ...settings },
        iterations: 10_000,
        cells: [],
        status: "complete",
        warnings: [],
      }],
    },
  } as unknown as TesseraMatchupReport;
}

test("provider-only raw settings normalize without masking gameplay settings", () => {
  const local = normalizeTesseraReportScenarioContractForParity(
    reportWithSettings({
      provider: "local-engine",
      phase: "shooting",
      targetInCover: "false",
      charging: "false",
      withinRapidFireRange: "false",
      withinMeltaRange: "false",
      remainedStationary: "false",
      indirectFire: "false",
    }),
  );
  const website = normalizeTesseraReportScenarioContractForParity(
    reportWithSettings({
      "Target in cover": "No",
      "Attacker charging": "Off",
      "Rapid fire range": "false",
      "Melta range": "0",
      Stationary: "disabled",
      "Indirect fire": "No",
    }),
  );

  assert.equal(local.ok, true);
  assert.equal(website.ok, true);
  if (!local.ok || !website.ok) return;
  assert.notEqual(
    local.rawContractSha256,
    website.rawContractSha256,
  );
  assert.equal(
    local.normalizedContractSha256,
    website.normalizedContractSha256,
  );
  assert.deepEqual(local.contract[0].settings, {
    charging: "false",
    indirectFire: "false",
    remainedStationary: "false",
    targetInCover: "false",
    withinMeltaRange: "false",
    withinRapidFireRange: "false",
  });
});

test("unknown gameplay settings fail closed with a mapping gap", () => {
  const result = normalizeTesseraReportScenarioContractForParity(
    reportWithSettings({
      provider: "website",
      "Critical hit mode": "5+",
    }),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.issues.some(
      (entry) => entry.code === "PROVIDER_SETTING_MAPPING_MISSING",
    ),
  );
});

test("website contracts rebind to canonical local-engine settings without gameplay drift", () => {
  const websiteContract: TesseraFrozenScenarioContract[] = [{
    phase: "fight",
    direction: "opponent-to-player",
    metric: "mean-damage",
    settings: {
      provider: "website",
      "Target in cover": "Yes",
      "Attacker charging": "On",
      "Rapid fire range": "0",
      "Melta range": "false",
      Stationary: "disabled",
      "Indirect fire": "No",
    },
    iterations: 25_000,
  }];

  const localContract = rebindTesseraScenarioContractProvider(
    websiteContract,
    "website",
    "local-engine",
  );

  assert.deepEqual(localContract, [{
    phase: "fight",
    direction: "opponent-to-player",
    metric: "mean-damage",
    settings: {
      charging: "true",
      indirectFire: "false",
      provider: "local-engine",
      remainedStationary: "false",
      targetInCover: "true",
      withinMeltaRange: "false",
      withinRapidFireRange: "false",
    },
    iterations: 25_000,
  }]);
  const website = normalizeTesseraReportScenarioContractForParity(
    reportWithSettings(websiteContract[0].settings),
  );
  const local = normalizeTesseraReportScenarioContractForParity(
    reportWithSettings(localContract[0].settings),
  );
  assert.equal(website.ok, true);
  assert.equal(local.ok, true);
  if (!website.ok || !local.ok) return;
  assert.equal(
    website.normalizedContractSha256,
    local.normalizedContractSha256,
  );
});

test("provider rebinding rejects source identity and mapping ambiguity", () => {
  assert.throws(
    () => rebindTesseraScenarioContractProvider(
      [{
        phase: "shooting",
        direction: "player-to-opponent",
        metric: "wipe-probability",
        settings: {
          provider: "local-engine",
        },
        iterations: 10_000,
      }],
      "website",
      "local-engine",
    ),
    /does not declare a single website source provider/,
  );
  assert.throws(
    () => rebindTesseraScenarioContractProvider(
      [{
        phase: "shooting",
        direction: "player-to-opponent",
        metric: "wipe-probability",
        settings: {
          provider: "website",
          "Unmapped gameplay switch": "on",
        },
        iterations: 10_000,
      }],
      "website",
      "local-engine",
    ),
    /PROVIDER_SETTING_MAPPING_MISSING/,
  );
});
