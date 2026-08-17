import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  DataBundleManifestDraftV1Schema,
  type DataBundleManifestDraftV1,
} from "../../lib/rosterpilot/data-bundle";
import {
  FACTION_DATA_DEPENDENCIES,
} from "../../lib/rosterpilot/runtime-data-bundle";
import {
  canonicalJson,
  classifyDataBundleDelta,
  sha256Hex,
  type DataBundleDeltaResult,
} from "../../lib/rosterpilot/semantic-hash";
import {
  validationPlanForDelta,
} from "../../scripts/prepare-data-bundle-update";
import {
  mappingRegressionReasons,
  type SourceManifest,
} from "../../scripts/prepare-data-update";
import {
  LocalSourceObservationV1Schema,
  publishLocalSourceCandidate,
  verifyLocalSourceCandidate,
  type LocalSourceCandidateReference,
  type LocalSourceEvidenceFile,
  type LocalSourceObservationV1,
  type LocalSourceValidationPlanV1,
  type VerifiedLocalSourceCandidate,
} from "./local-source-candidate";
import {
  appendWorkflowReliabilityEventSafely,
  associateWorkflowReliabilityIdentities,
  createWorkflowReliabilityEventStore,
  type WorkflowReliabilityEventStore,
  type WorkflowReliabilityOutcomeV1,
} from "../reliability";

export const LOCAL_SOURCE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const LOCAL_SOURCE_INITIAL_RETRY_MS = 60 * 60 * 1_000;
export const LOCAL_SOURCE_MAX_RETRY_MS = 6 * 60 * 60 * 1_000;
export const LOCAL_SOURCE_CANDIDATE_RETENTION_MS =
  30 * 24 * 60 * 60 * 1_000;
export const LOCAL_SOURCE_CERTIFICATION_TIMEOUT_MS = 60 * 60_000;
const STATE_LOCK_STALE_MS = 60_000;
const WORKER_LOCK_STALE_GRACE_MS = 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const MAX_HTTP_BYTES = 32 * 1_024 * 1_024;
const MAX_HTTP_REDIRECTS = 5;
const UPDATE_DIRECTORY_VERSION = "v1";
const STATE_FILENAME = "state.json";
const JOB_FILENAME = "job.json";
const NPM_REGISTRY_URL =
  "https://registry.npmjs.org/@alpaca-software%2F40kdc-data/latest";
const RULES_PACKAGE = "@alpaca-software/40kdc-data";
const RULES_LOCK_PATH =
  "node_modules/@alpaca-software/40kdc-data";
const BSDATA_REPOSITORY = "BSData/wh40k-11e";
const BSDATA_URL = "https://github.com/BSData/wh40k-11e.git";
const BSDATA_BRANCH = "main";
const BSDATA_API_URL =
  "https://api.github.com/repos/BSData/wh40k-11e/commits/main";
const OFFICIAL_DOWNLOADS_URL =
  "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/";
const OFFICIAL_MFM_URL = "https://mfm.warhammer-community.com/en";
const TERMINAL_JOB_STATUSES = new Set<LocalSourceUpdateJobStatus>([
  "installed",
  "activated",
  "quarantined",
  "failed",
]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jobStatusSchema = z.enum([
  "queued",
  "checking",
  "fetching",
  "building",
  "certifying",
  "installed",
  "activated",
  "quarantined",
  "failed",
]);
const triggerSchema = z.enum([
  "startup",
  "scheduled",
  "manual",
  "compatibility",
]);
const candidateReferenceSchema = z
  .object({
    bundleId: sha256Schema,
    directory: z.string().min(1).max(4_096),
    manifestPath: z.string().min(1).max(4_096),
    receiptPath: z.string().min(1).max(4_096),
    classification: z.enum([
      "bootstrap",
      "provenance-only",
      "mapping-only",
      "rules",
      "methodology/global",
    ]),
    affectedFactions: z.array(z.string().min(1).max(160)),
  })
  .strict();
const jobEvidenceSchema = z
  .object({
    stage: z.enum([
      "fetch",
      "build",
      "schema",
      "mapping",
      "export-smoke",
      "certification",
    ]),
    status: z.enum(["passed", "failed"]),
    path: z.string().min(1).max(4_096),
    sha256: sha256Schema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

const localSourceUpdateJobDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobKind: z.literal("rosterpilot-local-source-update"),
    jobId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    trigger: triggerSchema,
    forced: z.boolean(),
    status: jobStatusSchema,
    progress: z.string().min(1).max(2_000),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    retryAt: z.string().datetime().nullable(),
    recoveryCount: z.number().int().nonnegative(),
    bsDataCommitOverride: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    observation: LocalSourceObservationV1Schema.nullable(),
    officialReconciliation: z.enum([
      "verified",
      "pending",
      "unavailable",
    ]),
    candidate: candidateReferenceSchema.nullable(),
    evidence: z.array(jobEvidenceSchema),
    quarantinedScopes: z.array(z.string().min(1).max(256)),
    reliabilityWarnings: z
      .array(
        z
          .object({
            code: z.string().min(1).max(256),
            message: z.string().min(1).max(4_096),
            recordedAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    error: z
      .object({
        code: z.string().min(1).max(160),
        message: z.string().min(1).max(4_000),
        retryable: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const LocalSourceUpdateJobV1Schema =
  localSourceUpdateJobDraftSchema.extend(
    { integritySha256: sha256Schema },
  );

// Early local-source builds wrote schema-v1 jobs before compatibility builds
// gained an optional BSData commit override. Preserve those sealed records so
// interrupted work can be recovered after upgrading instead of forcing the
// operator to discard durable update evidence.
const LegacyLocalSourceUpdateJobV1Schema =
  localSourceUpdateJobDraftSchema
    .omit({ bsDataCommitOverride: true })
    .extend({ integritySha256: sha256Schema });

const localSourceUpdateStateDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    stateKind: z.literal("rosterpilot-local-source-update-state"),
    revision: z.number().int().nonnegative(),
    activeJobId: z.string().uuid().nullable(),
    lastJobId: z.string().uuid().nullable(),
    latestCandidate: candidateReferenceSchema.nullable(),
    latestObservation: LocalSourceObservationV1Schema.nullable(),
    lastAttemptAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    nextAutomaticAttemptAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const LocalSourceUpdateStateV1Schema =
  localSourceUpdateStateDraftSchema.extend(
    { integritySha256: sha256Schema },
  );

const lockOwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    pid: z.number().int().positive(),
    token: z.string().uuid(),
    acquiredAt: z.string().datetime(),
  })
  .strict();

export type LocalSourceUpdateJobStatus = z.infer<
  typeof jobStatusSchema
>;
export type LocalSourceUpdateTrigger = z.infer<
  typeof triggerSchema
>;
export type LocalSourceUpdateJobV1 = z.infer<
  typeof LocalSourceUpdateJobV1Schema
>;
export type LocalSourceUpdateStateV1 = z.infer<
  typeof LocalSourceUpdateStateV1Schema
>;
export type LocalSourceJobEvidenceV1 = z.infer<
  typeof jobEvidenceSchema
>;

export type LocalSourceUpdateDueResult = {
  due: boolean;
  reason:
    | "forced"
    | "in-progress"
    | "never-checked"
    | "retry-due"
    | "daily-check-due"
    | "not-due";
  nextAutomaticAttemptAt: string | null;
};

export type LocalSourcePipelineProgress = (
  status: Extract<
    LocalSourceUpdateJobStatus,
    "checking" | "fetching" | "building" | "certifying"
  >,
  progress: string,
) => Promise<void>;

export type LocalSourcePipelineResult = {
  kind: "current" | "candidate";
  observation: LocalSourceObservationV1;
  officialReconciliation:
    | "verified"
    | "pending"
    | "unavailable";
  candidate: LocalSourceCandidateReference | null;
  evidence: LocalSourceJobEvidenceV1[];
};

export interface LocalSourceUpdatePipeline {
  run(input: {
    jobId: string;
    jobDirectory: string;
    projectRoot: string;
    supportRoot: string;
    latestCandidate: LocalSourceCandidateReference | null;
    force?: boolean;
    bsDataCommitOverride: string | null;
    onProgress: LocalSourcePipelineProgress;
  }): Promise<LocalSourcePipelineResult>;
}

export type LocalSourceCandidateConsumer = (
  candidate: LocalSourceCandidateReference,
  context: {
    jobId: string;
    trigger: LocalSourceUpdateTrigger;
    activate: boolean;
    force: boolean;
    bsDataCommitOverride: string | null;
  },
) => Promise<{
  installed: boolean;
  activated: boolean;
}>;

export class LocalSourcePipelineError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly quarantinedScopes: string[];
  readonly evidence: LocalSourceJobEvidenceV1[];
  readonly observation: LocalSourceObservationV1 | null;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      quarantinedScopes?: readonly string[];
      evidence?: readonly LocalSourceJobEvidenceV1[];
      observation?: LocalSourceObservationV1 | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LocalSourcePipelineError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.quarantinedScopes = [
      ...new Set(options.quarantinedScopes ?? []),
    ].sort();
    this.evidence = [...(options.evidence ?? [])];
    this.observation = options.observation ?? null;
  }
}

export type BoundedCommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  output: Buffer;
  durationMs: number;
};

export type BoundedCommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
) => Promise<BoundedCommandResult>;

class BoundedCommandError extends Error {
  readonly result: BoundedCommandResult;
  readonly code: "COMMAND_FAILED" | "COMMAND_TIMED_OUT" | "OUTPUT_LIMIT";

  constructor(
    code: BoundedCommandError["code"],
    message: string,
    result: BoundedCommandResult,
  ) {
    super(message);
    this.name = "BoundedCommandError";
    this.code = code;
    this.result = result;
  }
}

type PipelineCommandEvidence = {
  receiptFile: LocalSourceEvidenceFile;
  jobEvidence: LocalSourceJobEvidenceV1;
};

type DefaultPipelineOptions = {
  fetch?: typeof fetch;
  runCommand?: BoundedCommandRunner;
  now?: () => Date;
  commandTimeoutMs?: Partial<{
    git: number;
    install: number;
    generation: number;
    build: number;
    validation: number;
    certification: number;
  }>;
};

type ApprovedRulesSource = LocalSourceObservationV1["rules"];

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function withoutIntegrity<T extends { integritySha256: string }>(
  value: T,
): Omit<T, "integritySha256"> {
  const { integritySha256: _integritySha256, ...draft } = value;
  void _integritySha256;
  return draft;
}

async function seal<T extends object>(draft: T): Promise<T & {
  integritySha256: string;
}> {
  return {
    ...draft,
    integritySha256: await sha256Hex(canonicalJson(draft)),
  };
}

async function verifySeal<T extends { integritySha256: string }>(
  value: T,
): Promise<void> {
  const expected = await sha256Hex(
    canonicalJson(withoutIntegrity(value)),
  );
  if (value.integritySha256 !== expected) {
    throw new Error("Durable local-source update state failed integrity verification.");
  }
}

async function atomicWriteJson(
  filename: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.next-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, stableJson(value), { flag: "wx" });
  await rename(temporary, filename);
}

async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(filename, "utf8")) as unknown;
}

async function readApprovedRulesSource(
  projectRoot: string,
  source: SourceManifest,
): Promise<ApprovedRulesSource> {
  const packageJson = await readJson(
    path.join(projectRoot, "package.json"),
  ) as {
    dependencies?: Record<string, unknown>;
  };
  const packageLock = await readJson(
    path.join(projectRoot, "package-lock.json"),
  ) as {
    lockfileVersion?: unknown;
    packages?: Record<
      string,
      {
        dependencies?: Record<string, unknown>;
        version?: unknown;
        resolved?: unknown;
        integrity?: unknown;
      }
    >;
  };
  const packageVersion = packageJson.dependencies?.[RULES_PACKAGE];
  const lockRootVersion =
    packageLock.packages?.[""]?.dependencies?.[RULES_PACKAGE];
  const lockEntry = packageLock.packages?.[RULES_LOCK_PATH];
  if (
    packageLock.lockfileVersion !== 3 ||
    typeof packageVersion !== "string" ||
    typeof lockRootVersion !== "string" ||
    source.rules.package !== RULES_PACKAGE ||
    source.rules.version !== packageVersion ||
    packageVersion !== lockRootVersion ||
    typeof lockEntry?.version !== "string" ||
    packageVersion !== lockEntry.version ||
    typeof lockEntry.resolved !== "string" ||
    typeof lockEntry.integrity !== "string"
  ) {
    throw new LocalSourcePipelineError(
      "LOCAL_SOURCE_RULES_APPROVAL_INVALID",
      "The reviewed data source manifest, package.json, and package-lock.json do not bind one exact 40kdc rules source.",
      { retryable: false },
    );
  }
  let tarball: URL;
  try {
    tarball = new URL(lockEntry.resolved);
  } catch {
    throw new LocalSourcePipelineError(
      "LOCAL_SOURCE_RULES_APPROVAL_INVALID",
      "The reviewed 40kdc package-lock tarball URL is invalid.",
      { retryable: false },
    );
  }
  if (
    tarball.protocol !== "https:" ||
    tarball.hostname !== "registry.npmjs.org" ||
    tarball.username !== "" ||
    tarball.password !== "" ||
    tarball.search !== "" ||
    tarball.hash !== ""
  ) {
    throw new LocalSourcePipelineError(
      "LOCAL_SOURCE_RULES_APPROVAL_INVALID",
      "The reviewed 40kdc package-lock tarball is outside the allowlisted npm registry.",
      { retryable: false },
    );
  }
  return LocalSourceObservationV1Schema.shape.rules.parse({
    package: RULES_PACKAGE,
    version: lockEntry.version,
    registryUrl: NPM_REGISTRY_URL,
    distIntegrity: lockEntry.integrity,
    tarballUrl: lockEntry.resolved,
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

export function localSourceRetryDelayMs(
  consecutiveFailures: number,
): number {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures <= 0) {
    throw new Error("consecutiveFailures must be a positive integer.");
  }
  return Math.min(
    LOCAL_SOURCE_INITIAL_RETRY_MS * 2 ** (consecutiveFailures - 1),
    LOCAL_SOURCE_MAX_RETRY_MS,
  );
}

export function evaluateLocalSourceUpdateDue(
  state: Pick<
    LocalSourceUpdateStateV1,
    | "activeJobId"
    | "lastAttemptAt"
    | "nextAutomaticAttemptAt"
    | "consecutiveFailures"
  >,
  now: Date,
  force = false,
): LocalSourceUpdateDueResult {
  if (state.activeJobId) {
    return {
      due: false,
      reason: "in-progress",
      nextAutomaticAttemptAt: state.nextAutomaticAttemptAt,
    };
  }
  if (force) {
    return {
      due: true,
      reason: "forced",
      nextAutomaticAttemptAt: state.nextAutomaticAttemptAt,
    };
  }
  if (!state.lastAttemptAt) {
    return {
      due: true,
      reason: "never-checked",
      nextAutomaticAttemptAt: state.nextAutomaticAttemptAt,
    };
  }
  const next = state.nextAutomaticAttemptAt
    ? new Date(state.nextAutomaticAttemptAt).getTime()
    : new Date(state.lastAttemptAt).getTime() +
      LOCAL_SOURCE_CHECK_INTERVAL_MS;
  if (now.getTime() >= next) {
    return {
      due: true,
      reason:
        state.consecutiveFailures > 0 ? "retry-due" : "daily-check-due",
      nextAutomaticAttemptAt: new Date(next).toISOString(),
    };
  }
  return {
    due: false,
    reason: "not-due",
    nextAutomaticAttemptAt: new Date(next).toISOString(),
  };
}

export function defaultLocalSourceUpdateRoot(
  options: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  if (platform === "darwin") {
    return path.join(
      homeDirectory,
      "Library",
      "Application Support",
      "RosterPilot",
      "data-updates",
    );
  }
  if (platform === "win32") {
    return path.join(
      environment.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local"),
      "RosterPilot",
      "data-updates",
    );
  }
  return path.join(
    environment.XDG_STATE_HOME ?? path.join(homeDirectory, ".local", "state"),
    "rosterpilot",
    "data-updates",
  );
}

export const runBoundedCommand: BoundedCommandRunner = async (
  command,
  args,
  options,
) => {
  const startedAt = Date.now();
  return new Promise<BoundedCommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      // Each command owns a process group so a timeout or output violation
      // cannot leave compilers, package managers, or hooks running behind it.
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let limitExceeded = false;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (limitExceeded) return;
      byteLength += chunk.byteLength;
      if (byteLength > options.maxOutputBytes) {
        limitExceeded = true;
        killBoundedCommandTree(child);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timeout = setTimeout(() => {
      timedOut = true;
      killBoundedCommandTree(child);
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const result: BoundedCommandResult = {
        command,
        args: [...args],
        exitCode: code ?? -1,
        output: Buffer.concat(chunks),
        durationMs: Date.now() - startedAt,
      };
      if (timedOut) {
        reject(
          new BoundedCommandError(
            "COMMAND_TIMED_OUT",
            `${command} exceeded its ${options.timeoutMs} ms time limit.`,
            result,
          ),
        );
      } else if (limitExceeded) {
        reject(
          new BoundedCommandError(
            "OUTPUT_LIMIT",
            `${command} exceeded its bounded output limit.`,
            result,
          ),
        );
      } else if (code !== 0) {
        reject(
          new BoundedCommandError(
            "COMMAND_FAILED",
            `${command} exited with status ${code ?? "unknown"}.`,
            result,
          ),
        );
      } else {
        resolve(result);
      }
    });
  });
};

function killBoundedCommandTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group may already be exiting. Fall back to the direct child.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // A close/error event will still settle the bounded command.
  }
}

function sanitizedBuildEnvironment(input: {
  stagingRoot: string;
  supportRoot: string;
}): NodeJS.ProcessEnv {
  const buildHome = path.join(input.stagingRoot, ".build-home");
  const temporary = path.join(input.stagingRoot, ".tmp");
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: buildHome,
    TMPDIR: temporary,
    CI: "1",
    NODE_ENV: "development",
    npm_config_cache: path.join(input.supportRoot, "cache", "npm"),
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_include: "dev",
    npm_config_userconfig: path.join(buildHome, ".npmrc-empty"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(buildHome, ".gitconfig-empty"),
  };
}

async function fetchBoundedText(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  headers?: HeadersInit,
  allowedHostnames: readonly string[] = [new URL(url).hostname],
): Promise<string> {
  const allowed = new Set(allowedHostnames);
  const signal = AbortSignal.timeout(timeoutMs);
  let current = new URL(url);
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= MAX_HTTP_REDIRECTS; redirectCount += 1) {
    if (
      current.protocol !== "https:" ||
      current.username !== "" ||
      current.password !== "" ||
      !allowed.has(current.hostname)
    ) {
      throw new Error(
        `${current.hostname || "The requested source"} is outside the allowlisted upstream hosts.`,
      );
    }
    response = await fetchImpl(current, {
      headers,
      redirect: "manual",
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`${current.hostname} returned a redirect without a location.`);
    }
    if (redirectCount === MAX_HTTP_REDIRECTS) {
      throw new Error(`${current.hostname} exceeded the redirect limit.`);
    }
    current = new URL(location, current);
  }
  if (!response) {
    throw new Error("The allowlisted upstream request did not produce a response.");
  }
  if (!response.ok) {
    throw new Error(`${current.hostname} returned HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_BYTES) {
    throw new Error(`${current.hostname} response exceeded the size limit.`);
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_HTTP_BYTES) {
      throw new Error(`${current.hostname} response exceeded the size limit.`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = Buffer.from(chunk.value);
      byteLength += bytes.byteLength;
      if (byteLength > MAX_HTTP_BYTES) {
        await reader.cancel();
        throw new Error(
          `${current.hostname} response exceeded the size limit.`,
        );
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function latestMfmVersion(html: string): string | null {
  const match =
    html.match(/<h[1-3][^>]*>\s*v(\d+(?:\.\d+)+)\s*<\/h[1-3]>/i) ??
    html.match(/\bversion\s+v?(\d+(?:\.\d+)+)\b/i);
  return match?.[1] ?? null;
}

async function discoverLocalSources(
  projectRoot: string,
  fetchImpl: typeof fetch,
  checkedAt: string,
): Promise<LocalSourceObservationV1> {
  const source = JSON.parse(
    await readFile(path.join(projectRoot, "data", "sources.json"), "utf8"),
  ) as SourceManifest;
  const approvedRules = await readApprovedRulesSource(projectRoot, source);
  const [npmText, bsdataText, officialResult] = await Promise.all([
    fetchBoundedText(fetchImpl, NPM_REGISTRY_URL, 15_000),
    fetchBoundedText(fetchImpl, BSDATA_API_URL, 15_000, {
      Accept: "application/vnd.github+json",
      "User-Agent": "RosterPilot-local-source-update",
      "X-GitHub-Api-Version": "2022-11-28",
    }),
    Promise.all([
      fetchBoundedText(fetchImpl, OFFICIAL_DOWNLOADS_URL, 15_000),
      fetchBoundedText(fetchImpl, OFFICIAL_MFM_URL, 15_000),
    ])
      .then(async ([downloadsHtml, mfmHtml]) => ({
        version: latestMfmVersion(mfmHtml),
        contentSha256: await sha256Hex(
          canonicalJson({
            downloads: await sha256Hex(downloadsHtml),
            mfm: await sha256Hex(mfmHtml),
          }),
        ),
      }))
      .catch(() => null),
  ]);
  const npmPayload = JSON.parse(npmText) as {
    name?: string;
    version?: string;
    dist?: { integrity?: string; tarball?: string };
  };
  if (
    npmPayload.name !== RULES_PACKAGE ||
    !npmPayload.version ||
    !npmPayload.dist?.integrity ||
    !npmPayload.dist.tarball
  ) {
    throw new Error("The allowlisted 40kdc npm metadata is incomplete.");
  }
  const tarball = new URL(npmPayload.dist.tarball);
  if (
    tarball.protocol !== "https:" ||
    tarball.hostname !== "registry.npmjs.org"
  ) {
    throw new Error("The 40kdc tarball is outside the allowlisted npm registry.");
  }
  // Registry "latest" is change detection only. Executable rules remain
  // selected from the independently reviewed dependency lock.
  const latestRequiresReview =
    npmPayload.version !== approvedRules.version ||
    npmPayload.dist.integrity !== approvedRules.distIntegrity ||
    npmPayload.dist.tarball !== approvedRules.tarballUrl;
  const bsdataPayload = JSON.parse(bsdataText) as { sha?: string };
  if (!bsdataPayload.sha?.match(/^[a-f0-9]{40}$/)) {
    throw new Error("The allowlisted BSData branch did not return an exact commit.");
  }
  const officialChanged = Boolean(
    officialResult &&
      (officialResult.version !== source.official.mfmVersion ||
        officialResult.contentSha256 !== source.official.contentSha256),
  );
  return LocalSourceObservationV1Schema.parse({
    checkedAt,
    rules: {
      ...approvedRules,
      observedLatest: {
        version: npmPayload.version,
        distIntegrity: npmPayload.dist.integrity,
        tarballUrl: npmPayload.dist.tarball,
        approval: latestRequiresReview
          ? "review-required"
          : "approved",
      },
    },
    newRecruit: {
      repository: BSDATA_REPOSITORY,
      url: BSDATA_URL,
      branch: BSDATA_BRANCH,
      commit: bsdataPayload.sha,
      latestCommit: bsdataPayload.sha,
    },
    official: {
      downloadsUrl: OFFICIAL_DOWNLOADS_URL,
      mfmUrl: OFFICIAL_MFM_URL,
      observedVersion: officialResult?.version ?? null,
      observedContentSha256: officialResult?.contentSha256 ?? null,
      retainedVersion: source.official.mfmVersion,
      retainedContentSha256: source.official.contentSha256,
      disposition: officialResult
        ? officialChanged
          ? "update-pending"
          : "current"
        : "unknown",
    },
  });
}

function incrementReleaseId(current: string, checkedAt: string): string {
  const date = checkedAt.slice(0, 10);
  const match = current.match(new RegExp(`^${date}\\.(\\d+)$`));
  return `${date}.${match ? Number(match[1]) + 1 : 1}`;
}

function nextLocalSourceManifest(
  source: SourceManifest,
  observation: LocalSourceObservationV1,
): SourceManifest {
  return {
    ...structuredClone(source),
    releaseId: incrementReleaseId(source.releaseId, observation.checkedAt),
    rules: {
      ...source.rules,
      version: observation.rules.version,
    },
    newRecruit: {
      ...source.newRecruit,
      repository: BSDATA_REPOSITORY,
      url: BSDATA_URL,
      branch: BSDATA_BRANCH,
      commit: observation.newRecruit.commit,
    },
    // Official values are deliberately retained. A live page observation is
    // change detection, not reviewed extraction authority.
    official: {
      ...source.official,
    },
  };
}

async function listBuilderFiles(
  root: string,
): Promise<string[]> {
  const selected = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ];
  const walk = async (relativeDirectory: string): Promise<string[]> => {
    const directory = path.join(root, relativeDirectory);
    return (
      await Promise.all(
        (await readdir(directory, { withFileTypes: true }))
          .sort((left, right) => left.name.localeCompare(right.name))
          .map(async (entry) => {
            const relative = path.posix.join(
              relativeDirectory.split(path.sep).join("/"),
              entry.name,
            );
            if (entry.isDirectory()) return walk(relative);
            if (!entry.isFile() || entry.isSymbolicLink()) {
              throw new Error(`Builder source contains an unsupported entry: ${relative}.`);
            }
            return [relative];
          }),
      )
    ).flat();
  };
  return [
    ...new Set([
      ...selected,
      ...(await walk("cli")),
      ...(await walk("lib")),
      ...(await walk("local")),
      ...(await walk("mcp")),
      ...(await walk("scripts")),
      ...(await walk("tests")),
      ...(await walk("types")),
    ]),
  ].sort();
}

async function assertRegularSourceTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Local-source staging does not accept symbolic links: ${filename}.`,
      );
    }
    if (entry.isDirectory()) {
      await assertRegularSourceTree(filename);
    } else if (!entry.isFile()) {
      throw new Error(
        `Local-source staging accepts only regular files and directories: ${filename}.`,
      );
    }
  }
}

export async function assertSafeBsDataCheckout(
  directory: string,
  relativeDirectory = "",
): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`BSData checkout must be a regular directory: ${directory}.`);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (relativeDirectory === "" && entry.name === ".git") continue;
    const filename = path.join(directory, entry.name);
    const relative = path.posix.join(
      relativeDirectory.split(path.sep).join("/"),
      entry.name,
    );
    if (entry.isSymbolicLink()) {
      throw new Error(
        `BSData checkout contains an unsupported symbolic link: ${relative}.`,
      );
    }
    if (entry.isDirectory()) {
      await assertSafeBsDataCheckout(filename, relative);
    } else if (!entry.isFile()) {
      throw new Error(
        `BSData checkout contains an unsupported filesystem entry: ${relative}.`,
      );
    }
  }
}

async function copyStagingProject(
  projectRoot: string,
  stagingRoot: string,
): Promise<void> {
  for (const directory of [
    "cli",
    "data",
    "lib",
    "local",
    "mcp",
    "scripts",
    "tests",
    "types",
  ]) {
    const source = path.join(projectRoot, directory);
    const metadata = await lstat(source);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Staging source must be a regular directory: ${source}.`);
    }
    await assertRegularSourceTree(source);
    await cp(source, path.join(stagingRoot, directory), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  for (const filename of ["package.json", "package-lock.json", "tsconfig.json"]) {
    await cp(
      path.join(projectRoot, filename),
      path.join(stagingRoot, filename),
      { dereference: false },
    );
  }
}

async function writeCommandEvidence(input: {
  jobDirectory: string;
  sequence: number;
  stage: LocalSourceEvidenceFile["stage"];
  name: string;
  status: "passed" | "failed";
  result: BoundedCommandResult;
}): Promise<PipelineCommandEvidence> {
  const evidenceDirectory = path.join(input.jobDirectory, "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const safeName = input.name.replace(/[^A-Za-z0-9._-]+/g, "-");
  const filename = path.join(
    evidenceDirectory,
    `${String(input.sequence).padStart(3, "0")}-${safeName}.log`,
  );
  const header = Buffer.from(
    stableJson({
      command: path.basename(input.result.command),
      args: input.result.args,
      exitCode: input.result.exitCode,
      durationMs: input.result.durationMs,
      status: input.status,
    }),
  );
  const content = Buffer.concat([header, input.result.output]);
  await writeFile(filename, content, { flag: "wx" });
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  return {
    receiptFile: { stage: input.stage, filename },
    jobEvidence: {
      stage: input.stage,
      status: input.status,
      path: filename,
      sha256,
      byteLength: content.byteLength,
    },
  };
}

async function writeJsonEvidence(input: {
  jobDirectory: string;
  sequence: number;
  stage: LocalSourceEvidenceFile["stage"];
  name: string;
  status: "passed" | "failed";
  value: unknown;
}): Promise<PipelineCommandEvidence> {
  const evidenceDirectory = path.join(input.jobDirectory, "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const filename = path.join(
    evidenceDirectory,
    `${String(input.sequence).padStart(3, "0")}-${input.name}.json`,
  );
  const content = Buffer.from(stableJson(input.value));
  await writeFile(filename, content, { flag: "wx" });
  return {
    receiptFile: { stage: input.stage, filename },
    jobEvidence: {
      stage: input.stage,
      status: input.status,
      path: filename,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      byteLength: content.byteLength,
    },
  };
}

function parseCandidateManifest(input: unknown): {
  bundleId: string;
  draft: DataBundleManifestDraftV1;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Candidate manifest is invalid.");
  }
  const { bundleId, ...draftInput } = input as Record<string, unknown>;
  return {
    bundleId: sha256Schema.parse(bundleId),
    draft: DataBundleManifestDraftV1Schema.parse(draftInput),
  };
}

function deltaForCandidate(
  previous: DataBundleManifestDraftV1 | null,
  candidate: DataBundleManifestDraftV1,
): DataBundleDeltaResult | null {
  if (!previous) return null;
  return classifyDataBundleDelta({
    current: previous,
    candidate,
    factionDependencies: FACTION_DATA_DEPENDENCIES,
  });
}

function quarantineScopes(delta: DataBundleDeltaResult): string[] {
  const factionScopes = delta.affectedFactions.map(
    (factionId) => `faction:${factionId}`,
  );
  return [...new Set([...delta.changedScopes, ...factionScopes])].sort();
}

async function mappingBaselineSummary(
  projectRoot: string,
  latest: VerifiedLocalSourceCandidate | null,
): Promise<Parameters<typeof mappingRegressionReasons>[0]> {
  const exportEvidence = latest?.buildEvidence.validation.evidence.find(
    (entry) => entry.stage === "export-smoke" && entry.path.endsWith(".json"),
  );
  if (latest && exportEvidence) {
    try {
      const document = JSON.parse(
        await readFile(
          path.join(latest.reference.directory, ...exportEvidence.path.split("/")),
          "utf8",
        ),
      ) as { candidateSummary?: unknown };
      if (document.candidateSummary) {
        return document.candidateSummary as Parameters<
          typeof mappingRegressionReasons
        >[0];
      }
    } catch {
      // The candidate itself was already verified. A legacy evidence payload
      // simply falls back to the compiled baseline below.
    }
  }
  return JSON.parse(
    await readFile(
      path.join(
        projectRoot,
        "data",
        "generated",
        "new-recruit-summary.json",
      ),
      "utf8",
    ),
  ) as Parameters<typeof mappingRegressionReasons>[0];
}

export function createDefaultLocalSourceUpdatePipeline(
  options: DefaultPipelineOptions = {},
): LocalSourceUpdatePipeline {
  const fetchImpl = options.fetch ?? fetch;
  const commandRunner = options.runCommand ?? runBoundedCommand;
  const now = options.now ?? (() => new Date());
  const timeouts = {
    git: options.commandTimeoutMs?.git ?? 2 * 60_000,
    install: options.commandTimeoutMs?.install ?? 10 * 60_000,
    generation: options.commandTimeoutMs?.generation ?? 10 * 60_000,
    build: options.commandTimeoutMs?.build ?? 5 * 60_000,
    validation: options.commandTimeoutMs?.validation ?? 10 * 60_000,
    certification:
      options.commandTimeoutMs?.certification ??
      LOCAL_SOURCE_CERTIFICATION_TIMEOUT_MS,
  };

  return {
    async run(input): Promise<LocalSourcePipelineResult> {
      const evidence: PipelineCommandEvidence[] = [];
      let evidenceSequence = 0;
      let observation: LocalSourceObservationV1 | null = null;
      let stagingParent: string | null = null;
      let candidateValidationScopes: string[] = [];
      const runEvidence = async (
        stage: LocalSourceEvidenceFile["stage"],
        name: string,
        command: string,
        args: readonly string[],
        commandOptions: {
          cwd: string;
          env: NodeJS.ProcessEnv;
          timeoutMs: number;
        },
      ): Promise<BoundedCommandResult> => {
        const sequence = ++evidenceSequence;
        try {
          const result = await commandRunner(command, args, {
            ...commandOptions,
            maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
          });
          evidence[sequence - 1] = await writeCommandEvidence({
            jobDirectory: input.jobDirectory,
            sequence,
            stage,
            name,
            status: "passed",
            result,
          });
          return result;
        } catch (error) {
          const result =
            error instanceof BoundedCommandError
              ? error.result
              : {
                  command,
                  args: [...args],
                  exitCode: -1,
                  output: Buffer.from(String(error)),
                  durationMs: 0,
                };
          evidence[sequence - 1] = await writeCommandEvidence({
            jobDirectory: input.jobDirectory,
            sequence,
            stage,
            name,
            status: "failed",
            result,
          });
          throw error;
        }
      };
      const jsonEvidence = async (
        stage: LocalSourceEvidenceFile["stage"],
        name: string,
        status: "passed" | "failed",
        value: unknown,
      ): Promise<void> => {
        const sequence = ++evidenceSequence;
        evidence[sequence - 1] = await writeJsonEvidence({
          jobDirectory: input.jobDirectory,
          sequence,
          stage,
          name,
          status,
          value,
        });
      };
      try {
        await input.onProgress(
          "checking",
          "Checking the allowlisted upstream data sources.",
        );
        observation = await discoverLocalSources(
          input.projectRoot,
          fetchImpl,
          now().toISOString(),
        );
        if (input.bsDataCommitOverride) {
          observation = LocalSourceObservationV1Schema.parse({
            ...observation,
            newRecruit: {
              ...observation.newRecruit,
              commit: input.bsDataCommitOverride,
            },
          });
        }
        let latestVerified: VerifiedLocalSourceCandidate | null = null;
        if (input.latestCandidate) {
          try {
            latestVerified = await verifyLocalSourceCandidate(
              input.latestCandidate.directory,
            );
          } catch {
            // A corrupt candidate is never trusted as a baseline. A fresh
            // candidate receives full bootstrap certification instead.
            latestVerified = null;
          }
        }
        const latestSources = latestVerified?.buildEvidence.sources;
        let builderChanged = false;
        if (latestVerified && input.force) {
          try {
            await verifyLocalSourceCandidate(
              latestVerified.reference.directory,
              { expectedBuilderRoot: input.projectRoot },
            );
          } catch {
            builderChanged = true;
          }
        }
        const needsBuild =
          !latestVerified ||
          builderChanged ||
          latestSources?.rules.version !== observation.rules.version ||
          latestSources?.rules.distIntegrity !==
            observation.rules.distIntegrity ||
          latestSources?.newRecruit.commit !==
            observation.newRecruit.commit;
        if (!needsBuild) {
          if (!latestVerified) {
            throw new Error(
              "A current local-source result requires a verified candidate.",
            );
          }
          return {
            kind: "current",
            observation,
            officialReconciliation:
              observation.official.disposition === "update-pending"
                ? "pending"
                : observation.official.disposition === "unknown"
                  ? "unavailable"
                  : "verified",
            candidate: latestVerified.reference,
            evidence: [],
          };
        }

        await input.onProgress(
          "fetching",
          "Fetching exact upstream revisions into isolated local caches.",
        );
        stagingParent = await mkdtemp(
          path.join(os.tmpdir(), "rosterpilot-local-data-"),
        );
        const stagingRoot = path.join(stagingParent, "project");
        const bsdataCheckout = path.join(stagingParent, "bsdata-checkout");
        const preflightArtifacts = path.join(
          stagingParent,
          "preflight-artifacts",
        );
        const finalArtifacts = path.join(stagingParent, "final-artifacts");
        await mkdir(stagingRoot, { recursive: true });
        await copyStagingProject(input.projectRoot, stagingRoot);
        const buildEnvironment = sanitizedBuildEnvironment({
          stagingRoot,
          supportRoot: input.supportRoot,
        });
        await mkdir(buildEnvironment.HOME!, { recursive: true });
        await mkdir(buildEnvironment.TMPDIR!, { recursive: true });
        await mkdir(path.dirname(buildEnvironment.npm_config_cache!), {
          recursive: true,
        });
        await writeFile(buildEnvironment.npm_config_userconfig!, "", {
          flag: "wx",
        });
        await writeFile(buildEnvironment.GIT_CONFIG_GLOBAL!, "", {
          flag: "wx",
        });

        const mirror = path.join(
          input.supportRoot,
          "cache",
          "bsdata-wh40k-11e.git",
        );
        await mkdir(path.dirname(mirror), { recursive: true });
        let mirrorExists = false;
        try {
          mirrorExists = (await stat(mirror)).isDirectory();
        } catch {
          mirrorExists = false;
        }
        if (!mirrorExists) {
          await runEvidence(
            "fetch",
            "bsdata-mirror-clone",
            "git",
            [
              "-c",
              "http.followRedirects=false",
              "clone",
              "--mirror",
              BSDATA_URL,
              mirror,
            ],
            {
              cwd: stagingParent,
              env: buildEnvironment,
              timeoutMs: timeouts.git,
            },
          );
        } else {
          const remote = await runEvidence(
            "fetch",
            "bsdata-remote-check",
            "git",
            ["--git-dir", mirror, "remote", "get-url", "origin"],
            {
              cwd: stagingParent,
              env: buildEnvironment,
              timeoutMs: timeouts.git,
            },
          );
          if (remote.output.toString("utf8").trim() !== BSDATA_URL) {
            throw new Error(
              "The persistent BSData cache origin is outside the allowlist.",
            );
          }
          await runEvidence(
            "fetch",
            "bsdata-fetch",
            "git",
            [
              "--git-dir",
              mirror,
              "-c",
              "http.followRedirects=false",
              "fetch",
              "--prune",
              "origin",
              `+refs/heads/${BSDATA_BRANCH}:refs/heads/${BSDATA_BRANCH}`,
            ],
            {
              cwd: stagingParent,
              env: buildEnvironment,
              timeoutMs: timeouts.git,
            },
          );
        }
        const resolvedCommit = await runEvidence(
          "fetch",
          "bsdata-commit-check",
          "git",
          [
            "--git-dir",
            mirror,
            "rev-parse",
            `refs/heads/${BSDATA_BRANCH}`,
          ],
          {
            cwd: stagingParent,
            env: buildEnvironment,
            timeoutMs: timeouts.git,
          },
        );
        if (
          !input.bsDataCommitOverride &&
          resolvedCommit.output.toString("utf8").trim() !==
            observation.newRecruit.commit
        ) {
          throw new Error(
            "The BSData branch moved between discovery and exact-cache fetch; retry the check.",
          );
        }
        await runEvidence(
          "fetch",
          "bsdata-selected-commit-check",
          "git",
          [
            "--git-dir",
            mirror,
            "cat-file",
            "-e",
            `${observation.newRecruit.commit}^{commit}`,
          ],
          {
            cwd: stagingParent,
            env: buildEnvironment,
            timeoutMs: timeouts.git,
          },
        );
        await runEvidence(
          "fetch",
          "bsdata-local-checkout",
          "git",
          ["clone", "--no-checkout", mirror, bsdataCheckout],
          {
            cwd: stagingParent,
            env: buildEnvironment,
            timeoutMs: timeouts.git,
          },
        );
        await runEvidence(
          "fetch",
          "bsdata-checkout-exact-commit",
          "git",
          ["checkout", "--quiet", "--detach", observation.newRecruit.commit],
          {
            cwd: bsdataCheckout,
            env: buildEnvironment,
            timeoutMs: timeouts.git,
          },
        );
        await assertSafeBsDataCheckout(bsdataCheckout);
        const source = JSON.parse(
          await readFile(
            path.join(input.projectRoot, "data", "sources.json"),
            "utf8",
          ),
        ) as SourceManifest;
        const nextSource = nextLocalSourceManifest(source, observation);
        await atomicWriteJson(
          path.join(stagingRoot, "data", "sources.json"),
          nextSource,
        );
        await runEvidence(
          "fetch",
          "npm-ci-reviewed-dependency-lock",
          "npm",
          [
            "ci",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
          ],
          {
            cwd: stagingRoot,
            env: buildEnvironment,
            timeoutMs: timeouts.install,
          },
        );
        const installedPackage = JSON.parse(
          await readFile(
            path.join(
              stagingRoot,
              "node_modules",
              "@alpaca-software",
              "40kdc-data",
              "package.json",
            ),
            "utf8",
          ),
        ) as { name?: string; version?: string };
        if (
          installedPackage.name !== observation.rules.package ||
          installedPackage.version !== observation.rules.version
        ) {
          throw new Error(
            "The installed 40kdc package does not match the exact registry observation.",
          );
        }
        const installedLock = JSON.parse(
          await readFile(path.join(stagingRoot, "package-lock.json"), "utf8"),
        ) as {
          packages?: Record<
            string,
            { version?: string; resolved?: string; integrity?: string }
          >;
        };
        const installedLockEntry =
          installedLock.packages?.[
            "node_modules/@alpaca-software/40kdc-data"
          ];
        if (
          installedLockEntry?.version !== observation.rules.version ||
          installedLockEntry.resolved !== observation.rules.tarballUrl ||
          installedLockEntry.integrity !== observation.rules.distIntegrity
        ) {
          throw new Error(
            "The installed 40kdc package-lock identity does not match the exact registry observation.",
          );
        }
        await runEvidence(
          "mapping",
          "generate-bsdata-mappings",
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/sync-bsdata.ts",
            "--checkout",
            bsdataCheckout,
            "--commit",
            observation.newRecruit.commit,
            "--write",
          ],
          {
            cwd: stagingRoot,
            env: buildEnvironment,
            timeoutMs: timeouts.generation,
          },
        );
        await jsonEvidence("fetch", "source-observation", "passed", {
          observation,
          installedRulesPackage: installedPackage,
        });

        await input.onProgress(
          "building",
          "Building a content-addressed candidate outside the checkout.",
        );
        const buildCandidate = async (
          outputDirectory: string,
          name: string,
        ) => {
          await runEvidence(
            "build",
            name,
            process.execPath,
            [
              "--import",
              "tsx",
              "scripts/build-local-source-candidate.ts",
              "--out-dir",
              outputDirectory,
              "--created-at",
              observation!.checkedAt,
            ],
            {
              cwd: stagingRoot,
              env: buildEnvironment,
              timeoutMs: timeouts.build,
            },
          );
          return parseCandidateManifest(
            JSON.parse(
              await readFile(
                path.join(outputDirectory, "manifest.json"),
                "utf8",
              ),
            ),
          );
        };
        const preflight = await buildCandidate(
          preflightArtifacts,
          "build-preflight-candidate",
        );
        const previousManifest = latestVerified?.manifestDraft ?? null;
        const preflightDelta = deltaForCandidate(
          previousManifest,
          preflight.draft,
        );
        if (preflightDelta?.quarantine) {
          throw new LocalSourcePipelineError(
            "LOCAL_SOURCE_DELTA_QUARANTINED",
            preflightDelta.reasons.join(" "),
            {
              quarantinedScopes: quarantineScopes(preflightDelta),
              observation,
            },
          );
        }
        candidateValidationScopes = preflightDelta
          ? quarantineScopes(preflightDelta)
          : ["candidate:bootstrap"];
        await input.onProgress(
          "certifying",
          "Validating schema, mappings, exports, and the required deterministic scope.",
        );
        const candidateSummaryPath = path.join(
          stagingRoot,
          "data",
          "generated",
          "new-recruit-summary.json",
        );
        const regressionReasons = mappingRegressionReasons(
          await mappingBaselineSummary(input.projectRoot, latestVerified),
          JSON.parse(await readFile(candidateSummaryPath, "utf8")),
        );
        await jsonEvidence(
          "mapping",
          "mapping-regression",
          regressionReasons.length === 0 ? "passed" : "failed",
          { regressionReasons },
        );
        if (regressionReasons.length > 0) {
          throw new LocalSourcePipelineError(
            "LOCAL_SOURCE_MAPPING_REGRESSION",
            `Candidate mapping regression: ${regressionReasons.join("; ")}`,
            {
              quarantinedScopes:
                preflightDelta?.affectedFactions.map(
                  (factionId) => `faction:${factionId}:mapping`,
                ) ?? ["mapping"],
              observation,
            },
          );
        }
        await runEvidence(
          "mapping",
          "mapping-sync-check",
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/sync-bsdata.ts",
            "--checkout",
            bsdataCheckout,
            "--commit",
            observation.newRecruit.commit,
            "--check",
          ],
          {
            cwd: stagingRoot,
            env: buildEnvironment,
            timeoutMs: timeouts.validation,
          },
        );
        const finalCandidate = await buildCandidate(
          finalArtifacts,
          "build-final-candidate",
        );
        const finalDelta = deltaForCandidate(
          previousManifest,
          finalCandidate.draft,
        );
        if (finalDelta?.quarantine) {
          throw new LocalSourcePipelineError(
            "LOCAL_SOURCE_FINAL_DELTA_QUARANTINED",
            finalDelta.reasons.join(" "),
            {
              quarantinedScopes: quarantineScopes(finalDelta),
              observation,
            },
          );
        }
        candidateValidationScopes = finalDelta
          ? quarantineScopes(finalDelta)
          : ["candidate:bootstrap"];
        const finalPlan = validationPlanForDelta(finalDelta);
        if (finalPlan.runDataCheck) {
          const dataCheck = await runEvidence(
            "schema",
            "schema-and-data-check",
            "npm",
            ["run", "data:check"],
            {
              cwd: stagingRoot,
              env: buildEnvironment,
              timeoutMs: timeouts.validation,
            },
          );
          await jsonEvidence("export-smoke", "export-coverage-smoke", "passed", {
            dataCheckOutputSha256: crypto
              .createHash("sha256")
              .update(dataCheck.output)
              .digest("hex"),
            candidateSummary: JSON.parse(
              await readFile(candidateSummaryPath, "utf8"),
            ),
          });
        } else {
          await jsonEvidence("schema", "schema-check-not-required", "passed", {
            reason: "provenance-only delta",
          });
          await jsonEvidence("export-smoke", "export-smoke-not-required", "passed", {
            reason: "provenance-only delta preserved export semantics",
          });
        }
        if (
          finalPlan.fullCertification ||
          finalPlan.certificationFactions.length > 0
        ) {
          await input.onProgress(
            "certifying",
            "Running the retained product type checks and focused test suite before activation.",
          );
          await runEvidence(
            "certification",
            "retained-product-typecheck",
            "npm",
            ["run", "typecheck"],
            {
              cwd: stagingRoot,
              env: buildEnvironment,
              timeoutMs: timeouts.validation,
            },
          );
          await runEvidence(
            "certification",
            "retained-product-tests",
            "npm",
            ["test"],
            {
              cwd: stagingRoot,
              env: buildEnvironment,
              timeoutMs: timeouts.certification,
            },
          );
        } else {
          await jsonEvidence(
            "certification",
            "deterministic-certification-not-required",
            "passed",
            { reason: "provenance-only delta" },
          );
        }
        const classification =
          finalDelta?.classification ?? "bootstrap";
        if (classification === "ambiguous/regressive") {
          throw new LocalSourcePipelineError(
            "LOCAL_SOURCE_FINAL_DELTA_QUARANTINED",
            "The final candidate delta is ambiguous or regressive.",
            {
              quarantinedScopes: finalDelta
                ? quarantineScopes(finalDelta)
                : ["candidate"],
              observation,
            },
          );
        }
        const affectedFactions =
          finalDelta?.affectedFactions ??
          Object.keys(finalCandidate.draft.semanticHashes.factions).sort();
        // Builder identity describes the trusted checkout, including its
        // dependency lock. The exact 40kdc package installed into staging is
        // separately bound by source integrity evidence in this receipt.
        const builderFiles = await listBuilderFiles(input.projectRoot);
        const published = await publishLocalSourceCandidate({
          artifactsDirectory: finalArtifacts,
          destinationRoot: path.join(input.supportRoot, "candidates"),
          sources: observation,
          builderRoot: input.projectRoot,
          builderFiles,
          validation: {
            classification,
            affectedFactions,
            plan: finalPlan as LocalSourceValidationPlanV1,
            evidenceFiles: evidence
              .filter((entry) => entry.jobEvidence.status === "passed")
              .map((entry) => entry.receiptFile),
          },
          parentBundleId: latestVerified?.reference.bundleId ?? null,
          now,
        });
        return {
          kind: "candidate",
          observation,
          officialReconciliation:
            observation.official.disposition === "update-pending"
              ? "pending"
              : observation.official.disposition === "unknown"
                ? "unavailable"
                : "verified",
          candidate: published,
          evidence: evidence.map((entry) => entry.jobEvidence),
        };
      } catch (error) {
        const jobEvidence = evidence.map((entry) => entry.jobEvidence);
        if (error instanceof LocalSourcePipelineError) {
          throw new LocalSourcePipelineError(error.code, error.message, {
            retryable: error.retryable,
            quarantinedScopes: error.quarantinedScopes,
            evidence: jobEvidence,
            observation: error.observation ?? observation,
            cause: error,
          });
        }
        const boundedInfrastructureFailure =
          error instanceof BoundedCommandError &&
          ["COMMAND_TIMED_OUT", "OUTPUT_LIMIT"].includes(error.code);
        const certificationFailure =
          !boundedInfrastructureFailure &&
          evidence.some(
          (entry) =>
            entry.jobEvidence.status === "failed" &&
            [
              "build",
              "schema",
              "mapping",
              "export-smoke",
              "certification",
            ].includes(
              entry.jobEvidence.stage,
            ),
          );
        throw new LocalSourcePipelineError(
          certificationFailure
            ? "LOCAL_SOURCE_CERTIFICATION_FAILED"
            : "LOCAL_SOURCE_UPDATE_FAILED",
          error instanceof Error ? error.message : String(error),
          {
            retryable: !certificationFailure,
            quarantinedScopes: certificationFailure
              ? candidateValidationScopes.length > 0
                ? candidateValidationScopes
                : ["candidate:validation"]
              : [],
            evidence: jobEvidence,
            observation,
            cause: error,
          },
        );
      } finally {
        if (stagingParent) {
          await rm(stagingParent, { recursive: true, force: true });
        }
      }
    },
  };
}

type CoordinatorOptions = {
  rootDirectory: string;
  projectRoot: string;
  pipeline?: LocalSourceUpdatePipeline;
  consumeCandidate?: LocalSourceCandidateConsumer;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  reliability?: {
    store?: WorkflowReliabilityEventStore;
    rootDirectory?: string;
    associateIdentities?: typeof associateWorkflowReliabilityIdentities;
  };
};

async function acquireDirectoryLock(input: {
  directory: string;
  now: () => Date;
  isProcessAlive: (pid: number) => boolean;
  staleAfterMs: number;
  waitMs?: number;
}): Promise<{
  token: string;
  release: () => Promise<void>;
}> {
  const waitDeadline = Date.now() + (input.waitMs ?? 0);
  let recoveryAttempts = 0;
  while (recoveryAttempts < 3) {
    const owner = {
      schemaVersion: 1 as const,
      pid: process.pid,
      token: crypto.randomUUID(),
      acquiredAt: input.now().toISOString(),
    };
    try {
      await mkdir(input.directory, { recursive: false });
      await writeFile(
        path.join(input.directory, "owner.json"),
        stableJson(owner),
        { flag: "wx" },
      );
      return {
        token: owner.token,
        release: async () => {
          const current = lockOwnerSchema.parse(
            await readJson(path.join(input.directory, "owner.json")),
          );
          if (current.token !== owner.token) {
            throw new Error("The local-source update lock owner changed.");
          }
          await rm(input.directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      let existing: z.infer<typeof lockOwnerSchema> | null = null;
      try {
        existing = lockOwnerSchema.parse(
          await readJson(path.join(input.directory, "owner.json")),
        );
      } catch {
        existing = null;
      }
      const lockMetadata = existing
        ? null
        : await stat(input.directory).catch((statError: unknown) => {
            if (
              statError instanceof Error &&
              "code" in statError &&
              statError.code === "ENOENT"
            ) {
              return null;
            }
            throw statError;
          });
      if (!existing && !lockMetadata) continue;
      const age = existing
        ? input.now().getTime() - new Date(existing.acquiredAt).getTime()
        : input.now().getTime() - lockMetadata!.mtimeMs;
      if (
        age >= input.staleAfterMs &&
        (!existing || !input.isProcessAlive(existing.pid))
      ) {
        await rm(input.directory, { recursive: true, force: true });
        recoveryAttempts += 1;
        continue;
      }
      if (Date.now() < waitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw new Error(
        existing
          ? `Another local-source update process ${existing.pid} owns the lock.`
          : "Another local-source update owns an unreadable recent lock.",
      );
    }
  }
  throw new Error("Could not acquire the local-source update lock.");
}

function localSourceReliabilityOutcome(
  job: LocalSourceUpdateJobV1,
): WorkflowReliabilityOutcomeV1 {
  if (job.status === "activated" || job.status === "installed") {
    return "succeeded";
  }
  if (job.status === "quarantined") return "degraded";
  if (job.status === "failed") return "failed";
  if (job.status === "queued" && job.recoveryCount > 0) return "recovered";
  if (job.status === "queued") return "started";
  return "in-progress";
}

function localSourceReliabilityExecution(
  job: LocalSourceUpdateJobV1,
): "running" | "succeeded" | "degraded" | "failed" {
  if (job.status === "activated" || job.status === "installed") {
    return "succeeded";
  }
  if (job.status === "quarantined") return "degraded";
  if (job.status === "failed") return "failed";
  return "running";
}

function localSourceReliabilityEventKind(
  job: LocalSourceUpdateJobV1,
): string {
  if (job.status === "queued" && job.recoveryCount > 0) {
    return "recovered-after-crash";
  }
  if (job.status === "failed" || job.status === "quarantined") {
    return "failure";
  }
  if (job.status === "activated" || job.status === "installed") {
    return "finalization";
  }
  if (job.status === "certifying") return "verification";
  return "transition";
}

function defaultCoordinatorReliabilityRoot(rootDirectory: string): string {
  const resolved = path.resolve(rootDirectory);
  return path.basename(resolved) === "data-updates"
    ? path.join(path.dirname(resolved), "reliability")
    : path.join(resolved, "reliability");
}

export function createLocalSourceUpdateCoordinator(
  options: CoordinatorOptions,
) {
  const root = path.join(path.resolve(options.rootDirectory), UPDATE_DIRECTORY_VERSION);
  const jobsRoot = path.join(root, "jobs");
  const statePath = path.join(root, STATE_FILENAME);
  const stateLockPath = path.join(root, "state.lock");
  const workerLockPath = path.join(root, "worker.lock");
  const candidatesRoot = path.join(root, "candidates");
  const now = options.now ?? (() => new Date());
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const pipeline =
    options.pipeline ?? createDefaultLocalSourceUpdatePipeline({ now });
  const reliabilityRootDirectory = path.resolve(
    options.reliability?.rootDirectory ??
      defaultCoordinatorReliabilityRoot(options.rootDirectory),
  );
  const reliabilityStore =
    options.reliability?.store ??
    createWorkflowReliabilityEventStore({
      rootDirectory: reliabilityRootDirectory,
    });

  const jobPath = (jobId: string) =>
    path.join(jobsRoot, jobId, JOB_FILENAME);

  const initialState = async (): Promise<LocalSourceUpdateStateV1> => {
    const instant = now().toISOString();
    return LocalSourceUpdateStateV1Schema.parse(
      await seal({
        schemaVersion: 1 as const,
        stateKind: "rosterpilot-local-source-update-state" as const,
        revision: 0,
        activeJobId: null,
        lastJobId: null,
        latestCandidate: null,
        latestObservation: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        nextAutomaticAttemptAt: null,
        updatedAt: instant,
      }),
    );
  };

  const readState = async (): Promise<LocalSourceUpdateStateV1> => {
    await mkdir(root, { recursive: true });
    try {
      const state = LocalSourceUpdateStateV1Schema.parse(
        await readJson(statePath),
      );
      await verifySeal(state);
      return state;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        const state = await initialState();
        await atomicWriteJson(statePath, state);
        return state;
      }
      throw error;
    }
  };

  const prunePublishedCandidates = async (): Promise<void> => {
    const state = await readState();
    const protectedDirectory = state.latestCandidate
      ? path.resolve(state.latestCandidate.directory)
      : null;
    const cutoff = now().getTime() - LOCAL_SOURCE_CANDIDATE_RETENTION_MS;
    let entries;
    try {
      entries = await readdir(candidatesRoot, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.resolve(candidatesRoot, entry.name);
      if (directory === protectedDirectory) continue;
      const metadata = await lstat(directory);
      if (metadata.mtimeMs >= cutoff) continue;
      await rm(directory, { recursive: true, force: true });
    }
  };

  const writeState = async (
    draft: Omit<LocalSourceUpdateStateV1, "integritySha256">,
  ): Promise<LocalSourceUpdateStateV1> => {
    const state = LocalSourceUpdateStateV1Schema.parse(await seal(draft));
    await atomicWriteJson(statePath, state);
    return state;
  };

  const readJob = async (jobId: string): Promise<LocalSourceUpdateJobV1> => {
    const raw = await readJson(jobPath(jobId));
    const current = LocalSourceUpdateJobV1Schema.safeParse(raw);
    if (current.success) {
      await verifySeal(current.data);
      return current.data;
    }
    const legacy = LegacyLocalSourceUpdateJobV1Schema.parse(raw);
    await verifySeal(legacy);
    return LocalSourceUpdateJobV1Schema.parse(
      await seal({
        ...withoutIntegrity(legacy),
        bsDataCommitOverride: null,
      }),
    );
  };

  const writeJobRecord = async (
    draft: Omit<LocalSourceUpdateJobV1, "integritySha256">,
  ): Promise<LocalSourceUpdateJobV1> => {
    const job = LocalSourceUpdateJobV1Schema.parse(await seal(draft));
    await atomicWriteJson(jobPath(job.jobId), job);
    return job;
  };

  const appendJobReliabilityWarning = (
    job: LocalSourceUpdateJobV1,
    warning: { code: string; message: string },
  ): Omit<LocalSourceUpdateJobV1, "integritySha256"> => {
    const warnings = job.reliabilityWarnings ?? [];
    const nextWarnings = warnings.some(
      (existing) =>
        existing.code === warning.code &&
        existing.message === warning.message,
    )
      ? warnings
      : [
          ...warnings,
          {
            ...warning,
            recordedAt: now().toISOString(),
          },
        ].slice(-20);
    return {
      ...withoutIntegrity(job),
      reliabilityWarnings: nextWarnings,
    };
  };

  const writeJob = async (
    draft: Omit<LocalSourceUpdateJobV1, "integritySha256">,
  ): Promise<LocalSourceUpdateJobV1> => {
    // The job document is the authoritative transition. Journal and identity
    // failures are advisory and are never allowed to undo this write.
    let job = await writeJobRecord(draft);
    const workflow = {
      workflowId: job.jobId,
      workflowKind: "local-data-update",
    } as const;
    const recorded = await appendWorkflowReliabilityEventSafely(
      reliabilityStore,
      {
        workflow,
        idempotencyKey: `data-update-revision:${job.revision}`,
        eventKind: localSourceReliabilityEventKind(job),
        stage: job.status,
        provider: "local-source",
        outcome: localSourceReliabilityOutcome(job),
        occurredAt: job.updatedAt,
        execution: {
          status: localSourceReliabilityExecution(job),
          attempt: job.revision + 1,
        },
        evidence: {
          status:
            job.status === "activated" || job.status === "installed"
              ? "verified"
              : job.status === "quarantined"
                ? "invalid"
                : job.evidence.length > 0
                  ? "partial"
                  : "pending",
          artifactCount: 1 + job.evidence.length,
          evidenceSha256: job.integritySha256,
        },
        error: job.error,
        attributes: {
          jobId: job.jobId,
          jobRevision: job.revision,
          trigger: job.trigger,
          forced: job.forced,
          recoveryCount: job.recoveryCount,
          officialReconciliation: job.officialReconciliation,
          candidateBundleId: job.candidate?.bundleId ?? null,
          jobStateSha256: job.integritySha256,
          evidence: job.evidence.map((entry) => ({
            stage: entry.stage,
            status: entry.status,
            sha256: entry.sha256,
          })),
          quarantinedScopes: job.quarantinedScopes,
        },
      },
    );
    let association: { ok: boolean; warning: string | null };
    try {
      association = await (
        options.reliability?.associateIdentities ??
        associateWorkflowReliabilityIdentities
      )(
        {
          workflow,
          identities: [
            { kind: "data-update-job-id", value: job.jobId },
          ],
        },
        { rootDirectory: reliabilityRootDirectory },
      );
    } catch (error) {
      association = {
        ok: false,
        warning:
          error instanceof Error
            ? error.message
            : "The local update reliability identity could not be associated.",
      };
    }
    const warnings: Array<{ code: string; message: string }> = [];
    if (!recorded.ok) warnings.push(recorded.error);
    if (!association.ok && association.warning) {
      warnings.push({
        code: "RELIABILITY_IDENTITY_ASSOCIATION_FAILED",
        message: association.warning,
      });
    }
    for (const warning of warnings) {
      const warned = appendJobReliabilityWarning(job, warning);
      job = await writeJobRecord(warned).catch(() => job);
    }
    return job;
  };

  const mutateJob = async (
    jobId: string,
    mutation: (
      job: Omit<LocalSourceUpdateJobV1, "integritySha256">,
    ) => Omit<LocalSourceUpdateJobV1, "integritySha256">,
  ): Promise<LocalSourceUpdateJobV1> => {
    const current = await readJob(jobId);
    return writeJob(
      mutation({
        ...withoutIntegrity(current),
        revision: current.revision + 1,
        updatedAt: now().toISOString(),
      }),
    );
  };

  const withStateLock = async <T>(action: () => Promise<T>): Promise<T> => {
    await mkdir(root, { recursive: true });
    const lock = await acquireDirectoryLock({
      directory: stateLockPath,
      now,
      isProcessAlive,
      staleAfterMs: STATE_LOCK_STALE_MS,
      waitMs: 2_000,
    });
    try {
      return await action();
    } finally {
      await lock.release();
    }
  };

  const recoverInterrupted = async (): Promise<LocalSourceUpdateJobV1 | null> =>
    withStateLock(async () => {
      const state = await readState();
      if (!state.activeJobId) return null;
      const job = await readJob(state.activeJobId);
      if (
        TERMINAL_JOB_STATUSES.has(job.status) &&
        job.completedAt
      ) {
        const affectsGlobalState = job.trigger !== "compatibility";
        const succeeded = ["installed", "activated"].includes(
          job.status,
        );
        const completionTime = new Date(job.completedAt).getTime();
        const retryableFailure =
          job.status === "failed" && job.error?.retryable === true;
        await writeState({
          ...withoutIntegrity(state),
          revision: state.revision + 1,
          activeJobId: null,
          lastJobId: job.jobId,
          latestCandidate: affectsGlobalState
            ? job.candidate ?? state.latestCandidate
            : state.latestCandidate,
          latestObservation: affectsGlobalState
            ? job.observation ?? state.latestObservation
            : state.latestObservation,
          lastAttemptAt: affectsGlobalState
            ? job.startedAt ?? job.completedAt
            : state.lastAttemptAt,
          lastSuccessAt:
            affectsGlobalState && succeeded
              ? job.completedAt
              : state.lastSuccessAt,
          consecutiveFailures: affectsGlobalState
            ? succeeded
              ? 0
              : retryableFailure
                ? state.consecutiveFailures + 1
                : state.consecutiveFailures
            : state.consecutiveFailures,
          nextAutomaticAttemptAt: affectsGlobalState
            ? succeeded
              ? new Date(
                  completionTime + LOCAL_SOURCE_CHECK_INTERVAL_MS,
                ).toISOString()
              : job.retryAt ??
                new Date(
                  completionTime + LOCAL_SOURCE_CHECK_INTERVAL_MS,
                ).toISOString()
            : state.nextAutomaticAttemptAt,
          updatedAt: now().toISOString(),
        });
        return job;
      }
      if (job.status === "queued") {
        return job;
      }
      let workerOwner: z.infer<typeof lockOwnerSchema> | null = null;
      try {
        workerOwner = lockOwnerSchema.parse(
          await readJson(path.join(workerLockPath, "owner.json")),
        );
      } catch {
        workerOwner = null;
      }
      if (workerOwner && isProcessAlive(workerOwner.pid)) {
        return job;
      }
      if (!workerOwner) {
        try {
          const lockAge =
            now().getTime() - (await stat(workerLockPath)).mtimeMs;
          if (lockAge < WORKER_LOCK_STALE_GRACE_MS) {
            return job;
          }
        } catch {
          // A missing lock means the nonterminal job can be recovered.
        }
      }
      await rm(workerLockPath, { recursive: true, force: true });
      return mutateJob(job.jobId, (draft) => ({
        ...draft,
        status: "queued",
        progress:
          "Recovered an interrupted local update; isolated build work will restart safely.",
        completedAt: null,
        retryAt: null,
        recoveryCount: draft.recoveryCount + 1,
        error: null,
      }));
    });

  const enqueue = async (input: {
    trigger: LocalSourceUpdateTrigger;
    force?: boolean;
    bsDataCommitOverride?: string | null;
  }): Promise<{
    queued: boolean;
    due: LocalSourceUpdateDueResult;
    job: LocalSourceUpdateJobV1 | null;
  }> =>
    withStateLock(async () => {
      const state = await readState();
      if (state.activeJobId) {
        const active = await readJob(state.activeJobId);
        return {
          queued: false,
          due: evaluateLocalSourceUpdateDue(state, now(), input.force),
          job: active,
        };
      }
      const force = input.force ?? false;
      const due = evaluateLocalSourceUpdateDue(state, now(), force);
      if (!due.due && ["startup", "scheduled"].includes(input.trigger)) {
        return { queued: false, due, job: null };
      }
      const instant = now().toISOString();
      const bsDataCommitOverride = input.bsDataCommitOverride ?? null;
      if (
        bsDataCommitOverride &&
        !/^[a-f0-9]{40}$/.test(bsDataCommitOverride)
      ) {
        throw new Error(
          "bsDataCommitOverride must be one exact lowercase 40-character commit.",
        );
      }
      const job = await writeJob({
        schemaVersion: 1,
        jobKind: "rosterpilot-local-source-update",
        jobId: crypto.randomUUID(),
        revision: 0,
        trigger: input.trigger,
        forced: force,
        status: "queued",
        progress: "Local upstream data update queued.",
        createdAt: instant,
        startedAt: null,
        updatedAt: instant,
        completedAt: null,
        retryAt: null,
        recoveryCount: 0,
        bsDataCommitOverride,
        observation: null,
        officialReconciliation: "unavailable",
        candidate: null,
        evidence: [],
        quarantinedScopes: [],
        reliabilityWarnings: [],
        error: null,
      });
      await writeState({
        ...withoutIntegrity(state),
        revision: state.revision + 1,
        activeJobId: job.jobId,
        lastJobId: job.jobId,
        updatedAt: instant,
      });
      return { queued: true, due, job };
    });

  const finalizeState = async (
    job: LocalSourceUpdateJobV1,
    result: {
      succeeded: boolean;
      candidate?: LocalSourceCandidateReference | null;
      observation?: LocalSourceObservationV1 | null;
      retryAt?: string | null;
      countFailure?: boolean;
      affectsGlobalState?: boolean;
    },
  ): Promise<void> => {
    await withStateLock(async () => {
      const state = await readState();
      const instant = now().toISOString();
      const affectsGlobalState = result.affectsGlobalState ?? true;
      const failures = result.succeeded
        ? 0
        : result.countFailure
          ? state.consecutiveFailures + 1
          : state.consecutiveFailures;
      await writeState({
        ...withoutIntegrity(state),
        revision: state.revision + 1,
        activeJobId:
          state.activeJobId === job.jobId ? null : state.activeJobId,
        lastJobId: job.jobId,
        latestCandidate:
          affectsGlobalState
            ? result.candidate ?? state.latestCandidate
            : state.latestCandidate,
        latestObservation:
          affectsGlobalState
            ? result.observation ?? state.latestObservation
            : state.latestObservation,
        lastAttemptAt: affectsGlobalState
          ? job.startedAt ?? instant
          : state.lastAttemptAt,
        lastSuccessAt: affectsGlobalState
          ? result.succeeded
            ? instant
            : state.lastSuccessAt
          : state.lastSuccessAt,
        consecutiveFailures: affectsGlobalState
          ? failures
          : state.consecutiveFailures,
        nextAutomaticAttemptAt: affectsGlobalState
          ? result.succeeded
            ? new Date(
                now().getTime() + LOCAL_SOURCE_CHECK_INTERVAL_MS,
              ).toISOString()
            : result.retryAt ??
              new Date(
                now().getTime() + LOCAL_SOURCE_CHECK_INTERVAL_MS,
              ).toISOString()
          : state.nextAutomaticAttemptAt,
        updatedAt: instant,
      });
    });
  };

  const runJob = async (jobId: string): Promise<LocalSourceUpdateJobV1> => {
    await recoverInterrupted();
    const workerLock = await acquireDirectoryLock({
      directory: workerLockPath,
      now,
      isProcessAlive,
      staleAfterMs: WORKER_LOCK_STALE_GRACE_MS,
    });
    let current = await readJob(jobId);
    try {
      if (TERMINAL_JOB_STATUSES.has(current.status)) return current;
      const startingState = await readState();
      if (startingState.activeJobId !== jobId) {
        throw new LocalSourcePipelineError(
          "LOCAL_SOURCE_JOB_NOT_ACTIVE",
          `Local-source job ${jobId} is not the active queued update.`,
        );
      }
      current = await mutateJob(jobId, (draft) => ({
        ...draft,
        status: "checking",
        progress: "Checking allowlisted upstream data sources.",
        startedAt: draft.startedAt ?? now().toISOString(),
        completedAt: null,
        retryAt: null,
        error: null,
      }));
      const state = await readState();
      const result = await pipeline.run({
        jobId,
        jobDirectory: path.dirname(jobPath(jobId)),
        projectRoot: options.projectRoot,
        supportRoot: root,
        latestCandidate: state.latestCandidate,
        force: current.forced,
        bsDataCommitOverride: current.bsDataCommitOverride,
        onProgress: async (status, progress) => {
          current = await mutateJob(jobId, (draft) => ({
            ...draft,
            status,
            progress,
          }));
        },
      });
      current = await mutateJob(jobId, (draft) => ({
        ...draft,
        status: "certifying",
        progress:
          result.kind === "candidate"
            ? "The locally verified candidate is ready for durable installation."
            : "The verified local data is current; finalizing the durable job.",
        observation: result.observation,
        officialReconciliation: result.officialReconciliation,
        candidate: result.candidate,
        evidence: result.evidence,
        quarantinedScopes: [],
        error: null,
      }));
      const activationAllowed = current.trigger !== "compatibility";
      let activated = result.kind === "current" && activationAllowed;
      if (result.candidate && options.consumeCandidate) {
        const consumed = await options.consumeCandidate(result.candidate, {
          jobId,
          trigger: current.trigger,
          activate: activationAllowed,
          force: current.forced,
          bsDataCommitOverride: current.bsDataCommitOverride,
        });
        if (!consumed.installed) {
          throw new LocalSourcePipelineError(
            "LOCAL_SOURCE_CANDIDATE_INSTALL_FAILED",
            "The local data store did not install the verified candidate.",
          );
        }
        if (!activationAllowed && consumed.activated) {
          throw new LocalSourcePipelineError(
            "LOCAL_SOURCE_COMPATIBILITY_ACTIVATION_FORBIDDEN",
            "A compatibility-only candidate consumer reported an unexpected global activation.",
          );
        }
        activated = activationAllowed && consumed.activated;
      }
      if (activated) {
        current = await mutateJob(jobId, (draft) => ({
          ...draft,
          status: "activated",
          progress:
            result.kind === "current"
              ? "Local upstream data is current."
              : "The locally verified candidate was atomically activated for future operations.",
          completedAt: now().toISOString(),
        }));
      } else {
        current = await mutateJob(jobId, (draft) => ({
          ...draft,
          status: "installed",
          progress:
            current.trigger === "compatibility"
              ? "The locally verified compatibility snapshot was installed without changing the globally active snapshot."
              : "The locally verified candidate was installed for explicit activation.",
          completedAt: now().toISOString(),
        }));
      }
      await finalizeState(current, {
        succeeded: true,
        candidate: result.candidate,
        observation: result.observation,
        affectsGlobalState: current.trigger !== "compatibility",
      });
      await prunePublishedCandidates().catch(() => undefined);
      return current;
    } catch (error) {
      const pipelineError =
        error instanceof LocalSourcePipelineError
          ? error
          : new LocalSourcePipelineError(
              "LOCAL_SOURCE_UPDATE_FAILED",
              error instanceof Error ? error.message : String(error),
              { retryable: true, cause: error },
            );
      const quarantined = pipelineError.quarantinedScopes.length > 0;
      const state = await readState();
      const nextFailureCount = state.consecutiveFailures + 1;
      const retryAt = pipelineError.retryable
        ? new Date(
            now().getTime() + localSourceRetryDelayMs(nextFailureCount),
          ).toISOString()
        : null;
      current = await mutateJob(jobId, (draft) => ({
        ...draft,
        status: quarantined ? "quarantined" : "failed",
        progress: quarantined
          ? "The candidate was quarantined; the active snapshot was preserved."
          : "The local update failed; the active snapshot was preserved.",
        completedAt: now().toISOString(),
        retryAt,
        observation: pipelineError.observation ?? draft.observation,
        evidence:
          pipelineError.evidence.length > 0
            ? pipelineError.evidence
            : draft.evidence,
        quarantinedScopes: pipelineError.quarantinedScopes,
        error: {
          code: pipelineError.code,
          message: pipelineError.message.slice(0, 4_000),
          retryable: pipelineError.retryable,
        },
      }));
      await finalizeState(current, {
        succeeded: false,
        observation: pipelineError.observation,
        retryAt,
        countFailure: pipelineError.retryable,
        affectsGlobalState: current.trigger !== "compatibility",
      });
      await prunePublishedCandidates().catch(() => undefined);
      return current;
    } finally {
      await workerLock.release();
    }
  };

  const runNext = async (): Promise<LocalSourceUpdateJobV1 | null> => {
    await recoverInterrupted();
    const state = await readState();
    return state.activeJobId ? runJob(state.activeJobId) : null;
  };

  return {
    rootDirectory: root,
    getState: readState,
    getJob: readJob,
    getStatus: async () => {
      const state = await readState();
      return {
        state,
        activeJob: state.activeJobId
          ? await readJob(state.activeJobId)
          : null,
        due: evaluateLocalSourceUpdateDue(state, now()),
      };
    },
    enqueue,
    recoverInterrupted,
    runJob,
    runNext,
  };
}
