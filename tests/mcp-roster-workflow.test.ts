import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRosterPilotMcpServer } from "../mcp/server";
import { buildRoster } from "../lib/rosterpilot/engine";
import {
  GeneralThreatArchetypeIds,
  type DataBundleProvider,
} from "../lib/rosterpilot";
import type {
  TesseraRunJob,
  TesseraRunRequest,
} from "../local/tessera/jobs";

test("MCP composite workflow gates and performs New Recruit delivery", async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let deliveries = 0;
  const server = createRosterPilotMcpServer({
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
      deliver: async (roster) => {
        deliveries += 1;
        return {
          ok: true,
          data: {
            rosterId: roster.id,
            rosterName: roster.name,
            listUrl:
              "https://www.newrecruit.eu/app/Lists/workflow-fixture",
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
            artifacts: [],
          },
          violations: [],
          warnings: [],
        };
      },
    },
  });
  const client = new Client({
    name: "roster-workflow-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const question = await client.callTool({
      name: "run_roster_workflow",
      arguments: {
        prompt:
          "Can you upload a 1,000 point Custodes army to New Recruit?",
      },
    });
    assert.equal(question.isError, false);
    assert.equal(deliveries, 0);
    const questionEnvelope = question.structuredContent as {
      data: {
        newRecruit: { delivery: { authorized: boolean } };
        execution: {
          newRecruitDelivery: { status: string };
        };
      };
    };
    assert.equal(
      questionEnvelope.data.newRecruit.delivery.authorized,
      false,
    );
    assert.equal(
      questionEnvelope.data.execution.newRecruitDelivery.status,
      "not-run",
    );

    const explicit = await client.callTool({
      name: "run_roster_workflow",
      arguments: {
        prompt:
          "Build a 1,000 point Custodes army and upload it to New Recruit.",
      },
    });
    assert.equal(explicit.isError, false);
    assert.equal(deliveries, 1);
    const explicitEnvelope = explicit.structuredContent as {
      data: {
        newRecruit: { delivery: { status: string } };
        execution: {
          newRecruitDelivery: {
            status: string;
            result: { imported: boolean };
          };
        };
      };
    };
    assert.equal(
      explicitEnvelope.data.execution.newRecruitDelivery.status,
      "delivered",
    );
    assert.equal(
      explicitEnvelope.data.newRecruit.delivery.status,
      "delivered",
    );
    assert.equal(
      explicitEnvelope.data.execution.newRecruitDelivery.result.imported,
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("hosted MCP returns a manual handoff when direct delivery is unavailable", async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer();
  const client = new Client({
    name: "hosted-roster-workflow-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const response = await client.callTool({
      name: "run_roster_workflow",
      arguments: {
        prompt:
          "Build a 1,000 point Aeldari army and upload it to New Recruit.",
      },
    });
    assert.equal(response.isError, false);
    const envelope = response.structuredContent as {
      data: {
        newRecruit: {
          handoff: {
            artifacts: Array<{ format: string; encoding: string }>;
          };
        };
        execution: {
          newRecruitDelivery: { status: string };
        };
      };
      violations: Array<{ code: string }>;
      warnings: Array<{ code: string }>;
    };
    assert.equal(
      envelope.data.execution.newRecruitDelivery.status,
      "unavailable",
    );
    assert.ok(
      envelope.data.newRecruit.handoff.artifacts.some(
        (artifact) =>
          artifact.format === "rosz" &&
          artifact.encoding === "base64",
      ),
    );
    assert.equal(
      envelope.warnings.find(
        (warning) =>
          warning.code === "NEW_RECRUIT_COMPANION_UNAVAILABLE",
      )?.code,
      "NEW_RECRUIT_COMPANION_UNAVAILABLE",
    );
    assert.deepEqual(envelope.violations, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP optimize workflow keeps an omitted provider promotion-gated", async () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  }).data;
  assert.ok(opponent);
  const requests: TesseraRunRequest[] = [];
  const fixtureJob = {
    runId: "workflow-baseline-run",
    runKind: "exact",
    status: "queued",
    requestPath:
      "/tmp/workflow-baseline-run/tessera-run.json",
    resultPath: "/tmp/workflow-baseline-run/result.json",
  } as unknown as TesseraRunJob;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer({
    tesseraRunJobs: {
      start: async (request) => {
        requests.push(request);
        return fixtureJob;
      },
      status: async () => ({ job: fixtureJob, result: null }),
      resume: async () => fixtureJob,
      resolveProfiles: async () => fixtureJob,
      cancel: async () => fixtureJob,
    },
  });
  const client = new Client({
    name: "optimizer-workflow-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const response = await client.callTool({
      name: "run_roster_workflow",
      arguments: {
        prompt:
          "Build a 1,000 point Custodes army against Aeldari and Tessera optimize it.",
        opponentRoster: opponent,
      },
    });
    assert.equal(response.isError, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "exact");
    if (requests[0]?.kind === "exact") {
      assert.equal(requests[0].options?.executionMode, "simulate");
      assert.equal(requests[0].options?.includeChangeCandidates, true);
      assert.equal(requests[0].opponent.kind, "roster");
    }
    const envelope = response.structuredContent as {
      data: {
        status: string;
        optimization: {
          status: string;
          preparation: {
            provider: string;
            artifactIntent: string;
            simulationInput: string;
            profileRichRosz: string;
            pairedBaseline: string;
          };
        };
        execution: {
          tesseraBaseline: {
            status: string;
            jobs: Array<{ runId: string }>;
          };
        };
      };
    };
    assert.equal(
      envelope.data.status,
      "ready-for-tessera-baseline",
    );
    assert.equal(
      envelope.data.optimization.status,
      "baseline-pending",
    );
    assert.equal(
      envelope.data.optimization.preparation.profileRichRosz,
      "pending-provider-selection",
    );
    assert.equal(
      envelope.data.optimization.preparation.provider,
      "auto",
    );
    assert.equal(
      envelope.data.optimization.preparation.artifactIntent,
      "provider-deferred",
    );
    assert.equal(
      envelope.data.optimization.preparation.simulationInput,
      "pending-provider-selection",
    );
    assert.equal(
      envelope.data.execution.tesseraBaseline.status,
      "in-progress",
    );
    assert.equal(
      envelope.data.execution.tesseraBaseline.jobs[0]?.runId,
      fixtureJob.runId,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP general optimize workflow keys all six durable baselines by archetype", async () => {
  const requests: TesseraRunRequest[] = [];
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer({
    tesseraRunJobs: {
      start: async (request) => {
        const index = requests.push(request) - 1;
        return {
          runId: `general-baseline-${index}`,
          runKind: "exact",
          status: "queued",
          requestPath: `/tmp/general-baseline-${index}/tessera-run.json`,
          resultPath: `/tmp/general-baseline-${index}/result.json`,
        } as unknown as TesseraRunJob;
      },
      status: async () => {
        throw new Error("status not used");
      },
      resume: async () => {
        throw new Error("resume not used");
      },
      resolveProfiles: async () => {
        throw new Error("profile resolution not used");
      },
      cancel: async () => {
        throw new Error("cancel not used");
      },
    },
  });
  const client = new Client({
    name: "general-optimizer-workflow-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const response = await client.callTool({
      name: "run_roster_workflow",
      arguments: {
        prompt:
          "Build a 1,000 point Custodes army and Tessera optimize it.",
      },
    });
    assert.equal(response.isError, false);
    assert.equal(requests.length, 6);
    assert.ok(requests.every((request) => request.kind === "exact"));
    const envelope = response.structuredContent as {
      data: {
        execution: {
          tesseraBaseline: {
            status: string;
            targetKind: string;
            jobs: Array<{
              targetId: string;
              targetLabel: string;
              runId: string;
            }>;
          };
        };
      };
    };
    assert.equal(
      envelope.data.execution.tesseraBaseline.targetKind,
      "general-six-archetype",
    );
    assert.deepEqual(
      envelope.data.execution.tesseraBaseline.jobs.map(
        (job) => job.targetId,
      ),
      GeneralThreatArchetypeIds,
    );
    assert.ok(
      envelope.data.execution.tesseraBaseline.jobs.every(
        (job) => job.targetLabel.length > 0 && job.runId.length > 0,
      ),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP composite workflow holds exactly one data-bundle lease", async () => {
  const events: string[] = [];
  const bundleId = "a".repeat(64);
  const provider: DataBundleProvider = {
    async acquireSnapshot() {
      events.push("acquire");
      let released = false;
      return {
        leaseId: "composite-workflow-lease",
        snapshot: null as never,
        get released() {
          return released;
        },
        async release() {
          if (released) return;
          released = true;
          events.push("release");
        },
      };
    },
    async getStatus() {
      return {
        state: "ready",
        activeBundleId: bundleId,
        latestVerifiedBundleId: bundleId,
        latestUpstreamBundleId: bundleId,
        candidate: null,
        quarantinedScopes: [],
        lastCheckedAt: "2026-08-01T00:00:00.000Z",
      };
    },
    async refresh() {
      return {
        status: await this.getStatus(),
        activatedBundleId: null,
        classification: null,
      };
    },
    async rollback() {
      return this.getStatus();
    },
  };
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer({
    dataBundleProvider: provider,
  });
  const client = new Client({
    name: "workflow-lease-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const response = await client.callTool({
      name: "run_roster_workflow",
      arguments: {
        prompt: "Build a 1,000 point Custodes army.",
        coachingMode: "full",
      },
    });
    assert.equal(response.isError, false);
    assert.deepEqual(events, ["acquire", "release"]);
  } finally {
    await client.close();
    await server.close();
  }
});
