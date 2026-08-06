import assert from "node:assert/strict";
import { test } from "node:test";

import { CombatCorpusReviewedMatcherV1Schema } from "../local/tessera/combat-corpus-reviewed-overlay";

test("CombatCorpusReviewedMatcherV1Schema validates expanded local matchers for Step 1", () => {
  const matchers = [
    "simple-additive-stat-modifier-v1",
    "simple-additive-roll-modifier-v1",
    "simple-reroll-v1",
    "simple-feel-no-pain-v1",
    "simple-flat-damage-reduction-v1",
    "simple-invulnerable-save-v1",
    "simple-keyword-grant-v1",
    "simple-bs-modifier-v1",
    "noncombat-movement-v1",
    "dice-substitution-v1",
    "stance-selection-v1",
    "leader-buff-grant-v1",
    "objective-proximity-v1",
    "threshold-modifier-v1",
  ];

  for (const matcher of matchers) {
    const parsed = CombatCorpusReviewedMatcherV1Schema.parse(matcher);
    assert.equal(parsed, matcher);
  }
});
