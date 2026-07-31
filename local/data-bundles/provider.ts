import {
  createDataBundleSnapshot,
  type AcquireDataBundleSnapshotOptions,
  type DataBundleProvider,
  type DataBundleProviderStatus,
  type DataBundleSnapshot,
  type DataBundleSnapshotLease,
  type Ed25519KeyRegistry,
  type RefreshDataBundleOptions,
  type RefreshDataBundleResult,
  type VerifiedDataBundleShardV1,
} from "../../lib/rosterpilot/data-bundle";
import {
  RemoteRuntimeDataBundleProvider,
  type RuntimeDataBundleCandidateValidator,
} from "../../lib/rosterpilot/remote-data-bundle-provider";
import {
  activateRuntimeDataBundle,
  assertRuntimeDataBundleShardData,
  type RuntimeDataBundleShardDataV1,
} from "../../lib/rosterpilot/runtime-data-bundle";
import {
  createLocalDataBundleStore,
  type LocalDataBundleStore,
  type LocalDataBundleInstallInput,
} from "./store";

export type CreateLocalRuntimeDataBundleProviderOptions = {
  rootDirectory: string;
  trustedKeys: Ed25519KeyRegistry;
  channelUrl?: string | null;
  fetch?: typeof fetch;
  now?: () => Date;
  refreshIntervalMs?: number;
  validateCandidate?: RuntimeDataBundleCandidateValidator;
  refreshOnInitialize?: boolean;
  periodicRefresh?: boolean;
  bootstrap?: LocalDataBundleInstallInput;
};

function runtimeSnapshot(
  snapshot: DataBundleSnapshot<unknown>,
): DataBundleSnapshot<RuntimeDataBundleShardDataV1> {
  const shards: Array<
    VerifiedDataBundleShardV1<RuntimeDataBundleShardDataV1>
  > = [];
  for (const descriptor of snapshot.manifest.shards) {
    const shard = snapshot.getShard(descriptor.shardId);
    if (!shard) {
      throw new Error(
        `Installed bundle is missing shard ${descriptor.shardId}.`,
      );
    }
    assertRuntimeDataBundleShardData(shard.data, descriptor);
    shards.push(
      shard as VerifiedDataBundleShardV1<RuntimeDataBundleShardDataV1>,
    );
  }
  return createDataBundleSnapshot(snapshot.manifest, shards, {
    acquiredAt: snapshot.acquiredAt,
  });
}

function shardFiles(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
): Record<string, unknown> {
  return Object.fromEntries(
    snapshot.manifest.shards.map((descriptor) => {
      const shard = snapshot.getShard(descriptor.shardId);
      if (!shard) {
        throw new Error(
          `Verified candidate is missing shard ${descriptor.shardId}.`,
        );
      }
      return [descriptor.path, shard];
    }),
  );
}

class LocalRuntimeDataBundleProvider
  implements DataBundleProvider<RuntimeDataBundleShardDataV1>
{
  readonly #store: LocalDataBundleStore;
  readonly #remote: RemoteRuntimeDataBundleProvider;

  constructor(
    store: LocalDataBundleStore,
    remote: RemoteRuntimeDataBundleProvider,
  ) {
    this.#store = store;
    this.#remote = remote;
  }

  async acquireSnapshot(
    options: AcquireDataBundleSnapshotOptions = {},
  ): Promise<
    DataBundleSnapshotLease<RuntimeDataBundleShardDataV1>
  > {
    const runtimeLease = await this.#remote.acquireSnapshot(options);
    try {
      const persistentLease =
        await this.#store.acquireSnapshot({
          ...options,
          bundleId: runtimeLease.snapshot.bundleId,
        });
      if (
        persistentLease.snapshot.bundleId !==
        runtimeLease.snapshot.bundleId
      ) {
        await persistentLease.release();
        throw new Error(
          "The active runtime data bundle and persistent bundle store disagree.",
        );
      }
      let released = false;
      return {
        leaseId: runtimeLease.leaseId,
        snapshot: runtimeSnapshot(persistentLease.snapshot),
        get released() {
          return released;
        },
        async release() {
          if (released) return;
          await persistentLease.release();
          await runtimeLease.release();
          released = true;
        },
      };
    } catch (error) {
      await runtimeLease.release();
      throw error;
    }
  }

  async getStatus(): Promise<DataBundleProviderStatus> {
    const [runtime, local] = await Promise.all([
      this.#remote.getStatus(),
      this.#store.getStatus(),
    ]);
    const storedQuarantines = local.quarantines.map((entry) => ({
      scope: entry.scopes.join(",") || "bundle",
      bundleId: entry.bundleId,
      reason: entry.reason,
    }));
    return {
      ...runtime,
      state:
        local.state === "degraded" && runtime.state === "ready"
          ? "degraded"
          : runtime.state,
      quarantinedScopes: [
        ...runtime.quarantinedScopes,
        ...storedQuarantines.filter(
          (entry) =>
            !runtime.quarantinedScopes.some(
              (runtimeEntry) =>
                runtimeEntry.bundleId === entry.bundleId &&
                runtimeEntry.scope === entry.scope,
            ),
        ),
      ],
      rollbackHold: local.rollbackHold,
    };
  }

  refresh(
    options?: RefreshDataBundleOptions,
  ): Promise<RefreshDataBundleResult> {
    return this.#remote.refresh(options);
  }

  async rollback(bundleId: string): Promise<DataBundleProviderStatus> {
    await this.#remote.rollback(bundleId);
    return this.getStatus();
  }

  async retainReference(
    referenceId: string,
    bundleId: string,
  ): Promise<void> {
    await this.#store.setBundleReference(referenceId, bundleId);
  }

  async releaseReference(
    referenceId: string,
    bundleId?: string,
  ): Promise<void> {
    await this.#store.removeBundleReference(referenceId, {
      ...(bundleId ? { bundleId } : {}),
    });
  }

  getRefreshMode() {
    return this.#remote.getRefreshMode();
  }

  startPeriodicRefresh(): boolean {
    return this.#remote.startPeriodicRefresh();
  }

  stopPeriodicRefresh(): void {
    this.#remote.stopPeriodicRefresh();
  }
}

export async function createLocalRuntimeDataBundleProvider(
  options: CreateLocalRuntimeDataBundleProviderOptions,
): Promise<
  DataBundleProvider<RuntimeDataBundleShardDataV1> & {
    getStore(): LocalDataBundleStore;
    getRefreshMode(): ReturnType<
      RemoteRuntimeDataBundleProvider["getRefreshMode"]
    >;
    startPeriodicRefresh(): boolean;
    stopPeriodicRefresh(): void;
  }
> {
  const store = createLocalDataBundleStore({
    rootDirectory: options.rootDirectory,
    trustedKeys: options.trustedKeys,
    now: options.now,
    validateShardData: (data, descriptor) => {
      assertRuntimeDataBundleShardData(data, descriptor);
    },
  });
  let installed;
  try {
    const status = await store.getStatus();
    if (
      status.rollbackHold &&
      status.activeBundleId !== status.rollbackHold.bundleId
    ) {
      await store.activateBundle(status.rollbackHold.bundleId);
    }
    installed = await store.loadActiveBundle();
  } catch (error) {
    if (!options.bootstrap) throw error;
    await store.installBundle(options.bootstrap, {
      activate: true,
    });
    installed = await store.loadActiveBundle();
  }
  const bootstrap = runtimeSnapshot(installed.snapshot);
  const remote = new RemoteRuntimeDataBundleProvider({
    bootstrap,
    channelUrl: options.channelUrl,
    trustedKeys: options.trustedKeys,
    fetch: options.fetch,
    now: options.now,
    refreshIntervalMs: options.refreshIntervalMs,
    validateCandidate: options.validateCandidate,
    persistVerified: async ({ snapshot, classification }) => {
      await store.installBundle(
        {
          manifest: snapshot.manifest,
          shards: shardFiles(snapshot),
          acceptance: {
            classification:
              classification.classification,
            certificationStatus:
              classification.classification ===
              "provenance-only"
                ? "not-required"
                : "passed",
          },
        },
        { activate: false },
      );
    },
    loadArchived: async (bundleId) => {
      try {
        return runtimeSnapshot(
          (await store.loadBundle(bundleId)).snapshot,
        );
      } catch {
        return null;
      }
    },
    loadActiveBundleId: async () =>
      (await store.getStatus()).activeBundleId,
    initialChannelCursor: await store.getChannelCursor(),
    loadChannelCursor: async () => store.getChannelCursor(),
    compareAndSetChannelCursor: async (input) =>
      store.compareAndSetChannelCursor(input),
    initialRollbackHold: (await store.getStatus()).rollbackHold,
    loadRollbackHold: async () =>
      (await store.getStatus()).rollbackHold,
    persistRollbackHold: async (hold) => {
      await store.setRollbackHold(hold);
    },
    clearRollbackHold: async () => {
      await store.clearRollbackHold();
    },
    recordQuarantine: async ({ bundleId, scopes, reason }) => {
      const localStatus = await store.getStatus();
      if (
        localStatus.bundles.some(
          (entry) => entry.bundleId === bundleId,
        )
      ) {
        await store.quarantineBundle(bundleId, {
          reason,
          scopes,
        });
      }
    },
    activate: async (snapshot) => {
      const status = await store.getStatus();
      const previousBundleId = status.activeBundleId;
      const previous = previousBundleId
        ? await store.loadBundle(previousBundleId)
        : null;
      if (status.activeBundleId !== snapshot.bundleId) {
        await store.activateBundle(snapshot.bundleId);
      }
      try {
        activateRuntimeDataBundle(snapshot);
      } catch (error) {
        if (
          previousBundleId &&
          previousBundleId !== snapshot.bundleId
        ) {
          if (status.rollbackHold?.bundleId === snapshot.bundleId) {
            await store.clearRollbackHold();
          }
          await store.activateBundle(previousBundleId);
          if (previous) {
            activateRuntimeDataBundle(
              runtimeSnapshot(previous.snapshot),
            );
          }
        }
        throw error;
      }
      await store.enforceRetention();
    },
  });
  await remote.initialize({
    refresh: options.refreshOnInitialize ?? true,
  });
  if (options.periodicRefresh) remote.startPeriodicRefresh();
  const provider = new LocalRuntimeDataBundleProvider(store, remote);
  return Object.assign(provider, {
    getStore: () => store,
  });
}
