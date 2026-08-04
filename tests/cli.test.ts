import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildRoster,
  rosterExecutionFingerprint,
  type RosterDraftV1,
} from "../lib/rosterpilot";

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
  assert.match(stdout, /rosterpilot data update-status/);
  assert.match(stdout, /rosterpilot data start-local-update/);
  assert.match(stdout, /rosterpilot data update-job --job/);
  assert.match(stdout, /rosterpilot rebase --file/);
  assert.match(stdout, /workflow repair-web/);
  assert.match(stdout, /workflow approve-data-migration/);
  assert.match(stdout, /workflow start-repaired-web/);
  assert.match(stdout, /--portfolio-out general-threat-portfolio\.json/);
  assert.match(
    stdout,
    /rosterpilot tessera compare-providers[^\n]*--local-report[^\n]*--website-report/,
  );
  assert.match(
    stdout,
    /rosterpilot tessera personal-rotation aggregate[^\n]*--covering-suite[^\n]*--comparison[^\n]*--record/,
  );
});

test("CLI distinguishes the active, verified, and upstream data bundles", async () => {
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "cli/rosterpilot.ts",
      "data",
      "update-status",
    ],
    { cwd: process.cwd() },
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    data: {
      activeBundleId: string | null;
      latestVerifiedBundleId: string | null;
      latestUpstreamBundleId: string | null;
    };
  };
  assert.equal(result.ok, true);
  assert.match(result.data.activeBundleId ?? "", /^[a-f0-9]{64}$/);
  assert.ok("latestVerifiedBundleId" in result.data);
  assert.ok("latestUpstreamBundleId" in result.data);
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
    [
      "build",
      "new-recruit",
      "tessera",
      "faction-stress",
      "tessera-optimizer",
    ],
  );
  assert.equal(result.data.workflows[0].available, true);
  assert.deepEqual(
    result.data.workflows.map((workflow) => workflow.setupProfile),
    ["core", "new-recruit", "tessera", "tessera", "tessera"],
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
    data: RosterDraftV1;
  };
  assert.equal(result.ok, true);
  assert.equal(result.data.pointsLimit, 1000);
  assert.equal(result.data.totalPoints, 1000);
  assert.deepEqual(result.data.preferences, ["mobility"]);
  assert.equal(result.data.constraints.allowNamedCharacters, false);
  const direct = buildRoster({
    prompt:
      "Build a 1,000-point fast Custodes army with no named characters",
  });
  assert.ok(direct.data);
  assert.equal(
    rosterExecutionFingerprint(result.data),
    rosterExecutionFingerprint(direct.data),
  );
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
