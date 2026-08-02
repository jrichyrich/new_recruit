import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  buildRoster,
  generateFactionStressPortfolio,
  getNewRecruitFactionSummary,
  inspectEnrichedRosz,
  newRecruitCatalogue,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import { aggregateProfileRequirements } from "../local/tessera/profile-policy";
import { runRosterStressTest } from "../local/tessera/stress";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function localEngineFixture(roster: RosterDraftV1): Uint8Array {
  const faction = getNewRecruitFactionSummary(roster.factionId);
  assert.ok(faction);
  const selections = roster.units.map((unit) => `
    <selection id="${escapeXml(unit.selectionId)}" name="${escapeXml(unit.name)}" number="1" type="unit">
      <profiles><profile name="${escapeXml(unit.name)}" typeName="Unit"><characteristics>
        <characteristic name="M">6&quot;</characteristic><characteristic name="T">5</characteristic><characteristic name="Sv">3+</characteristic><characteristic name="W">3</characteristic><characteristic name="LD">6+</characteristic><characteristic name="OC">1</characteristic><characteristic name="InSv">4+</characteristic>
      </characteristics></profile></profiles>
      <selections>
        <selection id="${escapeXml(unit.selectionId)}-models" name="Models" number="${unit.modelCount}" type="model" />
        <selection id="${escapeXml(unit.selectionId)}-ranged" name="Fixture ranged weapon" number="${unit.modelCount}" type="upgrade"><profiles><profile name="Fixture ranged weapon" typeName="Ranged Weapons"><characteristics>
          <characteristic name="Range">24&quot;</characteristic><characteristic name="A">2</characteristic><characteristic name="BS">3+</characteristic><characteristic name="S">5</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">-</characteristic>
        </characteristics></profile></profiles></selection>
        <selection id="${escapeXml(unit.selectionId)}-melee" name="Fixture melee weapon" number="${unit.modelCount}" type="upgrade"><profiles><profile name="Fixture melee weapon" typeName="Melee Weapons"><characteristics>
          <characteristic name="Range">Melee</characteristic><characteristic name="A">3</characteristic><characteristic name="WS">3+</characteristic><characteristic name="S">5</characteristic><characteristic name="AP">-1</characteristic><characteristic name="D">1</characteristic><characteristic name="Keywords">-</characteristic>
        </characteristics></profile></profiles></selection>
      </selections>
      <costs><cost name="pts" value="${unit.points}" /></costs>
      <categories><category name="Infantry" /></categories>
    </selection>`).join("");
  const xml = `<?xml version="1.0"?>
<roster name="${escapeXml(roster.name)}" generatedBy="https://newrecruit.eu" gameSystemId="${escapeXml(newRecruitCatalogue.gameSystem.id)}" gameSystemName="${escapeXml(newRecruitCatalogue.gameSystem.name)}" gameSystemRevision="${roster.sourceData.newRecruit.gameSystemRevision}">
  <costs><cost name="pts" value="${roster.totalPoints}" /></costs>
  <forces><force name="${escapeXml(roster.factionName)}" catalogueName="${escapeXml(faction.catalogue.name)}" catalogueId="${escapeXml(faction.catalogue.id)}" catalogueRevision="${roster.sourceData.newRecruit.catalogueRevision ?? 0}"><selections>${selections}</selections></force></forces>
</roster>`;
  return zipSync({ "fixture.ros": strToU8(xml) });
}

function localDelivery(root: string) {
  return async (
    roster: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    const outputDirectory = options.outputDirectory ?? root;
    await mkdir(outputDirectory, { recursive: true });
    const content = localEngineFixture(roster);
    const sourcePath = path.join(outputDirectory, "source.rosz");
    const enrichedPath = path.join(outputDirectory, "enriched.rosz");
    await Promise.all([
      writeFile(sourcePath, content),
      writeFile(enrichedPath, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: roster.id,
        rosterName: roster.name,
        listUrl: "https://www.newrecruit.eu/app/Lists/local-stress-fixture",
        imported: true,
        sessionReused: true,
        verification: {
          name: true,
          faction: true,
          points: true,
          units: roster.units.map((unit) => ({
            name: unit.name,
            modelCount: unit.modelCount,
            matched: true,
          })),
          mismatches: [],
        },
        enrichedSummary: inspectEnrichedRosz(content),
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: sourcePath,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enrichedPath,
          },
        ],
      },
      violations: [],
      warnings: [],
    };
  };
}

test("local-engine stress runs retain deterministic evidence and suppress candidate coaching", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-local-engine-stress-"),
  );
  try {
    const playerResult = buildRoster({
      faction: "adeptus-custodes",
      pointsLimit: 250,
      name: "Local stress player",
    });
    assert.ok(playerResult.ok && playerResult.data);
    const player = playerResult.data;
    const portfolio = generateFactionStressPortfolio({
      faction: "aeldari",
      pointsLimit: player.pointsLimit,
      suite: "core-3",
    });
    assert.ok(portfolio.ok && portfolio.data);
    const requirements = aggregateProfileRequirements([
      player,
      ...portfolio.data.items.flatMap((item) =>
        item.roster ? [item.roster] : [],
      ),
    ]);
    const policyPath = path.join(directory, "profile-policy.json");
    await writeFile(
      policyPath,
      `${JSON.stringify({
        schemaVersion: 1,
        policyKind: "tessera-profile-policy",
        entries: requirements.map((requirement) => ({
          faction: requirement.faction,
          unit: requirement.unit,
          selectionId: requirement.selectionId,
          unitOccurrence: requirement.unitOccurrence,
          modelCount: requirement.modelCount,
          weaponGroup: requirement.weaponGroup,
          phase: requirement.phase,
          selectedProfile: requirement.availableProfiles[0],
          activeCount: requirement.activeCount,
        })),
      }, null, 2)}\n`,
    );
    let websiteCalls = 0;
    const result = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "full-all",
        simulationBackend: "local-engine",
        executionMode: "simulate",
        profilePolicyPath: policyPath,
        outputDirectory: "stress",
        rootDir: directory,
      },
      {
        deliver: localDelivery(directory),
        runBrowser: async () => {
          websiteCalls += 1;
          throw new Error("website provider must not run");
        },
      },
    );

    assert.equal(
      result.ok,
      true,
      result.violations.map((issue) => issue.message).join("\n"),
    );
    assert.ok(result.data);
    assert.equal(websiteCalls, 0);
    assert.equal(result.data.source, "tessera-local-engine");
    assert.equal(result.data.simulation?.selectedBackend, "local-engine");
    assert.equal(
      result.data.simulation?.providerIdentity?.provider,
      "local-engine",
    );
    assert.equal(result.data.findings.length, 0);
    assert.equal(result.data.changeCandidates.length, 0);
    assert.ok(
      result.data.warnings.some((warning) =>
        /evidence was retained for evaluation/i.test(warning),
      ),
    );
    const scenarios = result.data.screeningReport?.simulation.scenarios ?? [];
    assert.ok(scenarios.length > 0);
    assert.ok(
      scenarios.every((scenario) =>
        (scenario.metricRuns ?? []).every(
          (metricRun) =>
            metricRun.seed !== undefined &&
            metricRun.executionSha256 !== undefined &&
            metricRun.projectionSha256 !== undefined &&
            metricRun.matrixSha256 !== undefined,
        ),
      ),
    );

    const manifestArtifact = result.data.artifacts.find(
      (artifact) => artifact.format === "stress-manifest",
    );
    assert.ok(manifestArtifact);
    const manifestPath = path.resolve(
      directory,
      "stress",
      manifestArtifact.written,
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    assert.equal(manifest.schemaVersion, 5);
    assert.equal(manifest.simulationBackend, "local-engine");
    assert.equal(manifest.selectedSimulationBackend, "local-engine");

    manifest.finalArtifacts = null;
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const resumed = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        resumeManifestPath: manifestPath,
        rootDir: directory,
        overwrite: true,
      },
      {
        deliver: localDelivery(directory),
        runBrowser: async () => {
          websiteCalls += 1;
          throw new Error("website provider must not run");
        },
      },
    );
    assert.equal(
      resumed.ok,
      true,
      resumed.violations.map((issue) => issue.message).join("\n"),
    );
    assert.equal(resumed.data?.source, "tessera-local-engine");
    assert.equal(
      resumed.data?.simulation?.selectedBackend,
      "local-engine",
    );
    assert.equal(resumed.data?.findings.length, 0);
    assert.equal(resumed.data?.changeCandidates.length, 0);
    assert.equal(websiteCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
