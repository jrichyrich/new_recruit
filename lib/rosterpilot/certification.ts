import crypto from "node:crypto";

import {
  factions,
  normalizeName,
} from "@alpaca-software/40kdc-data";
import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";

import {
  buildRoster,
  exportRoster,
  getDataStatus,
  listDetachments,
  searchUnits,
  validateRoster,
} from "./engine";
import { getNewRecruitFactionCatalogue } from "./catalogue";
import {
  getNewRecruitCapability,
  listDataConflicts,
  newRecruitCatalogue,
} from "./catalogue-summary";
import { getCachedDataFreshness } from "./freshness";
import { newRecruitRos } from "./new-recruit";
import { resolveNewRecruitUnit } from "./new-recruit-resolver";
import {
  buildExportableRosterCandidate,
  rosterExecutionFingerprint,
  rosterStructuralFingerprint,
} from "./stress-portfolio";
import {
  PreferenceTagSchema,
  RosterDraftV2Schema,
  type ConnectorEvent,
  type RosterDraftV1,
  type RuntimeProvenance,
} from "./types";
import {
  deriveCertificationCoverageDimensions,
  type CertificationCoverageDimensions,
} from "./certification-coverage";

export const CERTIFICATION_SCHEMA_VERSION = 1 as const;

export const CertificationTierSchema = z.enum([
  "deterministic",
  "connector",
  "live",
]);
export type CertificationTier = z.infer<typeof CertificationTierSchema>;

export const CertificationResultStatusSchema = z.enum([
  "pass",
  "fail",
  "unsupported",
  "degraded",
  "skipped",
]);
export type CertificationResultStatus = z.infer<
  typeof CertificationResultStatusSchema
>;

export const ConnectorEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1),
    recordedAt: z.string().datetime(),
    provider: z.enum(["new-recruit", "tessera"]),
    action: z.enum(["prepare", "probe", "simulate"]),
    origin: z.enum([
      "new-remote",
      "persistent-cache",
      "manifest-reuse",
      "in-memory",
    ]),
    outcome: z.enum(["verified", "reused", "failed", "uncertain"]),
    remoteId: z.string().min(1).nullable(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .strict();
export type { ConnectorEvent } from "./types";

export const CertificationExpertReviewBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    dataPinSha256: z.string().regex(/^[0-9a-f]{64}$/),
    factionContractSha256: z.string().regex(/^[0-9a-f]{64}$/),
    bindingSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const PendingExpertReviewSchema = z
  .object({
    status: z.literal("pending"),
    reviewedAt: z.string().min(1).optional(),
    assertions: z.array(z.string().min(1)).default([]),
    binding: CertificationExpertReviewBindingSchema.optional(),
    invalidationReason: z
      .enum(["unbound-legacy", "binding-mismatch"])
      .optional(),
  })
  .strict();

const ReviewedExpertReviewSchema = z
  .object({
    status: z.literal("reviewed"),
    reviewedAt: z.string().min(1),
    assertions: z.array(z.string().min(1)).min(1),
    binding: CertificationExpertReviewBindingSchema,
  })
  .strict();

const ExpertReviewSchema = z.preprocess(
  (input) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return input;
    }
    const review = input as Record<string, unknown>;
    const status = review.status ?? "pending";
    if (status === "reviewed" && review.binding === undefined) {
      return {
        ...review,
        status: "pending",
        invalidationReason: "unbound-legacy",
      };
    }
    return {
      ...review,
      status,
    };
  },
  z.discriminatedUnion("status", [
    PendingExpertReviewSchema,
    ReviewedExpertReviewSchema,
  ]),
);

const RepresentativeUnitModelMultisetEntrySchema = z
  .object({
    unitId: z.string().min(1),
    modelCount: z.number().int().positive(),
    selectionCount: z.number().int().positive(),
  })
  .strict();

export const RepresentativeRosterGoldenEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    detachmentId: z.string().min(1),
    warlordUnitId: z.string().min(1),
    unitModelMultiset: z
      .array(RepresentativeUnitModelMultisetEntrySchema)
      .min(1),
    structuralFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    executionFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    canonicalRoszSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

const RepresentativeRosterSchema = z
  .object({
    id: z.string().min(1),
    pointsLimit: z.number().int().positive(),
    capabilities: z
      .array(
        z.enum([
          "roster-correctness",
          "new-recruit-export",
          "new-recruit-delivery",
          "tessera-preparation",
          "tessera-simulation",
        ]),
      )
      .min(1),
    minimumPointsUtilization: z.number().min(0).max(1),
    /**
     * Optional only for schema-v1 compatibility. An absent golden is an
     * explicit pending contract during execution and can never produce a
     * passing representative build or export result.
     */
    goldenEvidence:
      RepresentativeRosterGoldenEvidenceSchema.optional(),
  })
  .strict();

const TesseraPostureSchema = z.enum([
  "balanced-control",
  "ranged-pressure",
  "assault-pressure",
]);

const TesseraCompositionSchema = z.enum([
  "mixed",
  "mass",
  "elite-heavy",
]);

const PortfolioPolicySchema = z
  .object({
    requiredCorePostures: z
      .array(TesseraPostureSchema)
      .length(3)
      .refine(
        (postures) => new Set(postures).size === postures.length,
        "Core postures must be unique.",
      ),
    notApplicableCompositions: z
      .array(
        z
          .object({
            composition: TesseraCompositionSchema,
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    namedCharacterSpecialist: z.enum([
      "required",
      "not-applicable",
      "review-pending",
    ]),
  })
  .strict();

export const CertificationCapabilityRequirementSchema = z.enum([
  "required",
  "unsupported",
]);

export const CERTIFICATION_CAPABILITY_BOUNDARY_CODES = {
  rosterCorrectness:
    "CERTIFICATION_ROSTER_CORRECTNESS_UNSUPPORTED",
  newRecruitExport: "NEW_RECRUIT_MAPPING_UNAVAILABLE",
  newRecruitDelivery:
    "CERTIFICATION_NEW_RECRUIT_DELIVERY_UNSUPPORTED",
  tesseraPreparation:
    "CERTIFICATION_TESSERA_PREPARATION_UNSUPPORTED",
  trustedTesseraSimulation:
    "CERTIFICATION_TRUSTED_TESSERA_SIMULATION_UNSUPPORTED",
} as const;

export const CERTIFICATION_CAPABILITY_DEPENDENCY_CODES = {
  trustedSimulationBlockedByExport:
    "CERTIFICATION_TRUSTED_TESSERA_SIMULATION_BLOCKED_BY_EXPORT",
  trustedSimulationBlockedByDelivery:
    "CERTIFICATION_TRUSTED_TESSERA_SIMULATION_BLOCKED_BY_DELIVERY",
} as const;

export const TesseraPreparationCapabilitySchema = z.enum([
  "complete",
  "degraded",
  "unsupported",
]);

const ExplicitFactionCertificationSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    rosterCorrectness: CertificationCapabilityRequirementSchema,
    newRecruitExport: CertificationCapabilityRequirementSchema,
    newRecruitDelivery: CertificationCapabilityRequirementSchema,
    tesseraPreparation:
      TesseraPreparationCapabilitySchema.default("complete"),
    trustedTesseraSimulation:
      CertificationCapabilityRequirementSchema,
    expectedBlockingConflicts: z.number().int().nonnegative(),
    expectedLimitations: z.array(z.string().min(1)).default([]),
    detachmentIds: z.array(z.string().min(1)).default([]),
    representativeRosters: z
      .array(RepresentativeRosterSchema)
      .default([]),
    portfolioPolicy: PortfolioPolicySchema.optional(),
    expertReview: ExpertReviewSchema.default({
      status: "pending",
      assertions: [],
    }),
  })
  .strict();

/**
 * Schema-v1 manifests originally serialized only New Recruit export and
 * Tessera preparation. Preserve their historical coupled behavior when those
 * documents are read, while ensuring every parsed faction has the explicit
 * five-capability contract used by current writers.
 */
export const FactionCertificationSchema = z.preprocess(
  (input) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return input;
    }
    const faction = input as Record<string, unknown>;
    const newRecruitExport = faction.newRecruitExport;
    const tesseraPreparation =
      faction.tesseraPreparation ?? "complete";
    const legacyExternalCapabilityUnsupported =
      newRecruitExport === "unsupported" ||
      tesseraPreparation === "unsupported";
    return {
      ...faction,
      rosterCorrectness:
        faction.rosterCorrectness ?? "required",
      newRecruitDelivery:
        faction.newRecruitDelivery ??
        (newRecruitExport === "unsupported"
          ? "unsupported"
          : "required"),
      trustedTesseraSimulation:
        faction.trustedTesseraSimulation ??
        (legacyExternalCapabilityUnsupported
          ? "unsupported"
          : "required"),
    };
  },
  ExplicitFactionCertificationSchema,
);

export const CertificationDataPinSchema = z
  .object({
    releaseId: z.string().min(1),
    rulesPackageVersion: z.string().min(1),
    newRecruitRepository: z.string().min(1).optional(),
    newRecruitCommit: z.string().regex(/^[0-9a-f]{40}$/),
    newRecruitGameSystemRevision: z
      .number()
      .int()
      .nonnegative()
      .optional(),
    officialMfmVersion: z.string().min(1).optional(),
    officialMfmContentSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export const CertificationBaselinesSchema = z
  .object({
    buildableFactions: z.number().int().positive(),
    exportCapableFactions: z.number().int().nonnegative(),
    blockingConflicts: z.number().int().nonnegative(),
    uniqueBlockingConflicts: z
      .number()
      .int()
      .nonnegative()
      .optional(),
  })
  .strict();

const CertificationManifestDocumentSchema = z
  .object({
    schemaVersion: z.literal(CERTIFICATION_SCHEMA_VERSION),
    manifestKind: z.literal("rosterpilot-faction-certification"),
    dataPin: CertificationDataPinSchema,
    baselines: CertificationBaselinesSchema,
    defaults: z
      .object({
        pointBands: z.array(z.number().int().positive()).min(1),
        minimumPointsUtilization: z.number().min(0).max(1),
        preferences: z.array(PreferenceTagSchema).min(1),
        allowNamedCharacters: z.boolean(),
        allowLegends: z.boolean(),
        opponentPostures: z.array(
          TesseraPostureSchema,
        ),
        specialistCases: z.array(z.string().min(1)),
        portfolioPolicy: PortfolioPolicySchema,
      })
      .strict(),
    browserFixtures: z.array(z.string().min(1)),
    factions: z.array(FactionCertificationSchema).min(1),
  })
  .strict();

type ParsedCertificationManifest = z.infer<
  typeof CertificationManifestDocumentSchema
>;

export const CertificationManifestSchema =
  CertificationManifestDocumentSchema.transform((manifest) => ({
    ...manifest,
    factions: manifest.factions.map((faction) => ({
      ...faction,
      expertReview: synchronizeCertificationExpertReview({
        review: faction.expertReview,
        expectedBinding: certificationExpertReviewBinding(
          manifest,
          faction,
        ),
      }),
    })),
  }));

export type CertificationManifest = z.infer<
  typeof CertificationManifestSchema
>;
export type FactionCertification = z.infer<
  typeof FactionCertificationSchema
>;
export type CertificationExpertReviewBinding = z.infer<
  typeof CertificationExpertReviewBindingSchema
>;
export type RepresentativeRosterGoldenEvidence = z.infer<
  typeof RepresentativeRosterGoldenEvidenceSchema
>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(
      value as Record<string, unknown>,
    )
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalPortfolioPolicy(
  policy: FactionCertification["portfolioPolicy"] | CertificationManifest["defaults"]["portfolioPolicy"],
) {
  if (!policy) return null;
  return {
    requiredCorePostures: [...policy.requiredCorePostures].sort(),
    notApplicableCompositions: [
      ...policy.notApplicableCompositions,
    ].sort((left, right) =>
      `${left.composition}\u0000${left.reason}`.localeCompare(
        `${right.composition}\u0000${right.reason}`,
      ),
    ),
    namedCharacterSpecialist: policy.namedCharacterSpecialist,
  };
}

/**
 * Binds manual faction assertions to the exact pinned data and executable
 * faction contract they reviewed. Set-like contract arrays are normalized so
 * harmless serialization reordering does not invalidate a review.
 */
export function certificationExpertReviewBinding(
  manifest: Pick<ParsedCertificationManifest, "dataPin" | "defaults">,
  faction: FactionCertification,
): CertificationExpertReviewBinding {
  const dataPinSha256 = sha256(canonicalJson(manifest.dataPin));
  const factionContractSha256 = sha256(
    canonicalJson({
      defaults: {
        ...manifest.defaults,
        pointBands: [...manifest.defaults.pointBands].sort(
          (left, right) => left - right,
        ),
        preferences: [...manifest.defaults.preferences].sort(),
        opponentPostures: [
          ...manifest.defaults.opponentPostures,
        ].sort(),
        specialistCases: [
          ...manifest.defaults.specialistCases,
        ].sort(),
        portfolioPolicy: canonicalPortfolioPolicy(
          manifest.defaults.portfolioPolicy,
        ),
      },
      faction: {
        id: faction.id,
        name: faction.name,
        rosterCorrectness: faction.rosterCorrectness,
        newRecruitExport: faction.newRecruitExport,
        newRecruitDelivery: faction.newRecruitDelivery,
        tesseraPreparation: faction.tesseraPreparation,
        trustedTesseraSimulation:
          faction.trustedTesseraSimulation,
        expectedBlockingConflicts:
          faction.expectedBlockingConflicts,
        expectedLimitations: [
          ...faction.expectedLimitations,
        ].sort(),
        detachmentIds: [...faction.detachmentIds].sort(),
        representativeRosters: faction.representativeRosters
          .map((roster) => ({
            ...roster,
            capabilities: [...roster.capabilities].sort(),
            ...(roster.goldenEvidence
              ? {
                  goldenEvidence: {
                    ...roster.goldenEvidence,
                    unitModelMultiset: [
                      ...roster.goldenEvidence.unitModelMultiset,
                    ].sort(
                      (left, right) =>
                        left.unitId.localeCompare(right.unitId) ||
                        left.modelCount - right.modelCount ||
                        left.selectionCount -
                          right.selectionCount,
                    ),
                  },
                }
              : {}),
          }))
          .sort((left, right) =>
            canonicalJson(left).localeCompare(canonicalJson(right)),
          ),
        portfolioPolicy: canonicalPortfolioPolicy(
          faction.portfolioPolicy,
        ),
      },
    }),
  );
  return {
    schemaVersion: 1,
    dataPinSha256,
    factionContractSha256,
    bindingSha256: sha256(
      canonicalJson({
        schemaVersion: 1,
        dataPinSha256,
        factionContractSha256,
      }),
    ),
  };
}

export function certificationExpertReviewBindingMatches(
  actual: CertificationExpertReviewBinding | undefined,
  expected: CertificationExpertReviewBinding,
): boolean {
  return (
    actual?.schemaVersion === expected.schemaVersion &&
    actual.dataPinSha256 === expected.dataPinSha256 &&
    actual.factionContractSha256 ===
      expected.factionContractSha256 &&
    actual.bindingSha256 === expected.bindingSha256
  );
}

export function synchronizeCertificationExpertReview(input: {
  review: FactionCertification["expertReview"];
  expectedBinding: CertificationExpertReviewBinding;
}): FactionCertification["expertReview"] {
  if (
    input.review.status === "reviewed" &&
    certificationExpertReviewBindingMatches(
      input.review.binding,
      input.expectedBinding,
    )
  ) {
    return {
      ...input.review,
      binding: input.expectedBinding,
    };
  }
  const hadReviewedEvidence =
    input.review.reviewedAt !== undefined ||
    input.review.assertions.length > 0;
  return {
    status: "pending",
    ...(input.review.reviewedAt
      ? { reviewedAt: input.review.reviewedAt }
      : {}),
    assertions: input.review.assertions,
    binding: input.expectedBinding,
    ...(input.review.status === "reviewed"
      ? { invalidationReason: "binding-mismatch" as const }
      : input.review.invalidationReason
        ? { invalidationReason: input.review.invalidationReason }
        : hadReviewedEvidence &&
            input.review.binding &&
            !certificationExpertReviewBindingMatches(
              input.review.binding,
              input.expectedBinding,
            )
          ? { invalidationReason: "binding-mismatch" as const }
          : {}),
  };
}

export function synchronizedTesseraPreparationExpectation(input: {
  mappingAvailable: boolean;
  priorNewRecruitExport?: FactionCertification["newRecruitExport"];
  priorTesseraPreparation?: FactionCertification["tesseraPreparation"];
}): FactionCertification["tesseraPreparation"] {
  if (!input.mappingAvailable) return "unsupported";
  if (
    input.priorNewRecruitExport === "unsupported" ||
    input.priorTesseraPreparation === "unsupported"
  ) {
    return "degraded";
  }
  return input.priorTesseraPreparation ?? "complete";
}

export type TesseraPreparationObservation = {
  /**
   * Compatibility readers may omit this field. In that case `available`
   * retains its historical meaning.
   */
  mappingAvailable?: boolean;
  available: boolean;
  executionViable: boolean;
  maximumResultStatus: "complete" | "degraded" | null;
};

export function classifyTesseraPreparationCapability(
  expected: FactionCertification["tesseraPreparation"],
  observed: TesseraPreparationObservation,
): {
  status: Extract<
    CertificationResultStatus,
    "pass" | "fail" | "unsupported" | "degraded"
  >;
  code: string | null;
} {
  const mappingAvailable =
    observed.mappingAvailable ?? observed.available;
  if (!mappingAvailable) {
    return expected === "unsupported"
      ? {
          status: "unsupported",
          code: "CERTIFICATION_TESSERA_MAPPING_UNSUPPORTED",
        }
      : {
          status: "fail",
          code: "CERTIFICATION_TESSERA_MAPPING_REGRESSION",
        };
  }
  if (expected === "unsupported") {
    return {
      status: "fail",
      code: "CERTIFICATION_TESSERA_CAPABILITY_DRIFT",
    };
  }
  if (!observed.available || !observed.executionViable) {
    return {
      status: "fail",
      code: "CERTIFICATION_PORTFOLIO_NOT_EXECUTABLE",
    };
  }
  if (observed.maximumResultStatus === "complete") {
    return { status: "pass", code: null };
  }
  if (expected === "complete") {
    return {
      status: "fail",
      code: "CERTIFICATION_PORTFOLIO_COVERAGE_REGRESSION",
    };
  }
  return {
    status: "degraded",
    code: "CERTIFICATION_PORTFOLIO_DEGRADED",
  };
}

export type NamedCharacterSpecialistExpectation =
  z.infer<typeof PortfolioPolicySchema>["namedCharacterSpecialist"];

export function classifyNamedCharacterSpecialistCapability(
  expected: NamedCharacterSpecialistExpectation,
  observed:
    | "included"
    | "not-applicable"
    | "unavailable-after-evaluation",
): {
  status: Extract<
    CertificationResultStatus,
    "pass" | "fail" | "degraded" | "skipped"
  >;
  code: string | null;
} {
  if (expected === "not-applicable") {
    return observed === "not-applicable"
      ? {
          status: "skipped",
          code: "CERTIFICATION_NAMED_SPECIALIST_NOT_APPLICABLE",
        }
      : {
          status: "fail",
          code: "CERTIFICATION_NAMED_SPECIALIST_CAPABILITY_DRIFT",
        };
  }
  if (observed === "included") {
    return { status: "pass", code: null };
  }
  if (observed === "not-applicable") {
    return expected === "review-pending"
      ? {
          status: "skipped",
          code: "CERTIFICATION_NAMED_SPECIALIST_REVIEW_REQUIRED",
        }
      : {
          status: "fail",
          code: "CERTIFICATION_NAMED_SPECIALIST_REQUIRED",
        };
  }
  return {
    status: "degraded",
    code: "CERTIFICATION_NAMED_SPECIALIST_UNAVAILABLE",
  };
}

export type CertificationArtifactDescriptor = {
  kind:
    | "canonical-rosz"
    | "enriched-rosz"
    | "profile-policy"
    | "profile-policy-scaffold"
    | "browser-fixture-evidence"
    | "scenario"
    | "report"
    | "report-attempt"
    | "report-checksum"
    | "manifest";
  path: string;
  sha256: string | null;
};

export const CertificationArtifactDescriptorSchema: z.ZodType<
  CertificationArtifactDescriptor
> = z
  .object({
    kind: z.enum([
      "canonical-rosz",
      "enriched-rosz",
      "profile-policy",
      "profile-policy-scaffold",
      "browser-fixture-evidence",
      "scenario",
      "report",
      "report-attempt",
      "report-checksum",
      "manifest",
    ]),
    path: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

export type CertificationCaseResult = {
  caseId: string;
  factionId: string | null;
  workflow:
    | "oracle"
    | "roster-correctness"
    | "new-recruit-export"
    | "new-recruit-delivery"
    | "tessera-preparation"
    | "tessera-simulation"
    | "browser-fixture";
  stage: string;
  status: CertificationResultStatus;
  code: string | null;
  message: string;
  retryable: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  evidence: Record<string, unknown>;
  artifacts: CertificationArtifactDescriptor[];
  connectorEvents: ConnectorEvent[];
};

const CertificationWorkflowSchema = z.enum([
  "oracle",
  "roster-correctness",
  "new-recruit-export",
  "new-recruit-delivery",
  "tessera-preparation",
  "tessera-simulation",
  "browser-fixture",
]);

export const CertificationCaseResultSchema: z.ZodType<
  CertificationCaseResult
> = z
  .object({
    caseId: z.string().min(1),
    factionId: z.string().min(1).nullable(),
    workflow: CertificationWorkflowSchema,
    stage: z.string().min(1),
    status: CertificationResultStatusSchema,
    code: z.string().min(1).nullable(),
    message: z.string(),
    retryable: z.boolean(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    evidence: z.record(z.unknown()),
    artifacts: z.array(CertificationArtifactDescriptorSchema),
    connectorEvents: z.array(ConnectorEventSchema),
  })
  .strict();

export type CertificationReport = {
  schemaVersion: typeof CERTIFICATION_SCHEMA_VERSION;
  reportKind: "rosterpilot-certification";
  runId: string;
  tier: CertificationTier;
  generatedAt: string;
  ok: boolean;
  status: "pass" | "degraded" | "fail";
  manifestSha256: string;
  resumedFrom: string | null;
  selection: {
    requestedFaction: string | null;
    shard: { index: number; total: number } | null;
    changedOnly: boolean;
    selectedFactionIds: string[];
  };
  provenance: {
    runtime: RuntimeProvenance | null;
    localAgent: {
      version: string | null;
      protocolVersion: number | null;
      runtime: RuntimeProvenance | null;
      buildId: string | null;
      stale: boolean | null;
    };
    newRecruitUi: {
      identity: string | null;
    };
    tesseraUi: {
      identity: string | null;
    };
    profilePolicy: {
      source: "none" | "cli";
      requestedBasename: string | null;
      artifactPath: string | null;
      sourceSha256: string | null;
      canonicalSha256: string | null;
    };
    dataPin: CertificationManifest["dataPin"];
    cachedLiveUpdateCheck: {
      state: string;
      checkedAt: string;
    } | null;
  };
  baselines: CertificationManifest["baselines"] & {
    actualBuildableFactions: number;
    actualExportCapableFactions: number;
    actualBlockingConflicts: number;
    actualUniqueBlockingConflicts: number | null;
  };
  coverage: {
    factions: {
      intended: number;
      exercised: number;
      passed: number;
      failed: number;
      unsupported: number;
      pendingExpertReview: number;
    };
    workflows: Record<
      CertificationCaseResult["workflow"],
      Record<CertificationResultStatus, number>
    >;
    browserFixtures: {
      intended: number;
      exercised: number;
    };
    dimensions: CertificationCoverageDimensions;
  };
  cases: CertificationCaseResult[];
  connectorEvents: ConnectorEvent[];
  artifacts: CertificationArtifactDescriptor[];
  limitations: string[];
};

const RuntimeProvenanceSchema = z
  .object({
    rosterPilotVersion: z.string().min(1),
    rulesPackageVersion: z.string().min(1),
    stressGeneratorVersion: z.string().min(1),
    processStartedAt: z.string().datetime(),
    gitHead: z.string().min(1).nullable(),
    sourceFingerprintAtStart: z.string().min(1),
    sourceFingerprintNow: z.string().min(1),
    buildId: z.string().min(1),
    stale: z.boolean(),
  })
  .strict();

const CertificationLocalAgentProvenanceSchema = z
  .object({
    version: z.string().min(1).nullable(),
    protocolVersion: z
      .number()
      .int()
      .nonnegative()
      .nullable(),
    runtime: RuntimeProvenanceSchema.nullable().default(null),
    buildId: z.string().min(1).nullable(),
    stale: z.boolean().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.runtime) return;
    if (value.buildId !== value.runtime.buildId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["buildId"],
        message:
          "The legacy local-agent build id must match the full runtime provenance.",
      });
    }
    if (value.stale !== value.runtime.stale) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stale"],
        message:
          "The legacy local-agent stale flag must match the full runtime provenance.",
      });
    }
  });

const CertificationSelectionSchema = z
  .object({
    requestedFaction: z.string().min(1).nullable(),
    shard: z
      .object({
        index: z.number().int().positive(),
        total: z.number().int().positive(),
      })
      .strict()
      .refine(
        (shard) => shard.index <= shard.total,
        "Shard index must not exceed its total.",
      )
      .nullable(),
    changedOnly: z.boolean(),
    selectedFactionIds: z
      .array(z.string().min(1))
      .refine(
        (factionIds) =>
          new Set(factionIds).size === factionIds.length,
        "Selected faction ids must be unique.",
      ),
  })
  .strict();

const CertificationStatusCountsSchema = z
  .object({
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();

const CertificationCoverageDimensionsSchema: z.ZodType<
  CertificationCoverageDimensions
> = z
  .object({
    detachments: z
      .object({
        intended: z.array(z.string().min(1)),
        exercised: z.array(z.string().min(1)),
        missing: z.array(z.string().min(1)),
      })
      .strict(),
    unitCategories: z
      .object({
        exercised: z.array(z.string().min(1)),
        caseCountByCategory: z.record(
          z.number().int().nonnegative(),
        ),
      })
      .strict(),
    specialistCases: z
      .object({
        intended: z.array(z.string().min(1)),
        exercised: z.array(z.string().min(1)),
        missing: z.array(z.string().min(1)),
        evidenceCaseIds: z.record(
          z.array(z.string().min(1)),
        ),
      })
      .strict(),
    failureModes: z.array(
      z
        .object({
          code: z.string().min(1),
          count: z.number().int().positive(),
          statuses: z.array(CertificationResultStatusSchema),
          retryableCount: z.number().int().nonnegative(),
          caseIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();

export const CertificationReportSchema: z.ZodType<
  CertificationReport,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    schemaVersion: z.literal(CERTIFICATION_SCHEMA_VERSION),
    reportKind: z.literal("rosterpilot-certification"),
    runId: z.string().min(1),
    tier: CertificationTierSchema,
    generatedAt: z.string().datetime(),
    ok: z.boolean(),
    status: z.enum(["pass", "degraded", "fail"]),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    resumedFrom: z.string().min(1).nullable(),
    selection: CertificationSelectionSchema,
    provenance: z
      .object({
        runtime: RuntimeProvenanceSchema.nullable(),
        localAgent: CertificationLocalAgentProvenanceSchema,
        newRecruitUi: z
          .object({
            identity: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .nullable(),
          })
          .strict()
          .default({ identity: null }),
        tesseraUi: z
          .object({
            identity: z.string().min(1).nullable(),
          })
          .strict(),
        profilePolicy: z
          .object({
            source: z.enum(["none", "cli"]),
            requestedBasename: z.string().min(1).nullable(),
            artifactPath: z.string().min(1).nullable(),
            sourceSha256: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .nullable(),
            canonicalSha256: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .nullable(),
          })
          .strict(),
        dataPin: CertificationDataPinSchema,
        cachedLiveUpdateCheck: z
          .object({
            state: z.string().min(1),
            checkedAt: z.string().datetime(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    baselines: CertificationBaselinesSchema
      .extend({
        actualBuildableFactions: z
          .number()
          .int()
          .nonnegative(),
        actualExportCapableFactions: z
          .number()
          .int()
          .nonnegative(),
        actualBlockingConflicts: z
          .number()
          .int()
          .nonnegative(),
        actualUniqueBlockingConflicts: z
          .number()
          .int()
          .nonnegative()
          .nullable(),
      })
      .strict(),
    coverage: z
      .object({
        factions: z
          .object({
            intended: z.number().int().nonnegative(),
            exercised: z.number().int().nonnegative(),
            passed: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative(),
            unsupported: z.number().int().nonnegative(),
            pendingExpertReview: z
              .number()
              .int()
              .nonnegative(),
          })
          .strict(),
        workflows: z
          .object({
            oracle: CertificationStatusCountsSchema,
            "roster-correctness":
              CertificationStatusCountsSchema,
            "new-recruit-export":
              CertificationStatusCountsSchema,
            "new-recruit-delivery":
              CertificationStatusCountsSchema,
            "tessera-preparation":
              CertificationStatusCountsSchema,
            "tessera-simulation":
              CertificationStatusCountsSchema,
            "browser-fixture":
              CertificationStatusCountsSchema,
          })
          .strict(),
        browserFixtures: z
          .object({
            intended: z.number().int().nonnegative(),
            exercised: z.number().int().nonnegative(),
          })
          .strict(),
        dimensions: CertificationCoverageDimensionsSchema.default({
          detachments: {
            intended: [],
            exercised: [],
            missing: [],
          },
          unitCategories: {
            exercised: [],
            caseCountByCategory: {},
          },
          specialistCases: {
            intended: [],
            exercised: [],
            missing: [],
            evidenceCaseIds: {},
          },
          failureModes: [],
        }),
      })
      .strict(),
    cases: z.array(CertificationCaseResultSchema),
    connectorEvents: z.array(ConnectorEventSchema),
    artifacts: z.array(CertificationArtifactDescriptorSchema),
    limitations: z.array(z.string()),
  })
  .strict();

export type DeterministicCertificationOptions = {
  factionId?: string;
  shard?: { index: number; total: number };
  changedOnly?: boolean;
  skipAll?: boolean;
  resumedCaseIds?: Set<string>;
  artifactWriter?: (
    filename: string,
    content: Uint8Array,
  ) => Promise<string>;
  progress?: (message: string) => void;
};

function timestamp(): string {
  return new Date().toISOString();
}

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function certificationManifestSha256(
  manifest: CertificationManifest,
): string {
  return sha256(JSON.stringify(manifest));
}

function caseResult(
  input: Omit<
    CertificationCaseResult,
    "startedAt" | "completedAt" | "durationMs"
  > & { startedAt: string; startedMs: number },
): CertificationCaseResult {
  const completedAt = timestamp();
  const { startedMs, ...result } = input;
  return {
    ...result,
    startedAt: input.startedAt,
    completedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
  };
}

export function certificationExpertReviewCases(
  faction: FactionCertification,
): CertificationCaseResult[] {
  if (faction.expertReview.status === "pending") {
    const startedAt = timestamp();
    return [
      caseResult({
        caseId: `${faction.id}:expert-review:pending`,
        factionId: faction.id,
        workflow: "oracle",
        stage: "manual-verification",
        status: "degraded",
        code: "CERTIFICATION_EXPERT_REVIEW_PENDING",
        message: `${faction.name} is awaiting expert review.`,
        retryable: false,
        evidence: {
          evidenceSource: "manual-expert-review",
          automated: false,
          reviewStatus: "pending",
          reviewedAt: faction.expertReview.reviewedAt ?? null,
          draftAssertions: faction.expertReview.assertions,
          reviewBinding: faction.expertReview.binding ?? null,
          invalidationReason:
            faction.expertReview.invalidationReason ?? null,
        },
        artifacts: [],
        connectorEvents: [],
        startedAt,
        startedMs: Date.now(),
      }),
    ];
  }
  return faction.expertReview.assertions.map(
    (assertionText, assertionIndex) => {
      const startedAt = timestamp();
      return caseResult({
        caseId: `${faction.id}:expert-review:${String(assertionIndex + 1).padStart(2, "0")}`,
        factionId: faction.id,
        workflow: "oracle",
        stage: "manual-verification",
        status: "pass",
        code: null,
        message: assertionText,
        retryable: false,
        evidence: {
          evidenceSource: "manual-expert-review",
          automated: false,
          reviewStatus: "reviewed",
          reviewedAt: faction.expertReview.reviewedAt,
          reviewBinding: faction.expertReview.binding,
          assertion: assertionText,
          assertionIndex: assertionIndex + 1,
        },
        artifacts: [],
        connectorEvents: [],
        startedAt,
        startedMs: Date.now(),
      });
    },
  );
}

function failCase(
  caseId: string,
  factionId: string | null,
  workflow: CertificationCaseResult["workflow"],
  stage: string,
  error: unknown,
  startedAt: string,
  startedMs: number,
): CertificationCaseResult {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "CERTIFICATION_ASSERTION_FAILED";
  const evidence =
    error &&
    typeof error === "object" &&
    "evidence" in error &&
    error.evidence &&
    typeof error.evidence === "object" &&
    !Array.isArray(error.evidence)
      ? (error.evidence as Record<string, unknown>)
      : {};
  return caseResult({
    caseId,
    factionId,
    workflow,
    stage,
    status: "fail",
    code,
    message:
      error instanceof Error
        ? error.message
        : "The certification assertion failed.",
    retryable: false,
    evidence,
    artifacts: [],
    connectorEvents: [],
    startedAt,
    startedMs,
  });
}

function assertion(condition: unknown, code: string, message: string): asserts condition {
  if (condition) return;
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

function selectedFactions(
  manifest: CertificationManifest,
  options: DeterministicCertificationOptions,
): FactionCertification[] {
  if (options.skipAll) return [];
  let selected = manifest.factions;
  if (options.factionId) {
    selected = selected.filter((entry) => entry.id === options.factionId);
    assertion(
      selected.length === 1,
      "CERTIFICATION_FACTION_NOT_FOUND",
      `Certification manifest has no faction "${options.factionId}".`,
    );
  }
  if (options.shard) {
    const { index, total } = options.shard;
    assertion(
      total > 0 && index > 0 && index <= total,
      "CERTIFICATION_SHARD_INVALID",
      `Shard must use a one-based index within its total; received ${index}/${total}.`,
    );
    selected = selected.filter(
      (_, factionIndex) => factionIndex % total === index - 1,
    );
  }
  return selected;
}

type CanonicalXmlNode = {
  tag: string;
  attributes: Record<string, string>;
  children: CanonicalXmlNode[];
};

function decodeCanonicalXmlAttribute(value: string): string {
  assertion(
    !/&(?!(?:amp|quot|apos|lt|gt);)/.test(value),
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    "The canonical ROS contains an unsupported or malformed XML entity.",
  );
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function canonicalXmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const input = source.trimEnd();
  const pattern = /\s+([A-Za-z_:][\w:.-]*)="([^"]*)"/gy;
  let offset = 0;
  while (offset < input.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(input);
    assertion(
      match,
      "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
      "The canonical ROS contains malformed XML attributes.",
    );
    assertion(
      attributes[match[1]] === undefined,
      "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
      `The canonical ROS repeats the "${match[1]}" XML attribute.`,
    );
    attributes[match[1]] = decodeCanonicalXmlAttribute(match[2]);
    offset = pattern.lastIndex;
  }
  return attributes;
}

function parseCanonicalRos(xml: string): CanonicalXmlNode {
  const declaration = xml.match(
    /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\s*/,
  );
  assertion(
    declaration,
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    "The canonical ROS does not contain the expected XML declaration.",
  );
  const body = xml.slice(declaration[0].length);
  const tokenPattern =
    /<\/[A-Za-z][\w:-]*\s*>|<[A-Za-z][\w:-]*(?:\s+[^<>]*?)?\s*\/?>/g;
  const roots: CanonicalXmlNode[] = [];
  const stack: CanonicalXmlNode[] = [];
  let offset = 0;
  for (const match of body.matchAll(tokenPattern)) {
    assertion(
      body.slice(offset, match.index).trim().length === 0,
      "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
      "The canonical ROS contains unsupported text or markup.",
    );
    const token = match[0];
    if (token.startsWith("</")) {
      const closing = token.match(/^<\/([A-Za-z][\w:-]*)\s*>$/);
      const current = stack.pop();
      assertion(
        closing && current?.tag === closing[1],
        "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
        "The canonical ROS contains an unbalanced XML element.",
      );
    } else {
      const opening = token.match(
        /^<([A-Za-z][\w:-]*)([\s\S]*?)(\/?)>$/,
      );
      assertion(
        opening,
        "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
        "The canonical ROS contains a malformed XML element.",
      );
      const node: CanonicalXmlNode = {
        tag: opening[1],
        attributes: canonicalXmlAttributes(opening[2]),
        children: [],
      };
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else roots.push(node);
      if (opening[3] !== "/") stack.push(node);
    }
    offset = (match.index ?? 0) + token.length;
  }
  assertion(
    body.slice(offset).trim().length === 0 &&
      stack.length === 0 &&
      roots.length === 1,
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    "The canonical ROS does not contain exactly one balanced XML root.",
  );
  return roots[0];
}

function directChildren(
  node: CanonicalXmlNode,
  tag: string,
): CanonicalXmlNode[] {
  return node.children.filter((child) => child.tag === tag);
}

function requiredContainer(
  node: CanonicalXmlNode,
  tag: string,
  context: string,
): CanonicalXmlNode {
  const containers = directChildren(node, tag);
  assertion(
    containers.length === 1,
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    `The canonical ROS ${context} must contain exactly one <${tag}> element.`,
  );
  return containers[0];
}

function childSelections(
  node: CanonicalXmlNode,
  context: string,
): CanonicalXmlNode[] {
  const containers = directChildren(node, "selections");
  assertion(
    containers.length <= 1,
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    `The canonical ROS ${context} contains repeated <selections> elements.`,
  );
  if (containers.length === 0) return [];
  assertion(
    containers[0].children.every((child) => child.tag === "selection"),
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    `The canonical ROS ${context} contains a non-selection child.`,
  );
  return containers[0].children;
}

function selectionNumber(
  node: CanonicalXmlNode,
  context: string,
  code: string,
): number {
  const value = Number(node.attributes.number);
  assertion(
    Number.isInteger(value) && value > 0,
    code,
    `The canonical ROS ${context} has an invalid selection count.`,
  );
  return value;
}

function directPointCost(
  node: CanonicalXmlNode,
  context: string,
): CanonicalXmlNode {
  const costs = requiredContainer(node, "costs", context);
  const pointCosts = costs.children.filter(
    (child) =>
      child.tag === "cost" && child.attributes.name === "pts",
  );
  assertion(
    costs.children.length === 1 && pointCosts.length === 1,
    "CERTIFICATION_ROSZ_POINTS_MISMATCH",
    `The canonical ROS ${context} must contain exactly one points cost.`,
  );
  return pointCosts[0];
}

function collectXmlNodes(
  node: CanonicalXmlNode,
  tag: string,
): CanonicalXmlNode[] {
  return [
    ...(node.tag === tag ? [node] : []),
    ...node.children.flatMap((child) =>
      collectXmlNodes(child, tag),
    ),
  ];
}

function referenceExpectation(reference: {
  name: string;
  entryId: string;
  entryGroupId?: string;
  group?: string;
  type: string;
}): Record<string, string | undefined> {
  return {
    name: reference.name,
    entryId: reference.entryId,
    entryGroupId: reference.entryGroupId,
    group: reference.group,
    from: reference.entryGroupId ? "group" : "entry",
    type: reference.type,
  };
}

function assertSelectionReference(
  node: CanonicalXmlNode,
  reference: {
    name: string;
    entryId: string;
    entryGroupId?: string;
    group?: string;
    type: string;
  },
  number: number,
  code: string,
  context: string,
): void {
  const expected = referenceExpectation(reference);
  assertion(
    node.tag === "selection" &&
      Object.entries(expected).every(
        ([key, value]) => node.attributes[key] === value,
      ) &&
      selectionNumber(node, context, code) === number,
    code,
    `The canonical ROS ${context} does not match its pinned catalogue reference.`,
  );
}

function assertEquipmentSelections(
  actual: CanonicalXmlNode[],
  expected: Array<{
    count: number;
    reference: {
      name: string;
      entryId: string;
      entryGroupId?: string;
      group?: string;
      type: string;
    };
  }>,
  context: string,
): void {
  assertion(
    actual.length === expected.length,
    "CERTIFICATION_ROSZ_EQUIPMENT_MISMATCH",
    `The canonical ROS ${context} has ${actual.length} equipment selections; expected ${expected.length}.`,
  );
  for (const [index, item] of expected.entries()) {
    assertSelectionReference(
      actual[index],
      item.reference,
      item.count,
      "CERTIFICATION_ROSZ_EQUIPMENT_MISMATCH",
      `${context} equipment ${index + 1}`,
    );
  }
}

function compareCanonicalXmlTree(
  actual: CanonicalXmlNode,
  expected: CanonicalXmlNode,
  path: string,
): void {
  assertion(
    actual.tag === expected.tag,
    "CERTIFICATION_ROSZ_CANONICAL_TREE_MISMATCH",
    `The canonical ROS changed the XML element at ${path}.`,
  );
  const actualKeys = Object.keys(actual.attributes).sort();
  const expectedKeys = Object.keys(expected.attributes).sort();
  assertion(
    actualKeys.join("\0") === expectedKeys.join("\0"),
    "CERTIFICATION_ROSZ_CANONICAL_TREE_MISMATCH",
    `The canonical ROS changed the XML attributes at ${path}.`,
  );
  for (const key of expectedKeys) {
    const code =
      expected.tag === "selection" && key === "id"
        ? "CERTIFICATION_ROSZ_SELECTION_ID_MISMATCH"
        : expected.tag === "selection" &&
            ["entryId", "entryGroupId", "from", "group", "number", "type"].includes(
              key,
            )
          ? "CERTIFICATION_ROSZ_SELECTION_REFERENCE_MISMATCH"
          : expected.tag === "cost"
            ? "CERTIFICATION_ROSZ_POINTS_MISMATCH"
            : "CERTIFICATION_ROSZ_CANONICAL_TREE_MISMATCH";
    assertion(
      actual.attributes[key] === expected.attributes[key],
      code,
      `The canonical ROS changed "${key}" at ${path}.`,
    );
  }
  assertion(
    actual.children.length === expected.children.length,
    "CERTIFICATION_ROSZ_CANONICAL_TREE_MISMATCH",
    `The canonical ROS changed the child count at ${path}.`,
  );
  for (const [index, child] of expected.children.entries()) {
    compareCanonicalXmlTree(
      actual.children[index],
      child,
      `${path}/${child.tag}[${index + 1}]`,
    );
  }
}

function countByEntryId(
  selections: CanonicalXmlNode[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const selection of selections) {
    const entryId = selection.attributes.entryId ?? "";
    counts.set(entryId, (counts.get(entryId) ?? 0) + 1);
  }
  return counts;
}

export function validateCanonicalRoszArchive(
  roster: RosterDraftV1,
  content: Uint8Array,
): Record<string, unknown> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(content);
  } catch {
    assertion(
      false,
      "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
      "The canonical ROSZ is not a readable ZIP archive.",
    );
  }
  const rosterEntries = Object.entries(entries).filter(([filename]) =>
    filename.toLocaleLowerCase().endsWith(".ros"),
  );
  assertion(
    Object.keys(entries).length === 1 &&
      rosterEntries.length === 1 &&
      !rosterEntries[0][0].includes("/") &&
      !rosterEntries[0][0].includes("\\"),
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    `Expected one root-level .ros entry, found ${rosterEntries.length} among ${Object.keys(entries).length} archive entries.`,
  );
  const xml = strFromU8(rosterEntries[0][1]);
  const root = parseCanonicalRos(xml);
  assertion(
    root.tag === "roster",
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    "The canonical ROS root is not <roster>.",
  );

  const mapping = getNewRecruitFactionCatalogue(roster.factionId);
  assertion(
    mapping,
    "CERTIFICATION_ROSZ_CATALOGUE_IDENTITY_MISMATCH",
    `The canonical roster faction "${roster.factionId}" has no pinned New Recruit catalogue.`,
  );
  const gameSystem = newRecruitCatalogue.gameSystem;
  assertion(
    roster.sourceData.newRecruit.gameSystemRevision ===
        gameSystem.revision &&
      roster.sourceData.newRecruit.catalogueRevision ===
        mapping.catalogue.revision,
    "CERTIFICATION_ROSZ_CATALOGUE_IDENTITY_MISMATCH",
    "The roster source pin does not match the canonical New Recruit catalogue revisions.",
  );
  assertion(
    root.attributes.gameSystemId === gameSystem.id &&
      root.attributes.gameSystemName === gameSystem.name &&
      root.attributes.gameSystemRevision ===
        String(gameSystem.revision),
    "CERTIFICATION_ROSZ_CATALOGUE_IDENTITY_MISMATCH",
    "The canonical ROS game-system ID or revision does not match the pinned catalogue.",
  );
  assertion(
    root.attributes.name === roster.name,
    "CERTIFICATION_ROSZ_ROSTER_NAME_MISMATCH",
    `The canonical ROS roster name is "${root.attributes.name ?? ""}"; expected "${roster.name}".`,
  );
  const rootPointCost = directPointCost(root, "roster");
  assertion(
    rootPointCost.attributes.typeId === gameSystem.pointsTypeId &&
      rootPointCost.attributes.value === String(roster.totalPoints),
    "CERTIFICATION_ROSZ_POINTS_MISMATCH",
    `The canonical ROS total is ${rootPointCost.attributes.value ?? "missing"}; expected ${roster.totalPoints}.`,
  );

  const forces = requiredContainer(root, "forces", "roster");
  const forceNodes = directChildren(forces, "force");
  assertion(
    forces.children.length === 1 && forceNodes.length === 1,
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    "The canonical ROS must contain exactly one force.",
  );
  const force = forceNodes[0];
  assertion(
    normalizeName(mapping.factionName) ===
        normalizeName(roster.factionName) &&
      force.attributes.catalogueName === mapping.catalogue.name,
    "CERTIFICATION_ROSZ_FACTION_MISMATCH",
    `The canonical ROS force does not identify ${roster.factionName} through its pinned catalogue.`,
  );
  assertion(
    force.attributes.catalogueId === mapping.catalogue.id &&
      force.attributes.catalogueRevision ===
        String(mapping.catalogue.revision),
    "CERTIFICATION_ROSZ_CATALOGUE_IDENTITY_MISMATCH",
    "The canonical ROS force catalogue ID or revision does not match the pinned faction catalogue.",
  );

  const expectedXml = newRecruitRos(roster);
  const expectedRoot = parseCanonicalRos(expectedXml);
  const expectedForces = requiredContainer(
    expectedRoot,
    "forces",
    "expected roster",
  );
  const expectedForce = directChildren(expectedForces, "force")[0];
  assertion(
    expectedForce,
    "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    "The canonical exporter expectation does not contain a force.",
  );
  const actualTopLevelSelections = childSelections(force, "force");
  const expectedTopLevelSelections = childSelections(
    expectedForce,
    "expected force",
  );
  const isUnitSelection = (node: CanonicalXmlNode) =>
    node.attributes.type === "unit" ||
    node.attributes.type === "model";
  const actualUnits = actualTopLevelSelections.filter(isUnitSelection);
  const expectedUnits =
    expectedTopLevelSelections.filter(isUnitSelection);
  assertion(
    expectedUnits.length === roster.units.length,
    "CERTIFICATION_ROSZ_UNIT_MULTIPLICITY_MISMATCH",
    "The canonical exporter did not encode one top-level selection for every roster unit.",
  );
  assertion(
    actualUnits.length === roster.units.length,
    "CERTIFICATION_ROSZ_UNIT_MULTIPLICITY_MISMATCH",
    `The canonical ROS contains ${actualUnits.length} unit selections; expected ${roster.units.length}.`,
  );
  const expectedUnitCounts = countByEntryId(expectedUnits);
  const actualUnitCounts = countByEntryId(actualUnits);
  assertion(
    [...expectedUnitCounts.entries()].every(
      ([entryId, count]) => actualUnitCounts.get(entryId) === count,
    ) &&
      [...actualUnitCounts.entries()].every(
        ([entryId, count]) => expectedUnitCounts.get(entryId) === count,
      ),
    "CERTIFICATION_ROSZ_UNIT_MULTIPLICITY_MISMATCH",
    "The canonical ROS changed the exact multiplicity of one or more unit catalogue entries.",
  );

  let equipmentSelectionCount = 0;
  let enhancementSelectionCount = 0;
  for (const [index, unit] of roster.units.entries()) {
    const unitMapping = mapping.units[unit.unitId];
    assertion(
      unitMapping,
      "CERTIFICATION_ROSZ_UNIT_IDENTITY_MISMATCH",
      `The canonical roster unit "${unit.unitId}" has no pinned catalogue entry.`,
    );
    const actualUnit = actualUnits[index];
    assertSelectionReference(
      actualUnit,
      unitMapping,
      1,
      "CERTIFICATION_ROSZ_UNIT_IDENTITY_MISMATCH",
      `unit ${index + 1} (${unit.name})`,
    );
    const unitPointCost = directPointCost(
      actualUnit,
      `unit ${index + 1} (${unit.name})`,
    );
    assertion(
      unitPointCost.attributes.typeId === gameSystem.pointsTypeId &&
        unitPointCost.attributes.value === String(unit.points),
      "CERTIFICATION_ROSZ_POINTS_MISMATCH",
      `The canonical ROS points for unit ${index + 1} (${unit.name}) do not match ${unit.points}.`,
    );

    const unitChildren = childSelections(
      actualUnit,
      `unit ${index + 1} (${unit.name})`,
    );
    const warlordEntryId = unitMapping.warlord?.entryId;
    const warlordSelections = warlordEntryId
      ? unitChildren.filter(
          (child) => child.attributes.entryId === warlordEntryId,
        )
      : [];
    assertion(
      warlordSelections.length === (unit.isWarlord ? 1 : 0),
      "CERTIFICATION_ROSZ_WARLORD_MISMATCH",
      `The canonical ROS Warlord selection for unit ${index + 1} (${unit.name}) does not match the roster.`,
    );
    if (unit.isWarlord) {
      assertion(
        unitMapping.warlord,
        "CERTIFICATION_ROSZ_WARLORD_MISMATCH",
        `${unit.name} is the Warlord but has no pinned Warlord catalogue reference.`,
      );
      assertSelectionReference(
        warlordSelections[0],
        unitMapping.warlord,
        1,
        "CERTIFICATION_ROSZ_WARLORD_MISMATCH",
        `unit ${index + 1} (${unit.name}) Warlord`,
      );
    }

    const enhancementEntryIds = new Set(
      Object.values(unitMapping.enhancements).map(
        (reference) => reference.entryId,
      ),
    );
    const enhancementSelections = unitChildren.filter((child) =>
      enhancementEntryIds.has(child.attributes.entryId ?? ""),
    );
    const enhancementReference = unit.enhancementId
      ? unitMapping.enhancements[unit.enhancementId]
      : undefined;
    assertion(
      enhancementSelections.length ===
        (unit.enhancementId ? 1 : 0) &&
        (!unit.enhancementId || enhancementReference),
      "CERTIFICATION_ROSZ_ENHANCEMENT_MISMATCH",
      `The canonical ROS enhancement for unit ${index + 1} (${unit.name}) does not match the roster.`,
    );
    if (enhancementReference) {
      assertSelectionReference(
        enhancementSelections[0],
        enhancementReference,
        1,
        "CERTIFICATION_ROSZ_ENHANCEMENT_MISMATCH",
        `unit ${index + 1} (${unit.name}) enhancement`,
      );
      enhancementSelectionCount += 1;
    }

    const resolution = resolveNewRecruitUnit(unitMapping, unit);
    assertion(
      resolution.ok,
      "CERTIFICATION_ROSZ_EQUIPMENT_MISMATCH",
      `The canonical roster loadout for unit ${index + 1} (${unit.name}) cannot be resolved against the pinned catalogue.`,
    );
    const modelSelections = unitChildren.filter(
      (child) => child.attributes.type === "model",
    );
    assertion(
      modelSelections.length === resolution.models.length,
      "CERTIFICATION_ROSZ_MODEL_COUNT_MISMATCH",
      `The canonical ROS contains ${modelSelections.length} model selections for unit ${index + 1} (${unit.name}); expected ${resolution.models.length}.`,
    );
    let encodedModelCount = 0;
    for (const [modelIndex, model] of resolution.models.entries()) {
      const actualModel = modelSelections[modelIndex];
      assertSelectionReference(
        actualModel,
        model.reference,
        model.count,
        "CERTIFICATION_ROSZ_MODEL_COUNT_MISMATCH",
        `unit ${index + 1} (${unit.name}) model ${modelIndex + 1}`,
      );
      encodedModelCount += selectionNumber(
        actualModel,
        `unit ${index + 1} (${unit.name}) model ${modelIndex + 1}`,
        "CERTIFICATION_ROSZ_MODEL_COUNT_MISMATCH",
      );
      const modelEquipment = childSelections(
        actualModel,
        `unit ${index + 1} (${unit.name}) model ${modelIndex + 1}`,
      );
      assertEquipmentSelections(
        modelEquipment,
        model.equipment,
        `unit ${index + 1} (${unit.name}) model ${modelIndex + 1}`,
      );
      equipmentSelectionCount += modelEquipment.length;
    }
    if (resolution.models.length === 0) {
      encodedModelCount = selectionNumber(
        actualUnit,
        `unit ${index + 1} (${unit.name})`,
        "CERTIFICATION_ROSZ_MODEL_COUNT_MISMATCH",
      );
      assertion(
        unit.modelCount === 1,
        "CERTIFICATION_ROSZ_MODEL_COUNT_UNVERIFIABLE",
        `The canonical exporter has no nested model selection capable of encoding ${unit.modelCount} models for ${unit.name}.`,
      );
    }
    assertion(
      encodedModelCount === unit.modelCount,
      "CERTIFICATION_ROSZ_MODEL_COUNT_MISMATCH",
      `The canonical ROS encodes ${encodedModelCount} models for unit ${index + 1} (${unit.name}); expected ${unit.modelCount}.`,
    );

    const reservedSelections = new Set([
      ...modelSelections,
      ...warlordSelections,
      ...enhancementSelections,
    ]);
    const directEquipment = unitChildren.filter(
      (child) => !reservedSelections.has(child),
    );
    assertEquipmentSelections(
      directEquipment,
      resolution.directEquipment,
      `unit ${index + 1} (${unit.name}) direct`,
    );
    equipmentSelectionCount += directEquipment.length;
  }

  const actualProfiles = collectXmlNodes(root, "profile");
  const expectedProfiles = collectXmlNodes(expectedRoot, "profile");
  assertion(
    actualProfiles.length === expectedProfiles.length,
    "CERTIFICATION_ROSZ_PROFILE_MISMATCH",
    `The canonical ROS contains ${actualProfiles.length} profiles; expected ${expectedProfiles.length} from the canonical exporter.`,
  );
  const actualSelectionIds = collectXmlNodes(root, "selection").map(
    (selection) => selection.attributes.id,
  );
  assertion(
    actualSelectionIds.every(Boolean) &&
      new Set(actualSelectionIds).size === actualSelectionIds.length,
    "CERTIFICATION_ROSZ_SELECTION_ID_MISMATCH",
    "The canonical ROS contains a missing or repeated selection ID.",
  );
  compareCanonicalXmlTree(root, expectedRoot, "roster");
  assertion(
    xml === expectedXml,
    "CERTIFICATION_ROSZ_CANONICAL_XML_MISMATCH",
    "The ROS payload is structurally equivalent but does not match the deterministic canonical serialization.",
  );

  const totalModelCount = roster.units.reduce(
    (sum, unit) => sum + unit.modelCount,
    0,
  );
  assertion(
    actualUnits.length === expectedUnits.length,
    "CERTIFICATION_ROSZ_UNIT_MULTIPLICITY_MISMATCH",
    "The canonical ROS unit count changed after identity validation.",
  );
  return {
    archiveEntries: Object.keys(entries).sort(),
    bytes: content.byteLength,
    contentSha256: sha256(content),
    rosterName: roster.name,
    factionId: roster.factionId,
    factionName: roster.factionName,
    totalPoints: roster.totalPoints,
    catalogueId: mapping.catalogue.id,
    catalogueRevision: mapping.catalogue.revision,
    gameSystemId: gameSystem.id,
    gameSystemRevision: gameSystem.revision,
    unitSelectionCount: actualUnits.length,
    modelCount: totalModelCount,
    warlordSelectionCount: roster.units.filter(
      (unit) => unit.isWarlord,
    ).length,
    equipmentSelectionCount,
    enhancementSelectionCount,
    selectionIdCount: actualSelectionIds.length,
    profileCount: actualProfiles.length,
    profileValidation:
      actualProfiles.length === 0
        ? "not-emitted-by-canonical-exporter"
        : "canonical-profile-tree-matched",
  };
}

function stableCertificationDraft(
  roster: RosterDraftV1,
): RosterDraftV1 {
  const fingerprint = rosterExecutionFingerprint(roster);
  return {
    ...roster,
    id: `cert-${fingerprint.slice(0, 24)}`,
    units: roster.units.map((unit, index) => ({
      ...unit,
      selectionId: `cert-${fingerprint.slice(0, 16)}-${String(index + 1).padStart(3, "0")}`,
    })),
  };
}

function buildAndRequireValid(input: Parameters<typeof buildRoster>[0]): RosterDraftV1 {
  const built = buildRoster(input);
  assertion(
    built.ok && built.data,
    built.violations[0]?.code ?? "CERTIFICATION_BUILD_FAILED",
    built.violations.map((issue) => issue.message).join(" ") ||
      "Roster construction returned no roster.",
  );
  const validation = validateRoster(built.data);
  assertion(
    validation.ok && validation.violations.length === 0,
    validation.violations[0]?.code ?? "CERTIFICATION_VALIDATION_FAILED",
    validation.violations.map((issue) => issue.message).join(" ") ||
      "Roster validation failed.",
  );
  return built.data;
}

export const CERTIFICATION_GOLDEN_DRIFT_CODES = {
  pending: "CERTIFICATION_GOLDEN_CONTRACT_PENDING",
  detachment: "CERTIFICATION_GOLDEN_DETACHMENT_DRIFT",
  warlord: "CERTIFICATION_GOLDEN_WARLORD_DRIFT",
  unitModelMultiset:
    "CERTIFICATION_GOLDEN_UNIT_MODEL_MULTISET_DRIFT",
  structuralFingerprint:
    "CERTIFICATION_GOLDEN_STRUCTURAL_FINGERPRINT_DRIFT",
  executionFingerprint:
    "CERTIFICATION_GOLDEN_EXECUTION_FINGERPRINT_DRIFT",
  canonicalRoszSha256:
    "CERTIFICATION_GOLDEN_ROSZ_SHA256_DRIFT",
} as const;

type RepresentativeRosterContract =
  FactionCertification["representativeRosters"][number];

export function canonicalRepresentativeUnitModelMultiset(
  roster: RosterDraftV1,
): RepresentativeRosterGoldenEvidence["unitModelMultiset"] {
  const counts = new Map<
    string,
    RepresentativeRosterGoldenEvidence["unitModelMultiset"][number]
  >();
  for (const unit of roster.units) {
    const key = `${unit.unitId}\u0000${unit.modelCount}`;
    const current = counts.get(key);
    counts.set(key, {
      unitId: unit.unitId,
      modelCount: unit.modelCount,
      selectionCount: (current?.selectionCount ?? 0) + 1,
    });
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.unitId.localeCompare(right.unitId) ||
      left.modelCount - right.modelCount ||
      left.selectionCount - right.selectionCount,
  );
}

function goldenDrift(
  code: (typeof CERTIFICATION_GOLDEN_DRIFT_CODES)[keyof typeof CERTIFICATION_GOLDEN_DRIFT_CODES],
  message: string,
  evidence: Record<string, unknown>,
): never {
  const error = new Error(message) as Error & {
    code: string;
    evidence: Record<string, unknown>;
  };
  error.code = code;
  error.evidence = evidence;
  throw error;
}

export function assertRepresentativeRosterMatchesGolden(
  roster: RosterDraftV1,
  expected: RepresentativeRosterGoldenEvidence,
): void {
  const warlords = roster.units.filter((unit) => unit.isWarlord);
  const actual = {
    detachmentId: roster.detachmentId,
    warlordUnitId:
      warlords.length === 1 ? warlords[0].unitId : null,
    unitModelMultiset:
      canonicalRepresentativeUnitModelMultiset(roster),
    structuralFingerprint: rosterStructuralFingerprint(roster),
    executionFingerprint: rosterExecutionFingerprint(roster),
  };
  const commonEvidence = {
    expectedGoldenEvidence: expected,
    actualGoldenEvidence: actual,
  };
  if (actual.detachmentId !== expected.detachmentId) {
    goldenDrift(
      CERTIFICATION_GOLDEN_DRIFT_CODES.detachment,
      `Representative detachment changed from ${expected.detachmentId} to ${actual.detachmentId}.`,
      commonEvidence,
    );
  }
  if (actual.warlordUnitId !== expected.warlordUnitId) {
    goldenDrift(
      CERTIFICATION_GOLDEN_DRIFT_CODES.warlord,
      `Representative Warlord changed from ${expected.warlordUnitId} to ${actual.warlordUnitId ?? "none"}.`,
      commonEvidence,
    );
  }
  if (
    canonicalJson(actual.unitModelMultiset) !==
    canonicalJson(expected.unitModelMultiset)
  ) {
    goldenDrift(
      CERTIFICATION_GOLDEN_DRIFT_CODES.unitModelMultiset,
      "Representative unit/model multiset changed under the pinned data.",
      commonEvidence,
    );
  }
  if (
    actual.structuralFingerprint !==
    expected.structuralFingerprint
  ) {
    goldenDrift(
      CERTIFICATION_GOLDEN_DRIFT_CODES.structuralFingerprint,
      "Representative structural fingerprint changed under the pinned data.",
      commonEvidence,
    );
  }
  if (
    actual.executionFingerprint !==
    expected.executionFingerprint
  ) {
    goldenDrift(
      CERTIFICATION_GOLDEN_DRIFT_CODES.executionFingerprint,
      "Representative execution fingerprint changed under the pinned data.",
      commonEvidence,
    );
  }
}

export function assertCanonicalRoszMatchesGolden(
  actualSha256: string,
  expected: RepresentativeRosterGoldenEvidence,
): void {
  if (
    expected.canonicalRoszSha256 !== undefined &&
    actualSha256 !== expected.canonicalRoszSha256
  ) {
    goldenDrift(
      CERTIFICATION_GOLDEN_DRIFT_CODES.canonicalRoszSha256,
      `Canonical ROSZ hash changed from ${expected.canonicalRoszSha256} to ${actualSha256}.`,
      {
        expectedCanonicalRoszSha256:
          expected.canonicalRoszSha256,
        actualCanonicalRoszSha256: actualSha256,
      },
    );
  }
}

export function buildCertificationRepresentative(input: {
  manifest: Pick<CertificationManifest, "defaults">;
  faction: FactionCertification;
  contract: RepresentativeRosterContract;
}): {
  roster: RosterDraftV1;
  preferences: CertificationManifest["defaults"]["preferences"];
} {
  const { manifest, faction, contract } = input;
  const defaults = manifest.defaults;
  const name = `Certification ${faction.name} ${contract.pointsLimit}`;
  const preferenceCandidates = [
    defaults.preferences,
    ...defaults.preferences.map((preference) => [preference]),
    ["mobility"] as const,
    ["elite"] as const,
    ["horde"] as const,
  ];
  const buildCandidate = (
    preferences: CertificationManifest["defaults"]["preferences"],
  ): RosterDraftV1 =>
    buildAndRequireValid({
      playerFaction: faction.id,
      pointsLimit: contract.pointsLimit,
      name,
      preferences,
      allowNamedCharacters: defaults.allowNamedCharacters,
      allowLegends: defaults.allowLegends,
    });

  let selectedPreferences = defaults.preferences;
  let roster = buildCandidate(selectedPreferences);
  if (
    roster.totalPoints / roster.pointsLimit <
    contract.minimumPointsUtilization
  ) {
    for (const preferences of preferenceCandidates.slice(1)) {
      let candidate: RosterDraftV1;
      try {
        candidate = buildCandidate([...preferences]);
      } catch {
        continue;
      }
      if (candidate.totalPoints > roster.totalPoints) {
        roster = candidate;
        selectedPreferences = [...preferences];
      }
    }
  }
  return { roster, preferences: selectedPreferences };
}

export async function generateRepresentativeGoldenEvidence(input: {
  manifest: Pick<CertificationManifest, "defaults">;
  faction: FactionCertification;
  contract: RepresentativeRosterContract;
  representative?: ReturnType<
    typeof buildCertificationRepresentative
  >;
}): Promise<RepresentativeRosterGoldenEvidence> {
  const representative =
    input.representative ??
    buildCertificationRepresentative(input);
  const { roster } = representative;
  const warlords = roster.units.filter((unit) => unit.isWarlord);
  assertion(
    warlords.length === 1,
    "CERTIFICATION_WARLORD_INVALID",
    `${input.faction.name} produced ${warlords.length} Warlords while generating golden evidence.`,
  );
  const golden: RepresentativeRosterGoldenEvidence = {
    schemaVersion: 1,
    detachmentId: roster.detachmentId,
    warlordUnitId: warlords[0].unitId,
    unitModelMultiset:
      canonicalRepresentativeUnitModelMultiset(roster),
    structuralFingerprint: rosterStructuralFingerprint(roster),
    executionFingerprint: rosterExecutionFingerprint(roster),
  };
  if (
    input.faction.newRecruitExport === "required" &&
    input.contract.capabilities.includes("new-recruit-export")
  ) {
    const exportRepresentative =
      buildExportableRosterCandidate({
        playerFaction: input.faction.id,
        pointsLimit: input.contract.pointsLimit,
        name: `Certification ${input.faction.name} ${input.contract.pointsLimit} export representative`,
        preferences: representative.preferences,
        allowNamedCharacters:
          input.manifest.defaults.allowNamedCharacters,
        allowLegends: input.manifest.defaults.allowLegends,
      });
    assertion(
      exportRepresentative,
      "CERTIFICATION_EXPORT_REPRESENTATIVE_UNAVAILABLE",
      `${input.faction.name} has no deterministic ${input.contract.pointsLimit}-point export representative under its declared capability.`,
    );
    const stable = stableCertificationDraft(exportRepresentative);
    const exported = await exportRoster(stable, "rosz");
    assertion(
      exported.ok &&
        exported.data &&
        exported.data.content instanceof Uint8Array,
      exported.violations[0]?.code ??
        "CERTIFICATION_ROSZ_EXPORT_FAILED",
      exported.violations.map((issue) => issue.message).join(" ") ||
        `${input.faction.name} did not produce a binary ROSZ artifact while generating golden evidence.`,
    );
    golden.canonicalRoszSha256 = sha256(exported.data.content);
  }
  return golden;
}

function factionUnitMetadata(factionId: string) {
  const result = searchUnits({
    faction: factionId,
    includeLegends: false,
    limit: 100,
  });
  assertion(
    result.ok && result.data,
    "CERTIFICATION_UNIT_METADATA_UNAVAILABLE",
    `Unit metadata could not be loaded for ${factionId}.`,
  );
  return result.data;
}

async function certifyFaction(
  manifest: CertificationManifest,
  faction: FactionCertification,
  options: DeterministicCertificationOptions,
): Promise<CertificationCaseResult[]> {
  const cases: CertificationCaseResult[] = [];
  const defaults = manifest.defaults;
  const baseByPoints = new Map<number, RosterDraftV1>();
  const preferencesByPoints = new Map<number, typeof defaults.preferences>();
  const push = (result: CertificationCaseResult) => {
    cases.push(result);
    options.progress?.(
      `${result.status.toLocaleUpperCase()} ${result.caseId}: ${result.message}`,
    );
  };
  for (const reviewCase of certificationExpertReviewCases(
    faction,
  )) {
    push(reviewCase);
  }

  const conflictCaseId = `${faction.id}:mapping-baseline`;
  {
    const startedAt = timestamp();
    const startedMs = Date.now();
    try {
      const actual = listDataConflicts({
        factionId: faction.id,
        blocking: true,
        limit: 1,
      }).total;
      assertion(
        actual <= faction.expectedBlockingConflicts,
        "CERTIFICATION_MAPPING_CONFLICT_REGRESSION",
        `${faction.name} blocking conflicts increased from ${faction.expectedBlockingConflicts} to ${actual}.`,
      );
      const capability = getNewRecruitCapability(faction.id);
      const actualDetachmentIds = listDetachments(faction.id)
        .map((detachment) => detachment.id)
        .sort();
      assertion(
        JSON.stringify([...faction.detachmentIds].sort()) ===
          JSON.stringify(actualDetachmentIds),
        "CERTIFICATION_DETACHMENT_COVERAGE_DRIFT",
        `${faction.name} manifest detachments do not match the pinned legal detachments.`,
      );
      assertion(
        faction.representativeRosters.length >= 2 &&
          faction.representativeRosters.some(
            (roster) => roster.pointsLimit === 1_000,
          ) &&
          faction.representativeRosters.some(
            (roster) => roster.pointsLimit === 2_000,
          ),
        "CERTIFICATION_REPRESENTATIVE_ROSTERS_MISSING",
        `${faction.name} needs explicit 1,000- and 2,000-point representative roster contracts.`,
      );
      const expectedAvailable = faction.newRecruitExport === "required";
      assertion(
        capability.available === expectedAvailable,
        "CERTIFICATION_CAPABILITY_DRIFT",
        `${faction.name} New Recruit capability is ${capability.available ? "available" : "unavailable"}, but the manifest expects ${faction.newRecruitExport}.`,
      );
      push(
        caseResult({
          caseId: conflictCaseId,
          factionId: faction.id,
          workflow: "oracle",
          stage: "capability-baseline",
          status: expectedAvailable ? "pass" : "unsupported",
          code: expectedAvailable
            ? null
            : "NEW_RECRUIT_MAPPING_UNAVAILABLE",
          message: expectedAvailable
            ? "Mapping conflicts did not regress and the declared capability remains available."
            : "The declared New Recruit capability boundary remains fail-closed.",
          retryable: false,
          evidence: {
            expectedBlockingConflicts: faction.expectedBlockingConflicts,
            actualBlockingConflicts: actual,
            capability,
            detachmentIds: actualDetachmentIds,
            representativeRosterIds:
              faction.representativeRosters.map(
                (roster) => roster.id,
              ),
          },
          artifacts: [],
          connectorEvents: [],
          startedAt,
          startedMs,
        }),
      );
    } catch (error) {
      push(
        failCase(
          conflictCaseId,
          faction.id,
          "oracle",
          "capability-baseline",
          error,
          startedAt,
          startedMs,
        ),
      );
    }
  }

  for (const representativeContract of faction.representativeRosters.filter(
    (roster) =>
      roster.capabilities.includes("roster-correctness"),
  )) {
    const pointsLimit = representativeContract.pointsLimit;
    const caseId = `${faction.id}:build:${pointsLimit}`;
    const startedAt = timestamp();
    const startedMs = Date.now();
    try {
      const builtRepresentative =
        buildCertificationRepresentative({
          manifest,
          faction,
          contract: representativeContract,
        });
      const roster = builtRepresentative.roster;
      const selectedPreferences =
        builtRepresentative.preferences;
      if (representativeContract.goldenEvidence) {
        assertRepresentativeRosterMatchesGolden(
          roster,
          representativeContract.goldenEvidence,
        );
      }
      baseByPoints.set(pointsLimit, roster);
      preferencesByPoints.set(pointsLimit, selectedPreferences);
      const utilization = roster.totalPoints / roster.pointsLimit;
      assertion(
        utilization >=
          representativeContract.minimumPointsUtilization,
        "CERTIFICATION_POINTS_UNDERFILLED",
        `${faction.name} built ${roster.totalPoints}/${pointsLimit} points (${(
          utilization * 100
        ).toFixed(1)}%), below the ${(representativeContract.minimumPointsUtilization * 100).toFixed(1)}% contract.`,
      );
      const warlords = roster.units.filter((unit) => unit.isWarlord);
      assertion(
        warlords.length === 1,
        "CERTIFICATION_WARLORD_INVALID",
        `${faction.name} produced ${warlords.length} Warlords.`,
      );
      push(
        caseResult({
          caseId,
          factionId: faction.id,
          workflow: "roster-correctness",
          stage: "build-and-validate",
          status: representativeContract.goldenEvidence
            ? "pass"
            : "degraded",
          code: representativeContract.goldenEvidence
            ? null
            : CERTIFICATION_GOLDEN_DRIFT_CODES.pending,
          message: representativeContract.goldenEvidence
            ? `Built and validated the pinned golden ${roster.totalPoints}/${pointsLimit}-point roster with one Warlord.`
            : `Built and validated ${roster.totalPoints}/${pointsLimit} points, but this legacy representative has no pinned golden evidence.`,
          retryable: false,
          evidence: {
            pointsLimit,
            representativeRosterId: representativeContract.id,
            goldenContractStatus:
              representativeContract.goldenEvidence
                ? "verified"
                : "pending",
            totalPoints: roster.totalPoints,
            utilization,
            unitCount: roster.units.length,
            detachmentId: roster.detachmentId,
            unitRoles: [
              ...new Set(roster.units.map((unit) => unit.role)),
            ].sort(),
            warlordUnitId: warlords[0].unitId,
            preferences: selectedPreferences,
            structuralFingerprint: rosterStructuralFingerprint(roster),
            executionFingerprint: rosterExecutionFingerprint(roster),
          },
          artifacts: [],
          connectorEvents: [],
          startedAt,
          startedMs,
        }),
      );
    } catch (error) {
      push(
        failCase(
          caseId,
          faction.id,
          "roster-correctness",
          "build-and-validate",
          error,
          startedAt,
          startedMs,
        ),
      );
    }
  }

  const representative =
    baseByPoints.get(
      faction.representativeRosters.find((roster) =>
        roster.capabilities.includes("new-recruit-export"),
      )?.pointsLimit ?? defaults.pointBands[0],
    ) ??
    [...baseByPoints.values()][0];
  if (!representative) return cases;

  {
    const caseId = `${faction.id}:determinism`;
    const startedAt = timestamp();
    const startedMs = Date.now();
    try {
      const representativePreferences =
        preferencesByPoints.get(representative.pointsLimit) ??
        defaults.preferences;
      const repeated = buildAndRequireValid({
        playerFaction: faction.id,
        pointsLimit: representative.pointsLimit,
        name: representative.name,
        preferences: representativePreferences,
        allowNamedCharacters: defaults.allowNamedCharacters,
        allowLegends: defaults.allowLegends,
      });
      const prompted = buildAndRequireValid({
        prompt: `Please build a ${representative.pointsLimit} point ${faction.name} roster.`,
        playerFaction: faction.id,
        pointsLimit: representative.pointsLimit,
        name: representative.name,
        preferences: representativePreferences,
        allowNamedCharacters: defaults.allowNamedCharacters,
        allowLegends: defaults.allowLegends,
      });
      const serialized = RosterDraftV2Schema.parse(
        JSON.parse(JSON.stringify(representative)),
      );
      const fingerprints = [
        representative,
        repeated,
        prompted,
        serialized,
      ].map(rosterExecutionFingerprint);
      assertion(
        new Set(fingerprints).size === 1,
        "CERTIFICATION_NONDETERMINISTIC_ROSTER",
        `${faction.name} changed across repeat, prompt, or serialization variants.`,
      );
      push(
        caseResult({
          caseId,
          factionId: faction.id,
          workflow: "roster-correctness",
          stage: "metamorphic-round-trip",
          status: "pass",
          code: null,
          message:
            "Repeat, prompt, and serialization variants retained one execution fingerprint.",
          retryable: false,
          evidence: { executionFingerprint: fingerprints[0] },
          artifacts: [],
          connectorEvents: [],
          startedAt,
          startedMs,
        }),
      );
    } catch (error) {
      push(
        failCase(
          caseId,
          faction.id,
          "roster-correctness",
          "metamorphic-round-trip",
          error,
          startedAt,
          startedMs,
        ),
      );
    }
  }

  {
    const caseId = `${faction.id}:hard-constraints`;
    const startedAt = timestamp();
    const startedMs = Date.now();
    try {
      const noNamed = buildAndRequireValid({
        playerFaction: faction.id,
        pointsLimit: representative.pointsLimit,
        name: `Certification ${faction.name} hard constraints`,
        preferences: defaults.preferences,
        allowNamedCharacters: false,
        allowLegends: false,
      });
      const metadata = factionUnitMetadata(faction.id);
      const namedIds = new Set(
        metadata
          .filter((unit) => unit.isNamedCharacter)
          .map((unit) => unit.id),
      );
      assertion(
        noNamed.units.every((unit) => !namedIds.has(unit.unitId)),
        "CERTIFICATION_NAMED_CHARACTER_CONSTRAINT_LOST",
        `${faction.name} selected a named character despite allowNamedCharacters=false.`,
      );
      const collectionUnitIds = [...new Set(noNamed.units.map((unit) => unit.unitId))];
      const requiredUnitId = noNamed.units[0].unitId;
      const requiredWarlordUnitId = noNamed.units.find(
        (unit) => unit.isWarlord,
      )?.unitId;
      assertion(
        requiredWarlordUnitId,
        "CERTIFICATION_WARLORD_INVALID",
        `${faction.name} has no Warlord for the hard-constraint case.`,
      );
      const excludedUnitId = metadata.find(
        (unit) => !collectionUnitIds.includes(unit.id),
      )?.id;
      const constrained = buildAndRequireValid({
        playerFaction: faction.id,
        pointsLimit: representative.pointsLimit,
        name: `Certification ${faction.name} constrained`,
        preferences: defaults.preferences,
        allowNamedCharacters: false,
        allowLegends: false,
        collectionUnitIds,
        requiredUnitIds: [requiredUnitId],
        excludedUnitIds: excludedUnitId ? [excludedUnitId] : [],
        requiredWarlordUnitId,
      });
      assertion(
        constrained.constraints.allowNamedCharacters === false &&
          constrained.constraints.allowLegends === false &&
          constrained.constraints.collectionUnitIds?.every((id) =>
            collectionUnitIds.includes(id),
          ) &&
          constrained.constraints.requiredUnitIds?.includes(requiredUnitId) &&
          constrained.constraints.requiredWarlordUnitId ===
            requiredWarlordUnitId &&
          (!excludedUnitId ||
            constrained.constraints.excludedUnitIds?.includes(excludedUnitId)),
        "CERTIFICATION_HARD_CONSTRAINT_METADATA_LOST",
        `${faction.name} did not retain every structured hard constraint.`,
      );
      assertion(
        constrained.units.some((unit) => unit.unitId === requiredUnitId) &&
          constrained.units.every((unit) =>
            collectionUnitIds.includes(unit.unitId),
          ) &&
          (!excludedUnitId ||
            constrained.units.every((unit) => unit.unitId !== excludedUnitId)) &&
          constrained.units.some(
            (unit) =>
              unit.unitId === requiredWarlordUnitId && unit.isWarlord,
          ),
        "CERTIFICATION_HARD_CONSTRAINT_SELECTION_LOST",
        `${faction.name} selections violate a required, excluded, collection, or Warlord constraint.`,
      );
      push(
        caseResult({
          caseId,
          factionId: faction.id,
          workflow: "roster-correctness",
          stage: "hard-constraint-preservation",
          status: "pass",
          code: null,
          message:
            "Named-character, collection, inclusion, exclusion, and Warlord constraints were retained.",
          retryable: false,
          evidence: {
            requiredUnitId,
            excludedUnitId: excludedUnitId ?? null,
            requiredWarlordUnitId,
            collectionUnitIds,
          },
          artifacts: [],
          connectorEvents: [],
          startedAt,
          startedMs,
        }),
      );
    } catch (error) {
      push(
        failCase(
          caseId,
          faction.id,
          "roster-correctness",
          "hard-constraint-preservation",
          error,
          startedAt,
          startedMs,
        ),
      );
    }
  }

  for (const exportContract of faction.representativeRosters.filter(
    (roster) =>
      roster.capabilities.includes("new-recruit-export"),
  )) {
    const caseId =
      `${faction.id}:canonical-rosz:${exportContract.id}`;
    const startedAt = timestamp();
    const startedMs = Date.now();
    try {
      const exportRepresentative =
        faction.newRecruitExport === "required"
          ? buildExportableRosterCandidate({
              playerFaction: faction.id,
              pointsLimit: exportContract.pointsLimit,
              name: `Certification ${faction.name} ${exportContract.pointsLimit} export representative`,
              preferences:
                preferencesByPoints.get(exportContract.pointsLimit) ??
                defaults.preferences,
              allowNamedCharacters: defaults.allowNamedCharacters,
              allowLegends: defaults.allowLegends,
            })
          : baseByPoints.get(exportContract.pointsLimit);
      assertion(
        exportRepresentative,
        "CERTIFICATION_EXPORT_REPRESENTATIVE_UNAVAILABLE",
        `${faction.name} has no deterministic ${exportContract.pointsLimit}-point export representative under its declared capability.`,
      );
      const stableExportRepresentative =
        stableCertificationDraft(exportRepresentative);
      const exported = await exportRoster(
        stableExportRepresentative,
        "rosz",
      );
      if (faction.newRecruitExport === "unsupported") {
        assertion(
          !exported.ok &&
            exported.data === null &&
            exported.violations.some(
              (issue) =>
                issue.code === "NEW_RECRUIT_MAPPING_UNAVAILABLE" ||
                issue.code === "NEW_RECRUIT_DATA_CONFLICT",
            ),
          "CERTIFICATION_UNSUPPORTED_EXPORT_DID_NOT_FAIL_CLOSED",
          `${faction.name} is declared unsupported but ROSZ export did not fail with a mapping boundary.`,
        );
        push(
          caseResult({
            caseId,
            factionId: faction.id,
            workflow: "new-recruit-export",
            stage: "canonical-export",
            status: "unsupported",
            code: exported.violations[0]?.code ?? "NEW_RECRUIT_MAPPING_UNAVAILABLE",
            message:
              "ROSZ export failed before external mutation at the declared mapping boundary.",
            retryable: false,
            evidence: {
              representativeRosterId: exportContract.id,
              pointsLimit: exportContract.pointsLimit,
              violations: exported.violations,
            },
            artifacts: [],
            connectorEvents: [],
            startedAt,
            startedMs,
          }),
        );
      } else {
        assertion(
          exported.ok &&
            exported.data &&
            exported.data.content instanceof Uint8Array,
          exported.violations[0]?.code ?? "CERTIFICATION_ROSZ_EXPORT_FAILED",
          exported.violations.map((issue) => issue.message).join(" ") ||
            `${faction.name} did not produce a binary ROSZ artifact.`,
        );
        const archive = validateCanonicalRoszArchive(
          stableExportRepresentative,
          exported.data.content,
        );
        const expectedGolden = exportContract.goldenEvidence;
        if (expectedGolden?.canonicalRoszSha256) {
          assertCanonicalRoszMatchesGolden(
            String(archive.contentSha256),
            expectedGolden,
          );
        }
        const goldenExportVerified =
          expectedGolden?.canonicalRoszSha256 !== undefined;
        const written = options.artifactWriter
          ? await options.artifactWriter(
              exported.data.filename,
              exported.data.content,
            )
          : null;
        push(
          caseResult({
            caseId,
            factionId: faction.id,
            workflow: "new-recruit-export",
            stage: "canonical-export",
            status: goldenExportVerified
              ? "pass"
              : "degraded",
            code: goldenExportVerified
              ? null
              : CERTIFICATION_GOLDEN_DRIFT_CODES.pending,
            message: goldenExportVerified
              ? "The pinned golden representative exported as an exact, structurally verified ROSZ archive."
              : "The representative exported as a structurally verified ROSZ archive, but its legacy contract has no pinned canonical ROSZ hash.",
            retryable: false,
            evidence: {
              ...archive,
              representativeRosterId: exportContract.id,
              goldenContractStatus: goldenExportVerified
                ? "verified"
                : "pending",
              pointsLimit: stableExportRepresentative.pointsLimit,
              totalPoints: stableExportRepresentative.totalPoints,
              executionFingerprint:
                rosterExecutionFingerprint(
                  stableExportRepresentative,
                ),
              unitIds: stableExportRepresentative.units.map(
                (unit) => unit.unitId,
              ),
            },
            artifacts: written
              ? [
                  {
                    kind: "canonical-rosz",
                    path: written,
                    sha256: String(archive.contentSha256),
                  },
                ]
              : [],
            connectorEvents: [],
            startedAt,
            startedMs,
          }),
        );
      }
    } catch (error) {
      push(
        failCase(
          caseId,
          faction.id,
          "new-recruit-export",
          "canonical-export",
          error,
          startedAt,
          startedMs,
        ),
      );
    }
  }
  return cases;
}

function emptyWorkflowCoverage() {
  const statuses = (): Record<CertificationResultStatus, number> => ({
    pass: 0,
    fail: 0,
    unsupported: 0,
    degraded: 0,
    skipped: 0,
  });
  return {
    oracle: statuses(),
    "roster-correctness": statuses(),
    "new-recruit-export": statuses(),
    "new-recruit-delivery": statuses(),
    "tessera-preparation": statuses(),
    "tessera-simulation": statuses(),
    "browser-fixture": statuses(),
  };
}

export async function runDeterministicCertification(
  inputManifest: unknown,
  options: DeterministicCertificationOptions = {},
): Promise<CertificationReport> {
  const manifest = CertificationManifestSchema.parse(inputManifest);
  const data = getDataStatus();
  assertion(
    data.ok && data.data,
    "CERTIFICATION_DATA_STATUS_FAILED",
    "Roster data status could not be read.",
  );
  const actualFactionIds = new Set(factions.all.map((faction) => faction.id));
  const manifestFactionIds = new Set(
    manifest.factions.map((faction) => faction.id),
  );
  assertion(
    actualFactionIds.size === manifestFactionIds.size &&
      [...actualFactionIds].every((id) => manifestFactionIds.has(id)),
    "CERTIFICATION_FACTION_COVERAGE_DRIFT",
    "The certification manifest does not contain exactly the factions in the pinned rules package.",
  );
  assertion(
    manifest.dataPin.releaseId === data.data.sources.releaseId &&
      manifest.dataPin.rulesPackageVersion === data.data.packageVersion &&
      manifest.dataPin.newRecruitCommit ===
        data.data.sources.newRecruit.commit &&
      (manifest.dataPin.newRecruitRepository === undefined ||
        manifest.dataPin.newRecruitRepository ===
          data.data.sources.newRecruit.repository) &&
      (manifest.dataPin.newRecruitGameSystemRevision === undefined ||
        manifest.dataPin.newRecruitGameSystemRevision ===
          data.data.sources.newRecruit.gameSystemRevision) &&
      (manifest.dataPin.officialMfmVersion === undefined ||
        manifest.dataPin.officialMfmVersion ===
          data.data.sources.official.mfmVersion) &&
      (manifest.dataPin.officialMfmContentSha256 === undefined ||
        manifest.dataPin.officialMfmContentSha256 ===
          data.data.sources.official.contentSha256),
    "CERTIFICATION_DATA_PIN_DRIFT",
    "The certification manifest data pin does not match the runtime data pin.",
  );
  assertion(
    data.data.buildableFactionCount === manifest.baselines.buildableFactions &&
      data.data.newRecruitCoverage.exportCapableFactions ===
        manifest.baselines.exportCapableFactions,
    "CERTIFICATION_CAPABILITY_BASELINE_DRIFT",
    "Buildable or export-capable faction totals changed; regenerate and review the certification manifest.",
  );
  assertion(
    data.data.conflicts.blocking <= manifest.baselines.blockingConflicts,
    "CERTIFICATION_MAPPING_CONFLICT_REGRESSION",
    `Blocking mapping conflicts increased from ${manifest.baselines.blockingConflicts} to ${data.data.conflicts.blocking}.`,
  );
  if (manifest.baselines.uniqueBlockingConflicts !== undefined) {
    assertion(
      (
        newRecruitCatalogue.summary.uniqueBlockingConflicts ??
        Number.POSITIVE_INFINITY
      ) <= manifest.baselines.uniqueBlockingConflicts,
      "CERTIFICATION_UNIQUE_MAPPING_CONFLICT_REGRESSION",
      `Unique blocking mapping conflicts increased from ${manifest.baselines.uniqueBlockingConflicts} to ${newRecruitCatalogue.summary.uniqueBlockingConflicts ?? "unknown"}.`,
    );
  }

  const selected = selectedFactions(manifest, options);
  const cases: CertificationCaseResult[] = [];
  for (const faction of selected) {
    if (options.resumedCaseIds?.has(`${faction.id}:completed`)) {
      const now = timestamp();
      cases.push({
        caseId: `${faction.id}:resume`,
        factionId: faction.id,
        workflow: "oracle",
        stage: "resume",
        status: "skipped",
        code: "CERTIFICATION_RESUME_REUSED",
        message: "A prior completed faction result was retained.",
        retryable: false,
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        evidence: {},
        artifacts: [],
        connectorEvents: [],
      });
      continue;
    }
    cases.push(...(await certifyFaction(manifest, faction, options)));
  }
  const workflows = emptyWorkflowCoverage();
  for (const result of cases) workflows[result.workflow][result.status] += 1;
  const factionSummaries = selected.map((faction) => {
    const factionCases = cases.filter(
      (result) => result.factionId === faction.id,
    );
    const factionCoverage =
      deriveCertificationCoverageDimensions({
        manifest,
        selectedFactionIds: [faction.id],
        cases: factionCases,
      });
    return {
      faction,
      failed: factionCases.some((result) => result.status === "fail"),
      passed: factionCases.some((result) => result.status === "pass"),
      unsupported: factionCases.some(
        (result) => result.status === "unsupported",
      ),
      incomplete: factionCases.some((result) =>
        ["unsupported", "degraded"].includes(result.status),
      ) ||
        factionCoverage.specialistCases.missing.length > 0 ||
        factionCoverage.detachments.missing.length > 0,
    };
  });
  const failed = cases.some((result) => result.status === "fail");
  const pendingExpertReview = selected.filter(
    (faction) => faction.expertReview.status !== "reviewed",
  ).length;
  const coverageDimensions =
    deriveCertificationCoverageDimensions({
      manifest,
      selectedFactionIds: selected.map((faction) => faction.id),
      cases,
    });
  const passedFactionCount = factionSummaries.filter(
    (summary) =>
      summary.passed &&
      !summary.failed &&
      !summary.incomplete,
  ).length;
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    reportKind: "rosterpilot-certification",
    runId: crypto.randomUUID(),
    tier: "deterministic",
    generatedAt: timestamp(),
    ok: !failed,
    status: failed
      ? "fail"
      : pendingExpertReview > 0 ||
          coverageDimensions.specialistCases.missing.length > 0 ||
          coverageDimensions.detachments.missing.length > 0 ||
          passedFactionCount < selected.length ||
          cases.some((result) =>
            ["unsupported", "degraded"].includes(result.status),
          )
        ? "degraded"
        : "pass",
    manifestSha256: certificationManifestSha256(manifest),
    resumedFrom: null,
    selection: {
      requestedFaction: options.factionId ?? null,
      shard: options.shard ?? null,
      changedOnly: options.changedOnly ?? false,
      selectedFactionIds: selected.map((faction) => faction.id),
    },
    provenance: {
      runtime: null,
      localAgent: {
        version: null,
        protocolVersion: null,
        runtime: null,
        buildId: null,
        stale: null,
      },
      newRecruitUi: { identity: null },
      tesseraUi: { identity: null },
      profilePolicy: {
        source: "none",
        requestedBasename: null,
        artifactPath: null,
        sourceSha256: null,
        canonicalSha256: null,
      },
      dataPin: manifest.dataPin,
      cachedLiveUpdateCheck: getCachedDataFreshness(),
    },
    baselines: {
      ...manifest.baselines,
      actualBuildableFactions: data.data.buildableFactionCount,
      actualExportCapableFactions:
        data.data.newRecruitCoverage.exportCapableFactions,
      actualBlockingConflicts: data.data.conflicts.blocking,
      actualUniqueBlockingConflicts:
        newRecruitCatalogue.summary.uniqueBlockingConflicts ?? null,
    },
    coverage: {
      factions: {
        intended: selected.length,
        exercised: factionSummaries.filter(
          ({ faction }) =>
            cases.some((result) => result.factionId === faction.id),
        ).length,
        passed: passedFactionCount,
        failed: factionSummaries.filter((summary) => summary.failed).length,
        unsupported: factionSummaries.filter(
          (summary) => summary.unsupported,
        ).length,
        pendingExpertReview,
      },
      workflows,
      browserFixtures: {
        intended: manifest.browserFixtures.length,
        exercised: 0,
      },
      dimensions: coverageDimensions,
    },
    cases,
    connectorEvents: cases.flatMap((result) => result.connectorEvents),
    artifacts: [],
    limitations: [
      "Deterministic certification validates roster and canonical ROSZ behavior without creating remote lists.",
      "Pending expert reviews remain visible and cap a fully selected report at degraded.",
      "Faction proxies are coverage cases, not claims about tournament-list frequency.",
      ...(coverageDimensions.specialistCases.missing.length > 0
        ? [
            `Missing specialist certification evidence: ${coverageDimensions.specialistCases.missing.join(", ")}.`,
          ]
        : []),
      ...(coverageDimensions.detachments.missing.length > 0
        ? [
            `Missing detachment certification evidence: ${coverageDimensions.detachments.missing.join(", ")}.`,
          ]
        : []),
    ],
  };
}
