import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type { TesseraMatchupReport } from "../lib/rosterpilot";
import {
  createExactReportReceipt,
  exactReportEvidenceSha256,
  exactReportEvidenceSha256V2,
  parseExactReportReceipt,
  type ExactMatchupReportReceiptV1,
  type ExactMatchupReportReceiptV2,
  verifyExactReportReceipt,
} from "../local/tessera/exact-report-integrity";
import {
  localTesseraScenarioPolicyContractV2,
  tesseraScenarioPolicyContractV2Sha256,
} from "../local/tessera/scenario-contract-v2";
import {
  localTesseraScenarioPolicyContractV3,
  tesseraScenarioPolicyContractV3Sha256,
} from "../local/tessera/scenario-contract-v3";

const REPORT_PATH = "/tmp/exact-matchup.json";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function sha256(value: string | unknown): string {
  const content = typeof value === "string"
    ? value
    : JSON.stringify(canonicalize(value));
  return crypto.createHash("sha256").update(content).digest("hex");
}

function providerIdentity() {
  return {
    schemaVersion: 1 as const,
    provider: "local-engine" as const,
    engine: "tessera-engine" as const,
    repository: "Tessera-cmd/tessera-engine" as const,
    commit: "1".repeat(40),
    tree: "2".repeat(40),
    sourceSha256: sha256("engine-source"),
    adapterVersion: "fixture-adapter-v1",
    compilerVersion: "fixture-compiler-v1",
    inputSchemaVersion: 1 as const,
    capabilityManifestSha256: sha256("capabilities"),
    promotion: "candidate" as const,
    licenseState: "evaluation-only" as const,
  };
}

function providerCompatibilityEnvelope(
  bundleId: string,
  identity: ReturnType<typeof providerIdentity>,
) {
  const trustCore = {
    schemaVersion: 1,
    manifest: null,
    update: {
      providerConfigured: true,
      dataTrust: "locally-verified",
      providerMode: "local-source",
      state: "ready",
      activeBundleId: bundleId,
      latestVerifiedBundleId: bundleId,
      latestUpstreamBundleId: bundleId,
      candidate: null,
      quarantinedScopesSha256: sha256("no-quarantines"),
      officialAuthoritySha256: sha256("official-authority"),
      rollbackHold: null,
      durability: {
        mode: "persistent",
        state: "ready",
        reason: null,
      },
    },
  };
  const bundleTrust = {
    ...trustCore,
    identitySha256: sha256(trustCore),
  };
  const core = {
    schemaVersion: 1,
    kind: "rosterpilot-provider-compatibility",
    data: {
      bundleId,
      bundleTrust,
    },
    rosters: [],
    tessera: {
      provider: "local-engine",
      providerIdentitySha256: sha256(identity),
      providerIdentity: identity,
      website: null,
    },
    profilePolicyHash: null,
    scenarioContractSha256: sha256("scenario-contract"),
    complete: false,
    issues: [],
  };
  return {
    ...core,
    envelopeSha256: sha256(core),
  };
}

function preparedRoster(
  side: "player" | "opponent",
  bundleId: string,
) {
  const sourceSha256 = sha256(`${side}-source`);
  const inputSha256 = sha256(`${side}-input`);
  return {
    rosterId: `${side}-roster-id`,
    rosterName: `${side} roster`,
    factionId: `${side}-faction`,
    listUrl: null,
    sourceRoszPath: `${side}-source.json`,
    enrichedRoszPath: `${side}-input.json`,
    sourceRoszSha256: sourceSha256,
    enrichedRoszSha256: inputSha256,
    preparedArtifact: {
      schemaVersion: 2,
      kind: "bundle-native",
      sourceRosterPath: `${side}-source.json`,
      sourceRosterSha256: sourceSha256,
      engineInputPath: `${side}-input.json`,
      engineInputSha256: inputSha256,
      bundleId,
      compilerVersion: "fixture-compiler-v1",
      connectorEvents: [],
    },
    simulationInput: {
      kind: "rosterpilot-local-engine-input",
      path: `${side}-input.json`,
      sha256: inputSha256,
      bundleId,
      compilerVersion: "fixture-compiler-v1",
    },
    summary: {
      rosterName: `${side} roster`,
      factionName: `${side} faction`,
      totalPoints: 1_000,
      unitCount: 1,
      modelCount: 1,
      units: [],
      profileCounts: {},
      profileRich: true,
    },
    fingerprint: sha256(`${side}-fingerprint`),
    units: [],
  };
}

function fixtureReport(): TesseraMatchupReport {
  const bundleId = sha256("bundle");
  const identity = providerIdentity();
  const scenarioPolicyContractV2 =
    localTesseraScenarioPolicyContractV2(
      10_000,
      ["shooting"],
      ["mean-damage"],
    );
  const bridgeCore = {
    schemaVersion: 1,
    kind: "rosterpilot-combat-bridge-evidence",
    opponentName: "opponent roster",
    bridgeSha256: sha256("bridge"),
    replay: {
      mode: "deterministic-recompile",
      scenarioPolicyContractV2Sha256:
        tesseraScenarioPolicyContractV2Sha256(
          scenarioPolicyContractV2,
        ),
    },
  };
  const envelope = providerCompatibilityEnvelope(bundleId, identity);
  return {
    schemaVersion: 3,
    runId: "receipt-v2-fixture",
    generatedAt: "2026-08-04T00:00:00.000Z",
    source: "tessera-local-engine",
    status: "complete",
    profilePolicyHash: null,
    scenarioContract: [],
    scenarioContractSha256: sha256("scenario-contract"),
    scenarioPolicyContractV2,
    scenarioPolicyContractV2Sha256:
      tesseraScenarioPolicyContractV2Sha256(
        scenarioPolicyContractV2,
      ),
    pinnedData: {
      bundleId,
    } as TesseraMatchupReport["pinnedData"],
    providerCompatibility:
      envelope as unknown as TesseraMatchupReport["providerCompatibility"],
    providerCompatibilityEnvelopes: [
      envelope as unknown as TesseraMatchupReport["providerCompatibility"],
    ],
    comparisonClass: "matched",
    configuration: {} as TesseraMatchupReport["configuration"],
    pointsComparisons: [],
    player: preparedRoster("player", bundleId),
    opponents: [{
      kind: "roster",
      ...preparedRoster("opponent", bundleId),
    }],
    simulation: {
      requested: true,
      executionMode: "simulate",
      experimental: true,
      status: "complete",
      requestedBackend: "local-engine",
      selectedBackend: "local-engine",
      providerIdentity: identity,
      engine: "tessera-engine",
      settings: {},
      combatBridgeEvidence: [{
        ...bridgeCore,
        evidenceSha256: sha256(bridgeCore),
      }],
      matrices: [],
      scenarios: [],
    },
    strengths: [],
    weaknesses: [],
    suggestions: [],
    limitations: [],
    warnings: [],
    artifacts: [],
  } as unknown as TesseraMatchupReport;
}

function serialize(report: TesseraMatchupReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function rewriteOuterHashes(
  receipt: ExactMatchupReportReceiptV2,
  report: TesseraMatchupReport,
): ExactMatchupReportReceiptV2 {
  const serialized = serialize(report);
  return {
    ...structuredClone(receipt),
    reportSha256: sha256(serialized),
    evidenceSha256: exactReportEvidenceSha256V2(report),
  };
}

test("exact report receipt v2 binds the complete execution evidence", () => {
  const report = fixtureReport();
  const serialized = serialize(report);
  const receipt = createExactReportReceipt(
    REPORT_PATH,
    serialized,
    report,
  );

  assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(
    receipt.bindings.scenarioPolicies.map((item) => item.schemaVersion),
    [2],
  );
  assert.equal(receipt.bindings.combatBridgeEvidence.count, 1);
  assert.equal(receipt.bindings.sourceArtifacts.rosters.length, 2);
  assert.equal(
    receipt.bindings.providerIdentity.provider,
    "local-engine",
  );
  assert.equal(
    receipt.bindings.bundleCompatibility.bundleId,
    report.pinnedData?.bundleId,
  );
  assert.equal(
    verifyExactReportReceipt(
      REPORT_PATH,
      serialized,
      report,
      receipt,
    ),
    null,
  );
  assert.deepEqual(parseExactReportReceipt(receipt), receipt);
});

test("receipt parsing is strict while schema-v1 receipts remain verifiable", () => {
  const report = fixtureReport();
  const serialized = serialize(report);
  const legacyReceipt: ExactMatchupReportReceiptV1 = {
    schemaVersion: 1,
    kind: "tessera-exact-matchup-report-receipt",
    reportFilename: "exact-matchup.json",
    reportSha256: sha256(serialized),
    evidenceSha256: exactReportEvidenceSha256(report),
    runId: report.runId,
  };

  assert.equal(
    verifyExactReportReceipt(
      REPORT_PATH,
      serialized,
      report,
      legacyReceipt,
    ),
    null,
  );
  assert.equal(parseExactReportReceipt(legacyReceipt).schemaVersion, 1);
  assert.throws(
    () => parseExactReportReceipt({
      ...createExactReportReceipt(REPORT_PATH, serialized, report),
      unboundField: true,
    }),
    /malformed.*unrecognized/i,
  );
  assert.match(
    verifyExactReportReceipt(
      REPORT_PATH,
      serialized,
      report,
      { ...legacyReceipt, schemaVersion: 3 },
    ) ?? "",
    /missing or malformed/i,
  );
});

test("scenario-policy tampering is rejected after outer hashes are rewritten", () => {
  const original = fixtureReport();
  const receipt = createExactReportReceipt(
    REPORT_PATH,
    serialize(original),
    original,
  );
  const tampered = structuredClone(original) as TesseraMatchupReport;
  const changedPolicy = localTesseraScenarioPolicyContractV2(
    20_000,
    ["shooting"],
    ["mean-damage"],
  );
  tampered.scenarioPolicyContractV2 = changedPolicy;
  tampered.scenarioPolicyContractV2Sha256 =
    tesseraScenarioPolicyContractV2Sha256(changedPolicy);
  const rewritten = rewriteOuterHashes(receipt, tampered);

  assert.match(
    verifyExactReportReceipt(
      REPORT_PATH,
      serialize(tampered),
      tampered,
      rewritten,
    ) ?? "",
    /scenario-policy evidence changed/i,
  );
});

test("receipt v2 binds scenario-policy v3 evidence when a report retains it", () => {
  const report = fixtureReport();
  const extended = report as TesseraMatchupReport & {
    scenarioPolicyContractV3: unknown;
    scenarioPolicyContractV3Sha256: string;
  };
  extended.scenarioPolicyContractV3 =
    localTesseraScenarioPolicyContractV3(
      10_000,
      {
        playerSelectionIds: ["player-unit"],
        opponentSelectionIds: ["opponent-unit"],
      },
      ["shooting"],
      ["mean-damage"],
    );
  extended.scenarioPolicyContractV3Sha256 =
    tesseraScenarioPolicyContractV3Sha256(
      extended.scenarioPolicyContractV3,
    );
  const receipt = createExactReportReceipt(
    REPORT_PATH,
    serialize(report),
    report,
  );

  assert.deepEqual(
    receipt.bindings.scenarioPolicies.map((item) => item.schemaVersion),
    [2, 3],
  );
  assert.equal(
    verifyExactReportReceipt(
      REPORT_PATH,
      serialize(report),
      report,
      receipt,
    ),
    null,
  );
});

test("bridge and source-artifact tampering are rejected independently", () => {
  const original = fixtureReport();
  const receipt = createExactReportReceipt(
    REPORT_PATH,
    serialize(original),
    original,
  );

  const bridgeTampered = structuredClone(original) as TesseraMatchupReport;
  const bridge = bridgeTampered.simulation.combatBridgeEvidence?.[0] as
    unknown as Record<string, unknown>;
  bridge.bridgeSha256 = sha256("changed-bridge");
  const bridgeCore = { ...bridge };
  delete bridgeCore.evidenceSha256;
  bridge.evidenceSha256 = sha256(bridgeCore);
  const rewrittenBridge = rewriteOuterHashes(receipt, bridgeTampered);
  assert.match(
    verifyExactReportReceipt(
      REPORT_PATH,
      serialize(bridgeTampered),
      bridgeTampered,
      rewrittenBridge,
    ) ?? "",
    /combat-bridge evidence changed/i,
  );

  const sourceTampered = structuredClone(original) as TesseraMatchupReport;
  const player = sourceTampered.player as unknown as Record<string, unknown>;
  const changedSource = sha256("changed-player-source");
  player.sourceRoszSha256 = changedSource;
  (player.preparedArtifact as Record<string, unknown>).sourceRosterSha256 =
    changedSource;
  const rewrittenSource = rewriteOuterHashes(receipt, sourceTampered);
  assert.match(
    verifyExactReportReceipt(
      REPORT_PATH,
      serialize(sourceTampered),
      sourceTampered,
      rewrittenSource,
    ) ?? "",
    /source-artifact identity changed/i,
  );
});

test("provider and bundle-compatibility tampering are rejected", () => {
  const original = fixtureReport();
  const receipt = createExactReportReceipt(
    REPORT_PATH,
    serialize(original),
    original,
  );

  const compatibilityTampered = structuredClone(original) as
    TesseraMatchupReport;
  const envelope = compatibilityTampered.providerCompatibility as unknown as
    Record<string, unknown>;
  envelope.complete = true;
  const envelopeCore = { ...envelope };
  delete envelopeCore.envelopeSha256;
  envelope.envelopeSha256 = sha256(envelopeCore);
  compatibilityTampered.providerCompatibilityEnvelopes = [
    envelope as unknown as NonNullable<
      TesseraMatchupReport["providerCompatibility"]
    >,
  ];
  const rewritten = rewriteOuterHashes(receipt, compatibilityTampered);
  assert.match(
    verifyExactReportReceipt(
      REPORT_PATH,
      serialize(compatibilityTampered),
      compatibilityTampered,
      rewritten,
    ) ?? "",
    /bundle or provider-compatibility evidence changed/i,
  );

  const invalidBundle = structuredClone(original) as TesseraMatchupReport;
  (invalidBundle.pinnedData as unknown as Record<string, unknown>).bundleId =
    sha256("different-bundle");
  const invalidSerialized = serialize(invalidBundle);
  const rewrittenBytesOnly = {
    ...receipt,
    reportSha256: sha256(invalidSerialized),
  };
  assert.match(
    verifyExactReportReceipt(
      REPORT_PATH,
      invalidSerialized,
      invalidBundle,
      rewrittenBytesOnly,
    ) ?? "",
    /invalid receipt-bound evidence.*pinned bundle/i,
  );
});
