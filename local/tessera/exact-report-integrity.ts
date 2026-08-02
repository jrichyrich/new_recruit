import crypto from "node:crypto";
import path from "node:path";

import type { TesseraMatchupReport } from "../../lib/rosterpilot";

export type ExactMatchupReportReceipt = {
  schemaVersion: 1;
  kind: "tessera-exact-matchup-report-receipt";
  reportFilename: string;
  reportSha256: string;
  evidenceSha256: string;
  runId: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function digest(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Rebuilds a canonical digest from the evidence itself. Raw browser matrix
 * hashes are retained as provenance, but they are never treated as proof that
 * the report's normalized cells were left untouched.
 */
export function exactReportEvidenceSha256(
  report: TesseraMatchupReport,
): string {
  const evidence = {
    schemaVersion: report.schemaVersion,
    runId: report.runId,
    status: report.status,
    source: report.source,
    configuration: report.configuration,
    scenarioContract: report.scenarioContract ?? null,
    scenarioContractSha256:
      report.scenarioContractSha256 ?? null,
    profilePolicyHash: report.profilePolicyHash ?? null,
    tesseraUiIdentity: report.tesseraUiIdentity ?? null,
    pinnedData: report.pinnedData,
    comparisonClass: report.comparisonClass,
    pointsComparisons: report.pointsComparisons,
    player: {
      fingerprint: report.player.fingerprint,
      sourceRoszSha256: report.player.sourceRoszSha256,
      enrichedRoszSha256: report.player.enrichedRoszSha256,
      simulationInput: report.player.simulationInput,
      summary: report.player.summary,
      units: report.player.units,
    },
    opponents: report.opponents.map((opponent) => ({
      kind: opponent.kind,
      archetype: opponent.archetype,
      rosterName: opponent.rosterName,
      fingerprint: opponent.fingerprint,
      sourceRoszSha256: opponent.sourceRoszSha256,
      enrichedRoszSha256: opponent.enrichedRoszSha256,
      simulationInput: opponent.simulationInput,
      summary: opponent.summary,
      units: opponent.units,
      catalogueProvenance: opponent.catalogueProvenance,
    })),
    simulation: {
      requested: report.simulation.requested,
      executionMode: report.simulation.executionMode,
      status: report.simulation.status,
      requestedBackend: report.simulation.requestedBackend,
      selectedBackend: report.simulation.selectedBackend,
      providerIdentity: report.simulation.providerIdentity,
      providerEvidence: report.simulation.providerEvidence ?? null,
      providerEvidenceCaptures:
        report.simulation.providerEvidenceCaptures ?? null,
      fallback: report.simulation.fallback,
      engine: report.simulation.engine,
      settings: report.simulation.settings,
      legacyProjection: report.simulation.legacyProjection,
      matrices: report.simulation.matrices,
      scenarios: report.simulation.scenarios,
    },
    providerCompatibility:
      report.providerCompatibility ?? null,
    providerCompatibilityEnvelopes:
      report.providerCompatibilityEnvelopes ?? [],
  };
  return digest(JSON.stringify(canonicalize(evidence)));
}

export function exactReportReceiptPath(reportPath: string): string {
  const extension = path.extname(reportPath);
  const stem = extension
    ? reportPath.slice(0, -extension.length)
    : reportPath;
  return `${stem}.receipt.json`;
}

export function createExactReportReceipt(
  reportFilename: string,
  serializedReport: string,
  report: TesseraMatchupReport,
): ExactMatchupReportReceipt {
  return {
    schemaVersion: 1,
    kind: "tessera-exact-matchup-report-receipt",
    reportFilename: path.basename(reportFilename),
    reportSha256: digest(serializedReport),
    evidenceSha256: exactReportEvidenceSha256(report),
    runId: report.runId,
  };
}

export function verifyExactReportReceipt(
  reportPath: string,
  serializedReport: string,
  report: TesseraMatchupReport,
  candidate: unknown,
): string | null {
  if (!candidate || typeof candidate !== "object") {
    return "The exact baseline report receipt is missing or malformed.";
  }
  const receipt = candidate as Partial<ExactMatchupReportReceipt>;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "tessera-exact-matchup-report-receipt" ||
    receipt.reportFilename !== path.basename(reportPath) ||
    receipt.runId !== report.runId ||
    !receipt.reportSha256 ||
    !/^[0-9a-f]{64}$/.test(receipt.reportSha256) ||
    !receipt.evidenceSha256 ||
    !/^[0-9a-f]{64}$/.test(receipt.evidenceSha256)
  ) {
    return "The exact baseline report receipt does not identify this report.";
  }
  if (receipt.reportSha256 !== digest(serializedReport)) {
    return "The exact baseline report bytes changed after the receipt was recorded.";
  }
  if (receipt.evidenceSha256 !== exactReportEvidenceSha256(report)) {
    return "The baseline scenario or matrix evidence changed after the receipt was recorded.";
  }
  return null;
}
