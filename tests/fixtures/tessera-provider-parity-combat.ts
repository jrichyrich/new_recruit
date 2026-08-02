import type {
  TesseraProviderParityModelCapabilityEnvelope,
  TesseraProviderParityNormalizedCombatSnapshot,
} from "../../local/tessera/provider-parity";

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
            profileId: "witchseeker-flamer",
            name: "Witchseeker flamer",
            phase: "shooting",
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
            profileId: "troupe-shuriken-pistol",
            name: "Shuriken pistol",
            phase: "shooting",
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
            profileId: "farseer-eldritch-storm",
            name: "Eldritch Storm",
            phase: "shooting",
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
            profileId: "shroud-runner-scatter-laser",
            name: "Scatter laser",
            phase: "shooting",
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
