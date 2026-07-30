import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRoster,
  generateFactionStressPortfolio,
  getNewRecruitFactionSummary,
  newRecruitCatalogue,
  type ConnectorEvent,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
  type TesseraStressPreparationFailureReport,
} from "../lib/rosterpilot";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import {
  TesseraStressPreparationFailureReportSchema,
  runRosterStressTest,
} from "../local/tessera/stress";
import { aggregateProfileRequirements } from "../local/tessera/profile-policy";

function roster(
  faction: string,
  pointsLimit: number,
  name: string,
): RosterDraftV1 {
  const result = buildRoster({ faction, pointsLimit, name });
  assert.equal(
    result.ok,
    true,
    result.violations
      .map((violation) => violation.message)
      .join("\n"),
  );
  assert.ok(result.data);
  return result.data;
}

function enrichedSummary(
  candidate: RosterDraftV1,
  catalogueRevisionOffset = 0,
): EnrichedRoszSummary {
  const faction = getNewRecruitFactionSummary(
    candidate.factionId,
  );
  assert.ok(faction?.catalogue.id);
  return {
    rosterName: candidate.name,
    factionName: candidate.factionName,
    totalPoints: candidate.totalPoints,
    generatedBy: "https://newrecruit.eu",
    observedNewRecruitCatalogue: {
      source: "new-recruit-enriched-rosz",
      gameSystem: {
        id: newRecruitCatalogue.gameSystem.id,
        name: newRecruitCatalogue.gameSystem.name,
        revision:
          candidate.sourceData.newRecruit.gameSystemRevision,
      },
      catalogues: [
        {
          id: faction.catalogue.id,
          name: faction.catalogue.name,
          revision:
            (candidate.sourceData.newRecruit
              .catalogueRevision ?? 0) +
            catalogueRevisionOffset,
        },
      ],
    },
    profileCount: 1,
    weaponProfileCount: 1,
    units: candidate.units.map((unit) => ({
      selectionId: unit.selectionId,
      name: unit.name,
      modelCount: unit.modelCount,
      ordinal: unit.ordinal,
      points: unit.points,
    })),
  };
}

function connectorEvent(
  candidate: RosterDraftV1,
  contentSha256: string,
): ConnectorEvent {
  return {
    schemaVersion: 1,
    eventId: `prepare-${candidate.id}`,
    recordedAt: new Date().toISOString(),
    provider: "new-recruit",
    action: "prepare",
    origin: "new-remote",
    outcome: "verified",
    remoteId: `fixture-${candidate.id}`,
    contentSha256,
  };
}

async function successfulDelivery(
  candidate: RosterDraftV1,
  options: NewRecruitDeliveryOptions = {},
  fallbackDirectory: string,
  catalogueRevisionOffset = 0,
): Promise<ResultEnvelope<NewRecruitDelivery>> {
  const outputDirectory =
    options.outputDirectory ?? fallbackDirectory;
  await mkdir(outputDirectory, { recursive: true });
  const content = Buffer.from(`fixture:${candidate.id}`);
  const contentSha256 = createHash("sha256")
    .update(content)
    .digest("hex");
  const source = path.join(outputDirectory, "source.rosz");
  const enriched = path.join(
    outputDirectory,
    "enriched.rosz",
  );
  await Promise.all([
    writeFile(source, content),
    writeFile(enriched, content),
  ]);
  const event = connectorEvent(candidate, contentSha256);
  return {
    ok: true,
    data: {
      rosterId: candidate.id,
      rosterName: candidate.name,
      listUrl:
        "https://www.newrecruit.eu/app/Lists/preparation-fixture",
      imported: true,
      sessionReused: true,
      verification: null,
      enrichedSummary: enrichedSummary(
        candidate,
        catalogueRevisionOffset,
      ),
      connectorEvents: [event],
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: "source.rosz",
          mimeType: "application/zip",
          written: source,
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: "enriched.rosz",
          mimeType: "application/zip",
          written: enriched,
        },
      ],
    },
    violations: [],
    warnings: [],
  };
}

async function profilePolicyPath(
  directory: string,
  player: RosterDraftV1,
): Promise<string> {
  const portfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: player.pointsLimit,
    suite: "core-3",
  });
  assert.ok(portfolio.data);
  const requirements = aggregateProfileRequirements([
    player,
    ...portfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const filename = path.join(directory, "profiles.json");
  await writeFile(
    filename,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        policyKind: "tessera-profile-policy",
        entries: requirements.map((requirement) => ({
          faction: requirement.faction,
          unit: requirement.unit,
          unitOccurrence: requirement.unitOccurrence,
          modelCount: requirement.modelCount,
          weaponGroup: requirement.weaponGroup,
          phase: requirement.phase,
          selectedProfile:
            requirement.availableProfiles[0],
          activeCount: requirement.activeCount,
        })),
      },
      null,
      2,
    )}\n`,
  );
  return filename;
}

function preparationFailure(
  result: Awaited<ReturnType<typeof runRosterStressTest>>,
): TesseraStressPreparationFailureReport {
  assert.equal(result.ok, false);
  assert.ok(result.data);
  assert.equal(
    result.data.reportKind,
    "tessera-stress-preparation-failure",
  );
  const report =
    result.data as TesseraStressPreparationFailureReport;
  TesseraStressPreparationFailureReportSchema.parse(report);
  assert.equal(report.status, "failed");
  assert.equal(report.simulation.status, "failed");
  assert.equal(report.simulation.engine, "none");
  assert.equal(report.simulation.trustedMatrices, 0);
  assert.equal(report.stageProvenance.screening, null);
  assert.equal(report.stageProvenance.deepDive, null);
  assert.ok(
    report.artifacts.some(
      (artifact) =>
        artifact.format === "stress-manifest",
    ),
  );
  return report;
}

test("preparation failures retain verified state without making partial receipts reusable", async () => {
  const directory = await mkdtemp(
    path.join(
      os.tmpdir(),
      "tessera-stress-preparation-failure-",
    ),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Preparation failure player",
  );
  const policyPath = await profilePolicyPath(
    directory,
    player,
  );
  let browserCalls = 0;
  const runBrowser = async () => {
    browserCalls += 1;
    throw new Error(
      "Tessera must not start after preparation failure.",
    );
  };

  const playerNull = await runRosterStressTest(
    player,
    { kind: "faction", factionId: "aeldari" },
    {
      suite: "core-3",
      analysisStrategy: "staged",
      executionMode: "simulate",
      profilePolicyPath: policyPath,
      outputDirectory: "player-null",
      rootDir: directory,
    },
    {
      deliver: async () => ({
        ok: false,
        data: null,
        violations: [
          {
            code: "NEW_RECRUIT_FIXTURE_PLAYER_NULL",
            message: "Synthetic player preparation failure.",
            severity: "error",
          },
        ],
        warnings: [],
      }),
      runBrowser,
    },
  );
  const playerNullReport =
    preparationFailure(playerNull);
  assert.equal(
    playerNullReport.preparation.failedSide,
    "player",
  );
  assert.equal(
    playerNullReport.preparation.status,
    "failed",
  );
  assert.equal(
    playerNullReport.verifiedPreparedPlayer,
    null,
  );
  assert.deepEqual(
    playerNullReport.verifiedPreparedOpponents,
    [],
  );
  assert.equal(
    playerNullReport.currentPartialPreparedReceipt,
    null,
  );
  assert.equal(
    playerNullReport.recovery.verifiedPreparedPlayer,
    false,
  );
  const playerNullManifest = JSON.parse(
    await readFile(
      path.join(
        directory,
        "player-null",
        "stress-manifest.json",
      ),
      "utf8",
    ),
  );
  assert.equal(playerNullManifest.preparedPlayer, null);
  assert.equal(
    playerNullManifest.preparedPlayerSha256,
    null,
  );
  assert.deepEqual(
    playerNullManifest.preparedOpponents,
    {},
  );

  let opponentDeliveryCalls = 0;
  const laterOpponentNull = await runRosterStressTest(
    player,
    { kind: "faction", factionId: "aeldari" },
    {
      suite: "core-3",
      analysisStrategy: "staged",
      executionMode: "simulate",
      profilePolicyPath: policyPath,
      outputDirectory: "opponent-null",
      rootDir: directory,
    },
    {
      deliver: async (candidate, options) => {
        opponentDeliveryCalls += 1;
        if (opponentDeliveryCalls === 3) {
          return {
            ok: false,
            data: null,
            violations: [
              {
                code: "NEW_RECRUIT_FIXTURE_OPPONENT_NULL",
                message:
                  "Synthetic later opponent preparation failure.",
                severity: "error",
              },
            ],
            warnings: [],
          };
        }
        return successfulDelivery(
          candidate,
          options,
          directory,
        );
      },
      runBrowser,
    },
  );
  const opponentNullReport =
    preparationFailure(laterOpponentNull);
  assert.equal(
    opponentNullReport.preparation.failedSide,
    "opponent",
  );
  assert.equal(
    opponentNullReport.preparation.status,
    "partial",
  );
  assert.ok(
    opponentNullReport.verifiedPreparedPlayer,
  );
  assert.equal(
    opponentNullReport.verifiedPreparedOpponents.length,
    1,
  );
  assert.equal(
    opponentNullReport.preparation.uniqueRosters,
    2,
  );
  assert.equal(
    opponentNullReport.currentPartialPreparedReceipt,
    null,
  );
  const opponentNullManifest = JSON.parse(
    await readFile(
      path.join(
        directory,
        "opponent-null",
        "stress-manifest.json",
      ),
      "utf8",
    ),
  );
  assert.ok(opponentNullManifest.preparedPlayer);
  assert.equal(
    Object.keys(
      opponentNullManifest.preparedOpponents,
    ).length,
    1,
  );
  assert.ok(
    opponentNullManifest.opponentPreparationStartedAt[
      opponentNullReport.preparation.failedTemplateId!
    ],
  );

  const partialProvenance = await runRosterStressTest(
    player,
    { kind: "faction", factionId: "aeldari" },
    {
      suite: "core-3",
      analysisStrategy: "staged",
      executionMode: "simulate",
      profilePolicyPath: policyPath,
      outputDirectory: "partial-provenance",
      rootDir: directory,
    },
    {
      deliver: (candidate, options) =>
        successfulDelivery(
          candidate,
          options,
          directory,
          1,
        ),
      runBrowser,
    },
  );
  const partialReport =
    preparationFailure(partialProvenance);
  assert.equal(
    partialReport.verifiedPreparedPlayer,
    null,
  );
  assert.deepEqual(
    partialReport.verifiedPreparedOpponents,
    [],
  );
  assert.ok(
    partialReport.currentPartialPreparedReceipt,
  );
  assert.equal(
    partialReport.currentPartialPreparedReceipt.side,
    "player",
  );
  assert.equal(
    partialReport.currentPartialPreparedReceipt.reusable,
    false,
  );
  assert.ok(
    partialReport.currentPartialPreparedReceipt.failureCodes.includes(
      "NEW_RECRUIT_CATALOGUE_DRIFT",
    ),
  );
  assert.equal(
    partialReport.currentPartialPreparedReceipt.prepared
      .catalogueProvenance?.status,
    "drift",
  );
  assert.equal(partialReport.connectorEvents.length, 1);
  assert.equal(
    partialReport.preparation.remoteMutations,
    1,
  );
  assert.ok(
    partialReport.artifacts
      .filter(
        (artifact) =>
          artifact.format !== "stress-manifest",
      )
      .every(
        (artifact) =>
          artifact.verification === "unverified" &&
          artifact.reusable === false,
      ),
  );
  const partialManifest = JSON.parse(
    await readFile(
      path.join(
        directory,
        "partial-provenance",
        "stress-manifest.json",
      ),
      "utf8",
    ),
  );
  assert.equal(partialManifest.preparedPlayer, null);
  assert.equal(
    partialManifest.preparedPlayerSha256,
    null,
  );
  assert.deepEqual(partialManifest.preparedOpponents, {});
  assert.equal(browserCalls, 0);
});
