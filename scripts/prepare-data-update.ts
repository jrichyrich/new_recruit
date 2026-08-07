import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkDataFreshness,
  type LiveDataFreshness,
} from "../lib/rosterpilot";

export type SourceManifest = {
  schemaVersion: 1;
  releaseId: string;
  rules: {
    package: "@alpaca-software/40kdc-data";
    version: string;
    edition: "11th";
    dataslate: string;
  };
  newRecruit: {
    repository: "BSData/wh40k-11e";
    url: string;
    branch: string;
    commit: string;
  };
  official: {
    downloadsUrl: string;
    mfmUrl: string;
    mfmVersion: string;
    updatedAt: string;
    contentSha256: string;
    checkedAt: string;
  };
};

type CatalogueSummary = {
  releaseId: string;
  summary: {
    factionCount: number;
    exportCapableFactions: number;
    completeFactions: number;
    conflicts: number;
    blockingConflicts: number;
    uniqueConflicts?: number;
    uniqueBlockingConflicts?: number;
  };
  factions: Record<
    string,
    {
      configurationAvailable: boolean;
      coverage: {
        mappedUnits: number;
        mappedDetachments: number;
      };
    }
  >;
};

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => void;

export const DATA_UPDATE_USAGE = `Usage: npm run data:prepare-update:legacy-direct-sync -- [--help]

Legacy maintenance command: validate and atomically rewrite the tracked
bootstrap data. Routine releases use npm run data:prepare-update instead.

Options:
  -h, --help  Show this help without checking or changing data.
`;

export class DataUpdateCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataUpdateCliUsageError";
  }
}

export function parseDataUpdateArgs(argv: readonly string[]): {
  help: boolean;
} {
  let help = false;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    throw new DataUpdateCliUsageError(
      `Unknown data-update option: ${argument}`,
    );
  }
  return { help };
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const publishPaths = [
  "package.json",
  "package-lock.json",
  "data/sources.json",
  "data/generated/new-recruit-catalogues.json",
  "data/generated/new-recruit-summary.json",
  "data/certification-manifest.json",
] as const;
export const DATA_UPDATE_TRANSACTION_DIRECTORY =
  ".rosterpilot-data-update-transaction";
export const DATA_UPDATE_LOCK_DIRECTORY =
  ".rosterpilot-data-update-lock";
const OWNERLESS_LOCK_STALE_AFTER_MS = 60_000;

type PublishJournal = {
  schemaVersion: 1;
  phase: "preparing" | "publishing" | "committed";
  relativePaths: string[];
  existedPaths: string[];
};

type PublishLockOwner = {
  pid: number;
  startedAt: string;
  token: string;
};

function readJson<T>(filename: string): T {
  return JSON.parse(readFileSync(filename, "utf8")) as T;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function nextReleaseId(current: string, checkedAt: string): string {
  const date = checkedAt.slice(0, 10);
  const match = current.match(new RegExp(`^${date}\\.(\\d+)$`));
  return `${date}.${match ? Number(match[1]) + 1 : 1}`;
}

export function nextSourceManifest(
  source: SourceManifest,
  freshness: LiveDataFreshness,
): SourceManifest {
  const next = structuredClone(source);
  let sourceIdentityChanged = false;
  if (
    freshness.rules.updateAvailable &&
    freshness.rules.latestVersion &&
    freshness.rules.latestVersion !== source.rules.version
  ) {
    next.rules.version = freshness.rules.latestVersion;
    sourceIdentityChanged = true;
  }
  if (
    freshness.newRecruit.updateAvailable &&
    freshness.newRecruit.latestCommit &&
    freshness.newRecruit.latestCommit !== source.newRecruit.commit
  ) {
    next.newRecruit.commit = freshness.newRecruit.latestCommit;
    sourceIdentityChanged = true;
  }
  if (freshness.official.updateAvailable) {
    const latestVersion =
      freshness.official.latestVersion ?? source.official.mfmVersion;
    const latestContentSha256 =
      freshness.official.latestContentSha256 ??
      source.official.contentSha256;
    if (
      latestVersion !== source.official.mfmVersion ||
      latestContentSha256 !== source.official.contentSha256
    ) {
      next.official.mfmVersion = latestVersion;
      next.official.contentSha256 = latestContentSha256;
      sourceIdentityChanged = true;
    }
  }
  if (sourceIdentityChanged) {
    next.official.checkedAt = freshness.checkedAt;
    next.releaseId = nextReleaseId(
      source.releaseId,
      freshness.checkedAt,
    );
  }
  return next;
}

function exportAvailable(
  faction: CatalogueSummary["factions"][string] | undefined,
): boolean {
  return Boolean(
    faction?.configurationAvailable &&
      faction.coverage.mappedUnits > 0 &&
      faction.coverage.mappedDetachments > 0,
  );
}

export function mappingRegressionReasons(
  previous: CatalogueSummary,
  next: CatalogueSummary,
): string[] {
  const reasons: string[] = [];
  if (next.summary.factionCount !== previous.summary.factionCount) {
    reasons.push(
      `faction count changed from ${previous.summary.factionCount} to ${next.summary.factionCount}`,
    );
  }
  if (
    next.summary.exportCapableFactions <
    previous.summary.exportCapableFactions
  ) {
    reasons.push(
      `export-capable factions fell from ${previous.summary.exportCapableFactions} to ${next.summary.exportCapableFactions}`,
    );
  }
  if (next.summary.conflicts > previous.summary.conflicts) {
    reasons.push(
      `mapping conflicts rose from ${previous.summary.conflicts} to ${next.summary.conflicts}`,
    );
  }
  if (
    next.summary.blockingConflicts >
    previous.summary.blockingConflicts
  ) {
    reasons.push(
      `blocking mapping conflicts rose from ${previous.summary.blockingConflicts} to ${next.summary.blockingConflicts}`,
    );
  }
  if (
    previous.summary.uniqueConflicts !== undefined &&
    next.summary.uniqueConflicts === undefined
  ) {
    reasons.push("unique mapping-conflict evidence disappeared");
  } else if (
    previous.summary.uniqueConflicts !== undefined &&
    next.summary.uniqueConflicts !== undefined &&
    next.summary.uniqueConflicts > previous.summary.uniqueConflicts
  ) {
    reasons.push(
      `unique mapping conflicts rose from ${previous.summary.uniqueConflicts} to ${next.summary.uniqueConflicts}`,
    );
  }
  if (
    previous.summary.uniqueBlockingConflicts !== undefined &&
    next.summary.uniqueBlockingConflicts === undefined
  ) {
    reasons.push("unique blocking mapping-conflict evidence disappeared");
  } else if (
    previous.summary.uniqueBlockingConflicts !== undefined &&
    next.summary.uniqueBlockingConflicts !== undefined &&
    next.summary.uniqueBlockingConflicts >
      previous.summary.uniqueBlockingConflicts
  ) {
    reasons.push(
      `unique blocking mapping conflicts rose from ${previous.summary.uniqueBlockingConflicts} to ${next.summary.uniqueBlockingConflicts}`,
    );
  }
  for (const [factionId, faction] of Object.entries(previous.factions)) {
    if (
      exportAvailable(faction) &&
      !exportAvailable(next.factions[factionId])
    ) {
      reasons.push(`${factionId} lost selected-roster export capability`);
    }
  }
  return reasons.sort();
}

function assertSafePublishPaths(relativePaths: readonly string[]): void {
  for (const relativePath of relativePaths) {
    const normalized = path.normalize(relativePath);
    if (
      path.isAbsolute(relativePath) ||
      normalized === ".." ||
      normalized.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        `Data update publish path must stay inside the project: ${relativePath}.`,
      );
    }
  }
}

function writePublishJournal(
  transactionRoot: string,
  journal: PublishJournal,
): void {
  const filename = path.join(transactionRoot, "journal.json");
  const temporary = path.join(transactionRoot, "journal.next.json");
  writeFileSync(temporary, stableJson(journal), { flag: "w" });
  renameSync(temporary, filename);
}

function processIsActive(pid: number): boolean {
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

function acquireDataUpdateLock(destinationRoot: string): string {
  const lockRoot = path.join(
    destinationRoot,
    DATA_UPDATE_LOCK_DIRECTORY,
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner: PublishLockOwner = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: randomUUID(),
    };
    try {
      mkdirSync(lockRoot, { recursive: false });
      writeFileSync(
        path.join(lockRoot, "owner.json"),
        stableJson(owner),
        { flag: "wx" },
      );
      return owner.token;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        )
      ) {
        throw error;
      }
      const ownerPath = path.join(lockRoot, "owner.json");
      let existing: PublishLockOwner | null = null;
      try {
        existing = readJson<PublishLockOwner>(ownerPath);
      } catch {
        const transactionExists = existsSync(
          path.join(
            destinationRoot,
            DATA_UPDATE_TRANSACTION_DIRECTORY,
          ),
        );
        const lockAgeMs =
          Date.now() - statSync(lockRoot).mtimeMs;
        if (
          !transactionExists &&
          lockAgeMs >= OWNERLESS_LOCK_STALE_AFTER_MS
        ) {
          rmSync(lockRoot, { recursive: true, force: true });
          continue;
        }
        throw new Error(
          `A data update lock exists without readable owner metadata: ${lockRoot}. Wait one minute and retry; an ownerless pre-transaction lock is then recovered automatically.`,
        );
      }
      if (
        Number.isInteger(existing.pid) &&
        existing.pid > 0 &&
        processIsActive(existing.pid)
      ) {
        throw new Error(
          `A data update is already in progress under process ${existing.pid} since ${existing.startedAt}.`,
        );
      }
      rmSync(lockRoot, { recursive: true, force: true });
    }
  }
  throw new Error("Could not acquire the data update lock.");
}

function releaseDataUpdateLock(
  destinationRoot: string,
  token: string,
): void {
  const lockRoot = path.join(
    destinationRoot,
    DATA_UPDATE_LOCK_DIRECTORY,
  );
  if (!existsSync(lockRoot)) return;
  const owner = readJson<PublishLockOwner>(
    path.join(lockRoot, "owner.json"),
  );
  if (owner.token !== token) {
    throw new Error(
      "The data update lock owner changed before release.",
    );
  }
  rmSync(lockRoot, { recursive: true, force: true });
}

/**
 * Restores the last complete release after an interrupted publish. A committed
 * journal means all replacements completed and only transaction cleanup was
 * interrupted, so the new release is retained.
 */
function recoverInterruptedDataUpdateUnlocked(
  destinationRoot: string,
): string[] {
  const transactionRoot = path.join(
    destinationRoot,
    DATA_UPDATE_TRANSACTION_DIRECTORY,
  );
  if (!existsSync(transactionRoot)) return [];
  const journalPath = path.join(transactionRoot, "journal.json");
  if (!existsSync(journalPath)) {
    rmSync(transactionRoot, { recursive: true, force: true });
    return [];
  }
  const journal = readJson<PublishJournal>(journalPath);
  if (
    journal.schemaVersion !== 1 ||
    !["preparing", "publishing", "committed"].includes(journal.phase) ||
    !Array.isArray(journal.relativePaths) ||
    !Array.isArray(journal.existedPaths)
  ) {
    throw new Error(
      `The interrupted data-update journal is invalid: ${journalPath}.`,
    );
  }
  assertSafePublishPaths(journal.relativePaths);
  if (journal.phase === "preparing" || journal.phase === "committed") {
    rmSync(transactionRoot, { recursive: true, force: true });
    return [];
  }

  const existed = new Set(journal.existedPaths);
  const restored: string[] = [];
  for (const relativePath of journal.relativePaths) {
    const destination = path.join(destinationRoot, relativePath);
    if (!existed.has(relativePath)) {
      rmSync(destination, { force: true });
      restored.push(relativePath);
      continue;
    }
    const backup = path.join(
      transactionRoot,
      "backup",
      relativePath,
    );
    if (!existsSync(backup)) {
      throw new Error(
        `Cannot recover interrupted data update because the backup for ${relativePath} is missing.`,
      );
    }
    const replacement = path.join(
      transactionRoot,
      "recovery",
      relativePath,
    );
    mkdirSync(path.dirname(replacement), { recursive: true });
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(backup, replacement);
    renameSync(replacement, destination);
    restored.push(relativePath);
  }
  rmSync(transactionRoot, { recursive: true, force: true });
  return restored;
}

export function recoverInterruptedDataUpdate(
  destinationRoot: string,
): string[] {
  const lockToken = acquireDataUpdateLock(destinationRoot);
  try {
    return recoverInterruptedDataUpdateUnlocked(destinationRoot);
  } finally {
    releaseDataUpdateLock(destinationRoot, lockToken);
  }
}

/**
 * Publishes a validated staging set and restores every original if any
 * replacement fails. A durable journal also makes a process interruption
 * recoverable on the next update attempt.
 */
export function publishFilesAtomically(
  stagingRoot: string,
  destinationRoot: string,
  relativePaths: readonly string[],
  options: {
    beforePublish?: (relativePath: string, index: number) => void;
  } = {},
): void {
  assertSafePublishPaths(relativePaths);
  const lockToken = acquireDataUpdateLock(destinationRoot);
  try {
    recoverInterruptedDataUpdateUnlocked(destinationRoot);
  const transactionRoot = path.join(
    destinationRoot,
    DATA_UPDATE_TRANSACTION_DIRECTORY,
  );
  mkdirSync(transactionRoot, { recursive: false });
  const incomingRoot = path.join(transactionRoot, "incoming");
  const backupRoot = path.join(transactionRoot, "backup");
  const existedPaths = relativePaths.filter((relativePath) =>
    existsSync(path.join(destinationRoot, relativePath)),
  );
  const journal: PublishJournal = {
    schemaVersion: 1,
    phase: "preparing",
    relativePaths: [...relativePaths],
    existedPaths,
  };
  writePublishJournal(transactionRoot, journal);
  try {
    for (const relativePath of relativePaths) {
      const source = path.join(stagingRoot, relativePath);
      if (!existsSync(source)) {
        throw new Error(
          `Validated data update is missing ${relativePath}.`,
        );
      }
      const incoming = path.join(incomingRoot, relativePath);
      mkdirSync(path.dirname(incoming), { recursive: true });
      copyFileSync(source, incoming);
      const destination = path.join(destinationRoot, relativePath);
      if (existsSync(destination)) {
        const backup = path.join(backupRoot, relativePath);
        mkdirSync(path.dirname(backup), { recursive: true });
        copyFileSync(destination, backup);
      }
    }
    journal.phase = "publishing";
    writePublishJournal(transactionRoot, journal);

    for (const [index, relativePath] of relativePaths.entries()) {
      options.beforePublish?.(relativePath, index);
      const destination = path.join(destinationRoot, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      renameSync(path.join(incomingRoot, relativePath), destination);
    }
    journal.phase = "committed";
    writePublishJournal(transactionRoot, journal);
  } catch (error) {
    try {
      recoverInterruptedDataUpdateUnlocked(destinationRoot);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "The data update failed and automatic recovery was incomplete.",
      );
    }
    throw error;
  }
  rmSync(transactionRoot, { recursive: true, force: true });
  } finally {
    releaseDataUpdateLock(destinationRoot, lockToken);
  }
}

function copyStagingProject(sourceRoot: string, stagingRoot: string): void {
  for (const directory of ["data", "lib", "local", "scripts"]) {
    cpSync(
      path.join(sourceRoot, directory),
      path.join(stagingRoot, directory),
      { recursive: true },
    );
  }
  for (const filename of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]) {
    copyFileSync(
      path.join(sourceRoot, filename),
      path.join(stagingRoot, filename),
    );
  }
}

function defaultCommandRunner(
  command: string,
  args: string[],
  options: { cwd: string },
): void {
  execFileSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
  });
}

export async function prepareDataUpdate(options: {
  root?: string;
  freshness?: LiveDataFreshness;
  run?: CommandRunner;
} = {}): Promise<{
  changed: boolean;
  previousReleaseId: string;
  releaseId: string;
  freshness: LiveDataFreshness;
  published: string[];
}> {
  const root = options.root ?? projectRoot;
  const sourcesPath = path.join(root, "data", "sources.json");
  const source = readJson<SourceManifest>(sourcesPath);
  const freshnessResult = options.freshness
    ? null
    : await checkDataFreshness({ timeoutMs: 15_000 });
  const freshness = options.freshness ?? freshnessResult?.data ?? null;
  if (!freshness || freshness.state === "unknown") {
    throw new Error(
      `Cannot prepare a partial data update: ${
        freshnessResult?.warnings
          .map((item) => item.message)
          .join(" ") ?? "live source freshness is unknown"
      }`,
    );
  }
  const next = nextSourceManifest(source, freshness);
  if (JSON.stringify(next) === JSON.stringify(source)) {
    return {
      changed: false,
      previousReleaseId: source.releaseId,
      releaseId: source.releaseId,
      freshness,
      published: [],
    };
  }

  const stagingParent = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-data-update-stage-"),
  );
  const stagingRoot = path.join(stagingParent, "project");
  const run = options.run ?? defaultCommandRunner;
  try {
    mkdirSync(stagingRoot, { recursive: true });
    copyStagingProject(root, stagingRoot);
    run(
      "npm",
      [
        "install",
        `${next.rules.package}@${next.rules.version}`,
        "--save-exact",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: stagingRoot },
    );
    writeFileSync(
      path.join(stagingRoot, "data", "sources.json"),
      stableJson(next),
    );
    run(
      process.execPath,
      ["--import", "tsx", "scripts/sync-bsdata.ts", "--write"],
      { cwd: stagingRoot },
    );

    const previousSummary = readJson<CatalogueSummary>(
      path.join(
        root,
        "data",
        "generated",
        "new-recruit-summary.json",
      ),
    );
    const nextSummary = readJson<CatalogueSummary>(
      path.join(
        stagingRoot,
        "data",
        "generated",
        "new-recruit-summary.json",
      ),
    );
    const regressions = mappingRegressionReasons(
      previousSummary,
      nextSummary,
    );
    if (regressions.length > 0) {
      throw new Error(
        `The staged data update has mapping regressions: ${regressions.join("; ")}.`,
      );
    }

    run("npm", ["run", "data:sync-check"], { cwd: stagingRoot });
    run("npm", ["run", "data:check"], { cwd: stagingRoot });
    run("npm", ["run", "certify:manifest:sync"], {
      cwd: stagingRoot,
    });
    run("npm", ["run", "certify:manifest:check"], {
      cwd: stagingRoot,
    });
    run(
      "npm",
      [
        "run",
        "certify",
        "--",
        "--tier",
        "deterministic",
        "--portfolio",
        "--out-dir",
        path.join(stagingRoot, ".certification-data-update"),
      ],
      { cwd: stagingRoot },
    );
    publishFilesAtomically(stagingRoot, root, publishPaths);
    return {
      changed: true,
      previousReleaseId: source.releaseId,
      releaseId: next.releaseId,
      freshness,
      published: [...publishPaths],
    };
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

export async function runPrepareDataUpdateCli(
  argv: readonly string[],
  options: {
    root?: string;
    freshness?: LiveDataFreshness;
    run?: CommandRunner;
    writeOutput?: (value: string) => void;
  } = {},
): Promise<void> {
  const args = parseDataUpdateArgs(argv);
  const writeOutput =
    options.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (args.help) {
    writeOutput(DATA_UPDATE_USAGE);
    return;
  }
  const result = await prepareDataUpdate({
    root: options.root,
    freshness: options.freshness,
    run: options.run,
  });
  writeOutput(
    `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  try {
    await runPrepareDataUpdateCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof DataUpdateCliUsageError) {
      process.stderr.write(`${error.message}\nRun with --help for usage.\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  !fileURLToPath(import.meta.url).endsWith(".mjs")
) {
  await main();
}
