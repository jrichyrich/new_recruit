import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeMissionReadiness,
  buildRoster,
  modifyRoster,
  type RosterDraftV1,
  type TesseraChangeCandidate,
  type TesseraFinding,
  type TesseraMatchupReport,
  type TesseraStressFinding,
  type TesseraStressPortfolio,
} from "../lib/rosterpilot";
import {
  aggregateChangeCandidates,
} from "../local/tessera/stress";
import {
  preservesRosterHardConstraints,
} from "../local/tessera/candidate-quality";

function antiAeldariRoster(): RosterDraftV1 {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Adeptus Custodes 1000 vs Aeldari",
    preferences: [
      "mobility",
      "durability",
      "objective",
      "shooting",
      "melee",
    ],
    detachmentId: "tharanatoi-hammerblow",
    forceDispositionId: "priority-assets",
    requiredUnitIds: [
      "agamatus-custodians",
      "pallas-grav-attack",
    ],
  });
  assert.equal(built.ok, true);
  assert.ok(built.data);
  assert.equal(built.data.totalPoints, 1_000);
  return built.data;
}

const roleGap: TesseraFinding = {
  findingId: "fight-role-gap",
  kind: "role-gap",
  severity: "warn",
  confidence: "high",
  summary: "The baseline fight matrices contain no reliable answer.",
  unitInstanceIds: [],
  evidence: [],
};

function candidateReports(
  candidate: TesseraChangeCandidate,
  findings: TesseraFinding[] = [roleGap],
): Map<string, TesseraMatchupReport> {
  return new Map([
    [
      "balanced-control-mixed",
      {
        changeCandidates: [candidate],
        findings,
      } as TesseraMatchupReport,
    ],
    [
      "ranged-pressure-mixed",
      {
        changeCandidates: [candidate],
        findings,
      } as TesseraMatchupReport,
    ],
  ]);
}

function portfolio(): TesseraStressPortfolio {
  return {
    coverage: { ready: 3 },
    items: [
      {
        templateId: "balanced-control-mixed",
        posture: "balanced-control",
      },
      {
        templateId: "ranged-pressure-mixed",
        posture: "ranged-pressure",
      },
    ],
  } as TesseraStressPortfolio;
}

test("change-candidate qualification preserves every frozen hard constraint", () => {
  const player = antiAeldariRoster();
  assert.equal(
    preservesRosterHardConstraints(
      player,
      structuredClone(player),
    ),
    true,
  );

  const required = player.units.find(
    (unit) => unit.unitId === "agamatus-custodians",
  );
  assert.ok(required);
  const removesRequired = modifyRoster(player, {
    type: "replace",
    selectionId: required.selectionId,
    unitId: "prosecutors",
  });
  assert.ok(removesRequired.data);
  assert.equal(
    preservesRosterHardConstraints(player, removesRequired.data),
    false,
  );

  const replaceable = player.units.find(
    (unit) => unit.selectionId !== required.selectionId,
  );
  assert.ok(replaceable);
  const excludedBaseline = {
    ...player,
    constraints: {
      ...player.constraints,
      requiredUnitIds: [],
      excludedUnitIds: ["prosecutors"],
    },
  };
  const addsExcluded = modifyRoster(excludedBaseline, {
    type: "replace",
    selectionId: replaceable.selectionId,
    unitId: "prosecutors",
  });
  assert.ok(addsExcluded.data);
  assert.equal(
    preservesRosterHardConstraints(
      excludedBaseline,
      addsExcluded.data,
    ),
    false,
  );

  const namedBaseline = {
    ...player,
    constraints: {
      ...player.constraints,
      allowNamedCharacters: false,
      requiredUnitIds: [],
    },
  };
  const addsNamedCharacter = {
    ...namedBaseline,
    units: namedBaseline.units.map((unit, index) =>
      index === 0
        ? {
            ...unit,
            unitId: "trajann-valoris",
            name: "Trajann Valoris",
          }
        : unit,
    ),
  };
  assert.equal(
    preservesRosterHardConstraints(
      namedBaseline,
      addsNamedCharacter,
    ),
    false,
  );

  const warlord = player.units.find((unit) => unit.isWarlord);
  assert.ok(warlord);
  const requiredWarlordBaseline = {
    ...player,
    constraints: {
      ...player.constraints,
      requiredWarlordUnitId: warlord.unitId,
    },
  };
  const changesRequiredWarlord = {
    ...requiredWarlordBaseline,
    units: requiredWarlordBaseline.units.map((unit) => ({
      ...unit,
      isWarlord: false,
    })),
  };
  assert.equal(
    preservesRosterHardConstraints(
      requiredWarlordBaseline,
      changesRequiredWarlord,
    ),
    false,
  );
});

test("stress aggregation rejects underfilled and robust-unit replacement candidates", async () => {
  const player = antiAeldariRoster();
  const readiness = analyzeMissionReadiness(player);
  assert.ok(readiness.data);
  const agamatus = player.units.find(
    (unit) => unit.name === "Agamatus Custodians",
  );
  assert.ok(agamatus);
  const underfilled: TesseraChangeCandidate = {
    candidateId: "underfilled",
    title: "Replace Agamatus Custodians with Prosecutors",
    rationale: "Synthetic regression for the live 585-point result.",
    operation: {
      type: "replace",
      selectionId: agamatus.selectionId,
      unitId: "prosecutors",
    },
    beforePoints: player.totalPoints,
    afterPoints: 585,
    rosterFingerprint: "underfilled",
    evidenceFindingIds: [roleGap.findingId],
  };
  assert.deepEqual(
    await aggregateChangeCandidates(
      player,
      candidateReports(underfilled),
      portfolio(),
      readiness.data,
      [],
    ),
    [],
  );

  const pallas = player.units.find(
    (unit) => unit.name === "Pallas Grav-attack",
  );
  assert.ok(pallas);
  const robustReplacement: TesseraChangeCandidate = {
    candidateId: "robust-replacement",
    title: "Replace Pallas Grav-attack with Shield-Captain",
    rationale: "Synthetic regression for protected robust answers.",
    operation: {
      type: "replace",
      selectionId: pallas.selectionId,
      unitId: "shield-captain",
    },
    beforePoints: player.totalPoints,
    afterPoints: 1_000,
    rosterFingerprint: "robust-replacement",
    evidenceFindingIds: [roleGap.findingId],
  };
  const unrelatedFinding: TesseraFinding = {
    findingId: "unrelated-threat",
    kind: "enemy-threat",
    severity: "warn",
    confidence: "high",
    summary: "A threat affects a different player unit.",
    unitInstanceIds: [agamatus.selectionId],
    evidence: [
      {
        scenarioId: "unrelated-scenario",
        attackerInstanceId: "opponent-unit",
        targetInstanceId: agamatus.selectionId,
        phase: "shooting",
        direction: "opponent-to-player",
        values: {
          wipeProbability: 0.8,
          halfWipeProbability: 0.9,
          meanKills: null,
          meanDamage: null,
          damagePer100Points: null,
        },
      },
    ],
  };
  const unrelatedCandidate = {
    ...robustReplacement,
    candidateId: "unrelated",
    evidenceFindingIds: [unrelatedFinding.findingId],
  };
  assert.deepEqual(
    await aggregateChangeCandidates(
      player,
      candidateReports(unrelatedCandidate, [unrelatedFinding]),
      portfolio(),
      readiness.data,
      [],
    ),
    [],
  );

  const robustFinding: TesseraStressFinding = {
    findingId: "robust-pallas",
    kind: "robust-answer",
    severity: "info",
    confidence: "high",
    summary: "Pallas is a robust answer.",
    templateIds: [
      "balanced-control-mixed",
      "ranged-pressure-mixed",
    ],
    supportingWeight: 0.75,
    unitInstanceIds: [pallas.selectionId],
  };
  assert.deepEqual(
    await aggregateChangeCandidates(
      player,
      candidateReports(robustReplacement),
      portfolio(),
      readiness.data,
      [robustFinding],
    ),
    [],
  );
});
