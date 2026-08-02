import crypto from "node:crypto";

import { strToU8 } from "fflate";
import { z } from "zod";

import type {
  CertificationArtifactDescriptor,
  CertificationResultStatus,
} from "../../lib/rosterpilot/certification";
import type { ConnectorEvent } from "../../lib/rosterpilot";
import {
  TESSERA_DIRECTIONS,
  TESSERA_METRICS,
  TESSERA_PHASES,
  type TesseraBrowserResult,
  type TesseraDirection,
  type TesseraScenario,
} from "../tessera/browser";

export const LIVE_CERTIFICATION_SCENARIO_IDS =
  TESSERA_PHASES.flatMap((phase) =>
    TESSERA_METRICS.flatMap((metric) =>
      TESSERA_DIRECTIONS.map(
        (direction) => `${phase}:${direction}:${metric}`,
      ),
    ),
  );

const TesseraPhaseSchema = z.enum(TESSERA_PHASES);
const TesseraMetricSchema = z.enum(TESSERA_METRICS);
const TesseraDirectionSchema = z.enum(TESSERA_DIRECTIONS);
const nullableFiniteNumber = z
  .number()
  .refine(Number.isFinite)
  .nullable();
const TesseraCellUncertaintySchema = z
  .object({
    sampleCount: z.number().int().positive().nullable(),
    standardDeviation: z.number().nonnegative().nullable(),
    standardError: z.number().nonnegative().nullable(),
    completeness: z.enum([
      "complete",
      "partial",
      "unavailable",
    ]),
  })
  .strict();
const TesseraMatrixCellSchema = z
  .object({
    attacker: z.string().min(1),
    target: z.string().min(1),
    direction: TesseraDirectionSchema.optional(),
    killProbability: nullableFiniteNumber,
    expectedDamage: nullableFiniteNumber,
    damagePer100Points: nullableFiniteNumber,
    uncertainty: TesseraCellUncertaintySchema.optional(),
  })
  .strict();
const TesseraScenarioCellSchema = TesseraMatrixCellSchema.extend({
  attackerIndex: z.number().int().nonnegative(),
  targetIndex: z.number().int().nonnegative(),
  attackerOccurrence: z.number().int().positive(),
  targetOccurrence: z.number().int().positive(),
  metricValue: z.number().refine(Number.isFinite),
  seed: z.number().int().optional(),
  executionSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
}).strict();
const TesseraScenarioSchema = z
  .object({
    id: z.string().min(1),
    phase: TesseraPhaseSchema,
    direction: TesseraDirectionSchema,
    metric: TesseraMetricSchema,
    settings: z.record(z.string()),
    iterations: z.number().nullable(),
    seed: z.number().int().optional(),
    executionSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
    projectionSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
    cells: z.array(TesseraScenarioCellSchema),
    matrixSha256: z.string().optional(),
    integrity: z
      .object({
        status: z.enum(["trusted", "aliased"]),
        issueCodes: z.array(
          z.enum([
            "TESSERA_PHASE_MATRIX_ALIAS",
            "TESSERA_METRIC_MATRIX_ALIAS",
          ]),
        ),
        aliasedScenarioIds: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();
const TesseraImportedSemanticValueSchema = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .strict();
const TesseraImportedSemanticToggleSchema = z
  .object({
    name: z.string(),
    state: z.boolean().nullable(),
  })
  .strict();
const TesseraImportedWeaponSemanticSchema = z
  .object({
    occurrence: z.number().int().positive(),
    name: z.string(),
    profile: z.string().nullable(),
    count: z.number().int().nonnegative().nullable(),
    visibleCharacteristics: z.array(
      TesseraImportedSemanticValueSchema,
    ),
    effectToggles: z.array(TesseraImportedSemanticToggleSchema),
  })
  .strict();
const TesseraImportedUnitSemanticSchema = z
  .object({
    occurrence: z.number().int().positive(),
    name: z.string(),
    modelCount: z.number().int().positive().nullable(),
    included: z.boolean().nullable(),
    weapons: z.array(TesseraImportedWeaponSemanticSchema),
    visibleCharacteristics: z.array(
      TesseraImportedSemanticValueSchema,
    ),
    effectToggles: z.array(TesseraImportedSemanticToggleSchema),
  })
  .strict();
const TesseraImportedArmySemanticSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    side: z.enum(["player", "opponent"]),
    armyName: z.string().nullable(),
    reportedUnitCount: z.number().int().nonnegative().nullable(),
    units: z.array(TesseraImportedUnitSemanticSchema),
    warningCodes: z.array(z.string()),
    alternateProfileResolutions: z.array(
      z
        .object({
          unit: z.string().nullable(),
          weaponGroup: z.string().nullable(),
          availableProfiles: z.array(z.string()),
          selectedProfile: z.string().nullable(),
          resolvedByPolicy: z.boolean(),
        })
        .strict(),
    ),
    completeness: z.enum(["complete", "partial", "unavailable"]),
    incompleteReasons: z.array(z.string()),
  })
  .strict();
const TesseraImportedArmySimulationStateBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    side: z.enum(["player", "opponent"]),
    snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/i),
    savedListName: z.string().min(1),
    selectedUnitCount: z.number().int().positive(),
    selectorValueSha256: z.string().regex(/^[0-9a-f]{64}$/i),
    selectorLabel: z.string().min(1),
    selectorLabelSha256: z.string().regex(/^[0-9a-f]{64}$/i),
    stateSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .strict();
const TesseraWebsiteProviderEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    deployment: z
      .object({
        identitySha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/i)
          .nullable(),
        declaredVersion: z.string().nullable(),
        assets: z.array(
          z
            .object({
              url: z.string().min(1),
              sameOrigin: z.boolean(),
              sha256: z
                .string()
                .regex(/^[0-9a-f]{64}$/i)
                .nullable(),
              byteLength: z
                .number()
                .int()
                .nonnegative()
                .nullable()
                .optional(),
            })
            .strict(),
        ),
        complete: z.boolean(),
        completeness: z.enum([
          "complete",
          "partial",
          "fallback",
          "unavailable",
        ]),
        declarationSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/i)
          .nullable(),
        incompleteReasons: z.array(z.string()),
      })
      .strict(),
    importSemantics: z
      .object({
        combinedSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/i)
          .nullable(),
        playerSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/i)
          .nullable(),
        opponentSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/i)
          .nullable(),
        complete: z.boolean(),
        completeness: z.enum(["complete", "partial", "unavailable"]),
        unresolvedEffectCount: z.number().int().nonnegative(),
        playerSnapshot:
          TesseraImportedArmySemanticSnapshotSchema.nullable(),
        opponentSnapshot:
          TesseraImportedArmySemanticSnapshotSchema.nullable(),
        stateBindings: z
          .object({
            player:
              TesseraImportedArmySimulationStateBindingSchema.nullable(),
            opponent:
              TesseraImportedArmySimulationStateBindingSchema.nullable(),
          })
          .strict()
          .optional(),
        incompleteReasons: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
const TesseraSavedListActionSchema = z
  .object({
    name: z.string().min(1),
    expectedUnitCount: z.number().int().positive(),
    action: z.enum(["imported", "reused"]),
    contentSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    semanticSnapshotSource: z
      .enum(["fresh-import", "verified-cache", "unavailable"])
      .optional(),
    semanticSnapshotSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    semanticSnapshotReceiptSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
  })
  .strict();
const CertificationTesseraBrowserResultSchema = z
  .object({
    uiIdentity: z.string().nullable().optional(),
    providerEvidence: TesseraWebsiteProviderEvidenceSchema.optional(),
    legacyProjection: z.unknown().optional(),
    settings: z.record(z.string()),
    cells: z.array(TesseraMatrixCellSchema),
    scenarios: z.array(TesseraScenarioSchema),
    importWarnings: z
      .object({
        player: z.array(z.string()),
        opponent: z.array(z.string()),
      })
      .strict(),
    importIssues: z.array(z.unknown()).optional(),
    integrityIssues: z.array(z.unknown()).optional(),
    scenarioAttempts: z.array(z.unknown()).optional(),
    savedListReuse: z
      .object({
        mode: z.literal("deterministic"),
        player: TesseraSavedListActionSchema,
        opponent: TesseraSavedListActionSchema,
      })
      .strict()
      .optional(),
    warnings: z.array(z.string()),
  })
  .strict();

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function parseCertificationTesseraBrowserResult(
  value: unknown,
): TesseraBrowserResult {
  const parsed =
    CertificationTesseraBrowserResultSchema.safeParse(value);
  if (!parsed.success) {
    throw codedError(
      "CERTIFICATION_TESSERA_RESULT_INVALID",
      "The local agent returned a malformed Tessera result. No scenario from that response was trusted.",
    );
  }
  return parsed.data as TesseraBrowserResult;
}

type ScenarioContractIssueCode =
  | "TESSERA_SCENARIO_ID_TUPLE_MISMATCH"
  | "TESSERA_SCENARIO_ITERATIONS_INVALID"
  | "TESSERA_SCENARIO_MATRIX_HASH_INVALID"
  | "TESSERA_SCENARIO_SETTINGS_MISMATCH"
  | "TESSERA_SCENARIO_CELL_DIRECTION_MISMATCH"
  | "TESSERA_SCENARIO_INTEGRITY_UNTRUSTED"
  | "TESSERA_SCENARIO_CELLS_EMPTY";

type ScenarioCoverage = {
  expectedScenarioCount: number;
  returnedScenarioCount: number;
  uniqueScenarioCount: number;
  trustedScenarioCount: number;
  missingCanonicalScenarioIds: string[];
  absentCanonicalScenarioIds: string[];
  incompleteScenarioIds: string[];
  untrustedScenarioIds: string[];
  unexpectedScenarioIds: string[];
  duplicateScenarioIds: string[];
  invalidContractScenarioIds: string[];
  scenarioContractIssues: Array<{
    scenarioId: string;
    codes: ScenarioContractIssueCode[];
  }>;
  uiIdentityPresent: boolean;
  integrityIssueCount: number;
  dimensions: {
    consistent: boolean;
    byDirection: Record<
      TesseraDirection,
      { attackers: number; targets: number } | null
    >;
    issues: string[];
  };
};

export type LiveTesseraCertificationCapture = {
  status: Extract<CertificationResultStatus, "pass" | "fail">;
  code: string | null;
  message: string;
  retryable: boolean;
  complete: boolean;
  evidence: Record<string, unknown>;
  artifact: CertificationArtifactDescriptor;
  /**
   * Compatibility alias for the simulation event used by earlier callers.
   * New callers should persist `connectorEvents`, which also accounts for
   * each deterministic Tessera saved-list import or reuse.
   */
  connectorEvent: ConnectorEvent;
  connectorEvents: ConnectorEvent[];
  uiIdentity: string | null;
};

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const sha256Pattern = /^[0-9a-f]{64}$/i;

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function setting(
  settings: Record<string, string>,
  name: string,
): string | null {
  const match = Object.entries(settings).find(
    ([key]) => key.trim().toLocaleLowerCase() === name,
  );
  return match?.[1] ?? null;
}

function stableScenarioSettings(
  settings: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(settings)
      .filter(
        ([key]) =>
          !["phase", "metric", "direction", "iterations"].includes(
            key.trim().toLocaleLowerCase(),
          ),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function metricSettingMatches(
  value: string,
  metric: TesseraScenario["metric"],
): boolean {
  const patterns: Record<TesseraScenario["metric"], RegExp> = {
    "wipe-probability": /^p\s*\(\s*wiped\s*\)$/i,
    "half-wipe-probability":
      /^p\s*\(\s*(?:≥?\s*half(?:\s+wiped)?|half-wipe|≥?\s*50\s*%|50\s*%\+?)\s*\)$/i,
    "mean-kills": /^mean kills$/i,
    "mean-damage": /^mean damage$/i,
  };
  return patterns[metric].test(value.trim());
}

function directionSettingMatches(
  value: string,
  direction: TesseraDirection,
): boolean {
  const patterns: Record<TesseraDirection, RegExp> = {
    "player-to-opponent": /^a\s*(?:→|->|to)\s*b$/i,
    "opponent-to-player": /^b\s*(?:→|->|to)\s*a$/i,
  };
  return patterns[direction].test(value.trim());
}

function scenarioContractIssueCodes(
  scenario: TesseraScenario,
  resultSettings: Record<string, string>,
): ScenarioContractIssueCode[] {
  const issues: ScenarioContractIssueCode[] = [];
  if (
    scenario.id !==
    `${scenario.phase}:${scenario.direction}:${scenario.metric}`
  ) {
    issues.push("TESSERA_SCENARIO_ID_TUPLE_MISMATCH");
  }
  if (
    !Number.isSafeInteger(scenario.iterations) ||
    Number(scenario.iterations) <= 0
  ) {
    issues.push("TESSERA_SCENARIO_ITERATIONS_INVALID");
  }
  if (
    !scenario.matrixSha256 ||
    !sha256Pattern.test(scenario.matrixSha256)
  ) {
    issues.push("TESSERA_SCENARIO_MATRIX_HASH_INVALID");
  }
  const scenarioPhase = setting(scenario.settings, "phase");
  const scenarioMetric = setting(scenario.settings, "metric");
  const scenarioDirection = setting(
    scenario.settings,
    "direction",
  );
  const scenarioIterations = setting(
    scenario.settings,
    "iterations",
  );
  const settingsMismatch =
    canonical(stableScenarioSettings(scenario.settings)) !==
      canonical(stableScenarioSettings(resultSettings)) ||
    scenarioPhase === null ||
    scenarioPhase.trim().toLocaleLowerCase() !== scenario.phase ||
    scenarioMetric === null ||
    !metricSettingMatches(scenarioMetric, scenario.metric) ||
    scenarioDirection === null ||
    !directionSettingMatches(
      scenarioDirection,
      scenario.direction,
    ) ||
    scenarioIterations === null ||
    Number(scenarioIterations.replaceAll(",", "")) !==
      scenario.iterations;
  if (settingsMismatch) {
    issues.push("TESSERA_SCENARIO_SETTINGS_MISMATCH");
  }
  if (
    scenario.cells.some(
      (cell) =>
        cell.direction !== undefined &&
        cell.direction !== scenario.direction,
    )
  ) {
    issues.push(
      "TESSERA_SCENARIO_CELL_DIRECTION_MISMATCH",
    );
  }
  if (scenario.integrity?.status !== "trusted") {
    issues.push("TESSERA_SCENARIO_INTEGRITY_UNTRUSTED");
  }
  if (scenario.cells.length === 0) {
    issues.push("TESSERA_SCENARIO_CELLS_EMPTY");
  }
  return issues;
}

/**
 * Converts the browser's per-side deterministic saved-list result into
 * durable connector events. Importing a missing saved list is a remote
 * preparation mutation; selecting an already verified deterministic list is
 * a manifest-scoped reuse and is not a mutation.
 */
export function tesseraSavedListConnectorEvents(input: {
  savedListReuse:
    | NonNullable<TesseraBrowserResult["savedListReuse"]>
    | null
    | undefined;
  recordedAt: string;
  eventIdSeed: string;
  contentSha256?: {
    player?: string | null;
    opponent?: string | null;
  };
}): ConnectorEvent[] {
  if (!input.savedListReuse) return [];
  return (["player", "opponent"] as const).map((side) => {
    const result = input.savedListReuse![side];
    const declaredContentSha256 =
      result.contentSha256?.toLowerCase() ??
      input.contentSha256?.[side]?.toLowerCase() ??
      null;
    const contentSha256 =
      declaredContentSha256 &&
      sha256Pattern.test(declaredContentSha256)
        ? declaredContentSha256
        : null;
    const remoteId = sha256(result.name);
    const imported = result.action === "imported";
    return {
      schemaVersion: 1,
      eventId: sha256(
        JSON.stringify({
          schemaVersion: 1,
          kind: "tessera-saved-list",
          eventIdSeed: input.eventIdSeed,
          side,
          nameSha256: remoteId,
          action: result.action,
          expectedUnitCount: result.expectedUnitCount,
          contentSha256,
        }),
      ),
      recordedAt: input.recordedAt,
      provider: "tessera",
      action: "prepare",
      origin: imported ? "new-remote" : "manifest-reuse",
      outcome: imported ? "verified" : "reused",
      remoteId,
      contentSha256,
    };
  });
}

function scenarioIsTrusted(
  scenario: TesseraScenario,
  resultSettings: Record<string, string>,
): boolean {
  return (
    LIVE_CERTIFICATION_SCENARIO_IDS.includes(scenario.id) &&
    scenarioContractIssueCodes(
      scenario,
      resultSettings,
    ).length === 0
  );
}

function scenarioDimensions(scenario: TesseraScenario): {
  attackers: number;
  targets: number;
  rectangular: boolean;
} {
  const attackerIndexes = [
    ...new Set(
      scenario.cells.map((cell) => cell.attackerIndex),
    ),
  ].sort((left, right) => left - right);
  const targetIndexes = [
    ...new Set(
      scenario.cells.map((cell) => cell.targetIndex),
    ),
  ].sort((left, right) => left - right);
  const contiguous = (indexes: number[]) =>
    indexes.every((value, index) => value === index);
  return {
    attackers: attackerIndexes.length,
    targets: targetIndexes.length,
    rectangular:
      attackerIndexes.length > 0 &&
      targetIndexes.length > 0 &&
      contiguous(attackerIndexes) &&
      contiguous(targetIndexes) &&
      scenario.cells.length ===
        attackerIndexes.length * targetIndexes.length,
  };
}

function scenarioDimensionCoverage(
  scenarios: TesseraScenario[],
  expectedPlayerUnitCount: number,
  expectedOpponentUnitCount: number,
): ScenarioCoverage["dimensions"] {
  const byDirection: ScenarioCoverage["dimensions"]["byDirection"] = {
    "player-to-opponent": null,
    "opponent-to-player": null,
  };
  const issues: string[] = [];
  for (const scenario of scenarios) {
    if (!LIVE_CERTIFICATION_SCENARIO_IDS.includes(scenario.id)) {
      continue;
    }
    const dimensions = scenarioDimensions(scenario);
    if (!dimensions.rectangular) {
      issues.push(
        `${scenario.id} does not contain a complete rectangular matrix.`,
      );
      continue;
    }
    const prior = byDirection[scenario.direction];
    if (
      prior &&
      (prior.attackers !== dimensions.attackers ||
        prior.targets !== dimensions.targets)
    ) {
      issues.push(
        `${scenario.id} has dimensions ${dimensions.attackers}x${dimensions.targets}; expected ${prior.attackers}x${prior.targets} for ${scenario.direction}.`,
      );
      continue;
    }
    byDirection[scenario.direction] = {
      attackers: dimensions.attackers,
      targets: dimensions.targets,
    };
  }
  const forward = byDirection["player-to-opponent"];
  const reverse = byDirection["opponent-to-player"];
  if (!forward || !reverse) {
    issues.push(
      "Both forward and reverse canonical matrix dimensions were not returned.",
    );
  } else if (
    forward.attackers !== reverse.targets ||
    forward.targets !== reverse.attackers
  ) {
    issues.push(
      `Forward dimensions ${forward.attackers}x${forward.targets} are not the transpose of reverse dimensions ${reverse.attackers}x${reverse.targets}.`,
    );
  }
  if (
    forward &&
    (
      forward.attackers !== expectedPlayerUnitCount ||
      forward.targets !== expectedOpponentUnitCount
    )
  ) {
    issues.push(
      `Forward dimensions ${forward.attackers}x${forward.targets} do not match the verified ${expectedPlayerUnitCount}x${expectedOpponentUnitCount} imported-unit counts.`,
    );
  }
  if (
    reverse &&
    (
      reverse.attackers !== expectedOpponentUnitCount ||
      reverse.targets !== expectedPlayerUnitCount
    )
  ) {
    issues.push(
      `Reverse dimensions ${reverse.attackers}x${reverse.targets} do not match the verified ${expectedOpponentUnitCount}x${expectedPlayerUnitCount} imported-unit counts.`,
    );
  }
  return {
    consistent: issues.length === 0,
    byDirection,
    issues,
  };
}

function scenarioCoverage(
  result: TesseraBrowserResult,
  expectedPlayerUnitCount: number,
  expectedOpponentUnitCount: number,
): ScenarioCoverage {
  const expected = new Set(LIVE_CERTIFICATION_SCENARIO_IDS);
  const returnedIds = result.scenarios.map((scenario) => scenario.id);
  const returned = new Set(returnedIds);
  const scenarioContractIssues = result.scenarios
    .map((scenario) => ({
      scenarioId: scenario.id,
      codes: scenarioContractIssueCodes(
        scenario,
        result.settings,
      ),
    }))
    .filter(({ codes }) => codes.length > 0);
  const trusted = new Set(
    result.scenarios
      .filter((scenario) =>
        scenarioIsTrusted(scenario, result.settings),
      )
      .map((scenario) => scenario.id),
  );
  const frequencies = new Map<string, number>();
  for (const id of returnedIds) {
    frequencies.set(id, (frequencies.get(id) ?? 0) + 1);
  }
  return {
    expectedScenarioCount: LIVE_CERTIFICATION_SCENARIO_IDS.length,
    returnedScenarioCount: result.scenarios.length,
    uniqueScenarioCount: returned.size,
    trustedScenarioCount: trusted.size,
    missingCanonicalScenarioIds:
      LIVE_CERTIFICATION_SCENARIO_IDS.filter(
        (id) => !trusted.has(id),
      ),
    absentCanonicalScenarioIds:
      LIVE_CERTIFICATION_SCENARIO_IDS.filter(
        (id) => !returned.has(id),
      ),
    incompleteScenarioIds: [
      ...new Set(
        result.scenarios
          .filter(
            (scenario) =>
              expected.has(scenario.id) &&
              !scenarioIsTrusted(scenario, result.settings),
          )
          .map((scenario) => scenario.id),
      ),
    ].sort(),
    untrustedScenarioIds: [
      ...new Set(
        result.scenarios
          .filter(
            (scenario) =>
              expected.has(scenario.id) &&
              scenario.integrity?.status !== "trusted",
          )
          .map((scenario) => scenario.id),
      ),
    ].sort(),
    unexpectedScenarioIds: [
      ...new Set(returnedIds.filter((id) => !expected.has(id))),
    ].sort(),
    duplicateScenarioIds: [...frequencies]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .sort(),
    invalidContractScenarioIds: [
      ...new Set(
        scenarioContractIssues.map(
          ({ scenarioId }) => scenarioId,
        ),
      ),
    ].sort(),
    scenarioContractIssues,
    uiIdentityPresent:
      typeof result.uiIdentity === "string" &&
      result.uiIdentity.trim().length > 0,
    integrityIssueCount: result.integrityIssues?.length ?? 0,
    dimensions: scenarioDimensionCoverage(
      result.scenarios,
      expectedPlayerUnitCount,
      expectedOpponentUnitCount,
    ),
  };
}

function coverageIsComplete(
  coverage: ScenarioCoverage,
): boolean {
  return (
    coverage.returnedScenarioCount ===
      coverage.expectedScenarioCount &&
    coverage.uniqueScenarioCount ===
      coverage.expectedScenarioCount &&
    coverage.trustedScenarioCount ===
      coverage.expectedScenarioCount &&
    coverage.missingCanonicalScenarioIds.length === 0 &&
    coverage.incompleteScenarioIds.length === 0 &&
    coverage.untrustedScenarioIds.length === 0 &&
    coverage.unexpectedScenarioIds.length === 0 &&
    coverage.duplicateScenarioIds.length === 0 &&
    coverage.invalidContractScenarioIds.length === 0 &&
    coverage.scenarioContractIssues.length === 0 &&
    coverage.uiIdentityPresent &&
    coverage.integrityIssueCount === 0 &&
    coverage.dimensions.consistent
  );
}

/**
 * Freezes every field returned by Tessera before certification decides
 * whether the requested full matrix is complete. This keeps useful partial
 * evidence durable without allowing it to become a passing result.
 */
export async function captureLiveTesseraCertificationResult(input: {
  factionId: string;
  playerName: string;
  opponentName: string;
  expectedPlayerUnitCount: number;
  expectedOpponentUnitCount: number;
  result: unknown;
  profilePolicyEvidence: Record<string, unknown>;
  writeArtifact: (
    filename: string,
    content: Uint8Array,
  ) => Promise<string>;
  eventId?: string;
  recordedAt?: string;
}): Promise<LiveTesseraCertificationCapture> {
  const result = parseCertificationTesseraBrowserResult(
    input.result,
  );
  const coverage = scenarioCoverage(
    result,
    input.expectedPlayerUnitCount,
    input.expectedOpponentUnitCount,
  );
  const complete = coverageIsComplete(coverage);
  const scenarioFingerprint = sha256(
    canonical({
      schemaVersion: 2,
      uiIdentity: result.uiIdentity ?? null,
      settings: result.settings,
      profilePolicy: input.profilePolicyEvidence,
      expectedPlayerUnitCount:
        input.expectedPlayerUnitCount,
      expectedOpponentUnitCount:
        input.expectedOpponentUnitCount,
      providerEvidence: result.providerEvidence ?? null,
      scenarios: result.scenarios
        .map((scenario) => ({
          id: scenario.id,
          phase: scenario.phase,
          direction: scenario.direction,
          metric: scenario.metric,
          settings: scenario.settings,
          iterations: scenario.iterations,
          matrixSha256: scenario.matrixSha256 ?? null,
          integrity: scenario.integrity ?? null,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );
  const artifactContent = strToU8(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "rosterpilot-tessera-scenarios",
        status: complete ? "complete" : "partial",
        factionId: input.factionId,
        playerName: input.playerName,
        opponentName: input.opponentName,
        uiIdentity: result.uiIdentity ?? null,
        providerEvidence: result.providerEvidence ?? null,
        settings: result.settings,
        profilePolicy: input.profilePolicyEvidence,
        coverage,
        scenarios: result.scenarios,
        scenarioAttempts: result.scenarioAttempts ?? [],
        importWarnings: result.importWarnings,
        importIssues: result.importIssues ?? [],
        savedListReuse: result.savedListReuse ?? null,
        integrityIssues: result.integrityIssues ?? [],
        warnings: result.warnings,
      },
      null,
      2,
    )}\n`,
  );
  const artifactSha256 = sha256(artifactContent);
  const artifactPath = await input.writeArtifact(
    `${input.factionId}-${artifactSha256.slice(0, 12)}-tessera-${
      complete ? "scenarios" : "partial-scenarios"
    }.json`,
    artifactContent,
  );
  const artifact = {
    kind: "scenario" as const,
    path: artifactPath,
    sha256: artifactSha256,
  };
  const recordedAt =
    input.recordedAt ?? new Date().toISOString();
  const simulationEventId =
    input.eventId ?? crypto.randomUUID();
  const savedListEvents = tesseraSavedListConnectorEvents({
    savedListReuse: result.savedListReuse,
    recordedAt,
    eventIdSeed: simulationEventId,
  });
  const evidence = {
    scenarios: result.scenarios.length,
    scenarioData: result.scenarios,
    scenarioIds: result.scenarios.map(
      (scenario) => scenario.id,
    ),
    scenarioAttempts: result.scenarioAttempts ?? [],
    ...coverage,
    settings: result.settings,
    uiIdentity: result.uiIdentity ?? null,
    providerEvidence: result.providerEvidence ?? null,
    profilePolicy: input.profilePolicyEvidence,
    importWarnings: result.importWarnings,
    importIssues: result.importIssues ?? [],
    savedListReuse: result.savedListReuse ?? null,
    warnings: result.warnings,
    integrityIssues: result.integrityIssues ?? [],
    scenarioFingerprint,
    scenarioArtifactStatus: complete ? "complete" : "partial",
    scenarioArtifactSha256: artifactSha256,
    connectorAccounting: {
      schemaVersion: 1,
      savedListImports: savedListEvents.filter(
        (event) =>
          event.origin === "new-remote" &&
          event.outcome === "verified",
      ).length,
      savedListReuses: savedListEvents.filter(
        (event) =>
          event.origin === "manifest-reuse" &&
          event.outcome === "reused",
      ).length,
      savedListEventCount: savedListEvents.length,
      synthesizedFromLegacyEvidence: false,
      synthesizedEventCount: 0,
      contentHashUnavailableSides: savedListEvents
        .map((event, index) =>
          event.contentSha256 === null
            ? index === 0
              ? "player"
              : "opponent"
            : null,
        )
        .filter(
          (side): side is "player" | "opponent" =>
            side !== null,
        ),
    },
  };
  const simulationEvent: ConnectorEvent = {
    schemaVersion: 1,
    eventId: simulationEventId,
    recordedAt,
    provider: "tessera",
    action: "simulate",
    origin: "new-remote",
    outcome: complete ? "verified" : "failed",
    remoteId: null,
    contentSha256: scenarioFingerprint,
  };
  return {
    status: complete ? "pass" : "fail",
    code: complete
      ? null
      : "CERTIFICATION_TESSERA_SCENARIOS_INCOMPLETE",
    message: complete
      ? "Tessera returned all 16 requested scenarios with stable fingerprints and iteration counts."
      : `Tessera returned ${coverage.trustedScenarioCount}/${coverage.expectedScenarioCount} complete trusted canonical scenarios.`,
    retryable: !complete,
    complete,
    evidence,
    artifact,
    connectorEvent: simulationEvent,
    connectorEvents: [...savedListEvents, simulationEvent],
    uiIdentity: result.uiIdentity ?? null,
  };
}
