import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../../lib/rosterpilot";
import type { TesseraSimulationProviderIdentity } from "../../lib/rosterpilot";
import {
  type PersonalLocalParityRotationRecordV1,
  sealPersonalLocalParityRotationRecordV1,
  writePersonalLocalParityRotationRecordV1,
} from "./personal-local-attestation-store";
import {
  type TesseraParityCoveringSuiteV2,
  verifyTesseraParityCoveringSuiteV2,
} from "./provider-parity-covering-suite-v2";
import type {
  TesseraProviderParityWorkflowArtifact,
  TesseraProviderParityWorkflowExactV2,
} from "./provider-parity-workflow";
import { verifyTesseraProviderParityResultV2 } from "./provider-parity-v2";

const SHA256 = /^[0-9a-f]{64}$/;

export type PersonalParityRotationComparisonV1 = {
  artifact: TesseraProviderParityWorkflowArtifact;
  machineIdSha256: string;
  source?: string;
};

export type PersonalParityRotationAggregateV1 = {
  coveringSuiteSha256: string;
  caseIds: string[];
  aggregateExactReceiptSha256: string;
  aggregateParityResultSha256: string;
  localProviderIdentitySha256: string;
  websiteProviderIdentitySha256: string;
  bundleId: string;
  record: PersonalLocalParityRotationRecordV1;
};

export class PersonalParityRotationAggregateError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersonalParityRotationAggregateError";
    this.code = code;
  }
}

function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" &&
    !Array.isArray(value);
}

function exactBindingCore(
  value: TesseraProviderParityWorkflowExactV2,
): Omit<TesseraProviderParityWorkflowExactV2, "exactBindingSha256"> {
  const core = structuredClone(value) as Partial<
    TesseraProviderParityWorkflowExactV2
  >;
  delete core.exactBindingSha256;
  return core as Omit<
    TesseraProviderParityWorkflowExactV2,
    "exactBindingSha256"
  >;
}

function providerSource(
  artifact: TesseraProviderParityWorkflowArtifact,
  provider: "local-engine" | "website",
): TesseraProviderParityWorkflowArtifact["sourceReports"][number] {
  const matches = Array.isArray(artifact.sourceReports)
    ? artifact.sourceReports.filter(
    (source) => source.provider === provider,
    )
    : [];
  if (matches.length !== 1) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_PROVIDER_INVALID",
      `Comparison evidence requires exactly one ${provider} source report.`,
    );
  }
  const source = matches[0]!;
  if (
    !isRecord(source.executionEvidence) ||
    !isRecord(source.executionEvidence.providerIdentity) ||
    !SHA256.test(source.receiptSha256) ||
    !SHA256.test(source.executionEvidence.providerIdentitySha256) ||
    digest(source.executionEvidence.providerIdentity) !==
      source.executionEvidence.providerIdentitySha256
  ) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_PROVIDER_INVALID",
      `Comparison evidence has an invalid ${provider} provider or receipt identity.`,
    );
  }
  return source;
}

function assertProviderIdentity(
  identity: TesseraSimulationProviderIdentity,
  provider: "local-engine" | "website",
): void {
  if (identity.provider !== provider) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_PROVIDER_INVALID",
      `The ${provider} source contains the wrong provider identity.`,
    );
  }
}

function comparisonCase(input: {
  comparison: PersonalParityRotationComparisonV1;
  suite: TesseraParityCoveringSuiteV2;
  expectedMachineIdSha256: string;
}): {
  caseId: string;
  pairedExactReceiptsSha256: string;
  parityResultSha256: string;
  localProviderIdentitySha256: string;
  websiteProviderIdentitySha256: string;
  bundleId: string;
} {
  const { artifact } = input.comparison;
  const sourceLabel = input.comparison.source
    ? ` "${input.comparison.source}"`
    : "";
  if (
    artifact?.schemaVersion !== 1 ||
    artifact.kind !== "tessera-provider-parity-comparison"
  ) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_COMPARISON_INVALID",
      `Personal parity rejected comparison${sourceLabel}: it is not a provider-parity workflow artifact.`,
    );
  }
  if (
    input.comparison.machineIdSha256 !== input.expectedMachineIdSha256 ||
    !SHA256.test(input.comparison.machineIdSha256)
  ) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_MACHINE_MISMATCH",
      `Personal parity rejected comparison${sourceLabel}: its machine binding does not match this rotation.`,
    );
  }
  const exact = artifact.exactParityV2;
  if (
    !exact ||
    !SHA256.test(exact.exactBindingSha256) ||
    digest(exactBindingCore(exact)) !== exact.exactBindingSha256 ||
    exact.status !== "complete" ||
    exact.personalAttestationEligible !== true ||
    !exact.result ||
    !verifyTesseraProviderParityResultV2(exact.result) ||
    exact.result.outcome !== "pass" ||
    exact.result.eligible !== true ||
    exact.result.complete !== true ||
    !exact.result.contractBinding
  ) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_COMPARISON_INVALID",
      `Personal parity rejected comparison${sourceLabel}: exact provider-parity v2 evidence is invalid, incomplete, non-passing, or has a bad self-hash.`,
    );
  }
  const binding = exact.result.contractBinding;
  if (binding.coveringSuiteSha256 !== input.suite.suiteSha256) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_SUITE_MISMATCH",
      `Personal parity rejected comparison${sourceLabel}: it binds a different covering suite.`,
    );
  }
  if (!input.suite.cases.some((entry) => entry.caseId === binding.coveringCaseId)) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_EXTRA_CASE",
      `Personal parity rejected comparison${sourceLabel}: case "${binding.coveringCaseId}" is not in the covering suite.`,
    );
  }

  const local = providerSource(artifact, "local-engine");
  const website = providerSource(artifact, "website");
  assertProviderIdentity(
    local.executionEvidence.providerIdentity,
    "local-engine",
  );
  assertProviderIdentity(
    website.executionEvidence.providerIdentity,
    "website",
  );
  const recomputedReceiptSha256 = digest([
    { provider: "local-engine", receiptSha256: local.receiptSha256 },
    { provider: "website", receiptSha256: website.receiptSha256 },
  ]);
  if (
    !SHA256.test(exact.pairedExactReceiptsSha256) ||
    exact.pairedExactReceiptsSha256 !== recomputedReceiptSha256
  ) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_RECEIPT_INVALID",
      `Personal parity rejected comparison${sourceLabel}: its paired exact-receipt identity is invalid.`,
    );
  }
  const localIdentity = exact.result.comparison.localIdentity;
  const websiteIdentity = exact.result.comparison.websiteIdentity;
  if (
    !localIdentity ||
    !websiteIdentity ||
    localIdentity.provider !== "local-engine" ||
    websiteIdentity.provider !== "website" ||
    localIdentity.providerIdentity !==
      local.executionEvidence.providerIdentitySha256 ||
    websiteIdentity.providerIdentity !==
      website.executionEvidence.providerIdentitySha256 ||
    localIdentity.dataBundleId !== websiteIdentity.dataBundleId ||
    !SHA256.test(localIdentity.dataBundleId)
  ) {
    throw new PersonalParityRotationAggregateError(
      localIdentity?.dataBundleId !== websiteIdentity?.dataBundleId
        ? "PERSONAL_PARITY_AGGREGATE_BUNDLE_MISMATCH"
        : "PERSONAL_PARITY_AGGREGATE_PROVIDER_INVALID",
      `Personal parity rejected comparison${sourceLabel}: provider identities and data bundle are not bound consistently to the exact result.`,
    );
  }
  return {
    caseId: binding.coveringCaseId,
    pairedExactReceiptsSha256: exact.pairedExactReceiptsSha256,
    parityResultSha256: exact.result.resultSha256,
    localProviderIdentitySha256:
      local.executionEvidence.providerIdentitySha256,
    websiteProviderIdentitySha256:
      website.executionEvidence.providerIdentitySha256,
    bundleId: localIdentity.dataBundleId,
  };
}

export function aggregatePersonalLocalParityRotationV1(input: {
  coveringSuite: TesseraParityCoveringSuiteV2;
  comparisons: readonly PersonalParityRotationComparisonV1[];
  machineIdSha256: string;
  rotationId: string;
  mode: "observe" | "enforce";
  completedAt?: string;
  verifiedAt?: string;
}): PersonalParityRotationAggregateV1 {
  if (
    !isRecord(input.coveringSuite) ||
    !SHA256.test(input.coveringSuite.suiteSha256) ||
    !verifyTesseraParityCoveringSuiteV2(input.coveringSuite)
  ) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_SUITE_INVALID",
      "Personal parity requires a valid, self-hashed covering-suite-v2 artifact.",
    );
  }
  if (!SHA256.test(input.machineIdSha256)) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_MACHINE_MISMATCH",
      "Personal parity requires one valid local machine binding.",
    );
  }
  const cases = input.comparisons.map((comparison) => {
    try {
      return comparisonCase({
        comparison,
        suite: input.coveringSuite,
        expectedMachineIdSha256: input.machineIdSha256,
      });
    } catch (error) {
      if (error instanceof PersonalParityRotationAggregateError) {
        throw error;
      }
      throw new PersonalParityRotationAggregateError(
        "PERSONAL_PARITY_AGGREGATE_COMPARISON_INVALID",
        `Personal parity rejected comparison${comparison.source ? ` "${comparison.source}"` : ""}: its exact provider-parity evidence is malformed.`,
        { cause: error },
      );
    }
  });
  const caseIds = cases.map((entry) => entry.caseId);
  const duplicateCaseId = caseIds.find(
    (caseId, index) => caseIds.indexOf(caseId) !== index,
  );
  if (duplicateCaseId) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_DUPLICATE_CASE",
      `Personal parity received more than one comparison for covering case "${duplicateCaseId}".`,
    );
  }
  const expectedCaseIds = input.coveringSuite.cases
    .map((entry) => entry.caseId)
    .sort();
  const actualCaseIds = [...caseIds].sort();
  const missing = expectedCaseIds.filter(
    (caseId) => !actualCaseIds.includes(caseId),
  );
  if (missing.length > 0) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_MISSING_CASE",
      `Personal parity is missing comparison(s) for covering case(s): ${missing.join(", ")}.`,
    );
  }
  if (actualCaseIds.length !== expectedCaseIds.length) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_EXTRA_CASE",
      "Personal parity received comparisons outside the exact covering suite.",
    );
  }
  const first = cases[0];
  if (!first) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_MISSING_CASE",
      "Personal parity requires one passing comparison per covering-suite case.",
    );
  }
  for (const entry of cases.slice(1)) {
    if (
      entry.bundleId !== first.bundleId ||
      entry.localProviderIdentitySha256 !==
        first.localProviderIdentitySha256 ||
      entry.websiteProviderIdentitySha256 !==
        first.websiteProviderIdentitySha256
    ) {
      throw new PersonalParityRotationAggregateError(
        entry.bundleId !== first.bundleId
          ? "PERSONAL_PARITY_AGGREGATE_BUNDLE_MISMATCH"
          : "PERSONAL_PARITY_AGGREGATE_PROVIDER_MISMATCH",
        "All comparisons in one personal parity rotation must bind the same data bundle and local/Web provider identities.",
      );
    }
  }
  const ordered = [...cases].sort((left, right) =>
    left.caseId.localeCompare(right.caseId)
  );
  const aggregateExactReceiptSha256 = digest({
    schemaVersion: 1,
    kind: "rosterpilot-personal-parity-aggregate-exact-receipts",
    coveringSuiteSha256: input.coveringSuite.suiteSha256,
    cases: ordered.map((entry) => ({
      caseId: entry.caseId,
      pairedExactReceiptsSha256: entry.pairedExactReceiptsSha256,
    })),
  });
  const aggregateParityResultSha256 = digest({
    schemaVersion: 1,
    kind: "rosterpilot-personal-parity-aggregate-results",
    coveringSuiteSha256: input.coveringSuite.suiteSha256,
    cases: ordered.map((entry) => ({
      caseId: entry.caseId,
      resultSha256: entry.parityResultSha256,
    })),
  });
  const completedAt = input.completedAt ?? new Date().toISOString();
  const record = sealPersonalLocalParityRotationRecordV1({
    machineIdSha256: input.machineIdSha256,
    providerIdentitySha256: first.localProviderIdentitySha256,
    bundleId: first.bundleId,
    rotation: {
      rotationId: input.rotationId,
      mode: input.mode,
      outcome: "pass",
      exactReceiptSha256: aggregateExactReceiptSha256,
      coverageSuiteSha256: input.coveringSuite.suiteSha256,
      completedAt,
    },
    parityResultSha256: aggregateParityResultSha256,
    verifiedAt: input.verifiedAt ?? completedAt,
  });
  return {
    coveringSuiteSha256: input.coveringSuite.suiteSha256,
    caseIds: ordered.map((entry) => entry.caseId),
    aggregateExactReceiptSha256,
    aggregateParityResultSha256,
    localProviderIdentitySha256: first.localProviderIdentitySha256,
    websiteProviderIdentitySha256: first.websiteProviderIdentitySha256,
    bundleId: first.bundleId,
    record,
  };
}

async function readJson(filename: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new PersonalParityRotationAggregateError(
      "PERSONAL_PARITY_AGGREGATE_ARTIFACT_INVALID",
      `Personal parity could not read valid JSON from "${filename}".`,
      { cause: error },
    );
  }
}

export async function createPersonalLocalParityRotationFromFilesV1(input: {
  coveringSuitePath: string;
  comparisonPaths: readonly string[];
  machineIdSha256: string;
  rotationId: string;
  mode: "observe" | "enforce";
  recordPath: string;
  completedAt?: string;
  verifiedAt?: string;
  overwrite?: boolean;
}): Promise<PersonalParityRotationAggregateV1 & { recordPath: string }> {
  const suitePath = path.resolve(input.coveringSuitePath);
  const comparisonPaths = input.comparisonPaths.map((filename) =>
    path.resolve(filename)
  );
  const [coveringSuite, ...artifacts] = await Promise.all([
    readJson(suitePath),
    ...comparisonPaths.map(readJson),
  ]);
  const aggregate = aggregatePersonalLocalParityRotationV1({
    coveringSuite: coveringSuite as TesseraParityCoveringSuiteV2,
    comparisons: artifacts.map((artifact, index) => ({
      artifact: artifact as TesseraProviderParityWorkflowArtifact,
      machineIdSha256: input.machineIdSha256,
      source: comparisonPaths[index],
    })),
    machineIdSha256: input.machineIdSha256,
    rotationId: input.rotationId,
    mode: input.mode,
    completedAt: input.completedAt,
    verifiedAt: input.verifiedAt,
  });
  const recordPath = await writePersonalLocalParityRotationRecordV1({
    record: aggregate.record,
    filename: input.recordPath,
    overwrite: input.overwrite,
  });
  return { ...aggregate, recordPath };
}
