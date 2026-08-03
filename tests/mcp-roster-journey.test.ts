import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildRoster } from "../lib/rosterpilot/engine";
import {
  approveRosterJourneyDataMigration,
  chooseRosterJourneyAction,
  continueRosterJourneySafely,
  getRosterJourney,
  repairRosterJourneyTesseraWebCompatibility,
  startRosterJourneyRepairedTesseraWebRun,
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
      repairWebCompatibility: (journeyId, revision, input) =>
        repairRosterJourneyTesseraWebCompatibility(
          journeyId,
          revision,
          input,
          { rootDir },
        ),
      approveDataMigration: (journeyId, revision, approval) =>
        approveRosterJourneyDataMigration(
          journeyId,
          revision,
          approval,
          { rootDir },
        ),
      startRepairedWeb: (journeyId, revision, input) =>
        startRosterJourneyRepairedTesseraWebRun(
          journeyId,
          revision,
          input,
          { rootDir },
        ),
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
    const listed = await client.listTools();
    assert.ok(
      listed.tools.some(
        (tool) => tool.name === "repair_tessera_web_compatibility",
      ),
    );
    const repairTool = listed.tools.find(
      (tool) => tool.name === "repair_tessera_web_compatibility",
    );
    const requiredRepairInputs =
      (repairTool?.inputSchema as { required?: string[] }).required ?? [];
    assert.equal(
      requiredRepairInputs.includes("observedGameSystemRevision"),
      false,
    );
    assert.equal(
      requiredRepairInputs.includes("observedCatalogueRevision"),
      false,
    );
    assert.ok(
      listed.tools.some(
        (tool) => tool.name === "approve_roster_data_migration",
      ),
    );
    assert.ok(
      listed.tools.some(
        (tool) => tool.name === "start_repaired_tessera_web_run",
      ),
    );
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
