import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRoster,
  rosterExecutionFingerprint,
} from "../lib/rosterpilot";
import {
  analyzeRosterMatchup,
  prepareRosterForTessera,
} from "../local/tessera/companion";
import { verifyLocalTesseraEngineInput } from "../local/tessera/local-engine-input";
import {
  buildCustodesVsAeldariSmokeRoster,
  resolvedProfilePolicy,
} from "./helpers/tessera-local-bundle";

test("exact local-engine matchup bypasses New Recruit and verifies bundle-native inputs for both armies", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-local-engine-companion-"),
  );
  try {
    const player = buildCustodesVsAeldariSmokeRoster();
    const opponent = buildRoster({
      playerFaction: "aeldari",
      pointsLimit: 1_000,
      name: "Aeldari local opponent",
      preferences: ["objective", "mobility", "shooting"],
      legendsPolicy: "exclude",
      playContext: { kind: "matched-play" },
      opponentContext: {
        kind: "known-faction",
        factionId: "adeptus-custodes",
      },
      mixedThreatIntent: true,
    });
    assert.ok(opponent.ok && opponent.data);
    const opponentRoster = opponent.data;
    const policy = resolvedProfilePolicy(player, opponentRoster);
    const calls = {
      delivery: 0,
      enrichment: 0,
      website: 0,
    };
    const result = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponentRoster },
      {
        simulationBackend: "local-engine",
        executionMode: "simulate",
        analysisMode: "quick",
        phases: ["shooting"],
        metrics: ["mean-damage"],
        profilePolicy: policy,
        outputDirectory: path.join(directory, "report"),
        allowOutsideRoot: true,
      },
      {
        deliver: async () => {
          calls.delivery += 1;
          throw new Error("New Recruit delivery must not run");
        },
        enrich: async () => {
          calls.enrichment += 1;
          throw new Error("New Recruit enrichment must not run");
        },
        runBrowser: async () => {
          calls.website += 1;
          throw new Error("website provider must not run");
        },
      },
    );

    assert.equal(
      result.ok,
      true,
      [
        ...result.violations.map((issue) => issue.message),
        ...(result.data?.failures ?? []).map(
          (failure) => `${failure.code}: ${failure.message}`,
        ),
        ...(result.data?.warnings ?? []),
      ].join("\n"),
    );
    assert.ok(result.data);
    assert.deepEqual(calls, {
      delivery: 0,
      enrichment: 0,
      website: 0,
    });
    assert.equal(result.data.source, "tessera-local-engine");
    assert.equal(result.data.status, "complete");
    assert.deepEqual(result.data.preparation, {
      status: "complete",
      source: "rosterpilot-data-bundle",
      uniqueRosters: 2,
      remoteMutations: 0,
      cacheReuses: 0,
      connectorEvents: [],
    });
    assert.equal(result.data.simulation.status, "complete");
    assert.equal(result.data.simulation.requestedBackend, "local-engine");
    assert.equal(result.data.simulation.selectedBackend, "local-engine");
    assert.equal(result.data.simulation.fallback, null);
    assert.equal(result.data.simulation.providerIdentity?.provider, "local-engine");
    assert.equal(result.data.simulation.scenarios?.length, 2);
    const preparedArmies = [
      { prepared: result.data.player, sourceRoster: player },
      {
        prepared: result.data.opponents[0],
        sourceRoster: opponentRoster,
      },
    ];
    assert.equal(preparedArmies.length, 2);
    assert.equal(result.data.player.listUrl, null);
    for (const { prepared, sourceRoster } of preparedArmies) {
      assert.ok(prepared);
      assert.ok(prepared.sourceRoszPath);
      assert.match(prepared.sourceRoszPath, /\.json$/);
      assert.match(prepared.enrichedRoszPath, /\.json$/);
      assert.deepEqual(prepared.connectorEvents, []);
      assert.equal(
        prepared.simulationInput?.kind,
        "rosterpilot-local-engine-input",
      );
      assert.ok(
        prepared.simulationInput?.kind ===
          "rosterpilot-local-engine-input",
      );
      assert.equal(
        prepared.simulationInput.path,
        prepared.enrichedRoszPath,
      );
      assert.equal(
        prepared.simulationInput.sha256,
        prepared.enrichedRoszSha256,
      );
      assert.equal(
        prepared.simulationInput.bundleId,
        sourceRoster.sourceData.bundleId,
      );
      const parsed = verifyLocalTesseraEngineInput({
        content: await readFile(prepared.simulationInput.path),
        expectedSha256: prepared.simulationInput.sha256,
        expectedBundleId: sourceRoster.sourceData.bundleId,
        expectedRosterFingerprint:
          rosterExecutionFingerprint(sourceRoster),
      });
      assert.equal(parsed.rosterId, sourceRoster.id);
      assert.equal(parsed.totalPoints, 1_000);
      assert.equal(parsed.units.length, sourceRoster.units.length);
    }
    const playerSimulationInput = result.data.player.simulationInput;
    if (
      playerSimulationInput?.kind !==
      "rosterpilot-local-engine-input"
    ) {
      assert.fail("Expected a frozen bundle-native player input.");
    }
    const playerInput = verifyLocalTesseraEngineInput({
      content: await readFile(playerSimulationInput.path),
      expectedSha256: playerSimulationInput.sha256,
      expectedBundleId: player.sourceData.bundleId,
      expectedRosterFingerprint: rosterExecutionFingerprint(player),
    });
    const witchseekers = playerInput.units
      .filter((unit) => unit.label === "Witchseekers")
      .sort((left, right) => left.occurrence - right.occurrence);
    assert.deepEqual(
      witchseekers.map((unit) => ({
        modelCount: unit.models,
        occurrence: unit.occurrence,
      })),
      [
        { modelCount: 10, occurrence: 1 },
        { modelCount: 6, occurrence: 2 },
      ],
    );
    assert.equal(
      new Set(witchseekers.map((unit) => unit.selectionId)).size,
      2,
    );
    assert.equal(
      new Set(witchseekers.map((unit) => unit.instanceId)).size,
      2,
    );
    assert.deepEqual(
      witchseekers.map((unit) => unit.selectionId),
      player.units
        .filter((unit) => unit.name === "Witchseekers")
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((unit) => unit.selectionId),
    );
    assert.equal(
      result.data.connectorEvents?.some(
        (event) => event.provider === "new-recruit",
      ),
      false,
    );
    assert.equal(result.data.findings?.length, 0);
    assert.equal(result.data.changeCandidates?.length, 0);
    assert.ok(
      result.data.warnings.some((warning) =>
        /written-license and parity promotion gates/i.test(warning),
      ),
    );
    assert.ok(
      result.data.warnings.some((warning) =>
        /base-profile evaluation/i.test(warning),
      ),
    );
    assert.ok(
      result.data.warnings.some((warning) =>
        /datasheet abilit(?:y|ies).*(?:not applied|omitted)/i.test(warning),
      ),
    );
    assert.ok(
      result.data.connectorEvents?.some(
        (event) =>
          event.provider === "tessera" &&
          event.simulationBackend === "local-engine" &&
          event.origin === "in-memory",
      ) === true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-engine preparation fails closed on an unresolved alternate profile before external activity", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-local-engine-policy-"),
  );
  try {
    const built = buildRoster({
      playerFaction: "aeldari",
      pointsLimit: 1_000,
      requiredUnitIds: ["fire-prism"],
      legendsPolicy: "exclude",
      playContext: { kind: "matched-play" },
    });
    assert.ok(built.ok && built.data);
    const calls = {
      delivery: 0,
      enrichment: 0,
      website: 0,
      runtime: 0,
    };
    const result = await prepareRosterForTessera(
      built.data,
      {
        simulationBackend: "local-engine",
        outputDirectory: path.join(directory, "inputs"),
        allowOutsideRoot: true,
      },
      {
        deliver: async () => {
          calls.delivery += 1;
          throw new Error("New Recruit delivery must not run");
        },
        enrich: async () => {
          calls.enrichment += 1;
          throw new Error("New Recruit enrichment must not run");
        },
        runBrowser: async () => {
          calls.website += 1;
          throw new Error("website provider must not run");
        },
        runtimeIssue: () => {
          calls.runtime += 1;
          throw new Error("New Recruit runtime preflight must not run");
        },
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.deepEqual(
      result.violations.map((issue) => issue.code),
      ["TESSERA_LOCAL_PROFILE_POLICY_REQUIRED"],
    );
    assert.deepEqual(calls, {
      delivery: 0,
      enrichment: 0,
      website: 0,
      runtime: 0,
    });
    // A fail-closed preparation has no report, list URL, fallback receipt, or
    // preparation attribution to misrepresent as a New Recruit operation.
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
