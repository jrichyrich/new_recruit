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
  const normalizedName = normalizeName(name);
  return references.filter(
    (reference) => reference.normalizedName === normalizedName,
  );
}

function modelNameRank(
  modelName: string | null,
  reference: CatalogueModelReference,
): number {
  if (!modelName) return 3;
  const expected = normalizeName(modelName);
  const actual = reference.normalizedName;
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
    normalizeName(name),
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
  const groups = groupLoadout(
    unit.raw,
    selection.modelCount,
    dataset.wargearOptionsOf(unit.raw),
    composition?.models,
    counts,
  );
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
              normalizeName(model.name) ===
              normalizeName(group.model_name ?? ""),
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
    modelEquipment.map((equipment) => normalizeName(equipment.name)),
  );
  const availableNames = new Set(
    model.equipment.map((equipment) => equipment.normalizedName),
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
    const directEquipment: ResolvedEquipmentReference[] = [];
    for (const equipment of positiveEquipment) {
      const matches = referencesByName(
        mapping.directEquipment,
        equipment.name,
      );
      if (matches.length !== 1) {
        return {
          ok: false,
          reason: `New Recruit catalogue mapping for ${selection.name} equipment "${equipment.name}" is ${
            matches.length === 0 ? "missing" : "ambiguous"
          }.`,
        };
      }
      directEquipment.push({
        ...equipment,
        reference: matches[0],
      });
    }
    return {
      ok: true,
      models: [],
      directEquipment: aggregateDirectEquipment(directEquipment),
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
    const candidates = mapping.models
      .map((model) => candidateForGroup(mapping, model, group))
      .filter((candidate): candidate is ModelCandidate => candidate !== null)
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
