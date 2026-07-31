import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  applyOfficialRulesOverlay,
  createOfficialExtractionReceiptDraft,
  verifyOfficialPublicationEvidence,
} from "../lib/rosterpilot/official-data";
import type {
  OfficialExtractionReceiptDraftV1,
  OfficialRulesOverlayV1,
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

async function overlayFor(
  unit: {
    id: string;
    faction_id: string;
    points: Array<{
      models: number;
      cost: number;
      unit_count_min: number;
      unit_count_max: number | null;
    }>;
  },
): Promise<OfficialRulesOverlayV1> {
  const unitPoints = [
    {
      factionId: unit.faction_id,
      unitId: unit.id,
      tiers: unit.points.map((tier, index) => ({
        ...tier,
        cost: tier.cost + (index === 0 ? 5 : 0),
      })),
    },
  ];
  const emptyHash = await semanticHash([]);
  return {
    schemaVersion: 1 as const,
    authority: "games-workshop" as const,
    source: {
      version: "3.2",
      contentSha256: "a".repeat(64),
      url: "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
      extractedAt: "2026-07-30T00:00:00.000Z",
      extractor: "rosterpilot-official-fixture",
      extractorVersion: "1",
    },
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
    },
    unitPoints,
    leaderLinks: [],
    detachments: [],
    enhancementPoints: [],
  };
}

function base64Url(value: ArrayBuffer): string {
  return Buffer.from(value).toString("base64url");
}

async function extractorFixture() {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey(
    "jwk",
    keys.publicKey,
  );
  return {
    keys,
    registry: {
      schemaVersion: 1 as const,
      extractors: [
        {
          extractorId: "rosterpilot-official-fixture",
          keyId: "official-fixture-1",
          publicKey,
          status: "trusted" as const,
          reviewedAt: "2026-07-30T00:00:00.000Z",
          reviewReference: "fixture-review",
        },
      ],
    },
  };
}

async function signedReceipt(
  draft: OfficialExtractionReceiptDraftV1,
  privateKey: CryptoKey,
) {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(canonicalJson(draft)),
  );
  return {
    ...structuredClone(draft),
    signature: {
      algorithm: "Ed25519" as const,
      keyId: "official-fixture-1",
      value: base64Url(signature),
    },
  };
}

test("machine-verified official values override community points with explicit conflict evidence", async () => {
  const rules = serializeRuntimeRulesData();
  const unit = rules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
        "adeptus-custodes" &&
      ((entry as { points?: unknown[] }).points?.length ?? 0) > 0,
  ) as Parameters<typeof overlayFor>[0] | undefined;
  assert.ok(unit);
  const overlay = await overlayFor(unit);
  const result = await applyOfficialRulesOverlay(rules, overlay);
  const updated = result.rulesData.units.find(
    (entry) => (entry as { id?: string }).id === unit.id,
  ) as typeof unit | undefined;

  assert.equal(
    updated?.points[0].cost,
    overlay.unitPoints[0].tiers[0].cost,
  );
  assert.deepEqual(result.affectedFactions, [
    "adeptus-custodes",
  ]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].resolution, "official-override");
  assert.match(result.overlayHash, /^[a-f0-9]{64}$/);
});

test("official leader, detachment, disposition, and enhancement values override independently", async () => {
  const rules = serializeRuntimeRulesData();
  const unit = rules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
        "adeptus-custodes" &&
      ((entry as { points?: unknown[] }).points?.length ?? 0) >
        0 &&
      (
        (entry as {
          points?: Array<{
            unit_count_min?: number;
            unit_count_max?: number | null;
          }>;
        }).points ?? []
      ).every(
        (tier) =>
          tier.unit_count_min !== undefined &&
          tier.unit_count_max !== undefined,
      ),
  ) as Parameters<typeof overlayFor>[0] | undefined;
  assert.ok(unit);
  const overlay = await overlayFor(unit);
  overlay.leaderLinks = [
    {
      factionId: "adeptus-custodes",
      leaderId: "aleya",
      eligibleBodyguardIds: ["prosecutors", "vigilators"],
      eligibleBodyguardKeywords: [],
    },
  ];
  overlay.detachments = [
    {
      factionId: "adeptus-custodes",
      detachmentId: "lions-of-the-emperor",
      detachmentPoints: 3,
      forceDispositionIds: ["take-and-hold"],
    },
  ];
  overlay.enhancementPoints = [
    {
      factionId: "adeptus-custodes",
      enhancementId:
        "superior-creation-lions-of-the-emperor",
      cost: 30,
    },
  ];
  for (const scope of [
    "leaderLinks",
    "detachments",
    "enhancementPoints",
  ] as const) {
    const payload = overlay[scope];
    overlay.coverage[scope] = {
      status: "complete",
      sourceEntityCount: payload.length,
      extractedEntityCount: payload.length,
      payloadSha256: await semanticHash(payload),
    };
  }

  const result = await applyOfficialRulesOverlay(rules, overlay);
  const attachment = result.rulesData.leaderAttachments.find(
    (entry) =>
      (entry as { leader_id?: string }).leader_id === "aleya",
  ) as
    | { eligible_bodyguard_ids?: string[] }
    | undefined;
  const detachment = result.rulesData.detachments.find(
    (entry) =>
      (entry as { id?: string }).id ===
      "lions-of-the-emperor",
  ) as
    | {
        detachment_points?: number;
        force_dispositions?: string[];
      }
    | undefined;
  const enhancement = result.rulesData.enhancements.find(
    (entry) =>
      (entry as { id?: string }).id ===
      "superior-creation-lions-of-the-emperor",
  ) as { cost?: number } | undefined;

  assert.deepEqual(attachment?.eligible_bodyguard_ids, [
    "prosecutors",
    "vigilators",
  ]);
  assert.equal(detachment?.detachment_points, 3);
  assert.deepEqual(detachment?.force_dispositions, [
    "take-and-hold",
  ]);
  assert.equal(enhancement?.cost, 30);
  assert.deepEqual(
    new Set(result.conflicts.map((entry) => entry.scope)),
    new Set([
      "unit-points",
      "leader-links",
      "detachment",
      "enhancement-points",
    ]),
  );
});

test("an official overlay fails closed when it references an unknown entity", async () => {
  const rules = serializeRuntimeRulesData();
  const unit = rules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
        "adeptus-custodes" &&
      ((entry as { points?: unknown[] }).points?.length ?? 0) > 0,
  ) as Parameters<typeof overlayFor>[0] | undefined;
  assert.ok(unit);
  const overlay = await overlayFor(unit);
  overlay.unitPoints[0].unitId = "not-a-real-unit";
  overlay.coverage.unitPoints.payloadSha256 = await semanticHash(
    overlay.unitPoints,
  );

  await assert.rejects(
    applyOfficialRulesOverlay(rules, overlay),
    /unknown adeptus-custodes:not-a-real-unit/,
  );

  const invalidRelation = await overlayFor(unit);
  invalidRelation.leaderLinks = [
    {
      factionId: "adeptus-custodes",
      leaderId: "aleya",
      eligibleBodyguardIds: ["not-a-real-bodyguard"],
      eligibleBodyguardKeywords: [],
    },
  ];
  invalidRelation.coverage.leaderLinks = {
    status: "complete",
    sourceEntityCount: 1,
    extractedEntityCount: 1,
    payloadSha256: await semanticHash(
      invalidRelation.leaderLinks,
    ),
  };
  await assert.rejects(
    applyOfficialRulesOverlay(rules, invalidRelation),
    /unknown bodyguard unit not-a-real-bodyguard/,
  );
});

test("official overlays reject incomplete or self-inconsistent extraction evidence", async () => {
  const rules = serializeRuntimeRulesData();
  const unit = rules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
        "adeptus-custodes" &&
      ((entry as { points?: unknown[] }).points?.length ?? 0) > 0,
  ) as Parameters<typeof overlayFor>[0] | undefined;
  assert.ok(unit);
  const overlay = await overlayFor(unit);
  overlay.coverage.unitPoints.sourceEntityCount += 1;
  await assert.rejects(
    applyOfficialRulesOverlay(rules, overlay),
    /not complete/,
  );

  const empty = await overlayFor(unit);
  empty.unitPoints = [];
  empty.coverage.unitPoints = {
    status: "not-published",
    sourceEntityCount: 0,
    extractedEntityCount: 0,
    payloadSha256: await semanticHash([]),
  };
  await assert.rejects(
    applyOfficialRulesOverlay(rules, empty),
    /complete, non-empty unit-points extraction/,
  );
});

test("official overlay tooling creates source-bound evidence that remains fail-closed until populated", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-official-overlay-"),
  );
  const filename = path.join(directory, "official-overlay.json");
  try {
    let output = "";
    await runOfficialDataOverlayCli(
      ["template", "--out", filename],
      {
        root: process.cwd(),
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    const report = JSON.parse(output) as {
      ok: boolean;
      publishable: boolean;
    };
    assert.equal(report.ok, true);
    assert.equal(report.publishable, false);
    const overlay = JSON.parse(await readFile(filename, "utf8")) as {
      authority: string;
      source: { contentSha256: string };
      coverage: { unitPoints: { status: string } };
    };
    assert.equal(overlay.authority, "games-workshop");
    assert.match(overlay.source.contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      overlay.coverage.unitPoints.status,
      "not-published",
    );
    await assert.rejects(
      runOfficialDataOverlayCli(
        ["check", "--file", filename],
        { root: process.cwd() },
      ),
      /source-artifact.*receipt.*self-declared/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reviewed extractor evidence binds source bytes, exact overlay, signature, and one-to-one inventory", async () => {
  const rules = serializeRuntimeRulesData();
  const unit = rules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
        "adeptus-custodes" &&
      ((entry as { points?: unknown[] }).points?.length ?? 0) > 0,
  ) as Parameters<typeof overlayFor>[0] | undefined;
  assert.ok(unit);
  const sourceArtifact = new TextEncoder().encode(
    "official-source-fixture",
  );
  const overlay = await overlayFor(unit);
  overlay.source.contentSha256 = await sha256Hex(sourceArtifact);
  const { keys, registry } = await extractorFixture();
  const draft = await createOfficialExtractionReceiptDraft(
    overlay,
    sourceArtifact,
    "2026-07-30T01:00:00.000Z",
  );
  const receipt = await signedReceipt(draft, keys.privateKey);

  const valid = await verifyOfficialPublicationEvidence({
    overlay,
    sourceArtifact,
    extractionReceipt: receipt,
    trustedExtractors: registry,
  });
  assert.equal(valid.extractorId, overlay.source.extractor);
  assert.equal(valid.sourceArtifactSha256, overlay.source.contentSha256);

  await assert.rejects(
    verifyOfficialPublicationEvidence({
      overlay,
      sourceArtifact: new TextEncoder().encode("tampered-source"),
      extractionReceipt: receipt,
      trustedExtractors: registry,
    }),
    /exact source artifact bytes/,
  );

  const tamperedReceipt = structuredClone(receipt);
  tamperedReceipt.issuedAt = "2026-07-30T02:00:00.000Z";
  await assert.rejects(
    verifyOfficialPublicationEvidence({
      overlay,
      sourceArtifact,
      extractionReceipt: tamperedReceipt,
      trustedExtractors: registry,
    }),
    /signature is invalid|tampered/i,
  );

  const incompleteDraft = structuredClone(draft);
  incompleteDraft.coverage.unitPoints!.sourceEntityKeys = [];
  const incompleteReceipt = await signedReceipt(
    incompleteDraft,
    keys.privateKey,
  );
  await assert.rejects(
    verifyOfficialPublicationEvidence({
      overlay,
      sourceArtifact,
      extractionReceipt: incompleteReceipt,
      trustedExtractors: registry,
    }),
    /one-to-one source inventory/,
  );

  await assert.rejects(
    verifyOfficialPublicationEvidence({
      overlay,
      sourceArtifact,
      extractionReceipt: receipt,
      trustedExtractors: {
        schemaVersion: 1,
        extractors: [],
      },
    }),
    /No reviewed official extractor key/,
  );
});

test("official overlay CLI verifies the external source and signed receipt before publication", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-official-evidence-"),
  );
  try {
    const rules = serializeRuntimeRulesData();
    const unit = rules.units.find(
      (entry) =>
        (entry as { faction_id?: string }).faction_id ===
          "adeptus-custodes" &&
        ((entry as { points?: unknown[] }).points?.length ?? 0) > 0,
    ) as Parameters<typeof overlayFor>[0] | undefined;
    assert.ok(unit);
    const sourceArtifact = new TextEncoder().encode(
      "official-cli-source-fixture",
    );
    const overlay = await overlayFor(unit);
    overlay.source.contentSha256 = await sha256Hex(sourceArtifact);
    const { keys, registry } = await extractorFixture();
    const receipt = await signedReceipt(
      await createOfficialExtractionReceiptDraft(
        overlay,
        sourceArtifact,
        "2026-07-30T01:00:00.000Z",
      ),
      keys.privateKey,
    );
    const overlayFile = path.join(directory, "overlay.json");
    const sourceFile = path.join(directory, "source.bin");
    const receiptFile = path.join(directory, "receipt.json");
    const registryFile = path.join(directory, "extractors.json");
    await Promise.all([
      writeFile(overlayFile, JSON.stringify(overlay)),
      writeFile(sourceFile, sourceArtifact),
      writeFile(receiptFile, JSON.stringify(receipt)),
      writeFile(registryFile, JSON.stringify(registry)),
    ]);
    let output = "";
    await runOfficialDataOverlayCli(
      [
        "check",
        "--file",
        overlayFile,
        "--source-artifact",
        sourceFile,
        "--receipt",
        receiptFile,
        "--trusted-extractors",
        registryFile,
      ],
      {
        root: process.cwd(),
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    const report = JSON.parse(output) as {
      publishable: boolean;
      extractorKeyId: string;
    };
    assert.equal(report.publishable, true);
    assert.equal(report.extractorKeyId, "official-fixture-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
