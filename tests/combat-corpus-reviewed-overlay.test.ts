import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSERVATIVE_COMBAT_CORPUS_REVIEWED_STORE_V1,
  createCombatCorpusReviewedStoreV1,
  exactCombatCorpusReviewEntryV1,
  verifyCombatCorpusReviewedStoreV1,
  wargearCombatCorpusAbilityBindingV1,
  type CombatCorpusReviewEvidenceV1,
  type CombatCorpusReviewedEntryV1,
} from "../local/tessera/combat-corpus-reviewed-overlay";

const evidence: CombatCorpusReviewEvidenceV1 = {
  reviewedBy: "fixture-reviewer",
  reviewedAt: "2026-08-04T00:00:00.000Z",
  rationale: "The fixture binds one exact reviewed semantic leaf.",
  reference: "fixture:combat-corpus-review",
};

const exact = exactCombatCorpusReviewEntryV1({
  entryId: "exact:leaf-a",
  source: {
    sourceId: "source-a",
    entitySha256: "a".repeat(64),
    jsonPointer: "/effect",
    fragmentSha256: "b".repeat(64),
  },
  phases: ["fight", "shooting", "fight"],
  stateKeys: ["unit.damage", "timing", "unit.damage"],
  disposition: {
    kind: "modeled",
    mechanicIds: ["save-mod", "hit-mod", "save-mod"],
  },
  evidence,
});

const wargear = wargearCombatCorpusAbilityBindingV1({
  entryId: "wargear:icon-a",
  factionId: "faction-a",
  unitId: "unit-a",
  equipmentId: "icon-a",
  abilityId: "icon-a-effect",
  evidence,
});

test("review stores canonicalize set-like evidence and retain a stable hash", () => {
  const forward = createCombatCorpusReviewedStoreV1({
    seedVersion: "fixture-v1",
    entries: [exact, wargear],
  });
  const reverse = createCombatCorpusReviewedStoreV1({
    seedVersion: "fixture-v1",
    entries: [wargear, exact],
  });

  assert.deepEqual(reverse, forward);
  assert.deepEqual(
    forward.entries.find((entry) => entry.kind === "exact-leaf"),
    {
      ...exact,
      phases: ["fight", "shooting"],
      stateKeys: ["timing", "unit.damage"],
      disposition: {
        kind: "modeled",
        mechanicIds: ["hit-mod", "save-mod"],
      },
    },
  );
  assert.match(forward.storeSha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyCombatCorpusReviewedStoreV1(forward), true);
  assert.equal(
    verifyCombatCorpusReviewedStoreV1({
      ...forward,
      storeSha256: "0".repeat(64),
    }),
    false,
  );
});

test("review stores reject duplicate matcher and exact-source authority", () => {
  const matcher = CONSERVATIVE_COMBAT_CORPUS_REVIEWED_STORE_V1.entries.find(
    (entry) => entry.kind === "reviewed-matcher",
  );
  assert.ok(matcher);

  assert.throws(
    () => createCombatCorpusReviewedStoreV1({
      seedVersion: "duplicate-matcher-v1",
      entries: [
        matcher,
        { ...matcher, entryId: `${matcher.entryId}:duplicate` },
      ],
    }),
    /cannot repeat a matcher/i,
  );
  assert.throws(
    () => createCombatCorpusReviewedStoreV1({
      seedVersion: "duplicate-exact-v1",
      entries: [
        exact,
        { ...exact, entryId: "exact:leaf-a:duplicate" },
      ] as CombatCorpusReviewedEntryV1[],
    }),
    /cannot repeat an exact leaf binding/i,
  );
});

test("the shipped conservative review seed is self-verifying", () => {
  assert.equal(
    verifyCombatCorpusReviewedStoreV1(
      CONSERVATIVE_COMBAT_CORPUS_REVIEWED_STORE_V1,
    ),
    true,
  );
  assert.ok(
    CONSERVATIVE_COMBAT_CORPUS_REVIEWED_STORE_V1.entries.length > 0,
  );
});
