import crypto from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  createDataBundleSnapshot,
  DataBundleChannelCursorV1Schema,
  verifyDataBundleChannelPointer,
  verifyDataBundleManifest,
  verifyDataBundleShard,
  type DataBundleShardDescriptorV1,
  type DataBundleChannelCursorV1,
  type DataBundleSnapshot,
  type DataBundleSnapshotLease,
  type Ed25519KeyRegistry,
  type VerifiedDataBundleManifestV1,
  type VerifiedDataBundleShardV1,
} from "../../lib/rosterpilot/data-bundle";
import {
  canonicalJson,
  sha256Hex,
  type DataBundleDeltaClassification,
} from "../../lib/rosterpilot/semantic-hash";
import {
  createLocalDataBundleIntegrityReceipt,
  verifyLocalDataBundleIntegrityReceipt,
  type LocalDataBundleIntegrityReceiptV1,
  type LocalDataBundleReceiptShardV1,
} from "./receipt";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STORE_VERSION_DIRECTORY = "v1";
const ACTIVE_STATE_FILENAME = "active.json";
const CHANNEL_CURSOR_FILENAME = "channel-cursor.json";
const MANIFEST_FILENAME = "manifest.json";
const RECEIPT_FILENAME = "receipt.json";
const UPDATE_LEASE_DIRECTORY = "update.lock";
const PREVIOUS_BUNDLE_RETENTION = 3;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_SNAPSHOT_REFERENCE_TTL_MS = 24 * 60 * 60 * 1_000;
// Entity-level hashes for all supported factions currently place the signed
// manifest above 2 MiB. Keep the same bounded ceiling as the network reader.
const DEFAULT_MANIFEST_BYTE_LIMIT = 8 * 1_024 * 1_024;
const DEFAULT_SHARD_BYTE_LIMIT = 64 * 1_024 * 1_024;
const DEFAULT_BUNDLE_BYTE_LIMIT = 512 * 1_024 * 1_024;
const DEFAULT_RECEIPT_BYTE_LIMIT = 4 * 1_024 * 1_024;

const sha256Schema = z
  .string()
  .regex(SHA256_PATTERN, "Expected a lowercase SHA-256 digest.");

const LocalDataBundleQuarantineV1Schema = z
  .object({
    bundleId: sha256Schema,
    quarantinedAt: z.string().datetime(),
    reason: z.string().min(1).max(4_000),
    scopes: z.array(z.string().min(1).max(160)),
    evidenceSha256: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((quarantine, context) => {
    if (new Set(quarantine.scopes).size !== quarantine.scopes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopes"],
        message: "Quarantine scopes must be unique.",
      });
    }
  });

export const LocalDataBundleRollbackHoldV1Schema = z
  .object({
    bundleId: sha256Schema,
    engagedAt: z.string().datetime(),
    release: z.literal("force-refresh"),
  })
  .strict();

const localDataBundleChannelCursorDraftV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    stateKind: z.literal(
      "rosterpilot-local-data-bundle-channel-cursor",
    ),
    cursor: DataBundleChannelCursorV1Schema,
    updatedAt: z.string().datetime(),
  })
  .strict();

const LocalDataBundleChannelCursorRecordV1Schema =
  localDataBundleChannelCursorDraftV1Schema.extend({
    integritySha256: sha256Schema,
  });

const localDataBundleStoreStateDraftV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    stateKind: z.literal("rosterpilot-local-data-bundle-store"),
    revision: z.number().int().nonnegative(),
    activeBundleId: sha256Schema.nullable(),
    previousBundleIds: z.array(sha256Schema).max(
      PREVIOUS_BUNDLE_RETENTION,
    ),
    quarantines: z.array(LocalDataBundleQuarantineV1Schema),
    rollbackHold: LocalDataBundleRollbackHoldV1Schema.nullable()
      .optional(),
    updatedAt: z.string().datetime(),
    lastOperation: z.enum([
      "initialize",
      "install",
      "activate",
      "rollback",
      "quarantine",
      "clear-quarantine",
      "rollback-hold",
      "clear-rollback-hold",
      "retention",
    ]),
  })
  .strict();

export const LocalDataBundleStoreStateV1Schema =
  localDataBundleStoreStateDraftV1Schema
    .extend({
      integritySha256: sha256Schema,
    })
    .superRefine((state, context) => {
      if (
        new Set(state.previousBundleIds).size !==
        state.previousBundleIds.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["previousBundleIds"],
          message: "Rollback history cannot repeat a bundle id.",
        });
      }
      if (
        state.activeBundleId &&
        state.previousBundleIds.includes(state.activeBundleId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeBundleId"],
          message:
            "The active bundle cannot also be rollback history.",
        });
      }
      const quarantinedIds = state.quarantines.map(
        (quarantine) => quarantine.bundleId,
      );
      if (new Set(quarantinedIds).size !== quarantinedIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["quarantines"],
          message: "A bundle can have only one active quarantine.",
        });
      }
      if (
        state.activeBundleId &&
        quarantinedIds.includes(state.activeBundleId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeBundleId"],
          message: "A quarantined bundle cannot remain active.",
        });
      }
    });

const localDataBundleReferenceDraftV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    referenceKind: z.literal("rosterpilot-data-bundle-reference"),
    referenceId: z.string().min(1).max(512),
    bundleId: sha256Schema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    retentionClass: z
      .enum(["durable", "transient-snapshot"])
      .optional(),
    owner: z
      .object({
        pid: z.number().int().positive(),
        instanceId: z.string().uuid(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const LocalDataBundleReferenceV1Schema =
  localDataBundleReferenceDraftV1Schema.extend({
    integritySha256: sha256Schema,
  });

export type LocalDataBundleStoreStateV1 = z.infer<
  typeof LocalDataBundleStoreStateV1Schema
>;

type LocalDataBundleStoreStateDraftV1 = z.infer<
  typeof localDataBundleStoreStateDraftV1Schema
>;

export type LocalDataBundleQuarantineV1 = z.infer<
  typeof LocalDataBundleQuarantineV1Schema
>;

export type LocalDataBundleRollbackHoldV1 = z.infer<
  typeof LocalDataBundleRollbackHoldV1Schema
>;

export type LocalDataBundleReferenceV1 = z.infer<
  typeof LocalDataBundleReferenceV1Schema
>;

export type LocalDataBundleStoreErrorCode =
  | "DATA_BUNDLE_STORE_LOCKED"
  | "DATA_BUNDLE_STORE_LEASE_INVALID"
  | "DATA_BUNDLE_STORE_STATE_INVALID"
  | "DATA_BUNDLE_INSTALL_INVALID"
  | "DATA_BUNDLE_NOT_INSTALLED"
  | "DATA_BUNDLE_ACTIVE_REQUIRED"
  | "DATA_BUNDLE_QUARANTINED"
  | "DATA_BUNDLE_ROLLBACK_HELD"
  | "DATA_BUNDLE_INTEGRITY_FAILED"
  | "DATA_BUNDLE_REFERENCE_INVALID"
  | "DATA_BUNDLE_RETENTION_BLOCKED";

export class LocalDataBundleStoreError extends Error {
  readonly code: LocalDataBundleStoreErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    code: LocalDataBundleStoreErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "LocalDataBundleStoreError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

export type LocalDataBundleStoreFaultPoint =
  | "after-staging-written"
  | "after-bundle-installed"
  | "before-active-switch";

export type LocalDataBundleStoreLimits = {
  manifestBytes: number;
  shardBytes: number;
  bundleBytes: number;
  receiptBytes: number;
};

export type CreateLocalDataBundleStoreOptions = {
  rootDirectory: string;
  trustedKeys: Ed25519KeyRegistry;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  retentionDays?: number;
  snapshotReferenceTtlMs?: number;
  limits?: Partial<LocalDataBundleStoreLimits>;
  validateShardData?: (
    data: unknown,
    descriptor: DataBundleShardDescriptorV1,
  ) => void | Promise<void>;
  faultInjector?: (
    point: LocalDataBundleStoreFaultPoint,
  ) => void | Promise<void>;
};

export type LocalDataBundleAcceptanceMetadata = {
  classification?: DataBundleDeltaClassification | null;
  certificationStatus?:
    | "not-required"
    | "pending"
    | "passed"
    | "failed"
    | "quarantined";
  certificationEvidenceSha256?: string | null;
};

export type LocalDataBundleInstallInput = {
  manifest: unknown;
  shards:
    | ReadonlyMap<string, unknown>
    | Readonly<Record<string, unknown>>;
  channelPointer?: unknown;
  acceptance?: LocalDataBundleAcceptanceMetadata;
};

export type LocalDataBundleMutationOptions = {
  lease?: LocalDataBundleUpdateLease;
};

export type LocalDataBundleInstallOptions =
  LocalDataBundleMutationOptions & {
    activate?: boolean;
  };

export type LocalDataBundleInstallResult = {
  bundleId: string;
  installed: boolean;
  activated: boolean;
  previousBundleId: string | null;
  receipt: LocalDataBundleIntegrityReceiptV1;
};

export type LocalDataBundleActivationResult = {
  bundleId: string;
  previousBundleId: string | null;
  changed: boolean;
  state: LocalDataBundleStoreStateV1;
};

export type LocalDataBundleVerifiedInstall = {
  bundleId: string;
  manifest: VerifiedDataBundleManifestV1;
  shards: ReadonlyMap<
    string,
    VerifiedDataBundleShardV1<unknown>
  >;
  snapshot: DataBundleSnapshot<unknown>;
  receipt: LocalDataBundleIntegrityReceiptV1;
};

export type LocalDataBundleStatusEntry = {
  bundleId: string;
  role: "active" | "previous" | "installed" | "quarantined";
  integrity: "verified" | "invalid";
  installedAt: string | null;
  referencedBy: number;
  quarantine: LocalDataBundleQuarantineV1 | null;
  issue: string | null;
};

export type LocalDataBundleStoreStatus = {
  schemaVersion: 1;
  state: "ready" | "degraded" | "empty";
  activeBundleId: string | null;
  previousBundleIds: string[];
  stateRevision: number | null;
  updatedAt: string | null;
  bundles: LocalDataBundleStatusEntry[];
  quarantines: LocalDataBundleQuarantineV1[];
  rollbackHold: LocalDataBundleRollbackHoldV1 | null;
  references: Array<{
    referenceId: string;
    bundleId: string;
    expiresAt: string | null;
    retentionClass: "durable" | "transient-snapshot";
    owner: {
      pid: number;
      instanceId: string;
    } | null;
  }>;
  updateLease: {
    held: boolean;
    pid: number | null;
    acquiredAt: string | null;
  };
  issues: string[];
};

export type LocalDataBundleChannelCursorCompareAndSetResult = {
  committed: boolean;
  cursor: DataBundleChannelCursorV1;
};

export type LocalDataBundleQuarantineInput = {
  reason: string;
  scopes?: readonly string[];
  evidenceSha256?: string | null;
};

export type LocalDataBundleReferenceOptions =
  LocalDataBundleMutationOptions & {
    expiresAt?: string | null;
  };

export type LocalDataBundleRetentionResult = {
  prunedBundleIds: string[];
  retainedBundleIds: string[];
  protectedBundleIds: string[];
  expiredReferenceIds: string[];
  issues: string[];
};

export type AcquireLocalDataBundleUpdateLeaseOptions = {
  timeoutMs?: number;
  staleOwnerGraceMs?: number;
};

export interface LocalDataBundleUpdateLease {
  readonly leaseId: string;
  readonly acquiredAt: string;
  readonly released: boolean;
  release(): Promise<void>;
}

type LeaseOwner = {
  schemaVersion: 1;
  leaseKind: "rosterpilot-data-bundle-update";
  pid: number;
  token: string;
  acquiredAt: string;
};

function filesystemCode(error: unknown): string | null {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function assertBundleId(bundleId: string): void {
  if (!SHA256_PATTERN.test(bundleId)) {
    throw new LocalDataBundleStoreError(
      "DATA_BUNDLE_INSTALL_INVALID",
      `Invalid data-bundle id "${bundleId}".`,
    );
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

async function syncFile(filename: string): Promise<void> {
  const handle = await open(filename, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(filename), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(filename, bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await syncFile(filename);
}

async function atomicWriteJson(
  filename: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeDurableFile(temporary, encodeJson(value));
    await rename(temporary, filename);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function syncDirectoryTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await syncDirectoryTree(path.join(directory, entry.name));
    }
  }
  await syncDirectory(directory);
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readBoundedJson(
  filename: string,
  byteLimit: number,
): Promise<unknown> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new LocalDataBundleStoreError(
      "DATA_BUNDLE_INTEGRITY_FAILED",
      `Expected a regular data-bundle file at "${filename}".`,
    );
  }
  if (metadata.size > byteLimit) {
    throw new LocalDataBundleStoreError(
      "DATA_BUNDLE_INTEGRITY_FAILED",
      `Data-bundle file "${filename}" exceeds its ${byteLimit}-byte limit.`,
    );
  }
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new LocalDataBundleStoreError(
      "DATA_BUNDLE_INTEGRITY_FAILED",
      `Data-bundle file "${filename}" is not valid JSON.`,
      { cause: error },
    );
  }
}

async function listRegularFiles(
  directory: string,
  relativeDirectory = "",
): Promise<string[]> {
  const entries = await readdir(
    path.join(directory, relativeDirectory),
    { withFileTypes: true },
  );
  const files: string[] = [];
  for (const entry of entries) {
    const relative = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isSymbolicLink()) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INTEGRITY_FAILED",
        `Installed data bundle contains a symbolic link at "${relative}".`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(directory, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INTEGRITY_FAILED",
        `Installed data bundle contains a non-regular entry at "${relative}".`,
      );
    }
  }
  return files.sort();
}

function resolveBundlePath(
  bundleDirectory: string,
  relativePath: string,
): string {
  const resolved = path.resolve(
    bundleDirectory,
    ...relativePath.split("/"),
  );
  if (
    resolved === bundleDirectory ||
    !resolved.startsWith(`${bundleDirectory}${path.sep}`)
  ) {
    throw new LocalDataBundleStoreError(
      "DATA_BUNDLE_INSTALL_INVALID",
      `Unsafe data-bundle path "${relativePath}".`,
    );
  }
  return resolved;
}

function localShardPathsAreSafe(paths: readonly string[]): boolean {
  const allPaths = [
    MANIFEST_FILENAME,
    RECEIPT_FILENAME,
    ...paths,
  ];
  if (new Set(allPaths).size !== allPaths.length) return false;
  return !allPaths.some((candidate, index) =>
    allPaths.some(
      (other, otherIndex) =>
        index !== otherIndex &&
        other.startsWith(`${candidate}/`),
    ),
  );
}

function shardInputEntries(
  shards: LocalDataBundleInstallInput["shards"],
): Array<[string, unknown]> {
  const possibleMap = shards as ReadonlyMap<string, unknown>;
  if (
    typeof possibleMap.entries === "function" &&
    typeof possibleMap.size === "number"
  ) {
    return [...possibleMap.entries()];
  }
  return Object.entries(shards);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return filesystemCode(error) === "EPERM";
  }
}

async function recoverAbandonedLease(
  directory: string,
  staleOwnerGraceMs: number,
): Promise<boolean> {
  let owner: Partial<LeaseOwner> | null = null;
  try {
    owner = JSON.parse(
      await readFile(path.join(directory, "owner.json"), "utf8"),
    ) as Partial<LeaseOwner>;
  } catch {
    // The creator may be between mkdir and its owner record.
  }
  const ageMs = await stat(directory)
    .then((value) => Date.now() - value.mtimeMs)
    .catch(() => 0);
  const validOwner =
    owner?.schemaVersion === 1 &&
    owner.leaseKind === "rosterpilot-data-bundle-update" &&
    typeof owner.token === "string" &&
    owner.token.length > 0 &&
    typeof owner.pid === "number";
  const ownerPid = owner?.pid;
  if (
    (validOwner &&
      typeof ownerPid === "number" &&
      processIsAlive(ownerPid)) ||
    (!validOwner && ageMs < staleOwnerGraceMs)
  ) {
    return false;
  }
  const abandoned = `${directory}.abandoned-${crypto.randomUUID()}`;
  try {
    await rename(directory, abandoned);
  } catch {
    return false;
  }
  await rm(abandoned, { recursive: true, force: true });
  return true;
}

class OwnedLocalDataBundleUpdateLease
  implements LocalDataBundleUpdateLease
{
  readonly leaseId: string;
  readonly acquiredAt: string;
  readonly storageDirectory: string;
  #released = false;
  #releasePromise: Promise<void> | null = null;

  constructor(input: {
    leaseId: string;
    acquiredAt: string;
    storageDirectory: string;
  }) {
    this.leaseId = input.leaseId;
    this.acquiredAt = input.acquiredAt;
    this.storageDirectory = input.storageDirectory;
  }

  get released(): boolean {
    return this.#released;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    if (this.#releasePromise) return this.#releasePromise;
    this.#releasePromise = (async () => {
      const leaseDirectory = path.join(
        this.storageDirectory,
        "locks",
        UPDATE_LEASE_DIRECTORY,
      );
      try {
        const parsed = JSON.parse(
          await readFile(
            path.join(leaseDirectory, "owner.json"),
            "utf8",
          ),
        ) as Partial<LeaseOwner>;
        if (parsed.token !== this.leaseId) {
          this.#released = true;
          return;
        }
        const releasedDirectory =
          `${leaseDirectory}.released-${crypto.randomUUID()}`;
        await rename(leaseDirectory, releasedDirectory);
        await rm(releasedDirectory, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        if (filesystemCode(error) !== "ENOENT") throw error;
      }
      this.#released = true;
    })();
    try {
      await this.#releasePromise;
    } finally {
      this.#releasePromise = null;
    }
  }
}

type PreparedInstall = {
  manifest: VerifiedDataBundleManifestV1;
  shards: Map<string, VerifiedDataBundleShardV1<unknown>>;
  serializedManifest: Uint8Array;
  serializedShards: Map<string, Uint8Array>;
  receipt: LocalDataBundleIntegrityReceiptV1;
};

type ReadReferencesResult = {
  references: LocalDataBundleReferenceV1[];
  issues: string[];
  retentionBlocked: boolean;
};

export class LocalDataBundleStore {
  readonly storageDirectory: string;
  readonly #trustedKeys: Ed25519KeyRegistry;
  readonly #now: () => Date;
  readonly #retentionDays: number;
  readonly #snapshotReferenceTtlMs: number;
  readonly #instanceId = crypto.randomUUID();
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #limits: LocalDataBundleStoreLimits;
  readonly #validateShardData:
    | CreateLocalDataBundleStoreOptions["validateShardData"]
    | undefined;
  readonly #faultInjector:
    | CreateLocalDataBundleStoreOptions["faultInjector"]
    | undefined;

  constructor(options: CreateLocalDataBundleStoreOptions) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INSTALL_INVALID",
        "The local data-bundle root must be an absolute path.",
      );
    }
    const retentionDays =
      options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INSTALL_INVALID",
        "Data-bundle retention days must be a non-negative number.",
      );
    }
    const snapshotReferenceTtlMs =
      options.snapshotReferenceTtlMs ??
      DEFAULT_SNAPSHOT_REFERENCE_TTL_MS;
    if (
      !Number.isFinite(snapshotReferenceTtlMs) ||
      snapshotReferenceTtlMs <= 0
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INSTALL_INVALID",
        "The transient snapshot-reference lifetime must be positive.",
      );
    }
    this.storageDirectory = path.resolve(
      options.rootDirectory,
      STORE_VERSION_DIRECTORY,
    );
    this.#trustedKeys = options.trustedKeys;
    this.#now = options.now ?? (() => new Date());
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.#retentionDays = retentionDays;
    this.#snapshotReferenceTtlMs = snapshotReferenceTtlMs;
    this.#limits = {
      manifestBytes:
        options.limits?.manifestBytes ??
        DEFAULT_MANIFEST_BYTE_LIMIT,
      shardBytes:
        options.limits?.shardBytes ?? DEFAULT_SHARD_BYTE_LIMIT,
      bundleBytes:
        options.limits?.bundleBytes ?? DEFAULT_BUNDLE_BYTE_LIMIT,
      receiptBytes:
        options.limits?.receiptBytes ??
        DEFAULT_RECEIPT_BYTE_LIMIT,
    };
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INSTALL_INVALID",
          `Data-bundle ${name} limit must be a positive integer.`,
        );
      }
    }
    this.#validateShardData = options.validateShardData;
    this.#faultInjector = options.faultInjector;
  }

  async acquireUpdateLease(
    options: AcquireLocalDataBundleUpdateLeaseOptions = {},
  ): Promise<LocalDataBundleUpdateLease> {
    await this.#ensureDirectories();
    const leaseDirectory = path.join(
      this.storageDirectory,
      "locks",
      UPDATE_LEASE_DIRECTORY,
    );
    const timeoutMs = options.timeoutMs ?? 30_000;
    const staleOwnerGraceMs = options.staleOwnerGraceMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    const token = crypto.randomUUID();
    while (true) {
      try {
        await mkdir(leaseDirectory, { mode: 0o700 });
        const acquiredAt = this.#timestamp();
        const owner: LeaseOwner = {
          schemaVersion: 1,
          leaseKind: "rosterpilot-data-bundle-update",
          pid: process.pid,
          token,
          acquiredAt,
        };
        try {
          await writeDurableFile(
            path.join(leaseDirectory, "owner.json"),
            encodeJson(owner),
          );
          await syncDirectory(leaseDirectory);
        } catch (error) {
          await rm(leaseDirectory, {
            recursive: true,
            force: true,
          });
          throw error;
        }
        return new OwnedLocalDataBundleUpdateLease({
          leaseId: token,
          acquiredAt,
          storageDirectory: this.storageDirectory,
        });
      } catch (error) {
        if (filesystemCode(error) !== "EEXIST") throw error;
        if (
          await recoverAbandonedLease(
            leaseDirectory,
            staleOwnerGraceMs,
          )
        ) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LocalDataBundleStoreError(
            "DATA_BUNDLE_STORE_LOCKED",
            "Timed out waiting for the exclusive local data-bundle update lease.",
            { retryable: true },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async installBundle(
    input: LocalDataBundleInstallInput,
    options: LocalDataBundleInstallOptions = {},
  ): Promise<LocalDataBundleInstallResult> {
    return this.#withLease(options.lease, async (lease) => {
      const prepared = await this.#prepareInstall(input);
      const bundleId = prepared.manifest.bundleId;
      const bundleDirectory = this.#bundleDirectory(bundleId);
      const state = await this.#readState();
      if (state.quarantines.some((entry) => entry.bundleId === bundleId)) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_QUARANTINED",
          `Data bundle "${bundleId}" is quarantined and cannot be installed or activated until its quarantine is cleared.`,
        );
      }

      let installed = false;
      if (await pathExists(bundleDirectory)) {
        await this.#verifyInstalledBundle(bundleId);
      } else {
        const stagingDirectory = path.join(
          this.storageDirectory,
          "staging",
          `${bundleId}-${lease.leaseId}`,
        );
        await mkdir(stagingDirectory, {
          recursive: false,
          mode: 0o700,
        });
        try {
          await writeDurableFile(
            path.join(stagingDirectory, MANIFEST_FILENAME),
            prepared.serializedManifest,
          );
          for (const descriptor of prepared.manifest.shards) {
            const bytes = prepared.serializedShards.get(
              descriptor.path,
            );
            if (!bytes) {
              throw new LocalDataBundleStoreError(
                "DATA_BUNDLE_INSTALL_INVALID",
                `Prepared shard "${descriptor.path}" is missing.`,
              );
            }
            await writeDurableFile(
              resolveBundlePath(
                stagingDirectory,
                descriptor.path,
              ),
              bytes,
            );
          }
          await writeDurableFile(
            path.join(stagingDirectory, RECEIPT_FILENAME),
            encodeJson(prepared.receipt),
          );
          await syncDirectoryTree(stagingDirectory);
          await this.#injectFault("after-staging-written");
          await rename(stagingDirectory, bundleDirectory);
          await syncDirectory(
            path.join(this.storageDirectory, "bundles"),
          );
          installed = true;
          await this.#injectFault("after-bundle-installed");
        } finally {
          await rm(stagingDirectory, {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
      }

      let activated = false;
      let previousBundleId: string | null = state.activeBundleId;
      if (options.activate) {
        const activation = await this.#activateLocked(
          bundleId,
          "install",
        );
        activated = activation.changed;
        previousBundleId = activation.previousBundleId;
      }
      const verified = await this.#verifyInstalledBundle(bundleId);
      return {
        bundleId,
        installed,
        activated,
        previousBundleId,
        receipt: verified.receipt,
      };
    });
  }

  async activateBundle(
    bundleId: string,
    options: LocalDataBundleMutationOptions = {},
  ): Promise<LocalDataBundleActivationResult> {
    return this.#withLease(options.lease, () =>
      this.#activateLocked(bundleId, "activate"),
    );
  }

  async rollbackBundle(
    bundleId?: string,
    options: LocalDataBundleMutationOptions = {},
  ): Promise<LocalDataBundleActivationResult> {
    return this.#withLease(options.lease, async () => {
      const state = await this.#readState();
      const target = bundleId ?? state.previousBundleIds[0];
      if (!target) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_NOT_INSTALLED",
          "No previous local data bundle is available for rollback.",
        );
      }
      return this.#activateLocked(target, "rollback");
    });
  }

  async setRollbackHold(
    input: LocalDataBundleRollbackHoldV1,
    options: LocalDataBundleMutationOptions = {},
  ): Promise<LocalDataBundleStoreStateV1> {
    const rollbackHold = LocalDataBundleRollbackHoldV1Schema.parse(input);
    return this.#withLease(options.lease, async () => {
      const state = await this.#readState();
      if (
        state.quarantines.some(
          (entry) => entry.bundleId === rollbackHold.bundleId,
        )
      ) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_QUARANTINED",
          `Data bundle "${rollbackHold.bundleId}" is quarantined.`,
        );
      }
      await this.#verifyInstalledBundle(rollbackHold.bundleId);
      return this.#writeNextState(state, {
        activeBundleId: state.activeBundleId,
        previousBundleIds: state.previousBundleIds,
        quarantines: state.quarantines,
        rollbackHold,
        lastOperation: "rollback-hold",
      });
    });
  }

  async clearRollbackHold(
    options: LocalDataBundleMutationOptions = {},
  ): Promise<LocalDataBundleStoreStateV1> {
    return this.#withLease(options.lease, async () => {
      const state = await this.#readState();
      if (!state.rollbackHold) return state;
      return this.#writeNextState(state, {
        activeBundleId: state.activeBundleId,
        previousBundleIds: state.previousBundleIds,
        quarantines: state.quarantines,
        rollbackHold: null,
        lastOperation: "clear-rollback-hold",
      });
    });
  }

  async quarantineBundle(
    bundleId: string,
    input: LocalDataBundleQuarantineInput,
    options: LocalDataBundleMutationOptions = {},
  ): Promise<LocalDataBundleStoreStateV1> {
    assertBundleId(bundleId);
    const parsed = LocalDataBundleQuarantineV1Schema.parse({
      bundleId,
      quarantinedAt: this.#timestamp(),
      reason: input.reason,
      scopes: [...new Set(input.scopes ?? [])].sort(),
      evidenceSha256: input.evidenceSha256 ?? null,
    });
    return this.#withLease(options.lease, async () => {
      const state = await this.#readState();
      const quarantines = [
        ...state.quarantines.filter(
          (entry) => entry.bundleId !== bundleId,
        ),
        parsed,
      ].sort((left, right) =>
        left.bundleId.localeCompare(right.bundleId),
      );
      let activeBundleId = state.activeBundleId;
      let previousBundleIds = state.previousBundleIds.filter(
        (candidate) => candidate !== bundleId,
      );
      if (activeBundleId === bundleId) {
        activeBundleId = null;
        for (const candidate of previousBundleIds) {
          if (
            quarantines.some(
              (entry) => entry.bundleId === candidate,
            )
          ) {
            continue;
          }
          try {
            await this.#verifyInstalledBundle(candidate);
            activeBundleId = candidate;
            break;
          } catch {
            // A rollback target must independently verify before use.
          }
        }
        if (activeBundleId) {
          previousBundleIds = previousBundleIds.filter(
            (candidate) => candidate !== activeBundleId,
          );
        }
      }
      return this.#writeNextState(state, {
        activeBundleId,
        previousBundleIds:
          previousBundleIds.slice(0, PREVIOUS_BUNDLE_RETENTION),
        quarantines,
        rollbackHold:
          state.rollbackHold?.bundleId === bundleId
            ? null
            : state.rollbackHold ?? null,
        lastOperation: "quarantine",
      });
    });
  }

  async clearBundleQuarantine(
    bundleId: string,
    options: LocalDataBundleMutationOptions = {},
  ): Promise<LocalDataBundleStoreStateV1> {
    assertBundleId(bundleId);
    return this.#withLease(options.lease, async () => {
      const state = await this.#readState();
      const quarantines = state.quarantines.filter(
        (entry) => entry.bundleId !== bundleId,
      );
      if (quarantines.length === state.quarantines.length) {
        return state;
      }
      return this.#writeNextState(state, {
        activeBundleId: state.activeBundleId,
        previousBundleIds: state.previousBundleIds,
        quarantines,
        lastOperation: "clear-quarantine",
      });
    });
  }

  async loadBundle(
    bundleId: string,
  ): Promise<LocalDataBundleVerifiedInstall> {
    assertBundleId(bundleId);
    const state = await this.#readState();
    if (state.quarantines.some((entry) => entry.bundleId === bundleId)) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_QUARANTINED",
        `Data bundle "${bundleId}" is quarantined.`,
      );
    }
    return this.#verifyInstalledBundle(bundleId);
  }

  async loadActiveBundle(): Promise<LocalDataBundleVerifiedInstall> {
    const state = await this.#readState();
    if (!state.activeBundleId) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_ACTIVE_REQUIRED",
        "No active local data bundle is configured.",
      );
    }
    return this.loadBundle(state.activeBundleId);
  }

  async acquireSnapshot(
    options: {
      bundleId?: string;
      factionIds?: readonly string[];
      signal?: AbortSignal;
    } = {},
  ): Promise<DataBundleSnapshotLease<unknown>> {
    options.signal?.throwIfAborted();
    const updateLease = await this.acquireUpdateLease();
    let verified: LocalDataBundleVerifiedInstall;
    const referenceId = `snapshot:${crypto.randomUUID()}`;
    try {
      const state = await this.#readState();
      const bundleId = options.bundleId ?? state.activeBundleId;
      if (!bundleId) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_ACTIVE_REQUIRED",
          "No active local data bundle is configured.",
        );
      }
      if (
        state.quarantines.some(
          (entry) => entry.bundleId === bundleId,
        )
      ) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_QUARANTINED",
          `Data bundle "${bundleId}" is quarantined.`,
        );
      }
      verified = await this.#verifyInstalledBundle(bundleId);
      for (const factionId of options.factionIds ?? []) {
        if (!verified.snapshot.getFactionShard(factionId)) {
          throw new LocalDataBundleStoreError(
            "DATA_BUNDLE_INTEGRITY_FAILED",
            `Active data bundle "${bundleId}" does not contain faction "${factionId}".`,
          );
        }
      }
      await this.#setReferenceLocked(
        referenceId,
        bundleId,
        new Date(
          this.#now().getTime() + this.#snapshotReferenceTtlMs,
        ).toISOString(),
        {
          retentionClass: "transient-snapshot",
          owner: {
            pid: process.pid,
            instanceId: this.#instanceId,
          },
        },
      );
    } finally {
      await updateLease.release();
    }

    let released = false;
    let releasePromise: Promise<void> | null = null;
    const removeSnapshotReference = () =>
      this.removeBundleReference(referenceId, {
        bundleId: verified!.bundleId,
      });
    return {
      leaseId: referenceId,
      snapshot: verified!.snapshot,
      get released() {
        return released;
      },
      async release() {
        if (released) return;
        if (releasePromise) return releasePromise;
        releasePromise = (async () => {
          await removeSnapshotReference();
          released = true;
        })();
        try {
          await releasePromise;
        } finally {
          releasePromise = null;
        }
      },
    };
  }

  async setBundleReference(
    referenceId: string,
    bundleId: string,
    options: LocalDataBundleReferenceOptions = {},
  ): Promise<LocalDataBundleReferenceV1> {
    return this.#withLease(options.lease, () =>
      this.#setReferenceLocked(
        referenceId,
        bundleId,
        options.expiresAt ?? null,
        {
          retentionClass: "durable",
          owner: null,
        },
      ),
    );
  }

  async removeBundleReference(
    referenceId: string,
    options: LocalDataBundleMutationOptions & {
      bundleId?: string;
    } = {},
  ): Promise<boolean> {
    return this.#withLease(options.lease, async () => {
      const filename = await this.#referenceFilename(referenceId);
      if (!(await pathExists(filename))) return false;
      const parsed = await this.#readReferenceFile(filename);
      if (
        parsed.referenceId !== referenceId ||
        (options.bundleId &&
          parsed.bundleId !== options.bundleId)
      ) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_REFERENCE_INVALID",
          `Data-bundle reference "${referenceId}" does not match the requested identity.`,
        );
      }
      const released = `${filename}.released-${crypto.randomUUID()}`;
      await rename(filename, released);
      await syncDirectory(path.dirname(filename));
      await rm(released, { force: true });
      return true;
    });
  }

  async enforceRetention(
    options: LocalDataBundleMutationOptions = {},
  ): Promise<LocalDataBundleRetentionResult> {
    return this.#withLease(options.lease, async (lease) => {
      const state = await this.#readState();
      const referenceResult = await this.#readReferences();
      if (referenceResult.retentionBlocked) {
        const installed = await this.#installedBundleIds();
        return {
          prunedBundleIds: [],
          retainedBundleIds: installed,
          protectedBundleIds: installed,
          expiredReferenceIds: [],
          issues: [
            ...referenceResult.issues,
            "Retention was blocked because one or more durable bundle references could not be verified.",
          ],
        };
      }

      const nowMs = this.#now().getTime();
      const liveReferences =
        referenceResult.references.filter(
          (reference) => this.#referenceIsLive(reference, nowMs),
        );
      const expiredReferences =
        referenceResult.references.filter(
          (reference) => !this.#referenceIsLive(reference, nowMs),
        );
      for (const reference of expiredReferences) {
        await this.removeBundleReference(reference.referenceId, {
          bundleId: reference.bundleId,
          lease,
        });
      }

      const protectedIds = new Set<string>([
        ...(state.activeBundleId ? [state.activeBundleId] : []),
        ...(state.rollbackHold ? [state.rollbackHold.bundleId] : []),
        ...state.previousBundleIds.slice(
          0,
          PREVIOUS_BUNDLE_RETENTION,
        ),
        ...liveReferences.map((reference) => reference.bundleId),
      ]);
      const cutoff =
        nowMs -
        this.#retentionDays * 24 * 60 * 60 * 1_000;
      const installed = await this.#installedBundleIds();
      const pruned: string[] = [];
      const retained: string[] = [];
      const issues = [...referenceResult.issues];
      for (const bundleId of installed) {
        if (protectedIds.has(bundleId)) {
          retained.push(bundleId);
          continue;
        }
        let verified: LocalDataBundleVerifiedInstall;
        try {
          verified = await this.#verifyInstalledBundle(bundleId);
        } catch (error) {
          retained.push(bundleId);
          issues.push(
            `Retained unverifiable bundle "${bundleId}": ${String(
              error,
            )}`,
          );
          continue;
        }
        if (Date.parse(verified.receipt.installedAt) >= cutoff) {
          retained.push(bundleId);
          continue;
        }
        const source = this.#bundleDirectory(bundleId);
        const trash = path.join(
          this.storageDirectory,
          "trash",
          `${bundleId}-${crypto.randomUUID()}`,
        );
        await rename(source, trash);
        await syncDirectory(
          path.join(this.storageDirectory, "bundles"),
        );
        await rm(trash, { recursive: true, force: true });
        pruned.push(bundleId);
      }

      const quarantines = state.quarantines.filter(
        (quarantine) => !pruned.includes(quarantine.bundleId),
      );
      if (
        pruned.length > 0 ||
        expiredReferences.length > 0
      ) {
        await this.#writeNextState(state, {
          activeBundleId: state.activeBundleId,
          previousBundleIds: state.previousBundleIds,
          quarantines,
          lastOperation: "retention",
        });
      }
      return {
        prunedBundleIds: pruned.sort(),
        retainedBundleIds: retained.sort(),
        protectedBundleIds: [...protectedIds].sort(),
        expiredReferenceIds: expiredReferences
          .map((reference) => reference.referenceId)
          .sort(),
        issues,
      };
    });
  }

  async getChannelCursor(): Promise<DataBundleChannelCursorV1 | null> {
    await this.#assertStoreDirectory(true);
    const filename = path.join(
      this.storageDirectory,
      CHANNEL_CURSOR_FILENAME,
    );
    let input: unknown;
    try {
      input = await readBoundedJson(
        filename,
        this.#limits.receiptBytes,
      );
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") return null;
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_STORE_STATE_INVALID",
        `The local channel anti-replay cursor cannot be read: ${String(error)}`,
        { cause: error },
      );
    }
    const parsed =
      LocalDataBundleChannelCursorRecordV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_STORE_STATE_INVALID",
        `The local channel anti-replay cursor is invalid: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    const { integritySha256, ...draft } = parsed.data;
    if (
      integritySha256 !==
      (await sha256Hex(canonicalJson(draft)))
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_STORE_STATE_INVALID",
        "The local channel anti-replay cursor failed its integrity check.",
      );
    }
    return parsed.data.cursor;
  }

  async compareAndSetChannelCursor(input: {
    expectedPointerSha256: string | null;
    cursor: DataBundleChannelCursorV1;
  }): Promise<LocalDataBundleChannelCursorCompareAndSetResult> {
    if (input.expectedPointerSha256 !== null) {
      sha256Schema.parse(input.expectedPointerSha256);
    }
    const cursor = DataBundleChannelCursorV1Schema.parse(input.cursor);
    return this.#withLease(undefined, async () => {
      const current = await this.getChannelCursor();
      if (current?.pointerSha256 === cursor.pointerSha256) {
        return { committed: false, cursor: current };
      }
      if (
        (current?.pointerSha256 ?? null) !==
        input.expectedPointerSha256
      ) {
        if (!current) {
          throw new LocalDataBundleStoreError(
            "DATA_BUNDLE_STORE_STATE_INVALID",
            "The durable channel anti-replay cursor disappeared during compare-and-set.",
          );
        }
        return { committed: false, cursor: current };
      }
      const draft =
        localDataBundleChannelCursorDraftV1Schema.parse({
          schemaVersion: 1,
          stateKind:
            "rosterpilot-local-data-bundle-channel-cursor",
          cursor,
          updatedAt: this.#timestamp(),
        });
      await atomicWriteJson(
        path.join(
          this.storageDirectory,
          CHANNEL_CURSOR_FILENAME,
        ),
        LocalDataBundleChannelCursorRecordV1Schema.parse({
          ...draft,
          integritySha256: await sha256Hex(
            canonicalJson(draft),
          ),
        }),
      );
      return { committed: true, cursor };
    });
  }

  async getStatus(): Promise<LocalDataBundleStoreStatus> {
    const issues: string[] = [];
    let state: LocalDataBundleStoreStateV1 | null = null;
    try {
      state = await this.#readState();
    } catch (error) {
      issues.push(String(error));
    }
    const references = await this.#readReferences().catch((error) => {
      issues.push(String(error));
      return {
        references: [],
        issues: [],
        retentionBlocked: true,
      } satisfies ReadReferencesResult;
    });
    issues.push(...references.issues);
    const nowMs = this.#now().getTime();
    const liveReferences = references.references.filter(
      (reference) => this.#referenceIsLive(reference, nowMs),
    );
    const referenceCounts = new Map<string, number>();
    for (const reference of liveReferences) {
      referenceCounts.set(
        reference.bundleId,
        (referenceCounts.get(reference.bundleId) ?? 0) + 1,
      );
    }

    const installed: string[] =
      await this.#installedBundleIds().catch((error) => {
        issues.push(String(error));
        return [] as string[];
      });
    const bundles: LocalDataBundleStatusEntry[] = [];
    for (const bundleId of installed) {
      const quarantine =
        state?.quarantines.find(
          (entry) => entry.bundleId === bundleId,
        ) ?? null;
      let integrity: LocalDataBundleStatusEntry["integrity"] =
        "verified";
      let installedAt: string | null = null;
      let issue: string | null = null;
      try {
        const verified = await this.#verifyInstalledBundle(bundleId);
        installedAt = verified.receipt.installedAt;
      } catch (error) {
        integrity = "invalid";
        issue = String(error);
        issues.push(`Bundle "${bundleId}": ${issue}`);
      }
      const role: LocalDataBundleStatusEntry["role"] =
        quarantine
          ? "quarantined"
          : state?.activeBundleId === bundleId
            ? "active"
            : state?.previousBundleIds.includes(bundleId)
              ? "previous"
              : "installed";
      bundles.push({
        bundleId,
        role,
        integrity,
        installedAt,
        referencedBy: referenceCounts.get(bundleId) ?? 0,
        quarantine,
        issue,
      });
    }

    if (
      state?.activeBundleId &&
      !installed.includes(state.activeBundleId)
    ) {
      issues.push(
        `Active bundle "${state.activeBundleId}" is not installed.`,
      );
    }
    const activeEntry = bundles.find(
      (entry) => entry.bundleId === state?.activeBundleId,
    );
    const ready =
      Boolean(state?.activeBundleId) &&
      activeEntry?.integrity === "verified" &&
      activeEntry.role === "active";
    const empty =
      installed.length === 0 && state?.activeBundleId == null;
    return {
      schemaVersion: 1,
      state: ready ? "ready" : empty ? "empty" : "degraded",
      activeBundleId: state?.activeBundleId ?? null,
      previousBundleIds: state?.previousBundleIds ?? [],
      stateRevision: state?.revision ?? null,
      updatedAt: state?.updatedAt ?? null,
      bundles,
      quarantines: state?.quarantines ?? [],
      rollbackHold: state?.rollbackHold ?? null,
      references: liveReferences.map((reference) => ({
        referenceId: reference.referenceId,
        bundleId: reference.bundleId,
        expiresAt: reference.expiresAt,
        retentionClass: this.#referenceRetentionClass(reference),
        owner: reference.owner ?? null,
      })),
      updateLease: await this.#readLeaseStatus(),
      issues,
    };
  }

  async #prepareInstall(
    input: LocalDataBundleInstallInput,
  ): Promise<PreparedInstall> {
    const manifestResult = await verifyDataBundleManifest(
      input.manifest,
      this.#trustedKeys,
    );
    if (!manifestResult.ok) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INSTALL_INVALID",
        `Data-bundle manifest verification failed (${manifestResult.code}): ${manifestResult.message}`,
      );
    }
    const manifest = manifestResult.data;
    let sourceChannel: string | null = null;
    let channelPointerSha256: string | null = null;
    if (input.channelPointer !== undefined) {
      const pointerResult = await verifyDataBundleChannelPointer(
        input.channelPointer,
        this.#trustedKeys,
      );
      if (!pointerResult.ok) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INSTALL_INVALID",
          `Data-bundle channel verification failed (${pointerResult.code}): ${pointerResult.message}`,
        );
      }
      if (pointerResult.data.bundleId !== manifest.bundleId) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INSTALL_INVALID",
          "The verified channel pointer and manifest identify different data bundles.",
        );
      }
      sourceChannel = pointerResult.data.channel;
      channelPointerSha256 = await sha256Hex(
        canonicalJson(pointerResult.data),
      );
    }

    const shardInputs = new Map(shardInputEntries(input.shards));
    const declaredPaths = manifest.shards.map(
      (descriptor) => descriptor.path,
    );
    if (!localShardPathsAreSafe(declaredPaths)) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INSTALL_INVALID",
        "The signed manifest repeats or overlaps a shard path or reserved local bundle filename.",
      );
    }
    const suppliedPaths = [...shardInputs.keys()].sort();
    const expectedPaths = [...declaredPaths].sort();
    if (canonicalJson(suppliedPaths) !== canonicalJson(expectedPaths)) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INSTALL_INVALID",
        `The supplied shard set does not exactly match the signed manifest (expected ${expectedPaths.join(
          ", ",
        )}; received ${suppliedPaths.join(", ")}).`,
      );
    }

    const serializedManifest = encodeJson(manifest);
    if (serializedManifest.byteLength > this.#limits.manifestBytes) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INSTALL_INVALID",
        "The verified data-bundle manifest exceeds the local size limit.",
      );
    }
    const verifiedShards = new Map<
      string,
      VerifiedDataBundleShardV1<unknown>
    >();
    const serializedShards = new Map<string, Uint8Array>();
    let bundleBytes = serializedManifest.byteLength;
    for (const descriptor of manifest.shards) {
      const shardResult = await verifyDataBundleShard(
        manifest,
        shardInputs.get(descriptor.path),
      );
      if (!shardResult.ok) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INSTALL_INVALID",
          `Data-bundle shard "${descriptor.path}" verification failed (${shardResult.code}): ${shardResult.message}`,
        );
      }
      await this.#validateShardData?.(
        shardResult.data.data,
        descriptor,
      );
      const bytes = encodeJson(shardResult.data);
      if (bytes.byteLength > this.#limits.shardBytes) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INSTALL_INVALID",
          `Data-bundle shard "${descriptor.path}" exceeds the local size limit.`,
        );
      }
      bundleBytes += bytes.byteLength;
      if (bundleBytes > this.#limits.bundleBytes) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INSTALL_INVALID",
          "The verified data bundle exceeds the aggregate local size limit.",
        );
      }
      verifiedShards.set(descriptor.shardId, shardResult.data);
      serializedShards.set(descriptor.path, bytes);
    }
    createDataBundleSnapshot(manifest, verifiedShards.values(), {
      acquiredAt: this.#timestamp(),
    });

    const acceptance = input.acceptance ?? {};
    const receipt = await createLocalDataBundleIntegrityReceipt({
      schemaVersion: 1,
      receiptKind: "rosterpilot-local-data-bundle-integrity",
      bundleId: manifest.bundleId,
      installedAt: this.#timestamp(),
      manifestSha256: await sha256Hex(
        canonicalJson(manifest),
      ),
      signing: {
        algorithm: "Ed25519",
        keyId: manifest.signature.keyId,
      },
      source: {
        channel: sourceChannel,
        channelPointerSha256,
      },
      acceptance: {
        classification: acceptance.classification ?? null,
        certificationStatus:
          acceptance.certificationStatus ?? "not-required",
        certificationEvidenceSha256:
          acceptance.certificationEvidenceSha256 ?? null,
      },
      shards: manifest.shards.map((descriptor) => ({
        shardId: descriptor.shardId,
        path: descriptor.path,
        contentSha256: descriptor.contentSha256,
        semanticHash: descriptor.semanticHash,
        byteLength: descriptor.byteLength,
      })),
    });
    return {
      manifest,
      shards: verifiedShards,
      serializedManifest,
      serializedShards,
      receipt,
    };
  }

  async #verifyInstalledBundle(
    bundleId: string,
  ): Promise<LocalDataBundleVerifiedInstall> {
    assertBundleId(bundleId);
    await this.#assertStoreDirectory(true);
    await this.#assertStoreSubdirectory("bundles", true);
    const bundleDirectory = this.#bundleDirectory(bundleId);
    let bundleMetadata;
    try {
      bundleMetadata = await lstat(bundleDirectory);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_NOT_INSTALLED",
          `Data bundle "${bundleId}" is not installed.`,
        );
      }
      throw error;
    }
    if (
      !bundleMetadata.isDirectory() ||
      bundleMetadata.isSymbolicLink()
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INTEGRITY_FAILED",
        `Installed data bundle "${bundleId}" is not a regular directory.`,
      );
    }
    const manifestInput = await readBoundedJson(
      path.join(bundleDirectory, MANIFEST_FILENAME),
      this.#limits.manifestBytes,
    );
    const manifestResult = await verifyDataBundleManifest(
      manifestInput,
      this.#trustedKeys,
    );
    if (!manifestResult.ok) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INTEGRITY_FAILED",
        `Installed data-bundle manifest verification failed (${manifestResult.code}): ${manifestResult.message}`,
      );
    }
    const manifest = manifestResult.data;
    if (manifest.bundleId !== bundleId) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INTEGRITY_FAILED",
        `Installed directory "${bundleId}" contains manifest "${manifest.bundleId}".`,
      );
    }
    const declaredPaths = manifest.shards.map(
      (descriptor) => descriptor.path,
    );
    if (!localShardPathsAreSafe(declaredPaths)) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INTEGRITY_FAILED",
        "Installed data-bundle manifest has unsafe, repeated, or overlapping local paths.",
      );
    }
    const expectedFiles = [
      MANIFEST_FILENAME,
      RECEIPT_FILENAME,
      ...declaredPaths,
    ].sort();
    const actualFiles = await listRegularFiles(bundleDirectory);
    if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INTEGRITY_FAILED",
        `Installed data bundle "${bundleId}" has missing or unexpected files.`,
      );
    }

    const shards = new Map<
      string,
      VerifiedDataBundleShardV1<unknown>
    >();
    let bundleBytes = encodeJson(manifest).byteLength;
    for (const descriptor of manifest.shards) {
      const shardInput = await readBoundedJson(
        resolveBundlePath(bundleDirectory, descriptor.path),
        this.#limits.shardBytes,
      );
      const shardResult = await verifyDataBundleShard(
        manifest,
        shardInput,
      );
      if (!shardResult.ok) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INTEGRITY_FAILED",
          `Installed data-bundle shard "${descriptor.path}" verification failed (${shardResult.code}): ${shardResult.message}`,
        );
      }
      await this.#validateShardData?.(
        shardResult.data.data,
        descriptor,
      );
      bundleBytes += encodeJson(shardResult.data).byteLength;
      if (bundleBytes > this.#limits.bundleBytes) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INTEGRITY_FAILED",
          `Installed data bundle "${bundleId}" exceeds the aggregate local size limit.`,
        );
      }
      shards.set(descriptor.shardId, shardResult.data);
    }
    const snapshot = createDataBundleSnapshot(
      manifest,
      shards.values(),
      {
        acquiredAt: this.#timestamp(),
      },
    );
    const receiptInput = await readBoundedJson(
      path.join(bundleDirectory, RECEIPT_FILENAME),
      this.#limits.receiptBytes,
    );
    const receiptShards: LocalDataBundleReceiptShardV1[] =
      manifest.shards.map((descriptor) => ({
        shardId: descriptor.shardId,
        path: descriptor.path,
        contentSha256: descriptor.contentSha256,
        semanticHash: descriptor.semanticHash,
        byteLength: descriptor.byteLength,
      }));
    const receiptResult =
      await verifyLocalDataBundleIntegrityReceipt(receiptInput, {
        bundleId,
        manifestSha256: await sha256Hex(
          canonicalJson(manifest),
        ),
        signing: {
          algorithm: "Ed25519",
          keyId: manifest.signature.keyId,
        },
        shards: receiptShards,
      });
    if (!receiptResult.ok) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INTEGRITY_FAILED",
        `Installed data-bundle receipt verification failed (${receiptResult.code}): ${receiptResult.message}`,
      );
    }
    return {
      bundleId,
      manifest,
      shards: snapshot.shards,
      snapshot,
      receipt: receiptResult.receipt,
    };
  }

  async #activateLocked(
    bundleId: string,
    operation: "install" | "activate" | "rollback",
  ): Promise<LocalDataBundleActivationResult> {
    assertBundleId(bundleId);
    const state = await this.#readState();
    const rollbackHold =
      operation === "rollback"
        ? {
            bundleId,
            engagedAt: this.#timestamp(),
            release: "force-refresh" as const,
          }
        : state.rollbackHold ?? null;
    if (
      rollbackHold &&
      operation !== "rollback" &&
      rollbackHold.bundleId !== bundleId
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_ROLLBACK_HELD",
        `Data bundle activation is held at "${rollbackHold.bundleId}" until an explicit force refresh clears the rollback hold.`,
      );
    }
    if (state.quarantines.some((entry) => entry.bundleId === bundleId)) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_QUARANTINED",
        `Data bundle "${bundleId}" is quarantined.`,
      );
    }
    await this.#verifyInstalledBundle(bundleId);
    if (state.activeBundleId === bundleId) {
      if (operation === "rollback") {
        const next = await this.#writeNextState(state, {
          activeBundleId: state.activeBundleId,
          previousBundleIds: state.previousBundleIds,
          quarantines: state.quarantines,
          rollbackHold,
          lastOperation: operation,
        });
        return {
          bundleId,
          previousBundleId: state.activeBundleId,
          changed: false,
          state: next,
        };
      }
      return {
        bundleId,
        previousBundleId: state.activeBundleId,
        changed: false,
        state,
      };
    }
    await this.#injectFault("before-active-switch");
    const previousBundleId = state.activeBundleId;
    const history = [
      ...(previousBundleId ? [previousBundleId] : []),
      ...state.previousBundleIds,
    ]
      .filter(
        (candidate, index, all) =>
          candidate !== bundleId &&
          all.indexOf(candidate) === index,
      )
      .slice(0, PREVIOUS_BUNDLE_RETENTION);
    const next = await this.#writeNextState(state, {
      activeBundleId: bundleId,
      previousBundleIds: history,
      quarantines: state.quarantines,
      rollbackHold,
      lastOperation: operation,
    });
    return {
      bundleId,
      previousBundleId,
      changed: true,
      state: next,
    };
  }

  async #setReferenceLocked(
    referenceId: string,
    bundleId: string,
    expiresAt: string | null,
    metadata: {
      retentionClass: "durable" | "transient-snapshot";
      owner: {
        pid: number;
        instanceId: string;
      } | null;
    },
  ): Promise<LocalDataBundleReferenceV1> {
    assertBundleId(bundleId);
    const state = await this.#readState();
    if (state.quarantines.some((entry) => entry.bundleId === bundleId)) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_QUARANTINED",
        `Data bundle "${bundleId}" is quarantined.`,
      );
    }
    await this.#verifyInstalledBundle(bundleId);
    const draft = localDataBundleReferenceDraftV1Schema.parse({
      schemaVersion: 1,
      referenceKind: "rosterpilot-data-bundle-reference",
      referenceId,
      bundleId,
      createdAt: this.#timestamp(),
      expiresAt,
      retentionClass: metadata.retentionClass,
      owner: metadata.owner,
    });
    if (
      draft.retentionClass === "transient-snapshot" &&
      (draft.expiresAt === null || draft.owner === null)
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_REFERENCE_INVALID",
        "A transient snapshot reference requires an owner and bounded expiration.",
      );
    }
    if (
      draft.retentionClass === "durable" &&
      draft.owner !== null
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_REFERENCE_INVALID",
        "A durable data-bundle reference cannot have a process owner.",
      );
    }
    if (
      draft.expiresAt !== null &&
      Date.parse(draft.expiresAt) <= this.#now().getTime()
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_REFERENCE_INVALID",
        "A new data-bundle reference must expire in the future.",
      );
    }
    const reference = LocalDataBundleReferenceV1Schema.parse({
      ...draft,
      integritySha256: await sha256Hex(canonicalJson(draft)),
    });
    await atomicWriteJson(
      await this.#referenceFilename(referenceId),
      reference,
    );
    return reference;
  }

  async #readReferenceFile(
    filename: string,
  ): Promise<LocalDataBundleReferenceV1> {
    const input = await readBoundedJson(
      filename,
      this.#limits.receiptBytes,
    );
    const parsed = LocalDataBundleReferenceV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_REFERENCE_INVALID",
        `Invalid data-bundle reference "${filename}": ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    const {
      integritySha256,
      ...draft
    } = parsed.data;
    if (
      integritySha256 !==
      (await sha256Hex(canonicalJson(draft)))
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_REFERENCE_INVALID",
        `Data-bundle reference "${filename}" failed its integrity check.`,
      );
    }
    if (
      path.basename(filename, ".json") !==
      (await sha256Hex(parsed.data.referenceId))
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_REFERENCE_INVALID",
        `Data-bundle reference "${filename}" is stored under the wrong identity.`,
      );
    }
    if (
      parsed.data.retentionClass === "transient-snapshot" &&
      (parsed.data.expiresAt === null || !parsed.data.owner)
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_REFERENCE_INVALID",
        `Transient snapshot reference "${filename}" has no owner or bounded expiration.`,
      );
    }
    if (
      parsed.data.retentionClass === "durable" &&
      parsed.data.owner
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_REFERENCE_INVALID",
        `Durable data-bundle reference "${filename}" cannot have a process owner.`,
      );
    }
    return parsed.data;
  }

  #referenceRetentionClass(
    reference: LocalDataBundleReferenceV1,
  ): "durable" | "transient-snapshot" {
    return (
      reference.retentionClass ??
      (reference.referenceId.startsWith("snapshot:")
        ? "transient-snapshot"
        : "durable")
    );
  }

  #referenceIsLive(
    reference: LocalDataBundleReferenceV1,
    nowMs: number,
  ): boolean {
    const retentionClass =
      this.#referenceRetentionClass(reference);
    if (
      retentionClass === "transient-snapshot" &&
      reference.owner &&
      !this.#isProcessAlive(reference.owner.pid)
    ) {
      return false;
    }
    const expiresAt =
      reference.expiresAt === null &&
      retentionClass === "transient-snapshot"
        ? Date.parse(reference.createdAt) +
          this.#snapshotReferenceTtlMs
        : reference.expiresAt === null
          ? Number.POSITIVE_INFINITY
          : Date.parse(reference.expiresAt);
    return expiresAt > nowMs;
  }

  async #readReferences(): Promise<ReadReferencesResult> {
    const directory = path.join(
      this.storageDirectory,
      "references",
    );
    let entries;
    try {
      await this.#assertStoreSubdirectory("references", false);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") {
        return {
          references: [],
          issues: [],
          retentionBlocked: false,
        };
      }
      throw error;
    }
    const references: LocalDataBundleReferenceV1[] = [];
    const issues: string[] = [];
    let retentionBlocked = false;
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^[a-f0-9]{64}\.json$/.test(entry.name)
      ) {
        issues.push(
          `Unexpected data-bundle reference entry "${entry.name}".`,
        );
        retentionBlocked = true;
        continue;
      }
      try {
        references.push(
          await this.#readReferenceFile(
            path.join(directory, entry.name),
          ),
        );
      } catch (error) {
        issues.push(String(error));
        retentionBlocked = true;
      }
    }
    return { references, issues, retentionBlocked };
  }

  async #referenceFilename(referenceId: string): Promise<string> {
    if (
      typeof referenceId !== "string" ||
      referenceId.length === 0 ||
      referenceId.length > 512
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_REFERENCE_INVALID",
        "A data-bundle reference id must contain 1 to 512 characters.",
      );
    }
    return path.join(
      this.storageDirectory,
      "references",
      `${await sha256Hex(referenceId)}.json`,
    );
  }

  async #readState(): Promise<LocalDataBundleStoreStateV1> {
    await this.#assertStoreDirectory(true);
    const filename = path.join(
      this.storageDirectory,
      ACTIVE_STATE_FILENAME,
    );
    let input: unknown;
    try {
      input = await readBoundedJson(
        filename,
        this.#limits.receiptBytes,
      );
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") {
        return this.#sealState({
          schemaVersion: 1,
          stateKind: "rosterpilot-local-data-bundle-store",
          revision: 0,
          activeBundleId: null,
          previousBundleIds: [],
          quarantines: [],
          rollbackHold: null,
          updatedAt: this.#timestamp(),
          lastOperation: "initialize",
        });
      }
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_STORE_STATE_INVALID",
        `The local data-bundle active state cannot be read: ${String(
          error,
        )}`,
        { cause: error },
      );
    }
    const parsed =
      LocalDataBundleStoreStateV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_STORE_STATE_INVALID",
        `The local data-bundle active state is invalid: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    const {
      integritySha256,
      ...draft
    } = parsed.data;
    if (
      integritySha256 !==
      (await sha256Hex(canonicalJson(draft)))
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_STORE_STATE_INVALID",
        "The local data-bundle active state failed its integrity check.",
      );
    }
    return parsed.data;
  }

  async #sealState(
    input: LocalDataBundleStoreStateDraftV1,
  ): Promise<LocalDataBundleStoreStateV1> {
    const draft =
      localDataBundleStoreStateDraftV1Schema.parse(input);
    return LocalDataBundleStoreStateV1Schema.parse({
      ...draft,
      integritySha256: await sha256Hex(canonicalJson(draft)),
    });
  }

  async #writeNextState(
    state: LocalDataBundleStoreStateV1,
    input: Pick<
      LocalDataBundleStoreStateDraftV1,
      | "activeBundleId"
      | "previousBundleIds"
      | "quarantines"
      | "rollbackHold"
      | "lastOperation"
    > & {
      rollbackHold?: LocalDataBundleRollbackHoldV1 | null;
    },
  ): Promise<LocalDataBundleStoreStateV1> {
    const next = await this.#sealState({
      schemaVersion: 1,
      stateKind: "rosterpilot-local-data-bundle-store",
      revision: state.revision + 1,
      activeBundleId: input.activeBundleId,
      previousBundleIds: input.previousBundleIds,
      quarantines: input.quarantines,
      rollbackHold:
        input.rollbackHold === undefined
          ? state.rollbackHold ?? null
          : input.rollbackHold,
      updatedAt: this.#timestamp(),
      lastOperation: input.lastOperation,
    });
    await atomicWriteJson(
      path.join(
        this.storageDirectory,
        ACTIVE_STATE_FILENAME,
      ),
      next,
    );
    return next;
  }

  async #installedBundleIds(): Promise<string[]> {
    const directory = path.join(
      this.storageDirectory,
      "bundles",
    );
    let entries;
    try {
      await this.#assertStoreSubdirectory("bundles", false);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          SHA256_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  }

  async #readLeaseStatus(): Promise<
    LocalDataBundleStoreStatus["updateLease"]
  > {
    const ownerFilename = path.join(
      this.storageDirectory,
      "locks",
      UPDATE_LEASE_DIRECTORY,
      "owner.json",
    );
    try {
      const owner = JSON.parse(
        await readFile(ownerFilename, "utf8"),
      ) as Partial<LeaseOwner>;
      return {
        held: true,
        pid:
          typeof owner.pid === "number" ? owner.pid : null,
        acquiredAt:
          typeof owner.acquiredAt === "string"
            ? owner.acquiredAt
            : null,
      };
    } catch {
      return {
        held: false,
        pid: null,
        acquiredAt: null,
      };
    }
  }

  async #ensureDirectories(): Promise<void> {
    await mkdir(this.storageDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await this.#assertStoreDirectory(false);
    for (const name of [
      "bundles",
      "staging",
      "trash",
      "references",
      "locks",
    ]) {
      const directory = path.join(this.storageDirectory, name);
      await mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (filesystemCode(error) !== "EEXIST") throw error;
      });
      await this.#assertStoreSubdirectory(name, false);
    }
  }

  async #assertStoreDirectory(allowMissing: boolean): Promise<void> {
    try {
      const metadata = await lstat(this.storageDirectory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink()
      ) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INTEGRITY_FAILED",
          `Local data-bundle path "${this.storageDirectory}" is not a regular directory.`,
        );
      }
    } catch (error) {
      if (allowMissing && filesystemCode(error) === "ENOENT") return;
      throw error;
    }
  }

  async #assertStoreSubdirectory(
    name: string,
    allowMissing: boolean,
  ): Promise<void> {
    await this.#assertStoreDirectory(allowMissing);
    const directory = path.join(this.storageDirectory, name);
    try {
      const metadata = await lstat(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink()
      ) {
        throw new LocalDataBundleStoreError(
          "DATA_BUNDLE_INTEGRITY_FAILED",
          `Local data-bundle path "${directory}" is not a regular directory.`,
        );
      }
    } catch (error) {
      if (allowMissing && filesystemCode(error) === "ENOENT") return;
      throw error;
    }
  }

  #bundleDirectory(bundleId: string): string {
    assertBundleId(bundleId);
    return path.join(
      this.storageDirectory,
      "bundles",
      bundleId,
    );
  }

  #timestamp(): string {
    const value = this.#now();
    if (
      !(value instanceof Date) ||
      !Number.isFinite(value.getTime())
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_INSTALL_INVALID",
        "The local data-bundle clock returned an invalid date.",
      );
    }
    return value.toISOString();
  }

  async #injectFault(
    point: LocalDataBundleStoreFaultPoint,
  ): Promise<void> {
    await this.#faultInjector?.(point);
  }

  #assertLease(
    lease: LocalDataBundleUpdateLease,
  ): asserts lease is OwnedLocalDataBundleUpdateLease {
    if (
      !(lease instanceof OwnedLocalDataBundleUpdateLease) ||
      lease.storageDirectory !== this.storageDirectory ||
      lease.released
    ) {
      throw new LocalDataBundleStoreError(
        "DATA_BUNDLE_STORE_LEASE_INVALID",
        "The supplied data-bundle update lease is not active for this store.",
      );
    }
  }

  async #withLease<T>(
    supplied: LocalDataBundleUpdateLease | undefined,
    operation: (
      lease: OwnedLocalDataBundleUpdateLease,
    ) => Promise<T>,
  ): Promise<T> {
    if (supplied) {
      this.#assertLease(supplied);
      return operation(supplied);
    }
    const acquired = await this.acquireUpdateLease();
    this.#assertLease(acquired);
    try {
      return await operation(acquired);
    } finally {
      await acquired.release();
    }
  }
}

export function createLocalDataBundleStore(
  options: CreateLocalDataBundleStoreOptions,
): LocalDataBundleStore {
  return new LocalDataBundleStore(options);
}
