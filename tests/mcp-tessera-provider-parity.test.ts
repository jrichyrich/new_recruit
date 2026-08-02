import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type {
  RunTesseraProviderParityWorkflowOptions,
  RunTesseraProviderParityWorkflowResult,
} from "../local/tessera/provider-parity-workflow";
import { createRosterPilotMcpServer } from "../mcp/server";

function unusedCompanionResult(code: string) {
  return {
    ok: false as const,
    data: null,
    violations: [{
      code,
      message: "This companion method was not expected.",
      severity: "error" as const,
    }],
    warnings: [],
  };
}

test("MCP exposes receipt-bound provider comparison and scenario rebinding", async () => {
  const calls: RunTesseraProviderParityWorkflowOptions[] = [];
  const comparison = {
    schemaVersion: 1,
    kind: "tessera-provider-parity-comparison",
    classification: "parity-pass",
  } as unknown as RunTesseraProviderParityWorkflowResult["data"];
  const server = createRosterPilotMcpServer({
    tesseraCompanion: {
      status: async () => unusedCompanionResult("STATUS_NOT_EXPECTED"),
      prepare: async () => unusedCompanionResult("PREPARE_NOT_EXPECTED"),
      analyze: async () => unusedCompanionResult("ANALYZE_NOT_EXPECTED"),
      compareProviders: async (options) => {
        calls.push(options);
        return {
          ok: true,
          data: comparison,
          violations: [],
          warnings: [],
        };
      },
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "rosterpilot-provider-parity-mcp-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some(
      (tool) => tool.name === "compare_tessera_providers",
    ));
    assert.ok(tools.tools.some(
      (tool) =>
        tool.name === "rebind_tessera_scenario_contract_provider",
    ));

    const compared = await client.callTool({
      name: "compare_tessera_providers",
      arguments: {
        localReportPath: "/tmp/local-report.json",
        websiteReportPath: "/tmp/website-report.json",
        outputDirectory: "/tmp/provider-parity",
        overwrite: true,
      },
    });
    assert.equal(compared.isError, false);
    assert.deepEqual(calls, [{
      localReportPath: "/tmp/local-report.json",
      websiteReportPath: "/tmp/website-report.json",
      outputDirectory: "/tmp/provider-parity",
      overwrite: true,
    }]);

    const rebound = await client.callTool({
      name: "rebind_tessera_scenario_contract_provider",
      arguments: {
        sourceProvider: "website",
        targetProvider: "local-engine",
        scenarioContract: [{
          phase: "shooting",
          direction: "player-to-opponent",
          metric: "mean-damage",
          settings: {
            provider: "website",
            "Target in cover": "No",
            "Rapid fire range": "Yes",
          },
          iterations: 10_000,
        }],
      },
    });
    assert.equal(rebound.isError, undefined);
    const reboundData = rebound.structuredContent as {
      scenarioContract: Array<{
        settings: Record<string, string>;
        iterations: number;
      }>;
      scenarioContractSha256: string;
    };
    assert.equal(reboundData.scenarioContract[0].iterations, 10_000);
    assert.deepEqual(reboundData.scenarioContract[0].settings, {
      charging: "false",
      indirectFire: "false",
      provider: "local-engine",
      remainedStationary: "false",
      targetInCover: "false",
      withinMeltaRange: "false",
      withinRapidFireRange: "true",
    });
    assert.match(reboundData.scenarioContractSha256, /^[0-9a-f]{64}$/);
  } finally {
    await client.close();
    await server.close();
  }
});
