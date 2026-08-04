import type {
  TesseraProviderParityModelCapabilityEnvelope,
  TesseraProviderParityNormalizedCombatSnapshot,
} from "../../local/tessera/provider-parity";
import {
  tesseraProviderParityProfileId,
} from "../../local/tessera/provider-parity-evidence";

function profileId(input: {
  side: "player" | "opponent";
  unitName: string;
  weaponName: string;
}): string {
  return tesseraProviderParityProfileId({
    ...input,
    unitOccurrence: 1,
    profile: null,
    weaponOccurrence: 1,
  });
}

export function providerParityModelCapabilityFixture(): TesseraProviderParityModelCapabilityEnvelope {
  return {
    schemaVersion: 1,
    rulesEdition: "warhammer-40000-11e",
    rulesPackageVersion: "matched-play-fixture-v1",
    engineDataSchemaVersion: 1,
    combatModelVersion: "base-profile-monte-carlo-v1",
    modeledMechanics: [
      "attack-profile",
      "defense-profile",
      "phase-direction",
      "semantic-weapon-profile-identity",
      "weapon-range",
      "weapon-keywords",
    ],
    omittedMechanics: ["battle-shock", "stratagems"],
  };
}

export function providerParityNamedCombatSnapshotFixture(): TesseraProviderParityNormalizedCombatSnapshot {
  return {
    schemaVersion: 1,
    kind: "tessera-provider-neutral-combat-snapshot",
    units: [
      {
        instanceId: "custodes-witchseekers-1",
        side: "player",
        normalizedName: "Witchseekers",
        modelCount: 5,
        points: 50,
        defense: {
          toughness: 3,
          save: 3,
          woundsPerModel: 1,
          invulnerableSave: { shooting: 5, fight: 5 },
        },
        attackProfiles: [
          {
            profileId: profileId({
              side: "player",
              unitName: "Witchseekers",
              weaponName: "Witchseeker flamer",
            }),
            name: "Witchseeker flamer",
            phase: "shooting",
            rangeInches: 12,
            equippedModelCount: 5,
            attacks: "D6",
            skill: null,
            strength: 4,
            armorPenetration: 0,
            damage: "1",
            keywords: ["IGNORES COVER", "TORRENT"],
          },
        ],
        modeledEffects: ["torrent-auto-hit"],
        omittedEffects: ["battle-shock-trigger"],
        evidence: {
          status: "complete",
          sourceRefs: ["fixture:custodes:witchseekers"],
          warningCodes: [],
        },
      },
      {
        instanceId: "aeldari-troupe-1",
        side: "opponent",
        normalizedName: "Troupe",
        modelCount: 5,
        points: 75,
        defense: {
          toughness: 3,
          save: 6,
          woundsPerModel: 1,
          invulnerableSave: { shooting: 4, fight: 4 },
        },
        attackProfiles: [
          {
            profileId: profileId({
              side: "opponent",
              unitName: "Troupe",
              weaponName: "Shuriken pistol",
            }),
            name: "Shuriken pistol",
            phase: "shooting",
            rangeInches: 12,
            equippedModelCount: 5,
            attacks: "1",
            skill: 3,
            strength: 4,
            armorPenetration: -1,
            damage: "1",
            keywords: ["PISTOL"],
          },
        ],
        modeledEffects: [],
        omittedEffects: ["fate-dice"],
        evidence: {
          status: "complete",
          sourceRefs: ["fixture:aeldari:troupe"],
          warningCodes: [],
        },
      },
      {
        instanceId: "aeldari-farseer-1",
        side: "opponent",
        normalizedName: "Farseer",
        modelCount: 1,
        points: 80,
        defense: {
          toughness: 3,
          save: 6,
          woundsPerModel: 4,
          invulnerableSave: { shooting: 4, fight: 4 },
        },
        attackProfiles: [
          {
            profileId: profileId({
              side: "opponent",
              unitName: "Farseer",
              weaponName: "Eldritch Storm",
            }),
            name: "Eldritch Storm",
            phase: "shooting",
            rangeInches: 24,
            equippedModelCount: 1,
            attacks: "D6",
            skill: 2,
            strength: 6,
            armorPenetration: -2,
            damage: "D3",
            keywords: ["BLAST", "PSYCHIC"],
          },
        ],
        modeledEffects: ["psychic-weapon"],
        omittedEffects: ["fate-dice"],
        evidence: {
          status: "complete",
          sourceRefs: ["fixture:aeldari:farseer"],
          warningCodes: [],
        },
      },
      {
        instanceId: "aeldari-shroud-runners-1",
        side: "opponent",
        normalizedName: "Shroud Runners",
        modelCount: 3,
        points: 80,
        defense: {
          toughness: 4,
          save: 4,
          woundsPerModel: 3,
          invulnerableSave: { shooting: null, fight: null },
        },
        attackProfiles: [
          {
            profileId: profileId({
              side: "opponent",
              unitName: "Shroud Runners",
              weaponName: "Scatter laser",
            }),
            name: "Scatter laser",
            phase: "shooting",
            rangeInches: 36,
            equippedModelCount: 3,
            attacks: "6",
            skill: 3,
            strength: 5,
            armorPenetration: 0,
            damage: "1",
            keywords: [],
          },
        ],
        modeledEffects: ["mounted-platform"],
        omittedEffects: ["fate-dice"],
        evidence: {
          status: "complete",
          sourceRefs: ["fixture:aeldari:shroud-runners"],
          warningCodes: [],
        },
      },
    ],
  };
}
