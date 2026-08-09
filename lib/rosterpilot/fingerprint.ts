import type { RosterDraftV1 } from "./types";

function stableFingerprint(value: string): string {
  const seeds = [
    0x811c9dc5,
    0x9e3779b9,
    0x85ebca6b,
    0xc2b2ae35,
    0x27d4eb2f,
    0x165667b1,
    0xd3a2646c,
    0xfd7046c5,
  ];
  return seeds.map((seed, seedIndex) => {
    let hash = seed;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index) + seedIndex;
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }).join("");
}

function units(roster: RosterDraftV1, includeExecutionState: boolean) {
  return roster.units.map((unit) => ({
    unitId: unit.unitId,
    modelCount: unit.modelCount,
    ...(includeExecutionState
      ? { points: unit.points, isWarlord: unit.isWarlord }
      : {}),
    enhancementId: unit.enhancementId,
    equipment: unit.equipment
      .map((entry) => ({ itemId: entry.itemId, count: entry.count }))
      .sort((left, right) =>
        left.itemId.localeCompare(right.itemId) || left.count - right.count
      ),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function rosterStructuralFingerprint(roster: RosterDraftV1): string {
  return stableFingerprint(JSON.stringify({
    factionId: roster.factionId,
    pointsLimit: roster.pointsLimit,
    detachmentId: roster.detachmentId,
    units: units(roster, false),
  }));
}

export function rosterExecutionFingerprint(roster: RosterDraftV1): string {
  const rosterRulesHash = "rosterRulesHash" in roster.sourceData
    ? roster.sourceData.rosterRulesHash
    : stableFingerprint(JSON.stringify(roster.sourceData));
  return stableFingerprint(JSON.stringify({
    gameSystem: roster.gameSystem,
    factionId: roster.factionId,
    pointsLimit: roster.pointsLimit,
    totalPoints: roster.totalPoints,
    detachmentId: roster.detachmentId,
    forceDispositionId: roster.forceDispositionId,
    rosterRulesHash,
    units: units(roster, true),
  }));
}

export function rosterExportFingerprint(roster: RosterDraftV1): string {
  const mappingHash = "mappingHash" in roster.sourceData
    ? roster.sourceData.mappingHash
    : stableFingerprint(JSON.stringify(roster.sourceData));
  return stableFingerprint(JSON.stringify({
    executionFingerprint: rosterExecutionFingerprint(roster),
    mappingHash,
  }));
}
