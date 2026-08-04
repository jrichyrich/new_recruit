import assert from "node:assert/strict";
import test from "node:test";

import type { DataBundleSnapshot } from "../lib/rosterpilot/data-bundle";
import { stampRosterDataIdentity } from "../lib/rosterpilot/draft";
import { compileCombatBridgeV3 } from "../lib/rosterpilot/combat-bridge-v3";
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
  CombatBridgeInputV3PreparationError,
  prepareCombatBridgeInputV3FromDataset,
  prepareCombatBridgeInputV3FromSnapshot,
} from "../local/tessera/combat-bridge-input-v3";
import {
  CONSERVATIVE_COMBAT_CORPUS_REVIEWED_STORE_V1,
  createCombatCorpusReviewedStoreV1,
  wargearCombatCorpusAbilityBindingV1,
} from "../local/tessera/combat-corpus-reviewed-overlay";
import {
  runtimeDatasetFromSnapshot,
} from "../local/tessera/combat-bridge-input";
import {
  compileRosterForLocalTesseraEngineV2,
} from "../local/tessera/local-engine-input-v2";
import {
  aggregateProfileRequirements,
  profilePolicyScaffold,
} from "../local/tessera/profile-policy";
import {
  canonicalTesseraScenarioPolicyContractV3,
  selectedBaselineTesseraScenarioPolicyContractV3,
  type TesseraScenarioPolicyContractV3,
} from "../local/tessera/scenario-contract-v3";

const bundleId = "8".repeat(64);
const version = { edition: "11th", dataslate: "fixture" } as const;

function digest(character: string): string {
  return character.repeat(64);
}

function ability(input: {
  id: string;
  factionId: string;
  effect: RuntimeRulesData["abilities"][number]["effect"];
}): RuntimeRulesData["abilities"][number] {
  return {
    ability_id: input.id,
    name: input.id,
    authored_by: "fixture",
    game_version: version,
    ability_type: "unit",
    faction_id: input.factionId,
    behavior: "passive",
    effect: input.effect,
    scope: { range: "unit", duration: "phase" },
  };
}

function fixtureRules(
  conditionalCharge = false,
  includeReviewedWargear = false,
): RuntimeRulesData {
  const rules = emptyRuntimeRulesData();
  rules.factions.push(
    {
      id: "faction-a",
      name: "Faction A",
      faction_rule_id: null,
      game_version: version,
    },
    {
      id: "faction-b",
      name: "Faction B",
      faction_rule_id: null,
      game_version: version,
    },
  );
  rules.units.push(
    {
      id: "unit-a",
      name: "Unit A",
      faction_id: "faction-a",
      profiles: [{ M: 6, T: 5, W: 3, Sv: 2, Ld: 6, OC: 2 }],
      ability_ids: ["attack-bonus"],
      weapon_ids: ["blade-a"],
      game_version: version,
    },
    {
      id: "unit-b",
      name: "Unit B",
      faction_id: "faction-b",
      profiles: [{ M: 6, T: 4, W: 2, Sv: 3, Ld: 6, OC: 1 }],
      ability_ids: ["target-fnp"],
      weapon_ids: ["blade-b"],
      game_version: version,
    },
  );
  const attackEffect: RuntimeRulesData["abilities"][number]["effect"] =
    conditionalCharge
      ? {
          type: "conditional",
          condition: { type: "charged-this-turn" },
          effect: {
            type: "stat-modifier",
            target: "unit",
            modifier: { stat: "A", operation: "add", value: 1 },
          },
        }
      : {
          type: "stat-modifier",
          target: "unit",
          modifier: { stat: "A", operation: "add", value: 1 },
        };
  const abilities = [
    ability({
      id: "attack-bonus",
      factionId: "faction-a",
      effect: attackEffect,
    }),
    ability({
      id: "target-fnp",
      factionId: "faction-b",
      effect: {
        type: "feel-no-pain",
        target: "unit",
        modifier: { threshold: 5 },
      },
    }),
  ];
  if (includeReviewedWargear) {
    abilities.push(ability({
      id: "icon-reroll",
      factionId: "faction-a",
      effect: {
        type: "re-roll",
        target: "unit",
        modifier: { roll: "hit", subset: "ones" },
      },
    }));
    rules.wargear.push({
      id: "icon-a",
      name: "Icon A",
      category: "icon",
      game_version: version,
    });
    rules.wargearOptions.push({
      id: "icon-a-option",
      unit_id: "unit-a",
      faction_id: "faction-a",
      replacement: ["icon-a"],
      game_version: version,
    });
  }
  rules.abilities.push(...abilities);
  rules.phaseMappings.push(...abilities.map((entry) => ({
    source_id: entry.ability_id,
    source_type: "ability" as const,
    phases: ["fight"] as ["fight"],
    game_version: version,
    authored_by: "fixture",
  })));
  rules.detachments.push(
    {
      id: "detachment-a",
      name: "Detachment A",
      faction_id: "faction-a",
      game_version: version,
    },
    {
      id: "detachment-b",
      name: "Detachment B",
      faction_id: "faction-b",
      game_version: version,
    },
  );
  rules.weapons.push(
    {
      id: "blade-a",
      name: "Blade A",
      type: "melee",
      faction_id: "faction-a",
      profiles: [{
        name: "Blade A",
        range: "Melee",
        stats: { A: 4, WS: 2, S: 6, AP: -2, D: 2 },
      }],
      game_version: version,
    },
    {
      id: "blade-b",
      name: "Blade B",
      type: "melee",
      faction_id: "faction-b",
      profiles: [{
        name: "Blade B",
        range: "Melee",
        stats: { A: 3, WS: 3, S: 5, AP: -1, D: 1 },
      }],
      game_version: version,
    },
  );
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
        "unit:unit-a": digest("9"),
        "equipment:unit-a:blade-a": digest("a"),
        "equipment:unit-a:icon-a": digest("4"),
      },
    },
    "faction-b": {
      factionRulesHash: digest("b"),
      mappingHash: digest("c"),
      portfolioHash: digest("d"),
      conflictHash: digest("e"),
      entityHashes: {
        "faction:faction-b": digest("f"),
        "detachment:detachment-b": digest("0"),
        "unit:unit-b": digest("1"),
        "equipment:unit-b:blade-b": digest("2"),
      },
    },
  },
};

function roster(input: {
  id: string;
  factionId: "faction-a" | "faction-b";
  factionName: string;
  detachmentId: "detachment-a" | "detachment-b";
  selectionId: string;
  unitId: "unit-a" | "unit-b";
  weaponId: "blade-a" | "blade-b";
}): RosterDraftV1 {
  const semantic = semanticHashes.factions[input.factionId];
  const draft: RosterDraftV1 = {
    schemaVersion: 3,
    gameSystem: "warhammer-40000-11e",
    id: input.id,
    name: input.id,
    factionId: input.factionId,
    factionName: input.factionName,
    pointsLimit: 500,
    totalPoints: 100,
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
    units: [{
      selectionId: input.selectionId,
      unitId: input.unitId,
      name: input.unitId === "unit-a" ? "Unit A" : "Unit B",
      role: "Unit",
      modelCount: 1,
      ordinal: 1,
      points: 100,
      isWarlord: false,
      enhancementId: null,
      enhancementName: null,
      equipment: [{
        itemId: input.weaponId,
        name: input.weaponId === "blade-a" ? "Blade A" : "Blade B",
        count: 1,
      }],
      tags: [],
    }],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    sourceData: {
      package: "@alpaca-software/40kdc-data",
      version: "1.2.1",
      edition: "11th",
      dataslate: "fixture",
      releaseId: `bundle-${bundleId}`,
      newRecruit: {
        repository: "BSData/wh40k-11e",
        commit: "1".repeat(40),
        gameSystemRevision: 1,
        catalogueRevision: 1,
      },
      official: {
        mfmVersion: "fixture",
        updatedAt: "2026-08-04T00:00:00.000Z",
        contentSha256: digest("3"),
      },
      bundleId,
      engineDataSchemaVersion: 2,
      rosterRulesHash: digest("4"),
      factionRulesHash: semantic.factionRulesHash,
      mappingHash: semantic.mappingHash,
      entityHashes: { ...semantic.entityHashes },
      identityStatus: "verified",
    },
  };
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
    factions: { [input.factionId]: semantic },
  });
}

function fixtureSnapshot(
  rules: RuntimeRulesData = fixtureRules(),
): DataBundleSnapshot<RuntimeDataBundleShardDataV1> {
  const shard = {
    schemaVersion: 1,
    shardId: "global",
    kind: "global",
    factionIds: [],
    data: {
      payloadKind: "rosterpilot-runtime-global",
      schemaVersion: 2,
      rulesData: rules,
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
    acquiredAt: "2026-08-04T00:00:00.000Z",
    shards,
    getShard: (shardId: string) => shards.get(shardId) ?? null,
    getFactionShard: () => shard,
  } as unknown as DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
}

function fixtureRosters(includeReviewedWargear = false): {
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
} {
  const playerRoster = roster({
    id: "player-roster",
    factionId: "faction-a",
    factionName: "Faction A",
    detachmentId: "detachment-a",
    selectionId: "player-unit",
    unitId: "unit-a",
    weaponId: "blade-a",
  });
  return {
    playerRoster: includeReviewedWargear
      ? stampRosterDataIdentity({
          ...playerRoster,
          units: playerRoster.units.map((unit) => ({
            ...unit,
            equipment: [
              ...unit.equipment,
              { itemId: "icon-a", name: "Icon A", count: 1 },
            ],
          })),
        }, {
          bundleId,
          engineDataSchemaVersion: 2,
          provenance: {
            package: playerRoster.sourceData.package,
            version: playerRoster.sourceData.version,
            edition: playerRoster.sourceData.edition,
            dataslate: playerRoster.sourceData.dataslate,
            releaseId: playerRoster.sourceData.releaseId,
            newRecruit: playerRoster.sourceData.newRecruit,
            official: playerRoster.sourceData.official,
          },
          factions: { "faction-a": semanticHashes.factions["faction-a"] },
        })
      : playerRoster,
    opponentRoster: roster({
      id: "opponent-roster",
      factionId: "faction-b",
      factionName: "Faction B",
      detachmentId: "detachment-b",
      selectionId: "opponent-unit",
      unitId: "unit-b",
      weaponId: "blade-b",
    }),
  };
}

function physicalScenario(): TesseraScenarioPolicyContractV3 {
  const baseline = selectedBaselineTesseraScenarioPolicyContractV3(
    100,
    {
      playerSelectionIds: ["player-unit"],
      opponentSelectionIds: ["opponent-unit"],
    },
    ["fight"],
    ["mean-damage"],
  );
  return canonicalTesseraScenarioPolicyContractV3({
    ...baseline,
    scenarios: baseline.scenarios.map((scenario) => ({
      ...scenario,
      state: {
        ...scenario.state,
        timing: "during-phase",
        player: {
          ...scenario.state.player,
          units: scenario.state.player.units.map((unit) => ({
            ...unit,
            movement: "advanced" as const,
            chargedThisTurn: true,
            inCover: true,
            controlsObjective: true,
            strength: "below-half" as const,
            damage: "damaged" as const,
          })),
        },
        opponent: {
          ...scenario.state.opponent,
          units: scenario.state.opponent.units.map((unit) => ({
            ...unit,
            movement: "stationary" as const,
            chargedThisTurn: false,
            inCover: false,
            controlsObjective: false,
            strength: "starting" as const,
            damage: "healthy" as const,
          })),
        },
        pairs: scenario.state.pairs.map((pair) => ({
          ...pair,
          distanceInches: 7,
          withinRange: true,
          withinRapidFireRange: false,
          withinMeltaRange: false,
          targetCondition:
            scenario.direction === "player-to-opponent",
        })),
      },
    })),
  });
}

function fixtureInput(
  rules: RuntimeRulesData = fixtureRules(),
  includeReviewedWargear = false,
) {
  const snapshot = fixtureSnapshot(rules);
  const dataset = runtimeDatasetFromSnapshot(snapshot);
  const rosters = fixtureRosters(includeReviewedWargear);
  const dataContext = {
    dataset,
    bundleId,
    engineDataSchemaVersion: 2,
  };
  const requirements = aggregateProfileRequirements(
    [rosters.playerRoster, rosters.opponentRoster],
    dataset,
  );
  const scaffold = profilePolicyScaffold(requirements);
  const profilePolicy = requirements.length === 0
    ? null
    : {
        ...scaffold,
        entries: scaffold.entries.map((entry, index) => ({
          ...entry,
          selectedProfile: requirements[index].availableProfiles[0],
        })),
      };
  return {
    snapshot,
    dataset,
    ...rosters,
    scenarioPolicy: physicalScenario(),
    localInputs: {
      player: compileRosterForLocalTesseraEngineV2(
        rosters.playerRoster,
        profilePolicy,
        dataContext,
      ),
      opponent: compileRosterForLocalTesseraEngineV2(
        rosters.opponentRoster,
        profilePolicy,
        dataContext,
      ),
    },
  };
}

test("snapshot preparation inventories only selected rules and projects exact v3 pair state", async () => {
  const prepared = await prepareCombatBridgeInputV3FromSnapshot(
    fixtureInput(),
  );

  assert.equal(prepared.report.summary.unsupported, 0);
  assert.equal(
    prepared.report.summary.accountedLeafCount,
    prepared.report.summary.leafCount,
  );
  assert.equal(prepared.inventory.sources.length, 2);
  assert.equal(prepared.input.bundle.semanticAuthority, "bundle-manifest-verified");
  assert.equal(
    prepared.replayBindings.scenarioContractV3Sha256?.length,
    64,
  );
  assert.match(
    prepared.replayBindings.localInputV2Sha256s?.player ?? "",
    /^[a-f0-9]{64}$/,
  );

  const forward = prepared.input.cells.find(
    (cell) => cell.direction === "player-to-opponent",
  );
  const reverse = prepared.input.cells.find(
    (cell) => cell.direction === "opponent-to-player",
  );
  assert.ok(forward);
  assert.ok(reverse);
  assert.deepEqual(forward.scenario, {
    schemaVersion: 2,
    phase: "fight",
    distanceInches: 7,
    withinHalfRange: false,
    attackerStationary: false,
    attackerCharged: true,
    attackerAttached: false,
    targetAttached: false,
    attackerInCover: true,
    targetInCover: false,
    timing: "during-phase",
    objectiveState: "controlled",
    attackerStrengthState: "below-half",
    targetStrengthState: "starting",
    attackerDamageState: "damaged",
    targetDamageState: "healthy",
    armyAbilityState: "unknown",
    targetConditionState: "met",
  });
  assert.equal(reverse.scenario.attackerStationary, true);
  assert.equal(reverse.scenario.attackerCharged, false);
  assert.equal(reverse.scenario.attackerInCover, false);
  assert.equal(reverse.scenario.targetInCover, true);
  assert.equal(reverse.scenario.objectiveState, "not-controlled");
  assert.equal(reverse.scenario.attackerStrengthState, "starting");
  assert.equal(reverse.scenario.targetStrengthState, "below-half");
  assert.equal(reverse.scenario.targetConditionState, "not-met");

  const bridge = await compileCombatBridgeV3(prepared.input);
  assert.equal(bridge.exactness.status, "decision-grade");
  assert.equal(bridge.coverage.claimEligibility, "decision-grade");
  assert.deepEqual(
    bridge.exactness.replay.localInputV2Sha256s,
    prepared.replayBindings.localInputV2Sha256s,
  );
});

test("unreviewed conditional ancestry fails closed with retained conformance evidence", async () => {
  const input = fixtureInput(fixtureRules(true));
  await assert.rejects(
    prepareCombatBridgeInputV3FromSnapshot(input),
    (error: unknown) => {
      assert.ok(error instanceof CombatBridgeInputV3PreparationError);
      assert.equal(error.code, "COMBAT_CORPUS_REVIEW_REQUIRED");
      assert.ok(error.artifact);
      assert.ok(error.artifact.report.summary.unsupported > 0);
      assert.ok(
        error.artifact.report.leafAccounting.some(
          (entry) => entry.disposition.kind === "unsupported",
        ),
      );
      return true;
    },
  );
});

test("a reviewed non-weapon wargear binding becomes an exact corpus source", async () => {
  const input = fixtureInput(fixtureRules(false, true), true);
  const evidence = {
    reviewedBy: "fixture-reviewer",
    reviewedAt: "2026-08-04T00:00:00.000Z",
    rationale: "The fixture icon is explicitly bound to its structured effect.",
    reference: "fixture:icon-a",
  };
  const reviewedStore = createCombatCorpusReviewedStoreV1({
    seedVersion: "fixture-wargear-binding-v1",
    entries: [
      ...CONSERVATIVE_COMBAT_CORPUS_REVIEWED_STORE_V1.entries,
      wargearCombatCorpusAbilityBindingV1({
        entryId: "wargear:unit-a:icon-a:icon-reroll",
        factionId: "faction-a",
        unitId: "unit-a",
        equipmentId: "icon-a",
        abilityId: "icon-reroll",
        evidence,
      }),
    ],
  });
  const prepared = await prepareCombatBridgeInputV3FromSnapshot({
    ...input,
    reviewedStore,
  });

  assert.ok(
    prepared.input.cells.flatMap((cell) => cell.ruleVariants)
      .flatMap((variant) => [
        ...variant.attackerRules,
        ...variant.targetRules,
      ])
      .some((rule) =>
        rule.abilityId === "icon-reroll" &&
        rule.source.kind === "wargear"
      ),
  );
  assert.ok(
    prepared.overlay.entries.some(
      (entry) => entry.kind === "ability-binding",
    ),
  );
  assert.equal(
    (await compileCombatBridgeV3(prepared.input)).exactness.status,
    "decision-grade",
  );
});

test("local-input-v2 frozen alternate profiles are reproduced from bundle identities", async () => {
  const rules = fixtureRules();
  const blade = rules.weapons.find((weapon) => weapon.id === "blade-a");
  assert.ok(blade);
  blade.profiles = [
    {
      name: "Strike",
      range: "Melee",
      stats: { A: 4, WS: 2, S: 7, AP: -2, D: 2 },
    },
    {
      name: "Sweep",
      range: "Melee",
      stats: { A: 8, WS: 2, S: 5, AP: -1, D: 1 },
    },
  ];
  const input = fixtureInput(rules);
  assert.match(input.localInputs.player.profilePolicySha256 ?? "", /^[a-f0-9]{64}$/);

  const prepared = await prepareCombatBridgeInputV3FromSnapshot(input);
  assert.equal(prepared.input.bundle.bundleId, bundleId);
  assert.match(
    prepared.replayBindings.localInputV2Sha256s?.player ?? "",
    /^[a-f0-9]{64}$/,
  );
});

test("snapshot preparation rejects scenario scope and local-input identity drift", async () => {
  const input = fixtureInput();
  const wrongScope = selectedBaselineTesseraScenarioPolicyContractV3(
    100,
    {
      playerSelectionIds: ["another-player-unit"],
      opponentSelectionIds: ["opponent-unit"],
    },
    ["fight"],
    ["mean-damage"],
  );
  await assert.rejects(
    prepareCombatBridgeInputV3FromSnapshot({
      ...input,
      scenarioPolicy: wrongScope,
    }),
    (error: unknown) =>
      error instanceof CombatBridgeInputV3PreparationError &&
      error.code === "COMBAT_CORPUS_SCENARIO_SCOPE_MISMATCH",
  );

  await assert.rejects(
    prepareCombatBridgeInputV3FromSnapshot({
      ...input,
      localInputs: {
        ...input.localInputs,
        player: {
          ...input.localInputs.player,
          rosterId: "different-roster",
        },
      },
    }),
    (error: unknown) =>
      error instanceof CombatBridgeInputV3PreparationError &&
      error.code === "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH",
  );

  await assert.rejects(
    prepareCombatBridgeInputV3FromSnapshot({
      ...input,
      localInputs: {
        ...input.localInputs,
        player: {
          ...input.localInputs.player,
          units: input.localInputs.player.units.map((unit, index) =>
            index === 0 ? { ...unit, T: unit.T + 1 } : unit
          ),
        },
      },
    }),
    (error: unknown) =>
      error instanceof CombatBridgeInputV3PreparationError &&
      error.code === "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH" &&
      /differs from deterministic compilation/i.test(error.message),
  );
});

test("a bare Dataset can discover rules but cannot claim snapshot authority", async () => {
  const input = fixtureInput();
  await assert.rejects(
    prepareCombatBridgeInputV3FromDataset({
      dataset: createRuntimeDataset(fixtureRules()),
      playerRoster: input.playerRoster,
      opponentRoster: input.opponentRoster,
      scenarioPolicy: input.scenarioPolicy,
      localInputs: input.localInputs,
    }),
    (error: unknown) =>
      error instanceof CombatBridgeInputV3PreparationError &&
      error.code === "COMBAT_CORPUS_SNAPSHOT_REQUIRED",
  );
});
