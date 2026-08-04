import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import type {
  ExportArtifact,
  TesseraMatchupReport,
  TesseraSimulationProviderIdentity,
} from "../../lib/rosterpilot";
import { writeExportArtifacts } from "../../lib/rosterpilot/io";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  type ExactMatchupReportReceipt,
  type ExactMatchupReportReceiptV2,
  exactReportReceiptPath,
  parseExactReportReceipt,
  verifyExactReportReceipt,
} from "./exact-report-integrity";
import {
  compareTesseraProviderParity,
  type TesseraParityProvider,
  type TesseraProviderParityResult,
} from "./provider-parity";
import {
  adaptReportBoundTesseraMatchupReportToProviderParityRun,
  type TesseraProviderParityReportAdapterIssue,
  type TesseraReportBoundProviderParityAdapterResult,
} from "./provider-parity-report-adapter";
import {
  TESSERA_PROVIDER_NEUTRAL_SCENARIO_SETTINGS_VERSION,
} from "./provider-parity-scenario-contract";
import {
  tesseraScenarioPolicyContractV3ConclusionStatus,
  tesseraScenarioPolicyContractV3Sha256,
} from "./scenario-contract-v3";
import {
  localTesseraProviderIdentityAllowsAnalyticalClaims,
} from "./local-engine";
import {
  type PersonalLocalParityRotationRecordV1,
  sealPersonalLocalParityRotationRecordV1,
  writePersonalLocalParityRotationRecordV1,
} from "./personal-local-attestation-store";
import {
  type TesseraParityCoveringSuiteV2,
  verifyTesseraParityCoveringSuiteV2,
} from "./provider-parity-covering-suite-v2";
import {
  compareTesseraProviderParityV2,
  type TesseraProviderParityContractBindingV2,
  type TesseraProviderParityResultV2,
  type TesseraProviderParityRunV2,
} from "./provider-parity-v2";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type TesseraProviderParityCombatStateCellV2 = {
  scenarioId: string;
  attackerInstanceId: string;
  targetInstanceId: string;
  metric: string;
  combatStateSha256: string;
};

export type TesseraProviderParityCoverageWitnessV2 = {
  requirementId: string;
  relevantLeafIds: string[];
};

/**
 * Exact provider-parity bindings retained inside each source report. The
 * exact-report receipt binds these bytes; the self-hash makes accidental
 * partial rewrites fail before the v2 comparator sees them.
 */
export type TesseraProviderParityReportEvidenceV2 = {
  schemaVersion: 2;
  kind: "rosterpilot-provider-parity-report-evidence";
  contractBinding: TesseraProviderParityContractBindingV2;
  coveringSuite: TesseraParityCoveringSuiteV2;
  coverageWitnesses: TesseraProviderParityCoverageWitnessV2[];
  combatStates: TesseraProviderParityCombatStateCellV2[];
  providerStateEvidenceSha256: string;
  evidenceSha256: string;
};

export type TesseraProviderParityWorkflowV2Issue = {
  code:
    | "PARITY_V2_EXACT_RECEIPT_REQUIRED"
    | "PARITY_V2_REPORT_EVIDENCE_MISSING"
    | "PARITY_V2_REPORT_EVIDENCE_INVALID"
    | "PARITY_V2_REPORT_EVIDENCE_HASH_INVALID"
    | "PARITY_V2_SCENARIO_BINDING_MISMATCH"
    | "PARITY_V2_BRIDGE_BINDING_MISMATCH"
    | "PARITY_V2_COVERING_SUITE_INVALID"
    | "PARITY_V2_COVERING_CASE_MISMATCH"
    | "PARITY_V2_COMBAT_STATE_MISMATCH"
    | "PARITY_V2_ROSTER_BINDING_MISMATCH"
    | "PARITY_V2_PROVIDER_STATE_MISMATCH";
  provider: TesseraParityProvider;
  message: string;
};

export type TesseraProviderParityWorkflowExactV2 = {
  schemaVersion: 2;
  kind: "tessera-provider-parity-workflow-exact-binding";
  status: "complete" | "unavailable" | "invalid";
  personalAttestationEligible: boolean;
  pairedExactReceiptsSha256: string;
  reportEvidenceSha256: {
    localEngine: string | null;
    website: string | null;
  };
  issues: TesseraProviderParityWorkflowV2Issue[];
  result: TesseraProviderParityResultV2 | null;
  exactBindingSha256: string;
};

export type TesseraProviderParityWorkflowClassification =
  | "parity-pass"
  | "model-drift"
  | "data-or-input-drift"
  | "evidence-incomplete";

export type TesseraProviderParityWorkflowArtifact = {
  schemaVersion: 1;
  kind: "tessera-provider-parity-comparison";
  evidenceKind: "paired-receipt-bound-completed-provider-reports";
  sourceResolution: {
    kind: "reports-root-sha256-run-id";
    reportRootRequired: true;
  };
  generatedAt: string;
  outcome: TesseraProviderParityResult["outcome"] | "ineligible";
  classification: TesseraProviderParityWorkflowClassification;
  sourceReports: Array<{
    provider: TesseraParityProvider;
    reportPath: string;
    receiptPath: string;
    reportSha256: string;
    receiptSha256: string;
    receiptEvidenceSha256: string;
    runId: string;
    executionEvidence: {
      reportSource: TesseraMatchupReport["source"];
      reportStatus: TesseraMatchupReport["status"];
      simulationStatus: NonNullable<
        TesseraMatchupReport["simulation"]["status"]
      > | null;
      engine: TesseraMatchupReport["simulation"]["engine"] | null;
      providerIdentity: TesseraSimulationProviderIdentity;
      providerIdentitySha256: string;
      complete: boolean;
      website: {
        deploymentIdentitySha256: string | null;
        deploymentComplete: boolean;
        importSemanticsSha256: string | null;
        importSemanticsComplete: boolean;
        stateBindingsComplete: boolean;
      } | null;
    };
    providerCompatibilityEnvelopeSha256: string | null;
    rawScenarioContractSha256: string | null;
    normalizedScenarioContractSha256: string | null;
    normalizedInputSha256: string | null;
  }>;
  scenarioNormalization: {
    version: typeof TESSERA_PROVIDER_NEUTRAL_SCENARIO_SETTINGS_VERSION;
    providerOnlySettingsIgnored: ["provider"];
    gameplaySettingsCompared: [
      "targetInCover",
      "charging",
      "withinRapidFireRange",
      "withinMeltaRange",
      "remainedStationary",
      "indirectFire",
    ];
  };
  adaptation: {
    local: { ok: boolean; issues: TesseraProviderParityReportAdapterIssue[] };
    website: { ok: boolean; issues: TesseraProviderParityReportAdapterIssue[] };
  };
  /**
   * Exact v2 admission is additive so schema-v1 certification readers can
   * continue to rebuild `parity`. Legacy comparisons are diagnostic only and
   * can never produce a personal-local attestation rotation.
   */
  exactParityV2: TesseraProviderParityWorkflowExactV2;
  parity: TesseraProviderParityResult | null;
  providerAssessment: {
    localEngine: { strengths: string[]; weaknesses: string[] };
    website: { strengths: string[]; weaknesses: string[] };
  };
  strengths: string[];
  weaknesses: string[];
  nextActions: string[];
  limitations: string[];
  artifacts: Array<{
    format:
      | "provider-parity-json"
      | "provider-parity-html"
      | "provider-parity-sha256";
    written: string;
  }>;
};

export type RunTesseraProviderParityWorkflowOptions = {
  localReportPath: string;
  websiteReportPath: string;
  outputDirectory?: string;
  overwrite?: boolean;
  rootDir?: string;
  allowOutsideRoot?: boolean;
  personalRotation?: {
    machineIdSha256: string;
    rotationId: string;
    mode: "observe" | "enforce";
    completedAt?: string;
    verifiedAt?: string;
    recordPath?: string;
    overwrite?: boolean;
  };
};

export type RunTesseraProviderParityWorkflowResult = {
  ok: boolean;
  data: TesseraProviderParityWorkflowArtifact;
  personalRotationRecord?: PersonalLocalParityRotationRecordV1;
  personalRotationRecordPath?: string;
  violations: Array<{ code: string; message: string; severity: "error" }>;
  warnings: Array<{ code: string; message: string; severity: "warn" }>;
};

type VerifiedReport = {
  provider: TesseraParityProvider;
  path: string;
  receiptPath: string;
  serialized: string;
  reportSha256: string;
  receiptSha256: string;
  receiptEvidenceSha256: string;
  receipt: ExactMatchupReportReceipt;
  providerIdentity: TesseraSimulationProviderIdentity;
  report: TesseraMatchupReport;
};

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalCombatStates(
  states: readonly TesseraProviderParityCombatStateCellV2[],
): TesseraProviderParityCombatStateCellV2[] {
  return states.map((state) => ({ ...state })).sort((left, right) =>
    compareStrings(
      [
        left.scenarioId,
        left.metric,
        left.attackerInstanceId,
        left.targetInstanceId,
      ].join("\u0000"),
      [
        right.scenarioId,
        right.metric,
        right.attackerInstanceId,
        right.targetInstanceId,
      ].join("\u0000"),
    )
  );
}

export function tesseraProviderParityCombatStateEvidenceSha256V2(
  states: readonly TesseraProviderParityCombatStateCellV2[],
): string {
  return canonicalSha256({
    schemaVersion: 2,
    kind: "tessera-provider-parity-combat-state-evidence",
    cells: canonicalCombatStates(states),
  });
}

function canonicalCoverageWitnesses(
  witnesses: readonly TesseraProviderParityCoverageWitnessV2[],
): TesseraProviderParityCoverageWitnessV2[] {
  return witnesses.map((witness) => ({
    requirementId: witness.requirementId,
    relevantLeafIds: [...new Set(witness.relevantLeafIds)].sort(
      compareStrings,
    ),
  })).sort((left, right) =>
    compareStrings(left.requirementId, right.requirementId)
  );
}

export function tesseraProviderParityCoveringCaseEvidenceSha256V2(
  input: {
    coveringCaseId: string;
    combatBridgeV3Sha256: string;
    corpusConformanceReportSha256: string;
    coverageWitnesses: readonly TesseraProviderParityCoverageWitnessV2[];
  },
): string {
  return canonicalSha256({
    schemaVersion: 2,
    kind: "tessera-provider-parity-covering-case-evidence",
    coveringCaseId: input.coveringCaseId,
    combatBridgeV3Sha256: input.combatBridgeV3Sha256,
    corpusConformanceReportSha256:
      input.corpusConformanceReportSha256,
    coverageWitnesses: canonicalCoverageWitnesses(
      input.coverageWitnesses,
    ),
  });
}

/**
 * Provider-specific execution state is derived only from fields already
 * retained by (and therefore byte-bound to) the exact report receipt.
 */
export function tesseraProviderParityProviderStateEvidenceSha256V2(
  report: TesseraMatchupReport,
): string {
  return canonicalSha256({
    report: {
      runId: report.runId,
      source: report.source,
      status: report.status,
    },
    provider: {
      selectedBackend: report.simulation.selectedBackend ?? null,
      engine: report.simulation.engine ?? null,
      status: report.simulation.status ?? null,
      identity: report.simulation.providerIdentity ?? null,
      evidence: report.simulation.providerEvidence ?? null,
      evidenceCaptures:
        report.simulation.providerEvidenceCaptures ?? null,
    },
    scenarioPolicyContractV3Sha256:
      report.scenarioPolicyContractV3Sha256 ?? null,
    scenarios: (report.simulation.scenarios ?? []).map((scenario) => ({
      scenarioId: scenario.scenarioId,
      phase: scenario.phase,
      direction: scenario.direction,
      metrics: scenario.metrics,
      status: scenario.status,
      settings: scenario.settings,
      metricRuns: scenario.metricRuns ?? null,
      cells: scenario.cells.map((cell) => ({
        attackerInstanceId: cell.attacker.instanceId,
        targetInstanceId: cell.target.instanceId,
        confidence: cell.confidence,
        warningRefs: cell.warningRefs,
        conclusionEligibility: Object.fromEntries(
          Object.entries(cell.combatEnvelope ?? {}).map(
            ([metric, envelope]) => [
              metric,
              envelope?.conclusionEligibility ?? null,
            ],
          ),
        ),
      })),
    })),
  });
}

export function sealTesseraProviderParityReportEvidenceV2(
  input: Omit<TesseraProviderParityReportEvidenceV2, "evidenceSha256">,
): TesseraProviderParityReportEvidenceV2 {
  const core = {
    ...input,
    contractBinding: { ...input.contractBinding },
    coveringSuite: structuredClone(input.coveringSuite),
    coverageWitnesses: canonicalCoverageWitnesses(
      input.coverageWitnesses,
    ),
    combatStates: canonicalCombatStates(input.combatStates),
  };
  return { ...core, evidenceSha256: canonicalSha256(core) };
}

function reportEvidenceCandidate(
  report: TesseraMatchupReport,
): unknown {
  return (report.simulation as unknown as Record<string, unknown>)
    .providerParityEvidenceV2;
}

function parseReportEvidenceV2(
  value: unknown,
): TesseraProviderParityReportEvidenceV2 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "contractBinding",
      "coveringSuite",
      "coverageWitnesses",
      "combatStates",
      "providerStateEvidenceSha256",
      "evidenceSha256",
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== "rosterpilot-provider-parity-report-evidence" ||
    !isRecord(value.contractBinding) ||
    !hasExactKeys(value.contractBinding, [
      "scenarioPolicyContractV3Sha256",
      "combatBridgeV3Sha256",
      "corpusConformanceReportSha256",
      "coveringSuiteSha256",
      "coveringCaseId",
      "coveringCaseEvidenceSha256",
      "combatStateSha256",
      "playerRosterFingerprint",
      "opponentRosterFingerprint",
    ]) ||
    !Object.entries(value.contractBinding).every(([key, item]) =>
      key === "coveringCaseId"
        ? typeof item === "string" && item.length > 0
        : key === "playerRosterFingerprint" ||
            key === "opponentRosterFingerprint"
          ? typeof item === "string" && item.length > 0
          : typeof item === "string" && SHA256_PATTERN.test(item)
    ) ||
    !Array.isArray(value.coverageWitnesses) ||
    !value.coverageWitnesses.every((witness) =>
      isRecord(witness) &&
      hasExactKeys(witness, ["requirementId", "relevantLeafIds"]) &&
      typeof witness.requirementId === "string" &&
      witness.requirementId.length > 0 &&
      Array.isArray(witness.relevantLeafIds) &&
      witness.relevantLeafIds.every(
        (leafId) => typeof leafId === "string" && leafId.length > 0,
      )
    ) ||
    !Array.isArray(value.combatStates) ||
    !value.combatStates.every((state) =>
      isRecord(state) &&
      hasExactKeys(state, [
        "scenarioId",
        "attackerInstanceId",
        "targetInstanceId",
        "metric",
        "combatStateSha256",
      ]) &&
      typeof state.scenarioId === "string" && state.scenarioId.length > 0 &&
      typeof state.attackerInstanceId === "string" &&
      state.attackerInstanceId.length > 0 &&
      typeof state.targetInstanceId === "string" &&
      state.targetInstanceId.length > 0 &&
      typeof state.metric === "string" && state.metric.length > 0 &&
      typeof state.combatStateSha256 === "string" &&
      SHA256_PATTERN.test(state.combatStateSha256)
    ) ||
    typeof value.providerStateEvidenceSha256 !== "string" ||
    !SHA256_PATTERN.test(value.providerStateEvidenceSha256) ||
    typeof value.evidenceSha256 !== "string" ||
    !SHA256_PATTERN.test(value.evidenceSha256) ||
    !isRecord(value.coveringSuite)
  ) {
    return null;
  }
  return value as unknown as TesseraProviderParityReportEvidenceV2;
}

function v2Issue(
  code: TesseraProviderParityWorkflowV2Issue["code"],
  provider: TesseraParityProvider,
  message: string,
): TesseraProviderParityWorkflowV2Issue {
  return { code, provider, message };
}

function reportRosterFingerprints(
  report: TesseraMatchupReport,
): { player: string | null; opponent: string | null } {
  return {
    player: report.player.fingerprint ?? null,
    opponent: report.opponents.length === 1
      ? report.opponents[0].fingerprint ?? null
      : null,
  };
}

function receiptV2(
  report: VerifiedReport,
): ExactMatchupReportReceiptV2 | null {
  return report.receipt.schemaVersion === 2 ? report.receipt : null;
}

function reportBridgeEvidenceMatches(
  report: VerifiedReport,
  evidence: TesseraProviderParityReportEvidenceV2,
): boolean {
  const receipt = receiptV2(report);
  if (!receipt) return false;
  const candidates = report.report.simulation.combatBridgeEvidence ?? [];
  return candidates.some((candidate) => {
    const record = candidate as unknown as Record<string, unknown>;
    const exactness = isRecord(record.exactness) ? record.exactness : null;
    const corpus = exactness && isRecord(exactness.corpus)
      ? exactness.corpus
      : null;
    const bridgeSha256 = record.combatBridgeV3Sha256 ?? record.bridgeSha256;
    const corpusSha256 =
      record.corpusConformanceReportSha256 ?? corpus?.reportSha256;
    return (
      bridgeSha256 === evidence.contractBinding.combatBridgeV3Sha256 &&
      corpusSha256 ===
        evidence.contractBinding.corpusConformanceReportSha256 &&
      typeof record.evidenceSha256 === "string" &&
      receipt.bindings.combatBridgeEvidence.evidenceSha256s.includes(
        record.evidenceSha256,
      )
    );
  });
}

function combatStateKey(
  state: Pick<
    TesseraProviderParityCombatStateCellV2,
    "scenarioId" | "metric" | "attackerInstanceId" | "targetInstanceId"
  >,
): string {
  return [
    state.scenarioId,
    state.metric,
    state.attackerInstanceId,
    state.targetInstanceId,
  ].join("\u0000");
}

function reportShape(value: unknown): value is TesseraMatchupReport {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TesseraMatchupReport>;
  return (
    typeof candidate.runId === "string" &&
    typeof candidate.status === "string" &&
    !!candidate.player &&
    Array.isArray(candidate.opponents) &&
    !!candidate.simulation &&
    Array.isArray(candidate.simulation.scenarios)
  );
}

async function readVerifiedReport(
  reportPath: string,
  expectedProvider: TesseraParityProvider,
): Promise<VerifiedReport> {
  const resolved = path.resolve(reportPath);
  const receiptPath = exactReportReceiptPath(resolved);
  const [serialized, receiptText] = await Promise.all([
    readFile(resolved, "utf8"),
    readFile(receiptPath, "utf8"),
  ]);
  let reportValue: unknown;
  let receiptValue: unknown;
  try {
    reportValue = JSON.parse(serialized);
    receiptValue = JSON.parse(receiptText);
  } catch {
    throw new Error(
      `The ${expectedProvider} report or its exact-report receipt is not valid JSON.`,
    );
  }
  if (!reportShape(reportValue)) {
    throw new Error(
      `The ${expectedProvider} file is not a complete Tessera exact matchup report.`,
    );
  }
  const receiptError = verifyExactReportReceipt(
    resolved,
    serialized,
    reportValue,
    receiptValue,
  );
  if (receiptError) {
    throw new Error(`${expectedProvider} receipt verification failed: ${receiptError}`);
  }
  if (
    reportValue.simulation.selectedBackend !== expectedProvider ||
    reportValue.simulation.providerIdentity?.provider !== expectedProvider
  ) {
    throw new Error(
      `The ${expectedProvider} input report is bound to ${reportValue.simulation.selectedBackend ?? "no concrete provider"}.`,
    );
  }
  const expectedSource =
    expectedProvider === "local-engine"
      ? "tessera-local-engine"
      : "tessera-ui";
  if (reportValue.source !== expectedSource) {
    throw new Error(
      `The ${expectedProvider} input report source is ${reportValue.source}; expected ${expectedSource}.`,
    );
  }
  const receipt = parseExactReportReceipt(receiptValue);
  return {
    provider: expectedProvider,
    path: resolved,
    receiptPath,
    serialized,
    reportSha256: sha256(serialized),
    receiptSha256: sha256(receiptText),
    receiptEvidenceSha256: receipt.evidenceSha256,
    receipt,
    providerIdentity: reportValue.simulation.providerIdentity,
    report: reportValue,
  };
}

function adaptationView(
  result: TesseraReportBoundProviderParityAdapterResult,
) {
  return result.ok
    ? { ok: true, issues: [] }
    : { ok: false, issues: result.issues };
}

function validateExactReportEvidenceV2(input: {
  verified: VerifiedReport;
  adapted: TesseraReportBoundProviderParityAdapterResult;
}): {
  evidence: TesseraProviderParityReportEvidenceV2 | null;
  issues: TesseraProviderParityWorkflowV2Issue[];
} {
  const { verified, adapted } = input;
  const provider = verified.provider;
  const issues: TesseraProviderParityWorkflowV2Issue[] = [];
  const receipt = receiptV2(verified);
  if (!receipt) {
    issues.push(
      v2Issue(
        "PARITY_V2_EXACT_RECEIPT_REQUIRED",
        provider,
        "Exact provider parity v2 requires a schema-v2 exact-report receipt.",
      ),
    );
  }
  const candidate = reportEvidenceCandidate(verified.report);
  if (candidate === undefined || candidate === null) {
    issues.push(
      v2Issue(
        "PARITY_V2_REPORT_EVIDENCE_MISSING",
        provider,
        "The report has no receipt-bound provider-parity v2 evidence.",
      ),
    );
    return { evidence: null, issues };
  }
  const evidence = parseReportEvidenceV2(candidate);
  if (!evidence) {
    issues.push(
      v2Issue(
        "PARITY_V2_REPORT_EVIDENCE_INVALID",
        provider,
        "The receipt-bound provider-parity v2 evidence is malformed or has unknown fields.",
      ),
    );
    return { evidence: null, issues };
  }
  const { evidenceSha256, ...evidenceCore } = evidence;
  if (canonicalSha256(evidenceCore) !== evidenceSha256) {
    issues.push(
      v2Issue(
        "PARITY_V2_REPORT_EVIDENCE_HASH_INVALID",
        provider,
        "The provider-parity v2 evidence self-hash does not match its canonical contents.",
      ),
    );
  }

  let suiteValid = false;
  try {
    suiteValid = verifyTesseraParityCoveringSuiteV2(
      evidence.coveringSuite,
    );
  } catch {
    suiteValid = false;
  }
  if (
    !suiteValid ||
    evidence.coveringSuite.suiteSha256 !==
      evidence.contractBinding.coveringSuiteSha256
  ) {
    issues.push(
      v2Issue(
        "PARITY_V2_COVERING_SUITE_INVALID",
        provider,
        "The retained covering suite is invalid or does not match the exact contract binding.",
      ),
    );
  }
  const coveringCases = Array.isArray(evidence.coveringSuite.cases)
    ? evidence.coveringSuite.cases
    : [];
  const coveringCase = coveringCases.find(
    (entry) => entry.caseId === evidence.contractBinding.coveringCaseId,
  );
  const envelope = reportCompatibilityEnvelope(verified.report);
  const playerFaction = envelope?.rosters.find(
    (entry) => entry.side === "player" && entry.occurrence === 1,
  )?.factionId ?? null;
  const opponentFaction = envelope?.rosters.find(
    (entry) => entry.side === "opponent" && entry.occurrence === 1,
  )?.factionId ?? null;
  if (
    !coveringCase ||
    !playerFaction ||
    !opponentFaction ||
    !(
      (
        coveringCase.attackerFactionId === playerFaction &&
        coveringCase.defenderFactionId === opponentFaction
      ) ||
      (
        coveringCase.attackerFactionId === opponentFaction &&
        coveringCase.defenderFactionId === playerFaction
      )
    )
  ) {
    issues.push(
      v2Issue(
        "PARITY_V2_COVERING_CASE_MISMATCH",
        provider,
        "The covering case does not identify this report's exact player/opponent faction pairing.",
      ),
    );
  }
  const canonicalWitnesses = canonicalCoverageWitnesses(
    evidence.coverageWitnesses,
  );
  const witnessRequirements = canonicalWitnesses.map(
    (witness) => witness.requirementId,
  );
  const expectedRequirements = coveringCase
    ? [...coveringCase.coveredRequirementIds].sort(compareStrings)
    : [];
  const witnessesComplete =
    canonicalWitnesses.length === evidence.coverageWitnesses.length &&
    new Set(witnessRequirements).size === witnessRequirements.length &&
    canonicalJson(witnessRequirements) ===
      canonicalJson(expectedRequirements) &&
    canonicalWitnesses.every(
      (witness) =>
        !witness.requirementId.startsWith("mechanic:") ||
        witness.relevantLeafIds.length > 0,
    );
  const coveringCaseEvidenceSha256 =
    tesseraProviderParityCoveringCaseEvidenceSha256V2({
      coveringCaseId: evidence.contractBinding.coveringCaseId,
      combatBridgeV3Sha256:
        evidence.contractBinding.combatBridgeV3Sha256,
      corpusConformanceReportSha256:
        evidence.contractBinding.corpusConformanceReportSha256,
      coverageWitnesses: canonicalWitnesses,
    });
  if (
    !witnessesComplete ||
    coveringCaseEvidenceSha256 !==
      evidence.contractBinding.coveringCaseEvidenceSha256
  ) {
    issues.push(
      v2Issue(
        "PARITY_V2_COVERING_CASE_MISMATCH",
        provider,
        "The exact roster/bridge does not provide one complete relevant-leaf witness for every declared covering-case mechanic.",
      ),
    );
  }

  const scenarioV3 = verified.report.scenarioPolicyContractV3;
  const receiptScenarioV3 = receipt?.bindings.scenarioPolicies.filter(
    (entry) => entry.schemaVersion === 3,
  ) ?? [];
  let scenarioSha256: string | null = null;
  let scalarClaimsAllowed = false;
  try {
    scenarioSha256 = scenarioV3
      ? tesseraScenarioPolicyContractV3Sha256(scenarioV3)
      : null;
    scalarClaimsAllowed = scenarioV3
      ? tesseraScenarioPolicyContractV3ConclusionStatus(scenarioV3)
          .scalarClaimsAllowed
      : false;
  } catch {
    scenarioSha256 = null;
  }
  if (
    scenarioSha256 === null ||
    !scalarClaimsAllowed ||
    receiptScenarioV3.length !== 1 ||
    receiptScenarioV3[0].contractSha256 !== scenarioSha256 ||
    verified.report.scenarioPolicyContractV3Sha256 !== scenarioSha256 ||
    evidence.contractBinding.scenarioPolicyContractV3Sha256 !==
      scenarioSha256
  ) {
    issues.push(
      v2Issue(
        "PARITY_V2_SCENARIO_BINDING_MISMATCH",
        provider,
        "Exact parity requires one selected-state scenario-policy v3 contract matching both report and receipt.",
      ),
    );
  }

  if (!reportBridgeEvidenceMatches(verified, evidence)) {
    issues.push(
      v2Issue(
        "PARITY_V2_BRIDGE_BINDING_MISMATCH",
        provider,
        "No receipt-bound combat-bridge record matches the exact bridge-v3 and corpus-conformance identities.",
      ),
    );
  }

  const fingerprints = reportRosterFingerprints(verified.report);
  const receiptRosters = receipt?.bindings.sourceArtifacts.rosters ?? [];
  const receiptPlayer = receiptRosters.find(
    (entry) => entry.side === "player" && entry.occurrence === 1,
  );
  const receiptOpponent = receiptRosters.find(
    (entry) => entry.side === "opponent" && entry.occurrence === 1,
  );
  if (
    verified.report.opponents.length !== 1 ||
    fingerprints.player !==
      evidence.contractBinding.playerRosterFingerprint ||
    fingerprints.opponent !==
      evidence.contractBinding.opponentRosterFingerprint ||
    receiptPlayer?.fingerprint !== fingerprints.player ||
    receiptOpponent?.fingerprint !== fingerprints.opponent
  ) {
    issues.push(
      v2Issue(
        "PARITY_V2_ROSTER_BINDING_MISMATCH",
        provider,
        "The exact player/opponent roster fingerprints do not match report and receipt bindings.",
      ),
    );
  }

  const canonicalStates = canonicalCombatStates(evidence.combatStates);
  const stateKeys = canonicalStates.map(combatStateKey);
  const expectedStateKeys = adapted.ok
    ? adapted.run.cells.map(combatStateKey).sort(compareStrings)
    : [];
  const declaredStateSha256 =
    tesseraProviderParityCombatStateEvidenceSha256V2(canonicalStates);
  let envelopeMismatch = false;
  for (const scenario of verified.report.simulation.scenarios ?? []) {
    for (const cell of scenario.cells) {
      for (const metric of scenario.metrics) {
        const conclusion = cell.combatEnvelope?.[metric]
          ?.conclusionEligibility;
        if (!conclusion) continue;
        const state = canonicalStates.find(
          (entry) =>
            entry.scenarioId === scenario.scenarioId &&
            entry.metric === metric &&
            entry.attackerInstanceId === cell.attacker.instanceId &&
            entry.targetInstanceId === cell.target.instanceId,
        );
        if (
          !state ||
          conclusion.scalarClaimsAllowed !== true ||
          conclusion.mode !== "selected" ||
          conclusion.combatStateSha256 !== state.combatStateSha256 ||
          conclusion.scenarioPolicyContractV3Sha256 !== scenarioSha256
        ) {
          envelopeMismatch = true;
        }
      }
    }
  }
  if (
    !adapted.ok ||
    canonicalStates.length === 0 ||
    new Set(stateKeys).size !== stateKeys.length ||
    canonicalJson([...stateKeys].sort(compareStrings)) !==
      canonicalJson(expectedStateKeys) ||
    declaredStateSha256 !== evidence.contractBinding.combatStateSha256 ||
    envelopeMismatch
  ) {
    issues.push(
      v2Issue(
        "PARITY_V2_COMBAT_STATE_MISMATCH",
        provider,
        "The exact per-cell combat-state inventory is incomplete, duplicated, or detached from the compared cells.",
      ),
    );
  }

  if (
    tesseraProviderParityProviderStateEvidenceSha256V2(verified.report) !==
      evidence.providerStateEvidenceSha256
  ) {
    issues.push(
      v2Issue(
        "PARITY_V2_PROVIDER_STATE_MISMATCH",
        provider,
        "The provider-state evidence digest does not match receipt-bound execution state.",
      ),
    );
  }
  return { evidence, issues };
}

function buildExactWorkflowV2(input: {
  localReport: VerifiedReport;
  websiteReport: VerifiedReport;
  local: TesseraReportBoundProviderParityAdapterResult;
  website: TesseraReportBoundProviderParityAdapterResult;
}): TesseraProviderParityWorkflowExactV2 {
  const local = validateExactReportEvidenceV2({
    verified: input.localReport,
    adapted: input.local,
  });
  const website = validateExactReportEvidenceV2({
    verified: input.websiteReport,
    adapted: input.website,
  });
  const issues = [...local.issues, ...website.issues].sort((left, right) =>
    compareStrings(
      `${left.provider}|${left.code}|${left.message}`,
      `${right.provider}|${right.code}|${right.message}`,
    )
  );
  let result: TesseraProviderParityResultV2 | null = null;
  if (
    issues.length === 0 &&
    local.evidence &&
    website.evidence &&
    input.local.ok &&
    input.website.ok
  ) {
    const localRun: TesseraProviderParityRunV2 = {
      ...input.local.run,
      schemaVersion: 2,
      contractBinding: local.evidence.contractBinding,
      exactReceiptSha256: input.localReport.receiptSha256,
      providerStateEvidenceSha256:
        local.evidence.providerStateEvidenceSha256,
    };
    const websiteRun: TesseraProviderParityRunV2 = {
      ...input.website.run,
      schemaVersion: 2,
      contractBinding: website.evidence.contractBinding,
      exactReceiptSha256: input.websiteReport.receiptSha256,
      providerStateEvidenceSha256:
        website.evidence.providerStateEvidenceSha256,
    };
    result = compareTesseraProviderParityV2(localRun, websiteRun);
  }
  const pairedExactReceiptsSha256 = canonicalSha256([
    {
      provider: input.localReport.provider,
      receiptSha256: input.localReport.receiptSha256,
    },
    {
      provider: input.websiteReport.provider,
      receiptSha256: input.websiteReport.receiptSha256,
    },
  ]);
  const anyEvidence =
    reportEvidenceCandidate(input.localReport.report) != null ||
    reportEvidenceCandidate(input.websiteReport.report) != null;
  const status = result
    ? "complete" as const
    : anyEvidence
      ? "invalid" as const
      : "unavailable" as const;
  const personalAttestationEligible = Boolean(
    result?.eligible && result.complete && result.outcome === "pass",
  );
  const core = {
    schemaVersion: 2 as const,
    kind: "tessera-provider-parity-workflow-exact-binding" as const,
    status,
    personalAttestationEligible,
    pairedExactReceiptsSha256,
    reportEvidenceSha256: {
      localEngine: local.evidence?.evidenceSha256 ?? null,
      website: website.evidence?.evidenceSha256 ?? null,
    },
    issues,
    result,
  };
  return { ...core, exactBindingSha256: canonicalSha256(core) };
}

export function classifyTesseraProviderParityWorkflow(
  parity: TesseraProviderParityResult | null,
  adaptationsComplete: boolean,
): TesseraProviderParityWorkflowClassification {
  if (!adaptationsComplete || !parity) return "evidence-incomplete";
  if (parity.outcome === "incomplete") return "evidence-incomplete";
  if (parity.outcome === "pass") return "parity-pass";
  if (parity.outcome === "ineligible") return "data-or-input-drift";
  if (
    parity.eligible &&
    parity.issues.some((entry) => entry.category === "policy")
  ) {
    return "model-drift";
  }
  return "data-or-input-drift";
}

function reportCompatibilityEnvelope(report: TesseraMatchupReport) {
  if (report.providerCompatibilityEnvelopes !== undefined) {
    return report.providerCompatibilityEnvelopes.length === 1
      ? report.providerCompatibilityEnvelopes[0]
      : null;
  }
  return report.providerCompatibility ?? null;
}

function executionEvidence(report: VerifiedReport) {
  const compatibility = reportCompatibilityEnvelope(report.report);
  const website = compatibility?.tessera.website ?? null;
  const stateBindings = website?.importSemantics.stateBindings;
  return {
    reportSource: report.report.source,
    reportStatus: report.report.status,
    simulationStatus: report.report.simulation.status ?? null,
    engine: report.report.simulation.engine ?? null,
    providerIdentity: report.providerIdentity,
    providerIdentitySha256: sha256(canonicalJson(report.providerIdentity)),
    complete:
      report.report.status === "complete" &&
      report.report.simulation.status === "complete",
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

function findings(input: {
  local: TesseraReportBoundProviderParityAdapterResult;
  website: TesseraReportBoundProviderParityAdapterResult;
  parity: TesseraProviderParityResult | null;
}): {
  strengths: string[];
  weaknesses: string[];
  nextActions: string[];
} {
  const strengths = [
    "Both source reports and their exact-report receipts were verified before comparison.",
  ];
  const weaknesses: string[] = [];
  const nextActions: string[] = [];
  if (input.local.ok && input.website.ok) {
    strengths.push(
      "Both providers supplied complete report-bound bundle, roster, provider, scenario, capability, and combat evidence.",
    );
    if (
      input.local.bindings.normalizedScenarioContractSha256 ===
      input.website.bindings.normalizedScenarioContractSha256
    ) {
      strengths.push(
        "The raw provider settings normalize to the same frozen gameplay contract.",
      );
    }
  } else {
    for (const [provider, adaptation] of [
      ["local-engine", input.local],
      ["website", input.website],
    ] as const) {
      if (adaptation.ok) continue;
      weaknesses.push(
        ...adaptation.issues.map(
          (entry) => `${provider}: ${entry.code} — ${entry.message}`,
        ),
      );
    }
    nextActions.push(
      "Regenerate the failed provider report with a complete compatibility envelope, explicit frozen scenario contract, and receipt-bound semantic/input evidence.",
    );
  }
  if (input.parity) {
    if (input.parity.modelCapabilityEnvelope.status === "match") {
      strengths.push("The providers declare the same normalized combat-model capability.");
    }
    if (input.parity.combatSnapshot.status === "match") {
      strengths.push("The provider-neutral unit, weapon, defense, and effect snapshots match.");
    }
    for (const summary of input.parity.metricSummaries) {
      const rate = (summary.withinToleranceRate * 100).toFixed(2);
      const text = `${summary.metric}: ${rate}% (${summary.withinToleranceCount}/${summary.expectedCellCount}) within tolerance.`;
      (summary.status === "pass" ? strengths : weaknesses).push(text);
    }
    const failedWinners = input.parity.winnerClassifications.filter(
      (winner) => winner.status === "fail",
    );
    if (failedWinners.length === 0 && input.parity.winnerClassifications.length > 0) {
      strengths.push(
        "The canonical probability-pressure winner agrees, including uncertainty boundaries.",
      );
    } else if (failedWinners.length > 0) {
      weaknesses.push(
        `${failedWinners.length} canonical winner classification(s) disagree outside uncertainty.`,
      );
    }
    weaknesses.push(
      ...input.parity.issues.map(
        (entry) => `${entry.code}${entry.key ? ` (${entry.key})` : ""}: ${entry.message}`,
      ),
    );
    if (input.parity.outcome === "fail") {
      nextActions.push(
        "Inspect the largest tolerance multiples and effect/profile diffs; treat them as model drift only after all eligibility identities remain matched.",
      );
    } else if (input.parity.outcome === "ineligible") {
      nextActions.push(
        "Resolve bundle, roster, profile, scenario, capability, or combat-snapshot drift before interpreting numeric differences.",
      );
    } else if (input.parity.outcome === "incomplete") {
      nextActions.push(
        "Repeat the paired run with complete cells and retained sample uncertainty for every requested metric.",
      );
    }
  }
  return {
    strengths: [...new Set(strengths)],
    weaknesses: [...new Set(weaknesses)],
    nextActions: [...new Set(nextActions)],
  };
}

function providerAssessment(input: {
  localReport: VerifiedReport;
  websiteReport: VerifiedReport;
  local: TesseraReportBoundProviderParityAdapterResult;
  website: TesseraReportBoundProviderParityAdapterResult;
}) {
  const localStrengths = [
    "The exact local report and receipt bind one pinned tessera-engine identity to hash-verified, bundle-native simulation inputs.",
  ];
  const localWeaknesses = [
    "Local reproducibility applies only to the explicitly shared combat-capability envelope; missions, movement, terrain geometry, stratagem sequencing, and other omitted mechanics are not modeled here.",
  ];
  const localIdentity = input.localReport.providerIdentity;
  if (input.local.ok) {
    localStrengths.push(
      "Roster, scenario, combat-profile, and capability identities were rebuilt from report-bound local inputs without a website dependency.",
    );
  } else {
    localWeaknesses.push(
      "The local evidence did not satisfy the strict report-bound parity adapter, so its numeric cells cannot establish provider parity.",
    );
  }
  if (
    localIdentity.provider === "local-engine" &&
    !localTesseraProviderIdentityAllowsAnalyticalClaims(localIdentity)
  ) {
    localWeaknesses.push(
      `The pinned local engine is ${localIdentity.promotion} with ${localIdentity.licenseState} usage state; one comparison alone does not activate the machine-local provider.`,
    );
  }

  const websiteStrengths = [
    "The exact Web report and receipt bind the result to one observed tessera-ui deployment and selected provider identity.",
  ];
  const websiteWeaknesses = [
    "Tessera Web does not expose a source commit or authoritative semantic rules version here; identity is limited to observed deployment bytes, adapter identity, selected-list state, and visible semantics.",
  ];
  const websiteEvidence =
    executionEvidence(input.websiteReport).website;
  if (
    input.website.ok &&
    websiteEvidence?.deploymentComplete &&
    websiteEvidence.importSemanticsComplete &&
    websiteEvidence.stateBindingsComplete
  ) {
    websiteStrengths.push(
      "Live deployment hashes, imported unit/weapon/effect semantics, and both selected-list state bindings were complete for this run.",
    );
  } else {
    websiteWeaknesses.push(
      "The captured Web deployment/import/state evidence was incomplete or failed strict semantic derivation, so opaque behavior cannot be filled from local roster data.",
    );
  }
  return {
    localEngine: {
      strengths: localStrengths,
      weaknesses: localWeaknesses,
    },
    website: {
      strengths: websiteStrengths,
      weaknesses: websiteWeaknesses,
    },
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function listHtml(values: string[], empty: string): string {
  return values.length > 0
    ? `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
    : `<p class="muted">${escapeHtml(empty)}</p>`;
}

export function renderTesseraProviderParityWorkflowHtml(
  artifact: TesseraProviderParityWorkflowArtifact,
): string {
  const metricRows = artifact.parity?.metricSummaries.map((summary) => `
<tr><th>${escapeHtml(summary.metric)}</th><td>${escapeHtml(summary.status)}</td><td>${escapeHtml(summary.comparedCellCount)}/${escapeHtml(summary.expectedCellCount)}</td><td>${escapeHtml((summary.withinToleranceRate * 100).toFixed(2))}%</td><td>${escapeHtml(summary.beyondDoubleToleranceCount)}</td></tr>`).join("") ?? "";
  const largestCells = [...(artifact.parity?.cells ?? [])]
    .filter((cell) => cell.toleranceMultiple !== null)
    .sort((left, right) =>
      (right.toleranceMultiple ?? -1) - (left.toleranceMultiple ?? -1)
    )
    .slice(0, 20)
    .map((cell) => `
<tr><th>${escapeHtml(cell.key)}</th><td>${escapeHtml(cell.metric)}</td><td>${escapeHtml(cell.localValue)}</td><td>${escapeHtml(cell.websiteValue)}</td><td>${escapeHtml(cell.difference)}</td><td>${escapeHtml(cell.tolerance?.value ?? "—")}</td><td>${escapeHtml(cell.toleranceMultiple?.toFixed(2) ?? "—")}</td><td>${escapeHtml(cell.status)}</td></tr>`)
    .join("");
  const sourceRows = artifact.sourceReports.map((source) => `
<tr><th>${escapeHtml(source.provider)}</th><td>${escapeHtml(source.executionEvidence.reportSource)} / ${escapeHtml(source.executionEvidence.reportStatus)} / ${escapeHtml(source.executionEvidence.simulationStatus ?? "unavailable")}</td><td><code>${escapeHtml(source.runId)}</code></td><td><code>${escapeHtml(source.reportSha256)}</code><br><code>${escapeHtml(source.receiptSha256)}</code></td><td><code>${escapeHtml(source.providerCompatibilityEnvelopeSha256 ?? "unavailable")}</code></td><td><code>${escapeHtml(source.rawScenarioContractSha256 ?? "unavailable")}</code></td><td><code>${escapeHtml(source.normalizedScenarioContractSha256 ?? "unavailable")}</code></td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera provider parity</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;margin:0;background:#f4f6f8;color:#17202a}main{max-width:1200px;margin:auto;padding:32px}header,section{background:white;border:1px solid #dfe5eb;border-radius:12px;padding:20px;margin:0 0 18px}h1,h2{margin-top:0}.badge{display:inline-block;border-radius:999px;padding:5px 10px;background:#e8eef5;font-weight:700}.pass{background:#dff5e5}.fail{background:#fde2df}.muted{color:#596773}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e8edf2;padding:8px}code{font-size:12px;overflow-wrap:anywhere}.caution{border-left:4px solid #d68a00;padding-left:12px}</style></head><body><main>
<header><p class="badge ${artifact.outcome === "pass" ? "pass" : "fail"}">${escapeHtml(artifact.outcome)}</p><h1>Local engine vs Tessera Web</h1><p>Classification: <strong>${escapeHtml(artifact.classification)}</strong> · Generated ${escapeHtml(artifact.generatedAt)}</p><p class="caution">Directional combat parity only. This is not a game win probability.</p></header>
<section><h2>Bound sources and scenario identity</h2><table><thead><tr><th>Provider</th><th>Source / report / simulation</th><th>Run</th><th>Report / receipt SHA-256</th><th>Compatibility envelope</th><th>Raw contract</th><th>Normalized contract</th></tr></thead><tbody>${sourceRows}</tbody></table><p class="muted">Only the provider-only <code>provider</code> setting is discarded. Phase, direction, metric, and iteration metadata are compared structurally. Cover, charge, range, stationary, and indirect-fire semantics are mapped and compared; unknown settings fail closed.</p></section>
<section><h2>Provider-specific assessment</h2><h3>Local engine — strengths</h3>${listHtml(artifact.providerAssessment.localEngine.strengths, "No local-engine strength was established.")}<h3>Local engine — weaknesses</h3>${listHtml(artifact.providerAssessment.localEngine.weaknesses, "No local-engine limitation was recorded.")}<h3>Tessera Web — strengths</h3>${listHtml(artifact.providerAssessment.website.strengths, "No Web strength was established.")}<h3>Tessera Web — weaknesses</h3>${listHtml(artifact.providerAssessment.website.weaknesses, "No Web limitation was recorded.")}</section>
<section><h2>Strengths</h2>${listHtml(artifact.strengths, "No strengths could be established from the retained evidence.")}</section>
<section><h2>Weaknesses</h2>${listHtml(artifact.weaknesses, "No policy weakness was detected.")}</section>
<section><h2>Metric coverage</h2>${metricRows ? `<table><thead><tr><th>Metric</th><th>Status</th><th>Compared</th><th>Within tolerance</th><th>Beyond 2×</th></tr></thead><tbody>${metricRows}</tbody></table>` : '<p class="muted">Numeric parity was not eligible.</p>'}</section>
<section><h2>Largest normalized differences</h2>${largestCells ? `<table><thead><tr><th>Cell</th><th>Metric</th><th>Local</th><th>Web</th><th>Difference</th><th>Tolerance</th><th>Multiple</th><th>Status</th></tr></thead><tbody>${largestCells}</tbody></table>` : '<p class="muted">No comparable cells.</p>'}</section>
<section><h2>Next actions</h2>${listHtml(artifact.nextActions, "No corrective action is required by this comparison.")}</section>
<section><h2>Limitations</h2>${listHtml(artifact.limitations, "")}</section>
</main></body></html>`;
}

export async function runTesseraProviderParityWorkflow(
  options: RunTesseraProviderParityWorkflowOptions,
): Promise<RunTesseraProviderParityWorkflowResult> {
  const [localReport, websiteReport] = await Promise.all([
    readVerifiedReport(options.localReportPath, "local-engine"),
    readVerifiedReport(options.websiteReportPath, "website"),
  ]);
  const [local, website] = await Promise.all([
    adaptReportBoundTesseraMatchupReportToProviderParityRun(
      localReport.report,
      localReport.path,
    ),
    adaptReportBoundTesseraMatchupReportToProviderParityRun(
      websiteReport.report,
      websiteReport.path,
    ),
  ]);
  const parity = local.ok && website.ok
    ? compareTesseraProviderParity(local.run, website.run)
    : null;
  const exactParityV2 = buildExactWorkflowV2({
    localReport,
    websiteReport,
    local,
    website,
  });
  const summary = findings({ local, website, parity });
  const perProvider = providerAssessment({
    localReport,
    websiteReport,
    local,
    website,
  });
  const outputDirectory = options.outputDirectory ?? "exports/tessera/parity";
  const filenames = {
    json: "tessera-provider-parity.json",
    html: "tessera-provider-parity.html",
    checksum: "tessera-provider-parity.json.sha256",
  };
  const sourceReports = [
    { verified: localReport, adapted: local },
    { verified: websiteReport, adapted: website },
  ].map(({ verified, adapted }) => ({
    provider: verified.provider,
    reportPath: path.basename(verified.path),
    receiptPath: path.basename(verified.receiptPath),
    reportSha256: verified.reportSha256,
    receiptSha256: verified.receiptSha256,
    receiptEvidenceSha256: verified.receiptEvidenceSha256,
    runId: verified.report.runId,
    executionEvidence: executionEvidence(verified),
    providerCompatibilityEnvelopeSha256:
      adapted.ok
        ? adapted.bindings.providerCompatibilityEnvelopeSha256
        : verified.report.providerCompatibility?.envelopeSha256 ?? null,
    rawScenarioContractSha256:
      adapted.ok
        ? adapted.bindings.rawScenarioContractSha256
        : verified.report.scenarioContractSha256 ?? null,
    normalizedScenarioContractSha256:
      adapted.ok
        ? adapted.bindings.normalizedScenarioContractSha256
        : null,
    normalizedInputSha256:
      adapted.ok ? adapted.bindings.normalizedInputSha256 : null,
  }));
  const comparisonClassification = classifyTesseraProviderParityWorkflow(
    parity,
    local.ok && website.ok,
  );
  const generatedAt = new Date().toISOString();
  const artifact: TesseraProviderParityWorkflowArtifact = {
    schemaVersion: 1,
    kind: "tessera-provider-parity-comparison",
    evidenceKind: "paired-receipt-bound-completed-provider-reports",
    sourceResolution: {
      kind: "reports-root-sha256-run-id",
      reportRootRequired: true,
    },
    generatedAt,
    outcome: parity?.outcome ?? "ineligible",
    classification: comparisonClassification,
    sourceReports,
    scenarioNormalization: {
      version: TESSERA_PROVIDER_NEUTRAL_SCENARIO_SETTINGS_VERSION,
      providerOnlySettingsIgnored: ["provider"],
      gameplaySettingsCompared: [
        "targetInCover",
        "charging",
        "withinRapidFireRange",
        "withinMeltaRange",
        "remainedStationary",
        "indirectFire",
      ],
    },
    adaptation: {
      local: adaptationView(local),
      website: adaptationView(website),
    },
    exactParityV2,
    parity,
    providerAssessment: perProvider,
    strengths: summary.strengths,
    weaknesses: summary.weaknesses,
    nextActions: summary.nextActions,
    limitations: [
      "This comparison measures directional combat-model parity, not game win probability.",
      "Movement, terrain geometry, missions, scoring, deployment, sequencing, player decisions, and mechanics outside the shared capability envelope remain out of scope.",
      "A pass applies only to the exact receipt-bound reports, data bundle, provider deployments, imported semantics, profile policy, and frozen scenario contract named here.",
      ...(exactParityV2.personalAttestationEligible
        ? []
        : [
            "This comparison is not eligible for a personal-local attestation rotation unless exact provider-parity v2 bindings are complete and passing.",
          ]),
    ],
    artifacts: [
      { format: "provider-parity-json", written: filenames.json },
      { format: "provider-parity-html", written: filenames.html },
      { format: "provider-parity-sha256", written: filenames.checksum },
    ],
  };
  const json = `${canonicalJson(artifact)}\n`;
  const html = renderTesseraProviderParityWorkflowHtml(artifact);
  const checksum = `${sha256(json)}  ${filenames.json}\n`;
  const exportArtifacts: ExportArtifact[] = [
    {
      format: "roster-json",
      filename: filenames.json,
      mimeType: "application/json",
      encoding: "utf8",
      content: json,
    },
    {
      format: "html",
      filename: filenames.html,
      mimeType: "text/html; charset=utf-8",
      encoding: "utf8",
      content: html,
    },
    {
      format: "text",
      filename: filenames.checksum,
      mimeType: "text/plain; charset=utf-8",
      encoding: "utf8",
      content: checksum,
    },
  ];
  const written = await writeExportArtifacts(
    exportArtifacts,
    outputDirectory,
    {
      rootDir: options.rootDir,
      overwrite: options.overwrite,
      allowOutsideRoot: options.allowOutsideRoot,
    },
  );
  artifact.artifacts = [
    { format: "provider-parity-json", written: written[0] },
    { format: "provider-parity-html", written: written[1] },
    { format: "provider-parity-sha256", written: written[2] },
  ];
  let personalRotationRecord:
    | PersonalLocalParityRotationRecordV1
    | undefined;
  let personalRotationRecordPath: string | undefined;
  const workflowWarnings: RunTesseraProviderParityWorkflowResult["warnings"] = [];
  if (options.personalRotation) {
    const localExactEvidence = parseReportEvidenceV2(
      reportEvidenceCandidate(localReport.report),
    );
    const oneCaseCoversSuite =
      localExactEvidence?.coveringSuite.cases.length === 1;
    if (
      exactParityV2.personalAttestationEligible &&
      exactParityV2.result &&
      oneCaseCoversSuite
    ) {
      personalRotationRecord = sealPersonalLocalParityRotationRecordV1({
        machineIdSha256: options.personalRotation.machineIdSha256,
        providerIdentitySha256: sha256(
          canonicalJson(localReport.providerIdentity),
        ),
        bundleId: local.run?.identity.dataBundleId ?? "",
        rotation: {
          rotationId: options.personalRotation.rotationId,
          mode: options.personalRotation.mode,
          outcome: "pass",
          exactReceiptSha256:
            exactParityV2.pairedExactReceiptsSha256,
          coverageSuiteSha256:
            exactParityV2.result.contractBinding!
              .coveringSuiteSha256,
          completedAt:
            options.personalRotation.completedAt ?? generatedAt,
        },
        parityResultSha256: exactParityV2.result.resultSha256,
        verifiedAt:
          options.personalRotation.verifiedAt ?? generatedAt,
      });
      if (options.personalRotation.recordPath) {
        personalRotationRecordPath =
          await writePersonalLocalParityRotationRecordV1({
            record: personalRotationRecord,
            filename: options.personalRotation.recordPath,
            overwrite: options.personalRotation.overwrite,
          });
      }
    } else {
      workflowWarnings.push({
        code: "TESSERA_PERSONAL_PARITY_ROTATION_INELIGIBLE",
        message:
          "No personal parity rotation record was created because exact provider-parity v2 evidence was unavailable, invalid, incomplete, non-passing, or this comparison did not cover the complete bidirectional suite in one case.",
        severity: "warn",
      });
    }
  }
  const ok = parity?.outcome === "pass";
  return {
    ok,
    data: artifact,
    ...(personalRotationRecord ? { personalRotationRecord } : {}),
    ...(personalRotationRecordPath
      ? { personalRotationRecordPath }
      : {}),
    violations: ok
      ? []
      : [{
          code:
            comparisonClassification === "model-drift"
              ? "TESSERA_PROVIDER_MODEL_DRIFT"
              : comparisonClassification === "evidence-incomplete"
                ? "TESSERA_PROVIDER_PARITY_EVIDENCE_INCOMPLETE"
                : "TESSERA_PROVIDER_PARITY_INELIGIBLE",
          message:
            comparisonClassification === "model-drift"
              ? "The eligible local and website reports failed the numerical parity policy."
              : comparisonClassification === "evidence-incomplete"
                ? "The local and website reports did not retain complete evidence for every requested parity cell."
                : "The local and website reports did not establish eligible provider parity.",
          severity: "error",
        }],
    warnings: workflowWarnings,
  };
}
