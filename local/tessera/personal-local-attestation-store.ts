import crypto from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { canonicalJson } from "../../lib/rosterpilot";
import { rosterPilotSupportDirectory } from "../agent/paths";
import {
  createPersonalLocalParityAttestationV1,
  evaluatePersonalLocalParityAttestationV1,
  type PersonalLocalParityAttestationContextV1,
  type PersonalLocalParityAttestationV1,
  type PersonalLocalParityEvaluationV1,
  type PersonalLocalParityRotationV1,
} from "./personal-local-attestation";
import {
  verifyTesseraParityCoveringSuiteV2,
  type TesseraParityCoveringSuiteV2,
} from "./provider-parity-covering-suite-v2";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MACHINE_BINDING_BYTES = 32;
const MAXIMUM_SEED_BYTES = 128;
const MAXIMUM_ROTATION_RECORD_BYTES = 128 * 1_024;
const MAXIMUM_ATTESTATION_BYTES = 512 * 1_024;
const MAXIMUM_COVERING_SUITE_BYTES = 4 * 1_024 * 1_024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MACHINE_BINDING_DOMAIN =
  "rosterpilot-personal-local-parity-machine-v1";

const CanonicalTimestampSchema = z.string().refine(
  (value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString() === value;
  },
  "Expected one canonical UTC ISO timestamp.",
);

const IdentifierSchema = z.string().min(1).max(256).refine(
  (value) => value === value.trim(),
  "Identifiers cannot have leading or trailing whitespace.",
);

const RotationSchema = z.object({
  rotationId: IdentifierSchema,
  mode: z.enum(["observe", "enforce"]),
  outcome: z.enum(["pass", "fail"]),
  exactReceiptSha256: z.string().regex(SHA256_PATTERN),
  coverageSuiteSha256: z.string().regex(SHA256_PATTERN),
  completedAt: CanonicalTimestampSchema,
}).strict();

const AttestationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal(
    "rosterpilot-personal-local-parity-attestation",
  ),
  scope: z.literal("single-user-single-machine"),
  machineIdSha256: z.string().regex(SHA256_PATTERN),
  providerIdentitySha256: z.string().regex(SHA256_PATTERN),
  bundleId: z.string().regex(SHA256_PATTERN),
  dataProviderMode: z.literal("local-source"),
  rotations: z.array(RotationSchema).length(4),
  createdAt: CanonicalTimestampSchema,
  attestationSha256: z.string().regex(SHA256_PATTERN),
}).strict();

const RotationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal(
    "rosterpilot-personal-local-parity-rotation-record",
  ),
  scope: z.literal("single-user-single-machine"),
  dataProviderMode: z.literal("local-source"),
  machineIdSha256: z.string().regex(SHA256_PATTERN),
  providerIdentitySha256: z.string().regex(SHA256_PATTERN),
  bundleId: z.string().regex(SHA256_PATTERN),
  rotation: RotationSchema,
  verification: z.object({
    status: z.literal("verified"),
    parityResultSha256: z.string().regex(SHA256_PATTERN),
    verifiedAt: CanonicalTimestampSchema,
  }).strict(),
  recordSha256: z.string().regex(SHA256_PATTERN),
}).strict();

export type PersonalLocalParityRotationRecordV1 = z.infer<
  typeof RotationRecordSchema
>;

export type PersonalLocalParityStorePathsV1 = {
  directory: string;
  machineBindingPath: string;
  attestationPath: string;
  coveringSuitesDirectory: string;
};

export type PersonalLocalParityStoredAttestationV1 = {
  attestation: PersonalLocalParityAttestationV1;
  machineIdSha256: string;
  path: string;
  coveringSuite: TesseraParityCoveringSuiteV2 | null;
  coveringSuitePath: string;
  coveringSuiteIssueCode:
    | "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISSING"
    | "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_INVALID"
    | "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISMATCH"
    | null;
};

export type PersonalLocalParityAttestationStoreStatusV1 = {
  present: boolean;
  selfVerified: boolean;
  machineBindingMatches: boolean;
  attestationPath: string;
  attestationSha256: string | null;
  providerIdentitySha256: string | null;
  bundleId: string | null;
  coverageSuiteSha256: string | null;
  coveringSuiteVerified: boolean;
  coveringSuitePath: string | null;
  coveringSuiteIssueCode: string | null;
  rotations: Array<{
    rotationId: string;
    mode: "observe" | "enforce";
    completedAt: string;
  }>;
};

export class PersonalLocalParityStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersonalLocalParityStoreError";
    this.code = code;
  }
}

function digest(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(value: unknown): string {
  return digest(canonicalJson(value));
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function privatePermissions(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function attestationCore(
  attestation: PersonalLocalParityAttestationV1,
): Omit<PersonalLocalParityAttestationV1, "attestationSha256"> {
  return Object.fromEntries(
    Object.entries(attestation).filter(
      ([field]) => field !== "attestationSha256",
    ),
  ) as Omit<PersonalLocalParityAttestationV1, "attestationSha256">;
}

function rotationRecordCore(
  record: PersonalLocalParityRotationRecordV1,
): Omit<PersonalLocalParityRotationRecordV1, "recordSha256"> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([field]) => field !== "recordSha256",
    ),
  ) as Omit<PersonalLocalParityRotationRecordV1, "recordSha256">;
}

function parseCanonicalJson<T>(input: {
  text: string;
  filename: string;
  schema: z.ZodType<T>;
  integrityField: "attestationSha256" | "recordSha256";
}): T {
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch (error) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_JSON_INVALID",
      `Personal local parity rejected "${input.filename}": invalid JSON.`,
      { cause: error },
    );
  }
  const parsed = input.schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_SCHEMA_INVALID",
      `Personal local parity rejected "${input.filename}": schema validation failed at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid artifact"}.`,
    );
  }
  const canonical = `${canonicalJson(parsed.data)}\n`;
  if (input.text !== canonical) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_ENCODING_INVALID",
      `Personal local parity rejected "${input.filename}": the file is not canonical JSON.`,
    );
  }
  const object = parsed.data as Record<string, unknown>;
  const retained = object[input.integrityField];
  const core = Object.fromEntries(
    Object.entries(object).filter(
      ([field]) => field !== input.integrityField,
    ),
  );
  if (
    typeof retained !== "string" ||
    canonicalDigest(core) !== retained
  ) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_INTEGRITY_INVALID",
      `Personal local parity rejected "${input.filename}": the self-hash does not match its canonical contents.`,
    );
  }
  return parsed.data;
}

type StoredCoveringSuiteResult = {
  coveringSuite: TesseraParityCoveringSuiteV2 | null;
  coveringSuitePath: string;
  coveringSuiteIssueCode:
    | "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISSING"
    | "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_INVALID"
    | "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISMATCH"
    | null;
};

function coveringSuitePath(
  paths: PersonalLocalParityStorePathsV1,
  suiteSha256: string,
): string {
  return path.join(
    paths.coveringSuitesDirectory,
    `${suiteSha256}.json`,
  );
}

function assertVerifiedCoveringSuite(
  suite: TesseraParityCoveringSuiteV2,
): void {
  let verified = false;
  try {
    verified = verifyTesseraParityCoveringSuiteV2(suite);
  } catch {
    verified = false;
  }
  if (
    !verified ||
    !SHA256_PATTERN.test(suite.suiteSha256)
  ) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_COVERING_SUITE_INVALID",
      "The personal parity covering suite is invalid or its self-hash is stale.",
    );
  }
}

function parseStoredCoveringSuite(input: {
  text: string;
  filename: string;
  expectedSuiteSha256: string;
}): TesseraParityCoveringSuiteV2 {
  let candidate: unknown;
  try {
    candidate = JSON.parse(input.text);
  } catch (error) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_COVERING_SUITE_INVALID",
      `Personal local parity rejected "${input.filename}": the retained covering suite is invalid JSON.`,
      { cause: error },
    );
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    input.text !== `${canonicalJson(candidate)}\n`
  ) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_COVERING_SUITE_INVALID",
      `Personal local parity rejected "${input.filename}": the retained covering suite is not canonical JSON.`,
    );
  }
  const suite = candidate as TesseraParityCoveringSuiteV2;
  assertVerifiedCoveringSuite(suite);
  if (suite.suiteSha256 !== input.expectedSuiteSha256) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_COVERING_SUITE_MISMATCH",
      `Personal local parity rejected "${input.filename}": the retained covering suite does not match its attested content address.`,
    );
  }
  return suite;
}

async function readPrivateRegularFile(
  filename: string,
  maximumBytes: number,
): Promise<string> {
  let handle;
  try {
    handle = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_PATH_UNSAFE",
        `Personal local parity rejected "${filename}": symbolic links are not allowed.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_PATH_UNSAFE",
        `Personal local parity rejected "${filename}": expected a regular file.`,
      );
    }
    if (!privatePermissions(metadata.mode)) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_PERMISSIONS_UNSAFE",
        `Personal local parity rejected "${filename}": group or world permissions are not allowed.`,
      );
    }
    if (metadata.size > maximumBytes) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_FILE_TOO_LARGE",
        `Personal local parity rejected "${filename}": the file exceeds ${maximumBytes} bytes.`,
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertPrivateDirectory(
  directory: string,
  create: boolean,
): Promise<boolean> {
  if (create) {
    try {
      const existing = await lstat(directory);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new PersonalLocalParityStoreError(
          "PERSONAL_LOCAL_PARITY_PATH_UNSAFE",
          `Personal local parity store "${directory}" is not a physical directory.`,
        );
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(directory, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      });
    }
  }
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (!create && errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_PATH_UNSAFE",
      `Personal local parity store "${directory}" is not a physical directory.`,
    );
  }
  if (create) {
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
    metadata = await lstat(directory);
  }
  if (!privatePermissions(metadata.mode)) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_PERMISSIONS_UNSAFE",
      `Personal local parity store "${directory}" permits group or world access.`,
    );
  }
  return true;
}

async function writeCanonicalJsonAtomic(input: {
  filename: string;
  value: unknown;
  overwrite?: boolean;
}): Promise<void> {
  const directory = path.dirname(input.filename);
  await assertPrivateDirectory(directory, true);
  if (await pathExists(input.filename)) {
    const metadata = await lstat(input.filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_PATH_UNSAFE",
        `Personal local parity refused the unsafe destination "${input.filename}".`,
      );
    }
    if (!input.overwrite) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_ALREADY_EXISTS",
        `Personal local parity destination already exists: ${input.filename}.`,
      );
    }
  }
  const temporary = `${input.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${canonicalJson(input.value)}\n`,
      { flag: "wx", mode: PRIVATE_FILE_MODE },
    );
    await rename(temporary, input.filename);
    await chmod(input.filename, PRIVATE_FILE_MODE);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function retainCoveringSuiteV2(input: {
  paths: PersonalLocalParityStorePathsV1;
  coveringSuite: TesseraParityCoveringSuiteV2;
}): Promise<string> {
  assertVerifiedCoveringSuite(input.coveringSuite);
  const filename = coveringSuitePath(
    input.paths,
    input.coveringSuite.suiteSha256,
  );
  await assertPrivateDirectory(
    input.paths.coveringSuitesDirectory,
    true,
  );
  if (await pathExists(filename)) {
    const text = await readPrivateRegularFile(
      filename,
      MAXIMUM_COVERING_SUITE_BYTES,
    );
    parseStoredCoveringSuite({
      text,
      filename,
      expectedSuiteSha256: input.coveringSuite.suiteSha256,
    });
    return filename;
  }
  await writeCanonicalJsonAtomic({
    filename,
    value: input.coveringSuite,
  });
  return filename;
}

async function readStoredCoveringSuiteV2(input: {
  paths: PersonalLocalParityStorePathsV1;
  expectedSuiteSha256: string;
}): Promise<StoredCoveringSuiteResult> {
  const filename = coveringSuitePath(
    input.paths,
    input.expectedSuiteSha256,
  );
  try {
    const directoryPresent = await assertPrivateDirectory(
      input.paths.coveringSuitesDirectory,
      false,
    );
    if (!directoryPresent || !(await pathExists(filename))) {
      return {
        coveringSuite: null,
        coveringSuitePath: filename,
        coveringSuiteIssueCode:
          "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISSING",
      };
    }
    const text = await readPrivateRegularFile(
      filename,
      MAXIMUM_COVERING_SUITE_BYTES,
    );
    return {
      coveringSuite: parseStoredCoveringSuite({
        text,
        filename,
        expectedSuiteSha256: input.expectedSuiteSha256,
      }),
      coveringSuitePath: filename,
      coveringSuiteIssueCode: null,
    };
  } catch (error) {
    const code = error instanceof PersonalLocalParityStoreError
      ? error.code
      : null;
    return {
      coveringSuite: null,
      coveringSuitePath: filename,
      coveringSuiteIssueCode:
        code === "PERSONAL_LOCAL_PARITY_COVERING_SUITE_MISMATCH"
          ? "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISMATCH"
          : "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_INVALID",
    };
  }
}

function orderedRecords(
  records: readonly PersonalLocalParityRotationRecordV1[],
): PersonalLocalParityRotationRecordV1[] {
  return [...records].sort(
    (left, right) =>
      Date.parse(left.rotation.completedAt) -
        Date.parse(right.rotation.completedAt) ||
      left.rotation.rotationId.localeCompare(right.rotation.rotationId),
  );
}

function assertRotationSet(
  records: readonly PersonalLocalParityRotationRecordV1[],
  machineIdSha256: string,
): {
  providerIdentitySha256: string;
  bundleId: string;
  coverageSuiteSha256: string;
  rotations: PersonalLocalParityRotationV1[];
  latestVerifiedAt: string;
} {
  if (records.length !== 4) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_FOUR_ROTATIONS_REQUIRED",
      "A personal local attestation requires exactly four verified rotation records.",
    );
  }
  const ordered = orderedRecords(records);
  const first = ordered[0];
  if (!first) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_FOUR_ROTATIONS_REQUIRED",
      "A personal local attestation requires exactly four verified rotation records.",
    );
  }
  const expectedModes = [
    "observe",
    "observe",
    "observe",
    "enforce",
  ] as const;
  const rotationIds = new Set<string>();
  const receiptIds = new Set<string>();
  const parityResultIds = new Set<string>();
  let previousCompletedAt = Number.NEGATIVE_INFINITY;
  for (const [index, record] of ordered.entries()) {
    const completedAt = Date.parse(record.rotation.completedAt);
    const verifiedAt = Date.parse(record.verification.verifiedAt);
    if (
      record.machineIdSha256 !== machineIdSha256 ||
      record.providerIdentitySha256 !== first.providerIdentitySha256 ||
      record.bundleId !== first.bundleId ||
      record.rotation.coverageSuiteSha256 !==
        first.rotation.coverageSuiteSha256
    ) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_BINDING_MISMATCH",
        "All four personal parity rotations must bind the same machine, provider, data bundle, and covering suite.",
      );
    }
    if (
      record.rotation.mode !== expectedModes[index] ||
      record.rotation.outcome !== "pass"
    ) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_SEQUENCE_INVALID",
        "Personal parity requires three chronological observe passes followed by one enforce pass.",
      );
    }
    if (
      completedAt <= previousCompletedAt ||
      verifiedAt < completedAt
    ) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_TIME_INVALID",
        "Personal parity rotations must have strictly increasing completion times and cannot be verified before completion.",
      );
    }
    if (
      rotationIds.has(record.rotation.rotationId) ||
      receiptIds.has(record.rotation.exactReceiptSha256) ||
      parityResultIds.has(record.verification.parityResultSha256)
    ) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_REPLAY_REJECTED",
        "Personal parity rotation, exact-receipt, and parity-result identities cannot be replayed.",
      );
    }
    rotationIds.add(record.rotation.rotationId);
    receiptIds.add(record.rotation.exactReceiptSha256);
    parityResultIds.add(record.verification.parityResultSha256);
    previousCompletedAt = completedAt;
  }
  return {
    providerIdentitySha256: first.providerIdentitySha256,
    bundleId: first.bundleId,
    coverageSuiteSha256: first.rotation.coverageSuiteSha256,
    rotations: ordered.map((record) => record.rotation),
    latestVerifiedAt: ordered.reduce(
      (latest, record) =>
        Date.parse(record.verification.verifiedAt) > Date.parse(latest)
          ? record.verification.verifiedAt
          : latest,
      first.verification.verifiedAt,
    ),
  };
}

export function personalLocalParityStorePathsV1(
  directory =
    process.env.ROSTERPILOT_PERSONAL_TESSERA_PARITY_DIRECTORY ??
      path.join(
        rosterPilotSupportDirectory(),
        "TesseraPersonalParity",
        "v1",
      ),
): PersonalLocalParityStorePathsV1 {
  const resolved = path.resolve(directory);
  return {
    directory: resolved,
    machineBindingPath: path.join(resolved, "machine-binding.key"),
    attestationPath: path.join(resolved, "attestation.json"),
    coveringSuitesDirectory: path.join(resolved, "covering-suites"),
  };
}

export async function personalLocalMachineIdSha256V1(input: {
  directory?: string;
  create?: boolean;
} = {}): Promise<string | null> {
  const paths = personalLocalParityStorePathsV1(input.directory);
  const directoryPresent = await assertPrivateDirectory(
    paths.directory,
    input.create === true,
  );
  if (!directoryPresent) return null;
  if (!(await pathExists(paths.machineBindingPath))) {
    if (!input.create) return null;
    const secret = crypto.randomBytes(MACHINE_BINDING_BYTES).toString("hex");
    try {
      await writeFile(paths.machineBindingPath, `${secret}\n`, {
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  const text = await readPrivateRegularFile(
    paths.machineBindingPath,
    MAXIMUM_SEED_BYTES,
  );
  if (!/^[0-9a-f]{64}\n$/.test(text)) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_MACHINE_BINDING_INVALID",
      "The private personal parity machine binding is malformed.",
    );
  }
  const secretBytes = Buffer.from(text.trim(), "hex");
  return digest(
    Buffer.concat([
      Buffer.from(`${MACHINE_BINDING_DOMAIN}\0`, "utf8"),
      secretBytes,
    ]),
  );
}

export function sealPersonalLocalParityRotationRecordV1(input: {
  machineIdSha256: string;
  providerIdentitySha256: string;
  bundleId: string;
  rotation: PersonalLocalParityRotationV1;
  parityResultSha256: string;
  verifiedAt?: string;
}): PersonalLocalParityRotationRecordV1 {
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const core = {
    schemaVersion: 1 as const,
    kind: "rosterpilot-personal-local-parity-rotation-record" as const,
    scope: "single-user-single-machine" as const,
    dataProviderMode: "local-source" as const,
    machineIdSha256: input.machineIdSha256,
    providerIdentitySha256: input.providerIdentitySha256,
    bundleId: input.bundleId,
    rotation: structuredClone(input.rotation),
    verification: {
      status: "verified" as const,
      parityResultSha256: input.parityResultSha256,
      verifiedAt,
    },
  };
  const record = RotationRecordSchema.parse({
    ...core,
    recordSha256: canonicalDigest(core),
  }) as PersonalLocalParityRotationRecordV1;
  if (
    Date.parse(record.verification.verifiedAt) <
      Date.parse(record.rotation.completedAt)
  ) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_TIME_INVALID",
      "A personal parity rotation cannot be verified before it completed.",
    );
  }
  return record;
}

export function verifyPersonalLocalParityRotationRecordV1(
  value: unknown,
): value is PersonalLocalParityRotationRecordV1 {
  const parsed = RotationRecordSchema.safeParse(value);
  if (!parsed.success) return false;
  const record = parsed.data as PersonalLocalParityRotationRecordV1;
  return canonicalDigest(rotationRecordCore(record)) === record.recordSha256 &&
    Date.parse(record.verification.verifiedAt) >=
      Date.parse(record.rotation.completedAt);
}

export async function writePersonalLocalParityRotationRecordV1(input: {
  record: PersonalLocalParityRotationRecordV1;
  filename: string;
  overwrite?: boolean;
}): Promise<string> {
  if (!verifyPersonalLocalParityRotationRecordV1(input.record)) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_ROTATION_INVALID",
      "The personal parity rotation record failed schema or integrity verification.",
    );
  }
  const filename = path.resolve(input.filename);
  await writeCanonicalJsonAtomic({
    filename,
    value: input.record,
    overwrite: input.overwrite,
  });
  return filename;
}

export async function readVerifiedPersonalLocalParityRotationRecordV1(
  filename: string,
): Promise<PersonalLocalParityRotationRecordV1> {
  const resolved = path.resolve(filename);
  const text = await readPrivateRegularFile(
    resolved,
    MAXIMUM_ROTATION_RECORD_BYTES,
  );
  const record = parseCanonicalJson({
    text,
    filename: resolved,
    schema: RotationRecordSchema,
    integrityField: "recordSha256",
  }) as PersonalLocalParityRotationRecordV1;
  if (
    Date.parse(record.verification.verifiedAt) <
      Date.parse(record.rotation.completedAt)
  ) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_TIME_INVALID",
      `Personal local parity rejected "${resolved}": verification predates completion.`,
    );
  }
  return record;
}

export async function createStoredPersonalLocalParityAttestationV1(input: {
  rotationRecordPaths: readonly string[];
  coveringSuite: TesseraParityCoveringSuiteV2;
  directory?: string;
  overwrite?: boolean;
  createdAt?: string;
  expectedBindings?: {
    providerIdentitySha256: string;
    bundleId: string;
    coverageSuiteSha256: string;
  };
}): Promise<{
  attestation: PersonalLocalParityAttestationV1;
  evaluation: PersonalLocalParityEvaluationV1;
  path: string;
  coveringSuitePath: string;
}> {
  if (input.rotationRecordPaths.length !== 4) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_FOUR_ROTATIONS_REQUIRED",
      "A personal local attestation requires exactly four --rotation records.",
    );
  }
  const paths = personalLocalParityStorePathsV1(input.directory);
  const machineIdSha256 = await personalLocalMachineIdSha256V1({
    directory: paths.directory,
    create: true,
  });
  if (!machineIdSha256) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_MACHINE_BINDING_MISSING",
      "The personal parity machine binding could not be initialized.",
    );
  }
  const records = await Promise.all(
    input.rotationRecordPaths.map(
      readVerifiedPersonalLocalParityRotationRecordV1,
    ),
  );
  const binding = assertRotationSet(records, machineIdSha256);
  assertVerifiedCoveringSuite(input.coveringSuite);
  if (
    binding.coverageSuiteSha256 !==
      input.coveringSuite.suiteSha256
  ) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_COVERING_SUITE_MISMATCH",
      "The verified rotations do not bind the supplied covering-suite artifact.",
    );
  }
  if (input.expectedBindings) {
    for (const [field, value] of Object.entries(
      input.expectedBindings,
    )) {
      if (!SHA256_PATTERN.test(value)) {
        throw new PersonalLocalParityStoreError(
          "PERSONAL_LOCAL_PARITY_CONTEXT_INVALID",
          `${field} must be one lowercase SHA-256 value.`,
        );
      }
    }
    if (
      binding.providerIdentitySha256 !==
        input.expectedBindings.providerIdentitySha256 ||
      binding.bundleId !== input.expectedBindings.bundleId ||
      binding.coverageSuiteSha256 !==
        input.expectedBindings.coverageSuiteSha256
    ) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_CURRENT_BINDING_MISMATCH",
        "The verified rotations do not match the current provider, data bundle, and covering suite.",
      );
    }
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (
    Date.parse(createdAt) < Date.parse(binding.latestVerifiedAt) ||
    new Date(Date.parse(createdAt)).toISOString() !== createdAt
  ) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_TIME_INVALID",
      "The attestation creation time must be canonical and cannot predate its verified rotations.",
    );
  }
  const attestation = AttestationSchema.parse(
    createPersonalLocalParityAttestationV1({
      machineIdSha256,
      providerIdentitySha256: binding.providerIdentitySha256,
      bundleId: binding.bundleId,
      rotations: binding.rotations,
      createdAt,
    }),
  ) as PersonalLocalParityAttestationV1;
  const evaluation = evaluatePersonalLocalParityAttestationV1({
    attestation,
    machineIdSha256,
    providerIdentitySha256: binding.providerIdentitySha256,
    bundleId: binding.bundleId,
    coverageSuiteSha256: binding.coverageSuiteSha256,
    coveringSuite: input.coveringSuite,
  });
  if (!evaluation.active) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_ATTESTATION_INACTIVE",
      `The candidate personal attestation failed closed: ${evaluation.reasonCodes.join(", ")}.`,
    );
  }
  const retainedCoveringSuitePath = await retainCoveringSuiteV2({
    paths,
    coveringSuite: input.coveringSuite,
  });
  await writeCanonicalJsonAtomic({
    filename: paths.attestationPath,
    value: attestation,
    overwrite: input.overwrite,
  });
  return {
    attestation,
    evaluation,
    path: paths.attestationPath,
    coveringSuitePath: retainedCoveringSuitePath,
  };
}

export async function readStoredPersonalLocalParityAttestationV1(input: {
  directory?: string;
} = {}): Promise<PersonalLocalParityStoredAttestationV1 | null> {
  const paths = personalLocalParityStorePathsV1(input.directory);
  const directoryPresent = await assertPrivateDirectory(
    paths.directory,
    false,
  );
  if (!directoryPresent) return null;
  const hasAttestation = await pathExists(paths.attestationPath);
  const machineIdSha256 = await personalLocalMachineIdSha256V1({
    directory: paths.directory,
    create: false,
  });
  if (!hasAttestation && !machineIdSha256) return null;
  if (!hasAttestation || !machineIdSha256) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_STORE_INCOMPLETE",
      "The personal parity store contains only one half of its machine binding and attestation.",
    );
  }
  const text = await readPrivateRegularFile(
    paths.attestationPath,
    MAXIMUM_ATTESTATION_BYTES,
  );
  const attestation = parseCanonicalJson({
    text,
    filename: paths.attestationPath,
    schema: AttestationSchema,
    integrityField: "attestationSha256",
  }) as PersonalLocalParityAttestationV1;
  const coverageSuiteSha256 =
    attestation.rotations[0]?.coverageSuiteSha256;
  if (!coverageSuiteSha256) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_ATTESTATION_INVALID",
      "The stored personal parity attestation has no covering-suite binding.",
    );
  }
  const retainedCoveringSuite = await readStoredCoveringSuiteV2({
    paths,
    expectedSuiteSha256: coverageSuiteSha256,
  });
  const intrinsicEvaluation =
    evaluatePersonalLocalParityAttestationV1({
      attestation,
      machineIdSha256: attestation.machineIdSha256,
      providerIdentitySha256:
        attestation.providerIdentitySha256,
      bundleId: attestation.bundleId,
      coverageSuiteSha256,
      coveringSuite: retainedCoveringSuite.coveringSuite,
      coveringSuiteIssueCode:
        retainedCoveringSuite.coveringSuiteIssueCode,
    });
  const nonSuiteReasonCodes = intrinsicEvaluation.reasonCodes.filter(
    (reasonCode) =>
      !reasonCode.startsWith(
        "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_",
      ),
  );
  const receiptIdentities = new Set(
    attestation.rotations.map(
      (rotation) => rotation.exactReceiptSha256,
    ),
  );
  const lastCompletedAt = Date.parse(
    attestation.rotations.at(-1)?.completedAt ?? "",
  );
  if (
    nonSuiteReasonCodes.length > 0 ||
    receiptIdentities.size !== attestation.rotations.length ||
    Date.parse(attestation.createdAt) < lastCompletedAt
  ) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_ATTESTATION_INVALID",
      "The stored personal parity attestation is self-hashed but its rotation sequence or retained bindings are not valid.",
    );
  }
  return {
    attestation,
    machineIdSha256,
    path: paths.attestationPath,
    ...retainedCoveringSuite,
  };
}

export async function loadPersonalLocalParityAttestationContextV1(input: {
  providerIdentitySha256: string;
  bundleId: string;
  coverageSuiteSha256: string;
  directory?: string;
}): Promise<PersonalLocalParityAttestationContextV1 | null> {
  for (const [field, value] of Object.entries({
    providerIdentitySha256: input.providerIdentitySha256,
    bundleId: input.bundleId,
    coverageSuiteSha256: input.coverageSuiteSha256,
  })) {
    if (!SHA256_PATTERN.test(value)) {
      throw new PersonalLocalParityStoreError(
        "PERSONAL_LOCAL_PARITY_CONTEXT_INVALID",
        `${field} must be one lowercase SHA-256 value.`,
      );
    }
  }
  const stored = await readStoredPersonalLocalParityAttestationV1({
    directory: input.directory,
  });
  if (!stored) return null;
  return {
    attestation: stored.attestation,
    machineIdSha256: stored.machineIdSha256,
    providerIdentitySha256: input.providerIdentitySha256,
    bundleId: input.bundleId,
    coverageSuiteSha256: input.coverageSuiteSha256,
    coveringSuite: stored.coveringSuite,
    coveringSuiteIssueCode: stored.coveringSuiteIssueCode,
  };
}

/**
 * Loads the machine-local attestation against the caller's current provider
 * and bundle while retaining the covering-suite identity sealed into it.
 */
export async function loadCurrentPersonalLocalParityAttestationContextV1(
  input: {
    providerIdentitySha256: string;
    bundleId: string;
    directory?: string;
  },
): Promise<PersonalLocalParityAttestationContextV1 | null> {
  const stored = await readStoredPersonalLocalParityAttestationV1({
    directory: input.directory,
  });
  if (!stored) return null;
  const coverageSuiteSha256 =
    stored.attestation.rotations[0]?.coverageSuiteSha256;
  if (!coverageSuiteSha256) {
    throw new PersonalLocalParityStoreError(
      "PERSONAL_LOCAL_PARITY_ATTESTATION_INVALID",
      "The stored personal parity attestation has no covering-suite binding.",
    );
  }
  return {
    attestation: stored.attestation,
    machineIdSha256: stored.machineIdSha256,
    providerIdentitySha256: input.providerIdentitySha256,
    bundleId: input.bundleId,
    coverageSuiteSha256,
    coveringSuite: stored.coveringSuite,
    coveringSuiteIssueCode: stored.coveringSuiteIssueCode,
  };
}

export async function inspectPersonalLocalParityAttestationStoreV1(input: {
  directory?: string;
} = {}): Promise<PersonalLocalParityAttestationStoreStatusV1> {
  const paths = personalLocalParityStorePathsV1(input.directory);
  const stored = await readStoredPersonalLocalParityAttestationV1(input);
  if (!stored) {
    return {
      present: false,
      selfVerified: false,
      machineBindingMatches: false,
      attestationPath: paths.attestationPath,
      attestationSha256: null,
      providerIdentitySha256: null,
      bundleId: null,
      coverageSuiteSha256: null,
      coveringSuiteVerified: false,
      coveringSuitePath: null,
      coveringSuiteIssueCode: null,
      rotations: [],
    };
  }
  const coverageSuiteSha256 =
    stored.attestation.rotations[0]?.coverageSuiteSha256 ?? null;
  const evaluation = coverageSuiteSha256
    ? evaluatePersonalLocalParityAttestationV1({
        attestation: stored.attestation,
        machineIdSha256: stored.machineIdSha256,
        providerIdentitySha256:
          stored.attestation.providerIdentitySha256,
        bundleId: stored.attestation.bundleId,
        coverageSuiteSha256,
        coveringSuite: stored.coveringSuite,
        coveringSuiteIssueCode: stored.coveringSuiteIssueCode,
      })
    : null;
  return {
    present: true,
    selfVerified:
      canonicalDigest(attestationCore(stored.attestation)) ===
      stored.attestation.attestationSha256,
    machineBindingMatches:
      evaluation?.reasonCodes.includes(
        "PERSONAL_LOCAL_ATTESTATION_MACHINE_MISMATCH",
      ) === false,
    attestationPath: stored.path,
    attestationSha256: stored.attestation.attestationSha256,
    providerIdentitySha256:
      stored.attestation.providerIdentitySha256,
    bundleId: stored.attestation.bundleId,
    coverageSuiteSha256,
    coveringSuiteVerified: stored.coveringSuite !== null,
    coveringSuitePath: stored.coveringSuitePath,
    coveringSuiteIssueCode: stored.coveringSuiteIssueCode,
    rotations: stored.attestation.rotations.map((rotation) => ({
      rotationId: rotation.rotationId,
      mode: rotation.mode,
      completedAt: rotation.completedAt,
    })),
  };
}
