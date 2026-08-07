import crypto from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  compareNewRecruitCatalogueProvenance,
  getNewRecruitFactionSummary,
  isForwardGameSystemRevisionOnlyDrift,
  newRecruitCatalogue,
  prepareNewRecruitHandoff,
  type ConnectorEvent,
  rosterExportFingerprint,
  rosterExecutionFingerprint,
  rosterStructuralFingerprint,
  rosterSourceDataCompatibleForExport,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type NewRecruitCatalogueProvenanceComparison,
  type ResultEnvelope,
  type RosterDraftV1,
  validateEnrichedRosz,
  validateEnrichedRoszGameplayIdentity,
  validateTesseraReadyRosz,
} from "../../lib/rosterpilot";
import { rosterPilotSupportDirectory } from "../agent/paths";
import {
  compareRoszGameplaySnapshots,
  inspectRoszGameplaySnapshot,
} from "../tessera/rosz-integrity";
import {
  appendWorkflowReliabilityEventSafely,
  associateWorkflowReliabilityIdentities,
  createWorkflowReliabilityEventStore,
} from "../reliability";
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

type ProvisionalCacheReceiptV1 = {
  schemaVersion: 1;
  cacheKind: "new-recruit-provisional-enriched-roster";
  reason: "forward-game-system-revision-only";
  cacheKey: string;
  createdAt: string;
  exportFingerprint: string;
  executionFingerprint: string;
  sourceData: RosterDraftV1["sourceData"];
  rosterId: string;
  rosterName: string;
  uiIdentity: string | null;
  listUrl: string | null;
  sourceRoszSha256: string;
  enrichedRoszSha256: string;
  enrichedSummary: EnrichedRoszSummary;
  catalogueProvenance: NewRecruitCatalogueProvenanceComparison;
  profileCoverageSha256: string;
  connectorEvents: ConnectorEvent[];
  integritySha256: string;
};

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
  /**
   * Hash-bound local recovery evidence for a verified source/enriched pair.
   * Older receipts legitimately omit this field and require explicit legacy
   * restoration; new receipts persist it before a created outcome is sealed.
   */
  recoveryArtifact?: NewRecruitMutationRecoveryArtifact | null;
};

export type NewRecruitMutationRecoveryArtifact = {
  schemaVersion: 1;
  artifactKind: "new-recruit-enriched-rosz";
  sourceRoszPath: string;
  sourceRoszSha256: string;
  enrichedRoszPath: string;
  enrichedRoszSha256: string;
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
  reliabilityWarnings?: Array<{
    code: string;
    message: string;
    recordedAt: string;
  }>;
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
  reliabilityWarnings?: Array<{
    code: string;
    message: string;
    recordedAt: string;
  }>;
  integritySha256: string;
};

export type NewRecruitMutationReceipt =
  | NewRecruitCanonicalMutationReceipt
  | NewRecruitRoszMutationReceipt;

export type NewRecruitMutationFinalization = {
  outcome: Exclude<NewRecruitMutationOutcome, "pending">;
  connectorEvent: ConnectorEvent | null;
  message: string;
  recoveryArtifact?: NewRecruitMutationRecoveryArtifact | null;
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

function validMutationRecoveryArtifact(
  value: unknown,
): value is NewRecruitMutationRecoveryArtifact {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<NewRecruitMutationRecoveryArtifact>;
  return (
    artifact.schemaVersion === 1 &&
    artifact.artifactKind === "new-recruit-enriched-rosz" &&
    typeof artifact.sourceRoszPath === "string" &&
    path.isAbsolute(artifact.sourceRoszPath) &&
    typeof artifact.enrichedRoszPath === "string" &&
    path.isAbsolute(artifact.enrichedRoszPath) &&
    isSha256(artifact.sourceRoszSha256) &&
    isSha256(artifact.enrichedRoszSha256)
  );
}

async function verifiedRegularFileSha256(
  filename: string,
  label: string,
): Promise<string> {
  return (await readVerifiedRegularFile(filename, label)).sha256;
}

async function readVerifiedRegularFile(
  filename: string,
  label: string,
): Promise<{ content: Buffer; sha256: string }> {
  let before;
  try {
    before = await lstat(filename);
  } catch {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ARTIFACT_MISSING",
      `The retained ${label} recovery artifact is missing. No new New Recruit list was created.`,
    );
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED",
      `The retained ${label} recovery artifact is not a regular non-symlink file. No new New Recruit list was created.`,
    );
  }
  const content = await readFile(filename);
  const after = await lstat(filename).catch(() => null);
  if (
    !after?.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED",
      `The retained ${label} recovery artifact changed while it was read. No new New Recruit list was created.`,
    );
  }
  return {
    content,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
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
    .update(rosterExportFingerprint(roster))
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

function provisionalCacheRoot(cacheKey?: string): string {
  return path.join(
    cacheRoot(),
    "provisional",
    ...(cacheKey ? [cacheKey] : []),
  );
}

function mutationArtifactRoot(cacheKey: string): string {
  return path.join(
    cacheRoot(),
    "mutation-artifacts",
    cacheKey,
  );
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

function sourceDataMatchesForExport(
  left: unknown,
  right: RosterDraftV1["sourceData"],
): boolean {
  if (
    left &&
    typeof left === "object" &&
    "engineDataSchemaVersion" in left &&
    "rosterRulesHash" in left &&
    "mappingHash" in left
  ) {
    return rosterSourceDataCompatibleForExport(
      left as RosterDraftV1["sourceData"],
      right,
    );
  }
  return canonical(left) === canonical(right);
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
      typeof attempt.message === "string") &&
    (attempt.recoveryArtifact === undefined ||
      attempt.recoveryArtifact === null ||
      validMutationRecoveryArtifact(attempt.recoveryArtifact));
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
      Boolean(attempt.message?.trim()) &&
      (attempt.recoveryArtifact === undefined ||
        attempt.recoveryArtifact === null ||
        attempt.recoveryArtifact.enrichedRoszSha256 ===
          event.contentSha256)
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
    (receipt.reliabilityWarnings === undefined ||
      (Array.isArray(receipt.reliabilityWarnings) &&
        receipt.reliabilityWarnings.length <= 20 &&
        receipt.reliabilityWarnings.every(
          (warning) =>
            Boolean(
              warning &&
                typeof warning === "object" &&
                typeof warning.code === "string" &&
                warning.code.length > 0 &&
                typeof warning.message === "string" &&
                warning.message.length > 0 &&
                isIsoDate(warning.recordedAt),
            ),
        ))) &&
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
    !sourceDataMatchesForExport(receipt.sourceData, roster.sourceData)
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
    const sameEvent = inventory.entries.find(
      (candidate) => candidate.eventId === entry.eventId,
    );
    if (
      sameEvent &&
      sameEvent.cacheKey !== entry.cacheKey &&
      sameEvent.connectorEventId === entry.connectorEventId &&
      sameEvent.listUrl === entry.listUrl &&
      sameEvent.contentSha256 === entry.contentSha256 &&
      sameEvent.recordedAt === entry.recordedAt &&
      sameEvent.outcome === entry.outcome &&
      sameEvent.origin === entry.origin
    ) {
      // One verified browser event may be indexed first by its exact uploaded
      // bytes and then by the canonical roster cache. Preserve both
      // provenance edges under deterministic inventory IDs without treating
      // that safe cross-index as conflicting or replaying the mutation.
      entry = {
        ...entry,
        eventId: `${entry.eventId}-${entry.cacheKey.slice(0, 12)}`,
      };
    }
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

/** Read-only, redacted projection suitable for CLI/MCP recovery guidance. */
export async function inspectNewRecruitMutationReceipt(
  roster: RosterDraftV1,
): Promise<{
  receiptFound: boolean;
  cacheKey: string;
  rosterId: string;
  updatedAt: string | null;
  attemptCount: number;
  latestAttempt: {
    attemptId: string;
    runId: string;
    outcome: NewRecruitMutationOutcome;
    startedAt: string;
    finalizedAt: string | null;
    hasConnectorEvidence: boolean;
    hasInventoryEvidence: boolean;
    hasRecoveryArtifact: boolean;
  } | null;
  safeToRetry: boolean;
  requiredAction:
    | "none"
    | "retry-proven-not-created"
    | "reconcile-from-observed-evidence"
    | "reuse-created-artifact";
}> {
  const receipt = await readNewRecruitMutationReceipt(roster);
  const latest = receipt?.attempts.at(-1) ?? null;
  return {
    receiptFound: receipt !== null,
    cacheKey: receipt?.cacheKey ?? newRecruitCacheKey(roster),
    rosterId: roster.id,
    updatedAt: receipt?.updatedAt ?? null,
    attemptCount: receipt?.attempts.length ?? 0,
    latestAttempt: latest
      ? {
          attemptId: latest.attemptId,
          runId: latest.runId,
          outcome: latest.outcome,
          startedAt: latest.startedAt,
          finalizedAt: latest.finalizedAt,
          hasConnectorEvidence: latest.connectorEvent !== null,
          hasInventoryEvidence: latest.inventoryEventId !== null,
          hasRecoveryArtifact: latest.recoveryArtifact != null,
        }
      : null,
    safeToRetry: latest?.outcome === "not-created",
    requiredAction:
      !latest
        ? "none"
        : latest.outcome === "not-created"
          ? "retry-proven-not-created"
          : latest.outcome === "pending" || latest.outcome === "uncertain"
            ? "reconcile-from-observed-evidence"
            : "reuse-created-artifact",
  };
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
    reliabilityWarnings: [],
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
    reliabilityWarnings: [],
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

async function recoveryArtifactForDelivery(
  cacheKey: string,
  expectedSourceRoszSha256: string | null,
  delivery: ResultEnvelope<NewRecruitDelivery>,
  event: ConnectorEvent | null,
): Promise<NewRecruitMutationRecoveryArtifact> {
  if (
    !delivery.data?.enrichedSummary ||
    !event ||
    event.origin !== "new-remote" ||
    event.outcome !== "verified" ||
    !event.contentSha256
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ARTIFACT_REQUIRED",
      `A created New Recruit mutation cannot be finalized without verified enriched-artifact evidence. (enrichedSummary: ${!!delivery.data?.enrichedSummary}, event: ${!!event}, origin: ${event?.origin}, outcome: ${event?.outcome})`,
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
  if (!sourceRoszPath || !enrichedRoszPath) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ARTIFACT_REQUIRED",
      "A created New Recruit mutation cannot be finalized without retained source and enriched ROSZ files.",
    );
  }
  return persistMutationRecoveryArtifact({
    cacheKey,
    sourceRoszPath,
    enrichedRoszPath,
    expectedSourceRoszSha256,
    expectedEnrichedRoszSha256: event.contentSha256,
  });
}

async function copyRecoveryFile(input: {
  source: string;
  destination: string;
  expectedSha256: string;
  label: string;
}): Promise<void> {
  const existing = await lstat(input.destination).catch(() => null);
  if (existing) {
    const digest = await verifiedRegularFileSha256(
      input.destination,
      input.label,
    );
    if (digest !== input.expectedSha256) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED",
        `The content-addressed ${input.label} recovery artifact changed. No new New Recruit list was created.`,
      );
    }
    return;
  }
  const temporary = `${input.destination}.${crypto.randomUUID()}.tmp`;
  try {
    await copyFile(input.source, temporary);
    const digest = await verifiedRegularFileSha256(
      temporary,
      input.label,
    );
    if (digest !== input.expectedSha256) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED",
        `The ${input.label} recovery artifact changed while it was retained. No new New Recruit list was created.`,
      );
    }
    await rename(temporary, input.destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function persistMutationRecoveryArtifact(input: {
  cacheKey: string;
  sourceRoszPath: string;
  enrichedRoszPath: string;
  expectedSourceRoszSha256: string | null;
  expectedEnrichedRoszSha256: string;
}): Promise<NewRecruitMutationRecoveryArtifact> {
  const absoluteSource = path.resolve(input.sourceRoszPath);
  const absoluteEnriched = path.resolve(input.enrichedRoszPath);
  const [sourceRoszSha256, enrichedRoszSha256] = await Promise.all([
    verifiedRegularFileSha256(absoluteSource, "source ROSZ"),
    verifiedRegularFileSha256(absoluteEnriched, "enriched ROSZ"),
  ]);
  if (
    (input.expectedSourceRoszSha256 !== null &&
      input.expectedSourceRoszSha256 !== sourceRoszSha256) ||
    input.expectedEnrichedRoszSha256 !== enrichedRoszSha256
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED",
      "The verified New Recruit connector hashes do not match the retained recovery artifacts.",
    );
  }
  const directory = path.join(
    mutationArtifactRoot(input.cacheKey),
    `${sourceRoszSha256}-${enrichedRoszSha256}`,
  );
  const release = await acquireDirectoryLease(`${directory}.lock`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED",
        "The content-addressed New Recruit recovery location is not a regular directory.",
      );
    }
    const retainedSource = path.join(directory, "source.rosz");
    const retainedEnriched = path.join(directory, "enriched.rosz");
    await Promise.all([
      copyRecoveryFile({
        source: absoluteSource,
        destination: retainedSource,
        expectedSha256: sourceRoszSha256,
        label: "source ROSZ",
      }),
      copyRecoveryFile({
        source: absoluteEnriched,
        destination: retainedEnriched,
        expectedSha256: enrichedRoszSha256,
        label: "enriched ROSZ",
      }),
    ]);
    return {
      schemaVersion: 1,
      artifactKind: "new-recruit-enriched-rosz",
      sourceRoszPath: retainedSource,
      sourceRoszSha256,
      enrichedRoszPath: retainedEnriched,
      enrichedRoszSha256,
    };
  } finally {
    await release();
  }
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
    delivery.data?.imported === true &&
    event?.origin === "new-remote" &&
    event.outcome === "verified"
  ) {
    return {
      outcome: "created",
      connectorEvent: event,
      message:
        delivery.ok
          ? "New Recruit created and verified a remote roster list."
          : "New Recruit created and verified a remote roster list, but post-delivery acceptance failed closed.",
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
  const recoveryArtifact = finalization.recoveryArtifact ?? null;
  if (
    recoveryArtifact &&
    (
      !validMutationRecoveryArtifact(recoveryArtifact) ||
      !event ||
      !["verified", "reused"].includes(event.outcome) ||
      event.contentSha256 !== recoveryArtifact.enrichedRoszSha256
    )
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ARTIFACT_INVALID",
      "A mutation recovery artifact requires matching verified New Recruit connector evidence.",
    );
  }
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

async function recordMutationFinalizationReliability(input: {
  filename: string;
  receipt: NewRecruitMutationReceipt;
  attempt: NewRecruitMutationAttempt;
  recovered?: boolean;
}): Promise<NewRecruitMutationReceipt> {
  const reliabilityRoot = path.join(
    rosterPilotSupportDirectory(),
    "reliability",
  );
  const workflow = {
    workflowId: input.attempt.runId,
    workflowKind: "new-recruit-mutation",
  } as const;
  const connectorEventSha256 = input.attempt.connectorEvent
    ? sha256Text(canonical(input.attempt.connectorEvent))
    : null;
  const recorded = await appendWorkflowReliabilityEventSafely(
    createWorkflowReliabilityEventStore({
      rootDirectory: reliabilityRoot,
    }),
    {
      workflow,
      idempotencyKey:
        `new-recruit:${input.receipt.cacheKey}:${input.attempt.attemptId}:` +
        `${input.attempt.outcome}:${input.attempt.finalizedAt ?? "unfinalized"}`,
      eventKind:
        input.recovered
          ? "repair-applied"
          : input.attempt.outcome === "created"
            ? "external-mutation"
            : input.attempt.outcome === "reused"
              ? "artifact-reuse"
              : "failure",
      stage: "new-recruit-finalization",
      provider: "new-recruit",
      outcome:
        input.recovered
          ? "recovered"
          : input.attempt.outcome === "created" ||
              input.attempt.outcome === "reused"
            ? "succeeded"
            : input.attempt.outcome === "uncertain"
              ? "inconclusive"
              : "failed",
      occurredAt: input.attempt.finalizedAt ?? input.receipt.updatedAt,
      execution: {
        status:
          input.recovered ||
          input.attempt.outcome === "created" ||
          input.attempt.outcome === "reused"
            ? "succeeded"
            : input.attempt.outcome === "uncertain"
              ? "inconclusive"
              : "failed",
        attempt: 1,
      },
      evidence: {
        status:
          input.attempt.outcome === "uncertain" ? "partial" : "verified",
        artifactCount:
          1 + (input.attempt.recoveryArtifact ? 2 : 0),
        evidenceSha256: input.receipt.integritySha256,
      },
      error:
        !input.recovered &&
        (input.attempt.outcome === "uncertain" ||
          input.attempt.outcome === "not-created")
          ? {
              code:
                input.attempt.outcome === "uncertain"
                  ? "NEW_RECRUIT_MUTATION_UNCERTAIN"
                  : "NEW_RECRUIT_MUTATION_NOT_CREATED",
              message:
                input.attempt.message ??
                "The New Recruit mutation did not complete.",
              retryable: input.attempt.outcome === "not-created",
            }
          : null,
      attributes: {
        runId: input.attempt.runId,
        attemptId: input.attempt.attemptId,
        cacheKey: input.receipt.cacheKey,
        receiptSha256: input.receipt.integritySha256,
        outcome: input.attempt.outcome,
        recovered: input.recovered ?? false,
        connectorEventSha256,
        connectorEventId:
          input.attempt.connectorEvent?.eventId ?? null,
        connectorContentSha256:
          input.attempt.connectorEvent?.contentSha256 ?? null,
        sourceRoszSha256:
          input.attempt.recoveryArtifact?.sourceRoszSha256 ??
          input.attempt.expectedSourceRoszSha256,
        enrichedRoszSha256:
          input.attempt.recoveryArtifact?.enrichedRoszSha256 ?? null,
      },
    },
  );
  const association = await associateWorkflowReliabilityIdentities(
    {
      workflow,
      identities: [
        { kind: "new-recruit-run-id", value: input.attempt.runId },
      ],
    },
    { rootDirectory: reliabilityRoot },
  );
  const warnings: Array<{ code: string; message: string }> = [];
  if (!recorded.ok) warnings.push(recorded.error);
  if (!association.ok && association.warning) {
    warnings.push({
      code: "RELIABILITY_IDENTITY_ASSOCIATION_FAILED",
      message: association.warning,
    });
  }
  if (warnings.length === 0) return input.receipt;
  const currentWarnings = input.receipt.reliabilityWarnings ?? [];
  const nextWarnings = [...currentWarnings];
  for (const warning of warnings) {
    if (
      nextWarnings.some(
        (existing) =>
          existing.code === warning.code &&
          existing.message === warning.message,
      )
    ) {
      continue;
    }
    nextWarnings.push({
      ...warning,
      recordedAt: new Date().toISOString(),
    });
  }
  const warned = resealMutationReceipt({
    ...input.receipt,
    reliabilityWarnings: nextWarnings.slice(-20),
  });
  return atomicWriteJson(input.filename, warned)
    .then(() => warned)
    .catch(() => input.receipt);
}

async function finalizeMutationAttempt(input: {
  filename: string;
  receipt: NewRecruitMutationReceipt;
  attemptId: string;
  finalization: NewRecruitMutationFinalization;
  recovered?: boolean;
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
        canonical(input.finalization.connectorEvent) &&
      canonical(attempt.recoveryArtifact ?? null) ===
        canonical(input.finalization.recoveryArtifact ?? null)
    ) {
      const recorded = (input.receipt.reliabilityWarnings?.length ?? 0) > 0
        ? input.receipt
        : await recordMutationFinalizationReliability({
            filename: input.filename,
            receipt: input.receipt,
            attempt,
          });
      await ensureFinalizedInventory(recorded);
      return recorded;
    }
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ALREADY_FINALIZED",
      "The New Recruit mutation attempt was already finalized with a different outcome.",
    );
  }
  const recoveryArtifact = input.finalization.recoveryArtifact ?? null;
  if (recoveryArtifact) {
    if (!validMutationRecoveryArtifact(recoveryArtifact)) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_ARTIFACT_INVALID",
        "The New Recruit mutation recovery artifact receipt is malformed.",
      );
    }
    const [sourceSha256, enrichedSha256] = await Promise.all([
      verifiedRegularFileSha256(
        recoveryArtifact.sourceRoszPath,
        "source ROSZ",
      ),
      verifiedRegularFileSha256(
        recoveryArtifact.enrichedRoszPath,
        "enriched ROSZ",
      ),
    ]);
    if (
      sourceSha256 !== recoveryArtifact.sourceRoszSha256 ||
      enrichedSha256 !== recoveryArtifact.enrichedRoszSha256 ||
      (attempt.expectedSourceRoszSha256 !== null &&
        attempt.expectedSourceRoszSha256 !== sourceSha256) ||
      (input.finalization.connectorEvent?.contentSha256 !== null &&
        input.finalization.connectorEvent?.contentSha256 !== undefined &&
        input.finalization.connectorEvent.contentSha256 !== enrichedSha256)
    ) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED",
        "The retained New Recruit recovery artifacts do not match the mutation receipt hashes.",
      );
    }
  }
  const finalizedAt = new Date().toISOString();
  attempt.outcome = input.finalization.outcome;
  attempt.finalizedAt = finalizedAt;
  attempt.connectorEvent = input.finalization.connectorEvent;
  attempt.message = input.finalization.message;
  attempt.recoveryArtifact = recoveryArtifact;
  attempt.inventoryEventId =
    input.finalization.outcome === "created" ||
    input.finalization.outcome === "reused"
      ? `new-recruit-${input.finalization.connectorEvent!.eventId}`
      : null;
  let sealed = resealMutationReceipt(input.receipt);
  // The finalized receipt is authoritative. If inventory persistence is
  // interrupted, the next read/resume backfills the exact event by ID.
  await atomicWriteJson(input.filename, sealed);
  sealed = await recordMutationFinalizationReliability({
    filename: input.filename,
    receipt: sealed,
    attempt: sealed.attempts.find(
      (candidate) => candidate.attemptId === input.attemptId,
    )!,
    recovered: input.recovered,
  });
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
      recoveryArtifact: null,
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
      finalizeDelivery: async (delivery) => {
        const finalization = classifyNewRecruitMutationDelivery(delivery);
        if (finalization.outcome !== "created") {
          return finalize(finalization);
        }
        let recoveryArtifact: NewRecruitMutationRecoveryArtifact;
        try {
          recoveryArtifact = await recoveryArtifactForDelivery(
            cacheKey,
            input.descriptor.expectedSourceRoszSha256,
            delivery,
            finalization.connectorEvent,
          );
        } catch (error) {
          // The remote creation evidence is still authoritative. Seal it and
          // release the mutation lease before surfacing the local retention
          // failure; an exact retained job can then repair the artifact without
          // risking a duplicate delivery.
          await finalize(finalization);
          throw error;
        }
        return finalize({
          ...finalization,
          recoveryArtifact,
        });
      },
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
    const recovered = attempt.outcome === "uncertain";
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
      recovered,
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
      const recorded = (receipt.reliabilityWarnings?.length ?? 0) > 0
        ? receipt
        : await recordMutationFinalizationReliability({
            filename,
            receipt,
            attempt: existing,
          });
      await ensureFinalizedInventory(recorded);
      return recorded;
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
    receipt = await recordMutationFinalizationReliability({
      filename,
      receipt,
      attempt,
    });
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

function provisionalCatalogueComparison(
  roster: RosterDraftV1,
  summary: EnrichedRoszSummary,
): NewRecruitCatalogueProvenanceComparison | null {
  const faction = getNewRecruitFactionSummary(roster.factionId);
  if (!faction?.catalogue.id) return null;
  return compareNewRecruitCatalogueProvenance(summary, {
    releaseId: roster.sourceData.releaseId,
    gameSystem: {
      id: newRecruitCatalogue.gameSystem.id,
      name: newRecruitCatalogue.gameSystem.name,
      revision: roster.sourceData.newRecruit.gameSystemRevision,
    },
    catalogue: {
      id: faction.catalogue.id,
      name: faction.catalogue.name,
      revision: roster.sourceData.newRecruit.catalogueRevision,
    },
  });
}

function validProvisionalReceipt(
  value: unknown,
): value is ProvisionalCacheReceiptV1 {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<ProvisionalCacheReceiptV1>;
  return (
    receipt.schemaVersion === 1 &&
    receipt.cacheKind ===
      "new-recruit-provisional-enriched-roster" &&
    receipt.reason === "forward-game-system-revision-only" &&
    isSha256(receipt.cacheKey) &&
    isIsoDate(receipt.createdAt) &&
    isSha256(receipt.exportFingerprint) &&
    isSha256(receipt.executionFingerprint) &&
    Boolean(receipt.sourceData) &&
    typeof receipt.sourceData === "object" &&
    typeof receipt.rosterId === "string" &&
    receipt.rosterId.length > 0 &&
    typeof receipt.rosterName === "string" &&
    receipt.rosterName.length > 0 &&
    (receipt.uiIdentity === null ||
      typeof receipt.uiIdentity === "string") &&
    (receipt.listUrl === null ||
      typeof receipt.listUrl === "string") &&
    isSha256(receipt.sourceRoszSha256) &&
    isSha256(receipt.enrichedRoszSha256) &&
    Boolean(receipt.enrichedSummary) &&
    typeof receipt.enrichedSummary === "object" &&
    Boolean(receipt.catalogueProvenance) &&
    typeof receipt.catalogueProvenance === "object" &&
    isForwardGameSystemRevisionOnlyDrift(
      receipt.catalogueProvenance as NewRecruitCatalogueProvenanceComparison,
    ) &&
    isSha256(receipt.profileCoverageSha256) &&
    Array.isArray(receipt.connectorEvents) &&
    receipt.connectorEvents.every(isConnectorEvent) &&
    typeof receipt.integritySha256 === "string" &&
    integrityMatches(receipt as ProvisionalCacheReceiptV1)
  );
}

function provisionalDelivery(
  roster: RosterDraftV1,
  directory: string,
  receipt: ProvisionalCacheReceiptV1,
): ResultEnvelope<NewRecruitDelivery> {
  return {
    ok: true,
    data: {
      rosterId: roster.id,
      rosterName: receipt.rosterName,
      uiIdentity: safeNewRecruitUiIdentity(receipt.uiIdentity),
      listUrl: receipt.listUrl,
      imported: false,
      sessionReused: true,
      cacheReused: true,
      connectorEvents: [
        ...receipt.connectorEvents,
        {
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          recordedAt: new Date().toISOString(),
          provider: "new-recruit",
          action: "prepare",
          origin: "manifest-reuse",
          outcome: "reused",
          remoteId: receipt.listUrl,
          contentSha256: receipt.enrichedRoszSha256,
        },
      ],
      verification: null,
      enrichedSummary: receipt.enrichedSummary,
      catalogueProvenance: receipt.catalogueProvenance,
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: "source.rosz",
          mimeType: "application/zip",
          written: path.join(directory, "source.rosz"),
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: "enriched.rosz",
          mimeType: "application/zip",
          written: path.join(directory, "enriched.rosz"),
        },
      ],
    },
    violations: [],
    warnings: [
      {
        code: "NEW_RECRUIT_PROVISIONAL_CACHE_REUSED",
        message:
          "Reused a hash-verified provisional New Recruit artifact; no remote list was created. Tessera must revalidate its forward-only revision drift before use.",
        severity: "warn",
      },
    ],
  };
}

export async function storeNewRecruitProvisionalArtifact(
  roster: RosterDraftV1,
  delivery: ResultEnvelope<NewRecruitDelivery>,
): Promise<void> {
  if (!delivery.data?.enrichedSummary) return;
  const sourcePath = delivery.data.artifacts.find(
    (artifact) =>
      artifact.format === "rosterpilot-source-rosz" ||
      artifact.format === "rosz",
  )?.written;
  const enrichedPath = delivery.data.artifacts.find(
    (artifact) => artifact.format === "new-recruit-enriched-rosz",
  )?.written;
  if (!sourcePath || !enrichedPath) return;
  const [sourceContent, enrichedContent] = await Promise.all([
    readFile(sourcePath),
    readFile(enrichedPath),
  ]);
  const readiness = validateTesseraReadyRosz(enrichedContent);
  if (
    canonical(readiness.summary) !==
    canonical(delivery.data.enrichedSummary)
  ) {
    throw failClosed(
      "NEW_RECRUIT_PROVISIONAL_ARTIFACT_DRIFT",
      "The provisional New Recruit artifact summary changed before it could be retained.",
    );
  }
  const catalogueProvenance = provisionalCatalogueComparison(
    roster,
    readiness.summary,
  );
  if (
    !catalogueProvenance ||
    !isForwardGameSystemRevisionOnlyDrift(catalogueProvenance)
  ) {
    return;
  }
  const sourceRoszSha256 = crypto
    .createHash("sha256")
    .update(sourceContent)
    .digest("hex");
  const enrichedRoszSha256 = crypto
    .createHash("sha256")
    .update(enrichedContent)
    .digest("hex");
  const cacheKey = newRecruitCacheKey(roster);
  const parent = provisionalCacheRoot(cacheKey);
  const destination = path.join(parent, enrichedRoszSha256);
  const temporary = path.join(
    parent,
    `.${enrichedRoszSha256}.${crypto.randomUUID()}.tmp`,
  );
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const temporarySource = path.join(temporary, "source.rosz");
    const temporaryEnriched = path.join(temporary, "enriched.rosz");
    await Promise.all([
      copyFile(sourcePath, temporarySource),
      copyFile(enrichedPath, temporaryEnriched),
    ]);
    const receipt: ProvisionalCacheReceiptV1 = sealIntegrity({
      schemaVersion: 1,
      cacheKind: "new-recruit-provisional-enriched-roster",
      reason: "forward-game-system-revision-only",
      cacheKey,
      createdAt: new Date().toISOString(),
      exportFingerprint: rosterExportFingerprint(roster),
      executionFingerprint: rosterExecutionFingerprint(roster),
      sourceData: roster.sourceData,
      rosterId: roster.id,
      rosterName: delivery.data.rosterName,
      uiIdentity: safeNewRecruitUiIdentity(delivery.data.uiIdentity),
      listUrl: delivery.data.listUrl,
      sourceRoszSha256,
      enrichedRoszSha256,
      enrichedSummary: readiness.summary,
      catalogueProvenance,
      profileCoverageSha256: sha256Text(
        canonical(readiness.unitProfileCoverage),
      ),
      connectorEvents: delivery.data.connectorEvents ?? [],
    });
    await atomicWriteJson(
      path.join(temporary, "receipt.json"),
      receipt,
    );
    try {
      await rename(temporary, destination);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function legacyUncertainEventMatchesVerified(
  uncertain: ConnectorEvent | null,
  verified: ConnectorEvent,
): boolean {
  if (
    !uncertain ||
    uncertain.provider !== "new-recruit" ||
    uncertain.action !== "prepare" ||
    uncertain.origin !== "new-remote" ||
    uncertain.outcome !== "uncertain" ||
    verified.provider !== "new-recruit" ||
    verified.action !== "prepare" ||
    verified.origin !== "new-remote" ||
    verified.outcome !== "verified" ||
    typeof verified.remoteId !== "string" ||
    verified.remoteId.length === 0 ||
    !verified.contentSha256
  ) {
    return false;
  }
  return (
    uncertain.eventId === verified.eventId &&
    uncertain.recordedAt === verified.recordedAt &&
    uncertain.remoteId === verified.remoteId &&
    uncertain.contentSha256 === verified.contentSha256
  );
}

/**
 * Releases one legacy contradiction created by the pre-recovery Tessera
 * wrapper. That wrapper changed a verified remote creation to `uncertain`
 * when strict catalogue acceptance failed after the upload. A sealed
 * provisional artifact preserves the original verified event and exact
 * source/enriched bytes, so that evidence can repair the receipt locally.
 * Every other uncertain outcome remains fail-closed.
 */
async function repairLegacyStrictDriftMutationReceipt(input: {
  roster: RosterDraftV1;
  provisional: ProvisionalCacheReceiptV1;
  directory: string;
}): Promise<void> {
  const cacheKey = newRecruitCacheKey(input.roster);
  if (input.provisional.cacheKey !== cacheKey) {
    throw failClosed(
      "NEW_RECRUIT_PROVISIONAL_RECEIPT_CONFLICT",
      "The provisional artifact does not match the roster mutation receipt.",
    );
  }
  const verifiedEvents = input.provisional.connectorEvents.filter(
    (event) =>
      event.origin === "new-remote" &&
      event.outcome === "verified" &&
      event.remoteId === input.provisional.listUrl &&
      event.contentSha256 === input.provisional.enrichedRoszSha256,
  );
  if (verifiedEvents.length === 0) return;

  const filename = mutationReceiptPath(cacheKey);
  const release = await acquireDirectoryLease(
    mutationReceiptLockPath(cacheKey),
  );
  try {
    const receipt = await readMutationReceiptFile(filename);
    if (!receipt) return;
    assertReceiptProvenance(receipt, input.roster);
    const matches = receipt.attempts.flatMap((attempt) =>
      attempt.outcome === "uncertain" &&
      (
        attempt.expectedSourceRoszSha256 === null ||
        attempt.expectedSourceRoszSha256 ===
          input.provisional.sourceRoszSha256
      )
        ? verifiedEvents
            .filter((event) =>
              legacyUncertainEventMatchesVerified(
                attempt.connectorEvent,
                event,
              ),
            )
            .map((event) => ({ attempt, event }))
        : [],
    );
    if (matches.length === 0) return;
    if (matches.length !== 1) {
      throw failClosed(
        "NEW_RECRUIT_LEGACY_RECEIPT_AMBIGUOUS",
        "More than one uncertain mutation matches the verified provisional artifact; manual reconciliation is required.",
      );
    }
    const [{ attempt, event }] = matches;
    const recoveryArtifact = await persistMutationRecoveryArtifact({
      cacheKey,
      sourceRoszPath: path.join(input.directory, "source.rosz"),
      enrichedRoszPath: path.join(input.directory, "enriched.rosz"),
      expectedSourceRoszSha256:
        input.provisional.sourceRoszSha256,
      expectedEnrichedRoszSha256:
        input.provisional.enrichedRoszSha256,
    });
    attempt.outcome = "created";
    attempt.expectedSourceRoszSha256 =
      input.provisional.sourceRoszSha256;
    attempt.connectorEvent = event;
    attempt.inventoryEventId = `new-recruit-${event.eventId}`;
    attempt.message =
      "Recovered a verified New Recruit creation that an earlier strict catalogue-drift handoff misclassified as uncertain.";
    attempt.recoveryArtifact = recoveryArtifact;
    const sealed = resealMutationReceipt(receipt);
    await atomicWriteJson(filename, sealed);
    await ensureFinalizedInventory(sealed);
  } finally {
    await release();
  }
}

export async function loadNewRecruitProvisionalArtifact(
  roster: RosterDraftV1,
  options: { repairMutationReceipt?: boolean } = {},
): Promise<ResultEnvelope<NewRecruitDelivery> | null> {
  const cacheKey = newRecruitCacheKey(roster);
  const parent = provisionalCacheRoot(cacheKey);
  let directories: string[];
  try {
    directories = (await readdir(parent, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          /^[0-9a-f]{64}$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  const candidates: Array<{
    directory: string;
    receipt: ProvisionalCacheReceiptV1;
  }> = [];
  for (const name of directories) {
    const directory = path.join(parent, name);
    try {
      const receipt = JSON.parse(
        await readFile(path.join(directory, "receipt.json"), "utf8"),
      ) as unknown;
      if (!validProvisionalReceipt(receipt)) continue;
      if (
        receipt.cacheKey !== cacheKey ||
        receipt.enrichedRoszSha256 !== name ||
        receipt.exportFingerprint !== rosterExportFingerprint(roster) ||
        receipt.executionFingerprint !==
          rosterExecutionFingerprint(roster) ||
        !sourceDataMatchesForExport(receipt.sourceData, roster.sourceData)
      ) {
        continue;
      }
      const sourcePath = path.join(directory, "source.rosz");
      const enrichedPath = path.join(directory, "enriched.rosz");
      if (
        receipt.sourceRoszSha256 !== (await sha256(sourcePath)) ||
        receipt.enrichedRoszSha256 !== (await sha256(enrichedPath))
      ) {
        continue;
      }
      const readiness = validateTesseraReadyRosz(
        await readFile(enrichedPath),
      );
      if (
        canonical(readiness.summary) !==
          canonical(receipt.enrichedSummary) ||
        sha256Text(canonical(readiness.unitProfileCoverage)) !==
          receipt.profileCoverageSha256
      ) {
        continue;
      }
      const currentComparison = provisionalCatalogueComparison(
        roster,
        readiness.summary,
      );
      if (
        !currentComparison ||
        (
          currentComparison.status !== "matched" &&
          !isForwardGameSystemRevisionOnlyDrift(currentComparison)
        )
      ) {
        continue;
      }
      candidates.push({ directory, receipt });
    } catch {
      continue;
    }
  }
  candidates.sort((left, right) =>
    right.receipt.createdAt.localeCompare(left.receipt.createdAt),
  );
  const selected = candidates[0];
  if (!selected) return null;
  if (options.repairMutationReceipt !== false) {
    await repairLegacyStrictDriftMutationReceipt({
      roster,
      provisional: selected.receipt,
      directory: selected.directory,
    });
  }
  return provisionalDelivery(
    roster,
    selected.directory,
    selected.receipt,
  );
}

/**
 * Rehydrates a verified delivery directly from the sealed mutation ledger
 * when the ordinary trusted/provisional cache is missing. This is strictly a
 * local read path: it never opens New Recruit or creates another list.
 */
async function verifiedMutationRecoveryArtifact(
  receipt: NewRecruitMutationReceipt | null,
): Promise<{
  attempt: NewRecruitMutationAttempt;
  artifact: NewRecruitMutationRecoveryArtifact;
  event: ConnectorEvent;
  enrichedContent: Buffer;
} | null> {
  const attempt = receipt?.attempts.findLast(
    (candidate) =>
      candidate.outcome === "created" &&
      candidate.recoveryArtifact != null,
  );
  const artifact = attempt?.recoveryArtifact;
  const event = attempt?.connectorEvent;
  if (!attempt || !artifact || !event) return null;
  const [sourceSha256, enriched] = await Promise.all([
    verifiedRegularFileSha256(
      artifact.sourceRoszPath,
      "source ROSZ",
    ),
    readVerifiedRegularFile(
      artifact.enrichedRoszPath,
      "enriched ROSZ",
    ),
  ]);
  const enrichedSha256 = enriched.sha256;
  const enrichedContent = enriched.content;
  if (
    sourceSha256 !== artifact.sourceRoszSha256 ||
    enrichedSha256 !== artifact.enrichedRoszSha256 ||
    event.contentSha256 !== enrichedSha256 ||
    (attempt.expectedSourceRoszSha256 !== null &&
      attempt.expectedSourceRoszSha256 !== sourceSha256)
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED",
      `The recovery artifacts recorded by run ${attempt.runId} changed after the New Recruit mutation was finalized. No new list was created.`,
    );
  }
  return { attempt, artifact, event, enrichedContent };
}

export async function loadNewRecruitMutationRecoveryArtifact(
  roster: RosterDraftV1,
): Promise<ResultEnvelope<NewRecruitDelivery> | null> {
  const receipt = await readNewRecruitMutationReceipt(roster);
  const recovered = await verifiedMutationRecoveryArtifact(receipt);
  if (!recovered) return null;
  const { attempt, artifact, event, enrichedContent } = recovered;
  const currentHandoff = await prepareNewRecruitHandoff(roster, false);
  const currentSource = currentHandoff.data?.artifacts.find(
    (candidate) => candidate.format === "rosz",
  );
  if (!currentHandoff.ok || !currentSource) {
    return null;
  }
  const sourceMismatches = compareRoszGameplaySnapshots(
    inspectRoszGameplaySnapshot(
      typeof currentSource.content === "string"
        ? Buffer.from(currentSource.content, "utf8")
        : currentSource.content,
    ),
    inspectRoszGameplaySnapshot(
      await readFile(artifact.sourceRoszPath),
    ),
  );
  if (sourceMismatches.length > 0) {
    // The remote list remains durable evidence, but it was produced by a
    // different exporter result. Reusing it would silently resurrect a fixed
    // selection-tree bug. Callers may use a content-addressed successor
    // mutation, while the original canonical receipt continues to prevent an
    // accidental duplicate of the old bytes.
    return null;
  }
  const enrichedSha256 = artifact.enrichedRoszSha256;
  const identity = validateEnrichedRoszGameplayIdentity(
    enrichedContent,
    roster,
  );
  const catalogueProvenance = provisionalCatalogueComparison(
    roster,
    identity.summary,
  );
  if (
    !catalogueProvenance ||
    (
      catalogueProvenance.status !== "matched" &&
      !isForwardGameSystemRevisionOnlyDrift(catalogueProvenance)
    )
  ) {
    throw failClosed(
      "NEW_RECRUIT_MUTATION_ARTIFACT_INCOMPATIBLE",
      `The recovery artifact recorded by run ${attempt.runId} no longer matches this roster's frozen New Recruit identity. No new list was created.`,
    );
  }
  return {
    ok: true,
    data: {
      rosterId: roster.id,
      rosterName: identity.summary.rosterName,
      uiIdentity: null,
      listUrl: event.remoteId,
      imported: false,
      sessionReused: true,
      cacheReused: true,
      connectorEvents: [
        event,
        {
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          recordedAt: new Date().toISOString(),
          provider: "new-recruit",
          action: "prepare",
          origin: "manifest-reuse",
          outcome: "reused",
          remoteId: event.remoteId,
          contentSha256: enrichedSha256,
        },
      ],
      verification: null,
      enrichedSummary: identity.summary,
      catalogueProvenance,
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: path.basename(artifact.sourceRoszPath),
          mimeType: "application/zip",
          written: artifact.sourceRoszPath,
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: path.basename(artifact.enrichedRoszPath),
          mimeType: "application/zip",
          written: artifact.enrichedRoszPath,
        },
      ],
    },
    violations: [],
    warnings: [
      {
        code: "NEW_RECRUIT_MUTATION_ARTIFACT_REUSED",
        message:
          `Reused the hash-verified artifacts retained by New Recruit mutation run ${attempt.runId}; no remote list was created.`,
        severity: "warn",
      },
    ],
  };
}

/**
 * Adopt a sealed enriched artifact after a compatible data migration without
 * creating another New Recruit list. The gameplay shape and newly expected
 * catalogue identity must both match exactly.
 */
export async function adoptNewRecruitMutationArtifactAcrossRosterRevision(
  previousRoster: RosterDraftV1,
  nextRoster: RosterDraftV1,
): Promise<ResultEnvelope<NewRecruitDelivery> | null> {
  if (
    rosterStructuralFingerprint(previousRoster) !==
    rosterStructuralFingerprint(nextRoster)
  ) {
    return null;
  }
  const receipt = await readNewRecruitMutationReceipt(previousRoster);
  const recovered = await verifiedMutationRecoveryArtifact(receipt);
  if (!recovered) return null;
  const { attempt, artifact, event, enrichedContent } = recovered;
  const identity = validateEnrichedRoszGameplayIdentity(
    enrichedContent,
    nextRoster,
  );
  const catalogueProvenance = provisionalCatalogueComparison(
    nextRoster,
    identity.summary,
  );
  if (!catalogueProvenance || catalogueProvenance.status !== "matched") {
    return null;
  }
  const reusedEvent: ConnectorEvent = {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
    provider: "new-recruit",
    action: "prepare",
    origin: "manifest-reuse",
    outcome: "reused",
    remoteId: event.remoteId,
    contentSha256: artifact.enrichedRoszSha256,
  };
  const delivery: ResultEnvelope<NewRecruitDelivery> = {
    ok: true,
    data: {
      rosterId: nextRoster.id,
      rosterName: identity.summary.rosterName,
      uiIdentity: null,
      listUrl: event.remoteId,
      imported: false,
      sessionReused: true,
      cacheReused: true,
      connectorEvents: [event, reusedEvent],
      verification: null,
      enrichedSummary: identity.summary,
      catalogueProvenance,
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: path.basename(artifact.sourceRoszPath),
          mimeType: "application/zip",
          written: artifact.sourceRoszPath,
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: path.basename(artifact.enrichedRoszPath),
          mimeType: "application/zip",
          written: artifact.enrichedRoszPath,
        },
      ],
    },
    violations: [],
    warnings: [
      {
        code: "NEW_RECRUIT_CROSS_REVISION_ARTIFACT_REUSED",
        message:
          `Reused the hash-verified New Recruit artifact from run ${attempt.runId} after exact gameplay and catalogue verification; no new list was created.`,
        severity: "warn",
      },
    ],
  };
  await storeNewRecruitCache(nextRoster, delivery, {
    runId: `compatibility-repair-${crypto.randomUUID()}`,
  });
  return delivery;
}

export async function loadNewRecruitRoszMutationRecoveryArtifact(input: {
  subject: NewRecruitRoszMutationSubject;
  expected: EnrichedRoszSummary;
}): Promise<ResultEnvelope<NewRecruitDelivery> | null> {
  const receipt = await readNewRecruitRoszMutationReceipt(input.subject);
  const recovered = await verifiedMutationRecoveryArtifact(receipt);
  if (!recovered) return null;
  const { attempt, artifact, event, enrichedContent } = recovered;
  const summary = validateEnrichedRosz(enrichedContent, {
    name: input.expected.rosterName,
    factionName: input.expected.factionName,
    totalPoints: input.expected.totalPoints,
    units: input.expected.units.map((unit) => ({
      name: unit.name,
      modelCount: unit.modelCount,
      ...(unit.points === undefined
        ? {}
        : { points: unit.points }),
    })),
  });
  return {
    ok: true,
    data: {
      rosterId: receipt!.rosterId,
      rosterName: summary.rosterName,
      uiIdentity: null,
      listUrl: event.remoteId,
      imported: false,
      sessionReused: true,
      cacheReused: true,
      connectorEvents: [
        event,
        {
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          recordedAt: new Date().toISOString(),
          provider: "new-recruit",
          action: "prepare",
          origin: "manifest-reuse",
          outcome: "reused",
          remoteId: event.remoteId,
          contentSha256: artifact.enrichedRoszSha256,
        },
      ],
      verification: null,
      enrichedSummary: summary,
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: path.basename(artifact.sourceRoszPath),
          mimeType: "application/zip",
          written: artifact.sourceRoszPath,
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: path.basename(artifact.enrichedRoszPath),
          mimeType: "application/zip",
          written: artifact.enrichedRoszPath,
        },
      ],
    },
    violations: [],
    warnings: [
      {
        code: "NEW_RECRUIT_MUTATION_ARTIFACT_REUSED",
        message:
          `Reused the hash-verified uploaded-ROSZ artifacts retained by New Recruit mutation run ${attempt.runId}; no remote list was created.`,
        severity: "warn",
      },
    ],
  };
}

async function regularRoszFilesInside(
  root: string,
  maximumDepth = 8,
  maximumFiles = 1_000,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maximumDepth) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(root, candidate);
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        entry.isSymbolicLink()
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
      } else if (
        entry.isFile() &&
        candidate.toLocaleLowerCase().endsWith(".rosz")
      ) {
        files.push(candidate);
        if (files.length > maximumFiles) {
          throw failClosed(
            "NEW_RECRUIT_LEGACY_ARTIFACT_AMBIGUOUS",
            "The retained Tessera run contains too many ROSZ files for bounded legacy recovery.",
          );
        }
      }
    }
  };
  await visit(root, 0);
  return files;
}

/**
 * One-time, local-only migration for a created mutation from a release that
 * predates recovery receipts. The exact durable Tessera job is supplied by
 * the operator; this function never scans outside that job and performs no
 * browser or network activity.
 */
export async function restoreNewRecruitMutationArtifactFromTesseraRun(input: {
  roster: RosterDraftV1;
  jobPath: string;
}): Promise<ResultEnvelope<NewRecruitDelivery>> {
  const jobPath = path.resolve(input.jobPath);
  const jobRoot = path.dirname(jobPath);
  const [jobMetadata, rootMetadata] = await Promise.all([
    lstat(jobPath).catch(() => null),
    lstat(jobRoot).catch(() => null),
  ]);
  if (
    path.basename(jobPath) !== "tessera-run.json" ||
    !jobMetadata?.isFile() ||
    jobMetadata.isSymbolicLink() ||
    !rootMetadata?.isDirectory() ||
    rootMetadata.isSymbolicLink()
  ) {
    throw failClosed(
      "NEW_RECRUIT_LEGACY_JOB_INVALID",
      "Legacy recovery requires an exact regular tessera-run.json and its non-symlink job directory.",
    );
  }
  let job: {
    jobKind?: unknown;
    runId?: unknown;
    jobDirectory?: unknown;
    requestPath?: unknown;
  };
  try {
    job = JSON.parse(await readFile(jobPath, "utf8")) as typeof job;
  } catch {
    throw failClosed(
      "NEW_RECRUIT_LEGACY_JOB_INVALID",
      "The supplied Tessera job manifest is not valid JSON.",
    );
  }
  if (
    job.jobKind !== "rosterpilot-tessera-run" ||
    typeof job.runId !== "string" ||
    typeof job.jobDirectory !== "string" ||
    path.resolve(job.jobDirectory) !== jobRoot ||
    typeof job.requestPath !== "string" ||
    path.resolve(job.requestPath) !== jobPath
  ) {
    throw failClosed(
      "NEW_RECRUIT_LEGACY_JOB_INVALID",
      "The supplied Tessera job does not bind its run ID and job directory to this manifest.",
    );
  }
  const receipt = await readNewRecruitMutationReceipt(input.roster);
  const attempt = receipt?.attempts.find(
    (candidate) =>
      candidate.runId === job.runId && candidate.outcome === "created",
  );
  if (!receipt || !attempt || !attempt.connectorEvent) {
    throw failClosed(
      "NEW_RECRUIT_LEGACY_RECEIPT_MISSING",
      `No created New Recruit mutation receipt is bound to Tessera run ${job.runId}.`,
    );
  }
  if (attempt.recoveryArtifact) {
    try {
      const recovered =
        await loadNewRecruitMutationRecoveryArtifact(input.roster);
      if (recovered) return recovered;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        code !== "NEW_RECRUIT_MUTATION_ARTIFACT_MISSING" &&
        code !== "NEW_RECRUIT_MUTATION_ARTIFACT_CHANGED"
      ) {
        throw error;
      }
      // A moved or deleted old run can be rebound only through the exact job
      // and hashes supplied below.
    }
  }
  if (
    !attempt.expectedSourceRoszSha256 ||
    !attempt.connectorEvent.contentSha256
  ) {
    throw failClosed(
      "NEW_RECRUIT_LEGACY_RECEIPT_INCOMPLETE",
      "The legacy mutation receipt does not contain both source and enriched content hashes.",
    );
  }
  const candidates = await regularRoszFilesInside(jobRoot);
  const matches = new Map<string, string[]>();
  for (const candidate of candidates) {
    const digest = await verifiedRegularFileSha256(
      candidate,
      "legacy ROSZ",
    );
    const entries = matches.get(digest) ?? [];
    entries.push(candidate);
    matches.set(digest, entries);
  }
  const sourceMatches = matches.get(attempt.expectedSourceRoszSha256) ?? [];
  const enrichedMatches =
    matches.get(attempt.connectorEvent.contentSha256) ?? [];
  if (sourceMatches.length !== 1 || enrichedMatches.length !== 1) {
    throw failClosed(
      "NEW_RECRUIT_LEGACY_ARTIFACT_AMBIGUOUS",
      `Tessera run ${job.runId} must contain exactly one source and one enriched ROSZ matching the sealed mutation hashes.`,
    );
  }
  const sourceRoszPath = sourceMatches[0]!;
  const enrichedRoszPath = enrichedMatches[0]!;
  const identity = validateEnrichedRoszGameplayIdentity(
    await readFile(enrichedRoszPath),
    input.roster,
  );
  const catalogueProvenance = provisionalCatalogueComparison(
    input.roster,
    identity.summary,
  );
  if (
    !catalogueProvenance ||
    (
      catalogueProvenance.status !== "matched" &&
      !isForwardGameSystemRevisionOnlyDrift(catalogueProvenance)
    )
  ) {
    throw failClosed(
      "NEW_RECRUIT_LEGACY_ARTIFACT_INCOMPATIBLE",
      "Legacy recovery accepts only an identity-complete, profile-complete artifact with matching provenance or forward game-system-revision-only drift.",
    );
  }
  const cacheKey = newRecruitCacheKey(input.roster);
  const filename = mutationReceiptPath(cacheKey);
  const release = await acquireDirectoryLease(
    mutationReceiptLockPath(cacheKey),
  );
  try {
    const current = await readMutationReceiptFile(filename);
    if (!current) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_RECEIPT_MISSING",
        "The mutation receipt disappeared during legacy artifact recovery.",
      );
    }
    assertReceiptProvenance(current, input.roster);
    const currentAttempt = current.attempts.find(
      (candidate) =>
        candidate.runId === job.runId && candidate.outcome === "created",
    );
    if (!currentAttempt) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_ATTEMPT_MISSING",
        "The created mutation attempt disappeared during legacy artifact recovery.",
      );
    }
    if (
      currentAttempt.expectedSourceRoszSha256 !==
        attempt.expectedSourceRoszSha256 ||
      currentAttempt.connectorEvent?.contentSha256 !==
        attempt.connectorEvent.contentSha256
    ) {
      throw failClosed(
        "NEW_RECRUIT_MUTATION_EVIDENCE_CONFLICT",
        "The mutation evidence changed during legacy artifact recovery.",
      );
    }
    const recoveryArtifact =
      await persistMutationRecoveryArtifact({
        cacheKey,
        sourceRoszPath,
        enrichedRoszPath,
        expectedSourceRoszSha256:
          attempt.expectedSourceRoszSha256,
        expectedEnrichedRoszSha256:
          attempt.connectorEvent.contentSha256,
      });
    currentAttempt.recoveryArtifact = recoveryArtifact;
    const sealed = resealMutationReceipt(current);
    await atomicWriteJson(filename, sealed);
    await ensureFinalizedInventory(sealed);
  } finally {
    await release();
  }
  const restored =
    await loadNewRecruitMutationRecoveryArtifact(input.roster);
  if (!restored) {
    throw failClosed(
      "NEW_RECRUIT_LEGACY_ARTIFACT_RESTORE_FAILED",
      "The verified legacy artifact could not be reopened from the mutation recovery store.",
    );
  }
  restored.warnings.unshift({
    code: "NEW_RECRUIT_LEGACY_ARTIFACT_RESTORED",
    message:
      `Restored the hash-verified artifact from Tessera run ${job.runId}; no New Recruit or Tessera activity occurred.`,
    severity: "warn",
  });
  return restored;
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
      !sourceDataMatchesForExport(receipt.sourceData, roster.sourceData) ||
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
