import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { TesseraSimulationProviderIdentity } from "../lib/rosterpilot";
import { canonicalJson } from "../lib/rosterpilot";
import {
  aggregatePersonalLocalParityRotationV1,
  createPersonalLocalParityRotationFromFilesV1,
  PersonalParityRotationAggregateError,
} from "../local/tessera/personal-parity-rotation-aggregate";
import {
  verifyPersonalLocalParityRotationRecordV1,
} from "../local/tessera/personal-local-attestation-store";
import {
  buildTesseraParityCoveringSuiteV2,
  type TesseraParityCoveringSuiteV2,
} from "../local/tessera/provider-parity-covering-suite-v2";
import {
  tesseraProviderParityCombatSnapshotSha256,
  tesseraProviderParityContractSha256,
  tesseraProviderParityModelCapabilityEnvelopeSha256,
  type TesseraParityProvider,
  type TesseraProviderParityRun,
} from "../local/tessera/provider-parity";
import type {
  TesseraProviderParityWorkflowArtifact,
  TesseraProviderParityWorkflowExactV2,
} from "../local/tessera/provider-parity-workflow";
import {
  compareTesseraProviderParityV2,
  type TesseraProviderParityRunV2,
} from "../local/tessera/provider-parity-v2";
import {
  providerParityModelCapabilityFixture,
  providerParityNamedCombatSnapshotFixture,
} from "./fixtures/tessera-provider-parity-combat";

const MACHINE = "f".repeat(64);
const BUNDLE = "b".repeat(64);

function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function suite(): TesseraParityCoveringSuiteV2 {
  return buildTesseraParityCoveringSuiteV2({
    corpusInventorySha256: "a".repeat(64),
    factions: ["a", "b", "c"].map((factionId) => ({
      factionId,
      attackerMechanicIds: [`${factionId}-attack`],
      defenderMechanicIds: [`${factionId}-defend`],
    })),
  });
}

function parityRun(input: {
  provider: TesseraParityProvider;
  coveringSuite: TesseraParityCoveringSuiteV2;
  caseId: string;
  bundleId: string;
  value?: number;
  providerIdentity: TesseraSimulationProviderIdentity;
}): TesseraProviderParityRunV2 {
  const scenarioContract = [{
    scenarioId: "shooting:player-to-opponent:mean-damage",
    phase: "shooting" as const,
    direction: "player-to-opponent" as const,
    metric: "mean-damage" as const,
    settings: { range: "18", state: "selected" },
    iterations: 10_000,
  }];
  const combatSnapshot = providerParityNamedCombatSnapshotFixture();
  const modelCapabilityEnvelope = providerParityModelCapabilityFixture();
  const base: TesseraProviderParityRun = {
    identity: {
      provider: input.provider,
      providerIdentity: digest(input.providerIdentity),
      dataBundleId: input.bundleId,
      normalizedInputSha256: "1".repeat(64),
      scenarioContractSha256:
        tesseraProviderParityContractSha256(scenarioContract),
      profilePolicyHash: null,
      modelCapabilityEnvelopeSha256:
        tesseraProviderParityModelCapabilityEnvelopeSha256(
          modelCapabilityEnvelope,
        ),
      combatSnapshotSha256:
        tesseraProviderParityCombatSnapshotSha256(combatSnapshot),
    },
    modelCapabilityEnvelope,
    combatSnapshot,
    scenarioContract,
    cells: [{
      scenarioId: scenarioContract[0].scenarioId,
      attackerInstanceId: "custodes-witchseekers-1",
      targetInstanceId: "aeldari-troupe-1",
      metric: "mean-damage",
      value: input.value ?? 3,
      iterations: 10_000,
      sampleCount: 10_000,
      standardError: 0.01,
    }],
    winnerClassifications: [],
  };
  return {
    ...base,
    schemaVersion: 2,
    contractBinding: {
      scenarioPolicyContractV3Sha256: "2".repeat(64),
      combatBridgeV3Sha256: "3".repeat(64),
      corpusConformanceReportSha256: "4".repeat(64),
      coveringSuiteSha256: input.coveringSuite.suiteSha256,
      coveringCaseId: input.caseId,
      coveringCaseEvidenceSha256: "a".repeat(64),
      combatStateSha256: "5".repeat(64),
      playerRosterFingerprint: "player",
      opponentRosterFingerprint: "opponent",
    },
    exactReceiptSha256:
      input.provider === "local-engine" ? "6".repeat(64) : "7".repeat(64),
    providerStateEvidenceSha256:
      input.provider === "local-engine" ? "8".repeat(64) : "9".repeat(64),
  };
}

const localProviderIdentity: TesseraSimulationProviderIdentity = {
  schemaVersion: 1,
  provider: "local-engine",
  engine: "tessera-engine",
  repository: "Tessera-cmd/tessera-engine",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  sourceSha256: "3".repeat(64),
  adapterVersion: "adapter-v1",
  compilerVersion: "compiler-v1",
  inputSchemaVersion: 2,
  capabilityManifestSha256: "4".repeat(64),
  promotion: "candidate",
  licenseState: "evaluation-only",
};

const websiteProviderIdentity: TesseraSimulationProviderIdentity = {
  schemaVersion: 1,
  provider: "website",
  engine: "tessera-ui",
  uiIdentity: "5".repeat(64),
  adapterVersion: "browser-v1",
};

function comparison(input: {
  coveringSuite: TesseraParityCoveringSuiteV2;
  caseId: string;
  bundleId?: string;
  websiteValue?: number;
  websiteIdentity?: TesseraSimulationProviderIdentity;
}): TesseraProviderParityWorkflowArtifact {
  const result = compareTesseraProviderParityV2(
    parityRun({
      provider: "local-engine",
      coveringSuite: input.coveringSuite,
      caseId: input.caseId,
      bundleId: input.bundleId ?? BUNDLE,
      providerIdentity: localProviderIdentity,
    }),
    parityRun({
      provider: "website",
      coveringSuite: input.coveringSuite,
      caseId: input.caseId,
      bundleId: input.bundleId ?? BUNDLE,
      value: input.websiteValue,
      providerIdentity:
        input.websiteIdentity ?? websiteProviderIdentity,
    }),
  );
  if (input.websiteValue === undefined) {
    assert.equal(result.outcome, "pass", JSON.stringify(result, null, 2));
  }
  const receipts = {
    local: "a".repeat(64),
    website: "c".repeat(64),
  };
  const exactCore: Omit<
    TesseraProviderParityWorkflowExactV2,
    "exactBindingSha256"
  > = {
    schemaVersion: 2,
    kind: "tessera-provider-parity-workflow-exact-binding",
    status: "complete",
    personalAttestationEligible:
      result.outcome === "pass" && result.eligible && result.complete,
    pairedExactReceiptsSha256: digest([
      { provider: "local-engine", receiptSha256: receipts.local },
      { provider: "website", receiptSha256: receipts.website },
    ]),
    reportEvidenceSha256: {
      localEngine: "d".repeat(64),
      website: "e".repeat(64),
    },
    issues: [],
    result,
  };
  const exactParityV2 = {
    ...exactCore,
    exactBindingSha256: digest(exactCore),
  };
  const source = (
    provider: "local-engine" | "website",
    providerIdentity: TesseraSimulationProviderIdentity,
  ) => ({
    provider,
    receiptSha256:
      provider === "local-engine" ? receipts.local : receipts.website,
    executionEvidence: {
      providerIdentity,
      providerIdentitySha256: digest(providerIdentity),
    },
  });
  return {
    schemaVersion: 1,
    kind: "tessera-provider-parity-comparison",
    exactParityV2,
    sourceReports: [
      source("local-engine", localProviderIdentity),
      source(
        "website",
        input.websiteIdentity ?? websiteProviderIdentity,
      ),
    ],
  } as unknown as TesseraProviderParityWorkflowArtifact;
}

function aggregateInput(coveringSuite = suite()) {
  return {
    coveringSuite,
    comparisons: coveringSuite.cases.map((entry) => ({
      artifact: comparison({ coveringSuite, caseId: entry.caseId }),
      machineIdSha256: MACHINE,
    })),
    machineIdSha256: MACHINE,
    rotationId: "rotation-1",
    mode: "observe" as const,
    completedAt: "2026-08-04T10:00:00.000Z",
    verifiedAt: "2026-08-04T10:01:00.000Z",
  };
}

test("multi-case aggregation seals one deterministic store-compatible rotation", () => {
  const input = aggregateInput();
  assert.ok(input.coveringSuite.cases.length > 1);
  const first = aggregatePersonalLocalParityRotationV1(input);
  const second = aggregatePersonalLocalParityRotationV1({
    ...input,
    comparisons: [...input.comparisons].reverse(),
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first.caseIds, [...first.caseIds].sort());
  assert.equal(
    first.record.rotation.exactReceiptSha256,
    first.aggregateExactReceiptSha256,
  );
  assert.equal(
    first.record.verification.parityResultSha256,
    first.aggregateParityResultSha256,
  );
  assert.equal(verifyPersonalLocalParityRotationRecordV1(first.record), true);
});

test("aggregation preserves the one-case covering-suite path", () => {
  const coveringSuite = buildTesseraParityCoveringSuiteV2({
    corpusInventorySha256: "a".repeat(64),
    factions: ["a", "b"].map((factionId) => ({
      factionId,
      attackerMechanicIds: [`${factionId}-attack`],
      defenderMechanicIds: [`${factionId}-defend`],
    })),
  });
  assert.equal(coveringSuite.cases.length, 1);
  const aggregated = aggregatePersonalLocalParityRotationV1(
    aggregateInput(coveringSuite),
  );
  assert.deepEqual(
    aggregated.caseIds,
    [coveringSuite.cases[0]!.caseId],
  );
  assert.equal(
    verifyPersonalLocalParityRotationRecordV1(aggregated.record),
    true,
  );
});

test("aggregation rejects duplicate, missing, and extra covering cases", () => {
  const duplicate = aggregateInput();
  duplicate.comparisons[1] = duplicate.comparisons[0];
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(duplicate),
    (error: unknown) =>
      error instanceof PersonalParityRotationAggregateError &&
      error.code === "PERSONAL_PARITY_AGGREGATE_DUPLICATE_CASE",
  );

  const missing = aggregateInput();
  missing.comparisons.pop();
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(missing),
    (error: unknown) =>
      error instanceof PersonalParityRotationAggregateError &&
      error.code === "PERSONAL_PARITY_AGGREGATE_MISSING_CASE",
  );

  const extra = aggregateInput();
  const artifact = comparison({
    coveringSuite: extra.coveringSuite,
    caseId: extra.coveringSuite.cases[0]!.caseId,
  });
  artifact.exactParityV2.result!.contractBinding!.coveringCaseId = "outside";
  const resultCore = {
    ...artifact.exactParityV2.result!,
    resultSha256: undefined,
  };
  delete (resultCore as { resultSha256?: string }).resultSha256;
  artifact.exactParityV2.result = {
    ...resultCore,
    resultSha256: digest(resultCore),
  };
  const exactCore = {
    ...artifact.exactParityV2,
    exactBindingSha256: undefined,
  };
  delete (exactCore as { exactBindingSha256?: string }).exactBindingSha256;
  artifact.exactParityV2.exactBindingSha256 = digest(exactCore);
  extra.comparisons.push({ artifact, machineIdSha256: MACHINE });
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(extra),
    (error: unknown) =>
      error instanceof PersonalParityRotationAggregateError &&
      error.code === "PERSONAL_PARITY_AGGREGATE_EXTRA_CASE",
  );
});

test("aggregation rejects suite, comparison, machine, bundle, and provider drift", () => {
  const suiteTamper = aggregateInput();
  suiteTamper.coveringSuite.cases[0]!.coveredRequirementIds.pop();
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(suiteTamper),
    /valid, self-hashed covering-suite-v2/,
  );

  const comparisonTamper = aggregateInput();
  comparisonTamper.comparisons[0]!.artifact.exactParityV2.result!
    .resultSha256 = "0".repeat(64);
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(comparisonTamper),
    /bad self-hash/,
  );

  const receipt = aggregateInput();
  receipt.comparisons[0]!.artifact.exactParityV2
    .pairedExactReceiptsSha256 = "0".repeat(64);
  const receiptExactCore = {
    ...receipt.comparisons[0]!.artifact.exactParityV2,
    exactBindingSha256: undefined,
  };
  delete (receiptExactCore as { exactBindingSha256?: string })
    .exactBindingSha256;
  receipt.comparisons[0]!.artifact.exactParityV2
    .exactBindingSha256 = digest(receiptExactCore);
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(receipt),
    (error: unknown) =>
      error instanceof PersonalParityRotationAggregateError &&
      error.code === "PERSONAL_PARITY_AGGREGATE_RECEIPT_INVALID",
  );

  const detachedProvider = aggregateInput();
  const detachedWebsite = detachedProvider.comparisons[0]!.artifact
    .sourceReports.find((entry) => entry.provider === "website")!;
  detachedWebsite.executionEvidence.providerIdentity = {
    ...websiteProviderIdentity,
    uiIdentity: "0".repeat(64),
  };
  detachedWebsite.executionEvidence.providerIdentitySha256 = digest(
    detachedWebsite.executionEvidence.providerIdentity,
  );
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(detachedProvider),
    (error: unknown) =>
      error instanceof PersonalParityRotationAggregateError &&
      error.code === "PERSONAL_PARITY_AGGREGATE_PROVIDER_INVALID",
  );

  const machine = aggregateInput();
  machine.comparisons[0]!.machineIdSha256 = "0".repeat(64);
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(machine),
    (error: unknown) =>
      error instanceof PersonalParityRotationAggregateError &&
      error.code === "PERSONAL_PARITY_AGGREGATE_MACHINE_MISMATCH",
  );

  const bundle = aggregateInput();
  const secondCaseId = bundle.coveringSuite.cases[1]!.caseId;
  bundle.comparisons[1]!.artifact = comparison({
    coveringSuite: bundle.coveringSuite,
    caseId: secondCaseId,
    bundleId: "0".repeat(64),
  });
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(bundle),
    (error: unknown) =>
      error instanceof PersonalParityRotationAggregateError &&
      error.code === "PERSONAL_PARITY_AGGREGATE_BUNDLE_MISMATCH",
  );

  const provider = aggregateInput();
  provider.comparisons[1]!.artifact = comparison({
    coveringSuite: provider.coveringSuite,
    caseId: provider.coveringSuite.cases[1]!.caseId,
    websiteIdentity: {
      ...websiteProviderIdentity,
      uiIdentity: "0".repeat(64),
    },
  });
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(provider),
    (error: unknown) =>
      error instanceof PersonalParityRotationAggregateError &&
      error.code === "PERSONAL_PARITY_AGGREGATE_PROVIDER_MISMATCH",
  );
});

test("aggregation rejects validly self-hashed non-passing evidence", () => {
  const input = aggregateInput();
  input.comparisons[0]!.artifact = comparison({
    coveringSuite: input.coveringSuite,
    caseId: input.coveringSuite.cases[0]!.caseId,
    websiteValue: 100,
  });
  assert.throws(
    () => aggregatePersonalLocalParityRotationV1(input),
    /non-passing/,
  );
});

test("file aggregation writes the existing private rotation-record format", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rp-personal-rotation-aggregate-"),
  );
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = aggregateInput();
  const suitePath = path.join(directory, "suite.json");
  const comparisonPaths = input.comparisons.map((_, index) =>
    path.join(directory, `comparison-${index + 1}.json`)
  );
  await Promise.all([
    writeFile(suitePath, JSON.stringify(input.coveringSuite)),
    ...input.comparisons.map((entry, index) =>
      writeFile(comparisonPaths[index]!, JSON.stringify(entry.artifact))
    ),
  ]);
  const recordPath = path.join(directory, "rotation.json");
  const created = await createPersonalLocalParityRotationFromFilesV1({
    coveringSuitePath: suitePath,
    comparisonPaths,
    machineIdSha256: MACHINE,
    rotationId: input.rotationId,
    mode: input.mode,
    completedAt: input.completedAt,
    verifiedAt: input.verifiedAt,
    recordPath,
  });

  assert.equal(created.recordPath, recordPath);
  assert.equal(
    verifyPersonalLocalParityRotationRecordV1(
      JSON.parse(await readFile(recordPath, "utf8")),
    ),
    true,
  );
});
