import crypto from "node:crypto";

import {
  type TesseraConfidence,
  type TesseraMatchupReport,
  type TesseraScenarioCell,
  type TesseraScenarioResult,
  type TesseraStressAggregate,
  type TesseraStressFinding,
  type TesseraStressPortfolio,
  type TesseraStressPortfolioItem,
  type TesseraStressRepresentative,
  type TesseraStressRobustness,
  type TesseraStressSample,
  type TesseraStressUnitRobustness,
} from "../../lib/rosterpilot";

const HALF_WIPE_THRESHOLD = 0.5;
const MIN_CONFIDENT_POINT_COVERAGE = 0.8;

type CoverageResult = {
  value: number | null;
  pointCoverage: number;
};

function finitePointValue(value: number | null): number {
  return value !== null && Number.isFinite(value) && value > 0 ? value : 0;
}

const CONFIDENCE_RANK: Record<TesseraConfidence, number> = {
  ambiguous: 0,
  review: 1,
  high: 2,
};

function worstEvidenceConfidence(
  values: TesseraConfidence[],
): TesseraConfidence {
  if (values.length === 0) return "ambiguous";
  return values.reduce((worst, value) =>
    CONFIDENCE_RANK[value] < CONFIDENCE_RANK[worst] ? value : worst,
  "high");
}

function contributingEvidenceConfidence(
  scenarios: TesseraScenarioResult[],
): TesseraConfidence {
  return worstEvidenceConfidence(
    scenarios
      .flatMap((scenario) => scenario.cells)
      .filter(
        (cell) =>
          finitePointValue(cell.target.points) > 0 &&
          cell.confidence !== "ambiguous" &&
          cell.values.halfWipeProbability !== null,
      )
      .map((cell) => cell.confidence),
  );
}

function capEvidenceConfidence(
  desired: TesseraConfidence,
  evidence: TesseraConfidence,
): TesseraConfidence {
  return CONFIDENCE_RANK[evidence] < CONFIDENCE_RANK[desired]
    ? evidence
    : desired;
}

function uniqueTargets(cells: TesseraScenarioCell[]): Map<string, TesseraScenarioCell["target"]> {
  return new Map(cells.map((cell) => [cell.target.instanceId, cell.target]));
}

function directionalCoverage(
  scenarios: TesseraScenarioResult[],
  expectedTargetPoints: number,
): CoverageResult {
  const cells = scenarios.flatMap((scenario) => scenario.cells);
  if (cells.length === 0) {
    return { value: null, pointCoverage: 0 };
  }
  const targets = uniqueTargets(cells);
  const totalPoints = finitePointValue(expectedTargetPoints);
  let knownPoints = 0;
  let passingPoints = 0;
  for (const target of targets.values()) {
    const points = finitePointValue(target.points);
    const candidates = cells.filter(
      (cell) =>
        cell.target.instanceId === target.instanceId &&
        cell.confidence !== "ambiguous" &&
        cell.values.halfWipeProbability !== null,
    );
    if (candidates.length === 0) continue;
    knownPoints += points;
    if (
      candidates.some(
        (cell) =>
          (cell.values.halfWipeProbability ?? 0) >= HALF_WIPE_THRESHOLD,
      )
    ) {
      passingPoints += points;
    }
  }
  if (totalPoints <= 0) {
    return { value: null, pointCoverage: 0 };
  }
  if (knownPoints <= 0) {
    return { value: null, pointCoverage: 0 };
  }
  return {
    value: Math.min(1, passingPoints / totalPoints),
    pointCoverage: Math.min(1, knownPoints / totalPoints),
  };
}

function scenariosFor(
  report: TesseraMatchupReport,
  opponentName: string,
  direction: TesseraScenarioResult["direction"],
  phase?: TesseraScenarioResult["phase"],
): TesseraScenarioResult[] {
  return (report.simulation.scenarios ?? []).filter(
    (scenario) =>
      scenario.status === "complete" &&
      scenario.opponentName === opponentName &&
      scenario.direction === direction &&
      (phase === undefined || scenario.phase === phase),
  );
}

function itemOpponent(
  report: TesseraMatchupReport,
  item: TesseraStressPortfolioItem,
) {
  if (!item.roster && !item.fingerprint) return null;
  return (
    report.opponents.find(
      (opponent) =>
        (item.fingerprint !== null &&
          opponent.fingerprint === item.fingerprint) ||
        (item.roster !== null &&
          opponent.rosterName === item.roster.name),
    ) ?? null
  );
}

function sampleForItem(
  report: TesseraMatchupReport,
  item: TesseraStressPortfolioItem,
  weight: number,
): TesseraStressSample {
  const opponent = itemOpponent(report, item);
  const missing: TesseraStressSample = {
    templateId: item.templateId,
    posture: item.posture,
    composition: item.composition,
    weight,
    status: "missing",
    coverageCompleteness: "missing",
    evidenceConfidence: "ambiguous",
    offensiveCoverage: null,
    threatExposure: null,
    coverageMargin: null,
    shootingCoverage: null,
    fightCoverage: null,
    shootingExposure: null,
    fightExposure: null,
    playerPointCoverage: 0,
    opponentPointCoverage: 0,
    provisional: null,
    warningRefs: [
      ...new Set(item.warnings.map((warning) => warning.message)),
    ],
  };
  if (!opponent) return missing;

  const shootingCoverage = directionalCoverage(
    scenariosFor(
      report,
      opponent.rosterName,
      "player-to-opponent",
      "shooting",
    ),
    opponent.summary.totalPoints,
  );
  const fightCoverage = directionalCoverage(
    scenariosFor(
      report,
      opponent.rosterName,
      "player-to-opponent",
      "fight",
    ),
    opponent.summary.totalPoints,
  );
  const shootingExposure = directionalCoverage(
    scenariosFor(
      report,
      opponent.rosterName,
      "opponent-to-player",
      "shooting",
    ),
    report.player.summary.totalPoints,
  );
  const fightExposure = directionalCoverage(
    scenariosFor(
      report,
      opponent.rosterName,
      "opponent-to-player",
      "fight",
    ),
    report.player.summary.totalPoints,
  );
  const combinedCoverage = directionalCoverage(
    scenariosFor(report, opponent.rosterName, "player-to-opponent"),
    opponent.summary.totalPoints,
  );
  const combinedExposure = directionalCoverage(
    scenariosFor(report, opponent.rosterName, "opponent-to-player"),
    report.player.summary.totalPoints,
  );
  const playerPointCoverage = Math.min(
    shootingExposure.pointCoverage,
    fightExposure.pointCoverage,
  );
  const opponentPointCoverage = Math.min(
    shootingCoverage.pointCoverage,
    fightCoverage.pointCoverage,
  );
  const hasValues =
    combinedCoverage.value !== null && combinedExposure.value !== null;
  const confident =
    hasValues &&
    playerPointCoverage >= MIN_CONFIDENT_POINT_COVERAGE &&
    opponentPointCoverage >= MIN_CONFIDENT_POINT_COVERAGE;
  const contributingScenarios = scenariosFor(
    report,
    opponent.rosterName,
    "player-to-opponent",
  ).concat(
    scenariosFor(report, opponent.rosterName, "opponent-to-player"),
  );
  const evidenceConfidence = contributingEvidenceConfidence(
    contributingScenarios,
  );
  const warningRefs = [
    ...new Set(
      contributingScenarios.flatMap((scenario) => [
          ...scenario.warnings,
          ...scenario.cells.flatMap((cell) => cell.warningRefs),
        ]),
    ),
  ];
  const estimate = {
    offensiveCoverage: combinedCoverage.value,
    threatExposure: combinedExposure.value,
    coverageMargin:
      combinedCoverage.value !== null && combinedExposure.value !== null
        ? combinedCoverage.value - combinedExposure.value
        : null,
    shootingCoverage: shootingCoverage.value,
    fightCoverage: fightCoverage.value,
    shootingExposure: shootingExposure.value,
    fightExposure: fightExposure.value,
    playerPointCoverage,
    opponentPointCoverage,
  };
  return {
    ...missing,
    status: confident ? "confident" : hasValues ? "ambiguous" : "missing",
    coverageCompleteness: confident
      ? "complete"
      : hasValues
        ? "partial"
        : "missing",
    evidenceConfidence,
    offensiveCoverage: confident ? estimate.offensiveCoverage : null,
    threatExposure: confident ? estimate.threatExposure : null,
    coverageMargin: confident ? estimate.coverageMargin : null,
    shootingCoverage: confident ? estimate.shootingCoverage : null,
    fightCoverage: confident ? estimate.fightCoverage : null,
    shootingExposure: confident ? estimate.shootingExposure : null,
    fightExposure: confident ? estimate.fightExposure : null,
    playerPointCoverage,
    opponentPointCoverage,
    provisional: confident || !hasValues ? null : estimate,
    warningRefs,
  };
}

function quantile(values: number[], position: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function aggregate(
  samples: TesseraStressSample[],
  field: "offensiveCoverage" | "threatExposure" | "coverageMargin",
  higherIsBetter: boolean,
): TesseraStressAggregate {
  const usable = samples.filter(
    (sample) => sample.status === "confident" && sample[field] !== null,
  );
  const values = usable.map((sample) => sample[field] as number);
  const ordered = [...values].sort((left, right) =>
    higherIsBetter ? left - right : right - left,
  );
  const tailCount = Math.max(1, Math.ceil(ordered.length * 0.2));
  const lowerTail =
    ordered.length === 0
      ? null
      : ordered
          .slice(0, tailCount)
          .reduce((total, value) => total + value, 0) / tailCount;
  const totalWeight = usable.reduce((total, sample) => total + sample.weight, 0);
  const weightedMean =
    totalWeight === 0
      ? null
      : usable.reduce(
          (total, sample) =>
            total + (sample[field] as number) * sample.weight,
          0,
        ) / totalWeight;
  return {
    sampleCount: usable.length,
    usableWeight: totalWeight,
    evidenceConfidence: worstEvidenceConfidence(
      usable.map(
        (sample) => sample.evidenceConfidence ?? "ambiguous",
      ),
    ),
    worst:
      values.length === 0
        ? null
        : higherIsBetter
          ? Math.min(...values)
          : Math.max(...values),
    lowerTail,
    median: quantile(values, 0.5),
    mean: weightedMean,
    best:
      values.length === 0
        ? null
        : higherIsBetter
          ? Math.max(...values)
          : Math.min(...values),
  };
}

function weightedMean(
  samples: TesseraStressSample[],
  field:
    | "shootingCoverage"
    | "fightCoverage"
    | "shootingExposure"
    | "fightExposure",
): number | null {
  const usable = samples.filter(
    (sample) => sample.status === "confident" && sample[field] !== null,
  );
  const weight = usable.reduce((total, sample) => total + sample.weight, 0);
  if (weight === 0) return null;
  return usable.reduce(
    (total, sample) => total + (sample[field] as number) * sample.weight,
    0,
  ) / weight;
}

function unitRobustness(
  report: TesseraMatchupReport,
  portfolio: TesseraStressPortfolio,
  samples: TesseraStressSample[],
): TesseraStressUnitRobustness[] {
  const playerUnits = report.player.units ?? [];
  return playerUnits.map((unit) => {
    let weightedBreadth = 0;
    let exposedWeight = 0;
    const supportingTemplateIds: string[] = [];
    const exposedTemplateIds: string[] = [];
    for (const sample of samples) {
      if (sample.status !== "confident") continue;
      const item = portfolio.items.find(
        (candidate) => candidate.templateId === sample.templateId,
      );
      if (!item) continue;
      const opponent = itemOpponent(report, item);
      if (!opponent) continue;
      const attackCells = scenariosFor(
        report,
        opponent.rosterName,
        "player-to-opponent",
      ).flatMap((scenario) =>
        scenario.cells.filter(
          (cell) =>
            cell.attacker.instanceId === unit.instanceId &&
            cell.confidence !== "ambiguous" &&
            cell.values.halfWipeProbability !== null,
        ),
      );
      const targets = uniqueTargets(attackCells);
      const totalTargetPoints = finitePointValue(
        opponent.summary.totalPoints,
      );
      const coveredTargetPoints = [...targets.values()].reduce(
        (total, target) => {
          const covered = attackCells.some(
            (cell) =>
              cell.target.instanceId === target.instanceId &&
              (cell.values.halfWipeProbability ?? 0) >= HALF_WIPE_THRESHOLD,
          );
          return total + (covered ? finitePointValue(target.points) : 0);
        },
        0,
      );
      const breadth =
        totalTargetPoints > 0 ? coveredTargetPoints / totalTargetPoints : 0;
      weightedBreadth += breadth * sample.weight;
      if (breadth > 0) supportingTemplateIds.push(sample.templateId);

      const exposed = scenariosFor(
        report,
        opponent.rosterName,
        "opponent-to-player",
      )
        .flatMap((scenario) => scenario.cells)
        .some(
          (cell) =>
            cell.target.instanceId === unit.instanceId &&
            cell.confidence !== "ambiguous" &&
            (cell.values.halfWipeProbability ?? 0) >= HALF_WIPE_THRESHOLD,
        );
      if (exposed) {
        exposedWeight += sample.weight;
        exposedTemplateIds.push(sample.templateId);
      }
    }
    return {
      instanceId: unit.instanceId,
      label: unit.label,
      points: unit.points,
      answerBreadth: weightedBreadth,
      exposedWeight,
      supportingTemplateIds,
      exposedTemplateIds,
    };
  });
}

export function computeStressRobustness(
  report: TesseraMatchupReport,
  portfolio: TesseraStressPortfolio,
): TesseraStressRobustness {
  const readyItems = portfolio.items.filter(
    (item) => item.status === "ready" && item.roster !== null,
  );
  const weight = readyItems.length === 0 ? 0 : 1 / readyItems.length;
  const samples = readyItems.map((item) => sampleForItem(report, item, weight));
  const confidentCount = samples.filter(
    (sample) => sample.status === "confident",
  ).length;
  const representedPostures = new Set(
    samples
      .filter((sample) => sample.status === "confident")
      .map((sample) => sample.posture),
  );
  const degradedMinimum = Math.min(2, readyItems.length);
  const degradedPostureMinimum = Math.min(
    2,
    new Set(readyItems.map((item) => item.posture)).size,
  );
  const legacyCoverageConfidence =
    confidentCount === portfolio.coverage.intended
      ? "complete"
      : (
          portfolio.coverage.maximumResultStatus === "degraded" &&
          confidentCount >= degradedMinimum &&
          representedPostures.size >= degradedPostureMinimum
        ) ||
          (confidentCount >= 6 && representedPostures.size === 3)
        ? "review"
        : "insufficient";
  const coverageCompleteness =
    legacyCoverageConfidence === "complete"
      ? "complete"
      : legacyCoverageConfidence === "review"
        ? "degraded"
        : "insufficient";
  const evidenceConfidence = worstEvidenceConfidence(
    samples
      .filter((sample) => sample.status === "confident")
      .map((sample) => sample.evidenceConfidence ?? "ambiguous"),
  );
  const warnings: string[] = [];
  if (confidentCount !== readyItems.length) {
    warnings.push(
      `${readyItems.length - confidentCount} prepared proxy result(s) lacked at least ${Math.round(
        MIN_CONFIDENT_POINT_COVERAGE * 100,
      )}% non-ambiguous point coverage.`,
    );
  }
  if (confidentCount > 0 && evidenceConfidence !== "high") {
    warnings.push(
      `Quantitative coverage includes ${confidentCount} complete proxy result(s), but aggregate evidence confidence is ${evidenceConfidence}; evidence confidence is capped by the lowest-confidence contributing simulation cell.`,
    );
  }
  const offense = aggregate(samples, "offensiveCoverage", true);
  const exposure = aggregate(samples, "threatExposure", false);
  const margin = aggregate(samples, "coverageMargin", true);
  return {
    scoreDefinitionVersion: "stress-robustness-v2",
    halfWipeThreshold: HALF_WIPE_THRESHOLD,
    samples,
    offense,
    exposure,
    margin,
    phaseDependence: {
      shootingCoverageMean: weightedMean(samples, "shootingCoverage"),
      fightCoverageMean: weightedMean(samples, "fightCoverage"),
      shootingExposureMean: weightedMean(samples, "shootingExposure"),
      fightExposureMean: weightedMean(samples, "fightExposure"),
    },
    units: unitRobustness(report, portfolio, samples),
    confidence: legacyCoverageConfidence,
    coverageCompleteness,
    evidenceConfidence,
    warnings,
  };
}

function compositionVector(item: TesseraStressPortfolioItem): number[] {
  const traits = item.traits;
  if (!traits || traits.unitCount === 0) return [0, 0, 0];
  return [
    traits.hordePointsPercent,
    traits.eliteHeavyPointsPercent,
    (traits.tagCounts.mobility ?? 0) / traits.unitCount,
  ];
}

function sampleVector(
  sample: TesseraStressSample,
  item: TesseraStressPortfolioItem,
): number[] {
  return [
    sample.shootingCoverage ?? 0,
    sample.fightCoverage ?? 0,
    sample.shootingExposure ?? 1,
    sample.fightExposure ?? 1,
    ...compositionVector(item),
  ];
}

function vectorDistance(left: number[], right: number[]): number {
  let combat = 0;
  let composition = 0;
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (index < 4) combat += difference * difference;
    else composition += difference * difference;
  }
  return Math.sqrt(combat) * 0.7 + Math.sqrt(composition) * 0.3;
}

export function selectStressRepresentatives(
  robustness: TesseraStressRobustness,
  portfolio: TesseraStressPortfolio,
): TesseraStressRepresentative[] {
  const usable = robustness.samples
    .filter((sample) => sample.status === "confident")
    .map((sample) => ({
      sample,
      item: portfolio.items.find(
        (item) => item.templateId === sample.templateId,
      )!,
    }))
    .filter((entry) => entry.item)
    .sort((left, right) =>
      left.sample.templateId.localeCompare(right.sample.templateId),
    );
  if (usable.length === 0) return [];

  const stress = [...usable].sort((left, right) => {
    const leftRisk =
      0.5 * (1 - (left.sample.offensiveCoverage ?? 0)) +
      0.5 * (left.sample.threatExposure ?? 1);
    const rightRisk =
      0.5 * (1 - (right.sample.offensiveCoverage ?? 0)) +
      0.5 * (right.sample.threatExposure ?? 1);
    return rightRisk - leftRisk ||
      left.sample.templateId.localeCompare(right.sample.templateId);
  })[0];
  const vectors = new Map(
    usable.map((entry) => [
      entry.sample.templateId,
      sampleVector(entry.sample, entry.item),
    ]),
  );
  const central = [...usable]
    .filter((entry) => entry.sample.templateId !== stress.sample.templateId)
    .sort((left, right) => {
      const leftDistance = usable.reduce(
        (total, entry) =>
          total +
          vectorDistance(
            vectors.get(left.sample.templateId)!,
            vectors.get(entry.sample.templateId)!,
          ),
        0,
      );
      const rightDistance = usable.reduce(
        (total, entry) =>
          total +
          vectorDistance(
            vectors.get(right.sample.templateId)!,
            vectors.get(entry.sample.templateId)!,
          ),
        0,
      );
      return leftDistance - rightDistance ||
        left.sample.templateId.localeCompare(right.sample.templateId);
    })[0];
  const selected = [stress, central].filter(Boolean);
  const contrast = [...usable]
    .filter(
      (entry) =>
        !selected.some(
          (candidate) =>
            candidate.sample.templateId === entry.sample.templateId,
        ),
    )
    .sort((left, right) => {
      const leftDistance = Math.min(
        ...selected.map((entry) =>
          vectorDistance(
            vectors.get(left.sample.templateId)!,
            vectors.get(entry.sample.templateId)!,
          ),
        ),
      );
      const rightDistance = Math.min(
        ...selected.map((entry) =>
          vectorDistance(
            vectors.get(right.sample.templateId)!,
            vectors.get(entry.sample.templateId)!,
          ),
        ),
      );
      return rightDistance - leftDistance ||
        left.sample.templateId.localeCompare(right.sample.templateId);
    })[0];
  const representatives = [
    {
      kind: "stress" as const,
      entry: stress,
      rationale:
        "Highest equal-weight combination of uncovered opponent points and exposed player points.",
    },
    ...(central
      ? [
          {
            kind: "central" as const,
            entry: central,
            rationale:
              "Portfolio medoid closest to the complete screen result set.",
          },
        ]
      : []),
    ...(contrast
      ? [
          {
            kind: "contrast" as const,
            entry: contrast,
            rationale:
              "Most structurally and directionally distinct remaining screen result.",
          },
        ]
      : []),
  ];
  return representatives.map(({ kind, entry, rationale }) => ({
    kind,
    templateId: entry.sample.templateId,
    rationale,
  }));
}

function findingId(kind: string, key: string): string {
  return crypto
    .createHash("sha256")
    .update(`${kind}:${key}`)
    .digest("hex")
    .slice(0, 20);
}

export function stressFindings(
  robustness: TesseraStressRobustness,
  portfolio: TesseraStressPortfolio,
): TesseraStressFinding[] {
  const findings: TesseraStressFinding[] = [];
  const evidenceConfidence =
    robustness.evidenceConfidence ?? "ambiguous";
  const itemByTemplate = new Map(
    portfolio.items.map((item) => [item.templateId, item]),
  );
  for (const unit of robustness.units) {
    const postures = new Set(
      unit.supportingTemplateIds
        .map((templateId) => itemByTemplate.get(templateId)?.posture)
        .filter(Boolean),
    );
    if (unit.answerBreadth >= 0.5 && postures.size >= 2) {
      findings.push({
        findingId: findingId("robust-answer", unit.instanceId),
        kind: "robust-answer",
        severity: "info",
        confidence: capEvidenceConfidence("high", evidenceConfidence),
        summary: `${unit.label} provides meaningful half-wipe coverage across ${unit.supportingTemplateIds.length} faction proxies.`,
        templateIds: unit.supportingTemplateIds,
        supportingWeight: unit.answerBreadth,
        unitInstanceIds: [unit.instanceId],
      });
    } else if (unit.answerBreadth >= 0.15) {
      findings.push({
        findingId: findingId("conditional-answer", unit.instanceId),
        kind: "conditional-answer",
        severity: "info",
        confidence: capEvidenceConfidence("review", evidenceConfidence),
        summary: `${unit.label} is useful into a narrower subset of the prepared faction portfolio.`,
        templateIds: unit.supportingTemplateIds,
        supportingWeight: unit.answerBreadth,
        unitInstanceIds: [unit.instanceId],
      });
    }
    if (unit.exposedWeight >= 0.5) {
      findings.push({
        findingId: findingId("archetype-risk", unit.instanceId),
        kind: "archetype-risk",
        severity: "warn",
        confidence: capEvidenceConfidence("review", evidenceConfidence),
        summary: `${unit.label} is materially exposed in ${Math.round(
          unit.exposedWeight * 100,
        )}% of the equal-weight prepared portfolio.`,
        templateIds: unit.exposedTemplateIds,
        supportingWeight: unit.exposedWeight,
        unitInstanceIds: [unit.instanceId],
      });
    }
  }
  if (
    robustness.offense.best !== null &&
    robustness.offense.best < HALF_WIPE_THRESHOLD
  ) {
    findings.push({
      findingId: findingId("universal-gap", "offense"),
      kind: "universal-gap",
      severity: "warn",
      confidence: capEvidenceConfidence(
        robustness.confidence === "complete" ? "high" : "review",
        evidenceConfidence,
      ),
      summary:
        "No prepared proxy reaches 50% offensive point coverage under the screening threshold.",
      templateIds: robustness.samples.map((sample) => sample.templateId),
      supportingWeight: robustness.offense.usableWeight,
      unitInstanceIds: [],
    });
  }
  for (const sample of robustness.samples.filter(
    (candidate) => candidate.status !== "confident",
  )) {
    findings.push({
      findingId: findingId("insufficient-confidence", sample.templateId),
      kind: "insufficient-confidence",
      severity: "warn",
      confidence: "ambiguous",
      summary: `${sample.templateId} lacks enough non-ambiguous point coverage for a quantitatively complete portfolio conclusion.`,
      templateIds: [sample.templateId],
      supportingWeight: sample.weight,
      unitInstanceIds: [],
    });
  }
  return findings;
}
