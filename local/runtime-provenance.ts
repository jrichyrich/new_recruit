import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DATA_PACKAGE_VERSION } from "../lib/rosterpilot/engine";
import { TESSERA_STRESS_GENERATOR_VERSION } from "../lib/rosterpilot/stress-portfolio";
import type { RuntimeProvenance } from "../lib/rosterpilot/types";
import { projectRoot } from "./agent/paths";

const processStartedAt = new Date().toISOString();

function command(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    ) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function sourceFingerprint(): string {
  const trackedDiff =
    command([
      "diff",
      "--no-ext-diff",
      "--binary",
      "HEAD",
      "--",
      "lib",
      "local",
      "mcp",
      "cli",
      "package.json",
      "package-lock.json",
    ]) ?? "";
  const untracked =
    command([
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "lib",
      "local",
      "mcp",
      "cli",
      "package.json",
      "package-lock.json",
    ])
      ?.split("\n")
      .filter(Boolean)
      .sort() ?? [];
  const hash = crypto.createHash("sha256").update(trackedDiff);
  for (const relative of untracked) {
    hash.update(relative);
    try {
      hash.update(readFileSync(path.join(projectRoot, relative)));
    } catch {
      hash.update("<unreadable>");
    }
  }
  return hash.digest("hex");
}

const rosterPilotVersion = packageVersion();
const gitHead = command(["rev-parse", "HEAD"]);
const sourceFingerprintAtStart = sourceFingerprint();
const buildId = crypto
  .createHash("sha256")
  .update(
    [
      rosterPilotVersion,
      DATA_PACKAGE_VERSION,
      TESSERA_STRESS_GENERATOR_VERSION,
      gitHead ?? "no-git",
      sourceFingerprintAtStart,
    ].join("|"),
  )
  .digest("hex")
  .slice(0, 20);

export function getRuntimeProvenance(): RuntimeProvenance {
  const sourceFingerprintNow = sourceFingerprint();
  return {
    rosterPilotVersion,
    rulesPackageVersion: DATA_PACKAGE_VERSION,
    stressGeneratorVersion: TESSERA_STRESS_GENERATOR_VERSION,
    processStartedAt,
    gitHead,
    sourceFingerprintAtStart,
    sourceFingerprintNow,
    buildId,
    stale: sourceFingerprintNow !== sourceFingerprintAtStart,
  };
}

export function runtimeRestartIssue(): {
  code: "RUNTIME_RESTART_REQUIRED";
  message: string;
} | null {
  const runtime = getRuntimeProvenance();
  return runtime.stale
    ? {
        code: "RUNTIME_RESTART_REQUIRED",
        message:
          "RosterPilot source files changed after this process started. Restart the MCP server and local agent before external preparation or simulation.",
      }
    : null;
}
