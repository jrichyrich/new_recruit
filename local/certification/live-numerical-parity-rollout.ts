const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export const LIVE_NUMERICAL_PARITY_REQUIRED_CONSECUTIVE_PASSES = 3;
export const LIVE_NUMERICAL_PARITY_ENFORCEMENT_TAG =
  "rosterpilot-live-numerical-parity-enforced-v1";
export const LIVE_NUMERICAL_PARITY_ENFORCEMENT_ENV =
  "ROSTERPILOT_LIVE_NUMERICAL_PARITY_ENFORCED";

export type LiveNumericalParityRolloutObservation = {
  schemaVersion: 1;
  observationKind: "live-numerical-parity-rotation";
  rotationId: string;
  observedAt: string;
  certificateReportId: string;
  certificateSha256: string;
  expectedBundleId: string;
  expectedGitHead: string;
  status: "pass" | "fail" | "incomplete" | "ineligible" | "unavailable";
  eligible: boolean;
  complete: boolean;
  liveEvidence: boolean;
};

export type LiveNumericalParityRolloutEvaluation = {
  schemaVersion: 1;
  evaluationKind: "live-numerical-parity-rollout";
  requiredConsecutivePasses: 3;
  acceptedObservationCount: number;
  consecutivePasses: number;
  enforcementLatchActive: boolean;
  requiredCurrentRotationId: string | null;
  enforcementActivatedAtRotationId: string | null;
  enforcementActive: boolean;
  latestRotationId: string | null;
  latestStatus:
    | "pass"
    | "fail"
    | "incomplete"
    | "ineligible"
    | "unavailable"
    | "missing";
  releaseGate: "observe" | "pass" | "block";
  reasons: string[];
};

function validTimestamp(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

function observationStatus(
  observation: LiveNumericalParityRolloutObservation,
): LiveNumericalParityRolloutObservation["status"] {
  if (
    observation.schemaVersion !== 1 ||
    observation.observationKind !== "live-numerical-parity-rotation" ||
    !observation.rotationId.trim() ||
    !validTimestamp(observation.observedAt) ||
    !SHA256_PATTERN.test(observation.certificateReportId) ||
    !SHA256_PATTERN.test(observation.certificateSha256) ||
    !SHA256_PATTERN.test(observation.expectedBundleId) ||
    !GIT_SHA_PATTERN.test(observation.expectedGitHead)
  ) {
    return "fail";
  }
  if (observation.status === "pass") {
    return observation.eligible &&
      observation.complete &&
      observation.liveEvidence
      ? "pass"
      : "ineligible";
  }
  return observation.status;
}

/**
 * Three checksum-verified live passes activate a sticky numerical-parity
 * release gate. Unavailable evidence is not an observation of model failure:
 * it neither advances nor resets the pre-enforcement streak. Every available
 * non-pass resets it. Once latched, anything except a current pass blocks.
 */
export function evaluateLiveNumericalParityRollout(input: {
  observations: readonly LiveNumericalParityRolloutObservation[];
  enforcementLatchActive?: boolean;
  currentRotationId?: string | null;
}): LiveNumericalParityRolloutEvaluation {
  const ordered = [...input.observations].sort(
    (left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
      left.rotationId.localeCompare(right.rotationId),
  );
  const seenIds = new Set<string>();
  for (const observation of ordered) {
    if (seenIds.has(observation.rotationId)) {
      throw new Error(
        `Duplicate live numerical parity rotationId "${observation.rotationId}" was rejected.`,
      );
    }
    seenIds.add(observation.rotationId);
  }

  let consecutivePasses = 0;
  let enforcementActivatedAtRotationId: string | null = null;
  let latestStatus: LiveNumericalParityRolloutEvaluation["latestStatus"] =
    "missing";
  for (const observation of ordered) {
    const status = observationStatus(observation);
    latestStatus = status;
    if (status === "pass") {
      consecutivePasses += 1;
      if (
        enforcementActivatedAtRotationId === null &&
        consecutivePasses >=
          LIVE_NUMERICAL_PARITY_REQUIRED_CONSECUTIVE_PASSES
      ) {
        enforcementActivatedAtRotationId = observation.rotationId;
      }
    } else if (status !== "unavailable") {
      consecutivePasses = 0;
    }
  }

  const enforcementLatchActive =
    input.enforcementLatchActive === true;
  const enforcementActive =
    enforcementLatchActive ||
    enforcementActivatedAtRotationId !== null;
  const reasons: string[] = [];
  const requiredCurrentRotationId =
    input.currentRotationId?.trim() || null;
  if (
    input.currentRotationId !== undefined &&
    input.currentRotationId !== null &&
    requiredCurrentRotationId === null
  ) {
    throw new Error(
      "Live numerical parity rollout current rotation ID cannot be blank.",
    );
  }
  if (requiredCurrentRotationId !== null) {
    const current = ordered.find(
      (observation) =>
        observation.rotationId === requiredCurrentRotationId,
    );
    latestStatus = current ? observationStatus(current) : "missing";
  } else if (enforcementLatchActive) {
    latestStatus = "missing";
  }
  let releaseGate: LiveNumericalParityRolloutEvaluation["releaseGate"] =
    "observe";
  if (enforcementActive) {
    releaseGate = latestStatus === "pass" ? "pass" : "block";
    if (latestStatus === "missing") {
      reasons.push(
        requiredCurrentRotationId === null
          ? "Live numerical parity enforcement is durably latched, but no required current rotation ID was supplied."
          : "Live numerical parity enforcement is durably latched, but no current checksum-verified certificate is available.",
      );
    } else if (latestStatus === "unavailable") {
      reasons.push(
        "Live numerical parity enforcement is active, but the current certificate is unavailable; release is blocked without treating the outage as model drift.",
      );
    } else if (latestStatus !== "pass") {
      reasons.push(
        `Live numerical parity enforcement is active and the current certificate is ${latestStatus}.`,
      );
    }
  } else {
    reasons.push(
      `Live numerical parity remains observational until ${LIVE_NUMERICAL_PARITY_REQUIRED_CONSECUTIVE_PASSES} successful live rotations have been recorded; ${consecutivePasses} currently qualify.`,
    );
  }
  return {
    schemaVersion: 1,
    evaluationKind: "live-numerical-parity-rollout",
    requiredConsecutivePasses:
      LIVE_NUMERICAL_PARITY_REQUIRED_CONSECUTIVE_PASSES,
    acceptedObservationCount: ordered.length,
    consecutivePasses,
    enforcementLatchActive,
    requiredCurrentRotationId,
    enforcementActivatedAtRotationId,
    enforcementActive,
    latestRotationId:
      requiredCurrentRotationId === null
        ? ordered.at(-1)?.rotationId ?? null
        : ordered.some(
              (observation) =>
                observation.rotationId === requiredCurrentRotationId,
            )
          ? requiredCurrentRotationId
          : null,
    latestStatus,
    releaseGate,
    reasons,
  };
}
