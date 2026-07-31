import {
  readFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  configureDataBundleProvider,
} from "../../lib/rosterpilot/data-operations";
import type {
  Ed25519KeyRegistry,
} from "../../lib/rosterpilot/data-bundle";
import {
  rosterPilotSupportDirectory,
  projectRoot,
} from "../agent/paths";
import {
  createLocalRuntimeDataBundleProvider,
} from "./provider";
import type {
  LocalDataBundleInstallInput,
} from "./store";
import {
  defaultLocalDataBundleEnvironment,
} from "./defaults";

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
let activeProvider: Awaited<
  ReturnType<typeof createLocalRuntimeDataBundleProvider>
> | null = null;

export function initializeLocalDataBundleProvider(): Promise<LocalDataBundleConfigurationResult> {
  if (initialization) return initialization;
  initialization = (async () => {
    const trustedKeys = await readTrustedKeys();
    if (Object.keys(trustedKeys).length === 0) {
      configureDataBundleProvider(null);
      return {
        configured: false,
        reason:
          "No trusted data-bundle public key is installed; the compiled bootstrap data remains active.",
        activeBundleId: null,
      };
    }
    const runtimeConfiguration =
      defaultLocalDataBundleEnvironment(projectRoot);
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
    const provider = await createLocalRuntimeDataBundleProvider({
      rootDirectory: path.join(
        rosterPilotSupportDirectory(),
        "data-bundles",
      ),
      trustedKeys,
      channelUrl: runtimeConfiguration.channelUrl,
      bootstrap,
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
  })().catch((error) => {
    activeProvider?.stopPeriodicRefresh();
    activeProvider = null;
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

export function startLocalDataBundlePeriodicRefresh(): boolean {
  return activeProvider?.startPeriodicRefresh() ?? false;
}

export function stopLocalDataBundlePeriodicRefresh(): void {
  activeProvider?.stopPeriodicRefresh();
}

export function resetLocalDataBundleProviderInitializationForTests(): void {
  activeProvider?.stopPeriodicRefresh();
  activeProvider = null;
  initialization = null;
  configureDataBundleProvider(null);
}
