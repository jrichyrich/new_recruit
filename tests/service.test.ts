import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RosterPilotService,
  type StressRunner,
} from "../lib/rosterpilot/service";

async function fixture(options: {
  runStress?: StressRunner;
  deliver?: ConstructorParameters<typeof RosterPilotService>[0]["deliverToNewRecruit"];
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-service-"));
  const service = new RosterPilotService({
    rootDirectory: root,
    createId: (() => {
      let id = 0;
      return () => `operation-${++id}`;
    })(),
    lease: async (operation) => operation(),
    runStress: options.runStress,
    deliverToNewRecruit: options.deliver,
  });
  await service.initialize();
  return { service, root };
}

async function build(service: RosterPilotService, faction = "adeptus-custodes") {
  const result = await service.run({
    action: "build",
    request: `Build a 500 point ${faction} roster`,
    options: { faction, pointsLimit: 500 },
  });
  assert.equal(result.state, "completed", JSON.stringify(result.violations));
  assert.ok(result.roster?.rosterRef);
  return result;
}

test("builds a compact operation and stores a V4 roster", async () => {
  const { service, root } = await fixture();
  try {
    const result = await build(service);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4_096);
    const stored = JSON.parse(await readFile(
      path.join(root, "rosters", "v4", `${result.roster!.rosterId}.json`),
      "utf8",
    )) as { schemaVersion: number; roster: { schemaVersion: number } };
    assert.equal(stored.schemaVersion, 4);
    assert.equal(stored.roster.schemaVersion, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports through an artifact reference instead of inline content", async () => {
  const { service, root } = await fixture();
  try {
    const built = await build(service);
    const exported = await service.run({
      action: "export",
      rosterRef: built.roster!.rosterRef,
      format: "rosz",
    });
    assert.equal(exported.state, "completed");
    assert.equal(exported.artifacts.length, 1);
    assert.ok(exported.artifacts[0].uri.startsWith("rosterpilot://artifacts/"));
    const resource = await service.readResource(exported.artifacts[0].uri);
    assert.ok("blob" in resource);
    assert.ok(resource.blob.length > 100);
    assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= 4_096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyzes two exact rosters locally without claiming a win rate", async () => {
  const { service, root } = await fixture();
  try {
    const player = await build(service, "adeptus-custodes");
    const opponent = await build(service, "world-eaters");
    const result = await service.run({
      action: "matchup",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
    });
    assert.equal(result.state, "completed");
    assert.equal(result.artifacts.length, 1);
    assert.match(String(result.result?.limitation), /not a whole-game win probability/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs local stress directly and confirms website stress through act", async () => {
  const calls: Array<{
    backend: string;
    faction: string;
    outputDirectory: string;
    profilePolicyPath?: string;
  }> = [];
  const runStress: StressRunner = async (_roster, faction, options) => {
    calls.push({
      backend: options.backend,
      faction,
      outputDirectory: options.outputDirectory,
      profilePolicyPath: options.profilePolicyPath,
    });
    return {
      ok: true,
      data: {
        schemaVersion: 4,
        reportKind: "tessera-stress-test",
        runId: `stress-${calls.length}`,
        status: "complete",
        simulation: { trustedMatrices: 3 },
        findings: [{ title: "Pressure", summary: "Keep screens intact." }],
      },
      violations: [],
      warnings: Array.from({ length: 30 }, (_, index) => ({
        code: `STRESS_WARNING_${index}`,
        message: "Diagnostic detail ".repeat(40),
        severity: "warn" as const,
      })),
    };
  };
  const { service, root } = await fixture({ runStress });
  try {
    const built = await build(service);
    const local = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: {
        opponentFaction: "world-eaters",
        backend: "local-engine",
        suite: "core-3",
      },
    });
    assert.equal(local.state, "completed");
    assert.ok(Buffer.byteLength(JSON.stringify(local)) <= 4_096);
    assert.equal(calls[0].backend, "local-engine");
    assert.equal(calls[0].faction, "world-eaters");
    assert.match(calls[0].outputDirectory, new RegExp(`${local.operationId}$`));

    const staged = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: {
        opponentFaction: "world-eaters",
        backend: "website",
        suite: "diverse-9",
      },
    });
    assert.equal(staged.state, "action-required");
    assert.equal(calls.length, 1);
    const completed = await service.act({
      operationId: staged.operationId,
      expectedRevision: staged.revision,
      actionId: "tessera.stress.run",
      choice: "profiles/world-eaters.json",
      confirm: true,
    });
    assert.equal(completed.state, "completed");
    assert.equal(calls[1].backend, "website");
    assert.equal(calls[1].faction, "world-eaters");
    assert.equal(calls[1].profilePolicyPath, "profiles/world-eaters.json");
    assert.match(calls[1].outputDirectory, new RegExp(`${staged.operationId}$`));
    assert.notEqual(calls[0].outputDirectory, calls[1].outputDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks stale actions and performs confirmed New Recruit upload once", async () => {
  let deliveries = 0;
  const deliveryOptions: Array<Parameters<NonNullable<
    ConstructorParameters<typeof RosterPilotService>[0]["deliverToNewRecruit"]
  >>[1]> = [];
  const { service, root } = await fixture({
    deliver: async (roster, options) => {
      deliveries += 1;
      deliveryOptions.push(options);
      return {
        ok: true,
        data: {
          rosterId: roster.id,
          rosterName: roster.name,
          listUrl: "https://www.newrecruit.eu/app/list/example",
          imported: true,
          sessionReused: false,
          verification: {
            name: true,
            faction: true,
            points: true,
            units: [],
            mismatches: [],
          },
          artifacts: [],
        },
        violations: [],
        warnings: [],
      };
    },
  });
  try {
    const built = await build(service);
    const stale = await service.act({
      operationId: built.operationId,
      expectedRevision: built.revision + 1,
      actionId: "new-recruit.upload",
      confirm: true,
    });
    assert.equal(stale.state, "failed");
    assert.equal(deliveries, 0);

    const current = await service.inspect({ ref: built.operationId }) as {
      revision: number;
    };
    const uploaded = await service.act({
      operationId: built.operationId,
      expectedRevision: current.revision,
      actionId: "new-recruit.upload",
      confirm: true,
    });
    assert.equal(uploaded.state, "completed");
    assert.equal(deliveries, 1);
    assert.equal(deliveryOptions[0].rootDir, root);
    assert.equal(deliveryOptions[0].outputDirectory, "new-recruit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
