import type {
  TesseraFrozenScenarioContract,
  TesseraMatchupReport,
  TesseraPhase,
  TesseraSimulationProvider,
} from "../../lib/rosterpilot";
import {
  canonicalTesseraScenarioContract,
  TesseraScenarioContractError,
  tesseraScenarioContractSha256,
} from "./scenario-contract";

export const TESSERA_PROVIDER_NEUTRAL_SCENARIO_SETTINGS_VERSION =
  "provider-neutral-settings-v1" as const;

export type TesseraProviderNeutralScenarioIssue = {
  code:
    | "FROZEN_CONTRACT_MISSING"
    | "FROZEN_CONTRACT_DIGEST_INVALID"
    | "FROZEN_CONTRACT_SCOPE_MISMATCH"
    | "OBSERVED_CONTRACT_INCOMPLETE"
    | "PROVIDER_SETTING_MAPPING_MISSING"
    | "PROVIDER_SETTING_VALUE_INVALID"
    | "PROVIDER_SETTING_MISMATCH";
  message: string;
  scenarioKey: string | null;
  setting: string | null;
};

export type TesseraProviderNeutralScenarioResult =
  | {
      ok: true;
      report: TesseraMatchupReport;
      contract: TesseraFrozenScenarioContract[];
      rawContractSha256: string;
      normalizedContractSha256: string;
      issues: [];
    }
  | {
      ok: false;
      report: null;
      contract: null;
      rawContractSha256: string | null;
      normalizedContractSha256: null;
      issues: TesseraProviderNeutralScenarioIssue[];
    };

type CanonicalBooleanSetting =
  | "targetInCover"
  | "charging"
  | "withinRapidFireRange"
  | "withinMeltaRange"
  | "remainedStationary"
  | "indirectFire";

const SETTING_ALIASES = new Map<string, CanonicalBooleanSetting>([
  ["targetincover", "targetInCover"],
  ["targetcover", "targetInCover"],
  ["cover", "targetInCover"],
  ["charging", "charging"],
  ["charge", "charging"],
  ["attackercharging", "charging"],
  ["withinrapidfirerange", "withinRapidFireRange"],
  ["rapidfirerange", "withinRapidFireRange"],
  ["halfrange", "withinRapidFireRange"],
  ["withinmeltarange", "withinMeltaRange"],
  ["meltarange", "withinMeltaRange"],
  ["remainedstationary", "remainedStationary"],
  ["stationary", "remainedStationary"],
  ["indirectfire", "indirectFire"],
  ["indirect", "indirectFire"],
]);

const PROVIDER_METADATA_KEYS = new Set([
  "provider",
  "phase",
  "metric",
  "direction",
  "iterations",
  "iteration",
  "simulations",
  "simulation",
  "trials",
  "runs",
]);

function normalizedKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

function scenarioKey(
  entry: Pick<
    TesseraFrozenScenarioContract,
    "phase" | "direction" | "metric"
  >,
): string {
  return `${entry.phase}:${entry.direction}:${entry.metric}`;
}

function defaultsForPhase(
  phase: TesseraPhase,
): Record<CanonicalBooleanSetting, string> {
  return {
    targetInCover: "false",
    charging: phase === "fight" ? "true" : "false",
    withinRapidFireRange: "false",
    withinMeltaRange: "false",
    remainedStationary: "false",
    indirectFire: "false",
  };
}

function booleanValue(value: string): "true" | "false" | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (["true", "yes", "on", "1", "enabled"].includes(normalized)) {
    return "true";
  }
  if (["false", "no", "off", "0", "disabled", "none"].includes(normalized)) {
    return "false";
  }
  return null;
}

function normalizeSettings(input: {
  settings: Record<string, string>;
  phase: TesseraPhase;
  scenarioKey: string;
  source: "frozen" | "observed";
  issues: TesseraProviderNeutralScenarioIssue[];
}): Record<string, string> | null {
  const normalized = defaultsForPhase(input.phase);
  const seen = new Map<CanonicalBooleanSetting, string>();
  for (const [rawKey, rawValue] of Object.entries(input.settings)) {
    const key = normalizedKey(rawKey);
    if (PROVIDER_METADATA_KEYS.has(key)) continue;
    const canonical = SETTING_ALIASES.get(key);
    if (!canonical) {
      input.issues.push({
        code: "PROVIDER_SETTING_MAPPING_MISSING",
        message:
          `${input.source} setting ${JSON.stringify(rawKey)} has no provider-neutral mapping. Add an explicit mapping before using this report for parity.`,
        scenarioKey: input.scenarioKey,
        setting: rawKey,
      });
      continue;
    }
    const value = booleanValue(rawValue);
    if (value === null) {
      input.issues.push({
        code: "PROVIDER_SETTING_VALUE_INVALID",
        message:
          `${input.source} setting ${JSON.stringify(rawKey)}=${JSON.stringify(rawValue)} is not a recognized boolean value.`,
        scenarioKey: input.scenarioKey,
        setting: rawKey,
      });
      continue;
    }
    const prior = seen.get(canonical);
    if (prior !== undefined && prior !== value) {
      input.issues.push({
        code: "PROVIDER_SETTING_VALUE_INVALID",
        message:
          `${input.source} settings map conflicting values onto ${canonical}.`,
        scenarioKey: input.scenarioKey,
        setting: canonical,
      });
      continue;
    }
    seen.set(canonical, value);
    normalized[canonical] = value;
  }
  return input.issues.some(
      (entry) => entry.scenarioKey === input.scenarioKey,
    )
    ? null
    : Object.fromEntries(
        Object.entries(normalized).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
}

/**
 * Rebinds one provider-observed contract for execution by the other provider.
 * Provider metadata is the only intentionally discarded identity. Gameplay
 * settings are first passed through the same reviewed provider-neutral map
 * used by parity evaluation, so aliases cannot leak into the local engine and
 * an unknown setting still fails closed.
 */
export function rebindTesseraScenarioContractProvider(
  contract: TesseraFrozenScenarioContract[],
  sourceProvider: TesseraSimulationProvider,
  targetProvider: TesseraSimulationProvider,
): TesseraFrozenScenarioContract[] {
  const canonical = canonicalTesseraScenarioContract(contract);
  const rebound = canonical.map((entry) => {
    const key = scenarioKey(entry);
    const providerEntries = Object.entries(entry.settings).filter(
      ([name]) => normalizedKey(name) === "provider",
    );
    if (
      providerEntries.length > 1 ||
      providerEntries.some(
        ([, value]) => value !== sourceProvider,
      )
    ) {
      throw new TesseraScenarioContractError(
        "TESSERA_SCENARIO_CONTRACT_MISMATCH",
        `The Tessera scenario contract ${key} does not declare a single ${sourceProvider} source provider.`,
      );
    }
    const issues: TesseraProviderNeutralScenarioIssue[] = [];
    const settings = normalizeSettings({
      settings: entry.settings,
      phase: entry.phase,
      scenarioKey: key,
      source: "frozen",
      issues,
    });
    if (!settings || issues.length > 0) {
      throw new TesseraScenarioContractError(
        "TESSERA_SCENARIO_CONTRACT_MISMATCH",
        issues
          .map((issue) => `${issue.code}: ${issue.message}`)
          .join("; ") ||
          `The Tessera scenario contract ${key} could not be rebound.`,
      );
    }
    return {
      ...entry,
      settings: {
        ...settings,
        provider: targetProvider,
      },
    };
  });
  return canonicalTesseraScenarioContract(rebound);
}

/**
 * Reconciles a report's provider-specific observations with the exact frozen
 * contract retained by that report. Raw settings are never compared as if
 * provider labels were semantic identities: only the explicit v1 mapping is
 * eligible, and an unknown key fails closed.
 */
export function normalizeTesseraReportScenarioContractForParity(
  report: TesseraMatchupReport,
): TesseraProviderNeutralScenarioResult {
  if (!Array.isArray(report.scenarioContract) || report.scenarioContract.length === 0) {
    return {
      ok: false,
      report: null,
      contract: null,
      rawContractSha256: null,
      normalizedContractSha256: null,
      issues: [{
        code: "FROZEN_CONTRACT_MISSING",
        message:
          "Provider parity requires an explicit frozen scenario contract in each completed report.",
        scenarioKey: null,
        setting: null,
      }],
    };
  }

  let frozen: TesseraFrozenScenarioContract[];
  let rawContractSha256: string;
  try {
    frozen = canonicalTesseraScenarioContract(report.scenarioContract);
    rawContractSha256 = tesseraScenarioContractSha256(frozen);
  } catch (error) {
    return {
      ok: false,
      report: null,
      contract: null,
      rawContractSha256: null,
      normalizedContractSha256: null,
      issues: [{
        code: "FROZEN_CONTRACT_SCOPE_MISMATCH",
        message:
          error instanceof Error
            ? error.message
            : "The frozen scenario contract is invalid.",
        scenarioKey: null,
        setting: null,
      }],
    };
  }
  if (
    report.scenarioContractSha256 !== rawContractSha256
  ) {
    return {
      ok: false,
      report: null,
      contract: null,
      rawContractSha256,
      normalizedContractSha256: null,
      issues: [{
        code: "FROZEN_CONTRACT_DIGEST_INVALID",
        message:
          "The frozen scenario contract does not match the SHA-256 retained by the report.",
        scenarioKey: null,
        setting: null,
      }],
    };
  }

  const issues: TesseraProviderNeutralScenarioIssue[] = [];
  const normalizedByKey = new Map<string, TesseraFrozenScenarioContract>();
  for (const entry of frozen) {
    const key = scenarioKey(entry);
    const settings = normalizeSettings({
      settings: entry.settings,
      phase: entry.phase,
      scenarioKey: key,
      source: "frozen",
      issues,
    });
    if (!settings) continue;
    normalizedByKey.set(key, { ...entry, settings });
  }

  const observed = new Map<
    string,
    { iterations: number | null; settings: Record<string, string> }
  >();
  for (const scenario of report.simulation.scenarios ?? []) {
    for (const metricRun of scenario.metricRuns ?? []) {
      const key = scenarioKey({
        phase: scenario.phase,
        direction: scenario.direction,
        metric: metricRun.metric,
      });
      if (observed.has(key)) {
        issues.push({
          code: "OBSERVED_CONTRACT_INCOMPLETE",
          message: `The report repeats observed contract ${key}.`,
          scenarioKey: key,
          setting: null,
        });
      } else {
        observed.set(key, {
          iterations: metricRun.iterations,
          settings: metricRun.settings,
        });
      }
    }
  }

  for (const [key, expected] of normalizedByKey) {
    const actual = observed.get(key);
    if (!actual || !Number.isSafeInteger(actual.iterations) || actual.iterations! <= 0) {
      issues.push({
        code: "OBSERVED_CONTRACT_INCOMPLETE",
        message: `The report has no complete observed metric run for ${key}.`,
        scenarioKey: key,
        setting: null,
      });
      continue;
    }
    const settings = normalizeSettings({
      settings: actual.settings,
      phase: expected.phase,
      scenarioKey: key,
      source: "observed",
      issues,
    });
    if (!settings) continue;
    if (
      actual.iterations !== expected.iterations ||
      JSON.stringify(settings) !== JSON.stringify(expected.settings)
    ) {
      issues.push({
        code: "PROVIDER_SETTING_MISMATCH",
        message:
          `Observed provider settings or iterations did not reproduce the normalized frozen contract for ${key}.`,
        scenarioKey: key,
        setting: null,
      });
    }
  }
  for (const key of observed.keys()) {
    if (!normalizedByKey.has(key)) {
      issues.push({
        code: "FROZEN_CONTRACT_SCOPE_MISMATCH",
        message: `Observed provider contract ${key} is outside the frozen scope.`,
        scenarioKey: key,
        setting: null,
      });
    }
  }
  if (
    normalizedByKey.size !== frozen.length ||
    observed.size !== frozen.length
  ) {
    issues.push({
      code: "FROZEN_CONTRACT_SCOPE_MISMATCH",
      message:
        "The frozen and observed provider contracts do not have identical phase/direction/metric coverage.",
      scenarioKey: null,
      setting: null,
    });
  }
  if (issues.length > 0) {
    return {
      ok: false,
      report: null,
      contract: null,
      rawContractSha256,
      normalizedContractSha256: null,
      issues,
    };
  }

  const contract = canonicalTesseraScenarioContract([
    ...normalizedByKey.values(),
  ]);
  const normalizedContractSha256 = tesseraScenarioContractSha256(contract);
  const normalizedReport = structuredClone(report);
  normalizedReport.scenarioContract = contract;
  normalizedReport.scenarioContractSha256 = normalizedContractSha256;
  for (const scenario of normalizedReport.simulation.scenarios ?? []) {
    for (const metricRun of scenario.metricRuns ?? []) {
      const entry = normalizedByKey.get(
        scenarioKey({
          phase: scenario.phase,
          direction: scenario.direction,
          metric: metricRun.metric,
        }),
      );
      if (!entry) continue;
      metricRun.settings = { ...entry.settings };
      metricRun.iterations = entry.iterations;
    }
    const first = scenario.metricRuns?.[0];
    if (first) {
      scenario.settings = { ...first.settings };
      scenario.iterations = first.iterations;
    }
  }
  return {
    ok: true,
    report: normalizedReport,
    contract,
    rawContractSha256,
    normalizedContractSha256,
    issues: [],
  };
}
