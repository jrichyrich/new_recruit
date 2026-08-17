import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RosterPilotService,
  type ExactStressRunner,
  type StressRunner,
} from "../lib/rosterpilot/service";
import { modifyRoster } from "../lib/rosterpilot/engine";
import { rosterStructuralFingerprint } from "../lib/rosterpilot/stress-portfolio";
import type { RosterDraftV1 } from "../lib/rosterpilot/types";

async function fixture(options: {
  runStress?: StressRunner;
  runExactStress?: ExactStressRunner;
  deliver?: ConstructorParameters<typeof RosterPilotService>[0]["deliverToNewRecruit"];
  reconcileNewRecruitMutation?: ConstructorParameters<typeof RosterPilotService>[0]["reconcileNewRecruitMutation"];
  lease?: ConstructorParameters<typeof RosterPilotService>[0]["lease"];
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rosterpilot-service-"));
  const service = new RosterPilotService({
    rootDirectory: root,
    createId: (() => {
      let id = 0;
      return () => `operation-${++id}`;
    })(),
    lease: options.lease ?? (async (operation) => operation()),
    runStress: options.runStress,
    runExactStress: options.runExactStress,
    deliverToNewRecruit: options.deliver,
    reconcileNewRecruitMutation: options.reconcileNewRecruitMutation,
  });
  await service.initialize();
  return { service, root };
}

async function build(service: RosterPilotService, faction = "adeptus-custodes") {
  const result = await service.run({
    action: "build",
    request: `Build a 500 point ${faction} roster`,
    options: { faction, pointsLimit: 500 },
  });
  assert.equal(result.state, "completed", JSON.stringify(result.violations));
  assert.ok(result.roster?.rosterRef);
  return result;
}

async function rosterDetails(
  service: RosterPilotService,
  rosterRef: string,
): Promise<RosterDraftV1> {
  return await service.inspect({
    ref: rosterRef,
    view: "details",
  }) as RosterDraftV1;
}

test("builds a compact operation and stores a V4 roster", async () => {
  const { service, root } = await fixture();
  try {
    const result = await build(service);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4_096);
    const stored = JSON.parse(await readFile(
      path.join(root, "rosters", "v4", `${result.roster!.rosterId}.json`),
      "utf8",
    )) as { schemaVersion: number; roster: { schemaVersion: number } };
    assert.equal(stored.schemaVersion, 4);
    assert.equal(stored.roster.schemaVersion, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stores semantic roster variants under distinct collision-safe refs", async () => {
  const { service, root } = await fixture();
  try {
    const built = await service.run({
      action: "build",
      request: "Build a 500 point Adeptus Custodes roster.",
      options: {
        faction: "adeptus-custodes",
        pointsLimit: 500,
        name: "Semantic identity roster",
        requiredUnitIds: ["custodian-wardens"],
      },
    });
    assert.equal(built.state, "completed", JSON.stringify(built.violations));
    assert.ok(built.roster?.rosterRef);
    const original = await rosterDetails(service, built.roster.rosterRef);
    const wardens = original.units.find(
      (unit) => unit.unitId === "custodian-wardens",
    );
    assert.ok(wardens);
    const replacementItemId = wardens.equipment.some(
        (entry) => entry.itemId === "guardian-spear",
      )
      ? "castellan-axe"
      : "guardian-spear";
    const modified = await service.run({
      action: "modify",
      rosterRef: built.roster.rosterRef,
      options: {
        operation: {
          type: "set-equipment",
          selectionId: wardens.selectionId,
          equipment: [{
            itemId: replacementItemId,
            count: wardens.modelCount,
          }],
        },
      },
    });
    assert.equal(
      modified.state,
      "completed",
      JSON.stringify(modified.violations),
    );
    assert.ok(modified.roster?.rosterRef);
    assert.match(original.id, /^rp-[a-f0-9]{64}$/);
    assert.notEqual(modified.roster.rosterRef, built.roster.rosterRef);

    const retainedOriginal = await rosterDetails(
      service,
      built.roster.rosterRef,
    );
    const storedModified = await rosterDetails(
      service,
      modified.roster.rosterRef,
    );
    assert.deepEqual(retainedOriginal, original);
    assert.ok(
      storedModified.units
        .find((unit) => unit.selectionId === wardens.selectionId)
        ?.equipment.some((entry) => entry.itemId === replacementItemId),
    );

    const renamed = await service.run({
      action: "modify",
      rosterRef: built.roster.rosterRef,
      options: {
        operation: {
          type: "set-name",
          name: "Custodes Warden Test Cohort",
        },
      },
    });
    assert.equal(
      renamed.state,
      "completed",
      JSON.stringify(renamed.violations),
    );
    assert.notEqual(renamed.roster?.rosterRef, built.roster.rosterRef);
    const storedRenamed = await rosterDetails(
      service,
      renamed.roster!.rosterRef,
    );
    assert.equal(storedRenamed.name, "Custodes Warden Test Cohort");
    assert.deepEqual(storedRenamed.units, original.units);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves a natural-language model-count modification", async () => {
  const { service, root } = await fixture();
  try {
    const built = await service.run({
      action: "build",
      request: "Build Custodian Wardens.",
      options: {
        faction: "adeptus-custodes",
        pointsLimit: 500,
        requiredUnitIds: ["custodian-wardens"],
      },
    });
    assert.equal(built.state, "completed", JSON.stringify(built.violations));
    const original = await rosterDetails(service, built.roster!.rosterRef);
    const wardens = original.units.find(
      (unit) => unit.unitId === "custodian-wardens",
    );
    assert.ok(wardens);
    const requestedModelCount = wardens.modelCount === 4 ? 5 : 4;

    const modified = await service.run({
      action: "modify",
      rosterRef: built.roster!.rosterRef,
      request:
        `Set the Custodian Wardens unit to exactly ${requestedModelCount} models.`,
    });

    assert.equal(
      modified.state,
      "completed",
      JSON.stringify(modified.violations),
    );
    assert.equal(
      modified.roster?.units.find(
        (unit) => unit.unitId === "custodian-wardens",
      )?.models,
      requestedModelCount,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed instead of overwriting a conflicting roster reference", async () => {
  const { service, root } = await fixture();
  try {
    const request = {
      action: "build" as const,
      request: "Build a 500 point Adeptus Custodes roster.",
      options: {
        faction: "adeptus-custodes",
        pointsLimit: 500,
        name: "Storage collision roster",
      },
    };
    const built = await service.run(request);
    assert.equal(built.state, "completed", JSON.stringify(built.violations));
    assert.ok(built.roster?.rosterId);
    const filename = path.join(
      root,
      "rosters",
      "v4",
      `${built.roster.rosterId}.json`,
    );
    const conflicting = JSON.parse(await readFile(filename, "utf8")) as {
      roster: RosterDraftV1;
    };
    conflicting.roster.detachmentName = "Conflicting stored semantics";
    await writeFile(filename, `${JSON.stringify(conflicting, null, 2)}\n`);

    const repeated = await service.run(request);
    assert.equal(repeated.state, "failed");
    assert.equal(repeated.violations[0]?.code, "OPERATION_FAILED");
    assert.match(
      repeated.violations[0]?.message ?? "",
      /ROSTER_REFERENCE_COLLISION/,
    );
    const retained = JSON.parse(await readFile(filename, "utf8")) as {
      roster: RosterDraftV1;
    };
    assert.equal(
      retained.roster.detachmentName,
      "Conflicting stored semantics",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continues to read legacy roster IDs", async () => {
  const { service, root } = await fixture();
  try {
    const built = await build(service);
    const roster = await rosterDetails(service, built.roster!.rosterRef);
    const legacyId = "rp-legacy-readable";
    const legacy = { ...roster, id: legacyId };
    await writeFile(
      path.join(root, "rosters", "v4", `${legacyId}.json`),
      `${JSON.stringify({
        schemaVersion: 4,
        storedAt: "2026-01-01T00:00:00.000Z",
        importedFromSchemaVersion: 3,
        roster: legacy,
      }, null, 2)}\n`,
    );

    const inspected = await rosterDetails(
      service,
      `rosterpilot://rosters/${legacyId}`,
    );
    assert.equal(inspected.id, legacyId);
    assert.deepEqual(inspected.units, roster.units);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonicalizes structured build names and known-faction opponent scope", async () => {
  const { service, root } = await fixture();
  try {
    const result = await service.run({
      action: "build",
      request: "Build a matched-play counter roster.",
      options: {
        playerFaction: "Adeptus Custodes",
        pointsLimit: 1000,
        name: "Structured Custodes Counter",
        preferences: ["mobility"],
        allowNamedCharacters: false,
        legendsPolicy: "exclude",
        playContext: { kind: "matched-play" },
        collectionProfile: { mode: "open-catalog" },
        requiredUnitIds: ["venatari-custodians"],
        excludedUnitIds: ["vertus-praetors"],
        requiredWarlordUnitId: "shield-captain",
        detachmentId: "shield-host",
        forceDispositionId: "purge-the-foe",
        opponentFaction: "World Eaters",
        opponentAssumptions: {
          styleTags: ["aggressive", "melee"],
          source: "user-stated",
        },
        mixedThreatIntent: true,
      },
    });
    assert.equal(result.state, "completed", JSON.stringify(result.violations));
    assert.ok(result.roster?.rosterRef);

    const roster = await rosterDetails(service, result.roster.rosterRef);
    assert.equal(roster.factionId, "adeptus-custodes");
    assert.equal(roster.name, "Structured Custodes Counter");
    assert.equal(roster.pointsLimit, 1000);
    assert.equal(roster.detachmentId, "shield-host");
    assert.equal(roster.forceDispositionId, "purge-the-foe");
    assert.deepEqual(roster.preferences, ["mobility", "shooting", "melee"]);
    assert.equal(roster.constraints.allowNamedCharacters, false);
    assert.equal(roster.constraints.allowLegends, false);
    assert.equal(
      roster.constraints.legendsPolicyDecision?.requestedPolicy,
      "exclude",
    );
    assert.equal(
      roster.constraints.legendsPolicyDecision?.playContextKind,
      "matched-play",
    );
    assert.deepEqual(roster.constraints.collectionProfile, {
      mode: "open-catalog",
    });
    assert.deepEqual(roster.constraints.requiredUnitIds, [
      "shield-captain",
      "venatari-custodians",
    ]);
    assert.deepEqual(roster.constraints.excludedUnitIds, [
      "vertus-praetors",
    ]);
    assert.equal(
      roster.constraints.requiredWarlordUnitId,
      "shield-captain",
    );
    assert.equal(roster.constraints.opponentFactionId, "world-eaters");
    assert.equal(
      roster.constraints.opponentThreatProfile?.factionId,
      "world-eaters",
    );
    assert.match(
      roster.constraints.opponentPortfolioHash ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.equal(
      roster.constraints.opponentRosterFingerprints?.length,
      9,
    );
    assert.notEqual(
      roster.constraints.opponentThreatProfile?.bodyCount,
      null,
    );
    assert.ok(roster.units.some((unit) =>
      unit.unitId === "venatari-custodians"
    ));
    assert.ok(!roster.units.some((unit) =>
      unit.unitId === "vertus-praetors"
    ));
    assert.ok(roster.units.some((unit) =>
      unit.unitId === "shield-captain" && unit.isWarlord
    ));
    assert.ok((result.roster?.units.length ?? 0) > 1);
    assert.equal(result.roster?.units.length, result.roster?.unitCount);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4_096);
    const comparison = result.result?.opponentComparison as {
      status: "complete" | "bounded" | "degraded";
      scope: "exact-roster" | "faction-portfolio";
      portfolio: {
        ready: number;
        intended: number;
        complete: boolean;
        hash: string | null;
      };
      coverage: {
        datasheets: {
          rows: number;
          eligible: number;
          evaluated: number;
          omitted: number;
          truncated: boolean;
        };
        allied: {
          rules: number;
          offered: number;
          selectable: number;
          status: "inventory-only";
        };
        detachments: {
          mode: "pinned" | "enumerated";
          eligible: number;
          evaluated: number;
          successful: number;
        };
        configurations: "bounded";
      };
      recommended: {
        applied: boolean;
        rosterRef: string;
        anchors: string[];
        floor: number;
        median: number;
      };
      alternatives: Array<{ rosterRef: string; floor: number }>;
      artifact: string;
    };
    assert.equal(comparison.status, "bounded");
    assert.equal(comparison.scope, "faction-portfolio");
    assert.deepEqual(
      {
        ready: comparison.portfolio.ready,
        intended: comparison.portfolio.intended,
        complete: comparison.portfolio.complete,
      },
      { ready: 9, intended: 9, complete: true },
    );
    assert.match(comparison.portfolio.hash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(comparison.coverage.datasheets.rows, 35);
    assert.equal(comparison.coverage.datasheets.omitted, 0);
    assert.equal(comparison.coverage.datasheets.truncated, false);
    assert.deepEqual(comparison.coverage.allied, {
      rules: 2,
      offered: 51,
      selectable: 0,
      status: "inventory-only",
    });
    assert.ok(comparison.coverage.datasheets.evaluated > 0);
    assert.equal(
      comparison.coverage.datasheets.evaluated,
      comparison.coverage.datasheets.eligible,
    );
    assert.equal(comparison.coverage.detachments.mode, "pinned");
    assert.equal(
      comparison.coverage.detachments.evaluated,
      comparison.coverage.detachments.eligible,
    );
    assert.equal(comparison.coverage.configurations, "bounded");
    assert.equal(comparison.recommended.applied, true);
    assert.equal(comparison.recommended.rosterRef, result.roster.rosterRef);
    assert.equal(comparison.alternatives.length, 3);
    for (const alternative of comparison.alternatives) {
      assert.match(
        alternative.rosterRef,
        /^rosterpilot:\/\/rosters\/rp-[a-f0-9]{64}$/,
      );
    }
    for (const anchorName of comparison.recommended.anchors) {
      const selected = roster.units.find((unit) => unit.name === anchorName);
      assert.ok(selected, `${anchorName} must be present in the recommendation`);
      if (
        selected.unitId !== "venatari-custodians" &&
        selected.unitId !== "shield-captain"
      ) {
        assert.ok(
          !roster.constraints.requiredUnitIds?.includes(selected.unitId),
          "an internal exploration anchor must not become a user requirement",
        );
      }
    }

    const resource = await service.readResource(comparison.artifact);
    assert.ok("text" in resource);
    const audit = JSON.parse(resource.text) as {
      comparisonFingerprint: string;
      source: {
        bundleId: string;
        opponentFactionRulesHash: string | null;
        opponentPortfolioHash: string | null;
      };
      coverage: {
        catalogueRows: number;
        attempted: number;
        uniqueCandidates: number;
        maximumBuilds: number;
        notExpanded: number;
      };
      opponents: Array<{
        rosterId: string;
        rosterRef: string;
        structuralFingerprint: string;
        simulationFingerprint: string;
      }>;
      candidates: Array<{
        rosterRef: string;
        units: Array<{ unitId: string }>;
        matchupScores: Array<{
          templateId: string;
          score: number;
        }>;
      }>;
      ledger: Array<{
        unitId: string;
        status: string;
        reasonCode: string | null;
        simulationFingerprint: string | null;
      }>;
      serviceContract: {
        status: string;
        selectedRosterRef: string;
      };
    };
    assert.match(audit.comparisonFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(audit.source.bundleId, roster.sourceData.bundleId);
    assert.match(audit.source.opponentFactionRulesHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(
      audit.source.opponentPortfolioHash,
      comparison.portfolio.hash,
    );
    assert.equal(audit.opponents.length, 9);
    assert.ok(audit.opponents.every((entry) =>
      /^rosterpilot:\/\/rosters\/rp-[a-f0-9]{64}$/.test(entry.rosterRef) &&
      /^[a-f0-9]{64}$/.test(entry.structuralFingerprint) &&
      /^[a-f0-9]{64}$/.test(entry.simulationFingerprint)
    ));
    const replayedOpponent = await rosterDetails(
      service,
      audit.opponents[0]!.rosterRef,
    );
    assert.equal(replayedOpponent.id, audit.opponents[0]!.rosterId);
    assert.equal(
      rosterStructuralFingerprint(replayedOpponent),
      audit.opponents[0]!.structuralFingerprint,
    );
    assert.equal(audit.coverage.maximumBuilds, 48);
    assert.equal(
      audit.coverage.attempted,
      comparison.coverage.datasheets.evaluated,
    );
    assert.equal(
      audit.coverage.notExpanded,
      comparison.coverage.datasheets.omitted,
    );
    assert.equal(audit.candidates.length, audit.coverage.uniqueCandidates);
    assert.ok(audit.candidates.every((candidate) => candidate.rosterRef));
    assert.equal(audit.serviceContract.status, comparison.status);
    assert.equal(audit.serviceContract.selectedRosterRef, result.roster.rosterRef);
    assert.ok(audit.candidates.every(
      (candidate) => candidate.matchupScores.length === 9
    ));
    assert.ok(audit.candidates.some(
      (candidate) =>
        new Set(candidate.matchupScores.map((matchup) => matchup.score))
          .size > 1
    ), "opponent archetypes must produce materially different option evidence");
    const expectedOptions = [
      "venatari-custodians",
      "vertus-praetors",
      "contemptor-achillus-dreadnought",
      "contemptor-galatus-dreadnought",
      "venerable-contemptor-dreadnought",
      "telemon-heavy-dreadnought",
      "caladius-grav-tank",
      "pallas-grav-attack",
    ];
    for (const unitId of expectedOptions) {
      const entry = audit.ledger.find((item) => item.unitId === unitId);
      assert.ok(entry, `${unitId} must have a comparison-ledger row`);
      assert.notEqual(entry.status, "budget-not-expanded");
      assert.ok(
        entry.simulationFingerprint || entry.reasonCode,
        `${unitId} must have candidate evidence or an explicit reason`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builds against an exact rebased opponent reference", async () => {
  const { service, root } = await fixture();
  try {
    const opponentResult = await build(service, "world-eaters");
    const opponent = await rosterDetails(
      service,
      opponentResult.roster!.rosterRef,
    );
    const result = await service.run({
      action: "build",
      request: "Build an Adeptus Custodes counter roster.",
      opponentRef: opponentResult.roster!.rosterRef,
      options: {
        faction: "adeptus-custodes",
        pointsLimit: 500,
        comparisonBuildLimit: 1,
      },
    });
    assert.equal(result.state, "completed", JSON.stringify(result.violations));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4_096);
    assert.equal(result.opponent?.rosterId, opponent.id);
    assert.ok(result.roster?.rosterRef);
    const comparison = result.result?.opponentComparison as {
      status: "complete" | "bounded" | "degraded";
      scope: "exact-roster" | "faction-portfolio";
      portfolio: {
        ready: number;
        intended: number;
        complete: boolean;
        hash: string | null;
      };
      coverage: {
        datasheets: {
          evaluated: number;
          omitted: number;
          truncated: boolean;
        };
        allied: {
          rules: number;
          offered: number;
          selectable: number;
          status: "inventory-only";
        };
        configurations: "bounded";
      };
      recommended: {
        applied: boolean;
        rosterRef: string;
      };
      alternatives: Array<{ rosterRef: string }>;
      artifact: string;
    };
    assert.equal(comparison.status, "bounded");
    assert.equal(comparison.scope, "exact-roster");
    assert.deepEqual(comparison.portfolio, {
      ready: 1,
      intended: 1,
      complete: true,
      hash: null,
    });
    assert.equal(comparison.coverage.datasheets.evaluated, 1);
    assert.ok(comparison.coverage.datasheets.omitted > 0);
    assert.equal(comparison.coverage.datasheets.truncated, false);
    assert.deepEqual(comparison.coverage.allied, {
      rules: 2,
      offered: 51,
      selectable: 0,
      status: "inventory-only",
    });
    assert.equal(comparison.coverage.configurations, "bounded");
    assert.equal(comparison.recommended.applied, true);
    assert.equal(comparison.recommended.rosterRef, result.roster.rosterRef);
    assert.ok(comparison.alternatives.length <= 3);
    assert.doesNotMatch(result.message, /whole catalogue/i);
    const resource = await service.readResource(comparison.artifact);
    assert.ok("text" in resource);
    const audit = JSON.parse(resource.text) as {
      coverage: {
        attempted: number;
        notExpanded: number;
        maximumBuilds: number;
      };
      candidates: Array<{ rosterRef: string | null }>;
      opponents: Array<{
        rosterId: string;
        rosterRef: string;
        structuralFingerprint: string;
      }>;
      serviceContract: {
        status: string;
        portfolio: { ready: number; intended: number; complete: boolean };
      };
    };
    assert.equal(audit.coverage.maximumBuilds, 1);
    assert.equal(audit.coverage.attempted, 1);
    assert.equal(
      audit.coverage.notExpanded,
      comparison.coverage.datasheets.omitted,
    );
    assert.ok(audit.candidates.every((candidate) => candidate.rosterRef));
    assert.equal(audit.opponents.length, 1);
    assert.equal(audit.opponents[0]?.rosterRef, opponentResult.roster!.rosterRef);
    assert.equal(audit.opponents[0]?.rosterId, opponent.id);
    assert.equal(
      audit.opponents[0]?.structuralFingerprint,
      rosterStructuralFingerprint(opponent),
    );
    assert.equal(audit.serviceContract.status, "bounded");
    assert.deepEqual(audit.serviceContract.portfolio, {
      ready: 1,
      intended: 1,
      complete: true,
      hash: null,
    });
    const operation = await service.inspect({
      ref: result.operationId,
      view: "details",
    }) as { opponentRef: string | null };
    assert.equal(operation.opponentRef, opponentResult.roster!.rosterRef);

    const roster = await rosterDetails(service, result.roster.rosterRef);
    assert.equal(roster.constraints.opponentFactionId, "world-eaters");
    assert.ok(roster.constraints.opponentRosterFingerprint);
    assert.equal(
      roster.constraints.opponentThreatProfile?.bodyCount,
      opponent.units.reduce((sum, unit) => sum + unit.modelCount, 0),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for conflicting or unknown structured opponent scope", async () => {
  const { service, root } = await fixture();
  try {
    const opponent = await build(service, "world-eaters");
    const conflict = await service.run({
      action: "build",
      request: "Build an Adeptus Custodes counter roster.",
      opponentRef: opponent.roster!.rosterRef,
      options: {
        faction: "adeptus-custodes",
        pointsLimit: 500,
        opponentFaction: "world-eaters",
      },
    });
    assert.equal(conflict.state, "failed");
    assert.equal(conflict.violations[0]?.code, "OPPONENT_SCOPE_CONFLICT");

    const unknown = await service.run({
      action: "build",
      request: "Build an Adeptus Custodes counter roster.",
      options: {
        faction: "adeptus-custodes",
        pointsLimit: 500,
        opponentFaction: "not-a-supported-faction",
      },
    });
    assert.equal(unknown.state, "failed");
    assert.equal(
      unknown.violations[0]?.code,
      "OPPONENT_FACTION_UNSUPPORTED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid build options before construction", async () => {
  const { service, root } = await fixture();
  try {
    const unknownOption = await service.run({
      action: "build",
      request: "Build a roster.",
      options: {
        faction: "adeptus-custodes",
        unsupportedComparisonMode: true,
      },
    });
    assert.equal(unknownOption.state, "failed");
    assert.equal(unknownOption.violations[0]?.code, "BUILD_OPTIONS_INVALID");

    const excessiveLimit = await service.run({
      action: "build",
      request: "Build a roster.",
      options: {
        faction: "adeptus-custodes",
        comparisonBuildLimit: 501,
      },
    });
    assert.equal(excessiveLimit.state, "failed");
    assert.equal(excessiveLimit.violations[0]?.code, "BUILD_OPTIONS_INVALID");
    assert.ok(Buffer.byteLength(JSON.stringify(excessiveLimit)) <= 4_096);

    const excessiveName = await service.run({
      action: "build",
      request: "Build a roster.",
      options: {
        faction: "adeptus-custodes",
        name: "x".repeat(5_000),
      },
    });
    assert.equal(excessiveName.state, "failed");
    assert.equal(excessiveName.violations[0]?.code, "BUILD_OPTIONS_INVALID");
    assert.ok(Buffer.byteLength(JSON.stringify(excessiveName)) <= 4_096);

    const hugeUnknownKey = await service.run({
      action: "build",
      request: "Build a roster.",
      options: {
        faction: "adeptus-custodes",
        ["x".repeat(5_000)]: true,
      },
    });
    assert.equal(hugeUnknownKey.state, "failed");
    assert.equal(
      hugeUnknownKey.violations[0]?.code,
      "BUILD_OPTIONS_INVALID",
    );
    assert.ok(Buffer.byteLength(JSON.stringify(hugeUnknownKey)) <= 4_096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps faction-scoped research scoped to that faction", async () => {
  const { service, root } = await fixture();
  try {
    const result = await service.run({
      action: "research",
      options: { faction: "adeptus-custodes", limit: 100 },
    });
    assert.equal(result.state, "completed");
    assert.equal(result.result?.factionMatchCount, 1);
    assert.deepEqual(result.result?.factions, [{
      id: "adeptus-custodes",
      name: "Adeptus Custodes",
      supported: true,
    }]);
    assert.ok(Number(result.result?.unitMatchCount) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expands a faction-scoped list research request when literal search is empty", async () => {
  const { service, root } = await fixture();
  try {
    const result = await service.run({
      action: "research",
      request:
        "Find Adeptus Custodes aircraft, grav-tanks, transports, dreadnoughts, Sisters of Silence units, Wardens, Allarus, Vertus, Epic Heroes, and all current detachment-relevant options for designing unusual 2000 point armies.",
      options: { faction: "adeptus-custodes", limit: 100 },
    });

    assert.equal(result.state, "completed");
    assert.ok(Number(result.result?.unitMatchCount) > 0);
    const units = result.result?.units as Array<{ id: string }>;
    assert.ok(units.some((unit) => unit.id === "ares-gunship"));
    assert.ok(units.some((unit) =>
      unit.id === "custodian-wardens"
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports remaining points only for the selected comparison roster", async () => {
  const { service, root } = await fixture();
  try {
    const result = await service.run({
      action: "build",
      request:
        "Build an Adeptus Custodes Golden Air Force with an Ares Gunship and Orion Assault Dropship.",
      options: {
        playerFaction: "adeptus-custodes",
        opponentFaction: "world-eaters",
        detachmentId: "shield-host",
        pointsLimit: 1980,
        requiredUnitIds: ["ares-gunship", "orion-assault-dropship"],
        comparisonBuildLimit: 1,
      },
    });

    assert.equal(result.state, "completed", JSON.stringify(result.violations));
    assert.equal(result.roster?.points, "1980/1980");
    assert.ok(!result.warnings.some((warning) =>
      warning.code === "POINTS_REMAIN"
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports through an artifact reference instead of inline content", async () => {
  const { service, root } = await fixture();
  try {
    const built = await build(service);
    const exported = await service.run({
      action: "export",
      rosterRef: built.roster!.rosterRef,
      format: "rosz",
    });
    assert.equal(exported.state, "completed");
    assert.equal(exported.artifacts.length, 1);
    assert.ok(exported.artifacts[0].uri.startsWith("rosterpilot://artifacts/"));
    const resource = await service.readResource(exported.artifacts[0].uri);
    assert.ok("blob" in resource);
    assert.ok(resource.blob.length > 100);
    assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= 4_096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks export and upload actions for a stored over-copy roster", async () => {
  const { service, root } = await fixture();
  try {
    const built = await service.run({
      action: "build",
      request: "Build a Blade Champion collection roster.",
      options: {
        faction: "adeptus-custodes",
        pointsLimit: 2000,
        allowNamedCharacters: false,
        collectionUnitIds: ["blade-champion"],
        requiredWarlordUnitId: "blade-champion",
        detachmentId: "shield-host",
      },
    });
    assert.equal(built.state, "completed", JSON.stringify(built.violations));
    const roster = await rosterDetails(service, built.roster!.rosterRef);
    assert.equal(
      roster.units.filter((unit) => unit.unitId === "blade-champion").length,
      3,
    );
    const invalid = modifyRoster(roster, {
      type: "add",
      unitId: "blade-champion",
    });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.data);
    assert.ok(invalid.violations.some((violation) =>
      violation.code === "UNIT_COPY_LIMIT_EXCEEDED"
    ));
    await writeFile(
      path.join(root, "rosters", "v4", `${invalid.data.id}.json`),
      `${JSON.stringify({
        schemaVersion: 4,
        storedAt: "2026-01-01T00:00:00.000Z",
        importedFromSchemaVersion: invalid.data.schemaVersion,
        roster: invalid.data,
      }, null, 2)}\n`,
    );

    const exported = await service.run({
      action: "export",
      rosterRef: `rosterpilot://rosters/${invalid.data.id}`,
      format: "rosz",
    });
    assert.equal(exported.state, "failed");
    assert.ok(exported.violations.some((violation) =>
      violation.code === "UNIT_COPY_LIMIT_EXCEEDED"
    ));
    assert.deepEqual(exported.artifacts, []);
    assert.deepEqual(exported.nextActions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyzes two exact rosters locally without claiming a win rate", async () => {
  const { service, root } = await fixture();
  try {
    const player = await build(service, "adeptus-custodes");
    const opponent = await build(service, "world-eaters");
    const result = await service.run({
      action: "matchup",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
    });
    assert.equal(result.state, "completed");
    assert.equal(result.artifacts.length, 1);
    assert.match(String(result.result?.limitation), /not a whole-game win probability/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs local stress directly and confirms website stress through act", async () => {
  const calls: Array<{
    backend: string;
    faction: string;
    outputDirectory: string;
    profilePolicyPath?: string;
    catalogueDriftMode: string;
  }> = [];
  const runStress: StressRunner = async (_roster, faction, options) => {
    calls.push({
      backend: options.backend,
      faction,
      outputDirectory: options.outputDirectory,
      profilePolicyPath: options.profilePolicyPath,
      catalogueDriftMode: options.catalogueDriftMode,
    });
    return {
      ok: true,
      data: {
        schemaVersion: 4,
        reportKind: "tessera-stress-test",
        runId: `stress-${calls.length}`,
        status: "complete",
        simulation: { trustedMatrices: 3 },
        findings: [{ title: "Pressure", summary: "Keep screens intact." }],
      },
      violations: [],
      warnings: Array.from({ length: 30 }, (_, index) => ({
        code: `STRESS_WARNING_${index}`,
        message: "Diagnostic detail ".repeat(40),
        severity: "warn" as const,
      })),
    };
  };
  const { service, root } = await fixture({ runStress });
  try {
    const built = await build(service);
    const local = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: {
        opponentFaction: "world-eaters",
        backend: "local-engine",
        suite: "core-3",
      },
    });
    assert.equal(local.state, "completed");
    assert.ok(Buffer.byteLength(JSON.stringify(local)) <= 4_096);
    assert.equal(calls[0].backend, "local-engine");
    assert.equal(calls[0].faction, "world-eaters");
    assert.equal(calls[0].catalogueDriftMode, "reject");
    assert.equal(local.result?.catalogueDriftMode, "reject");
    assert.match(calls[0].outputDirectory, new RegExp(`${local.operationId}$`));

    const staged = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: {
        opponentFaction: "world-eaters",
        backend: "website",
        suite: "diverse-9",
        catalogueDriftMode: "diagnostic",
      },
    });
    assert.equal(staged.state, "action-required");
    assert.equal(
      staged.warnings[0]?.code,
      "CATALOGUE_DRIFT_DIAGNOSTIC_REQUESTED",
    );
    assert.equal(calls.length, 1);
    const completed = await service.act({
      operationId: staged.operationId,
      expectedRevision: staged.revision,
      actionId: "tessera.stress.run",
      choice: "profiles/world-eaters.json",
      confirm: true,
    });
    assert.equal(completed.state, "completed");
    assert.equal(calls[1].backend, "website");
    assert.equal(calls[1].faction, "world-eaters");
    assert.equal(calls[1].profilePolicyPath, "profiles/world-eaters.json");
    assert.equal(calls[1].catalogueDriftMode, "diagnostic");
    assert.equal(completed.result?.catalogueDriftMode, "diagnostic");
    assert.match(calls[1].outputDirectory, new RegExp(`${staged.operationId}$`));
    assert.notEqual(calls[0].outputDirectory, calls[1].outputDirectory);

    const replayed = await service.act({
      operationId: completed.operationId,
      expectedRevision: completed.revision,
      actionId: "tessera.stress.run",
      confirm: true,
    });
    assert.equal(replayed.state, "failed");
    assert.equal(replayed.violations[0]?.code, "ACTION_NOT_AVAILABLE");
    assert.equal(calls.length, 2);
    const retained = await service.inspect({ ref: completed.operationId }) as {
      state: string;
      revision: number;
    };
    assert.equal(retained.state, "completed");
    assert.equal(retained.revision, completed.revision);

    const forced = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: {
        opponentFaction: "world-eaters",
        backend: "local-engine",
        catalogueDriftMode: "force",
      },
    });
    assert.equal(forced.state, "failed");
    assert.equal(
      forced.violations[0]?.code,
      "STRESS_CATALOGUE_DRIFT_MODE_INVALID",
    );
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains a generated profile-policy scaffold from failed local stress", async () => {
  const runStress: StressRunner = async (_roster, _faction, options) => {
    const scaffoldPath = path.join(
      options.outputDirectory,
      "tessera-profile-policy.scaffold.json",
    );
    await mkdir(options.outputDirectory, { recursive: true });
    await writeFile(
      scaffoldPath,
      `${JSON.stringify({
        schemaVersion: 1,
        policyKind: "tessera-profile-policy",
        entries: [{
          faction: "World Eaters",
          unit: "Daemon Prince of Khorne with Wings",
          weaponGroup: "Hellforged weapons",
          phase: "fight",
          selectedProfile: "SELECT_ONE_OF: strike | sweep",
          activeCount: 1,
        }],
      }, null, 2)}\n`,
    );
    return {
      ok: false,
      data: null,
      violations: [{
        code: "TESSERA_PROFILE_POLICY_REQUIRED",
        message:
          `Explicit weapon-profile choices are required before Tessera activity. ${"Ambiguous profile detail. ".repeat(8)}Complete the scaffold at ${scaffoldPath}.`,
        severity: "error" as const,
      }],
      warnings: [],
    };
  };
  const { service, root } = await fixture({ runStress });
  try {
    const built = await build(service);
    const failed = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: {
        opponentFaction: "world-eaters",
        backend: "local-engine",
        suite: "diverse-9",
        strategy: "full-all",
      },
    });

    assert.equal(failed.state, "failed");
    assert.equal(
      failed.violations[0]?.code,
      "TESSERA_PROFILE_POLICY_REQUIRED",
    );
    assert.equal(failed.artifacts.length, 1);
    assert.equal(
      failed.artifacts[0]?.filename,
      "tessera-profile-policy.scaffold.json",
    );
    assert.match(
      failed.artifacts[0]?.uri ?? "",
      /^rosterpilot:\/\/artifacts\/[a-f0-9]{64}$/,
    );
    const resource = await service.readResource(failed.artifacts[0]!.uri);
    assert.ok("text" in resource);
    assert.match(resource.text, /Daemon Prince of Khorne with Wings/);
    assert.ok(Buffer.byteLength(JSON.stringify(failed)) <= 4_096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains a generated profile-policy scaffold from failed exact local stress", async () => {
  const runExactStress: ExactStressRunner = async (
    _player,
    _opponent,
    options,
  ) => {
    const scaffoldPath = path.join(
      options.outputDirectory,
      "profile-policy.scaffold.json",
    );
    await mkdir(options.outputDirectory, { recursive: true });
    await writeFile(
      scaffoldPath,
      `${JSON.stringify({
        schemaVersion: 1,
        policyKind: "tessera-profile-policy",
        entries: [{
          faction: "Adeptus Custodes",
          unit: "Custodian Guard",
          weaponGroup: "Guardian spear",
          phase: "shooting",
          selectedProfile: "SELECT_ONE_OF: ranged | melee",
          activeCount: 1,
        }],
      }, null, 2)}\n`,
    );
    return {
      ok: false,
      data: null,
      violations: [{
        code: "TESSERA_PROFILE_POLICY_REQUIRED",
        message:
          `Explicit weapon-profile choices are required before Tessera activity. Complete ${scaffoldPath}.`,
        severity: "error" as const,
      }],
      warnings: [],
    };
  };
  const { service, root } = await fixture({ runExactStress });
  try {
    const player = await build(service, "adeptus-custodes");
    const opponent = await build(service, "world-eaters");
    const failed = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
      options: { backend: "local-engine" },
    });

    assert.equal(failed.state, "failed");
    assert.equal(
      failed.violations[0]?.code,
      "TESSERA_PROFILE_POLICY_REQUIRED",
    );
    assert.equal(failed.artifacts.length, 1);
    assert.equal(
      failed.artifacts[0]?.filename,
      "profile-policy.scaffold.json",
    );
    assert.match(
      failed.artifacts[0]?.uri ?? "",
      /^rosterpilot:\/\/artifacts\/[a-f0-9]{64}$/,
    );
    const resource = await service.readResource(failed.artifacts[0]!.uri);
    assert.ok("text" in resource);
    assert.match(resource.text, /Custodian Guard/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not retry an uncertain Tessera website execution", async () => {
  let calls = 0;
  const runStress: StressRunner = async () => {
    calls += 1;
    throw new Error("Browser connection closed after submission.");
  };
  const { service, root } = await fixture({ runStress });
  try {
    const built = await build(service);
    const missingOpponent = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: { backend: "website" },
    });
    assert.equal(missingOpponent.state, "failed");
    assert.equal(
      missingOpponent.violations[0]?.code,
      "OPPONENT_FACTION_REQUIRED",
    );

    const staged = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: {
        opponentFaction: "world-eaters",
        backend: "website",
      },
    });
    assert.equal(staged.state, "action-required");

    const unconfirmed = await service.act({
      operationId: staged.operationId,
      expectedRevision: staged.revision,
      actionId: "tessera.stress.run",
      confirm: false,
    });
    assert.equal(unconfirmed.state, "action-required");
    assert.equal(unconfirmed.revision, staged.revision);
    assert.equal(calls, 0);

    const failed = await service.act({
      operationId: staged.operationId,
      expectedRevision: staged.revision,
      actionId: "tessera.stress.run",
      confirm: true,
    });
    assert.equal(failed.state, "failed");
    assert.equal(
      failed.violations[0]?.code,
      "TESSERA_WEB_EXECUTION_UNCERTAIN",
    );
    assert.equal(calls, 1);

    const replayed = await service.act({
      operationId: failed.operationId,
      expectedRevision: failed.revision,
      actionId: "tessera.stress.run",
      confirm: true,
    });
    assert.equal(replayed.violations[0]?.code, "ACTION_NOT_AVAILABLE");
    assert.equal(calls, 1);
    const retained = await service.inspect({ ref: failed.operationId }) as {
      state: string;
      revision: number;
      violations: Array<{ code: string }>;
    };
    assert.equal(retained.state, "failed");
    assert.equal(retained.revision, failed.revision);
    assert.equal(
      retained.violations[0]?.code,
      "TESSERA_WEB_EXECUTION_UNCERTAIN",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claims a confirmed website action before external execution", async () => {
  let calls = 0;
  let markStarted!: () => void;
  let releaseRunner!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  const runStress: StressRunner = async () => {
    calls += 1;
    markStarted();
    await release;
    return {
      ok: true,
      data: { status: "complete", runId: "claimed-once" },
      violations: [],
      warnings: [],
    };
  };
  const { service, root } = await fixture({ runStress });
  try {
    const built = await build(service);
    const staged = await service.run({
      action: "stress",
      rosterRef: built.roster!.rosterRef,
      options: {
        opponentFaction: "world-eaters",
        backend: "website",
      },
    });
    const first = service.act({
      operationId: staged.operationId,
      expectedRevision: staged.revision,
      actionId: "tessera.stress.run",
      confirm: true,
    });
    await started;

    const concurrent = await service.act({
      operationId: staged.operationId,
      expectedRevision: staged.revision,
      actionId: "tessera.stress.run",
      confirm: true,
    });
    assert.equal(concurrent.state, "failed");
    assert.equal(
      concurrent.violations[0]?.code,
      "OPERATION_ACTION_IN_PROGRESS",
    );
    assert.equal(calls, 1);

    releaseRunner();
    const completed = await first;
    assert.equal(completed.state, "completed");
    assert.equal(calls, 1);
  } finally {
    releaseRunner?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("routes exact stress locally and confirms exact website stress through act", async () => {
  const calls: Array<{
    playerId: string;
    opponentId: string;
    backend: string;
    allowPointMismatch: boolean;
    profilePolicyPath?: string;
    baselineReportPath?: string;
    catalogueDriftMode: string;
    selectedPlayerAbilityIds: string[];
    activationMode: string;
    selectedAttachmentBindings: Array<{
      side: string;
      leaderSelectionId: string;
      bodyguardSelectionId: string;
      supportingSelectionIds: string[];
    }>;
  }> = [];
  const runExactStress: ExactStressRunner = async (player, opponent, options) => {
    calls.push({
      playerId: player.id,
      opponentId: opponent.id,
      backend: options.backend,
      allowPointMismatch: options.allowPointMismatch,
      profilePolicyPath: options.profilePolicyPath,
      baselineReportPath: options.baselineReportPath,
      catalogueDriftMode: options.catalogueDriftMode,
      selectedPlayerAbilityIds: options.selectedPlayerAbilityIds,
      activationMode: options.activationMode,
      selectedAttachmentBindings: options.selectedAttachmentBindings,
    });
    const data = {
      schemaVersion: 4,
      reportKind: "tessera-matchup-analysis",
      runId: `exact-${calls.length}`,
      status: "complete",
      simulation: { trustedMatrices: 16 },
      findings: [{ title: "Exact pressure", summary: "Preserve screens." }],
      ...(options.backend === "website"
        ? {
            artifacts: [
              { format: "matchup-json", written: `exact-${calls.length}-matchup.json` },
              { format: "matchup-html", written: `exact-${calls.length}-matchup.html` },
              { format: "matchup-receipt", written: `exact-${calls.length}-matchup.receipt.json` },
            ],
          }
        : {}),
    };
    if (options.backend === "website") {
      await mkdir(options.outputDirectory, { recursive: true });
      await writeFile(
        path.join(options.outputDirectory, `exact-${calls.length}-matchup.json`),
        `${JSON.stringify(data)}\n`,
      );
      await writeFile(
        path.join(options.outputDirectory, `exact-${calls.length}-matchup.html`),
        "<!doctype html><title>Matchup heatmap</title>\n",
      );
      await writeFile(
        path.join(options.outputDirectory, `exact-${calls.length}-matchup.receipt.json`),
        `${JSON.stringify({ reportFilename: `exact-${calls.length}-matchup.json` })}\n`,
      );
    }
    return {
      ok: true,
      data,
      violations: [],
      warnings: [],
    };
  };
  const { service, root } = await fixture({ runExactStress });
  try {
    const player = await build(service, "adeptus-custodes");
    const opponent = await build(service, "world-eaters");
    const local = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
      options: {
        backend: "local-engine",
        allowPointMismatch: true,
        selectedPlayerAbilityIds: ["moment-shackle", "moment-shackle"],
        selectedAttachmentBindings: [{
          side: "opponent",
          leaderSelectionId: " opponent-leader ",
          bodyguardSelectionId: " opponent-bodyguard ",
          supportingSelectionIds: ["support-b", "support-a"],
        }],
      },
    });
    assert.equal(local.state, "completed");
    assert.equal(local.result?.mode, "exact");
    assert.equal(local.opponent?.rosterId, opponent.roster!.rosterId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].backend, "local-engine");
    assert.equal(calls[0].allowPointMismatch, true);
    assert.equal(calls[0].catalogueDriftMode, "reject");
    assert.deepEqual(calls[0].selectedPlayerAbilityIds, ["moment-shackle"]);
    assert.equal(calls[0].activationMode, "baseline");
    assert.deepEqual(calls[0].selectedAttachmentBindings, [{
      side: "opponent",
      leaderSelectionId: "opponent-leader",
      bodyguardSelectionId: "opponent-bodyguard",
      supportingSelectionIds: ["support-a", "support-b"],
    }]);

    const attachedEnvelope = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
      options: {
        backend: "local-engine",
        activationMode: "envelope",
        selectedAttachmentBindings: [{
          side: "opponent",
          leaderSelectionId: "opponent-leader",
          bodyguardSelectionId: "opponent-bodyguard",
        }],
      },
    });
    assert.equal(attachedEnvelope.state, "completed");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].activationMode, "envelope");
    assert.deepEqual(calls[1].selectedAttachmentBindings, [{
      side: "opponent",
      leaderSelectionId: "opponent-leader",
      bodyguardSelectionId: "opponent-bodyguard",
      supportingSelectionIds: [],
    }]);

    const activationConflict = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
      options: {
        backend: "local-engine",
        selectedPlayerAbilityIds: ["moment-shackle"],
        activationMode: "envelope",
      },
    });
    assert.equal(activationConflict.state, "failed");
    assert.equal(
      activationConflict.violations[0]?.code,
      "STRESS_ACTIVATION_SCOPE_CONFLICT",
    );

    const conflict = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
      options: {
        backend: "local-engine",
        opponentFaction: "world-eaters",
      },
    });
    assert.equal(conflict.state, "failed");
    assert.equal(conflict.violations[0]?.code, "OPPONENT_SCOPE_CONFLICT");

    const malformedAttachment = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
      options: {
        backend: "local-engine",
        selectedAttachmentBindings: [{
          side: "opponent",
          leaderSelectionId: "opponent-leader",
        }],
      },
    });
    assert.equal(malformedAttachment.state, "failed");
    assert.equal(
      malformedAttachment.violations[0]?.code,
      "STRESS_ATTACHMENT_BINDINGS_INVALID",
    );

    const factionAttachment = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      options: {
        backend: "local-engine",
        opponentFaction: "world-eaters",
        selectedAttachmentBindings: [],
      },
    });
    assert.equal(factionAttachment.state, "failed");
    assert.equal(
      factionAttachment.violations[0]?.code,
      "STRESS_ATTACHMENT_PROVIDER_UNSUPPORTED",
    );

    const websiteAttachment = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
      options: {
        backend: "website",
        selectedAttachmentBindings: [],
      },
    });
    assert.equal(websiteAttachment.state, "failed");
    assert.equal(
      websiteAttachment.violations[0]?.code,
      "STRESS_ATTACHMENT_PROVIDER_UNSUPPORTED",
    );

    const revisionAttachment = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
      options: {
        backend: "local-engine",
        baselineReportPath: "reports/baseline.json",
        selectedAttachmentBindings: [],
      },
    });
    assert.equal(revisionAttachment.state, "failed");
    assert.equal(
      revisionAttachment.violations[0]?.code,
      "STRESS_ATTACHMENT_REVISION_UNSUPPORTED",
    );
    assert.equal(calls.length, 2);

    const staged = await service.run({
      action: "stress",
      rosterRef: player.roster!.rosterRef,
      opponentRef: opponent.roster!.rosterRef,
      options: {
        backend: "website",
        allowPointMismatch: true,
        baselineReportPath: "reports/baseline.json",
        catalogueDriftMode: "diagnostic",
      },
    });
    assert.equal(staged.state, "action-required");
    assert.equal(staged.opponent?.rosterId, opponent.roster!.rosterId);
    assert.equal(calls.length, 2);

    const completed = await service.act({
      operationId: staged.operationId,
      expectedRevision: staged.revision,
      actionId: "tessera.stress.run",
      choice: "profiles/exact.json",
      confirm: true,
    });
    assert.equal(completed.state, "completed");
    assert.equal(completed.result?.mode, "exact");
    assert.equal(calls.length, 3);
    assert.equal(calls[2].backend, "website");
    assert.equal(calls[2].profilePolicyPath, "profiles/exact.json");
    assert.equal(calls[2].baselineReportPath, "reports/baseline.json");
    assert.equal(calls[2].catalogueDriftMode, "diagnostic");
    assert.equal(completed.artifacts[0]?.filename, "exact-3-matchup.json");
    assert.equal(completed.artifacts[1]?.filename, "exact-3-matchup.html");
    assert.equal(completed.artifacts[1]?.mimeType, "text/html");
    const stored = await service.inspect({ ref: completed.artifacts[0]!.uri });
    const storedPath = (stored as { path: string }).path;
    const receipt = JSON.parse(await readFile(
      path.join(path.dirname(storedPath), "exact-3-matchup.receipt.json"),
      "utf8",
    )) as { reportFilename: string };
    assert.equal(receipt.reportFilename, "exact-3-matchup.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks stale actions and performs confirmed New Recruit upload once", async () => {
  let deliveries = 0;
  let leaseDepth = 0;
  const deliveryOptions: Array<Parameters<NonNullable<
    ConstructorParameters<typeof RosterPilotService>[0]["deliverToNewRecruit"]
  >>[1]> = [];
  const { service, root } = await fixture({
    lease: async (operation) => {
      leaseDepth += 1;
      try {
        return await operation();
      } finally {
        leaseDepth -= 1;
      }
    },
    deliver: async (roster, options) => {
      assert.equal(leaseDepth, 1);
      deliveries += 1;
      deliveryOptions.push(options);
      return {
        ok: true,
        data: {
          rosterId: roster.id,
          rosterName: roster.name,
          listUrl: "https://www.newrecruit.eu/app/list/example",
          imported: true,
          sessionReused: false,
          verification: {
            name: true,
            faction: true,
            points: true,
            units: [],
            mismatches: [],
          },
          artifacts: [],
        },
        violations: [],
        warnings: [],
      };
    },
  });
  try {
    const unexportable = await service.run({
      action: "build",
      request: "Build a 1000 point Necrons roster",
      options: {
        faction: "necrons",
        pointsLimit: 1000,
        allowNamedCharacters: false,
        requiredUnitIds: ["tesseract-vault"],
      },
    });
    assert.equal(
      unexportable.state,
      "completed",
      JSON.stringify(unexportable.violations),
    );
    assert.equal(
      unexportable.nextActions.some(
        (action) => action.actionId === "new-recruit.upload",
      ),
      false,
    );
    const blocked = await service.act({
      operationId: unexportable.operationId,
      expectedRevision: unexportable.revision,
      actionId: "new-recruit.upload",
      confirm: true,
    });
    assert.equal(blocked.state, "failed");
    assert.equal(blocked.violations[0]?.code, "ACTION_NOT_AVAILABLE");
    assert.equal(deliveries, 0);

    const unexportableRoster = await rosterDetails(
      service,
      unexportable.roster!.rosterRef,
    );
    const imported = await service.importRoster(unexportableRoster);
    assert.equal(imported.state, "completed");
    assert.equal(
      imported.nextActions.some(
        (action) => action.actionId === "new-recruit.upload",
      ),
      false,
    );

    const equipmentSelection = unexportableRoster.units.find(
      (selection) => selection.equipment.length > 0,
    );
    assert.ok(equipmentSelection);
    const modified = await service.run({
      action: "modify",
      rosterRef: unexportable.roster!.rosterRef,
      options: {
        operation: {
          type: "set-equipment",
          selectionId: equipmentSelection.selectionId,
          equipment: equipmentSelection.equipment.map((entry) => ({
            itemId: entry.itemId,
            count: entry.count,
          })),
        },
      },
    });
    assert.equal(modified.state, "completed", JSON.stringify(modified.violations));
    assert.equal(
      modified.nextActions.some(
        (action) => action.actionId === "new-recruit.upload",
      ),
      false,
    );

    const textExport = await service.run({
      action: "export",
      rosterRef: unexportable.roster!.rosterRef,
      format: "text",
    });
    assert.equal(textExport.state, "completed");
    assert.equal(
      textExport.nextActions.some(
        (action) => action.actionId === "new-recruit.upload",
      ),
      false,
    );
    assert.equal(deliveries, 0);

    const built = await build(service);
    const stale = await service.act({
      operationId: built.operationId,
      expectedRevision: built.revision + 1,
      actionId: "new-recruit.upload",
      confirm: true,
    });
    assert.equal(stale.state, "failed");
    assert.equal(deliveries, 0);

    const current = await service.inspect({ ref: built.operationId }) as {
      revision: number;
    };
    const uploaded = await service.act({
      operationId: built.operationId,
      expectedRevision: current.revision,
      actionId: "new-recruit.upload",
      confirm: true,
    });
    assert.equal(uploaded.state, "completed");
    assert.equal(deliveries, 1);
    assert.equal(deliveryOptions[0].rootDir, root);
    assert.equal(
      deliveryOptions[0].outputDirectory,
      path.join("new-recruit", built.operationId),
    );

    const replayed = await service.act({
      operationId: uploaded.operationId,
      expectedRevision: uploaded.revision,
      actionId: "new-recruit.upload",
      confirm: true,
    });
    assert.equal(replayed.state, "failed");
    assert.equal(replayed.violations[0]?.code, "ACTION_NOT_AVAILABLE");
    assert.equal(deliveries, 1);
    const retained = await service.inspect({ ref: uploaded.operationId }) as {
      state: string;
      revision: number;
    };
    assert.equal(retained.state, "completed");
    assert.equal(retained.revision, uploaded.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offers New Recruit reconciliation when a prior upload is uncertain", async () => {
  let reconciled: string | null = null;
  const { service, root } = await fixture({
    deliver: async () => ({
      ok: false,
      data: null,
      violations: [{
        code: "NEW_RECRUIT_MUTATION_RECONCILIATION_REQUIRED",
        message: "Attempt prior is uncertain.",
        severity: "error",
      }],
      warnings: [],
    }),
    reconcileNewRecruitMutation: async (input) => {
      reconciled = input.outcome;
    },
  });
  try {
    const built = await build(service);
    const uploaded = await service.act({
      operationId: built.operationId,
      expectedRevision: built.revision,
      actionId: "new-recruit.upload",
      confirm: true,
    });
    assert.equal(uploaded.state, "action-required");
    assert.equal(
      uploaded.violations[0]?.code,
      "NEW_RECRUIT_MUTATION_RECONCILIATION_REQUIRED",
    );
    assert.equal(
      uploaded.nextActions[0]?.actionId,
      "new-recruit.reconcile-outcome",
    );
    const reconciledOperation = await service.act({
      operationId: uploaded.operationId,
      expectedRevision: uploaded.revision,
      actionId: "new-recruit.reconcile-outcome",
      choice: "created",
      confirm: true,
    });
    assert.equal(reconciled, "created");
    assert.equal(reconciledOperation.state, "action-required");
    assert.equal(
      reconciledOperation.nextActions[0]?.actionId,
      "new-recruit.upload",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
