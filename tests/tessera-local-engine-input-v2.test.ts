import assert from "node:assert/strict";
import test from "node:test";

import {
  compileRosterForLocalTesseraEngineV2,
  parseLocalTesseraEngineInputV2,
  serializeLocalTesseraEngineInputV2,
  verifyLocalTesseraEngineInputV2,
} from "../local/tessera/local-engine-input-v2";
import { localInputSha256 } from "../local/tessera/local-engine-input";
import {
  buildCustodesVsAeldariSmokeRoster,
  resolvedProfilePolicy,
} from "./helpers/tessera-local-bundle";

test("local input v2 binds every weapon profile to range, source, bearer, and loadout identities", () => {
  const roster = buildCustodesVsAeldariSmokeRoster();
  const input = compileRosterForLocalTesseraEngineV2(
    roster,
    resolvedProfilePolicy(roster),
  );

  assert.equal(input.schemaVersion, 2);
  assert.ok(input.units.length > 0);
  for (const unit of input.units) {
    assert.ok(unit.unitId);
    for (const weapon of unit.weapons) {
      assert.ok(weapon.weaponId);
      assert.ok(weapon.equipmentId);
      assert.ok(weapon.profileId);
      assert.equal(weapon.bearerSelectionId, unit.selectionId);
      assert.ok(weapon.loadoutGroupId);
      assert.equal(
        weapon.type === "melee",
        weapon.rangeInches === null,
      );
      if (weapon.type === "ranged") {
        assert.ok(
          typeof weapon.rangeInches === "number" &&
            weapon.rangeInches > 0,
        );
      }
    }
  }

  const content = serializeLocalTesseraEngineInputV2(input);
  assert.deepEqual(parseLocalTesseraEngineInputV2(content), input);
  assert.deepEqual(
    verifyLocalTesseraEngineInputV2({
      content,
      expectedSha256: localInputSha256(content),
      expectedBundleId: input.bundleId,
      expectedRosterFingerprint: input.rosterFingerprint,
    }),
    input,
  );
});

test("local input v2 rejects a profile whose bearer identity drifts", () => {
  const roster = buildCustodesVsAeldariSmokeRoster();
  const input = compileRosterForLocalTesseraEngineV2(
    roster,
    resolvedProfilePolicy(roster),
  );
  const changed = structuredClone(input);
  changed.units[0].weapons[0].bearerSelectionId = "another-selection";

  assert.throws(
    () => serializeLocalTesseraEngineInputV2(changed),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "TESSERA_LOCAL_INPUT_V2_BEARER_MISMATCH",
  );
});

test("local input v2 rejects a zero-range shooting profile", () => {
  const roster = buildCustodesVsAeldariSmokeRoster();
  const input = compileRosterForLocalTesseraEngineV2(
    roster,
    resolvedProfilePolicy(roster),
  );
  const changed = structuredClone(input);
  const ranged = changed.units
    .flatMap((unit) => unit.weapons.map((weapon) => ({ unit, weapon })))
    .find(({ weapon }) => weapon.type === "ranged");
  assert.ok(ranged);
  ranged.weapon.rangeInches = 0;

  assert.throws(
    () => serializeLocalTesseraEngineInputV2(changed),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "TESSERA_LOCAL_INPUT_V2_RANGE_MISSING",
  );
});
