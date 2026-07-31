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
import { fileURLToPath, pathToFileURL } from "node:url";

const setupFile = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(setupFile), "..");
const supportedProfiles = new Set(["core", "mcp", "new-recruit", "tessera"]);
const supportedRefreshModes = new Set(["skip", "check", "apply"]);
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const defaultDataBundleChannelUrl =
  "https://raw.githubusercontent.com/jrichyrich/new_recruit/data-bundles/channels/stable.json";
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

function localDataBundleEnvironment(projectRoot) {
  return {
    ROSTERPILOT_DATA_CHANNEL_URL:
      process.env.ROSTERPILOT_DATA_CHANNEL_URL ??
      defaultDataBundleChannelUrl,
    ROSTERPILOT_DATA_TRUSTED_KEYS_FILE:
      process.env.ROSTERPILOT_DATA_TRUSTED_KEYS_FILE ??
      path.join(
        projectRoot,
        "data",
        "data-bundle-trusted-keys.json",
      ),
    ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY:
      process.env.ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY ??
      path.join(projectRoot, "data", "bootstrap-data-bundle"),
  };
}

export function renderCodexConfig({
  nodeExecutable,
  projectRoot,
}) {
  const loader = pathToFileURL(
    path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs"),
  ).href;
  const server = path.join(projectRoot, "mcp", "stdio.ts");
  const dataEnvironment = localDataBundleEnvironment(projectRoot);
  const dataEnvironmentToml = Object.entries(dataEnvironment)
    .map(([name, value]) => `${name} = ${quoteToml(value)}`)
    .join(", ");
  return [
    "[mcp_servers.rosterpilot]",
    `command = ${quoteToml(nodeExecutable)}`,
    `args = [${[
      "--import",
      loader,
      server,
    ].map(quoteToml).join(", ")}]`,
    `cwd = ${quoteToml(projectRoot)}`,
    `env = { ${dataEnvironmentToml} }`,
    "",
  ].join("\n");
}

export function renderClaudeConfig({
  nodeExecutable,
  projectRoot,
}) {
  const dataEnvironment = localDataBundleEnvironment(projectRoot);
  return JSON.stringify(
    {
      mcpServers: {
        rosterpilot: {
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
          env: dataEnvironment,
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

  if (doctor) {
    if (dependencies.fs.exists(configPath)) {
      addResult(results, "Codex MCP", "ready", `${configPath} exists`);
    } else {
      addResult(
        results,
        "Codex MCP",
        "warning",
        `configuration is absent; run npm run setup -- --profile mcp`,
        ['Run "npm run setup -- --profile mcp" to create the local Codex MCP configuration.'],
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
            "signed runtime updates are unavailable; continuing from the pinned compiled offline data",
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
      status: "ready",
      detail:
        "latest verified runtime bundle activated; the tracked offline bootstrap was unchanged",
    },
  );
}

function addDataBundleReadiness(results, status) {
  const bundle = status?.dataBundle;
  const signed =
    bundle?.dataTrust === undefined ||
    bundle.dataTrust === "signed-verified";
  const healthy =
    bundle?.state !== "degraded" &&
    bundle?.state !== "offline";
  const durable = bundle?.durability?.state !== "degraded";
  const ready =
    bundle?.providerConfigured === true &&
    typeof bundle.activeBundleId === "string" &&
    bundle.activeBundleId.length > 0 &&
    signed &&
    healthy &&
    durable;
  addResult(
    results,
    "Signed data updates",
    ready ? "ready" : "warning",
    ready
      ? `provider is ${bundle.state ?? "ready"} on bundle ${bundle.activeBundleId}`
      : bundle?.providerConfigured
        ? `signed provider is configured but not release-ready (state ${bundle.state ?? "degraded"}, trust ${bundle.dataTrust ?? "unknown"}${
            bundle?.durability?.reason
              ? `; ${bundle.durability.reason}`
              : ""
          })`
        : "signed runtime provider is unavailable; builds use pinned compiled data",
    ready
      ? []
      : [
          'Run "npm run rosterpilot -- data update-status" to inspect bootstrap, trust-key, and channel readiness.',
          'Release operators must run "npm run data:bundle:verify-release" before deployment.',
        ],
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
    const agentReady = agent.ok === true && agent.running === true;
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

  const newRecruitResponse = diagnosticJson(
    "New Recruit status",
    runRosterPilot(["new-recruit", "status"], dependencies),
  );
  if (!newRecruitResponse.ok) {
    addResult(
      results,
      "New Recruit",
      "error",
      newRecruitResponse.detail,
      [
        'Run "npm run rosterpilot -- new-recruit status" after repairing the local agent.',
      ],
    );
  } else {
    const status = newRecruitResponse.value.data;
    const ready =
      newRecruitResponse.value.ok === true && status?.available === true;
    const localAutomationBroken =
      status?.agentAvailable === false ||
      status?.protocolCompatible === false ||
      status?.installationCurrent === false ||
      status?.runtimeCompatible === false ||
      status?.browserAvailable === false ||
      status?.brokerAvailable === false;
    addResult(
      results,
      "New Recruit",
      ready ? "ready" : "error",
      ready
        ? "browser automation and the Keychain credential are ready"
        : `automation is unavailable${status?.credentialState ? `; credential state is ${status.credentialState}` : ""}`,
      ready
        ? []
        : [
            localAutomationBroken || status?.credentialsConfigured
              ? ensureCurrentNextStep
              : 'Run "npm run rosterpilot -- new-recruit configure" to securely configure the credential.',
          ],
    );
  }

  if (profile !== "tessera") return;
  const tesseraResponse = diagnosticJson(
    "Tessera status",
    runRosterPilot(["tessera", "status"], dependencies),
  );
  if (!tesseraResponse.ok) {
    addResult(
      results,
      "Tessera",
      "error",
      tesseraResponse.detail,
      [
        'Run "npm run rosterpilot -- tessera status" after repairing the local agent.',
      ],
    );
    return;
  }
  const status = tesseraResponse.value.data;
  const ready =
    tesseraResponse.value.ok === true && status?.available === true;
  const localAutomationBroken =
    status?.agentAvailable === false ||
    status?.protocolCompatible === false ||
    status?.installationCurrent === false ||
    status?.runtimeCompatible === false ||
    status?.browserAvailable === false ||
    status?.brokerAvailable === false;
  addResult(
    results,
    "Tessera",
    ready ? "ready" : "error",
    ready
      ? "browser automation and the Tessera licence key are ready"
      : `automation is unavailable${status?.credentialState ? `; credential state is ${status.credentialState}` : ""}`,
    ready
      ? []
      : [
          localAutomationBroken || status?.credentialsConfigured
            ? ensureCurrentNextStep
            : 'Run "npm run rosterpilot -- tessera configure" to securely configure the licence key.',
        ],
  );
}

async function diagnoseRemoteFreshness(options, dependencies, results) {
  if (options.refresh === "skip") {
    addResult(
      results,
      "Remote data freshness",
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
      "Remote data freshness",
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
    "Remote data freshness",
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
      "Remote data freshness",
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
