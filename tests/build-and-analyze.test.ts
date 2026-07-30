import assert from "node:assert/strict";
import test from "node:test";

import { buildRoster } from "../lib/rosterpilot";
import { buildAndAnalyzeRosterMatchup } from "../local/tessera/exact-full-loop";

test("build-and-analyze rejects a declared points-limit mismatch before external work", async () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  });
  assert.ok(opponent.ok && opponent.data);
  let deliveryCalls = 0;
  const result = await buildAndAnalyzeRosterMatchup(
    {
      prompt: "Build a durable Custodes counter-roster",
      playerFaction: "adeptus-custodes",
      pointsLimit: 2000,
      opponentRoster: opponent.data,
      executionMode: "simulate",
    },
    {},
    {
      deliver: async () => {
        deliveryCalls += 1;
        throw new Error("delivery should not run");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.equal(result.violations[0]?.code, "TESSERA_POINTS_LIMIT_MISMATCH");
  assert.equal(deliveryCalls, 0);
});

test("build-and-analyze uses exact opponent provenance and never auto-applies changes", async () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
    preferences: ["shooting", "mobility"],
  });
  assert.ok(opponent.ok && opponent.data);
  const result = await buildAndAnalyzeRosterMatchup(
    {
      prompt:
        "Build a mission-ready 1000 point Adeptus Custodes counter-roster",
      playerFaction: "adeptus-custodes",
      opponentRoster: opponent.data,
      allowReadinessWarnings: true,
      executionMode: "prepare-only",
    },
    {},
    {
      runtimeIssue: () => ({
        code: "RUNTIME_RESTART_REQUIRED",
        message: "Fixture blocks before external delivery.",
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.ok(result.data);
  assert.equal(
    result.data.rosterRepair.roster.constraints.opponentFactionId,
    "aeldari",
  );
  assert.ok(
    result.data.rosterRepair.roster.constraints
      .opponentRosterFingerprint,
  );
  assert.equal(result.data.automaticRevisionApplied, false);
  assert.equal(
    result.data.revisionCandidatesRequireAuthorization,
    true,
  );
  assert.equal(result.data.collectionMode, "open-catalog");
});
