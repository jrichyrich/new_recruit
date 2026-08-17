import {
  groupLoadout,
  normalizeName,
} from "@alpaca-software/40kdc-data";

import type {
  CatalogueModelReference,
  CatalogueSelectionReference,
  CatalogueUnitReference,
} from "./catalogue-types";
import { dataset, units } from "./runtime-dataset";

const UNICODE_DASHES = /[\u058a\u05be\u1400\u1806\u2010-\u2015\u2e17\u2e1a\u2e3a-\u2e3b\u2e40\u301c\u3030\u30a0\ufe31-\ufe32\ufe58\ufe63\uff0d\u2212]/g;

/**
 * BSData and the rules package occasionally use different Unicode forms for
 * punctuation. Keep matching deterministic and conservative: canonicalize
 * compatibility characters, dash variants, and whitespace, then delegate the
 * existing punctuation/diacritic behavior to the rules package normalizer.
 */
export function normalizeNewRecruitName(value: string): string {
  return normalizeName(
    value
      .normalize("NFKC")
      .replace(UNICODE_DASHES, "-")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export function newRecruitEquipmentSignature(
  equipment: Array<{
    itemId?: string;
    name: string;
    count: number;
  }>,
): string {
  const counts = new Map<string, number>();
  for (const item of equipment) {
    if (item.count <= 0) continue;
    const key = item.itemId
      ? `id:${item.itemId}`
      : `name:${normalizeNewRecruitName(item.name)}`;
    counts.set(key, (counts.get(key) ?? 0) + item.count);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}=${count}`)
    .join("|");
}

export type NewRecruitUnitInput = {
  unitId: string;
  name: string;
  modelCount: number;
  equipment: Array<{
    itemId: string;
    name: string;
    count: number;
  }>;
};

export type ResolvedEquipmentReference = {
  itemId: string;
  name: string;
  count: number;
  reference: CatalogueSelectionReference;
};

export type ResolvedModelReference = {
  reference: CatalogueModelReference;
  count: number;
  equipment: ResolvedEquipmentReference[];
};

export type NewRecruitUnitResolution =
  | {
      ok: true;
      models: ResolvedModelReference[];
      directEquipment: ResolvedEquipmentReference[];
    }
  | {
      ok: false;
      reason: string;
    };

type EquipmentGroup = {
  modelName: string | null;
  isLeaderModel: boolean | null;
  count: number;
  equipment: Array<{
    itemId: string;
    name: string;
    count: number;
  }>;
};

const MAX_DEFAULT_GROUP_SEARCH_STATES = 4_096;
const MAX_GROUP_LOADOUT_RECURSIVE_CANDIDATES = 512;

function exactDefaultEquipmentGroups(
  selection: NewRecruitUnitInput,
  models:
    | ReadonlyArray<{
        name: string;
        min?: number;
        max?: number;
        default_weapon_ids?: readonly string[];
        is_leader_model?: boolean;
      }>
    | undefined,
): EquipmentGroup[] | null {
  if (
    !models ||
    models.length === 0 ||
    models.some(
      (model) => (model.default_weapon_ids?.length ?? 0) === 0,
    )
  ) {
    return null;
  }
  const selectedById = new Map<
    string,
    NewRecruitUnitInput["equipment"][number]
  >();
  for (const equipment of selection.equipment) {
    if (equipment.count <= 0) continue;
    const current = selectedById.get(equipment.itemId);
    selectedById.set(equipment.itemId, {
      ...equipment,
      count: (current?.count ?? 0) + equipment.count,
    });
  }
  const residual = new Map(
    [...selectedById].map(([itemId, equipment]) => [
      itemId,
      equipment.count,
    ]),
  );
  const defaultIds = new Set(
    models.flatMap((model) => [
      ...(model.default_weapon_ids ?? []),
    ]),
  );
  if ([...residual.keys()].some((itemId) => !defaultIds.has(itemId))) {
    return null;
  }
  const ranges = models.map((model) => {
    const minimum = Math.max(0, Math.floor(model.min ?? 0));
    return {
      minimum,
      maximum: Math.max(
        minimum,
        Math.min(
          selection.modelCount,
          Math.floor(model.max ?? minimum),
        ),
      ),
    };
  });
  const suffixMinimum = new Array<number>(models.length + 1).fill(0);
  const suffixMaximum = new Array<number>(models.length + 1).fill(0);
  for (let index = models.length - 1; index >= 0; index -= 1) {
    suffixMinimum[index] =
      suffixMinimum[index + 1] + ranges[index].minimum;
    suffixMaximum[index] =
      suffixMaximum[index + 1] + ranges[index].maximum;
  }
  const counts = new Array<number>(models.length).fill(0);
  let searchedStates = 0;
  const assign = (index: number, modelsLeft: number): boolean => {
    searchedStates += 1;
    if (searchedStates > MAX_DEFAULT_GROUP_SEARCH_STATES) return false;
    if (index === models.length) {
      return (
        modelsLeft === 0 &&
        [...residual.values()].every((count) => count === 0)
      );
    }
    const range = ranges[index];
    const minimum = Math.max(
      range.minimum,
      modelsLeft - suffixMaximum[index + 1],
    );
    const maximum = Math.min(
      range.maximum,
      modelsLeft - suffixMinimum[index + 1],
    );
    if (minimum > maximum) return false;
    const perModel = new Map<string, number>();
    for (const itemId of models[index].default_weapon_ids ?? []) {
      perModel.set(itemId, (perModel.get(itemId) ?? 0) + 1);
    }
    for (let count = maximum; count >= minimum; count -= 1) {
      const fits = [...perModel].every(
        ([itemId, perModelCount]) =>
          (residual.get(itemId) ?? 0) >= perModelCount * count,
      );
      if (!fits) continue;
      for (const [itemId, perModelCount] of perModel) {
        residual.set(
          itemId,
          (residual.get(itemId) ?? 0) - perModelCount * count,
        );
      }
      counts[index] = count;
      if (assign(index + 1, modelsLeft - count)) return true;
      for (const [itemId, perModelCount] of perModel) {
        residual.set(
          itemId,
          (residual.get(itemId) ?? 0) + perModelCount * count,
        );
      }
    }
    counts[index] = 0;
    return false;
  };
  if (!assign(0, selection.modelCount)) return null;
  return models.flatMap((model, index) => {
    const count = counts[index];
    if (count <= 0) return [];
    const equipmentCounts = new Map<string, number>();
    for (const itemId of model.default_weapon_ids ?? []) {
      equipmentCounts.set(
        itemId,
        (equipmentCounts.get(itemId) ?? 0) + count,
      );
    }
    return [
      {
        modelName: model.name,
        isLeaderModel: model.is_leader_model ?? null,
        count,
        equipment: [...equipmentCounts].map(
          ([itemId, equipmentCount]) => ({
            itemId,
            name: selectedById.get(itemId)!.name,
            count: equipmentCount,
          }),
        ),
      },
    ];
  });
}

function groupLoadoutSearchIsTooComplex(
  models:
    | ReadonlyArray<{
        name: string;
      }>
    | undefined,
  options: ReadonlyArray<{
    replacement?: readonly string[];
    replacement_choice?: ReadonlyArray<readonly string[]>;
    model_constraint?: {
      model_name?: string | null;
    } | null;
  }>,
): boolean {
  if (!models || models.length === 0) return false;
  let recursiveCandidateUpperBound = 0;
  for (const model of models) {
    let rowCandidateUpperBound = 1;
    for (const option of options) {
      const modelName =
        option.model_constraint?.model_name ?? null;
      if (modelName !== null && modelName !== model.name) {
        continue;
      }
      const transformations =
        (option.replacement?.length ?? 0) > 0
          ? 1
          : (option.replacement_choice ?? []).filter(
              (branch) => branch.length > 0,
            ).length;
      if (transformations === 0) continue;
      rowCandidateUpperBound *= transformations + 1;
      if (
        rowCandidateUpperBound >
        MAX_GROUP_LOADOUT_RECURSIVE_CANDIDATES
      ) {
        return true;
      }
    }
    recursiveCandidateUpperBound += rowCandidateUpperBound;
    if (
      recursiveCandidateUpperBound >
      MAX_GROUP_LOADOUT_RECURSIVE_CANDIDATES
    ) {
      return true;
    }
  }
  return false;
}

type ModelCandidate = {
  model: CatalogueModelReference;
  nameRank: number;
  leaderRank: number;
  modelEquipmentCount: number;
  extraEquipmentCount: number;
  modelEquipment: ResolvedEquipmentReference[];
  directEquipment: ResolvedEquipmentReference[];
};

function referencesByName(
  references: CatalogueSelectionReference[],
  name: string,
): CatalogueSelectionReference[] {
  const normalizedName = normalizeNewRecruitName(name);
  return references.filter(
    (reference) =>
      normalizeNewRecruitName(reference.name) === normalizedName,
  );
}

function resolveCoherentEquipmentSet(
  references: CatalogueSelectionReference[],
  equipment: Array<{
    itemId: string;
    name: string;
    count: number;
  }>,
):
  | { ok: true; equipment: ResolvedEquipmentReference[] }
  | { ok: false; equipmentName: string; matchCount: number } {
  const matchesByEquipment = equipment.map((item) => ({
    item,
    matches: referencesByName(references, item.name),
  }));
  const missing = matchesByEquipment.find(
    ({ matches }) => matches.length === 0,
  );
  if (missing) {
    return {
      ok: false,
      equipmentName: missing.item.name,
      matchCount: 0,
    };
  }
  if (matchesByEquipment.every(({ matches }) => matches.length === 1)) {
    return {
      ok: true,
      equipment: matchesByEquipment.map(({ item, matches }) => ({
        ...item,
        reference: matches[0],
      })),
    };
  }

  const choiceIds = new Set(
    matchesByEquipment.flatMap(({ matches }) =>
      matches.flatMap((reference) =>
        reference.loadoutChoiceId ? [reference.loadoutChoiceId] : [],
      ),
    ),
  );
  const candidates = [...choiceIds].flatMap((choiceId) => {
    const selected: ResolvedEquipmentReference[] = [];
    let scopedMatches = 0;
    for (const { item, matches } of matchesByEquipment) {
      const inChoice = matches.filter(
        (reference) => reference.loadoutChoiceId === choiceId,
      );
      const unscoped = matches.filter(
        (reference) => reference.loadoutChoiceId === undefined,
      );
      if (inChoice.length === 1) {
        scopedMatches += 1;
        selected.push({ ...item, reference: inChoice[0] });
        continue;
      }
      if (item.count > 1 && inChoice.length === item.count) {
        scopedMatches += 1;
        selected.push(
          ...inChoice.map((reference) => ({
            ...item,
            count: 1,
            reference,
          })),
        );
        continue;
      }
      if (inChoice.length === 0 && unscoped.length === 1) {
        selected.push({ ...item, reference: unscoped[0] });
        continue;
      }
      return [];
    }
    return [{ choiceId, selected, scopedMatches }];
  });
  candidates.sort(
    (left, right) =>
      right.scopedMatches - left.scopedMatches ||
      left.choiceId.localeCompare(right.choiceId),
  );
  const best = candidates[0];
  const tied =
    best &&
    candidates[1]?.scopedMatches === best.scopedMatches;
  if (best && !tied) {
    return { ok: true, equipment: best.selected };
  }

  const ambiguous = matchesByEquipment.find(
    ({ matches }) => matches.length > 1,
  ) as (typeof matchesByEquipment)[number];
  return {
    ok: false,
    equipmentName: ambiguous.item.name,
    matchCount: ambiguous.matches.length,
  };
}

function modelRoleAndVariant(name: string): {
  role: string;
  variant: string;
} {
  const trimmed = name.trim();
  const parenthetical = trimmed.match(/^(.*)\(([^)]+)\)\s*$/);
  if (parenthetical) {
    return {
      role: normalizeNewRecruitName(parenthetical[1]),
      variant: normalizeNewRecruitName(parenthetical[2]),
    };
  }
  const withVariant = trimmed.match(/^(.*?)\s+(?:w\/|with)\s+(.*)$/i);
  if (withVariant) {
    return {
      role: normalizeNewRecruitName(withVariant[1]),
      variant: normalizeNewRecruitName(withVariant[2]),
    };
  }
  return { role: normalizeNewRecruitName(trimmed), variant: "" };
}

function modelNameRank(
  modelName: string | null,
  reference: CatalogueModelReference,
): number {
  if (!modelName) return 3;
  const expected = normalizeNewRecruitName(modelName);
  const actual = normalizeNewRecruitName(reference.name);
  if (actual === expected) return 0;
  const expectedParts = modelRoleAndVariant(modelName);
  const actualParts = modelRoleAndVariant(reference.name);
  if (
    expectedParts.role === actualParts.role &&
    expectedParts.variant &&
    expectedParts.variant === actualParts.variant
  ) {
    return 0;
  }
  if (
    actual.startsWith(`${expected} `) ||
    expected.startsWith(`${actual} `) ||
    actual.endsWith(` ${expected}`) ||
    expected.endsWith(` ${actual}`)
  ) {
    return 1;
  }
  if (actual.includes(expected) || expected.includes(actual)) return 2;
  return 3;
}

function looksLikeLeaderModel(name: string): boolean {
  return /\b(alpha|champion|exarch|huntmaster|leader|master|princeps|sergeant|superior|watchmaster)\b/.test(
    modelRoleAndVariant(name).role,
  );
}

/**
 * BSData encodes 10- vs 20-model (and similar) squads as a unit-level size
 * selection such as "2 Watchmasters and 18 Troopers" or "10 models". Weapon
 * pairings like "1 Splinter pistol and 1 Power weapon" stay on the model.
 */
export function isUnitSizeLoadoutChoice(name: string): boolean {
  const trimmed = name.trim();
  if (/^\d+\s+models?$/i.test(trimmed)) return true;
  const composed = /^(?:0-)?(\d+)\s+.+?\s+and\s+(\d+)\s+/.exec(trimmed);
  if (!composed) return false;
  return Math.max(Number(composed[1]), Number(composed[2])) >= 3;
}

function equipmentGroups(
  selection: NewRecruitUnitInput,
): EquipmentGroup[] | null {
  const unit = units.getAny(selection.unitId);
  if (!unit) return null;
  const positiveEquipment = selection.equipment.filter(
    (equipment) => equipment.count > 0,
  );
  const equipmentById = new Map(
    positiveEquipment.map((equipment) => [equipment.itemId, equipment]),
  );
  const counts = new Map(
    positiveEquipment.map((equipment) => [
      equipment.itemId,
      equipment.count,
    ]),
  );
  const composition = dataset.unitCompositionOf(unit.raw);
  const exactDefaultGroups = exactDefaultEquipmentGroups(
    selection,
    composition?.models,
  );
  if (exactDefaultGroups) return exactDefaultGroups;
  const aggregateFallback = (): EquipmentGroup[] | null => {
    if ((composition?.models.length ?? 0) > 1) return null;
    const model =
      composition?.models.length === 1
        ? composition.models[0]
        : null;
    return [
      {
        modelName: model?.name ?? null,
        isLeaderModel: model?.is_leader_model ?? null,
        count: selection.modelCount,
        equipment: positiveEquipment,
      },
    ];
  };
  const options = dataset.wargearOptionsOf(unit.raw);
  if (
    groupLoadoutSearchIsTooComplex(
      composition?.models,
      options,
    )
  ) {
    return aggregateFallback();
  }
  let groups: ReturnType<typeof groupLoadout>;
  try {
    groups = groupLoadout(
      unit.raw,
      selection.modelCount,
      options,
      composition?.models,
      counts,
    );
  } catch {
    // A homogeneous composition has an exact aggregate fallback. Use it when
    // malformed upstream data still defeats the bounded search. Multi-row
    // compositions remain fail-closed because their equipment cannot be
    // attributed safely without a successful per-model decomposition.
    return aggregateFallback();
  }
  if (groups) {
    const resolved: EquipmentGroup[] = [];
    for (const group of groups) {
      const equipment = [];
      for (const item of group.weapons) {
        const selected = equipmentById.get(item.id);
        if (!selected) return null;
        equipment.push({
          itemId: item.id,
          name: selected.name,
          count: item.count * group.count,
        });
      }
      resolved.push({
        modelName: group.model_name,
        isLeaderModel:
          composition?.models.find(
            (model) =>
              normalizeNewRecruitName(model.name) ===
              normalizeNewRecruitName(group.model_name ?? ""),
          )?.is_leader_model ?? null,
        count: group.count,
        equipment,
      });
    }
    return resolved;
  }
  return aggregateFallback();
}

function candidateForGroup(
  mapping: CatalogueUnitReference,
  model: CatalogueModelReference,
  group: EquipmentGroup,
): ModelCandidate | null {
  const modelItems = group.equipment.filter(
    (equipment) =>
      referencesByName(model.equipment, equipment.name).length > 0,
  );
  const directItems = group.equipment.filter(
    (equipment) =>
      referencesByName(model.equipment, equipment.name).length === 0,
  );
  const resolvedModelEquipment = resolveCoherentEquipmentSet(
    model.equipment,
    modelItems,
  );
  if (!resolvedModelEquipment.ok) return null;
  const resolvedDirectEquipment = resolveCoherentEquipmentSet(
    mapping.directEquipment,
    directItems,
  );
  if (!resolvedDirectEquipment.ok) return null;
  const modelEquipment = resolvedModelEquipment.equipment;
  const directEquipment = resolvedDirectEquipment.equipment;

  const mappedNames = new Set(
    modelEquipment.map((equipment) =>
      normalizeNewRecruitName(equipment.name),
    ),
  );
  const availableNames = new Set(
    model.equipment.map((equipment) =>
      normalizeNewRecruitName(equipment.name),
    ),
  );
  return {
    model,
    nameRank: modelNameRank(group.modelName, model),
    leaderRank:
      group.isLeaderModel === null
        ? 0
        : group.isLeaderModel === looksLikeLeaderModel(model.name)
          ? 0
          : 1,
    modelEquipmentCount: mappedNames.size,
    extraEquipmentCount: [...availableNames].filter(
      (name) => !mappedNames.has(name),
    ).length,
    modelEquipment,
    directEquipment,
  };
}

function compareCandidates(left: ModelCandidate, right: ModelCandidate): number {
  return (
    left.leaderRank - right.leaderRank ||
    left.nameRank - right.nameRank ||
    right.modelEquipmentCount - left.modelEquipmentCount ||
    left.extraEquipmentCount - right.extraEquipmentCount ||
    left.model.normalizedName.localeCompare(right.model.normalizedName) ||
    left.model.entryId.localeCompare(right.model.entryId)
  );
}

function candidatesAreTied(
  left: ModelCandidate,
  right: ModelCandidate | undefined,
): boolean {
  return Boolean(
    right &&
      left.nameRank === right.nameRank &&
      left.leaderRank === right.leaderRank &&
      left.modelEquipmentCount === right.modelEquipmentCount &&
      left.extraEquipmentCount === right.extraEquipmentCount &&
      left.model.normalizedName !== right.model.normalizedName,
  );
}

function aggregateDirectEquipment(
  equipment: ResolvedEquipmentReference[],
): ResolvedEquipmentReference[] {
  const result = new Map<string, ResolvedEquipmentReference>();
  for (const item of equipment) {
    const existing = result.get(item.reference.entryId);
    if (existing) {
      existing.count += item.count;
    } else {
      result.set(item.reference.entryId, { ...item });
    }
  }
  return [...result.values()].sort(
    (left, right) =>
      left.reference.normalizedName.localeCompare(
        right.reference.normalizedName,
      ) || left.reference.entryId.localeCompare(right.reference.entryId),
  );
}

export function resolveNewRecruitUnit(
  mapping: CatalogueUnitReference,
  selection: NewRecruitUnitInput,
): NewRecruitUnitResolution {
  const positiveEquipment = selection.equipment.filter(
    (equipment) => equipment.count > 0,
  );
  if (mapping.models.length === 0) {
    const directEquipment = resolveCoherentEquipmentSet(
      mapping.directEquipment,
      positiveEquipment,
    );
    if (!directEquipment.ok) {
      return {
        ok: false,
        reason: `New Recruit catalogue mapping for ${selection.name} equipment "${directEquipment.equipmentName}" is ${
          directEquipment.matchCount === 0 ? "missing" : "ambiguous"
        }.`,
      };
    }
    return {
      ok: true,
      models: [],
      directEquipment: aggregateDirectEquipment(
        directEquipment.equipment,
      ),
    };
  }

  const groups = equipmentGroups(selection);
  if (!groups) {
    return {
      ok: false,
      reason: `The legal ${selection.name} loadout could not be decomposed into New Recruit model selections.`,
    };
  }

  const models: ResolvedModelReference[] = [];
  const directEquipment: ResolvedEquipmentReference[] = [];
  const usedEntryIds = new Set<string>();
  for (const group of groups) {
    const candidates = mapping.models
      .map((model) => candidateForGroup(mapping, model, group))
      .filter((candidate): candidate is ModelCandidate => candidate !== null)
      .filter((candidate) => {
        if (!usedEntryIds.has(candidate.model.entryId)) return true;
        // Same-name catalogue entries (two Watchmasters) may reuse one entry.
        // Distinct named specialists (Master Vox vs Regimental Standard) may not.
        return modelNameRank(group.modelName, candidate.model) === 0;
      })
      .sort(compareCandidates);
    const eligible =
      group.isLeaderModel === true
        ? candidates.filter((candidate) => candidate.nameRank === 0)
        : candidates;
    const best = eligible[0];
    if (!best) {
      return {
        ok: false,
        reason: `New Recruit has no model entry for ${group.count} ${group.modelName ?? selection.name} model${
          group.count === 1 ? "" : "s"
        } with the selected equipment.`,
      };
    }
    if (candidatesAreTied(best, eligible[1])) {
      const names = eligible
        .filter((candidate) => candidatesAreTied(best, candidate))
        .map((candidate) => candidate.model.name)
        .join(", ");
      return {
        ok: false,
        reason: `New Recruit model mapping for ${group.modelName ?? selection.name} is ambiguous between: ${names}.`,
      };
    }
    models.push({
      reference: best.model,
      count: group.count,
      equipment: best.modelEquipment,
    });
    usedEntryIds.add(best.model.entryId);
    directEquipment.push(...best.directEquipment);
  }

  return {
    ok: true,
    models,
    directEquipment: aggregateDirectEquipment(directEquipment),
  };
}
