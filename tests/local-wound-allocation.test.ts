import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allocateMortalWounds,
  allocateStandardDamage,
  initializeUnitModels,
  type GameSimulationUnit,
  type ModelWoundState,
} from "../local/tessera/game-loop-simulator";

test("Model-level wound allocation: mandatory allocation to damaged models and non-spillover on standard damage", () => {
  // 5 Custodian Guard (3 Wounds per model)
  const squad: ModelWoundState[] = [
    { modelIndex: 0, currentWounds: 3, maxWounds: 3 },
    { modelIndex: 1, currentWounds: 3, maxWounds: 3 },
    { modelIndex: 2, currentWounds: 3, maxWounds: 3 },
    { modelIndex: 3, currentWounds: 3, maxWounds: 3 },
    { modelIndex: 4, currentWounds: 3, maxWounds: 3 },
  ];

  // 1. Apply a Damage 2 attack -> Model 0 takes 2 damage (1 wound remaining)
  const step1 = allocateStandardDamage(squad, 2, 1);
  assert.equal(step1.modelsDestroyed, 0);
  assert.equal(step1.damageWasted, 0);
  assert.equal(step1.updatedModels[0].currentWounds, 1);
  assert.equal(step1.updatedModels[1].currentWounds, 3);

  // 2. Mandatory Allocation: Next Damage 3 attack MUST hit Model 0 (already damaged)
  const step2 = allocateStandardDamage(step1.updatedModels, 3, 1);
  assert.equal(step2.modelsDestroyed, 1); // Model 0 destroyed
  assert.equal(step2.damageWasted, 2); // 3 damage into 1 wound = 2 wasted (NO SPILLOVER)
  assert.equal(step2.updatedModels[0].currentWounds, 0);
  assert.equal(step2.updatedModels[1].currentWounds, 3); // Model 1 untouched!

  // 3. Heavy Damage 5 attack into 3-Wound Model 1 -> Destroys Model 1, 2 damage wasted
  const step3 = allocateStandardDamage(step2.updatedModels, 5, 1);
  assert.equal(step3.modelsDestroyed, 1);
  assert.equal(step3.damageWasted, 2);
  assert.equal(step3.updatedModels[1].currentWounds, 0);
  assert.equal(step3.updatedModels[2].currentWounds, 3); // Model 2 untouched!
});

test("Mortal Wounds allocation: correctly spills over across multiple models", () => {
  // 3 Eightbound (3 Wounds per model)
  const squad: ModelWoundState[] = [
    { modelIndex: 0, currentWounds: 3, maxWounds: 3 },
    { modelIndex: 1, currentWounds: 3, maxWounds: 3 },
    { modelIndex: 2, currentWounds: 3, maxWounds: 3 },
  ];

  // 7 Mortal Wounds:
  // Model 0 takes 3 MW -> destroyed
  // Model 1 takes 3 MW -> destroyed
  // Model 2 takes 1 MW -> 2 wounds remaining
  const res = allocateMortalWounds(squad, 7);
  assert.equal(res.modelsDestroyed, 2);
  assert.equal(res.updatedModels[0].currentWounds, 0);
  assert.equal(res.updatedModels[1].currentWounds, 0);
  assert.equal(res.updatedModels[2].currentWounds, 2);
});

test("initializeUnitModels auto-populates model arrays from unit roles and points", () => {
  const custodesUnit: GameSimulationUnit = {
    unitId: "test-custodes-guard",
    position: { x: 0, y: 0 },
    baseRadiusInches: 0.8,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 225,
    woundsPerModel: 3,
    initialModelCount: 5,
  };

  const models = initializeUnitModels(custodesUnit);
  assert.equal(models.length, 5);
  assert.equal(models[0].currentWounds, 3);
  assert.equal(models[0].maxWounds, 3);
});
