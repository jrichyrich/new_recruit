import assert from "node:assert/strict";
import test from "node:test";

import {
  DataBundleManifestDraftV1Schema,
  createDataBundleSnapshot,
  createSignedDataBundleChannelPointer,
  createSignedDataBundleManifest,
  verifyDataBundleChannelPointer,
  verifyDataBundleManifest,
  verifyDataBundleShard,
  type DataBundleManifestDraftV1,
  type DataBundleShardV1,
  type DataBundleSigner,
} from "../lib/rosterpilot/data-bundle";
import {
  canonicalJson,
  canonicalSemanticJson,
  classifyDataBundleDelta,
  semanticHash,
  sha256Hex,
  type DataBundleComparableIdentity,
  type DataBundleSemanticHashesV1,
} from "../lib/rosterpilot/semantic-hash";

const digest = (character: string): string => character.repeat(64);

function semanticInventory(): DataBundleSemanticHashesV1 {
  return {
    globalHash: digest("1"),
    methodologyHash: digest("2"),
    factions: {
      "space-marines": {
        factionRulesHash: digest("3"),
        mappingHash: digest("4"),
        portfolioHash: digest("5"),
        conflictHash: digest("6"),
        entityHashes: {
          "unit:intercessor-squad": digest("7"),
        },
      },
      "space-wolves": {
        factionRulesHash: digest("8"),
        mappingHash: digest("9"),
        portfolioHash: digest("a"),
        conflictHash: digest("b"),
        entityHashes: {
          "unit:grey-hunters": digest("c"),
        },
      },
    },
  };
}

async function keyPair(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
}

function signer(
  pair: CryptoKeyPair,
  keyId = "release-2026",
): DataBundleSigner {
  return {
    keyId,
    privateKey: pair.privateKey,
  };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

async function bundleFixture() {
  const globalShard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "global",
    kind: "global",
    factionIds: [],
    data: {
      gameSystem: "Warhammer 40,000 11th Edition",
      rules: ["core"],
    },
  };
  const marinesShard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "faction:space-marines",
    kind: "faction",
    factionIds: ["space-marines", "space-wolves"],
    data: {
      rules: {
        "space-marines": ["intercessor-squad"],
        "space-wolves": ["grey-hunters"],
      },
      newRecruit: {
        full: { mappedUnits: 2 },
        summary: { mappedUnits: 2 },
      },
    },
  };
  const draft: DataBundleManifestDraftV1 = {
    schemaVersion: 1,
    engineDataSchemaVersion: 1,
    createdAt: "2026-07-31T12:00:00.000Z",
    provenance: {
      official: {
        authority: "games-workshop",
        version: "1.1",
        contentSha256: digest("d"),
        downloadsUrl:
          "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
        dataUrl: "https://mfm.warhammer-community.com/en",
        publishedAt: "2026-07-22T00:00:00.000Z",
        checkedAt: "2026-07-31T11:59:00.000Z",
      },
      rules: {
        provider: "40kdc-data",
        package: "@alpaca-software/40kdc-data",
        version: "1.2.1",
        sourceSha256: digest("e"),
        edition: "11th",
        dataslate: "launch",
      },
      newRecruit: {
        provider: "bsdata",
        repository: "BSData/wh40k-11e",
        branch: "main",
        commit: "21b4efa69d7212cb206fdcbf98aa606ee49f78a2",
      },
    },
    semanticHashes: semanticInventory(),
    shards: [
      {
        shardId: "global",
        kind: "global",
        factionIds: [],
        dependencyShardIds: [],
        path: "shards/global.json",
        contentSha256: await sha256Hex(canonicalJson(globalShard)),
        semanticHash: await semanticHash(globalShard.data),
        byteLength: byteLength(globalShard),
        mediaType: "application/vnd.rosterpilot.data-shard+json",
      },
      {
        shardId: "faction:space-marines",
        kind: "faction",
        factionIds: ["space-marines", "space-wolves"],
        dependencyShardIds: ["global"],
        path: "shards/space-marines.json",
        contentSha256: await sha256Hex(canonicalJson(marinesShard)),
        semanticHash: await semanticHash(marinesShard.data),
        byteLength: byteLength(marinesShard),
        mediaType: "application/vnd.rosterpilot.data-shard+json",
      },
    ],
  };
  const pair = await keyPair();
  const manifest = await createSignedDataBundleManifest(
    draft,
    signer(pair),
  );
  return {
    pair,
    draft,
    manifest,
    shards: [globalShard, marinesShard] as const,
  };
}

test("canonical semantic hashing ignores provenance without erasing rule order", async () => {
  const first = {
    rules: {
      attacks: [1, 2, 3],
      strength: 5,
    },
    releaseId: "2026-07-30.1",
    commit: "419a80d",
    generatedAt: "2026-07-30T00:00:00.000Z",
  };
  const reordered = {
    generatedAt: "2099-01-01T00:00:00.000Z",
    commit: "21b4efa",
    releaseId: "2026-07-31.1",
    rules: {
      strength: 5,
      attacks: [1, 2, 3],
    },
  };
  assert.equal(
    canonicalSemanticJson(first),
    canonicalSemanticJson(reordered),
  );
  assert.equal(await semanticHash(first), await semanticHash(reordered));
  assert.notEqual(
    await semanticHash(first),
    await semanticHash({
      ...reordered,
      rules: { ...reordered.rules, attacks: [3, 2, 1] },
    }),
  );
  assert.equal(
    await semanticHash(first, {
      unorderedArrayPaths: [["rules", "attacks"]],
    }),
    await semanticHash(
      {
        ...reordered,
        rules: { ...reordered.rules, attacks: [3, 2, 1] },
      },
      {
        unorderedArrayPaths: [["rules", "attacks"]],
      },
    ),
  );
});

test("canonical JSON fails closed for values that cannot be reproduced", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { c: 3, b: 2 } }),
    '{"a":{"b":2,"c":3},"z":1}',
  );
  assert.throws(() => canonicalJson({ invalid: Number.NaN }));
  assert.throws(() => canonicalJson({ invalid: undefined }));
  assert.throws(() => canonicalJson(new Date()));
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic));
});

test("signed manifests bind exact provenance and support key rotation", async () => {
  const fixture = await bundleFixture();
  const verified = await verifyDataBundleManifest(fixture.manifest, {
    "release-2026": fixture.pair.publicKey,
  });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.data.bundleId, fixture.manifest.bundleId);

  const provenanceTampered = structuredClone(fixture.manifest);
  provenanceTampered.provenance.newRecruit.commit =
    "419a80d0000000000000000000000000000000000";
  const tamperedResult = await verifyDataBundleManifest(
    provenanceTampered,
    { "release-2026": fixture.pair.publicKey },
  );
  assert.equal(tamperedResult.ok, false);
  if (!tamperedResult.ok) {
    assert.equal(tamperedResult.code, "BUNDLE_ID_MISMATCH");
  }

  const signatureTampered = structuredClone(fixture.manifest);
  signatureTampered.signature.value =
    `${signatureTampered.signature.value[0] === "A" ? "B" : "A"}${signatureTampered.signature.value.slice(1)}`;
  const signatureResult = await verifyDataBundleManifest(
    signatureTampered,
    { "release-2026": fixture.pair.publicKey },
  );
  assert.equal(signatureResult.ok, false);
  if (!signatureResult.ok) {
    assert.equal(signatureResult.code, "SIGNATURE_INVALID");
  }

  const unknownKey = await verifyDataBundleManifest(
    fixture.manifest,
    {},
  );
  assert.equal(unknownKey.ok, false);
  if (!unknownKey.ok) {
    assert.equal(unknownKey.code, "UNKNOWN_KEY_ID");
  }

  const nextPair = await keyPair();
  const nextManifest = await createSignedDataBundleManifest(
    {
      ...fixture.draft,
      createdAt: "2026-08-01T12:00:00.000Z",
    },
    signer(nextPair, "release-2027"),
  );
  const nextVerified = await verifyDataBundleManifest(nextManifest, {
    "release-2026": fixture.pair.publicKey,
    "release-2027": nextPair.publicKey,
  });
  assert.equal(nextVerified.ok, true);
});

test("stable channel pointers are signed independently from bundle manifests", async () => {
  const fixture = await bundleFixture();
  const pointer = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 1,
      channel: "stable",
      bundleId: fixture.manifest.bundleId,
      manifestUrl:
        "https://data.rosterpilot.example/bundles/manifest.json",
      publishedAt: "2026-07-31T12:01:00.000Z",
    },
    signer(fixture.pair),
  );
  const verified = await verifyDataBundleChannelPointer(pointer, {
    "release-2026": fixture.pair.publicKey,
  });
  assert.equal(verified.ok, true);

  const tampered = { ...pointer, channel: "preview" };
  const rejected = await verifyDataBundleChannelPointer(tampered, {
    "release-2026": fixture.pair.publicKey,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.code, "SIGNATURE_INVALID");
  }
});

test("shards are content verified before entering an immutable snapshot", async () => {
  const fixture = await bundleFixture();
  const manifestResult = await verifyDataBundleManifest(
    fixture.manifest,
    { "release-2026": fixture.pair.publicKey },
  );
  assert.equal(manifestResult.ok, true);
  if (!manifestResult.ok) return;

  const shardResults = await Promise.all(
    fixture.shards.map((shard) =>
      verifyDataBundleShard(manifestResult.data, shard),
    ),
  );
  assert.ok(shardResults.every((result) => result.ok));
  const verifiedShards = shardResults.flatMap((result) =>
    result.ok ? [result.data] : [],
  );
  const snapshot = createDataBundleSnapshot(
    manifestResult.data,
    verifiedShards,
    { acquiredAt: "2026-07-31T12:02:00.000Z" },
  );
  assert.equal(snapshot.bundleId, fixture.manifest.bundleId);
  assert.equal(
    snapshot.getFactionShard("space-wolves")?.shardId,
    "faction:space-marines",
  );
  assert.equal(snapshot.getFactionShard("aeldari"), null);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(
    Object.isFrozen(snapshot.getShard("global")?.data),
    true,
  );
  assert.equal("set" in snapshot.shards, false);

  const tampered = structuredClone(fixture.shards[1]);
  (tampered.data as { rules: Record<string, string[]> }).rules[
    "space-wolves"
  ] = ["thunderwolf-cavalry"];
  const rejected = await verifyDataBundleShard(
    manifestResult.data,
    tampered,
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.code, "SHARD_HASH_MISMATCH");
  }
});

test("manifest validation rejects unsafe or ambiguous shard graphs", async () => {
  const fixture = await bundleFixture();
  const cyclic = structuredClone(fixture.draft);
  cyclic.shards[0].dependencyShardIds = ["faction:space-marines"];
  assert.equal(
    DataBundleManifestDraftV1Schema.safeParse(cyclic).success,
    false,
  );

  const unsafePath = structuredClone(fixture.draft);
  unsafePath.shards[0].path = "../global.json";
  assert.equal(
    DataBundleManifestDraftV1Schema.safeParse(unsafePath).success,
    false,
  );

  const duplicateOwner = structuredClone(fixture.draft);
  duplicateOwner.shards.push({
    ...duplicateOwner.shards[1],
    shardId: "faction:duplicate",
    path: "shards/duplicate.json",
  });
  assert.equal(
    DataBundleManifestDraftV1Schema.safeParse(duplicateOwner).success,
    false,
  );
});

function comparable(
  hashes: DataBundleSemanticHashesV1,
  engineDataSchemaVersion = 1,
): DataBundleComparableIdentity {
  return {
    engineDataSchemaVersion,
    semanticHashes: hashes,
  };
}

test("the real BSData pin transition is provenance-only when semantics match", () => {
  const hashes = semanticInventory();
  const result = classifyDataBundleDelta({
    current: comparable(structuredClone(hashes)),
    candidate: comparable(structuredClone(hashes)),
  });
  assert.equal(result.classification, "provenance-only");
  assert.deepEqual(result.affectedFactions, []);
  assert.equal(result.requiresFullCertification, false);
  assert.equal(result.quarantine, false);
});

test("delta classification scopes mapping, rules, dependencies, and methodology", () => {
  const current = semanticInventory();
  const mappingCandidate = structuredClone(current);
  mappingCandidate.factions["space-marines"].mappingHash = digest("f");
  const mapping = classifyDataBundleDelta({
    current: comparable(current),
    candidate: comparable(mappingCandidate),
    factionDependencies: {
      "space-wolves": ["space-marines"],
    },
  });
  assert.equal(mapping.classification, "mapping-only");
  assert.deepEqual(mapping.directlyChangedFactions, ["space-marines"]);
  assert.deepEqual(mapping.affectedFactions, [
    "space-marines",
    "space-wolves",
  ]);

  const rulesCandidate = structuredClone(current);
  rulesCandidate.factions["space-wolves"].entityHashes[
    "unit:grey-hunters"
  ] = digest("d");
  rulesCandidate.factions["space-wolves"].factionRulesHash = digest("e");
  const rules = classifyDataBundleDelta({
    current: comparable(current),
    candidate: comparable(rulesCandidate),
  });
  assert.equal(rules.classification, "rules");
  assert.deepEqual(rules.changedEntities, {
    "space-wolves": ["unit:grey-hunters"],
  });

  const portfolioCandidate = structuredClone(current);
  portfolioCandidate.factions["space-marines"].portfolioHash =
    digest("e");
  const portfolio = classifyDataBundleDelta({
    current: comparable(current),
    candidate: comparable(portfolioCandidate),
    factionDependencies: {
      "space-wolves": ["space-marines"],
    },
  });
  assert.equal(portfolio.classification, "rules");
  assert.equal(portfolio.requiresFullCertification, false);
  assert.deepEqual(portfolio.directlyChangedFactions, [
    "space-marines",
  ]);
  assert.deepEqual(portfolio.affectedFactions, [
    "space-marines",
    "space-wolves",
  ]);
  assert.deepEqual(portfolio.changedScopes, [
    "faction:space-marines:portfolio",
  ]);

  const methodologyCandidate = structuredClone(current);
  methodologyCandidate.methodologyHash = digest("f");
  const methodology = classifyDataBundleDelta({
    current: comparable(current),
    candidate: comparable(methodologyCandidate),
  });
  assert.equal(methodology.classification, "methodology/global");
  assert.equal(methodology.requiresFullCertification, true);

  const ambiguous = classifyDataBundleDelta({
    current: comparable(current),
    candidate: comparable(mappingCandidate),
    candidateAssessment: "ambiguous",
    ambiguousScopes: ["faction:space-marines:unit:unknown"],
  });
  assert.equal(ambiguous.classification, "ambiguous/regressive");
  assert.equal(ambiguous.quarantine, true);

  const regressive = classifyDataBundleDelta({
    current: comparable(current, 2),
    candidate: comparable(current, 1),
  });
  assert.equal(regressive.classification, "ambiguous/regressive");
  assert.deepEqual(regressive.changedScopes, ["engine-data-schema"]);
});
