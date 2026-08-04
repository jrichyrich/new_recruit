import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCombatBridgeV2,
  defaultCombatPolicyV1,
  type BundleCombatRuleRecordV1,
  type CombatBridgeCellInputV2,
  type CombatBundleBindingV2,
  type CombatRuleSourceV1,
} from "../lib/rosterpilot/combat-bridge";
import type { CombatBridgeV3 } from "../lib/rosterpilot/combat-bridge-v3";
import type {
  LocalTesseraEngineUnit,
} from "../local/tessera/local-engine-input";
import {
  projectCombatBridgeCellToTessera,
  projectCombatBridgeVariantToTessera,
  summarizeTesseraVariantOutcomes,
  tesseraKeywordFromRef,
} from "../local/tessera/combat-bridge-adapter";
import {
  applyTrackedTesseraAdapterV2Patches,
} from "../local/tessera/tessera-adapter-v2";

const bundle: CombatBundleBindingV2 = {
  bundleId: "1".repeat(64),
  engineDataSchemaVersion: 3,
  semanticAuthority: "bundle-manifest-verified",
  playerRosterId: "attacker-roster",
  opponentRosterId: "target-roster",
  playerRosterFingerprint: "9".repeat(64),
  opponentRosterFingerprint: "8".repeat(64),
  playerFactionId: "attacker-faction",
  opponentFactionId: "target-faction",
  playerRosterRulesHash: "2".repeat(64),
  opponentRosterRulesHash: "1".repeat(64),
  playerFactionRulesHash: "3".repeat(64),
  opponentFactionRulesHash: "4".repeat(64),
  playerMappingHash: "5".repeat(64),
  opponentMappingHash: "6".repeat(64),
  portfolioHash: null,
};

function rule(input: {
  id: string;
  effect: unknown;
  side?: "attacker" | "target";
  phases?: Array<"shooting" | "fight">;
  phaseMappingStatus?: "verified" | "missing";
  source?: CombatRuleSourceV1;
}): BundleCombatRuleRecordV1 {
  return {
    abilityId: input.id,
    abilityName: input.id,
    entityHash: `entity-${input.id}`,
    effect: input.effect,
    source: input.source ?? {
      kind: "unit",
      unitId:
        input.side === "target" ? "target-unit" : "attacker-unit",
    },
    phases: input.phases ?? ["fight"],
    ...(input.phaseMappingStatus
      ? { phaseMappingStatus: input.phaseMappingStatus }
      : {}),
    activation: { kind: "always" },
    unsupportedRelevance: "combat",
  };
}

function cell(
  attackerRules: BundleCombatRuleRecordV1[],
  targetRules: BundleCombatRuleRecordV1[],
): CombatBridgeCellInputV2 {
  return {
    cellId: "attacker:target:fight:damage",
    direction: "player-to-opponent",
    metric: "mean-damage",
    attacker: {
      rosterId: "attacker-roster",
      selectionId: "attacker-selection",
      unitId: "attacker-unit",
      factionId: "attacker-faction",
      keywords: ["Infantry"],
    },
    target: {
      rosterId: "target-roster",
      selectionId: "target-selection",
      unitId: "target-unit",
      factionId: "target-faction",
      keywords: ["Infantry"],
    },
    scenario: {
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
    },
    ruleVariants: [
      {
        attachmentPlan: { id: "unattached", attacker: [], target: [] },
        attackerRules,
        targetRules,
      },
    ],
  };
}

async function compiledVariant(
  attackerRules: BundleCombatRuleRecordV1[],
  targetRules: BundleCombatRuleRecordV1[],
) {
  return (await compiledCell(attackerRules, targetRules)).variants[0];
}

async function compiledCell(
  attackerRules: BundleCombatRuleRecordV1[],
  targetRules: BundleCombatRuleRecordV1[],
) {
  const bridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [cell(attackerRules, targetRules)],
  });
  return bridge.cells[0];
}

test("adapter projects resolved attacker and defender buffs into Tessera effects", async () => {
  const offensive = rule({
    id: "offensive-buffs",
    effect: {
      type: "sequence",
      steps: [
        {
          type: "roll-modifier",
          target: "unit",
          modifier: { roll: "hit", operation: "add", value: 1 },
        },
        {
          type: "stat-modifier",
          target: "unit",
          modifier: { stat: "AP", operation: "add", value: -1 },
        },
        {
          type: "re-roll",
          target: "unit",
          modifier: { roll: "wound", subset: "ones" },
        },
        {
          type: "keyword-grant",
          target: "unit",
          modifier: { keyword: "Lethal Hits", weapon_type: "melee" },
        },
      ],
    },
  });
  const defensive = rule({
    id: "feel-no-pain-5",
    side: "target",
    effect: {
      type: "feel-no-pain",
      target: "unit",
      modifier: { threshold: 5 },
    },
  });
  const variant = await compiledVariant([offensive], [defensive]);
  const projection = projectCombatBridgeVariantToTessera({
    variant,
    phase: "fight",
  });

  assert.equal(projection.coverage.status, "complete");
  assert.equal(projection.omissions.length, 0);
  assert.equal(projection.engineEffects.length, 2);
  const attacker = projection.engineEffects.find(
    (effect) => effect.side === "attacker",
  );
  const defender = projection.engineEffects.find(
    (effect) => effect.side === "defender",
  );
  assert.deepEqual(attacker?.mods, {
    hitModifier: 1,
    apBonus: 1,
    reroll: { wound: "ones" },
    grantKeywords: ["LETHAL HITS"],
  });
  assert.deepEqual(defender?.mods, { fnp: 5 });
  assert.match(projection.projectionSha256, /^[a-f0-9]{64}$/);
  assert.match(projection.executionSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    projectCombatBridgeVariantToTessera({ variant, phase: "fight" }),
    projection,
  );
});

test("execution identity excludes source-only variant provenance", async () => {
  const variant = await compiledVariant([
    rule({
      id: "same-mechanics",
      effect: {
        type: "roll-modifier",
        target: "unit",
        modifier: { roll: "hit", operation: "add", value: 1 },
      },
    }),
  ], []);
  const provenanceAlias = structuredClone(variant);
  provenanceAlias.variantId = "provenance-alias";
  provenanceAlias.variantSha256 = "a".repeat(64);
  provenanceAlias.effects[0].effectId = "aliased-effect";
  provenanceAlias.effects[0].provenance.entityHash = "aliased-entity";

  const first = projectCombatBridgeVariantToTessera({
    variant,
    phase: "fight",
  });
  const second = projectCombatBridgeVariantToTessera({
    variant: provenanceAlias,
    phase: "fight",
  });
  assert.notEqual(first.projectionSha256, second.projectionSha256);
  assert.equal(first.executionSha256, second.executionSha256);

  const sourceCell = await compiledCell([], []);
  const aliasedCell = {
    ...sourceCell,
    variants: [variant, provenanceAlias],
  };
  const cellProjection = projectCombatBridgeCellToTessera(aliasedCell);
  assert.equal(cellProjection.variants.length, 2);
  assert.equal(cellProjection.uniqueExecutionCount, 1);
});

test("adapter applies the final hit modifier cap across both perspectives", async () => {
  const offensiveHit = rule({
    id: "offensive-hit",
    effect: {
      type: "roll-modifier",
      target: "unit",
      modifier: { roll: "hit", operation: "add", value: 1 },
    },
  });
  const incomingHit = rule({
    id: "incoming-hit",
    side: "target",
    effect: {
      type: "roll-modifier",
      target: "attacker",
      modifier: { roll: "hit", operation: "add", value: 1 },
    },
  });
  const variant = await compiledVariant([offensiveHit], [incomingHit]);
  assert.equal(variant.resolvedByPerspective.attacker.hitMod.value, 1);
  assert.equal(variant.resolvedByPerspective.target.hitMod.value, 1);
  assert.equal(variant.resolved.hitMod.value, 1);

  const projection = projectCombatBridgeVariantToTessera({
    variant,
    phase: "fight",
  });
  assert.equal(
    projection.engineEffects.find((effect) => effect.side === "attacker")
      ?.mods.hitModifier,
    1,
  );
  assert.equal(projection.coverage.status, "complete");
});

test("adapter-v2 projects defensive stats and blocks impossible mechanics", async () => {
  const damageReroll = rule({
    id: "damage-reroll",
    effect: {
      type: "re-roll",
      target: "unit",
      modifier: { roll: "damage", subset: "ones" },
    },
  });
  const hazardousGrant = rule({
    id: "hazardous-grant",
    effect: {
      type: "keyword-grant",
      target: "unit",
      modifier: { keyword: "Hazardous", weapon_type: "melee" },
    },
  });
  const defensiveStats = rule({
    id: "defensive-stats",
    side: "target",
    effect: {
      type: "sequence",
      steps: [
        {
          type: "stat-modifier",
          target: "unit",
          modifier: { stat: "Sv", operation: "improve", value: 1 },
        },
        {
          type: "stat-modifier",
          target: "unit",
          modifier: { stat: "T", operation: "add", value: 1 },
        },
      ],
    },
  });
  const variant = await compiledVariant(
    [damageReroll, hazardousGrant],
    [defensiveStats],
  );
  assert.equal(variant.coverage.status, "complete");

  const projection = projectCombatBridgeVariantToTessera({
    variant,
    phase: "fight",
  });
  assert.equal(projection.schemaVersion, 2);
  assert.equal(projection.coverage.status, "unusable");
  assert.equal(projection.coverage.claimEligibility, "none");
  assert.deepEqual(
    projection.omissions.map((entry) => entry.code).sort(),
    [
      "TESSERA_DAMAGE_REROLL_UNSUPPORTED",
      "TESSERA_GRANTED_KEYWORD_UNSUPPORTED",
    ],
  );
  assert.equal(
    projection.omissions.find(
      (entry) => entry.code === "TESSERA_DAMAGE_REROLL_UNSUPPORTED",
    )?.blocking,
    true,
  );
  assert.equal(projection.unitPatches.length, 1);
  assert.deepEqual(
    {
      scope: projection.unitPatches[0].scope,
      bearerSelectionId:
        projection.unitPatches[0].bearerSelectionId,
      saveModifier: projection.unitPatches[0].saveModifier,
      toughnessModifier:
        projection.unitPatches[0].toughnessModifier,
    },
    {
      scope: "unit-wide",
      bearerSelectionId: null,
      saveModifier: -1,
      toughnessModifier: 1,
    },
  );
  assert.ok(
    projection.engineEffects.every(
      (effect) =>
        effect.mods.toughBonus === undefined &&
        effect.mods.grantKeywords === undefined,
    ),
  );
});

test("adapter-v2 retains exact bearer selection for save and Toughness patches", async () => {
  const bearerStats = rule({
    id: "bearer-defensive-stats",
    side: "target",
    source: {
      kind: "enhancement",
      enhancementId: "fixture-enhancement",
      bearerUnitId: "target-unit",
      bearerSelectionId: "target-selection",
    },
    effect: {
      type: "sequence",
      steps: [
        {
          type: "roll-modifier",
          target: "unit",
          modifier: { roll: "save", operation: "add", value: 1 },
        },
        {
          type: "stat-modifier",
          target: "unit",
          modifier: { stat: "T", operation: "add", value: 2 },
        },
      ],
    },
  });
  const projection = projectCombatBridgeVariantToTessera({
    variant: await compiledVariant([], [bearerStats]),
    phase: "fight",
  });

  assert.equal(projection.coverage.status, "complete");
  assert.equal(projection.omissions.length, 0);
  assert.equal(projection.unitPatches.length, 1);
  assert.deepEqual(
    {
      scope: projection.unitPatches[0].scope,
      bearerSelectionId:
        projection.unitPatches[0].bearerSelectionId,
      saveModifier: projection.unitPatches[0].saveModifier,
      toughnessModifier:
        projection.unitPatches[0].toughnessModifier,
    },
    {
      scope: "bearer",
      bearerSelectionId: "target-selection",
      saveModifier: 1,
      toughnessModifier: 2,
    },
  );
});

test("attached bearer Save and Toughness leaves reach the exact local patch", async () => {
  const bearerDefence = rule({
    id: "attached-bearer-defence",
    side: "target",
    source: {
      kind: "enhancement",
      enhancementId: "attached-bearer-enhancement",
      bearerUnitId: "target-leader-unit",
      bearerSelectionId: "target-leader-selection",
    },
    effect: {
      type: "sequence",
      steps: [
        {
          type: "roll-modifier",
          target: "bearer",
          modifier: { roll: "save", operation: "add", value: 1 },
        },
        {
          type: "stat-modifier",
          target: "bearer",
          modifier: { stat: "T", operation: "add", value: 2 },
        },
      ],
    },
  });
  const input = cell([], [bearerDefence]);
  input.ruleVariants[0].attachmentPlan = {
    id: "target-leader-attached",
    attacker: [],
    target: [{
      leaderSelectionId: "target-leader-selection",
      bodyguardSelectionId: "target-selection",
      supportSelectionIds: [],
    }],
  };
  const bridge = await compileCombatBridgeV2({
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [input],
  });
  const variant = bridge.cells[0].variants[0];
  assert.equal(variant.coverage.status, "complete");
  assert.equal(variant.resolvedByPerspective.target.saveMod.value, 0);
  assert.equal(variant.resolvedByPerspective.target.toughnessMod.value, 0);
  assert.deepEqual(
    variant.effects
      .filter((effect) =>
        effect.provenance.abilityId === "attached-bearer-defence"
      )
      .map((effect) => ({
        status: effect.status,
        type: effect.contribution?.type,
      }))
      .sort((left, right) =>
        String(left.type).localeCompare(String(right.type)),
      ),
    [
      { status: "modeled", type: "save-mod" },
      { status: "modeled", type: "toughness-mod" },
    ],
  );

  const projection = projectCombatBridgeCellToTessera(
    bridge.cells[0],
  ).variants[0];
  assert.equal(projection.coverage.status, "complete");
  assert.deepEqual(
    projection.unitPatches.map((patch) => ({
      scope: patch.scope,
      bearerSelectionId: patch.bearerSelectionId,
      saveModifier: patch.saveModifier,
      toughnessModifier: patch.toughnessModifier,
    })),
    [{
      scope: "bearer",
      bearerSelectionId: "target-leader-selection",
      saveModifier: 1,
      toughnessModifier: 2,
    }],
  );

  const defender = {
    instanceId: "target-body-instance",
    selectionId: "target-selection",
    unitId: "target-unit",
    occurrence: 1,
    label: "Target bodyguard",
    name: "Target bodyguard",
    models: 5,
    T: 4,
    SV: 4,
    W: 2,
    INV: null,
    FNP: null,
    points: 100,
    keywords: ["INFANTRY"],
    weapons: [],
    attached: [{
      instanceId: "target-leader-instance",
      selectionId: "target-leader-selection",
      unitId: "target-leader-unit",
      occurrence: 1,
      label: "Target leader",
      name: "Target leader",
      models: 1,
      T: 5,
      SV: 3,
      W: 5,
      INV: null,
      FNP: null,
      points: 80,
      keywords: ["CHARACTER"],
      weapons: [],
    }],
  } satisfies LocalTesseraEngineUnit & {
    attached: LocalTesseraEngineUnit[];
  };
  const patched = applyTrackedTesseraAdapterV2Patches(
    defender,
    projection.unitPatches,
  );
  assert.deepEqual(
    { SV: patched.SV, T: patched.T },
    { SV: 4, T: 4 },
  );
  assert.deepEqual(
    patched.attached.map(({ SV, T }) => ({ SV, T })),
    [{ SV: 2, T: 7 }],
  );
});

test("mortal-only Feel No Pain is a blocking adapter omission", async () => {
  const mortalFnp = rule({
    id: "mortal-fnp",
    side: "target",
    effect: {
      type: "feel-no-pain",
      target: "unit",
      modifier: { threshold: 5, scope: "mortal" },
    },
  });
  const projection = projectCombatBridgeVariantToTessera({
    variant: await compiledVariant([], [mortalFnp]),
    phase: "fight",
  });

  assert.equal(projection.coverage.status, "unusable");
  assert.equal(projection.coverage.claimEligibility, "none");
  assert.deepEqual(
    projection.omissions.map((entry) => ({
      code: entry.code,
      blocking: entry.blocking,
    })),
    [{ code: "TESSERA_MORTAL_FNP_UNSUPPORTED", blocking: true }],
  );
});

test("adapter applies a missing-phase-map contribution but retains provisional status", async () => {
  const bestEffort = rule({
    id: "best-effort-hit",
    phases: [],
    phaseMappingStatus: "missing",
    effect: {
      type: "roll-modifier",
      target: "unit",
      modifier: { roll: "hit", operation: "add", value: 1 },
    },
  });
  const bridgeCell = await compiledCell([bestEffort], []);
  const variant = bridgeCell.variants[0];
  const projection = projectCombatBridgeVariantToTessera({
    variant,
    phase: "fight",
  });

  assert.equal(projection.omissions.length, 0);
  assert.equal(projection.coverage.status, "partial");
  assert.equal(projection.coverage.approximatedBridgeEffects, 1);
  assert.equal(projection.engineEffects[0].mods.hitModifier, 1);
  const cellProjection = projectCombatBridgeCellToTessera(bridgeCell);
  assert.equal(cellProjection.coverage.status, "partial");
  assert.equal(cellProjection.coverage.claimEligibility, "provisional");
  assert.equal(cellProjection.variants.length, 1);
});

test("cell projection accepts the executable cell shape retained by bridge v3", async () => {
  const cellV3: CombatBridgeV3["cells"][number] =
    await compiledCell([], []);
  const projection = projectCombatBridgeCellToTessera(cellV3);

  assert.equal(projection.bridgeCellId, cellV3.cellId);
  assert.equal(projection.coverage.status, "complete");
});

test("keyword conversion is explicit about supported parameter shapes", () => {
  assert.equal(
    tesseraKeywordFromRef({
      keyword_id: "anti",
      parameters: { target_keyword: "Infantry", threshold: 4 },
    }),
    "ANTI-INFANTRY 4+",
  );
  assert.equal(
    tesseraKeywordFromRef({
      keyword_id: "sustained-hits",
      parameters: { value: 2 },
    }),
    "SUSTAINED HITS 2",
  );
  assert.equal(
    tesseraKeywordFromRef({ keyword_id: "twin-linked" }),
    "TWIN-LINKED",
  );
  assert.equal(
    tesseraKeywordFromRef({ keyword_id: "hazardous" }),
    null,
  );
});

test("variant outcome summary is order-independent and retains tie provenance", () => {
  const outcomes = [
    { variantId: "high-b", value: 8 },
    { variantId: "low", value: 2 },
    { variantId: "middle", value: 5 },
    { variantId: "high-a", value: 8 },
  ];
  const expected = {
    count: 4,
    medianMethod: "lower-nearest-rank",
    min: { value: 2, variantIds: ["low"] },
    median: { value: 5, variantIds: ["middle"] },
    max: { value: 8, variantIds: ["high-a", "high-b"] },
  };
  assert.deepEqual(summarizeTesseraVariantOutcomes(outcomes), expected);
  assert.deepEqual(
    summarizeTesseraVariantOutcomes([...outcomes].reverse()),
    expected,
  );
  assert.equal(summarizeTesseraVariantOutcomes([]), null);
  assert.throws(
    () =>
      summarizeTesseraVariantOutcomes([
        { variantId: "same", value: 1 },
        { variantId: "same", value: 2 },
      ]),
    /conflicting outcomes/,
  );
});
