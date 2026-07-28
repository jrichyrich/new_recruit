import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  buildRoster,
  inspectEnrichedRosz,
  modifyRoster,
  searchUnits,
  validateRoster,
  type EnrichedRoszSummary,
  type ModifyRosterOperation,
  type ResultEnvelope,
  type RosterDraftV1,
  type TesseraArchetype,
  type TesseraAnalysisConfiguration,
  type TesseraChangeCandidate,
  type TesseraConfidence,
  type TesseraConnectionStatus,
  type TesseraDirection,
  type TesseraFinding,
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
  renderTesseraMatchupReportHtml,
  renderTesseraRevisionComparisonHtml,
} from "./report";

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
  experimental?: boolean;
  analysisMode?: "quick" | "full";
  phases?: TesseraPhase[];
  metrics?: TesseraMetric[];
  allowPointMismatch?: boolean;
  includeChangeCandidates?: boolean;
};

type TesseraDependencies = {
  deliver?: typeof deliverRosterToNewRecruit;
  enrich?: typeof enrichRoszThroughNewRecruit;
  runBrowser?: typeof runTesseraBrowserMatchup;
};

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
  const available =
    process.platform === "darwin" &&
    browserAvailable &&
    agentStatus?.available === true &&
    agentStatus.protocolCompatible &&
    installationCurrent &&
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
  const delivery = await (dependencies.deliver ?? deliverRosterToNewRecruit)(
    roster,
    {
      ...options,
      downloadEnrichedRosz: true,
      downloadPrettyHtml: false,
      outputDirectory: options.outputDirectory ?? "exports/tessera",
    },
  );
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
  return {
    ok: true,
    data: {
      rosterId: roster.id,
      rosterName: roster.name,
      factionId: roster.factionId,
      listUrl: delivery.data.listUrl,
      sourceRoszPath: source.written,
      enrichedRoszPath: enriched.written,
      summary: delivery.data.enrichedSummary,
      fingerprint: rosterFingerprint(roster),
      units: canonicalUnits(roster, "player"),
    },
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

function warningConfidence(warnings: string[]): TesseraConfidence {
  if (warnings.some((warning) => /alternate profile|ambiguous/i.test(warning))) {
    return "ambiguous";
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
        iterations: raw.iterations ?? null,
        settings: raw.settings ?? {},
        values: new Map<string, TesseraScenarioCell>(),
        warnings: [],
      };
    group.metrics.add(metric);
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
    const confidence = warningConfidence(attackerImportWarnings);
    const warningRefs = [
      ...attackerImportWarnings.map(
        (warning) => `Attacker import: ${warning}`,
      ),
      ...targetImportWarnings.map((warning) => `Target import: ${warning}`),
    ];
    for (const rawCell of raw.cells) {
      const attacker = attackers[rawCell.attackerIndex];
      const target = targets[rawCell.targetIndex];
      if (!attacker || !target) {
        group.warnings.push(
          `Tessera returned an out-of-range ${direction} cell at ${rawCell.attackerIndex},${rawCell.targetIndex}.`,
        );
        continue;
      }
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
    const status =
      group.values.size === expectedCellCount && missingMetrics.length === 0
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
  const tags: Array<"shooting" | "melee" | "objective" | "durability"> = [];
  if (
    findings.some(
      (finding) =>
        finding.kind === "role-gap" && /shooting/i.test(finding.summary),
    )
  ) {
    tags.push("shooting");
  }
  if (
    findings.some(
      (finding) =>
        finding.kind === "role-gap" && /fight/i.test(finding.summary),
    )
  ) {
    tags.push("melee");
  }
  if (findings.some((finding) => finding.kind === "enemy-threat")) {
    tags.push("durability");
  }
  if (tags.length === 0) tags.push("objective");
  return tags;
}

function changeCandidates(
  roster: RosterDraftV1,
  findings: TesseraFinding[],
): TesseraChangeCandidate[] {
  const candidates: TesseraChangeCandidate[] = [];
  const seen = new Set<string>();
  const evidenceFindingIds = findings
    .filter(
      (finding) =>
        finding.severity === "warn" &&
        finding.confidence !== "ambiguous",
    )
    .map((finding) => finding.findingId)
    .slice(0, 6);
  if (evidenceFindingIds.length === 0) return [];
  const actionableFindings = findings.filter((finding) =>
    evidenceFindingIds.includes(finding.findingId),
  );
  const addCandidate = (
    title: string,
    rationale: string,
    operation: ModifyRosterOperation,
  ) => {
    const modified = modifyRoster(roster, operation);
    if (!modified.ok || !modified.data) return;
    const key = rosterFingerprint(modified.data);
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
      afterPoints: modified.data.totalPoints,
      rosterFingerprint: key,
      evidenceFindingIds,
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
      (!roster.constraints.collectionUnitIds ||
        roster.constraints.collectionUnitIds.includes(unit.id)),
  );
  const remaining = roster.pointsLimit - roster.totalPoints;
  const addition = allowedUnits.find((unit) => unit.pointsFrom <= remaining);
  if (addition) {
    addCandidate(
      `Add ${addition.name}`,
      `Uses available points to add ${candidateRoleTags(actionableFindings).join(
        "/",
      )} coverage.`,
      { type: "add", unitId: addition.id },
    );
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
      addCandidate(
        `Increase ${selection.name} to ${larger} models`,
        "Uses spare points to strengthen an existing unit without changing its battlefield role.",
        {
          type: "set-model-count",
          selectionId: selection.selectionId,
          modelCount: larger,
        },
      );
      if (candidates.length >= 3) break;
    }
  }

  if (candidates.length < 3) {
    const replaceable = [...roster.units].sort(
      (a, b) => b.points - a.points || a.name.localeCompare(b.name),
    );
    outer: for (const selection of replaceable) {
      for (const unit of allowedUnits) {
        if (unit.id === selection.unitId) continue;
        addCandidate(
          `Replace ${selection.name} with ${unit.name}`,
          `Tests a legal ${candidateRoleTags(actionableFindings).join(
            "/",
          )} alternative against the same scenarios.`,
          {
            type: "replace",
            selectionId: selection.selectionId,
            unitId: unit.id,
          },
        );
        if (candidates.length >= 3) break outer;
      }
    }
  }
  return candidates.slice(0, 3);
}

export async function analyzeRosterMatchup(
  playerRoster: RosterDraftV1,
  opponent: TesseraOpponentInput,
  options: TesseraAnalysisOptions = {},
  dependencies: TesseraDependencies = {},
): Promise<ResultEnvelope<TesseraMatchupReport>> {
  const outputDirectory = options.outputDirectory ?? "exports/tessera";
  const configuration = analysisConfiguration(options);
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
  const player = await prepareRosterForTessera(
    playerRoster,
    { ...options, outputDirectory: path.join(outputDirectory, "player") },
    dependencies,
  );
  if (!player.ok || !player.data) {
    return {
      ok: false,
      data: null,
      violations: player.violations,
      warnings: player.warnings,
    };
  }
  const preparedPlayer = player.data;

  const opponents: TesseraMatchupReport["opponents"] = [];
  const warnings: string[] = player.warnings.map((warning) => warning.message);
  if (opponent.kind === "roster") {
    const prepared = await prepareRosterForTessera(
      opponent.roster,
      { ...options, outputDirectory: path.join(outputDirectory, "opponent") },
      dependencies,
    );
    if (!prepared.ok || !prepared.data) {
      return {
        ok: false,
        data: null,
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
    });
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
        data: null,
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
    });
  } else {
    const requested =
      opponent.archetypes?.length
        ? opponent.archetypes
        : (Object.keys(ARCHETYPE_PREFERENCES) as TesseraArchetype[]);
    const seen = new Set<string>();
    for (const archetype of requested.slice(0, 3)) {
      const built = buildRoster({
        faction: opponent.factionId,
        pointsLimit: playerRoster.pointsLimit,
        name: `${opponent.factionId} ${archetype} proxy`,
        preferences: ARCHETYPE_PREFERENCES[archetype],
        allowLegends: false,
        allowNamedCharacters: true,
      });
      if (!built.ok || !built.data) {
        warnings.push(
          `Could not build ${archetype}: ${
            built.violations[0]?.message ?? "unknown build failure"
          }`,
        );
        continue;
      }
      const key = rosterFingerprint(built.data);
      if (seen.has(key)) {
        warnings.push(
          `${archetype} duplicated another deterministic proxy and was omitted.`,
        );
        continue;
      }
      seen.add(key);
      const prepared = await prepareRosterForTessera(
        built.data,
        {
          ...options,
          outputDirectory: path.join(
            outputDirectory,
            "opponents",
            archetype,
          ),
        },
        dependencies,
      );
      if (!prepared.ok || !prepared.data) {
        warnings.push(
          `Could not prepare ${archetype}: ${
            prepared.violations[0]?.message ?? "New Recruit handoff failed"
          }`,
        );
        continue;
      }
      opponents.push({
        kind: "faction-archetype",
        archetype,
        rosterName: prepared.data.rosterName,
        enrichedRoszPath: prepared.data.enrichedRoszPath,
        summary: prepared.data.summary,
        fingerprint: rosterFingerprint(built.data),
        units: canonicalUnits(built.data, "opponent"),
      });
    }
  }
  if (opponents.length === 0) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "NO_OPPONENTS_PREPARED",
          message: "No opponent roster could be prepared for Tessera.",
          severity: "error",
        },
      ],
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
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_POINTS_MISMATCH",
            message: pointsMismatchMessage(comparison),
            severity: "error",
          },
        ],
        warnings: player.warnings,
      };
    }
    for (const index of [...unmatchedIndexes].sort((a, b) => b - a)) {
      warnings.push(
        `${opponents[index].rosterName} was omitted because its ${opponents[index].summary.totalPoints}-point total is outside the ${configuration.pointsTolerancePercent}% tolerance.`,
      );
      opponents.splice(index, 1);
      pointsComparisons.splice(index, 1);
    }
    if (opponents.length === 0) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_POINTS_MISMATCH",
            message:
              "No generated faction archetype was within the matched-points tolerance.",
            severity: "error",
          },
        ],
        warnings: player.warnings,
      };
    }
  }

  const matrices: TesseraMatchupReport["simulation"]["matrices"] = [];
  const scenarios: TesseraScenarioResult[] = [];
  const settings: Record<string, string> = {};
  if (options.experimental) {
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
        });
        Object.assign(settings, result.settings);
        warnings.push(...result.warnings);
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
      } catch (error) {
        warnings.push(
          `Experimental Tessera analysis failed for ${prepared.rosterName}: ${
            error instanceof Error ? error.message : "unknown browser failure"
          }`,
        );
      } finally {
        await rm(profileDirectory, { recursive: true, force: true });
      }
    }
  }

  const findings = structuredFindings(scenarios);
  const legacy = legacyFindingText(findings);
  const allMatched = pointsComparisons.every((comparison) => comparison.matched);
  const expectedScenarioCount =
    opponents.length *
    configuration.phases.length *
    configuration.directions.length;
  const scenariosComplete =
    scenarios.length === expectedScenarioCount &&
    scenarios.every((scenario) => scenario.status === "complete");
  const proposedChanges =
    configuration.includeChangeCandidates &&
    allMatched &&
    scenarios.length > 0
      ? changeCandidates(playerRoster, findings)
      : [];
  const runId = crypto.randomUUID();
  const report: TesseraMatchupReport = {
    schemaVersion: 2,
    runId,
    generatedAt: new Date().toISOString(),
    source: matrices.length ? "tessera-ui" : "handoff-only",
    status:
      options.experimental &&
      matrices.length === opponents.length &&
      scenariosComplete
        ? "complete"
        : "partial",
    comparisonClass: allMatched ? "matched" : "unmatched",
    configuration,
    pointsComparisons,
    player: preparedPlayer,
    opponents,
    simulation: {
      requested: options.experimental === true,
      experimental: true,
      settings,
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
    artifacts: [],
  };
  const basename = `${safeName(playerRoster.name) || "roster"}-matchup`;
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
          content: renderTesseraMatchupReportHtml(report),
        },
      ],
      outputDirectory,
      options,
    );
    report.artifacts = [
      { format: "matchup-json", written: written[0] },
      { format: "matchup-html", written: written[1] },
    ];
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
    baseline.schemaVersion !== 2 ||
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
            "Revision comparison requires a complete schema-v2 baseline with captured scenarios.",
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
