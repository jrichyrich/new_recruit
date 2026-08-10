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

import { RosterPilotService } from "../lib/rosterpilot/service";
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

async function connected() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-mcp-"));
  const service = new RosterPilotService({
    rootDirectory: root,
    lease: async (operation) => operation(),
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

test("keeps explicit CLI build flags aligned with MCP build options", async () => {
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
    ]) {
      assert.match(help.stdout, new RegExp(flag));
    }

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
        factionId: string;
        detachment: string;
        disposition: string;
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

test("stages Tessera website stress without making the external call", async () => {
  let calls = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-mcp-stress-"));
  const service = new RosterPilotService({
    rootDirectory: root,
    lease: async (operation) => operation(),
    runStress: async () => {
      calls += 1;
      return { ok: true, data: {}, violations: [], warnings: [] };
    },
  });
  try {
    const built = await service.run({
      action: "build",
      options: { faction: "adeptus-custodes", pointsLimit: 500 },
    });
    const staged = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: {
        opponentFaction: "world-eaters",
        backend: "website",
      },
    });
    assert.equal(staged.state, "action-required");
    assert.equal(staged.nextActions[0].actionId, "tessera.stress.run");
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
