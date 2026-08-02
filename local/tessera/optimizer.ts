import { createHash, randomUUID } from "node:crypto";

import {
  rosterProfileRequirements,
  validateRoster,
} from "../../lib/rosterpilot/engine";
import {
  analyzeMissionReadiness,
} from "../../lib/rosterpilot/mission-readiness";
import {
  rosterExecutionFingerprint,
} from "../../lib/rosterpilot/stress-portfolio";
import type {
  ProfilePolicyV1,
  RosterDraftV1,
  RuntimeProvenance,
  TesseraChangeCandidate,
  TesseraMatchupReport,
  TesseraMissionReadinessBand,
  TesseraMissionReadinessReport,
  TesseraRevisionComparisonReport,
  TesseraStressRevisionReport,
  TesseraStressTestReport,
} from "../../lib/rosterpilot/types";
import {
  MINIMUM_CHANGE_CANDIDATE_UTILIZATION,
  qualifyRosterChangeCandidate,
} from "./candidate-quality";
import type { TesseraRunRequest } from "./jobs";
import {
  profilePolicyHash,
  profilePolicyIdentityMatches,
  validateProfilePolicy,
} from "./profile-policy";

export const TESSERA_OPTIMIZER_SCHEMA_VERSION = 1;
export const TESSERA_OPTIMIZER_HEURISTIC_VERSION =
  "tessera-pareto-v1" as const;

const sha256Pattern = /^[0-9a-f]{64}$/;

export type TesseraOptimizerMode = "guided" | "recommend-only";

export type TesseraOptimizerStage =
  | "recommendations-ready"
  | "candidate-batch-approved"
  | "comparisons-pending"
  | "pareto-ready"
  | "winner-approved"
  | "baseline-retained"
  | "finalized"
  | "invalidated";

export type TesseraOptimizerBaselineKind = "exact" | "stress";

export type TesseraOptimizerIssue = {
  code: string;
  message: string;
  severity: "error" | "warn";
};

export type TesseraOptimizerResult<T> = {
  ok: boolean;
  data: T | null;
  violations: TesseraOptimizerIssue[];
  warnings: TesseraOptimizerIssue[];
};

export type TesseraOptimizerHeuristicParameters = {
  qualificationVersion: "candidate-quality-v1";
  profileCompatibilityVersion: "frozen-profile-subset-v1";
  paretoVersion: typeof TESSERA_OPTIMIZER_HEURISTIC_VERSION;
  minimumPointsUtilization: number;
  exactRequiredConclusion: "improved";
  stressRequiredConclusion: "better";
  requireAcceptedMissionReadinessGuardrail: true;
  stressMateriality: 0.01;
};

export type TesseraOptimizerFrozenIdentities = {
  baseline: {
    kind: TesseraOptimizerBaselineKind;
    runId: string;
    reportPath: string;
    reportCanonicalSha256: string;
    reportArtifactSha256: string | null;
    evidenceArtifactSha256: string | null;
    rosterFingerprint: string;
    scenarioContractSha256: string;
    tesseraUiIdentity: string | null;
  };
  bundle: {
    bundleId: string;
    engineDataSchemaVersion: number;
    rosterRulesHash: string;
    factionRulesHash: string;
    mappingHash: string;
    entityHashesSha256: string;
    semanticIdentitySha256: string;
    provenanceSha256: string;
  };
  portfolio: {
    kind: "exact-opponents" | "stress-portfolio";
    declaredSha256: string | null;
    contractSha256: string;
  };
  profile: {
    policyHash: string | null;
    policyPath: string | null;
    policyArtifactSha256: string | null;
    requirementsSha256: string;
  };
  heuristic: {
    version: typeof TESSERA_OPTIMIZER_HEURISTIC_VERSION;
    parametersSha256: string;
  };
  runtime: {
    baselineSha256: string;
    evaluationSha256: string;
  };
  contextSha256: string;
};

export type TesseraOptimizerBaseline = {
  kind: TesseraOptimizerBaselineKind;
  reportPath: string;
  runId: string;
  roster: RosterDraftV1;
  rosterSha256: string;
  rosterFingerprint: string;
  readiness: TesseraMissionReadinessReport;
  profilePolicy: ProfilePolicyV1 | null;
  frozenProfileRequirements: TesseraMatchupReport["frozenProfileRequirements"];
};

export type TesseraOptimizerBaselineSuggestions = {
  pairing: "unpaired";
  evidenceClass: "unpaired-baseline-suggestions";
  statements: string[];
  candidateIds: string[];
  caveat: string;
};

export type TesseraOptimizerApprovalReceipt =
  | {
      schemaVersion: 1;
      approvalKind: "candidate-evaluation-batch";
      approvalId: string;
      approvedBy: string;
      approvedAt: string;
      optimizerRunId: string;
      expectedStateRevision: number;
      frozenIdentities: TesseraOptimizerFrozenIdentities;
      candidateIds: string[];
      candidateBatchSha256: string;
      receiptSha256: string;
    }
  | {
      schemaVersion: 1;
      approvalKind: "optimizer-exact-winner";
      approvalId: string;
      approvedBy: string;
      approvedAt: string;
      optimizerRunId: string;
      expectedStateRevision: number;
      frozenIdentities: TesseraOptimizerFrozenIdentities;
      candidateBatchApprovalSha256: string;
      paretoResultSha256: string;
      candidateId: string;
      candidateRosterSha256: string;
      candidateRosterFingerprint: string;
      comparisonEvidenceSha256: string;
      receiptSha256: string;
    }
  | {
      schemaVersion: 1;
      approvalKind: "optimizer-baseline-retention";
      approvalId: string;
      approvedBy: string;
      approvedAt: string;
      optimizerRunId: string;
      expectedStateRevision: number;
      frozenIdentities: TesseraOptimizerFrozenIdentities;
      candidateBatchApprovalSha256: string;
      paretoResultSha256: string;
      receiptSha256: string;
    };

export type TesseraOptimizerRevisionRunRequest = Extract<
  TesseraRunRequest,
  { kind: "exact-revision" | "stress-revision" }
>;

export type TesseraOptimizerComparisonRequest = {
  schemaVersion: 1;
  requestKind: "tessera-optimizer-revision";
  optimizerRunId: string;
  candidateId: string;
  contextSha256: string;
  candidateBatchApprovalSha256: string;
  revisedRosterSha256: string;
  revisedRosterFingerprint: string;
  runRequest: TesseraOptimizerRevisionRunRequest;
  requestSha256: string;
};

export type TesseraOptimizerObjectiveDimension = {
  id: string;
  value: number;
  direction: "maximize";
  materiality: number;
};

export type TesseraOptimizerComparisonEvidence = {
  schemaVersion: 1;
  comparisonKind: "exact" | "stress";
  candidateId: string;
  baselineRunId: string;
  revisedRosterFingerprint: string;
  reportRunId: string;
  reportCanonicalSha256: string;
  reportArtifactSha256: string | null;
  conclusion: string;
  qualified: boolean;
  disqualificationReasons: string[];
  objectiveDimensions: TesseraOptimizerObjectiveDimension[];
  summary: {
    improved: number;
    worsened: number;
    unchanged: number;
    ambiguous: number;
  };
  missionReadinessGuardrailAccepted: boolean;
  evidenceSha256: string;
};

export type TesseraOptimizerParetoCandidate = {
  candidateId: string;
  rosterFingerprint: string;
  rosterSha256: string;
  comparisonEvidenceSha256: string;
  qualified: boolean;
  disqualificationReasons: string[];
  objectiveDimensions: TesseraOptimizerObjectiveDimension[];
  dominatedByCandidateIds: string[];
};

export type TesseraOptimizerParetoResult = {
  schemaVersion: 1;
  policyVersion: typeof TESSERA_OPTIMIZER_HEURISTIC_VERSION;
  optimizerRunId: string;
  contextSha256: string;
  candidateBatchApprovalSha256: string;
  generatedAt: string;
  candidates: TesseraOptimizerParetoCandidate[];
  frontierCandidateIds: string[];
  dominatedCandidateIds: string[];
  disqualifiedCandidateIds: string[];
  baselineRetained: boolean;
  resultSha256: string;
};

export type TesseraOptimizerMaterializedCandidate = {
  candidate: TesseraChangeCandidate;
  pairing: "unpaired-baseline-suggestion";
  status:
    | "proposed"
    | "approved"
    | "rejected-local"
    | "ready-for-comparison"
    | "comparison-complete";
  revisedRoster: RosterDraftV1 | null;
  revisedRosterSha256: string | null;
  readiness: TesseraMissionReadinessReport | null;
  localRejection: TesseraOptimizerIssue | null;
  comparisonRequest: TesseraOptimizerComparisonRequest | null;
  comparison: TesseraOptimizerComparisonEvidence | null;
};

export type TesseraOptimizerDeliveryIntent =
  | {
      kind: "none";
      intentId: null;
      recordedBy: null;
      recordedAt: string;
    }
  | {
      kind: "prepare-handoff" | "deliver-new-recruit";
      intentId: string;
      recordedBy: string;
      recordedAt: string;
    };

export type TesseraOptimizerFinalization = {
  disposition: "winner-finalized" | "baseline-retained";
  candidateId: string | null;
  roster: RosterDraftV1;
  rosterSha256: string;
  rosterFingerprint: string;
  winnerApprovalReceiptSha256: string | null;
  deliveryIntent: TesseraOptimizerDeliveryIntent;
  finalizedAt: string;
  finalizationSha256: string;
};

export type TesseraOptimizerState = {
  schemaVersion: 1;
  coordinatorKind: "rosterpilot-tessera-optimizer";
  optimizerRunId: string;
  mode: TesseraOptimizerMode;
  stage: TesseraOptimizerStage;
  stateRevision: number;
  createdAt: string;
  updatedAt: string;
  heuristicParameters: TesseraOptimizerHeuristicParameters;
  frozenIdentities: TesseraOptimizerFrozenIdentities;
  baseline: TesseraOptimizerBaseline;
  baselineSuggestions: TesseraOptimizerBaselineSuggestions;
  candidates: TesseraOptimizerMaterializedCandidate[];
  approvals: TesseraOptimizerApprovalReceipt[];
  pareto: TesseraOptimizerParetoResult | null;
  finalization: TesseraOptimizerFinalization | null;
  invalidation: TesseraOptimizerIssue | null;
  integritySha256: string;
};

export type CreateTesseraOptimizerStateInput = {
  mode?: TesseraOptimizerMode;
  optimizerRunId?: string;
  createdAt?: string;
  baselineReportPath: string;
  baselineReport: TesseraMatchupReport | TesseraStressTestReport;
  baselineReportArtifactSha256?: string | null;
  baselineEvidenceArtifactSha256?: string | null;
  baselineRoster: RosterDraftV1;
  evaluationRuntime: RuntimeProvenance;
  profilePolicy?: ProfilePolicyV1 | null;
  profilePolicyPath?: string | null;
  profilePolicyArtifactSha256?: string | null;
  heuristicParameters?: Partial<TesseraOptimizerHeuristicParameters>;
};

export type TesseraOptimizerCandidateQualifier = (
  baselineRoster: RosterDraftV1,
  baselineReadiness: TesseraMissionReadinessReport,
  candidate: TesseraChangeCandidate,
) => Promise<{
  roster: RosterDraftV1;
  readiness: TesseraMissionReadinessReport;
} | null>;

const defaultHeuristicParameters: TesseraOptimizerHeuristicParameters = {
  qualificationVersion: "candidate-quality-v1",
  profileCompatibilityVersion: "frozen-profile-subset-v1",
  paretoVersion: TESSERA_OPTIMIZER_HEURISTIC_VERSION,
  minimumPointsUtilization: MINIMUM_CHANGE_CANDIDATE_UTILIZATION,
  exactRequiredConclusion: "improved",
  stressRequiredConclusion: "better",
  requireAcceptedMissionReadinessGuardrail: true,
  stressMateriality: 0.01,
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function tesseraOptimizerCanonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

export function tesseraOptimizerRuntimeIdentitySha256(
  runtime: RuntimeProvenance,
): string {
  return tesseraOptimizerCanonicalSha256({
    rosterPilotVersion: runtime.rosterPilotVersion,
    rulesPackageVersion: runtime.rulesPackageVersion,
    stressGeneratorVersion: runtime.stressGeneratorVersion,
    gitHead: runtime.gitHead,
    sourceFingerprintAtStart: runtime.sourceFingerprintAtStart,
    sourceFingerprintNow: runtime.sourceFingerprintNow,
    buildId: runtime.buildId,
    nodeVersion: runtime.nodeVersion ?? null,
    platform: runtime.platform ?? null,
    architecture: runtime.architecture ?? null,
    chromeVersion: runtime.chromeVersion ?? null,
    playwrightVersion: runtime.playwrightVersion ?? null,
    brokerBuildId: runtime.brokerBuildId ?? null,
    macOsVersion: runtime.macOsVersion ?? null,
    localAgentExpectedProtocolVersion:
      runtime.localAgentExpectedProtocolVersion ?? null,
    localAgentExpectedVersion:
      runtime.localAgentExpectedVersion ?? null,
    localAgentObservedStatus:
      runtime.localAgentObservedStatus ?? null,
    localAgentProcessIdentity:
      runtime.localAgentProcessIdentity ?? null,
    mcpBuildId: runtime.mcpBuildId ?? null,
    dataReleaseId: runtime.dataReleaseId ?? null,
    dataFreshnessCheckedAt:
      runtime.dataFreshnessCheckedAt ?? null,
    dataGeneratedAt: runtime.dataGeneratedAt ?? null,
  });
}

function issue(
  code: string,
  message: string,
  severity: "error" | "warn" = "error",
): TesseraOptimizerIssue {
  return { code, message, severity };
}

function success<T>(
  data: T,
  warnings: TesseraOptimizerIssue[] = [],
): TesseraOptimizerResult<T> {
  return { ok: true, data, violations: [], warnings };
}

function failure<T>(
  violation: TesseraOptimizerIssue,
  data: T | null = null,
): TesseraOptimizerResult<T> {
  return {
    ok: false,
    data,
    violations: [violation],
    warnings: [],
  };
}

function isStressReport(
  report: TesseraMatchupReport | TesseraStressTestReport,
): report is TesseraStressTestReport {
  return "reportKind" in report && report.reportKind === "tessera-stress-test";
}

function isSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && sha256Pattern.test(value);
}

function isIsoTimestamp(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

function semanticSourceIdentity(sourceData: RosterDraftV1["sourceData"]) {
  return {
    bundleId: sourceData.bundleId,
    engineDataSchemaVersion: sourceData.engineDataSchemaVersion,
    rosterRulesHash: sourceData.rosterRulesHash,
    factionRulesHash: sourceData.factionRulesHash,
    mappingHash: sourceData.mappingHash,
    entityHashesSha256: tesseraOptimizerCanonicalSha256(
      sourceData.entityHashes,
    ),
  };
}

function runtimeForBaseline(
  report: TesseraMatchupReport | TesseraStressTestReport,
): RuntimeProvenance | null {
  return report.runtime ?? null;
}

function reportProfilePolicyHash(
  report: TesseraMatchupReport | TesseraStressTestReport,
): string | null {
  return isStressReport(report)
    ? report.configuration.profilePolicyHash ?? null
    : report.profilePolicyHash ?? null;
}

function frozenProfileRequirements(
  report: TesseraMatchupReport | TesseraStressTestReport,
  roster: RosterDraftV1,
) {
  if (!isStressReport(report)) {
    return structuredClone(report.frozenProfileRequirements ?? []);
  }
  const rosters = [
    roster,
    ...report.portfolio.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ];
  const requirements = rosters.flatMap((candidate) =>
    rosterProfileRequirements(candidate),
  );
  return requirements.sort((left, right) =>
    tesseraOptimizerCanonicalSha256(left).localeCompare(
      tesseraOptimizerCanonicalSha256(right),
    ),
  );
}

function scenarioContract(
  report: TesseraMatchupReport | TesseraStressTestReport,
): unknown {
  if (isStressReport(report)) {
    return {
      suite: report.suite,
      configuration: report.configuration,
      portfolioSha256: report.portfolioSha256,
      stageProvenance: report.stageProvenance,
      representatives: report.representatives,
      frozenOpponentArtifacts: report.frozenOpponentArtifacts,
    };
  }
  return {
    configuration: report.configuration ?? null,
    pointsComparisons: report.pointsComparisons ?? [],
    simulationSettings: report.simulation.settings,
    scenarios: (report.simulation.scenarios ?? []).map((scenario) => ({
      scenarioId: scenario.scenarioId,
      opponentName: scenario.opponentName,
      phase: scenario.phase,
      direction: scenario.direction,
      metrics: scenario.metrics,
      status: scenario.status,
      settings: scenario.settings,
    })),
  };
}

function portfolioContract(
  report: TesseraMatchupReport | TesseraStressTestReport,
): unknown {
  if (isStressReport(report)) {
    return {
      portfolioSha256: report.portfolioSha256,
      suite: report.suite,
      strategy: report.configuration.analysisStrategy,
      portfolio: report.portfolio,
      representatives: report.representatives,
      frozenOpponentArtifacts: report.frozenOpponentArtifacts,
    };
  }
  return report.opponents.map((opponent) => ({
    kind: opponent.kind,
    rosterName: opponent.rosterName,
    fingerprint: opponent.fingerprint ?? null,
    sourceRoszSha256: opponent.sourceRoszSha256 ?? null,
    enrichedRoszSha256: opponent.enrichedRoszSha256 ?? null,
    summary: opponent.summary,
  }));
}

function reportDataPin(
  report: TesseraMatchupReport | TesseraStressTestReport,
): RosterDraftV1["sourceData"] | null {
  if (isStressReport(report)) {
    return report.pinnedData?.player ?? report.missionReadiness.sourceData;
  }
  return report.pinnedData ?? null;
}

function reportEvidenceArtifactSha256(
  input: CreateTesseraOptimizerStateInput,
): string | null {
  if (input.baselineEvidenceArtifactSha256 !== undefined) {
    return input.baselineEvidenceArtifactSha256;
  }
  if (!isStressReport(input.baselineReport)) return null;
  return (
    input.baselineReport.artifacts.find(
      (artifact) => artifact.format === "stress-manifest",
    )?.sha256 ?? null
  );
}

function validateIdentityInput(
  input: CreateTesseraOptimizerStateInput,
): TesseraOptimizerIssue | null {
  if (!input.baselineReportPath.trim()) {
    return issue(
      "TESSERA_OPTIMIZER_BASELINE_PATH_REQUIRED",
      "A durable baseline report path is required.",
    );
  }
  if (
    input.baselineReportArtifactSha256 != null &&
    !isSha256(input.baselineReportArtifactSha256)
  ) {
    return issue(
      "TESSERA_OPTIMIZER_BASELINE_HASH_INVALID",
      "The baseline report artifact hash must be a lowercase SHA-256 value.",
    );
  }
  const evidenceSha256 = reportEvidenceArtifactSha256(input);
  if (evidenceSha256 != null && !isSha256(evidenceSha256)) {
    return issue(
      "TESSERA_OPTIMIZER_EVIDENCE_HASH_INVALID",
      "The baseline evidence artifact hash must be a lowercase SHA-256 value.",
    );
  }
  if (
    input.profilePolicyArtifactSha256 != null &&
    !isSha256(input.profilePolicyArtifactSha256)
  ) {
    return issue(
      "TESSERA_OPTIMIZER_PROFILE_ARTIFACT_HASH_INVALID",
      "The profile-policy artifact hash must be a lowercase SHA-256 value.",
    );
  }
  if (input.evaluationRuntime.stale) {
    return issue(
      "TESSERA_OPTIMIZER_RUNTIME_RESTART_REQUIRED",
      "The evaluation runtime is stale. Restart it before creating an optimizer batch.",
    );
  }
  return null;
}

export function deriveTesseraOptimizerFrozenIdentities(
  input: CreateTesseraOptimizerStateInput,
): TesseraOptimizerResult<TesseraOptimizerFrozenIdentities> {
  const invalid = validateIdentityInput(input);
  if (invalid) return failure(invalid);
  const baselineRuntime = runtimeForBaseline(input.baselineReport);
  if (!baselineRuntime) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_BASELINE_RUNTIME_REQUIRED",
        "The paired baseline must retain its runtime provenance.",
      ),
    );
  }
  const policyHash = reportProfilePolicyHash(input.baselineReport);
  const policy = input.profilePolicy ?? null;
  if (
    (policy ? profilePolicyHash(policy) : null) !== policyHash ||
    (policyHash !== null && !input.profilePolicyPath) ||
    (policyHash !== null && !input.profilePolicyArtifactSha256)
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_PROFILE_IDENTITY_INVALID",
        "The optimizer must receive the exact profile policy, path, and artifact hash frozen by the baseline.",
      ),
    );
  }
  const requirements = frozenProfileRequirements(
    input.baselineReport,
    input.baselineRoster,
  );
  const profileValidation = validateProfilePolicy(requirements, policy);
  if (!profileValidation.valid || profileValidation.hash !== policyHash) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_PROFILE_REQUIREMENTS_INVALID",
        "The supplied profile policy does not exactly cover the baseline's frozen profile requirements.",
      ),
    );
  }
  const source = semanticSourceIdentity(input.baselineRoster.sourceData);
  const bundle = {
    ...source,
    semanticIdentitySha256: tesseraOptimizerCanonicalSha256(source),
    provenanceSha256: tesseraOptimizerCanonicalSha256({
      package: input.baselineRoster.sourceData.package,
      version: input.baselineRoster.sourceData.version,
      edition: input.baselineRoster.sourceData.edition,
      dataslate: input.baselineRoster.sourceData.dataslate,
      releaseId: input.baselineRoster.sourceData.releaseId,
      newRecruit: input.baselineRoster.sourceData.newRecruit,
      official: input.baselineRoster.sourceData.official,
    }),
  };
  const kind: TesseraOptimizerBaselineKind = isStressReport(
    input.baselineReport,
  )
    ? "stress"
    : "exact";
  const heuristicParameters = {
    ...defaultHeuristicParameters,
    ...input.heuristicParameters,
    qualificationVersion: "candidate-quality-v1" as const,
    profileCompatibilityVersion: "frozen-profile-subset-v1" as const,
    paretoVersion: TESSERA_OPTIMIZER_HEURISTIC_VERSION,
    exactRequiredConclusion: "improved" as const,
    stressRequiredConclusion: "better" as const,
    requireAcceptedMissionReadinessGuardrail: true as const,
  };
  const withoutContext: Omit<
    TesseraOptimizerFrozenIdentities,
    "contextSha256"
  > = {
    baseline: {
      kind,
      runId: input.baselineReport.runId,
      reportPath: input.baselineReportPath,
      reportCanonicalSha256: tesseraOptimizerCanonicalSha256(
        input.baselineReport,
      ),
      reportArtifactSha256:
        input.baselineReportArtifactSha256 ?? null,
      evidenceArtifactSha256: reportEvidenceArtifactSha256(input),
      rosterFingerprint: rosterExecutionFingerprint(
        input.baselineRoster,
      ),
      scenarioContractSha256: tesseraOptimizerCanonicalSha256(
        scenarioContract(input.baselineReport),
      ),
      tesseraUiIdentity:
        input.baselineReport.tesseraUiIdentity ?? null,
    },
    bundle,
    portfolio: {
      kind:
        kind === "stress"
          ? "stress-portfolio"
          : "exact-opponents",
      declaredSha256: isStressReport(input.baselineReport)
        ? input.baselineReport.portfolioSha256
        : null,
      contractSha256: tesseraOptimizerCanonicalSha256(
        portfolioContract(input.baselineReport),
      ),
    },
    profile: {
      policyHash,
      policyPath: input.profilePolicyPath ?? null,
      policyArtifactSha256:
        input.profilePolicyArtifactSha256 ?? null,
      requirementsSha256:
        tesseraOptimizerCanonicalSha256(requirements),
    },
    heuristic: {
      version: TESSERA_OPTIMIZER_HEURISTIC_VERSION,
      parametersSha256:
        tesseraOptimizerCanonicalSha256(heuristicParameters),
    },
    runtime: {
      baselineSha256:
        tesseraOptimizerRuntimeIdentitySha256(baselineRuntime),
      evaluationSha256:
        tesseraOptimizerRuntimeIdentitySha256(
          input.evaluationRuntime,
        ),
    },
  };
  return success({
    ...withoutContext,
    contextSha256: tesseraOptimizerCanonicalSha256(withoutContext),
  });
}

function baselineCompatibilityIssue(
  input: CreateTesseraOptimizerStateInput,
): TesseraOptimizerIssue | null {
  const rosterValidation = validateRoster(input.baselineRoster);
  if (!rosterValidation.ok) {
    return issue(
      "TESSERA_OPTIMIZER_BASELINE_ROSTER_INVALID",
      "The canonical baseline roster is no longer valid under its leased bundle.",
    );
  }
  const report = input.baselineReport;
  const fingerprint = rosterExecutionFingerprint(input.baselineRoster);
  if (
    !report.runId ||
    report.player.fingerprint !== fingerprint ||
    !isSha256(fingerprint)
  ) {
    return issue(
      "TESSERA_OPTIMIZER_BASELINE_FINGERPRINT_MISMATCH",
      "The supplied roster does not match the baseline player execution fingerprint.",
    );
  }
  const pinned = reportDataPin(report);
  if (
    !pinned ||
    tesseraOptimizerCanonicalSha256(semanticSourceIdentity(pinned)) !==
      tesseraOptimizerCanonicalSha256(
        semanticSourceIdentity(input.baselineRoster.sourceData),
      )
  ) {
    return issue(
      "TESSERA_OPTIMIZER_BASELINE_BUNDLE_MISMATCH",
      "The baseline report and canonical roster do not share one semantic data-bundle identity.",
    );
  }
  if (isStressReport(report)) {
    if (
      report.status !== "complete" ||
      report.source !== "tessera-ui" ||
      report.integrity.status !== "verified" ||
      !report.robustness ||
      !isSha256(report.portfolioSha256) ||
      report.missionReadiness.rosterFingerprint !== fingerprint
    ) {
      return issue(
        "TESSERA_OPTIMIZER_STRESS_BASELINE_INCOMPATIBLE",
        "Optimization requires a complete, integrity-verified paired stress baseline.",
      );
    }
  } else if (
    report.schemaVersion !== 3 ||
    report.status !== "complete" ||
    report.source !== "tessera-ui" ||
    !report.configuration ||
    !report.pinnedData ||
    !report.tesseraUiIdentity ||
    report.opponents.length === 0 ||
    !report.simulation.scenarios?.length ||
    report.simulation.scenarios.some(
      (scenario) => scenario.status !== "complete",
    )
  ) {
    return issue(
      "TESSERA_OPTIMIZER_EXACT_BASELINE_INCOMPATIBLE",
      "Optimization requires a complete schema-v3 paired exact baseline with frozen scenario provenance.",
    );
  }
  return null;
}

function stateHash(state: TesseraOptimizerState): string {
  return tesseraOptimizerCanonicalSha256({
    ...state,
    integritySha256: undefined,
  });
}

function sealState(
  state: Omit<TesseraOptimizerState, "integritySha256"> & {
    integritySha256?: string;
  },
): TesseraOptimizerState {
  const sealed = {
    ...state,
    integritySha256: "",
  } as TesseraOptimizerState;
  return {
    ...sealed,
    integritySha256: stateHash(sealed),
  };
}

function receiptHash(receipt: TesseraOptimizerApprovalReceipt): string {
  return tesseraOptimizerCanonicalSha256({
    ...receipt,
    receiptSha256: undefined,
  });
}

function requestHash(request: TesseraOptimizerComparisonRequest): string {
  return tesseraOptimizerCanonicalSha256({
    ...request,
    requestSha256: undefined,
  });
}

function evidenceHash(
  evidence: TesseraOptimizerComparisonEvidence,
): string {
  return tesseraOptimizerCanonicalSha256({
    ...evidence,
    evidenceSha256: undefined,
  });
}

function paretoHash(result: TesseraOptimizerParetoResult): string {
  return tesseraOptimizerCanonicalSha256({
    ...result,
    resultSha256: undefined,
  });
}

function finalizationHash(
  finalization: TesseraOptimizerFinalization,
): string {
  return tesseraOptimizerCanonicalSha256({
    ...finalization,
    finalizationSha256: undefined,
  });
}

function identitiesAreInternallyValid(
  identities: TesseraOptimizerFrozenIdentities,
): boolean {
  const { contextSha256, ...payload } = identities;
  return (
    isSha256(contextSha256) &&
    contextSha256 === tesseraOptimizerCanonicalSha256(payload)
  );
}

function stateIntegrityIssue(
  state: TesseraOptimizerState,
): TesseraOptimizerIssue | null {
  if (
    state.schemaVersion !== TESSERA_OPTIMIZER_SCHEMA_VERSION ||
    state.coordinatorKind !== "rosterpilot-tessera-optimizer" ||
    state.integritySha256 !== stateHash(state) ||
    !identitiesAreInternallyValid(state.frozenIdentities)
  ) {
    return issue(
      "TESSERA_OPTIMIZER_STATE_TAMPERED",
      "The optimizer state or frozen context hash is invalid.",
    );
  }
  if (
    state.baseline.rosterSha256 !==
      tesseraOptimizerCanonicalSha256(state.baseline.roster) ||
    state.baseline.rosterFingerprint !==
      rosterExecutionFingerprint(state.baseline.roster) ||
    state.baseline.readiness.rosterFingerprint !==
      state.baseline.rosterFingerprint
  ) {
    return issue(
      "TESSERA_OPTIMIZER_BASELINE_TAMPERED",
      "The baseline roster or readiness evidence no longer matches its receipt.",
    );
  }
  if (new Set(state.candidates.map(({ candidate }) => candidate.candidateId)).size !== state.candidates.length) {
    return issue(
      "TESSERA_OPTIMIZER_CANDIDATE_IDS_INVALID",
      "Candidate IDs must remain unique inside the frozen optimizer state.",
    );
  }
  for (const approval of state.approvals) {
    if (
      approval.receiptSha256 !== receiptHash(approval) ||
      approval.optimizerRunId !== state.optimizerRunId ||
      tesseraOptimizerCanonicalSha256(approval.frozenIdentities) !==
        tesseraOptimizerCanonicalSha256(state.frozenIdentities)
    ) {
      return issue(
        "TESSERA_OPTIMIZER_APPROVAL_TAMPERED",
        "An optimizer approval receipt no longer matches the frozen context.",
      );
    }
  }
  for (const candidate of state.candidates) {
    if (
      candidate.revisedRoster &&
      (
        candidate.revisedRosterSha256 !==
          tesseraOptimizerCanonicalSha256(candidate.revisedRoster) ||
        candidate.candidate.rosterFingerprint !==
          rosterExecutionFingerprint(candidate.revisedRoster)
      )
    ) {
      return issue(
        "TESSERA_OPTIMIZER_CANDIDATE_TAMPERED",
        `Candidate ${candidate.candidate.candidateId} no longer matches its frozen roster identity.`,
      );
    }
    if (
      candidate.comparisonRequest &&
      candidate.comparisonRequest.requestSha256 !==
        requestHash(candidate.comparisonRequest)
    ) {
      return issue(
        "TESSERA_OPTIMIZER_REQUEST_TAMPERED",
        `Candidate ${candidate.candidate.candidateId} has a modified comparison request.`,
      );
    }
    if (
      candidate.comparison &&
      candidate.comparison.evidenceSha256 !==
        evidenceHash(candidate.comparison)
    ) {
      return issue(
        "TESSERA_OPTIMIZER_EVIDENCE_TAMPERED",
        `Candidate ${candidate.candidate.candidateId} has modified comparison evidence.`,
      );
    }
  }
  if (state.pareto && state.pareto.resultSha256 !== paretoHash(state.pareto)) {
    return issue(
      "TESSERA_OPTIMIZER_PARETO_TAMPERED",
      "The Pareto result no longer matches its content hash.",
    );
  }
  if (
    state.finalization &&
    state.finalization.finalizationSha256 !==
      finalizationHash(state.finalization)
  ) {
    return issue(
      "TESSERA_OPTIMIZER_FINALIZATION_TAMPERED",
      "The optimizer finalization no longer matches its content hash.",
    );
  }
  return null;
}

export function verifyTesseraOptimizerState(
  state: TesseraOptimizerState,
  currentIdentities?: TesseraOptimizerFrozenIdentities,
): TesseraOptimizerResult<TesseraOptimizerState> {
  const integrity = stateIntegrityIssue(state);
  if (integrity) return failure(integrity);
  if (
    currentIdentities &&
    tesseraOptimizerCanonicalSha256(currentIdentities) !==
      tesseraOptimizerCanonicalSha256(state.frozenIdentities)
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_IDENTITY_INVALIDATED",
        "The current baseline, bundle, portfolio, profile, heuristic, or runtime identity differs from the approved optimizer context.",
      ),
    );
  }
  return success(state);
}

function invalidateState(
  state: TesseraOptimizerState,
  violation: TesseraOptimizerIssue,
  at = new Date().toISOString(),
): TesseraOptimizerResult<TesseraOptimizerState> {
  const invalidated = sealState({
    ...structuredClone(state),
    stage: "invalidated",
    stateRevision: state.stateRevision + 1,
    updatedAt: at,
    invalidation: violation,
    finalization: null,
  });
  return failure(violation, invalidated);
}

function guardTransition(
  state: TesseraOptimizerState,
  currentIdentities: TesseraOptimizerFrozenIdentities,
  at?: string,
): TesseraOptimizerResult<TesseraOptimizerState> {
  const integrity = stateIntegrityIssue(state);
  if (integrity) return failure(integrity);
  if (state.stage === "invalidated") {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_ALREADY_INVALIDATED",
        "This optimizer state is terminally invalidated and cannot be resumed.",
      ),
      state,
    );
  }
  if (
    tesseraOptimizerCanonicalSha256(currentIdentities) !==
      tesseraOptimizerCanonicalSha256(state.frozenIdentities)
  ) {
    return invalidateState(
      state,
      issue(
        "TESSERA_OPTIMIZER_IDENTITY_INVALIDATED",
        "A frozen baseline, bundle, portfolio, profile, heuristic, or runtime identity changed.",
      ),
      at,
    );
  }
  return success(state);
}

function defaultReadiness(
  report: TesseraMatchupReport | TesseraStressTestReport,
  roster: RosterDraftV1,
): TesseraOptimizerResult<TesseraMissionReadinessReport> {
  if (isStressReport(report)) return success(report.missionReadiness);
  const readiness = analyzeMissionReadiness(roster);
  if (!readiness.ok || !readiness.data) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_MISSION_READINESS_UNAVAILABLE",
        "Mission-readiness analysis failed for the canonical baseline roster.",
      ),
    );
  }
  return success(readiness.data);
}

export function createTesseraOptimizerState(
  input: CreateTesseraOptimizerStateInput,
): TesseraOptimizerResult<TesseraOptimizerState> {
  const baselineIssue = baselineCompatibilityIssue(input);
  if (baselineIssue) return failure(baselineIssue);
  const identities = deriveTesseraOptimizerFrozenIdentities(input);
  if (!identities.ok || !identities.data) {
    return failure(
      identities.violations[0] ??
        issue(
          "TESSERA_OPTIMIZER_IDENTITY_INVALID",
          "The optimizer identities could not be frozen.",
        ),
    );
  }
  const readiness = defaultReadiness(
    input.baselineReport,
    input.baselineRoster,
  );
  if (!readiness.ok || !readiness.data) {
    return failure(
      readiness.violations[0] ??
        issue(
          "TESSERA_OPTIMIZER_MISSION_READINESS_UNAVAILABLE",
          "Mission-readiness evidence could not be frozen.",
        ),
    );
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!isIsoTimestamp(createdAt)) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_TIMESTAMP_INVALID",
        "The optimizer creation time must be an ISO-compatible timestamp.",
      ),
    );
  }
  const reportCandidates = input.baselineReport.changeCandidates ?? [];
  const candidateIds = reportCandidates.map(({ candidateId }) => candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_CANDIDATE_IDS_INVALID",
        "The baseline report contains duplicate candidate IDs.",
      ),
    );
  }
  if (
    reportCandidates.some(
      (candidate) =>
        !candidate.candidateId ||
        candidate.beforePoints !== input.baselineRoster.totalPoints ||
        !isSha256(candidate.rosterFingerprint),
    )
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_CANDIDATE_IDENTITY_INVALID",
        "Every baseline candidate must bind the baseline points and one revised execution fingerprint.",
      ),
    );
  }
  const heuristicParameters: TesseraOptimizerHeuristicParameters = {
    ...defaultHeuristicParameters,
    ...input.heuristicParameters,
    qualificationVersion: "candidate-quality-v1",
    profileCompatibilityVersion: "frozen-profile-subset-v1",
    paretoVersion: TESSERA_OPTIMIZER_HEURISTIC_VERSION,
    exactRequiredConclusion: "improved",
    stressRequiredConclusion: "better",
    requireAcceptedMissionReadinessGuardrail: true,
  };
  const optimizerRunId = input.optimizerRunId ?? randomUUID();
  const state = sealState({
    schemaVersion: 1,
    coordinatorKind: "rosterpilot-tessera-optimizer",
    optimizerRunId,
    mode: input.mode ?? "guided",
    stage: "recommendations-ready",
    stateRevision: 0,
    createdAt,
    updatedAt: createdAt,
    heuristicParameters,
    frozenIdentities: identities.data,
    baseline: {
      kind: identities.data.baseline.kind,
      reportPath: input.baselineReportPath,
      runId: input.baselineReport.runId,
      roster: structuredClone(input.baselineRoster),
      rosterSha256: tesseraOptimizerCanonicalSha256(
        input.baselineRoster,
      ),
      rosterFingerprint: identities.data.baseline.rosterFingerprint,
      readiness: structuredClone(readiness.data),
      profilePolicy: structuredClone(input.profilePolicy ?? null),
      frozenProfileRequirements: frozenProfileRequirements(
        input.baselineReport,
        input.baselineRoster,
      ),
    },
    baselineSuggestions: {
      pairing: "unpaired",
      evidenceClass: "unpaired-baseline-suggestions",
      statements: structuredClone(
        isStressReport(input.baselineReport)
          ? input.baselineReport.findings.map((finding) => finding.summary)
          : input.baselineReport.suggestions,
      ),
      candidateIds,
      caveat:
        "These baseline suggestions are unpaired hypotheses. They are not improvements until an approved paired revision qualifies them.",
    },
    candidates: reportCandidates.map((candidate) => ({
      candidate: structuredClone(candidate),
      pairing: "unpaired-baseline-suggestion" as const,
      status: "proposed" as const,
      revisedRoster: null,
      revisedRosterSha256: null,
      readiness: null,
      localRejection: null,
      comparisonRequest: null,
      comparison: null,
    })),
    approvals: [],
    pareto: null,
    finalization: null,
    invalidation: null,
  });
  return success(state);
}

function candidateBatchPayload(
  state: TesseraOptimizerState,
  candidateIds: string[],
) {
  return candidateIds
    .map((candidateId) => {
      const candidate = state.candidates.find(
        (entry) => entry.candidate.candidateId === candidateId,
      )!;
      return {
        candidateId,
        operation: candidate.candidate.operation,
        beforePoints: candidate.candidate.beforePoints,
        afterPoints: candidate.candidate.afterPoints,
        rosterFingerprint: candidate.candidate.rosterFingerprint,
        evidenceFindingIds: [...candidate.candidate.evidenceFindingIds].sort(),
      };
    })
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

export function approveTesseraOptimizerCandidateBatch(
  state: TesseraOptimizerState,
  input: {
    currentIdentities: TesseraOptimizerFrozenIdentities;
    expectedStateRevision: number;
    candidateIds: string[];
    approvalId: string;
    approvedBy: string;
    approvedAt: string;
  },
): TesseraOptimizerResult<TesseraOptimizerState> {
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    input.approvedAt,
  );
  if (!guarded.ok) return guarded;
  if (state.mode !== "guided") {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_RECOMMEND_ONLY",
        "Recommend-only mode never authorizes roster revisions or paired comparisons.",
      ),
      state,
    );
  }
  if (
    state.stage !== "recommendations-ready" ||
    input.expectedStateRevision !== state.stateRevision
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_STALE_BATCH_APPROVAL",
        "Candidate approval must target the exact current recommendations revision.",
      ),
      state,
    );
  }
  const candidateIds = [...new Set(input.candidateIds)].sort();
  if (
    candidateIds.length === 0 ||
    candidateIds.length > 3 ||
    candidateIds.length !== input.candidateIds.length ||
    candidateIds.some(
      (candidateId) =>
        !state.candidates.some(
          (entry) => entry.candidate.candidateId === candidateId,
        ),
    ) ||
    !input.approvalId.trim() ||
    !input.approvedBy.trim() ||
    !isIsoTimestamp(input.approvedAt)
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_BATCH_APPROVAL_INVALID",
        "The approval must name one to three unique frozen candidates and include an explicit approval identity and timestamp.",
      ),
      state,
    );
  }
  const receiptWithoutHash = {
    schemaVersion: 1 as const,
    approvalKind: "candidate-evaluation-batch" as const,
    approvalId: input.approvalId,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    optimizerRunId: state.optimizerRunId,
    expectedStateRevision: input.expectedStateRevision,
    frozenIdentities: structuredClone(state.frozenIdentities),
    candidateIds,
    candidateBatchSha256: tesseraOptimizerCanonicalSha256(
      candidateBatchPayload(state, candidateIds),
    ),
  };
  const receipt: TesseraOptimizerApprovalReceipt = {
    ...receiptWithoutHash,
    receiptSha256:
      tesseraOptimizerCanonicalSha256(receiptWithoutHash),
  };
  return success(
    sealState({
      ...structuredClone(state),
      stage: "candidate-batch-approved",
      stateRevision: state.stateRevision + 1,
      updatedAt: input.approvedAt,
      candidates: state.candidates.map((entry) => ({
        ...structuredClone(entry),
        status: candidateIds.includes(entry.candidate.candidateId)
          ? "approved"
          : entry.status,
      })),
      approvals: [...structuredClone(state.approvals), receipt],
    }),
  );
}

function batchApproval(
  state: TesseraOptimizerState,
): Extract<
  TesseraOptimizerApprovalReceipt,
  { approvalKind: "candidate-evaluation-batch" }
> | null {
  return (
    state.approvals.find(
      (approval): approval is Extract<
        TesseraOptimizerApprovalReceipt,
        { approvalKind: "candidate-evaluation-batch" }
      > => approval.approvalKind === "candidate-evaluation-batch",
    ) ?? null
  );
}

function profileCompatible(
  state: TesseraOptimizerState,
  roster: RosterDraftV1,
): boolean {
  const requirements = rosterProfileRequirements(roster);
  const policy = state.baseline.profilePolicy;
  if (!policy) return requirements.length === 0;
  return requirements.every((requirement) =>
    policy.entries.some(
      (entry) =>
        profilePolicyIdentityMatches(entry, requirement) &&
        entry.activeCount === requirement.activeCount &&
        requirement.availableProfiles.some(
          (profile) =>
            profile.trim().toLocaleLowerCase() ===
            entry.selectedProfile.trim().toLocaleLowerCase(),
        ),
    ),
  );
}

function makeComparisonRequest(
  state: TesseraOptimizerState,
  candidate: TesseraChangeCandidate,
  roster: RosterDraftV1,
  approval: Extract<
    TesseraOptimizerApprovalReceipt,
    { approvalKind: "candidate-evaluation-batch" }
  >,
): TesseraOptimizerComparisonRequest {
  const profilePolicyPath = state.frozenIdentities.profile.policyPath;
  const options = {
    executionMode: "simulate" as const,
    experimental: false,
    ...(profilePolicyPath ? { profilePolicyPath } : {}),
  };
  const runRequest: TesseraOptimizerRevisionRunRequest =
    state.baseline.kind === "exact"
      ? {
          kind: "exact-revision",
          baselineReportPath: state.baseline.reportPath,
          revisedRoster: structuredClone(roster),
          options,
        }
      : {
          kind: "stress-revision",
          baselineReportPath: state.baseline.reportPath,
          revisedRoster: structuredClone(roster),
          options,
        };
  const withoutHash = {
    schemaVersion: 1 as const,
    requestKind: "tessera-optimizer-revision" as const,
    optimizerRunId: state.optimizerRunId,
    candidateId: candidate.candidateId,
    contextSha256: state.frozenIdentities.contextSha256,
    candidateBatchApprovalSha256: approval.receiptSha256,
    revisedRosterSha256: tesseraOptimizerCanonicalSha256(roster),
    revisedRosterFingerprint: rosterExecutionFingerprint(roster),
    runRequest,
  };
  return {
    ...withoutHash,
    requestSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
}

const defaultQualifier: TesseraOptimizerCandidateQualifier = async (
  baselineRoster,
  baselineReadiness,
  candidate,
) =>
  qualifyRosterChangeCandidate(
    baselineRoster,
    baselineReadiness,
    candidate.operation,
  );

function emptyPareto(
  state: TesseraOptimizerState,
  generatedAt: string,
): TesseraOptimizerParetoResult {
  const approval = batchApproval(state);
  const withoutHash = {
    schemaVersion: 1 as const,
    policyVersion: TESSERA_OPTIMIZER_HEURISTIC_VERSION,
    optimizerRunId: state.optimizerRunId,
    contextSha256: state.frozenIdentities.contextSha256,
    candidateBatchApprovalSha256: approval?.receiptSha256 ?? "",
    generatedAt,
    candidates: [] as TesseraOptimizerParetoCandidate[],
    frontierCandidateIds: [] as string[],
    dominatedCandidateIds: [] as string[],
    disqualifiedCandidateIds: approval?.candidateIds ?? [],
    baselineRetained: true,
  };
  return {
    ...withoutHash,
    resultSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
}

export async function materializeApprovedTesseraOptimizerCandidates(
  state: TesseraOptimizerState,
  input: {
    currentIdentities: TesseraOptimizerFrozenIdentities;
    materializedAt?: string;
    qualifyCandidate?: TesseraOptimizerCandidateQualifier;
  },
): Promise<TesseraOptimizerResult<TesseraOptimizerState>> {
  const materializedAt =
    input.materializedAt ?? new Date().toISOString();
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    materializedAt,
  );
  if (!guarded.ok) return guarded;
  if (state.stage !== "candidate-batch-approved") {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_BATCH_APPROVAL_REQUIRED",
        "Candidates cannot be materialized until the exact candidate batch has been approved.",
      ),
      state,
    );
  }
  const approval = batchApproval(state);
  if (!approval) {
    return invalidateState(
      state,
      issue(
        "TESSERA_OPTIMIZER_BATCH_APPROVAL_MISSING",
        "The approved stage has no verifiable candidate-batch receipt.",
      ),
      materializedAt,
    );
  }
  const qualify = input.qualifyCandidate ?? defaultQualifier;
  const candidates = structuredClone(state.candidates);
  for (const entry of candidates) {
    if (!approval.candidateIds.includes(entry.candidate.candidateId)) continue;
    const qualified = await qualify(
      structuredClone(state.baseline.roster),
      structuredClone(state.baseline.readiness),
      structuredClone(entry.candidate),
    );
    if (!qualified) {
      entry.status = "rejected-local";
      entry.localRejection = issue(
        "TESSERA_OPTIMIZER_CANDIDATE_LOCAL_GUARDRAIL",
        "The candidate failed legality, hard-constraint, points-utilization, ROSZ exportability, or mission-readiness qualification.",
      );
      continue;
    }
    const validation = validateRoster(qualified.roster);
    const actualFingerprint = rosterExecutionFingerprint(qualified.roster);
    if (
      !validation.ok ||
      qualified.roster.totalPoints !== entry.candidate.afterPoints ||
      entry.candidate.beforePoints !== state.baseline.roster.totalPoints ||
      actualFingerprint !== entry.candidate.rosterFingerprint ||
      qualified.readiness.rosterFingerprint !== actualFingerprint
    ) {
      return invalidateState(
        state,
        issue(
          "TESSERA_OPTIMIZER_CANDIDATE_IDENTITY_MISMATCH",
          `Approved candidate ${entry.candidate.candidateId} did not materialize to its exact points, roster fingerprint, or readiness receipt.`,
        ),
        materializedAt,
      );
    }
    if (!profileCompatible(state, qualified.roster)) {
      entry.status = "rejected-local";
      entry.localRejection = issue(
        "TESSERA_OPTIMIZER_PROFILE_POLICY_CHANGED",
        "This candidate needs a profile choice not covered by the exact baseline policy; create a new baseline instead.",
      );
      continue;
    }
    entry.status = "ready-for-comparison";
    entry.revisedRoster = structuredClone(qualified.roster);
    entry.revisedRosterSha256 =
      tesseraOptimizerCanonicalSha256(qualified.roster);
    entry.readiness = structuredClone(qualified.readiness);
    entry.comparisonRequest = makeComparisonRequest(
      state,
      entry.candidate,
      qualified.roster,
      approval,
    );
  }
  const ready = candidates.filter(
    (entry) => entry.status === "ready-for-comparison",
  );
  const next = sealState({
    ...structuredClone(state),
    stage:
      ready.length > 0 ? "comparisons-pending" : "baseline-retained",
    stateRevision: state.stateRevision + 1,
    updatedAt: materializedAt,
    candidates,
    pareto: ready.length > 0 ? null : emptyPareto(state, materializedAt),
  });
  return success(next);
}

export function approvedTesseraOptimizerComparisonRequests(
  state: TesseraOptimizerState,
  currentIdentities: TesseraOptimizerFrozenIdentities,
): TesseraOptimizerResult<TesseraOptimizerComparisonRequest[]> {
  const guarded = guardTransition(state, currentIdentities);
  if (!guarded.ok) {
    return {
      ...guarded,
      data: guarded.data
        ? guarded.data.candidates.flatMap((entry) =>
            entry.comparisonRequest ? [entry.comparisonRequest] : [],
          )
        : null,
    };
  }
  if (state.stage !== "comparisons-pending") {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_COMPARISONS_NOT_AUTHORIZED",
        "Paired revision requests exist only after batch approval and local qualification.",
      ),
    );
  }
  return success(
    state.candidates.flatMap((entry) =>
      entry.status === "ready-for-comparison" && entry.comparisonRequest
        ? [structuredClone(entry.comparisonRequest)]
        : [],
    ),
  );
}

function readinessRank(band: TesseraMissionReadinessBand): number {
  if (band === "green") return 3;
  if (band === "amber") return 2;
  if (band === "red") return 1;
  return 0;
}

function commonObjectiveDimensions(
  state: TesseraOptimizerState,
  candidate: TesseraOptimizerMaterializedCandidate,
): TesseraOptimizerObjectiveDimension[] {
  return [
    {
      id: "mission-readiness",
      value: readinessRank(candidate.readiness?.overallBand ?? "unknown"),
      direction: "maximize",
      materiality: 0,
    },
    {
      id: "points-utilization",
      value:
        (candidate.revisedRoster?.totalPoints ?? 0) /
        Math.max(1, state.baseline.roster.pointsLimit),
      direction: "maximize",
      materiality: 0.001,
    },
  ];
}

function exactComparisonEvidence(
  state: TesseraOptimizerState,
  candidate: TesseraOptimizerMaterializedCandidate,
  report: TesseraRevisionComparisonReport,
  artifactSha256: string | null,
): TesseraOptimizerComparisonEvidence | TesseraOptimizerIssue {
  const counts = report.summary.aggregateCounts;
  if (
    report.schemaVersion !== 2 ||
    report.baselineRunId !== state.baseline.runId ||
    report.revisedRosterFingerprint !== candidate.candidate.rosterFingerprint ||
    report.summary.conclusionBasis !== "trusted-roster-aggregates" ||
    !counts ||
    !report.summary.conclusion ||
    !report.aggregates?.length
  ) {
    return issue(
      "TESSERA_OPTIMIZER_EXACT_COMPARISON_MISMATCH",
      "The exact comparison is not the complete trusted paired report for this baseline and candidate.",
    );
  }
  if (
    report.revisedReports.length === 0 ||
    report.revisedReports.some(
      (revised) =>
        revised.player.fingerprint !==
          candidate.candidate.rosterFingerprint ||
        !revised.runtime ||
        tesseraOptimizerRuntimeIdentitySha256(revised.runtime) !==
          state.frozenIdentities.runtime.evaluationSha256,
    )
  ) {
    return issue(
      "TESSERA_OPTIMIZER_COMPARISON_RUNTIME_MISMATCH",
      "The exact comparison did not run entirely on the frozen evaluation runtime and revised roster.",
    );
  }
  const objectiveDimensions = report.aggregates
    .map((aggregate, index) => ({
      id: [
        "exact",
        aggregate.metric,
        aggregate.direction,
        [...aggregate.opponentNames].sort().join(","),
        [...aggregate.phases].sort().join(","),
        index,
      ].join(":"),
      value: aggregate.directionalChange ?? Number.NaN,
      direction: "maximize" as const,
      materiality: aggregate.materialityThreshold ?? 0,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const reasons: string[] = [];
  if (report.summary.conclusion !== "improved") {
    reasons.push("paired conclusion is not improved");
  }
  if (counts.improved === 0 || counts.worsened > 0) {
    reasons.push("trusted aggregates do not prove a no-regression improvement");
  }
  if (
    counts.ambiguous > 0 ||
    objectiveDimensions.some(({ value }) => !Number.isFinite(value))
  ) {
    reasons.push("trusted objectives are missing or ambiguous");
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    comparisonKind: "exact" as const,
    candidateId: candidate.candidate.candidateId,
    baselineRunId: report.baselineRunId,
    revisedRosterFingerprint: report.revisedRosterFingerprint,
    reportRunId: report.runId,
    reportCanonicalSha256: tesseraOptimizerCanonicalSha256(report),
    reportArtifactSha256: artifactSha256,
    conclusion: report.summary.conclusion,
    qualified: reasons.length === 0,
    disqualificationReasons: reasons,
    objectiveDimensions: [
      ...objectiveDimensions,
      ...commonObjectiveDimensions(state, candidate),
    ],
    summary: {
      improved: counts.improved,
      worsened: counts.worsened,
      unchanged: counts.unchanged,
      ambiguous: counts.ambiguous,
    },
    missionReadinessGuardrailAccepted: true,
  };
  return {
    ...withoutHash,
    evidenceSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
}

function stressComparisonEvidence(
  state: TesseraOptimizerState,
  candidate: TesseraOptimizerMaterializedCandidate,
  report: TesseraStressRevisionReport,
  artifactSha256: string | null,
): TesseraOptimizerComparisonEvidence | TesseraOptimizerIssue {
  if (
    report.schemaVersion !== 2 ||
    report.reportKind !== "tessera-stress-revision" ||
    report.baselineRunId !== state.baseline.runId ||
    report.revisedRosterFingerprint !== candidate.candidate.rosterFingerprint ||
    tesseraOptimizerCanonicalSha256(report.baseline) !==
      state.frozenIdentities.baseline.reportCanonicalSha256 ||
    report.baseline.portfolioSha256 !==
      state.frozenIdentities.portfolio.declaredSha256 ||
    report.revised.portfolioSha256 !==
      state.frozenIdentities.portfolio.declaredSha256 ||
    !report.revised.runtime ||
    tesseraOptimizerRuntimeIdentitySha256(report.revised.runtime) !==
      state.frozenIdentities.runtime.evaluationSha256
  ) {
    return issue(
      "TESSERA_OPTIMIZER_STRESS_COMPARISON_MISMATCH",
      "The stress comparison is not the exact frozen-portfolio paired report for this candidate and evaluation runtime.",
    );
  }
  const objectiveDimensions = report.sampleDeltas
    .map((delta) => ({
      id: `stress-margin:${delta.templateId}`,
      value: delta.marginChange ?? Number.NaN,
      direction: "maximize" as const,
      materiality: state.heuristicParameters.stressMateriality,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const reasons: string[] = [];
  if (report.summary.conclusion !== "better") {
    reasons.push("paired stress conclusion is not better");
  }
  if (!report.missionReadinessGuardrail.accepted) {
    reasons.push("mission-readiness guardrail rejected the revision");
  }
  if (
    report.summary.ambiguous > 0 ||
    objectiveDimensions.length === 0 ||
    objectiveDimensions.some(({ value }) => !Number.isFinite(value))
  ) {
    reasons.push("stress objectives are missing or ambiguous");
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    comparisonKind: "stress" as const,
    candidateId: candidate.candidate.candidateId,
    baselineRunId: report.baselineRunId,
    revisedRosterFingerprint: report.revisedRosterFingerprint,
    reportRunId: report.runId,
    reportCanonicalSha256: tesseraOptimizerCanonicalSha256(report),
    reportArtifactSha256: artifactSha256,
    conclusion: report.summary.conclusion,
    qualified: reasons.length === 0,
    disqualificationReasons: reasons,
    objectiveDimensions: [
      ...objectiveDimensions,
      ...commonObjectiveDimensions(state, candidate),
    ],
    summary: structuredClone(report.summary),
    missionReadinessGuardrailAccepted:
      report.missionReadinessGuardrail.accepted,
  };
  return {
    ...withoutHash,
    evidenceSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
}

function dominates(
  left: TesseraOptimizerObjectiveDimension[],
  right: TesseraOptimizerObjectiveDimension[],
): boolean {
  const leftById = new Map(left.map((dimension) => [dimension.id, dimension]));
  if (
    left.length !== right.length ||
    right.some((dimension) => !leftById.has(dimension.id))
  ) {
    return false;
  }
  let materiallyBetter = false;
  for (const rightDimension of right) {
    const leftDimension = leftById.get(rightDimension.id)!;
    const threshold = Math.max(
      leftDimension.materiality,
      rightDimension.materiality,
    );
    const change = leftDimension.value - rightDimension.value;
    if (change < -threshold) return false;
    if (change > threshold) materiallyBetter = true;
  }
  return materiallyBetter;
}

function computePareto(
  state: TesseraOptimizerState,
  generatedAt: string,
): TesseraOptimizerParetoResult {
  const approval = batchApproval(state)!;
  const completed = state.candidates.filter(
    (candidate) => approval.candidateIds.includes(candidate.candidate.candidateId),
  );
  const candidates: TesseraOptimizerParetoCandidate[] = completed.map(
    (candidate) => ({
      candidateId: candidate.candidate.candidateId,
      rosterFingerprint: candidate.candidate.rosterFingerprint,
      rosterSha256: candidate.revisedRosterSha256 ?? "",
      comparisonEvidenceSha256:
        candidate.comparison?.evidenceSha256 ?? "",
      qualified: candidate.comparison?.qualified ?? false,
      disqualificationReasons:
        candidate.comparison?.disqualificationReasons ?? [
          candidate.localRejection?.message ??
            "No complete paired comparison evidence was recorded.",
        ],
      objectiveDimensions:
        candidate.comparison?.objectiveDimensions ?? [],
      dominatedByCandidateIds: [],
    }),
  );
  const objectiveSignatures = new Set(
    candidates
      .filter((candidate) => candidate.qualified)
      .map((candidate) =>
        candidate.objectiveDimensions
          .map((dimension) => dimension.id)
          .sort()
          .join("|"),
      ),
  );
  if (objectiveSignatures.size > 1) {
    for (const candidate of candidates) {
      if (!candidate.qualified) continue;
      candidate.qualified = false;
      candidate.disqualificationReasons.push(
        "Paired candidates did not expose one identical objective contract.",
      );
    }
  }
  for (const candidate of candidates) {
    if (!candidate.qualified) continue;
    candidate.dominatedByCandidateIds = candidates
      .filter(
        (other) =>
          other.qualified &&
          other.candidateId !== candidate.candidateId &&
          dominates(
            other.objectiveDimensions,
            candidate.objectiveDimensions,
          ),
      )
      .map(({ candidateId }) => candidateId)
      .sort();
  }
  candidates.sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
  const frontierCandidateIds = candidates
    .filter(
      (candidate) =>
        candidate.qualified &&
        candidate.dominatedByCandidateIds.length === 0,
    )
    .map(({ candidateId }) => candidateId);
  const withoutHash = {
    schemaVersion: 1 as const,
    policyVersion: TESSERA_OPTIMIZER_HEURISTIC_VERSION,
    optimizerRunId: state.optimizerRunId,
    contextSha256: state.frozenIdentities.contextSha256,
    candidateBatchApprovalSha256: approval.receiptSha256,
    generatedAt,
    candidates,
    frontierCandidateIds,
    dominatedCandidateIds: candidates
      .filter(({ dominatedByCandidateIds }) => dominatedByCandidateIds.length > 0)
      .map(({ candidateId }) => candidateId),
    disqualifiedCandidateIds: candidates
      .filter(({ qualified }) => !qualified)
      .map(({ candidateId }) => candidateId),
    baselineRetained: frontierCandidateIds.length === 0,
  };
  return {
    ...withoutHash,
    resultSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
}

export function recordTesseraOptimizerComparison(
  state: TesseraOptimizerState,
  input: {
    currentIdentities: TesseraOptimizerFrozenIdentities;
    candidateId: string;
    report: TesseraRevisionComparisonReport | TesseraStressRevisionReport;
    reportArtifactSha256?: string | null;
    recordedAt?: string;
    verifiedBaselineReportPath?: string;
    verifiedBaselineReportSha256?: string;
  },
): TesseraOptimizerResult<TesseraOptimizerState> {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    recordedAt,
  );
  if (!guarded.ok) return guarded;
  if (state.stage !== "comparisons-pending") {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_COMPARISON_NOT_AUTHORIZED",
        "Comparison evidence can only be recorded after an approved batch was locally qualified.",
      ),
      state,
    );
  }
  if (
    input.reportArtifactSha256 != null &&
    !isSha256(input.reportArtifactSha256)
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_COMPARISON_HASH_INVALID",
        "The comparison artifact hash must be a lowercase SHA-256 value.",
      ),
      state,
    );
  }
  const candidate = state.candidates.find(
    (entry) => entry.candidate.candidateId === input.candidateId,
  );
  if (
    !candidate ||
    candidate.status !== "ready-for-comparison" ||
    !candidate.comparisonRequest ||
    !candidate.revisedRoster
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_CANDIDATE_NOT_AUTHORIZED",
        "The comparison does not belong to an approved, locally qualified candidate.",
      ),
      state,
    );
  }
  const observedPath = input.report.baselineReportPath;
  if (observedPath !== state.baseline.reportPath) {
    const acceptedHash = state.frozenIdentities.baseline.reportArtifactSha256;
    if (
      input.verifiedBaselineReportPath !== observedPath ||
      !acceptedHash ||
      input.verifiedBaselineReportSha256 !== acceptedHash
    ) {
      return invalidateState(
        state,
        issue(
          "TESSERA_OPTIMIZER_BASELINE_PATH_MISMATCH",
          "The comparison references a different baseline path without a matching frozen-artifact receipt.",
        ),
        recordedAt,
      );
    }
  }
  const evidence =
    state.baseline.kind === "exact" &&
    !("reportKind" in input.report)
      ? exactComparisonEvidence(
          state,
          candidate,
          input.report,
          input.reportArtifactSha256 ?? null,
        )
      : state.baseline.kind === "stress" &&
          "reportKind" in input.report
        ? stressComparisonEvidence(
            state,
            candidate,
            input.report,
            input.reportArtifactSha256 ?? null,
          )
        : issue(
            "TESSERA_OPTIMIZER_COMPARISON_KIND_MISMATCH",
            "The comparison kind does not match the frozen baseline kind.",
          );
  if ("severity" in evidence) {
    return invalidateState(state, evidence, recordedAt);
  }
  const candidates = state.candidates.map((entry) =>
    entry.candidate.candidateId === input.candidateId
      ? {
          ...structuredClone(entry),
          status: "comparison-complete" as const,
          comparison: evidence,
        }
      : structuredClone(entry),
  );
  const nextDraft = sealState({
    ...structuredClone(state),
    stateRevision: state.stateRevision + 1,
    updatedAt: recordedAt,
    candidates,
  });
  const approval = batchApproval(nextDraft)!;
  const finished = approval.candidateIds.every((candidateId) => {
    const entry = nextDraft.candidates.find(
      (candidate) => candidate.candidate.candidateId === candidateId,
    );
    return (
      entry?.status === "rejected-local" ||
      entry?.status === "comparison-complete"
    );
  });
  if (!finished) return success(nextDraft);
  const pareto = computePareto(nextDraft, recordedAt);
  return success(
    sealState({
      ...structuredClone(nextDraft),
      stage: pareto.baselineRetained
        ? "baseline-retained"
        : "pareto-ready",
      pareto,
    }),
  );
}

export function paretoTesseraOptimizerCandidates(
  state: TesseraOptimizerState,
  currentIdentities: TesseraOptimizerFrozenIdentities,
): TesseraOptimizerResult<TesseraOptimizerParetoResult> {
  const verified = verifyTesseraOptimizerState(state, currentIdentities);
  if (!verified.ok) return { ...verified, data: null };
  if (!state.pareto) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_PARETO_NOT_READY",
        "Pareto results are available only after every approved candidate reaches a terminal local or paired result.",
      ),
    );
  }
  return success(structuredClone(state.pareto));
}

export function approveTesseraOptimizerWinner(
  state: TesseraOptimizerState,
  input: {
    currentIdentities: TesseraOptimizerFrozenIdentities;
    expectedStateRevision: number;
    candidateId: string;
    approvalId: string;
    approvedBy: string;
    approvedAt: string;
  },
): TesseraOptimizerResult<TesseraOptimizerState> {
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    input.approvedAt,
  );
  if (!guarded.ok) return guarded;
  if (
    state.mode !== "guided" ||
    state.stage !== "pareto-ready" ||
    !state.pareto ||
    input.expectedStateRevision !== state.stateRevision
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_WINNER_APPROVAL_NOT_READY",
        "Winner approval must target the exact current Pareto result in guided mode.",
      ),
      state,
    );
  }
  if (
    !state.pareto.frontierCandidateIds.includes(input.candidateId) ||
    !input.approvalId.trim() ||
    !input.approvedBy.trim() ||
    !isIsoTimestamp(input.approvedAt)
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_WINNER_APPROVAL_INVALID",
        "The exact winner must be one candidate on the current Pareto frontier with an explicit approval identity.",
      ),
      state,
    );
  }
  const candidate = state.candidates.find(
    (entry) => entry.candidate.candidateId === input.candidateId,
  );
  const batch = batchApproval(state);
  if (
    !candidate?.revisedRoster ||
    !candidate.revisedRosterSha256 ||
    !candidate.comparison ||
    !batch
  ) {
    return invalidateState(
      state,
      issue(
        "TESSERA_OPTIMIZER_WINNER_EVIDENCE_MISSING",
        "The selected Pareto winner has no exact roster, batch approval, or comparison evidence receipt.",
      ),
      input.approvedAt,
    );
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    approvalKind: "optimizer-exact-winner" as const,
    approvalId: input.approvalId,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    optimizerRunId: state.optimizerRunId,
    expectedStateRevision: input.expectedStateRevision,
    frozenIdentities: structuredClone(state.frozenIdentities),
    candidateBatchApprovalSha256: batch.receiptSha256,
    paretoResultSha256: state.pareto.resultSha256,
    candidateId: input.candidateId,
    candidateRosterSha256: candidate.revisedRosterSha256,
    candidateRosterFingerprint: candidate.candidate.rosterFingerprint,
    comparisonEvidenceSha256: candidate.comparison.evidenceSha256,
  };
  const receipt: TesseraOptimizerApprovalReceipt = {
    ...withoutHash,
    receiptSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
  return success(
    sealState({
      ...structuredClone(state),
      stage: "winner-approved",
      stateRevision: state.stateRevision + 1,
      updatedAt: input.approvedAt,
      approvals: [...structuredClone(state.approvals), receipt],
    }),
  );
}

export function retainTesseraOptimizerBaseline(
  state: TesseraOptimizerState,
  input: {
    currentIdentities: TesseraOptimizerFrozenIdentities;
    expectedStateRevision: number;
    approvalId: string;
    approvedBy: string;
    approvedAt: string;
  },
): TesseraOptimizerResult<TesseraOptimizerState> {
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    input.approvedAt,
  );
  if (!guarded.ok) return guarded;
  const batch = batchApproval(state);
  if (
    state.mode !== "guided" ||
    state.stage !== "pareto-ready" ||
    !state.pareto ||
    !batch ||
    input.expectedStateRevision !== state.stateRevision
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_BASELINE_RETENTION_NOT_READY",
        "Baseline retention must target the exact current Pareto result in guided mode.",
      ),
      state,
    );
  }
  if (
    !input.approvalId.trim() ||
    !input.approvedBy.trim() ||
    !isIsoTimestamp(input.approvedAt)
  ) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_BASELINE_RETENTION_INVALID",
        "Keeping the baseline requires an explicit approval identity and timestamp.",
      ),
      state,
    );
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    approvalKind: "optimizer-baseline-retention" as const,
    approvalId: input.approvalId,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    optimizerRunId: state.optimizerRunId,
    expectedStateRevision: input.expectedStateRevision,
    frozenIdentities: structuredClone(state.frozenIdentities),
    candidateBatchApprovalSha256: batch.receiptSha256,
    paretoResultSha256: state.pareto.resultSha256,
  };
  const receipt: TesseraOptimizerApprovalReceipt = {
    ...withoutHash,
    receiptSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
  return success(
    sealState({
      ...structuredClone(state),
      stage: "baseline-retained",
      stateRevision: state.stateRevision + 1,
      updatedAt: input.approvedAt,
      approvals: [...structuredClone(state.approvals), receipt],
    }),
  );
}

function winnerApproval(
  state: TesseraOptimizerState,
): Extract<
  TesseraOptimizerApprovalReceipt,
  { approvalKind: "optimizer-exact-winner" }
> | null {
  return (
    state.approvals.find(
      (approval): approval is Extract<
        TesseraOptimizerApprovalReceipt,
        { approvalKind: "optimizer-exact-winner" }
      > => approval.approvalKind === "optimizer-exact-winner",
    ) ?? null
  );
}

function validDeliveryIntent(
  intent: TesseraOptimizerDeliveryIntent,
): boolean {
  if (!isIsoTimestamp(intent.recordedAt)) return false;
  return intent.kind === "none"
    ? intent.intentId === null && intent.recordedBy === null
    : Boolean(intent.intentId.trim() && intent.recordedBy.trim());
}

export function finalizeTesseraOptimizer(
  state: TesseraOptimizerState,
  input: {
    currentIdentities: TesseraOptimizerFrozenIdentities;
    deliveryIntent: TesseraOptimizerDeliveryIntent;
    finalizedAt?: string;
  },
): TesseraOptimizerResult<TesseraOptimizerState> {
  const finalizedAt = input.finalizedAt ?? new Date().toISOString();
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    finalizedAt,
  );
  if (!guarded.ok) return guarded;
  if (!validDeliveryIntent(input.deliveryIntent)) {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_DELIVERY_INTENT_INVALID",
        "Delivery intent must be explicit, timestamped, and independently identified when non-empty.",
      ),
      state,
    );
  }
  let roster: RosterDraftV1;
  let candidateId: string | null = null;
  let disposition: TesseraOptimizerFinalization["disposition"];
  let winnerReceiptSha256: string | null = null;
  if (
    state.mode === "recommend-only" &&
    state.stage === "recommendations-ready"
  ) {
    if (input.deliveryIntent.kind !== "none") {
      return failure(
        issue(
          "TESSERA_OPTIMIZER_RECOMMEND_ONLY_DELIVERY_BLOCKED",
          "Recommend-only mode can retain the baseline but cannot express delivery intent.",
        ),
        state,
      );
    }
    roster = state.baseline.roster;
    disposition = "baseline-retained";
  } else if (state.stage === "baseline-retained") {
    if (input.deliveryIntent.kind !== "none") {
      return failure(
        issue(
          "TESSERA_OPTIMIZER_BASELINE_DELIVERY_BLOCKED",
          "No qualified winner exists, so the optimizer can only retain the baseline without delivery intent.",
        ),
        state,
      );
    }
    roster = state.baseline.roster;
    disposition = "baseline-retained";
  } else if (state.stage === "winner-approved") {
    const winner = winnerApproval(state);
    const candidate = winner
      ? state.candidates.find(
          (entry) => entry.candidate.candidateId === winner.candidateId,
        )
      : null;
    if (
      !winner ||
      !candidate?.revisedRoster ||
      candidate.revisedRosterSha256 !== winner.candidateRosterSha256
    ) {
      return invalidateState(
        state,
        issue(
          "TESSERA_OPTIMIZER_WINNER_APPROVAL_MISMATCH",
          "The winner approval no longer binds the exact candidate roster being finalized.",
        ),
        finalizedAt,
      );
    }
    roster = candidate.revisedRoster;
    candidateId = candidate.candidate.candidateId;
    disposition = "winner-finalized";
    winnerReceiptSha256 = winner.receiptSha256;
  } else {
    return failure(
      issue(
        "TESSERA_OPTIMIZER_FINALIZATION_NOT_AUTHORIZED",
        "A changed roster needs exact winner approval; otherwise only a terminal baseline-retained state may finalize.",
      ),
      state,
    );
  }
  const withoutHash = {
    disposition,
    candidateId,
    roster: structuredClone(roster),
    rosterSha256: tesseraOptimizerCanonicalSha256(roster),
    rosterFingerprint: rosterExecutionFingerprint(roster),
    winnerApprovalReceiptSha256: winnerReceiptSha256,
    deliveryIntent: structuredClone(input.deliveryIntent),
    finalizedAt,
  };
  const finalization: TesseraOptimizerFinalization = {
    ...withoutHash,
    finalizationSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
  return success(
    sealState({
      ...structuredClone(state),
      stage: "finalized",
      stateRevision: state.stateRevision + 1,
      updatedAt: finalizedAt,
      finalization,
    }),
  );
}
