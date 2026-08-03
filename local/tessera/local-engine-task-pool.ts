import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";

const DEFAULT_WORKER_EXPORT = "runLocalTesseraEngineMatchup";
const MAXIMUM_TASK_ID_LENGTH = 128;
const MAXIMUM_ORDER_KEY_LENGTH = 1_024;
const MAXIMUM_FILE_BYTES = 128 * 1024 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CHILD_MODULE = fileURLToPath(
  new URL("./local-engine-task-child.mjs", import.meta.url),
);

export type LocalEngineTaskPoolTask<TPayload = unknown> = Readonly<{
  id: string;
  orderKey: string;
  payload: TPayload;
}>;

export type LocalEngineTaskPoolResult<TResult = unknown> = Readonly<{
  id: string;
  orderKey: string;
  value: TResult;
}>;

export type LocalEngineTaskPoolOptions = Readonly<{
  poolSize?: number;
  signal?: AbortSignal;
  workerModule?: string | URL;
  workerExport?: string;
  workerExecArgv?: readonly string[];
  /** Process crashes may be retried; task and integrity failures never are. */
  maxTaskAttempts?: number;
}>;

export type LocalEngineTaskPoolErrorCode =
  | "LOCAL_ENGINE_POOL_ABORTED"
  | "LOCAL_ENGINE_POOL_INVALID_CONFIGURATION"
  | "LOCAL_ENGINE_POOL_INVALID_TASK"
  | "LOCAL_ENGINE_POOL_WORKER_INITIALIZATION_FAILED"
  | "LOCAL_ENGINE_POOL_WORKER_EXITED"
  | "LOCAL_ENGINE_POOL_PROTOCOL_ERROR"
  | "LOCAL_ENGINE_POOL_TASK_FAILED";

export class LocalEngineTaskPoolError extends Error {
  readonly code: LocalEngineTaskPoolErrorCode;
  readonly taskId: string | null;
  readonly remoteCode: string | null;

  constructor(
    code: LocalEngineTaskPoolErrorCode,
    message: string,
    options: {
      taskId?: string | null;
      remoteCode?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "LocalEngineTaskPoolError";
    this.code = code;
    this.taskId = options.taskId ?? null;
    this.remoteCode = options.remoteCode ?? null;
  }
}

type NormalizedTask = Readonly<{
  id: string;
  orderKey: string;
  payload: unknown;
}>;

type TaskEnvelopeCore = Readonly<{
  schemaVersion: 1;
  sequence: number;
  taskId: string;
  moduleUrl: string;
  exportName: string;
  payload: unknown;
  payloadSha256: string;
}>;

type RemoteError = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
};

type ChildResult = {
  schemaVersion?: unknown;
  sequence?: unknown;
  taskId?: unknown;
  inputFileSha256?: unknown;
  outcome?: unknown;
  value?: unknown;
  valueSha256?: unknown;
  error?: RemoteError;
  resultSha256?: unknown;
  [key: string]: unknown;
};

type ProcessSlot = {
  readonly index: number;
  child: ChildProcess | null;
};

type ChildControlMessage = {
  type?: unknown;
  sequence?: unknown;
  error?: RemoteError;
};

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function canonicalClone<T = unknown>(value: unknown): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function invalidTask(message: string): never {
  throw new LocalEngineTaskPoolError(
    "LOCAL_ENGINE_POOL_INVALID_TASK",
    message,
  );
}

function normalizeTasks(
  tasks: readonly LocalEngineTaskPoolTask[],
): NormalizedTask[] {
  const ids = new Set<string>();
  const normalized = tasks.map((task, index) => {
    if (
      typeof task.id !== "string" ||
      task.id.length === 0 ||
      task.id.length > MAXIMUM_TASK_ID_LENGTH ||
      !TASK_ID_PATTERN.test(task.id)
    ) {
      invalidTask(
        `Local-engine task ${index} has an invalid id; use 1-${MAXIMUM_TASK_ID_LENGTH} letters, numbers, dots, underscores, colons, or hyphens.`,
      );
    }
    if (ids.has(task.id)) {
      invalidTask(
        `Local-engine task id ${JSON.stringify(task.id)} is duplicated.`,
      );
    }
    ids.add(task.id);
    if (
      typeof task.orderKey !== "string" ||
      task.orderKey.length === 0 ||
      task.orderKey.length > MAXIMUM_ORDER_KEY_LENGTH
    ) {
      invalidTask(
        `Local-engine task ${JSON.stringify(task.id)} has an invalid canonical order key.`,
      );
    }
    let payload: unknown;
    try {
      payload = canonicalClone(task.payload);
    } catch (error) {
      invalidTask(
        `Local-engine task ${JSON.stringify(task.id)} is not canonical JSON: ${error instanceof Error ? error.message : "unknown serialization failure"}`,
      );
    }
    return Object.freeze({
      id: task.id,
      orderKey: task.orderKey,
      payload,
    });
  });
  return normalized.sort(
    (left, right) =>
      compareText(left.orderKey, right.orderKey) ||
      compareText(left.id, right.id),
  );
}

export function defaultLocalEngineTaskPoolSize(
  parallelism: number = availableParallelism(),
): number {
  const normalized = Number.isFinite(parallelism)
    ? Math.max(1, Math.floor(parallelism))
    : 1;
  return Math.min(3, Math.max(1, normalized - 1));
}

function configuredPoolSize(value: number | undefined): number {
  if (value === undefined) return defaultLocalEngineTaskPoolSize();
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_INVALID_CONFIGURATION",
      "The local-engine process-pool size must be an integer from 1 through 64.",
    );
  }
  return value;
}

function configuredTaskAttempts(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_INVALID_CONFIGURATION",
      "Local-engine process attempts must be an integer from 1 through 5.",
    );
  }
  return value;
}

function configuredExecArgv(value: readonly string[] | undefined): string[] {
  const entries = value ? [...value] : ["--import", "tsx"];
  if (
    entries.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 4_096 ||
        entry.includes("\0"),
    )
  ) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_INVALID_CONFIGURATION",
      "The local-engine child runtime arguments are invalid.",
    );
  }
  return entries;
}

async function workerModuleUrl(value: string | URL | undefined): Promise<string> {
  const candidate =
    value instanceof URL
      ? new URL(value.href)
      : value === undefined
        ? new URL("./local-engine.ts", import.meta.url)
        : pathToFileURL(path.resolve(value));
  if (candidate.protocol !== "file:") {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_INVALID_CONFIGURATION",
      "The local-engine worker module must be a local file URL.",
    );
  }
  let metadata;
  try {
    metadata = await lstat(fileURLToPath(candidate));
  } catch {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_INVALID_CONFIGURATION",
      `The local-engine worker module does not exist: ${fileURLToPath(candidate)}.`,
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_INVALID_CONFIGURATION",
      "The local-engine worker module must be a regular, non-symlinked file.",
    );
  }
  return candidate.href;
}

function remoteMessage(error: RemoteError | undefined): string {
  return typeof error?.message === "string" && error.message.length > 0
    ? error.message
    : "The child process did not provide an error message.";
}

function remoteCode(error: RemoteError | undefined): string | null {
  return typeof error?.code === "string" && error.code.length > 0
    ? error.code
    : null;
}

function abortedError(): LocalEngineTaskPoolError {
  return new LocalEngineTaskPoolError(
    "LOCAL_ENGINE_POOL_ABORTED",
    "The local-engine task pool was cancelled before all results completed.",
  );
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    ROSTERPILOT_LOCAL_ENGINE_CHILD: "1",
  };
  for (const name of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function writeImmutableTaskFile(
  filePath: string,
  core: TaskEnvelopeCore,
): Promise<string> {
  const envelope = {
    ...core,
    taskSha256: sha256(canonicalJson(core)),
  };
  const raw = `${canonicalJson(envelope)}\n`;
  if (Buffer.byteLength(raw) > MAXIMUM_FILE_BYTES) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_INVALID_TASK",
      `Local-engine task ${JSON.stringify(core.taskId)} exceeds the bounded task-file size.`,
      { taskId: core.taskId },
    );
  }
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o400);
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o222) !== 0
  ) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
      `Local-engine task ${JSON.stringify(core.taskId)} could not be sealed read-only.`,
      { taskId: core.taskId },
    );
  }
  return sha256(raw);
}

async function verifyInputFile(
  filePath: string,
  expectedSha256: string,
  taskId: string,
): Promise<void> {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAXIMUM_FILE_BYTES ||
    (metadata.mode & 0o222) !== 0
  ) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
      `Local-engine task ${JSON.stringify(taskId)} changed its immutable input file.`,
      { taskId },
    );
  }
  const raw = await readFile(filePath, "utf8");
  if (sha256(raw) !== expectedSha256) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
      `Local-engine task ${JSON.stringify(taskId)} changed its sealed input hash.`,
      { taskId },
    );
  }
}

async function readVerifiedResult<TResult>(
  filePath: string,
  task: NormalizedTask,
  sequence: number,
  inputFileSha256: string,
): Promise<TResult> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
      `Local-engine task ${JSON.stringify(task.id)} exited without an isolated result file.`,
      { taskId: task.id },
    );
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAXIMUM_FILE_BYTES ||
    (metadata.mode & 0o222) !== 0
  ) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
      `Local-engine task ${JSON.stringify(task.id)} produced an invalid result file.`,
      { taskId: task.id },
    );
  }
  let parsed: ChildResult;
  const raw = await readFile(filePath, "utf8");
  try {
    parsed = JSON.parse(raw) as ChildResult;
    if (`${canonicalJson(parsed)}\n` !== raw) {
      throw new TypeError("result JSON is not canonical");
    }
  } catch (error) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
      `Local-engine task ${JSON.stringify(task.id)} produced unreadable result evidence: ${error instanceof Error ? error.message : "unknown parse failure"}.`,
      { taskId: task.id },
    );
  }

  const { resultSha256, ...resultCore } = parsed;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.sequence !== sequence ||
    parsed.taskId !== task.id ||
    parsed.inputFileSha256 !== inputFileSha256 ||
    typeof resultSha256 !== "string" ||
    resultSha256 !== sha256(canonicalJson(resultCore))
  ) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
      `Local-engine task ${JSON.stringify(task.id)} produced a result with invalid identity or hashes.`,
      { taskId: task.id },
    );
  }

  if (parsed.outcome === "initialization-error") {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_WORKER_INITIALIZATION_FAILED",
      `A local-engine child could not initialize: ${remoteMessage(parsed.error)}.`,
      { taskId: task.id, remoteCode: remoteCode(parsed.error) },
    );
  }
  if (parsed.outcome === "protocol-error") {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
      `Local-engine task ${JSON.stringify(task.id)} failed its child protocol: ${remoteMessage(parsed.error)}.`,
      { taskId: task.id, remoteCode: remoteCode(parsed.error) },
    );
  }
  if (parsed.outcome === "task-error") {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_TASK_FAILED",
      `Local-engine task ${JSON.stringify(task.id)} failed: ${remoteMessage(parsed.error)}.`,
      { taskId: task.id, remoteCode: remoteCode(parsed.error) },
    );
  }
  if (
    parsed.outcome !== "success" ||
    typeof parsed.valueSha256 !== "string" ||
    parsed.valueSha256 !== sha256(canonicalJson(parsed.value))
  ) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
      `Local-engine task ${JSON.stringify(task.id)} returned an invalid canonical value.`,
      { taskId: task.id },
    );
  }
  return canonicalClone<TResult>(parsed.value);
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const forced = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 500);
  forced.unref();
  child.once("exit", () => clearTimeout(forced));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  terminateChild(child);
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1_000);
      timeout.unref();
    }),
  ]);
}

/**
 * Runs local-engine adapters in a bounded child-process pool. Every attempt
 * receives one sealed canonical task file and writes one sealed canonical
 * result file in an isolated temporary directory. The coordinator verifies
 * both files, owns retries and cancellation, and returns canonical ordering.
 */
export async function runLocalEngineTaskPool<TPayload, TResult>(
  tasks: readonly LocalEngineTaskPoolTask<TPayload>[],
  options: LocalEngineTaskPoolOptions = {},
): Promise<readonly LocalEngineTaskPoolResult<TResult>[]> {
  if (options.signal?.aborted) throw abortedError();
  const normalizedTasks = normalizeTasks(tasks);
  if (normalizedTasks.length === 0) return Object.freeze([]);
  const requestedPoolSize = configuredPoolSize(options.poolSize);
  const maximumAttempts = configuredTaskAttempts(options.maxTaskAttempts);
  const moduleUrl = await workerModuleUrl(options.workerModule);
  const exportName = options.workerExport ?? DEFAULT_WORKER_EXPORT;
  const execArgv = configuredExecArgv(options.workerExecArgv);
  if (
    exportName.length === 0 ||
    exportName.length > 256 ||
    exportName.includes("\0")
  ) {
    throw new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_INVALID_CONFIGURATION",
      "The local-engine worker export name is invalid.",
    );
  }
  if (options.signal?.aborted) throw abortedError();

  const poolRoot = await mkdtemp(
    path.join(tmpdir(), "rosterpilot-local-engine-pool-"),
  );
  const workerCount = Math.min(requestedPoolSize, normalizedTasks.length);
  const results = new Array<LocalEngineTaskPoolResult<TResult>>(
    normalizedTasks.length,
  );
  const processSlots: ProcessSlot[] = Array.from(
    { length: workerCount },
    (_, index) => ({ index, child: null }),
  );
  let nextSequence = 0;
  let batchFailure: LocalEngineTaskPoolError | null = null;

  const failBatch = (error: LocalEngineTaskPoolError): LocalEngineTaskPoolError => {
    if (batchFailure === null) {
      batchFailure = error;
      for (const slot of processSlots) {
        if (slot.child !== null) terminateChild(slot.child);
      }
    }
    return batchFailure;
  };
  const onAbort = (): void => {
    failBatch(abortedError());
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const startSlot = async (slot: ProcessSlot): Promise<ChildProcess> => {
    const current = slot.child;
    if (
      current !== null &&
      current.exitCode === null &&
      current.signalCode === null &&
      current.connected
    ) {
      return current;
    }
    slot.child = null;
    let child: ChildProcess;
    try {
      child = spawn(
        process.execPath,
        [...execArgv, CHILD_MODULE, "--server"],
        {
          cwd: process.cwd(),
          env: childEnvironment(),
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
    } catch (error) {
      throw new LocalEngineTaskPoolError(
        "LOCAL_ENGINE_POOL_WORKER_INITIALIZATION_FAILED",
        `Could not start local-engine process slot ${slot.index}: ${error instanceof Error ? error.message : "unknown process startup failure"}.`,
      );
    }
    slot.child = child;
    if (batchFailure !== null) terminateChild(child);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const complete = (error?: LocalEngineTaskPoolError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (candidate: unknown): void => {
        const message = candidate as ChildControlMessage;
        if (message?.type === "ready") {
          complete();
          return;
        }
        complete(
          new LocalEngineTaskPoolError(
            "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
            `Local-engine process slot ${slot.index} sent an unexpected startup message.`,
          ),
        );
      };
      const onError = (error: Error): void => {
        complete(
          new LocalEngineTaskPoolError(
            "LOCAL_ENGINE_POOL_WORKER_INITIALIZATION_FAILED",
            `Local-engine process slot ${slot.index} could not start: ${error.message}.`,
          ),
        );
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        slot.child = null;
        complete(
          new LocalEngineTaskPoolError(
            "LOCAL_ENGINE_POOL_WORKER_EXITED",
            `Local-engine process slot ${slot.index} exited during startup (exit ${code ?? "none"}, signal ${signal ?? "none"}).`,
          ),
        );
      };
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    return child;
  };

  const dispatchToSlot = async (
    slot: ProcessSlot,
    request: {
      taskFile: string;
      resultFile: string;
      taskFileSha256: string;
      sequence: number;
      taskId: string;
    },
  ): Promise<void> => {
    const child = await startSlot(slot);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const complete = (error?: LocalEngineTaskPoolError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (candidate: unknown): void => {
        const message = candidate as ChildControlMessage;
        if (
          message?.type === "complete" &&
          message.sequence === request.sequence
        ) {
          complete();
          return;
        }
        if (message?.type === "fatal") {
          complete(
            new LocalEngineTaskPoolError(
              "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
              `Local-engine task ${JSON.stringify(request.taskId)} received a fatal child-protocol response: ${remoteMessage(message.error)}.`,
              {
                taskId: request.taskId,
                remoteCode: remoteCode(message.error),
              },
            ),
          );
          return;
        }
        complete(
          new LocalEngineTaskPoolError(
            "LOCAL_ENGINE_POOL_PROTOCOL_ERROR",
            `Local-engine task ${JSON.stringify(request.taskId)} received an unexpected child response.`,
            { taskId: request.taskId },
          ),
        );
      };
      const onError = (error: Error): void => {
        slot.child = null;
        complete(
          new LocalEngineTaskPoolError(
            "LOCAL_ENGINE_POOL_WORKER_EXITED",
            `Local-engine task ${JSON.stringify(request.taskId)} lost its child process: ${error.message}.`,
            { taskId: request.taskId },
          ),
        );
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        slot.child = null;
        complete(
          new LocalEngineTaskPoolError(
            "LOCAL_ENGINE_POOL_WORKER_EXITED",
            `Local-engine task ${JSON.stringify(request.taskId)} exited before producing verified evidence (exit ${code ?? "none"}, signal ${signal ?? "none"}).`,
            { taskId: request.taskId },
          ),
        );
      };
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
      child.send(
        {
          type: "task",
          ...request,
        },
        (error) => {
          if (!error) return;
          complete(
            new LocalEngineTaskPoolError(
              "LOCAL_ENGINE_POOL_WORKER_EXITED",
              `Local-engine task ${JSON.stringify(request.taskId)} could not reach its child process: ${error.message}.`,
              { taskId: request.taskId },
            ),
          );
        },
      );
    });
  };

  const runAttempt = async (
    slot: ProcessSlot,
    task: NormalizedTask,
    sequence: number,
    attempt: number,
  ): Promise<TResult> => {
    if (batchFailure !== null) throw batchFailure;
    const attemptDirectory = path.join(
      poolRoot,
      `${String(sequence).padStart(4, "0")}-${String(attempt).padStart(2, "0")}`,
    );
    await mkdir(attemptDirectory, { mode: 0o700 });
    const taskFile = path.join(attemptDirectory, "task.json");
    const resultFile = path.join(attemptDirectory, "result.json");
    const payloadSha256 = sha256(canonicalJson(task.payload));
    const inputFileSha256 = await writeImmutableTaskFile(taskFile, {
      schemaVersion: 1,
      sequence,
      taskId: task.id,
      moduleUrl,
      exportName,
      payload: task.payload,
      payloadSha256,
    });
    if (batchFailure !== null) throw batchFailure;
    await dispatchToSlot(slot, {
      taskFile,
      resultFile,
      taskFileSha256: inputFileSha256,
      sequence,
      taskId: task.id,
    });
    if (batchFailure !== null) throw batchFailure;
    await verifyInputFile(taskFile, inputFileSha256, task.id);
    return readVerifiedResult<TResult>(
      resultFile,
      task,
      sequence,
      inputFileSha256,
    );
  };

  const runTask = async (
    slot: ProcessSlot,
    task: NormalizedTask,
    sequence: number,
  ): Promise<TResult> => {
    let latestError: LocalEngineTaskPoolError | null = null;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await runAttempt(slot, task, sequence, attempt);
      } catch (error) {
        const normalizedError =
          error instanceof LocalEngineTaskPoolError
            ? error
            : new LocalEngineTaskPoolError(
                "LOCAL_ENGINE_POOL_WORKER_EXITED",
                `Local-engine task ${JSON.stringify(task.id)} failed outside the child protocol: ${error instanceof Error ? error.message : "unknown process failure"}.`,
                { taskId: task.id },
              );
        latestError = normalizedError;
        if (
          normalizedError.code !== "LOCAL_ENGINE_POOL_WORKER_EXITED" ||
          attempt === maximumAttempts ||
          batchFailure !== null
        ) {
          throw normalizedError;
        }
      }
    }
    throw latestError ?? new LocalEngineTaskPoolError(
      "LOCAL_ENGINE_POOL_WORKER_EXITED",
      `Local-engine task ${JSON.stringify(task.id)} exhausted its process attempts.`,
      { taskId: task.id },
    );
  };

  const workerLoop = async (slot: ProcessSlot): Promise<void> => {
    while (batchFailure === null) {
      const sequence = nextSequence;
      if (sequence >= normalizedTasks.length) return;
      nextSequence += 1;
      const task = normalizedTasks[sequence];
      try {
        const value = await runTask(slot, task, sequence);
        results[sequence] = Object.freeze({
          id: task.id,
          orderKey: task.orderKey,
          value,
        });
      } catch (error) {
        throw failBatch(
          error instanceof LocalEngineTaskPoolError
            ? error
            : new LocalEngineTaskPoolError(
                "LOCAL_ENGINE_POOL_WORKER_EXITED",
                `Local-engine task ${JSON.stringify(task.id)} failed unexpectedly.`,
                { taskId: task.id },
              ),
        );
      }
    }
    throw batchFailure;
  };

  try {
    if (options.signal?.aborted) onAbort();
    await Promise.all(processSlots.map((slot) => workerLoop(slot)));
    if (batchFailure !== null) throw batchFailure;
    return Object.freeze([...results]);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await Promise.allSettled(
      processSlots.map(async (slot) => {
        const child = slot.child;
        slot.child = null;
        if (child !== null) await stopChild(child);
      }),
    );
    await rm(poolRoot, { recursive: true, force: true });
  }
}
