import { z } from "zod";

export const SPATIAL_GEOMETRY_SCHEMA_VERSION = 1 as const;

export interface Point2D {
  x: number;
  y: number;
}

export interface BoardDimensions {
  widthInches: number;
  heightInches: number;
}

export interface ObjectiveMarker {
  id: string;
  position: Point2D;
  controlRadiusInches: number;
}

export interface UnitSpatialState {
  unitId: string;
  position: Point2D;
  baseRadiusInches: number;
  movementInches: number;
  deepStrikeEligible: boolean;
  ocPerModel?: number;
  survivingModelCount?: number;
}

// 2D6 Charge probability lookup table for required roll (2 to 12)
export const TWO_D6_PROBABILITIES: Record<number, number> = {
  2: 36 / 36, // 100%
  3: 35 / 36, // 97.2%
  4: 33 / 36, // 91.7%
  5: 30 / 36, // 83.3%
  6: 26 / 36, // 72.2%
  7: 21 / 36, // 58.3%
  8: 15 / 36, // 41.7%
  9: 10 / 36, // 27.8%
  10: 6 / 36, // 16.7%
  11: 3 / 36, // 8.3%
  12: 1 / 36, // 2.8%
};

export const STANDARD_INCURSION_BOARD: BoardDimensions = {
  widthInches: 30,
  heightInches: 44,
};

export const STANDARD_STRIKE_FORCE_BOARD: BoardDimensions = {
  widthInches: 44,
  heightInches: 60,
};

export function calculateDistance2D(p1: Point2D, p2: Point2D): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function calculateChargeProbability(
  attackerPos: Point2D,
  targetPos: Point2D,
  movementInches = 5
): { distanceInches: number; requiredRoll: number; successProbability: number } {
  const directDistance = calculateDistance2D(attackerPos, targetPos);
  const chargeDistance = Math.max(0, directDistance - 1.0);
  const neededRoll = Math.max(2, Math.ceil(chargeDistance));

  const successProbability = TWO_D6_PROBABILITIES[Math.min(12, Math.max(2, neededRoll))] ?? 0;

  return {
    distanceInches: Math.round(directDistance * 10) / 10,
    requiredRoll: Math.min(12, Math.max(2, neededRoll)),
    successProbability: Math.round(successProbability * 1000) / 1000,
  };
}

export function isValidDeepStrikePosition(
  candidatePos: Point2D,
  enemyUnits: UnitSpatialState[],
  minExclusionInches = 9.0
): boolean {
  for (const enemy of enemyUnits) {
    const dist = calculateDistance2D(candidatePos, enemy.position);
    if (dist < minExclusionInches) {
      return false;
    }
  }
  return true;
}

export function evaluateObjectiveControl(
  units: UnitSpatialState[],
  objective: ObjectiveMarker
): { controlledBy: string | null; playerOcTotal: number; enemyOcTotal: number } {
  let playerOcTotal = 0;
  let enemyOcTotal = 0;

  for (const u of units) {
    const dist = calculateDistance2D(u.position, objective.position);
    if (dist <= objective.controlRadiusInches + u.baseRadiusInches) {
      const oc = (u.ocPerModel ?? 2) * (u.survivingModelCount ?? 1);
      if (u.unitId.startsWith("player")) {
        playerOcTotal += oc;
      } else {
        enemyOcTotal += oc;
      }
    }
  }

  const controlledBy =
    playerOcTotal > enemyOcTotal
      ? "player"
      : enemyOcTotal > playerOcTotal
      ? "opponent"
      : null;

  return { controlledBy, playerOcTotal, enemyOcTotal };
}
