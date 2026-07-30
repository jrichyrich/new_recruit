import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderedOpponentMatrixPlayer,
  type OrderedOpponentMatrixPlayerEvidence,
} from "../local/certification/ordered-opponent-matrix";
import { searchFactions } from "../lib/rosterpilot";

function assertAuditablePair(
  evidence: OrderedOpponentMatrixPlayerEvidence,
  playerFactionId: string,
  opponentFactionId: string,
): void {
  assert.equal(evidence.playerFactionId, playerFactionId);
  assert.equal(evidence.opponentFactionId, opponentFactionId);
  assert.equal(
    evidence.buildInput.playerFaction,
    playerFactionId,
  );
  assert.deepEqual(evidence.buildInput.opponentContext, {
    kind: "known-faction",
    factionId: opponentFactionId,
  });
  assert.equal(evidence.roster.factionId, playerFactionId);
  assert.equal(
    evidence.roster.opponentFactionId,
    opponentFactionId,
  );
  assert.equal(evidence.validation.ok, true);
  assert.deepEqual(evidence.validation.violations, []);
  assert.match(evidence.roster.rosterFingerprint, /^[0-9a-f]{64}$/);
  assert.match(
    evidence.roster.executionFingerprint,
    /^[0-9a-f]{64}$/,
  );

  const scoring = evidence.opponentScoring;
  assert.equal(scoring.generatorVersion, "beam-search-v1");
  assert.equal(
    scoring.targetCoverage.opponentFactionId,
    opponentFactionId,
  );
  assert.equal(
    scoring.selectedCandidates.length,
    evidence.roster.unitCount,
  );
  assert.ok(evidence.roster.detachmentId.length > 0);
  assert.ok(evidence.roster.unitRoles.length > 0);
  assert.equal(
    scoring.selectedCandidates.reduce(
      (sum, candidate) =>
        sum + candidate.components.opponentCoverage,
      0,
    ),
    scoring.targetCoverage.selectedCoverageScore,
  );
  assert.ok(
    scoring.selectedCandidates.every(
      (candidate) =>
        candidate.selectionId.length > 0 &&
        Number.isFinite(candidate.components.total) &&
        Number.isFinite(
          candidate.components.opponentCoverage,
        ),
    ),
  );
  for (const share of [
    scoring.targetCoverage.eliteShare,
    scoring.targetCoverage.hordeShare,
    scoring.targetCoverage.mobilityShare,
    scoring.targetCoverage.vehicleMonsterShare,
  ]) {
    assert.ok(share >= 0 && share <= 1);
  }
}

test(
  "ordered matrix evidence genuinely builds and scores both faction directions",
  { timeout: 120_000 },
  () => {
    const custodesAgainstAeldari =
      buildOrderedOpponentMatrixPlayer({
        playerFactionId: "adeptus-custodes",
        playerFactionName: "Adeptus Custodes",
        opponentFactionId: "aeldari",
        opponentFactionName: "Aeldari",
        pointsLimit: 1000,
        preferences: ["objective", "durability"],
        allowNamedCharacters: true,
        allowLegends: false,
      });
    const aeldariAgainstCustodes =
      buildOrderedOpponentMatrixPlayer({
        playerFactionId: "aeldari",
        playerFactionName: "Aeldari",
        opponentFactionId: "adeptus-custodes",
        opponentFactionName: "Adeptus Custodes",
        pointsLimit: 1000,
        preferences: ["objective", "durability"],
        allowNamedCharacters: true,
        allowLegends: false,
      });

    assertAuditablePair(
      custodesAgainstAeldari,
      "adeptus-custodes",
      "aeldari",
    );
    assertAuditablePair(
      aeldariAgainstCustodes,
      "aeldari",
      "adeptus-custodes",
    );
    assert.notEqual(
      custodesAgainstAeldari.roster.rosterFingerprint,
      aeldariAgainstCustodes.roster.rosterFingerprint,
      "reversing an ordered pair must not relabel the opponent preview as the player roster",
    );
    assert.notEqual(
      custodesAgainstAeldari.roster.executionFingerprint,
      aeldariAgainstCustodes.roster.executionFingerprint,
    );
  },
);

test("ordered matrix player build fails closed when the known opponent cannot be retained", () => {
  assert.throws(
    () =>
      buildOrderedOpponentMatrixPlayer({
        playerFactionId: "adeptus-custodes",
        playerFactionName: "Adeptus Custodes",
        opponentFactionId: "not-a-faction",
        opponentFactionName: "Unknown fixture",
        pointsLimit: 1000,
        preferences: ["objective", "durability"],
        allowNamedCharacters: true,
        allowLegends: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { code?: string }).code,
        "CERTIFICATION_ORDERED_MATRIX_CONTEXT_MISMATCH",
      );
      return true;
    },
  );
});

test(
  "every build-supported faction passes the pull-request opponent covering array",
  { timeout: 180_000 },
  () => {
    const factions = searchFactions("", 100).data
      ?.filter((faction) => faction.supported)
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.ok(factions);
    assert.equal(factions.length, 35);
    const opponents = [
      {
        id: "adeptus-custodes",
        name: "Adeptus Custodes",
        archetype: "elite",
      },
      { id: "orks", name: "Orks", archetype: "mass" },
      {
        id: "imperial-knights",
        name: "Imperial Knights",
        archetype: "vehicle-monster",
      },
    ] as const;
    const observedPairs = new Set<string>();

    for (const player of factions) {
      for (const opponent of opponents) {
        const evidence = buildOrderedOpponentMatrixPlayer({
          playerFactionId: player.id,
          playerFactionName: player.name,
          opponentFactionId: opponent.id,
          opponentFactionName: opponent.name,
          pointsLimit: 1_000,
          preferences: ["objective", "durability"],
          allowNamedCharacters: true,
          allowLegends: false,
        });
        assertAuditablePair(evidence, player.id, opponent.id);
        observedPairs.add(`${player.id}:${opponent.archetype}`);
      }
    }

    assert.equal(
      observedPairs.size,
      factions.length * opponents.length,
    );
  },
);
