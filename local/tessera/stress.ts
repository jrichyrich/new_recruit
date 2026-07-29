import crypto from "node:crypto";
import {
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
  exportRoster,
  generateFactionStressPortfolio,
  modifyRoster,
  rosterHasNamedCharacter,
  rosterSimulationFingerprint,
  rosterExecutionFingerprint,
  RosterDraftSchema,
  validateRoster,
  type NewRecruitDelivery,
  type ProfilePolicyV1,
  type ResultEnvelope,
  type RosterDraftV1,
  type RosterIssue,
  type TesseraAnalysisConfiguration,
  type TesseraChangeCandidate,
  type TesseraMatchupReport,
  type TesseraMetric,
  type TesseraMissionReadinessReport,
  type TesseraPreparedRoster,
  type TesseraStressAnalysisStrategy,
  type TesseraStressConfiguration,
  type TesseraStressFrozenOpponentArtifact,
  type TesseraStressPortfolio,
  type TesseraStressPortfolioItem,
  type TesseraStressRepresentative,
  type TesseraStressRevisionReport,
  type TesseraStressRobustness,
  type TesseraStressRevisionSampleDelta,
  type TesseraStressStageProvenance,
  type TesseraStressSuite,
  type TesseraStressTestReport,
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
  loadNewRecruitCache,
  storeNewRecruitCache,
} from "../new-recruit/cache";
import { closeTesseraLocalAgentSession } from "../agent/client";
import {
  analyzeRosterMatchup,
  getTesseraConnectionStatus,
  prepareRosterForTessera,
  type TesseraDependencies,
  type TesseraOpponentInput,
} from "./companion";
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
  ProfilePolicySchema,
  profilePolicyHash,
  profilePolicyScaffold,
  validateProfilePolicy,
} from "./profile-policy";

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
  suite?: TesseraStressSuite;
  analysisStrategy?: TesseraStressAnalysisStrategy;
  resumeManifestPath?: string;
  profilePolicyPath?: string;
  forceRetry?: boolean;
  experimental?: boolean;
};

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
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  nextAction: string | null;
};

type ManifestPreparedOpponent = {
  prepared: TesseraPreparedRoster;
  sha256: string;
};

type TesseraStressManifest = {
  schemaVersion: 2;
  reportKind: "tessera-stress-manifest";
  runId: string;
  createdAt: string;
  updatedAt: string;
  playerFingerprint: string;
  playerSourceData: RosterDraftV1["sourceData"];
  opponentFactionId: string;
  configuration: TesseraStressConfiguration;
  portfolio: TesseraStressPortfolio;
  outputDirectory: string;
  simulationRequested: boolean;
  profilePolicy: ProfilePolicyV1 | null;
  profilePolicyHash: string | null;
  warnings: string[];
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

const SourceDataSchema = z.object({
  package: z.literal("@alpaca-software/40kdc-data"),
  version: z.string().min(1),
  edition: z.literal("11th"),
  dataslate: z.string().min(1),
  releaseId: z.string().min(1),
  migratedFrom: z.literal(1).optional(),
  newRecruit: z.object({
    repository: z.literal("BSData/wh40k-11e"),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    gameSystemRevision: z.number().int().nonnegative(),
    catalogueRevision: z.number().int().nonnegative().nullable(),
  }),
  official: z.object({
    mfmVersion: z.string().min(1),
    updatedAt: z.string().min(1),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

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

const PreparedRosterSchema = z.object({
  rosterId: z.string().min(1),
  rosterName: z.string().min(1),
  factionId: z.string().min(1).optional(),
  listUrl: z.string().nullable(),
  sourceRoszPath: z.string().min(1),
  enrichedRoszPath: z.string().min(1),
  summary: z.object({
    rosterName: z.string().min(1),
    factionName: z.string().min(1),
    totalPoints: z.number().nonnegative(),
    generatedBy: z.string(),
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
});

const StressConfigurationSchema = z.object({
  suite: z.enum(["core-3", "diverse-9"]),
  analysisStrategy: z.enum(["staged", "full-all"]),
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

const PortfolioSchema = z.object({
  schemaVersion: z.literal(1),
  generatorVersion: z.string().min(1),
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
    representedPostures: z.array(z.string()),
    representedCompositions: z.array(z.string()),
    uniqueSimulationPayloads: z.number().int().nonnegative().default(0),
    namedCharacterCoverage: z.boolean().default(false),
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
  firstAttemptAt: z.string().min(1).nullable(),
  lastAttemptAt: z.string().min(1).nullable(),
  nextAction: z.string().min(1).nullable(),
});

const StressManifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  reportKind: z.literal("tessera-stress-manifest"),
  runId: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  playerFingerprint: z.string().min(1),
  playerSourceData: SourceDataSchema,
  opponentFactionId: z.string().min(1),
  configuration: StressConfigurationSchema,
  portfolio: PortfolioSchema,
  outputDirectory: z.string().min(1),
  simulationRequested: z.boolean(),
  profilePolicy: ProfilePolicySchema.nullable().optional(),
  profilePolicyHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  warnings: z.array(z.string()),
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
    confidence: z.enum(["high", "review", "ambiguous"]),
    warningRefs: z.array(z.string()),
  })),
  status: z.enum(["complete", "partial"]),
  warnings: z.array(z.string()),
});

const MatchupReportSchema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  source: z.enum(["tessera-ui", "handoff-only"]),
  status: z.enum(["complete", "partial"]),
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
  }),
  player: PreparedRosterSchema,
  opponents: z.array(z.object({
    rosterName: z.string().min(1),
    enrichedRoszPath: z.string().min(1),
    summary: PreparedRosterSchema.shape.summary,
  }).passthrough()).min(1),
  simulation: z.object({
    requested: z.boolean(),
    experimental: z.boolean(),
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
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  reportKind: z.literal("tessera-stress-test"),
  runId: z.string().min(1),
  generatedAt: z.string().min(1),
  source: z.enum(["tessera-ui", "handoff-only"]),
  status: z.enum(["complete", "degraded", "inconclusive", "partial"]),
  player: PreparedRosterSchema,
  opponentFactionId: z.string().min(1),
  configuration: StressConfigurationSchema,
  suite: z.enum(["core-3", "diverse-9"]),
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
    })),
    confidence: z.enum(["complete", "review", "insufficient"]),
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
    ]),
    written: z.string().min(1),
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

function portableReportValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => portableReportValue(entry, key));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        portableReportValue(entry, entryKey),
      ]),
    );
  }
  if (
    typeof value === "string" &&
    (key.endsWith("Path") || key === "written") &&
    path.isAbsolute(value)
  ) {
    return path.basename(value);
  }
  return value;
}

function portableStressReport(
  report: TesseraStressTestReport,
): TesseraStressTestReport {
  return portableReportValue(report) as TesseraStressTestReport;
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
  const readyItems = checked.items.filter(
    (item) => item.status === "ready" && item.roster !== null,
  );
  checked.coverage = {
    ...checked.coverage,
    ready: readyItems.length,
    unavailable: checked.items.length - readyItems.length,
    representedPostures: [
      ...new Set(readyItems.map((item) => item.posture)),
    ],
    representedCompositions: [
      ...new Set(readyItems.map((item) => item.composition)),
    ],
    uniqueSimulationPayloads: seenPayloads.size,
    namedCharacterCoverage:
      readyItems.some((item) => item.containsNamedCharacter === true) ||
      checked.coverage.namedCharacterCoverage,
  };
  const minimum = checked.suite === "diverse-9" ? 6 : 3;
  if (
    readyItems.length < minimum ||
    checked.coverage.representedPostures.length < 3 ||
    !checked.coverage.namedCharacterCoverage
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "STRESS_PORTFOLIO_PREFLIGHT_INSUFFICIENT",
          `${checked.suite} requires at least ${minimum} unique exportable Tessera payloads covering all three postures and deliberate named-character coverage when an exportable legal anchor exists; found ${readyItems.length} across ${checked.coverage.representedPostures.length} posture(s), named coverage=${checked.coverage.namedCharacterCoverage}. No external activity was started.`,
        ),
      ],
      warnings,
    };
  }
  return {
    ok: true,
    data: checked,
    violations: [],
    warnings,
  };
}

function sharedSourcePin(
  sourceData: RosterDraftV1["sourceData"],
): string {
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
  return {
    suite: options.suite ?? "diverse-9",
    analysisStrategy: options.analysisStrategy ?? "staged",
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
    ? entry.status === "complete"
    : entry.status === "complete" || entry.status === "partial";
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
        !stageEntryIsReusable(
          manifest.screening[templateId],
          manifest.simulationRequested,
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
      !stageEntryIsReusable(
        manifest.deepDive[representative.templateId],
        manifest.simulationRequested,
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
  profilePolicy: ProfilePolicyV1 | null,
  warnings: string[] = [],
): TesseraStressManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    reportKind: "tessera-stress-manifest",
    runId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    playerFingerprint: rosterExecutionFingerprint(playerRoster),
    playerSourceData: playerRoster.sourceData,
    opponentFactionId,
    configuration,
    portfolio,
    outputDirectory: path.resolve(outputDirectory),
    simulationRequested,
    profilePolicy,
    profilePolicyHash:
      profilePolicy === null ? null : profilePolicyHash(profilePolicy),
    warnings,
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

async function readManifest(
  filename: string,
): Promise<TesseraStressManifest> {
  const raw = JSON.parse(await readFile(filename, "utf8")) as {
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
  const migrateStage = (
    entries: typeof data.screening,
  ): Record<string, ManifestStageEntry> =>
    Object.fromEntries(
      Object.entries(entries).map(([templateId, entry]) => [
        templateId,
        "attemptCount" in entry
          ? entry
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
              firstAttemptAt: null,
              lastAttemptAt: null,
              nextAction:
                entry.status === "complete"
                  ? null
                  : "Resume the run with the v2 workflow.",
            },
      ]),
    );
  const manifest = {
    ...data,
    schemaVersion: 2,
    configuration: {
      ...data.configuration,
      profilePolicyHash:
        data.configuration.profilePolicyHash ?? null,
    },
    profilePolicy: data.profilePolicy ?? null,
    profilePolicyHash: data.profilePolicyHash ?? null,
    screening: migrateStage(data.screening),
    deepDive: migrateStage(data.deepDive),
  } as TesseraStressManifest;
  Object.defineProperty(manifest, "__migratedFrom", {
    value: raw.schemaVersion === 1 ? 1 : null,
    enumerable: false,
  });
  return manifest;
}

async function writeManifest(
  manifest: TesseraStressManifest,
  filename: string,
  options: TesseraStressOptions,
  overwrite: boolean,
): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  const artifact = {
    format: "roster-json" as const,
    filename: path.basename(filename),
    mimeType: "application/json",
    encoding: "utf8" as const,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
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
  seed: (roster: RosterDraftV1, prepared: TesseraPreparedRoster) => void;
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
    const key = `${roster.id}:${rosterExecutionFingerprint(roster)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const result = (async () => {
      if (!dependencies.deliver) {
        const persisted = await loadNewRecruitCache(roster);
        if (persisted) return persisted;
      }
      const delivered = await actual(roster, options);
      if (!dependencies.deliver && delivered.ok) {
        await storeNewRecruitCache(roster, delivered);
      }
      return delivered;
    })();
    cache.set(key, result);
    return result;
  };
  return {
    dependencies: { ...dependencies, deliver },
    seed: (roster, prepared) => {
      cache.set(
        `${roster.id}:${rosterExecutionFingerprint(roster)}`,
        Promise.resolve(preparedDelivery(roster, prepared)),
      );
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
  if (
    report.source !== "tessera-ui" ||
    report.status !== "complete" ||
    !report.simulation.requested ||
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
  const report = parsed.data as TesseraMatchupReport;
  const configuration = report.configuration;
  const opponent = report.opponents[0];
  if (
    report.player.enrichedRoszPath !==
      expected.player.enrichedRoszPath ||
    report.player.rosterId !== expected.player.rosterId ||
    report.player.factionId !== expected.player.factionId ||
    report.player.summary.totalPoints !==
      expected.player.summary.totalPoints ||
    report.opponents.length !== 1 ||
    opponent.rosterName !== expected.item.roster.name ||
    (expected.opponentEnrichedRoszPath !== undefined &&
      opponent.enrichedRoszPath !==
        expected.opponentEnrichedRoszPath) ||
    opponent.summary.totalPoints !==
      expected.item.roster.totalPoints ||
    !configuration ||
    configuration.analysisMode !== expected.mode ||
    JSON.stringify(configuration.phases) !==
      JSON.stringify(["shooting", "fight"]) ||
    JSON.stringify(configuration.metrics) !==
      JSON.stringify(expected.metrics) ||
    JSON.stringify(configuration.directions) !==
      JSON.stringify([
        "player-to-opponent",
        "opponent-to-player",
      ]) ||
    configuration.pointsTolerancePercent !== 5 ||
    configuration.allowPointMismatch ||
    configuration.includeChangeCandidates !==
      expected.includeChangeCandidates ||
    report.simulation.requested !==
      expected.simulationRequested ||
    !report.simulation.experimental ||
    (expected.simulationRequested &&
      report.status !== "complete") ||
    (report.status === "complete" &&
      report.source !== "tessera-ui")
  ) {
    throw new Error(
      "Stored stage report does not match the frozen player, opponent, configuration, or simulation mode.",
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
): TesseraAnalysisConfiguration {
  return {
    analysisMode: mode,
    phases: ["shooting", "fight"],
    metrics,
    directions: ["player-to-opponent", "opponent-to-player"],
    pointsTolerancePercent: 5,
    allowPointMismatch: false,
    includeChangeCandidates: false,
  };
}

function combineMatchupReports(
  reports: Map<string, TesseraMatchupReport>,
  preparedPlayer: TesseraPreparedRoster,
  expectedCount: number,
  metrics: TesseraMetric[],
  mode: "quick" | "full",
  warnings: string[],
): TesseraMatchupReport {
  const values = [...reports.values()];
  const configuration =
    values.find((report) => report.configuration)?.configuration ??
    manualAnalysisConfiguration(metrics, mode);
  const scenarios = values.flatMap(
    (report) => report.simulation.scenarios ?? [],
  );
  const matrices = values.flatMap(
    (report) => report.simulation.matrices,
  );
  const complete =
    values.length === expectedCount &&
    values.every((report) => report.status === "complete");
  return {
    schemaVersion: 2,
    runId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    source: matrices.length > 0 ? "tessera-ui" : "handoff-only",
    status: complete ? "complete" : "partial",
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
    opponents: values.flatMap((report) => report.opponents),
    simulation: {
      requested: values.some((report) => report.simulation.requested),
      experimental: true,
      settings: Object.assign(
        {},
        ...values.map((report) => report.simulation.settings),
      ),
      matrices,
      scenarios,
    },
    strengths: unique(values.flatMap((report) => report.strengths)),
    weaknesses: unique(values.flatMap((report) => report.weaknesses)),
    suggestions: unique(values.flatMap((report) => report.suggestions)),
    findings: values.flatMap((report) => report.findings ?? []),
    changeCandidates: values.flatMap(
      (report) => report.changeCandidates ?? [],
    ),
    limitations: unique(
      values.flatMap((report) => report.limitations),
    ),
    warnings: unique([
      ...warnings,
      ...values.flatMap((report) => report.warnings),
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

function stageDirectoryName(templateId: string): string {
  return safeName(templateId) || "proxy";
}

async function ensurePreparedOpponents(
  input: StressExecutionInput,
  items: Array<
    TesseraStressPortfolioItem & { roster: RosterDraftV1 }
  >,
  delivery: ReturnType<typeof createDeliveryCache>,
): Promise<ResultEnvelope<true>> {
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
        return failure(
          "TESSERA_STRESS_PREPARED_OPPONENT_CHANGED",
          `The manifest-owned prepared artifact for ${item.templateId} is missing or changed. Start a new run instead of creating a duplicate external list.`,
        );
      }
      delivery.seed(item.roster, receipt.prepared);
      continue;
    }
    if (
      input.manifest.opponentPreparationStartedAt[item.templateId]
    ) {
      return failure(
        "TESSERA_STRESS_DELIVERY_OUTCOME_UNKNOWN",
        `A prior New Recruit delivery for ${item.templateId} started but no verified receipt was persisted. Resume will not risk creating a duplicate list; inspect the external account and start a new run when safe.`,
      );
    }
    input.manifest.opponentPreparationStartedAt[item.templateId] =
      new Date().toISOString();
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
          : "The opponent delivery marker could not be persisted.",
      );
    }
    const prepared = await prepareRosterForTessera(
      item.roster,
      {
        ...input.options,
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
      delivery.seed(item.roster, prepared.data);
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
          : "The verified opponent delivery receipt could not be persisted.",
      );
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
  "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
  "TESSERA_PREMIUM_STILL_LOCKED",
  "TESSERA_MATRIX_MISSING",
  "TESSERA_MATRIX_STALE",
  "TESSERA_STALE_MATRIX",
  "TESSERA_INCOMPLETE_MATRIX",
  "TESSERA_SCENARIOS_INCOMPLETE",
]);

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

function retryLimit(input: StressExecutionInput): number {
  return input.resumed ? 5 : 3;
}

function retryDelay(attemptWithinTurn: number): number {
  return attemptWithinTurn <= 1 ? 1_000 : 3_000;
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
          includeChangeCandidates: stage === "screening",
          opponentEnrichedRoszPath:
            input.manifest.preparedOpponents[item.templateId]
              ?.prepared.enrichedRoszPath,
        });
        reports.set(item.templateId, report);
        const opponent = preparedOpponent(report, item);
        if (opponent) delivery.seed(item.roster, opponent);
        continue;
      } catch (error) {
        entry.status = "pending";
        entry.reportSha256 = null;
        entry.error = structuredStageError(
          "TESSERA_STORED_REPORT_INVALID",
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
      continue;
    }
    if (
      entry.attemptCount >= retryLimit(input) &&
      !input.options.forceRetry
    ) {
      entry.nextAction =
        "The retry budget is exhausted; inspect the error before using --force-retry.";
      warnings.push(
        `${item.templateId}: ${entry.nextAction}`,
      );
      continue;
    }

    const opponentPath = input.opponentRoszPaths?.get(item.templateId);
    const opponent: TesseraOpponentInput = opponentPath
      ? { kind: "rosz", path: opponentPath }
      : { kind: "roster", roster: item.roster };
    let result: Awaited<ReturnType<typeof analyzeRosterMatchup>> | null = null;
    let lastCode: string | null = null;
    let attemptWithinTurn = 0;
    const maximumAttempts = input.options.forceRetry
      ? entry.attemptCount + 3
      : retryLimit(input);
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
          experimental: input.options.experimental,
          analysisMode: mode,
          phases: ["shooting", "fight"],
          metrics,
          profilePolicy: input.manifest.profilePolicy,
          sessionId: input.manifest.runId,
          allowPointMismatch: false,
          includeChangeCandidates: stage === "screening",
        },
        delivery.dependencies,
      );
      const code =
        result.ok && result.data?.status === "complete"
          ? null
          : result.violations[0]?.code ??
            result.data?.warnings
              .map((warning) =>
                warning.match(/\[(TESSERA_[A-Z0-9_]+)\]/)?.[1],
              )
              .find(Boolean) ??
            (result.data
              ? "TESSERA_SCENARIOS_INCOMPLETE"
              : "TESSERA_STAGE_FAILED");
      lastCode = code;
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
      if (opponentPrepared) delivery.seed(item.roster, opponentPrepared);
    }
    const reportPath =
      result.data?.artifacts.find(
        (artifact) => artifact.format === "matchup-json",
      )?.written ?? null;
    if (result.ok && result.data && reportPath) {
      entry.status =
        result.data.status === "complete" ? "complete" : "partial";
      entry.reportPath = reportPath;
      entry.reportSha256 = await fileSha256(reportPath);
      entry.error =
        result.data.status === "complete" ||
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
      entry.nextAction = entry.error
        ? entry.attemptCount < 5
          ? "Resume this run to retry the incomplete proxy."
          : "Inspect the incomplete scenarios before forcing another retry."
        : null;
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
      entry.nextAction = entry.error.retryable
        ? "Resume this run after checking local browser readiness."
        : "Resolve the terminal error, then resume with --force-retry.";
      warnings.push(`${item.templateId}: ${entry.error.message}`);
    }
    await writeManifest(
      input.manifest,
      input.manifestPath,
      input.options,
      true,
    );
  }
  return { reports, warnings };
}

function aggregateChangeCandidates(
  playerRoster: RosterDraftV1,
  screeningReports: Map<string, TesseraMatchupReport>,
  portfolio: TesseraStressPortfolio,
  baselineReadiness: TesseraMissionReadinessReport,
): TesseraChangeCandidate[] {
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
  return [...groups.values()]
    .filter(
      (group) =>
        group.templateIds.size >= minimumSupport &&
        group.postures.size >= 2,
    )
    .flatMap((group) => {
      const modified = modifyRoster(
        playerRoster,
        group.candidate.operation,
      );
      if (!modified.ok || !modified.data) return [];
      const readiness = analyzeMissionReadiness(modified.data);
      if (!readiness.ok || !readiness.data) return [];
      const guardrail = assessMissionReadinessRevisionGuardrail(
        baselineReadiness,
        readiness.data,
      );
      if (!guardrail.accepted) return [];
      return [
        {
          ...group.candidate,
          rationale: `${group.candidate.rationale} Supported by ${group.templateIds.size} frozen proxies across ${group.postures.size} postures; the deterministic mission-readiness guardrail passed.`,
          evidenceFindingIds: [...group.evidenceFindingIds],
        },
      ];
    })
    .slice(0, 3);
}

function executionStatus(
  portfolio: TesseraStressPortfolio,
  representatives: TesseraStressRepresentative[],
  strategy: TesseraStressAnalysisStrategy,
  robustness: TesseraStressRobustness,
  manifest: TesseraStressManifest,
): TesseraStressTestReport["status"] {
  const readyItems = portfolio.items.filter(
    (item) => item.status === "ready" && item.roster !== null,
  );
  const screeningComplete = readyItems.every(
    (item) => manifest.screening[item.templateId]?.status === "complete",
  );
  const minimum = portfolio.suite === "diverse-9" ? 6 : 3;
  if (
    !screeningComplete ||
    readyItems.length < minimum
  ) return "partial";

  const confident = robustness.samples.filter(
    (sample) => sample.status === "confident",
  );
  const confidentPostures = new Set(
    confident.map((sample) => sample.posture),
  );
  if (
    confident.length < minimum ||
    confidentPostures.size < 3 ||
    representatives.length !== 3
  ) return "inconclusive";

  const deepComplete =
    strategy === "full-all" ||
    representatives.every(
      (representative) =>
        manifest.deepDive[representative.templateId]?.status === "complete",
    );
  if (!deepComplete) return "partial";

  const completeTarget = portfolio.suite === "diverse-9" ? 9 : 3;
  return confident.length === completeTarget &&
    readyItems.length === completeTarget
    ? "complete"
    : "degraded";
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

async function executeStressTest(
  input: StressExecutionInput,
): Promise<ResultEnvelope<TesseraStressTestReport>> {
  const delivery = createDeliveryCache(input.dependencies);
  let preparedPlayer = input.manifest.preparedPlayer;
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
      return failure(
        "TESSERA_STRESS_PREPARED_PLAYER_CHANGED",
        "The manifest-owned prepared player artifact is missing or changed. Start a new run instead of mixing prepared files.",
      );
    }
    delivery.seed(input.playerRoster, preparedPlayer);
  } else {
    if (input.manifest.playerPreparationStartedAt) {
      return failure(
        "TESSERA_STRESS_DELIVERY_OUTCOME_UNKNOWN",
        "A prior New Recruit delivery for the player roster started but no verified receipt was persisted. Resume will not risk creating a duplicate list; inspect the external account and start a new run when safe.",
      );
    }
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
      return failure(
        "WRITE_FAILED",
        error instanceof Error
          ? error.message
          : "The player delivery marker could not be persisted.",
      );
    }
    const prepared = await prepareRosterForTessera(
      input.playerRoster,
      {
        ...input.options,
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
      return {
        ok: false,
        data: null,
        violations: prepared.violations,
        warnings: prepared.warnings,
      };
    }
    try {
      preparedPlayer = prepared.data;
      input.manifest.preparedPlayer = preparedPlayer;
      input.manifest.preparedPlayerSha256 = await fileSha256(
        preparedPlayer.enrichedRoszPath,
      );
      input.manifest.playerPreparationStartedAt = null;
      delivery.seed(input.playerRoster, preparedPlayer);
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
          : "The verified player delivery receipt could not be persisted.",
      );
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
  if (!preparedOpponents.ok) {
    return {
      ok: false,
      data: null,
      violations: preparedOpponents.violations,
      warnings: preparedOpponents.warnings,
    };
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
  if (
    input.options.experimental &&
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
  const screening = await runStage(
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
    readyItems.length,
    screeningMetrics,
    screeningMode,
    screening.warnings,
  );
  const robustness = computeStressRobustness(
    screeningReport,
    input.portfolio,
  );
  const previousRepresentatives =
    input.manifest.representatives;
  const representatives =
    input.frozenRepresentatives ??
    selectStressRepresentatives(robustness, input.portfolio);
  if (
    !input.frozenRepresentatives &&
    previousRepresentatives.length > 0 &&
    canonicalJson(previousRepresentatives) !==
      canonicalJson(representatives)
  ) {
    for (const entry of Object.values(input.manifest.deepDive)) {
      entry.status = "pending";
      entry.reportPath = null;
      entry.reportSha256 = null;
      entry.error = structuredStageError(
        "TESSERA_REPRESENTATIVES_CHANGED",
        "Representative selection changed before it was complete; the deep-dive stage must be rebuilt.",
      );
      entry.nextAction =
        "Resume the run to rebuild the deep-dive stage.";
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
  } else if (representatives.length > 0) {
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
    const deepDive = await runStage(
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
      representativeItems.length,
      DEEP_DIVE_METRICS,
      "full",
      deepDive.warnings,
    );
  }

  const mission = analyzeMissionReadiness(input.playerRoster);
  if (!mission.ok || !mission.data) {
    return {
      ok: false,
      data: null,
      violations: mission.violations,
      warnings: mission.warnings,
    };
  }
  const changeCandidates = aggregateChangeCandidates(
    input.playerRoster,
    screening.reports,
    input.portfolio,
    mission.data,
  );
  const warnings = unique([
    ...input.manifest.warnings,
    ...screening.warnings,
    ...deepWarnings,
    ...robustness.warnings,
    ...input.portfolio.items.flatMap((item) =>
      item.warnings.map((warning) => warning.message),
    ),
    ...(input.options.experimental
      ? []
      : [
          "Tessera simulation was not requested; this report contains prepared handoffs and no probability claims.",
        ]),
  ]);
  const report: TesseraStressTestReport = {
    schemaVersion: 2,
    reportKind: "tessera-stress-test",
    runId: input.manifest.runId,
    generatedAt: new Date().toISOString(),
    source:
      screeningReport.source === "tessera-ui"
        ? "tessera-ui"
        : "handoff-only",
    status: executionStatus(
      input.portfolio,
      representatives,
      input.configuration.analysisStrategy,
      robustness,
      input.manifest,
    ),
    player: preparedPlayer,
    opponentFactionId: input.portfolio.factionId,
    configuration: input.configuration,
    suite: input.portfolio.suite,
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
    findings: stressFindings(robustness, input.portfolio),
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
    report.artifacts = [
      { format: "stress-json", written: path.basename(jsonPath) },
      { format: "stress-html", written: path.basename(htmlPath) },
      {
        format: "stress-manifest",
        written: path.basename(input.manifestPath),
      },
    ];
    Object.assign(report, portableStressReport(report));
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
  return {
    ok: true,
    data: report,
    violations: [],
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
): Promise<ResultEnvelope<TesseraStressTestReport>> {
  const validation = validateRoster(playerRoster);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
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
  const requestedOutput =
    options.outputDirectory ?? "exports/tessera";
  let outputDirectory = resolveFromWriteRoot(
    requestedOutput,
    options,
  );
  const manifestPath =
    (options.resumeManifestPath
      ? resolveFromWriteRoot(options.resumeManifestPath, options)
      : undefined) ??
    path.join(outputDirectory, "stress-manifest.json");
  let manifest: TesseraStressManifest;
  let resumed = false;
  if (options.resumeManifestPath) {
    try {
      manifest = await readManifest(manifestPath);
    } catch (error) {
      return failure(
        "TESSERA_STRESS_RESUME_UNREADABLE",
        error instanceof Error
          ? error.message
          : "The stress-test resume manifest could not be read.",
        validation.warnings,
      );
    }
    resumed = true;
    const migratedFromV1 =
      (manifest as TesseraStressManifest & {
        __migratedFrom?: number | null;
      }).__migratedFrom === 1;
    if (!options.profilePolicyPath) {
      requestedProfilePolicy = manifest.profilePolicy;
      configuration = stressConfiguration(
        options,
        manifest.profilePolicyHash,
      );
    }
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
    outputDirectory = manifest.outputDirectory;
    const legacyConfigurationMatches =
      migratedFromV1 &&
      canonicalJson({
        ...manifest.configuration,
        profilePolicyHash: configuration.profilePolicyHash,
      }) === canonicalJson(configuration);
    if (
      manifest.playerFingerprint !==
        rosterExecutionFingerprint(playerRoster) ||
      manifest.opponentFactionId !== opponent.factionId ||
      manifest.simulationRequested !==
        (options.experimental === true) ||
      (
        !configurationMatches(manifest.configuration, configuration) &&
        !legacyConfigurationMatches
      )
    ) {
      return failure(
        "TESSERA_STRESS_RESUME_MISMATCH",
        "The resume manifest does not match this player roster, opponent faction, suite, and analysis strategy.",
        validation.warnings,
      );
    }
    if (
      canonicalJson(manifest.playerSourceData) !==
      canonicalJson(playerRoster.sourceData)
    ) {
      return failure(
        "TESSERA_STRESS_DATA_PIN_CHANGED",
        "The player roster data pin differs from the frozen resume manifest. Start a new stress test instead of mixing data releases.",
        validation.warnings,
      );
    }
    if (
      sharedSourcePin(manifest.playerSourceData) !==
      sharedSourcePin(manifest.portfolio.sourceData)
    ) {
      return failure(
        "TESSERA_STRESS_DATA_PIN_CHANGED",
        "The resume manifest mixes player and opponent portfolio data releases. Start a new stress test instead of reusing mixed data.",
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
        await writeManifest(manifest, manifestPath, options, true);
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
    if (manifest.finalArtifacts) {
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
          if (
            completed.runId !== manifest.runId ||
            completed.opponentFactionId !==
              manifest.opponentFactionId ||
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
      profileValidation.hash !== manifest.profilePolicyHash
    ) {
      return failure(
        "TESSERA_STRESS_RESUME_PROFILE_POLICY_CHANGED",
        "The supplied profile policy is incomplete, invalid, or differs from the policy frozen in this run. Resume and paired revisions require the exact canonical policy hash.",
        validation.warnings,
      );
    }
    manifest.warnings = unique([
      ...manifest.warnings,
      ...validation.warnings.map((warning) => warning.message),
      ...preflight.warnings.map((warning) => warning.message),
    ]);
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
  } else {
    const generated = generateFactionStressPortfolio({
      faction: opponent.factionId,
      pointsLimit: playerRoster.pointsLimit,
      suite: configuration.suite,
      pointsTolerancePercent: configuration.pointsTolerancePercent,
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
        "The player roster and generated opponent portfolio use different pinned data releases. Rebuild the player roster before starting external activity.",
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
    manifest = newManifest(
      playerRoster,
      preflight.data.factionId,
      preflight.data,
      configuration,
      outputDirectory,
      options.experimental === true,
      requestedProfilePolicy,
      initialWarnings,
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
      return failure(
        "WRITE_FAILED",
        error instanceof Error
          ? error.message
          : "The stress-test output paths could not be reserved.",
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
      resumed && manifest.representatives.length === 3
        ? manifest.representatives
        : undefined,
  });
  if (
    options.experimental &&
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
  const report = {
    ...parsed.data,
    schemaVersion: 2 as const,
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
      "The revised roster must use the same pinned data release as the frozen baseline.",
      validation.warnings,
    );
  }
  if (
    sharedSourcePin(baseline.missionReadiness.sourceData) !==
    sharedSourcePin(baseline.portfolio.sourceData)
  ) {
    return failure(
      "TESSERA_STRESS_DATA_PIN_CHANGED",
      "The baseline mixes player and opponent portfolio data releases, so it cannot support a paired revision comparison.",
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
  const confidentTemplates = new Set(
    baselineRobustness.samples
      .filter((sample) => sample.status === "confident")
      .map((sample) => sample.templateId),
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
  if (
    baseline.source !== "tessera-ui" ||
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
    !readyTemplateIds.every((templateId) =>
      confidentTemplates.has(templateId),
    ) ||
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
  if (options.experimental !== true) {
    return failure(
      "TESSERA_STRESS_REVISION_SIMULATION_REQUIRED",
      "Revision comparison must rerun Tessera. Enable experimental local analysis for this approved comparison.",
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

  const outputDirectory =
    options.outputDirectory
      ? resolveFromWriteRoot(options.outputDirectory, options)
      : path.join(
          path.dirname(resolvedBaselineReportPath),
          "stress-revision",
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
    return failure(
      "WRITE_FAILED",
      error instanceof Error
        ? error.message
        : "The revision output paths could not be reserved.",
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
    baselineManifest.profilePolicy,
  );
  const revisionRunDirectory = path.join(
    outputDirectory,
    "revised-runs",
    manifest.runId,
  );
  manifest.outputDirectory = path.resolve(revisionRunDirectory);
  manifest.representatives = baseline.representatives;
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
    return failure(
      "WRITE_FAILED",
      error instanceof Error
        ? error.message
        : "The revision manifest could not be written.",
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
      experimental: true,
    },
    dependencies,
    opponentRoszPaths: opponentPaths,
    frozenRepresentatives: baseline.representatives,
  });
  if (!rerun.ok || !rerun.data) {
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
  if (
    revised.source !== "tessera-ui" ||
    !["complete", "degraded"].includes(revised.status) ||
    revised.screeningReport?.status !== "complete" ||
    revised.deepDiveReport?.status !== "complete" ||
    revisedScreeningError !== null ||
    revisedDeepDiveError !== null ||
    !readyTemplateIds.every((templateId) =>
      revisedConfidentTemplates.has(templateId),
    ) ||
    canonicalJson(revised.representatives) !==
      canonicalJson(baseline.representatives) ||
    canonicalJson(revised.portfolio) !==
      canonicalJson(baseline.portfolio) ||
    canonicalJson(revised.frozenOpponentArtifacts) !==
      canonicalJson(baseline.frozenOpponentArtifacts)
  ) {
    return failure(
      "TESSERA_STRESS_REVISION_INCOMPLETE",
      "The revised roster did not produce complete, confident screening and deep-dive results for every frozen proxy. No paired conclusion was produced.",
      rerun.warnings,
    );
  }
  if (
    canonicalJson(revised.stageProvenance) !==
    canonicalJson(baseline.stageProvenance)
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
        written: comparisonTargets[0],
      },
      {
        format: "stress-revision-html",
        written: comparisonTargets[1],
      },
    ];
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
