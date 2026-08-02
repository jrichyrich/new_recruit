import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLiveNumericalParityCertification,
  evaluateLiveNumericalParity,
  sealLiveNumericalParityCertification,
  writeLiveNumericalParityCertification,
  type LiveNumericalParitySourceEvidence,
} from "../local/certification/live-numerical-parity";
import {
  buildLiveNumericalParityRolloutArtifact,
  liveNumericalParityRolloutExitCode,
  readVerifiedLiveNumericalParityRolloutArtifact,
  writeLiveNumericalParityRolloutArtifact,
} from "../local/certification/live-numerical-parity-rollout-artifact";
import {
  evaluateLiveNumericalParityRollout,
  LIVE_NUMERICAL_PARITY_ENFORCEMENT_ENV,
  LIVE_NUMERICAL_PARITY_ENFORCEMENT_TAG,
  type LiveNumericalParityRolloutObservation,
} from "../local/certification/live-numerical-parity-rollout";
import {
  parseLiveNumericalParityRolloutArguments,
} from "../scripts/live-numerical-parity-rollout";

const BUNDLE_ID = "a".repeat(64);
const GIT_HEAD = "b".repeat(40);

function observation(
  index: number,
  status: LiveNumericalParityRolloutObservation["status"] = "pass",
): LiveNumericalParityRolloutObservation {
  return {
    schemaVersion: 1,
    observationKind: "live-numerical-parity-rotation",
    rotationId: `rotation-${index}`,
    observedAt: new Date(Date.UTC(2026, 7, index)).toISOString(),
    certificateReportId: String(index % 10).repeat(64),
    certificateSha256: String((index + 1) % 10).repeat(64),
    expectedBundleId: BUNDLE_ID,
    expectedGitHead: GIT_HEAD,
    status,
    eligible: status === "pass",
    complete: status === "pass",
    liveEvidence: status === "pass",
  };
}

function source(
  provider: "local-engine" | "website",
): LiveNumericalParitySourceEvidence {
  return {
    provider,
    reportPath: `/evidence/${provider}.json`,
    receiptPath: `/evidence/${provider}.receipt.json`,
    reportSha256: provider === "local-engine" ? "c".repeat(64) : "d".repeat(64),
    receiptSha256: provider === "local-engine" ? "e".repeat(64) : "f".repeat(64),
    runId: `${provider}-run`,
    reportSource:
      provider === "local-engine" ? "tessera-local-engine" : "tessera-ui",
    runtimeIdentitySha256:
      provider === "local-engine" ? "1".repeat(64) : "2".repeat(64),
    providerIdentitySha256:
      provider === "local-engine" ? "3".repeat(64) : "4".repeat(64),
    providerCompatibilityEnvelopeSha256:
      provider === "local-engine" ? "5".repeat(64) : "6".repeat(64),
    evidenceKind: "live",
    complete: true,
    issueCodes: [],
  };
}

function passEvaluation() {
  return evaluateLiveNumericalParity({
    comparisonAvailable: true,
    comparisonIntegrityValid: true,
    sourceReportsAvailable: true,
    sourceBindingsValid: true,
    liveEvidenceComplete: true,
    fixtureOnlyEvidence: false,
    releaseBindingMatches: true,
    parityOutcome: "pass",
    parityEligible: true,
    parityComplete: true,
    metricSummaries: [
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ].map((metric) => ({
      metric: metric as
        | "wipe-probability"
        | "half-wipe-probability"
        | "mean-kills"
        | "mean-damage",
      expectedCellCount: 100,
      comparedCellCount: 100,
      withinToleranceCount: 98,
      withinToleranceRate: 0.98,
      beyondDoubleToleranceCount: 0,
      status: "pass" as const,
    })),
    winnerClassifications: [
      {
        classificationId: "canonical-probability-pressure-v1",
        localWinner: "player",
        websiteWinner: "player",
        uncertaintyBoundary: false,
        status: "pass",
      },
    ],
  });
}

async function writePassCertificate(
  directory: string,
  index: number,
  rotationId = `rotation-${index}`,
): Promise<string> {
  const artifact = sealLiveNumericalParityCertification({
    generatedAt: new Date(Date.UTC(2026, 7, index)).toISOString(),
    rotationId,
    comparison: {
      path: `/evidence/comparison-${index}.json`,
      checksumPath: `/evidence/comparison-${index}.json.sha256`,
      sha256: String(index % 10).repeat(64),
      checksumSha256: String((index + 1) % 10).repeat(64),
    },
    releaseBinding: {
      expectedBundleId: BUNDLE_ID,
      observedBundleIds: [BUNDLE_ID],
      expectedGitHead: GIT_HEAD,
      observedGitHeads: [GIT_HEAD],
      matched: true,
    },
    sourceReports: [source("local-engine"), source("website")],
    evaluation: passEvaluation(),
  });
  const outputPath = path.join(
    directory,
    `live-numerical-parity-${index}.json`,
  );
  await writeLiveNumericalParityCertification(artifact, outputPath);
  return outputPath;
}

async function writeUnavailableCertificate(
  directory: string,
  index: number,
  rotationId = `rotation-${index}`,
): Promise<string> {
  const artifact = await createLiveNumericalParityCertification({
    comparisonPath: path.join(directory, `missing-${index}.json`),
    reportsRoot: directory,
    rotationId,
    expectedBundleId: BUNDLE_ID,
    expectedGitHead: GIT_HEAD,
    generatedAt: new Date(Date.UTC(2026, 7, index)).toISOString(),
  });
  assert.equal(artifact.evaluation.status, "unavailable");
  const outputPath = path.join(
    directory,
    `live-numerical-parity-${index}.json`,
  );
  await writeLiveNumericalParityCertification(artifact, outputPath);
  return outputPath;
}

async function writeReleaseMismatchCertificate(
  directory: string,
  index: number,
): Promise<string> {
  const observedBundleId = "9".repeat(64);
  const evaluation = evaluateLiveNumericalParity({
    comparisonAvailable: true,
    comparisonIntegrityValid: true,
    sourceReportsAvailable: true,
    sourceBindingsValid: true,
    liveEvidenceComplete: true,
    fixtureOnlyEvidence: false,
    releaseBindingMatches: false,
    parityOutcome: "pass",
    parityEligible: true,
    parityComplete: true,
    metricSummaries: passEvaluation().metricSummaries,
    winnerClassifications: passEvaluation().winnerClassifications,
    initialReasons: [
      {
        category: "eligibility",
        code: "EXPECTED_BUNDLE_ID_MISMATCH",
        message: "The observed bundle does not match the release expectation.",
        provider: null,
        metric: null,
      },
    ],
  });
  assert.equal(evaluation.status, "ineligible");
  const artifact = sealLiveNumericalParityCertification({
    generatedAt: new Date(Date.UTC(2026, 7, index)).toISOString(),
    rotationId: `rotation-${index}`,
    comparison: {
      path: `/evidence/comparison-${index}.json`,
      checksumPath: `/evidence/comparison-${index}.json.sha256`,
      sha256: "7".repeat(64),
      checksumSha256: "8".repeat(64),
    },
    releaseBinding: {
      expectedBundleId: BUNDLE_ID,
      observedBundleIds: [observedBundleId],
      expectedGitHead: GIT_HEAD,
      observedGitHeads: [GIT_HEAD],
      matched: false,
    },
    sourceReports: [source("local-engine"), source("website")],
    evaluation,
  });
  const outputPath = path.join(
    directory,
    `live-numerical-parity-${index}.json`,
  );
  await writeLiveNumericalParityCertification(artifact, outputPath);
  return outputPath;
}

test("numerical parity observes until three consecutive passes", () => {
  const observing = evaluateLiveNumericalParityRollout({
    observations: [observation(1), observation(2)],
  });
  assert.equal(observing.enforcementActive, false);
  assert.equal(observing.releaseGate, "observe");
  assert.equal(observing.consecutivePasses, 2);

  const activated = evaluateLiveNumericalParityRollout({
    observations: [observation(3), observation(1), observation(2)],
  });
  assert.equal(activated.enforcementActive, true);
  assert.equal(activated.enforcementActivatedAtRotationId, "rotation-3");
  assert.equal(activated.releaseGate, "pass");
});

test("unavailable does not advance or reset, while an available fail resets", () => {
  const unavailable = evaluateLiveNumericalParityRollout({
    observations: [
      observation(1),
      observation(2, "unavailable"),
      observation(3),
    ],
  });
  assert.equal(unavailable.consecutivePasses, 2);
  assert.equal(unavailable.enforcementActive, false);

  const failed = evaluateLiveNumericalParityRollout({
    observations: [
      observation(1),
      observation(2),
      observation(3, "fail"),
      observation(4),
    ],
  });
  assert.equal(failed.consecutivePasses, 1);
  assert.equal(failed.releaseGate, "observe");
});

test("the separate sticky latch blocks missing and current non-pass evidence", () => {
  const missing = evaluateLiveNumericalParityRollout({
    observations: [],
    enforcementLatchActive: true,
  });
  assert.equal(missing.releaseGate, "block");
  assert.equal(liveNumericalParityRolloutExitCode(missing), 2);

  const unavailable = evaluateLiveNumericalParityRollout({
    observations: [observation(4, "unavailable")],
    enforcementLatchActive: true,
  });
  assert.equal(unavailable.releaseGate, "block");

  const passing = evaluateLiveNumericalParityRollout({
    observations: [observation(5)],
    enforcementLatchActive: true,
    currentRotationId: "rotation-5",
  });
  assert.equal(passing.releaseGate, "pass");
  assert.equal(liveNumericalParityRolloutExitCode(passing), 0);

  const staleWithoutCurrentIdentity = evaluateLiveNumericalParityRollout({
    observations: [observation(5)],
    enforcementLatchActive: true,
  });
  assert.equal(staleWithoutCurrentIdentity.latestStatus, "missing");
  assert.equal(staleWithoutCurrentIdentity.releaseGate, "block");
});

test("enforcement requires the explicitly selected current rotation", () => {
  const historical = [observation(1), observation(2), observation(3)];
  const missingCurrent = evaluateLiveNumericalParityRollout({
    observations: historical,
    enforcementLatchActive: true,
    currentRotationId: "rotation-4",
  });
  assert.equal(missingCurrent.enforcementActive, true);
  assert.equal(missingCurrent.requiredCurrentRotationId, "rotation-4");
  assert.equal(missingCurrent.latestRotationId, null);
  assert.equal(missingCurrent.latestStatus, "missing");
  assert.equal(missingCurrent.releaseGate, "block");

  const passingCurrent = evaluateLiveNumericalParityRollout({
    observations: [...historical, observation(4)],
    enforcementLatchActive: true,
    currentRotationId: "rotation-4",
  });
  assert.equal(passingCurrent.latestRotationId, "rotation-4");
  assert.equal(passingCurrent.latestStatus, "pass");
  assert.equal(passingCurrent.releaseGate, "pass");
});

test("duplicate rotation IDs are rejected outright", () => {
  assert.throws(
    () =>
      evaluateLiveNumericalParityRollout({
        observations: [observation(1), observation(1)],
      }),
    /Duplicate live numerical parity rotationId/,
  );
});

test("rollout loader verifies certificates and preserves current-rotation state", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-numeric-rollout-"),
  );
  await writeUnavailableCertificate(root, 3);

  const artifact = await buildLiveNumericalParityRolloutArtifact({
    reportsRoot: root,
    generatedAt: "2026-08-04T00:00:00.000Z",
    currentRotationId: "rotation-3",
  });
  assert.equal(artifact.observations.length, 1);
  assert.equal(artifact.evaluation.enforcementActive, false);
  assert.equal(artifact.evaluation.releaseGate, "observe");
  assert.equal(artifact.evaluation.latestStatus, "unavailable");
  assert.equal(
    artifact.evaluation.requiredCurrentRotationId,
    "rotation-3",
  );

  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-numeric-rollout-output-"),
  );
  const written = await writeLiveNumericalParityRolloutArtifact({
    artifact,
    outputPath: path.join(
      outputRoot,
      "live-numerical-parity-rollout-1.json",
    ),
  });
  assert.match(
    await readFile(written.checksumPath, "utf8"),
    /^[a-f0-9]{64}  live-numerical-parity-rollout-1\.json\n$/,
  );
  assert.equal(
    (
      await readVerifiedLiveNumericalParityRolloutArtifact(
        written.reportPath,
      )
    ).reportId,
    artifact.reportId,
  );
});

test("rollout loader rejects duplicate certificate rotations", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-numeric-rollout-duplicate-"),
  );
  await writeUnavailableCertificate(root, 1, "duplicate-rotation");
  await writeUnavailableCertificate(root, 2, "duplicate-rotation");

  await assert.rejects(
    buildLiveNumericalParityRolloutArtifact({ reportsRoot: root }),
    /duplicate certificate rotationId/,
  );
});

test("rollout loader rejects duplicate rotations across retained history", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-numeric-rollout-history-duplicate-"),
  );
  await writeUnavailableCertificate(root, 1);
  const retained = await buildLiveNumericalParityRolloutArtifact({
    reportsRoot: root,
    generatedAt: "2026-08-02T12:00:00.000Z",
  });
  await writeLiveNumericalParityRolloutArtifact({
    artifact: retained,
    outputPath: path.join(
      root,
      "live-numerical-parity-rollout-retained.json",
    ),
  });

  await assert.rejects(
    buildLiveNumericalParityRolloutArtifact({ reportsRoot: root }),
    /duplicate retained evidence for rotation "rotation-1"/,
  );
});

test("rollout loader records unavailable and expected-release mismatch certificates", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-numeric-rollout-nonpass-"),
  );
  await writeUnavailableCertificate(root, 2);

  const withUnavailable =
    await buildLiveNumericalParityRolloutArtifact({
      reportsRoot: root,
      generatedAt: "2026-08-04T00:00:00.000Z",
    });
  assert.equal(withUnavailable.observations[0].status, "unavailable");
  assert.equal(withUnavailable.evaluation.consecutivePasses, 0);

  await writeReleaseMismatchCertificate(root, 4);
  const withMismatch = await buildLiveNumericalParityRolloutArtifact({
    reportsRoot: root,
    generatedAt: "2026-08-05T00:00:00.000Z",
  });
  assert.equal(withMismatch.observations.at(-1)?.status, "ineligible");
  assert.equal(withMismatch.evaluation.consecutivePasses, 0);
});

test("rollout loader rejects a certificate with a changed checksum", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-numeric-rollout-tamper-"),
  );
  const certificatePath = await writeUnavailableCertificate(root, 1);
  await writeFile(
    `${certificatePath}.sha256`,
    `${"0".repeat(64)}  ${path.basename(certificatePath)}\n`,
    "utf8",
  );

  await assert.rejects(
    buildLiveNumericalParityRolloutArtifact({ reportsRoot: root }),
    /detached checksum is invalid/,
  );
});

test("rollout loader rejects a self-authored pass without exact source evidence", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-numeric-rollout-untrusted-pass-"),
  );
  await writePassCertificate(root, 1);

  await assert.rejects(
    buildLiveNumericalParityRolloutArtifact({ reportsRoot: root }),
    /no provider comparison with SHA-256/,
  );
});

test("rollout CLI and latch names remain separate from provider compatibility", () => {
  const parsed = parseLiveNumericalParityRolloutArguments([
    "--reports-root",
    "reports",
    "--out",
    "live-numerical-parity-rollout-1.json",
    "--enforcement-latch",
    "enforce",
    "--current-rotation-id",
    "rotation-9",
  ]);
  assert.equal(parsed.enforcementLatchActive, true);
  assert.equal(parsed.currentRotationId, "rotation-9");
  assert.equal(
    path.basename(parsed.outputPath),
    "live-numerical-parity-rollout-1.json",
  );
  assert.equal(
    LIVE_NUMERICAL_PARITY_ENFORCEMENT_TAG,
    "rosterpilot-live-numerical-parity-enforced-v1",
  );
  assert.equal(
    LIVE_NUMERICAL_PARITY_ENFORCEMENT_ENV,
    "ROSTERPILOT_LIVE_NUMERICAL_PARITY_ENFORCED",
  );
});
