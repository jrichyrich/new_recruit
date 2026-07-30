import { createHash } from "node:crypto";

import type {
  ProfilePolicyV1,
} from "../../lib/rosterpilot";
import { profilePolicyHash } from "./profile-policy";

export type TesseraSavedListReuseSide = {
  runId: string;
  enrichedRoszSha256: string;
  scopedProfilePolicySha256: string;
  rosterExecutionFingerprint: string;
  expectedUnitCount: number;
};

export type TesseraSavedListReuse = {
  schemaVersion: 1;
  player: TesseraSavedListReuseSide;
  opponent: TesseraSavedListReuseSide;
};

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
