import assert from "node:assert/strict";
import test from "node:test";

import { Dataset } from "@alpaca-software/40kdc-data";

import {
  buildRoster,
  deriveRosterCompatibilityFactionIdentity,
  parseRosterDraft,
  rebaseRosterData,
  rosterExecutionFingerprint,
  rosterExportFingerprint,
  stampRosterDataIdentity,
  type RosterCompatibilitySnapshot,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import { newRecruitCatalogueMappings } from "../lib/rosterpilot/catalogue";
import {
  serializeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import { newRecruitCacheKey } from "../local/new-recruit/cache";

function fixtureRoster(): RosterDraftV1 {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 500,
    name: "Semantic compatibility fixture",
  });
  assert.ok(
    built.ok && built.data,
    built.violations.map((issue) => issue.message).join("; "),
  );
  return built.data;
}

function provenanceOf(roster: RosterDraftV1) {
  return {
    package: roster.sourceData.package,
    version: roster.sourceData.version,
    edition: roster.sourceData.edition,
    dataslate: roster.sourceData.dataslate,
    releaseId: `${roster.sourceData.releaseId}-metadata-only`,
    newRecruit: {
      ...roster.sourceData.newRecruit,
      commit: "b".repeat(40),
    },
    official: {
      ...roster.sourceData.official,
      updatedAt: "2099-01-01",
    },
  } satisfies RosterCompatibilitySnapshot["provenance"];
}

function snapshotFor(
  roster: RosterDraftV1,
  entityHashes = roster.sourceData.entityHashes,
): RosterCompatibilitySnapshot {
  return {
    bundleId: "b".repeat(64),
    engineDataSchemaVersion:
      roster.sourceData.engineDataSchemaVersion,
    provenance: provenanceOf(roster),
    factions: {
      [roster.factionId]: {
        factionRulesHash: roster.sourceData.factionRulesHash,
        mappingHash: roster.sourceData.mappingHash,
        entityHashes: { ...entityHashes },
      },
    },
  };
}

function semanticSnapshotFor(
  roster: RosterDraftV1,
  identity: ReturnType<
    typeof deriveRosterCompatibilityFactionIdentity
  >,
  bundleMarker: string,
): RosterCompatibilitySnapshot {
  return {
    bundleId: bundleMarker.repeat(64),
    engineDataSchemaVersion:
      roster.sourceData.engineDataSchemaVersion,
    provenance: {
      package: roster.sourceData.package,
      version: roster.sourceData.version,
      edition: roster.sourceData.edition,
      dataslate: roster.sourceData.dataslate,
      releaseId: roster.sourceData.releaseId,
      newRecruit: roster.sourceData.newRecruit,
      official: roster.sourceData.official,
    },
    factions: {
      [roster.factionId]: identity,
    },
  };
}

function spaceMarineLoadoutFixture(): RosterDraftV1 {
  const built = buildRoster({
    faction: "space-marines",
    pointsLimit: 1_000,
    name: "Scoped loadout compatibility fixture",
  });
  assert.ok(
    built.ok && built.data,
    built.violations.map((issue) => issue.message).join("; "),
  );
  const centurions = built.data.units.find(
    (unit) => unit.unitId === "centurion-assault-squad",
  );
  assert.ok(centurions);
  assert.ok(
    centurions.equipment.some(
      (entry) => entry.itemId === "twin-flamer",
    ),
  );
  assert.ok(
    !centurions.equipment.some(
      (entry) => entry.itemId === "twin-meltagun",
    ),
  );
  return built.data;
}

function mutateWeaponDamage(
  rules: ReturnType<typeof serializeRuntimeRulesData>,
  weaponId: string,
): void {
  const weapon = (
    rules.weapons as Array<{
      id: string;
      profiles: Array<{
        stats: {
          D: number | string;
        };
      }>;
    }>
  ).find((entry) => entry.id === weaponId);
  assert.ok(weapon);
  assert.ok(weapon.profiles[0]);
  weapon.profiles[0].stats.D =
    typeof weapon.profiles[0].stats.D === "number"
      ? weapon.profiles[0].stats.D + 1
      : `${weapon.profiles[0].stats.D}+1`;
}

test("schema V3 rebases provenance-only bundle changes without changing selections", () => {
  const roster = fixtureRoster();
  const rebased = rebaseRosterData(roster, {
    snapshot: snapshotFor(roster),
  });
  assert.equal(rebased.ok, true);
  assert.equal(rebased.data?.status, "compatible-rebased");
  assert.deepEqual(rebased.data?.changedScopes, []);
  assert.deepEqual(rebased.data?.roster.units, roster.units);
  assert.equal(rebased.data?.roster.sourceData.bundleId, "b".repeat(64));
  assert.ok(
    rebased.warnings.some(
      (warning) => warning.code === "DATA_PROVENANCE_CHANGED",
    ),
  );
});

test("schema V3 reports the exact referenced scope when semantics change", () => {
  const roster = fixtureRoster();
  const unitKey = Object.keys(roster.sourceData.entityHashes).find(
    (key) => key.startsWith("unit:"),
  );
  assert.ok(unitKey);
  const entityHashes = {
    ...roster.sourceData.entityHashes,
    [unitKey]: "c".repeat(64),
  };
  const rebased = rebaseRosterData(roster, {
    snapshot: snapshotFor(roster, entityHashes),
  });
  assert.equal(rebased.ok, true);
  assert.equal(rebased.data?.status, "review-required");
  assert.deepEqual(
    rebased.data?.changedScopes.map((scope) => ({
      kind: scope.kind,
      entityId: scope.entityId,
      change: scope.change,
    })),
    [
      {
        kind: "unit",
        entityId: unitKey.slice("unit:".length),
        change: "changed",
      },
    ],
  );
  assert.deepEqual(
    rebased.data?.roster.units,
    roster.units,
    "review-required must never rewrite selections",
  );
});

test("V2 rosters remain readable and migrate conservatively to V3", () => {
  const roster = fixtureRoster();
  const legacySourceData = {
    package: roster.sourceData.package,
    version: roster.sourceData.version,
    edition: roster.sourceData.edition,
    dataslate: roster.sourceData.dataslate,
    releaseId: roster.sourceData.releaseId,
    newRecruit: roster.sourceData.newRecruit,
    official: roster.sourceData.official,
  };
  const parsed = parseRosterDraft({
    ...roster,
    schemaVersion: 2,
    sourceData: legacySourceData,
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.migrated, true);
  assert.equal(parsed.migratedFrom, 2);
  assert.equal(parsed.data.schemaVersion, 3);
  assert.equal(parsed.data.sourceData.identityStatus, "legacy-derived");
  assert.equal(parsed.data.sourceData.migratedFrom, 2);
});

test("execution, export, and cache identities invalidate only their semantic scope", () => {
  const roster = fixtureRoster();
  const provenanceOnly = structuredClone(roster);
  provenanceOnly.sourceData.releaseId = "metadata-only-release";
  provenanceOnly.sourceData.newRecruit.commit = "d".repeat(40);
  provenanceOnly.sourceData.bundleId = "d".repeat(64);
  assert.equal(
    rosterExecutionFingerprint(provenanceOnly),
    rosterExecutionFingerprint(roster),
  );
  assert.equal(
    rosterExportFingerprint(provenanceOnly),
    rosterExportFingerprint(roster),
  );
  assert.equal(
    newRecruitCacheKey(provenanceOnly),
    newRecruitCacheKey(roster),
  );

  const mappingChanged = structuredClone(roster);
  mappingChanged.sourceData.mappingHash = "e".repeat(64);
  assert.equal(
    rosterExecutionFingerprint(mappingChanged),
    rosterExecutionFingerprint(roster),
  );
  assert.notEqual(
    rosterExportFingerprint(mappingChanged),
    rosterExportFingerprint(roster),
  );
  assert.notEqual(
    newRecruitCacheKey(mappingChanged),
    newRecruitCacheKey(roster),
  );

  const rulesChanged = structuredClone(roster);
  rulesChanged.sourceData.rosterRulesHash = "f".repeat(64);
  assert.notEqual(
    rosterExecutionFingerprint(rulesChanged),
    rosterExecutionFingerprint(roster),
  );
});

test("roster rules hashes ignore unselected weapon profiles but retain selected profiles", () => {
  const roster = spaceMarineLoadoutFixture();
  const baseRules = serializeRuntimeRulesData();
  const baselineIdentity =
    deriveRosterCompatibilityFactionIdentity({
      source: new Dataset(structuredClone(baseRules)),
      catalogue: structuredClone(newRecruitCatalogueMappings),
      factionId: roster.factionId,
    });
  const baseline = stampRosterDataIdentity(
    roster,
    semanticSnapshotFor(roster, baselineIdentity, "1"),
  );

  const unselectedRules = structuredClone(baseRules);
  mutateWeaponDamage(unselectedRules, "twin-meltagun");
  const unselectedIdentity =
    deriveRosterCompatibilityFactionIdentity({
      source: new Dataset(unselectedRules),
      catalogue: structuredClone(newRecruitCatalogueMappings),
      factionId: roster.factionId,
    });
  const afterUnselectedChange = stampRosterDataIdentity(
    roster,
    semanticSnapshotFor(roster, unselectedIdentity, "2"),
  );
  assert.notEqual(
    unselectedIdentity.factionRulesHash,
    baselineIdentity.factionRulesHash,
    "the complete faction identity still records every weapon",
  );
  assert.equal(
    afterUnselectedChange.sourceData.rosterRulesHash,
    baseline.sourceData.rosterRulesHash,
    "an unused alternative weapon must not invalidate the roster",
  );

  const selectedRules = structuredClone(baseRules);
  mutateWeaponDamage(selectedRules, "twin-flamer");
  const selectedIdentity =
    deriveRosterCompatibilityFactionIdentity({
      source: new Dataset(selectedRules),
      catalogue: structuredClone(newRecruitCatalogueMappings),
      factionId: roster.factionId,
    });
  const afterSelectedChange = stampRosterDataIdentity(
    roster,
    semanticSnapshotFor(roster, selectedIdentity, "3"),
  );
  assert.notEqual(
    afterSelectedChange.sourceData.rosterRulesHash,
    baseline.sourceData.rosterRulesHash,
    "a selected weapon profile remains part of compatibility",
  );
});

test("roster export hashes ignore unselected mapping paths but retain selected paths", () => {
  const roster = spaceMarineLoadoutFixture();
  const source = new Dataset(serializeRuntimeRulesData());
  const baselineCatalogue = structuredClone(
    newRecruitCatalogueMappings,
  );
  const baselineIdentity =
    deriveRosterCompatibilityFactionIdentity({
      source,
      catalogue: baselineCatalogue,
      factionId: roster.factionId,
    });
  const baseline = stampRosterDataIdentity(
    roster,
    semanticSnapshotFor(roster, baselineIdentity, "4"),
  );

  const changeEquipmentPath = (
    catalogue: typeof baselineCatalogue,
    equipmentName: string,
  ) => {
    const mapping =
      catalogue.factions[roster.factionId]?.units[
        "centurion-assault-squad"
      ];
    assert.ok(mapping);
    const reference = mapping.models
      .flatMap((model) => model.equipment)
      .find(
        (entry) =>
          entry.normalizedName ===
          equipmentName,
      );
    assert.ok(reference);
    reference.entryId = `${reference.entryId}::changed`;
  };

  const unselectedCatalogue = structuredClone(baselineCatalogue);
  changeEquipmentPath(unselectedCatalogue, "twin meltagun");
  const unselectedIdentity =
    deriveRosterCompatibilityFactionIdentity({
      source,
      catalogue: unselectedCatalogue,
      factionId: roster.factionId,
    });
  const afterUnselectedChange = stampRosterDataIdentity(
    roster,
    semanticSnapshotFor(roster, unselectedIdentity, "5"),
  );
  assert.notEqual(
    unselectedIdentity.mappingHash,
    baselineIdentity.mappingHash,
    "the faction mapping identity still records every export path",
  );
  assert.equal(
    afterUnselectedChange.sourceData.mappingHash,
    baseline.sourceData.mappingHash,
    "an unused alternative mapping path must not invalidate the roster",
  );

  const selectedCatalogue = structuredClone(baselineCatalogue);
  changeEquipmentPath(selectedCatalogue, "twin flamer");
  const selectedIdentity =
    deriveRosterCompatibilityFactionIdentity({
      source,
      catalogue: selectedCatalogue,
      factionId: roster.factionId,
    });
  const afterSelectedChange = stampRosterDataIdentity(
    roster,
    semanticSnapshotFor(roster, selectedIdentity, "6"),
  );
  assert.notEqual(
    afterSelectedChange.sourceData.mappingHash,
    baseline.sourceData.mappingHash,
    "a selected equipment path remains part of export compatibility",
  );
});
