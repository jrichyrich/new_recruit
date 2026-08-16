import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const setupFile = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(setupFile), "..");
const supportedProfiles = new Set(["core", "mcp", "new-recruit", "tessera"]);
const supportedRefreshModes = new Set(["skip", "check", "apply"]);
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ensureCurrentNextStep =
  'Run "npm run rosterpilot -- agent ensure-current" from this checkout.';

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

export function localDataBundleEnvironment(
  projectRoot,
  options = {},
) {
  const environment = options.environment ?? process.env;
  const pathExists = options.pathExists ?? existsSync;
  const defaultBootstrapDirectory = path.join(
    projectRoot,
    "data",
    "bootstrap-data-bundle",
  );
  const explicitBootstrapDirectory =
    environment.ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY;
  /** @type {Record<string, string>} */
  const result = {
    ROSTERPILOT_DATA_PROVIDER_MODE:
      environment.ROSTERPILOT_DATA_PROVIDER_MODE ?? "local-source",
  };
  if (environment.ROSTERPILOT_SUPPORT_DIRECTORY) {
    result.ROSTERPILOT_SUPPORT_DIRECTORY =
      environment.ROSTERPILOT_SUPPORT_DIRECTORY;
  }
  // Signed-channel settings are operator-controlled. A cloned local install
  // must not silently fall back to the publisher channel or require keys.
  if (environment.ROSTERPILOT_DATA_CHANNEL_URL) {
    result.ROSTERPILOT_DATA_CHANNEL_URL =
      environment.ROSTERPILOT_DATA_CHANNEL_URL;
  }
  if (environment.ROSTERPILOT_DATA_TRUSTED_KEYS_FILE) {
    result.ROSTERPILOT_DATA_TRUSTED_KEYS_FILE =
      environment.ROSTERPILOT_DATA_TRUSTED_KEYS_FILE;
  }
  if (
    explicitBootstrapDirectory ||
    pathExists(defaultBootstrapDirectory)
  ) {
    result.ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY =
      explicitBootstrapDirectory ?? defaultBootstrapDirectory;
  }
  return result;
}

export function renderLocalMcpServerConfig({
  nodeExecutable,
  projectRoot,
  environment = undefined,
  pathExists = undefined,
}) {
  return {
    command: nodeExecutable,
    args: [
      "--import",
      pathToFileURL(
        path.join(
          projectRoot,
          "node_modules",
          "tsx",
          "dist",
          "loader.mjs",
        ),
      ).href,
      path.join(projectRoot, "mcp", "stdio.ts"),
    ],
    cwd: projectRoot,
    env: localDataBundleEnvironment(projectRoot, {
      environment,
      pathExists,
    }),
  };
}

export function renderCodexConfig({
  nodeExecutable,
  projectRoot,
  environment = undefined,
  pathExists = undefined,
}) {
  const server = renderLocalMcpServerConfig({
    nodeExecutable,
    projectRoot,
    environment,
    pathExists,
  });
  const dataEnvironmentToml = Object.entries(server.env)
    .map(([name, value]) => `${name} = ${quoteToml(value)}`)
    .join(", ");
  return [
    "# RosterPilot standalone MCP configuration.",
    "# Do not combine this entry with the rosterpilot@personal plugin in the same checkout.",
    "[mcp_servers.rosterpilot]",
    `command = ${quoteToml(server.command)}`,
    `args = [${server.args.map(quoteToml).join(", ")}]`,
    `cwd = ${quoteToml(server.cwd)}`,
    `env = { ${dataEnvironmentToml} }`,
    "",
  ].join("\n");
}

export function renderClaudeConfig({
  nodeExecutable,
  projectRoot,
  environment = undefined,
  pathExists = undefined,
}) {
  const server = renderLocalMcpServerConfig({
    nodeExecutable,
    projectRoot,
    environment,
    pathExists,
  });
  return JSON.stringify(
    {
      mcpServers: {
        rosterpilot: server,
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

For the ChatGPT/Codex personal-plugin path, run the core profile first, then
npm run plugin:local:install. Later profiles detect that registration and do
not create a shadowing project-local MCP entry.
`;
}

function defaultRun(command, args, options = {}) {
  const capture = options.capture === true;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: capture ? "utf8" : undefined,
    shell:
      process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
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
    probeWritableDirectory(directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const probe = path.join(
        directory,
        `.rosterpilot-write-check-${process.pid}-${Date.now()}`,
      );
      try {
        writeFileSync(probe, "RosterPilot writable-storage check.\n", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } finally {
        if (existsSync(probe)) unlinkSync(probe);
      }
    },
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
    [
      "run",
      ...(capture ? ["--silent"] : []),
      name,
      ...(args.length ? ["--", ...args] : []),
    ],
    {
      capture,
      cwd: dependencies.projectRoot,
    },
  );
}

function runRosterPilot(action, dependencies) {
  const loader = pathToFileURL(
    path.join(
      dependencies.projectRoot,
      "node_modules",
      "tsx",
      "dist",
      "loader.mjs",
    ),
  ).href;
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

function addResult(results, name, status, detail, nextSteps = []) {
  results.push({ name, status, detail, nextSteps });
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
  const nextSteps = [
    ...new Set(results.flatMap((result) => result.nextSteps ?? [])),
  ];
  if (nextSteps.length) {
    outputLine(dependencies.stdout);
    outputLine(dependencies.stdout, "Next steps");
    for (const nextStep of nextSteps) {
      outputLine(dependencies.stdout, `  • ${nextStep}`);
    }
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

function diagnoseSupportStorage(results, dependencies, blocking) {
  try {
    dependencies.fs.probeWritableDirectory(
      dependencies.supportDirectory,
    );
    addResult(
      results,
      "Application support storage",
      "ready",
      `${dependencies.supportDirectory} is writable`,
    );
  } catch (error) {
    addResult(
      results,
      "Application support storage",
      blocking ? "error" : "warning",
      `RosterPilot cannot write its local snapshots at ${dependencies.supportDirectory}: ${
        error instanceof Error ? error.message : String(error)
      }. Roster building can still use the compiled snapshot.`,
      [
        "Make that folder writable for your account, then rerun Doctor. Do not run RosterPilot as root.",
      ],
    );
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

function configureMcp({ doctor, results }, dependencies) {
  const configDirectory = path.join(dependencies.projectRoot, ".codex");
  const configPath = path.join(configDirectory, "config.toml");
  const config = renderCodexConfig({
    nodeExecutable: dependencies.nodeExecutable,
    projectRoot: dependencies.projectRoot,
  });
  const pluginCheck = runNpmScript(
    "plugin:local:check",
    [],
    dependencies,
    true,
  );
  let pluginReport = null;
  try {
    pluginReport = pluginCheck.stdout.trim()
      ? JSON.parse(pluginCheck.stdout)
      : null;
  } catch {
    pluginReport = null;
  }
  const personalPluginRegistered =
    pluginReport?.installed?.pluginId === "rosterpilot@personal";

  if (personalPluginRegistered) {
    if (pluginReport.projectMcpShadow?.status === "shadowing") {
      const message =
        `project-local MCP configuration shadows rosterpilot@personal: ${pluginReport.projectMcpShadow.configPath}`;
      if (!doctor) throw new SetupError(message);
      addResult(
        results,
        "ChatGPT/Codex personal plugin",
        "error",
        message,
        [
          "Remove or rename only the project-local mcp_servers.rosterpilot entry, then rerun Doctor.",
        ],
      );
    } else {
      const ready =
        !pluginCheck.error &&
        pluginCheck.code === 0 &&
        pluginReport.ok === true;
      addResult(
        results,
        "ChatGPT/Codex personal plugin",
        ready ? "ready" : "warning",
        ready
          ? "registered plugin owns the local RosterPilot MCP server; standalone configuration was skipped"
          : "registered plugin needs repair; standalone configuration was skipped to avoid shadowing it",
        ready
          ? []
          : [
              'Run "npm run plugin:local:install", then start a new ChatGPT/Codex task.',
            ],
      );
    }
    outputLine(
      dependencies.stdout,
      "\nOptional Claude Desktop configuration (copy into its mcpServers configuration):",
    );
    outputLine(
      dependencies.stdout,
      renderClaudeConfig({
        nodeExecutable: dependencies.nodeExecutable,
        projectRoot: dependencies.projectRoot,
      }),
    );
    return;
  }

  if (doctor) {
    if (dependencies.fs.exists(configPath)) {
      addResult(results, "Standalone Codex MCP", "ready", `${configPath} exists`);
    } else {
      addResult(
        results,
        "Standalone Codex MCP",
        "warning",
        `configuration is absent; run npm run setup -- --profile mcp`,
        ['Run "npm run setup -- --profile mcp" to create the local Codex MCP configuration.'],
      );
    }
  } else if (dependencies.fs.exists(configPath)) {
    addResult(
      results,
      "Standalone Codex MCP",
      "warning",
      `${configPath} already exists and was not overwritten`,
    );
    outputLine(dependencies.stdout, "\nMerge this block if RosterPilot is absent:");
    outputLine(dependencies.stdout, config);
  } else {
    dependencies.fs.mkdir(configDirectory);
    dependencies.fs.write(configPath, config);
    addResult(results, "Standalone Codex MCP", "ready", `created ${configPath}`);
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

function configureManagedSkill({ doctor, results }, dependencies) {
  const action = doctor ? "skill:check" : "skill:install";
  const result = runNpmScript(action, [], dependencies, true);
  let report = null;
  try {
    report = result.stdout.trim()
      ? JSON.parse(result.stdout)
      : null;
  } catch {
    report = null;
  }
  const ready =
    !result.error &&
    result.code === 0 &&
    report?.ok === true &&
    report?.status === "current";
  const pluginNotice =
    report?.pluginCache?.status === "outside-setup-control"
      ? ` Plugin cache ${report.pluginCache.path} is outside setup control.`
      : "";
  addResult(
    results,
    "RosterPilot Codex skill",
    ready ? "ready" : "warning",
    ready
      ? `managed skill ${report.version} matches source ${report.sourceHash}.${pluginNotice}`
      : `${
          report?.status
            ? `managed skill is ${report.status}`
            : commandFailure("RosterPilot skill management", result).message
        }.${pluginNotice}`,
    ready
      ? []
      : [
          `Run "npm run ${doctor ? "skill:install" : "skill:check"}" to inspect or repair the managed RosterPilot skill.`,
        ],
  );
}

async function configureNewRecruit(
  { doctor, results },
  dependencies,
) {
  ensureNewRecruitPrerequisites(dependencies);
  const lifecycle = !doctor
    ? parseJsonCommand(
      "RosterPilot local-agent installation",
      runRosterPilot(["agent", "install"], dependencies),
    )
    : parseJsonCommand(
      "RosterPilot local-agent status",
      runRosterPilot(["agent", "status"], dependencies),
    );
  if (!lifecycle.ok || !lifecycle.running || !lifecycle.status) {
    throw new SetupError(
      lifecycle.message ??
        "The RosterPilot local agent is not installed or running.",
    );
  }
  const provider = lifecycle.status.providers?.find(
    (item) => item.providerId === "new-recruit",
  );
  if (provider?.credentialState !== "disabled") {
    throw new SetupError(
      "The installed New Recruit broker did not report the required fail-closed credential contract. Run agent ensure-current before continuing.",
    );
  }
  addResult(
    results,
    "New Recruit",
    "warning",
    "new Keychain credential release and sign-in are disabled pending an authenticated native consumer; local exports remain available and an existing browser session may remain active",
  );
}

async function configureTessera(
  { results },
  dependencies,
) {
  const lifecycle = parseJsonCommand(
    "RosterPilot local-agent status",
    runRosterPilot(["agent", "status"], dependencies),
  );
  if (!lifecycle.ok || !lifecycle.running || !lifecycle.status) {
    throw new SetupError(
      lifecycle.message ??
        "The RosterPilot local agent is not installed or running.",
    );
  }
  const provider = lifecycle.status.providers?.find(
    (item) => item.providerId === "tessera",
  );
  if (provider?.credentialState !== "disabled") {
    throw new SetupError(
      "The installed Tessera broker did not report the required fail-closed credential contract. Run agent ensure-current before continuing.",
    );
  }
  addResult(
    results,
    "Tessera",
    "warning",
    "Tessera Website credential release is disabled pending an authenticated native consumer; use the local-engine backend",
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
  const diagnostic = diagnosticJson(
    "Live freshness check",
    runRosterPilot(["freshness"], dependencies),
  );
  if (!diagnostic.ok) {
    addResult(
      results,
      "Live freshness",
      "warning",
      `${diagnostic.detail} The pinned local data remains available and no update was applied.`,
      [
        'Retry "npm run rosterpilot -- freshness" when internet access is available.',
      ],
    );
    return;
  }
  const response = diagnostic.value;
  const state = response.data?.state ?? "unknown";
  const action = freshnessAction(state);
  if (action === "current") {
    addResult(
      results,
      "Live freshness",
      "ready",
      "active verified data is current",
    );
    return;
  }
  if (action === "unknown") {
    addResult(
      results,
      "Live freshness",
      "warning",
      "at least one upstream source could not be checked; no update was applied",
    );
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

  const refreshResponse = parseJsonCommand(
    "Runtime data refresh",
    runRosterPilot(["data", "refresh"], dependencies),
  );
  if (!refreshResponse.ok) {
    const providerUnavailable = refreshResponse.violations?.some(
      (violation) =>
        violation.code === "DATA_BUNDLE_PROVIDER_UNAVAILABLE",
    );
    if (providerUnavailable) {
      results.splice(
        results.findIndex(
          (result) => result.name === "Live freshness",
        ),
        1,
        {
          name: "Live freshness",
          status: "warning",
          detail:
            "the local data updater is unavailable; continuing from pinned compiled data",
        },
      );
      return;
    }
    throw new SetupError(
      `Runtime data refresh failed: ${
        refreshResponse.violations
          ?.map((violation) => violation.message)
          .join(" ") ?? "the provider rejected the update"
      }`,
    );
  }
  results.splice(
    results.findIndex((result) => result.name === "Live freshness"),
    1,
    {
      name: "Live freshness",
      status: refreshResponse.data?.activatedBundleId
        ? "ready"
        : "warning",
      detail: refreshResponse.data?.activatedBundleId
        ? `verified snapshot ${shortIdentity(refreshResponse.data.activatedBundleId)} activated for future work`
        : refreshResponse.data?.localUpdateJobId
          ? `background update job ${refreshResponse.data.localUpdateJobId} was queued; current snapshot ${shortIdentity(refreshResponse.data.status?.activeBundleId)} remains active until the candidate finishes certification`
          : "the refresh request was accepted, but no activated snapshot or background job was reported; the current snapshot remains active",
      nextSteps: refreshResponse.data?.localUpdateJobId
        ? [
            `Run "npm run rosterpilot -- data update-job --job ${refreshResponse.data.localUpdateJobId}" to follow the background job.`,
          ]
        : [],
    },
  );
}

function shortIdentity(value) {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function locallyCertifiedMatchesUpstream(sourceStatus) {
  const upstream = sourceStatus?.latestUpstream;
  const certified = sourceStatus?.latestLocallyCertified;
  if (!upstream || !certified) return false;
  return (
    (upstream.rulesVersion === null ||
      upstream.rulesVersion === certified.rulesVersion) &&
    (upstream.newRecruitCommit === null ||
      upstream.newRecruitCommit === certified.newRecruitCommit)
  );
}

function addDataBundleReadiness(results, status) {
  const bundle = status?.dataBundle;
  const activeIdentity = shortIdentity(bundle?.activeBundleId);
  const locallyVerified = bundle?.dataTrust === "locally-verified";
  const signedVerified = bundle?.dataTrust === "signed-verified";
  const activeVerified = locallyVerified || signedVerified;
  addResult(
    results,
    "Active roster snapshot",
    activeVerified ? "ready" : "warning",
    locallyVerified
      ? `locally verified snapshot ${activeIdentity} is active for new roster work`
      : signedVerified
        ? `signed verified snapshot ${activeIdentity} is active for this hosted deployment`
        : `compiled snapshot ${activeIdentity} is active and roster building remains available while local data initializes`,
    activeVerified
      ? []
      : [
          "Keep using the compiled snapshot; RosterPilot will switch future work only after a local snapshot passes certification.",
        ],
  );

  const localUpdate = bundle?.localUpdate;
  if (localUpdate) {
    const updateFinished = localUpdate.status === "activated";
    addResult(
      results,
      "Background data update",
      updateFinished ? "ready" : "warning",
      updateFinished
        ? `job ${localUpdate.jobId} activated the current snapshot; ${localUpdate.progress}`
        : `job ${localUpdate.jobId} is ${localUpdate.status}; ${localUpdate.progress} Current snapshot ${activeIdentity} remains active.`,
      updateFinished
        ? []
        : [
            `Run "npm run rosterpilot -- data update-job --job ${localUpdate.jobId}" to see its current progress.`,
          ],
    );
  } else if (bundle?.providerMode === "local-source") {
    addResult(
      results,
      "Background data update",
      "warning",
      `no local update job has been recorded; current snapshot ${activeIdentity} remains usable`,
      [
        'Run "npm run rosterpilot -- data refresh" to queue a check now, or leave RosterPilot to run its daily background check.',
      ],
    );
  }

  const sourceStatus = bundle?.sourceStatus;
  const upstreamObserved = Boolean(
    sourceStatus?.latestUpstream &&
      (sourceStatus.latestUpstream?.rulesVersion !== null ||
        sourceStatus.latestUpstream?.newRecruitCommit !== null),
  );
  const upstreamCurrent = locallyCertifiedMatchesUpstream(sourceStatus);
  addResult(
    results,
    "Upstream data",
    upstreamCurrent ? "ready" : "warning",
    upstreamCurrent
      ? `latest checked 40kdc and BSData identities match locally certified snapshot ${shortIdentity(sourceStatus.latestLocallyCertified?.bundleId)}`
      : upstreamObserved
        ? "newer or not-yet-certified upstream data was observed; the current snapshot stays active while the background updater checks it"
        : "upstream identity has not been checked yet; this does not prevent use of the current snapshot",
    upstreamCurrent
      ? []
      : [
          'Run "npm run rosterpilot -- data update-status" to inspect the latest upstream and certified identities.',
        ],
  );

  const observations = bundle?.serviceCompatibility ?? [];
  const incompatible = observations.filter(
    (observation) => !observation.compatibleBundleId,
  );
  addResult(
    results,
    "Service compatibility",
    incompatible.length === 0 ? "ready" : "warning",
    observations.length === 0
      ? "no New Recruit or Tessera Web catalogue mismatch has been observed yet"
      : incompatible.length === 0
        ? `${observations.length} observed New Recruit/Tessera catalogue ${observations.length === 1 ? "identity has" : "identities have"} an exact compatible retained snapshot`
        : `${incompatible.length} observed service ${incompatible.length === 1 ? "identity needs" : "identities need"} compatibility repair; rosters and mutation receipts are preserved`,
    incompatible.length === 0
      ? []
      : [
          "Continue the affected workflow; RosterPilot will queue the compatibility search without creating another external list.",
        ],
  );

  const officialReconciliation =
    sourceStatus?.officialReconciliation ?? "unavailable";
  addResult(
    results,
    "Official reconciliation",
    officialReconciliation === "verified" ? "ready" : "warning",
    officialReconciliation === "verified"
      ? "the active official-source overlay is verified"
      : officialReconciliation === "pending"
        ? "an official Games Workshop source change was detected and still needs reconciliation; the last usable values remain active"
        : "official-source reconciliation status is unavailable; community and New Recruit source status remains separate",
  );
}

function diagnosticJson(label, result) {
  let value = null;
  if (result.stdout.trim()) {
    try {
      value = JSON.parse(result.stdout);
    } catch {
      if (!result.error && result.code === 0) {
        return {
          ok: false,
          detail: `${label} returned invalid JSON.`,
          value: null,
        };
      }
    }
  }
  if (result.error || result.code !== 0) {
    return {
      ok: false,
      detail: commandFailure(label, result).message,
      value,
    };
  }
  return {
    ok: true,
    detail: "",
    value,
  };
}

function diagnoseCommand(
  results,
  {
    name,
    label,
    result,
    readyDetail,
    nextSteps,
  },
) {
  if (result.error || result.code !== 0) {
    addResult(
      results,
      name,
      "error",
      commandFailure(label, result).message,
      nextSteps,
    );
    return false;
  }
  addResult(results, name, "ready", readyDetail);
  return true;
}

function diagnoseLocalAutomation(profile, dependencies, results) {
  if (dependencies.platform !== "darwin") {
    addResult(
      results,
      "Local automation platform",
      "error",
      `${profile} readiness requires macOS; this host reports ${dependencies.platform}`,
      ["Use the core or mcp profile on this host."],
    );
    return;
  }

  const swiftReady = dependencies.fs.isExecutable("/usr/bin/swiftc");
  addResult(
    results,
    "Swift toolchain",
    swiftReady ? "ready" : "error",
    swiftReady
      ? "Apple Swift compiler is available"
      : "Swift is unavailable, so the Keychain broker cannot be built",
    swiftReady
      ? []
      : [
          "Install the Apple command-line developer tools, then rerun Doctor.",
        ],
  );
  const browserReady = dependencies.fs.isExecutable(chromePath);
  addResult(
    results,
    "Google Chrome",
    browserReady ? "ready" : "error",
    browserReady
      ? `${chromePath} is executable`
      : `Chrome is not executable at ${chromePath}`,
    browserReady
      ? []
      : ["Install Google Chrome in /Applications, then rerun Doctor."],
  );

  let agentStatus = null;
  let agentReady = false;
  const agentResponse = diagnosticJson(
    "RosterPilot local-agent status",
    runRosterPilot(["agent", "status"], dependencies),
  );
  if (!agentResponse.ok && !agentResponse.value) {
    addResult(
      results,
      "Local agent",
      "error",
      agentResponse.detail,
      [ensureCurrentNextStep],
    );
  } else {
    const agent = agentResponse.value;
    agentReady = agent.ok === true && agent.running === true;
    agentStatus = agent.status ?? null;
    const buildId = agent.status?.runtime?.buildId;
    addResult(
      results,
      "Local agent",
      agentReady ? "ready" : "error",
      agentReady
        ? `running from the current checkout${buildId ? ` (build ${buildId})` : ""}`
        : `${agent.code ?? "LOCAL_AGENT_UNAVAILABLE"}: ${agent.message ?? "the installed agent is not current and ready"}`,
      agentReady
        ? []
        : agent.nextSteps?.length
          ? agent.nextSteps
          : [ensureCurrentNextStep],
    );
    if (agent.status) {
      addResult(
        results,
        "Keychain broker",
        agent.status.brokerAvailable ? "ready" : "error",
        agent.status.brokerAvailable
          ? "the installed broker responds for local providers"
          : `${agent.status.brokerStatusCode ?? "BROKER_UNAVAILABLE"}: the installed broker is unavailable`,
        agent.status.brokerAvailable
          ? []
          : [
              'Run "npm run rosterpilot -- agent ensure-current"; reauthorize the broker if macOS prompts.',
            ],
      );
    }
  }

  const newRecruitProvider = agentStatus?.providers?.find(
    (item) => item.providerId === "new-recruit",
  );
  const newRecruitDisabled =
    newRecruitProvider?.credentialState === "disabled";
  const newRecruitReady = agentReady && newRecruitProvider?.ready === true;
  addResult(
    results,
    "New Recruit",
    newRecruitReady ? "ready" : newRecruitDisabled ? "warning" : "error",
    newRecruitReady
      ? "browser automation and the Keychain credential are ready"
      : newRecruitDisabled
        ? "new Keychain credential release and sign-in are disabled pending an authenticated native consumer; local exports remain available and an existing browser session may remain active"
        : `automation is unavailable${newRecruitProvider?.credentialState ? `; credential state is ${newRecruitProvider.credentialState}` : ""}`,
    newRecruitReady || newRecruitDisabled ? [] : [ensureCurrentNextStep],
  );

  if (profile !== "tessera") return;
  const tesseraProvider = agentStatus?.providers?.find(
    (item) => item.providerId === "tessera",
  );
  const tesseraDisabled = tesseraProvider?.credentialState === "disabled";
  const tesseraReady = agentReady && tesseraProvider?.ready === true;
  addResult(
    results,
    "Tessera",
    tesseraReady ? "ready" : tesseraDisabled ? "warning" : "error",
    tesseraReady
      ? "browser automation and the Tessera licence key are ready"
      : tesseraDisabled
        ? "Tessera Website credential release is disabled pending an authenticated native consumer; the local-engine backend remains available"
      : `automation is unavailable${tesseraProvider?.credentialState ? `; credential state is ${tesseraProvider.credentialState}` : ""}`,
    tesseraReady || tesseraDisabled ? [] : [ensureCurrentNextStep],
  );
}

async function diagnoseRemoteFreshness(options, dependencies, results) {
  if (options.refresh === "skip") {
    addResult(
      results,
      "Upstream connectivity",
      "warning",
      "live upstream check skipped; all local diagnostics still ran",
      [
        'Run "npm run rosterpilot -- freshness" when internet access is available.',
      ],
    );
    return;
  }
  const response = diagnosticJson(
    "Live freshness check",
    runRosterPilot(["freshness"], dependencies),
  );
  if (!response.ok) {
    addResult(
      results,
      "Upstream connectivity",
      "warning",
      `${response.detail} Local readiness results remain valid for the active frozen data bundle.`,
      [
        'Retry "npm run rosterpilot -- freshness" when internet access is available.',
      ],
    );
    return;
  }
  const state = response.value.data?.state ?? "unknown";
  const action = freshnessAction(state);
  addResult(
    results,
    "Upstream connectivity",
    action === "current" ? "ready" : "warning",
    action === "current"
      ? "the active verified data matches the checked upstream sources"
      : action === "offer-update"
        ? `upstream state is ${state}; no update was applied`
        : "one or more upstream sources could not be checked; local diagnostics are unaffected",
    action === "current"
      ? []
      : action === "offer-update"
        ? ['Run "npm run setup -- --refresh apply" after reviewing the update.']
        : [
            'Retry "npm run rosterpilot -- freshness" when internet access is available.',
          ],
  );
}

function diagnosePinnedSourceSynchronization(
  options,
  dependencies,
  results,
) {
  if (options.refresh === "skip") {
    addResult(
      results,
      "Remote pinned-source check",
      "warning",
      "network-backed BSData synchronization check skipped; committed data was still validated locally",
      [
        'Run "npm run data:sync-check" when internet access is available.',
      ],
    );
    return;
  }
  const result = runNpmScript(
    "data:sync-check",
    [],
    dependencies,
    true,
  );
  if (result.error || result.code !== 0) {
    addResult(
      results,
      "Remote pinned-source check",
      "warning",
      "the pinned BSData checkout could not be fetched; committed data was still validated locally",
      [
        'Retry "npm run data:sync-check" when internet access is available.',
      ],
    );
    return;
  }
  addResult(
    results,
    "Remote pinned-source check",
    "ready",
    "generated data matches a freshly fetched pinned BSData checkout",
  );
}

async function runDoctor(options, dependencies, results) {
  const npm = dependencies.run(
    npmExecutable(dependencies.platform),
    ["--version"],
    {
      capture: true,
      cwd: dependencies.projectRoot,
    },
  );
  diagnoseCommand(results, {
    name: "npm",
    label: "npm prerequisite",
    result: npm,
    readyDetail: `npm ${npm.stdout.trim()}`,
    nextSteps: ["Install npm with Node.js, then rerun Doctor."],
  });

  const git = dependencies.run("git", ["--version"], {
    capture: true,
    cwd: dependencies.projectRoot,
  });
  diagnoseCommand(results, {
    name: "Git",
    label: "Git prerequisite",
    result: git,
    readyDetail: git.stdout.trim(),
    nextSteps: ["Install Git, then rerun Doctor."],
  });
  diagnoseSupportStorage(results, dependencies, true);

  const loaderPath = path.join(
    dependencies.projectRoot,
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );
  const dependenciesReady = dependencies.fs.exists(loaderPath);
  addResult(
    results,
    "Dependencies",
    dependenciesReady ? "ready" : "error",
    dependenciesReady
      ? "installed lockfile dependencies found"
      : "lockfile dependencies are not installed",
    dependenciesReady
      ? []
      : ['Run "npm ci", then rerun Doctor.'],
  );

  if (options.profile === "new-recruit" || options.profile === "tessera") {
    if (dependenciesReady) {
      diagnoseLocalAutomation(options.profile, dependencies, results);
    } else {
      const browserReady =
        dependencies.platform === "darwin" &&
        dependencies.fs.isExecutable(chromePath);
      addResult(
        results,
        "Google Chrome",
        browserReady ? "ready" : "error",
        browserReady
          ? `${chromePath} is executable`
          : "Chrome or the required macOS host is unavailable",
        browserReady
          ? []
          : ["Install Google Chrome in /Applications on macOS."],
      );
      addResult(
        results,
        "Local agent",
        "error",
        "agent diagnostics require the installed lockfile dependencies",
        ['Run "npm ci", then rerun Doctor.'],
      );
    }
  }

  if (dependenciesReady) {
    diagnoseCommand(results, {
      name: "Roster data validation",
      label: "Roster data validation",
      result: runNpmScript("data:check", [], dependencies, true),
      readyDetail: "committed roster data passes validation",
      nextSteps: [
        'Run "npm run data:check" and address the reported validation error.',
      ],
    });
    const statusResponse = diagnosticJson(
      "RosterPilot status",
      runRosterPilot(["status"], dependencies),
    );
    if (
      statusResponse.ok &&
      statusResponse.value.ok &&
      statusResponse.value.data
    ) {
      addResult(
        results,
        "Roster engine",
        "ready",
        `release ${statusResponse.value.data.sources.releaseId} validated`,
      );
      addDataBundleReadiness(results, statusResponse.value.data);
    } else {
      addResult(
        results,
        "Roster engine",
        "error",
        statusResponse.ok
          ? "RosterPilot status did not report a ready data release."
          : statusResponse.detail,
        ['Run "npm run rosterpilot -- status" and resolve the reported data issue.'],
      );
    }
  } else {
    for (const name of [
      "Roster data validation",
      "Roster engine",
    ]) {
      addResult(
        results,
        name,
        "error",
        "check skipped because lockfile dependencies are missing",
        ['Run "npm ci", then rerun Doctor.'],
      );
    }
  }

  if (profileIncludesMcp(options.profile)) {
    configureManagedSkill({ doctor: true, results }, dependencies);
    configureMcp({ doctor: true, results }, dependencies);
  }
  if (dependenciesReady) {
    diagnosePinnedSourceSynchronization(
      options,
      dependencies,
      results,
    );
    await diagnoseRemoteFreshness(options, dependencies, results);
  } else {
    addResult(
      results,
      "Remote pinned-source check",
      "warning",
      "network-backed synchronization check skipped because lockfile dependencies are missing",
      [
        'Run "npm ci", then retry "npm run data:sync-check" when online.',
      ],
    );
    addResult(
      results,
      "Upstream connectivity",
      "warning",
      "live check skipped because lockfile dependencies are missing; local file checks above remain authoritative",
      [
        'Run "npm ci", then retry "npm run rosterpilot -- freshness" when online.',
      ],
    );
  }

  printResults(results, dependencies);
  const nextSteps = [
    ...new Set(results.flatMap((result) => result.nextSteps ?? [])),
  ];
  return {
    ok: !results.some((result) => result.status === "error"),
    options,
    results,
    nextSteps,
  };
}

export async function runSetup(rawOptions, overrides = {}) {
  const environment = overrides.environment ?? process.env;
  const homeDirectory = overrides.homeDirectory ?? os.homedir();
  const dependencies = {
    ask: overrides.ask,
    environment,
    fs: overrides.fs ?? defaultFileSystem(),
    homeDirectory,
    isTTY: overrides.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    nodeExecutable: overrides.nodeExecutable ?? process.execPath,
    nodeVersion: overrides.nodeVersion ?? process.version,
    platform: overrides.platform ?? process.platform,
    projectRoot: overrides.projectRoot ?? defaultProjectRoot,
    run: overrides.run ?? defaultRun,
    stderr: overrides.stderr ?? process.stderr,
    stdin: overrides.stdin ?? process.stdin,
    supportDirectory:
      overrides.supportDirectory ??
      environment.ROSTERPILOT_SUPPORT_DIRECTORY ??
      path.join(
        homeDirectory,
        "Library",
        "Application Support",
        "RosterPilot",
      ),
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
          "Setup profile [core/mcp/new-recruit/tessera] (core): ",
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
  if (options.doctor) {
    return runDoctor(options, dependencies, results);
  }
  if (options.profile === "new-recruit" || options.profile === "tessera") {
    ensureNewRecruitPrerequisites(dependencies);
  }

  const npm = dependencies.run(
    npmExecutable(dependencies.platform),
    ["--version"],
    {
      capture: true,
      cwd: dependencies.projectRoot,
    },
  );
  assertCommand("npm prerequisite", npm);
  addResult(results, "npm", "ready", `npm ${npm.stdout.trim()}`);

  const git = dependencies.run("git", ["--version"], {
    capture: true,
    cwd: dependencies.projectRoot,
  });
  assertCommand("Git prerequisite", git);
  addResult(results, "Git", "ready", git.stdout.trim());
  diagnoseSupportStorage(results, dependencies, false);

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

  if (options.refresh === "skip") {
    addResult(
      results,
      "Remote pinned-source check",
      "warning",
      "network-backed BSData synchronization check skipped; committed data will be validated locally",
      [
        'Run "npm run data:sync-check" when internet access is available.',
      ],
    );
  } else {
    const synchronization = runNpmScript(
      "data:sync-check",
      [],
      dependencies,
      true,
    );
    if (synchronization.error || synchronization.code !== 0) {
      addResult(
        results,
        "Remote pinned-source check",
        "warning",
        "the pinned BSData checkout could not be fetched; committed data will still be validated locally",
        [
          'Retry "npm run data:sync-check" when internet access is available.',
        ],
      );
    } else {
      addResult(
        results,
        "Remote pinned-source check",
        "ready",
        "generated data matches a freshly checked pinned BSData checkout",
      );
    }
  }

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
  addDataBundleReadiness(results, status.data);

  if (profileIncludesMcp(options.profile)) {
    configureManagedSkill({ doctor: false, results }, dependencies);
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
  return { ok: true, options, results, nextSteps: [] };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseSetupArgs(argv);
    if (options.help) {
      outputLine(process.stdout, usage(options.doctor));
      return;
    }
    const result = await runSetup(options);
    if (!result.ok) process.exitCode = 2;
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
