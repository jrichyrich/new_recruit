import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  certificationReports,
  renderCertificationTrend,
} from "../scripts/certification-trend";
import type {
  CertificationCaseResult,
  CertificationReport,
} from "../lib/rosterpilot/certification";
import type { ConnectorEvent } from "../lib/rosterpilot";

async function writeVerifiedReport(
  filename: string,
  report: CertificationReport,
): Promise<void> {
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(filename, content);
  await writeFile(
    `${filename}.sha256`,
    `${crypto.createHash("sha256").update(content).digest("hex")}  ${path.basename(filename)}\n`,
  );
}

function certificationCase(input: {
  caseId?: string;
  factionId: string;
  workflow: CertificationCaseResult["workflow"];
  status: CertificationCaseResult["status"];
  completedAt: string;
  code?: string | null;
  evidence?: Record<string, unknown>;
}): CertificationCaseResult {
  return {
    caseId:
      input.caseId ??
      `${input.factionId}:${input.workflow}:${input.completedAt}`,
    factionId: input.factionId,
    workflow: input.workflow,
    stage: "fixture",
    status: input.status,
    code: input.code ?? null,
    message: "Fixture certification result.",
    retryable: false,
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    durationMs: 1,
    evidence: input.evidence ?? {},
    artifacts: [],
    connectorEvents: [],
  };
}

function connectorEvent(input: {
  eventId: string;
  recordedAt: string;
  origin: ConnectorEvent["origin"];
  outcome: ConnectorEvent["outcome"];
  remoteId?: string;
  provider?: ConnectorEvent["provider"];
}): ConnectorEvent {
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    recordedAt: input.recordedAt,
    provider: input.provider ?? "new-recruit",
    action: "prepare",
    origin: input.origin,
    outcome: input.outcome,
    remoteId: input.remoteId ?? null,
    contentSha256: "a".repeat(64),
  };
}

function certificationReport(input: {
  runId: string;
  tier: CertificationReport["tier"];
  generatedAt: string;
  factionIds: string[];
  cases: CertificationCaseResult[];
  events?: ConnectorEvent[];
  blockingConflicts: number;
  uiIdentity?: string | null;
  newRecruitUiIdentity?: string | null;
  runtimeStale?: boolean;
  localAgentStale?: boolean;
}): CertificationReport {
  return {
    schemaVersion: 1,
    reportKind: "rosterpilot-certification",
    runId: input.runId,
    tier: input.tier,
    generatedAt: input.generatedAt,
    ok: !input.cases.some((result) => result.status === "fail"),
    status: input.cases.some((result) => result.status === "fail")
      ? "fail"
      : "pass",
    manifestSha256: "b".repeat(64),
    resumedFrom: null,
    selection: {
      requestedFaction: null,
      shard: null,
      changedOnly: false,
      selectedFactionIds: input.factionIds,
    },
    provenance: {
      runtime: {
        rosterPilotVersion: "1.0.0",
        rulesPackageVersion: "fixture",
        stressGeneratorVersion: "fixture",
        processStartedAt: input.generatedAt,
        gitHead: "c".repeat(40),
        sourceFingerprintAtStart: "d".repeat(64),
        sourceFingerprintNow: "d".repeat(64),
        buildId: "fixture-build",
        stale: input.runtimeStale ?? false,
      },
      localAgent: {
        version: "1.0.0",
        protocolVersion: 1,
        runtime: {
          rosterPilotVersion: "1.0.0",
          rulesPackageVersion: "fixture",
          stressGeneratorVersion: "fixture",
          processStartedAt: input.generatedAt,
          gitHead: "f".repeat(40),
          sourceFingerprintAtStart: "1".repeat(64),
          sourceFingerprintNow: "1".repeat(64),
          buildId: "fixture-agent",
          stale: input.localAgentStale ?? false,
        },
        buildId: "fixture-agent",
        stale: input.localAgentStale ?? false,
      },
      newRecruitUi: {
        identity: input.newRecruitUiIdentity ?? null,
      },
      tesseraUi: {
        identity: input.uiIdentity ?? null,
      },
      profilePolicy: {
        source: "none",
        requestedBasename: null,
        artifactPath: null,
        sourceSha256: null,
        canonicalSha256: null,
      },
      dataPin: {
        releaseId: "fixture-release",
        rulesPackageVersion: "fixture-rules",
        newRecruitCommit: "e".repeat(40),
      },
      cachedLiveUpdateCheck: null,
    },
    baselines: {
      buildableFactions: 35,
      exportCapableFactions: 32,
      blockingConflicts: 2_155,
      uniqueBlockingConflicts: 100,
      actualBuildableFactions: 35,
      actualExportCapableFactions: 32,
      actualBlockingConflicts: input.blockingConflicts,
      actualUniqueBlockingConflicts: 100,
    },
    coverage: {
      factions: {
        intended: input.factionIds.length,
        exercised: input.factionIds.length,
        passed: input.factionIds.length,
        failed: 0,
        unsupported: 0,
        pendingExpertReview: 0,
      },
      workflows: {
        oracle: {
          pass: 0,
          fail: 0,
          unsupported: 0,
          degraded: 0,
          skipped: 0,
        },
        "roster-correctness": {
          pass: 0,
          fail: 0,
          unsupported: 0,
          degraded: 0,
          skipped: 0,
        },
        "new-recruit-export": {
          pass: 0,
          fail: 0,
          unsupported: 0,
          degraded: 0,
          skipped: 0,
        },
        "new-recruit-delivery": {
          pass: 0,
          fail: 0,
          unsupported: 0,
          degraded: 0,
          skipped: 0,
        },
        "tessera-preparation": {
          pass: 0,
          fail: 0,
          unsupported: 0,
          degraded: 0,
          skipped: 0,
        },
        "tessera-simulation": {
          pass: 0,
          fail: 0,
          unsupported: 0,
          degraded: 0,
          skipped: 0,
        },
        "browser-fixture": {
          pass: 0,
          fail: 0,
          unsupported: 0,
          degraded: 0,
          skipped: 0,
        },
      },
      browserFixtures: {
        intended: 0,
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
    cases: input.cases,
    connectorEvents: input.events ?? [],
    artifacts: [],
    limitations: [],
  };
}

function trendFixtureReports(): CertificationReport[] {
  const firstMutation = connectorEvent({
    eventId: "mutation-1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    origin: "new-remote",
    outcome: "verified",
    remoteId: "list-1",
  });
  const duplicateMutation = connectorEvent({
    eventId: "mutation-2",
    recordedAt: "2026-01-01T00:01:00.000Z",
    origin: "new-remote",
    outcome: "verified",
    remoteId: "list-1",
  });
  const cacheReuse = connectorEvent({
    eventId: "cache-1",
    recordedAt: "2026-01-01T00:02:00.000Z",
    origin: "persistent-cache",
    outcome: "reused",
  });
  const liveSuccessAt = "2026-01-01T01:00:00.000Z";
  const first = certificationReport({
    runId: "live-one",
    tier: "live",
    generatedAt: "2026-01-01T02:00:00.000Z",
    factionIds: ["death-guard"],
    blockingConflicts: 2_155,
    uiIdentity: "tessera-ui-a",
    newRecruitUiIdentity: "1".repeat(64),
    cases: [
      certificationCase({
        caseId: "death-guard:deterministic-build",
        factionId: "death-guard",
        workflow: "roster-correctness",
        status: "pass",
        completedAt: liveSuccessAt,
      }),
      certificationCase({
        caseId: "death-guard:deterministic-export",
        factionId: "death-guard",
        workflow: "new-recruit-export",
        status: "pass",
        completedAt: liveSuccessAt,
      }),
      certificationCase({
        caseId: "death-guard:live-new-recruit",
        factionId: "death-guard",
        workflow: "new-recruit-delivery",
        status: "pass",
        completedAt: liveSuccessAt,
      }),
      certificationCase({
        caseId: "death-guard:portfolio:core-3",
        factionId: "death-guard",
        workflow: "tessera-preparation",
        status: "pass",
        completedAt: liveSuccessAt,
      }),
      certificationCase({
        caseId: "death-guard:live-tessera",
        factionId: "death-guard",
        workflow: "tessera-simulation",
        status: "pass",
        completedAt: liveSuccessAt,
        evidence: {
          scenarioAttempts: [
            {
              attempt: 1,
              status: "failed",
              code: "TESSERA_STALE_MATRIX",
            },
            {
              attempt: 2,
              status: "success",
              code: null,
            },
          ],
          priorAttempts: [
            {
              code: "TESSERA_BROWSER_TIMEOUT",
            },
          ],
        },
      }),
    ],
    events: [
      firstMutation,
      duplicateMutation,
      cacheReuse,
      cacheReuse,
    ],
  });
  const uncertain = connectorEvent({
    eventId: "uncertain-1",
    recordedAt: "2026-01-03T00:00:00.000Z",
    origin: "new-remote",
    outcome: "uncertain",
    remoteId: "list-uncertain",
  });
  const second = certificationReport({
    runId: "live-two",
    tier: "live",
    generatedAt: "2026-01-03T02:00:00.000Z",
    factionIds: ["aeldari"],
    blockingConflicts: 2_152,
    uiIdentity: "tessera-ui-b",
    newRecruitUiIdentity: "2".repeat(64),
    runtimeStale: true,
    localAgentStale: true,
    cases: [
      certificationCase({
        caseId: "aeldari:live-tessera",
        factionId: "aeldari",
        workflow: "tessera-simulation",
        status: "fail",
        code: "TESSERA_LIST_SELECTION_MISMATCH",
        completedAt: "2026-01-03T01:00:00.000Z",
      }),
      certificationCase({
        caseId: "aeldari:live-new-recruit",
        factionId: "aeldari",
        workflow: "new-recruit-delivery",
        status: "fail",
        code: "RUNTIME_RESTART_REQUIRED",
        completedAt: "2026-01-03T01:01:00.000Z",
      }),
    ],
    events: [uncertain],
  });
  const deterministic = certificationReport({
    runId: "deterministic-later",
    tier: "deterministic",
    generatedAt: "2026-01-10T00:00:00.000Z",
    factionIds: ["death-guard"],
    blockingConflicts: 2_150,
    cases: [
      certificationCase({
        factionId: "death-guard",
        workflow: "roster-correctness",
        status: "pass",
        completedAt: "2026-01-10T00:00:00.000Z",
      }),
    ],
  });
  return [first, second, deterministic];
}

test("trend keeps successful live recency independent from later deterministic reports and exposes reliability signals", () => {
  const rendered = renderCertificationTrend(
    trendFixtureReports(),
    new Date("2026-01-11T01:00:00.000Z"),
  );
  const { summary } = rendered;

  assert.equal(
    summary.latestByFaction.get("death-guard")?.tier,
    "deterministic",
  );
  assert.equal(
    summary.lastSuccessfulLiveByFaction.get("death-guard"),
    "2026-01-01T01:00:00.000Z",
  );
  assert.deepEqual(
    summary.latestLiveByFaction.get("death-guard")?.capabilities,
    {
      "roster-correctness": "pass",
      "new-recruit-export": "pass",
      "new-recruit-delivery": "pass",
      "tessera-preparation": "pass",
      "tessera-simulation": "pass",
    },
  );
  assert.equal(
    summary.lastSuccessfulLiveByFaction.has("aeldari"),
    false,
  );
  assert.equal(summary.latestBlockingConflicts, 2_150);
  assert.equal(summary.mappingConflictDeltaFromFirst, -5);
  assert.equal(summary.mappingConflictDeltaFromPrevious, -2);
  assert.equal(summary.remoteMutations, 3);
  assert.equal(summary.newRecruitMutations, 3);
  assert.equal(summary.persistentCacheReuses, 1);
  assert.equal(summary.uncertainOutcomes, 1);
  assert.equal(summary.duplicateRemoteMutations, 1);
  assert.equal(summary.duplicateEventRecords, 1);
  assert.equal(summary.staleRuntimeReports, 1);
  assert.equal(summary.staleLocalAgentReports, 1);
  assert.equal(summary.staleRuntimeFailureCases, 1);
  assert.equal(
    summary.applicableCases,
    summary.passingCases +
      summary.failedCases +
      summary.degradedCases +
      summary.unsupportedCases,
  );
  assert.equal(summary.newRecruitUiIdentityChanges, 1);
  assert.equal(summary.newRecruitUiIdentitiesObserved, 2);
  assert.equal(
    summary.latestNewRecruitUiIdentity,
    "2".repeat(64),
  );
  assert.equal(summary.tesseraUiIdentityChanges, 1);
  assert.equal(summary.tesseraUiIdentitiesObserved, 2);
  assert.equal(summary.observableAttemptCount, 3);
  assert.equal(summary.retryOrPriorAttemptCount, 2);
  assert.equal(summary.scenarioRetryAttemptCount, 1);
  assert.equal(summary.priorAttemptCount, 1);
  assert.deepEqual(
    summary.browserFailures.map((failure) => failure.code).sort(),
    [
      "TESSERA_BROWSER_TIMEOUT",
      "TESSERA_LIST_SELECTION_MISMATCH",
      "TESSERA_STALE_MATRIX",
    ],
  );

  assert.match(
    rendered.markdown,
    /death-guard \| pass \| deterministic .*2026-01-01T01:00:00\.000Z \| 10d 0h \| pass/,
  );
  assert.match(
    rendered.markdown,
    /aeldari .* never \| never \| fail/,
  );
  assert.match(
    rendered.markdown,
    /Mapping-conflict delta from first input: -5/,
  );
  assert.match(
    rendered.markdown,
    /Retry\/prior-attempt rate: 66\.7% \(2\/3/,
  );
  assert.match(
    rendered.markdown,
    /Five-capability state[\s\S]*Roster correctness[\s\S]*Trusted Tessera simulation/,
  );

  const resumedWithPreservedCase = certificationReport({
    runId: "live-resume-with-old-case",
    tier: "live",
    generatedAt: "2026-01-12T00:00:00.000Z",
    factionIds: ["death-guard"],
    blockingConflicts: 2_150,
    uiIdentity: "tessera-ui-b",
    cases: [
      certificationCase({
        caseId: "death-guard:live-new-recruit",
        factionId: "death-guard",
        workflow: "new-recruit-delivery",
        status: "pass",
        completedAt: "2025-12-31T00:00:00.000Z",
      }),
    ],
  });
  const resumedTrend = renderCertificationTrend(
    [...trendFixtureReports(), resumedWithPreservedCase],
    new Date("2026-01-12T00:00:00.000Z"),
  );
  assert.equal(
    resumedTrend.summary.lastSuccessfulLiveByFaction.get(
      "death-guard",
    ),
    "2026-01-01T01:00:00.000Z",
  );
  assert.equal(
    resumedTrend.summary.latestLiveByFaction.get(
      "death-guard",
    )?.checkedAt,
    "2026-01-01T01:00:00.000Z",
  );
});

test("mixed pass and unsupported live capabilities remain a boundary, never a successful check", () => {
  const completedAt = "2026-02-01T00:00:00.000Z";
  const report = certificationReport({
    runId: "mixed-capability-boundary",
    tier: "live",
    generatedAt: completedAt,
    factionIds: ["death-guard"],
    blockingConflicts: 2_150,
    cases: [
      certificationCase({
        factionId: "death-guard",
        workflow: "roster-correctness",
        status: "pass",
        completedAt,
      }),
      certificationCase({
        factionId: "death-guard",
        workflow: "new-recruit-export",
        status: "pass",
        completedAt,
      }),
      certificationCase({
        caseId: "death-guard:live-capability-boundary",
        factionId: "death-guard",
        workflow: "new-recruit-delivery",
        status: "unsupported",
        completedAt,
      }),
      certificationCase({
        factionId: "death-guard",
        workflow: "tessera-preparation",
        status: "pass",
        completedAt,
      }),
      certificationCase({
        caseId: "death-guard:live-tessera",
        factionId: "death-guard",
        workflow: "tessera-simulation",
        status: "unsupported",
        completedAt,
      }),
    ],
  });

  const { summary, markdown } = renderCertificationTrend(
    [report],
    new Date(completedAt),
  );
  assert.equal(
    summary.latestByFaction.get("death-guard")?.status,
    "capability-boundary",
  );
  assert.equal(
    summary.latestLiveByFaction.get("death-guard")?.status,
    "capability-boundary",
  );
  assert.equal(
    summary.lastSuccessfulLiveByFaction.has("death-guard"),
    false,
  );
  assert.equal(summary.unsupportedCases, 2);
  assert.match(
    markdown,
    /Case pass rate: 60\.0% \(3\/5 non-skipped outcomes\)/,
  );
  assert.match(
    markdown,
    /death-guard \| pass \| pass \| unsupported \| pass \| unsupported/,
  );
});

test("trend report discovery is recursive, ordered, schema-strict, and checksum-verified", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-trend-"),
  );
  try {
    const reports = trendFixtureReports();
    await mkdir(path.join(directory, "nested"), {
      recursive: true,
    });
    await writeVerifiedReport(
      path.join(
        directory,
        "nested",
        "certification-report-later.json",
      ),
      reports[2],
    );
    await writeVerifiedReport(
      path.join(
        directory,
        "certification-report-earlier.json",
      ),
      reports[0],
    );
    const loaded = await certificationReports(directory);
    assert.deepEqual(
      loaded.map((report) => report.runId),
      ["live-one", "deterministic-later"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trend ingestion rejects missing checksums, hash drift, and schema-invalid reports", async (context) => {
  const valid = trendFixtureReports()[0];
  await context.test("missing checksum", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-trend-missing-"),
    );
    try {
      await writeFile(
        path.join(directory, "certification-report-missing.json"),
        `${JSON.stringify(valid, null, 2)}\n`,
      );
      await assert.rejects(
        certificationReports(directory),
        /detached checksum is missing or unreadable/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await context.test("hash drift", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-trend-hash-"),
    );
    try {
      const filename = path.join(
        directory,
        "certification-report-drift.json",
      );
      await writeVerifiedReport(filename, valid);
      await writeFile(filename, `${JSON.stringify(valid)}\n`);
      await assert.rejects(
        certificationReports(directory),
        /bytes do not match the detached checksum/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await context.test("schema-invalid", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-trend-schema-"),
    );
    try {
      const filename = path.join(
        directory,
        "certification-report-schema.json",
      );
      await writeVerifiedReport(filename, {
        ...valid,
        unexpectedField: true,
      } as CertificationReport);
      await assert.rejects(
        certificationReports(directory),
        /schema validation failed.*Unrecognized key/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("weekly workflows run the sharded full ordered matrix and retain safe trend inputs", async () => {
  const liveWorkflow = await readFile(
    path.resolve(".github/workflows/certification-live.yml"),
    "utf8",
  );
  assert.match(
    liveWorkflow,
    /weekly-rotation:[\s\S]*?args=\(--tier live --shard "\$\{\{ matrix\.shard \}\}" --opponent-matrix/,
  );
  assert.match(liveWorkflow, /weekly-trend:/);
  assert.match(
    liveWorkflow,
    /certification-report-\*\.json/,
  );
  assert.match(liveWorkflow, /retention-days:\s*90/);
});
