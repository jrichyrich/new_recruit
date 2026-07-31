import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSignedDataBundleChannelPointer,
  createSignedDataBundleManifest,
  dataBundleChannelPointerSha256,
  verifyDataBundleChannelPointer,
  verifyDataBundleManifest,
  type DataBundleManifestDraftV1,
  type DataBundleShardV1,
  type DataBundleSigner,
} from "../lib/rosterpilot/data-bundle";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
  type DataBundleDeltaResult,
  type DataBundleSemanticHashesV1,
} from "../lib/rosterpilot/semantic-hash";
import {
  buildRuntimeDataBundle,
  buildRuntimeDataBundleWithRetainedOfficialEvidence,
  runtimeOfficialCarryForward,
  signRuntimeDataBundle,
  verifyRuntimeDataBundle,
  type RuntimeDataBundleBuild,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  newRecruitCatalogueMappings,
} from "../lib/rosterpilot/catalogue";
import {
  newRecruitCatalogue,
} from "../lib/rosterpilot/catalogue-summary";
import {
  serializeRuntimeRulesData,
} from "../lib/rosterpilot/runtime-dataset";
import {
  DATA_BUNDLE_BUILD_USAGE,
  dataBundleSignerFromEnvironment,
  officialReconciliationAssessment,
  publishSignedDataBundle,
  runBuildDataBundleCli,
} from "../scripts/build-data-bundle";
import {
  PREPARE_DATA_BUNDLE_USAGE,
  parsePrepareDataBundleArgs,
  partialRollForwardBlockReason,
  prepareDataBundleUpdate,
  runPrepareDataBundleCli,
  validationPlanForDelta,
  writeCertificationReviewPackage,
} from "../scripts/prepare-data-bundle-update";

const digest = (character: string): string => character.repeat(64);
const OLD_BSDATA_COMMIT =
  "419a80d35346cd9bf26d32f69b4a5df404beb95d";
const NEW_BSDATA_COMMIT =
  "21b4efa69d7212cb206fdcbf98aa606ee49f78a2";

function semanticInventory(): DataBundleSemanticHashesV1 {
  return {
    globalHash: digest("1"),
    methodologyHash: digest("2"),
    factions: {
      aeldari: {
        factionRulesHash: digest("3"),
        mappingHash: digest("4"),
        portfolioHash: digest("5"),
        conflictHash: digest("6"),
        entityHashes: {
          "unit:guardian-defenders": digest("7"),
        },
      },
    },
  };
}

function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

async function fixtureBuild(
  commit: string,
  createdAt: string,
  official: {
    version: string;
    contentSha256: string;
  } = {
    version: "1.1",
    contentSha256: digest("8"),
  },
): Promise<RuntimeDataBundleBuild> {
  const globalShard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "global",
    kind: "global",
    factionIds: [],
    data: { payloadKind: "test-global", rules: ["core"] },
  };
  const factionShard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "faction:aeldari",
    kind: "faction",
    factionIds: ["aeldari"],
    data: {
      payloadKind: "test-faction",
      factionId: "aeldari",
      rules: ["guardian-defenders"],
    },
  };
  const descriptors: DataBundleManifestDraftV1["shards"] = [];
  for (const shard of [globalShard, factionShard]) {
    descriptors.push({
      shardId: shard.shardId,
      kind: shard.kind,
      factionIds: shard.factionIds,
      dependencyShardIds:
        shard.kind === "global" ? [] : ["global"],
      path:
        shard.kind === "global"
          ? "shards/global.json"
          : "shards/aeldari.json",
      contentSha256: await sha256Hex(canonicalJson(shard)),
      semanticHash: await semanticHash(shard.data),
      byteLength: canonicalByteLength(shard),
      mediaType:
        "application/vnd.rosterpilot.data-shard+json",
    });
  }
  return {
    draft: {
      schemaVersion: 1,
      engineDataSchemaVersion: 1,
      createdAt,
      provenance: {
        official: {
          authority: "games-workshop",
          version: official.version,
          contentSha256: official.contentSha256,
          downloadsUrl:
            "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
          dataUrl: "https://mfm.warhammer-community.com/en",
          checkedAt: createdAt,
        },
        rules: {
          provider: "40kdc-data",
          package: "@alpaca-software/40kdc-data",
          version: "1.2.1",
          sourceSha256: digest("9"),
          edition: "11th",
          dataslate: "launch",
        },
        newRecruit: {
          provider: "bsdata",
          repository: "BSData/wh40k-11e",
          branch: "main",
          commit,
        },
      },
      semanticHashes: semanticInventory(),
      shards: descriptors,
    },
    shards: [globalShard, factionShard] as unknown as RuntimeDataBundleBuild["shards"],
    officialReconciliation: null,
  };
}

async function signingFixture(): Promise<{
  pair: CryptoKeyPair;
  signer: DataBundleSigner;
}> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  return {
    pair,
    signer: {
      keyId: "release-2026",
      privateKey: pair.privateKey,
    },
  };
}

async function retainedOfficialFixture(
  rules: ReturnType<typeof serializeRuntimeRulesData>,
) {
  const unit = rules.units.find(
    (entry) =>
      (entry as { faction_id?: string }).faction_id ===
        "adeptus-custodes" &&
      ((entry as { points?: unknown[] }).points?.length ?? 0) > 0,
  ) as {
    id: string;
    faction_id: string;
    points: Array<{
      models: number;
      cost: number;
      unit_count_min: number;
      unit_count_max: number | null;
    }>;
  };
  assert.ok(unit);
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
  const emptyPayloadHash = await semanticHash([]);
  const overlay = {
    schemaVersion: 1 as const,
    authority: "games-workshop" as const,
    source: {
      version:
        newRecruitCatalogueMappings.sources.official.mfmVersion,
      contentSha256:
        newRecruitCatalogueMappings.sources.official.contentSha256,
      url: newRecruitCatalogueMappings.sources.official.mfmUrl,
      extractedAt: "2026-07-30T00:00:00.000Z",
      extractor: "reviewed-fixture",
      extractorVersion: "1",
    },
    coverage: {
      unitPoints: {
        status: "complete" as const,
        sourceEntityCount: 1,
        extractedEntityCount: 1,
        payloadSha256: await semanticHash(unitPoints),
      },
      leaderLinks: {
        status: "not-published" as const,
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: emptyPayloadHash,
      },
      detachments: {
        status: "not-published" as const,
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: emptyPayloadHash,
      },
      enhancementPoints: {
        status: "not-published" as const,
        sourceEntityCount: 0,
        extractedEntityCount: 0,
        payloadSha256: emptyPayloadHash,
      },
    },
    unitPoints,
    leaderLinks: [],
    detachments: [],
    enhancementPoints: [],
  };
  return {
    unit,
    overlay,
    authority: {
      status: "verified" as const,
      sourceArtifactSha256: digest("1"),
      overlaySha256: await semanticHash(overlay),
      receiptSha256: digest("3"),
      extractorId: "reviewed-fixture",
      extractorKeyId: "reviewed-fixture-key",
    },
  };
}

async function legacyPointerForManifest(
  manifest: { bundleId: string },
  signer: DataBundleSigner,
  publishedAt = "2026-07-30T00:01:00.000Z",
) {
  return createSignedDataBundleChannelPointer(
    {
      schemaVersion: 1,
      channel: "stable",
      bundleId: manifest.bundleId,
      manifestUrl:
        `https://data.rosterpilot.example/bundles/` +
        `${manifest.bundleId}/manifest.json`,
      publishedAt,
    },
    signer,
  );
}

test("bundle build and update help are read-only before signing configuration", async () => {
  let buildOutput = "";
  await runBuildDataBundleCli(["--help"], {
    root: "/definitely/not/a/project",
    environment: { NODE_ENV: "test" },
    writeOutput: (value) => {
      buildOutput += value;
    },
  });
  assert.equal(buildOutput, DATA_BUNDLE_BUILD_USAGE);

  let prepareOutput = "";
  await runPrepareDataBundleCli(["--help"], {
    root: "/definitely/not/a/project",
    environment: { NODE_ENV: "test" },
    writeOutput: (value) => {
      prepareOutput += value;
    },
  });
  assert.equal(prepareOutput, PREPARE_DATA_BUNDLE_USAGE);
  assert.deepEqual(parsePrepareDataBundleArgs(["--no-refresh"]), {
    help: false,
    outDir: "dist/data-channel",
    channel: "stable",
    publicBaseUrl: null,
    previousManifest: null,
    officialReconciliationEvidence: null,
    officialSourceArtifact: null,
    officialExtractionReceipt: null,
    officialExtractorTrustedKeys:
      "data/official-extractor-trusted-keys.json",
    officialAuthorityUnavailableReason: null,
    reviewPackageDir: null,
    skipRefresh: true,
  });
  assert.equal(
    parsePrepareDataBundleArgs([
      "--review-package-dir",
      "out/review",
    ]).reviewPackageDir,
    "out/review",
  );
  assert.throws(
    () =>
      dataBundleSignerFromEnvironment({ NODE_ENV: "test" }),
    {
    message:
      /ROSTERPILOT_DATA_SIGNING_KEY_ID.*ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK/,
    },
  );
});

test("review packages preserve exact evidence with a hash inventory", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-review-source-"),
  );
  const output = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-review-parent-"),
  );
  const packageDirectory = path.join(output, "review");
  try {
    mkdirSync(path.join(root, "data"), { recursive: true });
    mkdirSync(
      path.join(root, ".certification-data-bundle", "aeldari"),
      { recursive: true },
    );
    const manifestPath = path.join(root, "manifest.json");
    const updatePath = path.join(root, "update.json");
    writeFileSync(
      path.join(root, "data", "certification-manifest.json"),
      '{"schemaVersion":1}\n',
    );
    writeFileSync(
      path.join(
        root,
        ".certification-data-bundle",
        "aeldari",
        "certification-report.json",
      ),
      '{"status":"degraded"}\n',
    );
    writeFileSync(manifestPath, '{"bundleId":"candidate"}\n');
    writeFileSync(updatePath, '{"classification":"mapping-only"}\n');

    const packagePath = writeCertificationReviewPackage({
      outputDirectory: packageDirectory,
      candidateRoot: root,
      candidateManifestPath: manifestPath,
      candidateUpdateReportPath: updatePath,
      candidate: {
        bundleId: digest("a"),
        manifestPath,
        channelPath: path.join(root, "stable.json"),
        classification: "mapping-only",
        affectedFactions: ["aeldari"],
        retainedFactions: [],
      },
      certification: {
        failedFactions: [
          {
            factionId: "aeldari",
            reason: "expert review pending",
          },
        ],
      },
      createdAt: "2026-07-31T18:00:00.000Z",
    });
    const reviewPackage = JSON.parse(
      readFileSync(packagePath, "utf8"),
    ) as {
      packageKind: string;
      failedFactions: Array<{ factionId: string }>;
      files: Array<{ path: string; sha256: string }>;
    };
    assert.equal(
      reviewPackage.packageKind,
      "rosterpilot-certification-review",
    );
    assert.deepEqual(
      reviewPackage.failedFactions.map((entry) => entry.factionId),
      ["aeldari"],
    );
    assert.deepEqual(
      reviewPackage.files.map((entry) => entry.path),
      [
        "candidate/manifest.json",
        "candidate/update-report.json",
        "certification-manifest.pending.json",
        "README.md",
        "reports/aeldari/certification-report.json",
      ],
    );
    assert.ok(
      reviewPackage.files.every((entry) =>
        /^[a-f0-9]{64}$/.test(entry.sha256),
      ),
    );
    assert.throws(
      () =>
        writeCertificationReviewPackage({
          outputDirectory: packageDirectory,
          candidateRoot: root,
          candidateManifestPath: manifestPath,
          candidateUpdateReportPath: updatePath,
          candidate: {
            bundleId: digest("a"),
            manifestPath,
            channelPath: path.join(root, "stable.json"),
            classification: "mapping-only",
            affectedFactions: ["aeldari"],
            retainedFactions: [],
          },
          certification: { failedFactions: [] },
          createdAt: "2026-07-31T18:00:00.000Z",
        }),
      /not empty/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("partial roll-forward rejects shared semantic changes", () => {
  const baseline = {
    engineDataSchemaVersion: 3,
    semanticHashes: {
      globalHash: digest("1"),
      methodologyHash: digest("2"),
    },
  };
  assert.equal(
    partialRollForwardBlockReason(baseline, baseline),
    null,
  );
  assert.equal(
    partialRollForwardBlockReason(baseline, {
      ...baseline,
      semanticHashes: {
        ...baseline.semanticHashes,
        globalHash: digest("3"),
      },
    }),
    "the global shard semantics changed",
  );
});

test("the actual 419a80d to 21b4efa replay publishes provenance-only with zero tracked diff", async () => {
  const trackedRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-tracked-replay-"),
  );
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-channel-replay-"),
  );
  const trackedFiles = [
    "package.json",
    "package-lock.json",
    "data/sources.json",
    "data/generated/new-recruit-catalogues.json",
    "data/generated/new-recruit-summary.json",
    "data/certification-manifest.json",
  ];
  try {
    for (const [index, relativePath] of trackedFiles.entries()) {
      const filename = path.join(trackedRoot, relativePath);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, `tracked-${index}\n`);
    }
    const before = new Map(
      trackedFiles.map((relativePath) => [
        relativePath,
        readFileSync(
          path.join(trackedRoot, relativePath),
          "utf8",
        ),
      ]),
    );
    const { pair, signer } = await signingFixture();
    const previousBuild = await fixtureBuild(
      OLD_BSDATA_COMMIT,
      "2026-07-30T00:00:00.000Z",
    );
    const previousManifest =
      await createSignedDataBundleManifest(
        previousBuild.draft,
        signer,
      );
    const candidate = await publishSignedDataBundle(
      await fixtureBuild(
        NEW_BSDATA_COMMIT,
        "2026-07-31T00:00:00.000Z",
      ),
      {
        outputRoot,
        channel: "stable",
        publicBaseUrl:
          "https://data.rosterpilot.example",
        signer,
        previousManifest,
        previousChannelPointer:
          await legacyPointerForManifest(
            previousManifest,
            signer,
          ),
        publishedAt: "2026-07-31T00:01:00.000Z",
      },
    );

    assert.equal(
      candidate.manifest.provenance.newRecruit.commit,
      NEW_BSDATA_COMMIT,
    );
    assert.equal(
      candidate.updateReport.previousBundleId,
      previousManifest.bundleId,
    );
    assert.equal(
      candidate.updateReport.delta?.classification,
      "provenance-only",
    );
    assert.deepEqual(
      candidate.updateReport.delta?.affectedFactions,
      [],
    );
    const verifiedManifest = await verifyDataBundleManifest(
      JSON.parse(readFileSync(candidate.manifestPath, "utf8")),
      { "release-2026": pair.publicKey },
    );
    assert.equal(verifiedManifest.ok, true);
    const verifiedPointer =
      await verifyDataBundleChannelPointer(
        JSON.parse(
          readFileSync(candidate.channelPath, "utf8"),
        ),
        { "release-2026": pair.publicKey },
      );
    assert.equal(verifiedPointer.ok, true);
    if (!verifiedPointer.ok) return;
    assert.equal(verifiedPointer.data.schemaVersion, 2);
    if (verifiedPointer.data.schemaVersion === 2) {
      assert.equal(verifiedPointer.data.revision, 1);
      assert.equal(
        verifiedPointer.data.transition.kind,
        "publish",
      );
      assert.ok(verifiedPointer.data.previous);
    }
    assert.equal(
      existsSync(
        path.join(
          outputRoot,
          "channels",
          "stable",
          `${await dataBundleChannelPointerSha256(verifiedPointer.data)}.json`,
        ),
      ),
      true,
    );
    for (const relativePath of trackedFiles) {
      assert.equal(
        readFileSync(
          path.join(trackedRoot, relativePath),
          "utf8",
        ),
        before.get(relativePath),
        `${relativePath} must not be rewritten by bundle publication`,
      );
    }
  } finally {
    rmSync(trackedRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("the routine updater stages the 419a80d to 21b4efa transition outside the checkout", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-staged-replay-"),
  );
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-staged-channel-"),
  );
  const preparedOutput = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-prepared-channel-"),
  );
  try {
    const source = {
      schemaVersion: 1 as const,
      releaseId: "2026-07-30.1",
      rules: {
        package: "@alpaca-software/40kdc-data" as const,
        version: "1.2.1",
        edition: "11th" as const,
        dataslate: "launch",
      },
      newRecruit: {
        repository: "BSData/wh40k-11e",
        url: "https://github.com/BSData/wh40k-11e.git",
        branch: "main",
        commit: OLD_BSDATA_COMMIT,
      },
      official: {
        downloadsUrl:
          "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
        mfmUrl: "https://mfm.warhammer-community.com/en",
        mfmVersion: "1.1",
        updatedAt: "2026-07-22",
        contentSha256: digest("a"),
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    };
    const summary = {
      releaseId: source.releaseId,
      summary: {
        factionCount: 1,
        exportCapableFactions: 1,
        completeFactions: 1,
        conflicts: 0,
        blockingConflicts: 0,
        uniqueConflicts: 0,
        uniqueBlockingConflicts: 0,
      },
      factions: {
        aeldari: {
          configurationAvailable: true,
          coverage: {
            mappedUnits: 1,
            mappedDetachments: 1,
          },
        },
      },
    };
    const trackedValues: Record<string, string> = {
      "package.json": "{}\n",
      "package-lock.json": "{}\n",
      "tsconfig.json": "{}\n",
      "data/sources.json": `${JSON.stringify(source)}\n`,
      "data/bsdata-overrides.json": "{}\n",
      "data/generated/new-recruit-catalogues.json":
        '{"catalogue":"unchanged"}\n',
      "data/generated/new-recruit-summary.json":
        `${JSON.stringify(summary)}\n`,
      "data/certification-manifest.json":
        '{"certification":"unchanged"}\n',
    };
    for (const [relativePath, value] of Object.entries(
      trackedValues,
    )) {
      const filename = path.join(root, relativePath);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, value);
    }
    for (const directory of ["lib", "local", "scripts"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }

    const { signer } = await signingFixture();
    const previousBuild = await fixtureBuild(
      OLD_BSDATA_COMMIT,
      "2026-07-30T00:00:00.000Z",
    );
    const previousManifest =
      await createSignedDataBundleManifest(
        previousBuild.draft,
        signer,
      );
    const previousManifestPath = path.join(
      root,
      "previous-manifest.json",
    );
    writeFileSync(
      previousManifestPath,
      JSON.stringify(previousManifest),
    );
    const publishedCandidate = await publishSignedDataBundle(
      await fixtureBuild(
        NEW_BSDATA_COMMIT,
        "2026-07-31T00:00:00.000Z",
      ),
      {
        outputRoot: preparedOutput,
        channel: "stable",
        publicBaseUrl:
          "https://data.rosterpilot.example",
        signer,
        previousManifest,
        previousChannelPointer:
          await legacyPointerForManifest(
            previousManifest,
            signer,
          ),
        publishedAt: "2026-07-31T00:01:00.000Z",
      },
    );

    const commands: string[] = [];
    const result = await prepareDataBundleUpdate({
      root,
      outputRoot,
      channel: "stable",
      publicBaseUrl: "https://data.rosterpilot.example",
      previousManifest: previousManifestPath,
      freshness: {
        checkedAt: "2026-07-31T00:00:00.000Z",
        state: "update-available",
        rules: {
          pinnedVersion: "1.2.1",
          latestVersion: "1.2.1",
          updateAvailable: false,
        },
        newRecruit: {
          pinnedCommit: OLD_BSDATA_COMMIT,
          latestCommit: NEW_BSDATA_COMMIT,
          updateAvailable: true,
        },
        official: {
          pinnedVersion: "1.1",
          latestVersion: "1.1",
          pinnedContentSha256: digest("a"),
          latestContentSha256: digest("a"),
          updateAvailable: false,
        },
      },
      environment: { NODE_ENV: "test" },
      now: () => "2026-07-31T00:00:00.000Z",
      run: (_command, args) => {
        commands.push(args.join(" "));
        if (args.includes("scripts/build-data-bundle.ts")) {
          const outIndex = args.indexOf("--out-dir");
          assert.notEqual(outIndex, -1);
          cpSync(preparedOutput, args[outIndex + 1], {
            recursive: true,
          });
        }
      },
    });
    assert.equal(result.changed, true);
    assert.equal(
      result.bundleId,
      publishedCandidate.manifest.bundleId,
    );
    assert.equal(result.sourceChanged, true);
    assert.equal(result.classification, "provenance-only");
    assert.equal(result.releaseId, "2026-07-31.1");
    assert.ok(
      commands.some((command) =>
        command.includes("scripts/sync-bsdata.ts --write"),
      ),
    );
    assert.ok(
      commands.some((command) =>
        command.includes("run data:sync-check"),
      ),
    );
    assert.ok(
      !commands.some((command) =>
        command.includes("certify:manifest:sync"),
      ),
    );
    assert.ok(
      !commands.some((command) =>
        command.includes("run certify "),
      ),
    );
    for (const [relativePath, value] of Object.entries(
      trackedValues,
    )) {
      assert.equal(
        readFileSync(path.join(root, relativePath), "utf8"),
        value,
        `${relativePath} changed in the application checkout`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(preparedOutput, { recursive: true, force: true });
  }
});

test("an official publication change quarantines without a source-bound overlay", async () => {
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-official-quarantine-"),
  );
  try {
    const { signer } = await signingFixture();
    const previousBuild = await fixtureBuild(
      OLD_BSDATA_COMMIT,
      "2026-07-30T00:00:00.000Z",
    );
    const previousManifest =
      await createSignedDataBundleManifest(
        previousBuild.draft,
        signer,
      );
    const candidate = await fixtureBuild(
      OLD_BSDATA_COMMIT,
      "2026-07-31T00:00:00.000Z",
      {
        version: "1.2",
        contentSha256: digest("c"),
      },
    );
    const assessment = officialReconciliationAssessment(
      previousManifest,
      candidate,
    );
    assert.equal(
      assessment?.classification,
      "ambiguous/regressive",
    );
    assert.deepEqual(assessment?.changedScopes, ["official"]);
    await assert.rejects(
      publishSignedDataBundle(candidate, {
        outputRoot,
        channel: "stable",
        publicBaseUrl:
          "https://data.rosterpilot.example",
        signer,
        previousManifest,
      }),
      /ambiguous\/regressive.*official.*quarantined/,
    );
    assert.equal(
      existsSync(path.join(outputRoot, "channels", "stable.json")),
      false,
    );

    const officialOverlay = {
      schemaVersion: 1 as const,
      authority: "games-workshop" as const,
      source: {
        version: "1.2",
        contentSha256: digest("c"),
        url: "https://mfm.warhammer-community.com/en",
        extractedAt: "2026-07-31T00:00:00.000Z",
        extractor: "rosterpilot-official-fixture",
        extractorVersion: "1.0.0",
      },
      unitPoints: [],
      leaderLinks: [],
      detachments: [],
      enhancementPoints: [],
    };
    const reconciled: RuntimeDataBundleBuild = {
      ...candidate,
      officialReconciliation: {
        overlayHash: await semanticHash(officialOverlay),
        affectedFactions: [],
        conflicts: [],
      },
    };
    await assert.rejects(
      publishSignedDataBundle(reconciled, {
        outputRoot,
        channel: "stable",
        publicBaseUrl:
          "https://data.rosterpilot.example",
        signer,
        previousManifest,
        officialEvidence: {
          overlay: officialOverlay,
          sourceArtifact: new Uint8Array(),
          extractionReceipt: {},
          trustedExtractors: {},
        },
      }),
      /coverage/,
    );
    assert.equal(
      existsSync(path.join(outputRoot, "channels", "stable.json")),
      false,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("the first stable channel requires reviewed authority or an explicit degraded reason", async () => {
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-authority-genesis-"),
  );
  try {
    const { signer } = await signingFixture();
    const unavailableReason =
      "No reviewed extractor is configured for this explicit degraded fixture.";
    const build = await buildRuntimeDataBundle({
      officialAuthority: {
        status: "unavailable",
        reason: unavailableReason,
      },
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    await assert.rejects(
      publishSignedDataBundle(build, {
        outputRoot,
        channel: "stable",
        publicBaseUrl: "https://data.rosterpilot.example",
        signer,
      }),
      /first stable-channel publication requires reviewed official extraction evidence/i,
    );
    const published = await publishSignedDataBundle(build, {
      outputRoot,
      channel: "stable",
      publicBaseUrl: "https://data.rosterpilot.example",
      signer,
      officialAuthorityUnavailableReason: unavailableReason,
    });
    const global = published.updateReport.candidateBundleId
      ? build.shards.find((shard) => shard.shardId === "global")?.data
      : null;
    assert.equal(
      global?.payloadKind === "rosterpilot-runtime-global"
        ? global.officialAuthority.status
        : null,
      "unavailable",
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("a provenance-only refresh preserves verified authority and rejects an unnoticed downgrade", async () => {
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-authority-refresh-"),
  );
  try {
    const { pair, signer } = await signingFixture();
    const authority = {
      status: "verified" as const,
      sourceArtifactSha256: digest("1"),
      overlaySha256: digest("2"),
      receiptSha256: digest("3"),
      extractorId: "reviewed-fixture",
      extractorKeyId: "reviewed-fixture-key",
    };
    const currentBuild = await buildRuntimeDataBundle({
      officialAuthority: authority,
      createdAt: "2026-07-30T00:00:00.000Z",
    });
    const currentSigned = await signRuntimeDataBundle(
      currentBuild,
      signer,
    );
    const current = await verifyRuntimeDataBundle({
      manifest: currentSigned.manifest,
      shards: currentSigned.shards,
      trustedKeys: { "release-2026": pair.publicKey },
    });
    if (!current.ok) assert.fail(current.message);
    const previousPointer = await legacyPointerForManifest(
      currentSigned.manifest,
      signer,
    );

    const preservedBuild = await buildRuntimeDataBundle({
      officialAuthority: authority,
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    const preserved = await publishSignedDataBundle(
      preservedBuild,
      {
        outputRoot,
        channel: "stable",
        publicBaseUrl: "https://data.rosterpilot.example",
        signer,
        previousManifest: currentSigned.manifest,
        previousChannelPointer: previousPointer,
        previousSnapshot: current.data,
      },
    );
    assert.equal(
      preserved.updateReport.delta?.classification,
      "provenance-only",
    );
    const preservedGlobal = preservedBuild.shards.find(
      (shard) => shard.shardId === "global",
    )?.data;
    assert.deepEqual(
      preservedGlobal?.payloadKind === "rosterpilot-runtime-global"
        ? preservedGlobal.officialAuthority
        : null,
      authority,
    );

    const downgraded = await buildRuntimeDataBundle({
      officialAuthority: {
        status: "unavailable",
        reason: "Evidence was omitted.",
      },
      createdAt: "2026-07-31T01:00:00.000Z",
    });
    await assert.rejects(
      publishSignedDataBundle(downgraded, {
        outputRoot: path.join(outputRoot, "downgrade"),
        channel: "stable",
        publicBaseUrl: "https://data.rosterpilot.example",
        signer,
        previousManifest: currentSigned.manifest,
        previousChannelPointer: previousPointer,
        previousSnapshot: current.data,
      }),
      /cannot downgrade a verified authority binding/i,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("the build CLI automatically carries verified official authority across a BSData-only refresh", async () => {
  const previousRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-authority-carry-previous-"),
  );
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-authority-carry-output-"),
  );
  try {
    const { pair, signer } = await signingFixture();
    const rules = serializeRuntimeRulesData();
    const officialUnit = rules.units.find(
      (entry) =>
        (entry as { faction_id?: string }).faction_id ===
          "adeptus-custodes" &&
        ((entry as { points?: unknown[] }).points?.length ?? 0) >
          0,
    ) as
      | {
          id: string;
          faction_id: string;
          points: Array<{
            models: number;
            cost: number;
            unit_count_min: number;
            unit_count_max: number | null;
          }>;
        }
      | undefined;
    assert.ok(officialUnit);
    const unitPoints = [
      {
        factionId: officialUnit.faction_id,
        unitId: officialUnit.id,
        tiers: officialUnit.points.map((tier, index) => ({
          ...tier,
          cost: tier.cost + (index === 0 ? 5 : 0),
        })),
      },
    ];
    const emptyPayloadHash = await semanticHash([]);
    const officialOverlay = {
      schemaVersion: 1 as const,
      authority: "games-workshop" as const,
      source: {
        version:
          newRecruitCatalogueMappings.sources.official.mfmVersion,
        contentSha256:
          newRecruitCatalogueMappings.sources.official
            .contentSha256,
        url: newRecruitCatalogueMappings.sources.official.mfmUrl,
        extractedAt: "2026-07-30T00:00:00.000Z",
        extractor: "reviewed-fixture",
        extractorVersion: "1",
      },
      coverage: {
        unitPoints: {
          status: "complete" as const,
          sourceEntityCount: 1,
          extractedEntityCount: 1,
          payloadSha256: await semanticHash(unitPoints),
        },
        leaderLinks: {
          status: "not-published" as const,
          sourceEntityCount: 0,
          extractedEntityCount: 0,
          payloadSha256: emptyPayloadHash,
        },
        detachments: {
          status: "not-published" as const,
          sourceEntityCount: 0,
          extractedEntityCount: 0,
          payloadSha256: emptyPayloadHash,
        },
        enhancementPoints: {
          status: "not-published" as const,
          sourceEntityCount: 0,
          extractedEntityCount: 0,
          payloadSha256: emptyPayloadHash,
        },
      },
      unitPoints,
      leaderLinks: [],
      detachments: [],
      enhancementPoints: [],
    };
    const officialOverlayHash = await semanticHash(officialOverlay);
    const authority = {
      status: "verified" as const,
      sourceArtifactSha256: digest("1"),
      overlaySha256: officialOverlayHash,
      receiptSha256: digest("3"),
      extractorId: "reviewed-fixture",
      extractorKeyId: "reviewed-fixture-key",
    };
    const catalogue = structuredClone(newRecruitCatalogueMappings);
    const summary = structuredClone(newRecruitCatalogue);
    catalogue.sources.newRecruit.commit = OLD_BSDATA_COMMIT;
    summary.sources.newRecruit.commit = OLD_BSDATA_COMMIT;
    const previousBuild = await buildRuntimeDataBundle({
      catalogue,
      catalogueSummary: summary,
      officialOverlay,
      officialAuthority: authority,
      certification: JSON.parse(
        readFileSync(
          path.join(
            process.cwd(),
            "data",
            "certification-manifest.json",
          ),
          "utf8",
        ),
      ),
      createdAt: "2026-07-30T00:00:00.000Z",
    });
    assert.equal(previousBuild.officialReconciliation?.conflicts.length, 1);
    const previous = await signRuntimeDataBundle(
      previousBuild,
      signer,
    );
    const previousDirectory = path.join(
      previousRoot,
      "bundles",
      previous.manifest.bundleId,
    );
    mkdirSync(previousDirectory, { recursive: true });
    writeFileSync(
      path.join(previousDirectory, "manifest.json"),
      `${JSON.stringify(previous.manifest, null, 2)}\n`,
    );
    for (const descriptor of previous.manifest.shards) {
      const shard = previous.shards.find(
        (entry) => entry.shardId === descriptor.shardId,
      );
      assert.ok(shard);
      const filename = path.join(
        previousDirectory,
        ...descriptor.path.split("/"),
      );
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, `${JSON.stringify(shard, null, 2)}\n`);
    }
    const pointer = await legacyPointerForManifest(
      previous.manifest,
      signer,
    );
    mkdirSync(path.join(previousRoot, "channels"), {
      recursive: true,
    });
    writeFileSync(
      path.join(previousRoot, "channels", "stable.json"),
      `${JSON.stringify(pointer, null, 2)}\n`,
    );
    const privateKey = await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    );
    let output = "";
    await runBuildDataBundleCli(
      [
        "--out-dir",
        outputRoot,
        "--manifest-base-url",
        "https://data.rosterpilot.example",
        "--previous-manifest",
        path.join(previousDirectory, "manifest.json"),
        "--created-at",
        "2026-07-31T00:00:00.000Z",
      ],
      {
        root: process.cwd(),
        environment: {
          NODE_ENV: "test",
          ROSTERPILOT_DATA_SIGNING_KEY_ID: signer.keyId,
          ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK:
            JSON.stringify(privateKey),
          ROSTERPILOT_DATA_BUNDLE_BASE_URL:
            "https://data.rosterpilot.example",
        },
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    const report = JSON.parse(output) as {
      bundleId: string;
      classification: string;
    };
    assert.equal(report.classification, "provenance-only");
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          outputRoot,
          "bundles",
          report.bundleId,
          "manifest.json",
        ),
        "utf8",
      ),
    ) as { shards: Array<{ shardId: string; path: string }> };
    const globalPath = manifest.shards.find(
      (entry) => entry.shardId === "global",
    )?.path;
    assert.ok(globalPath);
    const global = JSON.parse(
      readFileSync(
        path.join(
          outputRoot,
          "bundles",
          report.bundleId,
          ...globalPath.split("/"),
        ),
        "utf8",
      ),
    ) as {
      data: {
        officialAuthority: unknown;
        officialReconciliation: { overlayHash: string } | null;
      };
    };
    assert.deepEqual(global.data.officialAuthority, authority);
    assert.equal(
      global.data.officialReconciliation?.overlayHash,
      authority.overlaySha256,
    );
    const factionPath = manifest.shards.find(
      (entry) => entry.shardId === "faction:adeptus-custodes",
    )?.path;
    assert.ok(factionPath);
    const faction = JSON.parse(
      readFileSync(
        path.join(
          outputRoot,
          "bundles",
          report.bundleId,
          ...factionPath.split("/"),
        ),
        "utf8",
      ),
    ) as {
      data: {
        rulesData: { units: unknown[] };
        officialConflicts: unknown[];
        officialOverlayHash: string | null;
      };
    };
    const carriedUnit = faction.data.rulesData.units.find(
      (entry) =>
        (entry as { id?: string }).id === officialUnit.id,
    ) as { points?: Array<{ cost?: number }> } | undefined;
    assert.equal(
      carriedUnit?.points?.[0]?.cost,
      unitPoints[0].tiers[0].cost,
    );
    assert.equal(faction.data.officialConflicts.length, 1);
    assert.equal(
      faction.data.officialOverlayHash,
      authority.overlaySha256,
    );
  } finally {
    rmSync(previousRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("a 40kdc refresh reapplies the exact retained official overlay", async () => {
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-official-rules-refresh-"),
  );
  try {
    const { pair, signer } = await signingFixture();
    const previousRules = serializeRuntimeRulesData();
    const fixture = await retainedOfficialFixture(previousRules);
    const previousBuild = await buildRuntimeDataBundle({
      rulesData: previousRules,
      officialOverlay: fixture.overlay,
      officialAuthority: fixture.authority,
      createdAt: "2026-07-30T00:00:00.000Z",
    });
    const previousSigned = await signRuntimeDataBundle(
      previousBuild,
      signer,
    );
    const verified = await verifyRuntimeDataBundle({
      manifest: previousSigned.manifest,
      shards: previousSigned.shards,
      trustedKeys: { [signer.keyId]: pair.publicKey },
    });
    if (!verified.ok) assert.fail(verified.message);

    const refreshedRules = structuredClone(previousRules);
    const refreshedUnit = refreshedRules.units.find(
      (entry) =>
        (entry as { id?: string }).id === fixture.unit.id,
    ) as { points: Array<{ cost: number }> };
    refreshedUnit.points[0].cost += 20;
    const candidate =
      await buildRuntimeDataBundleWithRetainedOfficialEvidence(
        {
          rulesData: refreshedRules,
          createdAt: "2026-07-31T00:00:00.000Z",
        },
        verified.data,
      );

    assert.notEqual(
      candidate.draft.provenance.rules.sourceSha256,
      previousSigned.manifest.provenance.rules.sourceSha256,
    );
    const candidateGlobal = candidate.shards.find(
      (shard) => shard.shardId === "global",
    )?.data;
    assert.equal(
      candidateGlobal?.payloadKind === "rosterpilot-runtime-global"
        ? candidateGlobal.officialEvidenceOverlay?.unitPoints[0]
            ?.unitId
        : null,
      fixture.unit.id,
    );
    const candidateFaction = candidate.shards.find(
      (shard) => shard.shardId === "faction:adeptus-custodes",
    )?.data;
    const effectiveUnit =
      candidateFaction?.payloadKind ===
      "rosterpilot-runtime-faction"
        ? (candidateFaction.rulesData.units.find(
            (entry) =>
              (entry as { id?: string }).id === fixture.unit.id,
          ) as { points?: Array<{ cost?: number }> } | undefined)
        : undefined;
    assert.equal(
      effectiveUnit?.points?.[0]?.cost,
      fixture.overlay.unitPoints[0].tiers[0].cost,
    );
    assert.deepEqual(
      candidateGlobal?.payloadKind === "rosterpilot-runtime-global"
        ? candidateGlobal.officialAuthority
        : null,
      fixture.authority,
    );

    const published = await publishSignedDataBundle(candidate, {
      outputRoot,
      channel: "stable",
      publicBaseUrl: "https://data.rosterpilot.example",
      signer,
      previousManifest: previousSigned.manifest,
      previousChannelPointer: await legacyPointerForManifest(
        previousSigned.manifest,
        signer,
      ),
      previousSnapshot: verified.data,
    });
    assert.ok(published.updateReport.delta);
    assert.equal(
      published.manifest.provenance.official.contentSha256,
      previousSigned.manifest.provenance.official.contentSha256,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("a retained official overlay fails closed when refreshed 40kdc data no longer matches", async () => {
  const { pair, signer } = await signingFixture();
  const previousRules = serializeRuntimeRulesData();
  const fixture = await retainedOfficialFixture(previousRules);
  const previousBuild = await buildRuntimeDataBundle({
    rulesData: previousRules,
    officialOverlay: fixture.overlay,
    officialAuthority: fixture.authority,
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  const previousSigned = await signRuntimeDataBundle(
    previousBuild,
    signer,
  );
  const verified = await verifyRuntimeDataBundle({
    manifest: previousSigned.manifest,
    shards: previousSigned.shards,
    trustedKeys: { [signer.keyId]: pair.publicKey },
  });
  if (!verified.ok) assert.fail(verified.message);

  const incompatibleRules = structuredClone(previousRules);
  incompatibleRules.units = incompatibleRules.units.filter(
    (entry) =>
      (entry as { id?: string }).id !== fixture.unit.id,
  );
  await assert.rejects(
    buildRuntimeDataBundleWithRetainedOfficialEvidence(
      {
        rulesData: incompatibleRules,
        createdAt: "2026-07-31T00:00:00.000Z",
      },
      verified.data,
    ),
    new RegExp(
      `Official overlay references unknown adeptus-custodes:${fixture.unit.id}`,
    ),
  );
});

test("retained official evidence rejects a signed overlay-to-receipt hash mismatch", async () => {
  const { pair, signer } = await signingFixture();
  const rules = serializeRuntimeRulesData();
  const fixture = await retainedOfficialFixture(rules);
  const mismatched = await buildRuntimeDataBundle({
    rulesData: rules,
    officialOverlay: fixture.overlay,
    officialAuthority: fixture.authority,
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  const global = mismatched.shards.find(
    (shard) => shard.shardId === "global",
  );
  assert.ok(
    global?.data.payloadKind === "rosterpilot-runtime-global" &&
      global.data.officialEvidenceOverlay,
  );
  if (
    !global ||
    global.data.payloadKind !== "rosterpilot-runtime-global" ||
    !global.data.officialEvidenceOverlay
  ) {
    assert.fail("Expected retained official evidence.");
  }
  global.data.officialEvidenceOverlay.source.extractedAt =
    "2026-07-30T00:00:01.000Z";
  const descriptor = mismatched.draft.shards.find(
    (entry) => entry.shardId === "global",
  );
  assert.ok(descriptor);
  descriptor.contentSha256 = await sha256Hex(canonicalJson(global));
  descriptor.semanticHash = await semanticHash(global.data);
  descriptor.byteLength = canonicalByteLength(global);

  const signed = await signRuntimeDataBundle(mismatched, signer);
  const verified = await verifyRuntimeDataBundle({
    manifest: signed.manifest,
    shards: signed.shards,
    trustedKeys: { [signer.keyId]: pair.publicKey },
  });
  if (!verified.ok) assert.fail(verified.message);
  await assert.rejects(
    runtimeOfficialCarryForward(verified.data),
    /official evidence.*does not match.*receipt-bound authority/i,
  );
});

test("validation planning skips certification churn only for verified provenance-only updates", () => {
  const provenanceOnly: DataBundleDeltaResult = {
    classification: "provenance-only",
    directlyChangedFactions: [],
    affectedFactions: [],
    changedEntities: {},
    changedScopes: [],
    requiresFullCertification: false,
    quarantine: false,
    reasons: ["No semantics changed."],
  };
  assert.deepEqual(validationPlanForDelta(provenanceOnly), {
    runDataCheck: false,
    syncCertificationManifest: false,
    certificationFactions: [],
    fullCertification: false,
    includePortfolio: false,
  });

  const mappingOnly: DataBundleDeltaResult = {
    ...provenanceOnly,
    classification: "mapping-only",
    directlyChangedFactions: ["aeldari"],
    affectedFactions: ["aeldari", "drukhari"],
  };
  assert.deepEqual(validationPlanForDelta(mappingOnly), {
    runDataCheck: true,
    syncCertificationManifest: true,
    certificationFactions: ["aeldari", "drukhari"],
    fullCertification: false,
    includePortfolio: false,
  });

  const rules: DataBundleDeltaResult = {
    ...mappingOnly,
    classification: "rules",
  };
  assert.equal(
    validationPlanForDelta(rules).includePortfolio,
    true,
  );

  const global: DataBundleDeltaResult = {
    ...provenanceOnly,
    classification: "methodology/global",
    affectedFactions: ["aeldari"],
    requiresFullCertification: true,
  };
  assert.equal(
    validationPlanForDelta(global).fullCertification,
    true,
  );
  assert.equal(
    validationPlanForDelta(global).includePortfolio,
    true,
  );
  assert.throws(
    () =>
      validationPlanForDelta({
        ...provenanceOnly,
        classification: "ambiguous/regressive",
        quarantine: true,
      }),
    /quarantined data bundle/,
  );
});

test("a scoped certification failure requests a signed partial roll-forward", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-partial-publisher-"),
  );
  const candidateOutput = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-partial-candidate-"),
  );
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-partial-channel-"),
  );
  try {
    const source = {
      schemaVersion: 1,
      releaseId: "2026-07-30.1",
      rules: {
        package: "@alpaca-software/40kdc-data",
        version: "1.2.1",
        edition: "11th",
        dataslate: "launch",
      },
      newRecruit: {
        repository: "BSData/wh40k-11e",
        url: "https://github.com/BSData/wh40k-11e.git",
        branch: "main",
        commit: OLD_BSDATA_COMMIT,
      },
      official: {
        downloadsUrl:
          "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
        mfmUrl: "https://mfm.warhammer-community.com/en",
        mfmVersion: "1.1",
        updatedAt: "2026-07-22",
        contentSha256: digest("8"),
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    };
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(
      path.join(root, "data", "sources.json"),
      JSON.stringify(source),
    );
    writeFileSync(
      path.join(root, "data", "data-bundle-trusted-keys.json"),
      '{"schemaVersion":1,"keys":[]}\n',
    );

    const { signer } = await signingFixture();
    const previousBuild = await fixtureBuild(
      OLD_BSDATA_COMMIT,
      "2026-07-30T00:00:00.000Z",
    );
    const previousManifest =
      await createSignedDataBundleManifest(
        previousBuild.draft,
        signer,
      );
    const previousManifestPath = path.join(
      root,
      "previous-manifest.json",
    );
    writeFileSync(
      previousManifestPath,
      JSON.stringify(previousManifest),
    );
    const changedBuild = await fixtureBuild(
      NEW_BSDATA_COMMIT,
      "2026-07-31T00:00:00.000Z",
    );
    changedBuild.draft.semanticHashes.factions.aeldari
      .factionRulesHash = digest("f");
    await publishSignedDataBundle(changedBuild, {
      outputRoot: candidateOutput,
      channel: "stable",
      publicBaseUrl: "https://data.rosterpilot.example",
      signer,
      previousManifest,
      previousChannelPointer:
        await legacyPointerForManifest(previousManifest, signer),
      publishedAt: "2026-07-31T00:01:00.000Z",
    });

    const commands: string[][] = [];
    const result = await prepareDataBundleUpdate({
      root,
      outputRoot,
      channel: "stable",
      publicBaseUrl: "https://data.rosterpilot.example",
      previousManifest: previousManifestPath,
      skipRefresh: true,
      environment: { NODE_ENV: "test" },
      now: () => "2026-07-31T00:00:00.000Z",
      run: (_command, args) => {
        commands.push([...args]);
        if (args.includes("scripts/build-data-bundle.ts")) {
          const outIndex = args.indexOf("--out-dir");
          assert.notEqual(outIndex, -1);
          cpSync(candidateOutput, args[outIndex + 1], {
            recursive: true,
          });
          if (args.includes("--retain-factions")) {
            const reportPath = path.join(
              args[outIndex + 1],
              "channels",
              "stable.update.json",
            );
            const report = JSON.parse(
              readFileSync(reportPath, "utf8"),
            ) as {
              candidateBundleId: string;
              composition: unknown;
            };
            report.composition = {
              retainedShards: [
                { shardId: "faction:aeldari" },
              ],
            };
            writeFileSync(reportPath, JSON.stringify(report));
            const manifestPath = path.join(
              args[outIndex + 1],
              "bundles",
              report.candidateBundleId,
              "manifest.json",
            );
            const manifest = JSON.parse(
              readFileSync(manifestPath, "utf8"),
            ) as {
              composition: unknown;
            };
            manifest.composition = report.composition;
            writeFileSync(
              manifestPath,
              JSON.stringify(manifest),
            );
          }
          return;
        }
        if (
          args[0] === "run" &&
          args[1] === "certify" &&
          args[args.indexOf("--faction") + 1] === "aeldari"
        ) {
          throw new Error("fixture certification regression");
        }
      },
    });

    const partialBuild = commands.find((args) =>
      args.includes("--retain-factions"),
    );
    assert.ok(partialBuild);
    assert.equal(
      partialBuild[
        partialBuild.indexOf("--retain-factions") + 1
      ],
      "aeldari",
    );
    assert.ok(partialBuild.includes("--previous-bundle-dir"));
    assert.ok(partialBuild.includes("--quarantine-reason"));
    assert.deepEqual(result.quarantinedFactions, ["aeldari"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(candidateOutput, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("the CLI verifies and re-signs retained dependency shards", async () => {
  const previousOutput = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-verified-previous-"),
  );
  const outputRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-composed-output-"),
  );
  try {
    const { pair, signer } = await signingFixture();
    const previousBuild = await buildRuntimeDataBundle({
      certification: JSON.parse(
        readFileSync(
          path.join(
            process.cwd(),
            "data",
            "certification-manifest.json",
          ),
          "utf8",
        ),
      ),
      createdAt: "2026-07-30T00:00:00.000Z",
    });
    const previous = await publishSignedDataBundle(
      previousBuild,
      {
        outputRoot: previousOutput,
        channel: "stable",
        publicBaseUrl:
          "https://data.rosterpilot.example",
        signer,
        officialAuthorityUnavailableReason:
          "No reviewed official extraction evidence was supplied.",
        publishedAt: "2026-07-30T00:01:00.000Z",
      },
    );
    const privateKey = await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    );
    let output = "";
    await runBuildDataBundleCli(
      [
        "--out-dir",
        outputRoot,
        "--channel",
        "stable",
        "--manifest-base-url",
        "https://data.rosterpilot.example",
        "--previous-manifest",
        previous.manifestPath,
        "--previous-bundle-dir",
        previous.bundleDirectory,
        "--retain-factions",
        "aeldari",
        "--quarantine-reason",
        "Aeldari certification fixture failed.",
        "--created-at",
        "2026-07-31T00:00:00.000Z",
      ],
      {
        root: process.cwd(),
        environment: {
          NODE_ENV: "test",
          ROSTERPILOT_DATA_SIGNING_KEY_ID:
            "release-2026",
          ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK:
            JSON.stringify(privateKey),
        },
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    const summary = JSON.parse(output) as {
      bundleId: string;
      retainedFactions: string[];
    };
    assert.deepEqual(summary.retainedFactions, [
      "aeldari",
      "drukhari",
    ]);
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          outputRoot,
          "bundles",
          summary.bundleId,
          "manifest.json",
        ),
        "utf8",
      ),
    );
    const verified = await verifyDataBundleManifest(
      manifest,
      { "release-2026": pair.publicKey },
    );
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(
      verified.data.composition?.baseBundleId,
      previous.manifest.bundleId,
    );
    assert.deepEqual(
      verified.data.composition?.retainedShards.map(
        (entry) => entry.shardId,
      ),
      ["faction:aeldari", "faction:drukhari"],
    );
  } finally {
    rmSync(previousOutput, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

function currentSourceFixture() {
  return {
    schemaVersion: 1,
    releaseId: "2026-07-30.1",
    rules: {
      package: "@alpaca-software/40kdc-data",
      version: "1.2.1",
      edition: "11th",
      dataslate: "launch",
    },
    newRecruit: {
      repository: "BSData/wh40k-11e",
      url: "https://github.com/BSData/wh40k-11e.git",
      branch: "main",
      commit: NEW_BSDATA_COMMIT,
    },
    official: {
      downloadsUrl:
        "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
      mfmUrl: "https://mfm.warhammer-community.com/en",
      mfmVersion: "1.1",
      updatedAt: "2026-07-22",
      contentSha256: digest("8"),
      checkedAt: "2026-07-30T00:00:00.000Z",
    },
  };
}

function currentFreshnessFixture() {
  return {
    checkedAt: "2026-07-31T00:00:00.000Z",
    state: "current" as const,
    rules: {
      pinnedVersion: "1.2.1",
      latestVersion: "1.2.1",
      updateAvailable: false,
    },
    newRecruit: {
      pinnedCommit: NEW_BSDATA_COMMIT,
      latestCommit: NEW_BSDATA_COMMIT,
      updateAvailable: false,
    },
    official: {
      pinnedVersion: "1.1",
      latestVersion: "1.1",
      pinnedContentSha256: digest("8"),
      latestContentSha256: digest("8"),
      updateAvailable: false,
    },
  };
}

test("equal semantic inventory cannot suppress changed signed shard evidence", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-current-behind-"),
  );
  const channelRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-current-behind-channel-"),
  );
  const candidateOutput = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-current-behind-candidate-"),
  );
  try {
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(
      path.join(root, "data", "sources.json"),
      JSON.stringify(currentSourceFixture()),
    );
    const { signer } = await signingFixture();
    const previous = await publishSignedDataBundle(
      await fixtureBuild(
        NEW_BSDATA_COMMIT,
        "2026-07-30T00:00:00.000Z",
      ),
      {
        outputRoot: channelRoot,
        channel: "stable",
        publicBaseUrl:
          "https://data.rosterpilot.example",
        signer,
      },
    );
    const changedBuild = await fixtureBuild(
      NEW_BSDATA_COMMIT,
      "2026-07-31T00:00:00.000Z",
    );
    changedBuild.draft.provenance.official.checkedAt =
      previous.manifest.provenance.official.checkedAt;
    const globalShard = changedBuild.shards.find(
      (shard) => shard.shardId === "global",
    ) as DataBundleShardV1<Record<string, unknown>>;
    globalShard.data = {
      ...globalShard.data,
      verifiedAuthorityEvidence: {
        receiptSha256: digest("f"),
      },
    };
    const globalDescriptor = changedBuild.draft.shards.find(
      (shard) => shard.shardId === "global",
    )!;
    globalDescriptor.contentSha256 = await sha256Hex(
      canonicalJson(globalShard),
    );
    globalDescriptor.semanticHash = await semanticHash(
      globalShard.data,
    );
    globalDescriptor.byteLength = canonicalByteLength(
      globalShard,
    );
    const candidate = await publishSignedDataBundle(
      changedBuild,
      {
        outputRoot: candidateOutput,
        channel: "stable",
        publicBaseUrl:
          "https://data.rosterpilot.example",
        signer,
        previousManifest: previous.manifest,
        previousChannelPointer: previous.channelPointer,
      },
    );
    const commands: string[][] = [];
    const result = await prepareDataBundleUpdate({
      root,
      outputRoot: channelRoot,
      channel: "stable",
      publicBaseUrl: "https://data.rosterpilot.example",
      previousManifest: previous.manifestPath,
      freshness: currentFreshnessFixture(),
      environment: { NODE_ENV: "test" },
      now: () => "2026-07-31T00:00:00.000Z",
      run: (_command, args) => {
        commands.push([...args]);
        if (args.includes("scripts/build-data-bundle.ts")) {
          const outIndex = args.indexOf("--out-dir");
          assert.notEqual(outIndex, -1);
          cpSync(candidateOutput, args[outIndex + 1], {
            recursive: true,
          });
        }
      },
    });

    assert.equal(result.sourceChanged, false);
    assert.equal(result.changed, true);
    assert.equal(result.classification, "provenance-only");
    assert.equal(result.bundleId, candidate.manifest.bundleId);
    assert.ok(
      commands.some((args) =>
        args.includes("scripts/build-data-bundle.ts"),
      ),
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(channelRoot, "channels", "stable.json"),
          "utf8",
        ),
      ).bundleId,
      candidate.manifest.bundleId,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(channelRoot, { recursive: true, force: true });
    rmSync(candidateOutput, { recursive: true, force: true });
  }
});

test("an unchanged daily observation reuses its bundle and does not grow pointer ancestry", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-current-channel-"),
  );
  const channelRoot = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-current-channel-output-"),
  );
  const candidateOutput = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-current-channel-candidate-"),
  );
  try {
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(
      path.join(root, "data", "sources.json"),
      JSON.stringify(currentSourceFixture()),
    );
    const { signer } = await signingFixture();
    const previousBuild = await fixtureBuild(
      NEW_BSDATA_COMMIT,
      "2026-07-30T00:00:00.000Z",
    );
    const previous = await publishSignedDataBundle(
      previousBuild,
      {
        outputRoot: channelRoot,
        channel: "stable",
        publicBaseUrl:
          "https://data.rosterpilot.example",
        signer,
        publishedAt: "2026-07-30T00:01:00.000Z",
      },
    );
    const candidateBuild = await fixtureBuild(
      NEW_BSDATA_COMMIT,
      "2026-07-31T00:00:00.000Z",
    );
    candidateBuild.draft.provenance.official.checkedAt =
      previous.manifest.provenance.official.checkedAt;
    const metadataOnly = await publishSignedDataBundle(
      candidateBuild,
      {
        outputRoot: candidateOutput,
        channel: "stable",
        publicBaseUrl:
          "https://data.rosterpilot.example",
        signer,
        previousManifest: previous.manifest,
        previousChannelPointer: previous.channelPointer,
        publishedAt: "2026-07-31T00:01:00.000Z",
      },
    );
    assert.notEqual(
      metadataOnly.manifest.bundleId,
      previous.manifest.bundleId,
    );
    const pointerPath = path.join(
      channelRoot,
      "channels",
      "stable.json",
    );
    const pointerBefore = readFileSync(pointerPath, "utf8");
    const updatePath = path.join(
      channelRoot,
      "channels",
      "stable.update.json",
    );
    const updateBefore = readFileSync(updatePath, "utf8");
    const historyPath = path.join(
      channelRoot,
      "channels",
      "stable",
    );
    const historyBefore = readdirSync(historyPath).sort();
    let buildCommands = 0;
    let otherCommands = 0;
    const result = await prepareDataBundleUpdate({
      root,
      outputRoot: channelRoot,
      channel: "stable",
      publicBaseUrl: "https://data.rosterpilot.example",
      previousManifest: previous.manifestPath,
      freshness: currentFreshnessFixture(),
      environment: { NODE_ENV: "test" },
      now: () => "2026-07-31T00:00:00.000Z",
      run: (_command, args) => {
        if (args.includes("scripts/build-data-bundle.ts")) {
          buildCommands += 1;
          const outIndex = args.indexOf("--out-dir");
          assert.notEqual(outIndex, -1);
          cpSync(candidateOutput, args[outIndex + 1], {
            recursive: true,
          });
        } else {
          otherCommands += 1;
        }
      },
    });

    assert.equal(result.changed, false);
    assert.equal(result.bundleId, previous.manifest.bundleId);
    assert.equal(result.classification, "provenance-only");
    assert.equal(buildCommands, 1);
    assert.equal(otherCommands, 0);
    assert.equal(readFileSync(pointerPath, "utf8"), pointerBefore);
    assert.equal(readFileSync(updatePath, "utf8"), updateBefore);
    assert.deepEqual(readdirSync(historyPath).sort(), historyBefore);
    assert.equal(
      existsSync(
        path.join(
          channelRoot,
          "bundles",
          metadataOnly.manifest.bundleId,
        ),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(channelRoot, { recursive: true, force: true });
    rmSync(candidateOutput, { recursive: true, force: true });
  }
});
