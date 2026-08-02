import crypto from "node:crypto";

import type {
  TesseraMatchupReport,
  TesseraMetric,
  TesseraMetricValues,
  TesseraScenarioResult,
} from "../../lib/rosterpilot/types";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  tesseraProviderParityCombatSnapshotSha256,
  tesseraProviderParityContractSha256,
  tesseraProviderParityModelCapabilityEnvelopeSha256,
  type TesseraParityProvider,
  type TesseraProviderParityCell,
  type TesseraProviderParityModelCapabilityEnvelope,
  type TesseraProviderParityNormalizedCombatSnapshot,
  type TesseraProviderParityRun,
  type TesseraProviderParityScenarioContract,
} from "./provider-parity";
import {
  validateTesseraProviderParityCombatSnapshot,
  validateTesseraProviderParityModelCapabilityEnvelope,
} from "./provider-parity-evidence";
import {
  providerCompatibilityEnvelopeSha256,
  providerCompatibilityTrustBindingIssues,
  type ProviderCompatibilityEnvelope,
} from "./provider-compatibility";
import {
  deriveTesseraLocalProviderParityEvidence,
  TESSERA_PROVIDER_PARITY_COMBAT_MODEL_VERSION,
} from "./local-provider-parity-evidence";
import {
  normalizeTesseraReportScenarioContractForParity,
} from "./provider-parity-scenario-contract";
import {
  deriveTesseraWebsiteProviderParityEvidence,
} from "./website-provider-parity-evidence";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type TesseraProviderParityReportAdapterIssueCode =
  | "REPORT_NOT_COMPLETE"
  | "REPORT_PROVIDER_MISMATCH"
  | "REPORT_SCENARIOS_MISSING"
  | "REPORT_SCENARIO_INCOMPLETE"
  | "REPORT_CONTRACT_INCOMPLETE"
  | "REPORT_CELL_INVALID"
  | "REPORT_CELL_UNCERTAINTY_INCOMPLETE"
  | "PARITY_IDENTITY_INCOMPLETE"
  | "MODEL_CAPABILITY_ENVELOPE_INVALID"
  | "COMBAT_SNAPSHOT_INVALID"
  | "COMBAT_SNAPSHOT_COVERAGE_INCOMPLETE"
  | "REPORT_SCOPE_INVALID"
  | "PROVIDER_COMPATIBILITY_MISSING"
  | "PROVIDER_COMPATIBILITY_INVALID"
  | "PROVIDER_COMPATIBILITY_INCOMPLETE"
  | "REPORT_BINDING_MISMATCH"
  | "SCENARIO_NORMALIZATION_FAILED"
  | "REPORT_BOUND_EVIDENCE_UNAVAILABLE";

export type TesseraProviderParityReportAdapterIssue = {
  code: TesseraProviderParityReportAdapterIssueCode;
  message: string;
  scenarioId: string | null;
  metric: TesseraMetric | null;
  cellKey: string | null;
};

export type TesseraProviderParityReportAdapterOptions = {
  provider: TesseraParityProvider;
  providerIdentity: string;
  dataBundleId: string;
  normalizedInputSha256: string;
  profilePolicyHash?: string | null;
  modelCapabilityEnvelope: TesseraProviderParityModelCapabilityEnvelope;
  combatSnapshot: TesseraProviderParityNormalizedCombatSnapshot;
};

export type TesseraProviderParityReportAdapterResult =
  | {
      ok: true;
      run: TesseraProviderParityRun;
      issues: [];
    }
  | {
      ok: false;
      run: null;
      issues: TesseraProviderParityReportAdapterIssue[];
    };

export type TesseraReportBoundProviderParityAdapterResult =
  | {
      ok: true;
      run: TesseraProviderParityRun;
      bindings: {
        reportRunId: string;
        providerCompatibilityEnvelopeSha256: string;
        rawScenarioContractSha256: string;
        normalizedScenarioContractSha256: string;
        normalizedInputSha256: string;
      };
      issues: [];
    }
  | {
      ok: false;
      run: null;
      bindings: null;
      issues: TesseraProviderParityReportAdapterIssue[];
    };

function issue(
  code: TesseraProviderParityReportAdapterIssueCode,
  message: string,
  options: {
    scenarioId?: string | null;
    metric?: TesseraMetric | null;
    cellKey?: string | null;
  } = {},
): TesseraProviderParityReportAdapterIssue {
  return {
    code,
    message,
    scenarioId: options.scenarioId ?? null,
    metric: options.metric ?? null,
    cellKey: options.cellKey ?? null,
  };
}

function metricValue(
  values: TesseraMetricValues,
  metric: TesseraMetric,
): number | null {
  if (metric === "wipe-probability") return values.wipeProbability;
  if (metric === "half-wipe-probability") {
    return values.halfWipeProbability;
  }
  if (metric === "mean-kills") return values.meanKills;
  return values.meanDamage;
}

function isProbabilityMetric(metric: TesseraMetric): boolean {
  return (
    metric === "wipe-probability" ||
    metric === "half-wipe-probability"
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validSettings(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([key, item]) => key.length > 0 && typeof item === "string",
    )
  );
}

function metricRunFor(
  scenario: TesseraScenarioResult,
  metric: TesseraMetric,
): NonNullable<TesseraScenarioResult["metricRuns"]>[number] | null {
  const matches = scenario.metricRuns?.filter(
    (metricRun) => metricRun.metric === metric,
  );
  return matches?.length === 1 ? matches[0] : null;
}

function scenarioContractForMetric(
  scenario: TesseraScenarioResult,
  metric: TesseraMetric,
  issues: TesseraProviderParityReportAdapterIssue[],
): TesseraProviderParityScenarioContract | null {
  const metricRunsPresent = Array.isArray(scenario.metricRuns);
  const metricRunMatches = scenario.metricRuns?.filter(
    (entry) => entry.metric === metric,
  );
  const metricRun = metricRunFor(scenario, metric);
  if (
    (metricRunsPresent && metricRunMatches?.length !== 1) ||
    metricRun?.integrity?.status === "aliased"
  ) {
    issues.push(
      issue(
        "REPORT_CONTRACT_INCOMPLETE",
        `Scenario ${scenario.scenarioId} does not retain one trusted metric run for ${metric}.`,
        { scenarioId: scenario.scenarioId, metric },
      ),
    );
    return null;
  }
  const iterations = metricRun?.iterations ?? scenario.iterations;
  const settings = metricRun?.settings ?? scenario.settings;
  if (
    !scenario.scenarioId ||
    !positiveInteger(iterations) ||
    !validSettings(settings)
  ) {
    issues.push(
      issue(
        "REPORT_CONTRACT_INCOMPLETE",
        `Scenario ${scenario.scenarioId || "<missing>"} lacks retained iterations or settings for ${metric}.`,
        { scenarioId: scenario.scenarioId || null, metric },
      ),
    );
    return null;
  }
  return {
    scenarioId: scenario.scenarioId,
    phase: scenario.phase,
    direction: scenario.direction,
    metric,
    settings: { ...settings },
    iterations,
  };
}

function parityCell(
  scenario: TesseraScenarioResult,
  contract: TesseraProviderParityScenarioContract,
  cell: TesseraScenarioResult["cells"][number],
  issues: TesseraProviderParityReportAdapterIssue[],
): TesseraProviderParityCell | null {
  const value = metricValue(cell.values, contract.metric);
  const expectedAttackerSide =
    scenario.direction === "player-to-opponent" ? "player" : "opponent";
  const expectedTargetSide =
    expectedAttackerSide === "player" ? "opponent" : "player";
  const cellDisplayKey = [
    scenario.scenarioId,
    contract.metric,
    cell.attacker.instanceId,
    cell.target.instanceId,
  ].join("|");
  if (
    !cell.attacker.instanceId ||
    !cell.target.instanceId ||
    cell.attacker.side !== expectedAttackerSide ||
    cell.target.side !== expectedTargetSide ||
    cell.confidence !== "high" ||
    cell.warningRefs.length > 0 ||
    !finiteNonNegative(value) ||
    (isProbabilityMetric(contract.metric) && value > 1)
  ) {
    issues.push(
      issue(
        "REPORT_CELL_INVALID",
        `Scenario ${scenario.scenarioId} has no finite comparable ${contract.metric} value for ${cellDisplayKey}.`,
        {
          scenarioId: scenario.scenarioId,
          metric: contract.metric,
          cellKey: cellDisplayKey,
        },
      ),
    );
    return null;
  }

  const uncertainty = cell.uncertainty?.[contract.metric];
  const retainedSampleCount = uncertainty?.sampleCount;
  const sampleCount =
    retainedSampleCount === null || retainedSampleCount === undefined
      ? contract.iterations
      : retainedSampleCount;
  if (
    !positiveInteger(sampleCount) ||
    sampleCount !== contract.iterations ||
    (uncertainty?.standardDeviation !== null &&
      uncertainty?.standardDeviation !== undefined &&
      !finiteNonNegative(uncertainty.standardDeviation)) ||
    (uncertainty?.standardError !== null &&
      uncertainty?.standardError !== undefined &&
      !finiteNonNegative(uncertainty.standardError))
  ) {
    issues.push(
      issue(
        "REPORT_CELL_UNCERTAINTY_INCOMPLETE",
        `Scenario ${scenario.scenarioId} has invalid retained sampling evidence for ${cellDisplayKey}.`,
        {
          scenarioId: scenario.scenarioId,
          metric: contract.metric,
          cellKey: cellDisplayKey,
        },
      ),
    );
    return null;
  }

  const standardDeviation = uncertainty?.standardDeviation;
  const standardError = uncertainty?.standardError;
  if (
    !isProbabilityMetric(contract.metric) &&
    (uncertainty?.completeness !== "complete" ||
      (!finiteNonNegative(standardDeviation) &&
        !finiteNonNegative(standardError)))
  ) {
    issues.push(
      issue(
        "REPORT_CELL_UNCERTAINTY_INCOMPLETE",
        `Scenario ${scenario.scenarioId} does not retain complete mean uncertainty for ${cellDisplayKey}; parity will not invent it.`,
        {
          scenarioId: scenario.scenarioId,
          metric: contract.metric,
          cellKey: cellDisplayKey,
        },
      ),
    );
    return null;
  }

  return {
    scenarioId: scenario.scenarioId,
    attackerInstanceId: cell.attacker.instanceId,
    targetInstanceId: cell.target.instanceId,
    metric: contract.metric,
    value,
    iterations: contract.iterations,
    sampleCount,
    ...(finiteNonNegative(standardDeviation)
      ? { sampleVariance: standardDeviation ** 2 }
      : {}),
    ...(finiteNonNegative(standardError) ? { standardError } : {}),
  };
}

export function adaptTesseraMatchupReportToProviderParityRun(
  report: TesseraMatchupReport,
  options: TesseraProviderParityReportAdapterOptions,
): TesseraProviderParityReportAdapterResult {
  const issues: TesseraProviderParityReportAdapterIssue[] = [];
  if (
    report.status !== "complete" ||
    report.simulation.requested !== true ||
    report.simulation.status !== "complete" ||
    report.simulation.executionMode === "prepare-only" ||
    (report.failures?.length ?? 0) > 0
  ) {
    issues.push(
      issue(
        "REPORT_NOT_COMPLETE",
        "Provider parity requires a complete simulated matchup report without retained failures.",
      ),
    );
  }
  const expectedSource =
    options.provider === "local-engine"
      ? "tessera-local-engine"
      : "tessera-ui";
  if (
    report.source !== expectedSource ||
    report.simulation.selectedBackend !== options.provider ||
    !report.simulation.providerIdentity ||
    report.simulation.providerIdentity.provider !== options.provider
  ) {
    issues.push(
      issue(
        "REPORT_PROVIDER_MISMATCH",
        `The report does not retain a complete ${options.provider} provider identity.`,
      ),
    );
  }
  if (
    options.providerIdentity.trim().length === 0 ||
    options.dataBundleId.trim().length === 0 ||
    !SHA256_PATTERN.test(options.normalizedInputSha256)
  ) {
    issues.push(
      issue(
        "PARITY_IDENTITY_INCOMPLETE",
        "The explicit provider, bundle, or normalized-input identity is incomplete.",
      ),
    );
  }

  for (const problem of validateTesseraProviderParityModelCapabilityEnvelope(
    options.modelCapabilityEnvelope,
  )) {
    issues.push(
      issue(
        "MODEL_CAPABILITY_ENVELOPE_INVALID",
        `Model-capability envelope is invalid at ${problem.path}: ${problem.message}`,
      ),
    );
  }
  for (const problem of validateTesseraProviderParityCombatSnapshot(
    options.combatSnapshot,
  )) {
    issues.push(
      issue(
        "COMBAT_SNAPSHOT_INVALID",
        `Combat snapshot is invalid at ${problem.path}: ${problem.message}`,
      ),
    );
  }

  const scenarios = report.simulation.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    issues.push(
      issue(
        "REPORT_SCENARIOS_MISSING",
        "The complete report does not retain normalized scenario evidence.",
      ),
    );
  }

  const scenarioContract: TesseraProviderParityScenarioContract[] = [];
  const cells: TesseraProviderParityCell[] = [];
  for (const scenario of scenarios ?? []) {
    if (scenario.status !== "complete" || scenario.warnings.length > 0) {
      issues.push(
        issue(
          "REPORT_SCENARIO_INCOMPLETE",
          `Scenario ${scenario.scenarioId} is partial or retains warnings.`,
          { scenarioId: scenario.scenarioId },
        ),
      );
    }
    if (!Array.isArray(scenario.metrics) || scenario.metrics.length === 0) {
      issues.push(
        issue(
          "REPORT_CONTRACT_INCOMPLETE",
          `Scenario ${scenario.scenarioId} has no requested metrics.`,
          { scenarioId: scenario.scenarioId },
        ),
      );
      continue;
    }
    for (const metric of scenario.metrics) {
      const contract = scenarioContractForMetric(scenario, metric, issues);
      if (!contract) continue;
      scenarioContract.push(contract);
      if (!Array.isArray(scenario.cells) || scenario.cells.length === 0) {
        issues.push(
          issue(
            "REPORT_CELL_INVALID",
            `Scenario ${scenario.scenarioId} has no normalized cells.`,
            { scenarioId: scenario.scenarioId, metric },
          ),
        );
        continue;
      }
      for (const scenarioCell of scenario.cells) {
        const normalized = parityCell(
          scenario,
          contract,
          scenarioCell,
          issues,
        );
        if (normalized) cells.push(normalized);
      }
    }
  }

  const snapshotUnits = new Map(
    options.combatSnapshot.units.map((unit) => [unit.instanceId, unit]),
  );
  const contractsByKey = new Map(
    scenarioContract.map((entry) => [
      `${entry.scenarioId}\u0000${entry.metric}`,
      entry,
    ]),
  );
  for (const cell of cells) {
    const contract = contractsByKey.get(
      `${cell.scenarioId}\u0000${cell.metric}`,
    );
    const expectedAttackerSide =
      contract?.direction === "opponent-to-player" ? "opponent" : "player";
    for (const [instanceId, expectedSide] of [
      [cell.attackerInstanceId, expectedAttackerSide],
      [
        cell.targetInstanceId,
        expectedAttackerSide === "player" ? "opponent" : "player",
      ],
    ] as const) {
      const snapshotUnit = snapshotUnits.get(instanceId);
      if (!snapshotUnit || snapshotUnit.side !== expectedSide) {
        issues.push(
          issue(
            "COMBAT_SNAPSHOT_COVERAGE_INCOMPLETE",
            `Combat snapshot does not retain ${instanceId} on the expected ${expectedSide} side.`,
            {
              scenarioId: cell.scenarioId,
              metric: cell.metric,
              cellKey: instanceId,
            },
          ),
        );
      }
    }
  }

  const contractKeys = scenarioContract.map(
    (entry) => `${entry.scenarioId}\u0000${entry.metric}`,
  );
  const cellKeys = cells.map((entry) =>
    [
      entry.scenarioId,
      entry.metric,
      entry.attackerInstanceId,
      entry.targetInstanceId,
    ].join("\u0000"),
  );
  if (
    new Set(contractKeys).size !== contractKeys.length ||
    new Set(cellKeys).size !== cellKeys.length
  ) {
    issues.push(
      issue(
        "REPORT_CONTRACT_INCOMPLETE",
        "The report contains duplicate scenario contracts or parity cells.",
      ),
    );
  }

  if (issues.length > 0) {
    return { ok: false, run: null, issues };
  }
  const profilePolicyHash =
    options.profilePolicyHash === undefined
      ? report.profilePolicyHash ?? null
      : options.profilePolicyHash;
  return {
    ok: true,
    issues: [],
    run: {
      identity: {
        provider: options.provider,
        providerIdentity: options.providerIdentity,
        dataBundleId: options.dataBundleId,
        normalizedInputSha256: options.normalizedInputSha256,
        scenarioContractSha256:
          tesseraProviderParityContractSha256(scenarioContract),
        profilePolicyHash,
        modelCapabilityEnvelopeSha256:
          tesseraProviderParityModelCapabilityEnvelopeSha256(
            options.modelCapabilityEnvelope,
          ),
        combatSnapshotSha256: tesseraProviderParityCombatSnapshotSha256(
          options.combatSnapshot,
        ),
      },
      modelCapabilityEnvelope: options.modelCapabilityEnvelope,
      combatSnapshot: options.combatSnapshot,
      scenarioContract,
      cells,
      winnerClassifications: [],
    },
  };
}

function sha256(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function reportCompatibilityEnvelope(
  report: TesseraMatchupReport,
  issues: TesseraProviderParityReportAdapterIssue[],
): ProviderCompatibilityEnvelope | null {
  const candidates = report.providerCompatibilityEnvelopes ??
    (report.providerCompatibility ? [report.providerCompatibility] : []);
  if (candidates.length !== 1 || report.opponents.length !== 1) {
    issues.push(
      issue(
        candidates.length === 0
          ? "PROVIDER_COMPATIBILITY_MISSING"
          : "REPORT_SCOPE_INVALID",
        candidates.length === 0
          ? "The exact report has no retained provider-compatibility envelope."
          : "Provider parity requires one exact opponent and exactly one provider-compatibility envelope.",
      ),
    );
    return null;
  }
  const envelope = candidates[0] as ProviderCompatibilityEnvelope;
  const { envelopeSha256, ...withoutDigest } = envelope;
  if (
    !SHA256_PATTERN.test(envelopeSha256) ||
    providerCompatibilityEnvelopeSha256(withoutDigest) !== envelopeSha256
  ) {
    issues.push(
      issue(
        "PROVIDER_COMPATIBILITY_INVALID",
        "The retained provider-compatibility envelope does not match its canonical SHA-256.",
      ),
    );
    return null;
  }
  if (!envelope.complete || envelope.issues.length > 0) {
    issues.push(
      issue(
        "PROVIDER_COMPATIBILITY_INCOMPLETE",
        `The retained provider-compatibility envelope is incomplete: ${
          envelope.issues.map((entry) => entry.code).join(", ") ||
          "complete=false"
        }.`,
      ),
    );
    return null;
  }
  if (
    !SHA256_PATTERN.test(envelope.data.bundleId) ||
    !SHA256_PATTERN.test(envelope.data.semanticIdentitySha256) ||
    !SHA256_PATTERN.test(envelope.data.rosterRulesHash) ||
    !SHA256_PATTERN.test(envelope.data.factionRulesHash) ||
    !SHA256_PATTERN.test(envelope.data.mappingHash) ||
    !SHA256_PATTERN.test(envelope.data.entityHashesSha256) ||
    !SHA256_PATTERN.test(envelope.tessera.providerIdentitySha256) ||
    envelope.tessera.providerIdentitySha256 !==
      sha256(envelope.tessera.providerIdentity)
  ) {
    issues.push(
      issue(
        "PROVIDER_COMPATIBILITY_INVALID",
        "The compatibility envelope lacks a valid bundle-semantic or provider-identity digest.",
      ),
    );
    return null;
  }
  const trustBindingIssues =
    providerCompatibilityTrustBindingIssues(envelope);
  if (trustBindingIssues.length > 0) {
    issues.push(
      issue(
        "PROVIDER_COMPATIBILITY_INVALID",
        `The compatibility envelope's signed-bundle trust binding is invalid: ${trustBindingIssues.join(", ")}.`,
      ),
    );
    return null;
  }
  return envelope;
}

function normalizedRosterScope(
  envelope: ProviderCompatibilityEnvelope,
): Array<{
  side: "player" | "opponent";
  occurrence: number;
  factionId: string | null;
  rosterFingerprint: string | null;
}> {
  return envelope.rosters
    .map((roster) => ({
      side: roster.side,
      occurrence: roster.occurrence,
      factionId: roster.factionId,
      rosterFingerprint: roster.rosterFingerprint,
    }))
    .sort(
      (left, right) =>
        left.side.localeCompare(right.side) ||
        left.occurrence - right.occurrence,
    );
}

function reportRosterScope(report: TesseraMatchupReport) {
  return [
    {
      side: "player" as const,
      occurrence: 1,
      rosterFingerprint: report.player.fingerprint ?? null,
    },
    ...report.opponents.map((opponent, index) => ({
      side: "opponent" as const,
      occurrence: index + 1,
      rosterFingerprint: opponent.fingerprint ?? null,
    })),
  ].sort(
    (left, right) =>
      left.side.localeCompare(right.side) ||
      left.occurrence - right.occurrence,
  );
}

function reportBoundIdentityIssues(
  report: TesseraMatchupReport,
  envelope: ProviderCompatibilityEnvelope,
  rawScenarioContractSha256: string,
): TesseraProviderParityReportAdapterIssue[] {
  const issues: TesseraProviderParityReportAdapterIssue[] = [];
  const provider = report.simulation.selectedBackend;
  if (
    (provider !== "local-engine" && provider !== "website") ||
    envelope.tessera.provider !== provider ||
    !report.simulation.providerIdentity ||
    report.simulation.providerIdentity.provider !== provider ||
    canonicalJson(report.simulation.providerIdentity) !==
      canonicalJson(envelope.tessera.providerIdentity)
  ) {
    issues.push(
      issue(
        "REPORT_BINDING_MISMATCH",
        "The report provider identity is not the identity bound by its compatibility envelope.",
      ),
    );
  }
  if (
    envelope.profilePolicyHash !== (report.profilePolicyHash ?? null) ||
    envelope.scenarioContractSha256 !== rawScenarioContractSha256 ||
    report.pinnedData?.bundleId !== envelope.data.bundleId
  ) {
    issues.push(
      issue(
        "REPORT_BINDING_MISMATCH",
        "The report profile policy or raw frozen scenario contract is not bound by its compatibility envelope.",
      ),
    );
  }
  const envelopeScope = normalizedRosterScope(envelope);
  const reportFingerprints = reportRosterScope(report).map((entry) => ({
    side: entry.side,
    occurrence: entry.occurrence,
    rosterFingerprint: entry.rosterFingerprint,
  }));
  const envelopeFingerprints = envelopeScope.map((entry) => ({
    side: entry.side,
    occurrence: entry.occurrence,
    rosterFingerprint: entry.rosterFingerprint,
  }));
  if (
    envelopeScope.some(
      (entry) =>
        !entry.rosterFingerprint ||
        !SHA256_PATTERN.test(entry.rosterFingerprint),
    ) ||
    canonicalJson(reportFingerprints) !== canonicalJson(envelopeFingerprints)
  ) {
    issues.push(
      issue(
        "REPORT_BINDING_MISMATCH",
        "The canonical roster fingerprints do not match the compatibility envelope.",
      ),
    );
  }
  return issues;
}

/**
 * Strict production adapter for completed exact reports. Provider, bundle,
 * roster, policy, scenario, capability, and combat identities are derived
 * from receipt-bound report fields and verified input/provider evidence. No
 * caller-supplied identity or semantic snapshot is accepted.
 */
export async function adaptReportBoundTesseraMatchupReportToProviderParityRun(
  report: TesseraMatchupReport,
  reportPath: string,
): Promise<TesseraReportBoundProviderParityAdapterResult> {
  const issues: TesseraProviderParityReportAdapterIssue[] = [];
  const normalizedScenario =
    normalizeTesseraReportScenarioContractForParity(report);
  if (!normalizedScenario.ok) {
    issues.push(
      ...normalizedScenario.issues.map((entry) =>
        issue(
          "SCENARIO_NORMALIZATION_FAILED",
          `${entry.code}: ${entry.message}`,
          { scenarioId: entry.scenarioKey },
        )
      ),
    );
  }
  const envelope = reportCompatibilityEnvelope(report, issues);
  if (!normalizedScenario.ok || !envelope) {
    return { ok: false, run: null, bindings: null, issues };
  }
  issues.push(
    ...reportBoundIdentityIssues(
      report,
      envelope,
      normalizedScenario.rawContractSha256,
    ),
  );
  const provider = report.simulation.selectedBackend;
  if (provider !== "local-engine" && provider !== "website") {
    issues.push(
      issue(
        "REPORT_PROVIDER_MISMATCH",
        "The report does not retain one concrete simulation provider.",
      ),
    );
    return { ok: false, run: null, bindings: null, issues };
  }
  const units = [
    ...(report.player.units ?? []),
    ...(report.opponents[0]?.units ?? []),
  ];
  if (units.length === 0) {
    issues.push(
      issue(
        "REPORT_SCOPE_INVALID",
        "The exact report does not retain canonical unit instances for both armies.",
      ),
    );
  }
  const evidenceOptions = {
    rulesEdition: envelope.data.rules.edition,
    rulesPackageVersion: envelope.data.rules.version,
    engineDataSchemaVersion: envelope.data.engineDataSchemaVersion,
    combatModelVersion: TESSERA_PROVIDER_PARITY_COMBAT_MODEL_VERSION,
  };
  const derived = provider === "local-engine"
    ? await deriveTesseraLocalProviderParityEvidence(report, {
        reportPath,
        dataBundleId: envelope.data.bundleId,
        ...evidenceOptions,
      })
    : envelope.tessera.website
      ? deriveTesseraWebsiteProviderParityEvidence(
          envelope.tessera.website,
          { units, ...evidenceOptions },
        )
      : {
          ok: false as const,
          modelCapabilityEnvelope: null,
          combatSnapshot: null,
          issues: [{
            code: "WEBSITE_IMPORT_EVIDENCE_INCOMPLETE" as const,
            path: "providerCompatibility.tessera.website",
            message:
              "The website report has no compatibility-bound semantic evidence.",
          }],
        };
  if (!derived.ok) {
    issues.push(
      ...derived.issues.map((entry) =>
        issue(
          "REPORT_BOUND_EVIDENCE_UNAVAILABLE",
          `${entry.code} at ${entry.path}: ${entry.message}`,
        )
      ),
    );
  }
  if (issues.length > 0 || !derived.ok) {
    return { ok: false, run: null, bindings: null, issues };
  }

  const normalizedInputSha256 = sha256(normalizedRosterScope(envelope));
  const adapted = adaptTesseraMatchupReportToProviderParityRun(
    normalizedScenario.report,
    {
      provider,
      providerIdentity: envelope.tessera.providerIdentitySha256,
      dataBundleId: envelope.data.bundleId,
      normalizedInputSha256,
      profilePolicyHash: report.profilePolicyHash ?? null,
      modelCapabilityEnvelope: derived.modelCapabilityEnvelope,
      combatSnapshot: derived.combatSnapshot,
    },
  );
  if (!adapted.ok) {
    return {
      ok: false,
      run: null,
      bindings: null,
      issues: adapted.issues,
    };
  }
  return {
    ok: true,
    run: adapted.run,
    bindings: {
      reportRunId: report.runId,
      providerCompatibilityEnvelopeSha256: envelope.envelopeSha256,
      rawScenarioContractSha256:
        normalizedScenario.rawContractSha256,
      normalizedScenarioContractSha256:
        normalizedScenario.normalizedContractSha256,
      normalizedInputSha256,
    },
    issues: [],
  };
}
