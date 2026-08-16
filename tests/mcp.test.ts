import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  runAgentLifecycleCommand,
  type AgentLifecycleDependencies,
} from "../cli/agent-lifecycle";
import {
  RosterPilotService,
  type StressRunner,
} from "../lib/rosterpilot/service";
import type { LifecycleResult } from "../local/agent/lifecycle";
import { createRosterPilotMcpServer } from "../mcp/server";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function runCli(
  supportDirectory: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx", "cli/rosterpilot.ts", ...args],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ROSTERPILOT_SUPPORT_DIRECTORY: supportDirectory,
        ROSTERPILOT_LOCAL_UPDATE_WORKER: "1",
      },
    },
  );
}

async function cliFailure(
  supportDirectory: string,
  args: string[],
): Promise<string> {
  try {
    await runCli(supportDirectory, args);
    assert.fail("Expected the CLI invocation to fail.");
  } catch (error) {
    const failure = error as { message?: string; stderr?: string };
    return `${failure.stderr ?? ""}\n${failure.message ?? ""}`;
  }
}

async function connected(options: { runStress?: StressRunner } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-mcp-"));
  const service = new RosterPilotService({
    rootDirectory: root,
    lease: async (operation) => operation(),
    runStress: options.runStress,
  });
  const server = createRosterPilotMcpServer({ service });
  const client = new Client({ name: "rosterpilot-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { root, service, server, client };
}

test("routes documented local-agent lifecycle commands", async () => {
  const calls: string[] = [];
  const result = (action: string): LifecycleResult => ({
    ok: true,
    installed: action !== "uninstall",
    running: action !== "uninstall",
    launchAgentPath: `/agent/${action}.plist`,
    brokerPath: `/broker/${action}`,
    socketPath: `/socket/${action}`,
  });
  const dependency = (action: string) => async () => {
    calls.push(action);
    return result(action);
  };
  const dependencies: AgentLifecycleDependencies = {
    install: dependency("install"),
    status: dependency("status"),
    ensureCurrent: dependency("ensure-current"),
    restart: dependency("restart"),
    uninstall: dependency("uninstall"),
  };

  for (const action of [
    "install",
    "status",
    "ensure-current",
    "restart",
    "uninstall",
  ]) {
    assert.deepEqual(
      await runAgentLifecycleCommand(action, dependencies),
      result(action),
    );
  }
  assert.deepEqual(calls, [
    "install",
    "status",
    "ensure-current",
    "restart",
    "uninstall",
  ]);
  await assert.rejects(
    runAgentLifecycleCommand("unknown", dependencies),
    /Unknown agent command "unknown"/,
  );
});

test("publishes exactly three token-efficient tools", async () => {
  const context = await connected();
  try {
    const listed = await context.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      "run",
      "inspect",
      "act",
    ]);
    const runTool = listed.tools.find((tool) => tool.name === "run");
    assert.match(runTool?.description ?? "", /playerFaction/);
    assert.match(runTool?.description ?? "", /pointsLimit \(not pointLimit\)/);
    assert.match(runTool?.description ?? "", /preferences/);
    assert.match(runTool?.description ?? "", /legendsPolicy/);
    assert.match(runTool?.description ?? "", /compareOpponentOptions/);
    assert.match(runTool?.description ?? "", /comparisonDepth/);
    assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= 16 * 1_024);
  } finally {
    await context.client.close();
    await context.server.close();
    await rm(context.root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test("keeps retained CLI routes and explicit build flags aligned with MCP options", async () => {
  const context = await connected();
  const cliRoot = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-cli-"));
  const expectedOptions = {
    name: "Adapter parity",
    allowNamedCharacters: false,
    playerFaction: "adeptus-custodes",
    pointsLimit: 500,
    detachmentId: "shield-host",
    forceDispositionId: "purge-the-foe",
    compareOpponentOptions: false,
    comparisonDepth: "standard",
    opponentFaction: "world-eaters",
  };
  try {
    const help = await runCli(cliRoot, ["help"]);
    for (const flag of [
      "--player-faction",
      "--detachment",
      "--force-disposition",
      "--compare-opponent-options",
      "--comparison-depth",
      "--catalogue-drift-mode",
    ]) {
      assert.match(help.stdout, new RegExp(flag));
    }
    assert.match(
      help.stdout,
      /agent <install\|status\|ensure-current\|restart\|uninstall>/,
    );

    const cliRun = await runCli(cliRoot, [
      "build",
      "--player-faction",
      "adeptus-custodes",
      "--points",
      "500",
      "--detachment",
      "shield-host",
      "--force-disposition",
      "purge-the-foe",
      "--compare-opponent-options=false",
      "--comparison-depth",
      "standard",
      "--opponent-faction",
      "world-eaters",
      "--options",
      JSON.stringify({
        name: "Adapter parity",
        allowNamedCharacters: false,
      }),
    ]);
    const cliSummary = JSON.parse(cliRun.stdout) as {
      operationId: string;
      state: string;
      roster: {
        rosterRef: string;
        factionId: string;
        detachment: string;
        disposition: string;
        units: Array<{ selectionId: string; warlord: boolean }>;
      };
    };
    assert.equal(cliSummary.state, "completed");
    const cliDetails = JSON.parse((await runCli(cliRoot, [
      "inspect",
      cliSummary.operationId,
      "--view",
      "details",
    ])).stdout) as {
      request: { options: Record<string, unknown> };
    };
    assert.deepEqual(cliDetails.request.options, expectedOptions);

    const mcpRun = await context.client.callTool({
      name: "run",
      arguments: {
        action: "build",
        options: expectedOptions,
      },
    });
    const mcpSummary = mcpRun.structuredContent as {
      operationId: string;
      state: string;
      roster: {
        factionId: string;
        detachment: string;
        disposition: string;
      };
    };
    assert.equal(mcpSummary.state, "completed");
    const mcpDetails = await context.service.inspect({
      ref: mcpSummary.operationId,
      view: "details",
    }) as {
      request: { options: Record<string, unknown> };
    };
    assert.deepEqual(mcpDetails.request.options, expectedOptions);
    assert.deepEqual(
      {
        factionId: cliSummary.roster.factionId,
        detachment: cliSummary.roster.detachment,
        disposition: cliSummary.roster.disposition,
      },
      {
        factionId: mcpSummary.roster.factionId,
        detachment: mcpSummary.roster.detachment,
        disposition: mcpSummary.roster.disposition,
      },
    );

    const warlord = cliSummary.roster.units.find((unit) => unit.warlord);
    assert.ok(warlord);
    const modified = JSON.parse((await runCli(cliRoot, [
      "modify",
      "--roster",
      cliSummary.roster.rosterRef,
      "--options",
      JSON.stringify({
        operation: {
          type: "set-warlord",
          selectionId: warlord.selectionId,
        },
      }),
    ])).stdout) as {
      state: string;
      roster: { rosterRef: string };
    };
    assert.equal(modified.state, "completed");

    const exportedPath = path.join(cliRoot, "adapter-parity-roster.json");
    const exported = JSON.parse((await runCli(cliRoot, [
      "export",
      "--roster",
      modified.roster.rosterRef,
      "--format",
      "roster-json",
      "--output",
      exportedPath,
    ])).stdout) as { state: string; artifacts: Array<{ written?: string }> };
    assert.equal(exported.state, "completed");
    assert.equal(exported.artifacts[0]?.written, exportedPath);

    const imported = JSON.parse((await runCli(cliRoot, [
      "import",
      exportedPath,
    ])).stdout) as { state: string; roster: { factionId: string } };
    assert.equal(imported.state, "completed");
    assert.equal(imported.roster.factionId, "adeptus-custodes");

    const research = JSON.parse((await runCli(cliRoot, [
      "research",
      "Custodes",
    ])).stdout) as { state: string };
    assert.equal(research.state, "completed");

    const status = JSON.parse((await runCli(cliRoot, [
      "status",
    ])).stdout) as { data: { ok: boolean }; newRecruit: { ok: boolean } };
    assert.equal(status.data.ok, true);
    assert.equal(typeof status.newRecruit.ok, "boolean");

    assert.match(
      await cliFailure(cliRoot, [
        "build",
        "--player-faction",
        "adeptus-custodes",
        "--compare-opponent-options=maybe",
      ]),
      /--compare-opponent-options must be true or false/,
    );
    assert.match(
      await cliFailure(cliRoot, [
        "build",
        "--player-faction",
        "adeptus-custodes",
        "--comparison-depth",
        "deep",
      ]),
      /--comparison-depth must be standard or expanded/,
    );
    assert.match(
      await cliFailure(cliRoot, [
        "stress",
        "--catalogue-drift-mode",
        "force",
      ]),
      /--catalogue-drift-mode must be reject or diagnostic/,
    );
  } finally {
    await context.client.close();
    await context.server.close();
    await rm(context.root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    await rm(cliRoot, { recursive: true, force: true });
  }
});

test("returns compact structured results and resource links", async () => {
  const context = await connected();
  try {
    const built = await context.client.callTool({
      name: "run",
      arguments: {
        action: "build",
        request: "Build a 500 point Adeptus Custodes roster",
        options: { faction: "adeptus-custodes", pointsLimit: 500 },
      },
    });
    assert.ok(built.structuredContent);
    assert.ok(Buffer.byteLength(JSON.stringify(built)) <= 4_096);
    const rosterRef = (built.structuredContent as {
      roster: { rosterRef: string };
    }).roster.rosterRef;

    const exported = await context.client.callTool({
      name: "run",
      arguments: { action: "export", rosterRef, format: "rosz" },
    });
    const content = exported.content as Array<{ type: string }>;
    assert.ok(content.some((entry) => entry.type === "resource_link"));
    assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= 4_096);

    const compared = await context.client.callTool({
      name: "run",
      arguments: {
        action: "build",
        request: "Build a 1000 point Adeptus Custodes counter roster",
        options: {
          playerFaction: "adeptus-custodes",
          opponentFaction: "world-eaters",
          pointsLimit: 1000,
          name: "界".repeat(160),
        },
      },
    });
    assert.ok(compared.structuredContent);
    assert.ok(
      (compared.content as Array<{ type: string }>).some(
        (entry) => entry.type === "resource_link",
      ),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(compared)) <= 4_096);
  } finally {
    await context.client.close();
    await context.server.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

test("keeps Tessera website confirmation and drift policy at the MCP boundary", async () => {
  let calls = 0;
  const driftModes: string[] = [];
  const context = await connected({
    runStress: async (_roster, _faction, options) => {
      calls += 1;
      driftModes.push(options.catalogueDriftMode);
      return {
        ok: true,
        data: { status: "complete", runId: `mcp-stress-${calls}` },
        violations: [],
        warnings: [],
      };
    },
  });
  try {
    const built = await context.client.callTool({
      name: "run",
      arguments: {
        action: "build",
        options: { faction: "adeptus-custodes", pointsLimit: 500 },
      },
    });
    const rosterRef = (built.structuredContent as {
      roster: { rosterRef: string };
    }).roster.rosterRef;
    const stagedResult = await context.client.callTool({
      name: "run",
      arguments: {
        action: "stress",
        rosterRef,
        options: {
          opponentFaction: "world-eaters",
          backend: "website",
        },
      },
    });
    const staged = stagedResult.structuredContent as {
      operationId: string;
      revision: number;
      state: string;
      nextActions: Array<{ actionId: string }>;
    };
    assert.equal(staged.state, "action-required");
    assert.equal(staged.nextActions[0].actionId, "tessera.stress.run");
    assert.equal(calls, 0);

    const forcedResult = await context.client.callTool({
      name: "run",
      arguments: {
        action: "stress",
        rosterRef,
        options: {
          opponentFaction: "world-eaters",
          backend: "local-engine",
          catalogueDriftMode: "force",
        },
      },
    });
    const forced = forcedResult.structuredContent as {
      state: string;
      violations: Array<{ code: string }>;
    };
    assert.equal(forced.state, "failed");
    assert.equal(
      forced.violations[0]?.code,
      "STRESS_CATALOGUE_DRIFT_MODE_INVALID",
    );
    assert.equal(calls, 0);

    const completedResult = await context.client.callTool({
      name: "act",
      arguments: {
        operationId: staged.operationId,
        expectedRevision: staged.revision,
        actionId: "tessera.stress.run",
        confirm: true,
      },
    });
    const completed = completedResult.structuredContent as {
      state: string;
      result: { catalogueDriftMode: string };
    };
    assert.equal(completed.state, "completed");
    assert.equal(completed.result.catalogueDriftMode, "reject");
    assert.deepEqual(driftModes, ["reject"]);
  } finally {
    await context.client.close();
    await context.server.close();
    await rm(context.root, { recursive: true, force: true });
  }
});
