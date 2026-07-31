import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import {
  activateNewRecruitCatalogueMappings,
  newRecruitCatalogueMappings,
} from "../lib/rosterpilot/catalogue";
import {
  activateNewRecruitCatalogueSummary,
  newRecruitCatalogue,
} from "../lib/rosterpilot/catalogue-summary";
import {
  clearActiveDataBundleManifestForTests,
  getActiveDataBundleManifest,
} from "../lib/rosterpilot/active-data-context";
import {
  createDataBundleSnapshot,
  verifyDataBundleManifest,
  verifyDataBundleShard,
  type VerifiedDataBundleShardV1,
  type DataBundleVerificationResult,
} from "../lib/rosterpilot/data-bundle";
import {
  buildRoster,
} from "../lib/rosterpilot/engine";
import {
  CertificationManifestSchema,
  certificationExpertReviewBinding,
  runDeterministicCertification,
} from "../lib/rosterpilot/certification";
import {
  buildRuntimeDataBundle,
  composeRuntimeDataBundleRetainingVerifiedShards,
  FACTION_DATA_DEPENDENCIES,
  signRuntimeDataBundle,
  activateRuntimeDataBundle,
  verifyRuntimeDataBundle,
  type RuntimeDataBundleShardDataV1,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  activateRuntimeRulesData,
  serializeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import {
  canonicalJson,
  classifyDataBundleDelta,
  semanticHash,
  sha256Hex,
} from "../lib/rosterpilot/semantic-hash";
import {
  resetRosterCompatibilityIdentityCache,
} from "../lib/rosterpilot/draft";
import {
  rosterExecutionFingerprint,
  rosterStructuralFingerprint,
} from "../lib/rosterpilot/stress-portfolio";

const originalRules = serializeRuntimeRulesData();
const originalCatalogue = structuredClone(
  newRecruitCatalogueMappings,
);
const originalSummary = structuredClone(newRecruitCatalogue);
const certificationManifestDocument = JSON.parse(
  readFileSync(
    new URL(
      "../data/certification-manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const certificationManifest = CertificationManifestSchema.parse(
  certificationManifestDocument,
);

afterEach(() => {
  activateRuntimeRulesData(originalRules);
  activateNewRecruitCatalogueMappings(originalCatalogue);
  activateNewRecruitCatalogueSummary(originalSummary);
  clearActiveDataBundleManifestForTests();
  resetRosterCompatibilityIdentityCache();
});

test("compiled fallback rosters disclose unverified official authority", () => {
  clearActiveDataBundleManifestForTests();
  const roster = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Compiled authority disclosure",
  });
  assert.ok(roster.data);
  assert.equal(
    roster.data.sourceData.official.authority?.status,
    "unverified-overlay",
  );
  assert.equal(
    roster.warnings.some(
      (warning) => warning.code === "OFFICIAL_AUTHORITY_UNAVAILABLE",
    ),
    true,
  );
});

async function signer() {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  return {
    signer: {
      keyId: "runtime-test",
      privateKey: keys.privateKey,
    },
    registry: {
      "runtime-test": keys.publicKey,
    },
  };
}

async function activateSignedBuild(
  build: Awaited<ReturnType<typeof buildRuntimeDataBundle>>,
): Promise<void> {
  const signing = await signer();
  const signed = await signRuntimeDataBundle(
    build,
    signing.signer,
  );
  const verified = await verifyRuntimeDataBundle({
    manifest: signed.manifest,
    shards: signed.shards,
    trustedKeys: signing.registry,
  });
  if (!verified.ok) {
    assert.fail(`Runtime bundle verification failed: ${verified.message}`);
  }
  activateRuntimeDataBundle(verified.data);
}

test("a signed runtime bundle reconstructs one immutable build snapshot", async () => {
  const before = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Runtime snapshot baseline",
  });
  assert.ok(before.ok && before.data);

  const build = await buildRuntimeDataBundle({
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  const global = build.shards.find(
    (shard) => shard.shardId === "global",
  );
  const custodes = build.shards.find(
    (shard) => shard.shardId === "faction:adeptus-custodes",
  );
  assert.equal(
    global?.data.payloadKind,
    "rosterpilot-runtime-global",
  );
  assert.equal(
    custodes?.data.payloadKind,
    "rosterpilot-runtime-faction",
  );
  if (
    global?.data.payloadKind !== "rosterpilot-runtime-global" ||
    custodes?.data.payloadKind !== "rosterpilot-runtime-faction"
  ) {
    assert.fail("Expected supported runtime shards.");
  }
  assert.equal(
    global.data.rulesData.units.some(
      (unit) =>
        (unit as { faction_id?: string }).faction_id ===
        "adeptus-custodes",
    ),
    false,
  );
  assert.ok(custodes.data.rulesData.units.length > 0);

  const signing = await signer();
  const signed = await signRuntimeDataBundle(
    build,
    signing.signer,
  );
  const verifiedManifest = await verifyDataBundleManifest(
    signed.manifest,
    signing.registry,
  );
  assert.equal(verifiedManifest.ok, true);
  if (!verifiedManifest.ok) assert.fail("Manifest verification failed.");
  const verifiedShards: Array<
    VerifiedDataBundleShardV1<RuntimeDataBundleShardDataV1>
  > = [];
  for (const shard of signed.shards) {
    const shardResult: DataBundleVerificationResult<
      VerifiedDataBundleShardV1<RuntimeDataBundleShardDataV1>
    > = await verifyDataBundleShard<RuntimeDataBundleShardDataV1>(
      verifiedManifest.data,
      shard,
    );
    assert.equal(shardResult.ok, true);
    if (!shardResult.ok) assert.fail("Shard verification failed.");
    verifiedShards.push(shardResult.data);
  }
  const snapshot = createDataBundleSnapshot<
    RuntimeDataBundleShardDataV1
  >(
    verifiedManifest.data,
    verifiedShards,
    { acquiredAt: "2026-07-30T00:01:00.000Z" },
  );
  activateRuntimeDataBundle(snapshot);

  const after = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Runtime snapshot baseline",
  });
  assert.ok(after.ok && after.data);
  assert.equal(
    rosterStructuralFingerprint(after.data),
    rosterStructuralFingerprint(before.data),
  );
  assert.equal(
    rosterExecutionFingerprint(after.data),
    rosterExecutionFingerprint(before.data),
  );
  assert.equal(after.data.sourceData.bundleId, signed.manifest.bundleId);
});

test("a degraded official-authority state is frozen into rosters and warned during validation", async () => {
  const reason =
    "No reviewed Games Workshop extractor was available for this explicit degraded release.";
  await activateSignedBuild(
    await buildRuntimeDataBundle({
      officialAuthority: {
        status: "unavailable",
        reason,
      },
      createdAt: "2026-07-30T03:00:00.000Z",
    }),
  );
  const roster = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Degraded authority provenance",
  });
  assert.ok(roster.data);
  assert.equal(
    roster.data.sourceData.official.authority?.status,
    "unavailable",
  );
  assert.equal(
    roster.warnings.some(
      (warning) =>
        warning.code === "OFFICIAL_AUTHORITY_UNAVAILABLE" &&
        warning.message === reason,
    ),
    true,
  );
});

test("runtime verification recomputes signed shard and compatibility semantics", async () => {
  const build = await buildRuntimeDataBundle({
    certification: certificationManifest,
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  const signing = await signer();

  const mislabeledShard = structuredClone(build);
  mislabeledShard.draft.shards[0].semanticHash = "f".repeat(64);
  const signedShard = await signRuntimeDataBundle(
    mislabeledShard,
    signing.signer,
  );
  const shardResult = await verifyRuntimeDataBundle({
    manifest: signedShard.manifest,
    shards: signedShard.shards,
    trustedKeys: signing.registry,
  });
  assert.equal(shardResult.ok, false);
  if (!shardResult.ok) {
    assert.equal(
      shardResult.code,
      "SHARD_SEMANTIC_HASH_MISMATCH",
    );
  }

  const mislabeledBundle = structuredClone(build);
  mislabeledBundle.draft.semanticHashes.factions[
    "adeptus-custodes"
  ].factionRulesHash = "e".repeat(64);
  const signedBundle = await signRuntimeDataBundle(
    mislabeledBundle,
    signing.signer,
  );
  const bundleResult = await verifyRuntimeDataBundle({
    manifest: signedBundle.manifest,
    shards: signedBundle.shards,
    trustedKeys: signing.registry,
  });
  assert.equal(bundleResult.ok, false);
  if (!bundleResult.ok) {
    assert.equal(
      bundleResult.code,
      "BUNDLE_SEMANTIC_HASH_MISMATCH",
    );
  }

  const malformedOfficialEvidence = structuredClone(build);
  const malformedGlobal = malformedOfficialEvidence.shards.find(
    (shard) => shard.shardId === "global",
  );
  assert.ok(
    malformedGlobal?.data.payloadKind ===
      "rosterpilot-runtime-global",
  );
  if (
    !malformedGlobal ||
    malformedGlobal.data.payloadKind !==
      "rosterpilot-runtime-global"
  ) {
    assert.fail("Expected a runtime global shard.");
  }
  malformedGlobal.data.officialEvidenceOverlay = {
    schemaVersion: 2,
  } as unknown as NonNullable<
    typeof malformedGlobal.data.officialEvidenceOverlay
  >;
  const malformedDescriptor =
    malformedOfficialEvidence.draft.shards.find(
      (descriptor) => descriptor.shardId === "global",
    );
  assert.ok(malformedDescriptor);
  malformedDescriptor.contentSha256 = await sha256Hex(
    canonicalJson(malformedGlobal),
  );
  malformedDescriptor.semanticHash = await semanticHash(
    malformedGlobal.data,
  );
  malformedDescriptor.byteLength = new TextEncoder().encode(
    canonicalJson(malformedGlobal),
  ).byteLength;
  const signedMalformedOfficialEvidence =
    await signRuntimeDataBundle(
      malformedOfficialEvidence,
      signing.signer,
    );
  const malformedOfficialResult = await verifyRuntimeDataBundle({
    manifest: signedMalformedOfficialEvidence.manifest,
    shards: signedMalformedOfficialEvidence.shards,
    trustedKeys: signing.registry,
  });
  assert.equal(malformedOfficialResult.ok, false);
  if (!malformedOfficialResult.ok) {
    assert.equal(
      malformedOfficialResult.code,
      "SHARD_IDENTITY_MISMATCH",
    );
  }
});

test("provenance churn reuses every shard and classifies without certification churn", async () => {
  const current = await buildRuntimeDataBundle({
    catalogue: {
      ...structuredClone(newRecruitCatalogueMappings),
      sources: {
        ...structuredClone(newRecruitCatalogueMappings.sources),
        newRecruit: {
          ...structuredClone(
            newRecruitCatalogueMappings.sources.newRecruit,
          ),
          commit:
            "419a80d35346cd9bf26d32f69b4a5df404beb95d",
        },
      },
    },
    certification: certificationManifest,
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  const catalogue = structuredClone(newRecruitCatalogueMappings);
  catalogue.releaseId = "metadata-only-refresh";
  catalogue.generatedAt = "2026-07-31T00:00:00.000Z";
  catalogue.sources.newRecruit.commit =
    "21b4efa69d7212cb206fdcbf98aa606ee49f78a2";
  catalogue.sources.official.checkedAt =
    "2026-07-31T00:00:00.000Z";
  const candidate = await buildRuntimeDataBundle({
    catalogue,
    catalogueSummary: {
      ...structuredClone(newRecruitCatalogue),
      releaseId: catalogue.releaseId,
      generatedAt: catalogue.generatedAt,
      sources: catalogue.sources,
    },
    certification: certificationManifest,
    createdAt: "2026-07-31T00:00:00.000Z",
  });

  assert.equal(
    Object.keys(current.draft.semanticHashes.factions).length,
    35,
  );
  assert.deepEqual(
    candidate.draft.semanticHashes,
    current.draft.semanticHashes,
  );
  assert.equal(
    candidate.shards.filter(
      (shard) =>
        shard.data.payloadKind ===
          "rosterpilot-runtime-faction" &&
        (
          shard.data.certification as
            | { id?: string }
            | null
        )?.id === shard.data.factionId,
    ).length,
    35,
  );
  assert.deepEqual(
    candidate.draft.shards.map((entry) => ({
      shardId: entry.shardId,
      contentSha256: entry.contentSha256,
    })),
    current.draft.shards.map((entry) => ({
      shardId: entry.shardId,
      contentSha256: entry.contentSha256,
    })),
  );
  assert.equal(
    classifyDataBundleDelta({
      current: current.draft,
      candidate: candidate.draft,
      factionDependencies: FACTION_DATA_DEPENDENCIES,
    }).classification,
    "provenance-only",
  );
});

test("a New Recruit game-system revision is mapping-only, not a global methodology change", async () => {
  const current = await buildRuntimeDataBundle({
    certification: certificationManifest,
  });
  const catalogue = structuredClone(newRecruitCatalogueMappings);
  const catalogueSummary = structuredClone(newRecruitCatalogue);
  catalogue.gameSystem.revision += 1;
  catalogueSummary.gameSystem.revision =
    catalogue.gameSystem.revision;

  const candidate = await buildRuntimeDataBundle({
    catalogue,
    catalogueSummary,
    certification: certificationManifest,
  });
  assert.equal(
    candidate.draft.semanticHashes.globalHash,
    current.draft.semanticHashes.globalHash,
  );
  assert.equal(
    candidate.draft.semanticHashes.methodologyHash,
    current.draft.semanticHashes.methodologyHash,
  );
  for (const factionId of Object.keys(
    current.draft.semanticHashes.factions,
  )) {
    const before = current.draft.semanticHashes.factions[factionId];
    const after = candidate.draft.semanticHashes.factions[factionId];
    assert.equal(after.factionRulesHash, before.factionRulesHash);
    assert.equal(after.portfolioHash, before.portfolioHash);
    assert.equal(after.conflictHash, before.conflictHash);
    assert.notEqual(after.mappingHash, before.mappingHash);
  }

  const delta = classifyDataBundleDelta({
    current: current.draft,
    candidate: candidate.draft,
    factionDependencies: FACTION_DATA_DEPENDENCIES,
  });
  assert.equal(delta.classification, "mapping-only");
  assert.equal(delta.requiresFullCertification, false);
  assert.equal(delta.directlyChangedFactions.length, 35);
  assert.equal(delta.affectedFactions.length, 35);
  assert.equal(
    delta.changedScopes.every(
      (scope) =>
        scope.endsWith(":mapping") ||
        scope.endsWith(":mapping-entities"),
    ),
    true,
  );
});

test("expert review rules evidence survives provenance-only activation and invalidates on signed rules changes", async () => {
  const reviewDocument = structuredClone(
    certificationManifestDocument,
  );
  const baseline = CertificationManifestSchema.parse(
    reviewDocument,
  );
  const baselineFaction = baseline.factions.find(
    (faction) => faction.id === "adeptus-custodes",
  );
  assert.ok(baselineFaction);
  const rawFaction = reviewDocument.factions.find(
    (faction: { id?: string }) =>
      faction.id === "adeptus-custodes",
  );
  assert.ok(rawFaction);
  const baselineBinding = certificationExpertReviewBinding(
    baseline,
    baselineFaction,
  );
  rawFaction.expertReview = {
    status: "reviewed",
    reviewedAt: "2026-07-31",
    assertions: [
      "The current Custodes rules and referenced entities were reviewed.",
    ],
    capabilityScopes: ["roster-rules"],
    binding: certificationExpertReviewBinding(
      baseline,
      {
        ...baselineFaction,
        expertReview: {
          ...baselineFaction.expertReview,
          capabilityScopes: ["roster-rules"],
        },
      },
    ),
  };

  await activateSignedBuild(
    await buildRuntimeDataBundle({
      createdAt: "2026-07-31T01:00:00.000Z",
    }),
  );
  const provenanceOnlyReview =
    CertificationManifestSchema.parse(reviewDocument).factions.find(
      (faction) => faction.id === "adeptus-custodes",
    )?.expertReview;
  assert.equal(provenanceOnlyReview?.status, "reviewed");

  const changedRules = structuredClone(originalRules);
  const changedUnit = changedRules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
        "adeptus-custodes" &&
      ((entry as { points?: unknown[] }).points?.length ?? 0) > 0,
  ) as { points: Array<{ cost: number }> } | undefined;
  assert.ok(changedUnit?.points[0]);
  changedUnit.points[0].cost += 5;
  await activateSignedBuild(
    await buildRuntimeDataBundle({
      rulesData: changedRules,
      createdAt: "2026-07-31T02:00:00.000Z",
    }),
  );
  const changedManifest = getActiveDataBundleManifest();
  assert.ok(changedManifest);
  const invalidatedReview =
    CertificationManifestSchema.parse(reviewDocument).factions.find(
      (faction) => faction.id === "adeptus-custodes",
    )?.expertReview;
  assert.equal(invalidatedReview?.status, "pending");
  if (
    invalidatedReview?.status === "pending" &&
    invalidatedReview.binding?.schemaVersion === 2
  ) {
    assert.equal(
      invalidatedReview.invalidationReason,
      "binding-mismatch",
    );
    assert.equal(
      invalidatedReview.binding.semanticEvidence
        .runtimeFactionRulesSha256,
      changedManifest.semanticHashes.factions["adeptus-custodes"]
        .factionRulesHash,
    );
    assert.notEqual(
      invalidatedReview.binding.semanticEvidence
        .rosterRulesSha256,
      baselineBinding.semanticEvidence.rosterRulesSha256,
    );
  }
});

test("deterministic certification reads the live runtime faction inventory", async () => {
  const reducedRules = structuredClone(originalRules);
  reducedRules.factions = reducedRules.factions.filter(
    (entry) =>
      (entry as { id?: string }).id !== "adeptus-custodes",
  );
  activateRuntimeRulesData(reducedRules);
  await assert.rejects(
    runDeterministicCertification(
      certificationManifestDocument,
      { factionId: "aeldari" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "CERTIFICATION_FACTION_COVERAGE_DRIFT",
  );
});

test("signed faction shards retain official reconciliation conflicts and coverage identity", async () => {
  const rules = serializeRuntimeRulesData();
  const unit = rules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
        "adeptus-custodes" &&
      ((entry as { points?: unknown[] }).points?.length ?? 0) > 0,
  ) as
    | {
        id: string;
        faction_id: string;
        points: Array<{
          models: number;
          cost: number;
          unit_count_min: number;
          unit_count_max: number | null;
        }>;
      }
    | undefined;
  assert.ok(unit);
  const unitPoints = [
    {
      factionId: unit.faction_id,
      unitId: unit.id,
      tiers: unit.points.map((tier, index) => ({
        ...tier,
        cost: tier.cost + (index === 0 ? 5 : 0),
      })),
    },
  ];
  const emptyHash = await semanticHash([]);
  const overlay = {
    schemaVersion: 1 as const,
    authority: "games-workshop" as const,
    source: {
      version:
        newRecruitCatalogueMappings.sources.official.mfmVersion,
      contentSha256:
        newRecruitCatalogueMappings.sources.official.contentSha256,
      url: newRecruitCatalogueMappings.sources.official.mfmUrl,
      extractedAt: "2026-07-30T00:00:00.000Z",
      extractor: "rosterpilot-runtime-test",
      extractorVersion: "1",
    },
    coverage: {
      unitPoints: {
        status: "complete" as const,
        sourceEntityCount: 1,
        extractedEntityCount: 1,
        payloadSha256: await semanticHash(unitPoints),
      },
      leaderLinks: {
        status: "not-published" as const,
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: emptyHash,
      },
      detachments: {
        status: "not-published" as const,
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: emptyHash,
      },
      enhancementPoints: {
        status: "not-published" as const,
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: emptyHash,
      },
    },
    unitPoints,
    leaderLinks: [],
    detachments: [],
    enhancementPoints: [],
  };
  const baseline = await buildRuntimeDataBundle({ rulesData: rules });
  const reconciled = await buildRuntimeDataBundle({
    rulesData: rules,
    officialOverlay: overlay,
  });
  const factionShard = reconciled.shards.find(
    (shard) => shard.shardId === "faction:adeptus-custodes",
  );
  assert.equal(
    factionShard?.data.payloadKind,
    "rosterpilot-runtime-faction",
  );
  if (
    factionShard?.data.payloadKind !==
    "rosterpilot-runtime-faction"
  ) {
    assert.fail("Expected a Custodes faction shard.");
  }
  assert.equal(factionShard.data.officialConflicts.length, 1);
  assert.equal(
    factionShard.data.officialOverlayHash,
    reconciled.officialReconciliation?.overlayHash,
  );
  assert.notEqual(
    reconciled.draft.semanticHashes.factions[
      "adeptus-custodes"
    ].conflictHash,
    baseline.draft.semanticHashes.factions[
      "adeptus-custodes"
    ].conflictHash,
  );
});

test("one faction rules change affects only its dependency scope", async () => {
  const current = await buildRuntimeDataBundle({
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  const rules = serializeRuntimeRulesData();
  const unit = rules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
      "adeptus-custodes",
  ) as
    | {
        points?: Array<{ cost: number }>;
      }
    | undefined;
  assert.ok(unit?.points?.[0]);
  unit.points[0].cost += 5;
  const candidate = await buildRuntimeDataBundle({
    rulesData: rules,
    createdAt: "2026-07-31T00:00:00.000Z",
  });

  const currentHashes = new Map(
    current.draft.shards.map((entry) => [
      entry.shardId,
      entry.contentSha256,
    ]),
  );
  const changedShards = candidate.draft.shards
    .filter(
      (entry) =>
        currentHashes.get(entry.shardId) !== entry.contentSha256,
    )
    .map((entry) => entry.shardId);
  assert.deepEqual(changedShards, [
    "faction:adeptus-custodes",
  ]);

  const delta = classifyDataBundleDelta({
    current: current.draft,
    candidate: candidate.draft,
    factionDependencies: FACTION_DATA_DEPENDENCIES,
  });
  assert.equal(delta.classification, "rules");
  assert.deepEqual(delta.directlyChangedFactions, [
    "adeptus-custodes",
  ]);
  assert.deepEqual(delta.affectedFactions, [
    "adeptus-custodes",
  ]);
  assert.equal(delta.requiresFullCertification, false);
});

test("a failed faction retains its verified dependency component while safe shards advance", async () => {
  const previousBuild = await buildRuntimeDataBundle({
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  const rules = serializeRuntimeRulesData();
  for (const factionId of [
    "aeldari",
    "adeptus-custodes",
  ]) {
    const unit = rules.units.find(
      (entry) =>
        (entry as { faction_id?: string }).faction_id ===
        factionId,
    ) as
      | {
          points?: Array<{ cost: number }>;
        }
      | undefined;
    assert.ok(unit?.points?.[0]);
    unit.points[0].cost += 5;
  }
  const candidate = await buildRuntimeDataBundle({
    rulesData: rules,
    createdAt: "2026-07-31T00:00:00.000Z",
  });
  const signing = await signer();
  const previousSigned = await signRuntimeDataBundle(
    previousBuild,
    signing.signer,
  );
  const previous = await verifyRuntimeDataBundle({
    manifest: previousSigned.manifest,
    shards: previousSigned.shards,
    trustedKeys: signing.registry,
  });
  if (!previous.ok) {
    assert.fail(`Previous runtime bundle failed verification: ${previous.message}`);
  }

  const composed =
    await composeRuntimeDataBundleRetainingVerifiedShards({
      candidate,
      previous: previous.data,
      quarantinedFactions: [
        {
          factionId: "aeldari",
          scopes: ["faction:aeldari:certification"],
          reason: "Aeldari deterministic certification regressed.",
        },
      ],
    });
  assert.deepEqual(
    composed.draft.composition?.retainedShards.map(
      (entry) => entry.shardId,
    ),
    ["faction:aeldari", "faction:drukhari"],
    "a shared-library dependant must remain on the same verified component",
  );
  assert.equal(
    composed.draft.semanticHashes.factions.aeldari
      .factionRulesHash,
    previousBuild.draft.semanticHashes.factions.aeldari
      .factionRulesHash,
  );
  assert.equal(
    composed.draft.semanticHashes.factions.drukhari
      .factionRulesHash,
    previousBuild.draft.semanticHashes.factions.drukhari
      .factionRulesHash,
  );
  assert.equal(
    composed.draft.semanticHashes.factions[
      "adeptus-custodes"
    ].factionRulesHash,
    candidate.draft.semanticHashes.factions[
      "adeptus-custodes"
    ].factionRulesHash,
  );
  assert.equal(
    composed.draft.composition?.candidateDraftSha256,
    await sha256Hex(canonicalJson(candidate.draft)),
  );

  const delta = classifyDataBundleDelta({
    current: previousBuild.draft,
    candidate: composed.draft,
    factionDependencies: FACTION_DATA_DEPENDENCIES,
  });
  assert.equal(delta.classification, "rules");
  assert.deepEqual(delta.affectedFactions, [
    "adeptus-custodes",
  ]);

  const signed = await signRuntimeDataBundle(
    composed,
    signing.signer,
  );
  const verified = await verifyRuntimeDataBundle({
    manifest: signed.manifest,
    shards: signed.shards,
    trustedKeys: signing.registry,
  });
  if (!verified.ok) {
    assert.fail(`Composed runtime bundle failed verification: ${verified.message}`);
  }
  assert.deepEqual(
    verified.data.getFactionShard("aeldari")?.data,
    previous.data.getFactionShard("aeldari")?.data,
  );
  assert.notDeepEqual(
    verified.data.getFactionShard("adeptus-custodes")
      ?.data,
    previous.data.getFactionShard("adeptus-custodes")
      ?.data,
  );
  const tamperedLineage = structuredClone(signed.manifest);
  if (!tamperedLineage.composition) {
    assert.fail("Expected signed retained-shard lineage.");
  }
  tamperedLineage.composition.retainedShards[0].sourceBundleId =
    "f".repeat(64);
  const tamperedResult = await verifyDataBundleManifest(
    tamperedLineage,
    signing.registry,
  );
  assert.equal(tamperedResult.ok, false);
  if (!tamperedResult.ok) {
    assert.equal(tamperedResult.code, "BUNDLE_ID_MISMATCH");
  }

  const globalCandidate = structuredClone(candidate);
  globalCandidate.draft.semanticHashes.globalHash = "f".repeat(64);
  await assert.rejects(
    composeRuntimeDataBundleRetainingVerifiedShards({
      candidate: globalCandidate,
      previous: previous.data,
      quarantinedFactions: [
        {
          factionId: "aeldari",
          reason: "Cannot localize a global regression.",
        },
      ],
    }),
    /Partial faction roll-forward is unsafe/,
  );
});
