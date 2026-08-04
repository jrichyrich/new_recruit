import crypto from "node:crypto";

import type { TesseraPhase } from "../../lib/rosterpilot/types";

export const TESSERA_PROVIDER_PARITY_MODEL_CAPABILITY_SCHEMA_VERSION = 1;
export const TESSERA_PROVIDER_PARITY_COMBAT_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Provider-neutral declaration of the combat semantics a provider modeled.
 * This is intentionally narrower than the outer provider compatibility
 * envelope retained by certification and report artifacts.
 */
export type TesseraProviderParityModelCapabilityEnvelope = {
  schemaVersion: 1;
  rulesEdition: string;
  rulesPackageVersion: string;
  engineDataSchemaVersion: number;
  combatModelVersion: string;
  modeledMechanics: string[];
  omittedMechanics: string[];
};

export type TesseraProviderParityCombatDefense = {
  toughness: number;
  save: number;
  woundsPerModel: number;
  invulnerableSave: {
    shooting: number | null;
    fight: number | null;
  };
};

export type TesseraProviderParityCombatAttackProfile = {
  /**
   * Stable provider-neutral identity derived from side, unit occurrence,
   * visible weapon/profile names, and weapon occurrence. Provider-native
   * record IDs remain provider-specific evidence and are not compared.
   */
  profileId: string;
  name: string;
  phase: TesseraPhase;
  /** Exact profile range for shooting; null for fight profiles. */
  rangeInches: number | null;
  equippedModelCount: number;
  attacks: string;
  skill: number | null;
  strength: number;
  armorPenetration: number;
  damage: string;
  keywords: string[];
};

export type TesseraProviderParitySemanticEvidence = {
  status: "complete" | "incomplete";
  /** Provider-specific evidence references are retained but not cross-compared. */
  sourceRefs: string[];
  warningCodes: string[];
};

export type TesseraProviderParityCombatUnitSnapshot = {
  instanceId: string;
  side: "player" | "opponent";
  normalizedName: string;
  modelCount: number;
  points: number;
  defense: TesseraProviderParityCombatDefense;
  attackProfiles: TesseraProviderParityCombatAttackProfile[];
  modeledEffects: string[];
  omittedEffects: string[];
  evidence: TesseraProviderParitySemanticEvidence;
};

export type TesseraProviderParityNormalizedCombatSnapshot = {
  schemaVersion: 1;
  kind: "tessera-provider-neutral-combat-snapshot";
  units: TesseraProviderParityCombatUnitSnapshot[];
};

export type TesseraProviderParityCombatDiffClassification =
  | "identical"
  | "snapshot-missing"
  | "unit-missing"
  | "unit-identity-mismatch"
  | "defense-profile-mismatch"
  | "attack-profile-mismatch"
  | "modeled-effects-mismatch"
  | "semantic-evidence-incomplete";

export type TesseraProviderParityCombatDiff = {
  classification: TesseraProviderParityCombatDiffClassification;
  unitInstanceId: string | null;
  paths: string[];
  localValue: unknown;
  websiteValue: unknown;
};

export type TesseraProviderParityCombatSnapshotComparison = {
  status: "match" | "mismatch" | "incomplete";
  diffs: TesseraProviderParityCombatDiff[];
};

export type TesseraProviderParityEvidenceProblem = {
  path: string;
  message: string;
};

/** Provider-neutral text normalization shared by local and Web derivations. */
export function normalizeTesseraProviderParityName(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Stable effect identifier; providers must not compare display-name casing. */
export function tesseraProviderParityEffectId(value: string): string {
  return normalizeTesseraProviderParityName(value)
    .toLocaleLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const TESSERA_PROVIDER_PARITY_MODELED_MECHANICS = [
  "attack-profile",
  "defense-profile",
  "explicit-effect-state",
  "phase-direction",
  "semantic-weapon-profile-identity",
  "weapon-range",
  "weapon-keywords",
] as const;

export const TESSERA_PROVIDER_PARITY_OMITTED_MECHANICS = [] as const;

/** Semantic profile identity independent of either provider's internal IDs. */
export function tesseraProviderParityProfileId(input: {
  side: "player" | "opponent";
  unitName: string;
  unitOccurrence: number;
  weaponName: string;
  profile: string | null;
  weaponOccurrence: number;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        side: input.side,
        unitName: normalizeTesseraProviderParityName(input.unitName)
          .toLocaleLowerCase(),
        unitOccurrence: input.unitOccurrence,
        weaponName: normalizeTesseraProviderParityName(input.weaponName)
          .toLocaleLowerCase(),
        profile: input.profile
          ? normalizeTesseraProviderParityName(input.profile)
              .toLocaleLowerCase()
          : null,
        weaponOccurrence: input.weaponOccurrence,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

/** Stable attack-profile identity shared by local-input and Web converters. */
export function tesseraProviderParityAttackProfileId(input: {
  unitInstanceId: string;
  name: string;
  phase: TesseraPhase;
  occurrence: number;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        unitInstanceId: input.unitInstanceId,
        name: normalizeTesseraProviderParityName(input.name)
          .toLocaleLowerCase(),
        phase: input.phase,
        occurrence: input.occurrence,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function canonicalModelCapabilityEnvelope(
  envelope: TesseraProviderParityModelCapabilityEnvelope,
): Record<string, unknown> {
  return {
    schemaVersion: envelope.schemaVersion,
    rulesEdition: envelope.rulesEdition,
    rulesPackageVersion: envelope.rulesPackageVersion,
    engineDataSchemaVersion: envelope.engineDataSchemaVersion,
    combatModelVersion: envelope.combatModelVersion,
    modeledMechanics: canonicalStrings(envelope.modeledMechanics),
    omittedMechanics: canonicalStrings(envelope.omittedMechanics),
  };
}

export function tesseraProviderParityModelCapabilityEnvelopeSha256(
  envelope: TesseraProviderParityModelCapabilityEnvelope,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalModelCapabilityEnvelope(envelope)))
    .digest("hex");
}

export function compareTesseraProviderParityModelCapabilityEnvelopes(
  local: TesseraProviderParityModelCapabilityEnvelope,
  website: TesseraProviderParityModelCapabilityEnvelope,
): boolean {
  return (
    JSON.stringify(canonicalModelCapabilityEnvelope(local)) ===
    JSON.stringify(canonicalModelCapabilityEnvelope(website))
  );
}

function hasUniqueNonEmptyStrings(values: unknown): values is string[] {
  return (
    Array.isArray(values) &&
    values.every(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) &&
    new Set(values).size === values.length
  );
}

export function validateTesseraProviderParityModelCapabilityEnvelope(
  envelope: TesseraProviderParityModelCapabilityEnvelope,
): TesseraProviderParityEvidenceProblem[] {
  const problems: TesseraProviderParityEvidenceProblem[] = [];
  if (envelope.schemaVersion !== 1) {
    problems.push({
      path: "schemaVersion",
      message: "Model-capability schema version must be 1.",
    });
  }
  for (const field of [
    "rulesEdition",
    "rulesPackageVersion",
    "combatModelVersion",
  ] as const) {
    if (
      typeof envelope[field] !== "string" ||
      envelope[field].trim().length === 0
    ) {
      problems.push({
        path: field,
        message: `${field} must be a non-empty string.`,
      });
    }
  }
  if (
    !Number.isInteger(envelope.engineDataSchemaVersion) ||
    envelope.engineDataSchemaVersion <= 0
  ) {
    problems.push({
      path: "engineDataSchemaVersion",
      message: "engineDataSchemaVersion must be a positive integer.",
    });
  }
  const modeledMechanicsValid = hasUniqueNonEmptyStrings(
    envelope.modeledMechanics,
  );
  if (!modeledMechanicsValid) {
    problems.push({
      path: "modeledMechanics",
      message: "modeledMechanics must contain unique non-empty identifiers.",
    });
  }
  const omittedMechanicsValid = hasUniqueNonEmptyStrings(
    envelope.omittedMechanics,
  );
  if (!omittedMechanicsValid) {
    problems.push({
      path: "omittedMechanics",
      message: "omittedMechanics must contain unique non-empty identifiers.",
    });
  }
  const overlap =
    modeledMechanicsValid && omittedMechanicsValid
      ? envelope.modeledMechanics.filter((mechanic) =>
          envelope.omittedMechanics.includes(mechanic),
        )
      : [];
  if (overlap.length > 0) {
    problems.push({
      path: "modeledMechanics",
      message: `Mechanics cannot be both modeled and omitted: ${overlap.join(", ")}.`,
    });
  }
  return problems;
}

function canonicalAttackProfile(
  profile: TesseraProviderParityCombatAttackProfile,
): Record<string, unknown> {
  return {
    profileId: profile.profileId,
    name: profile.name,
    phase: profile.phase,
    rangeInches: profile.rangeInches,
    equippedModelCount: profile.equippedModelCount,
    attacks: profile.attacks,
    skill: profile.skill,
    strength: profile.strength,
    armorPenetration: profile.armorPenetration,
    damage: profile.damage,
    keywords: canonicalStrings(profile.keywords),
  };
}

function canonicalCombatUnit(
  unit: TesseraProviderParityCombatUnitSnapshot,
): Record<string, unknown> {
  return {
    instanceId: unit.instanceId,
    side: unit.side,
    normalizedName: unit.normalizedName,
    modelCount: unit.modelCount,
    points: unit.points,
    defense: {
      toughness: unit.defense.toughness,
      save: unit.defense.save,
      woundsPerModel: unit.defense.woundsPerModel,
      invulnerableSave: {
        shooting: unit.defense.invulnerableSave.shooting,
        fight: unit.defense.invulnerableSave.fight,
      },
    },
    attackProfiles: unit.attackProfiles
      .map(canonicalAttackProfile)
      .sort((left, right) =>
        String(left.profileId).localeCompare(String(right.profileId)),
      ),
    modeledEffects: canonicalStrings(unit.modeledEffects),
    omittedEffects: canonicalStrings(unit.omittedEffects),
    evidence: {
      status: unit.evidence.status,
      sourceRefs: canonicalStrings(unit.evidence.sourceRefs),
      warningCodes: canonicalStrings(unit.evidence.warningCodes),
    },
  };
}

function canonicalCombatSnapshot(
  snapshot: TesseraProviderParityNormalizedCombatSnapshot,
): Record<string, unknown> {
  return {
    schemaVersion: snapshot.schemaVersion,
    kind: snapshot.kind,
    units: snapshot.units
      .map(canonicalCombatUnit)
      .sort((left, right) =>
        String(left.instanceId).localeCompare(String(right.instanceId)),
      ),
  };
}

export function tesseraProviderParityCombatSnapshotSha256(
  snapshot: TesseraProviderParityNormalizedCombatSnapshot,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalCombatSnapshot(snapshot)))
    .digest("hex");
}

function isNullablePositiveInteger(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && Number(value) > 0);
}

function validAttackProfile(
  profile: TesseraProviderParityCombatAttackProfile,
): boolean {
  return (
    typeof profile.profileId === "string" &&
    /^[0-9a-f]{24}$/.test(profile.profileId) &&
    typeof profile.name === "string" &&
    profile.name.trim().length > 0 &&
    (profile.phase === "shooting" || profile.phase === "fight") &&
    (
      (profile.phase === "shooting" &&
        Number.isSafeInteger(profile.rangeInches) &&
        Number(profile.rangeInches) > 0) ||
      (profile.phase === "fight" && profile.rangeInches === null)
    ) &&
    Number.isInteger(profile.equippedModelCount) &&
    profile.equippedModelCount > 0 &&
    typeof profile.attacks === "string" &&
    profile.attacks.trim().length > 0 &&
    isNullablePositiveInteger(profile.skill) &&
    Number.isFinite(profile.strength) &&
    profile.strength > 0 &&
    Number.isInteger(profile.armorPenetration) &&
    typeof profile.damage === "string" &&
    profile.damage.trim().length > 0 &&
    hasUniqueNonEmptyStrings(profile.keywords)
  );
}

export function validateTesseraProviderParityCombatSnapshot(
  snapshot: TesseraProviderParityNormalizedCombatSnapshot,
): TesseraProviderParityEvidenceProblem[] {
  const problems: TesseraProviderParityEvidenceProblem[] = [];
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.kind !== "tessera-provider-neutral-combat-snapshot" ||
    !Array.isArray(snapshot.units) ||
    snapshot.units.length === 0
  ) {
    problems.push({
      path: "snapshot",
      message: "Normalized combat snapshot header or unit collection is invalid.",
    });
    return problems;
  }

  const seenUnits = new Set<string>();
  for (const [unitIndex, unit] of snapshot.units.entries()) {
    const unitPath = `units[${unitIndex}]`;
    const identityValid =
      typeof unit.instanceId === "string" &&
      unit.instanceId.trim().length > 0 &&
      (unit.side === "player" || unit.side === "opponent") &&
      typeof unit.normalizedName === "string" &&
      unit.normalizedName.trim().length > 0 &&
      Number.isInteger(unit.modelCount) &&
      unit.modelCount > 0 &&
      Number.isFinite(unit.points) &&
      unit.points >= 0;
    if (!identityValid || seenUnits.has(unit.instanceId)) {
      problems.push({
        path: unitPath,
        message: "Combat unit identity is invalid or duplicated.",
      });
    }
    seenUnits.add(unit.instanceId);

    const defense = unit.defense;
    if (
      !defense ||
      !Number.isFinite(defense.toughness) ||
      defense.toughness <= 0 ||
      !Number.isInteger(defense.save) ||
      defense.save <= 0 ||
      !Number.isFinite(defense.woundsPerModel) ||
      defense.woundsPerModel <= 0 ||
      !isNullablePositiveInteger(defense.invulnerableSave?.shooting) ||
      !isNullablePositiveInteger(defense.invulnerableSave?.fight)
    ) {
      problems.push({
        path: `${unitPath}.defense`,
        message: "Combat defense profile is invalid.",
      });
    }

    if (
      !Array.isArray(unit.attackProfiles) ||
      unit.attackProfiles.some((profile) => !validAttackProfile(profile)) ||
      new Set(unit.attackProfiles.map((profile) => profile.profileId)).size !==
        unit.attackProfiles.length
    ) {
      problems.push({
        path: `${unitPath}.attackProfiles`,
        message: "Combat attack profiles are invalid or duplicated.",
      });
    }

    if (
      !hasUniqueNonEmptyStrings(unit.modeledEffects) ||
      !hasUniqueNonEmptyStrings(unit.omittedEffects) ||
      unit.modeledEffects.some((effect) => unit.omittedEffects.includes(effect))
    ) {
      problems.push({
        path: `${unitPath}.modeledEffects`,
        message: "Modeled and omitted effects are invalid or overlap.",
      });
    }

    if (
      unit.evidence?.status !== "complete" ||
      !hasUniqueNonEmptyStrings(unit.evidence.sourceRefs) ||
      unit.evidence.sourceRefs.length === 0 ||
      !hasUniqueNonEmptyStrings(unit.evidence.warningCodes)
    ) {
      problems.push({
        path: `${unitPath}.evidence`,
        message: "Semantic evidence is incomplete or invalid.",
      });
    }
  }
  return problems;
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalUnitParts(unit: TesseraProviderParityCombatUnitSnapshot) {
  const canonical = canonicalCombatUnit(unit);
  return {
    identity: {
      side: canonical.side,
      normalizedName: canonical.normalizedName,
      modelCount: canonical.modelCount,
      points: canonical.points,
    },
    defense: canonical.defense,
    attacks: canonical.attackProfiles,
    effects: {
      modeledEffects: canonical.modeledEffects,
      omittedEffects: canonical.omittedEffects,
    },
  };
}

export function compareTesseraProviderParityCombatSnapshots(
  local: TesseraProviderParityNormalizedCombatSnapshot | undefined,
  website: TesseraProviderParityNormalizedCombatSnapshot | undefined,
): TesseraProviderParityCombatSnapshotComparison {
  if (!local || !website) {
    return {
      status: "incomplete",
      diffs: [
        {
          classification: "snapshot-missing",
          unitInstanceId: null,
          paths: ["snapshot"],
          localValue: local ?? null,
          websiteValue: website ?? null,
        },
      ],
    };
  }

  const diffs: TesseraProviderParityCombatDiff[] = [];
  const localUnits = new Map(local.units.map((unit) => [unit.instanceId, unit]));
  const websiteUnits = new Map(
    website.units.map((unit) => [unit.instanceId, unit]),
  );
  const unitIds = Array.from(
    new Set([...localUnits.keys(), ...websiteUnits.keys()]),
  ).sort();

  for (const unitInstanceId of unitIds) {
    const localUnit = localUnits.get(unitInstanceId);
    const websiteUnit = websiteUnits.get(unitInstanceId);
    if (!localUnit || !websiteUnit) {
      diffs.push({
        classification: "unit-missing",
        unitInstanceId,
        paths: [`units.${unitInstanceId}`],
        localValue: localUnit ?? null,
        websiteValue: websiteUnit ?? null,
      });
      continue;
    }

    if (
      localUnit.evidence.status !== "complete" ||
      websiteUnit.evidence.status !== "complete" ||
      localUnit.evidence.sourceRefs.length === 0 ||
      websiteUnit.evidence.sourceRefs.length === 0
    ) {
      diffs.push({
        classification: "semantic-evidence-incomplete",
        unitInstanceId,
        paths: [`units.${unitInstanceId}.evidence`],
        localValue: localUnit.evidence,
        websiteValue: websiteUnit.evidence,
      });
    }

    const localParts = canonicalUnitParts(localUnit);
    const websiteParts = canonicalUnitParts(websiteUnit);
    for (const [classification, key] of [
      ["unit-identity-mismatch", "identity"],
      ["defense-profile-mismatch", "defense"],
      ["attack-profile-mismatch", "attacks"],
      ["modeled-effects-mismatch", "effects"],
    ] as const) {
      if (!equalCanonical(localParts[key], websiteParts[key])) {
        diffs.push({
          classification,
          unitInstanceId,
          paths: [`units.${unitInstanceId}.${key}`],
          localValue: localParts[key],
          websiteValue: websiteParts[key],
        });
      }
    }
  }

  if (diffs.length === 0) {
    return {
      status: "match",
      diffs: [
        {
          classification: "identical",
          unitInstanceId: null,
          paths: [],
          localValue: null,
          websiteValue: null,
        },
      ],
    };
  }
  return {
    status: diffs.some(
      (diff) => diff.classification === "semantic-evidence-incomplete",
    )
      ? "incomplete"
      : "mismatch",
    diffs,
  };
}
