import crypto from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  createSignedDataBundleChannelPointer,
  createSignedDataBundleQuarantineRecord,
  dataBundleChannelPointerSha256,
  dataBundleSemanticIdentitySha256,
  verifyDataBundleChannelPointer,
  verifyDataBundleManifest,
  verifyDataBundleQuarantineRecord,
  verifyDataBundleShard,
  type DataBundleQuarantineRecordV1,
  type DataBundleSigner,
  type Ed25519KeyRegistry,
  type VerifiedDataBundleChannelPointerV2,
  type VerifiedDataBundleManifestV1,
} from "../lib/rosterpilot/data-bundle";
import {
  canonicalJson,
  sha256Hex,
} from "../lib/rosterpilot/semantic-hash";
import {
  LIVE_CANARY_IDS,
  type LiveCanaryId,
} from "../local/certification/live-canaries";
import {
  dataBundleSignerFromEnvironment,
} from "./build-data-bundle";
import {
  deriveVerifiedEd25519PublicJwk,
} from "./prepare-data-bundle-release";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REPORT_BYTES = 16 * 1_024 * 1_024;
const MAX_MANIFEST_BYTES = 8 * 1_024 * 1_024;
const MAX_SHARD_BYTES = 64 * 1_024 * 1_024;

const LiveCanaryRollbackReportSchema = z
  .object({
    reportKind: z.literal("rosterpilot-rotating-live-canary"),
    canary: z
      .object({
        id: z.enum(LIVE_CANARY_IDS),
      })
      .passthrough(),
    status: z.enum(["pass", "fail", "unavailable"]),
    livePass: z.boolean(),
    evidenceKind: z.enum(["live", "none"]),
    releaseEvidence: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("bundle-bound"),
          expectedBundleId: z
            .string()
            .regex(SHA256_PATTERN),
        })
        .strict(),
      z
        .object({
          kind: z.literal("ad-hoc"),
          expectedBundleId: z.null(),
        })
        .strict(),
    ]),
    dataBundle: z
      .object({
        bundleId: z.string().regex(SHA256_PATTERN),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

type VerifiedCanaryReport = z.infer<
  typeof LiveCanaryRollbackReportSchema
> & {
  reportSha256: string;
};

type RollbackOptions = {
  channelRoot: string;
  reportsRoot: string;
  channel: string;
  failedBundleId: string;
  manifestBaseUrl: string;
  signer: DataBundleSigner;
  trustedKeys: Ed25519KeyRegistry;
  now?: () => Date;
};

export type CanaryRollbackResult = {
  action: "none" | "rolled-back" | "already-rolled-back";
  failedBundleId: string;
  rollbackBundleId: string | null;
  failedCanaries: LiveCanaryId[];
  quarantinePath: string | null;
  quarantineRelativePath: string | null;
  quarantineRecordSha256: string | null;
  pointerPath: string;
};

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readBoundedJson(
  filename: string,
  byteLimit: number,
): Promise<unknown> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Expected a regular JSON file at ${filename}.`);
  }
  if (metadata.size > byteLimit) {
    throw new Error(
      `${filename} exceeds the ${byteLimit}-byte safety limit.`,
    );
  }
  return JSON.parse(await readFile(filename, "utf8"));
}

async function regularFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Live-canary evidence cannot contain a symbolic link: ${filename}.`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await regularFiles(filename)));
    } else if (entry.isFile()) {
      files.push(filename);
    }
  }
  return files;
}

async function sha256File(filename: string): Promise<string> {
  return crypto
    .createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function verifiedCanaryReports(
  reportsRoot: string,
  expectedBundleId: string,
): Promise<VerifiedCanaryReport[]> {
  const files = (await regularFiles(reportsRoot)).filter(
    (filename) =>
      path.basename(filename).startsWith("live-canary-") &&
      filename.endsWith(".json"),
  );
  const byCanary = new Map<LiveCanaryId, VerifiedCanaryReport>();
  for (const filename of files) {
    const checksumFilename = `${filename}.sha256`;
    const checksum = await readFile(checksumFilename, "utf8");
    const reportSha256 = await sha256File(filename);
    if (
      checksum !==
      `${reportSha256}  ${path.basename(filename)}\n`
    ) {
      throw new Error(
        `Detached live-canary checksum verification failed for ${filename}.`,
      );
    }
    const report = LiveCanaryRollbackReportSchema.parse(
      await readBoundedJson(filename, MAX_REPORT_BYTES),
    );
    if (byCanary.has(report.canary.id)) {
      throw new Error(
        `Live-canary evidence repeats ${report.canary.id}.`,
      );
    }
    if (report.releaseEvidence.kind !== "bundle-bound") {
      throw new Error(
        `Live canary ${report.canary.id} is ad-hoc evidence; automatic release rollback requires an exact bundle binding.`,
      );
    }
    if (
      report.releaseEvidence.expectedBundleId !==
      expectedBundleId
    ) {
      throw new Error(
        `Live canary ${report.canary.id} release evidence is bound to ${report.releaseEvidence.expectedBundleId}, not expected bundle ${expectedBundleId}.`,
      );
    }
    if (
      report.status === "unavailable" ||
      report.evidenceKind !== "live"
    ) {
      throw new Error(
        `Live canary ${report.canary.id} is ${report.status} with ${report.evidenceKind} evidence; automatic release rollback requires complete live evidence from every canary.`,
      );
    }
    if (report.dataBundle?.bundleId !== expectedBundleId) {
      throw new Error(
        `Live canary ${report.canary.id} is not bound to expected bundle ${expectedBundleId}.`,
      );
    }
    if (
      report.status === "pass" &&
      (!report.livePass || report.evidenceKind !== "live")
    ) {
      throw new Error(
        `Live canary ${report.canary.id} has an inconsistent pass result.`,
      );
    }
    if (report.status === "fail" && report.livePass) {
      throw new Error(
        `Live canary ${report.canary.id} has an inconsistent failure result.`,
      );
    }
    byCanary.set(report.canary.id, {
      ...report,
      reportSha256,
    });
  }
  const missing = LIVE_CANARY_IDS.filter(
    (canaryId) => !byCanary.has(canaryId),
  );
  if (missing.length > 0) {
    throw new Error(
      `Live-canary rollback evidence is incomplete: ${missing.join(", ")}.`,
    );
  }
  return LIVE_CANARY_IDS.map((canaryId) => byCanary.get(canaryId)!);
}

function safeBundleFile(
  bundleDirectory: string,
  relativePath: string,
): string {
  const resolved = path.resolve(
    bundleDirectory,
    ...relativePath.split("/"),
  );
  if (!resolved.startsWith(`${bundleDirectory}${path.sep}`)) {
    throw new Error(
      `Unsafe data-bundle shard path ${relativePath}.`,
    );
  }
  return resolved;
}

async function verifiedBundle(
  channelRoot: string,
  bundleId: string,
  trustedKeys: Ed25519KeyRegistry,
): Promise<VerifiedDataBundleManifestV1> {
  const bundleDirectory = path.join(
    channelRoot,
    "bundles",
    bundleId,
  );
  const manifestInput = await readBoundedJson(
    path.join(bundleDirectory, "manifest.json"),
    MAX_MANIFEST_BYTES,
  );
  const manifest = await verifyDataBundleManifest(
    manifestInput,
    trustedKeys,
  );
  if (!manifest.ok) {
    throw new Error(
      `Data-bundle manifest verification failed: ${manifest.message}`,
    );
  }
  if (manifest.data.bundleId !== bundleId) {
    throw new Error(
      `Verified data-bundle manifest does not match ${bundleId}.`,
    );
  }
  for (const descriptor of manifest.data.shards) {
    const shard = await verifyDataBundleShard(
      manifest.data,
      await readBoundedJson(
        safeBundleFile(bundleDirectory, descriptor.path),
        MAX_SHARD_BYTES,
      ),
    );
    if (!shard.ok) {
      throw new Error(
        `Data-bundle shard verification failed: ${shard.message}`,
      );
    }
  }
  return manifest.data;
}

async function writeAtomicJson(
  filename: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filename), {
    recursive: true,
  });
  const temporary = `${filename}.next-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, stableJson(value), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, filename);
}

async function writeImmutableJson(
  filename: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filename), {
    recursive: true,
  });
  try {
    await writeFile(filename, stableJson(value), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    const existing = await readBoundedJson(
      filename,
      MAX_MANIFEST_BYTES,
    );
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error(
        `Immutable quarantine path already contains different content: ${filename}.`,
      );
    }
  }
}

function normalizedBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(
      "Published data-bundle URLs must use HTTPS.",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

async function existingQuarantine(
  filename: string,
  trustedKeys: Ed25519KeyRegistry,
): Promise<DataBundleQuarantineRecordV1 | null> {
  try {
    const verified = await verifyDataBundleQuarantineRecord(
      await readBoundedJson(filename, MAX_MANIFEST_BYTES),
      trustedKeys,
    );
    if (!verified.ok) {
      throw new Error(
        `Existing quarantine verification failed: ${verified.message}`,
      );
    }
    return verified.data;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function verifiedRollbackPredecessor(
  channelRoot: string,
  pointer: VerifiedDataBundleChannelPointerV2,
  trustedKeys: Ed25519KeyRegistry,
): Promise<string> {
  if (pointer.transition.kind !== "publish") {
    throw new Error(
      "Automatic live-canary rollback requires the failed bundle to come from a signed v2 publication transition; a failed rollback transition requires operator intervention.",
    );
  }
  if (!pointer.previous) {
    throw new Error(
      "Automatic live-canary rollback requires a signed v2 channel transition with a predecessor.",
    );
  }
  const predecessorFilename = path.join(
    channelRoot,
    "channels",
    pointer.channel,
    `${pointer.previous.pointerSha256}.json`,
  );
  const predecessor = await verifyDataBundleChannelPointer(
    await readBoundedJson(
      predecessorFilename,
      MAX_MANIFEST_BYTES,
    ),
    trustedKeys,
  );
  if (!predecessor.ok) {
    throw new Error(
      `Signed channel predecessor verification failed: ${predecessor.message}`,
    );
  }
  const predecessorSha256 =
    await dataBundleChannelPointerSha256(predecessor.data);
  if (
    predecessorSha256 !== pointer.previous.pointerSha256
  ) {
    throw new Error(
      "The signed channel predecessor does not match its content-addressed ancestry hash.",
    );
  }
  if (predecessor.data.channel !== pointer.channel) {
    throw new Error(
      "A signed channel rollback cannot cross channel ancestry.",
    );
  }
  const expectedRevision =
    predecessor.data.schemaVersion === 2
      ? predecessor.data.revision + 1
      : 1;
  if (pointer.revision !== expectedRevision) {
    throw new Error(
      `Signed channel revision ${pointer.revision} does not immediately follow predecessor revision ${expectedRevision - 1}.`,
    );
  }
  if (
    pointer.transition.fromBundleId !==
    predecessor.data.bundleId
  ) {
    throw new Error(
      "The signed channel transition is not bound to its verified predecessor bundle.",
    );
  }
  if (
    new Date(pointer.publishedAt).getTime() <
    new Date(predecessor.data.publishedAt).getTime()
  ) {
    throw new Error(
      "Signed channel publication time moved backwards within the rollback ancestry.",
    );
  }
  return predecessor.data.bundleId;
}

export async function rollbackDataBundleAfterCanary(
  options: RollbackOptions,
): Promise<CanaryRollbackResult> {
  if (!SHA256_PATTERN.test(options.failedBundleId)) {
    throw new Error(
      "The failed bundle must be an exact lowercase SHA-256 ID.",
    );
  }
  const channelRoot = path.resolve(options.channelRoot);
  const reports = await verifiedCanaryReports(
    path.resolve(options.reportsRoot),
    options.failedBundleId,
  );
  const failedCanaries = reports
    .filter(
      (report) =>
        report.status === "fail" &&
        report.evidenceKind === "live",
    )
    .map((report) => report.canary.id);
  const pointerPath = path.join(
    channelRoot,
    "channels",
    `${options.channel}.json`,
  );
  const pointer = await verifyDataBundleChannelPointer(
    await readBoundedJson(pointerPath, MAX_MANIFEST_BYTES),
    options.trustedKeys,
  );
  if (!pointer.ok) {
    throw new Error(
      `Stable-channel pointer verification failed: ${pointer.message}`,
    );
  }
  const quarantinePath = path.join(
    channelRoot,
    "quarantines",
    `${options.failedBundleId}.json`,
  );
  const quarantineRelativePath = path.posix.join(
    "quarantines",
    `${options.failedBundleId}.json`,
  );
  const previousQuarantine = await existingQuarantine(
    quarantinePath,
    options.trustedKeys,
  );
  if (pointer.data.bundleId !== options.failedBundleId) {
    if (
      previousQuarantine?.rollbackBundleId ===
      pointer.data.bundleId
    ) {
      return {
        action: "already-rolled-back",
        failedBundleId: options.failedBundleId,
        rollbackBundleId:
          previousQuarantine.rollbackBundleId,
        failedCanaries,
        quarantinePath,
        quarantineRelativePath,
        quarantineRecordSha256: await sha256Hex(
          canonicalJson(previousQuarantine),
        ),
        pointerPath,
      };
    }
    throw new Error(
      `The signed ${options.channel} channel moved from failed bundle ${options.failedBundleId} to ${pointer.data.bundleId}; refusing to overwrite concurrent publication.`,
    );
  }
  if (
    failedCanaries.length === 0 &&
    !previousQuarantine
  ) {
    return {
      action: "none",
      failedBundleId: options.failedBundleId,
      rollbackBundleId: null,
      failedCanaries,
      quarantinePath: null,
      quarantineRelativePath: null,
      quarantineRecordSha256: null,
      pointerPath,
    };
  }
  if (pointer.data.schemaVersion !== 2) {
    throw new Error(
      "Automatic live-canary rollback requires a signed v2 channel transition; unsigned update receipts and legacy v1 pointers cannot identify the rollback predecessor.",
    );
  }

  const failedManifest = await verifiedBundle(
    channelRoot,
    options.failedBundleId,
    options.trustedKeys,
  );
  const rollbackBundleId = await verifiedRollbackPredecessor(
    channelRoot,
    pointer.data,
    options.trustedKeys,
  );
  if (
    previousQuarantine &&
    previousQuarantine.rollbackBundleId !== rollbackBundleId
  ) {
    throw new Error(
      "The existing signed quarantine rollback target does not match the verified channel predecessor.",
    );
  }
  const rollbackManifest = await verifiedBundle(
    channelRoot,
    rollbackBundleId,
    options.trustedKeys,
  );
  const rollbackQuarantine = await existingQuarantine(
    path.join(
      channelRoot,
      "quarantines",
      `${rollbackManifest.bundleId}.json`,
    ),
    options.trustedKeys,
  );
  if (rollbackQuarantine) {
    throw new Error(
      `The proposed rollback bundle ${rollbackManifest.bundleId} is quarantined.`,
    );
  }

  const now = (options.now ?? (() => new Date()))().toISOString();
  const quarantine =
    previousQuarantine ??
    (await createSignedDataBundleQuarantineRecord(
      {
        schemaVersion: 1,
        recordKind:
          "rosterpilot-data-bundle-channel-quarantine",
        channel: options.channel,
        bundleId: failedManifest.bundleId,
        semanticIdentitySha256:
          await dataBundleSemanticIdentitySha256(
            failedManifest,
          ),
        rollbackBundleId: rollbackManifest.bundleId,
        reasonCode: "LIVE_CANARY_FAILED",
        reason:
          `Post-activation live certification failed for ${failedCanaries.join(", ")}.`,
        scopes: ["bundle"],
        createdAt: now,
        evidence: reports.map((report) => ({
          canaryId: report.canary.id,
          reportSha256: report.reportSha256,
          status: report.status,
        })),
      },
      options.signer,
    ));
  const quarantineRecordSha256 = await sha256Hex(
    canonicalJson(quarantine),
  );
  const baseUrl = normalizedBaseUrl(options.manifestBaseUrl);
  const previousPointerSha256 =
    await dataBundleChannelPointerSha256(pointer.data);
  const rollbackPointer =
    await createSignedDataBundleChannelPointer(
      {
        schemaVersion: 2,
        channel: options.channel,
        bundleId: rollbackManifest.bundleId,
        manifestUrl:
          `${baseUrl}/bundles/${rollbackManifest.bundleId}/manifest.json`,
        publishedAt: now,
        revision:
          pointer.data.schemaVersion === 2
            ? pointer.data.revision + 1
            : 1,
        previous: {
          pointerSha256: previousPointerSha256,
          pointerUrl:
            `${baseUrl}/channels/${options.channel}/` +
            `${previousPointerSha256}.json`,
        },
        transition: {
          kind: "rollback",
          fromBundleId: pointer.data.bundleId,
          reasonCode: "LIVE_CANARY_FAILED",
          quarantineRecordSha256,
        },
      },
      options.signer,
    );
  const rollbackPointerSha256 =
    await dataBundleChannelPointerSha256(rollbackPointer);
  await writeImmutableJson(quarantinePath, quarantine);
  await writeImmutableJson(
    path.join(
      channelRoot,
      "channels",
      options.channel,
      `${previousPointerSha256}.json`,
    ),
    pointer.data,
  );
  await writeImmutableJson(
    path.join(
      channelRoot,
      "channels",
      options.channel,
      `${rollbackPointerSha256}.json`,
    ),
    rollbackPointer,
  );
  await writeAtomicJson(
    path.join(
      channelRoot,
      "channels",
      `${options.channel}.update.json`,
    ),
    {
      schemaVersion: 1,
      updateKind: "live-canary-rollback",
      channel: options.channel,
      previousBundleId: failedManifest.bundleId,
      candidateBundleId: rollbackManifest.bundleId,
      createdAt: now,
      quarantineRecordSha256,
    },
  );
  // The signed pointer is the commit record and always moves last.
  await writeAtomicJson(pointerPath, rollbackPointer);
  return {
    action: "rolled-back",
    failedBundleId: failedManifest.bundleId,
    rollbackBundleId: rollbackManifest.bundleId,
    failedCanaries,
    quarantinePath,
    quarantineRelativePath,
    quarantineRecordSha256,
    pointerPath,
  };
}

type ParsedArguments = {
  channelRoot: string;
  reportsRoot: string;
  channel: string;
  failedBundleId: string;
  manifestBaseUrl: string;
  trustedKeysFile: string;
};

function argumentValue(
  argv: readonly string[],
  option: string,
): string {
  const index = argv.indexOf(option);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} is required.`);
  }
  return value;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  return {
    channelRoot: path.resolve(
      argumentValue(argv, "--channel-root"),
    ),
    reportsRoot: path.resolve(
      argumentValue(argv, "--reports-root"),
    ),
    channel: argumentValue(argv, "--channel"),
    failedBundleId: argumentValue(
      argv,
      "--failed-bundle-id",
    ),
    manifestBaseUrl: argumentValue(
      argv,
      "--manifest-base-url",
    ),
    trustedKeysFile: path.resolve(
      argumentValue(argv, "--trusted-keys"),
    ),
  };
}

async function trustedKeysFromFile(
  filename: string,
  signer: DataBundleSigner,
): Promise<Ed25519KeyRegistry> {
  const input = z
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
    .strict()
    .parse(await readBoundedJson(filename, MAX_MANIFEST_BYTES));
  const keys: Record<string, JsonWebKey> = Object.fromEntries(
    input.keys.map((entry) => [
      entry.keyId,
      entry.publicKey as JsonWebKey,
    ]),
  );
  const releasePublicKey =
    await deriveVerifiedEd25519PublicJwk(signer);
  const trustedReleaseKey = keys[signer.keyId];
  if (
    !trustedReleaseKey ||
    trustedReleaseKey.kty !== "OKP" ||
    trustedReleaseKey.crv !== "Ed25519" ||
    trustedReleaseKey.x !== releasePublicKey.x
  ) {
    throw new Error(
      `The rollback signing key "${signer.keyId}" is not installed with matching public material in the trusted-key registry.`,
    );
  }
  return keys;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const signer = dataBundleSignerFromEnvironment();
  const result = await rollbackDataBundleAfterCanary({
    ...args,
    signer,
    trustedKeys: await trustedKeysFromFile(
      args.trustedKeysFile,
      signer,
    ),
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
