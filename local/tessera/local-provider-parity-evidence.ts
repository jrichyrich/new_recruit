import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  TesseraMatchupReport,
  TesseraPreparedRoster,
  TesseraUnitInstance,
} from "../../lib/rosterpilot";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION,
  LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT,
  parseLocalTesseraEngineInputV2,
  verifyLocalTesseraEngineInputV2,
  type LocalEngineWeaponV2,
  type LocalTesseraEngineInputV2,
  type LocalTesseraEngineUnitV2,
} from "./local-engine-input-v2";
import {
  TESSERA_PROVIDER_PARITY_MODELED_MECHANICS,
  TESSERA_PROVIDER_PARITY_OMITTED_MECHANICS,
  normalizeTesseraProviderParityName,
  tesseraProviderParityEffectId,
  tesseraProviderParityProfileId,
  validateTesseraProviderParityCombatSnapshot,
  validateTesseraProviderParityModelCapabilityEnvelope,
  type TesseraProviderParityCombatAttackProfile,
  type TesseraProviderParityCombatUnitSnapshot,
  type TesseraProviderParityModelCapabilityEnvelope,
  type TesseraProviderParityNormalizedCombatSnapshot,
} from "./provider-parity-evidence";

export const TESSERA_PROVIDER_PARITY_COMBAT_MODEL_VERSION =
  "rosterpilot-provider-neutral-combat-v2" as const;

export type TesseraLocalProviderParityEvidenceIssue = {
  code:
    | "LOCAL_REPORT_SCOPE_INVALID"
    | "LOCAL_INPUT_REFERENCE_INVALID"
    | "LOCAL_INPUT_OUTSIDE_REPORT_BUNDLE"
    | "LOCAL_INPUT_UNREADABLE"
    | "LOCAL_INPUT_SCHEMA_UNSUPPORTED"
    | "LOCAL_INPUT_IDENTITY_MISMATCH"
    | "LOCAL_UNIT_BINDING_MISSING"
    | "LOCAL_UNIT_BINDING_AMBIGUOUS"
    | "LOCAL_EFFECT_IDENTITY_AMBIGUOUS"
    | "LOCAL_DERIVED_EVIDENCE_INVALID";
  path: string;
  message: string;
};

export type TesseraLocalProviderParityEvidenceResult =
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
      issues: TesseraLocalProviderParityEvidenceIssue[];
    };

export type TesseraLocalProviderParityEvidenceOptions = {
  reportPath: string;
  dataBundleId: string;
  rulesEdition: string;
  rulesPackageVersion: string;
  engineDataSchemaVersion: number;
  combatModelVersion?: string;
};

function issue(
  code: TesseraLocalProviderParityEvidenceIssue["code"],
  pathName: string,
  message: string,
): TesseraLocalProviderParityEvidenceIssue {
  return { code, path: pathName, message };
}

function withinDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function localSimulationInput(
  prepared: Pick<TesseraPreparedRoster, "simulationInput">,
): Extract<
  NonNullable<TesseraPreparedRoster["simulationInput"]>,
  { kind: "rosterpilot-local-engine-input" }
> | null {
  return prepared.simulationInput?.kind ===
      "rosterpilot-local-engine-input"
    ? prepared.simulationInput
    : null;
}

async function readBoundLocalInput(input: {
  prepared: Pick<TesseraPreparedRoster, "simulationInput" | "fingerprint">;
  reportDirectory: string;
  bundleId: string;
  side: "player" | "opponent";
  issues: TesseraLocalProviderParityEvidenceIssue[];
}): Promise<LocalTesseraEngineInputV2 | null> {
  const reference = localSimulationInput(input.prepared);
  if (!reference) {
    input.issues.push(
      issue(
        "LOCAL_INPUT_REFERENCE_INVALID",
        `${input.side}.simulationInput`,
        "The completed local report does not retain a local-engine input reference.",
      ),
    );
    return null;
  }
  if (reference.compilerVersion !== LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION) {
    input.issues.push(
      issue(
        "LOCAL_INPUT_SCHEMA_UNSUPPORTED",
        `${input.side}.simulationInput.compilerVersion`,
        "Exact provider parity requires a retained rules-aware local input v2 compiler identity.",
      ),
    );
    return null;
  }
  const resolved = path.resolve(input.reportDirectory, reference.path);
  if (!withinDirectory(input.reportDirectory, resolved)) {
    input.issues.push(
      issue(
        "LOCAL_INPUT_OUTSIDE_REPORT_BUNDLE",
        `${input.side}.simulationInput.path`,
        "The local-engine input is outside the receipt-bound report bundle.",
      ),
    );
    return null;
  }
  let content: Uint8Array;
  try {
    content = await readFile(resolved);
  } catch {
    input.issues.push(
      issue(
        "LOCAL_INPUT_UNREADABLE",
        `${input.side}.simulationInput.path`,
        `The receipt-bound local-engine input could not be read at ${resolved}.`,
      ),
    );
    return null;
  }
  try {
    let schemaVersion: unknown = null;
    try {
      schemaVersion = JSON.parse(
        Buffer.from(content).toString("utf8"),
      )?.schemaVersion;
    } catch {
      schemaVersion = null;
    }
    if (schemaVersion !== 2) {
      input.issues.push(
        issue(
          "LOCAL_INPUT_SCHEMA_UNSUPPORTED",
          `${input.side}.simulationInput`,
          "Exact provider parity requires local input schema v2 so weapon range, profile, equipment, bearer, and loadout identities are all receipt-bound.",
        ),
      );
      return null;
    }
    return verifyLocalTesseraEngineInputV2({
      content,
      expectedSha256: reference.sha256,
      expectedBundleId: input.bundleId,
      expectedRosterFingerprint: input.prepared.fingerprint,
    });
  } catch (error) {
    // Parse once only to distinguish malformed content in diagnostics; the
    // verifier remains the authority for all retained identities.
    try {
      parseLocalTesseraEngineInputV2(content);
    } catch {
      // Keep the verifier's complete coded message below.
    }
    input.issues.push(
      issue(
        "LOCAL_INPUT_IDENTITY_MISMATCH",
        `${input.side}.simulationInput`,
        error instanceof Error
          ? error.message
          : "The local-engine input did not match its retained hash, bundle, or roster fingerprint.",
      ),
    );
    return null;
  }
}

function weaponDisplayName(weapon: LocalEngineWeaponV2): string {
  return normalizeTesseraProviderParityName(weapon.name);
}

function weaponIdentity(weapon: LocalEngineWeaponV2): {
  weaponName: string;
  profile: string | null;
} {
  const display = weaponDisplayName(weapon);
  const delimiter = display.match(/\s+(?:-|–|—|:)\s+/);
  if (!delimiter?.index) {
    return { weaponName: display, profile: null };
  }
  return {
    weaponName: normalizeTesseraProviderParityName(
      display.slice(0, delimiter.index),
    ),
    profile: normalizeTesseraProviderParityName(
      display.slice(delimiter.index + delimiter[0].length),
    ),
  };
}

function attackProfiles(
  side: "player" | "opponent",
  unitName: string,
  unitOccurrence: number,
  weapons: readonly LocalEngineWeaponV2[],
): TesseraProviderParityCombatAttackProfile[] {
  const occurrences = new Map<string, number>();
  return weapons.map((weapon) => {
    const phase = weapon.type === "ranged" ? "shooting" : "fight";
    const name = weaponDisplayName(weapon);
    const identity = weaponIdentity(weapon);
    const key = `${phase}\u0000${name.toLocaleLowerCase()}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return {
      profileId: tesseraProviderParityProfileId({
        side,
        unitName,
        unitOccurrence,
        weaponName: identity.weaponName,
        profile: identity.profile,
        weaponOccurrence: occurrence,
      }),
      name,
      phase,
      rangeInches: weapon.rangeInches,
      equippedModelCount: weapon.count,
      attacks: String(weapon.A),
      skill: weapon.type === "ranged" ? weapon.BS ?? null : weapon.WS ?? null,
      strength: weapon.S,
      armorPenetration: weapon.AP,
      damage: String(weapon.D),
      keywords: [...new Set(weapon.keywords.map((keyword) =>
        keyword.trim().toLocaleUpperCase()
      ))].sort((left, right) => left.localeCompare(right)),
    };
  });
}

function localProfileSourceIdentitySha256(
  unit: LocalTesseraEngineUnitV2,
  weapon: LocalEngineWeaponV2,
): string {
  return createHash("sha256")
    .update(canonicalJson({
      identityContractVersion:
        LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT,
      unitId: unit.unitId,
      weaponId: weapon.weaponId,
      equipmentId: weapon.equipmentId,
      profileId: weapon.profileId,
      bearerSelectionId: weapon.bearerSelectionId,
      loadoutGroupId: weapon.loadoutGroupId,
      rangeInches: weapon.rangeInches,
    }))
    .digest("hex");
}

function omittedEffects(
  input: LocalTesseraEngineInputV2,
  unit: LocalTesseraEngineUnitV2,
  issues: TesseraLocalProviderParityEvidenceIssue[],
): string[] {
  const names = [
    ...input.limitations.omittedDatasheetAbilities
      .filter((entry) => entry.selectionId === unit.selectionId)
      .flatMap((entry) => entry.abilityNames),
    ...input.limitations.omittedWargear
      .filter((entry) => entry.selectionId === unit.selectionId)
      .map((entry) => entry.itemName),
    ...input.limitations.omittedEnhancements
      .filter((entry) => entry.selectionId === unit.selectionId)
      .map((entry) => entry.enhancementName),
    ...input.limitations.unsupportedWeaponKeywords
      .filter((entry) => entry.selectionId === unit.selectionId)
      .map((entry) => entry.keyword),
  ];
  const byId = new Map<string, string>();
  for (const name of names) {
    const effectId = tesseraProviderParityEffectId(name);
    const prior = byId.get(effectId);
    if (!effectId || (prior !== undefined && prior !== name)) {
      issues.push(
        issue(
          "LOCAL_EFFECT_IDENTITY_AMBIGUOUS",
          `units.${unit.selectionId}.effects`,
          `Local omitted effects ${JSON.stringify(prior)} and ${JSON.stringify(name)} do not have distinct stable identities.`,
        ),
      );
      continue;
    }
    byId.set(effectId, name);
  }
  return [...byId.keys()].sort((left, right) => left.localeCompare(right));
}

function canonicalUnitFor(
  local: LocalTesseraEngineUnitV2,
  side: "player" | "opponent",
  units: readonly TesseraUnitInstance[],
  issues: TesseraLocalProviderParityEvidenceIssue[],
): TesseraUnitInstance | null {
  const matches = units.filter(
    (candidate) =>
      candidate.side === side &&
      candidate.selectionId === local.selectionId &&
      candidate.ordinal === local.occurrence &&
      candidate.modelCount === local.models,
  );
  if (matches.length === 0) {
    issues.push(
      issue(
        "LOCAL_UNIT_BINDING_MISSING",
        `${side}.${local.selectionId}`,
        "No canonical report unit matches the local input selection, occurrence, and model count.",
      ),
    );
    return null;
  }
  if (matches.length > 1) {
    issues.push(
      issue(
        "LOCAL_UNIT_BINDING_AMBIGUOUS",
        `${side}.${local.selectionId}`,
        "More than one canonical report unit matches the local input selection.",
      ),
    );
    return null;
  }
  return matches[0];
}

function combatUnits(input: {
  localInput: LocalTesseraEngineInputV2;
  side: "player" | "opponent";
  units: readonly TesseraUnitInstance[];
  inputSha256: string;
  issues: TesseraLocalProviderParityEvidenceIssue[];
}): TesseraProviderParityCombatUnitSnapshot[] {
  const result: TesseraProviderParityCombatUnitSnapshot[] = [];
  const bound = new Set<string>();
  for (const local of input.localInput.units) {
    const canonical = canonicalUnitFor(
      local,
      input.side,
      input.units,
      input.issues,
    );
    if (!canonical) continue;
    bound.add(canonical.instanceId);
    if (canonical.points === null) {
      input.issues.push(
        issue(
          "LOCAL_UNIT_BINDING_MISSING",
          `${input.side}.${canonical.instanceId}.points`,
          "The canonical report unit does not retain points for parity normalization.",
        ),
      );
      continue;
    }
    result.push({
      instanceId: canonical.instanceId,
      side: input.side,
      normalizedName: normalizeTesseraProviderParityName(canonical.name),
      modelCount: local.models,
      points: canonical.points,
      defense: {
        toughness: local.T,
        save: local.SV,
        woundsPerModel: local.W,
        invulnerableSave: {
          shooting: local.rangedINV ?? local.INV,
          fight: local.meleeINV ?? local.INV,
        },
      },
      attackProfiles: attackProfiles(
        input.side,
        canonical.name,
        canonical.ordinal,
        local.weapons,
      ),
      modeledEffects: [],
      omittedEffects: omittedEffects(input.localInput, local, input.issues),
      evidence: {
        status: "complete",
        sourceRefs: [
          `rosterpilot-local-input:${input.inputSha256}`,
          ...local.weapons.map(
            (weapon) =>
              `rosterpilot-local-profile-identity:${localProfileSourceIdentitySha256(local, weapon)}`,
          ),
        ].sort((left, right) => left.localeCompare(right)),
        warningCodes: [],
      },
    });
  }
  for (const unit of input.units.filter((unit) => unit.side === input.side)) {
    if (!bound.has(unit.instanceId)) {
      input.issues.push(
        issue(
          "LOCAL_UNIT_BINDING_MISSING",
          `${input.side}.${unit.instanceId}`,
          "A canonical report unit has no verified local-engine input binding.",
        ),
      );
    }
  }
  return result;
}

/**
 * Derives local provider evidence exclusively from immutable input references
 * retained by a receipt-bound exact report. It never accepts combat identity
 * or capability values from the CLI caller.
 */
export async function deriveTesseraLocalProviderParityEvidence(
  report: TesseraMatchupReport,
  options: TesseraLocalProviderParityEvidenceOptions,
): Promise<TesseraLocalProviderParityEvidenceResult> {
  const issues: TesseraLocalProviderParityEvidenceIssue[] = [];
  if (
    report.simulation.selectedBackend !== "local-engine" ||
    report.opponents.length !== 1 ||
    !Array.isArray(report.player.units) ||
    !Array.isArray(report.opponents[0]?.units)
  ) {
    return {
      ok: false,
      modelCapabilityEnvelope: null,
      combatSnapshot: null,
      issues: [
        issue(
          "LOCAL_REPORT_SCOPE_INVALID",
          "report",
          "Local provider parity requires one complete exact opponent and canonical unit instances on both sides.",
        ),
      ],
    };
  }
  const reportDirectory = path.dirname(path.resolve(options.reportPath));
  const [playerInput, opponentInput] = await Promise.all([
    readBoundLocalInput({
      prepared: report.player,
      reportDirectory,
      bundleId: options.dataBundleId,
      side: "player",
      issues,
    }),
    readBoundLocalInput({
      prepared: report.opponents[0],
      reportDirectory,
      bundleId: options.dataBundleId,
      side: "opponent",
      issues,
    }),
  ]);
  if (!playerInput || !opponentInput || issues.length > 0) {
    return {
      ok: false,
      modelCapabilityEnvelope: null,
      combatSnapshot: null,
      issues,
    };
  }
  const units = [
    ...(report.player.units ?? []),
    ...(report.opponents[0].units ?? []),
  ];
  const combatSnapshot: TesseraProviderParityNormalizedCombatSnapshot = {
    schemaVersion: 1,
    kind: "tessera-provider-neutral-combat-snapshot",
    units: [
      ...combatUnits({
        localInput: playerInput,
        side: "player",
        units,
        inputSha256: report.player.simulationInput!.sha256,
        issues,
      }),
      ...combatUnits({
        localInput: opponentInput,
        side: "opponent",
        units,
        inputSha256: report.opponents[0].simulationInput!.sha256,
        issues,
      }),
    ].sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
  };
  const modelCapabilityEnvelope: TesseraProviderParityModelCapabilityEnvelope = {
    schemaVersion: 1,
    rulesEdition: options.rulesEdition.trim(),
    rulesPackageVersion: options.rulesPackageVersion.trim(),
    engineDataSchemaVersion: options.engineDataSchemaVersion,
    combatModelVersion:
      options.combatModelVersion ?? TESSERA_PROVIDER_PARITY_COMBAT_MODEL_VERSION,
    modeledMechanics: [...TESSERA_PROVIDER_PARITY_MODELED_MECHANICS],
    omittedMechanics: [...TESSERA_PROVIDER_PARITY_OMITTED_MECHANICS],
  };
  for (const problem of validateTesseraProviderParityModelCapabilityEnvelope(
    modelCapabilityEnvelope,
  )) {
    issues.push(
      issue(
        "LOCAL_DERIVED_EVIDENCE_INVALID",
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
        "LOCAL_DERIVED_EVIDENCE_INVALID",
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
