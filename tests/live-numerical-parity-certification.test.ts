import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLiveNumericalParityCertification,
  evaluateLiveNumericalParity,
  readVerifiedLiveNumericalParityCertification,
  resolveProviderParitySourceReportPath,
  sealLiveNumericalParityCertification,
  writeLiveNumericalParityCertification,
  type LiveNumericalParityMetricEvidence,
  type LiveNumericalParitySourceEvidence,
} from "../local/certification/live-numerical-parity";
import {
  parseLiveNumericalParityArguments,
  runLiveNumericalParityCli,
} from "../scripts/certify-live-numerical-parity";

const SHA256 = "a".repeat(64);

function passingMetrics(): LiveNumericalParityMetricEvidence[] {
  return [
    "wipe-probability",
    "half-wipe-probability",
    "mean-kills",
    "mean-damage",
  ].map((metric) => ({
    metric: metric as LiveNumericalParityMetricEvidence["metric"],
    expectedCellCount: 100,
    comparedCellCount: 100,
    withinToleranceCount: 98,
    withinToleranceRate: 0.98,
    beyondDoubleToleranceCount: 0,
    status: "pass" as const,
  }));
}

const winner = {
  classificationId: "canonical-probability-pressure-v1",
  localWinner: "player" as const,
  websiteWinner: "player" as const,
  uncertaintyBoundary: false,
  status: "pass" as const,
};

function evaluationInput() {
  return {
    comparisonAvailable: true,
    comparisonIntegrityValid: true,
    sourceReportsAvailable: true,
    sourceBindingsValid: true,
    liveEvidenceComplete: true,
    fixtureOnlyEvidence: false,
    parityOutcome: "pass" as const,
    parityEligible: true,
    parityComplete: true,
    metricSummaries: passingMetrics(),
    winnerClassifications: [winner],
  };
}

function source(
  provider: "local-engine" | "website",
): LiveNumericalParitySourceEvidence {
  return {
    provider,
    reportPath: `/evidence/${provider}.json`,
    receiptPath: `/evidence/${provider}.receipt.json`,
    reportSha256: provider === "local-engine" ? "b".repeat(64) : "c".repeat(64),
    receiptSha256: provider === "local-engine" ? "d".repeat(64) : "e".repeat(64),
    runId: `${provider}-run`,
    reportSource:
      provider === "local-engine" ? "tessera-local-engine" : "tessera-ui",
    runtimeIdentitySha256:
      provider === "local-engine" ? "f".repeat(64) : "1".repeat(64),
    providerIdentitySha256:
      provider === "local-engine" ? "2".repeat(64) : "3".repeat(64),
    providerCompatibilityEnvelopeSha256:
      provider === "local-engine" ? "4".repeat(64) : "5".repeat(64),
    evidenceKind: "live",
    complete: true,
    issueCodes: [],
  };
}

test("live parity passes only at the complete 98-percent policy boundary", () => {
  const evaluation = evaluateLiveNumericalParity(evaluationInput());

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.complete, true);
  assert.equal(evaluation.everyMetricAtLeast98Percent, true);
  assert.equal(evaluation.beyondDoubleToleranceCellCount, 0);
  assert.equal(
    evaluation.canonicalWinnerAgreementOutsideUncertainty,
    true,
  );
  assert.deepEqual(evaluation.reasons, []);
});

test("live parity fails numeric drift and canonical winner disagreement", () => {
  const metrics = passingMetrics();
  metrics[2] = {
    ...metrics[2],
    withinToleranceCount: 97,
    withinToleranceRate: 0.97,
    beyondDoubleToleranceCount: 1,
    status: "fail",
  };
  const evaluation = evaluateLiveNumericalParity({
    ...evaluationInput(),
    parityOutcome: "fail",
    metricSummaries: metrics,
    winnerClassifications: [
      {
        ...winner,
        websiteWinner: "opponent",
        status: "fail",
      },
    ],
  });

  assert.equal(evaluation.status, "fail");
  assert.deepEqual(
    new Set(evaluation.reasons.map((entry) => entry.code)),
    new Set([
      "METRIC_PASS_RATE_BELOW_98_PERCENT",
      "CELL_BEYOND_DOUBLE_TOLERANCE",
      "CANONICAL_WINNER_MISMATCH",
    ]),
  );
});

test("incomplete parity remains distinct from ineligible data drift", () => {
  const incomplete = evaluateLiveNumericalParity({
    ...evaluationInput(),
    parityOutcome: "incomplete",
    parityComplete: false,
    metricSummaries: passingMetrics().slice(0, 3),
    winnerClassifications: [],
  });
  const ineligible = evaluateLiveNumericalParity({
    ...evaluationInput(),
    parityOutcome: "ineligible",
    parityEligible: false,
  });

  assert.equal(incomplete.status, "incomplete");
  assert.ok(
    incomplete.reasons.some((entry) => entry.code === "PARITY_INCOMPLETE"),
  );
  assert.equal(ineligible.status, "ineligible");
  assert.ok(
    ineligible.reasons.some((entry) => entry.code === "PARITY_INELIGIBLE"),
  );
});

test("fixture-only evidence is ineligible and never a live pass", () => {
  const evaluation = evaluateLiveNumericalParity({
    ...evaluationInput(),
    fixtureOnlyEvidence: true,
  });

  assert.equal(evaluation.status, "ineligible");
  assert.equal(evaluation.liveEvidence, false);
  assert.ok(
    evaluation.reasons.some(
      (entry) => entry.code === "FIXTURE_ONLY_EVIDENCE",
    ),
  );
});

test("release bundle and git mismatches make otherwise passing parity ineligible", () => {
  const evaluation = evaluateLiveNumericalParity({
    ...evaluationInput(),
    releaseBindingMatches: false,
    initialReasons: [
      {
        category: "eligibility",
        code: "EXPECTED_BUNDLE_ID_MISMATCH",
        message: "Expected bundle differs from both sources.",
        provider: null,
        metric: null,
      },
      {
        category: "eligibility",
        code: "EXPECTED_GIT_HEAD_MISMATCH",
        message: "Expected git HEAD differs from both sources.",
        provider: null,
        metric: null,
      },
    ],
  });

  assert.equal(evaluation.status, "ineligible");
  assert.equal(evaluation.eligible, false);
  assert.deepEqual(
    evaluation.reasons.map((entry) => entry.code).sort(),
    ["EXPECTED_BUNDLE_ID_MISMATCH", "EXPECTED_GIT_HEAD_MISMATCH"],
  );
});

test("missing comparison evidence produces a durable unavailable result", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-parity-missing-"),
  );
  const artifact = await createLiveNumericalParityCertification({
    comparisonPath: path.join(root, "missing-comparison.json"),
    generatedAt: "2026-08-02T00:00:00.000Z",
    rotationId: "rotation-missing",
    expectedBundleId: "7".repeat(64),
    expectedGitHead: "8".repeat(40),
  });

  assert.equal(artifact.evaluation.status, "unavailable");
  assert.equal(artifact.evaluation.eligible, false);
  assert.equal(artifact.evaluation.complete, false);
  assert.equal(artifact.rotationId, "rotation-missing");
  assert.deepEqual(artifact.releaseBinding, {
    expectedBundleId: "7".repeat(64),
    observedBundleIds: [],
    expectedGitHead: "8".repeat(40),
    observedGitHeads: [],
    matched: false,
  });
  assert.ok(
    artifact.evaluation.reasons.some(
      (entry) => entry.code === "COMPARISON_UNAVAILABLE",
    ),
  );
  assert.ok(
    artifact.evaluation.reasons.some(
      (entry) => entry.code === "EXPECTED_BUNDLE_ID_MISMATCH",
    ),
  );
  assert.ok(
    artifact.evaluation.reasons.some(
      (entry) => entry.code === "EXPECTED_GIT_HEAD_MISMATCH",
    ),
  );
});

test("certification writer and parser reject changed bytes", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-parity-artifact-"),
  );
  const evaluation = evaluateLiveNumericalParity(evaluationInput());
  const artifact = sealLiveNumericalParityCertification({
    generatedAt: "2026-08-02T00:00:00.000Z",
    comparison: {
      path: "/evidence/tessera-provider-parity.json",
      checksumPath: "/evidence/tessera-provider-parity.json.sha256",
      sha256: SHA256,
      checksumSha256: "6".repeat(64),
    },
    releaseBinding: {
      expectedBundleId: null,
      observedBundleIds: ["7".repeat(64)],
      expectedGitHead: null,
      observedGitHeads: ["8".repeat(40)],
      matched: true,
    },
    sourceReports: [source("website"), source("local-engine")],
    evaluation,
  });
  const outputPath = path.join(root, "live-numerical-parity.json");
  const written = await writeLiveNumericalParityCertification(
    artifact,
    outputPath,
  );

  const verified = await readVerifiedLiveNumericalParityCertification(
    outputPath,
  );
  assert.equal(verified.reportId, artifact.reportId);
  assert.equal(verified.evaluation.status, "pass");
  assert.match(
    await readFile(written.checksumPath, "utf8"),
    /^[a-f0-9]{64}  live-numerical-parity\.json\n$/,
  );

  const original = await readFile(outputPath, "utf8");
  const changed = original.replace(
    '"status":"pass"',
    '"status":"fail"',
  );
  await writeFile(outputPath, changed, "utf8");
  await assert.rejects(
    readVerifiedLiveNumericalParityCertification(outputPath),
    /detached checksum is invalid/,
  );

  const changedSha256 = crypto
    .createHash("sha256")
    .update(changed)
    .digest("hex");
  await writeFile(
    written.checksumPath,
    `${changedSha256}  ${path.basename(outputPath)}\n`,
    "utf8",
  );
  await assert.rejects(
    readVerifiedLiveNumericalParityCertification(outputPath),
    /evaluation is not canonical|reportId does not match/,
  );
});

test("portable source lookup binds hash, run, provider, and uniqueness", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-parity-portable-"),
  );
  const firstDirectory = path.join(root, "download-one");
  await mkdir(firstDirectory);
  const report = JSON.stringify({
    runId: "portable-run",
    generatedAt: "2026-08-02T00:00:00.000Z",
    source: "tessera-local-engine",
    status: "complete",
    player: {},
    opponents: [],
    simulation: {
      selectedBackend: "local-engine",
      scenarios: [],
    },
  });
  const reportPath = path.join(firstDirectory, "matchup.json");
  await writeFile(reportPath, report, "utf8");
  const reportSha256 = crypto
    .createHash("sha256")
    .update(report)
    .digest("hex");

  assert.equal(
    await resolveProviderParitySourceReportPath({
      reportsRoot: root,
      expectedSha256: reportSha256,
      expectedRunId: "portable-run",
      expectedProvider: "local-engine",
    }),
    reportPath,
  );
  await assert.rejects(
    resolveProviderParitySourceReportPath({
      reportsRoot: root,
      expectedSha256: reportSha256,
      expectedRunId: "portable-run",
      expectedProvider: "website",
    }),
    /has no website report/,
  );

  const duplicateDirectory = path.join(root, "download-two");
  await mkdir(duplicateDirectory);
  await writeFile(
    path.join(duplicateDirectory, "same-matchup.json"),
    report,
    "utf8",
  );
  await assert.rejects(
    resolveProviderParitySourceReportPath({
      reportsRoot: root,
      expectedSha256: reportSha256,
      expectedRunId: "portable-run",
      expectedProvider: "local-engine",
    }),
    /binding is ambiguous/,
  );
});

test("CLI parser keeps the gate explicit and deterministic", () => {
  assert.deepEqual(
    parseLiveNumericalParityArguments([
      "--comparison",
      "comparison.json",
      "--out",
      "certification.json",
      "--reports-root",
      "downloaded",
      "--expected-bundle-id",
      "9".repeat(64),
      "--rotation-id",
      "rotation-1",
      "--expected-git-head",
      "a".repeat(40),
      "--overwrite",
    ]),
    {
      comparisonPath: "comparison.json",
      reportsRoot: "downloaded",
      rotationId: "rotation-1",
      expectedBundleId: "9".repeat(64),
      expectedGitHead: "a".repeat(40),
      outputPath: "certification.json",
      overwrite: true,
      help: false,
    },
  );
});

test("CLI requires a portable reports root", async () => {
  await assert.rejects(
    runLiveNumericalParityCli([
      "--comparison",
      "comparison.json",
    ]),
    /requires --reports-root/,
  );
});
