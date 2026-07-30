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
  type TesseraStressRunReport,
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
  outputDirectory?: string;
  overwrite: boolean;
  experimental: boolean;
};

type StressOptions = {
  suite: TesseraStressSuite;
  analysisStrategy: TesseraStressAnalysisStrategy;
  resumeManifestPath?: string;
  outputDirectory?: string;
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
    freshnessChecker: async () => ({
      ok: true,
      data: {
        checkedAt: "2026-07-30T00:00:00.000Z",
        state: "current",
        rules: {
          pinnedVersion: "fixture",
          latestVersion: "fixture",
          updateAvailable: false,
        },
        newRecruit: {
          pinnedCommit: "fixture",
          latestCommit: "fixture",
          updateAvailable: false,
        },
        official: {
          pinnedVersion: "fixture",
          latestVersion: "fixture",
          pinnedContentSha256: "a".repeat(64),
          latestContentSha256: "a".repeat(64),
          updateAvailable: false,
        },
      },
      violations: [],
      warnings: [],
    }),
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
    assert.equal(stressProperties.outputDirectory.default, undefined);
    assert.equal(stressProperties.responseDetail.default, "compact");

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
      executionMode: undefined,
      fallbackMode: "none",
      profilePolicyPath: undefined,
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
      executionMode: undefined,
      fallbackMode: "none",
      profilePolicyPath: undefined,
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

    const compactStress = await client.callTool({
      name: "stress_test_roster_against_faction",
      arguments: {
        playerRoster: built.data,
        factionId: "aeldari",
      },
    });
    assert.equal(
      (
        compactStress.structuredContent as {
          warningCount?: number;
        }
      ).warningCount,
      0,
    );
    assert.deepEqual(stressTests[0], {
      rosterId: built.data.id,
      factionId: "aeldari",
      options: {
        suite: "diverse-9",
        analysisStrategy: "staged",
        resumeManifestPath: undefined,
        restartManifestPath: undefined,
        profilePolicyPath: undefined,
        forceRetry: false,
        executionMode: undefined,
        outputDirectory: undefined,
        overwrite: false,
        experimental: false,
      },
    });

    const fullStress = await client.callTool({
      name: "stress_test_roster_against_faction",
      arguments: {
        playerRoster: built.data,
        factionId: "necrons",
        suite: "core-3",
        analysisStrategy: "full-all",
        resumeManifestPath: "/fixture/manifest.json",
        restartManifestPath: undefined,
        profilePolicyPath: undefined,
        forceRetry: false,
        executionMode: undefined,
        outputDirectory: "exports/stress",
        overwrite: true,
        experimental: true,
        responseDetail: "full",
      },
    });
    assert.equal(
      Object.hasOwn(
        fullStress.structuredContent as object,
        "warningCount",
      ),
      false,
    );
    assert.deepEqual(stressTests[1], {
      rosterId: built.data.id,
      factionId: "necrons",
      options: {
        suite: "core-3",
        analysisStrategy: "full-all",
        resumeManifestPath: "/fixture/manifest.json",
        restartManifestPath: undefined,
        profilePolicyPath: undefined,
        forceRetry: false,
        executionMode: undefined,
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

test("compact Astra stress handoff stays bounded and preserves freshness and artifact paths", async () => {
  const built = buildRoster({
    faction: "astra-militarum",
    pointsLimit: 1000,
    name: "Astra Militarum 1000 vs Custodes",
    opponentContext: {
      kind: "known-faction",
      factionId: "adeptus-custodes",
    },
  });
  assert.ok(built.ok && built.data);

  const report = {
    schemaVersion: 3,
    reportKind: "tessera-stress-test",
    runId: "12345678-compact-astra",
    status: "complete",
    statusExplanation: "All three core postures completed.",
    player: {
      rosterName: built.data.name,
      factionId: built.data.factionId,
      summary: {
        factionName: built.data.factionName,
        totalPoints: built.data.totalPoints,
      },
    },
    opponentFactionId: "adeptus-custodes",
    suite: "core-3",
    portfolio: {
      factionName: "Adeptus Custodes",
      pointsLimit: 1000,
      coverage: {
        requested: 3,
        ready: 3,
        blocked: 0,
        requestedPostures: [
          "balanced-control",
          "ranged-pressure",
          "assault-pressure",
        ],
        representedPostures: [
          "balanced-control",
          "ranged-pressure",
          "assault-pressure",
        ],
        missingPostures: [],
        requestedCompositions: [],
        representedCompositions: ["elite-heavy"],
        missingCompositions: [],
        requestedCells: [],
        representedCells: [],
        missingCells: [],
        uniqueSimulationFingerprints: 3,
        minimumExecutable: 3,
        executable: true,
        maximumResultStatus: "complete",
      },
    },
    integrity: { status: "trusted", issues: [] },
    failures: [],
    recovery: {
      manifest:
        "exports/tessera/astra-vs-custodes/stress-manifest.json",
      screeningAttempts: 3,
      deepDiveAttempts: 3,
      exhaustedTemplates: [],
      nextActions: [],
      verifiedPreparedPlayer: true,
      verifiedPreparedOpponents: 3,
    },
    preparation: {
      status: "complete",
      source: "new-recruit",
      uniqueRosters: 4,
      remoteMutations: 4,
      cacheReuses: 0,
      connectorEvents: [],
    },
    simulation: {
      requested: true,
      status: "complete",
      engine: "tessera-ui",
      trustedMatrices: 48,
    },
    representatives: [],
    robustness: null,
    pinnedData: {
      cachedLiveUpdateCheck: {
        checkedAt: "2026-07-30T00:00:00.000Z",
        state: "update-available",
      },
    },
    artifacts: [
      {
        format: "stress-json",
        written: "stress-report.json",
        sha256: "a".repeat(64),
      },
      {
        format: "stress-html",
        written: "stress-report.html",
        sha256: "b".repeat(64),
      },
    ],
    oversizedDiagnostics: "x".repeat(75_000),
  } as unknown as TesseraStressRunReport;

  const server = createRosterPilotMcpServer({
    freshnessChecker: async () => ({
      ok: true,
      data: {
        checkedAt: "2026-07-30T00:00:00.000Z",
        state: "update-available",
        rules: {
          pinnedVersion: "1.0.0",
          latestVersion: "1.0.1",
          updateAvailable: true,
        },
        newRecruit: {
          pinnedCommit: "a".repeat(40),
          latestCommit: "b".repeat(40),
          updateAvailable: true,
        },
        official: {
          pinnedVersion: "1.0",
          latestVersion: "1.0",
          pinnedContentSha256: "c".repeat(64),
          latestContentSha256: "c".repeat(64),
          updateAvailable: false,
        },
      },
      violations: [],
      warnings: [
        {
          code: "DATA_UPDATE_AVAILABLE",
          message:
            "Newer data is available; this run remains pinned.",
          severity: "warn",
        },
      ],
    }),
    tesseraCompanion: {
      status: async () => notInvoked("STATUS_FIXTURE"),
      prepare: async () => notInvoked("PREPARE_FIXTURE"),
      analyze: async () => notInvoked("ANALYZE_FIXTURE"),
      stressTest: async () => ({
        ok: true,
        data: report,
        violations: [],
        warnings: [],
      }),
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "rosterpilot-compact-stress-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const compact = await client.callTool({
      name: "stress_test_roster_against_faction",
      arguments: {
        playerRoster: built.data,
        factionId: "adeptus-custodes",
        suite: "core-3",
      },
    });
    const compactPayload =
      compact.structuredContent as Record<string, unknown>;
    assert.ok(
      Buffer.byteLength(JSON.stringify(compactPayload)) <
        50_000,
    );
    assert.equal(compactPayload.warningCount, 1);
    assert.equal(
      (
        compactPayload.warnings as Array<{
          code: string;
        }>
      )[0].code,
      "DATA_UPDATE_AVAILABLE",
    );
    assert.equal(
      (
        compactPayload.data as {
          artifactPaths: unknown[];
        }
      ).artifactPaths.length,
      2,
    );
    assert.equal(
      Object.hasOwn(
        compactPayload.data as object,
        "oversizedDiagnostics",
      ),
      false,
    );

    const full = await client.callTool({
      name: "stress_test_roster_against_faction",
      arguments: {
        playerRoster: built.data,
        factionId: "adeptus-custodes",
        suite: "core-3",
        responseDetail: "full",
      },
    });
    assert.equal(
      (
        (
          full.structuredContent as {
            data: { oversizedDiagnostics: string };
          }
        ).data.oversizedDiagnostics
      ).length,
      75_000,
    );
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
  assert.match(stdout, /--restart-from manifest\.json/);
  assert.match(
    stdout,
    /verified prepared artifacts are reused/,
  );
  assert.match(
    stdout,
    /tessera compare-stress-revision --baseline-report stress-test\.json --revised-roster revised\.json/,
  );
});
