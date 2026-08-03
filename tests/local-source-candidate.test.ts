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

import type {
  DataBundleManifestDraftV1,
  DataBundleShardV1,
} from "../lib/rosterpilot/data-bundle";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
} from "../lib/rosterpilot/semantic-hash";
import type {
  RuntimeDataBundleBuild,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  publishLocalSourceCandidate,
  verifyLocalSourceCandidate,
  writeLocalSourceBundleArtifacts,
  type LocalSourceObservationV1,
} from "../local/data-bundles/local-source-candidate";

const digest = (character: string) => character.repeat(64);
const NPM_INTEGRITY = `sha512-${"A".repeat(86)}==`;

async function fixtureBuild(): Promise<RuntimeDataBundleBuild> {
  const createdAt = "2026-08-02T12:00:00.000Z";
  const globalShard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "global",
    kind: "global",
    factionIds: [],
    data: { payloadKind: "test-global", sequence: 1 },
  };
  const factionShard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "faction:aeldari",
    kind: "faction",
    factionIds: ["aeldari"],
    data: { payloadKind: "test-faction", factionId: "aeldari" },
  };
  const descriptor = async (
    shard: DataBundleShardV1,
    relativePath: string,
  ): Promise<DataBundleManifestDraftV1["shards"][number]> => ({
    shardId: shard.shardId,
    kind: shard.kind,
    factionIds: shard.factionIds,
    dependencyShardIds: shard.kind === "global" ? [] : ["global"],
    path: relativePath,
    contentSha256: await sha256Hex(canonicalJson(shard)),
    semanticHash: await semanticHash(shard.data),
    byteLength: new TextEncoder().encode(canonicalJson(shard)).byteLength,
    mediaType: "application/vnd.rosterpilot.data-shard+json",
  });
  return {
    draft: {
      schemaVersion: 1,
      engineDataSchemaVersion: 2,
      createdAt,
      provenance: {
        official: {
          authority: "games-workshop",
          version: "1.1",
          contentSha256: digest("1"),
          downloadsUrl:
            "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
          dataUrl: "https://mfm.warhammer-community.com/en",
          checkedAt: createdAt,
        },
        rules: {
          provider: "40kdc-data",
          package: "@alpaca-software/40kdc-data",
          version: "1.2.1",
          sourceSha256: digest("2"),
          edition: "11th",
          dataslate: "launch",
        },
        newRecruit: {
          provider: "bsdata",
          repository: "BSData/wh40k-11e",
          branch: "main",
          commit: "21b4efa69d7212cb206fdcbf98aa606ee49f78a2",
        },
      },
      semanticHashes: {
        globalHash: digest("3"),
        methodologyHash: digest("4"),
        factions: {
          aeldari: {
            factionRulesHash: digest("5"),
            mappingHash: digest("6"),
            portfolioHash: digest("7"),
            conflictHash: digest("8"),
            entityHashes: { "unit:guardian-defenders": digest("9") },
          },
        },
      },
      shards: [
        await descriptor(globalShard, "shards/global.json"),
        await descriptor(factionShard, "shards/aeldari.json"),
      ],
    },
    shards: [globalShard, factionShard] as RuntimeDataBundleBuild["shards"],
    officialReconciliation: null,
  };
}

function observation(): LocalSourceObservationV1 {
  return {
    checkedAt: "2026-08-02T12:00:00.000Z",
    rules: {
      package: "@alpaca-software/40kdc-data",
      version: "1.2.1",
      registryUrl:
        "https://registry.npmjs.org/@alpaca-software%2F40kdc-data/latest",
      distIntegrity: NPM_INTEGRITY,
      tarballUrl:
        "https://registry.npmjs.org/@alpaca-software/40kdc-data/-/40kdc-data-1.2.1.tgz",
    },
    newRecruit: {
      repository: "BSData/wh40k-11e",
      url: "https://github.com/BSData/wh40k-11e.git",
      branch: "main",
      commit: "21b4efa69d7212cb206fdcbf98aa606ee49f78a2",
      latestCommit: "21b4efa69d7212cb206fdcbf98aa606ee49f78a2",
    },
    official: {
      downloadsUrl:
        "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
      mfmUrl: "https://mfm.warhammer-community.com/en",
      observedVersion: "1.1",
      observedContentSha256: digest("1"),
      retainedVersion: "1.1",
      retainedContentSha256: digest("1"),
      disposition: "current",
    },
  };
}

async function publishedFixture(root: string) {
  const artifacts = path.join(root, "artifacts");
  const candidates = path.join(root, "candidates");
  const evidence = path.join(root, "data-check.log");
  await writeFile(evidence, "deterministic validation passed\n");
  await writeFile(path.join(root, "builder-source.ts"), "export const ok = true;\n");
  await writeLocalSourceBundleArtifacts(await fixtureBuild(), artifacts);
  return publishLocalSourceCandidate({
    artifactsDirectory: artifacts,
    destinationRoot: candidates,
    sources: observation(),
    builderRoot: root,
    builderFiles: ["builder-source.ts"],
    validation: {
      classification: "bootstrap",
      affectedFactions: ["aeldari"],
      plan: {
        runDataCheck: true,
        syncCertificationManifest: true,
        certificationFactions: [],
        fullCertification: true,
        includePortfolio: true,
      },
      evidenceFiles: [{ stage: "certification", filename: evidence }],
    },
    now: () => new Date("2026-08-02T12:30:00.000Z"),
  });
}

test("local-source candidate receipt rebinds manifest, shards, sources, builder, and validation evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-candidate-"));
  try {
    const reference = await publishedFixture(root);
    const verified = await verifyLocalSourceCandidate(reference.directory, {
      expectedBuilderRoot: root,
    });
    assert.equal(verified.reference.bundleId, reference.bundleId);
    assert.equal(
      verified.receipt.acceptance.certificationStatus,
      "passed",
    );
    assert.equal(
      verified.buildEvidence.validation.classification,
      "bootstrap",
    );
    assert.equal(
      verified.buildEvidence.sources.newRecruit.commit,
      observation().newRecruit.commit,
    );
    assert.equal(verified.shards.size, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-source candidate verification rejects changed shards and evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-tamper-"));
  try {
    const reference = await publishedFixture(root);
    const shardPath = path.join(reference.directory, "shards", "aeldari.json");
    const originalShard = await readFile(shardPath, "utf8");
    const shard = JSON.parse(originalShard) as { data: { factionId: string } };
    shard.data.factionId = "changed";
    await writeFile(shardPath, JSON.stringify(shard));
    await assert.rejects(
      verifyLocalSourceCandidate(reference.directory),
      /failed content, semantic, or length verification/,
    );

    await writeFile(shardPath, originalShard);
    const verified = await verifyLocalSourceCandidate(reference.directory);
    const evidencePath = path.join(
      reference.directory,
      verified.buildEvidence.validation.evidence[0].path,
    );
    await writeFile(evidencePath, "changed evidence\n");
    await assert.rejects(
      verifyLocalSourceCandidate(reference.directory),
      /validation evidence .* failed verification/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-source candidate verification detects receipt and expected-builder drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-builder-"));
  try {
    const reference = await publishedFixture(root);
    await writeFile(path.join(root, "builder-source.ts"), "export const ok = false;\n");
    await assert.rejects(
      verifyLocalSourceCandidate(reference.directory, {
        expectedBuilderRoot: root,
      }),
      /different source code/,
    );

    const receipt = JSON.parse(
      await readFile(reference.receiptPath, "utf8"),
    ) as { source: { provenance: { rules: { version: string } } } };
    receipt.source.provenance.rules.version = "9.9.9";
    await writeFile(reference.receiptPath, JSON.stringify(receipt));
    await assert.rejects(
      verifyLocalSourceCandidate(reference.directory),
      /receipt failed verification: .*integrity digest/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-source candidate cross-binds detailed source and validation evidence to the store receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-source-cross-binding-"));
  try {
    const reference = await publishedFixture(root);
    const evidencePath = path.join(
      reference.directory,
      "local-build-evidence.json",
    );
    const evidence = JSON.parse(
      await readFile(evidencePath, "utf8"),
    ) as {
      integritySha256: string;
      sources: { rules: { distIntegrity: string } };
      [key: string]: unknown;
    };
    evidence.sources.rules.distIntegrity =
      `sha512-${"B".repeat(86)}==`;
    const { integritySha256: _oldIntegrity, ...draft } = evidence;
    void _oldIntegrity;
    evidence.integritySha256 = await sha256Hex(canonicalJson(draft));
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await assert.rejects(
      verifyLocalSourceCandidate(reference.directory),
      /source identities are not bound/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
