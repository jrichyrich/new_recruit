import {
  runMonteCarloWinProbabilitySimulation,
  type GameSimulationUnit,
} from "./local/tessera/game-loop-simulator";

console.log("=========================================================================");
console.log(" FULL LOCAL ENGINE STRESS-TEST: CUSTODES VS WORLD EATERS (9 ARCHETYPES)  ");
console.log("=========================================================================\n");

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
    unitId: "prosecutors",
    position: { x: 5, y: 6 },
    baseRadiusInches: 0.5,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 45,
    woundsPerModel: 1,
    initialModelCount: 4,
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

const archetypes: { id: string; name: string; units: GameSimulationUnit[] }[] = [
  {
    id: "balanced-control:mixed",
    name: "Balanced Control (Combined Arms)",
    units: [
      { unitId: "lord-on-juggernaut", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 10, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 100, woundsPerModel: 7, initialModelCount: 1 },
      { unitId: "berzerkers-1", position: { x: 15, y: 24 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 180, woundsPerModel: 2, initialModelCount: 10 },
      { unitId: "rhino", position: { x: 15, y: 30 }, baseRadiusInches: 1.5, movementInches: 12, deepStrikeEligible: false, role: "Vehicle", points: 75, woundsPerModel: 10, initialModelCount: 1 },
    ],
  },
  {
    id: "balanced-control:mass",
    name: "Balanced Control (Jakhals Horde)",
    units: [
      { unitId: "master-of-executions", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 6, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 80, woundsPerModel: 4, initialModelCount: 1 },
      { unitId: "jakhals-horde-1", position: { x: 10, y: 25 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 70, woundsPerModel: 1, initialModelCount: 10 },
      { unitId: "jakhals-horde-2", position: { x: 20, y: 25 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 70, woundsPerModel: 1, initialModelCount: 10 },
      { unitId: "berzerkers-2", position: { x: 15, y: 28 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 180, woundsPerModel: 2, initialModelCount: 10 },
    ],
  },
  {
    id: "balanced-control:elite-heavy",
    name: "Balanced Control (Eightbound Heavy)",
    units: [
      { unitId: "lord-on-juggernaut", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 10, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 100, woundsPerModel: 7, initialModelCount: 1 },
      { unitId: "eightbound-1", position: { x: 10, y: 30 }, baseRadiusInches: 0.8, movementInches: 9, deepStrikeEligible: false, role: "Infantry", points: 145, woundsPerModel: 3, initialModelCount: 3 },
      { unitId: "exalted-eightbound", position: { x: 20, y: 30 }, baseRadiusInches: 0.8, movementInches: 9, deepStrikeEligible: false, role: "Infantry", points: 160, woundsPerModel: 3, initialModelCount: 3 },
    ],
  },
  {
    id: "ranged-pressure:mixed",
    name: "Ranged Pressure (Helbrute & Defiler)",
    units: [
      { unitId: "master-of-executions", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 6, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 80, woundsPerModel: 4, initialModelCount: 1 },
      { unitId: "helbrute", position: { x: 10, y: 35 }, baseRadiusInches: 1.5, movementInches: 6, deepStrikeEligible: false, role: "Vehicle", points: 140, woundsPerModel: 8, initialModelCount: 1 },
      { unitId: "defiler", position: { x: 20, y: 35 }, baseRadiusInches: 2.0, movementInches: 8, deepStrikeEligible: false, role: "Vehicle", points: 190, woundsPerModel: 14, initialModelCount: 1 },
    ],
  },
  {
    id: "ranged-pressure:mass",
    name: "Ranged Pressure (Mass Support Platforms)",
    units: [
      { unitId: "master-of-executions", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 6, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 80, woundsPerModel: 4, initialModelCount: 1 },
      { unitId: "helbrute-1", position: { x: 10, y: 35 }, baseRadiusInches: 1.5, movementInches: 6, deepStrikeEligible: false, role: "Vehicle", points: 140, woundsPerModel: 8, initialModelCount: 1 },
      { unitId: "helbrute-2", position: { x: 20, y: 35 }, baseRadiusInches: 1.5, movementInches: 6, deepStrikeEligible: false, role: "Vehicle", points: 140, woundsPerModel: 8, initialModelCount: 1 },
    ],
  },
  {
    id: "ranged-pressure:elite-heavy",
    name: "Ranged Pressure (Lord of Skulls)",
    units: [
      { unitId: "lord-on-juggernaut", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 10, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 100, woundsPerModel: 7, initialModelCount: 1 },
      { unitId: "khorne-lord-of-skulls", position: { x: 20, y: 35 }, baseRadiusInches: 2.0, movementInches: 8, deepStrikeEligible: false, role: "Vehicle", points: 450, woundsPerModel: 18, initialModelCount: 1 },
    ],
  },
  {
    id: "assault-pressure:mixed",
    name: "Assault Pressure (Winged Daemon Prince)",
    units: [
      { unitId: "daemon-prince-wings", position: { x: 15, y: 32 }, baseRadiusInches: 1.5, movementInches: 12, deepStrikeEligible: true, role: "Monster", isWarlord: true, points: 195, woundsPerModel: 10, initialModelCount: 1 },
      { unitId: "eightbound", position: { x: 10, y: 30 }, baseRadiusInches: 0.8, movementInches: 9, deepStrikeEligible: false, role: "Infantry", points: 145, woundsPerModel: 3, initialModelCount: 3 },
    ],
  },
  {
    id: "assault-pressure:mass",
    name: "Assault Pressure (Mass Eightbound & Berzerkers)",
    units: [
      { unitId: "lord-on-juggernaut", position: { x: 15, y: 38 }, baseRadiusInches: 0.8, movementInches: 10, deepStrikeEligible: false, role: "Character", isWarlord: true, points: 100, woundsPerModel: 7, initialModelCount: 1 },
      { unitId: "eightbound-1", position: { x: 10, y: 30 }, baseRadiusInches: 0.8, movementInches: 9, deepStrikeEligible: false, role: "Infantry", points: 145, woundsPerModel: 3, initialModelCount: 3 },
      { unitId: "berzerkers-1", position: { x: 15, y: 24 }, baseRadiusInches: 0.5, movementInches: 6, deepStrikeEligible: false, role: "Infantry", points: 180, woundsPerModel: 2, initialModelCount: 10 },
    ],
  },
  {
    id: "assault-pressure:elite-heavy",
    name: "Assault Pressure (Lord of Skulls & Daemon Prince)",
    units: [
      { unitId: "daemon-prince", position: { x: 10, y: 32 }, baseRadiusInches: 1.5, movementInches: 10, deepStrikeEligible: false, role: "Monster", isWarlord: true, points: 180, woundsPerModel: 10, initialModelCount: 1 },
      { unitId: "khorne-lord-of-skulls", position: { x: 20, y: 35 }, baseRadiusInches: 2.0, movementInches: 8, deepStrikeEligible: false, role: "Vehicle", points: 450, woundsPerModel: 18, initialModelCount: 1 },
    ],
  },
];

console.log("Archetype ID | Posture & Composition | Custodes Win % | Custodes Mean VP | WE Mean VP");
console.log("---------------------------------------------------------------------------------------");

let totalWinRate = 0;
let totalCustodesVp = 0;
let totalWeVp = 0;

for (const arch of archetypes) {
  const sim = runMonteCarloWinProbabilitySimulation(custodes1000, arch.units, 500);
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
