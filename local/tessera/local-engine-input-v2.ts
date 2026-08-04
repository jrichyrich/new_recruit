import crypto from "node:crypto";

import type {
  ProfilePolicyV1,
  RosterDraftV1,
} from "../../lib/rosterpilot";
import {
  LOCAL_TESSERA_COMPILER_VERSION,
  compileRosterForLocalTesseraEngine,
  parseLocalTesseraEngineInput,
  serializeLocalTesseraEngineInput,
  verifyLocalTesseraEngineInput,
  type LocalEngineWeapon,
  type LocalTesseraEngineDataContext,
  type LocalTesseraEngineInput,
  type LocalTesseraEngineUnit,
} from "./local-engine-input";

export const LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION =
  "rules-aware-local-input-v2" as const;
export const LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT =
  "bundle-weapon-profile-bearer-v1" as const;

export type LocalEngineWeaponV2 = LocalEngineWeapon & Required<
  Pick<
    LocalEngineWeapon,
    | "weaponId"
    | "equipmentId"
    | "profileId"
    | "bearerSelectionId"
    | "loadoutGroupId"
    | "rangeInches"
  >
>;

export type LocalTesseraEngineUnitV2 = Omit<
  LocalTesseraEngineUnit,
  "unitId" | "weapons"
> & {
  unitId: string;
  weapons: LocalEngineWeaponV2[];
};

export type LocalTesseraEngineInputV2 = Omit<
  LocalTesseraEngineInput,
  "schemaVersion" | "compilerVersion" | "units"
> & {
  schemaVersion: 2;
  compilerVersion: typeof LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION;
  identityContractVersion:
    typeof LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT;
  units: LocalTesseraEngineUnitV2[];
};

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sha256(content: Uint8Array): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function requiredIdentity(
  value: string | undefined,
  subject: string,
): string {
  if (!value?.trim()) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_V2_IDENTITY_MISSING",
      `${subject} is missing from the bundle-native local input.`,
    );
  }
  return value;
}

function weaponV2(
  weapon: LocalEngineWeapon,
  unit: LocalTesseraEngineUnit,
): LocalEngineWeaponV2 {
  const rangeInches = weapon.rangeInches;
  if (
    rangeInches === undefined ||
    (weapon.type === "ranged" && rangeInches === null) ||
    (weapon.type === "ranged" && rangeInches !== null && rangeInches <= 0) ||
    (weapon.type === "melee" && rangeInches !== null)
  ) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_V2_RANGE_MISSING",
      `${unit.label} / ${weapon.name} has no exact phase-appropriate range.`,
    );
  }
  return {
    ...weapon,
    weaponId: requiredIdentity(
      weapon.weaponId,
      `${unit.label} / ${weapon.name} weaponId`,
    ),
    equipmentId: requiredIdentity(
      weapon.equipmentId,
      `${unit.label} / ${weapon.name} equipmentId`,
    ),
    profileId: requiredIdentity(
      weapon.profileId,
      `${unit.label} / ${weapon.name} profileId`,
    ),
    bearerSelectionId: requiredIdentity(
      weapon.bearerSelectionId,
      `${unit.label} / ${weapon.name} bearerSelectionId`,
    ),
    loadoutGroupId: requiredIdentity(
      weapon.loadoutGroupId,
      `${unit.label} / ${weapon.name} loadoutGroupId`,
    ),
    rangeInches,
  };
}

function upgradeV1(
  input: LocalTesseraEngineInput,
): LocalTesseraEngineInputV2 {
  const units = input.units.map((unit) => ({
    ...unit,
    unitId: requiredIdentity(unit.unitId, `${unit.label} unitId`),
    weapons: unit.weapons.map((weapon) => weaponV2(weapon, unit)),
  }));
  return {
    ...input,
    schemaVersion: 2,
    compilerVersion: LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION,
    identityContractVersion:
      LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT,
    units,
  };
}

function v1Projection(
  input: LocalTesseraEngineInputV2,
): LocalTesseraEngineInput {
  const {
    identityContractVersion,
    ...base
  } = input;
  if (
    identityContractVersion !==
      LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT
  ) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_V2_INVALID",
      "The local input does not declare the frozen v2 identity contract.",
    );
  }
  return {
    ...base,
    schemaVersion: 1,
    compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
  };
}

function assertUniqueIdentities(input: LocalTesseraEngineInputV2): void {
  const profileBearers = new Set<string>();
  for (const unit of input.units) {
    for (const weapon of unit.weapons) {
      if (
        (weapon.type === "ranged" &&
          (typeof weapon.rangeInches !== "number" ||
            !Number.isSafeInteger(weapon.rangeInches) ||
            weapon.rangeInches <= 0)) ||
        (weapon.type === "melee" && weapon.rangeInches !== null)
      ) {
        throw codedError(
          "TESSERA_LOCAL_INPUT_V2_RANGE_MISSING",
          `${unit.label} / ${weapon.name} has no exact phase-appropriate range.`,
        );
      }
      if (weapon.bearerSelectionId !== unit.selectionId) {
        throw codedError(
          "TESSERA_LOCAL_INPUT_V2_BEARER_MISMATCH",
          `${unit.label} / ${weapon.name} is bound to another roster selection.`,
        );
      }
      const key = [
        weapon.bearerSelectionId,
        weapon.equipmentId,
        weapon.profileId,
      ].join("|");
      if (profileBearers.has(key)) {
        throw codedError(
          "TESSERA_LOCAL_INPUT_V2_PROFILE_DUPLICATE",
          `${unit.label} repeats exact bearer/equipment/profile identity ${key}.`,
        );
      }
      profileBearers.add(key);
    }
  }
}

export function compileRosterForLocalTesseraEngineV2(
  roster: RosterDraftV1,
  policy: ProfilePolicyV1 | null = null,
  dataContext: LocalTesseraEngineDataContext | null = null,
): LocalTesseraEngineInputV2 {
  const upgraded = upgradeV1(
    compileRosterForLocalTesseraEngine(roster, policy, dataContext),
  );
  assertUniqueIdentities(upgraded);
  return upgraded;
}

export function serializeLocalTesseraEngineInputV2(
  input: LocalTesseraEngineInputV2,
): Uint8Array {
  if (
    input.schemaVersion !== 2 ||
    input.compilerVersion !== LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION ||
    input.identityContractVersion !==
      LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT
  ) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_V2_INVALID",
      "The local input does not declare the exact v2 schema, compiler, and identity contract.",
    );
  }
  // Reuse the mature v1 semantic validator after projecting only the versioned
  // wrapper fields. Weapon source identities are accepted by both schemas.
  serializeLocalTesseraEngineInput(v1Projection(input));
  assertUniqueIdentities(input);
  return Buffer.from(`${JSON.stringify(input, null, 2)}\n`, "utf8");
}

export function parseLocalTesseraEngineInputV2(
  content: Uint8Array,
): LocalTesseraEngineInputV2 {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8"));
  } catch {
    throw codedError(
      "TESSERA_LOCAL_INPUT_V2_INVALID",
      "The RosterPilot local-engine v2 input is not valid JSON.",
    );
  }
  if (!value || typeof value !== "object") {
    throw codedError(
      "TESSERA_LOCAL_INPUT_V2_INVALID",
      "The RosterPilot local-engine v2 input must be an object.",
    );
  }
  const candidate = value as Partial<LocalTesseraEngineInputV2>;
  if (
    candidate.schemaVersion !== 2 ||
    candidate.compilerVersion !== LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION ||
    candidate.identityContractVersion !==
      LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT
  ) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_V2_INVALID",
      "The RosterPilot local-engine input is not schema v2 with the frozen identity contract.",
    );
  }
  const parsedV1 = parseLocalTesseraEngineInput(
    Buffer.from(
      JSON.stringify(
        v1Projection(candidate as LocalTesseraEngineInputV2),
      ),
      "utf8",
    ),
  );
  const parsed = upgradeV1(parsedV1);
  assertUniqueIdentities(parsed);
  return parsed;
}

export function verifyLocalTesseraEngineInputV2(input: {
  content: Uint8Array;
  expectedSha256?: string;
  expectedBundleId?: string;
  expectedRosterFingerprint?: string;
}): LocalTesseraEngineInputV2 {
  if (
    input.expectedSha256 &&
    sha256(input.content) !== input.expectedSha256
  ) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_CHANGED",
      "The RosterPilot local-engine v2 input changed after its hash was frozen.",
    );
  }
  const parsed = parseLocalTesseraEngineInputV2(input.content);
  if (
    input.expectedBundleId &&
    parsed.bundleId !== input.expectedBundleId
  ) {
    throw codedError(
      "TESSERA_LOCAL_BUNDLE_MISMATCH",
      `The local input names bundle ${parsed.bundleId}, not frozen bundle ${input.expectedBundleId}.`,
    );
  }
  if (
    input.expectedRosterFingerprint &&
    parsed.rosterFingerprint !== input.expectedRosterFingerprint
  ) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_CHANGED",
      "The local-engine v2 input does not match the frozen roster execution fingerprint.",
    );
  }
  return parsed;
}

/** Verifies persisted local inputs without weakening either version's schema. */
export function verifyLocalTesseraEngineInputAnyVersion(input: {
  content: Uint8Array;
  expectedSha256?: string;
  expectedBundleId?: string;
  expectedRosterFingerprint?: string;
}): LocalTesseraEngineInput | LocalTesseraEngineInputV2 {
  let schemaVersion: unknown;
  try {
    schemaVersion = JSON.parse(
      Buffer.from(input.content).toString("utf8"),
    )?.schemaVersion;
  } catch {
    schemaVersion = null;
  }
  return schemaVersion === 2
    ? verifyLocalTesseraEngineInputV2(input)
    : verifyLocalTesseraEngineInput(input);
}
