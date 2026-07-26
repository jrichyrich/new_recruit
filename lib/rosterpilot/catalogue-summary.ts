import catalogueJson from "../../data/generated/new-recruit-summary.json";

import type {
  DataConflict,
  NewRecruitCatalogueSummaryManifest,
  NewRecruitFactionSummary,
} from "./catalogue-types";

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
  offset: number;
  limit: number;
  items: DataConflict[];
};

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
    offset,
    limit,
    items: items.slice(offset, offset + limit),
  };
}

export function conflictsForRoster(input: {
  factionId: string;
  detachmentId: string;
  units: Array<{
    unitId: string;
    modelCount?: number;
    enhancementId?: string | null;
    equipment: Array<{
      itemId?: string;
      name: string;
      count: number;
    }>;
  }>;
}): DataConflict[] {
  const faction = getNewRecruitFactionSummary(input.factionId);
  if (!faction) return [];
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
  return faction.conflicts.filter(
    (item) => {
      if (item.entityType === "catalogue") return true;
      if (item.entityType === "detachment") {
        return item.entityId === input.detachmentId;
      }
      if (item.entityType === "unit") return unitIds.has(item.entityId);
      if (item.entityType === "points") {
        return [...unitIds].some(
          (unitId) =>
            item.entityId === unitId ||
            item.entityId.startsWith(`${unitId}:`),
        );
      }
      if (item.entityType === "equipment") {
        return (
          unitIds.has(item.entityId) || equipmentIds.has(item.entityId)
        );
      }
      if (item.entityType === "enhancement") {
        return enhancementIds.has(item.entityId);
      }
      return false;
    },
  );
}
