import {
  Dataset,
  dataset as embeddedDataset,
} from "@alpaca-software/40kdc-data";

/**
 * The serializable boundary of the 40kdc Dataset constructor. Keeping this
 * type derived from the installed package avoids coupling RosterPilot to an
 * internal package path that is not part of 40kdc-data's public exports.
 */
export type RuntimeRulesData = NonNullable<
  ConstructorParameters<typeof Dataset>[0]
>;

export const RUNTIME_RULE_COLLECTION_NAMES = [
  "units",
  "targetProfiles",
  "weapons",
  "weaponKeywords",
  "unitKeywords",
  "factions",
  "abilities",
  "phaseMappings",
  "detachments",
  "alliedRules",
  "stratagems",
  "enhancements",
  "leaderAttachments",
  "unitCompositions",
  "wargearOptions",
  "wargear",
  "gameVersions",
  "missions",
  "missionMatchups",
  "missionCards",
  "deploymentPatterns",
  "forceDispositions",
  "terrainTemplates",
  "terrainLayouts",
  "hullShapes",
  "resourcePools",
  "interactionFlags",
] as const satisfies readonly (keyof RuntimeRulesData)[];

export type RuntimeRuleCollectionName =
  (typeof RUNTIME_RULE_COLLECTION_NAMES)[number];

type RawBacked = { raw: unknown };

function rawRecord<T>(value: T): unknown {
  return (
    value !== null &&
    typeof value === "object" &&
    "raw" in value
  )
    ? (value as RawBacked).raw
    : value;
}

function rawCollection(
  values: readonly unknown[],
): unknown[] {
  return values.map((value) => structuredClone(rawRecord(value)));
}

/**
 * Materialize a portable rules payload from a linked 40kdc Dataset. The
 * resulting value can be signed, stored, and passed back to `new Dataset()`;
 * no executable package code is included in a runtime data bundle.
 */
export function serializeRuntimeRulesData(
  source: Dataset = embeddedDataset,
): RuntimeRulesData {
  return {
    units: rawCollection(source.units.all),
    targetProfiles: rawCollection(source.targetProfiles.all),
    weapons: rawCollection(source.weapons.all),
    weaponKeywords: rawCollection(source.weaponKeywords.all),
    unitKeywords: rawCollection(source.unitKeywords.all),
    factions: rawCollection(source.factions.all),
    abilities: rawCollection(source.abilities.all),
    phaseMappings: rawCollection(source.phaseMappings),
    detachments: rawCollection(source.detachments.all),
    alliedRules: rawCollection(source.alliedRules.all),
    stratagems: rawCollection(source.stratagems.all),
    enhancements: rawCollection(source.enhancements.all),
    leaderAttachments: rawCollection(source.leaderAttachments),
    unitCompositions: rawCollection(source.unitCompositions),
    wargearOptions: rawCollection(source.wargearOptions.all),
    wargear: rawCollection(source.wargear.all),
    gameVersions: rawCollection(source.gameVersions),
    missions: rawCollection(source.missions.all),
    missionMatchups: rawCollection(source.missionMatchups.all),
    missionCards: rawCollection(source.missionCards.all),
    deploymentPatterns: rawCollection(source.deploymentPatterns.all),
    forceDispositions: rawCollection(source.forceDispositions.all),
    terrainTemplates: rawCollection(source.terrainTemplates.all),
    terrainLayouts: rawCollection(source.terrainLayouts.all),
    hullShapes: rawCollection(source.hullShapes.all),
    resourcePools: rawCollection(source.resourcePools.all),
    interactionFlags: rawCollection(source.interactionFlags),
  } as RuntimeRulesData;
}

export function emptyRuntimeRulesData(): RuntimeRulesData {
  return Object.fromEntries(
    RUNTIME_RULE_COLLECTION_NAMES.map((name) => [name, []]),
  ) as unknown as RuntimeRulesData;
}

function canonicalRecord(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalRecord).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalRecord(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function runtimeRecordIdentity(
  collection: RuntimeRuleCollectionName,
  value: unknown,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return canonicalRecord(value);
  }
  const item = value as Record<string, unknown>;
  const scope = [
    item.faction_id,
    item.source_faction_id,
    item.detachment_id,
    item.unit_id,
  ].find((candidate) => typeof candidate === "string");
  const prefix = typeof scope === "string" ? `${scope}:` : "";
  if (typeof item.id === "string") return `${prefix}${item.id}`;
  if (typeof item.ability_id === "string") {
    return `${prefix}${item.ability_id}`;
  }
  if (
    collection === "phaseMappings" &&
    typeof item.source_type === "string" &&
    typeof item.source_id === "string"
  ) {
    return canonicalRecord(value);
  }
  if (
    collection === "leaderAttachments" &&
    typeof item.leader_id === "string"
  ) {
    return canonicalRecord(value);
  }
  return canonicalRecord(value);
}

/**
 * Reassembles global and faction shards into one deterministic Dataset input.
 * Duplicate records are accepted only when their canonical payloads match;
 * conflicting shard ownership fails closed before activation.
 */
export function mergeRuntimeRulesData(
  parts: readonly RuntimeRulesData[],
): RuntimeRulesData {
  const merged = emptyRuntimeRulesData();
  for (const collection of RUNTIME_RULE_COLLECTION_NAMES) {
    const records = new Map<
      string,
      { canonical: string; value: unknown }
    >();
    for (const part of parts) {
      for (const value of part[collection] as readonly unknown[]) {
        const identity = runtimeRecordIdentity(collection, value);
        const canonical = canonicalRecord(value);
        const existing = records.get(identity);
        if (existing && existing.canonical !== canonical) {
          throw new Error(
            `Runtime data shards disagree on ${collection} record "${identity}".`,
          );
        }
        if (!existing) {
          records.set(identity, {
            canonical,
            value: structuredClone(value),
          });
        }
      }
    }
    (merged as unknown as Record<string, unknown[]>)[collection] = [
      ...records.entries(),
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entry.value);
  }
  return merged;
}

export let dataset = embeddedDataset;
export let units = dataset.units;
export let targetProfiles = dataset.targetProfiles;
export let weapons = dataset.weapons;
export let weaponKeywords = dataset.weaponKeywords;
export let unitKeywords = dataset.unitKeywords;
export let factions = dataset.factions;
export let abilities = dataset.abilities;
export let detachments = dataset.detachments;
export let alliedRules = dataset.alliedRules;
export let stratagems = dataset.stratagems;
export let enhancements = dataset.enhancements;
export let wargearOptions = dataset.wargearOptions;
export let wargear = dataset.wargear;
export let missions = dataset.missions;
export let missionMatchups = dataset.missionMatchups;
export let missionCards = dataset.missionCards;
export let deploymentPatterns = dataset.deploymentPatterns;
export let forceDispositions = dataset.forceDispositions;
export let terrainTemplates = dataset.terrainTemplates;
export let terrainLayouts = dataset.terrainLayouts;
export let hullShapes = dataset.hullShapes;
export let resourcePools = dataset.resourcePools;

/**
 * Atomically swaps every live collection binding to one newly constructed
 * Dataset. ES-module imports observe these live bindings, so all consumers
 * move together instead of seeing a partially activated rules payload.
 */
export function activateRuntimeRulesData(
  raw: RuntimeRulesData,
): Dataset {
  return activateRuntimeDataset(createRuntimeDataset(raw));
}

export function createRuntimeDataset(
  raw: RuntimeRulesData,
): Dataset {
  return new Dataset(structuredClone(raw));
}

export function activateRuntimeDataset(next: Dataset): Dataset {
  dataset = next;
  units = next.units;
  targetProfiles = next.targetProfiles;
  weapons = next.weapons;
  weaponKeywords = next.weaponKeywords;
  unitKeywords = next.unitKeywords;
  factions = next.factions;
  abilities = next.abilities;
  detachments = next.detachments;
  alliedRules = next.alliedRules;
  stratagems = next.stratagems;
  enhancements = next.enhancements;
  wargearOptions = next.wargearOptions;
  wargear = next.wargear;
  missions = next.missions;
  missionMatchups = next.missionMatchups;
  missionCards = next.missionCards;
  deploymentPatterns = next.deploymentPatterns;
  forceDispositions = next.forceDispositions;
  terrainTemplates = next.terrainTemplates;
  terrainLayouts = next.terrainLayouts;
  hullShapes = next.hullShapes;
  resourcePools = next.resourcePools;
  return next;
}

export function resetRuntimeRulesDataForTests(): void {
  activateRuntimeRulesData(serializeRuntimeRulesData(embeddedDataset));
}
