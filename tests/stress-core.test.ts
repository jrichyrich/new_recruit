import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeMissionReadiness,
  assessMissionReadinessRevisionGuardrail,
  buildRoster,
  exportRoster,
  generateFactionStressPortfolio,
  rosterExecutionFingerprint,
  rosterStructuralDistance,
  rosterStructuralFingerprint,
  validateRoster,
  type RosterDraftV1,
  type TesseraMissionReadinessReport,
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

  const changed: RosterDraftV1 = {
    ...base,
    detachmentId: `${base.detachmentId}-changed`,
  };
  assert.notEqual(
    rosterStructuralFingerprint(base),
    rosterStructuralFingerprint(changed),
  );
  assert.ok(rosterStructuralDistance(base, changed) > 0);
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
  assert.ok(
    diverse.data?.items.some(
      (item) =>
        item.composition === "mass" &&
        item.status === "unavailable" &&
        item.omissionReason,
    ),
  );
  const ready = diverse.data?.items.filter(
    (item) => item.status === "ready",
  );
  assert.ok(ready);
  assert.equal(
    new Set(ready.map((item) => item.fingerprint)).size,
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
    if (item.composition === "elite-heavy") {
      assert.ok((item.traits?.eliteHeavyPointsPercent ?? 0) >= 0.4);
    }
  }
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
