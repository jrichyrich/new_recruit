import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildRoster } from "../lib/rosterpilot";
import { createRosterPilotMcpServer } from "../mcp/server";

test("MCP exposes the standard validation workflow and explicit Web confirmations", async () => {
  const roster = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
  }).data;
  assert.ok(roster);

  const starts: unknown[] = [];
  const confirmations: unknown[] = [];
  const server = createRosterPilotMcpServer({
    tesseraValidationWorkflows: {
      async start(input) {
        starts.push(structuredClone(input));
        return { action: "local-started", workflowId: "validation-1" };
      },
      async status(workflowId) {
        return { workflowId, pendingAction: "poll-local-nine" };
      },
      async advance(workflowId) {
        return { workflowId, action: "local-pending" };
      },
      async confirmRemainingSix(workflowId, expectedOfferSequence) {
        confirmations.push({ workflowId, expectedOfferSequence });
        return { workflowId, pendingAction: "start-web-batch" };
      },
      async confirmSuccessor(
        workflowId,
        failedJobId,
        expectedOfferSequence,
      ) {
        confirmations.push({
          workflowId,
          failedJobId,
          expectedOfferSequence,
        });
        return { workflowId, pendingAction: "start-web-batch" };
      },
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "rosterpilot-validation-mcp-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "start_tessera_validation",
      "get_tessera_validation_status",
      "advance_tessera_validation",
      "confirm_tessera_validation_remaining_six",
      "confirm_tessera_validation_successor",
    ]) {
      assert.ok(names.includes(name), `${name} was not registered`);
    }

    const started = await client.callTool({
      name: "start_tessera_validation",
      arguments: {
        playerRoster: roster,
        opponentFaction: "aeldari",
      },
    });
    assert.equal(started.isError, undefined);
    assert.equal(starts.length, 1);
    assert.deepEqual(
      starts[0],
      {
        playerRoster: roster,
        opponentFaction: "aeldari",
        validationDepth: "standard",
        exhaustiveConfirmation: false,
      },
    );

    const unconfirmedExhaustive = await client.callTool({
      name: "start_tessera_validation",
      arguments: {
        playerRoster: roster,
        opponentFaction: "aeldari",
        validationDepth: "exhaustive",
      },
    });
    assert.equal(unconfirmedExhaustive.isError, true);
    assert.equal(starts.length, 1);

    await client.callTool({
      name: "get_tessera_validation_status",
      arguments: { workflowId: "validation-1" },
    });
    await client.callTool({
      name: "advance_tessera_validation",
      arguments: { workflowId: "validation-1" },
    });
    await client.callTool({
      name: "confirm_tessera_validation_remaining_six",
      arguments: {
        workflowId: "validation-1",
        expectedOfferSequence: 9,
      },
    });
    await client.callTool({
      name: "confirm_tessera_validation_successor",
      arguments: {
        workflowId: "validation-1",
        failedJobId: "failed-web-batch",
        expectedOfferSequence: 12,
      },
    });
    assert.deepEqual(confirmations, [
      { workflowId: "validation-1", expectedOfferSequence: 9 },
      {
        workflowId: "validation-1",
        failedJobId: "failed-web-batch",
        expectedOfferSequence: 12,
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
