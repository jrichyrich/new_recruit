import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type {
  NewRecruitServiceIdentityV1,
} from "./service-compatibility";

const runFile = promisify(execFile);

export const BSDATA_REPOSITORY = "BSData/wh40k-11e";
export const MAX_BSDATA_COMPATIBILITY_COMMITS = 500;

const DEFAULT_ALLOWED_REMOTES = [
  "https://github.com/BSData/wh40k-11e.git",
  "https://github.com/BSData/wh40k-11e",
  "git@github.com:BSData/wh40k-11e.git",
  "ssh://git@github.com/BSData/wh40k-11e.git",
] as const;

const referenceSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !value.includes("..") &&
      !/[\u0000-\u001f\u007f~^:?*[\\]/.test(value),
    "Expected a safe Git reference.",
  );

const repositoryPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.includes(":") &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      value
        .split("/")
        .every(
          (part) => part !== "" && part !== "." && part !== "..",
        ),
    "Expected a safe repository-relative path.",
  );

export type ResolveBsDataHistoryIdentityInput = {
  /** Existing persistent bare cache maintained by the local updater. */
  cacheDirectory: string;
  identity: NewRecruitServiceIdentityV1;
  reference?: string;
  gameSystemPath?: string;
  factionCataloguePath?: string;
  maxCommits?: number;
  /** Test/self-host injection; production callers should use the default. */
  allowedRemoteUrls?: readonly string[];
};

export type BsDataHistoryIdentityMatch = {
  status: "matched";
  repository: typeof BSDATA_REPOSITORY;
  commit: string;
  reference: string;
  gameSystemPath: string;
  factionCataloguePath: string;
  commitsExamined: number;
  relevantCommits: number;
  identity: NewRecruitServiceIdentityV1;
};

export type BsDataHistoryIdentityNoMatch = {
  status: "no-match";
  repository: typeof BSDATA_REPOSITORY;
  reference: string;
  reason:
    | "IDENTITY_SOURCE_PATH_NOT_FOUND"
    | "EXACT_IDENTITY_NOT_FOUND";
  message: string;
  commitsExamined: number;
  relevantCommits: number;
  gameSystemPath: string | null;
  factionCataloguePath: string | null;
};

export type BsDataHistoryIdentityResolution =
  | BsDataHistoryIdentityMatch
  | BsDataHistoryIdentityNoMatch;

export type BsDataHistoryResolverErrorCode =
  | "BSDATA_CACHE_UNSAFE"
  | "BSDATA_CACHE_NOT_BARE"
  | "BSDATA_REMOTE_NOT_ALLOWLISTED"
  | "BSDATA_REFERENCE_INVALID"
  | "BSDATA_HISTORY_READ_FAILED";

export class BsDataHistoryResolverError extends Error {
  readonly code: BsDataHistoryResolverErrorCode;
  override readonly cause?: unknown;

  constructor(
    code: BsDataHistoryResolverErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "BsDataHistoryResolverError";
    this.code = code;
    this.cause = options.cause;
  }
}

type CatalogueRootIdentity = {
  kind: "gameSystem" | "catalogue";
  id: string;
  name: string | null;
  revision: number;
};

function normalizeRemote(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function git(
  cacheDirectory: string,
  args: readonly string[],
  options: { maxBuffer?: number; allowFailure?: boolean } = {},
): Promise<string | null> {
  try {
    const result = await runFile("git", [...args], {
      cwd: cacheDirectory,
      encoding: "utf8",
      env: safeEnvironment(),
      timeout: 30_000,
      maxBuffer: options.maxBuffer ?? 8 * 1_024 * 1_024,
    });
    return result.stdout;
  } catch (error) {
    if (options.allowFailure) return null;
    throw new BsDataHistoryResolverError(
      "BSDATA_HISTORY_READ_FAILED",
      `Could not read the local BSData history with git ${args[0] ?? ""}.`,
      { cause: error },
    );
  }
}

function xmlAttributes(fragment: string): Record<string, string> {
  return Object.fromEntries(
    [...fragment.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(
      (match) => [match[1], match[3]],
    ),
  );
}

function parseRootIdentity(
  content: string,
  expectedKind?: "gameSystem" | "catalogue",
): CatalogueRootIdentity | null {
  const root = content.match(/<(gameSystem|catalogue)\b([^>]*)>/i);
  if (!root) return null;
  const kind = root[1] === "gameSystem" ? "gameSystem" : "catalogue";
  if (expectedKind && kind !== expectedKind) return null;
  const attributes = xmlAttributes(root[2]);
  const revision = Number(attributes.revision);
  if (
    !attributes.id?.trim() ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    return null;
  }
  return {
    kind,
    id: attributes.id.trim(),
    name: attributes.name?.trim() || null,
    revision,
  };
}

async function assertBareAllowlistedCache(
  cacheDirectory: string,
  allowedRemoteUrls: readonly string[],
): Promise<void> {
  const metadata = await lstat(cacheDirectory).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new BsDataHistoryResolverError(
      "BSDATA_CACHE_UNSAFE",
      "The BSData history cache must be an existing regular directory.",
    );
  }
  const bare = (
    await git(cacheDirectory, ["rev-parse", "--is-bare-repository"])
  )?.trim();
  if (bare !== "true") {
    throw new BsDataHistoryResolverError(
      "BSDATA_CACHE_NOT_BARE",
      "The BSData history resolver accepts only a bare Git cache and never operates on a checkout.",
    );
  }
  const remote = (
    await git(cacheDirectory, ["config", "--get", "remote.origin.url"])
  )?.trim();
  const allowed = new Set(
    allowedRemoteUrls.map((candidate) => normalizeRemote(candidate)),
  );
  if (!remote || !allowed.has(normalizeRemote(remote))) {
    throw new BsDataHistoryResolverError(
      "BSDATA_REMOTE_NOT_ALLOWLISTED",
      `The bare cache remote is not allowlisted for ${BSDATA_REPOSITORY}.`,
    );
  }
}

async function sourceAt(
  cacheDirectory: string,
  commit: string,
  sourcePath: string,
): Promise<string | null> {
  return git(
    cacheDirectory,
    ["show", `${commit}:${sourcePath}`],
    {
      maxBuffer: 64 * 1_024 * 1_024,
      allowFailure: true,
    },
  );
}

async function sourcePathsAtReference(
  cacheDirectory: string,
  reference: string,
): Promise<string[]> {
  const output = await git(cacheDirectory, [
    "ls-tree",
    "-r",
    "--name-only",
    reference,
  ]);
  return (output ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.endsWith(".gst") || value.endsWith(".cat"))
    .filter((value) => repositoryPathSchema.safeParse(value).success);
}

async function allCatalogueHistoryCommits(
  cacheDirectory: string,
  reference: string,
  maxCommits: number,
): Promise<string[]> {
  const history = await git(cacheDirectory, [
    "log",
    "--first-parent",
    "--format=%H",
    `--max-count=${maxCommits}`,
    reference,
    "--",
    "*.gst",
    "*.cat",
  ]);
  return (history ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => /^[a-f0-9]{7,64}$/.test(value));
}

async function discoverSourcePath(input: {
  cacheDirectory: string;
  reference: string;
  candidates: readonly string[];
  kind: "gameSystem" | "catalogue";
  id: string;
}): Promise<string | null> {
  const extension = input.kind === "gameSystem" ? ".gst" : ".cat";
  for (const candidate of input.candidates.filter((value) =>
    value.endsWith(extension),
  )) {
    const content = await sourceAt(
      input.cacheDirectory,
      input.reference,
      candidate,
    );
    const identity = content
      ? parseRootIdentity(content, input.kind)
      : null;
    if (identity?.id === input.id) return candidate;
  }
  return null;
}

function exactIdentity(
  gameSystem: CatalogueRootIdentity | null,
  catalogue: CatalogueRootIdentity | null,
  expected: NewRecruitServiceIdentityV1,
): boolean {
  return (
    gameSystem?.kind === "gameSystem" &&
    gameSystem.id === expected.gameSystem.id &&
    gameSystem.revision === expected.gameSystem.revision &&
    catalogue?.kind === "catalogue" &&
    catalogue.id === expected.factionCatalogue.id &&
    catalogue.revision === expected.factionCatalogue.revision
  );
}

async function resolveWithKnownPaths(input: {
  cacheDirectory: string;
  reference: string;
  identity: NewRecruitServiceIdentityV1;
  gameSystemPath: string;
  factionCataloguePath: string;
  maxCommits: number;
}): Promise<BsDataHistoryIdentityResolution> {
  const history = await git(input.cacheDirectory, [
    "log",
    "--first-parent",
    "--format=%H",
    `--max-count=${input.maxCommits}`,
    input.reference,
    "--",
    input.gameSystemPath,
    input.factionCataloguePath,
  ]);
  const commits = (history ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => /^[a-f0-9]{7,64}$/.test(value));
  let commitsExamined = 0;
  for (const commit of commits) {
    commitsExamined += 1;
    const [gameSystemSource, factionCatalogueSource] =
      await Promise.all([
        sourceAt(
          input.cacheDirectory,
          commit,
          input.gameSystemPath,
        ),
        sourceAt(
          input.cacheDirectory,
          commit,
          input.factionCataloguePath,
        ),
      ]);
    const gameSystem = gameSystemSource
      ? parseRootIdentity(gameSystemSource, "gameSystem")
      : null;
    const catalogue = factionCatalogueSource
      ? parseRootIdentity(factionCatalogueSource, "catalogue")
      : null;
    if (exactIdentity(gameSystem, catalogue, input.identity)) {
      return {
        status: "matched",
        repository: BSDATA_REPOSITORY,
        commit,
        reference: input.reference,
        gameSystemPath: input.gameSystemPath,
        factionCataloguePath: input.factionCataloguePath,
        commitsExamined,
        relevantCommits: commits.length,
        identity: input.identity,
      };
    }
  }
  return {
    status: "no-match",
    repository: BSDATA_REPOSITORY,
    reference: input.reference,
    reason: "EXACT_IDENTITY_NOT_FOUND",
    message:
      `No exact BSData identity match was found in the newest ${commits.length} relevant commits (bounded at ${input.maxCommits}).`,
    commitsExamined,
    relevantCommits: commits.length,
    gameSystemPath: input.gameSystemPath,
    factionCataloguePath: input.factionCataloguePath,
  };
}

async function resolveWithHistoricalPathDiscovery(input: {
  cacheDirectory: string;
  reference: string;
  identity: NewRecruitServiceIdentityV1;
  gameSystemPath: string | null;
  factionCataloguePath: string | null;
  maxCommits: number;
}): Promise<BsDataHistoryIdentityResolution> {
  const commits = await allCatalogueHistoryCommits(
    input.cacheDirectory,
    input.reference,
    input.maxCommits,
  );
  let gameSystemPath = input.gameSystemPath;
  let factionCataloguePath = input.factionCataloguePath;
  let commitsExamined = 0;
  for (const commit of commits) {
    commitsExamined += 1;
    if (!gameSystemPath || !factionCataloguePath) {
      const candidates = await sourcePathsAtReference(
        input.cacheDirectory,
        commit,
      );
      gameSystemPath ??= await discoverSourcePath({
        cacheDirectory: input.cacheDirectory,
        reference: commit,
        candidates,
        kind: "gameSystem",
        id: input.identity.gameSystem.id,
      });
      factionCataloguePath ??= await discoverSourcePath({
        cacheDirectory: input.cacheDirectory,
        reference: commit,
        candidates,
        kind: "catalogue",
        id: input.identity.factionCatalogue.id,
      });
    }
    if (!gameSystemPath || !factionCataloguePath) continue;
    const [gameSystemSource, factionCatalogueSource] =
      await Promise.all([
        sourceAt(input.cacheDirectory, commit, gameSystemPath),
        sourceAt(input.cacheDirectory, commit, factionCataloguePath),
      ]);
    const gameSystem = gameSystemSource
      ? parseRootIdentity(gameSystemSource, "gameSystem")
      : null;
    const catalogue = factionCatalogueSource
      ? parseRootIdentity(factionCatalogueSource, "catalogue")
      : null;
    if (exactIdentity(gameSystem, catalogue, input.identity)) {
      return {
        status: "matched",
        repository: BSDATA_REPOSITORY,
        commit,
        reference: input.reference,
        gameSystemPath,
        factionCataloguePath,
        commitsExamined,
        relevantCommits: commits.length,
        identity: input.identity,
      };
    }
  }
  const sourcePathsFound =
    Boolean(gameSystemPath) && Boolean(factionCataloguePath);
  return {
    status: "no-match",
    repository: BSDATA_REPOSITORY,
    reference: input.reference,
    reason: sourcePathsFound
      ? "EXACT_IDENTITY_NOT_FOUND"
      : "IDENTITY_SOURCE_PATH_NOT_FOUND",
    message: sourcePathsFound
      ? `No exact BSData identity match was found in the newest ${commits.length} relevant catalogue commits (bounded at ${input.maxCommits}).`
      : `The exact game-system or faction-catalogue id was not found in the newest ${commits.length} relevant catalogue commits (bounded at ${input.maxCommits}).`,
    commitsExamined,
    relevantCommits: commits.length,
    gameSystemPath,
    factionCataloguePath,
  };
}

/**
 * Resolves the newest historical BSData commit with an exact New Recruit
 * game-system and faction-catalogue identity. It performs only read commands
 * against an allowlisted bare cache; fetching and cache maintenance belong to
 * the updater, and no checkout is created or mutated here.
 */
export async function resolveBsDataHistoryIdentity(
  input: ResolveBsDataHistoryIdentityInput,
): Promise<BsDataHistoryIdentityResolution> {
  const cacheDirectory = path.resolve(input.cacheDirectory);
  const allowedRemoteUrls =
    input.allowedRemoteUrls ?? DEFAULT_ALLOWED_REMOTES;
  if (allowedRemoteUrls.length === 0) {
    throw new BsDataHistoryResolverError(
      "BSDATA_REMOTE_NOT_ALLOWLISTED",
      "At least one exact BSData bare-cache remote must be allowlisted.",
    );
  }
  await assertBareAllowlistedCache(
    cacheDirectory,
    allowedRemoteUrls,
  );

  const parsedReference = referenceSchema.safeParse(
    input.reference ?? "HEAD",
  );
  if (!parsedReference.success) {
    throw new BsDataHistoryResolverError(
      "BSDATA_REFERENCE_INVALID",
      "The requested BSData history reference is invalid.",
      { cause: parsedReference.error },
    );
  }
  const reference = parsedReference.data;
  const maxCommits = z
    .number()
    .int()
    .positive()
    .max(MAX_BSDATA_COMPATIBILITY_COMMITS)
    .parse(input.maxCommits ?? MAX_BSDATA_COMPATIBILITY_COMMITS);

  const candidates = await sourcePathsAtReference(
    cacheDirectory,
    reference,
  );
  const explicitGameSystemPath = input.gameSystemPath
    ? repositoryPathSchema.parse(input.gameSystemPath)
    : null;
  const explicitFactionCataloguePath = input.factionCataloguePath
    ? repositoryPathSchema.parse(input.factionCataloguePath)
    : null;
  const gameSystemPath =
    explicitGameSystemPath ??
    (await discoverSourcePath({
      cacheDirectory,
      reference,
      candidates,
      kind: "gameSystem",
      id: input.identity.gameSystem.id,
    }));
  const factionCataloguePath =
    explicitFactionCataloguePath ??
    (await discoverSourcePath({
      cacheDirectory,
      reference,
      candidates,
      kind: "catalogue",
      id: input.identity.factionCatalogue.id,
    }));

  if (gameSystemPath && factionCataloguePath) {
    return resolveWithKnownPaths({
      cacheDirectory,
      reference,
      identity: input.identity,
      gameSystemPath,
      factionCataloguePath,
      maxCommits,
    });
  }
  return resolveWithHistoricalPathDiscovery({
    cacheDirectory,
    reference,
    identity: input.identity,
    gameSystemPath,
    factionCataloguePath,
    maxCommits,
  });
}
