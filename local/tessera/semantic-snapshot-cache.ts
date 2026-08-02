import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type {
  TesseraImportedArmySemanticSnapshot,
} from "../../lib/rosterpilot";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  deterministicTesseraSavedListName,
  tesseraSavedListReuseValidationError,
  type TesseraSavedListReuseSide,
} from "./saved-list-reuse";

const sha256Pattern = /^[0-9a-f]{64}$/;
const maximumPointerBytes = 64 * 1024;
const maximumReceiptBytes = 8 * 1024 * 1024;

const semanticValueSchema = z.object({
  name: z.string(),
  value: z.string(),
}).strict();

const semanticToggleSchema = z.object({
  name: z.string(),
  state: z.boolean().nullable(),
}).strict();

const importedWeaponSchema = z.object({
  occurrence: z.number().int().positive(),
  name: z.string(),
  profile: z.string().nullable(),
  count: z.number().int().nonnegative().nullable(),
  visibleCharacteristics: z.array(semanticValueSchema),
  effectToggles: z.array(semanticToggleSchema),
}).strict();

const importedUnitSchema = z.object({
  occurrence: z.number().int().positive(),
  name: z.string(),
  modelCount: z.number().int().positive().nullable(),
  included: z.boolean().nullable(),
  weapons: z.array(importedWeaponSchema),
  visibleCharacteristics: z.array(semanticValueSchema),
  effectToggles: z.array(semanticToggleSchema),
}).strict();

const importedArmySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  side: z.enum(["player", "opponent"]),
  armyName: z.string().nullable(),
  reportedUnitCount: z.number().int().positive().nullable(),
  units: z.array(importedUnitSchema),
  warningCodes: z.array(z.string()),
  alternateProfileResolutions: z.array(z.object({
    unit: z.string().nullable(),
    weaponGroup: z.string().nullable(),
    availableProfiles: z.array(z.string()),
    selectedProfile: z.string().nullable(),
    resolvedByPolicy: z.boolean(),
  }).strict()),
  completeness: z.enum(["complete", "partial"]),
  incompleteReasons: z.array(z.string()),
}).strict().superRefine((snapshot, context) => {
  if (
    snapshot.completeness === "complete" &&
    snapshot.incompleteReasons.length > 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["incompleteReasons"],
      message: "A complete semantic snapshot cannot retain incomplete reasons.",
    });
  }
  if (
    snapshot.completeness === "partial" &&
    snapshot.incompleteReasons.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["incompleteReasons"],
      message: "A partial semantic snapshot must explain why it is incomplete.",
    });
  }
});

const cacheKeySchema = z.object({
  schemaVersion: z.literal(1),
  side: z.enum(["player", "opponent"]),
  enrichedRoszSha256: z.string().regex(sha256Pattern),
  savedListIdentity: z.object({
    name: z.string().min(1),
    runId: z.string().min(1),
  }).strict(),
  rosterExecutionFingerprint: z.string().regex(sha256Pattern),
  scopedProfilePolicySha256: z.string().regex(sha256Pattern),
  expectedUnitCount: z.number().int().positive(),
}).strict();

const receiptPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("tessera-import-semantic-snapshot-receipt"),
  key: cacheKeySchema,
  keySha256: z.string().regex(sha256Pattern),
  snapshot: importedArmySnapshotSchema,
  snapshotSha256: z.string().regex(sha256Pattern),
}).strict();

const receiptSchema = receiptPayloadSchema.extend({
  integritySha256: z.string().regex(sha256Pattern),
}).strict();

const pointerPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("tessera-import-semantic-snapshot-pointer"),
  keySha256: z.string().regex(sha256Pattern),
  receiptSha256: z.string().regex(sha256Pattern),
}).strict();

const pointerSchema = pointerPayloadSchema.extend({
  integritySha256: z.string().regex(sha256Pattern),
}).strict();

export type TesseraImportSemanticSnapshotCacheKey = z.infer<
  typeof cacheKeySchema
>;

export type TesseraImportSemanticSnapshotReceipt = z.infer<
  typeof receiptSchema
>;

export type TesseraImportSemanticSnapshotCacheHit = {
  status: "hit";
  snapshot: TesseraImportedArmySemanticSnapshot;
  keySha256: string;
  snapshotSha256: string;
  receiptSha256: string;
};

export type TesseraImportSemanticSnapshotCacheMiss = {
  status: "miss" | "invalid";
  reason:
    | "pointer-missing"
    | "pointer-not-regular-file"
    | "pointer-too-large"
    | "pointer-malformed"
    | "pointer-integrity-mismatch"
    | "pointer-key-mismatch"
    | "receipt-missing"
    | "receipt-not-regular-file"
    | "receipt-too-large"
    | "receipt-malformed"
    | "receipt-integrity-mismatch"
    | "receipt-address-mismatch"
    | "receipt-key-mismatch"
    | "snapshot-integrity-mismatch"
    | "snapshot-side-mismatch"
    | "snapshot-unit-count-mismatch";
  keySha256: string;
};

export type TesseraImportSemanticSnapshotCacheLoad =
  | TesseraImportSemanticSnapshotCacheHit
  | TesseraImportSemanticSnapshotCacheMiss;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function semanticSnapshotCacheKeySha256(
  key: TesseraImportSemanticSnapshotCacheKey,
): string {
  return sha256(canonicalJson(key));
}

function assertDeterministicSavedListIdentity(
  key: TesseraImportSemanticSnapshotCacheKey,
): void {
  const expectedName = deterministicTesseraSavedListName(key.side, {
    runId: key.savedListIdentity.runId,
    enrichedRoszSha256: key.enrichedRoszSha256,
    scopedProfilePolicySha256: key.scopedProfilePolicySha256,
    profilePolicyEntryKeys: [],
    rosterExecutionFingerprint: key.rosterExecutionFingerprint,
    expectedUnitCount: key.expectedUnitCount,
  });
  if (key.savedListIdentity.name !== expectedName) {
    throw new Error(
      "The Tessera semantic snapshot cache key has a mismatched deterministic saved-list identity.",
    );
  }
}

export function createTesseraImportSemanticSnapshotCacheKey(
  side: "player" | "opponent",
  identity: TesseraSavedListReuseSide,
): TesseraImportSemanticSnapshotCacheKey {
  const validationError = tesseraSavedListReuseValidationError(identity);
  if (validationError) {
    throw new Error(
      `Cannot create a Tessera semantic snapshot cache key: ${validationError}.`,
    );
  }
  return cacheKeySchema.parse({
    schemaVersion: 1,
    side,
    enrichedRoszSha256:
      identity.enrichedRoszSha256.toLocaleLowerCase(),
    savedListIdentity: {
      name: deterministicTesseraSavedListName(side, identity),
      runId: identity.runId.trim(),
    },
    rosterExecutionFingerprint:
      identity.rosterExecutionFingerprint.toLocaleLowerCase(),
    scopedProfilePolicySha256:
      identity.scopedProfilePolicySha256.toLocaleLowerCase(),
    expectedUnitCount: identity.expectedUnitCount,
  });
}

export function tesseraImportSemanticSnapshotCachePaths(
  cacheDirectory: string,
  key: TesseraImportSemanticSnapshotCacheKey,
  receiptSha256?: string,
): {
  keySha256: string;
  pointerPath: string;
  receiptPath: string | null;
} {
  const parsedKey = cacheKeySchema.parse(key);
  assertDeterministicSavedListIdentity(parsedKey);
  const keySha256 = semanticSnapshotCacheKeySha256(parsedKey);
  return {
    keySha256,
    pointerPath: path.join(
      cacheDirectory,
      "v1",
      "keys",
      keySha256.slice(0, 2),
      `${keySha256}.json`,
    ),
    receiptPath: receiptSha256
      ? path.join(
          cacheDirectory,
          "v1",
          "receipts",
          receiptSha256.slice(0, 2),
          `${receiptSha256}.json`,
        )
      : null,
  };
}

async function readRegularFile(
  filename: string,
  maximumBytes: number,
): Promise<
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "missing" | "not-regular-file" | "too-large" }
> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: "not-regular-file" };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return { ok: false, reason: "not-regular-file" };
  }
  if (metadata.size > maximumBytes) {
    return { ok: false, reason: "too-large" };
  }
  try {
    const bytes = await readFile(filename);
    if (bytes.length > maximumBytes) {
      return { ok: false, reason: "too-large" };
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: "not-regular-file" };
  }
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function loadTesseraImportSemanticSnapshot(
  cacheDirectory: string,
  key: TesseraImportSemanticSnapshotCacheKey,
): Promise<TesseraImportSemanticSnapshotCacheLoad> {
  const parsedKey = cacheKeySchema.parse(key);
  assertDeterministicSavedListIdentity(parsedKey);
  const keySha256 = semanticSnapshotCacheKeySha256(parsedKey);
  const paths = tesseraImportSemanticSnapshotCachePaths(
    cacheDirectory,
    parsedKey,
  );
  const pointerFile = await readRegularFile(
    paths.pointerPath,
    maximumPointerBytes,
  );
  if (!pointerFile.ok) {
    return {
      status: pointerFile.reason === "missing" ? "miss" : "invalid",
      reason:
        pointerFile.reason === "missing"
          ? "pointer-missing"
          : pointerFile.reason === "too-large"
            ? "pointer-too-large"
            : "pointer-not-regular-file",
      keySha256,
    };
  }
  let pointerCandidate: unknown;
  try {
    pointerCandidate = JSON.parse(pointerFile.bytes.toString("utf8"));
  } catch {
    return { status: "invalid", reason: "pointer-malformed", keySha256 };
  }
  const parsedPointer = pointerSchema.safeParse(pointerCandidate);
  if (!parsedPointer.success) {
    return { status: "invalid", reason: "pointer-malformed", keySha256 };
  }
  const pointer = parsedPointer.data;
  const pointerPayload = pointerPayloadSchema.parse({
    schemaVersion: pointer.schemaVersion,
    kind: pointer.kind,
    keySha256: pointer.keySha256,
    receiptSha256: pointer.receiptSha256,
  });
  if (sha256(canonicalJson(pointerPayload)) !== pointer.integritySha256) {
    return {
      status: "invalid",
      reason: "pointer-integrity-mismatch",
      keySha256,
    };
  }
  if (pointer.keySha256 !== keySha256) {
    return {
      status: "invalid",
      reason: "pointer-key-mismatch",
      keySha256,
    };
  }
  const receiptPath = tesseraImportSemanticSnapshotCachePaths(
    cacheDirectory,
    parsedKey,
    pointer.receiptSha256,
  ).receiptPath;
  if (!receiptPath) {
    return { status: "invalid", reason: "receipt-missing", keySha256 };
  }
  const receiptFile = await readRegularFile(
    receiptPath,
    maximumReceiptBytes,
  );
  if (!receiptFile.ok) {
    return {
      status: "invalid",
      reason:
        receiptFile.reason === "missing"
          ? "receipt-missing"
          : receiptFile.reason === "too-large"
            ? "receipt-too-large"
            : "receipt-not-regular-file",
      keySha256,
    };
  }
  let receiptCandidate: unknown;
  try {
    receiptCandidate = JSON.parse(receiptFile.bytes.toString("utf8"));
  } catch {
    return { status: "invalid", reason: "receipt-malformed", keySha256 };
  }
  const parsedReceipt = receiptSchema.safeParse(receiptCandidate);
  if (!parsedReceipt.success) {
    return { status: "invalid", reason: "receipt-malformed", keySha256 };
  }
  const receipt = parsedReceipt.data;
  const receiptPayload = receiptPayloadSchema.parse({
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    key: receipt.key,
    keySha256: receipt.keySha256,
    snapshot: receipt.snapshot,
    snapshotSha256: receipt.snapshotSha256,
  });
  const observedReceiptSha256 = sha256(canonicalJson(receiptPayload));
  if (observedReceiptSha256 !== receipt.integritySha256) {
    return {
      status: "invalid",
      reason: "receipt-integrity-mismatch",
      keySha256,
    };
  }
  if (
    receipt.integritySha256 !== pointer.receiptSha256 ||
    observedReceiptSha256 !== pointer.receiptSha256
  ) {
    return {
      status: "invalid",
      reason: "receipt-address-mismatch",
      keySha256,
    };
  }
  if (
    receipt.keySha256 !== keySha256 ||
    !sameCanonicalValue(receipt.key, parsedKey)
  ) {
    return {
      status: "invalid",
      reason: "receipt-key-mismatch",
      keySha256,
    };
  }
  const observedSnapshotSha256 = sha256(
    canonicalJson(receipt.snapshot),
  );
  if (observedSnapshotSha256 !== receipt.snapshotSha256) {
    return {
      status: "invalid",
      reason: "snapshot-integrity-mismatch",
      keySha256,
    };
  }
  if (receipt.snapshot.side !== parsedKey.side) {
    return {
      status: "invalid",
      reason: "snapshot-side-mismatch",
      keySha256,
    };
  }
  if (
    receipt.snapshot.reportedUnitCount !== parsedKey.expectedUnitCount
  ) {
    return {
      status: "invalid",
      reason: "snapshot-unit-count-mismatch",
      keySha256,
    };
  }
  return {
    status: "hit",
    snapshot: receipt.snapshot,
    keySha256,
    snapshotSha256: receipt.snapshotSha256,
    receiptSha256: receipt.integritySha256,
  };
}

async function writeAtomic(
  filename: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(filename);
  await ensurePrivateCacheDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function ensurePrivateCacheDirectory(
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "The Tessera semantic snapshot cache contains an unsafe directory boundary.",
    );
  }
  await chmod(directory, 0o700);
}

async function ensurePrivateCacheLayout(
  cacheDirectory: string,
): Promise<void> {
  for (const directory of [
    cacheDirectory,
    path.join(cacheDirectory, "v1"),
    path.join(cacheDirectory, "v1", "keys"),
    path.join(cacheDirectory, "v1", "receipts"),
  ]) {
    await ensurePrivateCacheDirectory(directory);
  }
}

export async function storeTesseraImportSemanticSnapshot(
  cacheDirectory: string,
  key: TesseraImportSemanticSnapshotCacheKey,
  snapshot: TesseraImportedArmySemanticSnapshot,
): Promise<{
  keySha256: string;
  snapshotSha256: string;
  receiptSha256: string;
}> {
  const parsedKey = cacheKeySchema.parse(key);
  assertDeterministicSavedListIdentity(parsedKey);
  const parsedSnapshot = importedArmySnapshotSchema.parse(snapshot);
  if (parsedSnapshot.side !== parsedKey.side) {
    throw new Error(
      "The Tessera semantic snapshot side does not match its cache key.",
    );
  }
  if (parsedSnapshot.reportedUnitCount !== parsedKey.expectedUnitCount) {
    throw new Error(
      "The Tessera semantic snapshot unit count does not match its cache key.",
    );
  }
  const keySha256 = semanticSnapshotCacheKeySha256(parsedKey);
  const snapshotSha256 = sha256(canonicalJson(parsedSnapshot));
  const receiptPayload = receiptPayloadSchema.parse({
    schemaVersion: 1,
    kind: "tessera-import-semantic-snapshot-receipt",
    key: parsedKey,
    keySha256,
    snapshot: parsedSnapshot,
    snapshotSha256,
  });
  const receiptSha256 = sha256(canonicalJson(receiptPayload));
  const receipt = receiptSchema.parse({
    ...receiptPayload,
    integritySha256: receiptSha256,
  });
  const pointerPayload = pointerPayloadSchema.parse({
    schemaVersion: 1,
    kind: "tessera-import-semantic-snapshot-pointer",
    keySha256,
    receiptSha256,
  });
  const pointer = pointerSchema.parse({
    ...pointerPayload,
    integritySha256: sha256(canonicalJson(pointerPayload)),
  });
  const paths = tesseraImportSemanticSnapshotCachePaths(
    cacheDirectory,
    parsedKey,
    receiptSha256,
  );
  if (!paths.receiptPath) {
    throw new Error("The Tessera semantic snapshot receipt path is missing.");
  }
  await ensurePrivateCacheLayout(cacheDirectory);
  await writeAtomic(paths.receiptPath, canonicalJson(receipt));
  await writeAtomic(paths.pointerPath, canonicalJson(pointer));
  return { keySha256, snapshotSha256, receiptSha256 };
}
