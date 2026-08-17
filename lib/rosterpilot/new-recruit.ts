import {
  getNewRecruitFactionCatalogue,
  newRecruitCatalogueMappings,
} from "./catalogue";
import { conflictsForRoster } from "./catalogue-summary";
import type {
  CatalogueSelectionReference,
  NewRecruitFactionCatalogue,
} from "./catalogue-types";
import {
  isUnitSizeLoadoutChoice,
  normalizeNewRecruitName,
  resolveNewRecruitUnit,
  type ResolvedModelReference,
} from "./new-recruit-resolver";
import { dataset, factions, units } from "./runtime-dataset";
import type { DraftUnit, RosterDraftV1 } from "./types";

type XmlNode = Record<string, unknown>;

const XML_COLLECTION_NAMES: Record<string, string> = {
  categories: "category",
  costs: "cost",
  forces: "force",
  selections: "selection",
};

function deterministicId(parts: Array<string | number>): string {
  let hash = 2166136261;
  for (const character of parts.join("|")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `rp-${(hash >>> 0).toString(36)}`;
}

function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serializeXmlNode(tag: string, node: XmlNode): string {
  const attributes: string[] = [];
  const children: string[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const childTag = XML_COLLECTION_NAMES[key] ?? key.replace(/s$/, "");
      children.push(
        `<${key}>${value
          .map((child) => serializeXmlNode(childTag, child as XmlNode))
          .join("")}</${key}>`,
      );
      continue;
    }
    if (typeof value === "object") {
      children.push(serializeXmlNode(key, value as XmlNode));
      continue;
    }
    attributes.push(`${key}="${escapeXml(value)}"`);
  }

  const open = attributes.length ? `<${tag} ${attributes.join(" ")}>` : `<${tag}>`;
  return children.length
    ? `${open}${children.join("")}</${tag}>`
    : `${open.slice(0, -1)} />`;
}

function selectionFromReference(
  reference: CatalogueSelectionReference,
  id: string,
  number: number,
): XmlNode {
  return {
    id,
    name: reference.name,
    entryId: reference.entryId,
    ...(reference.entryGroupId
      ? {
          entryGroupId: reference.entryGroupId,
          group: reference.group,
          from: "group",
        }
      : { from: "entry" }),
    number,
    type: reference.type,
  };
}

type ResolvedEquipment = {
  itemId: string;
  count: number;
  reference: CatalogueSelectionReference;
};

export function unitSizeLoadoutChoices(
  models: ResolvedModelReference[],
): CatalogueSelectionReference[] {
  const choices = new Map<string, CatalogueSelectionReference>();
  for (const model of models) {
    for (const item of model.equipment) {
      const choice = item.reference.loadoutChoice;
      if (!choice || !isUnitSizeLoadoutChoice(choice.name)) continue;
      choices.set(choice.entryId, choice);
    }
  }
  return [...choices.values()].sort(
    (left, right) =>
      left.normalizedName.localeCompare(right.normalizedName) ||
      left.entryId.localeCompare(right.entryId),
  );
}

function equipmentSelections(
  equipment: ResolvedEquipment[],
  idParts: Array<string | number>,
  omitChoiceIds: ReadonlySet<string> = new Set(),
): XmlNode[] {
  const result: XmlNode[] = [];
  const choices = new Map<
    string,
    {
      reference: NonNullable<CatalogueSelectionReference["loadoutChoice"]>;
      children: XmlNode[];
    }
  >();
  for (const item of equipment) {
    const child = selectionFromReference(
      item.reference,
      deterministicId([...idParts, item.itemId, item.reference.entryId]),
      item.count,
    );
    const choice = item.reference.loadoutChoice;
    if (!choice || omitChoiceIds.has(choice.entryId)) {
      result.push(child);
      continue;
    }
    const existing = choices.get(choice.entryId);
    if (existing) {
      existing.children.push(child);
      continue;
    }
    const grouped = { reference: choice, children: [child] };
    choices.set(choice.entryId, grouped);
    result.push({
      ...selectionFromReference(
        choice,
        deterministicId([...idParts, "loadout-choice", choice.entryId]),
        1,
      ),
      selections: grouped.children,
    });
  }
  return result;
}

function uniqueLeaderModelIndex(
  unitId: string,
  models: ResolvedModelReference[],
): number {
  const unit = units.getAny(unitId);
  const composition = unit
    ? dataset.unitCompositionOf(unit.raw)
    : undefined;
  const leaderNames = (composition?.models ?? [])
    .filter((model) => model.is_leader_model === true)
    .map((model) => normalizeNewRecruitName(model.name));
  if (leaderNames.length === 0) return -1;
  const indexes = models.flatMap((model, index) => {
    const actual = normalizeNewRecruitName(model.reference.name);
    return leaderNames.some(
      (expected) =>
        actual === expected ||
        actual.startsWith(`${expected} `) ||
        expected.startsWith(`${actual} `),
    )
      ? [index]
      : [];
  });
  return indexes.length === 1 ? indexes[0] : -1;
}

function unitInFactionAncestry(
  unitId: string,
  factionId: string,
) {
  const seen = new Set<string>();
  let current = factions.get(factionId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const unit = units.getInFaction(unitId, current.id);
    if (unit) return unit;
    const parentId = current.raw.parent_faction_id;
    current = parentId ? factions.get(parentId) : undefined;
  }
  return undefined;
}

function rosterUnitSelection(
  selection: DraftUnit,
  faction: NewRecruitFactionCatalogue,
): XmlNode {
  const mapping = faction.units[selection.unitId];
  if (!mapping) {
    throw new Error(
      `New Recruit catalogue mapping is unavailable for ${selection.name} (${selection.unitId}).`,
    );
  }

  const children: XmlNode[] = [];
  if (selection.isWarlord && !mapping.warlord) {
    throw new Error(
      `New Recruit Warlord mapping is unavailable for ${selection.name}.`,
    );
  }
  const warlordSelection = selection.isWarlord && mapping.warlord
    ? selectionFromReference(
        mapping.warlord,
        deterministicId([selection.selectionId, "warlord"]),
        1,
      )
    : null;
  if (selection.enhancementId) {
    const enhancement = mapping.enhancements[selection.enhancementId];
    if (!enhancement) {
      throw new Error(
        `New Recruit enhancement mapping is unavailable for ${
          selection.enhancementName ?? selection.enhancementId
        }.`,
      );
    }
    children.push(
      selectionFromReference(
        enhancement,
        deterministicId([
          selection.selectionId,
          "enhancement",
          selection.enhancementId,
        ]),
        1,
      ),
    );
  }

  const resolution = resolveNewRecruitUnit(mapping, selection);
  if (!resolution.ok) {
    throw new Error(resolution.reason);
  }
  const sizeChoices = unitSizeLoadoutChoices(resolution.models);
  const sizeChoiceIds = new Set(
    sizeChoices.map((choice) => choice.entryId),
  );
  const modelNodes: XmlNode[] = resolution.models.map(
    (model, modelIndex) => ({
      ...selectionFromReference(
        model.reference,
        deterministicId([
          selection.selectionId,
          "model",
          model.reference.entryId,
          modelIndex,
        ]),
        model.count,
      ),
      selections: equipmentSelections(
        model.equipment,
        [selection.selectionId, "model-equipment", modelIndex],
        sizeChoiceIds,
      ),
    }),
  );
  const leaderIndex = uniqueLeaderModelIndex(
    selection.unitId,
    resolution.models,
  );
  if (warlordSelection && leaderIndex >= 0) {
    const leader = modelNodes[leaderIndex];
    const existing = Array.isArray(leader.selections)
      ? leader.selections
      : [];
    leader.selections = [warlordSelection, ...existing];
  } else if (warlordSelection) {
    children.push(warlordSelection);
  }
  if (sizeChoices.length === 1) {
    children.push({
      ...selectionFromReference(
        sizeChoices[0],
        deterministicId([
          selection.selectionId,
          "unit-size",
          sizeChoices[0].entryId,
        ]),
        1,
      ),
      selections: modelNodes,
    });
  } else {
    children.push(
      ...sizeChoices.map((choice) =>
        selectionFromReference(
          choice,
          deterministicId([
            selection.selectionId,
            "unit-size",
            choice.entryId,
          ]),
          1,
        ),
      ),
      ...modelNodes,
    );
  }
  children.push(
    ...equipmentSelections(
      resolution.directEquipment,
      [selection.selectionId, "direct-equipment"],
      sizeChoiceIds,
    ),
  );

  return {
    id: deterministicId([selection.selectionId, "new-recruit"]),
    name: mapping.name,
    entryId: mapping.entryId,
    number: 1,
    type: mapping.type,
    from: "entry",
    costs: [
      {
        name: "pts",
        typeId: newRecruitCatalogueMappings.gameSystem.pointsTypeId,
        value: selection.points,
      },
    ],
    categories: mapping.categories.map((category) => ({
      id: category.entryId,
      entryId: category.entryId,
      name: category.name,
      primary: category.primary,
    })),
    selections: children,
  };
}

export function configurationSelections(
  draft: RosterDraftV1,
  faction: NewRecruitFactionCatalogue,
): XmlNode[] {
  const configuration = faction.configuration;
  if (!configuration) {
    throw new Error(
      `New Recruit configuration mapping is unavailable for ${draft.factionName}.`,
    );
  }
  const battleSize = configuration.battleSize.choices[draft.battleSize];
  const detachment = configuration.detachment.choices[draft.detachmentId];
  const detachmentRoot =
    detachment?.rootReference ?? configuration.detachment.reference;
  const disposition =
    configuration.forceDisposition.choices[draft.forceDispositionId];
  if (!battleSize) {
    throw new Error(
      `New Recruit battle-size mapping is unavailable for ${draft.battleSize}.`,
    );
  }
  if (!detachment) {
    throw new Error(
      `New Recruit detachment mapping is unavailable for ${draft.detachmentName}.`,
    );
  }
  if (!disposition) {
    throw new Error(
      `New Recruit force-disposition mapping is unavailable for ${draft.forceDispositionName}.`,
    );
  }
  const category = {
    id: configuration.category.entryId,
    entryId: configuration.category.entryId,
    name: configuration.category.name,
    primary: true,
  };
  const selectedLegendUnits = (draft.units ?? []).filter(
    (selection) =>
      unitInFactionAncestry(
        selection.unitId,
        draft.factionId ?? faction.factionId,
      )?.raw.is_legend === true,
  );
  if (
    selectedLegendUnits.length > 0 &&
    !configuration.legendsVisibility
  ) {
    throw new Error(
      `New Recruit Legends visibility mapping is unavailable for selected Legends unit${
        selectedLegendUnits.length === 1 ? "" : "s"
      }: ${selectedLegendUnits.map((unit) => unit.name).join(", ")}.`,
    );
  }

  const selections: XmlNode[] = [
    {
      ...selectionFromReference(
        configuration.battleSize.reference,
        deterministicId([draft.id, "battle-size"]),
        1,
      ),
      categories: [category],
      selections: [
        {
          ...selectionFromReference(
            battleSize,
            deterministicId([draft.id, "battle-size", draft.battleSize]),
            1,
          ),
          costs: [
            {
              name: "pts",
              typeId: newRecruitCatalogueMappings.gameSystem.pointsTypeId,
              value: 0,
            },
          ],
        },
      ],
    },
    {
      ...selectionFromReference(
        detachmentRoot,
        deterministicId([draft.id, "detachment"]),
        1,
      ),
      categories: [category],
      selections: [
        {
          ...selectionFromReference(
            detachment,
            deterministicId([draft.id, "detachment", draft.detachmentId]),
            1,
          ),
          costs: [
            {
              name: "Detachment Points",
              typeId:
                newRecruitCatalogueMappings.gameSystem.detachmentPointsTypeId,
              value: detachment.detachmentPoints,
            },
          ],
        },
      ],
    },
    {
      ...selectionFromReference(
        configuration.forceDisposition.reference,
        deterministicId([draft.id, "force-disposition"]),
        1,
      ),
      categories: [category],
      selections: [
        selectionFromReference(
          disposition,
          deterministicId([
            draft.id,
            "force-disposition",
            draft.forceDispositionId,
          ]),
          1,
        ),
      ],
    },
  ];
  if (selectedLegendUnits.length > 0) {
    const visibility = configuration.legendsVisibility;
    if (!visibility) {
      throw new Error(
        "New Recruit Legends visibility mapping became unavailable during export.",
      );
    }
    selections.push({
      ...selectionFromReference(
        visibility.parent,
        deterministicId([draft.id, "legends-visibility"]),
        1,
      ),
      categories: [category],
      selections: [
        {
          ...selectionFromReference(
            visibility.choice,
            deterministicId([
              draft.id,
              "legends-visibility",
              visibility.choice.entryId,
            ]),
            1,
          ),
          categories: [{ ...category, primary: false }],
        },
      ],
    });
  }
  return selections;
}

export function newRecruitRos(draft: RosterDraftV1): string {
  const faction = getNewRecruitFactionCatalogue(draft.factionId);
  if (!faction || !faction.catalogue.id) {
    throw new Error(
      `New Recruit catalogue mapping is unavailable for ${draft.factionName}.`,
    );
  }
  const conflicts = conflictsForRoster(draft).filter((item) => item.blocking);
  if (conflicts.length > 0) {
    throw new Error(
      `New Recruit export is blocked by ${conflicts.length} data-source conflict${
        conflicts.length === 1 ? "" : "s"
      }: ${conflicts
        .slice(0, 3)
        .map((item) => item.message)
        .join(" ")}`,
    );
  }
  const gameSystem = newRecruitCatalogueMappings.gameSystem;
  const roster: XmlNode = {
    id: deterministicId([draft.id, "roster"]),
    name: draft.name,
    battleScribeVersion: gameSystem.battleScribeVersion,
    generatedBy: "RosterPilot",
    gameSystemId: gameSystem.id,
    gameSystemName: gameSystem.name,
    gameSystemRevision: gameSystem.revision,
    xmlns: gameSystem.xmlns,
    costs: [
      {
        name: "pts",
        typeId: gameSystem.pointsTypeId,
        value: draft.totalPoints,
      },
    ],
    forces: [
      {
        id: deterministicId([draft.id, "force"]),
        name: "Army Roster",
        entryId: gameSystem.forceEntryId,
        catalogueId: faction.catalogue.id,
        catalogueRevision: faction.catalogue.revision,
        catalogueName: faction.catalogue.name,
        selections: [
          ...configurationSelections(draft, faction),
          ...draft.units.map((selection) =>
            rosterUnitSelection(selection, faction),
          ),
        ],
      },
    ],
  };

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXmlNode("roster", roster)}`;
}
