import crypto from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  type ConnectorEvent,
  rosterExecutionFingerprint,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
  validateEnrichedRoszGameplayIdentity,
} from "../../lib/rosterpilot";
import { rosterPilotSupportDirectory } from "../agent/paths";
import { safeNewRecruitUiIdentity } from "./ui-identity";

type CacheReceiptV2 = {
  schemaVersion: 1 | 2;
  cacheKind: "new-recruit-enriched-roster";
  cacheKey: string;
  createdAt: string;
  executionFingerprint: string;
  sourceData: RosterDraftV1["sourceData"];
  rosterId: string;
  rosterName: string;
  uiIdentity?: string | null;
  listUrl: string | null;
  sourceRoszSha256: string;
  enrichedRoszSha256: string;
  enrichedSummary: EnrichedRoszSummary;
  connectorEvents?: ConnectorEvent[];
};

type CacheReceiptV3 = Omit<CacheReceiptV2, "schemaVersion"> & {
  schemaVersion: 3;
  integritySha256: string;
};

type CacheReceipt = CacheReceiptV2 | CacheReceiptV3;

type RunInventoryV1 = {
  schemaVersion: 1;
  inventoryKind: "new-recruit-remote-lists";
  entries: Array<{
    cacheKey: string;
    rosterName: string;
    listUrl: string;
    recordedAt: string;
  }>;
};

export type NewRecruitInventoryOutcome = "created" | "reused";

export type NewRecruitRunInventoryEntry = {
  eventId: string;
  runId: string;
  attemptId: string | null;
  cacheKey: string;
  executionFingerprint: string | null;
  rosterName: string;
  listUrl: string | null;
  recordedAt: string;
  outcome: NewRecruitInventoryOutcome;
  origin: ConnectorEvent["origin"];
  connectorEventId: string | null;
  contentSha256: string | null;
};

export type NewRecruitRunInventoryV2 = {
  schemaVersion: 2;
  inventoryKind: "new-recruit-remote-lists";
  entries: NewRecruitRunInventoryEntry[];
  integritySha256: string;
};

export type NewRecruitMutationOutcome =
  | "pending"
  | "created"
  | "reused"
  | "uncertain"
  | "not-created";

export type NewRecruitMutationAttempt = {
  attemptId: string;
  runId: string;
  outcome: NewRecruitMutationOutcome;
  startedAt: string;
  finalizedAt: string | null;
  expectedSourceRoszSha256: string | null;
  connectorEvent: ConnectorEvent | null;
  inventoryEventId: string | null;
  message: string | null;
};

export type NewRecruitCanonicalMutationReceipt = {
  schemaVersion: 1;
  receiptKind: "new-recruit-mutation-receipt";
  cacheKey: string;
  executionFingerprint: string;
  sourceData: RosterDraftV1["sourceData"];
  rosterId: string;
  rosterName: string;
  createdAt: string;
  updatedAt: string;
  attempts: NewRecruitMutationAttempt[];
  integritySha256: string;
};

export type NewRecruitRoszMutationSubject = {
  schemaVersion: 1;
  subjectKind: "uploaded-rosz";
  cacheKey: string;
  sourceRoszSha256: string;
  rosterName: string;
};

export type NewRecruitRoszMutationReceipt = {
  schemaVersion: 2;
  receiptKind: "new-recruit-mutation-receipt";
  subjectKind: "uploaded-rosz";
  cacheKey: string;
  executionFingerprint: null;
  sourceData: null;
  sourceRoszSha256: string;
  rosterId: string;
  rosterName: string;
  createdAt: string;
  updatedAt: string;
  attempts: NewRecruitMutationAttempt[];
  integritySha256: string;
};

export type NewRecruitMutationReceipt =
  | NewRecruitCanonicalMutationReceipt
  | NewRecruitRoszMutationReceipt;

export type NewRecruitMutationFinalization = {
  outcome: Exclude<NewRecruitMutationOutcome, "pending">;
  connectorEvent: ConnectorEvent | null;
  message: string;
};

export type NewRecruitMutationResolution = {
  outcome: "created" | "reused" | "not-created";
  connectorEvent: ConnectorEvent | null;
  message: string;
};

export type NewRecruitMutationTransaction = {
  cacheKey: string;
  attemptId: string;
  runId: string;
  observeConnectorEvidence: (
    event: ConnectorEvent,
  ) => Promise<NewRecruitMutationReceipt>;
  finalize: (
    finalization: NewRecruitMutationFinalization,
  ) => Promise<NewRecruitMutationReceipt>;
  finalizeDelivery: (
    delivery: ResultEnvelope<NewRecruitDelivery>,
  ) => Promise<NewRecruitMutationReceipt>;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256(filename: string): Promise<string> {
  return crypto
    .createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

function withoutIntegrity<T extends { integritySha256: string }>(
  value: T,
): Omit<T, "integritySha256"> {
  const unsealed = { ...value };
  delete (unsealed as Partial<T>).integritySha256;
  return unsealed;
}

function sealIntegrity<T extends object>(
  value: T,
): T & { integritySha256: string } {
  return {
    ...value,
    integritySha256: sha256Text(canonical(value)),
  };
}

function integrityMatches<T extends { integritySha256: string }>(
  value: T,
): boolean {
  return (
    /^[0-9a-f]{64}$/.test(value.integritySha256) &&
    value.integritySha256 ===
      sha256Text(canonical(withoutIntegrity(value)))
  );
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function isSha256(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}$/.test(value)
  );
}

function isNullableSha256(value: unknown): value is string | null {
  return value === null || isSha256(value);
}

function isConnectorEvent(value: unknown): value is ConnectorEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ConnectorEvent>;
  return (
    event.schemaVersion === 1 &&
    typeof event.eventId === "string" &&
    event.eventId.length > 0 &&
    isIsoDate(event.recordedAt) &&
    ["new-recruit", "tessera"].includes(String(event.provider)) &&
    ["prepare", "probe", "simulate"].includes(String(event.action)) &&
    [
      "new-remote",
      "persistent-cache",
      "manifest-reuse",
      "in-memory",
    ].includes(String(event.origin)) &&
    ["verified", "reused", "failed", "uncertain"].includes(
      String(event.outcome),
    ) &&
    (event.remoteId === null ||
      (typeof event.remoteId === "string" &&
        event.remoteId.length > 0)) &&
    isNullableSha256(event.contentSha256)
  );
}

function failClosed(
  code: string,
  message: string,
): Error & { code: string; retryable: false } {
  return Object.assign(new Error(message), {
    code,
    retryable: false as const,
  });
}

async function atomicWriteJson(
  filename: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filename), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(value, null, 2)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  await rename(temporary, filename);
}

export function newRecruitCacheKey(roster: RosterDraftV1): string {
  return crypto
    .createHash("sha256")
    .update(
      canonical({
        executionFingerprint: rosterExecutionFingerprint(roster),
        sourceData: roster.sourceData,
      }),
    )
    .digest("hex");
}

export function newRecruitRoszMutationSubject(input: {
  content: Uint8Array;
  rosterName: string;
}): NewRecruitRoszMutationSubject {
  const rosterName = input.rosterName.trim();
  if (!rosterName) {
    throw failClosed(
      "NEW_RECRUIT_ROSZ_SUBJECT_INVALID",
      "A roster name is required for an uploaded ROSZ mutation subject.",
    );
  }
  const sourceRoszSha256 = crypto
    .createHash("sha256")
    .update(input.content)
    .digest("hex");
  return {
    schemaVersion: 1,
    subjectKind: "uploaded-rosz",
    cacheKey: sha256Text(
      canonical({
        subjectKind: "uploaded-rosz",
        sourceRoszSha256,
      }),
    ),
    sourceRoszSha256,
    rosterName,
  };
}

function cacheRoot(): string {
  return path.join(
    rosterPilotSupportDirectory(),
    "cache",
    "new-recruit",
    "v1",
  );
}

function mutationReceiptRoot(): string {
  return path.join(cacheRoot(), "mutation-receipts");
}

function mutationReceiptPath(cacheKey: string): string {
  return path.join(mutationReceiptRoot(), `${cacheKey}.json`);
}

function mutationReceiptLockPath(cacheKey: string): string {
  return path.join(mutationReceiptRoot(), "locks", cacheKey);
}

function inventoryPath(): string {
  return path.join(
    rosterPilotSupportDirectory(),
    "new-recruit-run-inventory.json",
  );
}

function sourceDataHash(
  sourceData: RosterDraftV1["sourceData"],
): string {
  return sha256Text(canonical(sourceData));
}

function validMutationAttempt(
  value: unknown,
): value is NewRecruitMutationAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<NewRecruitMutationAttempt>;
  const outcome = attempt.outcome;
  const finalized =
    outcome !== undefined && outcome !== "pending";
  const structurallyValid =
    typeof attempt.attemptId === "string" &&
    attempt.attemptId.length > 0 &&
    typeof attempt.runId === "string" &&
    attempt.runId.trim().length > 0 &&
    [
      "pending",
      "created",
      "reused",
      "uncertain",
      "not-created",
    ].includes(String(outcome)) &&
    isIsoDate(attempt.startedAt) &&
    (attempt.finalizedAt === null ||
      isIsoDate(attempt.finalizedAt)) &&
    (finalized
      ? attempt.finalizedAt !== null
      : attempt.finalizedAt === null) &&
    isNullableSha256(attempt.expectedSourceRoszSha256) &&
    (attempt.connectorEvent === null ||
      isConnectorEvent(attempt.connectorEvent)) &&
    (attempt.inventoryEventId === null ||
      (typeof attempt.inventoryEventId === "string" &&
        attempt.inventoryEventId.length > 0)) &&
    (attempt.message === null ||
      typeof attempt.message === "string");
  if (!structurallyValid) return false;
  const event = attempt.connectorEvent;
  if (outcome === "pending") {
    return (
      (event == null ||
        (event.provider === "new-recruit" &&
          event.action === "prepare")) &&
      attempt.inventoryEventId === null &&
      attempt.message === null
    );
  }
  if (outcome === "created") {
    return (
      event?.provider === "new-recruit" &&
      event.action === "prepare" &&
      event.origin === "new-remote" &&
      event.outcome === "verified" &&
      attempt.inventoryEventId !== null &&
      Boolean(attempt.message?.trim())
    );
  }
  if (outcome === "reused") {
    return (
      event?.provider === "new-recruit" &&
      event.action === "prepare" &&
      ["verified", "reused"].includes(event.outcome) &&
      attempt.inventoryEventId !== null &&
      Boolean(attempt.message?.trim())
    );
  }
  if (outcome === "uncertain") {
    return (
      (!event || event.outcome === "uncertain") &&
      attempt.inventoryEventId === null &&
      Boolean(attempt.message?.trim())
    );
  }
  return (
    outcome === "not-created" &&
    (!event ||
      (event.origin !== "new-remote" &&
        event.outcome === "failed")) &&
    attempt.inventoryEventId === null &&
    Boolean(attempt.message?.trim())
  );
}

function validMutationReceipt(
  value: unknown,
): value is NewRecruitMutationReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<NewRecruitMutationReceipt>;
  const commonValid =
    receipt.receiptKind === "new-recruit-mutation-receipt" &&
    isSha256(receipt.cacheKey) &&
    typeof receipt.rosterId === "string" &&
    receipt.rosterId.length > 0 &&
    typeof receipt.rosterName === "string" &&
    receipt.rosterName.length > 0 &&
    isIsoDate(receipt.createdAt) &&
    isIsoDate(receipt.updatedAt) &&
    Array.isArray(receipt.attempts) &&
    receipt.attempts.every(validMutationAttempt) &&
    new Set(
      receipt.attempts.map((attempt) => attempt.attemptId),
    ).size === receipt.attempts.length &&
    typeof receipt.integritySha256 === "string" &&
    integrityMatches(receipt as NewRecruitMutationReceipt);
  if (!commonValid) return false;
  if (receipt.schemaVersion === 1) {
    const canonicalReceipt =
      receipt as Partial<NewRecruitCanonicalMutationReceipt>;
    return (
      isSha256(canonicalReceipt.executionFingerprint) &&
      Boolean(canonicalReceipt.sourceData) &&
      typeof canonicalReceipt.sourceData === "object"
    );
  }
  if (receipt.schemaVersion === 2) {
    const roszReceipt =
      receipt as Partial<NewRecruitRoszMutationReceipt>;
    return (
      roszReceipt.subjectKind === "uploaded-rosz" &&
      roszReceipt.executionFingerprint === null &&
      roszReceipt.sourceData === null &&
      isSha256(roszReceipt.sourceRoszSha256)
    );
  }
  return false;
}

function validInventoryEntry(
  value: unknown,
): value is NewRecruitRunInventoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<NewRecruitRunInventoryEntry>;
  return (
    typeof entry.eventId === "string" &&
    entry.eventId.length > 0 &&
    typeof entry.runId === "string" &&
    entry.runId.trim().length > 0 &&
    (entry.attemptId === null ||
      (typeof entry.attemptId === "string" &&
        entry.attemptId.length > 0)) &&
    isSha256(entry.cacheKey) &&
    (entry.executionFingerprint === null ||
      isSha256(entry.executionFingerprint)) &&
    typeof entry.rosterName === "string" &&
    entry.rosterName.length > 0 &&
    (entry.listUrl === null ||
      (typeof entry.listUrl === "string" &&
        entry.listUrl.length > 0)) &&
    isIsoDate(entry.recordedAt) &&
    ["created", "reused"].includes(String(entry.outcome)) &&
    [
      "new-remote",
      "persistent-cache",
      "manifest-reuse",
      "in-memory",
    ].includes(String(entry.origin)) &&
    (entry.connectorEventId === null ||
      (typeof entry.connectorEventId === "string" &&
        entry.connectorEventId.length > 0)) &&
    isNullableSha256(entry.contentSha256)
  );
}

function validLegacyInventory(
  value: unknown,
): value is RunInventoryV1 {
  if (!value || typeof value !== "object") return false;
  const inventory = value as Partial<RunInventoryV1>;
  return (
    inventory.schemaVersion === 1 &&
    inventory.inventoryKind === "new-recruit-remote-lists" &&
    Array.isArray(inventory.entries) &&
    inventory.entries.every(
      (entry) =>
        Boolean(entry) &&
        typeof entry.cacheKey === "string" &&
        isSha256(entry.cacheKey) &&
        typeof entry.rosterName === "string" &&
        entry.rosterName.length > 0 &&
        typeof entry.listUrl === "string" &&
        entry.listUrl.length > 0 &&
        isIsoDate(entry.recordedAt),
    )
  );
}

function validInventoryV2(
  value: unknown,
): value is NewRecruitRunInventoryV2 {
  if (!value || typeof value !== "object") return false;
  const inventory = value as Partial<NewRecruitRunInventoryV2>;
  return (
    inventory.schemaVersion === 2 &&
    inventory.inventoryKind === "new-recruit-remote-lists" &&
    Array.isArray(inventory.entries) &&
    inventory.entries.every(validInventoryEntry) &&
    typeof inventory.integritySha256 === "string" &&
    integrityMatches(inventory as NewRecruitRunInventoryV2)
  );
}

function migrateLegacyInventory(
  legacy: RunInventoryV1,
): NewRecruitRunInventoryV2 {
  const entries = legacy.entries.map((entry, index) => ({
    eventId: `legacy-${sha256Text(
      canonical({
        ...entry,
        index,
      }),
    )}`,
    runId: "legacy-unscoped",
    attemptId: null,
    cacheKey: entry.cacheKey,
    executionFingerprint: null,
    rosterName: entry.rosterName,
    listUrl: entry.listUrl,
    recordedAt: entry.recordedAt,
    outcome: "created" as const,
    origin: "new-remote" as const,
    connectorEventId: null,
    contentSha256: null,
  }));
  return sealIntegrity({
    schemaVersion: 2 as const,
    inventoryKind: "new-recruit-remote-lists" as const,
    entries,
  });
}

async function readInventoryFile(): Promise<NewRecruitRunInventoryV2> {
  const filename = inventoryPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return sealIntegrity({
        schemaVersion: 2 as const,
        inventoryKind:
          "new-recruit-remote-lists" as const,
        entries: [],
      });
    }
    throw failClosed(
      "NEW_RECRUIT_INVENTORY_INVALID",
      "The durable New Recruit inventory could not be read. No remote delivery was attempted.",
    );
  }
  if (validInventoryV2(parsed)) return parsed;
  if (validLegacyInventory(parsed)) {
    return migrateLegacyInventory(parsed);
  }
  throw failClosed(
    "NEW_RECRUIT_INVENTORY_INVALID",
    "The durable New Recruit inventory failed validation or its integrity seal changed. No remote delivery was attempted.",
  );
}

async function readMutationReceiptFile(
  filename: string,
): Promise<NewRecruitMutationReceipt | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw failClosed(
      "NEW_RECRUIT_MUTATION_RECEIPT_INVALID",
      "The durable New Recruit mutation receipt could not be read. Reconcile it before another delivery.",
    );
  }
  if (!validMutationReceipt(parsed)) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_RECEIPT_INVALID",
      "The durable New Recruit mutation receipt failed validation or its integrity seal changed. Reconcile it before another delivery.",
    );
  }
  return parsed;
}

function assertReceiptProvenance(
  receipt: NewRecruitMutationReceipt,
  roster: RosterDraftV1,
): asserts receipt is NewRecruitCanonicalMutationReceipt {
  const cacheKey = newRecruitCacheKey(roster);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.cacheKey !== cacheKey ||
    receipt.executionFingerprint !==
      rosterExecutionFingerprint(roster) ||
    sourceDataHash(receipt.sourceData) !==
      sourceDataHash(roster.sourceData)
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_PROVENANCE_MISMATCH",
      "The durable New Recruit mutation receipt does not match this roster execution fingerprint and pinned source data. No remote delivery was attempted.",
    );
  }
}

function assertRoszReceiptProvenance(
  receipt: NewRecruitMutationReceipt,
  subject: NewRecruitRoszMutationSubject,
): asserts receipt is NewRecruitRoszMutationReceipt {
  if (
    receipt.schemaVersion !== 2 ||
    receipt.subjectKind !== "uploaded-rosz" ||
    receipt.cacheKey !== subject.cacheKey ||
    receipt.sourceRoszSha256 !== subject.sourceRoszSha256 ||
    receipt.rosterName !== subject.rosterName
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_PROVENANCE_MISMATCH",
      "The durable New Recruit mutation receipt does not match this content-addressed uploaded ROSZ. No remote delivery was attempted.",
    );
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPERM",
    );
  }
}

async function recoverAbandonedLease(
  directory: string,
  staleOwnerGraceMs: number,
): Promise<boolean> {
  let owner:
    | {
        pid?: number;
        token?: string;
        acquiredAt?: string;
      }
    | null = null;
  try {
    owner = JSON.parse(
      await readFile(path.join(directory, "owner.json"), "utf8"),
    ) as {
      pid?: number;
      token?: string;
      acquiredAt?: string;
    };
  } catch {
    // A creator may be between mkdir and owner.json. Only reclaim the
    // directory after a short grace period.
  }
  const directoryAgeMs = await stat(directory)
    .then((value) => Date.now() - value.mtimeMs)
    .catch(() => 0);
  const ownerIsValid =
    owner &&
    typeof owner.token === "string" &&
    owner.token.length > 0 &&
    typeof owner.pid === "number";
  if (
    (ownerIsValid && processIsAlive(owner!.pid!)) ||
    (!ownerIsValid && directoryAgeMs < staleOwnerGraceMs)
  ) {
    return false;
  }
  const quarantine =
    `${directory}.abandoned-${crypto.randomUUID()}`;
  try {
    await rename(directory, quarantine);
  } catch {
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

export async function acquireDirectoryLease(
  directory: string,
  timeoutMs = 30_000,
  staleOwnerGraceMs = 5_000,
): Promise<() => Promise<void>> {
  await mkdir(path.dirname(directory), {
    recursive: true,
    mode: 0o700,
  });
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();
  while (true) {
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        path.join(directory, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
        })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return async () => {
        try {
          const owner = JSON.parse(
            await readFile(
              path.join(directory, "owner.json"),
              "utf8",
            ),
          ) as { token?: string };
          if (owner.token !== token) return;
          await rm(directory, { recursive: true, force: true });
        } catch {
          // The lease was already released or recovered.
        }
      };
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        )
      ) {
        throw error;
      }
      if (
        await recoverAbandonedLease(
          directory,
          staleOwnerGraceMs,
        )
      ) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error(
            "Timed out waiting for the New Recruit cache lease.",
          ),
          { code: "NEW_RECRUIT_CACHE_LOCKED" },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function acquireNewRecruitCacheLease(
  roster: RosterDraftV1,
): Promise<() => Promise<void>> {
  return acquireDirectoryLease(
    path.join(cacheRoot(), "locks", newRecruitCacheKey(roster)),
  );
}

async function appendInventoryEntry(
  entry: NewRecruitRunInventoryEntry,
): Promise<void> {
  if (!validInventoryEntry(entry)) {
    throw failClosed(
      "NEW_RECRUIT_INVENTORY_EVENT_INVALID",
      "A New Recruit inventory event was invalid and was not persisted.",
    );
  }
  const filename = inventoryPath();
  const release = await acquireDirectoryLease(`${filename}.lock`);
  try {
    const inventory = await readInventoryFile();
    if (
      inventory.entries.some(
        (candidate) => candidate.eventId === entry.eventId,
      )
    ) {
      const existing = inventory.entries.find(
        (candidate) => candidate.eventId === entry.eventId,
      );
      const matchesAuthoritativeAttempt =
        entry.attemptId === null &&
        Boolean(existing?.attemptId) &&
        canonical({
          ...existing,
          attemptId: null,
        }) === canonical(entry);
      if (
        canonical(existing) !== canonical(entry) &&
        !matchesAuthoritativeAttempt
      ) {
        throw failClosed(
          "NEW_RECRUIT_INVENTORY_EVENT_CONFLICT",
          "A New Recruit inventory event ID already exists with different provenance. No remote delivery was attempted.",
        );
      }
      return;
    }
    const next = sealIntegrity({
      schemaVersion: 2 as const,
      inventoryKind: "new-recruit-remote-lists" as const,
      entries: [...inventory.entries, entry],
    });
    await atomicWriteJson(filename, next);
  } finally {
    await release();
  }
}

function inventoryEntryForAttempt(
  receipt: NewRecruitMutationReceipt,
  attempt: NewRecruitMutationAttempt,
): NewRecruitRunInventoryEntry | null {
  if (
    (attempt.outcome !== "created" &&
      attempt.outcome !== "reused") ||
    !attempt.connectorEvent ||
    !attempt.inventoryEventId
  ) {
    return null;
  }
  return {
    eventId: attempt.inventoryEventId,
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    cacheKey: receipt.cacheKey,
    executionFingerprint: receipt.executionFingerprint,
    rosterName: receipt.rosterName,
    listUrl: attempt.connectorEvent.remoteId,
    recordedAt: attempt.connectorEvent.recordedAt,
    outcome: attempt.outcome,
    origin: attempt.connectorEvent.origin,
    connectorEventId: attempt.connectorEvent.eventId,
    contentSha256: attempt.connectorEvent.contentSha256,
  };
}

async function ensureFinalizedInventory(
  receipt: NewRecruitMutationReceipt,
): Promise<void> {
  for (const attempt of receipt.attempts) {
    const entry = inventoryEntryForAttempt(receipt, attempt);
    if (entry) await appendInventoryEntry(entry);
  }
}

export async function readNewRecruitRunInventory(): Promise<
  NewRecruitRunInventoryV2
> {
  return readInventoryFile();
}

export async function readNewRecruitMutationReceipt(
  roster: RosterDraftV1,
): Promise<NewRecruitMutationReceipt | null> {
  const receipt = await readMutationReceiptFile(
    mutationReceiptPath(newRecruitCacheKey(roster)),
  );
  if (!receipt) return null;
  assertReceiptProvenance(receipt, roster);
  await ensureFinalizedInventory(receipt);
  return receipt;
}

export async function readNewRecruitRoszMutationReceipt(
  subject: NewRecruitRoszMutationSubject,
): Promise<NewRecruitRoszMutationReceipt | null> {
  const receipt = await readMutationReceiptFile(
    mutationReceiptPath(subject.cacheKey),
  );
  if (!receipt) return null;
  assertRoszReceiptProvenance(receipt, subject);
  await ensureFinalizedInventory(receipt);
  return receipt;
}

function newMutationReceipt(
  roster: RosterDraftV1,
): NewRecruitCanonicalMutationReceipt {
  const now = new Date().toISOString();
  return sealIntegrity({
    schemaVersion: 1 as const,
    receiptKind: "new-recruit-mutation-receipt" as const,
    cacheKey: newRecruitCacheKey(roster),
    executionFingerprint: rosterExecutionFingerprint(roster),
    sourceData: structuredClone(roster.sourceData),
    rosterId: roster.id,
    rosterName: roster.name,
    createdAt: now,
    updatedAt: now,
    attempts: [],
  });
}

function newRoszMutationReceipt(
  subject: NewRecruitRoszMutationSubject,
): NewRecruitRoszMutationReceipt {
  const now = new Date().toISOString();
  return sealIntegrity({
    schemaVersion: 2 as const,
    receiptKind: "new-recruit-mutation-receipt" as const,
    subjectKind: "uploaded-rosz" as const,
    cacheKey: subject.cacheKey,
    executionFingerprint: null,
    sourceData: null,
    sourceRoszSha256: subject.sourceRoszSha256,
    rosterId: `uploaded-rosz:${subject.sourceRoszSha256}`,
    rosterName: subject.rosterName,
    createdAt: now,
    updatedAt: now,
    attempts: [],
  });
}

function resealMutationReceipt(
  receipt: NewRecruitMutationReceipt,
): NewRecruitMutationReceipt {
  if (receipt.schemaVersion === 1) {
    return sealIntegrity({
      ...withoutIntegrity(receipt),
      updatedAt: new Date().toISOString(),
    });
  }
  return sealIntegrity({
    ...withoutIntegrity(receipt),
    updatedAt: new Date().toISOString(),
  });
}

function prepareEvent(
  delivery: ResultEnvelope<NewRecruitDelivery>,
): ConnectorEvent | null {
  return (
    delivery.data?.connectorEvents
      ?.filter(
        (event) =>
          event.provider === "new-recruit" &&
          event.action === "prepare",
      )
      .at(-1) ?? null
  );
}

export function classifyNewRecruitMutationDelivery(
  delivery: ResultEnvelope<NewRecruitDelivery>,
): NewRecruitMutationFinalization {
  const event = prepareEvent(delivery);
  const messages = delivery.violations
    .map((violation) => violation.message)
    .join(" ");
  if (
    delivery.ok &&
    delivery.data &&
    event &&
    (delivery.data.cacheReused === true ||
      event.outcome === "reused" ||
      (delivery.data.imported === false &&
        event.outcome === "verified" &&
        event.origin !== "new-remote"))
  ) {
    return {
      outcome: "reused",
      connectorEvent:
        event.outcome === "reused"
          ? event
          : {
              ...event,
              outcome: "reused",
            },
      message:
        "New Recruit reused an existing verified roster artifact; no remote list was created.",
    };
  }
  if (
    delivery.ok &&
    delivery.data?.imported === true &&
    event?.origin === "new-remote" &&
    event.outcome === "verified"
  ) {
    return {
      outcome: "created",
      connectorEvent: event,
      message:
        "New Recruit created and verified a remote roster list.",
    };
  }
  if (
    !delivery.ok &&
    delivery.data?.imported !== true &&
    event?.outcome === "failed" &&
    event.origin !== "new-remote"
  ) {
    return {
      outcome: "not-created",
      connectorEvent: event,
      message:
        messages ||
        "New Recruit failed before any remote list could be created.",
    };
  }
  return {
    outcome: "uncertain",
    connectorEvent: event
      ? {
          ...event,
          outcome: "uncertain",
        }
      : null,
    message:
      messages ||
      "New Recruit did not provide enough evidence to prove whether a remote list was created.",
  };
}

function validateMutationFinalization(
  finalization: NewRecruitMutationFinalization,
): void {
  const event = finalization.connectorEvent;
  if (
    finalization.outcome === "created" &&
    (!event ||
      event.provider !== "new-recruit" ||
      event.action !== "prepare" ||
      event.origin !== "new-remote" ||
      event.outcome !== "verified")
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_FINALIZATION_INVALID",
      "A created outcome requires a verified new-remote New Recruit connector event.",
    );
  }
  if (
    finalization.outcome === "reused" &&
    (!event ||
      event.provider !== "new-recruit" ||
      event.action !== "prepare" ||
      !["verified", "reused"].includes(event.outcome))
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_FINALIZATION_INVALID",
      "A reused outcome requires a verified or reused New Recruit connector event.",
    );
  }
  if (
    finalization.outcome === "not-created" &&
    event &&
    (event.origin === "new-remote" ||
      event.outcome !== "failed")
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_FINALIZATION_INVALID",
      "A not-created outcome cannot be used when the connector may have mutated New Recruit.",
    );
  }
  if (
    finalization.outcome === "uncertain" &&
    event &&
    event.outcome !== "uncertain"
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_FINALIZATION_INVALID",
      "An uncertain outcome must retain an uncertain connector event.",
    );
  }
  if (
    event &&
    (event.provider !== "new-recruit" ||
      event.action !== "prepare" ||
      !isConnectorEvent(event))
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_FINALIZATION_INVALID",
      "The mutation finalization contains an invalid connector event.",
    );
  }
  if (!finalization.message.trim()) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_FINALIZATION_INVALID",
      "The mutation finalization must explain its outcome.",
    );
  }
}

function unresolvedAttempt(
  receipt: NewRecruitMutationReceipt,
): NewRecruitMutationAttempt | undefined {
  return receipt.attempts.find(
    (attempt) =>
      attempt.outcome === "pending" ||
      attempt.outcome === "uncertain",
  );
}

function createdAttempt(
  receipt: NewRecruitMutationReceipt,
): NewRecruitMutationAttempt | undefined {
  return receipt.attempts.find(
    (attempt) => attempt.outcome === "created",
  );
}

async function finalizeMutationAttempt(input: {
  filename: string;
  receipt: NewRecruitMutationReceipt;
  attemptId: string;
  finalization: NewRecruitMutationFinalization;
}): Promise<NewRecruitMutationReceipt> {
  validateMutationFinalization(input.finalization);
  const attempt = input.receipt.attempts.find(
    (candidate) => candidate.attemptId === input.attemptId,
  );
  if (!attempt) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ATTEMPT_MISSING",
      "The New Recruit mutation attempt is missing from its durable receipt.",
    );
  }
  if (attempt.outcome !== "pending") {
    if (
      attempt.outcome === input.finalization.outcome &&
      canonical(attempt.connectorEvent) ===
        canonical(input.finalization.connectorEvent)
    ) {
      await ensureFinalizedInventory(input.receipt);
      return input.receipt;
    }
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ALREADY_FINALIZED",
      "The New Recruit mutation attempt was already finalized with a different outcome.",
    );
  }
  const finalizedAt = new Date().toISOString();
  attempt.outcome = input.finalization.outcome;
  attempt.finalizedAt = finalizedAt;
  attempt.connectorEvent = input.finalization.connectorEvent;
  attempt.message = input.finalization.message;
  attempt.inventoryEventId =
    input.finalization.outcome === "created" ||
    input.finalization.outcome === "reused"
      ? `new-recruit-${input.finalization.connectorEvent!.eventId}`
      : null;
  const sealed = resealMutationReceipt(input.receipt);
  // The finalized receipt is authoritative. If inventory persistence is
  // interrupted, the next read/resume backfills the exact event by ID.
  await atomicWriteJson(input.filename, sealed);
  await ensureFinalizedInventory(sealed);
  return sealed;
}

async function observeMutationConnectorEvidence(input: {
  filename: string;
  receipt: NewRecruitMutationReceipt;
  attemptId: string;
  event: ConnectorEvent;
}): Promise<NewRecruitMutationReceipt> {
  if (
    !isConnectorEvent(input.event) ||
    input.event.provider !== "new-recruit" ||
    input.event.action !== "prepare"
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_EVIDENCE_INVALID",
      "Only a valid New Recruit prepare event can be attached to a pending mutation receipt.",
    );
  }
  const attempt = input.receipt.attempts.find(
    (candidate) => candidate.attemptId === input.attemptId,
  );
  if (!attempt) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ATTEMPT_MISSING",
      "The New Recruit mutation attempt is missing from its durable receipt.",
    );
  }
  if (attempt.outcome !== "pending") {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ALREADY_FINALIZED",
      "Connector evidence cannot be attached after a New Recruit mutation attempt is finalized.",
    );
  }
  if (attempt.connectorEvent) {
    if (canonical(attempt.connectorEvent) === canonical(input.event)) {
      return input.receipt;
    }
    throw failClosed(
      "NEW_RECRUIT_MUTATION_EVIDENCE_CONFLICT",
      "The pending New Recruit mutation receipt already contains different connector evidence.",
    );
  }
  attempt.connectorEvent = input.event;
  const sealed = resealMutationReceipt(input.receipt);
  await atomicWriteJson(input.filename, sealed);
  return sealed;
}

type MutationReceiptDescriptor = {
  cacheKey: string;
  rosterName: string;
  expectedSourceRoszSha256: string | null;
  create: () => NewRecruitMutationReceipt;
  assert: (receipt: NewRecruitMutationReceipt) => void;
};

async function beginMutationReceipt(input: {
  descriptor: MutationReceiptDescriptor;
  runId: string;
}): Promise<NewRecruitMutationTransaction> {
  if (!input.runId.trim()) {
    throw failClosed(
      "NEW_RECRUIT_RUN_ID_REQUIRED",
      "A durable run ID is required before New Recruit browser activity.",
    );
  }
  if (
    !isNullableSha256(
      input.descriptor.expectedSourceRoszSha256,
    )
  ) {
    throw failClosed(
      "NEW_RECRUIT_SOURCE_HASH_INVALID",
      "The expected source ROSZ hash must be a SHA-256 value.",
    );
  }
  const cacheKey = input.descriptor.cacheKey;
  const filename = mutationReceiptPath(cacheKey);
  const release = await acquireDirectoryLease(
    mutationReceiptLockPath(cacheKey),
  );
  let released = false;
  const releaseOnce = async (): Promise<void> => {
    if (released) return;
    released = true;
    await release();
  };
  try {
    await readInventoryFile();
    let receipt =
      (await readMutationReceiptFile(filename)) ??
      input.descriptor.create();
    input.descriptor.assert(receipt);
    await ensureFinalizedInventory(receipt);
    const unresolved = unresolvedAttempt(receipt);
    if (unresolved) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_RECONCILIATION_REQUIRED",
        `New Recruit attempt ${unresolved.attemptId} from run ${unresolved.runId} is ${unresolved.outcome}. Reconcile it before another delivery for ${input.descriptor.rosterName}.`,
      );
    }
    const created = createdAttempt(receipt);
    if (created) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_ALREADY_CREATED",
        `Run ${created.runId} already recorded a created New Recruit list for this exact mutation subject, but its verified artifact was not reused. Reconcile or restore the prepared artifact instead of creating a duplicate.`,
      );
    }
    const now = new Date().toISOString();
    const attempt: NewRecruitMutationAttempt = {
      attemptId: crypto.randomUUID(),
      runId: input.runId.trim(),
      outcome: "pending",
      startedAt: now,
      finalizedAt: null,
      expectedSourceRoszSha256:
        input.descriptor.expectedSourceRoszSha256,
      connectorEvent: null,
      inventoryEventId: null,
      message: null,
    };
    receipt = resealMutationReceipt({
      ...receipt,
      attempts: [...receipt.attempts, attempt],
    } as NewRecruitMutationReceipt);
    await atomicWriteJson(filename, receipt);
    let finalized = false;
    const currentReceipt =
      async (): Promise<NewRecruitMutationReceipt> => {
        const current = await readMutationReceiptFile(filename);
        if (!current) {
          throw failClosed(
            "NEW_RECRUIT_MUTATION_RECEIPT_MISSING",
            "The durable New Recruit mutation receipt disappeared before finalization.",
          );
        }
        input.descriptor.assert(current);
        return current;
      };
    const finalize = async (
      finalization: NewRecruitMutationFinalization,
    ): Promise<NewRecruitMutationReceipt> => {
      if (finalized) {
        throw failClosed(
          "NEW_RECRUIT_MUTATION_ALREADY_FINALIZED",
          "The New Recruit mutation transaction was already finalized.",
        );
      }
      try {
        const result = await finalizeMutationAttempt({
          filename,
          receipt: await currentReceipt(),
          attemptId: attempt.attemptId,
          finalization,
        });
        finalized = true;
        return result;
      } finally {
        await releaseOnce();
      }
    };
    return {
      cacheKey,
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      observeConnectorEvidence: async (event) => {
        if (finalized) {
          throw failClosed(
            "NEW_RECRUIT_MUTATION_ALREADY_FINALIZED",
            "The New Recruit mutation transaction was already finalized.",
          );
        }
        return observeMutationConnectorEvidence({
          filename,
          receipt: await currentReceipt(),
          attemptId: attempt.attemptId,
          event,
        });
      },
      finalize,
      finalizeDelivery: (delivery) =>
        finalize(classifyNewRecruitMutationDelivery(delivery)),
    };
  } catch (error) {
    await releaseOnce();
    throw error;
  }
}

export async function beginNewRecruitMutationReceipt(input: {
  roster: RosterDraftV1;
  runId: string;
  expectedSourceRoszSha256?: string | null;
}): Promise<NewRecruitMutationTransaction> {
  if (
    input.expectedSourceRoszSha256 !== undefined &&
    !isNullableSha256(input.expectedSourceRoszSha256)
  ) {
    throw failClosed(
      "NEW_RECRUIT_SOURCE_HASH_INVALID",
      "The expected source ROSZ hash must be a SHA-256 value.",
    );
  }
  return beginMutationReceipt({
    runId: input.runId,
    descriptor: {
      cacheKey: newRecruitCacheKey(input.roster),
      rosterName: input.roster.name,
      expectedSourceRoszSha256:
        input.expectedSourceRoszSha256 ?? null,
      create: () => newMutationReceipt(input.roster),
      assert: (receipt) =>
        assertReceiptProvenance(receipt, input.roster),
    },
  });
}

export async function beginNewRecruitRoszMutationReceipt(input: {
  subject: NewRecruitRoszMutationSubject;
  runId: string;
}): Promise<NewRecruitMutationTransaction> {
  return beginMutationReceipt({
    runId: input.runId,
    descriptor: {
      cacheKey: input.subject.cacheKey,
      rosterName: input.subject.rosterName,
      expectedSourceRoszSha256:
        input.subject.sourceRoszSha256,
      create: () => newRoszMutationReceipt(input.subject),
      assert: (receipt) =>
        assertRoszReceiptProvenance(receipt, input.subject),
    },
  });
}

async function reconcileMutationReceipt(input: {
  descriptor: Pick<
    MutationReceiptDescriptor,
    "cacheKey" | "rosterName" | "assert"
  >;
  runId: string;
  attemptId?: string;
  resolution: NewRecruitMutationResolution;
}): Promise<NewRecruitMutationReceipt> {
  if (!input.runId.trim()) {
    throw failClosed(
      "NEW_RECRUIT_RUN_ID_REQUIRED",
      "The original durable run ID is required to reconcile a New Recruit mutation.",
    );
  }
  validateMutationFinalization(input.resolution);
  const cacheKey = input.descriptor.cacheKey;
  const filename = mutationReceiptPath(cacheKey);
  const release = await acquireDirectoryLease(
    mutationReceiptLockPath(cacheKey),
  );
  try {
    const receipt = await readMutationReceiptFile(filename);
    if (!receipt) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_RECEIPT_MISSING",
        `No durable New Recruit mutation receipt exists for ${input.descriptor.rosterName}.`,
      );
    }
    input.descriptor.assert(receipt);
    const attempt = [...receipt.attempts]
      .reverse()
      .find(
        (candidate) =>
          candidate.runId === input.runId.trim() &&
          (!input.attemptId ||
            candidate.attemptId === input.attemptId),
      );
    if (!attempt) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_ATTEMPT_MISSING",
        "No New Recruit mutation attempt matches the supplied run and attempt IDs.",
      );
    }
    if (
      attempt.outcome !== "pending" &&
      attempt.outcome !== "uncertain"
    ) {
      if (
        attempt.outcome === input.resolution.outcome &&
        canonical(attempt.connectorEvent) ===
          canonical(input.resolution.connectorEvent)
      ) {
        await ensureFinalizedInventory(receipt);
        return receipt;
      }
      throw failClosed(
        "NEW_RECRUIT_MUTATION_ALREADY_FINALIZED",
        "The selected New Recruit mutation attempt is already finalized.",
      );
    }
    attempt.outcome = "pending";
    attempt.finalizedAt = null;
    attempt.connectorEvent = null;
    attempt.inventoryEventId = null;
    attempt.message = null;
    return finalizeMutationAttempt({
      filename,
      receipt,
      attemptId: attempt.attemptId,
      finalization: input.resolution,
    });
  } finally {
    await release();
  }
}

export async function reconcileNewRecruitMutationReceipt(input: {
  roster: RosterDraftV1;
  runId: string;
  attemptId?: string;
  resolution: NewRecruitMutationResolution;
}): Promise<NewRecruitMutationReceipt> {
  return reconcileMutationReceipt({
    ...input,
    descriptor: {
      cacheKey: newRecruitCacheKey(input.roster),
      rosterName: input.roster.name,
      assert: (receipt) =>
        assertReceiptProvenance(receipt, input.roster),
    },
  });
}

export async function reconcileNewRecruitRoszMutationReceipt(input: {
  subject: NewRecruitRoszMutationSubject;
  runId: string;
  attemptId?: string;
  resolution: NewRecruitMutationResolution;
}): Promise<NewRecruitMutationReceipt> {
  return reconcileMutationReceipt({
    ...input,
    descriptor: {
      cacheKey: input.subject.cacheKey,
      rosterName: input.subject.rosterName,
      assert: (receipt) =>
        assertRoszReceiptProvenance(receipt, input.subject),
    },
  });
}

export async function recordNewRecruitReuseReceipt(input: {
  roster: RosterDraftV1;
  runId: string;
  delivery: ResultEnvelope<NewRecruitDelivery>;
}): Promise<NewRecruitMutationReceipt> {
  const finalization =
    classifyNewRecruitMutationDelivery(input.delivery);
  if (finalization.outcome !== "reused") {
    throw failClosed(
      "NEW_RECRUIT_REUSE_EVIDENCE_REQUIRED",
      "A reuse receipt requires a verified cache, manifest, or saved-list reuse delivery.",
    );
  }
  if (!input.runId.trim()) {
    throw failClosed(
      "NEW_RECRUIT_RUN_ID_REQUIRED",
      "A durable run ID is required when recording New Recruit reuse.",
    );
  }
  const cacheKey = newRecruitCacheKey(input.roster);
  const filename = mutationReceiptPath(cacheKey);
  const release = await acquireDirectoryLease(
    mutationReceiptLockPath(cacheKey),
  );
  try {
    let receipt =
      (await readMutationReceiptFile(filename)) ??
      newMutationReceipt(input.roster);
    assertReceiptProvenance(receipt, input.roster);
    const unresolved = unresolvedAttempt(receipt);
    if (unresolved) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_RECONCILIATION_REQUIRED",
        `New Recruit attempt ${unresolved.attemptId} from run ${unresolved.runId} is ${unresolved.outcome}. Reconcile it before recording another delivery outcome.`,
      );
    }
    const event = finalization.connectorEvent!;
    const existing = receipt.attempts.find(
      (attempt) =>
        attempt.connectorEvent?.eventId === event.eventId,
    );
    if (existing) {
      if (
        existing.runId !== input.runId.trim() ||
        existing.outcome !== "reused"
      ) {
        throw failClosed(
          "NEW_RECRUIT_MUTATION_EVENT_CONFLICT",
          "The New Recruit connector event was already recorded with different run provenance.",
        );
      }
      await ensureFinalizedInventory(receipt);
      return receipt;
    }
    const now = new Date().toISOString();
    const attempt: NewRecruitMutationAttempt = {
      attemptId: crypto.randomUUID(),
      runId: input.runId.trim(),
      outcome: "reused",
      startedAt: now,
      finalizedAt: now,
      expectedSourceRoszSha256: null,
      connectorEvent: event,
      inventoryEventId: `new-recruit-${event.eventId}`,
      message: finalization.message,
    };
    receipt = resealMutationReceipt({
      ...receipt,
      attempts: [...receipt.attempts, attempt],
    });
    await atomicWriteJson(filename, receipt);
    await ensureFinalizedInventory(receipt);
    return receipt;
  } finally {
    await release();
  }
}

function cachedDelivery(
  roster: RosterDraftV1,
  directory: string,
  receipt: CacheReceipt,
): ResultEnvelope<NewRecruitDelivery> {
  const sourceRoszPath = path.join(directory, "source.rosz");
  const enrichedRoszPath = path.join(directory, "enriched.rosz");
  return {
    ok: true,
    data: {
      rosterId: roster.id,
      rosterName: receipt.rosterName,
      uiIdentity: safeNewRecruitUiIdentity(
        receipt.uiIdentity,
      ),
      listUrl: receipt.listUrl,
      imported: true,
      sessionReused: true,
      cacheReused: true,
      connectorEvents: [
        ...(receipt.connectorEvents ?? []),
        {
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          recordedAt: new Date().toISOString(),
          provider: "new-recruit",
          action: "prepare",
          origin: "persistent-cache",
          outcome: "reused",
          remoteId: receipt.listUrl,
          contentSha256: receipt.enrichedRoszSha256,
        },
      ],
      verification: null,
      enrichedSummary: receipt.enrichedSummary,
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: "source.rosz",
          mimeType: "application/zip",
          written: sourceRoszPath,
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: "enriched.rosz",
          mimeType: "application/zip",
          written: enrichedRoszPath,
        },
      ],
    },
    violations: [],
    warnings: [
      {
        code: "NEW_RECRUIT_CACHE_REUSED",
        message:
          "Reused the verified content-addressed New Recruit artifact; no remote list was created.",
        severity: "warn",
      },
    ],
  };
}

export async function loadNewRecruitCache(
  roster: RosterDraftV1,
): Promise<ResultEnvelope<NewRecruitDelivery> | null> {
  const key = newRecruitCacheKey(roster);
  const directory = path.join(cacheRoot(), key);
  try {
    const receipt = JSON.parse(
      await readFile(path.join(directory, "receipt.json"), "utf8"),
    ) as CacheReceipt;
    const sourceRoszPath = path.join(directory, "source.rosz");
    const enrichedRoszPath = path.join(directory, "enriched.rosz");
    if (
      ![1, 2, 3].includes(receipt.schemaVersion) ||
      receipt.cacheKind !== "new-recruit-enriched-roster" ||
      (receipt.schemaVersion === 3 &&
        !integrityMatches(receipt)) ||
      receipt.cacheKey !== key ||
      receipt.executionFingerprint !== rosterExecutionFingerprint(roster) ||
      canonical(receipt.sourceData) !== canonical(roster.sourceData) ||
      receipt.sourceRoszSha256 !== (await sha256(sourceRoszPath)) ||
      receipt.enrichedRoszSha256 !== (await sha256(enrichedRoszPath))
    ) return null;
    const enrichedContent = await readFile(enrichedRoszPath);
    const actualSummary = validateEnrichedRoszGameplayIdentity(
      enrichedContent,
      roster,
    ).summary;
    if (canonical(actualSummary) !== canonical(receipt.enrichedSummary)) {
      return null;
    }
    return cachedDelivery(roster, directory, receipt);
  } catch {
    return null;
  }
}

export type NewRecruitCacheStoreContext = {
  runId: string;
  mutationAttemptId?: string | null;
};

async function recordStoredDeliveryInventory(input: {
  roster: RosterDraftV1;
  delivery: ResultEnvelope<NewRecruitDelivery>;
  context?: NewRecruitCacheStoreContext;
  enrichedRoszSha256: string;
}): Promise<void> {
  if (input.context && !input.context.runId.trim()) {
    throw failClosed(
      "NEW_RECRUIT_RUN_ID_REQUIRED",
      "A non-empty durable run ID is required when storing a run-scoped New Recruit artifact.",
    );
  }
  const finalization =
    classifyNewRecruitMutationDelivery(input.delivery);
  if (
    finalization.outcome === "created" ||
    finalization.outcome === "reused"
  ) {
    const event = finalization.connectorEvent!;
    await appendInventoryEntry({
      eventId: `new-recruit-${event.eventId}`,
      runId: input.context?.runId.trim() || "legacy-unscoped",
      attemptId:
        input.context?.mutationAttemptId ?? null,
      cacheKey: newRecruitCacheKey(input.roster),
      executionFingerprint:
        rosterExecutionFingerprint(input.roster),
      rosterName:
        input.delivery.data?.rosterName ?? input.roster.name,
      listUrl:
        event.remoteId ??
        input.delivery.data?.listUrl ??
        null,
      recordedAt: event.recordedAt,
      outcome: finalization.outcome,
      origin: event.origin,
      connectorEventId: event.eventId,
      contentSha256: event.contentSha256,
    });
    return;
  }
  // Backward compatibility for callers predating connector receipts. New
  // durable callers must always provide connector events and a real run ID.
  if (input.context) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_RECEIPT_REQUIRED",
      "A run-scoped New Recruit cache store requires a finalized created or reused connector receipt.",
    );
  }
  if (input.delivery.data?.listUrl) {
    const eventId = `legacy-${crypto.randomUUID()}`;
    await appendInventoryEntry({
      eventId,
      runId: "legacy-unscoped",
      attemptId: null,
      cacheKey: newRecruitCacheKey(input.roster),
      executionFingerprint:
        rosterExecutionFingerprint(input.roster),
      rosterName: input.delivery.data.rosterName,
      listUrl: input.delivery.data.listUrl,
      recordedAt: new Date().toISOString(),
      outcome: "created",
      origin: "new-remote",
      connectorEventId: null,
      contentSha256: input.enrichedRoszSha256,
    });
  }
}

export async function storeNewRecruitCache(
  roster: RosterDraftV1,
  delivery: ResultEnvelope<NewRecruitDelivery>,
  context?: NewRecruitCacheStoreContext,
): Promise<void> {
  if (!delivery.ok || !delivery.data?.enrichedSummary) return;
  if (context && !context.runId.trim()) {
    throw failClosed(
      "NEW_RECRUIT_RUN_ID_REQUIRED",
      "A non-empty durable run ID is required when storing a run-scoped New Recruit artifact.",
    );
  }
  const sourceRoszPath = delivery.data.artifacts.find(
    (artifact) =>
      artifact.format === "rosterpilot-source-rosz" ||
      artifact.format === "rosz",
  )?.written;
  const enrichedRoszPath = delivery.data.artifacts.find(
    (artifact) => artifact.format === "new-recruit-enriched-rosz",
  )?.written;
  if (!sourceRoszPath || !enrichedRoszPath) return;
  const enrichedContent = await readFile(enrichedRoszPath);
  const actualSummary = validateEnrichedRoszGameplayIdentity(
    enrichedContent,
    roster,
  ).summary;
  if (canonical(actualSummary) !== canonical(delivery.data.enrichedSummary)) {
    throw new Error(
      "The New Recruit cache refused an enriched artifact whose exact summary changed.",
    );
  }
  const key = newRecruitCacheKey(roster);
  const directory = path.join(cacheRoot(), key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cachedSource = path.join(directory, "source.rosz");
  const cachedEnriched = path.join(directory, "enriched.rosz");
  await Promise.all([
    copyFile(sourceRoszPath, cachedSource),
    copyFile(enrichedRoszPath, cachedEnriched),
  ]);
  const receipt: CacheReceiptV3 = sealIntegrity({
    schemaVersion: 3,
    cacheKind: "new-recruit-enriched-roster",
    cacheKey: key,
    createdAt: new Date().toISOString(),
    executionFingerprint: rosterExecutionFingerprint(roster),
    sourceData: roster.sourceData,
    rosterId: roster.id,
    rosterName: delivery.data.rosterName,
    uiIdentity: safeNewRecruitUiIdentity(
      delivery.data.uiIdentity,
    ),
    listUrl: delivery.data.listUrl,
    sourceRoszSha256: await sha256(cachedSource),
    enrichedRoszSha256: await sha256(cachedEnriched),
    enrichedSummary: actualSummary,
    connectorEvents: delivery.data.connectorEvents ?? [],
  });
  const receiptPath = path.join(directory, "receipt.json");
  await atomicWriteJson(receiptPath, receipt);
  await recordStoredDeliveryInventory({
    roster,
    delivery,
    ...(context ? { context } : {}),
    enrichedRoszSha256: receipt.enrichedRoszSha256,
  });
}
