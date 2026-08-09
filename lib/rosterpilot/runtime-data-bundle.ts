import type {
  NewRecruitCatalogueManifest,
  NewRecruitCatalogueSummaryManifest,
} from "./catalogue-types";
import {
  activateNewRecruitCatalogueMappings,
  newRecruitCatalogueMappings,
} from "./catalogue";
import {
  activateNewRecruitCatalogueSummary,
  newRecruitCatalogue,
} from "./catalogue-summary";
import {
  createRuntimeDataset,
  activateRuntimeDataset,
  emptyRuntimeRulesData,
  mergeRuntimeRulesData,
  RUNTIME_RULE_COLLECTION_NAMES,
  serializeRuntimeRulesData,
  type RuntimeRuleCollectionName,
  type RuntimeRulesData,
} from "./runtime-dataset";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
  type DataBundleSemanticHashesV1,
} from "./semantic-hash";
import {
  createDataBundleSnapshot,
  createSignedDataBundleManifest,
  verifyDataBundleManifest,
  verifyDataBundleShard,
  type DataBundleManifestDraftV1,
  type DataBundleManifestV1,
  type DataBundleSnapshot,
  type DataBundleOfficialAuthorityStatus,
  type DataBundleShardDescriptorV1,
  type DataBundleShardV1,
  type DataBundleSigner,
  type DataBundleVerificationResult,
  type Ed25519KeyRegistry,
  type VerifiedAcceptedDataBundleManifestV1,
  type VerifiedDataBundleManifestV1,
  type VerifiedDataBundleShardV1,
} from "./data-bundle";
import {
  deriveRosterCompatibilityFactionIdentity,
  resetRosterCompatibilityIdentityCache,
  type RosterCompatibilitySnapshot,
} from "./draft";
import {
  refreshRuntimeDataConstants,
} from "./engine";
import {
  setActiveDataBundleManifest,
} from "./active-data-context";
import {
  OfficialRulesOverlaySchema,
  applyOfficialRulesOverlay,
  verifyOfficialRulesOverlayCoverage,
  type OfficialCommunityConflict,
  type OfficialRulesOverlay,
} from "./official-data";
import {
  RuntimeFactionLegendsStateSchema,
  activateLegendsInventory,
  unavailableFactionLegendsState,
  type RuntimeFactionLegendsState,
} from "./legends";

export const RUNTIME_DATA_BUNDLE_SCHEMA_VERSION = 2;
export const RUNTIME_DATA_BUNDLE_SUPPORTED_SCHEMA_VERSIONS = [
  1, 2,
] as const;
export const RUNTIME_DATA_BUNDLE_MEDIA_TYPE =
  "application/vnd.rosterpilot.data-shard+json";

export function isSupportedRuntimeDataBundleSchemaVersion(
  version: number,
): version is 1 | 2 {
  return RUNTIME_DATA_BUNDLE_SUPPORTED_SCHEMA_VERSIONS.includes(
    version as 1 | 2,
  );
}

type CatalogueBase = Pick<
  NewRecruitCatalogueManifest,
  "schemaVersion" | "gameSystem"
>;
type CatalogueSummaryBase = Pick<
  NewRecruitCatalogueSummaryManifest,
  "schemaVersion" | "gameSystem"
>;

export type RuntimeGlobalShardDataV1 = {
  payloadKind: "rosterpilot-runtime-global";
  schemaVersion: 1;
  /** Rules records that are not owned by one faction. */
  rulesData: RuntimeRulesData;
  catalogueBase: CatalogueBase;
  catalogueSummaryBase: CatalogueSummaryBase;
  certificationDefaults: unknown;
  certificationBrowserFixtures: unknown;
  officialReconciliation: {
    overlayHash: string;
    affectedFactions: string[];
  } | null;
  /**
   * Exact normalized official facts retained by the signed bundle. Older v1
   * bundles may omit this field; those bundles can preserve an unchanged
   * effective snapshot, but cannot reapply official facts to a new rules
   * source without supplying the reviewed evidence again.
   */
  officialEvidenceOverlay?: Extract<
    OfficialRulesOverlay,
    { schemaVersion: 1 }
  > | null;
  officialAuthority: DataBundleOfficialAuthorityStatus;
};

export type RuntimeFactionShardDataV1 = {
  payloadKind: "rosterpilot-runtime-faction";
  schemaVersion: 1;
  factionId: string;
  rulesData: RuntimeRulesData;
  catalogue: NewRecruitCatalogueManifest["factions"][string];
  catalogueSummary:
    NewRecruitCatalogueSummaryManifest["factions"][string];
  certification: unknown;
  officialConflicts: OfficialCommunityConflict[];
  officialOverlayHash: string | null;
};

export type RuntimeGlobalShardDataV2 = {
  payloadKind: "rosterpilot-runtime-global";
  schemaVersion: 2;
  rulesData: RuntimeRulesData;
  catalogueBase: CatalogueBase;
  catalogueSummaryBase: CatalogueSummaryBase;
  certificationDefaults: unknown;
  certificationBrowserFixtures: unknown;
  officialReconciliation: {
    overlayHash: string;
    affectedFactions: string[];
  } | null;
  officialEvidenceOverlay?: OfficialRulesOverlay | null;
  officialAuthority: DataBundleOfficialAuthorityStatus;
};

export type RuntimeFactionShardDataV2 = {
  payloadKind: "rosterpilot-runtime-faction";
  schemaVersion: 2;
  factionId: string;
  rulesData: RuntimeRulesData;
  catalogue: NewRecruitCatalogueManifest["factions"][string];
  catalogueSummary:
    NewRecruitCatalogueSummaryManifest["factions"][string];
  certification: unknown;
  officialConflicts: OfficialCommunityConflict[];
  officialOverlayHash: string | null;
  legends: RuntimeFactionLegendsState;
};

export type RuntimeDataBundleShardData =
  | RuntimeGlobalShardDataV1
  | RuntimeFactionShardDataV1
  | RuntimeGlobalShardDataV2
  | RuntimeFactionShardDataV2;

/** @deprecated Use RuntimeDataBundleShardData; retained for API compatibility. */
export type RuntimeDataBundleShardDataV1 =
  RuntimeDataBundleShardData;

export function assertRuntimeDataBundleShardData(
  value: unknown,
  descriptor?: Pick<
    DataBundleShardDescriptorV1,
    "kind" | "factionIds" | "shardId"
  >,
): asserts value is RuntimeDataBundleShardDataV1 {
  const item = record(value);
  const rules = record(item?.rulesData);
  const validRules =
    rules !== null &&
    RUNTIME_RULE_COLLECTION_NAMES.every((name) =>
      Array.isArray(rules[name]),
    );
  const validOfficialEvidenceOverlay =
    item?.officialEvidenceOverlay === undefined ||
    item.officialEvidenceOverlay === null ||
    OfficialRulesOverlaySchema.safeParse(
      item.officialEvidenceOverlay,
    ).success;
  const legacyGlobal =
    item?.payloadKind === "rosterpilot-runtime-global" &&
    item.schemaVersion === 1 &&
    validRules &&
    record(item.catalogueBase) !== null &&
    record(item.catalogueSummaryBase) !== null &&
    validOfficialEvidenceOverlay &&
    (item.officialEvidenceOverlay == null ||
      record(item.officialEvidenceOverlay)?.schemaVersion === 1);
  const currentGlobal =
    item?.payloadKind === "rosterpilot-runtime-global" &&
    item.schemaVersion === 2 &&
    validRules &&
    record(item.catalogueBase) !== null &&
    record(item.catalogueSummaryBase) !== null &&
    validOfficialEvidenceOverlay;
  const legacyFaction =
    item?.payloadKind === "rosterpilot-runtime-faction" &&
    item.schemaVersion === 1 &&
    typeof item.factionId === "string" &&
    item.factionId.length > 0 &&
    validRules &&
    record(item.catalogue) !== null &&
    record(item.catalogueSummary) !== null;
  const currentFaction =
    item?.payloadKind === "rosterpilot-runtime-faction" &&
    item.schemaVersion === 2 &&
    typeof item.factionId === "string" &&
    item.factionId.length > 0 &&
    validRules &&
    record(item.catalogue) !== null &&
    record(item.catalogueSummary) !== null &&
    RuntimeFactionLegendsStateSchema.safeParse(item.legends).success &&
    record(item.legends)?.factionId === item.factionId;
  const global = legacyGlobal || currentGlobal;
  const faction = legacyFaction || currentFaction;
  const descriptorMatches =
    !descriptor ||
    (descriptor.kind === "global"
      ? global && descriptor.factionIds.length === 0
      : faction &&
        descriptor.factionIds.length === 1 &&
        item?.factionId === descriptor.factionIds[0]);
  if ((!global && !faction) || !descriptorMatches) {
    throw new Error(
      `Data-bundle shard ${descriptor?.shardId ?? "payload"} is not a supported RosterPilot runtime shard.`,
    );
  }
  if (currentFaction) {
    const legends = RuntimeFactionLegendsStateSchema.parse(
      item?.legends,
    );
    assertRuntimeFactionLegendsShardCoherence(
      item?.rulesData as RuntimeRulesData,
      legends,
      descriptor?.shardId ?? `faction:${legends.factionId}`,
    );
  }
}

export type RuntimeDataBundleBuild = {
  draft: DataBundleManifestDraftV1;
  shards: DataBundleShardV1<RuntimeDataBundleShardDataV1>[];
  officialReconciliation: {
    overlayHash: string;
    affectedFactions: string[];
    conflicts: OfficialCommunityConflict[];
  } | null;
};

export type RuntimeOfficialCarryForward = {
  rulesData: RuntimeRulesData;
  overlay: OfficialRulesOverlay | null;
  authority: Extract<
    DataBundleOfficialAuthorityStatus,
    { status: "verified" }
  >;
  reconciliation: NonNullable<
    RuntimeDataBundleBuild["officialReconciliation"]
  >;
};

export type SignedRuntimeDataBundle = {
  manifest: DataBundleManifestV1;
  shards: DataBundleShardV1<RuntimeDataBundleShardDataV1>[];
};

type CertificationDocument = {
  defaults?: unknown;
  browserFixtures?: unknown;
  factions?: Array<{
    id?: string;
    portfolioPolicy?: unknown;
    expectedLimitations?: unknown;
    semanticEvidence?: unknown;
    expertReview?: unknown;
    [key: string]: unknown;
  }>;
};

export const FACTION_DATA_DEPENDENCIES: Readonly<
  Record<string, readonly string[]>
> = {
  "black-templars": ["adeptus-astartes"],
  "blood-angels": ["adeptus-astartes"],
  "crimson-fists": ["adeptus-astartes"],
  "dark-angels": ["adeptus-astartes"],
  deathwatch: ["adeptus-astartes"],
  "imperial-fists": ["adeptus-astartes"],
  "iron-hands": ["adeptus-astartes"],
  "raven-guard": ["adeptus-astartes"],
  salamanders: ["adeptus-astartes"],
  "space-wolves": ["adeptus-astartes"],
  ultramarines: ["adeptus-astartes"],
  "white-scars": ["adeptus-astartes"],
  drukhari: ["aeldari"],
};

function record(value: unknown): Record<string, unknown> | null {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
}

function stringValue(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

function runtimeLegendBuildSupported(
  rulesData: RuntimeRulesData,
  factionId: string,
  unitId: string | null,
): boolean {
  if (unitId === null) return false;
  const unit = (rulesData.units as readonly unknown[]).find(
    (entry) =>
      stringValue(record(entry), "id") === unitId &&
      stringValue(record(entry), "faction_id") === factionId,
  );
  const raw = record(unit);
  if (
    !raw ||
    !Array.isArray(raw.profiles) ||
    raw.profiles.length === 0 ||
    !Array.isArray(raw.points) ||
    raw.points.length === 0 ||
    !Array.isArray(raw.weapon_ids)
  ) {
    return false;
  }
  const knownWeaponIds = new Set(
    (rulesData.weapons as readonly unknown[])
      .map((weapon) => stringValue(record(weapon), "id"))
      .filter((id): id is string => id !== null),
  );
  if (
    raw.weapon_ids.some(
      (weaponId) =>
        typeof weaponId !== "string" ||
        !knownWeaponIds.has(weaponId),
    )
  ) {
    return false;
  }
  return (rulesData.unitCompositions as readonly unknown[]).some(
    (composition) =>
      stringValue(record(composition), "unit_id") === unitId,
  );
}

/**
 * A shard signature authenticates bytes, not their internal agreement. Keep
 * the authoritative Legends inventory, structured rules classification, and
 * build-support claim mutually consistent before the shard can enter a
 * verified snapshot or be activated directly by a trusted local caller.
 */
function assertRuntimeFactionLegendsShardCoherence(
  rulesData: RuntimeRulesData,
  legends: RuntimeFactionLegendsState,
  shardId: string,
): void {
  const factionUnits = (rulesData.units as readonly unknown[]).filter(
    (unit) =>
      stringValue(record(unit), "faction_id") ===
      legends.factionId,
  );
  const mappedUnitIds = new Set<string>();

  for (const legend of legends.units) {
    if (legend.unitId !== null) {
      const matches = factionUnits.filter(
        (unit) =>
          stringValue(record(unit), "id") === legend.unitId,
      );
      if (matches.length !== 1) {
        throw new Error(
          `Runtime Legends entry ${legend.legendId} in ${shardId} maps to structured unit ${legend.unitId}, but that unit does not resolve exactly once in faction ${legends.factionId}.`,
        );
      }
      mappedUnitIds.add(legend.unitId);
    }
  }

  if (
    legends.coverageStatus !== "complete" &&
    legends.coverageStatus !== "not-published"
  ) {
    return;
  }
  for (const unit of factionUnits) {
    const raw = record(unit);
    const unitId = stringValue(raw, "id");
    if (unitId === null) {
      throw new Error(
        `Runtime faction shard ${shardId} contains a ${legends.factionId} unit without an identity, so its authoritative Legends classification cannot be verified.`,
      );
    }
    const expected = mappedUnitIds.has(unitId);
    if (raw?.is_legend !== expected) {
      throw new Error(
        `Runtime unit ${unitId} in ${shardId} has is_legend=${String(raw?.is_legend)}, but authoritative ${legends.coverageStatus} Legends coverage requires ${expected}.`,
      );
    }
  }
}

function assertRuntimeFactionLegendsBuildCoherence(
  rulesData: RuntimeRulesData,
  legends: RuntimeFactionLegendsState,
  shardId: string,
): void {
  for (const legend of legends.units) {
    const recomputedBuildSupported =
      runtimeLegendBuildSupported(
        rulesData,
        legends.factionId,
        legend.unitId,
      );
    if (legend.buildSupported !== recomputedBuildSupported) {
      throw new Error(
        `Runtime Legends entry ${legend.legendId} in ${shardId} claims buildSupported=${legend.buildSupported}, but its structured profile completeness recomputes to ${recomputedBuildSupported}.`,
      );
    }
  }
}

type RuntimeRulesPartition = {
  global: RuntimeRulesData;
  factions: Map<string, RuntimeRulesData>;
};

function addRuntimeRuleRecord(
  target: RuntimeRulesData,
  collection: RuntimeRuleCollectionName,
  value: unknown,
): void {
  (
    target as unknown as Record<
      RuntimeRuleCollectionName,
      unknown[]
    >
  )[collection].push(structuredClone(value));
}

/**
 * Assign rule records to their narrowest authoritative faction scope. Records
 * referenced by multiple factions are copied to each owning shard and are
 * deduplicated, with conflict checks, when a snapshot is activated.
 */
function partitionRuntimeRulesData(
  raw: RuntimeRulesData,
  factionIds: readonly string[],
): RuntimeRulesPartition {
  const supported = new Set(factionIds);
  const global = emptyRuntimeRulesData();
  const factionParts = new Map(
    factionIds.map((factionId) => [
      factionId,
      emptyRuntimeRulesData(),
    ]),
  );
  const unitOwners = new Map<string, Set<string>>();
  const detachmentOwners = new Map<string, Set<string>>();
  const sourceOwners = new Map<string, Set<string>>();
  const abilityOwners = new Map<string, Set<string>>();

  const addOwner = (
    map: Map<string, Set<string>>,
    entityId: string | null,
    factionId: string | null,
  ) => {
    if (!entityId || !factionId || !supported.has(factionId)) {
      return;
    }
    const owners = map.get(entityId) ?? new Set<string>();
    owners.add(factionId);
    map.set(entityId, owners);
  };
  const addSourceOwner = (
    entityId: string | null,
    factionId: string | null,
  ) => {
    addOwner(sourceOwners, entityId, factionId);
  };

  for (const value of raw.units as readonly unknown[]) {
    const item = record(value);
    const factionId = stringValue(item, "faction_id");
    const unitId = stringValue(item, "id");
    addOwner(unitOwners, unitId, factionId);
    addSourceOwner(unitId, factionId);
    for (const abilityId of stringArray(item?.ability_ids)) {
      addOwner(abilityOwners, abilityId, factionId);
    }
  }
  for (const value of raw.factions as readonly unknown[]) {
    const item = record(value);
    const factionId = stringValue(item, "id");
    addSourceOwner(factionId, factionId);
    addOwner(
      abilityOwners,
      stringValue(item, "faction_rule_id"),
      factionId,
    );
  }
  for (const value of raw.detachments as readonly unknown[]) {
    const item = record(value);
    const factionId = stringValue(item, "faction_id");
    const detachmentId = stringValue(item, "id");
    addOwner(detachmentOwners, detachmentId, factionId);
    addSourceOwner(detachmentId, factionId);
    addOwner(
      abilityOwners,
      stringValue(item, "detachment_rule_id"),
      factionId,
    );
    for (const abilityId of stringArray(
      item?.detachment_rule_ids,
    )) {
      addOwner(abilityOwners, abilityId, factionId);
    }
  }
  for (const value of raw.stratagems as readonly unknown[]) {
    const item = record(value);
    const stratagemId = stringValue(item, "id");
    const detachmentId = stringValue(item, "detachment_id");
    for (const owner of detachmentOwners.get(detachmentId ?? "") ?? []) {
      addSourceOwner(stratagemId, owner);
      addOwner(
        abilityOwners,
        stringValue(item, "ability_id"),
        owner,
      );
    }
  }
  for (const value of raw.enhancements as readonly unknown[]) {
    const item = record(value);
    const enhancementId = stringValue(item, "id");
    const detachmentId = stringValue(item, "detachment_id");
    for (const owner of detachmentOwners.get(detachmentId ?? "") ?? []) {
      addSourceOwner(enhancementId, owner);
      addOwner(
        abilityOwners,
        stringValue(item, "ability_id"),
        owner,
      );
    }
  }
  for (const value of raw.weapons as readonly unknown[]) {
    const item = record(value);
    addSourceOwner(
      stringValue(item, "id"),
      stringValue(item, "faction_id"),
    );
  }
  for (const [abilityId, owners] of abilityOwners) {
    for (const owner of owners) addSourceOwner(abilityId, owner);
  }

  const directOwners = (
    item: Record<string, unknown> | null,
  ): Set<string> => {
    const result = new Set<string>();
    for (const field of [
      "faction_id",
      "source_faction_id",
      "factionId",
      "faction_keyword_id",
    ]) {
      const factionId = stringValue(item, field);
      if (factionId && supported.has(factionId)) {
        result.add(factionId);
      }
    }
    return result;
  };
  const ownersFor = (
    collection: RuntimeRuleCollectionName,
    value: unknown,
  ): Set<string> => {
    const item = record(value);
    const owners = directOwners(item);
    const include = (values: Iterable<string> | undefined) => {
      for (const factionId of values ?? []) owners.add(factionId);
    };
    const unitId =
      stringValue(item, "unit_id") ??
      stringValue(item, "leader_id");
    const detachmentId = stringValue(item, "detachment_id");
    const entityId =
      stringValue(item, "ability_id") ??
      stringValue(item, "id");
    include(unitOwners.get(unitId ?? ""));
    include(detachmentOwners.get(detachmentId ?? ""));
    if (collection === "abilities") {
      include(abilityOwners.get(entityId ?? ""));
      for (const referencedUnitId of stringArray(item?.unit_ids)) {
        include(unitOwners.get(referencedUnitId));
      }
    }
    if (collection === "phaseMappings") {
      include(
        sourceOwners.get(stringValue(item, "source_id") ?? ""),
      );
    }
    if (collection === "leaderAttachments") {
      include(unitOwners.get(stringValue(item, "leader_id") ?? ""));
    }
    return owners;
  };

  for (const collection of RUNTIME_RULE_COLLECTION_NAMES) {
    for (const value of raw[collection] as readonly unknown[]) {
      const owners = ownersFor(collection, value);
      if (owners.size === 0) {
        addRuntimeRuleRecord(global, collection, value);
        continue;
      }
      for (const factionId of owners) {
        const target = factionParts.get(factionId);
        if (target) addRuntimeRuleRecord(target, collection, value);
      }
    }
  }
  return { global, factions: factionParts };
}

function globalRulesProjection(
  raw: RuntimeRulesData,
): Record<string, unknown> {
  return {
    // Rule collections are sets keyed by their runtime identities. Normalize
    // their ordering so an archive/restore cycle cannot turn JSON ordering
    // into a false methodology change.
    rulesData: mergeRuntimeRulesData([raw]),
  };
}

function certificationFaction(
  document: CertificationDocument | undefined,
  factionId: string,
) {
  return (
    document?.factions?.find((entry) => entry.id === factionId) ??
    null
  );
}

function catalogueBase(
  manifest:
    | NewRecruitCatalogueManifest
    | NewRecruitCatalogueSummaryManifest,
): CatalogueBase {
  return structuredClone({
    schemaVersion: manifest.schemaVersion,
    gameSystem: manifest.gameSystem,
  });
}

function runtimeFactionLegendsState(
  overlay: OfficialRulesOverlay | null,
  authority: DataBundleOfficialAuthorityStatus,
  factionId: string,
  rulesData: RuntimeRulesData,
): RuntimeFactionLegendsState {
  if (overlay?.schemaVersion !== 2) {
    return unavailableFactionLegendsState(factionId);
  }
  const coverage = overlay.legendFactionCoverage.find(
    (entry) => entry.factionId === factionId,
  );
  if (!coverage) {
    return unavailableFactionLegendsState(factionId);
  }
  const sourceIds = new Set(coverage.sourceIds);
  return RuntimeFactionLegendsStateSchema.parse({
    schemaVersion: 1,
    factionId,
    coverageStatus: coverage.status,
    classificationAuthority:
      authority.status === "verified"
        ? "games-workshop-verified"
        : "games-workshop-unverified-overlay",
    sourceArtifacts: overlay.legendSources
      .filter((source) => sourceIds.has(source.sourceId))
      .map((source) => ({
        sourceId: source.sourceId,
        version: source.version,
        contentSha256: source.contentSha256,
        url: source.url,
      })),
    units: overlay.legendUnits
      .filter((unit) => unit.factionId === factionId)
      .map((unit) => ({
        legendId: unit.legendId,
        factionId: unit.factionId,
        name: unit.name,
        unitId: unit.unitId,
        sourceId: unit.sourceId,
        ...(unit.datasheetUrl
          ? { datasheetUrl: unit.datasheetUrl }
          : {}),
        buildSupported: runtimeLegendBuildSupported(
          rulesData,
          factionId,
          unit.unitId,
        ),
      })),
  });
}

async function factionSemanticHashes(
  source: ReturnType<typeof createRuntimeDataset>,
  catalogue: NewRecruitCatalogueManifest,
  certification: CertificationDocument | undefined,
  factionId: string,
  officialConflicts: readonly OfficialCommunityConflict[],
  legends?: RuntimeFactionLegendsState,
) {
  const compatibility =
    deriveRosterCompatibilityFactionIdentity({
      source,
      catalogue,
      factionId,
    });
  const mapping = catalogue.factions[factionId] ?? null;
  const certificationEntry = certificationFaction(
    certification,
    factionId,
  );
  const entityHashes = { ...compatibility.entityHashes };
  if (legends) {
    entityHashes["legends:coverage"] = await semanticHash({
      coverageStatus: legends.coverageStatus,
      classificationAuthority: legends.classificationAuthority,
      sourceArtifacts: legends.sourceArtifacts,
    });
    for (const unit of legends.units) {
      entityHashes[`legend:${unit.legendId}`] =
        await semanticHash(unit);
    }
  }
  return {
    factionRulesHash: legends
      ? await semanticHash({
          base: compatibility.factionRulesHash,
          legends,
        })
      : compatibility.factionRulesHash,
    mappingHash: compatibility.mappingHash,
    portfolioHash: await semanticHash({
      methodology: "adaptive-threat-lenses-v1",
      generatorVersion: "faction-stress-v6",
      defaults: certification?.defaults ?? null,
      portfolioPolicy:
        certificationEntry?.portfolioPolicy ?? null,
      expectedLimitations:
        certificationEntry?.expectedLimitations ?? [],
    }),
    conflictHash: await semanticHash({
      mapping: mapping?.conflicts ?? [],
      official: officialConflicts,
    }),
    entityHashes,
  };
}

function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function runtimeMethodologyProjection(
  engineDataSchemaVersion: number,
): Record<string, unknown> {
  return {
    engineDataSchemaVersion,
    // Version 2 scopes roster and export identity to selected rules and
    // mapping paths. Advancing this value deliberately forces a one-time
    // full certification when compared with v1 bundles.
    semanticHashSchemaVersion:
      engineDataSchemaVersion >= 2 ? 3 : 2,
    ...(engineDataSchemaVersion >= 2
      ? {
          legendsInventorySchemaVersion: 1,
          legendsClassificationAuthority:
            "games-workshop-faction-packs",
        }
      : {}),
    portfolioMethodology: "adaptive-threat-lenses-v1",
    portfolioGeneratorVersion: "faction-stress-v6",
  };
}

export async function buildRuntimeDataBundle(
  input: {
    rulesData?: RuntimeRulesData;
    /**
     * Raw structured-rules source identity when `rulesData` is an archived
     * effective snapshot (for example, after an official overlay). This keeps
     * source provenance separate from the effective rules being carried.
     */
    rulesSourceSha256?: string;
    catalogue?: NewRecruitCatalogueManifest;
    catalogueSummary?: NewRecruitCatalogueSummaryManifest;
    certification?: CertificationDocument;
    officialOverlay?: unknown;
    officialAuthority?: RuntimeGlobalShardDataV1["officialAuthority"];
    inheritedOfficialReconciliation?: NonNullable<
      RuntimeDataBundleBuild["officialReconciliation"]
    >;
    inheritedOfficialEvidenceOverlay?: unknown;
    createdAt?: string;
    engineDataSchemaVersion?: number;
  } = {},
): Promise<RuntimeDataBundleBuild> {
  const engineDataSchemaVersion =
    input.engineDataSchemaVersion ??
    RUNTIME_DATA_BUNDLE_SCHEMA_VERSION;
  if (
    !isSupportedRuntimeDataBundleSchemaVersion(
      engineDataSchemaVersion,
    )
  ) {
    throw new Error(
      `Runtime data build requires unsupported engine data schema ${engineDataSchemaVersion}.`,
    );
  }
  const catalogue =
    input.catalogue ?? newRecruitCatalogueMappings;
  const catalogueSummary =
    input.catalogueSummary ?? newRecruitCatalogue;
  let rulesData =
    input.rulesData ?? serializeRuntimeRulesData();
  // Freeze raw 40kdc provenance before an official overlay produces the
  // effective runtime rules. Provenance identifies the source; faction/entity
  // semantic hashes identify the reconciled behavior.
  const rulesSourceSha256 =
    input.rulesSourceSha256 ??
    (await sha256Hex(canonicalJson(rulesData)));
  let officialReconciliation:
    | RuntimeDataBundleBuild["officialReconciliation"] =
    input.inheritedOfficialReconciliation
      ? structuredClone(input.inheritedOfficialReconciliation)
      : null;
  let officialEvidenceOverlay: OfficialRulesOverlay | null = null;
  if (
    input.officialOverlay !== undefined &&
    input.inheritedOfficialReconciliation
  ) {
    throw new Error(
      "A runtime data build cannot both apply and inherit official reconciliation.",
    );
  }
  if (input.officialOverlay !== undefined) {
    const overlay = await verifyOfficialRulesOverlayCoverage(
      input.officialOverlay,
    );
    if (
      engineDataSchemaVersion === 1 &&
      overlay.schemaVersion !== 1
    ) {
      throw new Error(
        "Engine data schema 1 cannot retain an official V2 Legends overlay.",
      );
    }
    if (
      overlay.schemaVersion === 2 &&
      overlay.gameEdition !== catalogue.sources.rules.edition
    ) {
      throw new Error(
        `Official Legends overlay edition ${overlay.gameEdition} does not match runtime rules edition ${catalogue.sources.rules.edition}.`,
      );
    }
    if (
      overlay.source.contentSha256 !==
        catalogue.sources.official.contentSha256 ||
      overlay.source.version !==
        catalogue.sources.official.mfmVersion
    ) {
      throw new Error(
        "Official overlay provenance does not match the candidate Games Workshop source.",
      );
    }
    const applied = await applyOfficialRulesOverlay(
      rulesData,
      overlay,
    );
    rulesData = applied.rulesData;
    officialReconciliation = {
      overlayHash: applied.overlayHash,
      affectedFactions: applied.affectedFactions,
      conflicts: applied.conflicts,
    };
    officialEvidenceOverlay = structuredClone(overlay);
  } else if (input.inheritedOfficialEvidenceOverlay !== undefined) {
    if (!input.inheritedOfficialReconciliation) {
      throw new Error(
        "Retained official evidence requires its verified reconciliation metadata.",
      );
    }
    const overlay = await verifyOfficialRulesOverlayCoverage(
      input.inheritedOfficialEvidenceOverlay,
    );
    if (
      engineDataSchemaVersion === 1 &&
      overlay.schemaVersion !== 1
    ) {
      throw new Error(
        "Engine data schema 1 cannot inherit an official V2 Legends overlay.",
      );
    }
    if (
      overlay.schemaVersion === 2 &&
      overlay.gameEdition !== catalogue.sources.rules.edition
    ) {
      throw new Error(
        `Retained official Legends overlay edition ${overlay.gameEdition} does not match runtime rules edition ${catalogue.sources.rules.edition}.`,
      );
    }
    const overlayHash = await semanticHash(overlay);
    if (
      overlay.source.contentSha256 !==
        catalogue.sources.official.contentSha256 ||
      overlay.source.version !==
        catalogue.sources.official.mfmVersion ||
      overlayHash !== input.inheritedOfficialReconciliation.overlayHash
    ) {
      throw new Error(
        "Retained official evidence does not bind the candidate Games Workshop provenance and reconciliation.",
      );
    }
    officialEvidenceOverlay = structuredClone(overlay);
  }
  const officialAuthority: RuntimeGlobalShardDataV1["officialAuthority"] =
    input.officialAuthority ??
    (officialReconciliation
      ? {
          status: "unverified-overlay",
          reason:
            "The overlay was applied without reviewed extractor publication evidence.",
        }
      : {
          status: "unavailable",
          reason:
            "No reviewed official extraction evidence was supplied.",
        });
  if (
    officialAuthority.status === "verified" &&
    officialEvidenceOverlay &&
    (await semanticHash(officialEvidenceOverlay)) !==
      officialAuthority.overlaySha256
  ) {
    throw new Error(
      "Verified official authority does not bind the retained official overlay.",
    );
  }
  const factionIds = Object.keys(catalogue.factions).sort();
  const sourceDataset = createRuntimeDataset(rulesData);
  const partition = partitionRuntimeRulesData(
    rulesData,
    factionIds,
  );
  const legendsByFaction = new Map(
    factionIds.map((factionId) => [
      factionId,
      runtimeFactionLegendsState(
        officialEvidenceOverlay,
        officialAuthority,
        factionId,
        rulesData,
      ),
    ]),
  );
  const semanticFactions: DataBundleSemanticHashesV1["factions"] = {};
  for (const factionId of factionIds) {
    const factionOfficialConflicts =
      officialReconciliation?.conflicts.filter(
        (conflict) => conflict.factionId === factionId,
      ) ?? [];
    const hashes = await factionSemanticHashes(
      sourceDataset,
      catalogue,
      input.certification,
      factionId,
      factionOfficialConflicts,
      engineDataSchemaVersion === 2
        ? legendsByFaction.get(factionId)
        : undefined,
    );
    semanticFactions[factionId] = {
      factionRulesHash: hashes.factionRulesHash,
      mappingHash: hashes.mappingHash,
      portfolioHash: hashes.portfolioHash,
      conflictHash: hashes.conflictHash,
      entityHashes: hashes.entityHashes,
    };
  }
  const semanticHashes: DataBundleSemanticHashesV1 = {
    globalHash: await semanticHash({
      rules: globalRulesProjection(partition.global),
      officialAuthorityStatus: officialAuthority.status,
    }),
    methodologyHash: await semanticHash(
      runtimeMethodologyProjection(
        engineDataSchemaVersion,
      ),
    ),
    factions: semanticFactions,
  };

  const globalBase = {
    rulesData: partition.global,
    catalogueBase: catalogueBase(catalogue),
    catalogueSummaryBase: catalogueBase(catalogueSummary),
    certificationDefaults:
      input.certification?.defaults ?? null,
    certificationBrowserFixtures:
      input.certification?.browserFixtures ?? null,
    officialReconciliation: officialReconciliation
      ? {
          overlayHash: officialReconciliation.overlayHash,
          affectedFactions: [
            ...officialReconciliation.affectedFactions,
          ],
        }
      : null,
    officialAuthority,
  };
  const globalData: RuntimeGlobalShardDataV1 | RuntimeGlobalShardDataV2 =
    engineDataSchemaVersion === 1
      ? {
          payloadKind: "rosterpilot-runtime-global",
          schemaVersion: 1,
          ...globalBase,
          officialEvidenceOverlay:
            officialEvidenceOverlay as Extract<
              OfficialRulesOverlay,
              { schemaVersion: 1 }
            > | null,
        }
      : {
          payloadKind: "rosterpilot-runtime-global",
          schemaVersion: 2,
          ...globalBase,
          officialEvidenceOverlay,
        };
  const globalShard: DataBundleShardV1<RuntimeDataBundleShardData> = {
    schemaVersion: 1,
    shardId: "global",
    kind: "global",
    factionIds: [],
    data: globalData,
  };
  const factionShards = factionIds.map<
    DataBundleShardV1<RuntimeDataBundleShardData>
  >((factionId) => {
    const factionBase = {
      factionId,
      rulesData:
        partition.factions.get(factionId) ??
        emptyRuntimeRulesData(),
      catalogue: catalogue.factions[factionId],
      catalogueSummary: catalogueSummary.factions[factionId],
      certification: certificationFaction(
        input.certification,
        factionId,
      ),
      officialConflicts:
        officialReconciliation?.conflicts.filter(
          (conflict) => conflict.factionId === factionId,
        ) ?? [],
      officialOverlayHash:
        officialReconciliation?.affectedFactions.includes(
          factionId,
        )
          ? officialReconciliation.overlayHash
          : null,
    };
    const data: RuntimeFactionShardDataV1 | RuntimeFactionShardDataV2 =
      engineDataSchemaVersion === 1
        ? {
            payloadKind: "rosterpilot-runtime-faction",
            schemaVersion: 1,
            ...factionBase,
          }
        : {
            payloadKind: "rosterpilot-runtime-faction",
            schemaVersion: 2,
            ...factionBase,
            legends:
              legendsByFaction.get(factionId) ??
              unavailableFactionLegendsState(factionId),
          };
    return {
      schemaVersion: 1,
      shardId: `faction:${factionId}`,
      kind: "faction",
      factionIds: [factionId],
      data,
    };
  });
  const shards = [globalShard, ...factionShards];
  const descriptors: DataBundleShardDescriptorV1[] = [];
  for (const shard of shards) {
    const contentSha256 = await sha256Hex(canonicalJson(shard));
    const dependencies =
      shard.kind === "global"
        ? []
        : [
            "global",
            ...(FACTION_DATA_DEPENDENCIES[
              shard.factionIds[0]
            ] ?? []).map((factionId) => `faction:${factionId}`),
          ];
    descriptors.push({
      shardId: shard.shardId,
      kind: shard.kind,
      factionIds: [...shard.factionIds],
      dependencyShardIds: dependencies,
      path:
        shard.kind === "global"
          ? "shards/global.json"
          : `shards/${shard.factionIds[0]}.json`,
      contentSha256,
      semanticHash: await semanticHash(shard.data),
      byteLength: canonicalByteLength(shard),
      mediaType: RUNTIME_DATA_BUNDLE_MEDIA_TYPE,
    });
  }

  const sources = catalogue.sources;
  return {
    draft: {
      schemaVersion: 1,
      engineDataSchemaVersion,
      createdAt: input.createdAt ?? new Date().toISOString(),
      provenance: {
        official: {
          authority: "games-workshop",
          version: sources.official.mfmVersion,
          contentSha256: sources.official.contentSha256,
          downloadsUrl: sources.official.downloadsUrl,
          dataUrl: sources.official.mfmUrl,
          checkedAt: sources.official.checkedAt,
        },
        rules: {
          provider: "40kdc-data",
          package: sources.rules.package,
          version: sources.rules.version,
          sourceSha256: rulesSourceSha256,
          edition: sources.rules.edition,
          dataslate: sources.rules.dataslate,
        },
        newRecruit: {
          provider: "bsdata",
          repository: sources.newRecruit.repository,
          branch: sources.newRecruit.branch,
          commit: sources.newRecruit.commit,
        },
      },
      semanticHashes,
      shards: descriptors,
    },
    shards,
    officialReconciliation,
  };
}

export async function signRuntimeDataBundle(
  build: RuntimeDataBundleBuild,
  signer: DataBundleSigner,
): Promise<SignedRuntimeDataBundle> {
  return {
    manifest: await createSignedDataBundleManifest(
      build.draft,
      signer,
    ),
    shards: build.shards,
  };
}

export type RuntimeDataBundleQuarantinedFaction = {
  factionId: string;
  scopes?: readonly string[];
  reason: string;
};

function factionShardGraph(
  manifests: readonly Pick<DataBundleManifestV1, "shards">[],
): {
  owners: Map<string, string>;
  neighbours: Map<string, Set<string>>;
} {
  const owners = new Map<string, string>();
  const factionShardIds = new Set<string>();
  for (const manifest of manifests) {
    for (const descriptor of manifest.shards) {
      if (descriptor.kind !== "faction") continue;
      factionShardIds.add(descriptor.shardId);
      for (const factionId of descriptor.factionIds) {
        const existing = owners.get(factionId);
        if (existing && existing !== descriptor.shardId) {
          throw new Error(
            `Faction ${factionId} changed shard ownership between the candidate and retained bundle.`,
          );
        }
        owners.set(factionId, descriptor.shardId);
      }
    }
  }
  const neighbours = new Map(
    [...factionShardIds].map((shardId) => [
      shardId,
      new Set<string>(),
    ]),
  );
  for (const manifest of manifests) {
    for (const descriptor of manifest.shards) {
      if (descriptor.kind !== "faction") continue;
      for (const dependency of descriptor.dependencyShardIds) {
        if (!factionShardIds.has(dependency)) continue;
        neighbours.get(descriptor.shardId)?.add(dependency);
        neighbours.get(dependency)?.add(descriptor.shardId);
      }
    }
  }
  return { owners, neighbours };
}

/**
 * Expands a failed faction to its complete imported-library component. Both
 * dependencies and dependants are retained so a previously certified shard is
 * never combined with a different version of a shared faction library.
 * Global shards are deliberately excluded: global/methodology changes require
 * full certification and cannot use partial roll-forward.
 */
export function retainedFactionDependencyClosure(
  input: {
    candidate: Pick<DataBundleManifestV1, "shards">;
    previous: Pick<DataBundleManifestV1, "shards">;
    factionIds: readonly string[];
  },
): string[] {
  const graph = factionShardGraph([
    input.candidate,
    input.previous,
  ]);
  const pending: string[] = [];
  for (const factionId of input.factionIds) {
    const shardId = graph.owners.get(factionId);
    if (!shardId) {
      throw new Error(
        `Cannot retain unknown faction shard for ${factionId}.`,
      );
    }
    pending.push(shardId);
  }
  const retained = new Set<string>();
  while (pending.length > 0) {
    const shardId = pending.shift()!;
    if (retained.has(shardId)) continue;
    retained.add(shardId);
    for (const neighbour of graph.neighbours.get(shardId) ?? []) {
      if (!retained.has(neighbour)) pending.push(neighbour);
    }
  }
  return [...retained].sort();
}

/**
 * Creates a publisher-side hybrid build from a cryptographically verified
 * previous snapshot. The resulting manifest draft records shard lineage and
 * must be signed like every other bundle before it can be consumed.
 */
export async function composeRuntimeDataBundleRetainingVerifiedShards(
  input: {
    candidate: RuntimeDataBundleBuild;
    previous: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
    quarantinedFactions: readonly RuntimeDataBundleQuarantinedFaction[];
  },
): Promise<RuntimeDataBundleBuild> {
  if (input.quarantinedFactions.length === 0) {
    throw new Error(
      "Partial data-bundle composition requires at least one quarantined faction.",
    );
  }
  if (input.candidate.draft.composition) {
    throw new Error(
      "A partial roll-forward must be composed from a complete candidate build.",
    );
  }
  const candidateGlobal =
    input.candidate.draft.shards.find(
      (descriptor) => descriptor.kind === "global",
    );
  const previousGlobal =
    input.previous.manifest.shards.find(
      (descriptor) => descriptor.kind === "global",
    );
  if (
    input.candidate.draft.engineDataSchemaVersion !==
      input.previous.manifest.engineDataSchemaVersion ||
    input.candidate.draft.semanticHashes.globalHash !==
      input.previous.manifest.semanticHashes.globalHash ||
    input.candidate.draft.semanticHashes.methodologyHash !==
      input.previous.manifest.semanticHashes.methodologyHash ||
    !candidateGlobal ||
    !previousGlobal ||
    canonicalJson(candidateGlobal) !==
      canonicalJson(previousGlobal)
  ) {
    throw new Error(
      "Global shard content, global or methodology semantics, or the engine schema changed. Partial faction roll-forward is unsafe; certify every affected scope or leave the prior bundle active.",
    );
  }
  const duplicateFaction = input.quarantinedFactions.find(
    (entry, index) =>
      input.quarantinedFactions.findIndex(
        (candidate) => candidate.factionId === entry.factionId,
      ) !== index,
  );
  if (duplicateFaction) {
    throw new Error(
      `Quarantined faction ${duplicateFaction.factionId} was supplied more than once.`,
    );
  }
  for (const failure of input.quarantinedFactions) {
    if (
      !failure.reason.trim() ||
      failure.reason.length > 4_000
    ) {
      throw new Error(
        `Quarantined faction ${failure.factionId} requires a reason of at most 4,000 characters.`,
      );
    }
  }

  const retainedShardIds = retainedFactionDependencyClosure({
    candidate: input.candidate.draft,
    previous: input.previous.manifest,
    factionIds: input.quarantinedFactions.map(
      (entry) => entry.factionId,
    ),
  });
  const directFailures = new Map(
    input.quarantinedFactions.map((entry) => [
      entry.factionId,
      entry,
    ]),
  );
  const candidateDescriptors = new Map(
    input.candidate.draft.shards.map((descriptor) => [
      descriptor.shardId,
      descriptor,
    ]),
  );
  const previousDescriptors = new Map(
    input.previous.manifest.shards.map((descriptor) => [
      descriptor.shardId,
      descriptor,
    ]),
  );
  const previousShards = new Map(
    [...input.previous.shards].map(([shardId, shard]) => [
      shardId,
      shard,
    ]),
  );
  const retainedFactions = new Set<string>();
  const retainedReceipts =
    [] as NonNullable<
      DataBundleManifestDraftV1["composition"]
    >["retainedShards"];
  const replacementDescriptors =
    new Map<string, DataBundleShardDescriptorV1>();
  const replacementShards =
    new Map<
      string,
      DataBundleShardV1<RuntimeDataBundleShardDataV1>
    >();

  for (const shardId of retainedShardIds) {
    const candidateDescriptor = candidateDescriptors.get(shardId);
    const previousDescriptor = previousDescriptors.get(shardId);
    const previousShard = previousShards.get(shardId);
    if (
      !previousDescriptor ||
      !previousShard ||
      previousDescriptor.kind !== "faction" ||
      (candidateDescriptor &&
        (candidateDescriptor.kind !== "faction" ||
          canonicalJson(candidateDescriptor.factionIds) !==
            canonicalJson(previousDescriptor.factionIds)))
    ) {
      throw new Error(
        `Verified previous shard ${shardId} cannot safely replace the candidate shard.`,
      );
    }
    replacementDescriptors.set(
      shardId,
      structuredClone(previousDescriptor),
    );
    replacementShards.set(
      shardId,
      structuredClone(previousShard),
    );
    for (const factionId of previousDescriptor.factionIds) {
      retainedFactions.add(factionId);
    }
    const direct = previousDescriptor.factionIds
      .map((factionId) => directFailures.get(factionId))
      .find(
        (
          failure,
        ): failure is RuntimeDataBundleQuarantinedFaction =>
          failure !== undefined,
      );
    const scopes = direct?.scopes?.length
      ? [...new Set(direct.scopes)].sort()
      : previousDescriptor.factionIds.map(
          (factionId) =>
            direct
              ? `faction:${factionId}`
              : `faction:${factionId}:dependency`,
        );
    retainedReceipts.push({
      shardId,
      sourceBundleId: input.previous.bundleId,
      sourceContentSha256:
        previousDescriptor.contentSha256,
      sourceSemanticHash: previousDescriptor.semanticHash,
      scopes,
      reason:
        direct?.reason ??
        `Retained with the verified dependency component for ${input.quarantinedFactions
          .map((entry) => entry.factionId)
          .sort()
          .join(", ")}.`,
    });
  }

  const semanticFactions = structuredClone(
    input.candidate.draft.semanticHashes.factions,
  );
  for (const factionId of retainedFactions) {
    const previous =
      input.previous.manifest.semanticHashes.factions[
        factionId
      ];
    if (!previous) {
      throw new Error(
        `Faction ${factionId} cannot be retained across a changed semantic inventory.`,
      );
    }
    semanticFactions[factionId] = structuredClone(previous);
  }
  const candidateDraftSha256 = await sha256Hex(
    canonicalJson(input.candidate.draft),
  );
  return {
    ...input.candidate,
    draft: {
      ...structuredClone(input.candidate.draft),
      semanticHashes: {
        ...structuredClone(
          input.candidate.draft.semanticHashes,
        ),
        factions: semanticFactions,
      },
      shards: [
        ...input.candidate.draft.shards.map(
          (descriptor) =>
            replacementDescriptors.get(
              descriptor.shardId,
            ) ?? structuredClone(descriptor),
        ),
        ...[...replacementDescriptors.entries()]
          .filter(
            ([shardId]) =>
              !candidateDescriptors.has(shardId),
          )
          .map(([, descriptor]) =>
            structuredClone(descriptor),
          ),
      ],
      composition: {
        schemaVersion: 1,
        strategy: "retain-verified-shards",
        baseBundleId: input.previous.bundleId,
        candidateDraftSha256,
        retainedShards: retainedReceipts.sort((left, right) =>
          left.shardId.localeCompare(right.shardId),
        ),
      },
    },
    shards: [
      ...input.candidate.shards.map(
        (shard) =>
          replacementShards.get(shard.shardId) ??
          structuredClone(shard),
      ),
      ...[...replacementShards.entries()]
        .filter(
          ([shardId]) =>
            !input.candidate.shards.some(
              (shard) => shard.shardId === shardId,
            ),
        )
        .map(([, shard]) => structuredClone(shard)),
    ],
  };
}

function runtimeGlobalData(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
): RuntimeGlobalShardDataV1 | RuntimeGlobalShardDataV2 {
  const value = snapshot.getShard("global")?.data;
  if (
    !value ||
    value.payloadKind !== "rosterpilot-runtime-global" ||
    !isSupportedRuntimeDataBundleSchemaVersion(
      value.schemaVersion,
    ) ||
    value.schemaVersion !==
      snapshot.manifest.engineDataSchemaVersion
  ) {
    throw new Error(
      "The verified data bundle has no supported runtime global shard.",
    );
  }
  return value;
}

/**
 * Reads retained official evidence only from a fully verified immutable
 * snapshot. The exact overlay is optional for legacy v1 bundles, but when it
 * is present its normalized hash and Games Workshop provenance must still
 * match the receipt-bound authority stored in that signed snapshot.
 */
export async function runtimeOfficialCarryForward(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
): Promise<RuntimeOfficialCarryForward | null> {
  const global = runtimeGlobalData(snapshot);
  if (
    global.officialAuthority?.status !== "verified" ||
    !global.officialReconciliation ||
    global.officialAuthority.overlaySha256 !==
      global.officialReconciliation.overlayHash
  ) {
    return null;
  }
  let overlay: OfficialRulesOverlay | null = null;
  if (global.officialEvidenceOverlay != null) {
    const parsed = await verifyOfficialRulesOverlayCoverage(
      global.officialEvidenceOverlay,
    );
    const overlayHash = await semanticHash(parsed);
    if (
      overlayHash !== global.officialAuthority.overlaySha256 ||
      parsed.source.version !==
        snapshot.manifest.provenance.official.version ||
      parsed.source.contentSha256 !==
        snapshot.manifest.provenance.official.contentSha256
    ) {
      throw new Error(
        "The verified prior bundle contains official evidence that does not match its receipt-bound authority and source provenance.",
      );
    }
    overlay = structuredClone(parsed);
  }
  const rulesData: RuntimeRulesData[] = [global.rulesData];
  const conflicts: OfficialCommunityConflict[] = [];
  for (const descriptor of snapshot.manifest.shards) {
    if (descriptor.kind !== "faction") continue;
    const faction = snapshot.getShard(descriptor.shardId)?.data;
    if (
      !faction ||
      faction.payloadKind !== "rosterpilot-runtime-faction"
    ) {
      throw new Error(
        `Verified official carry-forward is missing ${descriptor.shardId}.`,
      );
    }
    rulesData.push(faction.rulesData);
    conflicts.push(...faction.officialConflicts);
  }
  return {
    rulesData: mergeRuntimeRulesData(rulesData),
    overlay,
    authority: structuredClone(global.officialAuthority),
    reconciliation: {
      overlayHash: global.officialReconciliation.overlayHash,
      affectedFactions: [
        ...global.officialReconciliation.affectedFactions,
      ],
      conflicts: structuredClone(conflicts),
    },
  };
}

/**
 * Builds against current structured data while preserving official authority
 * from a verified prior bundle. An unchanged structured source may retain its
 * exact effective snapshot (including legacy bundles). A changed 40kdc source
 * must reapply the exact normalized overlay retained by the prior signed
 * bundle; missing entities or mismatched evidence therefore fail closed.
 */
export async function buildRuntimeDataBundleWithRetainedOfficialEvidence(
  input: Parameters<typeof buildRuntimeDataBundle>[0] = {},
  previousSnapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1> | null,
): Promise<RuntimeDataBundleBuild> {
  const candidate = await buildRuntimeDataBundle(input);
  if (
    !previousSnapshot ||
    input.officialOverlay !== undefined ||
    input.inheritedOfficialReconciliation !== undefined ||
    input.inheritedOfficialEvidenceOverlay !== undefined ||
    input.officialAuthority !== undefined
  ) {
    return candidate;
  }
  const retained = await runtimeOfficialCarryForward(previousSnapshot);
  if (!retained) return candidate;
  const officialProvenanceUnchanged =
    previousSnapshot.manifest.provenance.official.version ===
      candidate.draft.provenance.official.version &&
    previousSnapshot.manifest.provenance.official.contentSha256 ===
      candidate.draft.provenance.official.contentSha256;
  if (!officialProvenanceUnchanged) return candidate;

  const rulesProvenanceUnchanged =
    canonicalJson(previousSnapshot.manifest.provenance.rules) ===
    canonicalJson(candidate.draft.provenance.rules);
  if (rulesProvenanceUnchanged) {
    return buildRuntimeDataBundle({
      ...input,
      rulesData: retained.rulesData,
      rulesSourceSha256:
        candidate.draft.provenance.rules.sourceSha256,
      officialAuthority: retained.authority,
      inheritedOfficialReconciliation: retained.reconciliation,
      inheritedOfficialEvidenceOverlay:
        retained.overlay ?? undefined,
    });
  }
  if (!retained.overlay) {
    throw new Error(
      "The verified prior bundle predates retained official overlay evidence, so changed 40kdc rules cannot inherit official authority. Supply the reviewed official evidence again.",
    );
  }
  return buildRuntimeDataBundle({
    ...input,
    officialOverlay: retained.overlay,
    officialAuthority: retained.authority,
  });
}

export function runtimeRosterCompatibilitySnapshot(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
  factionId: string,
): RosterCompatibilitySnapshot {
  const global = runtimeGlobalData(snapshot);
  const faction = snapshot.getFactionShard(factionId)?.data;
  const semantic =
    snapshot.manifest.semanticHashes.factions[factionId];
  if (
    !faction ||
    faction.payloadKind !== "rosterpilot-runtime-faction" ||
    faction.factionId !== factionId ||
    !semantic
  ) {
    throw new Error(
      `Bundle ${snapshot.bundleId} has no verified runtime identity for ${factionId}.`,
    );
  }
  const sources = runtimeCatalogueSources(snapshot.manifest);
  return {
    bundleId: snapshot.bundleId,
    engineDataSchemaVersion:
      snapshot.manifest.engineDataSchemaVersion,
    provenance: {
      package: sources.rules.package,
      version: sources.rules.version,
      edition: sources.rules.edition,
      dataslate: sources.rules.dataslate,
      releaseId: `bundle-${snapshot.bundleId}`,
      newRecruit: {
        repository: sources.newRecruit.repository,
        commit: sources.newRecruit.commit,
        gameSystemRevision:
          global.catalogueBase.gameSystem.revision,
        catalogueRevision:
          faction.catalogue.catalogue.revision,
      },
      official: {
        mfmVersion: sources.official.mfmVersion,
        updatedAt: sources.official.updatedAt,
        contentSha256: sources.official.contentSha256,
        authority: structuredClone(global.officialAuthority),
      },
    },
    factions: {
      [factionId]: {
        factionRulesHash: semantic.factionRulesHash,
        mappingHash: semantic.mappingHash,
        entityHashes: { ...semantic.entityHashes },
      },
    },
  };
}

function runtimeCatalogueSources(
  manifest: VerifiedAcceptedDataBundleManifestV1,
): NewRecruitCatalogueManifest["sources"] {
  if (
    manifest.provenance.rules.package !==
      "@alpaca-software/40kdc-data" ||
    manifest.provenance.rules.edition !== "11th" ||
    manifest.provenance.newRecruit.repository !==
      "BSData/wh40k-11e"
  ) {
    throw new Error(
      "The verified data bundle targets an unsupported roster data source.",
    );
  }
  return {
    rules: {
      package: "@alpaca-software/40kdc-data",
      version: manifest.provenance.rules.version,
      edition: "11th",
      dataslate: manifest.provenance.rules.dataslate,
    },
    newRecruit: {
      repository: "BSData/wh40k-11e",
      branch: manifest.provenance.newRecruit.branch,
      commit: manifest.provenance.newRecruit.commit,
    },
    official: {
      downloadsUrl: manifest.provenance.official.downloadsUrl,
      mfmUrl:
        manifest.provenance.official.dataUrl ??
        manifest.provenance.official.downloadsUrl,
      mfmVersion: manifest.provenance.official.version,
      updatedAt:
        manifest.provenance.official.publishedAt ??
        manifest.provenance.official.checkedAt,
      contentSha256:
        manifest.provenance.official.contentSha256,
      checkedAt: manifest.provenance.official.checkedAt,
    },
  };
}

function runtimeCatalogueSummary(
  factions: NewRecruitCatalogueManifest["factions"],
): NewRecruitCatalogueManifest["summary"] {
  const entries = Object.values(factions);
  const conflicts = entries.flatMap((entry) => entry.conflicts);
  const uniqueKey = (conflict: {
    rootCauseKey?: string;
    id: string;
  }) => conflict.rootCauseKey ?? conflict.id;
  return {
    factionCount: entries.length,
    exportCapableFactions: entries.filter(
      (entry) => entry.configuration !== null,
    ).length,
    completeFactions: entries.filter(
      (entry) => entry.coverage.complete,
    ).length,
    engineUnits: entries.reduce(
      (sum, entry) => sum + entry.coverage.engineUnits,
      0,
    ),
    mappedUnits: entries.reduce(
      (sum, entry) => sum + entry.coverage.mappedUnits,
      0,
    ),
    mappedBaseLoadouts: entries.reduce(
      (sum, entry) =>
        sum + entry.coverage.mappedBaseLoadouts,
      0,
    ),
    conflicts: conflicts.length,
    blockingConflicts: conflicts.filter(
      (entry) => entry.blocking,
    ).length,
    uniqueConflicts: new Set(conflicts.map(uniqueKey)).size,
    uniqueBlockingConflicts: new Set(
      conflicts.filter((entry) => entry.blocking).map(uniqueKey),
    ).size,
  };
}

/**
 * Recompute every compatibility identity from the effective verified payload.
 * A signature proves publisher authority, but these hashes decide cache,
 * roster, export, and certification reuse and therefore cannot be accepted as
 * self-attested metadata from the same manifest.
 */
async function recomputeRuntimeSemanticHashes(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
): Promise<DataBundleSemanticHashesV1> {
  const global = runtimeGlobalData(snapshot);
  const sources = runtimeCatalogueSources(snapshot.manifest);
  const common = {
    releaseId: `bundle-${snapshot.bundleId}`,
    generatedAt: snapshot.manifest.createdAt,
    sources,
  };
  const catalogue: NewRecruitCatalogueManifest = {
    ...structuredClone(global.catalogueBase),
    ...common,
    factions: {},
    summary: {
      factionCount: 0,
      exportCapableFactions: 0,
      completeFactions: 0,
      engineUnits: 0,
      mappedUnits: 0,
      mappedBaseLoadouts: 0,
      conflicts: 0,
      blockingConflicts: 0,
      uniqueConflicts: 0,
      uniqueBlockingConflicts: 0,
    },
  };
  const certification: CertificationDocument = {
    defaults: structuredClone(global.certificationDefaults),
    browserFixtures: structuredClone(
      global.certificationBrowserFixtures,
    ),
    factions: [],
  };
  const ruleParts: RuntimeRulesData[] = [global.rulesData];
  const officialConflicts = new Map<
    string,
    OfficialCommunityConflict[]
  >();
  const legendsByFaction = new Map<
    string,
    RuntimeFactionLegendsState
  >();

  for (const descriptor of snapshot.manifest.shards) {
    if (descriptor.kind !== "faction") continue;
    const value = snapshot.getShard(descriptor.shardId)?.data;
    if (
      !value ||
      value.payloadKind !== "rosterpilot-runtime-faction" ||
      !isSupportedRuntimeDataBundleSchemaVersion(
        value.schemaVersion,
      ) ||
      descriptor.factionIds.length !== 1 ||
      value.factionId !== descriptor.factionIds[0]
    ) {
      throw new Error(
        `The verified faction shard ${descriptor.shardId} is not a supported runtime payload.`,
      );
    }
    assertRuntimeDataBundleShardData(value, descriptor);
    catalogue.factions[value.factionId] =
      structuredClone(value.catalogue);
    ruleParts.push(value.rulesData);
    officialConflicts.set(
      value.factionId,
      structuredClone(value.officialConflicts),
    );
    legendsByFaction.set(
      value.factionId,
      value.schemaVersion === 2
        ? RuntimeFactionLegendsStateSchema.parse(
            structuredClone(value.legends),
          )
        : unavailableFactionLegendsState(value.factionId),
    );
    if (value.certification !== null) {
      const certificationEntry = record(value.certification);
      if (certificationEntry?.id !== value.factionId) {
        throw new Error(
          `Runtime certification evidence for ${value.factionId} has the wrong faction identity.`,
        );
      }
      certification.factions!.push(
        structuredClone(value.certification) as NonNullable<
          CertificationDocument["factions"]
        >[number],
      );
    }
  }

  catalogue.summary = runtimeCatalogueSummary(catalogue.factions);
  const mergedRulesData = mergeRuntimeRulesData(ruleParts);
  for (const [factionId, legends] of legendsByFaction) {
    assertRuntimeFactionLegendsBuildCoherence(
      mergedRulesData,
      legends,
      snapshot.getFactionShard(factionId)?.shardId ??
        `faction:${factionId}`,
    );
  }
  const source = createRuntimeDataset(mergedRulesData);
  const factions: DataBundleSemanticHashesV1["factions"] = {};
  for (const factionId of Object.keys(catalogue.factions).sort()) {
    factions[factionId] = await factionSemanticHashes(
      source,
      catalogue,
      certification,
      factionId,
      officialConflicts.get(factionId) ?? [],
      snapshot.manifest.engineDataSchemaVersion >= 2
        ? legendsByFaction.get(factionId)
        : undefined,
    );
  }
  return {
    globalHash: await semanticHash(
      global.officialAuthority
        ? {
            rules: globalRulesProjection(global.rulesData),
            officialAuthorityStatus:
              global.officialAuthority.status,
          }
        : globalRulesProjection(global.rulesData),
    ),
    methodologyHash: await semanticHash(
      runtimeMethodologyProjection(
        snapshot.manifest.engineDataSchemaVersion,
      ),
    ),
    factions,
  };
}

export async function assertRuntimeDataBundleSemanticIdentity(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
): Promise<void> {
  const recomputed = await recomputeRuntimeSemanticHashes(snapshot);
  if (
    canonicalJson(recomputed) !==
    canonicalJson(snapshot.manifest.semanticHashes)
  ) {
    throw new Error(
      "The signed bundle semantic identities do not match its effective runtime payloads.",
    );
  }
}

export function activateRuntimeDataBundle(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
): void {
  const global = runtimeGlobalData(snapshot);
  const sources = runtimeCatalogueSources(snapshot.manifest);
  const common = {
    releaseId: `bundle-${snapshot.bundleId}`,
    generatedAt: snapshot.manifest.createdAt,
    sources,
  };
  const ruleParts: RuntimeRulesData[] = [global.rulesData];
  const mappings: NewRecruitCatalogueManifest = {
    ...structuredClone(global.catalogueBase),
    ...common,
    factions: {},
    summary: {
      factionCount: 0,
      exportCapableFactions: 0,
      completeFactions: 0,
      engineUnits: 0,
      mappedUnits: 0,
      mappedBaseLoadouts: 0,
      conflicts: 0,
      blockingConflicts: 0,
      uniqueConflicts: 0,
      uniqueBlockingConflicts: 0,
    },
  };
  const summary: NewRecruitCatalogueSummaryManifest = {
    ...structuredClone(global.catalogueSummaryBase),
    ...common,
    factions: {},
    summary: mappings.summary,
  };
  const nextLegends = new Map<
    string,
    RuntimeFactionLegendsState
  >();
  for (const descriptor of snapshot.manifest.shards) {
    if (descriptor.kind !== "faction") continue;
    const value = snapshot.getShard(descriptor.shardId)?.data;
    if (
      !value ||
      value.payloadKind !== "rosterpilot-runtime-faction" ||
      !isSupportedRuntimeDataBundleSchemaVersion(
        value.schemaVersion,
      ) ||
      descriptor.factionIds.length !== 1 ||
      value.factionId !== descriptor.factionIds[0]
    ) {
      throw new Error(
        `The verified faction shard ${descriptor.shardId} is not a supported runtime payload.`,
      );
    }
    assertRuntimeDataBundleShardData(value, descriptor);
    mappings.factions[value.factionId] =
      structuredClone(value.catalogue);
    summary.factions[value.factionId] =
      structuredClone(value.catalogueSummary);
    nextLegends.set(
      value.factionId,
      value.schemaVersion === 2
        ? RuntimeFactionLegendsStateSchema.parse(
            structuredClone(value.legends),
          )
        : unavailableFactionLegendsState(value.factionId),
    );
    ruleParts.push(value.rulesData);
  }
  mappings.summary = runtimeCatalogueSummary(mappings.factions);
  summary.summary = structuredClone(mappings.summary);
  const mergedRulesData = mergeRuntimeRulesData(ruleParts);
  for (const [factionId, legends] of nextLegends) {
    assertRuntimeFactionLegendsBuildCoherence(
      mergedRulesData,
      legends,
      snapshot.getFactionShard(factionId)?.shardId ??
        `faction:${factionId}`,
    );
  }
  const nextDataset = createRuntimeDataset(mergedRulesData);

  // Every potentially throwing parse/construction step has completed. The
  // following synchronous assignments are one event-loop atomic activation.
  activateRuntimeDataset(nextDataset);
  activateNewRecruitCatalogueMappings(mappings);
  activateNewRecruitCatalogueSummary(summary);
  activateLegendsInventory(nextLegends);
  resetRosterCompatibilityIdentityCache();
  setActiveDataBundleManifest(
    snapshot.manifest,
    global.officialAuthority ?? {
      status: "unverified-overlay",
      reason:
        "The active signed bundle predates explicit official-authority evidence status.",
    },
  );
  refreshRuntimeDataConstants();
}

export function createVerifiedRuntimeSnapshot(
  manifest: VerifiedAcceptedDataBundleManifestV1,
  shards: Iterable<
    VerifiedDataBundleShardV1<RuntimeDataBundleShardDataV1>
  >,
): DataBundleSnapshot<RuntimeDataBundleShardDataV1> {
  return createDataBundleSnapshot(manifest, shards);
}

export async function verifyRuntimeDataBundle(input: {
  manifest: unknown;
  shards: Iterable<unknown>;
  trustedKeys: Ed25519KeyRegistry;
}): Promise<
  DataBundleVerificationResult<
    DataBundleSnapshot<RuntimeDataBundleShardDataV1> & {
      readonly manifest: VerifiedDataBundleManifestV1;
      readonly trustOrigin: "signed-verified";
    }
  >
> {
  const manifest = await verifyDataBundleManifest(
    input.manifest,
    input.trustedKeys,
  );
  if (!manifest.ok) return manifest;
  if (
    !isSupportedRuntimeDataBundleSchemaVersion(
      manifest.data.engineDataSchemaVersion,
    )
  ) {
    return {
      ok: false,
      code: "SHARD_IDENTITY_MISMATCH",
      message: `Bundle ${manifest.data.bundleId} requires unsupported engine data schema ${manifest.data.engineDataSchemaVersion}.`,
    };
  }
  const shards: Array<
    VerifiedDataBundleShardV1<RuntimeDataBundleShardDataV1>
  > = [];
  for (const candidate of input.shards) {
    const shard = await verifyDataBundleShard<
      RuntimeDataBundleShardDataV1
    >(manifest.data, candidate);
    if (!shard.ok) return shard;
    try {
      const descriptor = manifest.data.shards.find(
        (entry) => entry.shardId === shard.data.shardId,
      );
      assertRuntimeDataBundleShardData(
        shard.data.data,
        descriptor,
      );
      if (
        shard.data.data.schemaVersion !==
        manifest.data.engineDataSchemaVersion
      ) {
        throw new Error(
          `Runtime shard ${shard.data.shardId} schema ${shard.data.data.schemaVersion} does not match manifest engine schema ${manifest.data.engineDataSchemaVersion}.`,
        );
      }
    } catch (error) {
      return {
        ok: false,
        code: "SHARD_IDENTITY_MISMATCH",
        message:
          error instanceof Error
            ? error.message
            : "Runtime shard payload validation failed.",
      };
    }
    shards.push(shard.data);
  }
  try {
    const snapshot = createVerifiedRuntimeSnapshot(
      manifest.data,
      shards,
    );
    await assertRuntimeDataBundleSemanticIdentity(snapshot);
    return {
      ok: true,
      data: snapshot as DataBundleSnapshot<RuntimeDataBundleShardDataV1> & {
        readonly manifest: VerifiedDataBundleManifestV1;
        readonly trustOrigin: "signed-verified";
      },
    };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof Error &&
        error.message.includes("semantic identities")
          ? "BUNDLE_SEMANTIC_HASH_MISMATCH"
          : "SHARD_IDENTITY_MISMATCH",
      message:
        error instanceof Error
          ? error.message
          : "The runtime data snapshot could not be assembled.",
    };
  }
}
