import assert from "node:assert/strict";
import {
  chmod,
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
  type LocalAgentResponse,
} from "../local/agent/contracts";
import {
  deliverThroughLocalAgent,
  getLocalAgentStatus,
  LocalAgentError,
  runTesseraThroughLocalAgent,
} from "../local/agent/client";
import { FrameDecoder, encodeFrame } from "../local/agent/framing";
import { renderLaunchAgent } from "../local/agent/lifecycle";
import { startLocalAgent } from "../local/agent/server";

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
    assert.equal(status.protocolVersion, LOCAL_AGENT_PROTOCOL_VERSION);
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
if (input.enrichedRoszPath) writeFileSync(input.enrichedRoszPath, "enriched");
if (input.prettyHtmlPath) writeFileSync(input.prettyHtmlPath, "<h1>Pretty</h1>");
process.stdout.write(JSON.stringify({
  ok: true,
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
    assert.doesNotMatch(
      JSON.stringify(result),
      /password|cookie|access.?token|rosterpilot-agent-delivery-/i,
    );
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
    `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
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
        playerFilename: "player.rosz",
        playerRoszBase64: Buffer.from("player").toString("base64"),
        playerName: "Player",
        opponentFilename: "opponent.rosz",
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
