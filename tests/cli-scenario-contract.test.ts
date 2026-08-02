import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { buildRoster } from "../lib/rosterpilot";
import {
  localTesseraScenarioContract,
} from "../local/tessera/scenario-contract";

const run = promisify(execFile);

function rosterFixture() {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
  });
  assert.ok(built.ok && built.data);
  return built.data;
}

function jobsModuleHookFiles(stubPath: string) {
  return {
    preload: [
      'import { register } from "node:module";',
      'register(new URL("./hooks.mjs", import.meta.url), import.meta.url, {',
      `  data: { stubUrl: ${JSON.stringify(pathToFileURL(stubPath).href)} },`,
      "});",
      "",
    ].join("\n"),
    hooks: [
      "let stubUrl;",
      "export function initialize(data) { stubUrl = data.stubUrl; }",
      "export function resolve(specifier, context, nextResolve) {",
      "  if (",
      '    specifier === "../local/tessera/jobs" &&',
      '    context.parentURL?.endsWith("/cli/rosterpilot.ts")',
      "  ) {",
      "    return { url: stubUrl, shortCircuit: true };",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "",
    ].join("\n"),
  };
}

test("CLI iteration sugar and explicit JSON forward one canonical durable contract", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-cli-scenario-contract-"),
  );
  const stubPath = path.join(directory, "jobs-stub.mjs");
  const preloadPath = path.join(directory, "preload.mjs");
  const hooksPath = path.join(directory, "hooks.mjs");
  const contractPath = path.join(directory, "contract.json");
  const hooks = jobsModuleHookFiles(stubPath);
  const fixture = path.join(directory, "roster.json");
  try {
    const contract = localTesseraScenarioContract(2_000);
    await Promise.all([
      writeFile(
        stubPath,
        [
          "export async function startTesseraRun(request) {",
          '  return { status: "queued", request };',
          "}",
          "export async function getTesseraRunStatus() { throw new Error('not expected'); }",
          "export async function resolveTesseraRunProfiles() { throw new Error('not expected'); }",
          "export async function resumeTesseraRun() { throw new Error('not expected'); }",
          "export async function cancelTesseraRun() { throw new Error('not expected'); }",
          "",
        ].join("\n"),
      ),
      writeFile(preloadPath, hooks.preload),
      writeFile(hooksPath, hooks.hooks),
      writeFile(
        contractPath,
        `${JSON.stringify([...contract].reverse(), null, 2)}\n`,
      ),
      writeFile(
        fixture,
        `${JSON.stringify(rosterFixture(), null, 2)}\n`,
      ),
    ]);
    const prefix = [
      "--import",
      "tsx",
      "--import",
      preloadPath,
      path.join(process.cwd(), "cli/rosterpilot.ts"),
      "tessera",
      "start-run",
      "--run-kind",
      "exact",
      "--file",
      fixture,
      "--opponent-roster",
      fixture,
      "--execution-mode",
      "simulate",
      "--simulation-backend",
      "local-engine",
    ];
    const [iterationsRun, explicitRun] = await Promise.all([
      run(
        process.execPath,
        [
          ...prefix,
          "--iterations",
          "2000",
          "--enforce-provider-compatibility",
        ],
        { cwd: process.cwd() },
      ),
      run(
        process.execPath,
        [...prefix, "--scenario-contract", contractPath],
        { cwd: process.cwd() },
      ),
    ]);
    const fromIterations = JSON.parse(iterationsRun.stdout) as {
      request: {
        options: {
          scenarioContract: unknown;
          providerCompatibilityMode: string;
        };
      };
    };
    const fromFile = JSON.parse(explicitRun.stdout) as {
      request: {
        options: {
          scenarioContract: unknown;
          providerCompatibilityMode: string;
        };
      };
    };
    assert.deepEqual(
      fromIterations.request.options.scenarioContract,
      contract,
    );
    assert.deepEqual(
      fromFile.request.options.scenarioContract,
      contract,
    );
    assert.equal(
      fromIterations.request.options.providerCompatibilityMode,
      "enforce",
    );
    assert.equal(
      fromFile.request.options.providerCompatibilityMode,
      "observe",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects conflicting, non-positive, provider-ambiguous, and scope-mismatched replay inputs", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-cli-scenario-reject-"),
  );
  const contractPath = path.join(directory, "contract.json");
  const fixture = path.join(directory, "roster.json");
  try {
    await Promise.all([
      writeFile(
        contractPath,
        `${JSON.stringify(localTesseraScenarioContract(100), null, 2)}\n`,
      ),
      writeFile(
        fixture,
        `${JSON.stringify(rosterFixture(), null, 2)}\n`,
      ),
    ]);
    const prefix = [
      "--import",
      "tsx",
      "cli/rosterpilot.ts",
      "tessera",
      "analyze",
      "--file",
      fixture,
      "--opponent-roster",
      fixture,
      "--execution-mode",
      "simulate",
    ];
    await assert.rejects(
      run(
        process.execPath,
        [
          ...prefix,
          "--simulation-backend",
          "local-engine",
          "--scenario-contract",
          contractPath,
          "--iterations",
          "100",
        ],
        { cwd: process.cwd() },
      ),
      /either --scenario-contract or --iterations/i,
    );
    await assert.rejects(
      run(
        process.execPath,
        [
          ...prefix,
          "--simulation-backend",
          "local-engine",
          "--iterations",
          "0",
        ],
        { cwd: process.cwd() },
      ),
      /positive integer/i,
    );
    await assert.rejects(
      run(
        process.execPath,
        [...prefix, "--iterations", "100"],
        { cwd: process.cwd() },
      ),
      /requires --simulation-backend local-engine/i,
    );
    await assert.rejects(
      run(
        process.execPath,
        [
          ...prefix,
          "--simulation-backend",
          "local-engine",
          "--analysis-mode",
          "quick",
          "--scenario-contract",
          contractPath,
        ],
        { cwd: process.cwd() },
      ),
      /does not exactly match.*scope/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
