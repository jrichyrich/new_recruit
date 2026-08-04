import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRoster,
  rosterExecutionFingerprint,
  type DataBundleSnapshot,
  type DataBundleProvider,
} from "../lib/rosterpilot";
import type {
  RuntimeDataBundleShardDataV1,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  serializeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import {
  analyzeRosterMatchup,
  localCombatScenarioClaimsEligible,
  prepareRosterForTessera,
} from "../local/tessera/companion";
import { verifyLocalTesseraEngineInputAnyVersion } from "../local/tessera/local-engine-input-v2";
import { runLocalTesseraEngineMatchup } from "../local/tessera/local-engine";
import {
  localTesseraScenarioPolicyContractV2,
  selectedBaselineTesseraCombatPolicyV2,
} from "../local/tessera/scenario-contract-v2";
import {
  buildCustodesVsWorldEatersSmokeRoster,
  resolvedProfilePolicy,
} from "./helpers/tessera-local-bundle";
import {
  buildTesseraParityCoveringSuiteV2,
} from "../local/tessera/provider-parity-covering-suite-v2";

test("local coaching eligibility requires decision-grade adapter coverage on every requested envelope", () => {
  const scenarios = [{
    metrics: ["mean-damage"],
    cells: [{
      combatEnvelope: {
        "mean-damage": {
          coverage: { claimEligibility: "decision-grade" },
          conclusionEligibility: {
            mode: "selected",
            scalarClaimsAllowed: true,
            unresolvedDimensions: [],
            scenarioPolicyContractV3Sha256: "1".repeat(64),
            combatStateSha256: "2".repeat(64),
          },
        },
      },
    }],
  }] as unknown as Parameters<
    typeof localCombatScenarioClaimsEligible
  >[0];
  assert.equal(localCombatScenarioClaimsEligible(scenarios), true);

  const missingConclusion = structuredClone(scenarios);
  delete missingConclusion[0].cells[0].combatEnvelope?.[
    "mean-damage"
  ]?.conclusionEligibility;
  assert.equal(
    localCombatScenarioClaimsEligible(missingConclusion),
    false,
  );

  const projectedPartial = structuredClone(scenarios);
  const envelope = projectedPartial[0].cells[0].combatEnvelope?.[
    "mean-damage"
  ];
  assert.ok(envelope);
  envelope.coverage.claimEligibility = "provisional";
  assert.equal(
    localCombatScenarioClaimsEligible(projectedPartial),
    false,
  );

  const missingProjection = structuredClone(scenarios);
  delete missingProjection[0].cells[0].combatEnvelope;
  assert.equal(
    localCombatScenarioClaimsEligible(missingProjection),
    false,
  );
});

function providerSnapshot(
  playerRoster: ReturnType<typeof buildCustodesVsWorldEatersSmokeRoster>,
  opponentRoster: NonNullable<ReturnType<typeof buildRoster>["data"]>,
): DataBundleSnapshot<RuntimeDataBundleShardDataV1> {
  const shard = {
    shardId: "global",
    data: {
      rulesData: serializeRuntimeRulesData(),
    },
  };
  const shards = new Map([["global", shard]]);
  const semantic = (roster: typeof playerRoster) => ({
    factionRulesHash: roster.sourceData.factionRulesHash,
    mappingHash: roster.sourceData.mappingHash,
    portfolioHash: "d".repeat(64),
    conflictHash: "e".repeat(64),
    entityHashes: { ...roster.sourceData.entityHashes },
  });
  return {
    bundleId: playerRoster.sourceData.bundleId,
    manifest: {
      engineDataSchemaVersion:
        playerRoster.sourceData.engineDataSchemaVersion,
      semanticHashes: {
        factions: {
          [playerRoster.factionId]: semantic(playerRoster),
          [opponentRoster.factionId]: semantic(opponentRoster),
        },
      },
    },
    shards,
  } as unknown as DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
}

test("exact Custodes versus World Eaters local matchup stays bundle-native and rules-aware", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-local-engine-companion-"),
  );
  try {
    const player = buildCustodesVsWorldEatersSmokeRoster();
    const opponent = buildRoster({
      playerFaction: "world-eaters",
      pointsLimit: 1_000,
      name: "World Eaters local opponent",
      preferences: ["objective", "durability", "melee"],
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
    const snapshot = providerSnapshot(player, opponentRoster);
    const policy = resolvedProfilePolicy(player, opponentRoster);
    let acquired = 0;
    let released = 0;
    let acquireOptions: unknown = null;
    const dataBundleProvider: DataBundleProvider<
      RuntimeDataBundleShardDataV1
    > = {
      acquireSnapshot: async (options) => {
        acquired += 1;
        acquireOptions = options;
        return {
          leaseId: "local-engine-operation-lease",
          snapshot,
          released: false,
          release: async () => {
            released += 1;
          },
        };
      },
      getStatus: async () => {
        throw new Error("not used");
      },
      refresh: async () => {
        throw new Error("not used");
      },
      rollback: async () => {
        throw new Error("not used");
      },
    };
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
        metrics: [
          "wipe-probability",
          "half-wipe-probability",
          "mean-kills",
          "mean-damage",
        ],
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
        dataBundleProvider,
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
    assert.equal(acquired, 1);
    assert.equal(released, 1);
    assert.deepEqual(acquireOptions, {
      bundleId: player.sourceData.bundleId,
      factionIds: ["adeptus-custodes", "world-eaters"],
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
    assert.equal(result.data.scenarioPolicyContractV3?.schemaVersion, 3);
    assert.match(
      result.data.scenarioPolicyContractV3Sha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.ok(result.data.simulation.scenarios?.every((scenario) =>
      scenario.cells.every((cell) =>
        scenario.metrics.every((metric) =>
          cell.combatEnvelope?.[metric]?.conclusionEligibility
            ?.scalarClaimsAllowed === false
        )
      )
    ));
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
      const parsed = verifyLocalTesseraEngineInputAnyVersion({
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
    const playerInput = verifyLocalTesseraEngineInputAnyVersion({
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
        { modelCount: 9, occurrence: 2 },
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
        /machine-local parity attestation.*bridge-v3/i.test(warning),
      ),
    );
    assert.ok(
      result.data.warnings.some((warning) =>
        /TESSERA_COMBAT_CORPUS_V3_INCOMPLETE/.test(warning),
      ),
    );
    assert.match(
      result.data.scenarioPolicyContractV2Sha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.equal(result.data.simulation.combatBridges, undefined);
    assert.equal(
      result.data.simulation.combatBridgeEvidence?.length,
      1,
    );
    const bridgeEvidence =
      result.data.simulation.combatBridgeEvidence?.[0];
    assert.ok(bridgeEvidence);
    assert.equal(bridgeEvidence.schemaVersion, 1);
    assert.match(
      bridgeEvidence.bridgeSha256,
      /^[0-9a-f]{64}$/,
    );
    assert.match(bridgeEvidence.evidenceSha256, /^[0-9a-f]{64}$/);
    assert.equal(
      bridgeEvidence.coverageUnit,
      "unique-mechanics-cell",
    );
    assert.ok(
      bridgeEvidence.uniqueMechanicsCount < bridgeEvidence.cellCount,
      `Expected four metric projections to share mechanics, got ${bridgeEvidence.uniqueMechanicsCount}/${bridgeEvidence.cellCount}.`,
    );
    assert.equal(
      bridgeEvidence.replay.playerInputSha256,
      playerSimulationInput.sha256,
    );
    assert.equal(
      result.data.simulation.scenarios?.every((scenario) =>
        scenario.cells.every(
          (cell) => cell.combatEnvelope?.["mean-damage"] !== undefined,
        ),
      ),
      true,
    );
    assert.deepEqual(
      result.data.artifacts
        .filter((artifact) => artifact.format.startsWith("combat-corpus-"))
        .map((artifact) => artifact.format)
        .sort(),
      [
        "combat-corpus-inventory",
        "combat-corpus-overlay",
        "combat-corpus-report",
      ],
    );
    const matchupJson = result.data.artifacts.find(
      (artifact) => artifact.format === "matchup-json",
    );
    assert.ok(matchupJson);
    const serializedReport = await readFile(matchupJson.written, "utf8");
    const persisted = JSON.parse(serializedReport) as NonNullable<
      typeof result.data
    >;
    assert.equal(persisted.simulation.combatBridges, undefined);
    assert.equal(
      persisted.simulation.combatBridgeEvidence?.[0]
        ?.evidenceSha256,
      bridgeEvidence.evidenceSha256,
    );
    assert.doesNotMatch(serializedReport, /"combatBridges"\s*:/);
    assert.ok(
      result.data.connectorEvents?.some(
        (event) =>
          event.provider === "tessera" &&
          event.simulationBackend === "local-engine" &&
          event.origin === "in-memory",
      ) === true,
    );

    const paritySuite = buildTesseraParityCoveringSuiteV2({
      corpusInventorySha256: "8".repeat(64),
      factions: [
        {
          factionId: "adeptus-custodes",
          attackerMechanicIds: [],
          defenderMechanicIds: [],
        },
        {
          factionId: "world-eaters",
          attackerMechanicIds: [],
          defenderMechanicIds: [],
        },
      ],
    });
    const parityPreflight = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponentRoster },
      {
        simulationBackend: "website",
        executionMode: "simulate",
        analysisMode: "quick",
        phases: ["shooting"],
        metrics: ["mean-damage"],
        profilePolicy: policy,
        providerParityCase: {
          coveringSuite: paritySuite,
          coveringCaseId: paritySuite.cases[0].caseId,
        },
        outputDirectory: path.join(directory, "parity-preflight"),
        allowOutsideRoot: true,
      },
      {
        dataBundleProvider,
        deliver: async () => {
          calls.delivery += 1;
          throw new Error("New Recruit must not run before corpus admission");
        },
        enrich: async () => {
          calls.enrichment += 1;
          throw new Error("New Recruit must not run before corpus admission");
        },
        runBrowser: async () => {
          calls.website += 1;
          throw new Error("Tessera Web must not run before corpus admission");
        },
      },
    );
    assert.equal(parityPreflight.ok, false);
    assert.equal(
      parityPreflight.violations[0]?.code,
      "COMBAT_CORPUS_REVIEW_REQUIRED",
    );
    assert.match(
      parityPreflight.violations[0]?.message ?? "",
      /No New Recruit or Tessera Web activity was started/,
    );
    assert.deepEqual(calls, {
      delivery: 0,
      enrichment: 0,
      website: 0,
    });

    const rejectedInjection = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponentRoster },
      {
        simulationBackend: "local-engine",
        executionMode: "simulate",
        analysisMode: "quick",
        phases: ["shooting"],
        metrics: ["mean-damage"],
        scenarioPolicyContractV2:
          localTesseraScenarioPolicyContractV2(
            8,
            ["shooting"],
            ["mean-damage"],
            selectedBaselineTesseraCombatPolicyV2(),
          ),
        profilePolicy: policy,
        outputDirectory: path.join(directory, "rejected-injection"),
        allowOutsideRoot: true,
      },
      {
        dataBundleProvider,
        runLocalEngine: async (input) => {
          const injected = await runLocalTesseraEngineMatchup(input);
          delete injected.scenarios[0]?.cells[0]?.combatEnvelope;
          return injected;
        },
      },
    );
    assert.equal(rejectedInjection.ok, false);
    assert.equal(
      [
        ...rejectedInjection.violations.map((issue) => issue.code),
        ...(rejectedInjection.data?.failures ?? []).map(
          (failure) => failure.code,
        ),
      ].includes("TESSERA_COMBAT_BRIDGE_EVIDENCE_MISSING"),
      true,
      "an injected base-profile or stripped local result must not be accepted as rules-aware evidence",
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
