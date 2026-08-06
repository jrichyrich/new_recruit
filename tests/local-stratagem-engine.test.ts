import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceCommandPhaseCp,
  canSpendCp,
  createInitialCpState,
  evaluateStratagemTrigger,
  spendCp,
} from "../local/tessera/stratagem-engine";

test("Stratagem Engine tracks CP pool and triggers Overwatch / Armor of Contempt", () => {
  let p1Cp = createInitialCpState("adeptus-custodes", 1);
  assert.equal(p1Cp.currentCp, 1);

  // Turn 1 Command Phase (+1 CP)
  p1Cp = advanceCommandPhaseCp(p1Cp);
  assert.equal(p1Cp.currentCp, 2);

  // Evaluate Fire Overwatch with torrent weapons
  const overwatch = evaluateStratagemTrigger(p1Cp, "fire-overwatch", {
    hasTorrentWeapons: true,
  });
  assert.equal(overwatch.triggered, true);
  assert.equal(overwatch.newState.currentCp, 1);
  p1Cp = overwatch.newState;

  // Evaluate Armor of Contempt vs AP -3 on high value target
  const aoc = evaluateStratagemTrigger(p1Cp, "armor-of-contempt", {
    incomingAp: 3,
    isHighValueTarget: true,
  });
  assert.equal(aoc.triggered, true);
  assert.equal(aoc.newState.currentCp, 0);
  assert.equal(aoc.modifiedAp, 2); // Reduced AP from -3 to -2
  p1Cp = aoc.newState;

  // Insufficient CP for next stratagem
  assert.equal(canSpendCp(p1Cp, 1), false);
  assert.throws(() => spendCp(p1Cp, 1), /Insufficient CP/);
});
