import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  TesseraDirection,
  TesseraFrozenScenarioContract,
  TesseraMetric,
  TesseraPhase,
  TesseraScenarioResult,
  TesseraSimulationBackend,
} from "../../lib/rosterpilot";

export const TESSERA_SCENARIO_PHASES = [
  "shooting",
  "fight",
] as const satisfies readonly TesseraPhase[];

export const TESSERA_SCENARIO_DIRECTIONS = [
  "player-to-opponent",
  "opponent-to-player",
] as const satisfies readonly TesseraDirection[];

export const TESSERA_SCENARIO_METRICS = [
  "wipe-probability",
  "half-wipe-probability",
  "mean-kills",
  "mean-damage",
] as const satisfies readonly TesseraMetric[];

const ScenarioContractEntrySchema = z.object({
  phase: z.enum(TESSERA_SCENARIO_PHASES),
  direction: z.enum(TESSERA_SCENARIO_DIRECTIONS),
  metric: z.enum(TESSERA_SCENARIO_METRICS),
  settings: z.record(z.string()),
  iterations: z.number().int().positive(),
}).strict();

export const TesseraScenarioContractSchema = z
  .array(ScenarioContractEntrySchema)
  .min(1);

export class TesseraScenarioContractError extends Error {
  readonly code:
    | "TESSERA_SCENARIO_CONTRACT_INVALID"
    | "TESSERA_SCENARIO_CONTRACT_MISMATCH";

  constructor(
    code: TesseraScenarioContractError["code"],
    message: string,
  ) {
    super(message);
    this.name = "TesseraScenarioContractError";
    this.code = code;
  }
}

function contractKey(
  entry: Pick<
    TesseraFrozenScenarioContract,
    "phase" | "direction" | "metric"
  >,
): string {
  return `${entry.phase}:${entry.direction}:${entry.metric}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalTesseraScenarioContract(
  value: unknown,
): TesseraFrozenScenarioContract[] {
  const parsed = TesseraScenarioContractSchema.safeParse(value);
  if (!parsed.success) {
    throw new TesseraScenarioContractError(
      "TESSERA_SCENARIO_CONTRACT_INVALID",
      `The Tessera scenario contract is invalid: ${parsed.error.issues[0]?.message ?? "schema validation failed"}.`,
    );
  }
  const keys = parsed.data.map(contractKey);
  if (new Set(keys).size !== keys.length) {
    const duplicate = keys.find(
      (key, index) => keys.indexOf(key) !== index,
    );
    throw new TesseraScenarioContractError(
      "TESSERA_SCENARIO_CONTRACT_INVALID",
      `The Tessera scenario contract repeats ${duplicate ?? "a phase/direction/metric tuple"}.`,
    );
  }
  return parsed.data
    .map((entry) => ({
      ...entry,
      settings: Object.fromEntries(
        Object.entries(entry.settings).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }))
    .sort(
      (left, right) =>
        left.phase.localeCompare(right.phase) ||
        left.direction.localeCompare(right.direction) ||
        left.metric.localeCompare(right.metric),
    );
}

export function tesseraScenarioContractSha256(
  contract: TesseraFrozenScenarioContract[],
): string {
  const canonical = canonicalTesseraScenarioContract(contract);
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(canonical)))
    .digest("hex");
}

export function assertTesseraScenarioContractScope(
  contract: TesseraFrozenScenarioContract[],
  phases: readonly TesseraPhase[],
  metrics: readonly TesseraMetric[],
): TesseraFrozenScenarioContract[] {
  const canonical = canonicalTesseraScenarioContract(contract);
  const uniquePhases = [...new Set(phases)];
  const uniqueMetrics = [...new Set(metrics)];
  const expected = new Set(
    uniquePhases.flatMap((phase) =>
      TESSERA_SCENARIO_DIRECTIONS.flatMap((direction) =>
        uniqueMetrics.map((metric) =>
          contractKey({ phase, direction, metric }),
        ),
      ),
    ),
  );
  const actual = new Set(canonical.map(contractKey));
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : null,
      extra.length > 0 ? `unexpected ${extra.join(", ")}` : null,
    ].filter((detail): detail is string => detail !== null);
    throw new TesseraScenarioContractError(
      "TESSERA_SCENARIO_CONTRACT_MISMATCH",
      `The Tessera scenario contract does not exactly match the requested phase/metric scope (${details.join("; ")}).`,
    );
  }
  return canonical;
}

export function assertTesseraScenarioContractProvider(
  contract: TesseraFrozenScenarioContract[],
  backend: TesseraSimulationBackend,
): void {
  if (backend === "auto") return;
  const declaredProviders = [
    ...new Set(
      contract
        .map((entry) => entry.settings.provider)
        .filter((provider): provider is string => provider !== undefined),
    ),
  ];
  if (
    declaredProviders.length > 1 ||
    (
      declaredProviders.length === 1 &&
      declaredProviders[0] !== backend
    )
  ) {
    throw new TesseraScenarioContractError(
      "TESSERA_SCENARIO_CONTRACT_MISMATCH",
      `The Tessera scenario contract declares provider ${declaredProviders.join(", ") || "unknown"}, which does not match --simulation-backend ${backend}.`,
    );
  }
}

export function localTesseraBaselineSettings(
  phase: TesseraPhase,
): Record<string, string> {
  return {
    provider: "local-engine",
    phase,
    targetInCover: "false",
    charging: phase === "fight" ? "true" : "false",
    // Fresh local scalar runs use the universal point-blank physical
    // baseline from scenario-policy v3. At zero inches every in-range Rapid
    // Fire and Melta profile is also within half range.
    withinRapidFireRange: "true",
    withinMeltaRange: "true",
    remainedStationary: "false",
    indirectFire: "false",
  };
}

export function localTesseraScenarioContract(
  iterations: number,
  phases: readonly TesseraPhase[] = TESSERA_SCENARIO_PHASES,
  metrics: readonly TesseraMetric[] = TESSERA_SCENARIO_METRICS,
): TesseraFrozenScenarioContract[] {
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new TesseraScenarioContractError(
      "TESSERA_SCENARIO_CONTRACT_INVALID",
      "Tessera iterations must be a positive safe integer.",
    );
  }
  return canonicalTesseraScenarioContract(
    [...new Set(phases)].flatMap((phase) =>
      TESSERA_SCENARIO_DIRECTIONS.flatMap((direction) =>
        [...new Set(metrics)].map((metric) => ({
          phase,
          direction,
          metric,
          settings: localTesseraBaselineSettings(phase),
          iterations,
        })),
      ),
    ),
  );
}

export function projectTesseraScenarioContract(
  contract: TesseraFrozenScenarioContract[],
  phases: readonly TesseraPhase[],
  metrics: readonly TesseraMetric[],
): TesseraFrozenScenarioContract[] {
  const phaseSet = new Set(phases);
  const metricSet = new Set(metrics);
  const projected = canonicalTesseraScenarioContract(contract).filter(
    (entry) =>
      phaseSet.has(entry.phase) && metricSet.has(entry.metric),
  );
  return assertTesseraScenarioContractScope(
    projected,
    phases,
    metrics,
  );
}

export function observedTesseraScenarioContract(
  scenarios: readonly TesseraScenarioResult[],
  phases: readonly TesseraPhase[],
  metrics: readonly TesseraMetric[],
): TesseraFrozenScenarioContract[] {
  const byKey = new Map<string, TesseraFrozenScenarioContract>();
  for (const scenario of scenarios) {
    for (const metricRun of scenario.metricRuns ?? []) {
      if (
        metricRun.iterations === null ||
        !Number.isSafeInteger(metricRun.iterations) ||
        metricRun.iterations <= 0
      ) {
        throw new TesseraScenarioContractError(
          "TESSERA_SCENARIO_CONTRACT_INVALID",
          `The observed Tessera scenario ${scenario.phase}:${scenario.direction}:${metricRun.metric} has no positive iteration count.`,
        );
      }
      const entry = canonicalTesseraScenarioContract([
        {
          phase: scenario.phase,
          direction: scenario.direction,
          metric: metricRun.metric,
          settings: metricRun.settings,
          iterations: metricRun.iterations,
        },
      ])[0];
      const key = contractKey(entry);
      const prior = byKey.get(key);
      if (
        prior &&
        JSON.stringify(canonicalValue(prior)) !==
          JSON.stringify(canonicalValue(entry))
      ) {
        throw new TesseraScenarioContractError(
          "TESSERA_SCENARIO_CONTRACT_MISMATCH",
          `Observed Tessera opponents produced different contracts for ${key}.`,
        );
      }
      byKey.set(key, entry);
    }
  }
  return assertTesseraScenarioContractScope(
    [...byKey.values()],
    phases,
    metrics,
  );
}
