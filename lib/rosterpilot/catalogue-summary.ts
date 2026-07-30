import catalogueJson from "../../data/generated/new-recruit-summary.json";

import type {
  DataConflict,
  NewRecruitCatalogueSummaryManifest,
  NewRecruitFactionSummary,
} from "./catalogue-types";
import { newRecruitEquipmentSignature } from "./new-recruit-resolver";

export type NewRecruitCapability = {
  factionId: string;
  available: boolean;
  complete: boolean;
  catalogueId: string | null;
  catalogueName: string | null;
  catalogueRevision: number | null;
  mappedUnits: number;
  engineUnits: number;
  mappedBaseLoadouts: number;
  mappedDetachments: number;
  engineDetachments: number;
  blockingConflicts: number;
  reason: string | null;
};

export type DataConflictFilter = {
  factionId?: string;
  entityType?: DataConflict["entityType"];
  blocking?: boolean;
  limit?: number;
  offset?: number;
};

export type DataConflictPage = {
  total: number;
  uniqueTotal: number;
  offset: number;
  limit: number;
  items: DataConflict[];
};

export type RosterConflictInput = {
  factionId: string;
  detachmentId: string;
  units: Array<{
    unitId: string;
    modelCount?: number;
    ordinal?: number;
    enhancementId?: string | null;
    equipment: Array<{
      itemId?: string;
      name: string;
      count: number;
    }>;
  }>;
};

/**
 * Returns true only when a conflict proves that every configuration of the
 * referenced unit is blocked. Model-count and loadout-scoped conflicts must
 * remain available to the builder so it can choose a different legal
 * configuration.
 */
export function conflictBlocksAllUnitConfigurations(
  conflict: DataConflict,
): boolean {
  if (!conflict.blocking) return false;
  if (conflict.entityType === "unit") return true;
  if (conflict.entityType !== "points") return false;
  if (
    conflict.scope?.modelCount !== undefined ||
    conflict.scope?.unitOrdinalMin !== undefined ||
    conflict.scope?.unitOrdinalMax !== undefined ||
    (conflict.scope?.selectionScopes?.length ?? 0) > 0 ||
    conflict.scope?.equipmentSignature !== undefined ||
    conflict.scope?.equipmentItemId !== undefined
  ) {
    return false;
  }
  const entitySuffix = conflict.entityId.split(":").at(-1);
  return !entitySuffix || !/^\d+$/.test(entitySuffix);
}

function ordinalInScope(
  ordinal: number | undefined,
  scope: {
    unitOrdinalMin?: number;
    unitOrdinalMax?: number | null;
  },
): boolean {
  const value = ordinal ?? 1;
  return (
    (scope.unitOrdinalMin === undefined ||
      value >= scope.unitOrdinalMin) &&
    (
      scope.unitOrdinalMax === undefined ||
      scope.unitOrdinalMax === null ||
      value <= scope.unitOrdinalMax
    )
  );
}

function selectionScopeMatches(
  scope: NonNullable<
    NonNullable<
      DataConflict["scope"]
    >["selectionScopes"]
  >[number],
  unit: RosterConflictInput["units"][number],
): boolean {
  return (
    scope.modelCount === unit.modelCount &&
    ordinalInScope(unit.ordinal, scope) &&
    (
      scope.equipmentSignature === undefined ||
      scope.equipmentSignature ===
        newRecruitEquipmentSignature(unit.equipment)
    )
  );
}

export const newRecruitCatalogue =
  catalogueJson as NewRecruitCatalogueSummaryManifest;

export function getNewRecruitFactionSummary(
  factionId: string,
): NewRecruitFactionSummary | null {
  return newRecruitCatalogue.factions[factionId] ?? null;
}

export function getNewRecruitCapability(
  factionId: string,
): NewRecruitCapability {
  const faction = getNewRecruitFactionSummary(factionId);
  if (!faction || !faction.catalogue.id) {
    return {
      factionId,
      available: false,
      complete: false,
      catalogueId: null,
      catalogueName: null,
      catalogueRevision: null,
      mappedUnits: 0,
      engineUnits: faction?.coverage.engineUnits ?? 0,
      mappedBaseLoadouts: 0,
      mappedDetachments: 0,
      engineDetachments: faction?.coverage.engineDetachments ?? 0,
      blockingConflicts:
        faction?.conflicts.filter((item) => item.blocking).length ?? 0,
      reason: "No New Recruit catalogue is configured for this faction.",
    };
  }
  const blockingConflicts = faction.conflicts.filter(
    (item) => item.blocking,
  ).length;
  const available =
    faction.configurationAvailable &&
    faction.coverage.mappedUnits > 0 &&
    faction.coverage.mappedDetachments > 0;
  return {
    factionId,
    available,
    complete: faction.coverage.complete,
    catalogueId: faction.catalogue.id,
    catalogueName: faction.catalogue.name,
    catalogueRevision: faction.catalogue.revision,
    mappedUnits: faction.coverage.mappedUnits,
    engineUnits: faction.coverage.engineUnits,
    mappedBaseLoadouts: faction.coverage.mappedBaseLoadouts,
    mappedDetachments: faction.coverage.mappedDetachments,
    engineDetachments: faction.coverage.engineDetachments,
    blockingConflicts,
    reason: available
      ? faction.coverage.complete
        ? null
        : "New Recruit export is available only for rosters whose selected units and configuration have no mapping conflicts."
      : "The faction configuration or its units are not sufficiently mapped for New Recruit export.",
  };
}

export function listDataConflicts(
  filter: DataConflictFilter = {},
): DataConflictPage {
  const limit = Math.max(1, Math.min(filter.limit ?? 50, 200));
  const offset = Math.max(0, filter.offset ?? 0);
  const items = Object.values(newRecruitCatalogue.factions)
    .flatMap((faction) => faction.conflicts)
    .filter(
      (item) =>
        (!filter.factionId || item.factionId === filter.factionId) &&
        (!filter.entityType || item.entityType === filter.entityType) &&
        (filter.blocking === undefined || item.blocking === filter.blocking),
    )
    .sort(
      (left, right) =>
        left.factionId.localeCompare(right.factionId) ||
        left.entityType.localeCompare(right.entityType) ||
        left.entityName.localeCompare(right.entityName),
    );
  return {
    total: items.length,
    uniqueTotal: new Set(
      items.map((item) => item.rootCauseKey ?? item.id),
    ).size,
    offset,
    limit,
    items: items.slice(offset, offset + limit),
  };
}

export function conflictAppliesToRoster(
  item: DataConflict,
  input: RosterConflictInput,
): boolean {
  const unitIds = new Set(input.units.map((unit) => unit.unitId));
  const equipmentIds = new Set(
    input.units.flatMap((unit) =>
      unit.equipment
        .filter((equipment) => equipment.count > 0)
        .flatMap((equipment) => [
          `${unit.unitId}:${equipment.name}`,
          ...(equipment.itemId
            ? [`${unit.unitId}:${equipment.itemId}`]
            : []),
        ]),
    ),
  );
  const enhancementIds = new Set(
    input.units.flatMap((unit) =>
      unit.enhancementId ? [unit.enhancementId] : [],
    ),
  );
  if (item.entityType === "catalogue") return true;
  if (item.entityType === "detachment") {
    return item.entityId === input.detachmentId;
  }
  if (item.entityType === "unit") return unitIds.has(item.entityId);
  if (item.entityType === "points") {
    return input.units.some((unit) => {
      if (
        item.entityId !== unit.unitId &&
        !item.entityId.startsWith(`${unit.unitId}:`)
      ) {
        return false;
      }
      if (
        item.scope?.selectionScopes &&
        !item.scope.selectionScopes.some(
          (scope) => selectionScopeMatches(scope, unit),
        )
      ) {
        return false;
      }
      const legacyModelCount =
        item.scope?.modelCount === undefined &&
        item.entityId.startsWith(`${unit.unitId}:`) &&
        /^\d+$/.test(item.entityId.slice(unit.unitId.length + 1))
          ? Number(item.entityId.slice(unit.unitId.length + 1))
          : undefined;
      return (
        (item.scope?.modelCount === undefined ||
          item.scope.modelCount === unit.modelCount) &&
        ordinalInScope(unit.ordinal, item.scope ?? {}) &&
        (
          item.scope?.equipmentSignature === undefined ||
          item.scope.equipmentSignature ===
            newRecruitEquipmentSignature(unit.equipment)
        ) &&
        (legacyModelCount === undefined ||
          legacyModelCount === unit.modelCount)
      );
    });
  }
  if (item.entityType === "equipment") {
    const selectedUnits = input.units.filter(
      (candidate) =>
        item.entityId === candidate.unitId ||
        item.entityId.startsWith(`${candidate.unitId}:`),
    );
    return selectedUnits.some((unit) => {
      if (
        item.scope?.selectionScopes &&
        !item.scope.selectionScopes.some((scope) =>
          selectionScopeMatches(scope, unit),
        )
      ) {
        return false;
      }
      if (item.scope?.selectionScopes) return true;
      if (
        item.scope?.modelCount !== undefined &&
        item.scope.modelCount !== unit.modelCount
      ) {
        return false;
      }
      if (!ordinalInScope(unit.ordinal, item.scope ?? {})) {
        return false;
      }
      if (
        item.scope?.equipmentSignature !== undefined &&
        item.scope.equipmentSignature !==
          newRecruitEquipmentSignature(unit.equipment)
      ) {
        return false;
      }
      if (item.scope?.equipmentSignature !== undefined) return true;
      if (item.scope?.equipmentItemId !== undefined) {
        return unit.equipment.some(
          (equipment) =>
            equipment.count > 0 &&
            equipment.itemId ===
              item.scope?.equipmentItemId,
        );
      }
      return unitIds.has(item.entityId) ||
        equipmentIds.has(item.entityId);
    });
  }
  if (item.entityType === "enhancement") {
    return enhancementIds.has(item.entityId);
  }
  return false;
}

export function conflictsForRoster(
  input: RosterConflictInput,
): DataConflict[] {
  const faction = getNewRecruitFactionSummary(input.factionId);
  if (!faction) return [];
  return faction.conflicts.filter((item) =>
    conflictAppliesToRoster(item, input),
  );
}
