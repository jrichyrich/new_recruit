import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dataset,
  tryImportRoster,
} from "@alpaca-software/40kdc-data";
import { unzipSync, strFromU8 } from "fflate";

import {
  buildRoster,
  exportRoster,
  modifyRoster,
  searchFactions,
  searchUnits,
  validateRoster,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import { writeExportArtifact } from "../lib/rosterpilot/io";

const fixtures = new URL("./fixtures/", import.meta.url);

test("searches real faction and unit data while gating build support", () => {
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

  const unsupported = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.violations[0]?.code, "UNSUPPORTED_FACTION");
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
  const valid = buildRoster({ pointsLimit: 1000 });
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

test("exports interoperable XML, zipped .rosz, JSON, text, and HTML", () => {
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
    const result = exportRoster(built.data, format);
    assert.equal(result.ok, true, `${format} export should pass`);
    assert.ok(result.data);
    if (format === "ros") {
      assert.match(result.data.content as string, /<roster\b/);
      assert.match(result.data.content as string, /Adeptus Custodes/);
      assert.match(
        result.data.content as string,
        /battleScribeVersion="2\.03"/,
      );
      assert.match(
        result.data.content as string,
        /gameSystemId="sys-352e-adc2-7639-d610"/,
      );
      assert.match(
        result.data.content as string,
        /catalogueId="1f19-6509-d906-ca10"/,
      );
      assert.match(result.data.content as string, /name="Force Disposition"/);
    }
    if (format === "rosz") {
      const entries = unzipSync(result.data.content as Uint8Array);
      const names = Object.keys(entries);
      assert.equal(names.length, 1);
      assert.match(names[0], /\.ros$/);
      assert.match(strFromU8(entries[names[0]]), /<roster\b/);
    }
    if (format === "html") {
      assert.match(result.data.content as string, /@media print/);
    }
  }
});

test("protects export paths and existing files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-test-"));
  try {
    const built = buildRoster({ pointsLimit: 1000 });
    assert.ok(built.data);
    const result = exportRoster(built.data, "text");
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
