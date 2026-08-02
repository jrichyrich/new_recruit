import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeneralThreatPortfolio,
  GeneralThreatArchetypeIds,
} from "../lib/rosterpilot/general-threat-portfolio";
import { validateRoster } from "../lib/rosterpilot/engine";

test("generic threat portfolio rejects unsupported points limits", () => {
  const result = buildGeneralThreatPortfolio({ pointsLimit: 1250 });

  assert.equal(result.ok, false);
  assert.equal(
    result.violations[0]?.code,
    "GENERAL_PORTFOLIO_POINTS_UNSUPPORTED",
  );
});

test("generic threat portfolio builds six legal exportable lenses", {
  timeout: 120_000,
}, () => {
  for (const pointsLimit of [1000, 2000]) {
    const first = buildGeneralThreatPortfolio({ pointsLimit });
    const second = buildGeneralThreatPortfolio({ pointsLimit });

    assert.equal(first.ok, true);
    assert.equal(first.data?.items.length, 6);
    assert.deepEqual(
      first.data?.items.map((item) => item.archetypeId),
      GeneralThreatArchetypeIds,
    );
    assert.equal(
      first.data?.portfolioHash,
      second.data?.portfolioHash,
    );
    assert.equal(
      new Set(
        first.data?.items.map(
          (item) => item.simulationFingerprint,
        ),
      ).size,
      6,
    );
    for (const item of first.data?.items ?? []) {
      assert.equal(validateRoster(item.roster).ok, true);
      assert.ok(
        item.roster.totalPoints >= pointsLimit * 0.98,
      );
      assert.ok(item.selectionEvidence.length >= 3);
      const armourShare =
        (item.traits.vehiclePointsPercent ?? 0) +
        (item.traits.monsterPointsPercent ?? 0);
      if (item.archetypeId === "elite") {
        assert.ok(
          (item.traits.infantryPointsPercent ?? 0) >= 0.55,
        );
        assert.ok(armourShare <= 0.25);
      }
      if (item.archetypeId === "armour-monster") {
        assert.ok(armourShare >= 0.55);
      }
    }
  }
});
