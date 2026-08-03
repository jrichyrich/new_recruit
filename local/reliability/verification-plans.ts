import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  existsSync,
} from "node:fs";
import {
  lstat,
  readFile,
  readlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import { appendWorkflowReliabilityEventSafely } from "./adapters";
import { sanitizeReliabilityText } from "./sanitize";
import type { WorkflowReliabilityEventStore } from "./store";
import {
  reliabilityIsoDateSchema,
  reliabilitySha256Schema,
  WorkflowReliabilityRefV1Schema,
  type WorkflowReliabilityRefV1,
} from "./types";

const MAX_STEP_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const MAX_TAP_PARSE_BYTES = 512 * 1_024;
const MAX_GIT_LIST_BYTES = 16 * 1_024 * 1_024;
const MAX_GIT_DIFF_BYTES = 512 * 1_024 * 1_024;

export const RepairVerificationPlanNames = [
  "reliability-journal",
  "batch-preflight",
  "tessera-workers",
  "tessera-browser",
  "standard-cross-provider",
  "lint",
  "plugin-parity",
  "application-build",
  "complete-suite",
] as const;

export const RepairVerificationPlanNameSchema = z.enum(
  RepairVerificationPlanNames,
);
export type RepairVerificationPlanName = z.infer<
  typeof RepairVerificationPlanNameSchema
>;

type RepairVerificationTool = "node" | "npm";

export type RepairVerificationStepDescriptor = Readonly<{
  stepId: string;
  tool: RepairVerificationTool;
  arguments: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}>;

type RepairVerificationPlanDefinition = Readonly<{
  planName: RepairVerificationPlanName;
  description: string;
  steps: readonly RepairVerificationStepDescriptor[];
}>;

function nodeTestStep(
  stepId: string,
  testFiles: readonly string[],
  timeoutMs = 5 * 60_000,
): RepairVerificationStepDescriptor {
  return Object.freeze({
    stepId,
    tool: "node",
    arguments: Object.freeze([
      "--import",
      "tsx",
      "--test",
      ...testFiles,
    ]),
    timeoutMs,
    maxOutputBytes: MAX_STEP_OUTPUT_BYTES,
  });
}

function npmStep(
  stepId: string,
  scriptArguments: readonly string[],
  timeoutMs: number,
): RepairVerificationStepDescriptor {
  return Object.freeze({
    stepId,
    tool: "npm",
    arguments: Object.freeze([...scriptArguments]),
    timeoutMs,
    maxOutputBytes: MAX_STEP_OUTPUT_BYTES,
  });
}

const repairVerificationPlans = Object.freeze({
  "reliability-journal": Object.freeze({
    planName: "reliability-journal",
    description: "Focused workflow reliability journal verification.",
    steps: Object.freeze([
      nodeTestStep("workflow-reliability-tests", [
        "tests/workflow-reliability.test.ts",
        "tests/repair-verification-plans.test.ts",
        "tests/mcp-reliability.test.ts",
      ]),
    ]),
  }),
  "batch-preflight": Object.freeze({
    planName: "batch-preflight",
    description: "Fail-fast Tessera batch preflight verification.",
    steps: Object.freeze([
      nodeTestStep("batch-preflight-tests", [
        "tests/tessera-batch-preflight.test.ts",
        "tests/tessera-exact-integrity.test.ts",
      ]),
    ]),
  }),
  "tessera-workers": Object.freeze({
    planName: "tessera-workers",
    description: "Durable worker, local process-pool, and cache verification.",
    steps: Object.freeze([
      nodeTestStep(
        "tessera-worker-tests",
        [
          "tests/tessera-jobs.test.ts",
          "tests/tessera-local-engine-task-pool.test.ts",
          "tests/tessera-local-engine-result-cache.test.ts",
          "tests/new-recruit-companion.test.ts",
        ],
        10 * 60_000,
      ),
    ]),
  }),
  "tessera-browser": Object.freeze({
    planName: "tessera-browser",
    description: "Browser evidence, freshness, and connector verification.",
    steps: Object.freeze([
      nodeTestStep(
        "tessera-browser-tests",
        [
          "tests/tessera-browser-v2.test.ts",
          "tests/browser-fixture-execution.test.ts",
          "tests/tessera-saved-list-reuse.test.ts",
        ],
        10 * 60_000,
      ),
    ]),
  }),
  "standard-cross-provider": Object.freeze({
    planName: "standard-cross-provider",
    description:
      "Standard diverse-nine local and representative-three Web orchestration verification.",
    steps: Object.freeze([
      nodeTestStep(
        "standard-cross-provider-tests",
        [
          "tests/tessera-stress-orchestration.test.ts",
          "tests/tessera-stress-analysis.test.ts",
          "tests/tessera-interfaces-v2.test.ts",
        ],
        10 * 60_000,
      ),
    ]),
  }),
  lint: Object.freeze({
    planName: "lint",
    description: "Repository lint verification.",
    steps: Object.freeze([
      npmStep("lint", ["run", "lint"], 10 * 60_000),
    ]),
  }),
  "plugin-parity": Object.freeze({
    planName: "plugin-parity",
    description: "Portable plugin parity verification.",
    steps: Object.freeze([
      npmStep("plugin-parity", ["run", "plugin:check"], 10 * 60_000),
    ]),
  }),
  "application-build": Object.freeze({
    planName: "application-build",
    description: "Precompiled worker and application build verification.",
    steps: Object.freeze([
      npmStep("application-build", ["run", "build"], 20 * 60_000),
    ]),
  }),
  "complete-suite": Object.freeze({
    planName: "complete-suite",
    description: "Complete repository test and build verification.",
    steps: Object.freeze([
      npmStep("complete-suite", ["test"], 45 * 60_000),
    ]),
  }),
} satisfies Record<RepairVerificationPlanName, RepairVerificationPlanDefinition>);

export type RepairVerificationPlanDescription = {
  planName: RepairVerificationPlanName;
  description: string;
  stepIds: string[];
};

/** Returns metadata only. Executables and arguments are deliberately not exposed. */
export function listRepairVerificationPlans(): RepairVerificationPlanDescription[] {
  return RepairVerificationPlanNames.map((planName) => {
    const definition = repairVerificationPlans[planName];
    return {
      planName,
      description: definition.description,
      stepIds: definition.steps.map((step) => step.stepId),
    };
  });
}

export const RepairVerificationTestCountsV1Schema = z
  .object({
    tests: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative().nullable(),
    failed: z.number().int().nonnegative().nullable(),
    skipped: z.number().int().nonnegative().nullable(),
    todo: z.number().int().nonnegative().nullable(),
    suites: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type RepairVerificationTestCountsV1 = z.infer<
  typeof RepairVerificationTestCountsV1Schema
>;

const RepairVerificationOutputEvidenceV1Schema = z
  .object({
    boundedSha256: reliabilitySha256Schema,
    bytesObserved: z.number().int().nonnegative(),
    bytesHashed: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const RepairVerificationStepResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    stepId: z.string().min(1).max(128),
    tool: z.enum(["node", "npm"]),
    startedAt: reliabilityIsoDateSchema,
    endedAt: reliabilityIsoDateSchema,
    durationMs: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(64).nullable(),
    timedOut: z.boolean(),
    outputLimitExceeded: z.boolean(),
    spawnError: z.string().max(4_096).nullable(),
    passed: z.boolean(),
    testCounts: RepairVerificationTestCountsV1Schema.nullable(),
    stdout: RepairVerificationOutputEvidenceV1Schema,
    stderr: RepairVerificationOutputEvidenceV1Schema,
  })
  .strict();

export type RepairVerificationStepResultV1 = z.infer<
  typeof RepairVerificationStepResultV1Schema
>;

export const RepairVerificationChangedFileV1Schema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4_096)
      .refine(
        (value) =>
          !path.posix.isAbsolute(value) &&
          value !== ".." &&
          !value.startsWith("../") &&
          !value.includes("/../"),
        "Changed file paths must remain repository-relative.",
      ),
    sha256: reliabilitySha256Schema.nullable(),
    kind: z.enum(["file", "symlink", "deleted", "other"]),
  })
  .strict();

export type RepairVerificationChangedFileV1 = z.infer<
  typeof RepairVerificationChangedFileV1Schema
>;

export const RepairVerificationSourceStateV1Schema = z
  .object({
    gitHead: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
    clean: z.boolean(),
    changedFiles: z.array(RepairVerificationChangedFileV1Schema).max(20_000),
    dirtyDiffSha256: reliabilitySha256Schema,
    sourceFingerprint: reliabilitySha256Schema,
  })
  .strict();

export type RepairVerificationSourceStateV1 = z.infer<
  typeof RepairVerificationSourceStateV1Schema
>;

export const RepairVerificationToolchainV1Schema = z
  .object({
    nodeVersion: z.string().min(1).max(128),
    npmVersion: z.string().min(1).max(128).nullable(),
    typescriptVersion: z.string().min(1).max(128).nullable(),
    tsxVersion: z.string().min(1).max(128).nullable(),
    eslintVersion: z.string().min(1).max(128).nullable(),
    gitVersion: z.string().min(1).max(256).nullable(),
    platform: z.string().min(1).max(64),
    architecture: z.string().min(1).max(64),
    packageJsonSha256: reliabilitySha256Schema,
    packageLockSha256: reliabilitySha256Schema.nullable(),
  })
  .strict();

export type RepairVerificationToolchainV1 = z.infer<
  typeof RepairVerificationToolchainV1Schema
>;

export const RepairVerificationRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("repair-verification"),
    verificationId: z.string().uuid(),
    planName: RepairVerificationPlanNameSchema,
    startedAt: reliabilityIsoDateSchema,
    endedAt: reliabilityIsoDateSchema,
    durationMs: z.number().int().nonnegative(),
    passed: z.boolean(),
    sourceChangedDuringVerification: z.boolean(),
    sourceBeforeFingerprint: reliabilitySha256Schema,
    sourceAfter: RepairVerificationSourceStateV1Schema,
    toolchain: RepairVerificationToolchainV1Schema,
    steps: z.array(RepairVerificationStepResultV1Schema).min(1).max(32),
    recordSha256: reliabilitySha256Schema,
  })
  .strict();

export type RepairVerificationRecordV1 = z.infer<
  typeof RepairVerificationRecordV1Schema
>;

export type RepairVerificationJournalOptions = {
  store: WorkflowReliabilityEventStore;
  workflow: WorkflowReliabilityRefV1;
  idempotencyKey?: string;
  stage?: string;
  provider?: string | null;
};

export type RepairVerificationJournalResult = {
  attempted: boolean;
  appended: boolean;
  eventSha256: string | null;
  warning: string | null;
};

export type RunRepairVerificationPlanInput = {
  planName: RepairVerificationPlanName;
  repositoryRoot: string;
  journal?: RepairVerificationJournalOptions;
};

export type RunRepairVerificationPlanResult = {
  record: RepairVerificationRecordV1;
  journal: RepairVerificationJournalResult;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sealedRecord(
  value: Omit<RepairVerificationRecordV1, "recordSha256">,
): RepairVerificationRecordV1 {
  return RepairVerificationRecordV1Schema.parse({
    ...value,
    recordSha256: sha256(canonicalJson(value)),
  });
}

export function verifyRepairVerificationRecord(
  value: unknown,
): RepairVerificationRecordV1 {
  const record = RepairVerificationRecordV1Schema.parse(value);
  const { recordSha256, ...unsigned } = record;
  if (sha256(canonicalJson(unsigned)) !== recordSha256) {
    throw new Error("The repair-verification record hash does not match.");
  }
  return record;
}

function parseCount(output: string, label: string): number | null {
  const matches = [
    ...output.matchAll(
      new RegExp(`^(?:#|ℹ) ${label} (\\d+)\\s*$`, "gm"),
    ),
  ];
  const value = matches.at(-1)?.[1];
  return value === undefined ? null : Number(value);
}

export function parseRepairVerificationTestCounts(
  output: string,
): RepairVerificationTestCountsV1 | null {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const tests = parseCount(plain, "tests");
  if (tests === null) return null;
  return RepairVerificationTestCountsV1Schema.parse({
    tests,
    passed: parseCount(plain, "pass"),
    failed: parseCount(plain, "fail"),
    skipped: parseCount(plain, "skipped"),
    todo: parseCount(plain, "todo"),
    suites: parseCount(plain, "suites"),
  });
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const retained = [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SHELL",
    "TMPDIR",
  ] as const;
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    NODE_ENV: "test",
    npm_config_loglevel: "warn",
  };
  for (const key of retained) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function terminateChild(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    child.kill(signal);
  }
}

async function executeStep(
  step: RepairVerificationStepDescriptor,
  repositoryRoot: string,
  now: () => Date,
): Promise<RepairVerificationStepResultV1> {
  const startedAt = now();
  const executable =
    step.tool === "node"
      ? process.execPath
      : process.platform === "win32"
        ? "npm.cmd"
        : "npm";
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutObserved = 0;
  let stderrObserved = 0;
  let stdoutHashed = 0;
  let stderrHashed = 0;
  let parseBytes = 0;
  const parseChunks: Buffer[] = [];
  let outputLimitExceeded = false;
  let timedOut = false;
  let spawnError: string | null = null;
  let forcedTermination: ReturnType<typeof setTimeout> | null = null;

  const child = spawn(executable, [...step.arguments], {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const requestTermination = () => {
    terminateChild(child);
    if (forcedTermination) return;
    forcedTermination = setTimeout(() => {
      terminateChild(child, "SIGKILL");
    }, 2_000);
    forcedTermination.unref();
  };

  const capture = (
    chunk: Buffer,
    stream: "stdout" | "stderr",
  ) => {
    if (stream === "stdout") stdoutObserved += chunk.byteLength;
    else stderrObserved += chunk.byteLength;
    const currentHashed =
      stream === "stdout" ? stdoutHashed : stderrHashed;
    const remaining = Math.max(0, step.maxOutputBytes - currentHashed);
    const bounded = chunk.subarray(0, remaining);
    if (bounded.byteLength > 0) {
      if (stream === "stdout") {
        stdoutHash.update(bounded);
        stdoutHashed += bounded.byteLength;
      } else {
        stderrHash.update(bounded);
        stderrHashed += bounded.byteLength;
      }
      if (parseBytes < MAX_TAP_PARSE_BYTES) {
        const parseChunk = bounded.subarray(
          0,
          MAX_TAP_PARSE_BYTES - parseBytes,
        );
        parseChunks.push(parseChunk);
        parseBytes += parseChunk.byteLength;
      }
    }
    if (chunk.byteLength > remaining && !outputLimitExceeded) {
      outputLimitExceeded = true;
      requestTermination();
    }
  };
  child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
  child.once("error", (error) => {
    spawnError = sanitizeReliabilityText(error.message);
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    requestTermination();
  }, step.timeoutMs);
  timeout.unref();
  const closed = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timeout);
  if (forcedTermination) clearTimeout(forcedTermination);
  const endedAt = now();
  const testCounts = parseRepairVerificationTestCounts(
    Buffer.concat(parseChunks).toString("utf8"),
  );
  const passed =
    closed.exitCode === 0 &&
    !closed.signal &&
    !timedOut &&
    !outputLimitExceeded &&
    spawnError === null;
  return RepairVerificationStepResultV1Schema.parse({
    schemaVersion: 1,
    stepId: step.stepId,
    tool: step.tool,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    exitCode: closed.exitCode,
    signal: closed.signal,
    timedOut,
    outputLimitExceeded,
    spawnError,
    passed,
    testCounts,
    stdout: {
      boundedSha256: stdoutHash.digest("hex"),
      bytesObserved: stdoutObserved,
      bytesHashed: stdoutHashed,
      truncated: stdoutObserved > stdoutHashed,
    },
    stderr: {
      boundedSha256: stderrHash.digest("hex"),
      bytesObserved: stderrObserved,
      bytesHashed: stderrHashed,
      truncated: stderrObserved > stderrHashed,
    },
  });
}

async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function runGitCollect(
  repositoryRoot: string,
  arguments_: readonly string[],
  maxBytes = MAX_GIT_LIST_BYTES,
): Promise<Buffer> {
  const child = spawn("git", [...arguments_], {
    cwd: repositoryRoot,
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size <= maxBytes) chunks.push(chunk);
    else terminateChild(child);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.concat(errors).byteLength < 16_384) errors.push(chunk);
  });
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
  }>((resolve) => {
    let spawnFailure: Error | null = null;
    child.once("error", (error) => {
      spawnFailure = error;
    });
    child.once("close", (code, signal) =>
      resolve({ code, signal, error: spawnFailure }),
    );
  });
  if (size > maxBytes) {
    throw new Error("Git evidence exceeded the bounded output limit.");
  }
  if (result.error || result.code !== 0 || result.signal) {
    const detail = sanitizeReliabilityText(
      Buffer.concat(errors).toString("utf8").trim(),
    );
    throw new Error(
      detail || result.error?.message || "Git evidence collection failed.",
    );
  }
  return Buffer.concat(chunks);
}

async function runGitHash(
  repositoryRoot: string,
  arguments_: readonly string[],
): Promise<string> {
  const child = spawn("git", [...arguments_], {
    cwd: repositoryRoot,
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const hash = createHash("sha256");
  let size = 0;
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size <= MAX_GIT_DIFF_BYTES) hash.update(chunk);
    else terminateChild(child);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.concat(errors).byteLength < 16_384) errors.push(chunk);
  });
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (size > MAX_GIT_DIFF_BYTES) {
    throw new Error("The dirty diff exceeded the evidence size limit.");
  }
  if (result.code !== 0 || result.signal) {
    throw new Error(
      sanitizeReliabilityText(
        Buffer.concat(errors).toString("utf8").trim(),
      ) || "The dirty diff could not be hashed.",
    );
  }
  return hash.digest("hex");
}

function decodeNullSeparated(value: Buffer): string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function normalizeChangedPath(value: string): string {
  const normalized = value.split(path.sep).join(path.posix.sep);
  RepairVerificationChangedFileV1Schema.shape.path.parse(normalized);
  return normalized;
}

async function changedFileEvidence(
  repositoryRoot: string,
  relativePath: string,
): Promise<RepairVerificationChangedFileV1> {
  const normalized = normalizeChangedPath(relativePath);
  const filename = path.resolve(repositoryRoot, normalized);
  const relative = path.relative(repositoryRoot, filename);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("A changed file escaped the repository root.");
  }
  try {
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink()) {
      return {
        path: normalized,
        sha256: sha256(`symlink\0${await readlink(filename)}`),
        kind: "symlink",
      };
    }
    if (metadata.isFile()) {
      return {
        path: normalized,
        sha256: await hashFile(filename),
        kind: "file",
      };
    }
    return {
      path: normalized,
      sha256: sha256(`other\0${metadata.mode}`),
      kind: "other",
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { path: normalized, sha256: null, kind: "deleted" };
    }
    throw error;
  }
}

async function resolveGitHead(repositoryRoot: string): Promise<string | null> {
  try {
    return (
      await runGitCollect(repositoryRoot, ["rev-parse", "--verify", "HEAD"])
    )
      .toString("utf8")
      .trim();
  } catch {
    return null;
  }
}

async function assertRosterPilotRepository(
  requestedRoot: string,
): Promise<string> {
  const root = await realpath(path.resolve(requestedRoot));
  const packageDocument = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as { name?: unknown };
  if (packageDocument.name !== "rosterpilot") {
    throw new Error("Repair verification requires a RosterPilot checkout.");
  }
  const gitRoot = await realpath(
    (
      await runGitCollect(root, ["rev-parse", "--show-toplevel"])
    )
      .toString("utf8")
      .trim(),
  );
  if (gitRoot !== root) {
    throw new Error("Repair verification must run at the Git checkout root.");
  }
  return root;
}

async function repairVerificationWorktreeIsClean(
  repositoryRoot: string,
): Promise<boolean> {
  const gitHead = await resolveGitHead(repositoryRoot);
  if (!gitHead) return false;
  const [tracked, untracked] = await Promise.all([
    runGitCollect(repositoryRoot, [
      "diff",
      "--name-only",
      "-z",
      "HEAD",
      "--",
    ]),
    runGitCollect(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  return tracked.byteLength === 0 && untracked.byteLength === 0;
}

export async function captureRepairVerificationSourceState(
  requestedRoot: string,
): Promise<RepairVerificationSourceStateV1> {
  const repositoryRoot = await assertRosterPilotRepository(requestedRoot);
  const gitHead = await resolveGitHead(repositoryRoot);
  const trackedArguments = gitHead
    ? ["diff", "--name-only", "-z", "HEAD", "--"]
    : ["ls-files", "-z"];
  const [tracked, untracked] = await Promise.all([
    runGitCollect(repositoryRoot, trackedArguments),
    runGitCollect(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  const paths = [
    ...new Set([
      ...decodeNullSeparated(tracked),
      ...decodeNullSeparated(untracked),
    ]),
  ].sort();
  const changedFiles = await Promise.all(
    paths.map((filename) => changedFileEvidence(repositoryRoot, filename)),
  );
  const trackedDiffSha256 = await runGitHash(
    repositoryRoot,
    gitHead
      ? ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]
      : ["diff", "--cached", "--binary", "--no-ext-diff", "--"],
  );
  const dirtyDiffSha256 = sha256(
    canonicalJson({ trackedDiffSha256, changedFiles }),
  );
  return RepairVerificationSourceStateV1Schema.parse({
    gitHead,
    clean: changedFiles.length === 0,
    changedFiles,
    dirtyDiffSha256,
    sourceFingerprint: sha256(
      canonicalJson({ gitHead, dirtyDiffSha256, changedFiles }),
    ),
  });
}

async function readPackageVersion(
  repositoryRoot: string,
  packageName: string,
): Promise<string | null> {
  try {
    const value = JSON.parse(
      await readFile(
        path.join(repositoryRoot, "node_modules", packageName, "package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

async function captureRepairVerificationToolchain(
  repositoryRoot: string,
): Promise<RepairVerificationToolchainV1> {
  const packageJson = path.join(repositoryRoot, "package.json");
  const packageLock = path.join(repositoryRoot, "package-lock.json");
  const version = async (
    executable: string,
    arguments_: readonly string[],
  ): Promise<string | null> => {
    try {
      return sanitizeReliabilityText(
        (
          await runGitCollect(
            repositoryRoot,
            executable === "git" ? arguments_ : ["--version"],
            64 * 1_024,
          )
        )
          .toString("utf8")
          .trim(),
      );
    } catch {
      return null;
    }
  };
  let npmVersion: string | null = null;
  try {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", [
      "--version",
    ], {
      cwd: repositoryRoot,
      env: safeEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const code = await new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    if (code === 0) {
      npmVersion = sanitizeReliabilityText(
        Buffer.concat(chunks).toString("utf8").trim(),
      );
    }
  } catch {
    npmVersion = null;
  }
  return RepairVerificationToolchainV1Schema.parse({
    nodeVersion: process.version,
    npmVersion,
    typescriptVersion: await readPackageVersion(repositoryRoot, "typescript"),
    tsxVersion: await readPackageVersion(repositoryRoot, "tsx"),
    eslintVersion: await readPackageVersion(repositoryRoot, "eslint"),
    gitVersion: await version("git", ["--version"]),
    platform: process.platform,
    architecture: process.arch,
    packageJsonSha256: await hashFile(packageJson),
    packageLockSha256: existsSync(packageLock)
      ? await hashFile(packageLock)
      : null,
  });
}

export type RepairVerificationPlanRuntime = {
  now(): Date;
  captureSourceState(root: string): Promise<RepairVerificationSourceStateV1>;
  captureToolchain(root: string): Promise<RepairVerificationToolchainV1>;
  executeStep(
    step: RepairVerificationStepDescriptor,
    root: string,
    now: () => Date,
  ): Promise<RepairVerificationStepResultV1>;
};

const defaultRuntime: RepairVerificationPlanRuntime = {
  now: () => new Date(),
  captureSourceState: captureRepairVerificationSourceState,
  captureToolchain: captureRepairVerificationToolchain,
  executeStep,
};

async function appendVerificationEvent(
  record: RepairVerificationRecordV1,
  options: RepairVerificationJournalOptions | undefined,
): Promise<RepairVerificationJournalResult> {
  if (!options) {
    return {
      attempted: false,
      appended: false,
      eventSha256: null,
      warning: null,
    };
  }
  const workflow = WorkflowReliabilityRefV1Schema.parse(options.workflow);
  const result = await appendWorkflowReliabilityEventSafely(options.store, {
    workflow,
    idempotencyKey:
      options.idempotencyKey ??
      `repair-verification:${record.verificationId}`,
    eventKind: "verification",
    stage: options.stage ?? "repair-verification",
    provider: options.provider ?? null,
    outcome: record.passed ? "succeeded" : "failed",
    occurredAt: record.endedAt,
    execution: {
      status: record.passed ? "succeeded" : "failed",
      attempt: null,
    },
    evidence: {
      status: record.passed ? "verified" : "invalid",
      artifactCount: 1,
      evidenceSha256: record.recordSha256,
    },
    error: record.passed
      ? null
      : {
          code: "REPAIR_VERIFICATION_FAILED",
          message: "The allowlisted repair-verification plan did not pass.",
          retryable: true,
        },
    attributes: {
      planName: record.planName,
      verificationId: record.verificationId,
      verificationRecordSha256: record.recordSha256,
      verificationGitHead: record.sourceAfter.gitHead,
      sourceFingerprint: record.sourceAfter.sourceFingerprint,
      dirtyDiffSha256: record.sourceAfter.dirtyDiffSha256,
      changedFiles: record.sourceAfter.changedFiles,
      sourceChangedDuringVerification:
        record.sourceChangedDuringVerification,
      toolchain: record.toolchain,
      steps: record.steps.map((step) => ({
        stepId: step.stepId,
        passed: step.passed,
        testCounts: step.testCounts,
        stdoutSha256: step.stdout.boundedSha256,
        stderrSha256: step.stderr.boundedSha256,
      })),
    },
  });
  if (!result.ok) {
    return {
      attempted: true,
      appended: false,
      eventSha256: null,
      warning: result.error.message,
    };
  }
  return {
    attempted: true,
    appended: result.data.created,
    eventSha256: result.data.event.eventSha256,
    warning: null,
  };
}

/**
 * Creates a runner whose command choices remain the module-owned static
 * allowlist. Runtime injection is available for deterministic unit tests; it
 * cannot add a plan, executable, argument, or step.
 */
export function createRepairVerificationPlanRunner(
  runtime: RepairVerificationPlanRuntime = defaultRuntime,
): {
  run(
    input: RunRepairVerificationPlanInput,
  ): Promise<RunRepairVerificationPlanResult>;
} {
  return {
    async run(input) {
      const planName = RepairVerificationPlanNameSchema.parse(input.planName);
      const repositoryRoot = await assertRosterPilotRepository(
        input.repositoryRoot,
      );
      const definition = repairVerificationPlans[planName];
      const startedAt = runtime.now();
      const [sourceBefore, toolchain] = await Promise.all([
        runtime.captureSourceState(repositoryRoot),
        runtime.captureToolchain(repositoryRoot),
      ]);
      const steps: RepairVerificationStepResultV1[] = [];
      for (const step of definition.steps) {
        steps.push(
          RepairVerificationStepResultV1Schema.parse(
            await runtime.executeStep(step, repositoryRoot, runtime.now),
          ),
        );
        if (!steps.at(-1)?.passed) break;
      }
      const sourceAfter = await runtime.captureSourceState(repositoryRoot);
      const endedAt = runtime.now();
      const sourceChangedDuringVerification =
        sourceBefore.sourceFingerprint !== sourceAfter.sourceFingerprint;
      const record = sealedRecord({
        schemaVersion: 1,
        recordKind: "repair-verification",
        verificationId: randomUUID(),
        planName,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        passed:
          steps.length === definition.steps.length &&
          steps.every((step) => step.passed) &&
          !sourceChangedDuringVerification,
        sourceChangedDuringVerification,
        sourceBeforeFingerprint: sourceBefore.sourceFingerprint,
        sourceAfter,
        toolchain,
        steps,
      });
      return {
        record,
        journal: await appendVerificationEvent(record, input.journal),
      };
    },
  };
}

export function runRepairVerificationPlan(
  input: RunRepairVerificationPlanInput,
): Promise<RunRepairVerificationPlanResult> {
  return createRepairVerificationPlanRunner().run(input);
}

export type RepairVerificationCommitAssociation = {
  matched: boolean;
  commit: string | null;
  reason:
    | "matched"
    | "verification-failed"
    | "no-repaired-files"
    | "worktree-not-clean"
    | "file-state-mismatch";
  journal: RepairVerificationJournalResult;
};

/**
 * Associates a later clean commit only when every file recorded in the
 * repaired dirty state still has the same content (or remains deleted).
 */
export async function associateRepairVerificationCommit(input: {
  record: RepairVerificationRecordV1;
  repositoryRoot: string;
  journal?: RepairVerificationJournalOptions;
}): Promise<RepairVerificationCommitAssociation> {
  const record = verifyRepairVerificationRecord(input.record);
  const emptyJournal: RepairVerificationJournalResult = {
    attempted: false,
    appended: false,
    eventSha256: null,
    warning: null,
  };
  if (!record.passed) {
    return {
      matched: false,
      commit: null,
      reason: "verification-failed",
      journal: emptyJournal,
    };
  }
  if (record.sourceAfter.changedFiles.length === 0) {
    return {
      matched: false,
      commit: null,
      reason: "no-repaired-files",
      journal: emptyJournal,
    };
  }
  const root = await assertRosterPilotRepository(input.repositoryRoot);
  const current = await captureRepairVerificationSourceState(root);
  if (!current.clean) {
    return {
      matched: false,
      commit: null,
      reason: "worktree-not-clean",
      journal: emptyJournal,
    };
  }
  const currentFiles = await Promise.all(
    record.sourceAfter.changedFiles.map((entry) =>
      changedFileEvidence(root, entry.path),
    ),
  );
  const matches = currentFiles.every((entry, index) => {
    const expected = record.sourceAfter.changedFiles[index];
    return entry.sha256 === expected.sha256 && entry.kind === expected.kind;
  });
  if (!matches) {
    return {
      matched: false,
      commit: null,
      reason: "file-state-mismatch",
      journal: emptyJournal,
    };
  }
  const commit = current.gitHead;
  if (!commit) {
    return {
      matched: false,
      commit: null,
      reason: "file-state-mismatch",
      journal: emptyJournal,
    };
  }
  let journal = emptyJournal;
  if (input.journal) {
    const result = await appendWorkflowReliabilityEventSafely(
      input.journal.store,
      {
        workflow: input.journal.workflow,
        idempotencyKey: `commit-association:${record.recordSha256}:${commit}`,
        eventKind: "commit-association",
        stage: input.journal.stage ?? "repair-verification",
        provider: input.journal.provider ?? null,
        outcome: "observed",
        execution: { status: "succeeded", attempt: null },
        evidence: {
          status: "verified",
          artifactCount: 1,
          evidenceSha256: record.recordSha256,
        },
        attributes: {
          commit,
          verificationId: record.verificationId,
          verificationRecordSha256: record.recordSha256,
          matchedFileCount: record.sourceAfter.changedFiles.length,
        },
      },
    );
    journal = result.ok
      ? {
          attempted: true,
          appended: result.data.created,
          eventSha256: result.data.event.eventSha256,
          warning: null,
        }
      : {
          attempted: true,
          appended: false,
          eventSha256: null,
          warning: result.error.message,
        };
  }
  return { matched: true, commit, reason: "matched", journal };
}

const AutomaticCommitCandidateAttributesSchema = z
  .object({
    verificationId: z.string().uuid(),
    verificationRecordSha256: reliabilitySha256Schema,
    sourceChangedDuringVerification: z.literal(false),
    changedFiles: z.array(RepairVerificationChangedFileV1Schema).min(1),
  })
  .passthrough();

export type AutomaticRepairCommitAssociationSkipReason =
  | "worktree-not-clean"
  | "file-state-mismatch"
  | "git-head-unavailable"
  | "journal-failed";

export type AutomaticRepairCommitAssociationResult = {
  workflowCount: number;
  verificationCandidates: number;
  alreadyAssociated: number;
  associated: Array<{
    workflow: WorkflowReliabilityRefV1;
    verificationId: string;
    commit: string;
    eventSha256: string;
  }>;
  skipped: Array<{
    workflow: WorkflowReliabilityRefV1;
    verificationId: string;
    reason: AutomaticRepairCommitAssociationSkipReason;
  }>;
  warnings: string[];
};

/**
 * On process startup, associate verified dirty repair states with the current
 * clean commit when every recorded file still matches. The journal event is
 * idempotent, and invalid workflow chains are skipped rather than repaired or
 * rewritten by this operation.
 */
export async function associatePendingRepairVerificationCommits(input: {
  store: WorkflowReliabilityEventStore;
  repositoryRoot: string;
  workflowKind?: string;
}): Promise<AutomaticRepairCommitAssociationResult> {
  const root = await assertRosterPilotRepository(input.repositoryRoot);
  if (!(await repairVerificationWorktreeIsClean(root))) {
    return {
      workflowCount: 0,
      verificationCandidates: 0,
      alreadyAssociated: 0,
      associated: [],
      skipped: [],
      warnings: [
        "Automatic repair commit association is deferred until the checkout is clean.",
      ],
    };
  }
  const workflows = (await input.store.listWorkflowRefs())
    .filter(
      (workflow) =>
        input.workflowKind === undefined ||
        workflow.workflowKind === input.workflowKind,
    )
    .sort((left, right) =>
      `${left.workflowKind}\0${left.workflowId}`.localeCompare(
        `${right.workflowKind}\0${right.workflowId}`,
      ),
    );
  const warnings: string[] = [];
  const candidates: Array<{
    workflow: WorkflowReliabilityRefV1;
    verificationId: string;
    verificationRecordSha256: string;
    verificationEventSha256: string;
    changedFiles: RepairVerificationChangedFileV1[];
  }> = [];
  let alreadyAssociated = 0;
  for (const workflow of workflows) {
    let history;
    try {
      history = await input.store.history(workflow);
    } catch (error) {
      warnings.push(
        sanitizeReliabilityText(
          error instanceof Error
            ? error.message
            : "A reliability history could not be read.",
        ),
      );
      continue;
    }
    if (!history.verification.ok) {
      warnings.push(
        `Skipped invalid reliability history ${workflow.workflowKind}:${workflow.workflowId}.`,
      );
      continue;
    }
    const associatedRecords = new Set(
      history.events.flatMap((event) => {
        if (event.eventKind !== "commit-association") return [];
        const value = event.attributes.verificationRecordSha256;
        return typeof value === "string" ? [value] : [];
      }),
    );
    for (const event of history.events) {
      if (
        event.eventKind !== "verification" ||
        event.outcome !== "succeeded" ||
        event.evidence.status !== "verified"
      ) {
        continue;
      }
      const parsed = AutomaticCommitCandidateAttributesSchema.safeParse(
        event.attributes,
      );
      if (!parsed.success) continue;
      if (
        associatedRecords.has(parsed.data.verificationRecordSha256)
      ) {
        alreadyAssociated += 1;
        continue;
      }
      candidates.push({
        workflow,
        verificationId: parsed.data.verificationId,
        verificationRecordSha256:
          parsed.data.verificationRecordSha256,
        verificationEventSha256: event.eventSha256,
        changedFiles: parsed.data.changedFiles,
      });
    }
  }
  const result: AutomaticRepairCommitAssociationResult = {
    workflowCount: workflows.length,
    verificationCandidates: candidates.length,
    alreadyAssociated,
    associated: [],
    skipped: [],
    warnings,
  };
  if (candidates.length === 0) return result;
  const current = await captureRepairVerificationSourceState(root);
  if (!current.clean) {
    result.skipped.push(
      ...candidates.map((candidate) => ({
        workflow: candidate.workflow,
        verificationId: candidate.verificationId,
        reason: "worktree-not-clean" as const,
      })),
    );
    return result;
  }
  if (!current.gitHead) {
    result.skipped.push(
      ...candidates.map((candidate) => ({
        workflow: candidate.workflow,
        verificationId: candidate.verificationId,
        reason: "git-head-unavailable" as const,
      })),
    );
    return result;
  }
  for (const candidate of candidates) {
    const currentFiles = await Promise.all(
      candidate.changedFiles.map((entry) =>
        changedFileEvidence(root, entry.path),
      ),
    );
    if (
      !currentFiles.every((entry, index) => {
        const expected = candidate.changedFiles[index];
        return (
          entry.kind === expected.kind && entry.sha256 === expected.sha256
        );
      })
    ) {
      result.skipped.push({
        workflow: candidate.workflow,
        verificationId: candidate.verificationId,
        reason: "file-state-mismatch",
      });
      continue;
    }
    const appended = await appendWorkflowReliabilityEventSafely(input.store, {
      workflow: candidate.workflow,
      idempotencyKey:
        `commit-association:${candidate.verificationRecordSha256}:` +
        current.gitHead,
      eventKind: "commit-association",
      stage: "repair-verification",
      outcome: "observed",
      execution: { status: "succeeded", attempt: null },
      evidence: {
        status: "verified",
        artifactCount: 1,
        evidenceSha256: candidate.verificationRecordSha256,
      },
      attributes: {
        automatic: true,
        commit: current.gitHead,
        verificationId: candidate.verificationId,
        verificationRecordSha256:
          candidate.verificationRecordSha256,
        verificationEventSha256:
          candidate.verificationEventSha256,
        matchedFileCount: candidate.changedFiles.length,
      },
    });
    if (!appended.ok) {
      result.skipped.push({
        workflow: candidate.workflow,
        verificationId: candidate.verificationId,
        reason: "journal-failed",
      });
      result.warnings.push(appended.error.message);
      continue;
    }
    result.associated.push({
      workflow: candidate.workflow,
      verificationId: candidate.verificationId,
      commit: current.gitHead,
      eventSha256: appended.data.event.eventSha256,
    });
  }
  return result;
}
