import type { LocalTesseraEngineUnit } from "./local-engine-input";

export const TRACKED_TESSERA_ADAPTER_V2_VERSION =
  "rosterpilot-tessera-adapter-v2" as const;

export type TesseraDefenderUnitPatchV2 = {
  id: string;
  side: "defender";
  scope: "unit-wide" | "bearer";
  bearerSelectionId: string | null;
  saveModifier?: number;
  toughnessModifier?: number;
  effectIds: string[];
};

type PatchableUnit = LocalTesseraEngineUnit & {
  attached?: PatchableUnit[];
};

export class TrackedTesseraAdapterV2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TrackedTesseraAdapterV2Error";
    this.code = code;
  }
}

function finiteModifier(
  value: number | undefined,
  label: string,
): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) {
    throw new TrackedTesseraAdapterV2Error(
      "TESSERA_ADAPTER_V2_PATCH_INVALID",
      `${label} must be a finite number.`,
    );
  }
  return value;
}

function patchOwnStats(
  unit: PatchableUnit,
  patch: TesseraDefenderUnitPatchV2,
): PatchableUnit {
  const saveModifier = finiteModifier(
    patch.saveModifier,
    "The save modifier",
  );
  const toughnessModifier = finiteModifier(
    patch.toughnessModifier,
    "The Toughness modifier",
  );
  const patchProfile = <T extends { SV: number; T: number }>(
    profile: T,
  ): T => ({
    ...profile,
    // 40kdc's resolved save modifier is a roll modifier: positive values
    // improve the required armour roll. Moving it into SV before Tessera
    // applies AP preserves the same `SV - AP - saveMod` arithmetic.
    SV: profile.SV - saveModifier,
    T: Math.max(1, profile.T + toughnessModifier),
  });
  return {
    ...patchProfile(unit),
    ...(unit.profiles
      ? { profiles: unit.profiles.map((profile) => patchProfile(profile)) }
      : {}),
  };
}

function patchUnitWide(
  unit: PatchableUnit,
  patch: TesseraDefenderUnitPatchV2,
): PatchableUnit {
  const own = patchOwnStats(unit, patch);
  return own.attached
    ? {
        ...own,
        attached: own.attached.map((member) =>
          patchUnitWide(member, patch),
        ),
      }
    : own;
}

function bearerMatches(
  unit: PatchableUnit,
  bearerSelectionId: string,
): boolean {
  return (
    unit.selectionId === bearerSelectionId ||
    (
      "memberId" in unit &&
      unit.memberId === bearerSelectionId
    )
  );
}

function patchBearer(
  defender: PatchableUnit,
  patch: TesseraDefenderUnitPatchV2,
): PatchableUnit {
  const bearerSelectionId = patch.bearerSelectionId;
  if (!bearerSelectionId) {
    throw new TrackedTesseraAdapterV2Error(
      "TESSERA_ADAPTER_V2_BEARER_ID_REQUIRED",
      `Bearer patch ${JSON.stringify(patch.id)} has no selection identity.`,
    );
  }
  const directMatch = bearerMatches(defender, bearerSelectionId);
  const attachedMatches = (defender.attached ?? []).filter((member) =>
    bearerMatches(member, bearerSelectionId),
  );
  const matchCount = Number(directMatch) + attachedMatches.length;
  if (matchCount !== 1) {
    throw new TrackedTesseraAdapterV2Error(
      matchCount === 0
        ? "TESSERA_ADAPTER_V2_BEARER_NOT_FOUND"
        : "TESSERA_ADAPTER_V2_BEARER_AMBIGUOUS",
      `Bearer patch ${JSON.stringify(patch.id)} resolved ${matchCount} members for selection ${JSON.stringify(bearerSelectionId)}.`,
    );
  }
  if (directMatch) {
    if (defender.models !== 1) {
      throw new TrackedTesseraAdapterV2Error(
        "TESSERA_ADAPTER_V2_BEARER_MODEL_AMBIGUOUS",
        `Selection ${JSON.stringify(bearerSelectionId)} contains ${defender.models} models, so its bearer-only stat patch cannot be applied to the unit headline exactly.`,
      );
    }
    return patchOwnStats(defender, patch);
  }
  return {
    ...defender,
    attached: (defender.attached ?? []).map((member) => {
      if (!bearerMatches(member, bearerSelectionId)) return member;
      if (member.models !== 1) {
        throw new TrackedTesseraAdapterV2Error(
          "TESSERA_ADAPTER_V2_BEARER_MODEL_AMBIGUOUS",
          `Attached selection ${JSON.stringify(bearerSelectionId)} contains ${member.models} models, so its bearer-only stat patch is ambiguous.`,
        );
      }
      return patchOwnStats(member, patch);
    }),
  };
}

/**
 * Applies projection-v2 stat patches without mutating the pinned dependency.
 * Unit-wide patches reach the body, mixed profiles, Leader, and Support
 * members. Bearer patches require one exact single-model selection match.
 */
export function applyTrackedTesseraAdapterV2Patches<
  TUnit extends LocalTesseraEngineUnit,
>(
  defender: TUnit,
  patches: readonly TesseraDefenderUnitPatchV2[],
): TUnit {
  let current = defender as TUnit & PatchableUnit;
  for (const patch of patches) {
    if (
      patch.side !== "defender" ||
      !patch.id ||
      !Array.isArray(patch.effectIds) ||
      patch.effectIds.length === 0
    ) {
      throw new TrackedTesseraAdapterV2Error(
        "TESSERA_ADAPTER_V2_PATCH_INVALID",
        "A tracked Tessera patch has an invalid side, identity, or effect inventory.",
      );
    }
    current = (
      patch.scope === "unit-wide"
        ? patchUnitWide(current, patch)
        : patch.scope === "bearer"
          ? patchBearer(current, patch)
          : (() => {
              throw new TrackedTesseraAdapterV2Error(
                "TESSERA_ADAPTER_V2_PATCH_SCOPE_UNSUPPORTED",
                `Tracked patch ${JSON.stringify(patch.id)} has an unsupported scope.`,
              );
            })()
    ) as TUnit & PatchableUnit;
  }
  return current;
}
