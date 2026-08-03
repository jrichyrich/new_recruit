import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectPersonalRosterPilotPlugin,
  installPersonalRosterPilotPlugin,
} from "../scripts/manage-rosterpilot-personal-plugin.mjs";

async function fixture(options: {
  marketplacePath?: string;
  supportStorageWritable?: boolean;
  upstreamReachable?: boolean;
} = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-personal-plugin-"),
  );
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const codexRoot = path.join(root, "codex");
  const sourceRoot = path.join(home, "plugins", "rosterpilot");
  const cacheRoot = path.join(
    codexRoot,
    "plugins",
    "cache",
    "personal",
    "rosterpilot",
  );
  const nodeExecutable = path.join(root, "bin", "node");
  const canonicalSkill = path.join(
    projectRoot,
    "skills",
    "rosterpilot",
  );
  const packagedSkill = path.join(
    projectRoot,
    "plugins",
    "rosterpilot",
    "skills",
    "rosterpilot",
  );
  await mkdir(canonicalSkill, { recursive: true });
  await mkdir(packagedSkill, { recursive: true });
  await mkdir(path.dirname(nodeExecutable), { recursive: true });
  await mkdir(
    path.join(projectRoot, "node_modules", "tsx", "dist"),
    { recursive: true },
  );
  await mkdir(path.join(projectRoot, "mcp"), { recursive: true });
  await mkdir(
    path.join(projectRoot, "local", "data-bundles"),
    { recursive: true },
  );
  await mkdir(path.join(home, ".agents", "plugins"), {
    recursive: true,
  });
  await writeFile(
    path.join(projectRoot, "package.json"),
    '{"name":"rosterpilot","version":"9.8.7"}\n',
  );
  const skill = "# RosterPilot fixture\n\nCanonical instructions.\n";
  await writeFile(path.join(canonicalSkill, "SKILL.md"), skill);
  await writeFile(path.join(packagedSkill, "SKILL.md"), skill);
  await mkdir(
    path.join(projectRoot, "plugins", "rosterpilot", ".codex-plugin"),
    { recursive: true },
  );
  await writeFile(
    path.join(
      projectRoot,
      "plugins",
      "rosterpilot",
      ".codex-plugin",
      "plugin.json",
    ),
    `${JSON.stringify({
      name: "rosterpilot",
      version: "9.8.7",
      description: "fixture",
      author: { name: "RosterPilot" },
      skills: "./skills/",
      interface: {
        displayName: "RosterPilot",
        shortDescription: "fixture",
        longDescription: "fixture",
        developerName: "RosterPilot",
        category: "Games",
        capabilities: ["Interactive"],
        defaultPrompt: ["Build a roster."],
      },
    }, null, 2)}\n`,
  );
  await writeFile(nodeExecutable, "fixture\n");
  await chmod(nodeExecutable, 0o700);
  await writeFile(
    path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs"),
    "",
  );
  await writeFile(path.join(projectRoot, "mcp", "stdio.ts"), "");
  await writeFile(
    path.join(
      projectRoot,
      "local",
      "data-bundles",
      "local-source-updater.ts",
    ),
    "export const localSourceUpdaterFixture = true;\n",
  );
  await writeFile(
    path.join(home, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify({
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [
        {
          name: "rosterpilot",
          source: {
            source: "local",
            path: options.marketplacePath ?? "./plugins/rosterpilot",
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Games",
        },
      ],
    }, null, 2)}\n`,
  );

  let installedVersion: string | null = null;
  const runCodex = async (args: string[]) => {
    if (args[0] === "plugin" && args[1] === "add") {
      const manifest = JSON.parse(
        await readFile(
          path.join(sourceRoot, ".codex-plugin", "plugin.json"),
          "utf8",
        ),
      ) as { version: string };
      installedVersion = manifest.version;
      await rm(cacheRoot, { recursive: true, force: true });
      await mkdir(cacheRoot, { recursive: true });
      await cp(sourceRoot, path.join(cacheRoot, installedVersion), {
        recursive: true,
      });
      return {
        code: 0,
        stdout: JSON.stringify({
          pluginId: "rosterpilot@personal",
          version: installedVersion,
        }),
        stderr: "",
      };
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return {
        code: 0,
        stdout: JSON.stringify({
          installed: installedVersion
            ? [
                {
                  pluginId: "rosterpilot@personal",
                  name: "rosterpilot",
                  marketplaceName: "personal",
                  version: installedVersion,
                  installed: true,
                  enabled: true,
                  source: { source: "local", path: sourceRoot },
                },
              ]
            : [],
          available: [],
        }),
        stderr: "",
      };
    }
    if (args[0] === "plugin" && args[1] === "remove") {
      installedVersion = null;
      await rm(cacheRoot, { recursive: true, force: true });
      return {
        code: 0,
        stdout: JSON.stringify({ removed: true }),
        stderr: "",
      };
    }
    if (args[0] === "mcp" && args[1] === "get" && installedVersion) {
      const mcp = JSON.parse(
        await readFile(path.join(sourceRoot, ".mcp.json"), "utf8"),
      ) as {
        mcpServers: { rosterpilot: Record<string, unknown> };
      };
      return {
        code: 0,
        stdout: JSON.stringify({
          name: "rosterpilot",
          enabled: true,
          transport: {
            type: "stdio",
            ...mcp.mcpServers.rosterpilot,
            env_vars: [],
          },
        }),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
  };
  const probeMcp = async () => ({
    ok: true,
    toolCount: 2,
    requiredTools: [
      "build_roster",
      "get_data_status",
      "repair_tessera_web_compatibility",
    ],
  });
  const runReadinessCommand = async (
    command: string,
    args: string[],
  ) => {
    if (command === nodeExecutable && args[0] === "--version") {
      return { code: 0, error: null, stdout: "v22.13.0\n", stderr: "" };
    }
    if (command === "npm" && args[0] === "--version") {
      return { code: 0, error: null, stdout: "10.9.2\n", stderr: "" };
    }
    if (command === "git" && args[0] === "--version") {
      return {
        code: 0,
        error: null,
        stdout: "git version 2.50.0\n",
        stderr: "",
      };
    }
    return { code: 1, error: null, stdout: "", stderr: "unexpected command" };
  };
  const probeSupportStorage = async () => {
    if (options.supportStorageWritable === false) {
      throw new Error("permission denied");
    }
  };
  const checkUpstreamConnectivity = async () => ({
    status: options.upstreamReachable === false ? "warning" : "ready",
    detail:
      options.upstreamReachable === false
        ? "0 of 3 allowlisted upstream sources are reachable; existing roster data remains usable"
        : "all allowlisted upstream sources are reachable",
    sources: [],
  });
  return {
    root,
    projectRoot,
    home,
    codexRoot,
    sourceRoot,
    cacheRoot,
    nodeExecutable,
    runCodex,
    probeMcp,
    runReadinessCommand,
    probeSupportStorage,
    checkUpstreamConnectivity,
    installedVersion: () => installedVersion,
  };
}

test("personal plugin install aligns source, cache, skill, and MCP", async () => {
  const found = await fixture();
  try {
    const options = {
      ...found,
      now: new Date("2026-08-02T02:30:45Z"),
      cacheNonce: "fixture",
      environment: {},
    };
    const installed = await installPersonalRosterPilotPlugin(options);
    assert.equal(installed.ok, true);
    assert.equal(installed.status, "current");
    assert.equal(installed.action, "installed");
    assert.equal(
      installed.source.manifest.version,
      "9.8.7+codex.20260802023045000.fixture",
    );
    assert.equal(
      installed.source.mcp.mcpServers.rosterpilot.env
        .ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY,
      undefined,
    );
    assert.equal(
      installed.source.mcp.mcpServers.rosterpilot.env
        .ROSTERPILOT_DATA_PROVIDER_MODE,
      "local-source",
    );
    assert.equal(
      installed.source.mcp.mcpServers.rosterpilot.env
        .ROSTERPILOT_DATA_CHANNEL_URL,
      undefined,
    );
    assert.equal(
      installed.source.mcp.mcpServers.rosterpilot.env
        .ROSTERPILOT_DATA_TRUSTED_KEYS_FILE,
      undefined,
    );
    assert.equal(installed.updateReadiness.status, "ready");
    assert.equal(installed.updateReadiness.providerMode, "local-source");
    assert.equal(installed.updateReadiness.signingRequired, false);
    assert.equal(installed.updateReadiness.localRosterUsable, true);
    assert.equal(installed.updateReadiness.updaterPresent, true);
    assert.equal(installed.updateReadiness.checks.node.status, "ready");
    assert.equal(installed.updateReadiness.checks.npm.status, "ready");
    assert.equal(installed.updateReadiness.checks.git.status, "ready");
    assert.equal(
      installed.updateReadiness.checks.supportStorage.status,
      "ready",
    );
    assert.equal(
      installed.updateReadiness.checks.upstreamConnectivity.status,
      "ready",
    );
    assert.equal(installed.cache.skillHash, installed.repository.sourceHash);
    assert.equal(installed.managedSkill.status, "current");

    const checked = await inspectPersonalRosterPilotPlugin(options);
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.issues, []);
    assert.equal(checked.updateReadiness.status, "ready");
    assert.equal(checked.updateReadiness.signingRequired, false);

    const manifestPath = path.join(
      found.sourceRoot,
      ".codex-plugin",
      "plugin.json",
    );
    const alteredManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as {
      interface: { shortDescription: string };
    };
    alteredManifest.interface.shortDescription = "altered fixture";
    await writeFile(
      manifestPath,
      `${JSON.stringify(alteredManifest, null, 2)}\n`,
    );
    const drifted = await inspectPersonalRosterPilotPlugin(options);
    assert.equal(drifted.ok, false);
    assert.equal(drifted.source.manifestMatches, false);
    assert.match(drifted.issues.join("; "), /personal plugin source is stale/);
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("temporary upstream outages do not invalidate the installed plugin", async () => {
  const found = await fixture({ upstreamReachable: false });
  try {
    const installed = await installPersonalRosterPilotPlugin({
      ...found,
      now: new Date("2026-08-02T02:30:45Z"),
      cacheNonce: "offline",
      environment: {},
    });
    assert.equal(installed.ok, true);
    assert.equal(installed.updateReadiness.status, "offline-ready");
    assert.equal(installed.updateReadiness.localRosterUsable, true);
    assert.equal(
      installed.updateReadiness.checks.upstreamConnectivity.status,
      "warning",
    );
    assert.match(
      installed.updateReadiness.nextAction,
      /Reconnect later.*retry automatically/,
    );
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("plugin readiness identifies unwritable local snapshot storage", async () => {
  const found = await fixture({ supportStorageWritable: false });
  try {
    const installed = await installPersonalRosterPilotPlugin({
      ...found,
      now: new Date("2026-08-02T02:30:45Z"),
      cacheNonce: "storage",
      environment: {},
    });
    assert.equal(installed.ok, true);
    assert.equal(installed.updateReadiness.status, "needs-attention");
    assert.equal(installed.updateReadiness.localRosterUsable, true);
    assert.equal(
      installed.updateReadiness.checks.supportStorage.status,
      "needs-attention",
    );
    assert.match(
      installed.updateReadiness.nextAction,
      /compiled data.*checks marked needs-attention/,
    );
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("personal plugin install refuses a mismatched marketplace mapping", async () => {
  const found = await fixture({ marketplacePath: "./plugins/not-rosterpilot" });
  try {
    await assert.rejects(
      installPersonalRosterPilotPlugin({
        ...found,
        now: new Date("2026-08-02T02:30:45Z"),
        cacheNonce: "fixture",
        environment: {},
      }),
      /personal marketplace does not map rosterpilot/,
    );
    await assert.rejects(readFile(path.join(found.sourceRoot, ".mcp.json")));
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("personal plugin reports and refuses a project-local MCP shadow", async () => {
  const found = await fixture();
  try {
    const configDirectory = path.join(found.projectRoot, ".codex");
    const configPath = path.join(configDirectory, "config.toml");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      configPath,
      '[mcp_servers.rosterpilot]\ncommand = "/old/node"\n',
    );
    const options = {
      ...found,
      now: new Date("2026-08-02T02:30:45Z"),
      cacheNonce: "fixture",
      environment: {},
    };
    const inspected = await inspectPersonalRosterPilotPlugin(options);
    assert.equal(inspected.projectMcpShadow.status, "shadowing");
    assert.match(
      inspected.issues.join("; "),
      /project-local MCP configuration shadows the personal plugin/,
    );
    await assert.rejects(
      installPersonalRosterPilotPlugin(options),
      /project-local mcp_servers\.rosterpilot entry shadows the personal plugin/,
    );
    await assert.rejects(readFile(path.join(found.sourceRoot, ".mcp.json")));
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("personal plugin install rejects a non-executable MCP runtime", async () => {
  const found = await fixture();
  try {
    await chmod(found.nodeExecutable, 0o600);
    await assert.rejects(
      installPersonalRosterPilotPlugin({
        ...found,
        now: new Date("2026-08-02T02:30:45Z"),
        cacheNonce: "fixture",
        environment: {},
      }),
      /runtime path is not executable/,
    );
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("personal plugin install restores the previous source and registration on failure", async () => {
  const found = await fixture();
  try {
    const firstOptions = {
      ...found,
      now: new Date("2026-08-02T02:30:45Z"),
      cacheNonce: "first",
      environment: {},
    };
    const first = await installPersonalRosterPilotPlugin(firstOptions);
    const firstVersion = first.source.manifest.version;
    let failNextAdd = true;
    const runCodex = async (args: string[]) => {
      if (
        failNextAdd &&
        args[0] === "plugin" &&
        args[1] === "add"
      ) {
        failNextAdd = false;
        return { code: 1, stdout: "", stderr: "injected add failure" };
      }
      return found.runCodex(args);
    };
    await assert.rejects(
      installPersonalRosterPilotPlugin({
        ...found,
        runCodex,
        now: new Date("2026-08-02T02:30:46Z"),
        cacheNonce: "second",
        environment: {},
      }),
      /injected add failure/,
    );
    const restoredManifest = JSON.parse(
      await readFile(
        path.join(
          found.sourceRoot,
          ".codex-plugin",
          "plugin.json",
        ),
        "utf8",
      ),
    ) as { version: string };
    assert.equal(restoredManifest.version, firstVersion);
    const checked = await inspectPersonalRosterPilotPlugin(firstOptions);
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.issues, []);
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("rollback preserves a prior registration when its marketplace source was missing", async () => {
  const found = await fixture();
  try {
    const first = await installPersonalRosterPilotPlugin({
      ...found,
      now: new Date("2026-08-02T02:30:45Z"),
      cacheNonce: "first",
      environment: {},
    });
    const firstVersion = first.source.manifest.version;
    await rm(found.sourceRoot, { recursive: true, force: true });
    let failNextAdd = true;
    const runCodex = async (args: string[]) => {
      if (
        failNextAdd &&
        args[0] === "plugin" &&
        args[1] === "add"
      ) {
        failNextAdd = false;
        return { code: 1, stdout: "", stderr: "injected add failure" };
      }
      return found.runCodex(args);
    };
    await assert.rejects(
      installPersonalRosterPilotPlugin({
        ...found,
        runCodex,
        now: new Date("2026-08-02T02:30:46Z"),
        cacheNonce: "second",
        environment: {},
      }),
      /injected add failure/,
    );
    assert.equal(found.installedVersion(), firstVersion);
    await assert.rejects(readFile(path.join(found.sourceRoot, ".mcp.json")));
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("rollback restores the previous standalone skill after publication fails", async () => {
  const found = await fixture();
  try {
    await installPersonalRosterPilotPlugin({
      ...found,
      now: new Date("2026-08-02T02:30:45Z"),
      cacheNonce: "first",
      environment: {},
    });
    const managedSkillPath = path.join(
      found.codexRoot,
      "skills",
      "rosterpilot",
      "SKILL.md",
    );
    const originalSkill = await readFile(managedSkillPath, "utf8");
    await writeFile(
      path.join(found.projectRoot, "skills", "rosterpilot", "SKILL.md"),
      "# Changed fixture\n\nNew canonical instructions.\n",
    );
    let failNextAdd = true;
    const runCodex = async (args: string[]) => {
      if (
        failNextAdd &&
        args[0] === "plugin" &&
        args[1] === "add"
      ) {
        failNextAdd = false;
        return { code: 1, stdout: "", stderr: "injected add failure" };
      }
      return found.runCodex(args);
    };
    await assert.rejects(
      installPersonalRosterPilotPlugin({
        ...found,
        runCodex,
        now: new Date("2026-08-02T02:30:46Z"),
        cacheNonce: "second",
        environment: {},
      }),
      /injected add failure/,
    );
    assert.equal(await readFile(managedSkillPath, "utf8"), originalSkill);
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("failed registration rollback retains its verified recovery copy", async () => {
  const found = await fixture();
  try {
    await installPersonalRosterPilotPlugin({
      ...found,
      now: new Date("2026-08-02T02:30:45Z"),
      cacheNonce: "first",
      environment: {},
    });
    const runCodex = async (args: string[]) => {
      if (args[0] === "plugin" && args[1] === "add") {
        return { code: 1, stdout: "", stderr: "persistent add failure" };
      }
      return found.runCodex(args);
    };
    await assert.rejects(
      installPersonalRosterPilotPlugin({
        ...found,
        runCodex,
        now: new Date("2026-08-02T02:30:46Z"),
        cacheNonce: "second",
        environment: {},
      }),
      /Recovery copy retained at/,
    );
    const entries = await readdir(path.dirname(found.sourceRoot));
    assert.equal(
      entries.some((entry) => entry.startsWith("rosterpilot.registered-")),
      true,
    );
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});
