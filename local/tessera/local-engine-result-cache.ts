import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";

const sha256Pattern = /^[0-9a-f]{64}$/;
const maximumPointerBytes = 64 * 1024;
const maximumReceiptBytes = 1024 * 1024;
export const LOCAL_ENGINE_RESULT_CACHE_MAX_BYTES = 128 * 1024 * 1024;

const cacheKeySchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal("local-engine"),
  providerIdentitySha256: z.string().regex(sha256Pattern),
  bundleId: z.string().min(1).max(512),
  bundleManifestSha256: z.string().regex(sha256Pattern),
  playerRosterSha256: z.string().regex(sha256Pattern),
  opponentRosterSha256: z.string().regex(sha256Pattern),
  playerEntityHashesSha256: z.string().regex(sha256Pattern),
  opponentEntityHashesSha256: z.string().regex(sha256Pattern),
  profilePolicySha256: z.string().regex(sha256Pattern).nullable(),
  scenarioContractSha256: z.string().regex(sha256Pattern),
  iterations: z.number().int().positive().max(100_000_000),
  seed: z.number().int().nonnegative().max(0xffff_ffff),
  compilerVersion: z.string().min(1).max(256),
  adapterVersion: z.string().min(1).max(256),
}).strict();

const receiptPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("tessera-local-engine-result-receipt"),
  key: cacheKeySchema,
  keySha256: z.string().regex(sha256Pattern),
  resultSha256: z.string().regex(sha256Pattern),
  resultByteLength: z.number().int().nonnegative(),
}).strict();

const receiptSchema = receiptPayloadSchema.extend({
  integritySha256: z.string().regex(sha256Pattern),
}).strict();

const pointerPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("tessera-local-engine-result-pointer"),
  keySha256: z.string().regex(sha256Pattern),
  receiptSha256: z.string().regex(sha256Pattern),
}).strict();

const pointerSchema = pointerPayloadSchema.extend({
  integritySha256: z.string().regex(sha256Pattern),
}).strict();

export type LocalEngineResultCacheKey = z.infer<typeof cacheKeySchema>;
export type LocalEngineResultCacheReceipt = z.infer<typeof receiptSchema>;

export type LocalEngineResultCacheKeyInput = Readonly<{
  providerIdentitySha256: string;
  bundleId: string;
  bundleManifestSha256: string;
  playerRosterSha256: string;
  opponentRosterSha256: string;
  playerEntityHashesSha256: string;
  opponentEntityHashesSha256: string;
  profilePolicySha256: string | null;
  scenarioContractSha256: string;
  iterations: number;
  seed: number;
  compilerVersion: string;
  adapterVersion: string;
}>;

export type LocalEngineResultCacheInvalidReason =
  | "pointer-missing"
  | "pointer-not-regular-file"
  | "pointer-too-large"
  | "pointer-malformed"
  | "pointer-noncanonical"
  | "pointer-integrity-mismatch"
  | "pointer-key-mismatch"
  | "receipt-missing"
  | "receipt-not-regular-file"
  | "receipt-too-large"
  | "receipt-malformed"
  | "receipt-noncanonical"
  | "receipt-integrity-mismatch"
  | "receipt-address-mismatch"
  | "receipt-key-mismatch"
  | "result-missing"
  | "result-not-regular-file"
  | "result-too-large"
  | "result-byte-length-mismatch"
  | "result-integrity-mismatch"
  | "result-malformed"
  | "result-noncanonical";

export type LocalEngineResultCacheHit<TResult = unknown> = Readonly<{
  status: "hit";
  keySha256: string;
  receiptSha256: string;
  resultSha256: string;
  result: TResult;
}>;

export type LocalEngineResultCacheMiss = Readonly<{
  status: "miss" | "invalid";
  reason: LocalEngineResultCacheInvalidReason;
  keySha256: string;
}>;

export type LocalEngineResultCacheLoad<TResult = unknown> =
  | LocalEngineResultCacheHit<TResult>
  | LocalEngineResultCacheMiss;

export type LocalEngineResultCacheStore = Readonly<{
  status: "installed" | "reused";
  keySha256: string;
  receiptSha256: string;
  resultSha256: string;
}>;

export type LocalEngineResultCacheStoreOptions = Readonly<{
  lockTimeoutMs?: number;
}>;

export type LocalEngineResultCacheErrorCode =
  | "LOCAL_ENGINE_RESULT_CACHE_BUSY"
  | "LOCAL_ENGINE_RESULT_CACHE_CONFLICT"
  | "LOCAL_ENGINE_RESULT_CACHE_INVALID_EXISTING"
  | "LOCAL_ENGINE_RESULT_CACHE_RESULT_TOO_LARGE"
  | "LOCAL_ENGINE_RESULT_CACHE_UNSAFE_BOUNDARY"
  | "LOCAL_ENGINE_RESULT_CACHE_WRITE_FAILED";

export class LocalEngineResultCacheError extends Error {
  readonly code: LocalEngineResultCacheErrorCode;
  readonly keySha256: string | null;

  constructor(
    code: LocalEngineResultCacheErrorCode,
    message: string,
    keySha256: string | null = null,
  ) {
    super(message);
    this.name = "LocalEngineResultCacheError";
    this.code = code;
    this.keySha256 = keySha256;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return value;
}

function nodeErrorCode(error: unknown): string | null {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function normalizeSha256(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function createLocalEngineResultCacheKey(
  input: LocalEngineResultCacheKeyInput,
): LocalEngineResultCacheKey {
  return deepFreeze(cacheKeySchema.parse({
    schemaVersion: 1,
    provider: "local-engine",
    providerIdentitySha256: normalizeSha256(
      input.providerIdentitySha256,
    ),
    bundleId: input.bundleId.trim(),
    bundleManifestSha256: normalizeSha256(
      input.bundleManifestSha256,
    ),
    playerRosterSha256: normalizeSha256(input.playerRosterSha256),
    opponentRosterSha256: normalizeSha256(input.opponentRosterSha256),
    playerEntityHashesSha256: normalizeSha256(
      input.playerEntityHashesSha256,
    ),
    opponentEntityHashesSha256: normalizeSha256(
      input.opponentEntityHashesSha256,
    ),
    profilePolicySha256:
      input.profilePolicySha256 === null
        ? null
        : normalizeSha256(input.profilePolicySha256),
    scenarioContractSha256: normalizeSha256(
      input.scenarioContractSha256,
    ),
    iterations: input.iterations,
    seed: input.seed,
    compilerVersion: input.compilerVersion.trim(),
    adapterVersion: input.adapterVersion.trim(),
  }));
}

export function localEngineResultCacheKeySha256(
  key: LocalEngineResultCacheKey,
): string {
  return sha256(canonicalJson(cacheKeySchema.parse(key)));
}

export function localEngineResultCachePaths(
  cacheDirectory: string,
  key: LocalEngineResultCacheKey,
  addresses: {
    receiptSha256?: string;
    resultSha256?: string;
  } = {},
): Readonly<{
  keySha256: string;
  pointerPath: string;
  receiptPath: string | null;
  resultPath: string | null;
  lockPath: string;
}> {
  const parsedKey = cacheKeySchema.parse(key);
  const keySha256 = localEngineResultCacheKeySha256(parsedKey);
  const root = path.resolve(cacheDirectory);
  const receiptSha256 = addresses.receiptSha256
    ? normalizeSha256(addresses.receiptSha256)
    : null;
  const resultSha256 = addresses.resultSha256
    ? normalizeSha256(addresses.resultSha256)
    : null;
  if (receiptSha256 && !sha256Pattern.test(receiptSha256)) {
    throw new TypeError("The local-engine receipt address is not a SHA-256 digest.");
  }
  if (resultSha256 && !sha256Pattern.test(resultSha256)) {
    throw new TypeError("The local-engine result address is not a SHA-256 digest.");
  }
  return Object.freeze({
    keySha256,
    pointerPath: path.join(
      root,
      "v1",
      "keys",
      keySha256.slice(0, 2),
      `${keySha256}.json`,
    ),
    receiptPath: receiptSha256
      ? path.join(
          root,
          "v1",
          "receipts",
          receiptSha256.slice(0, 2),
          `${receiptSha256}.json`,
        )
      : null,
    resultPath: resultSha256
      ? path.join(
          root,
          "v1",
          "results",
          resultSha256.slice(0, 2),
          `${resultSha256}.json`,
        )
      : null,
    lockPath: path.join(
      root,
      "v1",
      "locks",
      keySha256.slice(0, 2),
      `${keySha256}.lock`,
    ),
  });
}

type FileRead =
  | { ok: true; bytes: Buffer }
  | {
      ok: false;
      reason: "missing" | "not-regular-file" | "too-large";
    };

async function safeDirectoryState(
  directory: string,
): Promise<"safe" | "missing" | "unsafe"> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    return nodeErrorCode(error) === "ENOENT" ? "missing" : "unsafe";
  }
  return metadata.isDirectory() && !metadata.isSymbolicLink()
    ? "safe"
    : "unsafe";
}

async function readRegularCacheFile(
  filename: string,
  boundaryDirectories: readonly string[],
  maximumBytes: number,
): Promise<FileRead> {
  for (const directory of boundaryDirectories) {
    const state = await safeDirectoryState(directory);
    if (state === "missing") return { ok: false, reason: "missing" };
    if (state === "unsafe") {
      return { ok: false, reason: "not-regular-file" };
    }
  }
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    return nodeErrorCode(error) === "ENOENT"
      ? { ok: false, reason: "missing" }
      : { ok: false, reason: "not-regular-file" };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return { ok: false, reason: "not-regular-file" };
  }
  if (metadata.size > maximumBytes) {
    return { ok: false, reason: "too-large" };
  }
  try {
    const bytes = await readFile(filename);
    return bytes.length > maximumBytes
      ? { ok: false, reason: "too-large" }
      : { ok: true, bytes };
  } catch {
    return { ok: false, reason: "not-regular-file" };
  }
}

function boundaryDirectories(
  cacheDirectory: string,
  collection: "keys" | "receipts" | "results",
  address: string,
): string[] {
  const root = path.resolve(cacheDirectory);
  return [
    root,
    path.join(root, "v1"),
    path.join(root, "v1", collection),
    path.join(root, "v1", collection, address.slice(0, 2)),
  ];
}

function readFailureReason(
  kind: "pointer" | "receipt" | "result",
  reason: Exclude<FileRead, { ok: true }>["reason"],
): LocalEngineResultCacheInvalidReason {
  if (reason === "missing") return `${kind}-missing`;
  if (reason === "too-large") return `${kind}-too-large`;
  return `${kind}-not-regular-file`;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function invalid(
  reason: LocalEngineResultCacheInvalidReason,
  keySha256: string,
): LocalEngineResultCacheMiss {
  return Object.freeze({ status: "invalid", reason, keySha256 });
}

export async function loadLocalEngineResult<TResult = unknown>(
  cacheDirectory: string,
  key: LocalEngineResultCacheKey,
): Promise<LocalEngineResultCacheLoad<TResult>> {
  const parsedKey = cacheKeySchema.parse(key);
  const paths = localEngineResultCachePaths(cacheDirectory, parsedKey);
  const pointerFile = await readRegularCacheFile(
    paths.pointerPath,
    boundaryDirectories(cacheDirectory, "keys", paths.keySha256),
    maximumPointerBytes,
  );
  if (!pointerFile.ok) {
    const reason = readFailureReason("pointer", pointerFile.reason);
    return Object.freeze({
      status: reason === "pointer-missing" ? "miss" : "invalid",
      reason,
      keySha256: paths.keySha256,
    });
  }
  let pointerCandidate: unknown;
  try {
    pointerCandidate = JSON.parse(pointerFile.bytes.toString("utf8"));
  } catch {
    return invalid("pointer-malformed", paths.keySha256);
  }
  const parsedPointer = pointerSchema.safeParse(pointerCandidate);
  if (!parsedPointer.success) {
    return invalid("pointer-malformed", paths.keySha256);
  }
  const pointer = parsedPointer.data;
  if (pointerFile.bytes.toString("utf8") !== canonicalJson(pointer)) {
    return invalid("pointer-noncanonical", paths.keySha256);
  }
  const pointerPayload = pointerPayloadSchema.parse({
    schemaVersion: pointer.schemaVersion,
    kind: pointer.kind,
    keySha256: pointer.keySha256,
    receiptSha256: pointer.receiptSha256,
  });
  if (sha256(canonicalJson(pointerPayload)) !== pointer.integritySha256) {
    return invalid("pointer-integrity-mismatch", paths.keySha256);
  }
  if (pointer.keySha256 !== paths.keySha256) {
    return invalid("pointer-key-mismatch", paths.keySha256);
  }

  const addressed = localEngineResultCachePaths(cacheDirectory, parsedKey, {
    receiptSha256: pointer.receiptSha256,
  });
  if (!addressed.receiptPath) {
    return invalid("receipt-missing", paths.keySha256);
  }
  const receiptFile = await readRegularCacheFile(
    addressed.receiptPath,
    boundaryDirectories(
      cacheDirectory,
      "receipts",
      pointer.receiptSha256,
    ),
    maximumReceiptBytes,
  );
  if (!receiptFile.ok) {
    return invalid(
      readFailureReason("receipt", receiptFile.reason),
      paths.keySha256,
    );
  }
  let receiptCandidate: unknown;
  try {
    receiptCandidate = JSON.parse(receiptFile.bytes.toString("utf8"));
  } catch {
    return invalid("receipt-malformed", paths.keySha256);
  }
  const parsedReceipt = receiptSchema.safeParse(receiptCandidate);
  if (!parsedReceipt.success) {
    return invalid("receipt-malformed", paths.keySha256);
  }
  const receipt = parsedReceipt.data;
  if (receiptFile.bytes.toString("utf8") !== canonicalJson(receipt)) {
    return invalid("receipt-noncanonical", paths.keySha256);
  }
  const receiptPayload = receiptPayloadSchema.parse({
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    key: receipt.key,
    keySha256: receipt.keySha256,
    resultSha256: receipt.resultSha256,
    resultByteLength: receipt.resultByteLength,
  });
  const observedReceiptSha256 = sha256(canonicalJson(receiptPayload));
  if (observedReceiptSha256 !== receipt.integritySha256) {
    return invalid("receipt-integrity-mismatch", paths.keySha256);
  }
  if (
    receipt.integritySha256 !== pointer.receiptSha256 ||
    observedReceiptSha256 !== pointer.receiptSha256
  ) {
    return invalid("receipt-address-mismatch", paths.keySha256);
  }
  if (
    receipt.keySha256 !== paths.keySha256 ||
    !sameCanonicalValue(receipt.key, parsedKey)
  ) {
    return invalid("receipt-key-mismatch", paths.keySha256);
  }

  const resultAddressed = localEngineResultCachePaths(
    cacheDirectory,
    parsedKey,
    { resultSha256: receipt.resultSha256 },
  );
  if (!resultAddressed.resultPath) {
    return invalid("result-missing", paths.keySha256);
  }
  const resultFile = await readRegularCacheFile(
    resultAddressed.resultPath,
    boundaryDirectories(
      cacheDirectory,
      "results",
      receipt.resultSha256,
    ),
    LOCAL_ENGINE_RESULT_CACHE_MAX_BYTES,
  );
  if (!resultFile.ok) {
    return invalid(
      readFailureReason("result", resultFile.reason),
      paths.keySha256,
    );
  }
  if (resultFile.bytes.length !== receipt.resultByteLength) {
    return invalid("result-byte-length-mismatch", paths.keySha256);
  }
  if (sha256(resultFile.bytes) !== receipt.resultSha256) {
    return invalid("result-integrity-mismatch", paths.keySha256);
  }
  let result: unknown;
  try {
    result = JSON.parse(resultFile.bytes.toString("utf8"));
  } catch {
    return invalid("result-malformed", paths.keySha256);
  }
  try {
    if (resultFile.bytes.toString("utf8") !== canonicalJson(result)) {
      return invalid("result-noncanonical", paths.keySha256);
    }
  } catch {
    return invalid("result-malformed", paths.keySha256);
  }
  return Object.freeze({
    status: "hit",
    keySha256: paths.keySha256,
    receiptSha256: pointer.receiptSha256,
    resultSha256: receipt.resultSha256,
    result: deepFreeze(result) as TResult,
  });
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state = await safeDirectoryState(directory);
  if (state !== "safe") {
    throw new LocalEngineResultCacheError(
      "LOCAL_ENGINE_RESULT_CACHE_UNSAFE_BOUNDARY",
      "The local-engine result cache contains an unsafe directory boundary.",
    );
  }
  await chmod(directory, 0o700);
}

async function ensureCacheLayout(cacheDirectory: string): Promise<void> {
  const root = path.resolve(cacheDirectory);
  for (const directory of [
    root,
    path.join(root, "v1"),
    path.join(root, "v1", "keys"),
    path.join(root, "v1", "receipts"),
    path.join(root, "v1", "results"),
    path.join(root, "v1", "locks"),
  ]) {
    await ensurePrivateDirectory(directory);
  }
}

async function publishImmutable(
  filename: string,
  content: string,
  keySha256: string,
): Promise<void> {
  const directory = path.dirname(filename);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, filename);
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") {
      throw new LocalEngineResultCacheError(
        "LOCAL_ENGINE_RESULT_CACHE_WRITE_FAILED",
        `Could not publish an immutable local-engine cache object: ${error instanceof Error ? error.message : "unknown filesystem failure"}`,
        keySha256,
      );
    }
    let metadata;
    try {
      metadata = await lstat(filename);
      const existing = await readFile(filename, "utf8");
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        existing !== content
      ) {
        throw new Error("existing immutable object differs");
      }
    } catch {
      throw new LocalEngineResultCacheError(
        "LOCAL_ENGINE_RESULT_CACHE_INVALID_EXISTING",
        "An existing local-engine cache object does not match its content address.",
        keySha256,
      );
    }
  } finally {
    await rm(temporary, { force: true });
  }
  try {
    await chmod(filename, 0o400);
    const metadata = await lstat(filename);
    if ((metadata.mode & 0o222) !== 0) {
      throw new Error("published cache object remains writable");
    }
  } catch (error) {
    throw new LocalEngineResultCacheError(
      "LOCAL_ENGINE_RESULT_CACHE_WRITE_FAILED",
      `Could not seal an immutable local-engine cache object: ${error instanceof Error ? error.message : "unknown filesystem failure"}`,
      keySha256,
    );
  }
}

function lockTimeout(value: number | undefined): number {
  if (value === undefined) return 10_000;
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError(
      "The local-engine result-cache lock timeout must be an integer from 1 through 60000 milliseconds.",
    );
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireKeyLock(
  lockPath: string,
  keySha256: string,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(path.dirname(lockPath));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => {
        await rmdir(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") {
        throw new LocalEngineResultCacheError(
          "LOCAL_ENGINE_RESULT_CACHE_WRITE_FAILED",
          `Could not acquire the local-engine cache lock: ${error instanceof Error ? error.message : "unknown filesystem failure"}`,
          keySha256,
        );
      }
      if ((await safeDirectoryState(lockPath)) !== "safe") {
        throw new LocalEngineResultCacheError(
          "LOCAL_ENGINE_RESULT_CACHE_UNSAFE_BOUNDARY",
          "The local-engine result-cache lock boundary is unsafe.",
          keySha256,
        );
      }
      if (Date.now() >= deadline) {
        throw new LocalEngineResultCacheError(
          "LOCAL_ENGINE_RESULT_CACHE_BUSY",
          "Another coordinator is still publishing this local-engine result.",
          keySha256,
        );
      }
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
}

export async function storeLocalEngineResult(
  cacheDirectory: string,
  key: LocalEngineResultCacheKey,
  result: unknown,
  options: LocalEngineResultCacheStoreOptions = {},
): Promise<LocalEngineResultCacheStore> {
  const parsedKey = cacheKeySchema.parse(key);
  const paths = localEngineResultCachePaths(cacheDirectory, parsedKey);
  const resultContent = canonicalJson(result);
  const resultByteLength = Buffer.byteLength(resultContent);
  if (resultByteLength > LOCAL_ENGINE_RESULT_CACHE_MAX_BYTES) {
    throw new LocalEngineResultCacheError(
      "LOCAL_ENGINE_RESULT_CACHE_RESULT_TOO_LARGE",
      `The local-engine result exceeds the ${LOCAL_ENGINE_RESULT_CACHE_MAX_BYTES}-byte cache limit.`,
      paths.keySha256,
    );
  }
  const resultSha256 = sha256(resultContent);
  const receiptPayload = receiptPayloadSchema.parse({
    schemaVersion: 1,
    kind: "tessera-local-engine-result-receipt",
    key: parsedKey,
    keySha256: paths.keySha256,
    resultSha256,
    resultByteLength,
  });
  const receiptSha256 = sha256(canonicalJson(receiptPayload));
  const receipt = receiptSchema.parse({
    ...receiptPayload,
    integritySha256: receiptSha256,
  });
  const pointerPayload = pointerPayloadSchema.parse({
    schemaVersion: 1,
    kind: "tessera-local-engine-result-pointer",
    keySha256: paths.keySha256,
    receiptSha256,
  });
  const pointer = pointerSchema.parse({
    ...pointerPayload,
    integritySha256: sha256(canonicalJson(pointerPayload)),
  });
  const addressed = localEngineResultCachePaths(cacheDirectory, parsedKey, {
    receiptSha256,
    resultSha256,
  });
  if (!addressed.receiptPath || !addressed.resultPath) {
    throw new LocalEngineResultCacheError(
      "LOCAL_ENGINE_RESULT_CACHE_WRITE_FAILED",
      "The local-engine result cache could not derive immutable object paths.",
      paths.keySha256,
    );
  }

  await ensureCacheLayout(cacheDirectory);
  const release = await acquireKeyLock(
    paths.lockPath,
    paths.keySha256,
    lockTimeout(options.lockTimeoutMs),
  );
  try {
    const existing = await loadLocalEngineResult(
      cacheDirectory,
      parsedKey,
    );
    if (existing.status === "hit") {
      if (existing.resultSha256 !== resultSha256) {
        throw new LocalEngineResultCacheError(
          "LOCAL_ENGINE_RESULT_CACHE_CONFLICT",
          "The same deterministic local-engine cache key produced a different result.",
          paths.keySha256,
        );
      }
      return Object.freeze({
        status: "reused",
        keySha256: paths.keySha256,
        receiptSha256: existing.receiptSha256,
        resultSha256,
      });
    }
    if (existing.status === "invalid") {
      throw new LocalEngineResultCacheError(
        "LOCAL_ENGINE_RESULT_CACHE_INVALID_EXISTING",
        `The existing local-engine result cache entry failed verification (${existing.reason}).`,
        paths.keySha256,
      );
    }

    await publishImmutable(
      addressed.resultPath,
      resultContent,
      paths.keySha256,
    );
    await publishImmutable(
      addressed.receiptPath,
      canonicalJson(receipt),
      paths.keySha256,
    );
    await publishImmutable(
      paths.pointerPath,
      canonicalJson(pointer),
      paths.keySha256,
    );

    const verified = await loadLocalEngineResult(
      cacheDirectory,
      parsedKey,
    );
    if (
      verified.status !== "hit" ||
      verified.receiptSha256 !== receiptSha256 ||
      verified.resultSha256 !== resultSha256
    ) {
      throw new LocalEngineResultCacheError(
        "LOCAL_ENGINE_RESULT_CACHE_WRITE_FAILED",
        `The newly published local-engine cache entry failed verification${verified.status === "invalid" ? ` (${verified.reason})` : ""}.`,
        paths.keySha256,
      );
    }
    return Object.freeze({
      status: "installed",
      keySha256: paths.keySha256,
      receiptSha256,
      resultSha256,
    });
  } finally {
    await release();
  }
}
