import type {
  DataBundleProvider,
  DataBundleProviderStatus,
  DataBundleSnapshot,
} from "./data-bundle";
import {
  currentRosterSourceData,
  parseRosterDraft,
  rebaseRosterData,
} from "./draft";
import {
  runtimeRosterCompatibilitySnapshot,
  type RuntimeDataBundleShardDataV1,
} from "./runtime-data-bundle";
import {
  DEFAULT_FACTION_ID,
  type DataRefreshResult,
  type DataUpdateStatus,
  type ResultEnvelope,
  type RosterDataRebaseResult,
  type RosterIssue,
} from "./types";

let configuredProvider: DataBundleProvider | null = null;
let cachedProviderStatus: DataUpdateStatus | null = null;

export type LocalDataUpdateControlStatus = {
  localUpdate: DataUpdateStatus["localUpdate"];
  sourceStatus?: DataUpdateStatus["sourceStatus"];
  serviceCompatibility?: DataUpdateStatus["serviceCompatibility"];
};

export type LocalDataUpdateControl = {
  getStatus(): Promise<LocalDataUpdateControlStatus>;
  getJob?(jobId: string): Promise<
    DataUpdateStatus["localUpdate"]
  >;
  enqueue(options: { force: boolean }): Promise<{
    jobId: string | null;
    queued: boolean;
  }>;
};

export type LocalDataUpdateJobResult = {
  job: DataUpdateStatus["localUpdate"];
};

export type StartLocalDataUpdateResult = {
  jobId: string | null;
  queued: boolean;
  job: DataUpdateStatus["localUpdate"];
};

let configuredLocalDataUpdateControl: LocalDataUpdateControl | null = null;

function issue(
  code: string,
  message: string,
  severity: RosterIssue["severity"],
): RosterIssue {
  return { code, message, severity };
}

function bootstrapBundleId(): string | null {
  try {
    return currentRosterSourceData(DEFAULT_FACTION_ID).bundleId;
  } catch {
    return null;
  }
}

function offlineStatus(
  local?: LocalDataUpdateControlStatus,
): DataUpdateStatus {
  const bundleId = bootstrapBundleId();
  return {
    providerConfigured: false,
    providerMode: local ? "local-source" : "compiled",
    state: "offline",
    activeBundleId: bundleId,
    latestVerifiedBundleId: null,
    latestUpstreamBundleId: null,
    candidate: null,
    quarantinedScopes: [],
    lastSuccessfulCheckAt: null,
    officialAuthority: {
      status: "unverified-overlay",
      reason:
        "Compiled application data has no verified official-extractor evidence binding.",
    },
    rollbackHold: null,
    dataTrust: "compiled-unverified",
    durability: {
      mode: "memory",
      state: "degraded",
      reason:
        "No local or hosted runtime provider is configured; the compiled application data is active while local data initialization remains available.",
    },
    ...(local
      ? {
          localUpdate: local.localUpdate,
          ...(local.sourceStatus
            ? { sourceStatus: local.sourceStatus }
            : {}),
          ...(local.serviceCompatibility
            ? {
                serviceCompatibility:
                  local.serviceCompatibility,
              }
            : {}),
        }
      : {}),
  };
}

function publicStatus(
  status: DataBundleProviderStatus,
  local?: LocalDataUpdateControlStatus,
): DataUpdateStatus {
  const extended = status as DataBundleProviderStatus & {
    providerMode?: DataUpdateStatus["providerMode"];
    dataTrust?: NonNullable<DataUpdateStatus["dataTrust"]>;
    localUpdate?: DataUpdateStatus["localUpdate"];
    sourceStatus?: DataUpdateStatus["sourceStatus"];
    serviceCompatibility?: DataUpdateStatus["serviceCompatibility"];
  };
  const providerMode = extended.providerMode ?? "signed-channel";
  return {
    providerConfigured: true,
    providerMode,
    state: status.state,
    activeBundleId: status.activeBundleId,
    latestVerifiedBundleId: status.latestVerifiedBundleId,
    latestUpstreamBundleId: status.latestUpstreamBundleId,
    candidate: status.candidate,
    quarantinedScopes: status.quarantinedScopes,
    lastSuccessfulCheckAt: status.lastCheckedAt,
    officialAuthority:
      status.officialAuthority ?? {
        status: "unverified-overlay",
        reason:
          "The active data snapshot predates explicit official-authority evidence status.",
      },
    rollbackHold: status.rollbackHold ?? null,
    dataTrust:
      extended.dataTrust ??
      (providerMode === "local-source"
        ? "locally-verified"
        : "signed-verified"),
    durability: status.durability,
    ...(local?.localUpdate !== undefined ||
    extended.localUpdate !== undefined
      ? { localUpdate: local?.localUpdate ?? extended.localUpdate }
      : {}),
    ...(local?.sourceStatus !== undefined ||
    extended.sourceStatus !== undefined
      ? { sourceStatus: local?.sourceStatus ?? extended.sourceStatus }
      : {}),
    ...(local?.serviceCompatibility !== undefined ||
    extended.serviceCompatibility !== undefined
      ? {
          serviceCompatibility:
            local?.serviceCompatibility ??
            extended.serviceCompatibility,
        }
      : {}),
    ...(status.refreshMode
      ? { refreshMode: status.refreshMode }
      : {}),
  };
}

function providerUnavailable<T>(): ResultEnvelope<T> {
  return {
    ok: false,
    data: null,
    violations: [
      issue(
        "DATA_BUNDLE_PROVIDER_UNAVAILABLE",
        "Runtime data updates are unavailable on this surface. Roster construction continues from the compiled application data; on a local installation, run Doctor to restore the background updater.",
        "error",
      ),
    ],
    warnings: [],
  };
}

export function configureDataBundleProvider(
  provider: DataBundleProvider | null,
): void {
  configuredProvider = provider;
  cachedProviderStatus = provider
    ? {
        ...offlineStatus(),
        providerConfigured: true,
        state: "checking",
      }
    : null;
}

export function configureLocalDataUpdateControl(
  control: LocalDataUpdateControl | null,
): void {
  configuredLocalDataUpdateControl = control;
  if (!configuredProvider) {
    cachedProviderStatus = control
      ? { ...offlineStatus(), providerMode: "local-source" }
      : null;
  }
}

export function getConfiguredDataBundleProvider():
  | DataBundleProvider
  | null {
  return configuredProvider;
}

export async function retainDataBundleReference(
  referenceId: string,
  bundleId: string,
  provider: DataBundleProvider | null = configuredProvider,
): Promise<boolean> {
  if (!provider?.retainReference) return false;
  await provider.retainReference(referenceId, bundleId);
  return true;
}

export async function releaseDataBundleReference(
  referenceId: string,
  bundleId?: string,
  provider: DataBundleProvider | null = configuredProvider,
): Promise<boolean> {
  if (!provider?.releaseReference) return false;
  await provider.releaseReference(referenceId, bundleId);
  return true;
}

export async function withDataBundleSnapshotLease<T>(
  operation: () => T | Promise<T>,
  provider: DataBundleProvider | null = configuredProvider,
): Promise<T> {
  if (!provider) return operation();
  const lease = await provider.acquireSnapshot();
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

/**
 * Synchronous status for existing engine/freshness responses. The async
 * operation below refreshes this view from the configured provider.
 */
export function getDataUpdateStatusSnapshot(): DataUpdateStatus {
  return cachedProviderStatus ?? offlineStatus();
}

export async function getDataUpdateStatus(
  provider: DataBundleProvider | null = configuredProvider,
): Promise<ResultEnvelope<DataUpdateStatus>> {
  const local = configuredLocalDataUpdateControl
    ? await configuredLocalDataUpdateControl.getStatus().catch(() => null)
    : null;
  if (!provider) {
    const data = offlineStatus(local ?? undefined);
    cachedProviderStatus = data;
    return {
      ok: true,
      data,
      violations: [],
      warnings: [
        issue(
          "DATA_BUNDLE_PROVIDER_UNAVAILABLE",
          "No runtime update provider is configured. Roster construction remains available from compiled application data while local update readiness is repaired.",
          "warn",
        ),
      ],
    };
  }
  try {
    const data = publicStatus(
      await provider.getStatus(),
      local ?? undefined,
    );
    cachedProviderStatus = data;
    return {
      ok: true,
      data,
      violations: [],
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      data: cachedProviderStatus ?? offlineStatus(),
      violations: [
        issue(
          "DATA_BUNDLE_STATUS_FAILED",
          error instanceof Error
            ? error.message
            : "The runtime data provider status could not be read.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
}

export async function refreshDataNow(
  options: { force?: boolean } = {},
  provider: DataBundleProvider | null = configuredProvider,
): Promise<ResultEnvelope<DataRefreshResult>> {
  if (configuredLocalDataUpdateControl) {
    try {
      const queued = await configuredLocalDataUpdateControl.enqueue({
        force: options.force ?? true,
      });
      const status = await getDataUpdateStatus(provider);
      if (!status.data) {
        return {
          ok: false,
          data: null,
          violations: status.violations,
          warnings: status.warnings,
        };
      }
      return {
        ok: true,
        data: {
          status: status.data,
          activatedBundleId: null,
          classification: null,
          localUpdateJobId: queued.jobId,
        },
        violations: [],
        warnings: queued.queued
          ? [
              issue(
                "LOCAL_DATA_UPDATE_QUEUED",
                "The local source check is running in the background. Ordinary roster work can continue from the current snapshot.",
                "warn",
              ),
            ]
          : [],
      };
    } catch (error) {
      return {
        ok: false,
        data: null,
        violations: [
          issue(
            "LOCAL_DATA_UPDATE_QUEUE_FAILED",
            error instanceof Error
              ? error.message
              : "The durable local data update could not be queued.",
            "error",
          ),
        ],
        warnings: [],
      };
    }
  }
  if (!provider) return providerUnavailable();
  try {
    const refreshed = await provider.refresh({
      force: options.force ?? true,
    });
    const status = publicStatus(refreshed.status);
    cachedProviderStatus = status;
    return {
      ok: true,
      data: {
        status,
        activatedBundleId: refreshed.activatedBundleId,
        classification: refreshed.classification,
      },
      violations: [],
      warnings: status.quarantinedScopes.length
        ? [
            issue(
              "DATA_BUNDLE_SCOPES_QUARANTINED",
              "The verified update activated only safe scopes; one or more regressive or ambiguous scopes remain quarantined on their previous bundle.",
              "warn",
            ),
          ]
        : [],
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "DATA_BUNDLE_REFRESH_FAILED",
          error instanceof Error
            ? error.message
            : "The runtime data refresh failed.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
}

/** Starts only the durable machine-local source updater. */
export async function startLocalDataUpdate(
  options: { force?: boolean } = {},
): Promise<ResultEnvelope<StartLocalDataUpdateResult>> {
  if (!configuredLocalDataUpdateControl) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "LOCAL_DATA_UPDATE_UNAVAILABLE",
          "The durable local-source updater is not available on this hosted or compiled-only surface.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
  try {
    const queued = await configuredLocalDataUpdateControl.enqueue({
      force: options.force ?? true,
    });
    const status = await configuredLocalDataUpdateControl.getStatus();
    return {
      ok: true,
      data: {
        jobId: queued.jobId,
        queued: queued.queued,
        job: status.localUpdate,
      },
      violations: [],
      warnings: queued.queued
        ? [
            issue(
              "LOCAL_DATA_UPDATE_QUEUED",
              "The local source update is running in the background; roster work can continue.",
              "warn",
            ),
          ]
        : [],
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "LOCAL_DATA_UPDATE_QUEUE_FAILED",
          error instanceof Error
            ? error.message
            : "The durable local data update could not be queued.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
}

/** Reads one immutable durable local update job by id. */
export async function getLocalDataUpdateJob(
  jobId: string,
): Promise<ResultEnvelope<LocalDataUpdateJobResult>> {
  if (!configuredLocalDataUpdateControl) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "LOCAL_DATA_UPDATE_UNAVAILABLE",
          "The durable local-source updater is not available on this hosted or compiled-only surface.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "LOCAL_DATA_UPDATE_JOB_ID_INVALID",
          "A local update job id must be one UUID returned by the updater.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
  try {
    const job = configuredLocalDataUpdateControl.getJob
      ? await configuredLocalDataUpdateControl.getJob(jobId)
      : null;
    if (!job) {
      return {
        ok: false,
        data: null,
        violations: [
          issue(
            "LOCAL_DATA_UPDATE_JOB_NOT_FOUND",
            `Local update job ${jobId} was not found.`,
            "error",
          ),
        ],
        warnings: [],
      };
    }
    return {
      ok: true,
      data: { job },
      violations: [],
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "LOCAL_DATA_UPDATE_JOB_READ_FAILED",
          error instanceof Error
            ? error.message
            : "The durable local update job could not be read.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
}

export async function rollbackDataBundle(
  bundleId: string,
  provider: DataBundleProvider | null = configuredProvider,
): Promise<ResultEnvelope<DataUpdateStatus>> {
  if (!provider) return providerUnavailable();
  if (!/^[a-f0-9]{64}$/.test(bundleId)) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "DATA_BUNDLE_ID_INVALID",
          "A rollback target must be an exact lowercase SHA-256 bundle ID.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
  try {
    const data = publicStatus(await provider.rollback(bundleId));
    cachedProviderStatus = data;
    return {
      ok: true,
      data,
      violations: [],
      warnings: [
        issue(
          "DATA_BUNDLE_ROLLED_BACK",
          `Future requests will use archived bundle ${bundleId}. Automatic refresh is held until an explicit forced refresh, while existing snapshot leases and durable jobs remain unchanged.`,
          "warn",
        ),
      ],
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "DATA_BUNDLE_ROLLBACK_FAILED",
          error instanceof Error
            ? error.message
            : "The requested runtime data rollback failed.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
}

export function rebaseRoster(
  roster: unknown,
): ResultEnvelope<RosterDataRebaseResult> {
  return rebaseRosterData(roster);
}

export async function rebaseRosterWithProvider(
  roster: unknown,
  provider: DataBundleProvider | null = configuredProvider,
  targetBundleId?: string,
): Promise<ResultEnvelope<RosterDataRebaseResult>> {
  const parsed = parseRosterDraft(roster);
  if (
    !parsed.success ||
    !provider ||
    parsed.data.sourceData.identityStatus !== "verified"
  ) {
    return rebaseRosterData(roster);
  }
  let lease;
  try {
    lease = await provider.acquireSnapshot({
      bundleId: parsed.data.sourceData.bundleId,
      factionIds: [parsed.data.factionId],
    });
  } catch {
    return rebaseRosterData(roster);
  }
  try {
    const historical = runtimeRosterCompatibilitySnapshot(
      lease.snapshot as DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
      parsed.data.factionId,
    );
    const verified = rebaseRosterData(parsed.data, {
      snapshot: historical,
    });
    if (!verified.ok) return verified;
  } finally {
    await lease.release();
  }
  if (targetBundleId) {
    let targetLease;
    try {
      targetLease = await provider.acquireSnapshot({
        bundleId: targetBundleId,
        factionIds: [parsed.data.factionId],
      });
      return rebaseRosterData(parsed.data, {
        snapshot: runtimeRosterCompatibilitySnapshot(
          targetLease.snapshot as DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
          parsed.data.factionId,
        ),
      });
    } catch (error) {
      return {
        ok: false,
        data: null,
        violations: [
          issue(
            "DATA_BUNDLE_TARGET_UNAVAILABLE",
            error instanceof Error
              ? error.message
              : `Data bundle ${targetBundleId} could not be opened.`,
            "error",
          ),
        ],
        warnings: [],
      };
    } finally {
      await targetLease?.release();
    }
  }
  return rebaseRosterData(parsed.data);
}
