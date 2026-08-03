import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approveRosterJourneyDataMigration,
  continueRosterJourneySafely,
  getRosterJourney,
  repairRosterJourneyTesseraWebCompatibility,
  startRosterJourneyRepairedTesseraWebRun,
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

test("Web compatibility repair revalidates first and never starts Tessera implicitly", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "roster-repair-"));
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
      simulationBackend: "website",
      opponentContext: { kind: "known-roster", roster: opponent },
    },
    { rootDir },
  );
  assert.ok(started.workflow.roster);
  const nextRoster = structuredClone(started.workflow.roster);
  nextRoster.sourceData.newRecruit.gameSystemRevision = 8;
  nextRoster.sourceData.newRecruit.catalogueRevision = 7;
  const observedIdentity = {
    factionId: "adeptus-custodes",
    gameSystem: {
      id: "wh40k-11e",
      name: "Warhammer 40,000 11th Edition",
      revision: 8,
    },
    factionCatalogue: {
      id: "adeptus-custodes-catalogue",
      name: "Adeptus Custodes",
      revision: 7,
    },
  };
  let startedWebJobs = 0;
  const exactTargetBundleIds: string[] = [];
  const repaired = await repairRosterJourneyTesseraWebCompatibility(
    started.journeyId,
    started.stateRevision,
    {},
    {
      rootDir,
      dependencies: {
        ensureLocalServiceCompatibility: async (input) => {
          assert.equal(input.factionId, "adeptus-custodes");
          assert.equal(input.observedRevisionHint, undefined);
          return {
            status: "ready" as const,
            observedIdentity,
            compatibleBundleId: nextRoster.sourceData.bundleId,
            jobId: null,
            message: "Compatible local snapshot retained.",
          };
        },
        rebaseRosterWithProvider: async (
          roster,
          _provider,
          targetBundleId,
        ) => {
          exactTargetBundleIds.push(targetBundleId!);
          const candidate = structuredClone(
            roster as typeof nextRoster,
          );
          candidate.sourceData.bundleId = nextRoster.sourceData.bundleId;
          if (candidate.factionId === "adeptus-custodes") {
            candidate.sourceData.newRecruit.gameSystemRevision = 8;
            candidate.sourceData.newRecruit.catalogueRevision = 7;
          }
          return {
          ok: true,
          data: {
            status: "compatible-rebased",
            fromBundleId: candidate.sourceData.bundleId,
            toBundleId: nextRoster.sourceData.bundleId,
            roster: candidate,
            candidateRoster: candidate,
            provenanceChanged: true,
            changedScopes: [],
          },
          violations: [],
          warnings: [],
          };
        },
        validateRoster: () => ({
          ok: true,
          data: {
            legal: true,
            totalPoints: nextRoster.totalPoints,
          },
          violations: [],
          warnings: [],
        }),
        inspectNewRecruitMutationReceipt: async () => ({
          receiptFound: false,
          cacheKey: "fixture",
          rosterId: nextRoster.id,
          updatedAt: null,
          attemptCount: 0,
          latestAttempt: null,
          safeToRetry: false,
          requiredAction: "none",
        }),
        adoptNewRecruitMutationArtifactAcrossRosterRevision:
          async () => null,
        retainDataBundleReference: async () => true,
        startTesseraRun: async () => {
          startedWebJobs += 1;
          throw new Error("repair must not start a Web job");
        },
      },
    },
  );

  assert.equal(repaired.status, "ready-for-web");
  assert.equal(repaired.compatibilityRepair?.status, "ready-for-web");
  assert.equal(
    repaired.recovery.recommendedActionId,
    "tessera.start-successor",
  );
  assert.equal(
    repaired.recovery.actions[0]?.mcpTool,
    "start_repaired_tessera_web_run",
  );
  assert.equal(startedWebJobs, 0);
  assert.deepEqual(exactTargetBundleIds, [
    nextRoster.sourceData.bundleId,
    nextRoster.sourceData.bundleId,
  ]);
  assert.equal(
    repaired.workflow.analysis?.target.kind === "exact-opponent"
      ? repaired.workflow.analysis.target.roster.sourceData.bundleId
      : null,
    nextRoster.sourceData.bundleId,
  );
  assert.deepEqual(
    repaired.compatibilityRepair?.observedNewRecruitIdentity,
    { gameSystemRevision: 8, catalogueRevision: 7 },
  );
  assert.match(
    repaired.compatibilityRepair?.message ?? "",
    /separate approval/i,
  );

  const waitingStart = await startRosterJourney(
    {
      intent: "analyze",
      playerFaction: "adeptus-custodes",
      pointsLimit: 1000,
      simulationBackend: "website",
      opponentContext: { kind: "known-roster", roster: opponent },
    },
    { rootDir },
  );
  const waiting = await repairRosterJourneyTesseraWebCompatibility(
    waitingStart.journeyId,
    waitingStart.stateRevision,
    {},
    {
      rootDir,
      dependencies: {
        ensureLocalServiceCompatibility: async () => ({
          status: "waiting-for-compatible-source" as const,
          observedIdentity,
          compatibleBundleId: null,
          jobId: null,
          message:
            "No matching BSData commit was found in the bounded history search.",
        }),
        inspectNewRecruitMutationReceipt: async () => ({
          receiptFound: false,
          cacheKey: "waiting-fixture",
          rosterId: waitingStart.workflow.roster!.id,
          updatedAt: null,
          attemptCount: 0,
          latestAttempt: null,
          safeToRetry: false,
          requiredAction: "none",
        }),
      },
    },
  );
  assert.equal(waiting.status, "waiting-for-compatible-source");
  assert.equal(
    waiting.recovery.recommendedActionId,
    "workflow.wait-for-compatible-source",
  );
  assert.equal(waiting.workflow.roster?.id, waitingStart.workflow.roster?.id);

  const updatingStart = await startRosterJourney(
    {
      intent: "analyze",
      playerFaction: "adeptus-custodes",
      pointsLimit: 1000,
      simulationBackend: "website",
      opponentContext: { kind: "known-roster", roster: opponent },
    },
    { rootDir },
  );
  const updating = await repairRosterJourneyTesseraWebCompatibility(
    updatingStart.journeyId,
    updatingStart.stateRevision,
    {},
    {
      rootDir,
      dependencies: {
        ensureLocalServiceCompatibility: async () => ({
          status: "updating-local-data" as const,
          observedIdentity,
          compatibleBundleId: null,
          jobId: "local-update-fixture",
          message:
            "A compatibility snapshot is being built in the background.",
        }),
        inspectNewRecruitMutationReceipt: async () => ({
          receiptFound: false,
          cacheKey: "updating-fixture",
          rosterId: updatingStart.workflow.roster!.id,
          updatedAt: null,
          attemptCount: 0,
          latestAttempt: null,
          safeToRetry: false,
          requiredAction: "none",
        }),
      },
    },
  );
  assert.equal(updating.status, "updating-local-data");
  assert.equal(
    updating.compatibilityRepair?.localUpdateJobId,
    "local-update-fixture",
  );
  assert.equal(
    updating.recovery.recommendedActionId,
    "data.follow-local-update",
  );
  assert.equal(
    updating.workflow.roster?.id,
    updatingStart.workflow.roster?.id,
  );
});

test("Web compatibility repair rebases every frozen general-portfolio opponent", {
  timeout: 120_000,
}, async () => {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "roster-general-repair-"),
  );
  const started = await startRosterJourney(
    {
      intent: "analyze",
      playerFaction: "adeptus-custodes",
      pointsLimit: 1000,
      simulationBackend: "website",
      coachingMode: "none",
    },
    { rootDir },
  );
  assert.ok(started.workflow.roster);
  assert.equal(
    started.workflow.analysis?.target.kind,
    "general-six-archetype",
  );
  const compatibleBundleId = "d".repeat(64);
  const observedIdentity = {
    factionId: "adeptus-custodes",
    gameSystem: {
      id: "wh40k-11e",
      name: "Warhammer 40,000 11th Edition",
      revision: 8,
    },
    factionCatalogue: {
      id: "adeptus-custodes-catalogue",
      name: "Adeptus Custodes",
      revision: 7,
    },
  };
  const rebasedRosterIds: string[] = [];
  const repaired = await repairRosterJourneyTesseraWebCompatibility(
    started.journeyId,
    started.stateRevision,
    {},
    {
      rootDir,
      dependencies: {
        ensureLocalServiceCompatibility: async () => ({
          status: "ready" as const,
          observedIdentity,
          compatibleBundleId,
          jobId: null,
          message: "Compatible snapshot retained.",
        }),
        rebaseRosterWithProvider: async (value) => {
          const source = value as NonNullable<
            typeof started.workflow.roster
          >;
          rebasedRosterIds.push(source.id);
          const roster = structuredClone(source);
          roster.sourceData.bundleId = compatibleBundleId;
          if (roster.factionId === "adeptus-custodes") {
            roster.sourceData.newRecruit.gameSystemRevision = 8;
            roster.sourceData.newRecruit.catalogueRevision = 7;
          }
          return {
            ok: true,
            data: {
              status: "compatible-rebased" as const,
              fromBundleId: source.sourceData.bundleId,
              toBundleId: compatibleBundleId,
              roster,
              candidateRoster: roster,
              provenanceChanged: true,
              changedScopes: [],
            },
            violations: [],
            warnings: [],
          };
        },
        validateRoster: (value) => {
          const roster = value as NonNullable<
            typeof started.workflow.roster
          >;
          return {
            ok: true,
            data: { legal: true, totalPoints: roster.totalPoints },
            violations: [],
            warnings: [],
          };
        },
        inspectNewRecruitMutationReceipt: async () => ({
          receiptFound: false,
          cacheKey: "general-repair-fixture",
          rosterId: started.workflow.roster!.id,
          updatedAt: null,
          attemptCount: 0,
          latestAttempt: null,
          safeToRetry: false,
          requiredAction: "none",
        }),
        adoptNewRecruitMutationArtifactAcrossRosterRevision:
          async () => null,
        retainDataBundleReference: async () => true,
      },
    },
  );

  assert.equal(repaired.status, "ready-for-web");
  assert.equal(rebasedRosterIds.length, 7);
  assert.equal(
    repaired.workflow.roster?.sourceData.bundleId,
    compatibleBundleId,
  );
  const target = repaired.workflow.analysis?.target;
  assert.equal(target?.kind, "general-six-archetype");
  if (target?.kind === "general-six-archetype") {
    assert.equal(target.portfolio.items.length, 6);
    assert.ok(
      target.portfolio.items.every(
        (item) => item.roster.sourceData.bundleId === compatibleBundleId,
      ),
    );
  }
});

test("Web compatibility repair requires review for semantic bundle changes", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "roster-review-"));
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
      simulationBackend: "website",
      opponentContext: { kind: "known-roster", roster: opponent },
    },
    { rootDir },
  );
  assert.ok(started.workflow.roster);
  const candidateRoster = structuredClone(started.workflow.roster);
  candidateRoster.sourceData.newRecruit.gameSystemRevision = 8;
  candidateRoster.sourceData.newRecruit.catalogueRevision = 7;
  candidateRoster.sourceData.bundleId = "a".repeat(64);
  const observedIdentity = {
    factionId: "adeptus-custodes",
    gameSystem: {
      id: "wh40k-11e",
      name: "Warhammer 40,000 11th Edition",
      revision: 8,
    },
    factionCatalogue: {
      id: "adeptus-custodes-catalogue",
      name: "Adeptus Custodes",
      revision: 7,
    },
  };
  const uncertainMutation = {
    receiptFound: true,
    cacheKey: "review-fixture",
    rosterId: candidateRoster.id,
    updatedAt: "2026-08-02T00:00:00.000Z",
    attemptCount: 1,
    latestAttempt: {
      attemptId: "uncertain-attempt",
      runId: "uncertain-run",
      outcome: "created" as const,
      startedAt: "2026-08-02T00:00:00.000Z",
      finalizedAt: "2026-08-02T00:01:00.000Z",
      hasConnectorEvidence: true,
      hasInventoryEvidence: true,
      hasRecoveryArtifact: true,
    },
    safeToRetry: false,
    requiredAction: "reuse-created-artifact" as const,
  };
  const review = await repairRosterJourneyTesseraWebCompatibility(
    started.journeyId,
    started.stateRevision,
    {
      observedNewRecruitIdentity: {
        gameSystemRevision: 8,
        catalogueRevision: 7,
      },
    },
    {
      rootDir,
      dependencies: {
        ensureLocalServiceCompatibility: async (input) => {
          assert.deepEqual(input.observedRevisionHint, {
            gameSystemRevision: 8,
            catalogueRevision: 7,
          });
          return {
            status: "ready" as const,
            observedIdentity,
            compatibleBundleId: candidateRoster.sourceData.bundleId,
            jobId: null,
            message: "Compatible snapshot retained.",
          };
        },
        rebaseRosterWithProvider: async (roster) => {
          const source = roster as typeof candidateRoster;
          if (source.factionId === "adeptus-custodes") {
            return {
              ok: true,
              data: {
                status: "review-required" as const,
                fromBundleId:
                  started.workflow.roster!.sourceData.bundleId,
                toBundleId: candidateRoster.sourceData.bundleId,
                roster: started.workflow.roster!,
                candidateRoster,
                provenanceChanged: true,
                changedScopes: [
                  {
                    kind: "mapping" as const,
                    entityId: "adeptus-custodes",
                    change: "changed" as const,
                    previousHash: "b".repeat(64),
                    currentHash: "c".repeat(64),
                  },
                ],
              },
              violations: [],
              warnings: [],
            };
          }
          const targetRoster = structuredClone(source);
          targetRoster.sourceData.bundleId =
            candidateRoster.sourceData.bundleId;
          return {
            ok: true,
            data: {
              status: "compatible-rebased" as const,
              fromBundleId: source.sourceData.bundleId,
              toBundleId: candidateRoster.sourceData.bundleId,
              roster: targetRoster,
              candidateRoster: targetRoster,
              provenanceChanged: true,
              changedScopes: [],
            },
            violations: [],
            warnings: [],
          };
        },
        validateRoster: () => ({
          ok: true,
          data: {
            legal: true,
            totalPoints: candidateRoster.totalPoints,
          },
          violations: [],
          warnings: [],
        }),
        inspectNewRecruitMutationReceipt: async () =>
          uncertainMutation,
      },
    },
  );

  assert.equal(review.status, "needs-data-review");
  assert.equal(
    review.compatibilityRepair?.artifactReuse,
    "blocked-by-receipt",
  );
  assert.equal(
    review.recovery.recommendedActionId,
    "roster.review-data-migration",
  );
  assert.equal(
    review.compatibilityRepair?.compatibleBundleId,
    candidateRoster.sourceData.bundleId,
  );
  assert.equal(
    review.compatibilityRepair?.proposedWorkflow?.roster?.sourceData.bundleId,
    candidateRoster.sourceData.bundleId,
  );
  assert.deepEqual(review.compatibilityRepair?.successorJobRefs, []);

  let adoptionAttempts = 0;
  const approved = await approveRosterJourneyDataMigration(
    review.journeyId,
    review.stateRevision,
    { approvalId: "approved-migration", approvedBy: "fixture-user" },
    {
      rootDir,
      dependencies: {
        inspectNewRecruitMutationReceipt: async () =>
          uncertainMutation,
        adoptNewRecruitMutationArtifactAcrossRosterRevision:
          async () => {
            adoptionAttempts += 1;
            return null;
          },
        retainDataBundleReference: async () => true,
      },
    },
  );
  assert.equal(adoptionAttempts, 1);
  assert.equal(approved.status, "ready-for-web");
  assert.equal(
    approved.compatibilityRepair?.artifactReuse,
    "blocked-by-receipt",
  );
  assert.match(
    approved.compatibilityRepair?.message ?? "",
    /still blocks Web preparation/i,
  );

  let webStarts = 0;
  await assert.rejects(
    () =>
      startRosterJourneyRepairedTesseraWebRun(
        approved.journeyId,
        approved.stateRevision,
        { confirmExternalPreparation: true },
        {
          rootDir,
          dependencies: {
            startTesseraRun: async () => {
              webStarts += 1;
              throw new Error("blocked receipt must prevent Web preparation");
            },
          },
        },
      ),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code ===
            "NEW_RECRUIT_MUTATION_RECONCILIATION_REQUIRED",
      ),
  );
  assert.equal(webStarts, 0);
});
