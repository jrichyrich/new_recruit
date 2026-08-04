import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTesseraParityCoveringSuiteV2,
  TesseraParityCoveringSuiteError,
  verifyTesseraParityCoveringSuiteV2,
} from "../local/tessera/provider-parity-covering-suite-v2";

const corpusInventorySha256 = "a".repeat(64);

test("dynamic parity suite covers every faction in both roles and every role-scoped mechanic", () => {
  const suite = buildTesseraParityCoveringSuiteV2({
    corpusInventorySha256,
    factions: [
      {
        factionId: "custodes",
        attackerMechanicIds: ["lethal-hits", "melee-ap"],
        defenderMechanicIds: ["invulnerable-save"],
      },
      {
        factionId: "world-eaters",
        attackerMechanicIds: ["charge", "sustained-hits"],
        defenderMechanicIds: ["feel-no-pain"],
      },
      {
        factionId: "aeldari",
        attackerMechanicIds: ["reroll-hit"],
        defenderMechanicIds: ["hit-penalty"],
      },
    ],
  });

  const covered = new Set(
    suite.cases.flatMap((entry) => entry.coveredRequirementIds),
  );
  assert.deepEqual([...covered].sort(), suite.requirements);
  assert.ok(suite.cases.length < 3 * 3);
  assert.ok(
    suite.cases.every(
      (entry) => entry.attackerFactionId !== entry.defenderFactionId,
    ),
  );
  assert.equal(verifyTesseraParityCoveringSuiteV2(suite), true);
});

test("covering suite is deterministic and its identity fails closed on tampering", () => {
  const factions = [
    {
      factionId: "b",
      attackerMechanicIds: ["x"],
      defenderMechanicIds: ["y"],
    },
    {
      factionId: "a",
      attackerMechanicIds: ["z"],
      defenderMechanicIds: [],
    },
  ];
  const first = buildTesseraParityCoveringSuiteV2({
    corpusInventorySha256,
    factions,
  });
  const second = buildTesseraParityCoveringSuiteV2({
    corpusInventorySha256,
    factions: [...factions].reverse(),
  });
  assert.deepEqual(first, second);
  assert.equal(
    first.cases.length,
    1,
    "one bidirectional exact matchup covers both factions in both roles",
  );

  const changed = structuredClone(first);
  changed.cases[0].coveredRequirementIds.pop();
  assert.equal(verifyTesseraParityCoveringSuiteV2(changed), false);
  assert.equal(
    verifyTesseraParityCoveringSuiteV2(
      null as unknown as typeof changed,
    ),
    false,
  );
});

test("covering suite build rejects malformed faction and mechanic identifiers", () => {
  for (const factions of [
    [{
      factionId: " ",
      attackerMechanicIds: [],
      defenderMechanicIds: [],
    }],
    [{
      factionId: "a",
      attackerMechanicIds: [""],
      defenderMechanicIds: [],
    }],
    [{
      factionId: "a",
      attackerMechanicIds: [1],
      defenderMechanicIds: [],
    }],
  ]) {
    assert.throws(
      () => buildTesseraParityCoveringSuiteV2({
        corpusInventorySha256,
        factions: factions as never,
      }),
      TesseraParityCoveringSuiteError,
    );
  }
});
