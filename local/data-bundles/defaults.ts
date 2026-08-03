import path from "node:path";

export const DEFAULT_DATA_BUNDLE_CHANNEL_URL =
  "https://raw.githubusercontent.com/jrichyrich/new_recruit/data-bundles/channels/stable.json";

export function defaultLocalDataBundleEnvironment(
  projectDirectory: string,
): {
  providerMode: "local-source" | "signed-channel";
  channelUrl: string | null;
  trustedKeysFile: string;
  bootstrapDirectory: string;
} {
  const configuredMode = process.env.ROSTERPILOT_DATA_PROVIDER_MODE;
  const providerMode =
    configuredMode === "signed-channel"
      ? "signed-channel"
      : "local-source";
  return {
    providerMode,
    channelUrl:
      providerMode === "signed-channel"
        ? (process.env.ROSTERPILOT_DATA_CHANNEL_URL ??
          DEFAULT_DATA_BUNDLE_CHANNEL_URL)
        : null,
    trustedKeysFile:
      process.env.ROSTERPILOT_DATA_TRUSTED_KEYS_FILE ??
      path.join(
        projectDirectory,
        "data",
        "data-bundle-trusted-keys.json",
      ),
    bootstrapDirectory:
      process.env.ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY ??
      path.join(
        projectDirectory,
        "data",
        "bootstrap-data-bundle",
      ),
  };
}
