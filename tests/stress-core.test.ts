import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeMissionReadiness,
  assessMissionReadinessRevisionGuardrail,
  buildRoster,
  conflictBlocksAllUnitConfigurations,
  evaluateTesseraStressPortfolioContract,
  exportRoster,
  generateFactionStressPortfolio,
  previewFactionStressPortfolio,
  rosterExecutionFingerprint,
  rosterSimulationDistance,
  rosterStructuralDistance,
  rosterStructuralFingerprint,
  validateRoster,
  type RosterDraftV1,
  type TesseraMissionReadinessReport,
  type TesseraStressPortfolioItem,
} from "../lib/rosterpilot";

function roster(
  faction: string,
  pointsLimit = 1000,
): RosterDraftV1 {
  const built = buildRoster({
    faction,
    pointsLimit,
    allowNamedCharacters: false,
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((entry) => entry.message).join("; "),
  );
  assert.ok(built.data);
  return built.data;
}

test("structural fingerprints ignore presentation fields and expose list changes", () => {
  const base = roster("adeptus-custodes");
  const presentationOnly: RosterDraftV1 = {
    ...base,
    id: "presentation-only-id",
    name: "A different display name",
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    units: base.units.map((unit, index) => ({
      ...unit,
      selectionId: `presentation-${index}`,
      ordinal: index + 20,
    })),
  };
  assert.equal(
    rosterStructuralFingerprint(base),
    rosterStructuralFingerprint(presentationOnly),
  );
  assert.equal(
    rosterExecutionFingerprint(base),
    rosterExecutionFingerprint(presentationOnly),
  );
  assert.equal(rosterStructuralDistance(base, presentationOnly), 0);

  const dispositionChanged: RosterDraftV1 = {
    ...presentationOnly,
    forceDispositionId: "reconnaissance",
    forceDispositionName: "Reconnaissance",
  };
  assert.notEqual(
    rosterExecutionFingerprint(base),
    rosterExecutionFingerprint(dispositionChanged),
  );
  assert.equal(
    rosterSimulationDistance(base, dispositionChanged),
    0,
    "detachment/disposition-only changes are not execution-payload diversity",
  );

  const changed: RosterDraftV1 = {
    ...base,
    detachmentId: `${base.detachmentId}-changed`,
  };
  assert.notEqual(
    rosterStructuralFingerprint(base),
    rosterStructuralFingerprint(changed),
  );
  assert.ok(rosterStructuralDistance(base, changed) > 0);
  assert.equal(rosterSimulationDistance(base, changed), 0);

  const payloadChanged: RosterDraftV1 = {
    ...base,
    units: base.units.map((unit, index) =>
      index === 0
        ? { ...unit, points: unit.points + 5 }
        : unit,
    ),
  };
  assert.ok(rosterSimulationDistance(base, payloadChanged) > 0);
});

test("scoped point conflicts do not poison every configuration of a unit", () => {
  const baseConflict = {
    id: "scoped-points",
    factionId: "test-faction",
    entityType: "points" as const,
    entityId: "test-unit",
    entityName: "Test Unit",
    code: "POINTS_MISMATCH" as const,
    blocking: true,
    message: "Only the six-model tier differs.",
  };
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...baseConflict,
      scope: { modelCount: 6 },
    }),
    false,
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...baseConflict,
      scope: {
        selectionScopes: [{ modelCount: 6 }],
      },
    }),
    false,
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...baseConflict,
      entityId: "test-unit:6",
    }),
    false,
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations(baseConflict),
    true,
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...baseConflict,
      entityType: "unit",
      code: "UNMAPPED",
    }),
    true,
  );
});

test("generates deterministic, exportable core and diverse faction portfolios", async () => {
  const first = generateFactionStressPortfolio({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    suite: "core-3",
  });
  const second = generateFactionStressPortfolio({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    suite: "core-3",
  });
  assert.equal(first.ok, true);
  assert.equal(first.data?.generatorVersion, "faction-stress-v6");
  assert.equal(first.data?.coverage.intended, 3);
  assert.deepEqual(
    first.data?.items.map((item) => item.fingerprint),
    second.data?.items.map((item) => item.fingerprint),
  );
  assert.deepEqual(
    first.data?.items.map((item) => item.posture),
    [
      "balanced-control",
      "ranged-pressure",
      "assault-pressure",
    ],
  );

  const diverse = generateFactionStressPortfolio({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    suite: "diverse-9",
  });
  assert.equal(diverse.ok, true);
  assert.equal(diverse.data?.coverage.intended, 9);
  assert.equal(diverse.data?.items.length, 9);
  const ready = diverse.data?.items.filter(
    (item) => item.status === "ready",
  );
  assert.ok(ready);
  assert.equal(ready.length, 9);
  assert.equal(
    new Set(
      ready.map((item) => item.simulationFingerprint),
    ).size,
    ready.length,
  );
  for (const item of ready) {
    assert.ok(item.roster);
    assert.equal(validateRoster(item.roster).ok, true);
    const exported = await exportRoster(item.roster, "rosz");
    assert.equal(
      exported.ok,
      true,
      exported.violations.map((violation) => violation.message).join("; "),
    );
    assert.ok(
      item.roster.totalPoints >=
        item.roster.pointsLimit *
          (1 - (diverse.data?.pointsTolerancePercent ?? 5) / 100),
    );
    assert.match(
      item.compositionEvidence[0] ?? "",
      /adaptive lens/i,
    );
  }
  assert.deepEqual(
    diverse.data?.coverage.representedCells.map(
      (cell) => cell.templateId,
    ),
    ready.map((item) => item.templateId),
  );
  assert.deepEqual(
    diverse.data?.coverage.missingCells.map(
      (cell) => cell.templateId,
    ),
    diverse.data?.items
      .filter((item) => item.status === "unavailable")
      .map((item) => item.templateId),
  );
});

test("named-character specialist coverage is independent from core posture coverage", () => {
  const aeldari = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1000,
    suite: "core-3",
  });
  assert.equal(aeldari.ok, true);
  assert.ok(aeldari.data);
  assert.equal(
    aeldari.data.items.some(
      (item) =>
        item.status === "ready" &&
        item.containsNamedCharacter === true,
    ),
    false,
  );
  assert.equal(
    aeldari.data.coverage.namedCharacterCoverageStatus,
    "buildable-not-simulated",
  );
  assert.equal(aeldari.data.coverage.namedCharacterCoverage, false);
  assert.match(
    aeldari.data.coverage.namedCharacterCoverageReason ?? "",
    /not one of the simulated core-3 portfolio payloads/i,
  );
  assert.match(
    aeldari.data.coverage
      .namedCharacterSpecialistStructuralFingerprint ?? "",
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    aeldari.data.coverage
      .namedCharacterSpecialistSimulationFingerprint ?? "",
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    aeldari.data.coverage.maximumResultStatus,
    "complete",
  );

  const adeptusAstartes = generateFactionStressPortfolio({
    faction: "adeptus-astartes",
    pointsLimit: 1000,
    suite: "core-3",
  });
  assert.equal(adeptusAstartes.ok, true);
  assert.ok(adeptusAstartes.data);
  assert.equal(
    adeptusAstartes.data.coverage.namedCharacterCoverageStatus,
    "buildable-not-simulated",
  );
  assert.equal(
    adeptusAstartes.data.coverage.namedCharacterCoverage,
    false,
  );
  assert.match(
    adeptusAstartes.data.coverage
      .namedCharacterCoverageReason ?? "",
    /not one of the simulated core-3 portfolio payloads/i,
  );
  assert.match(
    adeptusAstartes.data.coverage
      .namedCharacterSpecialistStructuralFingerprint ?? "",
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    adeptusAstartes.data.coverage
      .namedCharacterSpecialistSimulationFingerprint ?? "",
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    adeptusAstartes.data.coverage.maximumResultStatus,
    "complete",
  );

  const chaosKnights = generateFactionStressPortfolio({
    faction: "chaos-knights",
    pointsLimit: 1000,
    suite: "core-3",
  });
  assert.ok(chaosKnights.data);
  assert.equal(
    chaosKnights.data.coverage.namedCharacterCoverageStatus,
    "not-applicable",
  );
  assert.equal(
    chaosKnights.data.coverage.namedCharacterCoverage,
    true,
  );
  assert.match(
    chaosKnights.data.coverage.namedCharacterCoverageReason ?? "",
    /no legal named-character anchor/i,
  );
  assert.equal(
    chaosKnights.data.coverage.maximumResultStatus,
    "complete",
  );
});

test("core portfolios require three unique postures and retain density evidence", async () => {
  const preview = await previewFactionStressPortfolio({
    faction: "orks",
    pointsLimit: 1000,
    suite: "core-3",
    pointsTolerancePercent: 5,
    allowLegends: false,
  });
  assert.equal(
    preview.ok,
    true,
    preview.violations.map((violation) => violation.message).join("; "),
  );
  assert.equal(preview.data?.gates.accepted, true);
  assert.equal(preview.data?.gates.completeCoverage, true);
  assert.equal(preview.data?.gates.maximumResultStatus, "complete");
  const ready = preview.data?.portfolio.items.filter(
    (item) => item.status === "ready",
  );
  assert.equal(ready?.length, 3);
  assert.equal(
    new Set(ready?.map((item) => item.simulationFingerprint)).size,
    3,
  );
  assert.equal(
    new Set(ready?.map((item) => item.posture)).size,
    3,
  );
  assert.ok(ready?.every((item) => item.roster));
  assert.ok(
    ready?.every((item) =>
      preview.data?.items.find(
        (candidate) => candidate.templateId === item.templateId,
      )?.exportable,
    ),
  );
  assert.ok(
    ready?.every(
      (item) =>
        item.compositionEvidence.length > 0 &&
        (item.traits?.modelCount ?? 0) > 0,
    ),
  );
  assert.deepEqual(preview.data?.gates.missingCompositions, []);
});

test("elite factions generate faction-feasible balanced, ranged, and assault core proxies", async () => {
  for (const faction of [
    "chaos-knights",
    "grey-knights",
    "imperial-knights",
  ]) {
    const preview = await previewFactionStressPortfolio({
      faction,
      pointsLimit: 1000,
      suite: "core-3",
      pointsTolerancePercent: 5,
      allowLegends: false,
    });
    assert.equal(
      preview.ok,
      true,
      `${faction}: ${preview.violations.map((violation) => violation.message).join("; ")}`,
    );
    assert.equal(preview.data?.gates.completeCoverage, true);
    assert.equal(
      preview.data?.gates.maximumResultStatus,
      "complete",
    );
    assert.deepEqual(
      preview.data?.gates.representedPostures,
      [
        "balanced-control",
        "ranged-pressure",
        "assault-pressure",
      ],
    );
    assert.equal(
      new Set(
        preview.data?.items.map(
          (item) => item.simulationFingerprint,
        ),
      ).size,
      3,
    );
    assert.equal(
      new Set(
        preview.data?.portfolio.items.map(
          (item) => item.composition,
        ),
      ).size,
      1,
      "repeated descriptive composition labels must not degrade core-3",
    );
    assert.deepEqual(preview.data?.gates.missingCompositions, []);
  }
});

test("Custodes portfolios use feasible faction-relative density", async () => {
  const core = await previewFactionStressPortfolio({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    suite: "core-3",
    pointsTolerancePercent: 5,
    allowLegends: false,
  });
  assert.equal(
    core.ok,
    true,
    core.violations.map((violation) => violation.message).join("; "),
  );
  assert.equal(core.data?.gates.executionViable, true);
  assert.equal(core.data?.gates.completeCoverage, true);
  assert.equal(core.data?.gates.maximumResultStatus, "complete");
  assert.ok(
    core.data?.portfolio.items
      .filter((item) => item.status === "ready")
      .every(
        (item) =>
          (item.traits?.eliteHeavyPointsPercent ?? 0) >= 0.45,
      ),
  );

  const diverse = await previewFactionStressPortfolio({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    suite: "diverse-9",
    pointsTolerancePercent: 5,
    allowLegends: false,
  });
  assert.equal(diverse.ok, true);
  assert.equal(diverse.data?.gates.executionViable, true);
  assert.equal(diverse.data?.gates.completeCoverage, true);
  assert.equal(diverse.data?.gates.maximumResultStatus, "complete");
  assert.equal(diverse.data?.gates.minimumUniqueRequired, 6);
  assert.equal(diverse.data?.gates.uniqueSimulationPayloads, 9);
  assert.deepEqual(diverse.data?.gates.missingCells, []);
});

test("Aeldari 2000 produces nine payload-distinct adaptive stress proxies", async () => {
  const preview = await previewFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 2000,
    suite: "diverse-9",
    pointsTolerancePercent: 5,
    allowLegends: false,
  });
  assert.equal(
    preview.ok,
    true,
    preview.violations.map((violation) => violation.message).join("; "),
  );
  const previewData = preview.data;
  assert.ok(previewData);
  assert.equal(previewData.gates.completeCoverage, true);
  assert.equal(previewData.gates.maximumResultStatus, "complete");
  assert.equal(previewData.gates.minimumUniqueRequired, 6);
  assert.equal(previewData.gates.uniqueSimulationPayloads, 9);
  assert.equal(previewData.gates.exportable, 9);
  assert.deepEqual(previewData.gates.missingCells, []);
  assert.equal(
    previewData.portfolio.contract?.lensDefinition?.metricVersion,
    "roster-threat-properties-v1",
  );
  assert.equal(
    previewData.portfolio.contract?.lensDefinition?.reviewStatus,
    "generated-pending-review",
  );
  assert.deepEqual(
    previewData.portfolio.contract?.lensDefinition?.metrics,
    [
      "model-density",
      "points-per-model",
      "infantry-share",
      "vehicle-monster-share",
      "ranged-pressure",
      "melee-pressure",
      "mobility",
      "unit-concentration",
    ],
  );
  assert.equal(
    previewData.portfolio.contract?.lensDefinition?.postures.length,
    3,
  );
  assert.equal(
    new Set(
      previewData.items.map(
        (item) => item.simulationFingerprint,
      ),
    ).size,
    9,
  );

  for (const posture of [
    "balanced-control",
    "ranged-pressure",
    "assault-pressure",
  ] as const) {
    const postureItems: TesseraStressPortfolioItem[] =
      previewData.portfolio.items.filter(
        (item) => item.posture === posture,
      );
    const mass = postureItems.find(
      (item) => item.composition === "mass",
    );
    const mixed = postureItems.find(
      (item) => item.composition === "mixed",
    );
    const elite = postureItems.find(
      (item) => item.composition === "elite-heavy",
    );
    assert.equal(mass?.status, "ready");
    assert.equal(mixed?.status, "ready");
    assert.equal(elite?.status, "ready");
    assert.ok(
      (mass?.traits?.modelCount ?? 0) >=
        (mixed?.traits?.modelCount ?? 0),
    );
    assert.ok(
      (mixed?.traits?.modelCount ?? 0) >=
        (elite?.traits?.modelCount ?? 0),
    );
    assert.match(
      mass?.compositionEvidence.join(" ") ?? "",
      /horde-tagged points \(context only; not a gate\)/i,
    );
  }
  assert.equal(
    previewData.gates.namedCharacterCoverageStatus,
    "buildable-not-simulated",
  );
  assert.equal(previewData.gates.namedCharacterCoverage, false);
});

test("diverse-9 expands a constrained faction pool until every cell has a unique payload", async () => {
  const preview = await previewFactionStressPortfolio({
    faction: "chaos-knights",
    pointsLimit: 1000,
    suite: "diverse-9",
    pointsTolerancePercent: 5,
    allowLegends: false,
  });
  assert.equal(preview.ok, true);
  assert.ok(preview.data);
  assert.equal(preview.data.gates.minimumUniqueRequired, 6);
  assert.equal(preview.data.gates.executionViable, true);
  assert.equal(preview.data.gates.completeCoverage, true);
  assert.equal(preview.data.gates.allPosturesRepresented, true);
  assert.equal(preview.data.gates.accepted, true);
  assert.equal(preview.data.gates.uniqueSimulationPayloads, 9);
  const unavailable = preview.data.portfolio.items.filter(
    (item) => item.status === "unavailable",
  );
  assert.equal(unavailable.length, 0);
});

test("shared portfolio contract requires three core postures and release-bound diverse exceptions", () => {
  const generatedCore = generateFactionStressPortfolio({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    suite: "core-3",
  });
  assert.ok(generatedCore.data);
  const incompleteCore = structuredClone(generatedCore.data);
  const removedCore = incompleteCore.items[0];
  removedCore.status = "unavailable";
  removedCore.roster = null;
  removedCore.simulationFingerprint = null;
  const coreContract =
    evaluateTesseraStressPortfolioContract(incompleteCore);
  assert.equal(coreContract.accepted, false);
  assert.equal(coreContract.minimumUniqueRequired, 3);
  assert.equal(
    coreContract.violation?.code,
    "PORTFOLIO_CONTRACT_UNMET",
  );

  const generatedDiverse = generateFactionStressPortfolio({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    suite: "diverse-9",
  });
  assert.ok(generatedDiverse.data);
  const reviewed = structuredClone(generatedDiverse.data);
  for (const item of reviewed.items.filter(
    (candidate) => candidate.composition === "mass",
  )) {
    item.status = "unavailable";
    item.roster = null;
    item.simulationFingerprint = null;
    item.omissionReason =
      "Reviewed fixture exception for this exact cell.";
    item.warnings = [
      {
        code: "STRESS_TEMPLATE_NOT_APPLICABLE",
        message:
          "This exact faction cell was reviewed and is not applicable.",
        severity: "warn",
      },
    ];
  }
  const degraded =
    evaluateTesseraStressPortfolioContract(reviewed);
  assert.equal(degraded.accepted, false);
  assert.equal(degraded.maximumResultStatus, null);
  assert.equal(degraded.uniqueSimulationPayloads, 6);
  assert.equal(degraded.minimumPosturesRequired, 3);
  assert.equal(
    degraded.reviewedNotApplicableTemplateIds.length,
    0,
  );
  assert.equal(
    degraded.unreviewedMissingTemplateIds.length,
    3,
  );
  assert.equal(
    degraded.violation?.code,
    "PORTFOLIO_CONTRACT_UNMET",
  );

  reviewed.items.find(
    (item) =>
      item.status === "unavailable" &&
      item.composition === "mass",
  )!.warnings = [
    {
      code: "STRESS_TEMPLATE_UNREVIEWED",
      message: "This missing cell has not been reviewed.",
      severity: "warn",
    },
  ];
  const unreviewed =
    evaluateTesseraStressPortfolioContract(reviewed);
  assert.equal(unreviewed.accepted, false);
  assert.equal(
    unreviewed.violation?.code,
    "PORTFOLIO_CONTRACT_UNMET",
  );
  assert.equal(unreviewed.unreviewedMissingTemplateIds.length, 3);

  const tamperedLens = structuredClone(generatedDiverse.data);
  assert.ok(tamperedLens.contract?.lensDefinition);
  tamperedLens.contract.lensDefinition.postures[0].ranges.modelCount[0] +=
    1;
  const tamperedContract =
    evaluateTesseraStressPortfolioContract(tamperedLens);
  assert.equal(tamperedContract.accepted, false);
  assert.equal(
    tamperedContract.violation?.code,
    "PORTFOLIO_CONTRACT_UNMET",
  );
});

test("mission readiness uses scaled thresholds and structured provenance", () => {
  const result = analyzeMissionReadiness(
    roster("adeptus-custodes", 1000),
  );
  assert.equal(result.ok, true);
  assert.ok(result.data);
  assert.equal(result.data.scoreDefinitionVersion, "mission-readiness-v1");
  assert.equal(result.data.primaryMissions.length, 5);
  assert.ok(result.data.secondaryCards.length > 0);
  assert.deepEqual(
    result.data.dimensions.map((dimension) => dimension.id),
    [
      "scoring-breadth",
      "control-depth",
      "reach",
      "action-economy",
      "durable-contesting",
      "home-continuity",
    ],
  );

  const scoring = result.data.dimensions.find(
    (dimension) => dimension.id === "scoring-breadth",
  );
  assert.equal(scoring?.metrics[0].redBelow, 4);
  assert.equal(scoring?.metrics[0].greenAtOrAbove, 6);
  assert.ok(
    result.data.dimensions
      .flatMap((dimension) => dimension.metrics)
      .flatMap((metric) => metric.sourcePaths)
      .every(
        (sourcePath) =>
          !sourcePath.includes("/name") &&
          !sourcePath.includes("/text") &&
          !sourcePath.includes("/description"),
      ),
  );

  const strikeForce = analyzeMissionReadiness(
    roster("adeptus-custodes", 2000),
  );
  assert.equal(strikeForce.ok, true);
  const strikeScoring = strikeForce.data?.dimensions
    .find((dimension) => dimension.id === "scoring-breadth")
    ?.metrics[0];
  assert.ok(strikeScoring);
  assert.equal(
    strikeScoring.normalizedValue,
    strikeScoring.value / 2,
  );
});

test("mission readiness fails closed and revision guardrails reject regressions", () => {
  const malformed = analyzeMissionReadiness({
    schemaVersion: 1,
    units: [],
  } as unknown as RosterDraftV1);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.data, null);

  const baselineResult = analyzeMissionReadiness(
    roster("adeptus-custodes"),
  );
  assert.ok(baselineResult.data);
  const baseline = baselineResult.data;
  const revised = structuredClone(
    baseline,
  ) as TesseraMissionReadinessReport;
  const scoring = revised.dimensions.find(
    (dimension) => dimension.id === "scoring-breadth",
  );
  assert.ok(scoring);
  scoring.band = "red";
  revised.overallBand = "red";
  const guardrail = assessMissionReadinessRevisionGuardrail(
    baseline,
    revised,
  );
  assert.equal(guardrail.accepted, false);
  assert.ok(
    guardrail.newRedDimensions.includes("scoring-breadth"),
  );
  assert.ok(
    guardrail.reasons.some((reason) =>
      reason.includes("downgrades overall mission readiness"),
    ),
  );
});
