import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildRoster } from "../lib/rosterpilot";
import type {
  TesseraRunJob,
  TesseraRunRequest,
} from "../local/tessera/jobs";
import { createRosterPilotMcpServer } from "../mcp/server";

const run = promisify(execFile);

function notInvoked(code: string) {
  return {
    ok: false as const,
    data: null,
    violations: [
      {
        code,
        message: "The synchronous Tessera companion must not run.",
        severity: "error" as const,
      },
    ],
    warnings: [],
  };
}

function fixtureJob(
  request: TesseraRunRequest,
  sequence: number,
): TesseraRunJob {
  const runId = `transport-parity-${sequence}`;
  const jobDirectory = `/fixture/tessera-runs/${runId}`;
  return {
    schemaVersion: 1,
    jobKind: "rosterpilot-tessera-run",
    runId,
    runKind: request.kind,
    status: "queued",
    createdAt: "2026-07-30T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempt: 0,
    workerPid: null,
    workerTokenSha256: null,
    jobDirectory,
    rootDirectory: "/fixture",
    requestPath: `${jobDirectory}/request.json`,
    resultPath: `${jobDirectory}/result.json`,
    manifestPath: `${jobDirectory}/manifest.json`,
    profilePolicyPath: null,
    inputArtifacts: [],
    requestSha256: "a".repeat(64),
    dataPins: [],
    dataPinSha256: "b".repeat(64),
    profilePolicySha256: null,
    artifactReceipts: [],
    preparedCheckpoint: null,
    runtimeProvenance: {
      rosterPilotVersion: "fixture",
      rulesPackageVersion: "fixture",
      stressGeneratorVersion: "fixture",
      processStartedAt: "2026-07-30T00:00:00.000Z",
      gitHead: null,
      sourceFingerprintAtStart: "fixture",
      sourceFingerprintNow: "fixture",
      buildId: "fixture",
      stale: false,
    },
    runtimeIdentitySha256: "c".repeat(64),
    simulationStage: 1,
    restartFrom: null,
    retryBudget: {
      automaticAttemptLimit: 3,
      lifetimeAttemptLimit: 5,
      automaticAttemptsRemaining: 3,
      lifetimeAttemptsRemaining: 5,
      exhausted: false,
      explicitRestartRequired: false,
    },
    attemptHistory: [],
    profileResolution: null,
    error: null,
    nextAction: "Poll the run status.",
  };
}

test("MCP exact routes fail closed without opponent scope and accept an exact roster", async () => {
  const player = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "MCP opponent scope player",
  });
  const opponent = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    name: "MCP opponent scope opponent",
  });
  assert.ok(player.ok && player.data);
  assert.ok(opponent.ok && opponent.data);

  const requests: TesseraRunRequest[] = [];
  let synchronousAnalyzeCalls = 0;
  const server = createRosterPilotMcpServer({
    tesseraCompanion: {
      status: async () => notInvoked("STATUS_NOT_EXPECTED"),
      prepare: async () => notInvoked("PREPARE_NOT_EXPECTED"),
      analyze: async () => {
        synchronousAnalyzeCalls += 1;
        return notInvoked("ANALYZE_NOT_EXPECTED");
      },
    },
    tesseraRunJobs: {
      start: async (request) => {
        requests.push(request);
        return fixtureJob(request, requests.length);
      },
      status: async () => {
        throw new Error("Job status was not expected.");
      },
      resume: async () => {
        throw new Error("Job resume was not expected.");
      },
      resolveProfiles: async () => {
        throw new Error("Profile resolution was not expected.");
      },
      cancel: async () => {
        throw new Error("Job cancellation was not expected.");
      },
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "rosterpilot-opponent-scope-mcp-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const omittedResponses = [
      await client.callTool({
        name: "analyze_roster_matchup",
        arguments: {
          playerRoster: player.data,
          executionMode: "simulate",
        },
      }),
      await client.callTool({
        name: "start_tessera_run",
        arguments: {
          request: {
            kind: "exact",
            playerRoster: player.data,
            executionMode: "simulate",
          },
        },
      }),
    ];

    for (const response of omittedResponses) {
      assert.equal(response.isError, true);
      const structured = response.structuredContent as {
        ok: boolean;
        violations: Array<{
          code: string;
          severity: string;
        }>;
      };
      assert.equal(structured.ok, false);
      assert.deepEqual(structured.violations, [
        {
          code: "OPPONENT_SCOPE_REQUIRED",
          message:
            "Provide an exact opponent roster or .rosz, or use the faction stress workflow when only the opponent faction is known.",
          severity: "error",
        },
      ]);
    }
    assert.equal(requests.length, 0);
    assert.equal(synchronousAnalyzeCalls, 0);

    const specifiedResponses = [
      await client.callTool({
        name: "analyze_roster_matchup",
        arguments: {
          playerRoster: player.data,
          opponent: {
            kind: "roster",
            roster: opponent.data,
          },
          executionMode: "simulate",
        },
      }),
      await client.callTool({
        name: "start_tessera_run",
        arguments: {
          request: {
            kind: "exact",
            playerRoster: player.data,
            opponent: {
              kind: "roster",
              roster: opponent.data,
            },
            executionMode: "simulate",
          },
        },
      }),
    ];

    assert.equal(specifiedResponses[0].isError, undefined);
    assert.equal(specifiedResponses[1].isError, undefined);
    assert.equal(
      (
        specifiedResponses[0].structuredContent as {
          status: string;
        }
      ).status,
      "in-progress",
    );
    assert.equal(
      (
        specifiedResponses[1].structuredContent as {
          status: string;
        }
      ).status,
      "queued",
    );
    for (const [index, response] of specifiedResponses.entries()) {
      assert.equal(
        (response.structuredContent as { runId: string }).runId,
        `transport-parity-${index + 1}`,
      );
    }
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.kind, "exact");
      if (request.kind !== "exact") {
        throw new Error("Expected an exact Tessera request.");
      }
      assert.equal(request.opponent.kind, "roster");
      if (request.opponent.kind !== "roster") {
        throw new Error("Expected a canonical opponent roster.");
      }
      assert.equal(request.opponent.roster.id, opponent.data.id);
      assert.equal(request.options?.executionMode, "simulate");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("simulate-mode MCP matchup tools start durable jobs without synchronous fallback", async () => {
  const player = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Transport parity player",
  });
  const opponent = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    name: "Transport parity opponent",
  });
  assert.ok(player.ok && player.data);
  assert.ok(opponent.ok && opponent.data);

  const requests: TesseraRunRequest[] = [];
  const synchronousCalls = {
    analyze: 0,
    stressTest: 0,
    buildAndStress: 0,
    buildAndAnalyze: 0,
    compare: 0,
    compareStressRevision: 0,
  };
  const resumeCalls: Array<{
    jobPath: string;
    restartFrom: boolean | undefined;
    outputDirectory: string | undefined;
  }> = [];
  let freshnessCalls = 0;
  const server = createRosterPilotMcpServer({
    freshnessChecker: async () => {
      freshnessCalls += 1;
      throw new Error("Durable job handoff should not check freshness inline.");
    },
    tesseraCompanion: {
      status: async () => notInvoked("STATUS_SYNC_CALLED"),
      prepare: async () => notInvoked("PREPARE_SYNC_CALLED"),
      analyze: async () => {
        synchronousCalls.analyze += 1;
        return notInvoked("ANALYZE_SYNC_CALLED");
      },
      stressTest: async () => {
        synchronousCalls.stressTest += 1;
        return notInvoked("STRESS_SYNC_CALLED");
      },
      buildAndStress: async () => {
        synchronousCalls.buildAndStress += 1;
        return notInvoked("BUILD_AND_STRESS_SYNC_CALLED");
      },
      buildAndAnalyze: async () => {
        synchronousCalls.buildAndAnalyze += 1;
        return notInvoked("BUILD_AND_ANALYZE_SYNC_CALLED");
      },
      compare: async () => {
        synchronousCalls.compare += 1;
        return notInvoked("COMPARE_SYNC_CALLED");
      },
      compareStressRevision: async () => {
        synchronousCalls.compareStressRevision += 1;
        return notInvoked(
          "COMPARE_STRESS_REVISION_SYNC_CALLED",
        );
      },
    },
    tesseraRunJobs: {
      start: async (request) => {
        requests.push(request);
        return fixtureJob(request, requests.length);
      },
      status: async () => {
        throw new Error("Job status was not expected.");
      },
      resume: async (jobPath, options) => {
        resumeCalls.push({
          jobPath,
          restartFrom: options?.restartFrom,
          outputDirectory: options?.outputDirectory,
        });
        return fixtureJob(
          {
            kind: "stress",
            playerRoster: player.data!,
            factionId: "aeldari",
          },
          99,
        );
      },
      resolveProfiles: async () => {
        throw new Error("Profile resolution was not expected.");
      },
      cancel: async () => {
        throw new Error("Job cancellation was not expected.");
      },
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "rosterpilot-tessera-transport-parity-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const responses = [
      await client.callTool({
        name: "analyze_roster_matchup",
        arguments: {
          playerRoster: player.data,
          opponent: {
            kind: "roster",
            roster: opponent.data,
          },
          executionMode: "simulate",
        },
      }),
      await client.callTool({
        name: "stress_test_roster_against_faction",
        arguments: {
          playerRoster: player.data,
          factionId: "aeldari",
          executionMode: "simulate",
        },
      }),
      await client.callTool({
        name: "build_and_stress_roster_against_faction",
        arguments: {
          prompt: "Build a 1,000-point Custodes roster",
          playerFaction: "adeptus-custodes",
          againstFaction: "aeldari",
          pointsLimit: 1000,
          executionMode: "simulate",
        },
      }),
      await client.callTool({
        name: "build_and_analyze_roster_matchup",
        arguments: {
          prompt: "Build a 1,000-point Custodes roster",
          playerFaction: "adeptus-custodes",
          pointsLimit: 1000,
          opponentRoster: opponent.data,
          executionMode: "simulate",
        },
      }),
      await client.callTool({
        name: "compare_roster_revision",
        arguments: {
          baselineReportPath: "/fixture/exact-baseline.json",
          revisedRoster: player.data,
        },
      }),
      await client.callTool({
        name: "compare_stress_test_revision",
        arguments: {
          baselineReportPath: "/fixture/stress-baseline.json",
          revisedRoster: player.data,
        },
      }),
      await client.callTool({
        name: "stress_test_roster_against_faction",
        arguments: {
          playerRoster: player.data,
          factionId: "aeldari",
          resumeManifestPath:
            "/fixture/legacy-stress-manifest.json",
        },
      }),
    ];

    for (const [index, response] of responses.entries()) {
      const content = response.structuredContent as {
        status?: string;
        runId?: string;
        manifestPath?: string;
      };
      assert.equal(content.status, "in-progress");
      assert.equal(content.runId, `transport-parity-${index + 1}`);
      assert.equal(
        content.manifestPath,
        `/fixture/tessera-runs/transport-parity-${index + 1}/manifest.json`,
      );
      assert.equal(response.isError, undefined);
    }

    assert.deepEqual(synchronousCalls, {
      analyze: 0,
      stressTest: 0,
      buildAndStress: 0,
      buildAndAnalyze: 0,
      compare: 0,
      compareStressRevision: 0,
    });
    assert.equal(freshnessCalls, 0);
    assert.deepEqual(
      requests.map((request) => request.kind),
      [
        "exact",
        "stress",
        "build-and-stress",
        "build-and-analyze",
        "exact-revision",
        "stress-revision",
        "stress",
      ],
    );

    const stressRequest = requests[1];
    assert.equal(stressRequest.kind, "stress");
    if (stressRequest.kind !== "stress") {
      throw new Error("Expected a stress job request.");
    }
    assert.equal(stressRequest.options?.suite, undefined);
    assert.equal(
      stressRequest.options?.analysisStrategy,
      undefined,
    );
    assert.equal(
      stressRequest.options?.executionMode,
      "simulate",
    );

    const buildAndStressRequest = requests[2];
    assert.equal(buildAndStressRequest.kind, "build-and-stress");
    if (buildAndStressRequest.kind !== "build-and-stress") {
      throw new Error("Expected a build-and-stress job request.");
    }
    assert.equal(buildAndStressRequest.input.suite, undefined);
    assert.equal(
      buildAndStressRequest.input.analysisStrategy,
      undefined,
    );
    assert.equal(
      buildAndStressRequest.input.executionMode,
      "simulate",
    );
    const adoptedStressRequest = requests[6];
    assert.equal(adoptedStressRequest.kind, "stress");
    if (adoptedStressRequest.kind !== "stress") {
      throw new Error("Expected an adopted stress job request.");
    }
    assert.equal(
      adoptedStressRequest.options?.resumeManifestPath,
      "/fixture/legacy-stress-manifest.json",
    );
    assert.equal(
      adoptedStressRequest.options?.executionMode,
      "simulate",
    );

    const restarted = await client.callTool({
      name: "resume_tessera_run",
      arguments: {
        jobPath: "/fixture/prior/tessera-run.json",
        restartFrom: true,
        outputDirectory: "/fixture/restarted",
      },
    });
    assert.equal(restarted.isError, undefined);
    assert.deepEqual(resumeCalls, [
      {
        jobPath: "/fixture/prior/tessera-run.json",
        restartFrom: true,
        outputDirectory: "/fixture/restarted",
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("CLI simulate compatibility starts a durable job with centralized defaults", async () => {
  const player = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "CLI durable transport parity",
  });
  assert.ok(player.ok && player.data);

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-cli-durable-"),
  );
  const rosterPath = path.join(temporaryDirectory, "roster.json");
  const capturePath = path.join(temporaryDirectory, "capture.json");
  const preloadPath = path.join(temporaryDirectory, "preload.mjs");
  const stubPath = path.join(temporaryDirectory, "jobs-stub.mjs");
  try {
    await Promise.all([
      writeFile(
        rosterPath,
        `${JSON.stringify(player.data, null, 2)}\n`,
      ),
      writeFile(
        preloadPath,
        [
          'import { registerHooks } from "node:module";',
          `const stubUrl = ${JSON.stringify(new URL(`file://${stubPath}`).href)};`,
          "registerHooks({",
          "  resolve(specifier, context, nextResolve) {",
          "    if (",
          '      specifier === "../local/tessera/jobs" &&',
          '      context.parentURL?.endsWith("/cli/rosterpilot.ts")',
          "    ) {",
          "      return { url: stubUrl, shortCircuit: true };",
          "    }",
          "    return nextResolve(specifier, context);",
          "  },",
          "});",
          "",
        ].join("\n"),
      ),
      writeFile(
        stubPath,
        [
          'import { writeFileSync } from "node:fs";',
          "",
          "export async function startTesseraRun(request, options) {",
          "  writeFileSync(",
          "    process.env.ROSTERPILOT_CLI_CAPTURE,",
          "    JSON.stringify({ request, options }),",
          "  );",
          "  return {",
          '    runId: "cli-durable-run",',
          '    manifestPath: "/fixture/cli-durable/manifest.json",',
          '    status: "queued",',
          "  };",
          "}",
          "export async function getTesseraRunStatus() { throw new Error('unexpected'); }",
          "export async function resumeTesseraRun() { throw new Error('unexpected'); }",
          "export async function resolveTesseraRunProfiles() { throw new Error('unexpected'); }",
          "export async function cancelTesseraRun() { throw new Error('unexpected'); }",
          "",
        ].join("\n"),
      ),
    ]);

    const { stdout } = await run(
      process.execPath,
      [
        "--import",
        preloadPath,
        "--import",
        "tsx",
        path.join(process.cwd(), "cli/rosterpilot.ts"),
        "tessera",
        "stress-test",
        "--file",
        rosterPath,
        "--against-faction",
        "aeldari",
        "--execution-mode",
        "simulate",
        "--out-dir",
        temporaryDirectory,
        "--allow-outside-root",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ROSTERPILOT_CLI_CAPTURE: capturePath,
        },
      },
    );

    const response = JSON.parse(stdout) as {
      status: string;
      runId: string;
    };
    assert.equal(response.status, "in-progress");
    assert.equal(response.runId, "cli-durable-run");
    const captured = JSON.parse(
      await readFile(capturePath, "utf8"),
    ) as {
      request: TesseraRunRequest;
      options: {
        outputDirectory: string;
      };
    };
    assert.equal(captured.request.kind, "stress");
    if (captured.request.kind !== "stress") {
      throw new Error("Expected a stress request.");
    }
    assert.equal(captured.request.options?.suite, undefined);
    assert.equal(
      captured.request.options?.analysisStrategy,
      undefined,
    );
    assert.equal(
      captured.request.options?.executionMode,
      "simulate",
    );
    assert.equal(
      captured.options.outputDirectory,
      temporaryDirectory,
    );
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
});

test("CLI exact routes report missing opponent scope and accept an exact roster", async () => {
  const player = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "CLI opponent scope player",
  });
  const opponent = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    name: "CLI opponent scope opponent",
  });
  assert.ok(player.ok && player.data);
  assert.ok(opponent.ok && opponent.data);

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-cli-opponent-scope-"),
  );
  const playerPath = path.join(temporaryDirectory, "player.json");
  const opponentPath = path.join(
    temporaryDirectory,
    "opponent.json",
  );
  const capturePath = path.join(temporaryDirectory, "capture.jsonl");
  const preloadPath = path.join(temporaryDirectory, "preload.mjs");
  const stubPath = path.join(temporaryDirectory, "jobs-stub.mjs");
  const cliPath = path.join(process.cwd(), "cli/rosterpilot.ts");
  const commonArguments = [
    "--import",
    preloadPath,
    "--import",
    "tsx",
    cliPath,
    "tessera",
  ];

  try {
    await Promise.all([
      writeFile(
        playerPath,
        `${JSON.stringify(player.data, null, 2)}\n`,
      ),
      writeFile(
        opponentPath,
        `${JSON.stringify(opponent.data, null, 2)}\n`,
      ),
      writeFile(
        preloadPath,
        [
          'import { registerHooks } from "node:module";',
          `const stubUrl = ${JSON.stringify(new URL(`file://${stubPath}`).href)};`,
          "registerHooks({",
          "  resolve(specifier, context, nextResolve) {",
          "    if (",
          '      specifier === "../local/tessera/jobs" &&',
          '      context.parentURL?.endsWith("/cli/rosterpilot.ts")',
          "    ) {",
          "      return { url: stubUrl, shortCircuit: true };",
          "    }",
          "    return nextResolve(specifier, context);",
          "  },",
          "});",
          "",
        ].join("\n"),
      ),
      writeFile(
        stubPath,
        [
          'import { appendFileSync } from "node:fs";',
          "",
          "export async function startTesseraRun(request, options) {",
          "  appendFileSync(",
          "    process.env.ROSTERPILOT_CLI_CAPTURE,",
          '    `${JSON.stringify({ request, options })}\\n`,',
          "  );",
          "  return {",
          '    runId: "cli-exact-scope-run",',
          '    manifestPath: "/fixture/cli-exact/manifest.json",',
          '    status: "queued",',
          "  };",
          "}",
          "export async function getTesseraRunStatus() { throw new Error('unexpected'); }",
          "export async function resumeTesseraRun() { throw new Error('unexpected'); }",
          "export async function resolveTesseraRunProfiles() { throw new Error('unexpected'); }",
          "export async function cancelTesseraRun() { throw new Error('unexpected'); }",
          "",
        ].join("\n"),
      ),
    ]);

    for (const commandArguments of [
      ["analyze", "--file", playerPath],
      [
        "start-run",
        "--run-kind",
        "exact",
        "--file",
        playerPath,
      ],
    ]) {
      await assert.rejects(
        run(process.execPath, [...commonArguments, ...commandArguments], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ROSTERPILOT_CLI_CAPTURE: capturePath,
          },
        }),
        (error: unknown) => {
          const failure = error as {
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          assert.equal(failure.code, 1);
          assert.equal(failure.stdout, "");
          assert.match(
            failure.stderr ?? "",
            /OPPONENT_SCOPE_REQUIRED/,
          );
          return true;
        },
      );
    }

    const specifiedOutputs = [];
    for (const commandArguments of [
      [
        "analyze",
        "--file",
        playerPath,
        "--opponent-roster",
        opponentPath,
        "--execution-mode",
        "simulate",
        "--out-dir",
        temporaryDirectory,
        "--allow-outside-root",
      ],
      [
        "start-run",
        "--run-kind",
        "exact",
        "--file",
        playerPath,
        "--opponent-roster",
        opponentPath,
        "--execution-mode",
        "simulate",
        "--out-dir",
        temporaryDirectory,
        "--allow-outside-root",
      ],
    ]) {
      specifiedOutputs.push(
        await run(
          process.execPath,
          [...commonArguments, ...commandArguments],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              ROSTERPILOT_CLI_CAPTURE: capturePath,
            },
          },
        ),
      );
    }

    const parsedOutputs = specifiedOutputs.map(
      ({ stdout }) =>
        JSON.parse(stdout) as {
          status: string;
          runId: string;
        },
    );
    assert.equal(parsedOutputs[0].status, "in-progress");
    assert.equal(parsedOutputs[1].status, "queued");
    assert.equal(parsedOutputs[0].runId, "cli-exact-scope-run");
    assert.equal(parsedOutputs[1].runId, "cli-exact-scope-run");
    const captured = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            request: TesseraRunRequest;
          },
      );
    assert.equal(captured.length, 2);
    for (const entry of captured) {
      assert.equal(entry.request.kind, "exact");
      if (entry.request.kind !== "exact") {
        throw new Error("Expected an exact Tessera request.");
      }
      assert.equal(entry.request.opponent.kind, "roster");
      if (entry.request.opponent.kind !== "roster") {
        throw new Error("Expected a canonical opponent roster.");
      }
      assert.equal(entry.request.opponent.roster.id, opponent.data.id);
      assert.equal(
        entry.request.options?.executionMode,
        "simulate",
      );
    }
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
});

test("CLI stress resume leaves omitted suite and analysis strategy unset", async () => {
  const player = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "CLI resume transport parity",
  });
  assert.ok(player.ok && player.data);

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-cli-resume-"),
  );
  const rosterPath = path.join(temporaryDirectory, "roster.json");
  const manifestPath = path.join(
    temporaryDirectory,
    "stress-manifest.json",
  );
  const capturePath = path.join(temporaryDirectory, "capture.json");
  const preloadPath = path.join(temporaryDirectory, "preload.mjs");
  const stubPath = path.join(temporaryDirectory, "jobs-stub.mjs");

  try {
    await Promise.all([
      writeFile(
        rosterPath,
        `${JSON.stringify(player.data, null, 2)}\n`,
      ),
      writeFile(
        preloadPath,
        [
          'import { registerHooks } from "node:module";',
          `const stubUrl = ${JSON.stringify(new URL(`file://${stubPath}`).href)};`,
          "registerHooks({",
          "  resolve(specifier, context, nextResolve) {",
          "    if (",
          '      specifier === "../local/tessera/jobs" &&',
          '      context.parentURL?.endsWith("/cli/rosterpilot.ts")',
          "    ) {",
          "      return { url: stubUrl, shortCircuit: true };",
          "    }",
          "    return nextResolve(specifier, context);",
          "  },",
          "});",
          "",
        ].join("\n"),
      ),
      writeFile(
        stubPath,
        [
          'import { writeFileSync } from "node:fs";',
          "",
          "export async function startTesseraRun(request) {",
          "  writeFileSync(",
          "    process.env.ROSTERPILOT_CLI_CAPTURE,",
          "    JSON.stringify({",
          "      suiteType: typeof request.options.suite,",
          "      analysisStrategyType:",
          "        typeof request.options.analysisStrategy,",
          "      resumeManifestPath:",
          "        request.options.resumeManifestPath,",
          "    }),",
          "  );",
          "  return {",
          '    runId: "cli-resume-durable-run",',
          '    manifestPath: "/fixture/manifest.json",',
          '    status: "queued",',
          "  };",
          "}",
          "export async function getTesseraRunStatus() { throw new Error('unexpected'); }",
          "export async function resumeTesseraRun() { throw new Error('unexpected'); }",
          "export async function resolveTesseraRunProfiles() { throw new Error('unexpected'); }",
          "export async function cancelTesseraRun() { throw new Error('unexpected'); }",
          "",
        ].join("\n"),
      ),
    ]);

    await run(
      process.execPath,
      [
        "--import",
        preloadPath,
        "--import",
        "tsx",
        path.join(process.cwd(), "cli/rosterpilot.ts"),
        "tessera",
        "stress-test",
        "--file",
        rosterPath,
        "--against-faction",
        "aeldari",
        "--resume",
        manifestPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ROSTERPILOT_CLI_CAPTURE: capturePath,
        },
      },
    );

    const captured = JSON.parse(
      await readFile(capturePath, "utf8"),
    ) as {
      suiteType: string;
      analysisStrategyType: string;
      resumeManifestPath: string;
    };
    assert.deepEqual(captured, {
      suiteType: "undefined",
      analysisStrategyType: "undefined",
      resumeManifestPath: path.resolve(manifestPath),
    });
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
});
