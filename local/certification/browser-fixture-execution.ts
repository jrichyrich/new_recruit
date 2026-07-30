import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

export const BrowserFixtureRegistrySchema = z
  .object({
    schemaVersion: z.literal(2),
    fixtureKind: z.literal(
      "rosterpilot-browser-certification-registry",
    ),
    fixtures: z.array(
      z
        .object({
          id: z.string().min(1),
          automatedBy: z.string().min(1),
          testName: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    for (const [index, fixture] of registry.fixtures.entries()) {
      if (ids.has(fixture.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fixtures", index, "id"],
          message: `Duplicate browser fixture id "${fixture.id}".`,
        });
      }
      ids.add(fixture.id);
    }
  });

export type BrowserFixtureRegistry = z.infer<
  typeof BrowserFixtureRegistrySchema
>;

export type BrowserFixtureExecutionStatus =
  | "pass"
  | "fail"
  | "skipped"
  | "missing"
  | "ambiguous";

export type BrowserFixtureExecutionResult = {
  id: string;
  automatedBy: string;
  testName: string;
  status: BrowserFixtureExecutionStatus;
  code: string | null;
  durationMs: number | null;
  detail: string | null;
};

export type BrowserFixtureExecutionEvidence = {
  schemaVersion: 1;
  evidenceKind: "rosterpilot-browser-fixture-execution";
  executionId: string;
  startedAt: string;
  completedAt: string;
  runner: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    command: string[];
  };
  registry: {
    path: string;
    sha256: string;
    fixtures: Array<{
      id: string;
      automatedBy: string;
      testName: string;
    }>;
  };
  sourceFiles: Array<{
    path: string;
    sha256: string;
  }>;
  process: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    outputExceeded: boolean;
    stdoutSha256: string;
    stderrSha256: string;
  };
  observations: Array<{
    name: string;
    file: string | null;
    durationMs: number | null;
    status: "pass" | "fail" | "skipped";
    detail: string | null;
  }>;
  results: BrowserFixtureExecutionResult[];
};

type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputExceeded: boolean;
  stdout: string;
  stderr: string;
};

type ExecuteBrowserFixtureOptions = {
  projectRoot: string;
  registryPath: string;
  fixtureIds: readonly string[];
  timeoutMs?: number;
};

type ExecuteBrowserFixtureDependencies = {
  run?: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
    },
  ) => Promise<ProcessResult>;
};

type JunitTestCase = {
  name: string;
  file: string | null;
  durationMs: number | null;
  status: "pass" | "fail" | "skipped";
  detail: string | null;
};

const MAX_TEST_OUTPUT_BYTES = 16 * 1024 * 1024;

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalRelativePath(
  projectRoot: string,
  filename: string,
): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(resolvedRoot, filename);
  const relative = path.relative(resolvedRoot, resolved);
  if (
    path.isAbsolute(filename) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Browser fixture test path "${filename}" leaves the project root.`,
    );
  }
  return relative.split(path.sep).join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    );
}

function attribute(
  source: string,
  name: string,
): string | null {
  const match = source.match(
    new RegExp(`(?:^|\\s)${name}="([^"]*)"`),
  );
  return match ? decodeXml(match[1]) : null;
}

function boundedFailureDetail(value: string): string {
  const normalized = decodeXml(value)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= 2_000) return normalized;
  return `${normalized.slice(0, 500)} … ${normalized.slice(-1_450)}`;
}

export function parseJunitTestCases(
  source: string,
): JunitTestCase[] {
  const results: JunitTestCase[] = [];
  const pattern =
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of source.matchAll(pattern)) {
    const attributes = match[1];
    const body = match[2] ?? "";
    const name = attribute(attributes, "name");
    if (!name) continue;
    const seconds = Number(attribute(attributes, "time"));
    const failure =
      body.match(/<(?:failure|error)\b[^>]*>([\s\S]*?)<\/(?:failure|error)>/) ??
      body.match(/<(?:failure|error)\b([^>]*)\/>/);
    const skipped = /<skipped\b/.test(body);
    results.push({
      name,
      file: attribute(attributes, "file"),
      durationMs: Number.isFinite(seconds)
        ? Math.round(seconds * 1_000)
        : null,
      status: failure ? "fail" : skipped ? "skipped" : "pass",
      detail: failure
        ? boundedFailureDetail(failure[1] ?? "") ||
          "The registered fixture test failed."
        : null,
    });
  }
  return results;
}

async function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const collect = (
      chunks: Buffer[],
      chunk: Buffer,
      stream: "stdout" | "stderr",
    ) => {
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if (
        stdoutBytes + stderrBytes >
        MAX_TEST_OUTPUT_BYTES
      ) {
        outputExceeded = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) =>
      collect(stdout, chunk, "stdout")
    );
    child.stderr.on("data", (chunk: Buffer) =>
      collect(stderr, chunk, "stderr")
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const outputError = outputExceeded
        ? "\nCERTIFICATION_BROWSER_FIXTURE_OUTPUT_LIMIT_EXCEEDED"
        : "";
      resolve({
        exitCode,
        signal,
        timedOut,
        outputExceeded,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr:
          Buffer.concat(stderr).toString("utf8") + outputError,
      });
    });
  });
}

function observedRelativePath(
  projectRoot: string,
  filename: string | null,
): string | null {
  if (!filename) return null;
  const relative = path.relative(
    path.resolve(projectRoot),
    path.resolve(projectRoot, filename),
  );
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

function sanitizeExecutionDetail(
  value: string | null,
  projectRoot: string,
): string | null {
  if (!value) return value;
  return [
    [path.resolve(projectRoot), "<project-root>"],
    [os.tmpdir(), "<temporary-directory>"],
    [os.homedir(), "<home-directory>"],
  ].reduce(
    (result, [source, replacement]) =>
      result.replaceAll(source, replacement),
    value,
  );
}

export async function executeBrowserFixtureRegistry(
  options: ExecuteBrowserFixtureOptions,
  dependencies: ExecuteBrowserFixtureDependencies = {},
): Promise<BrowserFixtureExecutionEvidence> {
  const startedAt = new Date().toISOString();
  const registryText = await readFile(options.registryPath, "utf8");
  const registry = BrowserFixtureRegistrySchema.parse(
    JSON.parse(registryText),
  );
  const requestedIds = new Set(options.fixtureIds);
  const selected = registry.fixtures.filter((fixture) =>
    requestedIds.has(fixture.id)
  );
  const selectedIds = new Set(selected.map((fixture) => fixture.id));
  const missingIds = options.fixtureIds.filter(
    (fixtureId) => !selectedIds.has(fixtureId),
  );
  if (missingIds.length > 0) {
    throw new Error(
      `Browser fixtures are not registered: ${missingIds.join(", ")}.`,
    );
  }

  const sourceFiles = [
    ...new Set(
      selected.map((fixture) =>
        canonicalRelativePath(
          options.projectRoot,
          fixture.automatedBy,
        )
      ),
    ),
  ].sort();
  const sourceHashesBefore = new Map<string, string>();
  for (const filename of sourceFiles) {
    sourceHashesBefore.set(
      filename,
      sha256(
        await readFile(
          path.join(options.projectRoot, filename),
        ),
      ),
    );
  }

  const testNames = [
    ...new Set(selected.map((fixture) => fixture.testName)),
  ].sort();
  const namePattern = `^(?:${testNames
    .map(escapeRegex)
    .join("|")})$`;
  const command = [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--test-reporter=junit",
    `--test-name-pattern=${namePattern}`,
    ...sourceFiles,
  ];
  const processResult = await (dependencies.run ?? runProcess)(
    process.execPath,
    command,
    {
      cwd: options.projectRoot,
      env: {
        ...process.env,
        ROSTERPILOT_BROWSER_TESTS: "1",
        ROSTERPILOT_CONNECTOR_FIXTURE_MODE: "1",
      },
      timeoutMs: options.timeoutMs ?? 15 * 60 * 1_000,
    },
  );

  let sourceChanged = false;
  const sourceEvidence: BrowserFixtureExecutionEvidence["sourceFiles"] =
    [];
  for (const filename of sourceFiles) {
    const after = sha256(
      await readFile(path.join(options.projectRoot, filename)),
    );
    sourceChanged ||= sourceHashesBefore.get(filename) !== after;
    sourceEvidence.push({ path: filename, sha256: after });
  }

  const observed = parseJunitTestCases(processResult.stdout).map(
    (result) => ({
      ...result,
      detail: sanitizeExecutionDetail(
        result.detail,
        options.projectRoot,
      ),
    }),
  );
  const observations =
    observed.map<
      BrowserFixtureExecutionEvidence["observations"][number]
    >((result) => ({
      ...result,
      file: observedRelativePath(
        options.projectRoot,
        result.file,
      ),
    }));
  const runnerFailure =
    processResult.timedOut ||
    processResult.outputExceeded ||
    processResult.signal !== null ||
    processResult.exitCode !== 0;
  const results = selected.map<BrowserFixtureExecutionResult>(
    (fixture) => {
      const registeredFile = canonicalRelativePath(
        options.projectRoot,
        fixture.automatedBy,
      );
      const matches = observed.filter(
        (result) =>
          result.name === fixture.testName &&
          observedRelativePath(
            options.projectRoot,
            result.file,
          ) === registeredFile,
      );
      if (sourceChanged) {
        return {
          ...fixture,
          status: "fail",
          code: "CERTIFICATION_BROWSER_FIXTURE_SOURCE_CHANGED",
          durationMs: null,
          detail:
            "A registered browser fixture source changed while its tests were executing.",
        };
      }
      if (runnerFailure) {
        const observedFailure = matches.find(
          (match) => match.status === "fail",
        );
        const observedSkip = matches.find(
          (match) => match.status === "skipped",
        );
        return {
          ...fixture,
          status: "fail",
          code: observedFailure
            ? "CERTIFICATION_BROWSER_FIXTURE_FAILED"
            : observedSkip
              ? "CERTIFICATION_BROWSER_FIXTURE_SKIPPED"
              : processResult.timedOut
                ? "CERTIFICATION_BROWSER_FIXTURE_TIMEOUT"
                : processResult.outputExceeded
                  ? "CERTIFICATION_BROWSER_FIXTURE_OUTPUT_LIMIT_EXCEEDED"
                  : "CERTIFICATION_BROWSER_FIXTURE_RUNNER_FAILED",
          durationMs: matches[0]?.durationMs ?? null,
          detail:
            observedFailure?.detail ??
            (observedSkip
              ? "The registered browser fixture test was skipped."
              : processResult.timedOut
                ? "The browser fixture runner timed out."
                : processResult.outputExceeded
                  ? "The browser fixture runner exceeded its bounded output limit."
                  : `The browser fixture runner did not exit cleanly (exit ${processResult.exitCode ?? "null"}, signal ${processResult.signal ?? "none"}).`),
        };
      }
      if (matches.length === 0) {
        return {
          ...fixture,
          status: "missing",
          code: processResult.timedOut
            ? "CERTIFICATION_BROWSER_FIXTURE_TIMEOUT"
            : "CERTIFICATION_BROWSER_FIXTURE_NOT_EXECUTED",
          durationMs: null,
          detail: processResult.timedOut
            ? "The browser fixture runner timed out."
            : "The registered node:test case was not present in the execution evidence.",
        };
      }
      if (matches.length > 1) {
        return {
          ...fixture,
          status: "ambiguous",
          code: "CERTIFICATION_BROWSER_FIXTURE_AMBIGUOUS",
          durationMs: null,
          detail:
            "The registered node:test case appeared more than once in the execution evidence.",
        };
      }
      const [match] = matches;
      if (match.status === "pass") {
        return {
          ...fixture,
          status: "pass",
          code: null,
          durationMs: match.durationMs,
          detail: null,
        };
      }
      return {
        ...fixture,
        status: match.status,
        code:
          match.status === "skipped"
            ? "CERTIFICATION_BROWSER_FIXTURE_SKIPPED"
            : "CERTIFICATION_BROWSER_FIXTURE_FAILED",
        durationMs: match.durationMs,
        detail:
          match.detail ??
          (match.status === "skipped"
            ? "The registered browser fixture test was skipped."
            : "The registered browser fixture test failed."),
      };
    },
  );
  const completedAt = new Date().toISOString();
  const executionSeed = JSON.stringify({
    startedAt,
    completedAt,
    registrySha256: sha256(registryText),
    sourceEvidence,
    stdoutSha256: sha256(processResult.stdout),
    stderrSha256: sha256(processResult.stderr),
    results,
  });
  return {
    schemaVersion: 1,
    evidenceKind: "rosterpilot-browser-fixture-execution",
    executionId: sha256(executionSeed),
    startedAt,
    completedAt,
    runner: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      command: [
        "node",
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-reporter=junit",
        "--test-name-pattern=<registered-fixtures>",
        ...sourceFiles,
      ],
    },
    registry: {
      path: canonicalRelativePath(
        options.projectRoot,
        path.relative(options.projectRoot, options.registryPath),
      ),
      sha256: sha256(registryText),
      fixtures: selected,
    },
    sourceFiles: sourceEvidence,
    process: {
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      timedOut: processResult.timedOut,
      outputExceeded: processResult.outputExceeded,
      stdoutSha256: sha256(processResult.stdout),
      stderrSha256: sha256(processResult.stderr),
    },
    observations,
    results,
  };
}
