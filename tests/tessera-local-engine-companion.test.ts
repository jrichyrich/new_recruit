import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  buildRoster,
  getNewRecruitFactionSummary,
  inspectEnrichedRosz,
  newRecruitCatalogue,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import { analyzeRosterMatchup } from "../local/tessera/companion";

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
  const selections = roster.units
    .map(
      (unit) => `<selection id="${escapeXml(unit.selectionId)}" name="${escapeXml(unit.name)}" number="1" type="unit">
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
      </selection>`,
    )
    .join("");
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
        listUrl: "https://www.newrecruit.eu/app/Lists/local-engine-fixture",
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

test("exact companion routes an explicit local-engine run without invoking the website", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-local-engine-companion-"),
  );
  try {
    const player = buildRoster({
      faction: "adeptus-custodes",
      pointsLimit: 250,
      name: "Local engine player",
    });
    const opponent = buildRoster({
      faction: "necrons",
      pointsLimit: 250,
      name: "Local engine opponent",
    });
    assert.ok(player.ok && player.data);
    assert.ok(opponent.ok && opponent.data);
    let websiteCalls = 0;
    const result = await analyzeRosterMatchup(
      player.data,
      { kind: "roster", roster: opponent.data },
      {
        simulationBackend: "local-engine",
        executionMode: "simulate",
        analysisMode: "quick",
        phases: ["shooting"],
        metrics: ["mean-damage"],
        outputDirectory: path.join(directory, "report"),
        allowOutsideRoot: true,
      },
      {
        deliver: localDelivery(directory),
        runBrowser: async () => {
          websiteCalls += 1;
          throw new Error("website provider must not run");
        },
      },
    );

    assert.equal(result.ok, true, result.violations.map((issue) => issue.message).join("\n"));
    assert.ok(result.data);
    assert.equal(websiteCalls, 0);
    assert.equal(result.data.source, "tessera-local-engine");
    assert.equal(result.data.status, "complete");
    assert.equal(result.data.simulation.status, "complete");
    assert.equal(result.data.simulation.requestedBackend, "local-engine");
    assert.equal(result.data.simulation.selectedBackend, "local-engine");
    assert.equal(result.data.simulation.providerIdentity?.provider, "local-engine");
    assert.equal(result.data.simulation.scenarios?.length, 2);
    assert.equal(result.data.findings?.length, 0);
    assert.equal(result.data.changeCandidates?.length, 0);
    assert.ok(
      result.data.warnings.some((warning) =>
        /written-license and parity promotion gates/i.test(warning),
      ),
    );
    assert.ok(
      result.data.connectorEvents?.some(
        (event) =>
          event.provider === "tessera" &&
          event.simulationBackend === "local-engine" &&
          event.origin === "in-memory",
      ) === true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
