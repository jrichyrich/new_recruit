import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  AppendWorkflowReliabilityEventInput,
  TimingSpanV1Schema,
  WorkflowReliabilityEventV1Schema,
  WorkflowReliabilityHeadV1Schema,
  WorkflowReliabilityRefV1Schema,
  WorkflowReliabilityRegistryV1Schema,
  type WorkflowReliabilityAppendResult,
  type WorkflowReliabilityEventV1,
  type WorkflowReliabilityHeadV1,
  type WorkflowReliabilityHistory,
  type WorkflowReliabilityReconciliationResult,
  type WorkflowReliabilityRefV1,
  type WorkflowReliabilityRegistryEntryV1,
  type WorkflowReliabilityRegistryV1,
  type WorkflowReliabilityVerification,
  type WorkflowReliabilityVerificationIssue,
} from "./types";
import {
  sanitizeReliabilityAttributes,
  sanitizeReliabilityError,
  sanitizeReliabilityText,
} from "./sanitize";

const STORE_VERSION = "v1";
const EVENT_FILE_PATTERN = /^(\d{12})-([0-9a-f]{64})\.json$/;
const MAX_RECORD_BYTES = 4 * 1_024 * 1_024;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(value: unknown): string {
  return digest(canonicalJson(value));
}

function withoutKey<T extends Record<string, unknown>, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export class WorkflowReliabilityStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowReliabilityStoreError";
    this.code = code;
  }
}

export function workflowReliabilityKey(
  workflow: WorkflowReliabilityRefV1,
): string {
  const normalized = WorkflowReliabilityRefV1Schema.parse(workflow);
  return canonicalDigest(normalized);
}

export function workflowReliabilityEventId(
  workflow: WorkflowReliabilityRefV1,
  idempotencyKey: string,
): string {
  return canonicalDigest({
    workflowKey: workflowReliabilityKey(workflow),
    idempotencyKey,
  });
}

export type WorkflowReliabilityStorePaths = {
  versionRoot: string;
  registryPath: string;
  workflowsRoot: string;
  workflowDirectory: string;
  eventsDirectory: string;
  headPath: string;
  lockDirectory: string;
};

export function workflowReliabilityStorePaths(
  rootDirectory: string,
  workflow: WorkflowReliabilityRefV1,
): WorkflowReliabilityStorePaths {
  const versionRoot = path.join(path.resolve(rootDirectory), STORE_VERSION);
  const workflowsRoot = path.join(versionRoot, "workflows");
  const key = workflowReliabilityKey(workflow);
  const workflowDirectory = path.join(workflowsRoot, key);
  return {
    versionRoot,
    registryPath: path.join(versionRoot, "registry.json"),
    workflowsRoot,
    workflowDirectory,
    eventsDirectory: path.join(workflowDirectory, "events"),
    headPath: path.join(workflowDirectory, "head.json"),
    lockDirectory: path.join(versionRoot, ".store.lock"),
  };
}

function eventFilename(event: WorkflowReliabilityEventV1): string {
  return `${String(event.sequence).padStart(12, "0")}-${event.eventId}.json`;
}

function eventHash(event: Omit<WorkflowReliabilityEventV1, "eventSha256">) {
  return canonicalDigest(event);
}

function headIntegrity(
  head: Omit<WorkflowReliabilityHeadV1, "integritySha256">,
): string {
  return canonicalDigest(head);
}

function registryIntegrity(
  registry: Omit<WorkflowReliabilityRegistryV1, "integritySha256">,
): string {
  return canonicalDigest(registry);
}

function issue(
  code: WorkflowReliabilityVerificationIssue["code"],
  message: string,
  options: { sequence?: number | null; filename?: string | null } = {},
): WorkflowReliabilityVerificationIssue {
  return {
    code,
    message,
    sequence: options.sequence ?? null,
    filename: options.filename ?? null,
  };
}

async function readJsonFile(filename: string): Promise<unknown> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new WorkflowReliabilityStoreError(
      "RELIABILITY_PATH_INVALID",
      `${filename} is not a regular reliability record.`,
    );
  }
  if (metadata.size > MAX_RECORD_BYTES) {
    throw new WorkflowReliabilityStoreError(
      "RELIABILITY_RECORD_TOO_LARGE",
      `${filename} exceeds the reliability record size limit.`,
    );
  }
  return JSON.parse(await readFile(filename, "utf8"));
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function writeJsonAtomic(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${canonicalJson(value)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeImmutableJson(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, `${canonicalJson(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

type ScanResult = {
  events: WorkflowReliabilityEventV1[];
  issues: WorkflowReliabilityVerificationIssue[];
};

async function scanEvents(
  rootDirectory: string,
  workflow: WorkflowReliabilityRefV1,
): Promise<ScanResult> {
  const normalizedWorkflow = WorkflowReliabilityRefV1Schema.parse(workflow);
  const paths = workflowReliabilityStorePaths(rootDirectory, normalizedWorkflow);
  let filenames: string[];
  try {
    filenames = (await readdir(paths.eventsDirectory))
      .filter((filename) => filename.endsWith(".json"))
      .sort();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        events: [],
        issues: [
          issue(
            "EVENT_DIRECTORY_MISSING",
            "The workflow reliability event directory does not exist.",
          ),
        ],
      };
    }
    throw error;
  }
  const events: WorkflowReliabilityEventV1[] = [];
  const issues: WorkflowReliabilityVerificationIssue[] = [];
  let expectedSequence = 1;
  let previousEventSha256: string | null = null;
  for (const filename of filenames) {
    const match = EVENT_FILE_PATTERN.exec(filename);
    if (!match) {
      issues.push(
        issue(
          "EVENT_FILENAME_INVALID",
          "A reliability event filename is malformed.",
          { filename },
        ),
      );
      continue;
    }
    const filenameSequence = Number(match[1]);
    let event: WorkflowReliabilityEventV1;
    try {
      event = WorkflowReliabilityEventV1Schema.parse(
        await readJsonFile(path.join(paths.eventsDirectory, filename)),
      ) as WorkflowReliabilityEventV1;
    } catch (error) {
      issues.push(
        issue(
          "EVENT_INVALID",
          `Reliability event ${filename} is unreadable or malformed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { filename, sequence: filenameSequence },
        ),
      );
      continue;
    }
    events.push(event);
    if (
      event.sequence !== expectedSequence ||
      filenameSequence !== expectedSequence
    ) {
      issues.push(
        issue(
          "EVENT_SEQUENCE_GAP",
          `Expected reliability event sequence ${expectedSequence}, found ${event.sequence}.`,
          { filename, sequence: event.sequence },
        ),
      );
    }
    if (eventFilename(event) !== filename) {
      issues.push(
        issue(
          "EVENT_FILENAME_MISMATCH",
          "The reliability event filename does not match its sequence and event ID.",
          { filename, sequence: event.sequence },
        ),
      );
    }
    if (canonicalJson(event.workflow) !== canonicalJson(normalizedWorkflow)) {
      issues.push(
        issue(
          "EVENT_WORKFLOW_MISMATCH",
          "A reliability event belongs to a different workflow.",
          { filename, sequence: event.sequence },
        ),
      );
    }
    const expectedEventId = workflowReliabilityEventId(
      event.workflow,
      event.idempotencyKey,
    );
    if (event.eventId !== expectedEventId) {
      issues.push(
        issue(
          "EVENT_ID_MISMATCH",
          "The reliability event ID is not bound to its workflow and idempotency key.",
          { filename, sequence: event.sequence },
        ),
      );
    }
    const expectedHash = eventHash(
      withoutKey(
        event as unknown as Record<string, unknown>,
        "eventSha256",
      ) as Omit<WorkflowReliabilityEventV1, "eventSha256">,
    );
    if (event.eventSha256 !== expectedHash) {
      issues.push(
        issue(
          "EVENT_HASH_MISMATCH",
          "The reliability event hash does not match its content.",
          { filename, sequence: event.sequence },
        ),
      );
    }
    if (event.previousEventSha256 !== previousEventSha256) {
      issues.push(
        issue(
          "EVENT_PREVIOUS_HASH_MISMATCH",
          "The reliability event does not continue the preceding hash chain.",
          { filename, sequence: event.sequence },
        ),
      );
    }
    expectedSequence = event.sequence + 1;
    previousEventSha256 = event.eventSha256;
  }
  return { events, issues };
}

function expectedHead(
  workflow: WorkflowReliabilityRefV1,
  events: WorkflowReliabilityEventV1[],
): WorkflowReliabilityHeadV1 {
  const last = events.at(-1) ?? null;
  const draft: Omit<WorkflowReliabilityHeadV1, "integritySha256"> = {
    schemaVersion: 1,
    recordKind: "workflow-reliability-head",
    workflow,
    workflowKey: workflowReliabilityKey(workflow),
    eventCount: events.length,
    lastSequence: last?.sequence ?? 0,
    lastEventSha256: last?.eventSha256 ?? null,
    updatedAt: last?.recordedAt ?? new Date(0).toISOString(),
  };
  return WorkflowReliabilityHeadV1Schema.parse({
    ...draft,
    integritySha256: headIntegrity(draft),
  });
}

async function readHead(
  filename: string,
): Promise<WorkflowReliabilityHeadV1 | null> {
  if (!(await pathExists(filename))) return null;
  return WorkflowReliabilityHeadV1Schema.parse(await readJsonFile(filename));
}

function registryEntry(
  head: WorkflowReliabilityHeadV1,
): WorkflowReliabilityRegistryEntryV1 {
  return {
    workflow: head.workflow,
    workflowKey: head.workflowKey,
    directory: head.workflowKey,
    eventCount: head.eventCount,
    lastSequence: head.lastSequence,
    lastEventSha256: head.lastEventSha256,
    updatedAt: head.updatedAt,
  };
}

function sealedRegistry(
  entries: WorkflowReliabilityRegistryEntryV1[],
): WorkflowReliabilityRegistryV1 {
  const sorted = [...entries].sort((left, right) =>
    left.workflowKey.localeCompare(right.workflowKey),
  );
  const draft: Omit<WorkflowReliabilityRegistryV1, "integritySha256"> = {
    schemaVersion: 1,
    recordKind: "workflow-reliability-registry",
    entries: sorted,
  };
  return WorkflowReliabilityRegistryV1Schema.parse({
    ...draft,
    integritySha256: registryIntegrity(draft),
  });
}

function verifyRegistryDocument(
  candidate: unknown,
): WorkflowReliabilityRegistryV1 {
  const registry = WorkflowReliabilityRegistryV1Schema.parse(candidate);
  const expectedIntegrity = registryIntegrity(
    withoutKey(
      registry as unknown as Record<string, unknown>,
      "integritySha256",
    ) as Omit<WorkflowReliabilityRegistryV1, "integritySha256">,
  );
  if (registry.integritySha256 !== expectedIntegrity) {
    throw new WorkflowReliabilityStoreError(
      "RELIABILITY_REGISTRY_TAMPERED",
      "The workflow reliability registry integrity hash does not match.",
    );
  }
  const keys = registry.entries.map((entry) => entry.workflowKey);
  if (
    new Set(keys).size !== keys.length ||
    canonicalJson(keys) !== canonicalJson([...keys].sort()) ||
    registry.entries.some(
      (entry) =>
        entry.directory !== entry.workflowKey ||
        workflowReliabilityKey(entry.workflow) !== entry.workflowKey,
    )
  ) {
    throw new WorkflowReliabilityStoreError(
      "RELIABILITY_REGISTRY_INVALID",
      "The workflow reliability registry is not canonical.",
    );
  }
  return registry;
}

async function readRegistry(
  filename: string,
): Promise<WorkflowReliabilityRegistryV1 | null> {
  if (!(await pathExists(filename))) return null;
  return verifyRegistryDocument(await readJsonFile(filename));
}

function eventIssuesOnly(
  issues: WorkflowReliabilityVerificationIssue[],
): WorkflowReliabilityVerificationIssue[] {
  return issues.filter((entry) => entry.code.startsWith("EVENT_"));
}

async function verification(
  rootDirectory: string,
  workflow: WorkflowReliabilityRefV1,
): Promise<{ verification: WorkflowReliabilityVerification; events: WorkflowReliabilityEventV1[] }> {
  const normalizedWorkflow = WorkflowReliabilityRefV1Schema.parse(workflow);
  const paths = workflowReliabilityStorePaths(rootDirectory, normalizedWorkflow);
  const scanned = await scanEvents(rootDirectory, normalizedWorkflow);
  const issues = [...scanned.issues];
  const expected = expectedHead(normalizedWorkflow, scanned.events);
  let head: WorkflowReliabilityHeadV1 | null = null;
  try {
    head = await readHead(paths.headPath);
    if (!head) {
      issues.push(issue("HEAD_MISSING", "The reliability head is missing."));
    } else {
      const headDraft = withoutKey(
        head as unknown as Record<string, unknown>,
        "integritySha256",
      ) as Omit<WorkflowReliabilityHeadV1, "integritySha256">;
      if (head.integritySha256 !== headIntegrity(headDraft)) {
        issues.push(
          issue("HEAD_INVALID", "The reliability head integrity hash does not match."),
        );
      } else if (canonicalJson(head) !== canonicalJson(expected)) {
        issues.push(
          issue(
            "HEAD_DIVERGED",
            "The reliability head does not identify the complete event chain.",
          ),
        );
      }
    }
  } catch (error) {
    issues.push(
      issue(
        "HEAD_INVALID",
        `The reliability head is malformed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
  try {
    const registry = await readRegistry(paths.registryPath);
    if (!registry) {
      issues.push(
        issue("REGISTRY_MISSING", "The reliability registry is missing."),
      );
    } else {
      const entry = registry.entries.find(
        (candidate) => candidate.workflowKey === expected.workflowKey,
      );
      if (!entry || canonicalJson(entry) !== canonicalJson(registryEntry(expected))) {
        issues.push(
          issue(
            "REGISTRY_DIVERGED",
            "The reliability registry does not identify this workflow head.",
          ),
        );
      }
    }
  } catch (error) {
    issues.push(
      issue(
        "REGISTRY_INVALID",
        `The reliability registry is malformed or tampered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
  return {
    events: scanned.events,
    verification: {
      ok: issues.length === 0,
      workflow: normalizedWorkflow,
      eventCount: scanned.events.length,
      lastSequence: scanned.events.at(-1)?.sequence ?? 0,
      lastEventSha256: scanned.events.at(-1)?.eventSha256 ?? null,
      head,
      issues,
    },
  };
}

function defaultExecutionStatus(
  outcome: AppendWorkflowReliabilityEventInput["outcome"],
) {
  switch (outcome) {
    case "started":
    case "in-progress":
      return "running" as const;
    case "succeeded":
    case "recovered":
      return "succeeded" as const;
    case "degraded":
      return "degraded" as const;
    case "inconclusive":
      return "inconclusive" as const;
    case "needs-input":
      return "needs-input" as const;
    case "failed":
      return "failed" as const;
    case "cancelled":
      return "cancelled" as const;
    default:
      return "not-started" as const;
  }
}

type NormalizedAppend = {
  eventMaterial: Omit<
    WorkflowReliabilityEventV1,
    "sequence" | "eventId" | "idempotencySha256" | "recordedAt" |
      "previousEventSha256" | "eventSha256"
  >;
  idempotencyMaterial: unknown;
};

function normalizeAppendInput(
  input: AppendWorkflowReliabilityEventInput,
  recordedAt: string,
): NormalizedAppend {
  const workflow = WorkflowReliabilityRefV1Schema.parse(input.workflow);
  const idempotencyKey = sanitizeReliabilityText(input.idempotencyKey).slice(
    0,
    512,
  );
  const eventKind = sanitizeReliabilityText(input.eventKind).slice(0, 256);
  const stage = input.stage
    ? sanitizeReliabilityText(input.stage).slice(0, 256)
    : null;
  const provider = input.provider
    ? sanitizeReliabilityText(input.provider).slice(0, 128)
    : null;
  const timings = (input.timings ?? []).map((span) =>
    TimingSpanV1Schema.parse(span),
  );
  const execution = {
    status:
      input.execution?.status ?? defaultExecutionStatus(input.outcome),
    attempt: input.execution?.attempt ?? null,
  };
  const evidence = {
    status: input.evidence?.status ?? "none",
    artifactCount: input.evidence?.artifactCount ?? 0,
    evidenceSha256: input.evidence?.evidenceSha256 ?? null,
  };
  const error = sanitizeReliabilityError(input.error);
  const attributes = sanitizeReliabilityAttributes(input.attributes);
  const occurredAt = input.occurredAt ?? recordedAt;
  const eventMaterial = {
    schemaVersion: 1 as const,
    recordKind: "workflow-reliability-event" as const,
    workflow,
    idempotencyKey,
    eventKind,
    stage,
    provider,
    outcome: input.outcome,
    occurredAt,
    timings,
    execution,
    evidence,
    error,
    attributes,
  };
  WorkflowReliabilityEventV1Schema.pick({
    schemaVersion: true,
    recordKind: true,
    workflow: true,
    idempotencyKey: true,
    eventKind: true,
    stage: true,
    provider: true,
    outcome: true,
    occurredAt: true,
    timings: true,
    execution: true,
    evidence: true,
    error: true,
    attributes: true,
  }).parse(eventMaterial);
  return {
    eventMaterial,
    idempotencyMaterial: {
      ...eventMaterial,
      occurredAt: input.occurredAt ?? null,
    },
  };
}

export type WorkflowReliabilityStoreOptions = {
  rootDirectory: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  dependencies?: {
    now?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
    onEventPersisted?: (
      event: WorkflowReliabilityEventV1,
      filename: string,
    ) => Promise<void> | void;
  };
};

export type WorkflowReliabilityEventStore = {
  rootDirectory: string;
  append(
    input: AppendWorkflowReliabilityEventInput,
  ): Promise<WorkflowReliabilityAppendResult>;
  verify(
    workflow: WorkflowReliabilityRefV1,
  ): Promise<WorkflowReliabilityVerification>;
  history(
    workflow: WorkflowReliabilityRefV1,
  ): Promise<WorkflowReliabilityHistory>;
  reconcile(
    workflow: WorkflowReliabilityRefV1,
  ): Promise<WorkflowReliabilityReconciliationResult>;
  rebuildRegistry(): Promise<WorkflowReliabilityRegistryV1>;
  listWorkflowRefs(): Promise<WorkflowReliabilityRefV1[]>;
};

export function createWorkflowReliabilityEventStore(
  options: WorkflowReliabilityStoreOptions,
): WorkflowReliabilityEventStore {
  const rootDirectory = path.resolve(options.rootDirectory);
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  const staleLockMs = options.staleLockMs ?? 30_000;
  const now = options.dependencies?.now ?? (() => new Date());
  const sleep =
    options.dependencies?.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const globalPaths = workflowReliabilityStorePaths(rootDirectory, {
    workflowId: "registry",
    workflowKind: "internal",
  });

  const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    await mkdir(globalPaths.versionRoot, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      try {
        await mkdir(globalPaths.lockDirectory, { mode: 0o700 });
        await writeFile(
          path.join(globalPaths.lockDirectory, "owner.json"),
          `${canonicalJson({ pid: process.pid, acquiredAt: now().toISOString() })}\n`,
          { flag: "wx", mode: 0o600 },
        );
        break;
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        const metadata = await stat(globalPaths.lockDirectory).catch(() => null);
        if (metadata && Date.now() - metadata.mtimeMs > staleLockMs) {
          const abandoned = `${globalPaths.lockDirectory}.abandoned.${randomUUID()}`;
          await rename(globalPaths.lockDirectory, abandoned).catch(() => undefined);
          await rm(abandoned, { recursive: true, force: true }).catch(
            () => undefined,
          );
          continue;
        }
        if (Date.now() >= deadline) {
          throw new WorkflowReliabilityStoreError(
            "RELIABILITY_STORE_BUSY",
            "The workflow reliability store is busy.",
          );
        }
        await sleep(10);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(globalPaths.lockDirectory, {
        recursive: true,
        force: true,
      });
    }
  };

  const rebuildRegistryUnlocked = async (): Promise<WorkflowReliabilityRegistryV1> => {
    let directories: string[] = [];
    try {
      directories = (await readdir(globalPaths.workflowsRoot, {
        withFileTypes: true,
      }))
        .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const entries: WorkflowReliabilityRegistryEntryV1[] = [];
    for (const directory of directories) {
      const eventsDirectory = path.join(
        globalPaths.workflowsRoot,
        directory,
        "events",
      );
      const firstFilename = (await readdir(eventsDirectory).catch(() => []))
        .filter((filename) => EVENT_FILE_PATTERN.test(filename))
        .sort()[0];
      if (!firstFilename) continue;
      const first = WorkflowReliabilityEventV1Schema.parse(
        await readJsonFile(path.join(eventsDirectory, firstFilename)),
      ) as WorkflowReliabilityEventV1;
      if (workflowReliabilityKey(first.workflow) !== directory) {
        throw new WorkflowReliabilityStoreError(
          "RELIABILITY_WORKFLOW_DIRECTORY_MISMATCH",
          "A reliability workflow directory does not match its events.",
        );
      }
      const scanned = await scanEvents(rootDirectory, first.workflow);
      if (eventIssuesOnly(scanned.issues).length > 0) {
        throw new WorkflowReliabilityStoreError(
          "RELIABILITY_EVENT_CHAIN_INVALID",
          `Cannot rebuild the registry because workflow ${first.workflow.workflowId} has an invalid event chain.`,
        );
      }
      const head = expectedHead(first.workflow, scanned.events);
      await writeJsonAtomic(
        workflowReliabilityStorePaths(rootDirectory, first.workflow).headPath,
        head,
      );
      entries.push(registryEntry(head));
    }
    const registry = sealedRegistry(entries);
    await writeJsonAtomic(globalPaths.registryPath, registry);
    return registry;
  };

  const reconcileUnlocked = async (
    workflow: WorkflowReliabilityRefV1,
  ): Promise<WorkflowReliabilityReconciliationResult> => {
    const normalizedWorkflow = WorkflowReliabilityRefV1Schema.parse(workflow);
    const paths = workflowReliabilityStorePaths(rootDirectory, normalizedWorkflow);
    const before = await verification(rootDirectory, normalizedWorkflow);
    const invalidEvents = eventIssuesOnly(before.verification.issues).filter(
      (entry) => entry.code !== "EVENT_DIRECTORY_MISSING",
    );
    if (invalidEvents.length > 0) {
      return {
        workflow: normalizedWorkflow,
        repairedHead: false,
        repairedRegistry: false,
        verification: before.verification,
      };
    }
    if (before.events.length === 0) {
      return {
        workflow: normalizedWorkflow,
        repairedHead: false,
        repairedRegistry: false,
        verification: before.verification,
      };
    }
    const expected = expectedHead(normalizedWorkflow, before.events);
    const repairedHead =
      before.verification.head === null ||
      canonicalJson(before.verification.head) !== canonicalJson(expected);
    if (repairedHead) await writeJsonAtomic(paths.headPath, expected);
    let repairedRegistry = false;
    try {
      const registry = await readRegistry(paths.registryPath);
      const expectedEntry = registryEntry(expected);
      const current = registry?.entries.find(
        (entry) => entry.workflowKey === expected.workflowKey,
      );
      if (!registry || canonicalJson(current) !== canonicalJson(expectedEntry)) {
        const entries = (registry?.entries ?? []).filter(
          (entry) => entry.workflowKey !== expected.workflowKey,
        );
        await writeJsonAtomic(
          paths.registryPath,
          sealedRegistry([...entries, expectedEntry]),
        );
        repairedRegistry = true;
      }
    } catch {
      await rebuildRegistryUnlocked();
      repairedRegistry = true;
    }
    const after = await verification(rootDirectory, normalizedWorkflow);
    return {
      workflow: normalizedWorkflow,
      repairedHead,
      repairedRegistry,
      verification: after.verification,
    };
  };

  return {
    rootDirectory,
    async append(input) {
      return withLock(async () => {
        const recordedAt = now().toISOString();
        const normalized = normalizeAppendInput(input, recordedAt);
        const workflow = normalized.eventMaterial.workflow;
        const paths = workflowReliabilityStorePaths(rootDirectory, workflow);
        await mkdir(paths.eventsDirectory, { recursive: true, mode: 0o700 });
        const scanned = await scanEvents(rootDirectory, workflow);
        const chainIssues = eventIssuesOnly(scanned.issues).filter(
          (entry) => entry.code !== "EVENT_DIRECTORY_MISSING",
        );
        if (chainIssues.length > 0) {
          throw new WorkflowReliabilityStoreError(
            "RELIABILITY_EVENT_CHAIN_INVALID",
            "The workflow reliability event chain is invalid; append was refused.",
          );
        }
        const idempotencySha256 = canonicalDigest(
          normalized.idempotencyMaterial,
        );
        const existing = scanned.events.find(
          (event) =>
            event.idempotencyKey ===
            normalized.eventMaterial.idempotencyKey,
        );
        if (existing) {
          if (existing.idempotencySha256 !== idempotencySha256) {
            throw new WorkflowReliabilityStoreError(
              "RELIABILITY_IDEMPOTENCY_CONFLICT",
              "The idempotency key was already used for different reliability evidence.",
            );
          }
          const reconciled = await reconcileUnlocked(workflow);
          if (!reconciled.verification.ok || !reconciled.verification.head) {
            throw new WorkflowReliabilityStoreError(
              "RELIABILITY_RECONCILIATION_FAILED",
              "The existing idempotent event could not be reconciled.",
            );
          }
          return {
            created: false,
            event: existing,
            head: reconciled.verification.head,
          };
        }
        const previous = scanned.events.at(-1) ?? null;
        const eventId = workflowReliabilityEventId(
          workflow,
          normalized.eventMaterial.idempotencyKey,
        );
        const draft = {
          ...normalized.eventMaterial,
          sequence: (previous?.sequence ?? 0) + 1,
          eventId,
          idempotencySha256,
          recordedAt,
          previousEventSha256: previous?.eventSha256 ?? null,
        };
        const event = WorkflowReliabilityEventV1Schema.parse({
          ...draft,
          eventSha256: eventHash(
            draft as Omit<WorkflowReliabilityEventV1, "eventSha256">,
          ),
        }) as WorkflowReliabilityEventV1;
        const filename = path.join(paths.eventsDirectory, eventFilename(event));
        await writeImmutableJson(filename, event);
        await options.dependencies?.onEventPersisted?.(event, filename);
        const head = expectedHead(workflow, [...scanned.events, event]);
        await writeJsonAtomic(paths.headPath, head);
        let registry: WorkflowReliabilityRegistryV1;
        try {
          registry =
            (await readRegistry(paths.registryPath)) ?? sealedRegistry([]);
        } catch {
          registry = await rebuildRegistryUnlocked();
        }
        const entries = registry.entries.filter(
          (entry) => entry.workflowKey !== head.workflowKey,
        );
        await writeJsonAtomic(
          paths.registryPath,
          sealedRegistry([...entries, registryEntry(head)]),
        );
        return { created: true, event, head };
      });
    },
    async verify(workflow) {
      return (await verification(rootDirectory, workflow)).verification;
    },
    async history(workflow) {
      const inspected = await verification(rootDirectory, workflow);
      return {
        workflow: inspected.verification.workflow,
        events: inspected.events,
        verification: inspected.verification,
      };
    },
    async reconcile(workflow) {
      return withLock(() => reconcileUnlocked(workflow));
    },
    async rebuildRegistry() {
      return withLock(() => rebuildRegistryUnlocked());
    },
    async listWorkflowRefs() {
      const registry = await readRegistry(globalPaths.registryPath);
      if (!registry) return [];
      return registry.entries.map((entry) => entry.workflow);
    },
  };
}
