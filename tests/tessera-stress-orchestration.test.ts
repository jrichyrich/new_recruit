import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  buildRoster,
  generateFactionStressPortfolio,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
  type TesseraDirection,
  type TesseraMetric,
  type TesseraPhase,
} from "../lib/rosterpilot";
import {
  aggregateProfileRequirements,
} from "../local/tessera/profile-policy";
import { TesseraAutomationError } from "../local/tessera/browser";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import type {
  TesseraBrowserInput,
  TesseraBrowserResult,
  TesseraScenario,
} from "../local/tessera/browser";
import {
  compareRosterStressRevision,
  runRosterStressTest,
} from "../local/tessera/stress";

function roster(
  faction: string,
  pointsLimit: number,
  name: string,
): RosterDraftV1 {
  const built = buildRoster({ faction, pointsLimit, name });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("\n"),
  );
  assert.ok(built.data);
  return built.data;
}

function summaryFor(candidate: RosterDraftV1): EnrichedRoszSummary {
  return {
    rosterName: candidate.name,
    factionName: candidate.factionName,
    totalPoints: candidate.totalPoints,
    generatedBy: "https://newrecruit.eu",
    profileCount: 2,
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

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function enrichedFixture(candidate: RosterDraftV1): Uint8Array {
  const selections = candidate.units
    .map(
      (unit) => `
      <selection id="${xmlAttribute(unit.selectionId)}" name="${xmlAttribute(
        unit.name,
      )}" number="1" type="unit">
        <cost name="pts" value="${unit.points}"/>
        <selections>
          <selection name="${xmlAttribute(
            unit.name,
          )}" number="${unit.modelCount}" type="model"/>
        </selections>
      </selection>`,
    )
    .join("");
  const xml = `<?xml version="1.0"?>
<roster name="${xmlAttribute(
    candidate.name,
  )}" generatedBy="https://newrecruit.eu">
  <cost name="pts" value="${candidate.totalPoints}"/>
  <forces>
    <force name="${xmlAttribute(
      candidate.factionName,
    )}" catalogueName="${xmlAttribute(candidate.factionName)}">
      <selections>${selections}</selections>
    </force>
  </forces>
  <profiles>
    <profile name="Fixture model" typeName="Unit"/>
    <profile name="Fixture weapon" typeName="Ranged Weapons"/>
  </profiles>
</roster>`;
  return zipSync({ "fixture.ros": strToU8(xml) });
}

function occurrenceAt(
  candidate: RosterDraftV1,
  index: number,
): number {
  const name = candidate.units[index].name;
  return (
    candidate.units
      .slice(0, index + 1)
      .filter((unit) => unit.name === name).length - 1
  );
}

function metricValue(
  metric: TesseraMetric,
  direction: TesseraDirection,
): number {
  if (metric === "half-wipe-probability") {
    return direction === "player-to-opponent" ? 0.75 : 0.25;
  }
  if (metric === "wipe-probability") {
    return direction === "player-to-opponent" ? 0.55 : 0.2;
  }
  if (metric === "mean-kills") {
    return direction === "player-to-opponent" ? 3 : 1;
  }
  return direction === "player-to-opponent" ? 5 : 2;
}

function rawScenario(
  player: RosterDraftV1,
  opponent: RosterDraftV1,
  phase: TesseraPhase,
  metric: TesseraMetric,
  direction: TesseraDirection,
): TesseraScenario {
  const attackers =
    direction === "player-to-opponent" ? player : opponent;
  const targets =
    direction === "player-to-opponent" ? opponent : player;
  const value = metricValue(metric, direction);
  return {
    id: `${phase}:${metric}:${direction}`,
    phase,
    metric,
    direction,
    settings: { phase, metric, direction },
    iterations: 1_000,
    cells: attackers.units.flatMap((attacker, attackerIndex) =>
      targets.units.map((target, targetIndex) => ({
        attacker: attacker.name,
        target: target.name,
        direction,
        attackerIndex,
        targetIndex,
        attackerOccurrence: occurrenceAt(attackers, attackerIndex),
        targetOccurrence: occurrenceAt(targets, targetIndex),
        metricValue: value,
        killProbability:
          metric === "wipe-probability" ? value : null,
        expectedDamage: metric === "mean-damage" ? value : null,
        damagePer100Points: null,
      })),
    ),
  };
}

function browserResult(
  input: TesseraBrowserInput,
  player: RosterDraftV1,
  opponent: RosterDraftV1,
): TesseraBrowserResult {
  const phases = [...(input.phases ?? ["shooting", "fight"])];
  const metrics = [
    ...(input.metrics ?? [
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ]),
  ];
  const directions: TesseraDirection[] = [
    "player-to-opponent",
    "opponent-to-player",
  ];
  const scenarios = phases.flatMap((phase) =>
    metrics.flatMap((metric) =>
      directions.map((direction) =>
        rawScenario(player, opponent, phase, metric, direction),
      ),
    ),
  );
  return {
    settings: { iterations: "1000" },
    cells: scenarios[0]?.cells ?? [],
    scenarios,
    importWarnings: { player: [], opponent: [] },
    warnings: [],
  };
}

test("runs, resumes, and pairs a staged faction stress test without duplicate list delivery", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-stress-orchestration-"),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Stress Player",
  );
  const rostersByName = new Map<string, RosterDraftV1>([
    [player.name, player],
  ]);
  const delivered: string[] = [];
  const browserInputs: TesseraBrowserInput[] = [];
  let driftMeanDamageScenario = false;
  let omitFightBrowserRuns = 0;
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    delivered.push(candidate.name);
    rostersByName.set(candidate.name, candidate);
    const outputDirectory =
      options.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const source = path.join(outputDirectory, "source.rosz");
    const enriched = path.join(outputDirectory, "enriched.rosz");
    const content = enrichedFixture(candidate);
    await Promise.all([
      writeFile(source, content),
      writeFile(enriched, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl: "https://www.newrecruit.eu/app/Lists/stress-fixture",
        imported: true,
        sessionReused: true,
        verification: null,
        enrichedSummary: summaryFor(candidate),
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
  };
  const runBrowser = async (
    input: TesseraBrowserInput,
  ): Promise<TesseraBrowserResult> => {
    browserInputs.push(input);
    const playerRoster = rostersByName.get(input.playerName);
    const opponentRoster = rostersByName.get(input.opponentName);
    assert.ok(playerRoster, input.playerName);
    assert.ok(opponentRoster, input.opponentName);
    const result = browserResult(
      input,
      playerRoster,
      opponentRoster,
    );
    if (driftMeanDamageScenario) {
      const metricScenario = result.scenarios.find(
        (scenario) => scenario.metric === "mean-damage",
      );
      if (metricScenario) {
        metricScenario.iterations = 999;
        metricScenario.settings.iterations = "999";
        driftMeanDamageScenario = false;
      }
    }
    if (omitFightBrowserRuns > 0) {
      omitFightBrowserRuns -= 1;
      result.scenarios = result.scenarios?.filter(
        (scenario) => scenario.phase !== "fight",
      );
    }
    return result;
  };
  const policyPortfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1_000,
    suite: "core-3",
  });
  assert.ok(policyPortfolio.data);
  const profileRequirements = aggregateProfileRequirements([
    player,
    ...policyPortfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const profilePolicyPath = path.join(directory, "profiles.json");
  await writeFile(
    profilePolicyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: profileRequirements.map((requirement) => ({
        faction: requirement.faction,
        unit: requirement.unit,
        weaponGroup: requirement.weaponGroup,
        phase: requirement.phase,
        selectedProfile: requirement.availableProfiles[0],
        activeCount: requirement.activeCount,
      })),
    }, null, 2)}\n`,
  );

  try {
    const baseline = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        outputDirectory: "baseline",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      baseline.ok,
      true,
      baseline.violations.map((violation) => violation.message).join("\n"),
    );
    assert.ok(baseline.data);
    assert.equal(baseline.data.status, "complete");
    assert.equal(baseline.data.portfolio.coverage.ready, 3);
    assert.equal(baseline.data.representatives.length, 3);
    assert.equal(
      baseline.data.robustness?.samples.filter(
        (sample) => sample.status === "confident",
      ).length,
      3,
    );
    assert.equal(delivered.length, 4);
    assert.equal(new Set(delivered).size, 4);
    assert.equal(browserInputs.length, 6);
    assert.ok(
      browserInputs.slice(0, 3).every(
        (input) =>
          input.analysisMode === "quick" &&
          input.metrics?.join(",") === "half-wipe-probability",
      ),
    );
    assert.ok(
      browserInputs.slice(3).every(
        (input) =>
          input.analysisMode === "full" &&
          input.metrics?.join(",") ===
            "wipe-probability,mean-kills,mean-damage",
      ),
    );
    const baselineOutputDirectory = path.join(directory, "baseline");
    const baselineJsonArtifact = baseline.data.artifacts.find(
      (artifact) => artifact.format === "stress-json",
    )?.written;
    const baselineHtmlArtifact = baseline.data.artifacts.find(
      (artifact) => artifact.format === "stress-html",
    )?.written;
    const manifestArtifact = baseline.data.artifacts.find(
      (artifact) => artifact.format === "stress-manifest",
    )?.written;
    assert.ok(baselineJsonArtifact);
    assert.ok(baselineHtmlArtifact);
    assert.ok(manifestArtifact);
    const baselineJson = path.resolve(
      baselineOutputDirectory,
      baselineJsonArtifact,
    );
    const baselineHtml = path.resolve(
      baselineOutputDirectory,
      baselineHtmlArtifact,
    );
    const manifestPath = path.resolve(
      baselineOutputDirectory,
      manifestArtifact,
    );
    const shareableBaseline = JSON.parse(
      await readFile(baselineJson, "utf8"),
    );
    assert.doesNotMatch(
      JSON.stringify(shareableBaseline),
      new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.ok(
      shareableBaseline.artifacts.every(
        (artifact: { written: string }) =>
          !path.isAbsolute(artifact.written),
      ),
    );
    const relocatedDirectory = path.join(directory, "relocated-bundle");
    await mkdir(relocatedDirectory);
    await Promise.all([
      copyFile(
        baselineJson,
        path.join(relocatedDirectory, path.basename(baselineJson)),
      ),
      copyFile(
        baselineHtml,
        path.join(relocatedDirectory, path.basename(baselineHtml)),
      ),
    ]);
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(relocatedDirectory, path.basename(baselineJson)),
          "utf8",
        ),
      ).runId,
      baseline.data.runId,
    );

    const completedResume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      completedResume.ok,
      true,
      completedResume.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.equal(completedResume.data?.runId, baseline.data.runId);
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 6);

    const legacyBaselinePath = path.join(
      directory,
      "legacy-stress-baseline.json",
    );
    const legacyBaseline = structuredClone(shareableBaseline);
    legacyBaseline.schemaVersion = 1;
    delete legacyBaseline.configuration.profilePolicyHash;
    delete legacyBaseline.stageProvenance.screening.profilePolicyHash;
    if (legacyBaseline.stageProvenance.deepDive) {
      delete legacyBaseline.stageProvenance.deepDive.profilePolicyHash;
    }
    await writeFile(
      legacyBaselinePath,
      `${JSON.stringify(legacyBaseline, null, 2)}\n`,
    );
    const legacyComparison = await compareRosterStressRevision(
      legacyBaselinePath,
      {
        ...player,
        name: "Legacy Profile Provenance Revision",
      },
      {
        experimental: true,
        outputDirectory: "legacy-revision",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(legacyComparison.ok, false);
    assert.equal(
      legacyComparison.violations[0]?.code,
      "TESSERA_STRESS_BASELINE_PROFILE_PROVENANCE_REQUIRED",
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 6);

    const legacyManifestPath = path.join(
      directory,
      "legacy-stress-manifest.json",
    );
    const legacyManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    legacyManifest.schemaVersion = 1;
    delete legacyManifest.profilePolicy;
    delete legacyManifest.profilePolicyHash;
    delete legacyManifest.configuration.profilePolicyHash;
    for (const group of [
      legacyManifest.screening,
      legacyManifest.deepDive,
    ]) {
      for (const entry of Object.values(group) as Array<
        Record<string, unknown>
      >) {
        entry.error =
          entry.error && typeof entry.error === "object"
            ? (entry.error as { message?: string }).message ?? null
            : entry.error ?? null;
        delete entry.attemptCount;
        delete entry.firstAttemptAt;
        delete entry.lastAttemptAt;
        delete entry.nextAction;
      }
    }
    await writeFile(
      legacyManifestPath,
      `${JSON.stringify(legacyManifest, null, 2)}\n`,
    );
    const migratedResume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        resumeManifestPath: legacyManifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(migratedResume.ok, true);
    const rewrittenManifest = JSON.parse(
      await readFile(legacyManifestPath, "utf8"),
    );
    assert.equal(rewrittenManifest.schemaVersion, 2);
    assert.match(
      rewrittenManifest.profilePolicyHash,
      /^[0-9a-f]{64}$/,
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 6);

    await Promise.all([unlink(baselineJson), unlink(baselineHtml)]);

    const resumed = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      resumed.ok,
      true,
      resumed.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.equal(resumed.data?.status, "complete");
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 6);

    const retryManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    const retryTemplateId = Object.keys(
      retryManifest.screening,
    )[0];
    assert.ok(retryTemplateId);
    retryManifest.screening[retryTemplateId].status = "partial";
    retryManifest.screening[retryTemplateId].error =
      "Synthetic interrupted screen for resume coverage.";
    await writeFile(
      manifestPath,
      `${JSON.stringify(retryManifest, null, 2)}\n`,
    );
    const retriedPartial = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(retriedPartial.ok, true);
    assert.equal(retriedPartial.data?.status, "complete");
    assert.deepEqual(
      retriedPartial.data?.representatives,
      resumed.data?.representatives,
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 7);

    const interruptedFinalManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    interruptedFinalManifest.finalArtifacts.jsonSha256 = null;
    interruptedFinalManifest.finalArtifacts.htmlSha256 = null;
    interruptedFinalManifest.completedAt = null;
    await writeFile(
      manifestPath,
      `${JSON.stringify(interruptedFinalManifest, null, 2)}\n`,
    );
    const recoveredFinalWrite = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(recoveredFinalWrite.ok, true);
    assert.equal(recoveredFinalWrite.data?.status, "complete");
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 7);

    const revised: RosterDraftV1 = {
      ...player,
      name: "Stress Player Revised",
      updatedAt: new Date().toISOString(),
    };
    rostersByName.set(revised.name, revised);
    const revisedBaselineArtifact =
      recoveredFinalWrite.data?.artifacts.find(
      (artifact) => artifact.format === "stress-json",
    )?.written;
    assert.ok(revisedBaselineArtifact);
    const revisedBaselinePath = path.resolve(
      baselineOutputDirectory,
      revisedBaselineArtifact,
    );

    const baselineContent = await readFile(revisedBaselinePath);
    const changedBaseline = JSON.parse(
      baselineContent.toString("utf8"),
    );
    changedBaseline.warnings.push("tampered baseline");
    await writeFile(
      revisedBaselinePath,
      `${JSON.stringify(changedBaseline, null, 2)}\n`,
    );
    const changedBaselineComparison =
      await compareRosterStressRevision(
        revisedBaselinePath,
        revised,
        {
          experimental: true,
          outputDirectory: "changed-baseline-revision",
          rootDir: directory,
        },
        { deliver, runBrowser },
      );
    assert.equal(changedBaselineComparison.ok, false);
    assert.equal(
      changedBaselineComparison.violations[0]?.code,
      "TESSERA_STRESS_BASELINE_PROVENANCE_INVALID",
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 7);
    await writeFile(revisedBaselinePath, baselineContent);

    const frozenArtifact =
      resumed.data?.frozenOpponentArtifacts[0];
    assert.ok(frozenArtifact);
    const frozenManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    const frozenArtifactPath =
      frozenManifest.preparedOpponents[frozenArtifact.templateId]
        ?.prepared.enrichedRoszPath;
    assert.ok(frozenArtifactPath);
    const frozenContent = await readFile(
      frozenArtifactPath,
    );
    await writeFile(
      frozenArtifactPath,
      "tampered frozen proxy",
    );
    const tamperedComparison =
      await compareRosterStressRevision(
        revisedBaselinePath,
        revised,
        {
          experimental: true,
          outputDirectory: "tampered-revision",
          rootDir: directory,
        },
        { deliver, runBrowser },
      );
    assert.equal(tamperedComparison.ok, false);
    assert.equal(
      tamperedComparison.violations[0]?.code,
      "TESSERA_STRESS_BASELINE_ARTIFACTS_CHANGED",
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 7);
    await writeFile(
      frozenArtifactPath,
      frozenContent,
    );

    omitFightBrowserRuns = 3;
    const incompleteRevision =
      await compareRosterStressRevision(
        revisedBaselinePath,
        revised,
        {
          experimental: true,
          outputDirectory: "incomplete-revision",
          rootDir: directory,
        },
        { deliver, runBrowser },
      );
    assert.equal(incompleteRevision.ok, false);
    assert.equal(
      incompleteRevision.violations[0]?.code,
      "TESSERA_STRESS_REVISION_INCOMPLETE",
    );
    assert.equal(delivered.length, 5);
    assert.equal(browserInputs.length, 15);

    driftMeanDamageScenario = true;
    const settingsMismatch = await compareRosterStressRevision(
      revisedBaselinePath,
      revised,
      {
        experimental: true,
        outputDirectory: "settings-mismatch-revision",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(settingsMismatch.ok, false);
    assert.equal(
      settingsMismatch.violations[0]?.code,
      "TESSERA_STRESS_SETTINGS_CHANGED",
    );
    assert.equal(delivered.length, 6);
    assert.equal(browserInputs.length, 21);

    assert.equal(driftMeanDamageScenario, false);
    const compared = await compareRosterStressRevision(
      revisedBaselinePath,
      revised,
      {
        experimental: true,
        outputDirectory: "revision",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      compared.ok,
      true,
      compared.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.ok(compared.data);
    assert.deepEqual(
      compared.data.revised.representatives,
      recoveredFinalWrite.data?.representatives,
    );
    assert.equal(compared.data.sampleDeltas.length, 3);
    assert.equal(compared.data.summary.unchanged, 3);
    assert.equal(delivered.length, 7);
    assert.equal(browserInputs.length, 27);
    assert.match(
      await readFile(
        compared.data.artifacts.find(
          (artifact) =>
            artifact.format === "stress-revision-html",
        )!.written,
        "utf8",
      ),
      /faction stress-test revision comparison/i,
    );

    const stableManifestContent = await readFile(manifestPath);
    const changedPortfolioManifest = JSON.parse(
      stableManifestContent.toString("utf8"),
    );
    const changedPortfolioItem =
      changedPortfolioManifest.portfolio.items.find(
        (item: { status: string }) => item.status === "ready",
      );
    assert.ok(changedPortfolioItem?.roster?.units?.[0]);
    changedPortfolioItem.roster.units[0].unitId =
      "unmapped-fixture-unit";
    changedPortfolioManifest.screening[
      changedPortfolioItem.templateId
    ].status = "pending";
    await writeFile(
      manifestPath,
      `${JSON.stringify(changedPortfolioManifest, null, 2)}\n`,
    );
    const changedPortfolioResume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(changedPortfolioResume.ok, false);
    assert.equal(
      changedPortfolioResume.violations[0]?.code,
      "TESSERA_STRESS_RESUME_PORTFOLIO_CHANGED",
    );
    assert.equal(delivered.length, 7);
    assert.equal(browserInputs.length, 27);
    await writeFile(manifestPath, stableManifestContent);

    const unknownOutcomeManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    delete unknownOutcomeManifest.preparedOpponents[
      retryTemplateId
    ];
    unknownOutcomeManifest.opponentPreparationStartedAt[
      retryTemplateId
    ] = "2026-07-28T20:00:00.000Z";
    unknownOutcomeManifest.screening[retryTemplateId].status =
      "pending";
    await writeFile(
      manifestPath,
      `${JSON.stringify(unknownOutcomeManifest, null, 2)}\n`,
    );
    const unknownOutcomeResume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(unknownOutcomeResume.ok, false);
    assert.equal(
      unknownOutcomeResume.violations[0]?.code,
      "TESSERA_STRESS_DELIVERY_OUTCOME_UNKNOWN",
    );
    assert.equal(delivered.length, 7);
    assert.equal(browserInputs.length, 27);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds transient retries and does not loop terminal failures", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-stress-retries-"),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Retry Player",
  );
  const portfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1_000,
    suite: "core-3",
  });
  assert.ok(portfolio.data);
  const requirements = aggregateProfileRequirements([
    player,
    ...portfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const profilePolicyPath = path.join(directory, "profiles.json");
  await writeFile(
    profilePolicyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: requirements.map((requirement) => ({
        faction: requirement.faction,
        unit: requirement.unit,
        weaponGroup: requirement.weaponGroup,
        phase: requirement.phase,
        selectedProfile: requirement.availableProfiles[0],
        activeCount: requirement.activeCount,
      })),
    }, null, 2)}\n`,
  );
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    const outputDirectory = options.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const source = path.join(outputDirectory, "source.rosz");
    const enriched = path.join(outputDirectory, "enriched.rosz");
    const content = enrichedFixture(candidate);
    await Promise.all([
      writeFile(source, content),
      writeFile(enriched, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl: "https://www.newrecruit.eu/app/Lists/retry-fixture",
        imported: true,
        sessionReused: true,
        verification: null,
        enrichedSummary: summaryFor(candidate),
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
  };
  try {
    let transientCalls = 0;
    const transient = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        outputDirectory: "transient",
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          transientCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
            "Synthetic transient unlock timeout.",
          );
        },
      },
    );
    assert.equal(transient.ok, true);
    assert.equal(transient.data?.status, "partial");
    assert.equal(transientCalls, 9);
    const transientManifestPath = path.join(
      directory,
      "transient",
      "stress-manifest.json",
    );
    const transientManifest = JSON.parse(
      await readFile(transientManifestPath, "utf8"),
    );
    assert.ok(
      Object.values(transientManifest.screening).every(
        (entry) =>
          (entry as { attemptCount: number }).attemptCount === 3 &&
          (entry as { error: { retryable: boolean } }).error
            .retryable === true,
      ),
    );

    const resumed = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: transientManifestPath,
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          transientCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
            "Synthetic transient unlock timeout.",
          );
        },
      },
    );
    assert.equal(resumed.ok, true);
    assert.equal(transientCalls, 15);
    const exhausted = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: transientManifestPath,
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          transientCalls += 1;
          throw new Error("Retry budget should prevent this call.");
        },
      },
    );
    assert.equal(exhausted.ok, true);
    assert.equal(transientCalls, 15);

    let terminalCalls = 0;
    const terminal = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        outputDirectory: "terminal",
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          terminalCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PREMIUM_KEY_REJECTED",
            "Synthetic rejected key.",
          );
        },
      },
    );
    assert.equal(terminal.ok, true);
    assert.equal(terminal.data?.status, "partial");
    assert.equal(terminalCalls, 3);
    const terminalManifest = JSON.parse(
      await readFile(
        path.join(directory, "terminal", "stress-manifest.json"),
        "utf8",
      ),
    );
    assert.ok(
      Object.values(terminalManifest.screening).every(
        (entry) =>
          (entry as { attemptCount: number }).attemptCount === 1 &&
          (entry as { error: { retryable: boolean } }).error
            .retryable === false,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
