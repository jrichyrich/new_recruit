import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildRoster } from "../lib/rosterpilot/engine";
import {
  chooseRosterJourneyAction,
  continueRosterJourneySafely,
  getRosterJourney,
  startRosterJourney,
} from "../local/workflow/journey";
import { createRosterPilotMcpServer } from "../mcp/server";

test("local MCP exposes durable journey start, status, continue, and park", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "mcp-journey-"));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer({
    workflowJourneys: {
      start: (request) => startRosterJourney(request, { rootDir }),
      status: (journeyId) => getRosterJourney(journeyId, { rootDir }),
      continue: (journeyId, revision) =>
        continueRosterJourneySafely(journeyId, revision, { rootDir }),
      choose: (journeyId, revision, actionId) =>
        chooseRosterJourneyAction(journeyId, revision, actionId, {
          rootDir,
        }),
    },
  });
  const client = new Client({
    name: "roster-journey-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const opponent = buildRoster({
      playerFaction: "aeldari",
      pointsLimit: 1000,
    }).data;
    assert.ok(opponent);
    const started = await client.callTool({
      name: "start_roster_workflow",
      arguments: {
        intent: "analyze",
        playerFaction: "adeptus-custodes",
        pointsLimit: 1000,
        simulationBackend: "local-engine",
        opponentRoster: opponent,
      },
    });
    assert.equal(started.isError, false);
    const startData = (started.structuredContent as {
      data: { journeyId: string; stateRevision: number };
    }).data;

    const status = await client.callTool({
      name: "get_roster_workflow_status",
      arguments: { journeyId: startData.journeyId },
    });
    assert.equal(status.isError, false);

    const continued = await client.callTool({
      name: "continue_roster_workflow",
      arguments: {
        journeyId: startData.journeyId,
        expectedRevision: startData.stateRevision,
      },
    });
    assert.equal(continued.isError, false);
    const continuedData = (continued.structuredContent as {
      data: { stateRevision: number };
    }).data;

    const parked = await client.callTool({
      name: "choose_roster_workflow_action",
      arguments: {
        journeyId: startData.journeyId,
        expectedRevision: continuedData.stateRevision,
        actionId: "workflow.park",
      },
    });
    assert.equal(parked.isError, false);
    assert.equal(
      (parked.structuredContent as { data: { status: string } }).data
        .status,
      "parked",
    );
  } finally {
    await client.close();
    await server.close();
  }
});
