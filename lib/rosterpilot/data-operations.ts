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

function offlineStatus(): DataUpdateStatus {
  const bundleId = bootstrapBundleId();
  return {
    providerConfigured: false,
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
        "Compiled application data has no verified signed official-extractor evidence binding.",
    },
    rollbackHold: null,
    dataTrust: "compiled-unverified",
    durability: {
      mode: "memory",
      state: "degraded",
      reason:
        "No signed runtime provider is configured; the compiled application data is active.",
    },
  };
}

function publicStatus(
  status: DataBundleProviderStatus,
): DataUpdateStatus {
  return {
    providerConfigured: true,
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
          "The active signed bundle predates explicit official-authority evidence status.",
      },
    rollbackHold: status.rollbackHold ?? null,
    dataTrust: "signed-verified",
    durability: status.durability,
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
        "Signed runtime data updates are unavailable on this surface. Roster construction continues from the compiled application data, which is not a verified signed bundle.",
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
  if (!provider) {
    const data = offlineStatus();
    cachedProviderStatus = data;
    return {
      ok: true,
      data,
      violations: [],
      warnings: [
        issue(
          "DATA_BUNDLE_PROVIDER_UNAVAILABLE",
          "No runtime update provider is configured. Roster construction is using compiled application data, not a verified signed bundle, and remains available offline.",
          "warn",
        ),
      ],
    };
  }
  try {
    const data = publicStatus(await provider.getStatus());
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
            : "The signed runtime data refresh failed.",
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
  return rebaseRosterData(parsed.data);
}
