import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRosterPilotMcpServer } from "../mcp/server";

test("MCP exposes the planned tool contract and matches the engine", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer();
  const client = new Client({ name: "rosterpilot-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "build_roster",
        "compare_factions",
        "explain_roster",
        "export_roster",
        "get_data_status",
        "modify_roster",
        "search_factions",
        "search_units",
        "validate_roster",
      ],
    );

    const response = await client.callTool({
      name: "build_roster",
      arguments: {
        prompt: "Build a 1,000 point fast Custodes army with no named characters",
      },
    });
    assert.equal(response.isError, false);
    const structured = response.structuredContent as {
      ok: boolean;
      data: { factionId: string; totalPoints: number };
    };
    assert.equal(structured.ok, true);
    assert.equal(structured.data.factionId, "adeptus-custodes");
    assert.equal(structured.data.totalPoints, 990);

    const malformed = await client.callTool({
      name: "validate_roster",
      arguments: { roster: { schemaVersion: 1, units: [] } },
    });
    assert.equal(malformed.isError, true);
    const malformedEnvelope = malformed.structuredContent as {
      ok: boolean;
      violations: Array<{ code: string }>;
    };
    assert.equal(malformedEnvelope.ok, false);
    assert.equal(malformedEnvelope.violations[0]?.code, "MALFORMED_ROSTER");
  } finally {
    await client.close();
    await server.close();
  }
});
