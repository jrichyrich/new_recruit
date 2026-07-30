import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CertificationReportSchema,
  type CertificationArtifactDescriptor,
  type CertificationCaseResult,
  type CertificationReport,
} from "../lib/rosterpilot/certification";
import {
  loadVerifiedCertificationResumeReport,
} from "../local/certification/live-resume";

const manifestSha256 = "a".repeat(64);

function statusCounts() {
  return {
    pass: 0,
    fail: 0,
    unsupported: 0,
    degraded: 0,
    skipped: 0,
  };
}

function reportFixture(): CertificationReport {
  const event = {
    schemaVersion: 1 as const,
    eventId: "resume-event",
    recordedAt: "2026-07-30T00:00:01.000Z",
    provider: "new-recruit" as const,
    action: "prepare" as const,
    origin: "persistent-cache" as const,
    outcome: "reused" as const,
    remoteId: "remote-fixture",
    contentSha256: "b".repeat(64),
  };
  const artifact: CertificationArtifactDescriptor = {
    kind: "canonical-rosz",
    path: "artifacts/canonical.rosz",
    sha256: "c".repeat(64),
  };
  const caseResult: CertificationCaseResult = {
    caseId: "death-guard:build:1000",
    factionId: "death-guard",
    workflow: "roster-correctness",
    stage: "build-and-validate",
    status: "pass",
    code: null,
    message: "fixture passed",
    retryable: false,
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:00:01.000Z",
    durationMs: 1_000,
    evidence: {
      executionFingerprint: "fixture-fingerprint",
    },
    artifacts: [artifact],
    connectorEvents: [event],
  };
  return {
    schemaVersion: 1,
    reportKind: "rosterpilot-certification",
    runId: "resume-report-fixture",
    tier: "live",
    generatedAt: "2026-07-30T00:00:02.000Z",
    ok: true,
    status: "pass",
    manifestSha256,
    resumedFrom: null,
    selection: {
      requestedFaction: "death-guard",
      shard: { index: 1, total: 4 },
      changedOnly: false,
      selectedFactionIds: ["death-guard", "orks"],
    },
    provenance: {
      runtime: {
        rosterPilotVersion: "0.2.0",
        rulesPackageVersion: "1.2.1",
        stressGeneratorVersion: "faction-stress-v4",
        processStartedAt: "2026-07-30T00:00:00.000Z",
        gitHead: "d".repeat(40),
        sourceFingerprintAtStart: "e".repeat(64),
        sourceFingerprintNow: "e".repeat(64),
        buildId: "resume-build",
        stale: false,
      },
      localAgent: {
        version: "0.2.0",
        protocolVersion: 1,
        runtime: {
          rosterPilotVersion: "0.2.0",
          rulesPackageVersion: "1.2.1",
          stressGeneratorVersion: "faction-stress-v4",
          processStartedAt: "2026-07-30T00:00:00.000Z",
          gitHead: "4".repeat(40),
          sourceFingerprintAtStart: "5".repeat(64),
          sourceFingerprintNow: "5".repeat(64),
          buildId: "agent-build",
          stale: false,
        },
        buildId: "agent-build",
        stale: false,
      },
      newRecruitUi: {
        identity: "3".repeat(64),
      },
      tesseraUi: {
        identity: "tessera-ui-fixture",
      },
      profilePolicy: {
        source: "cli",
        requestedBasename: "profiles.json",
        artifactPath: "profiles.json",
        sourceSha256: "f".repeat(64),
        canonicalSha256: "1".repeat(64),
      },
      dataPin: {
        releaseId: "2026-07-30.1",
        rulesPackageVersion: "1.2.1",
        newRecruitCommit: "2".repeat(40),
      },
      cachedLiveUpdateCheck: {
        state: "current",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    },
    baselines: {
      buildableFactions: 35,
      exportCapableFactions: 35,
      blockingConflicts: 676,
      uniqueBlockingConflicts: 676,
      actualBuildableFactions: 35,
      actualExportCapableFactions: 35,
      actualBlockingConflicts: 676,
      actualUniqueBlockingConflicts: 676,
    },
    coverage: {
      factions: {
        intended: 2,
        exercised: 2,
        passed: 2,
        failed: 0,
        unsupported: 0,
        pendingExpertReview: 0,
      },
      workflows: {
        oracle: statusCounts(),
        "roster-correctness": {
          ...statusCounts(),
          pass: 1,
        },
        "new-recruit-export": statusCounts(),
        "new-recruit-delivery": statusCounts(),
        "tessera-preparation": statusCounts(),
        "tessera-simulation": statusCounts(),
        "browser-fixture": statusCounts(),
      },
      browserFixtures: {
        intended: 22,
        exercised: 0,
      },
      dimensions: {
        detachments: {
          intended: [],
          exercised: [],
          missing: [],
        },
        unitCategories: {
          exercised: [],
          caseCountByCategory: {},
        },
        specialistCases: {
          intended: [],
          exercised: [],
          missing: [],
          evidenceCaseIds: {},
        },
        failureModes: [],
      },
    },
    cases: [caseResult],
    connectorEvents: [event],
    artifacts: [
      artifact,
      {
        kind: "manifest",
        path: "certification-manifest.json",
        sha256: "3".repeat(64),
      },
      {
        kind: "report",
        path: "certification-report-resume-report-fixture.json",
        sha256: null,
      },
      {
        kind: "report-checksum",
        path:
          "certification-report-resume-report-fixture.json.sha256",
        sha256: null,
      },
    ],
    limitations: ["fixture limitation"],
  };
}

function reportBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(content: Uint8Array): string {
  return crypto
    .createHash("sha256")
    .update(content)
    .digest("hex");
}

async function temporaryDirectory<T>(
  action: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-resume-report-"),
  );
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeResumeFixture(input: {
  directory: string;
  value?: unknown;
  content?: Uint8Array;
  checksum?: string | null;
}): Promise<{
  reportPath: string;
  content: Uint8Array;
}> {
  const reportPath = path.join(
    input.directory,
    "certification-report-resume-report-fixture.json",
  );
  const content =
    input.content ??
    reportBytes(input.value ?? reportFixture());
  await writeFile(reportPath, content);
  if (input.checksum !== null) {
    const checksum =
      input.checksum ??
      `${sha256(content)}  ${path.basename(reportPath)}\n`;
    await writeFile(`${reportPath}.sha256`, checksum);
  }
  return { reportPath, content };
}

function loaderInput(
  reportPath: string,
  overrides: Partial<{
    expectedTier: CertificationReport["tier"];
    expectedManifestSha256: string;
    expectedSelection: CertificationReport["selection"];
  }> = {},
) {
  const report = reportFixture();
  return {
    resumePath: reportPath,
    expectedTier: overrides.expectedTier ?? report.tier,
    expectedManifestSha256:
      overrides.expectedManifestSha256 ??
      report.manifestSha256,
    expectedSelection:
      overrides.expectedSelection ?? report.selection,
  };
}

async function assertResumeCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(
      (error as Error & { code?: string }).code,
      code,
    );
    return true;
  });
}

test("CertificationReportSchema accepts the complete v1 report contract", () => {
  const fixture = reportFixture();
  const parsed = CertificationReportSchema.parse(fixture);
  assert.deepEqual(parsed, fixture);
  assert.deepEqual(
    parsed.provenance.localAgent.runtime,
    fixture.provenance.localAgent.runtime,
  );
  assert.equal(
    parsed.provenance.newRecruitUi.identity,
    "3".repeat(64),
  );
});

test("CertificationReportSchema migrates legacy UI and local-agent provenance to explicit nulls", () => {
  const legacy = structuredClone(reportFixture()) as unknown as {
    provenance: {
      localAgent: Record<string, unknown>;
      newRecruitUi?: unknown;
    };
  };
  delete legacy.provenance.localAgent.runtime;
  delete legacy.provenance.newRecruitUi;
  const parsed = CertificationReportSchema.parse(legacy);
  assert.equal(parsed.provenance.localAgent.runtime, null);
  assert.equal(parsed.provenance.newRecruitUi.identity, null);
});

test("CertificationReportSchema rejects conflicting local-agent projections and raw New Recruit UI metadata", () => {
  const conflicting = structuredClone(reportFixture());
  conflicting.provenance.localAgent.buildId =
    "different-agent-build";
  assert.throws(() =>
    CertificationReportSchema.parse(conflicting),
  );

  const rawUiMetadata = structuredClone(reportFixture());
  rawUiMetadata.provenance.newRecruitUi.identity =
    "https://www.newrecruit.eu/assets/app.js";
  assert.throws(() =>
    CertificationReportSchema.parse(rawUiMetadata),
  );
});

test("verified resume report loader returns the parsed report and exact bytes", async () => {
  await temporaryDirectory(async (directory) => {
    const fixture = await writeResumeFixture({ directory });
    const loaded = await loadVerifiedCertificationResumeReport(
      loaderInput(fixture.reportPath),
    );
    assert.deepEqual(loaded.report, reportFixture());
    assert.deepEqual(
      [...loaded.reportContent],
      [...fixture.content],
    );
    assert.equal(loaded.reportSha256, sha256(fixture.content));
    assert.equal(loaded.reportPath, fixture.reportPath);
    assert.equal(
      loaded.checksumPath,
      `${fixture.reportPath}.sha256`,
    );
  });
});

test("verified resume report loader narrowly migrates the legacy internal startedMs field", async () => {
  await temporaryDirectory(async (directory) => {
    const legacy = structuredClone(reportFixture()) as unknown as {
      cases: Array<Record<string, unknown>>;
    };
    for (const [index, result] of legacy.cases.entries()) {
      result.startedMs = 1_785_393_692_260 + index;
    }
    const fixture = await writeResumeFixture({
      directory,
      value: legacy,
    });
    const loaded = await loadVerifiedCertificationResumeReport(
      loaderInput(fixture.reportPath),
    );
    assert.ok(
      loaded.report.cases.every(
        (result) => !("startedMs" in result),
      ),
    );
    assert.deepEqual(
      [...loaded.reportContent],
      [...fixture.content],
      "the exact hash-verified legacy bytes remain available for attempt history",
    );
  });
});

test("verified resume loader preserves legacy bytes while defaulting new provenance fields", async () => {
  await temporaryDirectory(async (directory) => {
    const legacy = structuredClone(reportFixture()) as unknown as {
      provenance: {
        localAgent: Record<string, unknown>;
        newRecruitUi?: unknown;
      };
    };
    delete legacy.provenance.localAgent.runtime;
    delete legacy.provenance.newRecruitUi;
    const fixture = await writeResumeFixture({
      directory,
      value: legacy,
    });
    const loaded = await loadVerifiedCertificationResumeReport(
      loaderInput(fixture.reportPath),
    );
    assert.equal(
      loaded.report.provenance.localAgent.runtime,
      null,
    );
    assert.equal(
      loaded.report.provenance.newRecruitUi.identity,
      null,
    );
    assert.deepEqual(
      [...loaded.reportContent],
      [...fixture.content],
    );
  });
});

test("verified resume report loader rejects a one-byte report tamper before parsing", async () => {
  await temporaryDirectory(async (directory) => {
    const fixture = await writeResumeFixture({ directory });
    const tampered = Uint8Array.from(fixture.content);
    tampered[Math.floor(tampered.length / 2)] ^= 1;
    await writeFile(fixture.reportPath, tampered);
    await assertResumeCode(
      () =>
        loadVerifiedCertificationResumeReport(
          loaderInput(fixture.reportPath),
        ),
      "CERTIFICATION_RESUME_REPORT_HASH_MISMATCH",
    );
  });
});

test("verified resume report loader rejects missing and malformed detached checksums", async (context) => {
  await context.test("missing checksum", async () => {
    await temporaryDirectory(async (directory) => {
      const fixture = await writeResumeFixture({
        directory,
        checksum: null,
      });
      await assertResumeCode(
        () =>
          loadVerifiedCertificationResumeReport(
            loaderInput(fixture.reportPath),
          ),
        "CERTIFICATION_RESUME_CHECKSUM_MISSING",
      );
    });
  });
  await context.test("malformed checksum", async () => {
    await temporaryDirectory(async (directory) => {
      const fixture = await writeResumeFixture({
        directory,
        checksum: "not-a-checksum\n",
      });
      await assertResumeCode(
        () =>
          loadVerifiedCertificationResumeReport(
            loaderInput(fixture.reportPath),
          ),
        "CERTIFICATION_RESUME_CHECKSUM_MALFORMED",
      );
    });
  });
  await context.test("checksum basename mismatch", async () => {
    await temporaryDirectory(async (directory) => {
      const content = reportBytes(reportFixture());
      const fixture = await writeResumeFixture({
        directory,
        content,
        checksum: `${sha256(content)}  other-report.json\n`,
      });
      await assertResumeCode(
        () =>
          loadVerifiedCertificationResumeReport(
            loaderInput(fixture.reportPath),
          ),
        "CERTIFICATION_RESUME_CHECKSUM_BASENAME_MISMATCH",
      );
    });
  });
});

test("verified resume report loader rejects a hash-valid malformed report", async () => {
  await temporaryDirectory(async (directory) => {
    const malformed = {
      ...reportFixture(),
      provenance: {
        ...reportFixture().provenance,
        unexpected: true,
      },
    };
    const fixture = await writeResumeFixture({
      directory,
      value: malformed,
    });
    await assertResumeCode(
      () =>
        loadVerifiedCertificationResumeReport(
          loaderInput(fixture.reportPath),
        ),
      "CERTIFICATION_RESUME_REPORT_INVALID",
    );
  });
});

test("verified resume report loader requires the exact requested selection", async (context) => {
  await temporaryDirectory(async (directory) => {
    const fixture = await writeResumeFixture({ directory });
    const expected = reportFixture().selection;
    const mismatches: Array<{
      name: string;
      selection: CertificationReport["selection"];
      code: string;
    }> = [
      {
        name: "requested faction",
        selection: {
          ...expected,
          requestedFaction: "aeldari",
        },
        code: "CERTIFICATION_RESUME_REQUESTED_FACTION_MISMATCH",
      },
      {
        name: "shard",
        selection: {
          ...expected,
          shard: { index: 2, total: 4 },
        },
        code: "CERTIFICATION_RESUME_SHARD_MISMATCH",
      },
      {
        name: "changed-only",
        selection: {
          ...expected,
          changedOnly: true,
        },
        code: "CERTIFICATION_RESUME_CHANGED_ONLY_MISMATCH",
      },
      {
        name: "selected faction IDs and order",
        selection: {
          ...expected,
          selectedFactionIds: ["orks", "death-guard"],
        },
        code: "CERTIFICATION_RESUME_SELECTED_FACTIONS_MISMATCH",
      },
    ];
    for (const mismatch of mismatches) {
      await context.test(mismatch.name, async () => {
        await assertResumeCode(
          () =>
            loadVerifiedCertificationResumeReport(
              loaderInput(fixture.reportPath, {
                expectedSelection: mismatch.selection,
              }),
            ),
          mismatch.code,
        );
      });
    }
  });
});

test("verified resume report loader requires exact tier and manifest hash", async (context) => {
  await temporaryDirectory(async (directory) => {
    const fixture = await writeResumeFixture({ directory });
    await context.test("tier", async () => {
      await assertResumeCode(
        () =>
          loadVerifiedCertificationResumeReport(
            loaderInput(fixture.reportPath, {
              expectedTier: "deterministic",
            }),
          ),
        "CERTIFICATION_RESUME_TIER_MISMATCH",
      );
    });
    await context.test("manifest hash", async () => {
      await assertResumeCode(
        () =>
          loadVerifiedCertificationResumeReport(
            loaderInput(fixture.reportPath, {
              expectedManifestSha256: "9".repeat(64),
            }),
          ),
        "CERTIFICATION_RESUME_MANIFEST_MISMATCH",
      );
    });
  });
});
