import {
  runMonteCarloWinProbabilitySimulation,
  type GameSimulationUnit,
} from "./local/tessera/game-loop-simulator";

console.log("=========================================================================");
console.log(" COACHED LOCAL ENGINE STRESS-TEST: CUSTODES VS WORLD EATERS (9 ARCHETYPES) ");
console.log("=========================================================================\n");

const coachedCustodes1000: GameSimulationUnit[] = [
  {
    unitId: "player-blade-champion",
    position: { x: 15, y: 22 }, // On obj-center
    baseRadiusInches: 0.8,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Character",
    isWarlord: true,
    points: 110,
    woundsPerModel: 6,
    initialModelCount: 1,
    ocPerModel: 2,
  },
  {
    unitId: "player-allarus-deep-strike",
    position: { x: 15, y: 38 }, // Turn 2 Deep Strike directly onto opponent home objective
    baseRadiusInches: 0.8,
    movementInches: 5,
    deepStrikeEligible: true,
    role: "Infantry",
    points: 330,
    woundsPerModel: 6,
    initialModelCount: 6,
    ocPerModel: 2,
  },
  {
    unitId: "player-custodian-guard",
    position: { x: 6, y: 22 }, // Holding obj-left (5 Guard x OC 3 = 15 OC)
    baseRadiusInches: 0.8,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 225,
    woundsPerModel: 3,
    initialModelCount: 5,
    ocPerModel: 3,
  },
  {
    unitId: "player-prosecutors-home",
    position: { x: 15, y: 6 }, // Holding obj-player-home
    baseRadiusInches: 0.5,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 45,
    woundsPerModel: 1,
    initialModelCount: 4,
    ocPerModel: 1,
  },
  {
    unitId: "player-witchseekers-screen",
    position: { x: 15, y: 14 }, // Scout 6" screen blocking World Eaters charges
    baseRadiusInches: 0.5,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 65,
    hasTorrentWeapons: true,
    woundsPerModel: 1,
    initialModelCount: 5,
    ocPerModel: 1,
  },
  {
    unitId: "player-vertus-praetors",
    position: { x: 24, y: 22 }, // Holding obj-right
    baseRadiusInches: 1.5,
    movementInches: 12,
    deepStrikeEligible: false,
    role: "Vehicle",
    points: 225,
    woundsPerModel: 4,
    initialModelCount: 3,
    ocPerModel: 2,
  },
];

const archetypes: { id: string; name: string; units: GameSimulationUnit[] }[] = [
  {
    id: "balanced-control:mixed",
    name: "Balanced Control (Combined Arms)",
    units: [
      { unitId: "opponent-lord-on-juggernaut", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 10, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 100, woundsPerModel: 7, initialModelCount: 1, ocPerModel: 2 },
      { unitId: "opponent-berzerkers-1", position: { x: 15, y: 24 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 180, woundsPerModel: 2, initialModelCount: 10, ocPerModel: 2 },
      { unitId: "opponent-rhino", position: { x: 15, y: 30 }, baseRadiusInches: 1.5, movementInches: 12, deepStrikeEligible: false, role: "Vehicle", points: 75, woundsPerModel: 10, initialModelCount: 1, ocPerModel: 2 },
    ],
  },
  {
    id: "balanced-control:mass",
    name: "Balanced Control (Jakhals Horde)",
    units: [
      { unitId: "opponent-master-of-executions", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 6, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 80, woundsPerModel: 4, initialModelCount: 1, ocPerModel: 1 },
      { unitId: "opponent-jakhals-horde-1", position: { x: 10, y: 25 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 70, woundsPerModel: 1, initialModelCount: 10, ocPerModel: 1 },
      { unitId: "opponent-jakhals-horde-2", position: { x: 20, y: 25 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 70, woundsPerModel: 1, initialModelCount: 10, ocPerModel: 1 },
      { unitId: "opponent-berzerkers-2", position: { x: 15, y: 28 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 180, woundsPerModel: 2, initialModelCount: 10, ocPerModel: 2 },
    ],
  },
  {
    id: "balanced-control:elite-heavy",
    name: "Balanced Control (Eightbound Heavy)",
    units: [
      { unitId: "opponent-lord-on-juggernaut", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 10, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 100, woundsPerModel: 7, initialModelCount: 1, ocPerModel: 2 },
      { unitId: "opponent-eightbound-1", position: { x: 10, y: 30 }, baseRadiusInches: 0.8, movementInches: 9, deepStrikeEligible: false, role: "Infantry", points: 145, woundsPerModel: 3, initialModelCount: 3, ocPerModel: 2 },
      { unitId: "opponent-exalted-eightbound", position: { x: 20, y: 30 }, baseRadiusInches: 0.8, movementInches: 9, deepStrikeEligible: false, role: "Infantry", points: 160, woundsPerModel: 3, initialModelCount: 3, ocPerModel: 2 },
    ],
  },
  {
    id: "ranged-pressure:mixed",
    name: "Ranged Pressure (Helbrute & Defiler)",
    units: [
      { unitId: "opponent-master-of-executions", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 6, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 80, woundsPerModel: 4, initialModelCount: 1, ocPerModel: 1 },
      { unitId: "opponent-helbrute", position: { x: 10, y: 35 }, baseRadiusInches: 1.5, movementInches: 6, deepStrikeEligible: false, role: "Vehicle", points: 140, woundsPerModel: 8, initialModelCount: 1, ocPerModel: 3 },
      { unitId: "opponent-defiler", position: { x: 20, y: 35 }, baseRadiusInches: 2.0, movementInches: 8, deepStrikeEligible: false, role: "Vehicle", points: 190, woundsPerModel: 14, initialModelCount: 1, ocPerModel: 5 },
    ],
  },
  {
    id: "ranged-pressure:mass",
    name: "Ranged Pressure (Mass Support Platforms)",
    units: [
      { unitId: "opponent-master-of-executions", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 6, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 80, woundsPerModel: 4, initialModelCount: 1, ocPerModel: 1 },
      { unitId: "opponent-helbrute-1", position: { x: 10, y: 35 }, baseRadiusInches: 1.5, movementInches: 6, deepStrikeEligible: false, role: "Vehicle", points: 140, woundsPerModel: 8, initialModelCount: 1, ocPerModel: 3 },
      { unitId: "opponent-helbrute-2", position: { x: 20, y: 35 }, baseRadiusInches: 1.5, movementInches: 6, deepStrikeEligible: false, role: "Vehicle", points: 140, woundsPerModel: 8, initialModelCount: 1, ocPerModel: 3 },
    ],
  },
  {
    id: "ranged-pressure:elite-heavy",
    name: "Ranged Pressure (Lord of Skulls)",
    units: [
      { unitId: "opponent-lord-on-juggernaut", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 10, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 100, woundsPerModel: 7, initialModelCount: 1, ocPerModel: 2 },
      { unitId: "opponent-khorne-lord-of-skulls", position: { x: 20, y: 35 }, baseRadiusInches: 2.0, movementInches: 8, deepStrikeEligible: false, role: "Vehicle", points: 450, woundsPerModel: 18, initialModelCount: 1, ocPerModel: 5 },
    ],
  },
  {
    id: "assault-pressure:mixed",
    name: "Assault Pressure (Winged Daemon Prince)",
    units: [
      { unitId: "opponent-daemon-prince-wings", position: { x: 15, y: 32 }, baseRadiusInches: 1.5, movementInches: 12, deepStrikeEligible: true, role: "Monster", isWarlord: true, points: 195, woundsPerModel: 10, initialModelCount: 1, ocPerModel: 3 },
      { unitId: "opponent-eightbound", position: { x: 10, y: 30 }, baseRadiusInches: 0.8, movementInches: 9, deepStrikeEligible: false, role: "Infantry", points: 145, woundsPerModel: 3, initialModelCount: 3, ocPerModel: 2 },
    ],
  },
  {
    id: "assault-pressure:mass",
    name: "Assault Pressure (Mass Eightbound & Berzerkers)",
    units: [
      { unitId: "opponent-lord-on-juggernaut", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 10, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 100, woundsPerModel: 7, initialModelCount: 1, ocPerModel: 2 },
      { unitId: "opponent-eightbound-1", position: { x: 10, y: 30 }, baseRadiusInches: 0.8, movementInches: 9, deepStrikeEligible: false, role: "Infantry", points: 145, woundsPerModel: 3, initialModelCount: 3, ocPerModel: 2 },
      { unitId: "opponent-berzerkers-1", position: { x: 15, y: 24 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 180, woundsPerModel: 2, initialModelCount: 10, ocPerModel: 2 },
    ],
  },
  {
    id: "assault-pressure:elite-heavy",
    name: "Assault Pressure (Lord of Skulls & Daemon Prince)",
    units: [
      { unitId: "opponent-daemon-prince", position: { x: 10, y: 32 }, baseRadiusInches: 1.5, movementInches: 10, deepStrikeEligible: false, role: "Monster", isWarlord: true, points: 180, woundsPerModel: 10, initialModelCount: 1, ocPerModel: 3 },
      { unitId: "opponent-khorne-lord-of-skulls", position: { x: 20, y: 35 }, baseRadiusInches: 2.0, movementInches: 8, deepStrikeEligible: false, role: "Vehicle", points: 450, woundsPerModel: 18, initialModelCount: 1, ocPerModel: 5 },
    ],
  },
];

console.log("Archetype ID | Posture & Composition | Custodes Win % | Custodes Mean VP | WE Mean VP");
console.log("---------------------------------------------------------------------------------------");

let totalWinRate = 0;
let totalCustodesVp = 0;
let totalWeVp = 0;

for (const arch of archetypes) {
  const sim = runMonteCarloWinProbabilitySimulation(coachedCustodes1000, arch.units, 500);
  console.log(
    `${arch.id.padEnd(23)} | ${arch.name.padEnd(36)} | ${sim.playerWinRatePercent.toFixed(1).padStart(5)}% | ${sim.playerMeanVp.toFixed(1).padStart(12)} | ${sim.opponentMeanVp.toFixed(1).padStart(10)}`
  );
  totalWinRate += sim.playerWinRatePercent;
  totalCustodesVp += sim.playerMeanVp;
  totalWeVp += sim.opponentMeanVp;
}

const avgWinRate = (totalWinRate / archetypes.length).toFixed(1);
const avgCustodesVp = (totalCustodesVp / archetypes.length).toFixed(1);
const avgWeVp = (totalWeVp / archetypes.length).toFixed(1);

console.log("---------------------------------------------------------------------------------------");
console.log(`OVERALL AGGREGATE SUMMARY: Win Rate = ${avgWinRate}%, Mean Custodes VP = ${avgCustodesVp}, Mean WE VP = ${avgWeVp}`);
console.log("=========================================================================\n");
