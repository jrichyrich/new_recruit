import { z } from "zod";

export const ROSTER_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_GAME = "warhammer-40000-11e" as const;
export const DEFAULT_FACTION_ID = "adeptus-custodes" as const;
/** @deprecated Use DEFAULT_FACTION_ID. Kept for persisted clients. */
export const SUPPORTED_FACTION_ID = DEFAULT_FACTION_ID;

export const PreferenceTagSchema = z.enum([
  "mobility",
  "durability",
  "objective",
  "shooting",
  "melee",
  "elite",
  "horde",
]);

export type PreferenceTag = z.infer<typeof PreferenceTagSchema>;

export type ResultEnvelope<T> = {
  ok: boolean;
  data: T | null;
  violations: RosterIssue[];
  warnings: RosterIssue[];
};

export type RosterIssue = {
  code: string;
  message: string;
  severity: "error" | "warn";
  selectionId?: string;
};

export const EquipmentSelectionSchema = z
  .object({
    itemId: z.string().min(1),
    name: z.string().min(1),
    count: z.number().int().nonnegative(),
  })
  .strict();

export type EquipmentSelection = z.infer<typeof EquipmentSelectionSchema>;

export const DraftUnitSchema = z
  .object({
    selectionId: z.string().min(1),
    unitId: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    modelCount: z.number().int().positive(),
    ordinal: z.number().int().positive(),
    points: z.number().int().nonnegative(),
    isWarlord: z.boolean(),
    enhancementId: z.string().min(1).nullable(),
    enhancementName: z.string().min(1).nullable(),
    equipment: z.array(EquipmentSelectionSchema),
    tags: z.array(PreferenceTagSchema),
  })
  .strict();

export type DraftUnit = z.infer<typeof DraftUnitSchema>;

const RosterDraftBodySchema = z.object({
  gameSystem: z.literal(SUPPORTED_GAME),
  id: z.string().min(1),
  name: z.string().min(1),
  factionId: z.string().min(1),
  factionName: z.string().min(1),
  pointsLimit: z.number().int().nonnegative(),
  totalPoints: z.number().int().nonnegative(),
  battleSize: z.enum(["incursion", "strike-force"]),
  detachmentId: z.string().min(1),
  detachmentName: z.string().min(1),
  forceDispositionId: z.string().min(1),
  forceDispositionName: z.string().min(1),
  preferences: z.array(PreferenceTagSchema),
  constraints: z
    .object({
      allowNamedCharacters: z.boolean(),
      allowLegends: z.boolean(),
      collectionUnitIds: z.array(z.string().min(1)).nullable(),
    })
    .strict(),
  units: z.array(DraftUnitSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const RosterDraftV1Schema = RosterDraftBodySchema.extend({
  schemaVersion: z.literal(1),
  sourceData: z
    .object({
      package: z.literal("@alpaca-software/40kdc-data"),
      version: z.string().min(1),
      edition: z.literal("11th"),
      dataslate: z.string().min(1),
    })
    .strict(),
}).strict();

export const RosterDraftV2Schema = RosterDraftBodySchema.extend({
  schemaVersion: z.literal(ROSTER_SCHEMA_VERSION),
  sourceData: z
    .object({
      package: z.literal("@alpaca-software/40kdc-data"),
      version: z.string().min(1),
      edition: z.literal("11th"),
      dataslate: z.string().min(1),
      releaseId: z.string().min(1),
      newRecruit: z
        .object({
          repository: z.literal("BSData/wh40k-11e"),
          commit: z.string().regex(/^[0-9a-f]{40}$/),
          gameSystemRevision: z.number().int().nonnegative(),
          catalogueRevision: z.number().int().nonnegative().nullable(),
        })
        .strict(),
      official: z
        .object({
          mfmVersion: z.string().min(1),
          updatedAt: z.string().min(1),
          contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
      migratedFrom: z.literal(1).optional(),
    })
    .strict(),
}).strict();

export const RosterDraftSchema = z.union([
  RosterDraftV2Schema,
  RosterDraftV1Schema,
]);

export type LegacyRosterDraftV1 = z.infer<typeof RosterDraftV1Schema>;
export type RosterDraftV2 = z.infer<typeof RosterDraftV2Schema>;
/** @deprecated Name retained for transport compatibility; new drafts are V2. */
export type RosterDraftV1 = RosterDraftV2;

export type BuildRosterInput = {
  prompt?: string;
  faction?: string;
  pointsLimit?: number;
  name?: string;
  preferences?: PreferenceTag[];
  allowNamedCharacters?: boolean;
  allowLegends?: boolean;
  collectionUnitIds?: string[];
  detachmentId?: string;
  forceDispositionId?: string;
  opponentContext?: {
    kind: "known-faction";
    factionId: string;
  };
  mixedThreatIntent?: boolean;
};

export const ModifyRosterOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    unitId: z.string().min(1),
    modelCount: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("remove"),
    selectionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("replace"),
    selectionId: z.string().min(1),
    unitId: z.string().min(1),
    modelCount: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("set-model-count"),
    selectionId: z.string().min(1),
    modelCount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("set-warlord"),
    selectionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("set-equipment"),
    selectionId: z.string().min(1),
    equipment: z.array(
      z.object({
        itemId: z.string().min(1),
        count: z.number().int().nonnegative(),
      }),
    ),
  }),
  z.object({
    type: z.literal("set-enhancement"),
    selectionId: z.string().min(1),
    enhancementId: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("set-detachment"),
    detachmentId: z.string().min(1),
    forceDispositionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("set-disposition"),
    forceDispositionId: z.string().min(1),
  }),
]);

export type ModifyRosterOperation = z.infer<typeof ModifyRosterOperationSchema>;

export type ExportFormat =
  | "ros"
  | "rosz"
  | "newrecruit-json"
  | "roster-json"
  | "text"
  | "html";

export type ExportArtifact = {
  format: ExportFormat;
  filename: string;
  mimeType: string;
  encoding: "utf8" | "binary";
  content: string | Uint8Array;
};

export type NewRecruitHandoff = {
  rosterId: string;
  rosterName: string;
  totalPoints: number;
  pointsLimit: number;
  importUrl: "https://www.newrecruit.eu/app/MyLists";
  artifacts: ExportArtifact[];
  instructions: string[];
};

export type NewRecruitConnectionStatus = {
  available: boolean;
  platform: NodeJS.Platform;
  browserAvailable: boolean;
  brokerAvailable: boolean;
  credentialsConfigured: boolean;
  profileDirectory: string | null;
  agentAvailable: boolean;
  agentVersion: string | null;
  protocolCompatible: boolean;
  installationCurrent: boolean;
  credentialState:
    | "ready"
    | "not-configured"
    | "keychain-locked"
    | "authorization-required"
    | "unavailable";
  browserState: "ready" | "unavailable";
};

export type NewRecruitVerification = {
  name: boolean;
  faction: boolean;
  points: boolean;
  units: Array<{
    name: string;
    modelCount: number;
    matched: boolean;
  }>;
  mismatches: string[];
};

export type NewRecruitDelivery = {
  rosterId: string;
  rosterName: string;
  listUrl: string | null;
  imported: boolean;
  sessionReused: boolean;
  verification: NewRecruitVerification | null;
  enrichedSummary?: EnrichedRoszSummary | null;
  artifacts: Array<{
    format:
      | "rosz"
      | "rosterpilot-source-rosz"
      | "new-recruit-enriched-rosz"
      | "new-recruit-pretty-html";
    filename: string;
    mimeType: string;
    written: string;
  }>;
};

export type EnrichedRoszSummary = {
  rosterName: string;
  factionName: string;
  totalPoints: number;
  generatedBy: string;
  profileCount: number;
  weaponProfileCount: number;
  units: Array<{
    selectionId?: string;
    name: string;
    modelCount: number;
    ordinal?: number;
    points?: number;
  }>;
};

export type TesseraArchetype =
  | "balanced-control"
  | "ranged-pressure"
  | "assault-pressure";

export type TesseraPhase = "shooting" | "fight";

export type TesseraMetric =
  | "wipe-probability"
  | "half-wipe-probability"
  | "mean-kills"
  | "mean-damage";

export type TesseraDirection =
  | "player-to-opponent"
  | "opponent-to-player";

export type TesseraConfidence = "high" | "review" | "ambiguous";

export type TesseraUnitInstance = {
  instanceId: string;
  selectionId: string | null;
  side: "player" | "opponent";
  name: string;
  label: string;
  ordinal: number;
  modelCount: number;
  points: number | null;
  tags: PreferenceTag[];
};

export type TesseraMetricValues = {
  wipeProbability: number | null;
  halfWipeProbability: number | null;
  meanKills: number | null;
  meanDamage: number | null;
  damagePer100Points: number | null;
};

export type TesseraScenarioCell = {
  attacker: TesseraUnitInstance;
  target: TesseraUnitInstance;
  values: TesseraMetricValues;
  confidence: TesseraConfidence;
  warningRefs: string[];
};

export type TesseraScenarioResult = {
  scenarioId: string;
  opponentName: string;
  phase: TesseraPhase;
  direction: TesseraDirection;
  metrics: TesseraMetric[];
  metricRuns?: Array<{
    metric: TesseraMetric;
    iterations: number | null;
    settings: Record<string, string>;
  }>;
  iterations: number | null;
  settings: Record<string, string>;
  cells: TesseraScenarioCell[];
  status: "complete" | "partial";
  warnings: string[];
};

export type TesseraFindingEvidence = {
  scenarioId: string;
  attackerInstanceId: string;
  targetInstanceId: string;
  phase: TesseraPhase;
  direction: TesseraDirection;
  values: TesseraMetricValues;
};

export type TesseraFinding = {
  findingId: string;
  kind:
    | "reliable-coverage"
    | "enemy-threat"
    | "coverage-gap"
    | "poor-efficiency"
    | "overqualified-trade"
    | "vulnerable-unit"
    | "role-gap";
  severity: "info" | "warn";
  confidence: TesseraConfidence;
  summary: string;
  unitInstanceIds: string[];
  evidence: TesseraFindingEvidence[];
};

export type TesseraChangeCandidate = {
  candidateId: string;
  title: string;
  rationale: string;
  operation: ModifyRosterOperation;
  beforePoints: number;
  afterPoints: number;
  rosterFingerprint: string;
  evidenceFindingIds: string[];
};

export type TesseraAnalysisConfiguration = {
  analysisMode: "quick" | "full";
  phases: TesseraPhase[];
  metrics: TesseraMetric[];
  directions: TesseraDirection[];
  pointsTolerancePercent: number;
  allowPointMismatch: boolean;
  includeChangeCandidates: boolean;
};

export type TesseraPointsComparison = {
  playerPoints: number;
  opponentPoints: number;
  pointsLimit: number;
  difference: number;
  differencePercent: number;
  tolerancePercent: number;
  matched: boolean;
  classification: "matched" | "unmatched";
};

export type TesseraConnectionStatus = {
  available: boolean;
  platform: NodeJS.Platform;
  browserAvailable: boolean;
  brokerAvailable: boolean;
  credentialsConfigured: boolean;
  agentAvailable: boolean;
  agentVersion: string | null;
  protocolCompatible: boolean;
  installationCurrent: boolean;
  credentialState:
    | "ready"
    | "not-configured"
    | "keychain-locked"
    | "authorization-required"
    | "unavailable";
  experimental: true;
  url: "https://playtessera.gg/";
};

export type TesseraPreparedRoster = {
  rosterId: string;
  rosterName: string;
  factionId?: string;
  listUrl: string | null;
  sourceRoszPath: string;
  enrichedRoszPath: string;
  summary: EnrichedRoszSummary;
  fingerprint?: string;
  units?: TesseraUnitInstance[];
};

export type TesseraMatchupReport = {
  schemaVersion?: 2;
  runId: string;
  generatedAt: string;
  source: "tessera-ui" | "handoff-only";
  status: "complete" | "partial";
  comparisonClass?: "matched" | "unmatched";
  configuration?: TesseraAnalysisConfiguration;
  pointsComparisons?: TesseraPointsComparison[];
  player: TesseraPreparedRoster;
  opponents: Array<{
    kind: "roster" | "rosz" | "faction-archetype";
    archetype?: TesseraArchetype;
    rosterName: string;
    enrichedRoszPath: string;
    summary: EnrichedRoszSummary;
    fingerprint?: string;
    units?: TesseraUnitInstance[];
  }>;
  simulation: {
    requested: boolean;
    experimental: boolean;
    settings: Record<string, string>;
    scenarios?: TesseraScenarioResult[];
    matrices: Array<{
      opponentName: string;
      cells: Array<{
        attacker: string;
        target: string;
        direction?: "player-to-opponent" | "opponent-to-player";
        killProbability: number | null;
        expectedDamage: number | null;
        damagePer100Points: number | null;
      }>;
    }>;
  };
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  findings?: TesseraFinding[];
  changeCandidates?: TesseraChangeCandidate[];
  limitations: string[];
  warnings: string[];
  artifacts: Array<{
    format: "matchup-json" | "matchup-html";
    written: string;
  }>;
};

export type TesseraRevisionDelta = {
  opponentName: string;
  phase: TesseraPhase;
  metric: TesseraMetric;
  direction: TesseraDirection;
  attackerInstanceId: string;
  targetInstanceId: string;
  before: number | null;
  after: number | null;
  change: number | null;
  classification: "improved" | "worsened" | "unchanged" | "ambiguous";
};

export type TesseraRevisionComparisonReport = {
  schemaVersion: 2;
  runId: string;
  generatedAt: string;
  baselineReportPath: string;
  baselineRunId: string;
  revisedRosterFingerprint: string;
  revisedReports: TesseraMatchupReport[];
  deltas: TesseraRevisionDelta[];
  summary: {
    improved: number;
    worsened: number;
    unchanged: number;
    ambiguous: number;
  };
  limitations: string[];
  warnings: string[];
  artifacts: Array<{
    format: "revision-json" | "revision-html";
    written: string;
  }>;
};

export type TesseraStressSuite = "core-3" | "diverse-9";

export type TesseraStressAnalysisStrategy = "staged" | "full-all";

export type TesseraStressComposition = "mixed" | "mass" | "elite-heavy";

export type TesseraStressPortfolioItemStatus = "ready" | "unavailable";

export type GenerateFactionStressPortfolioInput = {
  faction: string;
  pointsLimit: number;
  suite?: TesseraStressSuite;
  pointsTolerancePercent?: number;
  allowLegends?: boolean;
};

export type TesseraStressPortfolioTraits = {
  modelCount: number;
  unitCount: number;
  roleCount: number;
  pointsUtilization: number;
  hordeModelCount: number;
  hordePoints: number;
  hordePointsPercent: number;
  eliteHeavyPoints: number;
  eliteHeavyPointsPercent: number;
  eliteHeavyModelCount: number;
  tagCounts: Record<PreferenceTag, number>;
};

export type TesseraStressPortfolioItem = {
  templateId: string;
  posture: TesseraArchetype;
  composition: TesseraStressComposition;
  status: TesseraStressPortfolioItemStatus;
  roster: RosterDraftV1 | null;
  fingerprint: string | null;
  simulationFingerprint: string | null;
  structuralDistance: number | null;
  detachmentId: string | null;
  allowNamedCharacters: boolean | null;
  traits: TesseraStressPortfolioTraits | null;
  compositionEvidence: string[];
  containsNamedCharacter: boolean | null;
  omissionReason: string | null;
  warnings: RosterIssue[];
};

export type TesseraStressPortfolio = {
  schemaVersion: 1;
  generatorVersion: string;
  suite: TesseraStressSuite;
  factionId: string;
  factionName: string;
  pointsLimit: number;
  pointsTolerancePercent: number;
  sourceData: RosterDraftV2["sourceData"];
  items: TesseraStressPortfolioItem[];
  coverage: {
    intended: number;
    ready: number;
    unavailable: number;
    representedPostures: TesseraArchetype[];
    representedCompositions: TesseraStressComposition[];
    uniqueSimulationPayloads: number;
    namedCharacterCoverage: boolean;
  };
};

export type TesseraStressPortfolioPreview = {
  schemaVersion: 1;
  previewKind: "tessera-stress-portfolio";
  generatedAt: string;
  portfolio: TesseraStressPortfolio;
  items: Array<{
    templateId: string;
    structuralFingerprint: string | null;
    simulationFingerprint: string | null;
    minimumPairwiseDiversity: number | null;
    compositionEvidence: string[];
    profileRequirements: TesseraProfileRequirement[];
    containsNamedCharacter: boolean | null;
    exportable: boolean;
    exportError: string | null;
  }>;
  gates: {
    minimumUniqueRequired: number;
    uniqueSimulationPayloads: number;
    allPosturesRepresented: boolean;
    namedCharacterCoverage: boolean;
    exportable: number;
    accepted: boolean;
  };
  warnings: string[];
};

export type TesseraStressRepresentativeKind =
  | "stress"
  | "central"
  | "contrast";

export type TesseraStressRepresentative = {
  kind: TesseraStressRepresentativeKind;
  templateId: string;
  rationale: string;
};

export type TesseraStressSampleStatus =
  | "confident"
  | "ambiguous"
  | "missing";

export type TesseraStressSampleEstimate = {
  offensiveCoverage: number | null;
  threatExposure: number | null;
  coverageMargin: number | null;
  shootingCoverage: number | null;
  fightCoverage: number | null;
  shootingExposure: number | null;
  fightExposure: number | null;
  playerPointCoverage: number;
  opponentPointCoverage: number;
};

export type TesseraStressSample = {
  templateId: string;
  posture: TesseraArchetype;
  composition: TesseraStressComposition;
  weight: number;
  status: TesseraStressSampleStatus;
  offensiveCoverage: number | null;
  threatExposure: number | null;
  coverageMargin: number | null;
  shootingCoverage: number | null;
  fightCoverage: number | null;
  shootingExposure: number | null;
  fightExposure: number | null;
  playerPointCoverage: number;
  opponentPointCoverage: number;
  provisional: TesseraStressSampleEstimate | null;
  warningRefs: string[];
};

export type TesseraStressAggregate = {
  sampleCount: number;
  usableWeight: number;
  worst: number | null;
  lowerTail: number | null;
  median: number | null;
  mean: number | null;
  best: number | null;
};

export type TesseraStressUnitRobustness = {
  instanceId: string;
  label: string;
  points: number | null;
  answerBreadth: number;
  exposedWeight: number;
  supportingTemplateIds: string[];
};

export type TesseraStressRobustness = {
  scoreDefinitionVersion: "stress-robustness-v2";
  halfWipeThreshold: 0.5;
  samples: TesseraStressSample[];
  offense: TesseraStressAggregate;
  exposure: TesseraStressAggregate;
  margin: TesseraStressAggregate;
  phaseDependence: {
    shootingCoverageMean: number | null;
    fightCoverageMean: number | null;
    shootingExposureMean: number | null;
    fightExposureMean: number | null;
  };
  units: TesseraStressUnitRobustness[];
  confidence: "complete" | "review" | "insufficient";
  warnings: string[];
};

export type TesseraMissionReadinessBand =
  | "red"
  | "amber"
  | "green"
  | "unknown";

export type TesseraMissionReadinessDimensionId =
  | "scoring-breadth"
  | "control-depth"
  | "reach"
  | "action-economy"
  | "durable-contesting"
  | "home-continuity";

export type TesseraMissionDemand =
  | "control"
  | "projection"
  | "action"
  | "hold"
  | "attrition";

export type TesseraMissionReadinessMetric = {
  id: string;
  label: string;
  value: number;
  normalizedValue: number;
  unit: "units" | "models" | "points" | "objective-control";
  redBelow?: number;
  greenAtOrAbove?: number;
  selectionIds: string[];
  sourcePaths: string[];
};

export type TesseraMissionReadinessDimension = {
  id: TesseraMissionReadinessDimensionId;
  label: string;
  band: TesseraMissionReadinessBand;
  confidence: TesseraConfidence;
  metrics: TesseraMissionReadinessMetric[];
  providerSelectionIds: string[];
  evidence: string[];
};

export type TesseraPrimaryMissionReadiness = {
  matchupId: string;
  missionId: string;
  missionName: string;
  opponentDispositionId: string;
  demands: TesseraMissionDemand[];
  dimensionIds: TesseraMissionReadinessDimensionId[];
  band: TesseraMissionReadinessBand;
  confidence: TesseraConfidence;
  sourcePaths: string[];
};

export type TesseraSecondaryCardDemand = {
  cardId: string;
  cardName: string;
  demands: TesseraMissionDemand[];
  confidence: TesseraConfidence;
  sourcePaths: string[];
};

export type TesseraMissionReadinessReport = {
  schemaVersion: 1;
  scoreDefinitionVersion: "mission-readiness-v1";
  rosterFingerprint: string;
  overallBand: TesseraMissionReadinessBand;
  dimensions: TesseraMissionReadinessDimension[];
  primaryMissions: TesseraPrimaryMissionReadiness[];
  secondaryCards: TesseraSecondaryCardDemand[];
  sourceData: RosterDraftV2["sourceData"];
  warnings: string[];
};

export type TesseraMissionReadinessGuardrail = {
  accepted: boolean;
  reasons: string[];
  baselineBand: TesseraMissionReadinessBand;
  revisedBand: TesseraMissionReadinessBand;
  newRedDimensions: TesseraMissionReadinessDimensionId[];
  removedEssentialProviders: string[];
};

export type TesseraStressFindingKind =
  | "robust-answer"
  | "conditional-answer"
  | "universal-gap"
  | "archetype-risk"
  | "insufficient-confidence";

export type TesseraStressFinding = {
  findingId: string;
  kind: TesseraStressFindingKind;
  severity: "info" | "warn";
  confidence: TesseraConfidence;
  summary: string;
  templateIds: string[];
  supportingWeight: number;
  unitInstanceIds: string[];
};

export type TesseraStressConfiguration = {
  suite: TesseraStressSuite;
  analysisStrategy: TesseraStressAnalysisStrategy;
  pointsTolerancePercent: number;
  proxyWeights: "equal";
  screeningMetric: "half-wipe-probability";
  screeningPhases: TesseraPhase[];
  screeningDirections: TesseraDirection[];
  revisionMateriality: 0.01;
  profilePolicyHash: string | null;
};

export type TesseraStressStageProvenance = {
  analysisMode: "quick" | "full";
  phases: TesseraPhase[];
  metrics: TesseraMetric[];
  directions: TesseraDirection[];
  settings: Record<string, string>;
  iterations: number[];
  profilePolicyHash: string | null;
  proxyRuns: Array<{
    templateId: string;
    settings: Record<string, string>;
    iterations: number[];
    scenarios: Array<{
      phase: TesseraPhase;
      metric: TesseraMetric;
      direction: TesseraDirection;
      settings: Record<string, string>;
      iterations: number | null;
    }>;
  }>;
};

export type TesseraStressFrozenOpponentArtifact = {
  templateId: string;
  rosterFingerprint: string;
  enrichedRoszPath: string;
  sha256: string;
};

export type TesseraProfilePolicyEntry = {
  faction: string;
  unit: string;
  weaponGroup: string;
  phase: TesseraPhase;
  selectedProfile: string;
  activeCount: number;
};

export type ProfilePolicyV1 = {
  schemaVersion: 1;
  policyKind: "tessera-profile-policy";
  entries: TesseraProfilePolicyEntry[];
};

export type TesseraProfileRequirement = {
  faction: string;
  unit: string;
  selectionId: string | null;
  weaponGroup: string;
  phase: TesseraPhase;
  availableProfiles: string[];
  activeCount: number;
  selectedProfile: string | null;
};

export type TesseraStressTestReport = {
  schemaVersion: 2;
  reportKind: "tessera-stress-test";
  runId: string;
  generatedAt: string;
  source: "tessera-ui" | "handoff-only";
  status: "complete" | "degraded" | "inconclusive" | "partial";
  player: TesseraPreparedRoster;
  opponentFactionId: string;
  configuration: TesseraStressConfiguration;
  suite: TesseraStressSuite;
  portfolio: TesseraStressPortfolio;
  frozenOpponentArtifacts: TesseraStressFrozenOpponentArtifact[];
  stageProvenance: {
    screening: TesseraStressStageProvenance;
    deepDive: TesseraStressStageProvenance | null;
  };
  screeningReport: TesseraMatchupReport | null;
  deepDiveReport: TesseraMatchupReport | null;
  representatives: TesseraStressRepresentative[];
  robustness: TesseraStressRobustness | null;
  missionReadiness: TesseraMissionReadinessReport;
  findings: TesseraStressFinding[];
  changeCandidates: TesseraChangeCandidate[];
  limitations: string[];
  warnings: string[];
  artifacts: Array<{
    format: "stress-json" | "stress-html" | "stress-manifest";
    written: string;
  }>;
};

export type TesseraStressRevisionSampleDelta = {
  templateId: string;
  before: TesseraStressSample | null;
  after: TesseraStressSample | null;
  offenseChange: number | null;
  exposureChange: number | null;
  marginChange: number | null;
  classification: "improved" | "worsened" | "unchanged" | "ambiguous";
};

export type TesseraStressRevisionReport = {
  schemaVersion: 2;
  reportKind: "tessera-stress-revision";
  runId: string;
  generatedAt: string;
  baselineReportPath: string;
  baselineRunId: string;
  revisedRosterFingerprint: string;
  baseline: TesseraStressTestReport;
  revised: TesseraStressTestReport;
  sampleDeltas: TesseraStressRevisionSampleDelta[];
  missionReadinessGuardrail: TesseraMissionReadinessGuardrail;
  summary: {
    improved: number;
    worsened: number;
    unchanged: number;
    ambiguous: number;
    conclusion: "better" | "worse" | "unchanged" | "suppressed";
  };
  limitations: string[];
  warnings: string[];
  artifacts: Array<{
    format: "stress-revision-json" | "stress-revision-html";
    written: string;
  }>;
};

export type UnitSummary = {
  id: string;
  name: string;
  factionId: string;
  role: string;
  pointsFrom: number;
  modelCounts: number[];
  tags: PreferenceTag[];
  keywords: string[];
  isNamedCharacter: boolean;
  isLegend: boolean;
  supported: boolean;
};

export type FactionSummary = {
  id: string;
  name: string;
  unitCount: number;
  supported: boolean;
  keywords: string[];
  styles: PreferenceTag[];
};

export type DataStatus = {
  package: "@alpaca-software/40kdc-data";
  packageVersion: string;
  edition: "11th";
  dataslate: string;
  supportedFactionIds: string[];
  factionCount: number;
  buildableFactionCount: number;
  unitCount: number;
  provisionalPoints: number;
  custodesUnitCount: number;
  provisionalCustodesPoints: number;
  attribution: {
    text: "Powered by 40kdc-data";
    url: "https://40kdc.alpacasoft.dev";
  };
  sources: {
    releaseId: string;
    rules: {
      package: "@alpaca-software/40kdc-data";
      version: string;
      edition: "11th";
      dataslate: string;
    };
    newRecruit: {
      repository: "BSData/wh40k-11e";
      commit: string;
      gameSystemRevision: number;
      generatedAt: string;
    };
    official: {
      mfmVersion: string;
      updatedAt: string;
      contentSha256: string;
      checkedAt: string;
    };
  };
  freshness: {
    state: "pinned" | "update-available" | "official-update-pending" | "unknown";
    checkedAt: string;
  };
  newRecruitCoverage: {
    factionCount: number;
    exportCapableFactions: number;
    completeFactions: number;
    engineUnits: number;
    mappedUnits: number;
    mappedBaseLoadouts: number;
  };
  conflicts: {
    total: number;
    blocking: number;
  };
};

export type LiveDataFreshness = {
  checkedAt: string;
  state: "current" | "update-available" | "official-update-pending" | "unknown";
  rules: {
    pinnedVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean | null;
  };
  newRecruit: {
    pinnedCommit: string;
    latestCommit: string | null;
    updateAvailable: boolean | null;
  };
  official: {
    pinnedVersion: string;
    latestVersion: string | null;
    pinnedContentSha256: string;
    latestContentSha256: string | null;
    updateAvailable: boolean | null;
  };
};
