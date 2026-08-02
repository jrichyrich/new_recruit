import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  buildRoster,
  type LegendsPlayContext,
} from "../lib/rosterpilot";
import { buildAndAnalyzeRosterMatchup } from "../local/tessera/exact-full-loop";
import { buildAndStressRosterAgainstFaction } from "../local/tessera/full-loop";
import {
  startTesseraRun,
  type TesseraRunJob,
  type TesseraRunRequest,
} from "../local/tessera/jobs";
import { createRosterPilotMcpServer } from "../mcp/server";

const eventContext = {
  kind: "event",
  eventName: "Fixture Open",
  legendsPermission: "disallowed",
  evidence: {
    source: "organizer-ruling",
    title: "Fixture Legends ruling",
    reference: "fixture://tessera-legends-policy",
    contentSha256: "a".repeat(64),
    checkedAt: "2026-08-01T00:00:00.000Z",
  },
} satisfies LegendsPlayContext;

const runtimeStop = () => ({
  code: "RUNTIME_RESTART_REQUIRED",
  message: "Fixture stops before external delivery.",
} as const);

type PersistedJob = TesseraRunJob & {
  request: TesseraRunRequest;
};

async function readPersistedJob(filename: string): Promise<PersistedJob> {
  return JSON.parse(await readFile(filename, "utf8")) as PersistedJob;
}

function transportJob(
  request: TesseraRunRequest,
  sequence: number,
): TesseraRunJob {
  const runId = `legends-transport-${sequence}`;
  return {
    runId,
    runKind: request.kind,
    status: "queued",
    requestPath: `/fixture/${runId}/tessera-run.json`,
    manifestPath: `/fixture/${runId}/manifest.json`,
  } as TesseraRunJob;
}

test("Tessera preserves the player Legends decision and defaults opponent portfolios closed", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-legends-"),
  );
  try {
    const player = buildRoster({
      playerFaction: "adeptus-custodes",
      pointsLimit: 1_000,
      name: "Policy-bound Custodes",
      legendsPolicy: "exclude",
      playContext: eventContext,
    });
    const opponent = buildRoster({
      playerFaction: "aeldari",
      pointsLimit: 1_000,
      name: "Exact Aeldari opponent",
    });
    assert.ok(player.ok && player.data);
    assert.ok(opponent.ok && opponent.data);
    const expectedDecision =
      player.data.constraints.legendsPolicyDecision;
    assert.ok(expectedDecision);

    const exactBuild = await buildAndAnalyzeRosterMatchup(
      {
        prompt: "Build a mission-ready 1000 point Custodes counter-roster",
        playerFaction: "adeptus-custodes",
        opponentRoster: opponent.data,
        legendsPolicy: "exclude",
        playContext: eventContext,
        allowReadinessWarnings: true,
        executionMode: "prepare-only",
        outputDirectory: path.join(directory, "exact-build"),
      },
      {},
      { runtimeIssue: runtimeStop },
    );
    assert.deepEqual(
      exactBuild.data?.rosterRepair.roster.constraints
        .legendsPolicyDecision,
      expectedDecision,
    );

    const buildAndStress = await buildAndStressRosterAgainstFaction(
      {
        prompt: "Build a mission-ready 1000 point Custodes army",
        playerFaction: "adeptus-custodes",
        againstFaction: "aeldari",
        pointsLimit: 1_000,
        legendsPolicy: "exclude",
        playContext: eventContext,
        allowReadinessWarnings: true,
        suite: "core-3",
        executionMode: "prepare-only",
        outputDirectory: path.join(directory, "build-and-stress"),
      },
      { rootDir: directory },
      { runtimeIssue: runtimeStop },
    );
    assert.deepEqual(
      buildAndStress.data?.rosterRepair.roster.constraints
        .legendsPolicyDecision,
      expectedDecision,
    );
    const builtPortfolio = buildAndStress.data?.portfolioPreview?.portfolio;
    assert.ok(builtPortfolio);
    for (const item of builtPortfolio.items) {
      if (!item.roster) continue;
      assert.equal(item.roster.constraints.allowLegends, false);
      assert.equal(
        item.roster.constraints.legendsPolicyDecision
          ?.effectiveAllowLegends,
        false,
      );
    }

    const exactJob = await startTesseraRun(
      {
        kind: "exact",
        playerRoster: player.data,
        opponent: { kind: "roster", roster: opponent.data },
        options: { executionMode: "prepare-only" },
      },
      {
        rootDir: directory,
        outputDirectory: path.join(directory, "runs"),
        launch: false,
      },
    );
    const persistedExact = await readPersistedJob(exactJob.requestPath);
    assert.equal(persistedExact.request.kind, "exact");
    if (persistedExact.request.kind !== "exact") {
      throw new Error("Expected an exact Tessera request.");
    }
    assert.deepEqual(
      persistedExact.request.playerRoster.constraints
        .legendsPolicyDecision,
      expectedDecision,
    );

    const stressJob = await startTesseraRun(
      {
        kind: "stress",
        playerRoster: player.data,
        factionId: "aeldari",
        options: {
          suite: "core-3",
          executionMode: "prepare-only",
        },
      },
      {
        rootDir: directory,
        outputDirectory: path.join(directory, "runs"),
        launch: false,
      },
    );
    const persistedStress = await readPersistedJob(stressJob.requestPath);
    assert.equal(persistedStress.request.kind, "stress");
    if (persistedStress.request.kind !== "stress") {
      throw new Error("Expected a stress Tessera request.");
    }
    assert.deepEqual(
      persistedStress.request.playerRoster.constraints
        .legendsPolicyDecision,
      expectedDecision,
    );
    const frozenPortfolio =
      persistedStress.request.options?.portfolioPreview?.portfolio;
    assert.ok(frozenPortfolio);
    for (const item of frozenPortfolio.items) {
      if (!item.roster) continue;
      assert.equal(item.roster.constraints.allowLegends, false);
      assert.equal(
        item.roster.constraints.legendsPolicyDecision
          ?.effectiveAllowLegends,
        false,
      );
    }

    const buildJob = await startTesseraRun(
      {
        kind: "build-and-stress",
        input: {
          prompt: "Build a mission-ready 1000 point Custodes army",
          playerFaction: "adeptus-custodes",
          againstFaction: "aeldari",
          pointsLimit: 1_000,
          legendsPolicy: "exclude",
          playContext: eventContext,
          executionMode: "prepare-only",
        },
      },
      {
        rootDir: directory,
        outputDirectory: path.join(directory, "runs"),
        launch: false,
      },
    );
    const persistedBuild = await readPersistedJob(buildJob.requestPath);
    assert.equal(persistedBuild.request.kind, "build-and-stress");
    if (persistedBuild.request.kind !== "build-and-stress") {
      throw new Error("Expected a build-and-stress Tessera request.");
    }
    assert.equal(persistedBuild.request.input.legendsPolicy, "exclude");
    assert.deepEqual(persistedBuild.request.input.playContext, eventContext);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP Tessera builders publish and forward structured Legends inputs to durable jobs", async () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1_000,
    name: "MCP exact opponent",
  });
  assert.ok(opponent.ok && opponent.data);
  const requests: TesseraRunRequest[] = [];
  const synchronousFailure = async () => ({
    ok: false as const,
    data: null,
    violations: [
      {
        code: "SYNCHRONOUS_TESSERA_NOT_EXPECTED",
        message: "The durable transport test must not use the synchronous path.",
        severity: "error" as const,
      },
    ],
    warnings: [],
  });
  const server = createRosterPilotMcpServer({
    tesseraCompanion: {
      status: synchronousFailure,
      prepare: synchronousFailure,
      analyze: synchronousFailure,
      buildAndStress: synchronousFailure,
      buildAndAnalyze: synchronousFailure,
    },
    tesseraRunJobs: {
      start: async (request) => {
        requests.push(request);
        return transportJob(request, requests.length);
      },
      status: async () => {
        throw new Error("Status was not expected.");
      },
      resume: async () => {
        throw new Error("Resume was not expected.");
      },
      resolveProfiles: async () => {
        throw new Error("Profile resolution was not expected.");
      },
      cancel: async () => {
        throw new Error("Cancellation was not expected.");
      },
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "rosterpilot-tessera-legends-transport-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const tools = await client.listTools();
    for (const toolName of [
      "build_and_stress_roster_against_faction",
      "build_and_analyze_roster_matchup",
    ]) {
      const tool = tools.tools.find((candidate) => candidate.name === toolName);
      assert.ok(tool);
      const properties = (
        tool.inputSchema as {
          properties?: Record<string, unknown>;
        }
      ).properties;
      assert.ok(properties?.legendsPolicy);
      assert.ok(properties?.allowLegends);
      assert.ok(properties?.playContext);
    }

    await client.callTool({
      name: "build_and_stress_roster_against_faction",
      arguments: {
        prompt: "Build a mission-ready Custodes army",
        playerFaction: "adeptus-custodes",
        againstFaction: "aeldari",
        pointsLimit: 1_000,
        legendsPolicy: "exclude",
        allowLegends: false,
        playContext: eventContext,
        executionMode: "simulate",
      },
    });
    await client.callTool({
      name: "build_and_analyze_roster_matchup",
      arguments: {
        prompt: "Build a mission-ready Custodes counter-roster",
        playerFaction: "adeptus-custodes",
        pointsLimit: 1_000,
        opponentRoster: opponent.data,
        legendsPolicy: "exclude",
        allowLegends: false,
        playContext: eventContext,
        executionMode: "simulate",
      },
    });
    await client.callTool({
      name: "start_tessera_run",
      arguments: {
        request: {
          kind: "build-and-stress",
          prompt: "Build a mission-ready Custodes army",
          playerFaction: "adeptus-custodes",
          againstFaction: "aeldari",
          pointsLimit: 1_000,
          legendsPolicy: "exclude",
          allowLegends: false,
          playContext: eventContext,
          executionMode: "simulate",
        },
      },
    });
    await client.callTool({
      name: "start_tessera_run",
      arguments: {
        request: {
          kind: "build-and-analyze",
          prompt: "Build a mission-ready Custodes counter-roster",
          playerFaction: "adeptus-custodes",
          pointsLimit: 1_000,
          opponentRoster: opponent.data,
          legendsPolicy: "exclude",
          allowLegends: false,
          playContext: eventContext,
          executionMode: "simulate",
        },
      },
    });

    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.ok(
        request.kind === "build-and-stress" ||
          request.kind === "build-and-analyze",
      );
      if (
        request.kind !== "build-and-stress" &&
        request.kind !== "build-and-analyze"
      ) {
        throw new Error("Expected a Tessera builder request.");
      }
      assert.equal(request.input.legendsPolicy, "exclude");
      assert.equal(request.input.allowLegends, false);
      assert.deepEqual(request.input.playContext, eventContext);
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
