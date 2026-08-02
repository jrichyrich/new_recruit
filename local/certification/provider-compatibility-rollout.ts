const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type ProviderCompatibilityCanaryObservation = {
  canaryId: string;
  status: "pass" | "fail" | "unavailable";
  compatibilityComplete: boolean;
  envelopeSha256: string | null;
};

export type ProviderCompatibilityRotationObservation = {
  schemaVersion: 1;
  observationKind: "provider-compatibility-rotation";
  rotationId: string;
  observedAt: string;
  bundleId: string;
  bundleTrustIdentitySha256: string;
  providerCompatibilityMode: "observe" | "enforce";
  canaries: ProviderCompatibilityCanaryObservation[];
};

export type ProviderCompatibilityRolloutEvaluation = {
  schemaVersion: 1;
  evaluationKind: "provider-compatibility-rollout";
  requiredConsecutivePasses: number;
  requiredCanaryIds: string[];
  acceptedObservationCount: number;
  consecutivePasses: number;
  /** Durable repository-controlled latch; it can activate but never disable enforcement. */
  enforcementLatchActive: boolean;
  enforcementActivatedAtRotationId: string | null;
  enforcementActive: boolean;
  latestRotationId: string | null;
  latestProviderCompatibilityMode: "observe" | "enforce" | null;
  latestStatus: "pass" | "fail" | "unavailable" | "missing";
  releaseGate: "observe" | "pass" | "block";
  reasons: string[];
};

function validTimestamp(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

function normalizedRequiredCanaries(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()))]
    .filter(Boolean)
    .sort();
  if (normalized.length === 0) {
    throw new Error(
      "Provider compatibility rollout requires at least one named canary.",
    );
  }
  return normalized;
}

function rotationStatus(
  observation: ProviderCompatibilityRotationObservation,
  requiredCanaryIds: readonly string[],
): "pass" | "fail" | "unavailable" {
  if (
    observation.schemaVersion !== 1 ||
    observation.observationKind !==
      "provider-compatibility-rotation" ||
    !observation.rotationId.trim() ||
    !validTimestamp(observation.observedAt) ||
    !SHA256_PATTERN.test(observation.bundleId) ||
    !SHA256_PATTERN.test(observation.bundleTrustIdentitySha256) ||
    !["observe", "enforce"].includes(
      observation.providerCompatibilityMode,
    )
  ) {
    return "fail";
  }
  const byId = new Map<string, ProviderCompatibilityCanaryObservation>();
  for (const canary of observation.canaries) {
    if (!canary.canaryId.trim() || byId.has(canary.canaryId)) {
      return "fail";
    }
    byId.set(canary.canaryId, canary);
  }
  if (
    byId.size !== requiredCanaryIds.length ||
    requiredCanaryIds.some((canaryId) => !byId.has(canaryId))
  ) {
    return "fail";
  }
  const canaries = requiredCanaryIds.map(
    (canaryId) => byId.get(canaryId)!,
  );
  if (canaries.some((canary) => canary.status === "fail")) {
    return "fail";
  }
  if (
    canaries.some(
      (canary) =>
        canary.status === "unavailable" ||
        !canary.compatibilityComplete ||
        !canary.envelopeSha256 ||
        !SHA256_PATTERN.test(canary.envelopeSha256),
    )
  ) {
    return "unavailable";
  }
  return "pass";
}

/**
 * Evaluates the observe-then-enforce rollout from oldest to newest. Once a
 * complete three-rotation pass streak activates enforcement, later outages do
 * not silently turn enforcement off. They block a new release without
 * authorizing rollback of the active bundle.
 */
export function evaluateProviderCompatibilityRollout(input: {
  observations: ProviderCompatibilityRotationObservation[];
  requiredCanaryIds: readonly string[];
  requiredConsecutivePasses?: number;
  enforcementLatchActive?: boolean;
}): ProviderCompatibilityRolloutEvaluation {
  const requiredCanaryIds = normalizedRequiredCanaries(
    input.requiredCanaryIds,
  );
  const requiredConsecutivePasses =
    input.requiredConsecutivePasses ?? 3;
  if (
    !Number.isSafeInteger(requiredConsecutivePasses) ||
    requiredConsecutivePasses <= 0
  ) {
    throw new Error(
      "Provider compatibility rollout requires a positive consecutive-pass count.",
    );
  }

  const ordered = [...input.observations].sort(
    (left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
      left.rotationId.localeCompare(right.rotationId),
  );
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const observation of ordered) {
    if (seenIds.has(observation.rotationId)) {
      duplicateIds.add(observation.rotationId);
    }
    seenIds.add(observation.rotationId);
  }

  let consecutivePasses = 0;
  let enforcementActivatedAtRotationId: string | null = null;
  let latestStatus:
    | "pass"
    | "fail"
    | "unavailable"
    | "missing" = "missing";
  const reasons: string[] = [];
  for (const observation of ordered) {
    const status = duplicateIds.has(observation.rotationId)
      ? "fail"
      : rotationStatus(observation, requiredCanaryIds);
    latestStatus = status;
    if (status === "pass") {
      consecutivePasses += 1;
      if (
        enforcementActivatedAtRotationId === null &&
        consecutivePasses >= requiredConsecutivePasses
      ) {
        enforcementActivatedAtRotationId = observation.rotationId;
      }
    } else if (status === "fail") {
      consecutivePasses = 0;
    }
    // `unavailable` is not a live observation: it neither advances nor resets
    // the pre-enforcement pass streak. Once enforced, it still blocks release.
  }

  const enforcementLatchActive =
    input.enforcementLatchActive === true;
  const enforcementActive =
    enforcementLatchActive ||
    enforcementActivatedAtRotationId !== null;
  let releaseGate: ProviderCompatibilityRolloutEvaluation["releaseGate"] =
    "observe";
  if (enforcementActive) {
    releaseGate = latestStatus === "pass" ? "pass" : "block";
    const latest = ordered.at(-1) ?? null;
    if (
      enforcementLatchActive &&
      latestStatus === "pass" &&
      latest?.providerCompatibilityMode !== "enforce"
    ) {
      releaseGate = "block";
      reasons.push(
        "Provider compatibility enforcement is durably latched, but the latest rotation ran in observation mode.",
      );
    } else if (latestStatus === "missing") {
      reasons.push(
        "Provider compatibility enforcement is durably latched, but no current verified rotation is available. A new release is blocked.",
      );
    } else if (latestStatus === "unavailable") {
      reasons.push(
        "Provider compatibility enforcement is active, but the latest rotation is unavailable. A new release is blocked; the active bundle is not rolled back.",
      );
    } else if (latestStatus === "fail") {
      reasons.push(
        "Provider compatibility enforcement is active and the latest rotation failed.",
      );
    }
  } else {
    reasons.push(
      `Provider compatibility remains observational until ${requiredConsecutivePasses} successful live rotations have been recorded; ${consecutivePasses} currently qualify.`,
    );
  }
  if (duplicateIds.size > 0) {
    reasons.push(
      `Duplicate rotation identities were rejected: ${[...duplicateIds].sort().join(", ")}.`,
    );
  }

  return {
    schemaVersion: 1,
    evaluationKind: "provider-compatibility-rollout",
    requiredConsecutivePasses,
    requiredCanaryIds,
    acceptedObservationCount: ordered.length - duplicateIds.size,
    consecutivePasses,
    enforcementLatchActive,
    enforcementActivatedAtRotationId,
    enforcementActive,
    latestRotationId: ordered.at(-1)?.rotationId ?? null,
    latestProviderCompatibilityMode:
      ordered.at(-1)?.providerCompatibilityMode ?? null,
    latestStatus,
    releaseGate,
    reasons,
  };
}
