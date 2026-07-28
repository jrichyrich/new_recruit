import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

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
