import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  analyzeMissionReadiness,
  baselineDamageCells,
  canonicalJson,
  compileCombatBridgeV2,
  compileCombatBridgeV3,
  compareNewRecruitCatalogueProvenance,
  currentRosterSourceData,
  exportRoster,
  generateFactionStressPortfolio,
  getNewRecruitFactionSummary,
  getConfiguredDataBundleProvider,
  inspectEnrichedRosz,
  inspectEnrichedProfileRequirements,
  inspectEnrichedUnitProfileCoverage,
  isForwardGameSystemRevisionOnlyDrift,
  newRecruitCatalogue,
  rosterExecutionFingerprint,
  searchUnits,
  validateRoster,
  validateTesseraReadyRosz,
  type EnrichedRoszSummary,
  type ExportArtifact,
  type ConnectorEvent,
  type CombatBridgeV2,
  type CombatBridgeV3,
  type DataBundleSnapshot,
  type DataBundleProvider,
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
  type TesseraScenarioPolicyContractV2Snapshot,
  type TesseraScenarioPolicyContractV3Snapshot,
  type TesseraSimulationBackend,
  type TesseraSimulationFallbackReceipt,
  type TesseraSimulationProvider,
  type TesseraSimulationProviderIdentity,
  type TesseraStressPortfolioItem,
  type TesseraUnitInstance,
  type TesseraWebsiteProviderEvidence,
} from "../../lib/rosterpilot";
import { dataset as activeRuntimeDataset } from "../../lib/rosterpilot/runtime-dataset";
import type { RuntimeDataBundleShardDataV1 } from "../../lib/rosterpilot/runtime-data-bundle";
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
  recordVerifiedServiceObservation,
  type NewRecruitDeliveryOptions,
} from "../new-recruit/companion";
import {
  acquireNewRecruitCacheLease,
  acquireDirectoryLease,
  beginNewRecruitMutationReceipt,
  loadNewRecruitCache,
  loadNewRecruitMutationRecoveryArtifact,
  loadNewRecruitProvisionalArtifact,
  recordNewRecruitReuseReceipt,
  storeNewRecruitCache,
  storeNewRecruitProvisionalArtifact,
  type NewRecruitMutationTransaction,
} from "../new-recruit/cache";
import {
  getLocalAgentStatus,
  LocalAgentError,
  runTesseraThroughLocalAgent,
} from "../agent/client";
import {
  projectRoot,
  rosterPilotSupportDirectory,
} from "../agent/paths";
import {
  createServiceCompatibilityStore,
  type RecordTesseraServiceEvidenceInput,
} from "../data-bundles/service-compatibility";
import {
  runTesseraBrowserMatchup,
  TESSERA_URL,
  TESSERA_WEBSITE_ADAPTER_VERSION,
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
import {
  createLocalTesseraEngineProvider,
  localTesseraEngineIsAutoSelectable,
  localTesseraProviderIdentityAllowsAnalyticalClaims,
  LOCAL_TESSERA_ENGINE_IDENTITY,
  LOCAL_TESSERA_ENGINE_ITERATIONS,
  LOCAL_TESSERA_ENGINE_STATUS,
  runLocalTesseraEngineMatchup,
} from "./local-engine";
import type {
  PersonalLocalParityAttestationContextV1,
} from "./personal-local-attestation";
import {
  personalLocalProviderIdentitySha256,
} from "./personal-local-attestation";
import {
  loadCurrentPersonalLocalParityAttestationContextV1,
} from "./personal-local-attestation-store";
import {
  prepareRosterForLocalTesseraEngine,
} from "./local-engine-preparation";
import type {
  LocalTesseraEngineDataContext,
} from "./local-engine-input";
import {
  compileRosterForLocalTesseraEngineV2,
  verifyLocalTesseraEngineInputAnyVersion,
} from "./local-engine-input-v2";
import {
  createWebsiteTesseraProvider,
  routeTesseraSimulation,
  type TesseraWebsiteFallbackAuthorization,
} from "./simulation-provider";
import {
  assertTesseraScenarioContractProvider,
  assertTesseraScenarioContractScope,
  canonicalTesseraScenarioContract,
  observedTesseraScenarioContract,
  tesseraScenarioContractSha256,
} from "./scenario-contract";
import {
  activationEnvelopeTesseraScenarioPolicyContractV2,
  assertTesseraScenarioPolicyContractV2Scope,
  canonicalTesseraScenarioPolicyContractV2,
  migrateTesseraScenarioContractV1ToV2,
  selectedAbilitiesTesseraScenarioPolicyContractV2,
  selectedBaselineTesseraScenarioPolicyContractV2,
  tesseraScenarioPolicyContractV2Sha256,
  withSelectedTesseraAttachmentBindingsV2,
  type TesseraScenarioPolicyContractV2,
} from "./scenario-contract-v2";
import {
  activationEnvelopeTesseraScenarioPolicyContractV3,
  assertTesseraScenarioPolicyContractV3Scope,
  canonicalTesseraScenarioPolicyContractV3,
  selectedAbilitiesTesseraScenarioPolicyContractV3,
  selectedBaselineTesseraScenarioPolicyContractV3,
  tesseraScenarioPolicyContractV3Sha256,
  withSelectedTesseraAttachmentBindingsV3,
  type TesseraAttachmentBindingV3,
  type TesseraScenarioPolicyContractV3,
} from "./scenario-contract-v3";
import {
  buildMatchupProviderCompatibilityEnvelopes,
  captureProviderCompatibilityBundleTrustIdentity,
  effectiveProviderCompatibilityMode,
} from "./provider-compatibility";
import {
  compileCombatBridgeInputV2FromDataset,
  compileCombatBridgeInputV2FromSnapshot,
  runtimeDatasetFromSnapshot,
} from "./combat-bridge-input";
import {
  CombatBridgeInputV3PreparationError,
  prepareCombatBridgeInputV3FromSnapshot,
  type CombatBridgeInputV3PreparationArtifact,
  type PreparedCombatBridgeInputV3,
} from "./combat-bridge-input-v3";
import { compactCombatBridgeEvidence } from "./combat-bridge-evidence";
import { projectCombatBridgeCellToTessera } from "./combat-bridge-adapter";
import type {
  TesseraParityCoveringSuiteV2,
} from "./provider-parity-covering-suite-v2";
import {
  buildTesseraProviderParityReportEvidenceV2,
  deriveTesseraParityFactionMechanicsV2,
} from "./provider-parity-report-evidence-v2";

const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const verifiedUploadedArtifactCapabilities = new WeakSet<object>();

function combatBridgeEvidenceError(
  code:
    | "TESSERA_COMBAT_BRIDGE_EVIDENCE_MISSING"
    | "TESSERA_COMBAT_BRIDGE_EVIDENCE_MISMATCH",
  message: string,
): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * An injected local provider is still an untrusted transport boundary. Require
 * every returned scalar to bind back to the exact in-memory bridge compiled
 * for this opponent before accepting any matrix or scenario evidence.
 */
function assertLocalCombatBridgeExecutionEvidence(
  result: TesseraBrowserResult,
  bridge: CombatBridgeV2 | CombatBridgeV3,
): void {
  if (result.scenarios.length === 0) {
    throw combatBridgeEvidenceError(
      "TESSERA_COMBAT_BRIDGE_EVIDENCE_MISSING",
      "The local engine returned no scenario cells carrying combat-bridge evidence.",
    );
  }

  const bridgeCellsById = new Map(
    bridge.cells.map((cell) => [cell.cellId, cell]),
  );
  const bridgeProjectionsByCellId = new Map(
    bridge.cells.map((cell) => [
      cell.cellId,
      projectCombatBridgeCellToTessera(cell),
    ]),
  );
  let envelopeCount = 0;
  for (const scenario of result.scenarios) {
    if (scenario.cells.length === 0) {
      throw combatBridgeEvidenceError(
        "TESSERA_COMBAT_BRIDGE_EVIDENCE_MISSING",
        `Local scenario ${scenario.id} returned no scalar cells to verify against the combat bridge.`,
      );
    }
    for (const cell of scenario.cells) {
      const envelope = cell.combatEnvelope;
      if (!envelope) {
        throw combatBridgeEvidenceError(
          "TESSERA_COMBAT_BRIDGE_EVIDENCE_MISSING",
          `Local scenario ${scenario.id} returned a scalar without a combat-bridge envelope.`,
        );
      }
      envelopeCount += 1;
      const bridgeCell = bridgeCellsById.get(envelope.bridgeCellId);
      if (
        envelope.bridgeSha256 !== bridge.bridgeSha256 ||
        !bridgeCell ||
        envelope.bridgeCellSha256 !== bridgeCell.cellSha256 ||
        envelope.bridgeScenarioSha256 !== bridgeCell.scenarioSha256 ||
        bridgeCell.scenario.phase !== scenario.phase ||
        bridgeCell.direction !== scenario.direction ||
        bridgeCell.metric !== scenario.metric
      ) {
        throw combatBridgeEvidenceError(
          "TESSERA_COMBAT_BRIDGE_EVIDENCE_MISMATCH",
          `Local scenario ${scenario.id} returned an envelope that does not match its frozen bridge cell.`,
        );
      }
      const variant = bridgeCell.variants.find(
        (candidate) => candidate.variantId === envelope.selectedVariantId,
      );
      const cellProjection = bridgeProjectionsByCellId.get(
        bridgeCell.cellId,
      );
      const projection = cellProjection?.variants.find(
        (candidate) =>
          candidate.bridgeVariantId === envelope.selectedVariantId,
      );
      const expectedOmittedEffectIds = [
        ...new Set(
          (cellProjection?.variants ?? []).flatMap((candidate) =>
            candidate.omissions.map((omission) => omission.effectId),
          ),
        ),
      ].sort();
      const expectedApproximatedEffectIds = [
        ...new Set(
          bridgeCell.variants.flatMap((candidate) =>
            candidate.effects.flatMap((effect) =>
              effect.status === "approximated" ? [effect.effectId] : [],
            ),
          ),
        ),
      ].sort();
      if (
        !variant ||
        !cellProjection ||
        !projection ||
        envelope.selectedVariantSha256 !== variant.variantSha256 ||
        envelope.selectedProjectionSha256 !==
          projection.projectionSha256 ||
        envelope.attachmentPlanId !== variant.attachmentPlan.id ||
        envelope.activationId !== variant.activation.id ||
        envelope.variantCount !== cellProjection.uniqueExecutionCount ||
        envelope.sourceVariantCount !== bridgeCell.variants.length ||
        envelope.median !== cell.metricValue ||
        canonicalJson(envelope.coverage) !==
          canonicalJson(cellProjection.coverage) ||
        canonicalJson(envelope.omittedEffectIds) !==
          canonicalJson(expectedOmittedEffectIds) ||
        canonicalJson(envelope.approximatedEffectIds) !==
          canonicalJson(expectedApproximatedEffectIds)
      ) {
        throw combatBridgeEvidenceError(
          "TESSERA_COMBAT_BRIDGE_EVIDENCE_MISMATCH",
          `Local scenario ${scenario.id} returned scalar provenance that does not match its selected bridge variant.`,
        );
      }
    }
  }
  if (envelopeCount === 0) {
    throw combatBridgeEvidenceError(
      "TESSERA_COMBAT_BRIDGE_EVIDENCE_MISSING",
      "The local engine returned no combat-bridge envelopes.",
    );
  }
}

export function localCombatScenarioClaimsEligible(
  scenarios: readonly Pick<
    TesseraScenarioResult,
    "metrics" | "cells"
  >[],
): boolean {
  return (
    scenarios.length > 0 &&
    scenarios.every(
      (scenario) =>
        scenario.metrics.length > 0 &&
        scenario.cells.length > 0 &&
        scenario.cells.every((cell) =>
          scenario.metrics.every(
            (metric) =>
              cell.combatEnvelope?.[metric]?.coverage
                .claimEligibility === "decision-grade" &&
              cell.combatEnvelope?.[metric]?.conclusionEligibility
                ?.scalarClaimsAllowed === true,
          ),
        ),
    )
  );
}

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
  /** Requested provider. The selected provider is frozen for paired work. */
  simulationBackend?: TesseraSimulationBackend;
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
  /** Caller-supplied deterministic simulation contract for a fresh run. */
  scenarioContract?: TesseraFrozenScenarioContract[];
  /** Bundle-native combat context and bounded option/attachment policy. */
  scenarioPolicyContractV2?: TesseraScenarioPolicyContractV2;
  /** Physical player/opponent state and exact scalar/envelope conclusion policy. */
  scenarioPolicyContractV3?: TesseraScenarioPolicyContractV3;
  /** Optional bundle-native activations to select for the player roster. */
  selectedPlayerAbilityIds?: string[];
  /** Explore all discovered optional combat activations instead of baseline. */
  activationMode?: "baseline" | "envelope";
  /** Explicit fresh-run attachment state, bound to exact roster selections. */
  selectedAttachmentBindings?: TesseraAttachmentBindingV3[];
  /** Exact covering-suite case to seal into a paired local/Web parity report. */
  providerParityCase?: {
    coveringSuite: TesseraParityCoveringSuiteV2;
    coveringCaseId: string;
  };
  /** Hash-bound permission to leave the local engine after an auto failure. */
  websiteFallbackAuthorization?: TesseraWebsiteFallbackAuthorization;
  /** Internal replay contract frozen by stress/revision coordinators. */
  frozenScenarioContract?: TesseraFrozenScenarioContract[] | null;
  sessionId?: string;
  allowPointMismatch?: boolean;
  includeChangeCandidates?: boolean;
  /** Freeze whether incomplete website compatibility evidence blocks the run. */
  providerCompatibilityMode?: "observe" | "enforce";
  /** Proceed with visibly provisional results after verified catalogue drift. */
  catalogueDriftMode?: "reject" | "diagnostic" | "force";
};

export type TesseraDependencies = {
  deliver?: typeof deliverRosterToNewRecruit;
  enrich?: typeof enrichRoszThroughNewRecruit;
  runBrowser?: typeof runTesseraBrowserMatchup;
  runLocalEngine?: typeof runLocalTesseraEngineMatchup;
  /** Machine-bound personal parity authorization; never serialized to reports. */
  personalLocalAttestation?:
    PersonalLocalParityAttestationContextV1 | null;
  runtimeIssue?: typeof runtimeRestartIssue;
  /** Exact runtime-bundle provider; captured once for bundle-native rules. */
  dataBundleProvider?: DataBundleProvider<RuntimeDataBundleShardDataV1>;
  recordTesseraServiceEvidence?: (
    input: RecordTesseraServiceEvidenceInput,
  ) => Promise<unknown>;
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
  const [browserAvailable, localEngineAvailable] = await Promise.all([
    exists(chromePath),
    exists(path.join(projectRoot, "node_modules/tessera-engine/src/index.js")),
  ]);
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
      simulationAvailable:
        available || localEngineAvailable,
      defaultBackend: "website",
      backends: {
        localEngine: {
          ...structuredClone(LOCAL_TESSERA_ENGINE_STATUS),
          available: localEngineAvailable,
          simulationReady: localEngineAvailable,
          endToEndReady: localEngineAvailable,
          reason: localEngineAvailable
            ? LOCAL_TESSERA_ENGINE_STATUS.reason
            : "The pinned tessera-engine package is not installed or its entry point is unavailable.",
        },
        website: {
          available,
          identity: {
            schemaVersion: 1,
            provider: "website",
            engine: "tessera-ui",
            uiIdentity: null,
            adapterVersion: TESSERA_WEBSITE_ADAPTER_VERSION,
          },
          reason: available
            ? null
            : "The browser/local-agent/credential readiness gate is not satisfied.",
        },
      },
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
      : provider?.credentialState === "disabled"
        ? [
            {
              code: "CREDENTIAL_RELEASE_DISABLED",
              message:
                "Tessera Website credential release is disabled until an authenticated native consumer is available. The explicit local-engine route remains available.",
              severity: "warn",
            },
          ]
      : available
        ? [
            {
              code: "TESSERA_LOCAL_ENGINE_EVALUATION_ONLY",
              message:
                "The pinned local engine is available for explicit diagnostics; auto remains on the website until the current machine-local parity attestation and exact bridge-v3 gates pass.",
              severity: "warn",
            },
          ]
        : [
          {
            code: "TESSERA_COMPANION_UNAVAILABLE",
            message:
              "The Tessera website route requires macOS, Google Chrome, the local agent, and a configured premium key. The explicit local-engine evaluation route remains available for capability-covered rosters.",
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

type TesseraRosterPreparationOptions = NewRecruitDeliveryOptions & {
  simulationBackend?: TesseraSimulationBackend;
  profilePolicy?: ProfilePolicyV1 | null;
  /** Internal immutable data context owned by the enclosing exact run. */
  dataContext?: LocalTesseraEngineDataContext;
};

export async function prepareRosterForTessera(
  roster: RosterDraftV1,
  options: TesseraRosterPreparationOptions = {},
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
  if (options.simulationBackend === "local-engine") {
    return prepareRosterForLocalTesseraEngine(
      roster,
      options.profilePolicy ?? null,
      options,
    );
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
      ? (await loadNewRecruitCache(roster)) ??
        (await loadNewRecruitProvisionalArtifact(roster)) ??
        (await loadNewRecruitMutationRecoveryArtifact(roster))
      : null;
    if (persisted) {
      delivery = persisted;
      cacheReused = true;
      const reuseReceipt = await recordNewRecruitReuseReceipt({
        roster,
        runId: mutationRunId,
        delivery,
      });
      if (delivery.data) {
        try {
          await recordVerifiedServiceObservation(
            roster,
            delivery.data,
            reuseReceipt,
          );
        } catch (error) {
          delivery.warnings.push({
            code: "SERVICE_COMPATIBILITY_OBSERVATION_WRITE_FAILED",
            message:
              `The hash-verified cached New Recruit artifact remains reusable, but its catalogue identity could not be indexed: ${
                error instanceof Error ? error.message : String(error)
              }. Doctor can rebuild the compatibility index without uploading another list.`,
            severity: "warn",
          });
        }
      }
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
      const finalizedReceipt =
        await mutationTransaction?.finalizeDelivery(delivery);
      if (finalizedReceipt && delivery.data) {
        try {
          await recordVerifiedServiceObservation(
            roster,
            delivery.data,
            finalizedReceipt,
          );
        } catch (error) {
          delivery.warnings.push({
            code: "SERVICE_COMPATIBILITY_OBSERVATION_WRITE_FAILED",
            message:
              `The verified New Recruit artifact was retained, but its catalogue observation could not be indexed for automatic compatibility selection: ${
                error instanceof Error ? error.message : String(error)
              }. The mutation receipt prevents duplicate imports and Doctor can repair the local index.`,
            severity: "warn",
          });
        }
      }
      if (
        mutationTransaction &&
        delivery.data?.catalogueProvenance &&
        isForwardGameSystemRevisionOnlyDrift(
          delivery.data.catalogueProvenance,
        )
      ) {
        try {
          await storeNewRecruitProvisionalArtifact(
            roster,
            delivery,
          );
        } catch {
          delivery.warnings.push({
            code: "NEW_RECRUIT_PROVISIONAL_CACHE_WRITE_FAILED",
            message:
              "The revision-only enriched roster was retained by the mutation receipt but could not be added to the provisional reuse store.",
            severity: "warn",
          });
        }
      }
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
  const [sourceContent, enrichedContent] = await Promise.all([
    readFile(source.written),
    readFile(enriched.written),
  ]);
  const prepared: TesseraPreparedRoster = {
    rosterId: roster.id,
    rosterName: roster.name,
    factionId: roster.factionId,
    listUrl: delivery.data.listUrl,
    sourceRoszPath: source.written,
    enrichedRoszPath: enriched.written,
    sourceRoszSha256: sha256(sourceContent),
    enrichedRoszSha256: sha256(enrichedContent),
    preparedArtifact: {
      schemaVersion: 2,
      kind: "new-recruit-enriched",
      sourceRoszPath: source.written,
      sourceRoszSha256: sha256(sourceContent),
      enrichedRoszPath: enriched.written,
      enrichedRoszSha256: sha256(enrichedContent),
      connectorEvents: delivery.data.connectorEvents ?? [],
    },
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
  if (prepared.preparedArtifact?.kind === "new-recruit-enriched") {
    prepared.preparedArtifact.catalogueProvenance = catalogueProvenance;
  }
  const preparationWarnings = [...delivery.warnings];
  if (catalogueProvenance.status === "drift") {
    const mismatchSummary = catalogueProvenance.mismatches
      .map(
        (mismatch) =>
          `${mismatch.field} expected ${mismatch.expected}, observed ${
            mismatch.observed ?? "missing"
          }`,
      )
      .join("; ");
    const diagnosticDriftAccepted =
      options.catalogueDriftMode === "force" ||
      (options.catalogueDriftMode === "diagnostic" &&
        isForwardGameSystemRevisionOnlyDrift(catalogueProvenance));
    if (!diagnosticDriftAccepted) {
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
        warnings: preparationWarnings,
      };
    }
    preparationWarnings.push({
      code: "TESSERA_VERIFIED_CATALOGUE_DRIFT_DIAGNOSTIC",
      message:
        `Diagnostic mode accepted an identity-verified, profile-complete New Recruit archive despite a newer game-system revision: ${mismatchSummary}. The faction catalogue still matches exactly; embedded characteristic values remain live New Recruit evidence, so results retain both identities and stay provisional.`,
      severity: "warn",
    });
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
      warnings: preparationWarnings,
    };
  }
  const gameplayIntegrity = await verifyRoszGameplayArtifacts(
    source.written,
    enriched.written,
    roster.name,
    {
      ignoredMismatches:
        options.catalogueDriftMode === "force"
          ? ["game-system", "catalogue", "points", "selection-tree"]
          : isForwardGameSystemRevisionOnlyDrift(
              catalogueProvenance,
            )
            ? ["game-system"]
            : [],
    },
  );
  if (gameplayIntegrity) {
    return {
      ok: false,
      data: prepared,
      violations: [gameplayIntegrity],
      warnings: preparationWarnings,
    };
  }
  if (!delivery.ok) {
    return {
      ok: false,
      data: prepared,
      violations:
        delivery.violations.length > 0
          ? delivery.violations
          : [
              {
                code: "TESSERA_HANDOFF_INCOMPLETE",
                message:
                  "New Recruit returned verified recovery artifacts, but the delivery did not pass its acceptance checks.",
                severity: "error",
              },
            ],
      warnings: preparationWarnings,
    };
  }
  if (
    pendingPersistentCacheStore &&
    !cacheReused &&
    catalogueProvenance.status === "matched"
  ) {
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
    warnings: preparationWarnings,
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
    providerCompatibilityMode: effectiveProviderCompatibilityMode(
      options.providerCompatibilityMode,
    ),
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

type UploadedRoszCatalogueProvenance = NonNullable<
  TesseraPreparedRoster["catalogueProvenance"]
>;

function uploadedRoszCatalogueProvenance(
  summary: EnrichedRoszSummary,
  playerRoster: RosterDraftV1,
  opponentRosterContext: RosterDraftV1 | undefined,
  observedFactionId: string | null,
): UploadedRoszCatalogueProvenance | null {
  const expectedFactionId =
    opponentRosterContext?.factionId ?? observedFactionId;
  if (!expectedFactionId) return null;
  const factionCatalogue = getNewRecruitFactionSummary(
    expectedFactionId,
  );
  if (!factionCatalogue?.catalogue.id) return null;
  const sourceRoster = opponentRosterContext ?? playerRoster;
  return compareNewRecruitCatalogueProvenance(summary, {
    releaseId: sourceRoster.sourceData.releaseId,
    gameSystem: {
      id: newRecruitCatalogue.gameSystem.id,
      name: newRecruitCatalogue.gameSystem.name,
      revision:
        sourceRoster.sourceData.newRecruit.gameSystemRevision,
    },
    catalogue: {
      id: factionCatalogue.catalogue.id,
      name: factionCatalogue.catalogue.name,
      revision: opponentRosterContext
        ? opponentRosterContext.sourceData.newRecruit.catalogueRevision
        : factionCatalogue.catalogue.revision,
    },
  });
}

function acceptsUploadedRoszRevisionDiagnostic(
  comparison: UploadedRoszCatalogueProvenance | null,
  catalogueDriftMode: TesseraAnalysisOptions["catalogueDriftMode"],
): comparison is UploadedRoszCatalogueProvenance {
  if (catalogueDriftMode === "force" && comparison) return true;
  if (
    catalogueDriftMode !== "diagnostic" ||
    !comparison ||
    !isForwardGameSystemRevisionOnlyDrift(comparison) ||
    comparison.pinned.catalogue.revision === null ||
    !comparison.observed
  ) {
    return false;
  }
  const matchingCatalogues = comparison.observed.catalogues.filter(
    (catalogue) => catalogue.id === comparison.pinned.catalogue.id,
  );
  return (
    comparison.observed.catalogues.length === 1 &&
    matchingCatalogues.length === 1 &&
    matchingCatalogues[0].revision ===
      comparison.pinned.catalogue.revision
  );
}

function appendUploadedRoszRevisionDiagnosticWarning(
  warnings: RosterIssue[],
  comparison: UploadedRoszCatalogueProvenance,
): void {
  if (
    warnings.some(
      (warning) =>
        warning.code ===
        "TESSERA_VERIFIED_CATALOGUE_DRIFT_DIAGNOSTIC",
    )
  ) {
    return;
  }
  const mismatch = comparison.mismatches[0];
  warnings.push({
    code: "TESSERA_VERIFIED_CATALOGUE_DRIFT_DIAGNOSTIC",
    message:
      `Diagnostic mode accepted the identity-verified, profile-complete uploaded opponent despite a newer game-system revision: ${mismatch.field} expected ${mismatch.expected}, observed ${mismatch.observed ?? "missing"}. The faction catalogue still matches exactly; embedded characteristic values remain live New Recruit evidence, so results retain both identities and stay provisional.`,
    severity: "warn",
  });
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
  catalogueDriftMode: TesseraAnalysisOptions["catalogueDriftMode"] =
    "reject",
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
  let catalogueProvenance: UploadedRoszCatalogueProvenance | null =
    null;
  let diagnosticRevisionDriftAccepted = false;
  if (!uploadedArtifactProvenanceVerified) {
    const observedFactionCatalogues = Object.entries(
      newRecruitCatalogue.factions,
    ).flatMap(([candidateFactionId, faction]) => {
      const catalogue = gameplaySnapshot.catalogues.find(
        (candidate) =>
          candidate.id === faction.catalogue.id,
      );
      return catalogue
        ? [
            {
              factionId: candidateFactionId,
              expected: faction.catalogue,
              catalogue,
            },
          ]
        : [];
    });
    const observedFactionId =
      gameplaySnapshot.catalogues.length === 1 &&
      observedFactionCatalogues.length === 1
        ? observedFactionCatalogues[0].factionId
        : null;
    catalogueProvenance = uploadedRoszCatalogueProvenance(
      summary,
      playerRoster,
      opponentRosterContext,
      observedFactionId,
    );
    diagnosticRevisionDriftAccepted =
      acceptsUploadedRoszRevisionDiagnostic(
        catalogueProvenance,
        catalogueDriftMode,
      );
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
        (opponentRosterContext ?? playerRoster).sourceData.newRecruit
          .gameSystemRevision
    ) {
      if (!diagnosticRevisionDriftAccepted) {
        violations.push({
          code: "TESSERA_ROSZ_GAME_SYSTEM_MISMATCH",
          message:
            `The uploaded ROSZ game system ${gameplaySnapshot.gameSystem.id}@${gameplaySnapshot.gameSystem.revision} does not match the frozen bundle's ${newRecruitCatalogue.gameSystem.id}@${(opponentRosterContext ?? playerRoster).sourceData.newRecruit.gameSystemRevision}.`,
          severity: "error",
        });
      }
    }
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
        ).filter(
          (mismatch) =>
            !(
              diagnosticRevisionDriftAccepted &&
              mismatch === "game-system"
            ),
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
  if (
    diagnosticRevisionDriftAccepted &&
    catalogueProvenance
  ) {
    appendUploadedRoszRevisionDiagnosticWarning(
      warnings,
      catalogueProvenance,
    );
  }
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
    | "enrichedRoszPath"
    | "simulationInput"
    | "summary"
    | "rosterName"
  >,
  faction: string,
): Promise<ResultEnvelope<TesseraProfileRequirement[]>> {
  try {
    const content = await readFile(prepared.enrichedRoszPath);
    if (
      prepared.simulationInput?.kind ===
      "rosterpilot-local-engine-input"
    ) {
      const localInput = verifyLocalTesseraEngineInputAnyVersion({
        content,
        expectedSha256: prepared.simulationInput.sha256,
        expectedBundleId: prepared.simulationInput.bundleId,
      });
      if (
        localInput.compilerVersion !==
          prepared.simulationInput.compilerVersion ||
        localInput.totalPoints !== prepared.summary.totalPoints ||
        !factionNamesCompatible(
          localInput.factionName,
          prepared.summary.factionName,
        ) ||
        localInput.units.length !== prepared.summary.units.length ||
        localInput.factionId !== faction
      ) {
        return {
          ok: false,
          data: null,
          violations: [
            {
              code: "TESSERA_PREPARED_ARTIFACT_DRIFT",
              message:
                `The local input for ${prepared.rosterName} no longer matches its frozen summary or faction.`,
              severity: "error",
            },
          ],
          warnings: [],
        };
      }
      return {
        ok: true,
        data: structuredClone(localInput.profileRequirements),
        violations: [],
        warnings: [],
      };
    }
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
    const incompleteProfiles = inspectEnrichedUnitProfileCoverage(
      content,
    ).filter((unit) => !unit.complete);
    if (incompleteProfiles.length > 0) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "TESSERA_PREPARED_PROFILES_INCOMPLETE",
            message:
              `The prepared archive for ${prepared.rosterName} has incomplete per-unit model/weapon profiles for ${incompleteProfiles.map((unit) => unit.name).join(", ")}.`,
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

export function selectedAttachmentReportingUnits(
  units: readonly TesseraUnitInstance[],
  side: TesseraUnitInstance["side"],
  bindings: readonly TesseraAttachmentBindingV3[],
): TesseraUnitInstance[] {
  const unitsBySelectionId = new Map<string, TesseraUnitInstance>();
  for (const unit of units) {
    if (!unit.selectionId) continue;
    if (unitsBySelectionId.has(unit.selectionId)) {
      throw Object.assign(
        new Error(
          `Selection ${JSON.stringify(unit.selectionId)} occurs more than once in the ${side} report scope.`,
        ),
        { code: "TESSERA_ATTACHMENT_REPORT_SCOPE_INVALID" },
      );
    }
    unitsBySelectionId.set(unit.selectionId, unit);
  }
  const bindingByBodyguard = new Map<
    string,
    TesseraAttachmentBindingV3
  >();
  const boundSelectionIds = new Set<string>();
  for (const binding of bindings.filter((candidate) =>
    candidate.side === side
  )) {
    const memberSelectionIds = [
      binding.bodyguardSelectionId,
      binding.leaderSelectionId,
      ...binding.supportingSelectionIds,
    ];
    if (
      memberSelectionIds.some((selectionId) =>
        !unitsBySelectionId.has(selectionId)
      ) ||
      memberSelectionIds.some((selectionId) =>
        boundSelectionIds.has(selectionId)
      ) ||
      bindingByBodyguard.has(binding.bodyguardSelectionId)
    ) {
      throw Object.assign(
        new Error(
          `Selected ${side} attachment ${JSON.stringify(binding.leaderSelectionId)} -> ${JSON.stringify(binding.bodyguardSelectionId)} cannot be composed into the report unit scope.`,
        ),
        { code: "TESSERA_ATTACHMENT_REPORT_SCOPE_INVALID" },
      );
    }
    bindingByBodyguard.set(binding.bodyguardSelectionId, binding);
    memberSelectionIds.forEach((selectionId) =>
      boundSelectionIds.add(selectionId)
    );
  }

  return units.flatMap((unit) => {
    if (!unit.selectionId || !boundSelectionIds.has(unit.selectionId)) {
      return [unit];
    }
    const binding = bindingByBodyguard.get(unit.selectionId);
    if (!binding) return [];
    const members = [
      unit,
      unitsBySelectionId.get(binding.leaderSelectionId)!,
      ...binding.supportingSelectionIds.map((selectionId) =>
        unitsBySelectionId.get(selectionId)!
      ),
    ];
    const name = members.map((member) => member.name).join(" + ");
    const modelCount = members.reduce(
      (sum, member) => sum + member.modelCount,
      0,
    );
    const points = members.every((member) => member.points !== null)
      ? members.reduce((sum, member) => sum + member.points!, 0)
      : null;
    const instanceId = crypto
      .createHash("sha256")
      .update(canonicalJson({
        schemaVersion: 1,
        kind: "tessera-reporting-attachment-formation",
        side,
        memberSelectionIds: members.map((member) => member.selectionId),
      }))
      .digest("hex");
    return [{
      instanceId,
      selectionId: unit.selectionId,
      side,
      name,
      label: unitLabel(name, modelCount, points, unit.ordinal),
      ordinal: unit.ordinal,
      modelCount,
      points,
      tags: [...new Set(members.flatMap((member) => member.tags))].sort(),
    }];
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
  options: { ignoredMismatches?: string[] } = {},
): Promise<RosterIssue | null> {
  try {
    const [source, enriched] = await Promise.all([
      readFile(sourcePath),
      readFile(enrichedPath),
    ]);
    const ignored = new Set(options.ignoredMismatches ?? []);
    const mismatches = compareRoszGameplaySnapshots(
      inspectRoszGameplaySnapshot(source),
      inspectRoszGameplaySnapshot(enriched),
    ).filter((mismatch) => !ignored.has(mismatch));
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
  const localInput =
    prepared.simulationInput?.kind ===
    "rosterpilot-local-engine-input";
  const sourceFilename = localInput
    ? `source-${sourceRoszSha256}.json`
    : `source-${sourceRoszSha256}.rosz`;
  const enrichedFilename = localInput
    ? `local-input-${enrichedRoszSha256}.json`
    : `enriched-${enrichedRoszSha256}.rosz`;
  const [sourceRoszPath, enrichedRoszPath] = await Promise.all([
    writeExportArtifact(
      {
        format: localInput ? "roster-json" : "rosz",
        filename: sourceFilename,
        mimeType: localInput ? "application/json" : "application/zip",
        encoding: "binary",
        content: sourceContent,
      },
      path.join(
        artifactDirectory,
        sourceFilename,
      ),
      { ...options, overwrite: true },
    ),
    writeExportArtifact(
      {
        format: localInput ? "roster-json" : "rosz",
        filename: enrichedFilename,
        mimeType: localInput
          ? "application/vnd.rosterpilot.tessera-local-input+json"
          : "application/zip",
        encoding: "binary",
        content: enrichedContent,
      },
      path.join(
        artifactDirectory,
        enrichedFilename,
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
    ...(prepared.simulationInput?.kind ===
    "rosterpilot-local-engine-input"
      ? {
          simulationInput: {
            ...prepared.simulationInput,
            path: enrichedRoszPath,
            sha256: enrichedRoszSha256,
          },
        }
      : {}),
  };
}

async function verifiedPreparedRosterReuse(
  prepared: TesseraPreparedRoster,
  roster: RosterDraftV1 | null,
  catalogueDriftMode: "reject" | "diagnostic" | "force" | undefined,
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
    if (
      prepared.simulationInput?.kind ===
      "rosterpilot-local-engine-input"
    ) {
      const localInput = verifyLocalTesseraEngineInputAnyVersion({
        content: enriched,
        expectedSha256: prepared.simulationInput.sha256,
        expectedBundleId: prepared.simulationInput.bundleId,
        expectedRosterFingerprint: expectedFingerprint,
      });
      if (
        localInput.compilerVersion !==
          prepared.simulationInput.compilerVersion ||
        localInput.totalPoints !== prepared.summary.totalPoints ||
        !factionNamesCompatible(
          localInput.factionName,
          prepared.summary.factionName,
        ) ||
        localInput.units.length !== prepared.summary.units.length ||
        (
          roster !== null &&
          (
            localInput.totalPoints !== roster.totalPoints ||
            localInput.factionId !== roster.factionId
          )
        )
      ) {
        return fail(
          "The durable local-engine checkpoint no longer matches its frozen roster, bundle, compiler, or summary identity.",
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
              "Reused a hash-verified run-local data-bundle input; no New Recruit or website activity was performed.",
            severity: "warn",
          },
        ],
      };
    }
    const actualSummary = validateTesseraReadyRosz(enriched).summary;
    const ignoredGameplayMismatches =
      catalogueDriftMode === "force"
        ? new Set(["game-system", "catalogue", "points", "selection-tree"])
        : catalogueDriftMode === "diagnostic" &&
          prepared.catalogueProvenance &&
          isForwardGameSystemRevisionOnlyDrift(
            prepared.catalogueProvenance,
          )
          ? new Set(["game-system"])
          : new Set<string>();
    const gameplayMismatches = compareRoszGameplaySnapshots(
      inspectRoszGameplaySnapshot(source),
      inspectRoszGameplaySnapshot(enriched),
    ).filter(
      (mismatch) => !ignoredGameplayMismatches.has(mismatch),
    );
    if (
      gameplayMismatches.length > 0 ||
      (catalogueDriftMode !== "force" && !summariesGameplayCompatible(actualSummary, prepared.summary)) ||
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
        const reuseReceipt = await recordNewRecruitReuseReceipt({
          roster: opponentRosterContext!,
          runId: mutationRunId,
          delivery: persisted,
        });
        if (persisted.data) {
          try {
            await recordVerifiedServiceObservation(
              opponentRosterContext!,
              persisted.data,
              reuseReceipt,
            );
          } catch (error) {
            warnings.push({
              code: "SERVICE_COMPATIBILITY_OBSERVATION_WRITE_FAILED",
              message:
                `The hash-verified cached opponent remains reusable, but its catalogue identity could not be indexed: ${
                  error instanceof Error ? error.message : String(error)
                }. No duplicate upload was attempted.`,
              severity: "warn",
            });
          }
        }
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
  let catalogueProvenance:
    | UploadedRoszCatalogueProvenance
    | undefined;
  let diagnosticRevisionDriftAccepted = false;
  if (!uploadedArtifactProvenanceVerified) {
    const comparison = uploadedRoszCatalogueProvenance(
      prepared.summary,
      playerRoster,
      opponentRosterContext,
      preflight.factionId,
    );
    if (!comparison) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: opponentRosterContext
              ? "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNAVAILABLE"
              : "TESSERA_ROSZ_PROVENANCE_UNVERIFIABLE",
            message: opponentRosterContext
              ? "The canonical opponent context does not have a pinned New Recruit catalogue identity."
              : "The enriched uploaded opponent does not expose one supported pinned faction catalogue identity.",
            severity: "error",
          },
        ],
        warnings,
      };
    }
    catalogueProvenance = comparison;
    diagnosticRevisionDriftAccepted =
      acceptsUploadedRoszRevisionDiagnostic(
        comparison,
        options.catalogueDriftMode,
      );
    if (
      comparison.status !== "matched" &&
      !diagnosticRevisionDriftAccepted
    ) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: opponentRosterContext
              ? comparison.status === "drift"
                ? "NEW_RECRUIT_CATALOGUE_DRIFT"
                : "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNVERIFIABLE"
              : comparison.status === "drift"
                ? "TESSERA_ROSZ_DATA_PIN_MISMATCH"
                : "TESSERA_ROSZ_PROVENANCE_UNVERIFIABLE",
            message: opponentRosterContext
              ? "The enriched uploaded opponent does not prove the canonical opponent context's pinned catalogue identity."
              : "The enriched uploaded opponent does not retain the frozen source's pinned game-system and faction catalogue identity.",
            severity: "error",
          },
        ],
        warnings,
      };
    }
    if (diagnosticRevisionDriftAccepted) {
      appendUploadedRoszRevisionDiagnosticWarning(
        warnings,
        comparison,
      );
    }
  }
  const gameplayIntegrity = await verifyRoszGameplayArtifacts(
    frozenSourcePath,
    prepared.enrichedRoszPath,
    prepared.rosterName,
    {
      ignoredMismatches: diagnosticRevisionDriftAccepted
        ? ["game-system"]
        : [],
    },
  );
  if (gameplayIntegrity) {
    return {
      ok: false,
      data: null,
      violations: [gameplayIntegrity],
      warnings,
    };
  }
  try {
    const preparedContent = await readFile(
      prepared.enrichedRoszPath,
    );
    validateTesseraReadyRosz(preparedContent);
  } catch (error) {
    const coded = error as { code?: unknown };
    const code =
      coded.code === "TESSERA_INPUT_PROFILES_INCOMPLETE"
        ? "TESSERA_ROSZ_PROFILES_INCOMPLETE"
        : coded.code === "TESSERA_INPUT_NOT_PROFILE_RICH"
          ? "TESSERA_ROSZ_PROFILES_MISSING"
          : "TESSERA_ROSZ_PROFILE_INVENTORY_INVALID";
    return {
      ok: false,
      data: null,
      violations: [
        {
          code,
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

  if (
    pendingPersistentCacheStore &&
    (
      uploadedArtifactProvenanceVerified ||
      catalogueProvenance?.status === "matched"
    )
  ) {
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
    if (matched.length > 1) return null;
  }
  const occurrenceMatched = candidates.filter(
    (unit) => unit.ordinal === occurrence,
  );
  if (occurrenceMatched.length === 1) return occurrenceMatched[0];
  if (occurrenceMatched.length > 1) return null;
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

function combinedEvidenceSha256(values: Array<string | null>): string | null {
  const retained = values.filter(
    (value): value is string => value !== null,
  );
  if (retained.length !== values.length || retained.length === 0) {
    return null;
  }
  const unique = [...new Set(retained)].sort();
  return unique.length === 1
    ? unique[0]
    : crypto
        .createHash("sha256")
        .update(JSON.stringify(unique))
        .digest("hex");
}

export function aggregateWebsiteProviderEvidence(
  captures: Array<{
    opponentName: string;
    evidence: TesseraWebsiteProviderEvidence;
  }>,
): TesseraWebsiteProviderEvidence | undefined {
  if (captures.length === 0) return undefined;
  if (captures.length === 1) {
    return structuredClone(captures[0].evidence);
  }
  const evidences = captures.map((capture) => capture.evidence);
  const assetsByUrl = new Map<
    string,
    TesseraWebsiteProviderEvidence["deployment"]["assets"][number]
  >();
  let assetConflict = false;
  for (const asset of evidences.flatMap(
    (evidence) => evidence.deployment.assets,
  )) {
    const existing = assetsByUrl.get(asset.url);
    if (
      existing &&
      (
        existing.sha256 !== asset.sha256 ||
        existing.sameOrigin !== asset.sameOrigin ||
        existing.byteLength !== asset.byteLength
      )
    ) {
      assetConflict = true;
    } else {
      assetsByUrl.set(asset.url, asset);
    }
  }
  const deploymentComplete =
    !assetConflict &&
    evidences.every((evidence) => evidence.deployment.complete) &&
    new Set(
      evidences.map((evidence) => evidence.deployment.identitySha256),
    ).size === 1;
  // This branch aggregates multiple opponents, so one opponentSnapshot field
  // cannot represent the complete scope. Exact snapshots remain in captures.
  const importComplete = false;
  const playerSha256 = combinedEvidenceSha256(
    evidences.map(
      (evidence) => evidence.importSemantics.playerSha256,
    ),
  );
  const playerSnapshot = playerSha256
    ? evidences.find(
        (evidence) =>
          evidence.importSemantics.playerSha256 === playerSha256,
      )?.importSemantics.playerSnapshot ?? null
    : null;
  return {
    schemaVersion: 1,
    deployment: {
      identitySha256: combinedEvidenceSha256(
        evidences.map(
          (evidence) => evidence.deployment.identitySha256,
        ),
      ),
      declaredVersion:
        new Set(
          evidences.map(
            (evidence) => evidence.deployment.declaredVersion,
          ),
        ).size === 1
          ? evidences[0].deployment.declaredVersion
          : null,
      assets: [...assetsByUrl.values()].sort((left, right) =>
        left.url.localeCompare(right.url)
      ),
      complete: deploymentComplete,
      completeness: deploymentComplete
        ? "complete"
        : evidences.some(
              (evidence) =>
                evidence.deployment.completeness === "partial" ||
                evidence.deployment.completeness === "complete",
            )
          ? "partial"
          : evidences.some(
                (evidence) =>
                  evidence.deployment.completeness === "fallback",
              )
            ? "fallback"
            : "unavailable",
      declarationSha256: combinedEvidenceSha256(
        evidences.map(
          (evidence) => evidence.deployment.declarationSha256,
        ),
      ),
      incompleteReasons: deploymentComplete
        ? []
        : [
            ...new Set([
              ...(assetConflict ? ["asset-fingerprint-conflict"] : []),
              ...evidences.flatMap((evidence) =>
                evidence.deployment.incompleteReasons,
              ),
            ]),
          ].sort(),
    },
    importSemantics: {
      combinedSha256: combinedEvidenceSha256(
        evidences.map(
          (evidence) => evidence.importSemantics.combinedSha256,
        ),
      ),
      playerSha256,
      opponentSha256: combinedEvidenceSha256(
        evidences.map(
          (evidence) => evidence.importSemantics.opponentSha256,
        ),
      ),
      complete: importComplete,
      completeness: importComplete
        ? "complete"
        : evidences.some(
              (evidence) =>
                evidence.importSemantics.completeness !== "unavailable",
            )
          ? "partial"
          : "unavailable",
      unresolvedEffectCount: evidences.reduce(
        (total, evidence) =>
          total + evidence.importSemantics.unresolvedEffectCount,
        0,
      ),
      playerSnapshot,
      opponentSnapshot: null,
      incompleteReasons: importComplete
        ? []
        : [
            ...new Set(
              [
                "multi-opponent-semantic-snapshots-retained-in-provider-evidence-captures",
                ...captures.flatMap((capture) =>
                  capture.evidence.importSemantics.incompleteReasons.map(
                    (reason) => `${capture.opponentName}:${reason}`,
                  ),
                ),
              ],
            ),
          ].sort(),
    },
  };
}

export function consolidateBrowserScenarios(
  result: TesseraBrowserResult,
  playerUnits: TesseraUnitInstance[],
  opponentUnits: TesseraUnitInstance[],
  opponentName: string,
  configuration: TesseraAnalysisConfiguration,
  selectedAttachmentBindings: readonly TesseraAttachmentBindingV3[] = [],
): TesseraScenarioResult[] {
  const reportingPlayerUnits = selectedAttachmentReportingUnits(
    playerUnits,
    "player",
    selectedAttachmentBindings,
  );
  const reportingOpponentUnits = selectedAttachmentReportingUnits(
    opponentUnits,
    "opponent",
    selectedAttachmentBindings,
  );
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
        seed?: number;
        executionSha256?: string;
        projectionSha256?: string;
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
      seed: raw.seed,
      executionSha256: raw.executionSha256,
      projectionSha256: raw.projectionSha256,
      matrixSha256: raw.matrixSha256,
      integrity: raw.integrity,
    });
    group.iterations ??= raw.iterations ?? null;
    Object.assign(group.settings, raw.settings ?? {});
    const attackers =
      direction === "player-to-opponent"
        ? reportingPlayerUnits
        : reportingOpponentUnits;
    const targets =
      direction === "player-to-opponent"
        ? reportingOpponentUnits
        : reportingPlayerUnits;
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
          uncertainty: {},
          confidence,
          warningRefs,
        };
      cell.values[metricField(metric)] = rawCell.metricValue;
      if (rawCell.combatEnvelope) {
        cell.combatEnvelope = {
          ...(cell.combatEnvelope ?? {}),
          [metric]: structuredClone(rawCell.combatEnvelope),
        };
        if (
          rawCell.combatEnvelope.coverage.claimEligibility !==
          "decision-grade"
        ) {
          cell.warningRefs = [
            ...new Set([
              ...cell.warningRefs,
              `Local combat-rule coverage is ${rawCell.combatEnvelope.coverage.status}; this ${metric} envelope is ${rawCell.combatEnvelope.coverage.claimEligibility}.`,
            ]),
          ];
        }
      }
      cell.uncertainty = {
        ...(cell.uncertainty ?? {}),
        [metric]: rawCell.uncertainty ?? {
          sampleCount: null,
          standardDeviation: null,
          standardError: null,
          completeness: "unavailable",
        },
      };
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
        ? reportingPlayerUnits.length * reportingOpponentUnits.length
        : reportingOpponentUnits.length * reportingPlayerUnits.length;
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
      source:
        input.player.simulationInput?.kind ===
        "rosterpilot-local-engine-input"
          ? "rosterpilot-data-bundle"
          : "new-recruit",
      uniqueRosters: 1 + opponents.length,
      remoteMutations:
        input.player.simulationInput?.kind ===
        "rosterpilot-local-engine-input"
          ? 0
          : remoteMutations,
      cacheReuses:
        input.player.simulationInput?.kind ===
        "rosterpilot-local-engine-input"
          ? 0
          : cacheReuses,
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
  let personalLocalAttestation =
    dependencies.personalLocalAttestation;
  if (personalLocalAttestation === undefined) {
    try {
      personalLocalAttestation =
        await loadCurrentPersonalLocalParityAttestationContextV1({
          providerIdentitySha256:
            personalLocalProviderIdentitySha256(
              LOCAL_TESSERA_ENGINE_IDENTITY,
            ),
          bundleId: playerRoster.sourceData.bundleId,
        });
    } catch {
      // A malformed, stale, or unsafe personal store fails closed to Web.
      personalLocalAttestation = null;
    }
  }
  // Freeze the rules object/provider reference before any asynchronous
  // preparation. A later refresh may affect future leases, never this run.
  const capturedRuntimeDataset = activeRuntimeDataset;
  const capturedRuntimeSourceData = currentRosterSourceData(
    playerRoster.factionId,
  );
  const configuredDataBundleProvider =
    dependencies.dataBundleProvider ??
    (getConfiguredDataBundleProvider() as
      | DataBundleProvider<RuntimeDataBundleShardDataV1>
      | null);
  const outputDirectory = options.outputDirectory ?? "exports/tessera";
  const mutationRunId =
    options.sessionId ?? `tessera-exact-${crypto.randomUUID()}`;
  const basename = `${safeName(playerRoster.name) || "roster"}-matchup`;
  const baselineArtifactName =
    `${basename}-baseline-damage-v1.json`;
  const configuration = analysisConfiguration(options);
  const executionMode = effectiveExecutionMode(options);
  const simulationRequested = executionMode === "simulate";
  const requestedSimulationBackend = options.simulationBackend ?? "auto";
  const plannedSimulationBackend: TesseraSimulationProvider =
    requestedSimulationBackend === "local-engine"
      ? "local-engine"
      : requestedSimulationBackend === "website"
        ? "website"
        : localTesseraEngineIsAutoSelectable(
            personalLocalAttestation,
          )
          ? "local-engine"
          : "website";
  let scenarioContract: TesseraFrozenScenarioContract[] | null = null;
  try {
    const requestedContract = options.scenarioContract
      ? canonicalTesseraScenarioContract(options.scenarioContract)
      : null;
    const frozenContract = options.frozenScenarioContract
      ? canonicalTesseraScenarioContract(
          options.frozenScenarioContract,
        )
      : null;
    if (
      requestedContract &&
      frozenContract &&
      tesseraScenarioContractSha256(requestedContract) !==
        tesseraScenarioContractSha256(frozenContract)
    ) {
      throw Object.assign(
        new Error(
          "The caller-supplied and coordinator-frozen Tessera scenario contracts differ.",
        ),
        { code: "TESSERA_SCENARIO_CONTRACT_MISMATCH" },
      );
    }
    scenarioContract = requestedContract ?? frozenContract;
    if (scenarioContract) {
      if (!simulationRequested) {
        throw Object.assign(
          new Error(
            "A Tessera scenario contract requires executionMode=simulate.",
          ),
          { code: "TESSERA_SCENARIO_CONTRACT_MISMATCH" },
        );
      }
      scenarioContract = assertTesseraScenarioContractScope(
        scenarioContract,
        configuration.phases,
        configuration.metrics,
      );
      assertTesseraScenarioContractProvider(
        scenarioContract,
        plannedSimulationBackend,
      );
    }
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code:
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : "TESSERA_SCENARIO_CONTRACT_INVALID",
          message:
            error instanceof Error
              ? error.message
              : "The Tessera scenario contract is invalid.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const selectedAttachmentBindings =
    options.selectedAttachmentBindings ?? [];
  const selectedAttachmentBindingsV2 = selectedAttachmentBindings.map(
    (binding) => ({
      leaderSelectionId: binding.leaderSelectionId,
      bodyguardSelectionId: binding.bodyguardSelectionId,
      supportingSelectionIds: [...binding.supportingSelectionIds],
    }),
  );
  let scenarioPolicyContractV2: TesseraScenarioPolicyContractV2 | null = null;
  let scenarioPolicyContractV2Sha256: string | null = null;
  let scenarioPolicyContractV3: TesseraScenarioPolicyContractV3 | null = null;
  let scenarioPolicyContractV3Sha256: string | null = null;
  try {
    if (
      options.scenarioPolicyContractV2 &&
      plannedSimulationBackend !== "local-engine"
    ) {
      throw Object.assign(
        new Error(
          "The v2 combat scenario/policy contract is supported only by the bundle-native local engine.",
        ),
        { code: "TESSERA_SCENARIO_POLICY_PROVIDER_UNSUPPORTED" },
      );
    }
    if (
      simulationRequested &&
      (plannedSimulationBackend === "local-engine" ||
        options.providerParityCase)
    ) {
      scenarioPolicyContractV2 = options.scenarioPolicyContractV2
        ? canonicalTesseraScenarioPolicyContractV2(
            options.scenarioPolicyContractV2,
          )
        : options.selectedPlayerAbilityIds?.length
          ? selectedAbilitiesTesseraScenarioPolicyContractV2(
              LOCAL_TESSERA_ENGINE_ITERATIONS,
              options.selectedPlayerAbilityIds,
              configuration.phases,
              configuration.metrics,
            )
          : options.activationMode === "envelope"
            ? activationEnvelopeTesseraScenarioPolicyContractV2(
                LOCAL_TESSERA_ENGINE_ITERATIONS,
                configuration.phases,
                configuration.metrics,
              )
            : scenarioContract
              ? migrateTesseraScenarioContractV1ToV2(scenarioContract)
          : selectedBaselineTesseraScenarioPolicyContractV2(
              LOCAL_TESSERA_ENGINE_ITERATIONS,
              configuration.phases,
              configuration.metrics,
            );
      scenarioPolicyContractV2 =
        assertTesseraScenarioPolicyContractV2Scope(
          scenarioPolicyContractV2,
          configuration.phases,
          configuration.metrics,
        );
      if (selectedAttachmentBindingsV2.length > 0) {
        scenarioPolicyContractV2 =
          withSelectedTesseraAttachmentBindingsV2(
            scenarioPolicyContractV2,
            selectedAttachmentBindingsV2,
          );
      }
      if (scenarioContract && options.scenarioPolicyContractV2) {
        const migrated = migrateTesseraScenarioContractV1ToV2(
          scenarioContract,
        );
        if (
          JSON.stringify(migrated.scenarios) !==
          JSON.stringify(scenarioPolicyContractV2.scenarios)
        ) {
          throw Object.assign(
            new Error(
              "The v1 scenario settings and v2 combat context describe different engagements.",
            ),
            { code: "TESSERA_SCENARIO_POLICY_CONTRACT_MISMATCH" },
          );
        }
      }
      scenarioPolicyContractV2Sha256 =
        tesseraScenarioPolicyContractV2Sha256(
          scenarioPolicyContractV2,
        );
    }
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code:
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : "TESSERA_SCENARIO_POLICY_CONTRACT_V2_INVALID",
          message:
            error instanceof Error
              ? error.message
              : "The Tessera scenario/policy v2 contract is invalid.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
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
  let operationDataBundleLease:
    | Awaited<
        ReturnType<
          DataBundleProvider<RuntimeDataBundleShardDataV1>["acquireSnapshot"]
        >
      >
    | null = null;
  let operationDataBundleSnapshot:
    | DataBundleSnapshot<RuntimeDataBundleShardDataV1>
    | null = null;
  let operationLocalDataContext: LocalTesseraEngineDataContext | null = null;
  try {
    if (
      plannedSimulationBackend === "local-engine" ||
      options.providerParityCase
    ) {
      try {
        if (configuredDataBundleProvider) {
          const factionIds = new Set<string>([playerRoster.factionId]);
          if (opponent.kind === "roster") {
            factionIds.add(opponent.roster.factionId);
          } else if (opponent.kind === "rosz") {
            if (options.opponentRosterContext) {
              factionIds.add(options.opponentRosterContext.factionId);
            }
          } else {
            factionIds.add(opponent.factionId);
          }
          operationDataBundleLease =
            await configuredDataBundleProvider.acquireSnapshot({
              bundleId: playerRoster.sourceData.bundleId,
              factionIds: [...factionIds].sort(),
            });
          const snapshot = operationDataBundleLease.snapshot;
          operationDataBundleSnapshot = snapshot;
          operationLocalDataContext = {
            dataset: runtimeDatasetFromSnapshot(snapshot),
            bundleId: snapshot.bundleId,
            engineDataSchemaVersion:
              snapshot.manifest.engineDataSchemaVersion,
          };
        } else {
          operationLocalDataContext = {
            dataset: capturedRuntimeDataset,
            bundleId: capturedRuntimeSourceData.bundleId,
            engineDataSchemaVersion:
              capturedRuntimeSourceData.engineDataSchemaVersion,
          };
        }
      } catch (error) {
        return {
          ok: false,
          data: null,
          violations: [
            {
              code:
                error &&
                typeof error === "object" &&
                "code" in error &&
                typeof error.code === "string"
                  ? error.code
                  : "TESSERA_DATA_BUNDLE_ACQUISITION_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : "The exact local-engine data snapshot could not be acquired.",
              severity: "error",
            },
          ],
          warnings: [],
        };
      }
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
      if (
        options.selectedPlayerAbilityIds?.length &&
        operationDataBundleSnapshot
      ) {
        try {
          const iterations =
            scenarioPolicyContractV2?.scenarios[0]?.iterations ??
            LOCAL_TESSERA_ENGINE_ITERATIONS;
          const discoveryPolicy =
            selectedBaselineTesseraScenarioPolicyContractV2(
              iterations,
              configuration.phases,
              configuration.metrics,
            );
          const discoveryInput =
            await compileCombatBridgeInputV2FromSnapshot({
              snapshot: operationDataBundleSnapshot,
              playerRoster,
              opponentRoster: opponent.roster,
              scenarioPolicy: discoveryPolicy,
            });
          const discoveryBridge = await compileCombatBridgeV2(
            discoveryInput,
          );
          const available = new Set(
            discoveryBridge.cells.flatMap((cell) =>
              cell.availableActivationIds
            ),
          );
          const resolvedActivationIds =
            options.selectedPlayerAbilityIds.flatMap((abilityId) => {
              const matches = [...available].filter((activationId) =>
                activationId.startsWith(`attacker:${abilityId}:`) ||
                activationId.startsWith(`target:${abilityId}:`)
              );
              if (matches.length === 0) {
                throw Object.assign(
                  new Error(
                    `Selected player ability ${JSON.stringify(abilityId)} has no supported optional combat activation in the leased bundle.`,
                  ),
                  { code: "TESSERA_SELECTED_ABILITY_UNRESOLVED" },
                );
              }
              return matches;
            });
          scenarioPolicyContractV2 =
            selectedAbilitiesTesseraScenarioPolicyContractV2(
              iterations,
              options.selectedPlayerAbilityIds,
              configuration.phases,
              configuration.metrics,
              resolvedActivationIds,
            );
          if (selectedAttachmentBindingsV2.length > 0) {
            scenarioPolicyContractV2 =
              withSelectedTesseraAttachmentBindingsV2(
                scenarioPolicyContractV2,
                selectedAttachmentBindingsV2,
              );
          }
          scenarioPolicyContractV2Sha256 =
            tesseraScenarioPolicyContractV2Sha256(
              scenarioPolicyContractV2,
            );
          scenarioPolicyContractV3 =
            selectedAbilitiesTesseraScenarioPolicyContractV3(
              iterations,
              {
                playerSelectionIds: playerRoster.units.map(
                  (unit) => unit.selectionId,
                ),
                opponentSelectionIds: opponent.roster.units.map(
                  (unit) => unit.selectionId,
                ),
              },
              options.selectedPlayerAbilityIds.map((abilityId) => ({
                ownerSide: "player",
                abilityId,
              })),
              configuration.phases,
              configuration.metrics,
              resolvedActivationIds,
            );
          if (selectedAttachmentBindings.length > 0) {
            scenarioPolicyContractV3 =
              withSelectedTesseraAttachmentBindingsV3(
                scenarioPolicyContractV3,
                selectedAttachmentBindings,
              );
          }
          scenarioPolicyContractV3Sha256 =
            tesseraScenarioPolicyContractV3Sha256(
              scenarioPolicyContractV3,
            );
        } catch (error) {
          return {
            ok: false,
            data: null,
            violations: [{
              code:
                error &&
                typeof error === "object" &&
                "code" in error &&
                typeof error.code === "string"
                  ? error.code
                  : "TESSERA_SELECTED_ABILITY_UNRESOLVED",
              message:
                error instanceof Error
                  ? error.message
                  : "The selected player ability could not be bound to the leased combat rules.",
              severity: "error",
            }],
            warnings: playerValidation.warnings,
          };
        }
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
        options.catalogueDriftMode,
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
      ], operationLocalDataContext?.dataset),
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
    if (
      simulationRequested &&
      plannedSimulationBackend === "website" &&
      !dependencies.runBrowser
    ) {
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
      let providerParityPreflight: {
        opponentRoster: RosterDraftV1;
        prepared: PreparedCombatBridgeInputV3;
        bridge: CombatBridgeV3;
      } | null = null;
      if (options.providerParityCase) {
        const parityOpponentRoster =
          opponent.kind === "roster"
            ? opponent.roster
            : opponent.kind === "rosz"
              ? options.opponentRosterContext ?? null
              : null;
        try {
          if (
            !simulationRequested ||
            !operationDataBundleSnapshot ||
            !operationLocalDataContext ||
            !scenarioPolicyContractV2 ||
            !parityOpponentRoster
          ) {
            throw Object.assign(
              new Error(
                "Exact provider parity requires simulate mode, one canonical opponent roster, and an immutable verified data-bundle snapshot.",
              ),
              { code: "TESSERA_PROVIDER_PARITY_V2_PREFLIGHT_INVALID" },
            );
          }
          const unitScope = {
            playerSelectionIds: playerRoster.units.map(
              (unit) => unit.selectionId,
            ),
            opponentSelectionIds: parityOpponentRoster.units.map(
              (unit) => unit.selectionId,
            ),
          };
          scenarioPolicyContractV3 =
            options.scenarioPolicyContractV3
              ? canonicalTesseraScenarioPolicyContractV3(
                  options.scenarioPolicyContractV3,
                )
              : options.selectedPlayerAbilityIds?.length
                ? selectedAbilitiesTesseraScenarioPolicyContractV3(
                    scenarioPolicyContractV2.scenarios[0]?.iterations ??
                      LOCAL_TESSERA_ENGINE_ITERATIONS,
                    unitScope,
                    options.selectedPlayerAbilityIds.map((abilityId) => ({
                      ownerSide: "player",
                      abilityId,
                    })),
                    configuration.phases,
                    configuration.metrics,
                  )
                : options.activationMode === "envelope"
                  ? activationEnvelopeTesseraScenarioPolicyContractV3(
                      scenarioPolicyContractV2.scenarios[0]?.iterations ??
                        LOCAL_TESSERA_ENGINE_ITERATIONS,
                      unitScope,
                      configuration.phases,
                      configuration.metrics,
                    )
              : selectedBaselineTesseraScenarioPolicyContractV3(
                  scenarioPolicyContractV2.scenarios[0]?.iterations ??
                    LOCAL_TESSERA_ENGINE_ITERATIONS,
                  unitScope,
                  configuration.phases,
                  configuration.metrics,
                );
          scenarioPolicyContractV3 =
            assertTesseraScenarioPolicyContractV3Scope(
              scenarioPolicyContractV3,
              configuration.phases,
              configuration.metrics,
              unitScope,
            );
          if (selectedAttachmentBindings.length > 0) {
            scenarioPolicyContractV3 =
              withSelectedTesseraAttachmentBindingsV3(
                scenarioPolicyContractV3,
                selectedAttachmentBindings,
              );
          }
          scenarioPolicyContractV3Sha256 =
            tesseraScenarioPolicyContractV3Sha256(
              scenarioPolicyContractV3,
            );
          const prepared =
            await prepareCombatBridgeInputV3FromSnapshot({
              snapshot: operationDataBundleSnapshot,
              playerRoster,
              opponentRoster: parityOpponentRoster,
              scenarioPolicy: scenarioPolicyContractV3,
              localInputs: {
                player: compileRosterForLocalTesseraEngineV2(
                  playerRoster,
                  profilePolicy,
                  operationLocalDataContext,
                ),
                opponent: compileRosterForLocalTesseraEngineV2(
                  parityOpponentRoster,
                  profilePolicy,
                  operationLocalDataContext,
                ),
              },
            });
          providerParityPreflight = {
            opponentRoster: parityOpponentRoster,
            prepared,
            bridge: await compileCombatBridgeV3(prepared.input),
          };
        } catch (error) {
          let retainedReviewPaths: string[] = [];
          if (
            error instanceof CombatBridgeInputV3PreparationError &&
            error.artifact
          ) {
            const prefix = [
              "combat-corpus-review",
              safeName(parityOpponentRoster?.name ?? "opponent") ||
                "opponent",
            ].join("-");
            try {
              retainedReviewPaths = await writeExportArtifacts(
                [
                  {
                    format: "roster-json",
                    filename: `${prefix}-inventory.json`,
                    mimeType: "application/json",
                    encoding: "utf8",
                    content: `${JSON.stringify(error.artifact.inventory, null, 2)}\n`,
                  },
                  {
                    format: "roster-json",
                    filename: `${prefix}-overlay.json`,
                    mimeType: "application/json",
                    encoding: "utf8",
                    content: `${JSON.stringify(error.artifact.overlay, null, 2)}\n`,
                  },
                  {
                    format: "roster-json",
                    filename: `${prefix}-report.json`,
                    mimeType: "application/json",
                    encoding: "utf8",
                    content: `${JSON.stringify(error.artifact.report, null, 2)}\n`,
                  },
                ],
                outputDirectory,
                options,
              );
            } catch {
              retainedReviewPaths = [];
            }
          }
          const violation: RosterIssue = {
            code:
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "TESSERA_PROVIDER_PARITY_V2_PREFLIGHT_INVALID",
            message: `${
              error instanceof Error
                ? error.message
                : "Exact provider-parity preflight failed."
            }${
              retainedReviewPaths.length > 0
                ? ` Review artifacts: ${retainedReviewPaths.join(", ")}.`
                : ""
            } No New Recruit or Tessera Web activity was started.`,
            severity: "error",
          };
          return {
            ok: false,
            data: null,
            violations: [violation],
            warnings: playerValidation.warnings,
          };
        }
      }
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
            options.catalogueDriftMode,
          )
        : await prepareRosterForTessera(
            playerRoster,
            {
              ...options,
              simulationBackend: plannedSimulationBackend,
              profilePolicy,
              dataContext: operationLocalDataContext ?? undefined,
              mutationRunId,
              outputDirectory: path.join(outputDirectory, "player"),
            },
            dependencies,
          );
      if (!player.ok || !player.data) {
        let failedPlayer = player.data;
        if (failedPlayer) {
          try {
            failedPlayer = await materializePreparedRosterArtifacts(
              failedPlayer,
              path.join(outputDirectory, "player"),
              options,
            );
          } catch {
            // The original verified paths and hashes remain visible in the failed
            // report; the durable job layer will refuse an out-of-bundle path.
          }
        }
        return {
          ok: false,
          data: failedPlayer
            ? failedPreparationReport({
                playerRoster,
                player: failedPlayer,
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
        preparedPlayer.units = canonicalUnits(playerRoster, "player");
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
              options.catalogueDriftMode,
            )
          : await prepareRosterForTessera(
              opponent.roster,
              {
                ...options,
                simulationBackend: plannedSimulationBackend,
                profilePolicy,
                dataContext: operationLocalDataContext ?? undefined,
                mutationRunId,
                outputDirectory: path.join(outputDirectory, "opponent"),
              },
              dependencies,
            );
        if (!prepared.ok || !prepared.data) {
          let failedOpponent = prepared.data;
          if (failedOpponent) {
            try {
              failedOpponent = await materializePreparedRosterArtifacts(
                failedOpponent,
                path.join(outputDirectory, "opponent"),
                options,
              );
            } catch {
              // Preserve the verified paths in the failed report; the durable job
              // layer still enforces confinement before checkpointing them.
            }
          }
          const preparedOpponent = failedOpponent
            ? [
                {
                  kind: "roster" as const,
                  rosterName: failedOpponent.rosterName,
                  sourceRoszPath: failedOpponent.sourceRoszPath,
                  enrichedRoszPath: failedOpponent.enrichedRoszPath,
                  sourceRoszSha256:
                    failedOpponent.sourceRoszSha256,
                  enrichedRoszSha256:
                    failedOpponent.enrichedRoszSha256,
                  simulationInput: failedOpponent.simulationInput,
                  summary: failedOpponent.summary,
                  fingerprint: rosterExecutionFingerprint(opponent.roster),
                  units: canonicalUnits(opponent.roster, "opponent"),
                  cacheReused: failedOpponent.cacheReused,
                  connectorEvents: failedOpponent.connectorEvents,
                  catalogueProvenance: failedOpponent.catalogueProvenance,
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
          simulationInput: materializedOpponent.simulationInput,
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
        if (plannedSimulationBackend === "local-engine") {
          const opponentRosterContext = options.opponentRosterContext;
          if (!opponentRosterContext) {
            const violation: RosterIssue = {
              code: "TESSERA_LOCAL_OPPONENT_CONTEXT_REQUIRED",
              message:
                "A bundle-native local simulation cannot derive authoritative rules from an uploaded ROSZ alone. Supply the matching canonical opponent roster context; New Recruit enrichment was not attempted.",
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
                opponentName: path.basename(opponent.path),
              }),
              violations: [violation],
              warnings: player.warnings,
            };
          }
          const prepared = await prepareRosterForTessera(
            opponentRosterContext,
            {
              ...options,
              simulationBackend: "local-engine",
              profilePolicy,
              dataContext: operationLocalDataContext ?? undefined,
              mutationRunId,
              outputDirectory: path.join(outputDirectory, "opponent"),
            },
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
                opponentName: opponentRosterContext.name,
              }),
              violations: prepared.violations,
              warnings: [...player.warnings, ...prepared.warnings],
            };
          }
          let materializedOpponent: TesseraPreparedRoster;
          try {
            materializedOpponent = await materializePreparedRosterArtifacts(
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
                  : "The bundle-native uploaded-opponent context could not be materialized.",
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
                opponentName: opponentRosterContext.name,
              }),
              violations: [violation],
              warnings: [...player.warnings, ...prepared.warnings],
            };
          }
          opponents.push({
            kind: "rosz",
            rosterName: materializedOpponent.rosterName,
            sourceRoszPath: materializedOpponent.sourceRoszPath,
            enrichedRoszPath: materializedOpponent.enrichedRoszPath,
            sourceRoszSha256: materializedOpponent.sourceRoszSha256,
            enrichedRoszSha256: materializedOpponent.enrichedRoszSha256,
            simulationInput: materializedOpponent.simulationInput,
            summary: materializedOpponent.summary,
            fingerprint: rosterExecutionFingerprint(opponentRosterContext),
            units: canonicalUnits(opponentRosterContext, "opponent"),
            cacheReused: false,
            connectorEvents: [],
          });
          opponentDrafts.push(opponentRosterContext);
        } else {
        const frozenOpponentReuse =
          options.preparedReuse?.opponent ??
          options.frozenOpponentReuse;
        if (frozenOpponentReuse) {
          const reused = await verifiedPreparedRosterReuse(
            frozenOpponentReuse,
            options.opponentRosterContext ?? null,
            options.catalogueDriftMode,
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
          simulationInput: uploadedArtifact.simulationInput,
          summary: prepared.data.summary,
          fingerprint: uploadedArtifact.fingerprint,
          units: uploadedArtifact.units,
          cacheReused: prepared.data.cacheReused,
          connectorEvents: prepared.data.connectorEvents,
          catalogueProvenance: prepared.data.catalogueProvenance,
        });
        opponentDrafts.push(options.opponentRosterContext ?? null);
        }
        }
      } else {
        for (const item of factionProxyItems) {
          const prepared = await prepareRosterForTessera(
            item.roster,
            {
              ...options,
              simulationBackend: plannedSimulationBackend,
              profilePolicy,
              dataContext: operationLocalDataContext ?? undefined,
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
                    simulationInput: prepared.data.simulationInput,
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
            sourceRoszPath: materializedOpponent.sourceRoszPath,
            enrichedRoszPath: materializedOpponent.enrichedRoszPath,
            sourceRoszSha256:
              materializedOpponent.sourceRoszSha256,
            enrichedRoszSha256:
              materializedOpponent.enrichedRoszSha256,
            simulationInput: materializedOpponent.simulationInput,
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
      let enrichedProfileRequirements = mergedProfileRequirements([
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

      if (simulationRequested && (options.scenarioPolicyContractV3 ||
        options.providerParityCase ||
        (
          plannedSimulationBackend === "local-engine" &&
          opponents.length === 1
        ))) {
        try {
          if (opponents.length !== 1 || !opponentDrafts[0]) {
            throw Object.assign(
              new Error(
                "A physical-state v3 contract requires exactly one canonical opponent roster.",
              ),
              {
                code:
                  "TESSERA_SCENARIO_POLICY_CONTRACT_V3_SCOPE_MISMATCH",
              },
            );
          }
          const unitScope = {
            playerSelectionIds: playerRoster.units.map(
              (unit) => unit.selectionId,
            ),
            opponentSelectionIds: opponentDrafts[0].units.map(
              (unit) => unit.selectionId,
            ),
          };
          scenarioPolicyContractV3 =
            scenarioPolicyContractV3 ??
            (options.scenarioPolicyContractV3
              ? canonicalTesseraScenarioPolicyContractV3(
                  options.scenarioPolicyContractV3,
                )
              : options.selectedPlayerAbilityIds?.length
                ? selectedAbilitiesTesseraScenarioPolicyContractV3(
                    scenarioPolicyContractV2?.scenarios[0]?.iterations ??
                      LOCAL_TESSERA_ENGINE_ITERATIONS,
                    unitScope,
                    options.selectedPlayerAbilityIds.map((abilityId) => ({
                      ownerSide: "player",
                      abilityId,
                    })),
                    configuration.phases,
                    configuration.metrics,
                  )
                : options.activationMode === "envelope"
                  ? activationEnvelopeTesseraScenarioPolicyContractV3(
                      scenarioPolicyContractV2?.scenarios[0]?.iterations ??
                        LOCAL_TESSERA_ENGINE_ITERATIONS,
                      unitScope,
                      configuration.phases,
                      configuration.metrics,
                    )
              : selectedBaselineTesseraScenarioPolicyContractV3(
                  scenarioPolicyContractV2?.scenarios[0]?.iterations ??
                    LOCAL_TESSERA_ENGINE_ITERATIONS,
                  unitScope,
                  configuration.phases,
                  configuration.metrics,
                ));
          scenarioPolicyContractV3 =
            assertTesseraScenarioPolicyContractV3Scope(
              scenarioPolicyContractV3,
              configuration.phases,
              configuration.metrics,
              unitScope,
            );
          if (selectedAttachmentBindings.length > 0) {
            scenarioPolicyContractV3 =
              withSelectedTesseraAttachmentBindingsV3(
                scenarioPolicyContractV3,
                selectedAttachmentBindings,
              );
          }
          scenarioPolicyContractV3Sha256 =
            tesseraScenarioPolicyContractV3Sha256(
              scenarioPolicyContractV3,
            );
        } catch (error) {
          const violation: RosterIssue = {
            code:
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID",
            message:
              error instanceof Error
                ? error.message
                : "The physical-state v3 scenario contract is invalid.",
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
      }

      let combatBridges: Array<CombatBridgeV2 | CombatBridgeV3> = [];
      const combatBridgeReplayInputSha256s: Array<{
        player: string;
        opponent: string;
      } | null> = [];
      const combatBridgeV3Preparations: Array<
        PreparedCombatBridgeInputV3 | null
      > = [];
      const combatCorpusReviewArtifacts: Array<{
        opponentName: string;
        artifact: CombatBridgeInputV3PreparationArtifact;
      }> = [];
      if (
        simulationRequested &&
        (plannedSimulationBackend === "local-engine" ||
          options.providerParityCase)
      ) {
        const missingContextIndex = opponentDrafts.findIndex(
          (draft) => draft === null,
        );
        if (!scenarioPolicyContractV2 || missingContextIndex >= 0) {
          const violation: RosterIssue = {
            code:
              missingContextIndex >= 0
                ? "TESSERA_LOCAL_OPPONENT_CONTEXT_REQUIRED"
                : "TESSERA_SCENARIO_POLICY_CONTRACT_V2_REQUIRED",
            message:
              missingContextIndex >= 0
                ? `The local rules compiler has no canonical context for ${opponents[missingContextIndex]?.rosterName ?? "the opponent"}; New Recruit enrichment was not attempted.`
                : "The local rules compiler requires a frozen v2 scenario/policy contract.",
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
        try {
          const canonicalOpponents = opponentDrafts as RosterDraftV1[];
          if (!operationLocalDataContext) {
            throw Object.assign(
              new Error(
                "The exact local-engine Dataset was not captured before roster preparation.",
              ),
              { code: "TESSERA_DATA_BUNDLE_SNAPSHOT_MISSING" },
            );
          }
          if (providerParityPreflight) {
            if (
              canonicalOpponents.length !== 1 ||
              rosterExecutionFingerprint(canonicalOpponents[0]) !==
                rosterExecutionFingerprint(
                  providerParityPreflight.opponentRoster,
                )
            ) {
              throw Object.assign(
                new Error(
                  "The prepared opponent changed after exact provider-parity preflight.",
                ),
                { code: "TESSERA_PROVIDER_PARITY_V2_PREFLIGHT_DRIFT" },
              );
            }
            const replayInputSha256s =
              providerParityPreflight.prepared.replayBindings
                .localInputV2Sha256s;
            if (
              !replayInputSha256s?.player ||
              !replayInputSha256s.opponent
            ) {
              throw new Error(
                "The provider-parity preflight omitted exact local-input replay hashes.",
              );
            }
            combatBridges.push(providerParityPreflight.bridge);
            combatBridgeReplayInputSha256s.push({
              player: replayInputSha256s.player,
              opponent: replayInputSha256s.opponent,
            });
            combatBridgeV3Preparations.push(
              providerParityPreflight.prepared,
            );
          } else if (
            operationDataBundleSnapshot &&
            scenarioPolicyContractV3
          ) {
            const playerLocalInput =
              compileRosterForLocalTesseraEngineV2(
                playerRoster,
                profilePolicy,
                operationLocalDataContext,
              );
            const decisionGradeLocalRequired =
              localTesseraEngineIsAutoSelectable(
                personalLocalAttestation,
              );
            for (const [index, opponentRoster] of
              canonicalOpponents.entries()) {
              try {
                const prepared =
                  await prepareCombatBridgeInputV3FromSnapshot({
                    snapshot: operationDataBundleSnapshot,
                    playerRoster,
                    opponentRoster,
                    scenarioPolicy: scenarioPolicyContractV3,
                    localInputs: {
                      player: playerLocalInput,
                      opponent:
                        compileRosterForLocalTesseraEngineV2(
                          opponentRoster,
                          profilePolicy,
                          operationLocalDataContext,
                        ),
                    },
                  });
                const bridge = await compileCombatBridgeV3(
                  prepared.input,
                );
                combatBridges.push(bridge);
                const replayInputSha256s =
                  prepared.replayBindings.localInputV2Sha256s;
                if (
                  !replayInputSha256s?.player ||
                  !replayInputSha256s.opponent
                ) {
                  throw new Error(
                    "The admitted bridge v3 omitted exact local-input replay hashes.",
                  );
                }
                combatBridgeReplayInputSha256s.push({
                  player: replayInputSha256s.player,
                  opponent: replayInputSha256s.opponent,
                });
                combatBridgeV3Preparations.push(prepared);
              } catch (error) {
                if (
                  !(error instanceof CombatBridgeInputV3PreparationError) ||
                  error.code !== "COMBAT_CORPUS_REVIEW_REQUIRED" ||
                  !error.artifact ||
                  options.providerParityCase
                ) {
                  throw error;
                }
                combatCorpusReviewArtifacts.push({
                  opponentName:
                    opponents[index]?.rosterName ??
                    `Opponent ${index + 1}`,
                  artifact: error.artifact,
                });
                warnings.push(
                  `[TESSERA_COMBAT_CORPUS_V3_INCOMPLETE] ${opponents[index]?.rosterName ?? `Opponent ${index + 1}`} requires reviewed combat-corpus mappings (report ${error.artifact.report.reportSha256}). Review artifacts were retained; a legacy bridge-v2 diagnostic may run, but it cannot establish scalar parity or activate the personal local provider.`,
                );
                const legacyInput =
                  await compileCombatBridgeInputV2FromSnapshot({
                    snapshot: operationDataBundleSnapshot,
                    playerRoster,
                    opponentRoster,
                    scenarioPolicy: scenarioPolicyContractV2,
                  });
                combatBridges.push(
                  await compileCombatBridgeV2(legacyInput),
                );
                combatBridgeReplayInputSha256s.push(null);
                combatBridgeV3Preparations.push(null);
                if (decisionGradeLocalRequired) {
                  warnings.push(
                    "[TESSERA_PERSONAL_LOCAL_V3_REQUIRED] The active personal-local path requires an admitted bridge-v3 corpus. Local preflight will fail closed so an explicitly authorized Web fallback can be considered.",
                  );
                }
              }
            }
          } else if (operationDataBundleSnapshot) {
            const compileInputs = await Promise.all(
              canonicalOpponents.map((opponentRoster) =>
                compileCombatBridgeInputV2FromSnapshot({
                  snapshot: operationDataBundleSnapshot!,
                  playerRoster,
                  opponentRoster,
                  scenarioPolicy: scenarioPolicyContractV2!,
                }),
              ),
            );
            combatBridges = await Promise.all(
              compileInputs.map((input) => compileCombatBridgeV2(input)),
            );
            combatBridgeReplayInputSha256s.push(
              ...combatBridges.map(() => null),
            );
            combatBridgeV3Preparations.push(
              ...combatBridges.map(() => null),
            );
          } else {
            const compileInputs = await Promise.all(
              canonicalOpponents.map((opponentRoster) =>
                compileCombatBridgeInputV2FromDataset({
                  dataset: operationLocalDataContext!.dataset,
                  playerRoster,
                  opponentRoster,
                  scenarioPolicy: scenarioPolicyContractV2!,
                }),
              ),
            );
            combatBridges = await Promise.all(
              compileInputs.map((input) => compileCombatBridgeV2(input)),
            );
            combatBridgeReplayInputSha256s.push(
              ...combatBridges.map(() => null),
            );
            combatBridgeV3Preparations.push(
              ...combatBridges.map(() => null),
            );
          }
          for (const [index, bridge] of combatBridges.entries()) {
            if (bridge.coverage.status !== "complete") {
              warnings.push(
                `[TESSERA_COMBAT_COVERAGE_${bridge.coverage.status.toLocaleUpperCase()}] ${opponents[index]?.rosterName ?? `Opponent ${index + 1}`} combat coverage is ${bridge.coverage.status}/${bridge.coverage.claimEligibility}: ${bridge.coverage.omittedEffects} omitted and ${bridge.coverage.approximatedEffects} approximated effect(s).`,
              );
            }
          }
        } catch (error) {
          const violation: RosterIssue = {
            code:
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "TESSERA_COMBAT_BRIDGE_COMPILATION_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "The bundle-native combat bridge could not be compiled.",
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
      }

      if (
        plannedSimulationBackend !== "local-engine" &&
        preparedPlayer.enrichedRoszSha256
      ) {
        preparedPlayer.simulationInput = {
          kind: "new-recruit-enriched-rosz",
          sha256: preparedPlayer.enrichedRoszSha256,
        };
      }
      for (const prepared of opponents) {
        if (
          plannedSimulationBackend !== "local-engine" &&
          prepared.enrichedRoszSha256
        ) {
          prepared.simulationInput = {
            kind: "new-recruit-enriched-rosz",
            sha256: prepared.enrichedRoszSha256,
          };
        }
      }
      const matrices: TesseraMatchupReport["simulation"]["matrices"] = [];
      const scenarios: TesseraScenarioResult[] = [];
      const settings: Record<string, string> = {};
      const failures: NonNullable<TesseraMatchupReport["failures"]> = [];
      const simulationConnectorEvents: ConnectorEvent[] = [];
      const tesseraUiIdentities = new Set<string>();
      let tesseraUiIdentityComplete = true;
      const websiteProviderEvidenceCaptures: Array<{
        opponentName: string;
        evidence: TesseraWebsiteProviderEvidence;
      }> = [];
      let websiteProviderEvidenceComplete = true;
      let selectedSimulationBackend: TesseraSimulationProvider =
        plannedSimulationBackend;
      let simulationProviderIdentity: TesseraSimulationProviderIdentity | null =
        plannedSimulationBackend === "local-engine"
          ? LOCAL_TESSERA_ENGINE_IDENTITY
          : null;
      let simulationFallback: TesseraSimulationFallbackReceipt | null = null;
      let simulationProviderIdentityComplete = true;
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
              plannedSimulationBackend !== "local-engine" &&
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
            const simulationInput: Parameters<
              typeof runTesseraBrowserMatchup
            >[0] = {
              profileDirectory,
              playerRoszPath: preparedPlayer.enrichedRoszPath,
              playerName: preparedPlayer.rosterName,
              opponentRoszPath: prepared.enrichedRoszPath,
              opponentName: prepared.rosterName,
              playerSimulationInput: preparedPlayer.simulationInput,
              opponentSimulationInput: prepared.simulationInput,
              analysisMode: configuration.analysisMode,
              phases: configuration.phases,
              metrics: configuration.metrics,
              profilePolicy,
              frozenScenarioContract: scenarioContract,
              scenarioPolicyContractV2:
                plannedSimulationBackend === "local-engine"
                  ? scenarioPolicyContractV2
                  : null,
              scenarioPolicyContractV3,
              combatBridge:
                plannedSimulationBackend === "local-engine"
                  ? combatBridges[opponentIndex] ?? null
                  : null,
              combatCorpusTranslationLedger:
                plannedSimulationBackend === "local-engine"
                  ? combatBridgeV3Preparations[opponentIndex]
                      ?.translationLedger ?? null
                  : null,
              savedListReuse,
              sessionId: options.sessionId,
            };
            const websiteInputCompatible =
              preparedPlayer.simulationInput?.kind ===
                "new-recruit-enriched-rosz" &&
              prepared.simulationInput?.kind ===
                "new-recruit-enriched-rosz";
            const simulationRequestSha256 = crypto
              .createHash("sha256")
              .update(
                canonicalJson({
                  schemaVersion: 1,
                  action: "tessera-simulation",
                  requestedSimulationBackend,
                  plannedSimulationBackend,
                  bundleId:
                    "bundleId" in playerRoster.sourceData
                      ? playerRoster.sourceData.bundleId
                      : null,
                  playerRosterFingerprint:
                    preparedPlayer.fingerprint ??
                    rosterExecutionFingerprint(playerRoster),
                  opponentRosterFingerprint: prepared.fingerprint ?? null,
                  playerSimulationInputSha256:
                    preparedPlayer.simulationInput?.sha256 ?? null,
                  opponentSimulationInputSha256:
                    prepared.simulationInput?.sha256 ?? null,
                  profilePolicySha256: profilePolicy
                    ? profilePolicyHash(profilePolicy)
                    : null,
                  scenarioContractSha256: scenarioContract
                    ? tesseraScenarioContractSha256(scenarioContract)
                    : null,
                  scenarioPolicyContractV2Sha256,
                  scenarioPolicyContractV3Sha256,
                  combatBridgeSha256:
                    simulationInput.combatBridge?.bridgeSha256 ?? null,
                  combatCorpusTranslationLedgerSha256:
                    simulationInput.combatCorpusTranslationLedger
                      ? crypto.createHash("sha256").update(
                          canonicalJson(
                            simulationInput
                              .combatCorpusTranslationLedger,
                          ),
                        ).digest("hex")
                      : null,
                  personalCoverageSuiteSha256:
                    personalLocalAttestation?.coveringSuite
                      ?.suiteSha256 ?? null,
                  phases: configuration.phases,
                  metrics: configuration.metrics,
                }),
              )
              .digest("hex");
            const directWebsiteProvider = createWebsiteTesseraProvider(
              dependencies.runBrowser ?? runTesseraViaAgent,
            );
            const lazyAuthorizedWebsiteFallbackProvider = {
              backend: directWebsiteProvider.backend,
              getStatus: directWebsiteProvider.getStatus,
              // Authorization is checked by the router before this provider is
              // preflighted or run. Preparation stays lazy so an unconfirmed or
              // successful local attempt causes no New Recruit/browser activity.
              preflight: async () => ({
                ok: true,
                reasonCodes: [],
                warnings: [],
              }),
              run: async () => {
                if (!dependencies.runBrowser) {
                  const readiness = await getTesseraConnectionStatus();
                  if (!readiness.ok || !readiness.data?.available) {
                    throw Object.assign(
                      new Error(
                        readiness.violations[0]?.message ??
                          readiness.warnings[0]?.message ??
                          "The local Tessera agent, browser, or premium credential is not ready for the authorized Website fallback.",
                      ),
                      { code: "TESSERA_READINESS_PROBE_FAILED" },
                    );
                  }
                }
                const opponentRoster = opponentDrafts[opponentIndex];
                if (!opponentRoster) {
                  throw Object.assign(
                    new Error(
                      "The authorized Website fallback has no canonical opponent roster to prepare.",
                    ),
                    { code: "TESSERA_LOCAL_OPPONENT_CONTEXT_REQUIRED" },
                  );
                }
                const fallbackRoot = path.join(
                  outputDirectory,
                  "website-fallback",
                );
                const fallbackPlayerResult = await prepareRosterForTessera(
                  playerRoster,
                  {
                    ...options,
                    simulationBackend: "website",
                    profilePolicy,
                    mutationRunId: `${mutationRunId}-website-fallback-player`,
                    outputDirectory: path.join(fallbackRoot, "player"),
                  },
                  dependencies,
                );
                if (!fallbackPlayerResult.ok || !fallbackPlayerResult.data) {
                  const issue = fallbackPlayerResult.violations[0];
                  throw Object.assign(
                    new Error(
                      issue?.message ??
                        "The authorized Website fallback could not prepare the verified player New Recruit artifact.",
                    ),
                    {
                      code:
                        issue?.code ??
                        "TESSERA_WEBSITE_FALLBACK_PREPARATION_FAILED",
                    },
                  );
                }
                // Keep remote list mutations sequential. If player preparation
                // fails, no opponent import is attempted.
                const fallbackOpponentResult = await prepareRosterForTessera(
                  opponentRoster,
                  {
                    ...options,
                    simulationBackend: "website",
                    profilePolicy,
                    mutationRunId: `${mutationRunId}-website-fallback-opponent-${opponentIndex + 1}`,
                    outputDirectory: path.join(
                      fallbackRoot,
                      `opponent-${opponentIndex + 1}`,
                    ),
                  },
                  dependencies,
                );
                const failedPreparation = !fallbackOpponentResult.ok
                  ? fallbackOpponentResult
                  : null;
                if (
                  failedPreparation ||
                  !fallbackOpponentResult.data
                ) {
                  const issue = failedPreparation?.violations[0];
                  throw Object.assign(
                    new Error(
                      issue?.message ??
                        "The authorized Website fallback could not prepare verified New Recruit artifacts.",
                    ),
                    {
                      code:
                        issue?.code ??
                        "TESSERA_WEBSITE_FALLBACK_PREPARATION_FAILED",
                    },
                  );
                }
                const [fallbackPlayer, fallbackOpponent] = await Promise.all([
                  materializePreparedRosterArtifacts(
                    fallbackPlayerResult.data,
                    path.join(fallbackRoot, "player"),
                    options,
                  ),
                  materializePreparedRosterArtifacts(
                    fallbackOpponentResult.data,
                    path.join(
                      fallbackRoot,
                      `opponent-${opponentIndex + 1}`,
                    ),
                    options,
                  ),
                ]);
                fallbackPlayer.units = canonicalUnits(
                  playerRoster,
                  "player",
                );
                fallbackOpponent.units = canonicalUnits(
                  opponentRoster,
                  "opponent",
                );
                if (
                  !fallbackPlayer.enrichedRoszSha256 ||
                  !fallbackOpponent.enrichedRoszSha256
                ) {
                  throw Object.assign(
                    new Error(
                      "The authorized Website fallback did not retain both enriched ROSZ hashes.",
                    ),
                    { code: "TESSERA_HANDOFF_INCOMPLETE" },
                  );
                }
                fallbackPlayer.simulationInput = {
                  kind: "new-recruit-enriched-rosz",
                  sha256: fallbackPlayer.enrichedRoszSha256,
                };
                fallbackOpponent.simulationInput = {
                  kind: "new-recruit-enriched-rosz",
                  sha256: fallbackOpponent.enrichedRoszSha256,
                };
                const fallbackProfileInspections = await Promise.all([
                  inspectPreparedProfileRequirements(
                    fallbackPlayer,
                    playerRoster.factionId,
                  ),
                  inspectPreparedProfileRequirements(
                    fallbackOpponent,
                    opponentRoster.factionId,
                  ),
                ]);
                const failedInspection = fallbackProfileInspections.find(
                  (inspection) => !inspection.ok || !inspection.data,
                );
                if (failedInspection) {
                  const issue = failedInspection.violations[0];
                  throw Object.assign(
                    new Error(
                      issue?.message ??
                        "The authorized Website fallback artifacts could not be inspected.",
                    ),
                    {
                      code:
                        issue?.code ??
                        "TESSERA_ENRICHED_PROFILE_INSPECTION_FAILED",
                    },
                  );
                }
                const fallbackEnrichedProfileRequirements =
                  mergedProfileRequirements([
                    profileRequirements,
                    ...fallbackProfileInspections.map(
                      (inspection) => inspection.data ?? [],
                    ),
                  ]);
                const fallbackProfileValidation = validateProfilePolicy(
                  fallbackEnrichedProfileRequirements,
                  profilePolicy,
                );
                if (!fallbackProfileValidation.valid) {
                  throw Object.assign(
                    new Error(
                      "The authorized Website fallback exposed weapon-profile choices that are not resolved by the frozen profile policy.",
                    ),
                    { code: "TESSERA_PROFILE_POLICY_CHANGED" },
                  );
                }
                enrichedProfileRequirements =
                  fallbackEnrichedProfileRequirements;
                const fallbackInput: Parameters<
                  typeof runTesseraBrowserMatchup
                >[0] = {
                  ...simulationInput,
                  playerRoszPath: fallbackPlayer.enrichedRoszPath,
                  playerName: fallbackPlayer.rosterName,
                  opponentRoszPath: fallbackOpponent.enrichedRoszPath,
                  opponentName: fallbackOpponent.rosterName,
                  playerSimulationInput: fallbackPlayer.simulationInput,
                  opponentSimulationInput: fallbackOpponent.simulationInput,
                  scenarioPolicyContractV2: null,
                  combatBridge: null,
                  savedListReuse:
                    fallbackPlayer.fingerprint &&
                    fallbackOpponent.fingerprint
                      ? createTesseraSavedListReuse({
                          runId: `${mutationRunId}-website-fallback`,
                          profilePolicy,
                          player: {
                            enrichedRoszSha256:
                              fallbackPlayer.enrichedRoszSha256,
                            rosterExecutionFingerprint:
                              fallbackPlayer.fingerprint,
                            expectedUnitCount:
                              fallbackPlayer.summary.units.length,
                          },
                          opponent: {
                            enrichedRoszSha256:
                              fallbackOpponent.enrichedRoszSha256,
                            rosterExecutionFingerprint:
                              fallbackOpponent.fingerprint,
                            expectedUnitCount:
                              fallbackOpponent.summary.units.length,
                          },
                          playerProfileRequirements:
                            fallbackProfileInspections[0]?.data ?? [],
                          opponentProfileRequirements:
                            fallbackProfileInspections[1]?.data ?? [],
                        })
                      : null,
                };
                preparedPlayer = fallbackPlayer;
                opponents[opponentIndex] = {
                  kind: "roster",
                  rosterName: fallbackOpponent.rosterName,
                  sourceRoszPath: fallbackOpponent.sourceRoszPath,
                  enrichedRoszPath: fallbackOpponent.enrichedRoszPath,
                  sourceRoszSha256: fallbackOpponent.sourceRoszSha256,
                  enrichedRoszSha256:
                    fallbackOpponent.enrichedRoszSha256,
                  simulationInput: fallbackOpponent.simulationInput,
                  summary: fallbackOpponent.summary,
                  fingerprint: fallbackOpponent.fingerprint,
                  units: fallbackOpponent.units,
                  cacheReused: fallbackOpponent.cacheReused,
                  connectorEvents: fallbackOpponent.connectorEvents,
                  catalogueProvenance:
                    fallbackOpponent.catalogueProvenance,
                };
                warnings.push(
                  ...fallbackPlayerResult.warnings.map(
                    (warning) => warning.message,
                  ),
                  ...fallbackOpponentResult.warnings.map(
                    (warning) => warning.message,
                  ),
                );
                return directWebsiteProvider.run(fallbackInput);
              },
            };
            const routed = await routeTesseraSimulation({
              requestedBackend: requestedSimulationBackend,
              requestSha256: simulationRequestSha256,
              websiteFallbackAuthorization:
                options.websiteFallbackAuthorization,
              local: {
                provider: createLocalTesseraEngineProvider(
                  dependencies.runLocalEngine ?? runLocalTesseraEngineMatchup,
                  {
                    personalAttestation: personalLocalAttestation,
                  },
                ),
                input: simulationInput,
              },
              website: websiteInputCompatible
                ? {
                    provider: directWebsiteProvider,
                    input: simulationInput,
                  }
                : requestedSimulationBackend === "auto" &&
                    plannedSimulationBackend === "local-engine"
                  ? {
                      provider: lazyAuthorizedWebsiteFallbackProvider,
                      input: simulationInput,
                    }
                  : undefined,
            });
            const result = routed.data as TesseraBrowserResult;
            if (
              routed.selection.selectedBackend !==
              selectedSimulationBackend
            ) {
              if (
                requestedSimulationBackend === "auto" &&
                routed.fallback !== null &&
                matrices.length === 0
              ) {
                selectedSimulationBackend = routed.selection.selectedBackend;
              } else {
                throw Object.assign(
                  new Error(
                    "The simulation provider changed within one exact run.",
                  ),
                  { code: "TESSERA_SIMULATION_PROVIDER_DRIFT" },
                );
              }
            }
            if (
              routed.selection.selectedBackend === "local-engine" &&
              simulationInput.combatBridge
            ) {
              assertLocalCombatBridgeExecutionEvidence(
                result,
                simulationInput.combatBridge,
              );
            }
            simulationFallback ??= routed.fallback;
            simulationProviderIdentity = routed.identity;
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
            if (selectedSimulationBackend === "website") {
              if (result.uiIdentity) {
                tesseraUiIdentities.add(result.uiIdentity);
              } else {
                tesseraUiIdentityComplete = false;
              }
              if (result.providerEvidence) {
                websiteProviderEvidenceCaptures.push({
                  opponentName: prepared.rosterName,
                  evidence: structuredClone(result.providerEvidence),
                });
                if (
                  !result.providerEvidence.deployment.complete ||
                  !result.providerEvidence.importSemantics.complete
                ) {
                  websiteProviderEvidenceComplete = false;
                  warnings.push(
                    `[TESSERA_PROVIDER_EVIDENCE_INCOMPLETE] Website provenance for ${prepared.rosterName} is incomplete (deployment=${result.providerEvidence.deployment.completeness}, importSemantics=${result.providerEvidence.importSemantics.completeness}, unresolvedEffects=${result.providerEvidence.importSemantics.unresolvedEffectCount}).`,
                  );
                }
              } else {
                websiteProviderEvidenceComplete = false;
                warnings.push(
                  `[TESSERA_PROVIDER_EVIDENCE_INCOMPLETE] Website provenance for ${prepared.rosterName} did not include deployment and imported-army semantic evidence.`,
                );
              }
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
                routed.selection.selectedBackend === "local-engine" &&
                    scenarioPolicyContractV3?.policy.attachments.mode ===
                      "selected"
                  ? scenarioPolicyContractV3.policy.attachments.bindings
                  : [],
              ),
            );
            simulationConnectorEvents.push({
              schemaVersion: 1,
              eventId: crypto.randomUUID(),
              recordedAt: new Date().toISOString(),
              provider: "tessera",
              simulationBackend: selectedSimulationBackend,
              action: "simulate",
              origin:
                selectedSimulationBackend === "local-engine"
                  ? "in-memory"
                  : "new-remote",
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
            simulationProviderIdentityComplete = false;
            if (
              error &&
              typeof error === "object" &&
              "fallbackOffer" in error &&
              error.fallbackOffer &&
              typeof error.fallbackOffer === "object"
            ) {
              simulationFallback ??=
                error.fallbackOffer as TesseraSimulationFallbackReceipt;
            }
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
              simulationBackend: selectedSimulationBackend,
              action: "simulate",
              origin:
                selectedSimulationBackend === "local-engine"
                  ? "in-memory"
                  : "new-remote",
              outcome: "uncertain",
              remoteId: null,
              contentSha256: null,
            });
          } finally {
            await rm(profileDirectory, { recursive: true, force: true });
          }
        }
      }

      const combinedTesseraUiIdentity =
        tesseraUiIdentities.size === 0
          ? null
          : tesseraUiIdentities.size === 1
            ? [...tesseraUiIdentities][0]
            : crypto
                .createHash("sha256")
                .update([...tesseraUiIdentities].sort().join("|"))
                .digest("hex");
      if (selectedSimulationBackend === "website") {
        simulationProviderIdentity = combinedTesseraUiIdentity
          ? {
              schemaVersion: 1,
              provider: "website",
              engine: "tessera-ui",
              uiIdentity: combinedTesseraUiIdentity,
              adapterVersion: TESSERA_WEBSITE_ADAPTER_VERSION,
            }
          : null;
      }
      const providerEvidence = aggregateWebsiteProviderEvidence(
        websiteProviderEvidenceCaptures,
      );
      const allMatched = pointsComparisons.every((comparison) => comparison.matched);
      const expectedScenarioCount =
        opponents.length *
        configuration.phases.length *
        configuration.directions.length;
      const scenariosComplete =
        scenarios.length === expectedScenarioCount &&
        scenarios.every((scenario) => scenario.status === "complete");
      let observedScenarioContract: TesseraFrozenScenarioContract[] | null = null;
      try {
        if (simulationRequested && scenariosComplete) {
          observedScenarioContract = observedTesseraScenarioContract(
            scenarios,
            configuration.phases,
            configuration.metrics,
          );
        }
      } catch (error) {
        warnings.push(
          `[TESSERA_SCENARIO_CONTRACT_MISMATCH] ${error instanceof Error ? error.message : "The observed scenario contract is invalid."}`,
        );
      }
      const scenarioContractMatches =
        scenarioContract === null ||
        (
          observedScenarioContract !== null &&
          tesseraScenarioContractSha256(scenarioContract) ===
            tesseraScenarioContractSha256(observedScenarioContract)
        );
      if (
        scenarioContract !== null &&
        observedScenarioContract !== null &&
        !scenarioContractMatches
      ) {
        warnings.push(
          "[TESSERA_SETTINGS_CHANGED] Tessera did not reproduce the exact frozen scenario settings and iteration counts.",
        );
      }
      const reportScenarioContract =
        scenarioContract ?? observedScenarioContract;
      const reportScenarioContractSha256 = reportScenarioContract
        ? tesseraScenarioContractSha256(reportScenarioContract)
        : null;
      const bundleTrust =
        await captureProviderCompatibilityBundleTrustIdentity(
          "bundleId" in playerRoster.sourceData
            ? playerRoster.sourceData.bundleId
            : null,
        );
      const providerCompatibilityEnvelopes =
        buildMatchupProviderCompatibilityEnvelopes({
          sourceData: playerRoster.sourceData,
          bundleTrust,
          player: preparedPlayer,
          opponents,
          providerIdentity: simulationProviderIdentity,
          websiteEvidenceCaptures: websiteProviderEvidenceCaptures,
          profilePolicyHash: profilePolicy
            ? profilePolicyHash(profilePolicy)
            : null,
          scenarios,
          scenarioContractSha256: reportScenarioContractSha256,
        });
      const simulationEvidenceComplete =
        simulationRequested &&
        matrices.length === opponents.length &&
        captureIntegrityClean &&
        profileResolutionClean &&
        simulationProviderIdentityComplete &&
        simulationProviderIdentity !== null &&
        (selectedSimulationBackend !== "website" ||
          (
            tesseraUiIdentityComplete &&
            (
              configuration.providerCompatibilityMode !== "enforce" ||
              (
                websiteProviderEvidenceComplete &&
                websiteProviderEvidenceCaptures.length === opponents.length
              )
            )
          )) &&
        scenariosComplete &&
        observedScenarioContract !== null &&
        scenarioContractMatches;
      const localCombatClaimsEligible =
        selectedSimulationBackend !== "local-engine" ||
        (
          combatBridges.length === opponents.length &&
          combatBridges.every(
            (bridge) =>
              bridge.coverage.claimEligibility === "decision-grade",
          ) &&
          localCombatScenarioClaimsEligible(scenarios)
        );
      const providerEligibleForCoaching =
        simulationProviderIdentity?.provider === "website" ||
        (localTesseraProviderIdentityAllowsAnalyticalClaims(
          simulationProviderIdentity,
        ) &&
          localCombatClaimsEligible);
      const analyticalClaimsAllowed =
        simulationEvidenceComplete && providerEligibleForCoaching;
      const findings = analyticalClaimsAllowed
        ? structuredFindings(scenarios)
        : [];
      const legacy = legacyFindingText(findings);
      if (simulationRequested && !simulationEvidenceComplete) {
        warnings.push(
          "Substantive matchup findings and roster-change candidates were suppressed because the required capture evidence was incomplete or failed matrix-integrity checks.",
        );
      } else if (simulationEvidenceComplete) {
        if (
          selectedSimulationBackend === "local-engine" &&
          !localCombatClaimsEligible
        ) {
          warnings.push(
            "The local matrices retain bounded best-effort combat envelopes, but substantive findings are suppressed because at least one neutral bridge or provider projection is provisional or unusable.",
          );
        }
        if (!providerEligibleForCoaching) {
          warnings.push(
            "The local-engine matrices are retained as diagnostic evidence, but substantive matchup findings and roster-change candidates require a current machine-local parity attestation and exact bridge-v3 scalar eligibility.",
          );
        }
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
        : simulationEvidenceComplete
          ? "complete"
          : matrices.length > 0
            ? "partial"
            : "failed";
      const playerLocalSimulationInput =
        preparedPlayer.simulationInput?.kind ===
          "rosterpilot-local-engine-input"
          ? preparedPlayer.simulationInput
          : null;
      const combatBridgeEvidence =
        combatBridges.length > 0
          ? combatBridges.flatMap((bridge, index) => {
              const preparedOpponent = opponents[index];
              const opponentInput = preparedOpponent?.simulationInput;
              const replayInputs =
                combatBridgeReplayInputSha256s[index];
              const exactInputSha256s = replayInputs ??
                (playerLocalSimulationInput &&
                    opponentInput?.kind ===
                      "rosterpilot-local-engine-input"
                  ? {
                      player: playerLocalSimulationInput.sha256,
                      opponent: opponentInput.sha256,
                    }
                  : null);
              return preparedOpponent && exactInputSha256s &&
                (bridge.schemaVersion === 3 ||
                  scenarioPolicyContractV2Sha256 !== null)
                ? [
                    compactCombatBridgeEvidence({
                      bridge,
                      opponentName: preparedOpponent.rosterName,
                      scenarioPolicyContractV2Sha256,
                      scenarioPolicyContractV3Sha256,
                      playerInputSha256:
                        exactInputSha256s.player,
                      opponentInputSha256:
                        exactInputSha256s.opponent,
                    }),
                  ]
                : [];
            })
          : [];
      if (
        simulationRequested &&
        !simulationEvidenceComplete &&
        failures.length === 0
      ) {
        const preservedBrowserCode = warnings
          .flatMap((warning) => [
            warning.match(/\[(TESSERA_[A-Z0-9_]+)\]/)?.[1] ?? null,
          ])
          .find(
            (code): code is string =>
              code !== null &&
              code !== "TESSERA_PROFILE_POLICY_APPLIED" &&
              !(
                code === "TESSERA_PROVIDER_EVIDENCE_INCOMPLETE" &&
                configuration.providerCompatibilityMode !== "enforce"
              ),
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
            ? selectedSimulationBackend === "local-engine"
              ? "tessera-local-engine"
              : "tessera-ui"
            : selectedSimulationBackend === "local-engine"
              ? "tessera-local-engine-failed"
              : "tessera-ui-failed",
        status: !simulationRequested
          ? "prepared"
          : simulationEvidenceComplete
            ? "complete"
            : matrices.length > 0
              ? "inconclusive"
              : "failed",
        preparation: {
          status: "complete",
          source:
            selectedSimulationBackend === "local-engine"
              ? "rosterpilot-data-bundle"
              : "new-recruit",
          uniqueRosters: 1 + opponents.length,
          remoteMutations:
            selectedSimulationBackend === "local-engine"
              ? 0
              : remoteMutations,
          cacheReuses:
            selectedSimulationBackend === "local-engine"
              ? 0
              : cacheReuses,
          connectorEvents: preparationConnectorEvents,
        },
        failures,
        profilePolicyHash: profilePolicy
          ? profilePolicyHash(profilePolicy)
          : null,
        scenarioContract: reportScenarioContract,
        scenarioContractSha256: reportScenarioContractSha256,
        scenarioPolicyContractV2:
          selectedSimulationBackend === "local-engine"
            ? scenarioPolicyContractV2 as TesseraScenarioPolicyContractV2Snapshot | null
            : null,
        scenarioPolicyContractV2Sha256:
          selectedSimulationBackend === "local-engine"
            ? scenarioPolicyContractV2Sha256
            : null,
        scenarioPolicyContractV3:
          scenarioPolicyContractV3 as
            | TesseraScenarioPolicyContractV3Snapshot
            | null,
        scenarioPolicyContractV3Sha256,
        frozenProfileRequirements: structuredClone(
          enrichedProfileRequirements,
        ),
        runtime: getRuntimeProvenance(),
        tesseraUiIdentity: combinedTesseraUiIdentity,
        providerCompatibility:
          providerCompatibilityEnvelopes.length === 1
            ? providerCompatibilityEnvelopes[0]
            : undefined,
        providerCompatibilityEnvelopes,
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
          requestedBackend: requestedSimulationBackend,
          selectedBackend: selectedSimulationBackend,
          providerIdentity: simulationProviderIdentity ?? undefined,
          providerEvidence,
          providerEvidenceCaptures:
            websiteProviderEvidenceCaptures.length > 0
              ? websiteProviderEvidenceCaptures
              : undefined,
          fallback: simulationFallback,
          engine:
            selectedSimulationBackend === "local-engine"
              ? "tessera-engine"
              : "tessera-ui",
          settings,
          combatBridgeEvidence:
            combatBridgeEvidence.length > 0
              ? combatBridgeEvidence
              : undefined,
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
      let providerParityEvidenceComplete =
        options.providerParityCase === undefined;
      if (options.providerParityCase) {
        try {
          const exactBridgeEvidence = combatBridgeEvidence.find(
            (candidate) => candidate.schemaVersion === 2,
          );
          const exactBridge = combatBridges.find(
            (candidate): candidate is CombatBridgeV3 =>
              candidate.schemaVersion === 3,
          );
          const exactPreparation = combatBridgeV3Preparations.find(
            (candidate): candidate is PreparedCombatBridgeInputV3 =>
              candidate !== null,
          );
          const opponentRoster = opponentDrafts[0];
          const playerFingerprint =
            preparedPlayer.fingerprint ??
            rosterExecutionFingerprint(playerRoster);
          const opponentFingerprint =
            opponents[0]?.fingerprint ??
            (opponentRoster
              ? rosterExecutionFingerprint(opponentRoster)
              : null);
          if (
            !scenarioPolicyContractV3 ||
            !exactBridgeEvidence ||
            !exactBridge ||
            !exactPreparation ||
            !opponentRoster ||
            !opponentFingerprint
          ) {
            throw new Error(
              "The completed report lacks an admitted bridge v3, canonical opponent, or exact roster fingerprint.",
            );
          }
          report.simulation.providerParityEvidenceV2 =
            buildTesseraProviderParityReportEvidenceV2({
              report,
              scenarioPolicyContractV3,
              bridgeEvidence: exactBridgeEvidence,
              bridge: exactBridge,
              translationLedger:
                exactPreparation.translationLedger,
              coveringSuite:
                options.providerParityCase.coveringSuite,
              coveringCaseId:
                options.providerParityCase.coveringCaseId,
              playerFactionId: playerRoster.factionId,
              opponentFactionId: opponentRoster.factionId,
              playerRosterFingerprint: playerFingerprint,
              opponentRosterFingerprint: opponentFingerprint,
            });
          providerParityEvidenceComplete = true;
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : "The exact provider-parity v2 evidence could not be sealed.";
          failures.push({
            stage: "simulation",
            code: "TESSERA_PROVIDER_PARITY_V2_EVIDENCE_INVALID",
            message,
            opponentName: opponents[0]?.rosterName ?? null,
            retryable: false,
          });
          report.status = matrices.length > 0
            ? "inconclusive"
            : "failed";
          report.simulation.status = matrices.length > 0
            ? "partial"
            : "failed";
          report.warnings.push(
            `[TESSERA_PROVIDER_PARITY_V2_EVIDENCE_INVALID] ${message}`,
          );
        }
      }
      const websiteServiceEvidence =
        selectedSimulationBackend === "website" &&
        providerEvidence &&
        preparedPlayer.enrichedRoszSha256
          ? {
              factionId: playerRoster.factionId,
              enrichedRoszSha256: preparedPlayer.enrichedRoszSha256,
              observedAt: report.generatedAt,
              deploymentAssetSha256:
                providerEvidence.deployment.identitySha256,
              importedSemanticsSha256:
                providerEvidence.importSemantics.playerSha256 ??
                providerEvidence.importSemantics.combinedSha256,
            }
          : null;
      const recordTesseraServiceEvidence =
        dependencies.recordTesseraServiceEvidence ??
        (
          !dependencies.deliver &&
          !dependencies.enrich &&
          !dependencies.runBrowser &&
          !dependencies.runLocalEngine
            ? (input: RecordTesseraServiceEvidenceInput) =>
                createServiceCompatibilityStore({
                  rootDirectory: path.join(
                    rosterPilotSupportDirectory(),
                    "data-bundles",
                  ),
                }).recordTesseraEvidence(input)
            : null
        );
      if (websiteServiceEvidence && recordTesseraServiceEvidence) {
        try {
          const recorded = await recordTesseraServiceEvidence(
            websiteServiceEvidence,
          );
          if (recorded === null) {
            report.warnings.push(
              "The Tessera deployment evidence was captured, but no matching receipt-backed New Recruit observation was available to index it. No list was uploaded again.",
            );
          }
        } catch (error) {
          report.warnings.push(
            `The Tessera report remains valid, but its deployment evidence could not be added to the local service-compatibility index: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
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
        const corpusArtifactDescriptors =
          combatCorpusReviewArtifacts.flatMap(
            ({ opponentName, artifact }, index) => {
              const prefix = [
                "combat-corpus-review",
                String(index + 1),
                safeName(opponentName) || "opponent",
              ].join("-");
              return [
                {
                  format: "combat-corpus-inventory" as const,
                  filename: `${prefix}-inventory.json`,
                  value: artifact.inventory,
                },
                {
                  format: "combat-corpus-overlay" as const,
                  filename: `${prefix}-overlay.json`,
                  value: artifact.overlay,
                },
                {
                  format: "combat-corpus-report" as const,
                  filename: `${prefix}-report.json`,
                  value: artifact.report,
                },
              ];
            },
          );
        const admittedCorpusArtifactDescriptors =
          combatBridgeV3Preparations.flatMap((prepared, index) => {
            const bridge = combatBridges[index];
            if (!prepared || bridge?.schemaVersion !== 3) return [];
            const opponentName =
              opponents[index]?.rosterName ?? `Opponent ${index + 1}`;
            const prefix = [
              "combat-corpus-admitted",
              String(index + 1),
              safeName(opponentName) || "opponent",
            ].join("-");
            return [
              {
                format: "combat-corpus-inventory" as const,
                filename: `${prefix}-inventory.json`,
                value: prepared.inventory,
              },
              {
                format: "combat-corpus-overlay" as const,
                filename: `${prefix}-overlay.json`,
                value: prepared.overlay,
              },
              {
                format: "combat-corpus-report" as const,
                filename: `${prefix}-report.json`,
                value: prepared.report,
              },
              {
                format:
                  "combat-corpus-translation-ledger" as const,
                filename: `${prefix}-translation-ledger.json`,
                value: prepared.translationLedger,
              },
              {
                format: "provider-parity-suite-manifest" as const,
                filename: `${prefix}-parity-suite-manifest.json`,
                value: {
                  schemaVersion: 1,
                  kind: "rosterpilot-tessera-parity-suite-manifest",
                  corpusInventorySha256:
                    prepared.inventory.inventorySha256,
                  combatBridgeV3Sha256: bridge.bridgeSha256,
                  corpusConformanceReportSha256:
                    prepared.report.reportSha256,
                  factions:
                    deriveTesseraParityFactionMechanicsV2({
                      bridge,
                      translationLedger:
                        prepared.translationLedger,
                    }),
                },
              },
            ];
          });
        const retainedCorpusArtifactDescriptors = [
          ...corpusArtifactDescriptors,
          ...admittedCorpusArtifactDescriptors,
        ];
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
          ...retainedCorpusArtifactDescriptors.map((artifact) => ({
            format: artifact.format,
            written: artifact.filename,
          })),
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
            ...(report.player.simulationInput?.kind ===
            "rosterpilot-local-engine-input"
              ? {
                  simulationInput: {
                    ...report.player.simulationInput,
                    path: portablePath(
                      report.player.simulationInput.path,
                    ),
                  },
                }
              : {}),
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
            ...(prepared.simulationInput?.kind ===
            "rosterpilot-local-engine-input"
              ? {
                  simulationInput: {
                    ...prepared.simulationInput,
                    path: portablePath(
                      prepared.simulationInput.path,
                    ),
                  },
                }
              : {}),
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
          ...retainedCorpusArtifactDescriptors.map((artifact) => ({
            format: "roster-json" as const,
            filename: artifact.filename,
            mimeType: "application/json",
            encoding: "utf8" as const,
            content: `${JSON.stringify(artifact.value, null, 2)}\n`,
          })),
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
        if (websiteServiceEvidence && recordTesseraServiceEvidence) {
          await recordTesseraServiceEvidence({
            ...websiteServiceEvidence,
            jobReceiptSha256: crypto
              .createHash("sha256")
              .update(JSON.stringify(receipt))
              .digest("hex"),
          }).catch(() => undefined);
        }
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
      const successful =
        (!simulationRequested || simulationEvidenceComplete) &&
        providerParityEvidenceComplete;
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
  } finally {
    await operationDataBundleLease?.release();
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
    catalogueProvenance?: TesseraPreparedRoster["catalogueProvenance"];
  },
  catalogueDriftMode: "reject" | "diagnostic" | "force" | undefined,
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
    const actualSummary = validateTesseraReadyRosz(enriched).summary;
    if (catalogueDriftMode !== "force" && !summariesGameplayCompatible(actualSummary, prepared.summary)) {
      return "The enriched archive summary differs from the frozen report.";
    }
    const ignoredGameplayMismatches =
      catalogueDriftMode === "force"
        ? new Set(["game-system", "catalogue", "points", "selection-tree"])
        : catalogueDriftMode === "diagnostic" &&
          prepared.catalogueProvenance &&
          isForwardGameSystemRevisionOnlyDrift(
            prepared.catalogueProvenance,
          )
          ? new Set(["game-system"])
          : new Set<string>();
    const gameplayMismatches = compareRoszGameplaySnapshots(
      inspectRoszGameplaySnapshot(source),
      inspectRoszGameplaySnapshot(enriched),
    ).filter(
      (mismatch) => !ignoredGameplayMismatches.has(mismatch),
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
  const baselineProviderIdentity: TesseraSimulationProviderIdentity | null =
    baseline.simulation?.providerIdentity ??
    (baseline.tesseraUiIdentity
      ? {
          schemaVersion: 1,
          provider: "website",
          engine: "tessera-ui",
          uiIdentity: baseline.tesseraUiIdentity,
          adapterVersion: "website-browser-v1",
        }
      : null);
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
    !baselineProviderIdentity
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_BASELINE_INCOMPATIBLE",
          message:
            "Revision comparison requires a complete schema-v3 baseline with frozen source provenance, execution fingerprints, simulation-provider identity, and captured scenarios.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  if (
    baselineProviderIdentity.provider === "local-engine" &&
    !localTesseraProviderIdentityAllowsAnalyticalClaims(
      baselineProviderIdentity,
    )
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "TESSERA_LOCAL_ENGINE_EVALUATION_ONLY",
          message:
            "The pinned local Tessera engine may produce diagnostic and parity evidence, but paired revision conclusions require a current machine-local parity attestation and exact bridge-v3 scalar eligibility.",
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
    !["tessera-ui", "tessera-local-engine"].includes(
      baseline.source,
    ) ||
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
      options.catalogueDriftMode,
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
      options.catalogueDriftMode,
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
        simulationBackend:
          baseline.simulation.selectedBackend ??
          baselineProviderIdentity.provider,
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
      JSON.stringify(
        revised.data.simulation.providerIdentity ??
          (revised.data.tesseraUiIdentity
            ? {
                schemaVersion: 1,
                provider: "website",
                engine: "tessera-ui",
                uiIdentity: revised.data.tesseraUiIdentity,
                adapterVersion: "website-browser-v1",
              }
            : null),
      ) !== JSON.stringify(baselineProviderIdentity) ||
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
              `The rerun against ${opponent.rosterName} changed its frozen opponent identity, profile policy, or simulation-provider identity.`,
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
