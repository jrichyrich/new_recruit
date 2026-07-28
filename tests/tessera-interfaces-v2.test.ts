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

test("local MCP exposes Tessera v2 schemas and forwards analysis defaults", async () => {
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
    assert.ok(analyzeTool);
    assert.ok(compareTool);
    assert.equal(compareTool.annotations?.readOnlyHint, false);
    assert.equal(compareTool.annotations?.destructiveHint, false);
    assert.equal(compareTool.annotations?.idempotentHint, false);
    assert.equal(compareTool.annotations?.openWorldHint, true);

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
  } finally {
    await client.close();
    await server.close();
  }
});

test("hosted MCP omits the Tessera revision comparison tool", async () => {
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
  } finally {
    await client.close();
    await server.close();
  }
});

test("CLI help documents Tessera v2 analysis and revision options", async () => {
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
});
