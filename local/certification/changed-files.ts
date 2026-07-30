import { execFileSync } from "node:child_process";

const certificationSurface =
  /^(?:lib\/|local\/|mcp\/|cli\/|app\/api\/|data\/|tests\/|scripts\/|package(?:-lock)?\.json|\.github\/)/;

type GitCommand = (
  args: string[],
  cwd: string,
) => string | null;

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function lines(value: string | null): string[] {
  return value
    ? value
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function statusPaths(value: string | null): string[] {
  return lines(value).flatMap((entry) => {
    const payload = entry.slice(3).replace(/^"|"$/g, "");
    const renamed = payload.split(" -> ");
    return renamed.length === 2 ? renamed : [payload];
  });
}

function candidateBases(
  environment: NodeJS.ProcessEnv,
): string[] {
  const explicit =
    environment.ROSTERPILOT_CERTIFICATION_CHANGED_BASE;
  const githubBase = environment.GITHUB_BASE_REF
    ? `origin/${environment.GITHUB_BASE_REF}`
    : null;
  const before =
    environment.GITHUB_EVENT_BEFORE &&
    !/^0+$/.test(environment.GITHUB_EVENT_BEFORE)
      ? environment.GITHUB_EVENT_BEFORE
      : null;
  return [
    explicit,
    githubBase,
    before,
    "HEAD^",
  ].filter(
    (value, index, all): value is string =>
      Boolean(value) && all.indexOf(value) === index,
  );
}

/**
 * Returns certification-relevant paths changed in both the checked-out commit
 * range and the dirty worktree. When Git history cannot be established it
 * returns a sentinel, causing `--changed-only` to run rather than silently
 * skip coverage.
 */
export function certificationRelevantChanges(input: {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  git?: GitCommand;
}): string[] {
  const environment = input.environment ?? process.env;
  const git = input.git ?? runGit;
  const dirty = statusPaths(
    git(["status", "--short", "--untracked-files=all"], input.cwd),
  );
  let committed: string[] | null = null;
  for (const base of candidateBases(environment)) {
    const diff = git(
      ["diff", "--name-only", `${base}...HEAD`, "--"],
      input.cwd,
    );
    if (diff !== null) {
      committed = lines(diff);
      break;
    }
  }
  const candidates = [
    ...dirty,
    ...(committed ?? []),
  ];
  const relevant = [
    ...new Set(
      candidates
        .map((filename) => filename.replaceAll("\\", "/"))
        .filter((filename) => certificationSurface.test(filename)),
    ),
  ].sort();
  if (relevant.length > 0) return relevant;
  if (committed === null) {
    return ["<change-base-unavailable>"];
  }
  return [];
}
