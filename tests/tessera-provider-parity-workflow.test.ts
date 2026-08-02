import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  TesseraImportedArmySemanticSnapshot,
  TesseraMatchupReport,
  TesseraSimulationProviderIdentity,
  TesseraUnitInstance,
  TesseraWebsiteProviderEvidence,
} from "../lib/rosterpilot";
import { canonicalJson } from "../lib/rosterpilot/semantic-hash";
import {
  createLiveNumericalParityCertification,
} from "../local/certification/live-numerical-parity";
import { tesseraImportSemanticEvidenceFromSnapshots } from "../local/tessera/browser";
import {
  createExactReportReceipt,
  exactReportReceiptPath,
} from "../local/tessera/exact-report-integrity";
import {
  serializeLocalTesseraEngineInput,
  type LocalTesseraEngineInput,
} from "../local/tessera/local-engine-input";
import {
  providerCompatibilityBundleTrustIdentitySha256,
  providerCompatibilityEnvelopeSha256,
  type ProviderCompatibilityBundleTrustIdentity,
  type ProviderCompatibilityEnvelope,
} from "../local/tessera/provider-compatibility";
import type { TesseraProviderParityResult } from "../local/tessera/provider-parity";
import {
  classifyTesseraProviderParityWorkflow,
  runTesseraProviderParityWorkflow,
} from "../local/tessera/provider-parity-workflow";
import { tesseraScenarioContractSha256 } from "../local/tessera/scenario-contract";
import { createTesseraImportedArmySimulationStateBinding } from "../local/tessera/website-semantic-evidence";

const BUNDLE = "b".repeat(64);
const PLAYER_FINGERPRINT = "1".repeat(64);
const OPPONENT_FINGERPRINT = "2".repeat(64);
const PLAYER_INPUT_SHA_PLACEHOLDER = "3".repeat(64);
const OPPONENT_INPUT_SHA_PLACEHOLDER = "4".repeat(64);

function digest(value: string | Uint8Array | object): string {
  return crypto
    .createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : canonicalJson(value),
    )
    .digest("hex");
}

function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([entryKey]) => entryKey !== key),
  ) as Omit<T, K>;
}

const localIdentity: TesseraSimulationProviderIdentity = {
  schemaVersion: 1,
  provider: "local-engine",
  engine: "tessera-engine",
  repository: "Tessera-cmd/tessera-engine",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  sourceSha256: "3".repeat(64),
  adapterVersion: "fixture-adapter-v1",
  compilerVersion: "base-profile-evaluation-v1",
  inputSchemaVersion: 1,
  capabilityManifestSha256: "4".repeat(64),
  promotion: "candidate",
  licenseState: "evaluation-only",
};

const websiteIdentity: TesseraSimulationProviderIdentity = {
  schemaVersion: 1,
  provider: "website",
  engine: "tessera-ui",
  uiIdentity: "5".repeat(64),
  adapterVersion: "fixture-browser-v1",
};

function unit(
  side: "player" | "opponent",
): TesseraUnitInstance {
  return {
    instanceId: `${side}-unit-1`,
    selectionId: `${side}-selection`,
    side,
    name: side === "player" ? "Witchseekers" : "Troupe",
    label: side === "player" ? "Witchseekers" : "Troupe",
    ordinal: 1,
    modelCount: 5,
    points: side === "player" ? 50 : 75,
    tags: [],
  };
}

function localInput(
  side: "player" | "opponent",
  fingerprint: string,
): LocalTesseraEngineInput {
  const player = side === "player";
  return {
    schemaVersion: 1,
    kind: "rosterpilot-local-engine-input",
    compilerVersion: "base-profile-evaluation-v1",
    evaluationMode: "base-profile-evaluation",
    bundleId: BUNDLE,
    rosterId: `${side}-roster`,
    rosterFingerprint: fingerprint,
    rosterName: `${side} roster`,
    factionId: player ? "adeptus-custodes" : "aeldari",
    factionName: player ? "Adeptus Custodes" : "Aeldari",
    totalPoints: player ? 50 : 75,
    profilePolicySha256: null,
    profileRequirements: [],
    units: [{
      instanceId: player ? "a".repeat(24) : "b".repeat(24),
      selectionId: `${side}-selection`,
      occurrence: 1,
      label: player ? "Witchseekers" : "Troupe",
      name: player ? "Witchseekers" : "Troupe",
      models: 5,
      T: 3,
      SV: player ? 3 : 6,
      W: 1,
      INV: player ? 5 : 4,
      FNP: null,
      points: player ? 50 : 75,
      keywords: [],
      weapons: [{
        name: player ? "Witchseeker flamer" : "Shuriken pistol",
        type: "ranged",
        count: 5,
        A: player ? "D6" : 1,
        ...(player ? {} : { BS: 3 }),
        S: 4,
        AP: player ? 0 : -1,
        D: 1,
        keywords: player ? ["IGNORES COVER", "TORRENT"] : ["PISTOL"],
      }],
    }],
    limitations: {
      unmodeledSystems: ["stratagems"],
      omittedDatasheetAbilities: [],
      omittedWargear: [],
      omittedEnhancements: [],
      unsupportedWeaponKeywords: [],
      frozenChoices: [],
    },
  };
}

function semanticSnapshot(
  side: "player" | "opponent",
): TesseraImportedArmySemanticSnapshot {
  const player = side === "player";
  return {
    schemaVersion: 1,
    side,
    armyName: `${side} roster`,
    reportedUnitCount: 1,
    units: [{
      occurrence: 1,
      name: player ? "Witchseekers" : "Troupe",
      modelCount: 5,
      included: true,
      weapons: [{
        occurrence: 1,
        name: player ? "Witchseeker flamer" : "Shuriken pistol",
        profile: null,
        count: 5,
        visibleCharacteristics: [
          { name: "phase", value: "shooting" },
          { name: "attacks", value: player ? "D6" : "1" },
          ...(player ? [] : [{ name: "ballistic skill", value: "3+" }]),
          { name: "strength", value: "4" },
          { name: "AP", value: player ? "0" : "-1" },
          { name: "damage", value: "1" },
          {
            name: "keywords",
            value: player ? "IGNORES COVER, TORRENT" : "PISTOL",
          },
          { name: "effects", value: "none" },
        ],
        effectToggles: [],
      }],
      visibleCharacteristics: [
        { name: "toughness", value: "3" },
        { name: "save", value: player ? "3+" : "6+" },
        { name: "wounds", value: "1" },
        { name: "invulnerable save", value: player ? "5+" : "4+" },
        { name: "effects", value: "none" },
      ],
      effectToggles: [],
    }],
    warningCodes: [],
    alternateProfileResolutions: [],
    completeness: "complete",
    incompleteReasons: [],
  };
}

function websiteEvidence(): TesseraWebsiteProviderEvidence {
  const player = semanticSnapshot("player");
  const opponent = semanticSnapshot("opponent");
  const binding = (snapshot: TesseraImportedArmySemanticSnapshot) =>
    createTesseraImportedArmySimulationStateBinding(snapshot, {
      side: snapshot.side,
      savedListName: `${snapshot.side}-list`,
      selectedUnitCount: 1,
      selectorValue: `list:${snapshot.side}-list`,
      selectorLabel: `${snapshot.side}-list · 1 unit`,
    });
  return {
    schemaVersion: 1,
    deployment: {
      identitySha256: "6".repeat(64),
      declaredVersion: null,
      assets: [{
        url: "https://playtessera.gg/assets/app.js",
        sameOrigin: true,
        sha256: "7".repeat(64),
        byteLength: 100,
      }],
      complete: true,
      completeness: "complete",
      declarationSha256: "8".repeat(64),
      incompleteReasons: [],
    },
    importSemantics: tesseraImportSemanticEvidenceFromSnapshots(
      player,
      opponent,
      { player: binding(player), opponent: binding(opponent) },
    ),
  };
}

function compatibilityEnvelope(input: {
  provider: "local-engine" | "website";
  identity: TesseraSimulationProviderIdentity;
  contractSha256: string;
  evidence?: TesseraWebsiteProviderEvidence;
  playerInputSha256: string;
  opponentInputSha256: string;
}): ProviderCompatibilityEnvelope {
  const semanticData = {
    bundleId: BUNDLE,
    engineDataSchemaVersion: 1,
    rosterRulesHash: "c".repeat(64),
    factionRulesHash: "d".repeat(64),
    mappingHash: "e".repeat(64),
    entityHashesSha256: "f".repeat(64),
  };
  const trustWithoutDigest: Omit<
    ProviderCompatibilityBundleTrustIdentity,
    "identitySha256"
  > = {
    schemaVersion: 1,
    manifest: {
      bundleId: BUNDLE,
      signingKeyId: "fixture-key",
      manifestSha256: "1".repeat(64),
      semanticIdentitySha256: "9".repeat(64),
    },
    update: {
      providerConfigured: true,
      dataTrust: "signed-verified",
      state: "ready",
      activeBundleId: BUNDLE,
      latestVerifiedBundleId: BUNDLE,
      latestUpstreamBundleId: BUNDLE,
      candidate: null,
      quarantinedScopesSha256: "2".repeat(64),
      officialAuthoritySha256: "3".repeat(64),
      rollbackHold: null,
      durability: { mode: "persistent", state: "ready", reason: null },
    },
  };
  const withoutDigest: Omit<ProviderCompatibilityEnvelope, "envelopeSha256"> = {
    schemaVersion: 1,
    kind: "rosterpilot-provider-compatibility",
    data: {
      ...semanticData,
      semanticIdentitySha256: "9".repeat(64),
      rules: {
        package: "@alpaca-software/40kdc-data",
        version: "fixture-rules-v1",
        edition: "11th",
        dataslate: "fixture",
      },
      bsData: {
        repository: "BSData/wh40k-11e",
        commit: "a".repeat(40),
      },
      official: {
        mfmVersion: "fixture",
        updatedAt: "2026-08-02T00:00:00.000Z",
        contentSha256: "a".repeat(64),
        authorityStatus: "verified",
      },
      bundleTrust: {
        ...trustWithoutDigest,
        identitySha256:
          providerCompatibilityBundleTrustIdentitySha256(
            trustWithoutDigest,
          ),
      },
    },
    rosters: [
      {
        side: "player",
        occurrence: 1,
        factionId: "adeptus-custodes",
        rosterFingerprint: PLAYER_FINGERPRINT,
        simulationInputKind:
          input.provider === "local-engine"
            ? "rosterpilot-local-engine-input"
            : "new-recruit-enriched-rosz",
        simulationInputSha256: input.playerInputSha256,
        enrichedRoszSha256:
          input.provider === "website" ? input.playerInputSha256 : null,
        newRecruit: {
          status: input.provider === "website" ? "matched" : "not-applicable",
          pinned: null,
          observed: null,
        },
      },
      {
        side: "opponent",
        occurrence: 1,
        factionId: "aeldari",
        rosterFingerprint: OPPONENT_FINGERPRINT,
        simulationInputKind:
          input.provider === "local-engine"
            ? "rosterpilot-local-engine-input"
            : "new-recruit-enriched-rosz",
        simulationInputSha256: input.opponentInputSha256,
        enrichedRoszSha256:
          input.provider === "website" ? input.opponentInputSha256 : null,
        newRecruit: {
          status: input.provider === "website" ? "matched" : "not-applicable",
          pinned: null,
          observed: null,
        },
      },
    ],
    tessera: {
      provider: input.provider,
      providerIdentitySha256: digest(input.identity),
      providerIdentity: input.identity,
      website: input.evidence ?? null,
    },
    profilePolicyHash: null,
    scenarioContractSha256: input.contractSha256,
    complete: true,
    issues: [],
  };
  return {
    ...withoutDigest,
    envelopeSha256: providerCompatibilityEnvelopeSha256(withoutDigest),
  };
}

function matchupReport(input: {
  provider: "local-engine" | "website";
  identity: TesseraSimulationProviderIdentity;
  envelope: ProviderCompatibilityEnvelope;
  settings: Record<string, string>;
  playerInput: TesseraMatchupReport["player"]["simulationInput"];
  opponentInput: TesseraMatchupReport["opponents"][number]["simulationInput"];
  playerInputSha256: string;
  opponentInputSha256: string;
  evidence?: TesseraWebsiteProviderEvidence;
  value: number;
}): TesseraMatchupReport {
  const player = unit("player");
  const opponent = unit("opponent");
  const contract = [{
    phase: "shooting" as const,
    direction: "player-to-opponent" as const,
    metric: "wipe-probability" as const,
    settings: input.settings,
    iterations: 10_000,
  }];
  return {
    schemaVersion: 4,
    runId: `${input.provider}-run`,
    generatedAt: "2026-08-02T00:00:00.000Z",
    source:
      input.provider === "local-engine"
        ? "tessera-local-engine"
        : "tessera-ui",
    status: "complete",
    failures: [],
    profilePolicyHash: null,
    scenarioContract: contract,
    scenarioContractSha256: tesseraScenarioContractSha256(contract),
    pinnedData: { bundleId: BUNDLE } as TesseraMatchupReport["pinnedData"],
    providerCompatibility: input.envelope,
    providerCompatibilityEnvelopes: [input.envelope],
    player: {
      rosterId: "player-roster",
      rosterName: "player roster",
      factionId: "adeptus-custodes",
      listUrl: null,
      sourceRoszPath: "player/source.rosz",
      enrichedRoszPath: "player/enriched.rosz",
      enrichedRoszSha256: input.playerInputSha256,
      simulationInput: input.playerInput,
      summary: {
        rosterName: "player roster",
        factionName: "Adeptus Custodes",
        totalPoints: 50,
        generatedBy: "fixture",
        profileCount: 1,
        weaponProfileCount: 1,
        units: [],
      },
      fingerprint: PLAYER_FINGERPRINT,
      units: [player],
    },
    opponents: [{
      kind: "roster",
      rosterName: "opponent roster",
      enrichedRoszPath: "opponent/enriched.rosz",
      enrichedRoszSha256: input.opponentInputSha256,
      simulationInput: input.opponentInput,
      summary: {
        rosterName: "opponent roster",
        factionName: "Aeldari",
        totalPoints: 75,
        generatedBy: "fixture",
        profileCount: 1,
        weaponProfileCount: 1,
        units: [],
      },
      fingerprint: OPPONENT_FINGERPRINT,
      units: [opponent],
    }],
    simulation: {
      requested: true,
      executionMode: "simulate",
      experimental: true,
      status: "complete",
      requestedBackend: input.provider,
      selectedBackend: input.provider,
      providerIdentity: input.identity,
      providerEvidence: input.evidence,
      engine:
        input.provider === "local-engine" ? "tessera-engine" : "tessera-ui",
      settings: input.settings,
      scenarios: [{
        scenarioId: "shooting:player-to-opponent",
        opponentName: "opponent roster",
        phase: "shooting",
        direction: "player-to-opponent",
        metrics: ["wipe-probability"],
        metricRuns: [{
          metric: "wipe-probability",
          iterations: 10_000,
          settings: input.settings,
        }],
        iterations: 10_000,
        settings: input.settings,
        cells: [{
          attacker: player,
          target: opponent,
          values: {
            wipeProbability: input.value,
            halfWipeProbability: null,
            meanKills: null,
            meanDamage: null,
            damagePer100Points: null,
          },
          uncertainty: {
            "wipe-probability": {
              sampleCount: 10_000,
              standardDeviation: null,
              standardError: null,
              completeness: "complete",
            },
          },
          confidence: "high",
          warningRefs: [],
        }],
        status: "complete",
        warnings: [],
      }],
      matrices: [],
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    limitations: [],
    warnings: [],
    artifacts: [],
  };
}

async function writeReport(
  filename: string,
  report: TesseraMatchupReport,
): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(filename, serialized);
  const receipt = createExactReportReceipt(
    path.basename(filename),
    serialized,
    report,
  );
  await writeFile(
    exactReportReceiptPath(filename),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

const LOCAL_SETTINGS = {
  provider: "local-engine",
  phase: "shooting",
  targetInCover: "false",
  charging: "false",
  withinRapidFireRange: "false",
  withinMeltaRange: "false",
  remainedStationary: "false",
  indirectFire: "false",
};

const WEBSITE_SETTINGS = {
  "Target in cover": "No",
  "Attacker charging": "No",
  "Rapid fire range": "No",
  "Melta range": "No",
  Stationary: "No",
  "Indirect fire": "No",
};

async function writePairedReports(
  directory: string,
  options: { localValue?: number; websiteValue?: number } = {},
): Promise<{
  localPath: string;
  websitePath: string;
  localReport: TesseraMatchupReport;
  websiteReport: TesseraMatchupReport;
}> {
  const playerBytes = serializeLocalTesseraEngineInput(
    localInput("player", PLAYER_FINGERPRINT),
  );
  const opponentBytes = serializeLocalTesseraEngineInput(
    localInput("opponent", OPPONENT_FINGERPRINT),
  );
  const playerInputSha256 = digest(playerBytes);
  const opponentInputSha256 = digest(opponentBytes);
  await Promise.all([
    writeFile(path.join(directory, "player-input.json"), playerBytes),
    writeFile(path.join(directory, "opponent-input.json"), opponentBytes),
  ]);
  const contractSha256 = (
    settings: Record<string, string>,
  ) => tesseraScenarioContractSha256([{
    phase: "shooting",
    direction: "player-to-opponent",
    metric: "wipe-probability",
    settings,
    iterations: 10_000,
  }]);
  const evidence = websiteEvidence();
  const localReport = matchupReport({
    provider: "local-engine",
    identity: localIdentity,
    envelope: compatibilityEnvelope({
      provider: "local-engine",
      identity: localIdentity,
      contractSha256: contractSha256(LOCAL_SETTINGS),
      playerInputSha256,
      opponentInputSha256,
    }),
    settings: LOCAL_SETTINGS,
    playerInput: {
      kind: "rosterpilot-local-engine-input",
      path: "player-input.json",
      sha256: playerInputSha256,
      bundleId: BUNDLE,
      compilerVersion: "base-profile-evaluation-v1",
    },
    opponentInput: {
      kind: "rosterpilot-local-engine-input",
      path: "opponent-input.json",
      sha256: opponentInputSha256,
      bundleId: BUNDLE,
      compilerVersion: "base-profile-evaluation-v1",
    },
    playerInputSha256,
    opponentInputSha256,
    value: options.localValue ?? 0.5,
  });
  const websiteReport = matchupReport({
    provider: "website",
    identity: websiteIdentity,
    envelope: compatibilityEnvelope({
      provider: "website",
      identity: websiteIdentity,
      contractSha256: contractSha256(WEBSITE_SETTINGS),
      evidence,
      playerInputSha256: PLAYER_INPUT_SHA_PLACEHOLDER,
      opponentInputSha256: OPPONENT_INPUT_SHA_PLACEHOLDER,
    }),
    settings: WEBSITE_SETTINGS,
    playerInput: {
      kind: "new-recruit-enriched-rosz",
      sha256: PLAYER_INPUT_SHA_PLACEHOLDER,
    },
    opponentInput: {
      kind: "new-recruit-enriched-rosz",
      sha256: OPPONENT_INPUT_SHA_PLACEHOLDER,
    },
    playerInputSha256: PLAYER_INPUT_SHA_PLACEHOLDER,
    opponentInputSha256: OPPONENT_INPUT_SHA_PLACEHOLDER,
    evidence,
    value: options.websiteValue ?? 0.505,
  });
  const localPath = path.join(directory, "local.json");
  const websitePath = path.join(directory, "website.json");
  await Promise.all([
    writeReport(localPath, localReport),
    writeReport(websitePath, websiteReport),
  ]);
  return { localPath, websitePath, localReport, websiteReport };
}

test("completed receipt-bound local and Web reports produce executable parity artifacts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rp-parity-workflow-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const { localPath, websitePath } = await writePairedReports(directory);

  const result = await runTesseraProviderParityWorkflow({
    localReportPath: localPath,
    websiteReportPath: websitePath,
    outputDirectory: path.join(directory, "out"),
    rootDir: directory,
    allowOutsideRoot: true,
  });

  assert.equal(result.ok, true, JSON.stringify(result.data, null, 2));
  assert.equal(result.data.outcome, "pass");
  assert.equal(result.data.classification, "parity-pass");
  assert.equal(result.data.sourceResolution.kind, "reports-root-sha256-run-id");
  assert.ok(
    result.data.sourceReports.every(
      (source) =>
        !path.isAbsolute(source.reportPath) &&
        !path.isAbsolute(source.receiptPath),
    ),
  );
  assert.notEqual(
    result.data.sourceReports[0].rawScenarioContractSha256,
    result.data.sourceReports[1].rawScenarioContractSha256,
  );
  assert.equal(
    result.data.sourceReports[0].normalizedScenarioContractSha256,
    result.data.sourceReports[1].normalizedScenarioContractSha256,
  );
  const jsonPath = path.join(directory, "out", "tessera-provider-parity.json");
  const htmlPath = path.join(directory, "out", "tessera-provider-parity.html");
  const checksumPath = `${jsonPath}.sha256`;
  const json = await readFile(jsonPath, "utf8");
  assert.equal(`${canonicalJson(JSON.parse(json))}\n`, json);
  assert.equal(json.includes(directory), false);
  assert.equal(
    await readFile(checksumPath, "utf8"),
    `${digest(json)}  tessera-provider-parity.json\n`,
  );
  assert.equal(result.data.sourceReports[0].executionEvidence.complete, true);
  assert.equal(
    result.data.sourceReports[1].executionEvidence.website
      ?.stateBindingsComplete,
    true,
  );
  assert.ok(
    result.data.providerAssessment.localEngine.strengths.some(
      (entry) => entry.includes("pinned tessera-engine"),
    ),
  );
  assert.ok(
    result.data.providerAssessment.website.weaknesses.some(
      (entry) => entry.includes("authoritative semantic rules version"),
    ),
  );
  const certification = await createLiveNumericalParityCertification({
    comparisonPath: jsonPath,
    reportsRoot: directory,
    generatedAt: "2026-08-02T00:00:00.000Z",
  });
  assert.equal(certification.evaluation.status, "ineligible");
  assert.equal(certification.evaluation.liveEvidence, false);
  assert.ok(
    certification.evaluation.reasons.some(
      (entry) => entry.code === "FIXTURE_ONLY_EVIDENCE",
    ),
  );
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /Local engine vs Tessera Web/);
  assert.match(html, /Provider-specific assessment/);
  assert.match(html, /not a game win probability/i);
});

test("workflow rejects a report changed after its exact receipt was written", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rp-parity-tamper-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const { localPath, websitePath, localReport } =
    await writePairedReports(directory);
  localReport.simulation.scenarios![0].cells[0].values.wipeProbability = 0.9;
  await writeFile(localPath, `${JSON.stringify(localReport, null, 2)}\n`);

  await assert.rejects(
    runTesseraProviderParityWorkflow({
      localReportPath: localPath,
      websiteReportPath: websitePath,
      outputDirectory: path.join(directory, "out"),
      rootDir: directory,
      allowOutsideRoot: true,
    }),
    /local-engine receipt verification failed:.*bytes changed/,
  );
});

test("workflow rejects provider-swapped source reports", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rp-parity-swap-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const { localPath, websitePath } = await writePairedReports(directory);
  await assert.rejects(
    runTesseraProviderParityWorkflow({
      localReportPath: websitePath,
      websiteReportPath: localPath,
      outputDirectory: path.join(directory, "out"),
      rootDir: directory,
      allowOutsideRoot: true,
    }),
    /(?:local-engine|website) input report is bound to (?:website|local-engine)/,
  );
});

test("workflow classifies eligible numerical policy failures as model drift", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rp-parity-drift-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const { localPath, websitePath } = await writePairedReports(directory, {
    localValue: 0.2,
    websiteValue: 0.9,
  });
  const result = await runTesseraProviderParityWorkflow({
    localReportPath: localPath,
    websiteReportPath: websitePath,
    outputDirectory: path.join(directory, "out"),
    rootDir: directory,
    allowOutsideRoot: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.data.outcome, "fail");
  assert.equal(result.data.classification, "model-drift");
  assert.equal(result.violations[0]?.code, "TESSERA_PROVIDER_MODEL_DRIFT");
});

test("eligible but incomplete comparator output is evidence-incomplete", () => {
  const parity = {
    outcome: "incomplete",
    eligible: true,
    issues: [],
  } as unknown as TesseraProviderParityResult;
  assert.equal(
    classifyTesseraProviderParityWorkflow(parity, true),
    "evidence-incomplete",
  );
});

test("workflow revalidates signed-bundle trust after envelope and receipt digests are recomputed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rp-parity-trust-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const { localPath, websitePath, localReport } =
    await writePairedReports(directory);
  const envelope = localReport.providerCompatibility!;
  envelope.data.bundleTrust.manifest!.semanticIdentitySha256 = "a".repeat(64);
  const trustWithoutDigest = withoutKey(
    envelope.data.bundleTrust,
    "identitySha256",
  );
  envelope.data.bundleTrust.identitySha256 =
    providerCompatibilityBundleTrustIdentitySha256(trustWithoutDigest);
  const envelopeWithoutDigest = withoutKey(envelope, "envelopeSha256");
  envelope.envelopeSha256 =
    providerCompatibilityEnvelopeSha256(envelopeWithoutDigest);
  localReport.providerCompatibilityEnvelopes = [envelope];
  await writeReport(localPath, localReport);

  const result = await runTesseraProviderParityWorkflow({
    localReportPath: localPath,
    websiteReportPath: websitePath,
    outputDirectory: path.join(directory, "out"),
    rootDir: directory,
    allowOutsideRoot: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.data.classification, "evidence-incomplete");
  assert.ok(
    result.data.adaptation.local.issues.some(
      (entry) =>
        entry.code === "PROVIDER_COMPATIBILITY_INVALID" &&
        entry.message.includes("signed-semantic-identity-binding-mismatch"),
    ),
  );
});

test("workflow fails before numeric comparison when report-bound Web evidence is absent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rp-parity-missing-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const { localPath, websitePath, websiteReport } =
    await writePairedReports(directory);
  const envelope = websiteReport.providerCompatibility!;
  // A malformed claimed-complete envelope cannot invent Web semantic evidence.
  envelope.tessera.website = null;
  const withoutDigest = withoutKey(envelope, "envelopeSha256");
  envelope.envelopeSha256 = providerCompatibilityEnvelopeSha256(withoutDigest);
  websiteReport.providerCompatibilityEnvelopes = [envelope];
  await writeReport(websitePath, websiteReport);

  const result = await runTesseraProviderParityWorkflow({
    localReportPath: localPath,
    websiteReportPath: websitePath,
    outputDirectory: path.join(directory, "out"),
    rootDir: directory,
    allowOutsideRoot: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.data.parity, null);
  assert.equal(result.data.classification, "evidence-incomplete");
  assert.equal(
    result.violations[0]?.code,
    "TESSERA_PROVIDER_PARITY_EVIDENCE_INCOMPLETE",
  );
  assert.ok(
    result.data.adaptation.website.issues.some(
      (entry) => entry.code === "REPORT_BOUND_EVIDENCE_UNAVAILABLE",
    ),
  );
});
