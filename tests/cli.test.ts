import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("CLI standard help flag describes independent workflows", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", "cli/rosterpilot.ts", "--help"],
    { cwd: process.cwd() },
  );
  assert.match(stdout, /rosterpilot workflows/);
  assert.match(
    stdout,
    /none runs automatically after another/i,
  );
});

test("CLI reports workflow readiness without starting an external action", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", "cli/rosterpilot.ts", "workflows"],
    { cwd: process.cwd() },
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    data: {
      principle: string;
      workflows: Array<{
        id: string;
        available: boolean;
        setupProfile: string;
      }>;
    };
  };
  assert.equal(result.ok, true);
  assert.match(result.data.principle, /opt-in/i);
  assert.deepEqual(
    result.data.workflows.map((workflow) => workflow.id),
    ["build", "new-recruit", "tessera"],
  );
  assert.equal(result.data.workflows[0].available, true);
  assert.deepEqual(
    result.data.workflows.map((workflow) => workflow.setupProfile),
    ["core", "new-recruit", "tessera"],
  );
});

test("CLI preserves natural-language build preferences and constraints", async () => {
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "cli/rosterpilot.ts",
      "build",
      "--prompt",
      "Build a 1,000-point fast Custodes army with no named characters",
    ],
    { cwd: process.cwd() },
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    data: {
      pointsLimit: number;
      totalPoints: number;
      preferences: string[];
      constraints: { allowNamedCharacters: boolean };
    };
  };
  assert.equal(result.ok, true);
  assert.equal(result.data.pointsLimit, 1000);
  assert.equal(result.data.totalPoints, 990);
  assert.deepEqual(result.data.preferences, ["mobility"]);
  assert.equal(result.data.constraints.allowNamedCharacters, false);
});

test("CLI reports sanitized local New Recruit companion status", async () => {
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "cli/rosterpilot.ts",
      "new-recruit",
      "status",
    ],
    { cwd: process.cwd() },
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    data: {
      platform: string;
      credentialsConfigured: boolean;
      profileDirectory: string | null;
      agentAvailable: boolean;
      credentialState: string;
    };
  };
  assert.equal(result.ok, true);
  assert.equal(result.data.platform, process.platform);
  assert.equal(typeof result.data.credentialsConfigured, "boolean");
  assert.equal(typeof result.data.agentAvailable, "boolean");
  assert.match(
    result.data.credentialState,
    /^(ready|not-configured|keychain-locked|authorization-required|unavailable)$/,
  );
  assert.doesNotMatch(stdout, /password|cookie|access.?token/i);
});
