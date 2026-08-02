import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOfficialExtractionReceiptDraftV2,
  verifyOfficialRulesOverlayV2Coverage,
} from "../lib/rosterpilot/official-data";
import {
  serializeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
} from "../lib/rosterpilot/semantic-hash";
import {
  runOfficialDataOverlayCli,
} from "../scripts/official-data-overlay";
import {
  officialLegendArtifactInputTsv,
  parseOfficialLegendArtifactInput,
} from "../scripts/parse-official-legend-artifacts";

type RawUnit = {
  id: string;
  faction_id: string;
  points: Array<{
    models: number;
    cost: number;
    unit_count_min: number;
    unit_count_max: number | null;
  }>;
};

function base64Url(value: ArrayBuffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

test("supported release workflows forward schema-v2 Legends artifacts through verification and publication", async () => {
  for (const relativePath of [
    ".github/workflows/application-release.yml",
    ".github/workflows/data-freshness.yml",
    ".github/workflows/certification-review-package.yml",
  ]) {
    const workflow = await readFile(
      path.resolve(relativePath),
      "utf8",
    );
    assert.match(workflow, /official_legend_source_artifacts:/);
    assert.match(workflow, /OFFICIAL_LEGEND_SOURCES_INPUT:/);
    assert.match(
      workflow,
      /scripts\/parse-official-legend-artifacts\.ts/,
    );
    assert.match(workflow, /--legend-source-artifact/);
    assert.match(workflow, /--official-legend-source-artifact/);
  }
});

test("workflow Legends artifact input preserves keyed paths and rejects ambiguous inventories", () => {
  const raw = JSON.stringify([
    "__proto__=https://assets.example/aeldari.pdf?signature=a=b",
    "custodes-pack=data/evidence/custodes pack.pdf",
  ]);
  assert.deepEqual(parseOfficialLegendArtifactInput(raw), [
    {
      sourceId: "__proto__",
      artifactInput:
        "https://assets.example/aeldari.pdf?signature=a=b",
    },
    {
      sourceId: "custodes-pack",
      artifactInput: "data/evidence/custodes pack.pdf",
    },
  ]);
  assert.equal(
    officialLegendArtifactInputTsv(raw),
    "__proto__\thttps://assets.example/aeldari.pdf?signature=a=b\n" +
      "custodes-pack\tdata/evidence/custodes pack.pdf\n",
  );
  assert.deepEqual(parseOfficialLegendArtifactInput(""), []);
  assert.throws(
    () =>
      parseOfficialLegendArtifactInput(
        JSON.stringify(["a=/first.pdf", "a=/second.pdf"]),
      ),
    /source id a is repeated/,
  );
  assert.throws(
    () => parseOfficialLegendArtifactInput("{}"),
    /must be a JSON array/,
  );
  assert.throws(
    () => parseOfficialLegendArtifactInput("not-json"),
    /valid JSON array/,
  );
});

test("official overlay CLI verifies every schema-v2 Legends source artifact", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-legends-release-evidence-"),
  );
  try {
    const unit = serializeRuntimeRulesData().units.find(
      (entry) =>
        (entry as RawUnit).faction_id === "aeldari" &&
        ((entry as RawUnit).points?.length ?? 0) > 0 &&
        (entry as RawUnit).points.every(
          (tier) =>
            typeof tier.unit_count_min === "number" &&
            (typeof tier.unit_count_max === "number" ||
              tier.unit_count_max === null),
        ),
    ) as RawUnit | undefined;
    assert.ok(unit);

    const primaryArtifact = new TextEncoder().encode(
      "legends-release-primary-source",
    );
    const factionPack = new TextEncoder().encode(
      "legends-release-aeldari-faction-pack",
    );
    const legendSourceId = "__proto__";
    const unitPoints = [
      {
        factionId: unit.faction_id,
        unitId: unit.id,
        tiers: structuredClone(unit.points),
      },
    ];
    const legendFactionCoverage = [
      {
        factionId: unit.faction_id,
        sourceIds: [legendSourceId],
        status: "complete" as const,
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: await semanticHash([]),
      },
    ];
    const emptyHash = await semanticHash([]);
    const overlay = await verifyOfficialRulesOverlayV2Coverage({
      schemaVersion: 2,
      authority: "games-workshop",
      gameEdition: "11th",
      source: {
        version: "release-plumbing-mfm",
        contentSha256: await sha256Hex(primaryArtifact),
        url: "https://assets.warhammer-community.com/mfm-fixture.pdf",
        extractedAt: "2026-08-01T00:00:00.000Z",
        extractor: "release-plumbing-extractor",
        extractorVersion: "2",
      },
      legendSources: [
        {
          sourceId: legendSourceId,
          factionId: unit.faction_id,
          factionName: "Aeldari",
          documentKind: "faction-pack",
          gameEdition: "11th",
          version: "2026-08-01",
          legalFrom: "2026-06-20",
          contentSha256: await sha256Hex(factionPack),
          url: "https://assets.warhammer-community.com/aeldari-fixture.pdf",
          extractedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      coverage: {
        unitPoints: {
          status: "complete",
          sourceEntityCount: unitPoints.length,
          extractedEntityCount: unitPoints.length,
          payloadSha256: await semanticHash(unitPoints),
        },
        leaderLinks: {
          status: "not-published",
          sourceEntityCount: 0,
          extractedEntityCount: 0,
          payloadSha256: emptyHash,
        },
        detachments: {
          status: "not-published",
          sourceEntityCount: 0,
          extractedEntityCount: 0,
          payloadSha256: emptyHash,
        },
        enhancementPoints: {
          status: "not-published",
          sourceEntityCount: 0,
          extractedEntityCount: 0,
          payloadSha256: emptyHash,
        },
        legendUnits: {
          status: "complete",
          sourceEntityCount: 0,
          extractedEntityCount: 0,
          payloadSha256: emptyHash,
        },
        legendFactionCoverage: {
          status: "complete",
          sourceEntityCount: legendFactionCoverage.length,
          extractedEntityCount: legendFactionCoverage.length,
          payloadSha256: await semanticHash(
            legendFactionCoverage,
          ),
        },
      },
      unitPoints,
      leaderLinks: [],
      detachments: [],
      enhancementPoints: [],
      legendFactionCoverage,
      legendUnits: [],
    });

    const keys = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    );
    const receiptDraft = await createOfficialExtractionReceiptDraftV2(
      overlay,
      primaryArtifact,
      Object.fromEntries([[legendSourceId, factionPack]]),
      "2026-08-01T01:00:00.000Z",
    );
    const receiptSignature = await crypto.subtle.sign(
      { name: "Ed25519" },
      keys.privateKey,
      new TextEncoder().encode(canonicalJson(receiptDraft)),
    );
    const receipt = {
      ...receiptDraft,
      signature: {
        algorithm: "Ed25519" as const,
        keyId: "release-plumbing-key",
        value: base64Url(receiptSignature),
      },
    };
    const trustedExtractors = {
      schemaVersion: 1,
      extractors: [
        {
          extractorId: overlay.source.extractor,
          keyId: "release-plumbing-key",
          publicKey: await crypto.subtle.exportKey(
            "jwk",
            keys.publicKey,
          ),
          status: "trusted",
          reviewedAt: "2026-08-01T00:00:00.000Z",
          reviewReference: "release-plumbing-test-review",
        },
      ],
    };

    const overlayFile = path.join(directory, "overlay.json");
    const primaryFile = path.join(directory, "mfm.pdf");
    const factionPackFile = path.join(directory, "aeldari.pdf");
    const receiptFile = path.join(directory, "receipt.json");
    const trustFile = path.join(directory, "trusted-extractors.json");
    await Promise.all([
      writeFile(overlayFile, JSON.stringify(overlay)),
      writeFile(primaryFile, primaryArtifact),
      writeFile(factionPackFile, factionPack),
      writeFile(receiptFile, JSON.stringify(receipt)),
      writeFile(trustFile, JSON.stringify(trustedExtractors)),
    ]);

    let output = "";
    await runOfficialDataOverlayCli(
      [
        "check",
        "--file",
        overlayFile,
        "--source-artifact",
        primaryFile,
        "--legend-source-artifact",
        `${legendSourceId}=${factionPackFile}`,
        "--receipt",
        receiptFile,
        "--trusted-extractors",
        trustFile,
      ],
      {
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    const report = JSON.parse(output) as {
      publishable: boolean;
      affectedFactions: string[];
      legendSourceArtifactSha256: Record<string, string>;
    };
    assert.equal(report.publishable, true);
    assert.deepEqual(report.affectedFactions, [unit.faction_id]);
    assert.equal(
      report.legendSourceArtifactSha256[legendSourceId],
      await sha256Hex(factionPack),
    );

    await assert.rejects(
      runOfficialDataOverlayCli([
        "check",
        "--file",
        overlayFile,
        "--source-artifact",
        primaryFile,
        "--receipt",
        receiptFile,
        "--trusted-extractors",
        trustFile,
      ]),
      /exact faction-pack artifact inventory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
