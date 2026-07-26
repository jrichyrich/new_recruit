import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  baseLoadout,
  dataset,
  detachments,
  enhancements,
  factions,
  forceDispositions,
  normalizeName,
  units,
} from "@alpaca-software/40kdc-data";

import type {
  CatalogueCategoryReference,
  CatalogueModelReference,
  CatalogueSelectionReference,
  CatalogueUnitReference,
  DataConflict,
  NewRecruitCatalogueManifest,
  NewRecruitCatalogueSummaryManifest,
  NewRecruitConfiguration,
  NewRecruitFactionCatalogue,
} from "../lib/rosterpilot/catalogue-types";
import {
  resolveNewRecruitUnit,
  type NewRecruitUnitInput,
} from "../lib/rosterpilot/new-recruit-resolver";

type JsonRecord = Record<string, unknown>;

type SourceManifest = {
  schemaVersion: 1;
  releaseId: string;
  rules: {
    package: "@alpaca-software/40kdc-data";
    version: string;
    edition: "11th";
    dataslate: string;
  };
  newRecruit: {
    repository: "BSData/wh40k-11e";
    url: string;
    branch: string;
    commit: string;
  };
  official: NewRecruitCatalogueManifest["sources"]["official"];
};

type Overrides = {
  schemaVersion: 1;
  factionCatalogues: Record<string, string>;
  unitAliases: Record<string, string>;
  detachmentAliases: Record<string, string>;
  enhancementAliases: Record<string, string>;
};

type CatalogueDocument = {
  file: string;
  root: JsonRecord;
  id: string;
  name: string;
};

type SelectionIndex = {
  entries: Map<string, JsonRecord>;
  groups: Map<string, JsonRecord>;
};

type UnitCandidate = {
  document: CatalogueDocument;
  rootLink: JsonRecord;
  target: JsonRecord;
};

type WalkedSelection = {
  reference: CatalogueSelectionReference;
  node: JsonRecord;
  modelId?: string;
};

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourcesPath = path.join(projectRoot, "data", "sources.json");
const overridesPath = path.join(projectRoot, "data", "bsdata-overrides.json");
const outputPath = path.join(
  projectRoot,
  "data",
  "generated",
  "new-recruit-catalogues.json",
);
const summaryOutputPath = path.join(
  projectRoot,
  "data",
  "generated",
  "new-recruit-summary.json",
);

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => record(item) !== undefined)
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readJson<T>(filename: string): T {
  return JSON.parse(readFileSync(filename, "utf8")) as T;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function entryType(value: unknown): "model" | "unit" | "upgrade" {
  return value === "model" || value === "unit" ? value : "upgrade";
}

function joinEntryId(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join("::");
}

function selectionReference(
  node: JsonRecord,
  entryId: string,
  group?: JsonRecord,
): CatalogueSelectionReference {
  const name = text(node.name) ?? text(node.id) ?? "Unnamed selection";
  const groupId = text(group?.id);
  return {
    name,
    normalizedName: normalizeName(name),
    type: entryType(node.type),
    entryId,
    ...(groupId
      ? {
          entryGroupId: groupId,
          group: text(group?.name) ?? "Options",
        }
      : {}),
  };
}

function localSelectionIndex(root: JsonRecord): SelectionIndex {
  const entries = new Map<string, JsonRecord>();
  const groups = new Map<string, JsonRecord>();
  const visited = new Set<JsonRecord>();

  const visit = (node: JsonRecord) => {
    if (visited.has(node)) return;
    visited.add(node);

    for (const entry of [
      ...records(node.sharedSelectionEntries),
      ...records(node.selectionEntries),
    ]) {
      const id = text(entry.id);
      if (id) entries.set(id, entry);
      visit(entry);
    }
    for (const group of [
      ...records(node.sharedSelectionEntryGroups),
      ...records(node.selectionEntryGroups),
    ]) {
      const id = text(group.id);
      if (id) groups.set(id, group);
      visit(group);
    }
  };

  visit(root);
  return { entries, groups };
}

function dependencyDocuments(
  primary: CatalogueDocument,
  byId: Map<string, CatalogueDocument>,
): CatalogueDocument[] {
  const result: CatalogueDocument[] = [];
  const seen = new Set<string>();
  const visit = (document: CatalogueDocument) => {
    if (seen.has(document.id)) return;
    seen.add(document.id);
    result.push(document);
    for (const link of records(document.root.catalogueLinks)) {
      const targetId = text(link.targetId);
      const target = targetId ? byId.get(targetId) : undefined;
      if (target) visit(target);
    }
  };
  visit(primary);
  return result;
}

function combinedSelectionIndex(
  documents: CatalogueDocument[],
  gameSystem: JsonRecord,
): SelectionIndex {
  const indexes = [
    ...documents.map((document) => localSelectionIndex(document.root)),
    localSelectionIndex(gameSystem),
  ];
  const entries = new Map<string, JsonRecord>();
  const groups = new Map<string, JsonRecord>();
  for (const index of indexes.reverse()) {
    for (const [id, entry] of index.entries) entries.set(id, entry);
    for (const [id, group] of index.groups) groups.set(id, group);
  }
  return { entries, groups };
}

function resolveLink(
  link: JsonRecord,
  index: SelectionIndex,
): { target: JsonRecord; kind: "entry" | "group" } | undefined {
  const targetId = text(link.targetId);
  if (!targetId) return undefined;
  if (link.type === "selectionEntryGroup") {
    const target = index.groups.get(targetId);
    return target ? { target, kind: "group" } : undefined;
  }
  const target = index.entries.get(targetId);
  return target ? { target, kind: "entry" } : undefined;
}

function walkSelections(
  node: JsonRecord,
  rootPrefix: string,
  index: SelectionIndex,
  currentModelId?: string,
  linkedPrefix = rootPrefix,
  currentGroup?: JsonRecord,
  result: WalkedSelection[] = [],
  visited = new Set<string>(),
): WalkedSelection[] {
  for (const entry of records(node.selectionEntries)) {
    const id = text(entry.id);
    if (!id) continue;
    const reference = selectionReference(
      entry,
      joinEntryId(linkedPrefix, id),
      currentGroup
        ? {
            ...currentGroup,
            id: joinEntryId(rootPrefix, text(currentGroup.id)),
          }
        : undefined,
    );
    const modelId =
      reference.type === "model" ? id : currentModelId;
    result.push({ reference, node: entry, ...(modelId ? { modelId } : {}) });
    walkSelections(
      entry,
      rootPrefix,
      index,
      modelId,
      linkedPrefix,
      undefined,
      result,
      visited,
    );
  }

  for (const group of records(node.selectionEntryGroups)) {
    for (const entry of records(group.selectionEntries)) {
      const id = text(entry.id);
      if (!id) continue;
      const reference = selectionReference(entry, joinEntryId(linkedPrefix, id), {
        ...group,
        id: joinEntryId(rootPrefix, text(group.id)),
      });
      const modelId =
        reference.type === "model" ? id : currentModelId;
      result.push({ reference, node: entry, ...(modelId ? { modelId } : {}) });
      walkSelections(
        entry,
        rootPrefix,
        index,
        modelId,
        linkedPrefix,
        undefined,
        result,
        visited,
      );
    }
    walkSelections(
      group,
      rootPrefix,
      index,
      currentModelId,
      linkedPrefix,
      undefined,
      result,
      visited,
    );
  }

  for (const link of records(node.entryLinks)) {
    const linkId = text(link.id);
    const targetId = text(link.targetId);
    if (!linkId || !targetId) continue;
    const resolved = resolveLink(link, index);
    if (!resolved) continue;
    const visitKey = `${linkedPrefix}\0${linkId}\0${targetId}\0${currentModelId ?? ""}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    const nextPrefix = joinEntryId(linkedPrefix, linkId);
    if (resolved.kind === "entry") {
      const reference = selectionReference(
        resolved.target,
        joinEntryId(nextPrefix, targetId),
        currentGroup
          ? {
              ...currentGroup,
              id: joinEntryId(rootPrefix, text(currentGroup.id)),
            }
          : undefined,
      );
      const modelId =
        reference.type === "model" ? targetId : currentModelId;
      result.push({
        reference,
        node: resolved.target,
        ...(modelId ? { modelId } : {}),
      });
      walkSelections(
        resolved.target,
        rootPrefix,
        index,
        modelId,
        nextPrefix,
        undefined,
        result,
        visited,
      );
    } else {
      for (const entry of records(resolved.target.selectionEntries)) {
        const id = text(entry.id);
        if (!id) continue;
        const reference = selectionReference(entry, joinEntryId(nextPrefix, id), {
          ...resolved.target,
          id: joinEntryId(rootPrefix, linkId),
        });
        const modelId =
          reference.type === "model" ? id : currentModelId;
        result.push({
          reference,
          node: entry,
          ...(modelId ? { modelId } : {}),
        });
        walkSelections(
          entry,
          rootPrefix,
          index,
          modelId,
          nextPrefix,
          undefined,
          result,
          visited,
        );
      }
    }
  }
  return result;
}

function pointValues(node: JsonRecord, pointsTypeId: string): number[] {
  const values = new Set<number>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const item = record(value);
    if (!item) return;
    for (const cost of records(item.costs)) {
      if (cost.typeId === pointsTypeId) {
        const amount = numberValue(cost.value);
        if (amount !== undefined) values.add(amount);
      }
    }
    for (const modifier of records(item.modifiers)) {
      if (
        modifier.field === pointsTypeId &&
        (modifier.type === "set" || modifier.type === "increment")
      ) {
        const amount = numberValue(modifier.value);
        if (amount !== undefined) values.add(amount);
      }
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(node);
  return [...values].sort((left, right) => left - right);
}

function categoryReferences(node: JsonRecord): CatalogueCategoryReference[] {
  return records(node.categoryLinks)
    .map((link) => {
      const entryId = text(link.targetId);
      const name = text(link.name);
      if (!entryId || !name) return undefined;
      return {
        name,
        entryId,
        primary: link.primary === true,
      };
    })
    .filter(
      (item): item is CatalogueCategoryReference => item !== undefined,
    );
}

function unitMapping(
  candidate: UnitCandidate,
  index: SelectionIndex,
  pointsTypeId: string,
  relevantEnhancements: Map<string, string>,
  relevantEquipment: Set<string>,
): CatalogueUnitReference {
  const rootId = text(candidate.rootLink.id) as string;
  const targetId = text(candidate.target.id) as string;
  const rootReference = selectionReference(
    candidate.target,
    joinEntryId(rootId, targetId),
  );
  const walked = walkSelections(candidate.target, rootId, index);
  const modelItems = walked.filter(
    (item) => item.reference.type === "model",
  );
  const modelById = new Map<string, CatalogueModelReference>();
  for (const item of modelItems) {
    const modelId = item.modelId;
    if (!modelId || modelById.has(modelId)) continue;
    modelById.set(modelId, {
      ...item.reference,
      type: "model",
      equipment: [],
    });
  }
  for (const item of walked) {
    if (
      item.reference.type !== "upgrade" ||
      !item.modelId ||
      !relevantEquipment.has(item.reference.normalizedName)
    ) {
      continue;
    }
    modelById.get(item.modelId)?.equipment.push(item.reference);
  }

  const directEquipment = walked
    .filter(
      (item) =>
        item.reference.type === "upgrade" &&
        !item.modelId &&
        relevantEquipment.has(item.reference.normalizedName),
    )
    .map((item) => item.reference);
  const warlord = walked.find(
    (item) => item.reference.normalizedName === "warlord",
  )?.reference;
  const enhancementReferences: Record<string, CatalogueSelectionReference> = {};
  for (const [enhancementId, normalizedName] of relevantEnhancements) {
    const matches = walked.filter(
      (item) =>
        item.reference.type === "upgrade" &&
        item.reference.normalizedName === normalizedName,
    );
    if (matches.length === 1) {
      enhancementReferences[enhancementId] = matches[0].reference;
    }
  }
  const points = pointValues(candidate.target, pointsTypeId);
  return {
    ...rootReference,
    categories: categoryReferences(candidate.target),
    directEquipment: deduplicateReferences(directEquipment),
    models: [...modelById.values()].map((model) => ({
      ...model,
      equipment: deduplicateReferences(model.equipment),
    })),
    ...(warlord ? { warlord } : {}),
    enhancements: enhancementReferences,
    pointsByModelCount: Object.fromEntries(
      points.map((value) => [String(value), value]),
    ),
  };
}

function deduplicateReferences(
  references: CatalogueSelectionReference[],
): CatalogueSelectionReference[] {
  const result = new Map<string, CatalogueSelectionReference>();
  for (const reference of references) {
    result.set(`${reference.entryId}\0${reference.normalizedName}`, reference);
  }
  return [...result.values()].sort(
    (left, right) =>
      left.normalizedName.localeCompare(right.normalizedName) ||
      left.entryId.localeCompare(right.entryId),
  );
}

function factionUnitPool(factionId: string) {
  const result = [];
  const seen = new Set<string>();
  let current = factions.get(factionId);
  while (current) {
    for (const unit of units.byFaction(current.id)) {
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      result.push(unit);
    }
    const parentId = current.raw.parent_faction_id;
    current = parentId ? factions.get(parentId) : undefined;
  }
  return result;
}

function factionDetachments(factionId: string) {
  const result = [];
  const seen = new Set<string>();
  let current = factions.get(factionId);
  while (current) {
    for (const detachment of detachments.byFaction(current.id)) {
      if (seen.has(detachment.id)) continue;
      seen.add(detachment.id);
      if (
        !detachment.game_modes ||
        detachment.game_modes.includes("matched-play")
      ) {
        result.push(detachment);
      }
    }
    const parentId = current.raw.parent_faction_id;
    current = parentId ? factions.get(parentId) : undefined;
  }
  return result;
}

function modelCounts(unit: ReturnType<typeof units.get>): number[] {
  if (!unit) return [];
  const values = new Set<number>();
  for (const tier of unit.raw.points ?? []) {
    values.add(tier.models);
    if (tier.models_max) values.add(tier.models_max);
  }
  if (values.size === 0) values.add(unit.raw.model_count?.min ?? 1);
  return [...values].sort((left, right) => left - right);
}

function equipmentName(unit: NonNullable<ReturnType<typeof units.get>>, id: string) {
  return (
    unit.weapons.find((candidate) => candidate.id === id)?.name ??
    dataset.weapons.all.find(
      (candidate) =>
        candidate.id === id &&
        candidate.raw.faction_id === unit.raw.faction_id,
    )?.name ??
    dataset.wargear.all.find((candidate) => candidate.id === id)?.name ??
    id
  );
}

function baseSelections(
  unit: NonNullable<ReturnType<typeof units.get>>,
): NewRecruitUnitInput[] {
  const composition = dataset.unitCompositionOf(unit.raw);
  return modelCounts(unit).map((count) => {
    const loadout = baseLoadout(
      unit.raw,
      count,
      dataset.wargearOptionsOf(unit.raw),
      composition?.models,
    );
    return {
      unitId: unit.id,
      name: unit.name,
      modelCount: count,
      equipment: [...loadout.counts.entries()]
        .filter(([, amount]) => amount > 0)
        .map(([itemId, amount]) => ({
          itemId,
          name: equipmentName(unit, itemId),
          count: amount,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  });
}

function validEquipment(
  unit: NonNullable<ReturnType<typeof units.get>>,
): Array<{ itemId: string; name: string; normalizedName: string }> {
  const ids = new Set(unit.raw.weapon_ids ?? []);
  for (const option of dataset.wargearOptionsOf(unit.raw)) {
    for (const id of option.replaces ?? []) ids.add(id);
    for (const id of option.replacement ?? []) ids.add(id);
    for (const branch of option.replacement_choice ?? []) {
      for (const id of branch) ids.add(id);
    }
  }
  for (const model of dataset.unitCompositionOf(unit.raw)?.models ?? []) {
    for (const id of model.default_weapon_ids ?? []) ids.add(id);
  }
  return [...ids]
    .map((itemId) => {
      const name = equipmentName(unit, itemId);
      return { itemId, name, normalizedName: normalizeName(name) };
    })
    .sort(
      (left, right) =>
        left.normalizedName.localeCompare(right.normalizedName) ||
        left.itemId.localeCompare(right.itemId),
    );
}

function conflict(
  factionId: string,
  entityType: DataConflict["entityType"],
  entityId: string,
  entityName: string,
  code: DataConflict["code"],
  message: string,
  values: Pick<DataConflict, "rulesValue" | "newRecruitValue"> = {},
): DataConflict {
  return {
    id: sha256(
      [factionId, entityType, entityId, code, message].join("\0"),
    ).slice(0, 16),
    factionId,
    entityType,
    entityId,
    entityName,
    code,
    blocking: true,
    message,
    ...values,
  };
}

function buildConfiguration(
  primary: CatalogueDocument,
  documents: CatalogueDocument[],
  gameSystem: JsonRecord,
  index: SelectionIndex,
  engineDetachments: ReturnType<typeof factionDetachments>,
  overrides: Overrides,
  pointsTypeId: string,
  detachmentPointsTypeId: string,
  conflicts: DataConflict[],
  factionId: string,
): NewRecruitConfiguration | null {
  const configurationCategory = records(gameSystem.categoryEntries).find(
    (entry) => normalizeName(text(entry.name) ?? "") === "configuration",
  );
  const globalLinks = records(gameSystem.entryLinks);
  const battleLink = globalLinks.find(
    (link) => normalizeName(text(link.name) ?? "") === "battle size",
  );
  const dispositionLink = globalLinks.find(
    (link) => normalizeName(text(link.name) ?? "") === "force disposition",
  );
  const detachmentCandidates = documents.flatMap((document) =>
    records(document.root.entryLinks)
      .filter(
        (link) =>
          ["detachment", "detachments"].includes(
            normalizeName(text(link.name) ?? ""),
          ),
      )
      .map((link) => ({ document, link })),
  );
  const detachmentRoot = detachmentCandidates[0];
  const resolvedBattle = battleLink ? resolveLink(battleLink, index) : undefined;
  const resolvedDisposition = dispositionLink
    ? resolveLink(dispositionLink, index)
    : undefined;
  const resolvedDetachment = detachmentRoot
    ? resolveLink(detachmentRoot.link, index)
    : undefined;

  if (
    !configurationCategory ||
    !battleLink ||
    !dispositionLink ||
    !detachmentRoot ||
    resolvedBattle?.kind !== "entry" ||
    resolvedDisposition?.kind !== "entry" ||
    resolvedDetachment?.kind !== "entry"
  ) {
    conflicts.push(
      conflict(
        factionId,
        "catalogue",
        primary.id,
        primary.name,
        "UNSUPPORTED",
        "The Battle Size, Detachments, or Force Disposition configuration tree could not be resolved.",
      ),
    );
    return null;
  }

  const battleRootId = text(battleLink.id) as string;
  const battleTargetId = text(resolvedBattle.target.id) as string;
  const battleGroups = records(resolvedBattle.target.selectionEntryGroups);
  const battleChoices = battleGroups.flatMap((group) =>
    records(group.selectionEntries).map((entry) => ({ group, entry })),
  );
  const battleChoice = (
    normalized: string,
  ): CatalogueSelectionReference | undefined => {
    const found = battleChoices.find(({ entry }) =>
      normalizeName(text(entry.name) ?? "").includes(normalized),
    );
    if (!found) return undefined;
    return selectionReference(
      found.entry,
      joinEntryId(battleRootId, text(found.entry.id)),
      {
        ...found.group,
        id: joinEntryId(battleRootId, text(found.group.id)),
      },
    );
  };
  const incursion = battleChoice("incursion");
  const strikeForce = battleChoice("strike force");

  const dispositionRootId = text(dispositionLink.id) as string;
  const dispositionTargetId = text(resolvedDisposition.target.id) as string;
  const dispositionWalk = walkSelections(
    resolvedDisposition.target,
    dispositionRootId,
    index,
  );
  const dispositionChoices: Record<string, CatalogueSelectionReference> = {};
  for (const disposition of forceDispositions.all) {
    const match = dispositionWalk.find(
      (item) =>
        item.reference.normalizedName === normalizeName(disposition.name),
    );
    if (match) dispositionChoices[disposition.id] = match.reference;
  }

  const detachmentRootId = text(detachmentRoot.link.id) as string;
  const detachmentTargetId = text(resolvedDetachment.target.id) as string;
  const directDetachmentGroups = records(
    resolvedDetachment.target.selectionEntryGroups,
  ).map((group) => ({
    group,
    entryPrefix: detachmentRootId,
    groupId: joinEntryId(detachmentRootId, text(group.id)),
  }));
  const linkedDetachmentGroups = records(
    resolvedDetachment.target.entryLinks,
  ).flatMap((link) => {
    const linkName = normalizeName(text(link.name) ?? "");
    const linkId = text(link.id);
    const resolved = resolveLink(link, index);
    if (
      !["detachment", "detachments"].includes(linkName) ||
      !linkId ||
      resolved?.kind !== "group"
    ) {
      return [];
    }
    return [
      {
        group: resolved.target,
        entryPrefix: joinEntryId(detachmentRootId, linkId),
        groupId: joinEntryId(detachmentRootId, linkId),
      },
    ];
  });
  const detachmentEntries = [
    ...directDetachmentGroups,
    ...linkedDetachmentGroups,
  ].flatMap(({ group, entryPrefix, groupId }) =>
    records(group.selectionEntries).map((entry) => ({
      group,
      entry,
      entryPrefix,
      groupId,
    })),
  );
  const detachmentChoices: NewRecruitConfiguration["detachment"]["choices"] =
    {};
  for (const detachment of engineDetachments) {
    const alias =
      overrides.detachmentAliases[`${factionId}:${detachment.id}`] ??
      detachment.name;
    const matches = detachmentEntries.filter(
      ({ entry }) =>
        normalizeName(text(entry.name) ?? "") === normalizeName(alias),
    );
    if (matches.length !== 1) {
      conflicts.push(
        conflict(
          factionId,
          "detachment",
          detachment.id,
          detachment.name,
          matches.length === 0 ? "UNMAPPED" : "AMBIGUOUS",
          `${detachment.name} matched ${matches.length} New Recruit detachment entries.`,
        ),
      );
      continue;
    }
    const { entry, group, entryPrefix, groupId } = matches[0];
    const dp =
      records(entry.costs).find(
        (cost) => cost.typeId === detachmentPointsTypeId,
      )?.value ?? detachment.detachment_points ?? 0;
    detachmentChoices[detachment.id] = {
      ...selectionReference(
        entry,
        joinEntryId(entryPrefix, text(entry.id)),
        {
          ...group,
          id: groupId,
        },
      ),
      detachmentPoints: numberValue(dp) ?? 0,
    };
  }

  if (!incursion || !strikeForce) {
    conflicts.push(
      conflict(
        factionId,
        "catalogue",
        primary.id,
        primary.name,
        "UNSUPPORTED",
        "Incursion or Strike Force battle-size selections are unavailable.",
      ),
    );
    return null;
  }

  return {
    category: {
      name: text(configurationCategory.name) as string,
      entryId: text(configurationCategory.id) as string,
      primary: true,
    },
    battleSize: {
      reference: selectionReference(
        resolvedBattle.target,
        joinEntryId(battleRootId, battleTargetId),
      ),
      choices: { incursion, "strike-force": strikeForce },
    },
    detachment: {
      reference: selectionReference(
        resolvedDetachment.target,
        joinEntryId(detachmentRootId, detachmentTargetId),
      ),
      choices: detachmentChoices,
    },
    forceDisposition: {
      reference: selectionReference(
        resolvedDisposition.target,
        joinEntryId(dispositionRootId, dispositionTargetId),
      ),
      choices: dispositionChoices,
    },
  };
}

function generate(
  checkout: string,
  source: SourceManifest,
  overrides: Overrides,
): NewRecruitCatalogueManifest {
  const gameSystemDocument = readJson<{ gameSystem: JsonRecord }>(
    path.join(checkout, "Warhammer 40,000.json"),
  );
  const gameSystem = gameSystemDocument.gameSystem;
  const gameSystemId = text(gameSystem.id);
  const gameSystemName = text(gameSystem.name);
  const gameSystemRevision = numberValue(gameSystem.revision);
  const battleScribeVersion =
    text(gameSystem.battleScribeVersion) ??
    numberValue(gameSystem.battleScribeVersion)?.toFixed(2);
  const xmlns = "http://www.battlescribe.net/schema/rosterSchema";
  const forceEntry = records(gameSystem.forceEntries).find(
    (entry) => normalizeName(text(entry.name) ?? "") === "army roster",
  );
  const pointsType = records(gameSystem.costTypes).find(
    (cost) => normalizeName(text(cost.name) ?? "") === "pts",
  );
  const detachmentPointsType = records(gameSystem.costTypes).find(
    (cost) =>
      normalizeName(text(cost.name) ?? "") === "detachment points",
  );
  const forceEntryId = text(forceEntry?.id);
  const pointsTypeId = text(pointsType?.id);
  const detachmentPointsTypeId = text(detachmentPointsType?.id);
  if (
    !gameSystemId ||
    !gameSystemName ||
    gameSystemRevision === undefined ||
    !battleScribeVersion ||
    !xmlns ||
    !forceEntryId ||
    !pointsTypeId ||
    !detachmentPointsTypeId
  ) {
    throw new Error("The BSData game-system contract is incomplete.");
  }

  const documents = readdirSync(checkout)
    .filter(
      (filename) =>
        filename.endsWith(".json") && filename !== "Warhammer 40,000.json",
    )
    .map((file): CatalogueDocument | undefined => {
      const payload = readJson<{ catalogue?: JsonRecord }>(
        path.join(checkout, file),
      );
      const root = payload.catalogue;
      const id = text(root?.id);
      const name = text(root?.name);
      return root && id && name ? { file, root, id, name } : undefined;
    })
    .filter(
      (document): document is CatalogueDocument => document !== undefined,
    );
  const byId = new Map(documents.map((document) => [document.id, document]));
  const byFile = new Map(
    documents.map((document) => [document.file, document]),
  );
  const factionResults: Record<string, NewRecruitFactionCatalogue> = {};

  for (const faction of [...factions.all].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const sourceFile = overrides.factionCatalogues[faction.id];
    const primary = sourceFile ? byFile.get(sourceFile) : undefined;
    const conflicts: DataConflict[] = [];
    const engineUnits = factionUnitPool(faction.id);
    const engineDetachments = factionDetachments(faction.id);
    if (!primary) {
      conflicts.push(
        conflict(
          faction.id,
          "catalogue",
          faction.id,
          faction.name,
          "MISSING_CATALOGUE",
          `No BSData catalogue is configured for ${faction.name}.`,
        ),
      );
      factionResults[faction.id] = {
        factionId: faction.id,
        factionName: faction.name,
        sourceFile: sourceFile ?? "",
        catalogue: { id: "", name: "", revision: 0 },
        configuration: null,
        units: {},
        coverage: {
          engineUnits: engineUnits.length,
          mappedUnits: 0,
          mappedBaseLoadouts: 0,
          engineDetachments: engineDetachments.length,
          mappedDetachments: 0,
          complete: false,
        },
        conflicts,
      };
      continue;
    }

    const availableDocuments = dependencyDocuments(primary, byId);
    const shared = combinedSelectionIndex(availableDocuments, gameSystem);
    const unitCandidates = new Map<string, UnitCandidate[]>();
    for (const document of availableDocuments) {
      const local = localSelectionIndex(document.root);
      for (const link of records(document.root.entryLinks)) {
        if (link.type !== "selectionEntry") continue;
        const targetId = text(link.targetId);
        const target = targetId
          ? local.entries.get(targetId) ?? shared.entries.get(targetId)
          : undefined;
        if (!target) continue;
        const name = text(target.name) ?? text(link.name);
        if (!name) continue;
        const key = normalizeName(name);
        const values = unitCandidates.get(key) ?? [];
        values.push({ document, rootLink: link, target });
        unitCandidates.set(key, values);
      }
    }

    const relevantEnhancements = new Map<string, string>();
    for (const detachment of engineDetachments) {
      for (const enhancementId of detachment.enhancement_ids ?? []) {
        const entity = enhancements.get(enhancementId);
        if (entity) {
          const alias =
            overrides.enhancementAliases[
              `${faction.id}:${enhancementId}`
            ] ?? entity.name;
          relevantEnhancements.set(enhancementId, normalizeName(alias));
        }
      }
    }

    const mappedUnits: Record<string, CatalogueUnitReference> = {};
    let mappedBaseLoadouts = 0;
    for (const unit of engineUnits) {
      const alias =
        overrides.unitAliases[`${faction.id}:${unit.id}`] ?? unit.name;
      const candidates = unitCandidates.get(normalizeName(alias)) ?? [];
      const preferred = candidates.filter(
        (candidate) => candidate.document.id === primary.id,
      );
      const selected =
        preferred.length === 1
          ? preferred[0]
          : candidates.length === 1
            ? candidates[0]
            : undefined;
      if (!selected) {
        conflicts.push(
          conflict(
            faction.id,
            "unit",
            unit.id,
            unit.name,
            candidates.length === 0 ? "UNMAPPED" : "AMBIGUOUS",
            `${unit.name} matched ${candidates.length} New Recruit unit entries in ${primary.name} and its imports.`,
          ),
        );
        continue;
      }
      const equipment = validEquipment(unit);
      const mapping = unitMapping(
        selected,
        shared,
        pointsTypeId,
        relevantEnhancements,
        new Set(equipment.map((item) => item.normalizedName)),
      );
      const baseResolutions = baseSelections(unit).map((selection) => ({
        selection,
        resolution: resolveNewRecruitUnit(mapping, selection),
      }));
      const supportsBase = baseResolutions.every(
        ({ resolution }) => resolution.ok,
      );
      if (supportsBase) {
        mappedBaseLoadouts += 1;
      } else {
        const failure = baseResolutions.find(
          ({ resolution }) => !resolution.ok,
        );
        conflicts.push(
          conflict(
            faction.id,
            "equipment",
            unit.id,
            unit.name,
            "UNMAPPED",
            `At least one deterministic ${unit.name} base loadout cannot be represented in the New Recruit catalogue. ${
              failure && !failure.resolution.ok
                ? failure.resolution.reason
                : ""
            }`.trim(),
          ),
        );
      }

      const availableEquipment = new Set([
        ...mapping.directEquipment.map(
          (reference) => reference.normalizedName,
        ),
        ...mapping.models.flatMap((model) =>
          model.equipment.map((reference) => reference.normalizedName),
        ),
      ]);
      for (const item of equipment) {
        if (availableEquipment.has(item.normalizedName)) continue;
        conflicts.push(
          conflict(
            faction.id,
            "equipment",
            `${unit.id}:${item.itemId}`,
            `${unit.name}: ${item.name}`,
            "UNMAPPED",
            `${item.name} for ${unit.name} is legal in 40kdc but has no New Recruit catalogue selection.`,
          ),
        );
      }

      const bsdataPoints = new Set(
        Object.values(mapping.pointsByModelCount),
      );
      for (const tier of unit.raw.points ?? []) {
        if (
          (tier.unit_count_min ?? 1) > 1 ||
          tier.cost <= 0 ||
          bsdataPoints.size === 0
        ) {
          continue;
        }
        if (!bsdataPoints.has(tier.cost)) {
          conflicts.push(
            conflict(
              faction.id,
              "points",
              `${unit.id}:${tier.models}`,
              unit.name,
              "POINTS_MISMATCH",
              `${unit.name} (${tier.models} models) is ${tier.cost} points in 40kdc but that value is absent from its New Recruit entry.`,
              {
                rulesValue: tier.cost,
                newRecruitValue: [...bsdataPoints].join(", "),
              },
            ),
          );
        }
      }
      mappedUnits[unit.id] = mapping;
    }

    const configuration = buildConfiguration(
      primary,
      availableDocuments,
      gameSystem,
      shared,
      engineDetachments,
      overrides,
      pointsTypeId,
      detachmentPointsTypeId,
      conflicts,
      faction.id,
    );
    const mappedDetachments = configuration
      ? Object.keys(configuration.detachment.choices).length
      : 0;
    const complete =
      Object.keys(mappedUnits).length === engineUnits.length &&
      mappedBaseLoadouts === engineUnits.length &&
      mappedDetachments === engineDetachments.length &&
      configuration !== null &&
      conflicts.length === 0;

    factionResults[faction.id] = {
      factionId: faction.id,
      factionName: faction.name,
      sourceFile: primary.file,
      catalogue: {
        id: primary.id,
        name: primary.name,
        revision: numberValue(primary.root.revision) ?? 0,
      },
      configuration,
      units: Object.fromEntries(
        Object.entries(mappedUnits).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      coverage: {
        engineUnits: engineUnits.length,
        mappedUnits: Object.keys(mappedUnits).length,
        mappedBaseLoadouts,
        engineDetachments: engineDetachments.length,
        mappedDetachments,
        complete,
      },
      conflicts: conflicts.sort(
        (left, right) =>
          left.entityType.localeCompare(right.entityType) ||
          left.entityName.localeCompare(right.entityName) ||
          left.code.localeCompare(right.code),
      ),
    };
  }

  const generatedAt = execFileSync(
    "git",
    ["show", "-s", "--format=%cI", source.newRecruit.commit],
    { cwd: checkout, encoding: "utf8" },
  ).trim();
  const allFactions = Object.values(factionResults);
  return {
    schemaVersion: 1,
    releaseId: source.releaseId,
    generatedAt,
    sources: {
      rules: source.rules,
      newRecruit: {
        repository: source.newRecruit.repository,
        branch: source.newRecruit.branch,
        commit: source.newRecruit.commit,
      },
      official: source.official,
    },
    gameSystem: {
      id: gameSystemId,
      name: gameSystemName,
      revision: gameSystemRevision,
      battleScribeVersion,
      forceEntryId,
      pointsTypeId,
      detachmentPointsTypeId,
      xmlns,
    },
    factions: factionResults,
    summary: {
      factionCount: allFactions.length,
      exportCapableFactions: allFactions.filter(
        (faction) =>
          faction.configuration !== null &&
          faction.coverage.mappedUnits > 0 &&
          faction.coverage.mappedDetachments > 0,
      ).length,
      completeFactions: allFactions.filter(
        (faction) => faction.coverage.complete,
      ).length,
      engineUnits: allFactions.reduce(
        (sum, faction) => sum + faction.coverage.engineUnits,
        0,
      ),
      mappedUnits: allFactions.reduce(
        (sum, faction) => sum + faction.coverage.mappedUnits,
        0,
      ),
      mappedBaseLoadouts: allFactions.reduce(
        (sum, faction) => sum + faction.coverage.mappedBaseLoadouts,
        0,
      ),
      conflicts: allFactions.reduce(
        (sum, faction) => sum + faction.conflicts.length,
        0,
      ),
      blockingConflicts: allFactions.reduce(
        (sum, faction) =>
          sum + faction.conflicts.filter((item) => item.blocking).length,
        0,
      ),
    },
  };
}

function summarizeManifest(
  manifest: NewRecruitCatalogueManifest,
): NewRecruitCatalogueSummaryManifest {
  return {
    ...manifest,
    factions: Object.fromEntries(
      Object.entries(manifest.factions).map(([factionId, faction]) => {
        const { configuration, units: _units, ...summary } = faction;
        void _units;
        return [
          factionId,
          {
            ...summary,
            configurationAvailable: configuration !== null,
          },
        ];
      }),
    ),
  };
}

function parseArguments() {
  const args = process.argv.slice(2);
  const valueAfter = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    checkout: valueAfter("--checkout"),
    commit: valueAfter("--commit"),
    latest: args.includes("--latest"),
    write: args.includes("--write"),
    check: args.includes("--check") || !args.includes("--write"),
  };
}

function withCheckout<T>(
  source: SourceManifest,
  requestedPath: string | undefined,
  latest: boolean,
  action: (checkout: string, commit: string) => T,
): T {
  if (requestedPath) {
    const checkout = path.resolve(requestedPath);
    if (!statSync(checkout).isDirectory()) {
      throw new Error(`BSData checkout is not a directory: ${checkout}`);
    }
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
    }).trim();
    return action(checkout, commit);
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), "rosterpilot-bsdata-"));
  const checkout = path.join(temporary, "wh40k-11e");
  try {
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        source.newRecruit.url,
        checkout,
      ],
      { stdio: "inherit" },
    );
    const commit = latest
      ? execFileSync("git", ["rev-parse", source.newRecruit.branch], {
          cwd: checkout,
          encoding: "utf8",
        }).trim()
      : source.newRecruit.commit;
    execFileSync("git", ["checkout", "--quiet", commit], { cwd: checkout });
    return action(checkout, commit);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const argumentsValue = parseArguments();
const source = readJson<SourceManifest>(sourcesPath);
const overrides = readJson<Overrides>(overridesPath);
withCheckout(
  source,
  argumentsValue.checkout,
  argumentsValue.latest,
  (checkout, actualCommit) => {
    const requestedCommit = argumentsValue.commit ?? source.newRecruit.commit;
    if (!argumentsValue.latest && actualCommit !== requestedCommit) {
      throw new Error(
        `BSData checkout is ${actualCommit}; expected ${requestedCommit}.`,
      );
    }
    if (argumentsValue.latest && actualCommit !== source.newRecruit.commit) {
      throw new Error(
        `Latest BSData commit is ${actualCommit}; update data/sources.json before writing generated data.`,
      );
    }
    const manifest = generate(checkout, source, overrides);
    const output = stableJson(manifest);
    const summaryOutput = stableJson(summarizeManifest(manifest));
    if (argumentsValue.write) {
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, output);
      writeFileSync(summaryOutputPath, summaryOutput);
    }
    if (argumentsValue.check) {
      const existing = readFileSync(outputPath, "utf8");
      const existingSummary = readFileSync(summaryOutputPath, "utf8");
      if (existing !== output || existingSummary !== summaryOutput) {
        throw new Error(
          "Generated New Recruit catalogue data is stale. Run npm run data:sync.",
        );
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          releaseId: manifest.releaseId,
          commit: manifest.sources.newRecruit.commit,
          ...manifest.summary,
          outputs: [
            path.relative(projectRoot, outputPath),
            path.relative(projectRoot, summaryOutputPath),
          ],
        },
        null,
        2,
      )}\n`,
    );
  },
);
