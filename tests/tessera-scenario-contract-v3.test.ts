import assert from "node:assert/strict";
import test from "node:test";

import { localTesseraScenarioContract } from "../local/tessera/scenario-contract";
import {
  localTesseraScenarioPolicyContractV2,
  type TesseraCombatPolicyV2,
} from "../local/tessera/scenario-contract-v2";
import {
  assertTesseraScenarioPolicyContractV3Scope,
  canonicalTesseraScenarioPolicyContractV3,
  defaultTesseraCombatPolicyV3,
  localTesseraScenarioPolicyContractV3,
  migrateTesseraScenarioContractV1ToV3,
  migrateTesseraScenarioPolicyContractV2ToV3,
  selectedBaselineTesseraScenarioPolicyContractV3,
  TESSERA_SCENARIO_V3_STATE_KEYS,
  tesseraScenarioPolicyContractV3ConclusionStatus,
  tesseraScenarioPolicyContractV3Scope,
  tesseraScenarioPolicyContractV3Sha256,
  type TesseraScenarioPhysicalStateV3,
  type TesseraScenarioPolicyContractV3,
  type TesseraSidePhysicalStateV3,
} from "../local/tessera/scenario-contract-v3";

const unitScope = {
  playerSelectionIds: ["player:leader", "player:bodyguard"],
  opponentSelectionIds: ["opponent:unit"],
} as const;

function resolvedSide(
  side: TesseraSidePhysicalStateV3,
  commandPoints = 0,
): TesseraSidePhysicalStateV3 {
  return {
    resources: {
      commandPoints,
      factionResources: side.resources.factionResources.map((resource) => ({
        ...resource,
        amount: resource.amount === "unknown" ? 0 : resource.amount,
      })),
    },
    armyAbilities: side.armyAbilities.map((ability) => ({
      ...ability,
      active: ability.active === "unknown" ? false : ability.active,
    })),
    oncePerBattle: side.oncePerBattle.map((ability) => ({
      ...ability,
      available:
        ability.available === "unknown" ? false : ability.available,
    })),
    units: side.units.map((unit) => ({
      ...unit,
      movement: unit.movement === "unknown" ? "stationary" : unit.movement,
      chargedThisTurn:
        unit.chargedThisTurn === "unknown" ? false : unit.chargedThisTurn,
      wasChargedThisTurn:
        unit.wasChargedThisTurn === "unknown"
          ? false
          : unit.wasChargedThisTurn,
      inCover: unit.inCover === "unknown" ? false : unit.inCover,
      onObjective:
        unit.onObjective === "unknown" ? false : unit.onObjective,
      controlsObjective:
        unit.controlsObjective === "unknown"
          ? false
          : unit.controlsObjective,
      strength: unit.strength === "unknown" ? "starting" : unit.strength,
      damage: unit.damage === "unknown" ? "healthy" : unit.damage,
      battleShocked:
        unit.battleShocked === "unknown" ? false : unit.battleShocked,
      eligibleToFight:
        unit.eligibleToFight === "unknown" ? false : unit.eligibleToFight,
      hasFought: unit.hasFought === "unknown" ? false : unit.hasFought,
    })),
  };
}

function resolvedState(
  state: TesseraScenarioPhysicalStateV3,
  playerCommandPoints = 0,
): TesseraScenarioPhysicalStateV3 {
  return {
    battleRound: 1,
    timing: "during-phase",
    player: resolvedSide(state.player, playerCommandPoints),
    opponent: resolvedSide(state.opponent),
    pairs: state.pairs.map((pair) => ({
      ...pair,
      distanceInches: 12,
      withinRange: true,
      withinRapidFireRange: false,
      withinMeltaRange: false,
      withinConversionRange: false,
      targetVisible: true,
      indirectFire: false,
      targetCondition: false,
    })),
  };
}

function selectedContract(
  playerCommandPoints = 0,
): TesseraScenarioPolicyContractV3 {
  const baseline = localTesseraScenarioPolicyContractV3(
    1_000,
    unitScope,
    ["shooting"],
    ["mean-damage"],
  );
  return canonicalTesseraScenarioPolicyContractV3({
    ...baseline,
    scenarios: baseline.scenarios.map((scenario) => ({
      ...scenario,
      state: resolvedState(scenario.state, playerCommandPoints),
    })),
    policy: {
      ...baseline.policy,
      stateResolution: { mode: "selected" },
      activations: {
        mode: "selected",
        options: [],
        groups: [],
        selectedIds: [],
      },
      attachments: {
        mode: "selected",
        bindings: [],
      },
    },
  });
}

test("v3 canonicalization fixes physical ordering and hashes set-like state stably", () => {
  const policy = defaultTesseraCombatPolicyV3();
  const first = localTesseraScenarioPolicyContractV3(
    2_000,
    unitScope,
    ["shooting"],
    ["mean-damage", "wipe-probability"],
    {
      ...policy,
      activations: {
        mode: "envelope",
        options: [{
          id: "stratagem:a",
          ownerSide: "player",
          groupId: "stratagems",
          phases: ["shooting"],
          directions: ["opponent-to-player", "player-to-opponent"],
          costs: [{ kind: "command-points", amount: 1 }],
          prerequisites: [{ kind: "battle-round", minimum: 1 }],
        }],
        groups: [{
          id: "stratagems",
          ownerSide: "player",
          maximumActive: 1,
        }],
        includeNoOptionsBaseline: true,
      },
      attachments: {
        mode: "envelope",
        bindings: [{
          side: "player",
          leaderSelectionId: "player:leader",
          bodyguardSelectionId: "player:bodyguard",
          supportingSelectionIds: [],
        }],
        includeUnattachedBaseline: true,
      },
    },
  );
  const scrambled = canonicalTesseraScenarioPolicyContractV3({
    ...first,
    scenarios: [...first.scenarios].reverse().map((scenario) => ({
      ...scenario,
      state: {
        ...scenario.state,
        player: {
          ...scenario.state.player,
          units: [...scenario.state.player.units].reverse(),
        },
        pairs: [...scenario.state.pairs].reverse(),
      },
    })),
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
        bindings: [...first.policy.attachments.bindings].reverse(),
      },
    },
  });

  assert.deepEqual(scrambled, first);
  assert.equal(
    tesseraScenarioPolicyContractV3Sha256(scrambled),
    tesseraScenarioPolicyContractV3Sha256(first),
  );
  assert.match(tesseraScenarioPolicyContractV3Sha256(first), /^[a-f0-9]{64}$/);
  assert.ok(TESSERA_SCENARIO_V3_STATE_KEYS.includes("pair.distanceInches"));
});

test("v3 scope is exact across scenario tuples, unit selections, and pair coverage", () => {
  const contract = localTesseraScenarioPolicyContractV3(
    500,
    unitScope,
    ["shooting"],
    ["mean-damage"],
  );
  const scoped = assertTesseraScenarioPolicyContractV3Scope(
    contract,
    ["shooting"],
    ["mean-damage"],
    unitScope,
  );
  assert.deepEqual(tesseraScenarioPolicyContractV3Scope(scoped), {
    phases: ["shooting"],
    directions: ["opponent-to-player", "player-to-opponent"],
    metrics: ["mean-damage"],
    playerSelectionIds: ["player:bodyguard", "player:leader"],
    opponentSelectionIds: ["opponent:unit"],
  });
  assert.throws(
    () => assertTesseraScenarioPolicyContractV3Scope(
      contract,
      ["fight"],
      ["mean-damage"],
    ),
    /scope must contain exactly/i,
  );
  assert.throws(
    () => assertTesseraScenarioPolicyContractV3Scope(
      contract,
      ["shooting"],
      ["mean-damage"],
      {
        playerSelectionIds: ["different-player-unit"],
        opponentSelectionIds: ["opponent:unit"],
      },
    ),
    /unit scope does not match/i,
  );

  const missingPair = structuredClone(contract);
  missingPair.scenarios[0].state.pairs.pop();
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV3(missingPair),
    /every attacker\/target selection pair/i,
  );
});

test("v3 rejects direction-dependent physical sides and asymmetric exact distances", () => {
  const contract = localTesseraScenarioPolicyContractV3(
    100,
    unitScope,
    ["shooting"],
    ["mean-damage"],
  );
  const directionalState = structuredClone(contract);
  const reverse = directionalState.scenarios.find(
    (scenario) => scenario.direction === "opponent-to-player",
  );
  assert.ok(reverse);
  reverse.state.player.units[0].inCover = true;
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV3(directionalState),
    /physical state differs by direction/i,
  );

  const asymmetricDistance = structuredClone(contract);
  const forward = asymmetricDistance.scenarios.find(
    (scenario) => scenario.direction === "player-to-opponent",
  );
  assert.ok(forward);
  forward.state.pairs[0].distanceInches = 12;
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV3(asymmetricDistance),
    /distance cannot change/i,
  );
});

test("v3 exposes an explicit envelope-only versus selected scalar-claim gate", () => {
  const envelope = localTesseraScenarioPolicyContractV3(
    100,
    unitScope,
    ["shooting"],
    ["mean-damage"],
  );
  assert.deepEqual(
    tesseraScenarioPolicyContractV3ConclusionStatus(envelope),
    {
      mode: "envelope-only",
      scalarClaimsAllowed: false,
      unresolvedDimensions: ["state", "activations", "attachments"],
    },
  );

  const selected = selectedContract();
  assert.deepEqual(
    tesseraScenarioPolicyContractV3ConclusionStatus(selected),
    {
      mode: "selected",
      scalarClaimsAllowed: true,
      unresolvedDimensions: [],
    },
  );

  const unresolvedSelected = structuredClone(envelope);
  unresolvedSelected.policy = {
    ...unresolvedSelected.policy,
    stateResolution: { mode: "selected" },
    activations: {
      mode: "selected",
      options: [],
      groups: [],
      selectedIds: [],
    },
    attachments: {
      mode: "selected",
      bindings: [],
    },
  };
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV3(unresolvedSelected),
    /selected state resolution cannot contain unknown/i,
  );
});

test("v3 validates side-owned activation costs, groups, and prerequisites", () => {
  const selected = selectedContract(1);
  const withActivation = {
    ...selected,
    policy: {
      ...selected.policy,
      activations: {
        mode: "selected" as const,
        options: [{
          id: "stratagem:player",
          ownerSide: "player" as const,
          groupId: "stratagems",
          phases: ["shooting" as const],
          directions: ["player-to-opponent" as const],
          costs: [{ kind: "command-points" as const, amount: 2 }],
          prerequisites: [{
            kind: "unit-state" as const,
            side: "player" as const,
            selectionId: "player:leader",
            field: "battleShocked" as const,
            equals: false,
          }],
        }],
        groups: [{
          id: "stratagems",
          ownerSide: "player" as const,
          maximumActive: 1,
        }],
        selectedIds: ["stratagem:player"],
      },
    },
  };
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV3(withActivation),
    /require 2 command points/i,
  );

  const funded = structuredClone(withActivation);
  for (const scenario of funded.scenarios) {
    scenario.state.player.resources.commandPoints = 2;
  }
  assert.equal(
    canonicalTesseraScenarioPolicyContractV3(funded)
      .policy.activations.options[0].ownerSide,
    "player",
  );

  const wrongGroupOwner = structuredClone(funded);
  (wrongGroupOwner.policy.activations.groups[0] as {
    ownerSide: "player" | "opponent";
  }).ownerSide = "opponent";
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV3(wrongGroupOwner),
    /different physical owners/i,
  );

  const failedPrerequisite = structuredClone(funded);
  for (const scenario of failedPrerequisite.scenarios) {
    scenario.state.player.units.find(
      (unit) => unit.selectionId === "player:leader",
    )!.battleShocked = true;
  }
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV3(failedPrerequisite),
    /failed unit-state prerequisite/i,
  );
});

test("v3 attachment bindings retain physical ownership in selected and envelope modes", () => {
  const selected = selectedContract();
  const attached = canonicalTesseraScenarioPolicyContractV3({
    ...selected,
    policy: {
      ...selected.policy,
      attachments: {
        mode: "selected",
        bindings: [{
          side: "player",
          leaderSelectionId: "player:leader",
          bodyguardSelectionId: "player:bodyguard",
          supportingSelectionIds: [],
        }],
      },
    },
  });
  assert.equal(attached.policy.attachments.bindings[0].side, "player");

  const wrongSide = structuredClone(attached);
  wrongSide.policy.attachments.bindings[0].side = "opponent";
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV3(wrongSide),
    /not declared on the opponent side/i,
  );
});

test("v1 migration binds directional state to physical player/opponent units", () => {
  const v1 = localTesseraScenarioContract(
    777,
    ["fight"],
    ["mean-damage"],
  );
  const migrated = migrateTesseraScenarioContractV1ToV3(v1, unitScope);

  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.policy.modelingMode, "base-profile");
  assert.equal(migrated.policy.stateResolution.mode, "envelope");
  assert.equal(migrated.policy.activations.mode, "selected");
  assert.equal(migrated.policy.attachments.mode, "selected");
  for (const scenario of migrated.scenarios) {
    assert.ok(
      scenario.state.player.units.every((unit) => unit.chargedThisTurn),
    );
    assert.ok(
      scenario.state.opponent.units.every((unit) => unit.chargedThisTurn),
    );
    assert.ok(scenario.state.pairs.every(
      (pair) => pair.distanceInches === "unknown",
    ));
    assert.equal(scenario.iterations, 777);
  }
});

test("v2 migration requires activation ownership and rejects contradictory directions", () => {
  const policy: TesseraCombatPolicyV2 = {
    modelingMode: "rules-aware",
    activations: {
      mode: "selected",
      options: [{
        id: "stratagem:a",
        groupId: "stratagems",
        resourceCost: 2,
      }],
      groups: [{ id: "stratagems", maximumActive: 1 }],
      resourceBudget: 2,
      selectedIds: ["stratagem:a"],
    },
    attachments: {
      mode: "selected",
      bindings: [{
        leaderSelectionId: "player:leader",
        bodyguardSelectionId: "player:bodyguard",
        supportingSelectionIds: [],
      }],
    },
    limits: { maxAttachmentPlans: 16, maxJointVariants: 64 },
  };
  const v2 = localTesseraScenarioPolicyContractV2(
    100,
    ["shooting"],
    ["mean-damage"],
    policy,
  );
  assert.throws(
    () => migrateTesseraScenarioPolicyContractV2ToV3(v2, unitScope),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code ===
        "TESSERA_SCENARIO_POLICY_CONTRACT_V3_MIGRATION_NEEDS_INPUT",
  );

  const migrated = migrateTesseraScenarioPolicyContractV2ToV3(v2, {
    ...unitScope,
    activationOwners: { "stratagem:a": "player" },
  });
  assert.equal(migrated.policy.activations.options[0].ownerSide, "player");
  assert.equal(migrated.policy.attachments.bindings[0].side, "player");
  assert.ok(migrated.scenarios.every(
    (scenario) => scenario.state.player.resources.commandPoints === 2,
  ));

  const contradictory = structuredClone(v2);
  for (const scenario of contradictory.scenarios) {
    scenario.engagement.distanceInches =
      scenario.direction === "player-to-opponent" ? 12 : 18;
  }
  assert.throws(
    () => migrateTesseraScenarioPolicyContractV2ToV3(contradictory, {
      ...unitScope,
      activationOwners: { "stratagem:a": "player" },
    }),
    /contradictory directional.*distance/i,
  );
});

test("v3 contracts reject legacy or otherwise undeclared state fields", () => {
  const contract = localTesseraScenarioPolicyContractV3(
    100,
    unitScope,
    ["shooting"],
    ["mean-damage"],
  );
  const withLegacyState = structuredClone(contract) as unknown as {
    scenarios: Array<{
      state: TesseraScenarioPhysicalStateV3 & { targetInCover?: boolean };
    }>;
  };
  withLegacyState.scenarios[0].state.targetInCover = true;
  assert.throws(
    () => canonicalTesseraScenarioPolicyContractV3(withLegacyState),
    /unrecognized key.*targetInCover/i,
  );
});

test("v3 selected baseline is explicit and scalar-claim eligible", () => {
  const contract = selectedBaselineTesseraScenarioPolicyContractV3(
    100,
    unitScope,
    ["shooting", "fight"],
    ["mean-damage"],
  );
  assert.deepEqual(
    tesseraScenarioPolicyContractV3ConclusionStatus(contract),
    {
      mode: "selected",
      scalarClaimsAllowed: true,
      unresolvedDimensions: [],
    },
  );
  assert.ok(contract.scenarios.every((scenario) =>
    scenario.state.pairs.every(
      (pair) =>
        pair.distanceInches === 0 &&
        pair.withinRange === true &&
        pair.targetVisible === true,
    )
  ));
  assert.equal(contract.policy.activations.mode, "selected");
  assert.equal(contract.policy.attachments.mode, "selected");
});
