import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoster,
  repairRosterDeterministically,
  rosterExecutionFingerprint,
  rosterSimulationFingerprint,
  rosterStructuralFingerprint,
  searchFactions,
  searchUnits,
  validateRoster,
  type BuildRosterInput,
  type PreferenceTag,
  type RosterDraftV1,
  type RosterIssue,
} from "../lib/rosterpilot";

const PROPERTY_SEED = 0x5eed_40_35;
const preferenceCover: PreferenceTag[][] = [
  ["objective", "durability"],
  ["shooting", "mobility"],
  ["melee", "elite"],
  ["horde", "objective"],
];

function seededIndex(value: string, modulo: number): number {
  let hash = PROPERTY_SEED >>> 0;
  for (const character of value) {
    hash = Math.imul(
      hash ^ character.codePointAt(0)!,
      16_777_619,
    );
  }
  return (hash >>> 0) % modulo;
}

function issues(values: RosterIssue[]): string {
  return values
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join("; ");
}

function canonicalSelections(roster: RosterDraftV1): unknown[] {
  return roster.units
    .map((unit) => ({
      ...unit,
      equipment: [...unit.equipment].sort(
        (left, right) =>
          left.itemId.localeCompare(right.itemId) ||
          left.count - right.count,
      ),
      tags: [...unit.tags].sort(),
    }))
    .sort((left, right) =>
      left.selectionId.localeCompare(right.selectionId),
    );
}

function fingerprints(roster: RosterDraftV1) {
  return {
    structural: rosterStructuralFingerprint(roster),
    simulation: rosterSimulationFingerprint(roster),
    execution: rosterExecutionFingerprint(roster),
  };
}

function expectViolation(
  result: ReturnType<typeof validateRoster>,
  code: string,
  context: string,
): void {
  assert.equal(
    result.ok,
    false,
    `${context}: the intentionally illegal roster was accepted`,
  );
  assert.ok(
    result.violations.some(
      (violation) => violation.code === code,
    ),
    `${context}: expected ${code}; observed ${issues(result.violations)}`,
  );
  assert.ok(
    result.violations.every(
      (violation) =>
        violation.code.length > 0 &&
        violation.message.length > 0 &&
        violation.severity === "error",
    ),
    `${context}: every rejection must use a structured error`,
  );
}

function selectedUnitSummaries(
  roster: RosterDraftV1,
  context: string,
) {
  return [
    ...new Map(
      roster.units.map((selection) => [
        selection.unitId,
        selection,
      ]),
    ).values(),
  ].map((selection) => {
    const found = searchUnits({
      faction: roster.factionId,
      query: selection.name,
      includeLegends: true,
      limit: 100,
    });
    assert.ok(
      found.data,
      `${context}: public unit lookup failed: ${issues(found.violations)}`,
    );
    const summary = found.data.find(
      (candidate) => candidate.id === selection.unitId,
    );
    assert.ok(
      summary,
      `${context}: public unit lookup did not return ${selection.unitId}`,
    );
    return summary;
  });
}

test(
  "fixed-seed all-faction builds revalidate, round-trip, reject mutations, and preserve canonical identity",
  { timeout: 180_000 },
  () => {
    const factionResult = searchFactions("", 100);
    assert.ok(
      factionResult.data,
      `Faction discovery failed: ${issues(factionResult.violations)}`,
    );
    const factions = factionResult.data
      .filter((faction) => faction.supported)
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.equal(
      factions.length,
      35,
      `Seed ${PROPERTY_SEED}: expected all 35 build-supported factions`,
    );

    const exercisedPointBands = new Set<number>();
    for (const [index, faction] of factions.entries()) {
      // Cover both battle sizes while keeping the full-suite runtime bounded:
      // every faction gets two identical builds and every seventh faction
      // exercises the more expensive 2,000-point search.
      const pointsLimit = index % 7 === 0 ? 2_000 : 1_000;
      const preferences =
        preferenceCover[
          seededIndex(faction.id, preferenceCover.length)
        ];
      exercisedPointBands.add(pointsLimit);
      const context =
        `[seed=${PROPERTY_SEED} faction=${faction.id} points=${pointsLimit}]`;
      const input: BuildRosterInput = {
        playerFaction: faction.id,
        pointsLimit,
        name: `Property ${faction.id} ${pointsLimit}`,
        preferences,
        allowNamedCharacters: false,
        allowLegends: false,
      };

      const first = buildRoster(input);
      assert.ok(
        first.ok && first.data,
        `${context}: first build failed: ${issues(first.violations)}`,
      );
      const repeated = buildRoster(input);
      assert.ok(
        repeated.ok && repeated.data,
        `${context}: repeated build failed: ${issues(repeated.violations)}`,
      );
      const roster = first.data;
      const repeatedRoster = repeated.data;

      const validation = validateRoster(roster);
      assert.ok(
        validation.ok,
        `${context}: accepted build did not revalidate: ${issues(validation.violations)}`,
      );
      assert.equal(
        validation.data?.totalPoints,
        roster.totalPoints,
        `${context}: validation changed the point total`,
      );
      assert.equal(roster.factionId, faction.id, context);
      assert.equal(roster.pointsLimit, pointsLimit, context);
      assert.ok(
        roster.totalPoints <= pointsLimit,
        `${context}: build exceeds its point limit`,
      );

      assert.equal(
        repeatedRoster.totalPoints,
        roster.totalPoints,
        `${context}: repeated build changed points`,
      );
      assert.deepEqual(
        canonicalSelections(repeatedRoster),
        canonicalSelections(roster),
        `${context}: repeated build changed selections`,
      );
      assert.deepEqual(
        repeatedRoster.sourceData,
        roster.sourceData,
        `${context}: repeated build changed pinned provenance`,
      );
      assert.deepEqual(
        fingerprints(repeatedRoster),
        fingerprints(roster),
        `${context}: repeated build changed canonical identity`,
      );

      const roundTripped = JSON.parse(
        JSON.stringify(roster),
      ) as RosterDraftV1;
      assert.deepEqual(
        roundTripped,
        roster,
        `${context}: JSON round-trip changed the draft`,
      );
      assert.deepEqual(
        canonicalSelections(roundTripped),
        canonicalSelections(roster),
        `${context}: JSON round-trip changed selections`,
      );
      assert.deepEqual(
        roundTripped.sourceData,
        roster.sourceData,
        `${context}: JSON round-trip changed provenance`,
      );
      assert.deepEqual(
        fingerprints(roundTripped),
        fingerprints(roster),
        `${context}: JSON round-trip changed canonical identity`,
      );
      const roundTripValidation = validateRoster(roundTripped);
      assert.ok(
        roundTripValidation.ok,
        `${context}: JSON round-trip did not revalidate: ${issues(roundTripValidation.violations)}`,
      );

      const reordered = structuredClone(roster);
      reordered.units.reverse();
      for (const selection of reordered.units) {
        selection.equipment.reverse();
        selection.tags.reverse();
      }
      const reorderedValidation = validateRoster(reordered);
      assert.ok(
        reorderedValidation.ok,
        `${context}: harmless array ordering became illegal: ${issues(reorderedValidation.violations)}`,
      );
      assert.deepEqual(
        fingerprints(reordered),
        fingerprints(roster),
        `${context}: harmless array ordering changed canonical identity`,
      );
      assert.deepEqual(
        canonicalSelections(reordered),
        canonicalSelections(roster),
        `${context}: harmless array ordering changed selections`,
      );

      const unitSummaries = selectedUnitSummaries(
        roster,
        context,
      );
      assert.ok(
        unitSummaries.every(
          (selection) => !selection.isNamedCharacter,
        ),
        `${context}: allowNamedCharacters=false selected an Epic Hero`,
      );

      const wrongTotal = structuredClone(roster);
      wrongTotal.totalPoints += 1;
      expectViolation(
        validateRoster(wrongTotal),
        "POINTS_MISMATCH",
        `${context} total mutation`,
      );

      const unknownSelection = structuredClone(roster);
      unknownSelection.units[0].unitId =
        "property-test-unit-does-not-exist";
      expectViolation(
        validateRoster(unknownSelection),
        "UNIT_NOT_FOUND",
        `${context} selection mutation`,
      );

      const missingWarlord = structuredClone(roster);
      for (const selection of missingWarlord.units) {
        selection.isWarlord = false;
      }
      expectViolation(
        validateRoster(missingWarlord),
        "NO_WARLORD",
        `${context} missing Warlord mutation`,
      );

      assert.ok(
        roster.units.length >= 2,
        `${context}: property schedule needs two selections`,
      );
      const multipleWarlords = structuredClone(roster);
      multipleWarlords.units[0].isWarlord = true;
      multipleWarlords.units[1].isWarlord = true;
      expectViolation(
        validateRoster(multipleWarlords),
        "MULTIPLE_WARLORDS",
        `${context} multiple Warlord mutation`,
      );

      const nonCharacter = unitSummaries.find(
        (selection) =>
          !selection.keywords.some(
            (keyword) =>
              keyword.trim().toLocaleLowerCase() === "character",
          ),
      );
      if (nonCharacter) {
        const ineligibleWarlord = structuredClone(roster);
        const targetSelection = roster.units.find(
          (selection) => selection.unitId === nonCharacter.id,
        )!;
        for (const selection of ineligibleWarlord.units) {
          selection.isWarlord =
            selection.selectionId ===
            targetSelection.selectionId;
        }
        expectViolation(
          validateRoster(ineligibleWarlord),
          "WARLORD_INELIGIBLE",
          `${context} ineligible Warlord mutation`,
        );
      }

      const selectedUnitId = roster.units[0].unitId;
      const conflictingConstraint = buildRoster({
        playerFaction: faction.id,
        pointsLimit,
        requiredUnitIds: [selectedUnitId],
        excludedUnitIds: [selectedUnitId],
      });
      assert.equal(
        conflictingConstraint.ok,
        false,
        `${context}: contradictory unit constraints were accepted`,
      );
      assert.equal(
        conflictingConstraint.violations[0]?.code,
        "UNIT_CONSTRAINT_CONFLICT",
        `${context}: contradictory constraints lacked a structured code`,
      );

      const outsideCollection = buildRoster({
        playerFaction: faction.id,
        pointsLimit,
        collectionUnitIds: [],
        requiredUnitIds: [selectedUnitId],
      });
      assert.equal(
        outsideCollection.ok,
        false,
        `${context}: required unit outside collection was accepted`,
      );
      assert.equal(
        outsideCollection.violations[0]?.code,
        "REQUIRED_UNIT_OUTSIDE_COLLECTION",
        `${context}: collection violation lacked a structured code`,
      );

      const unknownRequired = buildRoster({
        playerFaction: faction.id,
        pointsLimit,
        requiredUnitIds: [
          "property-test-unit-does-not-exist",
        ],
      });
      assert.equal(
        unknownRequired.ok,
        false,
        `${context}: unknown required unit was accepted`,
      );
      assert.equal(
        unknownRequired.violations[0]?.code,
        "REQUIRED_UNIT_NOT_FOUND",
        `${context}: unknown constraint lacked a structured code`,
      );
    }

    assert.deepEqual(
      [...exercisedPointBands].sort((left, right) => left - right),
      [1_000, 2_000],
      `Seed ${PROPERTY_SEED}: covering schedule lost a point band`,
    );
  },
);

test(
  "deterministic repair preserves every publicly observable hard constraint",
  { timeout: 90_000 },
  async () => {
    const baseInput: BuildRosterInput = {
      prompt:
        "Build a 1,000 point Aeldari roster. Must include Farseer Skyrunner. Do not select Warlock Skyrunners.",
      playerFaction: "aeldari",
      pointsLimit: 1_000,
      preferences: ["objective", "durability"],
      allowNamedCharacters: false,
      allowLegends: false,
      requiredUnitIds: ["farseer-skyrunner"],
      excludedUnitIds: ["warlock-skyrunners"],
      requiredWarlordUnitId: "farseer-skyrunner",
      opponentContext: {
        kind: "known-faction",
        factionId: "adeptus-custodes",
      },
    };
    const baseline = buildRoster(baseInput);
    assert.ok(
      baseline.ok && baseline.data,
      `Repair baseline failed: ${issues(baseline.violations)}`,
    );
    const collectionUnitIds = [
      ...new Set(
        baseline.data.units.map((selection) => selection.unitId),
      ),
    ];
    const repaired = await repairRosterDeterministically({
      ...baseInput,
      collectionUnitIds,
    });
    assert.ok(
      repaired.ok && repaired.data,
      `Repair failed: ${issues(repaired.violations)}`,
    );
    const roster = repaired.data.roster;
    const context = "[repair faction=aeldari points=1000]";

    assert.equal(roster.factionId, "aeldari", context);
    assert.equal(roster.pointsLimit, 1_000, context);
    assert.ok(roster.totalPoints <= roster.pointsLimit, context);
    assert.equal(
      roster.constraints.allowNamedCharacters,
      false,
      context,
    );
    assert.equal(roster.constraints.allowLegends, false, context);
    assert.deepEqual(
      [...(roster.constraints.collectionUnitIds ?? [])].sort(),
      [...collectionUnitIds].sort(),
      `${context}: repair changed the collection constraint`,
    );
    assert.deepEqual(
      [...(roster.constraints.requiredUnitIds ?? [])].sort(),
      ["farseer-skyrunner"],
      `${context}: repair changed required units`,
    );
    assert.deepEqual(
      [...(roster.constraints.excludedUnitIds ?? [])].sort(),
      ["warlock-skyrunners"],
      `${context}: repair changed excluded units`,
    );
    assert.equal(
      roster.constraints.requiredWarlordUnitId,
      "farseer-skyrunner",
      `${context}: repair changed the Warlord constraint`,
    );
    assert.equal(
      roster.constraints.opponentFactionId,
      "adeptus-custodes",
      `${context}: repair changed the opponent constraint`,
    );
    assert.ok(
      roster.units.every((selection) =>
        collectionUnitIds.includes(selection.unitId),
      ),
      `${context}: repair selected outside the collection`,
    );
    assert.ok(
      roster.units.some(
        (selection) =>
          selection.unitId === "farseer-skyrunner",
      ),
      `${context}: repair removed the required unit`,
    );
    assert.ok(
      roster.units.every(
        (selection) =>
          selection.unitId !== "warlock-skyrunners",
      ),
      `${context}: repair selected an excluded unit`,
    );
    assert.equal(
      roster.units.find((selection) => selection.isWarlord)
        ?.unitId,
      "farseer-skyrunner",
      `${context}: repair changed the required Warlord`,
    );
    assert.ok(
      selectedUnitSummaries(roster, context).every(
        (selection) => !selection.isNamedCharacter,
      ),
      `${context}: repair relaxed the named-character restriction`,
    );
    const validation = validateRoster(roster);
    assert.ok(
      validation.ok,
      `${context}: repaired roster is illegal: ${issues(validation.violations)}`,
    );
  },
);

test("validateRoster rejects externally mutated embedded hard constraints", () => {
  const baseline = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1_000,
    allowNamedCharacters: false,
    allowLegends: false,
  });
  assert.ok(
    baseline.ok && baseline.data,
    `Constraint baseline failed: ${issues(baseline.violations)}`,
  );
  const context = "[embedded-constraint faction=aeldari]";

  const missingRequired = structuredClone(baseline.data);
  missingRequired.constraints.requiredUnitIds = [
    "property-test-required-unit-is-absent",
  ];
  expectViolation(
    validateRoster(missingRequired),
    "REQUIRED_UNIT_CONSTRAINT_VIOLATED",
    `${context} required unit`,
  );

  const selectedUnitId = baseline.data.units[0].unitId;
  const selectedExcluded = structuredClone(baseline.data);
  selectedExcluded.constraints.excludedUnitIds = [
    selectedUnitId,
  ];
  expectViolation(
    validateRoster(selectedExcluded),
    "EXCLUDED_UNIT_CONSTRAINT_VIOLATED",
    `${context} excluded unit`,
  );

  const outsideCollection = structuredClone(baseline.data);
  outsideCollection.constraints.collectionUnitIds =
    baseline.data.units
      .slice(1)
      .map((selection) => selection.unitId);
  expectViolation(
    validateRoster(outsideCollection),
    "COLLECTION_CONSTRAINT_VIOLATED",
    `${context} collection`,
  );

  const wrongRequiredWarlord = structuredClone(baseline.data);
  wrongRequiredWarlord.constraints.requiredWarlordUnitId =
    baseline.data.units.find(
      (selection) => !selection.isWarlord,
    )?.unitId ?? "property-test-wrong-warlord";
  expectViolation(
    validateRoster(wrongRequiredWarlord),
    "WARLORD_CONSTRAINT_VIOLATED",
    `${context} required Warlord`,
  );

  const namedUnits = searchUnits({
    faction: "aeldari",
    includeLegends: true,
    limit: 100,
  });
  assert.ok(
    namedUnits.data,
    `${context}: named-unit discovery failed: ${issues(namedUnits.violations)}`,
  );
  const namedUnit = namedUnits.data.find(
    (selection) => selection.isNamedCharacter,
  );
  assert.ok(
    namedUnit,
    `${context}: pinned data exposes no named-character fixture`,
  );
  const namedRoster = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1_000,
    allowNamedCharacters: true,
    allowLegends: false,
    requiredUnitIds: [namedUnit.id],
  });
  assert.ok(
    namedRoster.ok && namedRoster.data,
    `${context}: named-character fixture failed: ${issues(namedRoster.violations)}`,
  );
  const namedContradiction = structuredClone(namedRoster.data);
  namedContradiction.constraints.allowNamedCharacters = false;
  expectViolation(
    validateRoster(namedContradiction),
    "NAMED_CHARACTER_CONSTRAINT_VIOLATED",
    `${context} named character`,
  );
});
