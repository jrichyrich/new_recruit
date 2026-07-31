import path from "node:path";

export const DEFAULT_DATA_BUNDLE_CHANNEL_URL =
  "https://raw.githubusercontent.com/jrichyrich/new_recruit/data-bundles/channels/stable.json";

export function defaultLocalDataBundleEnvironment(
  projectDirectory: string,
): {
  channelUrl: string;
  trustedKeysFile: string;
  bootstrapDirectory: string;
} {
  return {
    channelUrl:
      process.env.ROSTERPILOT_DATA_CHANNEL_URL ??
      DEFAULT_DATA_BUNDLE_CHANNEL_URL,
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
