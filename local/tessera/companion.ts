import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  analyzeMissionReadiness,
  baselineDamageCells,
  compareNewRecruitCatalogueProvenance,
  exportRoster,
  generateFactionStressPortfolio,
  getNewRecruitFactionSummary,
  inspectEnrichedRosz,
  inspectEnrichedProfileRequirements,
  inspectEnrichedUnitProfileCoverage,
  newRecruitCatalogue,
  rosterExecutionFingerprint,
  searchUnits,
  validateRoster,
  type EnrichedRoszSummary,
  type ExportArtifact,
  type ConnectorEvent,
  type ModifyRosterOperation,
  type NewRecruitDelivery,
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
  type TesseraProfileRequirement,
  type TesseraRevisionAggregate,
  type TesseraRevisionComparisonReport,
  type TesseraRevisionDelta,
  type TesseraScenarioCell,
  type TesseraScenarioResult,
  type TesseraStressPortfolioItem,
  type TesseraUnitInstance,
} from "../../lib/rosterpilot";
import {
  resolveExportArtifactTargets,
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
  acquireNewRecruitCacheLease,
  acquireDirectoryLease,
  beginNewRecruitMutationReceipt,
  loadNewRecruitCache,
  recordNewRecruitReuseReceipt,
  storeNewRecruitCache,
  type NewRecruitMutationTransaction,
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
  profilePolicyIdentityKey,
  profilePolicyHash,
  profilePolicyScaffold,
  ProfilePolicySchema,
  validateProfilePolicy,
} from "./profile-policy";
import {
  getRuntimeProvenance,
  runtimeRestartIssue,
} from "../runtime-provenance";
import {
  createExactReportReceipt,
  exactReportReceiptPath,
  verifyExactReportReceipt,
} from "./exact-report-integrity";
import {
  compareRoszGameplaySnapshots,
  inspectRoszGameplaySnapshot,
  roszGameplaySnapshotSha256,
} from "./rosz-integrity";
import {
  createTesseraSavedListReuse,
} from "./saved-list-reuse";

const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const verifiedUploadedArtifactCapabilities = new WeakSet<object>();

function grantVerifiedUploadedArtifactCapability(): object {
  const capability = {};
  verifiedUploadedArtifactCapabilities.add(capability);
  return capability;
}

function hasVerifiedUploadedArtifactCapability(
  capability: object | undefined,
): boolean {
  return Boolean(
    capability &&
      verifiedUploadedArtifactCapabilities.has(capability),
  );
}

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
  /** Internal requirements frozen after New Recruit enrichment. */
  frozenProfileRequirements?: TesseraProfileRequirement[];
  /**
   * Internal frozen source context for a ROSZ opponent. Resumable stress
   * runs use it to finish policy and legality preflights before reopening a
   * previously verified enriched archive.
   */
  opponentRosterContext?: RosterDraftV1;
  /**
   * Internal process-local capability. A plain object or serialized value is
   * not trusted; only this module can mint a verified artifact capability
   * after checking the complete frozen bundle.
   */
  verifiedUploadedArtifactCapability?: object;
  /**
   * Internal durable-job checkpoint. These receipts are accepted only after
   * their hashes, gameplay summaries, and execution fingerprints are
   * revalidated before any external mutation.
   */
  preparedReuse?: {
    player: TesseraPreparedRoster;
    opponent: TesseraPreparedRoster | null;
    sourceAttempt: number;
  };
  /**
   * Internal paired-revision checkpoint for an opponent whose exact source
   * and enriched archives were already verified against the baseline receipt.
   * Unlike `preparedReuse`, this does not imply that the revised player has
   * already been prepared.
   */
  frozenOpponentReuse?: TesseraPreparedRoster;
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
  /**
   * Marks an injected delivery adapter as the production persistent-cache
   * path. Test doubles remain isolated by default.
   */
  persistentCacheDelivery?: boolean;
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
  const managesPersistentCache =
    !dependencies.deliver ||
    dependencies.persistentCacheDelivery === true;
  const releaseCacheLease = managesPersistentCache
    ? await acquireNewRecruitCacheLease(roster)
    : null;
  try {
  let cacheReused = false;
  let pendingPersistentCacheStore = false;
  const mutationRunId =
    options.mutationRunId ??
    `tessera-prepare-${roster.id}-${crypto.randomUUID()}`;
  let mutationTransaction: NewRecruitMutationTransaction | null =
    null;
  let delivery: Awaited<ReturnType<typeof deliverRosterToNewRecruit>>;
  try {
    const persisted = managesPersistentCache
      ? await loadNewRecruitCache(roster)
      : null;
    if (persisted) {
      delivery = persisted;
      cacheReused = true;
      await recordNewRecruitReuseReceipt({
        roster,
        runId: mutationRunId,
        delivery,
      });
    } else {
      if (managesPersistentCache && dependencies.deliver) {
        mutationTransaction =
          await beginNewRecruitMutationReceipt({
            roster,
            runId: mutationRunId,
          });
      }
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
            mutationReceiptMode: mutationTransaction
              ? "external"
              : options.mutationReceiptMode,
            downloadEnrichedRosz: true,
            downloadPrettyHtml: false,
            outputDirectory:
              options.outputDirectory ?? "exports/tessera",
          });
          dependencyCache.set(cacheKey, pending);
        }
        delivery = await pending;
        if (!delivery.ok) dependencyCache.delete(cacheKey);
        pendingPersistentCacheStore =
          dependencies.persistentCacheDelivery === true &&
          delivery.ok &&
          !cacheReused;
      } else {
        delivery = await deliverRosterToNewRecruit(roster, {
          ...options,
          downloadEnrichedRosz: true,
          downloadPrettyHtml: false,
          outputDirectory:
            options.outputDirectory ?? "exports/tessera",
        });
        pendingPersistentCacheStore = delivery.ok;
      }
      await mutationTransaction?.finalizeDelivery(delivery);
    }
  } catch (error) {
    if (mutationTransaction) {
      try {
        await mutationTransaction.finalize({
          outcome: "uncertain",
          connectorEvent: null,
          message:
            error instanceof Error
              ? error.message
              : "New Recruit delivery threw after dispatch.",
        });
      } catch {
        // The pending durable receipt remains authoritative when even
        // finalization cannot be confirmed.
      }
    }
    const coded = error as { code?: unknown };
    return {
      ok: false,
      data: null,
      violations: [
        {
          code:
            typeof coded.code === "string"
              ? coded.code
              : "NEW_RECRUIT_MUTATION_UNCERTAIN",
          message:
            error instanceof Error
              ? error.message
              : "New Recruit delivery failed with an uncertain external outcome.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
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
    fingerprint: rosterExecutionFingerprint(roster),
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
            `The frozen ${roster.factionName} New Recruit catalogue identity is unavailable, so Tessera cannot verify the prepared roster's catalogue provenance.`,
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
            `The catalogue identity observed in New Recruit's enriched ROSZ differs from frozen bundle ${roster.sourceData.bundleId} (source release ${roster.sourceData.releaseId}): ${mismatchSummary}. Tessera was not started. This comparison does not infer New Recruit's backend commit.`,
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
            `New Recruit's enriched ROSZ omitted ${catalogueProvenance.missing.join(", ")}. The frozen bundle remains recorded, but Tessera was not started because the live catalogue identity could not be verified.`,
          severity: "error",
        },
      ],
      warnings: delivery.warnings,
    };
  }
  const gameplayIntegrity = await verifyRoszGameplayArtifacts(
    source.written,
    enriched.written,
    roster.name,
  );
  if (gameplayIntegrity) {
    return {
      ok: false,
      data: prepared,
      violations: [gameplayIntegrity],
      warnings: delivery.warnings,
    };
  }
  if (pendingPersistentCacheStore && !cacheReused) {
    await storeNewRecruitCache(roster, delivery, {
      runId: mutationRunId,
      mutationAttemptId:
        mutationTransaction?.attemptId ?? null,
    });
  }
  return {
    ok: true,
    data: prepared,
    violations: [],
    warnings: delivery.warnings,
  };
  } finally {
    await releaseCacheLease?.();
  }
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

function effectiveExecutionMode(
  options: TesseraAnalysisOptions,
): "prepare-only" | "simulate" {
  if (options.executionMode) return options.executionMode;
  return options.experimental === true ? "simulate" : "prepare-only";
}

function canonicalOpponentCompatibilityIssue(
  player: RosterDraftV1,
  opponent: RosterDraftV1,
): RosterIssue | null {
  if (player.pointsLimit !== opponent.pointsLimit) {
    return {
      code: "TESSERA_POINTS_LIMIT_MISMATCH",
      message:
        `Canonical rosters declare different points limits (${player.pointsLimit} and ${opponent.pointsLimit}). Exact matchup analysis requires the same declared limit even when a total-points mismatch is explicitly allowed.`,
      severity: "error",
    };
  }
  const playerSource = player.sourceData;
  const opponentSource = opponent.sourceData;
  const sourceCompatible =
    playerSource.edition === opponentSource.edition &&
    ("bundleId" in playerSource &&
    "bundleId" in opponentSource
      ? playerSource.bundleId === opponentSource.bundleId &&
        playerSource.engineDataSchemaVersion ===
          opponentSource.engineDataSchemaVersion
      : playerSource.releaseId === opponentSource.releaseId &&
        playerSource.newRecruit.repository ===
          opponentSource.newRecruit.repository &&
        playerSource.newRecruit.commit ===
          opponentSource.newRecruit.commit &&
        playerSource.newRecruit.gameSystemRevision ===
          opponentSource.newRecruit.gameSystemRevision &&
        playerSource.official.contentSha256 ===
          opponentSource.official.contentSha256);
  if (!sourceCompatible) {
    return {
      code: "TESSERA_DATA_PIN_MISMATCH",
      message:
        `Canonical rosters must use the same edition and frozen data bundle. Player=${playerSource.bundleId} (${playerSource.edition}); opponent=${opponentSource.bundleId} (${opponentSource.edition}). Rebase provenance-compatible rosters before starting a new exact run.`,
      severity: "error",
    };
  }
  return null;
}

function exactOpponentScopeIssue(
  opponent: TesseraOpponentInput,
): RosterIssue | null {
  return opponent.kind === "faction-archetypes"
    ? {
        code: "OPPONENT_SCOPE_REQUIRED",
        message:
          "Exact matchup analysis requires a known opponent roster or ROSZ. For a known faction with an unknown list, use the adaptive stress workflow; RosterPilot will not guess a faction or route exact analysis through deprecated faction archetypes.",
        severity: "error",
      }
    : null;
}

function normalizedRosterText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\b(?:imperium|chaos|xenos)\s*-\s*/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function factionNamesCompatible(left: string, right: string): boolean {
  const normalizedLeft = normalizedRosterText(left);
  const normalizedRight = normalizedRosterText(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function factionIdentityForUploadedSummary(
  summary: EnrichedRoszSummary,
): string {
  const catalogueIds = new Set(
    (summary.observedNewRecruitCatalogue?.catalogues ?? [])
      .map((catalogue) => catalogue.id)
      .filter((id): id is string => id !== null),
  );
  const matched = Object.entries(newRecruitCatalogue.factions).find(
    ([, faction]) => catalogueIds.has(faction.catalogue.id),
  );
  return matched?.[0] ?? summary.factionName;
}

type UploadedRoszPreflight = {
  content: Buffer;
  summary: EnrichedRoszSummary;
  factionId: string | null;
  gameplayFingerprint: string;
  profileRequirements: TesseraProfileRequirement[];
  warnings: RosterIssue[];
};

async function inspectUploadedRoszPreflight(
  filename: string,
  playerRoster: RosterDraftV1,
  opponentRosterContext: RosterDraftV1 | undefined,
  uploadedArtifactProvenanceVerified = false,
): Promise<ResultEnvelope<UploadedRoszPreflight>> {
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
            error instanceof Error
              ? error.message
              : "The .rosz could not be read.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  let summary: EnrichedRoszSummary;
  let gameplaySnapshot: ReturnType<
    typeof inspectRoszGameplaySnapshot
  >;
  try {
    summary = inspectEnrichedRosz(content);
    gameplaySnapshot = inspectRoszGameplaySnapshot(content);
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
  const violations: RosterIssue[] = [];
  if (!summary.rosterName.trim()) {
    violations.push({
      code: "TESSERA_ROSZ_NAME_MISSING",
      message: "The uploaded ROSZ does not declare a roster name.",
      severity: "error",
    });
  }
  if (!summary.factionName.trim()) {
    violations.push({
      code: "TESSERA_ROSZ_FACTION_MISSING",
      message: "The uploaded ROSZ does not declare a faction catalogue.",
      severity: "error",
    });
  }
  if (!Number.isFinite(summary.totalPoints) || summary.totalPoints < 0) {
    violations.push({
      code: "TESSERA_ROSZ_POINTS_INVALID",
      message: "The uploaded ROSZ does not contain a valid points total.",
      severity: "error",
    });
  }
  if (summary.units.length === 0) {
    violations.push({
      code: "TESSERA_ROSZ_UNITS_MISSING",
      message: "The uploaded ROSZ does not contain any top-level units.",
      severity: "error",
    });
  }

  let factionId: string | null = null;
  if (!uploadedArtifactProvenanceVerified) {
    if (
      gameplaySnapshot.gameSystem.id === null ||
      gameplaySnapshot.gameSystem.revision === null
    ) {
      violations.push({
        code: "TESSERA_ROSZ_PROVENANCE_UNVERIFIABLE",
        message:
          "The uploaded ROSZ does not expose a concrete game-system identity and revision.",
        severity: "error",
      });
    } else if (
      gameplaySnapshot.gameSystem.id !==
        newRecruitCatalogue.gameSystem.id ||
      gameplaySnapshot.gameSystem.revision !==
        playerRoster.sourceData.newRecruit.gameSystemRevision
    ) {
      violations.push({
        code: "TESSERA_ROSZ_GAME_SYSTEM_MISMATCH",
        message:
          `The uploaded ROSZ game system ${gameplaySnapshot.gameSystem.id}@${gameplaySnapshot.gameSystem.revision} does not match the frozen bundle's ${newRecruitCatalogue.gameSystem.id}@${playerRoster.sourceData.newRecruit.gameSystemRevision}.`,
        severity: "error",
      });
    }
    const observedFactionCatalogues = Object.entries(
      newRecruitCatalogue.factions,
    ).flatMap(([factionId, faction]) => {
      const catalogue = gameplaySnapshot.catalogues.find(
        (candidate) =>
          candidate.id === faction.catalogue.id,
      );
      return catalogue
        ? [{ factionId, expected: faction.catalogue, catalogue }]
        : [];
    });
    if (
      gameplaySnapshot.catalogues.length !== 1 ||
      observedFactionCatalogues.length !== 1
    ) {
      violations.push({
        code: "TESSERA_ROSZ_CATALOGUE_IDENTITY_AMBIGUOUS",
        message:
          "The uploaded ROSZ does not identify exactly one supported opponent faction catalogue from the frozen data bundle.",
        severity: "error",
      });
    } else {
      const [matchedCatalogue] = observedFactionCatalogues;
      const { expected, catalogue } = matchedCatalogue;
      if (
        catalogue.revision === null ||
        catalogue.revision !== expected.revision
      ) {
        violations.push({
          code: "TESSERA_ROSZ_DATA_PIN_MISMATCH",
          message:
            `The uploaded ROSZ catalogue revision ${catalogue.revision ?? "unknown"} does not match the frozen bundle revision ${expected.revision}.`,
          severity: "error",
        });
      } else {
        factionId = matchedCatalogue.factionId;
      }
    }
  }
  const incompleteProfiles = inspectEnrichedUnitProfileCoverage(
    content,
  ).filter((unit) => !unit.complete);
  if (
    !uploadedArtifactProvenanceVerified &&
    summary.profileCount > 0 &&
    summary.weaponProfileCount > 0 &&
    incompleteProfiles.length > 0
  ) {
    violations.push({
      code: "TESSERA_ROSZ_PROFILES_INCOMPLETE",
      message:
        `The uploaded ROSZ has incomplete per-unit model/weapon profiles for ${incompleteProfiles.map((unit) => `${unit.name} (${unit.modelCount} model${unit.modelCount === 1 ? "" : "s"})`).join(", ")}.`,
      severity: "error",
    });
  }

  if (opponentRosterContext) {
    const validation = validateRoster(opponentRosterContext);
    violations.push(...validation.violations);
    const compatibility = canonicalOpponentCompatibilityIssue(
      playerRoster,
      opponentRosterContext,
    );
    if (compatibility) violations.push(compatibility);
    if (summary.totalPoints !== opponentRosterContext.totalPoints) {
      violations.push({
        code: "TESSERA_ROSZ_CONTEXT_POINTS_MISMATCH",
        message:
          `The uploaded ROSZ contains ${summary.totalPoints} points, but its canonical opponent context contains ${opponentRosterContext.totalPoints}.`,
        severity: "error",
      });
    }
    if (
      !factionNamesCompatible(
        summary.factionName,
        opponentRosterContext.factionName,
      )
    ) {
      violations.push({
        code: "TESSERA_ROSZ_CONTEXT_FACTION_MISMATCH",
        message:
          `The uploaded ROSZ faction "${summary.factionName}" does not match canonical context "${opponentRosterContext.factionName}".`,
        severity: "error",
      });
    }
    const canonicalUnits = opponentRosterContext.units
      .map((unit) =>
        [
          normalizedRosterText(unit.name),
          unit.modelCount,
          unit.points,
        ].join(":"),
      )
      .sort();
    const uploadedUnits = summary.units
      .map((unit) =>
        [
          normalizedRosterText(unit.name),
          unit.modelCount,
          unit.points ?? "",
        ].join(":"),
      )
      .sort();
    if (
      JSON.stringify(canonicalUnits) !==
      JSON.stringify(uploadedUnits)
    ) {
      violations.push({
        code: "TESSERA_ROSZ_CONTEXT_UNIT_MISMATCH",
        message:
          "The uploaded ROSZ unit, model-count, and points multiset does not match its canonical opponent context.",
        severity: "error",
      });
    }
    const canonicalRosz = await exportRoster(
      opponentRosterContext,
      "rosz",
    );
    if (!canonicalRosz.ok || !canonicalRosz.data) {
      violations.push({
        code: "TESSERA_ROSZ_CONTEXT_EXPORT_UNAVAILABLE",
        message:
          "The canonical opponent context could not be exported for complete ROSZ gameplay-identity verification.",
        severity: "error",
      });
    } else {
      try {
        const canonicalContent =
          typeof canonicalRosz.data.content === "string"
            ? Buffer.from(canonicalRosz.data.content)
            : canonicalRosz.data.content;
        const gameplayMismatches = compareRoszGameplaySnapshots(
          inspectRoszGameplaySnapshot(canonicalContent),
          inspectRoszGameplaySnapshot(content),
        );
        if (gameplayMismatches.length > 0) {
          violations.push({
            code: "TESSERA_ROSZ_CONTEXT_GAMEPLAY_MISMATCH",
            message:
              `The uploaded ROSZ does not match the canonical opponent's complete rule-bearing identity (${gameplayMismatches.join(", ")}).`,
            severity: "error",
          });
        }
      } catch (error) {
        violations.push({
          code: "TESSERA_ROSZ_CONTEXT_GAMEPLAY_UNVERIFIABLE",
          message:
            error instanceof Error
              ? error.message
              : "The canonical opponent gameplay identity could not be compared.",
          severity: "error",
        });
      }
    }
  }

  const warnings: RosterIssue[] = [];
  if (!opponentRosterContext) {
    warnings.push({
      code: "TESSERA_ROSZ_LEGALITY_UNVERIFIED",
      message:
        "An uploaded ROSZ without canonical opponent context can be checked for structure, points, embedded profiles, and catalogue identity, but its roster legality and exact source release remain unverified.",
      severity: "warn",
    });
  }
  if (
    !uploadedArtifactProvenanceVerified &&
    (
      gameplaySnapshot.gameSystem.id === null ||
      gameplaySnapshot.gameSystem.revision === null ||
      factionId === null
    )
  ) {
    warnings.push({
      code: "TESSERA_ROSZ_CATALOGUE_PROVENANCE_UNVERIFIED",
      message:
        "The uploaded ROSZ does not expose a complete pinned catalogue identity and cannot be used for exact simulation.",
      severity: "warn",
    });
  }

  let profileRequirements: TesseraProfileRequirement[] = [];
  try {
    profileRequirements = inspectEnrichedProfileRequirements(
      content,
      opponentRosterContext?.factionId ??
        factionIdentityForUploadedSummary(summary),
    );
  } catch (error) {
    violations.push({
      code: "TESSERA_ROSZ_PROFILE_INVENTORY_INVALID",
      message:
        error instanceof Error
          ? error.message
          : "The uploaded ROSZ profile inventory could not be inspected.",
      severity: "error",
    });
  }
  return {
    ok: violations.length === 0,
    data:
      violations.length === 0
        ? {
            content,
            summary,
            factionId,
            gameplayFingerprint:
              roszGameplaySnapshotSha256(gameplaySnapshot),
            profileRequirements,
            warnings,
          }
        : null,
    violations,
    warnings,
  };
}

function mergedProfileRequirements(
  groups: TesseraProfileRequirement[][],
): TesseraProfileRequirement[] {
  const merged = new Map<string, TesseraProfileRequirement>();
  for (const requirement of groups.flat()) {
    const key = profilePolicyIdentityKey(requirement);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, structuredClone(requirement));
      continue;
    }
    const profiles = new Map(
      current.availableProfiles.map((profile) => [
        normalizedRosterText(profile),
        profile,
      ]),
    );
    for (const profile of requirement.availableProfiles) {
      profiles.set(normalizedRosterText(profile), profile);
    }
    current.availableProfiles = [...profiles.values()].sort((left, right) =>
      left.localeCompare(right),
    );
    current.activeCount = Math.max(
      current.activeCount,
      requirement.activeCount,
    );
    if (current.selectionId !== requirement.selectionId) {
      current.selectionId = null;
    }
  }
  return [...merged.values()].sort((left, right) =>
    profilePolicyIdentityKey(left).localeCompare(
      profilePolicyIdentityKey(right),
    ),
  );
}

async function inspectPreparedProfileRequirements(
  prepared: Pick<
    TesseraPreparedRoster,
    "enrichedRoszPath" | "summary" | "rosterName"
  >,
  faction: string,
): Promise<ResultEnvelope<TesseraProfileRequirement[]>> {
  try {
    const content = await readFile(prepared.enrichedRoszPath);
    const actualSummary = inspectEnrichedRosz(content);
    if (
      actualSummary.totalPoints !== prepared.summary.totalPoints ||
      !factionNamesCompatible(
        actualSummary.factionName,
        prepared.summary.factionName,
      ) ||
      actualSummary.units.length !== prepared.summary.units.length
    ) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_PREPARED_ARTIFACT_DRIFT",
            message:
              `The prepared archive for ${prepared.rosterName} no longer matches its verified summary.`,
            severity: "error",
          },
        ],
        warnings: [],
      };
    }
    if (
      actualSummary.profileCount === 0 ||
      actualSummary.weaponProfileCount === 0
    ) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_PREPARED_PROFILES_MISSING",
            message:
              `The prepared archive for ${prepared.rosterName} does not contain embedded model and weapon profiles.`,
            severity: "error",
          },
        ],
        warnings: [],
      };
    }
    return {
      ok: true,
      data: inspectEnrichedProfileRequirements(content, faction),
      violations: [],
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_PREPARED_ARTIFACT_UNREADABLE",
          message:
            error instanceof Error
              ? error.message
              : `The prepared archive for ${prepared.rosterName} could not be inspected.`,
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
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

function summariesGameplayCompatible(
  left: EnrichedRoszSummary,
  right: EnrichedRoszSummary,
): boolean {
  const unitIdentity = (summary: EnrichedRoszSummary) =>
    summary.units
      .map((unit) =>
        [
          normalizedRosterText(unit.name),
          unit.modelCount,
          unit.points ?? "",
        ].join(":"),
      )
      .sort()
      .join("|");
  const catalogueIdentity = (summary: EnrichedRoszSummary) => {
    const observed = summary.observedNewRecruitCatalogue;
    if (!observed) return null;
    return JSON.stringify({
      gameSystem: {
        id: observed.gameSystem.id,
        revision: observed.gameSystem.revision,
      },
      catalogues: [...observed.catalogues]
        .map((catalogue) => ({
          id: catalogue.id,
          revision: catalogue.revision,
        }))
        .sort(
          (leftCatalogue, rightCatalogue) =>
            (leftCatalogue.id ?? "").localeCompare(
              rightCatalogue.id ?? "",
            ) ||
            (leftCatalogue.revision ?? -1) -
              (rightCatalogue.revision ?? -1),
        ),
    });
  };
  return (
    normalizedRosterText(left.rosterName) ===
      normalizedRosterText(right.rosterName) &&
    factionNamesCompatible(left.factionName, right.factionName) &&
    left.totalPoints === right.totalPoints &&
    unitIdentity(left) === unitIdentity(right) &&
    catalogueIdentity(left) === catalogueIdentity(right)
  );
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

function sha256(content: Uint8Array): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function verifyRoszGameplayArtifacts(
  sourcePath: string,
  enrichedPath: string,
  rosterName: string,
): Promise<RosterIssue | null> {
  try {
    const [source, enriched] = await Promise.all([
      readFile(sourcePath),
      readFile(enrichedPath),
    ]);
    const mismatches = compareRoszGameplaySnapshots(
      inspectRoszGameplaySnapshot(source),
      inspectRoszGameplaySnapshot(enriched),
    );
    if (mismatches.length > 0) {
      return {
        code: "TESSERA_ROSZ_ENRICHMENT_DRIFT",
        message:
          `New Recruit changed the rule-bearing ${mismatches.join(", ")} identity while enriching ${rosterName}. Tessera was not started.`,
        severity: "error",
      };
    }
    return null;
  } catch (error) {
    return {
      code: "TESSERA_ROSZ_GAMEPLAY_IDENTITY_UNREADABLE",
      message:
        `The source and enriched archives for ${rosterName} could not be compared completely: ${
          error instanceof Error ? error.message : "unreadable ROSZ"
        }.`,
      severity: "error",
    };
  }
}

async function materializePreparedRosterArtifacts(
  prepared: TesseraPreparedRoster,
  outputDirectory: string,
  options: TesseraAnalysisOptions,
): Promise<TesseraPreparedRoster> {
  const [sourceContent, enrichedContent] = await Promise.all([
    readFile(prepared.sourceRoszPath),
    readFile(prepared.enrichedRoszPath),
  ]);
  const sourceRoszSha256 = sha256(sourceContent);
  const enrichedRoszSha256 = sha256(enrichedContent);
  const artifactDirectory = path.join(outputDirectory, "artifacts");
  const [sourceRoszPath, enrichedRoszPath] = await Promise.all([
    writeExportArtifact(
      {
        format: "rosz",
        filename: `source-${sourceRoszSha256}.rosz`,
        mimeType: "application/zip",
        encoding: "binary",
        content: sourceContent,
      },
      path.join(
        artifactDirectory,
        `source-${sourceRoszSha256}.rosz`,
      ),
      { ...options, overwrite: true },
    ),
    writeExportArtifact(
      {
        format: "rosz",
        filename: `enriched-${enrichedRoszSha256}.rosz`,
        mimeType: "application/zip",
        encoding: "binary",
        content: enrichedContent,
      },
      path.join(
        artifactDirectory,
        `enriched-${enrichedRoszSha256}.rosz`,
      ),
      { ...options, overwrite: true },
    ),
  ]);
  return {
    ...prepared,
    sourceRoszPath,
    enrichedRoszPath,
    sourceRoszSha256,
    enrichedRoszSha256,
  };
}

async function verifiedPreparedRosterReuse(
  prepared: TesseraPreparedRoster,
  roster: RosterDraftV1 | null,
): Promise<ResultEnvelope<TesseraPreparedRoster>> {
  const expectedFingerprint = roster
    ? rosterExecutionFingerprint(roster)
    : prepared.fingerprint;
  const fail = (message: string): ResultEnvelope<TesseraPreparedRoster> => ({
    ok: false,
    data: null,
    violations: [
      {
        code: "TESSERA_PREPARED_ARTIFACT_DRIFT",
        message,
        severity: "error",
      },
    ],
    warnings: [],
  });
  if (
    !prepared.sourceRoszSha256 ||
    !/^[0-9a-f]{64}$/.test(prepared.sourceRoszSha256) ||
    !prepared.enrichedRoszSha256 ||
    !/^[0-9a-f]{64}$/.test(prepared.enrichedRoszSha256) ||
    !expectedFingerprint ||
    prepared.fingerprint !== expectedFingerprint
  ) {
    return fail(
      "The durable exact-run checkpoint is missing its frozen archive or roster-execution identity.",
    );
  }
  try {
    const [source, enriched] = await Promise.all([
      readFile(prepared.sourceRoszPath),
      readFile(prepared.enrichedRoszPath),
    ]);
    if (
      sha256(source) !== prepared.sourceRoszSha256 ||
      sha256(enriched) !== prepared.enrichedRoszSha256
    ) {
      return fail(
        "A durable exact-run checkpoint archive changed after it was recorded.",
      );
    }
    const actualSummary = inspectEnrichedRosz(enriched);
    const gameplayMismatches = compareRoszGameplaySnapshots(
      inspectRoszGameplaySnapshot(source),
      inspectRoszGameplaySnapshot(enriched),
    );
    if (
      gameplayMismatches.length > 0 ||
      !summariesGameplayCompatible(actualSummary, prepared.summary) ||
      (
        roster !== null &&
        (
          prepared.summary.totalPoints !== roster.totalPoints ||
          !factionNamesCompatible(
            prepared.summary.factionName,
            roster.factionName,
          )
        )
      )
    ) {
      return fail(
        `The durable exact-run checkpoint no longer matches the frozen roster gameplay identity${
          gameplayMismatches.length > 0
            ? ` (${gameplayMismatches.join(", ")})`
            : ""
        }.`,
      );
    }
  } catch (error) {
    return fail(
      `The durable exact-run checkpoint could not be verified: ${
        error instanceof Error ? error.message : "unreadable archive"
      }`,
    );
  }
  return {
    ok: true,
    data: {
      ...prepared,
      listUrl: null,
      cacheReused: true,
      connectorEvents: [],
    },
    violations: [],
    warnings: [
      {
        code: "TESSERA_PREPARED_ARTIFACT_REUSED",
        message:
          "Reused hash-verified run-local New Recruit artifacts; no remote list was created for this roster.",
        severity: "warn",
      },
    ],
  };
}

async function freezeUploadedRoszPreflight(
  outputDirectory: string,
  options: TesseraAnalysisOptions,
  preflight: UploadedRoszPreflight,
): Promise<ResultEnvelope<string>> {
  const sourceSha256 = sha256(preflight.content);
  const resolvedOutputDirectory = path.isAbsolute(outputDirectory)
    ? outputDirectory
    : path.resolve(options.rootDir ?? process.cwd(), outputDirectory);
  const frozenSourceTarget = path.join(
    resolvedOutputDirectory,
    `uploaded-source-${sourceSha256}.rosz`,
  );
  try {
    if (await exists(frozenSourceTarget)) {
      const existing = await readFile(frozenSourceTarget);
      if (sha256(existing) !== sourceSha256) {
        throw new Error(
          "The content-addressed uploaded ROSZ path contains different bytes.",
        );
      }
      return {
        ok: true,
        data: frozenSourceTarget,
        violations: [],
        warnings: [],
      };
    }
    const written = await writeExportArtifact(
      {
        format: "rosz",
        filename: path.basename(frozenSourceTarget),
        mimeType: "application/zip",
        encoding: "binary",
        content: preflight.content,
      },
      frozenSourceTarget,
      { ...options, overwrite: false },
    );
    return {
      ok: true,
      data: written,
      violations: [],
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_ROSZ_FREEZE_FAILED",
          message:
            error instanceof Error
              ? `The uploaded ROSZ could not be frozen before external activity: ${error.message}`
              : "The uploaded ROSZ could not be frozen before external activity.",
          severity: "error",
        },
      ],
      warnings: preflight.warnings,
    };
  }
}

async function prepareUploadedRosz(
  frozenSourcePath: string,
  outputDirectory: string,
  options: TesseraAnalysisOptions,
  dependencies: TesseraDependencies,
  preflight: UploadedRoszPreflight,
  playerRoster: RosterDraftV1,
  opponentRosterContext: RosterDraftV1 | undefined,
  mutationRunId: string,
): Promise<
  ResultEnvelope<{
    rosterName: string;
    listUrl: string | null;
    sourceRoszPath: string;
    enrichedRoszPath: string;
    summary: EnrichedRoszSummary;
    cacheReused: boolean;
    connectorEvents: ConnectorEvent[];
    catalogueProvenance?: TesseraPreparedRoster["catalogueProvenance"];
  }>
> {
  const { content, summary } = preflight;
  const uploadedArtifactProvenanceVerified =
    hasVerifiedUploadedArtifactCapability(
      options.verifiedUploadedArtifactCapability,
    );
  let pendingPersistentCacheStore: {
    roster: RosterDraftV1;
    delivery: ResultEnvelope<NewRecruitDelivery>;
    mutationAttemptId: string | null;
  } | null = null;
  let prepared:
    | {
        rosterName: string;
        listUrl: string | null;
        enrichedRoszPath: string;
        summary: EnrichedRoszSummary;
        cacheReused: boolean;
        connectorEvents: ConnectorEvent[];
      }
    | null = null;
  let warnings = [...preflight.warnings];
  if (summary.profileCount === 0 || summary.weaponProfileCount === 0) {
    const managesPersistentCache =
      !dependencies.enrich && Boolean(opponentRosterContext);
    const releaseCacheLease =
      managesPersistentCache && opponentRosterContext
        ? await acquireNewRecruitCacheLease(opponentRosterContext)
        : null;
    try {
      const persisted =
        managesPersistentCache && opponentRosterContext
          ? await loadNewRecruitCache(opponentRosterContext)
          : null;
      if (persisted?.ok && persisted.data?.enrichedSummary) {
        const enrichedArtifact = persisted.data.artifacts.find(
          (artifact) =>
            artifact.format === "new-recruit-enriched-rosz",
        );
        if (!enrichedArtifact) {
          throw new Error(
            "The verified New Recruit cache omitted its enriched ROSZ artifact.",
          );
        }
        await recordNewRecruitReuseReceipt({
          roster: opponentRosterContext!,
          runId: mutationRunId,
          delivery: persisted,
        });
        prepared = {
          rosterName: persisted.data.rosterName,
          listUrl: persisted.data.listUrl,
          enrichedRoszPath: enrichedArtifact.written,
          summary: persisted.data.enrichedSummary,
          cacheReused: true,
          connectorEvents: persisted.data.connectorEvents ?? [],
        };
        warnings = [...warnings, ...persisted.warnings];
      } else {
        const enriched = await (
          dependencies.enrich ?? enrichRoszThroughNewRecruit
        )(frozenSourcePath, {
          ...options,
          outputDirectory,
          mutationRunId,
          mutationSubjectRoster: opponentRosterContext,
        });
        if (!enriched.ok || !enriched.data) {
          return {
            ok: false,
            data: null,
            violations: enriched.violations,
            warnings: enriched.warnings,
          };
        }
        const connectorEvent =
          enriched.data.connectorEvents.at(-1) ?? null;
        prepared = {
          rosterName: enriched.data.summary.rosterName,
          listUrl: enriched.data.listUrl,
          enrichedRoszPath: enriched.data.enrichedRoszPath,
          summary: enriched.data.summary,
          cacheReused: false,
          connectorEvents: enriched.data.connectorEvents,
        };
        warnings = [...warnings, ...enriched.warnings];
        if (
          managesPersistentCache &&
          opponentRosterContext &&
          connectorEvent
        ) {
          pendingPersistentCacheStore = {
            roster: opponentRosterContext,
            delivery: {
              ok: true,
              data: {
                rosterId: opponentRosterContext.id,
                rosterName: prepared.rosterName,
                listUrl: prepared.listUrl,
                imported: enriched.data.imported,
                sessionReused: enriched.data.sessionReused,
                cacheReused: false,
                connectorEvents: prepared.connectorEvents,
                verification: null,
                enrichedSummary: prepared.summary,
                artifacts: [
                  {
                    format: "rosterpilot-source-rosz",
                    filename: path.basename(frozenSourcePath),
                    mimeType: "application/zip",
                    written: frozenSourcePath,
                  },
                  {
                    format: "new-recruit-enriched-rosz",
                    filename: path.basename(
                      prepared.enrichedRoszPath,
                    ),
                    mimeType: "application/zip",
                    written: prepared.enrichedRoszPath,
                  },
                ],
              },
              violations: [],
              warnings: enriched.warnings,
            },
            mutationAttemptId: null,
          };
        }
      }
    } catch (error) {
      const coded = error as { code?: unknown };
      return {
        ok: false,
        data: null,
        violations: [
          {
            code:
              typeof coded.code === "string"
                ? coded.code
                : "NEW_RECRUIT_MUTATION_UNCERTAIN",
            message:
              error instanceof Error
                ? error.message
                : "Uploaded ROSZ enrichment failed with an uncertain external outcome.",
            severity: "error",
          },
        ],
        warnings,
      };
    } finally {
      await releaseCacheLease?.();
    }
  } else {
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
      prepared = {
        rosterName: summary.rosterName,
        listUrl: null,
        enrichedRoszPath: written,
        summary,
        cacheReused: false,
        connectorEvents: [],
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
        warnings,
      };
    }
  }

  if (
    prepared.summary.totalPoints !== summary.totalPoints ||
    !factionNamesCompatible(
      prepared.summary.factionName,
      summary.factionName,
    )
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_ROSZ_ENRICHMENT_DRIFT",
          message:
            "The enriched opponent archive changed the locally inspected faction or points total.",
          severity: "error",
        },
      ],
      warnings,
    };
  }
  const gameplayIntegrity = await verifyRoszGameplayArtifacts(
    frozenSourcePath,
    prepared.enrichedRoszPath,
    prepared.rosterName,
  );
  if (gameplayIntegrity) {
    return {
      ok: false,
      data: null,
      violations: [gameplayIntegrity],
      warnings,
    };
  }
  if (!uploadedArtifactProvenanceVerified) {
    try {
      const preparedContent = await readFile(
        prepared.enrichedRoszPath,
      );
      const incompleteProfiles =
        inspectEnrichedUnitProfileCoverage(preparedContent).filter(
          (unit) => !unit.complete,
        );
      if (incompleteProfiles.length > 0) {
        return {
          ok: false,
          data: null,
          violations: [
            {
              code: "TESSERA_ROSZ_PROFILES_INCOMPLETE",
              message:
                `The enriched uploaded opponent has incomplete per-unit model/weapon profiles for ${incompleteProfiles.map((unit) => unit.name).join(", ")}.`,
              severity: "error",
            },
          ],
          warnings,
        };
      }
    } catch (error) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_ROSZ_PROFILE_INVENTORY_INVALID",
            message:
              error instanceof Error
                ? error.message
                : "The enriched uploaded opponent profile inventory could not be verified.",
            severity: "error",
          },
        ],
        warnings,
      };
    }
  }

  let catalogueProvenance:
    TesseraPreparedRoster["catalogueProvenance"] | undefined;
  if (
    opponentRosterContext &&
    !uploadedArtifactProvenanceVerified
  ) {
    const factionCatalogue = getNewRecruitFactionSummary(
      opponentRosterContext.factionId,
    );
    if (!factionCatalogue?.catalogue.id) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNAVAILABLE",
            message:
              "The canonical opponent context does not have a pinned New Recruit catalogue identity.",
            severity: "error",
          },
        ],
        warnings,
      };
    }
    catalogueProvenance = compareNewRecruitCatalogueProvenance(
      prepared.summary,
      {
        releaseId: opponentRosterContext.sourceData.releaseId,
        gameSystem: {
          id: newRecruitCatalogue.gameSystem.id,
          name: newRecruitCatalogue.gameSystem.name,
          revision:
            opponentRosterContext.sourceData.newRecruit.gameSystemRevision,
        },
        catalogue: {
          id: factionCatalogue.catalogue.id,
          name: factionCatalogue.catalogue.name,
          revision:
            opponentRosterContext.sourceData.newRecruit.catalogueRevision,
        },
      },
    );
    if (catalogueProvenance.status !== "matched") {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code:
              catalogueProvenance.status === "drift"
                ? "NEW_RECRUIT_CATALOGUE_DRIFT"
                : "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNVERIFIABLE",
            message:
              "The enriched uploaded opponent does not prove the canonical opponent context's pinned catalogue identity.",
            severity: "error",
          },
        ],
        warnings,
      };
    }
  } else if (!uploadedArtifactProvenanceVerified) {
    const observed = prepared.summary.observedNewRecruitCatalogue;
    if (
      effectiveExecutionMode(options) === "simulate" &&
      (
        preflight.factionId === null ||
        (
          (
            summary.profileCount === 0 ||
            summary.weaponProfileCount === 0
          ) &&
          !observed
        )
      )
    ) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_ROSZ_PROVENANCE_UNVERIFIABLE",
            message:
              "Simulation requires the frozen source and any New Recruit-enriched opponent to retain a compatible 11th-edition game-system and pinned faction catalogue identity.",
            severity: "error",
          },
        ],
        warnings,
      };
    }
    const factionCatalogue = preflight.factionId
      ? getNewRecruitFactionSummary(preflight.factionId)
      : null;
    if (observed && factionCatalogue?.catalogue.id) {
      catalogueProvenance = compareNewRecruitCatalogueProvenance(
        prepared.summary,
        {
          releaseId: playerRoster.sourceData.releaseId,
          gameSystem: {
            id: newRecruitCatalogue.gameSystem.id,
            name: newRecruitCatalogue.gameSystem.name,
            revision:
              playerRoster.sourceData.newRecruit.gameSystemRevision,
          },
          catalogue: {
            id: factionCatalogue.catalogue.id,
            name: factionCatalogue.catalogue.name,
            revision: factionCatalogue.catalogue.revision,
          },
        },
      );
      if (catalogueProvenance.status !== "matched") {
        return {
          ok: false,
          data: null,
          violations: [
            {
              code:
                catalogueProvenance.status === "drift"
                  ? "TESSERA_ROSZ_DATA_PIN_MISMATCH"
                  : "TESSERA_ROSZ_PROVENANCE_UNVERIFIABLE",
              message:
                "The enriched uploaded opponent does not retain the frozen source's pinned game-system and faction catalogue identity.",
              severity: "error",
            },
          ],
          warnings,
        };
      }
    }
  }
  if (pendingPersistentCacheStore) {
    let releaseCacheStoreLease: (() => Promise<void>) | null =
      null;
    try {
      releaseCacheStoreLease =
        await acquireNewRecruitCacheLease(
          pendingPersistentCacheStore.roster,
        );
      await storeNewRecruitCache(
        pendingPersistentCacheStore.roster,
        pendingPersistentCacheStore.delivery,
        {
          runId: mutationRunId,
          mutationAttemptId:
            pendingPersistentCacheStore.mutationAttemptId,
        },
      );
    } catch (error) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "NEW_RECRUIT_CACHE_STORE_FAILED",
            message:
              error instanceof Error
                ? `The verified uploaded roster could not be persisted for safe reuse: ${error.message}`
                : "The verified uploaded roster could not be persisted for safe reuse.",
            severity: "error",
          },
        ],
        warnings,
      };
    } finally {
      await releaseCacheStoreLease?.();
    }
  }
  return {
    ok: true,
    data: {
      ...prepared,
      sourceRoszPath: frozenSourcePath,
      ...(catalogueProvenance ? { catalogueProvenance } : {}),
    },
    violations: [],
    warnings,
  };
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
    const key = rosterExecutionFingerprint(qualified.roster);
    if (seen.has(key) || key === rosterExecutionFingerprint(roster)) return;
    seen.add(key);
    candidates.push({
      candidateId: crypto
        .createHash("sha256")
        .update(
          `${rosterExecutionFingerprint(roster)}:${JSON.stringify(operation)}`,
        )
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

function preparationAccounting(
  rosters: Array<{
    cacheReused?: boolean;
    connectorEvents?: ConnectorEvent[];
  }>,
): { remoteMutations: number; cacheReuses: number } {
  let remoteMutations = 0;
  let cacheReuses = 0;
  for (const roster of rosters) {
    const events = roster.connectorEvents ?? [];
    const reused =
      roster.cacheReused === true ||
      events.some(
        (event) =>
          event.provider === "new-recruit" &&
          event.action === "prepare" &&
          event.outcome === "reused",
      );
    if (reused) {
      cacheReuses += 1;
      continue;
    }
    if (
      events.some(
        (event) =>
          event.provider === "new-recruit" &&
          event.action === "prepare" &&
          event.origin === "new-remote" &&
          event.outcome === "verified",
      )
    ) {
      remoteMutations += 1;
    }
  }
  return { remoteMutations, cacheReuses };
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
  const { remoteMutations, cacheReuses } =
    preparationAccounting([input.player, ...opponents]);
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
  const mutationRunId =
    options.sessionId ?? `tessera-exact-${crypto.randomUUID()}`;
  const basename = `${safeName(playerRoster.name) || "roster"}-matchup`;
  const baselineArtifactName =
    `${basename}-baseline-damage-v1.json`;
  const configuration = analysisConfiguration(options);
  const executionMode = effectiveExecutionMode(options);
  const simulationRequested = executionMode === "simulate";
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
  const opponentScopeIssue = exactOpponentScopeIssue(opponent);
  if (opponentScopeIssue) {
    return {
      ok: false,
      data: null,
      violations: [opponentScopeIssue],
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
    const compatibilityIssue = canonicalOpponentCompatibilityIssue(
      playerRoster,
      opponent.roster,
    );
    if (compatibilityIssue) {
      return {
        ok: false,
        data: null,
        violations: [compatibilityIssue],
        warnings: [
          ...playerValidation.warnings,
          ...opponentValidation.warnings,
        ],
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
  let uploadedPreflight: UploadedRoszPreflight | null = null;
  if (opponent.kind === "rosz") {
    const inspected = await inspectUploadedRoszPreflight(
      opponent.path,
      playerRoster,
      options.opponentRosterContext,
      hasVerifiedUploadedArtifactCapability(
        options.verifiedUploadedArtifactCapability,
      ),
    );
    if (!inspected.ok || !inspected.data) {
      return {
        ok: false,
        data: null,
        violations: inspected.violations,
        warnings: inspected.warnings,
      };
    }
    uploadedPreflight = inspected.data;
    const preflightPoints = pointsComparison(
      playerRoster.totalPoints,
      uploadedPreflight.summary.totalPoints,
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
          ...uploadedPreflight.warnings,
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
  const profileRequirements = mergedProfileRequirements([
    aggregateProfileRequirements([
      playerRoster,
      ...(opponent.kind === "roster" ? [opponent.roster] : []),
      ...(opponent.kind === "rosz" && options.opponentRosterContext
        ? [options.opponentRosterContext]
        : []),
      ...factionProxyItems.map((item) => item.roster),
    ]),
    uploadedPreflight?.profileRequirements ?? [],
    options.frozenProfileRequirements ?? [],
  ]);
  const profileValidation = validateProfilePolicy(
    profileRequirements,
    profilePolicy,
  );
  const enforceProfilePolicy = simulationRequested;
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
    const profileDetail = [
      ...profileValidation.errors,
      ...profileValidation.unresolved.map(
        (requirement) =>
          `${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase}: choose one of ${requirement.availableProfiles.join(", ")} for ${requirement.activeCount} active weapon(s).`,
      ),
    ].join(" ");
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_PROFILE_POLICY_REQUIRED",
          message: `Explicit weapon-profile choices are required before New Recruit or Tessera activity.${
            profileDetail ? ` ${profileDetail}` : ""
          }${
            scaffoldPath ? ` Complete ${scaffoldPath}.` : ""
          }`,
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  if (simulationRequested && !dependencies.runBrowser) {
    const readiness = await getTesseraConnectionStatus();
    if (!readiness.ok || !readiness.data?.available) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_READINESS_PROBE_FAILED",
            message:
              readiness.violations[0]?.message ??
              readiness.warnings[0]?.message ??
              "The local Tessera agent, browser, or premium credential is not ready. No New Recruit lists were created.",
            severity: "error",
          },
        ],
        warnings: readiness.warnings,
      };
    }
  }
  try {
    await resolveExportArtifactTargets(
      [
        {
          format: "roster-json",
          filename: `${basename}.json`,
          mimeType: "application/json",
          encoding: "utf8",
          content: "",
        },
        {
          format: "html",
          filename: `${basename}.html`,
          mimeType: "text/html; charset=utf-8",
          encoding: "utf8",
          content: "",
        },
        {
          format: "roster-json",
          filename: `${basename}.receipt.json`,
          mimeType: "application/json",
          encoding: "utf8",
          content: "",
        },
        ...(options.fallbackMode === "baseline-damage-v1"
          ? [
              {
                format: "roster-json" as const,
                filename: baselineArtifactName,
                mimeType: "application/json",
                encoding: "utf8" as const,
                content: "",
              },
            ]
          : []),
      ],
      outputDirectory,
      options,
    );
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_OUTPUT_RESERVATION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "The exact-matchup output paths could not be reserved before external activity.",
          severity: "error",
        },
      ],
      warnings: playerValidation.warnings,
    };
  }
  let releaseOutputLease: (() => Promise<void>) | null = null;
  try {
    const resolvedOutputDirectory = path.resolve(
      options.rootDir ?? process.cwd(),
      outputDirectory,
    );
    releaseOutputLease = await acquireDirectoryLease(
      path.join(
        resolvedOutputDirectory,
        `.${basename}.exact-output.lock`,
      ),
      0,
    );
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_OUTPUT_LEASED",
          message:
            error instanceof Error
              ? `Another exact run owns these output paths: ${error.message}`
              : "Another exact run owns these output paths.",
          severity: "error",
        },
      ],
      warnings: playerValidation.warnings,
    };
  }
  try {
  let frozenUploadedSourcePath: string | null = null;
  if (
    opponent.kind === "rosz" &&
    !options.preparedReuse?.opponent &&
    !options.frozenOpponentReuse
  ) {
    if (!uploadedPreflight) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_ROSZ_PREFLIGHT_MISSING",
            message:
              "The uploaded opponent preflight was not retained before external activity.",
            severity: "error",
          },
        ],
        warnings: playerValidation.warnings,
      };
    }
    const frozen = await freezeUploadedRoszPreflight(
      path.join(outputDirectory, "opponent"),
      options,
      uploadedPreflight,
    );
    if (!frozen.ok || !frozen.data) {
      return {
        ok: false,
        data: null,
        violations: frozen.violations,
        warnings: frozen.warnings,
      };
    }
    frozenUploadedSourcePath = frozen.data;
  }
  const player = options.preparedReuse
    ? await verifiedPreparedRosterReuse(
        options.preparedReuse.player,
        playerRoster,
      )
    : await prepareRosterForTessera(
        playerRoster,
        {
          ...options,
          mutationRunId,
          outputDirectory: path.join(outputDirectory, "player"),
        },
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
  let preparedPlayer: TesseraPreparedRoster;
  try {
    preparedPlayer = await materializePreparedRosterArtifacts(
      player.data,
      path.join(outputDirectory, "player"),
      options,
    );
  } catch (error) {
    const violation: RosterIssue = {
      code: "TESSERA_ARTIFACT_MATERIALIZATION_FAILED",
      message:
        error instanceof Error
          ? error.message
          : "The verified player archives could not be materialized into the exact run bundle.",
      severity: "error",
    };
    return {
      ok: false,
      data: failedPreparationReport({
        playerRoster,
        player: player.data,
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

  const opponents: TesseraMatchupReport["opponents"] = [];
  const opponentDrafts: Array<RosterDraftV1 | null> = [];
  const warnings: string[] = [
    ...player.warnings,
    ...(uploadedPreflight?.warnings ?? []),
  ].map((warning) => warning.message);
  if (opponent.kind === "roster") {
    const prepared = options.preparedReuse?.opponent
      ? await verifiedPreparedRosterReuse(
          options.preparedReuse.opponent,
          opponent.roster,
        )
      : await prepareRosterForTessera(
          opponent.roster,
          {
            ...options,
            mutationRunId,
            outputDirectory: path.join(outputDirectory, "opponent"),
          },
          dependencies,
        );
    if (!prepared.ok || !prepared.data) {
      const preparedOpponent = prepared.data
        ? [
            {
              kind: "roster" as const,
              rosterName: prepared.data.rosterName,
              sourceRoszPath: prepared.data.sourceRoszPath,
              enrichedRoszPath: prepared.data.enrichedRoszPath,
              sourceRoszSha256:
                prepared.data.sourceRoszSha256,
              enrichedRoszSha256:
                prepared.data.enrichedRoszSha256,
              summary: prepared.data.summary,
              fingerprint: rosterExecutionFingerprint(opponent.roster),
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
    let materializedOpponent: TesseraPreparedRoster;
    try {
      materializedOpponent =
        await materializePreparedRosterArtifacts(
          prepared.data,
          path.join(outputDirectory, "opponent"),
          options,
        );
    } catch (error) {
      const violation: RosterIssue = {
        code: "TESSERA_ARTIFACT_MATERIALIZATION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The verified opponent archives could not be materialized into the exact run bundle.",
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
          warnings: [...player.warnings, ...prepared.warnings],
          opponentName: opponent.roster.name,
        }),
        violations: [violation],
        warnings: [...player.warnings, ...prepared.warnings],
      };
    }
    opponents.push({
      kind: "roster",
      rosterName: materializedOpponent.rosterName,
      sourceRoszPath: materializedOpponent.sourceRoszPath,
      enrichedRoszPath: materializedOpponent.enrichedRoszPath,
      sourceRoszSha256:
        materializedOpponent.sourceRoszSha256,
      enrichedRoszSha256:
        materializedOpponent.enrichedRoszSha256,
      summary: materializedOpponent.summary,
      fingerprint: rosterExecutionFingerprint(opponent.roster),
      units: canonicalUnits(opponent.roster, "opponent"),
      cacheReused: materializedOpponent.cacheReused,
      connectorEvents: materializedOpponent.connectorEvents,
      catalogueProvenance:
        materializedOpponent.catalogueProvenance,
    });
    opponentDrafts.push(opponent.roster);
  } else if (opponent.kind === "rosz") {
    if (!uploadedPreflight) {
      throw new Error("Uploaded ROSZ preflight was not retained.");
    }
    const frozenOpponentReuse =
      options.preparedReuse?.opponent ??
      options.frozenOpponentReuse;
    if (frozenOpponentReuse) {
      const reused = await verifiedPreparedRosterReuse(
        frozenOpponentReuse,
        options.opponentRosterContext ?? null,
      );
      if (!reused.ok || !reused.data) {
        return {
          ok: false,
          data: failedPreparationReport({
            playerRoster,
            player: preparedPlayer,
            opponents,
            simulationRequested,
            configuration,
            profilePolicy,
            violations: reused.violations,
            warnings: [...player.warnings, ...reused.warnings],
            opponentName: path.basename(opponent.path),
          }),
          violations: reused.violations,
          warnings: [...player.warnings, ...reused.warnings],
        };
      }
      let materializedOpponent: TesseraPreparedRoster;
      try {
        materializedOpponent =
          await materializePreparedRosterArtifacts(
            reused.data,
            path.join(outputDirectory, "opponent"),
            options,
          );
      } catch (error) {
        const violation: RosterIssue = {
          code: "TESSERA_ARTIFACT_MATERIALIZATION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "The verified uploaded opponent checkpoint could not be materialized into the exact run bundle.",
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
            warnings: [...player.warnings, ...reused.warnings],
            opponentName: reused.data.rosterName,
          }),
          violations: [violation],
          warnings: [...player.warnings, ...reused.warnings],
        };
      }
      opponents.push({
        kind: "rosz",
        rosterName: materializedOpponent.rosterName,
        sourceRoszPath: materializedOpponent.sourceRoszPath,
        enrichedRoszPath: materializedOpponent.enrichedRoszPath,
        sourceRoszSha256:
          materializedOpponent.sourceRoszSha256,
        enrichedRoszSha256:
          materializedOpponent.enrichedRoszSha256,
        summary: materializedOpponent.summary,
        fingerprint: materializedOpponent.fingerprint,
        units:
          materializedOpponent.units ??
          enrichedUnits(materializedOpponent.summary, "opponent"),
        cacheReused: true,
        connectorEvents: [],
        catalogueProvenance:
          materializedOpponent.catalogueProvenance,
      });
      warnings.push(...reused.warnings.map((warning) => warning.message));
      opponentDrafts.push(options.opponentRosterContext ?? null);
    } else {
    if (!frozenUploadedSourcePath) {
      return {
        ok: false,
        data: failedPreparationReport({
          playerRoster,
          player: preparedPlayer,
          opponents,
          simulationRequested,
          configuration,
          profilePolicy,
          violations: [
            {
              code: "TESSERA_ROSZ_FROZEN_SOURCE_MISSING",
              message:
                "The uploaded opponent was not frozen before New Recruit activity.",
              severity: "error",
            },
          ],
          warnings: player.warnings,
          opponentName: path.basename(opponent.path),
        }),
        violations: [
          {
            code: "TESSERA_ROSZ_FROZEN_SOURCE_MISSING",
            message:
              "The uploaded opponent was not frozen before New Recruit activity.",
            severity: "error",
          },
        ],
        warnings: player.warnings,
      };
    }
    const prepared = await prepareUploadedRosz(
      frozenUploadedSourcePath,
      path.join(outputDirectory, "opponent"),
      options,
      dependencies,
      uploadedPreflight,
      playerRoster,
      options.opponentRosterContext,
      mutationRunId,
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
    let uploadedArtifact: TesseraPreparedRoster;
    try {
      uploadedArtifact = await materializePreparedRosterArtifacts(
        {
          rosterId:
            options.opponentRosterContext?.id ??
            uploadedPreflight.gameplayFingerprint,
          rosterName: prepared.data.rosterName,
          factionId:
            options.opponentRosterContext?.factionId ??
            uploadedPreflight.factionId ??
            undefined,
          listUrl: prepared.data.listUrl,
          sourceRoszPath: prepared.data.sourceRoszPath,
          enrichedRoszPath: prepared.data.enrichedRoszPath,
          summary: prepared.data.summary,
          fingerprint:
            options.opponentRosterContext
              ? rosterExecutionFingerprint(
                  options.opponentRosterContext,
                )
              : uploadedPreflight.gameplayFingerprint,
          units:
            options.opponentRosterContext
              ? canonicalUnits(
                  options.opponentRosterContext,
                  "opponent",
                )
              : enrichedUnits(
                  prepared.data.summary,
                  "opponent",
                ),
          cacheReused: prepared.data.cacheReused,
          connectorEvents: prepared.data.connectorEvents,
          catalogueProvenance:
            prepared.data.catalogueProvenance,
        },
        path.join(outputDirectory, "opponent"),
        options,
      );
    } catch (error) {
      const violation: RosterIssue = {
        code: "TESSERA_ARTIFACT_MATERIALIZATION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The verified uploaded opponent archive could not be materialized into the exact run bundle.",
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
          warnings: [...player.warnings, ...prepared.warnings],
          opponentName: prepared.data.rosterName,
        }),
        violations: [violation],
        warnings: [...player.warnings, ...prepared.warnings],
      };
    }
    opponents.push({
      kind: "rosz",
      rosterName: prepared.data.rosterName,
      sourceRoszPath: uploadedArtifact.sourceRoszPath,
      enrichedRoszPath: uploadedArtifact.enrichedRoszPath,
      sourceRoszSha256:
        uploadedArtifact.sourceRoszSha256,
      enrichedRoszSha256:
        uploadedArtifact.enrichedRoszSha256,
      summary: prepared.data.summary,
      fingerprint: uploadedArtifact.fingerprint,
      units: uploadedArtifact.units,
      cacheReused: prepared.data.cacheReused,
      connectorEvents: prepared.data.connectorEvents,
      catalogueProvenance: prepared.data.catalogueProvenance,
    });
    opponentDrafts.push(options.opponentRosterContext ?? null);
    }
  } else {
    for (const item of factionProxyItems) {
      const prepared = await prepareRosterForTessera(
        item.roster,
        {
          ...options,
          mutationRunId,
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
      let materializedOpponent: TesseraPreparedRoster;
      try {
        materializedOpponent =
          await materializePreparedRosterArtifacts(
            prepared.data,
            path.join(
              outputDirectory,
              "opponents",
              item.templateId.replace(":", "-"),
            ),
            options,
          );
      } catch (error) {
        const violation: RosterIssue = {
          code: "TESSERA_ARTIFACT_MATERIALIZATION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "A verified faction-proxy archive could not be materialized into the run bundle.",
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
            warnings: [...player.warnings, ...prepared.warnings],
            opponentName: item.roster.name,
          }),
          violations: [violation],
          warnings: [...player.warnings, ...prepared.warnings],
        };
      }
      opponents.push({
        kind: "faction-archetype",
        archetype: item.posture,
        rosterName: materializedOpponent.rosterName,
        enrichedRoszPath: materializedOpponent.enrichedRoszPath,
        enrichedRoszSha256:
          materializedOpponent.enrichedRoszSha256,
        summary: materializedOpponent.summary,
        fingerprint:
          item.simulationFingerprint ??
          rosterExecutionFingerprint(item.roster),
        units: canonicalUnits(item.roster, "opponent"),
        cacheReused: materializedOpponent.cacheReused,
        connectorEvents: materializedOpponent.connectorEvents,
        catalogueProvenance:
          materializedOpponent.catalogueProvenance,
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

  const preparedProfileInspections = await Promise.all([
    inspectPreparedProfileRequirements(
      preparedPlayer,
      playerRoster.factionId,
    ),
    ...opponents.map((prepared, index) =>
      inspectPreparedProfileRequirements(
        prepared,
        opponentDrafts[index]?.factionId ??
          factionIdentityForUploadedSummary(prepared.summary),
      ),
    ),
  ]);
  const failedProfileInspection = preparedProfileInspections.find(
    (inspection) => !inspection.ok || !inspection.data,
  );
  if (failedProfileInspection) {
    return {
      ok: false,
      data: failedPreparationReport({
        playerRoster,
        player: preparedPlayer,
        opponents,
        simulationRequested,
        configuration,
        profilePolicy,
        violations: failedProfileInspection.violations,
        warnings: warnings.map((message) => ({
          code: "TESSERA_WARNING",
          message,
          severity: "warn" as const,
        })),
      }),
      violations: failedProfileInspection.violations,
      warnings: [
        ...player.warnings,
        ...failedProfileInspection.warnings,
      ],
    };
  }
  const enrichedProfileRequirements = mergedProfileRequirements([
    profileRequirements,
    ...preparedProfileInspections.map(
      (inspection) => inspection.data ?? [],
    ),
  ]);
  const enrichedProfileValidation = validateProfilePolicy(
    enrichedProfileRequirements,
    profilePolicy,
  );
  if (simulationRequested && !enrichedProfileValidation.valid) {
    let scaffoldPath: string | null = null;
    try {
      scaffoldPath = await writeExportArtifact(
        {
          format: "roster-json",
          filename: "profile-policy.enriched.scaffold.json",
          mimeType: "application/json",
          encoding: "utf8",
          content: `${JSON.stringify(
            profilePolicyScaffold(enrichedProfileRequirements),
            null,
            2,
          )}\n`,
        },
        path.join(
          outputDirectory,
          "profile-policy.enriched.scaffold.json",
        ),
        options,
      );
    } catch {
      // The prepared artifacts remain reusable even if scaffold writing fails.
    }
    const violation: RosterIssue = {
      code: "TESSERA_PROFILE_POLICY_REQUIRED_AFTER_ENRICHMENT",
      message:
        `New Recruit exposed additional alternate weapon profiles. Tessera was not started; complete the expanded policy${
          scaffoldPath ? ` at ${scaffoldPath}` : ""
        }. The verified prepared archives can be reused.`,
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
        warnings: warnings.map((message) => ({
          code: "TESSERA_WARNING",
          message,
          severity: "warn" as const,
        })),
      }),
      violations: [violation],
      warnings: player.warnings,
    };
  }

  const matrices: TesseraMatchupReport["simulation"]["matrices"] = [];
  const scenarios: TesseraScenarioResult[] = [];
  const settings: Record<string, string> = {};
  const failures: NonNullable<TesseraMatchupReport["failures"]> = [];
  const simulationConnectorEvents: ConnectorEvent[] = [];
  const tesseraUiIdentities = new Set<string>();
  let tesseraUiIdentityComplete = true;
  let legacyProjection:
    | NonNullable<
        TesseraMatchupReport["simulation"]["legacyProjection"]
      >
    | undefined;
  let captureIntegrityClean = true;
  let profileResolutionClean = true;
  if (simulationRequested) {
    for (const [opponentIndex, prepared] of opponents.entries()) {
      const profileDirectory = await mkdtemp(
        path.join(os.tmpdir(), "rosterpilot-tessera-"),
      );
      try {
        const savedListReuse =
          preparedPlayer.enrichedRoszSha256 &&
          preparedPlayer.fingerprint &&
          prepared.enrichedRoszSha256 &&
          prepared.fingerprint
            ? createTesseraSavedListReuse({
                runId: mutationRunId,
                profilePolicy,
                player: {
                  enrichedRoszSha256:
                    preparedPlayer.enrichedRoszSha256,
                  rosterExecutionFingerprint:
                    preparedPlayer.fingerprint,
                  expectedUnitCount:
                    preparedPlayer.summary.units.length,
                },
                opponent: {
                  enrichedRoszSha256:
                    prepared.enrichedRoszSha256,
                  rosterExecutionFingerprint:
                    prepared.fingerprint,
                  expectedUnitCount:
                    prepared.summary.units.length,
                },
                playerProfileRequirements:
                  preparedProfileInspections[0]?.data ?? [],
                opponentProfileRequirements:
                  preparedProfileInspections[opponentIndex + 1]?.data ??
                  [],
              })
            : null;
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
          savedListReuse,
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
        if (result.uiIdentity) {
          tesseraUiIdentities.add(result.uiIdentity);
        } else {
          tesseraUiIdentityComplete = false;
        }
        warnings.push(...result.warnings);
        const unresolvedAlternateProfiles = (result.importIssues ?? []).filter(
          (issue) =>
            issue.code === "alternate-profile" &&
            !issue.resolvedByPolicy,
        );
        if (unresolvedAlternateProfiles.length > 0) {
          profileResolutionClean = false;
          failures.push({
            stage: "simulation",
            code: "TESSERA_PROFILE_POLICY_NOT_APPLIED",
            message:
              `Tessera reported ${unresolvedAlternateProfiles.length} unresolved alternate-profile choice(s). The captured matrices are retained, but cannot support matchup conclusions.`,
            opponentName: prepared.rosterName,
            retryable: false,
          });
        }
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
    profileResolutionClean &&
    tesseraUiIdentityComplete &&
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
  const { remoteMutations, cacheReuses } =
    preparationAccounting([preparedPlayer, ...opponents]);
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
      remoteMutations,
      cacheReuses,
      connectorEvents: preparationConnectorEvents,
    },
    failures,
    profilePolicyHash: profilePolicy
      ? profilePolicyHash(profilePolicy)
      : null,
    frozenProfileRequirements: structuredClone(
      enrichedProfileRequirements,
    ),
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
    const resolvedOutputDirectory = path.resolve(
      options.rootDir ?? process.cwd(),
      outputDirectory,
    );
    const portablePath = (filename: string): string => {
      const relative = path.relative(
        resolvedOutputDirectory,
        path.resolve(filename),
      );
      return relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
        ? filename
        : relative;
    };
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
      {
        format: "matchup-receipt",
        written: `${basename}.receipt.json`,
      },
    ];
    const portableReport: TesseraMatchupReport = {
      ...report,
      player: {
        ...report.player,
        sourceRoszPath: portablePath(
          report.player.sourceRoszPath,
        ),
        enrichedRoszPath: portablePath(
          report.player.enrichedRoszPath,
        ),
      },
      opponents: report.opponents.map((prepared) => ({
        ...prepared,
        ...(prepared.sourceRoszPath
          ? {
              sourceRoszPath: portablePath(
                prepared.sourceRoszPath,
              ),
            }
          : {}),
        enrichedRoszPath: portablePath(
          prepared.enrichedRoszPath,
        ),
      })),
      artifacts: portableArtifacts,
    };
    const serializedPortableReport =
      `${JSON.stringify(portableReport, null, 2)}\n`;
    const artifacts: ExportArtifact[] = [
      {
        format: "roster-json",
        filename: `${basename}.json`,
        mimeType: "application/json",
        encoding: "utf8",
        content: serializedPortableReport,
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
    const receipt = createExactReportReceipt(
      written[0],
      serializedPortableReport,
      portableReport,
    );
    const receiptWritten = await writeExportArtifact(
      {
        format: "roster-json",
        filename: `${basename}.receipt.json`,
        mimeType: "application/json",
        encoding: "utf8",
        content: `${JSON.stringify(receipt, null, 2)}\n`,
      },
      path.join(outputDirectory, `${basename}.receipt.json`),
      options,
    );
    report.artifacts = portableArtifacts.map((artifact, index) => ({
      ...artifact,
      written:
        artifact.format === "matchup-receipt"
          ? receiptWritten
          : written[index],
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
  } finally {
    await releaseOutputLease?.();
  }
}

function metricValue(
  values: TesseraMetricValues,
  metric: TesseraMetric,
): number | null {
  return values[metricField(metric)] ?? null;
}

function revisionMaterialityThreshold(
  metric: TesseraMetric,
  baseline: number,
): number {
  if (
    metric === "wipe-probability" ||
    metric === "half-wipe-probability"
  ) {
    return 0.05;
  }
  if (metric === "mean-kills") {
    return Math.max(0.5, Math.abs(baseline) * 0.1);
  }
  return Math.max(1, Math.abs(baseline) * 0.1);
}

function revisionChangeIsMaterial(
  directionalChange: number,
  materialityThreshold: number,
): boolean {
  const numericTolerance = Math.max(
    Number.EPSILON * 16,
    Math.abs(materialityThreshold) * 1e-12,
  );
  return (
    Math.abs(directionalChange) + numericTolerance >=
    materialityThreshold
  );
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
            const materialityThreshold = revisionMaterialityThreshold(
              metric,
              before.value!,
            );
            classification =
              revisionChangeIsMaterial(
                directionalChange,
                materialityThreshold,
              )
                ? directionalChange > 0
                  ? "improved"
                  : "worsened"
                : "unchanged";
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

function trustedScenarioMean(
  scenario: TesseraScenarioResult,
  metric: TesseraMetric,
): { mean: number; cells: number } | null {
  const metricRun = scenario.metricRuns?.find(
    (run) => run.metric === metric,
  );
  if (
    scenario.status !== "complete" ||
    !scenario.metrics.includes(metric) ||
    !metricRun ||
    metricRun.integrity?.status !== "trusted" ||
    !metricRun.matrixSha256
  ) {
    return null;
  }
  const values: number[] = [];
  for (const cell of scenario.cells) {
    const value = metricValue(cell.values, metric);
    if (
      cell.confidence === "ambiguous" ||
      value === null ||
      !Number.isFinite(value)
    ) {
      return null;
    }
    values.push(value);
  }
  if (values.length === 0) return null;
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    cells: values.length,
  };
}

function revisionScenarioKey(
  scenario: TesseraScenarioResult,
): string {
  return [
    scenario.opponentName,
    scenario.phase,
    scenario.direction,
  ].join("|");
}

function revisionAggregates(
  baseline: TesseraMatchupReport,
  revisedReports: TesseraMatchupReport[],
): TesseraRevisionAggregate[] {
  const metrics = baseline.configuration?.metrics ?? [];
  const revisedScenarioBuckets = new Map<
    string,
    TesseraScenarioResult[]
  >();
  for (const report of revisedReports) {
    for (const scenario of report.simulation.scenarios ?? []) {
      const key = revisionScenarioKey(scenario);
      const bucket = revisedScenarioBuckets.get(key) ?? [];
      bucket.push(scenario);
      revisedScenarioBuckets.set(key, bucket);
    }
  }

  type AggregateAccumulator = {
    metric: TesseraMetric;
    direction: TesseraDirection;
    opponentNames: Set<string>;
    phases: Set<TesseraPhase>;
    expectedScenarios: number;
    applicableScenarios: number;
    baselineCells: number;
    revisedCells: number;
    baselineMeanSum: number;
    revisedMeanSum: number;
  };
  const accumulators = new Map<string, AggregateAccumulator>();
  for (const baselineScenario of baseline.simulation.scenarios ?? []) {
    const revisedBucket =
      revisedScenarioBuckets.get(
        revisionScenarioKey(baselineScenario),
      ) ?? [];
    const revisedScenario = revisedBucket.shift() ?? null;
    for (const metric of metrics) {
      const key = `${metric}|${baselineScenario.direction}`;
      const accumulator =
        accumulators.get(key) ??
        {
          metric,
          direction: baselineScenario.direction,
          opponentNames: new Set<string>(),
          phases: new Set<TesseraPhase>(),
          expectedScenarios: 0,
          applicableScenarios: 0,
          baselineCells: 0,
          revisedCells: 0,
          baselineMeanSum: 0,
          revisedMeanSum: 0,
        };
      accumulator.opponentNames.add(baselineScenario.opponentName);
      accumulator.phases.add(baselineScenario.phase);
      accumulator.expectedScenarios += 1;
      const before = trustedScenarioMean(
        baselineScenario,
        metric,
      );
      const after = revisedScenario
        ? trustedScenarioMean(revisedScenario, metric)
        : null;
      if (before && after) {
        accumulator.applicableScenarios += 1;
        accumulator.baselineCells += before.cells;
        accumulator.revisedCells += after.cells;
        accumulator.baselineMeanSum += before.mean;
        accumulator.revisedMeanSum += after.mean;
      }
      accumulators.set(key, accumulator);
    }
  }

  return [...accumulators.values()]
    .map((accumulator): TesseraRevisionAggregate => {
      const applicable =
        accumulator.expectedScenarios > 0 &&
        accumulator.applicableScenarios ===
          accumulator.expectedScenarios;
      if (!applicable) {
        return {
          metric: accumulator.metric,
          direction: accumulator.direction,
          opponentNames: [...accumulator.opponentNames].sort(),
          phases: [...accumulator.phases].sort(),
          expectedScenarios: accumulator.expectedScenarios,
          applicableScenarios: accumulator.applicableScenarios,
          baselineCells: accumulator.baselineCells,
          revisedCells: accumulator.revisedCells,
          before: null,
          after: null,
          directionalChange: null,
          materialityThreshold: null,
          classification: "ambiguous",
        };
      }
      const before =
        accumulator.baselineMeanSum /
        accumulator.applicableScenarios;
      const after =
        accumulator.revisedMeanSum /
        accumulator.applicableScenarios;
      const rawChange = after - before;
      const directionalChange =
        accumulator.direction === "player-to-opponent"
          ? rawChange
          : -rawChange;
      const materialityThreshold = revisionMaterialityThreshold(
        accumulator.metric,
        before,
      );
      const materiallyChanged = revisionChangeIsMaterial(
        directionalChange,
        materialityThreshold,
      );
      return {
        metric: accumulator.metric,
        direction: accumulator.direction,
        opponentNames: [...accumulator.opponentNames].sort(),
        phases: [...accumulator.phases].sort(),
        expectedScenarios: accumulator.expectedScenarios,
        applicableScenarios: accumulator.applicableScenarios,
        baselineCells: accumulator.baselineCells,
        revisedCells: accumulator.revisedCells,
        before,
        after,
        directionalChange,
        materialityThreshold,
        classification: !materiallyChanged
          ? "unchanged"
          : directionalChange > 0
            ? "improved"
            : "worsened",
      };
    })
    .sort(
      (left, right) =>
        left.metric.localeCompare(right.metric) ||
        left.direction.localeCompare(right.direction),
    );
}

function frozenScenarioContractFromBaseline(
  baseline: TesseraMatchupReport,
): ResultEnvelope<TesseraFrozenScenarioContract[]> {
  const configuration = baseline.configuration;
  if (!configuration) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_SCENARIO_CONTRACT_MISSING",
          message: "The baseline does not include its analysis configuration.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const contract: TesseraFrozenScenarioContract[] = [];
  for (const scenario of baseline.simulation.scenarios ?? []) {
    const metricRuns = scenario.metricRuns ?? [];
    const runsByMetric = new Map(
      metricRuns.map((run) => [run.metric, run]),
    );
    for (const metric of configuration.metrics) {
      const run = runsByMetric.get(metric);
      if (
        !run ||
        !run.matrixSha256 ||
        run.integrity?.status !== "trusted"
      ) {
        return {
          ok: false,
          data: null,
          violations: [
            {
              code: "TESSERA_BASELINE_SCENARIO_CONTRACT_MISSING",
              message:
                `Baseline scenario ${scenario.scenarioId} does not contain trusted, hash-identified evidence for ${metric}.`,
              severity: "error",
            },
          ],
          warnings: [],
        };
      }
      contract.push({
        phase: scenario.phase,
        direction: scenario.direction,
        metric,
        settings: { ...run.settings },
        iterations: run.iterations,
      });
    }
  }
  const unique = new Map(
    contract.map((entry) => [
      `${entry.phase}:${entry.direction}:${entry.metric}`,
      entry,
    ]),
  );
  const expected =
    configuration.phases.length *
    configuration.directions.length *
    configuration.metrics.length;
  if (unique.size !== expected) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_SCENARIO_CONTRACT_MISMATCH",
          message:
            `The baseline contains ${unique.size} unique scenario controls; ${expected} are required by its frozen configuration.`,
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  return {
    ok: true,
    data: [...unique.values()].sort(
      (left, right) =>
        left.phase.localeCompare(right.phase) ||
        left.direction.localeCompare(right.direction) ||
        left.metric.localeCompare(right.metric),
    ),
    violations: [],
    warnings: [],
  };
}

function baselineSourceCompatible(
  baseline: NonNullable<TesseraMatchupReport["pinnedData"]>,
  revised: RosterDraftV1["sourceData"],
): boolean {
  return (
    baseline.edition === revised.edition &&
    ("bundleId" in baseline &&
    "bundleId" in revised
      ? baseline.bundleId === revised.bundleId &&
        baseline.engineDataSchemaVersion ===
          revised.engineDataSchemaVersion
      : baseline.releaseId === revised.releaseId &&
        baseline.newRecruit.repository ===
          revised.newRecruit.repository &&
        baseline.newRecruit.commit === revised.newRecruit.commit &&
        baseline.newRecruit.gameSystemRevision ===
          revised.newRecruit.gameSystemRevision &&
        baseline.official.contentSha256 ===
          revised.official.contentSha256)
  );
}

async function verifyFrozenExactRosterArtifacts(
  reportDirectory: string,
  prepared: {
    rosterName: string;
    sourceRoszPath?: string;
    enrichedRoszPath: string;
    sourceRoszSha256?: string;
    enrichedRoszSha256?: string;
    summary: EnrichedRoszSummary;
  },
): Promise<
  | {
      sourcePath: string;
      enrichedPath: string;
    }
  | string
> {
  if (
    !prepared.sourceRoszPath ||
    !prepared.sourceRoszSha256 ||
    !prepared.enrichedRoszSha256
  ) {
    return "The frozen roster is missing a source or enriched archive receipt.";
  }
  const resolveArtifact = (filename: string) =>
    path.isAbsolute(filename)
      ? filename
      : path.resolve(reportDirectory, filename);
  const sourcePath = resolveArtifact(prepared.sourceRoszPath);
  const enrichedPath = resolveArtifact(prepared.enrichedRoszPath);
  try {
    const [source, enriched] = await Promise.all([
      readFile(sourcePath),
      readFile(enrichedPath),
    ]);
    if (
      sha256(source) !== prepared.sourceRoszSha256 ||
      sha256(enriched) !== prepared.enrichedRoszSha256
    ) {
      return "A frozen archive content hash differs from its receipt.";
    }
    const actualSummary = inspectEnrichedRosz(enriched);
    if (!summariesGameplayCompatible(actualSummary, prepared.summary)) {
      return "The enriched archive summary differs from the frozen report.";
    }
    const gameplayMismatches = compareRoszGameplaySnapshots(
      inspectRoszGameplaySnapshot(source),
      inspectRoszGameplaySnapshot(enriched),
    );
    if (gameplayMismatches.length > 0) {
      return `The source and enriched archives differ in ${gameplayMismatches.join(", ")}.`;
    }
    return { sourcePath, enrichedPath };
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "The frozen archives could not be inspected.";
  }
}

export async function compareRosterRevision(
  baselineReportPath: string,
  revisedRoster: RosterDraftV1,
  options: TesseraAnalysisOptions = {},
  dependencies: TesseraDependencies = {},
): Promise<ResultEnvelope<TesseraRevisionComparisonReport>> {
  let baseline: TesseraMatchupReport;
  let serializedBaseline: string;
  try {
    serializedBaseline = await readFile(
      baselineReportPath,
      "utf8",
    );
    baseline = JSON.parse(serializedBaseline) as TesseraMatchupReport;
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
    baseline.schemaVersion !== 3 ||
    !baseline.runId ||
    !baseline.configuration ||
    !Array.isArray(baseline.opponents) ||
    baseline.opponents.length === 0 ||
    !baseline.simulation ||
    !Array.isArray(baselineScenarios) ||
    baselineScenarios.length === 0 ||
    !baseline.pinnedData ||
    !baseline.player.fingerprint ||
    !/^[0-9a-f]{64}$/.test(baseline.player.fingerprint) ||
    !baseline.player.sourceRoszSha256 ||
    !/^[0-9a-f]{64}$/.test(baseline.player.sourceRoszSha256) ||
    !baseline.player.enrichedRoszSha256 ||
    !/^[0-9a-f]{64}$/.test(
      baseline.player.enrichedRoszSha256,
    ) ||
    baseline.opponents.some(
      (opponent) =>
        !opponent.fingerprint ||
        !/^[0-9a-f]{64}$/.test(opponent.fingerprint) ||
        !opponent.sourceRoszPath ||
        !opponent.sourceRoszSha256 ||
        !/^[0-9a-f]{64}$/.test(
          opponent.sourceRoszSha256,
        ) ||
        !opponent.enrichedRoszSha256 ||
        !/^[0-9a-f]{64}$/.test(
          opponent.enrichedRoszSha256,
        ),
    ) ||
    (
      baseline.profilePolicyHash !== null &&
      baseline.profilePolicyHash !== undefined &&
      !Array.isArray(baseline.frozenProfileRequirements)
    ) ||
    !baseline.tesseraUiIdentity
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_INCOMPATIBLE",
          message:
            "Revision comparison requires a complete schema-v3 baseline with frozen source provenance, execution fingerprints, Tessera UI identity, and captured scenarios.",
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
  let baselineReceipt: unknown;
  try {
    baselineReceipt = JSON.parse(
      await readFile(
        exactReportReceiptPath(baselineReportPath),
        "utf8",
      ),
    );
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_RECEIPT_MISSING",
          message:
            `A paired revision requires the exact baseline receipt beside the report: ${
              error instanceof Error
                ? error.message
                : "receipt unreadable"
            }`,
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const receiptIssue = verifyExactReportReceipt(
    baselineReportPath,
    serializedBaseline,
    baseline,
    baselineReceipt,
  );
  if (receiptIssue) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_INTEGRITY_CHANGED",
          message: receiptIssue,
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const frozenScenarioContract =
    frozenScenarioContractFromBaseline(baseline);
  if (!frozenScenarioContract.ok || !frozenScenarioContract.data) {
    return {
      ok: false,
      data: null,
      violations: frozenScenarioContract.violations,
      warnings: frozenScenarioContract.warnings,
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
  if (!baselineSourceCompatible(baseline.pinnedData, revisedRoster.sourceData)) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_REVISION_DATA_PIN_CHANGED",
          message:
            `The revised roster uses ${revisedRoster.sourceData.releaseId}, but the baseline is frozen to ${baseline.pinnedData.releaseId}. Rebuild the baseline instead of mixing data releases.`,
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  const baselinePointLimits = [
    ...new Set(
      (baseline.pointsComparisons ?? []).map(
        (comparison) => comparison.pointsLimit,
      ),
    ),
  ];
  if (
    baselinePointLimits.length !== 1 ||
    revisedRoster.pointsLimit !== baselinePointLimits[0]
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_REVISION_POINTS_LIMIT_CHANGED",
          message:
            `The revised roster declares ${revisedRoster.pointsLimit} points, but the baseline does not prove the same single points-limit contract.`,
          severity: "error",
        },
      ],
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
  if (effectiveExecutionMode(options) !== "simulate") {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_REVISION_SIMULATION_REQUIRED",
          message:
            "Revision comparison must rerun Tessera with executionMode=\"simulate\" (the deprecated experimental=true flag is normalized to that mode).",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  let revisionProfilePolicy: ProfilePolicyV1 | null;
  try {
    revisionProfilePolicy = await requestedAnalysisProfilePolicy(options);
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
      warnings: validation.warnings,
    };
  }
  const requestedProfilePolicyHash = revisionProfilePolicy
    ? profilePolicyHash(revisionProfilePolicy)
    : null;
  if ((baseline.profilePolicyHash ?? null) !== requestedProfilePolicyHash) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_REVISION_PROFILE_POLICY_CHANGED",
          message:
            "The revision must reuse the baseline's exact frozen profile policy.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  const baselineReportDirectory = path.dirname(baselineReportPath);
  const verifiedPlayerArtifacts =
    await verifyFrozenExactRosterArtifacts(
      baselineReportDirectory,
      baseline.player,
    );
  if (typeof verifiedPlayerArtifacts === "string") {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_PLAYER_ARTIFACT_CHANGED",
          message:
            `The frozen player artifacts for ${baseline.player.rosterName} are missing or changed: ${verifiedPlayerArtifacts}`,
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  const verifiedOpponentArtifacts: Array<{
    sourcePath: string;
    enrichedPath: string;
  }> = [];
  for (const opponent of baseline.opponents) {
    const verified = await verifyFrozenExactRosterArtifacts(
      baselineReportDirectory,
      opponent,
    );
    if (typeof verified === "string") {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_BASELINE_OPPONENT_ARTIFACT_CHANGED",
            message:
              `The frozen opponent artifacts for ${opponent.rosterName} are missing or changed: ${verified}`,
            severity: "error",
          },
        ],
        warnings: validation.warnings,
      };
    }
    verifiedOpponentArtifacts.push(verified);
  }

  const outputDirectory =
    options.outputDirectory ??
    path.join(path.dirname(baselineReportPath), "revision");
  const revisionBasename =
    `${safeName(revisedRoster.name) || "roster"}-revision`;
  try {
    await resolveExportArtifactTargets(
      [
        {
          format: "roster-json",
          filename: `${revisionBasename}.json`,
          mimeType: "application/json",
          encoding: "utf8",
          content: "",
        },
        {
          format: "html",
          filename: `${revisionBasename}.html`,
          mimeType: "text/html; charset=utf-8",
          encoding: "utf8",
          content: "",
        },
      ],
      outputDirectory,
      options,
    );
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_OUTPUT_RESERVATION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "The revision output paths could not be reserved before external activity.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  let releaseRevisionOutputLease:
    | (() => Promise<void>)
    | null = null;
  try {
    const resolvedOutputDirectory = path.resolve(
      options.rootDir ?? process.cwd(),
      outputDirectory,
    );
    releaseRevisionOutputLease = await acquireDirectoryLease(
      path.join(
        resolvedOutputDirectory,
        `.${revisionBasename}.exact-output.lock`,
      ),
      0,
    );
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_OUTPUT_LEASED",
          message:
            error instanceof Error
              ? `Another paired revision owns these output paths: ${error.message}`
              : "Another paired revision owns these output paths.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  try {
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
      {
        kind: "rosz",
        path: verifiedOpponentArtifacts[index].enrichedPath,
      },
      {
        ...options,
        executionMode: "simulate",
        experimental: undefined,
        profilePolicy: revisionProfilePolicy,
        profilePolicyPath: undefined,
        frozenProfileRequirements: structuredClone(
          baseline.frozenProfileRequirements ?? [],
        ),
        outputDirectory: path.join(
          outputDirectory,
          `opponent-${index + 1}-${safeName(opponent.rosterName)}`,
        ),
        analysisMode: baseline.configuration.analysisMode,
        phases: baseline.configuration.phases,
        metrics: baseline.configuration.metrics,
        allowPointMismatch: baseline.configuration.allowPointMismatch,
        includeChangeCandidates: false,
        frozenScenarioContract: frozenScenarioContract.data,
        frozenOpponentReuse: {
          rosterId: opponent.fingerprint!,
          rosterName: opponent.rosterName,
          listUrl: null,
          sourceRoszPath:
            verifiedOpponentArtifacts[index].sourcePath,
          enrichedRoszPath:
            verifiedOpponentArtifacts[index].enrichedPath,
          sourceRoszSha256: opponent.sourceRoszSha256,
          enrichedRoszSha256: opponent.enrichedRoszSha256,
          summary: structuredClone(opponent.summary),
          fingerprint: opponent.fingerprint,
          units: structuredClone(opponent.units ?? []),
          cacheReused: true,
          connectorEvents: [],
          catalogueProvenance: opponent.catalogueProvenance
            ? structuredClone(opponent.catalogueProvenance)
            : undefined,
        },
        verifiedUploadedArtifactCapability:
          grantVerifiedUploadedArtifactCapability(),
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
    const revisedOpponent = revised.data.opponents[0];
    if (
      revised.data.profilePolicyHash !==
        (baseline.profilePolicyHash ?? null) ||
      revised.data.tesseraUiIdentity !== baseline.tesseraUiIdentity ||
      !revisedOpponent ||
      !summariesGameplayCompatible(
        revisedOpponent.summary,
        opponent.summary,
      ) ||
      revisedOpponent.fingerprint !== opponent.fingerprint ||
      revisedOpponent.sourceRoszSha256 !==
        opponent.sourceRoszSha256 ||
      revisedOpponent.enrichedRoszSha256 !==
        opponent.enrichedRoszSha256
    ) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_REVISION_EVIDENCE_DRIFT",
            message:
              `The rerun against ${opponent.rosterName} changed its frozen opponent identity, profile policy, or Tessera UI identity.`,
            severity: "error",
          },
        ],
        warnings: revised.warnings,
      };
    }
    reusablePlayer ??= revised.data.player;
    revisedReports.push(revised.data);
  }

  const deltas = revisionDeltas(baseline, revisedReports);
  const aggregates = revisionAggregates(baseline, revisedReports);
  const aggregateCounts = {
    improved: aggregates.filter(
      (aggregate) => aggregate.classification === "improved",
    ).length,
    worsened: aggregates.filter(
      (aggregate) => aggregate.classification === "worsened",
    ).length,
    unchanged: aggregates.filter(
      (aggregate) => aggregate.classification === "unchanged",
    ).length,
    ambiguous: aggregates.filter(
      (aggregate) => aggregate.classification === "ambiguous",
    ).length,
    applicable: aggregates.filter(
      (aggregate) => aggregate.classification !== "ambiguous",
    ).length,
    total: aggregates.length,
  };
  const summary = {
    improved: deltas.filter((delta) => delta.classification === "improved")
      .length,
    worsened: deltas.filter((delta) => delta.classification === "worsened")
      .length,
    unchanged: deltas.filter((delta) => delta.classification === "unchanged")
      .length,
    ambiguous: deltas.filter((delta) => delta.classification === "ambiguous")
      .length,
    aggregateCounts,
    conclusionBasis: "trusted-roster-aggregates" as const,
    conclusion: "unchanged" as
      | "improved"
      | "worsened"
      | "mixed"
      | "unchanged",
  };
  summary.conclusion =
    aggregateCounts.improved > 0 && aggregateCounts.worsened === 0
      ? "improved"
      : aggregateCounts.worsened > 0 && aggregateCounts.improved === 0
        ? "worsened"
        : aggregateCounts.improved > 0 && aggregateCounts.worsened > 0
          ? "mixed"
          : "unchanged";
  const report: TesseraRevisionComparisonReport = {
    schemaVersion: 2,
    runId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    baselineReportPath,
    baselineRunId: baseline.runId,
    revisedRosterFingerprint: rosterExecutionFingerprint(revisedRoster),
    revisedReports,
    deltas,
    aggregates,
    summary,
    limitations: [
      "This comparison measures changes in directional combat math, not game win probability.",
      "The roster conclusion compares equal-weight trusted scenario means by metric and direction. Cell deltas are retained for drill-down only and do not vote on the conclusion.",
      ...baseline.limitations,
    ],
    warnings: [
      ...new Set(revisedReports.flatMap((item) => item.warnings)),
    ],
    artifacts: [],
  };
  try {
    const written = await writeExportArtifacts(
      [
        {
          format: "roster-json",
          filename: `${revisionBasename}.json`,
          mimeType: "application/json",
          encoding: "utf8",
          content: `${JSON.stringify(report, null, 2)}\n`,
        },
        {
          format: "html",
          filename: `${revisionBasename}.html`,
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
  } finally {
    await releaseRevisionOutputLease?.();
  }
}
