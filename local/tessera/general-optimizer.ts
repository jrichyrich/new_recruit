import { randomUUID } from "node:crypto";

import {
  GeneralThreatArchetypeIds,
  generalThreatPortfolioHash,
  type GeneralThreatArchetype,
  type GeneralThreatPortfolio,
} from "../../lib/rosterpilot/general-threat-portfolio";
import {
  exportRoster,
  rosterProfileRequirements,
  validateRoster,
} from "../../lib/rosterpilot/engine";
import {
  rosterExecutionFingerprint,
  rosterSimulationFingerprint,
} from "../../lib/rosterpilot/stress-portfolio";
import type {
  ProfilePolicyV1,
  RosterDraftV1,
  RuntimeProvenance,
  TesseraChangeCandidate,
  TesseraMatchupReport,
  TesseraMissionReadinessReport,
  TesseraProfileRequirement,
  TesseraRevisionComparisonReport,
} from "../../lib/rosterpilot/types";
import {
  MINIMUM_CHANGE_CANDIDATE_UTILIZATION,
  qualifyRosterChangeCandidate,
} from "./candidate-quality";
import type { TesseraRunRequest } from "./jobs";
import {
  createTesseraOptimizerState,
  tesseraOptimizerCanonicalSha256,
  tesseraOptimizerRuntimeIdentitySha256,
  type TesseraOptimizerCandidateQualifier,
  type TesseraOptimizerDeliveryIntent,
  type TesseraOptimizerFinalization,
  type TesseraOptimizerFrozenIdentities,
  type TesseraOptimizerIssue,
  type TesseraOptimizerMode,
  type TesseraOptimizerObjectiveDimension,
  type TesseraOptimizerResult,
} from "./optimizer";
import {
  profilePolicyIdentityMatches,
} from "./profile-policy";

export const TESSERA_GENERAL_OPTIMIZER_SCHEMA_VERSION = 1;
export const TESSERA_GENERAL_OPTIMIZER_HEURISTIC_VERSION =
  "tessera-general-six-pareto-v1" as const;

const sha256Pattern = /^[0-9a-f]{64}$/;

export type TesseraGeneralOptimizerStage =
  | "recommendations-ready"
  | "candidate-batch-approved"
  | "comparisons-pending"
  | "pareto-ready"
  | "winner-approved"
  | "baseline-retained"
  | "finalized"
  | "invalidated";

export type TesseraGeneralOptimizerBaselineInput = {
  archetypeId: GeneralThreatArchetype;
  reportPath: string;
  report: TesseraMatchupReport;
  reportArtifactSha256?: string | null;
  profilePolicy?: ProfilePolicyV1 | null;
  profilePolicyPath?: string | null;
  profilePolicyArtifactSha256?: string | null;
};

export type TesseraGeneralOptimizerBaselineIdentity = {
  archetypeId: GeneralThreatArchetype;
  label: string;
  reportPath: string;
  runId: string;
  reportCanonicalSha256: string;
  reportArtifactSha256: string;
  scenarioContractSha256: string;
  memberContractSha256: string;
  opponentRosterFingerprint: string;
  opponentSimulationFingerprint: string;
  baselineRuntimeSha256: string;
  tesseraUiIdentity: string;
  profilePolicyHash: string | null;
  profilePolicyPath: string | null;
  profilePolicyArtifactSha256: string | null;
  profileRequirementsSha256: string;
};

export type TesseraGeneralOptimizerFrozenIdentities = {
  player: {
    rosterSha256: string;
    rosterFingerprint: string;
  };
  bundle: TesseraOptimizerFrozenIdentities["bundle"];
  portfolio: {
    version: GeneralThreatPortfolio["version"];
    pointsLimit: GeneralThreatPortfolio["pointsLimit"];
    portfolioHash: string;
    artifactSha256: string;
    contractSha256: string;
  };
  baselines: TesseraGeneralOptimizerBaselineIdentity[];
  scenarioConfigurationSha256: string;
  heuristic: {
    version: typeof TESSERA_GENERAL_OPTIMIZER_HEURISTIC_VERSION;
    parametersSha256: string;
  };
  runtime: {
    baselineSha256: string;
    evaluationSha256: string;
  };
  contextSha256: string;
};

export type TesseraGeneralOptimizerBaseline = {
  archetypeId: GeneralThreatArchetype;
  label: string;
  reportPath: string;
  runId: string;
  opponentRosterFingerprint: string;
  profilePolicy: ProfilePolicyV1 | null;
  frozenProfileRequirements: TesseraProfileRequirement[];
};

export type TesseraGeneralOptimizerCandidateSource = {
  archetypeId: GeneralThreatArchetype;
  baselineRunId: string;
  title: string;
  rationale: string;
  evidenceFindingIds: string[];
};

export type TesseraGeneralOptimizerComparisonRequest = {
  schemaVersion: 1;
  requestKind: "tessera-general-optimizer-revision";
  optimizerRunId: string;
  candidateId: string;
  archetypeId: GeneralThreatArchetype;
  contextSha256: string;
  baselineRunId: string;
  baselineReportArtifactSha256: string;
  memberContractSha256: string;
  candidateBatchApprovalSha256: string;
  revisedRosterSha256: string;
  revisedRosterFingerprint: string;
  runRequest: Extract<TesseraRunRequest, { kind: "exact-revision" }>;
  requestSha256: string;
};

export type TesseraGeneralOptimizerComparisonEvidence = {
  schemaVersion: 1;
  candidateId: string;
  archetypeId: GeneralThreatArchetype;
  requestSha256: string;
  baselineRunId: string;
  revisedRosterFingerprint: string;
  reportRunId: string;
  reportCanonicalSha256: string;
  reportArtifactSha256: string;
  conclusion: "improved" | "worsened" | "mixed" | "unchanged";
  objectiveDimensions: TesseraOptimizerObjectiveDimension[];
  summary: {
    improved: number;
    worsened: number;
    unchanged: number;
    ambiguous: number;
  };
  evidenceSha256: string;
};

export type TesseraGeneralOptimizerCandidate = {
  candidate: TesseraChangeCandidate;
  sources: TesseraGeneralOptimizerCandidateSource[];
  status:
    | "proposed"
    | "approved"
    | "rejected-local"
    | "ready-for-comparisons"
    | "comparisons-complete";
  revisedRoster: RosterDraftV1 | null;
  revisedRosterSha256: string | null;
  readiness: TesseraMissionReadinessReport | null;
  localRejection: TesseraOptimizerIssue | null;
  comparisonRequests: TesseraGeneralOptimizerComparisonRequest[];
  comparisons: TesseraGeneralOptimizerComparisonEvidence[];
};

export type TesseraGeneralOptimizerApprovalReceipt =
  | {
      schemaVersion: 1;
      approvalKind: "general-candidate-evaluation-batch";
      approvalId: string;
      approvedBy: string;
      approvedAt: string;
      optimizerRunId: string;
      expectedStateRevision: number;
      frozenIdentities: TesseraGeneralOptimizerFrozenIdentities;
      candidateIds: string[];
      candidateBatchSha256: string;
      receiptSha256: string;
    }
  | {
      schemaVersion: 1;
      approvalKind: "general-optimizer-exact-winner";
      approvalId: string;
      approvedBy: string;
      approvedAt: string;
      optimizerRunId: string;
      expectedStateRevision: number;
      frozenIdentities: TesseraGeneralOptimizerFrozenIdentities;
      candidateBatchApprovalSha256: string;
      paretoResultSha256: string;
      candidateId: string;
      candidateRosterSha256: string;
      candidateRosterFingerprint: string;
      aggregateEvidenceSha256: string;
      receiptSha256: string;
    }
  | {
      schemaVersion: 1;
      approvalKind: "general-optimizer-baseline-retention";
      approvalId: string;
      approvedBy: string;
      approvedAt: string;
      optimizerRunId: string;
      expectedStateRevision: number;
      frozenIdentities: TesseraGeneralOptimizerFrozenIdentities;
      candidateBatchApprovalSha256: string;
      paretoResultSha256: string;
      receiptSha256: string;
    };

export type TesseraGeneralOptimizerParetoCandidate = {
  candidateId: string;
  rosterFingerprint: string;
  rosterSha256: string;
  aggregateEvidenceSha256: string;
  qualified: boolean;
  disqualificationReasons: string[];
  objectiveDimensions: TesseraOptimizerObjectiveDimension[];
  dominatedByCandidateIds: string[];
};

export type TesseraGeneralOptimizerParetoResult = {
  schemaVersion: 1;
  policyVersion: typeof TESSERA_GENERAL_OPTIMIZER_HEURISTIC_VERSION;
  optimizerRunId: string;
  contextSha256: string;
  candidateBatchApprovalSha256: string;
  generatedAt: string;
  candidates: TesseraGeneralOptimizerParetoCandidate[];
  frontierCandidateIds: string[];
  dominatedCandidateIds: string[];
  disqualifiedCandidateIds: string[];
  baselineRetained: boolean;
  resultSha256: string;
};

export type TesseraGeneralOptimizerState = {
  schemaVersion: 1;
  coordinatorKind: "rosterpilot-tessera-general-six-optimizer";
  optimizerRunId: string;
  mode: TesseraOptimizerMode;
  stage: TesseraGeneralOptimizerStage;
  stateRevision: number;
  createdAt: string;
  updatedAt: string;
  frozenIdentities: TesseraGeneralOptimizerFrozenIdentities;
  baselineRoster: RosterDraftV1;
  baselineReadiness: TesseraMissionReadinessReport;
  portfolio: GeneralThreatPortfolio;
  baselines: TesseraGeneralOptimizerBaseline[];
  baselineSuggestions: {
    pairing: "unpaired";
    evidenceClass: "six-unpaired-baseline-suggestions";
    statements: Array<{
      archetypeId: GeneralThreatArchetype;
      statements: string[];
    }>;
    caveat: string;
  };
  candidates: TesseraGeneralOptimizerCandidate[];
  approvals: TesseraGeneralOptimizerApprovalReceipt[];
  pareto: TesseraGeneralOptimizerParetoResult | null;
  finalization: TesseraOptimizerFinalization | null;
  invalidation: TesseraOptimizerIssue | null;
  integritySha256: string;
};

export type CreateTesseraGeneralOptimizerStateInput = {
  mode?: TesseraOptimizerMode;
  optimizerRunId?: string;
  createdAt?: string;
  baselineRoster: RosterDraftV1;
  portfolio: GeneralThreatPortfolio;
  portfolioArtifactSha256: string;
  baselines: TesseraGeneralOptimizerBaselineInput[];
  evaluationRuntime: RuntimeProvenance;
};

const heuristicParameters = {
  qualificationVersion: "candidate-quality-v1",
  profileCompatibilityVersion: "all-six-frozen-profile-subset-v1",
  paretoVersion: TESSERA_GENERAL_OPTIMIZER_HEURISTIC_VERSION,
  minimumPointsUtilization: MINIMUM_CHANGE_CANDIDATE_UTILIZATION,
  qualificationRule:
    "at-least-one-trusted-improvement-and-no-worsened-or-ambiguous-aggregate",
  requireIdenticalObjectiveContracts: true,
  requireAllSixComparisons: true,
} as const;

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

function isIsoTimestamp(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && sha256Pattern.test(value);
}

function stateHash(state: TesseraGeneralOptimizerState): string {
  return tesseraOptimizerCanonicalSha256({
    ...state,
    integritySha256: undefined,
  });
}

function sealState(
  state: Omit<TesseraGeneralOptimizerState, "integritySha256"> & {
    integritySha256?: string;
  },
): TesseraGeneralOptimizerState {
  const pending = {
    ...state,
    integritySha256: "",
  } as TesseraGeneralOptimizerState;
  return {
    ...pending,
    integritySha256: stateHash(pending),
  };
}

function receiptHash(
  receipt: TesseraGeneralOptimizerApprovalReceipt,
): string {
  return tesseraOptimizerCanonicalSha256({
    ...receipt,
    receiptSha256: undefined,
  });
}

function requestHash(
  request: TesseraGeneralOptimizerComparisonRequest,
): string {
  return tesseraOptimizerCanonicalSha256({
    ...request,
    requestSha256: undefined,
  });
}

function evidenceHash(
  evidence: TesseraGeneralOptimizerComparisonEvidence,
): string {
  return tesseraOptimizerCanonicalSha256({
    ...evidence,
    evidenceSha256: undefined,
  });
}

function paretoHash(result: TesseraGeneralOptimizerParetoResult): string {
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

function frozenIdentityHash(
  identities: TesseraGeneralOptimizerFrozenIdentities,
): string {
  const { contextSha256, ...payload } = identities;
  void contextSha256;
  return tesseraOptimizerCanonicalSha256(payload);
}

function archetypeRank(archetypeId: GeneralThreatArchetype): number {
  return GeneralThreatArchetypeIds.indexOf(archetypeId);
}

function compareArchetypes(
  left: { archetypeId: GeneralThreatArchetype },
  right: { archetypeId: GeneralThreatArchetype },
): number {
  return archetypeRank(left.archetypeId) - archetypeRank(right.archetypeId);
}

function sharedBundleContract(roster: RosterDraftV1): {
  bundleId: string;
  engineDataSchemaVersion: number;
} {
  return {
    bundleId: roster.sourceData.bundleId,
    engineDataSchemaVersion: roster.sourceData.engineDataSchemaVersion,
  };
}

function factionBundleContract(roster: RosterDraftV1): unknown {
  return {
    ...sharedBundleContract(roster),
    rosterRulesHash: roster.sourceData.rosterRulesHash,
    factionRulesHash: roster.sourceData.factionRulesHash,
    mappingHash: roster.sourceData.mappingHash,
    entityHashesSha256: tesseraOptimizerCanonicalSha256(
      roster.sourceData.entityHashes,
    ),
  };
}

function stateIntegrityIssue(
  state: TesseraGeneralOptimizerState,
): TesseraOptimizerIssue | null {
  const expectedArchetypes = tesseraOptimizerCanonicalSha256(
    [...GeneralThreatArchetypeIds],
  );
  const stateArchetypes = tesseraOptimizerCanonicalSha256(
    state.baselines.map(({ archetypeId }) => archetypeId),
  );
  const identityArchetypes = tesseraOptimizerCanonicalSha256(
    state.frozenIdentities.baselines.map(({ archetypeId }) => archetypeId),
  );
  if (
    state.schemaVersion !== TESSERA_GENERAL_OPTIMIZER_SCHEMA_VERSION ||
    state.coordinatorKind !==
      "rosterpilot-tessera-general-six-optimizer" ||
    state.integritySha256 !== stateHash(state) ||
    state.frozenIdentities.contextSha256 !==
      frozenIdentityHash(state.frozenIdentities) ||
    state.portfolio.portfolioHash !==
      generalThreatPortfolioHash(
        state.portfolio.pointsLimit,
        state.portfolio.items,
      ) ||
    tesseraOptimizerCanonicalSha256(state.baselineRoster) !==
      state.frozenIdentities.player.rosterSha256 ||
    rosterExecutionFingerprint(state.baselineRoster) !==
      state.frozenIdentities.player.rosterFingerprint ||
    stateArchetypes !== expectedArchetypes ||
    identityArchetypes !== expectedArchetypes ||
    new Set(state.baselines.map(({ runId }) => runId)).size !==
      GeneralThreatArchetypeIds.length ||
    new Set(state.baselines.map(({ reportPath }) => reportPath)).size !==
      GeneralThreatArchetypeIds.length ||
    state.portfolio.items.some(
      (item) =>
        item.simulationFingerprint !==
          rosterSimulationFingerprint(item.roster),
    ) ||
    new Set(
      state.candidates.map(({ candidate }) => candidate.candidateId),
    ).size !== state.candidates.length
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_STATE_TAMPERED",
      "The general-six optimizer state, portfolio, player roster, or frozen context is invalid.",
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
        "TESSERA_GENERAL_OPTIMIZER_APPROVAL_TAMPERED",
        "A general-six optimizer approval no longer matches its frozen context.",
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
        "TESSERA_GENERAL_OPTIMIZER_CANDIDATE_TAMPERED",
        `Candidate ${candidate.candidate.candidateId} no longer matches its revised roster receipt.`,
      );
    }
    if (
      candidate.comparisonRequests.some(
        (request) => request.requestSha256 !== requestHash(request),
      ) ||
      candidate.comparisons.some(
        (evidence) => evidence.evidenceSha256 !== evidenceHash(evidence),
      )
    ) {
      return issue(
        "TESSERA_GENERAL_OPTIMIZER_EVIDENCE_TAMPERED",
        `Candidate ${candidate.candidate.candidateId} has modified requests or comparison evidence.`,
      );
    }
  }
  if (
    state.pareto &&
    state.pareto.resultSha256 !== paretoHash(state.pareto)
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_PARETO_TAMPERED",
      "The general-six Pareto result no longer matches its receipt.",
    );
  }
  if (
    state.finalization &&
    state.finalization.finalizationSha256 !==
      finalizationHash(state.finalization)
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_FINALIZATION_TAMPERED",
      "The general-six finalization no longer matches its receipt.",
    );
  }
  return null;
}

export function verifyTesseraGeneralOptimizerState(
  state: TesseraGeneralOptimizerState,
  currentIdentities?: TesseraGeneralOptimizerFrozenIdentities,
): TesseraOptimizerResult<TesseraGeneralOptimizerState> {
  const integrity = stateIntegrityIssue(state);
  if (integrity) return failure(integrity);
  if (
    currentIdentities &&
    tesseraOptimizerCanonicalSha256(currentIdentities) !==
      tesseraOptimizerCanonicalSha256(state.frozenIdentities)
  ) {
    return failure(
      issue(
        "TESSERA_GENERAL_OPTIMIZER_IDENTITY_INVALIDATED",
        "The current player, bundle, portfolio, six baselines, profile policies, heuristic, or runtime differs from the frozen general optimizer context.",
      ),
    );
  }
  return success(state);
}

function invalidateState(
  state: TesseraGeneralOptimizerState,
  violation: TesseraOptimizerIssue,
  at: string,
): TesseraOptimizerResult<TesseraGeneralOptimizerState> {
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
  state: TesseraGeneralOptimizerState,
  currentIdentities: TesseraGeneralOptimizerFrozenIdentities,
  at: string,
): TesseraOptimizerResult<TesseraGeneralOptimizerState> {
  const integrity = stateIntegrityIssue(state);
  if (integrity) return failure(integrity);
  if (state.stage === "invalidated") {
    return failure(
      issue(
        "TESSERA_GENERAL_OPTIMIZER_ALREADY_INVALIDATED",
        "This general-six optimizer is terminally invalidated.",
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
        "TESSERA_GENERAL_OPTIMIZER_IDENTITY_INVALIDATED",
        "A frozen general-six optimizer identity changed.",
      ),
      at,
    );
  }
  return success(state);
}

async function portfolioIssue(
  portfolio: GeneralThreatPortfolio,
  baselineRoster: RosterDraftV1,
): Promise<TesseraOptimizerIssue | null> {
  const expectedIds = [...GeneralThreatArchetypeIds].sort();
  const observedIds = portfolio.items
    .map(({ archetypeId }) => archetypeId)
    .sort();
  if (
    portfolio.schemaVersion !== 1 ||
    portfolio.portfolioKind !== "general-threat-portfolio" ||
    (portfolio.pointsLimit !== 1000 && portfolio.pointsLimit !== 2000) ||
    portfolio.pointsLimit !== baselineRoster.pointsLimit ||
    portfolio.portfolioHash !==
      generalThreatPortfolioHash(portfolio.pointsLimit, portfolio.items) ||
    tesseraOptimizerCanonicalSha256(observedIds) !==
      tesseraOptimizerCanonicalSha256(expectedIds) ||
    new Set(
      portfolio.items.map(({ simulationFingerprint }) =>
        simulationFingerprint,
      ),
    ).size !== GeneralThreatArchetypeIds.length
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_PORTFOLIO_INVALID",
      "The general optimizer requires one complete, hash-valid six-archetype portfolio at the player's point limit.",
    );
  }
  const expectedSharedBundle = tesseraOptimizerCanonicalSha256(
    sharedBundleContract(baselineRoster),
  );
  for (const item of portfolio.items) {
    const validation = validateRoster(item.roster);
    const exported = validation.ok
      ? await exportRoster(item.roster, "rosz")
      : null;
    if (
      !validation.ok ||
      !exported?.ok ||
      !exported.data ||
      item.roster.pointsLimit !== portfolio.pointsLimit ||
      item.roster.totalPoints / item.roster.pointsLimit < 0.98 ||
      item.roster.factionId !== item.representativeFactionId ||
      item.simulationFingerprint !==
        rosterSimulationFingerprint(item.roster) ||
      tesseraOptimizerCanonicalSha256(
        sharedBundleContract(item.roster),
      ) !== expectedSharedBundle
    ) {
      return issue(
        "TESSERA_GENERAL_OPTIMIZER_PORTFOLIO_MEMBER_INVALID",
        `The ${item.archetypeId} portfolio member is not a legal, 98%-utilized, ROSZ-exportable roster from the same leased bundle contract.`,
      );
    }
  }
  return null;
}

function candidateIdentity(candidate: TesseraChangeCandidate): unknown {
  return {
    candidateId: candidate.candidateId,
    operation: candidate.operation,
    beforePoints: candidate.beforePoints,
    afterPoints: candidate.afterPoints,
    rosterFingerprint: candidate.rosterFingerprint,
  };
}

function baselineByArchetype(
  input: CreateTesseraGeneralOptimizerStateInput,
): Map<GeneralThreatArchetype, TesseraGeneralOptimizerBaselineInput> | null {
  if (input.baselines.length !== GeneralThreatArchetypeIds.length) {
    return null;
  }
  const map = new Map(
    input.baselines.map((baseline) => [baseline.archetypeId, baseline]),
  );
  return map.size === GeneralThreatArchetypeIds.length ? map : null;
}

export async function createTesseraGeneralOptimizerState(
  input: CreateTesseraGeneralOptimizerStateInput,
): Promise<TesseraOptimizerResult<TesseraGeneralOptimizerState>> {
  const invalidPortfolio = await portfolioIssue(
    input.portfolio,
    input.baselineRoster,
  );
  if (invalidPortfolio) return failure(invalidPortfolio);
  if (input.evaluationRuntime.stale) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_RUNTIME_RESTART_REQUIRED",
      "The evaluation runtime is stale. Restart it before creating a general optimizer.",
    ));
  }
  if (!isSha256(input.portfolioArtifactSha256)) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_PORTFOLIO_ARTIFACT_REQUIRED",
      "The frozen general-threat portfolio must include its lowercase SHA-256 artifact receipt.",
    ));
  }
  const baselineInputs = baselineByArchetype(input);
  if (!baselineInputs) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_BASELINES_REQUIRED",
      "Exactly one baseline report is required for each of the six archetypes.",
    ));
  }
  const reportPaths = input.baselines.map(({ reportPath }) => reportPath);
  const reportRunIds = input.baselines.map(({ report }) => report.runId);
  if (
    new Set(reportPaths).size !== GeneralThreatArchetypeIds.length ||
    new Set(reportRunIds).size !== GeneralThreatArchetypeIds.length
  ) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_BASELINE_IDENTITIES_DUPLICATE",
      "Every archetype baseline must have a unique durable report path and Tessera run ID.",
    ));
  }
  const optimizerRunId = input.optimizerRunId ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!isIsoTimestamp(createdAt)) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_TIMESTAMP_INVALID",
      "The optimizer creation time must be an ISO-compatible timestamp.",
    ));
  }
  const playerFingerprint = rosterExecutionFingerprint(
    input.baselineRoster,
  );
  const baselines: TesseraGeneralOptimizerBaseline[] = [];
  const baselineIdentities: TesseraGeneralOptimizerBaselineIdentity[] = [];
  const candidateMap = new Map<string, TesseraGeneralOptimizerCandidate>();
  const statements: TesseraGeneralOptimizerState["baselineSuggestions"]["statements"] = [];
  let sharedBundle: TesseraOptimizerFrozenIdentities["bundle"] | null = null;
  let sharedBaselineRuntimeSha256: string | null = null;
  let sharedConfigurationSha256: string | null = null;
  let sharedTesseraUiIdentity: string | null = null;
  let baselineReadiness: TesseraMissionReadinessReport | null = null;

  const portfolioByArchetype = new Map(
    input.portfolio.items.map((item) => [item.archetypeId, item]),
  );
  const canonicalPortfolioItems = GeneralThreatArchetypeIds.map(
    (archetypeId) => portfolioByArchetype.get(archetypeId)!,
  );
  for (const portfolioItem of canonicalPortfolioItems) {
    const baselineInput = baselineInputs.get(portfolioItem.archetypeId)!;
    const report = baselineInput.report;
    if (
      !baselineInput.reportPath.trim() ||
      !isSha256(baselineInput.reportArtifactSha256) ||
      report.configuration?.includeChangeCandidates !== true ||
      report.simulation.requested !== true ||
      report.simulation.executionMode !== "simulate" ||
      report.simulation.status !== "complete" ||
      report.opponents.length !== 1 ||
      report.opponents[0]?.fingerprint !==
        rosterExecutionFingerprint(portfolioItem.roster) ||
      report.player.fingerprint !== playerFingerprint
    ) {
      return failure(issue(
        "TESSERA_GENERAL_OPTIMIZER_BASELINE_TARGET_MISMATCH",
        `The ${portfolioItem.label} baseline does not bind the exact player and portfolio opponent roster.`,
      ));
    }
    const child = createTesseraOptimizerState({
      mode: input.mode,
      optimizerRunId: `${optimizerRunId}-${portfolioItem.archetypeId}`,
      createdAt,
      baselineReportPath: baselineInput.reportPath,
      baselineReport: report,
      baselineReportArtifactSha256:
        baselineInput.reportArtifactSha256 ?? null,
      baselineRoster: input.baselineRoster,
      evaluationRuntime: input.evaluationRuntime,
      profilePolicy: baselineInput.profilePolicy ?? null,
      profilePolicyPath: baselineInput.profilePolicyPath ?? null,
      profilePolicyArtifactSha256:
        baselineInput.profilePolicyArtifactSha256 ?? null,
    });
    if (!child.ok || !child.data || child.data.baseline.kind !== "exact") {
      return failure(
        child.violations[0] ?? issue(
          "TESSERA_GENERAL_OPTIMIZER_BASELINE_INVALID",
          `The ${portfolioItem.label} baseline is not a complete paired exact report.`,
        ),
      );
    }
    const childState = child.data;
    const configurationSha256 = tesseraOptimizerCanonicalSha256(
      report.configuration,
    );
    const tesseraUiIdentity =
      childState.frozenIdentities.baseline.tesseraUiIdentity;
    if (
      (
        sharedBundle &&
        tesseraOptimizerCanonicalSha256(sharedBundle) !==
          tesseraOptimizerCanonicalSha256(
            childState.frozenIdentities.bundle,
          )
      ) ||
      (
        sharedBaselineRuntimeSha256 &&
        sharedBaselineRuntimeSha256 !==
          childState.frozenIdentities.runtime.baselineSha256
      ) ||
      (
        sharedConfigurationSha256 &&
        sharedConfigurationSha256 !== configurationSha256
      ) ||
      (
        sharedTesseraUiIdentity &&
        sharedTesseraUiIdentity !== tesseraUiIdentity
      )
    ) {
      return failure(issue(
        "TESSERA_GENERAL_OPTIMIZER_BASELINE_CONTRACT_MISMATCH",
        "All six baselines must share one bundle, baseline runtime, player roster, and scenario configuration.",
      ));
    }
    sharedBundle ??= childState.frozenIdentities.bundle;
    sharedBaselineRuntimeSha256 ??=
      childState.frozenIdentities.runtime.baselineSha256;
    sharedConfigurationSha256 ??= configurationSha256;
    sharedTesseraUiIdentity ??= tesseraUiIdentity;
    baselineReadiness ??= childState.baseline.readiness;
    baselines.push({
      archetypeId: portfolioItem.archetypeId,
      label: portfolioItem.label,
      reportPath: baselineInput.reportPath,
      runId: report.runId,
      opponentRosterFingerprint:
        rosterExecutionFingerprint(portfolioItem.roster),
      profilePolicy: structuredClone(
        baselineInput.profilePolicy ?? null,
      ),
      frozenProfileRequirements: structuredClone(
        childState.baseline.frozenProfileRequirements ?? [],
      ),
    });
    const baselineIdentityWithoutMember = {
      archetypeId: portfolioItem.archetypeId,
      label: portfolioItem.label,
      reportPath: baselineInput.reportPath,
      runId: report.runId,
      reportCanonicalSha256:
        childState.frozenIdentities.baseline.reportCanonicalSha256,
      reportArtifactSha256: baselineInput.reportArtifactSha256!,
      scenarioContractSha256:
        childState.frozenIdentities.baseline.scenarioContractSha256,
      opponentRosterFingerprint:
        rosterExecutionFingerprint(portfolioItem.roster),
      opponentSimulationFingerprint:
        portfolioItem.simulationFingerprint,
      baselineRuntimeSha256:
        childState.frozenIdentities.runtime.baselineSha256,
      tesseraUiIdentity: tesseraUiIdentity!,
      profilePolicyHash:
        childState.frozenIdentities.profile.policyHash,
      profilePolicyPath:
        childState.frozenIdentities.profile.policyPath,
      profilePolicyArtifactSha256:
        childState.frozenIdentities.profile.policyArtifactSha256,
      profileRequirementsSha256:
        childState.frozenIdentities.profile.requirementsSha256,
    };
    baselineIdentities.push({
      ...baselineIdentityWithoutMember,
      memberContractSha256: tesseraOptimizerCanonicalSha256({
        ...baselineIdentityWithoutMember,
        representativeFactionId:
          portfolioItem.representativeFactionId,
        opponentRosterSha256:
          tesseraOptimizerCanonicalSha256(portfolioItem.roster),
        opponentBundleContract:
          factionBundleContract(portfolioItem.roster),
      }),
    });
    statements.push({
      archetypeId: portfolioItem.archetypeId,
      statements: structuredClone(report.suggestions ?? []),
    });
    for (const candidate of report.changeCandidates ?? []) {
      const existing = candidateMap.get(candidate.candidateId);
      if (
        existing &&
        tesseraOptimizerCanonicalSha256(
          candidateIdentity(existing.candidate),
        ) !== tesseraOptimizerCanonicalSha256(candidateIdentity(candidate))
      ) {
        return failure(issue(
          "TESSERA_GENERAL_OPTIMIZER_CANDIDATE_CONFLICT",
          `Candidate ${candidate.candidateId} has inconsistent operations or roster identities across baselines.`,
        ));
      }
      const source: TesseraGeneralOptimizerCandidateSource = {
        archetypeId: portfolioItem.archetypeId,
        baselineRunId: report.runId,
        title: candidate.title,
        rationale: candidate.rationale,
        evidenceFindingIds: candidate.evidenceFindingIds.map(
          (findingId) => `${portfolioItem.archetypeId}:${findingId}`,
        ),
      };
      if (existing) {
        existing.sources.push(source);
      } else {
        candidateMap.set(candidate.candidateId, {
          candidate: structuredClone(candidate),
          sources: [source],
          status: "proposed",
          revisedRoster: null,
          revisedRosterSha256: null,
          readiness: null,
          localRejection: null,
          comparisonRequests: [],
          comparisons: [],
        });
      }
    }
  }
  if (!sharedBundle || !sharedBaselineRuntimeSha256 || !baselineReadiness) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_BASELINES_REQUIRED",
      "The six baseline identities could not be frozen.",
    ));
  }
  const sortedBaselineIdentities = baselineIdentities.sort(compareArchetypes);
  const identitiesWithoutContext = {
    player: {
      rosterSha256: tesseraOptimizerCanonicalSha256(input.baselineRoster),
      rosterFingerprint: playerFingerprint,
    },
    bundle: structuredClone(sharedBundle),
    portfolio: {
      version: input.portfolio.version,
      pointsLimit: input.portfolio.pointsLimit,
      portfolioHash: input.portfolio.portfolioHash,
      artifactSha256: input.portfolioArtifactSha256,
      contractSha256: tesseraOptimizerCanonicalSha256(input.portfolio),
    },
    baselines: sortedBaselineIdentities,
    scenarioConfigurationSha256: sharedConfigurationSha256 ?? "",
    heuristic: {
      version: TESSERA_GENERAL_OPTIMIZER_HEURISTIC_VERSION,
      parametersSha256:
        tesseraOptimizerCanonicalSha256(heuristicParameters),
    },
    runtime: {
      baselineSha256: sharedBaselineRuntimeSha256,
      evaluationSha256:
        tesseraOptimizerRuntimeIdentitySha256(input.evaluationRuntime),
    },
  };
  const frozenIdentities: TesseraGeneralOptimizerFrozenIdentities = {
    ...identitiesWithoutContext,
    contextSha256:
      tesseraOptimizerCanonicalSha256(identitiesWithoutContext),
  };
  const candidates = [...candidateMap.values()]
    .map((candidate) => ({
      ...candidate,
      sources: candidate.sources.sort(compareArchetypes),
    }))
    .sort((left, right) =>
      left.candidate.candidateId.localeCompare(
        right.candidate.candidateId,
      ),
    );
  if (candidates.length === 0 && (input.mode ?? "guided") === "guided") {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_NO_CANDIDATES",
      "The six exact baselines did not expose a frozen candidate to approve. Re-run in recommend-only mode or collect candidate-bearing baselines.",
    ));
  }
  const state = sealState({
    schemaVersion: 1,
    coordinatorKind: "rosterpilot-tessera-general-six-optimizer",
    optimizerRunId,
    mode: input.mode ?? "guided",
    stage: "recommendations-ready",
    stateRevision: 0,
    createdAt,
    updatedAt: createdAt,
    frozenIdentities,
    baselineRoster: structuredClone(input.baselineRoster),
    baselineReadiness: structuredClone(baselineReadiness),
    portfolio: structuredClone(input.portfolio),
    baselines: baselines.sort(compareArchetypes),
    baselineSuggestions: {
      pairing: "unpaired",
      evidenceClass: "six-unpaired-baseline-suggestions",
      statements: statements.sort(compareArchetypes),
      caveat:
        "These six baseline suggestions are unpaired hypotheses. A roster change is not an improvement until all six approved paired revisions complete under the frozen contract.",
    },
    candidates,
    approvals: [],
    pareto: null,
    finalization: null,
    invalidation: null,
  });
  return success(state);
}

function batchApproval(
  state: TesseraGeneralOptimizerState,
): Extract<
  TesseraGeneralOptimizerApprovalReceipt,
  { approvalKind: "general-candidate-evaluation-batch" }
> | null {
  return state.approvals.find(
    (approval): approval is Extract<
      TesseraGeneralOptimizerApprovalReceipt,
      { approvalKind: "general-candidate-evaluation-batch" }
    > => approval.approvalKind === "general-candidate-evaluation-batch",
  ) ?? null;
}

function candidateBatchPayload(
  state: TesseraGeneralOptimizerState,
  candidateIds: string[],
): unknown {
  return candidateIds.map((candidateId) => {
    const candidate = state.candidates.find(
      (entry) => entry.candidate.candidateId === candidateId,
    )!;
    return candidateIdentity(candidate.candidate);
  });
}

export function approveTesseraGeneralOptimizerCandidateBatch(
  state: TesseraGeneralOptimizerState,
  input: {
    currentIdentities: TesseraGeneralOptimizerFrozenIdentities;
    expectedStateRevision: number;
    candidateIds: string[];
    approvalId: string;
    approvedBy: string;
    approvedAt: string;
  },
): TesseraOptimizerResult<TesseraGeneralOptimizerState> {
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    input.approvedAt,
  );
  if (!guarded.ok) return guarded;
  if (
    state.mode !== "guided" ||
    state.stage !== "recommendations-ready" ||
    input.expectedStateRevision !== state.stateRevision
  ) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_BATCH_APPROVAL_NOT_READY",
      "Candidate approval must target the exact current recommendations revision in guided mode.",
    ), state);
  }
  const candidateIds = [...new Set(input.candidateIds)].sort();
  if (
    candidateIds.length === 0 ||
    candidateIds.length > 3 ||
    candidateIds.length !== input.candidateIds.length ||
    candidateIds.some((candidateId) =>
      !state.candidates.some(
        (entry) => entry.candidate.candidateId === candidateId,
      ),
    ) ||
    !input.approvalId.trim() ||
    !input.approvedBy.trim() ||
    !isIsoTimestamp(input.approvedAt)
  ) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_BATCH_APPROVAL_INVALID",
      "The approval must name one to three unique frozen candidates and include an explicit approval identity and timestamp.",
    ), state);
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    approvalKind: "general-candidate-evaluation-batch" as const,
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
  const receipt: TesseraGeneralOptimizerApprovalReceipt = {
    ...withoutHash,
    receiptSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
  return success(sealState({
    ...structuredClone(state),
    stage: "candidate-batch-approved",
    stateRevision: state.stateRevision + 1,
    updatedAt: input.approvedAt,
    candidates: state.candidates.map((candidate) => ({
      ...structuredClone(candidate),
      status: candidateIds.includes(candidate.candidate.candidateId)
        ? "approved" as const
        : candidate.status,
    })),
    approvals: [...structuredClone(state.approvals), receipt],
  }));
}

function profileCompatible(
  baseline: TesseraGeneralOptimizerBaseline,
  roster: RosterDraftV1,
): boolean {
  const requirements = rosterProfileRequirements(roster);
  const policy = baseline.profilePolicy;
  if (!policy) return requirements.length === 0;
  return requirements.every((requirement) =>
    policy.entries.some((entry) =>
      profilePolicyIdentityMatches(entry, requirement) &&
      entry.activeCount === requirement.activeCount &&
      requirement.availableProfiles.some((profile) =>
        profile.trim().toLocaleLowerCase() ===
          entry.selectedProfile.trim().toLocaleLowerCase(),
      ),
    ),
  );
}

function readinessRank(
  band: TesseraMissionReadinessReport["overallBand"],
): number {
  return band === "green" ? 3 : band === "amber" ? 2 : band === "red" ? 1 : 0;
}

function makeComparisonRequest(
  state: TesseraGeneralOptimizerState,
  baseline: TesseraGeneralOptimizerBaseline,
  candidate: TesseraChangeCandidate,
  roster: RosterDraftV1,
  approval: Extract<
    TesseraGeneralOptimizerApprovalReceipt,
    { approvalKind: "general-candidate-evaluation-batch" }
  >,
): TesseraGeneralOptimizerComparisonRequest {
  const baselineIdentity = state.frozenIdentities.baselines.find(
    (identity) => identity.archetypeId === baseline.archetypeId,
  )!;
  const profilePolicyPath = baselineIdentity.profilePolicyPath;
  const runRequest: Extract<
    TesseraRunRequest,
    { kind: "exact-revision" }
  > = {
    kind: "exact-revision",
    baselineReportPath: baseline.reportPath,
    revisedRoster: structuredClone(roster),
    options: {
      executionMode: "simulate",
      experimental: false,
      ...(profilePolicyPath ? { profilePolicyPath } : {}),
    },
  };
  const withoutHash = {
    schemaVersion: 1 as const,
    requestKind: "tessera-general-optimizer-revision" as const,
    optimizerRunId: state.optimizerRunId,
    candidateId: candidate.candidateId,
    archetypeId: baseline.archetypeId,
    contextSha256: state.frozenIdentities.contextSha256,
    baselineRunId: baseline.runId,
    baselineReportArtifactSha256:
      baselineIdentity.reportArtifactSha256,
    memberContractSha256: baselineIdentity.memberContractSha256,
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
) => qualifyRosterChangeCandidate(
  baselineRoster,
  baselineReadiness,
  candidate.operation,
);

export async function materializeApprovedTesseraGeneralOptimizerCandidates(
  state: TesseraGeneralOptimizerState,
  input: {
    currentIdentities: TesseraGeneralOptimizerFrozenIdentities;
    materializedAt?: string;
    qualifyCandidate?: TesseraOptimizerCandidateQualifier;
  },
): Promise<TesseraOptimizerResult<TesseraGeneralOptimizerState>> {
  const materializedAt = input.materializedAt ?? new Date().toISOString();
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    materializedAt,
  );
  if (!guarded.ok) return guarded;
  if (state.stage !== "candidate-batch-approved") {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_BATCH_APPROVAL_REQUIRED",
      "Candidates cannot be materialized until the exact batch is approved.",
    ), state);
  }
  const approval = batchApproval(state);
  if (!approval) {
    return invalidateState(state, issue(
      "TESSERA_GENERAL_OPTIMIZER_BATCH_APPROVAL_MISSING",
      "The approved stage has no candidate-batch receipt.",
    ), materializedAt);
  }
  const qualify = input.qualifyCandidate ?? defaultQualifier;
  const candidates = structuredClone(state.candidates);
  for (const entry of candidates) {
    if (!approval.candidateIds.includes(entry.candidate.candidateId)) continue;
    const qualified = await qualify(
      structuredClone(state.baselineRoster),
      structuredClone(state.baselineReadiness),
      structuredClone(entry.candidate),
    );
    if (!qualified) {
      entry.status = "rejected-local";
      entry.localRejection = issue(
        "TESSERA_GENERAL_OPTIMIZER_CANDIDATE_LOCAL_GUARDRAIL",
        "The candidate failed legality, hard constraints, points utilization, exportability, or mission-readiness qualification.",
      );
      continue;
    }
    const fingerprint = rosterExecutionFingerprint(qualified.roster);
    if (
      !validateRoster(qualified.roster).ok ||
      qualified.roster.totalPoints !== entry.candidate.afterPoints ||
      entry.candidate.beforePoints !== state.baselineRoster.totalPoints ||
      fingerprint !== entry.candidate.rosterFingerprint ||
      qualified.readiness.rosterFingerprint !== fingerprint
    ) {
      return invalidateState(state, issue(
        "TESSERA_GENERAL_OPTIMIZER_CANDIDATE_IDENTITY_MISMATCH",
        `Approved candidate ${entry.candidate.candidateId} did not materialize once to its exact frozen identity.`,
      ), materializedAt);
    }
    if (
      state.baselines.some(
        (baseline) => !profileCompatible(baseline, qualified.roster),
      ) ||
      readinessRank(qualified.readiness.overallBand) <
        readinessRank(state.baselineReadiness.overallBand)
    ) {
      entry.status = "rejected-local";
      entry.localRejection = issue(
        "TESSERA_GENERAL_OPTIMIZER_LOCAL_CONTRACT_CHANGED",
        "This candidate needs an uncovered profile choice or worsens the frozen mission-readiness band; create new baselines instead.",
      );
      continue;
    }
    entry.status = "ready-for-comparisons";
    entry.revisedRoster = structuredClone(qualified.roster);
    entry.revisedRosterSha256 =
      tesseraOptimizerCanonicalSha256(qualified.roster);
    entry.readiness = structuredClone(qualified.readiness);
    entry.comparisonRequests = state.baselines.map((baseline) =>
      makeComparisonRequest(
        state,
        baseline,
        entry.candidate,
        qualified.roster,
        approval,
      ),
    );
  }
  const ready = candidates.some(
    (candidate) => candidate.status === "ready-for-comparisons",
  );
  const next = sealState({
    ...structuredClone(state),
    stage: ready ? "comparisons-pending" : "pareto-ready",
    stateRevision: state.stateRevision + 1,
    updatedAt: materializedAt,
    candidates,
    pareto: ready ? null : emptyPareto(state, materializedAt),
  });
  return success(next);
}

export function approvedTesseraGeneralOptimizerComparisonRequests(
  state: TesseraGeneralOptimizerState,
  currentIdentities: TesseraGeneralOptimizerFrozenIdentities,
): TesseraOptimizerResult<TesseraGeneralOptimizerComparisonRequest[]> {
  const guarded = guardTransition(
    state,
    currentIdentities,
    new Date().toISOString(),
  );
  if (!guarded.ok) return { ...guarded, data: null };
  if (state.stage !== "comparisons-pending") {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_COMPARISONS_NOT_AUTHORIZED",
      "Six-way paired requests exist only after batch approval and local qualification.",
    ));
  }
  return success(state.candidates.flatMap((candidate) =>
    candidate.status === "ready-for-comparisons"
      ? structuredClone(candidate.comparisonRequests)
      : [],
  ));
}

function exactEvidence(
  state: TesseraGeneralOptimizerState,
  candidate: TesseraGeneralOptimizerCandidate,
  archetypeId: GeneralThreatArchetype,
  request: TesseraGeneralOptimizerComparisonRequest,
  report: TesseraRevisionComparisonReport,
  artifactSha256: string,
): TesseraGeneralOptimizerComparisonEvidence | TesseraOptimizerIssue {
  const baseline = state.baselines.find(
    (entry) => entry.archetypeId === archetypeId,
  );
  const baselineIdentity = state.frozenIdentities.baselines.find(
    (entry) => entry.archetypeId === archetypeId,
  );
  const opponent = state.portfolio.items.find(
    (entry) => entry.archetypeId === archetypeId,
  );
  const counts = report.summary.aggregateCounts;
  if (
    !baseline ||
    !baselineIdentity ||
    !opponent ||
    !isSha256(artifactSha256) ||
    request.baselineRunId !== baseline.runId ||
    request.baselineReportArtifactSha256 !==
      baselineIdentity.reportArtifactSha256 ||
    request.memberContractSha256 !==
      baselineIdentity.memberContractSha256 ||
    report.schemaVersion !== 2 ||
    report.baselineReportPath !== baseline.reportPath ||
    report.baselineRunId !== baseline.runId ||
    report.revisedRosterFingerprint !==
      candidate.candidate.rosterFingerprint ||
    report.summary.conclusionBasis !== "trusted-roster-aggregates" ||
    !report.summary.conclusion ||
    !counts ||
    !report.aggregates?.length ||
    report.revisedReports.length === 0 ||
    report.revisedReports.some((revised) =>
      revised.schemaVersion !== 3 ||
      revised.status !== "complete" ||
      revised.source !== "tessera-ui" ||
      revised.configuration == null ||
      tesseraOptimizerCanonicalSha256(revised.configuration) !==
        state.frozenIdentities.scenarioConfigurationSha256 ||
      revised.profilePolicyHash !== baselineIdentity.profilePolicyHash ||
      revised.opponents.length !== 1 ||
      revised.opponents[0]?.fingerprint !==
        rosterExecutionFingerprint(opponent.roster) ||
      revised.simulation.requested !== true ||
      revised.simulation.executionMode !== "simulate" ||
      revised.simulation.status !== "complete" ||
      !revised.simulation.scenarios?.length ||
      revised.simulation.scenarios.some(
        (scenario) => scenario.status !== "complete",
      ) ||
      revised.player.fingerprint !==
        candidate.candidate.rosterFingerprint ||
      !revised.runtime ||
      tesseraOptimizerRuntimeIdentitySha256(revised.runtime) !==
        state.frozenIdentities.runtime.evaluationSha256
    )
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_COMPARISON_MISMATCH",
      `The ${archetypeId} comparison is not the complete trusted paired report for this baseline and candidate.`,
    );
  }
  const observedCounts = report.aggregates.reduce(
    (total, aggregate) => ({
      ...total,
      [aggregate.classification]: total[aggregate.classification] + 1,
    }),
    { improved: 0, worsened: 0, unchanged: 0, ambiguous: 0 },
  );
  if (
    observedCounts.improved !== counts.improved ||
    observedCounts.worsened !== counts.worsened ||
    observedCounts.unchanged !== counts.unchanged ||
    observedCounts.ambiguous !== counts.ambiguous ||
    counts.total !== report.aggregates.length ||
    counts.improved + counts.worsened + counts.unchanged +
      counts.ambiguous !== counts.total
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_COMPARISON_COUNTS_INVALID",
      `The ${archetypeId} comparison summary does not match its trusted aggregates.`,
    );
  }
  const dimensions = report.aggregates.flatMap((aggregate) => {
    if (!Number.isFinite(aggregate.directionalChange)) {
      return [];
    }
    return [{
      id: [
        "general-six",
        archetypeId,
        aggregate.metric,
        aggregate.direction,
        [...aggregate.phases].sort().join(","),
      ].join(":"),
      value: aggregate.directionalChange as number,
      direction: "maximize" as const,
      materiality: aggregate.materialityThreshold ?? 0,
    }];
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (
    new Set(dimensions.map(({ id }) => id)).size !== dimensions.length ||
    report.aggregates.some(
      (aggregate) =>
        aggregate.classification !== "ambiguous" &&
        !Number.isFinite(aggregate.directionalChange),
    )
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_OBJECTIVE_CONTRACT_INVALID",
      `The ${archetypeId} comparison has duplicate or missing trusted objective values.`,
    );
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    candidateId: candidate.candidate.candidateId,
    archetypeId,
    requestSha256: request.requestSha256,
    baselineRunId: report.baselineRunId,
    revisedRosterFingerprint: report.revisedRosterFingerprint,
    reportRunId: report.runId,
    reportCanonicalSha256: tesseraOptimizerCanonicalSha256(report),
    reportArtifactSha256: artifactSha256,
    conclusion: report.summary.conclusion,
    objectiveDimensions: dimensions,
    summary: {
      improved: counts.improved,
      worsened: counts.worsened,
      unchanged: counts.unchanged,
      ambiguous: counts.ambiguous,
    },
  };
  return {
    ...withoutHash,
    evidenceSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
}

export function recordTesseraGeneralOptimizerComparison(
  state: TesseraGeneralOptimizerState,
  input: {
    currentIdentities: TesseraGeneralOptimizerFrozenIdentities;
    expectedStateRevision: number;
    candidateId: string;
    archetypeId: GeneralThreatArchetype;
    requestSha256: string;
    report: TesseraRevisionComparisonReport;
    reportArtifactSha256: string;
    recordedAt?: string;
  },
): TesseraOptimizerResult<TesseraGeneralOptimizerState> {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    recordedAt,
  );
  if (!guarded.ok) return guarded;
  if (
    state.stage !== "comparisons-pending" ||
    input.expectedStateRevision !== state.stateRevision
  ) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_COMPARISON_NOT_AUTHORIZED",
      "Comparison evidence must target the exact current pending revision.",
    ), state);
  }
  if (
    !isSha256(input.reportArtifactSha256)
  ) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_COMPARISON_HASH_INVALID",
      "The comparison artifact hash must be lowercase SHA-256.",
    ), state);
  }
  const candidate = state.candidates.find(
    (entry) => entry.candidate.candidateId === input.candidateId,
  );
  const request = candidate?.comparisonRequests.find(
    (entry) => entry.archetypeId === input.archetypeId,
  );
  if (
    !candidate ||
    candidate.status !== "ready-for-comparisons" ||
    !candidate.revisedRoster ||
    !request ||
    request.requestSha256 !== input.requestSha256 ||
    state.candidates.some((entry) => entry.comparisons.some(
      (comparison) => comparison.reportRunId === input.report.runId,
    )) ||
    candidate.comparisons.some(
      (evidence) => evidence.archetypeId === input.archetypeId,
    )
  ) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_CANDIDATE_NOT_AUTHORIZED",
      "The comparison does not belong to an unrecorded approved candidate/archetype request.",
    ), state);
  }
  const evidence = exactEvidence(
    state,
    candidate,
    input.archetypeId,
    request,
    input.report,
    input.reportArtifactSha256,
  );
  if ("severity" in evidence) {
    return invalidateState(state, evidence, recordedAt);
  }
  const candidates = state.candidates.map((entry) => {
    if (entry.candidate.candidateId !== input.candidateId) {
      return structuredClone(entry);
    }
    const comparisons = [...structuredClone(entry.comparisons), evidence]
      .sort(compareArchetypes);
    return {
      ...structuredClone(entry),
      status: comparisons.length === GeneralThreatArchetypeIds.length
        ? "comparisons-complete" as const
        : entry.status,
      comparisons,
    };
  });
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
    return entry?.status === "rejected-local" ||
      entry?.status === "comparisons-complete";
  });
  if (!finished) return success(nextDraft);
  const pareto = computePareto(nextDraft, recordedAt);
  return success(sealState({
    ...structuredClone(nextDraft),
    stage: "pareto-ready",
    pareto,
  }));
}

function commonDimensions(
  state: TesseraGeneralOptimizerState,
  candidate: TesseraGeneralOptimizerCandidate,
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
      value: (candidate.revisedRoster?.totalPoints ?? 0) /
        Math.max(1, state.baselineRoster.pointsLimit),
      direction: "maximize",
      materiality: 0.001,
    },
  ];
}

function dominates(
  left: TesseraOptimizerObjectiveDimension[],
  right: TesseraOptimizerObjectiveDimension[],
): boolean {
  const leftById = new Map(left.map((dimension) => [dimension.id, dimension]));
  if (
    left.length !== right.length ||
    right.some((dimension) => !leftById.has(dimension.id))
  ) return false;
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

function aggregateEvidenceSha256(
  candidate: TesseraGeneralOptimizerCandidate,
): string {
  return tesseraOptimizerCanonicalSha256(
    candidate.comparisons.map((comparison) => ({
      archetypeId: comparison.archetypeId,
      evidenceSha256: comparison.evidenceSha256,
    })),
  );
}

function computePareto(
  state: TesseraGeneralOptimizerState,
  generatedAt: string,
): TesseraGeneralOptimizerParetoResult {
  const approval = batchApproval(state)!;
  const candidates: TesseraGeneralOptimizerParetoCandidate[] =
    approval.candidateIds.map((candidateId) => {
      const candidate = state.candidates.find(
        (entry) => entry.candidate.candidateId === candidateId,
      )!;
      const reasons: string[] = [];
      const comparisons = candidate.comparisons;
      if (candidate.status === "rejected-local") {
        reasons.push(
          candidate.localRejection?.message ??
            "The candidate failed local qualification.",
        );
      }
      if (
        comparisons.length !== GeneralThreatArchetypeIds.length ||
        new Set(comparisons.map(({ archetypeId }) => archetypeId)).size !==
          GeneralThreatArchetypeIds.length
      ) {
        reasons.push("All six paired comparisons were not recorded.");
      }
      const summary = comparisons.reduce(
        (total, comparison) => ({
          improved: total.improved + comparison.summary.improved,
          worsened: total.worsened + comparison.summary.worsened,
          unchanged: total.unchanged + comparison.summary.unchanged,
          ambiguous: total.ambiguous + comparison.summary.ambiguous,
        }),
        { improved: 0, worsened: 0, unchanged: 0, ambiguous: 0 },
      );
      if (summary.improved === 0) {
        reasons.push("No trusted general-six objective improved.");
      }
      if (summary.worsened > 0) {
        reasons.push("At least one trusted general-six objective worsened.");
      }
      if (summary.ambiguous > 0) {
        reasons.push("At least one trusted general-six objective is ambiguous.");
      }
      if (
        comparisons.some(
          ({ conclusion }) =>
            conclusion === "worsened" || conclusion === "mixed",
        )
      ) {
        reasons.push("At least one archetype conclusion regressed or mixed.");
      }
      return {
        candidateId,
        rosterFingerprint: candidate.candidate.rosterFingerprint,
        rosterSha256: candidate.revisedRosterSha256 ?? "",
        aggregateEvidenceSha256: aggregateEvidenceSha256(candidate),
        qualified: reasons.length === 0,
        disqualificationReasons: reasons,
        objectiveDimensions: [
          ...comparisons.flatMap(
            (comparison) => comparison.objectiveDimensions,
          ),
          ...commonDimensions(state, candidate),
        ].sort((left, right) => left.id.localeCompare(right.id)),
        dominatedByCandidateIds: [],
      };
    });
  const signatures = new Set(candidates.filter(({ qualified }) => qualified)
    .map((candidate) => candidate.objectiveDimensions
      .map(({ id }) => id).sort().join("|")));
  if (signatures.size > 1) {
    for (const candidate of candidates) {
      if (!candidate.qualified) continue;
      candidate.qualified = false;
      candidate.disqualificationReasons.push(
        "Paired candidates did not expose one identical six-archetype objective contract.",
      );
    }
  }
  for (const candidate of candidates) {
    if (!candidate.qualified) continue;
    candidate.dominatedByCandidateIds = candidates.filter((other) =>
      other.qualified &&
      other.candidateId !== candidate.candidateId &&
      dominates(other.objectiveDimensions, candidate.objectiveDimensions)
    ).map(({ candidateId }) => candidateId).sort();
  }
  candidates.sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId));
  const frontierCandidateIds = candidates.filter((candidate) =>
    candidate.qualified && candidate.dominatedByCandidateIds.length === 0
  ).map(({ candidateId }) => candidateId);
  const withoutHash = {
    schemaVersion: 1 as const,
    policyVersion: TESSERA_GENERAL_OPTIMIZER_HEURISTIC_VERSION,
    optimizerRunId: state.optimizerRunId,
    contextSha256: state.frozenIdentities.contextSha256,
    candidateBatchApprovalSha256: approval.receiptSha256,
    generatedAt,
    candidates,
    frontierCandidateIds,
    dominatedCandidateIds: candidates.filter(
      ({ dominatedByCandidateIds }) => dominatedByCandidateIds.length > 0,
    ).map(({ candidateId }) => candidateId),
    disqualifiedCandidateIds: candidates.filter(
      ({ qualified }) => !qualified,
    ).map(({ candidateId }) => candidateId),
    baselineRetained: frontierCandidateIds.length === 0,
  };
  return {
    ...withoutHash,
    resultSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
}

function emptyPareto(
  state: TesseraGeneralOptimizerState,
  generatedAt: string,
): TesseraGeneralOptimizerParetoResult {
  const approval = batchApproval(state);
  const withoutHash = {
    schemaVersion: 1 as const,
    policyVersion: TESSERA_GENERAL_OPTIMIZER_HEURISTIC_VERSION,
    optimizerRunId: state.optimizerRunId,
    contextSha256: state.frozenIdentities.contextSha256,
    candidateBatchApprovalSha256: approval?.receiptSha256 ?? "",
    generatedAt,
    candidates: [] as TesseraGeneralOptimizerParetoCandidate[],
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

export function paretoTesseraGeneralOptimizerCandidates(
  state: TesseraGeneralOptimizerState,
  currentIdentities: TesseraGeneralOptimizerFrozenIdentities,
): TesseraOptimizerResult<TesseraGeneralOptimizerParetoResult> {
  const verified = verifyTesseraGeneralOptimizerState(
    state,
    currentIdentities,
  );
  if (!verified.ok) return { ...verified, data: null };
  if (!state.pareto) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_PARETO_NOT_READY",
      "Pareto results require all six paired results for every approved candidate.",
    ));
  }
  return success(structuredClone(state.pareto));
}

export function approveTesseraGeneralOptimizerWinner(
  state: TesseraGeneralOptimizerState,
  input: {
    currentIdentities: TesseraGeneralOptimizerFrozenIdentities;
    expectedStateRevision: number;
    candidateId: string;
    approvalId: string;
    approvedBy: string;
    approvedAt: string;
  },
): TesseraOptimizerResult<TesseraGeneralOptimizerState> {
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
    input.expectedStateRevision !== state.stateRevision ||
    !state.pareto.frontierCandidateIds.includes(input.candidateId) ||
    !input.approvalId.trim() ||
    !input.approvedBy.trim() ||
    !isIsoTimestamp(input.approvedAt)
  ) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_WINNER_APPROVAL_INVALID",
      "Winner approval must bind one current Pareto-frontier candidate and the exact state revision.",
    ), state);
  }
  const candidate = state.candidates.find(
    (entry) => entry.candidate.candidateId === input.candidateId,
  );
  const paretoCandidate = state.pareto.candidates.find(
    (entry) => entry.candidateId === input.candidateId,
  );
  if (!candidate?.revisedRosterSha256 || !paretoCandidate?.qualified) {
    return invalidateState(state, issue(
      "TESSERA_GENERAL_OPTIMIZER_WINNER_EVIDENCE_MISSING",
      "The selected winner has no complete aggregate roster and evidence receipt.",
    ), input.approvedAt);
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    approvalKind: "general-optimizer-exact-winner" as const,
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
    aggregateEvidenceSha256: paretoCandidate.aggregateEvidenceSha256,
  };
  const receipt: TesseraGeneralOptimizerApprovalReceipt = {
    ...withoutHash,
    receiptSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
  return success(sealState({
    ...structuredClone(state),
    stage: "winner-approved",
    stateRevision: state.stateRevision + 1,
    updatedAt: input.approvedAt,
    approvals: [...structuredClone(state.approvals), receipt],
  }));
}

export function retainTesseraGeneralOptimizerBaseline(
  state: TesseraGeneralOptimizerState,
  input: {
    currentIdentities: TesseraGeneralOptimizerFrozenIdentities;
    expectedStateRevision: number;
    approvalId: string;
    approvedBy: string;
    approvedAt: string;
  },
): TesseraOptimizerResult<TesseraGeneralOptimizerState> {
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
    input.expectedStateRevision !== state.stateRevision ||
    !input.approvalId.trim() ||
    !input.approvedBy.trim() ||
    !isIsoTimestamp(input.approvedAt)
  ) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_BASELINE_RETENTION_INVALID",
      "Baseline retention must bind the exact current Pareto result and an explicit decision identity.",
    ), state);
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    approvalKind: "general-optimizer-baseline-retention" as const,
    approvalId: input.approvalId,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    optimizerRunId: state.optimizerRunId,
    expectedStateRevision: input.expectedStateRevision,
    frozenIdentities: structuredClone(state.frozenIdentities),
    candidateBatchApprovalSha256: batch.receiptSha256,
    paretoResultSha256: state.pareto.resultSha256,
  };
  const receipt: TesseraGeneralOptimizerApprovalReceipt = {
    ...withoutHash,
    receiptSha256: tesseraOptimizerCanonicalSha256(withoutHash),
  };
  return success(sealState({
    ...structuredClone(state),
    stage: "baseline-retained",
    stateRevision: state.stateRevision + 1,
    updatedAt: input.approvedAt,
    approvals: [...structuredClone(state.approvals), receipt],
  }));
}

function validDeliveryIntent(
  intent: TesseraOptimizerDeliveryIntent,
): boolean {
  if (!isIsoTimestamp(intent.recordedAt)) return false;
  return intent.kind === "none"
    ? intent.intentId === null && intent.recordedBy === null
    : Boolean(intent.intentId.trim() && intent.recordedBy.trim());
}

export function finalizeTesseraGeneralOptimizer(
  state: TesseraGeneralOptimizerState,
  input: {
    currentIdentities: TesseraGeneralOptimizerFrozenIdentities;
    expectedStateRevision: number;
    deliveryIntent: TesseraOptimizerDeliveryIntent;
    finalizedAt?: string;
  },
): TesseraOptimizerResult<TesseraGeneralOptimizerState> {
  const finalizedAt = input.finalizedAt ?? new Date().toISOString();
  const guarded = guardTransition(
    state,
    input.currentIdentities,
    finalizedAt,
  );
  if (!guarded.ok) return guarded;
  if (
    input.expectedStateRevision !== state.stateRevision ||
    !validDeliveryIntent(input.deliveryIntent)
  ) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_FINALIZATION_INVALID",
      "Finalization requires the exact current revision and a valid independent delivery intent.",
    ), state);
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
      return failure(issue(
        "TESSERA_GENERAL_OPTIMIZER_RECOMMEND_ONLY_DELIVERY_BLOCKED",
        "Recommend-only mode cannot express delivery intent.",
      ), state);
    }
    roster = state.baselineRoster;
    disposition = "baseline-retained";
  } else if (state.stage === "baseline-retained") {
    if (input.deliveryIntent.kind !== "none") {
      return failure(issue(
        "TESSERA_GENERAL_OPTIMIZER_BASELINE_DELIVERY_BLOCKED",
        "A retained baseline has no optimizer winner delivery authority.",
      ), state);
    }
    roster = state.baselineRoster;
    disposition = "baseline-retained";
  } else if (state.stage === "winner-approved") {
    const winner = state.approvals.find(
      (approval): approval is Extract<
        TesseraGeneralOptimizerApprovalReceipt,
        { approvalKind: "general-optimizer-exact-winner" }
      > => approval.approvalKind === "general-optimizer-exact-winner",
    );
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
      return invalidateState(state, issue(
        "TESSERA_GENERAL_OPTIMIZER_WINNER_APPROVAL_MISMATCH",
        "The winner approval no longer binds the exact final roster.",
      ), finalizedAt);
    }
    roster = candidate.revisedRoster;
    candidateId = candidate.candidate.candidateId;
    disposition = "winner-finalized";
    winnerReceiptSha256 = winner.receiptSha256;
  } else {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_FINALIZATION_NOT_AUTHORIZED",
      "A changed roster needs exact winner approval; otherwise only a retained baseline may finalize.",
    ), state);
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
  return success(sealState({
    ...structuredClone(state),
    stage: "finalized",
    stateRevision: state.stateRevision + 1,
    updatedAt: finalizedAt,
    finalization,
  }));
}
