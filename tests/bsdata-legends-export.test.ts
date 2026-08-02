import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { newRecruitCatalogueMappings } from "../lib/rosterpilot/catalogue";
import type {
  CatalogueSelectionReference,
  NewRecruitConfiguration,
  NewRecruitFactionCatalogue,
} from "../lib/rosterpilot/catalogue-types";
import {
  deriveRosterCompatibilityFactionIdentity,
  resetRosterCompatibilityIdentityCache,
} from "../lib/rosterpilot/draft";
import { buildRoster, exportRoster } from "../lib/rosterpilot/engine";
import {
  activateLegendsInventory,
  resetActiveLegendsInventoryForTests,
} from "../lib/rosterpilot/legends";
import {
  configurationSelections,
  newRecruitRos,
} from "../lib/rosterpilot/new-recruit";
import { normalizeNewRecruitName } from "../lib/rosterpilot/new-recruit-resolver";
import {
  activateRuntimeRulesData,
  createRuntimeDataset,
  resetRuntimeRulesDataForTests,
  serializeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import type { RosterDraftV1 } from "../lib/rosterpilot/types";
import {
  bsdataLegendClassificationSignals,
  buildConfiguration,
  combinedSelectionIndex,
  summarizeManifest,
  type CatalogueDocument,
  type Overrides,
} from "../scripts/sync-bsdata";

afterEach(() => {
  resetRuntimeRulesDataForTests();
  resetActiveLegendsInventoryForTests();
  resetRosterCompatibilityIdentityCache();
});

test("New Recruit summary omits duplicated BSData classification evidence", () => {
  const manifest = structuredClone(newRecruitCatalogueMappings);
  const faction = manifest.factions["adeptus-custodes"];
  assert.ok(faction);
  faction.classificationEvidence = {
    legendCandidates: [
      {
        source: "bsdata",
        name: "Summary-only Legends Fixture",
        normalizedName: "summary only legends fixture",
        catalogueId: faction.catalogue.id,
        catalogueRevision: faction.catalogue.revision,
        targetId: "summary-legends-fixture",
        entryPath: "summary::legends-fixture",
        signals: [
          {
            source: "bsdata",
            classification: "legend",
            kind: "entry-link-name",
            value: "Summary-only Legends Fixture [Legends]",
            entryPath: "summary::legends-fixture",
          },
        ],
      },
    ],
  };

  const summary = summarizeManifest(manifest);
  const summarizedFaction = summary.factions["adeptus-custodes"];
  assert.ok(summarizedFaction);
  assert.equal("classificationEvidence" in summarizedFaction, false);
  assert.ok(faction.classificationEvidence);
});

function reference(
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

function configuration(
  includeLegendsVisibility: boolean,
): NewRecruitConfiguration {
  return {
    category: {
      name: "Configuration",
      entryId: "configuration-category",
      primary: true,
    },
    battleSize: {
      reference: reference("Battle Size", "battle-root"),
      choices: {
        incursion: reference("Incursion", "incursion"),
        "strike-force": reference("Strike Force", "strike-force"),
      },
    },
    detachment: {
      reference: reference("Detachment", "detachment-root"),
      choices: {
        alpha: {
          ...reference("Alpha Host", "alpha-host"),
          detachmentPoints: 0,
        },
      },
    },
    forceDisposition: {
      reference: reference("Force Disposition", "disposition-root"),
      choices: {
        take: reference("Take and Hold", "take-and-hold"),
      },
    },
    ...(includeLegendsVisibility
      ? {
          legendsVisibility: {
            parent: reference(
              "Show/Hide Options",
              "show-hide-link::show-hide-root",
            ),
            choice: reference(
              "Legends are visible",
              "show-hide-link::show-legends-link::show-legends",
            ),
          },
        }
      : {}),
  };
}

function faction(
  includeLegendsVisibility: boolean,
): NewRecruitFactionCatalogue {
  return {
    factionId: "adeptus-custodes",
    factionName: "Adeptus Custodes",
    sourceFile: "fixture.json",
    catalogue: { id: "custodes", name: "Custodes", revision: 1 },
    configuration: configuration(includeLegendsVisibility),
    units: {
      aleya: {
        ...reference("Aleya", "aleya", "unit"),
        categories: [],
        directEquipment: [],
        models: [],
        enhancements: {},
        pointsByModelCount: {},
        classificationSignals: [
          {
            source: "bsdata",
            classification: "legend",
            kind: "entry-link-name",
            value: "Aleya [Legends]",
            entryPath: "aleya",
          },
        ],
      },
    },
    coverage: {
      engineUnits: 1,
      mappedUnits: 1,
      mappedBaseLoadouts: 1,
      engineDetachments: 1,
      mappedDetachments: 1,
      complete: true,
    },
    conflicts: [],
  };
}

function draft(): RosterDraftV1 {
  return {
    id: "legend-export-fixture",
    factionName: "Adeptus Custodes",
    battleSize: "incursion",
    detachmentId: "alpha",
    detachmentName: "Alpha Host",
    forceDispositionId: "take",
    forceDispositionName: "Take and Hold",
    units: [{ unitId: "aleya", name: "Aleya" }],
  } as unknown as RosterDraftV1;
}

function markAleyaAsLegend(): void {
  const rules = serializeRuntimeRulesData();
  const aleya = rules.units.find(
    (unit) =>
      (unit as { id?: string }).id === "aleya",
  ) as { is_legend?: boolean } | undefined;
  assert.ok(aleya);
  aleya.is_legend = true;
  activateRuntimeRulesData(rules);
}

function markUnitAsLegend(unitId: string): void {
  const rules = serializeRuntimeRulesData();
  const unit = rules.units.find(
    (candidate) =>
      (candidate as { id?: string }).id === unitId,
  ) as { is_legend?: boolean } | undefined;
  assert.ok(unit);
  unit.is_legend = true;
  activateRuntimeRulesData(rules);
}

test("BSData labels are evidence only and do not enable Legends visibility", () => {
  const selections = configurationSelections(draft(), faction(true));
  assert.equal(selections.length, 3);
  assert.equal(
    selections.some((selection) => selection.name === "Show/Hide Options"),
    false,
  );
});

test("runtime Legends selections emit the exact visibility branch and fail closed without it", () => {
  markAleyaAsLegend();
  const selections = configurationSelections(draft(), faction(true));
  assert.equal(selections.length, 4);
  const visibility = selections[3];
  assert.equal(visibility.name, "Show/Hide Options");
  assert.equal(
    (visibility.selections as Array<Record<string, unknown>>)[0].name,
    "Legends are visible",
  );

  assert.throws(
    () => configurationSelections(draft(), faction(false)),
    /Legends visibility mapping is unavailable.*Aleya/,
  );
});

test("inherited parent-faction Legends retain visibility identity and export configuration", () => {
  markUnitAsLegend("terminator-squad");
  activateLegendsInventory(
    new Map([
      [
        "blood-angels",
        {
          schemaVersion: 1 as const,
          factionId: "blood-angels",
          coverageStatus: "not-published" as const,
          classificationAuthority:
            "games-workshop-verified" as const,
          sourceArtifacts: [
            {
              sourceId: "blood-angels-legends-status",
              version: "fixture",
              contentSha256: "b".repeat(64),
              url: "https://example.com/blood-angels-legends.pdf",
            },
          ],
          units: [],
        },
      ],
      [
        "adeptus-astartes",
        {
          schemaVersion: 1 as const,
          factionId: "adeptus-astartes",
          coverageStatus: "complete" as const,
          classificationAuthority:
            "games-workshop-verified" as const,
          sourceArtifacts: [
            {
              sourceId: "adeptus-astartes-legends-pack",
              version: "fixture",
              contentSha256: "a".repeat(64),
              url: "https://example.com/adeptus-astartes-legends.pdf",
            },
          ],
          units: [
            {
              legendId:
                "official:adeptus-astartes:terminator-squad",
              factionId: "adeptus-astartes",
              name: "Terminator Squad",
              unitId: "terminator-squad",
              sourceId: "adeptus-astartes-legends-pack",
              buildSupported: true,
            },
          ],
        },
      ],
    ]),
  );

  const built = buildRoster({
    faction: "blood-angels",
    pointsLimit: 1_000,
    legendsPolicy: "allow",
    requiredUnitIds: ["terminator-squad"],
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(built.data);
  assert.ok(
    built.data.sourceData.entityHashes[
      "mapping:configuration:legends-visibility"
    ],
  );

  const bloodAngels =
    newRecruitCatalogueMappings.factions["blood-angels"];
  assert.ok(bloodAngels?.configuration?.legendsVisibility);
  const selections = configurationSelections(
    built.data,
    bloodAngels,
  );
  assert.equal(
    selections.some(
      (selection) => selection.name === "Show/Hide Options",
    ),
    true,
  );
  const ros = newRecruitRos(built.data);
  assert.match(ros, /name="Show\/Hide Options"/);
  assert.match(ros, /name="Legends are visible"/);

  const withoutVisibility = structuredClone(bloodAngels);
  assert.ok(withoutVisibility.configuration);
  delete withoutVisibility.configuration.legendsVisibility;
  assert.throws(
    () => configurationSelections(built.data!, withoutVisibility),
    /Legends visibility mapping is unavailable.*Terminator Squad/,
  );
});

test("ROS export reports a dedicated failure when Legends visibility is unavailable", async () => {
  const custodes =
    newRecruitCatalogueMappings.factions["adeptus-custodes"];
  assert.ok(custodes?.configuration);
  const originalVisibility =
    custodes.configuration.legendsVisibility;
  delete custodes.configuration.legendsVisibility;
  try {
    markAleyaAsLegend();
    activateLegendsInventory(
      new Map([
        [
          "adeptus-custodes",
          {
            schemaVersion: 1 as const,
            factionId: "adeptus-custodes",
            coverageStatus: "complete" as const,
            classificationAuthority:
              "games-workshop-verified" as const,
            sourceArtifacts: [
              {
                sourceId: "custodes-legends-pack",
                version: "fixture",
                contentSha256: "a".repeat(64),
                url: "https://example.com/custodes-legends.pdf",
              },
            ],
            units: [
              {
                legendId: "official:adeptus-custodes:aleya",
                factionId: "adeptus-custodes",
                name: "Aleya",
                unitId: "aleya",
                sourceId: "custodes-legends-pack",
                buildSupported: true,
              },
            ],
          },
        ],
      ]),
    );
    const built = buildRoster({
      faction: "adeptus-custodes",
      pointsLimit: 1_000,
      legendsPolicy: "allow",
      requiredUnitIds: ["aleya"],
    });
    assert.equal(
      built.ok,
      true,
      built.violations.map((violation) => violation.message).join("; "),
    );
    assert.ok(built.data);

    const exported = await exportRoster(built.data, "ros");
    assert.equal(exported.ok, false);
    assert.ok(
      exported.violations.some(
        (violation) =>
          violation.code ===
          "NEW_RECRUIT_LEGENDS_CONFIGURATION_UNAVAILABLE",
      ),
    );
  } finally {
    if (originalVisibility) {
      custodes.configuration.legendsVisibility = originalVisibility;
    } else {
      delete custodes.configuration.legendsVisibility;
    }
  }
});

test("the BSData reconciler resolves Show/Hide Options through the linked Legends choice", () => {
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
      {
        id: "show-hide-root",
        name: "Show/Hide Options",
        type: "upgrade",
        entryLinks: [
          {
            id: "show-legends-link",
            name: "Show Legends",
            type: "selectionEntry",
            targetId: "show-legends",
          },
        ],
      },
      {
        id: "show-legends",
        name: "Show Legends",
        type: "upgrade",
        categoryLinks: [
          {
            targetId: "configuration-category",
            name: "Configuration",
            primary: true,
          },
        ],
      },
    ],
  };
  const primary: CatalogueDocument = {
    file: "Fixture.json",
    id: "fixture",
    name: "Fixture",
    root: {
      id: "fixture",
      name: "Fixture",
      revision: 1,
      entryLinks: [
        {
          id: "detachment-link",
          name: "Detachment",
          type: "selectionEntry",
          targetId: "detachment-root",
        },
        {
          id: "show-hide-link",
          name: "Show/Hide Options",
          type: "selectionEntry",
          targetId: "show-hide-root",
        },
      ],
      sharedSelectionEntries: [
        {
          id: "detachment-root",
          name: "Detachment",
          type: "upgrade",
          categoryLinks: [
            {
              targetId: "configuration-category",
              name: "Configuration",
              primary: true,
            },
          ],
          selectionEntryGroups: [
            {
              id: "detachment-group",
              name: "Detachment",
              selectionEntries: [
                { id: "alpha", name: "Alpha Host", type: "upgrade" },
              ],
            },
          ],
        },
      ],
    },
  };
  const overrides: Overrides = {
    schemaVersion: 2,
    factionCatalogues: {},
    unitAliases: {},
    detachmentAliases: {},
    enhancementAliases: {},
    exactPathOverrides: { units: {}, detachments: {} },
  };
  const conflicts: Parameters<typeof buildConfiguration>[7] = [];
  const result = buildConfiguration(
    primary,
    [primary],
    gameSystem,
    combinedSelectionIndex([primary], gameSystem),
    [
      {
        id: "alpha",
        name: "Alpha Host",
        detachment_points: 0,
      },
    ] as Parameters<typeof buildConfiguration>[4],
    overrides,
    "detachment-points",
    conflicts,
    "fixture-faction",
  );

  assert.ok(result?.legendsVisibility);
  assert.equal(
    result.legendsVisibility.parent.entryId,
    "show-hide-link::show-hide-root",
  );
  assert.equal(
    result.legendsVisibility.choice.entryId,
    "show-hide-link::show-legends-link::show-legends",
  );
  assert.equal(result.legendsVisibility.choice.name, "Legends are visible");
});

test("classification hints are conservative while visibility and candidate evidence have explicit mapping semantics", () => {
  assert.deepEqual(
    bsdataLegendClassificationSignals(
      { name: "Relic Unit [Legends]" },
      {
        name: "Relic Unit",
        modifiers: [{ comment: "Legends" }],
      },
      "relic-unit",
    ).map((signal) => signal.kind),
    ["entry-link-name", "modifier-comment"],
  );
  assert.deepEqual(
    bsdataLegendClassificationSignals(
      { name: "Legends of Saga and Song" },
      { name: "Legends of Saga and Song" },
      "not-a-legend-marker",
    ),
    [],
  );

  const source = createRuntimeDataset(serializeRuntimeRulesData());
  const first = structuredClone(newRecruitCatalogueMappings);
  const firstConfiguration =
    first.factions["adeptus-custodes"]?.configuration;
  assert.ok(firstConfiguration);
  firstConfiguration.legendsVisibility = {
    parent: reference("Show/Hide Options", "visibility-parent-a"),
    choice: reference("Legends are visible", "visibility-choice-a"),
  };
  const firstFaction = first.factions["adeptus-custodes"];
  assert.ok(firstFaction);
  firstFaction.classificationEvidence = {
    legendCandidates: [
      {
        source: "bsdata",
        name: "Legacy Custodian",
        normalizedName: "legacy custodian",
        catalogueId: "custodes",
        catalogueRevision: 1,
        targetId: "legacy-custodian-a",
        entryPath: "legacy-custodian-link::legacy-custodian-a",
        signals: [
          {
            source: "bsdata",
            classification: "legend",
            kind: "entry-link-name",
            value: "Legacy Custodian [Legends]",
            entryPath: "legacy-custodian-link::legacy-custodian-a",
          },
        ],
      },
    ],
  };
  const second = structuredClone(first);
  const secondConfiguration =
    second.factions["adeptus-custodes"]?.configuration;
  assert.ok(secondConfiguration?.legendsVisibility);
  secondConfiguration.legendsVisibility.choice.entryId =
    "visibility-choice-b";
  const secondCandidate =
    second.factions["adeptus-custodes"]?.classificationEvidence
      ?.legendCandidates[0];
  assert.ok(secondCandidate);
  secondCandidate.targetId = "legacy-custodian-b";

  const firstIdentity = deriveRosterCompatibilityFactionIdentity({
    source,
    catalogue: first,
    factionId: "adeptus-custodes",
  });
  const secondIdentity = deriveRosterCompatibilityFactionIdentity({
    source,
    catalogue: second,
    factionId: "adeptus-custodes",
  });
  assert.notEqual(
    firstIdentity.entityHashes[
      "mapping:configuration:legends-visibility"
    ],
    secondIdentity.entityHashes[
      "mapping:configuration:legends-visibility"
    ],
  );
  assert.notEqual(
    firstIdentity.entityHashes[
      "mapping:classification-evidence:legends"
    ],
    secondIdentity.entityHashes[
      "mapping:classification-evidence:legends"
    ],
  );
  assert.notEqual(firstIdentity.mappingHash, secondIdentity.mappingHash);
});

test("unit classification signals do not change mapping compatibility", () => {
  const source = createRuntimeDataset(serializeRuntimeRulesData());
  const first = structuredClone(newRecruitCatalogueMappings);
  const firstAleya =
    first.factions["adeptus-custodes"]?.units.aleya;
  assert.ok(firstAleya);
  firstAleya.classificationSignals = [
    {
      source: "bsdata",
      classification: "legend",
      kind: "entry-link-name",
      value: "Aleya [Legends]",
      entryPath: "aleya-link::aleya",
    },
  ];
  const second = structuredClone(first);
  const secondSignal =
    second.factions["adeptus-custodes"]?.units.aleya
      ?.classificationSignals?.[0];
  assert.ok(secondSignal);
  secondSignal.value = "Aleya [Legacy Legends label]";
  secondSignal.entryPath = "updated-aleya-link::aleya";

  const firstIdentity = deriveRosterCompatibilityFactionIdentity({
    source,
    catalogue: first,
    factionId: "adeptus-custodes",
  });
  const secondIdentity = deriveRosterCompatibilityFactionIdentity({
    source,
    catalogue: second,
    factionId: "adeptus-custodes",
  });
  assert.equal(
    firstIdentity.entityHashes["mapping:unit:aleya:base"],
    secondIdentity.entityHashes["mapping:unit:aleya:base"],
  );
  assert.equal(firstIdentity.mappingHash, secondIdentity.mappingHash);
});
