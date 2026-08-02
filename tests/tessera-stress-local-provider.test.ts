import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  generateFactionStressPortfolio,
} from "../lib/rosterpilot";
import { runLocalTesseraEngineMatchup } from "../local/tessera/local-engine";
import { verifyLocalTesseraEngineInput } from "../local/tessera/local-engine-input";
import { runRosterStressTest } from "../local/tessera/stress";
import {
  localTesseraScenarioContract,
  tesseraScenarioContractSha256,
} from "../local/tessera/scenario-contract";
import {
  buildCustodesVsAeldariSmokeRoster,
  resolvedProfilePolicy,
} from "./helpers/tessera-local-bundle";

type StoredLocalPreparedRoster = {
  listUrl: string | null;
  sourceRoszPath: string;
  enrichedRoszPath: string;
  enrichedRoszSha256: string;
  fingerprint: string;
  simulationInput: {
    kind: "rosterpilot-local-engine-input";
    path: string;
    sha256: string;
    bundleId: string;
    compilerVersion: string;
  };
};

type StoredLocalStressManifest = {
  schemaVersion: number;
  simulationBackend: string;
  selectedSimulationBackend: string;
  requestedScenarioContract: ReturnType<
    typeof localTesseraScenarioContract
  > | null;
  requestedScenarioContractSha256: string | null;
  stageContracts: {
    screening: Record<
      string,
      ReturnType<typeof localTesseraScenarioContract>
    >;
    deepDive: Record<
      string,
      ReturnType<typeof localTesseraScenarioContract>
    >;
  };
  stageContractsSha256: string;
  preparedPlayer: StoredLocalPreparedRoster;
  preparedOpponents: Record<
    string,
    { prepared: StoredLocalPreparedRoster }
  >;
  finalArtifacts: unknown;
};

test("local-engine stress runs avoid the New Recruit cache, retain deterministic evidence, resume safely, and reject prepared-input tampering", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-local-engine-stress-"),
  );
  const previousSupport = process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
  const previousSocket = process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET;
  const supportDirectory = path.join(directory, "support");
  process.env.ROSTERPILOT_SUPPORT_DIRECTORY = supportDirectory;
  process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET = path.join(
    directory,
    "unreachable-agent.sock",
  );
  try {
    const player = buildCustodesVsAeldariSmokeRoster();
    const portfolio = generateFactionStressPortfolio({
      faction: "aeldari",
      pointsLimit: player.pointsLimit,
      suite: "core-3",
    });
    assert.ok(portfolio.ok && portfolio.data);
    const readyOpponents = portfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    );
    assert.deepEqual(
      portfolio.data.items.map((item) => item.templateId),
      [
        "balanced-control:elite-heavy",
        "ranged-pressure:elite-heavy",
        "assault-pressure:mixed",
      ],
    );
    assert.equal(readyOpponents.length, 3);
    assert.equal(
      readyOpponents.every((roster) => roster.totalPoints === 1_000),
      true,
    );
    const policy = resolvedProfilePolicy(
      player,
      ...readyOpponents,
    );
    const policyPath = path.join(directory, "profile-policy.json");
    await writeFile(
      policyPath,
      `${JSON.stringify(policy, null, 2)}\n`,
    );
    const calls = {
      enrichment: 0,
      website: 0,
    };
    let simulationCalls = 0;
    const dependencies = {
      runtimeIssue: () => null,
      enrich: async () => {
        calls.enrichment += 1;
        throw new Error("New Recruit enrichment must not run");
      },
      runBrowser: async () => {
        calls.website += 1;
        throw new Error("website provider must not run");
      },
      runLocalEngine: async (
        ...args: Parameters<typeof runLocalTesseraEngineMatchup>
      ) => {
        simulationCalls += 1;
        return runLocalTesseraEngineMatchup(...args);
      },
    };
    const scenarioContract = localTesseraScenarioContract(64);
    const result = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "full-all",
        simulationBackend: "local-engine",
        executionMode: "simulate",
        profilePolicyPath: policyPath,
        scenarioContract,
        outputDirectory: "stress",
        rootDir: directory,
      },
      dependencies,
    );

    assert.equal(
      result.ok,
      true,
      result.violations.map((issue) => issue.message).join("\n"),
    );
    assert.ok(result.data);
    assert.deepEqual(calls, {
      enrichment: 0,
      website: 0,
    });
    await assert.rejects(
      access(
        path.join(
          supportDirectory,
          "cache",
          "new-recruit",
          "v1",
        ),
      ),
      { code: "ENOENT" },
      "local-engine JSON must remain run-local instead of entering the New Recruit ROSZ cache",
    );
    assert.equal(result.data.source, "tessera-local-engine");
    assert.deepEqual(result.data.scenarioContract, scenarioContract);
    assert.equal(
      result.data.scenarioContractSha256,
      tesseraScenarioContractSha256(scenarioContract),
    );
    assert.match(
      result.data.stageScenarioContractsSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      result.data.screeningReport?.scenarioContract,
      scenarioContract,
    );
    assert.equal(
      result.data.screeningReport?.scenarioContractSha256,
      tesseraScenarioContractSha256(scenarioContract),
    );
    assert.equal(result.data.simulation?.selectedBackend, "local-engine");
    assert.equal(
      result.data.simulation?.providerIdentity?.provider,
      "local-engine",
    );
    assert.deepEqual(result.data.preparation, {
      status: "complete",
      source: "rosterpilot-data-bundle",
      uniqueRosters: 4,
      remoteMutations: 0,
      cacheReuses: 0,
      connectorEvents: [],
    });
    assert.equal(
      result.data.connectorEvents?.some(
        (event) => event.provider === "new-recruit",
      ),
      false,
    );
    assert.equal(result.data.findings.length, 0);
    assert.equal(result.data.changeCandidates.length, 0);
    const preparedArtifactFormats = result.data.artifacts
      .map((artifact) => artifact.format)
      .filter((format) =>
        format.startsWith("player-") || format.startsWith("opponent-"),
      );
    assert.deepEqual(
      [...new Set(preparedArtifactFormats)].sort(),
      [
        "opponent-local-engine-input",
        "opponent-source-json",
        "player-local-engine-input",
        "player-source-json",
      ],
    );
    assert.ok(
      result.data.warnings.some((warning) =>
        /evidence was retained for evaluation/i.test(warning),
      ),
    );
    assert.ok(
      result.data.warnings.some((warning) =>
        /base-profile-evaluation mode/i.test(warning),
      ),
    );
    assert.ok(
      result.data.warnings.some((warning) =>
        /non-weapon wargear effect.*did not apply/i.test(warning),
      ),
    );
    assert.ok(
      result.data.warnings.some((warning) =>
        /reused a hash-verified run-local data-bundle input/i.test(warning),
      ),
      "stress child runs must reuse the manifest-frozen local inputs",
    );
    const scenarios = result.data.screeningReport?.simulation.scenarios ?? [];
    assert.equal(scenarios.length, 12);
    assert.equal(
      scenarios.reduce(
        (count, scenario) => count + (scenario.metricRuns?.length ?? 0),
        0,
      ),
      48,
    );
    assert.ok(
      scenarios.every((scenario) =>
        (scenario.metricRuns ?? []).every(
          (metricRun) =>
            metricRun.seed !== undefined &&
            metricRun.executionSha256 !== undefined &&
            metricRun.projectionSha256 !== undefined &&
            metricRun.matrixSha256 !== undefined,
        ),
      ),
    );

    const manifestArtifact = result.data.artifacts.find(
      (artifact) => artifact.format === "stress-manifest",
    );
    assert.ok(manifestArtifact);
    const manifestPath = path.resolve(
      directory,
      "stress",
      manifestArtifact.written,
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as StoredLocalStressManifest;
    assert.equal(manifest.schemaVersion, 6);
    assert.equal(manifest.simulationBackend, "local-engine");
    assert.equal(manifest.selectedSimulationBackend, "local-engine");
    assert.deepEqual(
      manifest.requestedScenarioContract,
      scenarioContract,
    );
    assert.equal(
      manifest.requestedScenarioContractSha256,
      tesseraScenarioContractSha256(scenarioContract),
    );
    assert.match(manifest.stageContractsSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      Object.keys(manifest.stageContracts.screening).sort(),
      portfolio.data.items.map((item) => item.templateId).sort(),
    );
    assert.equal(
      Object.values(manifest.stageContracts.screening).every(
        (contract) =>
          contract.length === 16 &&
          contract.every((entry) => entry.iterations === 64),
      ),
      true,
    );
    assert.deepEqual(manifest.stageContracts.deepDive, {});
    const resolveManifestPath = (filename: string): string =>
      path.isAbsolute(filename)
        ? filename
        : path.resolve(path.dirname(manifestPath), filename);
    const preparedInputs = [
      manifest.preparedPlayer,
      ...Object.values(manifest.preparedOpponents).map(
        (receipt) => receipt.prepared,
      ),
    ];
    assert.equal(preparedInputs.length, 4);
    for (const prepared of preparedInputs) {
      assert.equal(prepared.listUrl, null);
      assert.match(prepared.sourceRoszPath, /\.json$/);
      assert.match(prepared.enrichedRoszPath, /\.json$/);
      assert.equal(
        prepared.simulationInput?.kind,
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
        player.sourceData.bundleId,
      );
      verifyLocalTesseraEngineInput({
        content: await readFile(
          resolveManifestPath(prepared.simulationInput.path),
        ),
        expectedSha256: prepared.simulationInput.sha256,
        expectedBundleId: player.sourceData.bundleId,
        expectedRosterFingerprint: prepared.fingerprint,
      });
    }
    const frozenInputIdentities = preparedInputs.map((prepared) => ({
      path: prepared.simulationInput.path,
      sha256: prepared.simulationInput.sha256,
      fingerprint: prepared.fingerprint,
    }));

    manifest.finalArtifacts = null;
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const resumed = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        resumeManifestPath: manifestPath,
        rootDir: directory,
        overwrite: true,
      },
      dependencies,
    );
    assert.equal(
      resumed.ok,
      true,
      resumed.violations.map((issue) => issue.message).join("\n"),
    );
    assert.equal(resumed.data?.source, "tessera-local-engine");
    assert.equal(
      resumed.data?.simulation?.selectedBackend,
      "local-engine",
    );
    assert.equal(resumed.data?.findings.length, 0);
    assert.equal(resumed.data?.changeCandidates.length, 0);
    assert.deepEqual(calls, {
      enrichment: 0,
      website: 0,
    });
    const resumedManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as StoredLocalStressManifest;
    assert.deepEqual(
      [
        resumedManifest.preparedPlayer,
        ...Object.values(resumedManifest.preparedOpponents).map(
          (receipt) => receipt.prepared,
        ),
      ].map((prepared) => ({
        path: prepared.simulationInput.path,
        sha256: prepared.simulationInput.sha256,
        fingerprint: prepared.fingerprint,
      })),
      frozenInputIdentities,
    );

    const simulationCallsBeforeTamper = simulationCalls;
    resumedManifest.finalArtifacts = null;
    await writeFile(
      manifestPath,
      `${JSON.stringify(resumedManifest, null, 2)}\n`,
    );
    await writeFile(
      resolveManifestPath(
        resumedManifest.preparedPlayer.simulationInput.path,
      ),
      "{\"tampered\":true}\n",
    );

    const tamperedResume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        resumeManifestPath: manifestPath,
        rootDir: directory,
        overwrite: true,
      },
      dependencies,
    );
    assert.equal(tamperedResume.ok, false);
    assert.equal(
      tamperedResume.violations[0]?.code,
      "TESSERA_STRESS_PREPARED_PLAYER_CHANGED",
    );
    assert.match(
      tamperedResume.violations[0]?.message ?? "",
      /prepared player artifact is missing or changed/i,
    );
    assert.equal(
      simulationCalls,
      simulationCallsBeforeTamper,
      "prepared-input drift must stop before local simulation",
    );
    assert.deepEqual(calls, {
      enrichment: 0,
      website: 0,
    });
  } finally {
    if (previousSupport === undefined) {
      delete process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
    } else {
      process.env.ROSTERPILOT_SUPPORT_DIRECTORY = previousSupport;
    }
    if (previousSocket === undefined) {
      delete process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET;
    } else {
      process.env.ROSTERPILOT_LOCAL_AGENT_SOCKET = previousSocket;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
