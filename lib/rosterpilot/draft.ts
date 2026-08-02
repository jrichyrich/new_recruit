import {
  normalizeName,
  type Dataset,
  type UnitView,
} from "@alpaca-software/40kdc-data";
import type {
  z,
} from "zod";

import {
  getNewRecruitFactionSummary,
  newRecruitCatalogue,
} from "./catalogue-summary";
import {
  newRecruitCatalogueMappings,
} from "./catalogue";
import type {
  NewRecruitCatalogueManifest,
} from "./catalogue-types";
import {
  getActiveDataBundleManifest,
  getActiveOfficialAuthority,
} from "./active-data-context";
import { dataset } from "./runtime-dataset";
import {
  ROSTER_SCHEMA_VERSION,
  LegacyRosterDraftV2Schema,
  RosterDraftV1Schema,
  RosterDraftV3Schema,
  type LegacyRosterDraftV1,
  type LegacyRosterDraftV2,
  type ResultEnvelope,
  type RosterDataChangedScope,
  type RosterDataRebaseResult,
  type RosterDraftV3,
  type RosterIssue,
} from "./types";

const ENGINE_DATA_SCHEMA_VERSION = 1;

type RosterSourceProvenance = Omit<
  RosterDraftV3["sourceData"],
  | "bundleId"
  | "engineDataSchemaVersion"
  | "rosterRulesHash"
  | "factionRulesHash"
  | "mappingHash"
  | "entityHashes"
  | "identityStatus"
  | "migratedFrom"
>;

export type RosterCompatibilityFactionIdentity = {
  factionRulesHash: string;
  mappingHash: string;
  entityHashes: Record<string, string>;
};

/**
 * Narrow synchronous adapter for an already-verified bundle snapshot.
 * Runtime providers may acquire and verify snapshots asynchronously, then pass
 * this immutable compatibility view into roster stamping or rebasing.
 */
export type RosterCompatibilitySnapshot = {
  bundleId: string;
  engineDataSchemaVersion: number;
  provenance: RosterSourceProvenance;
  factions: Record<string, RosterCompatibilityFactionIdentity>;
};

export type ParsedRosterDraft =
  | {
      success: true;
      data: RosterDraftV3;
      migrated: boolean;
      migratedFrom: 1 | 2 | null;
    }
  | {
      success: false;
      error: z.ZodError;
    };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Synchronous, dependency-free SHA-256 keeps roster construction available in
// browsers and Workers while matching bundle-manifest digest semantics.
function sha256(value: string): string {
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotate = (word: number, amount: number) =>
    (word >>> amount) | (word << (32 - amount));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const left =
        rotate(words[index - 15], 7) ^
        rotate(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const right =
        rotate(words[index - 2], 17) ^
        rotate(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] =
        (words[index - 16] + left + words[index - 7] + right) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const upper =
        rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h + upper + choose + constants[index] + words[index]) >>> 0;
      const lower =
        rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (lower + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) {
      state[index] = (state[index] + word) >>> 0;
    }
  }
  return [...state]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

function semanticHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sourceProvenance(factionId: string): RosterSourceProvenance {
  const manifest = newRecruitCatalogue;
  const faction = getNewRecruitFactionSummary(factionId);
  return {
    package: manifest.sources.rules.package,
    version: manifest.sources.rules.version,
    edition: manifest.sources.rules.edition,
    dataslate: manifest.sources.rules.dataslate,
    releaseId: manifest.releaseId,
    newRecruit: {
      repository: manifest.sources.newRecruit.repository,
      commit: manifest.sources.newRecruit.commit,
      gameSystemRevision: manifest.gameSystem.revision,
      catalogueRevision: faction?.catalogue.revision ?? null,
    },
    official: {
      mfmVersion: manifest.sources.official.mfmVersion,
      updatedAt: manifest.sources.official.updatedAt,
      contentSha256: manifest.sources.official.contentSha256,
      authority:
        getActiveOfficialAuthority() ?? {
          status: "unverified-overlay",
          reason:
            "Compiled application data has no verified signed official-extractor evidence binding.",
        },
    },
  };
}

function datasetFactionAncestry(
  source: Dataset,
  factionId: string,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current = source.factions.get(factionId);
  while (current && !seen.has(current.id)) {
    ids.push(current.id);
    seen.add(current.id);
    const parentId = current.raw.parent_faction_id;
    current = parentId
      ? source.factions.get(parentId)
      : undefined;
  }
  return ids;
}

function datasetFactionUnits(
  source: Dataset,
  factionId: string,
): UnitView[] {
  const seen = new Set<string>();
  const result: UnitView[] = [];
  for (const sourceFactionId of datasetFactionAncestry(
    source,
    factionId,
  )) {
    for (const unit of source.units.byFaction(sourceFactionId)) {
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      result.push(unit);
    }
  }
  return result;
}

function unitSemanticPayload(
  source: Dataset,
  factionId: string,
  unitId: string,
) {
  const unit = datasetFactionUnits(source, factionId).find(
    (candidate) => candidate.id === unitId,
  );
  if (!unit) return null;
  return {
    unit: Object.fromEntries(
      Object.entries(unit.raw).filter(
        ([key]) => key !== "weapon_ids",
      ),
    ),
    abilities: unit.abilities
      .map((ability) => ability.raw)
      .sort((left, right) =>
        left.ability_id.localeCompare(right.ability_id),
      ),
    composition: source.unitCompositionOf(unit.raw) ?? null,
    leaderAttachments: source.leaderAttachments
      .filter(
        (attachment) =>
          attachment.leader_id === unitId ||
          attachment.eligible_bodyguard_ids.includes(unitId),
      )
      .sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      ),
  };
}

function detachmentSemanticPayload(
  source: Dataset,
  detachmentId: string,
) {
  const detachment = source.detachments.all.find(
    (candidate) => candidate.id === detachmentId,
  );
  if (!detachment) return null;
  const enhancementSet = new Set(detachment.enhancement_ids ?? []);
  const stratagemSet = new Set(detachment.stratagem_ids ?? []);
  const abilityIds = new Set(
    [
      detachment.detachment_rule_id,
      ...source.enhancements.all
        .filter((entry) => enhancementSet.has(entry.id))
        .flatMap((entry) => entry.ability_id ?? []),
    ].filter((value): value is string => Boolean(value)),
  );
  return {
    detachment,
    enhancements: source.enhancements.all
      .filter((entry) => enhancementSet.has(entry.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    stratagems: source.stratagems.all
      .filter((entry) => stratagemSet.has(entry.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    abilities: source.abilities.all
      .filter((entry) => abilityIds.has(entry.id))
      .map((entry) => entry.raw)
      .sort((left, right) =>
        left.ability_id.localeCompare(right.ability_id),
      ),
  };
}

function equipmentSemanticPayload(
  source: Dataset,
  factionId: string,
  unitId: string,
  itemId: string,
) {
  const unit = datasetFactionUnits(source, factionId).find(
    (candidate) => candidate.id === unitId,
  );
  return {
    weapon:
      unit?.weapons.find((weapon) => weapon.id === itemId)?.raw ?? null,
    options:
      unit?.wargearOptions
        .filter((option) =>
          canonicalJson(option).includes(`"${itemId}"`),
        )
        .sort((left, right) => left.id.localeCompare(right.id)) ?? [],
  };
}

function mappingConfigurationBasePayload(
  catalogue: NewRecruitCatalogueManifest,
  factionId: string,
) {
  const configuration =
    catalogue.factions[factionId]?.configuration;
  if (!configuration) return null;
  return {
    // These values are written into every ROS/ROSZ root. A game-system
    // revision is therefore an export-compatibility change, not a global
    // gameplay or methodology change.
    gameSystem: catalogue.gameSystem,
    category: configuration.category,
    battleSize: configuration.battleSize.reference,
    detachment: configuration.detachment.reference,
    forceDisposition: configuration.forceDisposition.reference,
  };
}

function mappingUnitBasePayload(
  mapping:
    | NewRecruitCatalogueManifest["factions"][string]["units"][string]
    | undefined,
) {
  if (!mapping) return null;
  const excludedKeys = new Set([
    // BSData classification hints are reconciliation evidence only. Runtime
    // Games Workshop classification decides whether a roster is a Legend.
    "classificationSignals",
    // These export paths receive narrower entity hashes below.
    "directEquipment",
    "models",
    "warlord",
    "enhancements",
    "pointsByModelCount",
  ]);
  return Object.fromEntries(
    Object.entries(mapping).filter(
      ([key]) => !excludedKeys.has(key),
    ),
  );
}

function normalizedMappingName(value: string): string {
  return normalizeName(
    value
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function mappingModelNameRank(
  modelName: string | null,
  reference: {
    name: string;
  },
): number {
  if (!modelName) return 3;
  const expected = normalizedMappingName(modelName);
  const actual = normalizedMappingName(reference.name);
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

/**
 * Model entry identity is always selected because it controls the ROS
 * hierarchy. Equipment paths are included here only when model-name matching
 * leaves more than one candidate and the resolver must inspect the candidates'
 * complete equipment inventories to break the tie. This preserves fail-closed
 * behavior without coupling an ordinary roster to unrelated loadout paths.
 */
function mappingUnitModelsPayload(
  source: Dataset,
  unit: UnitView,
  mapping:
    | NewRecruitCatalogueManifest["factions"][string]["units"][string]
    | undefined,
) {
  if (!mapping) return null;
  const ambiguousEntryIds = new Set<string>();
  const composition = source.unitCompositionOf(unit.raw);
  const modelNames =
    composition?.models.map((model) => model.name) ?? [null];
  for (const modelName of modelNames) {
    const minimumRank = Math.min(
      ...mapping.models.map((model) =>
        mappingModelNameRank(modelName, model),
      ),
    );
    const candidates = mapping.models.filter(
      (model) =>
        mappingModelNameRank(modelName, model) === minimumRank,
    );
    if (candidates.length > 1) {
      for (const candidate of candidates) {
        ambiguousEntryIds.add(candidate.entryId);
      }
    }
  }
  return mapping.models
    .map((model) => {
      const {
        equipment,
        ...base
      } = model;
      return {
        ...base,
        ...(ambiguousEntryIds.has(model.entryId)
          ? {
              equipment: [...equipment].sort((left, right) =>
                left.entryId.localeCompare(right.entryId),
              ),
            }
          : {}),
      };
    })
    .sort((left, right) =>
      left.entryId.localeCompare(right.entryId),
    );
}

function mappingUnitEquipmentPayload(
  mapping:
    | NewRecruitCatalogueManifest["factions"][string]["units"][string]
    | undefined,
  equipmentName: string,
) {
  if (!mapping) return null;
  const expected = normalizedMappingName(equipmentName);
  const matches = (reference: { name: string }) =>
    normalizedMappingName(reference.name) === expected;
  return {
    directEquipment: mapping.directEquipment
      .filter(matches)
      .sort((left, right) =>
        left.entryId.localeCompare(right.entryId),
      ),
    models: mapping.models
      .map((model) => ({
        modelEntryId: model.entryId,
        equipment: model.equipment
          .filter(matches)
          .sort((left, right) =>
            left.entryId.localeCompare(right.entryId),
          ),
      }))
      .filter((model) => model.equipment.length > 0)
      .sort((left, right) =>
        left.modelEntryId.localeCompare(right.modelEntryId),
      ),
  };
}

const bootstrapIdentityCache = new Map<
  string,
  RosterCompatibilityFactionIdentity
>();

export function resetRosterCompatibilityIdentityCache(): void {
  bootstrapIdentityCache.clear();
}

export function currentRosterCompatibilityFactionIdentity(
  factionId: string,
): RosterCompatibilityFactionIdentity {
  const active =
    getActiveDataBundleManifest()?.semanticHashes.factions[factionId];
  if (active) {
    return {
      factionRulesHash: active.factionRulesHash,
      mappingHash: active.mappingHash,
      entityHashes: { ...active.entityHashes },
    };
  }
  const cached = bootstrapIdentityCache.get(factionId);
  if (cached) return cached;
  const identity = deriveRosterCompatibilityFactionIdentity({
    source: dataset,
    catalogue: newRecruitCatalogueMappings,
    factionId,
  });
  bootstrapIdentityCache.set(factionId, identity);
  return identity;
}

export function deriveRosterCompatibilityFactionIdentity(input: {
  source: Dataset;
  catalogue: NewRecruitCatalogueManifest;
  factionId: string;
}): RosterCompatibilityFactionIdentity {
  const { source, catalogue, factionId } = input;
  const ancestry = datasetFactionAncestry(source, factionId);
  const faction = source.factions.get(factionId);
  const mapping = catalogue.factions[factionId];
  const entityHashes: Record<string, string> = {};
  entityHashes[`faction:${factionId}`] = semanticHash({
    faction: faction?.raw ?? null,
    ancestry,
    factions: ancestry
      .map((id) => source.factions.get(id)?.raw ?? null),
    abilities: ancestry
      .flatMap(
        (id) =>
          source.factions.get(id)?.abilities.map(
            (ability) => ability.raw,
          ) ?? [],
      )
        .sort((left, right) =>
          left.ability_id.localeCompare(right.ability_id),
        ),
  });
  const factionUnits = datasetFactionUnits(source, factionId)
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const unit of factionUnits) {
    entityHashes[`unit:${unit.id}`] = semanticHash(
      unitSemanticPayload(source, factionId, unit.id),
    );
    for (const weapon of unit.weapons) {
      entityHashes[`equipment:${unit.id}:${weapon.id}`] = semanticHash(
        equipmentSemanticPayload(
          source,
          factionId,
          unit.id,
          weapon.id,
        ),
      );
    }
    const unitMapping = mapping?.units[unit.id];
    entityHashes[`mapping:unit:${unit.id}:base`] = semanticHash(
      mappingUnitBasePayload(unitMapping),
    );
    entityHashes[`mapping:unit:${unit.id}:models`] = semanticHash(
      mappingUnitModelsPayload(source, unit, unitMapping),
    );
    entityHashes[`mapping:unit:${unit.id}:warlord`] = semanticHash(
      unitMapping?.warlord ?? null,
    );
    for (const [modelCount, points] of Object.entries(
      unitMapping?.pointsByModelCount ?? {},
    )) {
      entityHashes[
        `mapping:unit:${unit.id}:points:${modelCount}`
      ] = semanticHash(points);
    }
    for (const [enhancementId, enhancement] of Object.entries(
      unitMapping?.enhancements ?? {},
    )) {
      entityHashes[
        `mapping:unit:${unit.id}:enhancement:${enhancementId}`
      ] = semanticHash(enhancement);
    }
    for (const weapon of unit.weapons) {
      entityHashes[
        `mapping:unit:${unit.id}:equipment:${weapon.id}`
      ] = semanticHash(
        mappingUnitEquipmentPayload(
          unitMapping,
          weapon.raw.name,
        ),
      );
    }
  }
  const factionUnitIds = new Set(factionUnits.map((unit) => unit.id));
  for (const [unitId, unitMapping] of Object.entries(
    mapping?.units ?? {},
  )) {
    if (factionUnitIds.has(unitId)) continue;
    entityHashes[`mapping:orphan-unit:${unitId}`] = semanticHash(
      unitMapping,
    );
  }
  const factionDetachments = ancestry.flatMap((sourceFactionId) =>
    source.detachments.byFaction(sourceFactionId),
  );
  for (const detachment of factionDetachments.sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    entityHashes[`detachment:${detachment.id}`] = semanticHash(
      detachmentSemanticPayload(source, detachment.id),
    );
    for (const enhancementId of detachment.enhancement_ids ?? []) {
      entityHashes[`enhancement:${enhancementId}`] = semanticHash(
        source.enhancements.all.find(
          (entry) => entry.id === enhancementId,
        ) ??
          null,
      );
    }
  }
  for (const disposition of source.forceDispositions.all) {
    entityHashes[`force-disposition:${disposition.id}`] =
      semanticHash(disposition);
  }
  entityHashes["mapping:configuration:base"] = semanticHash(
    mappingConfigurationBasePayload(catalogue, factionId),
  );
  const configuration = mapping?.configuration;
  entityHashes["mapping:configuration:legends-visibility"] =
    semanticHash(configuration?.legendsVisibility ?? null);
  entityHashes["mapping:classification-evidence:legends"] =
    semanticHash(
      mapping?.classificationEvidence?.legendCandidates ?? [],
    );
  for (const [battleSize, choice] of Object.entries(
    configuration?.battleSize.choices ?? {},
  )) {
    entityHashes[
      `mapping:configuration:battle-size:${battleSize}`
    ] = semanticHash(choice);
  }
  for (const [detachmentId, choice] of Object.entries(
    configuration?.detachment.choices ?? {},
  )) {
    entityHashes[
      `mapping:configuration:detachment:${detachmentId}`
    ] = semanticHash(choice);
  }
  for (const [dispositionId, choice] of Object.entries(
    configuration?.forceDisposition.choices ?? {},
  )) {
    entityHashes[
      `mapping:configuration:force-disposition:${dispositionId}`
    ] = semanticHash(choice);
  }
  const ruleHashes = Object.entries(entityHashes)
    .filter(([key]) => !key.startsWith("mapping:"))
    .sort(([left], [right]) => left.localeCompare(right));
  const mappingHashes = Object.entries(entityHashes)
    .filter(([key]) => key.startsWith("mapping:"))
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    factionRulesHash: semanticHash(ruleHashes),
    mappingHash: semanticHash(mappingHashes),
    entityHashes,
  };
}

function bootstrapSnapshot(factionId: string): RosterCompatibilitySnapshot {
  const provenance = sourceProvenance(factionId);
  const active = getActiveDataBundleManifest();
  return {
    bundleId:
      active?.bundleId ??
      semanticHash({
        releaseId: newRecruitCatalogue.releaseId,
        sources: newRecruitCatalogue.sources,
        gameSystem: newRecruitCatalogue.gameSystem,
      }),
    engineDataSchemaVersion:
      active?.engineDataSchemaVersion ??
      ENGINE_DATA_SCHEMA_VERSION,
    provenance,
    factions: {
      [factionId]:
        currentRosterCompatibilityFactionIdentity(factionId),
    },
  };
}

function selectedEntityKeys(roster: {
  factionId: string;
  battleSize: RosterDraftV3["battleSize"];
  detachmentId: string;
  forceDispositionId: string;
  units: RosterDraftV3["units"];
}): string[] {
  const factionUnitsById = new Map(
    datasetFactionUnits(dataset, roster.factionId).map((unit) => [
      unit.id,
      unit,
    ]),
  );
  const selectsLegend = roster.units.some(
    (unit) =>
      factionUnitsById.get(unit.unitId)?.raw.is_legend === true,
  );
  return [
    `faction:${roster.factionId}`,
    `detachment:${roster.detachmentId}`,
    `force-disposition:${roster.forceDispositionId}`,
    "mapping:configuration:base",
    `mapping:configuration:battle-size:${roster.battleSize}`,
    `mapping:configuration:detachment:${roster.detachmentId}`,
    `mapping:configuration:force-disposition:${roster.forceDispositionId}`,
    ...(selectsLegend
      ? ["mapping:configuration:legends-visibility"]
      : []),
    ...roster.units.flatMap((unit) => [
      `unit:${unit.unitId}`,
      `mapping:unit:${unit.unitId}:base`,
      `mapping:unit:${unit.unitId}:models`,
      `mapping:unit:${unit.unitId}:points:${unit.modelCount}`,
      ...(unit.isWarlord
        ? [`mapping:unit:${unit.unitId}:warlord`]
        : []),
      ...(unit.enhancementId
        ? [
            `enhancement:${unit.enhancementId}`,
            `mapping:unit:${unit.unitId}:enhancement:${unit.enhancementId}`,
          ]
        : []),
      ...unit.equipment
        .filter((entry) => entry.count > 0)
        .flatMap((entry) => [
          `equipment:${unit.unitId}:${entry.itemId}`,
          `mapping:unit:${unit.unitId}:equipment:${entry.itemId}`,
        ]),
    ]),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function identityForRoster(
  roster: Omit<RosterDraftV3, "sourceData"> & {
    sourceData?: RosterDraftV3["sourceData"];
  },
  snapshot: RosterCompatibilitySnapshot,
): Pick<
  RosterDraftV3["sourceData"],
  | "bundleId"
  | "engineDataSchemaVersion"
  | "rosterRulesHash"
  | "factionRulesHash"
  | "mappingHash"
  | "entityHashes"
  | "identityStatus"
> {
  const faction = snapshot.factions[roster.factionId];
  if (!faction) {
    throw new Error(
      `Bundle ${snapshot.bundleId} has no compatibility identity for ${roster.factionId}.`,
    );
  }
  const keys = selectedEntityKeys(roster);
  const entityHashes = Object.fromEntries(
    keys
      .map((key) => [key, faction.entityHashes[key]] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const ruleEntities = Object.entries(entityHashes).filter(
    ([key]) => !key.startsWith("mapping:"),
  );
  const mappingEntities = Object.entries(entityHashes).filter(([key]) =>
    key.startsWith("mapping:"),
  );
  return {
    bundleId: snapshot.bundleId,
    engineDataSchemaVersion: snapshot.engineDataSchemaVersion,
    rosterRulesHash: semanticHash({
      factionId: roster.factionId,
      detachmentId: roster.detachmentId,
      forceDispositionId: roster.forceDispositionId,
      selections: roster.units
        .map((unit) => ({
          unitId: unit.unitId,
          modelCount: unit.modelCount,
          points: unit.points,
          enhancementId: unit.enhancementId,
          equipment: unit.equipment
            .filter((entry) => entry.count > 0)
            .map((entry) => ({
              itemId: entry.itemId,
              count: entry.count,
            }))
            .sort((left, right) =>
              left.itemId.localeCompare(right.itemId),
            ),
        }))
        .sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        ),
      entities: ruleEntities,
    }),
    factionRulesHash: faction.factionRulesHash,
    mappingHash: semanticHash({
      selections: roster.units
        .map((unit) => ({
          unitId: unit.unitId,
          modelCount: unit.modelCount,
          enhancementId: unit.enhancementId,
          equipment: unit.equipment
            .filter((entry) => entry.count > 0)
            .map((entry) => ({
              itemId: entry.itemId,
              count: entry.count,
            }))
            .sort((left, right) =>
              left.itemId.localeCompare(right.itemId),
            ),
        }))
        .sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        ),
      entities: mappingEntities,
    }),
    entityHashes,
    identityStatus: "verified",
  };
}

export function currentRosterSourceData(
  factionId: string,
  migratedFrom?: 1 | 2,
): RosterDraftV3["sourceData"] {
  const snapshot = bootstrapSnapshot(factionId);
  const faction = snapshot.factions[factionId];
  return {
    ...snapshot.provenance,
    bundleId: snapshot.bundleId,
    engineDataSchemaVersion: snapshot.engineDataSchemaVersion,
    rosterRulesHash: faction.factionRulesHash,
    factionRulesHash: faction.factionRulesHash,
    mappingHash: faction.mappingHash,
    entityHashes: { ...faction.entityHashes },
    identityStatus: "verified",
    ...(migratedFrom ? { migratedFrom } : {}),
  };
}

export function stampRosterDataIdentity(
  roster: RosterDraftV3,
  snapshot: RosterCompatibilitySnapshot = bootstrapSnapshot(
    roster.factionId,
  ),
): RosterDraftV3 {
  const identity = identityForRoster(roster, snapshot);
  return {
    ...roster,
    sourceData: {
      ...snapshot.provenance,
      ...identity,
      ...(roster.sourceData.migratedFrom
        ? { migratedFrom: roster.sourceData.migratedFrom }
        : {}),
    },
  };
}

function embeddedLegacyIdentity(
  roster: LegacyRosterDraftV1 | LegacyRosterDraftV2,
): Pick<
  RosterDraftV3["sourceData"],
  | "rosterRulesHash"
  | "factionRulesHash"
  | "mappingHash"
  | "entityHashes"
> {
  const entityHashes = Object.fromEntries(
    [
      [
        `faction:${roster.factionId}`,
        semanticHash({ factionId: roster.factionId }),
      ],
      [
        `detachment:${roster.detachmentId}`,
        semanticHash({
          id: roster.detachmentId,
          name: roster.detachmentName,
        }),
      ],
      [
        `force-disposition:${roster.forceDispositionId}`,
        semanticHash({
          id: roster.forceDispositionId,
          name: roster.forceDispositionName,
        }),
      ],
      ...roster.units.flatMap((unit) => [
        [
          `unit:${unit.unitId}`,
          semanticHash({
            unitId: unit.unitId,
            name: unit.name,
            role: unit.role,
            modelCount: unit.modelCount,
            points: unit.points,
          }),
        ],
        ...unit.equipment.map((entry) => [
          `equipment:${unit.unitId}:${entry.itemId}`,
          semanticHash(entry),
        ]),
        ...(unit.enhancementId
          ? [
              [
                `enhancement:${unit.enhancementId}`,
                semanticHash({
                  id: unit.enhancementId,
                  name: unit.enhancementName,
                }),
              ],
            ]
          : []),
      ]),
    ] as Array<[string, string]>,
  );
  const embeddedRules = {
    factionId: roster.factionId,
    detachmentId: roster.detachmentId,
    forceDispositionId: roster.forceDispositionId,
    units: roster.units.map((unit) => ({
      unitId: unit.unitId,
      modelCount: unit.modelCount,
      points: unit.points,
      enhancementId: unit.enhancementId,
      equipment: unit.equipment,
    })),
  };
  return {
    rosterRulesHash: semanticHash(embeddedRules),
    factionRulesHash: semanticHash({
      legacyFactionId: roster.factionId,
      embeddedRules,
    }),
    mappingHash: semanticHash({
      legacySourceData: roster.sourceData,
      selectedEntities: Object.keys(entityHashes),
    }),
    entityHashes,
  };
}

export function migrateRosterDraftV1(
  draft: LegacyRosterDraftV1,
): RosterDraftV3 {
  const provenance = sourceProvenance(draft.factionId);
  return {
    ...draft,
    schemaVersion: ROSTER_SCHEMA_VERSION,
    sourceData: {
      ...provenance,
      bundleId: semanticHash({
        legacySchemaVersion: 1,
        sourceData: draft.sourceData,
      }),
      engineDataSchemaVersion: ENGINE_DATA_SCHEMA_VERSION,
      ...embeddedLegacyIdentity(draft),
      identityStatus: "legacy-derived",
      migratedFrom: 1,
    },
  };
}

export function migrateRosterDraftV2(
  draft: LegacyRosterDraftV2,
): RosterDraftV3 {
  const provenance = {
    package: draft.sourceData.package,
    version: draft.sourceData.version,
    edition: draft.sourceData.edition,
    dataslate: draft.sourceData.dataslate,
    releaseId: draft.sourceData.releaseId,
    newRecruit: draft.sourceData.newRecruit,
    official: draft.sourceData.official,
  };
  return {
    ...draft,
    schemaVersion: ROSTER_SCHEMA_VERSION,
    sourceData: {
      ...provenance,
      bundleId: semanticHash({
        legacySchemaVersion: 2,
        provenance,
      }),
      engineDataSchemaVersion: ENGINE_DATA_SCHEMA_VERSION,
      ...embeddedLegacyIdentity(draft),
      identityStatus: "legacy-derived",
      migratedFrom: 2,
    },
  };
}

export function parseRosterDraft(value: unknown): ParsedRosterDraft {
  const current = RosterDraftV3Schema.safeParse(value);
  if (current.success) {
    return {
      success: true,
      data: current.data,
      migrated: false,
      migratedFrom: null,
    };
  }
  const legacyV2 = LegacyRosterDraftV2Schema.safeParse(value);
  if (legacyV2.success) {
    return {
      success: true,
      data: migrateRosterDraftV2(legacyV2.data),
      migrated: true,
      migratedFrom: 2,
    };
  }
  const legacyV1 = RosterDraftV1Schema.safeParse(value);
  if (legacyV1.success) {
    return {
      success: true,
      data: migrateRosterDraftV1(legacyV1.data),
      migrated: true,
      migratedFrom: 1,
    };
  }
  return { success: false, error: current.error };
}

function changedScope(
  key: string,
  previousHash: string | undefined,
  currentHash: string | undefined,
  unverifiable = false,
): RosterDataChangedScope {
  const [prefix, ...rest] = key.split(":");
  const kind =
    prefix === "mapping"
      ? "mapping"
      : prefix === "force-disposition"
        ? "force-disposition"
        : (
            [
              "faction",
              "detachment",
              "unit",
              "equipment",
              "enhancement",
            ] as const
          ).includes(
            prefix as
              | "faction"
              | "detachment"
              | "unit"
              | "equipment"
              | "enhancement",
          )
          ? (prefix as RosterDataChangedScope["kind"])
          : "unknown";
  return {
    kind,
    entityId: rest.join(":") || key,
    change: unverifiable
      ? "unverifiable"
      : previousHash === undefined
        ? "added"
        : currentHash === undefined
          ? "removed"
          : "changed",
    previousHash: previousHash ?? null,
    currentHash: currentHash ?? null,
  };
}

function sameProvenance(
  left: RosterDraftV3["sourceData"],
  right: RosterDraftV3["sourceData"],
): boolean {
  const omitIdentity = (source: RosterDraftV3["sourceData"]) => ({
    package: source.package,
    version: source.version,
    edition: source.edition,
    dataslate: source.dataslate,
    releaseId: source.releaseId,
    newRecruit: source.newRecruit,
    official: source.official,
  });
  return canonicalJson(omitIdentity(left)) === canonicalJson(omitIdentity(right));
}

export function rosterSourceDataCompatibleForExport(
  left: RosterDraftV3["sourceData"],
  right: RosterDraftV3["sourceData"],
): boolean {
  return (
    left.engineDataSchemaVersion === right.engineDataSchemaVersion &&
    left.rosterRulesHash === right.rosterRulesHash &&
    left.mappingHash === right.mappingHash
  );
}

export function rebaseRosterData(
  value: unknown,
  options: {
    snapshot?: RosterCompatibilitySnapshot;
  } = {},
): ResultEnvelope<RosterDataRebaseResult> {
  const parsed = parseRosterDraft(value);
  if (!parsed.success) {
    const violation: RosterIssue = {
      code: "ROSTER_SCHEMA_INVALID",
      message: "The roster is not a readable V1, V2, or V3 draft.",
      severity: "error",
    };
    return {
      ok: false,
      data: null,
      violations: [violation],
      warnings: [],
    };
  }
  const roster = parsed.data;
  const snapshot =
    options.snapshot ?? bootstrapSnapshot(roster.factionId);
  const targetIdentity = identityForRoster(roster, snapshot);
  const targetSourceData: RosterDraftV3["sourceData"] = {
    ...snapshot.provenance,
    ...targetIdentity,
  };
  const provenanceChanged = !sameProvenance(
    roster.sourceData,
    targetSourceData,
  );
  if (
    roster.sourceData.identityStatus === "verified" &&
    roster.sourceData.bundleId === targetSourceData.bundleId
  ) {
    if (
      canonicalJson(roster.sourceData) !==
      canonicalJson(targetSourceData)
    ) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "ROSTER_DATA_INTEGRITY_MISMATCH",
            message:
              "The roster names the active data bundle, but its embedded provenance or semantic hashes do not match that signed bundle.",
            severity: "error",
          },
        ],
        warnings: [],
      };
    }
    return {
      ok: true,
      data: {
        status: "current",
        roster,
        fromBundleId: roster.sourceData.bundleId,
        toBundleId: targetSourceData.bundleId,
        provenanceChanged: false,
        changedScopes: [],
      },
      violations: [],
      warnings: [],
    };
  }
  const keys = new Set([
    ...Object.keys(roster.sourceData.entityHashes),
    ...Object.keys(targetSourceData.entityHashes),
  ]);
  const unverifiable =
    roster.sourceData.identityStatus === "legacy-derived" &&
    !(
      roster.sourceData.migratedFrom === 2 &&
      sameProvenance(roster.sourceData, targetSourceData)
    );
  const changedScopes = [...keys]
    .filter(
      (key) =>
        unverifiable ||
        roster.sourceData.entityHashes[key] !==
          targetSourceData.entityHashes[key],
    )
    .sort()
    .map((key) =>
      changedScope(
        key,
        roster.sourceData.entityHashes[key],
        targetSourceData.entityHashes[key],
        unverifiable,
      ),
    );
  const semanticsCompatible =
    !unverifiable &&
    (
      (
        roster.sourceData.identityStatus === "legacy-derived" &&
        roster.sourceData.migratedFrom === 2 &&
        sameProvenance(roster.sourceData, targetSourceData)
      ) ||
      (
        roster.sourceData.rosterRulesHash ===
          targetSourceData.rosterRulesHash &&
        roster.sourceData.mappingHash === targetSourceData.mappingHash &&
        roster.sourceData.engineDataSchemaVersion ===
          targetSourceData.engineDataSchemaVersion
      )
    );
  if (semanticsCompatible) {
    return {
      ok: true,
      data: {
        status: "compatible-rebased",
        roster: {
          ...roster,
          sourceData: targetSourceData,
        },
        fromBundleId: roster.sourceData.bundleId,
        toBundleId: targetSourceData.bundleId,
        provenanceChanged,
        changedScopes: [],
      },
      violations: [],
      warnings: provenanceChanged
        ? [
            {
              code: "DATA_PROVENANCE_CHANGED",
              message:
                "The roster was rebound to the current bundle because every referenced rules and export-mapping semantic hash is unchanged.",
              severity: "warn",
            },
          ]
        : [],
    };
  }
  return {
    ok: true,
    data: {
      status: "review-required",
      roster,
      fromBundleId: roster.sourceData.bundleId,
      toBundleId: targetSourceData.bundleId,
      provenanceChanged,
      changedScopes,
    },
    violations: [],
    warnings: [
      {
        code: "ROSTER_DATA_REVIEW_REQUIRED",
        message:
          "Referenced rules or New Recruit mappings changed. Review the listed scopes before rebasing; roster selections were not modified.",
        severity: "warn",
      },
      {
        code: "DATA_SEMANTICS_CHANGED",
        message:
          "The target data bundle is not semantically equivalent for this roster.",
        severity: "warn",
      },
    ],
  };
}
