import { z } from "zod";

import {
  configureDataBundleProvider,
  getConfiguredDataBundleProvider,
} from "./data-operations";
import {
  DataBundleManifestV1Schema,
  type DataBundleProvider,
  type DataBundleProviderStatus,
  type Ed25519KeyRegistry,
} from "./data-bundle";
import {
  RemoteRuntimeDataBundleProvider,
  secureDataBundleUrl,
} from "./remote-data-bundle-provider";
import {
  activateRuntimeDataBundle,
  isSupportedRuntimeDataBundleSchemaVersion,
  verifyRuntimeDataBundle,
} from "./runtime-data-bundle";
import type {
  HostedDataBundlePersistence,
  HostedStoredDataBundle,
} from "./hosted-data-bundle-persistence";

const trustedKeyFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    keys: z
      .array(
        z
          .object({
            keyId: z.string().min(1).max(128),
            publicKey: z
              .object({
                kty: z.literal("OKP"),
                crv: z.literal("Ed25519"),
                x: z.string().min(1),
                d: z.never().optional(),
              })
              .passthrough(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((document, context) => {
    const keyIds = document.keys.map((entry) => entry.keyId);
    if (new Set(keyIds).size !== keyIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keys"],
        message: "Trusted data-bundle key ids must be unique.",
      });
    }
  });

export type HostedDataBundleJsonLoader = (
  absoluteUrl: string,
) => Promise<unknown | null>;

export type HostedDataBundleProviderInitializationOptions = {
  channelUrl: string | null | undefined;
  bootstrapManifestUrl: string;
  trustedKeysUrl?: string;
  trustedKeysDocument?: unknown;
  trustedKeys?: Ed25519KeyRegistry;
  loadJson: HostedDataBundleJsonLoader;
  fetch?: typeof fetch;
  refreshIntervalMs?: number;
  scheduleBackground?: (task: Promise<void>) => void;
  periodicRefresh?: boolean;
  persistence?: HostedDataBundlePersistence;
};

export type HostedDataBundleProviderInitializationResult = {
  configured: boolean;
  source: "signed-verified" | "compiled-unverified";
  reason: string | null;
  activeBundleId: string | null;
  refreshScheduled: boolean;
  refreshMode:
    | "disabled"
    | "request-driven"
    | "request-driven-wait-until"
    | "periodic-unref";
  durability: {
    mode: "memory" | "persistent";
    state: "ready" | "degraded";
    reason: string | null;
  };
};

let initialization:
  | Promise<HostedDataBundleProviderInitializationResult>
  | null = null;
let initializationIdentity: string | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function absoluteHttpUrl(
  value: string | null | undefined,
  label: string,
): string {
  if (!value?.trim()) {
    throw new Error(`${label} is not configured.`);
  }
  const url = new URL(value);
  return secureDataBundleUrl(url.toString(), label);
}

function registrySize(registry: Ed25519KeyRegistry): number {
  return "get" in registry &&
    typeof registry.get === "function" &&
    "size" in registry &&
    typeof registry.size === "number"
    ? registry.size
    : Object.keys(registry).length;
}

export function parseDataBundleTrustedKeys(
  input: unknown,
): Ed25519KeyRegistry {
  const document = trustedKeyFileSchema.parse(input);
  return Object.fromEntries(
    document.keys.map((entry) => [
      entry.keyId,
      entry.publicKey as JsonWebKey,
    ]),
  );
}

async function configuredResult(
  provider: DataBundleProvider,
): Promise<HostedDataBundleProviderInitializationResult> {
  const status = await provider.getStatus();
  return {
    configured: true,
    source: "signed-verified",
    reason: null,
    activeBundleId: status.activeBundleId,
    refreshScheduled: false,
    refreshMode:
      status.refreshMode ??
      (provider instanceof RemoteRuntimeDataBundleProvider
        ? provider.getRefreshMode()
        : status.state === "offline"
          ? "disabled"
          : "request-driven"),
    durability:
      status.durability ?? {
        mode: "memory",
        state: "ready",
        reason: "The active provider retains archives only for this process lifetime.",
      },
  };
}

function compiledFallback(
  reason: string,
): HostedDataBundleProviderInitializationResult {
  return {
    configured: false,
    source: "compiled-unverified",
    reason,
    activeBundleId: null,
    refreshScheduled: false,
    refreshMode: "disabled",
    durability: {
      mode: "memory",
      state: "degraded",
      reason:
        "Compiled application data is active without a verified signed runtime bundle.",
    },
  };
}

async function verifyStoredBundle(
  bundle: HostedStoredDataBundle,
  trustedKeys: Ed25519KeyRegistry,
) {
  const verified = await verifyRuntimeDataBundle({
    manifest: bundle.manifest,
    shards: bundle.shards,
    trustedKeys,
  });
  if (!verified.ok) {
    throw new Error(verified.message);
  }
  if (
    !isSupportedRuntimeDataBundleSchemaVersion(
      verified.data.manifest.engineDataSchemaVersion,
    )
  ) {
    throw new Error(
      `Bundle ${verified.data.bundleId} requires unsupported engine data schema ${verified.data.manifest.engineDataSchemaVersion}.`,
    );
  }
  return verified.data;
}

async function initialize(
  options: HostedDataBundleProviderInitializationOptions,
): Promise<HostedDataBundleProviderInitializationResult> {
  const existing = getConfiguredDataBundleProvider();
  if (existing) return configuredResult(existing);

  const channelUrl = options.channelUrl?.trim()
    ? absoluteHttpUrl(
        options.channelUrl,
        "ROSTERPILOT_DATA_CHANNEL_URL",
      )
    : null;
  const bootstrapManifestUrl = absoluteHttpUrl(
    options.bootstrapManifestUrl,
    "The hosted bootstrap manifest URL",
  );
  let trustedKeys = options.trustedKeys;
  if (!trustedKeys) {
    const document =
      options.trustedKeysDocument ??
      (options.trustedKeysUrl
        ? await options.loadJson(
            absoluteHttpUrl(
              options.trustedKeysUrl,
              "The hosted trusted-keys URL",
            ),
          )
        : null);
    if (document === null) {
      throw new Error(
        "The hosted trusted-key registry is unavailable.",
      );
    }
    trustedKeys = parseDataBundleTrustedKeys(document);
  }
  if (registrySize(trustedKeys) === 0) {
    throw new Error(
      "The hosted trusted-key registry contains no public keys.",
    );
  }

  const manifestInput = await options.loadJson(
    bootstrapManifestUrl,
  );
  if (manifestInput === null) {
    throw new Error(
      "The hosted signed bootstrap manifest is unavailable.",
    );
  }
  const manifestShape =
    DataBundleManifestV1Schema.safeParse(manifestInput);
  if (!manifestShape.success) {
    throw new Error(
      "The hosted signed bootstrap manifest is malformed.",
    );
  }
  const shardInputs = await Promise.all(
    manifestShape.data.shards.map(async (descriptor) => {
      const shardUrl = new URL(
        descriptor.path,
        bootstrapManifestUrl,
      ).toString();
      const shard = await options.loadJson(shardUrl);
      if (shard === null) {
        throw new Error(
          `The hosted bootstrap shard ${descriptor.shardId} is unavailable.`,
        );
      }
      return shard;
    }),
  );
  let activeSnapshot;
  try {
    activeSnapshot = await verifyStoredBundle(
      { manifest: manifestInput, shards: shardInputs },
      trustedKeys,
    );
  } catch (error) {
    throw new Error(
      `The hosted bootstrap bundle was not trusted: ${errorMessage(error)}`,
    );
  }

  let durability: NonNullable<
    DataBundleProviderStatus["durability"]
  > = options.persistence
    ? { mode: "persistent", state: "ready", reason: null }
    : {
        mode: "memory",
        state: "ready",
        reason:
          "No hosted object store is configured; verified bundles and rollback history last only for this process lifetime.",
      };
  let storedQuarantines: Awaited<
    ReturnType<HostedDataBundlePersistence["loadQuarantines"]>
  > = [];
  let storedRollbackHold: Awaited<
    ReturnType<HostedDataBundlePersistence["loadRollbackHold"]>
  > = null;
  let storedChannelCursor: Awaited<
    ReturnType<HostedDataBundlePersistence["loadChannelCursor"]>
  > = null;
  if (options.persistence) {
    try {
      const [quarantines, rollbackHold, channelCursor] =
        await Promise.all([
        options.persistence.loadQuarantines(),
        options.persistence.loadRollbackHold(),
        options.persistence.loadChannelCursor(),
      ]);
      storedQuarantines = quarantines;
      storedRollbackHold = rollbackHold;
      storedChannelCursor = channelCursor;
    } catch (error) {
      throw new Error(
        `The hosted archive safety state could not be loaded: ${errorMessage(error)}`,
      );
    }
    try {
      const stored = await options.persistence.loadActiveBundle();
      if (stored) {
        activeSnapshot = await verifyStoredBundle(stored, trustedKeys);
      }
    } catch (error) {
      durability = {
        mode: "persistent",
        state: "degraded",
        reason:
          `The hosted archive could not load its active bundle; the shipped signed bootstrap remains active. ${errorMessage(error)}`,
      };
    }
    if (
      storedRollbackHold &&
      activeSnapshot.bundleId !== storedRollbackHold.bundleId
    ) {
      const held = await options.persistence.loadBundle(
        storedRollbackHold.bundleId,
      );
      if (!held) {
        throw new Error(
          `The hosted rollback hold targets missing bundle ${storedRollbackHold.bundleId}.`,
        );
      }
      activeSnapshot = await verifyStoredBundle(held, trustedKeys);
    }
  }

  let persistedActiveBundleId = activeSnapshot.bundleId;
  let firstActivation = true;
  const markPersistenceFailure = (error: unknown) => {
    durability = {
      mode: "persistent",
      state: "degraded",
      reason: errorMessage(error),
    };
  };
  let retentionPromise: Promise<void> | null = null;
  const scheduleRetention = () => {
    if (
      !options.persistence ||
      retentionPromise ||
      (!options.scheduleBackground && !options.periodicRefresh)
    ) {
      return;
    }
    const task = options.persistence
      .enforceRetention({
        verifyBundle: async (bundle) => {
          await verifyStoredBundle(bundle, trustedKeys);
        },
      })
      .then(() => undefined)
      .catch(markPersistenceFailure)
      .finally(() => {
        if (retentionPromise === task) retentionPromise = null;
      });
    retentionPromise = task;
    if (options.scheduleBackground) {
      try {
        options.scheduleBackground(task);
      } catch {
        void task;
      }
    } else {
      void task;
    }
  };

  const provider = new RemoteRuntimeDataBundleProvider({
    bootstrap: activeSnapshot,
    channelUrl,
    trustedKeys,
    fetch: options.fetch,
    refreshIntervalMs: options.refreshIntervalMs,
    scheduleBackground: options.scheduleBackground,
    durability: () => durability,
    persistVerified: options.persistence
      ? async ({ snapshot }) => {
          try {
            await options.persistence!.persistBundle(snapshot);
          } catch (error) {
            markPersistenceFailure(error);
            throw error;
          }
        }
      : undefined,
    loadArchived: options.persistence
      ? async (bundleId) => {
          const stored = await options.persistence!.loadBundle(bundleId);
          return stored
            ? verifyStoredBundle(stored, trustedKeys)
            : null;
        }
      : undefined,
    loadActiveBundleId: options.persistence
      ? () => options.persistence!.getActiveBundleId()
      : undefined,
    initialChannelCursor: storedChannelCursor,
    loadChannelCursor: options.persistence
      ? () => options.persistence!.loadChannelCursor()
      : undefined,
    compareAndSetChannelCursor: options.persistence
      ? (input) =>
          options.persistence!.compareAndSetChannelCursor(input)
      : undefined,
    initialRollbackHold: storedRollbackHold,
    loadRollbackHold: options.persistence
      ? () => options.persistence!.loadRollbackHold()
      : undefined,
    persistRollbackHold: options.persistence
      ? (hold) => options.persistence!.persistRollbackHold(hold)
      : undefined,
    clearRollbackHold: options.persistence
      ? () => options.persistence!.clearRollbackHold()
      : undefined,
    recordQuarantine: options.persistence
      ? (input) => options.persistence!.recordQuarantine(input)
      : undefined,
    retainReference: options.persistence
      ? (referenceId, bundleId) =>
          options.persistence!.retainReference(referenceId, bundleId)
      : undefined,
    releaseReference: options.persistence
      ? (referenceId, bundleId) =>
          options.persistence!.releaseReference(referenceId, bundleId)
      : undefined,
    initialQuarantinedScopes: storedQuarantines.flatMap(
      (quarantine) =>
        quarantine.scopes.map((scope) => ({
          scope,
          bundleId: quarantine.bundleId,
          reason: quarantine.reason,
        })),
    ),
    activate: async (snapshot) => {
      const previousBundleId = persistedActiveBundleId;
      const resolvedQuarantines =
        options.persistence && !firstActivation
          ? (await options.persistence.loadQuarantines()).filter(
              (quarantine) =>
                quarantine.bundleId === snapshot.bundleId,
            )
          : [];
      const restoreResolvedQuarantines = async () => {
        if (!options.persistence) return;
        for (const quarantine of resolvedQuarantines) {
          await options.persistence.recordQuarantine({
            bundleId: quarantine.bundleId,
            scopes: quarantine.scopes,
            reason: quarantine.reason,
          });
        }
      };
      if (options.persistence) {
        try {
          for (const quarantine of resolvedQuarantines) {
            await options.persistence.clearQuarantine({
              bundleId: quarantine.bundleId,
              reason:
                `Bundle ${snapshot.bundleId} passed the current candidate policy and was selected for repaired activation.`,
            });
          }
          await options.persistence.persistBundle(snapshot);
          await options.persistence.activateBundle(snapshot.bundleId);
        } catch (error) {
          await restoreResolvedQuarantines().catch(markPersistenceFailure);
          markPersistenceFailure(error);
          if (
            !firstActivation ||
            errorMessage(error).includes("changed concurrently") ||
            errorMessage(error).includes("quarantined")
          ) {
            throw error;
          }
        }
      }
      try {
        activateRuntimeDataBundle(snapshot);
        persistedActiveBundleId = snapshot.bundleId;
        firstActivation = false;
      } catch (error) {
        if (options.persistence) {
          await options.persistence
            .activateBundle(previousBundleId)
            .catch(markPersistenceFailure);
          await restoreResolvedQuarantines().catch(markPersistenceFailure);
        }
        throw error;
      }
      scheduleRetention();
    },
  });
  await provider.initialize({ refresh: false });
  configureDataBundleProvider(provider);
  if (options.periodicRefresh) provider.startPeriodicRefresh();

  let refreshScheduled = false;
  if (channelUrl) {
    const refreshTask = provider
      .refresh()
      .then(() => undefined)
      .catch(() => {
        // The verified bootstrap remains active. Provider status records the
        // signed-channel failure for the data status operations.
      });
    refreshScheduled = true;
    if (options.scheduleBackground) {
      try {
        options.scheduleBackground(refreshTask);
      } catch {
        void refreshTask;
      }
    } else {
      void refreshTask;
    }
  }
  return {
    configured: true,
    source: "signed-verified",
    reason: durability.state === "degraded" ? durability.reason : null,
    activeBundleId: activeSnapshot.bundleId,
    refreshScheduled,
    refreshMode: provider.getRefreshMode(),
    durability,
  };
}

/**
 * Initializes the shared hosted provider at most once per deployment
 * configuration. No filesystem APIs are used, so callers may load immutable
 * release assets through Cloudflare ASSETS, same-origin fetch, or a test
 * fixture. Any missing or invalid release input leaves compiled data active.
 */
export function initializeHostedDataBundleProvider(
  options: HostedDataBundleProviderInitializationOptions,
): Promise<HostedDataBundleProviderInitializationResult> {
  const existing = getConfiguredDataBundleProvider();
  if (existing) {
    if (existing instanceof RemoteRuntimeDataBundleProvider) {
      existing.setBackgroundScheduler(options.scheduleBackground);
      if (
        options.periodicRefresh &&
        existing.getRefreshMode() !==
          "request-driven-wait-until"
      ) {
        existing.startPeriodicRefresh();
      }
    }
    return configuredResult(existing);
  }
  const identity = JSON.stringify({
    channelUrl: options.channelUrl ?? null,
    bootstrapManifestUrl: options.bootstrapManifestUrl,
    trustedKeysUrl: options.trustedKeysUrl ?? null,
    hasInlineKeys:
      options.trustedKeys !== undefined ||
      options.trustedKeysDocument !== undefined,
    hasPersistence: options.persistence !== undefined,
    periodicRefresh: options.periodicRefresh === true,
  });
  if (initialization && initializationIdentity === identity) {
    return initialization;
  }
  initializationIdentity = identity;
  const attempt = initialize(options)
    .catch((error) => {
      if (!getConfiguredDataBundleProvider()) {
        configureDataBundleProvider(null);
      }
      return compiledFallback(errorMessage(error));
    })
    .finally(() => {
      if (
        !getConfiguredDataBundleProvider() &&
        initialization === attempt
      ) {
        initialization = null;
        initializationIdentity = null;
      }
    });
  initialization = attempt;
  return initialization;
}

export function resetHostedDataBundleProviderInitializationForTests(): void {
  const existing = getConfiguredDataBundleProvider();
  if (existing instanceof RemoteRuntimeDataBundleProvider) {
    existing.stopPeriodicRefresh();
  }
  initialization = null;
  initializationIdentity = null;
  configureDataBundleProvider(null);
}
