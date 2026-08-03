import assert from "node:assert/strict";
import test from "node:test";

import {
  conflictAppliesToRoster,
  conflictsForRoster,
  newRecruitCatalogue,
  type RosterConflictInput,
} from "../lib/rosterpilot/catalogue-summary";
import {
  buildExportableRosterCandidate,
  knownBlockedSelectionExclusions,
} from "../lib/rosterpilot/stress-portfolio";
import type {
  CatalogueModelReference,
  CatalogueSelectionReference,
  CatalogueUnitReference,
  DataConflict,
  NewRecruitFactionCatalogue,
} from "../lib/rosterpilot/catalogue-types";
import { configurationSelections } from "../lib/rosterpilot/new-recruit";
import {
  newRecruitEquipmentSignature,
  normalizeNewRecruitName,
  resolveNewRecruitUnit,
} from "../lib/rosterpilot/new-recruit-resolver";
import type { RosterDraftV1 } from "../lib/rosterpilot/types";
import {
  buildConfiguration,
  choiceAwareEquipmentReferences,
  combinedSelectionIndex,
  evaluateResolvedPoints,
  localSelectionIndex,
  walkSelections,
  type CatalogueDocument,
  type Overrides,
  type UnitMappingResult,
  type WalkedSelection,
} from "../scripts/sync-bsdata";

function document(
  file: string,
  id: string,
  root: Record<string, unknown>,
): CatalogueDocument {
  return {
    file,
    id,
    name: file.replace(/\.json$/, ""),
    root: {
      id,
      name: file.replace(/\.json$/, ""),
      revision: 1,
      ...root,
    },
  };
}

function detachmentRoot(input: {
  linkId: string;
  rootId: string;
  label: string;
  groupId: string;
  choices: Array<{ id: string; name: string }>;
  categoryOnLink?: boolean;
  linkedGroup?: boolean;
}): Record<string, unknown> {
  const categoryLinks = [
    {
      targetId: "configuration-category",
      name: "Configuration",
      primary: true,
    },
  ];
  const group = {
    id: input.groupId,
    name: "Detachment",
    selectionEntries: input.choices.map((choice) => ({
      ...choice,
      type: "upgrade",
      costs: [],
    })),
  };
  return {
    entryLinks: [
      {
        id: input.linkId,
        name: input.label,
        type: "selectionEntry",
        targetId: input.rootId,
        ...(input.categoryOnLink ? { categoryLinks } : {}),
      },
    ],
    sharedSelectionEntries: [
      {
        id: input.rootId,
        name: "Detachment",
        type: "upgrade",
        ...(!input.categoryOnLink ? { categoryLinks } : {}),
        ...(input.linkedGroup
          ? {
              entryLinks: [
                {
                  id: `${input.groupId}-link`,
                  name: "Detachment",
                  type: "selectionEntryGroup",
                  targetId: input.groupId,
                },
              ],
            }
          : { selectionEntryGroups: [group] }),
      },
    ],
    ...(input.linkedGroup
      ? { sharedSelectionEntryGroups: [group] }
      : {}),
  };
}

const gameSystem = {
  categoryEntries: [
    { id: "configuration-category", name: "Configuration" },
  ],
  entryLinks: [
    {
      id: "battle-link",
      name: "Battle Size",
      type: "selectionEntry",
      targetId: "battle-root",
    },
    {
      id: "disposition-link",
      name: "Force Disposition",
      type: "selectionEntry",
      targetId: "disposition-root",
    },
  ],
  sharedSelectionEntries: [
    {
      id: "battle-root",
      name: "Battle Size",
      type: "upgrade",
      selectionEntryGroups: [
        {
          id: "battle-group",
          name: "Battle Size",
          selectionEntries: [
            { id: "incursion", name: "Incursion", type: "upgrade" },
            {
              id: "strike-force",
              name: "Strike Force",
              type: "upgrade",
            },
          ],
        },
      ],
    },
    {
      id: "disposition-root",
      name: "Force Disposition",
      type: "upgrade",
    },
  ],
};

const emptyOverrides: Overrides = {
  schemaVersion: 2,
  factionCatalogues: {},
  unitAliases: {},
  detachmentAliases: {},
  enhancementAliases: {},
  exactPathOverrides: { units: {}, detachments: {} },
};

test("merges viable detachment roots and ignores an unrelated first import", () => {
  const unrelated = document(
    "Agents.json",
    "agents",
    detachmentRoot({
      linkId: "agents-root-link",
      rootId: "agents-root",
      label: "Detachment",
      groupId: "agents-group",
      choices: [{ id: "agents-choice", name: "Alien Detachment" }],
      categoryOnLink: true,
    }),
  );
  const primary = document(
    "Votann.json",
    "votann",
    detachmentRoot({
      linkId: "votann-root-link",
      rootId: "votann-root",
      label: "Detachment Choice",
      groupId: "votann-group",
      choices: [{ id: "alpha-choice", name: "Alpha Host" }],
    }),
  );
  const imported = document(
    "Space Marines.json",
    "space-marines",
    detachmentRoot({
      linkId: "marine-root-link",
      rootId: "marine-root",
      label: "Detachment",
      groupId: "marine-group",
      choices: [{ id: "beta-choice", name: "Beta Host" }],
      linkedGroup: true,
    }),
  );
  const documents = [unrelated, primary, imported];
  const index = combinedSelectionIndex(documents, gameSystem);
  const conflicts: DataConflict[] = [];
  const configuration = buildConfiguration(
    primary,
    documents,
    gameSystem,
    index,
    [
      { id: "alpha", name: "Alpha Host", detachment_points: 0 },
      { id: "beta", name: "Beta Host", detachment_points: 0 },
    ] as Parameters<typeof buildConfiguration>[4],
    emptyOverrides,
    "detachment-points",
    conflicts,
    "fixture-faction",
  );

  assert.ok(configuration);
  assert.deepEqual(Object.keys(configuration.detachment.choices), [
    "alpha",
    "beta",
  ]);
  assert.equal(
    configuration.detachment.choices.alpha.rootReference?.entryId,
    "votann-root-link::votann-root",
  );
  assert.equal(
    configuration.detachment.choices.beta.rootReference?.entryId,
    "marine-root-link::marine-root",
  );
  assert.equal(
    configuration.detachment.choices.beta.entryId,
    "marine-root-link::marine-group-link::beta-choice",
  );
  assert.equal(conflicts.length, 0);
});

test("serializes a detachment beneath the root that contributed its path", () => {
  const primary = document(
    "Primary.json",
    "primary",
    detachmentRoot({
      linkId: "primary-root-link",
      rootId: "primary-root",
      label: "Detachment Choice",
      groupId: "primary-group",
      choices: [{ id: "alpha-choice", name: "Alpha Host" }],
    }),
  );
  const imported = document(
    "Imported.json",
    "imported",
    detachmentRoot({
      linkId: "imported-root-link",
      rootId: "imported-root",
      label: "Detachment",
      groupId: "imported-group",
      choices: [{ id: "beta-choice", name: "Beta Host" }],
    }),
  );
  const documents = [primary, imported];
  const conflicts: DataConflict[] = [];
  const configuration = buildConfiguration(
    primary,
    documents,
    gameSystem,
    combinedSelectionIndex(documents, gameSystem),
    [{ id: "beta", name: "Beta Host", detachment_points: 0 }] as Parameters<
      typeof buildConfiguration
    >[4],
    emptyOverrides,
    "detachment-points",
    conflicts,
    "fixture-faction",
  );
  assert.ok(configuration);
  configuration.forceDisposition.choices.fixture = {
    name: "Fixture disposition",
    normalizedName: "fixture disposition",
    type: "upgrade",
    entryId: "fixture-disposition",
  };
  const selections = configurationSelections(
    {
      id: "fixture-roster",
      battleSize: "incursion",
      detachmentId: "beta",
      detachmentName: "Beta Host",
      forceDispositionId: "fixture",
      forceDispositionName: "Fixture disposition",
    } as RosterDraftV1,
    {
      configuration,
    } as NewRecruitFactionCatalogue,
  ) as Array<Record<string, unknown>>;
  const detachment = selections[1];
  assert.equal(detachment.entryId, "imported-root-link::imported-root");
  assert.equal(
    (detachment.selections as Array<Record<string, unknown>>)[0].entryId,
    "imported-root-link::beta-choice",
  );
});

test("rejects stale exact-path overrides without guessing a replacement", () => {
  const primary = document(
    "Primary.json",
    "primary",
    detachmentRoot({
      linkId: "primary-root-link",
      rootId: "primary-root",
      label: "Detachment",
      groupId: "primary-group",
      choices: [{ id: "alpha-choice", name: "Alpha Host" }],
    }),
  );
  const conflicts: DataConflict[] = [];
  const configuration = buildConfiguration(
    primary,
    [primary],
    gameSystem,
    combinedSelectionIndex([primary], gameSystem),
    [{ id: "alpha", name: "Alpha Host", detachment_points: 0 }] as Parameters<
      typeof buildConfiguration
    >[4],
    {
      ...emptyOverrides,
      exactPathOverrides: {
        units: {},
        detachments: {
          "fixture-faction:alpha": {
            catalogueId: "primary",
            catalogueRevision: 2,
            entryPath: "primary-root-link::alpha-choice",
          },
        },
      },
    },
    "detachment-points",
    conflicts,
    "fixture-faction",
  );

  assert.ok(configuration);
  assert.deepEqual(configuration.detachment.choices, {});
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].code, "STALE_OVERRIDE");
  assert.equal(conflicts[0].source, "reconciler");
  assert.match(conflicts[0].rootCauseKey ?? "", /^[0-9a-f]{16}$/);
  assert.equal(
    conflicts[0].scope?.entryPath,
    "primary-root-link::alpha-choice",
  );
});

test("schema-v2 conflict evidence is owned and deduplicated by root cause", () => {
  assert.equal(newRecruitCatalogue.schemaVersion, 2);
  const conflicts = Object.values(newRecruitCatalogue.factions).flatMap(
    (faction) => faction.conflicts,
  );
  assert.ok(conflicts.length > 0);
  assert.ok(
    conflicts.every(
      (item) =>
        item.source !== undefined &&
        /^[0-9a-f]{16}$/.test(item.rootCauseKey ?? ""),
    ),
  );
  const ownership = new Set(conflicts.map((item) => item.source));
  assert.ok(ownership.has("reconciler"));
  assert.ok(ownership.has("bsdata"));
  const factionsByRootCause = new Map<string, Set<string>>();
  for (const item of conflicts) {
    const factions =
      factionsByRootCause.get(item.rootCauseKey!) ?? new Set<string>();
    factions.add(item.factionId);
    factionsByRootCause.set(item.rootCauseKey!, factions);
  }
  assert.ok(
    [...factionsByRootCause.values()].some(
      (factionIds) => factionIds.size > 1,
    ),
  );
});

test("keeps repeated shared model targets distinct by full entry path", () => {
  const target = {
    id: "shared-model",
    name: "Shared Model",
    type: "model",
  };
  const index = localSelectionIndex({
    sharedSelectionEntries: [target],
  });
  const walked = walkSelections(
    {
      entryLinks: [
        {
          id: "left-link",
          type: "selectionEntry",
          targetId: "shared-model",
        },
        {
          id: "right-link",
          type: "selectionEntry",
          targetId: "shared-model",
        },
      ],
    },
    "unit-root",
    index,
  ).filter((item) => item.reference.type === "model");

  assert.deepEqual(
    walked.map((item) => item.modelId),
    [
      "unit-root::left-link::shared-model",
      "unit-root::right-link::shared-model",
    ],
  );
});

test("normalizes Unicode dash, whitespace, apostrophe, and diacritic variants", () => {
  assert.equal(
    normalizeNewRecruitName("Brôkhyr\u00a0Iron–master"),
    normalizeNewRecruitName("Brokhyr Iron-master"),
  );
  assert.equal(
    normalizeNewRecruitName("T’au — Empire"),
    normalizeNewRecruitName("T'au - Empire"),
  );
});

test("keeps duplicate equipment on one coherent sibling loadout branch", () => {
  const walked = (
    name: string,
    entryId: string,
    loadoutId: string,
  ): WalkedSelection => ({
    reference: selectionReference(name, entryId),
    node: { id: entryId, name, type: "upgrade" },
    ancestorEntryIds: [loadoutId],
  });
  const references = choiceAwareEquipmentReferences([
    walked("Kombi-weapon", "kombi-big", "big-loadout"),
    walked("Twin sluggas", "sluggas-big", "big-loadout"),
    walked("Big choppa", "big-choppa", "big-loadout"),
    walked("Kombi-weapon", "kombi-klaw", "klaw-loadout"),
    walked("Twin sluggas", "sluggas-klaw", "klaw-loadout"),
    walked("Power klaw", "power-klaw", "klaw-loadout"),
  ]);
  const mapping: CatalogueUnitReference = {
    ...selectionReference("Warboss", "warboss", "unit"),
    categories: [],
    directEquipment: references,
    models: [],
    enhancements: {},
    pointsByModelCount: {},
  };

  const base = resolveNewRecruitUnit(mapping, {
    unitId: "warboss",
    name: "Warboss",
    modelCount: 1,
    equipment: [
      { itemId: "kombi-weapon", name: "Kombi-weapon", count: 1 },
      { itemId: "twin-sluggas", name: "Twin sluggas", count: 1 },
      { itemId: "big-choppa-warboss", name: "Big choppa", count: 1 },
    ],
  });
  assert.equal(base.ok, true);
  assert.deepEqual(
    base.ok
      ? base.directEquipment.map((item) => item.reference.entryId).sort()
      : [],
    ["big-choppa", "kombi-big", "sluggas-big"],
  );

  const alternative = resolveNewRecruitUnit(mapping, {
    unitId: "warboss",
    name: "Warboss",
    modelCount: 1,
    equipment: [
      { itemId: "kombi-weapon", name: "Kombi-weapon", count: 1 },
      { itemId: "twin-sluggas", name: "Twin sluggas", count: 1 },
      { itemId: "power-klaw-warboss", name: "Power klaw", count: 1 },
    ],
  });
  assert.equal(alternative.ok, true);
  assert.deepEqual(
    alternative.ok
      ? alternative.directEquipment
          .map((item) => item.reference.entryId)
          .sort()
      : [],
    ["kombi-klaw", "power-klaw", "sluggas-klaw"],
  );

  const mixed = resolveNewRecruitUnit(mapping, {
    unitId: "warboss",
    name: "Warboss",
    modelCount: 1,
    equipment: [
      { itemId: "kombi-weapon", name: "Kombi-weapon", count: 1 },
      { itemId: "twin-sluggas", name: "Twin sluggas", count: 1 },
      { itemId: "big-choppa-warboss", name: "Big choppa", count: 1 },
      { itemId: "power-klaw-warboss", name: "Power klaw", count: 1 },
    ],
  });
  assert.equal(mixed.ok, false);
  assert.match(
    mixed.ok ? "" : mixed.reason,
    /equipment "Kombi-weapon" is ambiguous/,
  );
});

test("distinguishes a scoped quantity option from an unscoped default", () => {
  const references = choiceAwareEquipmentReferences([
    {
      reference: selectionReference(
        "Avenger shuriken catapult",
        "two-catapults",
      ),
      node: {
        id: "two-catapults",
        name: "Avenger shuriken catapult",
        type: "upgrade",
      },
      ancestorEntryIds: ["two-catapults-choice"],
    },
    {
      reference: selectionReference(
        "Avenger shuriken catapult",
        "default-catapult",
      ),
      node: {
        id: "default-catapult",
        name: "Avenger shuriken catapult",
        type: "upgrade",
      },
      ancestorEntryIds: [],
    },
  ]);

  assert.equal(
    references[0].loadoutChoiceId,
    "two-catapults-choice",
  );
  assert.equal(references[1].loadoutChoiceId, undefined);
});

test("retains the complete parent reference for nested loadout equipment", () => {
  const parent: WalkedSelection = {
    reference: selectionReference(
      "Power Glaive and Shimmershield",
      "shield-loadout",
    ),
    node: {
      id: "shield-loadout",
      name: "Power Glaive and Shimmershield",
      type: "upgrade",
    },
    ancestorEntryIds: [],
  };
  const child = (
    name: string,
    entryId: string,
  ): WalkedSelection => ({
    reference: selectionReference(name, entryId),
    node: { id: entryId, name, type: "upgrade" },
    ancestorEntryIds: ["shield-loadout"],
  });
  const references = choiceAwareEquipmentReferences([
    parent,
    child("Power Glaive", "power-glaive"),
    child("Shimmershield", "shimmershield"),
  ]);

  assert.deepEqual(references[1].loadoutChoice, parent.reference);
  assert.deepEqual(references[2].loadoutChoice, parent.reference);
});

test("keeps duplicate model equipment on one coherent sibling loadout branch", () => {
  const choice = (
    name: string,
    entryId: string,
    loadoutChoiceId: string,
  ): CatalogueSelectionReference => ({
    ...selectionReference(name, entryId),
    loadoutChoiceId,
  });
  const model: CatalogueModelReference = {
    ...selectionReference("Dire Avenger Exarch", "exarch", "model"),
    type: "model",
    equipment: [
      selectionReference("Close Combat Weapon", "exarch-close-combat"),
      choice("Power Glaive", "glaive-shield", "shield-loadout"),
      choice("Shimmershield", "shield", "shield-loadout"),
      choice("Power Glaive", "glaive-pistol", "pistol-loadout"),
      choice("Shuriken Pistol", "pistol", "pistol-loadout"),
    ],
  };
  const rankAndFile: CatalogueModelReference = {
    ...selectionReference("Dire Avenger", "dire-avenger", "model"),
    type: "model",
    equipment: [
      selectionReference("Avenger shuriken catapult", "catapult"),
      selectionReference("Close Combat Weapon", "close-combat"),
    ],
  };
  const resolution = resolveNewRecruitUnit(
    {
      ...selectionReference("Dire Avengers", "dire-avengers", "unit"),
      categories: [],
      directEquipment: [],
      models: [model, rankAndFile],
      enhancements: {},
      pointsByModelCount: {},
    },
    {
      unitId: "dire-avengers",
      name: "Dire Avengers",
      modelCount: 5,
      equipment: [
        { itemId: "power-glaive", name: "Power Glaive", count: 1 },
        { itemId: "shimmershield", name: "Shimmershield", count: 1 },
        {
          itemId: "avenger-shuriken-catapult",
          name: "Avenger shuriken catapult",
          count: 4,
        },
        {
          itemId: "close-combat-weapon",
          name: "Close Combat Weapon",
          count: 5,
        },
      ],
    },
  );

  assert.equal(resolution.ok, true);
  assert.deepEqual(
    resolution.ok
      ? resolution.models
          .find((item) => item.reference.entryId === "exarch")
          ?.equipment.map((item) => item.reference.entryId)
      : [],
    ["exarch-close-combat", "glaive-shield", "shield"],
  );

  const twinCatapults = resolveNewRecruitUnit(
    {
      ...selectionReference("Dire Avengers", "dire-avengers", "unit"),
      categories: [],
      directEquipment: [],
      models: [
        {
          ...model,
          equipment: [
            selectionReference(
              "Close Combat Weapon",
              "exarch-close-combat",
            ),
            choice(
              "Avenger shuriken catapult",
              "catapult-left",
              "twin-catapults",
            ),
            choice(
              "Avenger shuriken catapult",
              "catapult-right",
              "twin-catapults",
            ),
          ],
        },
        rankAndFile,
      ],
      enhancements: {},
      pointsByModelCount: {},
    },
    {
      unitId: "dire-avengers",
      name: "Dire Avengers",
      modelCount: 5,
      equipment: [
        {
          itemId: "avenger-shuriken-catapult",
          name: "Avenger shuriken catapult",
          count: 6,
        },
        {
          itemId: "close-combat-weapon",
          name: "Close Combat Weapon",
          count: 5,
        },
      ],
    },
  );
  assert.equal(twinCatapults.ok, true);
  assert.deepEqual(
    twinCatapults.ok
      ? twinCatapults.models
          .find((item) => item.reference.entryId === "exarch")
          ?.equipment.filter(
            (item) => item.name === "Avenger shuriken catapult",
          )
          .map((item) => [item.reference.entryId, item.count])
      : [],
    [
      ["catapult-left", 1],
      ["catapult-right", 1],
    ],
  );
});

function selectionReference(
  name: string,
  entryId: string,
  type: CatalogueSelectionReference["type"] = "upgrade",
): CatalogueSelectionReference {
  return {
    name,
    normalizedName: normalizeNewRecruitName(name),
    type,
    entryId,
  };
}

test("evaluates selected model and equipment point costs at exact counts", () => {
  const root = selectionReference("Unit", "unit-root", "unit");
  const model: CatalogueModelReference = {
    ...selectionReference("Model", "model-entry", "model"),
    type: "model",
    equipment: [],
  };
  const upgrade = selectionReference("Paid upgrade", "upgrade-entry");
  const result: UnitMappingResult = {
    mapping: {
      ...root,
      categories: [],
      directEquipment: [upgrade],
      models: [model],
      enhancements: {},
      pointsByModelCount: {},
    },
    nodesByEntryPath: new Map([
      ["unit-root", { id: "unit", costs: [] }],
      [
        "model-entry",
        {
          id: "model",
          costs: [{ typeId: "pts", value: 65 }],
        },
      ],
      [
        "upgrade-entry",
        {
          id: "upgrade",
          costs: [{ typeId: "pts", value: 10 }],
        },
      ],
    ]),
  };
  const evaluated = evaluateResolvedPoints(
    result,
    {
      ok: true,
      models: [{ reference: model, count: 2, equipment: [] }],
      directEquipment: [
        {
          itemId: "paid-upgrade",
          name: "Paid upgrade",
          count: 1,
          reference: upgrade,
        },
      ],
    },
    "pts",
    2,
    "primary",
  );
  assert.deepEqual(evaluated, {
    ok: true,
    value: 140,
    unresolvedReasons: [],
  });
});

test("prefers an aggregate unit cost over nested paid equipment", () => {
  const root = selectionReference("Aggregate Unit", "unit-root", "unit");
  const upgrade = selectionReference("Paid default", "upgrade-entry");
  const result: UnitMappingResult = {
    mapping: {
      ...root,
      categories: [],
      directEquipment: [upgrade],
      models: [],
      enhancements: {},
      pointsByModelCount: {},
    },
    nodesByEntryPath: new Map([
      [
        "unit-root",
        {
          id: "unit-root",
          costs: [{ typeId: "pts", value: 300 }],
        },
      ],
      [
        "upgrade-entry",
        {
          id: "upgrade",
          costs: [{ typeId: "pts", value: 30 }],
        },
      ],
    ]),
  };
  assert.deepEqual(
    evaluateResolvedPoints(
      result,
      {
        ok: true,
        models: [],
        directEquipment: [
          {
            itemId: "paid-default",
            name: "Paid default",
            count: 1,
            reference: upgrade,
          },
        ],
      },
      "pts",
      6,
      "primary",
    ),
    {
      ok: true,
      value: 300,
      unresolvedReasons: [],
    },
  );
});

test("evaluates canonical copy-count bands and retains unsupported roster context", () => {
  const root = selectionReference("Band Unit", "unit-root", "unit");
  const mapping: UnitMappingResult = {
    mapping: {
      ...root,
      categories: [],
      directEquipment: [],
      models: [],
      enhancements: {},
      pointsByModelCount: {},
    },
    nodesByEntryPath: new Map([
      [
        "unit-root",
        {
          id: "unit-root",
          costs: [{ typeId: "pts", value: 150 }],
          modifiers: [
            {
              field: "pts",
              type: "increment",
              value: 10,
              conditionGroups: [
                {
                  type: "and",
                  localConditionGroups: [
                    {
                      type: "atLeast",
                      value: 2,
                      field: "selections",
                      scope: "parent",
                      conditions: [
                        {
                          type: "before",
                          value: 1,
                          field: "selections",
                          scope: "self",
                          childId: "any",
                        },
                        {
                          type: "instanceOf",
                          value: 1,
                          field: "selections",
                          scope: "self",
                          childId: "unit-root",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    ]),
  };
  const resolution = {
    ok: true as const,
    models: [],
    directEquipment: [],
  };
  assert.equal(
    (
      evaluateResolvedPoints(
        mapping,
        resolution,
        "pts",
        3,
        "primary",
        1,
      ) as { value: number }
    ).value,
    150,
  );
  assert.equal(
    (
      evaluateResolvedPoints(
        mapping,
        resolution,
        "pts",
        3,
        "primary",
        3,
      ) as { value: number }
    ).value,
    160,
  );

  const unsupported: UnitMappingResult = {
    ...mapping,
    nodesByEntryPath: new Map([
      [
        "unit-root",
        {
          id: "unit-root",
          costs: [{ typeId: "pts", value: 150 }],
          modifiers: [
            {
              field: "pts",
              type: "increment",
              value: 10,
              conditions: [
                {
                  field: "selections",
                  scope: "force",
                  childId: "other-unit",
                  value: 1,
                  type: "atLeast",
                },
              ],
            },
          ],
        },
      ],
    ]),
  };
  const unresolved = evaluateResolvedPoints(
    unsupported,
    resolution,
    "pts",
    3,
    "primary",
    1,
  );
  assert.equal(unresolved.ok, true);
  assert.match(
    unresolved.ok
      ? unresolved.unresolvedReasons.join(" ")
      : "",
    /roster context/,
  );
});

const rosterSelection: RosterConflictInput = {
  factionId: "fixture",
  detachmentId: "fixture-detachment",
  units: [
    {
      unitId: "fixture-unit",
      modelCount: 3,
      ordinal: 2,
      equipment: [
        { itemId: "rifle", name: "Rifle", count: 3 },
      ],
    },
  ],
};

function scopedConflict(
  entityType: DataConflict["entityType"],
  scope: NonNullable<DataConflict["scope"]>,
): DataConflict {
  return {
    id: "fixture-conflict",
    factionId: "fixture",
    entityType,
    entityId:
      entityType === "points"
        ? "fixture-unit:6"
        : "fixture-unit:base:fixture",
    entityName: "Fixture Unit",
    code: "UNMAPPED",
    blocking: true,
    message: "Fixture conflict",
    scope,
  };
}

test("points and base-loadout conflicts apply only to their exact selection", () => {
  assert.equal(
    conflictAppliesToRoster(
      scopedConflict("points", { modelCount: 6 }),
      rosterSelection,
    ),
    false,
  );
  assert.equal(
    conflictAppliesToRoster(
      scopedConflict("points", {
        modelCount: 3,
        unitOrdinalMin: 3,
        unitOrdinalMax: null,
      }),
      rosterSelection,
    ),
    false,
  );
  assert.equal(
    conflictAppliesToRoster(
      scopedConflict("points", {
        modelCount: 3,
        unitOrdinalMin: 1,
        unitOrdinalMax: 2,
      }),
      rosterSelection,
    ),
    true,
  );
  assert.equal(
    conflictAppliesToRoster(
      scopedConflict("points", { modelCount: 3 }),
      rosterSelection,
    ),
    true,
  );
  assert.equal(
    conflictAppliesToRoster(
      {
        ...scopedConflict("points", {}),
        entityId: "fixture-unit:6",
      },
      rosterSelection,
    ),
    false,
  );

  const signature = newRecruitEquipmentSignature(
    rosterSelection.units[0].equipment,
  );
  const baseConflict = scopedConflict("equipment", {
    selectionScopes: [
      { modelCount: 3, equipmentSignature: signature },
    ],
  });
  assert.equal(
    conflictAppliesToRoster(baseConflict, rosterSelection),
    true,
  );
  assert.equal(
    conflictAppliesToRoster(baseConflict, {
      ...rosterSelection,
      units: [
        {
          ...rosterSelection.units[0],
          equipment: [
            { itemId: "pistol", name: "Pistol", count: 3 },
          ],
        },
      ],
    }),
    false,
  );
});

test("pins the six-model Venatari 330 versus 300 conflict before delivery", () => {
  const conflicts =
    newRecruitCatalogue.factions[
      "adeptus-custodes"
    ].conflicts.filter(
      (conflict) =>
        conflict.entityId ===
          "venatari-custodians:6" &&
        conflict.scope?.unitOrdinalMin === 1,
    );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].code, "POINTS_MISMATCH");
  assert.equal(conflicts[0].blocking, true);
  assert.equal(conflicts[0].rulesValue, 330);
  assert.equal(conflicts[0].newRecruitValue, 300);
  assert.equal(conflicts[0].scope?.unitOrdinalMax, 2);
  assert.equal(
    conflicts[0].scope?.equipmentSignature,
    "id:venatari-lance=6",
  );
  assert.ok(
    knownBlockedSelectionExclusions(
      "adeptus-custodes",
    ).some(
      (exclusion) =>
        exclusion.unitId ===
          "venatari-custodians" &&
        exclusion.modelCount === 6 &&
        exclusion.equipmentSignature ===
          "id:venatari-lance=6" &&
        exclusion.unitOrdinalMin === 1 &&
        exclusion.unitOrdinalMax === 2,
    ),
  );
});

test("portfolio retries a safe Venatari loadout instead of discarding the unit", () => {
  const roster = buildExportableRosterCandidate({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    requiredUnitIds: ["venatari-custodians"],
    opponentContext: {
      kind: "known-faction",
      factionId: "astra-militarum",
    },
  });
  assert.ok(roster);
  const selected = roster.units.find(
    (unit) => unit.unitId === "venatari-custodians",
  );
  assert.ok(selected);
  assert.equal(
    selected.equipment.some(
      (equipment) =>
        equipment.itemId === "venatari-lance",
    ),
    false,
  );
  assert.ok(
    selected.equipment.some(
      (equipment) =>
        equipment.itemId === "kinetic-destroyer",
    ),
  );
  assert.equal(
    conflictsForRoster(roster).some(
      (conflict) => conflict.blocking,
    ),
    false,
  );
});
