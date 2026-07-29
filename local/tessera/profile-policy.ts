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
    weaponGroup: z.string().min(1),
    phase: z.enum(["shooting", "fight"]),
    selectedProfile: z.string().min(1),
    activeCount: z.number().int().positive(),
  })),
}).strict();

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function entryKey(
  value: Pick<
    TesseraProfilePolicyEntry,
    "faction" | "unit" | "weaponGroup" | "phase"
  >,
): string {
  return [
    normalized(value.faction),
    normalized(value.unit),
    normalized(value.weaponGroup),
    value.phase,
  ].join("|");
}

function canonicalPolicy(policy: ProfilePolicyV1): ProfilePolicyV1 {
  return {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: [...policy.entries]
      .map((entry) => ({
        faction: entry.faction.trim(),
        unit: entry.unit.trim(),
        weaponGroup: entry.weaponGroup.trim(),
        phase: entry.phase,
        selectedProfile: entry.selectedProfile.trim(),
        activeCount: entry.activeCount,
      }))
      .sort(
        (left, right) =>
          entryKey(left).localeCompare(entryKey(right)) ||
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
  for (const requirement of rosters.flatMap(rosterProfileRequirements)) {
    const key = entryKey(requirement);
    const current = grouped.get(key);
    if (current) {
      current.activeCount = Math.max(
        current.activeCount,
        requirement.activeCount,
      );
      current.availableProfiles = [
        ...new Set([
          ...current.availableProfiles,
          ...requirement.availableProfiles,
        ]),
      ].sort();
      current.selectionId = null;
    } else {
      grouped.set(key, structuredClone(requirement));
    }
  }
  return [...grouped.values()].sort((left, right) =>
    entryKey(left).localeCompare(entryKey(right)),
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
  const entries = new Map<string, TesseraProfilePolicyEntry>();
  const errors: string[] = [];
  for (const entry of policy.entries) {
    const key = entryKey(entry);
    if (entries.has(key)) {
      errors.push(
        `Duplicate profile-policy entry for ${entry.unit} / ${entry.weaponGroup} / ${entry.phase}.`,
      );
      continue;
    }
    entries.set(key, entry);
  }
  const unresolved: TesseraProfileRequirement[] = [];
  for (const requirement of requirements) {
    const entry = entries.get(entryKey(requirement));
    if (!entry) {
      unresolved.push(requirement);
      continue;
    }
    if (
      !requirement.availableProfiles.some(
        (profile) =>
          normalized(profile) === normalized(entry.selectedProfile),
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
  const requiredKeys = new Set(requirements.map(entryKey));
  for (const entry of policy.entries) {
    if (!requiredKeys.has(entryKey(entry))) {
      errors.push(
        `The profile-policy entry for ${entry.unit} / ${entry.weaponGroup} / ${entry.phase} does not match the frozen rosters.`,
      );
    }
  }
  return {
    valid: unresolved.length === 0 && errors.length === 0,
    hash: profilePolicyHash(policy),
    requirements,
    unresolved,
    errors,
  };
}
