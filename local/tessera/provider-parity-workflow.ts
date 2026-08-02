import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import type {
  ExportArtifact,
  TesseraMatchupReport,
  TesseraSimulationProviderIdentity,
} from "../../lib/rosterpilot";
import { writeExportArtifacts } from "../../lib/rosterpilot/io";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  type ExactMatchupReportReceipt,
  exactReportReceiptPath,
  verifyExactReportReceipt,
} from "./exact-report-integrity";
import {
  compareTesseraProviderParity,
  type TesseraParityProvider,
  type TesseraProviderParityResult,
} from "./provider-parity";
import {
  adaptReportBoundTesseraMatchupReportToProviderParityRun,
  type TesseraProviderParityReportAdapterIssue,
  type TesseraReportBoundProviderParityAdapterResult,
} from "./provider-parity-report-adapter";
import {
  TESSERA_PROVIDER_NEUTRAL_SCENARIO_SETTINGS_VERSION,
} from "./provider-parity-scenario-contract";

export type TesseraProviderParityWorkflowClassification =
  | "parity-pass"
  | "model-drift"
  | "data-or-input-drift"
  | "evidence-incomplete";

export type TesseraProviderParityWorkflowArtifact = {
  schemaVersion: 1;
  kind: "tessera-provider-parity-comparison";
  evidenceKind: "paired-receipt-bound-completed-provider-reports";
  sourceResolution: {
    kind: "reports-root-sha256-run-id";
    reportRootRequired: true;
  };
  generatedAt: string;
  outcome: TesseraProviderParityResult["outcome"] | "ineligible";
  classification: TesseraProviderParityWorkflowClassification;
  sourceReports: Array<{
    provider: TesseraParityProvider;
    reportPath: string;
    receiptPath: string;
    reportSha256: string;
    receiptSha256: string;
    receiptEvidenceSha256: string;
    runId: string;
    executionEvidence: {
      reportSource: TesseraMatchupReport["source"];
      reportStatus: TesseraMatchupReport["status"];
      simulationStatus: NonNullable<
        TesseraMatchupReport["simulation"]["status"]
      > | null;
      engine: TesseraMatchupReport["simulation"]["engine"] | null;
      providerIdentity: TesseraSimulationProviderIdentity;
      providerIdentitySha256: string;
      complete: boolean;
      website: {
        deploymentIdentitySha256: string | null;
        deploymentComplete: boolean;
        importSemanticsSha256: string | null;
        importSemanticsComplete: boolean;
        stateBindingsComplete: boolean;
      } | null;
    };
    providerCompatibilityEnvelopeSha256: string | null;
    rawScenarioContractSha256: string | null;
    normalizedScenarioContractSha256: string | null;
    normalizedInputSha256: string | null;
  }>;
  scenarioNormalization: {
    version: typeof TESSERA_PROVIDER_NEUTRAL_SCENARIO_SETTINGS_VERSION;
    providerOnlySettingsIgnored: ["provider"];
    gameplaySettingsCompared: [
      "targetInCover",
      "charging",
      "withinRapidFireRange",
      "withinMeltaRange",
      "remainedStationary",
      "indirectFire",
    ];
  };
  adaptation: {
    local: { ok: boolean; issues: TesseraProviderParityReportAdapterIssue[] };
    website: { ok: boolean; issues: TesseraProviderParityReportAdapterIssue[] };
  };
  parity: TesseraProviderParityResult | null;
  providerAssessment: {
    localEngine: { strengths: string[]; weaknesses: string[] };
    website: { strengths: string[]; weaknesses: string[] };
  };
  strengths: string[];
  weaknesses: string[];
  nextActions: string[];
  limitations: string[];
  artifacts: Array<{
    format:
      | "provider-parity-json"
      | "provider-parity-html"
      | "provider-parity-sha256";
    written: string;
  }>;
};

export type RunTesseraProviderParityWorkflowOptions = {
  localReportPath: string;
  websiteReportPath: string;
  outputDirectory?: string;
  overwrite?: boolean;
  rootDir?: string;
  allowOutsideRoot?: boolean;
};

export type RunTesseraProviderParityWorkflowResult = {
  ok: boolean;
  data: TesseraProviderParityWorkflowArtifact;
  violations: Array<{ code: string; message: string; severity: "error" }>;
  warnings: Array<{ code: string; message: string; severity: "warn" }>;
};

type VerifiedReport = {
  provider: TesseraParityProvider;
  path: string;
  receiptPath: string;
  serialized: string;
  reportSha256: string;
  receiptSha256: string;
  receiptEvidenceSha256: string;
  providerIdentity: TesseraSimulationProviderIdentity;
  report: TesseraMatchupReport;
};

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function reportShape(value: unknown): value is TesseraMatchupReport {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TesseraMatchupReport>;
  return (
    typeof candidate.runId === "string" &&
    typeof candidate.status === "string" &&
    !!candidate.player &&
    Array.isArray(candidate.opponents) &&
    !!candidate.simulation &&
    Array.isArray(candidate.simulation.scenarios)
  );
}

async function readVerifiedReport(
  reportPath: string,
  expectedProvider: TesseraParityProvider,
): Promise<VerifiedReport> {
  const resolved = path.resolve(reportPath);
  const receiptPath = exactReportReceiptPath(resolved);
  const [serialized, receiptText] = await Promise.all([
    readFile(resolved, "utf8"),
    readFile(receiptPath, "utf8"),
  ]);
  let reportValue: unknown;
  let receiptValue: unknown;
  try {
    reportValue = JSON.parse(serialized);
    receiptValue = JSON.parse(receiptText);
  } catch {
    throw new Error(
      `The ${expectedProvider} report or its exact-report receipt is not valid JSON.`,
    );
  }
  if (!reportShape(reportValue)) {
    throw new Error(
      `The ${expectedProvider} file is not a complete Tessera exact matchup report.`,
    );
  }
  const receiptError = verifyExactReportReceipt(
    resolved,
    serialized,
    reportValue,
    receiptValue,
  );
  if (receiptError) {
    throw new Error(`${expectedProvider} receipt verification failed: ${receiptError}`);
  }
  if (
    reportValue.simulation.selectedBackend !== expectedProvider ||
    reportValue.simulation.providerIdentity?.provider !== expectedProvider
  ) {
    throw new Error(
      `The ${expectedProvider} input report is bound to ${reportValue.simulation.selectedBackend ?? "no concrete provider"}.`,
    );
  }
  const expectedSource =
    expectedProvider === "local-engine"
      ? "tessera-local-engine"
      : "tessera-ui";
  if (reportValue.source !== expectedSource) {
    throw new Error(
      `The ${expectedProvider} input report source is ${reportValue.source}; expected ${expectedSource}.`,
    );
  }
  const receipt = receiptValue as ExactMatchupReportReceipt;
  return {
    provider: expectedProvider,
    path: resolved,
    receiptPath,
    serialized,
    reportSha256: sha256(serialized),
    receiptSha256: sha256(receiptText),
    receiptEvidenceSha256: receipt.evidenceSha256,
    providerIdentity: reportValue.simulation.providerIdentity,
    report: reportValue,
  };
}

function adaptationView(
  result: TesseraReportBoundProviderParityAdapterResult,
) {
  return result.ok
    ? { ok: true, issues: [] }
    : { ok: false, issues: result.issues };
}

export function classifyTesseraProviderParityWorkflow(
  parity: TesseraProviderParityResult | null,
  adaptationsComplete: boolean,
): TesseraProviderParityWorkflowClassification {
  if (!adaptationsComplete || !parity) return "evidence-incomplete";
  if (parity.outcome === "incomplete") return "evidence-incomplete";
  if (parity.outcome === "pass") return "parity-pass";
  if (parity.outcome === "ineligible") return "data-or-input-drift";
  if (
    parity.eligible &&
    parity.issues.some((entry) => entry.category === "policy")
  ) {
    return "model-drift";
  }
  return "data-or-input-drift";
}

function reportCompatibilityEnvelope(report: TesseraMatchupReport) {
  if (report.providerCompatibilityEnvelopes !== undefined) {
    return report.providerCompatibilityEnvelopes.length === 1
      ? report.providerCompatibilityEnvelopes[0]
      : null;
  }
  return report.providerCompatibility ?? null;
}

function executionEvidence(report: VerifiedReport) {
  const compatibility = reportCompatibilityEnvelope(report.report);
  const website = compatibility?.tessera.website ?? null;
  const stateBindings = website?.importSemantics.stateBindings;
  return {
    reportSource: report.report.source,
    reportStatus: report.report.status,
    simulationStatus: report.report.simulation.status ?? null,
    engine: report.report.simulation.engine ?? null,
    providerIdentity: report.providerIdentity,
    providerIdentitySha256: sha256(canonicalJson(report.providerIdentity)),
    complete:
      report.report.status === "complete" &&
      report.report.simulation.status === "complete",
    website: website
      ? {
          deploymentIdentitySha256:
            website.deployment.identitySha256 ?? null,
          deploymentComplete:
            website.deployment.complete &&
            website.deployment.completeness === "complete",
          importSemanticsSha256:
            website.importSemantics.combinedSha256 ?? null,
          importSemanticsComplete:
            website.importSemantics.complete &&
            website.importSemantics.completeness === "complete",
          stateBindingsComplete:
            stateBindings?.player !== null &&
            stateBindings?.player !== undefined &&
            stateBindings.opponent !== null &&
            stateBindings.opponent !== undefined,
        }
      : null,
  };
}

function findings(input: {
  local: TesseraReportBoundProviderParityAdapterResult;
  website: TesseraReportBoundProviderParityAdapterResult;
  parity: TesseraProviderParityResult | null;
}): {
  strengths: string[];
  weaknesses: string[];
  nextActions: string[];
} {
  const strengths = [
    "Both source reports and their exact-report receipts were verified before comparison.",
  ];
  const weaknesses: string[] = [];
  const nextActions: string[] = [];
  if (input.local.ok && input.website.ok) {
    strengths.push(
      "Both providers supplied complete report-bound bundle, roster, provider, scenario, capability, and combat evidence.",
    );
    if (
      input.local.bindings.normalizedScenarioContractSha256 ===
      input.website.bindings.normalizedScenarioContractSha256
    ) {
      strengths.push(
        "The raw provider settings normalize to the same frozen gameplay contract.",
      );
    }
  } else {
    for (const [provider, adaptation] of [
      ["local-engine", input.local],
      ["website", input.website],
    ] as const) {
      if (adaptation.ok) continue;
      weaknesses.push(
        ...adaptation.issues.map(
          (entry) => `${provider}: ${entry.code} — ${entry.message}`,
        ),
      );
    }
    nextActions.push(
      "Regenerate the failed provider report with a complete compatibility envelope, explicit frozen scenario contract, and receipt-bound semantic/input evidence.",
    );
  }
  if (input.parity) {
    if (input.parity.modelCapabilityEnvelope.status === "match") {
      strengths.push("The providers declare the same normalized combat-model capability.");
    }
    if (input.parity.combatSnapshot.status === "match") {
      strengths.push("The provider-neutral unit, weapon, defense, and effect snapshots match.");
    }
    for (const summary of input.parity.metricSummaries) {
      const rate = (summary.withinToleranceRate * 100).toFixed(2);
      const text = `${summary.metric}: ${rate}% (${summary.withinToleranceCount}/${summary.expectedCellCount}) within tolerance.`;
      (summary.status === "pass" ? strengths : weaknesses).push(text);
    }
    const failedWinners = input.parity.winnerClassifications.filter(
      (winner) => winner.status === "fail",
    );
    if (failedWinners.length === 0 && input.parity.winnerClassifications.length > 0) {
      strengths.push(
        "The canonical probability-pressure winner agrees, including uncertainty boundaries.",
      );
    } else if (failedWinners.length > 0) {
      weaknesses.push(
        `${failedWinners.length} canonical winner classification(s) disagree outside uncertainty.`,
      );
    }
    weaknesses.push(
      ...input.parity.issues.map(
        (entry) => `${entry.code}${entry.key ? ` (${entry.key})` : ""}: ${entry.message}`,
      ),
    );
    if (input.parity.outcome === "fail") {
      nextActions.push(
        "Inspect the largest tolerance multiples and effect/profile diffs; treat them as model drift only after all eligibility identities remain matched.",
      );
    } else if (input.parity.outcome === "ineligible") {
      nextActions.push(
        "Resolve bundle, roster, profile, scenario, capability, or combat-snapshot drift before interpreting numeric differences.",
      );
    } else if (input.parity.outcome === "incomplete") {
      nextActions.push(
        "Repeat the paired run with complete cells and retained sample uncertainty for every requested metric.",
      );
    }
  }
  return {
    strengths: [...new Set(strengths)],
    weaknesses: [...new Set(weaknesses)],
    nextActions: [...new Set(nextActions)],
  };
}

function providerAssessment(input: {
  localReport: VerifiedReport;
  websiteReport: VerifiedReport;
  local: TesseraReportBoundProviderParityAdapterResult;
  website: TesseraReportBoundProviderParityAdapterResult;
}) {
  const localStrengths = [
    "The exact local report and receipt bind one pinned tessera-engine identity to hash-verified, bundle-native simulation inputs.",
  ];
  const localWeaknesses = [
    "Local reproducibility applies only to the explicitly shared combat-capability envelope; missions, movement, terrain geometry, stratagem sequencing, and other omitted mechanics are not modeled here.",
  ];
  const localIdentity = input.localReport.providerIdentity;
  if (input.local.ok) {
    localStrengths.push(
      "Roster, scenario, combat-profile, and capability identities were rebuilt from report-bound local inputs without a website dependency.",
    );
  } else {
    localWeaknesses.push(
      "The local evidence did not satisfy the strict report-bound parity adapter, so its numeric cells cannot establish provider parity.",
    );
  }
  if (
    localIdentity.provider === "local-engine" &&
    (localIdentity.promotion !== "promoted" ||
      localIdentity.licenseState !== "approved")
  ) {
    localWeaknesses.push(
      `The pinned local engine is ${localIdentity.promotion} with ${localIdentity.licenseState} licensing; a parity result does not authorize production promotion.`,
    );
  }

  const websiteStrengths = [
    "The exact Web report and receipt bind the result to one observed tessera-ui deployment and selected provider identity.",
  ];
  const websiteWeaknesses = [
    "Tessera Web does not expose a source commit or authoritative semantic rules version here; identity is limited to observed deployment bytes, adapter identity, selected-list state, and visible semantics.",
  ];
  const websiteEvidence =
    executionEvidence(input.websiteReport).website;
  if (
    input.website.ok &&
    websiteEvidence?.deploymentComplete &&
    websiteEvidence.importSemanticsComplete &&
    websiteEvidence.stateBindingsComplete
  ) {
    websiteStrengths.push(
      "Live deployment hashes, imported unit/weapon/effect semantics, and both selected-list state bindings were complete for this run.",
    );
  } else {
    websiteWeaknesses.push(
      "The captured Web deployment/import/state evidence was incomplete or failed strict semantic derivation, so opaque behavior cannot be filled from local roster data.",
    );
  }
  return {
    localEngine: {
      strengths: localStrengths,
      weaknesses: localWeaknesses,
    },
    website: {
      strengths: websiteStrengths,
      weaknesses: websiteWeaknesses,
    },
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function listHtml(values: string[], empty: string): string {
  return values.length > 0
    ? `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
    : `<p class="muted">${escapeHtml(empty)}</p>`;
}

export function renderTesseraProviderParityWorkflowHtml(
  artifact: TesseraProviderParityWorkflowArtifact,
): string {
  const metricRows = artifact.parity?.metricSummaries.map((summary) => `
<tr><th>${escapeHtml(summary.metric)}</th><td>${escapeHtml(summary.status)}</td><td>${escapeHtml(summary.comparedCellCount)}/${escapeHtml(summary.expectedCellCount)}</td><td>${escapeHtml((summary.withinToleranceRate * 100).toFixed(2))}%</td><td>${escapeHtml(summary.beyondDoubleToleranceCount)}</td></tr>`).join("") ?? "";
  const largestCells = [...(artifact.parity?.cells ?? [])]
    .filter((cell) => cell.toleranceMultiple !== null)
    .sort((left, right) =>
      (right.toleranceMultiple ?? -1) - (left.toleranceMultiple ?? -1)
    )
    .slice(0, 20)
    .map((cell) => `
<tr><th>${escapeHtml(cell.key)}</th><td>${escapeHtml(cell.metric)}</td><td>${escapeHtml(cell.localValue)}</td><td>${escapeHtml(cell.websiteValue)}</td><td>${escapeHtml(cell.difference)}</td><td>${escapeHtml(cell.tolerance?.value ?? "—")}</td><td>${escapeHtml(cell.toleranceMultiple?.toFixed(2) ?? "—")}</td><td>${escapeHtml(cell.status)}</td></tr>`)
    .join("");
  const sourceRows = artifact.sourceReports.map((source) => `
<tr><th>${escapeHtml(source.provider)}</th><td>${escapeHtml(source.executionEvidence.reportSource)} / ${escapeHtml(source.executionEvidence.reportStatus)} / ${escapeHtml(source.executionEvidence.simulationStatus ?? "unavailable")}</td><td><code>${escapeHtml(source.runId)}</code></td><td><code>${escapeHtml(source.reportSha256)}</code><br><code>${escapeHtml(source.receiptSha256)}</code></td><td><code>${escapeHtml(source.providerCompatibilityEnvelopeSha256 ?? "unavailable")}</code></td><td><code>${escapeHtml(source.rawScenarioContractSha256 ?? "unavailable")}</code></td><td><code>${escapeHtml(source.normalizedScenarioContractSha256 ?? "unavailable")}</code></td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera provider parity</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;margin:0;background:#f4f6f8;color:#17202a}main{max-width:1200px;margin:auto;padding:32px}header,section{background:white;border:1px solid #dfe5eb;border-radius:12px;padding:20px;margin:0 0 18px}h1,h2{margin-top:0}.badge{display:inline-block;border-radius:999px;padding:5px 10px;background:#e8eef5;font-weight:700}.pass{background:#dff5e5}.fail{background:#fde2df}.muted{color:#596773}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e8edf2;padding:8px}code{font-size:12px;overflow-wrap:anywhere}.caution{border-left:4px solid #d68a00;padding-left:12px}</style></head><body><main>
<header><p class="badge ${artifact.outcome === "pass" ? "pass" : "fail"}">${escapeHtml(artifact.outcome)}</p><h1>Local engine vs Tessera Web</h1><p>Classification: <strong>${escapeHtml(artifact.classification)}</strong> · Generated ${escapeHtml(artifact.generatedAt)}</p><p class="caution">Directional combat parity only. This is not a game win probability.</p></header>
<section><h2>Bound sources and scenario identity</h2><table><thead><tr><th>Provider</th><th>Source / report / simulation</th><th>Run</th><th>Report / receipt SHA-256</th><th>Compatibility envelope</th><th>Raw contract</th><th>Normalized contract</th></tr></thead><tbody>${sourceRows}</tbody></table><p class="muted">Only the provider-only <code>provider</code> setting is discarded. Phase, direction, metric, and iteration metadata are compared structurally. Cover, charge, range, stationary, and indirect-fire semantics are mapped and compared; unknown settings fail closed.</p></section>
<section><h2>Provider-specific assessment</h2><h3>Local engine — strengths</h3>${listHtml(artifact.providerAssessment.localEngine.strengths, "No local-engine strength was established.")}<h3>Local engine — weaknesses</h3>${listHtml(artifact.providerAssessment.localEngine.weaknesses, "No local-engine limitation was recorded.")}<h3>Tessera Web — strengths</h3>${listHtml(artifact.providerAssessment.website.strengths, "No Web strength was established.")}<h3>Tessera Web — weaknesses</h3>${listHtml(artifact.providerAssessment.website.weaknesses, "No Web limitation was recorded.")}</section>
<section><h2>Strengths</h2>${listHtml(artifact.strengths, "No strengths could be established from the retained evidence.")}</section>
<section><h2>Weaknesses</h2>${listHtml(artifact.weaknesses, "No policy weakness was detected.")}</section>
<section><h2>Metric coverage</h2>${metricRows ? `<table><thead><tr><th>Metric</th><th>Status</th><th>Compared</th><th>Within tolerance</th><th>Beyond 2×</th></tr></thead><tbody>${metricRows}</tbody></table>` : '<p class="muted">Numeric parity was not eligible.</p>'}</section>
<section><h2>Largest normalized differences</h2>${largestCells ? `<table><thead><tr><th>Cell</th><th>Metric</th><th>Local</th><th>Web</th><th>Difference</th><th>Tolerance</th><th>Multiple</th><th>Status</th></tr></thead><tbody>${largestCells}</tbody></table>` : '<p class="muted">No comparable cells.</p>'}</section>
<section><h2>Next actions</h2>${listHtml(artifact.nextActions, "No corrective action is required by this comparison.")}</section>
<section><h2>Limitations</h2>${listHtml(artifact.limitations, "")}</section>
</main></body></html>`;
}

export async function runTesseraProviderParityWorkflow(
  options: RunTesseraProviderParityWorkflowOptions,
): Promise<RunTesseraProviderParityWorkflowResult> {
  const [localReport, websiteReport] = await Promise.all([
    readVerifiedReport(options.localReportPath, "local-engine"),
    readVerifiedReport(options.websiteReportPath, "website"),
  ]);
  const [local, website] = await Promise.all([
    adaptReportBoundTesseraMatchupReportToProviderParityRun(
      localReport.report,
      localReport.path,
    ),
    adaptReportBoundTesseraMatchupReportToProviderParityRun(
      websiteReport.report,
      websiteReport.path,
    ),
  ]);
  const parity = local.ok && website.ok
    ? compareTesseraProviderParity(local.run, website.run)
    : null;
  const summary = findings({ local, website, parity });
  const perProvider = providerAssessment({
    localReport,
    websiteReport,
    local,
    website,
  });
  const outputDirectory = options.outputDirectory ?? "exports/tessera/parity";
  const filenames = {
    json: "tessera-provider-parity.json",
    html: "tessera-provider-parity.html",
    checksum: "tessera-provider-parity.json.sha256",
  };
  const sourceReports = [
    { verified: localReport, adapted: local },
    { verified: websiteReport, adapted: website },
  ].map(({ verified, adapted }) => ({
    provider: verified.provider,
    reportPath: path.basename(verified.path),
    receiptPath: path.basename(verified.receiptPath),
    reportSha256: verified.reportSha256,
    receiptSha256: verified.receiptSha256,
    receiptEvidenceSha256: verified.receiptEvidenceSha256,
    runId: verified.report.runId,
    executionEvidence: executionEvidence(verified),
    providerCompatibilityEnvelopeSha256:
      adapted.ok
        ? adapted.bindings.providerCompatibilityEnvelopeSha256
        : verified.report.providerCompatibility?.envelopeSha256 ?? null,
    rawScenarioContractSha256:
      adapted.ok
        ? adapted.bindings.rawScenarioContractSha256
        : verified.report.scenarioContractSha256 ?? null,
    normalizedScenarioContractSha256:
      adapted.ok
        ? adapted.bindings.normalizedScenarioContractSha256
        : null,
    normalizedInputSha256:
      adapted.ok ? adapted.bindings.normalizedInputSha256 : null,
  }));
  const comparisonClassification = classifyTesseraProviderParityWorkflow(
    parity,
    local.ok && website.ok,
  );
  const artifact: TesseraProviderParityWorkflowArtifact = {
    schemaVersion: 1,
    kind: "tessera-provider-parity-comparison",
    evidenceKind: "paired-receipt-bound-completed-provider-reports",
    sourceResolution: {
      kind: "reports-root-sha256-run-id",
      reportRootRequired: true,
    },
    generatedAt: new Date().toISOString(),
    outcome: parity?.outcome ?? "ineligible",
    classification: comparisonClassification,
    sourceReports,
    scenarioNormalization: {
      version: TESSERA_PROVIDER_NEUTRAL_SCENARIO_SETTINGS_VERSION,
      providerOnlySettingsIgnored: ["provider"],
      gameplaySettingsCompared: [
        "targetInCover",
        "charging",
        "withinRapidFireRange",
        "withinMeltaRange",
        "remainedStationary",
        "indirectFire",
      ],
    },
    adaptation: {
      local: adaptationView(local),
      website: adaptationView(website),
    },
    parity,
    providerAssessment: perProvider,
    strengths: summary.strengths,
    weaknesses: summary.weaknesses,
    nextActions: summary.nextActions,
    limitations: [
      "This comparison measures directional combat-model parity, not game win probability.",
      "Movement, terrain geometry, missions, scoring, deployment, sequencing, player decisions, and mechanics outside the shared capability envelope remain out of scope.",
      "A pass applies only to the exact receipt-bound reports, data bundle, provider deployments, imported semantics, profile policy, and frozen scenario contract named here.",
    ],
    artifacts: [
      { format: "provider-parity-json", written: filenames.json },
      { format: "provider-parity-html", written: filenames.html },
      { format: "provider-parity-sha256", written: filenames.checksum },
    ],
  };
  const json = `${canonicalJson(artifact)}\n`;
  const html = renderTesseraProviderParityWorkflowHtml(artifact);
  const checksum = `${sha256(json)}  ${filenames.json}\n`;
  const exportArtifacts: ExportArtifact[] = [
    {
      format: "roster-json",
      filename: filenames.json,
      mimeType: "application/json",
      encoding: "utf8",
      content: json,
    },
    {
      format: "html",
      filename: filenames.html,
      mimeType: "text/html; charset=utf-8",
      encoding: "utf8",
      content: html,
    },
    {
      format: "text",
      filename: filenames.checksum,
      mimeType: "text/plain; charset=utf-8",
      encoding: "utf8",
      content: checksum,
    },
  ];
  const written = await writeExportArtifacts(
    exportArtifacts,
    outputDirectory,
    {
      rootDir: options.rootDir,
      overwrite: options.overwrite,
      allowOutsideRoot: options.allowOutsideRoot,
    },
  );
  artifact.artifacts = [
    { format: "provider-parity-json", written: written[0] },
    { format: "provider-parity-html", written: written[1] },
    { format: "provider-parity-sha256", written: written[2] },
  ];
  const ok = parity?.outcome === "pass";
  return {
    ok,
    data: artifact,
    violations: ok
      ? []
      : [{
          code:
            comparisonClassification === "model-drift"
              ? "TESSERA_PROVIDER_MODEL_DRIFT"
              : comparisonClassification === "evidence-incomplete"
                ? "TESSERA_PROVIDER_PARITY_EVIDENCE_INCOMPLETE"
                : "TESSERA_PROVIDER_PARITY_INELIGIBLE",
          message:
            comparisonClassification === "model-drift"
              ? "The eligible local and website reports failed the numerical parity policy."
              : comparisonClassification === "evidence-incomplete"
                ? "The local and website reports did not retain complete evidence for every requested parity cell."
                : "The local and website reports did not establish eligible provider parity.",
          severity: "error",
        }],
    warnings: [],
  };
}
