import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  continueRosterJourneySafely,
  getRosterJourney,
  startRosterJourney,
  chooseRosterJourneyAction,
} from "../local/workflow/journey";
import { buildRoster } from "../lib/rosterpilot/engine";
import { exportRoster } from "../lib/rosterpilot/engine";
import { prepareNewRecruitHandoff } from "../lib/rosterpilot/handoff";

test("New Recruit handoff preserves universal exports when ROSZ is blocked", async () => {
  const roster = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
  }).data;
  assert.ok(roster);
  const handoff = await prepareNewRecruitHandoff(roster, true, {
    exportRoster: async (draft, format) =>
      format === "rosz"
        ? {
            ok: false,
            data: null,
            violations: [
              {
                code: "NEW_RECRUIT_MAPPING_UNAVAILABLE",
                message: "Fixture mapping is unavailable.",
                severity: "error",
              },
            ],
            warnings: [],
          }
        : exportRoster(draft, format),
  });

  assert.equal(handoff.ok, false);
  assert.ok(handoff.data);
  assert.deepEqual(
    handoff.data.artifacts.map((artifact) => artifact.format).sort(),
    ["html", "roster-json", "text"],
  );
});

test("durable journey preserves a legal roster and enforces revision-bound recovery", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "roster-journey-"));
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  }).data;
  assert.ok(opponent);
  const started = await startRosterJourney(
    {
      intent: "analyze",
      playerFaction: "adeptus-custodes",
      pointsLimit: 1000,
      coachingMode: "none",
      simulationBackend: "local-engine",
      opponentContext: { kind: "known-roster", roster: opponent },
    },
    { rootDir },
  );

  assert.equal(started.status, "action-required");
  assert.equal(started.recovery.rosterStillLegal, true);
  assert.equal(started.stateRevision, 1);
  assert.match(started.stateSha256, /^[0-9a-f]{64}$/);

  const loaded = await getRosterJourney(started.journeyId, { rootDir });
  assert.equal(loaded.stateSha256, started.stateSha256);

  const continued = await continueRosterJourneySafely(
    started.journeyId,
    started.stateRevision,
    { rootDir },
  );
  assert.equal(continued.stateRevision, 2);
  assert.equal(
    continued.recovery.recommendedActionId,
    "tessera.start-baseline",
  );

  await assert.rejects(
    () =>
      continueRosterJourneySafely(started.journeyId, 1, {
        rootDir,
      }),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ROSTER_JOURNEY_REVISION_CONFLICT",
      ),
  );

  const parked = await chooseRosterJourneyAction(
    started.journeyId,
    continued.stateRevision,
    "workflow.park",
    { rootDir },
  );
  assert.equal(parked.status, "parked");
});
