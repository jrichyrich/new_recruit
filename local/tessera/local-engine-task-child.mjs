import crypto from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import path from "node:path";

const MAXIMUM_FILE_BYTES = 128 * 1024 * 1024;

function canonicalJson(value, active = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
  }
  if (active.has(value)) {
    throw new TypeError("Canonical JSON does not support cyclic values.");
  }
  if (Array.isArray(value)) {
    active.add(value);
    try {
      return `[${value
        .map((entry, index) => {
          if (!(index in value)) {
            throw new TypeError("Canonical JSON does not support sparse arrays.");
          }
          return canonicalJson(entry, active);
        })
        .join(",")}]`;
    } finally {
      active.delete(value);
    }
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON requires plain objects.");
  }
  active.add(value);
  try {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key], active)}`,
      )
      .join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function parseTaskRequest(candidate) {
  if (!candidate || typeof candidate !== "object" || candidate.type !== "task") {
    throw new TypeError("The local-engine child received an invalid request.");
  }
  const sequence = Number(candidate.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError("The local-engine child sequence is invalid.");
  }
  for (const key of [
    "taskFile",
    "resultFile",
    "taskFileSha256",
    "taskId",
  ]) {
    if (typeof candidate[key] !== "string" || candidate[key].length === 0) {
      throw new TypeError(`The local-engine child request has invalid ${key}.`);
    }
  }
  return {
    taskFile: path.resolve(candidate.taskFile),
    resultFile: path.resolve(candidate.resultFile),
    taskFileSha256: candidate.taskFileSha256,
    sequence,
    taskId: candidate.taskId,
  };
}

function remoteError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message:
      error instanceof Error
        ? error.message
        : "The local-engine child failed with a non-Error value.",
    code:
      error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : null,
  };
}

async function readCanonicalFile(filePath) {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAXIMUM_FILE_BYTES
  ) {
    throw new TypeError("The local-engine task file is not a bounded regular file.");
  }
  const raw = await readFile(filePath, "utf8");
  const value = JSON.parse(raw);
  if (`${canonicalJson(value)}\n` !== raw) {
    throw new TypeError("The local-engine task file is not canonical JSON.");
  }
  return { raw, value };
}

async function writeCanonicalResult(resultFile, core) {
  const value = {
    ...core,
    resultSha256: sha256(canonicalJson(core)),
  };
  const raw = `${canonicalJson(value)}\n`;
  const temporary = `${resultFile}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, resultFile);
  await chmod(resultFile, 0o400);
}

async function runTask(argumentsValue) {
  const { raw, value } = await readCanonicalFile(argumentsValue.taskFile);
  if (sha256(raw) !== argumentsValue.taskFileSha256) {
    throw new TypeError("The local-engine task-file hash does not match.");
  }
  if (
    value.schemaVersion !== 1 ||
    value.sequence !== argumentsValue.sequence ||
    value.taskId !== argumentsValue.taskId ||
    value.taskSha256 !==
      sha256(
        canonicalJson({
          schemaVersion: value.schemaVersion,
          sequence: value.sequence,
          taskId: value.taskId,
          moduleUrl: value.moduleUrl,
          exportName: value.exportName,
          payload: value.payload,
          payloadSha256: value.payloadSha256,
        }),
      ) ||
    value.payloadSha256 !== sha256(canonicalJson(value.payload))
  ) {
    throw new TypeError("The local-engine task envelope failed integrity checks.");
  }

  let handler;
  try {
    const importedModule = await import(value.moduleUrl);
    handler = importedModule[value.exportName];
    if (typeof handler !== "function") {
      throw new TypeError(
        `The local-engine worker module does not export ${JSON.stringify(value.exportName)}.`,
      );
    }
  } catch (error) {
    return {
      outcome: "initialization-error",
      error: remoteError(error),
    };
  }

  try {
    const previousTaskFile = process.env.ROSTERPILOT_LOCAL_ENGINE_TASK_FILE;
    process.env.ROSTERPILOT_LOCAL_ENGINE_TASK_FILE = argumentsValue.taskFile;
    let result;
    try {
      result = await handler(deepFreeze(value.payload));
    } finally {
      if (previousTaskFile === undefined) {
        delete process.env.ROSTERPILOT_LOCAL_ENGINE_TASK_FILE;
      } else {
        process.env.ROSTERPILOT_LOCAL_ENGINE_TASK_FILE = previousTaskFile;
      }
    }
    const resultJson = canonicalJson(result);
    return {
      outcome: "success",
      value: JSON.parse(resultJson),
      valueSha256: sha256(resultJson),
    };
  } catch (error) {
    return {
      outcome: "task-error",
      error: remoteError(error),
    };
  }
}

async function handleTaskRequest(candidate) {
  let request;
  try {
    request = parseTaskRequest(candidate);
    let taskResult = await runTask(request);
    try {
      const currentTask = await readFile(request.taskFile, "utf8");
      if (sha256(currentTask) !== request.taskFileSha256) {
        throw new TypeError("The sealed task file changed during execution.");
      }
    } catch (error) {
      taskResult = {
        outcome: "protocol-error",
        error: remoteError(error),
      };
    }
    await writeCanonicalResult(request.resultFile, {
      schemaVersion: 1,
      sequence: request.sequence,
      taskId: request.taskId,
      inputFileSha256: request.taskFileSha256,
      ...taskResult,
    });
    process.send?.({ type: "complete", sequence: request.sequence });
  } catch (error) {
    if (request) {
      try {
        await writeCanonicalResult(request.resultFile, {
          schemaVersion: 1,
          sequence: request.sequence,
          taskId: request.taskId,
          inputFileSha256: request.taskFileSha256,
          outcome: "protocol-error",
          error: remoteError(error),
        });
        process.send?.({ type: "complete", sequence: request.sequence });
        return;
      } catch {
        // The coordinator will treat the child exit as a failed attempt.
      }
    }
    process.send?.({
      type: "fatal",
      sequence:
        candidate && Number.isSafeInteger(candidate.sequence)
          ? candidate.sequence
          : null,
      error: remoteError(error),
    });
    process.exitCode = 70;
  }
}

if (process.argv.length !== 3 || process.argv[2] !== "--server") {
  process.exitCode = 64;
} else if (typeof process.send !== "function") {
  process.exitCode = 70;
} else {
  let busy = false;
  process.on("message", async (candidate) => {
    if (busy) {
      process.send?.({
        type: "fatal",
        sequence: null,
        error: {
          name: "Error",
          message: "The coordinator dispatched work to a busy child process.",
          code: "LOCAL_ENGINE_CHILD_BUSY",
        },
      });
      process.exitCode = 70;
      return;
    }
    busy = true;
    try {
      await handleTaskRequest(candidate);
    } finally {
      busy = false;
    }
  });
  process.send({ type: "ready" });
}
