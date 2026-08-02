import crypto from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  analyzeMissionReadiness,
  assessMissionReadinessRevisionGuardrail,
  evaluateTesseraStressPortfolioContract,
  exportRoster,
  factionHasLegalNamedAnchor,
  generateFactionStressPortfolio,
  getCachedDataFreshnessResult,
  inspectEnrichedProfileRequirements,
  rosterHasNamedCharacter,
  rosterSimulationFingerprint,
  rosterExecutionFingerprint,
  RosterConstraintsSchema,
  RosterDraftSchema,
  RosterSourceDataSchema,
  validateRoster,
  type LiveDataFreshness,
  type NewRecruitDelivery,
  type ProfilePolicyV1,
  type ResultEnvelope,
  type RosterDraftV1,
  type RosterIssue,
  type TesseraAnalysisConfiguration,
  type TesseraChangeCandidate,
  type TesseraFrozenScenarioContract,
  type TesseraMatchupReport,
  type TesseraMetric,
  type TesseraMissionReadinessReport,
  type TesseraPreparedRoster,
  type TesseraProfileRequirement,
  type TesseraProviderCompatibilityEnvelope,
  type TesseraStressAnalysisStrategy,
  type TesseraStressConfiguration,
  type TesseraStressFrozenOpponentArtifact,
  type TesseraStressFinding,
  type TesseraStressPortfolio,
  type TesseraStressPortfolioPreview,
  type TesseraStressPortfolioItem,
  type TesseraStressRepresentative,
  type TesseraStressPreparationFailureReport,
  type TesseraStressRevisionReport,
  type TesseraStressRobustness,
  type TesseraStressRunReport,
  type TesseraStressRevisionSampleDelta,
  type TesseraStressStageProvenance,
  type TesseraStressSuite,
  type TesseraStressTestReport,
  type TesseraSimulationBackend,
  type TesseraSimulationProvider,
  type TesseraSimulationProviderIdentity,
  type TesseraWebsiteProviderEvidence,
} from "../../lib/rosterpilot";
import {
  pathExists,
  resolveExportArtifactTargets,
  writeExportArtifact,
  writeExportArtifacts,
  type WriteOptions,
} from "../../lib/rosterpilot/io";
import {
  deliverRosterToNewRecruit,
  type NewRecruitDeliveryOptions,
} from "../new-recruit/companion";
import {
  acquireNewRecruitCacheLease,
  loadNewRecruitCache,
  newRecruitCacheKey,
  storeNewRecruitCache,
} from "../new-recruit/cache";
import {
  getRuntimeProvenance,
  runtimeRestartIssue,
} from "../runtime-provenance";
import { closeTesseraLocalAgentSession } from "../agent/client";
import {
  analyzeRosterMatchup,
  clearPreparedRosterDeliveryMemo,
  getTesseraConnectionStatus,
  prepareRosterForTessera,
  type TesseraDependencies,
  type TesseraOpponentInput,
} from "./companion";
import { qualifyRosterChangeCandidate } from "./candidate-quality";
import {
  computeStressRobustness,
  selectStressRepresentatives,
  stressFindings,
} from "./stress-analysis";
import {
  renderTesseraStressRevisionReportHtml,
  renderTesseraStressTestReportHtml,
} from "./stress-report";
import {
  aggregateProfileRequirements,
  normalizeProfileIdentity,
  ProfilePolicySchema,
  profilePolicyHash,
  profilePolicyIdentityKey,
  profilePolicyIdentityMatches,
  profilePolicyScaffold,
  validateProfilePolicy,
} from "./profile-policy";
import {
  verifyLocalTesseraEngineInput,
} from "./local-engine-input";
import {
  localTesseraEngineIsAutoSelectable,
} from "./local-engine";
import {
  assertTesseraScenarioContractProvider,
  assertTesseraScenarioContractScope,
  canonicalTesseraScenarioContract,
  observedTesseraScenarioContract,
  projectTesseraScenarioContract,
  TESSERA_SCENARIO_PHASES,
  tesseraScenarioContractSha256,
} from "./scenario-contract";
import { effectiveProviderCompatibilityMode } from "./provider-compatibility";

const SCREENING_METRICS: TesseraMetric[] = [
  "half-wipe-probability",
];
const DEEP_DIVE_METRICS: TesseraMetric[] = [
  "wipe-probability",
  "mean-kills",
  "mean-damage",
];
const FULL_METRICS: TesseraMetric[] = [
  "wipe-probability",
  "half-wipe-probability",
  "mean-kills",
  "mean-damage",
];

export type TesseraStressOpponentInput = {
  kind: "faction";
  factionId: string;
};

export type TesseraStressOptions = WriteOptions & {
  outputDirectory?: string;
  /** Provider request frozen for the complete stress run. */
  simulationBackend?: TesseraSimulationBackend;
  suite?: TesseraStressSuite;
  analysisStrategy?: TesseraStressAnalysisStrategy;
  executionMode?: "prepare-only" | "simulate";
  resumeManifestPath?: string;
  restartManifestPath?: string;
  profilePolicyPath?: string;
  forceRetry?: boolean;
  experimental?: boolean;
  /** Proceed with visibly provisional results after verified catalogue drift. */
  catalogueDriftMode?: "reject" | "diagnostic";
  /** Freeze whether incomplete website compatibility evidence blocks the run. */
  providerCompatibilityMode?: "observe" | "enforce";
  /**
   * Internal durable-run contract. A durable coordinator owns the three
   * automatic attempts and the two explicit lifetime attempts, so a single
   * worker invocation may advance each incomplete stage only once.
   */
  retryOwner?: "stress-workflow" | "durable-job";
  /** Internal outer durable-job attempt number (1..5). */
  durableAttemptNumber?: number;
  /**
   * Frozen local preview supplied by the build-and-stress workflow. It is
   * revalidated below and prevents preview/execution regeneration drift.
   */
  portfolioPreview?: TesseraStressPortfolioPreview;
  /** Caller-supplied full deterministic contract for the stress workflow. */
  scenarioContract?: TesseraFrozenScenarioContract[];
};

function stressSimulationRequested(
  options: TesseraStressOptions,
): boolean {
  return options.executionMode
    ? options.executionMode === "simulate"
    : options.experimental === true;
}

function requestedSimulationBackend(
  options: TesseraStressOptions,
): TesseraSimulationBackend {
  return options.simulationBackend ?? "auto";
}

function selectedSimulationBackend(
  requested: TesseraSimulationBackend,
): TesseraSimulationProvider {
  if (requested === "local-engine") return "local-engine";
  if (requested === "website") return "website";
  return localTesseraEngineIsAutoSelectable()
    ? "local-engine"
    : "website";
}

function simulationProviderAllowsAnalyticalClaims(
  selected: TesseraSimulationProvider | undefined,
  identity: TesseraSimulationProviderIdentity | undefined,
): boolean {
  if (selected !== "local-engine") return true;
  return Boolean(
    identity?.provider === "local-engine" &&
      identity.promotion === "promoted" &&
      identity.licenseState === "approved",
  );
}

export type TesseraStressDependencies = TesseraDependencies & {
  wait?: (milliseconds: number) => Promise<void>;
};

type ManifestStageStatus =
  | "pending"
  | "complete"
  | "partial"
  | "failed";

type ManifestStageEntry = {
  status: ManifestStageStatus;
  reportPath: string | null;
  reportSha256: string | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  attemptCount: number;
  attemptHistory: Array<{
    attempt: number;
    startedAt: string;
    completedAt: string;
    outcome: "complete" | "partial" | "failed";
    error: {
      code: string;
      message: string;
      retryable: boolean;
    } | null;
  }>;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  nextAction: string | null;
};

type ManifestPreparedOpponent = {
  prepared: TesseraPreparedRoster;
  sha256: string;
};

type ManifestStageContracts = {
  screening: Record<string, TesseraFrozenScenarioContract[]>;
  deepDive: Record<string, TesseraFrozenScenarioContract[]>;
};

type TesseraStressManifest = {
  schemaVersion: 6;
  reportKind: "tessera-stress-manifest";
  runId: string;
  createdAt: string;
  updatedAt: string;
  playerFingerprint: string;
  playerSourceData: RosterDraftV1["sourceData"];
  opponentFactionId: string;
  configuration: TesseraStressConfiguration;
  portfolioSha256: string;
  portfolio: TesseraStressPortfolio;
  outputDirectory: string;
  simulationRequested: boolean;
  simulationBackend: TesseraSimulationBackend;
  selectedSimulationBackend: TesseraSimulationProvider;
  profilePolicy: ProfilePolicyV1 | null;
  profilePolicyHash: string | null;
  enrichedProfileRequirements: TesseraProfileRequirement[] | null;
  requestedScenarioContract: TesseraFrozenScenarioContract[] | null;
  requestedScenarioContractSha256: string | null;
  stageContracts: ManifestStageContracts;
  stageContractsSha256: string;
  warnings: string[];
  cachedLiveUpdateCheck: LiveDataFreshness | null;
  playerPreparationStartedAt: string | null;
  opponentPreparationStartedAt: Record<string, string>;
  preparedPlayer: TesseraPreparedRoster | null;
  preparedPlayerSha256: string | null;
  preparedOpponents: Record<string, ManifestPreparedOpponent>;
  representatives: TesseraStressRepresentative[];
  screening: Record<string, ManifestStageEntry>;
  deepDive: Record<string, ManifestStageEntry>;
  finalArtifacts: {
    json: string;
    html: string;
    jsonSha256: string | null;
    htmlSha256: string | null;
  } | null;
  completedAt: string | null;
};

type StressExecutionInput = {
  playerRoster: RosterDraftV1;
  portfolio: TesseraStressPortfolio;
  configuration: TesseraStressConfiguration;
  outputDirectory: string;
  manifestPath: string;
  manifest: TesseraStressManifest;
  resumed: boolean;
  options: TesseraStressOptions;
  dependencies: TesseraStressDependencies;
  opponentRoszPaths?: Map<string, string>;
  frozenRepresentatives?: TesseraStressRepresentative[];
};

type StageRunResult = {
  reports: Map<string, TesseraMatchupReport>;
  warnings: string[];
};

type PreparationFailureContext = {
  side: "player" | "opponent";
  templateId: string | null;
  rosterName: string | null;
  partialPrepared: TesseraPreparedRoster | null;
};

type PreparedOpponentsResult =
  | {
      ok: true;
      data: true;
      violations: RosterIssue[];
      warnings: RosterIssue[];
    }
  | {
      ok: false;
      data: null;
      violations: RosterIssue[];
      warnings: RosterIssue[];
      failureContext: PreparationFailureContext;
    };

const SourceDataSchema = RosterSourceDataSchema;

type StressSourceData = z.infer<typeof SourceDataSchema>;

const UnitInstanceSchema = z.object({
  instanceId: z.string().min(1),
  selectionId: z.string().nullable(),
  side: z.enum(["player", "opponent"]),
  name: z.string().min(1),
  label: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  modelCount: z.number().int().positive(),
  points: z.number().nonnegative().nullable(),
  tags: z.array(z.string()),
});

const ConnectorEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  recordedAt: z.string().min(1),
  provider: z.enum(["new-recruit", "tessera"]),
  simulationBackend: z
    .enum(["local-engine", "website"])
    .optional(),
  action: z.enum(["prepare", "probe", "simulate"]),
  origin: z.enum([
    "new-remote",
    "persistent-cache",
    "manifest-reuse",
    "in-memory",
  ]),
  outcome: z.enum(["verified", "reused", "failed", "uncertain"]),
  remoteId: z.string().nullable(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});

const SimulationProviderIdentitySchema = z.discriminatedUnion(
  "provider",
  [
    z.object({
      schemaVersion: z.literal(1),
      provider: z.literal("website"),
      engine: z.literal("tessera-ui"),
      uiIdentity: z.string().nullable(),
      adapterVersion: z.string().min(1),
    }),
    z.object({
      schemaVersion: z.literal(1),
      provider: z.literal("local-engine"),
      engine: z.literal("tessera-engine"),
      repository: z.literal("Tessera-cmd/tessera-engine"),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      tree: z.string().regex(/^[0-9a-f]{40}$/),
      sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      adapterVersion: z.string().min(1),
      compilerVersion: z.string().min(1),
      inputSchemaVersion: z.literal(1),
      capabilityManifestSha256:
        z.string().regex(/^[0-9a-f]{64}$/),
      promotion: z.enum(["candidate", "promoted"]),
      licenseState: z.enum(["evaluation-only", "approved"]),
    }),
  ],
);

const SimulationFallbackSchema = z.object({
  from: z.literal("local-engine"),
  to: z.literal("website"),
  code: z.string().min(1),
  message: z.string().min(1),
  discardedLocalEvidence: z.literal(true),
});

const ImportedSemanticValueSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const ImportedSemanticToggleSchema = z.object({
  name: z.string(),
  state: z.boolean().nullable(),
});

const ImportedWeaponSemanticSchema = z.object({
  occurrence: z.number().int().positive(),
  name: z.string(),
  profile: z.string().nullable(),
  count: z.number().int().nonnegative().nullable(),
  visibleCharacteristics: z.array(ImportedSemanticValueSchema),
  effectToggles: z.array(ImportedSemanticToggleSchema),
});

const ImportedUnitSemanticSchema = z.object({
  occurrence: z.number().int().positive(),
  name: z.string(),
  modelCount: z.number().int().positive().nullable(),
  included: z.boolean().nullable(),
  weapons: z.array(ImportedWeaponSemanticSchema),
  visibleCharacteristics: z.array(ImportedSemanticValueSchema),
  effectToggles: z.array(ImportedSemanticToggleSchema),
});

const ImportedArmySemanticSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  side: z.enum(["player", "opponent"]),
  armyName: z.string().nullable(),
  reportedUnitCount: z.number().int().nonnegative().nullable(),
  units: z.array(ImportedUnitSemanticSchema),
  warningCodes: z.array(z.string()),
  alternateProfileResolutions: z.array(z.object({
    unit: z.string().nullable(),
    weaponGroup: z.string().nullable(),
    availableProfiles: z.array(z.string()),
    selectedProfile: z.string().nullable(),
    resolvedByPolicy: z.boolean(),
  })),
  completeness: z.enum(["complete", "partial", "unavailable"]),
  incompleteReasons: z.array(z.string()),
});

const ImportedArmySimulationStateBindingSchema = z.object({
  schemaVersion: z.literal(1),
  side: z.enum(["player", "opponent"]),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  savedListName: z.string().min(1),
  selectedUnitCount: z.number().int().positive(),
  selectorValueSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  selectorLabel: z.string().min(1),
  selectorLabelSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  stateSha256: z.string().regex(/^[0-9a-f]{64}$/i),
});

const WebsiteProviderEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  deployment: z.object({
    identitySha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    declaredVersion: z.string().nullable(),
    assets: z.array(z.object({
      url: z.string(),
      sameOrigin: z.boolean(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      byteLength: z.number().int().nonnegative().nullable().optional(),
    })),
    complete: z.boolean(),
    completeness: z.enum([
      "complete",
      "partial",
      "fallback",
      "unavailable",
    ]),
    declarationSha256:
      z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    incompleteReasons: z.array(z.string()),
  }),
  importSemantics: z.object({
    combinedSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    playerSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    opponentSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    complete: z.boolean(),
    completeness: z.enum(["complete", "partial", "unavailable"]),
    unresolvedEffectCount: z.number().int().nonnegative(),
    playerSnapshot: ImportedArmySemanticSnapshotSchema.nullable(),
    opponentSnapshot: ImportedArmySemanticSnapshotSchema.nullable(),
    stateBindings: z.object({
      player: ImportedArmySimulationStateBindingSchema.nullable(),
      opponent: ImportedArmySimulationStateBindingSchema.nullable(),
    }).optional(),
    incompleteReasons: z.array(z.string()),
  }),
});

const SimulationInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new-recruit-enriched-rosz"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    kind: z.literal("rosterpilot-local-engine-input"),
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bundleId: z.string().min(1),
    compilerVersion: z.string().min(1),
  }),
]);

const ObservedNewRecruitCatalogueSchema = z.object({
  source: z.literal("new-recruit-enriched-rosz"),
  gameSystem: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    revision: z.number().int().nonnegative().nullable(),
  }),
  catalogues: z.array(z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    revision: z.number().int().nonnegative().nullable(),
  })),
});

const CatalogueProvenanceSchema = z.object({
  status: z.enum(["matched", "drift", "unverifiable"]),
  pinned: z.object({
    releaseId: z.string().min(1),
    gameSystem: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      revision: z.number().int().nonnegative(),
    }),
    catalogue: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      revision: z.number().int().nonnegative().nullable(),
    }),
  }),
  observed: ObservedNewRecruitCatalogueSchema.nullable(),
  mismatches: z.array(z.object({
    field: z.enum([
      "game-system-id",
      "game-system-revision",
      "catalogue-id",
      "catalogue-revision",
    ]),
    expected: z.union([z.string(), z.number()]),
    observed: z.union([z.string(), z.number()]).nullable(),
  })),
  missing: z.array(z.enum([
    "new-recruit-enriched-identity",
    "game-system-id",
    "game-system-revision",
    "catalogue-id",
    "catalogue-revision",
  ])),
});

const PreparedRosterSchema = z.object({
  rosterId: z.string().min(1),
  rosterName: z.string().min(1),
  factionId: z.string().min(1).optional(),
  listUrl: z.string().nullable(),
  sourceRoszPath: z.string().min(1),
  enrichedRoszPath: z.string().min(1),
  sourceRoszSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  enrichedRoszSha256:
    z.string().regex(/^[0-9a-f]{64}$/).optional(),
  simulationInput: SimulationInputSchema.optional(),
  summary: z.object({
    rosterName: z.string().min(1),
    factionName: z.string().min(1),
    totalPoints: z.number().nonnegative(),
    generatedBy: z.string(),
    observedNewRecruitCatalogue:
      ObservedNewRecruitCatalogueSchema.optional(),
    profileCount: z.number().int().nonnegative(),
    weaponProfileCount: z.number().int().nonnegative(),
    units: z.array(z.object({
      selectionId: z.string().optional(),
      name: z.string().min(1),
      modelCount: z.number().int().positive(),
      ordinal: z.number().int().positive().optional(),
      points: z.number().nonnegative().optional(),
    })),
  }),
  fingerprint: z.string().optional(),
  units: z.array(UnitInstanceSchema).optional(),
  cacheReused: z.boolean().optional(),
  connectorEvents: z.array(ConnectorEventSchema).optional(),
  catalogueProvenance: CatalogueProvenanceSchema.optional(),
  constraints: RosterConstraintsSchema.optional(),
});

const StressConfigurationSchema = z.object({
  suite: z.enum(["core-3", "diverse-9"]),
  analysisStrategy: z.enum(["staged", "full-all"]),
  catalogueDriftMode: z
    .enum(["reject", "diagnostic"])
    .default("reject"),
  providerCompatibilityMode: z
    .enum(["observe", "enforce"])
    .default("observe"),
  pointsTolerancePercent: z.number().nonnegative(),
  proxyWeights: z.literal("equal"),
  screeningMetric: z.literal("half-wipe-probability"),
  screeningPhases: z.array(z.enum(["shooting", "fight"])).min(1),
  screeningDirections: z.array(
    z.enum(["player-to-opponent", "opponent-to-player"]),
  ).min(1),
  revisionMateriality: z.literal(0.01),
  profilePolicyHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
});

const PortfolioItemSchema = z.object({
  templateId: z.string().min(1),
  posture: z.enum([
    "balanced-control",
    "ranged-pressure",
    "assault-pressure",
  ]),
  composition: z.enum(["mixed", "mass", "elite-heavy"]),
  status: z.enum(["ready", "unavailable"]),
  roster: RosterDraftSchema.nullable(),
  fingerprint: z.string().nullable(),
  omissionReason: z.string().nullable(),
}).passthrough();

const PortfolioPostureSchema = z.enum([
  "balanced-control",
  "ranged-pressure",
  "assault-pressure",
]);
const PortfolioCompositionSchema = z.enum([
  "mixed",
  "mass",
  "elite-heavy",
]);
const PortfolioCellSchema = z.object({
  templateId: z.string().min(1),
  posture: PortfolioPostureSchema,
  composition: PortfolioCompositionSchema,
});
const PortfolioRangeSchema = z.tuple([
  z.number(),
  z.number(),
]);
const PortfolioLensDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  metricVersion: z.literal("roster-threat-properties-v1"),
  reviewStatus: z.enum([
    "generated-pending-review",
    "reviewed",
  ]),
  metrics: z.array(z.enum([
    "model-density",
    "points-per-model",
    "infantry-share",
    "vehicle-monster-share",
    "ranged-pressure",
    "melee-pressure",
    "mobility",
    "unit-concentration",
  ])),
  postures: z.array(z.object({
    posture: PortfolioPostureSchema,
    candidateCount: z.number().int().nonnegative(),
    ranges: z.object({
      modelCount: PortfolioRangeSchema,
      pointsPerModel: PortfolioRangeSchema,
      infantryPointsPercent: PortfolioRangeSchema,
      vehicleMonsterPointsPercent: PortfolioRangeSchema,
      rangedPressurePercent: PortfolioRangeSchema,
      meleePressurePercent: PortfolioRangeSchema,
      mobilityPressurePercent: PortfolioRangeSchema,
      unitConcentrationPercent: PortfolioRangeSchema,
    }),
  })).length(3),
});

const PortfolioSchema = z.object({
  schemaVersion: z.literal(1),
  generatorVersion: z.string().min(1),
  contract: z.object({
    schemaVersion: z.literal(1),
    methodology: z.literal("adaptive-threat-lenses-v1"),
    portfolioHash:
      z.string().regex(/^[0-9a-f]{64}$/).optional(),
    sourceReleaseId: z.string().min(1),
    reviewedNotApplicableTemplateIds:
      z.array(z.string().min(1)),
    lensDefinition:
      PortfolioLensDefinitionSchema.optional(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }).optional(),
  suite: z.enum(["core-3", "diverse-9"]),
  factionId: z.string().min(1),
  factionName: z.string().min(1),
  pointsLimit: z.number().int().positive(),
  pointsTolerancePercent: z.number().nonnegative(),
  sourceData: SourceDataSchema,
  items: z.array(PortfolioItemSchema).min(1),
  coverage: z.object({
    intended: z.number().int().positive(),
    ready: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    representedPostures: z.array(PortfolioPostureSchema),
    missingPostures: z.array(PortfolioPostureSchema).optional(),
    representedCompositions: z.array(PortfolioCompositionSchema),
    missingCompositions:
      z.array(PortfolioCompositionSchema).optional(),
    representedCells: z.array(PortfolioCellSchema).optional(),
    missingCells: z.array(
      PortfolioCellSchema.extend({
        reason: z.string().min(1),
      }),
    ).optional(),
    uniqueSimulationPayloads: z.number().int().nonnegative().default(0),
    namedCharacterCoverage: z.boolean().default(false),
    namedCharacterCoverageStatus: z.enum([
      "included",
      "buildable-not-simulated",
      "not-applicable",
      "unavailable-after-evaluation",
    ]).optional(),
    namedCharacterCoverageReason: z.string().nullable().optional(),
    namedCharacterSpecialistStructuralFingerprint:
      z.string().min(1).nullable().default(null),
    namedCharacterSpecialistSimulationFingerprint:
      z.string().min(1).nullable().default(null),
    maximumResultStatus:
      z.enum(["complete", "degraded"]).optional(),
  }),
});

const RepresentativeSchema = z.object({
  kind: z.enum(["stress", "central", "contrast"]),
  templateId: z.string().min(1),
  rationale: z.string(),
});

const ManifestStageEntryV1Schema = z.object({
  status: z.enum(["pending", "complete", "partial", "failed"]),
  reportPath: z.string().nullable(),
  reportSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  error: z.string().nullable(),
});

const ManifestStageEntrySchema = z.object({
  status: z.enum(["pending", "complete", "partial", "failed"]),
  reportPath: z.string().nullable(),
  reportSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }).nullable(),
  attemptCount: z.number().int().nonnegative(),
  attemptHistory: z.array(z.object({
    attempt: z.number().int().positive(),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1),
    outcome: z.enum(["complete", "partial", "failed"]),
    error: z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    }).nullable(),
  })).default([]),
  firstAttemptAt: z.string().min(1).nullable(),
  lastAttemptAt: z.string().min(1).nullable(),
  nextAction: z.string().min(1).nullable(),
});

const ProfileRequirementSchema = z.object({
  faction: z.string().min(1),
  unit: z.string().min(1),
  selectionId: z.string().min(1).nullable(),
  unitOccurrence: z.number().int().positive().optional(),
  modelCount: z.number().int().positive().optional(),
  weaponGroup: z.string().min(1),
  phase: z.enum(["shooting", "fight"]),
  availableProfiles: z.array(z.string().min(1)).min(2),
  activeCount: z.number().int().positive(),
  selectedProfile: z.string().min(1).nullable(),
});

const FrozenScenarioContractSchema = z.object({
  phase: z.enum(["shooting", "fight"]),
  direction: z.enum([
    "player-to-opponent",
    "opponent-to-player",
  ]),
  metric: z.enum([
    "wipe-probability",
    "half-wipe-probability",
    "mean-kills",
    "mean-damage",
  ]),
  settings: z.record(z.string()),
  iterations: z.number().int().positive().nullable(),
});

const LegacyStageContractsSchema = z.object({
  screening: z.array(FrozenScenarioContractSchema).nullable(),
  deepDive: z.array(FrozenScenarioContractSchema).nullable(),
});

const PerTemplateStageContractsSchema = z.object({
  screening: z.record(z.array(FrozenScenarioContractSchema)),
  deepDive: z.record(z.array(FrozenScenarioContractSchema)),
});

const StressManifestSchema = z.object({
  schemaVersion: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
  ]),
  reportKind: z.literal("tessera-stress-manifest"),
  runId: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  playerFingerprint: z.string().min(1),
  playerSourceData: SourceDataSchema,
  opponentFactionId: z.string().min(1),
  configuration: StressConfigurationSchema,
  portfolioSha256:
    z.string().regex(/^[0-9a-f]{64}$/).optional(),
  portfolio: PortfolioSchema,
  outputDirectory: z.string().min(1),
  simulationRequested: z.boolean(),
  simulationBackend: z
    .enum(["auto", "local-engine", "website"])
    .optional(),
  selectedSimulationBackend: z
    .enum(["local-engine", "website"])
    .optional(),
  profilePolicy: ProfilePolicySchema.nullable().optional(),
  profilePolicyHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  enrichedProfileRequirements:
    z.array(ProfileRequirementSchema).nullable().optional(),
  requestedScenarioContract:
    z.array(FrozenScenarioContractSchema).nullable().optional(),
  requestedScenarioContractSha256:
    z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  stageContracts: z.union([
    LegacyStageContractsSchema,
    PerTemplateStageContractsSchema,
  ]).optional(),
  stageContractsSha256:
    z.string().regex(/^[0-9a-f]{64}$/).optional(),
  warnings: z.array(z.string()),
  cachedLiveUpdateCheck: z.unknown().nullable().optional(),
  playerPreparationStartedAt: z.string().min(1).nullable(),
  opponentPreparationStartedAt: z.record(z.string().min(1)),
  preparedPlayer: PreparedRosterSchema.nullable(),
  preparedPlayerSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  preparedOpponents: z.record(z.object({
    prepared: PreparedRosterSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })),
  representatives: z.array(RepresentativeSchema),
  screening: z.record(z.union([
    ManifestStageEntrySchema,
    ManifestStageEntryV1Schema,
  ])),
  deepDive: z.record(z.union([
    ManifestStageEntrySchema,
    ManifestStageEntryV1Schema,
  ])),
  finalArtifacts: z.object({
    json: z.string().min(1),
    html: z.string().min(1),
    jsonSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    htmlSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  }).nullable(),
  completedAt: z.string().nullable(),
});

export const TesseraStressPreparationFailureReportSchema = z
  .object({
    schemaVersion: z.literal(3),
    reportKind: z.literal(
      "tessera-stress-preparation-failure",
    ),
    runId: z.string().min(1),
    generatedAt: z.string().min(1),
    source: z.literal("prepare-only"),
    status: z.literal("failed"),
    statusExplanation: z.string().min(1),
    runtime: z.object({
      rosterPilotVersion: z.string().min(1),
      rulesPackageVersion: z.string().min(1),
      stressGeneratorVersion: z.string().min(1),
      processStartedAt: z.string().min(1),
      gitHead: z.string().nullable(),
      sourceFingerprintAtStart: z.string().min(1),
      sourceFingerprintNow: z.string().min(1),
      buildId: z.string().min(1),
      stale: z.boolean(),
    }),
    tesseraUiIdentity: z.null(),
    connectorEvents: z.array(ConnectorEventSchema),
    preparation: z.object({
      status: z.enum(["partial", "failed"]),
      source: z.enum([
        "new-recruit",
        "rosterpilot-data-bundle",
      ]),
      failedSide: z.enum(["player", "opponent"]),
      failedTemplateId: z.string().min(1).nullable(),
      uniqueRosters: z.number().int().nonnegative(),
      remoteMutations: z.number().int().nonnegative(),
      cacheReuses: z.number().int().nonnegative(),
      connectorEvents: z.array(ConnectorEventSchema),
    }),
    simulation: z.object({
      requested: z.boolean(),
      status: z.enum(["not-requested", "failed"]),
      engine: z.literal("none"),
      trustedMatrices: z.literal(0),
    }),
    failures: z
      .array(
        z.object({
          stage: z.literal("preparation"),
          code: z.string().min(1),
          message: z.string().min(1),
          opponentName: z.string().min(1).nullable(),
          retryable: z.boolean(),
        }),
      )
      .min(1),
    profilePolicyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    pinnedData: z.object({
      player: SourceDataSchema,
      opponents: z.array(SourceDataSchema),
      cachedLiveUpdateCheck: z.unknown().nullable(),
    }),
    integrity: z.object({
      status: z.literal("not-evaluated"),
      issues: z.tuple([]),
    }),
    recovery: z.object({
      manifest: z.string().min(1),
      screeningAttempts: z.number().int().nonnegative(),
      deepDiveAttempts: z.number().int().nonnegative(),
      exhaustedTemplates: z.array(z.string()),
      nextActions: z.array(z.string()),
      verifiedPreparedPlayer: z.boolean(),
      verifiedPreparedOpponents: z.number().int().nonnegative(),
    }),
    verifiedPreparedPlayer: PreparedRosterSchema.nullable(),
    verifiedPreparedOpponents: z.array(
      z.object({
        templateId: z.string().min(1),
        prepared: PreparedRosterSchema,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    ),
    currentPartialPreparedReceipt: z
      .object({
        side: z.enum(["player", "opponent"]),
        templateId: z.string().min(1).nullable(),
        prepared: PreparedRosterSchema,
        reusable: z.literal(false),
        failureCodes: z.array(z.string().min(1)).min(1),
      })
      .nullable(),
    opponentFactionId: z.string().min(1),
    configuration: StressConfigurationSchema,
    suite: z.enum(["core-3", "diverse-9"]),
    portfolioSha256: z.string().regex(/^[0-9a-f]{64}$/),
    portfolio: PortfolioSchema,
    stageProvenance: z.object({
      screening: z.null(),
      deepDive: z.null(),
    }),
    limitations: z.array(z.string()),
    warnings: z.array(z.string()),
    artifacts: z.array(
      z.object({
        format: z.enum([
          "stress-manifest",
          "player-source-rosz",
          "player-enriched-rosz",
          "opponent-source-rosz",
          "opponent-enriched-rosz",
          "player-source-json",
          "player-local-engine-input",
          "opponent-source-json",
          "opponent-local-engine-input",
        ]),
        written: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
        verification: z.enum(["verified", "unverified"]),
        reusable: z.boolean(),
        templateId: z.string().min(1).nullable(),
      }),
    ),
  })
  .strict();

const ScenarioResultSchema = z.object({
  scenarioId: z.string().min(1),
  opponentName: z.string().min(1),
  phase: z.enum(["shooting", "fight"]),
  direction: z.enum([
    "player-to-opponent",
    "opponent-to-player",
  ]),
  metrics: z.array(z.enum([
    "wipe-probability",
    "half-wipe-probability",
    "mean-kills",
    "mean-damage",
  ])).min(1),
  metricRuns: z.array(z.object({
    metric: z.enum([
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ]),
    iterations: z.number().int().positive().nullable(),
    settings: z.record(z.string()),
    seed: z.number().int().nonnegative().optional(),
    executionSha256:
      z.string().regex(/^[0-9a-f]{64}$/).optional(),
    projectionSha256:
      z.string().regex(/^[0-9a-f]{64}$/).optional(),
    matrixSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    integrity: z.object({
      status: z.enum(["trusted", "aliased"]),
      issueCodes: z.array(z.string()),
      aliasedScenarioIds: z.array(z.string()),
    }).optional(),
  })).min(1),
  iterations: z.number().int().positive().nullable(),
  settings: z.record(z.string()),
  cells: z.array(z.object({
    attacker: UnitInstanceSchema,
    target: UnitInstanceSchema,
    values: z.object({
      wipeProbability: z.number().nullable(),
      halfWipeProbability: z.number().nullable(),
      meanKills: z.number().nullable(),
      meanDamage: z.number().nullable(),
      damagePer100Points: z.number().nullable(),
    }),
    uncertainty: z.record(
      z.enum([
        "wipe-probability",
        "half-wipe-probability",
        "mean-kills",
        "mean-damage",
      ]),
      z.object({
        sampleCount: z.number().int().positive().nullable(),
        standardDeviation: z.number().nonnegative().nullable(),
        standardError: z.number().nonnegative().nullable(),
        completeness: z.enum([
          "complete",
          "partial",
          "unavailable",
        ]),
      }),
    ).optional(),
    confidence: z.enum(["high", "review", "ambiguous"]),
    warningRefs: z.array(z.string()),
  })),
  status: z.enum(["complete", "partial"]),
  warnings: z.array(z.string()),
});

const MatchupReportSchema = z.object({
  schemaVersion: z.union([
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  source: z.enum([
    "prepare-only",
    "tessera-ui",
    "tessera-ui-failed",
    "tessera-local-engine",
    "tessera-local-engine-failed",
    "handoff-only",
  ]),
  status: z.enum([
    "prepared",
    "complete",
    "degraded",
    "inconclusive",
    "failed",
    "partial",
  ]),
  configuration: z.object({
    analysisMode: z.enum(["quick", "full"]),
    phases: z.array(z.enum(["shooting", "fight"])),
    metrics: z.array(z.enum([
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ])),
    directions: z.array(
      z.enum(["player-to-opponent", "opponent-to-player"]),
    ),
    pointsTolerancePercent: z.number(),
    allowPointMismatch: z.boolean(),
    includeChangeCandidates: z.boolean(),
    providerCompatibilityMode: z
      .enum(["observe", "enforce"])
      .default("observe"),
  }),
  player: PreparedRosterSchema,
  opponents: z.array(z.object({
    kind: z
      .enum(["roster", "rosz", "faction-archetype"])
      .optional(),
    rosterName: z.string().min(1),
    sourceRoszPath: z.string().min(1).optional(),
    enrichedRoszPath: z.string().min(1),
    enrichedRoszSha256:
      z.string().regex(/^[0-9a-f]{64}$/).optional(),
    simulationInput: SimulationInputSchema.optional(),
    summary: PreparedRosterSchema.shape.summary,
  }).passthrough()).min(1),
  simulation: z.object({
    requested: z.boolean(),
    executionMode: z
      .enum(["prepare-only", "simulate"])
      .optional(),
    experimental: z.boolean(),
    status: z
      .enum(["not-requested", "complete", "partial", "failed"])
      .optional(),
    requestedBackend: z
      .enum(["auto", "local-engine", "website"])
      .optional(),
    selectedBackend: z
      .enum(["local-engine", "website"])
      .optional(),
    providerIdentity: SimulationProviderIdentitySchema.optional(),
    providerEvidence: WebsiteProviderEvidenceSchema.optional(),
    providerEvidenceCaptures: z.array(z.object({
      opponentName: z.string().min(1),
      evidence: WebsiteProviderEvidenceSchema,
    })).optional(),
    fallback: SimulationFallbackSchema.nullable().optional(),
    engine: z.enum(["tessera-ui", "tessera-engine"]).optional(),
    settings: z.record(z.string()),
    matrices: z.array(z.object({
      opponentName: z.string().min(1),
      cells: z.array(z.unknown()),
    })),
    scenarios: z.array(ScenarioResultSchema).optional(),
  }),
}).passthrough();

const StageProvenanceSchema = z.object({
  analysisMode: z.enum(["quick", "full"]),
  phases: z.array(z.enum(["shooting", "fight"])),
  metrics: z.array(z.enum([
    "wipe-probability",
    "half-wipe-probability",
    "mean-kills",
    "mean-damage",
  ])),
  directions: z.array(
    z.enum(["player-to-opponent", "opponent-to-player"]),
  ),
  settings: z.record(z.string()),
  iterations: z.array(z.number().int().positive()),
  profilePolicyHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  proxyRuns: z.array(z.object({
    templateId: z.string().min(1),
    settings: z.record(z.string()),
    iterations: z.array(z.number().int().positive()),
    scenarios: z.array(z.object({
      phase: z.enum(["shooting", "fight"]),
      metric: z.enum([
        "wipe-probability",
        "half-wipe-probability",
        "mean-kills",
        "mean-damage",
      ]),
      direction: z.enum([
        "player-to-opponent",
        "opponent-to-player",
      ]),
      settings: z.record(z.string()),
      iterations: z.number().int().positive().nullable(),
      matrixSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    })),
  })),
});

const StressSampleSchema = z.object({
  templateId: z.string().min(1),
  posture: z.enum([
    "balanced-control",
    "ranged-pressure",
    "assault-pressure",
  ]),
  composition: z.enum(["mixed", "mass", "elite-heavy"]),
  weight: z.number().nonnegative(),
  status: z.enum(["confident", "ambiguous", "missing"]),
  coverageCompleteness: z.enum([
    "complete",
    "partial",
    "missing",
  ]).optional(),
  evidenceConfidence: z.enum([
    "high",
    "review",
    "ambiguous",
  ]).optional(),
  offensiveCoverage: z.number().min(0).max(1).nullable(),
  threatExposure: z.number().min(0).max(1).nullable(),
  coverageMargin: z.number().min(-1).max(1).nullable(),
  shootingCoverage: z.number().min(0).max(1).nullable(),
  fightCoverage: z.number().min(0).max(1).nullable(),
  shootingExposure: z.number().min(0).max(1).nullable(),
  fightExposure: z.number().min(0).max(1).nullable(),
  playerPointCoverage: z.number().min(0).max(1),
  opponentPointCoverage: z.number().min(0).max(1),
  provisional: z.object({
    offensiveCoverage: z.number().min(0).max(1).nullable(),
    threatExposure: z.number().min(0).max(1).nullable(),
    coverageMargin: z.number().min(-1).max(1).nullable(),
    shootingCoverage: z.number().min(0).max(1).nullable(),
    fightCoverage: z.number().min(0).max(1).nullable(),
    shootingExposure: z.number().min(0).max(1).nullable(),
    fightExposure: z.number().min(0).max(1).nullable(),
    playerPointCoverage: z.number().min(0).max(1),
    opponentPointCoverage: z.number().min(0).max(1),
  }).nullable().default(null),
  warningRefs: z.array(z.string()),
});

const StressAggregateSchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  usableWeight: z.number().nonnegative(),
  evidenceConfidence: z.enum([
    "high",
    "review",
    "ambiguous",
  ]).optional(),
  worst: z.number().nullable(),
  lowerTail: z.number().nullable(),
  median: z.number().nullable(),
  mean: z.number().nullable(),
  best: z.number().nullable(),
});

const MissionBandSchema = z.enum([
  "red",
  "amber",
  "green",
  "unknown",
]);
const MissionDimensionIdSchema = z.enum([
  "scoring-breadth",
  "control-depth",
  "reach",
  "action-economy",
  "durable-contesting",
  "home-continuity",
]);
const MissionDemandSchema = z.enum([
  "control",
  "projection",
  "action",
  "hold",
  "attrition",
]);
const ConfidenceSchema = z.enum(["high", "review", "ambiguous"]);

const MissionReadinessSchema = z.object({
  schemaVersion: z.literal(1),
  scoreDefinitionVersion: z.literal("mission-readiness-v1"),
  rosterFingerprint: z.string().min(1),
  overallBand: MissionBandSchema,
  dimensions: z.array(z.object({
    id: MissionDimensionIdSchema,
    label: z.string().min(1),
    band: MissionBandSchema,
    confidence: ConfidenceSchema,
    metrics: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      value: z.number(),
      normalizedValue: z.number(),
      unit: z.enum([
        "units",
        "models",
        "points",
        "objective-control",
      ]),
      redBelow: z.number().optional(),
      greenAtOrAbove: z.number().optional(),
      selectionIds: z.array(z.string()),
      sourcePaths: z.array(z.string()),
    })),
    providerSelectionIds: z.array(z.string()),
    evidence: z.array(z.string()),
  })),
  primaryMissions: z.array(z.object({
    matchupId: z.string().min(1),
    missionId: z.string().min(1),
    missionName: z.string().min(1),
    opponentDispositionId: z.string().min(1),
    demands: z.array(MissionDemandSchema),
    dimensionIds: z.array(MissionDimensionIdSchema),
    band: MissionBandSchema,
    confidence: ConfidenceSchema,
    sourcePaths: z.array(z.string()),
  })),
  secondaryCards: z.array(z.object({
    cardId: z.string().min(1),
    cardName: z.string().min(1),
    demands: z.array(MissionDemandSchema),
    confidence: ConfidenceSchema,
    sourcePaths: z.array(z.string()),
  })),
  sourceData: SourceDataSchema,
  warnings: z.array(z.string()),
});

const StressBaselineSchema = z.object({
  schemaVersion: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  reportKind: z.literal("tessera-stress-test"),
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  source: z.enum([
    "prepare-only",
    "tessera-ui",
    "tessera-ui-failed",
    "tessera-local-engine",
    "tessera-local-engine-failed",
    "handoff-only",
  ]),
  status: z.enum([
    "prepared",
    "complete",
    "degraded",
    "inconclusive",
    "failed",
    "partial",
  ]),
  statusExplanation: z.string().default(""),
  simulation: z.object({
    requested: z.boolean(),
    status: z.enum([
      "not-requested",
      "complete",
      "partial",
      "failed",
    ]),
    requestedBackend: z
      .enum(["auto", "local-engine", "website"])
      .optional(),
    selectedBackend: z
      .enum(["local-engine", "website"])
      .optional(),
    providerIdentity: SimulationProviderIdentitySchema.optional(),
    fallback: SimulationFallbackSchema.nullable().optional(),
    engine: z.enum(["none", "tessera-ui", "tessera-engine"]),
    trustedMatrices: z.number().int().nonnegative(),
  }).optional(),
  integrity: z.object({
    status: z.enum(["verified", "inconclusive", "not-evaluated"]),
    issues: z.array(z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      templateIds: z.array(z.string()),
    })),
  }).default({
    status: "not-evaluated",
    issues: [],
  }),
  recovery: z.object({
    manifest: z.string(),
    screeningAttempts: z.number().int().nonnegative(),
    deepDiveAttempts: z.number().int().nonnegative(),
    exhaustedTemplates: z.array(z.string()),
    nextActions: z.array(z.string()),
    verifiedPreparedPlayer: z.boolean(),
    verifiedPreparedOpponents: z.number().int().nonnegative(),
  }).default({
    manifest: "",
    screeningAttempts: 0,
    deepDiveAttempts: 0,
    exhaustedTemplates: [],
    nextActions: [],
    verifiedPreparedPlayer: false,
    verifiedPreparedOpponents: 0,
  }),
  player: PreparedRosterSchema,
  opponentFactionId: z.string().min(1),
  configuration: StressConfigurationSchema,
  suite: z.enum(["core-3", "diverse-9"]),
  portfolioSha256:
    z.string().regex(/^[0-9a-f]{64}$/).optional(),
  portfolio: PortfolioSchema,
  frozenOpponentArtifacts: z.array(z.object({
    templateId: z.string().min(1),
    rosterFingerprint: z.string().min(1),
    enrichedRoszPath: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })),
  stageProvenance: z.object({
    screening: StageProvenanceSchema,
    deepDive: StageProvenanceSchema.nullable(),
  }),
  screeningReport: MatchupReportSchema,
  deepDiveReport: MatchupReportSchema.nullable(),
  representatives: z.array(RepresentativeSchema),
  robustness: z.object({
    scoreDefinitionVersion: z.union([
      z.literal("stress-robustness-v1"),
      z.literal("stress-robustness-v2"),
    ]),
    halfWipeThreshold: z.literal(0.5),
    samples: z.array(StressSampleSchema),
    offense: StressAggregateSchema,
    exposure: StressAggregateSchema,
    margin: StressAggregateSchema,
    phaseDependence: z.object({
      shootingCoverageMean: z.number().nullable(),
      fightCoverageMean: z.number().nullable(),
      shootingExposureMean: z.number().nullable(),
      fightExposureMean: z.number().nullable(),
    }),
    units: z.array(z.object({
      instanceId: z.string().min(1),
      label: z.string().min(1),
      points: z.number().nonnegative().nullable(),
      answerBreadth: z.number().min(0).max(1),
      exposedWeight: z.number().min(0).max(1),
      supportingTemplateIds: z.array(z.string()),
      exposedTemplateIds: z.array(z.string()).optional().default([]),
    })),
    confidence: z.enum(["complete", "review", "insufficient"]),
    coverageCompleteness: z.enum([
      "complete",
      "degraded",
      "insufficient",
    ]).optional(),
    evidenceConfidence: z.enum([
      "high",
      "review",
      "ambiguous",
    ]).optional(),
    warnings: z.array(z.string()),
  }),
  missionReadiness: MissionReadinessSchema,
  findings: z.array(z.unknown()),
  changeCandidates: z.array(z.unknown()),
  limitations: z.array(z.string()),
  warnings: z.array(z.string()),
  artifacts: z.array(z.object({
    format: z.enum([
      "stress-json",
      "stress-html",
      "stress-manifest",
      "child-report",
      "profile-policy",
      "player-source-rosz",
      "player-enriched-rosz",
      "opponent-source-rosz",
      "opponent-enriched-rosz",
      "player-source-json",
      "player-local-engine-input",
      "opponent-source-json",
      "opponent-local-engine-input",
    ]),
    written: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  })),
}).passthrough();

function issue(
  code: string,
  message: string,
  severity: "error" | "warn" = "error",
): RosterIssue {
  return { code, message, severity };
}

function failure<T>(
  code: string,
  message: string,
  warnings: RosterIssue[] = [],
): ResultEnvelope<T> {
  return {
    ok: false,
    data: null,
    violations: [issue(code, message)],
    warnings,
  };
}

function safeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function defaultStressOutputDirectory(
  playerRoster: RosterDraftV1,
  opponentFactionId: string,
  runId: string,
  now = new Date(),
): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(
    "exports",
    "tessera",
    `${safeName(playerRoster.factionId) || "player"}-vs-${safeName(
      opponentFactionId,
    ) || "opponent"}-${playerRoster.pointsLimit}-${timestamp}-${runId.slice(0, 8)}`,
  );
}

function resolveFromWriteRoot(
  value: string,
  options: WriteOptions,
): string {
  return path.resolve(options.rootDir ?? process.cwd(), value);
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(
    path.resolve(root),
    path.resolve(candidate),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function tesseraOutputFailure(error: unknown): {
  code: string;
  message: string;
} {
  const filesystemCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;
  const message =
    error instanceof Error ? error.message : "";
  if (
    filesystemCode === "EEXIST" ||
    /refusing to overwrite existing file/i.test(message)
  ) {
    return {
      code: "TESSERA_OUTPUT_ALREADY_EXISTS",
      message:
        "The Tessera output directory already contains protected artifacts. Choose a new directory or explicitly allow overwrite.",
    };
  }
  if (
    /outside|filesystem root/i.test(message)
  ) {
    return {
      code: "TESSERA_OUTPUT_OUTSIDE_ROOT",
      message:
        "The Tessera output path is outside the allowed write root.",
    };
  }
  return {
    code: "TESSERA_OUTPUT_RESERVATION_FAILED",
    message:
      "The Tessera output artifacts could not be reserved safely.",
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function combineTesseraUiIdentities(
  identities: Array<string | null | undefined>,
): string | null {
  return (
    unique(
      identities.filter(
        (identity): identity is string => Boolean(identity),
      ),
    )
      .sort()
      .join("|") || null
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function portfolioContentSha256(
  portfolio: TesseraStressPortfolio,
): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(portfolio))
    .digest("hex");
}

function portfolioIdentityWithoutDerivedCoverage(
  portfolio: TesseraStressPortfolio,
): string {
  const identity: Partial<TesseraStressPortfolio> = {
    ...portfolio,
  };
  delete identity.coverage;
  return canonicalJson(identity);
}

function scopedProfileRequirements(
  rosters: RosterDraftV1[],
  enrichedRequirements?: TesseraProfileRequirement[] | null,
): TesseraProfileRequirement[] {
  const normalizedFactionIdentity = (value: string): string =>
    normalizeProfileIdentity(value)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const rosterScopes = rosters.flatMap((roster) => {
    const occurrenceByUnitSize = new Map<string, number>();
    return roster.units.map((unit) => {
      const unitKey = [
        normalizeProfileIdentity(unit.name),
        unit.modelCount,
      ].join("|");
      const unitOccurrence =
        (occurrenceByUnitSize.get(unitKey) ?? 0) + 1;
      occurrenceByUnitSize.set(unitKey, unitOccurrence);
      return {
        factions: new Set([
          normalizedFactionIdentity(roster.factionId),
          normalizedFactionIdentity(roster.factionName),
        ]),
        unit: normalizeProfileIdentity(unit.name),
        selectionId: unit.selectionId,
        modelCount: unit.modelCount,
        unitOccurrence,
      };
    });
  });
  const relevantEnrichedRequirements =
    enrichedRequirements?.filter((requirement) =>
      rosterScopes.some((scope) =>
        (
          requirement.selectionId !== null &&
          requirement.selectionId === scope.selectionId
        ) ||
        (
          scope.factions.has(
            normalizedFactionIdentity(requirement.faction),
          ) &&
          normalizeProfileIdentity(requirement.unit) === scope.unit &&
          (
            requirement.modelCount === undefined ||
            requirement.modelCount === scope.modelCount
          ) &&
          (
            requirement.unitOccurrence === undefined ||
            requirement.unitOccurrence === scope.unitOccurrence
          )
        )
      ),
    ) ?? [];
  return mergeProfileInventory([
    ...aggregateProfileRequirements(rosters),
    ...relevantEnrichedRequirements,
  ]);
}

function scopedProfilePolicy(
  policy: ProfilePolicyV1 | null,
  requirements: TesseraProfileRequirement[],
): ProfilePolicyV1 | null {
  if (!policy) return null;
  return {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: policy.entries.filter((entry) =>
      requirements.some((requirement) =>
        profilePolicyIdentityMatches(entry, requirement),
      ),
    ),
  };
}

function portableReportValue(
  value: unknown,
  key = "",
  outputDirectory?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      portableReportValue(entry, key, outputDirectory)
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        portableReportValue(entry, entryKey, outputDirectory),
      ]),
    );
  }
  if (typeof value === "string" && key === "listUrl") return null;
  if (
    typeof value === "string" &&
    (key.endsWith("Path") || key === "written") &&
    path.isAbsolute(value)
  ) {
    if (outputDirectory) {
      const relative = path.relative(outputDirectory, value);
      if (
        relative &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ) {
        return relative;
      }
    }
    return path.basename(value);
  }
  return value;
}

function portableStressReport(
  report: TesseraStressTestReport,
  outputDirectory: string,
): TesseraStressTestReport {
  return portableReportValue(
    report,
    "",
    outputDirectory,
  ) as TesseraStressTestReport;
}

function portableManifestValue(
  value: unknown,
  manifestDirectory: string,
  key = "",
  parentKey = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      portableManifestValue(entry, manifestDirectory, key, parentKey)
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        portableManifestValue(
          entry,
          manifestDirectory,
          entryKey,
          key,
        ),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (key === "outputDirectory") return ".";
  const isPath =
    key.endsWith("Path") ||
    key === "reportPath" ||
    (parentKey === "simulationInput" && key === "path") ||
    (parentKey === "finalArtifacts" &&
      (key === "json" || key === "html"));
  if (!isPath || !path.isAbsolute(value)) return value;
  const relative = path.relative(manifestDirectory, value);
  return relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
    ? relative
    : value;
}

function resolveManifestValue(
  value: unknown,
  manifestDirectory: string,
  key = "",
  parentKey = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      resolveManifestValue(entry, manifestDirectory, key, parentKey)
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        resolveManifestValue(
          entry,
          manifestDirectory,
          entryKey,
          key,
        ),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  const isPath =
    key === "outputDirectory" ||
    key.endsWith("Path") ||
    key === "reportPath" ||
    (parentKey === "simulationInput" && key === "path") ||
    (parentKey === "finalArtifacts" &&
      (key === "json" || key === "html"));
  return isPath && !path.isAbsolute(value)
    ? path.resolve(manifestDirectory, value)
    : value;
}

async function fileSha256(filename: string): Promise<string> {
  const content = await readFile(filename);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    content,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fileContentSha256(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function artifactMaterializationError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function materializeContentAddressedRosz(
  sourceFilename: string,
  outputDirectory: string,
  expectedSha256?: string,
): Promise<{ filename: string; sha256: string }> {
  const resolvedSource = path.resolve(sourceFilename);
  if (!(await pathExists(resolvedSource))) {
    throw artifactMaterializationError(
      "TESSERA_STRESS_BUNDLE_ARTIFACT_MISSING",
      `The verified prepared artifact is missing: ${resolvedSource}.`,
    );
  }
  const sourceSha256 = await fileSha256(resolvedSource);
  if (
    expectedSha256 !== undefined &&
    sourceSha256 !== expectedSha256
  ) {
    throw artifactMaterializationError(
      "TESSERA_STRESS_BUNDLE_ARTIFACT_CHANGED",
      `The verified prepared artifact changed before it could be bundled: ${resolvedSource}.`,
    );
  }
  const basename =
    safeName(path.basename(resolvedSource)) || "artifact.rosz";
  const destinationDirectory = path.join(
    outputDirectory,
    "artifacts",
    "sha256",
    sourceSha256,
  );
  const destination = path.join(destinationDirectory, basename);
  if (path.resolve(destination) === resolvedSource) {
    return { filename: destination, sha256: sourceSha256 };
  }
  await mkdir(destinationDirectory, { recursive: true });
  if (await pathExists(destination)) {
    if ((await fileSha256(destination)) !== sourceSha256) {
      throw artifactMaterializationError(
        "TESSERA_STRESS_BUNDLE_ARTIFACT_CHANGED",
        `The content-addressed bundle artifact is corrupt: ${destination}.`,
      );
    }
    return { filename: destination, sha256: sourceSha256 };
  }
  const temporary = path.join(
    destinationDirectory,
    `.${basename}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await copyFile(resolvedSource, temporary);
    if ((await fileSha256(temporary)) !== sourceSha256) {
      throw artifactMaterializationError(
        "TESSERA_STRESS_BUNDLE_ARTIFACT_CHANGED",
        `The prepared artifact changed while it was copied: ${resolvedSource}.`,
      );
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  if ((await fileSha256(destination)) !== sourceSha256) {
    throw artifactMaterializationError(
      "TESSERA_STRESS_BUNDLE_ARTIFACT_CHANGED",
      `The copied bundle artifact failed hash verification: ${destination}.`,
    );
  }
  return { filename: destination, sha256: sourceSha256 };
}

async function materializePreparedRoster(
  prepared: TesseraPreparedRoster,
  outputDirectory: string,
  expectedEnrichedSha256: string,
): Promise<TesseraPreparedRoster> {
  const [source, enriched] = await Promise.all([
    materializeContentAddressedRosz(
      prepared.sourceRoszPath,
      outputDirectory,
    ),
    materializeContentAddressedRosz(
      prepared.enrichedRoszPath,
      outputDirectory,
      expectedEnrichedSha256,
    ),
  ]);
  return {
    ...prepared,
    sourceRoszPath: source.filename,
    enrichedRoszPath: enriched.filename,
    ...(prepared.simulationInput?.kind ===
    "rosterpilot-local-engine-input"
      ? {
          simulationInput: {
            ...prepared.simulationInput,
            path: enriched.filename,
            sha256: enriched.sha256,
          },
        }
      : {}),
  };
}

async function materializeManifestPreparedArtifacts(
  manifest: TesseraStressManifest,
  outputDirectory: string,
): Promise<void> {
  if (manifest.preparedPlayer) {
    if (!manifest.preparedPlayerSha256) {
      throw artifactMaterializationError(
        "TESSERA_STRESS_BUNDLE_ARTIFACT_MISSING",
        "The prepared player receipt has no verified enriched artifact hash.",
      );
    }
    manifest.preparedPlayer = await materializePreparedRoster(
      manifest.preparedPlayer,
      outputDirectory,
      manifest.preparedPlayerSha256,
    );
  }
  for (const receipt of Object.values(
    manifest.preparedOpponents,
  )) {
    receipt.prepared = await materializePreparedRoster(
      receipt.prepared,
      outputDirectory,
      receipt.sha256,
    );
  }
}

function materializationFailureCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("TESSERA_STRESS_BUNDLE_")
  ) {
    return error.code;
  }
  return "TESSERA_STRESS_BUNDLE_ARTIFACT_WRITE_FAILED";
}

async function readProfilePolicy(
  filename: string | undefined,
  options: TesseraStressOptions,
): Promise<ProfilePolicyV1 | null> {
  if (!filename) return null;
  const resolved = resolveFromWriteRoot(filename, options);
  const parsed = ProfilePolicySchema.safeParse(
    JSON.parse(await readFile(resolved, "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `The profile policy is invalid: ${parsed.error.issues[0]?.message ?? "schema validation failed"}.`,
    );
  }
  return parsed.data;
}

async function writeProfilePolicyScaffold(
  outputDirectory: string,
  requirements: ReturnType<typeof aggregateProfileRequirements>,
  options: TesseraStressOptions,
): Promise<string> {
  const filename = path.join(
    outputDirectory,
    "tessera-profile-policy.scaffold.json",
  );
  const [written] = await writeExportArtifacts(
    [
      {
        format: "roster-json",
        filename: path.basename(filename),
        mimeType: "application/json",
        encoding: "utf8",
        content: `${JSON.stringify(profilePolicyScaffold(requirements), null, 2)}\n`,
      },
    ],
    path.dirname(filename),
    { ...options, overwrite: true },
  );
  return written;
}

async function preflightPlayerRoster(
  roster: RosterDraftV1,
): Promise<ResultEnvelope<true>> {
  const exported = await exportRoster(roster, "rosz");
  if (!exported.ok || !exported.data) {
    return {
      ok: false,
      data: null,
      violations: exported.violations,
      warnings: exported.warnings,
    };
  }
  return {
    ok: true,
    data: true,
    violations: [],
    warnings: exported.warnings,
  };
}

function normalizePortfolioCoverage(
  portfolio: TesseraStressPortfolio,
): TesseraStressPortfolio {
  const readyItems = portfolio.items.filter(
    (item) => item.status === "ready" && item.roster !== null,
  );
  for (const item of readyItems) {
    item.containsNamedCharacter = rosterHasNamedCharacter(
      item.roster!,
    );
  }
  const intendedPostures = [
    ...new Set(portfolio.items.map((item) => item.posture)),
  ];
  const intendedCompositions = [
    ...new Set(portfolio.items.map((item) => item.composition)),
  ];
  const representedPostures = intendedPostures.filter((posture) =>
    readyItems.some((item) => item.posture === posture),
  );
  const representedCompositions = intendedCompositions.filter(
    (composition) =>
      readyItems.some((item) => item.composition === composition),
  );
  const missingPostures = intendedPostures.filter(
    (posture) => !representedPostures.includes(posture),
  );
  const missingCompositions = intendedCompositions.filter(
    (composition) =>
      !representedCompositions.includes(composition),
  );
  const hasReadyNamedCharacter = readyItems.some(
    (item) => item.containsNamedCharacter === true,
  );
  const uniqueSimulationPayloads = new Set(
    readyItems
      .map((item) => item.simulationFingerprint)
      .filter((value): value is string => Boolean(value)),
  ).size;
  const priorCoverage = portfolio.coverage;
  const namedCharacterCoverageStatus =
    priorCoverage.namedCharacterCoverageStatus ??
    (
      hasReadyNamedCharacter
        ? "included"
        : !factionHasLegalNamedAnchor(
              portfolio.factionId,
              portfolio.pointsLimit,
            )
          ? "not-applicable"
          : "unavailable-after-evaluation"
    );
  const namedCharacterCoverageReason =
    namedCharacterCoverageStatus === "included"
      ? null
      : priorCoverage.namedCharacterCoverageReason
        ? priorCoverage.namedCharacterCoverageReason
        : namedCharacterCoverageStatus === "not-applicable"
          ? `${portfolio.factionName} has no legal named-character anchor within the ${portfolio.pointsLimit}-point limit under the pinned source data.`
          : namedCharacterCoverageStatus ===
              "buildable-not-simulated"
            ? `${portfolio.factionName} has a legal, exportable named-character specialist, but it was not one of the simulated portfolio payloads.`
          : `${portfolio.factionName} has legal named-character anchors, but no legal, New Recruit-exportable specialist proxy was retained in the legacy portfolio evidence. This does not reduce core-3 posture coverage.`;
  portfolio.coverage = {
    ...priorCoverage,
    ready: readyItems.length,
    unavailable: portfolio.items.length - readyItems.length,
    representedPostures,
    missingPostures,
    representedCompositions,
    missingCompositions,
    representedCells: readyItems.map((item) => ({
      templateId: item.templateId,
      posture: item.posture,
      composition: item.composition,
    })),
    missingCells: portfolio.items
      .filter((item) => item.status === "unavailable")
      .map((item) => ({
        templateId: item.templateId,
        posture: item.posture,
        composition: item.composition,
        reason:
          item.omissionReason ??
          "The intended portfolio cell is unavailable.",
      })),
    uniqueSimulationPayloads,
    namedCharacterCoverage:
      namedCharacterCoverageStatus === "included" ||
      namedCharacterCoverageStatus === "not-applicable",
    namedCharacterCoverageStatus,
    namedCharacterCoverageReason,
    maximumResultStatus:
      (
        uniqueSimulationPayloads < portfolio.coverage.intended ||
        missingPostures.length > 0 ||
        (
          portfolio.suite === "diverse-9" &&
          missingCompositions.length > 0
        ) ||
        portfolio.items.some((item) => item.status === "unavailable")
      )
        ? "degraded"
        : "complete",
  };
  return portfolio;
}

async function preflightPortfolio(
  playerRoster: RosterDraftV1,
  portfolio: TesseraStressPortfolio,
): Promise<ResultEnvelope<TesseraStressPortfolio>> {
  const player = await preflightPlayerRoster(playerRoster);
  if (!player.ok) {
    return {
      ok: false,
      data: null,
      violations: player.violations,
      warnings: player.warnings,
    };
  }
  const checked = structuredClone(portfolio);
  const warnings: RosterIssue[] = player.warnings.map((warning) => ({
    ...warning,
    message: `[player] ${warning.message}`,
  }));
  for (const item of checked.items) {
    if (item.status !== "ready" || !item.roster) continue;
    const exported = await exportRoster(item.roster, "rosz");
    if (exported.ok && exported.data) {
      warnings.push(
        ...exported.warnings.map((warning) => ({
          ...warning,
          message: `[${item.templateId}] ${warning.message}`,
        })),
      );
      continue;
    }
    const message =
      exported.violations[0]?.message ??
      "The proxy could not be mapped to a New Recruit .rosz file.";
    const warning = issue(
      "STRESS_PROXY_PREFLIGHT_FAILED",
      `${item.templateId}: ${message}`,
      "warn",
    );
    item.status = "unavailable";
    item.roster = null;
    item.omissionReason = message;
    item.warnings = [
      ...item.warnings,
      ...exported.warnings,
      warning,
    ];
    warnings.push(
      ...exported.warnings.map((exportWarning) => ({
        ...exportWarning,
        message: `[${item.templateId}] ${exportWarning.message}`,
      })),
      warning,
    );
  }
  const seenPayloads = new Set<string>();
  for (const item of checked.items) {
    if (item.status !== "ready" || !item.roster) continue;
    const simulationFingerprint = rosterSimulationFingerprint(item.roster);
    item.simulationFingerprint = simulationFingerprint;
    item.containsNamedCharacter = rosterHasNamedCharacter(item.roster);
    if (seenPayloads.has(simulationFingerprint)) {
      const message =
        "This proxy duplicates a Tessera simulation payload already represented in the portfolio; detachment-only differences do not receive equal weight.";
      item.status = "unavailable";
      item.roster = null;
      item.omissionReason = message;
      const warning = issue(
        "STRESS_DUPLICATE_SIMULATION_PAYLOAD",
        `${item.templateId}: ${message}`,
        "warn",
      );
      item.warnings = [...item.warnings, warning];
      warnings.push(warning);
      continue;
    }
    seenPayloads.add(simulationFingerprint);
  }
  checked.coverage.uniqueSimulationPayloads = seenPayloads.size;
  normalizePortfolioCoverage(checked);
  const contract =
    evaluateTesseraStressPortfolioContract(checked);
  if (!contract.accepted) {
    return {
      ok: false,
      data: null,
      violations: [contract.violation!],
      warnings,
    };
  }
  checked.coverage.uniqueSimulationPayloads =
    contract.uniqueSimulationPayloads;
  checked.coverage.maximumResultStatus =
    contract.maximumResultStatus!;
  return {
    ok: true,
    data: checked,
    violations: [],
    warnings,
  };
}

function sharedSourcePin(
  sourceData: StressSourceData,
): string {
  if (
    "bundleId" in sourceData &&
    "engineDataSchemaVersion" in sourceData
  ) {
    return JSON.stringify({
      bundleId: sourceData.bundleId,
      engineDataSchemaVersion:
        sourceData.engineDataSchemaVersion,
    });
  }
  return JSON.stringify({
    package: sourceData.package,
    version: sourceData.version,
    edition: sourceData.edition,
    dataslate: sourceData.dataslate,
    releaseId: sourceData.releaseId,
    newRecruit: {
      repository: sourceData.newRecruit.repository,
      commit: sourceData.newRecruit.commit,
      gameSystemRevision:
        sourceData.newRecruit.gameSystemRevision,
    },
    official: sourceData.official,
  });
}

function stressConfiguration(
  options: TesseraStressOptions,
  frozenProfilePolicyHash: string | null = null,
): TesseraStressConfiguration {
  const suite = options.suite ?? "diverse-9";
  return {
    suite,
    analysisStrategy:
      options.analysisStrategy ??
      (suite === "core-3" ? "full-all" : "staged"),
    catalogueDriftMode:
      options.catalogueDriftMode ?? "reject",
    providerCompatibilityMode: effectiveProviderCompatibilityMode(
      options.providerCompatibilityMode,
    ),
    pointsTolerancePercent: 5,
    proxyWeights: "equal",
    screeningMetric: "half-wipe-probability",
    screeningPhases: ["shooting", "fight"],
    screeningDirections: [
      "player-to-opponent",
      "opponent-to-player",
    ],
    revisionMateriality: 0.01,
    profilePolicyHash: frozenProfilePolicyHash,
  };
}

function newStageEntry(): ManifestStageEntry {
  return {
    status: "pending",
    reportPath: null,
    reportSha256: null,
    error: null,
    attemptCount: 0,
    attemptHistory: [],
    firstAttemptAt: null,
    lastAttemptAt: null,
    nextAction: null,
  };
}

function emptyStage(
  portfolio: TesseraStressPortfolio,
): Record<string, ManifestStageEntry> {
  return Object.fromEntries(
    portfolio.items
      .filter((item) => item.status === "ready")
      .map((item) => [
        item.templateId,
        newStageEntry(),
      ]),
  );
}

function stageEntryIsReusable(
  entry: ManifestStageEntry | undefined,
  simulationRequested: boolean,
): boolean {
  if (!entry?.reportPath || !entry.reportSha256) return false;
  return simulationRequested
    ? entry.status === "complete" && entry.error === null
    : entry.status === "complete" || entry.status === "partial";
}

function stageContractFor(
  manifest: TesseraStressManifest,
  stage: "screening" | "deepDive",
  templateId: string,
): TesseraFrozenScenarioContract[] | null {
  const contract = manifest.stageContracts[stage][templateId];
  return contract?.length ? contract : null;
}

function cloneStageContractMap(
  contracts: Record<string, TesseraFrozenScenarioContract[]>,
): Record<string, TesseraFrozenScenarioContract[]> {
  return Object.fromEntries(
    Object.entries(contracts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([templateId, contract]) => [
        templateId,
        sortedScenarioContract(contract),
      ]),
  );
}

function cloneStageContracts(
  contracts: ManifestStageContracts,
): ManifestStageContracts {
  return {
    screening: cloneStageContractMap(contracts.screening),
    deepDive: cloneStageContractMap(contracts.deepDive),
  };
}

function stageContractsSha256(
  contracts: ManifestStageContracts,
): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(cloneStageContracts(contracts)))
    .digest("hex");
}

function projectedStageContracts(
  portfolio: TesseraStressPortfolio,
  configuration: TesseraStressConfiguration,
  contract: TesseraFrozenScenarioContract[] | null,
): ManifestStageContracts {
  if (!contract) return { screening: {}, deepDive: {} };
  const templateIds = portfolio.items
    .filter((item) => item.status === "ready" && item.roster !== null)
    .map((item) => item.templateId)
    .sort();
  const screeningMetrics =
    configuration.analysisStrategy === "full-all"
      ? FULL_METRICS
      : SCREENING_METRICS;
  const screening = projectTesseraScenarioContract(
    contract,
    TESSERA_SCENARIO_PHASES,
    screeningMetrics,
  );
  const deepDive =
    configuration.analysisStrategy === "full-all"
      ? null
      : projectTesseraScenarioContract(
          contract,
          TESSERA_SCENARIO_PHASES,
          DEEP_DIVE_METRICS,
        );
  return {
    screening: Object.fromEntries(
      templateIds.map((templateId) => [
        templateId,
        structuredClone(screening),
      ]),
    ),
    deepDive: deepDive
      ? Object.fromEntries(
          templateIds.map((templateId) => [
            templateId,
            structuredClone(deepDive),
          ]),
        )
      : {},
  };
}

function stageEvidenceIsReusable(
  manifest: TesseraStressManifest,
  stage: "screening" | "deepDive",
  templateId: string,
): boolean {
  return (
    stageEntryIsReusable(
      manifest[stage][templateId],
      manifest.simulationRequested,
    ) &&
    (
      !manifest.simulationRequested ||
      stageContractFor(manifest, stage, templateId) !== null
    )
  );
}

function manifestHasRetryableWork(
  manifest: TesseraStressManifest,
): boolean {
  const readyTemplateIds = manifest.portfolio.items
    .filter((item) => item.status === "ready" && item.roster !== null)
    .map((item) => item.templateId);
  if (
    readyTemplateIds.some(
      (templateId) =>
        !stageEvidenceIsReusable(
          manifest,
          "screening",
          templateId,
        ),
    )
  ) {
    return true;
  }
  if (manifest.configuration.analysisStrategy === "full-all") {
    return false;
  }
  return manifest.representatives.some(
    (representative) =>
      !stageEvidenceIsReusable(
        manifest,
        "deepDive",
        representative.templateId,
      ),
  );
}

function newManifest(
  playerRoster: RosterDraftV1,
  opponentFactionId: string,
  portfolio: TesseraStressPortfolio,
  configuration: TesseraStressConfiguration,
  outputDirectory: string,
  simulationRequested: boolean,
  simulationBackend: TesseraSimulationBackend,
  profilePolicy: ProfilePolicyV1 | null,
  warnings: string[] = [],
  runId = crypto.randomUUID(),
  cachedLiveUpdateCheck: LiveDataFreshness | null = null,
  requestedScenarioContract: TesseraFrozenScenarioContract[] | null = null,
): TesseraStressManifest {
  const now = new Date().toISOString();
  const canonicalRequestedContract = requestedScenarioContract
    ? canonicalTesseraScenarioContract(requestedScenarioContract)
    : null;
  const stageContracts = projectedStageContracts(
    portfolio,
    configuration,
    canonicalRequestedContract,
  );
  return {
    schemaVersion: 6,
    reportKind: "tessera-stress-manifest",
    runId,
    createdAt: now,
    updatedAt: now,
    playerFingerprint: rosterExecutionFingerprint(playerRoster),
    playerSourceData: playerRoster.sourceData,
    opponentFactionId,
    configuration,
    portfolioSha256: portfolioContentSha256(portfolio),
    portfolio,
    outputDirectory: path.resolve(outputDirectory),
    simulationRequested,
    simulationBackend,
    selectedSimulationBackend:
      selectedSimulationBackend(simulationBackend),
    profilePolicy,
    profilePolicyHash:
      profilePolicy === null ? null : profilePolicyHash(profilePolicy),
    enrichedProfileRequirements: null,
    requestedScenarioContract: canonicalRequestedContract,
    requestedScenarioContractSha256: canonicalRequestedContract
      ? tesseraScenarioContractSha256(canonicalRequestedContract)
      : null,
    stageContracts,
    stageContractsSha256: stageContractsSha256(stageContracts),
    warnings,
    cachedLiveUpdateCheck,
    playerPreparationStartedAt: null,
    opponentPreparationStartedAt: {},
    preparedPlayer: null,
    preparedPlayerSha256: null,
    preparedOpponents: {},
    representatives: [],
    screening: emptyStage(portfolio),
    deepDive: emptyStage(portfolio),
    finalArtifacts: null,
    completedAt: null,
  };
}

type LegacyManifestStageContracts = {
  screening: TesseraFrozenScenarioContract[] | null;
  deepDive: TesseraFrozenScenarioContract[] | null;
};

type ParsedStageContracts =
  | LegacyManifestStageContracts
  | ManifestStageContracts
  | undefined;

function legacyStageContracts(
  contracts: ParsedStageContracts,
): LegacyManifestStageContracts | null {
  if (
    !contracts ||
    (
      contracts.screening !== null &&
      !Array.isArray(contracts.screening)
    )
  ) {
    return null;
  }
  return contracts as LegacyManifestStageContracts;
}

function migratedLegacyStageContracts(
  contract: TesseraFrozenScenarioContract[] | null,
  entries: Record<string, ManifestStageEntry>,
): Record<string, TesseraFrozenScenarioContract[]> {
  if (!contract?.length) return {};
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([, entry]) => entry.status === "complete")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([templateId]) => [
        templateId,
        sortedScenarioContract(contract),
      ]),
  );
}

function normalizeStageContracts(
  contracts: ParsedStageContracts,
  screening: Record<string, ManifestStageEntry>,
  deepDive: Record<string, ManifestStageEntry>,
): ManifestStageContracts {
  if (!contracts) {
    return { screening: {}, deepDive: {} };
  }
  const legacy = legacyStageContracts(contracts);
  if (legacy) {
    return {
      screening: migratedLegacyStageContracts(
        legacy.screening,
        screening,
      ),
      deepDive: migratedLegacyStageContracts(
        legacy.deepDive,
        deepDive,
      ),
    };
  }
  return cloneStageContracts(contracts as ManifestStageContracts);
}

function uniqueContractIteration(
  contract: TesseraFrozenScenarioContract[] | null,
): number | null {
  const values = [
    ...new Set(
      (contract ?? [])
        .map((entry) => entry.iterations)
        .filter((value): value is number => value !== null),
    ),
  ];
  return values.length === 1 ? values[0] : null;
}

function repairLegacyCrossProxyIterationReplayFailures(
  legacyContracts: LegacyManifestStageContracts | null,
  contracts: ManifestStageContracts,
  screening: Record<string, ManifestStageEntry>,
  deepDive: Record<string, ManifestStageEntry>,
): string[] {
  if (!legacyContracts) return [];
  const repaired: string[] = [];
  for (const stage of ["screening", "deepDive"] as const) {
    const expectedIterations = uniqueContractIteration(
      legacyContracts[stage],
    );
    if (expectedIterations === null) continue;
    for (const [templateId, entry] of Object.entries(
      stage === "screening" ? screening : deepDive,
    )) {
      if (
        entry.status === "complete" ||
        contracts[stage][templateId] !== undefined ||
        entry.error?.code !== "TESSERA_SETTINGS_REPLAY_FAILED"
      ) {
        continue;
      }
      const match = entry.error.message.match(
        /^Tessera is using ([1-9]\d*) iterations and did not expose one control for the frozen value ([1-9]\d*)\.$/,
      );
      if (!match) continue;
      const observedIterations = Number(match[1]);
      const replayedIterations = Number(match[2]);
      if (
        observedIterations === replayedIterations ||
        replayedIterations !== expectedIterations
      ) {
        continue;
      }
      entry.error = {
        ...entry.error,
        retryable: true,
      };
      entry.nextAction =
        "Resume this run to recapture the proxy under its own frozen Tessera settings contract.";
      repaired.push(`${stage}/${templateId}`);
    }
  }
  return repaired;
}

async function readManifest(
  filename: string,
): Promise<TesseraStressManifest> {
  const serialized = JSON.parse(await readFile(filename, "utf8"));
  const raw = resolveManifestValue(
    serialized,
    path.dirname(path.resolve(filename)),
  ) as {
    schemaVersion?: number;
  };
  const parsed = StressManifestSchema.safeParse(
    raw,
  );
  if (!parsed.success) {
    throw new Error(
      `The resume manifest is not compatible: ${parsed.error.issues[0]?.message ?? "schema validation failed"}.`,
    );
  }
  const data = parsed.data;
  if (
    data.schemaVersion >= 5 &&
    (
      data.simulationBackend === undefined ||
      data.selectedSimulationBackend === undefined
    )
  ) {
    throw new Error(
      "The v5 resume manifest must freeze both simulationBackend and selectedSimulationBackend.",
    );
  }
  const migratedSimulationBackend =
    data.simulationBackend ?? "website";
  const migratedSelectedSimulationBackend =
    data.selectedSimulationBackend ??
    selectedSimulationBackend(migratedSimulationBackend);
  if (
    migratedSelectedSimulationBackend !==
    selectedSimulationBackend(migratedSimulationBackend)
  ) {
    throw new Error(
      "The resume manifest's selected simulation provider does not match its frozen backend request.",
    );
  }
  const normalizedPortfolio = normalizePortfolioCoverage(
    data.portfolio as unknown as TesseraStressPortfolio,
  );
  const computedPortfolioSha256 =
    portfolioContentSha256(normalizedPortfolio);
  if (
    data.schemaVersion >= 3 &&
    data.portfolioSha256 === undefined
  ) {
    throw new Error(
      `The v${data.schemaVersion} resume manifest does not contain its required frozen portfolio SHA-256.`,
    );
  }
  if (
    data.portfolioSha256 !== undefined &&
    data.portfolioSha256 !== computedPortfolioSha256
  ) {
    throw new Error(
      "The resume manifest's frozen portfolio content does not match portfolioSha256.",
    );
  }
  const migrateStage = (
    entries: typeof data.screening,
  ): Record<string, ManifestStageEntry> =>
    Object.fromEntries(
      Object.entries(entries).map(([templateId, entry]) => [
        templateId,
        "attemptCount" in entry
          ? {
              ...entry,
              attemptHistory: entry.attemptHistory ?? [],
            }
          : {
              status: entry.status,
              reportPath: entry.reportPath,
              reportSha256: entry.reportSha256,
              error:
                entry.error === null
                  ? null
                  : {
                      code: "TESSERA_LEGACY_STAGE_ERROR",
                      message: entry.error,
                      retryable: true,
                    },
              attemptCount:
                entry.status === "pending" ? 0 : 1,
              attemptHistory: [],
              firstAttemptAt: null,
              lastAttemptAt: null,
              nextAction:
                entry.status === "complete"
                  ? null
                  : "Resume the run with the v2 workflow.",
            },
      ]),
    );
  const screening = migrateStage(data.screening);
  const deepDive = migrateStage(data.deepDive);
  const parsedStageContracts =
    data.stageContracts as ParsedStageContracts;
  const stageContracts = normalizeStageContracts(
    parsedStageContracts,
    screening,
    deepDive,
  );
  if (
    data.schemaVersion === 6 &&
    (
      data.requestedScenarioContract === undefined ||
      data.requestedScenarioContractSha256 === undefined ||
      data.stageContractsSha256 === undefined
    )
  ) {
    throw new Error(
      "The v6 resume manifest does not contain its required scenario-contract provenance.",
    );
  }
  const requestedScenarioContract =
    data.requestedScenarioContract === undefined ||
      data.requestedScenarioContract === null
      ? null
      : assertTesseraScenarioContractScope(
          data.requestedScenarioContract,
          TESSERA_SCENARIO_PHASES,
          FULL_METRICS,
        );
  const requestedScenarioContractSha256 = requestedScenarioContract
    ? tesseraScenarioContractSha256(requestedScenarioContract)
    : null;
  if (
    data.schemaVersion === 6 &&
    data.requestedScenarioContractSha256 !== undefined &&
    data.requestedScenarioContractSha256 !==
      requestedScenarioContractSha256
  ) {
    throw new Error(
      "The resume manifest's requested scenario contract does not match its SHA-256.",
    );
  }
  if (
    data.schemaVersion === 6 &&
    data.stageContractsSha256 !== undefined &&
    data.stageContractsSha256 !==
      stageContractsSha256(stageContracts)
  ) {
    throw new Error(
      "The resume manifest's projected stage contracts do not match their SHA-256.",
    );
  }
  if (requestedScenarioContract) {
    assertTesseraScenarioContractProvider(
      requestedScenarioContract,
      migratedSelectedSimulationBackend,
    );
  }
  const repairedLegacyIterationFailures =
    repairLegacyCrossProxyIterationReplayFailures(
      legacyStageContracts(parsedStageContracts),
      stageContracts,
      screening,
      deepDive,
    );
  const manifest = {
    ...data,
    schemaVersion: 6,
    simulationBackend: migratedSimulationBackend,
    selectedSimulationBackend:
      migratedSelectedSimulationBackend,
    configuration: {
      ...data.configuration,
      profilePolicyHash:
        data.configuration.profilePolicyHash ?? null,
    },
    profilePolicy: data.profilePolicy ?? null,
    profilePolicyHash: data.profilePolicyHash ?? null,
    enrichedProfileRequirements:
      data.enrichedProfileRequirements ?? null,
    requestedScenarioContract,
    requestedScenarioContractSha256,
    stageContracts,
    stageContractsSha256: stageContractsSha256(stageContracts),
    warnings: unique([
      ...data.warnings,
      ...(repairedLegacyIterationFailures.length === 0
        ? []
        : [
            `Migrated legacy cross-proxy Tessera iteration replay failures to per-proxy recovery for ${repairedLegacyIterationFailures.join(", ")}; existing attempt history was preserved.`,
          ]),
    ]),
    cachedLiveUpdateCheck:
      (data.cachedLiveUpdateCheck as
        | LiveDataFreshness
        | null
        | undefined) ?? null,
    portfolioSha256: computedPortfolioSha256,
    portfolio: normalizedPortfolio,
    screening,
    deepDive,
  } as TesseraStressManifest;
  Object.defineProperty(manifest, "__migratedFrom", {
    value: raw.schemaVersion === 1 ? 1 : null,
    enumerable: false,
  });
  Object.defineProperty(manifest, "__portfolioHashMigrated", {
    value: data.portfolioSha256 === undefined,
    enumerable: false,
  });
  return manifest;
}

/**
 * Verify a v1/v2/v3/v4/v5/v6 stress manifest and rewrite it in the current
 * portable v6 format. Durable jobs use this only after copying the complete run bundle
 * into their own isolated directory.
 */
export async function verifyAndMigrateTesseraStressManifest(
  filename: string,
): Promise<void> {
  const manifest = await readManifest(filename);
  await writeManifest(
    manifest,
    filename,
    {
      rootDir: path.dirname(path.resolve(filename)),
      allowOutsideRoot: false,
    },
    true,
  );
}

async function writeManifest(
  manifest: TesseraStressManifest,
  filename: string,
  options: TesseraStressOptions,
  overwrite: boolean,
): Promise<void> {
  const currentPortfolioSha256 =
    portfolioContentSha256(manifest.portfolio);
  if (currentPortfolioSha256 !== manifest.portfolioSha256) {
    throw new Error(
      "The frozen stress portfolio changed after its manifest hash was established.",
    );
  }
  const currentRequestedScenarioContractSha256 =
    manifest.requestedScenarioContract
      ? tesseraScenarioContractSha256(
          manifest.requestedScenarioContract,
        )
      : null;
  if (
    currentRequestedScenarioContractSha256 !==
      manifest.requestedScenarioContractSha256
  ) {
    throw new Error(
      "The requested Tessera scenario contract changed after its manifest hash was established.",
    );
  }
  manifest.stageContractsSha256 = stageContractsSha256(
    manifest.stageContracts,
  );
  manifest.updatedAt = new Date().toISOString();
  const portableManifest = portableManifestValue(
    manifest,
    path.dirname(path.resolve(filename)),
  );
  const artifact = {
    format: "roster-json" as const,
    filename: path.basename(filename),
    mimeType: "application/json",
    encoding: "utf8" as const,
    content: `${JSON.stringify(portableManifest, null, 2)}\n`,
  };
  if (!overwrite) {
    await writeExportArtifact(
      artifact,
      filename,
      { ...options, overwrite: false },
    );
    return;
  }
  const [target] = await resolveExportArtifactTargets(
    [artifact],
    path.dirname(filename),
    { ...options, overwrite: true },
  );
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, artifact.content, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function configurationMatches(
  left: TesseraStressConfiguration,
  right: TesseraStressConfiguration,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function configurationMatchesExceptProfilePolicy(
  left: TesseraStressConfiguration,
  right: TesseraStressConfiguration,
): boolean {
  return canonicalJson({
    ...left,
    profilePolicyHash: null,
  }) === canonicalJson({
    ...right,
    profilePolicyHash: null,
  });
}

function profileInventoryKey(
  requirement: TesseraProfileRequirement,
): string {
  return profilePolicyIdentityKey(requirement);
}

function normalizedProfileName(value: string): string {
  return normalizeProfileIdentity(value);
}

function mergeProfileInventory(
  requirements: TesseraProfileRequirement[],
): TesseraProfileRequirement[] {
  const merged = new Map<string, TesseraProfileRequirement>();
  for (const requirement of requirements) {
    const key = profileInventoryKey(requirement);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        ...structuredClone(requirement),
        selectionId: null,
        availableProfiles: [...requirement.availableProfiles],
        selectedProfile: null,
      });
      continue;
    }
    current.activeCount = Math.max(
      current.activeCount,
      requirement.activeCount,
    );
    const profiles = new Map(
      current.availableProfiles.map((profile) => [
        normalizedProfileName(profile),
        profile,
      ]),
    );
    for (const profile of requirement.availableProfiles) {
      profiles.set(normalizedProfileName(profile), profile);
    }
    current.availableProfiles = [...profiles.values()].sort((left, right) =>
      normalizedProfileName(left).localeCompare(
        normalizedProfileName(right),
      ),
    );
  }
  return [...merged.values()].sort((left, right) =>
    profileInventoryKey(left).localeCompare(profileInventoryKey(right)),
  );
}

function compareProfileInventories(
  expected: TesseraProfileRequirement[],
  actual: TesseraProfileRequirement[],
): {
  blocking: string[];
  expanded: string[];
} {
  const expectedByKey = new Map(
    expected.map((requirement) => [
      profileInventoryKey(requirement),
      requirement,
    ]),
  );
  const actualByKey = new Map(
    actual.map((requirement) => [
      profileInventoryKey(requirement),
      requirement,
    ]),
  );
  const blocking: string[] = [];
  const expanded: string[] = [];
  for (const [key, requirement] of expectedByKey) {
    const enriched = actualByKey.get(key);
    const label =
      `${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase}`;
    if (!enriched) {
      blocking.push(
        `${label} is present in pinned roster data but missing from the enriched New Recruit profile inventory.`,
      );
      continue;
    }
    if (enriched.activeCount !== requirement.activeCount) {
      blocking.push(
        `${label} has activeCount ${enriched.activeCount} in the enriched archive; pinned roster data requires ${requirement.activeCount}.`,
      );
    }
    const actualProfiles = new Set(
      enriched.availableProfiles.map(normalizedProfileName),
    );
    const missing = requirement.availableProfiles.filter(
      (profile) => !actualProfiles.has(normalizedProfileName(profile)),
    );
    if (missing.length > 0) {
      blocking.push(
        `${label} is missing enriched profile(s): ${missing.join(", ")}.`,
      );
    }
    const expectedProfiles = new Set(
      requirement.availableProfiles.map(normalizedProfileName),
    );
    const additional = enriched.availableProfiles.filter(
      (profile) => !expectedProfiles.has(normalizedProfileName(profile)),
    );
    if (additional.length > 0) {
      expanded.push(
        `${label} exposes additional enriched profile(s): ${additional.join(", ")}.`,
      );
    }
  }
  for (const [key, requirement] of actualByKey) {
    if (expectedByKey.has(key)) continue;
    expanded.push(
      `${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase} is an additional alternate-profile decision exposed by New Recruit.`,
    );
  }
  return { blocking, expanded };
}

function manifestHasSimulationAttempts(
  manifest: TesseraStressManifest,
): boolean {
  return [
    ...Object.values(manifest.screening),
    ...Object.values(manifest.deepDive),
  ].some((entry) => entry.attemptCount > 0);
}

function preparedDelivery(
  roster: RosterDraftV1,
  prepared: TesseraPreparedRoster,
): ResultEnvelope<NewRecruitDelivery> {
  return {
    ok: true,
    data: {
      rosterId: roster.id,
      rosterName: prepared.rosterName,
      listUrl: prepared.listUrl,
      imported: true,
      sessionReused: true,
      cacheReused: true,
      verification: null,
      enrichedSummary: prepared.summary,
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: path.basename(prepared.sourceRoszPath),
          mimeType: "application/zip",
          written: prepared.sourceRoszPath,
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: path.basename(prepared.enrichedRoszPath),
          mimeType: "application/zip",
          written: prepared.enrichedRoszPath,
        },
      ],
    },
    violations: [],
    warnings: [],
  };
}

function createDeliveryCache(
  dependencies: TesseraStressDependencies,
): {
  dependencies: TesseraDependencies;
  seed: (
    roster: RosterDraftV1,
    prepared: TesseraPreparedRoster,
  ) => Promise<void>;
} {
  const actual = dependencies.deliver ?? deliverRosterToNewRecruit;
  const cache = new Map<
    string,
    ReturnType<typeof deliverRosterToNewRecruit>
  >();
  const deliver = (
    roster: RosterDraftV1,
    options?: NewRecruitDeliveryOptions,
  ) => {
    const key = newRecruitCacheKey(roster);
    const cached = cache.get(key);
    if (cached) return cached;
    const result = (async () => {
      if (!dependencies.deliver) {
        const persisted = await loadNewRecruitCache(roster);
        if (persisted) return persisted;
      }
      const delivered = await actual(roster, options);
      return delivered;
    })();
    cache.set(key, result);
    return result;
  };
  return {
    dependencies: {
      ...dependencies,
      deliver,
      persistentCacheDelivery:
        dependencies.persistentCacheDelivery === true ||
        !dependencies.deliver,
    },
    seed: async (roster, prepared) => {
      // Local-engine JSON is run-local evidence, not a New Recruit delivery.
      if (
        prepared.simulationInput?.kind ===
        "rosterpilot-local-engine-input"
      ) {
        return;
      }
      cache.set(
        newRecruitCacheKey(roster),
        Promise.resolve(preparedDelivery(roster, prepared)),
      );
      if (!dependencies.deliver) {
        const release = await acquireNewRecruitCacheLease(roster);
        try {
          await storeNewRecruitCache(
            roster,
            preparedDelivery(roster, prepared),
          );
        } finally {
          await release();
        }
      }
    },
  };
}

function preparedOpponent(
  report: TesseraMatchupReport,
  item: TesseraStressPortfolioItem,
): TesseraPreparedRoster | null {
  if (!item.roster) return null;
  const opponent = report.opponents.find(
    (candidate) => candidate.rosterName === item.roster?.name,
  );
  if (!opponent) return null;
  return {
    rosterId: item.roster.id,
    rosterName: opponent.rosterName,
    factionId: item.roster.factionId,
    listUrl: null,
    sourceRoszPath: opponent.enrichedRoszPath,
    enrichedRoszPath: opponent.enrichedRoszPath,
    simulationInput: opponent.simulationInput,
    summary: opponent.summary,
    fingerprint: item.fingerprint ?? undefined,
    units: opponent.units,
  };
}

type StoredStageExpectation = {
  player: TesseraPreparedRoster;
  item: TesseraStressPortfolioItem & { roster: RosterDraftV1 };
  metrics: TesseraMetric[];
  mode: "quick" | "full";
  simulationRequested: boolean;
  simulationBackend: TesseraSimulationProvider;
  providerCompatibilityMode: "observe" | "enforce";
  includeChangeCandidates: boolean;
  opponentEnrichedRoszPath?: string;
};

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function scenarioMetricValue(
  metric: TesseraMetric,
  cell: NonNullable<
    TesseraMatchupReport["simulation"]["scenarios"]
  >[number]["cells"][number],
): number | null {
  if (metric === "wipe-probability") {
    return cell.values.wipeProbability;
  }
  if (metric === "half-wipe-probability") {
    return cell.values.halfWipeProbability;
  }
  if (metric === "mean-kills") {
    return cell.values.meanKills;
  }
  return cell.values.meanDamage;
}

function completeScenarioValidationError(
  report: TesseraMatchupReport,
  expected: StoredStageExpectation,
): string | null {
  const scenarios = report.simulation.scenarios ?? [];
  const expectedKeys = new Set(
    ["shooting", "fight"].flatMap((phase) =>
      ["player-to-opponent", "opponent-to-player"].map(
        (direction) => `${phase}:${direction}`,
      ),
    ),
  );
  if (scenarios.length !== expectedKeys.size) {
    return `expected ${expectedKeys.size} scenarios but found ${scenarios.length}`;
  }
  const actualKeys = new Set<string>();
  const playerUnits = report.player.units;
  const opponentUnits = report.opponents[0]?.units;
  if (!playerUnits?.length || !opponentUnits?.length) {
    return "complete reports must retain canonical player and opponent unit instances";
  }
  for (const scenario of scenarios) {
    const key = `${scenario.phase}:${scenario.direction}`;
    if (
      !expectedKeys.has(key) ||
      actualKeys.has(key) ||
      scenario.opponentName !== expected.item.roster.name ||
      scenario.status !== "complete" ||
      scenario.iterations === null ||
      !sameStringSet(scenario.metrics, expected.metrics)
    ) {
      return `scenario ${key} does not match the requested phase, direction, metrics, opponent, or completion state`;
    }
    const metricRuns = scenario.metricRuns ?? [];
    if (
      expected.simulationBackend === "local-engine" &&
      (
        metricRuns.length !== scenario.metrics.length ||
        metricRuns.some(
          (metricRun) =>
            metricRun.seed === undefined ||
            metricRun.executionSha256 === undefined ||
            metricRun.projectionSha256 === undefined ||
            metricRun.matrixSha256 === undefined,
        )
      )
    ) {
      return `scenario ${key} does not retain complete deterministic local-engine execution provenance`;
    }
    actualKeys.add(key);
    const attackers =
      scenario.direction === "player-to-opponent"
        ? playerUnits
        : opponentUnits;
    const targets =
      scenario.direction === "player-to-opponent"
        ? opponentUnits
        : playerUnits;
    const expectedCells = new Set(
      attackers.flatMap((attacker) =>
        targets.map(
          (target) =>
            `${attacker.instanceId}:${target.instanceId}`,
        ),
      ),
    );
    const actualCells = new Set(
      scenario.cells.map(
        (cell) =>
          `${cell.attacker.instanceId}:${cell.target.instanceId}`,
      ),
    );
    if (
      actualCells.size !== expectedCells.size ||
      [...expectedCells].some((cell) => !actualCells.has(cell)) ||
      scenario.cells.some(
        (cell) =>
          expected.metrics.some(
            (metric) => scenarioMetricValue(metric, cell) === null,
          ),
      )
    ) {
      return `scenario ${key} has incomplete, duplicate, or mismatched unit cells`;
    }
  }
  return actualKeys.size === expectedKeys.size
    ? null
    : "the report does not contain every required scenario";
}

function combinedStageValidationError(
  report: TesseraMatchupReport,
  player: TesseraPreparedRoster,
  items: Array<
    TesseraStressPortfolioItem & { roster: RosterDraftV1 }
  >,
  metrics: TesseraMetric[],
  mode: "quick" | "full",
  includeChangeCandidates: boolean,
): string | null {
  const configuration = report.configuration;
  const simulationBackend =
    report.simulation.selectedBackend ?? "website";
  const expectedSource =
    simulationBackend === "local-engine"
      ? "tessera-local-engine"
      : "tessera-ui";
  if (
    report.source !== expectedSource ||
    report.status !== "complete" ||
    !report.simulation.requested ||
    (
      report.simulation.providerIdentity !== undefined &&
      report.simulation.providerIdentity.provider !== simulationBackend
    ) ||
    !configuration ||
    configuration.analysisMode !== mode ||
    !sameStringSet(configuration.phases, ["shooting", "fight"]) ||
    !sameStringSet(configuration.metrics, metrics) ||
    !sameStringSet(configuration.directions, [
      "player-to-opponent",
      "opponent-to-player",
    ]) ||
    configuration.pointsTolerancePercent !== 5 ||
    configuration.allowPointMismatch ||
    configuration.includeChangeCandidates !==
      includeChangeCandidates
  ) {
    return "the aggregate report configuration or completion state does not match the required stage";
  }
  const expectedNames = new Set(
    items.map((item) => item.roster.name),
  );
  const actualNames = new Set(
    report.opponents.map((opponent) => opponent.rosterName),
  );
  if (
    report.opponents.length !== items.length ||
    actualNames.size !== items.length ||
    [...expectedNames].some((name) => !actualNames.has(name))
  ) {
    return "the aggregate report opponents do not match the frozen stage";
  }
  for (const item of items) {
    const opponent = report.opponents.find(
      (candidate) => candidate.rosterName === item.roster.name,
    );
    if (
      !opponent ||
      opponent.summary.totalPoints !== item.roster.totalPoints
    ) {
      return `the aggregate report opponent ${item.templateId} does not match its frozen roster`;
    }
    const childReport: TesseraMatchupReport = {
      ...report,
      player,
      opponents: [opponent],
      simulation: {
        ...report.simulation,
        matrices: report.simulation.matrices.filter(
          (matrix) =>
            matrix.opponentName === item.roster.name,
        ),
        scenarios: (report.simulation.scenarios ?? []).filter(
          (scenario) =>
            scenario.opponentName === item.roster.name,
        ),
      },
    };
    const scenarioError = completeScenarioValidationError(
      childReport,
      {
        player,
        item,
        metrics,
        mode,
        simulationRequested: true,
        simulationBackend:
          report.simulation.selectedBackend ?? "website",
        providerCompatibilityMode:
          configuration.providerCompatibilityMode ?? "observe",
        includeChangeCandidates,
      },
    );
    if (scenarioError) {
      return `${item.templateId}: ${scenarioError}`;
    }
  }
  return null;
}

function stageProxyProvenanceMatches(
  report: TesseraMatchupReport,
  proxyRuns: TesseraStressStageProvenance["proxyRuns"],
  items: Array<
    TesseraStressPortfolioItem & { roster: RosterDraftV1 }
  >,
): boolean {
  if (proxyRuns.length !== items.length) return false;
  const runByTemplate = new Map(
    proxyRuns.map((run) => [run.templateId, run]),
  );
  if (runByTemplate.size !== proxyRuns.length) return false;
  return items.every((item) => {
    const run = runByTemplate.get(item.templateId);
    if (!run) return false;
    const consolidatedScenarios = (
      report.simulation.scenarios ?? []
    ).filter(
      (scenario) =>
        scenario.opponentName === item.roster.name,
    );
    const metricRunsAreComplete = consolidatedScenarios.every(
      (scenario) => {
        const metricRuns = scenario.metricRuns ?? [];
        const runMetrics = metricRuns.map((metricRun) =>
          metricRun.metric
        );
        return (
          metricRuns.length === scenario.metrics.length &&
          new Set(runMetrics).size === runMetrics.length &&
          canonicalJson([...runMetrics].sort()) ===
            canonicalJson([...scenario.metrics].sort())
        );
      },
    );
    if (!metricRunsAreComplete) return false;
    const scenarios = consolidatedScenarios
      .flatMap((scenario) =>
        (scenario.metricRuns ?? []).map((metricRun) => ({
          phase: scenario.phase,
          metric: metricRun.metric,
          direction: scenario.direction,
          settings: Object.fromEntries(
            Object.entries(metricRun.settings).sort(
              ([left], [right]) => left.localeCompare(right),
            ),
          ),
          iterations: metricRun.iterations,
          matrixSha256: metricRun.matrixSha256,
        })),
      )
      .sort(
        (left, right) =>
          left.phase.localeCompare(right.phase) ||
          left.direction.localeCompare(right.direction) ||
          left.metric.localeCompare(right.metric),
      );
    const iterations = [
      ...new Set(
        scenarios
          .map((scenario) => scenario.iterations)
          .filter(
            (value): value is number =>
              value !== null &&
              Number.isInteger(value) &&
              value > 0,
          ),
      ),
    ].sort((left, right) => left - right);
    const configuration = report.configuration;
    const expectedScenarioCount = configuration
      ? configuration.phases.length *
        configuration.directions.length *
        configuration.metrics.length
      : 0;
    return (
      scenarios.length === expectedScenarioCount &&
      scenarios.every((scenario) => scenario.iterations !== null) &&
      canonicalJson(run.scenarios) === canonicalJson(scenarios) &&
      canonicalJson(run.iterations) === canonicalJson(iterations)
    );
  });
}

async function readMatchupReport(
  filename: string,
  expected: StoredStageExpectation,
): Promise<TesseraMatchupReport> {
  const parsed = MatchupReportSchema.safeParse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `Stored stage report is invalid: ${parsed.error.issues[0]?.message ?? "schema validation failed"}.`,
    );
  }
  const stored = parsed.data as TesseraMatchupReport;
  const resolveStoredArtifactPath = (value: string): string =>
    path.isAbsolute(value)
      ? value
      : path.resolve(path.dirname(filename), value);
  const report: TesseraMatchupReport = {
    ...stored,
    player: {
      ...stored.player,
      sourceRoszPath: resolveStoredArtifactPath(
        stored.player.sourceRoszPath,
      ),
      enrichedRoszPath: resolveStoredArtifactPath(
        stored.player.enrichedRoszPath,
      ),
    },
    opponents: stored.opponents.map((opponent) => ({
      ...opponent,
      enrichedRoszPath: resolveStoredArtifactPath(
        opponent.enrichedRoszPath,
      ),
    })),
  };
  const configuration = report.configuration;
  const opponent = report.opponents[0];
  const [expectedPlayerSha256, expectedOpponentSha256] =
    await Promise.all([
      fileSha256(expected.player.enrichedRoszPath),
      expected.opponentEnrichedRoszPath
        ? fileSha256(expected.opponentEnrichedRoszPath)
        : Promise.resolve(null),
    ]);
  const mismatches = [
    (
      report.player.enrichedRoszSha256
        ? report.player.enrichedRoszSha256 !== expectedPlayerSha256
        : report.player.enrichedRoszPath !==
          expected.player.enrichedRoszPath
    )
      ? "player enriched artifact path"
      : null,
    report.player.rosterId !== expected.player.rosterId
      ? "player roster id"
      : null,
    report.player.factionId !== expected.player.factionId
      ? "player faction"
      : null,
    report.player.summary.totalPoints !==
    expected.player.summary.totalPoints
      ? "player points"
      : null,
    report.opponents.length !== 1 ? "opponent count" : null,
    !opponent || opponent.rosterName !== expected.item.roster.name
      ? "opponent roster name"
      : null,
    opponent &&
    expected.opponentEnrichedRoszPath !== undefined &&
    (
      opponent.enrichedRoszSha256
        ? opponent.enrichedRoszSha256 !== expectedOpponentSha256
        : opponent.enrichedRoszPath !==
          expected.opponentEnrichedRoszPath
    )
      ? "opponent enriched artifact path"
      : null,
    !opponent ||
    opponent.summary.totalPoints !== expected.item.roster.totalPoints
      ? "opponent points"
      : null,
    !configuration ? "analysis configuration" : null,
    configuration && configuration.analysisMode !== expected.mode
      ? "analysis mode"
      : null,
    configuration &&
    JSON.stringify(configuration.phases) !==
      JSON.stringify(["shooting", "fight"])
      ? "phases"
      : null,
    configuration &&
    JSON.stringify(configuration.metrics) !==
      JSON.stringify(expected.metrics)
      ? "metrics"
      : null,
    configuration &&
    JSON.stringify(configuration.directions) !==
      JSON.stringify([
        "player-to-opponent",
        "opponent-to-player",
      ])
      ? "directions"
      : null,
    configuration?.pointsTolerancePercent !== 5
      ? "points tolerance"
      : null,
    configuration?.allowPointMismatch === true
      ? "point mismatch policy"
      : null,
    configuration &&
    configuration.includeChangeCandidates !==
      expected.includeChangeCandidates
      ? "change-candidate mode"
      : null,
    configuration &&
    (configuration.providerCompatibilityMode ?? "observe") !==
      expected.providerCompatibilityMode
      ? "provider compatibility mode"
      : null,
    report.simulation.requested !== expected.simulationRequested
      ? "simulation mode"
      : null,
    !report.simulation.experimental
      ? "legacy simulation compatibility flag"
      : null,
    expected.simulationRequested && report.status !== "complete"
      ? "simulation status"
      : null,
    report.status === "complete" &&
    report.source !==
      (expected.simulationBackend === "local-engine"
        ? "tessera-local-engine"
        : "tessera-ui")
      ? "simulation source"
      : null,
    expected.simulationRequested &&
    (report.simulation.selectedBackend ?? "website") !==
      expected.simulationBackend
      ? "simulation provider"
      : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new Error(
      `Stored stage report does not match the frozen execution: ${mismatches.join(", ")}.`,
    );
  }
  if (report.status === "complete") {
    const scenarioError = completeScenarioValidationError(
      report,
      expected,
    );
    if (scenarioError) {
      throw new Error(
        `Stored complete stage report failed scenario validation: ${scenarioError}.`,
      );
    }
  }
  return report;
}

function manualAnalysisConfiguration(
  metrics: TesseraMetric[],
  mode: "quick" | "full",
  providerCompatibilityMode: "observe" | "enforce",
): TesseraAnalysisConfiguration {
  return {
    analysisMode: mode,
    phases: ["shooting", "fight"],
    metrics,
    directions: ["player-to-opponent", "opponent-to-player"],
    pointsTolerancePercent: 5,
    allowPointMismatch: false,
    includeChangeCandidates: false,
    providerCompatibilityMode,
  };
}

function aggregateEvidenceSha256(
  values: Array<string | null>,
): string | null {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  const uniqueValues = [...new Set(values as string[])].sort();
  return uniqueValues.length === 1
    ? uniqueValues[0]
    : crypto
        .createHash("sha256")
        .update(canonicalJson(uniqueValues))
        .digest("hex");
}

function aggregateStressWebsiteProviderEvidence(
  captures: Array<{
    opponentName: string;
    evidence: TesseraWebsiteProviderEvidence;
  }>,
  expectedCount: number,
): TesseraWebsiteProviderEvidence | undefined {
  if (captures.length === 0) return undefined;
  if (captures.length === 1 && expectedCount === 1) {
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
      continue;
    }
    assetsByUrl.set(asset.url, structuredClone(asset));
  }

  const deploymentIdentities = evidences.map(
    (evidence) => evidence.deployment.identitySha256,
  );
  const deploymentComplete =
    captures.length === expectedCount &&
    !assetConflict &&
    evidences.every((evidence) => evidence.deployment.complete) &&
    new Set(deploymentIdentities).size === 1;
  const deploymentReasons = [
    ...(captures.length === expectedCount
      ? []
      : [`capture-count:${captures.length}/${expectedCount}`]),
    ...(assetConflict ? ["asset-digest-conflict"] : []),
    ...captures.flatMap((capture) =>
      capture.evidence.deployment.incompleteReasons.map(
        (reason) => `${capture.opponentName}:${reason}`,
      ),
    ),
  ];

  const playerHashes = evidences.map(
    (evidence) => evidence.importSemantics.playerSha256,
  );
  const opponentHashes = evidences.map(
    (evidence) => evidence.importSemantics.opponentSha256,
  );
  const playerSha256 = aggregateEvidenceSha256(playerHashes);
  const opponentSha256 = aggregateEvidenceSha256(opponentHashes);
  const playerHashStable = new Set(playerHashes).size === 1;
  const importComplete =
    captures.length === 1 &&
    captures.length === expectedCount &&
    playerHashStable &&
    evidences.every((evidence) => evidence.importSemantics.complete);
  const playerSnapshot = playerHashStable
    ? evidences[0].importSemantics.playerSnapshot
    : null;
  const importReasons = [
    ...(captures.length === expectedCount
      ? []
      : [`capture-count:${captures.length}/${expectedCount}`]),
    ...(playerHashStable ? [] : ["player-semantic-digest-conflict"]),
    ...(captures.length > 1
      ? [
          "multi-opponent-semantic-snapshots-retained-in-provider-evidence-captures",
        ]
      : []),
    ...captures.flatMap((capture) =>
      capture.evidence.importSemantics.incompleteReasons.map(
        (reason) => `${capture.opponentName}:${reason}`,
      ),
    ),
  ];

  return {
    schemaVersion: 1,
    deployment: {
      identitySha256: aggregateEvidenceSha256(deploymentIdentities),
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
        : evidences.some((evidence) =>
              ["complete", "partial"].includes(
                evidence.deployment.completeness,
              )
            )
          ? "partial"
          : evidences.some(
                (evidence) =>
                  evidence.deployment.completeness === "fallback",
              )
            ? "fallback"
            : "unavailable",
      declarationSha256: aggregateEvidenceSha256(
        evidences.map(
          (evidence) => evidence.deployment.declarationSha256,
        ),
      ),
      incompleteReasons: deploymentComplete
        ? []
        : [...new Set(deploymentReasons)].sort(),
    },
    importSemantics: {
      combinedSha256:
        playerSha256 && opponentSha256
          ? crypto
              .createHash("sha256")
              .update(
                canonicalJson({ playerSha256, opponentSha256 }),
              )
              .digest("hex")
          : null,
      playerSha256,
      opponentSha256,
      complete: importComplete,
      completeness: importComplete
        ? "complete"
        : evidences.some(
              (evidence) =>
                evidence.importSemantics.completeness !==
                "unavailable",
            )
          ? "partial"
          : "unavailable",
      unresolvedEffectCount: evidences.reduce(
        (total, evidence) =>
          total + evidence.importSemantics.unresolvedEffectCount,
        0,
      ),
      playerSnapshot: playerSnapshot
        ? structuredClone(playerSnapshot)
        : null,
      opponentSnapshot:
        captures.length === 1
          ? structuredClone(
              evidences[0].importSemantics.opponentSnapshot,
            )
          : null,
      incompleteReasons: importComplete
        ? []
        : [...new Set(importReasons)].sort(),
    },
  };
}

function compatibilityEnvelopesFromReports(
  reports: Array<TesseraMatchupReport | null | undefined>,
): TesseraProviderCompatibilityEnvelope[] {
  const envelopes = reports.flatMap((report) => {
    if (!report) return [];
    return [
      ...(report.providerCompatibilityEnvelopes ?? []),
      ...(report.providerCompatibility
        ? [report.providerCompatibility]
        : []),
    ];
  });
  return [
    ...new Map(
      envelopes.map((envelope) => [
        envelope.envelopeSha256,
        structuredClone(envelope),
      ]),
    ).values(),
  ].sort((left, right) =>
    left.envelopeSha256.localeCompare(right.envelopeSha256)
  );
}

function combineMatchupReports(
  reports: Map<string, TesseraMatchupReport>,
  preparedPlayer: TesseraPreparedRoster,
  preparedOpponents: Readonly<
    Record<string, ManifestPreparedOpponent>
  >,
  expectedCount: number,
  metrics: TesseraMetric[],
  mode: "quick" | "full",
  warnings: string[],
  frozenProfilePolicyHash: string | null,
  expectedScenarioContract: TesseraFrozenScenarioContract[] | null,
  providerCompatibilityMode: "observe" | "enforce",
): TesseraMatchupReport {
  const values = [...reports.values()];
  const configuration =
    values.find((report) => report.configuration)?.configuration ??
    manualAnalysisConfiguration(
      metrics,
      mode,
      providerCompatibilityMode,
    );
  const scenarios = values.flatMap(
    (report) => report.simulation.scenarios ?? [],
  );
  const matrices = values.flatMap(
    (report) => report.simulation.matrices,
  );
  const providerEvidenceCaptures = values.flatMap((report) => {
    if (report.simulation.providerEvidenceCaptures) {
      return report.simulation.providerEvidenceCaptures.map(
        (capture) => structuredClone(capture),
      );
    }
    if (
      report.simulation.providerEvidence &&
      report.opponents.length === 1
    ) {
      return [{
        opponentName: report.opponents[0].rosterName,
        evidence: structuredClone(
          report.simulation.providerEvidence,
        ),
      }];
    }
    return [];
  });
  const providerEvidence =
    aggregateStressWebsiteProviderEvidence(
      providerEvidenceCaptures,
      expectedCount,
    );
  const providerCompatibilityEnvelopes =
    compatibilityEnvelopesFromReports(values);
  const requestedBackends = new Set(
    values.map(
      (report) => report.simulation.requestedBackend ?? "website",
    ),
  );
  const selectedBackends = new Set(
    values.map(
      (report) => report.simulation.selectedBackend ?? "website",
    ),
  );
  const providerIdentities = new Map<
    string,
    TesseraSimulationProviderIdentity
  >();
  for (const report of values) {
    const identity =
      report.simulation.providerIdentity ??
      (report.tesseraUiIdentity
        ? {
            schemaVersion: 1 as const,
            provider: "website" as const,
            engine: "tessera-ui" as const,
            uiIdentity: report.tesseraUiIdentity,
            adapterVersion: "website-browser-v1",
          }
        : null);
    if (identity) providerIdentities.set(canonicalJson(identity), identity);
  }
  const requestedBackend =
    [...requestedBackends][0] as TesseraSimulationBackend | undefined;
  const selectedBackend =
    [...selectedBackends][0] as TesseraSimulationProvider | undefined;
  const providerIdentity = [...providerIdentities.values()][0];
  const providerConsistent =
    requestedBackends.size <= 1 &&
    selectedBackends.size <= 1 &&
    providerIdentities.size <= 1 &&
    (
      providerIdentity === undefined ||
      providerIdentity.provider === selectedBackend
    ) &&
    (
      selectedBackend !== "local-engine" ||
      providerIdentity?.provider === "local-engine"
    );
  const analyticalClaimsAllowed =
    simulationProviderAllowsAnalyticalClaims(
      selectedBackend,
      providerIdentity,
    );
  const legacyProjections = values.flatMap((report) =>
    report.simulation.legacyProjection
      ? [report.simulation.legacyProjection]
      : [],
  );
  const legacyProjection =
    legacyProjections.length === values.length &&
    legacyProjections.length > 0 &&
    legacyProjections.every(
      (projection) =>
        projection.status === "derived" &&
        projection.phase === legacyProjections[0].phase &&
        projection.metric === legacyProjections[0].metric,
    )
      ? {
          status: "derived" as const,
          phase: legacyProjections[0].phase,
          metric: legacyProjections[0].metric,
          scenarioIds: [
            ...new Set(
              legacyProjections.flatMap(
                (projection) => projection.scenarioIds,
              ),
            ),
          ],
        }
      : {
          status: "unavailable" as const,
          phase: null,
          metric: null,
          scenarioIds: [],
        };
  const simulationRequested = values.some(
    (report) => report.simulation.requested,
  );
  const preparedReceipts = [
    ...new Map(
      values
        .flatMap((report) => [
          report.player,
          ...report.opponents.map((opponent) => ({
            ...opponent,
            rosterId:
              opponent.fingerprint ??
              `${opponent.rosterName}:${opponent.enrichedRoszPath}`,
          })),
        ])
        .map((receipt) => [receipt.rosterId, receipt] as const),
    ).values(),
  ];
  const cacheReuses = preparedReceipts.filter(
    (receipt) => receipt.cacheReused === true,
  ).length;
  const failures = [
    ...new Map(
      values
        .flatMap((report) => report.failures ?? [])
        .map(
          (failure) =>
            [
              [
                failure.stage,
                failure.code,
                failure.opponentName ?? "",
                failure.message,
              ].join(":"),
              failure,
            ] as const,
        ),
    ).values(),
  ];
  if (!providerConsistent) {
    failures.push({
      stage: "simulation",
      code: "TESSERA_SIMULATION_PROVIDER_DRIFT",
      message:
        "The stored stage reports do not share one frozen simulation provider identity.",
      opponentName: null,
      retryable: false,
    });
  }
  const childScenarioContracts = values.map((report) => {
    let observedContract: TesseraFrozenScenarioContract[] | null = null;
    let valid = true;
    const reportScenarios = report.simulation.scenarios ?? [];
    try {
      if (simulationRequested && reportScenarios.length > 0) {
        observedContract = observedTesseraScenarioContract(
          reportScenarios,
          configuration.phases,
          configuration.metrics,
        );
      }
    } catch (error) {
      valid = false;
      failures.push({
        stage: "simulation",
        code: "TESSERA_SCENARIO_CONTRACT_MISMATCH",
        message:
          error instanceof Error
            ? error.message
            : "A stored stage report has no canonical scenario contract.",
        opponentName: report.opponents[0]?.rosterName ?? null,
        retryable: false,
      });
    }
    let declaredContract: TesseraFrozenScenarioContract[] | null = null;
    try {
      declaredContract = report.scenarioContract
        ? canonicalTesseraScenarioContract(report.scenarioContract)
        : null;
    } catch (error) {
      valid = false;
      failures.push({
        stage: "simulation",
        code: "TESSERA_SCENARIO_CONTRACT_MISMATCH",
        message:
          error instanceof Error
            ? error.message
            : "A stored stage report declares an invalid scenario contract.",
        opponentName: report.opponents[0]?.rosterName ?? null,
        retryable: false,
      });
    }
    const declaredHash = report.scenarioContractSha256 ??
      (declaredContract
        ? tesseraScenarioContractSha256(declaredContract)
        : null);
    const observedHash = observedContract
      ? tesseraScenarioContractSha256(observedContract)
      : null;
    if (
      declaredHash !== null &&
      observedHash !== null &&
      declaredHash !== observedHash
    ) {
      valid = false;
      failures.push({
        stage: "simulation",
        code: "TESSERA_SCENARIO_CONTRACT_MISMATCH",
        message:
          "A stored stage report's declared scenario-contract hash does not match its observed metric runs.",
        opponentName: report.opponents[0]?.rosterName ?? null,
        retryable: false,
      });
    }
    return {
      contract: declaredContract ?? observedContract,
      hash: declaredHash ?? observedHash,
      valid,
    };
  });
  const expectedCanonicalContract = expectedScenarioContract
    ? canonicalTesseraScenarioContract(expectedScenarioContract)
    : null;
  const expectedScenarioContractHash = expectedCanonicalContract
    ? tesseraScenarioContractSha256(expectedCanonicalContract)
    : null;
  const resolvedChildContracts =
    childScenarioContracts.length === values.length &&
    childScenarioContracts.every(
      (contract) => contract.valid && contract.hash !== null,
    );
  const childScenarioContractHashes = new Set(
    childScenarioContracts.flatMap((contract) =>
      contract.hash ? [contract.hash] : [],
    ),
  );
  const scenarioContractConsistent =
    !simulationRequested ||
    (
      resolvedChildContracts &&
      (
        expectedScenarioContractHash === null ||
        childScenarioContracts.every(
          (contract) =>
            contract.hash === expectedScenarioContractHash,
        )
      )
    );
  const sharedObservedContract =
    expectedCanonicalContract ??
    (
      resolvedChildContracts &&
      childScenarioContractHashes.size === 1
        ? childScenarioContracts.find(
            (contract) => contract.contract !== null,
          )?.contract ?? null
        : null
    );
  const scenarioContractHash = sharedObservedContract
    ? tesseraScenarioContractSha256(sharedObservedContract)
    : null;
  const complete =
    values.length === expectedCount &&
    providerConsistent &&
    scenarioContractConsistent &&
    values.every((report) =>
      simulationRequested
        ? report.status === "complete"
        : report.status === "prepared" ||
          report.status === "complete",
    );
  return {
    schemaVersion: 3,
    runId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    source: simulationRequested
      ? matrices.length > 0
        ? selectedBackend === "local-engine"
          ? "tessera-local-engine"
          : "tessera-ui"
        : selectedBackend === "local-engine"
          ? "tessera-local-engine-failed"
          : "tessera-ui-failed"
      : "prepare-only",
    status: complete
      ? simulationRequested
        ? "complete"
        : "prepared"
      : simulationRequested
        ? matrices.length > 0
          ? "inconclusive"
          : "failed"
        : "failed",
    preparation: {
      status:
        preparedReceipts.length === 1 + values.length
          ? "complete"
          : "failed",
      source:
        selectedBackend === "local-engine"
          ? "rosterpilot-data-bundle"
          : "new-recruit",
      uniqueRosters: preparedReceipts.length,
      remoteMutations:
        selectedBackend === "local-engine"
          ? 0
          : Math.max(
              0,
              preparedReceipts.length - cacheReuses,
            ),
      cacheReuses:
        selectedBackend === "local-engine" ? 0 : cacheReuses,
      connectorEvents: preparedReceipts.flatMap(
        (receipt) => receipt.connectorEvents ?? [],
      ),
    },
    failures,
    profilePolicyHash: frozenProfilePolicyHash,
    scenarioContract: sharedObservedContract,
    scenarioContractSha256: scenarioContractHash,
    runtime: getRuntimeProvenance(),
    tesseraUiIdentity:
      [...new Set(values.flatMap((report) =>
        report.tesseraUiIdentity ? [report.tesseraUiIdentity] : [],
      ))].sort().join("|") || null,
    connectorEvents: values.flatMap(
      (report) => report.connectorEvents ?? [],
    ),
    providerCompatibility:
      providerCompatibilityEnvelopes.length === 1
        ? providerCompatibilityEnvelopes[0]
        : undefined,
    providerCompatibilityEnvelopes:
      providerCompatibilityEnvelopes.length > 0
        ? providerCompatibilityEnvelopes
        : undefined,
    pinnedData: values.find((report) => report.pinnedData)?.pinnedData,
    comparisonClass: values.every(
      (report) => report.comparisonClass !== "unmatched",
    )
      ? "matched"
      : "unmatched",
    configuration,
    pointsComparisons: values.flatMap(
      (report) => report.pointsComparisons ?? [],
    ),
    player: preparedPlayer,
    opponents: [...reports.entries()].flatMap(
      ([templateId, report]) =>
        report.opponents.map((opponent) => {
          const frozen =
            preparedOpponents[templateId]?.prepared;
          if (!frozen) return opponent;
          return {
            ...opponent,
            sourceRoszPath: frozen.sourceRoszPath,
            enrichedRoszPath: frozen.enrichedRoszPath,
            enrichedRoszSha256:
              frozen.enrichedRoszSha256 ??
              opponent.enrichedRoszSha256,
          };
        }),
    ),
    simulation: {
      requested: simulationRequested,
      executionMode: simulationRequested
        ? "simulate"
        : "prepare-only",
      experimental: true,
      status: !simulationRequested
        ? "not-requested"
        : complete
          ? "complete"
          : matrices.length > 0
            ? "partial"
            : "failed",
      requestedBackend,
      selectedBackend,
      providerIdentity,
      providerEvidence,
      providerEvidenceCaptures:
        providerEvidenceCaptures.length > 0
          ? providerEvidenceCaptures
          : undefined,
      fallback: null,
      engine:
        selectedBackend === "local-engine"
          ? "tessera-engine"
          : "tessera-ui",
      settings: Object.assign(
        {},
        ...values.map((report) => report.simulation.settings),
      ),
      legacyProjection,
      matrices,
      scenarios,
    },
    strengths: analyticalClaimsAllowed
      ? unique(values.flatMap((report) => report.strengths))
      : [],
    weaknesses: analyticalClaimsAllowed
      ? unique(values.flatMap((report) => report.weaknesses))
      : [],
    suggestions: analyticalClaimsAllowed
      ? unique(values.flatMap((report) => report.suggestions))
      : [],
    findings: analyticalClaimsAllowed
      ? [
          ...new Map(
            values
              .flatMap((report) => report.findings ?? [])
              .map(
                (finding) => [finding.findingId, finding] as const,
              ),
          ).values(),
        ]
      : [],
    changeCandidates: analyticalClaimsAllowed
      ? [
          ...new Map(
            values
              .flatMap((report) => report.changeCandidates ?? [])
              .map(
                (candidate) =>
                  [candidate.candidateId, candidate] as const,
              ),
          ).values(),
        ]
      : [],
    limitations: unique(
      values.flatMap((report) => report.limitations),
    ),
    warnings: unique([
      ...warnings,
      ...values.flatMap((report) => report.warnings),
      ...(analyticalClaimsAllowed
        ? []
        : [
            "Local tessera-engine evidence was retained for evaluation, but analytical and coaching claims were suppressed until the provider is both approved and promoted.",
          ]),
    ]),
    artifacts: [],
  };
}

function stageProvenance(
  report: TesseraMatchupReport,
  mode: "quick" | "full",
  metrics: TesseraMetric[],
  childReports: Map<string, TesseraMatchupReport>,
  frozenProfilePolicyHash: string | null,
): TesseraStressStageProvenance {
  const sortedSettings = (
    values: Record<string, string>,
  ): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  const reportIterations = (
    value: TesseraMatchupReport,
  ): number[] => [
    ...new Set(
      (value.simulation.scenarios ?? [])
        .flatMap((scenario) =>
          scenario.metricRuns?.length
            ? scenario.metricRuns.map(
                (metricRun) => metricRun.iterations,
              )
            : [scenario.iterations]
        )
        .filter(
          (value): value is number =>
            value !== null && Number.isInteger(value) && value > 0,
        ),
    ),
  ].sort((left, right) => left - right);
  const settings = sortedSettings(report.simulation.settings);
  const iterations = reportIterations(report);
  return {
    analysisMode: mode,
    phases: ["shooting", "fight"],
    metrics,
    directions: ["player-to-opponent", "opponent-to-player"],
    settings,
    iterations,
    profilePolicyHash: frozenProfilePolicyHash,
    proxyRuns: [...childReports.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([templateId, child]) => ({
        templateId,
        settings: sortedSettings(child.simulation.settings),
        iterations: reportIterations(child),
        scenarios: [...(child.simulation.scenarios ?? [])]
          .flatMap((scenario) =>
            (scenario.metricRuns ?? []).map((metricRun) => ({
              phase: scenario.phase,
              metric: metricRun.metric,
              direction: scenario.direction,
              settings: sortedSettings(metricRun.settings),
              iterations: metricRun.iterations,
              matrixSha256: metricRun.matrixSha256,
            })),
          )
          .sort(
            (left, right) =>
              left.phase.localeCompare(right.phase) ||
              left.direction.localeCompare(right.direction) ||
              left.metric.localeCompare(right.metric),
          ),
      })),
  };
}

function pairedStageExecutionContract(
  provenance: TesseraStressTestReport["stageProvenance"],
): unknown {
  const withoutObservedMatrixContent = (
    stage: TesseraStressStageProvenance | null,
  ) =>
    stage === null
      ? null
      : {
          ...stage,
          proxyRuns: stage.proxyRuns.map((run) => ({
            ...run,
            scenarios: run.scenarios.map((scenario) => ({
              phase: scenario.phase,
              metric: scenario.metric,
              direction: scenario.direction,
              settings: scenario.settings,
              iterations: scenario.iterations,
            })),
          })),
        };
  return {
    screening: withoutObservedMatrixContent(
      provenance.screening,
    ),
    deepDive: withoutObservedMatrixContent(provenance.deepDive),
  };
}

function stressReportHasVerifiedMatrixIntegrity(
  report: TesseraStressTestReport,
): boolean {
  const stages = [
    report.stageProvenance.screening,
    report.stageProvenance.deepDive,
  ].filter(
    (stage): stage is TesseraStressStageProvenance =>
      stage !== null,
  );
  return (
    report.integrity.status === "verified" &&
    stages.every((stage) =>
      stage.proxyRuns.every((run) =>
        run.scenarios.every((scenario) =>
          /^[0-9a-f]{64}$/.test(
            scenario.matrixSha256 ?? "",
          ),
        ),
      ),
    )
  );
}

function stageDirectoryName(templateId: string): string {
  return safeName(templateId) || "proxy";
}

async function ensurePreparedOpponents(
  input: StressExecutionInput,
  items: Array<
    TesseraStressPortfolioItem & { roster: RosterDraftV1 }
  >,
  delivery: ReturnType<typeof createDeliveryCache>,
): Promise<PreparedOpponentsResult> {
  if (input.opponentRoszPaths) {
    return {
      ok: true,
      data: true,
      violations: [],
      warnings: [],
    };
  }
  for (const item of items) {
    const receipt =
      input.manifest.preparedOpponents[item.templateId];
    if (receipt) {
      const present =
        (await pathExists(receipt.prepared.sourceRoszPath)) &&
        (await pathExists(receipt.prepared.enrichedRoszPath));
      const digest = present
        ? await fileSha256(receipt.prepared.enrichedRoszPath)
        : null;
      if (!present || digest !== receipt.sha256) {
        delete input.manifest.preparedOpponents[
          item.templateId
        ];
        return {
          ok: false,
          data: null,
          violations: [
            issue(
              "TESSERA_STRESS_PREPARED_OPPONENT_CHANGED",
              `The manifest-owned prepared artifact for ${item.templateId} is missing or changed. Start a new run instead of creating a duplicate external list.`,
            ),
          ],
          warnings: [],
          failureContext: {
            side: "opponent",
            templateId: item.templateId,
            rosterName: item.roster.name,
            partialPrepared: receipt.prepared,
          },
        };
      }
      continue;
    }
    if (
      input.manifest.selectedSimulationBackend !== "local-engine" &&
      input.manifest.opponentPreparationStartedAt[item.templateId]
    ) {
      return {
        ok: false,
        data: null,
        violations: [
          issue(
            "TESSERA_STRESS_DELIVERY_OUTCOME_UNKNOWN",
            `A prior New Recruit delivery for ${item.templateId} started but no verified receipt was persisted. Resume will not risk creating a duplicate list; inspect the external account and start a new run when safe.`,
          ),
        ],
        warnings: [],
        failureContext: {
          side: "opponent",
          templateId: item.templateId,
          rosterName: item.roster.name,
          partialPrepared: null,
        },
      };
    }
    const opponentPreparationStartedAt = new Date().toISOString();
    if (input.manifest.selectedSimulationBackend !== "local-engine") {
      input.manifest.opponentPreparationStartedAt[item.templateId] =
        opponentPreparationStartedAt;
      try {
        await writeManifest(
          input.manifest,
          input.manifestPath,
          input.options,
          true,
        );
      } catch (error) {
        return {
          ok: false,
          data: null,
          violations: [
            issue(
              "WRITE_FAILED",
              error instanceof Error
                ? error.message
                : "The opponent delivery marker could not be persisted.",
            ),
          ],
          warnings: [],
          failureContext: {
            side: "opponent",
            templateId: item.templateId,
            rosterName: item.roster.name,
            partialPrepared: null,
          },
        };
      }
    }
    const prepared = await prepareRosterForTessera(
      item.roster,
      {
        ...input.options,
        simulationBackend:
          input.manifest.selectedSimulationBackend,
        profilePolicy: input.manifest.profilePolicy,
        mutationRunId: input.manifest.runId,
        outputDirectory: path.join(
          input.outputDirectory,
          "stress-runs",
          input.manifest.runId,
          "prepared-opponents",
          stageDirectoryName(item.templateId),
        ),
        overwrite: input.options.overwrite,
      },
      delivery.dependencies,
    );
    if (!prepared.ok || !prepared.data) {
      return {
        ok: false,
        data: null,
        violations: prepared.violations,
        warnings: prepared.warnings,
        failureContext: {
          side: "opponent",
          templateId: item.templateId,
          rosterName: item.roster.name,
          partialPrepared: prepared.data,
        },
      };
    }
    try {
      const receiptValue: ManifestPreparedOpponent = {
        prepared: prepared.data,
        sha256: await fileSha256(
          prepared.data.enrichedRoszPath,
        ),
      };
      input.manifest.preparedOpponents[item.templateId] =
        receiptValue;
      delete input.manifest.opponentPreparationStartedAt[
        item.templateId
      ];
      await writeManifest(
        input.manifest,
        input.manifestPath,
        input.options,
        true,
      );
    } catch (error) {
      delete input.manifest.preparedOpponents[
        item.templateId
      ];
      if (input.manifest.selectedSimulationBackend !== "local-engine") {
        input.manifest.opponentPreparationStartedAt[
          item.templateId
        ] = opponentPreparationStartedAt;
      }
      return {
        ok: false,
        data: null,
        violations: [
          issue(
            "WRITE_FAILED",
            error instanceof Error
              ? error.message
              : "The verified opponent delivery receipt could not be persisted.",
          ),
        ],
        warnings: [],
        failureContext: {
          side: "opponent",
          templateId: item.templateId,
          rosterName: item.roster.name,
          partialPrepared: prepared.data,
        },
      };
    }
  }
  return {
    ok: true,
    data: true,
    violations: [],
    warnings: [],
  };
}

async function frozenOpponentArtifacts(
  input: StressExecutionInput,
  items: Array<
    TesseraStressPortfolioItem & { roster: RosterDraftV1 }
  >,
): Promise<TesseraStressFrozenOpponentArtifact[]> {
  return Promise.all(
    items.map(async (item) => {
      const receipt =
        input.manifest.preparedOpponents[item.templateId];
      const filename =
        receipt?.prepared.enrichedRoszPath ??
        input.opponentRoszPaths?.get(item.templateId);
      if (!filename) {
        throw new Error(
          `No frozen opponent artifact was recorded for ${item.templateId}.`,
        );
      }
      return {
        templateId: item.templateId,
        rosterFingerprint: rosterExecutionFingerprint(item.roster),
        enrichedRoszPath: filename,
        sha256: receipt?.sha256 ?? (await fileSha256(filename)),
      };
    }),
  );
}

const TRANSIENT_TESSERA_CODES = new Set([
  "LOCAL_AGENT_TIMEOUT",
  "LOCAL_AGENT_UNAVAILABLE",
  "TESSERA_BROWSER_UNAVAILABLE",
  "TESSERA_BROWSER_TIMEOUT",
  "TESSERA_BROWSER_SESSION_CLOSED",
  "TESSERA_BROWSER_NAVIGATION_FAILED",
  "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
  "TESSERA_PREMIUM_STILL_LOCKED",
  "TESSERA_MATRIX_MISSING",
  "TESSERA_MATRIX_STALE",
  "TESSERA_STALE_MATRIX",
  "TESSERA_INCOMPLETE_MATRIX",
  "TESSERA_SCENARIOS_INCOMPLETE",
  "TESSERA_EVIDENCE_INCOMPLETE",
  "TESSERA_PHASE_MATRIX_ALIAS",
  "TESSERA_METRIC_MATRIX_ALIAS",
  "TESSERA_PROXY_MATRIX_ALIAS",
  "TESSERA_MATRIX_FINGERPRINT_MISSING",
]);

const LIVE_READINESS_FAILURE_CODES = new Set([
  "LOCAL_AGENT_TIMEOUT",
  "LOCAL_AGENT_UNAVAILABLE",
  "TESSERA_BROWSER_UNAVAILABLE",
  "TESSERA_BROWSER_TIMEOUT",
  "TESSERA_BROWSER_SESSION_CLOSED",
  "TESSERA_BROWSER_NAVIGATION_FAILED",
  "TESSERA_COMPANION_FAILED",
  "TESSERA_COMPANION_UNAVAILABLE",
  "TESSERA_WORKER_PROTOCOL_ERROR",
  "TESSERA_WORKER_SESSION_MISMATCH",
  "TESSERA_PREMIUM_KEY_ABSENT",
  "TESSERA_PREMIUM_KEY_REJECTED",
  "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
  "TESSERA_PREMIUM_STILL_LOCKED",
  "TESSERA_ORIGIN_MISMATCH",
  "TESSERA_UI_CHANGED",
]);

const GLOBAL_STAGE_FAILURE_CODES = new Set([
  ...LIVE_READINESS_FAILURE_CODES,
  "TESSERA_SETTINGS_CHANGED",
  "TESSERA_SETTINGS_REPLAY_FAILED",
  "TESSERA_SETTINGS_PROVENANCE_MISSING",
]);

const PLAYER_SCOPED_GLOBAL_FAILURE_CODES = new Set([
  "TESSERA_PROFILE_EDITOR_MISMATCH",
  "TESSERA_PROFILE_POLICY_APPLICATION_FAILED",
  "TESSERA_PROFILE_POLICY_REQUIRED",
  "TESSERA_LIST_SELECTION_MISMATCH",
]);

function isGlobalStageFailure(
  error: NonNullable<ManifestStageEntry["error"]>,
): boolean {
  return (
    GLOBAL_STAGE_FAILURE_CODES.has(error.code) ||
    (
      PLAYER_SCOPED_GLOBAL_FAILURE_CODES.has(error.code) &&
      error.message.includes("[TESSERA_IMPORT_SIDE=player]")
    )
  );
}

function structuredStageError(
  code: string,
  message: string,
): NonNullable<ManifestStageEntry["error"]> {
  return {
    code,
    message,
    retryable: TRANSIENT_TESSERA_CODES.has(code),
  };
}

function retryLimit(
  input: StressExecutionInput,
): number {
  if (input.options.retryOwner === "durable-job") {
    return Math.min(
      5,
      Math.max(
        1,
        input.options.durableAttemptNumber ?? 1,
      ),
    );
  }
  return input.resumed ? 5 : 3;
}

function exhaustedRetryAction(): string {
  return "The five-attempt lifetime budget is exhausted. Inspect the attempt history, then use --restart-from to create a clean run that can reuse verified prepared artifacts.";
}

function stageNextAction(
  entry: ManifestStageEntry,
): string | null {
  if (!entry.error) return null;
  if (entry.attemptCount >= 5) return exhaustedRetryAction();
  if (!entry.error.retryable) {
    return "Resolve the terminal error, then explicitly resume with --force-retry.";
  }
  return "Resume this run to retry the incomplete proxy without repeating verified New Recruit preparation.";
}

function retryDelay(attemptWithinTurn: number): number {
  return attemptWithinTurn <= 1 ? 1_000 : 3_000;
}

function sortedScenarioContract(
  contract: TesseraFrozenScenarioContract[],
): TesseraFrozenScenarioContract[] {
  return contract
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

function scenarioContractFromReport(
  report: TesseraMatchupReport,
  metrics: TesseraMetric[],
): {
  contract: TesseraFrozenScenarioContract[] | null;
  error: string | null;
} {
  const entries = (report.simulation.scenarios ?? []).flatMap(
    (scenario) =>
      (scenario.metricRuns ?? []).map((metricRun) => ({
        phase: scenario.phase,
        direction: scenario.direction,
        metric: metricRun.metric,
        settings: metricRun.settings,
        iterations: metricRun.iterations,
      })),
  );
  const expectedKeys = new Set(
    ["shooting", "fight"].flatMap((phase) =>
      ["player-to-opponent", "opponent-to-player"].flatMap(
        (direction) =>
          metrics.map(
            (metric) => `${phase}:${direction}:${metric}`,
          ),
      ),
    ),
  );
  const actualKeys = entries.map(
    (entry) =>
      `${entry.phase}:${entry.direction}:${entry.metric}`,
  );
  if (
    entries.length !== expectedKeys.size ||
    new Set(actualKeys).size !== entries.length ||
    actualKeys.some((key) => !expectedKeys.has(key)) ||
    entries.some(
      (entry) =>
        entry.iterations === null ||
        !Number.isInteger(entry.iterations) ||
        entry.iterations <= 0,
    )
  ) {
    return {
      contract: null,
      error:
        "The completed stage report does not contain one exact settings and iteration contract for every requested scenario.",
    };
  }
  return {
    contract: sortedScenarioContract(entries),
    error: null,
  };
}

function freezeOrValidateStageContract(
  manifest: TesseraStressManifest,
  stage: "screening" | "deepDive",
  templateId: string,
  report: TesseraMatchupReport,
  metrics: TesseraMetric[],
): {
  changed: boolean;
  code: string | null;
  message: string | null;
} {
  if (!manifest.simulationRequested) {
    return { changed: false, code: null, message: null };
  }
  const observed = scenarioContractFromReport(report, metrics);
  if (!observed.contract) {
    return {
      changed: false,
      code: "TESSERA_SETTINGS_PROVENANCE_MISSING",
      message:
        observed.error ??
        "The stage report does not retain exact Tessera settings provenance.",
    };
  }
  const frozen = stageContractFor(
    manifest,
    stage,
    templateId,
  );
  if (frozen === null) {
    manifest.stageContracts[stage][templateId] =
      observed.contract;
    return { changed: true, code: null, message: null };
  }
  if (
    canonicalJson(sortedScenarioContract(frozen)) !==
    canonicalJson(observed.contract)
  ) {
    return {
      changed: false,
      code: "TESSERA_SETTINGS_CHANGED",
      message:
        `The ${stage === "deepDive" ? "deep-dive" : "screening"} capture did not reproduce the exact frozen Tessera settings and iteration counts.`,
    };
  }
  return { changed: false, code: null, message: null };
}

async function runStage(
  input: StressExecutionInput,
  stage: "screening" | "deepDive",
  items: TesseraStressPortfolioItem[],
  metrics: TesseraMetric[],
  mode: "quick" | "full",
  delivery: ReturnType<typeof createDeliveryCache>,
): Promise<StageRunResult> {
  const reports = new Map<string, TesseraMatchupReport>();
  const warnings: string[] = [];
  const stageManifest = input.manifest[stage];
  for (const item of items) {
    if (!item.roster || item.status !== "ready") continue;
    const entry =
      stageManifest[item.templateId] ??
      newStageEntry();
    stageManifest[item.templateId] = entry;
    if (
      stageEntryIsReusable(
        entry,
        input.manifest.simulationRequested,
      ) &&
      entry.reportPath !== null &&
      entry.reportSha256 !== null &&
      (await pathExists(entry.reportPath))
    ) {
      try {
        if (!input.manifest.preparedPlayer) {
          throw new Error(
            "The manifest has no prepared player receipt.",
          );
        }
        if (
          (await fileSha256(entry.reportPath)) !==
          entry.reportSha256
        ) {
          throw new Error(
            "The stored child report content hash changed.",
          );
        }
        const report = await readMatchupReport(entry.reportPath, {
          player: input.manifest.preparedPlayer,
          item: { ...item, roster: item.roster },
          metrics,
          mode,
          simulationRequested:
            input.manifest.simulationRequested,
          simulationBackend:
            input.manifest.selectedSimulationBackend,
          providerCompatibilityMode:
            input.manifest.configuration.providerCompatibilityMode,
          includeChangeCandidates: stage === "screening",
          opponentEnrichedRoszPath:
            input.manifest.preparedOpponents[item.templateId]
              ?.prepared.enrichedRoszPath,
        });
        const contract = freezeOrValidateStageContract(
          input.manifest,
          stage,
          item.templateId,
          report,
          metrics,
        );
        if (contract.code) {
          throw Object.assign(
            new Error(
              contract.message ??
                "The stored stage report does not match the frozen Tessera settings.",
            ),
            { code: contract.code },
          );
        }
        if (contract.changed) {
          await writeManifest(
            input.manifest,
            input.manifestPath,
            input.options,
            true,
          );
        }
        reports.set(item.templateId, report);
        const opponent = preparedOpponent(report, item);
        if (opponent) await delivery.seed(item.roster, opponent);
        continue;
      } catch (error) {
        entry.status = "pending";
        entry.reportSha256 = null;
        entry.error = structuredStageError(
          error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
            ? error.code
            : "TESSERA_STORED_REPORT_INVALID",
          error instanceof Error ? error.message : "Stored report is invalid.",
        );
        entry.nextAction =
          "Re-run this stage to replace the invalid local report.";
      }
    }

    if (
      entry.error &&
      !entry.error.retryable &&
      !input.options.forceRetry
    ) {
      entry.nextAction =
        "Resolve the terminal error, then resume with --force-retry.";
      warnings.push(
        `${item.templateId}: ${entry.error.message} ${entry.nextAction}`,
      );
      if (isGlobalStageFailure(entry.error)) break;
      continue;
    }
    if (
      entry.attemptCount >= retryLimit(input)
    ) {
      entry.nextAction =
        entry.attemptCount >= 5
          ? exhaustedRetryAction()
          : "The automatic retry budget for this invocation is exhausted. Resume the same manifest for up to five lifetime attempts.";
      warnings.push(
        `${item.templateId}: ${entry.nextAction}`,
      );
      if (
        entry.error &&
        isGlobalStageFailure(entry.error)
      ) break;
      continue;
    }

    const opponentPath = input.opponentRoszPaths?.get(item.templateId);
    const opponent: TesseraOpponentInput = opponentPath
      ? { kind: "rosz", path: opponentPath }
      : { kind: "roster", roster: item.roster };
    const preparedReuse = (() => {
      if (
        input.manifest.selectedSimulationBackend !== "local-engine"
      ) {
        return undefined;
      }
      const player = input.manifest.preparedPlayer;
      const preparedOpponent =
        input.manifest.preparedOpponents[item.templateId]?.prepared;
      if (!player || !preparedOpponent) {
        throw artifactMaterializationError(
          "TESSERA_STRESS_BUNDLE_ARTIFACT_MISSING",
          `The frozen local-engine prepared receipt for ${item.templateId} is missing before ${stage} execution.`,
        );
      }
      return {
        player,
        opponent: preparedOpponent,
        sourceAttempt: 1,
      };
    })();
    let result: Awaited<ReturnType<typeof analyzeRosterMatchup>> | null = null;
    let lastCode: string | null = null;
    let attemptWithinTurn = 0;
    const maximumAttempts = retryLimit(input);
    while (entry.attemptCount < maximumAttempts) {
      attemptWithinTurn += 1;
      const attemptedAt = new Date().toISOString();
      entry.attemptCount += 1;
      entry.firstAttemptAt ??= attemptedAt;
      entry.lastAttemptAt = attemptedAt;
      entry.nextAction = null;
      await writeManifest(
        input.manifest,
        input.manifestPath,
        input.options,
        true,
      );
      result = await analyzeRosterMatchup(
        input.playerRoster,
        opponent,
        {
          ...input.options,
          outputDirectory: path.join(
            input.outputDirectory,
            "stress-runs",
            input.manifest.runId,
            stage === "screening" ? "screening" : "deep-dive",
            stageDirectoryName(item.templateId),
          ),
          overwrite:
            input.resumed ||
            input.options.overwrite ||
            attemptWithinTurn > 1,
          executionMode: input.manifest.simulationRequested
            ? "simulate"
            : "prepare-only",
          simulationBackend:
            input.manifest.selectedSimulationBackend,
          providerCompatibilityMode:
            input.manifest.configuration.providerCompatibilityMode,
          experimental: input.options.experimental,
          analysisMode: mode,
          phases: ["shooting", "fight"],
          metrics,
          frozenProfileRequirements:
            scopedProfileRequirements(
              [input.playerRoster, item.roster],
              input.manifest.enrichedProfileRequirements,
            ),
          profilePolicyPath: undefined,
          profilePolicy: scopedProfilePolicy(
            input.manifest.profilePolicy,
            scopedProfileRequirements(
              [input.playerRoster, item.roster],
              input.manifest.enrichedProfileRequirements,
            ),
          ),
          opponentRosterContext: item.roster,
          scenarioContract: undefined,
          ...(preparedReuse ? { preparedReuse } : {}),
          frozenScenarioContract:
            stageContractFor(
              input.manifest,
              stage,
              item.templateId,
            ),
          sessionId: input.manifest.runId,
          allowPointMismatch: false,
          includeChangeCandidates: stage === "screening",
        },
        delivery.dependencies,
      );
      const exactContractMismatch = result.violations.some(
        (violation) =>
          violation.code === "TESSERA_SCENARIO_CONTRACT_MISMATCH",
      );
      const contract =
        input.manifest.simulationRequested &&
        result.data &&
        (
          (result.ok && result.data.status === "complete") ||
          exactContractMismatch
        )
          ? freezeOrValidateStageContract(
              input.manifest,
              stage,
              item.templateId,
              result.data,
              metrics,
            )
          : {
              changed: false,
              code: null,
              message: null,
            };
      if (contract.changed) {
        await writeManifest(
          input.manifest,
          input.manifestPath,
          input.options,
          true,
        );
      }
      const warningCodes = unique(
        (result.data?.warnings ?? []).flatMap((warning) => {
          const matched = warning.match(
            /\[(TESSERA_[A-Z0-9_]+)\]/,
          )?.[1];
          return matched ? [matched] : [];
        }),
      ).filter(
        (warningCode) =>
          warningCode !== "TESSERA_PROFILE_POLICY_APPLIED",
      );
      const code =
        contract.code ??
        (result.ok &&
        result.data &&
        (
          result.data.status === "complete" ||
          (!input.manifest.simulationRequested &&
            result.data.status === "prepared")
        )
          ? null
          : result.violations[0]?.code ??
            warningCodes.find((warningCode) =>
              TRANSIENT_TESSERA_CODES.has(warningCode),
            ) ??
            warningCodes[0] ??
            (result.data
              ? "TESSERA_SCENARIOS_INCOMPLETE"
              : "TESSERA_STAGE_FAILED"));
      lastCode = code;
      const attemptMessage =
        code === null
          ? null
          : contract.message ??
            result.violations[0]?.message ??
            result.data?.warnings.find((warning) =>
              warning.includes(`[${code}]`),
            ) ??
            (
              result.data
                ? "Tessera did not capture every requested scenario."
                : `The ${stage} stage did not produce a reusable report.`
            );
      const attemptError =
        code === null
          ? null
          : structuredStageError(
              code,
              attemptMessage ?? "The Tessera stage failed.",
            );
      entry.attemptHistory.push({
        attempt: entry.attemptCount,
        startedAt: attemptedAt,
        completedAt: new Date().toISOString(),
        outcome:
          code === null
            ? "complete"
            : result.data
              ? "partial"
              : "failed",
        error: attemptError,
      });
      entry.error = attemptError;
      entry.nextAction = stageNextAction(entry);
      await writeManifest(
        input.manifest,
        input.manifestPath,
        input.options,
        true,
      );
      if (code === null || !TRANSIENT_TESSERA_CODES.has(code)) break;
      if (entry.attemptCount >= maximumAttempts) break;
      await (
        input.dependencies.wait ??
        ((milliseconds: number) =>
          new Promise<void>((resolve) =>
            setTimeout(resolve, milliseconds),
          ))
      )(retryDelay(attemptWithinTurn));
    }
    if (!result) {
      warnings.push(
        `${item.templateId}: no attempt was allowed by the frozen retry budget.`,
      );
      continue;
    }
    if (result.data) {
      reports.set(item.templateId, result.data);
      const opponentPrepared = preparedOpponent(result.data, item);
      if (opponentPrepared) {
        await delivery.seed(item.roster, opponentPrepared);
      }
    }
    const reportPath =
      result.data?.artifacts.find(
        (artifact) => artifact.format === "matchup-json",
      )?.written ?? null;
    if (result.ok && result.data && reportPath) {
      entry.status =
        (
          result.data.status === "complete" ||
          (!input.manifest.simulationRequested &&
            result.data.status === "prepared")
        ) &&
        lastCode === null
          ? "complete"
          : "partial";
      entry.reportPath = reportPath;
      entry.reportSha256 = await fileSha256(reportPath);
      entry.error =
        lastCode === null ||
        !input.manifest.simulationRequested
          ? null
          : structuredStageError(
              lastCode ?? "TESSERA_SCENARIOS_INCOMPLETE",
              result.data.warnings.find((warning) =>
                lastCode
                  ? warning.includes(`[${lastCode}]`)
                  : false,
              ) ?? "Tessera did not capture every requested scenario.",
            );
      entry.nextAction = stageNextAction(entry);
      if (entry.error) {
        warnings.push(`${item.templateId}: ${entry.error.message}`);
      }
    } else {
      entry.status = "failed";
      entry.reportPath = reportPath;
      entry.reportSha256 =
        reportPath && (await pathExists(reportPath))
          ? await fileSha256(reportPath)
          : null;
      entry.error = structuredStageError(
        result.violations[0]?.code ?? "TESSERA_STAGE_FAILED",
        result.violations[0]?.message ??
          `The ${stage} stage did not produce a reusable report.`,
      );
      entry.nextAction = stageNextAction(entry);
      warnings.push(`${item.templateId}: ${entry.error.message}`);
    }
    await writeManifest(
      input.manifest,
      input.manifestPath,
      input.options,
      true,
    );
    if (
      entry.error &&
      isGlobalStageFailure(entry.error)
    ) {
      warnings.push(
        `${item.templateId}: the live Tessera unlock/matrix readiness capture failed, so later ${stage === "deepDive" ? "deep-dive" : "screening"} proxies were not attempted in this invocation.`,
      );
      break;
    }
  }
  return { reports, warnings };
}

function candidateEvidenceIsCausal(
  playerRoster: RosterDraftV1,
  report: TesseraMatchupReport,
  candidate: TesseraChangeCandidate,
): boolean {
  const referenced = new Set(candidate.evidenceFindingIds);
  if (referenced.size === 0) return false;
  const selectionId =
    "selectionId" in candidate.operation
      ? candidate.operation.selectionId
      : null;
  return (report.findings ?? [])
    .filter(
      (finding) =>
        referenced.has(finding.findingId) &&
        finding.severity === "warn" &&
        finding.confidence !== "ambiguous",
    )
    .some((finding) => {
      if (finding.kind === "role-gap") return true;
      if (!selectionId) return false;
      return finding.evidence.some((evidence) => {
        const affectedPlayerId =
          evidence.direction === "player-to-opponent"
            ? evidence.attackerInstanceId
            : evidence.targetInstanceId;
        return affectedPlayerId === selectionId;
      }) ||
        finding.unitInstanceIds.includes(selectionId);
    });
}

export async function aggregateChangeCandidates(
  playerRoster: RosterDraftV1,
  screeningReports: Map<string, TesseraMatchupReport>,
  portfolio: TesseraStressPortfolio,
  baselineReadiness: TesseraMissionReadinessReport,
  stressFindingResults: TesseraStressFinding[],
): Promise<TesseraChangeCandidate[]> {
  const groups = new Map<
    string,
    {
      candidate: TesseraChangeCandidate;
      templateIds: Set<string>;
      postures: Set<string>;
      evidenceFindingIds: Set<string>;
    }
  >();
  for (const [templateId, report] of screeningReports) {
    const posture =
      portfolio.items.find((item) => item.templateId === templateId)
        ?.posture ?? "unknown";
    for (const candidate of report.changeCandidates ?? []) {
      if (
        !candidateEvidenceIsCausal(
          playerRoster,
          report,
          candidate,
        )
      ) {
        continue;
      }
      const key = JSON.stringify(candidate.operation);
      const group = groups.get(key) ?? {
        candidate,
        templateIds: new Set<string>(),
        postures: new Set<string>(),
        evidenceFindingIds: new Set<string>(),
      };
      group.templateIds.add(templateId);
      group.postures.add(posture);
      candidate.evidenceFindingIds.forEach((id) =>
        group.evidenceFindingIds.add(id),
      );
      groups.set(key, group);
    }
  }
  const minimumSupport = Math.max(
    2,
    Math.ceil(portfolio.coverage.ready * 0.5),
  );
  const robustSelectionIds = new Set(
    stressFindingResults
      .filter((finding) => finding.kind === "robust-answer")
      .flatMap((finding) => finding.unitInstanceIds),
  );
  const accepted: TesseraChangeCandidate[] = [];
  for (const group of [...groups.values()]
    .filter(
      (group) =>
        group.templateIds.size >= minimumSupport &&
        group.postures.size >= 2,
    )) {
    const operation = group.candidate.operation;
    if (
      operation.type === "replace" &&
      robustSelectionIds.has(operation.selectionId)
    ) {
      continue;
    }
    const qualified = await qualifyRosterChangeCandidate(
      playerRoster,
      baselineReadiness,
      operation,
    );
    if (!qualified) continue;
    accepted.push({
      ...group.candidate,
      rationale: `${group.candidate.rationale} Supported by ${group.templateIds.size} frozen proxies across ${group.postures.size} postures; legality, New Recruit exportability, points utilization, and the deterministic mission-readiness guardrail passed.`,
      afterPoints: qualified.roster.totalPoints,
      rosterFingerprint: rosterExecutionFingerprint(
        qualified.roster,
      ),
      evidenceFindingIds: [...group.evidenceFindingIds],
    });
    if (accepted.length >= 3) break;
  }
  return accepted;
}

export function assessScreeningIntegrity(
  reports: Map<string, TesseraMatchupReport>,
  portfolio: TesseraStressPortfolio,
  simulationRequested: boolean,
  expectedTemplateIds?: ReadonlySet<string>,
): TesseraStressTestReport["integrity"] {
  if (!simulationRequested) {
    return {
      status: "not-evaluated",
      issues: [],
    };
  }
  const issues: TesseraStressTestReport["integrity"]["issues"] = [];
  const readyItems = portfolio.items.filter(
    (item) =>
      item.status === "ready" &&
      item.roster !== null &&
      Boolean(item.simulationFingerprint) &&
      (
        expectedTemplateIds === undefined ||
        expectedTemplateIds.has(item.templateId)
      ),
  );
  const missingEvidence = readyItems
    .filter((item) => reports.get(item.templateId)?.status !== "complete")
    .map((item) => item.templateId);
  if (missingEvidence.length > 0) {
    issues.push({
      code: "TESSERA_EVIDENCE_INCOMPLETE",
      message:
        `Trusted matrix integrity could not be evaluated for ${missingEvidence.length} prepared proxy result(s) because their simulations did not complete.`,
      templateIds: missingEvidence,
    });
  }
  for (const item of readyItems) {
    const report = reports.get(item.templateId);
    if (!report || report.status !== "complete") continue;
    const runs = (report.simulation.scenarios ?? [])
      .flatMap((scenario) =>
        (scenario.metricRuns ?? []).map((run) => ({
          key: `${scenario.phase}:${scenario.direction}:${run.metric}`,
          matrixSha256: run.matrixSha256 ?? null,
          integrity: run.integrity,
        })),
      )
      .sort((left, right) => left.key.localeCompare(right.key));
    if (
      runs.length === 0 ||
      runs.some((run) => run.matrixSha256 === null)
    ) {
      issues.push({
        code: "TESSERA_MATRIX_FINGERPRINT_MISSING",
        message:
          `${item.templateId}: one or more captured matrices lack the v2 content fingerprint required to rule out stale UI reuse.`,
        templateIds: [item.templateId],
      });
      continue;
    }
    const aliasedCodes = unique(
      runs.flatMap((run) =>
        run.integrity?.status === "aliased"
          ? run.integrity.issueCodes
          : [],
      ),
    );
    for (const code of aliasedCodes) {
      issues.push({
        code,
        message:
          `${item.templateId}: Tessera returned identical matrix content for scenarios that should have been independently captured.`,
        templateIds: [item.templateId],
      });
    }
  }
  return {
    status: issues.length === 0 ? "verified" : "inconclusive",
    issues,
  };
}

function quarantineIntegrityAffectedScenarios(
  report: TesseraMatchupReport | null,
  portfolio: TesseraStressPortfolio,
  integrity: TesseraStressTestReport["integrity"],
): void {
  if (!report || integrity.status !== "inconclusive") return;
  const issueByTemplate = new Map<string, string[]>();
  for (const integrityIssue of integrity.issues) {
    if (integrityIssue.code === "TESSERA_EVIDENCE_INCOMPLETE") {
      continue;
    }
    for (const templateId of integrityIssue.templateIds) {
      const codes = issueByTemplate.get(templateId) ?? [];
      codes.push(integrityIssue.code);
      issueByTemplate.set(templateId, codes);
    }
  }
  const codesByOpponent = new Map<string, string[]>();
  for (const [templateId, codes] of issueByTemplate) {
    const item = portfolio.items.find(
      (candidate) => candidate.templateId === templateId,
    );
    if (item?.roster) {
      codesByOpponent.set(item.roster.name, unique(codes));
    }
  }
  for (const scenario of report.simulation.scenarios ?? []) {
    const codes = codesByOpponent.get(scenario.opponentName);
    if (!codes?.length) continue;
    scenario.status = "partial";
    const warning =
      `[${codes.join(",")}] This scenario was quarantined because its matrix integrity is inconclusive; its cells are provisional observations, not analytical evidence.`;
    scenario.warnings = unique([...scenario.warnings, warning]);
    for (const cell of scenario.cells) {
      cell.confidence = "ambiguous";
      cell.warningRefs = unique([...cell.warningRefs, warning]);
    }
  }
}

function recordStageIntegrityIssues(
  stage: Record<string, ManifestStageEntry>,
  result: TesseraStressTestReport["integrity"],
): void {
  for (const integrityIssue of result.issues) {
    for (const templateId of integrityIssue.templateIds) {
      const entry = stage[templateId];
      if (
        !entry ||
        entry.status !== "complete" ||
        entry.error !== null
      ) continue;
      entry.error = structuredStageError(
        integrityIssue.code,
        integrityIssue.message,
      );
      const latestAttempt =
        entry.attemptHistory[entry.attemptHistory.length - 1];
      if (
        latestAttempt &&
        latestAttempt.attempt === entry.attemptCount &&
        latestAttempt.error === null
      ) {
        latestAttempt.outcome = "partial";
        latestAttempt.error = entry.error;
      }
      entry.nextAction = stageNextAction(entry);
    }
  }
}

async function runIntegrityCheckedStage(
  input: StressExecutionInput,
  stage: "screening" | "deepDive",
  items: TesseraStressPortfolioItem[],
  metrics: TesseraMetric[],
  mode: "quick" | "full",
  delivery: ReturnType<typeof createDeliveryCache>,
): Promise<StageRunResult & {
  integrity: TesseraStressTestReport["integrity"];
}> {
  const warnings: string[] = [];
  const expectedTemplateIds = new Set(
    items.map((item) => item.templateId),
  );
  let result: StageRunResult;
  let integrity: TesseraStressTestReport["integrity"];
  while (true) {
    result = await runStage(
      input,
      stage,
      items,
      metrics,
      mode,
      delivery,
    );
    warnings.push(...result.warnings);
    integrity = assessScreeningIntegrity(
      result.reports,
      input.portfolio,
      input.manifest.simulationRequested,
      expectedTemplateIds,
    );
    recordStageIntegrityIssues(
      input.manifest[stage],
      integrity,
    );
    await writeManifest(
      input.manifest,
      input.manifestPath,
      input.options,
      true,
    );
    const affectedTemplateIds = new Set(
      integrity.issues.flatMap((issue) => issue.templateIds),
    );
    const canRetryIntegrityFailure = [
      ...affectedTemplateIds,
    ].some((templateId) => {
      const entry = input.manifest[stage][templateId];
      return (
        entry?.error?.retryable === true &&
        entry.attemptCount < retryLimit(input)
      );
    });
    if (
      integrity.status !== "inconclusive" ||
      !canRetryIntegrityFailure
    ) {
      break;
    }
  }
  return {
    ...result,
    warnings: unique(warnings),
    integrity,
  };
}

function executionStatus(
  portfolio: TesseraStressPortfolio,
  representatives: TesseraStressRepresentative[],
  strategy: TesseraStressAnalysisStrategy,
  robustness: TesseraStressRobustness,
  manifest: TesseraStressManifest,
  integrity: TesseraStressTestReport["integrity"],
): TesseraStressTestReport["status"] {
  const readyItems = portfolio.items.filter(
    (item) => item.status === "ready" && item.roster !== null,
  );
  const requiredEvidence = requiredStressEvidence(portfolio);
  const screeningComplete = readyItems.every(
    (item) => manifest.screening[item.templateId]?.status === "complete",
  );
  if (!manifest.simulationRequested) {
    return screeningComplete && readyItems.length > 0
      ? "prepared"
      : "failed";
  }
  const minimum = requiredEvidence.minimumConfident;
  if (
    !screeningComplete ||
    readyItems.length < minimum
  ) {
    const capturedMatrices = robustness.samples.some(
      (sample) => sample.status !== "missing",
    );
    return capturedMatrices ? "inconclusive" : "failed";
  }

  const confident = robustness.samples.filter(
    (sample) => sample.status === "confident",
  );
  const confidentPostures = new Set(
    confident.map((sample) => sample.posture),
  );
  if (
    confident.length < minimum ||
    confidentPostures.size < requiredEvidence.minimumPostures ||
    representatives.length !== requiredEvidence.representatives ||
    integrity.status === "inconclusive"
  ) return "inconclusive";

  const deepComplete =
    strategy === "full-all" ||
    representatives.every(
      (representative) =>
        manifest.deepDive[representative.templateId]?.status === "complete",
    );
  if (!deepComplete) return "inconclusive";

  const completeTarget = portfolio.suite === "diverse-9" ? 9 : 3;
  if (portfolio.coverage.maximumResultStatus === "degraded") {
    return "degraded";
  }
  return confident.length === completeTarget &&
    readyItems.length === completeTarget
    ? "complete"
    : "degraded";
}

function requiredStressEvidence(
  portfolio: TesseraStressPortfolio,
): {
  minimumConfident: number;
  minimumPostures: number;
  representatives: number;
} {
  const ready = portfolio.items.filter(
    (item) => item.status === "ready" && item.roster !== null,
  );
  const contract =
    evaluateTesseraStressPortfolioContract(portfolio);
  return {
    minimumConfident: contract.minimumUniqueRequired,
    minimumPostures:
      contract.minimumPosturesRequired,
    representatives: Math.min(3, ready.length),
  };
}

function stressStatusExplanation(
  status: TesseraStressTestReport["status"],
  portfolio: TesseraStressPortfolio,
  robustness: TesseraStressRobustness,
  representatives: TesseraStressRepresentative[],
  manifest: TesseraStressManifest,
  integrity: TesseraStressTestReport["integrity"],
): string {
  const ready = portfolio.coverage.ready;
  const target = portfolio.coverage.intended;
  const quantitativelyComplete = robustness.samples.filter(
    (sample) => sample.status === "confident",
  ).length;
  const evidenceSummary =
    quantitativelyComplete > 0
      ? ` Aggregate evidence confidence is ${robustness.evidenceConfidence ?? "ambiguous"}, capped by the lowest-confidence contributing simulation cell.`
      : "";
  const screeningComplete = portfolio.items.filter(
    (item) => item.status === "ready",
  ).filter(
    (item) => manifest.screening[item.templateId]?.status === "complete",
  ).length;
  const deepComplete = representatives.filter(
    (representative) =>
      manifest.deepDive[representative.templateId]?.status === "complete",
  ).length;
  if (status === "prepared") {
    return `Preparation completed for the player roster and ${ready}/${target} frozen opponent proxies; no Tessera simulation was requested.`;
  }
  if (status === "failed" || status === "partial") {
    return `Required work is incomplete: ${screeningComplete}/${ready} screening proxies and ${deepComplete}/${representatives.length || 3} selected deep dives are complete.`;
  }
  if (status === "inconclusive") {
    if (integrity.status === "inconclusive") {
      return `Capture finished, but ${integrity.issues.length} simulation-integrity issue(s) prevent analytical confidence.`;
    }
    return `Capture finished, but only ${quantitativelyComplete}/${ready} ready proxies have quantitatively complete coverage across the required postures.${evidenceSummary}`;
  }
  if (status === "degraded") {
    const reason =
      ready < target
        ? "the reduced portfolio"
        : "a portfolio quality gate";
    return `${quantitativelyComplete}/${target} intended unique proxies have quantitatively complete coverage with all required postures and deep dives covered; ${reason} caps this result at degraded.${evidenceSummary}`;
  }
  return `All ${target} unique proxies have quantitatively complete coverage and all required deep dives completed with verified matrix integrity.${evidenceSummary}`;
}

function stressRecoverySummary(
  manifest: TesseraStressManifest,
  manifestPath: string,
  verifiedFrozenOpponentCount = 0,
): TesseraStressTestReport["recovery"] {
  const stages = [
    ...Object.entries(manifest.screening).map(
      ([templateId, entry]) => ({
        label: `screening/${templateId}`,
        entry,
      }),
    ),
    ...Object.entries(manifest.deepDive).map(
      ([templateId, entry]) => ({
        label: `deep-dive/${templateId}`,
        entry,
      }),
    ),
  ];
  return {
    manifest: path.basename(manifestPath),
    screeningAttempts: Object.values(manifest.screening).reduce(
      (sum, entry) => sum + entry.attemptCount,
      0,
    ),
    deepDiveAttempts: Object.values(manifest.deepDive).reduce(
      (sum, entry) => sum + entry.attemptCount,
      0,
    ),
    exhaustedTemplates: stages
      .filter(({ entry }) => entry.attemptCount >= 5)
      .map(({ label }) => label),
    nextActions: unique(
      stages.flatMap(({ label, entry }) =>
        entry.nextAction
          ? [`${label}: ${entry.nextAction}`]
          : [],
      ),
    ),
    verifiedPreparedPlayer:
      manifest.preparedPlayer !== null &&
      manifest.preparedPlayerSha256 !== null,
    verifiedPreparedOpponents:
      Math.max(
        Object.keys(manifest.preparedOpponents).length,
        verifiedFrozenOpponentCount,
      ),
  };
}

function stressFailures(
  manifest: TesseraStressManifest,
  portfolio: TesseraStressPortfolio,
): NonNullable<TesseraStressTestReport["failures"]> {
  return (
    [
      ["screening", manifest.screening],
      ["deep-dive", manifest.deepDive],
    ] as const
  ).flatMap(([stage, entries]) =>
    Object.entries(entries).flatMap(([templateId, entry]) => {
      if (!entry.error) return [];
      return [{
        stage,
        code: entry.error.code,
        message: entry.error.message,
        opponentName:
          portfolio.items.find(
            (item) => item.templateId === templateId,
          )?.roster?.name ?? null,
        retryable: entry.error.retryable,
      }];
    }),
  );
}

function trustedMatrixCount(
  reports: Array<TesseraMatchupReport | null>,
): number {
  const hashes = new Set<string>();
  for (const report of reports) {
    for (const scenario of report?.simulation.scenarios ?? []) {
      for (const run of scenario.metricRuns ?? []) {
        if (
          run.matrixSha256 &&
          run.integrity?.status !== "aliased"
        ) {
          hashes.add(run.matrixSha256);
        }
      }
    }
  }
  return hashes.size;
}

async function finalStressTargets(
  playerRoster: RosterDraftV1,
  portfolio: TesseraStressPortfolio,
  outputDirectory: string,
  options: TesseraStressOptions,
): Promise<[string, string]> {
  const basename = `${safeName(playerRoster.name) || "roster"}-vs-${safeName(
    portfolio.factionId,
  ) || "faction"}-stress-test`;
  const targets = await resolveExportArtifactTargets(
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
    ],
    outputDirectory,
    options,
  );
  return [targets[0], targets[1]];
}

async function preparedProfileInventory(
  playerRoster: RosterDraftV1,
  preparedPlayer: TesseraPreparedRoster,
  readyItems: Array<
    TesseraStressPortfolioItem & { roster: RosterDraftV1 }
  >,
  manifest: TesseraStressManifest,
  opponentRoszPaths?: Map<string, string>,
): Promise<TesseraProfileRequirement[]> {
  const inspectPrepared = async (
    prepared: TesseraPreparedRoster,
    factionId: string,
    overridePath?: string,
  ): Promise<TesseraProfileRequirement[]> => {
    const filename = overridePath ?? prepared.enrichedRoszPath;
    const content = await readFile(filename);
    if (
      !overridePath &&
      prepared.simulationInput?.kind ===
        "rosterpilot-local-engine-input"
    ) {
      return verifyLocalTesseraEngineInput({
        content,
        expectedSha256: prepared.simulationInput.sha256,
        expectedBundleId: prepared.simulationInput.bundleId,
        expectedRosterFingerprint: prepared.fingerprint,
      }).profileRequirements;
    }
    return inspectEnrichedProfileRequirements(content, factionId);
  };
  const inventories = await Promise.all([
    inspectPrepared(preparedPlayer, playerRoster.factionId),
    ...readyItems.map((item) => {
      const receipt =
        manifest.preparedOpponents[item.templateId]?.prepared;
      const enrichedRoszPath =
        opponentRoszPaths?.get(item.templateId) ??
        receipt?.enrichedRoszPath;
      if (!enrichedRoszPath) {
        throw new Error(
          `${item.templateId} has no verified prepared opponent receipt.`,
        );
      }
      return receipt
        ? inspectPrepared(
            receipt,
            item.roster.factionId,
            opponentRoszPaths?.has(item.templateId)
              ? enrichedRoszPath
              : undefined,
          )
        : readFile(enrichedRoszPath).then((content) =>
            inspectEnrichedProfileRequirements(
              content,
              item.roster.factionId,
            ),
          );
    }),
  ]);
  return mergeProfileInventory(inventories.flat());
}

function preparationFailureRetryable(code: string): boolean {
  if (
    code === "TESSERA_STRESS_DELIVERY_OUTCOME_UNKNOWN" ||
    code.includes("CATALOGUE_PROVENANCE") ||
    code.includes("CATALOGUE_DRIFT")
  ) {
    return false;
  }
  return /TIMEOUT|UNAVAILABLE|SESSION|NAVIGATION|CONNECTION|COMPANION/i.test(
    code,
  );
}

function uniqueConnectorEvents(
  prepared: TesseraPreparedRoster[],
): NonNullable<TesseraPreparedRoster["connectorEvents"]> {
  return [
    ...new Map(
      prepared
        .flatMap((receipt) => receipt.connectorEvents ?? [])
        .map((event) => [event.eventId, event] as const),
    ).values(),
  ];
}

async function optionalFileSha256(
  filename: string,
): Promise<string | null> {
  try {
    return (await pathExists(filename))
      ? await fileSha256(filename)
      : null;
  } catch {
    return null;
  }
}

async function preparationFailureArtifacts(
  input: StressExecutionInput,
  verifiedPlayer: TesseraPreparedRoster | null,
  verifiedOpponents: TesseraStressPreparationFailureReport["verifiedPreparedOpponents"],
  partial: PreparationFailureContext["partialPrepared"],
  context: PreparationFailureContext,
): Promise<TesseraStressPreparationFailureReport["artifacts"]> {
  const artifacts: TesseraStressPreparationFailureReport["artifacts"] =
    [
      {
        format: "stress-manifest",
        written: input.manifestPath,
        sha256: await optionalFileSha256(input.manifestPath),
        verification: "verified",
        reusable: true,
        templateId: null,
      },
    ];
  const addPreparedArtifacts = async (
    prepared: TesseraPreparedRoster,
    side: "player" | "opponent",
    templateId: string | null,
    verification: "verified" | "unverified",
    reusable: boolean,
    enrichedSha256?: string,
  ) => {
    artifacts.push(
      {
        format:
          prepared.simulationInput?.kind ===
          "rosterpilot-local-engine-input"
            ? side === "player"
              ? "player-source-json"
              : "opponent-source-json"
            : side === "player"
              ? "player-source-rosz"
              : "opponent-source-rosz",
        written: prepared.sourceRoszPath,
        sha256: await optionalFileSha256(
          prepared.sourceRoszPath,
        ),
        verification,
        reusable,
        templateId,
      },
      {
        format:
          prepared.simulationInput?.kind ===
          "rosterpilot-local-engine-input"
            ? side === "player"
              ? "player-local-engine-input"
              : "opponent-local-engine-input"
            : side === "player"
              ? "player-enriched-rosz"
              : "opponent-enriched-rosz",
        written: prepared.enrichedRoszPath,
        sha256:
          enrichedSha256 ??
          (await optionalFileSha256(
            prepared.enrichedRoszPath,
          )),
        verification,
        reusable,
        templateId,
      },
    );
  };
  if (verifiedPlayer) {
    await addPreparedArtifacts(
      verifiedPlayer,
      "player",
      null,
      "verified",
      true,
      input.manifest.preparedPlayerSha256 ?? undefined,
    );
  }
  for (const opponent of verifiedOpponents) {
    await addPreparedArtifacts(
      opponent.prepared,
      "opponent",
      opponent.templateId,
      "verified",
      true,
      opponent.sha256,
    );
  }
  if (partial) {
    await addPreparedArtifacts(
      partial,
      context.side,
      context.templateId,
      "unverified",
      false,
    );
  }
  return artifacts;
}

async function preparationFailureReport(
  input: StressExecutionInput,
  context: PreparationFailureContext,
  violations: RosterIssue[],
  warnings: RosterIssue[],
): Promise<TesseraStressPreparationFailureReport> {
  const verifiedPlayer =
    input.manifest.preparedPlayer &&
    input.manifest.preparedPlayerSha256
      ? input.manifest.preparedPlayer
      : null;
  const verifiedOpponents =
    input.portfolio.items.flatMap((item) => {
      const receipt =
        input.manifest.preparedOpponents[item.templateId];
      return receipt
        ? [
            {
              templateId: item.templateId,
              prepared: receipt.prepared,
              sha256: receipt.sha256,
            },
          ]
        : [];
    });
  const observedReceipts = [
    ...(verifiedPlayer ? [verifiedPlayer] : []),
    ...verifiedOpponents.map((entry) => entry.prepared),
    ...(context.partialPrepared
      ? [context.partialPrepared]
      : []),
  ];
  const connectorEvents = uniqueConnectorEvents(
    observedReceipts,
  );
  const cacheReuses = observedReceipts.filter(
    (receipt) => receipt.cacheReused === true,
  ).length;
  const recordedRemoteMutations = connectorEvents.filter(
    (event) =>
      event.provider === "new-recruit" &&
      event.action === "prepare" &&
      event.origin === "new-remote" &&
      event.outcome === "verified",
  ).length;
  const localPreparation =
    input.manifest.selectedSimulationBackend === "local-engine";
  const failureIssues =
    violations.length > 0
      ? violations
      : [
          issue(
            "TESSERA_STRESS_PREPARATION_FAILED",
            localPreparation
              ? "Local data-bundle compilation failed without a structured compiler error."
              : "New Recruit preparation failed without a structured connector error.",
          ),
        ];
  const recovery = stressRecoverySummary(
    input.manifest,
    input.manifestPath,
    input.opponentRoszPaths?.size ?? 0,
  );
  recovery.nextActions = unique([
    ...recovery.nextActions,
    localPreparation
      ? "Inspect the local compiler failure and frozen bundle identity, then resume after resolving it; no external list was created."
      : context.partialPrepared
        ? "Inspect the non-reusable partial New Recruit receipt and resolve its provenance failure. Do not import it into Tessera or copy it into manifest success fields."
        : "Inspect the failed New Recruit preparation and the recovery manifest before explicitly resuming; RosterPilot will not retry an uncertain external outcome automatically.",
  ]);
  const report: TesseraStressPreparationFailureReport = {
    schemaVersion: 3,
    reportKind: "tessera-stress-preparation-failure",
    runId: input.manifest.runId,
    generatedAt: new Date().toISOString(),
    source: "prepare-only",
    status: "failed",
    statusExplanation:
      localPreparation
        ? context.side === "player"
          ? "Player data-bundle compilation failed before a verified local input existed. Tessera was not started."
          : `Opponent data-bundle compilation failed for ${context.templateId ?? "the current proxy"}; verified local inputs were retained and Tessera was not started.`
        : context.side === "player"
          ? "Player New Recruit preparation failed before a verified reusable player receipt existed. Tessera was not started."
          : `Opponent New Recruit preparation failed for ${context.templateId ?? "the current proxy"}; previously verified receipts were retained and Tessera was not started.`,
    runtime: getRuntimeProvenance(),
    tesseraUiIdentity: null,
    connectorEvents,
    preparation: {
      status:
        verifiedPlayer ||
        verifiedOpponents.length > 0 ||
        context.partialPrepared
          ? "partial"
          : "failed",
      source: localPreparation
        ? "rosterpilot-data-bundle"
        : "new-recruit",
      failedSide: context.side,
      failedTemplateId: context.templateId,
      uniqueRosters:
        (verifiedPlayer ? 1 : 0) + verifiedOpponents.length,
      remoteMutations: localPreparation
        ? 0
        : recordedRemoteMutations > 0
          ? recordedRemoteMutations
          : Math.max(0, observedReceipts.length - cacheReuses),
      cacheReuses: localPreparation ? 0 : cacheReuses,
      connectorEvents,
    },
    simulation: {
      requested: input.manifest.simulationRequested,
      status: input.manifest.simulationRequested
        ? "failed"
        : "not-requested",
      engine: "none",
      trustedMatrices: 0,
    },
    failures: failureIssues.map((entry) => ({
      stage: "preparation",
      code: entry.code,
      message: entry.message,
      opponentName:
        context.side === "opponent"
          ? context.rosterName
          : null,
      retryable: preparationFailureRetryable(entry.code),
    })),
    profilePolicyHash:
      input.manifest.configuration.profilePolicyHash,
    pinnedData: {
      player: input.playerRoster.sourceData,
      opponents: unique(
        input.portfolio.items.flatMap((item) =>
          item.roster
            ? [canonicalJson(item.roster.sourceData)]
            : [],
        ),
      ).map(
        (value) =>
          JSON.parse(value) as RosterDraftV1["sourceData"],
      ),
      cachedLiveUpdateCheck:
        input.manifest.cachedLiveUpdateCheck,
    },
    integrity: {
      status: "not-evaluated",
      issues: [],
    },
    recovery,
    verifiedPreparedPlayer: verifiedPlayer,
    verifiedPreparedOpponents: verifiedOpponents,
    currentPartialPreparedReceipt: context.partialPrepared
      ? {
          side: context.side,
          templateId: context.templateId,
          prepared: context.partialPrepared,
          reusable: false,
          failureCodes: failureIssues.map(
            (entry) => entry.code,
          ),
        }
      : null,
    opponentFactionId: input.portfolio.factionId,
    configuration: input.configuration,
    suite: input.portfolio.suite,
    portfolioSha256: input.manifest.portfolioSha256,
    portfolio: input.portfolio,
    stageProvenance: {
      screening: null,
      deepDive: null,
    },
    limitations: [
      "Preparation failed before any Tessera browser activity or trusted simulation evidence.",
      "Only receipts present in verifiedPreparedPlayer or verifiedPreparedOpponents are reusable.",
      "currentPartialPreparedReceipt is diagnostic evidence only and cannot upgrade preparation status or support Tessera selection.",
      "No game win probability or matchup conclusion was produced.",
    ],
    warnings: unique([
      ...input.manifest.warnings,
      ...warnings.map((entry) => entry.message),
    ]),
    artifacts: [],
  };
  report.artifacts = await preparationFailureArtifacts(
    input,
    verifiedPlayer,
    verifiedOpponents,
    context.partialPrepared,
    context,
  );
  const portable = portableReportValue(
    report,
    "",
    input.outputDirectory,
  ) as TesseraStressPreparationFailureReport;
  TesseraStressPreparationFailureReportSchema.parse(portable);
  return portable;
}

async function executeStressTest(
  input: StressExecutionInput,
): Promise<ResultEnvelope<TesseraStressRunReport>> {
  const initiallyPreparedRosterIds = new Set<string>([
    ...(input.manifest.preparedPlayer
      ? [input.manifest.preparedPlayer.rosterId]
      : []),
    ...Object.values(input.manifest.preparedOpponents).map(
      (receipt) => receipt.prepared.rosterId,
    ),
  ]);
  const delivery = createDeliveryCache(input.dependencies);
  if (
    input.manifest.simulationRequested &&
    input.manifest.selectedSimulationBackend === "website" &&
    !input.dependencies.runBrowser
  ) {
    const readiness = await getTesseraConnectionStatus();
    if (!readiness.ok || !readiness.data?.available) {
      return failure(
        "TESSERA_READINESS_PROBE_FAILED",
        readiness.violations[0]?.message ??
          readiness.warnings[0]?.message ??
          "The local Tessera agent, browser, or premium credential is not ready. No New Recruit lists were created.",
        readiness.warnings,
      );
    }
  }
  let preparedPlayer = input.manifest.preparedPlayer;
  if (preparedPlayer && !preparedPlayer.constraints) {
    preparedPlayer = {
      ...preparedPlayer,
      constraints: structuredClone(input.playerRoster.constraints),
    };
    input.manifest.preparedPlayer = preparedPlayer;
  }
  if (preparedPlayer) {
    const filesPresent =
      (await pathExists(preparedPlayer.sourceRoszPath)) &&
      (await pathExists(preparedPlayer.enrichedRoszPath));
    const digest = filesPresent
      ? await fileSha256(preparedPlayer.enrichedRoszPath)
      : null;
    if (
      !filesPresent ||
      !input.manifest.preparedPlayerSha256 ||
      digest !== input.manifest.preparedPlayerSha256
    ) {
      const changedPreparedPlayer = preparedPlayer;
      preparedPlayer = null;
      input.manifest.preparedPlayer = null;
      input.manifest.preparedPlayerSha256 = null;
      const changedIssue = issue(
        "TESSERA_STRESS_PREPARED_PLAYER_CHANGED",
        "The manifest-owned prepared player artifact is missing or changed. Start a new run instead of mixing prepared files.",
      );
      const diagnostic = await preparationFailureReport(
        input,
        {
          side: "player",
          templateId: null,
          rosterName: input.playerRoster.name,
          partialPrepared: changedPreparedPlayer,
        },
        [changedIssue],
        [],
      );
      return {
        ok: false,
        data: diagnostic,
        violations: [changedIssue],
        warnings: [],
      };
    }
  } else {
    if (
      input.manifest.selectedSimulationBackend !== "local-engine" &&
      input.manifest.playerPreparationStartedAt
    ) {
      const outcomeIssue = issue(
        "TESSERA_STRESS_DELIVERY_OUTCOME_UNKNOWN",
        "A prior New Recruit delivery for the player roster started but no verified receipt was persisted. Resume will not risk creating a duplicate list; inspect the external account and start a new run when safe.",
      );
      const diagnostic = await preparationFailureReport(
        input,
        {
          side: "player",
          templateId: null,
          rosterName: input.playerRoster.name,
          partialPrepared: null,
        },
        [outcomeIssue],
        [],
      );
      return {
        ok: false,
        data: diagnostic,
        violations: [outcomeIssue],
        warnings: [],
      };
    }
    if (input.manifest.selectedSimulationBackend !== "local-engine") {
      input.manifest.playerPreparationStartedAt =
        new Date().toISOString();
      try {
        await writeManifest(
          input.manifest,
          input.manifestPath,
          input.options,
          true,
        );
      } catch (error) {
        const markerIssue = issue(
          "WRITE_FAILED",
          error instanceof Error
            ? error.message
            : "The player delivery marker could not be persisted.",
        );
        const diagnostic = await preparationFailureReport(
          input,
          {
            side: "player",
            templateId: null,
            rosterName: input.playerRoster.name,
            partialPrepared: null,
          },
          [markerIssue],
          [],
        );
        return {
          ok: false,
          data: diagnostic,
          violations: [markerIssue],
          warnings: [],
        };
      }
    }
    const prepared = await prepareRosterForTessera(
      input.playerRoster,
      {
        ...input.options,
        simulationBackend:
          input.manifest.selectedSimulationBackend,
        profilePolicy: input.manifest.profilePolicy,
        mutationRunId: input.manifest.runId,
        outputDirectory: path.join(
          input.outputDirectory,
          "stress-runs",
          input.manifest.runId,
          "player",
        ),
        overwrite: input.resumed || input.options.overwrite,
      },
      delivery.dependencies,
    );
    if (!prepared.ok || !prepared.data) {
      const diagnostic = await preparationFailureReport(
        input,
        {
          side: "player",
          templateId: null,
          rosterName: input.playerRoster.name,
          partialPrepared: prepared.data,
        },
        prepared.violations,
        prepared.warnings,
      );
      return {
        ok: false,
        data: diagnostic,
        violations: prepared.violations,
        warnings: prepared.warnings,
      };
    }
    const preparationStartedAt =
      input.manifest.playerPreparationStartedAt;
    try {
      preparedPlayer = prepared.data;
      input.manifest.preparedPlayer = preparedPlayer;
      input.manifest.preparedPlayerSha256 = await fileSha256(
        preparedPlayer.enrichedRoszPath,
      );
      input.manifest.playerPreparationStartedAt = null;
      await writeManifest(
        input.manifest,
        input.manifestPath,
        input.options,
        true,
      );
    } catch (error) {
      preparedPlayer = null;
      input.manifest.preparedPlayer = null;
      input.manifest.preparedPlayerSha256 = null;
      input.manifest.playerPreparationStartedAt =
        input.manifest.selectedSimulationBackend === "local-engine"
          ? null
          : preparationStartedAt ?? new Date().toISOString();
      const persistenceIssue = issue(
        "WRITE_FAILED",
        error instanceof Error
          ? error.message
          : "The verified player delivery receipt could not be persisted.",
      );
      const diagnostic = await preparationFailureReport(
        input,
        {
          side: "player",
          templateId: null,
          rosterName: input.playerRoster.name,
          partialPrepared: prepared.data,
        },
        [persistenceIssue],
        prepared.warnings,
      );
      return {
        ok: false,
        data: diagnostic,
        violations: [persistenceIssue],
        warnings: prepared.warnings,
      };
    }
  }

  const readyItems = input.portfolio.items.filter(
    (
      item,
    ): item is TesseraStressPortfolioItem & {
      roster: RosterDraftV1;
    } => item.status === "ready" && item.roster !== null,
  );
  const preparedOpponents = await ensurePreparedOpponents(
    input,
    readyItems,
    delivery,
  );
  if (preparedOpponents.ok === false) {
    const diagnostic = await preparationFailureReport(
      input,
      preparedOpponents.failureContext,
      preparedOpponents.violations,
      preparedOpponents.warnings,
    );
    return {
      ok: false,
      data: diagnostic,
      violations: preparedOpponents.violations,
      warnings: preparedOpponents.warnings,
    };
  }
  try {
    await materializeManifestPreparedArtifacts(
      input.manifest,
      input.outputDirectory,
    );
    if (!input.manifest.preparedPlayer) {
      throw artifactMaterializationError(
        "TESSERA_STRESS_BUNDLE_ARTIFACT_MISSING",
        "The prepared player receipt disappeared before bundle materialization.",
      );
    }
    preparedPlayer = input.manifest.preparedPlayer;
    await delivery.seed(input.playerRoster, preparedPlayer);
    for (const item of readyItems) {
      const receipt =
        input.manifest.preparedOpponents[item.templateId];
      if (receipt) {
        await delivery.seed(item.roster, receipt.prepared);
      }
    }
    if (input.opponentRoszPaths) {
      for (const [templateId, filename] of
        input.opponentRoszPaths.entries()) {
        const materialized =
          await materializeContentAddressedRosz(
            filename,
            input.outputDirectory,
          );
        input.opponentRoszPaths.set(
          templateId,
          materialized.filename,
        );
      }
    }
    if (delivery.dependencies.deliver) {
      clearPreparedRosterDeliveryMemo(
        delivery.dependencies.deliver,
      );
    }
    await writeManifest(
      input.manifest,
      input.manifestPath,
      input.options,
      true,
    );
  } catch (error) {
    return failure(
      materializationFailureCode(error),
      error instanceof Error
        ? error.message
        : "The verified prepared artifacts could not be bundled.",
    );
  }
  let frozenArtifacts: TesseraStressFrozenOpponentArtifact[];
  try {
    frozenArtifacts = await frozenOpponentArtifacts(
      input,
      readyItems,
    );
  } catch (error) {
    return failure(
      "TESSERA_STRESS_FROZEN_ARTIFACT_MISSING",
      error instanceof Error
        ? error.message
        : "A frozen opponent artifact could not be verified.",
      );
  }
  let enrichedRequirements: TesseraProfileRequirement[];
  try {
    enrichedRequirements = await preparedProfileInventory(
      input.playerRoster,
      preparedPlayer,
      readyItems,
      input.manifest,
      input.opponentRoszPaths,
    );
  } catch (error) {
    return failure(
      "TESSERA_ENRICHED_PROFILE_INVENTORY_UNREADABLE",
      error instanceof Error
        ? error.message
        : "The enriched New Recruit profile inventory could not be read.",
      );
  }
  const previouslyFrozenEnrichedRequirements =
    input.manifest.enrichedProfileRequirements;
  if (
    previouslyFrozenEnrichedRequirements &&
    canonicalJson(previouslyFrozenEnrichedRequirements) !==
      canonicalJson(enrichedRequirements)
  ) {
    return failure(
      "TESSERA_ENRICHED_PROFILE_INVENTORY_CHANGED",
      "The complete profile inventory in a prepared New Recruit artifact differs from the inventory frozen in this manifest. Start a new run instead of mixing profile decisions.",
    );
  }
  const pinnedRequirements = mergeProfileInventory(
    aggregateProfileRequirements([
      input.playerRoster,
      ...readyItems.map((item) => item.roster),
    ]),
  );
  const inventoryComparison = compareProfileInventories(
    pinnedRequirements,
    enrichedRequirements,
  );
  input.manifest.enrichedProfileRequirements = enrichedRequirements;
  if (inventoryComparison.blocking.length > 0) {
    try {
      await writeManifest(
        input.manifest,
        input.manifestPath,
        input.options,
        true,
      );
    } catch {
      // The inventory mismatch remains the primary actionable failure.
    }
    return failure(
      "TESSERA_ENRICHED_PROFILE_INVENTORY_MISMATCH",
      `The New Recruit-enriched archives do not contain the complete pinned profile inventory. ${inventoryComparison.blocking.join(" ")}`,
    );
  }
  const enrichedPolicyValidation = validateProfilePolicy(
    enrichedRequirements,
    input.manifest.profilePolicy,
  );
  if (
    (
      previouslyFrozenEnrichedRequirements === null &&
      inventoryComparison.expanded.length > 0
    ) ||
    !enrichedPolicyValidation.valid ||
    enrichedPolicyValidation.hash !==
      input.manifest.profilePolicyHash
  ) {
    let scaffoldPath: string | null = null;
    try {
      scaffoldPath = await writeProfilePolicyScaffold(
        input.outputDirectory,
        enrichedRequirements,
        input.options,
      );
      await writeManifest(
        input.manifest,
        input.manifestPath,
        input.options,
        true,
      );
    } catch {
      // Prepared receipts remain reusable even if the convenience scaffold
      // or manifest refresh cannot be written.
    }
    const details = [
      ...inventoryComparison.expanded,
      ...enrichedPolicyValidation.errors,
      ...enrichedPolicyValidation.unresolved.map(
        (requirement) =>
          `${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase}: choose one of ${requirement.availableProfiles.join(", ")} for ${requirement.activeCount} active weapon(s).`,
      ),
    ].join(" ");
    return failure(
      "TESSERA_PROFILE_POLICY_REQUIRED",
      `New Recruit enrichment exposed profile decisions that are not covered by the frozen policy. ${details}${
        scaffoldPath ? ` Complete the scaffold at ${scaffoldPath}.` : ""
      } Resume this manifest to reuse the verified prepared artifacts; no Tessera simulation has started.`,
    );
  }
  try {
    await writeManifest(
      input.manifest,
      input.manifestPath,
      input.options,
      true,
    );
  } catch (error) {
    return failure(
      "WRITE_FAILED",
      error instanceof Error
        ? error.message
        : "The verified enriched profile inventory could not be persisted.",
    );
  }
  if (
    input.manifest.simulationRequested &&
    input.manifest.selectedSimulationBackend === "website" &&
    !input.dependencies.runBrowser
  ) {
    const readiness = await getTesseraConnectionStatus();
    if (!readiness.ok || !readiness.data?.available) {
      return failure(
        "TESSERA_READINESS_PROBE_FAILED",
        readiness.violations[0]?.message ??
          readiness.warnings[0]?.message ??
          "The local Tessera agent, browser, or premium credential is not ready.",
        readiness.warnings,
      );
    }
  }
  const screeningMetrics =
    input.configuration.analysisStrategy === "full-all"
      ? FULL_METRICS
      : SCREENING_METRICS;
  const screeningMode =
    input.configuration.analysisStrategy === "full-all"
      ? "full"
      : "quick";
  const screening = await runIntegrityCheckedStage(
    input,
    "screening",
    readyItems,
    screeningMetrics,
    screeningMode,
    delivery,
  );
  const screeningReport = combineMatchupReports(
    screening.reports,
    preparedPlayer,
    input.manifest.preparedOpponents,
    readyItems.length,
    screeningMetrics,
    screeningMode,
    screening.warnings,
    input.manifest.profilePolicyHash,
    input.manifest.requestedScenarioContract
      ? projectTesseraScenarioContract(
          input.manifest.requestedScenarioContract,
          ["shooting", "fight"],
          screeningMetrics,
        )
      : null,
    input.configuration.providerCompatibilityMode,
  );
  const screeningIntegrity = screening.integrity;
  quarantineIntegrityAffectedScenarios(
    screeningReport,
    input.portfolio,
    screeningIntegrity,
  );
  const robustness = computeStressRobustness(
    screeningReport,
    input.portfolio,
  );
  const confidentScreeningTemplates = new Set(
    robustness.samples
      .filter((sample) => sample.status === "confident")
      .map((sample) => sample.templateId),
  );
  const requiredEvidence =
    requiredStressEvidence(input.portfolio);
  const minimumConfidentScreening =
    requiredEvidence.minimumConfident;
  const confidentScreeningPostures = new Set(
    robustness.samples
      .filter((sample) => sample.status === "confident")
      .map((sample) => sample.posture),
  );
  const screeningStable =
    screening.reports.size === readyItems.length &&
    screeningIntegrity.status !== "inconclusive" &&
    readyItems.every(
      (item) =>
        input.manifest.screening[item.templateId]?.status ===
          "complete",
    ) &&
    confidentScreeningTemplates.size >=
      minimumConfidentScreening &&
    confidentScreeningPostures.size >=
      requiredEvidence.minimumPostures;
  const previousRepresentatives =
    input.manifest.representatives;
  const representatives =
    screeningStable
      ? (
          input.frozenRepresentatives ??
          selectStressRepresentatives(robustness, input.portfolio)
        )
      : [];
  if (
    previousRepresentatives.length > 0 &&
    canonicalJson(previousRepresentatives) !==
      canonicalJson(representatives)
  ) {
    for (const entry of Object.values(input.manifest.deepDive)) {
      entry.status = "pending";
      entry.reportPath = null;
      entry.reportSha256 = null;
      entry.error = null;
      entry.nextAction =
        screeningStable
          ? "Representative selection changed after screening stabilized; resume to rebuild the deep-dive stage."
          : "Finish every confident screening proxy before selecting or running deep dives.";
    }
  }
  input.manifest.representatives = representatives;
  await writeManifest(
    input.manifest,
    input.manifestPath,
    input.options,
    true,
  );

  let deepDiveReport: TesseraMatchupReport | null = null;
  let deepDiveReports = new Map<string, TesseraMatchupReport>();
  const deepWarnings: string[] = [];
  if (input.configuration.analysisStrategy === "full-all") {
    deepDiveReport = screeningReport;
    deepDiveReports = screening.reports;
  } else if (
    screeningStable &&
    representatives.length ===
      requiredEvidence.representatives
  ) {
    const representativeItems = representatives
      .map((representative) =>
        readyItems.find(
          (item) => item.templateId === representative.templateId,
        ),
      )
      .filter(
        (
          item,
        ): item is TesseraStressPortfolioItem & {
          roster: RosterDraftV1;
        } => Boolean(item),
      );
    const deepDive = await runIntegrityCheckedStage(
      input,
      "deepDive",
      representativeItems,
      DEEP_DIVE_METRICS,
      "full",
      delivery,
    );
    deepWarnings.push(...deepDive.warnings);
    deepDiveReports = deepDive.reports;
    deepDiveReport = combineMatchupReports(
      deepDive.reports,
      preparedPlayer,
      input.manifest.preparedOpponents,
      representativeItems.length,
      DEEP_DIVE_METRICS,
      "full",
      deepDive.warnings,
      input.manifest.profilePolicyHash,
      input.manifest.requestedScenarioContract
        ? projectTesseraScenarioContract(
            input.manifest.requestedScenarioContract,
            ["shooting", "fight"],
            DEEP_DIVE_METRICS,
          )
        : null,
      input.configuration.providerCompatibilityMode,
    );
  } else if (!screeningStable) {
    deepWarnings.push(
      `Deep dives were not selected or run because every frozen screening capture must complete and at least ${minimumConfidentScreening} unique proxies across ${requiredEvidence.minimumPostures} posture(s) must have confident evidence.`,
    );
  }
  const deepDiveIntegrity =
    input.configuration.analysisStrategy === "full-all"
      ? screeningIntegrity
      : !input.manifest.simulationRequested
        ? {
            status: "not-evaluated" as const,
            issues: [],
          }
        : representatives.length !==
            requiredEvidence.representatives
          ? {
              status: "inconclusive" as const,
              issues: [
                {
                  code: "TESSERA_EVIDENCE_INCOMPLETE",
                  message:
                    `The staged analysis selected ${representatives.length}/${requiredEvidence.representatives} required representative deep dives.`,
                  templateIds: representatives.map(
                    (representative) =>
                      representative.templateId,
                  ),
                },
              ],
            }
          : assessScreeningIntegrity(
              deepDiveReports,
              input.portfolio,
              true,
              new Set(
                representatives.map(
                  (representative) =>
                    representative.templateId,
                ),
              ),
            );
  if (
    input.configuration.analysisStrategy !== "full-all"
  ) {
    quarantineIntegrityAffectedScenarios(
      deepDiveReport,
      input.portfolio,
      deepDiveIntegrity,
    );
  }
  const integrity: TesseraStressTestReport["integrity"] = {
    status:
      screeningIntegrity.status === "not-evaluated"
        ? "not-evaluated"
        : (
            screeningIntegrity.status === "inconclusive" ||
            deepDiveIntegrity.status === "inconclusive"
          )
          ? "inconclusive"
          : "verified",
    issues: unique([
      ...screeningIntegrity.issues,
      ...deepDiveIntegrity.issues,
    ].map((entry) => canonicalJson(entry))).map(
      (entry) =>
        JSON.parse(entry) as
          TesseraStressTestReport["integrity"]["issues"][number],
    ),
  };
  const stageProviderIdentities = [
    screeningReport?.simulation.providerIdentity,
    deepDiveReport?.simulation.providerIdentity,
  ].filter(
    (identity): identity is TesseraSimulationProviderIdentity =>
      identity !== undefined,
  );
  const providerIdentity = stageProviderIdentities[0];
  const providerIdentityDrift = stageProviderIdentities.some(
    (identity) =>
      providerIdentity !== undefined &&
      canonicalJson(identity) !== canonicalJson(providerIdentity),
  );
  const simulationProviderClaimsAllowed =
    simulationProviderAllowsAnalyticalClaims(
      input.manifest.selectedSimulationBackend,
      providerIdentity,
    );

  const mission = analyzeMissionReadiness(input.playerRoster);
  if (!mission.ok || !mission.data) {
    return {
      ok: false,
      data: null,
      violations: mission.violations,
      warnings: mission.warnings,
    };
  }
  const candidateFindings = stressFindings(
    robustness,
    input.portfolio,
  );
  const allScreeningStagesComplete = readyItems.every(
    (item) =>
      input.manifest.screening[item.templateId]?.status ===
      "complete",
  );
  const analyticalClaimsAllowed =
    input.manifest.simulationRequested &&
    simulationProviderClaimsAllowed &&
    !providerIdentityDrift &&
    allScreeningStagesComplete &&
    integrity.status === "verified" &&
    robustness.confidence !== "insufficient";
  const findings = analyticalClaimsAllowed
    ? candidateFindings
    : simulationProviderClaimsAllowed
      ? candidateFindings.filter(
          (finding) => finding.kind === "insufficient-confidence",
        )
      : [];
  const changeCandidates = analyticalClaimsAllowed
    ? await aggregateChangeCandidates(
        input.playerRoster,
        screening.reports,
        input.portfolio,
        mission.data,
        findings,
      )
    : [];
  const warnings = unique([
    ...input.manifest.warnings,
    ...screening.warnings,
    ...(screeningReport?.warnings ?? []),
    ...deepWarnings,
    ...(deepDiveReport?.warnings ?? []),
    ...robustness.warnings,
    ...integrity.issues.map(
      (entry) => `[${entry.code}] ${entry.message}`,
    ),
    ...(analyticalClaimsAllowed
      ? []
      : [
          "Substantive findings and roster-change candidates were suppressed because the complete screening evidence did not pass every confidence and integrity gate.",
        ]),
    ...(simulationProviderClaimsAllowed
      ? []
      : [
          "Local tessera-engine evidence was retained for evaluation, but analytical and coaching claims were suppressed until the provider is both approved and promoted.",
        ]),
    ...input.portfolio.items.flatMap((item) =>
      item.warnings.map((warning) => warning.message),
    ),
    ...(input.manifest.simulationRequested
      ? []
      : [
          "Tessera simulation was not requested; this report contains prepared handoffs and no probability claims.",
        ]),
  ]);
  const status = executionStatus(
    input.portfolio,
    representatives,
    input.configuration.analysisStrategy,
    robustness,
    input.manifest,
    integrity,
  );
  const preparedReceipts = [
    preparedPlayer,
    ...readyItems.flatMap((item) => {
      const receipt =
        input.manifest.preparedOpponents[item.templateId]?.prepared;
      return receipt ? [receipt] : [];
    }),
  ];
  const cacheReuses = preparedReceipts.filter(
    (receipt) =>
      receipt.cacheReused === true ||
      initiallyPreparedRosterIds.has(receipt.rosterId),
  ).length;
  const failures = stressFailures(
    input.manifest,
    input.portfolio,
  );
  const trustedMatrices = trustedMatrixCount([
    screeningReport,
    deepDiveReport,
  ]);
  const providerCompatibilityEnvelopes =
    compatibilityEnvelopesFromReports([
      screeningReport,
      deepDiveReport,
    ]);
  if (providerIdentityDrift) {
    failures.push({
      stage: "report",
      code: "TESSERA_SIMULATION_PROVIDER_DRIFT",
      message:
        "Screening and deep-dive evidence do not share one simulation-provider identity.",
      opponentName: null,
      retryable: false,
    });
  }
  if (
    input.manifest.simulationRequested &&
    status === "failed" &&
    failures.length === 0
  ) {
    failures.push({
      stage: "screening",
      code: "TESSERA_EVIDENCE_INCOMPLETE",
      message:
        "Tessera did not produce any trusted matrices for the requested simulation.",
      opponentName: null,
      retryable: true,
    });
  }
  const report: TesseraStressTestReport = {
    schemaVersion: 3,
    reportKind: "tessera-stress-test",
    runId: input.manifest.runId,
    generatedAt: new Date().toISOString(),
    runtime: getRuntimeProvenance(),
    tesseraUiIdentity:
      input.manifest.selectedSimulationBackend === "website"
        ? combineTesseraUiIdentities([
            screeningReport?.tesseraUiIdentity,
            deepDiveReport?.tesseraUiIdentity,
          ])
        : null,
    providerCompatibilityEnvelopes:
      providerCompatibilityEnvelopes.length > 0
        ? providerCompatibilityEnvelopes
        : undefined,
    connectorEvents: [
      ...(screeningReport?.connectorEvents ?? []),
      ...(deepDiveReport?.connectorEvents ?? []),
    ],
    source: !input.manifest.simulationRequested
      ? "prepare-only"
      : trustedMatrices > 0
        ? input.manifest.selectedSimulationBackend === "local-engine"
          ? "tessera-local-engine"
          : "tessera-ui"
        : input.manifest.selectedSimulationBackend === "local-engine"
          ? "tessera-local-engine-failed"
          : "tessera-ui-failed",
    status,
    statusExplanation: stressStatusExplanation(
      status,
      input.portfolio,
      robustness,
      representatives,
      input.manifest,
      integrity,
    ),
    preparation: {
      status:
        preparedReceipts.length === 1 + readyItems.length
          ? "complete"
          : preparedReceipts.length > 0
            ? "partial"
            : "failed",
      source:
        input.manifest.selectedSimulationBackend === "local-engine"
          ? "rosterpilot-data-bundle"
          : "new-recruit",
      uniqueRosters: preparedReceipts.length,
      remoteMutations:
        input.manifest.selectedSimulationBackend === "local-engine"
          ? 0
          : Math.max(
              0,
              preparedReceipts.length - cacheReuses,
            ),
      cacheReuses:
        input.manifest.selectedSimulationBackend === "local-engine"
          ? 0
          : cacheReuses,
      connectorEvents: preparedReceipts.flatMap(
        (receipt) => receipt.connectorEvents ?? [],
      ),
    },
    simulation: {
      requested: input.manifest.simulationRequested,
      status: !input.manifest.simulationRequested
        ? "not-requested"
        : status === "complete" || status === "degraded"
          ? "complete"
          : status === "inconclusive"
            ? "partial"
            : "failed",
      requestedBackend: input.manifest.simulationBackend,
      selectedBackend: input.manifest.selectedSimulationBackend,
      providerIdentity,
      fallback: null,
      engine: input.manifest.simulationRequested
        ? input.manifest.selectedSimulationBackend === "local-engine"
          ? "tessera-engine"
          : "tessera-ui"
        : "none",
      trustedMatrices,
    },
    failures,
    profilePolicyHash: input.configuration.profilePolicyHash,
    scenarioContract: input.manifest.requestedScenarioContract,
    scenarioContractSha256:
      input.manifest.requestedScenarioContractSha256,
    stageScenarioContracts: cloneStageContracts(
      input.manifest.stageContracts,
    ),
    stageScenarioContractsSha256:
      input.manifest.stageContractsSha256,
    pinnedData: {
      player: input.playerRoster.sourceData,
      opponents: unique(
        readyItems.map((item) =>
          canonicalJson(item.roster.sourceData),
        ),
      ).map(
        (value) =>
          JSON.parse(value) as RosterDraftV1["sourceData"],
      ),
      cachedLiveUpdateCheck:
        input.manifest.cachedLiveUpdateCheck,
    },
    integrity,
    recovery: stressRecoverySummary(
      input.manifest,
      input.manifestPath,
      input.opponentRoszPaths?.size ?? 0,
    ),
    player: preparedPlayer,
    opponentFactionId: input.portfolio.factionId,
    configuration: input.configuration,
    suite: input.portfolio.suite,
    portfolioSha256: input.manifest.portfolioSha256,
    portfolio: input.portfolio,
    frozenOpponentArtifacts: frozenArtifacts,
    stageProvenance: {
      screening: stageProvenance(
        screeningReport,
        screeningMode,
        screeningMetrics,
        screening.reports,
        input.configuration.profilePolicyHash,
      ),
      deepDive:
        deepDiveReport === null
          ? null
          : stageProvenance(
              deepDiveReport,
              input.configuration.analysisStrategy === "full-all"
                ? screeningMode
                : "full",
              input.configuration.analysisStrategy === "full-all"
                ? screeningMetrics
                : DEEP_DIVE_METRICS,
              deepDiveReports,
              input.configuration.profilePolicyHash,
            ),
    },
    screeningReport,
    deepDiveReport,
    representatives,
    robustness,
    missionReadiness: mission.data,
    findings,
    changeCandidates,
    limitations: [
      "This report measures directional combat robustness, not game win probability.",
      "The opponent lists are deterministic coverage proxies, not a claim about a player's actual list or current metagame frequency.",
      "Terrain geometry, deployment, movement, mission scoring, sequencing, player decisions, stratagem timing, and unmodeled rules remain outside the simulation.",
      "Equal proxy weights describe coverage across this frozen suite; they are not empirical faction-list probabilities.",
    ],
    warnings,
    artifacts: [],
  };
  let jsonPath: string;
  let htmlPath: string;
  try {
    const manifestOwnedArtifacts =
      input.resumed && input.manifest.finalArtifacts !== null;
    const reportWriteOptions: TesseraStressOptions = {
      ...input.options,
      overwrite:
        input.options.overwrite || manifestOwnedArtifacts,
    };
    [jsonPath, htmlPath] = await finalStressTargets(
      input.playerRoster,
      input.portfolio,
      input.outputDirectory,
      reportWriteOptions,
    );
    if (
      input.manifest.finalArtifacts &&
      (input.manifest.finalArtifacts.json !== jsonPath ||
        input.manifest.finalArtifacts.html !== htmlPath)
    ) {
      throw new Error(
        "The resume manifest final-artifact paths do not match this run.",
      );
    }
    input.manifest.finalArtifacts = {
      json: jsonPath,
      html: htmlPath,
      jsonSha256: null,
      htmlSha256: null,
    };
    input.manifest.completedAt = null;
    await writeManifest(
      input.manifest,
      input.manifestPath,
      input.options,
      true,
    );
    const childReportArtifacts = [
      ...Object.values(input.manifest.screening),
      ...Object.values(input.manifest.deepDive),
    ]
      .filter(
        (
          entry,
        ): entry is typeof entry & {
          reportPath: string;
          reportSha256: string;
        } =>
          entry.status === "complete" &&
          entry.reportPath !== null &&
          entry.reportSha256 !== null,
      )
      .filter(
        (entry, index, entries) =>
          entries.findIndex(
            (candidate) =>
              candidate.reportPath === entry.reportPath,
          ) === index,
      )
      .map((entry) => ({
        format: "child-report" as const,
        written: entry.reportPath,
        sha256: entry.reportSha256,
      }));
    const preparedArtifactDescriptors = (
      await Promise.all(
        preparedReceipts.flatMap((receipt, index) => [
          fileSha256(receipt.sourceRoszPath).then((digest) => ({
            format:
              receipt.simulationInput?.kind ===
              "rosterpilot-local-engine-input"
                ? index === 0
                  ? ("player-source-json" as const)
                  : ("opponent-source-json" as const)
                : index === 0
                  ? ("player-source-rosz" as const)
                  : ("opponent-source-rosz" as const),
            written: receipt.sourceRoszPath,
            sha256: digest,
          })),
          fileSha256(receipt.enrichedRoszPath).then((digest) => ({
            format:
              receipt.simulationInput?.kind ===
              "rosterpilot-local-engine-input"
                ? index === 0
                  ? ("player-local-engine-input" as const)
                  : ("opponent-local-engine-input" as const)
                : index === 0
                  ? ("player-enriched-rosz" as const)
                  : ("opponent-enriched-rosz" as const),
            written: receipt.enrichedRoszPath,
            sha256: digest,
          })),
        ]),
      )
    ).filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) =>
            candidate.format === entry.format &&
            candidate.written === entry.written,
        ) === index,
    );
    const policyArtifacts: TesseraStressTestReport["artifacts"] = [];
    if (input.manifest.profilePolicy) {
      const policyContent = `${JSON.stringify(
        input.manifest.profilePolicy,
        null,
        2,
      )}\n`;
      const policyDigest = await fileContentSha256(policyContent);
      const policyFilename = `tessera-profile-policy-${policyDigest.slice(0, 12)}.json`;
      const policyPath = path.join(
        input.outputDirectory,
        policyFilename,
      );
      if (await pathExists(policyPath)) {
        if ((await fileSha256(policyPath)) !== policyDigest) {
          throw new Error(
            "The bundled profile-policy artifact changed.",
          );
        }
      } else {
        await writeFile(policyPath, policyContent, {
          flag: "wx",
        });
      }
      policyArtifacts.push({
        format: "profile-policy",
        written: policyPath,
        sha256: policyDigest,
      });
    }
    report.artifacts = [
      {
        format: "stress-json",
        written: path.basename(jsonPath),
        sha256: null,
      },
      {
        format: "stress-html",
        written: path.basename(htmlPath),
        sha256: null,
      },
      {
        format: "stress-manifest",
        written: path.basename(input.manifestPath),
        sha256: null,
      },
      ...childReportArtifacts,
      ...policyArtifacts,
      ...preparedArtifactDescriptors,
    ];
    Object.assign(
      report,
      portableStressReport(report, input.outputDirectory),
    );
    await writeExportArtifacts(
      [
        {
          format: "roster-json",
          filename: path.basename(jsonPath),
          mimeType: "application/json",
          encoding: "utf8",
          content: `${JSON.stringify(report, null, 2)}\n`,
        },
        {
          format: "html",
          filename: path.basename(htmlPath),
          mimeType: "text/html; charset=utf-8",
          encoding: "utf8",
          content: renderTesseraStressTestReportHtml(report),
        },
      ],
      input.outputDirectory,
      reportWriteOptions,
    );
    input.manifest.finalArtifacts = {
      json: jsonPath,
      html: htmlPath,
      jsonSha256: await fileSha256(jsonPath),
      htmlSha256: await fileSha256(htmlPath),
    };
    input.manifest.completedAt = new Date().toISOString();
    await writeManifest(
      input.manifest,
      input.manifestPath,
      input.options,
      true,
    );
  } catch (error) {
    return {
      ok: false,
      data: report,
      violations: [
        issue(
          "WRITE_FAILED",
          error instanceof Error
            ? error.message
            : "Stress-test report write failed.",
        ),
      ],
      warnings: warnings.map((message) =>
        issue("TESSERA_STRESS_WARNING", message, "warn"),
      ),
    };
  }
  const requestedWorkSucceeded =
    status === "prepared" ||
    status === "complete" ||
    status === "degraded";
  return {
    ok: requestedWorkSucceeded,
    data: report,
    violations: requestedWorkSucceeded
      ? []
      : failures.map((entry) =>
          issue(entry.code, entry.message),
        ),
    warnings: warnings.map((message) =>
      issue("TESSERA_STRESS_WARNING", message, "warn"),
    ),
  };
}

export async function runRosterStressTest(
  playerRoster: RosterDraftV1,
  opponent: TesseraStressOpponentInput,
  options: TesseraStressOptions = {},
  dependencies: TesseraStressDependencies = {},
): Promise<ResultEnvelope<TesseraStressRunReport>> {
  const validation = validateRoster(playerRoster);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }
  const freshnessAtEntry =
    getCachedDataFreshnessResult();
  const freshnessWarningMessages =
    freshnessAtEntry?.warnings.map(
      (warning) => `${warning.code}: ${warning.message}`,
    ) ?? [];
  const restartIssue = dependencies.runtimeIssue
    ? dependencies.runtimeIssue()
    : dependencies.deliver
      ? null
      : runtimeRestartIssue();
  if (restartIssue) {
    return failure(
      restartIssue.code,
      restartIssue.message,
      validation.warnings,
    );
  }
  if (
    options.resumeManifestPath &&
    options.restartManifestPath
  ) {
    return failure(
      "TESSERA_STRESS_RECOVERY_MODE_CONFLICT",
      "Choose either --resume or --restart-from, not both.",
      validation.warnings,
    );
  }
  let requestedProfilePolicy: ProfilePolicyV1 | null;
  try {
    requestedProfilePolicy = await readProfilePolicy(
      options.profilePolicyPath,
      options,
    );
  } catch (error) {
    return failure(
      "TESSERA_PROFILE_POLICY_INVALID",
      error instanceof Error
        ? error.message
        : "The Tessera profile policy could not be read.",
      validation.warnings,
    );
  }
  let configuration = stressConfiguration(
    options,
    requestedProfilePolicy
      ? profilePolicyHash(requestedProfilePolicy)
      : null,
  );
  let simulationRequested = stressSimulationRequested(options);
  let simulationBackend = requestedSimulationBackend(options);
  let requestedScenarioContract: TesseraFrozenScenarioContract[] | null = null;
  try {
    if (options.scenarioContract) {
      if (
        !simulationRequested &&
        !options.resumeManifestPath &&
        !options.restartManifestPath
      ) {
        throw Object.assign(
          new Error(
            "A Tessera scenario contract requires executionMode=simulate.",
          ),
          { code: "TESSERA_SCENARIO_CONTRACT_MISMATCH" },
        );
      }
      requestedScenarioContract =
        assertTesseraScenarioContractScope(
          options.scenarioContract,
          TESSERA_SCENARIO_PHASES,
          FULL_METRICS,
        );
      assertTesseraScenarioContractProvider(
        requestedScenarioContract,
        selectedSimulationBackend(simulationBackend),
      );
    }
  } catch (error) {
    return failure(
      error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : "TESSERA_SCENARIO_CONTRACT_INVALID",
      error instanceof Error
        ? error.message
        : "The Tessera scenario contract is invalid.",
      validation.warnings,
    );
  }
  const prospectiveRunId = crypto.randomUUID();
  const requestedOutput =
    options.outputDirectory ??
    (
      options.resumeManifestPath
        ? path.dirname(options.resumeManifestPath)
        : defaultStressOutputDirectory(
            playerRoster,
            opponent.factionId,
            prospectiveRunId,
          )
    );
  let outputDirectory = resolveFromWriteRoot(
    requestedOutput,
    options,
  );
  const restartManifestPath = options.restartManifestPath
    ? resolveFromWriteRoot(options.restartManifestPath, options)
    : undefined;
  const resumeManifestPath = options.resumeManifestPath
    ? resolveFromWriteRoot(options.resumeManifestPath, options)
    : undefined;
  const writeRoot = path.resolve(options.rootDir ?? process.cwd());
  if (
    !options.allowOutsideRoot &&
    (
      !pathInside(writeRoot, outputDirectory) ||
      (
        restartManifestPath !== undefined &&
        !pathInside(writeRoot, restartManifestPath)
      ) ||
      (
        resumeManifestPath !== undefined &&
        !pathInside(writeRoot, resumeManifestPath)
      )
    )
  ) {
    return failure(
      "TESSERA_OUTPUT_OUTSIDE_ROOT",
      "The Tessera output or recovery path is outside the allowed write root.",
      validation.warnings,
    );
  }
  if (outputDirectory === path.parse(outputDirectory).root) {
    return failure(
      "TESSERA_OUTPUT_OUTSIDE_ROOT",
      "A filesystem root cannot be used as the Tessera output directory.",
      validation.warnings,
    );
  }
  const manifestPath =
    resumeManifestPath ??
    path.join(outputDirectory, "stress-manifest.json");
  const sourceManifestPath =
    options.resumeManifestPath
      ? manifestPath
      : restartManifestPath;
  const restarting = restartManifestPath !== undefined;
  let manifest: TesseraStressManifest;
  let resumed = false;
  if (sourceManifestPath) {
    try {
      manifest = await readManifest(sourceManifestPath);
    } catch (error) {
      return failure(
        restarting
          ? "TESSERA_STRESS_RESTART_UNREADABLE"
          : "TESSERA_STRESS_RESUME_UNREADABLE",
        error instanceof Error
          ? error.message
          : "The stress-test recovery manifest could not be read.",
        validation.warnings,
      );
    }
    if (options.catalogueDriftMode === undefined) {
      options = {
        ...options,
        catalogueDriftMode:
          manifest.configuration.catalogueDriftMode,
      };
    }
    if (options.providerCompatibilityMode === undefined) {
      options = {
        ...options,
        providerCompatibilityMode:
          manifest.configuration.providerCompatibilityMode,
      };
    }
    if (options.simulationBackend === undefined) {
      simulationBackend = manifest.simulationBackend;
      options = {
        ...options,
        simulationBackend,
      };
    }
    if (options.scenarioContract === undefined) {
      requestedScenarioContract =
        manifest.requestedScenarioContract;
      options = {
        ...options,
        scenarioContract:
          requestedScenarioContract ?? undefined,
      };
    }
    try {
      if (requestedScenarioContract) {
        assertTesseraScenarioContractProvider(
          requestedScenarioContract,
          selectedSimulationBackend(simulationBackend),
        );
      }
    } catch (error) {
      return failure(
        "TESSERA_SCENARIO_CONTRACT_MISMATCH",
        error instanceof Error
          ? error.message
          : "The requested scenario contract does not match the frozen simulation provider.",
        validation.warnings,
      );
    }
    resumed = !restarting;
    manifest.cachedLiveUpdateCheck =
      freshnessAtEntry?.data ??
      manifest.cachedLiveUpdateCheck;
    manifest.warnings = unique([
      ...manifest.warnings,
      ...freshnessWarningMessages,
    ]);
    const migratedFromV1 =
      (manifest as TesseraStressManifest & {
        __migratedFrom?: number | null;
      }).__migratedFrom === 1;
    if (!options.profilePolicyPath) {
      requestedProfilePolicy = manifest.profilePolicy;
      configuration = stressConfiguration(
        {
          ...options,
          suite: options.suite ?? manifest.configuration.suite,
          analysisStrategy:
            options.analysisStrategy ??
            manifest.configuration.analysisStrategy,
          catalogueDriftMode:
            options.catalogueDriftMode ??
            manifest.configuration.catalogueDriftMode,
        },
        manifest.profilePolicyHash,
      );
    } else {
      configuration = stressConfiguration(
        {
          ...options,
          suite: options.suite ?? manifest.configuration.suite,
          analysisStrategy:
            options.analysisStrategy ??
            manifest.configuration.analysisStrategy,
          catalogueDriftMode:
            options.catalogueDriftMode ??
            manifest.configuration.catalogueDriftMode,
        },
        configuration.profilePolicyHash,
      );
    }
    if (
      options.executionMode === undefined &&
      options.experimental === undefined
    ) {
      simulationRequested = manifest.simulationRequested;
    }
    const requestedEnrichedPolicyValidation =
      manifest.enrichedProfileRequirements
        ? validateProfilePolicy(
            manifest.enrichedProfileRequirements,
            requestedProfilePolicy,
          )
        : null;
    const canAdoptEnrichedProfilePolicy =
      requestedEnrichedPolicyValidation?.valid === true &&
      !manifestHasSimulationAttempts(manifest);
    if (
      !options.allowOutsideRoot &&
      !pathInside(
        options.rootDir ?? process.cwd(),
        manifest.outputDirectory,
      )
    ) {
      return failure(
        "TESSERA_STRESS_RESUME_OUTSIDE_ROOT",
        "The resume manifest points outside the allowed write root. Move the run under the root or explicitly allow that location.",
        validation.warnings,
      );
    }
    if (restarting) {
      if (
        path.resolve(outputDirectory) ===
          path.resolve(manifest.outputDirectory) ||
        path.resolve(manifestPath) ===
          path.resolve(sourceManifestPath)
      ) {
        return failure(
          "TESSERA_STRESS_RESTART_OUTPUT_COLLISION",
          "A restarted run needs a new --out-dir so its fresh manifest and reports cannot overwrite the source run.",
          validation.warnings,
        );
      }
    } else {
      outputDirectory = manifest.outputDirectory;
    }
    const legacyConfigurationMatches =
      migratedFromV1 &&
      canonicalJson({
        ...manifest.configuration,
        profilePolicyHash: configuration.profilePolicyHash,
      }) === canonicalJson(configuration);
    const enrichedPolicyConfigurationMatches =
      canAdoptEnrichedProfilePolicy &&
      configurationMatchesExceptProfilePolicy(
        manifest.configuration,
        configuration,
      );
    if (
      manifest.playerFingerprint !==
        rosterExecutionFingerprint(playerRoster) ||
      manifest.opponentFactionId !== opponent.factionId ||
      manifest.simulationRequested !==
        simulationRequested ||
      manifest.simulationBackend !== simulationBackend ||
      manifest.selectedSimulationBackend !==
        selectedSimulationBackend(simulationBackend) ||
      manifest.requestedScenarioContractSha256 !==
        (requestedScenarioContract
          ? tesseraScenarioContractSha256(
              requestedScenarioContract,
            )
          : null) ||
      (
        !configurationMatches(manifest.configuration, configuration) &&
        !legacyConfigurationMatches &&
        !enrichedPolicyConfigurationMatches
      )
    ) {
      return failure(
        "TESSERA_STRESS_RESUME_MISMATCH",
        "The resume manifest does not match this player roster, opponent faction, suite, analysis strategy, simulation provider, scenario contract, or catalogue-drift policy.",
        validation.warnings,
      );
    }
    if (
      canonicalJson(manifest.playerSourceData) !==
      canonicalJson(playerRoster.sourceData)
    ) {
      return failure(
        "TESSERA_STRESS_DATA_PIN_CHANGED",
        "The player roster data bundle differs from the frozen resume manifest. Start a new stress test instead of mixing bundle snapshots.",
        validation.warnings,
      );
    }
    if (
      sharedSourcePin(manifest.playerSourceData) !==
      sharedSourcePin(manifest.portfolio.sourceData)
    ) {
      return failure(
        "TESSERA_STRESS_DATA_PIN_CHANGED",
        "The resume manifest mixes player and opponent portfolio bundle snapshots. Start a new stress test instead of reusing mixed data.",
        validation.warnings,
      );
    }
    if (migratedFromV1) {
      const legacyPolicyValidation = validateProfilePolicy(
        aggregateProfileRequirements([
          playerRoster,
          ...manifest.portfolio.items.flatMap((item) =>
            item.roster ? [item.roster] : [],
          ),
        ]),
        requestedProfilePolicy,
      );
      if (!legacyPolicyValidation.valid) {
        return failure(
          "TESSERA_PROFILE_POLICY_REQUIRED",
          "This v1 manifest was migrated in memory, but resuming it requires an explicit complete profile policy. Supply --profile-policy; RosterPilot will not infer prior weapon-profile choices.",
          validation.warnings,
        );
      }
      manifest.profilePolicy = requestedProfilePolicy;
      manifest.profilePolicyHash = legacyPolicyValidation.hash;
      manifest.configuration.profilePolicyHash =
        legacyPolicyValidation.hash;
      configuration = {
        ...configuration,
        profilePolicyHash: legacyPolicyValidation.hash,
      };
      try {
        if (restarting) {
          // A restart writes only the new v2 manifest below. The v1 source
          // remains an immutable recovery record.
        } else {
        await writeManifest(manifest, manifestPath, options, true);
        }
      } catch (error) {
        return failure(
          "WRITE_FAILED",
          error instanceof Error
            ? error.message
            : "The migrated v2 stress manifest could not be written.",
          validation.warnings,
        );
      }
    }
    if (manifest.finalArtifacts && !restarting) {
      const jsonPresent = await pathExists(
        manifest.finalArtifacts.json,
      );
      const htmlPresent = await pathExists(
        manifest.finalArtifacts.html,
      );
      const jsonMatches =
        !jsonPresent ||
        manifest.finalArtifacts.jsonSha256 === null ||
        (
          (await fileSha256(manifest.finalArtifacts.json)) ===
            manifest.finalArtifacts.jsonSha256
        );
      const htmlMatches =
        !htmlPresent ||
        manifest.finalArtifacts.htmlSha256 === null ||
        (
          (await fileSha256(manifest.finalArtifacts.html)) ===
            manifest.finalArtifacts.htmlSha256
        );
      if (!jsonMatches || !htmlMatches) {
        return failure(
          "TESSERA_STRESS_FINAL_ARTIFACT_CHANGED",
          "A manifest-owned final report artifact has changed. Refusing to overwrite or resume from mixed output.",
          validation.warnings,
        );
      }
      if (
        manifest.completedAt &&
        manifest.finalArtifacts.jsonSha256 !== null &&
        manifest.finalArtifacts.htmlSha256 !== null &&
        jsonPresent &&
        htmlPresent &&
        !manifestHasRetryableWork(manifest)
      ) {
        try {
          const completed = await readStressBaseline(
            manifest.finalArtifacts.json,
          );
          const portfolioHashWasMigrated =
            (manifest as TesseraStressManifest & {
              __portfolioHashMigrated?: boolean;
            }).__portfolioHashMigrated === true;
          if (
            portfolioHashWasMigrated &&
            completed.portfolioSha256 !==
              manifest.portfolioSha256 &&
            portfolioIdentityWithoutDerivedCoverage(
              completed.portfolio,
            ) ===
              portfolioIdentityWithoutDerivedCoverage(
                manifest.portfolio,
              )
          ) {
            manifest.portfolio = completed.portfolio;
            manifest.portfolioSha256 =
              completed.portfolioSha256;
          }
          if (
            portfolioHashWasMigrated &&
            completed.portfolioSha256 ===
              manifest.portfolioSha256
          ) {
            await writeManifest(
              manifest,
              manifestPath,
              options,
              true,
            );
          }
          if (
            completed.runId !== manifest.runId ||
            completed.opponentFactionId !==
              manifest.opponentFactionId ||
            completed.portfolioSha256 !==
              manifest.portfolioSha256 ||
            !configurationMatches(
              completed.configuration,
              manifest.configuration,
            ) ||
            completed.missionReadiness.rosterFingerprint !==
              manifest.playerFingerprint
          ) {
            throw new Error(
              "The completed report identity does not match its manifest.",
            );
          }
          if (
            manifest.enrichedProfileRequirements !== null &&
            (
              !manifest.simulationRequested ||
              stressReportHasVerifiedMatrixIntegrity(completed)
            )
          ) {
            return {
              ok: true,
              data: completed,
              violations: [],
              warnings: completed.warnings.map((message) =>
                issue(
                  "TESSERA_STRESS_WARNING",
                  message,
                  "warn",
                ),
              ),
            };
          }
          if (manifest.enrichedProfileRequirements === null) {
            manifest.warnings = unique([
              ...manifest.warnings,
              "The prior completed report predates enriched profile-inventory provenance; prepared artifacts and the frozen policy will be revalidated before its child reports are reused.",
            ]);
          }
          if (
            manifest.simulationRequested &&
            !stressReportHasVerifiedMatrixIntegrity(completed)
          ) {
            manifest.warnings = unique([
              ...manifest.warnings,
              "The prior completed report predates verified matrix fingerprints; its frozen child reports will be revalidated and recaptured as needed.",
            ]);
            for (const stage of [
              manifest.screening,
              manifest.deepDive,
            ]) {
              for (const entry of Object.values(stage)) {
                if (entry.status !== "complete") continue;
                entry.error = structuredStageError(
                  "TESSERA_MATRIX_FINGERPRINT_MISSING",
                  "The stored child report predates verified matrix fingerprints and must be recaptured.",
                );
                entry.nextAction = stageNextAction(entry);
              }
            }
          }
        } catch (error) {
          return failure(
            "TESSERA_STRESS_FINAL_REPORT_INVALID",
            error instanceof Error
              ? error.message
              : "The completed report could not be validated.",
            validation.warnings,
          );
        }
      }
    }
    const preflight = await preflightPortfolio(
      playerRoster,
      manifest.portfolio,
    );
    if (!preflight.ok || !preflight.data) {
      return failure(
        "TESSERA_STRESS_RESUME_PORTFOLIO_CHANGED",
        preflight.violations[0]?.message ??
          "The frozen portfolio no longer passes v2 preflight.",
        [
          ...validation.warnings,
          ...preflight.warnings,
        ],
      );
    }
    if (
      canonicalJson(preflight.data) !==
      canonicalJson(manifest.portfolio)
    ) {
      return failure(
        "TESSERA_STRESS_RESUME_PORTFOLIO_CHANGED",
        "A previously ready frozen proxy no longer passes local New Recruit mapping preflight. Resume will not shrink or replace the frozen portfolio; restore the pinned environment or start a new run.",
        [
          ...validation.warnings,
          ...preflight.warnings,
        ],
      );
    }
    const profileValidation = validateProfilePolicy(
      manifest.enrichedProfileRequirements ??
        aggregateProfileRequirements([
          playerRoster,
          ...manifest.portfolio.items.flatMap((item) =>
            item.roster ? [item.roster] : [],
          ),
        ]),
      requestedProfilePolicy,
    );
    if (
      !profileValidation.valid ||
      (
        profileValidation.hash !== manifest.profilePolicyHash &&
        !canAdoptEnrichedProfilePolicy
      )
    ) {
      return failure(
        manifest.enrichedProfileRequirements &&
          !profileValidation.valid &&
          !manifestHasSimulationAttempts(manifest)
          ? "TESSERA_PROFILE_POLICY_REQUIRED"
          : "TESSERA_STRESS_RESUME_PROFILE_POLICY_CHANGED",
        manifest.enrichedProfileRequirements &&
          !profileValidation.valid &&
          !manifestHasSimulationAttempts(manifest)
          ? "The supplied policy does not resolve every profile decision found in the prepared New Recruit archives. Complete the generated policy scaffold, then resume this manifest to reuse those artifacts."
          : "The supplied profile policy is incomplete, invalid, or differs from the policy frozen in this run. Resume and paired revisions require the exact canonical policy hash.",
        validation.warnings,
      );
    }
    if (
      canAdoptEnrichedProfilePolicy &&
      profileValidation.hash !== manifest.profilePolicyHash
    ) {
      manifest.profilePolicy = requestedProfilePolicy;
      manifest.profilePolicyHash = profileValidation.hash;
      manifest.configuration.profilePolicyHash =
        profileValidation.hash;
      configuration = {
        ...configuration,
        profilePolicyHash: profileValidation.hash,
      };
      manifest.warnings = unique([
        ...manifest.warnings,
        "A completed policy was frozen against the verified New Recruit-enriched profile inventory before any Tessera simulation attempts.",
      ]);
    }
    manifest.warnings = unique([
      ...manifest.warnings,
      ...validation.warnings.map((warning) => warning.message),
      ...preflight.warnings.map((warning) => warning.message),
    ]);
    if (restarting) {
      const sourceManifest = manifest;
      const restartedManifest = newManifest(
        playerRoster,
        sourceManifest.opponentFactionId,
        sourceManifest.portfolio,
        sourceManifest.configuration,
        outputDirectory,
        sourceManifest.simulationRequested,
        sourceManifest.simulationBackend,
        sourceManifest.profilePolicy,
        unique([
          ...sourceManifest.warnings,
          `Restarted cleanly from run ${sourceManifest.runId}; only verified prepared artifacts are eligible for reuse.`,
        ]),
        prospectiveRunId,
        freshnessAtEntry?.data ??
          sourceManifest.cachedLiveUpdateCheck,
        sourceManifest.requestedScenarioContract,
      );
      restartedManifest.preparedPlayer =
        sourceManifest.preparedPlayer;
      restartedManifest.preparedPlayerSha256 =
        sourceManifest.preparedPlayerSha256;
      restartedManifest.preparedOpponents = {
        ...sourceManifest.preparedOpponents,
      };
      restartedManifest.enrichedProfileRequirements =
        sourceManifest.enrichedProfileRequirements;
      restartedManifest.stageContracts = cloneStageContracts(
        sourceManifest.stageContracts,
      );
      manifest = restartedManifest;
      try {
        await materializeManifestPreparedArtifacts(
          manifest,
          outputDirectory,
        );
        await resolveExportArtifactTargets(
          [
            {
              format: "roster-json",
              filename: path.basename(manifestPath),
              mimeType: "application/json",
              encoding: "utf8",
              content: "",
            },
          ],
          path.dirname(manifestPath),
          options,
        );
        await finalStressTargets(
          playerRoster,
          manifest.portfolio,
          outputDirectory,
          options,
        );
        await writeManifest(
          manifest,
          manifestPath,
          options,
          options.overwrite === true,
        );
      } catch (error) {
        const outputFailure = tesseraOutputFailure(error);
        const materializationCode =
          materializationFailureCode(error);
        return failure(
          materializationCode ===
              "TESSERA_STRESS_BUNDLE_ARTIFACT_WRITE_FAILED"
            ? outputFailure.code
            : materializationCode,
          materializationCode ===
              "TESSERA_STRESS_BUNDLE_ARTIFACT_WRITE_FAILED"
            ? outputFailure.message
            : error instanceof Error
              ? error.message
              : "The restarted stress-test manifest could not be created.",
          [
            ...validation.warnings,
            ...preflight.warnings,
          ],
        );
      }
    } else {
      try {
        await writeManifest(manifest, manifestPath, options, true);
      } catch (error) {
        return failure(
          "WRITE_FAILED",
          error instanceof Error
            ? error.message
            : "The stress-test resume manifest could not be updated.",
          [
            ...validation.warnings,
            ...preflight.warnings,
          ],
        );
      }
    }
  } else {
    const frozenPreview = options.portfolioPreview;
    if (
      frozenPreview &&
      (
        frozenPreview.portfolio.factionId !== opponent.factionId ||
        frozenPreview.portfolio.pointsLimit !==
          playerRoster.pointsLimit ||
        frozenPreview.portfolio.suite !== configuration.suite
      )
    ) {
      return failure(
        "TESSERA_STRESS_FROZEN_PORTFOLIO_MISMATCH",
        "The frozen portfolio preview does not match the requested opponent faction, points limit, or suite.",
        validation.warnings,
      );
    }
    const generated = frozenPreview
      ? {
          ok: true,
          data: frozenPreview.portfolio,
          violations: [],
          warnings: [],
        }
      : generateFactionStressPortfolio({
          faction: opponent.factionId,
          pointsLimit: playerRoster.pointsLimit,
          suite: configuration.suite,
          pointsTolerancePercent:
            configuration.pointsTolerancePercent,
          allowLegends: false,
        });
    if (!generated.ok || !generated.data) {
      return {
        ok: false,
        data: null,
        violations: generated.violations,
        warnings: [...validation.warnings, ...generated.warnings],
      };
    }
    const preflight = await preflightPortfolio(
      playerRoster,
      generated.data,
    );
    if (!preflight.ok || !preflight.data) {
      return {
        ok: false,
        data: null,
        violations: preflight.violations,
        warnings: [
          ...validation.warnings,
          ...generated.warnings,
          ...preflight.warnings,
        ],
      };
    }
    if (
      sharedSourcePin(playerRoster.sourceData) !==
      sharedSourcePin(preflight.data.sourceData)
    ) {
      return failure(
        "TESSERA_STRESS_DATA_PIN_CHANGED",
        "The player roster and generated opponent portfolio use different frozen data bundles. Rebase or rebuild the player roster before starting external activity.",
        [
          ...validation.warnings,
          ...generated.warnings,
          ...preflight.warnings,
        ],
      );
    }
    const profileRequirements = aggregateProfileRequirements([
      playerRoster,
      ...preflight.data.items.flatMap((item) =>
        item.roster ? [item.roster] : [],
      ),
    ]);
    const profileValidation = validateProfilePolicy(
      profileRequirements,
      requestedProfilePolicy,
    );
    if (!profileValidation.valid) {
      let scaffoldPath: string | null = null;
      try {
        scaffoldPath = await writeProfilePolicyScaffold(
          outputDirectory,
          profileRequirements,
          options,
        );
      } catch {
        // The policy requirement remains actionable even if the scaffold
        // cannot be written; the primary failure below is still accurate.
      }
      const detail = [
        ...profileValidation.errors,
        ...profileValidation.unresolved.map(
          (requirement) =>
            `${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase}: choose one of ${requirement.availableProfiles.join(", ")} for ${requirement.activeCount} active weapon(s).`,
        ),
      ].join(" ");
      return failure(
        "TESSERA_PROFILE_POLICY_REQUIRED",
        `Explicit weapon-profile choices are required before New Recruit or Tessera activity. ${detail}${
          scaffoldPath ? ` Complete the scaffold at ${scaffoldPath}.` : ""
        }`,
        [
          ...validation.warnings,
          ...generated.warnings,
          ...preflight.warnings,
        ],
      );
    }
    configuration = stressConfiguration(
      options,
      profileValidation.hash,
    );
    const initialWarnings = [
      ...validation.warnings,
      ...generated.warnings,
      ...preflight.warnings,
    ].map((warning) => warning.message);
    initialWarnings.push(...freshnessWarningMessages);
    manifest = newManifest(
      playerRoster,
      preflight.data.factionId,
      preflight.data,
      configuration,
      outputDirectory,
      simulationRequested,
      simulationBackend,
      requestedProfilePolicy,
      initialWarnings,
      prospectiveRunId,
      freshnessAtEntry?.data ?? null,
      requestedScenarioContract,
    );
    try {
      await resolveExportArtifactTargets(
        [
          {
            format: "roster-json",
            filename: path.basename(manifestPath),
            mimeType: "application/json",
            encoding: "utf8",
            content: "",
          },
        ],
        path.dirname(manifestPath),
        options,
      );
      await finalStressTargets(
        playerRoster,
        preflight.data,
        outputDirectory,
        options,
      );
      await writeManifest(
        manifest,
        manifestPath,
        options,
        options.overwrite === true,
      );
    } catch (error) {
      const outputFailure = tesseraOutputFailure(error);
      return failure(
        outputFailure.code,
        outputFailure.message,
        [...validation.warnings, ...generated.warnings],
      );
    }
  }
  const result = await executeStressTest({
    playerRoster,
    portfolio: manifest.portfolio,
    configuration: manifest.configuration,
    outputDirectory,
    manifestPath,
    manifest,
    resumed,
    options: {
      ...options,
      outputDirectory,
      overwrite: resumed ? options.overwrite : options.overwrite,
    },
    dependencies,
    frozenRepresentatives:
      resumed &&
      manifest.representatives.length ===
        requiredStressEvidence(manifest.portfolio).representatives
        ? manifest.representatives
        : undefined,
  });
  if (
    manifest.simulationRequested &&
    !dependencies.runBrowser &&
    !manifestHasRetryableWork(manifest)
  ) {
    await closeTesseraLocalAgentSession(manifest.runId).catch(
      () => undefined,
    );
  }
  return result;
}

function baselineOpponentPaths(
  baselineManifest: TesseraStressManifest,
): Map<string, string> {
  return new Map(
    Object.entries(baselineManifest.preparedOpponents).map(
      ([templateId, receipt]) => [
        templateId,
        receipt.prepared.enrichedRoszPath,
      ],
    ),
  );
}

function sampleDelta(
  templateId: string,
  baseline: TesseraStressTestReport,
  revised: TesseraStressTestReport,
  materiality: number,
): TesseraStressRevisionSampleDelta {
  const before =
    baseline.robustness?.samples.find(
      (sample) => sample.templateId === templateId,
    ) ?? null;
  const after =
    revised.robustness?.samples.find(
      (sample) => sample.templateId === templateId,
    ) ?? null;
  const offenseChange =
    before?.offensiveCoverage !== null &&
    before?.offensiveCoverage !== undefined &&
    after?.offensiveCoverage !== null &&
    after?.offensiveCoverage !== undefined
      ? after.offensiveCoverage - before.offensiveCoverage
      : null;
  const exposureChange =
    before?.threatExposure !== null &&
    before?.threatExposure !== undefined &&
    after?.threatExposure !== null &&
    after?.threatExposure !== undefined
      ? after.threatExposure - before.threatExposure
      : null;
  const marginChange =
    before?.coverageMargin !== null &&
    before?.coverageMargin !== undefined &&
    after?.coverageMargin !== null &&
    after?.coverageMargin !== undefined
      ? after.coverageMargin - before.coverageMargin
      : null;
  let classification: TesseraStressRevisionSampleDelta["classification"] =
    "ambiguous";
  if (
    marginChange !== null &&
    before?.status === "confident" &&
    after?.status === "confident"
  ) {
    classification =
      Math.abs(marginChange) < materiality
        ? "unchanged"
        : marginChange > 0
          ? "improved"
          : "worsened";
  }
  return {
    templateId,
    before,
    after,
    offenseChange,
    exposureChange,
    marginChange,
    classification,
  };
}

async function readStressBaseline(
  filename: string,
): Promise<TesseraStressTestReport> {
  const raw = JSON.parse(await readFile(filename, "utf8")) as {
    schemaVersion?: number;
  };
  const parsed = StressBaselineSchema.safeParse(
    raw,
  );
  if (!parsed.success) {
    throw new Error(
      `Revision comparison requires a compatible stress-test report: ${parsed.error.issues[0]?.message ?? "schema validation failed"}.`,
    );
  }
  const normalizedPortfolio = normalizePortfolioCoverage(
    parsed.data.portfolio as unknown as TesseraStressPortfolio,
  );
  const computedPortfolioSha256 =
    portfolioContentSha256(normalizedPortfolio);
  if (
    parsed.data.portfolioSha256 !== undefined &&
    parsed.data.portfolioSha256 !== computedPortfolioSha256
  ) {
    throw new Error(
      "The stress-test report's frozen portfolio content does not match portfolioSha256.",
    );
  }
  const report = {
    ...parsed.data,
    schemaVersion: 2 as const,
    portfolioSha256: computedPortfolioSha256,
    portfolio: normalizedPortfolio,
    configuration: {
      ...parsed.data.configuration,
      profilePolicyHash:
        parsed.data.configuration.profilePolicyHash ?? null,
    },
    stageProvenance: {
      screening: {
        ...parsed.data.stageProvenance.screening,
        profilePolicyHash:
          parsed.data.stageProvenance.screening.profilePolicyHash ?? null,
      },
      deepDive: parsed.data.stageProvenance.deepDive
        ? {
            ...parsed.data.stageProvenance.deepDive,
            profilePolicyHash:
              parsed.data.stageProvenance.deepDive.profilePolicyHash ?? null,
          }
        : null,
    },
    robustness: parsed.data.robustness
      ? {
          ...parsed.data.robustness,
          scoreDefinitionVersion: "stress-robustness-v2" as const,
          samples: parsed.data.robustness.samples.map((sample) => ({
            ...sample,
            provisional: sample.provisional ?? null,
          })),
        }
      : null,
  } as unknown as TesseraStressTestReport;
  Object.defineProperty(report, "__migratedFrom", {
    value: raw.schemaVersion === 1 ? 1 : null,
    enumerable: false,
  });
  return report;
}

export async function compareRosterStressRevision(
  baselineReportPath: string,
  revisedRoster: RosterDraftV1,
  options: TesseraStressOptions = {},
  dependencies: TesseraStressDependencies = {},
): Promise<ResultEnvelope<TesseraStressRevisionReport>> {
  const resolvedBaselineReportPath = resolveFromWriteRoot(
    baselineReportPath,
    options,
  );
  const revisionWriteRoot = path.resolve(
    options.rootDir ?? process.cwd(),
  );
  if (
    !options.allowOutsideRoot &&
    (
      !pathInside(revisionWriteRoot, resolvedBaselineReportPath) ||
      (
        options.outputDirectory !== undefined &&
        !pathInside(
          revisionWriteRoot,
          resolveFromWriteRoot(options.outputDirectory, options),
        )
      )
    )
  ) {
    return failure(
      "TESSERA_OUTPUT_OUTSIDE_ROOT",
      "The Tessera baseline or revision output path is outside the allowed write root.",
    );
  }
  let baseline: TesseraStressTestReport;
  try {
    baseline = await readStressBaseline(resolvedBaselineReportPath);
  } catch (error) {
    return failure(
      "TESSERA_STRESS_BASELINE_UNREADABLE",
      error instanceof Error
        ? error.message
      : "The faction stress-test baseline could not be read.",
    );
  }
  if (
    (baseline as TesseraStressTestReport & {
      __migratedFrom?: number | null;
    }).__migratedFrom === 1
  ) {
    return failure(
      "TESSERA_STRESS_BASELINE_PROFILE_PROVENANCE_REQUIRED",
      "The paired revision baseline does not contain exact v2 profile-policy provenance. Run a new v2 stress test; RosterPilot will not infer the missing profile choices.",
    );
  }
  const baselineManifestArtifact = baseline.artifacts.find(
    (artifact) => artifact.format === "stress-manifest",
  );
  if (!baselineManifestArtifact) {
    return failure(
      "TESSERA_STRESS_BASELINE_PROVENANCE_INVALID",
      "Revision comparison requires the baseline's stress manifest so the report and frozen run can be verified.",
    );
  }
  const resolvedBaselineManifestPath = path.isAbsolute(
    baselineManifestArtifact.written,
  )
    ? baselineManifestArtifact.written
    : path.resolve(
        path.dirname(resolvedBaselineReportPath),
        baselineManifestArtifact.written,
      );
  let baselineManifest: TesseraStressManifest;
  let baselineReportSha256: string;
  try {
    [baselineManifest, baselineReportSha256] = await Promise.all([
      readManifest(resolvedBaselineManifestPath),
      fileSha256(resolvedBaselineReportPath),
    ]);
  } catch (error) {
    return failure(
      "TESSERA_STRESS_BASELINE_PROVENANCE_INVALID",
      error instanceof Error
        ? error.message
      : "The baseline manifest or report hash could not be verified.",
    );
  }
  const baselineProfileProvenance =
    baselineManifest.enrichedProfileRequirements === null
      ? null
      : validateProfilePolicy(
          baselineManifest.enrichedProfileRequirements,
          baselineManifest.profilePolicy,
        );
  if (
    !baselineProfileProvenance?.valid ||
    baselineProfileProvenance.hash !==
      baselineManifest.profilePolicyHash
  ) {
    return failure(
      "TESSERA_STRESS_BASELINE_PROFILE_PROVENANCE_REQUIRED",
      "The paired revision baseline does not retain a policy verified against the complete New Recruit-enriched profile inventory. Run a new v2 baseline; RosterPilot will not infer the missing choices.",
    );
  }
  const baselineScreeningContractTemplates =
    baselineManifest.portfolio.items
      .filter(
        (item) => item.status === "ready" && item.roster !== null,
      )
      .map((item) => item.templateId);
  const baselineDeepDiveContractTemplates =
    baselineManifest.configuration.analysisStrategy === "staged"
      ? baselineManifest.representatives.map(
          (representative) => representative.templateId,
        )
      : [];
  if (
    baselineScreeningContractTemplates.some(
      (templateId) =>
        stageContractFor(
          baselineManifest,
          "screening",
          templateId,
        ) === null,
    ) ||
    baselineDeepDiveContractTemplates.some(
      (templateId) =>
        stageContractFor(
          baselineManifest,
          "deepDive",
          templateId,
        ) === null,
    )
  ) {
    return failure(
      "TESSERA_STRESS_BASELINE_SETTINGS_PROVENANCE_REQUIRED",
      "The paired revision baseline does not retain an exact frozen Tessera settings and iteration contract for every required proxy. Run a new baseline; RosterPilot will not infer missing execution settings.",
    );
  }
  if (
    !baselineManifest.completedAt ||
    !baselineManifest.simulationRequested ||
    baselineManifest.runId !== baseline.runId ||
    baselineManifest.opponentFactionId !==
      baseline.opponentFactionId ||
    baselineManifest.playerFingerprint !==
      baseline.missionReadiness.rosterFingerprint ||
    canonicalJson(baselineManifest.playerSourceData) !==
      canonicalJson(baseline.missionReadiness.sourceData) ||
    !configurationMatches(
      baselineManifest.configuration,
      baseline.configuration,
    ) ||
    baselineManifest.portfolioSha256 !==
      baseline.portfolioSha256 ||
    canonicalJson(baselineManifest.portfolio) !==
      canonicalJson(baseline.portfolio) ||
    canonicalJson(baselineManifest.representatives) !==
      canonicalJson(baseline.representatives) ||
    !baselineManifest.finalArtifacts ||
    path.resolve(baselineManifest.finalArtifacts.json) !==
      resolvedBaselineReportPath ||
    baselineManifest.finalArtifacts.jsonSha256 !==
      baselineReportSha256
  ) {
    return failure(
      "TESSERA_STRESS_BASELINE_PROVENANCE_INVALID",
      "The baseline report does not match its completed stress manifest, frozen portfolio, representatives, or recorded content hash.",
    );
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
  if (revisedRoster.factionId !== baseline.player.factionId) {
    return failure(
      "TESSERA_STRESS_REVISION_FACTION_CHANGED",
      "The revised roster must use the same faction as the baseline player roster.",
      validation.warnings,
    );
  }
  if (revisedRoster.pointsLimit !== baseline.portfolio.pointsLimit) {
    return failure(
      "TESSERA_STRESS_REVISION_POINTS_CHANGED",
      "The revised roster must use the same points limit as the frozen baseline.",
      validation.warnings,
    );
  }
  if (
    canonicalJson(revisedRoster.sourceData) !==
    canonicalJson(baseline.missionReadiness.sourceData)
  ) {
    return failure(
      "TESSERA_STRESS_DATA_PIN_CHANGED",
      "The revised roster must use the same frozen data bundle as the baseline.",
      validation.warnings,
    );
  }
  if (
    options.catalogueDriftMode !== undefined &&
    options.catalogueDriftMode !==
      baseline.configuration.catalogueDriftMode
  ) {
    return failure(
      "TESSERA_STRESS_REVISION_CONFIGURATION_CHANGED",
      "The paired revision must use the catalogue-drift policy frozen in the baseline stress report.",
      validation.warnings,
    );
  }
  options = {
    ...options,
    catalogueDriftMode:
      baseline.configuration.catalogueDriftMode,
  };
  if (
    sharedSourcePin(baseline.missionReadiness.sourceData) !==
    sharedSourcePin(baseline.portfolio.sourceData)
  ) {
    return failure(
      "TESSERA_STRESS_DATA_PIN_CHANGED",
      "The baseline mixes player and opponent portfolio bundle snapshots, so it cannot support a paired revision comparison.",
      validation.warnings,
    );
  }
  const playerPreflight = await preflightPlayerRoster(revisedRoster);
  if (!playerPreflight.ok) {
    return {
      ok: false,
      data: null,
      violations: playerPreflight.violations,
      warnings: [
        ...validation.warnings,
        ...playerPreflight.warnings,
      ],
    };
  }
  const revisionProfileValidation = validateProfilePolicy(
    aggregateProfileRequirements([
      revisedRoster,
      ...baseline.portfolio.items.flatMap((item) =>
        item.roster ? [item.roster] : [],
      ),
    ]),
    baselineManifest.profilePolicy,
  );
  if (
    !revisionProfileValidation.valid ||
    revisionProfileValidation.hash !==
      baseline.configuration.profilePolicyHash
  ) {
    return failure(
      "TESSERA_STRESS_REVISION_PROFILE_POLICY_CHANGED",
      "The revised roster requires profile choices that are not covered by the exact canonical policy frozen in the baseline. Create a new baseline rather than changing profiles inside a paired revision.",
      validation.warnings,
    );
  }
  const readyItems = baseline.portfolio.items.filter(
    (
      item,
    ): item is TesseraStressPortfolioItem & {
      roster: RosterDraftV1;
    } => item.status === "ready" && item.roster !== null,
  );
  const readyTemplateIds = readyItems.map(
    (item) => item.templateId,
  );
  const baselineRobustness = baseline.robustness;
  if (!baselineRobustness) {
    return failure(
      "TESSERA_STRESS_BASELINE_INCOMPLETE",
      "Revision comparison requires baseline robustness samples.",
      validation.warnings,
    );
  }
  if (!stressReportHasVerifiedMatrixIntegrity(baseline)) {
    return failure(
      "TESSERA_STRESS_BASELINE_INTEGRITY_REQUIRED",
      "Paired revision comparison requires a baseline with verified v2 matrix-integrity fingerprints. Run a new baseline instead of pairing against unverified or aliased capture evidence.",
      validation.warnings,
    );
  }
  const requiredSamples =
    baseline.suite === "diverse-9" ? 6 : 3;
  const usableSamples =
    baselineRobustness.samples.filter(
      (sample) => sample.status === "confident",
    ).length;
  const representedPostures = new Set(
    baselineRobustness.samples
      .filter((sample) => sample.status === "confident")
      .map((sample) => sample.posture),
  );
  const representativeKinds = new Set(
    baseline.representatives.map(
      (representative) => representative.kind,
    ),
  );
  const representativeTemplates = new Set(
    baseline.representatives.map(
      (representative) => representative.templateId,
    ),
  );
  const representativesUseFrozenTemplates =
    baseline.representatives.every((representative) =>
      readyTemplateIds.includes(representative.templateId),
    );
  const screeningMetrics =
    baseline.configuration.analysisStrategy === "full-all"
      ? FULL_METRICS
      : SCREENING_METRICS;
  const screeningMode =
    baseline.configuration.analysisStrategy === "full-all"
      ? "full"
      : "quick";
  const expectedScreeningProvenance = {
    analysisMode: screeningMode,
    phases: ["shooting", "fight"],
    metrics: screeningMetrics,
    directions: [
      "player-to-opponent",
      "opponent-to-player",
    ],
  };
  const expectedDeepDiveProvenance = {
    analysisMode:
      baseline.configuration.analysisStrategy === "full-all"
        ? screeningMode
        : "full",
    phases: ["shooting", "fight"],
    metrics:
      baseline.configuration.analysisStrategy === "full-all"
        ? screeningMetrics
        : DEEP_DIVE_METRICS,
    directions: [
      "player-to-opponent",
      "opponent-to-player",
    ],
  };
  const baselineScreeningShape = {
    analysisMode:
      baseline.stageProvenance.screening.analysisMode,
    phases: baseline.stageProvenance.screening.phases,
    metrics: baseline.stageProvenance.screening.metrics,
    directions: baseline.stageProvenance.screening.directions,
  };
  const baselineDeepDiveShape = baseline.stageProvenance.deepDive
    ? {
        analysisMode:
          baseline.stageProvenance.deepDive.analysisMode,
        phases: baseline.stageProvenance.deepDive.phases,
        metrics: baseline.stageProvenance.deepDive.metrics,
        directions: baseline.stageProvenance.deepDive.directions,
      }
    : null;
  const screeningProxyRuns =
    baseline.stageProvenance.screening.proxyRuns;
  const deepDiveProxyRuns =
    baseline.stageProvenance.deepDive?.proxyRuns ?? [];
  const screeningProxyTemplates = new Set(
    screeningProxyRuns.map((run) => run.templateId),
  );
  const deepDiveProxyTemplates = new Set(
    deepDiveProxyRuns.map((run) => run.templateId),
  );
  const expectedDeepDiveTemplates =
    baseline.configuration.analysisStrategy === "full-all"
      ? readyTemplateIds
      : baseline.representatives.map(
          (representative) => representative.templateId,
        );
  const deepDiveItems = expectedDeepDiveTemplates
    .map((templateId) =>
      readyItems.find((item) => item.templateId === templateId),
    )
    .filter(
      (
        item,
      ): item is TesseraStressPortfolioItem & {
        roster: RosterDraftV1;
      } => item !== undefined,
    );
  const screeningStageError = baseline.screeningReport
    ? combinedStageValidationError(
        baseline.screeningReport,
        baseline.player,
        readyItems,
        screeningMetrics,
        screeningMode,
        true,
      )
    : "the screening report is missing";
  const deepDiveStageError = baseline.deepDiveReport
    ? combinedStageValidationError(
        baseline.deepDiveReport,
        baseline.player,
        deepDiveItems,
        baseline.configuration.analysisStrategy === "full-all"
          ? screeningMetrics
          : DEEP_DIVE_METRICS,
        "full",
        baseline.configuration.analysisStrategy === "full-all",
      )
    : "the deep-dive report is missing";
  const screeningScenarioProvenanceMatches =
    baseline.screeningReport !== null &&
    stageProxyProvenanceMatches(
      baseline.screeningReport,
      screeningProxyRuns,
      readyItems,
    );
  const deepDiveScenarioProvenanceMatches =
    baseline.deepDiveReport !== null &&
    stageProxyProvenanceMatches(
      baseline.deepDiveReport,
      deepDiveProxyRuns,
      deepDiveItems,
    );
  const baselineSelectedBackend =
    baseline.simulation?.selectedBackend ?? "website";
  const baselineExpectedSource =
    baselineSelectedBackend === "local-engine"
      ? "tessera-local-engine"
      : "tessera-ui";
  const baselineProviderClaimsAllowed =
    simulationProviderAllowsAnalyticalClaims(
      baselineSelectedBackend,
      baseline.simulation?.providerIdentity,
    );
  if (
    baseline.source !== baselineExpectedSource ||
    !baselineProviderClaimsAllowed ||
    !["complete", "degraded"].includes(baseline.status) ||
    usableSamples < requiredSamples ||
    representedPostures.size !== 3 ||
    baseline.screeningReport?.status !== "complete" ||
    (baseline.configuration.analysisStrategy === "staged" &&
      baseline.deepDiveReport?.status !== "complete") ||
    baseline.representatives.length !== 3 ||
    deepDiveItems.length !== expectedDeepDiveTemplates.length ||
    screeningStageError !== null ||
    deepDiveStageError !== null ||
    !screeningScenarioProvenanceMatches ||
    !deepDiveScenarioProvenanceMatches ||
    representativeKinds.size !== 3 ||
    representativeTemplates.size !== 3 ||
    !representativesUseFrozenTemplates ||
    readyItems.length !== baseline.portfolio.coverage.ready ||
    canonicalJson(baselineScreeningShape) !==
      canonicalJson(expectedScreeningProvenance) ||
    baseline.stageProvenance.screening.iterations.length === 0 ||
    screeningProxyTemplates.size !== screeningProxyRuns.length ||
    screeningProxyRuns.length !== readyTemplateIds.length ||
    !readyTemplateIds.every((templateId) =>
      screeningProxyTemplates.has(templateId),
    ) ||
    screeningProxyRuns.some((run) => run.iterations.length === 0) ||
    baselineDeepDiveShape === null ||
    canonicalJson(baselineDeepDiveShape) !==
      canonicalJson(expectedDeepDiveProvenance) ||
    (baseline.stageProvenance.deepDive?.iterations.length ?? 0) === 0 ||
    deepDiveProxyTemplates.size !== deepDiveProxyRuns.length ||
    deepDiveProxyRuns.length !== expectedDeepDiveTemplates.length ||
    !expectedDeepDiveTemplates.every((templateId) =>
      deepDiveProxyTemplates.has(templateId),
    ) ||
    deepDiveProxyRuns.some((run) => run.iterations.length === 0)
  ) {
    return failure(
      "TESSERA_STRESS_BASELINE_INCOMPLETE",
      `Revision comparison requires a complete or degraded simulated baseline with at least ${requiredSamples} usable frozen proxies, all three postures, complete required stages, and unique stress/central/contrast representatives.`,
      validation.warnings,
    );
  }
  if (!stressSimulationRequested(options)) {
    return failure(
      "TESSERA_STRESS_REVISION_SIMULATION_REQUIRED",
      'Revision comparison must rerun Tessera with executionMode="simulate" (deprecated experimental=true is normalized to the same strict mode).',
      validation.warnings,
    );
  }
  const opponentPaths = baselineOpponentPaths(baselineManifest);
  const artifactByTemplate = new Map(
    baseline.frozenOpponentArtifacts.map((artifact) => [
      artifact.templateId,
      artifact,
    ]),
  );
  if (
    artifactByTemplate.size !==
      baseline.frozenOpponentArtifacts.length ||
    baseline.frozenOpponentArtifacts.length !== readyItems.length ||
    readyTemplateIds.some(
      (templateId) =>
        !opponentPaths.has(templateId) ||
        !artifactByTemplate.has(templateId),
    )
  ) {
    return failure(
      "TESSERA_STRESS_BASELINE_ARTIFACTS_MISSING",
      "The baseline does not retain an enriched .rosz path for every frozen proxy.",
      validation.warnings,
    );
  }
  const artifactChecks = await Promise.all(
    readyItems.map(async (item) => {
      const artifact = artifactByTemplate.get(item.templateId);
      if (!artifact) {
        return {
          templateId: item.templateId,
          state: "missing" as const,
        };
      }
      if (
        artifact.rosterFingerprint !==
        rosterExecutionFingerprint(item.roster)
      ) {
        return {
          templateId: item.templateId,
          state: "changed" as const,
        };
      }
      const frozenPath = opponentPaths.get(item.templateId);
      if (!frozenPath || !(await pathExists(frozenPath))) {
        return {
          templateId: item.templateId,
          state: "missing" as const,
        };
      }
      return {
        templateId: item.templateId,
        state:
          (await fileSha256(frozenPath)) === artifact.sha256 &&
          baselineManifest.preparedOpponents[item.templateId]?.sha256 ===
            artifact.sha256
            ? ("ok" as const)
            : ("changed" as const),
      };
    }),
  );
  const missingPaths = artifactChecks
    .filter((check) => check.state === "missing")
    .map((check) => check.templateId);
  const changedPaths = artifactChecks
    .filter((check) => check.state === "changed")
    .map((check) => check.templateId);
  if (missingPaths.length > 0) {
    return failure(
      "TESSERA_STRESS_BASELINE_ARTIFACTS_MISSING",
      `The frozen enriched .rosz artifact is missing for: ${missingPaths.join(", ")}.`,
      validation.warnings,
    );
  }
  if (changedPaths.length > 0) {
    return failure(
      "TESSERA_STRESS_BASELINE_ARTIFACTS_CHANGED",
      `The frozen proxy roster or enriched .rosz content changed for: ${changedPaths.join(", ")}. Start a new baseline instead of comparing mixed artifacts.`,
      validation.warnings,
    );
  }
  const missingOpponentPaths = (
    await Promise.all(
      readyTemplateIds.map(async (templateId) => {
        const filename = opponentPaths.get(templateId);
        return !filename || !(await pathExists(filename))
          ? templateId
          : null;
      }),
    )
  ).filter((templateId): templateId is string => templateId !== null);
  if (missingOpponentPaths.length > 0) {
    return failure(
      "TESSERA_STRESS_BASELINE_ARTIFACTS_MISSING",
      `The frozen enriched .rosz artifact is missing for: ${missingOpponentPaths.join(", ")}.`,
      validation.warnings,
    );
  }

  const revisionRunId = crypto.randomUUID();
  const outputDirectory =
    options.outputDirectory
      ? resolveFromWriteRoot(options.outputDirectory, options)
      : resolveFromWriteRoot(
          defaultStressOutputDirectory(
            revisedRoster,
            baseline.opponentFactionId,
            revisionRunId,
          ),
          options,
        );
  const comparisonBasename = `${safeName(revisedRoster.name) || "roster"}-stress-revision`;
  let comparisonTargets: string[];
  try {
    comparisonTargets = await resolveExportArtifactTargets(
      [
        {
          format: "roster-json",
          filename: `${comparisonBasename}.json`,
          mimeType: "application/json",
          encoding: "utf8",
          content: "",
        },
        {
          format: "html",
          filename: `${comparisonBasename}.html`,
          mimeType: "text/html; charset=utf-8",
          encoding: "utf8",
          content: "",
        },
      ],
      outputDirectory,
      options,
    );
  } catch (error) {
    const outputFailure = tesseraOutputFailure(error);
    return failure(
      outputFailure.code,
      outputFailure.message,
      validation.warnings,
    );
  }
  const configuration = baseline.configuration;
  const manifest = newManifest(
    revisedRoster,
    baseline.opponentFactionId,
    baseline.portfolio,
    configuration,
    outputDirectory,
    true,
    baselineManifest.simulationBackend,
    baselineManifest.profilePolicy,
    [],
    revisionRunId,
    null,
    baselineManifest.requestedScenarioContract,
  );
  const revisionRunDirectory = path.join(
    outputDirectory,
    "revised-runs",
    manifest.runId,
  );
  manifest.outputDirectory = path.resolve(revisionRunDirectory);
  manifest.representatives = baseline.representatives;
  manifest.stageContracts = cloneStageContracts(
    baselineManifest.stageContracts,
  );
  const manifestPath = path.join(
    revisionRunDirectory,
    "stress-manifest.json",
  );
  try {
    await writeManifest(
      manifest,
      manifestPath,
      options,
      false,
    );
  } catch (error) {
    const outputFailure = tesseraOutputFailure(error);
    return failure(
      outputFailure.code,
      outputFailure.message,
      validation.warnings,
    );
  }
  const rerun = await executeStressTest({
    playerRoster: revisedRoster,
    portfolio: baseline.portfolio,
    configuration,
    outputDirectory: revisionRunDirectory,
    manifestPath,
    manifest,
    resumed: false,
    options: {
      ...options,
      overwrite: false,
      executionMode: "simulate",
      experimental: false,
    },
    dependencies,
    opponentRoszPaths: opponentPaths,
    frozenRepresentatives: baseline.representatives,
  });
  const settingsFailure = [
    ...Object.values(manifest.screening),
    ...Object.values(manifest.deepDive),
  ].find(
    (entry) =>
      entry.error?.code === "TESSERA_SETTINGS_CHANGED" ||
      entry.error?.code === "TESSERA_SETTINGS_REPLAY_FAILED" ||
      entry.error?.code ===
        "TESSERA_SETTINGS_PROVENANCE_MISSING",
  );
  if (settingsFailure?.error) {
    return failure(
      "TESSERA_STRESS_SETTINGS_CHANGED",
      settingsFailure.error.message,
      rerun.warnings,
    );
  }
  if (
    !rerun.data ||
    rerun.data.reportKind !== "tessera-stress-test"
  ) {
    return {
      ok: false,
      data: null,
      violations: rerun.violations,
      warnings: rerun.warnings,
    };
  }
  const revised = rerun.data;
  const revisedScreeningError = revised.screeningReport
    ? combinedStageValidationError(
        revised.screeningReport,
        revised.player,
        readyItems,
        screeningMetrics,
        screeningMode,
        true,
      )
    : "the revised screening report is missing";
  const revisedDeepDiveError = revised.deepDiveReport
    ? combinedStageValidationError(
        revised.deepDiveReport,
        revised.player,
        deepDiveItems,
        baseline.configuration.analysisStrategy === "full-all"
          ? screeningMetrics
          : DEEP_DIVE_METRICS,
        "full",
        baseline.configuration.analysisStrategy === "full-all",
      )
    : "the revised deep-dive report is missing";
  const revisedConfidentTemplates = new Set(
    (revised.robustness?.samples ?? [])
      .filter((sample) => sample.status === "confident")
      .map((sample) => sample.templateId),
  );
  const revisedConfidentPostures = new Set(
    (revised.robustness?.samples ?? [])
      .filter((sample) => sample.status === "confident")
      .map((sample) => sample.posture),
  );
  const terminalRevisionFailures = stressFailures(
    manifest,
    baseline.portfolio,
  ).filter((entry) => !entry.retryable);
  const revisedSelectedBackend =
    revised.simulation?.selectedBackend ?? "website";
  const revisedExpectedSource =
    revisedSelectedBackend === "local-engine"
      ? "tessera-local-engine"
      : "tessera-ui";
  if (
    revised.source !== revisedExpectedSource ||
    !simulationProviderAllowsAnalyticalClaims(
      revisedSelectedBackend,
      revised.simulation?.providerIdentity,
    ) ||
    !["complete", "degraded"].includes(revised.status) ||
    revised.screeningReport?.status !== "complete" ||
    revised.deepDiveReport?.status !== "complete" ||
    revisedScreeningError !== null ||
    revisedDeepDiveError !== null ||
    revisedConfidentTemplates.size < requiredSamples ||
    revisedConfidentPostures.size !== 3 ||
    canonicalJson(revised.representatives) !==
      canonicalJson(baseline.representatives) ||
    canonicalJson(revised.portfolio) !==
      canonicalJson(baseline.portfolio) ||
    canonicalJson(revised.frozenOpponentArtifacts) !==
      canonicalJson(baseline.frozenOpponentArtifacts)
  ) {
    if (terminalRevisionFailures.length > 0) {
      return {
        ok: false,
        data: null,
        violations: terminalRevisionFailures.map((entry) =>
          issue(
            entry.code,
            `Revised ${entry.stage} failed${
              entry.opponentName
                ? ` against ${entry.opponentName}`
                : ""
            }: ${entry.message}`,
          ),
        ),
        warnings: rerun.warnings,
      };
    }
    return failure(
      "TESSERA_STRESS_REVISION_INCOMPLETE",
      `The revised roster did not produce at least ${requiredSamples} confident screening proxies across all three postures plus complete frozen deep dives. No paired conclusion was produced.`,
      rerun.warnings,
    );
  }
  if (
    canonicalJson(
      pairedStageExecutionContract(revised.stageProvenance),
    ) !==
    canonicalJson(
      pairedStageExecutionContract(baseline.stageProvenance),
    )
  ) {
    return failure(
      "TESSERA_STRESS_SETTINGS_CHANGED",
      "The revised run did not use the exact frozen Tessera settings and iteration counts. No paired conclusion was produced.",
      rerun.warnings,
    );
  }
  const guardrail = assessMissionReadinessRevisionGuardrail(
    baseline.missionReadiness,
    revised.missionReadiness,
  );
  const sampleDeltas = readyTemplateIds.map((templateId) =>
    sampleDelta(
      templateId,
      baseline,
      revised,
      baseline.configuration.revisionMateriality,
    ),
  );
  const summaryCounts = {
    improved: sampleDeltas.filter(
      (delta) => delta.classification === "improved",
    ).length,
    worsened: sampleDeltas.filter(
      (delta) => delta.classification === "worsened",
    ).length,
    unchanged: sampleDeltas.filter(
      (delta) => delta.classification === "unchanged",
    ).length,
    ambiguous: sampleDeltas.filter(
      (delta) => delta.classification === "ambiguous",
    ).length,
  };
  const conclusion: TesseraStressRevisionReport["summary"]["conclusion"] =
    !guardrail.accepted
      ? "suppressed"
      : summaryCounts.improved > summaryCounts.worsened
        ? "better"
        : summaryCounts.worsened > summaryCounts.improved
          ? "worse"
          : "unchanged";
  const report: TesseraStressRevisionReport = {
    schemaVersion: 2,
    reportKind: "tessera-stress-revision",
    runId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    baselineReportPath: resolvedBaselineReportPath,
    baselineRunId: baseline.runId,
    revisedRosterFingerprint:
      rosterExecutionFingerprint(revisedRoster),
    baseline,
    revised,
    sampleDeltas,
    missionReadinessGuardrail: guardrail,
    summary: { ...summaryCounts, conclusion },
    limitations: [
      "This paired comparison reuses the exact frozen proxy rosters and settings; it still measures directional combat math, not game win probability.",
      "Margin changes smaller than one percentage point are classified as unchanged to avoid overstating Monte Carlo noise.",
      "The paired conclusion is driven by the screening half-wipe robustness metric; deep-dive wipe, kill, and damage results are supporting evidence rather than separate votes.",
      "Mission readiness is a separate deterministic guardrail and is not blended into the combat robustness score.",
    ],
    warnings: unique([
      ...baseline.warnings,
      ...revised.warnings,
      ...(guardrail.accepted ? [] : guardrail.reasons),
    ]),
    artifacts: [],
  };
  try {
    report.artifacts = [
      {
        format: "stress-revision-json",
        written: path.basename(comparisonTargets[0]),
      },
      {
        format: "stress-revision-html",
        written: path.basename(comparisonTargets[1]),
      },
    ];
    Object.assign(
      report,
      portableReportValue(
        report,
        "",
        outputDirectory,
      ) as TesseraStressRevisionReport,
    );
    await writeExportArtifacts(
      [
        {
          format: "roster-json",
          filename: `${comparisonBasename}.json`,
          mimeType: "application/json",
          encoding: "utf8",
          content: `${JSON.stringify(report, null, 2)}\n`,
        },
        {
          format: "html",
          filename: `${comparisonBasename}.html`,
          mimeType: "text/html; charset=utf-8",
          encoding: "utf8",
          content: renderTesseraStressRevisionReportHtml(report),
        },
      ],
      outputDirectory,
      options,
    );
  } catch (error) {
    return {
      ok: false,
      data: report,
      violations: [
        issue(
          "WRITE_FAILED",
          error instanceof Error
            ? error.message
            : "Stress revision report write failed.",
        ),
      ],
      warnings: validation.warnings,
    };
  }
  return {
    ok: true,
    data: report,
    violations: [],
    warnings: report.warnings.map((message) =>
      issue("TESSERA_STRESS_WARNING", message, "warn"),
    ),
  };
}
