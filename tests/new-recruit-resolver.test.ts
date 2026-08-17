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

test("duplicate same-name catalogue models are not treated as ambiguous", () => {
  const mapping =
    newRecruitCatalogueMappings.factions["astra-militarum"].units[
      "death-korps-of-krieg"
    ];
  assert.ok(mapping);
  const watchmasters = mapping.models.filter(
    (model) => model.name === "Death Korps Watchmaster",
  );
  assert.ok(
    watchmasters.length >= 2,
    "fixture requires duplicate Watchmaster catalogue entries",
  );

  const resolved = resolveNewRecruitUnit(mapping, {
    unitId: "death-korps-of-krieg",
    name: "Death Korps of Krieg",
    modelCount: 20,
    equipment: [
      {
        itemId: "bolt-pistol-death-korps-of-krieg",
        name: "Bolt pistol",
        count: 1,
      },
      {
        itemId: "boltgun-death-korps-of-krieg",
        name: "Boltgun",
        count: 1,
      },
      {
        itemId: "chainsword-death-korps-of-krieg",
        name: "Chainsword",
        count: 1,
      },
      {
        itemId: "close-combat-weapon-death-korps-of-krieg",
        name: "Close combat weapon",
        count: 19,
      },
      { itemId: "lasgun", name: "Lasgun", count: 17 },
      { itemId: "meltagun", name: "Meltagun", count: 1 },
    ],
  });
  assert.equal(resolved.ok, true, resolved.ok ? undefined : resolved.reason);
  if (!resolved.ok) return;
  const modelCounts = new Map<string, number>();
  for (const model of resolved.models) {
    modelCounts.set(
      model.reference.name,
      (modelCounts.get(model.reference.name) ?? 0) + model.count,
    );
  }
  assert.equal(modelCounts.get("Death Korps Watchmaster"), 2);
  assert.equal(modelCounts.get("Death Korps Trooper"), 17);
  assert.equal(modelCounts.get("Death Korps Trooper w/ Meltagun"), 1);
});

test("Krieg Command Squad keeps Master Vox distinct from Regimental Standard", () => {
  const mapping =
    newRecruitCatalogueMappings.factions["astra-militarum"].units[
      "krieg-command-squad"
    ];
  assert.ok(mapping);
  const resolved = resolveNewRecruitUnit(mapping, {
    unitId: "krieg-command-squad",
    name: "Krieg Command Squad",
    modelCount: 6,
    equipment: [
      { itemId: "boltgun-krieg-command-squad", name: "Boltgun", count: 1 },
      {
        itemId: "chainsword-krieg-command-squad",
        name: "Chainsword",
        count: 1,
      },
      {
        itemId: "close-combat-weapon-krieg-command-squad",
        name: "Close combat weapon",
        count: 4,
      },
      { itemId: "lasgun", name: "Lasgun", count: 2 },
      {
        itemId: "laspistol-krieg-command-squad",
        name: "Laspistol",
        count: 3,
      },
      {
        itemId: "power-weapon-krieg-command-squad",
        name: "Power weapon",
        count: 1,
      },
    ],
  });
  assert.equal(resolved.ok, true, resolved.ok ? undefined : resolved.reason);
  if (!resolved.ok) return;
  const names = resolved.models.map((model) => model.reference.name);
  assert.equal(names.length, 6);
  assert.equal(
    names.filter((name) => name === "Veteran Guardsman w/ Master vox").length,
    1,
  );
  assert.equal(
    names.filter((name) => name === "Veteran Guardsman w/ Regimental standard")
      .length,
    1,
  );
});

test("Reiver Squad maps regular models to Reivers instead of extra Sergeants", () => {
  const mapping =
    newRecruitCatalogueMappings.factions["adeptus-astartes"].units[
      "reiver-squad"
    ];
  assert.ok(mapping);
  const resolved = resolveNewRecruitUnit(mapping, {
    unitId: "reiver-squad",
    name: "Reiver Squad",
    modelCount: 10,
    equipment: [
      { itemId: "combat-knife", name: "Combat knife", count: 10 },
      { itemId: "reiver-grav-chute", name: "Reiver grav-chute", count: 1 },
      {
        itemId: "special-issue-bolt-pistol-reiver-squad",
        name: "Special-issue bolt pistol",
        count: 10,
      },
    ],
  });
  assert.equal(resolved.ok, true, resolved.ok ? undefined : resolved.reason);
  if (!resolved.ok) return;
  assert.deepEqual(
    resolved.models.map((model) => ({
      name: model.reference.name,
      count: model.count,
    })),
    [
      { name: "Reiver Sergeant", count: 1 },
      { name: "Reivers", count: 9 },
    ],
  );
});
