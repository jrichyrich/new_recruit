import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const setupFile = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(setupFile), "..");
const supportedProfiles = new Set(["core", "mcp", "new-recruit", "tessera"]);
const supportedRefreshModes = new Set(["skip", "check", "apply"]);
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export class SetupError extends Error {}

export function parseSetupArgs(argv) {
  const options = {
    doctor: false,
    help: false,
    nonInteractive: false,
    profile: null,
    refresh: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--doctor") {
      options.doctor = true;
    } else if (token === "--help" || token === "-h") {
      options.help = true;
    } else if (token === "--non-interactive") {
      options.nonInteractive = true;
    } else if (token === "--profile" || token.startsWith("--profile=")) {
      const profile = token.includes("=")
        ? token.slice(token.indexOf("=") + 1)
        : argv[++index];
      if (!profile || !supportedProfiles.has(profile)) {
        throw new SetupError(
          `Invalid profile "${profile ?? ""}". Expected core, mcp, new-recruit, or tessera.`,
        );
      }
      options.profile = profile;
    } else if (token === "--refresh" || token.startsWith("--refresh=")) {
      const refresh = token.includes("=")
        ? token.slice(token.indexOf("=") + 1)
        : argv[++index];
      if (!refresh || !supportedRefreshModes.has(refresh)) {
        throw new SetupError(
          `Invalid refresh mode "${refresh ?? ""}". Expected skip, check, or apply.`,
        );
      }
      options.refresh = refresh;
    } else {
      throw new SetupError(`Unknown option "${token}".`);
    }
  }

  if (options.doctor && options.refresh === "apply") {
    throw new SetupError("Doctor cannot apply data updates.");
  }
  return options;
}

export function validateNodeVersion(version) {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return {
      supported: false,
      aligned: false,
      message: `Could not parse Node version "${version}".`,
    };
  }
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  const supported = major > 22 || (major === 22 && minor >= 13);
  const aligned = major === 22 && minor === 13 && patch === 0;
  return {
    supported,
    aligned,
    message: supported
      ? aligned
        ? `Node ${version.replace(/^v/, "")} matches the repository baseline.`
        : `Node ${version.replace(/^v/, "")} is supported, but CI uses Node 22.13.0. Run "nvm use" for the exact local match.`
      : `Node ${version.replace(/^v/, "")} is unsupported. Install Node 22.13 or newer, then run "nvm use".`,
  };
}

function quoteToml(value) {
  return JSON.stringify(value);
}

export function renderCodexConfig({
  nodeExecutable,
  projectRoot,
}) {
  const loader = path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const server = path.join(projectRoot, "mcp", "stdio.ts");
  return [
    "[mcp_servers.rosterpilot]",
    `command = ${quoteToml(nodeExecutable)}`,
    `args = [${[
      "--import",
      loader,
      server,
    ].map(quoteToml).join(", ")}]`,
    `cwd = ${quoteToml(projectRoot)}`,
    "",
  ].join("\n");
}

export function renderClaudeConfig({
  nodeExecutable,
  projectRoot,
}) {
  return JSON.stringify(
    {
      mcpServers: {
        rosterpilot: {
          command: nodeExecutable,
          args: [
            "--import",
            path.join(
              projectRoot,
              "node_modules",
              "tsx",
              "dist",
              "loader.mjs",
            ),
            path.join(projectRoot, "mcp", "stdio.ts"),
          ],
          cwd: projectRoot,
        },
      },
    },
    null,
    2,
  );
}

export function freshnessAction(state) {
  if (state === "current") return "current";
  if (state === "update-available" || state === "official-update-pending") {
    return "offer-update";
  }
  return "unknown";
}

function usage(doctor = false) {
  const command = doctor ? "npm run doctor" : "npm run setup";
  return `RosterPilot ${doctor ? "diagnostics" : "first-time setup"}

Usage:
  ${command}
  ${command} -- --profile core|mcp|new-recruit|tessera
  ${command} -- --profile core --non-interactive --refresh skip|check${doctor ? "" : "|apply"}

Profiles are cumulative: mcp includes core; new-recruit includes core and mcp;
tessera includes New Recruit preparation plus Tessera comparison readiness.
The default profile is core and the default refresh mode is check.
`;
}

function defaultRun(command, args, options = {}) {
  const capture = options.capture === true;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return {
    code: result.status ?? 1,
    error: result.error,
    stderr: capture ? result.stderr ?? "" : "",
    stdout: capture ? result.stdout ?? "" : "",
  };
}

function defaultFileSystem() {
  return {
    exists: existsSync,
    isExecutable(filename) {
      try {
        accessSync(filename, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    mkdir: (directory) => mkdirSync(directory, { recursive: true }),
    read: (filename) => readFileSync(filename, "utf8"),
    write: (filename, content) => writeFileSync(filename, content),
  };
}

function outputLine(stream, message = "") {
  stream.write(`${message}\n`);
}

function commandFailure(label, result) {
  const details = [result.error?.message, result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join("\n");
  return new SetupError(
    `${label} failed${details ? `:\n${details}` : "."}`,
  );
}

function npmExecutable(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function assertCommand(label, result) {
  if (result.error || result.code !== 0) throw commandFailure(label, result);
}

function parseJsonCommand(label, result) {
  assertCommand(label, result);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new SetupError(`${label} returned invalid JSON.`);
  }
}

function profileIncludesMcp(profile) {
  return (
    profile === "mcp" ||
    profile === "new-recruit" ||
    profile === "tessera"
  );
}

async function askChoice(question, choices, fallback, dependencies) {
  if (dependencies.ask) {
    return dependencies.ask(question, choices, fallback);
  }
  const terminal = createInterface({
    input: dependencies.stdin,
    output: dependencies.stdout,
  });
  try {
    const answer = (await terminal.question(question)).trim().toLowerCase();
    return answer || fallback;
  } finally {
    terminal.close();
  }
}

async function askYesNo(question, dependencies) {
  const answer = await askChoice(question, ["yes", "no"], "no", dependencies);
  return answer === "y" || answer === "yes";
}

function runNpmScript(name, args, dependencies, capture = false) {
  return dependencies.run(
    npmExecutable(dependencies.platform),
    ["run", name, ...(args.length ? ["--", ...args] : [])],
    {
      capture,
      cwd: dependencies.projectRoot,
    },
  );
}

function runRosterPilot(action, dependencies) {
  const loader = path.join(
    dependencies.projectRoot,
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );
  return dependencies.run(
    dependencies.nodeExecutable,
    [
      "--import",
      loader,
      path.join(dependencies.projectRoot, "cli", "rosterpilot.ts"),
      ...action,
    ],
    { capture: true, cwd: dependencies.projectRoot },
  );
}

function addResult(results, name, status, detail) {
  results.push({ name, status, detail });
}

function printResults(results, dependencies) {
  outputLine(dependencies.stdout);
  outputLine(dependencies.stdout, "RosterPilot readiness");
  for (const result of results) {
    const marker =
      result.status === "ready"
        ? "✓"
        : result.status === "warning"
          ? "!"
          : "✗";
    outputLine(
      dependencies.stdout,
      `  ${marker} ${result.name}: ${result.detail}`,
    );
  }
}

function ensureProjectFiles(dependencies) {
  for (const filename of ["package.json", "package-lock.json", "data/sources.json"]) {
    const resolved = path.join(dependencies.projectRoot, filename);
    if (!dependencies.fs.exists(resolved)) {
      throw new SetupError(
        `Missing ${filename}. Run this command from a complete RosterPilot checkout.`,
      );
    }
  }
}

function ensureNewRecruitPrerequisites(dependencies) {
  if (dependencies.platform !== "darwin") {
    throw new SetupError(
      "The new-recruit and tessera profiles require macOS. Use --profile mcp or --profile core on this platform.",
    );
  }
  if (!dependencies.fs.isExecutable("/usr/bin/swiftc")) {
    throw new SetupError(
      "Swift is required for the New Recruit Keychain broker. Install the Apple command-line developer tools, then rerun setup.",
    );
  }
  if (!dependencies.fs.isExecutable(chromePath)) {
    throw new SetupError(
      "Google Chrome is required for New Recruit delivery. Install Chrome in /Applications, then rerun setup.",
    );
  }
}

function ensureCleanTrackedWorktree(dependencies) {
  const result = dependencies.run(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { capture: true, cwd: dependencies.projectRoot },
  );
  assertCommand("Git worktree check", result);
  if (result.stdout.trim()) {
    throw new SetupError(
      "Cannot apply a data update while tracked files are modified. Commit or stash those changes, then rerun setup.",
    );
  }
}

function configureMcp({ doctor, results }, dependencies) {
  const configDirectory = path.join(dependencies.projectRoot, ".codex");
  const configPath = path.join(configDirectory, "config.toml");
  const config = renderCodexConfig({
    nodeExecutable: dependencies.nodeExecutable,
    projectRoot: dependencies.projectRoot,
  });

  if (doctor) {
    if (dependencies.fs.exists(configPath)) {
      addResult(results, "Codex MCP", "ready", `${configPath} exists`);
    } else {
      addResult(
        results,
        "Codex MCP",
        "warning",
        `configuration is absent; run npm run setup -- --profile mcp`,
      );
    }
  } else if (dependencies.fs.exists(configPath)) {
    addResult(
      results,
      "Codex MCP",
      "warning",
      `${configPath} already exists and was not overwritten`,
    );
    outputLine(dependencies.stdout, "\nMerge this block if RosterPilot is absent:");
    outputLine(dependencies.stdout, config);
  } else {
    dependencies.fs.mkdir(configDirectory);
    dependencies.fs.write(configPath, config);
    addResult(results, "Codex MCP", "ready", `created ${configPath}`);
  }

  outputLine(
    dependencies.stdout,
    "\nClaude Desktop configuration (copy into its mcpServers configuration):",
  );
  outputLine(
    dependencies.stdout,
    renderClaudeConfig({
      nodeExecutable: dependencies.nodeExecutable,
      projectRoot: dependencies.projectRoot,
    }),
  );
}

async function configureNewRecruit(
  { doctor, interactive, results },
  dependencies,
) {
  ensureNewRecruitPrerequisites(dependencies);
  if (!doctor) {
    const build = runNpmScript("companion:build", [], dependencies);
    assertCommand("New Recruit companion build", build);
    const installed = parseJsonCommand(
      "RosterPilot local-agent installation",
      runRosterPilot(["agent", "install"], dependencies),
    );
    if (!installed.ok || !installed.running) {
      throw new SetupError(
        installed.message ?? "The RosterPilot local agent did not start.",
      );
    }
  } else {
    const agent = parseJsonCommand(
      "RosterPilot local-agent status",
      runRosterPilot(["agent", "status"], dependencies),
    );
    if (!agent.ok || !agent.running) {
      throw new SetupError(
        agent.message ??
          "The RosterPilot local agent is not installed or running.",
      );
    }
  }

  let status = parseJsonCommand(
    "New Recruit status",
    runRosterPilot(["new-recruit", "status"], dependencies),
  );
  if (!status.data?.available) {
    throw new SetupError(
      "The New Recruit companion is unavailable after prerequisite checks.",
    );
  }

  if (status.data.credentialsConfigured) {
    addResult(
      results,
      "New Recruit",
      "ready",
      "local agent and Keychain credential are configured",
    );
    return;
  }
  if (doctor) {
    throw new SetupError(
      "The New Recruit companion is built, but its Keychain credential is not configured.",
    );
  }

  const configure = interactive
    ? await askYesNo(
        "Open the secure macOS credential dialog now? [y/N] ",
        dependencies,
      )
    : false;
  if (!configure) {
    addResult(
      results,
      "New Recruit",
      "warning",
      "local agent installed; run npm run rosterpilot -- new-recruit configure to add the Keychain credential",
    );
    return;
  }

  const configured = parseJsonCommand(
    "New Recruit credential configuration",
    runRosterPilot(["new-recruit", "configure"], dependencies),
  );
  if (!configured.ok) {
    throw new SetupError(
      configured.message ?? "New Recruit credential configuration failed.",
    );
  }
  status = parseJsonCommand(
    "New Recruit status",
    runRosterPilot(["new-recruit", "status"], dependencies),
  );
  if (!status.data?.credentialsConfigured) {
    throw new SetupError(
      "The secure dialog completed, but the New Recruit credential is not configured.",
    );
  }
  addResult(
    results,
    "New Recruit",
    "ready",
    "local agent and Keychain credential are configured",
  );
}

async function configureTessera(
  { doctor, interactive, results },
  dependencies,
) {
  let status = parseJsonCommand(
    "Tessera status",
    runRosterPilot(["tessera", "status"], dependencies),
  );
  if (
    !status.data?.agentAvailable ||
    !status.data?.browserAvailable ||
    !status.data?.brokerAvailable ||
    !status.data?.protocolCompatible
  ) {
    throw new SetupError(
      "The Tessera companion is unavailable after local automation setup.",
    );
  }
  if (status.data.credentialsConfigured) {
    addResult(
      results,
      "Tessera",
      "ready",
      "local agent and Tessera licence key are configured",
    );
    return;
  }
  if (doctor) {
    throw new SetupError(
      "The Tessera companion is installed, but its licence key is not configured.",
    );
  }

  const configure = interactive
    ? await askYesNo(
        "Open the secure macOS Tessera licence-key dialog now? [y/N] ",
        dependencies,
      )
    : false;
  if (!configure) {
    addResult(
      results,
      "Tessera",
      "warning",
      "local agent installed; run npm run rosterpilot -- tessera configure to add the licence key",
    );
    return;
  }

  const configured = parseJsonCommand(
    "Tessera licence-key configuration",
    runRosterPilot(["tessera", "configure"], dependencies),
  );
  if (!configured.ok) {
    throw new SetupError(
      configured.message ?? "Tessera licence-key configuration failed.",
    );
  }
  status = parseJsonCommand(
    "Tessera status",
    runRosterPilot(["tessera", "status"], dependencies),
  );
  if (!status.data?.credentialsConfigured) {
    throw new SetupError(
      "The secure dialog completed, but the Tessera licence key is not configured.",
    );
  }
  addResult(
    results,
    "Tessera",
    "ready",
    "local agent and Tessera licence key are configured",
  );
}

async function handleFreshness(
  { doctor, interactive, refresh, results },
  dependencies,
) {
  if (refresh === "skip") {
    addResult(results, "Live freshness", "warning", "check skipped");
    return;
  }
  const response = parseJsonCommand(
    "Live freshness check",
    runRosterPilot(["freshness"], dependencies),
  );
  const state = response.data?.state ?? "unknown";
  const action = freshnessAction(state);
  if (action === "current") {
    addResult(results, "Live freshness", "ready", "committed release is current");
    return;
  }
  if (action === "unknown") {
    addResult(
      results,
      "Live freshness",
      "warning",
      "at least one upstream source could not be checked; no update was applied",
    );
    if (refresh === "apply") {
      throw new SetupError(
        "Cannot apply a data update while live freshness is unknown.",
      );
    }
    return;
  }

  addResult(results, "Live freshness", "warning", `upstream state is ${state}`);
  if (doctor) return;
  const apply =
    refresh === "apply" ||
    (refresh === "check" &&
      interactive &&
      (await askYesNo(
        "Apply the reviewed data-update workflow now? [y/N] ",
        dependencies,
      )));
  if (!apply) return;

  ensureCleanTrackedWorktree(dependencies);
  assertCommand(
    "Data update",
    runNpmScript("data:prepare-update", [], dependencies),
  );
  assertCommand(
    "Generated data synchronization",
    runNpmScript("data:sync-check", [], dependencies),
  );
  assertCommand("Roster data validation", runNpmScript("data:check", [], dependencies));
  results.splice(
    results.findIndex((result) => result.name === "Live freshness"),
    1,
    {
      name: "Live freshness",
      status: "ready",
      detail: "update applied and validated; review and commit the tracked changes",
    },
  );
}

export async function runSetup(rawOptions, overrides = {}) {
  const dependencies = {
    ask: overrides.ask,
    fs: overrides.fs ?? defaultFileSystem(),
    isTTY: overrides.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    nodeExecutable: overrides.nodeExecutable ?? process.execPath,
    nodeVersion: overrides.nodeVersion ?? process.version,
    platform: overrides.platform ?? process.platform,
    projectRoot: overrides.projectRoot ?? defaultProjectRoot,
    run: overrides.run ?? defaultRun,
    stderr: overrides.stderr ?? process.stderr,
    stdin: overrides.stdin ?? process.stdin,
    stdout: overrides.stdout ?? process.stdout,
  };
  const options = { ...rawOptions };
  const interactive = !options.nonInteractive && dependencies.isTTY;
  const results = [];

  ensureProjectFiles(dependencies);
  const node = validateNodeVersion(dependencies.nodeVersion);
  if (!node.supported) throw new SetupError(node.message);
  addResult(
    results,
    "Node",
    node.aligned ? "ready" : "warning",
    node.message,
  );

  if (!options.profile) {
    options.profile = interactive
      ? await askChoice(
          "Setup profile [core/mcp/new-recruit] (core): ",
          [...supportedProfiles],
          "core",
          dependencies,
        )
      : "core";
    if (!supportedProfiles.has(options.profile)) {
      throw new SetupError(`Invalid profile "${options.profile}".`);
    }
  }
  options.refresh ??= "check";
  if (options.profile === "new-recruit" || options.profile === "tessera") {
    ensureNewRecruitPrerequisites(dependencies);
  }

  const git = dependencies.run("git", ["--version"], {
    capture: true,
    cwd: dependencies.projectRoot,
  });
  assertCommand("Git prerequisite", git);
  addResult(results, "Git", "ready", git.stdout.trim());

  const loaderPath = path.join(
    dependencies.projectRoot,
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );
  if (options.doctor) {
    if (!dependencies.fs.exists(loaderPath)) {
      throw new SetupError(
        'Dependencies are not installed. Run "npm ci" or "npm run setup".',
      );
    }
    addResult(results, "Dependencies", "ready", "installed lockfile dependencies found");
  } else {
    assertCommand(
      "Dependency installation",
      dependencies.run(npmExecutable(dependencies.platform), ["ci"], {
        cwd: dependencies.projectRoot,
      }),
    );
    addResult(results, "Dependencies", "ready", "installed with npm ci");
  }

  assertCommand(
    "Generated data synchronization",
    runNpmScript("data:sync-check", [], dependencies),
  );
  addResult(results, "Generated data", "ready", "matches the pinned BSData commit");

  assertCommand("Roster data validation", runNpmScript("data:check", [], dependencies));
  const status = parseJsonCommand(
    "RosterPilot status",
    runRosterPilot(["status"], dependencies),
  );
  if (!status.ok || !status.data) {
    throw new SetupError("RosterPilot status did not report a ready data release.");
  }
  addResult(
    results,
    "Roster engine",
    "ready",
    `release ${status.data.sources.releaseId} validated`,
  );

  if (profileIncludesMcp(options.profile)) {
    configureMcp({ doctor: options.doctor, results }, dependencies);
  }
  if (options.profile === "new-recruit" || options.profile === "tessera") {
    await configureNewRecruit(
      { doctor: options.doctor, interactive, results },
      dependencies,
    );
  }
  if (options.profile === "tessera") {
    await configureTessera(
      { doctor: options.doctor, interactive, results },
      dependencies,
    );
  }
  await handleFreshness(
    {
      doctor: options.doctor,
      interactive,
      refresh: options.refresh,
      results,
    },
    dependencies,
  );
  printResults(results, dependencies);
  return { ok: true, options, results };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseSetupArgs(argv);
    if (options.help) {
      outputLine(process.stdout, usage(options.doctor));
      return;
    }
    await runSetup(options);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown setup failure.";
    outputLine(process.stderr, `RosterPilot setup failed: ${message}`);
    outputLine(process.stderr, usage(options?.doctor ?? argv.includes("--doctor")));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === setupFile) {
  await main();
}
