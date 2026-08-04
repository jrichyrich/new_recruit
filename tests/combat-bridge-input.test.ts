import assert from "node:assert/strict";
import test from "node:test";

import type {
  DataBundleProvider,
  DataBundleSnapshot,
} from "../lib/rosterpilot/data-bundle";
import { stampRosterDataIdentity } from "../lib/rosterpilot/draft";
import { compileCombatBridgeV2 } from "../lib/rosterpilot/combat-bridge";
import type {
  RuntimeDataBundleShardDataV1,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  createRuntimeDataset,
  emptyRuntimeRulesData,
  type RuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import type { RosterDraftV1 } from "../lib/rosterpilot/types";
import {
  CombatBridgeInputError,
  compileCombatBridgeInputV2FromDataset,
  compileCombatBridgeInputV2FromSnapshot,
  compileCombatBridgeInputV2WithProvider,
} from "../local/tessera/combat-bridge-input";
import {
  defaultTesseraCombatPolicyV2,
  localTesseraScenarioPolicyContractV2,
  migrateTesseraScenarioContractV1ToV2,
  type TesseraCombatPolicyV2,
} from "../local/tessera/scenario-contract-v2";
import { localTesseraScenarioContract } from "../local/tessera/scenario-contract";

const bundleId = "a".repeat(64);
const version = {
  edition: "11th",
  dataslate: "launch",
} as const;

function digest(character: string): string {
  return character.repeat(64);
}

function ability(input: {
  id: string;
  factionId: string;
  type: "faction" | "detachment" | "stratagem" | "unit" | "enhancement";
  effect: RuntimeRulesData["abilities"][number]["effect"];
  detachmentId?: string;
}): RuntimeRulesData["abilities"][number] {
  return {
    ability_id: input.id,
    name: input.id,
    authored_by: "fixture",
    game_version: version,
    ability_type: input.type,
    faction_id: input.factionId,
    detachment_id: input.detachmentId ?? null,
    behavior: "passive",
    effect: input.effect,
    scope: { range: "unit", duration: "phase" },
  };
}

function fixtureRules(): RuntimeRulesData {
  const rules = emptyRuntimeRulesData();
  rules.factions.push({
    id: "faction-a",
    name: "Faction A",
    faction_rule_id: "army-a",
    game_version: version,
  });
  rules.factions.push({
    id: "faction-b",
    name: "Faction B",
    faction_rule_id: null,
    game_version: version,
  });
  rules.units.push({
    id: "leader-a",
    name: "Leader A",
    faction_id: "faction-a",
    role: "character",
    attachment_role: "leader",
    profiles: [{ M: 6, T: 5, W: 5, Sv: 2, Ld: 6, OC: 1 }],
    ability_ids: ["leader-rule"],
    game_version: version,
  });
  rules.units.push({
    id: "body-a",
    name: "Body A",
    faction_id: "faction-a",
    profiles: [{ M: 6, T: 5, W: 3, Sv: 2, Ld: 6, OC: 2 }],
    ability_ids: ["body-rule"],
    game_version: version,
  });
  rules.units.push({
    id: "target-b",
    name: "Target B",
    faction_id: "faction-b",
    profiles: [{ M: 6, T: 4, W: 2, Sv: 3, Ld: 6, OC: 2 }],
    ability_ids: ["target-fnp"],
    game_version: version,
  });

  const abilities = [
    ability({
      id: "army-a",
      factionId: "faction-a",
      type: "faction",
      effect: {
        type: "re-roll",
        target: "unit",
        modifier: { roll: "hit", subset: "ones" },
      },
    }),
    ability({
      id: "detachment-a-rule",
      factionId: "faction-a",
      detachmentId: "detachment-a",
      type: "detachment",
      effect: {
        type: "re-roll",
        target: "unit",
        modifier: { roll: "wound", subset: "ones" },
      },
    }),
    ability({
      id: "leader-rule",
      factionId: "faction-a",
      type: "unit",
      effect: {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "A", operation: "add", value: 1 },
      },
    }),
    ability({
      id: "body-rule",
      factionId: "faction-a",
      type: "unit",
      effect: {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "S", operation: "add", value: 1 },
      },
    }),
    ability({
      id: "stratagem-a-rule",
      factionId: "faction-a",
      detachmentId: "detachment-a",
      type: "stratagem",
      effect: {
        type: "keyword-grant",
        target: "unit",
        modifier: { keyword: "Lethal Hits", weapon_type: "melee" },
      },
    }),
    ability({
      id: "enhancement-a-rule",
      factionId: "faction-a",
      detachmentId: "detachment-a",
      type: "enhancement",
      effect: {
        type: "stat-modifier",
        target: "bearer",
        modifier: { stat: "D", operation: "add", value: 1 },
      },
    }),
    ability({
      id: "target-fnp",
      factionId: "faction-b",
      type: "unit",
      effect: {
        type: "feel-no-pain",
        target: "unit",
        modifier: { threshold: 5 },
      },
    }),
  ];
  rules.abilities.push(...abilities);
  rules.phaseMappings.push(...abilities.map(
    (entry): RuntimeRulesData["phaseMappings"][number] => ({
      source_id: entry.ability_id,
      source_type: "ability",
      phases: ["fight"],
      game_version: version,
      authored_by: "fixture",
    }),
  ));
  rules.detachments.push({
    id: "detachment-a",
    name: "Detachment A",
    faction_id: "faction-a",
    detachment_rule_id: "detachment-a-rule",
    detachment_rule_ids: ["detachment-a-rule"],
    enhancement_ids: ["enhancement-a"],
    stratagem_ids: ["stratagem-a"],
    game_version: version,
  });
  rules.detachments.push({
    id: "detachment-b",
    name: "Detachment B",
    faction_id: "faction-b",
    game_version: version,
  });
  rules.enhancements.push({
    id: "enhancement-a",
    name: "Enhancement A",
    detachment_id: "detachment-a",
    cost: 10,
    ability_id: "enhancement-a-rule",
    game_version: version,
  });
  rules.stratagems.push({
    id: "stratagem-a",
    name: "Stratagem A",
    category: "detachment",
    detachment_id: "detachment-a",
    cp_cost: 1,
    phases: ["fight"],
    player_turn: "your-turn",
    timing: "once-per-phase",
    ability_id: "stratagem-a-rule",
    game_version: version,
  });
  rules.leaderAttachments.push({
    leader_id: "leader-a",
    eligible_bodyguard_ids: ["body-a"],
    game_version: version,
  });
  return rules;
}

const semanticHashes = {
  globalHash: digest("1"),
  methodologyHash: digest("2"),
  factions: {
    "faction-a": {
      factionRulesHash: digest("3"),
      mappingHash: digest("4"),
      portfolioHash: digest("5"),
      conflictHash: digest("6"),
      entityHashes: {
        "faction:faction-a": digest("7"),
        "detachment:detachment-a": digest("8"),
        "unit:leader-a": digest("9"),
        "unit:body-a": digest("b"),
        "enhancement:enhancement-a": digest("c"),
      },
    },
    "faction-b": {
      factionRulesHash: digest("d"),
      mappingHash: digest("e"),
      portfolioHash: digest("f"),
      conflictHash: digest("0"),
      entityHashes: {
        "faction:faction-b": digest("1"),
        "detachment:detachment-b": digest("2"),
        "unit:target-b": digest("3"),
      },
    },
  },
};

function stampFixtureRoster(
  draft: RosterDraftV1,
  extraEntityHashes: Record<string, string> = {},
): RosterDraftV1 {
  const semantic = semanticHashes.factions[
    draft.factionId as keyof typeof semanticHashes.factions
  ];
  return stampRosterDataIdentity(draft, {
    bundleId,
    engineDataSchemaVersion: 2,
    provenance: {
      package: draft.sourceData.package,
      version: draft.sourceData.version,
      edition: draft.sourceData.edition,
      dataslate: draft.sourceData.dataslate,
      releaseId: draft.sourceData.releaseId,
      newRecruit: draft.sourceData.newRecruit,
      official: draft.sourceData.official,
    },
    factions: {
      [draft.factionId]: {
        ...semantic,
        entityHashes: {
          ...semantic.entityHashes,
          ...extraEntityHashes,
        },
      },
    },
  });
}

function snapshot(): DataBundleSnapshot<RuntimeDataBundleShardDataV1> {
  const shard = {
    schemaVersion: 1,
    shardId: "global",
    kind: "global",
    factionIds: [],
    data: {
      payloadKind: "rosterpilot-runtime-global",
      schemaVersion: 2,
      rulesData: fixtureRules(),
    },
  } as unknown as DataBundleSnapshot<RuntimeDataBundleShardDataV1>["shards"] extends ReadonlyMap<string, infer T>
    ? T
    : never;
  const shards = new Map([["global", shard]]);
  return {
    bundleId,
    manifest: {
      bundleId,
      engineDataSchemaVersion: 2,
      semanticHashes,
    },
    trustOrigin: "locally-verified",
    evidence: null,
    acquiredAt: "2026-08-03T00:00:00.000Z",
    shards,
    getShard: (shardId: string) => shards.get(shardId) ?? null,
    getFactionShard: () => shard,
  } as unknown as DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
}

function roster(input: {
  id: string;
  factionId: "faction-a" | "faction-b";
  detachmentId: "detachment-a" | "detachment-b";
  units: RosterDraftV1["units"];
}): RosterDraftV1 {
  const semantic = semanticHashes.factions[input.factionId];
  const draft: RosterDraftV1 = {
    schemaVersion: 3,
    gameSystem: "warhammer-40000-11e",
    id: input.id,
    name: input.id,
    factionId: input.factionId,
    factionName: input.factionId,
    pointsLimit: 1_000,
    totalPoints: input.units.reduce((sum, unit) => sum + unit.points, 0),
    battleSize: "incursion",
    detachmentId: input.detachmentId,
    detachmentName: input.detachmentId,
    forceDispositionId: "take-and-hold",
    forceDispositionName: "Take and Hold",
    preferences: [],
    constraints: {
      allowNamedCharacters: true,
      allowLegends: false,
      collectionUnitIds: null,
    },
    units: input.units,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    sourceData: {
      package: "@alpaca-software/40kdc-data",
      version: "1.2.1",
      edition: "11th",
      dataslate: "launch",
      releaseId: `bundle-${bundleId}`,
      newRecruit: {
        repository: "BSData/wh40k-11e",
        commit: "1".repeat(40),
        gameSystemRevision: 1,
        catalogueRevision: 1,
      },
      official: {
        mfmVersion: "launch",
        updatedAt: "2026-08-03T00:00:00.000Z",
        contentSha256: digest("a"),
      },
      bundleId,
      engineDataSchemaVersion: 2,
      rosterRulesHash: digest(input.factionId === "faction-a" ? "4" : "5"),
      factionRulesHash: semantic.factionRulesHash,
      mappingHash: semantic.mappingHash,
      entityHashes: { ...semantic.entityHashes },
      identityStatus: "verified",
    },
  };
  return stampFixtureRoster(draft);
}

function unit(input: {
  selectionId: string;
  unitId: string;
  enhancementId?: string;
  ordinal?: number;
}): RosterDraftV1["units"][number] {
  return {
    selectionId: input.selectionId,
    unitId: input.unitId,
    name: input.unitId,
    role: "Unit",
    modelCount: 1,
    ordinal: input.ordinal ?? 1,
    points: 100,
    isWarlord: false,
    enhancementId: input.enhancementId ?? null,
    enhancementName: input.enhancementId ?? null,
    equipment: [],
    tags: [],
  };
}

function rosters() {
  return {
    playerRoster: roster({
      id: "player",
      factionId: "faction-a",
      detachmentId: "detachment-a",
      units: [
        unit({
          selectionId: "leader-selection",
          unitId: "leader-a",
          enhancementId: "enhancement-a",
        }),
        unit({
          selectionId: "body-selection",
          unitId: "body-a",
        }),
      ],
    }),
    opponentRoster: roster({
      id: "opponent",
      factionId: "faction-b",
      detachmentId: "detachment-b",
      units: [unit({
        selectionId: "target-selection",
        unitId: "target-b",
      })],
    }),
  };
}

function envelopePolicy(): TesseraCombatPolicyV2 {
  return {
    ...defaultTesseraCombatPolicyV2(),
    activations: {
      mode: "envelope",
      options: [],
      groups: [],
      resourceBudget: 2,
      includeNoOptionsBaseline: true,
    },
    attachments: {
      mode: "enumerate",
      bindings: [],
    },
  };
}

test("provider-leased compilation binds semantic hashes and derives every eligible rule source", async () => {
  const leased = snapshot();
  let released = 0;
  let requested: unknown = null;
  const provider: DataBundleProvider<RuntimeDataBundleShardDataV1> = {
    acquireSnapshot: async (options) => {
      requested = options;
      return {
        leaseId: "lease-1",
        snapshot: leased,
        released: false,
        release: async () => {
          released += 1;
        },
      };
    },
    getStatus: async () => {
      throw new Error("not used");
    },
    refresh: async () => {
      throw new Error("not used");
    },
    rollback: async () => {
      throw new Error("not used");
    },
  };
  const pair = rosters();
  const compiled = await compileCombatBridgeInputV2WithProvider({
    provider,
    ...pair,
    scenarioPolicy: localTesseraScenarioPolicyContractV2(
      100,
      ["fight"],
      ["mean-damage"],
      envelopePolicy(),
    ),
  });

  assert.equal(released, 1);
  assert.deepEqual(requested, {
    bundleId,
    factionIds: ["faction-a", "faction-b"],
    signal: undefined,
  });
  assert.equal(compiled.bundle.bundleId, bundleId);
  assert.equal(
    compiled.bundle.semanticAuthority,
    "bundle-manifest-verified",
  );
  assert.equal(compiled.bundle.playerFactionRulesHash, digest("3"));
  assert.equal(compiled.bundle.opponentMappingHash, digest("e"));
  assert.equal(
    compiled.bundle.playerRosterRulesHash,
    pair.playerRoster.sourceData.rosterRulesHash,
  );
  assert.equal(
    compiled.bundle.opponentRosterRulesHash,
    pair.opponentRoster.sourceData.rosterRulesHash,
  );
  assert.match(compiled.bundle.portfolioHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(compiled.cells.length, 4);

  const cell = compiled.cells.find((entry) =>
    entry.cellId.startsWith("player-to-opponent:fight:mean-damage:leader-selection"),
  );
  assert.ok(cell);
  const attached = cell.ruleVariants.find(
    (variant) => variant.attachmentPlan.attacker.length === 1,
  );
  assert.ok(attached);
  assert.deepEqual(
    new Set(attached.attackerRules.map((rule) => rule.source.kind)),
    new Set([
      "army",
      "detachment",
      "detachment-stratagem",
      "unit",
      "attached",
      "enhancement",
    ]),
  );
  assert.ok(
    attached.attackerRules.some(
      (rule) =>
        rule.source.kind === "detachment-stratagem" &&
        rule.activation.kind === "stratagem" &&
        rule.activation.cpCost === 1,
    ),
  );
});

test("captured Dataset compilation uses roster bindings and marks unmapped phases provisional", async () => {
  const rules = fixtureRules();
  rules.phaseMappings.splice(
    0,
    rules.phaseMappings.length,
    ...rules.phaseMappings.filter(
      (mapping) => mapping.source_id !== "leader-rule",
    ),
  );
  const pair = rosters();
  const compileInput = await compileCombatBridgeInputV2FromDataset({
    dataset: createRuntimeDataset(rules),
    ...pair,
    scenarioPolicy: localTesseraScenarioPolicyContractV2(
      100,
      ["fight"],
      ["mean-damage"],
      envelopePolicy(),
    ),
  });

  assert.equal(compileInput.bundle.bundleId, bundleId);
  assert.equal(compileInput.bundle.semanticAuthority, "roster-asserted");
  assert.equal(
    compileInput.bundle.playerFactionRulesHash,
    pair.playerRoster.sourceData.factionRulesHash,
  );
  assert.equal(
    compileInput.bundle.opponentMappingHash,
    pair.opponentRoster.sourceData.mappingHash,
  );
  assert.equal(compileInput.bundle.portfolioHash, null);

  const forward = compileInput.cells.find((cell) =>
    cell.cellId.startsWith(
      "player-to-opponent:fight:mean-damage:leader-selection",
    ),
  );
  assert.ok(forward);
  const leaderRule = forward.ruleVariants
    .flatMap((variant) => variant.attackerRules)
    .find((rule) => rule.abilityId === "leader-rule");
  assert.ok(leaderRule);
  assert.deepEqual(leaderRule.phases, ["fight"]);
  assert.equal(leaderRule.phaseMappingStatus, "missing");
  assert.ok(
    forward.ruleVariants
      .flatMap((variant) => variant.attackerRules)
      .some((rule) => rule.phaseMappingStatus === "verified"),
  );

  const bridge = await compileCombatBridgeV2(compileInput);
  assert.equal(bridge.coverage.status, "partial");
  assert.ok(
    bridge.diagnostics.some(
      (diagnostic) =>
        diagnostic.code ===
          "COMBAT_BUNDLE_SEMANTIC_BINDING_UNVERIFIED",
    ),
  );
  assert.ok(
    bridge.cells
      .flatMap((cell) => cell.variants)
      .flatMap((variant) => variant.effects)
      .some(
        (effect) =>
          effect.provenance.abilityId === "leader-rule" &&
          effect.status === "approximated",
      ),
  );
});

test("captured Dataset compilation rejects rosters from different bundles", async () => {
  const pair = rosters();
  await assert.rejects(
    compileCombatBridgeInputV2FromDataset({
      dataset: createRuntimeDataset(fixtureRules()),
      playerRoster: pair.playerRoster,
      opponentRoster: {
        ...pair.opponentRoster,
        sourceData: {
          ...pair.opponentRoster.sourceData,
          bundleId: digest("f"),
        },
      },
      scenarioPolicy: localTesseraScenarioPolicyContractV2(
        100,
        ["fight"],
        ["mean-damage"],
      ),
    }),
    (error: unknown) =>
      error instanceof CombatBridgeInputError &&
      error.code === "COMBAT_BRIDGE_BUNDLE_MISMATCH",
  );
});

test("selected equipment mappings fail closed without flagging mapped weapons", async () => {
  const rules = fixtureRules();
  const leader = rules.units.find((entry) => entry.id === "leader-a");
  assert.ok(leader);
  leader.weapon_ids = ["known-blade"];
  rules.weapons.push({
    id: "known-blade",
    name: "Known blade",
    type: "melee",
    faction_id: "faction-a",
    profiles: [{
      name: "Known blade",
      range: "Melee",
      stats: { A: 4, WS: 2, S: 6, AP: -2, D: 2 },
    }],
    game_version: version,
  });
  rules.weapons.push({
    id: "orphan-blade",
    name: "Orphan blade",
    type: "melee",
    faction_id: "faction-a",
    profiles: [{
      name: "Orphan blade",
      range: "Melee",
      stats: { A: 1, WS: 2, S: 4, AP: 0, D: 1 },
    }],
    game_version: version,
  });
  rules.wargear.push({
    id: "icon-a",
    name: "Icon A",
    category: "icon",
    game_version: version,
  });
  rules.wargearOptions.push({
    id: "icon-a-option",
    unit_id: "leader-a",
    faction_id: "faction-a",
    replacement: ["icon-a"],
    game_version: version,
  });

  const pair = rosters();
  const equipment = [
    { itemId: "known-blade", name: "Known blade", count: 1 },
    { itemId: "icon-a", name: "Icon A", count: 1 },
    { itemId: "orphan-blade", name: "Orphan blade", count: 1 },
    { itemId: "missing-gear", name: "Missing gear", count: 1 },
  ];
  const playerRoster = stampFixtureRoster({
    ...pair.playerRoster,
    units: pair.playerRoster.units.map((entry) =>
      entry.selectionId === "leader-selection"
        ? { ...entry, equipment }
        : entry,
    ),
  }, Object.fromEntries(equipment.map((entry, index) => [
    `equipment:leader-a:${entry.itemId}`,
    digest(["4", "5", "6", "7"][index]),
  ])));
  const compiled = await compileCombatBridgeInputV2FromDataset({
    dataset: createRuntimeDataset(rules),
    playerRoster,
    opponentRoster: pair.opponentRoster,
    scenarioPolicy: localTesseraScenarioPolicyContractV2(
      100,
      ["fight"],
      ["mean-damage"],
      envelopePolicy(),
    ),
  });
  const forward = compiled.cells.find((cell) =>
    cell.cellId.startsWith(
      "player-to-opponent:fight:mean-damage:leader-selection",
    ),
  );
  assert.ok(forward);
  const unresolved = forward.ruleVariants
    .flatMap((variant) => variant.attackerRules)
    .filter((rule) => rule.abilityId.startsWith("rosterpilot-unresolved"));
  assert.ok(
    unresolved.some((rule) =>
      (rule.effect as { code?: string }).code ===
        "wargear-ability-mapping-missing" &&
      (rule.effect as { reference_id?: string }).reference_id === "icon-a"
    ),
  );
  assert.ok(
    unresolved.some((rule) =>
      (rule.effect as { code?: string }).code ===
        "equipment-unit-mapping-missing" &&
      (rule.effect as { reference_id?: string }).reference_id ===
        "orphan-blade"
    ),
  );
  assert.ok(
    unresolved.some((rule) =>
      (rule.effect as { code?: string }).code ===
        "equipment-mapping-missing" &&
      (rule.effect as { reference_id?: string }).reference_id ===
        "missing-gear"
    ),
  );
  assert.ok(
    !unresolved.some((rule) =>
      (rule.effect as { reference_id?: string }).reference_id ===
        "known-blade"
    ),
  );
});

test("snapshot and Dataset paths reject inconsistent retained roster hashes", async () => {
  const pair = rosters();
  const tamperedEntityRoster = {
    ...pair.playerRoster,
    sourceData: {
      ...pair.playerRoster.sourceData,
      entityHashes: {
        ...pair.playerRoster.sourceData.entityHashes,
        "unit:leader-a": digest("f"),
      },
    },
  };
  await assert.rejects(
    compileCombatBridgeInputV2FromSnapshot({
      snapshot: snapshot(),
      playerRoster: tamperedEntityRoster,
      opponentRoster: pair.opponentRoster,
      scenarioPolicy: localTesseraScenarioPolicyContractV2(
        100,
        ["fight"],
        ["mean-damage"],
      ),
    }),
    (error: unknown) =>
      error instanceof CombatBridgeInputError &&
      error.code === "COMBAT_BRIDGE_BUNDLE_MISMATCH",
  );

  await assert.rejects(
    compileCombatBridgeInputV2FromDataset({
      dataset: createRuntimeDataset(fixtureRules()),
      playerRoster: {
        ...pair.playerRoster,
        sourceData: {
          ...pair.playerRoster.sourceData,
          rosterRulesHash: digest("f"),
        },
      },
      opponentRoster: pair.opponentRoster,
      scenarioPolicy: localTesseraScenarioPolicyContractV2(
        100,
        ["fight"],
        ["mean-damage"],
      ),
    }),
    (error: unknown) =>
      error instanceof CombatBridgeInputError &&
      error.code === "COMBAT_BRIDGE_BUNDLE_MISMATCH",
  );
});

test("v2 activation options constrain discovered levers and unresolved ids fail closed", async () => {
  const rules = fixtureRules();
  const leaderRule = rules.abilities.find(
    (entry) => entry.ability_id === "leader-rule",
  );
  assert.ok(leaderRule);
  leaderRule.behavior = "activated";
  const pair = rosters();
  const constrainedPolicy: TesseraCombatPolicyV2 = {
    ...defaultTesseraCombatPolicyV2(),
    activations: {
      mode: "envelope",
      options: [
        {
          id: "attacker:leader-rule:leader-rule",
          groupId: null,
          resourceCost: 0,
        },
        {
          id: "attacker:stratagem-a-rule:stratagem-a",
          groupId: null,
          resourceCost: 1,
        },
      ],
      groups: [],
      resourceBudget: 1,
      includeNoOptionsBaseline: true,
    },
    attachments: {
      mode: "selected",
      bindings: [{
        leaderSelectionId: "leader-selection",
        bodyguardSelectionId: "body-selection",
        supportingSelectionIds: [],
      }],
    },
  };
  const compileInput = await compileCombatBridgeInputV2FromDataset({
    dataset: createRuntimeDataset(rules),
    ...pair,
    scenarioPolicy: localTesseraScenarioPolicyContractV2(
      100,
      ["fight"],
      ["mean-damage"],
      constrainedPolicy,
    ),
  });
  const bridge = await compileCombatBridgeV2(compileInput);
  const forward = bridge.cells.find((cell) =>
    cell.cellId.startsWith(
      "player-to-opponent:fight:mean-damage:leader-selection",
    ),
  );
  assert.ok(forward);
  assert.deepEqual(
    forward.variants.map((variant) => variant.activation.activeIds),
    [
      [],
      ["attacker:leader-rule:leader-rule"],
      ["attacker:stratagem-a-rule:stratagem-a"],
      [
        "attacker:leader-rule:leader-rule",
        "attacker:stratagem-a-rule:stratagem-a",
      ],
    ],
  );
  assert.equal(
    forward.variants.find((variant) =>
      variant.activation.activeIds.includes(
        "attacker:stratagem-a-rule:stratagem-a",
      ),
    )?.activation.cpSpent,
    1,
  );

  const unresolvedInput = structuredClone(compileInput);
  assert.ok(unresolvedInput.policy.activationConstraints);
  unresolvedInput.policy.activationConstraints.options[0].id =
    "attacker:missing-rule:missing-option";
  const unresolved = await compileCombatBridgeV2(unresolvedInput);
  assert.equal(unresolved.coverage.status, "unusable");
  assert.ok(
    unresolved.diagnostics.some(
      (diagnostic) =>
        diagnostic.code ===
          "COMBAT_ACTIVATION_POLICY_OPTION_UNRESOLVED",
    ),
  );
});

test("attachment plans and rule inputs are deterministic across roster ordering", async () => {
  const pair = rosters();
  const scenarioPolicy = localTesseraScenarioPolicyContractV2(
    100,
    ["fight"],
    ["mean-damage"],
    envelopePolicy(),
  );
  const first = await compileCombatBridgeInputV2FromSnapshot({
    snapshot: snapshot(),
    ...pair,
    scenarioPolicy,
  });
  const second = await compileCombatBridgeInputV2FromSnapshot({
    snapshot: snapshot(),
    ...pair,
    playerRoster: {
      ...pair.playerRoster,
      units: [...pair.playerRoster.units].reverse(),
    },
    scenarioPolicy,
  });

  assert.deepEqual(second, first);
  const bodyCell = first.cells.find((entry) =>
    entry.cellId.startsWith("player-to-opponent:fight:mean-damage:body-selection"),
  );
  assert.ok(bodyCell);
  assert.deepEqual(
    bodyCell.ruleVariants.map((variant) => variant.attachmentPlan.id),
    [
      "unattached",
      bodyCell.ruleVariants[1].attachmentPlan.id,
    ],
  );
  assert.ok(
    bodyCell.ruleVariants[1].attackerRules.some(
      (rule) =>
        rule.source.kind === "attached" &&
        rule.abilityId === "leader-rule",
    ),
  );
  assert.ok(
    bodyCell.ruleVariants[1].attackerRules.some(
      (rule) =>
        rule.source.kind === "enhancement" &&
        rule.source.bearerSelectionId === "leader-selection",
    ),
  );
});

test("missing unit and enhancement mappings become explicit omitted bridge effects", async () => {
  const pair = rosters();
  const brokenPlayer = stampFixtureRoster({
    ...pair.playerRoster,
    units: [unit({
      selectionId: "missing-selection",
      unitId: "missing-unit",
      enhancementId: "missing-enhancement",
    })],
  }, {
    "unit:missing-unit": digest("4"),
    "enhancement:missing-enhancement": digest("5"),
  });
  const compileInput = await compileCombatBridgeInputV2FromDataset({
    dataset: createRuntimeDataset(fixtureRules()),
    playerRoster: brokenPlayer,
    opponentRoster: pair.opponentRoster,
    scenarioPolicy: localTesseraScenarioPolicyContractV2(
      100,
      ["fight"],
      ["mean-damage"],
      envelopePolicy(),
    ),
  });
  const forward = compileInput.cells.find((cell) =>
    cell.cellId.startsWith("player-to-opponent"),
  );
  assert.ok(forward);
  const unresolvedCodes = forward.ruleVariants[0].attackerRules.map(
    (rule) =>
      (rule.effect as { code?: string }).code,
  );
  assert.ok(unresolvedCodes.includes("unit-mapping-missing"));
  assert.ok(unresolvedCodes.includes("enhancement-mapping-missing"));

  const bridge = await compileCombatBridgeV2(compileInput);
  assert.equal(bridge.coverage.status, "partial");
  assert.ok(
    bridge.cells
      .flatMap((cell) => cell.variants)
      .flatMap((variant) => variant.effects)
      .some(
        (effect) =>
          effect.status === "omitted" &&
          effect.provenance.abilityId.includes("unit-mapping-missing"),
      ),
  );
});

test("selected attachment bindings fail closed unless every id has one roster owner", async () => {
  const pair = rosters();
  const collisionOpponent = stampFixtureRoster({
    ...pair.opponentRoster,
    units: pair.opponentRoster.units.map((entry) => ({
      ...entry,
      selectionId: "leader-selection",
    })),
  });
  const cases = [
    {
      name: "unknown selection",
      opponentRoster: pair.opponentRoster,
      binding: {
        leaderSelectionId: "leader-selection",
        bodyguardSelectionId: "missing-selection",
        supportingSelectionIds: [],
      },
      message: /does not exist in either roster/,
    },
    {
      name: "cross-roster binding",
      opponentRoster: pair.opponentRoster,
      binding: {
        leaderSelectionId: "leader-selection",
        bodyguardSelectionId: "target-selection",
        supportingSelectionIds: [],
      },
      message: /crosses the player and opponent rosters/,
    },
    {
      name: "selection id collision",
      opponentRoster: collisionOpponent,
      binding: {
        leaderSelectionId: "leader-selection",
        bodyguardSelectionId: "body-selection",
        supportingSelectionIds: [],
      },
      message: /exists in both the player and opponent rosters/,
    },
  ];

  for (const entry of cases) {
    const policy: TesseraCombatPolicyV2 = {
      ...defaultTesseraCombatPolicyV2(),
      attachments: {
        mode: "selected",
        bindings: [entry.binding],
      },
    };
    await assert.rejects(
      compileCombatBridgeInputV2FromDataset({
        dataset: createRuntimeDataset(fixtureRules()),
        playerRoster: pair.playerRoster,
        opponentRoster: entry.opponentRoster,
        scenarioPolicy: localTesseraScenarioPolicyContractV2(
          100,
          ["fight"],
          ["mean-damage"],
          policy,
        ),
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof CombatBridgeInputError,
          `${entry.name} should throw CombatBridgeInputError`,
        );
        assert.equal(
          error.code,
          "COMBAT_BRIDGE_ATTACHMENT_SELECTION_INVALID",
        );
        assert.match(error.message, entry.message);
        return true;
      },
    );
  }
});

test("support attachment abilities are aura-filtered and retain support provenance", async () => {
  const rules = fixtureRules();
  rules.units.push({
    id: "support-a",
    name: "Support A",
    faction_id: "faction-a",
    role: "character",
    attachment_role: "support",
    profiles: [{ M: 6, T: 5, W: 4, Sv: 2, Ld: 6, OC: 1 }],
    ability_ids: [
      "support-aura-rule",
      "support-self-rule",
      "support-missing-rule",
    ],
    game_version: version,
  });
  const supportAura = ability({
    id: "support-aura-rule",
    factionId: "faction-a",
    type: "unit",
    effect: {
      type: "stat-modifier",
      target: "unit",
      modifier: { stat: "AP", operation: "add", value: 1 },
    },
  });
  supportAura.scope = { range: "aura-6", duration: "phase" };
  const supportSelf = ability({
    id: "support-self-rule",
    factionId: "faction-a",
    type: "unit",
    effect: {
      type: "stat-modifier",
      target: "unit",
      modifier: { stat: "D", operation: "add", value: 1 },
    },
  });
  rules.abilities.push(supportAura, supportSelf);
  rules.phaseMappings.push(...[supportAura, supportSelf].map(
    (entry): RuntimeRulesData["phaseMappings"][number] => ({
      source_id: entry.ability_id,
      source_type: "ability",
      phases: ["fight"],
      game_version: version,
      authored_by: "fixture",
    }),
  ));
  rules.leaderAttachments.push({
    leader_id: "support-a",
    eligible_bodyguard_ids: ["body-a"],
    game_version: version,
  });

  const pair = rosters();
  const playerRoster = stampFixtureRoster({
    ...pair.playerRoster,
    totalPoints: pair.playerRoster.totalPoints + 100,
    units: [
      ...pair.playerRoster.units,
      unit({
        selectionId: "support-selection",
        unitId: "support-a",
      }),
    ],
  }, {
    "unit:support-a": digest("6"),
  });
  const selectedPolicy: TesseraCombatPolicyV2 = {
    ...defaultTesseraCombatPolicyV2(),
    attachments: {
      mode: "selected",
      bindings: [{
        leaderSelectionId: "leader-selection",
        bodyguardSelectionId: "body-selection",
        supportingSelectionIds: ["support-selection"],
      }],
    },
  };
  const compiled = await compileCombatBridgeInputV2FromDataset({
    dataset: createRuntimeDataset(rules),
    playerRoster,
    opponentRoster: pair.opponentRoster,
    scenarioPolicy: localTesseraScenarioPolicyContractV2(
      100,
      ["fight"],
      ["mean-damage"],
      selectedPolicy,
    ),
  });
  const bodyCell = compiled.cells.find((entry) =>
    entry.cellId.startsWith(
      "player-to-opponent:fight:mean-damage:body-selection",
    ),
  );
  assert.ok(bodyCell);
  const rulesForBody = bodyCell.ruleVariants[0].attackerRules;
  assert.ok(
    rulesForBody.some((rule) =>
      rule.abilityId === "leader-rule" && rule.source.kind === "attached"
    ),
  );
  assert.ok(
    rulesForBody.some((rule) =>
      rule.abilityId === "support-aura-rule" &&
      rule.source.kind === "support"
    ),
  );
  assert.ok(
    !rulesForBody.some((rule) => rule.abilityId === "support-self-rule"),
  );
  assert.ok(
    rulesForBody.some((rule) =>
      rule.abilityId.includes("support-missing-rule") &&
      rule.source.kind === "support"
    ),
  );
});

test("selected attachments resolve per direction and v1 migration remains base-profile", async () => {
  const pair = rosters();
  const selectedPolicy: TesseraCombatPolicyV2 = {
    ...defaultTesseraCombatPolicyV2(),
    attachments: {
      mode: "selected",
      bindings: [{
        leaderSelectionId: "leader-selection",
        bodyguardSelectionId: "body-selection",
        supportingSelectionIds: [],
      }],
    },
  };
  const selected = await compileCombatBridgeInputV2FromSnapshot({
    snapshot: snapshot(),
    ...pair,
    scenarioPolicy: localTesseraScenarioPolicyContractV2(
      100,
      ["fight"],
      ["mean-damage"],
      selectedPolicy,
    ),
  });
  const forward = selected.cells.find((cell) =>
    cell.cellId.startsWith("player-to-opponent"),
  );
  const reverse = selected.cells.find((cell) =>
    cell.cellId.startsWith("opponent-to-player"),
  );
  assert.ok(forward && reverse);
  assert.equal(forward.ruleVariants.length, 1);
  assert.equal(forward.ruleVariants[0].attachmentPlan.attacker.length, 1);
  assert.equal(reverse.ruleVariants[0].attachmentPlan.target.length, 1);

  const migrated = await compileCombatBridgeInputV2FromSnapshot({
    snapshot: snapshot(),
    ...pair,
    scenarioPolicy: migrateTesseraScenarioContractV1ToV2(
      localTesseraScenarioContract(
        100,
        ["fight"],
        ["mean-damage"],
      ),
    ),
  });
  assert.ok(
    migrated.cells.every((cell) =>
      cell.ruleVariants.every(
        (variant) =>
          variant.attackerRules.length === 0 &&
          variant.targetRules.length === 0,
      ),
    ),
  );
});

test("provider leases are released when the returned snapshot mismatches the roster", async () => {
  const pair = rosters();
  const mismatched = snapshot();
  Object.defineProperty(mismatched, "bundleId", {
    value: digest("f"),
  });
  let released = 0;
  const provider = {
    acquireSnapshot: async () => ({
      leaseId: "lease-mismatch",
      snapshot: mismatched,
      released: false,
      release: async () => {
        released += 1;
      },
    }),
    getStatus: async () => {
      throw new Error("not used");
    },
    refresh: async () => {
      throw new Error("not used");
    },
    rollback: async () => {
      throw new Error("not used");
    },
  } satisfies DataBundleProvider<RuntimeDataBundleShardDataV1>;

  await assert.rejects(
    compileCombatBridgeInputV2WithProvider({
      provider,
      ...pair,
      scenarioPolicy: localTesseraScenarioPolicyContractV2(
        100,
        ["fight"],
        ["mean-damage"],
      ),
    }),
    (error: unknown) =>
      error instanceof CombatBridgeInputError &&
      error.code === "COMBAT_BRIDGE_BUNDLE_MISMATCH",
  );
  assert.equal(released, 1);
});
