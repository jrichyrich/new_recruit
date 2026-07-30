import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_AGENT_PROTOCOL_VERSION,
  type LocalAgentStatus,
} from "../local/agent/contracts";
import {
  assessLocalAgentInstallation,
  ensureCurrentLocalAgent,
  type LifecycleResult,
} from "../local/agent/lifecycle";
import type { RuntimeProvenance } from "../lib/rosterpilot";

function runtime(
  buildId: string,
  options: { stale?: boolean } = {},
): RuntimeProvenance {
  return {
    rosterPilotVersion: "0.2.0",
    rulesPackageVersion: "fixture-rules",
    stressGeneratorVersion: "fixture-stress",
    processStartedAt: "2026-07-30T00:00:00.000Z",
    gitHead: "fixture-head",
    sourceFingerprintAtStart: "a".repeat(64),
    sourceFingerprintNow: options.stale
      ? "b".repeat(64)
      : "a".repeat(64),
    buildId,
    stale: options.stale ?? false,
  };
}

function agentStatus(
  overrides: Partial<LocalAgentStatus> = {},
): LocalAgentStatus {
  return {
    available: true,
    version: "fixture",
    protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
    protocolCompatible: true,
    runtime: runtime("current-build"),
    platform: "darwin",
    projectDirectory: "/repo/current",
    nodeExecutable: "/opt/node/bin/node",
    browserAvailable: true,
    brokerAvailable: true,
    activeJob: false,
    queuedJobs: 0,
    providers: [],
    ...overrides,
  };
}

function lifecycleResult(
  overrides: Partial<LifecycleResult> = {},
): LifecycleResult {
  return {
    ok: true,
    installed: true,
    running: true,
    launchAgentPath: "/tmp/agent.plist",
    brokerPath: "/tmp/broker",
    socketPath: "/tmp/agent.sock",
    ...overrides,
  };
}

test("agent assessment reports checkout, protocol, build, and stale-runtime mismatches", () => {
  const assessment = assessLocalAgentInstallation(
    agentStatus({
      projectDirectory: "/repo/other",
      protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION - 1,
      protocolCompatible: false,
      runtime: runtime("old-build", { stale: true }),
    }),
    {
      expectedProjectDirectory: "/repo/current",
      currentRuntime: runtime("current-build"),
    },
  );

  assert.equal(assessment.current, false);
  assert.equal(assessment.checkoutCurrent, false);
  assert.equal(assessment.protocolCurrent, false);
  assert.equal(assessment.buildCurrent, false);
  assert.equal(assessment.agentRuntimeFresh, false);
  assert.deepEqual(
    assessment.issues.map((issue) => issue.code),
    [
      "LOCAL_AGENT_CHECKOUT_MISMATCH",
      "LOCAL_AGENT_PROTOCOL_MISMATCH",
      "LOCAL_AGENT_RUNTIME_STALE",
      "LOCAL_AGENT_BUILD_MISMATCH",
    ],
  );
});

test("agent ensure-current restarts a stale same-checkout build and retains the mismatch", async () => {
  const calls: string[] = [];
  const initial = lifecycleResult({
    ok: false,
    code: "LOCAL_AGENT_BUILD_MISMATCH",
    message: "old build",
    assessment: assessLocalAgentInstallation(
      agentStatus({ runtime: runtime("old-build") }),
      {
        expectedProjectDirectory: "/repo/current",
        currentRuntime: runtime("current-build"),
      },
    ),
  });
  const result = await ensureCurrentLocalAgent({
    status: async () => {
      calls.push("status");
      return initial;
    },
    restart: async () => {
      calls.push("restart");
      return lifecycleResult();
    },
    install: async () => {
      calls.push("install");
      return lifecycleResult();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["status", "restart"]);
  assert.deepEqual(result.repairActions, ["restart"]);
  assert.deepEqual(
    result.initialIssues?.map((issue) => issue.code),
    ["LOCAL_AGENT_BUILD_MISMATCH"],
  );
  assert.match(result.message ?? "", /current after restart/);
});

test("agent ensure-current reinstalls a mismatched checkout", async () => {
  const calls: string[] = [];
  const result = await ensureCurrentLocalAgent({
    status: async () =>
      lifecycleResult({
        ok: false,
        code: "LOCAL_AGENT_CHECKOUT_MISMATCH",
        message: "wrong checkout",
        assessment: assessLocalAgentInstallation(
          agentStatus({ projectDirectory: "/repo/other" }),
          {
            expectedProjectDirectory: "/repo/current",
            currentRuntime: runtime("current-build"),
          },
        ),
      }),
    restart: async () => {
      calls.push("restart");
      return lifecycleResult();
    },
    install: async () => {
      calls.push("install");
      return lifecycleResult();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["install"]);
  assert.deepEqual(result.repairActions, ["install"]);
});

test("agent ensure-current falls back to installation when restart cannot recover", async () => {
  const calls: string[] = [];
  const result = await ensureCurrentLocalAgent({
    status: async () =>
      lifecycleResult({
        ok: false,
        code: "LOCAL_AGENT_UNAVAILABLE",
        message: "not responding",
      }),
    restart: async () => {
      calls.push("restart");
      return lifecycleResult({
        ok: false,
        code: "LOCAL_AGENT_UNAVAILABLE",
        message: "still unavailable",
      });
    },
    install: async () => {
      calls.push("install");
      return lifecycleResult();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["restart", "install"]);
  assert.deepEqual(result.repairActions, ["restart", "install"]);
  assert.equal(result.initialIssues?.[0]?.code, "LOCAL_AGENT_UNAVAILABLE");
});
