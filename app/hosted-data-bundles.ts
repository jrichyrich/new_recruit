import {
  initializeHostedDataBundleProvider,
  type HostedDataBundleProviderInitializationResult,
} from "@/lib/rosterpilot";

const DEFAULT_TRUSTED_KEYS_PATH =
  "/data-bundles/trusted-keys.json";
const DEFAULT_BOOTSTRAP_MANIFEST_PATH =
  "/data-bundles/bootstrap/manifest.json";

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
