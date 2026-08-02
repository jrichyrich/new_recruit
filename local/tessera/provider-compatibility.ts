import crypto from "node:crypto";

import type {
  DataUpdateStatus,
  RosterDraftV1,
  TesseraPreparedRoster,
  TesseraScenarioResult,
  TesseraSimulationProvider,
  TesseraSimulationProviderIdentity,
  TesseraWebsiteProviderEvidence,
  VerifiedDataBundleManifestV1,
} from "../../lib/rosterpilot";
import {
  tesseraImportedArmySemanticEvidenceIncompleteReasons,
} from "./website-semantic-evidence";
import { getActiveDataBundleManifest } from "../../lib/rosterpilot/active-data-context";
import { getDataUpdateStatus } from "../../lib/rosterpilot/data-operations";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function effectiveProviderCompatibilityMode(
  requested?: "observe" | "enforce",
  environment: Readonly<Record<string, string | undefined>> = process.env,
): "observe" | "enforce" {
  return environment.ROSTERPILOT_PROVIDER_COMPATIBILITY_ENFORCED ===
    "true"
    ? "enforce"
    : requested ?? "observe";
}

export type ProviderCompatibilityIssueCode =
  | "DATA_BUNDLE_TRUST_UNVERIFIED"
  | "DATA_BUNDLE_UPDATE_IDENTITY_INCOMPLETE"
  | "SOURCE_IDENTITY_INCOMPLETE"
  | "ROSTER_IDENTITY_INCOMPLETE"
  | "NEW_RECRUIT_IDENTITY_UNVERIFIED"
  | "NEW_RECRUIT_CATALOGUE_DRIFT"
  | "TESSERA_PROVIDER_IDENTITY_INCOMPLETE"
  | "TESSERA_DEPLOYMENT_IDENTITY_INCOMPLETE"
  | "TESSERA_IMPORT_SEMANTICS_INCOMPLETE"
  | "TESSERA_IMPORT_EFFECTS_UNRESOLVED"
  | "PROFILE_POLICY_IDENTITY_INCOMPLETE"
  | "SCENARIO_CONTRACT_IDENTITY_INCOMPLETE";

export type ProviderCompatibilityIssue = {
  code: ProviderCompatibilityIssueCode;
  message: string;
  side: "player" | "opponent" | null;
  occurrence: number | null;
};

export type ProviderCompatibilityEnvelope = {
  schemaVersion: 1;
  kind: "rosterpilot-provider-compatibility";
  data: {
    bundleId: string;
    semanticIdentitySha256: string;
    engineDataSchemaVersion: number;
    rules: {
      package: "@alpaca-software/40kdc-data";
      version: string;
      edition: "11th";
      dataslate: string;
    };
    bsData: {
      repository: "BSData/wh40k-11e";
      commit: string;
    };
    official: {
      mfmVersion: string;
      updatedAt: string;
      contentSha256: string;
      authorityStatus: "verified" | "unavailable" | "unverified-overlay" | null;
    };
    rosterRulesHash: string;
    factionRulesHash: string;
    mappingHash: string;
    entityHashesSha256: string;
    bundleTrust: ProviderCompatibilityBundleTrustIdentity;
  };
  rosters: Array<{
    side: "player" | "opponent";
    occurrence: number;
    factionId: string | null;
    rosterFingerprint: string | null;
    simulationInputKind:
      | "new-recruit-enriched-rosz"
      | "rosterpilot-local-engine-input"
      | null;
    simulationInputSha256: string | null;
    enrichedRoszSha256: string | null;
    newRecruit: {
      status: "matched" | "drift" | "unverifiable" | "not-applicable";
      pinned: TesseraPreparedRoster["catalogueProvenance"] extends infer T
        ? T extends { pinned: infer P }
          ? P | null
          : null
        : null;
      observed: TesseraPreparedRoster["catalogueProvenance"] extends infer T
        ? T extends { observed: infer O }
          ? O | null
          : null
        : null;
    };
  }>;
  tessera: {
    provider: TesseraSimulationProvider;
    providerIdentitySha256: string;
    providerIdentity: TesseraSimulationProviderIdentity;
    website: TesseraWebsiteProviderEvidence | null;
  };
  profilePolicyHash: string | null;
  scenarioContractSha256: string;
  complete: boolean;
  issues: ProviderCompatibilityIssue[];
  envelopeSha256: string;
};

export type ProviderCompatibilityEnvelopeInput = {
  sourceData: RosterDraftV1["sourceData"];
  bundleTrust?: ProviderCompatibilityBundleTrustIdentity;
  player: ProviderCompatibilityPreparedRoster;
  opponents: ProviderCompatibilityPreparedRoster[];
  providerIdentity: TesseraSimulationProviderIdentity | null;
  websiteEvidence?: TesseraWebsiteProviderEvidence | null;
  profilePolicyHash: string | null;
  scenarioContractSha256: string | null;
};

export type ProviderCompatibilityPreparedRoster = {
  rosterName: string;
  factionId?: string;
  fingerprint?: string;
  simulationInput?: TesseraPreparedRoster["simulationInput"];
  enrichedRoszSha256?: string;
  catalogueProvenance?: TesseraPreparedRoster["catalogueProvenance"];
};

export type MatchupProviderCompatibilityInput = {
  sourceData: RosterDraftV1["sourceData"];
  bundleTrust?: ProviderCompatibilityBundleTrustIdentity;
  player: ProviderCompatibilityPreparedRoster;
  opponents: ProviderCompatibilityPreparedRoster[];
  providerIdentity: TesseraSimulationProviderIdentity | null;
  websiteEvidenceCaptures?: Array<{
    opponentName: string;
    evidence: TesseraWebsiteProviderEvidence;
  }>;
  profilePolicyHash: string | null;
  scenarios: TesseraScenarioResult[];
  /** Prefer the exact durable-job contract hash when one was explicitly frozen. */
  scenarioContractSha256?: string | null;
};

export type ProviderCompatibilityComparison = {
  comparable: boolean;
  issues: Array<{
    code:
      | "ENVELOPE_INCOMPLETE"
      | "ENVELOPE_DIGEST_INVALID"
      | "PROVIDER_PAIR_INVALID"
      | "DATA_BUNDLE_TRUST_MISMATCH"
      | "DATA_SEMANTICS_MISMATCH"
      | "ROSTER_SCOPE_MISMATCH"
      | "PROFILE_POLICY_MISMATCH"
      | "SCENARIO_CONTRACT_MISMATCH";
    message: string;
  }>;
};

export type ProviderCompatibilityBundleTrustIdentity = {
  schemaVersion: 1;
  manifest: {
    bundleId: string;
    signingKeyId: string;
    manifestSha256: string;
    semanticIdentitySha256: string;
  } | null;
  update: {
    providerConfigured: boolean;
    dataTrust: "signed-verified" | "compiled-unverified";
    state: DataUpdateStatus["state"];
    activeBundleId: string | null;
    latestVerifiedBundleId: string | null;
    latestUpstreamBundleId: string | null;
    candidate: {
      bundleId: string;
      classificationSha256: string;
    } | null;
    quarantinedScopesSha256: string;
    officialAuthoritySha256: string;
    rollbackHold: NonNullable<DataUpdateStatus["rollbackHold"]> | null;
    durability: NonNullable<DataUpdateStatus["durability"]> | null;
  };
  identitySha256: string;
};

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

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function bundleTrustWithoutDigest(input: {
  manifest: VerifiedDataBundleManifestV1 | null;
  status: DataUpdateStatus;
}): Omit<ProviderCompatibilityBundleTrustIdentity, "identitySha256"> {
  const quarantinedScopes = [...input.status.quarantinedScopes]
    .map((entry) => ({
      scope: entry.scope,
      bundleId: entry.bundleId,
      reason: entry.reason,
    }))
    .sort((left, right) =>
      [left.scope, left.bundleId, left.reason]
        .join("\u0000")
        .localeCompare(
          [right.scope, right.bundleId, right.reason].join("\u0000"),
        ),
    );
  const manifest = input.manifest
    ? {
        bundleId: input.manifest.bundleId,
        signingKeyId: input.manifest.signature.keyId,
        manifestSha256: sha256(input.manifest),
        semanticIdentitySha256: sha256(input.manifest.semanticHashes),
      }
    : null;
  return {
    schemaVersion: 1,
    manifest,
    update: {
      providerConfigured: input.status.providerConfigured,
      dataTrust: input.status.dataTrust ?? "compiled-unverified",
      state: input.status.state,
      activeBundleId: input.status.activeBundleId,
      latestVerifiedBundleId: input.status.latestVerifiedBundleId,
      latestUpstreamBundleId: input.status.latestUpstreamBundleId,
      candidate: input.status.candidate
        ? {
            bundleId: input.status.candidate.bundleId,
            classificationSha256: sha256(
              input.status.candidate.classification,
            ),
          }
        : null,
      quarantinedScopesSha256: sha256(quarantinedScopes),
      officialAuthoritySha256: sha256(
        input.status.officialAuthority,
      ),
      rollbackHold: input.status.rollbackHold ?? null,
      durability: input.status.durability ?? null,
    },
  };
}

export function buildProviderCompatibilityBundleTrustIdentity(input: {
  manifest: VerifiedDataBundleManifestV1 | null;
  status: DataUpdateStatus;
}): ProviderCompatibilityBundleTrustIdentity {
  const withoutDigest = bundleTrustWithoutDigest(input);
  return {
    ...withoutDigest,
    identitySha256:
      providerCompatibilityBundleTrustIdentitySha256(withoutDigest),
  };
}

/**
 * Captures the currently activated, signature-verified manifest together with
 * the runtime update-provider status. Callers bind this immutable value to
 * the compatibility envelope instead of inferring trust from roster hashes.
 */
export async function captureProviderCompatibilityBundleTrustIdentity(): Promise<ProviderCompatibilityBundleTrustIdentity> {
  const status = await getDataUpdateStatus();
  return buildProviderCompatibilityBundleTrustIdentity({
    manifest: getActiveDataBundleManifest(),
    status:
      status.data ?? {
        providerConfigured: false,
        state: "offline",
        activeBundleId: null,
        latestVerifiedBundleId: null,
        latestUpstreamBundleId: null,
        candidate: null,
        quarantinedScopes: [],
        lastSuccessfulCheckAt: null,
        officialAuthority: {
          status: "unverified-overlay",
          reason: "Runtime data-update status was unavailable.",
        },
        rollbackHold: null,
        dataTrust: "compiled-unverified",
        durability: {
          mode: "memory",
          state: "degraded",
          reason: "Runtime data-update status was unavailable.",
        },
      },
  });
}

export function providerCompatibilityBundleTrustIdentitySha256(
  trust: Omit<ProviderCompatibilityBundleTrustIdentity, "identitySha256">,
): string {
  return sha256(trust);
}

export function providerCompatibilityBundleTrustDigestValid(
  trust: ProviderCompatibilityBundleTrustIdentity,
): boolean {
  const { identitySha256, ...withoutDigest } = trust;
  return (
    validSha256(identitySha256) &&
    identitySha256 ===
      providerCompatibilityBundleTrustIdentitySha256(withoutDigest)
  );
}

export function providerCompatibilityDataSemanticIdentitySha256(
  data: Pick<
    ProviderCompatibilityEnvelope["data"],
    | "bundleId"
    | "engineDataSchemaVersion"
    | "rosterRulesHash"
    | "factionRulesHash"
    | "mappingHash"
    | "entityHashesSha256"
  >,
): string {
  return sha256({
    bundleId: data.bundleId,
    engineDataSchemaVersion: data.engineDataSchemaVersion,
    rosterRulesHash: data.rosterRulesHash,
    factionRulesHash: data.factionRulesHash,
    mappingHash: data.mappingHash,
    entityHashesSha256: data.entityHashesSha256,
  });
}

/**
 * Revalidates the signed-bundle/update identity embedded in a retained
 * compatibility envelope. This is deliberately independent of the envelope
 * and report receipts: both are unkeyed digests that an editor could
 * recompute after changing nested trust fields.
 */
export function providerCompatibilityTrustBindingIssues(
  envelope: ProviderCompatibilityEnvelope,
): string[] {
  const trust = envelope.data.bundleTrust;
  const manifest = trust.manifest;
  const issues: string[] = [];
  if (!providerCompatibilityBundleTrustDigestValid(trust)) {
    issues.push("bundle-trust-identity-digest-mismatch");
  }
  if (
    trust.schemaVersion !== 1 ||
    trust.update.dataTrust !== "signed-verified" ||
    !trust.update.providerConfigured ||
    !manifest ||
    !validSha256(manifest.bundleId) ||
    !validSha256(manifest.manifestSha256) ||
    !validSha256(manifest.semanticIdentitySha256) ||
    !manifest.signingKeyId.trim()
  ) {
    issues.push("signed-bundle-trust-incomplete");
  }
  if (
    manifest?.bundleId !== envelope.data.bundleId ||
    trust.update.activeBundleId !== envelope.data.bundleId
  ) {
    issues.push("active-bundle-trust-binding-mismatch");
  }
  if (
    !validSha256(trust.update.latestVerifiedBundleId) ||
    !validSha256(trust.update.quarantinedScopesSha256) ||
    !validSha256(trust.update.officialAuthoritySha256) ||
    (trust.update.latestUpstreamBundleId !== null &&
      !validSha256(trust.update.latestUpstreamBundleId)) ||
    (trust.update.candidate !== null &&
      (!validSha256(trust.update.candidate.bundleId) ||
        !validSha256(trust.update.candidate.classificationSha256))) ||
    (trust.update.rollbackHold !== null &&
      !validSha256(trust.update.rollbackHold.bundleId))
  ) {
    issues.push("bundle-update-identity-incomplete");
  }
  if (
    manifest?.semanticIdentitySha256 !==
      envelope.data.semanticIdentitySha256
  ) {
    issues.push("signed-semantic-identity-binding-mismatch");
  }
  return [...new Set(issues)].sort();
}

export function providerCompatibilityScenarioContractSha256(
  scenarios: TesseraScenarioResult[],
): string | null {
  if (scenarios.length === 0) return null;
  const contract = scenarios
    .flatMap((scenario) => {
      const metricRuns = scenario.metricRuns ?? [];
      return metricRuns.map((run) => ({
        scenarioId: scenario.scenarioId,
        opponentName: scenario.opponentName,
        phase: scenario.phase,
        direction: scenario.direction,
        metric: run.metric,
        settings: run.settings,
        iterations: run.iterations,
      }));
    })
    .sort((left, right) =>
      [
        left.opponentName,
        left.scenarioId,
        left.phase,
        left.direction,
        left.metric,
      ]
        .join("\u0000")
        .localeCompare(
          [
            right.opponentName,
            right.scenarioId,
            right.phase,
            right.direction,
            right.metric,
          ].join("\u0000"),
        ),
    );
  if (
    contract.length === 0 ||
    contract.some(
      (entry) =>
        !Number.isSafeInteger(entry.iterations) ||
        Number(entry.iterations) <= 0 ||
        Object.keys(entry.settings).length === 0,
    )
  ) {
    return null;
  }
  return sha256(contract);
}

function validSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function semanticDataIdentity(sourceData: RosterDraftV1["sourceData"]) {
  return {
    bundleId: sourceData.bundleId,
    engineDataSchemaVersion: sourceData.engineDataSchemaVersion,
    rosterRulesHash: sourceData.rosterRulesHash,
    factionRulesHash: sourceData.factionRulesHash,
    mappingHash: sourceData.mappingHash,
    entityHashesSha256: sha256(sourceData.entityHashes),
  };
}

function normalizedWebsiteEvidence(
  evidence: TesseraWebsiteProviderEvidence | null | undefined,
): TesseraWebsiteProviderEvidence | null {
  if (!evidence) return null;
  return {
    schemaVersion: evidence.schemaVersion,
    deployment: {
      identitySha256: evidence.deployment.identitySha256,
      declaredVersion: evidence.deployment.declaredVersion,
      assets: [...evidence.deployment.assets]
        .map((asset) => ({
          url: asset.url,
          sameOrigin: asset.sameOrigin,
          sha256: asset.sha256?.toLowerCase() ?? null,
          byteLength: asset.byteLength ?? null,
        }))
        .sort((left, right) => left.url.localeCompare(right.url)),
      complete: evidence.deployment.complete,
      completeness: evidence.deployment.completeness,
      declarationSha256: evidence.deployment.declarationSha256,
      incompleteReasons: [...evidence.deployment.incompleteReasons].sort(),
    },
    importSemantics: {
      combinedSha256:
        evidence.importSemantics.combinedSha256?.toLowerCase() ?? null,
      playerSha256:
        evidence.importSemantics.playerSha256?.toLowerCase() ?? null,
      opponentSha256:
        evidence.importSemantics.opponentSha256?.toLowerCase() ?? null,
      complete: evidence.importSemantics.complete,
      completeness: evidence.importSemantics.completeness,
      unresolvedEffectCount: evidence.importSemantics.unresolvedEffectCount,
      playerSnapshot: evidence.importSemantics.playerSnapshot
        ? structuredClone(evidence.importSemantics.playerSnapshot)
        : null,
      opponentSnapshot: evidence.importSemantics.opponentSnapshot
        ? structuredClone(evidence.importSemantics.opponentSnapshot)
        : null,
      ...(evidence.importSemantics.stateBindings
        ? {
            stateBindings: structuredClone(
              evidence.importSemantics.stateBindings,
            ),
          }
        : {}),
      incompleteReasons: [
        ...evidence.importSemantics.incompleteReasons,
      ].sort(),
    },
  };
}

function preparedRosters(input: ProviderCompatibilityEnvelopeInput) {
  return [
    { side: "player" as const, occurrence: 1, prepared: input.player },
    ...input.opponents.map((prepared, index) => ({
      side: "opponent" as const,
      occurrence: index + 1,
      prepared,
    })),
  ];
}

export function providerCompatibilityEnvelopeSha256(
  envelope: Omit<ProviderCompatibilityEnvelope, "envelopeSha256">,
): string {
  return sha256(envelope);
}

export function buildProviderCompatibilityEnvelope(
  input: ProviderCompatibilityEnvelopeInput,
): ProviderCompatibilityEnvelope {
  const issues: ProviderCompatibilityIssue[] = [];
  const source = semanticDataIdentity(input.sourceData);
  const trust =
    input.bundleTrust ??
    buildProviderCompatibilityBundleTrustIdentity({
      manifest: null,
      status: {
        providerConfigured: false,
        state: "offline",
        activeBundleId: input.sourceData.bundleId,
        latestVerifiedBundleId: null,
        latestUpstreamBundleId: null,
        candidate: null,
        quarantinedScopes: [],
        lastSuccessfulCheckAt: null,
        officialAuthority: {
          status: "unverified-overlay",
          reason:
            "No verified bundle trust snapshot was supplied to the compatibility envelope.",
        },
        rollbackHold: null,
        dataTrust: "compiled-unverified",
        durability: {
          mode: "memory",
          state: "degraded",
          reason:
            "No verified bundle trust snapshot was supplied to the compatibility envelope.",
        },
      },
    });
  const manifest = trust.manifest;
  if (
    !providerCompatibilityBundleTrustDigestValid(trust) ||
    trust.update.dataTrust !== "signed-verified" ||
    !trust.update.providerConfigured ||
    !manifest ||
    !validSha256(manifest.bundleId) ||
    !validSha256(manifest.manifestSha256) ||
    !validSha256(manifest.semanticIdentitySha256) ||
    !manifest.signingKeyId.trim()
  ) {
    issues.push({
      code: "DATA_BUNDLE_TRUST_UNVERIFIED",
      message:
        "Provider compatibility requires the activated signature-verified bundle manifest, signing key, and trust identity.",
      side: null,
      occurrence: null,
    });
  }
  const updateBundleIds = [
    trust.update.activeBundleId,
    trust.update.latestVerifiedBundleId,
    trust.update.latestUpstreamBundleId,
    trust.update.candidate?.bundleId ?? null,
    trust.update.rollbackHold?.bundleId ?? null,
  ].filter((value): value is string => value !== null);
  if (
    !providerCompatibilityBundleTrustDigestValid(trust) ||
    trust.update.activeBundleId !== input.sourceData.bundleId ||
    manifest?.bundleId !== input.sourceData.bundleId ||
    !validSha256(trust.update.latestVerifiedBundleId) ||
    updateBundleIds.some((bundleId) => !validSha256(bundleId)) ||
    !validSha256(trust.update.quarantinedScopesSha256) ||
    !validSha256(trust.update.officialAuthoritySha256) ||
    (trust.update.candidate !== null &&
      !validSha256(trust.update.candidate.classificationSha256))
  ) {
    issues.push({
      code: "DATA_BUNDLE_UPDATE_IDENTITY_INCOMPLETE",
      message:
        "The runtime update status is not completely bound to the same activated signed bundle as this roster operation.",
      side: null,
      occurrence: null,
    });
  }
  if (
    !validSha256(source.bundleId) ||
    !validSha256(source.rosterRulesHash) ||
    !validSha256(source.factionRulesHash) ||
    !validSha256(source.mappingHash) ||
    !validSha256(source.entityHashesSha256) ||
    !/^[a-f0-9]{40}$/.test(input.sourceData.newRecruit.commit)
  ) {
    issues.push({
      code: "SOURCE_IDENTITY_INCOMPLETE",
      message:
        "The signed data bundle did not provide a complete semantic and BSData identity.",
      side: null,
      occurrence: null,
    });
  }

  const provider = input.providerIdentity?.provider ?? null;
  const rosters = preparedRosters(input).map(
    ({ side, occurrence, prepared }) => {
      const provenance = prepared.catalogueProvenance ?? null;
      const newRecruitStatus: ProviderCompatibilityEnvelope["rosters"][number]["newRecruit"]["status"] =
        provider === "website"
          ? provenance?.status ?? "unverifiable"
          : "not-applicable";
      if (
        !prepared.fingerprint ||
        !prepared.simulationInput ||
        !validSha256(prepared.simulationInput.sha256) ||
        (provider === "website" &&
          !validSha256(prepared.enrichedRoszSha256))
      ) {
        issues.push({
          code: "ROSTER_IDENTITY_INCOMPLETE",
          message: `The ${side} roster occurrence ${occurrence} has no complete fingerprint and provider input hash.`,
          side,
          occurrence,
        });
      }
      if (provider === "website" && newRecruitStatus === "drift") {
        issues.push({
          code: "NEW_RECRUIT_CATALOGUE_DRIFT",
          message: `The ${side} roster occurrence ${occurrence} does not match the frozen New Recruit catalogue identity.`,
          side,
          occurrence,
        });
      } else if (
        provider === "website" &&
        newRecruitStatus !== "matched"
      ) {
        issues.push({
          code: "NEW_RECRUIT_IDENTITY_UNVERIFIED",
          message: `The ${side} roster occurrence ${occurrence} has no complete observed New Recruit catalogue identity.`,
          side,
          occurrence,
        });
      }
      return {
        side,
        occurrence,
        factionId: prepared.factionId ?? null,
        rosterFingerprint: prepared.fingerprint ?? null,
        simulationInputKind: prepared.simulationInput?.kind ?? null,
        simulationInputSha256:
          prepared.simulationInput?.sha256.toLowerCase() ?? null,
        enrichedRoszSha256:
          prepared.enrichedRoszSha256?.toLowerCase() ?? null,
        newRecruit: {
          status: newRecruitStatus,
          pinned: provenance?.pinned ?? null,
          observed: provenance?.observed ?? null,
        },
      };
    },
  );

  if (!input.providerIdentity) {
    issues.push({
      code: "TESSERA_PROVIDER_IDENTITY_INCOMPLETE",
      message: "The Tessera provider did not return an immutable identity.",
      side: null,
      occurrence: null,
    });
  }
  const websiteEvidence = normalizedWebsiteEvidence(input.websiteEvidence);
  if (provider === "website") {
    const playerSemanticReasons =
      websiteEvidence?.importSemantics.playerSnapshot
        ? tesseraImportedArmySemanticEvidenceIncompleteReasons(
            websiteEvidence.importSemantics.playerSnapshot,
            websiteEvidence.importSemantics.stateBindings?.player,
          )
        : ["player-snapshot-unavailable"];
    const opponentSemanticReasons =
      websiteEvidence?.importSemantics.opponentSnapshot
        ? tesseraImportedArmySemanticEvidenceIncompleteReasons(
            websiteEvidence.importSemantics.opponentSnapshot,
            websiteEvidence.importSemantics.stateBindings?.opponent,
          )
        : ["opponent-snapshot-unavailable"];
    if (
      !websiteEvidence?.deployment.complete ||
      !validSha256(websiteEvidence.deployment.identitySha256) ||
      !validSha256(websiteEvidence.deployment.declarationSha256) ||
      !websiteEvidence.deployment.assets.some(
        (asset) => asset.sameOrigin,
      ) ||
      websiteEvidence.deployment.assets.some(
        (asset) =>
          asset.sameOrigin && !validSha256(asset.sha256),
      )
    ) {
      issues.push({
        code: "TESSERA_DEPLOYMENT_IDENTITY_INCOMPLETE",
        message:
          "Tessera Web did not expose a complete content-addressed deployment identity.",
        side: null,
        occurrence: null,
      });
    }
    if (
      !websiteEvidence?.importSemantics.complete ||
      !validSha256(websiteEvidence.importSemantics.combinedSha256) ||
      !validSha256(websiteEvidence.importSemantics.playerSha256) ||
      !validSha256(websiteEvidence.importSemantics.opponentSha256) ||
      websiteEvidence.importSemantics.playerSnapshot === null ||
      websiteEvidence.importSemantics.opponentSnapshot === null ||
      playerSemanticReasons.length > 0 ||
      opponentSemanticReasons.length > 0
    ) {
      issues.push({
        code: "TESSERA_IMPORT_SEMANTICS_INCOMPLETE",
        message:
          "Tessera Web did not expose a complete normalized semantic snapshot for both imported armies.",
        side: null,
        occurrence: null,
      });
    }
    if (
      websiteEvidence &&
      (!Number.isSafeInteger(
        websiteEvidence.importSemantics.unresolvedEffectCount,
      ) ||
        websiteEvidence.importSemantics.unresolvedEffectCount > 0)
    ) {
      issues.push({
        code: "TESSERA_IMPORT_EFFECTS_UNRESOLVED",
        message:
          "Tessera Web retained one or more unresolved imported combat effects.",
        side: null,
        occurrence: null,
      });
    }
  }
  if (
    input.profilePolicyHash !== null &&
    !validSha256(input.profilePolicyHash)
  ) {
    issues.push({
      code: "PROFILE_POLICY_IDENTITY_INCOMPLETE",
      message: "The profile-policy identity is not a SHA-256 value.",
      side: null,
      occurrence: null,
    });
  }
  if (!validSha256(input.scenarioContractSha256)) {
    issues.push({
      code: "SCENARIO_CONTRACT_IDENTITY_INCOMPLETE",
      message: "The frozen scenario contract has no valid SHA-256 identity.",
      side: null,
      occurrence: null,
    });
  }

  const providerIdentity =
    input.providerIdentity ??
    ({
      schemaVersion: 1,
      provider: "website",
      engine: "tessera-ui",
      uiIdentity: null,
      adapterVersion: "missing",
    } as const);
  const withoutDigest: Omit<
    ProviderCompatibilityEnvelope,
    "envelopeSha256"
  > = {
    schemaVersion: 1,
    kind: "rosterpilot-provider-compatibility",
    data: {
      bundleId: input.sourceData.bundleId,
      semanticIdentitySha256:
        manifest?.semanticIdentitySha256 ??
        providerCompatibilityDataSemanticIdentitySha256(source),
      engineDataSchemaVersion:
        input.sourceData.engineDataSchemaVersion,
      rules: {
        package: input.sourceData.package,
        version: input.sourceData.version,
        edition: input.sourceData.edition,
        dataslate: input.sourceData.dataslate,
      },
      bsData: {
        repository: input.sourceData.newRecruit.repository,
        commit: input.sourceData.newRecruit.commit,
      },
      official: {
        mfmVersion: input.sourceData.official.mfmVersion,
        updatedAt: input.sourceData.official.updatedAt,
        contentSha256: input.sourceData.official.contentSha256,
        authorityStatus:
          input.sourceData.official.authority?.status ?? null,
      },
      rosterRulesHash: input.sourceData.rosterRulesHash,
      factionRulesHash: input.sourceData.factionRulesHash,
      mappingHash: input.sourceData.mappingHash,
      entityHashesSha256: source.entityHashesSha256,
      bundleTrust: structuredClone(trust),
    },
    rosters,
    tessera: {
      provider: providerIdentity.provider,
      providerIdentitySha256: sha256(providerIdentity),
      providerIdentity,
      website:
        providerIdentity.provider === "website"
          ? websiteEvidence
          : null,
    },
    profilePolicyHash: input.profilePolicyHash,
    scenarioContractSha256: input.scenarioContractSha256 ?? "",
    complete: issues.length === 0,
    issues: issues.sort((left, right) =>
      [left.code, left.side ?? "", left.occurrence ?? 0, left.message]
        .join("\u0000")
        .localeCompare(
          [
            right.code,
            right.side ?? "",
            right.occurrence ?? 0,
            right.message,
          ].join("\u0000"),
        ),
    ),
  };
  return {
    ...withoutDigest,
    envelopeSha256:
      providerCompatibilityEnvelopeSha256(withoutDigest),
  };
}

export function buildMatchupProviderCompatibilityEnvelopes(
  input: MatchupProviderCompatibilityInput,
): ProviderCompatibilityEnvelope[] {
  return input.opponents.map((opponent, index) => {
    const observedScenarioContractSha256 =
      input.scenarioContractSha256 ??
      providerCompatibilityScenarioContractSha256(
        input.scenarios.filter(
          (scenario) => scenario.opponentName === opponent.rosterName,
        ),
      );
    const captured = input.websiteEvidenceCaptures?.[index];
    const websiteEvidence =
      captured?.opponentName === opponent.rosterName
        ? captured.evidence
        : null;
    return buildProviderCompatibilityEnvelope({
      sourceData: input.sourceData,
      bundleTrust: input.bundleTrust,
      player: input.player,
      opponents: [opponent],
      providerIdentity: input.providerIdentity,
      websiteEvidence,
      profilePolicyHash: input.profilePolicyHash,
      scenarioContractSha256: observedScenarioContractSha256,
    });
  });
}

function sharedRosterScope(envelope: ProviderCompatibilityEnvelope) {
  return envelope.rosters.map((roster) => ({
    side: roster.side,
    occurrence: roster.occurrence,
    factionId: roster.factionId,
    rosterFingerprint: roster.rosterFingerprint,
  }));
}

export function compareProviderCompatibilityEnvelopes(
  first: ProviderCompatibilityEnvelope,
  second: ProviderCompatibilityEnvelope,
): ProviderCompatibilityComparison {
  const issues: ProviderCompatibilityComparison["issues"] = [];
  for (const envelope of [first, second]) {
    const { envelopeSha256, ...withoutDigest } = envelope;
    if (
      envelopeSha256 !==
      providerCompatibilityEnvelopeSha256(withoutDigest)
    ) {
      issues.push({
        code: "ENVELOPE_DIGEST_INVALID",
        message: `${envelope.tessera.provider} compatibility evidence does not match its recorded digest.`,
      });
    }
    if (!envelope.complete || envelope.issues.length > 0) {
      issues.push({
        code: "ENVELOPE_INCOMPLETE",
        message: `${envelope.tessera.provider} compatibility evidence is incomplete.`,
      });
    }
  }
  if (
    new Set([first.tessera.provider, second.tessera.provider]).size !== 2 ||
    ![first.tessera.provider, second.tessera.provider].includes(
      "local-engine",
    ) ||
    ![first.tessera.provider, second.tessera.provider].includes("website")
  ) {
    issues.push({
      code: "PROVIDER_PAIR_INVALID",
      message:
        "Compatibility comparison requires one local-engine envelope and one website envelope.",
    });
  }
  if (
    first.data.bundleTrust.identitySha256 !==
    second.data.bundleTrust.identitySha256
  ) {
    issues.push({
      code: "DATA_BUNDLE_TRUST_MISMATCH",
      message:
        "The providers are not bound to the same verified bundle trust and update identity.",
    });
  }
  if (
    first.data.semanticIdentitySha256 !==
    second.data.semanticIdentitySha256
  ) {
    issues.push({
      code: "DATA_SEMANTICS_MISMATCH",
      message:
        "The providers do not use the same signed roster-data semantics.",
    });
  }
  if (
    canonical(sharedRosterScope(first)) !==
    canonical(sharedRosterScope(second))
  ) {
    issues.push({
      code: "ROSTER_SCOPE_MISMATCH",
      message:
        "The providers do not cover the same canonical roster fingerprints.",
    });
  }
  if (first.profilePolicyHash !== second.profilePolicyHash) {
    issues.push({
      code: "PROFILE_POLICY_MISMATCH",
      message: "The providers do not use the same profile-policy identity.",
    });
  }
  if (
    first.scenarioContractSha256 !==
    second.scenarioContractSha256
  ) {
    issues.push({
      code: "SCENARIO_CONTRACT_MISMATCH",
      message: "The providers do not use the same scenario contract.",
    });
  }
  return {
    comparable: issues.length === 0,
    issues,
  };
}
