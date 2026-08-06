import {
  allocateMortalWounds,
  allocateStandardDamage,
  initializeUnitModels,
  runMonteCarloWinProbabilitySimulation,
  runSingleGameSimulation,
  type GameSimulationUnit,
  type ModelWoundState,
} from "./local/tessera/game-loop-simulator";

console.log("=========================================================================");
console.log("     ROSTERPILOT LOCAL ENGINE: MODEL-LEVEL WOUND ALLOCATION TEST BOARD   ");
console.log("=========================================================================\n");

// TEST 1: Damage Non-Spillover Demonstration
console.log("--- TEST 1: Standard Attack Damage Non-Spillover ---");
const custodesSquad: ModelWoundState[] = [
  { modelIndex: 0, currentWounds: 3, maxWounds: 3 },
  { modelIndex: 1, currentWounds: 3, maxWounds: 3 },
  { modelIndex: 2, currentWounds: 3, maxWounds: 3 },
];

console.log("Initial Squad (3 Custodian Guard, 3 Wounds each):", custodesSquad.map((m) => `[Model ${m.modelIndex}: ${m.currentWounds}/${m.maxWounds} HP]`).join(" "));

// Attack 1: Damage 5 attack (1 unsaved wound)
const attack1 = allocateStandardDamage(custodesSquad, 5, 1);
console.log("\n[Attack 1]: 1 unsaved hit of Damage 5 -> Target Model 0");
console.log(`Result: Models Destroyed = ${attack1.modelsDestroyed}, Damage Wasted (No Spillover) = ${attack1.damageWasted}`);
console.log("Squad State:", attack1.updatedModels.map((m) => `[Model ${m.modelIndex}: ${m.currentWounds}/${m.maxWounds} HP]`).join(" "));

// Attack 2: Damage 2 attack -> MUST hit damaged Model 0 if surviving, otherwise Model 1
const attack2 = allocateStandardDamage(attack1.updatedModels, 2, 1);
console.log("\n[Attack 2]: 1 unsaved hit of Damage 2 -> Target Model 1");
console.log(`Result: Models Destroyed = ${attack2.modelsDestroyed}, Damage Wasted = ${attack2.damageWasted}`);
console.log("Squad State:", attack2.updatedModels.map((m) => `[Model ${m.modelIndex}: ${m.currentWounds}/${m.maxWounds} HP]`).join(" "));

// TEST 2: Mortal Wounds Spillover Demonstration
console.log("\n--- TEST 2: Mortal Wounds / Devastating Wounds Spillover ---");
const eightboundSquad: ModelWoundState[] = [
  { modelIndex: 0, currentWounds: 3, maxWounds: 3 },
  { modelIndex: 1, currentWounds: 3, maxWounds: 3 },
  { modelIndex: 2, currentWounds: 3, maxWounds: 3 },
];
console.log("Initial Squad (3 Eightbound, 3 Wounds each):", eightboundSquad.map((m) => `[Model ${m.modelIndex}: ${m.currentWounds}/${m.maxWounds} HP]`).join(" "));

const mortalAttacks = allocateMortalWounds(eightboundSquad, 7);
console.log("\n[Mortal Attack]: Pool of 7 Mortal Wounds applied to Eightbound squad");
console.log(`Result: Models Destroyed = ${mortalAttacks.modelsDestroyed}`);
console.log("Squad State:", mortalAttacks.updatedModels.map((m) => `[Model ${m.modelIndex}: ${m.currentWounds}/${m.maxWounds} HP]`).join(" "));

// TEST 3: Full 1,000pt Custodes vs World Eaters Monte Carlo Game
console.log("\n--- TEST 3: 1,000-Iteration Monte Carlo Simulation (Custodes vs World Eaters) ---");

const custodes1000: GameSimulationUnit[] = [
  {
    unitId: "blade-champion",
    position: { x: 15, y: 6 },
    baseRadiusInches: 0.8,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Character",
    isWarlord: true,
    points: 110,
    woundsPerModel: 6,
    initialModelCount: 1,
  },
  {
    unitId: "allarus-custodians",
    position: { x: 15, y: 15 },
    baseRadiusInches: 0.8,
    movementInches: 5,
    deepStrikeEligible: true,
    role: "Infantry",
    points: 330,
    woundsPerModel: 6,
    initialModelCount: 6,
  },
  {
    unitId: "sagittarum-custodians",
    position: { x: 10, y: 10 },
    baseRadiusInches: 0.8,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 225,
    woundsPerModel: 3,
    initialModelCount: 5,
  },
  {
    unitId: "witchseekers",
    position: { x: 15, y: 22 },
    baseRadiusInches: 0.5,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 50,
    hasTorrentWeapons: true,
    woundsPerModel: 1,
    initialModelCount: 4,
  },
];

const worldEaters1000: GameSimulationUnit[] = [
  {
    unitId: "lord-on-juggernaut",
    position: { x: 15, y: 38 },
    baseRadiusInches: 0.8,
    movementInches: 10,
    deepStrikeEligible: false,
    role: "Character",
    isWarlord: true,
    points: 100,
    woundsPerModel: 7,
    initialModelCount: 1,
  },
  {
    unitId: "khorne-lord-of-skulls",
    position: { x: 20, y: 35 },
    baseRadiusInches: 2.0,
    movementInches: 8,
    deepStrikeEligible: false,
    role: "Vehicle",
    points: 450,
    woundsPerModel: 18,
    initialModelCount: 1,
  },
  {
    unitId: "eightbound",
    position: { x: 10, y: 30 },
    baseRadiusInches: 0.8,
    movementInches: 9,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 145,
    woundsPerModel: 3,
    initialModelCount: 3,
  },
  {
    unitId: "berzerkers",
    position: { x: 15, y: 24 },
    baseRadiusInches: 0.5,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 180,
    woundsPerModel: 2,
    initialModelCount: 10,
  },
];

const monteCarlo = runMonteCarloWinProbabilitySimulation(custodes1000, worldEaters1000, 1000);
console.log(`Simulation Iterations  : ${monteCarlo.iterations}`);
console.log(`Custodes Win Rate      : ${monteCarlo.playerWinRatePercent}%`);
console.log(`Custodes Mean Score    : ${monteCarlo.playerMeanVp} VP`);
console.log(`World Eaters Mean Score: ${monteCarlo.opponentMeanVp} VP`);
console.log("=========================================================================\n");
