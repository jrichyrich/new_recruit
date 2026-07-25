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
  prepareNewRecruitHandoff,
  searchFactions,
  searchUnits,
  validateRoster,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import {
  writeExportArtifact,
  writeExportArtifacts,
} from "../lib/rosterpilot/io";

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
      assert.match(
        xml,
        /name="Agamatus Custodians" entryId="28a9-923b-c230-bc66::00ab-41c4-cf52-4ad2"/,
      );
      assert.match(
        xml,
        /name="Pallas Grav-attack" entryId="7b13-004f-1fb5-97f8::06df-2fb2-8dfa-2fce"/,
      );
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
      assert.match(
        xml,
        /name="Agamatus Custodian \(Lastrum bolt cannon\)" entryId="28a9-923b-c230-bc66::de32-bd86-91c0-6d95"/,
      );
    }
    if (format === "html") {
      assert.match(result.data.content as string, /@media print/);
    }
  }
});

test("prepares a validated New Recruit handoff with editable and printable artifacts", () => {
  const built = buildRoster({
    prompt: "Build a 1,000 point fast Custodes army with no named characters",
  });
  assert.ok(built.data);

  const handoff = prepareNewRecruitHandoff(built.data);
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
  const blocked = prepareNewRecruitHandoff(invalid);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.data, null);
  assert.ok(blocked.violations.length > 0);
});

test("exports every browser prompt idea with real New Recruit references", () => {
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
    const exported = exportRoster(built.data, "rosz");
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
    for (const selection of built.data.units) {
      assert.match(xml, new RegExp(`name="${selection.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    }
  }
});

test("protects export paths and existing files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-test-"));
  try {
    const built = buildRoster({
      prompt: "Build a 1,000 point fast Custodes army with no named characters",
    });
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

test("preflights every New Recruit handoff file before batch writing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-handoff-"));
  try {
    const built = buildRoster({
      prompt: "Build a 1,000 point fast Custodes army with no named characters",
    });
    assert.ok(built.data);
    const handoff = prepareNewRecruitHandoff(built.data);
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
