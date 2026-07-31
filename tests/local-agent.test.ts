import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCAL_AGENT_PROTOCOL_VERSION,
  LOCAL_AGENT_VERSION,
  type LocalAgentResponse,
} from "../local/agent/contracts";
import {
  closeTesseraLocalAgentSession,
  deliverThroughLocalAgent,
  getLocalAgentStatus,
  LocalAgentError,
  probeNewRecruitThroughLocalAgent,
  runTesseraThroughLocalAgent,
  startTesseraRunThroughLocalAgent,
} from "../local/agent/client";
import { FrameDecoder, encodeFrame } from "../local/agent/framing";
import { renderLaunchAgent } from "../local/agent/lifecycle";
import { startLocalAgent } from "../local/agent/server";

async function writePersistentTesseraWorkerFixture(
  filename: string,
  logPath: string,
): Promise<void> {
  await writeFile(
    filename,
    `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
let contextGeneration = 0;
let contextActive = false;
let failedTransient = false;
let profileDirectory = null;
const log = (value) => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  pid: process.pid,
  contextGeneration,
  ...value
}) + "\\n");
const result = (warnings = []) => ({
  settings: {},
  warnings,
  cells: [],
  scenarios: [],
  importWarnings: { player: [], opponent: [] },
  importIssues: [],
  integrityIssues: []
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const envelope = JSON.parse(line);
  if (envelope.action === "analyze") {
    profileDirectory = envelope.request.profileDirectory;
    if (!contextActive) {
      contextActive = true;
      contextGeneration += 1;
    }
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    const savedListMarker = join(
      profileDirectory,
      "saved-list-state.fixture"
    );
    const savedListStatePresent = existsSync(savedListMarker);
    if (!savedListStatePresent) {
      writeFileSync(savedListMarker, "verified saved-list state");
    }
    log({
      action: "analyze",
      profileDirectory,
      savedListStatePresent,
      frozenScenarioContract: envelope.request.frozenScenarioContract,
      savedListReuse: envelope.request.savedListReuse
    });
    if (
      envelope.request.opponentName === "Transient" &&
      !failedTransient
    ) {
      failedTransient = true;
      process.stdout.write(JSON.stringify({
        ok: false,
        code: "TESSERA_BROWSER_TIMEOUT",
        message: "fixture timeout"
      }) + "\\n");
    } else if (envelope.request.opponentName === "Partial") {
      process.stdout.write(JSON.stringify({
        ok: true,
        data: result([
          "[TESSERA_PROFILE_POLICY_APPLIED] fixture",
          "[TESSERA_STALE_MATRIX] fixture stale matrix"
        ])
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ ok: true, data: result() }) + "\\n");
    }
  } else if (envelope.action === "reset") {
    contextActive = false;
    log({
      action: "reset",
      profileDirectory,
      savedListStatePresent: profileDirectory
        ? existsSync(join(profileDirectory, "saved-list-state.fixture"))
        : false
    });
    process.stdout.write(JSON.stringify({ ok: true, action: "reset" }) + "\\n");
  } else if (envelope.action === "close") {
    contextActive = false;
    log({ action: "close", profileDirectory });
    process.stdout.write(JSON.stringify({ ok: true, action: "close" }) + "\\n");
    break;
  }
}
`,
  );
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for the local-agent fixture condition.");
}

test("local-agent framing round-trips a fragmented message", () => {
  const frame = encodeFrame({ ok: true, value: "fixture" });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(frame.subarray(3)), [
    { ok: true, value: "fixture" },
  ]);
});

test("LaunchAgent rendering quotes paths and exposes no credential values", () => {
  const plist = renderLaunchAgent({
    nodeExecutable: "/opt/Node & Runtime/bin/node",
    projectDirectory: "/tmp/Roster <Pilot>",
    brokerPath: "/tmp/broker",
    socketPath: "/private/tmp/rosterpilot.sock",
    profileDirectory: "/tmp/profile",
    stdoutPath: "/tmp/stdout.log",
    stderrPath: "/tmp/stderr.log",
  });
  assert.match(plist, /Node &amp; Runtime/);
  assert.match(plist, /Roster &lt;Pilot&gt;/);
  assert.match(plist, /ROSTERPILOT_KEYCHAIN_BROKER/);
  assert.doesNotMatch(plist, /password|cookie|access.?token/i);
});

test("local agent reports providers through a user-only transport", async () => {
  const directory = await mkdtemp(
    path.join("/private/tmp", "rosterpilot-agent-status-"),
  );
  const socketPath = path.join(directory, "agent.sock");
  const spoolDirectory = path.join(directory, "spool");
  const running = await startLocalAgent({
    socketEnabled: false,
    socketPath,
    spoolDirectory,
    brokerPath: path.join(directory, "missing-broker"),
  });
  try {
    const spoolStat = await stat(spoolDirectory);
    assert.equal(spoolStat.mode & 0o777, 0o700);
    const status = await getLocalAgentStatus({ spoolDirectory });
    assert.equal(status.available, true);
    assert.equal(LOCAL_AGENT_PROTOCOL_VERSION, 10);
    assert.equal(status.protocolVersion, LOCAL_AGENT_PROTOCOL_VERSION);
    assert.equal(LOCAL_AGENT_VERSION, "1.9.0");
    assert.equal(status.version, LOCAL_AGENT_VERSION);
    assert.match(status.runtime?.buildId ?? "", /^[0-9a-f]{20}$/);
    assert.equal(status.runtime?.stale, false);
    assert.equal(
      typeof status.runtime?.rosterPilotVersion,
      "string",
    );
    assert.equal(
      typeof status.runtime?.rulesPackageVersion,
      "string",
    );
    assert.equal(
      typeof status.runtime?.stressGeneratorVersion,
      "string",
    );
    assert.match(
      status.runtime?.processStartedAt ?? "",
      /^\d{4}-\d{2}-\d{2}T/,
    );
    assert.match(
      status.runtime?.sourceFingerprintAtStart ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      status.runtime?.sourceFingerprintNow ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.equal(typeof status.projectDirectory, "string");
    assert.equal(typeof status.nodeExecutable, "string");
    assert.equal(status.brokerAvailable, false);
    assert.equal(status.brokerStatusCode, "BROKER_PROBE_FAILED");
    assert.deepEqual(
      status.providers.map((provider) => provider.providerId),
      ["new-recruit", "tessera"],
    );
    assert.equal(
      status.providers.find(
        (provider) => provider.providerId === "new-recruit",
      )?.credentialState,
      "unavailable",
    );
    assert.equal(
      status.providers.find((provider) => provider.providerId === "tessera")
        ?.credentialMode,
      "keychain",
    );
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local agent owns detached Tessera run-worker launches", async () => {
  const directory = await mkdtemp(
    path.join("/private/tmp", "rosterpilot-agent-run-worker-"),
  );
  const spoolDirectory = path.join(directory, "spool");
  const jobDirectory = path.join(directory, "run-fixture");
  const jobPath = path.join(jobDirectory, "tessera-run.json");
  const workerPath = path.join(directory, "job-worker.mjs");
  const markerPath = path.join(directory, "worker-marker.json");
  const workerToken = "local-agent-owned-worker";
  const workerTokenSha256 = createHash("sha256")
    .update(workerToken)
    .digest("hex");
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(
    jobPath,
    `${JSON.stringify({
      jobKind: "rosterpilot-tessera-run",
      requestPath: jobPath,
      workerTokenSha256,
    })}\n`,
  );
  await writeFile(
    workerPath,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
  jobPath: process.argv[2],
  workerToken: process.argv[3],
  pid: process.pid
}));
`,
  );
  const running = await startLocalAgent({
    socketEnabled: false,
    socketPath: path.join(directory, "agent.sock"),
    spoolDirectory,
    brokerPath: path.join(directory, "missing-broker"),
    tesseraJobWorkerPath: workerPath,
  });
  try {
    const launched = await startTesseraRunThroughLocalAgent(
      jobPath,
      workerToken,
      { spoolDirectory },
    );
    assert.equal(launched.accepted, true);
    assert.ok(launched.workerPid > 0);
    await waitForCondition(async () => {
      try {
        await access(markerPath);
        return true;
      } catch {
        return false;
      }
    });
    const marker = JSON.parse(
      await readFile(markerPath, "utf8"),
    ) as {
      jobPath: string;
      workerToken: string;
      pid: number;
    };
    assert.equal(marker.jobPath, jobPath);
    assert.equal(marker.workerToken, workerToken);
    assert.equal(marker.pid, launched.workerPid);
    await assert.rejects(
      startTesseraRunThroughLocalAgent(
        jobPath,
        "wrong-token",
        { spoolDirectory },
      ),
      (error: unknown) =>
        error instanceof LocalAgentError &&
        error.code === "TESSERA_WORKER_IDENTITY_MISMATCH",
    );
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local agent rejects incompatible protocol versions", async () => {
  const directory = await mkdtemp(
    path.join("/private/tmp", "rosterpilot-agent-version-"),
  );
  const socketPath = path.join(directory, "agent.sock");
  const spoolDirectory = path.join(directory, "spool");
  const running = await startLocalAgent({
    socketEnabled: false,
    socketPath,
    spoolDirectory,
    brokerPath: path.join(directory, "missing-broker"),
  });
  try {
    const requestPath = path.join(
      spoolDirectory,
      "requests",
      "fixture.request.json",
    );
    const temporaryPath = `${requestPath}.tmp`;
    const responsePath = path.join(
      spoolDirectory,
      "responses",
      "fixture.response.json",
    );
    await writeFile(
      temporaryPath,
      JSON.stringify({
        id: "fixture",
        protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION + 1,
        operation: "agent.status",
      }),
      { mode: 0o600 },
    );
    await rename(temporaryPath, requestPath);
    let response: LocalAgentResponse | null = null;
    for (let attempt = 0; attempt < 20 && !response; attempt += 1) {
      try {
        response = JSON.parse(
          await readFile(responsePath, "utf8"),
        ) as LocalAgentResponse;
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(response);
    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.equal(response.code, "LOCAL_AGENT_VERSION_MISMATCH");
    }
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local agent returns browser artifacts without returning credentials or paths", async () => {
  const directory = await mkdtemp(
    path.join("/private/tmp", "rosterpilot-agent-delivery-"),
  );
  const socketPath = path.join(directory, "agent.sock");
  const brokerPath = path.join(directory, "broker");
  const workerPath = path.join(directory, "worker.mjs");
  await writeFile(
    brokerPath,
    '#!/bin/sh\nprintf \'{"ok":true,"configured":true}\\n\'\n',
  );
  await chmod(brokerPath, 0o700);
  await writeFile(
    workerPath,
    `import { readFileSync, writeFileSync } from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (input.action === "probe") {
  process.stdout.write(JSON.stringify({
    ok: true,
    uiIdentity: "${"d".repeat(64)}",
    sessionReused: true,
    importControlVisible: true
  }));
  process.exit(0);
}
if (input.expected.name === "Invalid stdout") {
  process.stdout.write("not-json");
  process.exit(2);
}
if (input.enrichedRoszPath) writeFileSync(input.enrichedRoszPath, "enriched");
if (input.prettyHtmlPath) writeFileSync(input.prettyHtmlPath, "<h1>Pretty</h1>");
process.stdout.write(JSON.stringify({
  ok: true,
  uiIdentity: input.expected.name === "Malformed"
    ? "https://www.newrecruit.eu/assets/app.js"
    : "${"c".repeat(64)}",
  rawUiMetadata: "secret-browser-build-metadata",
  imported: true,
  sessionReused: false,
  listUrl: "https://www.newrecruit.eu/app/Lists/fixture",
  enrichedRoszPath: input.enrichedRoszPath,
  prettyHtmlPath: input.prettyHtmlPath,
  verification: { name: true, faction: true, points: true, units: [], mismatches: [] }
}));
`,
  );
  const spoolDirectory = path.join(directory, "spool");
  const running = await startLocalAgent({
    socketEnabled: false,
    socketPath,
    spoolDirectory,
    brokerPath,
    profileDirectory: path.join(directory, "profile"),
    workerPath,
  });
  try {
    const result = await deliverThroughLocalAgent(
      {
        sourceFilename: "fixture.rosz",
        sourceRoszBase64: Buffer.from("source").toString("base64"),
        downloadEnrichedRosz: true,
        downloadPrettyHtml: true,
        expected: {
          name: "Fixture",
          factionName: "Faction",
          totalPoints: 1000,
          units: [],
        },
      },
      { spoolDirectory },
    );
    assert.equal(
      Buffer.from(result.enrichedRoszBase64 ?? "", "base64").toString(),
      "enriched",
    );
    assert.equal(
      Buffer.from(result.prettyHtmlBase64 ?? "", "base64").toString(),
      "<h1>Pretty</h1>",
    );
    assert.equal(result.worker.imported, true);
    assert.equal(result.worker.uiIdentity, "c".repeat(64));
    assert.doesNotMatch(
      JSON.stringify(result),
      /password|cookie|access.?token|rawUiMetadata|secret-browser-build-metadata|rosterpilot-agent-delivery-/i,
    );
    const malformed = await deliverThroughLocalAgent(
      {
        sourceFilename: "fixture.rosz",
        sourceRoszBase64:
          Buffer.from("source").toString("base64"),
        downloadEnrichedRosz: false,
        downloadPrettyHtml: false,
        expected: {
          name: "Malformed",
          factionName: "Faction",
          totalPoints: 1000,
          units: [],
        },
      },
      { spoolDirectory },
    );
    assert.equal(malformed.worker.uiIdentity, null);
    assert.doesNotMatch(
      JSON.stringify(malformed),
      /assets\/app\.js/,
    );
    const unknownOutcome =
      await deliverThroughLocalAgent(
        {
          sourceFilename: "fixture.rosz",
          sourceRoszBase64:
            Buffer.from("source").toString("base64"),
          downloadEnrichedRosz: false,
          downloadPrettyHtml: false,
          expected: {
            name: "Invalid stdout",
            factionName: "Faction",
            totalPoints: 1000,
            units: [],
          },
        },
        { spoolDirectory },
      );
    assert.equal(unknownOutcome.worker.ok, false);
    assert.equal(
      unknownOutcome.worker.remoteOutcomeUnknown,
      true,
    );
    const probe =
      await probeNewRecruitThroughLocalAgent({
        spoolDirectory,
      });
    assert.deepEqual(probe, {
      ok: true,
      uiIdentity: "d".repeat(64),
      sessionReused: true,
      importControlVisible: true,
    });
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local agent returns sanitized Tessera matrix results", async () => {
  const directory = await mkdtemp(
    path.join("/private/tmp", "rosterpilot-agent-tessera-"),
  );
  const brokerPath = path.join(directory, "broker");
  const workerPath = path.join(directory, "tessera-worker.mjs");
  await writeFile(
    brokerPath,
    '#!/bin/sh\nprintf \'{"ok":true,"configured":true}\\n\'\n',
  );
  await chmod(brokerPath, 0o700);
  await writeFile(
    workerPath,
    `import { readFileSync } from "node:fs";
import { basename } from "node:path";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  basename(input.playerRoszPath) !== "player.rosz" ||
  basename(input.opponentRoszPath) !== "opponent.rosz" ||
  readFileSync(input.playerRoszPath, "utf8") !== "player" ||
  readFileSync(input.opponentRoszPath, "utf8") !== "opponent"
) {
  throw new Error("role-specific Tessera inputs were not materialized");
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    settings: { phase: "Fight" },
    warnings: [],
    cells: [{
      attacker: "Player",
      target: "Opponent",
      killProbability: 0.6,
      expectedDamage: 8,
      damagePer100Points: 4
    }]
  }
}));
`,
  );
  const spoolDirectory = path.join(directory, "spool");
  const running = await startLocalAgent({
    socketEnabled: false,
    socketPath: path.join(directory, "agent.sock"),
    spoolDirectory,
    brokerPath,
    tesseraWorkerPath: workerPath,
  });
  try {
    const result = await runTesseraThroughLocalAgent(
      {
        playerFilename: "enriched.rosz",
        playerRoszBase64: Buffer.from("player").toString("base64"),
        playerName: "Player",
        opponentFilename: "enriched.rosz",
        opponentRoszBase64: Buffer.from("opponent").toString("base64"),
        opponentName: "Opponent",
      },
      { spoolDirectory },
    );
    assert.equal(result.cells[0]?.killProbability, 0.6);
    assert.doesNotMatch(
      JSON.stringify(result),
      /license|credential|rosterpilot-agent-tessera-/i,
    );
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit fake Tessera workers keep one-shot EOF behavior and frozen contracts", async () => {
  const directory = await mkdtemp(
    path.join("/private/tmp", "rosterpilot-agent-session-"),
  );
  const brokerPath = path.join(directory, "broker");
  const workerPath = path.join(directory, "tessera-worker.mjs");
  const profileLog = path.join(directory, "profiles.log");
  await writeFile(
    brokerPath,
    '#!/bin/sh\nprintf \'{"ok":true,"configured":true}\\n\'\n',
  );
  await chmod(brokerPath, 0o700);
  await writeFile(
    workerPath,
    `import { appendFileSync } from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
appendFileSync(${JSON.stringify(profileLog)}, JSON.stringify({
  profileDirectory: input.profileDirectory,
  frozenScenarioContract: input.frozenScenarioContract
}) + "\\n");
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    settings: {},
    warnings: [],
    cells: [],
    scenarios: [],
    importWarnings: { player: [], opponent: [] },
    importIssues: []
  }
}));
`,
  );
  const spoolDirectory = path.join(directory, "spool");
  const running = await startLocalAgent({
    socketEnabled: false,
    socketPath: path.join(directory, "agent.sock"),
    spoolDirectory,
    brokerPath,
    tesseraWorkerPath: workerPath,
  });
  const payload = {
    playerFilename: "player.rosz",
    playerRoszBase64: Buffer.from("player").toString("base64"),
    playerName: "Player",
    opponentFilename: "opponent.rosz",
    opponentRoszBase64: Buffer.from("opponent").toString("base64"),
    opponentName: "Opponent",
    sessionId: "stress-run-fixture",
    frozenScenarioContract: [
      {
        phase: "shooting" as const,
        direction: "player-to-opponent" as const,
        metric: "wipe-probability" as const,
        settings: { iterations: "1000" },
        iterations: 1_000,
      },
    ],
  };
  try {
    await runTesseraThroughLocalAgent(payload, { spoolDirectory });
    await runTesseraThroughLocalAgent(payload, { spoolDirectory });
    const records = (await readFile(profileLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        profileDirectory: string;
        frozenScenarioContract: unknown;
      });
    assert.equal(records.length, 2);
    assert.equal(
      records[0].profileDirectory,
      records[1].profileDirectory,
    );
    assert.deepEqual(
      records[0].frozenScenarioContract,
      payload.frozenScenarioContract,
    );
    await access(records[0].profileDirectory);
    const closed = await closeTesseraLocalAgentSession(
      payload.sessionId,
      { spoolDirectory },
    );
    assert.equal(closed.closed, true);
    await assert.rejects(access(records[0].profileDirectory));
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistent Tessera sessions reuse one worker and reset poisoned contexts", async () => {
  const directory = await mkdtemp(
    path.join("/private/tmp", "rosterpilot-agent-persistent-"),
  );
  const workerPath = path.join(directory, "tessera-worker.mjs");
  const workerLog = path.join(directory, "worker.log");
  await writePersistentTesseraWorkerFixture(workerPath, workerLog);
  const spoolDirectory = path.join(directory, "spool");
  const running = await startLocalAgent({
    socketEnabled: false,
    socketPath: path.join(directory, "agent.sock"),
    spoolDirectory,
    brokerPath: path.join(directory, "unused-broker"),
    tesseraPersistentWorkerPath: workerPath,
  });
  const frozenScenarioContract = [
    {
      phase: "shooting" as const,
      direction: "player-to-opponent" as const,
      metric: "wipe-probability" as const,
      settings: { iterations: "1000" },
      iterations: 1_000,
    },
  ];
  const savedListReuse = {
    schemaVersion: 1 as const,
    player: {
      runId: "persistent-fixture",
      enrichedRoszSha256: "a".repeat(64),
      scopedProfilePolicySha256: "b".repeat(64),
      profilePolicyEntryKeys: [],
      rosterExecutionFingerprint: "c".repeat(64),
      expectedUnitCount: 2,
    },
    opponent: {
      runId: "persistent-fixture",
      enrichedRoszSha256: "d".repeat(64),
      scopedProfilePolicySha256: "b".repeat(64),
      profilePolicyEntryKeys: [],
      rosterExecutionFingerprint: "c".repeat(64),
      expectedUnitCount: 2,
    },
  };
  const payload = {
    playerFilename: "player.rosz",
    playerRoszBase64: Buffer.from("player").toString("base64"),
    playerName: "Player",
    opponentFilename: "opponent.rosz",
    opponentRoszBase64: Buffer.from("opponent").toString("base64"),
    opponentName: "Opponent",
    sessionId: "persistent-fixture",
    frozenScenarioContract,
    savedListReuse,
  };
  type WorkerLog = {
    pid: number;
    contextGeneration: number;
    action: string;
    profileDirectory: string;
    frozenScenarioContract?: unknown;
    savedListReuse?: unknown;
  };
  const records = async (): Promise<WorkerLog[]> =>
    (await readFile(workerLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkerLog);
  try {
    await runTesseraThroughLocalAgent(payload, { spoolDirectory });
    await runTesseraThroughLocalAgent(payload, { spoolDirectory });
    let log = await records();
    assert.deepEqual(
      log.map((entry) => entry.contextGeneration),
      [1, 1],
    );
    assert.equal(new Set(log.map((entry) => entry.pid)).size, 1);
    assert.deepEqual(
      log[0].frozenScenarioContract,
      frozenScenarioContract,
    );
    assert.deepEqual(log[0].savedListReuse, savedListReuse);

    await assert.rejects(
      runTesseraThroughLocalAgent(
        { ...payload, opponentName: "Transient" },
        { spoolDirectory },
      ),
      (error: unknown) =>
        error instanceof LocalAgentError &&
        error.code === "TESSERA_BROWSER_TIMEOUT",
    );
    log = await records();
    assert.equal(log.at(-1)?.action, "reset");

    await runTesseraThroughLocalAgent(payload, { spoolDirectory });
    log = await records();
    assert.equal(log.at(-1)?.contextGeneration, 2);

    await runTesseraThroughLocalAgent(
      { ...payload, opponentName: "Partial" },
      { spoolDirectory },
    );
    log = await records();
    assert.equal(log.at(-1)?.action, "reset");
    await runTesseraThroughLocalAgent(payload, { spoolDirectory });
    log = await records();
    assert.equal(log.at(-1)?.contextGeneration, 3);
    assert.equal(new Set(log.map((entry) => entry.pid)).size, 1);

    const profileDirectory = log.find(
      (entry) => entry.action === "analyze",
    )?.profileDirectory;
    assert.ok(profileDirectory);
    await access(profileDirectory);
    const closed = await closeTesseraLocalAgentSession(
      payload.sessionId,
      { spoolDirectory },
    );
    assert.equal(closed.closed, true);
    log = await records();
    assert.equal(log.at(-1)?.action, "close");
    await assert.rejects(access(profileDirectory));
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Tessera certification profile state survives a graceful local-agent restart until explicit close", async () => {
  const directory = await mkdtemp(
    path.join("/private/tmp", "rosterpilot-agent-restart-"),
  );
  const workerPath = path.join(directory, "tessera-worker.mjs");
  const workerLog = path.join(directory, "worker.log");
  await writePersistentTesseraWorkerFixture(workerPath, workerLog);
  const spoolDirectory = path.join(directory, "spool");
  const options = {
    socketEnabled: false,
    socketPath: path.join(directory, "agent.sock"),
    spoolDirectory,
    brokerPath: path.join(directory, "unused-broker"),
    tesseraPersistentWorkerPath: workerPath,
  };
  const payload = {
    playerFilename: "player.rosz",
    playerRoszBase64: Buffer.from("player").toString("base64"),
    playerName: "Player",
    opponentFilename: "opponent.rosz",
    opponentRoszBase64: Buffer.from("opponent").toString("base64"),
    opponentName: "Opponent",
    sessionId: "restart-fixture",
  };
  type RestartLog = {
    pid: number;
    action: string;
    profileDirectory: string;
    savedListStatePresent?: boolean;
  };
  const records = async (): Promise<RestartLog[]> =>
    (await readFile(workerLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RestartLog);
  const first = await startLocalAgent(options);
  let firstClosed = false;
  let second:
    | Awaited<ReturnType<typeof startLocalAgent>>
    | null = null;
  try {
    await runTesseraThroughLocalAgent(payload, {
      spoolDirectory,
    });
    const firstAnalyze = (await records()).find(
      (entry) => entry.action === "analyze",
    );
    assert.ok(firstAnalyze);
    assert.equal(firstAnalyze.savedListStatePresent, false);
    assert.equal(
      (await stat(firstAnalyze.profileDirectory)).mode & 0o777,
      0o700,
    );

    await first.close();
    firstClosed = true;
    await access(firstAnalyze.profileDirectory);
    assert.equal(
      await readFile(
        path.join(
          firstAnalyze.profileDirectory,
          "saved-list-state.fixture",
        ),
        "utf8",
      ),
      "verified saved-list state",
    );

    second = await startLocalAgent(options);
    await runTesseraThroughLocalAgent(payload, {
      spoolDirectory,
    });
    const analyzes = (await records()).filter(
      (entry) => entry.action === "analyze",
    );
    assert.equal(analyzes.length, 2);
    assert.equal(
      analyzes[1].profileDirectory,
      firstAnalyze.profileDirectory,
    );
    assert.equal(analyzes[1].savedListStatePresent, true);
    assert.notEqual(analyzes[1].pid, firstAnalyze.pid);

    const closed = await closeTesseraLocalAgentSession(
      payload.sessionId,
      { spoolDirectory },
    );
    assert.equal(closed.closed, true);
    await assert.rejects(access(firstAnalyze.profileDirectory));
  } finally {
    if (!firstClosed) await first.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistent Tessera sessions are deleted after their bounded expiry", async () => {
  const directory = await mkdtemp(
    path.join("/private/tmp", "rosterpilot-agent-expiry-"),
  );
  const workerPath = path.join(directory, "tessera-worker.mjs");
  const workerLog = path.join(directory, "worker.log");
  await writePersistentTesseraWorkerFixture(workerPath, workerLog);
  const spoolDirectory = path.join(directory, "spool");
  const running = await startLocalAgent({
    socketEnabled: false,
    socketPath: path.join(directory, "agent.sock"),
    spoolDirectory,
    brokerPath: path.join(directory, "unused-broker"),
    tesseraPersistentWorkerPath: workerPath,
    tesseraSessionTtlMs: 400,
    tesseraSessionCleanupIntervalMs: 20,
  });
  const payload = {
    playerFilename: "player.rosz",
    playerRoszBase64: Buffer.from("player").toString("base64"),
    playerName: "Player",
    opponentFilename: "opponent.rosz",
    opponentRoszBase64: Buffer.from("opponent").toString("base64"),
    opponentName: "Opponent",
    sessionId: "expiry-fixture",
  };
  const logEntries = async () =>
    (await readFile(workerLog, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        action: string;
        profileDirectory: string;
      });
  try {
    await runTesseraThroughLocalAgent(payload, { spoolDirectory });
    const expiringProfile = (await logEntries())[0].profileDirectory;
    await waitForCondition(async () => {
      const log = await logEntries();
      const removed = await access(expiringProfile).then(
        () => false,
        () => true,
      );
      return log.some((entry) => entry.action === "close") && removed;
    });

    await assert.rejects(
      closeTesseraLocalAgentSession("..", { spoolDirectory }),
      (error: unknown) =>
        error instanceof LocalAgentError &&
        error.code === "LOCAL_AGENT_PROTOCOL_ERROR",
    );
    await access(path.join(spoolDirectory, "tessera-sessions"));

  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-agent client reports an unavailable socket cleanly", async () => {
  await assert.rejects(
    getLocalAgentStatus({
      socketPath: path.join(
        os.tmpdir(),
        `rosterpilot-missing-${process.pid}.sock`,
      ),
      timeoutMs: 100,
    }),
    (error: unknown) =>
      error instanceof LocalAgentError &&
      error.code === "LOCAL_AGENT_UNAVAILABLE",
  );
});
