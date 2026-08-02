import { createHash } from "node:crypto";

import type {
  ProfilePolicyV1,
  TesseraProfileRequirement,
} from "../../lib/rosterpilot";
import {
  profilePolicyHash,
  profilePolicyIdentityKey,
  profilePolicyIdentityMatches,
} from "./profile-policy";

export type TesseraSavedListReuseSide = {
  runId: string;
  enrichedRoszSha256: string;
  scopedProfilePolicySha256: string;
  profilePolicyEntryKeys: string[];
  rosterExecutionFingerprint: string;
  expectedUnitCount: number;
};

export type TesseraSavedListReuse = {
  schemaVersion: 1;
  player: TesseraSavedListReuseSide;
  opponent: TesseraSavedListReuseSide;
};

export function createTesseraSavedListReuse(input: {
  runId: string;
  profilePolicy: ProfilePolicyV1 | null | undefined;
  player: Omit<
    TesseraSavedListReuseSide,
    | "runId"
    | "scopedProfilePolicySha256"
    | "profilePolicyEntryKeys"
  >;
  opponent: Omit<
    TesseraSavedListReuseSide,
    | "runId"
    | "scopedProfilePolicySha256"
    | "profilePolicyEntryKeys"
  >;
  playerProfileRequirements: TesseraProfileRequirement[];
  opponentProfileRequirements: TesseraProfileRequirement[];
}): TesseraSavedListReuse {
  const playerPolicy = scopeTesseraProfilePolicy(
    input.profilePolicy,
    input.playerProfileRequirements,
  );
  const opponentPolicy = scopeTesseraProfilePolicy(
    input.profilePolicy,
    input.opponentProfileRequirements,
  );
  return {
    schemaVersion: 1,
    player: {
      ...input.player,
      runId: input.runId,
      scopedProfilePolicySha256:
        scopedTesseraProfilePolicySha256(playerPolicy.policy),
      profilePolicyEntryKeys: playerPolicy.entryKeys,
    },
    opponent: {
      ...input.opponent,
      runId: input.runId,
      scopedProfilePolicySha256:
        scopedTesseraProfilePolicySha256(opponentPolicy.policy),
      profilePolicyEntryKeys: opponentPolicy.entryKeys,
    },
  };
}

export type TesseraSavedListReuseAction = {
  name: string;
  expectedUnitCount: number;
  action: "reused" | "imported";
  /**
   * Exact archive identity used to create or verify this saved list.
   * Optional so reports written before connector accounting v1 remain
   * readable without inventing a content hash.
   */
  contentSha256?: string;
  /** How semantic evidence for this exact saved entry was obtained. */
  semanticSnapshotSource?:
    | "fresh-import"
    | "verified-cache"
    | "unavailable";
  semanticSnapshotSha256?: string;
  semanticSnapshotReceiptSha256?: string;
};

const sha256Pattern = /^[0-9a-f]{64}$/i;

export function tesseraSavedListReuseValidationError(
  input: TesseraSavedListReuseSide,
): string | null {
  if (!input.runId.trim()) return "runId must not be empty";
  if (!sha256Pattern.test(input.enrichedRoszSha256)) {
    return "enrichedRoszSha256 must be a SHA-256 digest";
  }
  if (!sha256Pattern.test(input.scopedProfilePolicySha256)) {
    return "scopedProfilePolicySha256 must be a SHA-256 digest";
  }
  if (
    !Array.isArray(input.profilePolicyEntryKeys) ||
    input.profilePolicyEntryKeys.some(
      (key) => typeof key !== "string" || !key.trim(),
    ) ||
    new Set(input.profilePolicyEntryKeys).size !==
      input.profilePolicyEntryKeys.length
  ) {
    return "profilePolicyEntryKeys must contain unique, non-empty strings";
  }
  if (!sha256Pattern.test(input.rosterExecutionFingerprint)) {
    return "rosterExecutionFingerprint must be a SHA-256 digest";
  }
  if (
    !Number.isSafeInteger(input.expectedUnitCount) ||
    input.expectedUnitCount <= 0
  ) {
    return "expectedUnitCount must be a positive integer";
  }
  return null;
}

/**
 * Produces a safe visible Tessera list name without exposing a roster name,
 * run id, source archive hash, profile-policy hash, or execution fingerprint.
 */
export function deterministicTesseraSavedListName(
  side: "player" | "opponent",
  input: TesseraSavedListReuseSide,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        runId: input.runId.trim(),
        side,
        enrichedRoszSha256:
          input.enrichedRoszSha256.toLocaleLowerCase(),
        scopedProfilePolicySha256:
          input.scopedProfilePolicySha256.toLocaleLowerCase(),
        rosterExecutionFingerprint:
          input.rosterExecutionFingerprint.toLocaleLowerCase(),
      }),
    )
    .digest("hex");
  return `RP-CERT-${side === "player" ? "A" : "B"}-${digest.slice(0, 24)}`;
}

export function scopedTesseraProfilePolicySha256(
  policy: ProfilePolicyV1 | null | undefined,
): string {
  return policy
    ? profilePolicyHash(policy)
    : createHash("sha256")
      .update("rosterpilot:tessera-profile-policy:none:v1")
      .digest("hex");
}

export function scopeTesseraProfilePolicy(
  policy: ProfilePolicyV1 | null | undefined,
  requirements: TesseraProfileRequirement[],
): {
  policy: ProfilePolicyV1 | null;
  entryKeys: string[];
} {
  if (!policy || requirements.length === 0) {
    return {
      policy: null,
      entryKeys: [],
    };
  }
  const entries = policy.entries.filter((entry) =>
    requirements.some((requirement) =>
      profilePolicyIdentityMatches(entry, requirement),
    ),
  );
  if (entries.length === 0) {
    return {
      policy: null,
      entryKeys: [],
    };
  }
  return {
    policy: {
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries,
    },
    entryKeys: entries
      .map((entry) => profilePolicyIdentityKey(entry))
      .sort((left, right) => left.localeCompare(right)),
  };
}

export function tesseraProfilePolicyForEntryKeys(
  policy: ProfilePolicyV1 | null | undefined,
  entryKeys: string[],
): ProfilePolicyV1 | null {
  if (entryKeys.length === 0) return null;
  if (!policy) return null;
  const requested = new Set(entryKeys);
  const entries = policy.entries.filter((entry) =>
    requested.has(profilePolicyIdentityKey(entry)),
  );
  if (entries.length !== requested.size) return null;
  return {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries,
  };
}
