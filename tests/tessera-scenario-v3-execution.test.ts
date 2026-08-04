import assert from "node:assert/strict";
import test from "node:test";

import type { LocalTesseraEngineUnit } from "../local/tessera/local-engine-input";
import {
  projectLocalTesseraScenarioV3Cell,
} from "../local/tessera/scenario-v3-execution";
import type { TesseraScenarioEntryV3 } from "../local/tessera/scenario-contract-v3";

function unit(
  selectionId: string,
  side: "player" | "opponent",
  ranges: Array<{ name: string; range: number; keywords: string[] }>,
): LocalTesseraEngineUnit {
  return {
    instanceId: `${side}-${selectionId}`,
    selectionId,
    unitId: `${side}-unit-${selectionId}`,
    occurrence: 1,
    label: selectionId,
    name: selectionId,
    models: 1,
    T: 5,
    SV: 2,
    W: 3,
    INV: 4,
    FNP: null,
    keywords: [],
    weapons: ranges.map((profile, index) => ({
      weaponId: `${selectionId}-weapon-${index}`,
      equipmentId: `${selectionId}-equipment-${index}`,
      profileId: `${selectionId}-profile-${index}`,
      bearerSelectionId: selectionId,
      loadoutGroupId: `${selectionId}-loadout`,
      name: profile.name,
      type: "ranged" as const,
      rangeInches: profile.range,
      count: 1,
      A: 1,
      BS: 2,
      S: 4,
      AP: 0,
      D: 1,
      keywords: profile.keywords,
    })),
  };
}

function physicalUnit(selectionId: string, overrides = {}) {
  return {
    selectionId,
    movement: "stationary" as const,
    chargedThisTurn: false,
    wasChargedThisTurn: false,
    inCover: false,
    onObjective: false,
    controlsObjective: false,
    strength: "starting" as const,
    damage: "healthy" as const,
    battleShocked: false,
    eligibleToFight: true,
    hasFought: false,
    ...overrides,
  };
}

function scenario(overrides: {
  distance?: number;
  withinRange?: boolean;
  withinRapidFireRange?: boolean;
  withinMeltaRange?: boolean;
  withinConversionRange?: boolean;
  targetVisible?: boolean;
  indirectFire?: boolean;
  phase?: "shooting" | "fight";
  playerUnit?: ReturnType<typeof physicalUnit>;
} = {}): TesseraScenarioEntryV3 {
  return {
    phase: overrides.phase ?? "shooting",
    direction: "player-to-opponent",
    metric: "mean-damage",
    iterations: 100,
    state: {
      battleRound: 1,
      timing: "main",
      player: {
        resources: { commandPoints: 0, factionResources: [] },
        armyAbilities: [],
        oncePerBattle: [],
        units: [overrides.playerUnit ?? physicalUnit("p1")],
      },
      opponent: {
        resources: { commandPoints: 0, factionResources: [] },
        armyAbilities: [],
        oncePerBattle: [],
        units: [physicalUnit("o1")],
      },
      pairs: [{
        attackerSide: "player",
        attackerSelectionId: "p1",
        targetSide: "opponent",
        targetSelectionId: "o1",
        distanceInches: overrides.distance ?? 10,
        withinRange: overrides.withinRange ?? true,
        withinRapidFireRange:
          overrides.withinRapidFireRange ?? true,
        withinMeltaRange: overrides.withinMeltaRange ?? false,
        withinConversionRange:
          overrides.withinConversionRange ?? false,
        targetVisible: overrides.targetVisible ?? true,
        indirectFire: overrides.indirectFire ?? false,
        targetCondition: false,
      }],
    },
  };
}

test("v3 execution applies real per-profile range conditions", () => {
  const attacker = unit("p1", "player", [
    { name: "short", range: 12, keywords: ["RAPID FIRE 1"] },
    { name: "long", range: 24, keywords: ["RAPID FIRE 2"] },
    { name: "melta", range: 18, keywords: ["MELTA 2"] },
  ]);
  const projection = projectLocalTesseraScenarioV3Cell({
    scenario: scenario({
      distance: 10,
      withinRapidFireRange: true,
      withinMeltaRange: false,
    }),
    attacker,
    target: unit("o1", "opponent", []),
  });
  assert.equal(projection.attackEligible, true);
  assert.deepEqual(
    projection.attacker.weapons.map((weapon) => weapon.keywords),
    [[], ["RAPID FIRE 2"], []],
  );
  assert.match(projection.combatStateSha256, /^[0-9a-f]{64}$/);
});

test("v3 execution removes out-of-range profiles and exposes a zero cell", () => {
  const projection = projectLocalTesseraScenarioV3Cell({
    scenario: scenario({
      distance: 30,
      withinRange: false,
      withinRapidFireRange: false,
    }),
    attacker: unit("p1", "player", [
      { name: "rifle", range: 24, keywords: ["RAPID FIRE 1"] },
    ]),
    target: unit("o1", "opponent", []),
  });
  assert.equal(projection.attackEligible, false);
  assert.deepEqual(projection.attacker.weapons, []);
});

test("v3 execution rejects selected range state that contradicts distance", () => {
  assert.throws(
    () => projectLocalTesseraScenarioV3Cell({
      scenario: scenario({
        distance: 5,
        withinRapidFireRange: false,
      }),
      attacker: unit("p1", "player", [
        { name: "rifle", range: 24, keywords: ["RAPID FIRE 1"] },
      ]),
      target: unit("o1", "opponent", []),
    }),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code ===
        "TESSERA_SCENARIO_POLICY_CONTRACT_V3_STATE_CONTRADICTION",
  );
});

test("v3 fight execution respects selected fight eligibility", () => {
  const attacker = unit("p1", "player", []);
  attacker.weapons = [{
    name: "blade",
    type: "melee",
    rangeInches: null,
    count: 1,
    A: 4,
    WS: 2,
    S: 6,
    AP: -2,
    D: 2,
    keywords: [],
  }];
  const projection = projectLocalTesseraScenarioV3Cell({
    scenario: scenario({
      phase: "fight",
      playerUnit: physicalUnit("p1", { eligibleToFight: false }),
    }),
    attacker,
    target: unit("o1", "opponent", []),
  });
  assert.equal(projection.attackEligible, false);
});
