import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dataset,
  factions,
  tryImportRoster,
} from "@alpaca-software/40kdc-data";
import { unzipSync, strFromU8 } from "fflate";

import {
  baselineDamageCells,
  buildRoster,
  checkDataFreshness,
  compareOpponentRosterOptions,
  explainRoster,
  exportRoster,
  generateFactionStressPortfolio,
  getDataStatus,
  getNewRecruitCapability,
  modifyRoster,
  modifyRosterBatch,
  parseRosterDraft,
  prepareNewRecruitHandoff,
  searchFactions,
  searchUnits,
  toCanonicalRoster,
  rosterStructuralFingerprint,
  validateRoster,
  type BuildRosterInput,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import {
  conflictBlocksAllUnitConfigurations,
  conflictsForRoster,
  newRecruitCatalogue,
} from "../lib/rosterpilot/catalogue-summary";
import { getNewRecruitFactionCatalogue } from "../lib/rosterpilot/catalogue";
import type { DataConflict } from "../lib/rosterpilot/catalogue-types";
import { resolveUnitCopyLimit } from "../lib/rosterpilot/copy-limits";
import { resolveFactionIntent } from "../lib/rosterpilot/faction-intent";
import {
  writeExportArtifact,
  writeExportArtifacts,
} from "../lib/rosterpilot/io";

const fixtures = new URL("./fixtures/", import.meta.url);

function installSyntheticConflict(conflict: DataConflict): () => void {
  const conflicts =
    newRecruitCatalogue.factions[conflict.factionId]?.conflicts;
  assert.ok(conflicts, `Missing conflict fixture faction ${conflict.factionId}`);
  conflicts.push(conflict);
  return () => {
    const index = conflicts.indexOf(conflict);
    if (index >= 0) conflicts.splice(index, 1);
  };
}

function minimalCustodesRoster(
  allowNamedCharacters = false,
): RosterDraftV1 {
  const built = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 2000,
    allowNamedCharacters,
    requiredWarlordUnitId: "blade-champion",
    detachmentId: "shield-host",
  });
  assert.ok(
    built.ok && built.data,
    built.violations.map((violation) => violation.message).join("; "),
  );
  const warlord = built.data.units.find((selection) => selection.isWarlord);
  assert.equal(warlord?.unitId, "blade-champion");
  const reduced = modifyRosterBatch(
    built.data,
    built.data.units
      .filter((selection) => selection.selectionId !== warlord.selectionId)
      .map((selection) => ({
        type: "remove" as const,
        selectionId: selection.selectionId,
      })),
  );
  assert.ok(
    reduced.ok && reduced.data,
    reduced.violations.map((violation) => violation.message).join("; "),
  );
  return reduced.data;
}

test("searches and builds real faction data across the supported catalog", () => {
  const factionResult = searchFactions("custodes");
  assert.equal(factionResult.ok, true);
  assert.equal(factionResult.data?.[0].id, "adeptus-custodes");
  assert.equal(factionResult.data?.[0].supported, true);

  const unitResult = searchUnits({
    faction: "adeptus-custodes",
    query: "praetors",
  });
  assert.equal(unitResult.ok, true);
  assert.ok(unitResult.data?.some((unit) => unit.id === "vertus-praetors"));

  const spaceWolves = searchUnits({
    faction: "space-wolves",
    query: "Intercessor",
    limit: 30,
  });
  assert.equal(spaceWolves.ok, true);
  assert.ok(spaceWolves.data?.some((unit) => unit.id === "intercessor-squad"));
  assert.ok(
    spaceWolves.data?.every((unit) => unit.pointsFrom > 0),
    "Combat Patrol-only datasheets leaked into matched-play research",
  );
  assert.ok(
    spaceWolves.data?.every((unit) =>
      !/assault force|sanguinary spearhead|vengeful brethren/i.test(unit.name)
    ),
  );

  const spaceWolvesByName = searchUnits({
    faction: "Space Wolves",
    query: "",
    limit: 100,
  });
  assert.equal(spaceWolvesByName.ok, true);
  assert.ok(
    spaceWolvesByName.data?.every((unit) => unit.pointsFrom > 0),
    "Combat Patrol-only datasheets leaked into name-based matched-play research",
  );
  assert.ok(
    spaceWolvesByName.data?.every((unit) =>
      !/askar|assault force|sanguinary spearhead|vengeful brethren/i.test(
        unit.name,
      )
    ),
  );

  const aeldari = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    preferences: ["mobility", "shooting", "objective"],
  });
  assert.equal(aeldari.ok, true);
  assert.equal(aeldari.data?.factionId, "aeldari");
  assert.ok((aeldari.data?.totalPoints ?? 0) >= 980);
  assert.ok(aeldari.data?.units.some((unit) => unit.tags.includes("mobility")));
});

test("adds a parent-catalogue unit onto a successor-faction roster", () => {
  const built = buildRoster({
    playerFaction: "space-wolves",
    pointsLimit: 1_000,
    requiredUnitIds: ["blood-claws"],
    name: "Fenris parent catalogue add",
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(built.data);
  let current = built.data;
  for (const unit of [...current.units].reverse()) {
    if (current.totalPoints + 80 <= current.pointsLimit) break;
    if (unit.unitId === "blood-claws" || unit.isWarlord) continue;
    const removed = modifyRoster(current, {
      type: "remove",
      selectionId: unit.selectionId,
    });
    assert.equal(
      removed.ok,
      true,
      removed.violations.map((violation) => violation.message).join("; "),
    );
    current = removed.data!;
  }
  const added = modifyRoster(current, {
    type: "add",
    unitId: "intercessor-squad",
    modelCount: 5,
  });
  assert.equal(
    added.ok,
    true,
    added.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(
    added.data?.units.some((unit) => unit.unitId === "intercessor-squad"),
  );
});

test("distinguishes the player faction from an opponent in prose", () => {
  const inferred = buildRoster({
    prompt:
      "Build a 1000 point Aeldari army to battle an unknown Adeptus Custodes list.",
    pointsLimit: 1000,
  });
  assert.equal(
    inferred.ok,
    true,
    inferred.violations.map((violation) => violation.message).join("; "),
  );
  assert.equal(inferred.data?.factionId, "aeldari");
  assert.equal(
    inferred.data?.constraints.opponentFactionId,
    "adeptus-custodes",
  );

  const explicit = buildRoster({
    prompt:
      "Build a 1000 point Aeldari army to battle an unknown Adeptus Custodes list.",
    playerFaction: "aeldari",
    pointsLimit: 1000,
    opponentContext: {
      kind: "known-faction",
      factionId: "adeptus-custodes",
    },
  });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.data?.factionId, "aeldari");
  assert.equal(
    explicit.data?.constraints.opponentFactionId,
    "adeptus-custodes",
  );
  const explanation = explainRoster(explicit.data!);
  assert.equal(
    explanation.data?.optimizer.generatorVersion,
    "beam-search-v1",
  );
  assert.deepEqual(
    explanation.data?.optimizer.scoreOrder.slice(0, 3),
    [
      "hard constraints and legality",
      "points utilization",
      "mission readiness",
    ],
  );
  assert.equal(
    explanation.data?.optimizer.targetProfileCoverage
      ?.opponentFactionId,
    "adeptus-custodes",
  );
  assert.ok(
    explanation.data?.optimizer.selectedCandidates.every(
      (candidate) =>
        Number.isFinite(candidate.components.total),
    ),
  );
});

test("keeps Warlord-only candidates structurally distinct and repeatable", () => {
  const built = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);
  const firstUnit = built.data.units[0];
  const alternateUnit = built.data.units.find(
    (unit) => unit.unitId !== firstUnit?.unitId,
  );
  assert.ok(firstUnit && alternateUnit);

  const withFirstWarlord = structuredClone(built.data);
  const withAlternateWarlord = structuredClone(built.data);
  for (const unit of withFirstWarlord.units) {
    unit.isWarlord = unit.selectionId === firstUnit.selectionId;
  }
  for (const unit of withAlternateWarlord.units) {
    unit.isWarlord =
      unit.selectionId === alternateUnit.selectionId;
  }

  const firstFingerprint = rosterStructuralFingerprint(
    withFirstWarlord,
  );
  const alternateFingerprint = rosterStructuralFingerprint(
    withAlternateWarlord,
  );
  assert.notEqual(firstFingerprint, alternateFingerprint);

  const deterministicRepeat = structuredClone(withFirstWarlord);
  deterministicRepeat.name = "Presentation-only rename";
  deterministicRepeat.units.reverse();
  for (const unit of deterministicRepeat.units) {
    unit.equipment.reverse();
  }
  assert.equal(
    rosterStructuralFingerprint(deterministicRepeat),
    firstFingerprint,
  );

  const candidateRefs = new Map([
    [firstFingerprint, "rosterpilot://rosters/warlord-first"],
    [alternateFingerprint, "rosterpilot://rosters/warlord-alternate"],
  ]);
  assert.equal(candidateRefs.size, 2);
  assert.notEqual(
    candidateRefs.get(firstFingerprint),
    candidateRefs.get(alternateFingerprint),
  );
});

test("renames a roster without changing its army structure", () => {
  const built = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(built.ok && built.data);

  const originalFingerprint = rosterStructuralFingerprint(built.data);
  const renamed = modifyRoster(built.data, {
    type: "set-name",
    name: "  Custodes Praetorian Spearhead  ",
  });

  assert.ok(renamed.ok && renamed.data);
  assert.equal(renamed.data.name, "Custodes Praetorian Spearhead");
  assert.equal(
    rosterStructuralFingerprint(renamed.data),
    originalFingerprint,
  );
  assert.notEqual(renamed.data.id, built.data.id);
  assert.equal(validateRoster(renamed.data).ok, true);
});

test("builds against an exact opponent roster and records owned-model limits", () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
    preferences: ["shooting", "mobility"],
  });
  assert.ok(opponent.ok && opponent.data);
  const seed = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(seed.ok && seed.data);
  const ownedUnits = [...new Set(seed.data.units.map((unit) => unit.unitId))]
    .map((unitId) => {
      const selections = seed.data!.units.filter(
        (unit) => unit.unitId === unitId,
      );
      return {
        unitId,
        maxUnits: selections.length,
        maxModels: selections.reduce(
          (sum, unit) => sum + unit.modelCount,
          0,
        ),
      };
    });
  const matchup = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    collectionProfile: {
      mode: "owned",
      units: ownedUnits,
    },
    opponentContext: {
      kind: "known-roster",
      roster: opponent.data,
    },
  });
  assert.ok(
    matchup.ok && matchup.data,
    matchup.violations.map((issue) => issue.message).join("; "),
  );
  assert.equal(
    matchup.data.constraints.opponentFactionId,
    "aeldari",
  );
  assert.ok(matchup.data.constraints.opponentRosterFingerprint);
  assert.equal(
    matchup.data.constraints.opponentThreatProfile?.bodyCount,
    opponent.data.units.reduce(
      (sum, unit) => sum + unit.modelCount,
      0,
    ),
  );
  for (const owned of ownedUnits) {
    const selected = matchup.data.units.filter(
      (unit) => unit.unitId === owned.unitId,
    );
    assert.ok(selected.length <= owned.maxUnits);
    assert.ok(
      selected.reduce((sum, unit) => sum + unit.modelCount, 0) <=
        owned.maxModels,
    );
  }
  const explanation = explainRoster(matchup.data);
  assert.equal(
    explanation.data?.optimizer.targetProfileCoverage
      ?.opponentRosterFingerprint,
    matchup.data.constraints.opponentRosterFingerprint,
  );
});

test("varies deterministic Custodes counters across exact World Eaters archetypes", () => {
  const portfolio = generateFactionStressPortfolio({
    faction: "world-eaters",
    pointsLimit: 1000,
    suite: "diverse-9",
    artifactMode: "canonical",
  });
  assert.ok(
    portfolio.ok && portfolio.data,
    portfolio.violations.map((violation) => violation.message).join("; "),
  );
  const opponents = portfolio.data.items.flatMap((item) =>
    item.status === "ready" && item.roster
      ? [{
          templateId: item.templateId,
          posture: item.posture,
          composition: item.composition,
          roster: item.roster,
        }]
      : [],
  );
  assert.equal(opponents.length, 9);
  const opponentPortfolioHash =
    portfolio.data.contract?.portfolioHash ?? null;
  assert.match(opponentPortfolioHash ?? "", /^[0-9a-f]{64}$/);
  const portfolioBuildInput: BuildRosterInput = {
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    opponentContext: {
      kind: "known-faction",
      factionId: "world-eaters",
      representativeRosters: opponents.map((entry) => entry.roster),
      portfolioHash: opponentPortfolioHash!,
    },
  };
  const portfolioBuild = buildRoster(portfolioBuildInput);
  const repeatedPortfolioBuild = buildRoster(portfolioBuildInput);
  assert.ok(portfolioBuild.ok && portfolioBuild.data);
  assert.ok(repeatedPortfolioBuild.ok && repeatedPortfolioBuild.data);
  assert.equal(portfolioBuild.data.id, repeatedPortfolioBuild.data.id);
  assert.equal(
    portfolioBuild.data.constraints.opponentPortfolioHash,
    opponentPortfolioHash,
  );
  assert.equal(
    portfolioBuild.data.constraints.opponentRosterFingerprints?.length,
    9,
  );
  assert.notEqual(
    portfolioBuild.data.constraints.opponentThreatProfile?.bodyCount,
    null,
  );

  const counters = opponents.map(({ templateId, roster }) => {
    const built = buildRoster({
      playerFaction: "adeptus-custodes",
      pointsLimit: 1000,
      opponentContext: { kind: "known-roster", roster },
    });
    assert.ok(
      built.ok && built.data,
      `${templateId}: ${built.violations
        .map((violation) => violation.message)
        .join("; ")}`,
    );
    assert.ok(built.data.totalPoints >= 980, templateId);
    assert.equal(validateRoster(built.data).ok, true, templateId);
    assert.ok(
      built.data.constraints.opponentRosterFingerprint,
      `${templateId} must retain its exact opponent fingerprint`,
    );
    return { templateId, roster: built.data };
  });
  const structuralFingerprint = (roster: RosterDraftV1) =>
    roster.units
      .map((selection) =>
        [
          selection.unitId,
          selection.modelCount,
          selection.points,
          selection.equipment
            .map((entry) => `${entry.itemId}:${entry.count}`)
            .sort()
            .join(","),
        ].join("|"),
      )
      .sort()
      .join(";");
  assert.ok(
    new Set(
      counters.map(({ roster }) => structuralFingerprint(roster)),
    ).size >= 3,
    "nine materially different opponent rosters must not collapse to one or two Custodes lists",
  );
  assert.equal(
    new Set(
      counters.map(
        ({ roster }) =>
          roster.constraints.opponentRosterFingerprint,
      ),
    ).size,
    9,
  );
  const massCounter = counters.find(
    ({ templateId }) => templateId === "balanced-control:mass",
  );
  const eliteCounter = counters.find(
    ({ templateId }) => templateId === "balanced-control:elite-heavy",
  );
  assert.ok(massCounter && eliteCounter);
  assert.ok(
    massCounter.roster.units.reduce(
      (sum, selection) => sum + selection.modelCount,
      0,
    ) >
      eliteCounter.roster.units.reduce(
        (sum, selection) => sum + selection.modelCount,
        0,
      ),
    "mass and elite-heavy targets must drive materially different body-count responses",
  );
  const selectedUnitIds = new Set(
    counters.flatMap(({ roster }) =>
      roster.units.map((selection) => selection.unitId),
    ),
  );
  assert.ok(
    selectedUnitIds.has("venatari-custodians") ||
      selectedUnitIds.has("vertus-praetors"),
    "the matchup search must retain a mobile Custodes option",
  );
  assert.ok(
    selectedUnitIds.has("caladius-grav-tank") ||
      selectedUnitIds.has("contemptor-achillus-dreadnought") ||
      selectedUnitIds.has("telemon-heavy-dreadnought") ||
      counters.some(({ roster }) =>
        roster.units.some((selection) =>
          selection.equipment.some(
            (equipment) => equipment.itemId === "salvo-launcher",
          )
        )
      ),
    "the matchup search must retain an anti-heavy Custodes option",
  );

  const repeatTarget = opponents.find(
    ({ templateId }) => templateId === "balanced-control:mass",
  );
  assert.ok(repeatTarget);
  const repeated = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    opponentContext: {
      kind: "known-roster",
      roster: repeatTarget.roster,
    },
  });
  assert.ok(repeated.ok && repeated.data);
  const original = counters.find(
    ({ templateId }) => templateId === repeatTarget.templateId,
  );
  assert.ok(original);
  assert.equal(
    structuralFingerprint(repeated.data),
    structuralFingerprint(original.roster),
  );

  const comparisonInput = portfolioBuildInput;
  const baseline = portfolioBuild;
  assert.ok(baseline.ok && baseline.data);
  const comparisons = [0, 1].map(() =>
    compareOpponentRosterOptions({
      buildInput: comparisonInput,
      baselineRoster: baseline.data!,
      opponents,
      opponentPortfolioHash,
      maximumBuilds: 8,
    })
  );
  assert.ok(comparisons.every(
    (comparison) => comparison.ok && comparison.data
  ));
  assert.equal(
    comparisons[0].data!.audit.comparisonFingerprint,
    comparisons[1].data!.audit.comparisonFingerprint,
  );
  assert.deepEqual(
    comparisons[0].data!.candidates.map(
      (candidate) => candidate.simulationFingerprint
    ),
    comparisons[1].data!.candidates.map(
      (candidate) => candidate.simulationFingerprint
    ),
  );
  for (const candidate of comparisons[0].data!.candidates) {
    assert.equal(
      candidate.roster.constraints.opponentFactionId,
      "world-eaters",
    );
    assert.equal(
      candidate.roster.constraints.opponentRosterFingerprint,
      null,
    );
    assert.deepEqual(
      candidate.roster.constraints.requiredUnitIds,
      [],
      "comparison anchors must not be persisted as user requirements",
    );
  }
});

test("records complete bounded catalogue, detachment, Warlord, and profile coverage", () => {
  const opponent = buildRoster({
    playerFaction: "world-eaters",
    pointsLimit: 500,
  });
  assert.ok(opponent.ok && opponent.data);
  const buildInput: BuildRosterInput = {
    playerFaction: "adeptus-custodes",
    pointsLimit: 500,
    opponentContext: {
      kind: "known-roster",
      roster: opponent.data,
    },
  };
  const baseline = buildRoster(buildInput);
  assert.ok(baseline.ok && baseline.data);
  const comparison = compareOpponentRosterOptions({
    buildInput,
    baselineRoster: baseline.data,
    opponents: [{ templateId: "exact", roster: opponent.data }],
    maximumBuilds: 1,
  });
  assert.ok(comparison.ok && comparison.data);

  const invalidOpponent = {
    ...opponent.data,
    totalPoints: opponent.data.totalPoints + 1,
  };
  const rejectedOpponent = compareOpponentRosterOptions({
    buildInput,
    baselineRoster: baseline.data,
    opponents: [{ templateId: "tampered", roster: invalidOpponent }],
    maximumBuilds: 1,
  });
  assert.equal(rejectedOpponent.ok, false);
  assert.equal(
    rejectedOpponent.violations[0]?.code,
    "OPPONENT_COMPARISON_ROSTER_INVALID",
  );

  const tooManyOpponents = compareOpponentRosterOptions({
    buildInput,
    baselineRoster: baseline.data,
    opponents: Array.from({ length: 10 }, (_, index) => ({
      templateId: `limit-${index}`,
      roster: opponent.data!,
    })),
    maximumBuilds: 1,
  });
  assert.equal(tooManyOpponents.ok, false);
  assert.equal(
    tooManyOpponents.violations[0]?.code,
    "OPPONENT_COMPARISON_LIMIT_EXCEEDED",
  );

  const duplicateTemplate = compareOpponentRosterOptions({
    buildInput,
    baselineRoster: baseline.data,
    opponents: [
      { templateId: "duplicate", roster: opponent.data },
      { templateId: "duplicate", roster: opponent.data },
    ],
    maximumBuilds: 1,
  });
  assert.equal(duplicateTemplate.ok, false);
  assert.equal(
    duplicateTemplate.violations[0]?.code,
    "OPPONENT_COMPARISON_DUPLICATE_TEMPLATE_ID",
  );

  const duplicateStructure = compareOpponentRosterOptions({
    buildInput,
    baselineRoster: baseline.data,
    opponents: [
      { templateId: "structural-a", roster: opponent.data },
      { templateId: "structural-b", roster: opponent.data },
    ],
    maximumBuilds: 1,
  });
  assert.equal(duplicateStructure.ok, false);
  assert.equal(
    duplicateStructure.violations[0]?.code,
    "OPPONENT_COMPARISON_DUPLICATE_STRUCTURAL_FINGERPRINT",
  );

  const forgedPortfolioHash = compareOpponentRosterOptions({
    buildInput,
    baselineRoster: baseline.data,
    opponents: [{ templateId: "forged", roster: opponent.data }],
    opponentPortfolioHash: "f".repeat(64),
    maximumBuilds: 1,
  });
  assert.equal(forgedPortfolioHash.ok, false);
  assert.equal(
    forgedPortfolioHash.violations[0]?.code,
    "OPPONENT_COMPARISON_PORTFOLIO_HASH_MISMATCH",
  );
  const forgedPortfolioBuild = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 500,
    opponentContext: {
      kind: "known-faction",
      factionId: "world-eaters",
      representativeRosters: [opponent.data],
      portfolioHash: "f".repeat(64),
    },
  });
  assert.equal(forgedPortfolioBuild.ok, false);
  assert.equal(
    forgedPortfolioBuild.violations[0]?.code,
    "OPPONENT_PORTFOLIO_HASH_MISMATCH",
  );

  const largerOpponent = buildRoster({
    playerFaction: "world-eaters",
    pointsLimit: 1000,
  });
  assert.ok(largerOpponent.ok && largerOpponent.data);
  const mismatchedBuild = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 500,
    opponentContext: {
      kind: "known-roster",
      roster: largerOpponent.data,
    },
  });
  assert.equal(mismatchedBuild.ok, false);
  assert.equal(
    mismatchedBuild.violations[0]?.code,
    "OPPONENT_ROSTER_POINTS_LIMIT_MISMATCH",
  );
  const broadFactionInput: BuildRosterInput = {
    playerFaction: "adeptus-custodes",
    pointsLimit: 500,
    opponentContext: {
      kind: "known-faction",
      factionId: "world-eaters",
    },
  };
  const broadFactionBaseline = buildRoster(broadFactionInput);
  assert.ok(broadFactionBaseline.ok && broadFactionBaseline.data);
  const mismatchedPoints = compareOpponentRosterOptions({
    buildInput: broadFactionInput,
    baselineRoster: broadFactionBaseline.data,
    opponents: [{
      templateId: "wrong-game-size",
      roster: largerOpponent.data,
    }],
    maximumBuilds: 1,
  });
  assert.equal(mismatchedPoints.ok, false);
  assert.equal(
    mismatchedPoints.violations[0]?.code,
    "OPPONENT_COMPARISON_POINTS_LIMIT_MISMATCH",
  );

  const necronOpponent = buildRoster({
    playerFaction: "necrons",
    pointsLimit: 500,
  });
  assert.ok(necronOpponent.ok && necronOpponent.data);
  const contradictoryOpponent = compareOpponentRosterOptions({
    buildInput,
    baselineRoster: baseline.data,
    opponents: [{ templateId: "necrons", roster: necronOpponent.data }],
    maximumBuilds: 1,
  });
  assert.equal(contradictoryOpponent.ok, false);
  assert.equal(
    contradictoryOpponent.violations[0]?.code,
    "OPPONENT_COMPARISON_BASELINE_OPPONENT_MISMATCH",
  );

  const contradictoryContext = compareOpponentRosterOptions({
    buildInput: {
      ...buildInput,
      opponentContext: {
        kind: "known-roster",
        roster: necronOpponent.data,
      },
    },
    baselineRoster: baseline.data,
    opponents: [{ templateId: "world-eaters", roster: opponent.data }],
    maximumBuilds: 1,
  });
  assert.equal(contradictoryContext.ok, false);
  assert.equal(
    contradictoryContext.violations[0]?.code,
    "OPPONENT_COMPARISON_OPPONENT_CONTEXT_MISMATCH",
  );

  const necronBaseline = buildRoster({
    playerFaction: "necrons",
    pointsLimit: 500,
    opponentContext: {
      kind: "known-roster",
      roster: opponent.data,
    },
  });
  assert.ok(necronBaseline.ok && necronBaseline.data);
  const contradictoryBaseline = compareOpponentRosterOptions({
    buildInput,
    baselineRoster: necronBaseline.data,
    opponents: [{ templateId: "world-eaters", roster: opponent.data }],
    maximumBuilds: 1,
  });
  assert.equal(contradictoryBaseline.ok, false);
  assert.equal(
    contradictoryBaseline.violations[0]?.code,
    "OPPONENT_COMPARISON_BASELINE_INPUT_MISMATCH",
  );

  const { audit, candidates } = comparison.data;
  assert.equal(audit.method, "stratified-catalogue-axis-comparison-v3");
  assert.equal(audit.opponents[0]?.rosterId, opponent.data.id);
  assert.equal(
    audit.opponents[0]?.structuralFingerprint,
    rosterStructuralFingerprint(opponent.data),
  );
  assert.equal(audit.coverage.catalogueComplete, true);
  assert.equal(audit.coverage.catalogueMayBeTruncated, false);
  assert.equal(audit.coverage.coverageMode, "bounded");
  assert.equal(audit.coverage.catalogueRows, 35);
  assert.equal(audit.coverage.allied.rulesOffered, 2);
  assert.equal(audit.coverage.allied.ruleRows, 51);
  assert.equal(audit.coverage.allied.uniqueDatasheets, 51);
  assert.equal(audit.coverage.allied.inventoryOnly, 51);
  assert.equal(audit.coverage.allied.selectable, 0);
  assert.equal(audit.coverage.allied.attempted, 0);
  assert.equal(audit.coverage.allied.expansionSupported, false);
  assert.equal(
    audit.coverage.terminalLedgerRows,
    audit.coverage.catalogueRows + audit.coverage.allied.ruleRows,
  );
  assert.equal(
    audit.ledger.length,
    audit.coverage.catalogueRows + audit.coverage.allied.ruleRows,
  );
  assert.ok(audit.coverage.catalogueRows > audit.coverage.maximumBuilds);
  assert.equal(audit.coverage.legal, 1);
  assert.equal(audit.coverage.budgetExhausted, true);
  assert.equal(audit.coverage.detachments.mode, "enumerated");
  assert.ok(
    audit.coverage.detachments.evaluatedIds.every((detachmentId) =>
      audit.coverage.detachments.eligibleIds.includes(detachmentId)
    ),
  );
  assert.ok(
    audit.coverage.detachments.evaluatedIds.includes(
      baseline.data.detachmentId,
    ),
  );
  assert.ok(
    audit.coverage.detachments.evaluatedIds.length <=
      audit.coverage.maximumBuilds + 1,
  );
  assert.ok(
    audit.coverage.detachments.evaluatedIds.length <
      audit.coverage.detachments.eligibleIds.length,
  );
  assert.deepEqual(
    [...new Set([
      ...audit.coverage.detachments.successfulIds,
      ...audit.coverage.detachments.failures.map(
        (failure) => failure.detachmentId,
      ),
    ])].sort(),
    audit.coverage.detachments.evaluatedIds,
  );
  assert.ok(audit.coverage.detachments.successfulIds.length > 1);
  assert.equal(audit.coverage.warlords.mode, "stratified");
  assert.ok(audit.coverage.warlords.eligibleIds.length > 1);
  assert.ok(audit.coverage.warlords.evaluatedIds.length > 1);
  assert.ok(
    audit.ledger
      .filter(
        (entry) =>
          entry.origin === "faction-native" &&
          entry.status !== "ineligible",
      )
      .every(
        (entry) =>
          entry.detachmentId !== null && entry.warlordUnitId !== null,
      ),
  );
  const alliedLedger = audit.ledger.filter(
    (entry) => entry.origin === "allied-rule",
  );
  assert.equal(alliedLedger.length, 51);
  assert.ok(alliedLedger.every(
    (entry) =>
      entry.status === "inventory-only" &&
      entry.reasonCode === "ALLIED_CONSTRUCTION_UNSUPPORTED" &&
      entry.structuralFingerprint === null &&
      entry.simulationFingerprint === null &&
      entry.warlordUnitId === null,
  ));
  assert.match(
    audit.source.alliedInventoryHash ?? "",
    /^[0-9a-f]{64}$/,
  );
  const draxus = alliedLedger.find(
    (entry) => entry.unitId === "inquisitor-draxus",
  );
  assert.ok(draxus);
  assert.equal(draxus.sourceFactionId, "agents-of-the-imperium");
  assert.equal(draxus.alliedRuleId, "agents-of-the-imperium-allies");
  assert.equal(draxus.pointsFrom, 110);
  assert.equal(draxus.pricingBasis, "allied");
  assert.equal(draxus.alliedPriceHostKey, "imperium");
  assert.ok(candidates.every(
    (candidate) => !candidate.anchorUnitIds.includes("inquisitor-draxus")
  ));
  for (const unitId of [
    "venatari-custodians",
    "vertus-praetors",
    "contemptor-achillus-dreadnought",
    "contemptor-galatus-dreadnought",
    "venerable-contemptor-dreadnought",
    "telemon-heavy-dreadnought",
    "caladius-grav-tank",
    "pallas-grav-attack",
  ]) {
    const entry = audit.ledger.find((candidate) =>
      candidate.unitId === unitId
    );
    assert.ok(entry, `${unitId} must have a terminal ledger row`);
    assert.ok(
      entry.structuralFingerprint || entry.reasonCode,
      `${unitId} must have candidate evidence or an explicit reason`,
    );
  }
  assert.ok(
    candidates.some((candidate) =>
      candidate.matchupScores.some(
        (matchup) =>
          matchup.missingProfileCellCount > 0 &&
          matchup.evidenceCompleteness < 1,
      )
    ),
    "cells without weapon-profile evidence must be incomplete, not complete zero-output evidence",
  );

  const pinned = compareOpponentRosterOptions({
    buildInput: {
      ...buildInput,
      detachmentId: baseline.data.detachmentId,
    },
    baselineRoster: baseline.data,
    opponents: [{ templateId: "exact", roster: opponent.data }],
    maximumBuilds: 1,
  });
  assert.ok(pinned.ok && pinned.data);
  assert.equal(pinned.data.audit.coverage.detachments.mode, "pinned");
  assert.deepEqual(
    pinned.data.audit.coverage.detachments.eligibleIds,
    [baseline.data.detachmentId],
  );
  assert.deepEqual(
    pinned.data.audit.coverage.detachments.evaluatedIds,
    [baseline.data.detachmentId],
  );
});

test("keeps same-source AlliedRule datasheets out of native Aeldari construction", () => {
  for (const unitId of ["yvraine", "troupe-master"]) {
    const anchored = buildRoster({
      playerFaction: "aeldari",
      pointsLimit: 1000,
      detachmentId: "guardian-battlehost",
      internalExplorationAnchorUnitIds: [unitId],
    });
    assert.equal(anchored.ok, false);
    assert.equal(
      anchored.violations[0]?.code,
      "REQUIRED_UNIT_NOT_FOUND",
    );

    const warlord = buildRoster({
      playerFaction: "aeldari",
      pointsLimit: 1000,
      detachmentId: "guardian-battlehost",
      requiredWarlordUnitId: unitId,
    });
    assert.equal(warlord.ok, false);
    assert.equal(
      warlord.violations[0]?.code,
      "REQUIRED_UNIT_NOT_FOUND",
    );
  }

  const nativeYvraine = searchUnits({
    faction: "aeldari",
    query: "Yvraine",
  });
  assert.equal(nativeYvraine.ok, true);
  assert.deepEqual(nativeYvraine.data, []);
});

test("keeps generic Sentinel defaults but selects anti-elite profiles against Custodes", async () => {
  const requiredUnitIds = [
    "armoured-sentinels",
    "scout-sentinels",
  ];
  const generic = buildRoster({
    playerFaction: "astra-militarum",
    pointsLimit: 1000,
    requiredUnitIds,
  });
  assert.ok(generic.ok && generic.data);
  const genericSentinels = generic.data.units.filter(
    (unit) => requiredUnitIds.includes(unit.unitId),
  );
  assert.ok(genericSentinels.length >= 2);
  assert.ok(
    genericSentinels.every((unit) =>
      unit.equipment.some(
        (equipment) =>
          equipment.itemId === "multi-laser",
      ),
    ),
  );

  const matchup = buildRoster({
    playerFaction: "astra-militarum",
    pointsLimit: 1000,
    requiredUnitIds,
    opponentContext: {
      kind: "known-faction",
      factionId: "adeptus-custodes",
    },
  });
  assert.ok(
    matchup.ok && matchup.data,
    matchup.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  const matchupSentinels = matchup.data.units.filter(
    (unit) => requiredUnitIds.includes(unit.unitId),
  );
  assert.ok(matchupSentinels.length >= 2);
  assert.ok(
    matchupSentinels.every(
      (unit) =>
        !unit.equipment.some(
          (equipment) =>
            equipment.itemId === "multi-laser",
        ) &&
        unit.equipment.some(
          (equipment) =>
            equipment.itemId === "lascannon",
        ),
    ),
  );
  assert.equal(validateRoster(matchup.data).ok, true);
  const exportBlockers = conflictsForRoster(matchup.data).filter(
    (item) => item.blocking,
  );
  assert.ok(
    exportBlockers.length > 0,
    "the fixture must exercise roster-specific New Recruit preflight",
  );
  assert.equal(
    exportBlockers.some((conflict) =>
      requiredUnitIds.some(
        (unitId) =>
          conflict.entityId === unitId ||
          conflict.entityId.startsWith(`${unitId}:`),
      )
    ),
    false,
    "the selected anti-elite Sentinel configurations must remain export-mapped",
  );
  const exported = await exportRoster(matchup.data, "rosz");
  assert.equal(exported.ok, false);
  assert.equal(exported.data, null);
  assert.ok(
    exported.violations.some(
      (violation) =>
        violation.code === "NEW_RECRUIT_DATA_CONFLICT",
    ),
  );
  const explanation = explainRoster(matchup.data);
  assert.ok(
    explanation.data?.optimizer.targetProfileCoverage
      ?.selectedProfileEvidence.some(
        (evidence) =>
          /Lascannon.*S 12.*AP -3/i.test(evidence),
      ),
  );
  assert.ok(
    explanation.data?.optimizer.selectedCandidates
      .filter((candidate) =>
        requiredUnitIds.includes(candidate.unitId),
      )
      .every((candidate) =>
        candidate.equipmentSignature.includes("lascannon"),
      ),
  );
});

test("enumerates intermediate model counts inside ranged points tiers", () => {
  const input: BuildRosterInput = {
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    requiredUnitIds: ["venatari-custodians"],
    collectionProfile: {
      mode: "owned",
      units: [
        {
          unitId: "shield-captain",
          maxUnits: 1,
          maxModels: 1,
        },
        {
          unitId: "venatari-custodians",
          maxUnits: 1,
          maxModels: 5,
        },
      ],
    },
  };
  const result = buildRoster(input);
  assert.ok(result.ok && result.data);
  const venatari = result.data.units.find(
    (unit) => unit.unitId === "venatari-custodians",
  );
  assert.ok(venatari);
  assert.equal(
    venatari.modelCount,
    5,
    "the legal 4-6 points range must expose its intermediate size",
  );
  assert.equal(validateRoster(result.data).ok, true);

  const repeated = buildRoster(input);
  assert.ok(repeated.ok && repeated.data);
  assert.equal(
    repeated.data.units.find(
      (unit) => unit.unitId === "venatari-custodians",
    )?.modelCount,
    5,
  );
});

test("reserves room for every required unit before enlarging earlier units", () => {
  const requiredUnitIds = [
    "witchseekers",
    "allarus-custodians",
    "venatari-custodians",
    "pallas-grav-attack",
  ];
  const built = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 500,
    allowNamedCharacters: false,
    requiredWarlordUnitId: "knight-centura",
    requiredUnitIds,
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(built.data);
  assert.ok(built.data.totalPoints <= 500);
  assert.ok(built.data.units.some((unit) =>
    unit.unitId === "knight-centura" && unit.isWarlord
  ));
  for (const requiredUnitId of requiredUnitIds) {
    assert.ok(built.data.units.some((unit) =>
      unit.unitId === requiredUnitId
    ));
  }
});

test("combines independent wargear choices under a deterministic representative cap", () => {
  const baseInput: BuildRosterInput = {
    playerFaction: "astra-militarum",
    pointsLimit: 1000,
    requiredUnitIds: ["armoured-sentinels"],
    collectionProfile: {
      mode: "owned",
      units: [
        {
          unitId: "cadian-castellan",
          maxUnits: 1,
          maxModels: 1,
        },
        {
          unitId: "armoured-sentinels",
          maxUnits: 1,
          maxModels: 2,
        },
      ],
    },
  };
  const shooting = buildRoster({
    ...baseInput,
    preferences: ["shooting"],
  });
  assert.ok(shooting.ok && shooting.data);
  const shootingSentinels = shooting.data.units.find(
    (unit) => unit.unitId === "armoured-sentinels",
  );
  assert.ok(shootingSentinels);
  const shootingEquipment = new Set(
    shootingSentinels.equipment.map((equipment) => equipment.itemId),
  );
  assert.ok(
    shootingEquipment.has("plasma-cannon") ||
      shootingEquipment.has("lascannon"),
  );
  assert.ok(
    shootingEquipment.has("hunter-killer-missile"),
    "a preferred main-gun swap must combine with an independent add-on",
  );
  assert.equal(validateRoster(shooting.data).ok, true);

  const repeated = buildRoster({
    ...baseInput,
    preferences: ["shooting"],
  });
  assert.ok(repeated.ok && repeated.data);
  assert.deepEqual(
    repeated.data.units.find(
      (unit) => unit.unitId === "armoured-sentinels",
    )?.equipment,
    shootingSentinels.equipment,
    "bounded combination search must have a stable deterministic result",
  );

  const matchup = buildRoster({
    ...baseInput,
    opponentContext: {
      kind: "known-faction",
      factionId: "adeptus-custodes",
    },
  });
  assert.ok(matchup.ok && matchup.data);
  const matchupSentinels = matchup.data.units.find(
    (unit) => unit.unitId === "armoured-sentinels",
  );
  assert.ok(matchupSentinels);
  const matchupEquipment = new Set(
    matchupSentinels.equipment.map((equipment) => equipment.itemId),
  );
  assert.ok(matchupEquipment.has("lascannon"));
  assert.ok(matchupEquipment.has("hunter-killer-missile"));
  assert.ok(matchupEquipment.has("sentinel-chainsaw"));
  assert.equal(validateRoster(matchup.data).ok, true);
});

test("builds required support units with legal canonical bodyguard links", () => {
  const cases = [
    {
      factionId: "adeptus-astartes",
      supportUnitId: "lieutenant",
      bodyguardUnitId: "intercessor-squad",
    },
    {
      factionId: "necrons",
      supportUnitId: "technomancer",
      bodyguardUnitId: "immortals",
    },
    {
      factionId: "aeldari",
      supportUnitId: "warlock",
      bodyguardUnitId: "guardian-defenders",
    },
  ] as const;

  for (const testCase of cases) {
    const built = buildRoster({
      playerFaction: testCase.factionId,
      pointsLimit: 1000,
      requiredUnitIds: [testCase.supportUnitId],
      collectionProfile: {
        mode: "owned",
        units: [
          {
            unitId: testCase.supportUnitId,
            maxUnits: 1,
          },
          {
            unitId: testCase.bodyguardUnitId,
            maxUnits: 1,
          },
        ],
      },
    });
    assert.ok(
      built.ok && built.data,
      `${testCase.supportUnitId}: ${built.violations
        .map((violation) => violation.message)
        .join("; ")}`,
    );
    assert.equal(validateRoster(built.data).ok, true);
    assert.ok(
      built.data.units.some(
        (selection) => selection.unitId === testCase.bodyguardUnitId,
      ),
    );
    const support = built.data.units.find(
      (selection) => selection.unitId === testCase.supportUnitId,
    );
    assert.ok(support);
    assert.deepEqual(support.leaderAttachment, {
      bodyguardUnitId: testCase.bodyguardUnitId,
      role: "support",
      provisional: false,
    });

    const canonicalSupport = toCanonicalRoster(built.data).units.find(
      (selection) => selection.ref.id === testCase.supportUnitId,
    );
    assert.equal(
      canonicalSupport?.leader_attachment?.bodyguard_ref.id,
      testCase.bodyguardUnitId,
    );
    assert.equal(
      canonicalSupport?.leader_attachment?.bodyguard_ref.resolved,
      true,
    );
    assert.equal(canonicalSupport?.leader_attachment?.role, "support");
    assert.equal(canonicalSupport?.leader_attachment?.provisional, false);

    const bodyguard = built.data.units.find(
      (selection) => selection.unitId === testCase.bodyguardUnitId,
    );
    assert.ok(bodyguard);
    const rebound = modifyRoster(built.data, {
      type: "replace",
      selectionId: support.selectionId,
      unitId: testCase.supportUnitId,
    });
    assert.ok(
      rebound.ok && rebound.data,
      `${testCase.supportUnitId} replace: ${rebound.violations
        .map((violation) => violation.message)
        .join("; ")}`,
    );
    assert.deepEqual(
      rebound.data.units.find(
        (selection) => selection.selectionId === support.selectionId,
      )?.leaderAttachment,
      {
        bodyguardUnitId: testCase.bodyguardUnitId,
        role: "support",
        provisional: false,
      },
    );
    const staleAttachment = modifyRoster(built.data, {
      type: "remove",
      selectionId: bodyguard.selectionId,
    });
    assert.equal(staleAttachment.ok, false);
    assert.ok(
      staleAttachment.violations.some(
        (violation) => violation.code === "SUPPORT_BODYGUARD_MISSING",
      ),
    );
  }

  const impossible = buildRoster({
    playerFaction: "adeptus-astartes",
    pointsLimit: 1000,
    requiredUnitIds: ["lieutenant"],
    collectionProfile: {
      mode: "owned",
      units: [{ unitId: "lieutenant", maxUnits: 1 }],
    },
  });
  assert.equal(impossible.ok, false);
  assert.equal(impossible.data, null);
  assert.ok(
    impossible.violations.some(
      (violation) => violation.code === "SUPPORT_ATTACHMENT_UNAVAILABLE",
    ),
  );
});

test("fails closed on unscoped or unknown opponent assumptions", () => {
  const unscoped = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    opponentAssumptions: {
      styleTags: ["melee"],
      source: "user-stated",
    },
  });
  assert.equal(unscoped.ok, false);
  assert.equal(unscoped.data, null);
  assert.ok(
    unscoped.violations.some(
      (violation) =>
        violation.code === "OPPONENT_ASSUMPTIONS_SCOPE_REQUIRED",
    ),
  );

  const unknownUnit = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    opponentContext: {
      kind: "known-faction",
      factionId: "world-eaters",
    },
    opponentAssumptions: {
      styleTags: ["melee"],
      knownUnitIds: ["technomancer"],
      source: "user-stated",
    },
  });
  assert.equal(unknownUnit.ok, false);
  assert.equal(unknownUnit.data, null);
  assert.ok(
    unknownUnit.violations.some(
      (violation) =>
        violation.code === "OPPONENT_ASSUMPTION_UNIT_NOT_FOUND",
    ),
  );
});

test("persists deterministic opponent assumptions in threat evidence", () => {
  const baselineInput: BuildRosterInput = {
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    opponentContext: {
      kind: "known-faction",
      factionId: "world-eaters",
    },
  };
  const assumedInput: BuildRosterInput = {
    ...baselineInput,
    opponentAssumptions: {
      styleTags: ["horde", "ranged"],
      knownUnitIds: ["eightbound"],
      source: "user-stated",
    },
  };
  const baseline = buildRoster(baselineInput);
  const assumed = buildRoster(assumedInput);
  const repeated = buildRoster(assumedInput);
  assert.ok(baseline.ok && baseline.data);
  assert.ok(assumed.ok && assumed.data);
  assert.ok(repeated.ok && repeated.data);

  assert.deepEqual(
    assumed.data.constraints.opponentAssumptions,
    assumedInput.opponentAssumptions,
  );
  assert.equal(assumed.data.id, repeated.data.id);
  assert.deepEqual(assumed.data.units, repeated.data.units);
  assert.deepEqual(
    assumed.data.constraints.opponentThreatProfile,
    repeated.data.constraints.opponentThreatProfile,
  );

  const baselineProfile = baseline.data.constraints.opponentThreatProfile;
  const assumedProfile = assumed.data.constraints.opponentThreatProfile;
  assert.ok(baselineProfile && assumedProfile);
  assert.ok(assumedProfile.hordeShare > baselineProfile.hordeShare);
  assert.ok(assumedProfile.rangedShare > baselineProfile.rangedShare);
  assert.equal(assumedProfile.keyTargetProfiles[0]?.unitId, "eightbound");
  assert.equal(
    baselineProfile.keyTargetProfiles.some(
      (target) => target.unitId === "eightbound",
    ),
    false,
  );

  const baselineExplanation = explainRoster(baseline.data);
  const assumedExplanation = explainRoster(assumed.data);
  assert.ok(baselineExplanation.ok && baselineExplanation.data);
  assert.ok(assumedExplanation.ok && assumedExplanation.data);
  assert.equal(
    assumedExplanation.data.optimizer.targetProfileCoverage
      ?.keyTargetProfiles[0]?.unitId,
    "eightbound",
  );
  assert.notDeepEqual(
    assumedExplanation.data.optimizer.targetProfileCoverage,
    baselineExplanation.data.optimizer.targetProfileCoverage,
  );
});

test("baseline damage resolves faction-scoped duplicate IDs", () => {
  const astartes = buildRoster({
    playerFaction: "adeptus-astartes",
    pointsLimit: 1000,
    requiredUnitIds: ["lieutenant"],
    collectionProfile: {
      mode: "owned",
      units: [
        { unitId: "lieutenant", maxUnits: 1 },
        { unitId: "intercessor-squad", maxUnits: 1 },
      ],
    },
  });
  const custodes = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    collectionProfile: {
      mode: "owned",
      units: [
        { unitId: "shield-captain", maxUnits: 1 },
        { unitId: "custodian-guard", maxUnits: 1 },
      ],
    },
  });
  assert.ok(astartes.ok && astartes.data);
  assert.ok(custodes.ok && custodes.data);
  let cells: ReturnType<typeof baselineDamageCells> = [];
  assert.doesNotThrow(() => {
    cells = baselineDamageCells(astartes.data!, custodes.data!);
  });
  assert.ok(cells.length > 0);
});

test("distinguishes whole-unit blockers from scoped configuration conflicts", () => {
  const base: DataConflict = {
    id: "synthetic-conflict",
    rootCauseKey: "synthetic-root",
    factionId: "adeptus-custodes",
    entityType: "points",
    entityId: "prosecutors",
    entityName: "Prosecutors",
    code: "POINTS_MISMATCH",
    blocking: true,
    message: "Synthetic points conflict.",
    source: "bsdata",
  };
  assert.equal(conflictBlocksAllUnitConfigurations(base), true);
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...base,
      entityId: "prosecutors:6",
      scope: { modelCount: 6 },
    }),
    false,
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...base,
      entityId: "prosecutors:6",
    }),
    false,
    "legacy numeric entity suffixes remain model-count scoped",
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...base,
      entityType: "equipment",
      entityId: "prosecutors:boltgun",
    }),
    false,
  );
  assert.equal(
    conflictBlocksAllUnitConfigurations({
      ...base,
      entityType: "unit",
    }),
    true,
  );
});

test("canonical building ignores export-only scoped conflicts", async () => {
  const input: BuildRosterInput = {
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Scoped conflict regression",
    requiredUnitIds: ["prosecutors"],
  };
  const baseline = buildRoster(input);
  assert.equal(
    baseline.ok,
    true,
    baseline.violations.map((issue) => issue.message).join("; "),
  );
  assert.ok(baseline.data);
  const baselineSelection = baseline.data.units.find(
    (selection) => selection.unitId === "prosecutors",
  );
  assert.ok(baselineSelection);
  const conflict: DataConflict = {
    id: "synthetic-prosecutors-model-count",
    rootCauseKey: "synthetic-prosecutors-model-count",
    factionId: "adeptus-custodes",
    entityType: "points",
    entityId: `prosecutors:${baselineSelection.modelCount}`,
    entityName: "Prosecutors",
    code: "POINTS_MISMATCH",
    blocking: true,
    message: `Synthetic conflict for ${baselineSelection.modelCount} Prosecutors.`,
    rulesValue: baselineSelection.points,
    newRecruitValue: baselineSelection.points + 5,
    source: "bsdata",
    scope: { modelCount: baselineSelection.modelCount },
  };
  const removeConflict = installSyntheticConflict(conflict);
  try {
    const built = buildRoster(input);
    assert.equal(
      built.ok,
      true,
      built.violations.map((issue) => issue.message).join("; "),
    );
    assert.ok(built.data);
    const selected = built.data.units.filter(
      (selection) => selection.unitId === "prosecutors",
    );
    assert.ok(selected.length > 0);
    assert.ok(selected.some(
      (selection) =>
        selection.modelCount === baselineSelection.modelCount,
    ));
    assert.equal(
      conflictsForRoster(built.data).some(
        (item) => item.id === conflict.id,
      ),
      true,
    );
    const exported = await exportRoster(built.data, "rosz");
    assert.equal(exported.ok, false);
    assert.ok(
      exported.violations.some(
        (issue) => issue.code === "NEW_RECRUIT_DATA_CONFLICT",
      ),
    );
  } finally {
    removeConflict();
  }
});

test("a required legal unit outranks exportability and fails only at export preflight", async () => {
  const conflict: DataConflict = {
    id: "synthetic-required-unit-conflict",
    rootCauseKey: "synthetic-required-unit-conflict",
    factionId: "adeptus-custodes",
    entityType: "unit",
    entityId: "prosecutors",
    entityName: "Prosecutors",
    code: "UNMAPPED",
    blocking: true,
    message: "Synthetic whole-unit New Recruit mapping conflict.",
    source: "bsdata",
  };
  const removeConflict = installSyntheticConflict(conflict);
  try {
    const built = buildRoster({
      playerFaction: "adeptus-custodes",
      pointsLimit: 1000,
      name: "Required mapping boundary",
      requiredUnitIds: ["prosecutors"],
    });
    assert.equal(
      built.ok,
      true,
      built.violations.map((issue) => issue.message).join("; "),
    );
    assert.ok(built.data);
    assert.ok(
      built.data.units.some(
        (selection) => selection.unitId === "prosecutors",
      ),
    );
    assert.ok(
      built.warnings.some(
        (warning) => warning.code === "DATA_SOURCE_CONFLICT",
      ),
    );
    const exported = await exportRoster(built.data, "rosz");
    assert.equal(exported.ok, false);
    assert.equal(exported.data, null);
    assert.ok(
      exported.violations.some(
        (issue) => issue.code === "NEW_RECRUIT_DATA_CONFLICT",
      ),
    );
  } finally {
    removeConflict();
  }
});

test("a canonical faction name suppresses nested generic aliases", () => {
  const deathGuard = buildRoster({
    prompt: "Build a 1000 point Death Guard army.",
    pointsLimit: 1000,
  });
  assert.equal(
    deathGuard.ok,
    true,
    deathGuard.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  assert.equal(deathGuard.data?.factionId, "death-guard");

  const inferredOpponent = buildRoster({
    prompt:
      "Build a 1000 point Death Guard army against an unknown Orks list.",
    pointsLimit: 1000,
  });
  assert.equal(
    inferredOpponent.ok,
    true,
    inferredOpponent.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  assert.equal(inferredOpponent.data?.factionId, "death-guard");
  assert.equal(inferredOpponent.data?.constraints.opponentFactionId, "orks");
});

test("does not treat Custodian Guard as an Astra Militarum prompt mention", () => {
  const resolution = resolveFactionIntent({
    prompt: "Build a Shield Host with 4 Custodian Guard.",
    playerFaction: "adeptus-custodes",
  });

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.factionId, "adeptus-custodes");
  assert.deepEqual(resolution.opponentFactionIds, []);
});

test("structured player faction ignores unclassified factions in a roster name", () => {
  const resolution = resolveFactionIntent({
    prompt:
      "Build an Adeptus Custodes army. Name it Custodes World Eaters Counter 1000.",
    playerFaction: "adeptus-custodes",
  });

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.factionId, "adeptus-custodes");
});

test("structured opponent faction overrides a player-like prompt mention", () => {
  const resolution = resolveFactionIntent({
    prompt:
      "Build an exactly 2000 point legal Adeptus Custodes Golden Air Force skew around both an Ares Gunship and an Orion Assault Dropship. Use Shield Host, retain enough infantry to embark or score, include cheap mission pieces if possible, and optimize for an unknown World Eaters list.",
    playerFaction: "adeptus-custodes",
    opponentFaction: "world-eaters",
  });

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.factionId, "adeptus-custodes");
  assert.deepEqual(resolution.opponentFactionIds, ["world-eaters"]);
});

test("honors prompt and structured hard unit constraints", () => {
  const result = buildRoster({
    prompt:
      "Build a 1000 point Aeldari army. Must include Farseer Skyrunner. Do not select Warlock Skyrunners.",
    playerFaction: "aeldari",
    pointsLimit: 1000,
    requiredWarlordUnitId: "farseer-skyrunner",
  });
  assert.equal(
    result.ok,
    true,
    result.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(result.data);
  assert.ok(
    result.data.units.some(
      (unit) =>
        unit.unitId === "farseer-skyrunner" && unit.isWarlord,
    ),
  );
  assert.equal(
    result.data.units.some(
      (unit) => unit.unitId === "warlock-skyrunners",
    ),
    false,
  );
  assert.deepEqual(result.data.constraints.requiredUnitIds, [
    "farseer-skyrunner",
  ]);
  assert.deepEqual(result.data.constraints.excludedUnitIds, [
    "warlock-skyrunners",
  ]);
});

test("rejects an ineligible Warlord and validates an eligible mapped one", () => {
  const built = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
    requiredUnitIds: ["warlock-skyrunners"],
    requiredWarlordUnitId: "farseer-skyrunner",
  });
  assert.ok(built.data);
  const warlock = built.data.units.find(
    (unit) => unit.unitId === "warlock-skyrunners",
  );
  assert.ok(warlock);
  const invalid = modifyRoster(built.data, {
    type: "set-warlord",
    selectionId: warlock.selectionId,
  });
  assert.equal(invalid.ok, false);
  assert.ok(
    invalid.violations.some(
      (violation) => violation.code === "WARLORD_INELIGIBLE",
    ),
  );
  assert.equal(
    validateRoster(built.data).warnings.some(
      (warning) =>
        warning.code === "NEW_RECRUIT_WARLORD_MAPPING_UNAVAILABLE",
    ),
    false,
  );
});

test("retains a required named unit when other selections fail export preflight", async () => {
  const artemisMapping =
    getNewRecruitFactionCatalogue("adeptus-astartes")?.units[
      "watch-captain-artemis"
    ];
  assert.ok(artemisMapping);
  assert.equal(artemisMapping.warlord, undefined);

  const built = buildRoster({
    playerFaction: "adeptus-astartes",
    pointsLimit: 1000,
    preferences: ["objective", "durability"],
    allowNamedCharacters: true,
    allowLegends: false,
    requiredUnitIds: ["watch-captain-artemis"],
    requiredWarlordUnitId: "captain-in-phobos-armour",
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(built.data);
  assert.ok(
    built.data.units.some(
      (unit) =>
        unit.unitId === "watch-captain-artemis" &&
        !unit.isWarlord,
    ),
  );
  assert.ok(
    built.data.units.some(
      (unit) =>
        unit.unitId === "captain-in-phobos-armour" &&
        unit.isWarlord,
    ),
  );
  assert.deepEqual(built.data.constraints.requiredUnitIds, [
    "captain-in-phobos-armour",
    "watch-captain-artemis",
  ]);
  assert.equal(validateRoster(built.data).ok, true);
  const requiredExportUnitIds = [
    "captain-in-phobos-armour",
    "watch-captain-artemis",
  ];
  const exportBlockers = conflictsForRoster(built.data).filter(
    (item) => item.blocking,
  );
  assert.ok(
    exportBlockers.length > 0,
    "the fixture must exercise roster-specific New Recruit preflight",
  );
  assert.equal(
    exportBlockers.some((conflict) =>
      requiredExportUnitIds.some(
        (unitId) =>
          conflict.entityId === unitId ||
          conflict.entityId.startsWith(`${unitId}:`),
      )
    ),
    false,
    "the required named unit and mapped Warlord must not cause the export failure",
  );
  const exported = await exportRoster(built.data, "rosz");
  assert.equal(exported.ok, false);
  assert.equal(exported.data, null);
  assert.ok(
    exported.violations.some(
      (violation) =>
        violation.code === "NEW_RECRUIT_DATA_CONFLICT",
    ),
  );
});

test("applies roster modifications atomically and validates the final draft", () => {
  const built = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  });
  assert.ok(built.data);
  const removable = [...built.data.units]
    .filter((unit) => !unit.isWarlord && unit.points >= 60)
    .sort((left, right) => left.points - right.points)[0];
  assert.ok(removable);
  const result = modifyRosterBatch(built.data, [
    { type: "add", unitId: "vibro-cannon-platform" },
    { type: "remove", selectionId: removable.selectionId },
  ]);
  assert.equal(
    result.ok,
    true,
    result.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(
    result.data?.units.some(
      (unit) => unit.unitId === "vibro-cannon-platform",
    ),
  );
  assert.equal(
    result.data?.units.some(
      (unit) => unit.selectionId === removable.selectionId,
    ),
    false,
  );
  assert.equal(
    result.warnings.some((warning) => warning.code === "POINTS_REMAIN"),
    result.data!.totalPoints < result.data!.pointsLimit,
  );
});

test("does not leak transient warnings from intermediate batch drafts", () => {
  const built = buildRoster({
    playerFaction: "world-eaters",
    pointsLimit: 575,
    requiredUnitIds: [
      "kharn-the-betrayer",
      "helbrute",
      "khorne-berzerkers",
    ],
  });
  assert.ok(built.data);
  const berzerkers = built.data.units.find(
    (unit) => unit.unitId === "khorne-berzerkers",
  );
  assert.ok(berzerkers);

  const result = modifyRosterBatch(built.data, [
    { type: "remove", selectionId: berzerkers.selectionId },
    { type: "add", unitId: "khorne-berzerkers", modelCount: 10 },
    { type: "add", unitId: "khorne-berzerkers", modelCount: 10 },
  ]);

  assert.equal(
    result.ok,
    true,
    result.violations.map((violation) => violation.message).join("; "),
  );
  assert.equal(result.data?.totalPoints, 575);
  assert.equal(
    result.warnings.some((warning) => warning.code === "POINTS_REMAIN"),
    false,
  );
  assert.equal(
    result.warnings.filter(
      (warning) => warning.code === "OFFICIAL_AUTHORITY_UNAVAILABLE",
    ).length,
    1,
  );
});

test("builds and validates every embedded faction at common game sizes", () => {
  for (const pointsLimit of [500, 1000, 2000]) {
    for (const faction of factions.all) {
      const result = buildRoster({
        faction: faction.id,
        pointsLimit,
        name: `${faction.name} coverage`,
        preferences: ["mobility", "objective", "shooting"],
        allowLegends: false,
      });
      assert.equal(
        result.ok,
        true,
        `${faction.name} at ${pointsLimit}: ${result.violations
          .map((item) => `${item.code}: ${item.message}`)
          .join("; ")}`,
      );
      assert.equal(result.data?.factionId, faction.id);
      assert.ok((result.data?.units.length ?? 0) > 0);
    }
  }
});

test("exports a validated Aeldari roster with an eligible mapped Warlord", async () => {
  const result = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    name: "Aeldari Rapid Strike",
    preferences: ["mobility", "shooting", "objective"],
  });
  assert.ok(result.data);

  const html = await exportRoster(result.data, "html");
  assert.equal(html.ok, true);
  assert.match(String(html.data?.content), /Aeldari Rapid Strike/);

  const rosz = await exportRoster(result.data, "rosz");
  assert.equal(
    rosz.ok,
    true,
    rosz.violations.map((item) => item.message).join("; "),
  );
  assert.equal(
    result.data.units.find((unit) => unit.isWarlord)?.unitId,
    "farseer-skyrunner",
  );
});

test("records semantic source identity and migrates V1 drafts", async () => {
  const built = buildRoster({ faction: "adeptus-custodes", pointsLimit: 1000 });
  assert.ok(built.data);
  assert.equal(built.data.schemaVersion, 3);
  assert.match(built.data.sourceData.bundleId, /^[0-9a-f]{64}$/);
  assert.match(built.data.sourceData.rosterRulesHash, /^[0-9a-f]{64}$/);
  assert.match(built.data.sourceData.mappingHash, /^[0-9a-f]{64}$/);
  assert.match(built.data.sourceData.newRecruit.commit, /^[0-9a-f]{40}$/);
  assert.match(built.data.sourceData.official.contentSha256, /^[0-9a-f]{64}$/);

  const legacy = JSON.parse(
    await readFile(new URL("golden-boys-435.json", fixtures), "utf8"),
  ) as unknown;
  const migrated = parseRosterDraft(legacy);
  assert.equal(migrated.success, true);
  if (!migrated.success) return;
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.data.schemaVersion, 3);
  assert.equal(migrated.data.sourceData.migratedFrom, 1);

  const status = getDataStatus();
  assert.equal(status.data?.sources.releaseId, built.data.sourceData.releaseId);
  assert.equal(
    status.data?.sources.newRecruit.commit,
    built.data.sourceData.newRecruit.commit,
  );
});

test("separates non-Custodes canonical legality from generated-mapping preflight", async () => {
  const built = buildRoster({
    faction: "necrons",
    pointsLimit: 1000,
    allowNamedCharacters: false,
    requiredUnitIds: ["tesseract-vault"],
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((item) => item.message).join("; "),
  );
  assert.ok(built.data);
  assert.equal(validateRoster(built.data).ok, true);
  assert.equal(getNewRecruitCapability("necrons").available, true);
  const exportBlockers = conflictsForRoster(built.data).filter(
    (item) => item.blocking,
  );
  assert.ok(
    exportBlockers.length > 0,
    "faction-level capability must still be narrowed by roster preflight",
  );
  const exported = await exportRoster(built.data, "rosz");
  assert.equal(exported.ok, false);
  assert.equal(exported.data, null);
  assert.ok(
    exported.violations.some(
      (item) => item.code === "NEW_RECRUIT_DATA_CONFLICT",
    ),
  );
});

test("checks all live source classes without changing the pinned build", async () => {
  const mockFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org")) {
      return new Response(
        JSON.stringify({
          version: newRecruitCatalogue.sources.rules.version,
        }),
      );
    }
    if (url.includes("api.github.com")) {
      return new Response(
        JSON.stringify({ sha: "1111111111111111111111111111111111111111" }),
      );
    }
    return new Response("<html><h2>v1.1</h2><main>changed</main></html>");
  };
  const freshness = await checkDataFreshness({
    fetch: mockFetch as typeof fetch,
  });
  assert.equal(freshness.ok, true);
  assert.equal(freshness.data?.state, "update-available");
  assert.equal(freshness.data?.rules.updateAvailable, false);
  assert.equal(freshness.data?.newRecruit.updateAvailable, true);
  assert.ok(
    freshness.warnings.some(
      (item) => item.code === "DATA_PROVENANCE_CHANGED",
    ),
  );
});

test("returns a stable envelope for malformed roster schemas", () => {
  const result = validateRoster({
    schemaVersion: 1,
    units: [],
  } as unknown as RosterDraftV1);
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.equal(result.violations[0]?.code, "MALFORMED_ROSTER");
});

test("builds the acceptance Custodes roster deterministically", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("valid-custodes-build.json", fixtures), "utf8"),
  ) as {
    input: Parameters<typeof buildRoster>[0];
    expected: {
      factionId: string;
      pointsLimit: number;
      totalPoints: number;
      legal: boolean;
      allowNamedCharacters: boolean;
    };
  };
  const first = buildRoster(fixture.input);
  const second = buildRoster(fixture.input);
  assert.ok(first.data);
  assert.ok(second.data);
  assert.equal(first.ok, fixture.expected.legal);
  assert.equal(first.data.factionId, fixture.expected.factionId);
  assert.equal(first.data.pointsLimit, fixture.expected.pointsLimit);
  assert.equal(first.data.totalPoints, fixture.expected.totalPoints);
  assert.equal(
    first.data.constraints.allowNamedCharacters,
    fixture.expected.allowNamedCharacters,
  );
  assert.deepEqual(
    first.data.units.map((unit) => [
      unit.unitId,
      unit.modelCount,
      unit.points,
      unit.isWarlord,
    ]),
    second.data.units.map((unit) => [
      unit.unitId,
      unit.modelCount,
      unit.points,
      unit.isWarlord,
    ]),
  );
});

test("uses model-count and army-ordinal pricing", () => {
  const base = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 2000,
    preferences: ["mobility"],
    allowNamedCharacters: false,
  });
  assert.ok(base.data);

  const addFirst = modifyRoster(base.data, {
    type: "add",
    unitId: "blade-champion",
  });
  assert.ok(addFirst.data);
  const champions = addFirst.data.units.filter(
    (unit) => unit.unitId === "blade-champion",
  );
  assert.ok(champions.length >= 2);
  assert.equal(champions[0].points, 110);
  assert.equal(champions[1].points, 125);

  const addPraetors = modifyRoster(base.data, {
    type: "add",
    unitId: "vertus-praetors",
    modelCount: 2,
  });
  assert.ok(addPraetors.data);
  const praetors = addPraetors.data.units.find(
    (unit) => unit.unitId === "vertus-praetors",
  );
  assert.ok(praetors);
  const resized = modifyRoster(addPraetors.data, {
    type: "set-model-count",
    selectionId: praetors.selectionId,
    modelCount: 3,
  });
  assert.ok(resized.data);
  assert.equal(
    resized.data.units.find(
      (unit) => unit.selectionId === praetors.selectionId,
    )?.points,
    215,
  );
});

test("uses one rules copy-limit source for generic Character generation", () => {
  for (const [pointsLimit, expectedCopies] of [
    [1000, 2],
    [2000, 3],
  ] as const) {
    const built = buildRoster({
      playerFaction: "adeptus-custodes",
      pointsLimit,
      allowNamedCharacters: false,
      collectionUnitIds: ["blade-champion"],
      requiredWarlordUnitId: "blade-champion",
      detachmentId: "shield-host",
    });
    assert.ok(
      built.ok && built.data,
      built.violations.map((violation) => violation.message).join("; "),
    );
    assert.equal(
      built.data.units.filter(
        (selection) => selection.unitId === "blade-champion",
      ).length,
      expectedCopies,
    );
  }
});

test("resolves copy limits from consistent construction roles and fails closed", () => {
  assert.deepEqual(
    resolveUnitCopyLimit(
      {
        role: "character",
        keywords: ["Infantry", "Character"],
      },
      "strike-force",
      null,
    ),
    {
      status: "resolved",
      maximumCopies: 3,
      basis: "standard",
    },
  );
  assert.deepEqual(
    resolveUnitCopyLimit(
      {
        keywords: ["Vehicle", "Transport", "Coronus Grav-carrier"],
      },
      "strike-force",
      null,
    ),
    {
      status: "resolved",
      maximumCopies: 3,
      basis: "standard",
    },
  );
  assert.deepEqual(
    resolveUnitCopyLimit(
      {
        role: "dedicated-transport",
        keywords: ["Vehicle", "Transport", "Dedicated Transport"],
      },
      "strike-force",
      null,
    ),
    {
      status: "resolved",
      maximumCopies: 6,
      basis: "dedicated-transport",
    },
  );
  assert.deepEqual(
    resolveUnitCopyLimit(
      {
        keywords: ["War Dog"],
      },
      "strike-force",
      {
        granted_keywords: [
          {
            keyword: "Battleline",
            to_keywords: ["War Dog"],
          },
        ],
      },
    ),
    {
      status: "resolved",
      maximumCopies: 6,
      basis: "battleline",
    },
  );

  const conflict = resolveUnitCopyLimit(
    {
      role: "character",
      keywords: ["Character", "Epic Hero"],
    },
    "strike-force",
    null,
  );
  assert.equal(conflict.status, "unresolved");

  const legacyNamedCharacter = resolveUnitCopyLimit(
    {
      role: "character",
      keywords: ["Character", "Named Character"],
    },
    "strike-force",
    null,
  );
  assert.equal(legacyNamedCharacter.status, "unresolved");

  const unknown = resolveUnitCopyLimit(
    {
      role: "unknown-runtime-role",
      keywords: ["Infantry"],
    },
    "strike-force",
    null,
  );
  assert.equal(unknown.status, "unresolved");

  const conditionalGrant = resolveUnitCopyLimit(
    {
      keywords: ["War Dog"],
    },
    "strike-force",
    {
      granted_keywords: [
        {
          keyword: "Battleline",
          to_keywords: ["War Dog"],
          max_selected: 3,
        },
      ],
    },
  );
  assert.equal(conditionalGrant.status, "unresolved");

  assert.deepEqual(
    resolveUnitCopyLimit(
      {
        role: "epic-hero",
        keywords: ["Character", "Epic Hero", "War Dog"],
      },
      "strike-force",
      {
        granted_keywords: [
          {
            keyword: "Battleline",
            to_keywords: ["War Dog"],
            max_selected: 3,
          },
        ],
      },
    ),
    {
      status: "resolved",
      maximumCopies: 1,
      basis: "epic-hero",
    },
  );
  assert.deepEqual(
    resolveUnitCopyLimit(
      {
        role: "battleline",
        keywords: ["Battleline", "Transport"],
      },
      "strike-force",
      {
        granted_keywords: [
          {
            keyword: "Dedicated Transport",
            to_keywords: ["Transport"],
            max_selected: 1,
          },
        ],
      },
    ),
    {
      status: "resolved",
      maximumCopies: 6,
      basis: "battleline",
    },
  );
  assert.deepEqual(
    resolveUnitCopyLimit(
      {
        keywords: ["Chosen Champion"],
      },
      "strike-force",
      {
        granted_keywords: [
          {
            keyword: "Epic Hero",
            to_keywords: ["Chosen Champion"],
          },
        ],
      },
    ),
    {
      status: "resolved",
      maximumCopies: 1,
      basis: "epic-hero",
    },
  );
});

test("enforces generic, transport, and Epic Hero copy limits", async () => {
  const genericBase = minimalCustodesRoster();
  const threeChampions = modifyRosterBatch(genericBase, [
    { type: "add", unitId: "blade-champion" },
    { type: "add", unitId: "blade-champion" },
  ]);
  assert.ok(
    threeChampions.ok && threeChampions.data,
    threeChampions.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  const fourChampions = modifyRoster(threeChampions.data, {
    type: "add",
    unitId: "blade-champion",
  });
  assert.equal(fourChampions.ok, false);
  assert.ok(fourChampions.data);
  assert.deepEqual(
    fourChampions.violations.map((violation) => violation.code),
    ["UNIT_COPY_LIMIT_EXCEEDED"],
  );

  const recovered = modifyRosterBatch(threeChampions.data, [
    { type: "add", unitId: "blade-champion" },
    {
      type: "remove",
      selectionId: threeChampions.data.units.find(
        (selection) =>
          selection.unitId === "blade-champion" && !selection.isWarlord,
      )!.selectionId,
    },
  ]);
  assert.ok(
    recovered.ok && recovered.data,
    recovered.violations.map((violation) => violation.message).join("; "),
  );
  assert.equal(
    recovered.data.units.filter(
      (selection) => selection.unitId === "blade-champion",
    ).length,
    3,
  );

  const coronusBase = minimalCustodesRoster();
  const threeCoronus = modifyRosterBatch(
    coronusBase,
    Array.from({ length: 3 }, () => ({
      type: "add" as const,
      unitId: "coronus-grav-carrier",
    })),
  );
  assert.ok(
    threeCoronus.ok && threeCoronus.data,
    threeCoronus.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  const fourCoronus = modifyRoster(threeCoronus.data, {
    type: "add",
    unitId: "coronus-grav-carrier",
  });
  assert.equal(fourCoronus.ok, false);
  assert.ok(
    fourCoronus.violations.some(
      (violation) => violation.code === "UNIT_COPY_LIMIT_EXCEEDED",
    ),
  );

  const rhinoBase = minimalCustodesRoster();
  const sixRhinos = modifyRosterBatch(
    rhinoBase,
    Array.from({ length: 6 }, () => ({
      type: "add" as const,
      unitId: "anathema-psykana-rhino",
    })),
  );
  assert.ok(
    sixRhinos.ok && sixRhinos.data,
    sixRhinos.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  const sevenRhinos = modifyRoster(sixRhinos.data, {
    type: "add",
    unitId: "anathema-psykana-rhino",
  });
  assert.equal(sevenRhinos.ok, false);
  assert.ok(
    sevenRhinos.violations.some(
      (violation) => violation.code === "UNIT_COPY_LIMIT_EXCEEDED",
    ),
  );

  const epicBase = minimalCustodesRoster(true);
  const firstTrajann = modifyRoster(epicBase, {
    type: "add",
    unitId: "trajann-valoris",
  });
  assert.ok(
    firstTrajann.ok && firstTrajann.data,
    firstTrajann.violations
      .map((violation) => violation.message)
      .join("; "),
  );
  const secondTrajann = modifyRoster(firstTrajann.data, {
    type: "add",
    unitId: "trajann-valoris",
  });
  assert.equal(secondTrajann.ok, false);
  assert.ok(
    secondTrajann.violations.some(
      (violation) => violation.code === "UNIT_COPY_LIMIT_EXCEEDED",
    ),
  );

  const exported = await exportRoster(fourChampions.data, "rosz");
  assert.equal(exported.ok, false);
  assert.equal(exported.data, null);
  assert.ok(
    exported.violations.some(
      (violation) => violation.code === "UNIT_COPY_LIMIT_EXCEEDED",
    ),
  );
});

test("honors collection and named-character constraints", () => {
  const result = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    preferences: ["mobility"],
    allowNamedCharacters: false,
    collectionUnitIds: [
      "blade-champion",
      "vertus-praetors",
      "allarus-custodians",
      "pallas-grav-attack",
    ],
  });
  assert.ok(result.data);
  assert.ok(
    result.data.units.every((unit) =>
      [
        "blade-champion",
        "vertus-praetors",
        "allarus-custodians",
        "pallas-grav-attack",
      ].includes(unit.unitId),
    ),
  );
  const epicIds = new Set(
    (searchUnits({
      faction: "adeptus-custodes",
      includeLegends: true,
      limit: 100,
    }).data ?? [])
      .filter((unit) => unit.isNamedCharacter)
      .map((unit) => unit.id),
  );
  assert.ok(result.data.units.every((unit) => !epicIds.has(unit.unitId)));
});

test("surfaces illegal loadouts and the sanitized Golden Boys fixture", async () => {
  const valid = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
  });
  assert.ok(valid.data);
  const selection = valid.data.units.find((unit) => unit.equipment.length > 0);
  assert.ok(selection);
  const illegal = modifyRoster(valid.data, {
    type: "set-equipment",
    selectionId: selection.selectionId,
    equipment: [
      {
        itemId: selection.equipment[0].itemId,
        count: 99,
      },
    ],
  });
  assert.equal(illegal.ok, false);
  assert.ok(
    illegal.violations.some((violation) =>
      violation.code.startsWith("LOADOUT_"),
    ),
  );

  const goldenBoys = JSON.parse(
    await readFile(new URL("golden-boys-435.json", fixtures), "utf8"),
  ) as RosterDraftV1;
  const result = validateRoster(goldenBoys);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.code === "NO_WARLORD"));
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.code === "POINTS_OVER_LIMIT" ||
        violation.code === "DISPOSITION_INVALID" ||
        violation.code === "POINT_LIMIT_INVALID",
    ),
  );
});

test("parses sanitized authenticated New Recruit fixtures without rules prose", async () => {
  const json = await readFile(
    new URL("new-recruit/golden-boys.json", fixtures),
    "utf8",
  );
  assert.doesNotMatch(json, /"(?:rules|profiles|description)"\s*:/);
  const imported = tryImportRoster(json, { dataset });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.equal(imported.format, "newrecruit-json");
  assert.equal(imported.roster.name, "Golden Boys");
  assert.equal(imported.roster.faction_id, "adeptus-custodes");
  assert.equal(imported.roster.points.total_reported, 435);
  assert.deepEqual(
    imported.roster.units.map((unit) => [
      unit.ref.id,
      unit.model_count,
      unit.points,
    ]),
    [
      ["vertus-praetors", 2, 145],
      ["vertus-praetors", 2, 145],
      ["vertus-praetors", 2, 145],
    ],
  );

  const xml = await readFile(
    new URL("new-recruit/golden-boys.ros", fixtures),
    "utf8",
  );
  assert.doesNotMatch(xml, /<(?:rules|profiles)>/);
  assert.match(xml, /battleScribeVersion="2\.03"/);
  assert.match(xml, /gameSystemId="sys-352e-adc2-7639-d610"/);
  assert.match(xml, /catalogueId="1f19-6509-d906-ca10"/);

  const archive = await readFile(
    new URL("new-recruit/golden-boys.rosz", fixtures),
  );
  const entries = unzipSync(archive);
  assert.deepEqual(Object.keys(entries), ["golden-boys.ros"]);
  assert.equal(strFromU8(entries["golden-boys.ros"]), xml);
});

test("exports interoperable XML, zipped .rosz, JSON, text, and HTML", async () => {
  const built = buildRoster({
    prompt: "Build a 1,000 point fast Custodes army with no named characters",
  });
  assert.ok(built.data);
  for (const format of [
    "ros",
    "rosz",
    "newrecruit-json",
    "roster-json",
    "text",
    "html",
  ] as const) {
    const result = await exportRoster(built.data, format);
    assert.equal(result.ok, true, `${format} export should pass`);
    assert.ok(result.data);
    if (format === "roster-json") {
      const roundTripped = parseRosterDraft(
        JSON.parse(result.data.content as string),
      );
      assert.equal(roundTripped.success, true);
      assert.deepEqual(
        roundTripped.success ? roundTripped.data : null,
        built.data,
      );
    } else if (format === "ros") {
      const xml = result.data.content as string;
      assert.match(xml, /<roster\b/);
      assert.match(xml, /Adeptus Custodes/);
      assert.match(
        xml,
        /battleScribeVersion="2\.03"/,
      );
      assert.match(
        xml,
        /gameSystemId="sys-352e-adc2-7639-d610"/,
      );
      assert.match(
        xml,
        /catalogueId="1f19-6509-d906-ca10"/,
      );
      assert.match(xml, /name="Force Disposition"/);
      assert.doesNotMatch(xml, /\bentry(?:Group)?Id="rp-/);
      assert.match(
        xml,
        /name="Battle Size" entryId="7380-3e40-6ed6-b7cc::564e-fbc6-5266-3ea4"/,
      );
      assert.match(
        xml,
        /name="Detachments" entryId="9d4f-c524-e432-f877::5218-339c-eb34-9ac0"/,
      );
      assert.match(
        xml,
        /name="Shield Host" entryId="9d4f-c524-e432-f877::70eb-2978-3ad5-5901"/,
      );
      assert.match(
        xml,
        /name="Purge the Foe" entryId="8bc8-6bfe-78bd-2480::9c70-af87-0c32-afcf::7da4-f0a6-65ec-da48"/,
      );
      assert.match(
        xml,
        /name="Blade Champion" entryId="473-b72d-a70b-e3aa::48b7-e713-d5b1-f11c"/,
      );
      const mapping = getNewRecruitFactionCatalogue(built.data.factionId);
      assert.ok(mapping);
      for (const selection of built.data.units) {
        const unitMapping = mapping.units[selection.unitId];
        assert.ok(unitMapping, `${selection.name} should have a mapping`);
        assert.match(
          xml,
          new RegExp(
            `entryId="${unitMapping.entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
          ),
        );
      }
    }
    if (format === "rosz") {
      const entries = unzipSync(result.data.content as Uint8Array);
      const names = Object.keys(entries);
      assert.equal(names.length, 1);
      assert.match(names[0], /\.ros$/);
      const xml = strFromU8(entries[names[0]]);
      assert.match(xml, /<roster\b/);
      assert.doesNotMatch(xml, /\bentry(?:Group)?Id="rp-/);
    }
    if (format === "html") {
      assert.match(result.data.content as string, /@media print/);
    }
  }
});

test("exports mixed model compositions using canonical unit roles and loadouts", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    prompt: "Build a legal Custodes roster that must include Prosecutors",
  });
  assert.ok(built.data);
  const prosecutors = built.data.units.find(
    (selection) => selection.unitId === "prosecutors",
  );
  assert.ok(prosecutors);
  assert.equal(prosecutors.modelCount, 6);

  const exported = await exportRoster(built.data, "ros");
  assert.equal(
    exported.ok,
    true,
    exported.violations.map((item) => item.message).join("; "),
  );
  assert.ok(exported.data);
  const xml = exported.data.content as string;
  assert.match(
    xml,
    /name="Prosecutor Sister Superior"[^>]+number="1"[^>]+type="model"/,
  );
  assert.match(
    xml,
    /name="Prosecutor"[^>]+group="3-9 Prosecutors"[^>]+number="5"[^>]+type="model"/,
  );
  assert.match(
    xml,
    /name="Boltgun"[^>]+number="1"[^>]+type="upgrade"/,
  );
  assert.match(
    xml,
    /name="Boltgun"[^>]+number="5"[^>]+type="upgrade"/,
  );
});

test("exports legal mixed weapon choices as separate New Recruit model groups", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 2000,
    allowNamedCharacters: false,
  });
  assert.ok(built.data);
  const replacedSelection = built.data.units.find(
    (selection) => !selection.isWarlord && selection.points >= 215,
  );
  assert.ok(replacedSelection);
  const replaced = modifyRoster(built.data, {
    type: "replace",
    selectionId: replacedSelection.selectionId,
    unitId: "vertus-praetors",
    modelCount: 3,
  });
  assert.ok(replaced.data);
  const praetors = replaced.data.units.find(
    (selection) => selection.unitId === "vertus-praetors",
  );
  assert.ok(praetors);

  const mixed = modifyRoster(replaced.data, {
    type: "set-equipment",
    selectionId: praetors.selectionId,
    equipment: [
      { itemId: "interceptor-lance-vertus-praetors", count: 3 },
      { itemId: "salvo-launcher", count: 1 },
      { itemId: "vertus-hurricane-bolter", count: 2 },
    ],
  });
  assert.equal(
    mixed.ok,
    true,
    mixed.violations.map((item) => item.message).join("; "),
  );
  assert.ok(mixed.data);

  const exported = await exportRoster(mixed.data, "ros");
  assert.equal(
    exported.ok,
    true,
    exported.violations.map((item) => item.message).join("; "),
  );
  assert.ok(exported.data);
  const xml = exported.data.content as string;
  assert.match(
    xml,
    /name="Vertus Praetor \(Hurricane Bolter\)"[^>]+number="2"[^>]+type="model"/,
  );
  assert.match(
    xml,
    /name="Vertus Praetor \(Salvo Launcher\)"[^>]+number="1"[^>]+type="model"/,
  );
});

test("prepares a validated New Recruit handoff with editable and printable artifacts", async () => {
  const built = buildRoster({
    prompt: "Build a 1,000 point fast Custodes army with no named characters",
  });
  assert.ok(built.data);

  const handoff = await prepareNewRecruitHandoff(built.data);
  assert.equal(handoff.ok, true);
  assert.ok(handoff.data);
  assert.equal(
    handoff.data.importUrl,
    "https://www.newrecruit.eu/app/MyLists",
  );
  assert.deepEqual(
    handoff.data.artifacts.map((artifact) => artifact.format),
    ["rosz", "roster-json", "text", "html"],
  );
  assert.equal(handoff.data.artifacts[0].encoding, "binary");
  assert.ok(
    handoff.data.artifacts
      .slice(1)
      .every((artifact) => artifact.encoding === "utf8"),
  );

  const invalid = {
    ...built.data,
    totalPoints: built.data.totalPoints + 1,
  };
  const blocked = await prepareNewRecruitHandoff(invalid);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.data, null);
  assert.ok(blocked.violations.length > 0);
});

test("exports every browser prompt idea with real New Recruit references", async () => {
  const prompts = [
    {
      prompt: "Build a 1,000 point fast Custodes army with no named characters",
      pointsLimit: 1000,
    },
    {
      prompt: "Build a durable 1,500 point Custodes army for objective play",
      pointsLimit: 1500,
    },
    {
      prompt: "Build a 2,000 point elite Custodes force with shooting support",
      pointsLimit: 2000,
    },
  ];

  for (const input of prompts) {
    const built = buildRoster({
      ...input,
      preferences: ["mobility"],
      allowNamedCharacters: false,
    });
    assert.ok(built.data);
    const exported = await exportRoster(built.data, "rosz");
    assert.equal(
      exported.ok,
      true,
      `${input.pointsLimit}-point browser prompt should export`,
    );
    assert.ok(exported.data);
    const entries = unzipSync(exported.data.content as Uint8Array);
    const [filename] = Object.keys(entries);
    const xml = strFromU8(entries[filename]);
    assert.doesNotMatch(xml, /\bentry(?:Group)?Id="rp-/);
    const mapping = getNewRecruitFactionCatalogue(built.data.factionId);
    assert.ok(mapping);
    for (const selection of built.data.units) {
      const unitMapping = mapping.units[selection.unitId];
      assert.ok(unitMapping, `${selection.name} should have a mapping`);
      assert.match(
        xml,
        new RegExp(
          `entryId="${unitMapping.entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
        ),
      );
    }
  }
});

test("exports every conflict-free default faction build accepted by preflight", async () => {
  let attempted = 0;
  for (const faction of factions.all) {
    const built = buildRoster({
      faction: faction.id,
      pointsLimit: 1000,
      allowLegends: false,
    });
    assert.ok(built.data, `${faction.name} should build`);
    if (!built.data || !getNewRecruitCapability(faction.id).available) {
      continue;
    }
    const conflicts = conflictsForRoster(built.data).filter(
      (item) => item.blocking,
    );
    if (conflicts.length > 0) continue;

    attempted += 1;
    const exported = await exportRoster(built.data, "rosz");
    assert.equal(
      exported.ok,
      true,
      `${faction.name}: ${exported.violations
        .map((item) => item.message)
        .join("; ")}`,
    );
  }
  assert.ok(attempted > 0);
});

test("scopes New Recruit equipment conflicts to selected wargear", () => {
  const base = {
    factionId: "adeptus-custodes",
    detachmentId: "shield-host",
    units: [
      {
        unitId: "allarus-custodians",
        modelCount: 2,
        equipment: [
          {
            itemId: "guardian-spear",
            name: "Guardian spear",
            count: 2,
          },
        ],
      },
    ],
  };
  assert.equal(
    conflictsForRoster(base).some(
      (item) => item.entityId === "allarus-custodians:vexilla",
    ),
    false,
  );
  assert.equal(
    conflictsForRoster({
      ...base,
      units: [
        {
          ...base.units[0],
          equipment: [
            ...base.units[0].equipment,
            { itemId: "vexilla", name: "Vexilla", count: 1 },
          ],
        },
      ],
    }).some(
      (item) => item.entityId === "allarus-custodians:vexilla",
    ),
    true,
  );
});

test("protects export paths and existing files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-test-"));
  try {
    const built = buildRoster({
      prompt: "Build a 1,000 point fast Custodes army with no named characters",
    });
    assert.ok(built.data);
    const result = await exportRoster(built.data, "text");
    assert.ok(result.data);
    const written = await writeExportArtifact(result.data, "list.txt", {
      rootDir: directory,
    });
    assert.equal(path.dirname(written), directory);
    await assert.rejects(
      writeExportArtifact(result.data, "list.txt", { rootDir: directory }),
      /Refusing to overwrite/,
    );
    await assert.rejects(
      writeExportArtifact(result.data, "../outside.txt", {
        rootDir: directory,
      }),
      /outside/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflights every New Recruit handoff file before batch writing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-handoff-"));
  try {
    const built = buildRoster({
      prompt: "Build a 1,000 point fast Custodes army with no named characters",
    });
    assert.ok(built.data);
    const handoff = await prepareNewRecruitHandoff(built.data);
    assert.ok(handoff.data);

    const written = await writeExportArtifacts(
      handoff.data.artifacts,
      "exports",
      { rootDir: directory },
    );
    assert.equal(written.length, 4);
    assert.ok(written.every((filename) => path.dirname(filename).endsWith("exports")));

    await assert.rejects(
      writeExportArtifacts(handoff.data.artifacts, "exports", {
        rootDir: directory,
      }),
      /Refusing to overwrite existing files/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
