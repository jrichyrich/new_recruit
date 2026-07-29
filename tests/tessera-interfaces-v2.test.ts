import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  buildRoster,
  type TesseraMetric,
  type TesseraPhase,
  type TesseraStressAnalysisStrategy,
  type TesseraStressSuite,
} from "../lib/rosterpilot";
import { createRosterPilotMcpServer } from "../mcp/server";

const run = promisify(execFile);

type AnalysisOptions = {
  outputDirectory: string;
  overwrite: boolean;
  experimental: boolean;
  analysisMode: "quick" | "full";
  phases?: TesseraPhase[];
  metrics?: TesseraMetric[];
  allowPointMismatch: boolean;
  includeChangeCandidates: boolean;
};

type RevisionOptions = {
  outputDirectory: string;
  overwrite: boolean;
  experimental: boolean;
};

type StressOptions = {
  suite: TesseraStressSuite;
  analysisStrategy: TesseraStressAnalysisStrategy;
  resumeManifestPath?: string;
  outputDirectory: string;
  overwrite: boolean;
  experimental: boolean;
};

function notInvoked(code: string) {
  return {
    ok: false as const,
    data: null,
    violations: [
      {
        code,
        message: "Fixture operation completed without a live browser.",
        severity: "error" as const,
      },
    ],
    warnings: [],
  };
}

test("local MCP exposes Tessera analysis and stress-test schemas", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Tessera interface fixture",
  });
  assert.ok(built.ok && built.data);

  const analyses: AnalysisOptions[] = [];
  let revision:
    | {
        baselineReportPath: string;
        revisedRosterId: string;
        options: RevisionOptions;
      }
    | undefined;
  const stressTests: Array<{
    rosterId: string;
    factionId: string;
    options: StressOptions;
  }> = [];
  let stressRevision:
    | {
        baselineReportPath: string;
        revisedRosterId: string;
        options: RevisionOptions;
      }
    | undefined;
  const server = createRosterPilotMcpServer({
    tesseraCompanion: {
      status: async () => notInvoked("STATUS_FIXTURE"),
      prepare: async () => notInvoked("PREPARE_FIXTURE"),
      analyze: async (_player, _opponent, options) => {
        analyses.push(options);
        return notInvoked("ANALYZE_FIXTURE");
      },
      compare: async (baselineReportPath, revisedRoster, options) => {
        revision = {
          baselineReportPath,
          revisedRosterId: revisedRoster.id,
          options,
        };
        return notInvoked("COMPARE_FIXTURE");
      },
      stressTest: async (playerRoster, opponent, options) => {
        stressTests.push({
          rosterId: playerRoster.id,
          factionId: opponent.factionId,
          options,
        });
        return notInvoked("STRESS_TEST_FIXTURE");
      },
      previewPortfolio: async () =>
        notInvoked("STRESS_PREVIEW_FIXTURE"),
      buildAndStress: async () =>
        notInvoked("BUILD_AND_STRESS_FIXTURE"),
      compareStressRevision: async (
        baselineReportPath,
        revisedRoster,
        options,
      ) => {
        stressRevision = {
          baselineReportPath,
          revisedRosterId: revisedRoster.id,
          options,
        };
        return notInvoked("STRESS_REVISION_FIXTURE");
      },
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "rosterpilot-tessera-v2-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const listed = await client.listTools();
    const analyzeTool = listed.tools.find(
      (tool) => tool.name === "analyze_roster_matchup",
    );
    const compareTool = listed.tools.find(
      (tool) => tool.name === "compare_roster_revision",
    );
    const stressTool = listed.tools.find(
      (tool) => tool.name === "stress_test_roster_against_faction",
    );
    const stressRevisionTool = listed.tools.find(
      (tool) => tool.name === "compare_stress_test_revision",
    );
    const previewTool = listed.tools.find(
      (tool) => tool.name === "preview_faction_stress_portfolio",
    );
    const buildAndStressTool = listed.tools.find(
      (tool) =>
        tool.name ===
        "build_and_stress_roster_against_faction",
    );
    assert.ok(analyzeTool);
    assert.ok(compareTool);
    assert.ok(stressTool);
    assert.ok(stressRevisionTool);
    assert.ok(previewTool);
    assert.ok(buildAndStressTool);
    assert.equal(previewTool.annotations?.readOnlyHint, true);
    assert.equal(buildAndStressTool.annotations?.readOnlyHint, false);
    assert.equal(compareTool.annotations?.readOnlyHint, false);
    assert.equal(compareTool.annotations?.destructiveHint, false);
    assert.equal(compareTool.annotations?.idempotentHint, false);
    assert.equal(compareTool.annotations?.openWorldHint, true);
    assert.equal(stressTool.annotations?.readOnlyHint, false);
    assert.equal(stressTool.annotations?.destructiveHint, false);
    assert.equal(stressTool.annotations?.idempotentHint, false);
    assert.equal(stressTool.annotations?.openWorldHint, true);
    assert.equal(stressRevisionTool.annotations?.readOnlyHint, false);
    assert.equal(stressRevisionTool.annotations?.destructiveHint, false);
    assert.equal(stressRevisionTool.annotations?.idempotentHint, false);
    assert.equal(stressRevisionTool.annotations?.openWorldHint, true);

    const properties = (
      analyzeTool.inputSchema as {
        properties: Record<
          string,
          {
            default?: unknown;
            enum?: string[];
            items?: { enum?: string[] };
          }
        >;
      }
    ).properties;
    assert.deepEqual(properties.analysisMode.enum, ["quick", "full"]);
    assert.equal(properties.analysisMode.default, "full");
    assert.deepEqual(properties.phases.items?.enum, ["shooting", "fight"]);
    assert.deepEqual(properties.metrics.items?.enum, [
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ]);
    assert.equal(properties.allowPointMismatch.default, false);
    assert.equal(properties.includeChangeCandidates.default, true);
    const stressProperties = (
      stressTool.inputSchema as {
        properties: Record<
          string,
          {
            default?: unknown;
            enum?: string[];
          }
        >;
      }
    ).properties;
    assert.deepEqual(stressProperties.suite.enum, ["core-3", "diverse-9"]);
    assert.equal(stressProperties.suite.default, "diverse-9");
    assert.deepEqual(stressProperties.analysisStrategy.enum, [
      "staged",
      "full-all",
    ]);
    assert.equal(stressProperties.analysisStrategy.default, "staged");

    await client.callTool({
      name: "analyze_roster_matchup",
      arguments: {
        playerRoster: built.data,
        opponent: { kind: "rosz", path: "/fixture/opponent.rosz" },
      },
    });
    assert.deepEqual(analyses[0], {
      outputDirectory: "exports/tessera",
      overwrite: false,
      experimental: false,
      analysisMode: "full",
      phases: undefined,
      metrics: undefined,
      allowPointMismatch: false,
      includeChangeCandidates: true,
    });

    await client.callTool({
      name: "analyze_roster_matchup",
      arguments: {
        playerRoster: built.data,
        opponent: { kind: "rosz", path: "/fixture/opponent.rosz" },
        outputDirectory: "exports/quick",
        overwrite: true,
        experimental: true,
        analysisMode: "quick",
        phases: ["fight"],
        metrics: ["mean-damage"],
        allowPointMismatch: true,
        includeChangeCandidates: false,
      },
    });
    assert.deepEqual(analyses[1], {
      outputDirectory: "exports/quick",
      overwrite: true,
      experimental: true,
      analysisMode: "quick",
      phases: ["fight"],
      metrics: ["mean-damage"],
      allowPointMismatch: true,
      includeChangeCandidates: false,
    });

    await client.callTool({
      name: "compare_roster_revision",
      arguments: {
        baselineReportPath: "/fixture/baseline.json",
        revisedRoster: built.data,
        outputDirectory: "exports/revision",
        overwrite: true,
        experimental: true,
      },
    });
    assert.deepEqual(revision, {
      baselineReportPath: "/fixture/baseline.json",
      revisedRosterId: built.data.id,
      options: {
        outputDirectory: "exports/revision",
        overwrite: true,
        experimental: true,
      },
    });

    await client.callTool({
      name: "stress_test_roster_against_faction",
      arguments: {
        playerRoster: built.data,
        factionId: "aeldari",
      },
    });
    assert.deepEqual(stressTests[0], {
      rosterId: built.data.id,
      factionId: "aeldari",
      options: {
        suite: "diverse-9",
        analysisStrategy: "staged",
        resumeManifestPath: undefined,
        profilePolicyPath: undefined,
        forceRetry: false,
        outputDirectory: "exports/tessera",
        overwrite: false,
        experimental: false,
      },
    });

    await client.callTool({
      name: "stress_test_roster_against_faction",
      arguments: {
        playerRoster: built.data,
        factionId: "necrons",
        suite: "core-3",
        analysisStrategy: "full-all",
        resumeManifestPath: "/fixture/manifest.json",
        profilePolicyPath: undefined,
        forceRetry: false,
        outputDirectory: "exports/stress",
        overwrite: true,
        experimental: true,
      },
    });
    assert.deepEqual(stressTests[1], {
      rosterId: built.data.id,
      factionId: "necrons",
      options: {
        suite: "core-3",
        analysisStrategy: "full-all",
        resumeManifestPath: "/fixture/manifest.json",
        profilePolicyPath: undefined,
        forceRetry: false,
        outputDirectory: "exports/stress",
        overwrite: true,
        experimental: true,
      },
    });

    await client.callTool({
      name: "compare_stress_test_revision",
      arguments: {
        baselineReportPath: "/fixture/stress.json",
        revisedRoster: built.data,
        outputDirectory: "exports/stress-revision",
        overwrite: true,
        experimental: true,
      },
    });
    assert.deepEqual(stressRevision, {
      baselineReportPath: "/fixture/stress.json",
      revisedRosterId: built.data.id,
      options: {
        outputDirectory: "exports/stress-revision",
        overwrite: true,
        experimental: true,
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("hosted MCP omits local-only Tessera comparison tools", async () => {
  const server = createRosterPilotMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "rosterpilot-hosted-tessera-v2-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    assert.ok(
      !listed.tools.some((tool) => tool.name === "compare_roster_revision"),
    );
    assert.ok(
      !listed.tools.some(
        (tool) => tool.name === "stress_test_roster_against_faction",
      ),
    );
    assert.ok(
      !listed.tools.some(
        (tool) => tool.name === "compare_stress_test_revision",
      ),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("CLI help documents Tessera analysis and stress-test options", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", "cli/rosterpilot.ts", "help"],
    { cwd: process.cwd() },
  );

  assert.match(stdout, /--analysis-mode quick\|full/);
  assert.match(stdout, /--phases shooting,fight/);
  assert.match(
    stdout,
    /--metrics wipe-probability,half-wipe-probability,mean-kills,mean-damage/,
  );
  assert.match(stdout, /--allow-point-mismatch/);
  assert.match(stdout, /--no-change-candidates/);
  assert.match(
    stdout,
    /tessera compare-revision --baseline-report matchup\.json --revised-roster revised\.json/,
  );
  assert.match(
    stdout,
    /tessera stress-test --file roster\.json --against-faction aeldari/,
  );
  assert.match(stdout, /--suite core-3\|diverse-9/);
  assert.match(stdout, /--analysis staged\|full-all/);
  assert.match(
    stdout,
    /tessera compare-stress-revision --baseline-report stress-test\.json --revised-roster revised\.json/,
  );
});
