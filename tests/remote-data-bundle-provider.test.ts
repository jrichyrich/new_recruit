import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSignedDataBundleChannelPointer,
  dataBundleChannelPointerSha256,
  type DataBundleChannelCursorV1,
} from "../lib/rosterpilot/data-bundle";
import {
  RemoteRuntimeDataBundleProvider,
} from "../lib/rosterpilot/remote-data-bundle-provider";
import {
  buildRuntimeDataBundle,
  composeRuntimeDataBundleRetainingVerifiedShards,
  signRuntimeDataBundle,
  verifyRuntimeDataBundle,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  serializeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";

function minimalRuntimeSnapshot(bundleId: string) {
  return {
    bundleId,
    manifest: {},
    acquiredAt: "2026-07-31T00:00:00.000Z",
    getShard() {
      return null;
    },
    getFactionShard() {
      return null;
    },
  } as unknown as ConstructorParameters<
    typeof RemoteRuntimeDataBundleProvider
  >[0]["bootstrap"];
}

async function channelPointerChainFixture() {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signer = {
    keyId: "channel-replay-test",
    privateKey: keys.privateKey,
  };
  const bundleId = "a".repeat(64);
  const manifestUrl =
    `https://channel.example/bundles/${bundleId}/manifest.json`;
  const genesis = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 2,
      channel: "stable",
      bundleId,
      manifestUrl,
      publishedAt: "2026-07-30T00:00:00.000Z",
      revision: 0,
      previous: null,
      transition: { kind: "publish", fromBundleId: null },
    },
    signer,
  );
  const genesisSha256 =
    await dataBundleChannelPointerSha256(genesis);
  const revisionOne = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 2,
      channel: "stable",
      bundleId,
      manifestUrl,
      publishedAt: "2026-07-31T00:00:00.000Z",
      revision: 1,
      previous: {
        pointerSha256: genesisSha256,
        pointerUrl: `https://channel.example/history/${genesisSha256}.json`,
      },
      transition: { kind: "publish", fromBundleId: bundleId },
    },
    signer,
  );
  const revisionOneSha256 =
    await dataBundleChannelPointerSha256(revisionOne);
  const rollback = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 2,
      channel: "stable",
      bundleId,
      manifestUrl,
      publishedAt: "2026-07-31T01:00:00.000Z",
      revision: 2,
      previous: {
        pointerSha256: revisionOneSha256,
        pointerUrl: `https://channel.example/history/${revisionOneSha256}.json`,
      },
      transition: {
        kind: "rollback",
        fromBundleId: bundleId,
        reasonCode: "LIVE_CANARY_FAILED",
        quarantineRecordSha256: "f".repeat(64),
      },
    },
    signer,
  );
  return {
    bundleId,
    trustedKeys: { "channel-replay-test": keys.publicKey },
    genesis,
    genesisSha256,
    revisionOne,
    revisionOneSha256,
    rollback,
  };
}

function channelCursorPersistence() {
  let cursor: DataBundleChannelCursorV1 | null = null;
  return {
    load: async () => cursor,
    compareAndSet: async (input: {
      expectedPointerSha256: string | null;
      cursor: DataBundleChannelCursorV1;
    }) => {
      if (cursor?.pointerSha256 === input.cursor.pointerSha256) {
        return { committed: false, cursor };
      }
      if (
        (cursor?.pointerSha256 ?? null) !==
        input.expectedPointerSha256
      ) {
        assert.ok(cursor);
        return { committed: false, cursor };
      }
      cursor = input.cursor;
      return { committed: true, cursor };
    },
    current: () => cursor,
  };
}

test("signed channel revisions reject replay across restart and accept an explicit newer rollback", async () => {
  const chain = await channelPointerChainFixture();
  const persistence = channelCursorPersistence();
  let latest: unknown = chain.revisionOne;
  const fetchChannel = async (input: string | URL | Request) => {
    const url = String(input);
    const value =
      url === "https://channel.example/stable.json"
        ? latest
        : url ===
            `https://channel.example/history/${chain.genesisSha256}.json`
          ? chain.genesis
          : url ===
              `https://channel.example/history/${chain.revisionOneSha256}.json`
            ? chain.revisionOne
            : null;
    return new Response(JSON.stringify(value), {
      status: value ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
  const createProvider = () =>
    new RemoteRuntimeDataBundleProvider({
      bootstrap: minimalRuntimeSnapshot(chain.bundleId),
      channelUrl: "https://channel.example/stable.json",
      trustedKeys: chain.trustedKeys,
      fetch: fetchChannel,
      loadChannelCursor: persistence.load,
      compareAndSetChannelCursor: persistence.compareAndSet,
      activate: () => undefined,
    });

  const provider = createProvider();
  await provider.initialize({ refresh: false });
  await provider.refresh({ force: true });
  assert.equal(persistence.current()?.revision, 1);

  latest = chain.genesis;
  await assert.rejects(
    provider.refresh({ force: true }),
    /Rejected signed channel-pointer replay at revision 0/,
  );

  latest = chain.revisionOne;
  await provider.refresh({ force: true });
  assert.equal(persistence.current()?.revision, 1);

  const restarted = createProvider();
  await restarted.initialize({ refresh: false });
  latest = chain.genesis;
  await assert.rejects(
    restarted.refresh({ force: true }),
    /Rejected signed channel-pointer replay at revision 0/,
  );

  latest = chain.rollback;
  await restarted.refresh({ force: true });
  assert.equal(persistence.current()?.revision, 2);
  latest = chain.revisionOne;
  await assert.rejects(
    restarted.refresh({ force: true }),
    /Rejected signed channel-pointer replay at revision 1/,
  );
});

test("concurrent providers converge through channel-cursor compare-and-set", async () => {
  const chain = await channelPointerChainFixture();
  const persistence = channelCursorPersistence();
  let latest: unknown = chain.revisionOne;
  const fetchChannel = async (input: string | URL | Request) => {
    const url = String(input);
    const value =
      url === "https://channel.example/stable.json"
        ? latest
        : url ===
            `https://channel.example/history/${chain.genesisSha256}.json`
          ? chain.genesis
          : chain.revisionOne;
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const createProvider = () =>
    new RemoteRuntimeDataBundleProvider({
      bootstrap: minimalRuntimeSnapshot(chain.bundleId),
      channelUrl: "https://channel.example/stable.json",
      trustedKeys: chain.trustedKeys,
      fetch: fetchChannel,
      loadChannelCursor: persistence.load,
      compareAndSetChannelCursor: persistence.compareAndSet,
      activate: () => undefined,
    });
  const seed = createProvider();
  await seed.initialize({ refresh: false });
  await seed.refresh({ force: true });
  latest = chain.rollback;
  const first = createProvider();
  const second = createProvider();
  await Promise.all([
    first.initialize({ refresh: false }),
    second.initialize({ refresh: false }),
  ]);
  await Promise.all([
    first.refresh({ force: true }),
    second.refresh({ force: true }),
  ]);
  assert.equal(persistence.current()?.revision, 2);
  assert.equal(
    persistence.current()?.pointerSha256,
    await dataBundleChannelPointerSha256(chain.rollback),
  );
});

test("a version-two pointer can migrate one accepted legacy pointer but legacy movement then fails closed", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signer = {
    keyId: "legacy-channel-test",
    privateKey: keys.privateKey,
  };
  const bundleId = "b".repeat(64);
  const manifestUrl =
    `https://legacy.example/bundles/${bundleId}/manifest.json`;
  const legacy = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 1,
      channel: "stable",
      bundleId,
      manifestUrl,
      publishedAt: "2026-07-30T00:00:00.000Z",
    },
    signer,
  );
  const legacySha256 =
    await dataBundleChannelPointerSha256(legacy);
  const migration = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 2,
      channel: "stable",
      bundleId,
      manifestUrl,
      publishedAt: "2026-07-31T00:00:00.000Z",
      revision: 1,
      previous: {
        pointerSha256: legacySha256,
        pointerUrl: `https://legacy.example/history/${legacySha256}.json`,
      },
      transition: { kind: "publish", fromBundleId: bundleId },
    },
    signer,
  );
  const otherLegacy = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 1,
      channel: "stable",
      bundleId,
      manifestUrl,
      publishedAt: "2026-07-30T00:01:00.000Z",
    },
    signer,
  );
  const persistence = channelCursorPersistence();
  let latest: unknown = legacy;
  const provider = new RemoteRuntimeDataBundleProvider({
    bootstrap: minimalRuntimeSnapshot(bundleId),
    channelUrl: "https://legacy.example/stable.json",
    trustedKeys: { "legacy-channel-test": keys.publicKey },
    loadChannelCursor: persistence.load,
    compareAndSetChannelCursor: persistence.compareAndSet,
    fetch: async (input) => {
      const url = String(input);
      const value = url.endsWith("/stable.json") ? latest : legacy;
      return new Response(JSON.stringify(value), { status: 200 });
    },
    activate: () => undefined,
  });
  await provider.initialize({ refresh: false });
  await provider.refresh({ force: true });
  assert.equal(persistence.current()?.pointerSchemaVersion, 1);
  latest = migration;
  await provider.refresh({ force: true });
  assert.equal(persistence.current()?.revision, 1);
  latest = otherLegacy;
  await assert.rejects(
    provider.refresh({ force: true }),
    /different legacy channel pointer cannot replace/,
  );
});

test("warm providers synchronize a changed durable active pointer", async () => {
  const first = minimalRuntimeSnapshot("1".repeat(64));
  const second = minimalRuntimeSnapshot("2".repeat(64));
  let activeBundleId = first.bundleId;
  const activated: string[] = [];
  const provider = new RemoteRuntimeDataBundleProvider({
    bootstrap: first,
    trustedKeys: {},
    loadActiveBundleId: async () => activeBundleId,
    loadArchived: async (bundleId) =>
      bundleId === second.bundleId ? second : null,
    activate: (snapshot) => {
      activated.push(snapshot.bundleId);
    },
  });
  await provider.initialize({ refresh: false });
  activeBundleId = second.bundleId;
  const lease = await provider.acquireSnapshot();
  assert.equal(lease.snapshot.bundleId, second.bundleId);
  await lease.release();
  assert.deepEqual(activated, [first.bundleId, second.bundleId]);
});

test("long-lived providers use an unref periodic refresh with cleanup", async () => {
  let fetchCalls = 0;
  const provider = new RemoteRuntimeDataBundleProvider({
    bootstrap: minimalRuntimeSnapshot("3".repeat(64)),
    channelUrl: "https://periodic.example/stable.json",
    trustedKeys: {},
    refreshIntervalMs: 5,
    fetch: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 500 });
    },
    activate: () => undefined,
  });
  assert.equal(provider.startPeriodicRefresh(), true);
  assert.equal(provider.getRefreshMode(), "periodic-unref");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fetchCalls > 0);
  provider.stopPeriodicRefresh();
  assert.equal(provider.getRefreshMode(), "request-driven");
  const stoppedAt = fetchCalls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetchCalls, stoppedAt);
});

test("automatic periodic refresh preserves an explicit rollback hold", async () => {
  const previous = minimalRuntimeSnapshot("4".repeat(64));
  const current = minimalRuntimeSnapshot("5".repeat(64));
  let fetchCalls = 0;
  let activeBundleId = current.bundleId;
  let durableHold: Awaited<
    ReturnType<RemoteRuntimeDataBundleProvider["getStatus"]>
  >["rollbackHold"] = null;
  const provider = new RemoteRuntimeDataBundleProvider({
    bootstrap: current,
    channelUrl: "https://periodic.example/stable.json",
    trustedKeys: {},
    refreshIntervalMs: 5,
    loadArchived: async (bundleId) =>
      bundleId === previous.bundleId ? previous : null,
    loadActiveBundleId: async () => activeBundleId,
    loadRollbackHold: async () => durableHold,
    persistRollbackHold: async (hold) => {
      durableHold = hold;
    },
    fetch: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 500 });
    },
    activate: (snapshot) => {
      activeBundleId = snapshot.bundleId;
    },
  });
  await provider.initialize({ refresh: false });
  await provider.rollback(previous.bundleId);
  assert.equal(
    (await provider.getStatus()).rollbackHold?.bundleId,
    previous.bundleId,
  );

  const restartedProvider = new RemoteRuntimeDataBundleProvider({
    bootstrap: previous,
    channelUrl: "https://periodic.example/stable.json",
    trustedKeys: {},
    refreshIntervalMs: 5,
    loadActiveBundleId: async () => activeBundleId,
    loadRollbackHold: async () => durableHold,
    fetch: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 500 });
    },
    activate: (snapshot) => {
      activeBundleId = snapshot.bundleId;
    },
  });
  await restartedProvider.initialize({ refresh: false });
  restartedProvider.startPeriodicRefresh();
  await new Promise((resolve) => setTimeout(resolve, 25));
  restartedProvider.stopPeriodicRefresh();
  assert.equal(fetchCalls, 0);
  assert.ok((await restartedProvider.getStatus()).rollbackHold);
});

test("a verified channel update waits for the active snapshot lease", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signer = {
    keyId: "provider-test",
    privateKey: keys.privateKey,
  };
  const trustedKeys = {
    "provider-test": keys.publicKey,
  };
  const current = await signRuntimeDataBundle(
    await buildRuntimeDataBundle({
      createdAt: "2026-07-30T00:00:00.000Z",
    }),
    signer,
  );
  const changedRules = serializeRuntimeRulesData();
  const custodes = changedRules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
      "adeptus-custodes",
  ) as { points?: Array<{ cost: number }> } | undefined;
  assert.ok(custodes?.points?.[0]);
  custodes.points[0].cost += 5;
  const candidateBuild = await buildRuntimeDataBundle({
    rulesData: changedRules,
    createdAt: "2026-07-31T00:00:00.000Z",
  });
  candidateBuild.draft.provenance.newRecruit.commit = "3".repeat(40);
  const candidate = await signRuntimeDataBundle(
    candidateBuild,
    signer,
  );
  const bootstrap = await verifyRuntimeDataBundle({
    manifest: current.manifest,
    shards: current.shards,
    trustedKeys,
  });
  assert.equal(bootstrap.ok, true);
  if (!bootstrap.ok) assert.fail("Bootstrap verification failed.");

  const manifestUrl = `https://data.example/bundles/${candidate.manifest.bundleId}/manifest.json`;
  const pointer = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 1,
      channel: "stable",
      bundleId: candidate.manifest.bundleId,
      manifestUrl,
      publishedAt: "2026-07-31T00:01:00.000Z",
    },
    signer,
  );
  const responses = new Map<string, unknown>([
    ["https://data.example/stable.json", pointer],
    [manifestUrl, candidate.manifest],
    ...candidate.manifest.shards.map(
      (descriptor) =>
        [
          new URL(descriptor.path, manifestUrl).toString(),
          candidate.shards.find(
            (shard) => shard.shardId === descriptor.shardId,
          ),
        ] as const,
    ),
  ]);
  const activated: string[] = [];
  let fetchCalls = 0;
  let clock = Date.parse("2026-07-31T00:02:00.000Z");
  let finishCandidateActivation!: () => void;
  let candidateActivationStarted!: () => void;
  const candidateActivationEntered = new Promise<void>(
    (resolve) => {
      candidateActivationStarted = resolve;
    },
  );
  const candidateActivationGate = new Promise<void>((resolve) => {
    finishCandidateActivation = resolve;
  });
  const provider = new RemoteRuntimeDataBundleProvider({
    bootstrap: bootstrap.data,
    channelUrl: "https://data.example/stable.json",
    trustedKeys,
    initialQuarantinedScopes: [
      {
        scope: "faction:adeptus-custodes",
        bundleId: candidate.manifest.bundleId,
        reason: "Earlier candidate assessment failed.",
      },
    ],
    fetch: async (input) => {
      fetchCalls += 1;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const body = responses.get(url);
      return body === undefined
        ? new Response("missing", { status: 404 })
        : Response.json(body);
    },
    activate: async (snapshot) => {
      activated.push(snapshot.bundleId);
      if (snapshot.bundleId === candidate.manifest.bundleId) {
        candidateActivationStarted();
        await candidateActivationGate;
      }
    },
    now: () => new Date(clock),
  });
  await provider.initialize({ refresh: false });
  const lease = await provider.acquireSnapshot();
  const refresh = await provider.refresh({ force: true });

  assert.equal(refresh.activatedBundleId, null);
  assert.equal(refresh.classification?.classification, "rules");
  assert.equal(refresh.status.state, "candidate-ready");
  assert.deepEqual(activated, [current.manifest.bundleId]);

  const releasePromise = lease.release();
  await candidateActivationEntered;
  let nextLeaseResolved = false;
  const nextLeasePromise = provider.acquireSnapshot().then(
    (nextLease) => {
      nextLeaseResolved = true;
      return nextLease;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    nextLeaseResolved,
    false,
    "a request must not lease the old snapshot while activation is committing",
  );
  finishCandidateActivation();
  await releasePromise;
  const nextLease = await nextLeasePromise;
  assert.equal(
    nextLease.snapshot.bundleId,
    candidate.manifest.bundleId,
  );
  await nextLease.release();
  assert.equal(
    (await provider.getStatus()).activeBundleId,
    candidate.manifest.bundleId,
  );
  assert.deepEqual(
    (await provider.getStatus()).quarantinedScopes,
    [],
  );
  assert.deepEqual(activated, [
    current.manifest.bundleId,
    candidate.manifest.bundleId,
  ]);

  const rollback = await provider.rollback(
    current.manifest.bundleId,
  );
  assert.equal(rollback.activeBundleId, current.manifest.bundleId);
  assert.deepEqual(rollback.rollbackHold, {
    bundleId: current.manifest.bundleId,
    engagedAt: "2026-07-31T00:02:00.000Z",
    release: "force-refresh",
  });
  assert.deepEqual(activated, [
    current.manifest.bundleId,
    candidate.manifest.bundleId,
    current.manifest.bundleId,
  ]);

  clock += 16 * 60_000;
  const fetchesBeforeDueCheck = fetchCalls;
  const rolledBackLease = await provider.acquireSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCalls, fetchesBeforeDueCheck);
  assert.equal(
    rolledBackLease.snapshot.bundleId,
    current.manifest.bundleId,
  );
  await rolledBackLease.release();
  const heldRefresh = await provider.refresh();
  assert.equal(heldRefresh.activatedBundleId, null);
  assert.equal(fetchCalls, fetchesBeforeDueCheck);
  assert.equal(
    heldRefresh.status.activeBundleId,
    current.manifest.bundleId,
  );
  assert.ok(heldRefresh.status.rollbackHold);

  const explicitRefresh = await provider.refresh({ force: true });
  assert.equal(
    explicitRefresh.activatedBundleId,
    candidate.manifest.bundleId,
  );
  assert.equal(explicitRefresh.status.rollbackHold, null);
  assert.equal(
    explicitRefresh.status.activeBundleId,
    candidate.manifest.bundleId,
  );
});

test("a signed partial roll-forward reports retained scopes while remaining active", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signer = {
    keyId: "partial-provider-test",
    privateKey: keys.privateKey,
  };
  const trustedKeys = {
    "partial-provider-test": keys.publicKey,
  };
  const previousBuild = await buildRuntimeDataBundle({
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  const previousSigned = await signRuntimeDataBundle(
    previousBuild,
    signer,
  );
  const previous = await verifyRuntimeDataBundle({
    manifest: previousSigned.manifest,
    shards: previousSigned.shards,
    trustedKeys,
  });
  if (!previous.ok) {
    assert.fail(`Previous runtime bundle failed verification: ${previous.message}`);
  }

  const rules = serializeRuntimeRulesData();
  const aeldari = rules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
      "aeldari",
  ) as { points?: Array<{ cost: number }> } | undefined;
  assert.ok(aeldari?.points?.[0]);
  aeldari.points[0].cost += 5;
  const candidate = await buildRuntimeDataBundle({
    rulesData: rules,
    createdAt: "2026-07-31T00:00:00.000Z",
  });
  const composed =
    await composeRuntimeDataBundleRetainingVerifiedShards({
      candidate,
      previous: previous.data,
      quarantinedFactions: [
        {
          factionId: "aeldari",
          scopes: ["faction:aeldari:certification"],
          reason: "Aeldari certification failed.",
        },
      ],
    });
  const partialSigned = await signRuntimeDataBundle(
    composed,
    signer,
  );
  const partial = await verifyRuntimeDataBundle({
    manifest: partialSigned.manifest,
    shards: partialSigned.shards,
    trustedKeys,
  });
  if (!partial.ok) {
    assert.fail(`Partial runtime bundle failed verification: ${partial.message}`);
  }

  const provider = new RemoteRuntimeDataBundleProvider({
    bootstrap: partial.data,
    trustedKeys,
    activate: () => undefined,
  });
  const status = await provider.getStatus();
  assert.equal(status.state, "offline");
  assert.equal(
    status.activeBundleId,
    partialSigned.manifest.bundleId,
  );
  assert.deepEqual(
    status.quarantinedScopes.map((entry) => entry.scope),
    [
      "faction:aeldari:certification",
      "faction:drukhari:dependency",
    ],
  );
  assert.ok(
    status.quarantinedScopes.every((entry) =>
      entry.reason.includes(previousSigned.manifest.bundleId),
    ),
  );
});

test("release-authority trust never bypasses schema or shard integrity", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signer = {
    keyId: "provider-integrity-test",
    privateKey: keys.privateKey,
  };
  const trustedKeys = {
    "provider-integrity-test": keys.publicKey,
  };
  const current = await signRuntimeDataBundle(
    await buildRuntimeDataBundle({
      createdAt: "2026-07-30T00:00:00.000Z",
    }),
    signer,
  );
  const bootstrap = await verifyRuntimeDataBundle({
    manifest: current.manifest,
    shards: current.shards,
    trustedKeys,
  });
  if (!bootstrap.ok) {
    assert.fail(`Bootstrap verification failed: ${bootstrap.message}`);
  }

  const providerFor = async (
    candidate: Awaited<
      ReturnType<typeof signRuntimeDataBundle>
    >,
    tamperShard: boolean,
  ) => {
    const manifestUrl =
      `https://integrity.example/bundles/` +
      `${candidate.manifest.bundleId}/manifest.json`;
    const pointer = await createSignedDataBundleChannelPointer(
      {
        schemaVersion: 1,
        channel: "stable",
        bundleId: candidate.manifest.bundleId,
        manifestUrl,
        publishedAt: "2026-07-31T00:01:00.000Z",
      },
      signer,
    );
    const responses = new Map<string, unknown>([
      ["https://integrity.example/stable.json", pointer],
      [manifestUrl, candidate.manifest],
      ...candidate.manifest.shards.map((descriptor) => {
        const shard = candidate.shards.find(
          (entry) => entry.shardId === descriptor.shardId,
        );
        const body =
          tamperShard && descriptor.kind === "faction"
            ? {
                ...structuredClone(shard),
                data: {
                  ...(structuredClone(shard?.data) as object),
                  tampered: true,
                },
              }
            : shard;
        return [
          new URL(descriptor.path, manifestUrl).toString(),
          body,
        ] as const;
      }),
    ]);
    return new RemoteRuntimeDataBundleProvider({
      bootstrap: bootstrap.data,
      channelUrl: "https://integrity.example/stable.json",
      trustedKeys,
      fetch: async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const body = responses.get(url);
        return body === undefined
          ? new Response("missing", { status: 404 })
          : Response.json(body);
      },
      activate: () => undefined,
    });
  };

  const unsupportedBuild = await buildRuntimeDataBundle({
    createdAt: "2026-07-31T00:00:00.000Z",
  });
  unsupportedBuild.draft.engineDataSchemaVersion = 3;
  const unsupported = await signRuntimeDataBundle(
    unsupportedBuild,
    signer,
  );
  const unsupportedProvider = await providerFor(
    unsupported,
    false,
  );
  await assert.rejects(
    unsupportedProvider.refresh({ force: true }),
    /unsupported engine data schema 3/,
  );

  const candidate = await signRuntimeDataBundle(
    await buildRuntimeDataBundle({
      createdAt: "2026-07-31T00:00:00.000Z",
    }),
    signer,
  );
  const tamperedProvider = await providerFor(candidate, true);
  await assert.rejects(
    tamperedProvider.refresh({ force: true }),
    /does not match its signed content hash/,
  );
  assert.equal(
    (await tamperedProvider.getStatus()).state,
    "degraded",
  );
});

test("remote activation quarantines a signed verified-to-unavailable authority downgrade", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signer = {
    keyId: "authority-downgrade-test",
    privateKey: keys.privateKey,
  };
  const trustedKeys = {
    "authority-downgrade-test": keys.publicKey,
  };
  const verifiedAuthority = {
    status: "verified" as const,
    sourceArtifactSha256: "1".repeat(64),
    overlaySha256: "2".repeat(64),
    receiptSha256: "3".repeat(64),
    extractorId: "reviewed-extractor",
    extractorKeyId: "reviewed-extractor-key",
  };
  const current = await signRuntimeDataBundle(
    await buildRuntimeDataBundle({
      officialAuthority: verifiedAuthority,
      createdAt: "2026-07-30T00:00:00.000Z",
    }),
    signer,
  );
  const bootstrap = await verifyRuntimeDataBundle({
    manifest: current.manifest,
    shards: current.shards,
    trustedKeys,
  });
  if (!bootstrap.ok) assert.fail(bootstrap.message);
  const candidate = await signRuntimeDataBundle(
    await buildRuntimeDataBundle({
      officialAuthority: {
        status: "unavailable",
        reason: "The extractor receipt was omitted.",
      },
      createdAt: "2026-07-31T00:00:00.000Z",
    }),
    signer,
  );
  const manifestUrl =
    `https://authority.example/bundles/${candidate.manifest.bundleId}/manifest.json`;
  const pointer = await createSignedDataBundleChannelPointer(
    {
      schemaVersion: 1,
      channel: "stable",
      bundleId: candidate.manifest.bundleId,
      manifestUrl,
      publishedAt: "2026-07-31T00:01:00.000Z",
    },
    signer,
  );
  const responses = new Map<string, unknown>([
    ["https://authority.example/stable.json", pointer],
    [manifestUrl, candidate.manifest],
    ...candidate.manifest.shards.map((descriptor) => [
      new URL(descriptor.path, manifestUrl).toString(),
      candidate.shards.find(
        (shard) => shard.shardId === descriptor.shardId,
      ),
    ] as const),
  ]);
  const provider = new RemoteRuntimeDataBundleProvider({
    bootstrap: bootstrap.data,
    channelUrl: "https://authority.example/stable.json",
    trustedKeys,
    fetch: async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const body = responses.get(url);
      return body === undefined
        ? new Response("missing", { status: 404 })
        : Response.json(body);
    },
    activate: () => undefined,
  });
  await provider.initialize({ refresh: false });
  const refreshed = await provider.refresh({ force: true });
  assert.equal(refreshed.activatedBundleId, null);
  assert.equal(
    refreshed.classification?.classification,
    "ambiguous/regressive",
  );
  assert.deepEqual(
    refreshed.classification?.changedScopes,
    ["official-authority"],
  );
  assert.equal(
    refreshed.status.officialAuthority?.status,
    "verified",
  );
});

test("channel downloads are bounded by declared and streamed byte size", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signer = {
    keyId: "provider-size-test",
    privateKey: keys.privateKey,
  };
  const trustedKeys = {
    "provider-size-test": keys.publicKey,
  };
  const signed = await signRuntimeDataBundle(
    await buildRuntimeDataBundle({
      createdAt: "2026-07-30T00:00:00.000Z",
    }),
    signer,
  );
  const verified = await verifyRuntimeDataBundle({
    manifest: signed.manifest,
    shards: signed.shards,
    trustedKeys,
  });
  if (!verified.ok) {
    assert.fail(`Bootstrap verification failed: ${verified.message}`);
  }

  const attempts: Array<{
    label: string;
    response: () => Response;
  }> = [
    {
      label: "declared content length",
      response: () =>
        new Response("{}", {
          headers: {
            "content-length": String(256 * 1024 + 1),
          },
        }),
    },
    {
      label: "streamed body length",
      response: () =>
        new Response(" ".repeat(256 * 1024) + "{}"),
    },
  ];
  for (const attempt of attempts) {
    let fetchCalls = 0;
    const provider: RemoteRuntimeDataBundleProvider =
      new RemoteRuntimeDataBundleProvider({
        bootstrap: verified.data,
        channelUrl: "https://size.example/stable.json",
        trustedKeys,
        fetch: async () => {
          fetchCalls += 1;
          return attempt.response();
        },
        activate: () => undefined,
      });
    await assert.rejects(
      provider.refresh({ force: true }),
      /larger than the 262144-byte limit/,
      attempt.label,
    );
    assert.equal(fetchCalls, 1, attempt.label);
    const providerStatus: Awaited<
      ReturnType<RemoteRuntimeDataBundleProvider["getStatus"]>
    > = await provider.getStatus();
    assert.equal(providerStatus.state, "degraded", attempt.label);
    assert.equal(
      providerStatus.quarantinedScopes[0]?.scope,
      "channel",
      attempt.label,
    );
  }
});
