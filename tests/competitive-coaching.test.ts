import assert from "node:assert/strict";
import test from "node:test";

import {
  FOUNDATION_CODEX_V2_HEURISTIC_PACK,
  FOUNDATION_CODEX_V2_HEURISTIC_PACK_SHA256,
} from "../lib/rosterpilot/competitive-heuristics";
import {
  analyzeCompetitiveCoaching,
  type CompetitiveCoachingReport,
} from "../lib/rosterpilot/competitive-coaching";
import {
  buildRoster,
  resolveFactionUnit,
} from "../lib/rosterpilot/engine";
import {
  canonicalJson,
  sha256Hex,
} from "../lib/rosterpilot/semantic-hash";
import type { RosterDraftV1 } from "../lib/rosterpilot/types";

function buildFixture(): RosterDraftV1 {
  const built = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1_000,
    preferences: ["objective", "mobility"],
    legendsPolicy: "exclude",
    requiredUnitIds: ["blade-champion", "prosecutors"],
  });
  assert.equal(built.ok, true, JSON.stringify(built.violations));
  assert.ok(built.data);
  return built.data;
}

function requireReport(
  result: ReturnType<typeof analyzeCompetitiveCoaching>,
): CompetitiveCoachingReport {
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.ok(result.data);
  return result.data;
}

test("pins the calibrated Foundation Codex V2 heuristic pack by canonical hash", async () => {
  assert.equal(
    FOUNDATION_CODEX_V2_HEURISTIC_PACK.authority.officialRules,
    false,
  );
  assert.equal(
    FOUNDATION_CODEX_V2_HEURISTIC_PACK.authority.treatment,
    "calibrated-heuristics",
  );
  assert.deepEqual(
    FOUNDATION_CODEX_V2_HEURISTIC_PACK.applicability.gameEditions,
    ["11th"],
  );
  assert.match(
    FOUNDATION_CODEX_V2_HEURISTIC_PACK_SHA256,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(
    await sha256Hex(
      canonicalJson(FOUNDATION_CODEX_V2_HEURISTIC_PACK),
    ),
    FOUNDATION_CODEX_V2_HEURISTIC_PACK_SHA256,
  );
  assert.match(
    FOUNDATION_CODEX_V2_HEURISTIC_PACK.principles.find(
      (principle) => principle.id === "objective-control-efficiency",
    )?.calibration ?? "",
    /not a legality rule or universal quality threshold/i,
  );
});

test("produces deterministic concise coaching from validated roster and mission data", () => {
  const roster = buildFixture();
  const result = analyzeCompetitiveCoaching(roster);
  const report = requireReport(result);

  assert.equal(report.mode, "concise");
  assert.equal(report.reportKind, "competitive-coaching");
  assert.equal(report.heuristicPack.officialRules, false);
  assert.equal(
    report.heuristicPack.contentSha256,
    FOUNDATION_CODEX_V2_HEURISTIC_PACK_SHA256,
  );
  assert.notEqual(
    report.heuristicPack.contentSha256,
    roster.sourceData.rosterRulesHash,
  );
  assert.equal(report.units.length, roster.units.length);
  assert.equal(
    report.rosterFingerprint,
    report.missionReadiness.rosterFingerprint,
  );
  assert.equal(
    report.summary.missionReadinessBand,
    report.missionReadiness.overallBand,
  );
  assert.equal(
    report.summary.selectionActivationUpperBound,
    roster.units.length,
  );
  assert.equal(
    report.summary.activationEstimateBasis,
    "roster-selections-before-attachments",
  );
  assert.equal(
    report.applicability.missionSpecific.status,
    "omitted-mode",
  );
  assert.equal(
    report.applicability.terrainSpecific.status,
    "omitted-mode",
  );

  assert.ok(report.units.every((unit) => unit.roles.length > 0));
  assert.ok(report.units.some((unit) => unit.roles.length > 1));
  assert.ok(
    report.units.some((unit) =>
      unit.roles.some((role) => role.role === "force-multiplier"),
    ),
  );
  assert.ok(
    report.units.some((unit) =>
      unit.roles.some((role) => role.role === "tech-piece"),
    ),
  );
  assert.ok(
    report.units.some((unit) =>
      unit.roles.some((role) => role.role === "anvil"),
    ),
  );

  const prosecutor = report.units.find(
    (unit) => unit.unitId === "prosecutors",
  );
  assert.ok(prosecutor);
  assert.equal(
    prosecutor.metrics.totalObjectiveControl,
    prosecutor.modelCount * 2,
  );
  assert.equal(
    prosecutor.metrics.objectiveControlPerPoint,
    Math.round(
      ((prosecutor.modelCount * 2) / prosecutor.points +
        Number.EPSILON) *
        1_000_000,
    ) / 1_000_000,
  );
  assert.equal(
    prosecutor.metrics.contextualOcBenchmark.comparison,
    "above-or-equal",
  );
  assert.equal(
    prosecutor.metrics.contextualOcBenchmark.authority,
    "contextual-heuristic",
  );
  assert.ok(prosecutor.mobility.sourcePaths.length > 0);
  assert.ok(prosecutor.actionEconomy.sourcePaths.length > 0);
  assert.match(report.disclaimer, /not an official rule/i);
});

test("resolves inherited chapter datasheets through faction ancestry", () => {
  const built = buildRoster({
    playerFaction: "ultramarines",
    pointsLimit: 1_000,
    preferences: ["objective", "mobility"],
    legendsPolicy: "exclude",
  });
  assert.equal(built.ok, true, JSON.stringify(built.violations));
  assert.ok(built.data);

  const inherited = built.data.units.map((selection) =>
    resolveFactionUnit(selection.unitId, built.data!.factionId),
  );
  assert.ok(inherited.every((unit) => unit !== undefined));
  assert.ok(
    inherited.some(
      (unit) => unit?.raw.faction_id === "adeptus-astartes",
    ),
  );

  const result = analyzeCompetitiveCoaching(built.data);
  const report = requireReport(result);
  assert.equal(report.units.length, built.data.units.length);
  assert.equal(
    result.warnings.some(
      (warning) =>
        warning.code === "COACHING_UNIT_PROFILE_UNRESOLVED",
    ),
    false,
  );
  assert.ok(
    report.units.every(
      (unit) =>
        unit.metrics.totalWounds !== null &&
        unit.metrics.totalObjectiveControl !== null,
    ),
  );
});

test("full coaching omits and flags mission and terrain advice without context", () => {
  const result = analyzeCompetitiveCoaching(buildFixture(), {
    mode: "full",
  });
  const report = requireReport(result);

  assert.equal(
    report.applicability.missionSpecific.status,
    "omitted-missing-context",
  );
  assert.equal(
    report.applicability.terrainSpecific.status,
    "omitted-missing-context",
  );
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code === "COACHING_MISSION_CONTEXT_REQUIRED",
    ),
  );
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code === "COACHING_TERRAIN_CONTEXT_REQUIRED",
    ),
  );
  assert.equal(
    report.advice.some(
      (entry) =>
        entry.category === "mission" || entry.category === "terrain",
    ),
    false,
  );
  assert.ok(
    report.advice.some((entry) => entry.category === "variance"),
  );
});

test("full coaching applies supplied mission and terrain context without certifying it", () => {
  const result = analyzeCompetitiveCoaching(buildFixture(), {
    mode: "full",
    missionContext: {
      missionPackId: "example-tournament-pack",
      missionId: "example-mission",
    },
    terrainContext: {
      formatId: "WTC",
      layoutId: "example-layout",
    },
  });
  const report = requireReport(result);

  assert.equal(report.applicability.missionSpecific.status, "applied");
  assert.equal(report.applicability.terrainSpecific.status, "applied");
  assert.equal(
    result.warnings.some((warning) =>
      warning.code.startsWith("COACHING_MISSION_CONTEXT"),
    ),
    false,
  );
  assert.equal(
    result.warnings.some((warning) =>
      warning.code.startsWith("COACHING_TERRAIN_CONTEXT"),
    ),
    false,
  );
  const missionAdvice = report.advice.find(
    (entry) => entry.category === "mission",
  );
  const terrainAdvice = report.advice.find(
    (entry) => entry.category === "terrain",
  );
  assert.match(missionAdvice?.text ?? "", /example-tournament-pack/);
  assert.match(missionAdvice?.text ?? "", /official mission rules/i);
  assert.match(terrainAdvice?.text ?? "", /WTC/);
  assert.match(terrainAdvice?.text ?? "", /does not certify/i);
});

test("fails closed when the supplied roster no longer validates", () => {
  const roster = buildFixture();
  const invalid = {
    ...roster,
    totalPoints: roster.totalPoints + 1,
  };
  const result = analyzeCompetitiveCoaching(invalid);

  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.ok(result.violations.length > 0);
});
