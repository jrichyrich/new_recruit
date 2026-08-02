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
  baseUnitPoints,
  dataset,
  detachments,
  enhancements,
  factions,
  forceDispositions,
  units,
  wargearPoints,
} from "@alpaca-software/40kdc-data";

import type {
  CatalogueCategoryReference,
  CatalogueClassificationSignal,
  CatalogueLegendCandidateEvidence,
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
  newRecruitEquipmentSignature,
  normalizeNewRecruitName,
  resolveNewRecruitUnit,
  type NewRecruitUnitResolution,
  type NewRecruitUnitInput,
} from "../lib/rosterpilot/new-recruit-resolver";

export type JsonRecord = Record<string, unknown>;

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

export type Overrides = {
  schemaVersion: 1 | 2;
  factionCatalogues: Record<string, string>;
  unitAliases: Record<string, string>;
  detachmentAliases: Record<string, string>;
  enhancementAliases: Record<string, string>;
  exactPathOverrides?: {
    units?: Record<string, ExactPathOverride>;
    detachments?: Record<string, ExactPathOverride>;
  };
};

export type ExactPathOverride = {
  catalogueId: string;
  catalogueRevision: number;
  entryPath: string;
};

export type CatalogueDocument = {
  file: string;
  root: JsonRecord;
  id: string;
  name: string;
};

export type SelectionIndex = {
  entries: Map<string, JsonRecord>;
  groups: Map<string, JsonRecord>;
};

type UnitCandidate = {
  document: CatalogueDocument;
  rootLink: JsonRecord;
  target: JsonRecord;
  entryPath: string;
};

export type WalkedSelection = {
  reference: CatalogueSelectionReference;
  node: JsonRecord;
  modelId?: string;
  ancestorEntryIds: string[];
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
    normalizedName: normalizeNewRecruitName(name),
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

function hasBracketedLegendMarker(value: string | undefined): boolean {
  return value !== undefined && /\[\s*legends?\s*\]\s*$/i.test(value);
}

function withoutBracketedLegendMarker(value: string): string {
  return value.replace(/\s*\[\s*legends?\s*\]\s*$/i, "").trim();
}

function rootLegendModifierComments(node: JsonRecord): string[] {
  const queue = [
    ...records(node.modifiers),
    ...records(node.modifierGroups),
  ];
  const comments = new Set<string>();
  while (queue.length > 0) {
    const candidate = queue.shift() as JsonRecord;
    const comment = text(candidate.comment);
    if (
      comment &&
      ["legend", "legends"].includes(normalizeNewRecruitName(comment))
    ) {
      comments.add(comment);
    }
    queue.push(
      ...records(candidate.modifiers),
      ...records(candidate.modifierGroups),
    );
  }
  return [...comments].sort();
}

/**
 * Retains conservative BSData-authored hints as mapping evidence. The runtime
 * rules source, not these labels, decides whether the unit is a Legend.
 */
export function bsdataLegendClassificationSignals(
  rootLink: JsonRecord,
  target: JsonRecord,
  entryPath: string,
): CatalogueClassificationSignal[] {
  const signals: CatalogueClassificationSignal[] = [];
  const add = (
    kind: CatalogueClassificationSignal["kind"],
    value: string | undefined,
  ) => {
    if (!value) return;
    signals.push({
      source: "bsdata",
      classification: "legend",
      kind,
      value,
      entryPath,
    });
  };
  const linkName = text(rootLink.name);
  if (hasBracketedLegendMarker(linkName)) {
    add("entry-link-name", linkName);
  }
  const targetName = text(target.name);
  if (hasBracketedLegendMarker(targetName)) {
    add("selection-entry-name", targetName);
  }
  for (const category of records(target.categoryLinks)) {
    const categoryName = text(category.name);
    if (
      categoryName &&
      ["legend", "legends"].includes(
        normalizeNewRecruitName(categoryName),
      )
    ) {
      add("category", categoryName);
    }
  }
  for (const comment of rootLegendModifierComments(target)) {
    add("modifier-comment", comment);
  }
  return signals.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.value.localeCompare(right.value),
  );
}

function bsdataLegendCandidateEvidence(
  candidate: UnitCandidate,
): CatalogueLegendCandidateEvidence | undefined {
  const signals = bsdataLegendClassificationSignals(
    candidate.rootLink,
    candidate.target,
    candidate.entryPath,
  );
  const targetId = text(candidate.target.id);
  const name = text(candidate.target.name) ?? text(candidate.rootLink.name);
  if (signals.length === 0 || !targetId || !name) return undefined;
  return {
    source: "bsdata",
    name,
    normalizedName: normalizeNewRecruitName(
      withoutBracketedLegendMarker(name),
    ),
    catalogueId: candidate.document.id,
    catalogueRevision:
      numberValue(candidate.document.root.revision) ?? 0,
    targetId,
    entryPath: candidate.entryPath,
    signals,
  };
}

export function localSelectionIndex(root: JsonRecord): SelectionIndex {
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

export function combinedSelectionIndex(
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

export function walkSelections(
  node: JsonRecord,
  rootPrefix: string,
  index: SelectionIndex,
  currentModelId?: string,
  linkedPrefix = rootPrefix,
  currentGroup?: JsonRecord,
  result: WalkedSelection[] = [],
  visited = new Set<string>(),
  ancestorEntryIds: string[] = [],
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
      reference.type === "model" ? reference.entryId : currentModelId;
    result.push({
      reference,
      node: entry,
      ...(modelId ? { modelId } : {}),
      ancestorEntryIds,
    });
    walkSelections(
      entry,
      rootPrefix,
      index,
      modelId,
      linkedPrefix,
      undefined,
      result,
      visited,
      reference.type === "upgrade"
        ? [...ancestorEntryIds, reference.entryId]
        : ancestorEntryIds,
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
        reference.type === "model" ? reference.entryId : currentModelId;
      result.push({
        reference,
        node: entry,
        ...(modelId ? { modelId } : {}),
        ancestorEntryIds,
      });
      walkSelections(
        entry,
        rootPrefix,
        index,
        modelId,
        linkedPrefix,
        undefined,
        result,
        visited,
        reference.type === "upgrade"
          ? [...ancestorEntryIds, reference.entryId]
          : ancestorEntryIds,
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
      ancestorEntryIds,
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
        reference.type === "model" ? reference.entryId : currentModelId;
      result.push({
        reference,
        node: resolved.target,
        ...(modelId ? { modelId } : {}),
        ancestorEntryIds,
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
        reference.type === "upgrade"
          ? [...ancestorEntryIds, reference.entryId]
          : ancestorEntryIds,
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
          reference.type === "model" ? reference.entryId : currentModelId;
        result.push({
          reference,
          node: entry,
          ...(modelId ? { modelId } : {}),
          ancestorEntryIds,
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
          reference.type === "upgrade"
            ? [...ancestorEntryIds, reference.entryId]
            : ancestorEntryIds,
        );
      }
    }
  }
  return result;
}

/**
 * BSData can encode fixed weapon bundles as sibling loadout entries. When two
 * siblings repeat the same weapon name, a flat name lookup is ambiguous even
 * though the complete selected loadout identifies exactly one sibling. Retain
 * the first divergent ancestor as branch context so the runtime resolver can
 * choose the coherent set without a catalogue-specific override.
 */
export function choiceAwareEquipmentReferences(
  items: WalkedSelection[],
): CatalogueSelectionReference[] {
  const itemsByName = new Map<string, WalkedSelection[]>();
  for (const item of items) {
    const name = item.reference.normalizedName;
    itemsByName.set(name, [...(itemsByName.get(name) ?? []), item]);
  }

  const choiceIds = new Set<string>();
  for (const sameNameItems of itemsByName.values()) {
    const distinctItems = [
      ...new Map(
        sameNameItems.map((item) => [item.reference.entryId, item]),
      ).values(),
    ];
    if (distinctItems.length < 2) continue;
    const paths = distinctItems.map((item) => item.ancestorEntryIds);
    const sharedLength = Math.min(...paths.map((item) => item.length));
    for (let index = 0; index < sharedLength; index += 1) {
      const values = new Set(paths.map((item) => item[index]));
      if (values.size < 2) continue;
      for (const item of paths) choiceIds.add(item[index]);
      break;
    }
  }

  return items.map((item) => {
    const loadoutChoiceId = item.ancestorEntryIds
      .filter((entryId) => choiceIds.has(entryId))
      .at(-1);
    return loadoutChoiceId
      ? { ...item.reference, loadoutChoiceId }
      : item.reference;
  });
}

export type UnitMappingResult = {
  mapping: CatalogueUnitReference;
  nodesByEntryPath: Map<string, JsonRecord>;
};

export type EvaluatedPoints =
  | { ok: true; value: number; unresolvedReasons: string[] }
  | { ok: false; reason: string };

function numericConditionMatches(
  type: unknown,
  actual: number,
  expected: number,
): boolean | undefined {
  switch (type) {
    case "atLeast":
      return actual >= expected;
    case "atMost":
      return actual <= expected;
    case "greaterThan":
      return actual > expected;
    case "lessThan":
      return actual < expected;
    case "equalTo":
      return actual === expected;
    case "notEqualTo":
      return actual !== expected;
    default:
      return undefined;
  }
}

type PointEvaluationContext = {
  nodeId: string | undefined,
  modelCount: number,
  unitOrdinal: number,
  primaryCatalogueId: string;
  selectedCountsByNodeId: Map<string, number>;
};

function pointConditionMatches(
  condition: JsonRecord,
  context: PointEvaluationContext,
): boolean | undefined {
  if (condition.field !== "selections") return undefined;
  const scope = text(condition.scope);
  const childId = text(condition.childId);
  const expected = numberValue(condition.value);
  if (!scope || !childId || expected === undefined) return undefined;

  let actual: number | undefined;
  if (scope === "primary-catalogue" && condition.type === "instanceOf") {
    actual = childId === context.primaryCatalogueId ? 1 : 0;
  } else if (scope === "self" || scope === context.nodeId) {
    actual =
      childId === "model"
        ? context.modelCount
        : context.selectedCountsByNodeId.get(childId) ?? 0;
  }
  if (actual === undefined) return undefined;
  if (condition.type === "instanceOf") return actual >= expected;
  return numericConditionMatches(condition.type, actual, expected);
}

function combineConditionResults(
  operator: string,
  results: Array<boolean | undefined>,
): boolean | undefined {
  if (results.length === 0) return true;
  if (operator === "or") {
    if (results.some((result) => result === true)) return true;
    return results.some((result) => result === undefined)
      ? undefined
      : false;
  }
  if (results.some((result) => result === false)) return false;
  return results.some((result) => result === undefined)
    ? undefined
    : true;
}

function pointConditionGroupMatches(
  group: JsonRecord,
  context: PointEvaluationContext,
): boolean | undefined {
  if (records(group.repeats).length > 0) return undefined;
  const localResults = records(group.localConditionGroups).map(
    (localGroup) => {
      const expected = numberValue(localGroup.value);
      const conditions = records(localGroup.conditions);
      const sameUnit = conditions.some(
        (condition) =>
          condition.field === "selections" &&
          condition.scope === "self" &&
          condition.type === "instanceOf" &&
          text(condition.childId) === context.nodeId,
      );
      const beforeCurrent = conditions.some(
        (condition) =>
          condition.field === "selections" &&
          condition.scope === "self" &&
          condition.type === "before" &&
          condition.childId === "any",
      );
      if (
        localGroup.field !== "selections" ||
        localGroup.scope !== "parent" ||
        expected === undefined ||
        !sameUnit ||
        !beforeCurrent
      ) {
        return undefined;
      }
      return numericConditionMatches(
        localGroup.type,
        context.unitOrdinal - 1,
        expected,
      );
    },
  );
  return combineConditionResults(
    text(group.type) ?? "and",
    [
      ...records(group.conditions).map((condition) =>
        pointConditionMatches(condition, context),
      ),
      ...records(group.conditionGroups).map((nested) =>
        pointConditionGroupMatches(nested, context),
      ),
      ...localResults,
    ],
  );
}

function pointModifierActive(
  modifier: JsonRecord,
  context: PointEvaluationContext,
): boolean | undefined {
  if (records(modifier.repeats).length > 0) return undefined;
  return combineConditionResults(
    "and",
    [
      ...records(modifier.conditions).map((condition) =>
        pointConditionMatches(condition, context),
      ),
      ...records(modifier.conditionGroups).map((group) =>
        pointConditionGroupMatches(group, context),
      ),
    ],
  );
}

function selectedNodePointCost(
  node: JsonRecord,
  pointsTypeId: string,
  context: PointEvaluationContext,
): EvaluatedPoints {
  let value = 0;
  for (const cost of records(node.costs)) {
    if (cost.typeId !== pointsTypeId) continue;
    const amount = numberValue(cost.value);
    if (amount === undefined) {
      return {
        ok: false,
        reason: "the selected BSData entry has a non-numeric points value",
      };
    }
    value += amount;
  }
  const unresolvedReasons: string[] = [];
  const modifierQueue = [
    ...records(node.modifiers),
    ...records(node.modifierGroups),
  ];
  while (modifierQueue.length > 0) {
    const modifier = modifierQueue.shift() as JsonRecord;
    modifierQueue.push(
      ...records(modifier.modifiers),
      ...records(modifier.modifierGroups),
    );
    if (modifier.field !== pointsTypeId) continue;
    const active = pointModifierActive(modifier, {
      ...context,
      nodeId: text(node.id),
    });
    if (active === false) continue;
    if (active === undefined) {
      unresolvedReasons.push(
        "a selected BSData entry has a points modifier whose conditions require roster context",
      );
      continue;
    }
    const amount = numberValue(modifier.value);
    if (amount === undefined) {
      return {
        ok: false,
        reason: "a selected BSData points modifier is non-numeric",
      };
    }
    switch (modifier.type) {
      case "set":
        value = amount;
        break;
      case "increment":
        value += amount;
        break;
      case "multiply":
        value *= amount;
        break;
      default:
        unresolvedReasons.push(
          `a selected BSData entry uses the unsupported ${String(modifier.type)} points operation`,
        );
    }
  }
  return { ok: true, value, unresolvedReasons };
}

export function evaluateResolvedPoints(
  result: UnitMappingResult,
  resolution: Extract<NewRecruitUnitResolution, { ok: true }>,
  pointsTypeId: string,
  modelCount: number,
  primaryCatalogueId: string,
  unitOrdinal = 1,
): EvaluatedPoints {
  const selections: Array<{
    reference: CatalogueSelectionReference;
    count: number;
  }> = [
    { reference: result.mapping, count: 1 },
    ...resolution.models.map((model) => ({
      reference: model.reference,
      count: model.count,
    })),
    ...resolution.models.flatMap((model) =>
      model.equipment.map((equipment) => ({
        reference: equipment.reference,
        count: equipment.count,
      })),
    ),
    ...resolution.directEquipment.map((equipment) => ({
      reference: equipment.reference,
      count: equipment.count,
    })),
  ];
  const selectedCountsByNodeId = new Map<string, number>();
  for (const selection of selections) {
    const node = result.nodesByEntryPath.get(selection.reference.entryId);
    const nodeId = text(node?.id);
    const selectionIds = [
      nodeId,
      selection.reference.entryGroupId?.split("::").at(-1),
    ].filter((value): value is string => Boolean(value));
    for (const selectionId of selectionIds) {
      selectedCountsByNodeId.set(
        selectionId,
        (selectedCountsByNodeId.get(selectionId) ?? 0) +
          selection.count,
      );
    }
  }
  let value = 0;
  const unresolvedReasons = new Set<string>();
  const evaluateSelection = (
    selection: (typeof selections)[number],
  ): EvaluatedPoints => {
    const node = result.nodesByEntryPath.get(selection.reference.entryId);
    if (!node) {
      return {
        ok: false,
        reason: `the selected entry path ${selection.reference.entryId} was not retained`,
      };
    }
    const cost = selectedNodePointCost(
      node,
      pointsTypeId,
      {
        nodeId: text(node.id),
        modelCount,
        unitOrdinal,
        primaryCatalogueId,
        selectedCountsByNodeId,
      },
    );
    if (!cost.ok) return cost;
    return {
      ok: true,
      value: cost.value * selection.count,
      unresolvedReasons: cost.unresolvedReasons,
    };
  };
  const rootCost = evaluateSelection(selections[0]);
  if (!rootCost.ok) return rootCost;
  if (rootCost.value !== 0) return rootCost;
  for (const selection of selections) {
    const cost = evaluateSelection(selection);
    if (!cost.ok) return cost;
    value += cost.value;
    for (const reason of cost.unresolvedReasons) {
      unresolvedReasons.add(reason);
    }
  }
  return {
    ok: true,
    value,
    unresolvedReasons: [...unresolvedReasons],
  };
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
  relevantEnhancements: Map<string, string>,
  relevantEquipment: Set<string>,
): UnitMappingResult {
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
  const relevantWalkedEquipment = walked.filter(
    (item) =>
      item.reference.type === "upgrade" &&
      relevantEquipment.has(item.reference.normalizedName),
  );
  const choiceAwareWalkedEquipment = choiceAwareEquipmentReferences(
    relevantWalkedEquipment,
  ).map(
    (reference, index): WalkedSelection => ({
      ...relevantWalkedEquipment[index],
      reference,
    }),
  );
  for (const item of choiceAwareWalkedEquipment) {
    if (!item.modelId) continue;
    modelById.get(item.modelId)?.equipment.push(item.reference);
  }

  const directEquipment = choiceAwareWalkedEquipment
    .filter((item) => !item.modelId)
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
  const classificationSignals = bsdataLegendClassificationSignals(
    candidate.rootLink,
    candidate.target,
    candidate.entryPath,
  );
  const mapping: CatalogueUnitReference = {
    ...rootReference,
    categories: categoryReferences(candidate.target),
    directEquipment: deduplicateReferences(directEquipment),
    models: [...modelById.values()].map((model) => ({
      ...model,
      equipment: deduplicateReferences(model.equipment),
    })),
    ...(warlord ? { warlord } : {}),
    enhancements: enhancementReferences,
    pointsByModelCount: {},
    ...(classificationSignals.length > 0
      ? { classificationSignals }
      : {}),
  };
  return {
    mapping,
    nodesByEntryPath: new Map([
      [rootReference.entryId, candidate.target],
      ...walked.map(
        (item): [string, JsonRecord] => [
          item.reference.entryId,
          item.node,
        ],
      ),
    ]),
  };
}

function deduplicateReferences(
  references: CatalogueSelectionReference[],
): CatalogueSelectionReference[] {
  const result = new Map<string, CatalogueSelectionReference>();
  for (const reference of references) {
    result.set(
      `${reference.entryId}\0${reference.normalizedName}\0${reference.loadoutChoiceId ?? ""}`,
      reference,
    );
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
    const maximum = tier.models_max ?? tier.models;
    for (let count = tier.models; count <= maximum; count += 1) {
      values.add(count);
    }
  }
  if (values.size === 0) values.add(unit.raw.model_count?.min ?? 1);
  return [...values].sort((left, right) => left - right);
}

type UnitOrdinalBand = {
  min: number;
  max: number | null;
};

function ordinalBandsForModelCount(
  unit: NonNullable<ReturnType<typeof units.get>>,
  modelCount: number,
): UnitOrdinalBand[] {
  const matchingTiers = (unit.raw.points ?? []).filter(
    (tier) =>
      modelCount >= tier.models &&
      modelCount <= (tier.models_max ?? tier.models),
  );
  const boundaries = new Set<number>([1]);
  for (const tier of matchingTiers) {
    if (tier.unit_count_min !== undefined) {
      boundaries.add(tier.unit_count_min);
    }
    if (tier.unit_count_max !== undefined && tier.unit_count_max !== null) {
      boundaries.add(tier.unit_count_max + 1);
    }
  }
  const starts = [...boundaries]
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const bands: UnitOrdinalBand[] = [];
  for (const [index, min] of starts.entries()) {
    if (baseUnitPoints(unit.raw, modelCount, min) <= 0) {
      continue;
    }
    const next = starts[index + 1];
    const max = next === undefined ? null : next - 1;
    bands.push({ min, max });
  }
  return bands;
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
      return { itemId, name, normalizedName: normalizeNewRecruitName(name) };
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
  details: Pick<
    DataConflict,
    | "rulesValue"
    | "newRecruitValue"
    | "scope"
    | "catalogue"
  > & {
    source: NonNullable<DataConflict["source"]>;
    rootCauseIdentity?: string;
  },
): DataConflict {
  const { rootCauseIdentity, ...values } = details;
  const rootCauseKey = sha256(
    [
      entityType,
      entityId,
      code,
      rootCauseIdentity ?? normalizeNewRecruitName(message),
      JSON.stringify(values.scope ?? {}),
    ].join("\0"),
  ).slice(0, 16);
  return {
    id: sha256(
      [
        factionId,
        entityType,
        entityId,
        code,
        message,
        JSON.stringify(values.scope ?? {}),
      ].join("\0"),
    ).slice(0, 16),
    rootCauseKey,
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

type DetachmentEntryCandidate = {
  document: CatalogueDocument;
  rootReference: CatalogueSelectionReference;
  reference: CatalogueSelectionReference;
  node: JsonRecord;
};

function isDetachmentLabel(value: unknown): boolean {
  return ["detachment", "detachments", "detachment choice"].includes(
    normalizeNewRecruitName(text(value) ?? ""),
  );
}

function isConfigurationEntry(
  node: JsonRecord,
  configurationCategoryId: string,
  link?: JsonRecord,
): boolean {
  return [
    ...records(link?.categoryLinks),
    ...records(node.categoryLinks),
  ].some(
    (link) =>
      text(link.targetId) === configurationCategoryId ||
      normalizeNewRecruitName(text(link.name) ?? "") === "configuration",
  );
}

function detachmentEntriesForRoot(
  document: CatalogueDocument,
  link: JsonRecord,
  target: JsonRecord,
  index: SelectionIndex,
): DetachmentEntryCandidate[] {
  const rootId = text(link.id);
  const targetId = text(target.id);
  if (!rootId || !targetId) return [];
  const rootReference = selectionReference(
    target,
    joinEntryId(rootId, targetId),
  );
  const directGroups = records(target.selectionEntryGroups).map((group) => ({
    group,
    entryPrefix: rootId,
    groupId: joinEntryId(rootId, text(group.id)),
  }));
  const linkedGroups = records(target.entryLinks).flatMap((nestedLink) => {
    const linkId = text(nestedLink.id);
    const resolved = resolveLink(nestedLink, index);
    if (
      !linkId ||
      resolved?.kind !== "group" ||
      (!isDetachmentLabel(nestedLink.name) &&
        !isDetachmentLabel(resolved.target.name))
    ) {
      return [];
    }
    return [
      {
        group: resolved.target,
        entryPrefix: joinEntryId(rootId, linkId),
        groupId: joinEntryId(rootId, linkId),
      },
    ];
  });
  return [...directGroups, ...linkedGroups].flatMap(
    ({ group, entryPrefix, groupId }) =>
      records(group.selectionEntries).flatMap((entry) => {
        const entryId = text(entry.id);
        if (!entryId) return [];
        return [
          {
            document,
            rootReference,
            reference: selectionReference(
              entry,
              joinEntryId(entryPrefix, entryId),
              {
                ...group,
                id: groupId,
              },
            ),
            node: entry,
          },
        ];
      }),
  );
}

type LegendsVisibilityCandidate = {
  document: CatalogueDocument;
  parent: CatalogueSelectionReference;
  choice: CatalogueSelectionReference;
};

function legendsVisibilityForConfiguration(
  primary: CatalogueDocument,
  documents: CatalogueDocument[],
  index: SelectionIndex,
  configurationCategoryId: string,
  mappedDetachmentDocumentIds: ReadonlySet<string>,
): NewRecruitConfiguration["legendsVisibility"] | undefined {
  const candidates = documents.flatMap(
    (document): LegendsVisibilityCandidate[] =>
      records(document.root.entryLinks).flatMap((link) => {
        if (
          !["show/hide options", "show hide options"].includes(
            normalizeNewRecruitName(text(link.name) ?? ""),
          )
        ) {
          return [];
        }
        const rootId = text(link.id);
        const resolved = resolveLink(link, index);
        const targetId = text(resolved?.target.id);
        if (
          !rootId ||
          !targetId ||
          resolved?.kind !== "entry"
        ) {
          return [];
        }
        const choices = walkSelections(
          resolved.target,
          rootId,
          index,
        ).filter(
          (item) =>
            ["show legends", "legends are visible"].includes(
              item.reference.normalizedName,
            ) &&
            isConfigurationEntry(
              item.node,
              configurationCategoryId,
            ),
        );
        if (choices.length !== 1) return [];
        return [
          {
            document,
            parent: selectionReference(
              resolved.target,
              joinEntryId(rootId, targetId),
            ),
            choice: {
              ...choices[0].reference,
              name: "Legends are visible",
              normalizedName: normalizeNewRecruitName(
                "Legends are visible",
              ),
            },
          },
        ];
      }),
  );
  const unique = [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.document.id}\0${candidate.parent.entryId}\0${candidate.choice.entryId}`,
        candidate,
      ]),
    ).values(),
  ];
  const primaryCandidates = unique.filter(
    (candidate) => candidate.document.id === primary.id,
  );
  const detachmentCandidates = unique.filter((candidate) =>
    mappedDetachmentDocumentIds.has(candidate.document.id),
  );
  const selected =
    primaryCandidates.length === 1
      ? primaryCandidates[0]
      : detachmentCandidates.length === 1
        ? detachmentCandidates[0]
      : unique.length === 1
        ? unique[0]
        : undefined;
  return selected
    ? {
        parent: selected.parent,
        choice: selected.choice,
      }
    : undefined;
}

export function buildConfiguration(
  primary: CatalogueDocument,
  documents: CatalogueDocument[],
  gameSystem: JsonRecord,
  index: SelectionIndex,
  engineDetachments: ReturnType<typeof factionDetachments>,
  overrides: Overrides,
  detachmentPointsTypeId: string,
  conflicts: DataConflict[],
  factionId: string,
): NewRecruitConfiguration | null {
  const configurationCategory = records(gameSystem.categoryEntries).find(
    (entry) =>
      normalizeNewRecruitName(text(entry.name) ?? "") === "configuration",
  );
  const configurationCategoryId = text(configurationCategory?.id);
  const globalLinks = records(gameSystem.entryLinks);
  const battleLink = globalLinks.find(
    (link) =>
      normalizeNewRecruitName(text(link.name) ?? "") === "battle size",
  );
  const dispositionLink = globalLinks.find(
    (link) =>
      normalizeNewRecruitName(text(link.name) ?? "") === "force disposition",
  );
  const resolvedBattle = battleLink ? resolveLink(battleLink, index) : undefined;
  const resolvedDisposition = dispositionLink
    ? resolveLink(dispositionLink, index)
    : undefined;
  const detachmentEntries =
    configurationCategoryId === undefined
      ? []
      : documents.flatMap((document) =>
          records(document.root.entryLinks).flatMap((link) => {
            if (!isDetachmentLabel(link.name)) return [];
            const resolved = resolveLink(link, index);
            if (
              resolved?.kind !== "entry" ||
              !isConfigurationEntry(
                resolved.target,
                configurationCategoryId,
                link,
              )
            ) {
              return [];
            }
            return detachmentEntriesForRoot(
              document,
              link,
              resolved.target,
              index,
            );
          }),
        );
  const uniqueDetachmentEntries = [
    ...new Map(
      detachmentEntries.map((candidate) => [
        `${candidate.rootReference.entryId}\0${candidate.reference.entryId}`,
        candidate,
      ]),
    ).values(),
  ];

  if (
    !configurationCategory ||
    !configurationCategoryId ||
    !battleLink ||
    !dispositionLink ||
    resolvedBattle?.kind !== "entry" ||
    resolvedDisposition?.kind !== "entry" ||
    uniqueDetachmentEntries.length === 0
  ) {
    conflicts.push(
      conflict(
        factionId,
        "catalogue",
        primary.id,
        primary.name,
        "UNSUPPORTED",
        "The Battle Size, Detachments, or Force Disposition configuration tree could not be resolved.",
        {
          source: "reconciler",
          catalogue: {
            id: primary.id,
            revision: numberValue(primary.root.revision) ?? 0,
          },
          rootCauseIdentity: "configuration-tree-unresolved",
        },
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
      normalizeNewRecruitName(text(entry.name) ?? "").includes(normalized),
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
        item.reference.normalizedName ===
        normalizeNewRecruitName(disposition.name),
    );
    if (match) dispositionChoices[disposition.id] = match.reference;
  }

  const detachmentChoices: NewRecruitConfiguration["detachment"]["choices"] =
    {};
  const mappedDetachmentDocumentIds = new Set<string>();
  for (const detachment of engineDetachments) {
    const alias =
      overrides.detachmentAliases[`${factionId}:${detachment.id}`] ??
      detachment.name;
    const override =
      overrides.exactPathOverrides?.detachments?.[
        `${factionId}:${detachment.id}`
      ];
    let matches = uniqueDetachmentEntries.filter(
      ({ reference }) =>
        reference.normalizedName === normalizeNewRecruitName(alias),
    );
    if (override) {
      const sourceDocument = documents.find(
        (document) => document.id === override.catalogueId,
      );
      if (
        !sourceDocument ||
        numberValue(sourceDocument.root.revision) !==
          override.catalogueRevision
      ) {
        conflicts.push(
          conflict(
            factionId,
            "detachment",
            detachment.id,
            detachment.name,
            "STALE_OVERRIDE",
            `The reviewed New Recruit path override for ${detachment.name} targets a catalogue revision that is not pinned.`,
            {
              source: "reconciler",
              catalogue: {
                id: override.catalogueId,
                revision: override.catalogueRevision,
                entryPath: override.entryPath,
              },
              scope: { entryPath: override.entryPath },
              rootCauseIdentity: `stale-detachment-override:${override.catalogueId}:${override.entryPath}`,
            },
          ),
        );
        continue;
      }
      matches = uniqueDetachmentEntries.filter(
        (candidate) =>
          candidate.document.id === override.catalogueId &&
          candidate.reference.entryId === override.entryPath,
      );
    } else {
      const primaryMatches = matches.filter(
        (candidate) => candidate.document.id === primary.id,
      );
      if (primaryMatches.length === 1) matches = primaryMatches;
    }
    if (matches.length !== 1) {
      conflicts.push(
        conflict(
          factionId,
          "detachment",
          detachment.id,
          detachment.name,
          matches.length === 0 ? "UNMAPPED" : "AMBIGUOUS",
          `${detachment.name} matched ${matches.length} New Recruit detachment entries.`,
          {
            source: "bsdata",
            ...(override
              ? {
                  scope: { entryPath: override.entryPath },
                  catalogue: {
                    id: override.catalogueId,
                    revision: override.catalogueRevision,
                    entryPath: override.entryPath,
                  },
                }
              : {}),
            rootCauseIdentity: `detachment-match:${detachment.id}:${matches.length}`,
          },
        ),
      );
      continue;
    }
    const matched = matches[0];
    mappedDetachmentDocumentIds.add(matched.document.id);
    const dp =
      records(matched.node.costs).find(
        (cost) => cost.typeId === detachmentPointsTypeId,
      )?.value ?? detachment.detachment_points ?? 0;
    detachmentChoices[detachment.id] = {
      ...matched.reference,
      detachmentPoints: numberValue(dp) ?? 0,
      rootReference: matched.rootReference,
    };
  }
  const legendsVisibility = legendsVisibilityForConfiguration(
    primary,
    documents,
    index,
    configurationCategoryId,
    mappedDetachmentDocumentIds,
  );

  if (!incursion || !strikeForce) {
    conflicts.push(
      conflict(
        factionId,
        "catalogue",
        primary.id,
        primary.name,
        "UNSUPPORTED",
        "Incursion or Strike Force battle-size selections are unavailable.",
        {
          source: "bsdata",
          catalogue: {
            id: primary.id,
            revision: numberValue(primary.root.revision) ?? 0,
          },
          rootCauseIdentity: "battle-size-unresolved",
        },
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
      reference:
        Object.values(detachmentChoices)[0]?.rootReference ??
        uniqueDetachmentEntries[0].rootReference,
      choices: detachmentChoices,
    },
    forceDisposition: {
      reference: selectionReference(
        resolvedDisposition.target,
        joinEntryId(dispositionRootId, dispositionTargetId),
      ),
      choices: dispositionChoices,
    },
    ...(legendsVisibility ? { legendsVisibility } : {}),
  };
}

export function generate(
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
    (entry) => normalizeNewRecruitName(text(entry.name) ?? "") === "army roster",
  );
  const pointsType = records(gameSystem.costTypes).find(
    (cost) => normalizeNewRecruitName(text(cost.name) ?? "") === "pts",
  );
  const detachmentPointsType = records(gameSystem.costTypes).find(
    (cost) =>
      normalizeNewRecruitName(text(cost.name) ?? "") === "detachment points",
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
          {
            source: "reconciler",
          },
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
    const legendUnitCandidates = new Map<string, UnitCandidate[]>();
    const unitCandidatesByPath = new Map<string, UnitCandidate[]>();
    const allUnitCandidates: UnitCandidate[] = [];
    for (const document of availableDocuments) {
      const local = localSelectionIndex(document.root);
      for (const link of records(document.root.entryLinks)) {
        if (link.type !== "selectionEntry") continue;
        const linkId = text(link.id);
        const targetId = text(link.targetId);
        const target = targetId
          ? local.entries.get(targetId) ?? shared.entries.get(targetId)
          : undefined;
        if (!linkId || !targetId || !target) continue;
        const name = text(target.name) ?? text(link.name);
        if (!name) continue;
        const entryPath = joinEntryId(linkId, targetId);
        const candidate = {
          document,
          rootLink: link,
          target,
          entryPath,
        };
        allUnitCandidates.push(candidate);
        const key = normalizeNewRecruitName(name);
        const values = unitCandidates.get(key) ?? [];
        values.push(candidate);
        unitCandidates.set(key, values);
        if (
          bsdataLegendClassificationSignals(
            candidate.rootLink,
            candidate.target,
            candidate.entryPath,
          ).length > 0
        ) {
          const legendKey = normalizeNewRecruitName(
            withoutBracketedLegendMarker(name),
          );
          legendUnitCandidates.set(legendKey, [
            ...(legendUnitCandidates.get(legendKey) ?? []),
            candidate,
          ]);
        }
        const pathKey = `${document.id}\0${entryPath}`;
        unitCandidatesByPath.set(pathKey, [
          ...(unitCandidatesByPath.get(pathKey) ?? []),
          candidate,
        ]);
      }
    }
    const legendCandidateEvidence = [
      ...new Map(
        allUnitCandidates
          .filter((candidate) => candidate.document.id === primary.id)
          .map(bsdataLegendCandidateEvidence)
          .filter(
            (
              candidate,
            ): candidate is CatalogueLegendCandidateEvidence =>
              candidate !== undefined,
          )
          .map((candidate) => [
            `${candidate.catalogueId}\0${candidate.entryPath}`,
            candidate,
          ]),
      ).values(),
    ].sort(
      (left, right) =>
        left.normalizedName.localeCompare(right.normalizedName) ||
        left.catalogueId.localeCompare(right.catalogueId) ||
        left.entryPath.localeCompare(right.entryPath),
    );

    const relevantEnhancements = new Map<string, string>();
    for (const detachment of engineDetachments) {
      for (const enhancementId of detachment.enhancement_ids ?? []) {
        const entity = enhancements.get(enhancementId);
        if (entity) {
          const alias =
            overrides.enhancementAliases[
              `${faction.id}:${enhancementId}`
            ] ?? entity.name;
          relevantEnhancements.set(enhancementId, normalizeNewRecruitName(alias));
        }
      }
    }

    const mappedUnits: Record<string, CatalogueUnitReference> = {};
    const mappedCandidatePaths = new Set<string>();
    let mappedBaseLoadouts = 0;
    for (const unit of engineUnits) {
      const alias =
        overrides.unitAliases[`${faction.id}:${unit.id}`] ?? unit.name;
      const exactOverride =
        overrides.exactPathOverrides?.units?.[
          `${faction.id}:${unit.id}`
        ];
      const normalizedAlias = normalizeNewRecruitName(alias);
      let candidates =
        unit.raw.is_legend === true
          ? legendUnitCandidates.get(normalizedAlias) ?? []
          : unitCandidates.get(normalizedAlias) ?? [];
      if (exactOverride) {
        const sourceDocument = availableDocuments.find(
          (document) => document.id === exactOverride.catalogueId,
        );
        if (
          !sourceDocument ||
          numberValue(sourceDocument.root.revision) !==
            exactOverride.catalogueRevision
        ) {
          conflicts.push(
            conflict(
              faction.id,
              "unit",
              unit.id,
              unit.name,
              "STALE_OVERRIDE",
              `The reviewed New Recruit path override for ${unit.name} targets a catalogue revision that is not pinned.`,
              {
                source: "reconciler",
                catalogue: {
                  id: exactOverride.catalogueId,
                  revision: exactOverride.catalogueRevision,
                  entryPath: exactOverride.entryPath,
                },
                scope: { entryPath: exactOverride.entryPath },
                rootCauseIdentity: `stale-unit-override:${exactOverride.catalogueId}:${exactOverride.entryPath}`,
              },
            ),
          );
          continue;
        }
        candidates =
          unitCandidatesByPath.get(
            `${exactOverride.catalogueId}\0${exactOverride.entryPath}`,
          ) ?? [];
      }
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
            {
              source: "bsdata",
              ...(exactOverride
                ? {
                    scope: { entryPath: exactOverride.entryPath },
                    catalogue: {
                      id: exactOverride.catalogueId,
                      revision: exactOverride.catalogueRevision,
                      entryPath: exactOverride.entryPath,
                    },
                  }
                : {
                    catalogue: {
                      id: primary.id,
                      revision: numberValue(primary.root.revision) ?? 0,
                    },
                  }),
              rootCauseIdentity: `unit-match:${unit.id}:${candidates.length}`,
            },
          ),
        );
        continue;
      }
      mappedCandidatePaths.add(
        `${selected.document.id}\0${selected.entryPath}`,
      );
      const equipment = validEquipment(unit);
      const mappingResult = unitMapping(
        selected,
        shared,
        relevantEnhancements,
        new Set(equipment.map((item) => item.normalizedName)),
      );
      const mapping = mappingResult.mapping;
      const baseResolutions = baseSelections(unit).map((selection) => {
        const resolution = resolveNewRecruitUnit(mapping, selection);
        return { selection, resolution };
      });
      const supportsBase = baseResolutions.every(
        ({ resolution }) => resolution.ok,
      );
      if (supportsBase) {
        mappedBaseLoadouts += 1;
      }
      const failedBaseResolutions = baseResolutions.filter(
        ({ resolution }) => !resolution.ok,
      );
      const failuresByReason = new Map<
        string,
        typeof failedBaseResolutions
      >();
      for (const failure of failedBaseResolutions) {
        const reason = failure.resolution.ok
          ? "unknown loadout resolution failure"
          : failure.resolution.reason;
        const key = normalizeNewRecruitName(reason);
        failuresByReason.set(key, [
          ...(failuresByReason.get(key) ?? []),
          failure,
        ]);
      }
      for (const [reasonKey, failures] of failuresByReason) {
        const selectionScopes = failures.map((failure) => ({
          modelCount: failure.selection.modelCount,
          equipmentSignature: newRecruitEquipmentSignature(
            failure.selection.equipment,
          ),
        }));
        const modelCounts = selectionScopes
          .map((scope) => scope.modelCount)
          .join(", ");
        const firstFailure = failures[0];
        const reason = firstFailure.resolution.ok
          ? "The selected loadout did not resolve."
          : firstFailure.resolution.reason;
        conflicts.push(
          conflict(
            faction.id,
            "equipment",
            `${unit.id}:base:${sha256(reasonKey).slice(0, 12)}`,
            unit.name,
            "UNMAPPED",
            `The deterministic ${unit.name} base loadout for model count${
              selectionScopes.length === 1 ? "" : "s"
            } ${modelCounts} cannot be represented in the New Recruit catalogue. ${reason}`,
            {
              source: "bsdata",
              scope: {
                selectionScopes,
                entryPath: selected.entryPath,
              },
              catalogue: {
                id: selected.document.id,
                revision: numberValue(selected.document.root.revision) ?? 0,
                entryPath: selected.entryPath,
              },
              rootCauseIdentity: `base-loadout:${unit.id}:${reasonKey}`,
            },
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
            {
              source: "bsdata",
              scope: {
                equipmentItemId: item.itemId,
                entryPath: selected.entryPath,
              },
              catalogue: {
                id: selected.document.id,
                revision: numberValue(selected.document.root.revision) ?? 0,
                entryPath: selected.entryPath,
              },
              rootCauseIdentity: `equipment:${unit.id}:${item.itemId}`,
            },
          ),
        );
      }

      for (const result of baseResolutions) {
        if (!result.resolution.ok) continue;
        const equipmentCounts = new Map(
          result.selection.equipment.map((item) => [
            item.itemId,
            item.count,
          ]),
        );
        for (const band of ordinalBandsForModelCount(
          unit,
          result.selection.modelCount,
        )) {
          const evaluatedPoints = evaluateResolvedPoints(
            mappingResult,
            result.resolution,
            pointsTypeId,
            result.selection.modelCount,
            primary.id,
            band.min,
          );
          const canonicalPoints =
            baseUnitPoints(
              unit.raw,
              result.selection.modelCount,
              band.min,
            ) +
            wargearPoints(unit.raw, equipmentCounts);
          if (canonicalPoints <= 0) continue;
          const scope = {
            modelCount: result.selection.modelCount,
            unitOrdinalMin: band.min,
            unitOrdinalMax: band.max,
            equipmentSignature:
              newRecruitEquipmentSignature(
                result.selection.equipment,
              ),
            entryPath: selected.entryPath,
          };
          const unresolvedReason =
            evaluatedPoints.ok &&
            evaluatedPoints.unresolvedReasons.length > 0
              ? evaluatedPoints.unresolvedReasons.join("; ")
              : null;
          if (!evaluatedPoints.ok || unresolvedReason) {
            conflicts.push(
              conflict(
                faction.id,
                "points",
                `${unit.id}:${result.selection.modelCount}`,
                unit.name,
                "POINTS_EVALUATION_UNSUPPORTED",
                `New Recruit points for ${unit.name} (${result.selection.modelCount} models, copies ${band.min}${band.max === null ? "+" : `-${band.max}`}) could not be evaluated safely because ${
                  unresolvedReason ??
                  (evaluatedPoints.ok
                    ? "the selected loadout did not resolve"
                    : evaluatedPoints.reason) ??
                  "the selected loadout did not resolve"
                }.`,
                {
                  source: "reconciler",
                  rulesValue: canonicalPoints,
                  scope,
                  catalogue: {
                    id: selected.document.id,
                    revision: numberValue(selected.document.root.revision) ?? 0,
                    entryPath: selected.entryPath,
                  },
                  rootCauseIdentity: `points-evaluation:${unit.id}:${result.selection.modelCount}:${band.min}:${band.max ?? "*"}`,
                },
              ),
            );
            continue;
          }
          const firstCopyBand =
            band.min <= 1 &&
            (band.max === null || band.max >= 1);
          if (
            firstCopyBand &&
            evaluatedPoints.value === canonicalPoints
          ) {
            mapping.pointsByModelCount[
              String(result.selection.modelCount)
            ] = evaluatedPoints.value;
          }
          if (evaluatedPoints.value !== canonicalPoints) {
            conflicts.push(
              conflict(
                faction.id,
                "points",
                `${unit.id}:${result.selection.modelCount}`,
                unit.name,
                "POINTS_MISMATCH",
                `${unit.name} (${result.selection.modelCount} models, copies ${band.min}${band.max === null ? "+" : `-${band.max}`}) is ${canonicalPoints} points in RosterPilot but evaluates to ${evaluatedPoints.value} points in the selected New Recruit path.`,
                {
                  source: "bsdata",
                  rulesValue: canonicalPoints,
                  newRecruitValue: evaluatedPoints.value,
                  scope,
                  catalogue: {
                    id: selected.document.id,
                    revision: numberValue(selected.document.root.revision) ?? 0,
                    entryPath: selected.entryPath,
                  },
                  rootCauseIdentity: `points-mismatch:${unit.id}:${result.selection.modelCount}:${band.min}:${band.max ?? "*"}:${canonicalPoints}:${evaluatedPoints.value}`,
                },
              ),
            );
          }
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
      detachmentPointsTypeId,
      conflicts,
      faction.id,
    );
    const mappedDetachments = configuration
      ? Object.keys(configuration.detachment.choices).length
      : 0;
    const unmatchedLegendCandidates = legendCandidateEvidence.filter(
      (candidate) =>
        !mappedCandidatePaths.has(
          `${candidate.catalogueId}\0${candidate.entryPath}`,
        ),
    );
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
      ...(unmatchedLegendCandidates.length > 0
        ? {
            classificationEvidence: {
              legendCandidates: unmatchedLegendCandidates,
            },
          }
        : {}),
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
  const allConflicts = allFactions.flatMap(
    (faction) => faction.conflicts,
  );
  const blockingConflicts = allConflicts.filter(
    (item) => item.blocking,
  );
  return {
    schemaVersion: 2,
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
      conflicts: allConflicts.length,
      blockingConflicts: blockingConflicts.length,
      uniqueConflicts: new Set(
        allConflicts.map((item) => item.rootCauseKey ?? item.id),
      ).size,
      uniqueBlockingConflicts: new Set(
        blockingConflicts.map((item) => item.rootCauseKey ?? item.id),
      ).size,
    },
  };
}

export function summarizeManifest(
  manifest: NewRecruitCatalogueManifest,
): NewRecruitCatalogueSummaryManifest {
  return {
    ...manifest,
    factions: Object.fromEntries(
      Object.entries(manifest.factions).map(([factionId, faction]) => {
        const {
          configuration,
          units: _units,
          classificationEvidence: _classificationEvidence,
          ...summary
        } = faction;
        void _units;
        void _classificationEvidence;
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
    checkout:
      valueAfter("--checkout") ??
      process.env.ROSTERPILOT_BSDATA_CHECKOUT,
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

function main(): void {
  const argumentsValue = parseArguments();
  const source = readJson<SourceManifest>(sourcesPath);
  const overrides = readJson<Overrides>(overridesPath);
  withCheckout(
    source,
    argumentsValue.checkout,
    argumentsValue.latest,
    (checkout, actualCommit) => {
      const requestedCommit =
        argumentsValue.commit ?? source.newRecruit.commit;
      if (!argumentsValue.latest && actualCommit !== requestedCommit) {
        throw new Error(
          `BSData checkout is ${actualCommit}; expected ${requestedCommit}.`,
        );
      }
      if (
        argumentsValue.latest &&
        actualCommit !== source.newRecruit.commit
      ) {
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
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
