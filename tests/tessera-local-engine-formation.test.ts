import assert from "node:assert/strict";
import test from "node:test";

import {
  composeSelectedLocalTesseraFormations,
  localTesseraFormationModelTotal,
  LocalTesseraFormationError,
} from "../local/tessera/local-engine-formation";
import type { LocalTesseraEngineUnit } from "../local/tessera/local-engine-input";

function unit(
  selectionId: string,
  models: number,
  points: number,
): LocalTesseraEngineUnit {
  return {
    instanceId: `${selectionId}-instance`,
    selectionId,
    unitId: `${selectionId}-unit`,
    occurrence: 1,
    label: selectionId,
    name: selectionId,
    models,
    T: 5,
    SV: 2,
    W: 3,
    INV: 4,
    FNP: null,
    points,
    keywords: selectionId === "leader" ? ["CHARACTER"] : [],
    weapons: [
      {
        name: `${selectionId} weapon`,
        type: "melee",
        count: models,
        A: 2,
        WS: 2,
        S: 5,
        AP: -2,
        D: 2,
        keywords: [],
      },
    ],
  };
}

test("selected attachments compose one bodyguard, Leader, and Support formation", () => {
  const formations = composeSelectedLocalTesseraFormations({
    rosterFingerprint: "a".repeat(64),
    attachmentPlanId: "selected-plan",
    units: [
      unit("body", 4, 180),
      unit("leader", 1, 100),
      unit("support", 2, 80),
      unit("standalone", 3, 120),
    ],
    bindings: [
      {
        leaderSelectionId: "leader",
        bodyguardSelectionId: "body",
        supportingSelectionIds: ["support"],
      },
    ],
  });

  assert.equal(formations.length, 2);
  const attached = formations[0];
  assert.deepEqual(attached.memberSelectionIds, [
    "body",
    "leader",
    "support",
  ]);
  assert.deepEqual(
    attached.attached.map((member) => [
      member.selectionId,
      member.attachmentRole,
    ]),
    [
      ["leader", "leader"],
      ["support", "support"],
    ],
  );
  assert.equal(attached.models, 4);
  assert.equal(attached.totalModels, 7);
  assert.equal(attached.points, 360);
  assert.equal(attached.totalPoints, 360);
  assert.equal(localTesseraFormationModelTotal(attached), 7);
  assert.equal(formations[1].selectionId, "standalone");
});

test("formation identity is independent of Support input ordering", () => {
  const units = [
    unit("body", 4, 180),
    unit("leader", 1, 100),
    unit("support-a", 1, 40),
    unit("support-b", 1, 40),
  ];
  const first = composeSelectedLocalTesseraFormations({
    rosterFingerprint: "b".repeat(64),
    attachmentPlanId: "selected-plan",
    units,
    bindings: [
      {
        leaderSelectionId: "leader",
        bodyguardSelectionId: "body",
        supportingSelectionIds: ["support-b", "support-a"],
      },
    ],
  });
  const second = composeSelectedLocalTesseraFormations({
    rosterFingerprint: "b".repeat(64),
    attachmentPlanId: "selected-plan",
    units,
    bindings: [
      {
        leaderSelectionId: "leader",
        bodyguardSelectionId: "body",
        supportSelectionIds: ["support-a", "support-b"],
      },
    ],
  });

  assert.equal(first[0].formationId, second[0].formationId);
  assert.deepEqual(first[0].supportSelectionIds, [
    "support-a",
    "support-b",
  ]);
});

test("a partially owned or multiply bound attachment fails closed", () => {
  assert.throws(
    () =>
      composeSelectedLocalTesseraFormations({
        rosterFingerprint: "c".repeat(64),
        attachmentPlanId: "selected-plan",
        units: [unit("body", 4, 180)],
        bindings: [
          {
            leaderSelectionId: "other-roster-leader",
            bodyguardSelectionId: "body",
          },
        ],
      }),
    (error) =>
      error instanceof LocalTesseraFormationError &&
      error.code === "TESSERA_ATTACHMENT_CROSS_ROSTER_BINDING",
  );

  assert.throws(
    () =>
      composeSelectedLocalTesseraFormations({
        rosterFingerprint: "d".repeat(64),
        attachmentPlanId: "selected-plan",
        units: [
          unit("body-a", 4, 180),
          unit("body-b", 4, 180),
          unit("leader", 1, 100),
        ],
        bindings: [
          {
            leaderSelectionId: "leader",
            bodyguardSelectionId: "body-a",
          },
          {
            leaderSelectionId: "leader",
            bodyguardSelectionId: "body-b",
          },
        ],
      }),
    (error) =>
      error instanceof LocalTesseraFormationError &&
      error.code === "TESSERA_ATTACHMENT_MEMBER_REUSED",
  );
});

