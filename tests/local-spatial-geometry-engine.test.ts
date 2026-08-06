import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calculateChargeProbability,
  calculateDistance2D,
  evaluateObjectiveControl,
  isValidDeepStrikePosition,
  type ObjectiveMarker,
  type UnitSpatialState,
} from "../local/tessera/spatial-geometry-engine";

test("Spatial Geometry Engine calculates distance, charge probabilities, and 9in deep strike exclusion", () => {
  const p1 = { x: 10, y: 10 };
  const p2 = { x: 10, y: 18 };

  const dist = calculateDistance2D(p1, p2);
  assert.equal(dist, 8.0);

  // 8" total distance requires a 7" roll to reach 1" engagement range
  const charge = calculateChargeProbability(p1, p2, 5);
  assert.equal(charge.distanceInches, 8.0);
  assert.equal(charge.requiredRoll, 7);
  assert.equal(charge.successProbability, 0.583); // 58.3% chance

  // Deep strike exclusion check (9in min distance)
  const enemyUnit: UnitSpatialState = {
    unitId: "opponent-fire-prism",
    position: { x: 20, y: 20 },
    baseRadiusInches: 1.5,
    movementInches: 10,
    deepStrikeEligible: false,
  };

  // Position at (20, 25) is 5" away -> Invalid for deep strike (< 9")
  assert.equal(isValidDeepStrikePosition({ x: 20, y: 25 }, [enemyUnit], 9.0), false);

  // Position at (20, 30) is 10" away -> Valid for deep strike (>= 9")
  assert.equal(isValidDeepStrikePosition({ x: 20, y: 30 }, [enemyUnit], 9.0), true);

  // Objective control check (contested when both units are on objective)
  const obj: ObjectiveMarker = {
    id: "obj-center",
    position: { x: 20, y: 20 },
    controlRadiusInches: 3.0,
  };

  const playerUnit: UnitSpatialState = {
    unitId: "player-allarus-1",
    position: { x: 21, y: 20 },
    baseRadiusInches: 0.8,
    movementInches: 5,
    deepStrikeEligible: true,
  };

  const enemyOnObjective: UnitSpatialState = {
    ...enemyUnit,
    position: { x: 20, y: 21 },
  };

  // Contested objective (1 player unit vs 1 enemy unit)
  const contested = evaluateObjectiveControl([playerUnit, enemyOnObjective], obj);
  assert.equal(contested.controlledBy, null);

  // Player controls objective when enemy is outside objective range
  const enemyOutsideObjective: UnitSpatialState = {
    ...enemyUnit,
    position: { x: 20, y: 35 },
  };

  const playerControlled = evaluateObjectiveControl([playerUnit, enemyOutsideObjective], obj);
  assert.equal(playerControlled.controlledBy, "player");
  assert.equal(playerControlled.playerUnitCount, 1);
  assert.equal(playerControlled.enemyUnitCount, 0);
});
