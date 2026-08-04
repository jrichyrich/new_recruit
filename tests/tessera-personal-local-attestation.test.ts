import assert from "node:assert/strict";
import test from "node:test";

import type {
  CombatBridgeV3,
} from "../lib/rosterpilot/combat-bridge-v3";
import type {
  CombatCorpusTranslationLedgerEntryV1,
} from "../local/tessera/combat-bridge-input-v3";

import {
  createPersonalLocalParityAttestationV1,
  evaluatePersonalLocalParityAttestationV1,
  personalLocalProviderIdentitySha256,
  type PersonalLocalParityRotationV1,
} from "../local/tessera/personal-local-attestation";
import {
  createLocalTesseraEngineProvider,
  localTesseraEngineIsAutoSelectable,
  LOCAL_TESSERA_ENGINE_IDENTITY,
} from "../local/tessera/local-engine";
import {
  buildTesseraParityCoveringSuiteV2,
} from "../local/tessera/provider-parity-covering-suite-v2";

const machineIdSha256 = "1".repeat(64);
const providerIdentitySha256 = "2".repeat(64);
const bundleId = "3".repeat(64);
const coveringSuite = buildTesseraParityCoveringSuiteV2({
  corpusInventorySha256: "4".repeat(64),
  factions: [
    {
      factionId: "adeptus-custodes",
      attackerMechanicIds: ["critical-hits"],
      defenderMechanicIds: ["feel-no-pain"],
    },
    {
      factionId: "world-eaters",
      attackerMechanicIds: ["sustained-melee"],
      defenderMechanicIds: ["invulnerable-save"],
    },
  ],
});
const coverageSuiteSha256 = coveringSuite.suiteSha256;

function rotations(): PersonalLocalParityRotationV1[] {
  return [0, 1, 2, 3].map((index) => ({
    rotationId: `rotation-${index + 1}`,
    mode: index === 3 ? "enforce" : "observe",
    outcome: "pass",
    exactReceiptSha256: String(index + 5).repeat(64),
    coverageSuiteSha256,
    completedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
  }));
}

test("personal local attestation activates only after three observations and an enforced pass", () => {
  const attestation = createPersonalLocalParityAttestationV1({
    machineIdSha256,
    providerIdentitySha256,
    bundleId,
    rotations: rotations(),
    createdAt: new Date(Date.UTC(2026, 7, 4)).toISOString(),
  });
  assert.deepEqual(
    evaluatePersonalLocalParityAttestationV1({
      attestation,
      machineIdSha256,
      providerIdentitySha256,
      bundleId,
      coverageSuiteSha256,
      coveringSuite,
    }),
    {
      active: true,
      reasonCodes: [],
      qualifyingObservationPasses: 3,
      enforcedPass: true,
    },
  );
});

test("a covering-suite hash without its verified artifact cannot activate personal parity", () => {
  const attestation = createPersonalLocalParityAttestationV1({
    machineIdSha256,
    providerIdentitySha256,
    bundleId,
    rotations: rotations(),
  });
  const context = {
    attestation,
    machineIdSha256,
    providerIdentitySha256,
    bundleId,
    coverageSuiteSha256,
  };
  const evaluation = evaluatePersonalLocalParityAttestationV1(context);

  assert.equal(evaluation.active, false);
  assert.ok(
    evaluation.reasonCodes.includes(
      "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISSING",
    ),
  );
  assert.equal(localTesseraEngineIsAutoSelectable(context), false);
});

test("personal local attestation fails closed on machine drift, tampering, or no enforced rotation", () => {
  const attestation = createPersonalLocalParityAttestationV1({
    machineIdSha256,
    providerIdentitySha256,
    bundleId,
    rotations: rotations(),
  });
  const changed = structuredClone(attestation);
  changed.rotations[3].mode = "observe";
  const evaluation = evaluatePersonalLocalParityAttestationV1({
    attestation: changed,
    machineIdSha256: "9".repeat(64),
    providerIdentitySha256,
    bundleId,
    coverageSuiteSha256,
    coveringSuite,
  });
  assert.equal(evaluation.active, false);
  assert.ok(
    evaluation.reasonCodes.includes(
      "PERSONAL_LOCAL_ATTESTATION_HASH_INVALID",
    ),
  );
  assert.ok(
    evaluation.reasonCodes.includes(
      "PERSONAL_LOCAL_ATTESTATION_MACHINE_MISMATCH",
    ),
  );
  assert.ok(
    evaluation.reasonCodes.includes(
      "PERSONAL_LOCAL_ATTESTATION_ENFORCED_PASS_REQUIRED",
    ),
  );
});

test("an active personal attestation promotes only its machine-local provider instance", async () => {
  const boundProviderIdentitySha256 =
    personalLocalProviderIdentitySha256(
      LOCAL_TESSERA_ENGINE_IDENTITY,
    );
  const attestation = createPersonalLocalParityAttestationV1({
    machineIdSha256,
    providerIdentitySha256: boundProviderIdentitySha256,
    bundleId,
    rotations: rotations(),
  });
  const context = {
    attestation,
    machineIdSha256,
    providerIdentitySha256: boundProviderIdentitySha256,
    bundleId,
    coverageSuiteSha256,
    coveringSuite,
  };
  const provider = createLocalTesseraEngineProvider(undefined, {
    personalAttestation: context,
  });
  const status = await provider.getStatus();

  assert.equal(localTesseraEngineIsAutoSelectable(), false);
  assert.equal(localTesseraEngineIsAutoSelectable(context), true);
  assert.equal(status.promoted, true);
  assert.equal(status.evaluationOnly, false);
  assert.equal(status.identity.provider, "local-engine");
  if (status.identity.provider === "local-engine") {
    assert.equal(status.identity.promotion, "promoted");
    assert.equal(status.identity.licenseState, "personal-only");
  }
  assert.equal(LOCAL_TESSERA_ENGINE_IDENTITY.promotion, "candidate");

  const preflight = await provider.preflight({
    combatBridge: null,
  } as unknown as Parameters<typeof provider.preflight>[0]);
  assert.equal(preflight.ok, false);
  assert.ok(
    preflight.reasonCodes.includes(
      "TESSERA_PERSONAL_LOCAL_BRIDGE_V3_REQUIRED",
    ),
  );

  const combatBridge = {
    schemaVersion: 3,
    cells: [
      {
        cellId: "player-to-opponent",
        attacker: { factionId: "adeptus-custodes" },
        target: { factionId: "world-eaters" },
      },
      {
        cellId: "opponent-to-player",
        attacker: { factionId: "world-eaters" },
        target: { factionId: "adeptus-custodes" },
      },
    ],
    exactness: {
      corpus: {
        relevantLeaves: [{
          leafId: "new-leaf",
          sourceId: "new-source",
          disposition: "modeled",
        }],
        ruleBindings: [{
          cellId: "player-to-opponent",
          corpusSourceId: "new-source",
          perspective: "attacker",
        }],
      },
    },
  } as unknown as CombatBridgeV3;
  const combatCorpusTranslationLedger = [{
    leafId: "new-leaf",
    sourceId: "new-source",
    reviewEntryId: "exact",
    matcher: "exact-leaf",
    phases: ["shooting"],
    stateKeys: [],
    mechanicIds: ["new-unattested-mechanic"],
    disposition: "modeled",
  }] satisfies CombatCorpusTranslationLedgerEntryV1[];
  const uncoveredInput = {
    combatBridge,
    combatCorpusTranslationLedger,
  } as unknown as Parameters<typeof provider.preflight>[0];
  const uncovered = await provider.preflight(uncoveredInput);
  assert.equal(uncovered.ok, false);
  assert.ok(
    uncovered.reasonCodes.includes(
      "TESSERA_PERSONAL_LOCAL_SUITE_COVERAGE_REQUIRED",
    ),
  );
  await assert.rejects(
    async () => provider.run(uncoveredInput),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code ===
            "TESSERA_PERSONAL_LOCAL_SUITE_COVERAGE_REQUIRED",
      ),
  );
});
