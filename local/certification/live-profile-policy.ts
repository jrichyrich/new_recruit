import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  inspectEnrichedProfileRequirements,
  type ProfilePolicyV1,
  type RosterDraftV1,
  type TesseraProfileRequirement,
} from "../../lib/rosterpilot";
import {
  aggregateProfileRequirements,
  normalizeProfileIdentity,
  ProfilePolicySchema,
  profilePolicyHash,
  profilePolicyIdentityKey,
  profilePolicyIdentityMatches,
  profilePolicyScaffold,
  validateProfilePolicy,
} from "../tessera/profile-policy";

export type LiveCertificationProfilePolicySource = {
  policy: ProfilePolicyV1;
  requestedPath: string;
  requestedBasename: string;
  sourceSha256: string;
  canonicalSha256: string;
};

export type SafeTesseraProfileRequirement = Omit<
  TesseraProfileRequirement,
  "selectionId" | "selectedProfile"
>;

export type LiveCertificationProfilePolicyPreflight = {
  valid: boolean;
  code:
    | "TESSERA_ENRICHED_PROFILE_INVENTORY_MISMATCH"
    | "TESSERA_PROFILE_POLICY_REQUIRED"
    | "TESSERA_PROFILE_POLICY_INVALID"
    | null;
  policy: ProfilePolicyV1 | null;
  policyHash: string | null;
  requirements: SafeTesseraProfileRequirement[];
  unresolved: SafeTesseraProfileRequirement[];
  errors: string[];
  inventory: {
    pinned: SafeTesseraProfileRequirement[];
    enriched: SafeTesseraProfileRequirement[];
    blocking: Array<{
      code:
        | "missing-requirement"
        | "active-count-mismatch"
        | "missing-profiles";
      requirement: SafeTesseraProfileRequirement;
      observedActiveCount?: number;
      missingProfiles?: string[];
    }>;
    expanded: SafeTesseraProfileRequirement[];
  };
  scaffold: ProfilePolicyV1 | null;
};

export type PinnedLiveCertificationProfilePolicyPreflight = Pick<
  LiveCertificationProfilePolicyPreflight,
  | "valid"
  | "code"
  | "policy"
  | "policyHash"
  | "requirements"
  | "unresolved"
  | "errors"
  | "scaffold"
>;

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function sha256(content: string | Uint8Array): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function safeRequirement(
  requirement: TesseraProfileRequirement,
): SafeTesseraProfileRequirement {
  return {
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
    availableProfiles: [...requirement.availableProfiles],
    activeCount: requirement.activeCount,
  };
}

export function resolveLiveProfilePolicyArgument(
  tier: "deterministic" | "connector" | "live",
  raw: string | boolean | undefined,
): string | null {
  if (raw === undefined) return null;
  if (tier !== "live") {
    throw codedError(
      "CERTIFICATION_PROFILE_POLICY_TIER_INVALID",
      "--profile-policy is only valid with --tier live.",
    );
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw codedError(
      "CERTIFICATION_PROFILE_POLICY_PATH_REQUIRED",
      "--profile-policy requires a JSON file path.",
    );
  }
  return path.resolve(raw);
}

export async function loadLiveCertificationProfilePolicy(
  requestedPath: string,
): Promise<LiveCertificationProfilePolicySource> {
  let content: string;
  try {
    content = await readFile(requestedPath, "utf8");
  } catch (error) {
    throw codedError(
      "TESSERA_PROFILE_POLICY_INVALID",
      `The live certification profile policy "${path.basename(requestedPath)}" could not be read: ${
        error instanceof Error ? error.message : "unknown read failure"
      }`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw codedError(
      "TESSERA_PROFILE_POLICY_INVALID",
      `The live certification profile policy "${path.basename(requestedPath)}" is not valid JSON.`,
    );
  }
  const parsed = ProfilePolicySchema.safeParse(json);
  if (!parsed.success) {
    throw codedError(
      "TESSERA_PROFILE_POLICY_INVALID",
      `The live certification profile policy "${path.basename(requestedPath)}" is not a valid v1 Tessera profile policy.`,
    );
  }
  return {
    policy: parsed.data,
    requestedPath,
    requestedBasename: path.basename(requestedPath),
    sourceSha256: sha256(content),
    canonicalSha256: profilePolicyHash(parsed.data),
  };
}

/**
 * Resolves every alternate profile already known from pinned roster data.
 * This gate is intentionally independent of New Recruit so a missing or
 * invalid known choice cannot create a remote list. Enriched-only choices are
 * discovered and checked by `preflightLiveCertificationProfilePolicy` after
 * a verified archive is available.
 */
export function preflightPinnedLiveCertificationProfilePolicy(input: {
  roster: RosterDraftV1;
  source: LiveCertificationProfilePolicySource | null;
}): PinnedLiveCertificationProfilePolicyPreflight {
  const requirements = aggregateProfileRequirements([
    input.roster,
  ]);
  const policy = input.source
    ? {
        schemaVersion: 1 as const,
        policyKind: "tessera-profile-policy" as const,
        entries: input.source.policy.entries.filter((entry) =>
          requirements.some((requirement) =>
            profilePolicyIdentityMatches(entry, requirement),
          ),
        ),
      }
    : null;
  const validation = validateProfilePolicy(
    requirements,
    policy,
  );
  const code = validation.valid
    ? null
    : validation.errors.length > 0
      ? "TESSERA_PROFILE_POLICY_INVALID"
      : "TESSERA_PROFILE_POLICY_REQUIRED";
  return {
    valid: validation.valid,
    code,
    policy,
    policyHash: validation.hash,
    requirements: requirements.map(safeRequirement),
    unresolved: validation.unresolved.map(safeRequirement),
    errors: validation.errors,
    scaffold: validation.valid
      ? null
      : profilePolicyScaffold(requirements),
  };
}

export function preflightLiveCertificationProfilePolicy(input: {
  enrichedRosz: Uint8Array;
  roster: RosterDraftV1;
  source: LiveCertificationProfilePolicySource | null;
}): LiveCertificationProfilePolicyPreflight {
  const enrichedRequirements = inspectEnrichedProfileRequirements(
    input.enrichedRosz,
    input.roster.factionId,
  );
  const pinnedRequirements = aggregateProfileRequirements([
    input.roster,
  ]);
  const enrichedByKey = new Map(
    enrichedRequirements.map((requirement) => [
      profilePolicyIdentityKey(requirement),
      requirement,
    ]),
  );
  const pinnedByKey = new Map(
    pinnedRequirements.map((requirement) => [
      profilePolicyIdentityKey(requirement),
      requirement,
    ]),
  );
  const inventoryBlocking:
    LiveCertificationProfilePolicyPreflight["inventory"]["blocking"] =
      [];
  for (const [key, requirement] of pinnedByKey) {
    const observed = enrichedByKey.get(key);
    if (!observed) {
      inventoryBlocking.push({
        code: "missing-requirement",
        requirement: safeRequirement(requirement),
      });
      continue;
    }
    if (observed.activeCount !== requirement.activeCount) {
      inventoryBlocking.push({
        code: "active-count-mismatch",
        requirement: safeRequirement(requirement),
        observedActiveCount: observed.activeCount,
      });
    }
    const observedProfiles = new Set(
      observed.availableProfiles.map(normalizeProfileIdentity),
    );
    const missingProfiles = requirement.availableProfiles.filter(
      (profile) =>
        !observedProfiles.has(normalizeProfileIdentity(profile)),
    );
    if (missingProfiles.length > 0) {
      inventoryBlocking.push({
        code: "missing-profiles",
        requirement: safeRequirement(requirement),
        missingProfiles,
      });
    }
  }
  const expanded = enrichedRequirements
    .filter(
      (requirement) =>
        !pinnedByKey.has(profilePolicyIdentityKey(requirement)),
    )
    .map(safeRequirement);
  if (inventoryBlocking.length > 0) {
    return {
      valid: false,
      code: "TESSERA_ENRICHED_PROFILE_INVENTORY_MISMATCH",
      policy: null,
      policyHash: null,
      requirements: enrichedRequirements.map(safeRequirement),
      unresolved: [],
      errors: [],
      inventory: {
        pinned: pinnedRequirements.map(safeRequirement),
        enriched: enrichedRequirements.map(safeRequirement),
        blocking: inventoryBlocking,
        expanded,
      },
      scaffold: null,
    };
  }
  const policy = input.source
    ? {
        schemaVersion: 1 as const,
        policyKind: "tessera-profile-policy" as const,
        entries: input.source.policy.entries.filter((entry) =>
          enrichedRequirements.some((requirement) =>
            profilePolicyIdentityMatches(entry, requirement),
          ),
        ),
      }
    : null;
  const validation = validateProfilePolicy(
    enrichedRequirements,
    policy,
  );
  const safeRequirements = enrichedRequirements.map(safeRequirement);
  const safeUnresolved = validation.unresolved.map(safeRequirement);
  const code = validation.valid
    ? null
    : validation.errors.length > 0
      ? "TESSERA_PROFILE_POLICY_INVALID"
      : "TESSERA_PROFILE_POLICY_REQUIRED";
  return {
    valid: validation.valid,
    code,
    policy,
    policyHash: validation.hash,
    requirements: safeRequirements,
    unresolved: safeUnresolved,
    errors: validation.errors,
    inventory: {
      pinned: pinnedRequirements.map(safeRequirement),
      enriched: safeRequirements,
      blocking: [],
      expanded,
    },
    scaffold: profilePolicyScaffold(enrichedRequirements),
  };
}
