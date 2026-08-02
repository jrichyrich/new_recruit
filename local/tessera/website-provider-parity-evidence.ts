import { createHash } from "node:crypto";

import type {
  TesseraImportedArmySemanticSnapshot,
  TesseraImportedSemanticToggle,
  TesseraImportedSemanticValue,
  TesseraImportedUnitSemantic,
  TesseraImportedWeaponSemantic,
  TesseraUnitInstance,
  TesseraWebsiteProviderEvidence,
} from "../../lib/rosterpilot";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  normalizeTesseraProviderParityName,
  TESSERA_PROVIDER_PARITY_MODELED_MECHANICS,
  TESSERA_PROVIDER_PARITY_OMITTED_MECHANICS,
  tesseraProviderParityEffectId,
  tesseraProviderParityProfileId,
  validateTesseraProviderParityCombatSnapshot,
  validateTesseraProviderParityModelCapabilityEnvelope,
  type TesseraProviderParityCombatAttackProfile,
  type TesseraProviderParityCombatUnitSnapshot,
  type TesseraProviderParityModelCapabilityEnvelope,
  type TesseraProviderParityNormalizedCombatSnapshot,
} from "./provider-parity-evidence";
import {
  tesseraImportedArmySemanticEvidenceIncompleteReasons,
  tesseraImportedArmySemanticSnapshotSha256,
  tesseraSemanticCharacteristicValues,
  type TesseraSemanticCharacteristicName,
} from "./website-semantic-evidence";

const sha256Pattern = /^[0-9a-f]{64}$/;

export type TesseraWebsiteProviderParityEvidenceIssueCode =
  | "WEBSITE_DEPLOYMENT_EVIDENCE_INCOMPLETE"
  | "WEBSITE_IMPORT_EVIDENCE_INCOMPLETE"
  | "WEBSITE_IMPORT_DIGEST_MISMATCH"
  | "WEBSITE_UNIT_BINDING_MISSING"
  | "WEBSITE_UNIT_BINDING_AMBIGUOUS"
  | "WEBSITE_UNIT_CHARACTERISTIC_INVALID"
  | "WEBSITE_WEAPON_CHARACTERISTIC_INVALID"
  | "WEBSITE_EFFECT_STATE_CONFLICT"
  | "WEBSITE_CAPABILITY_IDENTITY_INVALID"
  | "WEBSITE_DERIVED_EVIDENCE_INVALID";

export type TesseraWebsiteProviderParityEvidenceIssue = {
  code: TesseraWebsiteProviderParityEvidenceIssueCode;
  path: string;
  message: string;
};

export type TesseraWebsiteProviderParityEvidenceOptions = {
  /** Canonical report instances bind names/occurrences to stable IDs/points. */
  units: TesseraUnitInstance[];
  /** Explicit outer-envelope identities; these are not guessed from Web UI. */
  rulesEdition: string;
  rulesPackageVersion: string;
  engineDataSchemaVersion: number;
  combatModelVersion: string;
};

export type TesseraWebsiteProviderParityEvidenceResult =
  | {
      ok: true;
      modelCapabilityEnvelope: TesseraProviderParityModelCapabilityEnvelope;
      combatSnapshot: TesseraProviderParityNormalizedCombatSnapshot;
      issues: [];
    }
  | {
      ok: false;
      modelCapabilityEnvelope: null;
      combatSnapshot: null;
      issues: TesseraWebsiteProviderParityEvidenceIssue[];
    };

function issue(
  code: TesseraWebsiteProviderParityEvidenceIssueCode,
  path: string,
  message: string,
): TesseraWebsiteProviderParityEvidenceIssue {
  return { code, path, message };
}

function normalizedName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function oneValue(
  values: readonly TesseraImportedSemanticValue[],
  name: TesseraSemanticCharacteristicName,
): string | null {
  const matches = tesseraSemanticCharacteristicValues(values, name);
  return matches.length === 1 ? matches[0] : null;
}

function integerValue(value: string | null): number | null {
  if (value === null) return null;
  const match = value.trim().match(/^([+-]?\d+)\+?$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function positiveIntegerValue(value: string | null): number | null {
  const parsed = integerValue(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nullableSaveValue(value: string | null): number | null | undefined {
  if (value === null) return undefined;
  if (/^(?:none|n\/a|not applicable|-|—)$/i.test(value.trim())) return null;
  const parsed = positiveIntegerValue(value);
  return parsed === null ? undefined : parsed;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))]
    .sort((left, right) => left.localeCompare(right));
}

function parsedKeywords(value: string | null): string[] | null {
  if (value === null) return null;
  if (/^(?:none|n\/a|not applicable|-|—)$/i.test(value.trim())) return [];
  return uniqueStrings(
    value
      .split(/[,;|]/)
      .map((keyword) => keyword.trim().toLocaleUpperCase()),
  );
}

function phaseForWeapon(
  weapon: TesseraImportedWeaponSemantic,
): "shooting" | "fight" | null {
  const explicit = oneValue(weapon.visibleCharacteristics, "phase");
  if (explicit) {
    const shooting = /\b(?:shooting|ranged)\b/i.test(explicit);
    const fight = /\b(?:fight|melee)\b/i.test(explicit);
    if (shooting !== fight) return shooting ? "shooting" : "fight";
    return null;
  }
  const hasBallisticSkill =
    oneValue(weapon.visibleCharacteristics, "ballisticSkill") !== null;
  const hasWeaponSkill =
    oneValue(weapon.visibleCharacteristics, "weaponSkill") !== null;
  if (hasBallisticSkill === hasWeaponSkill) return null;
  return hasBallisticSkill ? "shooting" : "fight";
}

function attackProfileName(
  weapon: TesseraImportedWeaponSemantic,
): string {
  return normalizeTesseraProviderParityName(
    weapon.profile
      ? `${weapon.name} — ${weapon.profile}`
      : weapon.name,
  );
}

function attackProfile(
  snapshot: TesseraImportedArmySemanticSnapshot,
  unit: TesseraImportedUnitSemantic,
  weapon: TesseraImportedWeaponSemantic,
  issues: TesseraWebsiteProviderParityEvidenceIssue[],
): TesseraProviderParityCombatAttackProfile | null {
  const path = `${snapshot.side}.${unit.name}[${unit.occurrence}].${weapon.name}[${weapon.occurrence}]`;
  const phase = phaseForWeapon(weapon);
  const attacks = oneValue(weapon.visibleCharacteristics, "attacks");
  const strength = positiveIntegerValue(
    oneValue(weapon.visibleCharacteristics, "strength"),
  );
  const armorPenetration = integerValue(
    oneValue(weapon.visibleCharacteristics, "armorPenetration"),
  );
  const damage = oneValue(weapon.visibleCharacteristics, "damage");
  const keywords = parsedKeywords(
    oneValue(weapon.visibleCharacteristics, "keywords"),
  );
  const skillValue =
    phase === "shooting"
      ? oneValue(weapon.visibleCharacteristics, "ballisticSkill") ??
        oneValue(weapon.visibleCharacteristics, "skill")
      : phase === "fight"
        ? oneValue(weapon.visibleCharacteristics, "weaponSkill") ??
          oneValue(weapon.visibleCharacteristics, "skill")
        : null;
  const parsedSkill = nullableSaveValue(skillValue);
  const torrent = keywords?.includes("TORRENT") ?? false;
  const skill = parsedSkill === undefined && torrent ? null : parsedSkill;
  if (
    phase === null ||
    weapon.count === null ||
    weapon.count <= 0 ||
    !attacks?.trim() ||
    strength === null ||
    armorPenetration === null ||
    !damage?.trim() ||
    keywords === null ||
    skill === undefined
  ) {
    issues.push(
      issue(
        "WEBSITE_WEAPON_CHARACTERISTIC_INVALID",
        path,
        "The active weapon does not expose one parseable phase, count, A, BS/WS (or TORRENT), S, AP, D, and keyword field.",
      ),
    );
    return null;
  }
  return {
    profileId: tesseraProviderParityProfileId({
      side: snapshot.side,
      unitName: unit.name,
      unitOccurrence: unit.occurrence,
      weaponName: weapon.name,
      profile: weapon.profile,
      weaponOccurrence: weapon.occurrence,
    }),
    name: attackProfileName(weapon),
    phase,
    equippedModelCount: weapon.count,
    attacks: attacks.trim(),
    skill,
    strength,
    armorPenetration,
    damage: damage.trim(),
    keywords,
  };
}

function effectStates(
  toggles: readonly TesseraImportedSemanticToggle[],
  effects: Map<string, { name: string; state: boolean }>,
  path: string,
  issues: TesseraWebsiteProviderParityEvidenceIssue[],
): void {
  for (const toggle of toggles) {
    if (toggle.state === null) continue;
    const key = normalizedName(toggle.name);
    const existing = effects.get(key);
    if (existing && existing.state !== toggle.state) {
      issues.push(
        issue(
          "WEBSITE_EFFECT_STATE_CONFLICT",
          path,
          `Visible effect ${toggle.name} has conflicting enabled and disabled states.`,
        ),
      );
      continue;
    }
    effects.set(key, { name: toggle.name.trim(), state: toggle.state });
  }
}

function semanticUnitBinding(
  snapshot: TesseraImportedArmySemanticSnapshot,
  semantic: TesseraImportedUnitSemantic,
  units: readonly TesseraUnitInstance[],
  issues: TesseraWebsiteProviderParityEvidenceIssue[],
): TesseraUnitInstance | null {
  const sameIdentity = units.filter(
    (candidate) =>
      candidate.side === snapshot.side &&
      normalizedName(candidate.name) === normalizedName(semantic.name) &&
      candidate.ordinal === semantic.occurrence &&
      candidate.modelCount === semantic.modelCount,
  );
  const path = `${snapshot.side}.${semantic.name}[${semantic.occurrence}]`;
  if (sameIdentity.length === 0) {
    issues.push(
      issue(
        "WEBSITE_UNIT_BINDING_MISSING",
        path,
        "No canonical report unit matches the visible side, name, occurrence, and model count.",
      ),
    );
    return null;
  }
  if (sameIdentity.length > 1) {
    issues.push(
      issue(
        "WEBSITE_UNIT_BINDING_AMBIGUOUS",
        path,
        "More than one canonical report unit matches this visible import unit.",
      ),
    );
    return null;
  }
  return sameIdentity[0];
}

function combatUnit(
  snapshot: TesseraImportedArmySemanticSnapshot,
  semantic: TesseraImportedUnitSemantic,
  canonicalUnit: TesseraUnitInstance,
  stateSha256: string,
  issues: TesseraWebsiteProviderParityEvidenceIssue[],
): TesseraProviderParityCombatUnitSnapshot | null {
  const path = `${snapshot.side}.${semantic.name}[${semantic.occurrence}]`;
  const toughness = positiveIntegerValue(
    oneValue(semantic.visibleCharacteristics, "toughness"),
  );
  const save = positiveIntegerValue(
    oneValue(semantic.visibleCharacteristics, "save"),
  );
  const woundsPerModel = positiveIntegerValue(
    oneValue(semantic.visibleCharacteristics, "wounds"),
  );
  const commonInvulnerableSave = nullableSaveValue(
    oneValue(semantic.visibleCharacteristics, "invulnerableSave"),
  );
  const shootingInvulnerableSave =
    commonInvulnerableSave !== undefined
      ? commonInvulnerableSave
      : nullableSaveValue(
          oneValue(
            semantic.visibleCharacteristics,
            "rangedInvulnerableSave",
          ),
        );
  const fightInvulnerableSave =
    commonInvulnerableSave !== undefined
      ? commonInvulnerableSave
      : nullableSaveValue(
          oneValue(
            semantic.visibleCharacteristics,
            "fightInvulnerableSave",
          ),
        );
  if (
    toughness === null ||
    save === null ||
    woundsPerModel === null ||
    shootingInvulnerableSave === undefined ||
    fightInvulnerableSave === undefined ||
    canonicalUnit.points === null ||
    !Number.isFinite(canonicalUnit.points) ||
    canonicalUnit.points < 0
  ) {
    issues.push(
      issue(
        "WEBSITE_UNIT_CHARACTERISTIC_INVALID",
        path,
        "The unit does not expose one parseable T, save, wounds, explicit invulnerable-save value/omission, and canonical points binding.",
      ),
    );
    return null;
  }
  const activeWeapons = semantic.weapons.filter(
    (weapon) => (weapon.count ?? 0) > 0,
  );
  const attackProfiles = activeWeapons
    .map((weapon) =>
      attackProfile(
        snapshot,
        semantic,
        weapon,
        issues,
      ),
    )
    .filter(
      (profile): profile is TesseraProviderParityCombatAttackProfile =>
        profile !== null,
    );
  if (
    activeWeapons.length === 0 ||
    attackProfiles.length !== activeWeapons.length
  ) {
    if (activeWeapons.length === 0) {
      issues.push(
        issue(
          "WEBSITE_WEAPON_CHARACTERISTIC_INVALID",
          `${path}.weapons`,
          "The visible import unit has no active weapon profile; parity evidence cannot invent one.",
        ),
      );
    }
    return null;
  }

  const effects = new Map<string, { name: string; state: boolean }>();
  effectStates(semantic.effectToggles, effects, path, issues);
  for (const weapon of activeWeapons) {
    effectStates(
      weapon.effectToggles,
      effects,
      `${path}.${weapon.name}[${weapon.occurrence}]`,
      issues,
    );
  }
  const modeledEffects = uniqueStrings(
    [...effects.values()]
      .filter((effect) => effect.state)
      .map((effect) => tesseraProviderParityEffectId(effect.name)),
  );
  const omittedEffects = uniqueStrings(
    [...effects.values()]
      .filter((effect) => !effect.state)
      .map((effect) => tesseraProviderParityEffectId(effect.name)),
  );
  const snapshotSha256 = tesseraImportedArmySemanticSnapshotSha256(snapshot);
  return {
    instanceId: canonicalUnit.instanceId,
    side: snapshot.side,
    normalizedName: normalizeTesseraProviderParityName(canonicalUnit.name),
    modelCount: semantic.modelCount as number,
    points: canonicalUnit.points,
    defense: {
      toughness,
      save,
      woundsPerModel,
      invulnerableSave: {
        shooting: shootingInvulnerableSave,
        fight: fightInvulnerableSave,
      },
    },
    attackProfiles,
    modeledEffects,
    omittedEffects,
    evidence: {
      status: "complete",
      sourceRefs: [
        `tessera-web:semantic:${snapshotSha256}`,
        `tessera-web:state:${stateSha256}`,
      ],
      warningCodes: uniqueStrings(snapshot.warningCodes),
    },
  };
}

/**
 * Convert only retained, visible Tessera Web semantics into parity evidence.
 * Missing characteristics, effects, state binding, identities, or unit maps
 * fail closed; no roster or datasheet values are substituted.
 */
export function deriveTesseraWebsiteProviderParityEvidence(
  evidence: TesseraWebsiteProviderEvidence,
  options: TesseraWebsiteProviderParityEvidenceOptions,
): TesseraWebsiteProviderParityEvidenceResult {
  const issues: TesseraWebsiteProviderParityEvidenceIssue[] = [];
  if (
    !evidence.deployment.complete ||
    !sha256Pattern.test(evidence.deployment.identitySha256 ?? "")
  ) {
    issues.push(
      issue(
        "WEBSITE_DEPLOYMENT_EVIDENCE_INCOMPLETE",
        "deployment",
        "A content-addressed Tessera Web deployment identity is required.",
      ),
    );
  }
  for (const [field, value] of [
    ["rulesEdition", options.rulesEdition],
    ["rulesPackageVersion", options.rulesPackageVersion],
    ["combatModelVersion", options.combatModelVersion],
  ] as const) {
    if (!value.trim()) {
      issues.push(
        issue(
          "WEBSITE_CAPABILITY_IDENTITY_INVALID",
          field,
          `${field} must be supplied by the outer compatibility contract.`,
        ),
      );
    }
  }
  if (
    !Number.isSafeInteger(options.engineDataSchemaVersion) ||
    options.engineDataSchemaVersion <= 0
  ) {
    issues.push(
      issue(
        "WEBSITE_CAPABILITY_IDENTITY_INVALID",
        "engineDataSchemaVersion",
        "A positive engine data schema version is required.",
      ),
    );
  }

  const snapshots = [
    {
      side: "player" as const,
      snapshot: evidence.importSemantics.playerSnapshot,
      expectedSha256: evidence.importSemantics.playerSha256,
      binding: evidence.importSemantics.stateBindings?.player,
    },
    {
      side: "opponent" as const,
      snapshot: evidence.importSemantics.opponentSnapshot,
      expectedSha256: evidence.importSemantics.opponentSha256,
      binding: evidence.importSemantics.stateBindings?.opponent,
    },
  ];
  for (const entry of snapshots) {
    if (!entry.snapshot) {
      issues.push(
        issue(
          "WEBSITE_IMPORT_EVIDENCE_INCOMPLETE",
          `importSemantics.${entry.side}`,
          "The retained imported-army semantic snapshot is missing.",
        ),
      );
      continue;
    }
    const reasons = tesseraImportedArmySemanticEvidenceIncompleteReasons(
      entry.snapshot,
      entry.binding,
    );
    if (
      entry.snapshot.completeness !== "complete" ||
      reasons.length > 0
    ) {
      issues.push(
        issue(
          "WEBSITE_IMPORT_EVIDENCE_INCOMPLETE",
          `importSemantics.${entry.side}`,
          `The visible semantic/state evidence is incomplete: ${reasons.join(", ") || entry.snapshot.incompleteReasons.join(", ") || "snapshot marked partial"}.`,
        ),
      );
    }
    const actualSha256 =
      tesseraImportedArmySemanticSnapshotSha256(entry.snapshot);
    if (
      entry.expectedSha256 !== actualSha256 ||
      entry.binding?.snapshotSha256 !== actualSha256
    ) {
      issues.push(
        issue(
          "WEBSITE_IMPORT_DIGEST_MISMATCH",
          `importSemantics.${entry.side}`,
          "The retained semantic snapshot does not match its import/state digest.",
        ),
      );
    }
  }
  const playerSha256 = snapshots[0].snapshot
    ? tesseraImportedArmySemanticSnapshotSha256(snapshots[0].snapshot)
    : null;
  const opponentSha256 = snapshots[1].snapshot
    ? tesseraImportedArmySemanticSnapshotSha256(snapshots[1].snapshot)
    : null;
  const combinedSha256 =
    playerSha256 && opponentSha256
      ? createHash("sha256")
          .update(canonicalJson({ playerSha256, opponentSha256 }))
          .digest("hex")
      : null;
  if (
    !evidence.importSemantics.complete ||
    evidence.importSemantics.unresolvedEffectCount !== 0 ||
    evidence.importSemantics.combinedSha256 !== combinedSha256
  ) {
    issues.push(
      issue(
        "WEBSITE_IMPORT_EVIDENCE_INCOMPLETE",
        "importSemantics",
        "The combined Web import evidence is partial, unresolved, or does not match its component snapshots.",
      ),
    );
  }
  if (issues.length > 0) {
    return {
      ok: false,
      modelCapabilityEnvelope: null,
      combatSnapshot: null,
      issues,
    };
  }

  const combatUnits: TesseraProviderParityCombatUnitSnapshot[] = [];
  const boundInstanceIds = new Set<string>();
  for (const entry of snapshots) {
    const snapshot = entry.snapshot as TesseraImportedArmySemanticSnapshot;
    const stateSha256 = entry.binding?.stateSha256 as string;
    for (const semantic of snapshot.units.filter((unit) => unit.included)) {
      const canonicalUnit = semanticUnitBinding(
        snapshot,
        semantic,
        options.units,
        issues,
      );
      if (!canonicalUnit) continue;
      if (boundInstanceIds.has(canonicalUnit.instanceId)) {
        issues.push(
          issue(
            "WEBSITE_UNIT_BINDING_AMBIGUOUS",
            canonicalUnit.instanceId,
            "One canonical unit instance was bound to more than one Web semantic unit.",
          ),
        );
        continue;
      }
      boundInstanceIds.add(canonicalUnit.instanceId);
      const converted = combatUnit(
        snapshot,
        semantic,
        canonicalUnit,
        stateSha256,
        issues,
      );
      if (converted) combatUnits.push(converted);
    }
  }
  for (const unit of options.units) {
    if (!boundInstanceIds.has(unit.instanceId)) {
      issues.push(
        issue(
          "WEBSITE_UNIT_BINDING_MISSING",
          unit.instanceId,
          "A canonical report unit has no included Web import semantic binding.",
        ),
      );
    }
  }

  const modelCapabilityEnvelope: TesseraProviderParityModelCapabilityEnvelope = {
    schemaVersion: 1,
    rulesEdition: options.rulesEdition.trim(),
    rulesPackageVersion: options.rulesPackageVersion.trim(),
    engineDataSchemaVersion: options.engineDataSchemaVersion,
    combatModelVersion: options.combatModelVersion.trim(),
    modeledMechanics: [...TESSERA_PROVIDER_PARITY_MODELED_MECHANICS],
    omittedMechanics: [...TESSERA_PROVIDER_PARITY_OMITTED_MECHANICS],
  };
  const combatSnapshot: TesseraProviderParityNormalizedCombatSnapshot = {
    schemaVersion: 1,
    kind: "tessera-provider-neutral-combat-snapshot",
    units: combatUnits.sort((left, right) =>
      left.instanceId.localeCompare(right.instanceId),
    ),
  };
  for (const problem of validateTesseraProviderParityModelCapabilityEnvelope(
    modelCapabilityEnvelope,
  )) {
    issues.push(
      issue(
        "WEBSITE_DERIVED_EVIDENCE_INVALID",
        `modelCapabilityEnvelope.${problem.path}`,
        problem.message,
      ),
    );
  }
  for (const problem of validateTesseraProviderParityCombatSnapshot(
    combatSnapshot,
  )) {
    issues.push(
      issue(
        "WEBSITE_DERIVED_EVIDENCE_INVALID",
        `combatSnapshot.${problem.path}`,
        problem.message,
      ),
    );
  }
  if (issues.length > 0) {
    return {
      ok: false,
      modelCapabilityEnvelope: null,
      combatSnapshot: null,
      issues,
    };
  }
  return {
    ok: true,
    modelCapabilityEnvelope,
    combatSnapshot,
    issues: [],
  };
}
