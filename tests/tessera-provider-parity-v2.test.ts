import assert from "node:assert/strict";
import test from "node:test";

import {
  tesseraProviderParityCombatSnapshotSha256,
  tesseraProviderParityContractSha256,
  tesseraProviderParityModelCapabilityEnvelopeSha256,
  type TesseraParityProvider,
  type TesseraProviderParityRun,
} from "../local/tessera/provider-parity";
import {
  compareTesseraProviderParityV2,
  verifyTesseraProviderParityResultV2,
  type TesseraProviderParityContractBindingV2,
  type TesseraProviderParityRunV2,
} from "../local/tessera/provider-parity-v2";
import {
  providerParityModelCapabilityFixture,
  providerParityNamedCombatSnapshotFixture,
} from "./fixtures/tessera-provider-parity-combat";

const binding: TesseraProviderParityContractBindingV2 = {
  scenarioPolicyContractV3Sha256: "1".repeat(64),
  combatBridgeV3Sha256: "2".repeat(64),
  corpusConformanceReportSha256: "3".repeat(64),
  coveringSuiteSha256: "4".repeat(64),
  coveringCaseId: "custodes-into-world-eaters",
  coveringCaseEvidenceSha256: "9".repeat(64),
  combatStateSha256: "5".repeat(64),
  playerRosterFingerprint: "player-fingerprint",
  opponentRosterFingerprint: "opponent-fingerprint",
};

function run(provider: TesseraParityProvider): TesseraProviderParityRunV2 {
  const scenarioContract = [{
    scenarioId: "shooting:player-to-opponent:mean-damage",
    phase: "shooting" as const,
    direction: "player-to-opponent" as const,
    metric: "mean-damage" as const,
    settings: { range: "18", state: "selected" },
    iterations: 10_000,
  }];
  const combatSnapshot = providerParityNamedCombatSnapshotFixture();
  const modelCapabilityEnvelope =
    providerParityModelCapabilityFixture();
  const base: TesseraProviderParityRun = {
    identity: {
      provider,
      providerIdentity:
        provider === "local-engine" ? "local-engine-fixture" : "web-fixture",
      dataBundleId: "bundle-fixture",
      normalizedInputSha256: "a".repeat(64),
      scenarioContractSha256:
        tesseraProviderParityContractSha256(scenarioContract),
      profilePolicyHash: null,
      modelCapabilityEnvelopeSha256:
        tesseraProviderParityModelCapabilityEnvelopeSha256(
          modelCapabilityEnvelope,
        ),
      combatSnapshotSha256:
        tesseraProviderParityCombatSnapshotSha256(combatSnapshot),
    },
    modelCapabilityEnvelope,
    combatSnapshot,
    scenarioContract,
    cells: [{
      scenarioId: scenarioContract[0].scenarioId,
      attackerInstanceId: "custodes-witchseekers-1",
      targetInstanceId: "aeldari-troupe-1",
      metric: "mean-damage",
      value: provider === "local-engine" ? 3.01 : 3,
      iterations: 10_000,
      sampleCount: 10_000,
      standardError: 0.01,
    }],
    winnerClassifications: [],
  };
  return {
    ...base,
    schemaVersion: 2,
    contractBinding: structuredClone(binding),
    exactReceiptSha256:
      provider === "local-engine" ? "6".repeat(64) : "7".repeat(64),
    providerStateEvidenceSha256:
      provider === "local-engine" ? "8".repeat(64) : "9".repeat(64),
  };
}

test("parity v2 binds a passing comparison to exact state, bridge, corpus, receipts, and covering case", () => {
  const result = compareTesseraProviderParityV2(
    run("local-engine"),
    run("website"),
  );
  assert.equal(result.outcome, "pass");
  assert.equal(result.eligible, true);
  assert.deepEqual(result.contractBinding, binding);
  assert.deepEqual(result.bindingIssues, []);
  assert.equal(verifyTesseraProviderParityResultV2(result), true);
});

test("parity v2 fails closed when Web captured a different exact combat state", () => {
  const local = run("local-engine");
  const website = run("website");
  website.contractBinding.combatStateSha256 = "f".repeat(64);
  const result = compareTesseraProviderParityV2(local, website);
  assert.equal(result.outcome, "ineligible");
  assert.equal(result.eligible, false);
  assert.ok(
    result.bindingIssues.some(
      (issue) => issue.field === "combatStateSha256",
    ),
  );
});
