import crypto from "node:crypto";

import { z } from "zod";

import {
  rosterProfileRequirements,
  type ProfilePolicyV1,
  type RosterDraftV1,
  type TesseraProfilePolicyEntry,
  type TesseraProfileRequirement,
} from "../../lib/rosterpilot";

export const ProfilePolicySchema = z.object({
  schemaVersion: z.literal(1),
  policyKind: z.literal("tessera-profile-policy"),
  entries: z.array(z.object({
    faction: z.string().min(1),
    unit: z.string().min(1),
    unitOccurrence: z.number().int().positive().optional(),
    modelCount: z.number().int().positive().optional(),
    weaponGroup: z.string().min(1),
    phase: z.enum(["shooting", "fight"]),
    selectedProfile: z.string().min(1),
    activeCount: z.number().int().positive(),
  })),
}).strict();

function canonicalPunctuation(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’‛`´]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-");
}

export function normalizeProfileIdentity(value: string): string {
  return canonicalPunctuation(value)
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

type ProfileIdentity = Pick<
  TesseraProfilePolicyEntry,
  "faction" | "unit" | "weaponGroup" | "phase"
> & {
  unitOccurrence?: number;
  modelCount?: number;
};

function baseEntryKey(
  value: Pick<
    TesseraProfilePolicyEntry,
    "faction" | "unit" | "weaponGroup" | "phase"
  >,
): string {
  return [
    normalizeProfileIdentity(value.faction),
    normalizeProfileIdentity(value.unit),
    normalizeProfileIdentity(value.weaponGroup),
    value.phase,
  ].join("|");
}

export function profilePolicyIdentityKey(
  value: ProfileIdentity,
): string {
  return [
    baseEntryKey(value),
    `models:${value.modelCount ?? "legacy"}`,
    `occurrence:${value.unitOccurrence ?? "legacy"}`,
  ].join("|");
}

export function profilePolicyIdentityMatches(
  left: ProfileIdentity,
  right: ProfileIdentity,
): boolean {
  return (
    baseEntryKey(left) === baseEntryKey(right) &&
    (
      left.modelCount === undefined ||
      right.modelCount === undefined ||
      left.modelCount === right.modelCount
    ) &&
    (
      left.unitOccurrence === undefined ||
      right.unitOccurrence === undefined ||
      left.unitOccurrence === right.unitOccurrence
    )
  );
}

function canonicalPolicy(policy: ProfilePolicyV1): ProfilePolicyV1 {
  return {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: [...policy.entries]
      .map((entry) => ({
        faction: canonicalPunctuation(entry.faction).trim(),
        unit: canonicalPunctuation(entry.unit).trim(),
        ...(entry.unitOccurrence === undefined
          ? {}
          : { unitOccurrence: entry.unitOccurrence }),
        ...(entry.modelCount === undefined
          ? {}
          : { modelCount: entry.modelCount }),
        weaponGroup: canonicalPunctuation(entry.weaponGroup).trim(),
        phase: entry.phase,
        selectedProfile: canonicalPunctuation(
          entry.selectedProfile,
        ).trim(),
        activeCount: entry.activeCount,
      }))
      .sort(
        (left, right) =>
          profilePolicyIdentityKey(left).localeCompare(
            profilePolicyIdentityKey(right),
          ) ||
          left.selectedProfile.localeCompare(right.selectedProfile) ||
          left.activeCount - right.activeCount,
      ),
  };
}

export function profilePolicyHash(policy: ProfilePolicyV1): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalPolicy(policy)))
    .digest("hex");
}

export function aggregateProfileRequirements(
  rosters: RosterDraftV1[],
): TesseraProfileRequirement[] {
  const grouped = new Map<string, TesseraProfileRequirement>();
  for (const roster of rosters) {
    const occurrenceByUnitSize = new Map<string, number>();
    const selectionIdentity = new Map<
      string,
      { modelCount: number; unitOccurrence: number }
    >();
    for (const selection of roster.units) {
      const unitSizeKey = [
        normalizeProfileIdentity(selection.name),
        selection.modelCount,
      ].join("|");
      const unitOccurrence =
        (occurrenceByUnitSize.get(unitSizeKey) ?? 0) + 1;
      occurrenceByUnitSize.set(unitSizeKey, unitOccurrence);
      selectionIdentity.set(selection.selectionId, {
        modelCount: selection.modelCount,
        unitOccurrence,
      });
    }
    for (const requirement of rosterProfileRequirements(roster)) {
      const identity =
        requirement.selectionId === null
          ? undefined
          : selectionIdentity.get(requirement.selectionId);
      const discriminated = {
        ...structuredClone(requirement),
        ...(identity ?? {}),
      };
      const key = profilePolicyIdentityKey(discriminated);
      const current = grouped.get(key);
      if (current) {
        current.activeCount = Math.max(
          current.activeCount,
          requirement.activeCount,
        );
        const profiles = new Map(
          current.availableProfiles.map((profile) => [
            normalizeProfileIdentity(profile),
            profile,
          ]),
        );
        for (const profile of requirement.availableProfiles) {
          profiles.set(normalizeProfileIdentity(profile), profile);
        }
        current.availableProfiles = [...profiles.values()].sort(
          (left, right) =>
            normalizeProfileIdentity(left).localeCompare(
              normalizeProfileIdentity(right),
            ),
        );
        current.selectionId = null;
      } else {
        grouped.set(key, discriminated);
      }
    }
  }
  return [...grouped.values()].sort((left, right) =>
    profilePolicyIdentityKey(left).localeCompare(
      profilePolicyIdentityKey(right),
    ),
  );
}

export function profilePolicyScaffold(
  requirements: TesseraProfileRequirement[],
): ProfilePolicyV1 {
  return {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: requirements.map((requirement) => ({
      faction: requirement.faction,
      unit: requirement.unit,
      ...(requirement.unitOccurrence === undefined
        ? {}
        : { unitOccurrence: requirement.unitOccurrence }),
      ...(requirement.modelCount === undefined
        ? {}
        : { modelCount: requirement.modelCount }),
      weaponGroup: requirement.weaponGroup,
      phase: requirement.phase,
      selectedProfile: `SELECT_ONE_OF: ${requirement.availableProfiles.join(" | ")}`,
      activeCount: requirement.activeCount,
    })),
  };
}

export type ProfilePolicyValidation = {
  valid: boolean;
  hash: string | null;
  requirements: TesseraProfileRequirement[];
  unresolved: TesseraProfileRequirement[];
  errors: string[];
};

export function validateProfilePolicy(
  requirements: TesseraProfileRequirement[],
  policy: ProfilePolicyV1 | null,
): ProfilePolicyValidation {
  if (requirements.length === 0) {
    return {
      valid: policy === null || policy.entries.length === 0,
      hash: policy ? profilePolicyHash(policy) : null,
      requirements,
      unresolved: [],
      errors:
        policy && policy.entries.length > 0
          ? ["The profile policy contains entries that no roster requires."]
          : [],
    };
  }
  if (!policy) {
    return {
      valid: false,
      hash: null,
      requirements,
      unresolved: requirements,
      errors: [],
    };
  }
  const errors: string[] = [];
  const matchedRequirements = new Set<number>();
  for (const entry of policy.entries) {
    let candidates = requirements
      .map((requirement, index) => ({ requirement, index }))
      .filter(({ requirement }) =>
        profilePolicyIdentityMatches(entry, requirement),
      );
    if (candidates.length > 1) {
      const matchingCount = candidates.filter(
        ({ requirement }) =>
          requirement.activeCount === entry.activeCount,
      );
      if (matchingCount.length === 1) candidates = matchingCount;
    }
    const label =
      `${entry.unit} / ${entry.weaponGroup} / ${entry.phase}`;
    if (candidates.length === 0) {
      errors.push(
        `The profile-policy entry for ${label} does not match the frozen rosters.`,
      );
      continue;
    }
    if (candidates.length > 1) {
      errors.push(
        `${label} is ambiguous across same-name unit occurrences. Regenerate the scaffold with modelCount and unitOccurrence.`,
      );
      continue;
    }
    const [{ requirement, index }] = candidates;
    if (matchedRequirements.has(index)) {
      errors.push(
        `Duplicate profile-policy entry for ${label} (modelCount ${requirement.modelCount ?? "legacy"}, occurrence ${requirement.unitOccurrence ?? "legacy"}).`,
      );
      continue;
    }
    matchedRequirements.add(index);
    if (
      !requirement.availableProfiles.some(
        (profile) =>
          normalizeProfileIdentity(profile) ===
          normalizeProfileIdentity(entry.selectedProfile),
      )
    ) {
      errors.push(
        `${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase} selected "${entry.selectedProfile}", but available profiles are ${requirement.availableProfiles.join(", ")}.`,
      );
    }
    if (entry.activeCount !== requirement.activeCount) {
      errors.push(
        `${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase} has activeCount ${entry.activeCount}; expected ${requirement.activeCount}.`,
      );
    }
  }
  const unresolved = requirements.filter(
    (_requirement, index) => !matchedRequirements.has(index),
  );
  return {
    valid: unresolved.length === 0 && errors.length === 0,
    hash: profilePolicyHash(policy),
    requirements,
    unresolved,
    errors,
  };
}
