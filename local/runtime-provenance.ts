import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DATA_PACKAGE_VERSION } from "../lib/rosterpilot/engine";
import { newRecruitCatalogue } from "../lib/rosterpilot/catalogue-summary";
import { TESSERA_STRESS_GENERATOR_VERSION } from "../lib/rosterpilot/stress-portfolio";
import type { RuntimeProvenance } from "../lib/rosterpilot/types";
import {
  LOCAL_AGENT_PROTOCOL_VERSION,
  LOCAL_AGENT_VERSION,
} from "./agent/contracts";
import {
  installedBrokerPath,
  projectRoot,
} from "./agent/paths";

const processStartedAt = new Date().toISOString();
const LOCAL_AGENT_LABEL = "com.jasonricha.rosterpilot.agent";

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

function dependencyVersion(name: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(
        path.join(projectRoot, "node_modules", name, "package.json"),
        "utf8",
      ),
    ) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function executableVersion(
  executable: string,
  args: string[],
): string | null {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function fileBuildId(filename: string): string | null {
  try {
    return crypto
      .createHash("sha256")
      .update(readFileSync(filename))
      .digest("hex")
      .slice(0, 20);
  } catch {
    return null;
  }
}

function filesBuildId(filenames: string[]): string | null {
  try {
    const hash = crypto.createHash("sha256");
    for (const filename of filenames) {
      hash.update(path.relative(projectRoot, filename));
      hash.update(readFileSync(filename));
    }
    return hash.digest("hex").slice(0, 20);
  } catch {
    return null;
  }
}

function launchAgentProcessIdentity():
  | NonNullable<RuntimeProvenance["localAgentProcessIdentity"]>
  | null {
  if (process.platform !== "darwin") return null;
  const uid =
    typeof process.getuid === "function" ? process.getuid() : 0;
  const detail = executableVersion("/bin/launchctl", [
    "print",
    `gui/${uid}/${LOCAL_AGENT_LABEL}`,
  ]);
  if (!detail) return null;
  const value = (key: string): string | null =>
    detail.match(
      new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m"),
    )?.[1] ?? null;
  const pidText = value("pid");
  const parsedPid =
    pidText !== null && /^\d+$/.test(pidText)
      ? Number(pidText)
      : null;
  return {
    label: LOCAL_AGENT_LABEL,
    pid: parsedPid,
    state: value("state"),
    program: value("program"),
  };
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
      "data",
      "scripts",
      "native",
      "worker",
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
      "data",
      "scripts",
      "native",
      "worker",
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
const chromeVersion = executableVersion(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--version"],
);
const playwrightVersion =
  dependencyVersion("playwright") ??
  dependencyVersion("playwright-core");
const brokerBuildId = fileBuildId(installedBrokerPath());
const macOsVersion =
  process.platform === "darwin"
    ? executableVersion("/usr/bin/sw_vers", ["-productVersion"])
    : null;
const mcpBuildId = filesBuildId([
  path.join(projectRoot, "mcp", "server.ts"),
  path.join(projectRoot, "mcp", "stdio.ts"),
]);

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
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    chromeVersion,
    playwrightVersion,
    brokerBuildId,
    macOsVersion,
    localAgentExpectedProtocolVersion:
      LOCAL_AGENT_PROTOCOL_VERSION,
    localAgentExpectedVersion: LOCAL_AGENT_VERSION,
    localAgentProcessIdentity: launchAgentProcessIdentity(),
    mcpBuildId,
    runtimeProcessIdentity: {
      pid: process.pid,
      executable: process.execPath,
    },
    dataReleaseId: newRecruitCatalogue.releaseId,
    dataFreshnessCheckedAt:
      newRecruitCatalogue.sources.official.checkedAt ?? null,
    dataGeneratedAt: newRecruitCatalogue.generatedAt ?? null,
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
