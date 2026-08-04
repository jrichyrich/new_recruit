import assert from "node:assert/strict";
import test from "node:test";

import { abilities } from "@alpaca-software/40kdc-data";

import {
  MAX_COMBAT_ATTACHMENT_PLANS,
  MAX_COMBAT_JOINT_VARIANTS,
  compileCombatBridgeV2,
  defaultCombatPolicyV1,
  enumerateActivationEnvelope,
  enumerateAttachmentEnvelope,
  tesseraAdapterSupportForContribution,
  verifyCombatBridgeV2Hash,
  type BundleCombatRuleRecordV1,
  type CombatAttachmentPlanV1,
  type CombatBridgeCellInputV2,
  type CombatBundleBindingV2,
  type CombatPolicyV1,
  type CombatScenarioContextV2,
} from "../lib/rosterpilot/combat-bridge";

const bundle: CombatBundleBindingV2 = {
  bundleId: "a".repeat(64),
  engineDataSchemaVersion: 3,
  semanticAuthority: "bundle-manifest-verified",
  playerRosterId: "custodes",
  opponentRosterId: "world-eaters",
  playerRosterFingerprint: "9".repeat(64),
  opponentRosterFingerprint: "8".repeat(64),
  playerFactionId: "adeptus-custodes",
  opponentFactionId: "world-eaters",
  playerRosterRulesHash: "b".repeat(64),
  opponentRosterRulesHash: "a".repeat(64),
  playerFactionRulesHash: "c".repeat(64),
  opponentFactionRulesHash: "d".repeat(64),
  playerMappingHash: "e".repeat(64),
  opponentMappingHash: "f".repeat(64),
  portfolioHash: null,
};

function scenario(
  overrides: Partial<CombatScenarioContextV2> = {},
): CombatScenarioContextV2 {
  return {
    schemaVersion: 2,
    phase: "fight",
    distanceInches: 1,
    withinHalfRange: true,
    attackerStationary: false,
    attackerCharged: true,
    attackerAttached: false,
    targetAttached: false,
    attackerInCover: false,
    targetInCover: false,
    timing: "start-of-phase",
    objectiveState: "unknown",
    attackerStrengthState: "starting",
    targetStrengthState: "starting",
    attackerDamageState: "healthy",
    targetDamageState: "healthy",
    armyAbilityState: "unknown",
    targetConditionState: "unknown",
    ...overrides,
  };
}

function rule(input: {
  id: string;
  effect: unknown;
  side?: "attacker" | "target";
  relevance?: "combat" | "non-combat";
  phases?: Array<"shooting" | "fight">;
  phaseMappingStatus?: "verified" | "missing";
}): BundleCombatRuleRecordV1 {
  return {
    abilityId: input.id,
    abilityName: input.id,
    entityHash: `entity-${input.id}`,
    effect: input.effect,
    source:
      input.side === "target"
        ? { kind: "unit", unitId: "target-unit" }
        : { kind: "unit", unitId: "attacker-unit" },
    phases: input.phases ?? ["fight"],
    ...(input.phaseMappingStatus
      ? { phaseMappingStatus: input.phaseMappingStatus }
      : {}),
    activation: { kind: "always" },
    unsupportedRelevance: input.relevance ?? "combat",
  };
}

function unattachedPlan(
  attackerRules: BundleCombatRuleRecordV1[],
  targetRules: BundleCombatRuleRecordV1[],
) {
  return {
    attachmentPlan: { id: "unattached", attacker: [], target: [] },
    attackerRules,
    targetRules,
  };
}

function cell(
  attackerRules: BundleCombatRuleRecordV1[],
  targetRules: BundleCombatRuleRecordV1[],
  overrides: Partial<CombatBridgeCellInputV2> = {},
): CombatBridgeCellInputV2 {
  return {
    cellId: "custodes-into-world-eaters:fight:damage",
    direction: "player-to-opponent",
    metric: "mean-damage",
    attacker: {
      rosterId: "custodes",
      selectionId: "guard-1",
      unitId: "custodian-guard",
      factionId: "adeptus-custodes",
      keywords: ["Infantry", "Adeptus Custodes"],
    },
    target: {
      rosterId: "world-eaters",
      selectionId: "berzerkers-1",
      unitId: "khorne-berzerkers",
      factionId: "world-eaters",
      keywords: ["Infantry", "World Eaters"],
    },
    scenario: scenario(),
    ruleVariants: [unattachedPlan(attackerRules, targetRules)],
    ...overrides,
  };
}

test("bundle-derived rules compile in both perspectives and preserve unsupported diagnostics", async () => {
  const standVigil = rule({
    id: "stand-vigil",
    effect: {
      type: "re-roll",
      target: "unit",
      modifier: { roll: "wound", subset: "ones" },
    },
  });
  const unsupported = rule({
    id: "master-of-stances",
    effect: {
      type: "ability-grant",
      target: "unit",
      modifier: { ability: "stance" },
    },
  });
  const feelNoPain = rule({
    id: "feel-no-pain-5",
    side: "target",
    effect: {
      type: "feel-no-pain",
      target: "unit",
      modifier: { threshold: 5 },
    },
  });

  const input = {
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([unsupported, standVigil], [feelNoPain])],
  };
  const first = await compileCombatBridgeV2(input);
  const second = await compileCombatBridgeV2({
    ...input,
    cells: [cell([standVigil, unsupported], [feelNoPain])],
  });

  assert.equal(first.bridgeSha256, second.bridgeSha256);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.coverage.status, "partial");
  assert.equal(first.coverage.claimEligibility, "provisional");
  const variant = first.cells[0].variants[0];
  assert.equal(variant.resolved.rerolls.wound?.subset, "ones");
  assert.equal(variant.resolved.feelNoPain?.threshold, 5);
  assert.ok(
    variant.effects.some(
      (effect) =>
        effect.status === "omitted" &&
        effect.provenance.abilityId === "master-of-stances" &&
        effect.reason?.includes("ability-grant"),
    ),
  );
  assert.ok(
    variant.effects.some(
      (effect) =>
        effect.status === "modeled" &&
        effect.provenance.perspective === "target" &&
        effect.contribution?.type === "feel-no-pain",
    ),
  );
});

test("actual World Eaters nested negations fail closed around the pinned translator", async () => {
  const beacons = abilities.findAll("Beacons of Rage").find(
    (ability) => ability.raw.faction_id === "world-eaters",
  );
  assert.ok(beacons);
  const condition = (
    beacons.raw.effect as {
      condition?: { operands?: Array<{ negated?: boolean }> };
    }
  ).condition;
  assert.equal(
    condition?.operands?.filter((operand) => operand.negated === true)
      .length,
    2,
  );

  const beaconsRule: BundleCombatRuleRecordV1 = {
    abilityId: beacons.id,
    abilityName: beacons.name,
    entityHash: "world-eaters:beacons-of-rage",
    effect: beacons.raw.effect,
    source: { kind: "unit", unitId: "eightbound" },
    phases: ["fight"],
    phaseMappingStatus: "verified",
    activation: { kind: "always" },
    unsupportedRelevance: "combat",
  };
  const bridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([beaconsRule], [])],
  });

  const variant = bridge.cells[0].variants[0];
  assert.equal(variant.resolved.hitMod.value, 0);
  assert.equal(variant.resolved.woundMod.value, 0);
  assert.equal(variant.coverage.status, "partial");
  assert.equal(variant.coverage.claimEligibility, "provisional");
  assert.equal(
    variant.effects.filter(
      (effect) =>
        effect.provenance.abilityId === "beacons-of-rage" &&
        effect.status === "omitted" &&
        effect.reason?.includes("nested compound-condition operand"),
    ).length,
    2,
  );
  assert.ok(
    variant.coverage.reasons.some((reason) =>
      reason.includes("pinned 40kdc 1.2.1 can silently mis-translate")
    ),
  );
});

test("metric projections with identical mechanics reuse compiled variants without changing cell hashes", async () => {
  const sharedRule = rule({
    id: "shared-mechanics",
    effect: {
      type: "stat-modifier",
      target: "unit",
      modifier: { stat: "A", operation: "add", value: 1 },
    },
  });
  const meanDamage = cell([sharedRule], [], {
    cellId: "player-to-opponent:fight:mean-damage:guard-1:berzerkers-1",
  });
  const wipeProbability = structuredClone(meanDamage);
  wipeProbability.cellId =
    "player-to-opponent:fight:wipe-probability:guard-1:berzerkers-1";
  wipeProbability.metric = "wipe-probability";

  const bridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [wipeProbability, meanDamage],
  });
  const isolated = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [wipeProbability],
  });

  assert.equal(bridge.cells.length, 2);
  assert.equal(bridge.cells[0].scenarioSha256, bridge.cells[1].scenarioSha256);
  assert.deepEqual(
    bridge.cells.map((entry) => entry.metric),
    ["mean-damage", "wipe-probability"],
  );
  assert.notEqual(bridge.cells[0].cellSha256, bridge.cells[1].cellSha256);
  assert.strictEqual(bridge.cells[0].variants, bridge.cells[1].variants);
  assert.deepEqual(bridge.cells[1], isolated.cells[0]);
  assert.deepEqual(bridge.coverage, isolated.coverage);
  assert.equal(bridge.coverageUnit, "unique-mechanics-cell");
  assert.equal(await verifyCombatBridgeV2Hash(bridge), true);

  const tampered = structuredClone(bridge);
  tampered.cells[0].variants[0].resolved.attacksMod.value += 1;
  assert.equal(await verifyCombatBridgeV2Hash(tampered), false);
});

test("target-side conditions use defender context without borrowing attacker state", async () => {
  const targetKeywordRule = rule({
    id: "vehicle-resilience",
    side: "target",
    effect: {
      type: "conditional",
      condition: {
        type: "unit-has-keyword",
        parameters: { keyword: "VEHICLE" },
      },
      effect: {
        type: "feel-no-pain",
        target: "unit",
        modifier: { threshold: 5 },
      },
    },
  });
  const targetChargedRule = rule({
    id: "defender-charged",
    side: "target",
    effect: {
      type: "conditional",
      condition: { type: "charged-this-turn" },
      effect: {
        type: "feel-no-pain",
        target: "unit",
        modifier: { threshold: 4 },
      },
    },
  });
  const base = cell([], []);
  const bridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([], [targetKeywordRule, targetChargedRule], {
      target: {
        ...base.target,
        keywords: ["Vehicle"],
      },
      scenario: scenario({ attackerCharged: true }),
    })],
  });

  const variant = bridge.cells[0].variants[0];
  assert.equal(variant.resolvedByPerspective.target.feelNoPain?.threshold, 5);
  assert.equal(variant.resolved.feelNoPain?.threshold, 5);
  assert.ok(
    variant.effects.some(
      (effect) =>
        effect.provenance.abilityId === "defender-charged" &&
        effect.status === "omitted",
    ),
  );
  assert.equal(variant.coverage.status, "partial");
});

test("bearer-scoped enhancement effects apply to the bearer but not an attached member", async () => {
  const enhancement = {
    ...rule({
      id: "bearer-attacks",
      effect: {
        type: "stat-modifier",
        target: "bearer",
        modifier: { stat: "A", operation: "add", value: 2 },
      },
    }),
    source: {
      kind: "enhancement" as const,
      enhancementId: "bearer-attacks-enhancement",
      bearerUnitId: "custodian-guard",
      bearerSelectionId: "guard-1",
    },
  };
  const bearerBridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([enhancement], [])],
  });
  assert.equal(
    bearerBridge.cells[0].variants[0].resolved.attacksMod.value,
    2,
  );
  assert.equal(bearerBridge.cells[0].coverage.status, "complete");

  const attachedEnhancement = {
    ...enhancement,
    source: {
      ...enhancement.source,
      bearerUnitId: "shield-captain",
      bearerSelectionId: "leader-1",
    },
  };
  const attachedPlan: CombatAttachmentPlanV1 = {
    id: "leader-attached",
    attacker: [{
      leaderSelectionId: "leader-1",
      bodyguardSelectionId: "guard-1",
      supportSelectionIds: [],
    }],
    target: [],
  };
  const attachedBridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([attachedEnhancement], [], {
      ruleVariants: [{
        attachmentPlan: attachedPlan,
        attackerRules: [attachedEnhancement],
        targetRules: [],
      }],
    })],
  });
  const attachedVariant = attachedBridge.cells[0].variants[0];
  assert.equal(attachedVariant.resolved.attacksMod.value, 0);
  assert.ok(
    attachedVariant.effects.some(
      (effect) =>
        effect.provenance.abilityId === "bearer-attacks" &&
        effect.status === "omitted" &&
        effect.reason?.includes("model-scoped"),
    ),
  );
  assert.equal(attachedVariant.coverage.status, "partial");
});

test("non-combat unsupported fragments are recorded without lowering combat coverage", async () => {
  const movementOnly = rule({
    id: "movement-only",
    relevance: "non-combat",
    effect: {
      type: "movement-modifier",
      target: "unit",
      modifier: { move_type: "normal", distance: 2 },
    },
  });
  const bridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([movementOnly], [])],
  });

  assert.equal(bridge.coverage.status, "complete");
  assert.ok(
    bridge.cells[0].variants[0].effects.some(
      (effect) =>
        effect.provenance.abilityId === "movement-only" &&
        effect.status === "not-applicable",
    ),
  );
});

test("a missing phase mapping applies best-effort and explicitly downgrades coverage", async () => {
  const unmappedPhase = rule({
    id: "phase-unmapped-reroll",
    phases: [],
    phaseMappingStatus: "missing",
    effect: {
      type: "re-roll",
      target: "unit",
      modifier: { roll: "hit", subset: "ones" },
    },
  });
  const bridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([unmappedPhase], [])],
  });

  const variant = bridge.cells[0].variants[0];
  assert.equal(variant.resolved.rerolls.hit?.subset, "ones");
  assert.equal(variant.coverage.status, "partial");
  assert.equal(variant.coverage.claimEligibility, "provisional");
  assert.ok(
    variant.effects.some(
      (effect) =>
        effect.provenance.abilityId === "phase-unmapped-reroll" &&
        effect.status === "approximated" &&
        effect.reason?.includes("phase mapping"),
    ),
  );
});

test("structured activations enumerate a deterministic legal baseline and envelope", async () => {
  const blessings = rule({
    id: "blessings-of-khorne",
    effect: {
      type: "dice-pool-allocation",
      pool: { count: 8, die: "D6" },
      max_activations: 1,
      options: [
        {
          name: "Martial Excellence",
          requirement: { type: "pair", min_value: 4 },
          effect: {
            type: "keyword-grant",
            target: "all-friendly",
            modifier: {
              keyword: "Sustained Hits 1",
              weapon_type: "melee",
            },
          },
        },
        {
          name: "Warp Blades",
          requirement: { type: "pair", min_value: 5 },
          effect: {
            type: "keyword-grant",
            target: "all-friendly",
            modifier: { keyword: "Lethal Hits", weapon_type: "melee" },
          },
        },
      ],
    },
  });
  const bridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([blessings], [])],
  });

  const variants = bridge.cells[0].variants;
  assert.equal(variants.length, 3);
  assert.deepEqual(
    variants.map((variant) => variant.activation.activeIds.length),
    [0, 1, 1],
  );
  assert.equal(bridge.coverage.status, "complete");
  assert.equal(variants[0].resolved.extraKeywords.length, 0);
  assert.ok(
    variants.slice(1).every(
      (variant) => variant.resolved.extraKeywords.length === 1,
    ),
  );
});

test("activation envelope enforces groups, selections, resource budgets, and the 64 cap", () => {
  const policy = defaultCombatPolicyV1();
  const grouped = ["a", "b", "c"].map((id) => ({
    id,
    label: id,
    group: { id: "stances", maxActivations: 2 },
    cpCost: 0,
  }));
  const groupEnvelope = enumerateActivationEnvelope(grouped, policy);
  assert.equal(groupEnvelope.items.length, 7);
  assert.ok(
    groupEnvelope.items.every((variant) => variant.activeIds.length <= 2),
  );

  const capped = enumerateActivationEnvelope(
    Array.from({ length: 70 }, (_, index) => ({
      id: `activation-${String(index).padStart(2, "0")}`,
      label: `Activation ${index}`,
      group: null,
      cpCost: 0,
    })),
    policy,
  );
  assert.equal(capped.items.length, MAX_COMBAT_JOINT_VARIANTS);
  assert.equal(capped.truncated, true);

  const selectedPolicy: CombatPolicyV1 = {
    ...policy,
    activationMode: "selected",
    selectedActivationIds: ["costly"],
    resourceBudget: { cp: 1 },
  };
  const invalid = enumerateActivationEnvelope(
    [{ id: "costly", label: "Costly", group: null, cpCost: 2 }],
    selectedPolicy,
  );
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.items.map((variant) => variant.id), ["baseline"]);
});

test("explicit activation constraints validate rather than rewrite discovered metadata", () => {
  const discovered = [{
    id: "stratagem",
    label: "Stratagem",
    group: { id: "battle-tactic", maxActivations: 1 },
    cpCost: 1,
  }];
  const exactPolicy: CombatPolicyV1 = {
    ...defaultCombatPolicyV1(),
    activationConstraints: {
      options: [{
        id: "stratagem",
        groupId: "battle-tactic",
        cpCost: 1,
      }],
      groups: [{ id: "battle-tactic", maxActivations: 1 }],
    },
  };
  const exact = enumerateActivationEnvelope(discovered, exactPolicy);
  assert.equal(exact.valid, true);
  assert.equal(exact.items[1].cpSpent, 1);

  for (const mutate of [
    (policy: CombatPolicyV1) => {
      assert.ok(policy.activationConstraints);
      policy.activationConstraints.options[0].cpCost = 0;
    },
    (policy: CombatPolicyV1) => {
      assert.ok(policy.activationConstraints);
      policy.activationConstraints.groups[0].maxActivations = 2;
    },
  ]) {
    const forged = structuredClone(exactPolicy);
    mutate(forged);
    const rejected = enumerateActivationEnvelope(discovered, forged);
    assert.equal(rejected.valid, false);
    assert.deepEqual(
      rejected.items.map((variant) => variant.id),
      ["baseline"],
    );
    assert.ok(
      rejected.diagnostics.some(
        (diagnostic) =>
          diagnostic.code ===
            "COMBAT_ACTIVATION_POLICY_METADATA_MISMATCH",
      ),
    );
  }
});

test("outer optional and stratagem activations compose atomically with inner choices", async () => {
  const hitChoice = {
    type: "roll-modifier",
    target: "unit",
    modifier: { roll: "hit", operation: "add", value: 1 },
  };
  const woundChoice = {
    type: "roll-modifier",
    target: "unit",
    modifier: { roll: "wound", operation: "add", value: 1 },
  };
  const effect = {
    type: "sequence",
    steps: [
      {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "A", operation: "add", value: 1 },
      },
      {
        type: "choice",
        options: [hitChoice, woundChoice],
      },
    ],
  };
  for (const activation of [
    {
      kind: "optional" as const,
      id: "outer-option",
      label: "Outer option",
      group: null,
      cpCost: 0,
    },
    {
      kind: "stratagem" as const,
      id: "outer-stratagem",
      label: "Outer stratagem",
      group: null,
      cpCost: 1,
    },
  ]) {
    const outerRule = {
      ...rule({ id: `atomic-${activation.kind}`, effect }),
      activation,
    };
    const bridge = await compileCombatBridgeV2({
      bundle,
      policy: defaultCombatPolicyV1(),
      cells: [cell([outerRule], [])],
    });
    const variants = bridge.cells[0].variants;
    assert.equal(variants.length, 3);
    assert.deepEqual(
      variants.map((variant) => variant.activation.activeIds.length),
      [0, 1, 1],
    );
    assert.deepEqual(
      variants.map((variant) => variant.activation.cpSpent),
      [0, activation.cpCost, activation.cpCost],
    );
    assert.equal(variants[0].resolved.attacksMod.value, 0);
    for (const active of variants.slice(1)) {
      assert.equal(active.resolved.attacksMod.value, 1);
      assert.equal(
        Number(active.resolved.hitMod.value === 1) +
          Number(active.resolved.woundMod.value === 1),
        1,
      );
    }
    assert.equal(bridge.cells[0].coverage.status, "complete");
  }

  const multiChoiceStratagem = {
    ...rule({
      id: "unsafe-multi-choice-stratagem",
      effect: {
        type: "dice-pool-allocation",
        max_activations: 2,
        options: [
          {
            name: "First",
            effect: hitChoice,
          },
          {
            name: "Second",
            effect: woundChoice,
          },
        ],
      },
    }),
    activation: {
      kind: "stratagem" as const,
      id: "outer-stratagem",
      label: "Outer stratagem",
      group: null,
      cpCost: 1,
    },
  };
  const unsafe = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([multiChoiceStratagem], [])],
  });
  assert.deepEqual(
    unsafe.cells[0].variants.map((variant) =>
      variant.activation.activeIds
    ),
    [[]],
  );
  assert.equal(unsafe.cells[0].coverage.status, "partial");
  assert.ok(
    unsafe.cells[0].variants[0].effects.some(
      (entry) =>
        entry.status === "omitted" &&
        entry.reason?.includes("charged once per independently selectable"),
    ),
  );
});

test("invalid selected activation sets do not produce an executable baseline", async () => {
  const costly = {
    ...rule({
      id: "costly-rule",
      effect: {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "A", operation: "add", value: 1 },
      },
    }),
    activation: {
      kind: "stratagem" as const,
      id: "costly",
      label: "Costly",
      group: null,
      cpCost: 2,
    },
  };
  const policy: CombatPolicyV1 = {
    ...defaultCombatPolicyV1(),
    activationMode: "selected",
    selectedActivationIds: ["attacker:costly-rule:costly"],
    resourceBudget: { cp: 1 },
  };
  const bridge = await compileCombatBridgeV2({
    bundle,
    policy,
    cells: [cell([costly], [])],
  });

  assert.equal(bridge.cells[0].variants.length, 0);
  assert.equal(bridge.cells[0].coverage.status, "unusable");
  assert.equal(bridge.coverage.claimEligibility, "none");
});

test("adapter vocabulary fails closed for contribution subtypes without exact conformance", () => {
  assert.equal(
    tesseraAdapterSupportForContribution({
      type: "reroll",
      roll: "damage",
      subset: "all-failures",
    }),
    "deferred",
  );
  assert.equal(
    tesseraAdapterSupportForContribution({
      type: "feel-no-pain",
      threshold: 5,
      scope: "mortal",
    }),
    "deferred",
  );
  assert.equal(
    tesseraAdapterSupportForContribution({ type: "ap-mod", value: -1 }),
    "exact",
  );
});

function attachmentPlan(index: number): CombatAttachmentPlanV1 {
  return index === 0
    ? { id: "unattached", attacker: [], target: [] }
    : {
        id: `plan-${String(index).padStart(2, "0")}`,
        attacker: [
          {
            leaderSelectionId: `leader-${index}`,
            bodyguardSelectionId: `body-${index}`,
            supportSelectionIds: [],
          },
        ],
        target: [],
      };
}

test("attachment envelope is stable, non-overlapping, and capped at 16 plans", () => {
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    attachmentPlan: attachmentPlan(index),
    marker: index,
  })).reverse();
  const envelope = enumerateAttachmentEnvelope(
    candidates,
    defaultCombatPolicyV1(),
  );
  assert.equal(envelope.items.length, MAX_COMBAT_ATTACHMENT_PLANS);
  assert.equal(envelope.items[0].attachmentPlan.id, "unattached");
  assert.equal(envelope.truncated, true);

  const overlap = enumerateAttachmentEnvelope(
    [
      {
        attachmentPlan: {
          id: "overlap",
          attacker: [
            {
              leaderSelectionId: "same",
              bodyguardSelectionId: "same",
              supportSelectionIds: [],
            },
          ],
          target: [],
        },
      },
    ],
    defaultCombatPolicyV1(),
  );
  assert.equal(overlap.valid, false);
  assert.equal(overlap.items.length, 0);
});

test("missing attachment rule variants classify a cell and bridge as unusable", async () => {
  const bridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell([], [], { ruleVariants: [] })],
  });

  assert.equal(bridge.cells[0].coverage.status, "unusable");
  assert.equal(bridge.coverage.status, "unusable");
  assert.equal(bridge.coverage.claimEligibility, "none");
});
