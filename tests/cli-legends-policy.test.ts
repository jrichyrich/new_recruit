import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { RosterDraftV1 } from "../lib/rosterpilot";

const run = promisify(execFile);

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

test("CLI forwards Legends policy and non-event play context", async () => {
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "cli/rosterpilot.ts",
      "build",
      "--faction",
      "adeptus-custodes",
      "--points",
      "1000",
      "--legends-policy",
      "exclude",
      "--play-context",
      "narrative",
    ],
    { cwd: process.cwd() },
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    data: RosterDraftV1;
  };
  assert.equal(result.ok, true);
  assert.equal(result.data.constraints.allowLegends, false);
  assert.equal(
    result.data.constraints.legendsPolicyDecision?.requestedPolicy,
    "exclude",
  );
  assert.equal(
    result.data.constraints.legendsPolicyDecision?.playContextKind,
    "narrative",
  );
});

test("CLI retains include-legends as a compatibility alias", async () => {
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "cli/rosterpilot.ts",
      "build",
      "--faction",
      "adeptus-custodes",
      "--points",
      "1000",
      "--include-legends",
    ],
    { cwd: process.cwd() },
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    data: RosterDraftV1;
  };
  assert.equal(result.ok, true);
  assert.equal(
    result.data.constraints.legendsPolicyDecision?.requestedPolicy,
    "allow",
  );
  assert.equal(
    result.data.constraints.legendsPolicyDecision?.source,
    "legacy-allow-legends",
  );
});

test("CLI rejects unsupported Legends policy values", async () => {
  await assert.rejects(
    run(
      process.execPath,
      [
        "--import",
        "tsx",
        "cli/rosterpilot.ts",
        "build",
        "--legends-policy",
        "sometimes",
      ],
      { cwd: process.cwd() },
    ),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "stderr" in error);
      assert.match(
        String((error as { stderr: string }).stderr),
        /--legends-policy requires auto, allow, or exclude/i,
      );
      return true;
    },
  );
});

test("CLI forwards Legends policy into durable Tessera builder requests", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-cli-legends-tessera-"),
  );
  const stubPath = path.join(directory, "jobs-stub.mjs");
  const preloadPath = path.join(directory, "preload.mjs");
  const hooksPath = path.join(directory, "hooks.mjs");
  const hooks = jobsModuleHookFiles(stubPath);
  try {
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
    ]);
    const { stdout } = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        preloadPath,
        path.join(process.cwd(), "cli/rosterpilot.ts"),
        "tessera",
        "start-run",
        "--run-kind",
        "build-and-stress",
        "--prompt",
        "Build a mission-ready Custodes army",
        "--player-faction",
        "adeptus-custodes",
        "--against-faction",
        "aeldari",
        "--points",
        "1000",
        "--legends-policy",
        "exclude",
        "--play-context",
        "narrative",
      ],
      { cwd: process.cwd() },
    );
    const result = JSON.parse(stdout) as {
      request: {
        kind: string;
        input: {
          legendsPolicy?: string;
          playContext?: { kind: string };
        };
      };
    };
    assert.equal(result.request.kind, "build-and-stress");
    assert.equal(result.request.input.legendsPolicy, "exclude");
    assert.deepEqual(result.request.input.playContext, {
      kind: "narrative",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
