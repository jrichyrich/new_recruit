import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSignedDataBundleChannelPointer,
  createHostedObjectStoreDataBundlePersistence,
  getConfiguredDataBundleProvider,
  initializeHostedDataBundleProvider,
  parseDataBundleTrustedKeys,
  resetHostedDataBundleProviderInitializationForTests,
  secureDataBundleUrl,
  type HostedDataBundleObjectStore,
} from "../lib/rosterpilot";
import {
  buildRuntimeDataBundle,
  signRuntimeDataBundle,
} from "../lib/rosterpilot/runtime-data-bundle";

function memoryHostedObjectStore(
  uploadedAt = "2026-07-31T00:00:00.000Z",
) {
  const objects = new Map<
    string,
    { value: string; version: string; uploadedAt: string }
  >();
  let revision = 0;
  let listingError: Error | null = null;
  let currentUploadedAt = uploadedAt;
  let rejectedSwaps = 0;
  const nextVersion = () => `v${++revision}`;
  const store: HostedDataBundleObjectStore = {
    async get(key) {
      const object = objects.get(key);
      return object
        ? {
            value: object.value,
            version: object.version,
            uploadedAt: object.uploadedAt,
          }
        : null;
    },
    async put(key, value) {
      objects.set(key, {
        value,
        version: nextVersion(),
        uploadedAt: currentUploadedAt,
      });
    },
    async compareAndSwap(key, expectedVersion, value) {
      if (rejectedSwaps > 0) {
        rejectedSwaps -= 1;
        return false;
      }
      const current = objects.get(key);
      if (
        (expectedVersion === null && current) ||
        (expectedVersion !== null &&
          current?.version !== expectedVersion)
      ) {
        return false;
      }
      objects.set(key, {
        value,
        version: nextVersion(),
        uploadedAt: currentUploadedAt,
      });
      return true;
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
    async list({ prefix }) {
      if (listingError) throw listingError;
      return {
        objects: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, object]) => ({
            key,
            uploadedAt: object.uploadedAt,
            size: object.value.length,
          })),
        cursor: null,
      };
    },
  };
  return {
    objects,
    store,
    failListings(error: Error | null) {
      listingError = error;
    },
    setUploadedAt(value: string) {
      currentUploadedAt = value;
    },
    rejectNextCompareAndSwap() {
      rejectedSwaps = 3;
    },
  };
}

test("hosted initialization keeps compiled data when release config is absent", async () => {
  resetHostedDataBundleProviderInitializationForTests();
  let reads = 0;
  const result = await initializeHostedDataBundleProvider({
    channelUrl: null,
    bootstrapManifestUrl:
      "https://app.example/data-bundles/bootstrap/manifest.json",
    trustedKeysUrl:
      "https://app.example/data-bundles/trusted-keys.json",
    loadJson: async () => {
      reads += 1;
      return null;
    },
  });

  assert.equal(result.configured, false);
  assert.equal(result.source, "compiled-unverified");
  assert.match(result.reason ?? "", /trusted-key registry/i);
  assert.equal(reads, 1);
  assert.equal(getConfiguredDataBundleProvider(), null);
});

test("trusted hosted key registries reject private and duplicate keys", () => {
  const publicKey = {
    kty: "OKP",
    crv: "Ed25519",
    x: "public",
  };
  assert.throws(
    () =>
      parseDataBundleTrustedKeys({
        schemaVersion: 1,
        keys: [
          {
            keyId: "release",
            publicKey: { ...publicKey, d: "private" },
          },
        ],
      }),
    /Invalid input|Expected never/,
  );
  assert.throws(
    () =>
      parseDataBundleTrustedKeys({
        schemaVersion: 1,
        keys: [
          { keyId: "release", publicKey },
          { keyId: "release", publicKey },
        ],
      }),
    /unique/,
  );
});

test("data-bundle transport requires HTTPS outside loopback development", () => {
  assert.equal(
    secureDataBundleUrl(
      "http://localhost:3000/data/stable.json",
      "channel",
    ),
    "http://localhost:3000/data/stable.json",
  );
  assert.throws(
    () =>
      secureDataBundleUrl(
        "http://data.example/stable.json",
        "channel",
      ),
    /must use HTTPS/,
  );
});

test("hosted channel cursors survive cold starts and advance with compare-and-set", async () => {
  const memory = memoryHostedObjectStore();
  const first = createHostedObjectStoreDataBundlePersistence(
    memory.store,
  );
  const pointerOne = "1".repeat(64);
  const pointerTwo = "2".repeat(64);
  const cursorOne = {
    schemaVersion: 1 as const,
    channel: "stable",
    pointerSchemaVersion: 2 as const,
    revision: 1,
    pointerSha256: pointerOne,
    bundleId: "a".repeat(64),
    acceptedAt: "2026-07-31T00:00:00.000Z",
  };
  const cursorTwo = {
    ...cursorOne,
    revision: 2,
    pointerSha256: pointerTwo,
    bundleId: "b".repeat(64),
    acceptedAt: "2026-07-31T00:01:00.000Z",
  };

  assert.equal(await first.loadChannelCursor(), null);
  assert.deepEqual(
    await first.compareAndSetChannelCursor({
      expectedPointerSha256: null,
      cursor: cursorOne,
    }),
    { committed: true, cursor: cursorOne },
  );
  assert.deepEqual(
    await first.compareAndSetChannelCursor({
      expectedPointerSha256: null,
      cursor: cursorTwo,
    }),
    { committed: false, cursor: cursorOne },
  );
  assert.deepEqual(
    await first.compareAndSetChannelCursor({
      expectedPointerSha256: pointerOne,
      cursor: cursorTwo,
    }),
    { committed: true, cursor: cursorTwo },
  );

  const cold = createHostedObjectStoreDataBundlePersistence(memory.store);
  assert.deepEqual(await cold.loadChannelCursor(), cursorTwo);
});

test("hosted initialization verifies bootstrap assets and refreshes the signed channel in the background", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey(
    "jwk",
    keys.publicKey,
  );
  const signer = {
    keyId: "hosted-release-test",
    privateKey: keys.privateKey,
  };
  const bundle = await signRuntimeDataBundle(
    await buildRuntimeDataBundle({
      createdAt: "2026-07-31T00:00:00.000Z",
    }),
    signer,
  );
  const origin = "https://app.example";
  const manifestUrl =
    `${origin}/data-bundles/bootstrap/manifest.json`;
  const channelUrl = `${origin}/data-bundles/channels/stable.json`;
  const pointer = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 1,
      channel: "stable",
      bundleId: bundle.manifest.bundleId,
      manifestUrl,
      publishedAt: "2026-07-31T00:01:00.000Z",
    },
    signer,
  );
  const assets = new Map<string, unknown>([
    [manifestUrl, bundle.manifest],
    ...bundle.manifest.shards.map(
      (descriptor) =>
        [
          new URL(descriptor.path, manifestUrl).toString(),
          bundle.shards.find(
            (shard) => shard.shardId === descriptor.shardId,
          ),
        ] as const,
    ),
  ]);
  const trustedKeysDocument = {
    schemaVersion: 1,
    keys: [
      {
        keyId: signer.keyId,
        publicKey,
      },
    ],
  };

  resetHostedDataBundleProviderInitializationForTests();
  const tampered = structuredClone(bundle.manifest);
  tampered.signature.value =
    `${tampered.signature.value.slice(0, -1)}${
      tampered.signature.value.endsWith("A") ? "B" : "A"
    }`;
  const rejected = await initializeHostedDataBundleProvider({
    channelUrl: null,
    bootstrapManifestUrl: manifestUrl,
    trustedKeysDocument,
    loadJson: async (url) =>
      url === manifestUrl ? tampered : (assets.get(url) ?? null),
  });
  assert.equal(rejected.configured, false);
  assert.match(rejected.reason ?? "", /not trusted/i);
  assert.equal(getConfiguredDataBundleProvider(), null);

  let offlineFetches = 0;
  const offlineSigned = await initializeHostedDataBundleProvider({
    channelUrl: null,
    bootstrapManifestUrl: manifestUrl,
    trustedKeysDocument,
    loadJson: async (url) => assets.get(url) ?? null,
    fetch: async () => {
      offlineFetches += 1;
      return new Response("unexpected", { status: 500 });
    },
  });
  assert.equal(offlineSigned.configured, true);
  assert.equal(offlineSigned.source, "signed-verified");
  assert.equal(
    offlineSigned.activeBundleId,
    bundle.manifest.bundleId,
    "a transient hosted initialization failure must not be cached for the process lifetime",
  );
  assert.equal(offlineSigned.refreshScheduled, false);
  assert.equal(offlineSigned.refreshMode, "disabled");
  assert.equal(offlineFetches, 0);
  assert.equal(
    (await getConfiguredDataBundleProvider()!.getStatus()).state,
    "offline",
  );

  resetHostedDataBundleProviderInitializationForTests();
  const background: Promise<void>[] = [];
  const initialized = await initializeHostedDataBundleProvider({
    channelUrl,
    bootstrapManifestUrl: manifestUrl,
    trustedKeysDocument,
    loadJson: async (url) => assets.get(url) ?? null,
    fetch: async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === channelUrl) return Response.json(pointer);
      return new Response("missing", { status: 404 });
    },
    scheduleBackground: (task) => {
      background.push(task);
    },
  });

  assert.equal(initialized.configured, true);
  assert.equal(initialized.source, "signed-verified");
  assert.equal(initialized.activeBundleId, bundle.manifest.bundleId);
  assert.equal(initialized.refreshScheduled, true);
  assert.equal(initialized.refreshMode, "request-driven-wait-until");
  assert.equal(background.length, 1);
  await Promise.all(background);
  const provider = getConfiguredDataBundleProvider();
  assert.ok(provider);
  const status = await provider.getStatus();
  assert.equal(status.state, "ready");
  assert.equal(status.activeBundleId, bundle.manifest.bundleId);
  assert.equal(
    status.latestVerifiedBundleId,
    bundle.manifest.bundleId,
  );
  assert.equal(
    status.latestUpstreamBundleId,
    bundle.manifest.bundleId,
  );
  assert.equal(status.candidate, null);
  assert.deepEqual(status.quarantinedScopes, []);
  assert.ok(status.lastCheckedAt);

  resetHostedDataBundleProviderInitializationForTests();
  const memoryStore = memoryHostedObjectStore();
  const persistence = createHostedObjectStoreDataBundlePersistence(
    memoryStore.store,
  );
  const durable = await initializeHostedDataBundleProvider({
    channelUrl: null,
    bootstrapManifestUrl: manifestUrl,
    trustedKeysDocument,
    loadJson: async (url) => assets.get(url) ?? null,
    persistence,
  });
  assert.equal(durable.configured, true);
  assert.deepEqual(durable.durability, {
    mode: "persistent",
    state: "ready",
    reason: null,
  });
  assert.ok(memoryStore.objects.has("rosterpilot-data/v1/active.json"));
  assert.ok(
    memoryStore.objects.has(
      `rosterpilot-data/v1/bundles/${bundle.manifest.bundleId}/manifest.json`,
    ),
  );
  await persistence.recordQuarantine({
    bundleId: bundle.manifest.bundleId,
    scopes: ["faction:aeldari"],
    reason: "Cold-start quarantine test.",
  });

  resetHostedDataBundleProviderInitializationForTests();
  const quarantinedRestore = await initializeHostedDataBundleProvider({
    channelUrl: null,
    bootstrapManifestUrl: manifestUrl,
    trustedKeysDocument,
    loadJson: async (url) => assets.get(url) ?? null,
    persistence,
  });
  assert.equal(quarantinedRestore.configured, false);
  assert.match(quarantinedRestore.reason ?? "", /quarantined/);
  const reloadedQuarantines = await persistence.loadQuarantines();
  assert.equal(reloadedQuarantines.length, 1);
  assert.deepEqual(
    {
      bundleId: reloadedQuarantines[0].bundleId,
      scopes: reloadedQuarantines[0].scopes,
      reason: reloadedQuarantines[0].reason,
    },
    {
      bundleId: bundle.manifest.bundleId,
      scopes: ["faction:aeldari"],
      reason: "Cold-start quarantine test.",
    },
  );
  assert.ok(Number.isFinite(Date.parse(reloadedQuarantines[0].recordedAt)));
  await persistence.clearQuarantine({
    bundleId: bundle.manifest.bundleId,
    reason: "Re-certified by the hosted release workflow.",
  });
  assert.deepEqual(await persistence.loadQuarantines(), []);

  resetHostedDataBundleProviderInitializationForTests();
  const restored = await initializeHostedDataBundleProvider({
    channelUrl: null,
    bootstrapManifestUrl: manifestUrl,
    trustedKeysDocument,
    loadJson: async (url) => assets.get(url) ?? null,
    persistence,
  });
  assert.equal(restored.activeBundleId, bundle.manifest.bundleId);
  assert.equal(restored.durability.mode, "persistent");
  assert.deepEqual(
    (await getConfiguredDataBundleProvider()!.getStatus())
      .quarantinedScopes,
    [],
  );
  await persistence.persistRollbackHold({
    bundleId: bundle.manifest.bundleId,
    engagedAt: "2026-07-31T01:00:00.000Z",
    release: "force-refresh",
  });
  resetHostedDataBundleProviderInitializationForTests();
  await initializeHostedDataBundleProvider({
    channelUrl: null,
    bootstrapManifestUrl: manifestUrl,
    trustedKeysDocument,
    loadJson: async (url) => assets.get(url) ?? null,
    persistence,
  });
  assert.deepEqual(
    (await getConfiguredDataBundleProvider()!.getStatus()).rollbackHold,
    {
      bundleId: bundle.manifest.bundleId,
      engagedAt: "2026-07-31T01:00:00.000Z",
      release: "force-refresh",
    },
  );
  await getConfiguredDataBundleProvider()!.refresh({ force: true });
  assert.equal(await persistence.loadRollbackHold(), null);
});

test("hosted retention protects rollback history, references, and young bundles and fails closed", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signed = await signRuntimeDataBundle(
    await buildRuntimeDataBundle({
      createdAt: "2026-05-01T00:00:00.000Z",
    }),
    { keyId: "retention-test", privateKey: keys.privateKey },
  );
  const memory = memoryHostedObjectStore(
    "2026-05-01T00:00:00.000Z",
  );
  const persistence = createHostedObjectStoreDataBundlePersistence(
    memory.store,
    { now: () => new Date("2026-07-31T00:00:00.000Z") },
  );
  const ids = Array.from({ length: 8 }, (_, index) =>
    String(index + 1).repeat(64),
  );
  const snapshot = (bundleId: string) => {
    const manifest = {
      ...structuredClone(signed.manifest),
      bundleId,
    };
    return {
      bundleId,
      manifest,
      acquiredAt: manifest.createdAt,
      getShard(shardId: string) {
        return (
          signed.shards.find((shard) => shard.shardId === shardId) ??
          null
        );
      },
      getFactionShard() {
        return null;
      },
    } as unknown as Parameters<
      typeof persistence.persistBundle
    >[0];
  };

  for (const bundleId of ids.slice(0, 6)) {
    await persistence.persistBundle(snapshot(bundleId));
  }
  memory.setUploadedAt("2026-07-20T00:00:00.000Z");
  await persistence.persistBundle(snapshot(ids[6]));
  for (const bundleId of ids.slice(0, 5)) {
    await persistence.activateBundle(bundleId);
  }
  await persistence.retainReference("job:durable", ids[5]);
  await persistence.recordQuarantine({
    bundleId: ids[0],
    scopes: ["faction:aeldari"],
    reason: "Certification failed.",
  });
  await assert.rejects(
    persistence.activateBundle(ids[0]),
    /quarantined/,
  );
  await assert.rejects(
    persistence.persistRollbackHold({
      bundleId: ids[0],
      engagedAt: "2026-07-31T00:00:00.000Z",
      release: "force-refresh",
    }),
    /quarantined/,
  );

  const verified = new Set<string>();
  const retention = await persistence.enforceRetention({
    verifyBundle: async (bundle) => {
      verified.add(
        (bundle.manifest as { bundleId: string }).bundleId,
      );
    },
  });
  assert.deepEqual(retention.prunedBundleIds, [ids[0]]);
  assert.deepEqual(retention.protectedBundleIds, [
    ids[1],
    ids[2],
    ids[3],
    ids[4],
    ids[5],
  ]);
  assert.equal(verified.size, 7);
  assert.equal(
    memory.objects.has(
      `rosterpilot-data/v1/bundles/${ids[0]}/manifest.json`,
    ),
    false,
  );
  assert.equal(
    memory.objects.has(
      `rosterpilot-data/v1/bundles/${ids[6]}/manifest.json`,
    ),
    true,
    "a bundle younger than 30 days must be retained",
  );
  const retainedQuarantines = await persistence.loadQuarantines();
  assert.equal(retainedQuarantines.length, 1);
  assert.match(retainedQuarantines[0].quarantineId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({
    bundleId: retainedQuarantines[0].bundleId,
    scopes: retainedQuarantines[0].scopes,
    reason: retainedQuarantines[0].reason,
    recordedAt: retainedQuarantines[0].recordedAt,
  },
    {
      bundleId: ids[0],
      scopes: ["faction:aeldari"],
      reason: "Certification failed.",
      recordedAt: "2026-07-31T00:00:00.000Z",
    },
  );

  memory.setUploadedAt("2026-05-01T00:00:00.000Z");
  await persistence.persistBundle(snapshot(ids[7]));
  await assert.rejects(
    persistence.enforceRetention({
      verifyBundle: async (bundle) => {
        if (
          (bundle.manifest as { bundleId: string }).bundleId ===
          ids[7]
        ) {
          throw new Error("signature mismatch");
        }
      },
    }),
    /signature mismatch/,
  );
  assert.equal(
    memory.objects.has(
      `rosterpilot-data/v1/bundles/${ids[7]}/manifest.json`,
    ),
    true,
    "integrity failure must happen before deletion",
  );

  memory.failListings(new Error("listing unavailable"));
  await assert.rejects(
    persistence.enforceRetention({ verifyBundle: async () => undefined }),
    /listing unavailable/,
  );
  memory.failListings(null);
  memory.rejectNextCompareAndSwap();
  await assert.rejects(
    persistence.activateBundle(ids[6]),
    /changed concurrently/,
  );
  assert.equal(await persistence.getActiveBundleId(), ids[4]);
});
