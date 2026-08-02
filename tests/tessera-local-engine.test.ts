import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  compileEnrichedRoszForLocalEngine,
  LOCAL_TESSERA_ENGINE_IDENTITY,
  runLocalTesseraEngineMatchup,
} from "../local/tessera/local-engine";

function enrichedRosz(input: {
  rosterName: string;
  unitName: string;
  selectionId: string;
  weaponKeyword?: string;
  ability?: string;
  rule?: string;
  pistolChoice?: boolean;
  extraMeleeChoice?: boolean;
  uppercaseSave?: boolean;
  invulnerableAbility?: boolean;
  alternateRifleProfiles?: boolean;
}): Uint8Array {
  const ability = input.ability
    ? `<profile name="Active ability" typeName="Abilities"><characteristics><characteristic name="Description">${input.ability}</characteristic></characteristics></profile>`
    : "";
  const rule = input.rule
    ? `<rules><rule name="Selected combat rule"><description>${input.rule}</description></rule></rules>`
    : "";
  const invulnerableAbility = input.invulnerableAbility
    ? `<profile name="Invulnerable Save" typeName="Abilities"><characteristics><characteristic name="Description">4+ invulnerable save</characteristic></characteristics></profile>`
    : "";
  const rifleProfiles = input.alternateRifleProfiles
    ? `<profile name="➤ Fixture rifle - focused" typeName="Ranged Weapons"><characteristics>
          <characteristic name="Range">24&quot;</characteristic><characteristic name="A">2</characteristic><characteristic name="BS">3+</characteristic><characteristic name="S">4</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">${input.weaponKeyword ?? "Rapid Fire 1"}</characteristic>
        </characteristics></profile><profile name="➤ Fixture rifle - dispersed" typeName="Ranged Weapons"><characteristics>
          <characteristic name="Range">24&quot;</characteristic><characteristic name="A">4</characteristic><characteristic name="BS">3+</characteristic><characteristic name="S">3</characteristic><characteristic name="AP">0</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">-</characteristic>
        </characteristics></profile>`
    : `<profile name="Fixture rifle" typeName="Ranged Weapons"><characteristics>
          <characteristic name="Range">24&quot;</characteristic><characteristic name="A">2</characteristic><characteristic name="BS">3+</characteristic><characteristic name="S">4</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">${input.weaponKeyword ?? "Rapid Fire 1"}</characteristic>
        </characteristics></profile>`;
  const pistol = input.pistolChoice
    ? `<selection id="${input.selectionId}-pistol" name="Fixture pistol" number="2" type="upgrade"><profiles><profile name="Fixture pistol" typeName="Ranged Weapons"><characteristics>
          <characteristic name="Range">12&quot;</characteristic><characteristic name="A">1</characteristic><characteristic name="BS">3+</characteristic><characteristic name="S">4</characteristic><characteristic name="AP">0</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">Pistol</characteristic>
        </characteristics></profile></profiles></selection>`
    : "";
  const secondBlade = input.extraMeleeChoice
    ? `<selection id="${input.selectionId}-axe" name="Fixture axe" number="2" type="upgrade"><profiles><profile name="Fixture axe" typeName="Melee Weapons"><characteristics>
          <characteristic name="Range">Melee</characteristic><characteristic name="A">2</characteristic><characteristic name="WS">3+</characteristic><characteristic name="S">5</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">-</characteristic>
        </characteristics></profile></profiles></selection>`
    : "";
  const xml = `<?xml version="1.0"?>
<roster name="${input.rosterName}" generatedBy="https://newrecruit.eu" gameSystemId="fixture-system" gameSystemName="Warhammer 40,000 11th Edition" gameSystemRevision="1">
  <costs><cost name="pts" value="100" /></costs>
  <forces><force name="Fixture" catalogueName="Fixture Faction" catalogueId="fixture" catalogueRevision="1"><selections>
    <selection id="${input.selectionId}" name="${input.unitName}" number="1" type="unit">
      <profiles>
        <profile name="${input.unitName}" typeName="Unit"><characteristics>
          <characteristic name="M">6&quot;</characteristic><characteristic name="T">4</characteristic><characteristic name="${input.uppercaseSave ? "SV" : "Sv"}">3+</characteristic><characteristic name="W">2</characteristic><characteristic name="LD">6+</characteristic><characteristic name="OC">1</characteristic>${input.invulnerableAbility ? "" : '<characteristic name="InSv">-</characteristic>'}
        </characteristics></profile>
        ${ability}
        ${invulnerableAbility}
      </profiles>
      ${rule}
      <selections>
        <selection id="${input.selectionId}-models" name="Fixture models" number="2" type="model" />
        <selection id="${input.selectionId}-rifle" name="Fixture rifle" number="2" type="upgrade"><profiles>${rifleProfiles}</profiles></selection>
        ${pistol}
        <selection id="${input.selectionId}-blade" name="Fixture blade" number="2" type="upgrade"><profiles><profile name="Fixture blade" typeName="Melee Weapons"><characteristics>
          <characteristic name="Range">Melee</characteristic><characteristic name="A">2</characteristic><characteristic name="WS">3+</characteristic><characteristic name="S">4</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">-</characteristic>
        </characteristics></profile></profiles></selection>
        ${secondBlade}
      </selections>
      <costs><cost name="pts" value="100" /></costs>
      <categories><category name="Infantry" /></categories>
    </selection>
  </selections></force></forces>
</roster>`;
  return zipSync({ "fixture.ros": strToU8(xml) });
}

test("strict local compiler preserves selected counts, profiles, and immutable identity", () => {
  const compiled = compileEnrichedRoszForLocalEngine(
    enrichedRosz({
      rosterName: "Player",
      unitName: "Wardens",
      selectionId: "wardens-1",
    }),
  );

  assert.equal(compiled.units.length, 1);
  assert.equal(compiled.units[0].selectionId, "wardens-1");
  assert.equal(compiled.units[0].models, 2);
  assert.equal(compiled.units[0].weapons.length, 2);
  assert.equal(compiled.units[0].weapons[0].count, 2);
  assert.deepEqual(compiled.units[0].keywords, ["INFANTRY"]);
  assert.equal(LOCAL_TESSERA_ENGINE_IDENTITY.promotion, "candidate");
  assert.equal(LOCAL_TESSERA_ENGINE_IDENTITY.licenseState, "evaluation-only");
});

test("local compiler accepts New Recruit save casing, numeric invulnerable profiles, and frozen alternate names", () => {
  const compiled = compileEnrichedRoszForLocalEngine(
    enrichedRosz({
      rosterName: "Player",
      unitName: "Wardens",
      selectionId: "wardens-1",
      uppercaseSave: true,
      invulnerableAbility: true,
      alternateRifleProfiles: true,
    }),
    {
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: [
        {
          faction: "Fixture Faction",
          unit: "Wardens",
          unitOccurrence: 1,
          modelCount: 2,
          weaponGroup: "Fixture rifle",
          phase: "shooting",
          selectedProfile: "focused",
          activeCount: 2,
        },
      ],
    },
  );

  assert.equal(compiled.units[0].SV, 3);
  assert.equal(compiled.units[0].INV, 4);
  assert.equal(compiled.units[0].weapons[0].name, "➤ Fixture rifle - focused");
});

test("local runner emits deterministic browser-compatible full matrices", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-local-engine-"));
  try {
    const playerPath = path.join(directory, "player.rosz");
    const opponentPath = path.join(directory, "opponent.rosz");
    await Promise.all([
      writeFile(
        playerPath,
        enrichedRosz({
          rosterName: "Player",
          unitName: "Wardens",
          selectionId: "wardens-1",
        }),
      ),
      writeFile(
        opponentPath,
        enrichedRosz({
          rosterName: "Opponent",
          unitName: "Guardians",
          selectionId: "guardians-1",
        }),
      ),
    ]);
    const input = {
      profileDirectory: directory,
      playerRoszPath: playerPath,
      playerName: "Player",
      opponentRoszPath: opponentPath,
      opponentName: "Opponent",
    };
    const first = await runLocalTesseraEngineMatchup(input);
    const second = await runLocalTesseraEngineMatchup(input);

    assert.equal(first.scenarios.length, 16);
    assert.equal(first.scenarios.every((scenario) => scenario.cells.length === 1), true);
    assert.deepEqual(
      first.scenarios.map((scenario) => scenario.matrixSha256),
      second.scenarios.map((scenario) => scenario.matrixSha256),
    );
    assert.equal(first.uiIdentity, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local compiler fails closed on unsupported active rules", () => {
  assert.throws(
    () =>
      compileEnrichedRoszForLocalEngine(
        enrichedRosz({
          rosterName: "Unsupported",
          unitName: "Seers",
          selectionId: "seers-1",
          weaponKeyword: "Mystery Barrage D3",
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "TESSERA_LOCAL_KEYWORD_UNSUPPORTED",
  );
  assert.throws(
    () =>
      compileEnrichedRoszForLocalEngine(
        enrichedRosz({
          rosterName: "Unsupported",
          unitName: "Seers",
          selectionId: "seers-1",
          ability: "Each time this unit attacks, re-roll the Hit roll.",
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "TESSERA_LOCAL_ACTIVE_ABILITY_UNSUPPORTED",
  );
  assert.throws(
    () =>
      compileEnrichedRoszForLocalEngine(
        enrichedRosz({
          rosterName: "Unsupported",
          unitName: "Seers",
          selectionId: "seers-1",
          rule: "Each time this unit attacks, re-roll the Wound roll.",
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "TESSERA_LOCAL_ACTIVE_RULE_UNSUPPORTED",
  );
});

test("local compiler rejects ambiguous phase weapon choices", () => {
  for (const candidate of [
    { pistolChoice: true },
    { extraMeleeChoice: true },
  ]) {
    assert.throws(
      () =>
        compileEnrichedRoszForLocalEngine(
          enrichedRosz({
            rosterName: "Unsupported",
            unitName: "Choice unit",
            selectionId: "choice-1",
            ...candidate,
          }),
        ),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_LOCAL_WEAPON_CHOICE_UNSUPPORTED",
    );
  }
});

test("local runner rejects unknown frozen settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-local-engine-settings-"));
  try {
    const playerPath = path.join(directory, "player.rosz");
    const opponentPath = path.join(directory, "opponent.rosz");
    await Promise.all([
      writeFile(playerPath, enrichedRosz({ rosterName: "Player", unitName: "Wardens", selectionId: "wardens-1" })),
      writeFile(opponentPath, enrichedRosz({ rosterName: "Opponent", unitName: "Guardians", selectionId: "guardians-1" })),
    ]);
    await assert.rejects(
      runLocalTesseraEngineMatchup({
        profileDirectory: directory,
        playerRoszPath: playerPath,
        playerName: "Player",
        opponentRoszPath: opponentPath,
        opponentName: "Opponent",
        phases: ["shooting"],
        metrics: ["mean-damage"],
        frozenScenarioContract: [
          {
            phase: "shooting",
            direction: "player-to-opponent",
            metric: "mean-damage",
            settings: { provider: "local-engine", phase: "shooting", unsupportedToggle: "true" },
            iterations: 1,
          },
          {
            phase: "shooting",
            direction: "opponent-to-player",
            metric: "mean-damage",
            settings: { provider: "local-engine", phase: "shooting", unsupportedToggle: "true" },
            iterations: 1,
          },
        ],
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "TESSERA_LOCAL_SETTING_UNSUPPORTED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
