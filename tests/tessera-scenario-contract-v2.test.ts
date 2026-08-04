import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalTesseraScenarioPolicyContractV2,
  defaultTesseraCombatPolicyV2,
  localTesseraScenarioPolicyContractV2,
  migrateTesseraScenarioContractV1ToV2,
  TESSERA_MAX_ATTACHMENT_PLANS_DEFAULT,
  TESSERA_MAX_JOINT_VARIANTS_DEFAULT,
  tesseraScenarioPolicyContractV2Sha256,
  type TesseraCombatPolicyV2,
} from "../local/tessera/scenario-contract-v2";
import { localTesseraScenarioContract } from "../local/tessera/scenario-contract";

function envelopePolicy(): TesseraCombatPolicyV2 {
  return {
    modelingMode: "rules-aware",
    activations: {
      mode: "envelope",
      options: [
        { id: "blessing:z", groupId: "blessings", resourceCost: 1 },
        { id: "blessing:a", groupId: "blessings", resourceCost: 1 },
      ],
      groups: [{ id: "blessings", maximumActive: 1 }],
      resourceBudget: 1,
      includeNoOptionsBaseline: true,
    },
    attachments: {
      mode: "enumerate",
      bindings: [{
        leaderSelectionId: "leader:b",
        bodyguardSelectionId: "bodyguard:b",
        supportingSelectionIds: ["support:z", "support:a"],
      }, {
        leaderSelectionId: "leader:a",
        bodyguardSelectionId: "bodyguard:a",
        supportingSelectionIds: [],
      }],
    },
    limits: {
      maxAttachmentPlans: 16,
      maxJointVariants: 64,
    },
  };
}

test("v2 contracts canonicalize set-like policy entries and hash stably", () => {
  const first = localTesseraScenarioPolicyContractV2(
    2_000,
    ["shooting", "fight"],
    ["mean-damage", "wipe-probability"],
    envelopePolicy(),
  );
  const second = canonicalTesseraScenarioPolicyContractV2({
    ...first,
    scenarios: [...first.scenarios].reverse(),
    policy: {
      ...first.policy,
      activations: first.policy.activations.mode === "envelope"
        ? {
            ...first.policy.activations,
            options: [...first.policy.activations.options].reverse(),
            groups: [...first.policy.activations.groups].reverse(),
          }
        : first.policy.activations,
      attachments: {
        ...first.policy.attachments,
        bindings: [...first.policy.attachments.bindings]
          .reverse()
          .map((binding) => ({
            ...binding,
            supportingSelectionIds: [
              ...binding.supportingSelectionIds,
            ].reverse(),
          })),
      },
    },
  });

  assert.deepEqual(second, first);
  assert.equal(
    tesseraScenarioPolicyContractV2Sha256(second),
    tesseraScenarioPolicyContractV2Sha256(first),
  );
  assert.match(tesseraScenarioPolicyContractV2Sha256(first), /^[a-f0-9]{64}$/);
});

test("v2 engagement context preserves explicit unknown states", () => {
  const baseline = localTesseraScenarioPolicyContractV2(
    1_000,
    ["shooting"],
    ["mean-damage"],
  );
  const unknown = canonicalTesseraScenarioPolicyContractV2({
    ...baseline,
    scenarios: baseline.scenarios.map((scenario) => ({
      ...scenario,
      engagement: {
        ...scenario.engagement,
        targetInCover: "unknown",
      },
    })),
  });

  assert.equal(unknown.scenarios[0].engagement.targetInCover, "unknown");
  assert.equal(unknown.scenarios[0].engagement.distanceInches, "unknown");
  assert.equal(unknown.scenarios[0].engagement.timing, "unknown");
  assert.equal(unknown.scenarios[0].engagement.objectiveControl, "unknown");
  assert.notEqual(
    tesseraScenarioPolicyContractV2Sha256(unknown),
    tesseraScenarioPolicyContractV2Sha256(baseline),
  );
});

test("v1 migration freezes base-profile and no-option semantics", () => {
  const v1 = localTesseraScenarioContract(
    777,
    ["fight"],
    ["mean-damage"],
  );
  const migrated = migrateTesseraScenarioContractV1ToV2(v1);

  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.policy.modelingMode, "base-profile");
  assert.equal(migrated.policy.activations.mode, "selected");
  if (migrated.policy.activations.mode === "selected") {
    assert.deepEqual(migrated.policy.activations.options, []);
    assert.deepEqual(migrated.policy.activations.selectedIds, []);
  }
  assert.equal(migrated.policy.attachments.mode, "selected");
  assert.deepEqual(migrated.policy.attachments.bindings, []);
  assert.deepEqual(migrated.policy.limits, {
    maxAttachmentPlans: TESSERA_MAX_ATTACHMENT_PLANS_DEFAULT,
    maxJointVariants: TESSERA_MAX_JOINT_VARIANTS_DEFAULT,
  });
  assert.equal(migrated.scenarios[0].engagement.charging, true);
  assert.equal(migrated.scenarios[0].engagement.targetInCover, false);
  assert.equal(migrated.scenarios[0].engagement.distanceInches, "unknown");
  assert.equal(migrated.scenarios[0].engagement.timing, "unknown");
  assert.equal(migrated.scenarios[0].engagement.armyAbilityActive, "unknown");
  assert.equal(migrated.scenarios[0].iterations, 777);
});

test("exact v1 distance, timing, and condition values migrate without guessing", () => {
  const v1 = localTesseraScenarioContract(
    321,
    ["shooting"],
    ["mean-damage"],
  );
  const migrated = migrateTesseraScenarioContractV1ToV2([{
    ...v1[0],
    settings: {
      ...v1[0].settings,
      distanceInches: "12.5",
      timing: "start-of-phase",
      objectiveControl: "true",
      armyAbilityActive: "false",
      targetCondition: "unknown",
      belowStrength: "true",
      damaged: "false",
    },
  }]);

  assert.deepEqual(
    {
      distanceInches: migrated.scenarios[0].engagement.distanceInches,
      timing: migrated.scenarios[0].engagement.timing,
      objectiveControl: migrated.scenarios[0].engagement.objectiveControl,
      armyAbilityActive:
        migrated.scenarios[0].engagement.armyAbilityActive,
      targetCondition: migrated.scenarios[0].engagement.targetCondition,
      belowStrength: migrated.scenarios[0].engagement.belowStrength,
      damaged: migrated.scenarios[0].engagement.damaged,
    },
    {
      distanceInches: 12.5,
      timing: "start-of-phase",
      objectiveControl: true,
      armyAbilityActive: false,
      targetCondition: "unknown",
      belowStrength: true,
      damaged: false,
    },
  );
});

test("v2 defaults retain the current baseline and enumeration caps", () => {
  const policy = defaultTesseraCombatPolicyV2();
  const contract = localTesseraScenarioPolicyContractV2(1_000);

  assert.equal(contract.scenarios.length, 16);
  assert.equal(policy.modelingMode, "rules-aware");
  assert.equal(policy.activations.mode, "envelope");
  assert.equal(policy.attachments.mode, "enumerate");
  assert.deepEqual(policy.limits, {
    maxAttachmentPlans: 16,
    maxJointVariants: 64,
  });
  assert.equal(
    contract.scenarios.find((scenario) => scenario.phase === "fight")
      ?.engagement.charging,
    true,
  );
  assert.equal(
    contract.scenarios.find((scenario) => scenario.phase === "shooting")
      ?.engagement.charging,
    false,
  );
});

test("v2 contracts reject invalid state, policy, resource, and binding values", () => {
  const baseline = localTesseraScenarioPolicyContractV2(
    1_000,
    ["shooting"],
    ["mean-damage"],
  );
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV2({
      ...baseline,
      scenarios: baseline.scenarios.map((scenario) => ({
        ...scenario,
        engagement: {
          ...scenario.engagement,
          charging: "maybe",
        },
      })),
    }),
    /engagement.*invalid/i,
  );

  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV2({
      ...baseline,
      scenarios: baseline.scenarios.map((scenario) => ({
        ...scenario,
        engagement: {
          ...scenario.engagement,
          distanceInches: -1,
        },
      })),
    }),
    /distanceInches.*greater than or equal to 0/i,
  );

  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV2({
      ...baseline,
      scenarios: baseline.scenarios.map((scenario) => ({
        ...scenario,
        engagement: {
          ...scenario.engagement,
          timing: " ",
        },
      })),
    }),
    /timing.*whitespace/i,
  );

  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV2({
      ...baseline,
      policy: {
        ...baseline.policy,
        activations: {
          mode: "selected",
          options: [{
            id: "stratagem:a",
            groupId: "stratagem",
            resourceCost: 2,
          }],
          groups: [{ id: "stratagem", maximumActive: 1 }],
          resourceBudget: 1,
          selectedIds: ["stratagem:a"],
        },
      },
    }),
    /resource budget/i,
  );

  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV2({
      ...baseline,
      policy: {
        ...baseline.policy,
        attachments: {
          mode: "selected",
          bindings: [{
            leaderSelectionId: "same-unit",
            bodyguardSelectionId: "same-unit",
            supportingSelectionIds: [],
          }],
        },
      },
    }),
    /attached to itself/i,
  );

  assert.throws(
    () => migrateTesseraScenarioContractV1ToV2([{
      ...localTesseraScenarioContract(
        100,
        ["shooting"],
        ["mean-damage"],
      )[0],
      settings: { unsupportedToggle: "true" },
    }]),
    /semantic loss/i,
  );
});
