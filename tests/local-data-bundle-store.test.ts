import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSignedDataBundleChannelPointer,
  createSignedDataBundleManifest,
  type DataBundleManifestDraftV1,
  type DataBundleShardV1,
  type DataBundleSigner,
} from "../lib/rosterpilot/data-bundle";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
  type DataBundleSemanticHashesV1,
} from "../lib/rosterpilot/semantic-hash";
import {
  buildRuntimeDataBundle,
  signRuntimeDataBundle,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  createLocalRuntimeDataBundleProvider,
} from "../local/data-bundles/provider";
import {
  createLocalDataBundleStore,
  LocalDataBundleStoreError,
} from "../local/data-bundles/store";

const digest = (character: string): string => character.repeat(64);

type BundleFixture = {
  manifest: Awaited<
    ReturnType<typeof createSignedDataBundleManifest>
  >;
  shards: Record<string, unknown>;
  pointer: Awaited<
    ReturnType<typeof createSignedDataBundleChannelPointer>
  >;
};

function semanticInventory(): DataBundleSemanticHashesV1 {
  return {
    globalHash: digest("1"),
    methodologyHash: digest("2"),
    factions: {
      "adeptus-custodes": {
        factionRulesHash: digest("3"),
        mappingHash: digest("4"),
        portfolioHash: digest("5"),
        conflictHash: digest("6"),
        entityHashes: {
          "unit:custodian-guard": digest("7"),
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

function signer(pair: CryptoKeyPair): DataBundleSigner {
  return {
    keyId: "release-2026",
    privateKey: pair.privateKey,
  };
}

function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

async function bundleFixture(
  pair: CryptoKeyPair,
  sequence: number,
): Promise<BundleFixture> {
  const globalShard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "global",
    kind: "global",
    factionIds: [],
    data: {
      edition: "11th",
      sequence,
    },
  };
  const factionShard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "faction:adeptus-custodes",
    kind: "faction",
    factionIds: ["adeptus-custodes"],
    data: {
      units: ["custodian-guard"],
      sequence,
    },
  };
  const createdAt = new Date(
    Date.UTC(2026, 0, 1, 0, sequence),
  ).toISOString();
  const draft: DataBundleManifestDraftV1 = {
    schemaVersion: 1,
    engineDataSchemaVersion: 1,
    createdAt,
    provenance: {
      official: {
        authority: "games-workshop",
        version: `1.${sequence}`,
        contentSha256: digest("8"),
        downloadsUrl:
          "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
        checkedAt: createdAt,
      },
      rules: {
        provider: "40kdc-data",
        package: "@alpaca-software/40kdc-data",
        version: "1.2.1",
        sourceSha256: digest("9"),
        edition: "11th",
        dataslate: "launch",
      },
      newRecruit: {
        provider: "bsdata",
        repository: "BSData/wh40k-11e",
        branch: "main",
        commit: `${sequence.toString(16).padStart(7, "0")}abcdef`,
      },
    },
    semanticHashes: semanticInventory(),
    shards: [
      {
        shardId: globalShard.shardId,
        kind: globalShard.kind,
        factionIds: globalShard.factionIds,
        dependencyShardIds: [],
        path: "shards/global.json",
        contentSha256: await sha256Hex(
          canonicalJson(globalShard),
        ),
        semanticHash: await semanticHash(globalShard.data),
        byteLength: canonicalByteLength(globalShard),
        mediaType:
          "application/vnd.rosterpilot.data-shard+json",
      },
      {
        shardId: factionShard.shardId,
        kind: factionShard.kind,
        factionIds: factionShard.factionIds,
        dependencyShardIds: ["global"],
        path: "shards/adeptus-custodes.json",
        contentSha256: await sha256Hex(
          canonicalJson(factionShard),
        ),
        semanticHash: await semanticHash(factionShard.data),
        byteLength: canonicalByteLength(factionShard),
        mediaType:
          "application/vnd.rosterpilot.data-shard+json",
      },
    ],
  };
  const manifest = await createSignedDataBundleManifest(
    draft,
    signer(pair),
  );
  return {
    manifest,
    shards: {
      "shards/global.json": globalShard,
      "shards/adeptus-custodes.json": factionShard,
    },
    pointer: await createSignedDataBundleChannelPointer(
      {
        schemaVersion: 1,
        channel: "stable",
        bundleId: manifest.bundleId,
        manifestUrl: `https://data.rosterpilot.test/${manifest.bundleId}/manifest.json`,
        publishedAt: createdAt,
      },
      signer(pair),
    ),
  };
}

async function withStoreDirectory(
  label: string,
  run: (rootDirectory: string) => Promise<void>,
): Promise<void> {
  const rootDirectory = await mkdtemp(
    path.join(os.tmpdir(), `${label}-`),
  );
  try {
    await run(rootDirectory);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
}

function isStoreError(
  error: unknown,
  code: LocalDataBundleStoreError["code"],
): boolean {
  return (
    error instanceof LocalDataBundleStoreError &&
    error.code === code
  );
}

test("local bundle install atomically activates a fully verified snapshot and receipt", async () => {
  await withStoreDirectory("data-bundle-store-install", async (root) => {
    const pair = await keyPair();
    const first = await bundleFixture(pair, 1);
    const second = await bundleFixture(pair, 2);
    const store = createLocalDataBundleStore({
      rootDirectory: root,
      trustedKeys: {
        "release-2026": pair.publicKey,
      },
    });

    assert.equal((await store.getStatus()).state, "empty");
    const installed = await store.installBundle(
      {
        manifest: first.manifest,
        shards: first.shards,
        channelPointer: first.pointer,
        acceptance: {
          classification: "provenance-only",
          certificationStatus: "passed",
          certificationEvidenceSha256: digest("a"),
        },
      },
      { activate: true },
    );
    assert.equal(installed.installed, true);
    assert.equal(installed.activated, true);
    assert.equal(installed.receipt.source.channel, "stable");
    assert.equal(
      installed.receipt.acceptance.certificationStatus,
      "passed",
    );

    const snapshotLease = await store.acquireSnapshot({
      factionIds: ["adeptus-custodes"],
    });
    assert.equal(snapshotLease.snapshot.bundleId, first.manifest.bundleId);
    await store.installBundle(
      {
        manifest: second.manifest,
        shards: second.shards,
        channelPointer: second.pointer,
      },
      { activate: true },
    );
    assert.equal(
      (await store.loadActiveBundle()).bundleId,
      second.manifest.bundleId,
    );
    assert.equal(
      snapshotLease.snapshot.bundleId,
      first.manifest.bundleId,
      "an acquired lease must retain its exact immutable snapshot",
    );
    assert.equal(
      (await store.getStatus()).bundles.find(
        (entry) => entry.bundleId === first.manifest.bundleId,
      )?.referencedBy,
      1,
    );
    await snapshotLease.release();
    assert.equal(snapshotLease.released, true);
    assert.equal((await store.getStatus()).state, "ready");
  });
});

test("a long-lived provider follows an active pointer advanced by another process", async () => {
  await withStoreDirectory(
    "data-bundle-cross-process-pointer",
    async (root) => {
      const pair = await keyPair();
      const releaseSigner = signer(pair);
      const first = await signRuntimeDataBundle(
        await buildRuntimeDataBundle({
          createdAt: "2026-07-30T00:00:00.000Z",
        }),
        releaseSigner,
      );
      const second = await signRuntimeDataBundle(
        await buildRuntimeDataBundle({
          createdAt: "2026-07-31T00:00:00.000Z",
        }),
        releaseSigner,
      );
      const installInput = (
        bundle: typeof first,
      ) => ({
        manifest: bundle.manifest,
        shards: Object.fromEntries(
          bundle.manifest.shards.map((descriptor) => [
            descriptor.path,
            bundle.shards.find(
              (shard) =>
                shard.shardId === descriptor.shardId,
            ),
          ]),
        ),
      });
      const provider =
        await createLocalRuntimeDataBundleProvider({
          rootDirectory: root,
          trustedKeys: {
            "release-2026": pair.publicKey,
          },
          channelUrl: null,
          refreshOnInitialize: false,
          bootstrap: installInput(first),
        });

      await provider.getStore().installBundle(
        {
          ...installInput(second),
          acceptance: {
            classification: "provenance-only",
            certificationStatus: "not-required",
          },
        },
        { activate: true },
      );

      const lease = await provider.acquireSnapshot();
      assert.equal(
        lease.snapshot.bundleId,
        second.manifest.bundleId,
      );
      await lease.release();
      const status = await provider.getStatus();
      assert.equal(status.activeBundleId, second.manifest.bundleId);
      assert.equal(
        status.rollbackHold,
        null,
        "following a shared active pointer is synchronization, not an operator rollback",
      );
    },
  );
});

test("failed validation and a crash after install never switch the active pointer", async () => {
  await withStoreDirectory("data-bundle-store-atomic", async (root) => {
    const pair = await keyPair();
    const first = await bundleFixture(pair, 3);
    const rejected = await bundleFixture(pair, 4);
    const interrupted = await bundleFixture(pair, 5);
    const trustedKeys = {
      "release-2026": pair.publicKey,
    };
    const store = createLocalDataBundleStore({
      rootDirectory: root,
      trustedKeys,
    });
    await store.installBundle(first, { activate: true });

    const tamperedShards = structuredClone(rejected.shards);
    (
      tamperedShards[
        "shards/adeptus-custodes.json"
      ] as DataBundleShardV1<{ units: string[]; sequence: number }>
    ).data.sequence = 999;
    await assert.rejects(
      store.installBundle(
        {
          manifest: rejected.manifest,
          shards: tamperedShards,
        },
        { activate: true },
      ),
      (error: unknown) =>
        isStoreError(error, "DATA_BUNDLE_INSTALL_INVALID"),
    );
    assert.equal(
      (await store.loadActiveBundle()).bundleId,
      first.manifest.bundleId,
    );

    const interruptedStore = createLocalDataBundleStore({
      rootDirectory: root,
      trustedKeys,
      faultInjector(point) {
        if (point === "after-bundle-installed") {
          throw new Error("simulated process interruption");
        }
      },
    });
    await assert.rejects(
      interruptedStore.installBundle(interrupted, {
        activate: true,
      }),
      /simulated process interruption/,
    );
    assert.equal(
      (await store.loadActiveBundle()).bundleId,
      first.manifest.bundleId,
    );
    assert.equal(
      (await store.loadBundle(interrupted.manifest.bundleId))
        .bundleId,
      interrupted.manifest.bundleId,
      "a crash after the immutable rename may leave a safe inactive install",
    );
    assert.deepEqual(
      await readdir(path.join(root, "v1", "staging")),
      [],
    );
  });
});

test("the update lease is exclusive, token-owned, and recovers an abandoned owner", async () => {
  await withStoreDirectory("data-bundle-store-lease", async (root) => {
    const pair = await keyPair();
    const options = {
      rootDirectory: root,
      trustedKeys: {
        "release-2026": pair.publicKey,
      },
    };
    const firstStore = createLocalDataBundleStore(options);
    const secondStore = createLocalDataBundleStore(options);
    const lease = await firstStore.acquireUpdateLease();
    await assert.rejects(
      secondStore.acquireUpdateLease({
        timeoutMs: 20,
        staleOwnerGraceMs: 0,
      }),
      (error: unknown) =>
        isStoreError(error, "DATA_BUNDLE_STORE_LOCKED"),
    );
    await lease.release();
    await lease.release();
    assert.equal(lease.released, true);

    const leaseDirectory = path.join(
      root,
      "v1",
      "locks",
      "update.lock",
    );
    await mkdir(leaseDirectory, { mode: 0o700 });
    await writeFile(
      path.join(leaseDirectory, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        leaseKind: "rosterpilot-data-bundle-update",
        pid: 2_147_483_647,
        token: "abandoned",
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const recovered = await secondStore.acquireUpdateLease({
      timeoutMs: 100,
      staleOwnerGraceMs: 0,
    });
    assert.notEqual(recovered.leaseId, "abandoned");
    await recovered.release();
  });
});

test("rollback and quarantine switch only to independently verified history", async () => {
  await withStoreDirectory("data-bundle-store-rollback", async (root) => {
    const pair = await keyPair();
    const first = await bundleFixture(pair, 6);
    const second = await bundleFixture(pair, 7);
    const store = createLocalDataBundleStore({
      rootDirectory: root,
      trustedKeys: {
        "release-2026": pair.publicKey,
      },
    });
    await store.installBundle(first, { activate: true });
    await store.installBundle(second, { activate: true });

    const rollback = await store.rollbackBundle();
    assert.equal(rollback.bundleId, first.manifest.bundleId);
    assert.equal(rollback.previousBundleId, second.manifest.bundleId);
    assert.deepEqual((await store.getStatus()).rollbackHold, {
      bundleId: first.manifest.bundleId,
      engagedAt: rollback.state.rollbackHold?.engagedAt,
      release: "force-refresh",
    });
    const reopenedStore = createLocalDataBundleStore({
      rootDirectory: root,
      trustedKeys: {
        "release-2026": pair.publicKey,
      },
    });
    assert.equal(
      (await reopenedStore.getStatus()).rollbackHold?.bundleId,
      first.manifest.bundleId,
    );
    await assert.rejects(
      reopenedStore.activateBundle(second.manifest.bundleId),
      (error: unknown) =>
        isStoreError(error, "DATA_BUNDLE_ROLLBACK_HELD"),
    );
    await reopenedStore.clearRollbackHold();
    await store.activateBundle(second.manifest.bundleId);
    const quarantined = await store.quarantineBundle(
      second.manifest.bundleId,
      {
        reason: "Certification evidence regressed.",
        scopes: ["portfolio", "mapping"],
        evidenceSha256: digest("b"),
      },
    );
    assert.equal(
      quarantined.activeBundleId,
      first.manifest.bundleId,
    );
    await assert.rejects(
      store.activateBundle(second.manifest.bundleId),
      (error: unknown) =>
        isStoreError(error, "DATA_BUNDLE_QUARANTINED"),
    );
    const status = await store.getStatus();
    assert.equal(status.state, "ready");
    assert.equal(
      status.bundles.find(
        (entry) => entry.bundleId === second.manifest.bundleId,
      )?.role,
      "quarantined",
    );
    await store.clearBundleQuarantine(second.manifest.bundleId);
    await store.activateBundle(second.manifest.bundleId);
    assert.equal(
      (await store.loadActiveBundle()).bundleId,
      second.manifest.bundleId,
    );
  });
});

test("the channel anti-replay cursor survives restart and uses compare-and-set", async () => {
  await withStoreDirectory("channel-cursor", async (rootDirectory) => {
    const pair = await keyPair();
    const options = {
      rootDirectory,
      trustedKeys: { "release-2026": pair.publicKey },
      now: () => new Date("2026-07-31T04:00:00.000Z"),
    };
    const cursor = {
      schemaVersion: 1 as const,
      channel: "stable",
      pointerSchemaVersion: 2 as const,
      revision: 7,
      pointerSha256: digest("7"),
      bundleId: digest("8"),
      acceptedAt: "2026-07-31T04:00:00.000Z",
    };
    const store = createLocalDataBundleStore(options);
    const committed = await store.compareAndSetChannelCursor({
      expectedPointerSha256: null,
      cursor,
    });
    assert.equal(committed.committed, true);

    const reopened = createLocalDataBundleStore(options);
    assert.deepEqual(await reopened.getChannelCursor(), cursor);
    const raced = await reopened.compareAndSetChannelCursor({
      expectedPointerSha256: digest("6"),
      cursor: {
        ...cursor,
        revision: 8,
        pointerSha256: digest("9"),
      },
    });
    assert.equal(raced.committed, false);
    assert.deepEqual(raced.cursor, cursor);
  });
});

test("retention preserves active, previous three, referenced, and thirty-day bundles", async () => {
  await withStoreDirectory("data-bundle-store-retention", async (root) => {
    const pair = await keyPair();
    let clock = new Date("2026-05-01T00:00:00.000Z");
    const store = createLocalDataBundleStore({
      rootDirectory: root,
      trustedKeys: {
        "release-2026": pair.publicKey,
      },
      now: () => new Date(clock),
    });
    const bundles = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        bundleFixture(pair, 10 + index),
      ),
    );
    await store.installBundle(bundles[0]);
    for (const candidate of bundles.slice(1, 6)) {
      await store.installBundle(candidate, { activate: true });
    }
    const statusBefore = await store.getStatus();
    assert.deepEqual(statusBefore.previousBundleIds, [
      bundles[4].manifest.bundleId,
      bundles[3].manifest.bundleId,
      bundles[2].manifest.bundleId,
    ]);

    clock = new Date("2026-06-20T00:00:00.000Z");
    await store.installBundle(bundles[6]);
    clock = new Date("2026-06-30T00:00:00.000Z");
    await store.setBundleReference(
      "durable-job-baseline",
      bundles[1].manifest.bundleId,
    );
    const firstRetention = await store.enforceRetention();
    assert.deepEqual(firstRetention.prunedBundleIds, [
      bundles[0].manifest.bundleId,
    ]);
    assert.ok(
      firstRetention.protectedBundleIds.includes(
        bundles[1].manifest.bundleId,
      ),
    );
    assert.ok(
      firstRetention.retainedBundleIds.includes(
        bundles[6].manifest.bundleId,
      ),
      "an inactive bundle younger than thirty days must be retained",
    );

    await store.removeBundleReference("durable-job-baseline", {
      bundleId: bundles[1].manifest.bundleId,
    });
    const secondRetention = await store.enforceRetention();
    assert.deepEqual(secondRetention.prunedBundleIds, [
      bundles[1].manifest.bundleId,
    ]);
    assert.equal(
      (await store.getStatus()).bundles.length,
      5,
    );
  });
});

test("crashed snapshot leases expire while durable references remain pinned", async () => {
  await withStoreDirectory(
    "data-bundle-store-snapshot-recovery",
    async (root) => {
      const pair = await keyPair();
      let clock = new Date("2026-07-31T00:00:00.000Z");
      const options = {
        rootDirectory: root,
        trustedKeys: {
          "release-2026": pair.publicKey,
        },
        now: () => new Date(clock),
        retentionDays: 0,
        snapshotReferenceTtlMs: 60_000,
      };
      const store = createLocalDataBundleStore(options);
      const bundles = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          bundleFixture(pair, 30 + index),
        ),
      );
      for (const bundle of bundles) {
        await store.installBundle(bundle, { activate: true });
      }
      const leakedSnapshot = await store.acquireSnapshot({
        bundleId: bundles[0].manifest.bundleId,
      });
      await store.setBundleReference(
        "durable-job-reference",
        bundles[1].manifest.bundleId,
      );

      const before = await store.getStatus();
      const transient = before.references.find(
        (reference) => reference.referenceId === leakedSnapshot.leaseId,
      );
      assert.equal(transient?.retentionClass, "transient-snapshot");
      assert.equal(transient?.owner?.pid, process.pid);
      assert.equal(
        transient?.expiresAt,
        "2026-07-31T00:01:00.000Z",
      );
      assert.equal(
        before.references.find(
          (reference) =>
            reference.referenceId === "durable-job-reference",
        )?.expiresAt,
        null,
      );

      clock = new Date("2026-07-31T00:00:00.001Z");
      const recoveryStore = createLocalDataBundleStore({
        ...options,
        isProcessAlive: () => false,
      });
      const retention = await recoveryStore.enforceRetention();
      assert.ok(
        retention.prunedBundleIds.includes(
          bundles[0].manifest.bundleId,
        ),
        "a dead snapshot owner must not pin its bundle until the TTL elapses",
      );
      assert.ok(
        retention.retainedBundleIds.includes(
          bundles[1].manifest.bundleId,
        ),
        "a durable roster or job reference remains non-expiring",
      );
      assert.deepEqual(
        (await recoveryStore.getStatus()).references.map(
          (reference) => reference.referenceId,
        ),
        ["durable-job-reference"],
      );
      await leakedSnapshot.release();
    },
  );
});

test("tampered integrity receipts fail closed and are surfaced as degraded status", async () => {
  await withStoreDirectory("data-bundle-store-receipt", async (root) => {
    const pair = await keyPair();
    const candidate = await bundleFixture(pair, 20);
    const store = createLocalDataBundleStore({
      rootDirectory: root,
      trustedKeys: {
        "release-2026": pair.publicKey,
      },
    });
    await store.installBundle(candidate, { activate: true });
    const receiptFilename = path.join(
      root,
      "v1",
      "bundles",
      candidate.manifest.bundleId,
      "receipt.json",
    );
    const receipt = JSON.parse(
      await readFile(receiptFilename, "utf8"),
    ) as { installedAt: string };
    receipt.installedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(receiptFilename, JSON.stringify(receipt));

    await assert.rejects(
      store.loadActiveBundle(),
      (error: unknown) =>
        isStoreError(error, "DATA_BUNDLE_INTEGRITY_FAILED"),
    );
    const status = await store.getStatus();
    assert.equal(status.state, "degraded");
    assert.equal(status.bundles[0]?.integrity, "invalid");
  });
});
