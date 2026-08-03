import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRosterPilotMcpServer } from "../mcp/server";

test("MCP reliability summary preserves per-workflow reads and supports aggregates", async () => {
  const historyInputs: unknown[] = [];
  const summaryInputs: unknown[] = [];
  const server = createRosterPilotMcpServer({
    reliability: {
      async history(input) {
        historyInputs.push(structuredClone(input));
        return { ok: true, data: { workflow: input }, error: null };
      },
      async summary(input) {
        summaryInputs.push(structuredClone(input));
        return { ok: true, data: { query: input }, error: null };
      },
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "rosterpilot-reliability-mcp-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const tools = (await client.listTools()).tools;
    const historyTool = tools.find(
      (tool) => tool.name === "get_workflow_repair_history",
    );
    const summaryTool = tools.find(
      (tool) => tool.name === "get_reliability_summary",
    );
    assert.ok(historyTool);
    assert.ok(summaryTool);
    assert.equal(
      ((historyTool.inputSchema as { required?: string[] }).required ?? [])
        .includes("workflowId"),
      true,
    );
    assert.equal(
      ((summaryTool.inputSchema as { required?: string[] }).required ?? [])
        .includes("workflowId"),
      false,
    );

    await client.callTool({
      name: "get_reliability_summary",
      arguments: {},
    });
    await client.callTool({
      name: "get_reliability_summary",
      arguments: {
        workflowId: "run-one",
        workflowKind: "tessera-run",
      },
    });
    await client.callTool({
      name: "get_workflow_repair_history",
      arguments: {
        workflowId: "run-one",
        workflowKind: "tessera-run",
      },
    });
    assert.deepEqual(summaryInputs, [
      { workflowId: undefined, workflowKind: undefined },
      { workflowId: "run-one", workflowKind: "tessera-run" },
    ]);
    assert.deepEqual(historyInputs, [
      { workflowId: "run-one", workflowKind: "tessera-run" },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
