import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  currentRosterSourceData,
  type ProfilePolicyV1,
} from "../lib/rosterpilot";
import {
  compileCombatBridgeV2,
  defaultCombatPolicyV1,
  type BundleCombatRuleRecordV1,
  type CombatBridgeCellInputV2,
  type CombatBundleBindingV2,
  type CombatScenarioContextV2,
} from "../lib/rosterpilot/combat-bridge";
import {
  LOCAL_TESSERA_COMPILER_VERSION,
  localInputSha256,
  serializeLocalTesseraEngineInput,
  type LocalTesseraEngineInput,
  type LocalTesseraEngineUnit,
} from "../local/tessera/local-engine-input";
import { runLocalTesseraEngineMatchup } from "../local/tessera/local-engine";
import {
  combatPolicyV1FromTesseraCombatPolicyV2,
  combatScenarioContextV2FromTesseraScenario,
} from "../local/tessera/combat-bridge-input";
import { profilePolicyHash } from "../local/tessera/profile-policy";
import {
  canonicalTesseraScenarioPolicyContractV2,
  defaultTesseraCombatPolicyV2,
  localTesseraScenarioPolicyContractV2,
} from "../local/tessera/scenario-contract-v2";

const profilePolicy: ProfilePolicyV1 = {
  schemaVersion: 1,
  policyKind: "tessera-profile-policy",
  entries: [],
};

function unit(input: {
  instanceId: string;
  selectionId: string;
  unitId: string;
  name: string;
  attacks: number;
}): LocalTesseraEngineUnit {
  return {
    instanceId: input.instanceId,
    selectionId: input.selectionId,
    unitId: input.unitId,
    occurrence: 1,
    label: input.name,
    name: input.name,
    models: 1,
    T: 5,
    SV: 3,
    W: 3,
    INV: null,
    FNP: null,
    points: 100,
    keywords: ["INFANTRY"],
    weapons: [
      {
        name: `${input.name} blade`,
        type: "melee",
        count: 1,
        A: input.attacks,
        WS: 3,
        S: 6,
        AP: -1,
        D: 2,
        keywords: [],
      },
    ],
  };
}

function localInput(input: {
  bundleId: string;
  rosterId: string;
  rosterName: string;
  factionId: string;
  unit: LocalTesseraEngineUnit;
}): LocalTesseraEngineInput {
  return {
    schemaVersion: 1,
    kind: "rosterpilot-local-engine-input",
    compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
    evaluationMode: "base-profile-evaluation",
    bundleId: input.bundleId,
    rosterId: input.rosterId,
    rosterFingerprint: `${input.rosterId}-fingerprint`,
    rosterName: input.rosterName,
    factionId: input.factionId,
    factionName: input.factionId,
    rosterRulesHash:
      input.rosterId === "player-roster"
        ? "1".repeat(64)
        : "0".repeat(64),
    factionRulesHash:
      input.rosterId === "player-roster"
        ? "2".repeat(64)
        : "3".repeat(64),
    mappingHash:
      input.rosterId === "player-roster"
        ? "4".repeat(64)
        : "5".repeat(64),
    totalPoints: 100,
    profilePolicySha256: profilePolicyHash(profilePolicy),
    profileRequirements: [],
    units: [input.unit],
    limitations: {
      unmodeledSystems: ["fixture-only systems"],
      omittedDatasheetAbilities: [],
      omittedWargear: [],
      omittedEnhancements: [],
      unsupportedWeaponKeywords: [],
      frozenChoices: [],
    },
  };
}

function bridgeScenario(): CombatScenarioContextV2 {
  return combatScenarioContextV2FromTesseraScenario(
    localTesseraScenarioPolicyContractV2(
      800,
      ["fight"],
      ["mean-damage"],
    ).scenarios[0],
  );
}

function optionalAttacksRule(): BundleCombatRuleRecordV1 {
  return {
    abilityId: "fixture-optional-attacks",
    abilityName: "Fixture optional attacks",
    entityHash: "fixture-optional-attacks-entity",
    effect: {
      type: "stat-modifier",
      target: "unit",
      modifier: { stat: "A", operation: "add", value: 12 },
    },
    source: { kind: "unit", unitId: "attacker-unit" },
    phases: ["fight"],
    phaseMappingStatus: "verified",
    activation: {
      kind: "optional",
      id: "fixture-optional-attacks",
      label: "Fixture optional attacks",
      group: null,
      cpCost: 0,
    },
    unsupportedRelevance: "combat",
  };
}

function bridgeCell(input: {
  direction: "player-to-opponent" | "opponent-to-player";
  attackerRosterId: string;
  attackerSelectionId: string;
  attackerUnitId: string;
  attackerFactionId: string;
  targetRosterId: string;
  targetSelectionId: string;
  targetUnitId: string;
  targetFactionId: string;
  attackerRules?: BundleCombatRuleRecordV1[];
  targetRules?: BundleCombatRuleRecordV1[];
  includeEquivalentRosterPlan?: boolean;
}): CombatBridgeCellInputV2 {
  return {
    cellId: [
      input.direction,
      "fight",
      "mean-damage",
      input.attackerSelectionId,
      input.targetSelectionId,
    ].join(":"),
    direction: input.direction,
    metric: "mean-damage",
    attacker: {
      rosterId: input.attackerRosterId,
      selectionId: input.attackerSelectionId,
      unitId: input.attackerUnitId,
      factionId: input.attackerFactionId,
      keywords: ["Infantry"],
    },
    target: {
      rosterId: input.targetRosterId,
      selectionId: input.targetSelectionId,
      unitId: input.targetUnitId,
      factionId: input.targetFactionId,
      keywords: ["Infantry"],
    },
    scenario: bridgeScenario(),
    ruleVariants: [
      {
        attachmentPlan: { id: "unattached", attacker: [], target: [] },
        attackerRules: input.attackerRules ?? [],
        targetRules: input.targetRules ?? [],
      },
      ...(input.includeEquivalentRosterPlan
        ? [{
            attachmentPlan: {
              id: "unrelated-attached-unit",
              attacker: [{
                leaderSelectionId: "unrelated-leader-selection",
                bodyguardSelectionId: "unrelated-bodyguard-selection",
                supportSelectionIds: [],
              }],
              target: [],
            },
            attackerRules: input.attackerRules ?? [],
            targetRules: input.targetRules ?? [],
          }]
        : []),
    ],
  };
}

async function fixture(options: {
  maxJointVariants?: number;
  playerAttackerRules?: BundleCombatRuleRecordV1[];
  playerTargetRules?: BundleCombatRuleRecordV1[];
} = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-local-combat-bridge-"),
  );
  const bundleId = currentRosterSourceData("adeptus-custodes").bundleId;
  const playerUnit = unit({
    instanceId: "111111111111111111111111",
    selectionId: "player-selection",
    unitId: "attacker-unit",
    name: "Player attacker",
    attacks: 4,
  });
  const opponentUnit = unit({
    instanceId: "222222222222222222222222",
    selectionId: "opponent-selection",
    unitId: "target-unit",
    name: "Opponent target",
    attacks: 4,
  });
  const player = localInput({
    bundleId,
    rosterId: "player-roster",
    rosterName: "Player",
    factionId: "adeptus-custodes",
    unit: playerUnit,
  });
  const opponent = localInput({
    bundleId,
    rosterId: "opponent-roster",
    rosterName: "Opponent",
    factionId: "world-eaters",
    unit: opponentUnit,
  });
  const playerContent = serializeLocalTesseraEngineInput(player);
  const opponentContent = serializeLocalTesseraEngineInput(opponent);
  const playerPath = path.join(directory, "player.json");
  const opponentPath = path.join(directory, "opponent.json");
  await Promise.all([
    writeFile(playerPath, playerContent),
    writeFile(opponentPath, opponentContent),
  ]);
  const matchup = {
    profileDirectory: directory,
    playerRoszPath: playerPath,
    playerName: player.rosterName,
    opponentRoszPath: opponentPath,
    opponentName: opponent.rosterName,
    playerSimulationInput: {
      kind: "rosterpilot-local-engine-input" as const,
      path: playerPath,
      sha256: localInputSha256(playerContent),
      bundleId,
      compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
    },
    opponentSimulationInput: {
      kind: "rosterpilot-local-engine-input" as const,
      path: opponentPath,
      sha256: localInputSha256(opponentContent),
      bundleId,
      compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
    },
    phases: ["fight" as const],
    metrics: ["mean-damage" as const],
    profilePolicy,
  };
  const bridgeBundle: CombatBundleBindingV2 = {
    bundleId,
    engineDataSchemaVersion: 3,
    semanticAuthority: "bundle-manifest-verified",
    playerRosterId: player.rosterId,
    opponentRosterId: opponent.rosterId,
    playerRosterFingerprint: player.rosterFingerprint,
    opponentRosterFingerprint: opponent.rosterFingerprint,
    playerFactionId: player.factionId,
    opponentFactionId: opponent.factionId,
    playerRosterRulesHash: player.rosterRulesHash ?? "1".repeat(64),
    opponentRosterRulesHash:
      opponent.rosterRulesHash ?? "0".repeat(64),
    playerFactionRulesHash: "2".repeat(64),
    opponentFactionRulesHash: "3".repeat(64),
    playerMappingHash: "4".repeat(64),
    opponentMappingHash: "5".repeat(64),
    portfolioHash: null,
  };
  const defaultCombatPolicy = defaultCombatPolicyV1();
  const combatPolicy = {
    ...defaultCombatPolicy,
    limits: {
      maxAttachmentPlans:
        defaultCombatPolicy.limits?.maxAttachmentPlans ?? 16,
      maxJointVariants:
        options.maxJointVariants ??
        defaultCombatPolicy.limits?.maxJointVariants ??
        64,
    },
  };
  const combatBridge = await compileCombatBridgeV2({
    bundle: bridgeBundle,
    policy: combatPolicy,
    cells: [
      bridgeCell({
        direction: "player-to-opponent",
        attackerRosterId: player.rosterId,
        attackerSelectionId: playerUnit.selectionId,
        attackerUnitId: "attacker-unit",
        attackerFactionId: player.factionId,
        targetRosterId: opponent.rosterId,
        targetSelectionId: opponentUnit.selectionId,
        targetUnitId: "target-unit",
        targetFactionId: opponent.factionId,
        attackerRules:
          options.playerAttackerRules ?? [optionalAttacksRule()],
        targetRules: options.playerTargetRules,
        includeEquivalentRosterPlan: true,
      }),
      bridgeCell({
        direction: "opponent-to-player",
        attackerRosterId: opponent.rosterId,
        attackerSelectionId: opponentUnit.selectionId,
        attackerUnitId: "target-unit",
        attackerFactionId: opponent.factionId,
        targetRosterId: player.rosterId,
        targetSelectionId: playerUnit.selectionId,
        targetUnitId: "attacker-unit",
        targetFactionId: player.factionId,
      }),
    ],
  });
  assert.notEqual(
    combatBridge.coverage.status,
    "unusable",
    JSON.stringify(combatBridge.diagnostics, null, 2),
  );
  return { directory, matchup, combatBridge, combatPolicy };
}

test("bundle-matched combat bridge expands a deterministic local matrix cell into a visible envelope", async () => {
  const { directory, matchup, combatBridge } = await fixture();
  try {
    const scenarioPolicyContractV2 = localTesseraScenarioPolicyContractV2(
      800,
      ["fight"],
      ["mean-damage"],
    );
    const first = await runLocalTesseraEngineMatchup({
      ...matchup,
      scenarioPolicyContractV2,
      combatBridge,
    });
    const second = await runLocalTesseraEngineMatchup({
      ...matchup,
      scenarioPolicyContractV2,
      combatBridge,
    });
    const firstScenario = first.scenarios.find(
      (entry) => entry.direction === "player-to-opponent",
    );
    const secondScenario = second.scenarios.find(
      (entry) => entry.direction === "player-to-opponent",
    );
    assert.ok(firstScenario);
    assert.ok(secondScenario);
    const firstCell = firstScenario.cells[0];
    const secondCell = secondScenario.cells[0];
    assert.ok(firstCell.combatEnvelope);
    assert.equal(firstCell.combatEnvelope.variantCount, 2);
    assert.equal(firstCell.combatEnvelope.sourceVariantCount, 4);
    assert.equal(firstCell.metricValue, firstCell.combatEnvelope.median);
    assert.ok(firstCell.combatEnvelope.min <= firstCell.combatEnvelope.median);
    assert.ok(firstCell.combatEnvelope.median < firstCell.combatEnvelope.max);
    assert.equal(firstCell.combatEnvelope.coverage.status, "complete");
    assert.equal(
      firstCell.combatEnvelope.coverage.claimEligibility,
      "decision-grade",
    );
    assert.equal(firstCell.combatEnvelope.bridgeSha256, combatBridge.bridgeSha256);
    assert.deepEqual(firstCell.combatEnvelope, secondCell.combatEnvelope);
    assert.equal(firstScenario.matrixSha256, secondScenario.matrixSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rules-aware v2 local execution without a combat bridge fails closed", async () => {
  const { directory, matchup } = await fixture();
  try {
    await assert.rejects(
      runLocalTesseraEngineMatchup({
        ...matchup,
        scenarioPolicyContractV2: localTesseraScenarioPolicyContractV2(
          20,
          ["fight"],
          ["mean-damage"],
        ),
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_COMBAT_BRIDGE_REQUIRED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local adapter-v2 refuses a scalar run when Damage rerolls are required", async () => {
  const damageReroll: BundleCombatRuleRecordV1 = {
    abilityId: "fixture-damage-reroll",
    abilityName: "Fixture Damage reroll",
    entityHash: "fixture-damage-reroll-entity",
    effect: {
      type: "re-roll",
      target: "unit",
      modifier: { roll: "damage", subset: "ones" },
    },
    source: { kind: "unit", unitId: "attacker-unit" },
    phases: ["fight"],
    phaseMappingStatus: "verified",
    activation: { kind: "always" },
    unsupportedRelevance: "combat",
  };
  const { directory, matchup, combatBridge } = await fixture({
    playerAttackerRules: [damageReroll],
  });
  try {
    await assert.rejects(
      runLocalTesseraEngineMatchup({
        ...matchup,
        scenarioPolicyContractV2:
          localTesseraScenarioPolicyContractV2(
            20,
            ["fight"],
            ["mean-damage"],
          ),
        combatBridge,
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_COMBAT_BRIDGE_ADAPTER_UNUSABLE" &&
        /reroll weapon Damage/i.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unit-wide save and Toughness patches change the executed local result", async () => {
  const defensiveStats: BundleCombatRuleRecordV1 = {
    abilityId: "fixture-unit-wide-defence",
    abilityName: "Fixture unit-wide defence",
    entityHash: "fixture-unit-wide-defence-entity",
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
          modifier: { stat: "T", operation: "add", value: 4 },
        },
      ],
    },
    source: { kind: "unit", unitId: "target-unit" },
    phases: ["fight"],
    phaseMappingStatus: "verified",
    activation: { kind: "always" },
    unsupportedRelevance: "combat",
  };
  const baseline = await fixture({ playerAttackerRules: [] });
  const patched = await fixture({
    playerAttackerRules: [],
    playerTargetRules: [defensiveStats],
  });
  const scenarioPolicyContractV2 = localTesseraScenarioPolicyContractV2(
    4_000,
    ["fight"],
    ["mean-damage"],
  );
  try {
    const baselineResult = await runLocalTesseraEngineMatchup({
      ...baseline.matchup,
      scenarioPolicyContractV2,
      combatBridge: baseline.combatBridge,
    });
    const patchedResult = await runLocalTesseraEngineMatchup({
      ...patched.matchup,
      scenarioPolicyContractV2,
      combatBridge: patched.combatBridge,
    });
    const baselineCell = baselineResult.scenarios.find(
      (scenario) => scenario.direction === "player-to-opponent",
    )?.cells[0];
    const patchedCell = patchedResult.scenarios.find(
      (scenario) => scenario.direction === "player-to-opponent",
    )?.cells[0];
    assert.ok(baselineCell);
    assert.ok(patchedCell);
    assert.equal(patchedCell.combatEnvelope?.coverage.status, "complete");
    assert.ok(
      patchedCell.metricValue < baselineCell.metricValue * 0.75,
      `expected ${patchedCell.metricValue} to be materially below ${baselineCell.metricValue}`,
    );
  } finally {
    await Promise.all([
      rm(baseline.directory, { recursive: true, force: true }),
      rm(patched.directory, { recursive: true, force: true }),
    ]);
  }
});

test("unknown direct engagement booleans fail explicitly in the scalar local engine", async () => {
  const { directory, matchup } = await fixture();
  try {
    const base = localTesseraScenarioPolicyContractV2(
      20,
      ["fight"],
      ["mean-damage"],
      {
        ...defaultTesseraCombatPolicyV2(),
        modelingMode: "base-profile",
      },
    );
    const unresolved = canonicalTesseraScenarioPolicyContractV2({
      ...base,
      scenarios: base.scenarios.map((scenario, index) =>
        index === 0
          ? {
              ...scenario,
              engagement: {
                ...scenario.engagement,
                targetInCover: "unknown" as const,
              },
            }
          : scenario,
      ),
    });
    await assert.rejects(
      runLocalTesseraEngineMatchup({
        ...matchup,
        scenarioPolicyContractV2: unresolved,
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_LOCAL_ENGAGEMENT_UNRESOLVED" &&
        error.message.includes("targetInCover"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a capped exact combat envelope requires explicit state selection", async () => {
  const { directory, matchup, combatBridge } = await fixture({
    maxJointVariants: 1,
  });
  try {
    const base = localTesseraScenarioPolicyContractV2(
      20,
      ["fight"],
      ["mean-damage"],
    );
    const scenarioPolicyContractV2 =
      canonicalTesseraScenarioPolicyContractV2({
        ...base,
        policy: {
          ...base.policy,
          limits: {
            ...base.policy.limits,
            maxJointVariants: 1,
          },
        },
      });
    assert.ok(
      combatBridge.cells.some((cell) =>
        cell.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "COMBAT_JOINT_ENVELOPE_TRUNCATED",
        ),
      ),
    );
    await assert.rejects(
      runLocalTesseraEngineMatchup({
        ...matchup,
        scenarioPolicyContractV2,
        combatBridge,
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_COMBAT_STATE_SELECTION_REQUIRED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selected Leader attachments execute as one pooled combat formation", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-local-attached-combat-"),
  );
  try {
    const bundleId = currentRosterSourceData("adeptus-custodes").bundleId;
    const bodyguard = unit({
      instanceId: "333333333333333333333333",
      selectionId: "bodyguard-selection",
      unitId: "bodyguard-unit",
      name: "Bodyguard",
      attacks: 1,
    });
    const leader = unit({
      instanceId: "444444444444444444444444",
      selectionId: "leader-selection",
      unitId: "leader-unit",
      name: "Leader",
      attacks: 20,
    });
    const target = unit({
      instanceId: "555555555555555555555555",
      selectionId: "target-selection",
      unitId: "target-unit",
      name: "Target",
      attacks: 1,
    });
    const player = {
      ...localInput({
        bundleId,
        rosterId: "attached-player-roster",
        rosterName: "Attached player",
        factionId: "adeptus-custodes",
        unit: bodyguard,
      }),
      totalPoints: 200,
      units: [bodyguard, leader],
    };
    const opponent = localInput({
      bundleId,
      rosterId: "attached-opponent-roster",
      rosterName: "Opponent",
      factionId: "world-eaters",
      unit: target,
    });
    const playerContent = serializeLocalTesseraEngineInput(player);
    const opponentContent = serializeLocalTesseraEngineInput(opponent);
    const playerPath = path.join(directory, "player.json");
    const opponentPath = path.join(directory, "opponent.json");
    await Promise.all([
      writeFile(playerPath, playerContent),
      writeFile(opponentPath, opponentContent),
    ]);

    const baseContract = localTesseraScenarioPolicyContractV2(
      800,
      ["fight"],
      ["mean-damage"],
    );
    const scenarioPolicyContractV2 =
      canonicalTesseraScenarioPolicyContractV2({
        ...baseContract,
        policy: {
          ...baseContract.policy,
          attachments: {
            mode: "selected" as const,
            bindings: [{
              leaderSelectionId: leader.selectionId,
              bodyguardSelectionId: bodyguard.selectionId,
              supportingSelectionIds: [],
            }],
          },
        },
      });
    const attachmentPlan = {
      id: "selected-player-formation",
      attacker: [{
        leaderSelectionId: leader.selectionId,
        bodyguardSelectionId: bodyguard.selectionId,
        supportSelectionIds: [],
      }],
      target: [],
    };
    const reverseAttachmentPlan = {
      id: "selected-player-formation-reverse",
      attacker: [],
      target: attachmentPlan.attacker,
    };
    const cell = (
      direction: "player-to-opponent" | "opponent-to-player",
      attacker: LocalTesseraEngineUnit,
      targetUnit: LocalTesseraEngineUnit,
    ): CombatBridgeCellInputV2 => ({
      cellId: [
        direction,
        "fight",
        "mean-damage",
        attacker.selectionId,
        targetUnit.selectionId,
      ].join(":"),
      direction,
      metric: "mean-damage",
      attacker: {
        rosterId:
          direction === "player-to-opponent"
            ? player.rosterId
            : opponent.rosterId,
        selectionId: attacker.selectionId,
        unitId: attacker.unitId!,
        factionId:
          direction === "player-to-opponent"
            ? player.factionId
            : opponent.factionId,
        keywords: attacker.keywords,
      },
      target: {
        rosterId:
          direction === "player-to-opponent"
            ? opponent.rosterId
            : player.rosterId,
        selectionId: targetUnit.selectionId,
        unitId: targetUnit.unitId!,
        factionId:
          direction === "player-to-opponent"
            ? opponent.factionId
            : player.factionId,
        keywords: targetUnit.keywords,
      },
      scenario: combatScenarioContextV2FromTesseraScenario(
        scenarioPolicyContractV2.scenarios.find(
          (scenario) => scenario.direction === direction,
        )!,
      ),
      ruleVariants: [{
        attachmentPlan:
          direction === "player-to-opponent"
            ? attachmentPlan
            : reverseAttachmentPlan,
        attackerRules: [],
        targetRules: [],
      }],
    });
    const combatBridge = await compileCombatBridgeV2({
      bundle: {
        bundleId,
        engineDataSchemaVersion: 3,
        semanticAuthority: "bundle-manifest-verified",
        playerRosterId: player.rosterId,
        opponentRosterId: opponent.rosterId,
        playerRosterFingerprint: player.rosterFingerprint,
        opponentRosterFingerprint: opponent.rosterFingerprint,
        playerFactionId: player.factionId,
        opponentFactionId: opponent.factionId,
        playerRosterRulesHash: player.rosterRulesHash!,
        opponentRosterRulesHash: opponent.rosterRulesHash!,
        playerFactionRulesHash: player.factionRulesHash!,
        opponentFactionRulesHash: opponent.factionRulesHash!,
        playerMappingHash: player.mappingHash!,
        opponentMappingHash: opponent.mappingHash!,
        portfolioHash: null,
      },
      policy: combatPolicyV1FromTesseraCombatPolicyV2(
        scenarioPolicyContractV2.policy,
      ),
      cells: [
        cell("player-to-opponent", bodyguard, target),
        cell("player-to-opponent", leader, target),
        cell("opponent-to-player", target, bodyguard),
        cell("opponent-to-player", target, leader),
      ],
    });
    const result = await runLocalTesseraEngineMatchup({
      profileDirectory: directory,
      playerRoszPath: playerPath,
      playerName: player.rosterName,
      opponentRoszPath: opponentPath,
      opponentName: opponent.rosterName,
      playerSimulationInput: {
        kind: "rosterpilot-local-engine-input",
        path: playerPath,
        sha256: localInputSha256(playerContent),
        bundleId,
        compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
      },
      opponentSimulationInput: {
        kind: "rosterpilot-local-engine-input",
        path: opponentPath,
        sha256: localInputSha256(opponentContent),
        bundleId,
        compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
      },
      phases: ["fight"],
      metrics: ["mean-damage"],
      profilePolicy,
      scenarioPolicyContractV2,
      combatBridge,
    });

    const forward = result.scenarios.find(
      (scenario) => scenario.direction === "player-to-opponent",
    );
    const reverse = result.scenarios.find(
      (scenario) => scenario.direction === "opponent-to-player",
    );
    assert.ok(forward);
    assert.ok(reverse);
    assert.equal(forward.cells.length, 1);
    assert.equal(reverse.cells.length, 1);
    assert.match(forward.cells[0].attacker, /Bodyguard.*Leader/);
    assert.match(reverse.cells[0].target, /Bodyguard.*Leader/);
    assert.ok(forward.cells[0].metricValue > 2.5);
    assert.equal(
      forward.cells[0].combatEnvelope?.attachmentPlanId,
      attachmentPlan.id,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
