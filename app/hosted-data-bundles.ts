import {
  getDataUpdateStatus,
  getConfiguredDataBundleProvider,
  initializeHostedDataBundleProvider,
  type HostedDataBundleProviderInitializationResult,
} from "@/lib/rosterpilot";

const DEFAULT_TRUSTED_KEYS_PATH =
  "/data-bundles/trusted-keys.json";
const DEFAULT_BOOTSTRAP_MANIFEST_PATH =
  "/data-bundles/bootstrap/manifest.json";

const hostedRuntimeState = globalThis as typeof globalThis & {
  __rosterpilotWorkerHostedDataRuntime?: boolean;
};

/**
 * Cloudflare initializes the hosted provider from Worker bindings before the
 * application router runs. Marking that shared runtime prevents a route from
 * reinterpreting the same isolate as a writable local Node installation.
 */
export function markWorkerHostedDataRuntime(): void {
  hostedRuntimeState.__rosterpilotWorkerHostedDataRuntime = true;
}

async function currentInitializationResult(
  reason: string | null = null,
): Promise<HostedDataBundleProviderInitializationResult> {
  const provider = getConfiguredDataBundleProvider();
  const status = await getDataUpdateStatus(provider);
  return {
    configured: provider !== null,
    source:
      status.data?.dataTrust === "signed-verified"
        ? "signed-verified"
        : status.data?.dataTrust === "locally-verified"
          ? "locally-verified"
          : "compiled-unverified",
    reason,
    activeBundleId: status.data?.activeBundleId ?? null,
    refreshScheduled: provider !== null,
    refreshMode: status.data?.refreshMode ?? "disabled",
    durability: status.data?.durability ?? {
      mode: "memory",
      state: "degraded",
      reason: reason ?? "Compiled application data is active.",
    },
  };
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function parsedTrustedKeysDocument(): unknown | undefined {
  const raw = environmentValue(
    "ROSTERPILOT_DATA_TRUSTED_KEYS_JSON",
  );
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function loadJson(url: string): Promise<unknown | null> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Hosted data asset returned HTTP ${response.status}.`,
    );
  }
  return response.json();
}

export function initializeHostedDataForRequest(
  request: Request,
): Promise<HostedDataBundleProviderInitializationResult> {
  const configuredMode = environmentValue(
    "ROSTERPILOT_DATA_PROVIDER_MODE",
  );
  const statelessHosted = Boolean(
    hostedRuntimeState.__rosterpilotWorkerHostedDataRuntime ||
    environmentValue("ROSTERPILOT_STATELESS_HOSTED") === "1" ||
      environmentValue("VERCEL") ||
      environmentValue("CF_PAGES") ||
      environmentValue("NETLIFY"),
  );
  const alreadyConfigured = getConfiguredDataBundleProvider();
  if (alreadyConfigured && configuredMode !== "local-source") {
    return currentInitializationResult();
  }
  if (hostedRuntimeState.__rosterpilotWorkerHostedDataRuntime) {
    return currentInitializationResult(
      alreadyConfigured
        ? null
        : "The Worker initialized compiled fallback data because no signed channel is configured.",
    );
  }
  if (
    configuredMode === "local-source" ||
    (!configuredMode && !statelessHosted)
  ) {
    return import("../local/data-bundles/configure").then(
      async ({ initializeLocalDataBundleProvider }) => {
        const initialized =
          await initializeLocalDataBundleProvider();
        const status = await getDataUpdateStatus();
        const update = status.data;
        return {
          configured: initialized.configured,
          source:
            update?.dataTrust === "locally-verified"
              ? "locally-verified"
              : "compiled-unverified",
          reason: initialized.reason,
          activeBundleId:
            update?.activeBundleId ?? initialized.activeBundleId,
          refreshScheduled: initialized.configured,
          refreshMode: initialized.configured
            ? "periodic-unref"
            : "disabled",
          durability: update?.durability ?? {
            mode: "memory",
            state: "degraded",
            reason:
              "Compiled data is active while local update storage initializes.",
          },
        } satisfies HostedDataBundleProviderInitializationResult;
      },
    );
  }
  const origin = new URL(request.url).origin;
  return initializeHostedDataBundleProvider({
    channelUrl: environmentValue(
      "ROSTERPILOT_DATA_CHANNEL_URL",
    ),
    bootstrapManifestUrl: new URL(
      environmentValue(
        "ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_MANIFEST_URL",
      ) ?? DEFAULT_BOOTSTRAP_MANIFEST_PATH,
      origin,
    ).toString(),
    trustedKeysUrl: new URL(
      environmentValue("ROSTERPILOT_DATA_TRUSTED_KEYS_URL") ??
        DEFAULT_TRUSTED_KEYS_PATH,
      origin,
    ).toString(),
    trustedKeysDocument: parsedTrustedKeysDocument(),
    loadJson,
    periodicRefresh: true,
  });
}
