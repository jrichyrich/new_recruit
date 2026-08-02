import assert from "node:assert/strict";
import test from "node:test";

import { searchFactions } from "../lib/rosterpilot/engine";
import {
  prepareRosterWorkflow,
} from "../lib/rosterpilot/roster-workflow";

test("composite workflow builds export-safe 1,000 and 2,000 point rosters for every supported faction", {
  timeout: 300_000,
}, async () => {
  const factions = (searchFactions("", 100).data ?? []).filter(
    (faction) => faction.supported,
  );
  assert.equal(factions.length, 35);

  const failures: Array<{
    factionId: string;
    pointsLimit: number;
    codes: string[];
  }> = [];
  for (const faction of factions) {
    for (const pointsLimit of [1000, 2000]) {
      const result = await prepareRosterWorkflow({
        intent: "prepare-new-recruit",
        playerFaction: faction.id,
        pointsLimit,
        coachingMode: "none",
      });
      if (!result.ok || !result.data?.roster) {
        failures.push({
          factionId: faction.id,
          pointsLimit,
          codes: result.violations.map((violation) => violation.code),
        });
        continue;
      }
      assert.equal(result.data.validation?.ok, true);
      assert.ok(result.data.roster.totalPoints >= pointsLimit * 0.98);
      assert.ok(
        result.data.newRecruit.handoff?.artifacts.some(
          (artifact) => artifact.format === "rosz",
        ),
      );
    }
  }
  assert.deepEqual(failures, []);
});
