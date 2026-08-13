import type {
  TesseraChangeCandidate,
  TesseraFinding,
  TesseraMatchupReport,
  TesseraMetricValues,
  TesseraRevisionComparisonReport,
  TesseraScenarioCell,
} from "../../lib/rosterpilot";

type DisplayMetric =
  | "wipe-probability"
  | "half-wipe-probability"
  | "mean-kills"
  | "mean-damage"
  | "damage-per-100-points";

type DisplayCell = {
  opponent: string;
  phase: string;
  direction: string;
  confidence: string;
  attackerId: string;
  attackerLabel: string;
  targetId: string;
  targetLabel: string;
  values: Record<DisplayMetric, number | null>;
  uncertainty: Record<
    DisplayMetric,
    {
      sampleCount: number | null;
      standardDeviation: number | null;
      standardError: number | null;
      completeness: string;
    } | null
  >;
  combatEnvelope: Record<
    DisplayMetric,
    {
      min: number;
      median: number;
      max: number;
      variantCount: number;
      sourceVariantCount: number;
      coverage: string;
      claimEligibility: string;
      reasons: string[];
    } | null
  >;
  warnings: string[];
};

type DisplayFinding = {
  kind: string;
  severity: string;
  confidence: string;
  summary: string;
  evidence: string[];
};

type DisplayCandidate = {
  title: string;
  rationale: string;
  points: string;
  operation: string;
  evidence: string[];
};

type DisplayPointsComparison = {
  opponent: string;
  playerPoints: number;
  opponentPoints: number;
  pointsLimit: number;
  difference: number;
  differencePercent: number;
  tolerancePercent: number;
  matched: boolean;
};

type DisplayPair = {
  label: string;
  value: string;
};

type DisplayReport = {
  title: string;
  playerLabel: string;
  opponentLabels: Record<string, string>;
  status: string;
  source: string;
  generatedAt: string;
  comparisonClass: string;
  points: DisplayPointsComparison[];
  settings: DisplayPair[];
  provenance: DisplayPair[];
  cells: DisplayCell[];
  findings: DisplayFinding[];
  candidates: DisplayCandidate[];
  warnings: string[];
  limitations: string[];
};

type DisplayRevisionDelta = {
  opponent: string;
  phase: string;
  metric: string;
  direction: string;
  attackerId: string;
  targetId: string;
  before: number | null;
  after: number | null;
  change: number | null;
  classification: string;
};

const metricLabels: Record<DisplayMetric, string> = {
  "wipe-probability": "Full-wipe probability",
  "half-wipe-probability": "Half-wipe probability",
  "mean-kills": "Mean kills",
  "mean-damage": "Mean damage",
  "damage-per-100-points": "Damage per 100 points",
};

const sensitiveKey =
  /(?:password|secret|token|cookie|credential|licen[cs]e.?key|premium.?key|authorization|browser.?storage|browser.?profile|profile.?directory|local.?storage|session.?storage)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.replace(
    /((?:password|secret|token|cookie|credential|licen[cs]e|premium)\s*(?:key)?\s*[:=]\s*)\S+/gi,
    "$1[redacted]",
  );
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function displayNumber(value: number | null): string {
  return value === null
    ? "Not available"
    : new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 2,
      }).format(value);
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function safeObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(safeObject);
  }
  if (!isRecord(value)) {
    return typeof value === "string" ? safeText(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveKey.test(key))
      .map(([key, child]) => [key, safeObject(child)]),
  );
}

function safePairs(
  source: Record<string, unknown> | undefined,
  prefix = "",
): DisplayPair[] {
  if (!source) {
    return [];
  }
  const pairs: DisplayPair[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (sensitiveKey.test(key) || value === null || value === undefined) {
      continue;
    }
    const label = prefix ? `${prefix}: ${key}` : key;
    if (typeof value === "string" || typeof value === "number") {
      pairs.push({ label: safeText(label), value: safeText(String(value)) });
    } else if (typeof value === "boolean") {
      pairs.push({ label: safeText(label), value: value ? "Yes" : "No" });
    }
  }
  return pairs;
}

function metricValues(values: Partial<TesseraMetricValues>): DisplayCell["values"] {
  return {
    "wipe-probability": safeNumber(values.wipeProbability),
    "half-wipe-probability": safeNumber(values.halfWipeProbability),
    "mean-kills": safeNumber(values.meanKills),
    "mean-damage": safeNumber(values.meanDamage),
    "damage-per-100-points": safeNumber(values.damagePer100Points),
  };
}

function metricUncertainty(
  cell: TesseraScenarioCell,
): DisplayCell["uncertainty"] {
  const normalized = (
    metric: "wipe-probability" | "half-wipe-probability" | "mean-kills" | "mean-damage",
  ) => {
    const value = cell.uncertainty?.[metric];
    return value
      ? {
          sampleCount: safeNumber(value.sampleCount),
          standardDeviation: safeNumber(value.standardDeviation),
          standardError: safeNumber(value.standardError),
          completeness: safeText(value.completeness, "unavailable"),
        }
      : null;
  };
  return {
    "wipe-probability": normalized("wipe-probability"),
    "half-wipe-probability": normalized("half-wipe-probability"),
    "mean-kills": normalized("mean-kills"),
    "mean-damage": normalized("mean-damage"),
    "damage-per-100-points": null,
  };
}

function metricCombatEnvelope(
  cell: TesseraScenarioCell,
): DisplayCell["combatEnvelope"] {
  const normalized = (
    metric:
      | "wipe-probability"
      | "half-wipe-probability"
      | "mean-kills"
      | "mean-damage",
  ) => {
    const envelope = cell.combatEnvelope?.[metric];
    return envelope
      ? {
          min: envelope.min,
          median: envelope.median,
          max: envelope.max,
          variantCount: envelope.variantCount,
          sourceVariantCount: envelope.sourceVariantCount,
          coverage: safeText(envelope.coverage.status),
          claimEligibility: safeText(
            envelope.coverage.claimEligibility,
          ),
          reasons: envelope.coverage.reasons.map((reason) =>
            safeText(reason),
          ),
        }
      : null;
  };
  return {
    "wipe-probability": normalized("wipe-probability"),
    "half-wipe-probability": normalized("half-wipe-probability"),
    "mean-kills": normalized("mean-kills"),
    "mean-damage": normalized("mean-damage"),
    "damage-per-100-points": null,
  };
}

function scenarioCell(
  cell: TesseraScenarioCell,
  opponent: string,
  phase: string,
  direction: string,
): DisplayCell {
  const displayUnit = (unit: TesseraScenarioCell["attacker"]): string => {
    const name = safeText(unit.name, unit.label);
    return unit.ordinal > 1 ? `${name} · Unit ${unit.ordinal}` : name;
  };
  return {
    opponent: safeText(opponent, "Opponent"),
    phase: safeText(phase, "unspecified"),
    direction: safeText(direction, "unspecified"),
    confidence: safeText(cell.confidence, "review"),
    attackerId: safeText(cell.attacker.instanceId, cell.attacker.label),
    attackerLabel: displayUnit(cell.attacker),
    targetId: safeText(cell.target.instanceId, cell.target.label),
    targetLabel: displayUnit(cell.target),
    values: metricValues(cell.values),
    uncertainty: metricUncertainty(cell),
    combatEnvelope: metricCombatEnvelope(cell),
    warnings: cell.warningRefs.map((warning) => safeText(warning)),
  };
}

function legacyCells(report: TesseraMatchupReport): DisplayCell[] {
  return report.simulation.matrices.flatMap((matrix, matrixIndex) =>
    matrix.cells.map((cell, cellIndex) => ({
      opponent: safeText(matrix.opponentName, `Opponent ${matrixIndex + 1}`),
      phase: safeText(report.simulation.settings.phase, "unspecified"),
      direction: safeText(cell.direction, "player-to-opponent"),
      confidence: "review",
      attackerId: `legacy-attacker-${matrixIndex}-${cellIndex}`,
      attackerLabel: safeText(cell.attacker, "Unknown attacker"),
      targetId: `legacy-target-${matrixIndex}-${cellIndex}`,
      targetLabel: safeText(cell.target, "Unknown target"),
      values: {
        "wipe-probability": safeNumber(cell.killProbability),
        "half-wipe-probability": null,
        "mean-kills": null,
        "mean-damage": safeNumber(cell.expectedDamage),
        "damage-per-100-points": safeNumber(cell.damagePer100Points),
      },
      uncertainty: {
        "wipe-probability": null,
        "half-wipe-probability": null,
        "mean-kills": null,
        "mean-damage": null,
        "damage-per-100-points": null,
      },
      combatEnvelope: {
        "wipe-probability": null,
        "half-wipe-probability": null,
        "mean-kills": null,
        "mean-damage": null,
        "damage-per-100-points": null,
      },
      warnings: ["Legacy matrix data does not include stable unit identities."],
    })),
  );
}

function normalizedCells(report: TesseraMatchupReport): DisplayCell[] {
  const scenarios = report.simulation.scenarios ?? [];
  if (!scenarios.length) {
    return legacyCells(report);
  }
  return scenarios.flatMap((scenario) =>
    scenario.cells.map((cell) =>
      scenarioCell(
        cell,
        scenario.opponentName,
        scenario.phase,
        scenario.direction,
      ),
    ),
  );
}

function formatEvidenceValues(values: TesseraMetricValues): string {
  const parts = [
    values.wipeProbability === null
      ? ""
      : `${Math.round(values.wipeProbability * 100)}% full wipe`,
    values.halfWipeProbability === null
      ? ""
      : `${Math.round(values.halfWipeProbability * 100)}% half wipe`,
    values.meanKills === null ? "" : `${displayNumber(values.meanKills)} mean kills`,
    values.meanDamage === null
      ? ""
      : `${displayNumber(values.meanDamage)} mean damage`,
    values.damagePer100Points === null
      ? ""
      : `${displayNumber(values.damagePer100Points)} damage/100 pts`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "No modeled value available";
}

function structuredFinding(finding: TesseraFinding): DisplayFinding {
  return {
    kind: safeText(finding.kind),
    severity: safeText(finding.severity),
    confidence: safeText(finding.confidence),
    summary: safeText(finding.summary),
    evidence: finding.evidence.map(
      (evidence) =>
        `${safeText(evidence.phase)} · ${safeText(
          evidence.direction,
        )} · ${safeText(evidence.attackerInstanceId)} → ${safeText(
          evidence.targetInstanceId,
        )}: ${formatEvidenceValues(evidence.values)}`,
    ),
  };
}

function normalizedFindings(report: TesseraMatchupReport): DisplayFinding[] {
  if (report.findings?.length) {
    return report.findings.map(structuredFinding);
  }
  return [
    ...report.strengths.map((summary) => ({
      kind: "strength",
      severity: "info",
      confidence: "review",
      summary: safeText(summary),
      evidence: [],
    })),
    ...report.weaknesses.map((summary) => ({
      kind: "weakness",
      severity: "warn",
      confidence: "review",
      summary: safeText(summary),
      evidence: [],
    })),
    ...report.suggestions.map((summary) => ({
      kind: "suggestion",
      severity: "info",
      confidence: "review",
      summary: safeText(summary),
      evidence: [],
    })),
  ];
}

function candidateView(candidate: TesseraChangeCandidate): DisplayCandidate {
  return {
    title: safeText(candidate.title),
    rationale: safeText(candidate.rationale),
    points: `${candidate.beforePoints} → ${candidate.afterPoints} points`,
    operation: JSON.stringify(safeObject(candidate.operation), null, 2),
    evidence: candidate.evidenceFindingIds.map((id) => safeText(id)),
  };
}

function opponentNameAt(
  report: TesseraMatchupReport,
  index: number,
): string {
  return safeText(report.opponents[index]?.rosterName, `Opponent ${index + 1}`);
}

function pointsComparisons(
  report: TesseraMatchupReport,
): DisplayPointsComparison[] {
  if (report.pointsComparisons?.length) {
    return report.pointsComparisons.map((comparison, index) => ({
      opponent: opponentNameAt(report, index),
      playerPoints: comparison.playerPoints,
      opponentPoints: comparison.opponentPoints,
      pointsLimit: comparison.pointsLimit,
      difference: comparison.difference,
      differencePercent: comparison.differencePercent,
      tolerancePercent: comparison.tolerancePercent,
      matched: comparison.matched,
    }));
  }
  return report.opponents.map((opponent) => {
    const playerPoints = report.player.summary.totalPoints;
    const opponentPoints = opponent.summary.totalPoints;
    const difference = Math.abs(playerPoints - opponentPoints);
    const pointsLimit = Math.max(playerPoints, opponentPoints, 1);
    return {
      opponent: safeText(opponent.rosterName, "Opponent"),
      playerPoints,
      opponentPoints,
      pointsLimit,
      difference,
      differencePercent: (difference / pointsLimit) * 100,
      tolerancePercent: 5,
      matched: difference / pointsLimit <= 0.05,
    };
  });
}

function reportSettings(report: TesseraMatchupReport): DisplayPair[] {
  const configuration = report.configuration
    ? safePairs({
        analysisMode: report.configuration.analysisMode,
        phases: report.configuration.phases.join(", "),
        metrics: report.configuration.metrics.join(", "),
        directions: report.configuration.directions.join(", "),
        pointsTolerancePercent: report.configuration.pointsTolerancePercent,
        allowPointMismatch: report.configuration.allowPointMismatch,
        includeChangeCandidates: report.configuration.includeChangeCandidates,
        providerCompatibilityMode:
          report.configuration.providerCompatibilityMode ?? "observe",
      })
    : [];
  const simulator = safePairs(report.simulation.settings, "Tessera");
  const scenarios = (report.simulation.scenarios ?? []).flatMap((scenario) => [
    ...(scenario.iterations === null
      ? []
      : [
          {
            label: `${scenario.scenarioId}: iterations`,
            value: String(scenario.iterations),
          },
        ]),
    ...safePairs(scenario.settings, scenario.scenarioId),
  ]);
  const seen = new Set<string>();
  return [...configuration, ...simulator, ...scenarios].filter((pair) => {
    const key = `${pair.label}\0${pair.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function reportProvenance(report: TesseraMatchupReport): DisplayPair[] {
  const providerIdentity = report.simulation.providerIdentity;
  const compatibilityEnvelopes = report.providerCompatibilityEnvelopes ??
    (report.providerCompatibility ? [report.providerCompatibility] : []);
  const pairs: DisplayPair[] = [
    { label: "Run ID", value: safeText(report.runId) },
    { label: "Generated", value: safeText(report.generatedAt) },
    { label: "Source", value: safeText(report.source) },
    {
      label: "Schema",
      value:
        report.schemaVersion === 4
          ? "Tessera report v4"
          : report.schemaVersion === 3
          ? "Tessera report v3"
          : report.schemaVersion === 2
            ? "Tessera report v2"
            : "Legacy report",
    },
    {
      label: "Player export",
      value: safeText(report.player.summary.generatedBy, "Unknown"),
    },
    {
      label: "Requested simulation backend",
      value: safeText(report.simulation.requestedBackend, "website"),
    },
    {
      label: "Selected simulation backend",
      value: safeText(report.simulation.selectedBackend, "website"),
    },
  ];
  if (providerIdentity?.provider === "website") {
    pairs.push(
      { label: "Provider engine", value: providerIdentity.engine },
      {
        label: "Tessera UI identity",
        value: safeText(providerIdentity.uiIdentity, "Unavailable"),
      },
      {
        label: "Provider adapter",
        value: safeText(providerIdentity.adapterVersion),
      },
    );
  } else if (providerIdentity?.provider === "local-engine") {
    pairs.push(
      { label: "Provider engine", value: providerIdentity.engine },
      { label: "Engine commit", value: providerIdentity.commit },
      { label: "Engine source SHA-256", value: providerIdentity.sourceSha256 },
      { label: "Compiler", value: providerIdentity.compilerVersion },
      { label: "Provider adapter", value: providerIdentity.adapterVersion },
      { label: "Promotion state", value: providerIdentity.promotion },
      { label: "Usage state", value: providerIdentity.licenseState },
    );
  }
  if (report.scenarioContractSha256) {
    pairs.push({
      label: "Scenario contract SHA-256",
      value: safeText(report.scenarioContractSha256),
    });
  }
  if (report.scenarioPolicyContractV2Sha256) {
    pairs.push({
      label: "Scenario/policy v2 SHA-256",
      value: safeText(report.scenarioPolicyContractV2Sha256),
    });
  }
  const compactBridgeEvidence =
    report.simulation.combatBridgeEvidence ?? [];
  for (const [index, bridge] of compactBridgeEvidence.entries()) {
    pairs.push(
      {
        label: `${safeText(
          bridge.opponentName,
          opponentNameAt(report, index),
        )} combat bridge SHA-256`,
        value: safeText(bridge.bridgeSha256),
      },
      {
        label: `${safeText(
          bridge.opponentName,
          opponentNameAt(report, index),
        )} combat coverage`,
        value: `${safeText(bridge.coverage.status)} · ${safeText(
          bridge.coverage.claimEligibility,
        )} · ${bridge.coverage.omittedEffects} omitted · ${bridge.uniqueMechanicsCount}/${bridge.cellCount} unique mechanics`,
      },
      {
        label: `${safeText(
          bridge.opponentName,
          opponentNameAt(report, index),
        )} combat evidence SHA-256`,
        value: safeText(bridge.evidenceSha256),
      },
    );
  }
  if (compactBridgeEvidence.length === 0) {
    for (const [index, bridge] of (
      report.simulation.combatBridges ?? []
    ).entries()) {
      pairs.push(
        {
          label: `${opponentNameAt(report, index)} combat bridge SHA-256`,
          value: safeText(bridge.bridgeSha256),
        },
        {
          label: `${opponentNameAt(report, index)} combat coverage`,
          value: `${safeText(bridge.coverage.status)} · ${safeText(
            bridge.coverage.claimEligibility,
          )} · ${bridge.coverage.omittedEffects} omitted`,
        },
      );
    }
  }
  compatibilityEnvelopes.forEach((envelope, index) => {
    const opponent = opponentNameAt(report, index);
    const website = envelope.tessera.website;
    pairs.push(
      {
        label: `${opponent} provider compatibility`,
        value: envelope.complete
          ? "Complete"
          : `Incomplete (${envelope.issues.length} issue${
              envelope.issues.length === 1 ? "" : "s"
            })`,
      },
      {
        label: `${opponent} compatibility envelope SHA-256`,
        value: safeText(envelope.envelopeSha256),
      },
      {
        label: `${opponent} signed data bundle`,
        value: safeText(envelope.data.bundleId),
      },
      {
        label: `${opponent} rules data`,
        value: `${safeText(envelope.data.rules.package)} ${safeText(
          envelope.data.rules.version,
        )} · ${safeText(envelope.data.rules.edition)} · ${safeText(
          envelope.data.rules.dataslate,
        )}`,
      },
      {
        label: `${opponent} BSData source`,
        value: `${safeText(envelope.data.bsData.repository)}@${safeText(
          envelope.data.bsData.commit,
        )}`,
      },
      {
        label: `${opponent} official points source`,
        value: `${safeText(envelope.data.official.mfmVersion)} · ${safeText(
          envelope.data.official.authorityStatus,
          "authority unavailable",
        )}`,
      },
      {
        label: `${opponent} semantic data identity`,
        value: safeText(envelope.data.semanticIdentitySha256),
      },
      {
        label: `${opponent} Tessera provider identity`,
        value: safeText(envelope.tessera.providerIdentitySha256),
      },
      {
        label: `${opponent} profile policy SHA-256`,
        value: safeText(envelope.profilePolicyHash, "Not available"),
      },
      {
        label: `${opponent} compatibility issue codes`,
        value:
          envelope.issues.map((entry) => safeText(entry.code)).join(", ") ||
          "None",
      },
    );
    envelope.rosters.forEach((roster) => {
      const sideLabel = roster.side === "player" ? "player" : opponent;
      const pinned = roster.newRecruit.pinned;
      const observed = roster.newRecruit.observed;
      pairs.push({
        label: `${sideLabel} New Recruit compatibility`,
        value: roster.newRecruit.status,
      });
      if (pinned) {
        pairs.push({
          label: `${sideLabel} pinned New Recruit catalogue`,
          value: `${safeText(pinned.gameSystem.name)} r${pinned.gameSystem.revision} · ${safeText(
            pinned.catalogue.name,
          )} r${pinned.catalogue.revision ?? "unknown"}`,
        });
      }
      if (observed) {
        pairs.push({
          label: `${sideLabel} observed New Recruit catalogue`,
          value: `${safeText(observed.gameSystem.name, "unknown game system")} r${
            observed.gameSystem.revision ?? "unknown"
          } · ${
            observed.catalogues
              .map(
                (catalogue) =>
                  `${safeText(catalogue.name, "unknown catalogue")} r${
                    catalogue.revision ?? "unknown"
                  }`,
              )
              .join(", ") || "no catalogue identity"
          }`,
        });
      }
    });
    if (website) {
      pairs.push(
        {
          label: `${opponent} Tessera Web deployment`,
          value: safeText(
            website.deployment.identitySha256,
            website.deployment.completeness,
          ),
        },
        {
          label: `${opponent} imported semantics`,
          value: safeText(
            website.importSemantics.combinedSha256,
            website.importSemantics.completeness,
          ),
        },
        {
          label: `${opponent} unresolved imported effects`,
          value: String(website.importSemantics.unresolvedEffectCount),
        },
        {
          label: `${opponent} Tessera Web same-origin assets`,
          value: `${website.deployment.assets.filter((asset) => asset.sameOrigin && asset.sha256).length}/${
            website.deployment.assets.filter((asset) => asset.sameOrigin).length
          } byte-hashed`,
        },
      );
    }
  });
  if (report.simulation.fallback) {
    pairs.push({
      label: "Provider fallback",
      value: `${report.simulation.fallback.from} → ${report.simulation.fallback.to} (${report.simulation.fallback.code}; local evidence discarded)`,
    });
  }
  if (report.player.fingerprint) {
    pairs.push({
      label: "Player roster fingerprint",
      value: safeText(report.player.fingerprint),
    });
  }
  report.opponents.forEach((opponent, index) => {
    pairs.push({
      label: `${opponentNameAt(report, index)} export`,
      value: safeText(opponent.summary.generatedBy, "Unknown"),
    });
    if (opponent.fingerprint) {
      pairs.push({
        label: `${opponentNameAt(report, index)} fingerprint`,
        value: safeText(opponent.fingerprint),
      });
    }
  });
  return pairs;
}

function normalizeReport(report: TesseraMatchupReport): DisplayReport {
  const points = pointsComparisons(report);
  const cells = normalizedCells(report);
  const playerLabel = safeText(
    report.player.summary.factionName,
    report.player.rosterName,
  );
  const opponentLabels = Object.fromEntries(
    report.opponents.map((opponent) => {
      const rosterName = safeText(opponent.rosterName, "Opponent");
      const factionName = safeText(
        opponent.summary.factionName,
        opponent.rosterName,
      );
      return [
        rosterName,
        rosterName === "RosterPilot Draft" ? factionName : rosterName,
      ];
    }),
  );
  const opponentFactions = unique(
    report.opponents.map((opponent) =>
      safeText(opponent.summary.factionName, opponent.rosterName),
    ),
  );
  const comparisonClass =
    report.comparisonClass ??
    (points.length && points.every((comparison) => comparison.matched)
      ? "matched"
      : "unmatched");
  return {
    title: opponentFactions.length === 1
      ? `${playerLabel} vs ${opponentFactions[0]} combat heat maps`
      : `${playerLabel} combat heat maps`,
    playerLabel,
    opponentLabels,
    status: safeText(report.status),
    source: safeText(report.source),
    generatedAt: safeText(report.generatedAt),
    comparisonClass,
    points,
    settings: reportSettings(report),
    provenance: reportProvenance(report),
    cells,
    findings: normalizedFindings(report),
    candidates: (report.changeCandidates ?? []).map(candidateView),
    warnings: unique([
      ...report.warnings.map((warning) => safeText(warning)),
      ...(report.simulation.scenarios ?? []).flatMap((scenario) =>
        scenario.warnings.map((warning) => safeText(warning)),
      ),
      ...cells.flatMap((cell) => cell.warnings),
    ]),
    limitations: unique(
      report.limitations.map((limitation) => safeText(limitation)),
    ),
  };
}

function renderPairs(pairs: DisplayPair[], emptyText: string): string {
  if (!pairs.length) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  }
  return `<dl class="pairs">${pairs
    .map(
      (pair) =>
        `<div><dt>${escapeHtml(pair.label)}</dt><dd>${escapeHtml(
          pair.value,
        )}</dd></div>`,
    )
    .join("")}</dl>`;
}

function renderStringList(items: string[], emptyText: string): string {
  if (!items.length) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  }
  return `<ul>${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
}

function renderPoints(points: DisplayPointsComparison[]): string {
  if (!points.length) {
    return '<p class="empty">No points comparison is available.</p>';
  }
  return `<div class="table-scroll"><table>
<thead><tr><th>Opponent</th><th>Player</th><th>Opponent</th><th>Limit</th><th>Difference</th><th>Status</th></tr></thead>
<tbody>${points
    .map(
      (point) => `<tr>
<th scope="row">${escapeHtml(point.opponent)}</th>
<td>${point.playerPoints}</td><td>${point.opponentPoints}</td><td>${point.pointsLimit}</td>
<td>${point.difference} (${displayNumber(point.differencePercent)}%)</td>
<td><span class="badge ${point.matched ? "good" : "warn"}">${
        point.matched ? "Matched" : "Unmatched"
      }</span><small> tolerance ${displayNumber(point.tolerancePercent)}%</small></td>
</tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderFindings(findings: DisplayFinding[]): string {
  if (!findings.length) {
    return '<p class="empty">No findings were produced from the available scenarios.</p>';
  }
  return `<div class="cards">${findings
    .map(
      (finding) => `<article class="card">
<div class="eyebrow">${escapeHtml(finding.kind)} · ${escapeHtml(
        finding.confidence,
      )} confidence</div>
<h3>${escapeHtml(finding.summary)}</h3>
${renderStringList(finding.evidence, "No structured evidence was recorded.")}
</article>`,
    )
    .join("")}</div>`;
}

function renderCandidates(candidates: DisplayCandidate[]): string {
  if (!candidates.length) {
    return '<p class="empty">No legal roster changes were proposed.</p>';
  }
  return `<div class="cards">${candidates
    .map(
      (candidate) => `<article class="card">
<div class="eyebrow">${escapeHtml(candidate.points)}</div>
<h3>${escapeHtml(candidate.title)}</h3>
<p>${escapeHtml(candidate.rationale)}</p>
<details><summary>Exact roster operation</summary><pre>${escapeHtml(
        candidate.operation,
      )}</pre></details>
${renderStringList(candidate.evidence, "No finding references were recorded.")}
</article>`,
    )
    .join("")}</div>`;
}

function selectOptions(
  values: string[],
  labels?: Record<string, string>,
  includeAll = true,
  preferred?: string,
): string {
  const clean = unique(values);
  const selected = preferred && clean.includes(preferred)
    ? preferred
    : clean[0] ?? "all";
  return [
    ...(includeAll
      ? [`<option value="all"${selected === "all" ? " selected" : ""}>All</option>`]
      : []),
    ...clean.map(
      (value) =>
        `<option value="${escapeHtml(value)}"${
          value === selected ? " selected" : ""
        }>${escapeHtml(labels?.[value] ?? value)}</option>`,
    ),
  ].join("");
}

function renderControls(
  cells: DisplayCell[],
  opponentLabels: Record<string, string>,
): string {
  const availableMetrics = (
    Object.keys(metricLabels) as DisplayMetric[]
  ).filter((metric) =>
    cells.some((cell) => cell.values[metric] !== null),
  );
  if (!availableMetrics.length) {
    availableMetrics.push("wipe-probability");
  }
  return `<form class="filters" id="matchup-filters">
<label>Opponent<select id="opponent-filter">${selectOptions(
    cells.map((cell) => cell.opponent),
    opponentLabels,
    false,
  )}</select></label>
<label>Phase<select id="phase-filter">${selectOptions(
    cells.map((cell) => cell.phase),
    { shooting: "Shooting", fight: "Fight" },
    false,
    "fight",
  )}</select></label>
<label>Measure<select id="metric-filter">${selectOptions(
    availableMetrics,
    metricLabels,
    false,
  )}</select></label>
</form>`;
}

function commonStyles(): string {
  return `<style>
:root{color-scheme:light;--ink:#16202a;--muted:#647181;--line:#d8dee6;--panel:#f5f7fa;--accent:#3157d5;--good:#177245;--warn:#a54b00}
*{box-sizing:border-box}body{margin:0;background:#eef1f5;color:var(--ink);font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;overflow-x:clip;padding:32px 20px 72px}.hero,section{background:#fff;border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:18px}
h1,h2,h3{line-height:1.2;margin-top:0}h1{font-size:clamp(1.8rem,4vw,2.7rem);margin-bottom:8px}h2{font-size:1.3rem}h3{font-size:1rem;margin-bottom:8px}
.kicker,.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;font-weight:700;color:var(--muted)}.meta{color:var(--muted)}
.caution{border-left:4px solid var(--warn);background:#fff7e8;padding:12px 14px;margin:18px 0 0}.badge{display:inline-block;border-radius:999px;padding:3px 9px;font-size:.78rem;font-weight:700;background:#e7ebf2}.badge.good{background:#dff5e9;color:var(--good)}.badge.warn{background:#fff0dc;color:var(--warn)}
.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:14px 0}.filters label{font-size:.78rem;font-weight:700;color:var(--muted)}select{display:block;width:100%;margin-top:4px;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff;color:var(--ink)}
.table-scroll{contain:inline-size;max-width:100%;min-width:0;overflow:auto;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:660px}th,td{border-bottom:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:#f0f3f7;z-index:1}tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
.heatmap-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:16px}.heatmap-panel{min-width:0}.heatmap-panel h3{font-size:1.15rem;margin-bottom:8px}.heatmap-panel .table-scroll{border:0;border-radius:0}.heatmap-panel table{min-width:420px;table-layout:fixed}.heatmap-panel th,.heatmap-panel td{border:3px solid #fff;padding:0}.heatmap-panel thead th{position:static;background:transparent;color:var(--muted);font-size:.72rem;font-weight:500;padding:4px;text-align:center}.heatmap-panel thead th:first-child{width:112px;text-align:left}.heatmap-panel tbody th{background:transparent;color:var(--muted);font-size:.75rem;font-weight:500;padding:7px;text-align:right;overflow-wrap:anywhere}.heat-cell{text-align:center;font-variant-numeric:tabular-nums;min-width:64px}.heat-cell button{appearance:none;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;font:600 .76rem/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:42px;padding:7px 3px;width:100%}.heat-cell button:hover,.heat-cell button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.heat-cell.empty{background:#f5f7fa}.heat-legend{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.72rem;margin-top:7px}.heat-legend span:nth-child(2){height:10px;flex:1;border:1px solid var(--line)}.heat-legend.player span:nth-child(2){background:linear-gradient(90deg,#f1f7fd,#70b7f5)}.heat-legend.opponent span:nth-child(2){background:linear-gradient(90deg,#fcf3f8,#e89ac7)}.cell-detail{border-top:1px solid var(--line);margin-top:16px;padding-top:12px;min-height:2.4rem}.directional-note{color:var(--muted);font-size:.8rem;margin-bottom:0}
.pairs{display:grid;grid-template-columns:repeat(2,minmax(240px,1fr));gap:0 24px;margin:0}.pairs div{display:grid;grid-template-columns:minmax(140px,1fr) 1.5fr;border-bottom:1px solid var(--line);padding:8px 0}.pairs dt{font-weight:700}.pairs dd{margin:0;overflow-wrap:anywhere}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.card{border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--panel)}.card ul{padding-left:20px}.empty{color:var(--muted);font-style:italic}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#18202a;color:#f5f7fa;padding:12px;border-radius:8px}
.delta-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.delta-stat{border:1px solid var(--line);border-radius:10px;padding:15px}.delta-stat strong{display:block;font-size:1.6rem}.improved{color:var(--good)}.worsened{color:#b42318}.ambiguous{color:var(--warn)}
@media(max-width:820px){.filters{grid-template-columns:repeat(2,1fr)}.heatmap-grid{grid-template-columns:1fr}.pairs{grid-template-columns:1fr}.delta-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:520px){main{padding-inline:10px}.hero,section{padding:16px}.filters{grid-template-columns:1fr}}@media print{body{background:#fff}.filters{display:none}.hero,section{break-inside:avoid;border-color:#bbb}}
</style>`;
}

function commonScript(): string {
  return `<script>
(() => {
  "use strict";
  const dataNode = document.getElementById("report-data");
  const data = dataNode ? JSON.parse(dataNode.textContent || "{}") : {};
  const cells = Array.isArray(data.cells) ? data.cells : [];
  const byId = (id) => document.getElementById(id);
  const selected = (id) => {
    const node = byId(id);
    return node && "value" in node ? node.value : "all";
  };
  const matches = (actual, wanted) => wanted === "all" || actual === wanted;
  const formatValue = (metric, value) => {
    if (value === null || typeof value !== "number") return "—";
    if (metric === "wipe-probability" || metric === "half-wipe-probability") {
      return (value * 100).toFixed(1) + "%";
    }
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  };
  const formatUncertainty = (value) => {
    if (!value || typeof value !== "object") return "uncertainty unavailable";
    const parts = [];
    if (Number.isInteger(value.sampleCount)) parts.push("n=" + value.sampleCount);
    if (typeof value.standardDeviation === "number") {
      parts.push("SD=" + formatValue("mean-damage", value.standardDeviation));
    }
    if (typeof value.standardError === "number") {
      parts.push("SE=" + formatValue("mean-damage", value.standardError));
    }
    parts.push(value.completeness || "unavailable");
    return parts.join(" · ");
  };
  const formatEnvelope = (metric, value) => {
    if (!value || typeof value !== "object") return "";
    return "rules envelope " + formatValue(metric, value.min) + " / " +
      formatValue(metric, value.median) + " / " + formatValue(metric, value.max) +
      " · " + value.variantCount + " execution" + (value.variantCount === 1 ? "" : "s") +
      " from " + value.sourceVariantCount + " source variant" +
      (value.sourceVariantCount === 1 ? "" : "s") +
      " · " + value.coverage + " · " + value.claimEligibility;
  };
  const heat = (metric, value, direction) => {
    if (value === null || typeof value !== "number") return "";
    const ratio = metric.includes("probability")
      ? Math.max(0, Math.min(1, value))
      : Math.max(0, Math.min(1, value / 20));
    const hue = direction === "player-to-opponent" ? 209 : 329;
    return "hsl(" + hue + " 72% " + Math.round(97 - ratio * 28) + "%)";
  };
  const make = (name, textValue) => {
    const node = document.createElement(name);
    if (textValue !== undefined) node.textContent = textValue;
    return node;
  };
  function panel(direction, filtered, metric) {
    const opponent = selected("opponent-filter");
    const playerLabel = typeof data.playerLabel === "string" ? data.playerLabel : "Player";
    const opponentLabels = data.opponentLabels && typeof data.opponentLabels === "object"
      ? data.opponentLabels
      : {};
    const opponentLabel = opponentLabels[opponent] || opponent || "Opponent";
    const panel = make("div");
    panel.className = "heatmap-panel";
    panel.dataset.direction = direction;
    panel.append(make("h3", direction === "player-to-opponent"
      ? playerLabel + " attacks"
      : opponentLabel + " attacks"));
    const directionCells = filtered.filter((cell) =>
      cell.direction === direction &&
      typeof cell.values[metric] === "number"
    );
    if (!directionCells.length) {
      panel.append(make("p", "No cells are available for this direction."));
      return panel;
    }
    const attackers = [...new Map(directionCells.map((cell) => [cell.attackerId, cell.attackerLabel])).entries()];
    const targets = [...new Map(directionCells.map((cell) => [cell.targetId, cell.targetLabel])).entries()];
    const values = new Map();
    for (const cell of directionCells) {
      const key = cell.attackerId + "\\u0000" + cell.targetId;
      if (!values.has(key)) values.set(key, cell);
    }
    const wrapper = make("div");
    wrapper.className = "table-scroll";
    const table = make("table");
    const thead = make("thead");
    const headRow = make("tr");
    headRow.append(make("th", "Attacker ↓ / Target →"));
    for (const [, label] of targets) headRow.append(make("th", label));
    thead.append(headRow);
    table.append(thead);
    const tbody = make("tbody");
    for (const [attackerId, attackerLabel] of attackers) {
      const row = make("tr");
      const rowHead = make("th", attackerLabel);
      rowHead.scope = "row";
      row.append(rowHead);
      for (const [targetId, targetLabel] of targets) {
        const cell = values.get(attackerId + "\\u0000" + targetId);
        const td = make("td");
        td.className = "heat-cell" + (cell ? "" : " empty");
        const value = cell ? cell.values[metric] : null;
        td.style.background = heat(metric, value, direction);
        if (cell) {
          const button = make("button", formatValue(metric, value));
          button.type = "button";
          button.setAttribute("aria-label", attackerLabel + " into " + targetLabel + ": " + formatValue(metric, value));
          button.addEventListener("click", () => {
            const uncertainty = cell.uncertainty ? cell.uncertainty[metric] : null;
            const envelope = cell.combatEnvelope ? cell.combatEnvelope[metric] : null;
            const envelopeText = formatEnvelope(metric, envelope);
            const detail = byId("cell-detail");
            if (detail) {
              detail.textContent = [
                attackerLabel + " → " + targetLabel + ": " + formatValue(metric, value),
                cell.confidence + " confidence",
                formatUncertainty(uncertainty),
                envelopeText,
                ...cell.warnings,
              ].filter(Boolean).join(" · ");
            }
          });
          td.append(button);
        } else {
          td.textContent = "—";
        }
        row.append(td);
      }
      tbody.append(row);
    }
    table.append(tbody);
    wrapper.append(table);
    panel.append(wrapper);
    const legend = make("div");
    legend.className = "heat-legend " + (direction === "player-to-opponent" ? "player" : "opponent");
    legend.append(make("span", "0"), make("span"), make("span", metric.includes("probability") ? "100%" : "higher"));
    panel.append(legend);
    return panel;
  }
  function renderHeatmap() {
    const host = byId("heatmaps");
    if (!host) return;
    host.replaceChildren();
    const metric = selected("metric-filter");
    const filtered = cells.filter((cell) =>
      matches(cell.opponent, selected("opponent-filter")) &&
      matches(cell.phase, selected("phase-filter"))
    );
    if (!filtered.length) {
      host.append(make("p", "No cells match these filters."));
      return;
    }
    host.append(
      panel("player-to-opponent", filtered, metric),
      panel("opponent-to-player", filtered, metric),
    );
    const detail = byId("cell-detail");
    if (detail) detail.textContent = "Select any cell for the exact attacker-target value.";
  }
  function renderDeltas() {
    const host = byId("delta-table");
    const deltas = Array.isArray(data.deltas) ? data.deltas : [];
    if (!host) return;
    host.replaceChildren();
    const filtered = deltas.filter((delta) =>
      matches(delta.opponent, selected("opponent-filter")) &&
      matches(delta.phase, selected("phase-filter")) &&
      matches(delta.direction, selected("direction-filter")) &&
      matches(delta.classification, selected("delta-result-filter")) &&
      matches(delta.metric, selected("metric-filter"))
    );
    if (!filtered.length) {
      host.append(make("p", "No before/after deltas match these filters."));
      return;
    }
    const wrapper = make("div");
    wrapper.className = "table-scroll";
    const table = make("table");
    const head = make("thead");
    const row = make("tr");
    ["Opponent", "Phase", "Direction", "Attacker", "Target", "Before", "After", "Change", "Result"].forEach((label) => row.append(make("th", label)));
    head.append(row);
    table.append(head);
    const body = make("tbody");
    for (const delta of filtered) {
      const deltaRow = make("tr");
      [delta.opponent, delta.phase, delta.direction, delta.attackerId, delta.targetId,
        formatValue(delta.metric, delta.before), formatValue(delta.metric, delta.after),
        formatValue(delta.metric, delta.change), delta.classification
      ].forEach((value) => deltaRow.append(make("td", value)));
      body.append(deltaRow);
    }
    table.append(body);
    wrapper.append(table);
    host.append(wrapper);
  }
  document.querySelectorAll("#matchup-filters select").forEach((control) => {
    control.addEventListener("change", () => {
      renderHeatmap();
      renderDeltas();
    });
  });
  renderHeatmap();
  renderDeltas();
})();
</script>`;
}

function reportSections(view: DisplayReport): string {
  const directionalNote = view.points.length === 1 && !view.points[0].matched
    ? `Directional case: ${view.points[0].playerPoints} points versus ${view.points[0].opponentPoints} points; explicitly allowed beyond Tessera's ${displayNumber(view.points[0].tolerancePercent)}% tolerance.`
    : "Points are within the configured Tessera tolerance.";
  return `<section aria-labelledby="matrix-heading"><h2 id="matrix-heading">Combat heat maps and probabilities</h2>
${renderControls(view.cells, view.opponentLabels)}
<p class="meta">Choose one phase and measure. Directions remain separate so values cannot be mixed or overwritten.</p>
<div class="heatmap-grid" id="heatmaps" aria-live="polite"></div>
<p class="cell-detail" id="cell-detail">Select any cell for the exact attacker-target value.</p>
<p class="directional-note">${escapeHtml(directionalNote)}</p>
<noscript><p class="caution">Enable JavaScript to use the interactive heatmap.</p></noscript>
</section>
<section aria-labelledby="points-heading"><h2 id="points-heading">Points match</h2>${renderPoints(
    view.points,
  )}</section>
<section aria-labelledby="findings-heading"><h2 id="findings-heading">Evidence-backed findings</h2>${renderFindings(
    view.findings,
  )}</section>
<section aria-labelledby="changes-heading"><h2 id="changes-heading">Proposed legal changes</h2>
<p class="meta">These candidates are suggestions only. RosterPilot will not apply one without explicit approval.</p>
${renderCandidates(view.candidates)}</section>
<section aria-labelledby="settings-heading"><h2 id="settings-heading">Simulation configuration</h2>${renderPairs(
    view.settings,
    "No visible simulator settings were recorded.",
  )}</section>
<section aria-labelledby="provenance-heading"><h2 id="provenance-heading">Provenance</h2>${renderPairs(
    view.provenance,
    "No provenance was recorded.",
  )}</section>
<section aria-labelledby="warnings-heading"><h2 id="warnings-heading">Warnings</h2>${renderStringList(
    view.warnings,
    "No warnings were recorded.",
  )}</section>
<section aria-labelledby="limitations-heading"><h2 id="limitations-heading">Limitations</h2>${renderStringList(
    view.limitations,
    "No limitations were recorded.",
  )}</section>`;
}

function documentShell(
  title: string,
  hero: string,
  content: string,
  embedded: unknown,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${commonStyles()}
</head>
<body><main>
${hero}
${content}
</main>
<script type="application/json" id="report-data">${serializeForScript(
    embedded,
  )}</script>
${commonScript()}
</body></html>`;
}

export function renderTesseraMatchupReportHtml(
  report: TesseraMatchupReport,
): string {
  const view = normalizeReport(report);
  const hero = `<header class="hero">
<div class="kicker">RosterPilot · Tessera directional analysis</div>
<h1>${escapeHtml(view.title)}</h1>
<p class="meta">Status: ${escapeHtml(view.status)} · Source: ${escapeHtml(
    view.source,
  )} · Generated ${escapeHtml(view.generatedAt)}</p>
<p><span class="badge ${
    view.comparisonClass === "matched" ? "good" : "warn"
  }">${escapeHtml(view.comparisonClass)} points comparison</span></p>
<p class="caution"><strong>Directional combat math only.</strong> This report is not a game win probability.</p>
</header>`;
  return documentShell(
    view.title,
    hero,
    reportSections(view),
    {
      cells: view.cells,
      playerLabel: view.playerLabel,
      opponentLabels: view.opponentLabels,
    },
  );
}

function revisionDeltas(
  report: TesseraRevisionComparisonReport,
): DisplayRevisionDelta[] {
  return report.deltas.map((delta) => ({
    opponent: safeText(delta.opponentName),
    phase: safeText(delta.phase),
    metric: safeText(delta.metric),
    direction: safeText(delta.direction),
    attackerId: safeText(delta.attackerInstanceId),
    targetId: safeText(delta.targetInstanceId),
    before: safeNumber(delta.before),
    after: safeNumber(delta.after),
    change: safeNumber(delta.change),
    classification: safeText(delta.classification),
  }));
}

function revisionControls(
  cells: DisplayCell[],
  deltas: DisplayRevisionDelta[],
): string {
  const metrics = unique([
    ...deltas.map((delta) => delta.metric),
    ...(Object.keys(metricLabels) as DisplayMetric[]).filter((metric) =>
      cells.some((cell) => cell.values[metric] !== null),
    ),
  ]);
  return `<form class="filters" id="matchup-filters">
<label>Opponent<select id="opponent-filter">${selectOptions([
    ...deltas.map((delta) => delta.opponent),
    ...cells.map((cell) => cell.opponent),
  ], undefined, false)}</select></label>
<label>Phase<select id="phase-filter">${selectOptions([
    ...deltas.map((delta) => delta.phase),
    ...cells.map((cell) => cell.phase),
  ], { shooting: "Shooting", fight: "Fight" }, false, "fight")}</select></label>
<label>Metric<select id="metric-filter">${selectOptions(
    metrics,
    metricLabels,
    false,
  )}</select></label>
<label>Direction<select id="direction-filter">${selectOptions([
    ...deltas.map((delta) => delta.direction),
    ...cells.map((cell) => cell.direction),
  ])}</select></label>
<label>Delta result<select id="delta-result-filter">${selectOptions(
    deltas.map((delta) => delta.classification),
  )}</select></label>
</form>`;
}

function revisionAggregateTable(
  report: TesseraRevisionComparisonReport,
): string {
  const aggregates = report.aggregates ?? [];
  if (aggregates.length === 0) {
    return "";
  }
  return `<section aria-labelledby="aggregate-heading"><h2 id="aggregate-heading">Trusted roster aggregates</h2>
<p>Each row gives equal weight to every applicable frozen scenario for that metric and direction. Positive directional change favors the revised player roster.</p>
<div class="table-scroll"><table>
<thead><tr><th>Metric</th><th>Direction</th><th>Before</th><th>After</th><th>Directional change</th><th>Threshold</th><th>Scenarios</th><th>Result</th></tr></thead>
<tbody>${aggregates
    .map(
      (aggregate) => `<tr>
<td>${escapeHtml(safeText(aggregate.metric))}</td>
<td>${escapeHtml(safeText(aggregate.direction))}</td>
<td>${escapeHtml(displayNumber(safeNumber(aggregate.before)))}</td>
<td>${escapeHtml(displayNumber(safeNumber(aggregate.after)))}</td>
<td>${escapeHtml(displayNumber(safeNumber(aggregate.directionalChange)))}</td>
<td>${escapeHtml(displayNumber(safeNumber(aggregate.materialityThreshold)))}</td>
<td>${escapeHtml(
        displayNumber(safeNumber(aggregate.applicableScenarios)),
      )}/${escapeHtml(
        displayNumber(safeNumber(aggregate.expectedScenarios)),
      )}</td>
<td><span class="badge ${escapeHtml(
        safeText(aggregate.classification),
      )}">${escapeHtml(
        safeText(aggregate.classification),
      )}</span></td>
</tr>`,
    )
    .join("")}</tbody></table></div></section>`;
}

export function renderTesseraRevisionComparisonHtml(
  report: TesseraRevisionComparisonReport,
): string {
  const revised = report.revisedReports[0];
  const view = revised
    ? normalizeReport(revised)
    : {
        title: "Revised roster",
        playerLabel: "Player",
        opponentLabels: {},
        status: "partial",
        source: "handoff-only",
        generatedAt: safeText(report.generatedAt),
        comparisonClass: "unknown",
        points: [],
        settings: [],
        provenance: [],
        cells: [],
        findings: [],
        candidates: [],
        warnings: [],
        limitations: [],
      };
  const deltas = revisionDeltas(report);
  const title = "Roster revision comparison";
  const hero = `<header class="hero">
<div class="kicker">RosterPilot · Tessera revision analysis</div>
<h1>${title}</h1>
<p class="meta">Generated ${escapeHtml(safeText(report.generatedAt))} · Run ${escapeHtml(
    safeText(report.runId),
  )}</p>
<p class="caution"><strong>Directional combat math only.</strong> Improvements and regressions are not changes in game win probability.</p>
</header>`;
  const aggregateCounts = report.summary.aggregateCounts;
  const summary = `<section aria-labelledby="delta-summary-heading"><h2 id="delta-summary-heading">Delta summary</h2>
${aggregateCounts ? `<p><strong>Roster conclusion:</strong> ${escapeHtml(
    safeText(report.summary.conclusion, "unchanged"),
  )}. This conclusion uses trusted roster aggregates; cell deltas do not vote.</p>
<div class="delta-grid">
<div class="delta-stat improved"><strong>${aggregateCounts.improved}</strong>Aggregate improved</div>
<div class="delta-stat worsened"><strong>${aggregateCounts.worsened}</strong>Aggregate worsened</div>
<div class="delta-stat"><strong>${aggregateCounts.unchanged}</strong>Aggregate unchanged</div>
<div class="delta-stat ambiguous"><strong>${aggregateCounts.ambiguous}</strong>Aggregate ambiguous</div>
</div>
<h3>Cell-level drill-down</h3>` : ""}
<div class="delta-grid">
<div class="delta-stat improved"><strong>${report.summary.improved}</strong>Improved</div>
<div class="delta-stat worsened"><strong>${report.summary.worsened}</strong>Worsened</div>
<div class="delta-stat"><strong>${report.summary.unchanged}</strong>Unchanged</div>
<div class="delta-stat ambiguous"><strong>${report.summary.ambiguous}</strong>Ambiguous</div>
</div></section>
${revisionAggregateTable(report)}
<section id="before" aria-labelledby="before-heading"><h2 id="before-heading">Before</h2>
<p>Baseline run <code>${escapeHtml(safeText(report.baselineRunId))}</code> from <code>${escapeHtml(
    safeText(report.baselineReportPath).split(/[\\/]/).pop() ?? "baseline report",
  )}</code>.</p></section>
<section id="after" aria-labelledby="after-heading"><h2 id="after-heading">After</h2>
<p>Revised roster fingerprint: <code>${escapeHtml(
    safeText(report.revisedRosterFingerprint),
  )}</code>. ${report.revisedReports.length} revised matchup report${
    report.revisedReports.length === 1 ? "" : "s"
  } recorded.</p></section>
<section aria-labelledby="delta-heading"><h2 id="delta-heading">Before/after deltas</h2>
${revisionControls(view.cells, deltas)}
<div id="delta-table" aria-live="polite"></div>
<noscript><p class="caution">Enable JavaScript to inspect filtered deltas.</p></noscript>
</section>
<section aria-labelledby="matrix-heading"><h2 id="matrix-heading">Revised matchup heat maps</h2>
<div class="heatmap-grid" id="heatmaps" aria-live="polite"></div>
<p class="cell-detail" id="cell-detail">Select any cell for the exact attacker-target value.</p></section>
<section aria-labelledby="findings-heading"><h2 id="findings-heading">Revised findings</h2>${renderFindings(
    view.findings,
  )}</section>
<section aria-labelledby="settings-heading"><h2 id="settings-heading">Simulation configuration</h2>${renderPairs(
    view.settings,
    "No visible simulator settings were recorded.",
  )}</section>
<section aria-labelledby="provenance-heading"><h2 id="provenance-heading">Provenance</h2>${renderPairs(
    [
      { label: "Revision run ID", value: safeText(report.runId) },
      {
        label: "Baseline run ID",
        value: safeText(report.baselineRunId),
      },
      ...view.provenance,
    ],
    "No provenance was recorded.",
  )}</section>
<section aria-labelledby="warnings-heading"><h2 id="warnings-heading">Warnings</h2>${renderStringList(
    unique([
      ...report.warnings.map((warning) => safeText(warning)),
      ...view.warnings,
    ]),
    "No warnings were recorded.",
  )}</section>
<section aria-labelledby="limitations-heading"><h2 id="limitations-heading">Limitations</h2>${renderStringList(
    unique([
      ...report.limitations.map((limitation) => safeText(limitation)),
      ...view.limitations,
    ]),
    "No limitations were recorded.",
  )}</section>`;
  return documentShell(title, hero, `${summary}`, {
    cells: view.cells,
    deltas,
    playerLabel: view.playerLabel,
    opponentLabels: view.opponentLabels,
  });
}
