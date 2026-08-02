import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  activateLegendsInventory,
  resetActiveLegendsInventoryForTests,
  type RosterDraftV1,
  type UnitSummary,
} from "../lib/rosterpilot";
import { createRosterPilotMcpServer } from "../mcp/server";

test("MCP publishes and applies the structured Legends policy contract", async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer();
  const client = new Client({
    name: "rosterpilot-legends-policy-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    const buildTool = listed.tools.find(
      (tool) => tool.name === "build_roster",
    );
    assert.ok(buildTool);
    const properties = (
      buildTool.inputSchema as {
        properties?: Record<string, unknown>;
      }
    ).properties;
    assert.ok(properties?.legendsPolicy);
    assert.ok(properties?.allowLegends);
    assert.ok(properties?.playContext);

    const response = await client.callTool({
      name: "build_roster",
      arguments: {
        faction: "adeptus-custodes",
        pointsLimit: 1_000,
        legendsPolicy: "allow",
        playContext: {
          kind: "event",
          eventName: "Unverified Open",
          legendsPermission: "allowed",
        },
      },
    });
    assert.equal(response.isError, false);
    const structured = response.structuredContent as {
      ok: boolean;
      data: RosterDraftV1;
    };
    assert.equal(structured.ok, true);
    assert.equal(structured.data.constraints.allowLegends, false);
    assert.equal(
      structured.data.constraints.legendsPolicyDecision?.playContextKind,
      "event",
    );
    assert.match(
      structured.data.constraints.legendsPolicyDecision?.reason ?? "",
      /no source-backed Legends ruling/i,
    );

    const invalid = await client.callTool({
      name: "build_roster",
      arguments: {
        faction: "adeptus-custodes",
        legendsPolicy: "sometimes",
      },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("MCP search returns verified Legends artifact provenance", async () => {
  activateLegendsInventory(
    new Map([
      [
        "aeldari",
        {
          schemaVersion: 1 as const,
          factionId: "aeldari",
          coverageStatus: "complete" as const,
          classificationAuthority:
            "games-workshop-verified" as const,
          sourceArtifacts: [
            {
              sourceId: "mcp-aeldari-legends-pack",
              version: "2026-08",
              contentSha256: "f".repeat(64),
              url: "https://example.com/mcp-aeldari-legends.pdf",
            },
          ],
          units: [
            {
              legendId: "official:aeldari:mcp-relic",
              factionId: "aeldari",
              name: "MCP Aeldari Legends Relic",
              unitId: null,
              sourceId: "mcp-aeldari-legends-pack",
              datasheetUrl:
                "https://example.com/mcp-aeldari-relic.pdf",
              buildSupported: false,
            },
          ],
        },
      ],
    ]),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer();
  const client = new Client({
    name: "rosterpilot-legends-provenance-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const response = await client.callTool({
      name: "search_units",
      arguments: {
        faction: "aeldari",
        query: "MCP Aeldari Legends Relic",
        includeLegends: true,
      },
    });
    assert.equal(response.isError, false);
    const structured = response.structuredContent as {
      data: UnitSummary[];
    };
    assert.deepEqual(structured.data[0].legendProvenance, {
      classificationAuthority: "games-workshop-verified",
      sourceId: "mcp-aeldari-legends-pack",
      version: "2026-08",
      contentSha256: "f".repeat(64),
      url: "https://example.com/mcp-aeldari-legends.pdf",
      datasheetUrl: "https://example.com/mcp-aeldari-relic.pdf",
    });
  } finally {
    resetActiveLegendsInventoryForTests();
    await Promise.all([client.close(), server.close()]);
  }
});
