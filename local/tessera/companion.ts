import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  analyzeMissionReadiness,
  baselineDamageCells,
  compareNewRecruitCatalogueProvenance,
  generateFactionStressPortfolio,
  getNewRecruitFactionSummary,
  inspectEnrichedRosz,
  newRecruitCatalogue,
  rosterExecutionFingerprint,
  searchUnits,
  validateRoster,
  type EnrichedRoszSummary,
  type ExportArtifact,
  type ConnectorEvent,
  type ModifyRosterOperation,
  type ProfilePolicyV1,
  type ResultEnvelope,
  type RosterDraftV1,
  type RosterIssue,
  type TesseraArchetype,
  type TesseraAnalysisConfiguration,
  type TesseraChangeCandidate,
  type TesseraConfidence,
  type TesseraConnectionStatus,
  type TesseraDirection,
  type TesseraFinding,
  type TesseraFrozenScenarioContract,
  type TesseraMatchupReport,
  type TesseraMetric,
  type TesseraMetricValues,
  type TesseraPhase,
  type TesseraPointsComparison,
  type TesseraPreparedRoster,
  type TesseraRevisionComparisonReport,
  type TesseraRevisionDelta,
  type TesseraScenarioCell,
  type TesseraScenarioResult,
  type TesseraStressPortfolioItem,
  type TesseraUnitInstance,
} from "../../lib/rosterpilot";
import {
  writeExportArtifact,
  writeExportArtifacts,
  type WriteOptions,
} from "../../lib/rosterpilot/io";
import {
  configureKeychainProvider,
  deliverRosterToNewRecruit,
  enrichRoszThroughNewRecruit,
  forgetKeychainProvider,
  type NewRecruitDeliveryOptions,
} from "../new-recruit/companion";
import {
  loadNewRecruitCache,
  storeNewRecruitCache,
} from "../new-recruit/cache";
import {
  getLocalAgentStatus,
  LocalAgentError,
  runTesseraThroughLocalAgent,
} from "../agent/client";
import { projectRoot } from "../agent/paths";
import {
  runTesseraBrowserMatchup,
  TESSERA_URL,
  type TesseraBrowserResult,
} from "./browser";
import {
  qualifyRosterChangeCandidate,
} from "./candidate-quality";
import {
  renderTesseraMatchupReportHtml,
  renderTesseraRevisionComparisonHtml,
} from "./report";
import {
  aggregateProfileRequirements,
  profilePolicyHash,
  profilePolicyScaffold,
  ProfilePolicySchema,
  validateProfilePolicy,
} from "./profile-policy";
import {
  getRuntimeProvenance,
  runtimeRestartIssue,
} from "../runtime-provenance";

const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ARCHETYPE_PREFERENCES: Record<
  TesseraArchetype,
  RosterDraftV1["preferences"]
> = {
  "balanced-control": ["objective", "durability"],
  "ranged-pressure": ["shooting", "durability"],
  "assault-pressure": ["melee", "mobility"],
};

const injectedDeliveryCaches = new WeakMap<
  NonNullable<TesseraDependencies["deliver"]>,
  Map<
    string,
    ReturnType<NonNullable<TesseraDependencies["deliver"]>>
  >
>();

export type TesseraOpponentInput =
  | { kind: "roster"; roster: RosterDraftV1 }
  | { kind: "rosz"; path: string }
  | {
      kind: "faction-archetypes";
      factionId: string;
      archetypes?: TesseraArchetype[];
    };

export type TesseraAnalysisOptions = WriteOptions & {
  outputDirectory?: string;
  executionMode?: "prepare-only" | "simulate";
  fallbackMode?: "none" | "baseline-damage-v1";
  profilePolicyPath?: string;
  /** @deprecated Use executionMode. */
  experimental?: boolean;
  analysisMode?: "quick" | "full";
  phases?: TesseraPhase[];
  metrics?: TesseraMetric[];
  profilePolicy?: ProfilePolicyV1 | null;
  /**
   * Internal frozen source context for a ROSZ opponent. Resumable stress
   * runs use it to finish policy and legality preflights before reopening a
   * previously verified enriched archive.
   */
  opponentRosterContext?: RosterDraftV1;
  frozenScenarioContract?: TesseraFrozenScenarioContract[] | null;
  sessionId?: string;
  allowPointMismatch?: boolean;
  includeChangeCandidates?: boolean;
};

export type TesseraDependencies = {
  deliver?: typeof deliverRosterToNewRecruit;
  enrich?: typeof enrichRoszThroughNewRecruit;
  runBrowser?: typeof runTesseraBrowserMatchup;
  runtimeIssue?: typeof runtimeRestartIssue;
};

export function clearPreparedRosterDeliveryMemo(
  deliver: NonNullable<TesseraDependencies["deliver"]>,
): void {
  injectedDeliveryCaches.delete(deliver);
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

export async function getTesseraConnectionStatus(): Promise<
  ResultEnvelope<TesseraConnectionStatus>
> {
  const browserAvailable = await exists(chromePath);
  let agentStatus: Awaited<ReturnType<typeof getLocalAgentStatus>> | null = null;
  let agentError: LocalAgentError | null = null;
  try {
    agentStatus = await getLocalAgentStatus({ timeoutMs: 2_000 });
  } catch (error) {
    agentError =
      error instanceof LocalAgentError
        ? error
        : new LocalAgentError(
            "LOCAL_AGENT_UNAVAILABLE",
            error instanceof Error
              ? error.message
              : "The RosterPilot local agent is unavailable.",
          );
  }
  const provider = agentStatus?.providers.find(
    (item) => item.providerId === "tessera",
  );
  const brokerAvailable = agentStatus?.brokerAvailable === true;
  const installationCurrent =
    agentStatus?.projectDirectory === projectRoot;
  const runtime = getRuntimeProvenance();
  const runtimeCompatible =
    agentStatus?.runtime?.buildId === runtime.buildId &&
    agentStatus.runtime.stale === false &&
    runtime.stale === false;
  const available =
    process.platform === "darwin" &&
    browserAvailable &&
    agentStatus?.available === true &&
    agentStatus.protocolCompatible &&
    installationCurrent &&
    runtimeCompatible &&
    provider?.credentialState === "ready";
  return {
    ok: true,
    data: {
      available,
      platform: process.platform,
      browserAvailable,
      brokerAvailable,
      credentialsConfigured: provider?.credentialState === "ready",
      agentAvailable: agentStatus?.available === true,
      agentVersion: agentStatus?.version ?? null,
      protocolCompatible: agentStatus?.protocolCompatible === true,
      installationCurrent,
      runtimeCompatible,
      runtimeBuildId: runtime.buildId,
      agentRuntimeBuildId: agentStatus?.runtime?.buildId ?? null,
      credentialState:
        provider?.credentialState ??
        (brokerAvailable ? "unavailable" : "not-configured"),
      experimental: true,
      url: TESSERA_URL,
    },
    violations: [],
    warnings: agentError
      ? [
          {
            code: agentError.code,
            message: agentError.message,
            severity: "warn",
          },
        ]
      : !runtimeCompatible && agentStatus?.available
        ? [
          {
            code: "RUNTIME_RESTART_REQUIRED",
            message:
              "The MCP process and local agent do not share the same current source fingerprint. Restart both before Tessera analysis.",
            severity: "warn",
          },
        ]
      : !installationCurrent && agentStatus?.available
        ? [
          {
            code: "LOCAL_AGENT_CHECKOUT_MISMATCH",
            message:
              'The running local agent belongs to another checkout. Run "rosterpilot agent install" from this checkout before Tessera analysis.',
            severity: "warn",
          },
        ]
      : available
        ? []
        : [
          {
            code: "TESSERA_COMPANION_UNAVAILABLE",
            message:
              "Tessera automation requires macOS, Google Chrome, the local agent, and a configured premium key. Enriched .rosz handoff remains available.",
            severity: "warn",
          },
        ],
  };
}

export async function configureTesseraCredentials() {
  return configureKeychainProvider("tessera");
}

export async function forgetTesseraCredentials() {
  return forgetKeychainProvider("tessera");
}

async function runTesseraViaAgent(
  input: Parameters<typeof runTesseraBrowserMatchup>[0],
): Promise<TesseraBrowserResult> {
  const [player, opponent] = await Promise.all([
    readFile(input.playerRoszPath),
    readFile(input.opponentRoszPath),
  ]);
  return runTesseraThroughLocalAgent({
    playerFilename: path.basename(input.playerRoszPath),
    playerRoszBase64: player.toString("base64"),
    playerName: input.playerName,
    opponentFilename: path.basename(input.opponentRoszPath),
    opponentRoszBase64: opponent.toString("base64"),
    opponentName: input.opponentName,
    analysisMode: input.analysisMode,
    phases: input.phases ? [...input.phases] : undefined,
    metrics: input.metrics ? [...input.metrics] : undefined,
    profilePolicy: input.profilePolicy,
    frozenScenarioContract: input.frozenScenarioContract,
    savedListReuse: input.savedListReuse,
    sessionId: input.sessionId,
  });
}

export async function prepareRosterForTessera(
  roster: RosterDraftV1,
  options: NewRecruitDeliveryOptions = {},
  dependencies: TesseraDependencies = {},
): Promise<ResultEnvelope<TesseraPreparedRoster>> {
  const validation = validateRoster(roster);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }
  const restartIssue = dependencies.runtimeIssue
    ? dependencies.runtimeIssue()
    : dependencies.deliver
      ? null
      : runtimeRestartIssue();
  if (restartIssue) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          ...restartIssue,
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  let cacheReused = false;
  let delivery: Awaited<ReturnType<typeof deliverRosterToNewRecruit>>;
  if (dependencies.deliver) {
    const dependencyCache =
      injectedDeliveryCaches.get(dependencies.deliver) ??
      new Map();
    injectedDeliveryCaches.set(
      dependencies.deliver,
      dependencyCache,
    );
    const cacheKey = [
      rosterExecutionFingerprint(roster),
      roster.sourceData.releaseId,
    ].join(":");
    let pending = dependencyCache.get(cacheKey);
    if (pending) {
      cacheReused = true;
    } else {
      pending = dependencies.deliver(roster, {
        ...options,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        outputDirectory:
          options.outputDirectory ?? "exports/tessera",
      });
      dependencyCache.set(cacheKey, pending);
    }
    delivery = await pending;
    if (!delivery.ok) dependencyCache.delete(cacheKey);
  } else {
    const cached = await loadNewRecruitCache(roster);
    if (cached) {
      delivery = cached;
      cacheReused = true;
    } else {
      delivery = await deliverRosterToNewRecruit(roster, {
        ...options,
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        outputDirectory: options.outputDirectory ?? "exports/tessera",
      });
      if (delivery.ok) await storeNewRecruitCache(roster, delivery);
    }
  }
  if (
    delivery.data?.cacheReused === true ||
    delivery.warnings.some(
      (warning) => warning.code === "NEW_RECRUIT_CACHE_REUSED",
    )
  ) {
    cacheReused = true;
  }
  const source = delivery.data?.artifacts.find(
    (artifact) =>
      artifact.format === "rosz" ||
      artifact.format === "rosterpilot-source-rosz",
  );
  const enriched = delivery.data?.artifacts.find(
    (artifact) => artifact.format === "new-recruit-enriched-rosz",
  );
  if (
    !delivery.ok ||
    !delivery.data ||
    !source ||
    !enriched ||
    !delivery.data.enrichedSummary
  ) {
    return {
      ok: false,
      data: null,
      violations:
        delivery.violations.length > 0
          ? delivery.violations
          : [
              {
                code: "TESSERA_HANDOFF_INCOMPLETE",
                message:
                  "New Recruit did not return a verified enriched .rosz artifact.",
                severity: "error",
              },
            ],
      warnings: delivery.warnings,
    };
  }
  const prepared: TesseraPreparedRoster = {
    rosterId: roster.id,
    rosterName: roster.name,
    factionId: roster.factionId,
    listUrl: delivery.data.listUrl,
    sourceRoszPath: source.written,
    enrichedRoszPath: enriched.written,
    summary: delivery.data.enrichedSummary,
    fingerprint: rosterFingerprint(roster),
    units: canonicalUnits(roster, "player"),
    cacheReused,
    connectorEvents: delivery.data.connectorEvents ?? [],
    constraints: structuredClone(roster.constraints),
  };
  const factionCatalogue = getNewRecruitFactionSummary(roster.factionId);
  if (!factionCatalogue?.catalogue.id) {
    return {
      ok: false,
      data: prepared,
      violations: [
        {
          code: "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNAVAILABLE",
          message:
            `The pinned ${roster.factionName} New Recruit catalogue identity is unavailable, so Tessera cannot verify the prepared roster's catalogue provenance.`,
          severity: "error",
        },
      ],
      warnings: delivery.warnings,
    };
  }
  const catalogueProvenance = compareNewRecruitCatalogueProvenance(
    delivery.data.enrichedSummary,
    {
      releaseId: roster.sourceData.releaseId,
      gameSystem: {
        id: newRecruitCatalogue.gameSystem.id,
        name: newRecruitCatalogue.gameSystem.name,
        revision: roster.sourceData.newRecruit.gameSystemRevision,
      },
      catalogue: {
        id: factionCatalogue.catalogue.id,
        name: factionCatalogue.catalogue.name,
        revision: roster.sourceData.newRecruit.catalogueRevision,
      },
    },
  );
  prepared.catalogueProvenance = catalogueProvenance;
  if (catalogueProvenance.status === "drift") {
    const mismatchSummary = catalogueProvenance.mismatches
      .map(
        (mismatch) =>
          `${mismatch.field} expected ${mismatch.expected}, observed ${
            mismatch.observed ?? "missing"
          }`,
      )
      .join("; ");
    return {
      ok: false,
      data: prepared,
      violations: [
        {
          code: "NEW_RECRUIT_CATALOGUE_DRIFT",
          message:
            `The catalogue identity observed in New Recruit's enriched ROSZ differs from pinned release ${roster.sourceData.releaseId}: ${mismatchSummary}. Tessera was not started. This comparison does not infer New Recruit's backend commit.`,
          severity: "error",
        },
      ],
      warnings: delivery.warnings,
    };
  }
  if (catalogueProvenance.status === "unverifiable") {
    return {
      ok: false,
      data: prepared,
      violations: [
        {
          code: "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNVERIFIABLE",
          message:
            `New Recruit's enriched ROSZ omitted ${catalogueProvenance.missing.join(", ")}. The pinned release remains recorded, but Tessera was not started because the live catalogue identity could not be verified.`,
          severity: "error",
        },
      ],
      warnings: delivery.warnings,
    };
  }
  return {
    ok: true,
    data: prepared,
    violations: [],
    warnings: delivery.warnings,
  };
}

function rosterFingerprint(roster: RosterDraftV1): string {
  return crypto
    .createHash("sha256")
    .update(
      [
        roster.factionId,
        roster.detachmentId,
        roster.forceDispositionId,
        roster.units
          .map(
            (unit) =>
              `${unit.selectionId}:${unit.unitId}:${unit.modelCount}:${unit.points}:${unit.equipment
                .map((item) => `${item.itemId}:${item.count}`)
                .sort()
                .join(",")}`,
          )
          .sort()
          .join("|"),
      ].join("::"),
    )
    .digest("hex");
}

function analysisConfiguration(
  options: TesseraAnalysisOptions,
): TesseraAnalysisConfiguration {
  const analysisMode = options.analysisMode ?? "full";
  return {
    analysisMode,
    phases:
      options.phases?.length
        ? [...new Set(options.phases)]
        : analysisMode === "quick"
          ? ["shooting"]
          : ["shooting", "fight"],
    metrics:
      options.metrics?.length
        ? [...new Set(options.metrics)]
        : analysisMode === "quick"
          ? ["wipe-probability"]
          : [
            "wipe-probability",
            "half-wipe-probability",
            "mean-kills",
            "mean-damage",
          ],
    directions: ["player-to-opponent", "opponent-to-player"],
    pointsTolerancePercent: 5,
    allowPointMismatch: options.allowPointMismatch ?? false,
    includeChangeCandidates: options.includeChangeCandidates ?? true,
  };
}

function unitLabel(
  name: string,
  modelCount: number,
  points: number | null,
  ordinal: number,
): string {
  return `${name} — ${modelCount} ${modelCount === 1 ? "model" : "models"}${
    points === null ? "" : ` — ${points} pts`
  } — Unit ${ordinal}`;
}

function canonicalUnits(
  roster: RosterDraftV1,
  side: TesseraUnitInstance["side"],
): TesseraUnitInstance[] {
  return roster.units.map((unit) => ({
    instanceId: unit.selectionId,
    selectionId: unit.selectionId,
    side,
    name: unit.name,
    label: unitLabel(unit.name, unit.modelCount, unit.points, unit.ordinal),
    ordinal: unit.ordinal,
    modelCount: unit.modelCount,
    points: unit.points,
    tags: unit.tags,
  }));
}

function enrichedUnits(
  summary: EnrichedRoszSummary,
  side: TesseraUnitInstance["side"],
): TesseraUnitInstance[] {
  const ordinals = new Map<string, number>();
  return summary.units.map((unit, index) => {
    const key = unit.name.trim().toLocaleLowerCase();
    const ordinal = unit.ordinal ?? (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    const points = unit.points ?? null;
    const selectionId = unit.selectionId ?? null;
    const instanceId =
      selectionId ??
      crypto
        .createHash("sha256")
        .update(
          `${summary.rosterName}|${index}|${key}|${unit.modelCount}|${points ?? ""}`,
        )
        .digest("hex")
        .slice(0, 24);
    return {
      instanceId,
      selectionId,
      side,
      name: unit.name,
      label: unitLabel(unit.name, unit.modelCount, points, ordinal),
      ordinal,
      modelCount: unit.modelCount,
      points,
      tags: [],
    };
  });
}

function summaryFingerprint(summary: EnrichedRoszSummary): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        rosterName: summary.rosterName,
        factionName: summary.factionName,
        totalPoints: summary.totalPoints,
        generatedBy: summary.generatedBy,
        units: summary.units,
      }),
    )
    .digest("hex");
}

function pointsComparison(
  playerPoints: number,
  opponentPoints: number,
  pointsLimit: number,
  tolerancePercent: number,
): TesseraPointsComparison {
  const difference = Math.abs(playerPoints - opponentPoints);
  const differencePercent =
    pointsLimit > 0 ? (difference / pointsLimit) * 100 : difference > 0 ? 100 : 0;
  const matched = differencePercent <= tolerancePercent;
  return {
    playerPoints,
    opponentPoints,
    pointsLimit,
    difference,
    differencePercent,
    tolerancePercent,
    matched,
    classification: matched ? "matched" : "unmatched",
  };
}

function pointsMismatchMessage(comparison: TesseraPointsComparison): string {
  return `Roster totals differ by ${comparison.difference} points (${comparison.differencePercent.toFixed(
    1,
  )}% of the ${comparison.pointsLimit}-point limit), above the ${comparison.tolerancePercent}% tolerance. Explicitly allow a mismatched directional analysis to continue.`;
}

function safeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

async function prepareUploadedRosz(
  filename: string,
  outputDirectory: string,
  options: TesseraAnalysisOptions,
  dependencies: TesseraDependencies,
): Promise<
  ResultEnvelope<{
    rosterName: string;
    enrichedRoszPath: string;
    summary: EnrichedRoszSummary;
  }>
> {
  let content: Buffer;
  try {
    content = await readFile(filename);
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "ROSTER_FILE_UNREADABLE",
          message:
            error instanceof Error ? error.message : "The .rosz could not be read.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  let summary: EnrichedRoszSummary;
  try {
    summary = inspectEnrichedRosz(content);
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "INVALID_ROSZ",
          message: error instanceof Error ? error.message : "Invalid .rosz.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  if (summary.profileCount === 0 || summary.weaponProfileCount === 0) {
    const enriched = await (dependencies.enrich ?? enrichRoszThroughNewRecruit)(
      filename,
      {
        ...options,
        outputDirectory,
      },
    );
    if (!enriched.ok || !enriched.data) {
      return {
        ok: false,
        data: null,
        violations: enriched.violations,
        warnings: enriched.warnings,
      };
    }
    return {
      ok: true,
      data: {
        rosterName: enriched.data.summary.rosterName,
        enrichedRoszPath: enriched.data.enrichedRoszPath,
        summary: enriched.data.summary,
      },
      violations: [],
      warnings: enriched.warnings,
    };
  }
  const outputPath = path.join(
    outputDirectory,
    `${safeName(summary.rosterName) || "opponent"}-enriched.rosz`,
  );
  try {
    const written = await writeExportArtifact(
      {
        format: "rosz",
        filename: path.basename(outputPath),
        mimeType: "application/zip",
        encoding: "binary",
        content,
      },
      outputPath,
      options,
    );
    return {
      ok: true,
      data: {
        rosterName: summary.rosterName,
        enrichedRoszPath: written,
        summary,
      },
      violations: [],
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "WRITE_FAILED",
          message: error instanceof Error ? error.message : "Write failed.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
}

function emptyMetricValues(): TesseraMetricValues {
  return {
    wipeProbability: null,
    halfWipeProbability: null,
    meanKills: null,
    meanDamage: null,
    damagePer100Points: null,
  };
}

function metricField(metric: TesseraMetric): keyof TesseraMetricValues {
  if (metric === "wipe-probability") return "wipeProbability";
  if (metric === "half-wipe-probability") return "halfWipeProbability";
  if (metric === "mean-kills") return "meanKills";
  return "meanDamage";
}

function unitMatchesIssue(
  unit: TesseraUnitInstance,
  issueUnit: string | null,
): boolean {
  if (!issueUnit) return false;
  const normalizedIssue = issueUnit
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
  return [unit.name, unit.label].some((value) => {
    const normalizedUnit = value
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
    return (
      normalizedUnit.includes(normalizedIssue) ||
      normalizedIssue.includes(normalizedUnit)
    );
  });
}

function matrixUnitForLabel(
  units: TesseraUnitInstance[],
  label: string,
  occurrence: number,
): TesseraUnitInstance | null {
  const normalizedLabel = label
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
  const normalizedUnit = (value: string) =>
    value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const exactLabels = units.filter(
    (unit) => normalizedUnit(unit.label) === normalizedLabel,
  );
  if (exactLabels.length === 1) return exactLabels[0];
  const exactNames = units.filter(
    (unit) => normalizedUnit(unit.name) === normalizedLabel,
  );
  const candidates =
    exactNames.length > 0
      ? exactNames
      : units.filter((unit) => {
          const name = normalizedUnit(unit.name);
          const canonicalLabel = normalizedUnit(unit.label);
          return (
            normalizedLabel.includes(name) ||
            name.includes(normalizedLabel) ||
            normalizedLabel.includes(canonicalLabel) ||
            canonicalLabel.includes(normalizedLabel)
          );
        });
  if (candidates.length === 1) return candidates[0];
  const explicitOrdinal = normalizedLabel.match(
    /(?:\bunit\s*|#)(\d+)\b/,
  )?.[1];
  if (explicitOrdinal) {
    const ordinal = Number(explicitOrdinal);
    const matched = candidates.filter(
      (unit) => unit.ordinal === ordinal,
    );
    if (matched.length === 1) return matched[0];
  }
  const occurrenceIndex = occurrence - 1;
  return occurrenceIndex >= 0 &&
    occurrenceIndex < candidates.length
    ? candidates[occurrenceIndex]
    : null;
}

function warningConfidence(
  warnings: string[],
  result: TesseraBrowserResult,
  attacker: TesseraUnitInstance,
  phase: TesseraPhase,
): TesseraConfidence {
  const relevantIssues = (result.importIssues ?? []).filter(
      (entry) =>
        entry.side === attacker.side &&
        (entry.phase === null || entry.phase === phase) &&
        unitMatchesIssue(attacker, entry.unit),
  );
  if (
    relevantIssues.some(
      (entry) =>
        entry.code === "alternate-profile" &&
        !entry.resolvedByPolicy,
    )
  ) {
    return "ambiguous";
  }
  if (
    relevantIssues.length > 0 &&
    relevantIssues.every((entry) => entry.resolvedByPolicy)
  ) {
    return "high";
  }
  return warnings.length > 0 ? "review" : "high";
}

function consolidateBrowserScenarios(
  result: TesseraBrowserResult,
  playerUnits: TesseraUnitInstance[],
  opponentUnits: TesseraUnitInstance[],
  opponentName: string,
  configuration: TesseraAnalysisConfiguration,
): TesseraScenarioResult[] {
  const rawScenarios = result.scenarios ?? [];
  const groups = new Map<
    string,
    {
      phase: TesseraPhase;
      direction: TesseraDirection;
      metrics: Set<TesseraMetric>;
      metricRuns: Array<{
        metric: TesseraMetric;
        iterations: number | null;
        settings: Record<string, string>;
        matrixSha256?: string;
        integrity?: {
          status: "trusted" | "aliased";
          issueCodes: string[];
          aliasedScenarioIds: string[];
        };
      }>;
      iterations: number | null;
      settings: Record<string, string>;
      values: Map<string, TesseraScenarioCell>;
      warnings: string[];
    }
  >();
  for (const raw of rawScenarios) {
    const phase = raw.phase as TesseraPhase;
    const direction = raw.direction as TesseraDirection;
    const metric = raw.metric as TesseraMetric;
    const key = `${phase}:${direction}`;
    const group =
      groups.get(key) ??
      {
        phase,
        direction,
        metrics: new Set<TesseraMetric>(),
        metricRuns: [],
        iterations: raw.iterations ?? null,
        settings: { ...(raw.settings ?? {}) },
        values: new Map<string, TesseraScenarioCell>(),
        warnings: [],
      };
    group.metrics.add(metric);
    group.metricRuns.push({
      metric,
      iterations: raw.iterations ?? null,
      settings: { ...(raw.settings ?? {}) },
      matrixSha256: raw.matrixSha256,
      integrity: raw.integrity,
    });
    group.iterations ??= raw.iterations ?? null;
    Object.assign(group.settings, raw.settings ?? {});
    const attackers =
      direction === "player-to-opponent" ? playerUnits : opponentUnits;
    const targets =
      direction === "player-to-opponent" ? opponentUnits : playerUnits;
    const attackerImportWarnings =
      direction === "player-to-opponent"
        ? (result.importWarnings?.player ?? [])
        : (result.importWarnings?.opponent ?? []);
    const targetImportWarnings =
      direction === "player-to-opponent"
        ? (result.importWarnings?.opponent ?? [])
        : (result.importWarnings?.player ?? []);
    for (const rawCell of raw.cells) {
      const attacker = matrixUnitForLabel(
        attackers,
        rawCell.attacker,
        rawCell.attackerOccurrence,
      );
      const target = matrixUnitForLabel(
        targets,
        rawCell.target,
        rawCell.targetOccurrence,
      );
      if (!attacker || !target) {
        group.warnings.push(
          `Tessera returned a ${direction} cell whose labels could not be mapped exactly: attacker="${rawCell.attacker}" occurrence=${rawCell.attackerOccurrence}, target="${rawCell.target}" occurrence=${rawCell.targetOccurrence}.`,
        );
        continue;
      }
      const confidence = warningConfidence(
        attackerImportWarnings,
        result,
        attacker,
        phase,
      );
      const relevantIssues = (result.importIssues ?? []).filter(
        (entry) =>
          (entry.side === attacker.side &&
            (entry.unit === null || unitMatchesIssue(attacker, entry.unit))) ||
          (entry.side === target.side &&
            (entry.unit === null || unitMatchesIssue(target, entry.unit))),
      );
      const warningRefs = [
        ...new Set(
          relevantIssues.length > 0
            ? relevantIssues.map(
                (entry) => {
                  const subject =
                    entry.side === attacker.side ? "Attacker" : "Target";
                  if (entry.resolvedByPolicy) {
                    return `${subject} import profile resolved by frozen policy: ${entry.weaponGroup ?? "alternate weapon"} → ${entry.selectedProfile ?? "selected profile"}.`;
                  }
                  return `${subject} import: ${entry.message}`;
                },
              )
            : [
                ...attackerImportWarnings.map(
                  (warning) => `Attacker import: ${warning}`,
                ),
                ...targetImportWarnings.map(
                  (warning) => `Target import: ${warning}`,
                ),
              ],
        ),
      ];
      const cellKey = `${attacker.instanceId}:${target.instanceId}`;
      const cell =
        group.values.get(cellKey) ??
        {
          attacker,
          target,
          values: emptyMetricValues(),
          confidence,
          warningRefs,
        };
      cell.values[metricField(metric)] = rawCell.metricValue;
      if (metric === "mean-damage" && attacker.points && attacker.points > 0) {
        cell.values.damagePer100Points =
          (rawCell.metricValue / attacker.points) * 100;
      }
      group.values.set(cellKey, cell);
    }
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const expectedCellCount =
      group.direction === "player-to-opponent"
        ? playerUnits.length * opponentUnits.length
        : opponentUnits.length * playerUnits.length;
    const missingMetrics = configuration.metrics.filter(
      (metric) => !group.metrics.has(metric),
    );
    const integrityCodes = [
      ...new Set(
        group.metricRuns.flatMap((run) =>
          run.integrity?.status === "aliased"
            ? run.integrity.issueCodes
            : [],
        ),
      ),
    ];
    const status =
      group.values.size === expectedCellCount &&
      missingMetrics.length === 0 &&
      integrityCodes.length === 0
        ? "complete"
        : "partial";
    const warnings = [...group.warnings];
    if (group.values.size !== expectedCellCount) {
      warnings.push(
        `Expected ${expectedCellCount} matrix cells but captured ${group.values.size}.`,
      );
    }
    if (missingMetrics.length) {
      warnings.push(`Missing metrics: ${missingMetrics.join(", ")}.`);
    }
    for (const code of integrityCodes) {
      warnings.push(
        `[${code}] Tessera returned identical content for independently captured matrices; this scenario is not trusted.`,
      );
    }
    return {
      scenarioId: crypto
        .createHash("sha256")
        .update(`${opponentName}:${group.phase}:${group.direction}`)
        .digest("hex")
        .slice(0, 24),
      opponentName,
      phase: group.phase,
      direction: group.direction,
      metrics: [...group.metrics],
      metricRuns: group.metricRuns.sort((left, right) =>
        left.metric.localeCompare(right.metric),
      ),
      iterations: group.iterations,
      settings: group.settings,
      cells: [...group.values.values()],
      status,
      warnings,
    };
  });
}

function evidence(
  scenario: TesseraScenarioResult,
  cell: TesseraScenarioCell,
) {
  return {
    scenarioId: scenario.scenarioId,
    attackerInstanceId: cell.attacker.instanceId,
    targetInstanceId: cell.target.instanceId,
    phase: scenario.phase,
    direction: scenario.direction,
    values: cell.values,
  };
}

function findingId(kind: TesseraFinding["kind"], key: string): string {
  return crypto
    .createHash("sha256")
    .update(`${kind}:${key}`)
    .digest("hex")
    .slice(0, 20);
}

function structuredFindings(
  scenarios: TesseraScenarioResult[],
): TesseraFinding[] {
  const findings: TesseraFinding[] = [];
  const coverageByTarget = new Map<
    string,
    {
      target: TesseraUnitInstance;
      evidence: TesseraFinding["evidence"];
      max: number;
      confidence: TesseraConfidence;
    }
  >();
  const ambiguousCoverageTargets = new Map<string, TesseraUnitInstance>();
  const reliableByPhase = new Set<TesseraPhase>();
  const ambiguousAttackPhases = new Set<TesseraPhase>();

  for (const scenario of scenarios) {
    for (const cell of scenario.cells) {
      const wipe = cell.values.wipeProbability ?? 0;
      const half = cell.values.halfWipeProbability;
      const confidence = cell.confidence;
      if (
        scenario.direction === "player-to-opponent" &&
        confidence === "ambiguous"
      ) {
        ambiguousAttackPhases.add(scenario.phase);
        ambiguousCoverageTargets.set(cell.target.instanceId, cell.target);
      }
      if (
        scenario.direction === "player-to-opponent" &&
        wipe >= 0.6 &&
        confidence !== "ambiguous"
      ) {
        reliableByPhase.add(scenario.phase);
        findings.push({
          findingId: findingId(
            "reliable-coverage",
            `${scenario.scenarioId}:${cell.attacker.instanceId}:${cell.target.instanceId}`,
          ),
          kind: "reliable-coverage",
          severity: "info",
          confidence,
          summary: `${cell.attacker.label} has a ${Math.round(
            wipe * 100,
          )}% modeled full-wipe probability into ${cell.target.label} in ${scenario.phase}.`,
          unitInstanceIds: [
            cell.attacker.instanceId,
            cell.target.instanceId,
          ],
          evidence: [evidence(scenario, cell)],
        });
      }
      if (
        scenario.direction === "opponent-to-player" &&
        wipe >= 0.5 &&
        confidence !== "ambiguous"
      ) {
        findings.push({
          findingId: findingId(
            "enemy-threat",
            `${scenario.scenarioId}:${cell.attacker.instanceId}:${cell.target.instanceId}`,
          ),
          kind: "enemy-threat",
          severity: "warn",
          confidence,
          summary: `${cell.attacker.label} threatens ${cell.target.label} at ${Math.round(
            wipe * 100,
          )}% modeled full-wipe probability in ${scenario.phase}.`,
          unitInstanceIds: [
            cell.attacker.instanceId,
            cell.target.instanceId,
          ],
          evidence: [evidence(scenario, cell)],
        });
      }
      if (
        scenario.direction === "player-to-opponent" &&
        half !== null &&
        confidence !== "ambiguous"
      ) {
        const current = coverageByTarget.get(cell.target.instanceId);
        if (!current || half > current.max) {
          coverageByTarget.set(cell.target.instanceId, {
            target: cell.target,
            evidence: [evidence(scenario, cell)],
            max: half,
            confidence,
          });
        }
      }
      if (
        scenario.direction === "player-to-opponent" &&
        cell.values.meanDamage !== null &&
        cell.values.damagePer100Points !== null &&
        cell.values.damagePer100Points < 1 &&
        confidence !== "ambiguous"
      ) {
        findings.push({
          findingId: findingId(
            "poor-efficiency",
            `${scenario.scenarioId}:${cell.attacker.instanceId}:${cell.target.instanceId}`,
          ),
          kind: "poor-efficiency",
          severity: "warn",
          confidence,
          summary: `${cell.attacker.label} produces only ${cell.values.damagePer100Points.toFixed(
            2,
          )} mean damage per 100 points into ${cell.target.label} in ${scenario.phase}.`,
          unitInstanceIds: [
            cell.attacker.instanceId,
            cell.target.instanceId,
          ],
          evidence: [evidence(scenario, cell)],
        });
      }
      if (
        scenario.direction === "player-to-opponent" &&
        wipe >= 0.6 &&
        confidence !== "ambiguous" &&
        cell.attacker.points !== null &&
        cell.target.points !== null &&
        cell.attacker.points > cell.target.points * 1.5
      ) {
        findings.push({
          findingId: findingId(
            "overqualified-trade",
            `${scenario.scenarioId}:${cell.attacker.instanceId}:${cell.target.instanceId}`,
          ),
          kind: "overqualified-trade",
          severity: "info",
          confidence,
          summary: `${cell.attacker.label} reliably removes ${cell.target.label}, but commits more than 1.5× its points.`,
          unitInstanceIds: [
            cell.attacker.instanceId,
            cell.target.instanceId,
          ],
          evidence: [evidence(scenario, cell)],
        });
      }
    }
  }

  for (const item of coverageByTarget.values()) {
    if (item.max >= 0.5) continue;
    findings.push({
      findingId: findingId("coverage-gap", item.target.instanceId),
      kind: "coverage-gap",
      severity: "warn",
      confidence: item.confidence,
      summary: `No modeled attack reaches a 50% chance to remove at least half of ${item.target.label} in one phase.`,
      unitInstanceIds: [item.target.instanceId],
      evidence: item.evidence,
    });
  }
  for (const [instanceId, target] of ambiguousCoverageTargets) {
    if (coverageByTarget.has(instanceId)) continue;
    findings.push({
      findingId: findingId("coverage-gap", `${instanceId}:ambiguous`),
      kind: "coverage-gap",
      severity: "warn",
      confidence: "ambiguous",
      summary: `Alternate-profile import warnings prevent a confident coverage assessment for ${target.label}.`,
      unitInstanceIds: [instanceId],
      evidence: [],
    });
  }

  for (const phase of ["shooting", "fight"] as TesseraPhase[]) {
    if (
      scenarios.some((scenario) => scenario.phase === phase) &&
      !reliableByPhase.has(phase)
    ) {
      findings.push({
        findingId: findingId("role-gap", phase),
        kind: "role-gap",
        severity: "warn",
        confidence: ambiguousAttackPhases.has(phase) ? "ambiguous" : "high",
        summary: ambiguousAttackPhases.has(phase)
          ? `Alternate-profile import warnings prevent a confident ${phase} role-gap assessment.`
          : `The baseline ${phase} matrices contain no 60% full-wipe matchup.`,
        unitInstanceIds: [],
        evidence: [],
      });
    }
  }

  const uniqueFindings = [
    ...new Map(findings.map((item) => [item.findingId, item])).values(),
  ];
  const kindOrder: TesseraFinding["kind"][] = [
    "enemy-threat",
    "coverage-gap",
    "role-gap",
    "vulnerable-unit",
    "poor-efficiency",
    "overqualified-trade",
    "reliable-coverage",
  ];
  return kindOrder.flatMap((kind) =>
    uniqueFindings.filter((finding) => finding.kind === kind).slice(0, 12),
  );
}

function legacyFindingText(findings: TesseraFinding[]) {
  const strengths = findings
    .filter((finding) => finding.kind === "reliable-coverage")
    .map((finding) => finding.summary)
    .slice(0, 12);
  const weaknesses = findings
    .filter((finding) =>
      ["enemy-threat", "coverage-gap", "vulnerable-unit"].includes(
        finding.kind,
      ),
    )
    .map((finding) => finding.summary)
    .slice(0, 12);
  const suggestions = findings.some((finding) => finding.kind === "enemy-threat")
    ? [
      "Review screening, defensive profiles, and lower-cost trading units before changing the roster.",
    ]
    : findings.some((finding) => finding.kind === "coverage-gap")
      ? [
        "Consider a legal roster change that adds a more efficient answer to the uncovered target profiles.",
      ]
      : [];
  return { strengths, weaknesses, suggestions };
}

function candidateRoleTags(findings: TesseraFinding[]): Array<
  "shooting" | "melee" | "objective" | "durability"
> {
  const tags = [
    ...new Set(findings.flatMap(roleTagsForFinding)),
  ];
  if (tags.length === 0) tags.push("objective");
  return tags;
}

function playerUnitIdsForFinding(
  roster: RosterDraftV1,
  finding: TesseraFinding,
): Set<string> {
  const rosterSelectionIds = new Set(
    roster.units.map((unit) => unit.selectionId),
  );
  const ids = new Set<string>();
  for (const evidence of finding.evidence) {
    const playerId =
      evidence.direction === "player-to-opponent"
        ? evidence.attackerInstanceId
        : evidence.targetInstanceId;
    if (rosterSelectionIds.has(playerId)) ids.add(playerId);
  }
  for (const instanceId of finding.unitInstanceIds) {
    if (rosterSelectionIds.has(instanceId)) ids.add(instanceId);
  }
  return ids;
}

function roleTagsForFinding(
  finding: TesseraFinding,
): Array<"shooting" | "melee" | "objective" | "durability"> {
  const tags: Array<
    "shooting" | "melee" | "objective" | "durability"
  > = [];
  if (
    /shooting/i.test(finding.summary) ||
    finding.evidence.some((entry) => entry.phase === "shooting")
  ) {
    tags.push("shooting");
  }
  if (
    /fight/i.test(finding.summary) ||
    finding.evidence.some((entry) => entry.phase === "fight")
  ) {
    tags.push("melee");
  }
  if (finding.kind === "enemy-threat") tags.push("durability");
  return [...new Set(tags)];
}

function candidateEvidence(
  roster: RosterDraftV1,
  findings: TesseraFinding[],
  selectionId: string | null,
  candidateTags: string[],
): TesseraFinding[] {
  return findings
    .filter(
      (finding) =>
        finding.severity === "warn" &&
        finding.confidence !== "ambiguous",
    )
    .filter((finding) => {
      if (
        selectionId &&
        playerUnitIdsForFinding(roster, finding).has(selectionId)
      ) {
        return true;
      }
      if (finding.kind !== "role-gap") return false;
      const requiredTags = roleTagsForFinding(finding);
      return (
        requiredTags.length > 0 &&
        requiredTags.every((tag) => candidateTags.includes(tag))
      );
    })
    .slice(0, 6);
}

function selectionIdForOperation(
  operation: ModifyRosterOperation,
): string | null {
  return "selectionId" in operation ? operation.selectionId : null;
}

async function changeCandidates(
  roster: RosterDraftV1,
  findings: TesseraFinding[],
): Promise<TesseraChangeCandidate[]> {
  const candidates: TesseraChangeCandidate[] = [];
  const seen = new Set<string>();
  const baselineReadiness = analyzeMissionReadiness(roster);
  if (!baselineReadiness.ok || !baselineReadiness.data) return [];
  const baselineReadinessReport = baselineReadiness.data;
  const actionableFindings = findings.filter(
    (finding) =>
      finding.severity === "warn" &&
      finding.confidence !== "ambiguous",
  );
  if (actionableFindings.length === 0) return [];
  const reliableSelectionIds = new Set(
    findings
      .filter((finding) => finding.kind === "reliable-coverage")
      .flatMap((finding) => [
        ...playerUnitIdsForFinding(roster, finding),
      ]),
  );
  const addCandidate = async (
    title: string,
    rationale: string,
    operation: ModifyRosterOperation,
    candidateTags: string[],
  ): Promise<void> => {
    const selectionId = selectionIdForOperation(operation);
    if (
      operation.type === "replace" &&
      selectionId &&
      reliableSelectionIds.has(selectionId)
    ) {
      return;
    }
    const evidence = candidateEvidence(
      roster,
      actionableFindings,
      selectionId,
      candidateTags,
    );
    if (evidence.length === 0) return;
    const qualified = await qualifyRosterChangeCandidate(
      roster,
      baselineReadinessReport,
      operation,
    );
    if (!qualified) return;
    const key = rosterFingerprint(qualified.roster);
    if (seen.has(key) || key === rosterFingerprint(roster)) return;
    seen.add(key);
    candidates.push({
      candidateId: crypto
        .createHash("sha256")
        .update(`${rosterFingerprint(roster)}:${JSON.stringify(operation)}`)
        .digest("hex")
        .slice(0, 20),
      title,
      rationale,
      operation,
      beforePoints: roster.totalPoints,
      afterPoints: qualified.roster.totalPoints,
      rosterFingerprint: key,
      evidenceFindingIds: evidence.map(
        (finding) => finding.findingId,
      ),
    });
  };

  const units = searchUnits({
    faction: roster.factionId,
    tags: candidateRoleTags(actionableFindings),
    includeLegends: roster.constraints.allowLegends,
    limit: 100,
  }).data ?? [];
  const allowedUnits = units.filter(
    (unit) =>
      (roster.constraints.allowNamedCharacters || !unit.isNamedCharacter) &&
      !(roster.constraints.excludedUnitIds ?? []).includes(unit.id) &&
      (!roster.constraints.collectionUnitIds ||
        roster.constraints.collectionUnitIds.includes(unit.id)),
  );
  const remaining = roster.pointsLimit - roster.totalPoints;
  for (const addition of allowedUnits.filter(
    (unit) => unit.pointsFrom <= remaining,
  )) {
    await addCandidate(
      `Add ${addition.name}`,
      `Uses available points to add ${candidateRoleTags(actionableFindings).join(
        "/",
      )} coverage while preserving a complete, exportable roster.`,
      { type: "add", unitId: addition.id },
      addition.tags,
    );
    if (candidates.length >= 3) break;
  }

  for (const selection of roster.units) {
    const summary = searchUnits({
      faction: roster.factionId,
      query: selection.name,
      includeLegends: roster.constraints.allowLegends,
      limit: 20,
    }).data?.find((unit) => unit.id === selection.unitId);
    const larger = summary?.modelCounts
      .filter((count) => count > selection.modelCount)
      .sort((a, b) => a - b)[0];
    if (larger !== undefined) {
      await addCandidate(
        `Increase ${selection.name} to ${larger} models`,
        "Uses spare points to strengthen an evidence-linked unit without changing its battlefield role.",
        {
          type: "set-model-count",
          selectionId: selection.selectionId,
          modelCount: larger,
        },
        selection.tags,
      );
      if (candidates.length >= 3) break;
    }
  }

  if (candidates.length < 3) {
    const requiredUnitIds = new Set(
      roster.constraints.requiredUnitIds ?? [],
    );
    const replaceable = roster.units
      .filter(
        (selection) =>
          !requiredUnitIds.has(selection.unitId) &&
          selection.unitId !==
            roster.constraints.requiredWarlordUnitId,
      )
      .sort(
        (a, b) =>
          b.points - a.points || a.name.localeCompare(b.name),
      );
    outer: for (const selection of replaceable) {
      for (const unit of allowedUnits) {
        if (unit.id === selection.unitId) continue;
        await addCandidate(
          `Replace ${selection.name} with ${unit.name}`,
          `Tests a legal ${candidateRoleTags(actionableFindings).join(
            "/",
          )} alternative while preserving a complete, exportable roster.`,
          {
            type: "replace",
            selectionId: selection.selectionId,
            unitId: unit.id,
          },
          unit.tags,
        );
        if (candidates.length >= 3) break outer;
      }
    }
  }
  return candidates.slice(0, 3);
}

async function requestedAnalysisProfilePolicy(
  options: TesseraAnalysisOptions,
): Promise<ProfilePolicyV1 | null> {
  let fromPath: ProfilePolicyV1 | null = null;
  if (options.profilePolicyPath) {
    const parsed = ProfilePolicySchema.safeParse(
      JSON.parse(await readFile(options.profilePolicyPath, "utf8")),
    );
    if (!parsed.success) {
      throw new Error(
        `The profile policy at ${options.profilePolicyPath} is not a valid v1 Tessera profile policy.`,
      );
    }
    fromPath = parsed.data;
  }
  if (
    fromPath &&
    options.profilePolicy &&
    profilePolicyHash(fromPath) !==
      profilePolicyHash(options.profilePolicy)
  ) {
    throw new Error(
      "profilePolicy and profilePolicyPath resolve to different canonical policies.",
    );
  }
  return fromPath ?? options.profilePolicy ?? null;
}

function failedPreparationReport(input: {
  playerRoster: RosterDraftV1;
  player: TesseraPreparedRoster;
  opponents?: TesseraMatchupReport["opponents"];
  simulationRequested: boolean;
  configuration: TesseraAnalysisConfiguration;
  profilePolicy: ProfilePolicyV1 | null;
  violations: RosterIssue[];
  warnings: RosterIssue[];
  opponentName?: string | null;
}): TesseraMatchupReport {
  const opponents = input.opponents ?? [];
  const connectorEvents = [
    ...(input.player.connectorEvents ?? []),
    ...opponents.flatMap(
      (opponent) => opponent.connectorEvents ?? [],
    ),
  ];
  const remoteMutations = connectorEvents.filter(
    (event) =>
      event.provider === "new-recruit" &&
      event.action === "prepare" &&
      event.origin === "new-remote" &&
      event.outcome === "verified",
  ).length;
  const cacheReuses = connectorEvents.filter(
    (event) =>
      event.provider === "new-recruit" &&
      event.action === "prepare" &&
      event.outcome === "reused",
  ).length;
  return {
    schemaVersion: 3,
    runId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    source: "prepare-only",
    status: "failed",
    preparation: {
      status: "failed",
      source: "new-recruit",
      uniqueRosters: 1 + opponents.length,
      remoteMutations,
      cacheReuses,
      connectorEvents,
    },
    failures: input.violations.map((violation) => ({
      stage: "preparation",
      code: violation.code,
      message: violation.message,
      opponentName: input.opponentName ?? null,
      retryable: false,
    })),
    profilePolicyHash: input.profilePolicy
      ? profilePolicyHash(input.profilePolicy)
      : null,
    runtime: getRuntimeProvenance(),
    tesseraUiIdentity: null,
    connectorEvents,
    pinnedData: input.playerRoster.sourceData,
    comparisonClass: "matched",
    configuration: input.configuration,
    pointsComparisons: [],
    player: input.player,
    opponents,
    simulation: {
      requested: input.simulationRequested,
      executionMode: input.simulationRequested
        ? "simulate"
        : "prepare-only",
      experimental: true,
      status: input.simulationRequested ? "failed" : "not-requested",
      engine: "tessera-ui",
      settings: {},
      legacyProjection: {
        status: "unavailable",
        phase: null,
        metric: null,
        scenarioIds: [],
      },
      matrices: [],
      scenarios: [],
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    findings: [],
    changeCandidates: [],
    limitations: [
      "Preparation failed before trusted Tessera evidence was collected.",
      "This report retains verified New Recruit artifacts and catalogue provenance for diagnosis and resume.",
      "No game win probability or matchup conclusion was produced.",
    ],
    warnings: input.warnings.map((warning) => warning.message),
    supplementalAnalyses: [],
    artifacts: [],
  };
}

export async function analyzeRosterMatchup(
  playerRoster: RosterDraftV1,
  opponent: TesseraOpponentInput,
  options: TesseraAnalysisOptions = {},
  dependencies: TesseraDependencies = {},
): Promise<ResultEnvelope<TesseraMatchupReport>> {
  const outputDirectory = options.outputDirectory ?? "exports/tessera";
  const configuration = analysisConfiguration(options);
  const simulationRequested =
    options.executionMode !== undefined
      ? options.executionMode === "simulate"
      : options.experimental === true;
  let profilePolicy: ProfilePolicyV1 | null;
  try {
    profilePolicy = await requestedAnalysisProfilePolicy(options);
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_PROFILE_POLICY_INVALID",
          message:
            error instanceof Error
              ? error.message
              : "The requested profile policy could not be read.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const playerValidation = validateRoster(playerRoster);
  if (!playerValidation.ok) {
    return {
      ok: false,
      data: null,
      violations: playerValidation.violations,
      warnings: playerValidation.warnings,
    };
  }
  if (opponent.kind === "roster") {
    const opponentValidation = validateRoster(opponent.roster);
    if (!opponentValidation.ok) {
      return {
        ok: false,
        data: null,
        violations: opponentValidation.violations,
        warnings: opponentValidation.warnings,
      };
    }
    const preflightPoints = pointsComparison(
      playerRoster.totalPoints,
      opponent.roster.totalPoints,
      playerRoster.pointsLimit,
      configuration.pointsTolerancePercent,
    );
    if (!preflightPoints.matched && !configuration.allowPointMismatch) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_POINTS_MISMATCH",
            message: pointsMismatchMessage(preflightPoints),
            severity: "error",
          },
        ],
        warnings: [
          ...playerValidation.warnings,
          ...opponentValidation.warnings,
        ],
      };
    }
  }
  let factionProxyItems: Array<
    TesseraStressPortfolioItem & { roster: RosterDraftV1 }
  > = [];
  if (opponent.kind === "faction-archetypes") {
    const generated = generateFactionStressPortfolio({
      faction: opponent.factionId,
      pointsLimit: playerRoster.pointsLimit,
      suite: "core-3",
      pointsTolerancePercent: configuration.pointsTolerancePercent,
      allowLegends: false,
    });
    if (!generated.ok || !generated.data) {
      return {
        ok: false,
        data: null,
        violations: generated.violations,
        warnings: generated.warnings,
      };
    }
    const requested = new Set(
      opponent.archetypes?.length
        ? opponent.archetypes
        : (Object.keys(ARCHETYPE_PREFERENCES) as TesseraArchetype[]),
    );
    factionProxyItems = generated.data.items.filter(
      (
        item,
      ): item is TesseraStressPortfolioItem & {
        roster: RosterDraftV1;
      } =>
        item.status === "ready" &&
        item.roster !== null &&
        requested.has(item.posture),
    );
    if (factionProxyItems.length === 0) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "NO_OPPONENTS_PREPARED",
            message:
              "The shared faction portfolio generator produced no requested, exportable opponent proxies.",
            severity: "error",
          },
        ],
        warnings: generated.warnings,
      };
    }
  }
  const profileRequirements = aggregateProfileRequirements([
    playerRoster,
    ...(opponent.kind === "roster" ? [opponent.roster] : []),
    ...(opponent.kind === "rosz" && options.opponentRosterContext
      ? [options.opponentRosterContext]
      : []),
    ...factionProxyItems.map((item) => item.roster),
  ]);
  const profileValidation = validateProfilePolicy(
    profileRequirements,
    profilePolicy,
  );
  const enforceProfilePolicy =
    simulationRequested &&
    (
      options.executionMode === "simulate" ||
      options.profilePolicy !== undefined ||
      options.profilePolicyPath !== undefined
    );
  if (enforceProfilePolicy && !profileValidation.valid) {
    let scaffoldPath: string | null = null;
    try {
      scaffoldPath = await writeExportArtifact(
        {
          format: "roster-json",
          filename: "profile-policy.scaffold.json",
          mimeType: "application/json",
          encoding: "utf8",
          content: `${JSON.stringify(
            profilePolicyScaffold(profileRequirements),
            null,
            2,
          )}\n`,
        },
        path.join(outputDirectory, "profile-policy.scaffold.json"),
        options,
      );
    } catch {
      // The validation error remains actionable without a written scaffold.
    }
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_PROFILE_POLICY_REQUIRED",
          message: `Explicit weapon-profile choices are required before New Recruit or Tessera activity.${
            scaffoldPath ? ` Complete ${scaffoldPath}.` : ""
          }`,
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const player = await prepareRosterForTessera(
    playerRoster,
    { ...options, outputDirectory: path.join(outputDirectory, "player") },
    dependencies,
  );
  if (!player.ok || !player.data) {
    return {
      ok: false,
      data: player.data
        ? failedPreparationReport({
            playerRoster,
            player: player.data,
            simulationRequested,
            configuration,
            profilePolicy,
            violations: player.violations,
            warnings: player.warnings,
          })
        : null,
      violations: player.violations,
      warnings: player.warnings,
    };
  }
  const preparedPlayer = player.data;

  const opponents: TesseraMatchupReport["opponents"] = [];
  const opponentDrafts: Array<RosterDraftV1 | null> = [];
  const warnings: string[] = player.warnings.map((warning) => warning.message);
  if (opponent.kind === "roster") {
    const prepared = await prepareRosterForTessera(
      opponent.roster,
      { ...options, outputDirectory: path.join(outputDirectory, "opponent") },
      dependencies,
    );
    if (!prepared.ok || !prepared.data) {
      const preparedOpponent = prepared.data
        ? [
            {
              kind: "roster" as const,
              rosterName: prepared.data.rosterName,
              enrichedRoszPath: prepared.data.enrichedRoszPath,
              summary: prepared.data.summary,
              fingerprint: rosterFingerprint(opponent.roster),
              units: canonicalUnits(opponent.roster, "opponent"),
              cacheReused: prepared.data.cacheReused,
              connectorEvents: prepared.data.connectorEvents,
              catalogueProvenance: prepared.data.catalogueProvenance,
            },
          ]
        : [];
      return {
        ok: false,
        data: failedPreparationReport({
          playerRoster,
          player: preparedPlayer,
          opponents: preparedOpponent,
          simulationRequested,
          configuration,
          profilePolicy,
          violations: prepared.violations,
          warnings: [...player.warnings, ...prepared.warnings],
          opponentName:
            prepared.data?.rosterName ?? opponent.roster.name,
        }),
        violations: prepared.violations,
        warnings: [...player.warnings, ...prepared.warnings],
      };
    }
    opponents.push({
      kind: "roster",
      rosterName: prepared.data.rosterName,
      enrichedRoszPath: prepared.data.enrichedRoszPath,
      summary: prepared.data.summary,
      fingerprint: rosterFingerprint(opponent.roster),
      units: canonicalUnits(opponent.roster, "opponent"),
      cacheReused: prepared.data.cacheReused,
      connectorEvents: prepared.data.connectorEvents,
      catalogueProvenance: prepared.data.catalogueProvenance,
    });
    opponentDrafts.push(opponent.roster);
  } else if (opponent.kind === "rosz") {
    const prepared = await prepareUploadedRosz(
      opponent.path,
      path.join(outputDirectory, "opponent"),
      options,
      dependencies,
    );
    if (!prepared.ok || !prepared.data) {
      return {
        ok: false,
        data: failedPreparationReport({
          playerRoster,
          player: preparedPlayer,
          opponents,
          simulationRequested,
          configuration,
          profilePolicy,
          violations: prepared.violations,
          warnings: [...player.warnings, ...prepared.warnings],
          opponentName: path.basename(opponent.path),
        }),
        violations: prepared.violations,
        warnings: [...player.warnings, ...prepared.warnings],
      };
    }
    opponents.push({
      kind: "rosz",
      rosterName: prepared.data.rosterName,
      enrichedRoszPath: prepared.data.enrichedRoszPath,
      summary: prepared.data.summary,
      fingerprint: summaryFingerprint(prepared.data.summary),
      units: enrichedUnits(prepared.data.summary, "opponent"),
      cacheReused: false,
    });
    opponentDrafts.push(options.opponentRosterContext ?? null);
  } else {
    for (const item of factionProxyItems) {
      const prepared = await prepareRosterForTessera(
        item.roster,
        {
          ...options,
          outputDirectory: path.join(
            outputDirectory,
            "opponents",
            item.templateId.replace(":", "-"),
          ),
        },
        dependencies,
      );
      if (!prepared.ok || !prepared.data) {
        const preparedOpponent = prepared.data
          ? [
              {
                kind: "faction-archetype" as const,
                archetype: item.posture,
                rosterName: prepared.data.rosterName,
                enrichedRoszPath: prepared.data.enrichedRoszPath,
                summary: prepared.data.summary,
                fingerprint:
                  item.simulationFingerprint ??
                  rosterExecutionFingerprint(item.roster),
                units: canonicalUnits(item.roster, "opponent"),
                cacheReused: prepared.data.cacheReused,
                connectorEvents: prepared.data.connectorEvents,
                catalogueProvenance:
                  prepared.data.catalogueProvenance,
              },
            ]
          : [];
        return {
          ok: false,
          data: failedPreparationReport({
            playerRoster,
            player: preparedPlayer,
            opponents: [...opponents, ...preparedOpponent],
            simulationRequested,
            configuration,
            profilePolicy,
            violations: prepared.violations,
            warnings: [...player.warnings, ...prepared.warnings],
            opponentName:
              prepared.data?.rosterName ?? item.roster.name,
          }),
          violations: prepared.violations,
          warnings: [...player.warnings, ...prepared.warnings],
        };
      }
      opponents.push({
        kind: "faction-archetype",
        archetype: item.posture,
        rosterName: prepared.data.rosterName,
        enrichedRoszPath: prepared.data.enrichedRoszPath,
        summary: prepared.data.summary,
        fingerprint:
          item.simulationFingerprint ??
          rosterExecutionFingerprint(item.roster),
        units: canonicalUnits(item.roster, "opponent"),
        cacheReused: prepared.data.cacheReused,
        connectorEvents: prepared.data.connectorEvents,
        catalogueProvenance: prepared.data.catalogueProvenance,
      });
      opponentDrafts.push(item.roster);
    }
  }
  if (opponents.length === 0) {
    const violation: RosterIssue = {
      code: "NO_OPPONENTS_PREPARED",
      message: "No opponent roster could be prepared for Tessera.",
      severity: "error",
    };
    return {
      ok: false,
      data: failedPreparationReport({
        playerRoster,
        player: preparedPlayer,
        simulationRequested,
        configuration,
        profilePolicy,
        violations: [violation],
        warnings: player.warnings,
      }),
      violations: [violation],
      warnings: player.warnings,
    };
  }

  const pointsComparisons = opponents.map((prepared) =>
    pointsComparison(
      preparedPlayer.summary.totalPoints,
      prepared.summary.totalPoints,
      playerRoster.pointsLimit,
      configuration.pointsTolerancePercent,
    ),
  );
  const unmatchedIndexes = pointsComparisons
    .map((comparison, index) => (comparison.matched ? -1 : index))
    .filter((index) => index >= 0);
  if (unmatchedIndexes.length && !configuration.allowPointMismatch) {
    if (opponent.kind !== "faction-archetypes") {
      const comparison = pointsComparisons[unmatchedIndexes[0]];
      const violation: RosterIssue = {
        code: "TESSERA_POINTS_MISMATCH",
        message: pointsMismatchMessage(comparison),
        severity: "error",
      };
      return {
        ok: false,
        data: failedPreparationReport({
          playerRoster,
          player: preparedPlayer,
          opponents,
          simulationRequested,
          configuration,
          profilePolicy,
          violations: [violation],
          warnings: player.warnings,
          opponentName:
            opponents[unmatchedIndexes[0]]?.rosterName ?? null,
        }),
        violations: [violation],
        warnings: player.warnings,
      };
    }
    for (const index of [...unmatchedIndexes].sort((a, b) => b - a)) {
      warnings.push(
        `${opponents[index].rosterName} was omitted because its ${opponents[index].summary.totalPoints}-point total is outside the ${configuration.pointsTolerancePercent}% tolerance.`,
      );
      opponents.splice(index, 1);
      opponentDrafts.splice(index, 1);
      pointsComparisons.splice(index, 1);
    }
    if (opponents.length === 0) {
      const violation: RosterIssue = {
        code: "TESSERA_POINTS_MISMATCH",
        message:
          "No generated faction archetype was within the matched-points tolerance.",
        severity: "error",
      };
      return {
        ok: false,
        data: failedPreparationReport({
          playerRoster,
          player: preparedPlayer,
          simulationRequested,
          configuration,
          profilePolicy,
          violations: [violation],
          warnings: player.warnings,
        }),
        violations: [violation],
        warnings: player.warnings,
      };
    }
  }

  const matrices: TesseraMatchupReport["simulation"]["matrices"] = [];
  const scenarios: TesseraScenarioResult[] = [];
  const settings: Record<string, string> = {};
  const failures: NonNullable<TesseraMatchupReport["failures"]> = [];
  const simulationConnectorEvents: ConnectorEvent[] = [];
  const tesseraUiIdentities = new Set<string>();
  let legacyProjection:
    | NonNullable<
        TesseraMatchupReport["simulation"]["legacyProjection"]
      >
    | undefined;
  let captureIntegrityClean = true;
  if (simulationRequested) {
    for (const prepared of opponents) {
      const profileDirectory = await mkdtemp(
        path.join(os.tmpdir(), "rosterpilot-tessera-"),
      );
      try {
        const result: TesseraBrowserResult = await (
          dependencies.runBrowser ?? runTesseraViaAgent
        )({
          profileDirectory,
          playerRoszPath: preparedPlayer.enrichedRoszPath,
          playerName: preparedPlayer.rosterName,
          opponentRoszPath: prepared.enrichedRoszPath,
          opponentName: prepared.rosterName,
          analysisMode: configuration.analysisMode,
          phases: configuration.phases,
          metrics: configuration.metrics,
          profilePolicy,
          frozenScenarioContract: options.frozenScenarioContract,
          sessionId: options.sessionId,
        });
        Object.assign(settings, result.settings);
        if (result.legacyProjection) {
          legacyProjection =
            !legacyProjection ||
            (legacyProjection.status === "derived" &&
              result.legacyProjection.status === "derived" &&
              legacyProjection.phase === result.legacyProjection.phase &&
              legacyProjection.metric === result.legacyProjection.metric)
              ? {
                  ...result.legacyProjection,
                  scenarioIds: [
                    ...new Set([
                      ...(legacyProjection?.scenarioIds ?? []),
                      ...result.legacyProjection.scenarioIds,
                    ]),
                  ],
                }
              : {
                  status: "unavailable",
                  phase: null,
                  metric: null,
                  scenarioIds: [],
                };
        }
        if (result.uiIdentity) tesseraUiIdentities.add(result.uiIdentity);
        warnings.push(...result.warnings);
        if ((result.integrityIssues?.length ?? 0) > 0) {
          captureIntegrityClean = false;
          for (const integrityIssue of result.integrityIssues ?? []) {
            failures.push({
              stage: "simulation",
              code: integrityIssue.code,
              message: integrityIssue.message,
              opponentName: prepared.rosterName,
              retryable: false,
            });
          }
        }
        matrices.push({
          opponentName: prepared.rosterName,
          cells: result.cells,
        });
        scenarios.push(
          ...consolidateBrowserScenarios(
            result,
            preparedPlayer.units ?? canonicalUnits(playerRoster, "player"),
            prepared.units ??
              enrichedUnits(prepared.summary, "opponent"),
            prepared.rosterName,
            configuration,
          ),
        );
        simulationConnectorEvents.push({
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          recordedAt: new Date().toISOString(),
          provider: "tessera",
          action: "simulate",
          origin: "new-remote",
          outcome: "verified",
          remoteId: null,
          contentSha256: crypto
            .createHash("sha256")
            .update(
              result.scenarios
                .map((scenario) => scenario.matrixSha256 ?? "")
                .join("|"),
            )
            .digest("hex"),
        });
      } catch (error) {
        const errorCode =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "TESSERA_COMPANION_FAILED";
        warnings.push(
          `[${errorCode}] Experimental Tessera analysis failed for ${prepared.rosterName}: ${
            error instanceof Error ? error.message : "unknown browser failure"
          }`,
        );
        failures.push({
          stage: "simulation",
          code: errorCode,
          message:
            error instanceof Error
              ? error.message
              : "Unknown Tessera browser failure.",
          opponentName: prepared.rosterName,
          retryable:
            /TIMEOUT|SESSION|NAVIGATION|STALE|LIST_SELECTION/.test(
              errorCode,
            ),
        });
        simulationConnectorEvents.push({
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          recordedAt: new Date().toISOString(),
          provider: "tessera",
          action: "simulate",
          origin: "new-remote",
          outcome: "uncertain",
          remoteId: null,
          contentSha256: null,
        });
      } finally {
        await rm(profileDirectory, { recursive: true, force: true });
      }
    }
  }

  const allMatched = pointsComparisons.every((comparison) => comparison.matched);
  const expectedScenarioCount =
    opponents.length *
    configuration.phases.length *
    configuration.directions.length;
  const scenariosComplete =
    scenarios.length === expectedScenarioCount &&
    scenarios.every((scenario) => scenario.status === "complete");
  const analyticalClaimsAllowed =
    simulationRequested &&
    matrices.length === opponents.length &&
    captureIntegrityClean &&
    scenariosComplete;
  const findings = analyticalClaimsAllowed
    ? structuredFindings(scenarios)
    : [];
  const legacy = legacyFindingText(findings);
  if (simulationRequested && !analyticalClaimsAllowed) {
    warnings.push(
      "Substantive matchup findings and roster-change candidates were suppressed because the required capture evidence was incomplete or failed matrix-integrity checks.",
    );
  }
  const proposedChanges =
    analyticalClaimsAllowed &&
    configuration.includeChangeCandidates &&
    allMatched
      ? await changeCandidates(playerRoster, findings)
      : [];
  const runId = crypto.randomUUID();
  const basename = `${safeName(playerRoster.name) || "roster"}-matchup`;
  const baselineArtifactName =
    `${basename}-baseline-damage-v1.json`;
  const supplementalAnalyses: NonNullable<
    TesseraMatchupReport["supplementalAnalyses"]
  > = [];
  if (options.fallbackMode === "baseline-damage-v1") {
    for (const [index, prepared] of opponents.entries()) {
      const opponentDraft = opponentDrafts[index];
      if (!opponentDraft) {
        supplementalAnalyses.push({
          engine: "baseline-damage-v1",
          status: "unavailable",
          opponentName: prepared.rosterName,
          artifact: baselineArtifactName,
          assumptions: {
            scope: "unit-to-unit-expected-damage",
            range:
              "Ranged attacks use 18 inches with half-range bonuses disabled; melee uses 1 inch.",
            cover: false,
            charge: true,
            abilities:
              "Pinned faction, detachment, unit, and intrinsic weapon effects supported by the canonical engine.",
            attachments:
              "Leaders, bodyguards, activatable resources, and stratagem timing are not modeled.",
            profilePolicyHash: profilePolicy
              ? profilePolicyHash(profilePolicy)
              : null,
          },
          cells: [],
          warnings: [
            "The baseline requires a canonical roster draft; an uploaded ROSZ alone is insufficient.",
          ],
        });
        continue;
      }
      try {
        const cells = baselineDamageCells(
          playerRoster,
          opponentDraft,
          profilePolicy,
        );
        supplementalAnalyses.push({
          engine: "baseline-damage-v1",
          status: cells.length > 0 ? "complete" : "unavailable",
          opponentName: prepared.rosterName,
          artifact: baselineArtifactName,
          assumptions: {
            scope: "unit-to-unit-expected-damage",
            range:
              "Ranged attacks use 18 inches with half-range bonuses disabled; melee uses 1 inch.",
            cover: false,
            charge: true,
            abilities:
              "Pinned faction, detachment, unit, and intrinsic weapon effects supported by the canonical engine.",
            attachments:
              "Leaders, bodyguards, activatable resources, and stratagem timing are not modeled.",
            profilePolicyHash: profilePolicy
              ? profilePolicyHash(profilePolicy)
              : null,
          },
          cells,
          warnings:
            cells.length > 0
              ? []
              : [
                  "No canonical unit-to-unit damage cells could be resolved.",
                ],
        });
      } catch (error) {
        supplementalAnalyses.push({
          engine: "baseline-damage-v1",
          status: "unavailable",
          opponentName: prepared.rosterName,
          artifact: baselineArtifactName,
          assumptions: {
            scope: "unit-to-unit-expected-damage",
            range:
              "Ranged attacks use 18 inches with half-range bonuses disabled; melee uses 1 inch.",
            cover: false,
            charge: true,
            abilities:
              "Pinned faction, detachment, unit, and intrinsic weapon effects supported by the canonical engine.",
            attachments:
              "Leaders, bodyguards, activatable resources, and stratagem timing are not modeled.",
            profilePolicyHash: profilePolicy
              ? profilePolicyHash(profilePolicy)
              : null,
          },
          cells: [],
          warnings: [
            error instanceof Error
              ? error.message
              : "The deterministic damage baseline failed.",
          ],
        });
      }
    }
  }
  const simulationStatus: NonNullable<
    TesseraMatchupReport["simulation"]["status"]
  > = !simulationRequested
    ? "not-requested"
    : analyticalClaimsAllowed
      ? "complete"
      : matrices.length > 0
        ? "partial"
        : "failed";
  if (
    simulationRequested &&
    !analyticalClaimsAllowed &&
    failures.length === 0
  ) {
    const preservedBrowserCode = warnings
      .flatMap((warning) => [
        warning.match(/\[(TESSERA_[A-Z0-9_]+)\]/)?.[1] ?? null,
      ])
      .find(
        (code): code is string =>
          code !== null &&
          code !== "TESSERA_PROFILE_POLICY_APPLIED",
      );
    failures.push({
      stage: "simulation",
      code: preservedBrowserCode ?? "TESSERA_EVIDENCE_INCOMPLETE",
      message:
        "Tessera did not produce the complete trusted matrix and scenario set required for analytical findings.",
      opponentName: null,
      retryable: true,
    });
  }
  const cacheReuses =
    Number(preparedPlayer.cacheReused === true) +
    opponents.filter((prepared) => prepared.cacheReused === true).length;
  const preparationConnectorEvents = [
    ...(preparedPlayer.connectorEvents ?? []),
    ...opponents.flatMap(
      (prepared) => prepared.connectorEvents ?? [],
    ),
  ];
  const report: TesseraMatchupReport = {
    schemaVersion: 3,
    runId,
    generatedAt: new Date().toISOString(),
    source: !simulationRequested
      ? "prepare-only"
      : matrices.length
        ? "tessera-ui"
        : "tessera-ui-failed",
    status: !simulationRequested
      ? "prepared"
      : analyticalClaimsAllowed
        ? "complete"
        : matrices.length > 0
          ? "inconclusive"
          : "failed",
    preparation: {
      status: "complete",
      source: "new-recruit",
      uniqueRosters: 1 + opponents.length,
      remoteMutations: 1 + opponents.length - cacheReuses,
      cacheReuses,
      connectorEvents: preparationConnectorEvents,
    },
    failures,
    profilePolicyHash: profilePolicy
      ? profilePolicyHash(profilePolicy)
      : null,
    runtime: getRuntimeProvenance(),
    tesseraUiIdentity:
      tesseraUiIdentities.size === 0
        ? null
        : tesseraUiIdentities.size === 1
          ? [...tesseraUiIdentities][0]
          : crypto
              .createHash("sha256")
              .update([...tesseraUiIdentities].sort().join("|"))
              .digest("hex"),
    connectorEvents: [
      ...preparationConnectorEvents,
      ...simulationConnectorEvents,
    ],
    pinnedData: playerRoster.sourceData,
    comparisonClass: allMatched ? "matched" : "unmatched",
    configuration,
    pointsComparisons,
    player: preparedPlayer,
    opponents,
    simulation: {
      requested: simulationRequested,
      executionMode: simulationRequested
        ? "simulate"
        : "prepare-only",
      experimental: true,
      status: simulationStatus,
      engine: "tessera-ui",
      settings,
      legacyProjection:
        legacyProjection ?? {
          status: "unavailable",
          phase: null,
          metric: null,
          scenarioIds: [],
        },
      matrices,
      scenarios,
    },
    strengths: legacy.strengths,
    weaknesses: legacy.weaknesses,
    suggestions: legacy.suggestions,
    findings,
    changeCandidates: proposedChanges,
    limitations: [
      "This is directional combat math, not a game win probability.",
      "Movement, terrain geometry, missions, scoring, deployment, sequencing, player decisions, and unmodeled stratagems are excluded.",
      "Faction archetypes are deterministic proxies, not current tournament-meta lists.",
    ],
    warnings: [...new Set(warnings)],
    supplementalAnalyses,
    artifacts: [],
  };
  try {
    const portableArtifacts: TesseraMatchupReport["artifacts"] = [
      {
        format: "matchup-json",
        written: `${basename}.json`,
      },
      {
        format: "matchup-html",
        written: `${basename}.html`,
      },
      ...(options.fallbackMode === "baseline-damage-v1"
        ? [
            {
              format: "baseline-json" as const,
              written: baselineArtifactName,
            },
          ]
        : []),
    ];
    const portableReport: TesseraMatchupReport = {
      ...report,
      artifacts: portableArtifacts,
    };
    const artifacts: ExportArtifact[] = [
      {
        format: "roster-json",
        filename: `${basename}.json`,
        mimeType: "application/json",
        encoding: "utf8",
        content: `${JSON.stringify(portableReport, null, 2)}\n`,
      },
      {
        format: "html",
        filename: `${basename}.html`,
        mimeType: "text/html; charset=utf-8",
        encoding: "utf8",
        content: renderTesseraMatchupReportHtml(portableReport),
      },
      ...(options.fallbackMode === "baseline-damage-v1"
        ? [
            {
              format: "roster-json" as const,
              filename: baselineArtifactName,
              mimeType: "application/json",
              encoding: "utf8" as const,
              content: `${JSON.stringify(
                {
                  schemaVersion: 1,
                  engine: "baseline-damage-v1",
                  runId,
                  generatedAt: report.generatedAt,
                  sourceData: playerRoster.sourceData,
                  analyses: supplementalAnalyses,
                  limitation:
                    "Unit-to-unit expected damage only; this does not estimate game win probability.",
                },
                null,
                2,
              )}\n`,
            },
          ]
        : []),
    ];
    const written = await writeExportArtifacts(
      artifacts,
      outputDirectory,
      options,
    );
    report.artifacts = portableArtifacts.map((artifact, index) => ({
      ...artifact,
      written: written[index],
    }));
  } catch (error) {
    return {
      ok: false,
      data: report,
      violations: [
        {
          code: "WRITE_FAILED",
          message: error instanceof Error ? error.message : "Report write failed.",
          severity: "error",
        },
      ],
      warnings: player.warnings,
    };
  }
  const successful = !simulationRequested || analyticalClaimsAllowed;
  return {
    ok: successful,
    data: report,
    violations: successful
      ? []
      : failures.map((failure) => ({
          code: failure.code,
          message: failure.message,
          severity: "error" as const,
        })),
    warnings: report.warnings.map((message) => ({
      code: "TESSERA_WARNING",
      message,
      severity: "warn",
    })),
  };
}

function metricValue(
  values: TesseraMetricValues,
  metric: TesseraMetric,
): number | null {
  return values[metricField(metric)] ?? null;
}

function revisionDeltas(
  baseline: TesseraMatchupReport,
  revisedReports: TesseraMatchupReport[],
): TesseraRevisionDelta[] {
  const baselineScenarios = baseline.simulation.scenarios ?? [];
  const baselineCells = new Map<
    string,
    {
      opponentName: string;
      phase: TesseraPhase;
      metric: TesseraMetric;
      direction: TesseraDirection;
      attackerInstanceId: string;
      targetInstanceId: string;
      value: number | null;
      confidence: TesseraConfidence;
    }
  >();
  for (const scenario of baselineScenarios) {
    for (const cell of scenario.cells) {
      for (const metric of scenario.metrics) {
        baselineCells.set(
          [
            scenario.opponentName,
            scenario.phase,
            scenario.direction,
            cell.attacker.instanceId,
            cell.target.instanceId,
            metric,
          ].join("|"),
          {
            opponentName: scenario.opponentName,
            phase: scenario.phase,
            metric,
            direction: scenario.direction,
            attackerInstanceId: cell.attacker.instanceId,
            targetInstanceId: cell.target.instanceId,
            value: metricValue(cell.values, metric),
            confidence: cell.confidence,
          },
        );
      }
    }
  }

  const deltas: TesseraRevisionDelta[] = [];
  const comparedKeys = new Set<string>();
  for (const report of revisedReports) {
    for (const scenario of report.simulation.scenarios ?? []) {
      for (const cell of scenario.cells) {
        for (const metric of scenario.metrics) {
          const key = [
            scenario.opponentName,
            scenario.phase,
            scenario.direction,
            cell.attacker.instanceId,
            cell.target.instanceId,
            metric,
          ].join("|");
          comparedKeys.add(key);
          const before = baselineCells.get(key);
          const after = metricValue(cell.values, metric);
          const ambiguous =
            !before ||
            before.value === null ||
            after === null ||
            before.confidence === "ambiguous" ||
            cell.confidence === "ambiguous";
          const change =
            ambiguous || before.value === null || after === null
              ? null
              : after - before.value;
          let classification: TesseraRevisionDelta["classification"] =
            "ambiguous";
          if (!ambiguous && change !== null) {
            const directionalChange =
              scenario.direction === "player-to-opponent" ? change : -change;
            classification =
              Math.abs(directionalChange) < 0.01
                ? "unchanged"
                : directionalChange > 0
                  ? "improved"
                  : "worsened";
          }
          deltas.push({
            opponentName: scenario.opponentName,
            phase: scenario.phase,
            metric,
            direction: scenario.direction,
            attackerInstanceId: cell.attacker.instanceId,
            targetInstanceId: cell.target.instanceId,
            before: before?.value ?? null,
            after,
            change,
            classification,
          });
        }
      }
    }
  }
  for (const [key, before] of baselineCells) {
    if (comparedKeys.has(key)) continue;
    deltas.push({
      opponentName: before.opponentName,
      phase: before.phase,
      metric: before.metric,
      direction: before.direction,
      attackerInstanceId: before.attackerInstanceId,
      targetInstanceId: before.targetInstanceId,
      before: before.value,
      after: null,
      change: null,
      classification: "ambiguous",
    });
  }
  return deltas;
}

export async function compareRosterRevision(
  baselineReportPath: string,
  revisedRoster: RosterDraftV1,
  options: TesseraAnalysisOptions = {},
  dependencies: TesseraDependencies = {},
): Promise<ResultEnvelope<TesseraRevisionComparisonReport>> {
  let baseline: TesseraMatchupReport;
  try {
    baseline = JSON.parse(
      await readFile(baselineReportPath, "utf8"),
    ) as TesseraMatchupReport;
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_UNREADABLE",
          message:
            error instanceof Error
              ? error.message
              : "The baseline matchup report could not be read.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const baselineScenarios = baseline.simulation?.scenarios ?? [];
  if (
    ![2, 3].includes(baseline.schemaVersion ?? 0) ||
    !baseline.runId ||
    !baseline.configuration ||
    !Array.isArray(baseline.opponents) ||
    baseline.opponents.length === 0 ||
    !baseline.simulation ||
    !Array.isArray(baselineScenarios) ||
    baselineScenarios.length === 0
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_INCOMPATIBLE",
          message:
            "Revision comparison requires a complete schema-v2 or schema-v3 baseline with captured scenarios.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const expectedBaselineScenarios =
    baseline.opponents.length *
    baseline.configuration.phases.length *
    baseline.configuration.directions.length;
  if (
    baseline.status !== "complete" ||
    baseline.source !== "tessera-ui" ||
    baselineScenarios.length !== expectedBaselineScenarios ||
    baselineScenarios.some((scenario) => scenario.status !== "complete")
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_INCOMPLETE",
          message:
            "Revision comparison requires a complete Tessera baseline with every requested phase and direction captured.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const validation = validateRoster(revisedRoster);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }
  if (
    baseline.player.factionId &&
    revisedRoster.factionId !== baseline.player.factionId
  ) {
    const sameFactionName = baseline.player.summary.factionName
      .toLocaleLowerCase()
      .includes(revisedRoster.factionName.toLocaleLowerCase());
    if (!sameFactionName) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_REVISION_FACTION_CHANGED",
            message:
              "The revised roster must use the same faction as the baseline.",
            severity: "error",
          },
        ],
        warnings: validation.warnings,
      };
    }
  }
  if (options.experimental !== true) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_REVISION_SIMULATION_REQUIRED",
          message:
            "Revision comparison must rerun Tessera. Enable experimental local browser analysis for this approved comparison.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }

  const outputDirectory =
    options.outputDirectory ??
    path.join(path.dirname(baselineReportPath), "revision");
  const revisedReports: TesseraMatchupReport[] = [];
  let reusablePlayer: TesseraPreparedRoster | null = null;
  for (const [index, opponent] of baseline.opponents.entries()) {
    const runDependencies: TesseraDependencies =
      reusablePlayer === null
        ? dependencies
        : {
          ...dependencies,
          deliver: async () => ({
            ok: true,
            data: {
              rosterId: revisedRoster.id,
              rosterName: revisedRoster.name,
              listUrl: reusablePlayer!.listUrl,
              imported: true,
              sessionReused: true,
              verification: {
                name: true,
                faction: true,
                points: true,
                units: revisedRoster.units.map((unit) => ({
                  name: unit.name,
                  modelCount: unit.modelCount,
                  matched: true,
                })),
                mismatches: [],
              },
              enrichedSummary: reusablePlayer!.summary,
              artifacts: [
                {
                  format: "rosterpilot-source-rosz",
                  filename: path.basename(reusablePlayer!.sourceRoszPath),
                  mimeType: "application/zip",
                  written: reusablePlayer!.sourceRoszPath,
                },
                {
                  format: "new-recruit-enriched-rosz",
                  filename: path.basename(reusablePlayer!.enrichedRoszPath),
                  mimeType: "application/zip",
                  written: reusablePlayer!.enrichedRoszPath,
                },
              ],
            },
            violations: [],
            warnings: [],
          }),
        };
    const revised = await analyzeRosterMatchup(
      revisedRoster,
      { kind: "rosz", path: opponent.enrichedRoszPath },
      {
        ...options,
        outputDirectory: path.join(
          outputDirectory,
          `opponent-${index + 1}-${safeName(opponent.rosterName)}`,
        ),
        analysisMode: baseline.configuration.analysisMode,
        phases: baseline.configuration.phases,
        metrics: baseline.configuration.metrics,
        allowPointMismatch: baseline.configuration.allowPointMismatch,
        includeChangeCandidates: false,
      },
      {
        ...runDependencies,
      },
    );
    if (!revised.ok || !revised.data) {
      return {
        ok: false,
        data: null,
        violations: revised.violations,
        warnings: revised.warnings,
      };
    }
    reusablePlayer ??= revised.data.player;
    revisedReports.push(revised.data);
  }

  const deltas = revisionDeltas(baseline, revisedReports);
  const summary = {
    improved: deltas.filter((delta) => delta.classification === "improved")
      .length,
    worsened: deltas.filter((delta) => delta.classification === "worsened")
      .length,
    unchanged: deltas.filter((delta) => delta.classification === "unchanged")
      .length,
    ambiguous: deltas.filter((delta) => delta.classification === "ambiguous")
      .length,
  };
  const report: TesseraRevisionComparisonReport = {
    schemaVersion: 2,
    runId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    baselineReportPath,
    baselineRunId: baseline.runId,
    revisedRosterFingerprint: rosterFingerprint(revisedRoster),
    revisedReports,
    deltas,
    summary,
    limitations: [
      "This comparison measures changes in directional combat math, not game win probability.",
      ...baseline.limitations,
    ],
    warnings: [
      ...new Set(revisedReports.flatMap((item) => item.warnings)),
    ],
    artifacts: [],
  };
  const basename = `${safeName(revisedRoster.name) || "roster"}-revision`;
  try {
    const written = await writeExportArtifacts(
      [
        {
          format: "roster-json",
          filename: `${basename}.json`,
          mimeType: "application/json",
          encoding: "utf8",
          content: `${JSON.stringify(report, null, 2)}\n`,
        },
        {
          format: "html",
          filename: `${basename}.html`,
          mimeType: "text/html; charset=utf-8",
          encoding: "utf8",
          content: renderTesseraRevisionComparisonHtml(report),
        },
      ],
      outputDirectory,
      options,
    );
    report.artifacts = [
      { format: "revision-json", written: written[0] },
      { format: "revision-html", written: written[1] },
    ];
  } catch (error) {
    return {
      ok: false,
      data: report,
      violations: [
        {
          code: "WRITE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Revision report write failed.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  return {
    ok: true,
    data: report,
    violations: [],
    warnings: report.warnings.map((message) => ({
      code: "TESSERA_WARNING",
      message,
      severity: "warn",
    })),
  };
}
