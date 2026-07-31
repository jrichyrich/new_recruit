import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type DataBundleSigner,
  type Ed25519KeyRegistry,
} from "../lib/rosterpilot/data-bundle";
import {
  buildRuntimeDataBundle,
  signRuntimeDataBundle,
  verifyRuntimeDataBundle,
  type RuntimeDataBundleBuild,
  type SignedRuntimeDataBundle,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
} from "../lib/rosterpilot/semantic-hash";
import {
  verifyOfficialPublicationEvidence,
  type OfficialPublicationEvidenceInput,
} from "../lib/rosterpilot/official-data";
import {
  CertificationManifestSchema,
} from "../lib/rosterpilot/certification";
import {
  dataBundleSignerFromEnvironment,
} from "./build-data-bundle";

export const DATA_BUNDLE_RELEASE_USAGE = `Usage: npm run data:bundle:prepare-release -- [options]

Build the signed bootstrap data bundle and additive public-key registry for an
application release.

Options:
  --out-dir <path>             Bootstrap directory
                               (default: data/bootstrap-data-bundle).
  --trusted-keys <path>        Public-key registry
                               (default: data/data-bundle-trusted-keys.json).
  --hosted-assets-dir <path>   Same-origin hosted assets
                               (default: public/data-bundles).
  --official-reconciliation-evidence <path>
                               Official rules overlay JSON.
  --official-source-artifact <path>
                               Exact source bytes covered by that overlay.
  --official-extraction-receipt <path>
                               Reviewed extractor's signed inventory receipt.
  --official-extractor-trusted-keys <path>
                               Reviewed extractor public-key registry (default:
                               data/official-extractor-trusted-keys.json).
  --official-authority-unavailable <reason>
                               Explicitly sign a degraded bootstrap that does
                               not claim official reconciliation. Mutually
                               exclusive with official extraction evidence.
  --created-at <ISO instant>   Override the manifest creation time.
  -h, --help                   Show help without reading signing configuration.

Signing is accepted only through ROSTERPILOT_DATA_SIGNING_KEY_ID and
ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK. The command derives and verifies the
matching public key in memory, writes only public material, and retains every
existing trusted key for a safe rotation overlap.
`;

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

type PublicEd25519Jwk = JsonWebKey & {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  key_ops: ["verify"];
  ext: true;
};

export type TrustedDataBundleKeyRegistryV1 = {
  schemaVersion: 1;
  keys: Array<{
    keyId: string;
    publicKey: PublicEd25519Jwk;
  }>;
};

export type DataBundleReleaseCliArgs = {
  help: boolean;
  outputDirectory: string;
  trustedKeysFile: string;
  hostedAssetsDirectory: string;
  officialReconciliationEvidence: string | null;
  officialSourceArtifact: string | null;
  officialExtractionReceipt: string | null;
  officialExtractorTrustedKeys: string;
  officialAuthorityUnavailableReason: string | null;
  createdAt: string | null;
};

export type PreparedDataBundleRelease = {
  bundleId: string;
  keyId: string;
  publicKeySha256: string;
  outputDirectory: string;
  trustedKeysFile: string;
  hostedAssetsDirectory: string;
  trustedKeyIds: string[];
};

export class DataBundleReleaseCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataBundleReleaseCliUsageError";
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requiredValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new DataBundleReleaseCliUsageError(
      `${option} requires a value.`,
    );
  }
  return value;
}

export function parseDataBundleReleaseArgs(
  argv: readonly string[],
): DataBundleReleaseCliArgs {
  const parsed: DataBundleReleaseCliArgs = {
    help: false,
    outputDirectory: "data/bootstrap-data-bundle",
    trustedKeysFile: "data/data-bundle-trusted-keys.json",
    hostedAssetsDirectory: "public/data-bundles",
    officialReconciliationEvidence: null,
    officialSourceArtifact: null,
    officialExtractionReceipt: null,
    officialExtractorTrustedKeys:
      "data/official-extractor-trusted-keys.json",
    officialAuthorityUnavailableReason: null,
    createdAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--out-dir") {
      parsed.outputDirectory = requiredValue(
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
    } else if (
      argument === "--official-reconciliation-evidence"
    ) {
      parsed.officialReconciliationEvidence = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--official-source-artifact") {
      parsed.officialSourceArtifact = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--official-extraction-receipt") {
      parsed.officialExtractionReceipt = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (
      argument === "--official-extractor-trusted-keys"
    ) {
      parsed.officialExtractorTrustedKeys = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--official-authority-unavailable") {
      parsed.officialAuthorityUnavailableReason = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--created-at") {
      parsed.createdAt = requiredValue(argv, index, argument);
      index += 1;
    } else {
      throw new DataBundleReleaseCliUsageError(
        `Unknown data-bundle release option: ${argument}`,
      );
    }
  }
  return parsed;
}

function publicJwkFromUnknown(
  value: unknown,
  description: string,
): PublicEd25519Jwk {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${description} is not an Ed25519 public JWK.`);
  }
  const candidate = value as JsonWebKey;
  if (
    candidate.kty !== "OKP" ||
    candidate.crv !== "Ed25519" ||
    typeof candidate.x !== "string" ||
    candidate.x.length !== 43 ||
    !base64UrlPattern.test(candidate.x) ||
    typeof candidate.d === "string"
  ) {
    throw new Error(`${description} is not an Ed25519 public JWK.`);
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: candidate.x,
    key_ops: ["verify"],
    ext: true,
  };
}

async function importPublicKey(
  value: PublicEd25519Jwk,
  description: string,
): Promise<CryptoKey> {
  try {
    return await globalThis.crypto.subtle.importKey(
      "jwk",
      value,
      { name: "Ed25519" },
      true,
      ["verify"],
    );
  } catch {
    throw new Error(`${description} is not an Ed25519 public JWK.`);
  }
}

async function privateJwk(
  signer: DataBundleSigner,
): Promise<JsonWebKey> {
  if (
    typeof CryptoKey !== "undefined" &&
    signer.privateKey instanceof CryptoKey
  ) {
    if (
      signer.privateKey.type !== "private" ||
      signer.privateKey.algorithm.name !== "Ed25519" ||
      !signer.privateKey.extractable ||
      !signer.privateKey.usages.includes("sign")
    ) {
      throw new Error(
        "The release signing key must be an extractable Ed25519 private key.",
      );
    }
    return globalThis.crypto.subtle.exportKey(
      "jwk",
      signer.privateKey,
    );
  }
  return signer.privateKey as JsonWebKey;
}

/**
 * Derives the public half of the CI-provided key and proves that it matches
 * the private half by signing and verifying a fixed, non-secret challenge.
 * Private key material is never returned or serialized.
 */
export async function deriveVerifiedEd25519PublicJwk(
  signer: DataBundleSigner,
): Promise<PublicEd25519Jwk> {
  if (!keyIdPattern.test(signer.keyId)) {
    throw new Error(
      "ROSTERPILOT_DATA_SIGNING_KEY_ID is not a valid data-bundle key id.",
    );
  }
  const privateKeyJwk = await privateJwk(signer);
  if (
    privateKeyJwk.kty !== "OKP" ||
    privateKeyJwk.crv !== "Ed25519" ||
    typeof privateKeyJwk.d !== "string" ||
    typeof privateKeyJwk.x !== "string"
  ) {
    throw new Error(
      "ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK must include one complete Ed25519 private JWK.",
    );
  }
  const publicKeyJwk = publicJwkFromUnknown(
    {
      kty: privateKeyJwk.kty,
      crv: privateKeyJwk.crv,
      x: privateKeyJwk.x,
    },
    "The derived verification key",
  );
  let signingKey: CryptoKey;
  try {
    signingKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      {
        kty: "OKP",
        crv: "Ed25519",
        d: privateKeyJwk.d,
        x: privateKeyJwk.x,
        key_ops: ["sign"],
        ext: true,
      },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error(
      "ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK is not an importable Ed25519 private JWK.",
    );
  }
  const verificationKey = await importPublicKey(
    publicKeyJwk,
    "The derived verification key",
  );
  const challenge = new TextEncoder().encode(
    "rosterpilot-data-bundle-release-key-validation-v1",
  );
  const signature = await globalThis.crypto.subtle.sign(
    { name: "Ed25519" },
    signingKey,
    challenge,
  );
  if (
    !(await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      verificationKey,
      signature,
      challenge,
    ))
  ) {
    throw new Error(
      "The Ed25519 private and public key material do not match.",
    );
  }
  return publicKeyJwk;
}

export function parseTrustedDataBundleKeyRegistry(
  input: unknown,
): TrustedDataBundleKeyRegistryV1 {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((input as { keys?: unknown }).keys)
  ) {
    throw new Error(
      "The trusted data-bundle public-key registry is invalid.",
    );
  }
  const seen = new Set<string>();
  const keys = (
    input as {
      keys: Array<{
        keyId?: unknown;
        publicKey?: unknown;
      }>;
    }
  ).keys.map((entry) => {
    if (
      !entry ||
      typeof entry.keyId !== "string" ||
      !keyIdPattern.test(entry.keyId) ||
      seen.has(entry.keyId)
    ) {
      throw new Error(
        "The trusted data-bundle public-key registry contains an invalid or duplicate key id.",
      );
    }
    seen.add(entry.keyId);
    return {
      keyId: entry.keyId,
      publicKey: publicJwkFromUnknown(
        entry.publicKey,
        `Trusted key "${entry.keyId}"`,
      ),
    };
  });
  return {
    schemaVersion: 1,
    keys: keys.sort((left, right) =>
      left.keyId.localeCompare(right.keyId),
    ),
  };
}

export async function addTrustedDataBundleReleaseKey(
  registry: TrustedDataBundleKeyRegistryV1,
  keyId: string,
  publicKey: PublicEd25519Jwk,
): Promise<TrustedDataBundleKeyRegistryV1> {
  const parsed = parseTrustedDataBundleKeyRegistry(registry);
  await Promise.all(
    parsed.keys.map((entry) =>
      importPublicKey(
        entry.publicKey,
        `Trusted key "${entry.keyId}"`,
      ),
    ),
  );
  await importPublicKey(publicKey, `Release key "${keyId}"`);
  const existing = parsed.keys.find(
    (entry) => entry.keyId === keyId,
  );
  if (existing && existing.publicKey.x !== publicKey.x) {
    throw new Error(
      `Trusted key id "${keyId}" already identifies different public key material.`,
    );
  }
  return parseTrustedDataBundleKeyRegistry({
    schemaVersion: 1,
    keys: existing
      ? parsed.keys
      : [...parsed.keys, { keyId, publicKey }],
  });
}

function resolveInsideRoot(
  root: string,
  value: string,
  description: string,
): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(resolvedRoot, value);
  const relative = path.relative(resolvedRoot, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${description} must be inside the project root.`);
  }
  return resolved;
}

function resolveInputPath(root: string, value: string): string {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(root, value);
}

function assertOrdinaryPath(
  filename: string,
  expected: "file" | "directory",
): void {
  if (!existsSync(filename)) return;
  const stats = lstatSync(filename);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Refusing to replace symbolic-link ${expected}: ${filename}.`,
    );
  }
  const matches =
    expected === "file" ? stats.isFile() : stats.isDirectory();
  if (!matches) {
    throw new Error(
      `Release ${expected} path has the wrong type: ${filename}.`,
    );
  }
}

function readTrustedKeyRegistry(
  filename: string,
): TrustedDataBundleKeyRegistryV1 {
  if (!existsSync(filename)) {
    return { schemaVersion: 1, keys: [] };
  }
  return parseTrustedDataBundleKeyRegistry(
    JSON.parse(readFileSync(filename, "utf8")),
  );
}

function registryMap(
  registry: TrustedDataBundleKeyRegistryV1,
): Ed25519KeyRegistry {
  return Object.fromEntries(
    registry.keys.map((entry) => [
      entry.keyId,
      entry.publicKey,
    ]),
  );
}

function writeExclusiveJson(
  filename: string,
  value: unknown,
): void {
  writeFileSync(filename, stableJson(value), {
    flag: "wx",
    mode: 0o644,
  });
}

function writeBootstrapStage(
  stageDirectory: string,
  signed: SignedRuntimeDataBundle,
): void {
  writeExclusiveJson(
    path.join(stageDirectory, "manifest.json"),
    signed.manifest,
  );
  for (const shard of signed.shards) {
    const descriptor = signed.manifest.shards.find(
      (entry) => entry.shardId === shard.shardId,
    );
    if (!descriptor) {
      throw new Error(
        `Signed bootstrap omitted descriptor for shard "${shard.shardId}".`,
      );
    }
    const filename = path.resolve(
      stageDirectory,
      ...descriptor.path.split("/"),
    );
    const relative = path.relative(stageDirectory, filename);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Signed bootstrap shard path escaped its release directory: ${descriptor.path}.`,
      );
    }
    mkdirSync(path.dirname(filename), { recursive: true });
    writeExclusiveJson(filename, shard);
  }
}

function writeAtomicJson(
  filename: string,
  value: unknown,
): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.next-${process.pid}`;
  if (existsSync(temporary)) {
    throw new Error(
      `A previous public-key registry update is incomplete: ${temporary}.`,
    );
  }
  writeExclusiveJson(temporary, value);
  try {
    renameSync(temporary, filename);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

type DataBundleReleaseTransactionV1 = {
  schemaVersion: 1;
  transactionKind: "rosterpilot-data-bundle-release";
  targets: Array<{
    destination: string;
    staged: string;
    backup: string;
  }>;
};

function releaseTransactionPath(root: string): string {
  return path.join(
    root,
    ".rosterpilot-data-bundle-release-transaction.json",
  );
}

function parseReleaseTransaction(
  input: unknown,
): DataBundleReleaseTransactionV1 {
  const candidate = input as Partial<DataBundleReleaseTransactionV1>;
  if (
    candidate?.schemaVersion !== 1 ||
    candidate.transactionKind !==
      "rosterpilot-data-bundle-release" ||
    !Array.isArray(candidate.targets) ||
    candidate.targets.length < 1 ||
    candidate.targets.some(
      (target) =>
        !target ||
        typeof target.destination !== "string" ||
        typeof target.staged !== "string" ||
        typeof target.backup !== "string" ||
        !path.isAbsolute(target.destination) ||
        !path.isAbsolute(target.staged) ||
        !path.isAbsolute(target.backup),
    )
  ) {
    throw new Error(
      "The interrupted data-bundle release transaction is invalid.",
    );
  }
  const parsed = candidate as DataBundleReleaseTransactionV1;
  const allPaths = parsed.targets.flatMap((target) => [
    target.destination,
    target.staged,
    target.backup,
  ]);
  if (
    new Set(allPaths).size !== allPaths.length ||
    parsed.targets.some(
      (target, index) =>
        path.dirname(target.staged) !==
          path.dirname(target.destination) ||
        !path.basename(target.staged).startsWith(
          `.${path.basename(target.destination)}.next-`,
        ) ||
        target.backup !==
          `${target.destination}.previous-release-${index}`,
    )
  ) {
    throw new Error(
      "The interrupted data-bundle release transaction contains unsafe target paths.",
    );
  }
  return parsed;
}

/** Complete a journaled directory swap after a process or machine crash. */
export function recoverInterruptedDataBundleRelease(
  root: string,
): boolean {
  const resolvedRoot = path.resolve(root);
  const journal = releaseTransactionPath(resolvedRoot);
  if (!existsSync(journal)) return false;
  const transaction = parseReleaseTransaction(
    JSON.parse(readFileSync(journal, "utf8")),
  );
  for (const target of transaction.targets) {
    for (const filename of [
      target.destination,
      target.staged,
      target.backup,
    ]) {
      const relative = path.relative(resolvedRoot, filename);
      if (
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
      ) {
        throw new Error(
          "The interrupted data-bundle release escaped the project root.",
        );
      }
    }
    if (existsSync(target.staged)) {
      if (existsSync(target.destination)) {
        if (existsSync(target.backup)) {
          throw new Error(
            `Cannot recover release target with both destination and backup present before installation: ${target.destination}.`,
          );
        }
        renameSync(target.destination, target.backup);
      }
      renameSync(target.staged, target.destination);
    } else if (!existsSync(target.destination)) {
      if (!existsSync(target.backup)) {
        throw new Error(
          `Interrupted release target cannot be recovered: ${target.destination}.`,
        );
      }
      renameSync(target.backup, target.destination);
    }
  }
  for (const target of transaction.targets) {
    rmSync(target.backup, { recursive: true, force: true });
    rmSync(target.staged, { recursive: true, force: true });
  }
  rmSync(journal, { force: true });
  return true;
}

function commitReleaseDirectories(
  root: string,
  targets: Array<{ staged: string; destination: string }>,
): void {
  const transaction: DataBundleReleaseTransactionV1 = {
    schemaVersion: 1,
    transactionKind: "rosterpilot-data-bundle-release",
    targets: targets.map((target, index) => ({
      ...target,
      backup: `${target.destination}.previous-release-${index}`,
    })),
  };
  for (const target of transaction.targets) {
    if (existsSync(target.backup)) {
      throw new Error(
        `A previous release backup requires recovery: ${target.backup}.`,
      );
    }
  }
  writeAtomicJson(releaseTransactionPath(root), transaction);
  // Recovery always completes every remaining staged target, so a crash at
  // any rename boundary is resumable without guessing which version won.
  recoverInterruptedDataBundleRelease(root);
}

async function verifyBootstrapDirectory(
  directory: string,
  registry: TrustedDataBundleKeyRegistryV1,
): Promise<string> {
  const manifest = JSON.parse(
    readFileSync(path.join(directory, "manifest.json"), "utf8"),
  ) as { shards?: Array<{ path?: string }> };
  const shards = (manifest.shards ?? []).map((descriptor) => {
    if (!descriptor.path) {
      throw new Error(
        "The staged release bootstrap has an invalid shard path.",
      );
    }
    return JSON.parse(
      readFileSync(
        path.join(directory, ...descriptor.path.split("/")),
        "utf8",
      ),
    );
  });
  const verified = await verifyRuntimeDataBundle({
    manifest,
    shards,
    trustedKeys: registryMap(registry),
  });
  if (!verified.ok) {
    throw new Error(
      `The staged release bootstrap failed verification: ${verified.message}`,
    );
  }
  return verified.data.bundleId;
}

export async function prepareSignedBootstrapDataBundle(
  build: RuntimeDataBundleBuild,
  options: {
    root: string;
    outputDirectory: string;
    trustedKeysFile: string;
    hostedAssetsDirectory?: string;
    signer: DataBundleSigner;
    officialEvidence?: OfficialPublicationEvidenceInput;
    officialAuthorityUnavailableReason?: string | null;
  },
): Promise<PreparedDataBundleRelease> {
  const root = path.resolve(options.root);
  recoverInterruptedDataBundleRelease(root);
  const outputDirectory = resolveInsideRoot(
    root,
    options.outputDirectory,
    "The bootstrap output directory",
  );
  const trustedKeysFile = resolveInsideRoot(
    root,
    options.trustedKeysFile,
    "The trusted-key registry",
  );
  const hostedAssetsDirectory = resolveInsideRoot(
    root,
    options.hostedAssetsDirectory ?? "public/data-bundles",
    "The hosted data-bundle asset directory",
  );
  const registryInsideOutput = path.relative(
    outputDirectory,
    trustedKeysFile,
  );
  if (
    registryInsideOutput === "" ||
    (!registryInsideOutput.startsWith("..") &&
      !path.isAbsolute(registryInsideOutput))
  ) {
    throw new Error(
      "The trusted-key registry cannot be stored inside the replaceable bootstrap directory.",
    );
  }
  for (const [left, right] of [
    [outputDirectory, hostedAssetsDirectory],
    [hostedAssetsDirectory, outputDirectory],
  ]) {
    const relative = path.relative(left, right);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    ) {
      throw new Error(
        "The local bootstrap and hosted asset directories cannot contain one another.",
      );
    }
  }
  const registryInsideHosted = path.relative(
    hostedAssetsDirectory,
    trustedKeysFile,
  );
  if (
    registryInsideHosted === "" ||
    (!registryInsideHosted.startsWith("..") &&
      !path.isAbsolute(registryInsideHosted))
  ) {
    throw new Error(
      "The source trusted-key registry cannot be stored inside the replaceable hosted asset directory.",
    );
  }
  assertOrdinaryPath(outputDirectory, "directory");
  assertOrdinaryPath(trustedKeysFile, "file");
  assertOrdinaryPath(hostedAssetsDirectory, "directory");

  const globalAuthority = build.shards.find(
    (shard) => shard.data.payloadKind === "rosterpilot-runtime-global",
  )?.data;
  if (
    !globalAuthority ||
    globalAuthority.payloadKind !== "rosterpilot-runtime-global"
  ) {
    throw new Error(
      "The application release has no global official-authority declaration.",
    );
  }

  if (build.officialReconciliation) {
    if (!options.officialEvidence) {
      throw new Error(
        "An application release containing official overrides requires the exact source artifact and a signed receipt from a configured reviewed extractor.",
      );
    }
    const verifiedOfficial = await verifyOfficialPublicationEvidence(
      options.officialEvidence,
    );
    if (
      (await semanticHash(verifiedOfficial.overlay)) !==
        build.officialReconciliation.overlayHash ||
      verifiedOfficial.overlay.source.version !==
        build.draft.provenance.official.version ||
      verifiedOfficial.sourceArtifactSha256 !==
        build.draft.provenance.official.contentSha256
    ) {
      throw new Error(
        "The reviewed official extraction evidence does not bind the application release overlay.",
      );
    }
    if (
      globalAuthority.officialAuthority.status !== "verified" ||
      globalAuthority.officialAuthority.sourceArtifactSha256 !==
        verifiedOfficial.sourceArtifactSha256 ||
      globalAuthority.officialAuthority.overlaySha256 !==
        verifiedOfficial.overlaySha256 ||
      globalAuthority.officialAuthority.receiptSha256 !==
        verifiedOfficial.receiptSha256 ||
      globalAuthority.officialAuthority.extractorId !==
        verifiedOfficial.extractorId ||
      globalAuthority.officialAuthority.extractorKeyId !==
        verifiedOfficial.extractorKeyId
    ) {
      throw new Error(
        "The signed bootstrap does not contain the reviewed official-authority binding.",
      );
    }
  } else if (
    globalAuthority.officialAuthority.status !== "unavailable" ||
    !options.officialAuthorityUnavailableReason?.trim() ||
    globalAuthority.officialAuthority.reason !==
      options.officialAuthorityUnavailableReason
  ) {
    throw new Error(
      "The first trusted application bootstrap requires reviewed official extraction evidence, or an explicit --official-authority-unavailable reason that signs a degraded non-reconciled status.",
    );
  }

  const publicKey = await deriveVerifiedEd25519PublicJwk(
    options.signer,
  );
  const registry = await addTrustedDataBundleReleaseKey(
    readTrustedKeyRegistry(trustedKeysFile),
    options.signer.keyId,
    publicKey,
  );
  const signed = await signRuntimeDataBundle(
    build,
    options.signer,
  );
  const verified = await verifyRuntimeDataBundle({
    manifest: signed.manifest,
    shards: signed.shards,
    trustedKeys: registryMap(registry),
  });
  if (!verified.ok) {
    throw new Error(
      `The release bootstrap failed verification: ${verified.message}`,
    );
  }
  if (
    signed.manifest.signature.keyId !== options.signer.keyId
  ) {
    throw new Error(
      "The release bootstrap was signed by an unexpected key id.",
    );
  }

  mkdirSync(path.dirname(outputDirectory), { recursive: true });
  const stageDirectory = mkdtempSync(
    path.join(
      path.dirname(outputDirectory),
      `.${path.basename(outputDirectory)}.next-`,
    ),
  );
  mkdirSync(path.dirname(hostedAssetsDirectory), {
    recursive: true,
  });
  const hostedStageDirectory = mkdtempSync(
    path.join(
      path.dirname(hostedAssetsDirectory),
      `.${path.basename(hostedAssetsDirectory)}.next-`,
    ),
  );
  try {
    writeBootstrapStage(stageDirectory, signed);
    const hostedBootstrap = path.join(
      hostedStageDirectory,
      "bootstrap",
    );
    mkdirSync(hostedBootstrap, { recursive: true });
    writeBootstrapStage(hostedBootstrap, signed);
    writeExclusiveJson(
      path.join(hostedStageDirectory, "trusted-keys.json"),
      registry,
    );
    const [localBundleId, hostedBundleId] = await Promise.all([
      verifyBootstrapDirectory(stageDirectory, registry),
      verifyBootstrapDirectory(hostedBootstrap, registry),
    ]);
    if (
      localBundleId !== signed.manifest.bundleId ||
      hostedBundleId !== signed.manifest.bundleId
    ) {
      throw new Error(
        "The local and hosted release bootstraps do not identify the signed candidate.",
      );
    }

    // Trust moves first. A crash between these two atomic renames can leave
    // an unused public key installed, but can never leave a bootstrap signed
    // by an untrusted key.
    writeAtomicJson(trustedKeysFile, registry);
    commitReleaseDirectories(root, [
      { staged: stageDirectory, destination: outputDirectory },
      {
        staged: hostedStageDirectory,
        destination: hostedAssetsDirectory,
      },
    ]);
  } finally {
    // Once the transaction journal exists, its staged directories are the
    // recovery source of truth. Preserve them if a filesystem error interrupts
    // the swap; the next release invocation will complete the journal first.
    if (!existsSync(releaseTransactionPath(root))) {
      if (existsSync(stageDirectory)) {
        rmSync(stageDirectory, { recursive: true, force: true });
      }
      if (existsSync(hostedStageDirectory)) {
        rmSync(hostedStageDirectory, {
          recursive: true,
          force: true,
        });
      }
    }
  }
  return {
    bundleId: signed.manifest.bundleId,
    keyId: options.signer.keyId,
    publicKeySha256: await sha256Hex(canonicalJson(publicKey)),
    outputDirectory,
    trustedKeysFile,
    hostedAssetsDirectory,
    trustedKeyIds: registry.keys.map((entry) => entry.keyId),
  };
}

async function acquireReleaseLock(
  root: string,
): Promise<() => void> {
  const lockFile = path.join(
    root,
    ".rosterpilot-data-bundle-release.lock",
  );
  if (existsSync(lockFile)) {
    let owner: { processId?: unknown };
    try {
      owner = JSON.parse(readFileSync(lockFile, "utf8")) as {
        processId?: unknown;
      };
    } catch {
      throw new Error(
        `The data-bundle release lock is invalid and requires manual review: ${lockFile}.`,
      );
    }
    if (
      typeof owner.processId !== "number" ||
      !Number.isInteger(owner.processId) ||
      owner.processId < 1
    ) {
      throw new Error(
        `The data-bundle release lock has no valid owner and requires manual review: ${lockFile}.`,
      );
    }
    let running = true;
    try {
      process.kill(owner.processId, 0);
    } catch (error) {
      running =
        (error as NodeJS.ErrnoException).code === "EPERM";
    }
    if (running) {
      throw new Error(
        `Another data-bundle release preparation is active: ${lockFile}.`,
      );
    }
    unlinkSync(lockFile);
  }
  let descriptor: number;
  try {
    descriptor = openSync(lockFile, "wx", 0o600);
  } catch {
    throw new Error(
      `Another data-bundle release preparation is active, or its lock must be reviewed: ${lockFile}.`,
    );
  }
  writeSync(
    descriptor,
    `${JSON.stringify({
      schemaVersion: 1,
      processId: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`,
  );
  closeSync(descriptor);
  return () => {
    if (existsSync(lockFile)) unlinkSync(lockFile);
  };
}

export async function runPrepareDataBundleReleaseCli(
  argv: readonly string[],
  options: {
    root?: string;
    environment?: NodeJS.ProcessEnv;
    writeOutput?: (value: string) => void;
    buildRuntimeBundle?: (
      input: Parameters<typeof buildRuntimeDataBundle>[0],
    ) => Promise<RuntimeDataBundleBuild>;
  } = {},
): Promise<void> {
  const args = parseDataBundleReleaseArgs(argv);
  const writeOutput =
    options.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (args.help) {
    writeOutput(DATA_BUNDLE_RELEASE_USAGE);
    return;
  }
  const root = path.resolve(options.root ?? process.cwd());
  const release = await acquireReleaseLock(root);
  try {
    recoverInterruptedDataBundleRelease(root);
    const signer = dataBundleSignerFromEnvironment(
      options.environment ?? process.env,
    );
    // Validate the key before reading or constructing the larger bundle.
    await deriveVerifiedEd25519PublicJwk(signer);
    const certification = CertificationManifestSchema.parse(
      JSON.parse(
        readFileSync(
          path.join(root, "data", "certification-manifest.json"),
          "utf8",
        ),
      ),
    );
    const officialOverlay =
      args.officialReconciliationEvidence === null
        ? undefined
        : JSON.parse(
            readFileSync(
              resolveInputPath(
                root,
                args.officialReconciliationEvidence,
              ),
              "utf8",
            ),
          );
    const hasAnyOfficialEvidence = Boolean(
      args.officialReconciliationEvidence ||
        args.officialSourceArtifact ||
        args.officialExtractionReceipt,
    );
    const hasCompleteOfficialEvidence = Boolean(
      args.officialReconciliationEvidence &&
        args.officialSourceArtifact &&
        args.officialExtractionReceipt,
    );
    if (hasAnyOfficialEvidence && !hasCompleteOfficialEvidence) {
      throw new Error(
        "Official publication requires --official-reconciliation-evidence, --official-source-artifact, and --official-extraction-receipt together.",
      );
    }
    if (
      hasAnyOfficialEvidence &&
      args.officialAuthorityUnavailableReason
    ) {
      throw new Error(
        "Official extraction evidence and --official-authority-unavailable are mutually exclusive.",
      );
    }
    if (
      !hasCompleteOfficialEvidence &&
      !args.officialAuthorityUnavailableReason
    ) {
      throw new Error(
        "The first trusted application bootstrap requires reviewed official extraction evidence. To publish a deliberately degraded bootstrap instead, provide --official-authority-unavailable with a reviewable reason.",
      );
    }
    const officialEvidence: OfficialPublicationEvidenceInput | undefined =
      hasCompleteOfficialEvidence
        ? {
            overlay: officialOverlay,
            sourceArtifact: readFileSync(
              resolveInputPath(root, args.officialSourceArtifact!),
            ),
            extractionReceipt: JSON.parse(
              readFileSync(
                resolveInputPath(
                  root,
                  args.officialExtractionReceipt!,
                ),
                "utf8",
              ),
            ),
            trustedExtractors: JSON.parse(
              readFileSync(
                resolveInputPath(
                  root,
                  args.officialExtractorTrustedKeys,
                ),
                "utf8",
              ),
            ),
          }
        : undefined;
    const verifiedOfficialEvidence = officialEvidence
      ? await verifyOfficialPublicationEvidence(officialEvidence)
      : null;
    const build = await (
      options.buildRuntimeBundle ?? buildRuntimeDataBundle
    )({
      certification,
      officialOverlay,
      officialAuthority: verifiedOfficialEvidence
        ? {
            status: "verified",
            sourceArtifactSha256:
              verifiedOfficialEvidence.sourceArtifactSha256,
            overlaySha256: verifiedOfficialEvidence.overlaySha256,
            receiptSha256: verifiedOfficialEvidence.receiptSha256,
            extractorId: verifiedOfficialEvidence.extractorId,
            extractorKeyId:
              verifiedOfficialEvidence.extractorKeyId,
          }
        : {
            status: "unavailable",
            reason: args.officialAuthorityUnavailableReason!,
          },
      createdAt: args.createdAt ?? new Date().toISOString(),
    });
    const prepared = await prepareSignedBootstrapDataBundle(
      build,
      {
        root,
        outputDirectory: args.outputDirectory,
        trustedKeysFile: args.trustedKeysFile,
        hostedAssetsDirectory: args.hostedAssetsDirectory,
        signer,
        officialEvidence,
        officialAuthorityUnavailableReason:
          args.officialAuthorityUnavailableReason,
      },
    );
    writeOutput(
      `${JSON.stringify(
        {
          ok: true,
          bundleId: prepared.bundleId,
          keyId: prepared.keyId,
          publicKeySha256: prepared.publicKeySha256,
          outputDirectory: prepared.outputDirectory,
          trustedKeysFile: prepared.trustedKeysFile,
          hostedAssetsDirectory:
            prepared.hostedAssetsDirectory,
          trustedKeyIds: prepared.trustedKeyIds,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    release();
  }
}

async function main(): Promise<void> {
  try {
    await runPrepareDataBundleReleaseCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof DataBundleReleaseCliUsageError) {
      process.stderr.write(
        `${error.message}\nRun with --help for usage.\n`,
      );
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
