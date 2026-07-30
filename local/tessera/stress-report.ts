import type {
  TesseraStressRevisionReport,
  TesseraStressTestReport,
} from "../../lib/rosterpilot/types";

type UnknownRecord = Record<string, unknown>;

type DisplayPair = {
  label: string;
  value: string;
};

type PortfolioItemView = {
  itemId: string;
  rosterName: string;
  template: string;
  posture: string;
  composition: string;
  points: number | null;
  weight: number | null;
  status: string;
  stages: string;
  representative: string;
  omissionReason: string;
};

type RangeView = {
  metric: string;
  worst: number | null;
  median: number | null;
  mean: number | null;
  best: number | null;
  tail: number | null;
};

type CoveragePointView = {
  itemId: string;
  label: string;
  phase: string;
  coverage: number | null;
  exposure: number | null;
  margin: number | null;
  confidence: string;
};

type RepresentativeView = {
  itemId: string;
  label: string;
  role: string;
  reason: string;
  status: string;
};

type MissionDimensionView = {
  dimension: string;
  band: string;
  value: string;
  confidence: string;
  evidence: string;
};

type FindingView = {
  kind: string;
  confidence: string;
  summary: string;
  support: string;
};

type UnitRobustnessView = {
  instanceId: string;
  label: string;
  points: number | null;
  answerBreadth: number | null;
  exposedWeight: number | null;
  support: string;
};

type ChangeView = {
  title: string;
  rationale: string;
  effect: string;
  support: string;
};

type DeltaView = {
  label: string;
  before: number | null;
  after: number | null;
  change: number | null;
  classification: string;
  context: string;
};

type StageScenarioView = {
  phase: string;
  metric: string;
  direction: string;
  iterations: string;
  settings: DisplayPair[];
};

type StageProxyView = {
  templateId: string;
  iterations: string;
  settings: DisplayPair[];
  scenarios: StageScenarioView[];
};

type StageProvenanceView = {
  stage: string;
  analysisMode: string;
  phases: string;
  metrics: string;
  directions: string;
  iterations: string;
  settings: DisplayPair[];
  proxyRuns: StageProxyView[];
};

type FrozenArtifactView = {
  templateId: string;
  rosterFingerprint: string;
  sha256: string;
  filename: string;
};

type StressTestView = {
  title: string;
  runId: string;
  generatedAt: string;
  status: string;
  statusExplanation: string;
  confidenceSummary: DisplayPair[];
  integrity: DisplayPair[];
  integrityIssues: string[];
  recovery: DisplayPair[];
  recoveryActions: string[];
  opponentFaction: string;
  suite: string;
  strategy: string;
  suiteCoverage: DisplayPair[];
  items: PortfolioItemView[];
  ranges: RangeView[];
  coveragePoints: CoveragePointView[];
  representatives: RepresentativeView[];
  phaseDependence: DisplayPair[];
  missionOverall: string;
  missionDimensions: MissionDimensionView[];
  units: UnitRobustnessView[];
  findings: FindingView[];
  changes: ChangeView[];
  provenance: DisplayPair[];
  stageProvenance: StageProvenanceView[];
  frozenArtifacts: FrozenArtifactView[];
  revisionMateriality: number;
  warnings: string[];
  limitations: string[];
};

const sensitiveKey =
  /(?:password|secret|token|cookie|credential|licen[cs]e.?key|premium.?key|authorization|browser.?storage|browser.?profile|profile.?directory|local.?storage|session.?storage)/i;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function at(source: unknown, path: string): unknown {
  let value = source;
  for (const part of path.split(".")) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[part];
  }
  return value;
}

function first(source: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const value = at(source, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function safeText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    if (
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return String(value);
    }
    return fallback;
  }
  return value.replace(
    /((?:password|secret|token|cookie|credential|licen[cs]e|premium)\s*(?:key)?\s*[:=]\s*)\S+/gi,
    "$1[redacted]",
  );
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberAt(source: unknown, paths: string[]): number | null {
  return finiteNumber(first(source, paths));
}

function textAt(
  source: unknown,
  paths: string[],
  fallback = "",
): string {
  return safeText(first(source, paths), fallback);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => safeText(item)).filter(Boolean)
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayNumber(value: number | null): string {
  return value === null
    ? "Not available"
    : new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 2,
      }).format(value);
}

function displayPercent(value: number | null): string {
  if (value === null) {
    return "Not available";
  }
  const normalized = Math.abs(value) <= 1 ? value * 100 : value;
  return `${displayNumber(normalized)}%`;
}

function displayValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return displayNumber(value);
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => safeText(entry)).filter(Boolean).join(", ");
  }
  return safeText(value, "Not available");
}

function basename(value: unknown, fallback = "Not recorded"): string {
  const clean = safeText(value);
  if (!clean) {
    return fallback;
  }
  return clean.split(/[\\/]/).filter(Boolean).pop() ?? fallback;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function objectPairs(
  value: unknown,
  ignored = new Set<string>(),
): DisplayPair[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    if (
      ignored.has(key) ||
      sensitiveKey.test(key) ||
      child === null ||
      child === undefined ||
      typeof child === "object"
    ) {
      return [];
    }
    return [{ label: humanize(key), value: displayValue(child) }];
  });
}

function settingValue(value: unknown): string {
  const clean = safeText(value, displayValue(value));
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(clean)) {
    return basename(clean);
  }
  return clean;
}

function settingsPairs(value: unknown): DisplayPair[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, setting]) => {
    if (
      sensitiveKey.test(key) ||
      setting === null ||
      setting === undefined ||
      typeof setting === "object"
    ) {
      return [];
    }
    return [{
      label: humanize(key),
      value: settingValue(setting),
    }];
  });
}

function numberArrayText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "Not recorded";
  }
  const numbers = value.filter(
    (entry): entry is number =>
      typeof entry === "number" && Number.isFinite(entry),
  );
  return numbers.length ? numbers.join(", ") : "Not recorded";
}

function normalizeStageProvenance(
  report: UnknownRecord,
): StageProvenanceView[] {
  const provenance = isRecord(report.stageProvenance)
    ? report.stageProvenance
    : {};
  return [
    ["screening", provenance.screening],
    ["deep dive", provenance.deepDive],
  ].flatMap(([stage, value]) => {
    if (!isRecord(value)) {
      return [];
    }
    return [{
      stage: humanize(String(stage)),
      analysisMode: textAt(value, ["analysisMode"], "Not recorded"),
      phases:
        stringArray(value.phases).map(humanize).join(", ") ||
        "Not recorded",
      metrics:
        stringArray(value.metrics).map(humanize).join(", ") ||
        "Not recorded",
      directions:
        stringArray(value.directions).map(humanize).join(", ") ||
        "Not recorded",
      iterations: numberArrayText(value.iterations),
      settings: settingsPairs(value.settings),
      proxyRuns: records(value.proxyRuns).map((run, index) => ({
        templateId: textAt(
          run,
          ["templateId"],
          `Proxy ${index + 1}`,
        ),
        iterations: numberArrayText(run.iterations),
        settings: settingsPairs(run.settings),
        scenarios: records(run.scenarios).map((scenario) => ({
          phase: humanize(textAt(scenario, ["phase"], "Not recorded")),
          metric: humanize(
            textAt(scenario, ["metric"], "Not recorded"),
          ),
          direction: humanize(
            textAt(scenario, ["direction"], "Not recorded"),
          ),
          iterations: String(
            finiteNumber(scenario.iterations) ?? "Not recorded",
          ),
          settings: settingsPairs(scenario.settings),
        })),
      })),
    }];
  });
}

function normalizeFrozenArtifacts(
  report: UnknownRecord,
): FrozenArtifactView[] {
  return records(report.frozenOpponentArtifacts).map(
    (artifact, index) => ({
      templateId: textAt(
        artifact,
        ["templateId"],
        `Proxy ${index + 1}`,
      ),
      rosterFingerprint: textAt(
        artifact,
        ["rosterFingerprint"],
        "Not recorded",
      ),
      sha256: textAt(artifact, ["sha256"], "Not recorded"),
      filename: basename(artifact.enrichedRoszPath),
    }),
  );
}

function normalizePortfolioItems(report: UnknownRecord): PortfolioItemView[] {
  const portfolio = isRecord(report.portfolio) ? report.portfolio : {};
  const rawItems = records(
    first(portfolio, ["items", "members", "opponents", "entries"]),
  );
  const representativeIds = new Set([
    ...stringArray(
      first(report, [
        "representativeItemIds",
        "deepDiveReport.representativeItemIds",
        "robustness.representativeItemIds",
      ]),
    ),
    ...records(report.representatives).map((representative) =>
      textAt(representative, ["templateId", "itemId"]),
    ),
  ]);
  const samples = records(first(report, ["robustness.samples"]));
  return rawItems.map((item, index) => {
    const itemId = textAt(
      item,
      ["itemId", "id", "templateId", "fingerprint"],
      `portfolio-${index + 1}`,
    );
    const representativeRole = textAt(item, [
      "representativeRole",
      "selectionRole",
      "role",
    ]) || textAt(
      records(report.representatives).find(
        (representative) =>
          textAt(representative, ["templateId", "itemId"]) === itemId,
      ),
      ["kind"],
    );
    const sample = samples.find(
      (candidate) => textAt(candidate, ["templateId", "itemId"]) === itemId,
    );
    const screenStatus =
      textAt(item, [
        "screening.status",
        "screenStatus",
        "stages.screening",
      ]) || textAt(sample, ["status"]);
    const deepStatus =
      textAt(item, [
        "deepDive.status",
        "deepStatus",
        "stages.deepDive",
      ]) ||
      (representativeIds.has(itemId)
        ? textAt(report, ["deepDiveReport.status"], "selected")
        : "");
    const screenStatusDisplay =
      screenStatus === "confident"
        ? "quantitative coverage complete"
        : screenStatus;
    return {
      itemId,
      rosterName: textAt(
        item,
        ["rosterName", "roster.name", "name", "label"],
        humanize(itemId),
      ),
      template: textAt(item, ["templateId", "template", "archetype"], "Unknown"),
      posture: textAt(
        item,
        ["posture", "traits.posture", "composition.posture"],
        "Unknown",
      ),
      composition: [
        ...stringArray(
          first(item, [
            "compositionTraits",
            "achievedTraits",
            "traits.composition",
          ]),
        ),
        textAt(item, ["composition", "compositionClass", "composition.class"]),
        numberAt(item, ["traits.hordePointsPercent"]) === null
          ? ""
          : `${displayPercent(
              numberAt(item, ["traits.hordePointsPercent"]),
            )} horde points`,
        numberAt(item, ["traits.eliteHeavyPointsPercent"]) === null
          ? ""
          : `${displayPercent(
              numberAt(item, ["traits.eliteHeavyPointsPercent"]),
            )} elite/heavy points`,
        numberAt(item, ["traits.infantryPointsPercent"]) === null
          ? ""
          : `${displayPercent(
              numberAt(item, ["traits.infantryPointsPercent"]),
            )} Infantry points`,
        (
          numberAt(item, ["traits.vehiclePointsPercent"]) === null &&
          numberAt(item, ["traits.monsterPointsPercent"]) === null
        )
          ? ""
          : `${displayPercent(
              (numberAt(item, ["traits.vehiclePointsPercent"]) ?? 0) +
                (numberAt(item, ["traits.monsterPointsPercent"]) ?? 0),
            )} Vehicle/Monster points`,
        numberAt(item, ["traits.unitConcentrationPercent"]) === null
          ? ""
          : `${displayPercent(
              numberAt(item, ["traits.unitConcentrationPercent"]),
            )} largest-unit concentration`,
      ]
        .filter(Boolean)
        .join(", ") || "Not classified",
      points: numberAt(item, [
        "points",
        "totalPoints",
        "roster.totalPoints",
        "summary.totalPoints",
      ]),
      weight:
        numberAt(item, ["weight", "portfolioWeight"]) ??
        numberAt(sample, ["weight"]),
      status: textAt(
        item,
        ["status", "generationStatus", "validation.status"],
        "unknown",
      ),
      stages: [
        screenStatusDisplay && `Screen: ${screenStatusDisplay}`,
        deepStatus && `Deep: ${deepStatus}`,
      ]
        .filter(Boolean)
        .join(" · ") || "Not started",
      representative:
        representativeRole ||
        (representativeIds.has(itemId) ? "Selected" : "No"),
      omissionReason: textAt(item, [
        "omissionReason",
        "unavailableReason",
        "failureReason",
      ]),
    };
  });
}

function suiteCoveragePairs(
  report: UnknownRecord,
  items: PortfolioItemView[],
): DisplayPair[] {
  const counts = first(report, ["portfolio.counts", "portfolio.coverage"]);
  const requested =
    numberAt(counts, ["requested", "intended", "total"]) ??
    numberAt(report, ["portfolio.requestedCount", "portfolio.intendedCount"]) ??
    items.length;
  const screenComplete =
    numberAt(counts, ["screenComplete", "screened", "usable"]) ??
    numberAt(report, ["screeningReport.completedCount"]) ??
    (records(first(report, ["robustness.samples"])).filter(
      (sample) => textAt(sample, ["status"]) !== "missing",
    ).length ||
      items.filter((item) => /complete/i.test(item.stages)).length);
  const deepComplete =
    numberAt(counts, ["deepComplete", "deepDives"]) ??
    numberAt(report, ["deepDiveReport.completedCount"]) ??
    (records(first(report, ["representatives"])).length ||
      items.filter((item) => /Deep: complete/i.test(item.stages)).length);
  const omitted =
    numberAt(counts, ["omitted", "unavailable", "failed"]) ??
    items.filter((item) => item.omissionReason).length;
  const representedPostures =
    stringArray(first(counts, ["representedPostures"])).length ||
    unique(
      items
        .filter((item) => item.status === "ready")
        .map((item) => item.posture),
    ).filter((posture) => posture !== "Unknown").length;
  return [
    { label: "Intended opponents", value: String(requested) },
    { label: "Screen-complete opponents", value: String(screenComplete) },
    { label: "Deep-dive opponents", value: String(deepComplete) },
    { label: "Unavailable or omitted", value: String(omitted) },
    { label: "Postures represented", value: String(representedPostures) },
    ...objectPairs(counts, new Set([
      "requested",
      "intended",
      "total",
      "ready",
      "screenComplete",
      "screened",
      "usable",
      "deepComplete",
      "deepDives",
      "omitted",
      "unavailable",
      "failed",
    ])),
  ];
}

function rangeFromRecord(metric: string, value: UnknownRecord): RangeView | null {
  const worst = numberAt(value, ["worst", "minimum", "min"]);
  const median = numberAt(value, ["median", "p50"]);
  const mean = numberAt(value, ["mean", "average"]);
  const best = numberAt(value, ["best", "maximum", "max"]);
  const tail = numberAt(value, [
    "lowerTail",
    "upperTail",
    "worst20PercentMean",
    "tailMean",
  ]);
  if ([worst, median, mean, best, tail].every((entry) => entry === null)) {
    return null;
  }
  return { metric: humanize(metric), worst, median, mean, best, tail };
}

function collectRanges(value: unknown, prefix = ""): RangeView[] {
  if (Array.isArray(value)) {
    return records(value).flatMap((entry, index) => {
      const metric = textAt(
        entry,
        ["metric", "name", "label", "key"],
        `${prefix || "Metric"} ${index + 1}`,
      );
      return rangeFromRecord(metric, entry) ?? [];
    });
  }
  if (!isRecord(value)) {
    return [];
  }
  const own = rangeFromRecord(prefix || "Overall", value);
  if (own) {
    return [own];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === "object" && child !== null
      ? collectRanges(child, prefix ? `${prefix} · ${key}` : key)
      : [],
  );
}

function normalizeCoveragePoints(report: UnknownRecord): CoveragePointView[] {
  const samples = records(
    first(report, [
      "robustness.samples",
      "screeningReport.samples",
      "screeningReport.results",
    ]),
  );
  return samples.map((sample, index) => {
    const coverage = numberAt(sample, [
      "offensiveCoverage",
      "coverage",
      "combined.offensiveCoverage",
      "metrics.combined.offensiveCoverage",
    ]);
    const exposure = numberAt(sample, [
      "threatExposure",
      "exposure",
      "combined.threatExposure",
      "metrics.combined.threatExposure",
    ]);
    return {
      itemId: textAt(
        sample,
        ["itemId", "portfolioItemId", "opponentId", "templateId"],
        `sample-${index + 1}`,
      ),
      label: textAt(
        sample,
        ["opponentName", "rosterName", "label", "templateId"],
        `Opponent ${index + 1}`,
      ),
      phase: textAt(sample, ["phase"], "combined"),
      coverage,
      exposure,
      margin:
        numberAt(sample, ["coverageMargin", "margin"]) ??
        (coverage !== null && exposure !== null ? coverage - exposure : null),
      confidence: textAt(
        sample,
        [
          "evidenceConfidence",
          "confidence",
          "coverageConfidence",
        ],
        "review",
      ),
    };
  });
}

function normalizeRepresentatives(
  report: UnknownRecord,
  items: PortfolioItemView[],
): RepresentativeView[] {
  const selected = records(
    first(report, [
      "deepDiveReport.representatives",
      "robustness.representatives",
      "representatives",
    ]),
  );
  if (selected.length) {
    return selected.map((entry, index) => {
      const itemId = textAt(
        entry,
        ["itemId", "portfolioItemId", "id", "templateId"],
        `representative-${index + 1}`,
      );
      const item = items.find((candidate) => candidate.itemId === itemId);
      return {
        itemId,
        label: textAt(
          entry,
          ["label", "rosterName", "opponentName"],
          item?.rosterName ?? humanize(itemId),
        ),
        role: textAt(
          entry,
          ["role", "selectionRole", "kind"],
          item?.representative ?? "Selected",
        ),
        reason: textAt(
          entry,
          ["reason", "selectionReason", "rationale"],
        ),
        status: textAt(
          entry,
          ["status", "deepDiveStatus"],
          item?.stages ?? "unknown",
        ),
      };
    });
  }
  const representativeIds = stringArray(report.representativeItemIds);
  return representativeIds.map((itemId, index) => {
    const item = items.find((candidate) => candidate.itemId === itemId);
    return {
      itemId,
      label: item?.rosterName ?? humanize(itemId),
      role: item?.representative || `Representative ${index + 1}`,
      reason: "",
      status: item?.stages ?? "unknown",
    };
  });
}

function normalizeMission(report: UnknownRecord): {
  overall: string;
  dimensions: MissionDimensionView[];
} {
  const readiness = first(report, ["missionReadiness", "robustness.missionReadiness"]);
  if (!isRecord(readiness)) {
    return { overall: "Not available", dimensions: [] };
  }
  const rawDimensions = first(readiness, [
    "dimensions",
    "scores",
    "readinessDimensions",
  ]);
  const dimensionEntries: Array<[string, UnknownRecord]> = Array.isArray(rawDimensions)
    ? records(rawDimensions).map((entry, index) => [
        textAt(entry, ["dimension", "id", "name"], `dimension-${index + 1}`),
        entry,
      ])
    : isRecord(rawDimensions)
      ? Object.entries(rawDimensions)
          .filter((entry): entry is [string, UnknownRecord] => isRecord(entry[1]))
      : [];
  return {
    overall: textAt(
      readiness,
      ["overall", "overallBand", "status", "classification"],
      "Not classified",
    ),
    dimensions: dimensionEntries.map(([key, dimension]) => {
      const metrics = records(dimension.metrics);
      const metricSummary = metrics
        .map((metric) => {
          const label = textAt(metric, ["label", "id"], "Metric");
          const normalized = numberAt(metric, ["normalizedValue"]);
          const raw = numberAt(metric, ["value"]);
          return `${label}: ${
            normalized === null ? displayNumber(raw) : displayNumber(normalized)
          }`;
        })
        .join("; ");
      return {
        dimension: textAt(dimension, ["label", "name"], humanize(key)),
        band: textAt(
          dimension,
          ["band", "status", "classification"],
          "unknown",
        ),
        value:
          metricSummary ||
          displayValue(
            first(dimension, ["value", "score", "normalizedValue", "count"]),
          ),
        confidence: textAt(dimension, ["confidence"], "review"),
        evidence:
          stringArray(
            first(dimension, ["evidence", "sources", "providers"]),
          ).join("; ") ||
          textAt(dimension, ["detail", "summary", "reason"]),
      };
    }),
  };
}

function normalizeFindings(report: UnknownRecord): FindingView[] {
  const findings = records(
    first(report, ["robustness.findings", "findings", "crossProxyFindings"]),
  );
  return findings.map((finding) => {
    const supportingItems = stringArray(
      first(finding, [
        "supportingItemIds",
        "portfolioItemIds",
        "evidenceItemIds",
        "templateIds",
      ]),
    );
    const weight = numberAt(finding, [
      "usablePortfolioWeight",
      "supportingWeight",
      "weight",
    ]);
    return {
      kind: textAt(finding, ["kind", "classification", "type"], "finding"),
      confidence: textAt(finding, ["confidence"], "review"),
      summary: textAt(finding, ["summary", "title", "message"], "No summary"),
      support: [
        supportingItems.length
          ? `${supportingItems.length} supporting opponents`
          : "",
        weight === null ? "" : `${displayPercent(weight)} usable weight`,
        textAt(finding, ["support", "evidenceSummary"]),
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

function normalizeUnitRobustness(report: UnknownRecord): UnitRobustnessView[] {
  return records(first(report, ["robustness.units", "unitRobustness"])).map(
    (unit, index) => ({
      instanceId: textAt(
        unit,
        ["instanceId", "selectionId", "id"],
        `unit-${index + 1}`,
      ),
      label: textAt(unit, ["label", "name"], `Unit ${index + 1}`),
      points: numberAt(unit, ["points"]),
      answerBreadth: numberAt(unit, ["answerBreadth", "coverageBreadth"]),
      exposedWeight: numberAt(unit, ["exposedWeight", "exposureWeight"]),
      support: stringArray(
        first(unit, ["supportingTemplateIds", "supportingItemIds"]),
      ).join(", "),
    }),
  );
}

function normalizeChanges(report: UnknownRecord): ChangeView[] {
  return records(report.changeCandidates).map((change) => ({
    title: textAt(change, ["title", "name"], "Roster change"),
    rationale: textAt(change, ["rationale", "summary", "reason"]),
    effect: [
      numberAt(change, ["beforePoints"]) === null
        ? ""
        : `${displayNumber(numberAt(change, ["beforePoints"]))} → ${displayNumber(
            numberAt(change, ["afterPoints"]),
          )} points`,
      textAt(change, ["classification", "effect", "result"]),
    ]
      .filter(Boolean)
      .join(" · "),
    support:
      stringArray(
        first(change, [
          "evidenceFindingIds",
          "supportingItemIds",
          "evidenceItemIds",
        ]),
      ).join(", ") ||
      textAt(change, ["support", "evidenceSummary"]),
  }));
}

function normalizeStressTest(report: TesseraStressTestReport): StressTestView {
  const root = report as unknown as UnknownRecord;
  const items = normalizePortfolioItems(root);
  const mission = normalizeMission(root);
  const aggregates = first(root, [
    "robustness.aggregates",
    "robustness.ranges",
    "screeningReport.aggregates",
  ]);
  const playerName = textAt(
    root,
    ["player.rosterName", "player.summary.rosterName", "player.name"],
    "Roster",
  );
  const suite = textAt(root, ["suite.id", "suite.name", "suite"], "Unknown suite");
  const strategy = textAt(
    root,
    [
      "analysisStrategy.mode",
      "analysisStrategy",
      "configuration.analysisStrategy",
      "configuration.analysis",
    ],
    "Unknown",
  );
  const phaseDependence = first(root, [
    "robustness.phaseDependence",
    "phaseDependence",
  ]);
  const sourceData = first(root, [
    "portfolio.provenance",
    "portfolio.sourceData",
    "provenance",
    "player.sourceData",
  ]);
  const legacyCoverage = textAt(
    root,
    ["robustness.confidence"],
    "not recorded",
  );
  const coverageCompleteness = textAt(
    root,
    ["robustness.coverageCompleteness"],
    legacyCoverage === "review" ? "degraded" : legacyCoverage,
  );
  const evidenceConfidence = textAt(
    root,
    ["robustness.evidenceConfidence"],
    "not recorded",
  );
  const rawStatusExplanation = textAt(root, ["statusExplanation"]);
  const statusExplanation =
    evidenceConfidence !== "not recorded"
      ? rawStatusExplanation.replace(
          /\bconfident\b/gi,
          "quantitatively complete",
        )
      : rawStatusExplanation;
  return {
    title: `${playerName} faction stress test`,
    runId: textAt(root, ["runId"]),
    generatedAt: textAt(root, ["generatedAt"]),
    status: textAt(root, ["status"], "unknown"),
    statusExplanation,
    confidenceSummary: [
      {
        label: "Quantitative coverage completeness",
        value: coverageCompleteness,
      },
      {
        label: "Evidence confidence",
        value: evidenceConfidence,
      },
    ],
    integrity: objectPairs(
      first(root, ["integrity"]),
      new Set(["issues"]),
    ),
    integrityIssues: records(first(root, ["integrity.issues"])).map(
      (entry) =>
        `[${textAt(entry, ["code"], "TESSERA_INTEGRITY")}] ${textAt(
          entry,
          ["message"],
          "Simulation integrity requires review.",
        )}`,
    ),
    recovery: objectPairs(
      first(root, ["recovery"]),
      new Set([
        "nextActions",
        "exhaustedTemplates",
      ]),
    ),
    recoveryActions: [
      ...stringArray(first(root, ["recovery.exhaustedTemplates"])).map(
        (entry) => `Retry budget exhausted: ${entry}`,
      ),
      ...stringArray(first(root, ["recovery.nextActions"])),
    ],
    opponentFaction: textAt(
      root,
      ["opponentFactionName", "opponentFactionId"],
      "Unknown faction",
    ),
    suite,
    strategy,
    suiteCoverage: suiteCoveragePairs(root, items),
    items,
    ranges: collectRanges(aggregates ?? root.robustness),
    coveragePoints: normalizeCoveragePoints(root),
    representatives: normalizeRepresentatives(root, items),
    phaseDependence: Array.isArray(phaseDependence)
      ? records(phaseDependence).flatMap((entry, index) =>
          objectPairs(entry).map((pair) => ({
            label: `${textAt(entry, ["label", "phase"], `Comparison ${index + 1}`)} · ${pair.label}`,
            value: pair.value,
          })),
        )
      : objectPairs(phaseDependence),
    missionOverall: mission.overall,
    missionDimensions: mission.dimensions,
    units: normalizeUnitRobustness(root),
    findings: normalizeFindings(root),
    changes: normalizeChanges(root),
    provenance: [
      { label: "Run ID", value: textAt(root, ["runId"], "Not recorded") },
      {
        label: "Schema",
        value: `${textAt(root, ["reportKind"], "stress-test")} v${textAt(
          root,
          ["schemaVersion"],
          "?",
        )}`,
      },
      { label: "Generated", value: textAt(root, ["generatedAt"], "Not recorded") },
      { label: "Opponent faction", value: textAt(root, ["opponentFactionId"], "Unknown") },
      { label: "Suite", value: suite },
      { label: "Analysis strategy", value: strategy },
      {
        label: "Portfolio SHA-256",
        value: textAt(
          root,
          ["portfolioSha256", "portfolio.fingerprint"],
          "Not recorded",
        ),
      },
      {
        label: "Player fingerprint",
        value: textAt(root, ["player.fingerprint"], "Not recorded"),
      },
      {
        label: "Generator version",
        value: textAt(root, ["portfolio.generatorVersion"], "Not recorded"),
      },
      {
        label: "Rules release",
        value: textAt(
          root,
          ["portfolio.sourceData.releaseId"],
          "Not recorded",
        ),
      },
      {
        label: "BSData commit",
        value: textAt(
          root,
          ["portfolio.sourceData.newRecruit.commit"],
          "Not recorded",
        ),
      },
      {
        label: "Revision materiality",
        value: displayPercent(
          numberAt(root, ["configuration.revisionMateriality"]) ?? 0.01,
        ),
      },
      ...objectPairs(sourceData),
    ],
    stageProvenance: normalizeStageProvenance(root),
    frozenArtifacts: normalizeFrozenArtifacts(root),
    revisionMateriality:
      numberAt(root, ["configuration.revisionMateriality"]) ?? 0.01,
    warnings: unique(stringArray(root.warnings)),
    limitations: unique(stringArray(root.limitations)),
  };
}

function normalizeDelta(value: UnknownRecord, index: number): DeltaView {
  const before = numberAt(value, ["before", "baseline", "baselineValue"]);
  const after = numberAt(value, ["after", "revised", "revisedValue"]);
  return {
    label: textAt(
      value,
      ["label", "metric", "itemId", "portfolioItemId", "dimension"],
      `Delta ${index + 1}`,
    ),
    before,
    after,
    change:
      numberAt(value, ["change", "delta"]) ??
      (before !== null && after !== null ? after - before : null),
    classification: textAt(
      value,
      ["classification", "status", "result"],
      "review",
    ),
    context: [
      textAt(value, ["phase"]),
      textAt(value, ["direction"]),
      textAt(value, ["opponentName", "rosterName"]),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function normalizeDeltas(value: unknown): DeltaView[] {
  if (Array.isArray(value)) {
    return records(value).map(normalizeDelta);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child], index) => {
    if (!isRecord(child)) {
      return [];
    }
    return [
      normalizeDelta(
        {
          ...child,
          label: child.label ?? humanize(key),
        },
        index,
      ),
    ];
  });
}

function classifyChange(
  change: number | null,
  lowerIsBetter = false,
  materiality = 0.01,
): string {
  if (change === null) {
    return "ambiguous";
  }
  if (Math.abs(change) < materiality) {
    return "unchanged";
  }
  const improved = lowerIsBetter ? change < 0 : change > 0;
  return improved ? "improved" : "worsened";
}

function exactSampleDeltas(
  report: UnknownRecord,
  materiality: number,
): DeltaView[] {
  return records(report.sampleDeltas).flatMap((delta) => {
    const templateId = textAt(delta, ["templateId"], "Unknown opponent");
    const before = isRecord(delta.before) ? delta.before : {};
    const after = isRecord(delta.after) ? delta.after : {};
    return [
      {
        label: `${templateId} · Offensive coverage`,
        before: numberAt(before, ["offensiveCoverage"]),
        after: numberAt(after, ["offensiveCoverage"]),
        change: numberAt(delta, ["offenseChange"]),
        classification: classifyChange(
          numberAt(delta, ["offenseChange"]),
          false,
          materiality,
        ),
        context: `${textAt(before, ["posture"], textAt(after, ["posture"]))} · ${textAt(
          before,
          ["composition"],
          textAt(after, ["composition"]),
        )}`,
      },
      {
        label: `${templateId} · Threat exposure`,
        before: numberAt(before, ["threatExposure"]),
        after: numberAt(after, ["threatExposure"]),
        change: numberAt(delta, ["exposureChange"]),
        classification: classifyChange(
          numberAt(delta, ["exposureChange"]),
          true,
          materiality,
        ),
        context: `${textAt(before, ["status"], textAt(after, ["status"]))} confidence`,
      },
      {
        label: `${templateId} · Coverage margin`,
        before: numberAt(before, ["coverageMargin"]),
        after: numberAt(after, ["coverageMargin"]),
        change: numberAt(delta, ["marginChange"]),
        classification: textAt(
          delta,
          ["classification"],
          classifyChange(
            numberAt(delta, ["marginChange"]),
            false,
            materiality,
          ),
        ),
        context: "",
      },
    ];
  });
}

function exactAggregateDeltas(
  report: UnknownRecord,
  materiality: number,
): DeltaView[] {
  const baseline = first(report, ["baseline.robustness"]);
  const revised = first(report, ["revised.robustness"]);
  const metrics: Array<{
    label: string;
    path: string;
    lowerIsBetter: boolean;
  }> = [
    { label: "Offensive coverage mean", path: "offense.mean", lowerIsBetter: false },
    {
      label: "Offensive lower tail",
      path: "offense.lowerTail",
      lowerIsBetter: false,
    },
    { label: "Threat exposure mean", path: "exposure.mean", lowerIsBetter: true },
    {
      label: "Threat exposure tail",
      path: "exposure.lowerTail",
      lowerIsBetter: true,
    },
    { label: "Coverage margin mean", path: "margin.mean", lowerIsBetter: false },
    {
      label: "Coverage margin lower tail",
      path: "margin.lowerTail",
      lowerIsBetter: false,
    },
  ];
  return metrics.flatMap((metric) => {
    const before = finiteNumber(at(baseline, metric.path));
    const after = finiteNumber(at(revised, metric.path));
    if (before === null && after === null) {
      return [];
    }
    const change =
      before !== null && after !== null ? after - before : null;
    return [{
      label: metric.label,
      before,
      after,
      change,
      classification: classifyChange(
        change,
        metric.lowerIsBetter,
        materiality,
      ),
      context: "Frozen equal-weight portfolio",
    }];
  });
}

function renderPairs(pairs: DisplayPair[], empty: string): string {
  if (!pairs.length) {
    return `<p class="empty">${escapeHtml(empty)}</p>`;
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

function renderList(items: string[], empty: string): string {
  if (!items.length) {
    return `<p class="empty">${escapeHtml(empty)}</p>`;
  }
  return `<ul>${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
}

function bandClass(value: string): string {
  if (/green|complete|high|improved|good/i.test(value)) {
    return "good";
  }
  if (/red|failed|worse|low|partial|degraded|inconclusive|review|ambiguous|warn/i.test(value)) {
    return "warn";
  }
  return "";
}

function renderPortfolio(items: PortfolioItemView[]): string {
  if (!items.length) {
    return '<p class="empty">No portfolio items were recorded.</p>';
  }
  return `<div class="table-scroll"><table>
<thead><tr><th>Opponent</th><th>Template</th><th>Posture / composition</th><th>Points</th><th>Weight</th><th>Stages</th><th>Representative</th></tr></thead>
<tbody>${items
    .map(
      (item) => `<tr>
<th scope="row">${escapeHtml(item.rosterName)}<small>${escapeHtml(item.itemId)}</small></th>
<td>${escapeHtml(item.template)}<small>${escapeHtml(item.status)}</small></td>
<td>${escapeHtml(item.posture)}<small>${escapeHtml(item.composition)}</small></td>
<td>${displayNumber(item.points)}</td><td>${displayPercent(item.weight)}</td>
<td>${escapeHtml(item.stages)}${
        item.omissionReason
          ? `<small class="warn-text">${escapeHtml(item.omissionReason)}</small>`
          : ""
      }</td><td>${escapeHtml(item.representative)}</td>
</tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderRanges(ranges: RangeView[]): string {
  if (!ranges.length) {
    return '<p class="empty">No aggregate robustness ranges were available.</p>';
  }
  return `<div class="table-scroll"><table>
<thead><tr><th>Measure</th><th>Worst</th><th>Median</th><th>Mean</th><th>Best</th><th>Tail</th></tr></thead>
<tbody>${ranges
    .map(
      (range) => `<tr><th scope="row">${escapeHtml(range.metric)}</th>
<td>${displayPercent(range.worst)}</td><td>${displayPercent(
        range.median,
      )}</td><td>${displayPercent(range.mean)}</td><td>${displayPercent(
        range.best,
      )}</td><td>${displayPercent(range.tail)}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderCoverageTable(points: CoveragePointView[]): string {
  if (!points.length) {
    return '<p class="empty">No usable screening samples were available.</p>';
  }
  return `<div class="table-scroll"><table>
<thead><tr><th>Opponent</th><th>Phase</th><th>Offensive coverage</th><th>Threat exposure</th><th>Margin</th><th>Evidence confidence</th></tr></thead>
<tbody>${points
    .map(
      (point) => `<tr><th scope="row">${escapeHtml(point.label)}</th>
<td>${escapeHtml(point.phase)}</td><td>${displayPercent(
        point.coverage,
      )}</td><td>${displayPercent(point.exposure)}</td><td>${displayPercent(
        point.margin,
      )}</td><td><span class="badge ${bandClass(
        point.confidence,
      )}">${escapeHtml(point.confidence)}</span></td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderRepresentatives(items: RepresentativeView[]): string {
  if (!items.length) {
    return '<p class="empty">No deep-dive representatives were selected.</p>';
  }
  return `<div class="cards">${items
    .map(
      (item) => `<article class="card"><div class="eyebrow">${escapeHtml(
        item.role,
      )}</div><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(
        item.reason || "Selected by the deterministic representative policy.",
      )}</p><small>${escapeHtml(item.status)} · ${escapeHtml(
        item.itemId,
      )}</small></article>`,
    )
    .join("")}</div>`;
}

function renderMission(
  overall: string,
  dimensions: MissionDimensionView[],
): string {
  if (!dimensions.length) {
    return `<p><span class="badge ${bandClass(overall)}">${escapeHtml(
      overall,
    )}</span></p><p class="empty">No mission-readiness dimensions were available.</p>`;
  }
  return `<p>Overall readiness: <span class="badge ${bandClass(
    overall,
  )}">${escapeHtml(overall)}</span></p>
<div class="table-scroll"><table>
<thead><tr><th>Dimension</th><th>Band</th><th>Value</th><th>Confidence</th><th>Evidence</th></tr></thead>
<tbody>${dimensions
    .map(
      (dimension) => `<tr><th scope="row">${escapeHtml(
        dimension.dimension,
      )}</th><td><span class="badge ${bandClass(
        dimension.band,
      )}">${escapeHtml(dimension.band)}</span></td><td>${escapeHtml(
        dimension.value,
      )}</td><td>${escapeHtml(dimension.confidence)}</td><td>${escapeHtml(
        dimension.evidence || "No structured evidence recorded.",
      )}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderFindings(items: FindingView[]): string {
  if (!items.length) {
    return '<p class="empty">No cross-proxy findings met the reporting threshold.</p>';
  }
  return `<div class="cards">${items
    .map(
      (item) => `<article class="card"><div class="eyebrow">${escapeHtml(
        item.kind,
      )} · ${escapeHtml(item.confidence)} confidence</div><h3>${escapeHtml(
        item.summary,
      )}</h3><p>${escapeHtml(
        item.support || "Support was not quantified.",
      )}</p></article>`,
    )
    .join("")}</div>`;
}

function renderUnitRobustness(items: UnitRobustnessView[]): string {
  if (!items.length) {
    return '<p class="empty">No unit-level robustness measurements were available.</p>';
  }
  return `<div class="table-scroll"><table>
<thead><tr><th>Unit</th><th>Points</th><th>Answer breadth</th><th>Exposed weight</th><th>Supporting opponents</th></tr></thead>
<tbody>${items
    .map(
      (item) => `<tr><th scope="row">${escapeHtml(
        item.label,
      )}<small>${escapeHtml(item.instanceId)}</small></th><td>${displayNumber(
        item.points,
      )}</td><td>${displayPercent(
        item.answerBreadth,
      )}</td><td>${displayPercent(item.exposedWeight)}</td><td>${escapeHtml(
        item.support || "None recorded",
      )}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderChanges(items: ChangeView[]): string {
  if (!items.length) {
    return '<p class="empty">No legal roster changes were proposed.</p>';
  }
  return `<div class="cards">${items
    .map(
      (item) => `<article class="card"><div class="eyebrow">${escapeHtml(
        item.effect || "Candidate change",
      )}</div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(
        item.rationale,
      )}</p><small>${escapeHtml(
        item.support || "No supporting finding references were recorded.",
      )}</small></article>`,
    )
    .join("")}</div>`;
}

function renderDeltas(items: DeltaView[], empty: string): string {
  if (!items.length) {
    return `<p class="empty">${escapeHtml(empty)}</p>`;
  }
  return `<div class="table-scroll"><table>
<thead><tr><th>Measure</th><th>Before</th><th>After</th><th>Change</th><th>Result</th><th>Context</th></tr></thead>
<tbody>${items
    .map(
      (item) => `<tr><th scope="row">${escapeHtml(item.label)}</th>
<td>${displayPercent(item.before)}</td><td>${displayPercent(
        item.after,
      )}</td><td>${displayPercent(item.change)}</td><td><span class="badge ${bandClass(
        item.classification,
      )}">${escapeHtml(item.classification)}</span></td><td>${escapeHtml(
        item.context,
      )}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function inlineSettings(settings: DisplayPair[]): string {
  return settings.length
    ? settings
        .map((setting) => `${setting.label}: ${setting.value}`)
        .join("; ")
    : "No visible settings recorded";
}

function renderScenarioProvenance(
  scenarios: StageScenarioView[],
): string {
  if (!scenarios.length) {
    return "No per-scenario provenance recorded";
  }
  return `<ul>${scenarios
    .map(
      (scenario) =>
        `<li>${escapeHtml(scenario.phase)} / ${escapeHtml(
          scenario.metric,
        )} / ${escapeHtml(
          scenario.direction,
        )} — ${escapeHtml(
          scenario.iterations,
        )} iterations — ${escapeHtml(
          inlineSettings(scenario.settings),
        )}</li>`,
    )
    .join("")}</ul>`;
}

function renderStageProvenance(
  stages: StageProvenanceView[],
): string {
  if (!stages.length) {
    return '<p class="empty">No stage provenance was recorded.</p>';
  }
  return `<div class="cards">${stages
    .map(
      (stage) => `<article class="card"><div class="eyebrow">${escapeHtml(
        stage.stage,
      )}</div>
${renderPairs(
  [
    { label: "Analysis mode", value: stage.analysisMode },
    { label: "Phases", value: stage.phases },
    { label: "Metrics", value: stage.metrics },
    { label: "Directions", value: stage.directions },
    { label: "Iterations", value: stage.iterations },
    { label: "Visible settings", value: inlineSettings(stage.settings) },
  ],
  "No stage details were recorded.",
)}
${
  stage.proxyRuns.length
    ? `<div class="table-scroll"><table>
<thead><tr><th>Proxy</th><th>Iterations</th><th>Visible settings</th><th>Scenario pairing</th></tr></thead>
<tbody>${stage.proxyRuns
        .map(
          (run) => `<tr><th scope="row">${escapeHtml(
            run.templateId,
          )}</th><td>${escapeHtml(run.iterations)}</td><td>${escapeHtml(
            inlineSettings(run.settings),
          )}</td><td>${renderScenarioProvenance(run.scenarios)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : '<p class="empty">No per-proxy stage runs were recorded.</p>'
}</article>`,
    )
    .join("")}</div>`;
}

function renderFrozenArtifacts(
  artifacts: FrozenArtifactView[],
): string {
  if (!artifacts.length) {
    return '<p class="empty">No frozen opponent artifact receipts were recorded.</p>';
  }
  return `<div class="table-scroll"><table>
<thead><tr><th>Proxy</th><th>Roster fingerprint</th><th>Content SHA-256</th><th>Artifact file</th></tr></thead>
<tbody>${artifacts
    .map(
      (artifact) => `<tr><th scope="row">${escapeHtml(
        artifact.templateId,
      )}</th><td><code>${escapeHtml(
        artifact.rosterFingerprint,
      )}</code></td><td><code>${escapeHtml(
        artifact.sha256,
      )}</code></td><td>${escapeHtml(artifact.filename)}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function commonStyles(): string {
  return `<style>
:root{color-scheme:light;--ink:#17202a;--muted:#657284;--line:#d8dfe8;--panel:#f5f7fa;--accent:#3157d5;--good:#137044;--warn:#a24700}
*{box-sizing:border-box}body{margin:0;background:#eef1f5;color:var(--ink);font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 20px 72px}.hero,section{background:#fff;border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:18px}
h1,h2,h3{line-height:1.2;margin-top:0}h1{font-size:clamp(1.8rem,4vw,2.7rem);margin-bottom:8px}h2{font-size:1.3rem}h3{font-size:1rem;margin-bottom:8px}
.kicker,.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;font-weight:700;color:var(--muted)}.meta,small{color:var(--muted)}small{display:block}.caution{border-left:4px solid var(--warn);background:#fff7e8;padding:12px 14px;margin-top:18px}
.badge{display:inline-block;border-radius:999px;padding:3px 9px;font-size:.78rem;font-weight:700;background:#e7ebf2}.badge.good{background:#dff5e9;color:var(--good)}.badge.warn{background:#fff0dc;color:var(--warn)}.warn-text{color:var(--warn)}
.pairs{display:grid;grid-template-columns:repeat(2,minmax(240px,1fr));gap:0 24px;margin:0}.pairs div{display:grid;grid-template-columns:minmax(150px,1fr) 1.5fr;border-bottom:1px solid var(--line);padding:8px 0}.pairs dt{font-weight:700}.pairs dd{margin:0;overflow-wrap:anywhere}
.table-scroll{overflow:auto;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:720px}th,td{border-bottom:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:#f0f3f7;z-index:1}tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.card{border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--panel)}.empty{color:var(--muted);font-style:italic}.chart{min-height:360px;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:8px;margin-bottom:14px}.chart svg{display:block;width:100%;height:340px}.chart-label{font-size:12px;fill:#435062}.chart-dot{stroke:#fff;stroke-width:2}.filters{margin:0 0 12px}.filters label{font-size:.8rem;font-weight:700;color:var(--muted)}select{margin-left:8px;border:1px solid var(--line);border-radius:8px;padding:7px;background:#fff;color:var(--ink)}
code{overflow-wrap:anywhere}@media(max-width:820px){.pairs{grid-template-columns:1fr}}@media print{body{background:#fff}.hero,section{break-inside:avoid;border-color:#bbb}.filters{display:none}.chart{min-height:0}}
</style>`;
}

function chartScript(): string {
  return `<script>
(() => {
  "use strict";
  const dataNode = document.getElementById("report-data");
  const data = dataNode ? JSON.parse(dataNode.textContent || "{}") : {};
  const points = Array.isArray(data.coveragePoints) ? data.coveragePoints : [];
  const host = document.getElementById("coverage-chart");
  const phase = document.getElementById("coverage-phase");
  const ns = "http://www.w3.org/2000/svg";
  const make = (name, attributes = {}, text = "") => {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text) node.textContent = text;
    return node;
  };
  const ratio = (value) => Math.max(0, Math.min(1, Math.abs(value) <= 1 ? value : value / 100));
  function render() {
    if (!host) return;
    host.replaceChildren();
    const selected = phase && "value" in phase ? phase.value : "all";
    const visible = points.filter((point) =>
      (selected === "all" || point.phase === selected) &&
      typeof point.coverage === "number" && typeof point.exposure === "number"
    );
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No plottable coverage and exposure samples are available.";
      host.append(empty);
      return;
    }
    const width = 900, height = 340, left = 64, right = 20, top = 24, bottom = 52;
    const x = (value) => left + ratio(value) * (width - left - right);
    const y = (value) => height - bottom - ratio(value) * (height - top - bottom);
    const svg = make("svg", { viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": "Offensive coverage versus threat exposure" });
    [0, .25, .5, .75, 1].forEach((tick) => {
      svg.append(make("line", { x1: x(tick), y1: top, x2: x(tick), y2: height - bottom, stroke: "#d8dfe8" }));
      svg.append(make("line", { x1: left, y1: y(tick), x2: width - right, y2: y(tick), stroke: "#d8dfe8" }));
      svg.append(make("text", { x: x(tick), y: height - 28, "text-anchor": "middle", class: "chart-label" }, Math.round(tick * 100) + "%"));
      svg.append(make("text", { x: 54, y: y(tick) + 4, "text-anchor": "end", class: "chart-label" }, Math.round(tick * 100) + "%"));
    });
    svg.append(make("line", { x1: left, y1: height - bottom, x2: width - right, y2: top, stroke: "#657284", "stroke-dasharray": "5 5" }));
    svg.append(make("text", { x: (left + width - right) / 2, y: height - 5, "text-anchor": "middle", class: "chart-label" }, "Offensive coverage"));
    svg.append(make("text", { x: 14, y: (top + height - bottom) / 2, transform: "rotate(-90 14 " + ((top + height - bottom) / 2) + ")", "text-anchor": "middle", class: "chart-label" }, "Threat exposure"));
    visible.forEach((point) => {
      const dot = make("circle", { cx: x(point.coverage), cy: y(point.exposure), r: 7, fill: ratio(point.coverage) >= ratio(point.exposure) ? "#137044" : "#a24700", class: "chart-dot" });
      const title = make("title", {}, point.label + " · coverage " + Math.round(ratio(point.coverage) * 100) + "% · exposure " + Math.round(ratio(point.exposure) * 100) + "%");
      dot.append(title);
      svg.append(dot);
    });
    host.append(svg);
  }
  if (phase) phase.addEventListener("change", render);
  render();
})();
</script>`;
}

function documentShell(
  title: string,
  hero: string,
  body: string,
  embedded: unknown,
): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${commonStyles()}
</head><body><main>${hero}${body}</main>
<script type="application/json" id="report-data">${serializeForScript(
    safeObject(embedded),
  )}</script>
${chartScript()}
</body></html>`;
}

export function renderTesseraStressTestReportHtml(
  report: TesseraStressTestReport,
): string {
  const view = normalizeStressTest(report);
  const phases = unique(view.coveragePoints.map((point) => point.phase));
  const hero = `<header class="hero"><div class="kicker">RosterPilot · Tessera faction stress test</div>
<h1>${escapeHtml(view.title)}</h1>
<p class="meta">Against ${escapeHtml(view.opponentFaction)} · ${escapeHtml(
    view.suite,
  )} · ${escapeHtml(view.strategy)} analysis · Generated ${escapeHtml(
    view.generatedAt,
  )}</p>
<p><span class="badge ${bandClass(view.status)}">${escapeHtml(
    view.status,
  )}</span></p>
${view.statusExplanation ? `<p>${escapeHtml(view.statusExplanation)}</p>` : ""}
${renderPairs(
    view.confidenceSummary,
    "Coverage and evidence confidence were not recorded.",
  )}
<p class="caution"><strong>Directional combat robustness, not win probability.</strong> Unknown lists, terrain, missions, deployment, sequencing, and player decisions remain uncertain.</p>
</header>`;
  const body = `<section aria-labelledby="coverage-heading"><h2 id="coverage-heading">Suite coverage</h2>
${renderPairs(view.suiteCoverage, "No suite coverage was recorded.")}
${renderPortfolio(view.items)}</section>
<section aria-labelledby="reliability-heading"><h2 id="reliability-heading">Reliability and recovery</h2>
<h3>Simulation integrity</h3>${renderPairs(
    view.integrity,
    "Simulation integrity was not evaluated.",
  )}${renderList(
    view.integrityIssues,
    "No matrix-integrity issues were recorded.",
  )}
<h3>Resume state</h3>${renderPairs(
    view.recovery,
    "No recovery state was recorded.",
  )}${renderList(
    view.recoveryActions,
    "No recovery action is required.",
  )}</section>
<section aria-labelledby="ranges-heading"><h2 id="ranges-heading">Robustness ranges</h2>
<p class="meta">Worst, median, mean, best, and tail values summarize equal-weight usable opponents; missing simulations are never inferred.</p>
${renderRanges(view.ranges)}</section>
<section aria-labelledby="coverage-exposure-heading"><h2 id="coverage-exposure-heading">Coverage versus exposure</h2>
<p class="meta">Points-weighted offensive coverage and threat exposure use the report’s configured half-wipe threshold.</p>
<form class="filters"><label>Phase<select id="coverage-phase"><option value="all">All</option>${phases
    .map(
      (phase) =>
        `<option value="${escapeHtml(phase)}">${escapeHtml(phase)}</option>`,
    )
    .join("")}</select></label></form>
<div class="chart" id="coverage-chart" aria-live="polite"></div>
${renderCoverageTable(view.coveragePoints)}</section>
<section aria-labelledby="representatives-heading"><h2 id="representatives-heading">Representative deep dives</h2>${renderRepresentatives(
    view.representatives,
  )}</section>
<section aria-labelledby="phase-heading"><h2 id="phase-heading">Phase dependence</h2>${renderPairs(
    view.phaseDependence,
    "No shooting-versus-fight dependence summary was available.",
  )}</section>
<section aria-labelledby="mission-heading"><h2 id="mission-heading">Mission readiness</h2>
<p class="meta">Mission readiness is a deterministic guardrail, not a game-outcome probability.</p>${renderMission(
    view.missionOverall,
    view.missionDimensions,
  )}</section>
<section aria-labelledby="findings-heading"><h2 id="findings-heading">Unit and cross-proxy findings</h2>
<h3>Unit robustness</h3>${renderUnitRobustness(view.units)}
<h3>Cross-proxy findings</h3>${renderFindings(view.findings)}</section>
<section aria-labelledby="changes-heading"><h2 id="changes-heading">Candidate roster changes</h2>
<p class="meta">Suggestions are evidence-backed proposals only and are never applied automatically.</p>${renderChanges(
    view.changes,
  )}</section>
<section aria-labelledby="provenance-heading"><h2 id="provenance-heading">Provenance</h2>${renderPairs(
    view.provenance,
    "No provenance was recorded.",
  )}
<h3>Simulation stage provenance</h3>${renderStageProvenance(
    view.stageProvenance,
  )}
<h3>Frozen opponent artifacts</h3>${renderFrozenArtifacts(
    view.frozenArtifacts,
  )}</section>
<section aria-labelledby="warnings-heading"><h2 id="warnings-heading">Warnings</h2>${renderList(
    view.warnings,
    "No warnings were recorded.",
  )}</section>
<section aria-labelledby="limitations-heading"><h2 id="limitations-heading">Limitations</h2>${renderList(
    view.limitations,
    "No additional limitations were recorded.",
  )}</section>`;
  return documentShell(view.title, hero, body, {
    coveragePoints: view.coveragePoints,
    runId: view.runId,
  });
}

export function renderTesseraStressRevisionReportHtml(
  report: TesseraStressRevisionReport,
): string {
  const root = report as unknown as UnknownRecord;
  const title = "Faction stress-test revision comparison";
  const materiality =
    numberAt(root, [
      "baseline.configuration.revisionMateriality",
      "revised.configuration.revisionMateriality",
    ]) ?? 0.01;
  const exactPaired = exactSampleDeltas(root, materiality);
  const paired =
    exactPaired.length
      ? exactPaired
      : normalizeDeltas(
          first(root, ["pairedDeltas", "pairedProxyDeltas", "deltas"]),
        );
  const exactAggregate = exactAggregateDeltas(root, materiality);
  const aggregate =
    exactAggregate.length
      ? exactAggregate
      : normalizeDeltas(
          first(root, [
            "aggregateDeltas",
            "robustnessDeltas",
            "summary.deltas",
          ]),
        );
  const guardrail = isRecord(root.missionReadinessGuardrail)
    ? root.missionReadinessGuardrail
    : {};
  const baselineReport = first(root, ["baseline"]);
  const baselineView = isRecord(baselineReport)
    ? normalizeStressTest(
        baselineReport as unknown as TesseraStressTestReport,
      )
    : null;
  const revisedReport = first(root, ["revisedReport", "revised"]);
  const revisedView = isRecord(revisedReport)
    ? normalizeStressTest(
        revisedReport as unknown as TesseraStressTestReport,
      )
    : null;
  const findings = normalizeFindings(
    records(root.findings).length
      ? root
      : (isRecord(root.revised) ? root.revised : root),
  );
  const changes = normalizeChanges(
    records(root.changeCandidates).length
      ? root
      : (isRecord(root.revised) ? root.revised : root),
  );
  const baselineRunId = textAt(root, [
    "baselineRunId",
    "baseline.runId",
  ]);
  const revisedRunId = textAt(root, ["revisedRunId", "revised.runId"]);
  const warnings = unique([
    ...stringArray(root.warnings),
    ...stringArray(first(root, ["baseline.warnings"])),
    ...stringArray(first(root, ["revised.warnings"])),
  ]);
  const limitations = unique([
    ...stringArray(root.limitations),
    ...stringArray(first(root, ["baseline.limitations"])),
    ...stringArray(first(root, ["revised.limitations"])),
  ]);
  const conclusion = textAt(
    root,
    ["summary.conclusion", "status"],
    "unknown",
  );
  const hero = `<header class="hero"><div class="kicker">RosterPilot · Tessera paired faction stress revision</div>
<h1>${title}</h1>
<p class="meta">Baseline ${escapeHtml(
    baselineRunId || "not recorded",
  )} · Revised ${escapeHtml(
    revisedRunId || "not recorded",
  )} · Generated ${escapeHtml(textAt(root, ["generatedAt"]))}</p>
<p><span class="badge ${bandClass(conclusion)}">${escapeHtml(
    conclusion,
  )}</span></p>
<p class="caution"><strong>Paired directional combat evidence only.</strong> Improvements and regressions are not changes in game win probability. Missing pairs suppress broad conclusions.</p>
</header>`;
  const body = `<section aria-labelledby="pairing-heading"><h2 id="pairing-heading">Frozen portfolio pairing</h2>${renderPairs(
    [
      { label: "Baseline run ID", value: baselineRunId || "Not recorded" },
      { label: "Revised run ID", value: revisedRunId || "Not recorded" },
      {
        label: "Baseline report",
        value:
          textAt(root, ["baselineReportPath"]).split(/[\\/]/).pop() ||
          "Not recorded",
      },
      {
        label: "Paired opponents",
        value: String(
          numberAt(root, [
            "pairing.pairedCount",
            "summary.pairedCount",
          ]) ?? records(root.sampleDeltas).length,
        ),
      },
      {
        label: "Missing revised pairs",
        value: String(
          numberAt(root, [
            "pairing.missingCount",
            "summary.missingPairCount",
          ]) ?? 0,
        ),
      },
      {
        label: "Portfolio SHA-256",
        value: textAt(
          root,
          [
            "portfolioSha256",
            "baseline.portfolioSha256",
            "portfolioFingerprint",
            "baselinePortfolioFingerprint",
          ],
          "Not recorded",
        ),
      },
      {
        label: "Revision materiality",
        value: displayPercent(materiality),
      },
    ],
    "No pairing metadata was recorded.",
  )}
<h3>Frozen opponent artifacts</h3>${renderFrozenArtifacts(
    baselineView?.frozenArtifacts ?? [],
  )}</section>
<section aria-labelledby="aggregate-heading"><h2 id="aggregate-heading">Aggregate robustness deltas</h2>${renderDeltas(
    aggregate,
    "No aggregate robustness deltas were available.",
  )}</section>
<section aria-labelledby="paired-heading"><h2 id="paired-heading">Paired opponent deltas</h2>${renderDeltas(
    paired,
    "No usable paired opponent deltas were available.",
  )}</section>
<section aria-labelledby="mission-heading"><h2 id="mission-heading">Mission-readiness changes</h2>
<p class="meta">Mission readiness remains a guardrail and tie-breaker, never a combined win score.</p>${renderPairs(
    [
      {
        label: "Guardrail result",
        value:
          typeof guardrail.accepted === "boolean"
            ? guardrail.accepted
              ? "Accepted"
              : "Rejected"
            : "Not available",
      },
      {
        label: "Baseline readiness",
        value: textAt(guardrail, ["baselineBand"], "Not available"),
      },
      {
        label: "Revised readiness",
        value: textAt(guardrail, ["revisedBand"], "Not available"),
      },
      {
        label: "New red dimensions",
        value:
          stringArray(guardrail.newRedDimensions).join(", ") || "None",
      },
      {
        label: "Removed essential providers",
        value:
          stringArray(guardrail.removedEssentialProviders).join(", ") ||
          "None",
      },
    ],
    "No mission-readiness changes were available.",
  )}
${renderList(
    stringArray(guardrail.reasons),
    "No mission-readiness guardrail reasons were recorded.",
  )}</section>
<section aria-labelledby="findings-heading"><h2 id="findings-heading">Unit and cross-proxy findings</h2>
<h3>Revised unit robustness</h3>${renderUnitRobustness(
    revisedView?.units ?? [],
  )}
<h3>Revised cross-proxy findings</h3>${renderFindings(findings)}</section>
<section aria-labelledby="changes-heading"><h2 id="changes-heading">Candidate roster changes</h2>${renderChanges(
    changes,
  )}</section>
<section aria-labelledby="provenance-heading"><h2 id="provenance-heading">Provenance</h2>${renderPairs(
    [
      { label: "Revision run ID", value: textAt(root, ["runId"], "Not recorded") },
      {
        label: "Schema",
        value: `${textAt(root, ["reportKind"], "stress-revision")} v${textAt(
          root,
          ["schemaVersion"],
          "?",
        )}`,
      },
      { label: "Baseline run ID", value: baselineRunId || "Not recorded" },
      { label: "Revised run ID", value: revisedRunId || "Not recorded" },
      {
        label: "Baseline player fingerprint",
        value: textAt(
          root,
          ["baselinePlayerFingerprint", "baseline.player.fingerprint"],
          "Not recorded",
        ),
      },
      {
        label: "Revised player fingerprint",
        value: textAt(
          root,
          [
            "revisedPlayerFingerprint",
            "revisedRosterFingerprint",
            "revised.player.fingerprint",
          ],
          revisedView
            ? revisedView.provenance.find(
                (pair) => pair.label === "Player fingerprint",
              )?.value ?? "Not recorded"
            : "Not recorded",
        ),
      },
      {
        label: "Revision materiality",
        value: displayPercent(materiality),
      },
    ],
    "No provenance was recorded.",
  )}
<h3>Baseline stage provenance</h3>${renderStageProvenance(
    baselineView?.stageProvenance ?? [],
  )}
<h3>Revised stage provenance</h3>${renderStageProvenance(
    revisedView?.stageProvenance ?? [],
  )}</section>
<section aria-labelledby="warnings-heading"><h2 id="warnings-heading">Warnings</h2>${renderList(
    warnings,
    "No warnings were recorded.",
  )}</section>
<section aria-labelledby="limitations-heading"><h2 id="limitations-heading">Limitations</h2>${renderList(
    limitations,
    "No additional limitations were recorded.",
  )}</section>`;
  return documentShell(title, hero, body, {
    aggregateDeltas: aggregate,
    pairedDeltas: paired,
    missionReadinessGuardrail: {
      accepted: guardrail.accepted,
      reasons: stringArray(guardrail.reasons),
      baselineBand: textAt(guardrail, ["baselineBand"]),
      revisedBand: textAt(guardrail, ["revisedBand"]),
      newRedDimensions: stringArray(guardrail.newRedDimensions),
      removedEssentialProviders: stringArray(
        guardrail.removedEssentialProviders,
      ),
    },
  });
}
