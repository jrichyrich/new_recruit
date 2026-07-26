import assert from "node:assert/strict";
import test from "node:test";

import { newRecruitCatalogueMappings } from "../lib/rosterpilot/catalogue";
import {
  resolveNewRecruitUnit,
  type NewRecruitUnitInput,
} from "../lib/rosterpilot/new-recruit-resolver";

const eliminatorSelection: NewRecruitUnitInput = {
  unitId: "eliminator-squad",
  name: "Eliminator Squad",
  modelCount: 3,
  equipment: [
    { itemId: "bolt-pistol", name: "Bolt pistol", count: 3 },
    {
      itemId: "bolt-sniper-rifle",
      name: "Bolt Sniper Rifle",
      count: 3,
    },
    {
      itemId: "close-combat-weapon",
      name: "Close combat weapon",
      count: 3,
    },
  ],
};

test("resolves Eliminators as one Sergeant and two regular models", () => {
  const mapping =
    newRecruitCatalogueMappings.factions["space-wolves"].units[
      eliminatorSelection.unitId
    ];
  assert.ok(mapping);

  const resolved = resolveNewRecruitUnit(mapping, eliminatorSelection);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  assert.deepEqual(
    resolved.models.map((model) => ({
      name: model.reference.name,
      count: model.count,
    })),
    [
      { name: "Eliminator Sergeant", count: 1 },
      { name: "Eliminator", count: 2 },
    ],
  );

  const sergeant = resolved.models[0];
  const regular = resolved.models[1];
  assert.notEqual(sergeant.reference.entryId, regular.reference.entryId);
  const rifle = sergeant.equipment.find(
    (equipment) => equipment.itemId === "bolt-sniper-rifle",
  );
  assert.ok(rifle);
  assert.match(
    rifle.reference.entryId,
    /::30cd-9443-83f7-d3ad::ab36-4f93-71d9-3d73$/,
  );
});

test("fails closed when the exact Sergeant mapping lacks required equipment", () => {
  const mapping = structuredClone(
    newRecruitCatalogueMappings.factions["space-wolves"].units[
      eliminatorSelection.unitId
    ],
  );
  assert.ok(mapping);

  const sergeant = mapping.models.find(
    (model) => model.name === "Eliminator Sergeant",
  );
  assert.ok(sergeant);
  sergeant.equipment = sergeant.equipment.filter(
    (equipment) => equipment.normalizedName !== "bolt sniper rifle",
  );

  const resolved = resolveNewRecruitUnit(mapping, eliminatorSelection);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(
    resolved.reason,
    /no model entry for 1 Eliminator Sergeant model with the selected equipment/,
  );
});
