import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildRoster } from "../lib/rosterpilot";
import {
  createRuntimeDataset,
  serializeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import {
  compileRosterForLocalTesseraEngine,
  localInputSha256,
  serializeLocalTesseraEngineInput,
  verifyLocalTesseraEngineInput,
} from "../local/tessera/local-engine-input";
import { prepareRosterForLocalTesseraEngine } from "../local/tessera/local-engine-preparation";
import {
  aggregateProfileRequirements,
  profilePolicyHash,
  profilePolicyScaffold,
} from "../local/tessera/profile-policy";
import {
  buildCustodesVsAeldariSmokeRoster,
  resolvedProfilePolicy,
} from "./helpers/tessera-local-bundle";

test("explicit data context, not the process-global Dataset, drives local profiles", () => {
  const result = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1_000,
    requiredUnitIds: ["fire-prism"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const roster = result.data;
  const firePrism = roster.units.find(
    (selection) => selection.unitId === "fire-prism",
  );
  assert.ok(firePrism);
  const selectedEquipmentIds = new Set(
    firePrism.equipment
      .filter((equipment) => equipment.count > 0)
      .map((equipment) => equipment.itemId),
  );
  const capturedRules = structuredClone(serializeRuntimeRulesData());
  const capturedWeapon = capturedRules.weapons.find(
    (weapon) =>
      weapon.faction_id === roster.factionId &&
      selectedEquipmentIds.has(weapon.id),
  );
  assert.ok(capturedWeapon);
  for (const profile of capturedWeapon.profiles) {
    profile.stats.S = 99;
  }
  const policy = resolvedProfilePolicy(roster);
  const globalInput = compileRosterForLocalTesseraEngine(roster, policy);
  const capturedInput = compileRosterForLocalTesseraEngine(
    roster,
    policy,
    {
      dataset: createRuntimeDataset(capturedRules),
      bundleId: roster.sourceData.bundleId,
      engineDataSchemaVersion:
        roster.sourceData.engineDataSchemaVersion,
    },
  );
  const strengths = (input: typeof capturedInput) =>
    input.units
      .find((unit) => unit.selectionId === firePrism.selectionId)
      ?.weapons
      .filter((weapon) =>
        weapon.name.startsWith(capturedWeapon.name),
      )
      .map((weapon) => weapon.S) ?? [];
  assert.ok(strengths(globalInput).every((strength) => strength !== 99));
  assert.ok(strengths(capturedInput).length > 0);
  assert.ok(strengths(capturedInput).every((strength) => strength === 99));
});

test("bundle-native compiler preserves hybrid phases and replacement weapon counts", () => {
  const result = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1_000,
    requiredUnitIds: ["striking-scorpions"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const roster = result.data;
  const compiled = compileRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
  );
  const source = roster.units.find(
    (unit) => unit.unitId === "striking-scorpions",
  );
  assert.ok(source);
  const unit = compiled.units.find(
    (candidate) => candidate.selectionId === source.selectionId,
  );
  assert.ok(unit);
  assert.equal(unit.models, 6);
  assert.deepEqual(
    unit.profiles?.map((profile) => ({
      name: profile.name,
      count: profile.count,
      W: profile.W,
    })),
    [{ name: "Striking Scorpion Exarch", count: 1, W: 2 }],
  );
  assert.deepEqual(
    unit.weapons
      .filter((weapon) => weapon.type === "melee")
      .map((weapon) => [weapon.name, weapon.count]),
    [
      ["Scorpion chainsword", 5],
      ["Scorpion's claw", 1],
    ],
  );
});

test("bundle-native firing-set policy retains disjoint pistol bearers", () => {
  const result = buildRoster({
    playerFaction: "adeptus-mechanicus",
    pointsLimit: 1_000,
    requiredUnitIds: ["pteraxii-sterylizors"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const roster = result.data;
  const compiled = compileRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
  );
  const source = roster.units.find(
    (unit) => unit.unitId === "pteraxii-sterylizors",
  );
  assert.ok(source);
  const unit = compiled.units.find(
    (candidate) => candidate.selectionId === source.selectionId,
  );
  assert.ok(unit);
  assert.deepEqual(
    unit.weapons.map((weapon) => [weapon.name, weapon.count]),
    [
      ["Flechette blaster", 1],
      ["Phosphor torch", 5],
      ["Pteraxii talons", 5],
      ["Taser goad", 1],
    ],
  );
  assert.ok(
    compiled.limitations.frozenChoices.some(
      (choice) =>
        choice.selectionId === source.selectionId &&
        choice.kind === "pistol-or-other" &&
        choice.omitted.length === 0,
    ),
  );
});

test("bundle-native firing-set policy fails closed when bearer groups cannot be resolved", () => {
  const result = buildRoster({
    playerFaction: "adeptus-mechanicus",
    pointsLimit: 1_000,
    requiredUnitIds: ["pteraxii-sterylizors"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const roster = structuredClone(result.data);
  const source = roster.units.find(
    (unit) => unit.unitId === "pteraxii-sterylizors",
  );
  assert.ok(source);
  const flechette = source.equipment.find(
    (equipment) => equipment.itemId === "flechette-blaster",
  );
  const torch = source.equipment.find(
    (equipment) => equipment.itemId === "phosphor-torch",
  );
  assert.ok(flechette && torch);
  flechette.count = 2;
  torch.count = 4;
  roster.units = [source];
  roster.totalPoints = source.points;
  assert.throws(
    () =>
      compileRosterForLocalTesseraEngine(
        roster,
        resolvedProfilePolicy(roster),
      ),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "TESSERA_LOCAL_WEAPON_CHOICE_UNSUPPORTED",
  );
});

test("bundle-native firing-set policy allocates full-coverage pistols to uncovered models", () => {
  const result = buildRoster({
    playerFaction: "astra-militarum",
    pointsLimit: 1_000,
    requiredUnitIds: ["catachan-command-squad"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const source = result.data.units.find(
    (unit) => unit.unitId === "catachan-command-squad",
  );
  assert.ok(source);
  const roster = {
    ...result.data,
    units: [source],
    totalPoints: source.points,
  };
  const compiled = compileRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
  );
  const unit = compiled.units[0];
  assert.deepEqual(
    unit.weapons
      .filter((weapon) => weapon.type === "ranged")
      .map((weapon) => [weapon.name, weapon.count]),
    [
      ["Lasgun", 4],
      ["Laspistol", 1],
    ],
  );
  assert.ok(
    compiled.limitations.frozenChoices.some(
      (choice) =>
        choice.selectionId === source.selectionId &&
        choice.kind === "pistol-or-other" &&
        choice.selected.includes("Laspistol x1") &&
        choice.omitted.includes("Laspistol x4"),
    ),
  );
});

test("bundle-native firing-set policy resolves the exact non-pistol bearer union", () => {
  const result = buildRoster({
    playerFaction: "adepta-sororitas",
    pointsLimit: 1_000,
    requiredUnitIds: ["retributor-squad"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const source = result.data.units.find(
    (unit) => unit.unitId === "retributor-squad",
  );
  assert.ok(source);
  const roster = {
    ...result.data,
    units: [source],
    totalPoints: source.points,
  };
  const compiled = compileRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
  );
  const unit = compiled.units[0];
  assert.deepEqual(
    unit.weapons
      .filter((weapon) => weapon.type === "ranged")
      .map((weapon) => [weapon.name, weapon.count]),
    [
      ["Boltgun", 1],
      ["Heavy bolter", 4],
    ],
  );
  assert.ok(
    compiled.limitations.frozenChoices.some(
      (choice) =>
        choice.selectionId === source.selectionId &&
        choice.kind === "pistol-or-other" &&
        choice.omitted.includes("Bolt pistol x5") &&
        /exact per-model loadout groups/i.test(choice.reason),
    ),
  );
});

test("bundle-native firing-set policy preserves pistols only on a proven pistol-only model", () => {
  const result = buildRoster({
    playerFaction: "adeptus-astartes",
    pointsLimit: 1_000,
    requiredUnitIds: ["company-heroes"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const source = result.data.units.find(
    (unit) => unit.unitId === "company-heroes",
  );
  assert.ok(source);
  const roster = {
    ...result.data,
    units: [source],
    totalPoints: source.points,
  };
  const compiled = compileRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
  );
  const unit = compiled.units[0];
  assert.deepEqual(
    Object.fromEntries(
      unit.weapons
        .filter((weapon) => weapon.type === "ranged")
        .map((weapon) => [weapon.name, weapon.count]),
    ),
    {
      "Bolt pistol": 1,
      "Bolt rifle": 1,
      "Master-crafted bolt rifle": 2,
      "Master-crafted heavy bolter": 2,
    },
  );
});

test("bundle-native compiler classifies HAZARDOUS as an omitted engine effect", () => {
  const result = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1_000,
    requiredUnitIds: ["kharseth"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const source = result.data.units.find((unit) => unit.unitId === "kharseth");
  assert.ok(source);
  const roster = {
    ...result.data,
    units: [source],
    totalPoints: source.points,
  };
  const compiled = compileRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
  );
  const hazardousWeapon = compiled.units[0].weapons.find(
    (weapon) => weapon.name === "Dread of the Deep Void",
  );
  assert.ok(hazardousWeapon);
  assert.equal(hazardousWeapon.keywords.includes("HAZARDOUS"), false);
  assert.ok(
    compiled.limitations.unsupportedWeaponKeywords.some(
      (limitation) =>
        limitation.selectionId === source.selectionId &&
        limitation.weaponName === "Dread of the Deep Void" &&
        limitation.keyword === "HAZARDOUS",
    ),
  );
});

test("bundle-native compiler classifies CONVERSION as an omitted range-dependent effect", () => {
  const result = buildRoster({
    playerFaction: "leagues-of-votann",
    pointsLimit: 1_000,
    requiredUnitIds: ["hekaton-land-fortress"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const selected = result.data.units.find(
    (unit) => unit.unitId === "hekaton-land-fortress",
  );
  assert.ok(selected);
  const source = {
    ...selected,
    equipment: selected.equipment.map((item) =>
      item.itemId === "cyclic-ion-cannon"
        ? {
            itemId: "sp-heavy-conversion-beamer",
            name: "SP heavy conversion beamer",
            count: item.count,
          }
        : item,
    ),
  };
  const roster = {
    ...result.data,
    units: [source],
    totalPoints: source.points,
  };
  const compiled = compileRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
  );
  const conversionWeapon = compiled.units[0].weapons.find(
    (weapon) => weapon.name === "SP heavy conversion beamer",
  );
  assert.ok(conversionWeapon);
  assert.equal(conversionWeapon.keywords.includes("CONVERSION"), false);
  assert.ok(
    compiled.limitations.unsupportedWeaponKeywords.some(
      (limitation) =>
        limitation.selectionId === source.selectionId &&
        limitation.weaponName === "SP heavy conversion beamer" &&
        limitation.keyword === "CONVERSION",
    ),
  );
});

test("local preparation reports artifact-write failures separately from compilation", async () => {
  const roster = buildCustodesVsAeldariSmokeRoster();
  const result = await prepareRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
    {
      outputDirectory: path.resolve(
        process.cwd(),
        "..",
        "rosterpilot-local-engine-write-rejection",
      ),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.violations[0]?.code,
    "TESSERA_LOCAL_ARTIFACT_WRITE_FAILED",
  );
});

test("bundle-native input verification rejects post-freeze mutation", () => {
  const roster = buildCustodesVsAeldariSmokeRoster();
  const input = compileRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
  );
  const shieldCaptain = input.units.find(
    (unit) => unit.name === "Shield-Captain",
  );
  assert.ok(shieldCaptain);
  assert.deepEqual(
    shieldCaptain.weapons.map((weapon) => weapon.type),
    ["ranged", "melee"],
  );
  const content = serializeLocalTesseraEngineInput(input);
  const changed = Buffer.from(content);
  changed[changed.length - 2] = changed[changed.length - 2] === 32 ? 33 : 32;
  assert.throws(
    () =>
      verifyLocalTesseraEngineInput({
        content: changed,
        expectedSha256: localInputSha256(content),
        expectedBundleId: roster.sourceData.bundleId,
      }),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "TESSERA_LOCAL_INPUT_CHANGED",
  );
});

test("bundle-native input verification rejects semantic engine corruption with a recomputed hash", () => {
  const roster = buildCustodesVsAeldariSmokeRoster();
  const original = compileRosterForLocalTesseraEngine(
    roster,
    resolvedProfilePolicy(roster),
  );
  const invalidInputs = [
    (() => {
      const input = structuredClone(original);
      const weapon = input.units
        .flatMap((unit) => unit.weapons)
        .find(
          (candidate) =>
            candidate.type === "ranged" &&
            candidate.BS !== undefined &&
            !candidate.keywords.includes("TORRENT"),
        );
      assert.ok(weapon);
      delete weapon.BS;
      weapon.WS = 2;
      return input;
    })(),
    (() => {
      const input = structuredClone(original);
      const weapon = input.units
        .flatMap((unit) => unit.weapons)
        .find((candidate) => candidate.type === "melee");
      assert.ok(weapon);
      delete weapon.WS;
      weapon.BS = 2;
      return input;
    })(),
    (() => {
      const input = structuredClone(original);
      input.units[0].weapons[0].keywords.push("UNSUPPORTED TEST RULE");
      return input;
    })(),
    (() => {
      const input = structuredClone(original);
      input.units[0].profiles = [
        {
          name: "Impossible duplicate body",
          count: input.units[0].models,
          T: input.units[0].T,
          SV: input.units[0].SV,
          W: input.units[0].W,
          INV: input.units[0].INV,
          FNP: input.units[0].FNP,
        },
      ];
      return input;
    })(),
    (() => {
      const input = structuredClone(original);
      input.units[1].instanceId = input.units[0].instanceId;
      return input;
    })(),
    (() => {
      const input = structuredClone(original);
      input.units[1].selectionId = input.units[0].selectionId;
      return input;
    })(),
    (() => {
      const input = structuredClone(original);
      input.units[1].label = input.units[0].label;
      input.units[1].occurrence = input.units[0].occurrence;
      return input;
    })(),
  ];

  for (const input of invalidInputs) {
    const content = Buffer.from(`${JSON.stringify(input, null, 2)}\n`);
    assert.throws(
      () =>
        verifyLocalTesseraEngineInput({
          content,
          expectedSha256: localInputSha256(content),
          expectedBundleId: roster.sourceData.bundleId,
        }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        "TESSERA_LOCAL_INPUT_INVALID",
    );
  }
});

test("bundle-native compiler applies an explicit non-default alternate profile", () => {
  const result = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1_000,
    requiredUnitIds: ["fire-prism"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
  });
  assert.ok(result.ok && result.data);
  const roster = result.data;
  const requirements = aggregateProfileRequirements([roster]);
  const scaffold = profilePolicyScaffold(requirements);
  const policy = {
    ...scaffold,
    entries: scaffold.entries.map((entry, index) => ({
      ...entry,
      selectedProfile:
        requirements[index].availableProfiles.at(-1) ??
        requirements[index].availableProfiles[0],
    })),
  };
  const compiled = compileRosterForLocalTesseraEngine(roster, policy);
  const firePrism = compiled.units.find((unit) => unit.name === "Fire Prism");
  assert.ok(firePrism);
  assert.deepEqual(
    firePrism.weapons
      .filter((weapon) => weapon.name.startsWith("Prism cannon"))
      .map((weapon) => ({
        name: weapon.name,
        count: weapon.count,
        A: weapon.A,
        S: weapon.S,
        AP: weapon.AP,
        D: weapon.D,
      })),
    [
      {
        name: "Prism cannon — Focused lances",
        count: 1,
        A: 2,
        S: 18,
        AP: -4,
        D: 6,
      },
    ],
  );
  assert.equal(compiled.profilePolicySha256, profilePolicyHash(policy));
  assert.deepEqual(
    compiled.limitations.frozenChoices
      .filter(
        (choice) =>
          choice.unitName === "Fire Prism" &&
          choice.kind === "alternate-profile",
      )
      .map((choice) => ({
        selected: choice.selected,
        omitted: choice.omitted,
      })),
    [
      {
        selected: ["Focused lances"],
        omitted: ["Dispersed pulse"],
      },
    ],
  );
  assert.throws(
    () => compileRosterForLocalTesseraEngine(roster, null),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "TESSERA_LOCAL_PROFILE_POLICY_REQUIRED",
  );
});
