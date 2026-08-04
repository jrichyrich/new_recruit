import crypto from "node:crypto";
import path from "node:path";

import { z } from "zod";

import type { TesseraMatchupReport } from "../../lib/rosterpilot";
import {
  tesseraScenarioPolicyContractV2Sha256,
} from "./scenario-contract-v2";
import {
  tesseraScenarioPolicyContractV3Sha256,
} from "./scenario-contract-v3";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const receiptKind = "tessera-exact-matchup-report-receipt" as const;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const nullableIdentitySchema = z.string().min(1).max(4_096).nullable();

const receiptCommonShape = {
  kind: z.literal(receiptKind),
  reportFilename: z.string().min(1).max(1_024),
  reportSha256: sha256Schema,
  evidenceSha256: sha256Schema,
  runId: z.string().min(1).max(4_096),
};

export const ExactMatchupReportReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...receiptCommonShape,
}).strict();

const scenarioPolicyBindingSchema = z.object({
  schemaVersion: z.union([z.literal(2), z.literal(3)]),
  contractSha256: sha256Schema,
  evidenceSha256: sha256Schema,
}).strict();

const combatBridgeEvidenceBindingSchema = z.object({
  count: z.number().int().nonnegative(),
  evidenceSha256s: z.array(sha256Schema),
  collectionSha256: sha256Schema,
}).strict();

const sourceArtifactBindingSchema = z.object({
  side: z.enum(["player", "opponent"]),
  occurrence: z.number().int().positive(),
  rosterId: nullableIdentitySchema,
  rosterName: z.string().min(1).max(4_096),
  factionId: nullableIdentitySchema,
  fingerprint: nullableIdentitySchema,
  sourceArtifactKind: z.enum([
    "bundle-native",
    "new-recruit-enriched",
    "legacy-report",
  ]),
  sourceArtifactSha256: sha256Schema.nullable(),
  derivedArtifactSha256: sha256Schema.nullable(),
  simulationInputKind: z.enum([
    "new-recruit-enriched-rosz",
    "rosterpilot-local-engine-input",
  ]).nullable(),
  simulationInputSha256: sha256Schema.nullable(),
  bundleId: nullableIdentitySchema,
  compilerVersion: nullableIdentitySchema,
  catalogueIdentitySha256: sha256Schema.nullable(),
}).strict();

const sourceArtifactCollectionBindingSchema = z.object({
  rosters: z.array(sourceArtifactBindingSchema),
  collectionSha256: sha256Schema,
}).strict();

const providerIdentityBindingSchema = z.object({
  provider: z.enum(["local-engine", "website"]).nullable(),
  identitySha256: sha256Schema.nullable(),
}).strict();

const bundleCompatibilityBindingSchema = z.object({
  bundleId: nullableIdentitySchema,
  pinnedDataSha256: sha256Schema.nullable(),
  providerCompatibilityEvidenceSha256: sha256Schema,
  providerCompatibilityEnvelopeSha256s: z.array(sha256Schema),
}).strict();

const exactReportBindingsV2Schema = z.object({
  scenarioPolicies: z.array(scenarioPolicyBindingSchema),
  scenarioPoliciesSha256: sha256Schema,
  combatBridgeEvidence: combatBridgeEvidenceBindingSchema,
  sourceArtifacts: sourceArtifactCollectionBindingSchema,
  providerIdentity: providerIdentityBindingSchema,
  bundleCompatibility: bundleCompatibilityBindingSchema,
}).strict();

export const ExactMatchupReportReceiptV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...receiptCommonShape,
  bindings: exactReportBindingsV2Schema,
  bindingsSha256: sha256Schema,
}).strict();

export const ExactMatchupReportReceiptSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    ExactMatchupReportReceiptV1Schema,
    ExactMatchupReportReceiptV2Schema,
  ],
);

export type ExactMatchupReportReceiptV1 = z.infer<
  typeof ExactMatchupReportReceiptV1Schema
>;
export type ExactMatchupReportReceiptV2 = z.infer<
  typeof ExactMatchupReportReceiptV2Schema
>;
export type ExactMatchupReportReceipt = z.infer<
  typeof ExactMatchupReportReceiptSchema
>;
export type ExactMatchupReportBindingsV2 = z.infer<
  typeof exactReportBindingsV2Schema
>;

type ReportWithScenarioPolicyV3 = TesseraMatchupReport & {
  scenarioPolicyContractV3?: unknown;
  scenarioPolicyContractV3Sha256?: string | null;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(value: unknown): string {
  return digest(canonicalJson(value));
}

function asRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} is missing or malformed.`);
  }
  return value as Record<string, unknown>;
}

function optionalIdentity(
  value: unknown,
  description: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096
  ) {
    throw new TypeError(`${description} is malformed.`);
  }
  return value;
}

function optionalSha256(
  value: unknown,
  description: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${description} is not a SHA-256 identity.`);
  }
  return value;
}

function sameOptionalIdentity(
  values: readonly (string | null)[],
  description: string,
): string | null {
  const present = values.filter(
    (value): value is string => value !== null,
  );
  if (new Set(present).size > 1) {
    throw new TypeError(`${description} identities disagree.`);
  }
  return present[0] ?? null;
}

function exactReportLegacyEvidence(report: TesseraMatchupReport) {
  return {
    schemaVersion: report.schemaVersion,
    runId: report.runId,
    status: report.status,
    source: report.source,
    configuration: report.configuration,
    scenarioContract: report.scenarioContract ?? null,
    scenarioContractSha256:
      report.scenarioContractSha256 ?? null,
    profilePolicyHash: report.profilePolicyHash ?? null,
    tesseraUiIdentity: report.tesseraUiIdentity ?? null,
    pinnedData: report.pinnedData,
    comparisonClass: report.comparisonClass,
    pointsComparisons: report.pointsComparisons,
    player: {
      fingerprint: report.player.fingerprint,
      sourceRoszSha256: report.player.sourceRoszSha256,
      enrichedRoszSha256: report.player.enrichedRoszSha256,
      simulationInput: report.player.simulationInput,
      summary: report.player.summary,
      units: report.player.units,
    },
    opponents: report.opponents.map((opponent) => ({
      kind: opponent.kind,
      archetype: opponent.archetype,
      rosterName: opponent.rosterName,
      fingerprint: opponent.fingerprint,
      sourceRoszSha256: opponent.sourceRoszSha256,
      enrichedRoszSha256: opponent.enrichedRoszSha256,
      simulationInput: opponent.simulationInput,
      summary: opponent.summary,
      units: opponent.units,
      catalogueProvenance: opponent.catalogueProvenance,
    })),
    simulation: {
      requested: report.simulation.requested,
      executionMode: report.simulation.executionMode,
      status: report.simulation.status,
      requestedBackend: report.simulation.requestedBackend,
      selectedBackend: report.simulation.selectedBackend,
      providerIdentity: report.simulation.providerIdentity,
      providerEvidence: report.simulation.providerEvidence ?? null,
      providerEvidenceCaptures:
        report.simulation.providerEvidenceCaptures ?? null,
      fallback: report.simulation.fallback,
      engine: report.simulation.engine,
      settings: report.simulation.settings,
      legacyProjection: report.simulation.legacyProjection,
      matrices: report.simulation.matrices,
      scenarios: report.simulation.scenarios,
    },
    providerCompatibility:
      report.providerCompatibility ?? null,
    providerCompatibilityEnvelopes:
      report.providerCompatibilityEnvelopes ?? [],
  };
}

/**
 * The schema-v1 evidence digest is intentionally retained byte-for-byte so
 * reports issued before receipt v2 remain verifiable.
 */
export function exactReportEvidenceSha256(
  report: TesseraMatchupReport,
): string {
  return canonicalDigest(exactReportLegacyEvidence(report));
}

function scenarioPolicyBindings(
  report: TesseraMatchupReport,
): ExactMatchupReportBindingsV2["scenarioPolicies"] {
  const extended = report as ReportWithScenarioPolicyV3;
  const candidates = [
    {
      schemaVersion: 2 as const,
      contract: report.scenarioPolicyContractV2,
      declaredSha256: report.scenarioPolicyContractV2Sha256,
    },
    {
      schemaVersion: 3 as const,
      contract: extended.scenarioPolicyContractV3,
      declaredSha256: extended.scenarioPolicyContractV3Sha256,
    },
  ];
  return candidates.flatMap((candidate) => {
    const contractPresent =
      candidate.contract !== undefined && candidate.contract !== null;
    const digestPresent =
      candidate.declaredSha256 !== undefined &&
      candidate.declaredSha256 !== null;
    if (!contractPresent && !digestPresent) return [];
    if (!contractPresent) {
      throw new TypeError(
        `The scenario-policy v${candidate.schemaVersion} digest has no retained contract.`,
      );
    }
    const record = asRecord(
      candidate.contract,
      `The scenario-policy v${candidate.schemaVersion} contract`,
    );
    if (record.schemaVersion !== candidate.schemaVersion) {
      throw new TypeError(
        `The scenario-policy v${candidate.schemaVersion} contract has the wrong schema version.`,
      );
    }
    let contractSha256: string;
    try {
      contractSha256 = candidate.schemaVersion === 2
        ? tesseraScenarioPolicyContractV2Sha256(candidate.contract)
        : tesseraScenarioPolicyContractV3Sha256(candidate.contract);
    } catch (error) {
      throw new TypeError(
        `The scenario-policy v${candidate.schemaVersion} contract is malformed: ${
          error instanceof Error ? error.message : "validation failed"
        }`,
      );
    }
    const declaredSha256 = optionalSha256(
      candidate.declaredSha256,
      `The scenario-policy v${candidate.schemaVersion} digest`,
    );
    if (
      declaredSha256 !== null &&
      declaredSha256 !== contractSha256
    ) {
      throw new TypeError(
        `The scenario-policy v${candidate.schemaVersion} contract does not match its declared digest.`,
      );
    }
    return [{
      schemaVersion: candidate.schemaVersion,
      contractSha256,
      evidenceSha256: canonicalDigest(candidate.contract),
    }];
  });
}

function combatBridgeEvidenceBinding(
  report: TesseraMatchupReport,
): ExactMatchupReportBindingsV2["combatBridgeEvidence"] {
  const evidence = report.simulation.combatBridgeEvidence ?? [];
  if (!Array.isArray(evidence)) {
    throw new TypeError("The combat-bridge evidence inventory is malformed.");
  }
  const evidenceSha256s = evidence.map((item, index) => {
    const record = asRecord(
      item,
      `Combat-bridge evidence ${index + 1}`,
    );
    const evidenceSha256 = optionalSha256(
      record.evidenceSha256,
      `Combat-bridge evidence ${index + 1} digest`,
    );
    if (evidenceSha256 === null) {
      throw new TypeError(
        `Combat-bridge evidence ${index + 1} has no digest.`,
      );
    }
    const core = { ...record };
    delete core.evidenceSha256;
    if (canonicalDigest(core) !== evidenceSha256) {
      throw new TypeError(
        `Combat-bridge evidence ${index + 1} does not match its declared digest.`,
      );
    }
    return evidenceSha256;
  });
  return {
    count: evidence.length,
    evidenceSha256s,
    collectionSha256: canonicalDigest(evidence),
  };
}

function sourceArtifactBinding(
  value: unknown,
  side: "player" | "opponent",
  occurrence: number,
): ExactMatchupReportBindingsV2["sourceArtifacts"]["rosters"][number] {
  const roster = asRecord(
    value,
    `${side === "player" ? "Player" : `Opponent ${occurrence}`} report roster`,
  );
  const rosterName = optionalIdentity(
    roster.rosterName,
    `${side} roster name`,
  );
  if (rosterName === null) {
    throw new TypeError(`The ${side} roster name is missing.`);
  }
  const prepared = roster.preparedArtifact === undefined
    ? null
    : asRecord(roster.preparedArtifact, `${side} prepared artifact`);
  const simulationInput = roster.simulationInput === undefined
    ? null
    : asRecord(roster.simulationInput, `${side} simulation input`);
  const preparedKind = optionalIdentity(
    prepared?.kind,
    `${side} prepared artifact kind`,
  );
  const simulationInputKind = optionalIdentity(
    simulationInput?.kind,
    `${side} simulation input kind`,
  );
  if (
    simulationInputKind !== null &&
    simulationInputKind !== "new-recruit-enriched-rosz" &&
    simulationInputKind !== "rosterpilot-local-engine-input"
  ) {
    throw new TypeError(`${side} simulation input kind is unsupported.`);
  }
  if (
    preparedKind !== null &&
    preparedKind !== "bundle-native" &&
    preparedKind !== "new-recruit-enriched"
  ) {
    throw new TypeError(`${side} prepared artifact kind is unsupported.`);
  }
  const sourceArtifactKind = preparedKind ?? (
    simulationInputKind === "rosterpilot-local-engine-input"
      ? "bundle-native"
      : simulationInputKind === "new-recruit-enriched-rosz"
        ? "new-recruit-enriched"
        : "legacy-report"
  );
  const sourceArtifactSha256 = sameOptionalIdentity(
    [
      optionalSha256(
        roster.sourceRoszSha256,
        `${side} source artifact digest`,
      ),
      optionalSha256(
        prepared?.sourceRosterSha256 ?? prepared?.sourceRoszSha256,
        `${side} prepared source artifact digest`,
      ),
    ],
    `${side} source artifact`,
  );
  const derivedArtifactSha256 = sameOptionalIdentity(
    [
      optionalSha256(
        roster.enrichedRoszSha256,
        `${side} derived artifact digest`,
      ),
      optionalSha256(
        prepared?.engineInputSha256 ?? prepared?.enrichedRoszSha256,
        `${side} prepared derived artifact digest`,
      ),
    ],
    `${side} derived artifact`,
  );
  const simulationInputSha256 = optionalSha256(
    simulationInput?.sha256,
    `${side} simulation input digest`,
  );
  if (
    simulationInputSha256 !== null &&
    derivedArtifactSha256 !== null &&
    simulationInputSha256 !== derivedArtifactSha256
  ) {
    throw new TypeError(
      `${side} simulation input and derived artifact identities disagree.`,
    );
  }
  const bundleId = sameOptionalIdentity(
    [
      optionalIdentity(prepared?.bundleId, `${side} artifact bundle`),
      optionalIdentity(simulationInput?.bundleId, `${side} input bundle`),
    ],
    `${side} bundle`,
  );
  const compilerVersion = sameOptionalIdentity(
    [
      optionalIdentity(
        prepared?.compilerVersion,
        `${side} artifact compiler`,
      ),
      optionalIdentity(
        simulationInput?.compilerVersion,
        `${side} input compiler`,
      ),
    ],
    `${side} compiler`,
  );
  return {
    side,
    occurrence,
    rosterId: optionalIdentity(roster.rosterId, `${side} roster id`),
    rosterName,
    factionId: optionalIdentity(roster.factionId, `${side} faction id`),
    fingerprint: optionalIdentity(
      roster.fingerprint,
      `${side} roster fingerprint`,
    ),
    sourceArtifactKind,
    sourceArtifactSha256,
    derivedArtifactSha256,
    simulationInputKind: simulationInputKind as
      | "new-recruit-enriched-rosz"
      | "rosterpilot-local-engine-input"
      | null,
    simulationInputSha256,
    bundleId,
    compilerVersion,
    catalogueIdentitySha256:
      roster.catalogueProvenance === undefined ||
      roster.catalogueProvenance === null
        ? null
        : canonicalDigest(roster.catalogueProvenance),
  };
}

function sourceArtifactCollectionBinding(
  report: TesseraMatchupReport,
): ExactMatchupReportBindingsV2["sourceArtifacts"] {
  if (!Array.isArray(report.opponents)) {
    throw new TypeError("The opponent artifact inventory is malformed.");
  }
  const rosters = [
    sourceArtifactBinding(report.player, "player", 1),
    ...report.opponents.map((opponent, index) =>
      sourceArtifactBinding(opponent, "opponent", index + 1),
    ),
  ];
  return {
    rosters,
    collectionSha256: canonicalDigest(rosters),
  };
}

function providerIdentityBinding(
  report: TesseraMatchupReport,
): ExactMatchupReportBindingsV2["providerIdentity"] {
  const selectedBackend = report.simulation.selectedBackend ?? null;
  if (
    selectedBackend !== null &&
    selectedBackend !== "local-engine" &&
    selectedBackend !== "website"
  ) {
    throw new TypeError("The selected simulation provider is malformed.");
  }
  const providerIdentity = report.simulation.providerIdentity ?? null;
  if (providerIdentity === null) {
    return {
      provider: selectedBackend,
      identitySha256: null,
    };
  }
  const record = asRecord(
    providerIdentity,
    "The simulation provider identity",
  );
  if (
    record.provider !== "local-engine" &&
    record.provider !== "website"
  ) {
    throw new TypeError("The simulation provider identity is malformed.");
  }
  if (
    selectedBackend !== null &&
    record.provider !== selectedBackend
  ) {
    throw new TypeError(
      "The selected simulation provider and provider identity disagree.",
    );
  }
  return {
    provider: record.provider,
    identitySha256: canonicalDigest(providerIdentity),
  };
}

function providerCompatibilityEnvelopes(
  report: TesseraMatchupReport,
): unknown[] {
  const primary = report.providerCompatibility ?? null;
  const envelopes = report.providerCompatibilityEnvelopes ?? [];
  if (!Array.isArray(envelopes)) {
    throw new TypeError(
      "The provider-compatibility envelope inventory is malformed.",
    );
  }
  if (
    primary !== null &&
    envelopes.length > 0 &&
    (
      envelopes.length !== 1 ||
      canonicalJson(primary) !== canonicalJson(envelopes[0])
    )
  ) {
    throw new TypeError(
      "The primary and inventoried provider-compatibility envelopes disagree.",
    );
  }
  return envelopes.length > 0 ? envelopes : primary === null ? [] : [primary];
}

function validateProviderCompatibilityEnvelope(
  value: unknown,
  index: number,
  reportProvider: ExactMatchupReportBindingsV2["providerIdentity"],
  pinnedBundleId: string | null,
): string {
  const envelope = asRecord(
    value,
    `Provider-compatibility envelope ${index + 1}`,
  );
  const envelopeSha256 = optionalSha256(
    envelope.envelopeSha256,
    `Provider-compatibility envelope ${index + 1} digest`,
  );
  if (envelopeSha256 === null) {
    throw new TypeError(
      `Provider-compatibility envelope ${index + 1} has no digest.`,
    );
  }
  const core = { ...envelope };
  delete core.envelopeSha256;
  if (canonicalDigest(core) !== envelopeSha256) {
    throw new TypeError(
      `Provider-compatibility envelope ${index + 1} does not match its declared digest.`,
    );
  }
  const data = asRecord(
    envelope.data,
    `Provider-compatibility envelope ${index + 1} data identity`,
  );
  const envelopeBundleId = optionalIdentity(
    data.bundleId,
    `Provider-compatibility envelope ${index + 1} bundle`,
  );
  if (
    pinnedBundleId !== null &&
    envelopeBundleId !== null &&
    pinnedBundleId !== envelopeBundleId
  ) {
    throw new TypeError(
      `Provider-compatibility envelope ${index + 1} does not match the pinned bundle.`,
    );
  }
  const bundleTrust = asRecord(
    data.bundleTrust,
    `Provider-compatibility envelope ${index + 1} bundle trust`,
  );
  const trustIdentitySha256 = optionalSha256(
    bundleTrust.identitySha256,
    `Provider-compatibility envelope ${index + 1} bundle-trust digest`,
  );
  if (trustIdentitySha256 === null) {
    throw new TypeError(
      `Provider-compatibility envelope ${index + 1} has no bundle-trust digest.`,
    );
  }
  const trustCore = { ...bundleTrust };
  delete trustCore.identitySha256;
  if (canonicalDigest(trustCore) !== trustIdentitySha256) {
    throw new TypeError(
      `Provider-compatibility envelope ${index + 1} has inconsistent bundle-trust evidence.`,
    );
  }
  const tessera = asRecord(
    envelope.tessera,
    `Provider-compatibility envelope ${index + 1} provider identity`,
  );
  const envelopeProvider = optionalIdentity(
    tessera.provider,
    `Provider-compatibility envelope ${index + 1} provider`,
  );
  const envelopeProviderIdentity = asRecord(
    tessera.providerIdentity,
    `Provider-compatibility envelope ${index + 1} concrete provider identity`,
  );
  const providerIdentitySha256 = optionalSha256(
    tessera.providerIdentitySha256,
    `Provider-compatibility envelope ${index + 1} provider digest`,
  );
  if (
    providerIdentitySha256 === null ||
    canonicalDigest(envelopeProviderIdentity) !== providerIdentitySha256
  ) {
    throw new TypeError(
      `Provider-compatibility envelope ${index + 1} has inconsistent provider evidence.`,
    );
  }
  if (
    reportProvider.provider !== null &&
    envelopeProvider !== reportProvider.provider
  ) {
    throw new TypeError(
      `Provider-compatibility envelope ${index + 1} names a different provider.`,
    );
  }
  if (
    reportProvider.identitySha256 !== null &&
    providerIdentitySha256 !== reportProvider.identitySha256
  ) {
    throw new TypeError(
      `Provider-compatibility envelope ${index + 1} has a different provider identity.`,
    );
  }
  return envelopeSha256;
}

function bundleCompatibilityBinding(
  report: TesseraMatchupReport,
  providerIdentity: ExactMatchupReportBindingsV2["providerIdentity"],
): ExactMatchupReportBindingsV2["bundleCompatibility"] {
  const pinnedData = report.pinnedData ?? null;
  const pinnedRecord = pinnedData === null
    ? null
    : asRecord(pinnedData, "The pinned data-bundle identity");
  const pinnedBundleId = optionalIdentity(
    pinnedRecord?.bundleId,
    "The pinned data-bundle id",
  );
  const envelopes = providerCompatibilityEnvelopes(report);
  const providerCompatibilityEnvelopeSha256s = envelopes.map(
    (envelope, index) =>
      validateProviderCompatibilityEnvelope(
        envelope,
        index,
        providerIdentity,
        pinnedBundleId,
      ),
  );
  const envelopeBundleIds = envelopes.map((envelope, index) => {
    const record = asRecord(
      envelope,
      `Provider-compatibility envelope ${index + 1}`,
    );
    const data = asRecord(
      record.data,
      `Provider-compatibility envelope ${index + 1} data identity`,
    );
    return optionalIdentity(
      data.bundleId,
      `Provider-compatibility envelope ${index + 1} bundle`,
    );
  });
  const bundleId = sameOptionalIdentity(
    [pinnedBundleId, ...envelopeBundleIds],
    "The report data-bundle",
  );
  return {
    bundleId,
    pinnedDataSha256:
      pinnedData === null ? null : canonicalDigest(pinnedData),
    providerCompatibilityEvidenceSha256: canonicalDigest({
      primary: report.providerCompatibility ?? null,
      envelopes: report.providerCompatibilityEnvelopes ?? [],
    }),
    providerCompatibilityEnvelopeSha256s,
  };
}

export function exactReportBindingsV2(
  report: TesseraMatchupReport,
): ExactMatchupReportBindingsV2 {
  const scenarioPolicies = scenarioPolicyBindings(report);
  const providerIdentity = providerIdentityBinding(report);
  return {
    scenarioPolicies,
    scenarioPoliciesSha256: canonicalDigest(scenarioPolicies),
    combatBridgeEvidence: combatBridgeEvidenceBinding(report),
    sourceArtifacts: sourceArtifactCollectionBinding(report),
    providerIdentity,
    bundleCompatibility: bundleCompatibilityBinding(
      report,
      providerIdentity,
    ),
  };
}

export function exactReportEvidenceSha256V2(
  report: TesseraMatchupReport,
): string {
  const bindings = exactReportBindingsV2(report);
  return canonicalDigest({
    legacyEvidenceSha256: exactReportEvidenceSha256(report),
    bindings,
  });
}

export function exactReportReceiptPath(reportPath: string): string {
  const extension = path.extname(reportPath);
  const stem = extension
    ? reportPath.slice(0, -extension.length)
    : reportPath;
  return `${stem}.receipt.json`;
}

export function parseExactReportReceipt(
  candidate: unknown,
): ExactMatchupReportReceipt {
  const parsed = ExactMatchupReportReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const issuePath = issue?.path.length
      ? ` at ${issue.path.join(".")}`
      : "";
    throw new TypeError(
      `The exact matchup report receipt is malformed${issuePath}: ${
        issue?.message ?? "schema validation failed"
      }.`,
    );
  }
  return parsed.data;
}

export function createExactReportReceipt(
  reportFilename: string,
  serializedReport: string,
  report: TesseraMatchupReport,
): ExactMatchupReportReceiptV2 {
  const bindings = exactReportBindingsV2(report);
  return {
    schemaVersion: 2,
    kind: receiptKind,
    reportFilename: path.basename(reportFilename),
    reportSha256: digest(serializedReport),
    evidenceSha256: canonicalDigest({
      legacyEvidenceSha256: exactReportEvidenceSha256(report),
      bindings,
    }),
    runId: report.runId,
    bindings,
    bindingsSha256: canonicalDigest(bindings),
  };
}

function commonReceiptIdentityIssue(
  receipt: ExactMatchupReportReceipt,
  reportPath: string,
  report: TesseraMatchupReport,
): string | null {
  if (
    receipt.kind !== receiptKind ||
    receipt.reportFilename !== path.basename(reportPath) ||
    receipt.runId !== report.runId
  ) {
    return "The exact baseline report receipt does not identify this report.";
  }
  return null;
}

function bindingMismatchMessage(
  recorded: ExactMatchupReportBindingsV2,
  expected: ExactMatchupReportBindingsV2,
): string {
  if (
    canonicalJson(recorded.scenarioPolicies) !==
      canonicalJson(expected.scenarioPolicies) ||
    recorded.scenarioPoliciesSha256 !==
      expected.scenarioPoliciesSha256
  ) {
    return "The baseline scenario-policy evidence changed after the receipt was recorded.";
  }
  if (
    canonicalJson(recorded.combatBridgeEvidence) !==
    canonicalJson(expected.combatBridgeEvidence)
  ) {
    return "The baseline combat-bridge evidence changed after the receipt was recorded.";
  }
  if (
    canonicalJson(recorded.sourceArtifacts) !==
    canonicalJson(expected.sourceArtifacts)
  ) {
    return "The baseline player or opponent source-artifact identity changed after the receipt was recorded.";
  }
  if (
    canonicalJson(recorded.providerIdentity) !==
    canonicalJson(expected.providerIdentity)
  ) {
    return "The baseline simulation-provider identity changed after the receipt was recorded.";
  }
  if (
    canonicalJson(recorded.bundleCompatibility) !==
    canonicalJson(expected.bundleCompatibility)
  ) {
    return "The baseline bundle or provider-compatibility evidence changed after the receipt was recorded.";
  }
  return "The baseline exact-report bindings changed after the receipt was recorded.";
}

export function verifyExactReportReceipt(
  reportPath: string,
  serializedReport: string,
  report: TesseraMatchupReport,
  candidate: unknown,
): string | null {
  const parsed = ExactMatchupReportReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    return "The exact baseline report receipt is missing or malformed.";
  }
  const receipt = parsed.data;
  const identityIssue = commonReceiptIdentityIssue(
    receipt,
    reportPath,
    report,
  );
  if (identityIssue) return identityIssue;
  if (receipt.reportSha256 !== digest(serializedReport)) {
    return "The exact baseline report bytes changed after the receipt was recorded.";
  }
  if (receipt.schemaVersion === 1) {
    if (receipt.evidenceSha256 !== exactReportEvidenceSha256(report)) {
      return "The baseline scenario or matrix evidence changed after the receipt was recorded.";
    }
    return null;
  }

  let expectedBindings: ExactMatchupReportBindingsV2;
  try {
    expectedBindings = exactReportBindingsV2(report);
  } catch (error) {
    return `The baseline report contains invalid receipt-bound evidence: ${
      error instanceof Error ? error.message : "validation failed"
    }`;
  }
  if (receipt.bindingsSha256 !== canonicalDigest(receipt.bindings)) {
    return "The exact baseline report receipt bindings changed after they were recorded.";
  }
  if (
    canonicalJson(receipt.bindings) !==
    canonicalJson(expectedBindings)
  ) {
    return bindingMismatchMessage(receipt.bindings, expectedBindings);
  }
  const expectedEvidenceSha256 = canonicalDigest({
    legacyEvidenceSha256: exactReportEvidenceSha256(report),
    bindings: expectedBindings,
  });
  if (receipt.evidenceSha256 !== expectedEvidenceSha256) {
    return "The baseline scenario or matrix evidence changed after the receipt was recorded, or other receipt-bound execution evidence no longer matches.";
  }
  return null;
}
