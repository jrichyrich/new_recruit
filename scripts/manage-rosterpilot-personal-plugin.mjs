import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  inspectRosterPilotSkill,
  installRosterPilotSkill,
  rosterPilotSkillHash,
} from "./manage-rosterpilot-skill.mjs";
import {
  renderLocalMcpServerConfig,
  validateNodeVersion,
} from "./setup.mjs";
import {
  inspectRosterPilotPlugin,
  syncRosterPilotPlugin,
} from "./sync-rosterpilot-plugin.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), "..");
const markerName = ".rosterpilot-personal-plugin.json";
const selector = "rosterpilot@personal";

const usage = `Usage:
  npm run plugin:local:check
  npm run plugin:local:install

Publish or verify the machine-local RosterPilot personal plugin. Installation
updates the managed skill, atomically stages the personal marketplace source,
asks Codex to rebuild its immutable plugin cache, and verifies the MCP binding.
The personal marketplace must already map rosterpilot to
./plugins/rosterpilot. The marketplace registry and Codex cache are never
edited directly. A project-local mcp_servers.rosterpilot entry is refused
because it would shadow the plugin-owned MCP server. Start a new ChatGPT/Codex
task after installation so it loads the new skill and tool snapshot.
`;

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function baseVersion(version) {
  return String(version).split("+", 1)[0];
}

function cachebuster(now = new Date()) {
  return now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 17);
}

function generatedVersion(version, options = {}) {
  const nonce =
    options.cacheNonce ??
    randomUUID().replaceAll("-", "").slice(0, 12);
  return `${baseVersion(version)}+codex.${cachebuster(options.now)}.${nonce}`;
}

function generatedManifestMatches(observed, canonical) {
  return isDeepStrictEqual(
    {
      ...observed,
      version: baseVersion(observed?.version),
    },
    {
      ...canonical,
      version: baseVersion(canonical?.version),
      mcpServers: "./.mcp.json",
    },
  );
}

function defaultNodeExecutable() {
  const homebrewNode = "/opt/homebrew/bin/node";
  return process.platform === "darwin" && existsSync(homebrewNode)
    ? homebrewNode
    : process.execPath;
}

function pathsFor(options = {}) {
  const projectRoot = path.resolve(
    options.projectRoot ?? defaultProjectRoot,
  );
  const home = path.resolve(options.home ?? os.homedir());
  const codexRoot = path.resolve(
    options.codexRoot ??
      process.env.CODEX_HOME ??
      path.join(home, ".codex"),
  );
  return {
    projectRoot,
    home,
    codexRoot,
    marketplacePath: path.resolve(
      options.marketplacePath ??
        path.join(home, ".agents", "plugins", "marketplace.json"),
    ),
    sourceRoot: path.resolve(
      options.sourceRoot ?? path.join(home, "plugins", "rosterpilot"),
    ),
    cacheRoot: path.resolve(
      options.cacheRoot ??
        path.join(
          codexRoot,
          "plugins",
          "cache",
          "personal",
          "rosterpilot",
        ),
    ),
    nodeExecutable: path.resolve(
      options.nodeExecutable ?? defaultNodeExecutable(),
    ),
    codexExecutable:
      options.codexExecutable ?? "codex",
    supportDirectory: path.resolve(
      options.supportDirectory ??
        options.environment?.ROSTERPILOT_SUPPORT_DIRECTORY ??
        process.env.ROSTERPILOT_SUPPORT_DIRECTORY ??
        path.join(
          home,
          "Library",
          "Application Support",
          "RosterPilot",
        ),
    ),
  };
}

function expectedMcp(paths, options = {}) {
  return {
    mcpServers: {
      rosterpilot: renderLocalMcpServerConfig({
        nodeExecutable: paths.nodeExecutable,
        projectRoot: paths.projectRoot,
        environment: options.environment,
        pathExists: options.pathExists,
      }),
    },
  };
}

function runCodexDefault(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: process.env,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function inheritedStringEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry) => typeof entry[1] === "string",
    ),
  );
}

async function withTimeout(promise, timeoutMs, description) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${description} timed out after ${timeoutMs} ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeMcpDefault(server, timeoutMs = 5 * 60_000) {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: {
      ...inheritedStringEnvironment(),
      ...server.env,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "rosterpilot-local-install-check",
    version: "1.0.0",
  });
  try {
    await withTimeout(
      client.connect(transport),
      timeoutMs,
      "RosterPilot MCP initialization",
    );
    const listed = await withTimeout(
      client.listTools(),
      timeoutMs,
      "RosterPilot MCP tools/list",
    );
    const names = listed.tools.map((tool) => tool.name);
    const requiredTools = ["run", "inspect", "act"];
    for (const required of requiredTools) {
      if (!names.includes(required)) {
        throw new Error(
          `RosterPilot MCP tools/list omitted required tool: ${required}`,
        );
      }
    }
    return {
      ok: true,
      toolCount: names.length,
      requiredTools,
    };
  } finally {
    await client.close().catch(async () => {
      await transport.close().catch(() => {});
    });
  }
}

async function probeMcp(paths, server, options = {}) {
  const result = options.probeMcp
    ? await options.probeMcp(server, paths)
    : await probeMcpDefault(server, options.probeTimeoutMs);
  if (result?.ok === false) {
    throw new Error(result.error ?? "RosterPilot MCP startup probe failed.");
  }
  return result ?? { ok: true };
}

async function runCodexJson(paths, args, options = {}) {
  const result = options.runCodex
    ? await options.runCodex(args, paths)
    : runCodexDefault(paths.codexExecutable, args);
  if (result.code !== 0) {
    throw new Error(
      `Codex command failed (${args.join(" ")}): ${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Codex command did not return JSON (${args.join(" ")}).`,
    );
  }
}

async function installedRegistration(paths, options = {}) {
  const listing = await runCodexJson(
    paths,
    ["plugin", "list", "--marketplace", "personal", "--json"],
    options,
  );
  return listing.installed?.find(
    (entry) => entry.pluginId === selector,
  ) ?? null;
}

async function marketplaceState(paths) {
  try {
    const marketplace = await readJson(paths.marketplacePath);
    const entry = marketplace.plugins?.find(
      (candidate) => candidate?.name === "rosterpilot",
    );
    const valid =
      marketplace.name === "personal" &&
      entry?.source?.source === "local" &&
      entry?.source?.path === "./plugins/rosterpilot";
    return { valid, marketplace, entry };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const rosterPilotMcpSection =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:rosterpilot|"rosterpilot"|'rosterpilot')\s*\]\s*(?:#.*)?$/m;
const rosterPilotMcpDottedAssignment =
  /^\s*mcp_servers\s*\.\s*(?:rosterpilot|"rosterpilot"|'rosterpilot')\s*=/m;
const mcpServersTable = /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/m;
const rosterPilotTableAssignment =
  /^\s*(?:rosterpilot|"rosterpilot"|'rosterpilot')\s*=/m;

function hasProjectMcpShadow(content) {
  if (
    rosterPilotMcpSection.test(content) ||
    rosterPilotMcpDottedAssignment.test(content)
  ) {
    return true;
  }
  const table = mcpServersTable.exec(content);
  if (!table) return false;
  const remainder = content.slice(table.index + table[0].length);
  const nextTable = remainder.search(/^\s*\[/m);
  const tableBody = nextTable === -1
    ? remainder
    : remainder.slice(0, nextTable);
  return rosterPilotTableAssignment.test(tableBody);
}

async function projectMcpShadowState(paths) {
  const configPath = path.join(
    paths.projectRoot,
    ".codex",
    "config.toml",
  );
  if (!(await exists(configPath))) {
    return { status: "absent", configPath };
  }
  try {
    const content = await readFile(configPath, "utf8");
    return {
      status: hasProjectMcpShadow(content)
        ? "shadowing"
        : "clear",
      configPath,
    };
  } catch (error) {
    return {
      status: "invalid",
      configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sourceState(paths, canonicalHash, packageVersion, options = {}) {
  if (!(await exists(paths.sourceRoot))) {
    return { status: "missing" };
  }
  try {
    const manifest = await readJson(
      path.join(paths.sourceRoot, ".codex-plugin", "plugin.json"),
    );
    const canonicalManifest = await readJson(
      path.join(
        paths.projectRoot,
        "plugins",
        "rosterpilot",
        ".codex-plugin",
        "plugin.json",
      ),
    );
    const mcp = await readJson(path.join(paths.sourceRoot, ".mcp.json"));
    const skillHash = await rosterPilotSkillHash(
      path.join(paths.sourceRoot, "skills", "rosterpilot"),
    );
    const expected = expectedMcp(paths, options);
    const manifestMatches = generatedManifestMatches(
      manifest,
      canonicalManifest,
    );
    return {
      status:
        manifestMatches &&
        baseVersion(manifest.version) === baseVersion(packageVersion) &&
        skillHash === canonicalHash &&
        isDeepStrictEqual(mcp, expected)
          ? "current"
          : "stale",
      manifest,
      manifestMatches,
      mcp,
      skillHash,
      expectedMcp: expected,
    };
  } catch (error) {
    return {
      status: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function cacheState(paths, source, canonicalHash) {
  if (source.status === "missing" || !source.manifest?.version) {
    return { status: "missing", versions: [] };
  }
  const versions = (await readdir(paths.cacheRoot, { withFileTypes: true })
    .catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const cacheDirectory = path.join(
    paths.cacheRoot,
    source.manifest.version,
  );
  if (!(await exists(cacheDirectory))) {
    return { status: "missing", versions, cacheDirectory };
  }
  try {
    const manifest = await readJson(
      path.join(cacheDirectory, ".codex-plugin", "plugin.json"),
    );
    const mcp = await readJson(path.join(cacheDirectory, ".mcp.json"));
    const skillHash = await rosterPilotSkillHash(
      path.join(cacheDirectory, "skills", "rosterpilot"),
    );
    return {
      status:
        isDeepStrictEqual(manifest, source.manifest) &&
        isDeepStrictEqual(mcp, source.mcp) &&
        skillHash === canonicalHash
          ? "current"
          : "stale",
      versions,
      cacheDirectory,
      manifest,
      mcp,
      skillHash,
    };
  } catch (error) {
    return {
      status: "invalid",
      versions,
      cacheDirectory,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runtimeMcpMatches(observed, expected) {
  const transport = observed?.transport;
  const server = expected.mcpServers.rosterpilot;
  return (
    observed?.name === "rosterpilot" &&
    observed?.enabled === true &&
    transport?.type === "stdio" &&
    transport.command === server.command &&
    isDeepStrictEqual(transport.args, server.args) &&
    isDeepStrictEqual(transport.env, server.env) &&
    transport.cwd === server.cwd
  );
}

function runReadinessCommandDefault(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  return {
    code: result.status ?? 1,
    error: result.error?.message ?? null,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function commandReadiness(label, result) {
  const detail = [result.error, result.stderr?.trim()]
    .filter(Boolean)
    .join(" ");
  return result.code === 0 && !result.error
    ? {
        status: "ready",
        detail: `${label} ${result.stdout.trim()}`.trim(),
      }
    : {
        status: "needs-attention",
        detail: `${label} is unavailable${detail ? `: ${detail}` : ""}`,
      };
}

async function probeSupportStorageDefault(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const probe = path.join(
    directory,
    `.rosterpilot-write-check-${process.pid}-${randomUUID()}`,
  );
  try {
    await writeFile(probe, "RosterPilot writable-storage check.\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    await rm(probe, { force: true });
  }
}

async function checkUpstreamConnectivityDefault(options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    return {
      status: "warning",
      detail: "network checks are unavailable in this Node runtime",
      sources: [],
    };
  }
  const endpoints = [
    {
      name: "40kdc npm data",
      url: "https://registry.npmjs.org/@alpaca-software%2F40kdc-data/latest",
    },
    {
      name: "BSData",
      url: "https://github.com/BSData/wh40k-11e",
    },
    {
      name: "Games Workshop",
      url: "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
    },
  ];
  const timeoutMs = options.upstreamTimeoutMs ?? 3_000;
  const sources = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const response = await fetcher(endpoint.url, {
          headers: {
            accept: "text/html,application/json;q=0.9,*/*;q=0.8",
            "user-agent": "RosterPilot-local-readiness/1",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return {
          name: endpoint.name,
          status: response.ok ? "ready" : "warning",
          detail: `HTTP ${response.status}`,
        };
      } catch (error) {
        return {
          name: endpoint.name,
          status: "warning",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const available = sources.filter(
    (source) => source.status === "ready",
  ).length;
  return {
    status: available === sources.length ? "ready" : "warning",
    detail:
      available === sources.length
        ? "all allowlisted upstream sources are reachable"
        : `${available} of ${sources.length} allowlisted upstream sources are reachable; existing roster data remains usable`,
    sources,
  };
}

async function dataUpdateReadiness(paths, options = {}) {
  const updaterPresent = await exists(
    path.join(
      paths.projectRoot,
      "local",
      "data-bundles",
      "local-source-updater.ts",
    ),
  );
  const runReadinessCommand =
    options.runReadinessCommand ?? runReadinessCommandDefault;
  const nodeResult = await runReadinessCommand(
    paths.nodeExecutable,
    ["--version"],
  );
  const parsedNode = validateNodeVersion(nodeResult.stdout?.trim() ?? "");
  const node =
    nodeResult.code === 0 && !nodeResult.error && parsedNode.supported
      ? { status: "ready", detail: parsedNode.message }
      : {
          status: "needs-attention",
          detail:
            nodeResult.code === 0 && !nodeResult.error
              ? parsedNode.message
              : commandReadiness("Node", nodeResult).detail,
        };
  const npm = commandReadiness(
    "npm",
    await runReadinessCommand(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["--version"],
    ),
  );
  const git = commandReadiness(
    "Git",
    await runReadinessCommand("git", ["--version"]),
  );
  let supportStorage;
  try {
    if (options.probeSupportStorage) {
      await options.probeSupportStorage(paths.supportDirectory, paths);
    } else {
      await probeSupportStorageDefault(paths.supportDirectory);
    }
    supportStorage = {
      status: "ready",
      detail: `${paths.supportDirectory} is writable`,
    };
  } catch (error) {
    supportStorage = {
      status: "needs-attention",
      detail: `${paths.supportDirectory} is not writable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const upstreamConnectivity = options.checkUpstreamConnectivity
    ? await options.checkUpstreamConnectivity(paths)
    : await checkUpstreamConnectivityDefault(options);
  const localPrerequisitesReady = [
    node,
    npm,
    git,
    supportStorage,
  ].every((check) => check.status === "ready");
  const status = !updaterPresent
    ? "updater-missing"
    : !localPrerequisitesReady
      ? "needs-attention"
      : upstreamConnectivity.status === "ready"
        ? "ready"
        : "offline-ready";
  return {
    status,
    providerMode: "local-source",
    signingRequired: false,
    localRosterUsable: true,
    updaterPresent,
    checks: {
      node,
      npm,
      git,
      supportStorage,
      upstreamConnectivity,
    },
    nextAction:
      status === "ready"
        ? "Start a new Codex task after installation. RosterPilot will check allowlisted upstream sources in the background when the daily check is due."
        : status === "offline-ready"
          ? "Roster building works from the current snapshot. Reconnect later and the daily background check will retry automatically."
          : status === "updater-missing"
            ? "Update this checkout and reinstall the plugin. Roster building remains usable with compiled data until the local updater is present."
            : "Roster building remains usable with compiled data. Fix the checks marked needs-attention, then rerun npm run plugin:local:check.",
  };
}

export async function inspectPersonalRosterPilotPlugin(options = {}) {
  const paths = pathsFor(options);
  const repository = await inspectRosterPilotPlugin(paths.projectRoot);
  const managedSkill = await inspectRosterPilotSkill({
    projectRoot: paths.projectRoot,
    codexRoot: paths.codexRoot,
  });
  const marketplace = await marketplaceState(paths);
  const projectMcpShadow = await projectMcpShadowState(paths);
  const updateReadiness = await dataUpdateReadiness(paths, options);
  const source = await sourceState(
    paths,
    repository.sourceHash,
    repository.packageVersion,
    options,
  );
  const cache = await cacheState(paths, source, repository.sourceHash);
  let installed = null;
  let runtimeMcp = null;
  let runtimeProbe = null;
  const issues = [];
  try {
    installed = await installedRegistration(paths, options);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (source.expectedMcp) {
    try {
      runtimeProbe = await probeMcp(
        paths,
        source.expectedMcp.mcpServers.rosterpilot,
        options,
      );
    } catch (error) {
      issues.push(
        `RosterPilot MCP startup probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  try {
    runtimeMcp = await runCodexJson(
      paths,
      ["mcp", "get", "rosterpilot", "--json"],
      options,
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  if (repository.status !== "current") issues.push("repository plugin is stale");
  if (managedSkill.status !== "current") issues.push("managed skill is stale");
  if (!marketplace.valid) issues.push("personal marketplace entry is invalid");
  if (projectMcpShadow.status === "shadowing") {
    issues.push(
      `project-local MCP configuration shadows the personal plugin: ${projectMcpShadow.configPath}`,
    );
  } else if (projectMcpShadow.status === "invalid") {
    issues.push(
      `project-local Codex configuration could not be inspected: ${projectMcpShadow.configPath}`,
    );
  }
  if (source.status !== "current") issues.push("personal plugin source is stale");
  if (cache.status !== "current") issues.push("installed plugin cache is stale");
  if (
    !installed ||
    installed.version !== source.manifest?.version ||
    path.resolve(installed.source?.path ?? "") !== paths.sourceRoot ||
    installed.enabled !== true
  ) {
    issues.push("Codex plugin registration is stale");
  }
  if (
    !runtimeMcpMatches(
      runtimeMcp,
      source.expectedMcp ?? expectedMcp(paths, options),
    )
  ) {
    issues.push("Codex MCP registration is stale");
  }
  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? "current" : "stale",
    paths,
    repository,
    managedSkill,
    marketplace,
    projectMcpShadow,
    source,
    cache,
    installed,
    runtimeMcp,
    runtimeProbe,
    updateReadiness,
    issues,
  };
}

async function safeToAdopt(paths, canonicalHash) {
  if (!(await exists(paths.sourceRoot))) return true;
  try {
    const marker = await readJson(path.join(paths.sourceRoot, markerName));
    if (marker.managedBy === "rosterpilot-personal-plugin") return true;
  } catch {
    // A legacy source may be adopted only after exact identity checks below.
  }
  try {
    const manifest = await readJson(
      path.join(paths.sourceRoot, ".codex-plugin", "plugin.json"),
    );
    const mcp = await readJson(path.join(paths.sourceRoot, ".mcp.json"));
    const skillHash = await rosterPilotSkillHash(
      path.join(paths.sourceRoot, "skills", "rosterpilot"),
    );
    const server = mcp?.mcpServers?.rosterpilot;
    return (
      manifest.name === "rosterpilot" &&
      manifest.mcpServers === "./.mcp.json" &&
      skillHash === canonicalHash &&
      path.resolve(server?.cwd ?? "") === paths.projectRoot &&
      path.resolve(server?.args?.at(-1) ?? "") ===
        path.join(paths.projectRoot, "mcp", "stdio.ts")
    );
  } catch {
    return false;
  }
}

export async function installPersonalRosterPilotPlugin(options = {}) {
  const paths = pathsFor(options);
  const projectMcpShadow = await projectMcpShadowState(paths);
  if (projectMcpShadow.status === "shadowing") {
    throw new Error(
      `Refusing to install while a project-local mcp_servers.rosterpilot entry shadows the personal plugin: ${projectMcpShadow.configPath}`,
    );
  }
  if (projectMcpShadow.status === "invalid") {
    throw new Error(
      `Cannot inspect the project-local Codex configuration before installation: ${projectMcpShadow.configPath}`,
    );
  }
  const synchronized = await syncRosterPilotPlugin(paths.projectRoot);
  if (!(await marketplaceState(paths)).valid) {
    throw new Error(
      `The personal marketplace does not map rosterpilot to ./plugins/rosterpilot: ${paths.marketplacePath}`,
    );
  }
  if (!(await safeToAdopt(paths, synchronized.sourceHash))) {
    throw new Error(
      `Refusing to replace an unmanaged or mismatched personal plugin source: ${paths.sourceRoot}`,
    );
  }
  try {
    await access(paths.nodeExecutable, constants.X_OK);
  } catch {
    throw new Error(
      `Required local plugin runtime path is not executable: ${paths.nodeExecutable}`,
    );
  }
  for (const required of [
    path.join(
      paths.projectRoot,
      "node_modules",
      "tsx",
      "dist",
      "loader.mjs",
    ),
    path.join(paths.projectRoot, "mcp", "stdio.ts"),
    path.join(
      paths.projectRoot,
      "dist",
      "workers",
      "tessera-job-worker.mjs",
    ),
    path.join(
      paths.projectRoot,
      "dist",
      "workers",
      "tessera-job-worker.receipt.json",
    ),
  ]) {
    if (!(await exists(required))) {
      throw new Error(`Required local plugin runtime path is missing: ${required}`);
    }
  }

  const priorRegistration = await installedRegistration(paths, options);
  const sourcePackage = path.join(
    paths.projectRoot,
    "plugins",
    "rosterpilot",
  );
  const parent = path.dirname(paths.sourceRoot);
  const staged = `${paths.sourceRoot}.installing-${process.pid}`;
  const sourceBackup = `${paths.sourceRoot}.previous-${process.pid}`;
  const registrationBackup =
    `${paths.sourceRoot}.registered-${process.pid}`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await rm(staged, { recursive: true, force: true });
  await rm(sourceBackup, { recursive: true, force: true });
  await rm(registrationBackup, { recursive: true, force: true });
  await cp(sourcePackage, staged, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const manifestPath = path.join(staged, ".codex-plugin", "plugin.json");
  const manifest = await readJson(manifestPath);
  manifest.version = generatedVersion(manifest.version, options);
  manifest.mcpServers = "./.mcp.json";
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(staged, ".mcp.json"),
    `${JSON.stringify(expectedMcp(paths, options), null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(staged, markerName),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        managedBy: "rosterpilot-personal-plugin",
        projectRoot: paths.projectRoot,
        sourceHash: synchronized.sourceHash,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const stagedHash = await rosterPilotSkillHash(
    path.join(staged, "skills", "rosterpilot"),
  );
  if (stagedHash !== synchronized.sourceHash) {
    await rm(staged, { recursive: true, force: true });
    throw new Error("Staged personal plugin skill does not match its source.");
  }

  if (priorRegistration) {
    const priorCache = path.join(
      paths.cacheRoot,
      priorRegistration.version,
    );
    try {
      const cachedManifest = await readJson(
        path.join(priorCache, ".codex-plugin", "plugin.json"),
      );
      if (
        cachedManifest.name !== "rosterpilot" ||
        cachedManifest.version !== priorRegistration.version
      ) {
        throw new Error("registered cache manifest identity does not match");
      }
      await cp(priorCache, registrationBackup, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      await rm(registrationBackup, { recursive: true, force: true });
      throw new Error(
        `Cannot snapshot the currently registered RosterPilot cache before publication: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const previousManagedSkill = await inspectRosterPilotSkill({
    projectRoot: paths.projectRoot,
    codexRoot: paths.codexRoot,
  });
  if (previousManagedSkill.status === "unmanaged") {
    await rm(staged, { recursive: true, force: true });
    await rm(registrationBackup, { recursive: true, force: true });
    throw new Error(
      `Refusing to replace unmanaged skill directory: ${previousManagedSkill.target}.`,
    );
  }
  const managedSkillBackup =
    `${previousManagedSkill.target}.personal-plugin-previous-${process.pid}`;
  await rm(managedSkillBackup, { recursive: true, force: true });
  const managedSkillExisted = previousManagedSkill.status !== "missing";
  try {
    if (managedSkillExisted) {
      await cp(previousManagedSkill.target, managedSkillBackup, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    await rm(registrationBackup, { recursive: true, force: true });
    await rm(managedSkillBackup, { recursive: true, force: true });
    throw error;
  }
  try {
    await installRosterPilotSkill({
      projectRoot: paths.projectRoot,
      codexRoot: paths.codexRoot,
    });
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    await rm(registrationBackup, { recursive: true, force: true });
    await rm(managedSkillBackup, { recursive: true, force: true });
    throw error;
  }

  const targetExists = await exists(paths.sourceRoot);
  let sourceMoved = false;
  let sourcePublished = false;
  let registrationTouched = false;
  try {
    if (targetExists) {
      await rename(paths.sourceRoot, sourceBackup);
      sourceMoved = true;
    }
    await rename(staged, paths.sourceRoot);
    sourcePublished = true;
    await probeMcp(
      paths,
      expectedMcp(paths, options).mcpServers.rosterpilot,
      options,
    );
    registrationTouched = true;
    await runCodexJson(
      paths,
      ["plugin", "add", selector, "--json"],
      options,
    );
    const inspected = await inspectPersonalRosterPilotPlugin(options);
    if (!inspected.ok) {
      throw new Error(
        `The personal plugin reinstall did not verify: ${inspected.issues.join("; ")}`,
      );
    }
    await rm(sourceBackup, { recursive: true, force: true });
    await rm(registrationBackup, { recursive: true, force: true });
    await rm(managedSkillBackup, { recursive: true, force: true });
    return {
      ...inspected,
      action: targetExists ? "updated" : "installed",
    };
  } catch (error) {
    const rollbackErrors = [];
    let preserveRegistrationBackup = false;
    if (sourcePublished) {
      await rm(paths.sourceRoot, { recursive: true, force: true });
    }
    if (registrationTouched && priorRegistration) {
      try {
        await cp(registrationBackup, paths.sourceRoot, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        await runCodexJson(
          paths,
          ["plugin", "add", selector, "--json"],
          options,
        );
      } catch (candidate) {
        preserveRegistrationBackup = true;
        rollbackErrors.push(
          `Codex registration: ${
            candidate instanceof Error
              ? candidate.message
              : String(candidate)
          }. Recovery copy retained at ${registrationBackup}`,
        );
      } finally {
        await rm(paths.sourceRoot, { recursive: true, force: true });
      }
    }
    try {
      if (sourceMoved) await rename(sourceBackup, paths.sourceRoot);
      else await rm(sourceBackup, { recursive: true, force: true });
    } catch (candidate) {
      rollbackErrors.push(
        `personal source: ${
          candidate instanceof Error ? candidate.message : String(candidate)
        }`,
      );
    }
    if (registrationTouched && !priorRegistration) {
      try {
        if (await installedRegistration(paths, options)) {
          await runCodexJson(
            paths,
            ["plugin", "remove", selector, "--json"],
            options,
          );
        }
      } catch (candidate) {
        rollbackErrors.push(
          `Codex registration: ${
            candidate instanceof Error
              ? candidate.message
              : String(candidate)
          }`,
        );
      }
    }
    try {
      await rm(previousManagedSkill.target, {
        recursive: true,
        force: true,
      });
      if (managedSkillExisted) {
        await rename(managedSkillBackup, previousManagedSkill.target);
      } else {
        await rm(managedSkillBackup, { recursive: true, force: true });
      }
    } catch (candidate) {
      rollbackErrors.push(
        `managed skill: ${
          candidate instanceof Error ? candidate.message : String(candidate)
        }`,
      );
    }
    if (!preserveRegistrationBackup) {
      await rm(registrationBackup, { recursive: true, force: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${message} Rollback was incomplete: ${rollbackErrors.join("; ")}`,
      );
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage);
    return;
  }
  const check = argv.length === 1 && argv[0] === "--check";
  if (argv.length > 0 && !check) {
    throw new Error(`Unknown personal-plugin option: ${argv[0]}`);
  }
  const result = check
    ? await inspectPersonalRosterPilotPlugin()
    : await installPersonalRosterPilotPlugin();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (check && !result.ok) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
