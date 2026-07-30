import type {
  ResultEnvelope,
  RosterIssue,
  TesseraStressPreparationFailureReport,
  TesseraStressRevisionReport,
  TesseraStressRunReport,
  TesseraStressTestReport,
} from "./types";

export type StressResponseDetail = "compact" | "full";

function compactWarnings(warnings: RosterIssue[]) {
  return {
    warnings: warnings.slice(0, 20),
    warningCount: warnings.length,
  };
}

function artifactPaths(
  report: TesseraStressRunReport | TesseraStressRevisionReport,
  outputDirectory?: string,
) {
  return report.artifacts.map((artifact) => ({
    format: artifact.format,
    path:
      outputDirectory &&
      !/^(?:[A-Za-z]:[\\/]|\/)/.test(artifact.written)
        ? `${outputDirectory.replace(/[\\/]+$/, "")}/${artifact.written.replace(/^[\\/]+/, "")}`
        : artifact.written,
    ...(
      "sha256" in artifact
        ? { sha256: artifact.sha256 }
        : {}
    ),
  }));
}

function compactPreparationFailure(
  report: TesseraStressPreparationFailureReport,
  outputDirectory?: string,
) {
  return {
    schemaVersion: report.schemaVersion,
    reportKind: report.reportKind,
    runId: report.runId,
    status: report.status,
    statusExplanation: report.statusExplanation,
    player: {
      prepared: report.verifiedPreparedPlayer !== null,
      name:
        report.verifiedPreparedPlayer?.rosterName ?? null,
      points:
        report.verifiedPreparedPlayer?.summary.totalPoints ??
        null,
    },
    opponent: {
      factionId: report.opponentFactionId,
      factionName: report.portfolio.factionName,
      pointsLimit: report.portfolio.pointsLimit,
      preparedTemplates:
        report.verifiedPreparedOpponents.map(
          (entry) => entry.templateId,
        ),
    },
    suite: report.suite,
    portfolioCoverage: report.portfolio.coverage,
    integrity: report.integrity,
    failures: report.failures,
    recovery: report.recovery,
    preparation: report.preparation,
    simulation: report.simulation,
    currentPartialPreparedReceipt:
      report.currentPartialPreparedReceipt
        ? {
            side:
              report.currentPartialPreparedReceipt.side,
            templateId:
              report.currentPartialPreparedReceipt.templateId,
            reusable: false,
            failureCodes:
              report.currentPartialPreparedReceipt.failureCodes,
          }
        : null,
    artifactPaths: artifactPaths(report, outputDirectory),
  };
}

function compactStressReport(
  report: TesseraStressTestReport,
  outputDirectory?: string,
) {
  return {
    schemaVersion: report.schemaVersion,
    reportKind: report.reportKind,
    runId: report.runId,
    status: report.status,
    statusExplanation: report.statusExplanation,
    player: {
      name: report.player.rosterName,
      factionId: report.player.factionId,
      factionName: report.player.summary.factionName,
      points: report.player.summary.totalPoints,
    },
    opponent: {
      factionId: report.opponentFactionId,
      factionName: report.portfolio.factionName,
      pointsLimit: report.portfolio.pointsLimit,
    },
    suite: report.suite,
    portfolioCoverage: report.portfolio.coverage,
    integrity: report.integrity,
    failures: report.failures ?? [],
    recovery: report.recovery,
    preparation: report.preparation ?? null,
    simulation: report.simulation ?? null,
    representatives: report.representatives,
    robustness:
      report.robustness === null
        ? null
        : {
            offense: report.robustness.offense,
            exposure: report.robustness.exposure,
            margin: report.robustness.margin,
            phaseDependence:
              report.robustness.phaseDependence,
            confidence: report.robustness.confidence,
            coverageCompleteness:
              report.robustness.coverageCompleteness,
            evidenceConfidence:
              report.robustness.evidenceConfidence,
            confidentSamples:
              report.robustness.samples.filter(
                (sample) => sample.status === "confident",
              ).length,
            totalSamples: report.robustness.samples.length,
          },
    freshness:
      report.pinnedData?.cachedLiveUpdateCheck ?? null,
    artifactPaths: artifactPaths(report, outputDirectory),
  };
}

export function compactStressResult(
  result: ResultEnvelope<TesseraStressRunReport>,
  outputDirectory?: string,
): Record<string, unknown> {
  const warningSummary = compactWarnings(result.warnings);
  if (!result.data) {
    return {
      ok: result.ok,
      data: null,
      violations: result.violations,
      ...warningSummary,
    };
  }
  return {
    ok: result.ok,
    data:
      result.data.reportKind ===
      "tessera-stress-preparation-failure"
        ? compactPreparationFailure(
            result.data,
            outputDirectory,
          )
        : compactStressReport(
            result.data,
            outputDirectory,
          ),
    violations: result.violations,
    ...warningSummary,
  };
}

export function compactStressRevisionResult(
  result: ResultEnvelope<TesseraStressRevisionReport>,
  outputDirectory?: string,
): Record<string, unknown> {
  const warningSummary = compactWarnings(result.warnings);
  if (!result.data) {
    return {
      ok: result.ok,
      data: null,
      violations: result.violations,
      ...warningSummary,
    };
  }
  const report = result.data;
  return {
    ok: result.ok,
    data: {
      schemaVersion: report.schemaVersion,
      reportKind: report.reportKind,
      runId: report.runId,
      status: report.summary.conclusion,
      summary: report.summary,
      player: {
        name: report.revised.player.rosterName,
        factionId: report.revised.player.factionId,
        factionName:
          report.revised.player.summary.factionName,
        points: report.revised.player.summary.totalPoints,
      },
      opponent: {
        factionId: report.revised.opponentFactionId,
        factionName: report.revised.portfolio.factionName,
        pointsLimit: report.revised.portfolio.pointsLimit,
      },
      portfolioCoverage:
        report.revised.portfolio.coverage,
      integrity: {
        baseline: report.baseline.integrity,
        revised: report.revised.integrity,
      },
      failures: {
        baseline: report.baseline.failures ?? [],
        revised: report.revised.failures ?? [],
      },
      recovery: report.revised.recovery,
      sampleDeltas: report.sampleDeltas,
      missionReadinessGuardrail:
        report.missionReadinessGuardrail,
      artifactPaths: artifactPaths(report, outputDirectory),
    },
    violations: result.violations,
    ...warningSummary,
  };
}
