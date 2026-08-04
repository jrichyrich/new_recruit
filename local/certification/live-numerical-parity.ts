import crypto from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  TesseraMatchupReport,
  TesseraMetric,
  TesseraProviderCompatibilityEnvelope,
  TesseraSimulationProviderIdentity,
} from "../../lib/rosterpilot/types";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import { TESSERA_WEBSITE_ADAPTER_VERSION } from "../tessera/browser";
import {
  exactReportReceiptPath,
  verifyExactReportReceipt,
} from "../tessera/exact-report-integrity";
import {
  LOCAL_TESSERA_ADAPTER_VERSION,
  LOCAL_TESSERA_COMPILER_VERSION,
} from "../tessera/local-engine";
import {
  compareTesseraProviderParity,
  TESSERA_PROVIDER_PARITY_CANONICAL_WINNER_ID,
  TESSERA_PROVIDER_PARITY_POLICY,
  type TesseraParityProvider,
  type TesseraProviderParityMetricSummary,
  type TesseraProviderParityResult,
  type TesseraProviderParityWinnerComparison,
} from "../tessera/provider-parity";
import { adaptReportBoundTesseraMatchupReportToProviderParityRun } from "../tessera/provider-parity-report-adapter";
import type { TesseraProviderParityWorkflowArtifact } from "../tessera/provider-parity-workflow";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const FIXTURE_MARKER_PATTERN = /(?:^|[^a-z])(fixture|mock|synthetic|recorded)(?:[^a-z]|$)/i;
const MAX_COMPARISON_BYTES = 64 * 1_024 * 1_024;
const MAX_SOURCE_REPORT_BYTES = 128 * 1_024 * 1_024;
const MAX_RECEIPT_BYTES = 64 * 1_024;
const MAX_CERTIFICATION_BYTES = 4 * 1_024 * 1_024;
const MAX_CHECKSUM_BYTES = 512;
const MAX_PORTABLE_REPORT_FILES = 10_000;
const MAX_PORTABLE_REPORT_BYTES = 2 * 1_024 * 1_024 * 1_024;

export const LIVE_NUMERICAL_PARITY_POLICY = {
  id: "tessera-live-numerical-parity-v1",
  requiredMetrics: [
    "wipe-probability",
    "half-wipe-probability",
    "mean-kills",
    "mean-damage",
  ] as const satisfies readonly TesseraMetric[],
  minimumPerMetricPassRate:
    TESSERA_PROVIDER_PARITY_POLICY.minimumMetricPassRate,
  maximumToleranceMultiple:
    TESSERA_PROVIDER_PARITY_POLICY.maximumToleranceMultiple,
  maximumBeyondDoubleToleranceCells: 0,
  canonicalWinnerId: TESSERA_PROVIDER_PARITY_CANONICAL_WINNER_ID,
  requiresLiveExecutionEvidence: true,
} as const;

export type LiveNumericalParityCertificationStatus =
  | "pass"
  | "fail"
  | "incomplete"
  | "ineligible"
  | "unavailable";

export type LiveNumericalParityReasonCategory =
  | "availability"
  | "integrity"
  | "eligibility"
  | "completeness"
  | "policy";

export type LiveNumericalParityReasonCode =
  | "COMPARISON_UNAVAILABLE"
  | "COMPARISON_RECEIPT_INVALID"
  | "COMPARISON_SCHEMA_INVALID"
  | "COMPARISON_DERIVATION_MISMATCH"
  | "SOURCE_REPORT_UNAVAILABLE"
  | "SOURCE_REPORT_RECEIPT_INVALID"
  | "SOURCE_REPORT_BINDING_MISMATCH"
  | "EXPECTED_BUNDLE_ID_MISMATCH"
  | "EXPECTED_GIT_HEAD_MISMATCH"
  | "LIVE_EXECUTION_EVIDENCE_INELIGIBLE"
  | "FIXTURE_ONLY_EVIDENCE"
  | "PARITY_INELIGIBLE"
  | "PARITY_INCOMPLETE"
  | "METRIC_SET_INCOMPLETE"
  | "METRIC_PASS_RATE_BELOW_98_PERCENT"
  | "CELL_BEYOND_DOUBLE_TOLERANCE"
  | "CANONICAL_WINNER_INCOMPLETE"
  | "CANONICAL_WINNER_MISMATCH"
  | "PARITY_OUTCOME_INCONSISTENT";

export type LiveNumericalParityReason = {
  category: LiveNumericalParityReasonCategory;
  code: LiveNumericalParityReasonCode;
  message: string;
  provider: TesseraParityProvider | null;
  metric: TesseraMetric | null;
};

export type LiveNumericalParitySourceEvidence = {
  provider: TesseraParityProvider;
  reportPath: string;
  receiptPath: string;
  reportSha256: string;
  receiptSha256: string;
  runId: string;
  reportSource: TesseraMatchupReport["source"];
  runtimeIdentitySha256: string | null;
  providerIdentitySha256: string | null;
  providerCompatibilityEnvelopeSha256: string | null;
  evidenceKind: "live" | "fixture-only" | "ineligible";
  complete: boolean;
  issueCodes: LiveNumericalParityReasonCode[];
};

export type LiveNumericalParityMetricEvidence = {
  metric: TesseraMetric;
  expectedCellCount: number;
  comparedCellCount: number;
  withinToleranceCount: number;
  withinToleranceRate: number;
  beyondDoubleToleranceCount: number;
  status: "pass" | "fail" | "incomplete";
};

export type LiveNumericalParityWinnerEvidence = {
  classificationId: string;
  localWinner: "player" | "opponent" | "tie" | null;
  websiteWinner: "player" | "opponent" | "tie" | null;
  uncertaintyBoundary: boolean;
  status: "pass" | "fail" | "incomplete";
};

export type LiveNumericalParityEvaluationInput = {
  comparisonAvailable: boolean;
  comparisonIntegrityValid: boolean;
  sourceReportsAvailable: boolean;
  sourceBindingsValid: boolean;
  liveEvidenceComplete: boolean;
  fixtureOnlyEvidence: boolean;
  releaseBindingMatches?: boolean;
  parityOutcome: TesseraProviderParityResult["outcome"] | null;
  parityEligible: boolean;
  parityComplete: boolean;
  metricSummaries: readonly LiveNumericalParityMetricEvidence[];
  winnerClassifications: readonly LiveNumericalParityWinnerEvidence[];
  initialReasons?: readonly LiveNumericalParityReason[];
};

export type LiveNumericalParityEvaluation = {
  status: LiveNumericalParityCertificationStatus;
  eligible: boolean;
  complete: boolean;
  liveEvidence: boolean;
  parityOutcome: TesseraProviderParityResult["outcome"] | null;
  allRequiredMetricsPresent: boolean;
  everyMetricAtLeast98Percent: boolean;
  beyondDoubleToleranceCellCount: number;
  canonicalWinnerAgreementOutsideUncertainty: boolean;
  metricSummaries: LiveNumericalParityMetricEvidence[];
  winnerClassifications: LiveNumericalParityWinnerEvidence[];
  reasons: LiveNumericalParityReason[];
};

export type LiveNumericalParityCertificationArtifact = {
  schemaVersion: 1;
  reportKind: "rosterpilot-live-numerical-parity-certification";
  reportId: string;
  rotationId: string | null;
  generatedAt: string;
  comparison: {
    path: string;
    checksumPath: string;
    sha256: string | null;
    checksumSha256: string | null;
  };
  releaseBinding: {
    expectedBundleId: string | null;
    observedBundleIds: string[];
    expectedGitHead: string | null;
    observedGitHeads: string[];
    matched: boolean;
  };
  sourceReports: LiveNumericalParitySourceEvidence[];
  policy: typeof LIVE_NUMERICAL_PARITY_POLICY;
  evaluation: LiveNumericalParityEvaluation;
};

export type WrittenLiveNumericalParityCertification = {
  artifact: LiveNumericalParityCertificationArtifact;
  reportPath: string;
  checksumPath: string;
  sha256: string;
};

type VerifiedFile = {
  path: string;
  bytes: Buffer;
  text: string;
  sha256: string;
};

type VerifiedComparison = {
  artifact: TesseraProviderParityWorkflowArtifact;
  file: VerifiedFile;
  receiptPath: string;
  receiptSha256: string;
};

type VerifiedSourceReport = {
  provider: TesseraParityProvider;
  report: TesseraMatchupReport;
  reportFile: VerifiedFile;
  receiptFile: VerifiedFile;
  compatibilityEnvelope: TesseraProviderCompatibilityEnvelope | null;
};

const ReasonSchema = z
  .object({
    category: z.enum([
      "availability",
      "integrity",
      "eligibility",
      "completeness",
      "policy",
    ]),
    code: z.enum([
      "COMPARISON_UNAVAILABLE",
      "COMPARISON_RECEIPT_INVALID",
      "COMPARISON_SCHEMA_INVALID",
      "COMPARISON_DERIVATION_MISMATCH",
      "SOURCE_REPORT_UNAVAILABLE",
      "SOURCE_REPORT_RECEIPT_INVALID",
      "SOURCE_REPORT_BINDING_MISMATCH",
      "EXPECTED_BUNDLE_ID_MISMATCH",
      "EXPECTED_GIT_HEAD_MISMATCH",
      "LIVE_EXECUTION_EVIDENCE_INELIGIBLE",
      "FIXTURE_ONLY_EVIDENCE",
      "PARITY_INELIGIBLE",
      "PARITY_INCOMPLETE",
      "METRIC_SET_INCOMPLETE",
      "METRIC_PASS_RATE_BELOW_98_PERCENT",
      "CELL_BEYOND_DOUBLE_TOLERANCE",
      "CANONICAL_WINNER_INCOMPLETE",
      "CANONICAL_WINNER_MISMATCH",
      "PARITY_OUTCOME_INCONSISTENT",
    ]),
    message: z.string().min(1),
    provider: z.enum(["local-engine", "website"]).nullable(),
    metric: z
      .enum([
        "wipe-probability",
        "half-wipe-probability",
        "mean-kills",
        "mean-damage",
      ])
      .nullable(),
  })
  .strict();

const MetricEvidenceSchema = z
  .object({
    metric: z.enum([
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ]),
    expectedCellCount: z.number().int().nonnegative(),
    comparedCellCount: z.number().int().nonnegative(),
    withinToleranceCount: z.number().int().nonnegative(),
    withinToleranceRate: z.number().finite().min(0).max(1),
    beyondDoubleToleranceCount: z.number().int().nonnegative(),
    status: z.enum(["pass", "fail", "incomplete"]),
  })
  .strict();

const WinnerEvidenceSchema = z
  .object({
    classificationId: z.string().min(1),
    localWinner: z.enum(["player", "opponent", "tie"]).nullable(),
    websiteWinner: z.enum(["player", "opponent", "tie"]).nullable(),
    uncertaintyBoundary: z.boolean(),
    status: z.enum(["pass", "fail", "incomplete"]),
  })
  .strict();

const SourceEvidenceSchema = z
  .object({
    provider: z.enum(["local-engine", "website"]),
    reportPath: z.string().min(1),
    receiptPath: z.string().min(1),
    reportSha256: z.string().regex(SHA256_PATTERN),
    receiptSha256: z.string().regex(SHA256_PATTERN),
    runId: z.string().min(1),
    reportSource: z.enum([
      "prepare-only",
      "tessera-ui",
      "tessera-ui-failed",
      "tessera-local-engine",
      "tessera-local-engine-failed",
      "handoff-only",
    ]),
    runtimeIdentitySha256: z.string().regex(SHA256_PATTERN).nullable(),
    providerIdentitySha256: z.string().regex(SHA256_PATTERN).nullable(),
    providerCompatibilityEnvelopeSha256: z
      .string()
      .regex(SHA256_PATTERN)
      .nullable(),
    evidenceKind: z.enum(["live", "fixture-only", "ineligible"]),
    complete: z.boolean(),
    issueCodes: z.array(ReasonSchema.shape.code),
  })
  .strict();

const PolicySchema = z
  .object({
    id: z.literal(LIVE_NUMERICAL_PARITY_POLICY.id),
    requiredMetrics: z.tuple([
      z.literal("wipe-probability"),
      z.literal("half-wipe-probability"),
      z.literal("mean-kills"),
      z.literal("mean-damage"),
    ]),
    minimumPerMetricPassRate: z.literal(0.98),
    maximumToleranceMultiple: z.literal(2),
    maximumBeyondDoubleToleranceCells: z.literal(0),
    canonicalWinnerId: z.literal(TESSERA_PROVIDER_PARITY_CANONICAL_WINNER_ID),
    requiresLiveExecutionEvidence: z.literal(true),
  })
  .strict();

const EvaluationSchema = z
  .object({
    status: z.enum([
      "pass",
      "fail",
      "incomplete",
      "ineligible",
      "unavailable",
    ]),
    eligible: z.boolean(),
    complete: z.boolean(),
    liveEvidence: z.boolean(),
    parityOutcome: z
      .enum(["pass", "fail", "incomplete", "ineligible"])
      .nullable(),
    allRequiredMetricsPresent: z.boolean(),
    everyMetricAtLeast98Percent: z.boolean(),
    beyondDoubleToleranceCellCount: z.number().int().nonnegative(),
    canonicalWinnerAgreementOutsideUncertainty: z.boolean(),
    metricSummaries: z.array(MetricEvidenceSchema),
    winnerClassifications: z.array(WinnerEvidenceSchema),
    reasons: z.array(ReasonSchema),
  })
  .strict();

const ArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    reportKind: z.literal(
      "rosterpilot-live-numerical-parity-certification",
    ),
    reportId: z.string().regex(SHA256_PATTERN),
    rotationId: z.string().trim().min(1).nullable(),
    generatedAt: z.string().refine(
      (value) => !Number.isNaN(Date.parse(value)),
      "Expected an ISO-compatible timestamp.",
    ),
    comparison: z
      .object({
        path: z.string().min(1),
        checksumPath: z.string().min(1),
        sha256: z.string().regex(SHA256_PATTERN).nullable(),
        checksumSha256: z.string().regex(SHA256_PATTERN).nullable(),
      })
      .strict(),
    releaseBinding: z
      .object({
        expectedBundleId: z.string().regex(SHA256_PATTERN).nullable(),
        observedBundleIds: z.array(z.string().regex(SHA256_PATTERN)),
        expectedGitHead: z.string().regex(GIT_SHA_PATTERN).nullable(),
        observedGitHeads: z.array(z.string().regex(GIT_SHA_PATTERN)),
        matched: z.boolean(),
      })
      .strict(),
    sourceReports: z.array(SourceEvidenceSchema).max(2),
    policy: PolicySchema,
    evaluation: EvaluationSchema,
  })
  .strict();

function digest(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function reason(
  category: LiveNumericalParityReasonCategory,
  code: LiveNumericalParityReasonCode,
  message: string,
  options: {
    provider?: TesseraParityProvider | null;
    metric?: TesseraMetric | null;
  } = {},
): LiveNumericalParityReason {
  return {
    category,
    code,
    message,
    provider: options.provider ?? null,
    metric: options.metric ?? null,
  };
}

function sortReasons(
  reasons: readonly LiveNumericalParityReason[],
): LiveNumericalParityReason[] {
  const unique = new Map<string, LiveNumericalParityReason>();
  for (const entry of reasons) {
    unique.set(canonicalJson(entry), { ...entry });
  }
  return [...unique.values()].sort((left, right) =>
    [
      left.category,
      left.code,
      left.provider ?? "",
      left.metric ?? "",
      left.message,
    ]
      .join("\u0000")
      .localeCompare(
        [
          right.category,
          right.code,
          right.provider ?? "",
          right.metric ?? "",
          right.message,
        ].join("\u0000"),
      ),
  );
}

function sortedMetrics(
  summaries: readonly LiveNumericalParityMetricEvidence[],
): LiveNumericalParityMetricEvidence[] {
  const order = new Map<TesseraMetric, number>(
    LIVE_NUMERICAL_PARITY_POLICY.requiredMetrics.map((metric, index) => [
      metric,
      index,
    ]),
  );
  return summaries
    .map((entry) => ({ ...entry }))
    .sort(
      (left, right) =>
        (order.get(left.metric) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.metric) ?? Number.MAX_SAFE_INTEGER) ||
        left.metric.localeCompare(right.metric),
    );
}

function sortedWinners(
  winners: readonly LiveNumericalParityWinnerEvidence[],
): LiveNumericalParityWinnerEvidence[] {
  return winners
    .map((entry) => ({ ...entry }))
    .sort((left, right) =>
      left.classificationId.localeCompare(right.classificationId),
    );
}

export function evaluateLiveNumericalParity(
  input: LiveNumericalParityEvaluationInput,
): LiveNumericalParityEvaluation {
  const reasons = [...(input.initialReasons ?? [])];
  const metricSummaries = sortedMetrics(input.metricSummaries);
  const winnerClassifications = sortedWinners(
    input.winnerClassifications,
  );
  const byMetric = new Map<TesseraMetric, LiveNumericalParityMetricEvidence>();
  let repeatedMetric = false;
  for (const summary of metricSummaries) {
    if (byMetric.has(summary.metric)) repeatedMetric = true;
    byMetric.set(summary.metric, summary);
  }
  const allRequiredMetricsPresent =
    !repeatedMetric &&
    byMetric.size === LIVE_NUMERICAL_PARITY_POLICY.requiredMetrics.length &&
    LIVE_NUMERICAL_PARITY_POLICY.requiredMetrics.every((metric) => {
      const summary = byMetric.get(metric);
      return (
        summary !== undefined &&
        summary.expectedCellCount > 0 &&
        summary.comparedCellCount === summary.expectedCellCount &&
        summary.withinToleranceCount <= summary.comparedCellCount &&
        summary.beyondDoubleToleranceCount <=
          summary.expectedCellCount &&
        Math.abs(
          summary.withinToleranceRate -
            summary.withinToleranceCount /
              summary.expectedCellCount,
        ) < 1e-12
      );
    });
  if (!allRequiredMetricsPresent) {
    reasons.push(
      reason(
        "completeness",
        "METRIC_SET_INCOMPLETE",
        "Live numerical parity requires one complete non-empty summary for each of the four canonical metrics.",
      ),
    );
  }

  const belowThreshold = metricSummaries.filter(
    (summary) =>
      summary.withinToleranceRate <
        LIVE_NUMERICAL_PARITY_POLICY.minimumPerMetricPassRate ||
      summary.status !== "pass",
  );
  const everyMetricAtLeast98Percent =
    allRequiredMetricsPresent && belowThreshold.length === 0;
  for (const summary of belowThreshold) {
    reasons.push(
      reason(
        "policy",
        "METRIC_PASS_RATE_BELOW_98_PERCENT",
        `${summary.metric} retained ${(summary.withinToleranceRate * 100).toFixed(2)}% within tolerance; at least 98% is required.`,
        { metric: summary.metric },
      ),
    );
  }

  const beyondDoubleToleranceCellCount = metricSummaries.reduce(
    (total, summary) => total + summary.beyondDoubleToleranceCount,
    0,
  );
  if (beyondDoubleToleranceCellCount > 0) {
    reasons.push(
      reason(
        "policy",
        "CELL_BEYOND_DOUBLE_TOLERANCE",
        `${beyondDoubleToleranceCellCount} parity cell(s) exceeded twice the metric tolerance; zero are allowed.`,
      ),
    );
  }

  const canonicalWinners = winnerClassifications.filter(
    (entry) =>
      entry.classificationId ===
      LIVE_NUMERICAL_PARITY_POLICY.canonicalWinnerId,
  );
  const canonicalWinnerComplete =
    canonicalWinners.length === 1 &&
    canonicalWinners[0].localWinner !== null &&
    canonicalWinners[0].websiteWinner !== null &&
    canonicalWinners[0].status !== "incomplete";
  if (!canonicalWinnerComplete) {
    reasons.push(
      reason(
        "completeness",
        "CANONICAL_WINNER_INCOMPLETE",
        "The comparison did not retain one complete canonical winner classification.",
      ),
    );
  }
  const canonicalWinnerAgreementOutsideUncertainty =
    canonicalWinnerComplete &&
    canonicalWinners.every(
      (entry) =>
        entry.uncertaintyBoundary ||
        (entry.status === "pass" && entry.localWinner === entry.websiteWinner),
    );
  if (
    canonicalWinnerComplete &&
    !canonicalWinnerAgreementOutsideUncertainty
  ) {
    reasons.push(
      reason(
        "policy",
        "CANONICAL_WINNER_MISMATCH",
        "The providers disagree on the canonical winner outside the retained uncertainty boundary.",
      ),
    );
  }

  if (!input.comparisonAvailable || !input.sourceReportsAvailable) {
    reasons.push(
      reason(
        "availability",
        !input.comparisonAvailable
          ? "COMPARISON_UNAVAILABLE"
          : "SOURCE_REPORT_UNAVAILABLE",
        !input.comparisonAvailable
          ? "The receipt-bound provider comparison is unavailable."
          : "One or both receipt-bound source reports are unavailable.",
      ),
    );
  }
  if (!input.comparisonIntegrityValid) {
    reasons.push(
      reason(
        "integrity",
        "COMPARISON_DERIVATION_MISMATCH",
        "The retained provider comparison does not match its receipt-bound source reports and canonical derivation.",
      ),
    );
  }
  if (!input.sourceBindingsValid) {
    reasons.push(
      reason(
        "integrity",
        "SOURCE_REPORT_BINDING_MISMATCH",
        "One or both source reports do not match the paths, hashes, run identities, or adapter bindings retained by the comparison.",
      ),
    );
  }
  if (input.fixtureOnlyEvidence) {
    reasons.push(
      reason(
        "eligibility",
        "FIXTURE_ONLY_EVIDENCE",
        "Recorded, mocked, synthetic, or fixture-only execution cannot establish a live parity pass.",
      ),
    );
  } else if (!input.liveEvidenceComplete) {
    reasons.push(
      reason(
        "eligibility",
        "LIVE_EXECUTION_EVIDENCE_INELIGIBLE",
        "Both providers must retain complete production runtime evidence; Tessera Web must also retain deployment, imported-semantics, and selected-state bindings.",
      ),
    );
  }
  if (input.parityOutcome === "ineligible" || !input.parityEligible) {
    reasons.push(
      reason(
        "eligibility",
        "PARITY_INELIGIBLE",
        "The paired reports do not share the same eligible bundle, roster input, profile policy, scenario, capability, and combat identities.",
      ),
    );
  }
  if (input.parityOutcome === "incomplete" || !input.parityComplete) {
    reasons.push(
      reason(
        "completeness",
        "PARITY_INCOMPLETE",
        "The paired comparison is eligible but lacks complete numeric or uncertainty evidence.",
      ),
    );
  }

  const available =
    input.comparisonAvailable && input.sourceReportsAvailable;
  const integrityValid =
    input.comparisonIntegrityValid && input.sourceBindingsValid;
  const eligible =
    available &&
    integrityValid &&
    input.releaseBindingMatches !== false &&
    input.liveEvidenceComplete &&
    !input.fixtureOnlyEvidence &&
    input.parityEligible &&
    input.parityOutcome !== "ineligible";
  const complete =
    eligible &&
    input.parityComplete &&
    input.parityOutcome !== "incomplete" &&
    allRequiredMetricsPresent &&
    canonicalWinnerComplete;
  const policyPassed =
    input.parityOutcome === "pass" &&
    everyMetricAtLeast98Percent &&
    beyondDoubleToleranceCellCount === 0 &&
    canonicalWinnerAgreementOutsideUncertainty;

  const status: LiveNumericalParityCertificationStatus = !available
    ? "unavailable"
    : !eligible
      ? "ineligible"
      : !complete
        ? "incomplete"
        : policyPassed
          ? "pass"
          : "fail";

  if (
    status === "pass" &&
    input.parityOutcome !== "pass"
  ) {
    reasons.push(
      reason(
        "integrity",
        "PARITY_OUTCOME_INCONSISTENT",
        "The certification cannot pass when the canonical parity comparison did not pass.",
      ),
    );
  }

  return {
    status,
    eligible,
    complete,
    liveEvidence:
      input.liveEvidenceComplete && !input.fixtureOnlyEvidence,
    parityOutcome: input.parityOutcome,
    allRequiredMetricsPresent,
    everyMetricAtLeast98Percent,
    beyondDoubleToleranceCellCount,
    canonicalWinnerAgreementOutsideUncertainty,
    metricSummaries,
    winnerClassifications,
    reasons: sortReasons(reasons),
  };
}

function reportId(input: {
  rotationId: string | null;
  comparison: LiveNumericalParityCertificationArtifact["comparison"];
  releaseBinding: LiveNumericalParityCertificationArtifact["releaseBinding"];
  sourceReports: LiveNumericalParitySourceEvidence[];
  evaluation: LiveNumericalParityEvaluation;
}): string {
  return digest(
    canonicalJson({
      rotationId: input.rotationId,
      comparison: input.comparison,
      releaseBinding: input.releaseBinding,
      sourceReports: input.sourceReports,
      policy: LIVE_NUMERICAL_PARITY_POLICY,
      evaluation: input.evaluation,
    }),
  );
}

export function sealLiveNumericalParityCertification(input: {
  generatedAt: string;
  rotationId?: string | null;
  comparison: LiveNumericalParityCertificationArtifact["comparison"];
  releaseBinding: LiveNumericalParityCertificationArtifact["releaseBinding"];
  sourceReports: LiveNumericalParitySourceEvidence[];
  evaluation: LiveNumericalParityEvaluation;
}): LiveNumericalParityCertificationArtifact {
  const artifact: LiveNumericalParityCertificationArtifact = {
    schemaVersion: 1,
    reportKind: "rosterpilot-live-numerical-parity-certification",
    reportId: "",
    rotationId: input.rotationId?.trim() || null,
    generatedAt: input.generatedAt,
    comparison: { ...input.comparison },
    releaseBinding: {
      ...input.releaseBinding,
      observedBundleIds: [...input.releaseBinding.observedBundleIds].sort(),
      observedGitHeads: [...input.releaseBinding.observedGitHeads].sort(),
    },
    sourceReports: [...input.sourceReports].sort((left, right) =>
      left.provider.localeCompare(right.provider),
    ),
    policy: LIVE_NUMERICAL_PARITY_POLICY,
    evaluation: input.evaluation,
  };
  artifact.reportId = reportId(artifact);
  return artifact;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function reportShape(value: unknown): value is TesseraMatchupReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<TesseraMatchupReport>;
  return (
    typeof report.runId === "string" &&
    validTimestamp(report.generatedAt) &&
    typeof report.source === "string" &&
    typeof report.status === "string" &&
    !!report.player &&
    Array.isArray(report.opponents) &&
    !!report.simulation &&
    Array.isArray(report.simulation.scenarios)
  );
}

function comparisonShape(
  value: unknown,
): value is TesseraProviderParityWorkflowArtifact {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<TesseraProviderParityWorkflowArtifact>;
  const outcomes = new Set(["pass", "fail", "incomplete", "ineligible"]);
  const classifications = new Set([
    "parity-pass",
    "model-drift",
    "data-or-input-drift",
    "evidence-incomplete",
  ]);
  const sourcesValid =
    Array.isArray(artifact.sourceReports) &&
    artifact.sourceReports.length === 2 &&
    artifact.sourceReports.every((source) =>
      !!source &&
      typeof source === "object" &&
      (source.provider === "local-engine" || source.provider === "website") &&
      typeof source.reportPath === "string" &&
      typeof source.receiptPath === "string" &&
      typeof source.reportSha256 === "string" &&
      SHA256_PATTERN.test(source.reportSha256) &&
      typeof source.receiptSha256 === "string" &&
      SHA256_PATTERN.test(source.receiptSha256) &&
      typeof source.receiptEvidenceSha256 === "string" &&
      SHA256_PATTERN.test(source.receiptEvidenceSha256) &&
      typeof source.runId === "string" &&
      !!source.executionEvidence &&
      typeof source.executionEvidence === "object"
    );
  const parityValid = artifact.parity === null || !!(
    artifact.parity &&
    artifact.parity.schemaVersion === 1 &&
    artifact.parity.kind === "tessera-provider-parity" &&
    outcomes.has(artifact.parity.outcome) &&
    typeof artifact.parity.eligible === "boolean" &&
    typeof artifact.parity.complete === "boolean" &&
    Array.isArray(artifact.parity.metricSummaries) &&
    Array.isArray(artifact.parity.cells) &&
    Array.isArray(artifact.parity.winnerClassifications) &&
    Array.isArray(artifact.parity.issues)
  );
  return (
    artifact.schemaVersion === 1 &&
    artifact.kind === "tessera-provider-parity-comparison" &&
    artifact.evidenceKind ===
      "paired-receipt-bound-completed-provider-reports" &&
    artifact.sourceResolution?.kind ===
      "reports-root-sha256-run-id" &&
    artifact.sourceResolution.reportRootRequired === true &&
    validTimestamp(artifact.generatedAt) &&
    typeof artifact.outcome === "string" &&
    outcomes.has(artifact.outcome) &&
    typeof artifact.classification === "string" &&
    classifications.has(artifact.classification) &&
    sourcesValid &&
    parityValid &&
    !!artifact.adaptation &&
    Array.isArray(artifact.strengths) &&
    Array.isArray(artifact.weaknesses) &&
    Array.isArray(artifact.nextActions) &&
    Array.isArray(artifact.limitations)
  );
}

async function readBoundedRegularFile(
  filename: string,
  maximumBytes: number,
): Promise<VerifiedFile> {
  const resolved = path.resolve(filename);
  const metadata = await lstat(resolved);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`Evidence is not a bounded regular file: ${resolved}.`);
  }
  const bytes = await readFile(resolved);
  return {
    path: resolved,
    bytes,
    text: bytes.toString("utf8"),
    sha256: digest(bytes),
  };
}

function parseJson(file: VerifiedFile): unknown {
  try {
    return JSON.parse(file.text);
  } catch (error) {
    throw new Error(`Evidence is not valid JSON: ${file.path}.`, {
      cause: error,
    });
  }
}

function providerComparisonReceiptPath(comparisonPath: string): string {
  return `${comparisonPath}.sha256`;
}

async function readVerifiedComparison(
  comparisonPath: string,
): Promise<VerifiedComparison> {
  const file = await readBoundedRegularFile(
    comparisonPath,
    MAX_COMPARISON_BYTES,
  );
  const value = parseJson(file);
  if (!comparisonShape(value)) {
    throw new Error("The input is not a schema-v1 provider parity comparison.");
  }
  const receiptPath = providerComparisonReceiptPath(file.path);
  const receiptFile = await readBoundedRegularFile(
    receiptPath,
    MAX_RECEIPT_BYTES,
  );
  const checksum = receiptFile.text.match(
    /^([a-f0-9]{64})  ([^/\\\r\n]+)\n$/,
  );
  if (
    !checksum ||
    checksum[1] !== file.sha256 ||
    checksum[2] !== path.basename(file.path)
  ) {
    throw new Error(
      "The provider-parity comparison detached checksum is malformed or does not identify these exact bytes.",
    );
  }
  return {
    artifact: value,
    file,
    receiptPath,
    receiptSha256: receiptFile.sha256,
  };
}

function reportCompatibilityEnvelope(
  report: TesseraMatchupReport,
): TesseraProviderCompatibilityEnvelope | null {
  const candidates = report.providerCompatibilityEnvelopes ??
    (report.providerCompatibility ? [report.providerCompatibility] : []);
  return candidates.length === 1 ? candidates[0] : null;
}

async function portableJsonFiles(
  directory: string,
  state: { files: number; bytes: number },
): Promise<string[]> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Portable parity reports root must be a real directory: ${directory}.`,
    );
  }
  const results: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Portable parity evidence cannot contain a symbolic link: ${filename}.`,
      );
    }
    if (entry.isDirectory()) {
      results.push(...(await portableJsonFiles(filename, state)));
      continue;
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json") ||
      entry.name.endsWith(".receipt.json")
    ) {
      continue;
    }
    const fileMetadata = await lstat(filename);
    if (
      !fileMetadata.isFile() ||
      fileMetadata.isSymbolicLink() ||
      fileMetadata.size > MAX_SOURCE_REPORT_BYTES
    ) {
      throw new Error(
        `Portable parity evidence contains an invalid report candidate: ${filename}.`,
      );
    }
    state.files += 1;
    state.bytes += fileMetadata.size;
    if (
      state.files > MAX_PORTABLE_REPORT_FILES ||
      state.bytes > MAX_PORTABLE_REPORT_BYTES
    ) {
      throw new Error(
        "Portable parity report discovery exceeded its bounded file or byte budget.",
      );
    }
    results.push(filename);
  }
  return results;
}

/**
 * Relocates one source report after CI artifact download. The original
 * absolute path is deliberately ignored; exact bytes are selected only by
 * the SHA-256 retained in the comparison. Duplicate copies fail closed so a
 * caller cannot silently choose between ambiguous evidence bundles.
 */
export async function resolveProviderParitySourceReportPath(input: {
  reportsRoot: string;
  expectedSha256: string;
  expectedRunId: string;
  expectedProvider: TesseraParityProvider;
}): Promise<string> {
  if (!SHA256_PATTERN.test(input.expectedSha256)) {
    throw new Error("Portable parity lookup requires one lowercase SHA-256.");
  }
  const root = path.resolve(input.reportsRoot);
  const candidates = await portableJsonFiles(root, {
    files: 0,
    bytes: 0,
  });
  const matches: string[] = [];
  for (const filename of candidates.sort()) {
    const file = await readBoundedRegularFile(
      filename,
      MAX_SOURCE_REPORT_BYTES,
    );
    if (file.sha256 !== input.expectedSha256) continue;
    const value = parseJson(file);
    if (
      reportShape(value) &&
      value.runId === input.expectedRunId &&
      value.simulation.selectedBackend === input.expectedProvider
    ) {
      matches.push(file.path);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Portable parity reports root has no ${input.expectedProvider} report for run ${input.expectedRunId} with SHA-256 ${input.expectedSha256}.`
        : `Portable parity reports root has ${matches.length} ${input.expectedProvider} reports for run ${input.expectedRunId} with SHA-256 ${input.expectedSha256}; the binding is ambiguous.`,
    );
  }
  return matches[0];
}

async function resolveProviderParityComparisonPath(input: {
  reportsRoot: string;
  expectedSha256: string;
}): Promise<string> {
  if (!SHA256_PATTERN.test(input.expectedSha256)) {
    throw new Error(
      "Portable parity comparison lookup requires one lowercase SHA-256.",
    );
  }
  const candidates = await portableJsonFiles(
    path.resolve(input.reportsRoot),
    { files: 0, bytes: 0 },
  );
  const matches: string[] = [];
  for (const filename of candidates.sort()) {
    const file = await readBoundedRegularFile(
      filename,
      MAX_SOURCE_REPORT_BYTES,
    );
    if (file.sha256 !== input.expectedSha256) continue;
    if (comparisonShape(parseJson(file))) matches.push(file.path);
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Portable parity reports root has no provider comparison with SHA-256 ${input.expectedSha256}.`
        : `Portable parity reports root has ${matches.length} provider comparisons with SHA-256 ${input.expectedSha256}; the binding is ambiguous.`,
    );
  }
  return matches[0];
}

function portableCertificationEvidence(
  artifact: LiveNumericalParityCertificationArtifact,
): object {
  return {
    rotationId: artifact.rotationId,
    generatedAt: artifact.generatedAt,
    comparison: {
      sha256: artifact.comparison.sha256,
      checksumSha256: artifact.comparison.checksumSha256,
    },
    releaseBinding: artifact.releaseBinding,
    sourceReports: artifact.sourceReports.map((entry) => ({
      provider: entry.provider,
      reportSha256: entry.reportSha256,
      receiptSha256: entry.receiptSha256,
      runId: entry.runId,
      reportSource: entry.reportSource,
      runtimeIdentitySha256: entry.runtimeIdentitySha256,
      providerIdentitySha256: entry.providerIdentitySha256,
      providerCompatibilityEnvelopeSha256:
        entry.providerCompatibilityEnvelopeSha256,
      evidenceKind: entry.evidenceKind,
      complete: entry.complete,
      issueCodes: entry.issueCodes,
    })),
    policy: artifact.policy,
    evaluation: artifact.evaluation,
  };
}

/**
 * A detached digest proves integrity, not provenance. Before a claimed live
 * pass can enter rollout history, rebuild it from the exact receipt-bound
 * comparison and source reports present in the supplied evidence root.
 */
export async function verifyLiveNumericalParityCertificationEvidence(input: {
  artifact: LiveNumericalParityCertificationArtifact;
  reportsRoot: string;
}): Promise<void> {
  if (input.artifact.evaluation.status !== "pass") return;
  if (
    input.artifact.comparison.sha256 === null ||
    input.artifact.comparison.checksumSha256 === null
  ) {
    throw new Error(
      "A passing live numerical parity certificate must bind an exact comparison and detached checksum.",
    );
  }
  const comparisonPath = await resolveProviderParityComparisonPath({
    reportsRoot: input.reportsRoot,
    expectedSha256: input.artifact.comparison.sha256,
  });
  const rebuilt = await createLiveNumericalParityCertification({
    comparisonPath,
    reportsRoot: input.reportsRoot,
    ...(input.artifact.rotationId
      ? { rotationId: input.artifact.rotationId }
      : {}),
    ...(input.artifact.releaseBinding.expectedBundleId
      ? {
          expectedBundleId:
            input.artifact.releaseBinding.expectedBundleId,
        }
      : {}),
    ...(input.artifact.releaseBinding.expectedGitHead
      ? {
          expectedGitHead:
            input.artifact.releaseBinding.expectedGitHead,
        }
      : {}),
    generatedAt: input.artifact.generatedAt,
  });
  if (
    rebuilt.evaluation.status !== "pass" ||
    canonicalJson(portableCertificationEvidence(rebuilt)) !==
      canonicalJson(portableCertificationEvidence(input.artifact))
  ) {
    throw new Error(
      "The passing live numerical parity certificate does not match a fresh derivation from its exact receipt-bound evidence.",
    );
  }
}

async function readVerifiedSourceReport(
  source: TesseraProviderParityWorkflowArtifact["sourceReports"][number],
  reportsRoot?: string,
): Promise<VerifiedSourceReport> {
  const resolvedReportPath = reportsRoot
    ? await resolveProviderParitySourceReportPath({
        reportsRoot,
        expectedSha256: source.reportSha256,
        expectedRunId: source.runId,
        expectedProvider: source.provider,
      })
    : source.reportPath;
  const reportFile = await readBoundedRegularFile(
    resolvedReportPath,
    MAX_SOURCE_REPORT_BYTES,
  );
  const reportValue = parseJson(reportFile);
  if (!reportShape(reportValue)) {
    throw new Error(`${source.provider} source is not an exact matchup report.`);
  }
  const canonicalReceiptPath = exactReportReceiptPath(reportFile.path);
  if (
    !reportsRoot &&
    path.resolve(source.receiptPath) !== canonicalReceiptPath
  ) {
    throw new Error(
      `${source.provider} retained a non-canonical exact-report receipt path.`,
    );
  }
  const receiptFile = await readBoundedRegularFile(
    canonicalReceiptPath,
    MAX_RECEIPT_BYTES,
  );
  const receiptValue = parseJson(receiptFile);
  const receiptError = verifyExactReportReceipt(
    reportFile.path,
    reportFile.text,
    reportValue,
    receiptValue,
  );
  if (receiptError) throw new Error(receiptError);
  const exactReceipt = receiptValue as {
    evidenceSha256?: unknown;
  };
  if (
    source.reportSha256 !== reportFile.sha256 ||
    source.receiptSha256 !== receiptFile.sha256 ||
    source.receiptEvidenceSha256 !== exactReceipt.evidenceSha256 ||
    source.runId !== reportValue.runId ||
    reportValue.simulation.selectedBackend !== source.provider
  ) {
    throw new Error(
      `${source.provider} source bytes, run, or provider do not match the comparison binding.`,
    );
  }
  return {
    provider: source.provider,
    report: reportValue,
    reportFile,
    receiptFile,
    compatibilityEnvelope: reportCompatibilityEnvelope(reportValue),
  };
}

function hasFixtureMarker(values: readonly unknown[]): boolean {
  return values.some(
    (value) =>
      typeof value === "string" && FIXTURE_MARKER_PATTERN.test(value),
  );
}

function runtimeEvidenceComplete(report: TesseraMatchupReport): boolean {
  const runtime = report.runtime;
  return !!(
    runtime &&
    runtime.stale === false &&
    runtime.gitHead &&
    GIT_SHA_PATTERN.test(runtime.gitHead) &&
    SHA256_PATTERN.test(runtime.sourceFingerprintAtStart) &&
    runtime.sourceFingerprintAtStart === runtime.sourceFingerprintNow &&
    runtime.buildId.length > 0 &&
    runtime.rosterPilotVersion.length > 0 &&
    runtime.rulesPackageVersion.length > 0 &&
    validTimestamp(runtime.processStartedAt) &&
    runtime.runtimeProcessIdentity &&
    Number.isInteger(runtime.runtimeProcessIdentity.pid) &&
    runtime.runtimeProcessIdentity.pid > 0 &&
    runtime.runtimeProcessIdentity.executable.length > 0
  );
}

function signedBundleEvidenceComplete(
  envelope: TesseraProviderCompatibilityEnvelope | null,
): boolean {
  if (!envelope?.complete || envelope.issues.length > 0) return false;
  const trust = envelope.data.bundleTrust;
  return !!(
    trust.manifest &&
    SHA256_PATTERN.test(envelope.data.bundleId) &&
    trust.manifest.bundleId === envelope.data.bundleId &&
    trust.manifest.semanticIdentitySha256 ===
      envelope.data.semanticIdentitySha256 &&
    SHA256_PATTERN.test(trust.manifest.manifestSha256) &&
    trust.manifest.evidenceKind === "signed" &&
    Boolean(trust.manifest.signingKeyId?.length) &&
    trust.update.dataTrust === "signed-verified" &&
    trust.update.activeBundleId === envelope.data.bundleId &&
    SHA256_PATTERN.test(trust.identitySha256)
  );
}

function providerIdentityEvidenceComplete(
  provider: TesseraParityProvider,
  identity: TesseraSimulationProviderIdentity | undefined,
  envelope: TesseraProviderCompatibilityEnvelope | null,
): boolean {
  if (!identity || identity.provider !== provider) return false;
  if (provider === "local-engine") {
    return (
      identity.provider === "local-engine" &&
      identity.engine === "tessera-engine" &&
      identity.repository === "Tessera-cmd/tessera-engine" &&
      GIT_SHA_PATTERN.test(identity.commit) &&
      GIT_SHA_PATTERN.test(identity.tree) &&
      SHA256_PATTERN.test(identity.sourceSha256) &&
      identity.adapterVersion === LOCAL_TESSERA_ADAPTER_VERSION &&
      identity.compilerVersion === LOCAL_TESSERA_COMPILER_VERSION &&
      identity.inputSchemaVersion === 2 &&
      SHA256_PATTERN.test(identity.capabilityManifestSha256)
    );
  }
  if (identity.provider !== "website") return false;
  const website = envelope?.tessera.website;
  const stateBindings = website?.importSemantics.stateBindings;
  return !!(
    identity.engine === "tessera-ui" &&
    identity.adapterVersion === TESSERA_WEBSITE_ADAPTER_VERSION &&
    identity.uiIdentity &&
    SHA256_PATTERN.test(identity.uiIdentity) &&
    website &&
    website.deployment.complete &&
    website.deployment.completeness === "complete" &&
    website.deployment.identitySha256 === identity.uiIdentity &&
    website.deployment.declarationSha256 &&
    SHA256_PATTERN.test(website.deployment.declarationSha256) &&
    website.deployment.assets.some(
      (asset) => asset.sameOrigin && asset.sha256 !== null,
    ) &&
    website.deployment.assets.every(
      (asset) => !asset.sameOrigin || !!asset.sha256,
    ) &&
    website.importSemantics.complete &&
    website.importSemantics.completeness === "complete" &&
    website.importSemantics.unresolvedEffectCount === 0 &&
    website.importSemantics.combinedSha256 &&
    SHA256_PATTERN.test(website.importSemantics.combinedSha256) &&
    stateBindings?.player &&
    stateBindings.opponent &&
    stateBindings.player.side === "player" &&
    stateBindings.opponent.side === "opponent" &&
    SHA256_PATTERN.test(stateBindings.player.stateSha256) &&
    SHA256_PATTERN.test(stateBindings.opponent.stateSha256)
  );
}

function comparisonExecutionEvidence(
  source: VerifiedSourceReport,
): TesseraProviderParityWorkflowArtifact["sourceReports"][number]["executionEvidence"] | null {
  const identity = source.report.simulation.providerIdentity;
  if (!identity) return null;
  const website = source.compatibilityEnvelope?.tessera.website ?? null;
  const stateBindings = website?.importSemantics.stateBindings;
  return {
    reportSource: source.report.source,
    reportStatus: source.report.status,
    simulationStatus: source.report.simulation.status ?? null,
    engine: source.report.simulation.engine ?? null,
    providerIdentity: identity,
    providerIdentitySha256: digest(canonicalJson(identity)),
    complete:
      source.report.status === "complete" &&
      source.report.simulation.status === "complete",
    website: website
      ? {
          deploymentIdentitySha256:
            website.deployment.identitySha256 ?? null,
          deploymentComplete:
            website.deployment.complete &&
            website.deployment.completeness === "complete",
          importSemanticsSha256:
            website.importSemantics.combinedSha256 ?? null,
          importSemanticsComplete:
            website.importSemantics.complete &&
            website.importSemantics.completeness === "complete",
          stateBindingsComplete:
            stateBindings?.player !== null &&
            stateBindings?.player !== undefined &&
            stateBindings.opponent !== null &&
            stateBindings.opponent !== undefined,
        }
      : null,
  };
}

function sourceEvidence(
  source: VerifiedSourceReport,
): {
  evidence: LiveNumericalParitySourceEvidence;
  reasons: LiveNumericalParityReason[];
} {
  const report = source.report;
  const providerIdentity = report.simulation.providerIdentity;
  const fixtureOnly = hasFixtureMarker([
    report.runId,
    providerIdentity?.adapterVersion,
    providerIdentity?.provider === "website"
      ? providerIdentity.uiIdentity
      : providerIdentity?.compilerVersion,
    report.runtime?.buildId,
  ]);
  const expectedSource =
    source.provider === "local-engine"
      ? "tessera-local-engine"
      : "tessera-ui";
  const complete =
    !fixtureOnly &&
    report.source === expectedSource &&
    report.status === "complete" &&
    report.simulation.requested === true &&
    report.simulation.executionMode === "simulate" &&
    report.simulation.status === "complete" &&
    report.simulation.selectedBackend === source.provider &&
    report.simulation.fallback == null &&
    runtimeEvidenceComplete(report) &&
    signedBundleEvidenceComplete(source.compatibilityEnvelope) &&
    providerIdentityEvidenceComplete(
      source.provider,
      providerIdentity,
      source.compatibilityEnvelope,
    );
  const issueCodes: LiveNumericalParityReasonCode[] = [];
  const reasons: LiveNumericalParityReason[] = [];
  if (fixtureOnly) {
    issueCodes.push("FIXTURE_ONLY_EVIDENCE");
    reasons.push(
      reason(
        "eligibility",
        "FIXTURE_ONLY_EVIDENCE",
        `${source.provider} retains an explicit fixture, recorded, mock, or synthetic execution marker.`,
        { provider: source.provider },
      ),
    );
  }
  if (!complete && !fixtureOnly) {
    issueCodes.push("LIVE_EXECUTION_EVIDENCE_INELIGIBLE");
    reasons.push(
      reason(
        "eligibility",
        "LIVE_EXECUTION_EVIDENCE_INELIGIBLE",
        `${source.provider} lacks complete production runtime, signed-bundle, provider, or Web semantic-state evidence.`,
        { provider: source.provider },
      ),
    );
  }
  return {
    evidence: {
      provider: source.provider,
      reportPath: source.reportFile.path,
      receiptPath: source.receiptFile.path,
      reportSha256: source.reportFile.sha256,
      receiptSha256: source.receiptFile.sha256,
      runId: report.runId,
      reportSource: report.source,
      runtimeIdentitySha256: report.runtime
        ? digest(canonicalJson(report.runtime))
        : null,
      providerIdentitySha256: providerIdentity
        ? digest(canonicalJson(providerIdentity))
        : null,
      providerCompatibilityEnvelopeSha256:
        source.compatibilityEnvelope?.envelopeSha256 ?? null,
      evidenceKind: fixtureOnly
        ? "fixture-only"
        : complete
          ? "live"
          : "ineligible",
      complete,
      issueCodes,
    },
    reasons,
  };
}

function matchingRuntimeBuilds(
  reports: readonly VerifiedSourceReport[],
): boolean {
  if (reports.length !== 2 || reports.some((entry) => !entry.report.runtime)) {
    return false;
  }
  const [left, right] = reports.map((entry) => entry.report.runtime!);
  return (
    left.rosterPilotVersion === right.rosterPilotVersion &&
    left.rulesPackageVersion === right.rulesPackageVersion &&
    left.gitHead === right.gitHead &&
    left.sourceFingerprintNow === right.sourceFingerprintNow &&
    left.buildId === right.buildId
  );
}

function metricEvidence(
  summaries: readonly TesseraProviderParityMetricSummary[],
): LiveNumericalParityMetricEvidence[] {
  return summaries.map((summary) => ({ ...summary }));
}

function winnerEvidence(
  winners: readonly TesseraProviderParityWinnerComparison[],
): LiveNumericalParityWinnerEvidence[] {
  return winners.map((winner) => ({ ...winner }));
}

function unavailableArtifact(
  comparisonPath: string,
  message: string,
  generatedAt: string,
  expectations: {
    expectedBundleId: string | null;
    expectedGitHead: string | null;
  },
  rotationId: string | null,
): LiveNumericalParityCertificationArtifact {
  const comparison = {
    path: path.resolve(comparisonPath),
    checksumPath: providerComparisonReceiptPath(path.resolve(comparisonPath)),
    sha256: null,
    checksumSha256: null,
  };
  const initialReasons: LiveNumericalParityReason[] = [
    reason(
      "availability",
      "COMPARISON_UNAVAILABLE",
      message,
    ),
  ];
  if (expectations.expectedBundleId !== null) {
    initialReasons.push(
      reason(
        "eligibility",
        "EXPECTED_BUNDLE_ID_MISMATCH",
        `Expected signed data bundle ${expectations.expectedBundleId}; observed none because the comparison is unavailable.`,
      ),
    );
  }
  if (expectations.expectedGitHead !== null) {
    initialReasons.push(
      reason(
        "eligibility",
        "EXPECTED_GIT_HEAD_MISMATCH",
        `Expected git HEAD ${expectations.expectedGitHead}; observed none because the comparison is unavailable.`,
      ),
    );
  }
  const evaluation = evaluateLiveNumericalParity({
    comparisonAvailable: false,
    comparisonIntegrityValid: false,
    sourceReportsAvailable: false,
    sourceBindingsValid: false,
    liveEvidenceComplete: false,
    fixtureOnlyEvidence: false,
    releaseBindingMatches:
      expectations.expectedBundleId === null &&
      expectations.expectedGitHead === null,
    parityOutcome: null,
    parityEligible: false,
    parityComplete: false,
    metricSummaries: [],
    winnerClassifications: [],
    initialReasons,
  });
  const sourceReports: LiveNumericalParitySourceEvidence[] = [];
  return sealLiveNumericalParityCertification({
    generatedAt,
    rotationId,
    comparison,
    releaseBinding: {
      ...expectations,
      observedBundleIds: [],
      observedGitHeads: [],
      matched:
        expectations.expectedBundleId === null &&
        expectations.expectedGitHead === null,
    },
    sourceReports,
    evaluation,
  });
}

export async function createLiveNumericalParityCertification(options: {
  comparisonPath: string;
  reportsRoot?: string;
  rotationId?: string;
  expectedBundleId?: string;
  expectedGitHead?: string;
  generatedAt?: string;
}): Promise<LiveNumericalParityCertificationArtifact> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const rotationId = options.rotationId?.trim() || null;
  const expectations = {
    expectedBundleId: options.expectedBundleId ?? null,
    expectedGitHead: options.expectedGitHead ?? null,
  };
  if (
    expectations.expectedBundleId !== null &&
    !SHA256_PATTERN.test(expectations.expectedBundleId)
  ) {
    throw new Error("Expected bundle ID must be one lowercase SHA-256.");
  }
  if (
    expectations.expectedGitHead !== null &&
    !GIT_SHA_PATTERN.test(expectations.expectedGitHead)
  ) {
    throw new Error("Expected git HEAD must be one lowercase 40-character commit SHA.");
  }
  let comparison: VerifiedComparison;
  try {
    comparison = await readVerifiedComparison(options.comparisonPath);
  } catch (error) {
    return unavailableArtifact(
      options.comparisonPath,
      error instanceof Error ? error.message : String(error),
      generatedAt,
      expectations,
      rotationId,
    );
  }

  const comparisonBinding = {
    path: comparison.file.path,
    checksumPath: comparison.receiptPath,
    sha256: comparison.file.sha256,
    checksumSha256: comparison.receiptSha256,
  };
  const initialReasons: LiveNumericalParityReason[] = [];
  let reports: VerifiedSourceReport[] = [];
  if (!options.reportsRoot) {
    initialReasons.push(
      reason(
        "availability",
        "SOURCE_REPORT_UNAVAILABLE",
        "The portable provider comparison requires --reports-root so exact source reports can be relocated by SHA-256, run ID, and provider.",
      ),
    );
  } else {
    const reportsRoot = options.reportsRoot;
    try {
      reports = await Promise.all(
        comparison.artifact.sourceReports.map((source) =>
          readVerifiedSourceReport(source, reportsRoot),
        ),
      );
    } catch (error) {
      initialReasons.push(
        reason(
          "availability",
          "SOURCE_REPORT_UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const uniqueProviders = new Set(reports.map((entry) => entry.provider));
  const sourceReportsAvailable =
    reports.length === 2 &&
    uniqueProviders.has("local-engine") &&
    uniqueProviders.has("website");
  const observedBundleIds = [
    ...new Set(
      reports.flatMap((entry) =>
        entry.compatibilityEnvelope
          ? [entry.compatibilityEnvelope.data.bundleId]
          : [],
      ),
    ),
  ].sort();
  const observedGitHeads = [
    ...new Set(
      reports.flatMap((entry) =>
        entry.report.runtime?.gitHead
          ? [entry.report.runtime.gitHead]
          : [],
      ),
    ),
  ].sort();
  const bundleExpectationMatched =
    expectations.expectedBundleId === null ||
    (observedBundleIds.length === 1 &&
      observedBundleIds[0] === expectations.expectedBundleId);
  const gitExpectationMatched =
    expectations.expectedGitHead === null ||
    (observedGitHeads.length === 1 &&
      observedGitHeads[0] === expectations.expectedGitHead);
  const releaseBinding = {
    ...expectations,
    observedBundleIds,
    observedGitHeads,
    matched: bundleExpectationMatched && gitExpectationMatched,
  };
  if (!bundleExpectationMatched) {
    initialReasons.push(
      reason(
        "eligibility",
        "EXPECTED_BUNDLE_ID_MISMATCH",
        `Expected signed data bundle ${expectations.expectedBundleId}; observed ${observedBundleIds.join(", ") || "none"}.`,
      ),
    );
  }
  if (!gitExpectationMatched) {
    initialReasons.push(
      reason(
        "eligibility",
        "EXPECTED_GIT_HEAD_MISMATCH",
        `Expected git HEAD ${expectations.expectedGitHead}; observed ${observedGitHeads.join(", ") || "none"}.`,
      ),
    );
  }
  const assessed = reports.map(sourceEvidence);
  initialReasons.push(...assessed.flatMap((entry) => entry.reasons));
  const sourceReports = assessed
    .map((entry) => entry.evidence)
    .sort((left, right) => left.provider.localeCompare(right.provider));
  let sourceBindingsValid = sourceReportsAvailable;
  let derivedParity: TesseraProviderParityResult | null = null;
  if (sourceReportsAvailable) {
    const adapted = await Promise.all(
      reports.map((entry) =>
        adaptReportBoundTesseraMatchupReportToProviderParityRun(
          entry.report,
          entry.reportFile.path,
        ),
      ),
    );
    if (adapted.every((entry) => entry.ok)) {
      const local = adapted.find(
        (entry, index) =>
          entry.ok && reports[index].provider === "local-engine",
      );
      const website = adapted.find(
        (entry, index) =>
          entry.ok && reports[index].provider === "website",
      );
      if (local?.ok && website?.ok) {
        derivedParity = compareTesseraProviderParity(
          local.run,
          website.run,
        );
        for (const [index, adaptedReport] of adapted.entries()) {
          if (!adaptedReport.ok) continue;
          const retained = comparison.artifact.sourceReports.find(
            (entry) => entry.provider === reports[index].provider,
          );
          sourceBindingsValid &&= !!(
            retained &&
            canonicalJson(retained.executionEvidence) ===
              canonicalJson(
                comparisonExecutionEvidence(reports[index]),
              ) &&
            retained.providerCompatibilityEnvelopeSha256 ===
              adaptedReport.bindings.providerCompatibilityEnvelopeSha256 &&
            retained.rawScenarioContractSha256 ===
              adaptedReport.bindings.rawScenarioContractSha256 &&
            retained.normalizedScenarioContractSha256 ===
              adaptedReport.bindings.normalizedScenarioContractSha256 &&
            retained.normalizedInputSha256 ===
              adaptedReport.bindings.normalizedInputSha256
          );
        }
      } else {
        sourceBindingsValid = false;
      }
    } else {
      sourceBindingsValid = false;
      initialReasons.push(
        reason(
          "integrity",
          "SOURCE_REPORT_BINDING_MISMATCH",
          adapted
            .flatMap((entry) => (entry.ok ? [] : entry.issues))
            .map((entry) => `${entry.code}: ${entry.message}`)
            .join("; ") ||
            "The source report adapter rejected one or both reports.",
        ),
      );
    }
  }

  const comparisonIntegrityValid = !!(
    derivedParity &&
    comparison.artifact.parity &&
    canonicalJson(derivedParity) ===
      canonicalJson(comparison.artifact.parity) &&
    comparison.artifact.outcome === derivedParity.outcome
  );
  if (!comparisonIntegrityValid && sourceReportsAvailable) {
    initialReasons.push(
      reason(
        "integrity",
        "COMPARISON_DERIVATION_MISMATCH",
        "The checksum-verified comparison parity result does not match a fresh canonical derivation from its exact source reports.",
      ),
    );
  }
  const crossRunRuntimeComplete = matchingRuntimeBuilds(reports);
  if (sourceReportsAvailable && !crossRunRuntimeComplete) {
    initialReasons.push(
      reason(
        "eligibility",
        "LIVE_EXECUTION_EVIDENCE_INELIGIBLE",
        "The local and Web reports were not produced by the same RosterPilot runtime build and source fingerprint.",
      ),
    );
    for (const sourceReport of sourceReports) {
      sourceReport.complete = false;
      sourceReport.evidenceKind = "ineligible";
      if (
        !sourceReport.issueCodes.includes(
          "LIVE_EXECUTION_EVIDENCE_INELIGIBLE",
        )
      ) {
        sourceReport.issueCodes.push(
          "LIVE_EXECUTION_EVIDENCE_INELIGIBLE",
        );
      }
    }
  }
  const fixtureOnlyEvidence = sourceReports.some(
    (entry) => entry.evidenceKind === "fixture-only",
  );
  const liveEvidenceComplete =
    crossRunRuntimeComplete &&
    sourceReports.length === 2 &&
    sourceReports.every(
      (entry) => entry.evidenceKind === "live" && entry.complete,
    );
  const parity = derivedParity ?? comparison.artifact.parity;
  const evaluation = evaluateLiveNumericalParity({
    comparisonAvailable: true,
    comparisonIntegrityValid,
    sourceReportsAvailable,
    sourceBindingsValid,
    liveEvidenceComplete,
    fixtureOnlyEvidence,
    releaseBindingMatches: releaseBinding.matched,
    parityOutcome: parity?.outcome ?? null,
    parityEligible: parity?.eligible ?? false,
    parityComplete: parity?.complete ?? false,
    metricSummaries: metricEvidence(parity?.metricSummaries ?? []),
    winnerClassifications: winnerEvidence(
      parity?.winnerClassifications ?? [],
    ),
    initialReasons,
  });
  return sealLiveNumericalParityCertification({
    generatedAt,
    rotationId,
    comparison: comparisonBinding,
    releaseBinding,
    sourceReports,
    evaluation,
  });
}

function assertCanonicalArtifact(
  artifact: LiveNumericalParityCertificationArtifact,
  filename: string,
): void {
  const expectedReleaseBindingMatch =
    (artifact.releaseBinding.expectedBundleId === null ||
      (artifact.releaseBinding.observedBundleIds.length === 1 &&
        artifact.releaseBinding.observedBundleIds[0] ===
          artifact.releaseBinding.expectedBundleId)) &&
    (artifact.releaseBinding.expectedGitHead === null ||
      (artifact.releaseBinding.observedGitHeads.length === 1 &&
        artifact.releaseBinding.observedGitHeads[0] ===
          artifact.releaseBinding.expectedGitHead));
  if (
    new Set(artifact.releaseBinding.observedBundleIds).size !==
      artifact.releaseBinding.observedBundleIds.length ||
    new Set(artifact.releaseBinding.observedGitHeads).size !==
      artifact.releaseBinding.observedGitHeads.length ||
    canonicalJson([...artifact.releaseBinding.observedBundleIds].sort()) !==
      canonicalJson(artifact.releaseBinding.observedBundleIds) ||
    canonicalJson([...artifact.releaseBinding.observedGitHeads].sort()) !==
      canonicalJson(artifact.releaseBinding.observedGitHeads) ||
    artifact.releaseBinding.matched !== expectedReleaseBindingMatch
  ) {
    throw new Error(
      `Live numerical parity rejected "${filename}": release bundle/git expectations are internally inconsistent.`,
    );
  }
  const releaseReasonCodes = new Set(
    artifact.evaluation.reasons.map((entry) => entry.code),
  );
  if (
    (artifact.releaseBinding.expectedBundleId !== null &&
      !(
        artifact.releaseBinding.observedBundleIds.length === 1 &&
        artifact.releaseBinding.observedBundleIds[0] ===
          artifact.releaseBinding.expectedBundleId
      ) &&
      !releaseReasonCodes.has("EXPECTED_BUNDLE_ID_MISMATCH")) ||
    (artifact.releaseBinding.expectedGitHead !== null &&
      !(
        artifact.releaseBinding.observedGitHeads.length === 1 &&
        artifact.releaseBinding.observedGitHeads[0] ===
          artifact.releaseBinding.expectedGitHead
      ) &&
      !releaseReasonCodes.has("EXPECTED_GIT_HEAD_MISMATCH"))
  ) {
    throw new Error(
      `Live numerical parity rejected "${filename}": release expectation mismatch reasons are missing.`,
    );
  }
  const providers = artifact.sourceReports.map((entry) => entry.provider);
  if (
    new Set(providers).size !== providers.length ||
    canonicalJson(
      [...artifact.sourceReports].sort((left, right) =>
        left.provider.localeCompare(right.provider),
      ),
    ) !== canonicalJson(artifact.sourceReports)
  ) {
    throw new Error(
      `Live numerical parity rejected "${filename}": source reports are duplicated or not canonically ordered.`,
    );
  }
  for (const sourceReport of artifact.sourceReports) {
    const issueCodes = [...sourceReport.issueCodes].sort();
    if (
      new Set(issueCodes).size !== issueCodes.length ||
      canonicalJson(issueCodes) !==
        canonicalJson(sourceReport.issueCodes) ||
      (sourceReport.evidenceKind === "live" &&
        (!sourceReport.complete || issueCodes.length > 0)) ||
      (sourceReport.evidenceKind === "fixture-only" &&
        (sourceReport.complete ||
          !issueCodes.includes("FIXTURE_ONLY_EVIDENCE"))) ||
      (sourceReport.evidenceKind === "ineligible" &&
        (sourceReport.complete ||
          !issueCodes.includes(
            "LIVE_EXECUTION_EVIDENCE_INELIGIBLE",
          )))
    ) {
      throw new Error(
        `Live numerical parity rejected "${filename}": ${sourceReport.provider} live-evidence classification is internally inconsistent.`,
      );
    }
  }
  const expected = evaluateLiveNumericalParity({
    comparisonAvailable: artifact.comparison.sha256 !== null,
    comparisonIntegrityValid: !artifact.evaluation.reasons.some(
      (entry) =>
        entry.code === "COMPARISON_DERIVATION_MISMATCH" ||
        entry.code === "COMPARISON_RECEIPT_INVALID" ||
        entry.code === "COMPARISON_SCHEMA_INVALID",
    ),
    sourceReportsAvailable:
      artifact.sourceReports.length === 2,
    sourceBindingsValid: !artifact.evaluation.reasons.some(
      (entry) => entry.code === "SOURCE_REPORT_BINDING_MISMATCH",
    ),
    liveEvidenceComplete:
      artifact.sourceReports.length === 2 &&
      artifact.sourceReports.every(
        (entry) => entry.evidenceKind === "live" && entry.complete,
      ),
    fixtureOnlyEvidence: artifact.sourceReports.some(
      (entry) => entry.evidenceKind === "fixture-only",
    ),
    releaseBindingMatches: artifact.releaseBinding.matched,
    parityOutcome: artifact.evaluation.parityOutcome,
    parityEligible:
      artifact.evaluation.parityOutcome !== null &&
      artifact.evaluation.parityOutcome !== "ineligible",
    parityComplete: artifact.evaluation.parityOutcome === "pass" ||
      artifact.evaluation.parityOutcome === "fail",
    metricSummaries: artifact.evaluation.metricSummaries,
    winnerClassifications: artifact.evaluation.winnerClassifications,
  });
  const { reasons: expectedReasons, ...expectedCore } = expected;
  const { reasons: retainedReasons, ...retainedCore } = artifact.evaluation;
  const retainedReasonCodes = new Set(
    retainedReasons.map((entry) => entry.code),
  );
  if (
    canonicalJson(expectedCore) !== canonicalJson(retainedCore) ||
    expectedReasons.some(
      (entry) => !retainedReasonCodes.has(entry.code),
    ) ||
    (artifact.evaluation.status === "pass" &&
      artifact.evaluation.reasons.length > 0)
  ) {
    throw new Error(
      `Live numerical parity rejected "${filename}": its evaluation is not canonical for its retained evidence.`,
    );
  }
  if (artifact.reportId !== reportId(artifact)) {
    throw new Error(
      `Live numerical parity rejected "${filename}": reportId does not match the canonical retained state.`,
    );
  }
}

async function destinationAvailable(
  filename: string,
  overwrite: boolean,
): Promise<void> {
  try {
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `Certification destination is not a regular file: ${filename}.`,
      );
    }
    if (!overwrite) {
      throw new Error(
        `Certification destination already exists: ${filename}.`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function writeLiveNumericalParityCertification(
  artifact: LiveNumericalParityCertificationArtifact,
  outputPath: string,
  options: { overwrite?: boolean } = {},
): Promise<WrittenLiveNumericalParityCertification> {
  const parsed = ArtifactSchema.parse(artifact);
  assertCanonicalArtifact(parsed, outputPath);
  const resolved = path.resolve(outputPath);
  const checksumPath = `${resolved}.sha256`;
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await Promise.all([
    destinationAvailable(resolved, options.overwrite === true),
    destinationAvailable(checksumPath, options.overwrite === true),
  ]);
  const content = `${canonicalJson(parsed)}\n`;
  const contentSha256 = digest(content);
  const checksum = `${contentSha256}  ${path.basename(resolved)}\n`;
  const nonce = crypto.randomUUID();
  const temporaryReport = `${resolved}.${nonce}.tmp`;
  const temporaryChecksum = `${checksumPath}.${nonce}.tmp`;
  try {
    await Promise.all([
      writeFile(temporaryReport, content, { flag: "wx", mode: 0o600 }),
      writeFile(temporaryChecksum, checksum, {
        flag: "wx",
        mode: 0o600,
      }),
    ]);
    await rename(temporaryReport, resolved);
    await rename(temporaryChecksum, checksumPath);
  } catch (error) {
    throw new Error(
      `Could not atomically write live numerical parity certification: ${resolved}.`,
      { cause: error },
    );
  }
  return {
    artifact: parsed,
    reportPath: resolved,
    checksumPath,
    sha256: contentSha256,
  };
}

export async function readVerifiedLiveNumericalParityCertification(
  inputPath: string,
): Promise<LiveNumericalParityCertificationArtifact> {
  const reportFile = await readBoundedRegularFile(
    inputPath,
    MAX_CERTIFICATION_BYTES,
  );
  const checksumFile = await readBoundedRegularFile(
    `${reportFile.path}.sha256`,
    MAX_CHECKSUM_BYTES,
  );
  const match = checksumFile.text.match(
    /^([a-f0-9]{64})  ([^/\\\r\n]+)\n$/,
  );
  if (
    !match ||
    match[2] !== path.basename(reportFile.path) ||
    match[1] !== reportFile.sha256
  ) {
    throw new Error(
      `Live numerical parity rejected "${reportFile.path}": detached checksum is invalid.`,
    );
  }
  const parsed = ArtifactSchema.parse(parseJson(reportFile));
  assertCanonicalArtifact(parsed, reportFile.path);
  return parsed;
}
