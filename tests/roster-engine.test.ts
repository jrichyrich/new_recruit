import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dataset,
  factions,
  tryImportRoster,
} from "@alpaca-software/40kdc-data";
import { unzipSync, strFromU8 } from "fflate";

import {
  buildRoster,
  checkDataFreshness,
  explainRoster,
  exportRoster,
  getDataStatus,
  getNewRecruitCapability,
  modifyRoster,
  modifyRosterBatch,
  parseRosterDraft,
  prepareNewRecruitHandoff,
  searchFactions,
  searchUnits,
  validateRoster,
  type BuildRosterInput,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import {
  conflictBlocksAllUnitConfigurations,
  conflictsForRoster,
  newRecruitCatalogue,
} from "../lib/rosterpilot/catalogue-summary";
import { getNewRecruitFactionCatalogue } from "../lib/rosterpilot/catalogue";
import type { DataConflict } from "../lib/rosterpilot/catalogue-types";
import {
  writeExportArtifact,
  writeExportArtifacts,
} from "../lib/rosterpilot/io";

const fixtures = new URL("./fixtures/", import.meta.url);

function installSyntheticConflict(conflict: DataConflict): () => void {
  const conflicts =
    newRecruitCatalogue.factions[conflict.factionId]?.conflicts;
  assert.ok(conflicts, `Missing conflict fixture faction ${conflict.factionId}`);
  conflicts.push(conflict);
  return () => {
    const index = conflicts.indexOf(conflict);
    if (index >= 0) conflicts.splice(index, 1);
  };
}

test("searches and builds real faction data across the supported catalog", () => {
  const factionResult = searchFactions("custodes");
  assert.equal(factionResult.ok, true);
  assert.equal(factionResult.data?.[0].id, "adeptus-custodes");
  assert.equal(factionResult.data?.[0].supported, true);

  const unitResult = searchUnits({
    faction: "adeptus-custodes",
    query: "praetors",
  });
  assert.equal(unitResult.ok, true);
  assert.ok(unitResult.data?.some((unit) => unit.id === "vertus-praetors"));

  const aeldari = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    preferences: ["mobility", "shooting", "objective"],
  });
  assert.equal(aeldari.ok, true);
  assert.equal(aeldari.data?.factionId, "aeldari");
  assert.ok((aeldari.data?.totalPoints ?? 0) >= 980);
  assert.ok(aeldari.data?.units.some((unit) => unit.tags.includes("mobility")));
});

test("distinguishes the player faction from an opponent in prose", () => {
  const inferred = buildRoster({
    prompt:
      "Build a 1000 point Aeldari army to battle an unknown Adeptus Custodes list.",
    pointsLimit: 1000,
  });
  assert.equal(
    inferred.ok,
    true,
    inferred.violations.map((violation) => violation.message).join("; "),
  );
  assert.equal(inferred.data?.factionId, "aeldari");
  assert.equal(
    inferred.data?.constraints.opponentFactionId,
    "adeptus-custodes",
  );

  const explicit = buildRoster({
    prompt:
      "Build a 1000 point Aeldari army to battle an unknown Adeptus Custodes list.",
    playerFaction: "aeldari",
    pointsLimit: 1000,
    opponentContext: {
      kind: "known-faction",
      factionId: "adeptus-custodes",
    },
  });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.data?.factionId, "aeldari");
  assert.equal(
    explicit.data?.constraints.opponentFactionId,
    "adeptus-custodes",
  );
  const explanation = explainRoster(explicit.data!);
  assert.equal(
    explanation.data?.optimizer.generatorVersion,
    "beam-search-v1",
  );
  assert.deepEqual(
    explanation.data?.optimizer.scoreOrder.slice(0, 3),
    [
      "hard constraints and legality",
      "New Recruit exportability",
      "points utilization",
    ],
  );
  assert.equal(
    explanation.data?.optimizer.targetProfileCoverage
      ?.opponentFactionId,
    "adeptus-custodes",
  );
  assert.ok(
    explanation.data?.optimizer.selectedCandidates.every(
      (candidate) =>
        Number.isFinite(candidate.components.total),
    ),
  );
});

test("builds against an exact opponent roster and records owned-model limits", () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
    preferences: ["shooting", "mobility"],
  });
  assert.ok(opponent.ok && opponent.data);
  const seed = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(seed.ok && seed.data);
  const ownedUnits = [...new Set(seed.data.units.map((unit) => unit.unitId))]
    .map((unitId) => {
      const selections = seed.data!.units.filter(
        (unit) => unit.unitId === unitId,
      );
      return {
        unitId,
        maxUnits: selections.length,
        maxModels: selections.reduce(
          (sum, unit) => sum + unit.modelCount,
          0,
        ),
      };
    });
  const matchup = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    collectionProfile: {
      mode: "owned",
      units: ownedUnits,
    },
    opponentContext: {
      kind: "known-roster",
      roster: opponent.data,
    },
  });
  assert.ok(
    matchup.ok && matchup.data,
    matchup.violations.map((issue) => issue.message).join("; "),
  );
  assert.equal(
    matchup.data.constraints.opponentFactionId,
    "aeldari",
  );
  assert.ok(matchup.data.constraints.opponentRosterFingerprint);
  assert.equal(
    matchup.data.constraints.opponentThreatProfile?.bodyCount,
    opponent.data.units.reduce(
      (sum, unit) => sum + unit.modelCount,
      0,
    ),
  );
  for (const owned of ownedUnits) {
    const selected = matchup.data.units.filter(
      (unit) => unit.unitId === owned.unitId,
    );
    assert.ok(selected.length <= owned.maxUnits);
    assert.ok(
      selected.reduce((sum, unit) => sum + unit.modelCount, 0) <=
        owned.maxModels,
    );
  }
  const explanation = explainRoster(matchup.data);
  assert.equal(
    explanation.data?.optimizer.targetProfileCoverage
      ?.opponentRosterFingerprint,
    matchup.data.constraints.opponentRosterFingerprint,
  );
});

test("keeps generic Sentinel defaults but selects anti-elite profiles against Custodes", async () => {
  const requiredUnitIds = [
    "armoured-sentinels",
    "scout-sentinels",
  ];
  const generic = buildRoster({
    playerFaction: "astra-militarum",
    pointsLimit: 1000,
    requiredUnitIds,
  });
  assert.ok(generic.ok && generic.data);
  const genericSentinels = generic.data.units.filter(
    (unit) => requiredUnitIds.includes(unit.unitId),
  );
  assert.ok(genericSentinels.length >= 2);
  assert.ok(
    genericSentinels.every((unit) =>
      unit.equipment.some(
        (equipment) =>
          equipment.itemId === "multi-laser",
      ),
    ),
  );

  const matchup = buildRoster({
    playerFaction: "astra-militarum",
    pointsLimit: 1000,
    requiredUnitIds,
    opponentContext: {
      kind: "known-faction",
      factionId: "adeptus-custodes",
    },
  });
  assert.ok(
    matchup.ok && matchup.data,
    matchup.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  const matchupSentinels = matchup.data.units.filter(
    (unit) => requiredUnitIds.includes(unit.unitId),
  );
  assert.ok(matchupSentinels.length >= 2);
  assert.ok(
    matchupSentinels.every(
      (unit) =>
        !unit.equipment.some(
          (equipment) =>
            equipment.itemId === "multi-laser",
        ) &&
        unit.equipment.some(
          (equipment) =>
            equipment.itemId === "lascannon",
        ),
    ),
  );
  assert.equal(validateRoster(matchup.data).ok, true);
  const exported = await exportRoster(matchup.data, "rosz");
  assert.equal(
    exported.ok,
    true,
    exported.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  const explanation = explainRoster(matchup.data);
  assert.ok(
    explanation.data?.optimizer.targetProfileCoverage
      ?.selectedProfileEvidence.some(
        (evidence) =>
          /Lascannon.*S 12.*AP -3/i.test(evidence),
      ),
  );
  assert.ok(
    explanation.data?.optimizer.selectedCandidates
      .filter((candidate) =>
        requiredUnitIds.includes(candidate.unitId),
      )
      .every((candidate) =>
        candidate.equipmentSignature.includes("lascannon"),
      ),
  );
});

test("distinguishes whole-unit blockers from scoped configuration conflicts", () => {
  const base: DataConflict = {
    id: "synthetic-conflict",
    rootCauseKey: "synthetic-root",
    factionId: "adeptus-custodes",
    entityType: "points",
    entityId: "prosecutors",
    entityName: "Prosecutors",
    code: "POINTS_MISMATCH",
    blocking: true,
    message: "Synthetic points conflict.",
    source: "bsdata",
  };
  assert.equal(conflictBlocksAllUnitConfigurations(base), true);
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...base,
      entityId: "prosecutors:6",
      scope: { modelCount: 6 },
    }),
    false,
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...base,
      entityId: "prosecutors:6",
    }),
    false,
    "legacy numeric entity suffixes remain model-count scoped",
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...base,
      entityType: "equipment",
      entityId: "prosecutors:boltgun",
    }),
    false,
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...base,
      entityType: "unit",
    }),
    true,
  );
});

test("the builder selects an exportable model count around a scoped conflict", async () => {
  const input: BuildRosterInput = {
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Scoped conflict regression",
    requiredUnitIds: ["prosecutors"],
  };
  const baseline = buildRoster(input);
  assert.equal(
    baseline.ok,
    true,
    baseline.violations.map((issue) => issue.message).join("; "),
  );
  assert.ok(baseline.data);
  const baselineSelection = baseline.data.units.find(
    (selection) => selection.unitId === "prosecutors",
  );
  assert.ok(baselineSelection);
  const conflict: DataConflict = {
    id: "synthetic-prosecutors-model-count",
    rootCauseKey: "synthetic-prosecutors-model-count",
    factionId: "adeptus-custodes",
    entityType: "points",
    entityId: `prosecutors:${baselineSelection.modelCount}`,
    entityName: "Prosecutors",
    code: "POINTS_MISMATCH",
    blocking: true,
    message: `Synthetic conflict for ${baselineSelection.modelCount} Prosecutors.`,
    rulesValue: baselineSelection.points,
    newRecruitValue: baselineSelection.points + 5,
    source: "bsdata",
    scope: { modelCount: baselineSelection.modelCount },
  };
  const removeConflict = installSyntheticConflict(conflict);
  try {
    const built = buildRoster(input);
    assert.equal(
      built.ok,
      true,
      built.violations.map((issue) => issue.message).join("; "),
    );
    assert.ok(built.data);
    const selected = built.data.units.filter(
      (selection) => selection.unitId === "prosecutors",
    );
    assert.ok(selected.length > 0);
    assert.ok(
      selected.every(
        (selection) =>
          selection.modelCount !== baselineSelection.modelCount,
      ),
      "the beam must keep the unit and choose an unblocked model count",
    );
    assert.equal(
      conflictsForRoster(built.data).some(
        (item) => item.id === conflict.id,
      ),
      false,
    );
    const exported = await exportRoster(built.data, "rosz");
    assert.equal(
      exported.ok,
      true,
      exported.violations.map((issue) => issue.message).join("; "),
    );
  } finally {
    removeConflict();
  }
});

test("a required legal unit outranks exportability and fails only at export preflight", async () => {
  const conflict: DataConflict = {
    id: "synthetic-required-unit-conflict",
    rootCauseKey: "synthetic-required-unit-conflict",
    factionId: "adeptus-custodes",
    entityType: "unit",
    entityId: "prosecutors",
    entityName: "Prosecutors",
    code: "UNMAPPED",
    blocking: true,
    message: "Synthetic whole-unit New Recruit mapping conflict.",
    source: "bsdata",
  };
  const removeConflict = installSyntheticConflict(conflict);
  try {
    const built = buildRoster({
      playerFaction: "adeptus-custodes",
      pointsLimit: 1000,
      name: "Required mapping boundary",
      requiredUnitIds: ["prosecutors"],
    });
    assert.equal(
      built.ok,
      true,
      built.violations.map((issue) => issue.message).join("; "),
    );
    assert.ok(built.data);
    assert.ok(
      built.data.units.some(
        (selection) => selection.unitId === "prosecutors",
      ),
    );
    assert.ok(
      built.warnings.some(
        (warning) => warning.code === "DATA_SOURCE_CONFLICT",
      ),
    );
    const exported = await exportRoster(built.data, "rosz");
    assert.equal(exported.ok, false);
    assert.equal(exported.data, null);
    assert.ok(
      exported.violations.some(
        (issue) => issue.code === "NEW_RECRUIT_DATA_CONFLICT",
      ),
    );
  } finally {
    removeConflict();
  }
});

test("a canonical faction name suppresses nested generic aliases", () => {
  const deathGuard = buildRoster({
    prompt: "Build a 1000 point Death Guard army.",
    pointsLimit: 1000,
  });
  assert.equal(
    deathGuard.ok,
    true,
    deathGuard.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  assert.equal(deathGuard.data?.factionId, "death-guard");

  const inferredOpponent = buildRoster({
    prompt:
      "Build a 1000 point Death Guard army against an unknown Orks list.",
    pointsLimit: 1000,
  });
  assert.equal(
    inferredOpponent.ok,
    true,
    inferredOpponent.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  assert.equal(inferredOpponent.data?.factionId, "death-guard");
  assert.equal(inferredOpponent.data?.constraints.opponentFactionId, "orks");
});

test("honors prompt and structured hard unit constraints", () => {
  const result = buildRoster({
    prompt:
      "Build a 1000 point Aeldari army. Must include Farseer Skyrunner. Do not select Warlock Skyrunners.",
    playerFaction: "aeldari",
    pointsLimit: 1000,
    requiredWarlordUnitId: "farseer-skyrunner",
  });
  assert.equal(
    result.ok,
    true,
    result.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(result.data);
  assert.ok(
    result.data.units.some(
      (unit) =>
        unit.unitId === "farseer-skyrunner" && unit.isWarlord,
    ),
  );
  assert.equal(
    result.data.units.some(
      (unit) => unit.unitId === "warlock-skyrunners",
    ),
    false,
  );
  assert.deepEqual(result.data.constraints.requiredUnitIds, [
    "farseer-skyrunner",
  ]);
  assert.deepEqual(result.data.constraints.excludedUnitIds, [
    "warlock-skyrunners",
  ]);
});

test("rejects an ineligible Warlord and validates an eligible mapped one", () => {
  const built = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
    requiredUnitIds: ["warlock-skyrunners"],
    requiredWarlordUnitId: "farseer-skyrunner",
  });
  assert.ok(built.data);
  const warlock = built.data.units.find(
    (unit) => unit.unitId === "warlock-skyrunners",
  );
  assert.ok(warlock);
  const invalid = modifyRoster(built.data, {
    type: "set-warlord",
    selectionId: warlock.selectionId,
  });
  assert.equal(invalid.ok, false);
  assert.ok(
    invalid.violations.some(
      (violation) => violation.code === "WARLORD_INELIGIBLE",
    ),
  );
  assert.equal(
    validateRoster(built.data).warnings.some(
      (warning) =>
        warning.code === "NEW_RECRUIT_WARLORD_MAPPING_UNAVAILABLE",
    ),
    false,
  );
});

test("retains a required named unit when a separate exportable Warlord is required", async () => {
  const artemisMapping =
    getNewRecruitFactionCatalogue("adeptus-astartes")?.units[
      "watch-captain-artemis"
    ];
  assert.ok(artemisMapping);
  assert.equal(artemisMapping.warlord, undefined);

  const built = buildRoster({
    playerFaction: "adeptus-astartes",
    pointsLimit: 1000,
    preferences: ["objective", "durability"],
    allowNamedCharacters: true,
    allowLegends: false,
    requiredUnitIds: ["watch-captain-artemis"],
    requiredWarlordUnitId: "captain-in-phobos-armour",
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(built.data);
  assert.ok(
    built.data.units.some(
      (unit) =>
        unit.unitId === "watch-captain-artemis" &&
        !unit.isWarlord,
    ),
  );
  assert.ok(
    built.data.units.some(
      (unit) =>
        unit.unitId === "captain-in-phobos-armour" &&
        unit.isWarlord,
    ),
  );
  assert.deepEqual(built.data.constraints.requiredUnitIds, [
    "captain-in-phobos-armour",
    "watch-captain-artemis",
  ]);
  const exported = await exportRoster(built.data, "rosz");
  assert.equal(
    exported.ok,
    true,
    exported.violations.map((violation) => violation.message).join("; "),
  );
});

test("applies roster modifications atomically and validates the final draft", () => {
  const built = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const removable = [...built.data.units]
    .filter((unit) => !unit.isWarlord && unit.points >= 50)
    .sort((left, right) => left.points - right.points)[0];
  assert.ok(removable);
  const result = modifyRosterBatch(built.data, [
    { type: "add", unitId: "shadowseer" },
    { type: "remove", selectionId: removable.selectionId },
  ]);
  assert.equal(
    result.ok,
    true,
    result.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(result.data?.units.some((unit) => unit.unitId === "shadowseer"));
  assert.equal(
    result.data?.units.some(
      (unit) => unit.selectionId === removable.selectionId,
    ),
    false,
  );
});

test("builds and validates every embedded faction at common game sizes", () => {
  for (const pointsLimit of [500, 1000, 2000]) {
    for (const faction of factions.all) {
      const result = buildRoster({
        faction: faction.id,
        pointsLimit,
        name: `${faction.name} coverage`,
        preferences: ["mobility", "objective", "shooting"],
        allowLegends: false,
      });
      assert.equal(
        result.ok,
        true,
        `${faction.name} at ${pointsLimit}: ${result.violations
          .map((item) => `${item.code}: ${item.message}`)
          .join("; ")}`,
      );
      assert.equal(result.data?.factionId, faction.id);
      assert.ok((result.data?.units.length ?? 0) > 0);
    }
  }
});

test("exports a validated Aeldari roster with an eligible mapped Warlord", async () => {
  const result = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    name: "Aeldari Rapid Strike",
    preferences: ["mobility", "shooting", "objective"],
  });
  assert.ok(result.data);

  const html = await exportRoster(result.data, "html");
  assert.equal(html.ok, true);
  assert.match(String(html.data?.content), /Aeldari Rapid Strike/);

  const rosz = await exportRoster(result.data, "rosz");
  assert.equal(
    rosz.ok,
    true,
    rosz.violations.map((item) => item.message).join("; "),
  );
  assert.equal(
    result.data.units.find((unit) => unit.isWarlord)?.unitId,
    "farseer-skyrunner",
  );
});

test("records semantic source identity and migrates V1 drafts", async () => {
  const built = buildRoster({ faction: "adeptus-custodes", pointsLimit: 1000 });
  assert.ok(built.data);
  assert.equal(built.data.schemaVersion, 3);
  assert.match(built.data.sourceData.bundleId, /^[0-9a-f]{64}$/);
  assert.match(built.data.sourceData.rosterRulesHash, /^[0-9a-f]{64}$/);
  assert.match(built.data.sourceData.mappingHash, /^[0-9a-f]{64}$/);
  assert.match(built.data.sourceData.newRecruit.commit, /^[0-9a-f]{40}$/);
  assert.match(built.data.sourceData.official.contentSha256, /^[0-9a-f]{64}$/);

  const legacy = JSON.parse(
    await readFile(new URL("golden-boys-435.json", fixtures), "utf8"),
  ) as unknown;
  const migrated = parseRosterDraft(legacy);
  assert.equal(migrated.success, true);
  if (!migrated.success) return;
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.data.schemaVersion, 3);
  assert.equal(migrated.data.sourceData.migratedFrom, 1);

  const status = getDataStatus();
  assert.equal(status.data?.sources.releaseId, built.data.sourceData.releaseId);
  assert.equal(
    status.data?.sources.newRecruit.commit,
    built.data.sourceData.newRecruit.commit,
  );
});

test("exports a conflict-free non-Custodes roster through generated mappings", async () => {
  const built = buildRoster({
    faction: "necrons",
    pointsLimit: 1000,
    allowNamedCharacters: false,
  });
  assert.ok(built.data);
  assert.equal(getNewRecruitCapability("necrons").available, true);
  const exported = await exportRoster(built.data, "rosz");
  assert.equal(
    exported.ok,
    true,
    exported.violations.map((item) => item.message).join("; "),
  );
  assert.ok(exported.data);
});

test("checks all live source classes without changing the pinned build", async () => {
  const mockFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org")) {
      return new Response(
        JSON.stringify({
          version: newRecruitCatalogue.sources.rules.version,
        }),
      );
    }
    if (url.includes("api.github.com")) {
      return new Response(
        JSON.stringify({ sha: "1111111111111111111111111111111111111111" }),
      );
    }
    return new Response("<html><h2>v1.1</h2><main>changed</main></html>");
  };
  const freshness = await checkDataFreshness({
    fetch: mockFetch as typeof fetch,
  });
  assert.equal(freshness.ok, true);
  assert.equal(freshness.data?.state, "update-available");
  assert.equal(freshness.data?.rules.updateAvailable, false);
  assert.equal(freshness.data?.newRecruit.updateAvailable, true);
  assert.ok(
    freshness.warnings.some(
      (item) => item.code === "DATA_PROVENANCE_CHANGED",
    ),
  );
});

test("returns a stable envelope for malformed roster schemas", () => {
  const result = validateRoster({
    schemaVersion: 1,
    units: [],
  } as unknown as RosterDraftV1);
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.equal(result.violations[0]?.code, "MALFORMED_ROSTER");
});

test("builds the acceptance Custodes roster deterministically", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("valid-custodes-build.json", fixtures), "utf8"),
  ) as {
    input: Parameters<typeof buildRoster>[0];
    expected: {
      factionId: string;
      pointsLimit: number;
      totalPoints: number;
      legal: boolean;
      allowNamedCharacters: boolean;
    };
  };
  const first = buildRoster(fixture.input);
  const second = buildRoster(fixture.input);
  assert.ok(first.data);
  assert.ok(second.data);
  assert.equal(first.ok, fixture.expected.legal);
  assert.equal(first.data.factionId, fixture.expected.factionId);
  assert.equal(first.data.pointsLimit, fixture.expected.pointsLimit);
  assert.equal(first.data.totalPoints, fixture.expected.totalPoints);
  assert.equal(
    first.data.constraints.allowNamedCharacters,
    fixture.expected.allowNamedCharacters,
  );
  assert.deepEqual(
    first.data.units.map((unit) => [
      unit.unitId,
      unit.modelCount,
      unit.points,
      unit.isWarlord,
    ]),
    second.data.units.map((unit) => [
      unit.unitId,
      unit.modelCount,
      unit.points,
      unit.isWarlord,
    ]),
  );
});

test("uses model-count and army-ordinal pricing", () => {
  const base = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 2000,
    preferences: ["mobility"],
    allowNamedCharacters: false,
  });
  assert.ok(base.data);

  const addFirst = modifyRoster(base.data, {
    type: "add",
    unitId: "blade-champion",
  });
  assert.ok(addFirst.data);
  const champions = addFirst.data.units.filter(
    (unit) => unit.unitId === "blade-champion",
  );
  assert.ok(champions.length >= 2);
  assert.equal(champions[0].points, 110);
  assert.equal(champions[1].points, 125);

  const addPraetors = modifyRoster(base.data, {
    type: "add",
    unitId: "vertus-praetors",
    modelCount: 2,
  });
  assert.ok(addPraetors.data);
  const praetors = addPraetors.data.units.find(
    (unit) => unit.unitId === "vertus-praetors",
  );
  assert.ok(praetors);
  const resized = modifyRoster(addPraetors.data, {
    type: "set-model-count",
    selectionId: praetors.selectionId,
    modelCount: 3,
  });
  assert.ok(resized.data);
  assert.equal(
    resized.data.units.find(
      (unit) => unit.selectionId === praetors.selectionId,
    )?.points,
    215,
  );
});

test("honors collection and named-character constraints", () => {
  const result = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    preferences: ["mobility"],
    allowNamedCharacters: false,
    collectionUnitIds: [
      "blade-champion",
      "vertus-praetors",
      "allarus-custodians",
      "pallas-grav-attack",
    ],
  });
  assert.ok(result.data);
  assert.ok(
    result.data.units.every((unit) =>
      [
        "blade-champion",
        "vertus-praetors",
        "allarus-custodians",
        "pallas-grav-attack",
      ].includes(unit.unitId),
    ),
  );
  const epicIds = new Set(
    (searchUnits({
      faction: "adeptus-custodes",
      includeLegends: true,
      limit: 100,
    }).data ?? [])
      .filter((unit) => unit.isNamedCharacter)
      .map((unit) => unit.id),
  );
  assert.ok(result.data.units.every((unit) => !epicIds.has(unit.unitId)));
});

test("surfaces illegal loadouts and the sanitized Golden Boys fixture", async () => {
  const valid = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(valid.data);
  const selection = valid.data.units.find((unit) => unit.equipment.length > 0);
  assert.ok(selection);
  const illegal = modifyRoster(valid.data, {
    type: "set-equipment",
    selectionId: selection.selectionId,
    equipment: [
      {
        itemId: selection.equipment[0].itemId,
        count: 99,
      },
    ],
  });
  assert.equal(illegal.ok, false);
  assert.ok(
    illegal.violations.some((violation) =>
      violation.code.startsWith("LOADOUT_"),
    ),
  );

  const goldenBoys = JSON.parse(
    await readFile(new URL("golden-boys-435.json", fixtures), "utf8"),
  ) as RosterDraftV1;
  const result = validateRoster(goldenBoys);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.code === "NO_WARLORD"));
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.code === "POINTS_OVER_LIMIT" ||
        violation.code === "DISPOSITION_INVALID" ||
        violation.code === "POINT_LIMIT_INVALID",
    ),
  );
});

test("parses sanitized authenticated New Recruit fixtures without rules prose", async () => {
  const json = await readFile(
    new URL("new-recruit/golden-boys.json", fixtures),
    "utf8",
  );
  assert.doesNotMatch(json, /"(?:rules|profiles|description)"\s*:/);
  const imported = tryImportRoster(json, { dataset });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.equal(imported.format, "newrecruit-json");
  assert.equal(imported.roster.name, "Golden Boys");
  assert.equal(imported.roster.faction_id, "adeptus-custodes");
  assert.equal(imported.roster.points.total_reported, 435);
  assert.deepEqual(
    imported.roster.units.map((unit) => [
      unit.ref.id,
      unit.model_count,
      unit.points,
    ]),
    [
      ["vertus-praetors", 2, 145],
      ["vertus-praetors", 2, 145],
      ["vertus-praetors", 2, 145],
    ],
  );

  const xml = await readFile(
    new URL("new-recruit/golden-boys.ros", fixtures),
    "utf8",
  );
  assert.doesNotMatch(xml, /<(?:rules|profiles)>/);
  assert.match(xml, /battleScribeVersion="2\.03"/);
  assert.match(xml, /gameSystemId="sys-352e-adc2-7639-d610"/);
  assert.match(xml, /catalogueId="1f19-6509-d906-ca10"/);

  const archive = await readFile(
    new URL("new-recruit/golden-boys.rosz", fixtures),
  );
  const entries = unzipSync(archive);
  assert.deepEqual(Object.keys(entries), ["golden-boys.ros"]);
  assert.equal(strFromU8(entries["golden-boys.ros"]), xml);
});

test("exports interoperable XML, zipped .rosz, JSON, text, and HTML", async () => {
  const built = buildRoster({
    prompt: "Build a 1,000 point fast Custodes army with no named characters",
  });
  assert.ok(built.data);
  for (const format of [
    "ros",
    "rosz",
    "newrecruit-json",
    "roster-json",
    "text",
    "html",
  ] as const) {
    const result = await exportRoster(built.data, format);
    assert.equal(result.ok, true, `${format} export should pass`);
    assert.ok(result.data);
    if (format === "ros") {
      const xml = result.data.content as string;
      assert.match(xml, /<roster\b/);
      assert.match(xml, /Adeptus Custodes/);
      assert.match(
        xml,
        /battleScribeVersion="2\.03"/,
      );
      assert.match(
        xml,
        /gameSystemId="sys-352e-adc2-7639-d610"/,
      );
      assert.match(
        xml,
        /catalogueId="1f19-6509-d906-ca10"/,
      );
      assert.match(xml, /name="Force Disposition"/);
      assert.doesNotMatch(xml, /\bentry(?:Group)?Id="rp-/);
      assert.match(
        xml,
        /name="Battle Size" entryId="7380-3e40-6ed6-b7cc::564e-fbc6-5266-3ea4"/,
      );
      assert.match(
        xml,
        /name="Detachments" entryId="9d4f-c524-e432-f877::5218-339c-eb34-9ac0"/,
      );
      assert.match(
        xml,
        /name="Shield Host" entryId="9d4f-c524-e432-f877::70eb-2978-3ad5-5901"/,
      );
      assert.match(
        xml,
        /name="Purge the Foe" entryId="8bc8-6bfe-78bd-2480::9c70-af87-0c32-afcf::7da4-f0a6-65ec-da48"/,
      );
      assert.match(
        xml,
        /name="Blade Champion" entryId="473-b72d-a70b-e3aa::48b7-e713-d5b1-f11c"/,
      );
      assert.match(
        xml,
        /name="Allarus Custodians" entryId="9f10-d8db-a7b3-5784::c8a6-a4c5-703e-b717"/,
      );
      const mapping = getNewRecruitFactionCatalogue(built.data.factionId);
      assert.ok(mapping);
      for (const selection of built.data.units) {
        const unitMapping = mapping.units[selection.unitId];
        assert.ok(unitMapping, `${selection.name} should have a mapping`);
        assert.match(
          xml,
          new RegExp(
            `entryId="${unitMapping.entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
          ),
        );
      }
    }
    if (format === "rosz") {
      const entries = unzipSync(result.data.content as Uint8Array);
      const names = Object.keys(entries);
      assert.equal(names.length, 1);
      assert.match(names[0], /\.ros$/);
      const xml = strFromU8(entries[names[0]]);
      assert.match(xml, /<roster\b/);
      assert.doesNotMatch(xml, /\bentry(?:Group)?Id="rp-/);
      assert.match(
        xml,
        /name="Allarus Custodian \(Guardian Spear\)" entryId="9f10-d8db-a7b3-5784::b690-3f83-ec6a-401f"/,
      );
    }
    if (format === "html") {
      assert.match(result.data.content as string, /@media print/);
    }
  }
});

test("exports mixed model compositions using canonical unit roles and loadouts", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    prompt: "Build a legal Custodes roster that must include Prosecutors",
  });
  assert.ok(built.data);
  const prosecutors = built.data.units.find(
    (selection) => selection.unitId === "prosecutors",
  );
  assert.ok(prosecutors);
  assert.equal(prosecutors.modelCount, 6);

  const exported = await exportRoster(built.data, "ros");
  assert.equal(
    exported.ok,
    true,
    exported.violations.map((item) => item.message).join("; "),
  );
  assert.ok(exported.data);
  const xml = exported.data.content as string;
  assert.match(
    xml,
    /name="Prosecutor Sister Superior"[^>]+number="1"[^>]+type="model"/,
  );
  assert.match(
    xml,
    /name="Prosecutor"[^>]+group="3-9 Prosecutors"[^>]+number="5"[^>]+type="model"/,
  );
  assert.match(
    xml,
    /name="Boltgun"[^>]+number="1"[^>]+type="upgrade"/,
  );
  assert.match(
    xml,
    /name="Boltgun"[^>]+number="5"[^>]+type="upgrade"/,
  );
});

test("exports legal mixed weapon choices as separate New Recruit model groups", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 2000,
    allowNamedCharacters: false,
  });
  assert.ok(built.data);
  const replacedSelection = built.data.units.find(
    (selection) => !selection.isWarlord && selection.points >= 215,
  );
  assert.ok(replacedSelection);
  const replaced = modifyRoster(built.data, {
    type: "replace",
    selectionId: replacedSelection.selectionId,
    unitId: "vertus-praetors",
    modelCount: 3,
  });
  assert.ok(replaced.data);
  const praetors = replaced.data.units.find(
    (selection) => selection.unitId === "vertus-praetors",
  );
  assert.ok(praetors);

  const mixed = modifyRoster(replaced.data, {
    type: "set-equipment",
    selectionId: praetors.selectionId,
    equipment: [
      { itemId: "interceptor-lance-vertus-praetors", count: 3 },
      { itemId: "salvo-launcher", count: 1 },
      { itemId: "vertus-hurricane-bolter", count: 2 },
    ],
  });
  assert.equal(
    mixed.ok,
    true,
    mixed.violations.map((item) => item.message).join("; "),
  );
  assert.ok(mixed.data);

  const exported = await exportRoster(mixed.data, "ros");
  assert.equal(
    exported.ok,
    true,
    exported.violations.map((item) => item.message).join("; "),
  );
  assert.ok(exported.data);
  const xml = exported.data.content as string;
  assert.match(
    xml,
    /name="Vertus Praetor \(Hurricane Bolter\)"[^>]+number="2"[^>]+type="model"/,
  );
  assert.match(
    xml,
    /name="Vertus Praetor \(Salvo Launcher\)"[^>]+number="1"[^>]+type="model"/,
  );
});

test("prepares a validated New Recruit handoff with editable and printable artifacts", async () => {
  const built = buildRoster({
    prompt: "Build a 1,000 point fast Custodes army with no named characters",
  });
  assert.ok(built.data);

  const handoff = await prepareNewRecruitHandoff(built.data);
  assert.equal(handoff.ok, true);
  assert.ok(handoff.data);
  assert.equal(
    handoff.data.importUrl,
    "https://www.newrecruit.eu/app/MyLists",
  );
  assert.deepEqual(
    handoff.data.artifacts.map((artifact) => artifact.format),
    ["rosz", "html"],
  );
  assert.equal(handoff.data.artifacts[0].encoding, "binary");
  assert.equal(handoff.data.artifacts[1].encoding, "utf8");

  const invalid = {
    ...built.data,
    totalPoints: built.data.totalPoints + 1,
  };
  const blocked = await prepareNewRecruitHandoff(invalid);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.data, null);
  assert.ok(blocked.violations.length > 0);
});

test("exports every browser prompt idea with real New Recruit references", async () => {
  const prompts = [
    {
      prompt: "Build a 1,000 point fast Custodes army with no named characters",
      pointsLimit: 1000,
    },
    {
      prompt: "Build a durable 1,500 point Custodes army for objective play",
      pointsLimit: 1500,
    },
    {
      prompt: "Build a 2,000 point elite Custodes force with shooting support",
      pointsLimit: 2000,
    },
  ];

  for (const input of prompts) {
    const built = buildRoster({
      ...input,
      preferences: ["mobility"],
      allowNamedCharacters: false,
    });
    assert.ok(built.data);
    const exported = await exportRoster(built.data, "rosz");
    assert.equal(
      exported.ok,
      true,
      `${input.pointsLimit}-point browser prompt should export`,
    );
    assert.ok(exported.data);
    const entries = unzipSync(exported.data.content as Uint8Array);
    const [filename] = Object.keys(entries);
    const xml = strFromU8(entries[filename]);
    assert.doesNotMatch(xml, /\bentry(?:Group)?Id="rp-/);
    const mapping = getNewRecruitFactionCatalogue(built.data.factionId);
    assert.ok(mapping);
    for (const selection of built.data.units) {
      const unitMapping = mapping.units[selection.unitId];
      assert.ok(unitMapping, `${selection.name} should have a mapping`);
      assert.match(
        xml,
        new RegExp(
          `entryId="${unitMapping.entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
        ),
      );
    }
  }
});

test("exports every conflict-free default faction build accepted by preflight", async () => {
  let attempted = 0;
  for (const faction of factions.all) {
    const built = buildRoster({
      faction: faction.id,
      pointsLimit: 1000,
      allowLegends: false,
    });
    assert.ok(built.data, `${faction.name} should build`);
    if (!built.data || !getNewRecruitCapability(faction.id).available) {
      continue;
    }
    const conflicts = conflictsForRoster(built.data).filter(
      (item) => item.blocking,
    );
    if (conflicts.length > 0) continue;

    attempted += 1;
    const exported = await exportRoster(built.data, "rosz");
    assert.equal(
      exported.ok,
      true,
      `${faction.name}: ${exported.violations
        .map((item) => item.message)
        .join("; ")}`,
    );
  }
  assert.ok(attempted > 0);
});

test("scopes New Recruit equipment conflicts to selected wargear", () => {
  const base = {
    factionId: "adeptus-custodes",
    detachmentId: "shield-host",
    units: [
      {
        unitId: "allarus-custodians",
        modelCount: 2,
        equipment: [
          {
            itemId: "guardian-spear",
            name: "Guardian spear",
            count: 2,
          },
        ],
      },
    ],
  };
  assert.equal(
    conflictsForRoster(base).some(
      (item) => item.entityId === "allarus-custodians:vexilla",
    ),
    false,
  );
  assert.equal(
    conflictsForRoster({
      ...base,
      units: [
        {
          ...base.units[0],
          equipment: [
            ...base.units[0].equipment,
            { itemId: "vexilla", name: "Vexilla", count: 1 },
          ],
        },
      ],
    }).some(
      (item) => item.entityId === "allarus-custodians:vexilla",
    ),
    true,
  );
});

test("protects export paths and existing files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-test-"));
  try {
    const built = buildRoster({
      prompt: "Build a 1,000 point fast Custodes army with no named characters",
    });
    assert.ok(built.data);
    const result = await exportRoster(built.data, "text");
    assert.ok(result.data);
    const written = await writeExportArtifact(result.data, "list.txt", {
      rootDir: directory,
    });
    assert.equal(path.dirname(written), directory);
    await assert.rejects(
      writeExportArtifact(result.data, "list.txt", { rootDir: directory }),
      /Refusing to overwrite/,
    );
    await assert.rejects(
      writeExportArtifact(result.data, "../outside.txt", {
        rootDir: directory,
      }),
      /outside/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflights every New Recruit handoff file before batch writing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-handoff-"));
  try {
    const built = buildRoster({
      prompt: "Build a 1,000 point fast Custodes army with no named characters",
    });
    assert.ok(built.data);
    const handoff = await prepareNewRecruitHandoff(built.data);
    assert.ok(handoff.data);

    const written = await writeExportArtifacts(
      handoff.data.artifacts,
      "exports",
      { rootDir: directory },
    );
    assert.equal(written.length, 2);
    assert.ok(written.every((filename) => path.dirname(filename).endsWith("exports")));

    await assert.rejects(
      writeExportArtifacts(handoff.data.artifacts, "exports", {
        rootDir: directory,
      }),
      /Refusing to overwrite existing files/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
