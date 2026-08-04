import crypto from "node:crypto";

import { canonicalJson } from "../../lib/rosterpilot";
import {
  verifyTesseraParityCoveringSuiteV2,
  type TesseraParityCoveringSuiteV2,
} from "./provider-parity-covering-suite-v2";

const SHA256 = /^[0-9a-f]{64}$/;

export type PersonalLocalParityRotationV1 = {
  rotationId: string;
  mode: "observe" | "enforce";
  outcome: "pass" | "fail";
  exactReceiptSha256: string;
  coverageSuiteSha256: string;
  completedAt: string;
};

export type PersonalLocalParityAttestationV1 = {
  schemaVersion: 1;
  kind: "rosterpilot-personal-local-parity-attestation";
  scope: "single-user-single-machine";
  machineIdSha256: string;
  providerIdentitySha256: string;
  bundleId: string;
  dataProviderMode: "local-source";
  rotations: PersonalLocalParityRotationV1[];
  createdAt: string;
  attestationSha256: string;
};

export type PersonalLocalParityEvaluationV1 = {
  active: boolean;
  reasonCodes: string[];
  qualifyingObservationPasses: number;
  enforcedPass: boolean;
};

export type PersonalLocalParityAttestationContextV1 = {
  attestation: PersonalLocalParityAttestationV1 | null | undefined;
  machineIdSha256: string;
  providerIdentitySha256: string;
  bundleId: string;
  coverageSuiteSha256: string;
  coveringSuite?: TesseraParityCoveringSuiteV2 | null;
  coveringSuiteIssueCode?:
    | "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISSING"
    | "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_INVALID"
    | "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISMATCH"
    | null;
};

function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function core(
  attestation: PersonalLocalParityAttestationV1,
): Omit<PersonalLocalParityAttestationV1, "attestationSha256"> {
  const { attestationSha256, ...value } = attestation;
  void attestationSha256;
  return value;
}

function validIsoDate(value: string): boolean {
  return Boolean(value && !Number.isNaN(Date.parse(value)));
}

export function createPersonalLocalParityAttestationV1(input: {
  machineIdSha256: string;
  providerIdentitySha256: string;
  bundleId: string;
  rotations: PersonalLocalParityRotationV1[];
  createdAt?: string;
}): PersonalLocalParityAttestationV1 {
  const value = {
    schemaVersion: 1 as const,
    kind: "rosterpilot-personal-local-parity-attestation" as const,
    scope: "single-user-single-machine" as const,
    machineIdSha256: input.machineIdSha256,
    providerIdentitySha256: input.providerIdentitySha256,
    bundleId: input.bundleId,
    dataProviderMode: "local-source" as const,
    rotations: structuredClone(input.rotations),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return { ...value, attestationSha256: digest(value) };
}

export function evaluatePersonalLocalParityAttestationV1(
  input: PersonalLocalParityAttestationContextV1,
): PersonalLocalParityEvaluationV1 {
  const reasons = new Set<string>();
  const attestation = input.attestation;
  if (!attestation) {
    return {
      active: false,
      reasonCodes: ["PERSONAL_LOCAL_ATTESTATION_MISSING"],
      qualifyingObservationPasses: 0,
      enforcedPass: false,
    };
  }
  if (
    attestation.schemaVersion !== 1 ||
    attestation.kind !==
      "rosterpilot-personal-local-parity-attestation" ||
    attestation.scope !== "single-user-single-machine" ||
    attestation.dataProviderMode !== "local-source"
  ) {
    reasons.add("PERSONAL_LOCAL_ATTESTATION_CONTRACT_INVALID");
  }
  if (
    !SHA256.test(attestation.attestationSha256) ||
    digest(core(attestation)) !== attestation.attestationSha256
  ) {
    reasons.add("PERSONAL_LOCAL_ATTESTATION_HASH_INVALID");
  }
  if (
    !SHA256.test(input.machineIdSha256) ||
    attestation.machineIdSha256 !== input.machineIdSha256
  ) {
    reasons.add("PERSONAL_LOCAL_ATTESTATION_MACHINE_MISMATCH");
  }
  if (
    !SHA256.test(input.providerIdentitySha256) ||
    attestation.providerIdentitySha256 !== input.providerIdentitySha256
  ) {
    reasons.add("PERSONAL_LOCAL_ATTESTATION_PROVIDER_MISMATCH");
  }
  if (!SHA256.test(input.bundleId) || attestation.bundleId !== input.bundleId) {
    reasons.add("PERSONAL_LOCAL_ATTESTATION_BUNDLE_MISMATCH");
  }
  if (!validIsoDate(attestation.createdAt)) {
    reasons.add("PERSONAL_LOCAL_ATTESTATION_TIME_INVALID");
  }
  if (input.coveringSuiteIssueCode) {
    reasons.add(input.coveringSuiteIssueCode);
  }
  let coveringSuiteVerified = false;
  if (input.coveringSuite) {
    try {
      coveringSuiteVerified =
        verifyTesseraParityCoveringSuiteV2(input.coveringSuite);
    } catch {
      coveringSuiteVerified = false;
    }
  }
  if (!input.coveringSuite) {
    reasons.add(
      input.coveringSuiteIssueCode ??
        "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISSING",
    );
  } else if (!coveringSuiteVerified) {
    reasons.add(
      "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_INVALID",
    );
  } else if (
    input.coveringSuite.suiteSha256 !== input.coverageSuiteSha256
  ) {
    reasons.add(
      "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISMATCH",
    );
  }

  const rotationIds = new Set<string>();
  let chronology = Number.NEGATIVE_INFINITY;
  for (const rotation of attestation.rotations) {
    if (!rotation.rotationId || rotationIds.has(rotation.rotationId)) {
      reasons.add("PERSONAL_LOCAL_ATTESTATION_ROTATION_DUPLICATE");
    }
    rotationIds.add(rotation.rotationId);
    if (
      !SHA256.test(rotation.exactReceiptSha256) ||
      !SHA256.test(rotation.coverageSuiteSha256)
    ) {
      reasons.add("PERSONAL_LOCAL_ATTESTATION_RECEIPT_INVALID");
    }
    if (rotation.coverageSuiteSha256 !== input.coverageSuiteSha256) {
      reasons.add("PERSONAL_LOCAL_ATTESTATION_SUITE_MISMATCH");
    }
    const timestamp = Date.parse(rotation.completedAt);
    if (!Number.isFinite(timestamp) || timestamp <= chronology) {
      reasons.add("PERSONAL_LOCAL_ATTESTATION_ROTATION_ORDER_INVALID");
    }
    chronology = timestamp;
  }

  const trailing = attestation.rotations.slice(-4);
  const observations = trailing.slice(0, 3);
  const enforcement = trailing[3];
  const qualifyingObservationPasses = observations.filter(
    (rotation) =>
      rotation.mode === "observe" &&
      rotation.outcome === "pass" &&
      rotation.coverageSuiteSha256 === input.coverageSuiteSha256,
  ).length;
  const enforcedPass = Boolean(
    enforcement?.mode === "enforce" &&
      enforcement.outcome === "pass" &&
      enforcement.coverageSuiteSha256 === input.coverageSuiteSha256,
  );
  if (
    trailing.length !== 4 ||
    qualifyingObservationPasses !== 3
  ) {
    reasons.add("PERSONAL_LOCAL_ATTESTATION_THREE_PASSES_REQUIRED");
  }
  if (!enforcedPass) {
    reasons.add("PERSONAL_LOCAL_ATTESTATION_ENFORCED_PASS_REQUIRED");
  }

  return {
    active: reasons.size === 0,
    reasonCodes: [...reasons].sort(),
    qualifyingObservationPasses,
    enforcedPass,
  };
}

export function personalLocalProviderIdentitySha256(
  identity: unknown,
): string {
  return digest(identity);
}
