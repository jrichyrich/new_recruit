import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  SetupError,
  freshnessAction,
  parseSetupArgs,
  renderClaudeConfig,
  renderCodexConfig,
  runSetup,
  validateNodeVersion,
} from "../scripts/setup.mjs";

type CommandCall = {
  args: string[];
  command: string;
  options: { capture?: boolean; cwd?: string };
};

function outputBuffer() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      write(value: string | Uint8Array) {
        chunks.push(String(value));
        return true;
      },
    },
  };
}

function setupHarness(options: {
  agentStatusCode?: number;
  agentStatus?: Record<string, unknown>;
  configExists?: boolean;
  credentialsConfigured?: boolean;
  dataSyncFailure?: boolean;
  freshnessFailure?: boolean;
  freshnessState?: string;
  newRecruitAgentAvailable?: boolean;
  newRecruitAvailable?: boolean;
  platform?: string;
  tesseraCredentialsConfigured?: boolean;
  trackedChanges?: string;
} = {}) {
  const projectRoot = "/tmp/Roster Pilot \"fixture\"";
  const configPath = path.join(projectRoot, ".codex", "config.toml");
  const files = new Map<string, string>([
    [path.join(projectRoot, "package.json"), "{}"],
    [path.join(projectRoot, "package-lock.json"), "{}"],
    [path.join(projectRoot, "data", "sources.json"), "{}"],
    [
      path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      "",
    ],
  ]);
  if (options.configExists) files.set(configPath, "existing = true\n");

  const calls: CommandCall[] = [];
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const run = (
    command: string,
    args: string[],
    commandOptions: { capture?: boolean; cwd?: string } = {},
  ) => {
    calls.push({ command, args, options: commandOptions });
    if (command === "git" && args[0] === "--version") {
      return { code: 0, stdout: "git version 2.50.0\n", stderr: "" };
    }
    if (command === "git" && args[0] === "status") {
      return {
        code: 0,
        stdout: options.trackedChanges ?? "",
        stderr: "",
      };
    }
    if (args.includes("data:sync-check") && options.dataSyncFailure) {
      return {
        code: 1,
        stdout: "",
        stderr: "pinned data fixture does not match\n",
      };
    }
    if (args.some((entry) => entry.endsWith("cli/rosterpilot.ts"))) {
      const action = args.at(-1);
      if (args.includes("agent")) {
        return {
          code: options.agentStatusCode ?? 0,
          stdout: JSON.stringify(
            options.agentStatus ?? {
              ok: true,
              installed: true,
              running: true,
            },
          ),
          stderr: "",
        };
      }
      if (args.includes("new-recruit") && action === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              available: options.newRecruitAvailable ?? true,
              agentAvailable:
                options.newRecruitAgentAvailable ?? true,
              credentialsConfigured: options.credentialsConfigured ?? false,
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("tessera") && action === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              available: options.tesseraCredentialsConfigured ?? false,
              agentAvailable: true,
              browserAvailable: true,
              brokerAvailable: true,
              protocolCompatible: true,
              credentialsConfigured:
                options.tesseraCredentialsConfigured ?? false,
            },
          }),
          stderr: "",
        };
      }
      if (action === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { sources: { releaseId: "2026-07-27.1" } },
          }),
          stderr: "",
        };
      }
      if (action === "freshness") {
        if (options.freshnessFailure) {
          return {
            code: 1,
            stdout: "",
            stderr: "network unavailable\n",
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { state: options.freshnessState ?? "current" },
          }),
          stderr: "",
        };
      }
      if (action === "configure") {
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, configured: true }),
          stderr: "",
        };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  return {
    calls,
    configPath,
    dependencies: {
      fs: {
        exists: (filename: string) => files.has(filename),
        isExecutable: () => true,
        mkdir: () => undefined,
        read: (filename: string) => files.get(filename) ?? "",
        write: (filename: string, content: string) => {
          files.set(filename, content);
        },
      },
      isTTY: false,
      nodeExecutable: "/opt/node/bin/node",
      nodeVersion: "v22.13.0",
      platform: options.platform ?? "darwin",
      projectRoot,
      run,
      stderr: stderr.stream,
      stdout: stdout.stream,
    },
    files,
    stderr,
    stdout,
  };
}

test("setup arguments validate profiles, refresh modes, and doctor mutations", () => {
  assert.deepEqual(
    parseSetupArgs([
      "--profile=mcp",
      "--non-interactive",
      "--refresh",
      "check",
    ]),
    {
      doctor: false,
      help: false,
      nonInteractive: true,
      profile: "mcp",
      refresh: "check",
    },
  );
  assert.throws(() => parseSetupArgs(["--profile", "cloud"]), SetupError);
  assert.throws(
    () => parseSetupArgs(["--doctor", "--refresh", "apply"]),
    /Doctor cannot apply/,
  );
});

test("Node validation enforces the minimum and warns away from the baseline", () => {
  assert.equal(validateNodeVersion("v22.12.0").supported, false);
  assert.deepEqual(
    {
      aligned: validateNodeVersion("v22.13.0").aligned,
      supported: validateNodeVersion("v22.13.0").supported,
    },
    { aligned: true, supported: true },
  );
  assert.deepEqual(
    {
      aligned: validateNodeVersion("v26.4.0").aligned,
      supported: validateNodeVersion("v26.4.0").supported,
    },
    { aligned: false, supported: true },
  );
  assert.equal(validateNodeVersion("v22.13.1").aligned, false);
});

test("package scripts and direct dependencies remain cross-platform", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.equal(
    Object.keys(packageJson.devDependencies).some((name) =>
      /-(?:darwin|linux|windows)(?:-|$)/.test(name),
    ),
    false,
  );
  for (const script of ["dev", "build", "start"]) {
    assert.doesNotMatch(packageJson.scripts[script], /^[A-Z0-9_]+=/);
  }
});

test("MCP renderers use the active executable and safely quote checkout paths", () => {
  const input = {
    nodeExecutable: "/opt/Node Runtime/bin/node",
    projectRoot: "/tmp/Roster \"Pilot\"",
  };
  const codex = renderCodexConfig(input);
  const claude = JSON.parse(renderClaudeConfig(input)) as {
    mcpServers: { rosterpilot: { command: string; cwd: string } };
  };
  assert.match(codex, /command = "\/opt\/Node Runtime\/bin\/node"/);
  assert.match(codex, /Roster \\"Pilot\\"/);
  assert.equal(
    claude.mcpServers.rosterpilot.command,
    "/opt/Node Runtime/bin/node",
  );
  assert.equal(claude.mcpServers.rosterpilot.cwd, "/tmp/Roster \"Pilot\"");
});

test("core setup installs locked dependencies and validates committed data", async () => {
  const harness = setupHarness();
  const result = await runSetup(
    {
      doctor: false,
      help: false,
      nonInteractive: true,
      profile: "core",
      refresh: "check",
    },
    harness.dependencies,
  );

  assert.equal(result.ok, true);
  assert.ok(
    harness.calls.some(
      (call) => call.command === "npm" && call.args[0] === "ci",
    ),
  );
  assert.ok(
    harness.calls.some((call) => call.args.includes("data:sync-check")),
  );
  assert.ok(harness.calls.some((call) => call.args.includes("data:check")));
  assert.ok(
    harness.calls.some((call) => call.args.at(-1) === "freshness"),
  );
  assert.match(harness.stdout.chunks.join(""), /release 2026-07-27\.1/);
});

test("doctor verifies dependencies without installing or mutating data", async () => {
  const harness = setupHarness();
  await runSetup(
    {
      doctor: true,
      help: false,
      nonInteractive: true,
      profile: "core",
      refresh: "skip",
    },
    harness.dependencies,
  );

  assert.equal(
    harness.calls.some(
      (call) =>
        call.args[0] === "ci" || call.args.includes("data:prepare-update"),
    ),
    false,
  );
  assert.equal(
    harness.calls.some((call) => call.args.includes("data:sync-check")),
    false,
  );
});

test("doctor keeps local diagnostics usable when remote freshness is offline", async () => {
  const harness = setupHarness({
    credentialsConfigured: true,
    freshnessFailure: true,
  });
  const result = await runSetup(
    {
      doctor: true,
      help: false,
      nonInteractive: true,
      profile: "new-recruit",
      refresh: "check",
    },
    harness.dependencies,
  );

  assert.equal(result.ok, true);
  assert.ok(
    harness.calls.some(
      (call) =>
        call.args.includes("agent") && call.args.at(-1) === "status",
    ),
  );
  assert.ok(
    harness.calls.some(
      (call) =>
        call.args.includes("new-recruit") &&
        call.args.at(-1) === "status",
    ),
  );
  assert.deepEqual(
    result.results.find(
      (entry: { name: string }) =>
        entry.name === "Remote data freshness",
    )?.status,
    "warning",
  );
  assert.match(
    harness.stdout.chunks.join(""),
    /Local readiness results remain valid for the pinned release/,
  );
});

test("doctor treats an unavailable remote pinned-source check as non-blocking", async () => {
  const harness = setupHarness({
    credentialsConfigured: true,
    dataSyncFailure: true,
  });
  const result = await runSetup(
    {
      doctor: true,
      help: false,
      nonInteractive: true,
      profile: "new-recruit",
      refresh: "check",
    },
    harness.dependencies,
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.results.find(
      (entry: { name: string }) =>
        entry.name === "Remote pinned-source check",
    )?.status,
    "warning",
  );
  assert.equal(
    result.results.find(
      (entry: { name: string }) => entry.name === "Local agent",
    )?.status,
    "ready",
  );
  assert.ok(
    harness.calls.some((call) => call.args.at(-1) === "freshness"),
  );
  assert.ok(
    result.nextSteps.some((step: string) =>
      step.includes("data:sync-check"),
    ),
  );
});

test("doctor preserves a stale-agent mismatch and recommends ensure-current", async () => {
  const harness = setupHarness({
    agentStatusCode: 2,
    agentStatus: {
      ok: false,
      installed: true,
      running: true,
      code: "LOCAL_AGENT_BUILD_MISMATCH",
      message: "running build old does not match checkout build new",
      nextSteps: [
        'Run "npm run rosterpilot -- agent ensure-current" from this checkout.',
      ],
    },
    credentialsConfigured: true,
  });
  const result = await runSetup(
    {
      doctor: true,
      help: false,
      nonInteractive: true,
      profile: "new-recruit",
      refresh: "skip",
    },
    harness.dependencies,
  );

  assert.equal(result.ok, false);
  assert.match(
    result.results.find(
      (entry: { name: string }) => entry.name === "Local agent",
    )?.detail ?? "",
    /LOCAL_AGENT_BUILD_MISMATCH/,
  );
  assert.ok(
    result.nextSteps.some((step: string) =>
      step.includes("agent ensure-current"),
    ),
  );
});

test("fresh-Mac doctor repairs the agent before recommending credential setup", async () => {
  const harness = setupHarness({
    agentStatusCode: 2,
    agentStatus: {
      ok: false,
      installed: false,
      running: false,
      code: "LOCAL_AGENT_NOT_INSTALLED",
      message: "the local agent is not installed",
    },
    newRecruitAgentAvailable: false,
    newRecruitAvailable: false,
  });
  const result = await runSetup(
    {
      doctor: true,
      help: false,
      nonInteractive: true,
      profile: "new-recruit",
      refresh: "skip",
    },
    harness.dependencies,
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.nextSteps.some((step: string) =>
      step.includes("agent ensure-current"),
    ),
  );
  assert.equal(
    result.nextSteps.some((step: string) =>
      step.includes("new-recruit configure"),
    ),
    false,
  );
});

test("MCP setup creates missing local config and preserves an existing file", async () => {
  const created = setupHarness();
  await runSetup(
    {
      doctor: false,
      help: false,
      nonInteractive: true,
      profile: "mcp",
      refresh: "skip",
    },
    created.dependencies,
  );
  assert.match(
    created.files.get(created.configPath) ?? "",
    /\[mcp_servers\.rosterpilot\]/,
  );
  assert.match(created.stdout.chunks.join(""), /Claude Desktop configuration/);

  const preserved = setupHarness({ configExists: true });
  await runSetup(
    {
      doctor: false,
      help: false,
      nonInteractive: true,
      profile: "mcp",
      refresh: "skip",
    },
    preserved.dependencies,
  );
  assert.equal(preserved.files.get(preserved.configPath), "existing = true\n");
  assert.match(preserved.stdout.chunks.join(""), /was not overwritten/);
});

test("explicit refresh applies only with a clean tracked worktree", async () => {
  const clean = setupHarness({ freshnessState: "update-available" });
  await runSetup(
    {
      doctor: false,
      help: false,
      nonInteractive: true,
      profile: "core",
      refresh: "apply",
    },
    clean.dependencies,
  );
  assert.ok(
    clean.calls.some((call) => call.args.includes("data:prepare-update")),
  );

  const dirty = setupHarness({
    freshnessState: "update-available",
    trackedChanges: " M data/sources.json\n",
  });
  await assert.rejects(
    runSetup(
      {
        doctor: false,
        help: false,
        nonInteractive: true,
        profile: "core",
        refresh: "apply",
      },
      dirty.dependencies,
    ),
    /tracked files are modified/,
  );
  assert.equal(
    dirty.calls.some((call) => call.args.includes("data:prepare-update")),
    false,
  );
});

test("unknown freshness never applies an update", async () => {
  assert.equal(freshnessAction("unknown"), "unknown");
  const harness = setupHarness({ freshnessState: "unknown" });
  await assert.rejects(
    runSetup(
      {
        doctor: false,
        help: false,
        nonInteractive: true,
        profile: "core",
        refresh: "apply",
      },
      harness.dependencies,
    ),
    /freshness is unknown/,
  );
  assert.equal(
    harness.calls.some((call) => call.args.includes("data:prepare-update")),
    false,
  );
});

test("New Recruit profile is rejected on unsupported platforms", async () => {
  const harness = setupHarness({ platform: "linux" });
  await assert.rejects(
    runSetup(
      {
        doctor: false,
        help: false,
        nonInteractive: true,
        profile: "new-recruit",
        refresh: "skip",
      },
      harness.dependencies,
    ),
    /require macOS/,
  );
  assert.equal(
    harness.calls.some((call) => call.args[0] === "ci"),
    false,
  );
});

test("New Recruit setup asks before opening the secure credential dialog", async () => {
  const declined = setupHarness();
  await runSetup(
    {
      doctor: false,
      help: false,
      nonInteractive: false,
      profile: "new-recruit",
      refresh: "skip",
    },
    {
      ...declined.dependencies,
      ask: async () => "no",
      isTTY: true,
    },
  );
  assert.ok(
    declined.calls.some((call) => call.args.includes("companion:build")),
  );
  assert.ok(
    declined.calls.some(
      (call) => call.args.includes("agent") && call.args.at(-1) === "install",
    ),
  );
  assert.equal(
    declined.calls.some((call) => call.args.at(-1) === "configure"),
    false,
  );
  assert.match(
    declined.stdout.chunks.join(""),
    /local agent installed; run npm run rosterpilot/,
  );

  const configured = setupHarness();
  let statusCalls = 0;
  const baseRun = configured.dependencies.run;
  await runSetup(
    {
      doctor: false,
      help: false,
      nonInteractive: false,
      profile: "new-recruit",
      refresh: "skip",
    },
    {
      ...configured.dependencies,
      ask: async () => "yes",
      isTTY: true,
      run(
        command: string,
        args: string[],
        commandOptions: { capture?: boolean; cwd?: string } = {},
      ) {
        if (
          args.includes("new-recruit") &&
          args.at(-1) === "status"
        ) {
          statusCalls += 1;
          configured.calls.push({
            command,
            args,
            options: commandOptions ?? {},
          });
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              data: {
                available: true,
                credentialsConfigured: statusCalls > 1,
              },
            }),
            stderr: "",
          };
        }
        return baseRun(command, args, commandOptions);
      },
    },
  );
  assert.ok(
    configured.calls.some((call) => call.args.at(-1) === "configure"),
  );
  assert.match(
    configured.stdout.chunks.join(""),
    /Keychain credential are configured/,
  );
});

test("New Recruit doctor checks the installed agent without reinstalling it", async () => {
  const harness = setupHarness({ credentialsConfigured: true });
  await runSetup(
    {
      doctor: true,
      help: false,
      nonInteractive: true,
      profile: "new-recruit",
      refresh: "skip",
    },
    harness.dependencies,
  );
  assert.ok(
    harness.calls.some(
      (call) => call.args.includes("agent") && call.args.at(-1) === "status",
    ),
  );
  assert.equal(
    harness.calls.some(
      (call) => call.args.includes("agent") && call.args.at(-1) === "install",
    ),
    false,
  );
  assert.equal(
    harness.calls.some((call) => call.args.includes("companion:build")),
    false,
  );
});

test("Tessera setup is cumulative but leaves both external workflows opt-in", async () => {
  const harness = setupHarness();
  await runSetup(
    {
      doctor: false,
      help: false,
      nonInteractive: true,
      profile: "tessera",
      refresh: "skip",
    },
    harness.dependencies,
  );

  assert.ok(
    harness.calls.some((call) => call.args.includes("companion:build")),
  );
  assert.ok(
    harness.calls.some(
      (call) => call.args.includes("agent") && call.args.at(-1) === "install",
    ),
  );
  assert.ok(
    harness.calls.some(
      (call) =>
        call.args.includes("new-recruit") && call.args.at(-1) === "status",
    ),
  );
  assert.ok(
    harness.calls.some(
      (call) => call.args.includes("tessera") && call.args.at(-1) === "status",
    ),
  );
  assert.equal(
    harness.calls.some((call) => call.args.at(-1) === "configure"),
    false,
  );
  assert.match(
    harness.stdout.chunks.join(""),
    /tessera configure to add the licence key/i,
  );
});
