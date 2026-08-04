import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraImportedArmySemanticSnapshot,
  TesseraImportedSemanticToggle,
  TesseraUnitInstance,
  TesseraWebsiteProviderEvidence,
} from "../lib/rosterpilot";
import {
  tesseraImportSemanticEvidenceFromSnapshots,
} from "../local/tessera/browser";
import {
  createTesseraImportedArmySimulationStateBinding,
  tesseraImportedArmySemanticSnapshotIncompleteReasons,
  tesseraSemanticWeaponRangeInches,
} from "../local/tessera/website-semantic-evidence";
import {
  deriveTesseraWebsiteProviderParityEvidence,
} from "../local/tessera/website-provider-parity-evidence";
import {
  tesseraProviderParityProfileId,
} from "../local/tessera/provider-parity-evidence";

type UnitFixture = {
  name: string;
  models: number;
  toughness: number;
  save: number;
  wounds: number;
  invulnerable: number | null;
  weapon: {
    name: string;
    range: number;
    attacks: string;
    skill: string;
    strength: number;
    ap: number;
    damage: string;
    keywords: string;
    toggles?: TesseraImportedSemanticToggle[];
  };
};

const namedUnits: Record<string, UnitFixture> = {
  Witchseekers: {
    name: "Witchseekers",
    models: 5,
    toughness: 3,
    save: 3,
    wounds: 1,
    invulnerable: 5,
    weapon: {
      name: "Witchseeker flamer",
      range: 12,
      attacks: "D6",
      skill: "none",
      strength: 4,
      ap: 0,
      damage: "1",
      keywords: "IGNORES COVER, TORRENT",
      toggles: [
        { name: "torrent-auto-hit", state: true },
        { name: "battle-shock-trigger", state: false },
      ],
    },
  },
  Troupe: {
    name: "Troupe",
    models: 5,
    toughness: 3,
    save: 6,
    wounds: 1,
    invulnerable: 4,
    weapon: {
      name: "Shuriken pistol",
      range: 12,
      attacks: "1",
      skill: "3+",
      strength: 4,
      ap: -1,
      damage: "1",
      keywords: "PISTOL",
    },
  },
  Farseer: {
    name: "Farseer",
    models: 1,
    toughness: 3,
    save: 6,
    wounds: 4,
    invulnerable: 4,
    weapon: {
      name: "Eldritch Storm",
      range: 24,
      attacks: "D6",
      skill: "2+",
      strength: 6,
      ap: -2,
      damage: "D3",
      keywords: "BLAST, PSYCHIC",
      toggles: [{ name: "psychic-weapon", state: true }],
    },
  },
  "Shroud Runners": {
    name: "Shroud Runners",
    models: 3,
    toughness: 4,
    save: 4,
    wounds: 3,
    invulnerable: null,
    weapon: {
      name: "Scatter laser",
      range: 36,
      attacks: "6",
      skill: "3+",
      strength: 5,
      ap: 0,
      damage: "1",
      keywords: "none",
      toggles: [{ name: "mounted-platform", state: true }],
    },
  },
};

function snapshot(
  side: "player" | "opponent",
  fixtures: UnitFixture[],
): TesseraImportedArmySemanticSnapshot {
  return {
    schemaVersion: 1,
    side,
    armyName: side === "player" ? "Custodes" : "Aeldari",
    reportedUnitCount: fixtures.length,
    units: fixtures.map((fixture) => ({
      occurrence: 1,
      name: fixture.name,
      modelCount: fixture.models,
      included: true,
      weapons: [{
        occurrence: 1,
        name: fixture.weapon.name,
        profile: null,
        count: fixture.models,
        visibleCharacteristics: [
          { name: "phase", value: "shooting" },
          { name: "range", value: `${fixture.weapon.range}\"` },
          { name: "attacks", value: fixture.weapon.attacks },
          { name: "ballistic skill", value: fixture.weapon.skill },
          { name: "strength", value: String(fixture.weapon.strength) },
          { name: "AP", value: String(fixture.weapon.ap) },
          { name: "damage", value: fixture.weapon.damage },
          { name: "keywords", value: fixture.weapon.keywords },
          ...(!fixture.weapon.toggles
            ? [{ name: "effects", value: "none" }]
            : []),
        ],
        effectToggles: fixture.weapon.toggles ?? [],
      }],
      visibleCharacteristics: [
        { name: "toughness", value: String(fixture.toughness) },
        { name: "save", value: `${fixture.save}+` },
        { name: "wounds", value: String(fixture.wounds) },
        {
          name: "invulnerable save",
          value:
            fixture.invulnerable === null
              ? "none"
              : `${fixture.invulnerable}+`,
        },
        { name: "effects", value: "none" },
      ],
      effectToggles: [],
    })),
    warningCodes: [],
    alternateProfileResolutions: [],
    completeness: "complete",
    incompleteReasons: [],
  };
}

function binding(snapshot: TesseraImportedArmySemanticSnapshot) {
  const savedListName = `RP-${snapshot.side}-fixture`;
  return createTesseraImportedArmySimulationStateBinding(snapshot, {
    side: snapshot.side,
    savedListName,
    selectedUnitCount: snapshot.reportedUnitCount ?? 0,
    selectorValue: `list:${savedListName}`,
    selectorLabel: `${savedListName} · ${snapshot.reportedUnitCount} units`,
  });
}

function completeEvidence(): {
  evidence: TesseraWebsiteProviderEvidence;
  units: TesseraUnitInstance[];
} {
  const player = snapshot("player", [namedUnits.Witchseekers]);
  const opponent = snapshot("opponent", [
    namedUnits.Troupe,
    namedUnits.Farseer,
    namedUnits["Shroud Runners"],
  ]);
  assert.deepEqual(
    tesseraImportedArmySemanticSnapshotIncompleteReasons(player),
    [],
  );
  assert.deepEqual(
    tesseraImportedArmySemanticSnapshotIncompleteReasons(opponent),
    [],
  );
  const importSemantics = tesseraImportSemanticEvidenceFromSnapshots(
    player,
    opponent,
    { player: binding(player), opponent: binding(opponent) },
  );
  const pointMap = new Map([
    ["Witchseekers", 50],
    ["Troupe", 75],
    ["Farseer", 80],
    ["Shroud Runners", 80],
  ]);
  const units = [player, opponent].flatMap((army) =>
    army.units.map((unit) => ({
      instanceId: `${army.side}-${unit.name.toLocaleLowerCase().replace(/\s+/g, "-")}-1`,
      selectionId: null,
      side: army.side,
      name: unit.name,
      label: unit.name,
      ordinal: unit.occurrence,
      modelCount: unit.modelCount as number,
      points: pointMap.get(unit.name) ?? null,
      tags: [],
    })),
  );
  return {
    evidence: {
      schemaVersion: 1,
      deployment: {
        identitySha256: "d".repeat(64),
        declaredVersion: null,
        assets: [{
          url: "https://playtessera.gg/assets/app.js",
          sameOrigin: true,
          sha256: "a".repeat(64),
          byteLength: 100,
        }],
        complete: true,
        completeness: "complete",
        declarationSha256: "e".repeat(64),
        incompleteReasons: [],
      },
      importSemantics,
    },
    units,
  };
}

test("visible Web range values normalize to exact phase-appropriate inches", () => {
  const ranged = structuredClone(
    snapshot("player", [namedUnits.Witchseekers]).units[0].weapons[0],
  );
  assert.equal(tesseraSemanticWeaponRangeInches(ranged), 12);

  const melee = structuredClone(ranged);
  melee.visibleCharacteristics = melee.visibleCharacteristics
    .filter((entry) =>
      !["phase", "range", "ballistic skill"].includes(entry.name),
    )
    .concat([
      { name: "phase", value: "fight" },
      { name: "range", value: "Melee" },
      { name: "weapon skill", value: "2+" },
    ]);
  assert.equal(tesseraSemanticWeaponRangeInches(melee), null);

  ranged.visibleCharacteristics.push({ name: "weapon range", value: "18\"" });
  assert.equal(tesseraSemanticWeaponRangeInches(ranged), undefined);
});

test("Web semantic derivation produces neutral named-unit combat evidence without hidden effects", () => {
  const fixture = completeEvidence();
  const result = deriveTesseraWebsiteProviderParityEvidence(
    fixture.evidence,
    {
      units: fixture.units,
      rulesEdition: "warhammer-40000-11e",
      rulesPackageVersion: "matched-play-fixture-v1",
      engineDataSchemaVersion: 1,
      combatModelVersion: "base-profile-monte-carlo-v1",
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.combatSnapshot.units.map((unit) => unit.normalizedName).sort(),
    ["Farseer", "Shroud Runners", "Troupe", "Witchseekers"],
  );
  const witchseekers = result.combatSnapshot.units.find(
    (unit) => unit.normalizedName === "Witchseekers",
  );
  assert.deepEqual(witchseekers?.modeledEffects, ["torrent-auto-hit"]);
  assert.deepEqual(witchseekers?.omittedEffects, ["battle-shock-trigger"]);
  assert.equal(witchseekers?.attackProfiles[0]?.rangeInches, 12);
  assert.equal(
    witchseekers?.attackProfiles[0]?.profileId,
    tesseraProviderParityProfileId({
      side: "player",
      unitName: "Witchseekers",
      unitOccurrence: 1,
      weaponName: "Witchseeker flamer",
      profile: null,
      weaponOccurrence: 1,
    }),
  );
  assert.deepEqual(
    result.combatSnapshot.units.find(
      (unit) => unit.normalizedName === "Troupe",
    )?.modeledEffects,
    [],
  );
  assert.ok(
    result.combatSnapshot.units.every((unit) =>
      unit.evidence.sourceRefs.some((ref) =>
        ref.startsWith("tessera-web:state:"),
      ),
    ),
  );
});

test("a ranged Web profile without one exact visible range fails closed", () => {
  const fixture = completeEvidence();
  const player = structuredClone(
    fixture.evidence.importSemantics.playerSnapshot,
  ) as TesseraImportedArmySemanticSnapshot;
  const opponent = structuredClone(
    fixture.evidence.importSemantics.opponentSnapshot,
  ) as TesseraImportedArmySemanticSnapshot;
  player.units[0].weapons[0].visibleCharacteristics =
    player.units[0].weapons[0].visibleCharacteristics.filter(
      (entry) => entry.name !== "range",
    );
  const importSemantics = tesseraImportSemanticEvidenceFromSnapshots(
    player,
    opponent,
    { player: binding(player), opponent: binding(opponent) },
  );
  assert.equal(importSemantics.complete, false);
  assert.ok(
    importSemantics.incompleteReasons.some((reason) =>
      reason.includes("range-not-visible-or-invalid"),
    ),
  );
  const result = deriveTesseraWebsiteProviderParityEvidence(
    {
      ...fixture.evidence,
      importSemantics,
    },
    {
      units: fixture.units,
      rulesEdition: "warhammer-40000-11e",
      rulesPackageVersion: "matched-play-fixture-v1",
      engineDataSchemaVersion: 1,
      combatModelVersion: "base-profile-monte-carlo-v1",
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.issues.some(
      (entry) =>
        entry.code === "WEBSITE_IMPORT_EVIDENCE_INCOMPLETE" &&
        entry.message.includes("range-not-visible-or-invalid"),
    ),
  );
});

test("a claimed-complete snapshot with zero weapons fails closed", () => {
  const fixture = completeEvidence();
  const player = structuredClone(
    fixture.evidence.importSemantics.playerSnapshot,
  ) as TesseraImportedArmySemanticSnapshot;
  const opponent = structuredClone(
    fixture.evidence.importSemantics.opponentSnapshot,
  ) as TesseraImportedArmySemanticSnapshot;
  player.units[0].weapons = [];
  player.completeness = "complete";
  player.incompleteReasons = [];
  const semantics = tesseraImportSemanticEvidenceFromSnapshots(
    player,
    opponent,
    { player: binding(player), opponent: binding(opponent) },
  );
  assert.equal(semantics.complete, false);
  assert.ok(
    semantics.incompleteReasons.some((reason) =>
      reason.includes("weapons-not-visible"),
    ),
  );
});

test("zero effect controls without an explicit visible omission fail closed", () => {
  const fixture = completeEvidence();
  const player = structuredClone(
    fixture.evidence.importSemantics.playerSnapshot,
  ) as TesseraImportedArmySemanticSnapshot;
  const opponent = structuredClone(
    fixture.evidence.importSemantics.opponentSnapshot,
  ) as TesseraImportedArmySemanticSnapshot;
  player.units[0].effectToggles = [];
  player.units[0].visibleCharacteristics =
    player.units[0].visibleCharacteristics.filter(
      (entry) => entry.name !== "effects",
    );
  player.units[0].weapons[0].effectToggles = [];
  player.units[0].weapons[0].visibleCharacteristics =
    player.units[0].weapons[0].visibleCharacteristics.filter(
      (entry) => entry.name !== "effects",
    );
  const semantics = tesseraImportSemanticEvidenceFromSnapshots(
    player,
    opponent,
    { player: binding(player), opponent: binding(opponent) },
  );
  assert.equal(semantics.complete, false);
  assert.ok(
    semantics.incompleteReasons.filter((reason) =>
      reason.includes("effect-state-or-explicit-omission-not-visible"),
    ).length >= 2,
  );
});

test("semantic snapshots without live selected-list bindings cannot be complete", () => {
  const fixture = completeEvidence();
  const semantics = tesseraImportSemanticEvidenceFromSnapshots(
    fixture.evidence.importSemantics.playerSnapshot,
    fixture.evidence.importSemantics.opponentSnapshot,
  );
  assert.equal(semantics.complete, false);
  assert.ok(
    semantics.incompleteReasons.includes(
      "player:simulation-state-binding-missing",
    ),
  );
});

test("a selected-list binding copied to a different visible selector state is rejected", () => {
  const fixture = completeEvidence();
  const player = fixture.evidence.importSemantics
    .playerSnapshot as TesseraImportedArmySemanticSnapshot;
  const opponent = fixture.evidence.importSemantics
    .opponentSnapshot as TesseraImportedArmySemanticSnapshot;
  const copied = structuredClone(
    fixture.evidence.importSemantics.stateBindings?.player,
  );
  assert.ok(copied);
  copied.savedListName = "RP-player-different-list";
  const semantics = tesseraImportSemanticEvidenceFromSnapshots(
    player,
    opponent,
    {
      player: copied,
      opponent: fixture.evidence.importSemantics.stateBindings?.opponent ?? null,
    },
  );
  assert.equal(semantics.complete, false);
  assert.ok(
    semantics.incompleteReasons.some((reason) =>
      /selector-value-does-not-bind|state-binding-integrity-mismatch/.test(
        reason,
      ),
    ),
  );
});
