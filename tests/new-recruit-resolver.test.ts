import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import v8 from "node:v8";

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

test("bounds combinatorial loadout resolution consistently across forced GC", () => {
  const mapping =
    newRecruitCatalogueMappings.factions["tau-empire"].units[
      "broadside-battlesuits"
    ];
  assert.ok(mapping);
  const selection: NewRecruitUnitInput = {
    unitId: "broadside-battlesuits",
    name: "Broadside Battlesuits",
    modelCount: 3,
    equipment: [
      {
        itemId: "crushing-bulk",
        name: "Crushing bulk",
        count: 3,
      },
      {
        itemId: "heavy-rail-rifle",
        name: "Heavy rail rifle",
        count: 3,
      },
    ],
  };

  v8.setFlagsFromString("--expose-gc");
  const forceGc = vm.runInNewContext("gc") as () => void;
  try {
    const outcomes = Array.from({ length: 24 }, () => {
      forceGc();
      const resolved = resolveNewRecruitUnit(mapping, selection);
      return resolved.ok
        ? resolved.models.map((model) => ({
            name: model.reference.name,
            count: model.count,
          }))
        : resolved.reason;
    });
    assert.deepEqual(
      [...new Set(outcomes.map((outcome) => JSON.stringify(outcome)))],
      [
        JSON.stringify([
          { name: "Broadside Shas’vre", count: 3 },
        ]),
      ],
    );

    const multiRowMapping =
      newRecruitCatalogueMappings.factions["adeptus-astartes"].units[
        "devastator-squad"
      ];
    assert.ok(multiRowMapping);
    const multiRowSelection: NewRecruitUnitInput = {
      unitId: "devastator-squad",
      name: "Devastator Squad",
      modelCount: 6,
      equipment: [
        { itemId: "bolt-pistol", name: "Bolt pistol", count: 6 },
        { itemId: "boltgun", name: "Boltgun", count: 6 },
        {
          itemId: "close-combat-weapon-devastator-squad",
          name: "Close combat weapon",
          count: 6,
        },
      ],
    };
    const multiRowOutcomes = Array.from({ length: 24 }, () => {
      forceGc();
      const resolved = resolveNewRecruitUnit(
        multiRowMapping,
        multiRowSelection,
      );
      return resolved.ok
        ? resolved.models.map((model) => ({
            name: model.reference.name,
            count: model.count,
          }))
        : resolved.reason;
    });
    assert.deepEqual(
      [
        ...new Set(
          multiRowOutcomes.map((outcome) => JSON.stringify(outcome)),
        ),
      ],
      [
        JSON.stringify([
          { name: "Devastator Sergeant", count: 1 },
          { name: "Devastator Marine w/ Boltgun", count: 5 },
        ]),
      ],
    );

    const complexMultiRowOutcomes = Array.from(
      { length: 24 },
      () => {
        forceGc();
        const resolved = resolveNewRecruitUnit(
          multiRowMapping,
          {
            ...multiRowSelection,
            equipment: [
              {
                itemId: "bolt-pistol",
                name: "Bolt pistol",
                count: 6,
              },
              { itemId: "boltgun", name: "Boltgun", count: 5 },
              {
                itemId: "close-combat-weapon-devastator-squad",
                name: "Close combat weapon",
                count: 6,
              },
              {
                itemId: "lascannon-devastator-squad",
                name: "Lascannon",
                count: 1,
              },
            ],
          },
        );
        return resolved.ok ? "resolved" : resolved.reason;
      },
    );
    assert.deepEqual(
      [...new Set(complexMultiRowOutcomes)],
      [
        "The legal Devastator Squad loadout could not be decomposed into New Recruit model selections.",
      ],
    );
  } finally {
    v8.setFlagsFromString("--no-expose-gc");
  }
});
