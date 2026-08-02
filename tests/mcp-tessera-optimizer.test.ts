import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRosterPilotMcpServer } from "../mcp/server";

test("local MCP exposes the complete approval-gated optimizer lifecycle", async () => {
  let statusCalls = 0;
  const unavailable = async () => ({
    ok: false,
    data: null,
    violations: [
      {
        code: "OPTIMIZER_FIXTURE",
        message: "Fixture adapter reached.",
        severity: "error" as const,
      },
    ],
    warnings: [],
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer({
    tesseraOptimizerStore: {
      start: unavailable,
      status: async () => {
        statusCalls += 1;
        return unavailable();
      },
      approveCandidates: unavailable,
      recordComparison: unavailable,
      approveWinner: unavailable,
      retainBaseline: unavailable,
      finalize: unavailable,
    },
  });
  const client = new Client({
    name: "optimizer-contract-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const names = (await client.listTools()).tools.map(
      (tool) => tool.name,
    );
    for (const expected of [
      "start_tessera_optimizer",
      "get_tessera_optimizer_status",
      "approve_tessera_optimizer_candidates",
      "record_tessera_optimizer_comparison",
      "approve_tessera_optimizer_winner",
      "retain_tessera_optimizer_baseline",
      "finalize_tessera_optimizer",
      "deliver_tessera_optimizer_winner_to_new_recruit",
    ]) {
      assert.ok(names.includes(expected), expected);
    }

    const status = await client.callTool({
      name: "get_tessera_optimizer_status",
      arguments: { statePath: "/fixture/optimizer.json" },
    });
    assert.equal(status.isError, true);
    assert.equal(statusCalls, 1);

    const missingDeliveryReceipt = await client.callTool({
      name: "finalize_tessera_optimizer",
      arguments: {
        statePath: "/fixture/optimizer.json",
        expectedStateRevision: 4,
        deliveryKind: "deliver-new-recruit",
      },
    });
    assert.equal(missingDeliveryReceipt.isError, true);
    const envelope = missingDeliveryReceipt.structuredContent as {
      violations: Array<{ code: string }>;
    };
    assert.equal(
      envelope.violations[0]?.code,
      "TESSERA_OPTIMIZER_DELIVERY_INTENT_REQUIRED",
    );

    const tooManyCandidates = await client.callTool({
      name: "approve_tessera_optimizer_candidates",
      arguments: {
        statePath: "/fixture/optimizer.json",
        expectedStateRevision: 0,
        candidateIds: ["a", "b", "c", "d"],
        approvalId: "approval",
        approvedBy: "tester",
      },
    });
    assert.equal(tooManyCandidates.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("local MCP exposes the aggregate six-archetype optimizer lifecycle", async () => {
  let statusCalls = 0;
  let recordedKey: {
    candidateId: string;
    archetypeId: string;
    requestSha256: string;
  } | null = null;
  const unavailable = async () => ({
    ok: false,
    data: null,
    violations: [
      {
        code: "GENERAL_OPTIMIZER_FIXTURE",
        message: "Fixture adapter reached.",
        severity: "error" as const,
      },
    ],
    warnings: [],
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer({
    tesseraGeneralOptimizerStore: {
      start: unavailable,
      status: async () => {
        statusCalls += 1;
        return unavailable();
      },
      approveCandidates: unavailable,
      recordComparison: async (_statePath, input) => {
        recordedKey = {
          candidateId: input.candidateId,
          archetypeId: input.archetypeId,
          requestSha256: input.requestSha256,
        };
        return unavailable();
      },
      approveWinner: unavailable,
      retainBaseline: unavailable,
      finalize: unavailable,
    },
  });
  const client = new Client({
    name: "general-optimizer-contract-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const names = (await client.listTools()).tools.map(
      (tool) => tool.name,
    );
    for (const expected of [
      "start_tessera_general_optimizer",
      "get_tessera_general_optimizer_status",
      "approve_tessera_general_optimizer_candidates",
      "record_tessera_general_optimizer_comparison",
      "approve_tessera_general_optimizer_winner",
      "retain_tessera_general_optimizer_baseline",
      "finalize_tessera_general_optimizer",
      "deliver_tessera_general_optimizer_winner_to_new_recruit",
    ]) {
      assert.ok(names.includes(expected), expected);
    }

    const status = await client.callTool({
      name: "get_tessera_general_optimizer_status",
      arguments: { statePath: "/fixture/general-optimizer.json" },
    });
    assert.equal(status.isError, true);
    assert.equal(statusCalls, 1);

    const missingDeliveryReceipt = await client.callTool({
      name: "finalize_tessera_general_optimizer",
      arguments: {
        statePath: "/fixture/general-optimizer.json",
        expectedStateRevision: 14,
        deliveryKind: "deliver-new-recruit",
      },
    });
    assert.equal(missingDeliveryReceipt.isError, true);
    const envelope = missingDeliveryReceipt.structuredContent as {
      violations: Array<{ code: string }>;
    };
    assert.equal(
      envelope.violations[0]?.code,
      "TESSERA_GENERAL_OPTIMIZER_DELIVERY_INTENT_REQUIRED",
    );

    const tooManyCandidates = await client.callTool({
      name: "approve_tessera_general_optimizer_candidates",
      arguments: {
        statePath: "/fixture/general-optimizer.json",
        expectedStateRevision: 0,
        candidateIds: ["a", "b", "c", "d"],
        approvalId: "approval",
        approvedBy: "tester",
      },
    });
    assert.equal(tooManyCandidates.isError, true);

    const requestSha256 = "a".repeat(64);
    const recorded = await client.callTool({
      name: "record_tessera_general_optimizer_comparison",
      arguments: {
        statePath: "/fixture/general-optimizer.json",
        expectedStateRevision: 2,
        candidateId: "candidate-one",
        archetypeId: "horde",
        requestSha256,
        reportPath: "/fixture/comparison.json",
      },
    });
    assert.equal(recorded.isError, true);
    assert.deepEqual(recordedKey, {
      candidateId: "candidate-one",
      archetypeId: "horde",
      requestSha256,
    });
  } finally {
    await client.close();
    await server.close();
  }
});
