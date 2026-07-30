import assert from "node:assert/strict";
import test from "node:test";

import {
  baselineDamageCells,
  buildRoster,
} from "../lib/rosterpilot/index";

test("baseline-damage-v1 is deterministic and never claims a winner", () => {
  const player = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
    requiredWarlordUnitId: "farseer-skyrunner",
    excludedUnitIds: ["warlock-skyrunners"],
    opponentContext: {
      kind: "known-faction",
      factionId: "adeptus-custodes",
    },
  });
  const opponent = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.equal(player.ok, true);
  assert.equal(opponent.ok, true);
  assert.ok(player.data);
  assert.ok(opponent.data);

  const first = baselineDamageCells(player.data, opponent.data);
  const second = baselineDamageCells(player.data, opponent.data);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);

  const farseerIntoAllarus = first.find(
    (cell) =>
      cell.attacker === "Farseer Skyrunner" &&
      cell.target === "Allarus Custodians" &&
      cell.phase === "shooting",
  );
  assert.equal(farseerIntoAllarus?.expectedDamage, 0.7284);
  assert.equal(
    JSON.stringify(first).toLocaleLowerCase().includes("winner"),
    false,
  );
});
