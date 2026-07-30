import {
  dataset,
  groupLoadout,
  normalizeName,
  units,
} from "@alpaca-software/40kdc-data";

import type {
  CatalogueModelReference,
  CatalogueSelectionReference,
  CatalogueUnitReference,
} from "./catalogue-types";

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
      const match =
        inChoice.length === 1
          ? inChoice[0]
          : inChoice.length === 0 && unscoped.length === 1
            ? unscoped[0]
            : undefined;
      if (!match) return [];
      if (inChoice.length === 1) scopedMatches += 1;
      selected.push({ ...item, reference: match });
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

function modelNameRank(
  modelName: string | null,
  reference: CatalogueModelReference,
): number {
  if (!modelName) return 3;
  const expected = normalizeNewRecruitName(modelName);
  const actual = normalizeNewRecruitName(reference.name);
  if (actual === expected) return 0;
  if (
    actual.startsWith(`${expected} `) ||
    expected.startsWith(`${actual} `)
  ) {
    return 1;
  }
  if (actual.includes(expected) || expected.includes(actual)) return 2;
  return 3;
}

function looksLikeLeaderModel(name: string): boolean {
  return /\b(alpha|champion|exarch|huntmaster|leader|master|princeps|sergeant|superior|watchmaster)\b/.test(
    normalizeNewRecruitName(name),
  );
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
  let groups: ReturnType<typeof groupLoadout>;
  try {
    groups = groupLoadout(
      unit.raw,
      selection.modelCount,
      dataset.wargearOptionsOf(unit.raw),
      composition?.models,
      counts,
    );
  } catch {
    // Malformed or combinatorially explosive upstream composition data must
    // block this mapping without terminating roster generation or export.
    return null;
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
  if ((composition?.models.length ?? 0) > 1) return null;

  const modelName =
    composition?.models.length === 1 ? composition.models[0].name : null;
  return [
    {
      modelName,
      isLeaderModel:
        composition?.models.length === 1
          ? composition.models[0].is_leader_model ?? null
          : null,
      count: selection.modelCount,
      equipment: positiveEquipment,
    },
  ];
}

function candidateForGroup(
  mapping: CatalogueUnitReference,
  model: CatalogueModelReference,
  group: EquipmentGroup,
): ModelCandidate | null {
  const modelEquipment: ResolvedEquipmentReference[] = [];
  const directEquipment: ResolvedEquipmentReference[] = [];

  for (const equipment of group.equipment) {
    const modelMatches = referencesByName(model.equipment, equipment.name);
    if (modelMatches.length > 1) return null;
    if (modelMatches.length === 1) {
      modelEquipment.push({
        ...equipment,
        reference: modelMatches[0],
      });
      continue;
    }
    const directMatches = referencesByName(
      mapping.directEquipment,
      equipment.name,
    );
    if (directMatches.length !== 1) return null;
    directEquipment.push({
      ...equipment,
      reference: directMatches[0],
    });
  }

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
    left.nameRank - right.nameRank ||
    left.leaderRank - right.leaderRank ||
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
      left.extraEquipmentCount === right.extraEquipmentCount,
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
  for (const group of groups) {
    const bestNameRank = Math.min(
      ...mapping.models.map((model) => modelNameRank(group.modelName, model)),
    );
    const candidates = mapping.models
      .map((model) => candidateForGroup(mapping, model, group))
      .filter((candidate): candidate is ModelCandidate => candidate !== null)
      .filter((candidate) => candidate.nameRank === bestNameRank)
      .sort(compareCandidates);
    const best = candidates[0];
    if (!best) {
      return {
        ok: false,
        reason: `New Recruit has no model entry for ${group.count} ${group.modelName ?? selection.name} model${
          group.count === 1 ? "" : "s"
        } with the selected equipment.`,
      };
    }
    if (candidatesAreTied(best, candidates[1])) {
      const names = candidates
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
    directEquipment.push(...best.directEquipment);
  }

  return {
    ok: true,
    models,
    directEquipment: aggregateDirectEquipment(directEquipment),
  };
}
