import {
  readFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { z } from "zod";

import {
  configureDataBundleProvider,
  configureLocalDataUpdateControl,
  type LocalDataUpdateControlStatus,
} from "../../lib/rosterpilot/data-operations";
import type {
  DataBundleSnapshot,
  Ed25519KeyRegistry,
} from "../../lib/rosterpilot/data-bundle";
import {
  rosterPilotSupportDirectory,
  projectRoot,
} from "../agent/paths";
import {
  assertRuntimeDataBundleShardData,
  type RuntimeDataBundleShardDataV1,
} from "../../lib/rosterpilot/runtime-data-bundle";
import {
  createLocalRuntimeDataBundleProvider,
} from "./provider";
import type {
  LocalDataBundleInstallInput,
} from "./store";
import {
  createLocalDataBundleStore,
} from "./store";
import {
  defaultLocalDataBundleEnvironment,
} from "./defaults";
import {
  createLocalSourceUpdateCoordinator,
  type LocalSourceCandidateConsumer,
  type LocalSourceUpdateJobV1,
} from "./local-source-updater";
import {
  verifyLocalSourceCandidate,
} from "./local-source-candidate";
import {
  createServiceCompatibilityStore,
  deriveSnapshotServiceIdentity,
  sameNewRecruitServiceIdentity,
  type NewRecruitServiceIdentityV1,
} from "./service-compatibility";
import {
  MAX_BSDATA_COMPATIBILITY_COMMITS,
  resolveBsDataHistoryIdentity,
} from "./bsdata-history";

const trustedKeyFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    keys: z.array(
      z
        .object({
          keyId: z.string().min(1),
          publicKey: z
            .object({
              kty: z.literal("OKP"),
              crv: z.literal("Ed25519"),
              x: z.string().min(1),
            })
            .passthrough(),
        })
        .strict(),
    ),
  })
  .strict();

export type LocalDataBundleConfigurationResult = {
  configured: boolean;
  reason: string | null;
  activeBundleId: string | null;
};

async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function readTrustedKeys(): Promise<Ed25519KeyRegistry> {
  const configured = defaultLocalDataBundleEnvironment(
    projectRoot,
  ).trustedKeysFile;
  try {
    const parsed = trustedKeyFileSchema.parse(
      await readJson(configured),
    );
    return Object.fromEntries(
      parsed.keys.map((entry) => [
        entry.keyId,
        entry.publicKey as JsonWebKey,
      ]),
    );
  } catch (error) {
    if (process.env.ROSTERPILOT_DATA_TRUSTED_KEYS_FILE) {
      throw error;
    }
    return {};
  }
}

async function readBootstrapBundle(
  directory: string,
): Promise<LocalDataBundleInstallInput> {
  const manifest = await readJson(
    path.join(directory, "manifest.json"),
  );
  const descriptors = z
    .object({
      shards: z.array(
        z.object({ path: z.string().min(1) }).passthrough(),
      ),
    })
    .passthrough()
    .parse(manifest).shards;
  return {
    manifest,
    shards: Object.fromEntries(
      await Promise.all(
        descriptors.map(async (descriptor) => [
          descriptor.path,
          await readJson(
            path.resolve(
              directory,
              ...descriptor.path.split("/"),
            ),
          ),
        ]),
      ),
    ),
  };
}

let initialization:
  | Promise<LocalDataBundleConfigurationResult>
  | null = null;
type LocalRuntimeProvider = Awaited<
  ReturnType<typeof createLocalRuntimeDataBundleProvider>
>;
let activeProvider: LocalRuntimeProvider | null = null;
let localUpdateCoordinator: ReturnType<
  typeof createLocalSourceUpdateCoordinator
> | null = null;
let localUpdateTimer: ReturnType<typeof setInterval> | null = null;
let providerAdoption: Promise<LocalRuntimeProvider | null> | null =
  null;

function wakeLocalDataUpdateWorker(): void {
  if (process.env.ROSTERPILOT_LOCAL_UPDATE_WORKER === "1") return;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(projectRoot, "scripts", "run-local-data-update-worker.ts"),
    ],
    {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        NODE_ENV: "production",
        ROSTERPILOT_SUPPORT_DIRECTORY: rosterPilotSupportDirectory(),
        ROSTERPILOT_DATA_PROVIDER_MODE: "local-source",
        ROSTERPILOT_LOCAL_UPDATE_WORKER: "1",
      },
    },
  );
  child.once("error", () => undefined);
  child.unref();
}

function dataBundleRoot(): string {
  return path.join(rosterPilotSupportDirectory(), "data-bundles");
}

function updateJobProjection(
  job: LocalSourceUpdateJobV1 | null,
): LocalDataUpdateControlStatus["localUpdate"] {
  return job
    ? {
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
        retryAt: job.retryAt,
        trigger: job.trigger,
        forced: job.forced,
        bsDataCommitOverride: job.bsDataCommitOverride,
        quarantinedScopes: job.quarantinedScopes,
        error: job.error,
      }
    : null;
}

async function localControlStatus(): Promise<LocalDataUpdateControlStatus> {
  if (!localUpdateCoordinator) return { localUpdate: null };
  const status = await localUpdateCoordinator.getStatus();
  const job =
    status.activeJob ??
    (status.state.lastJobId
      ? await localUpdateCoordinator.getJob(status.state.lastJobId)
      : null);
  const observation = status.state.latestObservation;
  let latestLocallyCertified:
    | NonNullable<
        NonNullable<LocalDataUpdateControlStatus["sourceStatus"]>["latestLocallyCertified"]
      >
    | null = null;
  const bundleStore =
    activeProvider?.getStore() ??
    createLocalDataBundleStore({
      rootDirectory: dataBundleRoot(),
      trustedKeys: await readTrustedKeys(),
      validateShardData: (data, descriptor) => {
        assertRuntimeDataBundleShardData(data, descriptor);
      },
    });
  const bundleStoreStatus = await bundleStore.getStatus().catch(() => null);
  for (const entry of (bundleStoreStatus?.bundles ?? [])
    .filter(
      (candidate) =>
        candidate.integrity === "verified" &&
        candidate.trustOrigin === "locally-verified",
    )
    .sort((left, right) =>
      (right.installedAt ?? "").localeCompare(left.installedAt ?? ""),
    )) {
    const installed = await bundleStore.loadBundle(entry.bundleId).catch(() => null);
    try {
      if (installed?.snapshot.trustOrigin === "locally-verified") {
        const candidate = {
          bundleId: installed.snapshot.bundleId,
          rulesVersion:
            installed.snapshot.manifest.provenance.rules.version,
          newRecruitCommit:
            installed.snapshot.manifest.provenance.newRecruit.commit,
          certifiedAt: installed.snapshot.manifest.createdAt,
        };
        if (
          !latestLocallyCertified ||
          candidate.certifiedAt > latestLocallyCertified.certifiedAt
        ) {
          latestLocallyCertified = candidate;
        }
      }
    } catch {
      // A corrupt archive is excluded from status and remains visible in the
      // store integrity diagnostics.
    }
  }
  const registry = createServiceCompatibilityStore({
    rootDirectory: dataBundleRoot(),
  });
  const registryState = await registry.readState().catch(() => null);
  const retainedBundleIds = new Set(
    (bundleStoreStatus?.bundles ?? [])
      .filter((entry) => entry.integrity === "verified")
      .map((entry) => entry.bundleId),
  );
  const latestByFaction = new Map<
    string,
    NonNullable<typeof registryState>["observations"][number]
  >();
  for (const entry of registryState?.observations ?? []) {
    const current = latestByFaction.get(entry.identity.factionId);
    if (
      !current ||
      entry.observedAt > current.observedAt ||
      (
        entry.observedAt === current.observedAt &&
        (
          entry.recordedAt > current.recordedAt ||
          (
            entry.recordedAt === current.recordedAt &&
            entry.tessera !== null &&
            current.tessera === null
          )
        )
      )
    ) {
      latestByFaction.set(entry.identity.factionId, entry);
    }
  }
  const serviceCompatibility = [...latestByFaction.values()].flatMap(
    (entry) => {
      const compatible = registryState?.snapshotReferences
        .filter(
          (reference) =>
            retainedBundleIds.has(reference.bundleId) &&
            sameNewRecruitServiceIdentity(
              reference.identity,
              entry.identity,
            ),
        )
        .sort((left, right) =>
          right.snapshotCreatedAt.localeCompare(
            left.snapshotCreatedAt,
          ),
        )[0];
      const common = {
        factionId: entry.identity.factionId,
        observedAt: entry.observedAt,
        gameSystemId: entry.identity.gameSystem.id,
        gameSystemRevision: entry.identity.gameSystem.revision,
        catalogueId: entry.identity.factionCatalogue.id,
        catalogueRevision:
          entry.identity.factionCatalogue.revision,
        compatibleBundleId: compatible?.bundleId ?? null,
      };
      return [
        { service: "new-recruit" as const, ...common },
        ...(entry.tessera
          ? [{ service: "tessera-web" as const, ...common }]
          : []),
      ];
    },
  );
  return {
    localUpdate: updateJobProjection(job),
    sourceStatus: {
      latestUpstream: {
        rulesVersion: observation?.rules.version ?? null,
        newRecruitCommit:
          observation?.newRecruit.commit ?? null,
        officialContentSha256:
          observation?.official.observedContentSha256 ?? null,
      },
      latestLocallyCertified,
      officialReconciliation:
        job?.officialReconciliation ??
        (observation?.official.disposition === "update-pending"
          ? "pending"
          : observation?.official.disposition === "current"
            ? "verified"
            : "unavailable"),
    },
    serviceCompatibility,
  };
}

async function reconcileServiceReferences(
  suppliedStore = activeProvider?.getStore(),
): Promise<void> {
  if (!suppliedStore) return;
  const store = suppliedStore;
  const [storeStatus, registryState] = await Promise.all([
    store.getStatus(),
    createServiceCompatibilityStore({
      rootDirectory: dataBundleRoot(),
    }).readState(),
  ]);
  const registry = createServiceCompatibilityStore({
    rootDirectory: dataBundleRoot(),
  });
  const observations = distinctServiceCompatibilityObservations(
    registryState.observations,
  );
  const retainedReferenceKeys = new Set(
    registryState.snapshotReferences.map(
      (reference) =>
        `${reference.bundleId}:${reference.compatibilityKey}`,
    ),
  );
  const installedReferenceIds = new Set(
    storeStatus.references.map((reference) => reference.referenceId),
  );
  const verifiedBundleIds = new Set(
    storeStatus.bundles
      .filter((bundle) => bundle.integrity === "verified")
      .map((bundle) => bundle.bundleId),
  );
  for (const reference of registryState.snapshotReferences) {
    if (
      verifiedBundleIds.has(reference.bundleId) &&
      !installedReferenceIds.has(reference.referenceId)
    ) {
      await store.setBundleReference(
        reference.referenceId,
        reference.bundleId,
      );
      installedReferenceIds.add(reference.referenceId);
    }
  }
  for (const bundle of storeStatus.bundles) {
    if (bundle.integrity !== "verified") continue;
    const unresolvedObservations = observations.filter(
      (observation) =>
        !retainedReferenceKeys.has(
          `${bundle.bundleId}:${observation.compatibilityKey}`,
        ),
    );
    if (unresolvedObservations.length === 0) continue;
    const installed = await store.loadBundle(bundle.bundleId);
    for (const observation of unresolvedObservations) {
      let identity;
      try {
        identity = deriveSnapshotServiceIdentity(
          installed.snapshot as DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
          observation.identity.factionId,
        );
      } catch {
        continue;
      }
      if (!sameNewRecruitServiceIdentity(identity, observation.identity)) {
        continue;
      }
      const retainedKey =
        `${bundle.bundleId}:${observation.compatibilityKey}`;
      if (retainedReferenceKeys.has(retainedKey)) continue;
      const reference = await registry.retainCompatibleSnapshot({
        bundleId: bundle.bundleId,
        identity,
        snapshotCreatedAt: installed.snapshot.manifest.createdAt,
        dataTrust: installed.trustOrigin,
        bsDataCommit:
          installed.snapshot.manifest.provenance.newRecruit.commit,
      });
      await store.setBundleReference(
        reference.referenceId,
        bundle.bundleId,
      );
      installedReferenceIds.add(reference.referenceId);
      retainedReferenceKeys.add(retainedKey);
    }
  }
}

export function distinctServiceCompatibilityObservations<
  T extends { compatibilityKey: string },
>(observations: readonly T[]): T[] {
  const distinct = new Map<string, T>();
  for (const observation of observations) {
    if (!distinct.has(observation.compatibilityKey)) {
      distinct.set(observation.compatibilityKey, observation);
    }
  }
  return [...distinct.values()];
}

async function replaceActiveProvider(
  trustedKeys: Ed25519KeyRegistry,
  bootstrap?: LocalDataBundleInstallInput,
): Promise<LocalRuntimeProvider> {
  const provider = await createLocalRuntimeDataBundleProvider({
    rootDirectory: dataBundleRoot(),
    trustedKeys,
    channelUrl: null,
    bootstrap,
    providerMode: "local-source",
    refreshOnInitialize: false,
    periodicRefresh: false,
  });
  const previous = activeProvider;
  activeProvider = provider;
  configureDataBundleProvider(provider);
  previous?.stopPeriodicRefresh();
  return provider;
}

function candidateConsumer(
  trustedKeys: Ed25519KeyRegistry,
): LocalSourceCandidateConsumer {
  return async (reference, context) => {
    const candidate = await verifyLocalSourceCandidate(
      reference.directory,
      { expectedBuilderRoot: projectRoot },
    );
    if (candidate.reference.bundleId !== reference.bundleId) {
      throw new Error(
        "The queued local candidate identity changed before installation.",
      );
    }
    const store =
      activeProvider?.getStore() ??
      createLocalDataBundleStore({
        rootDirectory: dataBundleRoot(),
        trustedKeys,
        validateShardData: (data, descriptor) => {
          assertRuntimeDataBundleShardData(data, descriptor);
        },
      });
    const installed = await store.installBundle(
      {
        manifest: candidate.manifest,
        shards: candidate.shards,
        localBuildReceipt: candidate.receipt,
      },
      { activate: false },
    );
    let activated = false;
    if (context.activate) {
      const before = await store.getStatus();
      if (!before.rollbackHold) {
        try {
          await store.activateBundle(candidate.reference.bundleId);
          if (activeProvider) {
            const providerStatus = await activeProvider.getStatus();
            activated =
              providerStatus.activeBundleId ===
              candidate.reference.bundleId;
          } else {
            const replacement = await replaceActiveProvider(trustedKeys);
            activated =
              (await replacement.getStatus()).activeBundleId ===
              candidate.reference.bundleId;
          }
        } catch (error) {
          if (before.activeBundleId) {
            await store.activateBundle(before.activeBundleId);
            await activeProvider?.getStatus().catch(() => undefined);
          } else {
            await store.clearActiveBundle(candidate.reference.bundleId);
          }
          throw error;
        }
      }
    }
    // Compatibility indexing and pruning are ancillary to the already
    // verified cutover. A damaged index must not make an activated update look
    // failed; Doctor can rebuild it from immutable bundles and receipts.
    await reconcileServiceReferences(store).catch(() => undefined);
    await store.enforceRetention().catch(() => undefined);
    return {
      installed: installed.installed ||
        installed.bundleId === candidate.reference.bundleId,
      activated,
    };
  };
}

export type LocalServiceCompatibilityResult =
  | {
      status: "ready";
      observedIdentity: NewRecruitServiceIdentityV1;
      compatibleBundleId: string;
      jobId: null;
      message: string;
    }
  | {
      status: "updating-local-data";
      observedIdentity: NewRecruitServiceIdentityV1;
      compatibleBundleId: null;
      jobId: string | null;
      message: string;
    }
  | {
      status: "waiting-for-compatible-source";
      observedIdentity: NewRecruitServiceIdentityV1 | null;
      compatibleBundleId: null;
      jobId: null;
      message: string;
    };

export type LocalServiceCompatibilityResolution =
  LocalServiceCompatibilityResult;

/**
 * Resolves one exact receipt-backed New Recruit identity to a retained local
 * snapshot. If a snapshot does not exist yet, this queues the required
 * current-source or historical compatibility build and returns immediately.
 */
export async function ensureLocalServiceCompatibility(input: {
  factionId: string;
  observedRevisionHint?: {
    gameSystemRevision: number;
    catalogueRevision: number;
  };
}): Promise<LocalServiceCompatibilityResult> {
  const registry = createServiceCompatibilityStore({
    rootDirectory: dataBundleRoot(),
  });
  const observation = await registry.latestNewRecruitObservation(
    input.factionId,
  );
  if (!observation) {
    return {
      status: "waiting-for-compatible-source",
      observedIdentity: null,
      compatibleBundleId: null,
      jobId: null,
      message:
        "No receipt-backed New Recruit catalogue identity has been observed for this faction yet. Keep the roster, then retry the existing New Recruit or Tessera preparation so RosterPilot can record the service identity without creating a duplicate list.",
    };
  }
  const identity = observation.identity;
  if (
    input.observedRevisionHint &&
    (identity.gameSystem.revision !==
      input.observedRevisionHint.gameSystemRevision ||
      identity.factionCatalogue.revision !==
        input.observedRevisionHint.catalogueRevision)
  ) {
    return {
      status: "waiting-for-compatible-source",
      observedIdentity: identity,
      compatibleBundleId: null,
      jobId: null,
      message:
        "The supplied revision hint does not match the latest receipt-backed New Recruit observation. RosterPilot kept the roster and will not guess which external catalogue identity to use.",
    };
  }

  await reconcileServiceReferences();
  const retainedBundleIds = activeProvider
    ? new Set(
        (await activeProvider.getStore().getStatus()).bundles
          .filter((bundle) => bundle.integrity === "verified")
          .map((bundle) => bundle.bundleId),
      )
    : new Set<string>();
  const compatible = await registry.findNewestCompatibleSnapshot({
    factionId: input.factionId,
    identity,
    retainedBundleIds,
  });
  if (compatible) {
    return {
      status: "ready",
      observedIdentity: identity,
      compatibleBundleId: compatible.bundleId,
      jobId: null,
      message:
        "A locally verified snapshot exactly matches the receipt-backed New Recruit catalogue identity.",
    };
  }
  if (!localUpdateCoordinator) {
    return {
      status: "waiting-for-compatible-source",
      observedIdentity: identity,
      compatibleBundleId: null,
      jobId: null,
      message:
        "No retained compatible snapshot is installed, and the local-source updater is not available in this deployment. The roster remains saved.",
    };
  }

  const updateStatus = await localUpdateCoordinator.getStatus();
  if (updateStatus.activeJob) {
    return {
      status: "updating-local-data",
      observedIdentity: identity,
      compatibleBundleId: null,
      jobId: updateStatus.activeJob.jobId,
      message:
        "RosterPilot is finishing the existing local data job before resolving this service-compatible snapshot.",
    };
  }

  // A service observation newer than our last upstream check first receives a
  // normal current-source check. This refreshes the allowlisted bare cache and
  // may make the exact service identity available without a history build.
  if (
    !updateStatus.state.lastAttemptAt ||
    updateStatus.state.lastAttemptAt < observation.observedAt
  ) {
    const queued = await localUpdateCoordinator.enqueue({
      trigger: "manual",
      force: true,
    });
    wakeLocalDataUpdateWorker();
    return {
      status: "updating-local-data",
      observedIdentity: identity,
      compatibleBundleId: null,
      jobId: queued.job?.jobId ?? null,
      message:
        "RosterPilot queued a background check of the allowlisted upstream sources. The roster stays usable while it runs.",
    };
  }

  const cacheDirectory = path.join(
    localUpdateCoordinator.rootDirectory,
    "cache",
    "bsdata-wh40k-11e.git",
  );
  let historical;
  try {
    historical = await resolveBsDataHistoryIdentity({
      cacheDirectory,
      identity,
      maxCommits: MAX_BSDATA_COMPATIBILITY_COMMITS,
    });
  } catch {
    const queued = await localUpdateCoordinator.enqueue({
      trigger: "manual",
      force: true,
    });
    wakeLocalDataUpdateWorker();
    return {
      status: "updating-local-data",
      observedIdentity: identity,
      compatibleBundleId: null,
      jobId: queued.job?.jobId ?? null,
      message:
        "RosterPilot queued a background source refresh so it can safely search the local BSData history cache.",
    };
  }
  if (historical.status === "no-match") {
    return {
      status: "waiting-for-compatible-source",
      observedIdentity: identity,
      compatibleBundleId: null,
      jobId: null,
      message:
        `${historical.message} The roster and prior New Recruit receipt were retained; no duplicate import was attempted.`,
    };
  }
  const queued = await localUpdateCoordinator.enqueue({
    trigger: "compatibility",
    force: true,
    bsDataCommitOverride: historical.commit,
  });
  wakeLocalDataUpdateWorker();
  return {
    status: "updating-local-data",
    observedIdentity: identity,
    compatibleBundleId: null,
    jobId: queued.job?.jobId ?? null,
    message:
      "RosterPilot found the exact historical BSData identity and queued an isolated compatibility build using the newest certified rules source. It will not replace the globally active snapshot.",
  };
}

export function initializeLocalDataBundleProvider(): Promise<LocalDataBundleConfigurationResult> {
  if (initialization) return initialization;
  initialization = (async () => {
    const runtimeConfiguration =
      defaultLocalDataBundleEnvironment(projectRoot);
    const trustedKeys = await readTrustedKeys();
    const bootstrapDirectory =
      runtimeConfiguration.bootstrapDirectory;
    let bootstrap: LocalDataBundleInstallInput | undefined;
    try {
      bootstrap = await readBootstrapBundle(bootstrapDirectory);
    } catch (error) {
      if (
        process.env
          .ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY
      ) {
        throw error;
      }
    }
    if (runtimeConfiguration.providerMode === "signed-channel") {
      configureLocalDataUpdateControl(null);
      if (Object.keys(trustedKeys).length === 0) {
        configureDataBundleProvider(null);
        return {
          configured: false,
          reason:
            "The hosted signed-channel mode requires its configured public verification registry.",
          activeBundleId: null,
        };
      }
      const provider = await createLocalRuntimeDataBundleProvider({
        rootDirectory: dataBundleRoot(),
        trustedKeys,
        channelUrl: runtimeConfiguration.channelUrl,
        bootstrap,
        providerMode: "signed-channel",
        periodicRefresh: true,
      });
      activeProvider = provider;
      configureDataBundleProvider(provider);
      const status = await provider.getStatus();
      return {
        configured: true,
        reason: null,
        activeBundleId: status.activeBundleId,
      };
    }

    localUpdateCoordinator = createLocalSourceUpdateCoordinator({
      rootDirectory: path.join(
        rosterPilotSupportDirectory(),
        "data-updates",
      ),
      projectRoot,
      consumeCandidate: candidateConsumer(trustedKeys),
    });
    configureLocalDataUpdateControl({
      getStatus: localControlStatus,
      getJob: async (jobId) =>
        updateJobProjection(
          await localUpdateCoordinator!.getJob(jobId),
        ),
      enqueue: async ({ force }) => {
        if (force) {
          const store =
            activeProvider?.getStore() ??
            createLocalDataBundleStore({
              rootDirectory: dataBundleRoot(),
              trustedKeys,
              validateShardData: (data, descriptor) => {
                assertRuntimeDataBundleShardData(data, descriptor);
              },
            });
          await store.clearRollbackHold();
        }
        const queued = await localUpdateCoordinator!.enqueue({
          trigger: "manual",
          force,
        });
        wakeLocalDataUpdateWorker();
        return {
          jobId: queued.job?.jobId ?? null,
          queued: queued.queued,
        };
      },
    });
    try {
      await replaceActiveProvider(trustedKeys, bootstrap);
    } catch {
      activeProvider = null;
      configureDataBundleProvider(null);
    }
    await localUpdateCoordinator.recoverInterrupted();
    await localUpdateCoordinator.enqueue({
      trigger: "startup",
      force: false,
    });
    if (process.env.ROSTERPILOT_LOCAL_UPDATE_WORKER !== "1") {
      wakeLocalDataUpdateWorker();
      startLocalDataBundlePeriodicRefresh();
    }
    const status = activeProvider
      ? await activeProvider.getStatus()
      : null;
    return {
      configured: true,
      reason: status
        ? null
        : "Compiled data is active while the first locally verified snapshot builds in the background.",
      activeBundleId: status?.activeBundleId ?? null,
    };
  })().catch((error) => {
    activeProvider?.stopPeriodicRefresh();
    activeProvider = null;
    configureLocalDataUpdateControl(null);
    localUpdateCoordinator = null;
    configureDataBundleProvider(null);
    return {
      configured: false,
      reason:
        error instanceof Error
          ? error.message
          : "Local data-bundle initialization failed.",
      activeBundleId: null,
    };
  });
  return initialization;
}

/**
 * Long-lived MCP/agent processes may have started on compiled fallback while
 * a detached worker installed the first local snapshot in another process.
 * Adopt that durable active pointer lazily before the next operation lease.
 */
export async function getCurrentLocalDataBundleProvider(): Promise<
  LocalRuntimeProvider | null
> {
  if (activeProvider) return activeProvider;
  await initializeLocalDataBundleProvider();
  if (activeProvider) return activeProvider;
  if (providerAdoption) return providerAdoption;
  providerAdoption = (async () => {
    try {
      const trustedKeys = await readTrustedKeys();
      const store = createLocalDataBundleStore({
        rootDirectory: dataBundleRoot(),
        trustedKeys,
        validateShardData: (data, descriptor) => {
          assertRuntimeDataBundleShardData(data, descriptor);
        },
      });
      const status = await store.getStatus();
      if (!status.activeBundleId) return null;
      return await replaceActiveProvider(trustedKeys);
    } catch {
      // Ordinary roster work remains on compiled fallback. The durable store
      // and update status preserve the verification failure for Doctor.
      return null;
    }
  })().finally(() => {
    providerAdoption = null;
  });
  return providerAdoption;
}

export function startLocalDataBundlePeriodicRefresh(): boolean {
  if (localUpdateCoordinator) {
    if (localUpdateTimer) return false;
    localUpdateTimer = setInterval(() => {
      void localUpdateCoordinator!
        .enqueue({ trigger: "scheduled", force: false })
        .then(() => wakeLocalDataUpdateWorker())
        .catch(() => undefined);
    }, 60 * 60 * 1_000);
    localUpdateTimer.unref?.();
    return true;
  }
  return activeProvider?.startPeriodicRefresh() ?? false;
}

/** Runs one queued durable job in the detached machine-local worker. */
export async function runQueuedLocalDataBundleUpdate(): Promise<void> {
  if (!localUpdateCoordinator) {
    await initializeLocalDataBundleProvider();
  }
  await localUpdateCoordinator?.runNext();
}

export function stopLocalDataBundlePeriodicRefresh(): void {
  if (localUpdateTimer) {
    clearInterval(localUpdateTimer);
    localUpdateTimer = null;
  }
  activeProvider?.stopPeriodicRefresh();
}

export function resetLocalDataBundleProviderInitializationForTests(): void {
  activeProvider?.stopPeriodicRefresh();
  stopLocalDataBundlePeriodicRefresh();
  activeProvider = null;
  localUpdateCoordinator = null;
  providerAdoption = null;
  initialization = null;
  configureLocalDataUpdateControl(null);
  configureDataBundleProvider(null);
}
