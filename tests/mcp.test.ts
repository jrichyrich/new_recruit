import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  buildRoster,
  rosterExecutionFingerprint,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import { createRosterPilotMcpServer } from "../mcp/server";

test("MCP exposes the planned tool contract and matches the engine", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let freshnessChecks = 0;
  let handoffWrite:
    | {
        formats: string[];
        outputDirectory: string;
        overwrite: boolean;
      }
    | undefined;
  const server = createRosterPilotMcpServer({
    freshnessChecker: async () => {
      freshnessChecks += 1;
      return {
        ok: true,
        data: {
          checkedAt: "2026-07-26T18:00:00.000Z",
          state: "current",
          rules: {
            pinnedVersion: "1.2.0",
            latestVersion: "1.2.0",
            updateAvailable: false,
          },
          newRecruit: {
            pinnedCommit: "fa5138e6a503b1f7818af4c72305d5901326a87d",
            latestCommit: "fa5138e6a503b1f7818af4c72305d5901326a87d",
            updateAvailable: false,
          },
          official: {
            pinnedVersion: "1.1",
            latestVersion: "1.1",
            pinnedContentSha256:
              "b9ff34a767377e46b285b9e66d481840fda204d39328e80d2c75e7dbbe0f6211",
            latestContentSha256:
              "b9ff34a767377e46b285b9e66d481840fda204d39328e80d2c75e7dbbe0f6211",
            updateAvailable: false,
          },
        },
        violations: [],
        warnings: [],
      };
    },
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
          agentAvailable: true,
          agentVersion: "1.0.0",
          protocolCompatible: true,
          installationCurrent: true,
          credentialState: "ready",
          browserState: "ready",
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
          enrichedSummary: null,
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
    tesseraCompanion: {
      status: async () => ({
        ok: true,
        data: {
          available: true,
          platform: "darwin",
          browserAvailable: true,
          brokerAvailable: true,
          credentialsConfigured: true,
          agentAvailable: true,
          agentVersion: "1.2.0",
          protocolCompatible: true,
          installationCurrent: true,
          credentialState: "ready",
          experimental: true,
          url: "https://playtessera.gg/",
        },
        violations: [],
        warnings: [],
      }),
      prepare: async () => ({
        ok: false,
        data: null,
        violations: [
          {
            code: "NOT_INVOKED",
            message: "Fixture prepare was not invoked.",
            severity: "error",
          },
        ],
        warnings: [],
      }),
      analyze: async () => ({
        ok: false,
        data: null,
        violations: [
          {
            code: "NOT_INVOKED",
            message: "Fixture analysis was not invoked.",
            severity: "error",
          },
        ],
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
        "analyze_roster_matchup",
        "build_roster",
        "check_data_freshness",
        "compare_factions",
        "deliver_roster_to_new_recruit",
        "explain_roster",
        "export_roster",
        "get_data_status",
        "get_data_update_status",
        "get_new_recruit_capability",
        "get_new_recruit_connection_status",
        "get_tessera_connection_status",
        "list_data_conflicts",
        "modify_roster",
        "modify_roster_batch",
        "prepare_new_recruit_handoff",
        "prepare_roster_for_tessera",
        "rebase_roster",
        "rebind_tessera_scenario_contract_provider",
        "refresh_data_now",
        "rollback_data_bundle",
        "run_roster_workflow",
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
      data: RosterDraftV1;
    };
    assert.equal(structured.ok, true);
    assert.equal(structured.data.factionId, "adeptus-custodes");
    assert.equal(structured.data.totalPoints, 1000);
    const direct = buildRoster({
      prompt:
        "Build a 1,000 point fast Custodes army with no named characters",
    });
    assert.ok(direct.data);
    assert.equal(
      rosterExecutionFingerprint(structured.data),
      rosterExecutionFingerprint(direct.data),
    );
    assert.equal(
      freshnessChecks,
      0,
      "a roster build must not wait for a live source check",
    );

    const aeldariResponse = await client.callTool({
      name: "build_roster",
      arguments: {
        prompt:
          "Build a 1,000 point fast Aeldari army that shoots and captures objectives",
        faction: "aeldari",
        pointsLimit: 1000,
        preferences: ["mobility", "shooting", "objective"],
      },
    });
    assert.equal(aeldariResponse.isError, false);
    const aeldari = aeldariResponse.structuredContent as {
      ok: boolean;
      data: { factionId: string; totalPoints: number };
    };
    assert.equal(aeldari.ok, true);
    assert.equal(aeldari.data.factionId, "aeldari");
    assert.ok(aeldari.data.totalPoints >= 980);
    assert.equal(
      freshnessChecks,
      0,
      "additional builds remain offline-first",
    );

    const forcedFreshness = await client.callTool({
      name: "check_data_freshness",
      arguments: { force: true },
    });
    assert.equal(forcedFreshness.isError, false);
    assert.equal(freshnessChecks, 1);

    const capability = await client.callTool({
      name: "get_new_recruit_capability",
      arguments: { factionId: "adeptus-custodes" },
    });
    assert.equal(capability.isError, false);

    const conflicts = await client.callTool({
      name: "list_data_conflicts",
      arguments: {
        factionId: "adeptus-custodes",
        blocking: true,
        limit: 10,
      },
    });
    assert.equal(conflicts.isError, false);

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
      ["rosz", "roster-json", "text", "html"],
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
    const malformedContent = malformed.content as Array<{
      type: string;
      text?: string;
    }>;
    assert.match(
      malformedContent
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join(" "),
      /invalid|schema|required/i,
    );
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
    assert.ok(!names.includes("get_tessera_connection_status"));
    assert.ok(!names.includes("prepare_roster_for_tessera"));
    assert.ok(!names.includes("analyze_roster_matchup"));
  } finally {
    await client.close();
    await server.close();
  }
});
