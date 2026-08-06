import {
  advanceCommandPhaseCp,
  createInitialCpState,
  evaluateStratagemTrigger,
  type PlayerCpState,
} from "./stratagem-engine";
import {
  calculateDistance2D,
  evaluateObjectiveControl,
  type ObjectiveMarker,
  type UnitSpatialState,
} from "./spatial-geometry-engine";

export interface ModelWoundState {
  modelIndex: number;
  currentWounds: number;
  maxWounds: number;
}

export interface GameSimulationUnit extends UnitSpatialState {
  role: "Character" | "Infantry" | "Vehicle" | "Monster";
  isWarlord?: boolean;
  points: number;
  hasTorrentWeapons?: boolean;
  woundsPerModel?: number;
  initialModelCount?: number;
  models?: ModelWoundState[];
}

export interface GameSimulationResult {
  iterations: number;
  playerWins: number;
  opponentWins: number;
  draws: number;
  playerWinRatePercent: number;
  playerMeanVp: number;
  opponentMeanVp: number;
}

export const DEFAULT_INCURSION_OBJECTIVES: ObjectiveMarker[] = [
  { id: "obj-center", position: { x: 15, y: 22 }, controlRadiusInches: 3.0 },
  { id: "obj-player-home", position: { x: 15, y: 6 }, controlRadiusInches: 3.0 },
  { id: "obj-opponent-home", position: { x: 15, y: 38 }, controlRadiusInches: 3.0 },
  { id: "obj-left", position: { x: 6, y: 22 }, controlRadiusInches: 3.0 },
  { id: "obj-right", position: { x: 24, y: 22 }, controlRadiusInches: 3.0 },
];

export function initializeUnitModels(unit: GameSimulationUnit): ModelWoundState[] {
  if (unit.models && unit.models.length > 0) {
    return unit.models.map((m) => ({ ...m }));
  }
  const wounds = unit.woundsPerModel ?? (unit.role === "Character" ? 5 : unit.role === "Vehicle" ? 10 : 3);
  const count = unit.initialModelCount ?? 3;
  const models: ModelWoundState[] = [];
  for (let i = 0; i < count; i++) {
    models.push({
      modelIndex: i,
      currentWounds: wounds,
      maxWounds: wounds,
    });
  }
  return models;
}

export function allocateStandardDamage(
  models: ModelWoundState[],
  damagePerAttack: number,
  unsavedWoundsCount: number
): { updatedModels: ModelWoundState[]; modelsDestroyed: number; damageWasted: number } {
  const updated = models.map((m) => ({ ...m }));
  let destroyed = 0;
  let wasted = 0;

  for (let attack = 0; attack < unsavedWoundsCount; attack++) {
    let target = updated.find((m) => m.currentWounds > 0 && m.currentWounds < m.maxWounds);
    if (!target) {
      target = updated.find((m) => m.currentWounds > 0);
    }
    if (!target) break; // All models destroyed

    if (damagePerAttack >= target.currentWounds) {
      wasted += damagePerAttack - target.currentWounds;
      target.currentWounds = 0;
      destroyed++;
    } else {
      target.currentWounds -= damagePerAttack;
    }
  }

  return {
    updatedModels: updated,
    modelsDestroyed: destroyed,
    damageWasted: wasted,
  };
}

export function allocateMortalWounds(
  models: ModelWoundState[],
  mortalWoundPool: number
): { updatedModels: ModelWoundState[]; modelsDestroyed: number } {
  const updated = models.map((m) => ({ ...m }));
  let destroyed = 0;
  let remainingMw = mortalWoundPool;

  while (remainingMw > 0) {
    let target = updated.find((m) => m.currentWounds > 0 && m.currentWounds < m.maxWounds);
    if (!target) {
      target = updated.find((m) => m.currentWounds > 0);
    }
    if (!target) break; // All models destroyed

    target.currentWounds--;
    remainingMw--;

    if (target.currentWounds === 0) {
      destroyed++;
    }
  }

  return {
    updatedModels: updated,
    modelsDestroyed: destroyed,
  };
}

export function runSingleGameSimulation(
  playerUnits: GameSimulationUnit[],
  opponentUnits: GameSimulationUnit[],
  objectives = DEFAULT_INCURSION_OBJECTIVES,
  maxRounds = 5
): { playerVp: number; opponentVp: number } {
  let playerCp = createInitialCpState("player-army", 1);
  let opponentCp = createInitialCpState("opponent-army", 1);

  let playerVp = 0;
  let opponentVp = 0;

  // Initialize model-level wound pools
  const playerState = playerUnits.map((u) => ({
    unit: u,
    models: initializeUnitModels(u),
  }));

  const opponentState = opponentUnits.map((u) => ({
    unit: u,
    models: initializeUnitModels(u),
  }));

  for (let round = 1; round <= maxRounds; round++) {
    // 1. Command Phase (+1 CP)
    playerCp = advanceCommandPhaseCp(playerCp);
    opponentCp = advanceCommandPhaseCp(opponentCp);

    // 2. Simulated Combat & Shooting Phase
    const activePlayer = playerState.filter((s) => s.models.some((m) => m.currentWounds > 0));
    const activeOpponent = opponentState.filter((s) => s.models.some((m) => m.currentWounds > 0));

    // Overwatch Trigger evaluation
    if (activePlayer.some((s) => s.unit.hasTorrentWeapons)) {
      const ow = evaluateStratagemTrigger(playerCp, "fire-overwatch", {
        hasTorrentWeapons: true,
      });
      if (ow.triggered && activeOpponent.length > 0) {
        playerCp = ow.newState;
        const target = activeOpponent[0];
        const alloc = allocateStandardDamage(target.models, 1, 3);
        target.models = alloc.updatedModels;
      }
    }

    // Player Shooting & Melee Attacks
    for (const pUnit of activePlayer) {
      const survivingModels = pUnit.models.filter((m) => m.currentWounds > 0).length;
      if (survivingModels === 0) continue;

      const closestOpponent = activeOpponent.find((o) => o.models.some((m) => m.currentWounds > 0));
      if (!closestOpponent) break;

      const dist = calculateDistance2D(pUnit.unit.position, closestOpponent.unit.position);
      if (dist <= 24.0) {
        const damagePerAttack = pUnit.unit.role === "Character" || pUnit.unit.points >= 300 ? 3 : 2;
        const unsavedWounds = Math.min(10, survivingModels * 3);
        const alloc = allocateStandardDamage(closestOpponent.models, damagePerAttack, unsavedWounds);
        closestOpponent.models = alloc.updatedModels;
      }
    }

    // Opponent Counter-Attacks
    const survivingOpponents = opponentState.filter((s) => s.models.some((m) => m.currentWounds > 0));
    for (const oUnit of survivingOpponents) {
      const survivingModels = oUnit.models.filter((m) => m.currentWounds > 0).length;
      if (survivingModels === 0) continue;

      const closestPlayer = activePlayer.find((p) => p.models.some((m) => m.currentWounds > 0));
      if (!closestPlayer) break;

      const dist = calculateDistance2D(oUnit.unit.position, closestPlayer.unit.position);
      if (dist <= 18.0) {
        const damagePerAttack = oUnit.unit.role === "Vehicle" || oUnit.unit.role === "Monster" ? 3 : 2;
        const unsavedWounds = Math.min(4, survivingModels);

        const aoc = evaluateStratagemTrigger(playerCp, "armor-of-contempt", {
          incomingAp: 3,
          isHighValueTarget: closestPlayer.unit.role === "Character" || closestPlayer.unit.role === "Infantry",
        });

        const effectiveDamage = aoc.triggered ? Math.max(1, damagePerAttack - 1) : damagePerAttack;
        if (aoc.triggered) {
          playerCp = aoc.newState;
        }

        const alloc = allocateStandardDamage(closestPlayer.models, effectiveDamage, unsavedWounds);
        closestPlayer.models = alloc.updatedModels;
      }
    }

    // 3. Primary Objective Scoring (Evaluated AFTER Combat Resolution with OC Metrics)
    if (round >= 2) {
      let playerControlledObjs = 0;
      let opponentControlledObjs = 0;

      const activePlayerSpatial: UnitSpatialState[] = playerState
        .filter((s) => s.models.some((m) => m.currentWounds > 0))
        .map((s) => ({
          ...s.unit,
          survivingModelCount: s.models.filter((m) => m.currentWounds > 0).length,
          ocPerModel: s.unit.ocPerModel ?? (s.unit.unitId.includes("guard") ? 3 : 2),
        }));

      const activeOpponentSpatial: UnitSpatialState[] = opponentState
        .filter((s) => s.models.some((m) => m.currentWounds > 0))
        .map((s) => ({
          ...s.unit,
          survivingModelCount: s.models.filter((m) => m.currentWounds > 0).length,
          ocPerModel: s.unit.ocPerModel ?? 2,
        }));

      const allSpatialUnits: UnitSpatialState[] = [
        ...activePlayerSpatial,
        ...activeOpponentSpatial,
      ];

      for (const obj of objectives) {
        const control = evaluateObjectiveControl(allSpatialUnits, obj);
        if (control.controlledBy === "player") {
          playerControlledObjs++;
        } else if (control.controlledBy === "opponent") {
          opponentControlledObjs++;
        }
      }

      if (playerControlledObjs >= 1) playerVp += 5;
      if (playerControlledObjs >= 2) playerVp += 5;
      if (playerControlledObjs > opponentControlledObjs) playerVp += 5;

      if (opponentControlledObjs >= 1) opponentVp += 5;
      if (opponentControlledObjs >= 2) opponentVp += 5;
      if (opponentControlledObjs > playerControlledObjs) opponentVp += 5;
    }

    // 4. Secondary Objectives Scoring (Assassination / Bring It Down)
    const killedWarlord = opponentState.some(
      (s) => s.unit.isWarlord && s.models.every((m) => m.currentWounds === 0)
    );
    if (killedWarlord && round === maxRounds) {
      playerVp += 5;
    }
  }

  return {
    playerVp: Math.min(100, playerVp),
    opponentVp: Math.min(100, opponentVp),
  };
}

export function runMonteCarloWinProbabilitySimulation(
  playerUnits: GameSimulationUnit[],
  opponentUnits: GameSimulationUnit[],
  iterations = 500
): GameSimulationResult {
  let playerWins = 0;
  let opponentWins = 0;
  let draws = 0;

  let totalPlayerVp = 0;
  let totalOpponentVp = 0;

  for (let i = 0; i < iterations; i++) {
    const res = runSingleGameSimulation(playerUnits, opponentUnits);
    totalPlayerVp += res.playerVp;
    totalOpponentVp += res.opponentVp;

    if (res.playerVp > res.opponentVp) {
      playerWins++;
    } else if (res.opponentVp > res.playerVp) {
      opponentWins++;
    } else {
      draws++;
    }
  }

  return {
    iterations,
    playerWins,
    opponentWins,
    draws,
    playerWinRatePercent: Math.round((playerWins / iterations) * 1000) / 10,
    playerMeanVp: Math.round((totalPlayerVp / iterations) * 10) / 10,
    opponentMeanVp: Math.round((totalOpponentVp / iterations) * 10) / 10,
  };
}
