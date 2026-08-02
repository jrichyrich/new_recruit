import { createHash } from "node:crypto";

import type {
  TesseraImportedArmySemanticSnapshot,
  TesseraImportedArmySimulationStateBinding,
  TesseraImportedSemanticToggle,
  TesseraImportedSemanticValue,
  TesseraImportedUnitSemantic,
  TesseraImportedWeaponSemantic,
} from "../../lib/rosterpilot";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";

const sha256Pattern = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

export function tesseraImportedArmySemanticSnapshotSha256(
  snapshot: TesseraImportedArmySemanticSnapshot,
): string {
  return sha256(snapshot);
}

function semanticKey(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const characteristicAliases = {
  toughness: new Set(["t", "toughness"]),
  save: new Set(["sv", "save", "armour save", "armor save"]),
  wounds: new Set(["w", "wounds", "wounds per model"]),
  invulnerableSave: new Set([
    "inv",
    "invuln",
    "invulnerable",
    "invulnerable save",
  ]),
  rangedInvulnerableSave: new Set([
    "ranged inv",
    "ranged invuln",
    "ranged invulnerable save",
    "shooting inv",
    "shooting invuln",
    "shooting invulnerable save",
  ]),
  fightInvulnerableSave: new Set([
    "fight inv",
    "fight invuln",
    "fight invulnerable save",
    "melee inv",
    "melee invuln",
    "melee invulnerable save",
  ]),
  attacks: new Set(["a", "attacks"]),
  ballisticSkill: new Set(["bs", "ballistic skill"]),
  weaponSkill: new Set(["ws", "weapon skill"]),
  skill: new Set(["skill"]),
  strength: new Set(["s", "strength"]),
  armorPenetration: new Set([
    "ap",
    "armour penetration",
    "armor penetration",
  ]),
  damage: new Set(["d", "damage"]),
  phase: new Set(["phase", "type", "weapon type"]),
  keywords: new Set(["keyword", "keywords", "weapon keywords"]),
} as const;

export type TesseraSemanticCharacteristicName =
  keyof typeof characteristicAliases;

export function tesseraSemanticCharacteristicValues(
  values: readonly TesseraImportedSemanticValue[],
  characteristic: TesseraSemanticCharacteristicName,
): string[] {
  const aliases: ReadonlySet<string> = characteristicAliases[characteristic];
  return [
    ...new Set(
      values
        .filter((entry) => aliases.has(semanticKey(entry.name)))
        .map((entry) => entry.value.trim())
        .filter(Boolean),
    ),
  ];
}

function hasOneValue(
  values: readonly TesseraImportedSemanticValue[],
  characteristic: TesseraSemanticCharacteristicName,
): boolean {
  return tesseraSemanticCharacteristicValues(values, characteristic).length === 1;
}

function hasInvulnerableDisclosure(
  values: readonly TesseraImportedSemanticValue[],
): boolean {
  return (
    hasOneValue(values, "invulnerableSave") ||
    (
      hasOneValue(values, "rangedInvulnerableSave") &&
      hasOneValue(values, "fightInvulnerableSave")
    )
  );
}

function explicitEffectOmission(
  values: readonly TesseraImportedSemanticValue[],
): boolean {
  return values.some((entry) => {
    const name = semanticKey(entry.name);
    if (!/^(?:effects?|abilities?|effect toggles?)$/.test(name)) {
      return false;
    }
    return /^(?:none|no effects?|no abilities?|n\/a|not applicable|omitted|disabled|-|—)$/i.test(
      entry.value.trim(),
    );
  });
}

function hasResolvedEffectDisclosure(
  values: readonly TesseraImportedSemanticValue[],
  toggles: readonly TesseraImportedSemanticToggle[],
): boolean {
  return (
    (
      toggles.length > 0 &&
      toggles.every(
        (toggle) =>
          toggle.state !== null && semanticKey(toggle.name).length > 0,
      )
    ) ||
    explicitEffectOmission(values)
  );
}

function activeWeapons(
  unit: TesseraImportedUnitSemantic,
): TesseraImportedWeaponSemantic[] {
  return unit.weapons.filter((weapon) => (weapon.count ?? 0) > 0);
}

function weaponCharacteristicReasons(
  weapon: TesseraImportedWeaponSemantic,
  unitPath: string,
): string[] {
  const path = `${unitPath}:weapon:${semanticKey(weapon.name)}:${weapon.occurrence}`;
  const reasons: string[] = [];
  if (weapon.count === null) reasons.push(`${path}:count-not-visible`);
  for (const field of [
    "attacks",
    "strength",
    "armorPenetration",
    "damage",
    "keywords",
  ] as const) {
    if (!hasOneValue(weapon.visibleCharacteristics, field)) {
      reasons.push(`${path}:${field}-not-visible-once`);
    }
  }
  const phaseVisible = hasOneValue(weapon.visibleCharacteristics, "phase");
  const ballisticSkillVisible = hasOneValue(
    weapon.visibleCharacteristics,
    "ballisticSkill",
  );
  const weaponSkillVisible = hasOneValue(
    weapon.visibleCharacteristics,
    "weaponSkill",
  );
  const genericSkillVisible = hasOneValue(
    weapon.visibleCharacteristics,
    "skill",
  );
  if (
    !phaseVisible &&
    ballisticSkillVisible === weaponSkillVisible
  ) {
    reasons.push(`${path}:phase-not-visible-or-unambiguous`);
  }
  if (
    !ballisticSkillVisible &&
    !weaponSkillVisible &&
    !genericSkillVisible
  ) {
    const keywords = tesseraSemanticCharacteristicValues(
      weapon.visibleCharacteristics,
      "keywords",
    ).join(" ");
    if (!/\btorrent\b/i.test(keywords)) {
      reasons.push(`${path}:skill-not-visible`);
    }
  }
  if (
    !hasResolvedEffectDisclosure(
      weapon.visibleCharacteristics,
      weapon.effectToggles,
    )
  ) {
    reasons.push(`${path}:effect-state-or-explicit-omission-not-visible`);
  }
  return reasons;
}

/**
 * Validate only meaning visibly exposed by Tessera's import-review UI. This
 * deliberately does not infer characteristics or effects from roster data.
 */
export function tesseraImportedArmySemanticSnapshotIncompleteReasons(
  snapshot: TesseraImportedArmySemanticSnapshot,
): string[] {
  const reasons: string[] = [];
  if (snapshot.schemaVersion !== 1) reasons.push("unsupported-schema-version");
  if (
    snapshot.reportedUnitCount === null ||
    snapshot.reportedUnitCount <= 0
  ) {
    reasons.push("reported-unit-count-not-visible");
  }
  if (
    snapshot.reportedUnitCount !== null &&
    snapshot.units.length !== snapshot.reportedUnitCount
  ) {
    reasons.push(
      `semantic-unit-count:${snapshot.units.length}/${snapshot.reportedUnitCount}`,
    );
  }
  if (snapshot.units.length === 0) reasons.push("semantic-units-not-visible");

  for (const unit of snapshot.units) {
    const unitPath = `unit:${semanticKey(unit.name)}:${unit.occurrence}`;
    if (unit.included !== true) {
      reasons.push(`${unitPath}:included-state-not-true`);
    }
    if (unit.modelCount === null || unit.modelCount <= 0) {
      reasons.push(`${unitPath}:model-count-not-visible`);
    }
    for (const field of ["toughness", "save", "wounds"] as const) {
      if (!hasOneValue(unit.visibleCharacteristics, field)) {
        reasons.push(`${unitPath}:${field}-not-visible-once`);
      }
    }
    if (!hasInvulnerableDisclosure(unit.visibleCharacteristics)) {
      reasons.push(`${unitPath}:invulnerable-save-not-explicit`);
    }
    const equipped = activeWeapons(unit);
    if (unit.weapons.length === 0) {
      reasons.push(`${unitPath}:weapons-not-visible`);
    } else if (equipped.length === 0) {
      reasons.push(`${unitPath}:equipped-weapon-not-visible`);
    }
    for (const weapon of equipped) {
      reasons.push(...weaponCharacteristicReasons(weapon, unitPath));
    }
    if (
      !hasResolvedEffectDisclosure(
        unit.visibleCharacteristics,
        unit.effectToggles,
      )
    ) {
      reasons.push(
        `${unitPath}:effect-state-or-explicit-omission-not-visible`,
      );
    }
  }

  return [...new Set(reasons)].sort();
}

type SelectedArmyState = {
  side: "player" | "opponent";
  savedListName: string;
  selectedUnitCount: number;
  selectorValue: string;
  selectorLabel: string;
};

function stateBindingPayload(
  binding: Omit<TesseraImportedArmySimulationStateBinding, "stateSha256">,
): Omit<TesseraImportedArmySimulationStateBinding, "stateSha256"> {
  return {
    schemaVersion: binding.schemaVersion,
    side: binding.side,
    snapshotSha256: binding.snapshotSha256,
    savedListName: binding.savedListName,
    selectedUnitCount: binding.selectedUnitCount,
    selectorValueSha256: binding.selectorValueSha256,
    selectorLabel: binding.selectorLabel,
    selectorLabelSha256: binding.selectorLabelSha256,
  };
}

export function createTesseraImportedArmySimulationStateBinding(
  snapshot: TesseraImportedArmySemanticSnapshot,
  selected: SelectedArmyState,
): TesseraImportedArmySimulationStateBinding {
  const payload = stateBindingPayload({
    schemaVersion: 1,
    side: selected.side,
    snapshotSha256: tesseraImportedArmySemanticSnapshotSha256(snapshot),
    savedListName: selected.savedListName.trim(),
    selectedUnitCount: selected.selectedUnitCount,
    selectorValueSha256: sha256(selected.selectorValue),
    selectorLabel: selected.selectorLabel,
    selectorLabelSha256: sha256(selected.selectorLabel),
  });
  return {
    ...payload,
    stateSha256: sha256(payload),
  };
}

export function tesseraImportedArmySimulationStateBindingIncompleteReasons(
  snapshot: TesseraImportedArmySemanticSnapshot,
  binding: TesseraImportedArmySimulationStateBinding | null | undefined,
): string[] {
  if (!binding) return ["simulation-state-binding-missing"];
  const reasons: string[] = [];
  if (binding.schemaVersion !== 1) reasons.push("state-binding-schema-version");
  if (binding.side !== snapshot.side) reasons.push("state-binding-side-mismatch");
  if (
    binding.snapshotSha256 !==
    tesseraImportedArmySemanticSnapshotSha256(snapshot)
  ) {
    reasons.push("state-binding-snapshot-digest-mismatch");
  }
  if (!binding.savedListName.trim()) reasons.push("state-binding-list-name-empty");
  if (
    !Number.isSafeInteger(binding.selectedUnitCount) ||
    binding.selectedUnitCount <= 0 ||
    binding.selectedUnitCount !== snapshot.reportedUnitCount
  ) {
    reasons.push("state-binding-unit-count-mismatch");
  }
  for (const [field, value] of [
    ["selector-value", binding.selectorValueSha256],
    ["selector-label", binding.selectorLabelSha256],
  ] as const) {
    if (!sha256Pattern.test(value)) reasons.push(`${field}-digest-invalid`);
  }
  if (
    binding.selectorValueSha256 !==
    sha256(`list:${binding.savedListName}`)
  ) {
    reasons.push("selector-value-does-not-bind-saved-list-name");
  }
  if (
    !binding.selectorLabel.trim() ||
    binding.selectorLabelSha256 !== sha256(binding.selectorLabel)
  ) {
    reasons.push("selector-label-digest-mismatch");
  }
  const normalizedLabel = semanticKey(binding.selectorLabel);
  if (!normalizedLabel.includes(semanticKey(binding.savedListName))) {
    reasons.push("selector-label-name-mismatch");
  }
  const visibleUnitCount = Number(
    binding.selectorLabel.match(/(?:^|\D)(\d+)\s*units?\b/i)?.[1] ??
      binding.selectorLabel.match(/\((\d+)\)\s*$/)?.[1],
  );
  if (
    !Number.isSafeInteger(visibleUnitCount) ||
    visibleUnitCount !== binding.selectedUnitCount
  ) {
    reasons.push("selector-label-unit-count-mismatch");
  }
  if (
    !sha256Pattern.test(binding.stateSha256) ||
    binding.stateSha256 !== sha256(stateBindingPayload(binding))
  ) {
    reasons.push("state-binding-integrity-mismatch");
  }
  return [...new Set(reasons)].sort();
}

export function tesseraImportedArmySemanticEvidenceIncompleteReasons(
  snapshot: TesseraImportedArmySemanticSnapshot,
  binding: TesseraImportedArmySimulationStateBinding | null | undefined,
): string[] {
  return [
    ...tesseraImportedArmySemanticSnapshotIncompleteReasons(snapshot),
    ...tesseraImportedArmySimulationStateBindingIncompleteReasons(
      snapshot,
      binding,
    ),
  ].sort();
}
