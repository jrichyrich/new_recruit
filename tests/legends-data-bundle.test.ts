import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  newRecruitCatalogueMappings,
} from "../lib/rosterpilot/catalogue";
import {
  activateRuntimeDataBundle,
  buildRuntimeDataBundle,
  buildRuntimeDataBundleWithRetainedOfficialEvidence,
  signRuntimeDataBundle,
  verifyRuntimeDataBundle,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  RemoteRuntimeDataBundleProvider,
} from "../lib/rosterpilot/remote-data-bundle-provider";
import {
  applyOfficialRulesOverlay,
  createOfficialExtractionReceiptDraftV2,
  verifyOfficialPublicationEvidence,
  verifyOfficialRulesOverlayV2Coverage,
  type OfficialExtractionReceiptDraftV2,
  type OfficialRulesOverlayV2,
} from "../lib/rosterpilot/official-data";
import {
  activeFactionLegendsState,
  resetActiveLegendsInventoryForTests,
} from "../lib/rosterpilot/legends";
import {
  buildRoster,
  exportRoster,
  getDataStatus,
  modifyRoster,
  searchUnits,
  validateRoster,
} from "../lib/rosterpilot/engine";
import {
  serializeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
} from "../lib/rosterpilot/semantic-hash";

type RawUnit = {
  id: string;
  faction_id: string;
  name: string;
  profiles?: unknown[];
  weapon_ids?: string[];
  points: Array<{
    models: number;
    cost: number;
    unit_count_min: number;
    unit_count_max: number | null;
  }>;
  is_legend?: boolean;
};

afterEach(() => {
  resetActiveLegendsInventoryForTests();
});

function base64Url(value: ArrayBuffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function fixtureUnits() {
  const rules = serializeRuntimeRulesData();
  const aeldari = rules.units.find(
    (entry) =>
      (entry as RawUnit).faction_id === "aeldari" &&
      ((entry as RawUnit).points?.length ?? 0) > 0 &&
      (entry as RawUnit).points.every(
        (tier) =>
          typeof tier.unit_count_min === "number" &&
          (typeof tier.unit_count_max === "number" ||
            tier.unit_count_max === null),
      ),
  ) as RawUnit | undefined;
  const custodes = rules.units.find(
    (entry) =>
      (entry as RawUnit).faction_id === "adeptus-custodes" &&
      ((entry as RawUnit).points?.length ?? 0) > 0,
  ) as RawUnit | undefined;
  const unsupportedAeldari = rules.units.find(
    (entry) => {
      const unit = entry as RawUnit;
      return (
        unit.faction_id === "aeldari" &&
        unit.id !== aeldari?.id &&
        (unit.points?.length ?? 0) > 0 &&
        (
          !Array.isArray(unit.profiles) ||
          unit.profiles.length === 0 ||
          !Array.isArray(unit.weapon_ids) ||
          !rules.unitCompositions.some(
            (composition) =>
              (composition as { unit_id?: string }).unit_id ===
              unit.id,
          )
        )
      );
    },
  ) as RawUnit | undefined;
  assert.ok(aeldari);
  assert.ok(custodes);
  assert.ok(unsupportedAeldari);
  return { rules, aeldari, custodes, unsupportedAeldari };
}

async function overlayFixture(input: {
  primaryArtifact: Uint8Array;
  aeldariPack: Uint8Array;
  custodesPack: Uint8Array;
  includeMatchedLegend?: boolean;
}): Promise<OfficialRulesOverlayV2> {
  const { aeldari, unsupportedAeldari } = await fixtureUnits();
  const unitPoints = [
    {
      factionId: aeldari.faction_id,
      unitId: aeldari.id,
      tiers: structuredClone(aeldari.points),
    },
  ];
  const legendUnits = input.includeMatchedLegend === false
    ? []
    : [
        {
          legendId: "aeldari-fixture-legend",
          factionId: "aeldari",
          name: aeldari.name,
          unitId: aeldari.id,
          sourceId: "aeldari-pack",
          datasheetUrl:
            "https://assets.warhammer-community.com/aeldari-fixture.pdf",
        },
        {
          legendId: "aeldari-inventory-only",
          factionId: "aeldari",
          name: "Inventory-only Aeldari Fixture",
          unitId: null,
          sourceId: "aeldari-pack",
        },
        {
          legendId: "aeldari-mapped-incomplete",
          factionId: "aeldari",
          name: unsupportedAeldari.name,
          unitId: unsupportedAeldari.id,
          sourceId: "aeldari-pack",
        },
      ];
  const legendFactionCoverage = [
    {
      factionId: "aeldari",
      sourceIds: ["aeldari-pack"],
      status: "complete" as const,
      sourceEntityCount: legendUnits.length,
      extractedEntityCount: legendUnits.length,
      payloadSha256: await semanticHash(legendUnits),
    },
    {
      factionId: "adeptus-custodes",
      sourceIds: ["custodes-pack"],
      status: "not-published" as const,
      sourceEntityCount: 0,
      extractedEntityCount: 0,
      payloadSha256: await semanticHash([]),
    },
  ];
  const emptyHash = await semanticHash([]);
  return verifyOfficialRulesOverlayV2Coverage({
    schemaVersion: 2,
    authority: "games-workshop",
    gameEdition: "11th",
    source: {
      version: "fixture-mfm-v2",
      contentSha256: await sha256Hex(input.primaryArtifact),
      url: "https://assets.warhammer-community.com/mfm-fixture.pdf",
      extractedAt: "2026-08-01T00:00:00.000Z",
      extractor: "rosterpilot-legends-fixture",
      extractorVersion: "2",
    },
    legendSources: [
      {
        sourceId: "aeldari-pack",
        factionId: "aeldari",
        factionName: "Aeldari",
        documentKind: "faction-pack",
        gameEdition: "11th",
        version: "2026-08-01",
        legalFrom: "2026-06-20",
        contentSha256: await sha256Hex(input.aeldariPack),
        url: "https://assets.warhammer-community.com/aeldari-fixture.pdf",
        extractedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        sourceId: "custodes-pack",
        factionId: "adeptus-custodes",
        factionName: "Adeptus Custodes",
        documentKind: "faction-pack",
        gameEdition: "11th",
        version: "2026-08-01",
        legalFrom: "2026-06-20",
        contentSha256: await sha256Hex(input.custodesPack),
        url: "https://assets.warhammer-community.com/custodes-fixture.pdf",
        extractedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    coverage: {
      unitPoints: {
        status: "complete",
        sourceEntityCount: unitPoints.length,
        extractedEntityCount: unitPoints.length,
        payloadSha256: await semanticHash(unitPoints),
      },
      leaderLinks: {
        status: "not-published",
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: emptyHash,
      },
      detachments: {
        status: "not-published",
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: emptyHash,
      },
      enhancementPoints: {
        status: "not-published",
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: emptyHash,
      },
      legendUnits: {
        status: "complete",
        sourceEntityCount: legendUnits.length,
        extractedEntityCount: legendUnits.length,
        payloadSha256: await semanticHash(legendUnits),
      },
      legendFactionCoverage: {
        status: "complete",
        sourceEntityCount: legendFactionCoverage.length,
        extractedEntityCount: legendFactionCoverage.length,
        payloadSha256: await semanticHash(
          legendFactionCoverage,
        ),
      },
    },
    unitPoints,
    leaderLinks: [],
    detachments: [],
    enhancementPoints: [],
    legendFactionCoverage,
    legendUnits,
  });
}

async function extractorTrustFixture() {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  return {
    keys,
    registry: {
      schemaVersion: 1 as const,
      extractors: [
        {
          extractorId: "rosterpilot-legends-fixture",
          keyId: "legends-fixture-key",
          publicKey: await crypto.subtle.exportKey(
            "jwk",
            keys.publicKey,
          ),
          status: "trusted" as const,
          reviewedAt: "2026-08-01T00:00:00.000Z",
          reviewReference: "legends-fixture-review",
        },
      ],
    },
  };
}

async function signExtractionReceipt(
  draft: OfficialExtractionReceiptDraftV2,
  privateKey: CryptoKey,
) {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(canonicalJson(draft)),
  );
  return {
    ...structuredClone(draft),
    signature: {
      algorithm: "Ed25519" as const,
      keyId: "legends-fixture-key",
      value: base64Url(signature),
    },
  };
}

async function runtimeSigner() {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  return {
    signer: {
      keyId: "legends-runtime-key",
      privateKey: keys.privateKey,
    },
    registry: {
      "legends-runtime-key": keys.publicKey,
    },
  };
}

test("official V2 Legends evidence binds every faction-pack artifact and preserves inventory-only entries", async () => {
  const primaryArtifact = new TextEncoder().encode("fixture-mfm");
  const aeldariPack = new TextEncoder().encode("fixture-aeldari-pack");
  const custodesPack = new TextEncoder().encode("fixture-custodes-pack");
  const overlay = await overlayFixture({
    primaryArtifact,
    aeldariPack,
    custodesPack,
  });
  const trust = await extractorTrustFixture();
  const draft = await createOfficialExtractionReceiptDraftV2(
    overlay,
    primaryArtifact,
    {
      "aeldari-pack": aeldariPack,
      "custodes-pack": custodesPack,
    },
    "2026-08-01T01:00:00.000Z",
  );
  assert.deepEqual(
    {
      factionName: draft.legendSources[0].factionName,
      documentKind: draft.legendSources[0].documentKind,
      gameEdition: draft.legendSources[0].gameEdition,
      legalFrom: draft.legendSources[0].legalFrom,
    },
    {
      factionName: "Aeldari",
      documentKind: "faction-pack",
      gameEdition: "11th",
      legalFrom: "2026-06-20",
    },
  );
  const receipt = await signExtractionReceipt(
    draft,
    trust.keys.privateKey,
  );
  const verified = await verifyOfficialPublicationEvidence({
    overlay,
    sourceArtifact: primaryArtifact,
    legendSourceArtifacts: {
      "aeldari-pack": aeldariPack,
      "custodes-pack": custodesPack,
    },
    extractionReceipt: receipt,
    trustedExtractors: trust.registry,
  });
  assert.equal(verified.overlay.schemaVersion, 2);
  assert.equal(
    verified.legendSourceArtifactSha256["aeldari-pack"],
    await sha256Hex(aeldariPack),
  );

  await assert.rejects(
    verifyOfficialPublicationEvidence({
      overlay,
      sourceArtifact: primaryArtifact,
      legendSourceArtifacts: {
        "aeldari-pack": new TextEncoder().encode("tampered"),
        "custodes-pack": custodesPack,
      },
      extractionReceipt: receipt,
      trustedExtractors: trust.registry,
    }),
    /exact faction-pack artifact aeldari-pack/,
  );

  const { rules, aeldari, custodes } = await fixtureUnits();
  const staleCommunityRules = structuredClone(rules);
  const staleCommunityCustodes = staleCommunityRules.units.find(
    (unit) => (unit as RawUnit).id === custodes.id,
  ) as RawUnit;
  staleCommunityCustodes.is_legend = true;
  const applied = await applyOfficialRulesOverlay(
    staleCommunityRules,
    overlay,
  );
  const appliedAeldari = applied.rulesData.units.find(
    (unit) => (unit as RawUnit).id === aeldari.id,
  ) as RawUnit;
  const appliedCustodes = applied.rulesData.units.find(
    (unit) => (unit as RawUnit).id === custodes.id,
  ) as RawUnit;
  assert.equal(appliedAeldari.is_legend, true);
  assert.equal(appliedCustodes.is_legend, false);
  assert.equal(applied.legendInventory.length, 3);
  assert.equal(applied.legendInventory[1].unitId, null);
});

test("official Legends evidence rejects standalone-document metadata and cross-edition activation", async () => {
  const primaryArtifact = new TextEncoder().encode("metadata-mfm");
  const aeldariPack = new TextEncoder().encode("metadata-aeldari-pack");
  const custodesPack = new TextEncoder().encode("metadata-custodes-pack");
  const overlay = await overlayFixture({
    primaryArtifact,
    aeldariPack,
    custodesPack,
  });

  const missingKind = structuredClone(overlay) as unknown as {
    legendSources: Array<Record<string, unknown>>;
  };
  delete missingKind.legendSources[0].documentKind;
  await assert.rejects(
    verifyOfficialRulesOverlayV2Coverage(missingKind),
    /documentKind/,
  );

  const mixedEdition = structuredClone(overlay);
  mixedEdition.legendSources[0].gameEdition = "10th";
  await assert.rejects(
    verifyOfficialRulesOverlayV2Coverage(mixedEdition),
    /targets 10th, not overlay edition 11th/,
  );

  const staleEdition = structuredClone(overlay);
  staleEdition.gameEdition = "10th";
  for (const source of staleEdition.legendSources) {
    source.gameEdition = "10th";
  }
  const catalogue = structuredClone(newRecruitCatalogueMappings);
  catalogue.sources.official.mfmVersion = staleEdition.source.version;
  catalogue.sources.official.contentSha256 =
    staleEdition.source.contentSha256;
  await assert.rejects(
    buildRuntimeDataBundle({
      catalogue,
      officialOverlay: staleEdition,
      createdAt: "2026-08-01T02:00:00.000Z",
    }),
    /overlay edition 10th does not match runtime rules edition 11th/,
  );
});

test("runtime bundle V2 freezes faction Legends inventory and semantic classification while V1 remains readable", async () => {
  const primaryArtifact = new TextEncoder().encode("runtime-mfm");
  const aeldariPack = new TextEncoder().encode("runtime-aeldari-pack");
  const custodesPack = new TextEncoder().encode("runtime-custodes-pack");
  const withLegend = await overlayFixture({
    primaryArtifact,
    aeldariPack,
    custodesPack,
  });
  const withoutLegend = await overlayFixture({
    primaryArtifact,
    aeldariPack,
    custodesPack,
    includeMatchedLegend: false,
  });
  const catalogue = structuredClone(newRecruitCatalogueMappings);
  catalogue.sources.official.mfmVersion = withLegend.source.version;
  catalogue.sources.official.contentSha256 =
    withLegend.source.contentSha256;
  const authority = {
    status: "verified" as const,
    sourceArtifactSha256: withLegend.source.contentSha256,
    overlaySha256: await semanticHash(withLegend),
    receiptSha256: "b".repeat(64),
    extractorId: withLegend.source.extractor,
    extractorKeyId: "legends-fixture-key",
  };
  const build = await buildRuntimeDataBundle({
    catalogue,
    officialOverlay: withLegend,
    officialAuthority: authority,
    createdAt: "2026-08-01T02:00:00.000Z",
  });
  const aeldariShard = build.shards.find(
    (shard) => shard.shardId === "faction:aeldari",
  );
  assert.equal(aeldariShard?.data.schemaVersion, 2);
  if (
    !aeldariShard ||
    aeldariShard.data.payloadKind !==
      "rosterpilot-runtime-faction" ||
    aeldariShard.data.schemaVersion !== 2
  ) {
    assert.fail("Expected a runtime faction V2 shard.");
  }
  assert.equal(aeldariShard.data.legends.coverageStatus, "complete");
  assert.equal(aeldariShard.data.legends.units.length, 3);
  assert.equal(
    aeldariShard.data.legends.units[1].buildSupported,
    false,
  );
  assert.equal(
    aeldariShard.data.legends.units[2].buildSupported,
    false,
  );

  const comparison = await buildRuntimeDataBundle({
    catalogue,
    officialOverlay: withoutLegend,
    officialAuthority: {
      ...authority,
      overlaySha256: await semanticHash(withoutLegend),
    },
    createdAt: "2026-08-01T02:00:00.000Z",
  });
  assert.notEqual(
    build.draft.semanticHashes.factions.aeldari
      .factionRulesHash,
    comparison.draft.semanticHashes.factions.aeldari
      .factionRulesHash,
  );
  assert.equal(
    build.draft.semanticHashes.factions["adeptus-custodes"]
      .factionRulesHash,
    comparison.draft.semanticHashes.factions["adeptus-custodes"]
      .factionRulesHash,
  );

  const signing = await runtimeSigner();
  const signed = await signRuntimeDataBundle(build, signing.signer);
  const verified = await verifyRuntimeDataBundle({
    manifest: signed.manifest,
    shards: signed.shards,
    trustedKeys: signing.registry,
  });
  if (!verified.ok) assert.fail(verified.message);
  assert.equal(verified.ok, true);
  const carried =
    await buildRuntimeDataBundleWithRetainedOfficialEvidence(
      {
        catalogue,
        createdAt: "2026-08-01T02:30:00.000Z",
      },
      verified.data,
    );
  const carriedGlobal = carried.shards.find(
    (shard) => shard.shardId === "global",
  );
  const carriedAeldari = carried.shards.find(
    (shard) => shard.shardId === "faction:aeldari",
  );
  assert.equal(
    carriedGlobal?.data.payloadKind ===
      "rosterpilot-runtime-global" &&
      carriedGlobal.data.officialEvidenceOverlay?.schemaVersion,
    2,
  );
  assert.equal(
    carriedAeldari?.data.payloadKind ===
      "rosterpilot-runtime-faction" &&
      carriedAeldari.data.schemaVersion === 2 &&
      carriedAeldari.data.legends.coverageStatus,
    "complete",
  );
  activateRuntimeDataBundle(verified.data);
  assert.equal(
    activeFactionLegendsState("aeldari").classificationAuthority,
    "games-workshop-verified",
  );
  const currentStatus = getDataStatus();
  assert.ok(currentStatus.data);
  assert.equal(
    currentStatus.data.legends.factionCoverage.complete,
    1,
  );
  assert.equal(
    currentStatus.data.legends.factionCoverage.notPublished,
    1,
  );
  assert.equal(
    currentStatus.data.legends.classificationAuthority.verified,
    2,
  );
  assert.equal(currentStatus.data.legends.inventoryUnits, 3);
  assert.equal(currentStatus.data.legends.buildSupportedUnits, 1);
  assert.equal(currentStatus.data.legends.inventoryOnlyUnits, 2);
  const mappedIncompleteLegend = withLegend.legendUnits.find(
    (unit) => unit.legendId === "aeldari-mapped-incomplete",
  );
  assert.ok(mappedIncompleteLegend?.unitId);
  const mappedIncompleteSearch = searchUnits({
    faction: "aeldari",
    query: mappedIncompleteLegend.name,
    includeLegends: true,
  });
  assert.equal(mappedIncompleteSearch.data?.length, 1);
  assert.equal(mappedIncompleteSearch.data?.[0].pointsKnown, false);
  assert.equal(
    mappedIncompleteSearch.data?.[0].legendBuildSupported,
    false,
  );
  assert.deepEqual(
    mappedIncompleteSearch.data?.[0].legendProvenance,
    {
      classificationAuthority: "games-workshop-verified",
      sourceId: "aeldari-pack",
      version: "2026-08-01",
      contentSha256: await sha256Hex(aeldariPack),
      url: "https://assets.warhammer-community.com/aeldari-fixture.pdf",
    },
  );
  const mappedIncompleteBuild = buildRoster({
    faction: "aeldari",
    pointsLimit: 1_000,
    legendsPolicy: "allow",
    requiredUnitIds: [mappedIncompleteLegend.unitId],
  });
  assert.ok(
    mappedIncompleteBuild.violations.some(
      (violation) =>
        violation.code === "LEGENDS_BUILD_SUPPORT_UNAVAILABLE",
    ),
  );
  const buildSupportedLegend = withLegend.legendUnits.find(
    (unit) => unit.unitId !== null,
  );
  assert.ok(buildSupportedLegend?.unitId);
  const buildSupportedSearch = searchUnits({
    faction: "aeldari",
    query: buildSupportedLegend.name,
    includeLegends: true,
  });
  const buildSupportedSummary = buildSupportedSearch.data?.find(
    (unit) => unit.id === buildSupportedLegend.unitId,
  );
  assert.deepEqual(buildSupportedSummary?.legendProvenance, {
    classificationAuthority: "games-workshop-verified",
    sourceId: "aeldari-pack",
    version: "2026-08-01",
    contentSha256: await sha256Hex(aeldariPack),
    url: "https://assets.warhammer-community.com/aeldari-fixture.pdf",
    datasheetUrl:
      "https://assets.warhammer-community.com/aeldari-fixture.pdf",
  });
  const legendsRoster = buildRoster({
    faction: "aeldari",
    pointsLimit: 1_000,
    legendsPolicy: "allow",
    requiredUnitIds: [buildSupportedLegend.unitId],
  });
  assert.ok(
    legendsRoster.data,
    legendsRoster.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  assert.ok(
    legendsRoster.warnings.some(
      (warning) => warning.code === "LEGENDS_INCLUDED",
    ),
  );
  const missingPolicyDecision = structuredClone(legendsRoster.data);
  delete missingPolicyDecision.constraints.legendsPolicyDecision;
  assert.ok(
    validateRoster(missingPolicyDecision).violations.some(
      (violation) =>
        violation.code === "LEGENDS_POLICY_STATE_MISSING",
    ),
  );
  const modifiedWithIncompleteLegend = modifyRoster(
    legendsRoster.data,
    {
      type: "add",
      unitId: mappedIncompleteLegend.unitId,
    },
  );
  assert.ok(
    modifiedWithIncompleteLegend.violations.some(
      (violation) =>
        violation.code === "LEGENDS_BUILD_SUPPORT_UNAVAILABLE",
    ),
  );
  const textExport = await exportRoster(legendsRoster.data, "text");
  const htmlExport = await exportRoster(legendsRoster.data, "html");
  assert.ok(textExport.data);
  assert.ok(htmlExport.data);
  assert.match(textExport.data.content as string, /\[Legends\]/);
  assert.match(htmlExport.data.content as string, />Legends</);

  const legacy = await buildRuntimeDataBundle({
    engineDataSchemaVersion: 1,
    createdAt: "2026-08-01T03:00:00.000Z",
  });
  assert.equal(
    legacy.shards.every((shard) => shard.data.schemaVersion === 1),
    true,
  );
  const legacySigned = await signRuntimeDataBundle(
    legacy,
    signing.signer,
  );
  const legacyVerified = await verifyRuntimeDataBundle({
    manifest: legacySigned.manifest,
    shards: legacySigned.shards,
    trustedKeys: signing.registry,
  });
  if (!legacyVerified.ok) assert.fail(legacyVerified.message);
  assert.equal(legacyVerified.ok, true);
  activateRuntimeDataBundle(legacyVerified.data);
  assert.equal(
    activeFactionLegendsState("aeldari").coverageStatus,
    "unavailable",
  );
  const legacyStatus = getDataStatus();
  assert.ok(legacyStatus.data);
  assert.equal(
    legacyStatus.data.legends.factionCoverage.complete,
    0,
  );
  assert.equal(
    legacyStatus.data.legends.factionCoverage.unavailable,
    legacyStatus.data.factionCount,
  );
  assert.equal(legacyStatus.data.legends.inventoryUnits, 0);
});

test("runtime provider accepts verified schema V1 and V2 snapshots", async () => {
  const signing = await runtimeSigner();
  for (const engineDataSchemaVersion of [1, 2] as const) {
    const build = await buildRuntimeDataBundle({
      engineDataSchemaVersion,
      createdAt: `2026-08-01T0${engineDataSchemaVersion}:00:00.000Z`,
    });
    const signed = await signRuntimeDataBundle(
      build,
      signing.signer,
    );
    const verified = await verifyRuntimeDataBundle({
      manifest: signed.manifest,
      shards: signed.shards,
      trustedKeys: signing.registry,
    });
    if (!verified.ok) assert.fail(verified.message);
    const provider = new RemoteRuntimeDataBundleProvider({
      bootstrap: verified.data,
      trustedKeys: signing.registry,
      activate: () => undefined,
    });
    await provider.initialize({ refresh: false });
    const lease = await provider.acquireSnapshot({
      factionIds: ["aeldari"],
    });
    assert.equal(
      lease.snapshot.manifest.engineDataSchemaVersion,
      engineDataSchemaVersion,
    );
    assert.equal(
      lease.snapshot.getFactionShard("aeldari")?.data
        .schemaVersion,
      engineDataSchemaVersion,
    );
    await lease.release();
    provider.stopPeriodicRefresh();
  }
});
