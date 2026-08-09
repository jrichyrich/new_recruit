import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { RosterPilotService } from "../lib/rosterpilot/service";
import { createRosterPilotMcpServer } from "../mcp/server";

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
    assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= 16 * 1_024);
  } finally {
    await context.client.close();
    await context.server.close();
    await rm(context.root, { recursive: true, force: true });
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
