import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runMonteCarloWinProbabilitySimulation,
  runSingleGameSimulation,
  type GameSimulationUnit,
} from "../local/tessera/game-loop-simulator";

test("Game Loop Simulator runs 5-turn VP scoring and Monte Carlo win probability estimations", () => {
  const playerUnits: GameSimulationUnit[] = [
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
      unitId: "player-witchseekers",
      position: { x: 15, y: 22 }, // On center objective
      baseRadiusInches: 0.5,
      movementInches: 6,
      deepStrikeEligible: false,
      role: "Infantry",
      points: 50,
      hasTorrentWeapons: true,
    },
  ];

  const opponentUnits: GameSimulationUnit[] = [
    {
      unitId: "opponent-farseer",
      position: { x: 15, y: 38 }, // On opponent home objective
      baseRadiusInches: 0.5,
      movementInches: 7,
      deepStrikeEligible: false,
      role: "Character",
      isWarlord: true,
      points: 80,
    },
  ];

  // Test single 5-turn game simulation
  const singleResult = runSingleGameSimulation(playerUnits, opponentUnits);
  assert.ok(singleResult.playerVp >= 0 && singleResult.playerVp <= 100);
  assert.ok(singleResult.opponentVp >= 0 && singleResult.opponentVp <= 100);

  // Test Monte Carlo 500-iteration win probability simulation
  const monteCarlo = runMonteCarloWinProbabilitySimulation(playerUnits, opponentUnits, 100);
  assert.equal(monteCarlo.iterations, 100);
  assert.ok(monteCarlo.playerWinRatePercent >= 0 && monteCarlo.playerWinRatePercent <= 100);
  assert.ok(monteCarlo.playerMeanVp > 0);
});
