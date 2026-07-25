import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRosterPilotMcpServer } from "../mcp/server";

test("MCP exposes the planned tool contract and matches the engine", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let handoffWrite:
    | {
        formats: string[];
        outputDirectory: string;
        overwrite: boolean;
      }
    | undefined;
  const server = createRosterPilotMcpServer({
    handoffWriter: async (artifacts, outputDirectory, overwrite) => {
      handoffWrite = {
        formats: artifacts.map((artifact) => artifact.format),
        outputDirectory,
        overwrite,
      };
      return artifacts.map(
        (artifact) => `/workspace/${outputDirectory}/${artifact.filename}`,
      );
    },
    newRecruitCompanion: {
      status: async () => ({
        ok: true,
        data: {
          available: true,
          platform: "darwin",
          browserAvailable: true,
          brokerAvailable: true,
          credentialsConfigured: true,
          profileDirectory: "/fixture/profile",
        },
        violations: [],
        warnings: [],
      }),
      deliver: async (roster, options) => ({
        ok: true,
        data: {
          rosterId: roster.id,
          rosterName: roster.name,
          listUrl: "https://www.newrecruit.eu/app/Lists/fixture",
          imported: true,
          sessionReused: true,
          verification: {
            name: true,
            faction: true,
            points: true,
            units: roster.units.map((unit) => ({
              name: unit.name,
              modelCount: unit.modelCount,
              matched: true,
            })),
            mismatches: [],
          },
          artifacts: [
            {
              format: "new-recruit-pretty-html",
              filename: "fixture.html",
              mimeType: "text/html",
              written: `${options.outputDirectory}/fixture.html`,
            },
          ],
        },
        violations: [],
        warnings: [],
      }),
    },
  });
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
        "deliver_roster_to_new_recruit",
        "explain_roster",
        "export_roster",
        "get_data_status",
        "get_new_recruit_connection_status",
        "modify_roster",
        "prepare_new_recruit_handoff",
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

    const handoff = await client.callTool({
      name: "prepare_new_recruit_handoff",
      arguments: {
        roster: structured.data,
      },
    });
    assert.equal(handoff.isError, false);
    const handoffEnvelope = handoff.structuredContent as {
      ok: boolean;
      data: {
        importUrl: string;
        artifacts: Array<{ format: string; encoding: string; content: string }>;
      };
    };
    assert.equal(handoffEnvelope.ok, true);
    assert.equal(
      handoffEnvelope.data.importUrl,
      "https://www.newrecruit.eu/app/MyLists",
    );
    assert.deepEqual(
      handoffEnvelope.data.artifacts.map((artifact) => artifact.format),
      ["rosz", "html"],
    );
    assert.equal(handoffEnvelope.data.artifacts[0].encoding, "base64");

    const writtenHandoff = await client.callTool({
      name: "prepare_new_recruit_handoff",
      arguments: {
        roster: structured.data,
        includeHtml: false,
        outputDirectory: "exports",
      },
    });
    assert.equal(writtenHandoff.isError, false);
    assert.deepEqual(handoffWrite, {
      formats: ["rosz"],
      outputDirectory: "exports",
      overwrite: false,
    });
    const writtenEnvelope = writtenHandoff.structuredContent as {
      data: { artifacts: Array<{ written: string }> };
    };
    assert.match(writtenEnvelope.data.artifacts[0].written, /\.rosz$/);

    const delivered = await client.callTool({
      name: "deliver_roster_to_new_recruit",
      arguments: {
        roster: structured.data,
        outputDirectory: "exports/new-recruit",
      },
    });
    assert.equal(delivered.isError, false);
    const deliveredEnvelope = delivered.structuredContent as {
      data: { imported: boolean; listUrl: string };
    };
    assert.equal(deliveredEnvelope.data.imported, true);
    assert.match(deliveredEnvelope.data.listUrl, /newrecruit\.eu\/app\/Lists/);

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

test("hosted MCP omits local credential-backed New Recruit tools", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer();
  const client = new Client({ name: "rosterpilot-remote-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(!names.includes("get_new_recruit_connection_status"));
    assert.ok(!names.includes("deliver_roster_to_new_recruit"));
  } finally {
    await client.close();
    await server.close();
  }
});
