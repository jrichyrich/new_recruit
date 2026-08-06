import {
  runMonteCarloWinProbabilitySimulation,
  type GameSimulationUnit,
} from "./local/tessera/game-loop-simulator";

const custodesUnits: GameSimulationUnit[] = [
  {
    unitId: "player-blade-champion",
    position: { x: 15, y: 6 },
    baseRadiusInches: 0.8,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Character",
    isWarlord: true,
    points: 110,
  },
  {
    unitId: "player-allarus-custodians",
    position: { x: 15, y: 15 },
    baseRadiusInches: 0.8,
    movementInches: 5,
    deepStrikeEligible: true,
    role: "Infantry",
    points: 330,
  },
  {
    unitId: "player-sagittarum-custodians",
    position: { x: 10, y: 10 },
    baseRadiusInches: 0.8,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 225,
  },
  {
    unitId: "player-prosecutors",
    position: { x: 5, y: 6 },
    baseRadiusInches: 0.5,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 45,
  },
  {
    unitId: "player-witchseekers",
    position: { x: 15, y: 22 },
    baseRadiusInches: 0.5,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 50,
    hasTorrentWeapons: true,
  },
];

const worldEatersUnits: GameSimulationUnit[] = [
  {
    unitId: "opponent-lord-on-juggernaut",
    position: { x: 15, y: 38 },
    baseRadiusInches: 0.8,
    movementInches: 10,
    deepStrikeEligible: false,
    role: "Character",
    isWarlord: true,
    points: 100,
  },
  {
    unitId: "opponent-khorne-lord-of-skulls",
    position: { x: 20, y: 35 },
    baseRadiusInches: 2.0,
    movementInches: 8,
    deepStrikeEligible: false,
    role: "Vehicle",
    points: 450,
  },
  {
    unitId: "opponent-eightbound",
    position: { x: 10, y: 30 },
    baseRadiusInches: 0.8,
    movementInches: 9,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 145,
  },
  {
    unitId: "opponent-berzerkers",
    position: { x: 15, y: 24 },
    baseRadiusInches: 0.5,
    movementInches: 6,
    deepStrikeEligible: false,
    role: "Infantry",
    points: 180,
  },
];

const result = runMonteCarloWinProbabilitySimulation(custodesUnits, worldEatersUnits, 1000);
console.log(JSON.stringify(result, null, 2));
