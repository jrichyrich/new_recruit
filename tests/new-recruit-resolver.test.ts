import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import v8 from "node:v8";

import { newRecruitCatalogueMappings } from "../lib/rosterpilot/catalogue";
import {
  resolveNewRecruitUnit,
  type NewRecruitUnitResolution,
  type NewRecruitUnitInput,
} from "../lib/rosterpilot/new-recruit-resolver";
import {
  evaluateResolvedPoints,
  type UnitMappingResult,
} from "../scripts/sync-bsdata";

test("adds selected equipment costs to a nonzero unit cost", () => {
  const pointsTypeId = "points";
  const unitEntryId = "unit";
  const modelEntryId = "model";
  const lanceEntryId = "lance";
  const mappingResult: UnitMappingResult = {
    mapping: {
      name: "Venatari Custodians",
      normalizedName: "venatari custodians",
      type: "unit",
      entryId: unitEntryId,
      categories: [],
      directEquipment: [],
      models: [],
      enhancements: {},
      pointsByModelCount: {},
    },
    nodesByEntryPath: new Map([
      [unitEntryId, {
        id: unitEntryId,
        costs: [{ typeId: pointsTypeId, value: 150 }],
      }],
      [modelEntryId, {
        id: modelEntryId,
        costs: [{ typeId: pointsTypeId, value: 0 }],
      }],
      [lanceEntryId, {
        id: lanceEntryId,
        costs: [{ typeId: pointsTypeId, value: 5 }],
      }],
    ]),
  };
  const resolution: Extract<NewRecruitUnitResolution, { ok: true }> = {
    ok: true,
    models: [{
      reference: {
        name: "Venatari Custodian (Venatari lance)",
        normalizedName: "venatari custodian (venatari lance)",
        type: "model",
        entryId: modelEntryId,
        equipment: [],
      },
      count: 3,
      equipment: [{
        itemId: "venatari-lance",
        name: "Venatari lance",
        count: 3,
        reference: {
          name: "Venatari lance",
          normalizedName: "venatari lance",
          type: "upgrade",
          entryId: lanceEntryId,
        },
      }],
    }],
    directEquipment: [],
  };

  assert.deepEqual(
    evaluateResolvedPoints(
      mappingResult,
      resolution,
      pointsTypeId,
      3,
      "adeptus-custodes",
    ),
    { ok: true, value: 165, unresolvedReasons: [] },
  );
});

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

test("uses model role to distinguish a shortened regular-model alias from its leader", () => {
  const selection: NewRecruitUnitInput = {
    unitId: "celestian-insidiants",
    name: "Celestian Insidiants",
    modelCount: 10,
    equipment: [
      {
        itemId: "condemnor-bolt-pistol",
        name: "Condemnor bolt pistol",
        count: 10,
      },
      { itemId: "null-mace", name: "Null mace", count: 10 },
    ],
  };
  const mapping =
    newRecruitCatalogueMappings.factions["adepta-sororitas"].units[
      selection.unitId
    ];
  assert.ok(mapping);

  const resolved = resolveNewRecruitUnit(mapping, selection);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  assert.deepEqual(
    resolved.models.map((model) => ({
      name: model.reference.name,
      count: model.count,
      equipment: model.equipment.map((equipment) => ({
        name: equipment.name,
        count: equipment.count,
      })),
    })),
    [
      {
        name: "Celestian Insidiant Superior",
        count: 1,
        equipment: [
          { name: "Condemnor bolt pistol", count: 1 },
          { name: "Null mace", count: 1 },
        ],
      },
      {
        name: "Insidiant",
        count: 9,
        equipment: [
          { name: "Condemnor bolt pistol", count: 9 },
          { name: "Null mace", count: 9 },
        ],
      },
    ],
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
