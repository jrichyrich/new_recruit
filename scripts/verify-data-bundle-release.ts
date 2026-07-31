import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyRuntimeDataBundle,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  canonicalJson,
} from "../lib/rosterpilot/semantic-hash";
import {
  parseTrustedDataBundleKeyRegistry,
} from "./prepare-data-bundle-release";

const usage = `Usage: npm run data:bundle:verify-release -- [options]

Verify that the application release contains one trusted signed bootstrap and
that the local and hosted copies are byte-semantically identical.

Options:
  --bootstrap-dir <path>       Default: data/bootstrap-data-bundle
  --trusted-keys <path>        Default: data/data-bundle-trusted-keys.json
  --hosted-assets-dir <path>   Default: public/data-bundles
  -h, --help                   Show help without reading release assets.
`;

type Args = {
  help: boolean;
  bootstrapDirectory: string;
  trustedKeysFile: string;
  hostedAssetsDirectory: string;
};

function requiredValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a path.`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): Args {
  const parsed: Args = {
    help: false,
    bootstrapDirectory: "data/bootstrap-data-bundle",
    trustedKeysFile: "data/data-bundle-trusted-keys.json",
    hostedAssetsDirectory: "public/data-bundles",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--bootstrap-dir") {
      parsed.bootstrapDirectory = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--trusted-keys") {
      parsed.trustedKeysFile = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--hosted-assets-dir") {
      parsed.hostedAssetsDirectory = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else {
      throw new Error(`Unknown release-verification option: ${argument}`);
    }
  }
  return parsed;
}

function resolvePath(root: string, value: string): string {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(root, value);
}

function readRegularJson(filename: string): unknown {
  if (!existsSync(filename)) {
    throw new Error(`Required release asset is missing: ${filename}.`);
  }
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Release asset is not a regular file: ${filename}.`);
  }
  return JSON.parse(readFileSync(filename, "utf8"));
}

function assertRegularDirectory(directory: string): void {
  if (!existsSync(directory)) {
    throw new Error(
      `Required release directory is missing: ${directory}.`,
    );
  }
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Release directory is not an ordinary directory: ${directory}.`,
    );
  }
}

function readShardPayload(
  directory: string,
  declaredPath: string,
): unknown {
  const filename = path.resolve(
    directory,
    ...declaredPath.split("/"),
  );
  const relative = path.relative(directory, filename);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Release bootstrap shard path escapes its directory: ${declaredPath}.`,
    );
  }
  const parsed = readRegularJson(filename);
  const resolvedDirectory = realpathSync(directory);
  const resolvedFilename = realpathSync(filename);
  const resolvedRelative = path.relative(
    resolvedDirectory,
    resolvedFilename,
  );
  if (
    !resolvedRelative ||
    resolvedRelative.startsWith("..") ||
    path.isAbsolute(resolvedRelative)
  ) {
    throw new Error(
      `Release bootstrap shard resolves outside its directory: ${declaredPath}.`,
    );
  }
  return parsed;
}

function bootstrapFiles(directory: string): {
  manifest: unknown;
  shards: unknown[];
} {
  assertRegularDirectory(directory);
  const manifest = readRegularJson(
    path.join(directory, "manifest.json"),
  ) as { shards?: Array<{ path?: string }> };
  if (!Array.isArray(manifest.shards)) {
    throw new Error(
      `Release bootstrap manifest is malformed: ${directory}.`,
    );
  }
  return {
    manifest,
    shards: manifest.shards.map((descriptor) => {
      if (typeof descriptor.path !== "string") {
        throw new Error(
          `Release bootstrap contains an invalid shard path: ${directory}.`,
        );
      }
      return readShardPayload(directory, descriptor.path);
    }),
  };
}

export async function verifyDataBundleRelease(options: {
  root: string;
  bootstrapDirectory?: string;
  trustedKeysFile?: string;
  hostedAssetsDirectory?: string;
}): Promise<{
  bundleId: string;
  signingKeyId: string;
  trustedKeyIds: string[];
}> {
  const root = path.resolve(options.root);
  const bootstrapDirectory = resolvePath(
    root,
    options.bootstrapDirectory ?? "data/bootstrap-data-bundle",
  );
  const trustedKeysFile = resolvePath(
    root,
    options.trustedKeysFile ??
      "data/data-bundle-trusted-keys.json",
  );
  const hostedAssetsDirectory = resolvePath(
    root,
    options.hostedAssetsDirectory ?? "public/data-bundles",
  );
  const transaction = path.join(
    root,
    ".rosterpilot-data-bundle-release-transaction.json",
  );
  if (existsSync(transaction)) {
    throw new Error(
      `The application release has an unfinished data-bundle transaction: ${transaction}.`,
    );
  }
  assertRegularDirectory(hostedAssetsDirectory);

  const localRegistry = parseTrustedDataBundleKeyRegistry(
    readRegularJson(trustedKeysFile),
  );
  if (localRegistry.keys.length === 0) {
    throw new Error(
      "The application release trusted-key registry is empty.",
    );
  }
  const hostedRegistry = parseTrustedDataBundleKeyRegistry(
    readRegularJson(
      path.join(hostedAssetsDirectory, "trusted-keys.json"),
    ),
  );
  if (
    canonicalJson(localRegistry) !==
    canonicalJson(hostedRegistry)
  ) {
    throw new Error(
      "The local and hosted public-key registries differ.",
    );
  }
  const trustedKeys = Object.fromEntries(
    localRegistry.keys.map((entry) => [
      entry.keyId,
      entry.publicKey,
    ]),
  );
  const local = bootstrapFiles(bootstrapDirectory);
  const hosted = bootstrapFiles(
    path.join(hostedAssetsDirectory, "bootstrap"),
  );
  if (
    canonicalJson(local) !== canonicalJson(hosted)
  ) {
    throw new Error(
      "The local and hosted signed bootstrap bundles differ.",
    );
  }
  const [localVerified, hostedVerified] = await Promise.all([
    verifyRuntimeDataBundle({ ...local, trustedKeys }),
    verifyRuntimeDataBundle({ ...hosted, trustedKeys }),
  ]);
  if (!localVerified.ok) {
    throw new Error(
      `The local release bootstrap is not trusted: ${localVerified.message}`,
    );
  }
  if (!hostedVerified.ok) {
    throw new Error(
      `The hosted release bootstrap is not trusted: ${hostedVerified.message}`,
    );
  }
  if (localVerified.data.bundleId !== hostedVerified.data.bundleId) {
    throw new Error(
      "The local and hosted release bundle identities differ.",
    );
  }
  return {
    bundleId: localVerified.data.bundleId,
    signingKeyId: localVerified.data.manifest.signature.keyId,
    trustedKeyIds: localRegistry.keys.map((entry) => entry.keyId),
  };
}

export async function runVerifyDataBundleReleaseCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage);
    return;
  }
  const result = await verifyDataBundleRelease({
    root: process.cwd(),
    bootstrapDirectory: args.bootstrapDirectory,
    trustedKeysFile: args.trustedKeysFile,
    hostedAssetsDirectory: args.hostedAssetsDirectory,
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runVerifyDataBundleReleaseCli();
}
