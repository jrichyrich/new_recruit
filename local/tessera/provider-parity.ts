import crypto from "node:crypto";

import type {
  TesseraDirection,
  TesseraMetric,
  TesseraPhase,
} from "../../lib/rosterpilot/types";

export const TESSERA_PROVIDER_PARITY_POLICY = {
  minimumMetricPassRate: 0.98,
  maximumToleranceMultiple: 2,
  probability: {
    absoluteFloor: 0.02,
    monteCarloMultiplier: 4,
    roundingAllowance: 0.005,
  },
  meanKills: {
    absoluteFloor: 0.1,
    relativeRate: 0.02,
    monteCarloMultiplier: 4,
    roundingAllowance: 0.05,
  },
  meanDamage: {
    absoluteFloor: 0.25,
    relativeRate: 0.02,
    monteCarloMultiplier: 4,
    roundingAllowance: 0.05,
  },
} as const;

export type TesseraParityProvider = "local-engine" | "website";

export type TesseraProviderParityIdentity = {
  provider: TesseraParityProvider;
  /**
   * The local commit/tree identity or the observed website UI identity.
   * Different providers are expected to have different provider identities.
   */
  providerIdentity: string;
  dataBundleId: string;
  normalizedInputSha256: string;
  scenarioContractSha256: string;
  profilePolicyHash: string | null;
};

export type TesseraProviderParityScenarioContract = {
  scenarioId: string;
  phase: TesseraPhase;
  direction: TesseraDirection;
  metric: TesseraMetric;
  settings: Record<string, string>;
  iterations: number;
};

export type TesseraProviderParityCell = {
  scenarioId: string;
  attackerInstanceId: string;
  targetInstanceId: string;
  metric: TesseraMetric;
  value: number | null;
  iterations: number;
  /**
   * Required for mean metrics. It is the standard error of that provider's
   * estimated mean, not the sample standard deviation.
   */
  standardError?: number | null;
};

export type TesseraProviderParityWinner = "player" | "opponent" | "tie";

export type TesseraProviderParityWinnerClassification = {
  classificationId: string;
  winner: TesseraProviderParityWinner;
  /** A winner mismatch is diagnostic while either result is on its boundary. */
  withinUncertainty: boolean;
};

export type TesseraProviderParityRun = {
  identity: TesseraProviderParityIdentity;
  scenarioContract: TesseraProviderParityScenarioContract[];
  cells: TesseraProviderParityCell[];
  winnerClassifications: TesseraProviderParityWinnerClassification[];
};

export type TesseraProviderParityIssueCategory =
  | "eligibility"
  | "incomplete"
  | "policy";

export type TesseraProviderParityIssueCode =
  | "PROVIDER_PAIR_INVALID"
  | "PROVIDER_IDENTITY_INCOMPLETE"
  | "DATA_BUNDLE_MISMATCH"
  | "NORMALIZED_INPUT_MISMATCH"
  | "PROFILE_POLICY_MISMATCH"
  | "CONTRACT_INCOMPLETE"
  | "CONTRACT_DUPLICATE"
  | "CONTRACT_DIGEST_INVALID"
  | "CONTRACT_MISMATCH"
  | "CONTRACT_WITHOUT_CELLS"
  | "CELL_DUPLICATE"
  | "CELL_OUTSIDE_CONTRACT"
  | "CELL_ITERATIONS_MISMATCH"
  | "CELL_MISSING"
  | "CELL_VALUE_INVALID"
  | "CELL_STANDARD_ERROR_MISSING"
  | "WINNER_CLASSIFICATION_DUPLICATE"
  | "WINNER_CLASSIFICATION_MISSING"
  | "WINNER_CLASSIFICATION_INVALID"
  | "WINNER_CLASSIFICATION_MISMATCH"
  | "METRIC_COVERAGE_BELOW_THRESHOLD"
  | "CELL_BEYOND_DOUBLE_TOLERANCE";

export type TesseraProviderParityIssue = {
  category: TesseraProviderParityIssueCategory;
  code: TesseraProviderParityIssueCode;
  key: string | null;
  provider: TesseraParityProvider | null;
  metric: TesseraMetric | null;
  message: string;
};

export type TesseraProviderParityTolerance = {
  value: number;
  absoluteFloor: number;
  relativeComponent: number;
  monteCarloComponent: number;
  pooledStandardError: number;
};

export type TesseraProviderParityCellComparison = {
  key: string;
  scenarioId: string;
  attackerInstanceId: string;
  targetInstanceId: string;
  metric: TesseraMetric;
  localValue: number | null;
  websiteValue: number | null;
  difference: number | null;
  tolerance: TesseraProviderParityTolerance | null;
  toleranceMultiple: number | null;
  status: "pass" | "fail" | "incomplete";
};

export type TesseraProviderParityMetricSummary = {
  metric: TesseraMetric;
  expectedCellCount: number;
  comparedCellCount: number;
  withinToleranceCount: number;
  withinToleranceRate: number;
  beyondDoubleToleranceCount: number;
  status: "pass" | "fail" | "incomplete";
};

export type TesseraProviderParityWinnerComparison = {
  classificationId: string;
  localWinner: TesseraProviderParityWinner | null;
  websiteWinner: TesseraProviderParityWinner | null;
  uncertaintyBoundary: boolean;
  status: "pass" | "fail" | "incomplete";
};

export type TesseraProviderParityResult = {
  schemaVersion: 1;
  kind: "tessera-provider-parity";
  outcome: "pass" | "fail" | "incomplete" | "ineligible";
  eligible: boolean;
  complete: boolean;
  localIdentity: TesseraProviderParityIdentity | null;
  websiteIdentity: TesseraProviderParityIdentity | null;
  policy: typeof TESSERA_PROVIDER_PARITY_POLICY;
  metricSummaries: TesseraProviderParityMetricSummary[];
  cells: TesseraProviderParityCellComparison[];
  winnerClassifications: TesseraProviderParityWinnerComparison[];
  issues: TesseraProviderParityIssue[];
};

const METRICS: TesseraMetric[] = [
  "wipe-probability",
  "half-wipe-probability",
  "mean-kills",
  "mean-damage",
];

const METRIC_ORDER = new Map<TesseraMetric, number>(
  METRICS.map((metric, index) => [metric, index]),
);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isMetric(value: unknown): value is TesseraMetric {
  return typeof value === "string" && METRICS.includes(value as TesseraMetric);
}

function isProbabilityMetric(metric: TesseraMetric): boolean {
  return (
    metric === "wipe-probability" ||
    metric === "half-wipe-probability"
  );
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function canonicalSettings(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(settings).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function contractKey(
  contract: Pick<TesseraProviderParityScenarioContract, "scenarioId" | "metric">,
): string {
  return `${contract.scenarioId}\u0000${contract.metric}`;
}

function displayContractKey(
  contract: Pick<TesseraProviderParityScenarioContract, "scenarioId" | "metric">,
): string {
  return `${contract.scenarioId}|${contract.metric}`;
}

function cellKey(
  cell: Pick<
    TesseraProviderParityCell,
    "scenarioId" | "metric" | "attackerInstanceId" | "targetInstanceId"
  >,
): string {
  return [
    cell.scenarioId,
    cell.metric,
    cell.attackerInstanceId,
    cell.targetInstanceId,
  ].join("\u0000");
}

function displayCellKey(
  cell: Pick<
    TesseraProviderParityCell,
    "scenarioId" | "metric" | "attackerInstanceId" | "targetInstanceId"
  >,
): string {
  return [
    cell.scenarioId,
    cell.metric,
    cell.attackerInstanceId,
    cell.targetInstanceId,
  ].join("|");
}

function canonicalContract(
  contract: readonly TesseraProviderParityScenarioContract[],
): Array<Record<string, unknown>> {
  return contract
    .map((entry) => ({
      scenarioId: entry.scenarioId,
      phase: entry.phase,
      direction: entry.direction,
      metric: entry.metric,
      settings: canonicalSettings(entry.settings),
      iterations: entry.iterations,
    }))
    .sort((left, right) => {
      const leftKey = `${String(left.scenarioId)}\u0000${String(left.metric)}`;
      const rightKey = `${String(right.scenarioId)}\u0000${String(right.metric)}`;
      return leftKey.localeCompare(rightKey);
    });
}

export function tesseraProviderParityContractSha256(
  contract: readonly TesseraProviderParityScenarioContract[],
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalContract(contract)))
    .digest("hex");
}

export function tesseraProviderParityTolerance(
  metric: TesseraMetric,
  localValue: number,
  websiteValue: number,
  localIterations: number,
  websiteIterations: number,
  localStandardError?: number | null,
  websiteStandardError?: number | null,
): TesseraProviderParityTolerance | null {
  if (
    !Number.isFinite(localValue) ||
    !Number.isFinite(websiteValue) ||
    !isPositiveInteger(localIterations) ||
    !isPositiveInteger(websiteIterations)
  ) {
    return null;
  }

  if (isProbabilityMetric(metric)) {
    if (
      localValue < 0 ||
      localValue > 1 ||
      websiteValue < 0 ||
      websiteValue > 1
    ) {
      return null;
    }
    const pooledProbability =
      (localValue * localIterations + websiteValue * websiteIterations) /
      (localIterations + websiteIterations);
    const pooledStandardError = Math.sqrt(
      pooledProbability *
        (1 - pooledProbability) *
        (1 / localIterations + 1 / websiteIterations),
    );
    const monteCarloComponent =
      TESSERA_PROVIDER_PARITY_POLICY.probability.monteCarloMultiplier *
        pooledStandardError +
      TESSERA_PROVIDER_PARITY_POLICY.probability.roundingAllowance;
    return {
      value: Math.max(
        TESSERA_PROVIDER_PARITY_POLICY.probability.absoluteFloor,
        monteCarloComponent,
      ),
      absoluteFloor: TESSERA_PROVIDER_PARITY_POLICY.probability.absoluteFloor,
      relativeComponent: 0,
      monteCarloComponent,
      pooledStandardError,
    };
  }

  if (
    !isFiniteNonNegative(localStandardError) ||
    !isFiniteNonNegative(websiteStandardError)
  ) {
    return null;
  }

  const policy =
    metric === "mean-kills"
      ? TESSERA_PROVIDER_PARITY_POLICY.meanKills
      : TESSERA_PROVIDER_PARITY_POLICY.meanDamage;
  const pooledStandardError = Math.sqrt(
    localStandardError ** 2 + websiteStandardError ** 2,
  );
  const relativeComponent =
    policy.relativeRate * Math.max(Math.abs(localValue), Math.abs(websiteValue));
  const monteCarloComponent =
    policy.monteCarloMultiplier * pooledStandardError +
    policy.roundingAllowance;
  return {
    value: Math.max(
      policy.absoluteFloor,
      relativeComponent,
      monteCarloComponent,
    ),
    absoluteFloor: policy.absoluteFloor,
    relativeComponent,
    monteCarloComponent,
    pooledStandardError,
  };
}

function issue(
  category: TesseraProviderParityIssueCategory,
  code: TesseraProviderParityIssueCode,
  message: string,
  options: {
    key?: string | null;
    provider?: TesseraParityProvider | null;
    metric?: TesseraMetric | null;
  } = {},
): TesseraProviderParityIssue {
  return {
    category,
    code,
    key: options.key ?? null,
    provider: options.provider ?? null,
    metric: options.metric ?? null,
    message,
  };
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function approximatelyLessThanOrEqual(left: number, right: number): boolean {
  const allowance =
    Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right));
  return left <= right + allowance;
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

function validateIdentity(
  identity: TesseraProviderParityIdentity,
  issues: TesseraProviderParityIssue[],
): void {
  if (
    identity.providerIdentity.trim().length === 0 ||
    identity.dataBundleId.trim().length === 0 ||
    !SHA256_PATTERN.test(identity.normalizedInputSha256) ||
    !SHA256_PATTERN.test(identity.scenarioContractSha256) ||
    (identity.profilePolicyHash !== null &&
      identity.profilePolicyHash.trim().length === 0)
  ) {
    issues.push(
      issue(
        "eligibility",
        "PROVIDER_IDENTITY_INCOMPLETE",
        `${identity.provider} did not provide a complete immutable provider, data, input, contract, and profile-policy identity.`,
        { provider: identity.provider },
      ),
    );
  }
}

function validateContract(
  run: TesseraProviderParityRun,
  issues: TesseraProviderParityIssue[],
): Map<string, TesseraProviderParityScenarioContract> {
  const result = new Map<string, TesseraProviderParityScenarioContract>();
  if (!Array.isArray(run.scenarioContract) || run.scenarioContract.length === 0) {
    issues.push(
      issue(
        "eligibility",
        "CONTRACT_INCOMPLETE",
        `${run.identity.provider} supplied no frozen scenario contract.`,
        { provider: run.identity.provider },
      ),
    );
    return result;
  }

  for (const entry of run.scenarioContract) {
    const metric = isMetric(entry.metric) ? entry.metric : null;
    const valid =
      typeof entry.scenarioId === "string" &&
      entry.scenarioId.trim().length > 0 &&
      (entry.phase === "shooting" || entry.phase === "fight") &&
      (entry.direction === "player-to-opponent" ||
        entry.direction === "opponent-to-player") &&
      metric !== null &&
      validSettings(entry.settings) &&
      isPositiveInteger(entry.iterations);
    const key = metric
      ? displayContractKey({ scenarioId: entry.scenarioId, metric })
      : entry.scenarioId;
    if (!valid) {
      issues.push(
        issue(
          "eligibility",
          "CONTRACT_INCOMPLETE",
          `${run.identity.provider} has an incomplete frozen scenario contract entry for ${key}.`,
          {
            key,
            provider: run.identity.provider,
            metric,
          },
        ),
      );
      continue;
    }
    const normalized = entry as TesseraProviderParityScenarioContract;
    const internalKey = contractKey(normalized);
    if (result.has(internalKey)) {
      issues.push(
        issue(
          "eligibility",
          "CONTRACT_DUPLICATE",
          `${run.identity.provider} repeated frozen scenario contract ${displayContractKey(normalized)}.`,
          {
            key: displayContractKey(normalized),
            provider: run.identity.provider,
            metric: normalized.metric,
          },
        ),
      );
      continue;
    }
    result.set(internalKey, normalized);
  }

  if (result.size === run.scenarioContract.length) {
    const observedDigest = tesseraProviderParityContractSha256(
      run.scenarioContract,
    );
    if (run.identity.scenarioContractSha256 !== observedDigest) {
      issues.push(
        issue(
          "eligibility",
          "CONTRACT_DIGEST_INVALID",
          `${run.identity.provider} scenario contract does not match its recorded SHA-256.`,
          { provider: run.identity.provider },
        ),
      );
    }
  }
  return result;
}

type ValidatedCells = {
  byKey: Map<string, TesseraProviderParityCell>;
  invalidKeys: Set<string>;
  coveredContracts: Set<string>;
};

function validateCells(
  run: TesseraProviderParityRun,
  contract: Map<string, TesseraProviderParityScenarioContract>,
  issues: TesseraProviderParityIssue[],
): ValidatedCells {
  const byKey = new Map<string, TesseraProviderParityCell>();
  const invalidKeys = new Set<string>();
  const coveredContracts = new Set<string>();
  if (!Array.isArray(run.cells)) {
    issues.push(
      issue(
        "incomplete",
        "CELL_VALUE_INVALID",
        `${run.identity.provider} did not return a parity cell collection.`,
        { provider: run.identity.provider },
      ),
    );
    return { byKey, invalidKeys, coveredContracts };
  }
  for (const cell of run.cells) {
    const metric = isMetric(cell.metric) ? cell.metric : null;
    const internalKey = metric ? cellKey({ ...cell, metric }) : "";
    const displayKey = metric ? displayCellKey({ ...cell, metric }) : cell.scenarioId;
    if (
      metric === null ||
      typeof cell.scenarioId !== "string" ||
      cell.scenarioId.trim().length === 0 ||
      typeof cell.attackerInstanceId !== "string" ||
      cell.attackerInstanceId.trim().length === 0 ||
      typeof cell.targetInstanceId !== "string" ||
      cell.targetInstanceId.trim().length === 0
    ) {
      issues.push(
        issue(
          "incomplete",
          "CELL_VALUE_INVALID",
          `${run.identity.provider} supplied a cell without a complete stable key.`,
          { key: displayKey, provider: run.identity.provider, metric },
        ),
      );
      if (internalKey) invalidKeys.add(internalKey);
      continue;
    }
    if (byKey.has(internalKey)) {
      invalidKeys.add(internalKey);
      issues.push(
        issue(
          "incomplete",
          "CELL_DUPLICATE",
          `${run.identity.provider} repeated parity cell ${displayKey}.`,
          { key: displayKey, provider: run.identity.provider, metric },
        ),
      );
      continue;
    }
    byKey.set(internalKey, cell);

    const expected = contract.get(contractKey(cell));
    if (!expected) {
      invalidKeys.add(internalKey);
      issues.push(
        issue(
          "incomplete",
          "CELL_OUTSIDE_CONTRACT",
          `${run.identity.provider} returned parity cell ${displayKey} outside the frozen scenario contract.`,
          { key: displayKey, provider: run.identity.provider, metric },
        ),
      );
      continue;
    }
    coveredContracts.add(contractKey(expected));
    if (cell.iterations !== expected.iterations) {
      invalidKeys.add(internalKey);
      issues.push(
        issue(
          "incomplete",
          "CELL_ITERATIONS_MISMATCH",
          `${run.identity.provider} returned ${cell.iterations} iterations for ${displayKey}; the frozen contract requires ${expected.iterations}.`,
          { key: displayKey, provider: run.identity.provider, metric },
        ),
      );
    }
    if (
      typeof cell.value !== "number" ||
      !Number.isFinite(cell.value) ||
      (isProbabilityMetric(metric) && (cell.value < 0 || cell.value > 1))
    ) {
      invalidKeys.add(internalKey);
      issues.push(
        issue(
          "incomplete",
          "CELL_VALUE_INVALID",
          `${run.identity.provider} returned an invalid ${metric} value for ${displayKey}.`,
          { key: displayKey, provider: run.identity.provider, metric },
        ),
      );
    }
    if (
      !isProbabilityMetric(metric) &&
      !isFiniteNonNegative(cell.standardError)
    ) {
      invalidKeys.add(internalKey);
      issues.push(
        issue(
          "incomplete",
          "CELL_STANDARD_ERROR_MISSING",
          `${run.identity.provider} did not provide a finite non-negative standard error for ${displayKey}.`,
          { key: displayKey, provider: run.identity.provider, metric },
        ),
      );
    }
  }

  for (const [key, entry] of contract) {
    if (!coveredContracts.has(key)) {
      issues.push(
        issue(
          "incomplete",
          "CONTRACT_WITHOUT_CELLS",
          `${run.identity.provider} returned no cells for frozen scenario ${displayContractKey(entry)}.`,
          {
            key: displayContractKey(entry),
            provider: run.identity.provider,
            metric: entry.metric,
          },
        ),
      );
    }
  }
  return { byKey, invalidKeys, coveredContracts };
}

function validateWinnerClassifications(
  run: TesseraProviderParityRun,
  issues: TesseraProviderParityIssue[],
): Map<string, TesseraProviderParityWinnerClassification> {
  const result = new Map<string, TesseraProviderParityWinnerClassification>();
  if (!Array.isArray(run.winnerClassifications)) {
    issues.push(
      issue(
        "incomplete",
        "WINNER_CLASSIFICATION_INVALID",
        `${run.identity.provider} did not return a winner-classification collection.`,
        { provider: run.identity.provider },
      ),
    );
    return result;
  }
  for (const classification of run.winnerClassifications) {
    const valid =
      typeof classification.classificationId === "string" &&
      classification.classificationId.trim().length > 0 &&
      (classification.winner === "player" ||
        classification.winner === "opponent" ||
        classification.winner === "tie") &&
      typeof classification.withinUncertainty === "boolean";
    if (!valid) {
      issues.push(
        issue(
          "incomplete",
          "WINNER_CLASSIFICATION_INVALID",
          `${run.identity.provider} supplied an invalid winner classification.`,
          {
            key: classification.classificationId || null,
            provider: run.identity.provider,
          },
        ),
      );
      continue;
    }
    if (result.has(classification.classificationId)) {
      issues.push(
        issue(
          "incomplete",
          "WINNER_CLASSIFICATION_DUPLICATE",
          `${run.identity.provider} repeated winner classification ${classification.classificationId}.`,
          {
            key: classification.classificationId,
            provider: run.identity.provider,
          },
        ),
      );
      continue;
    }
    result.set(classification.classificationId, classification);
  }
  return result;
}

function sortIssues(issues: TesseraProviderParityIssue[]): void {
  issues.sort((left, right) =>
    [
      left.category,
      left.code,
      left.metric ?? "",
      left.key ?? "",
      left.provider ?? "",
      left.message,
    ]
      .join("\u0000")
      .localeCompare(
        [
          right.category,
          right.code,
          right.metric ?? "",
          right.key ?? "",
          right.provider ?? "",
          right.message,
        ].join("\u0000"),
      ),
  );
}

function emptyResult(
  issues: TesseraProviderParityIssue[],
  localIdentity: TesseraProviderParityIdentity | null,
  websiteIdentity: TesseraProviderParityIdentity | null,
): TesseraProviderParityResult {
  sortIssues(issues);
  return {
    schemaVersion: 1,
    kind: "tessera-provider-parity",
    outcome: "ineligible",
    eligible: false,
    complete: false,
    localIdentity,
    websiteIdentity,
    policy: TESSERA_PROVIDER_PARITY_POLICY,
    metricSummaries: [],
    cells: [],
    winnerClassifications: [],
    issues,
  };
}

export function compareTesseraProviderParity(
  first: TesseraProviderParityRun,
  second: TesseraProviderParityRun,
): TesseraProviderParityResult {
  const issues: TesseraProviderParityIssue[] = [];
  const byProvider = new Map<TesseraParityProvider, TesseraProviderParityRun>();
  byProvider.set(first.identity.provider, first);
  if (byProvider.has(second.identity.provider)) {
    issues.push(
      issue(
        "eligibility",
        "PROVIDER_PAIR_INVALID",
        "Provider parity requires exactly one local-engine run and one website run.",
      ),
    );
    return emptyResult(
      issues,
      first.identity.provider === "local-engine" ? first.identity : null,
      first.identity.provider === "website" ? first.identity : null,
    );
  }
  byProvider.set(second.identity.provider, second);
  const local = byProvider.get("local-engine");
  const website = byProvider.get("website");
  if (!local || !website) {
    issues.push(
      issue(
        "eligibility",
        "PROVIDER_PAIR_INVALID",
        "Provider parity requires exactly one local-engine run and one website run.",
      ),
    );
    return emptyResult(issues, local?.identity ?? null, website?.identity ?? null);
  }

  validateIdentity(local.identity, issues);
  validateIdentity(website.identity, issues);
  if (local.identity.dataBundleId !== website.identity.dataBundleId) {
    issues.push(
      issue(
        "eligibility",
        "DATA_BUNDLE_MISMATCH",
        "Local and website parity runs do not use the same immutable data bundle.",
      ),
    );
  }
  if (
    local.identity.normalizedInputSha256 !==
    website.identity.normalizedInputSha256
  ) {
    issues.push(
      issue(
        "eligibility",
        "NORMALIZED_INPUT_MISMATCH",
        "Local and website parity runs do not use the same normalized roster input.",
      ),
    );
  }
  if (local.identity.profilePolicyHash !== website.identity.profilePolicyHash) {
    issues.push(
      issue(
        "eligibility",
        "PROFILE_POLICY_MISMATCH",
        "Local and website parity runs do not use the same profile policy.",
      ),
    );
  }

  const localContract = validateContract(local, issues);
  const websiteContract = validateContract(website, issues);
  const localContractComplete =
    local.scenarioContract.length > 0 &&
    localContract.size === local.scenarioContract.length;
  const websiteContractComplete =
    website.scenarioContract.length > 0 &&
    websiteContract.size === website.scenarioContract.length;
  if (
    local.identity.scenarioContractSha256 !==
      website.identity.scenarioContractSha256 ||
    (localContractComplete &&
      websiteContractComplete &&
      JSON.stringify(canonicalContract(local.scenarioContract)) !==
        JSON.stringify(canonicalContract(website.scenarioContract)))
  ) {
    issues.push(
      issue(
        "eligibility",
        "CONTRACT_MISMATCH",
        "Local and website parity runs do not use the same complete frozen scenario contract.",
      ),
    );
  }

  const localCells = validateCells(local, localContract, issues);
  const websiteCells = validateCells(website, websiteContract, issues);
  const allCellKeys = Array.from(
    new Set([...localCells.byKey.keys(), ...websiteCells.byKey.keys()]),
  ).sort();
  const cellComparisons: TesseraProviderParityCellComparison[] = [];

  for (const key of allCellKeys) {
    const localCell = localCells.byKey.get(key);
    const websiteCell = websiteCells.byKey.get(key);
    const exemplar = localCell ?? websiteCell;
    if (!exemplar) continue;
    const displayKey = displayCellKey(exemplar);
    if (!localCell || !websiteCell) {
      const missingProvider: TesseraParityProvider = localCell
        ? "website"
        : "local-engine";
      issues.push(
        issue(
          "incomplete",
          "CELL_MISSING",
          `${missingProvider} did not return parity cell ${displayKey}.`,
          {
            key: displayKey,
            provider: missingProvider,
            metric: exemplar.metric,
          },
        ),
      );
      cellComparisons.push({
        key: displayKey,
        scenarioId: exemplar.scenarioId,
        attackerInstanceId: exemplar.attackerInstanceId,
        targetInstanceId: exemplar.targetInstanceId,
        metric: exemplar.metric,
        localValue: localCell?.value ?? null,
        websiteValue: websiteCell?.value ?? null,
        difference: null,
        tolerance: null,
        toleranceMultiple: null,
        status: "incomplete",
      });
      continue;
    }

    const invalid =
      localCells.invalidKeys.has(key) || websiteCells.invalidKeys.has(key);
    const tolerance = invalid
      ? null
      : tesseraProviderParityTolerance(
          localCell.metric,
          localCell.value as number,
          websiteCell.value as number,
          localCell.iterations,
          websiteCell.iterations,
          localCell.standardError,
          websiteCell.standardError,
        );
    if (!tolerance) {
      cellComparisons.push({
        key: displayKey,
        scenarioId: exemplar.scenarioId,
        attackerInstanceId: exemplar.attackerInstanceId,
        targetInstanceId: exemplar.targetInstanceId,
        metric: exemplar.metric,
        localValue: localCell.value,
        websiteValue: websiteCell.value,
        difference: null,
        tolerance: null,
        toleranceMultiple: null,
        status: "incomplete",
      });
      continue;
    }

    const difference = Math.abs(
      compareNumbers(localCell.value as number, websiteCell.value as number),
    );
    const withinTolerance = approximatelyLessThanOrEqual(
      difference,
      tolerance.value,
    );
    const beyondDouble = !approximatelyLessThanOrEqual(
      difference,
      tolerance.value * TESSERA_PROVIDER_PARITY_POLICY.maximumToleranceMultiple,
    );
    if (beyondDouble) {
      issues.push(
        issue(
          "policy",
          "CELL_BEYOND_DOUBLE_TOLERANCE",
          `${displayKey} differs by more than twice its parity tolerance.`,
          { key: displayKey, metric: exemplar.metric },
        ),
      );
    }
    cellComparisons.push({
      key: displayKey,
      scenarioId: exemplar.scenarioId,
      attackerInstanceId: exemplar.attackerInstanceId,
      targetInstanceId: exemplar.targetInstanceId,
      metric: exemplar.metric,
      localValue: localCell.value,
      websiteValue: websiteCell.value,
      difference,
      tolerance,
      toleranceMultiple:
        tolerance.value === 0
          ? difference === 0
            ? 0
            : Number.POSITIVE_INFINITY
          : difference / tolerance.value,
      status: withinTolerance ? "pass" : "fail",
    });
  }

  const metricSummaries: TesseraProviderParityMetricSummary[] = [];
  for (const metric of METRICS) {
    const cells = cellComparisons.filter((cell) => cell.metric === metric);
    if (cells.length === 0) continue;
    const compared = cells.filter((cell) => cell.status !== "incomplete");
    const withinToleranceCount = compared.filter(
      (cell) => cell.status === "pass",
    ).length;
    const beyondDoubleToleranceCount = compared.filter(
      (cell) =>
        cell.difference !== null &&
        cell.tolerance !== null &&
        !approximatelyLessThanOrEqual(
          cell.difference,
          cell.tolerance.value *
            TESSERA_PROVIDER_PARITY_POLICY.maximumToleranceMultiple,
        ),
    ).length;
    const complete = compared.length === cells.length;
    const withinToleranceRate = cells.length
      ? withinToleranceCount / cells.length
      : 0;
    let status: TesseraProviderParityMetricSummary["status"] = "pass";
    if (!complete) {
      status = "incomplete";
    } else if (
      !approximatelyLessThanOrEqual(
        TESSERA_PROVIDER_PARITY_POLICY.minimumMetricPassRate,
        withinToleranceRate,
      ) ||
      beyondDoubleToleranceCount > 0
    ) {
      status = "fail";
    }
    if (
      complete &&
      !approximatelyLessThanOrEqual(
        TESSERA_PROVIDER_PARITY_POLICY.minimumMetricPassRate,
        withinToleranceRate,
      )
    ) {
      issues.push(
        issue(
          "policy",
          "METRIC_COVERAGE_BELOW_THRESHOLD",
          `${metric} has ${(withinToleranceRate * 100).toFixed(2)}% of cells within tolerance; parity requires at least 98%.`,
          { metric },
        ),
      );
    }
    metricSummaries.push({
      metric,
      expectedCellCount: cells.length,
      comparedCellCount: compared.length,
      withinToleranceCount,
      withinToleranceRate,
      beyondDoubleToleranceCount,
      status,
    });
  }
  metricSummaries.sort(
    (left, right) =>
      (METRIC_ORDER.get(left.metric) ?? 0) -
      (METRIC_ORDER.get(right.metric) ?? 0),
  );

  const localWinners = validateWinnerClassifications(local, issues);
  const websiteWinners = validateWinnerClassifications(website, issues);
  const winnerIds = Array.from(
    new Set([...localWinners.keys(), ...websiteWinners.keys()]),
  ).sort();
  const winnerClassifications: TesseraProviderParityWinnerComparison[] = [];
  for (const classificationId of winnerIds) {
    const localWinner = localWinners.get(classificationId);
    const websiteWinner = websiteWinners.get(classificationId);
    if (!localWinner || !websiteWinner) {
      const missingProvider: TesseraParityProvider = localWinner
        ? "website"
        : "local-engine";
      issues.push(
        issue(
          "incomplete",
          "WINNER_CLASSIFICATION_MISSING",
          `${missingProvider} did not return winner classification ${classificationId}.`,
          { key: classificationId, provider: missingProvider },
        ),
      );
      winnerClassifications.push({
        classificationId,
        localWinner: localWinner?.winner ?? null,
        websiteWinner: websiteWinner?.winner ?? null,
        uncertaintyBoundary:
          localWinner?.withinUncertainty === true ||
          websiteWinner?.withinUncertainty === true,
        status: "incomplete",
      });
      continue;
    }
    const uncertaintyBoundary =
      localWinner.withinUncertainty || websiteWinner.withinUncertainty;
    const matched =
      localWinner.winner === websiteWinner.winner || uncertaintyBoundary;
    if (!matched) {
      issues.push(
        issue(
          "policy",
          "WINNER_CLASSIFICATION_MISMATCH",
          `Local and website winner classifications disagree for ${classificationId} outside their uncertainty boundaries.`,
          { key: classificationId },
        ),
      );
    }
    winnerClassifications.push({
      classificationId,
      localWinner: localWinner.winner,
      websiteWinner: websiteWinner.winner,
      uncertaintyBoundary,
      status: matched ? "pass" : "fail",
    });
  }

  sortIssues(issues);
  const eligible = !issues.some((entry) => entry.category === "eligibility");
  const complete =
    eligible && !issues.some((entry) => entry.category === "incomplete");
  const policyPassed = !issues.some((entry) => entry.category === "policy");
  const outcome: TesseraProviderParityResult["outcome"] = !eligible
    ? "ineligible"
    : !complete
      ? "incomplete"
      : policyPassed
        ? "pass"
        : "fail";
  return {
    schemaVersion: 1,
    kind: "tessera-provider-parity",
    outcome,
    eligible,
    complete,
    localIdentity: local.identity,
    websiteIdentity: website.identity,
    policy: TESSERA_PROVIDER_PARITY_POLICY,
    metricSummaries,
    cells: cellComparisons,
    winnerClassifications,
    issues,
  };
}
