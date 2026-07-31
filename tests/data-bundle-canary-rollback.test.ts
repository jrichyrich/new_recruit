import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSignedDataBundleChannelPointer,
  createSignedDataBundleManifest,
  dataBundleChannelPointerSha256,
  dataBundleSemanticIdentitySha256,
  verifyDataBundleChannelPointer,
  verifyDataBundleQuarantineRecord,
  type DataBundleManifestDraftV1,
  type DataBundleManifestV1,
  type DataBundleShardV1,
  type DataBundleSigner,
} from "../lib/rosterpilot/data-bundle";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
} from "../lib/rosterpilot/semantic-hash";
import {
  LIVE_CANARY_IDS,
} from "../local/certification/live-canaries";
import {
  rollbackDataBundleAfterCanary,
} from "../scripts/rollback-data-bundle-after-canary";

const digest = (character: string): string =>
  character.repeat(64);

async function keyFixture() {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  return {
    signer: {
      keyId: "release-test",
      privateKey: pair.privateKey,
    } satisfies DataBundleSigner,
    trustedKeys: {
      "release-test": pair.publicKey,
    },
  };
}

async function signedBundle(
  signer: DataBundleSigner,
  marker: string,
  createdAt: string,
): Promise<{
  manifest: DataBundleManifestV1;
  shard: DataBundleShardV1;
}> {
  const shard: DataBundleShardV1 = {
    schemaVersion: 1,
    shardId: "global",
    kind: "global",
    factionIds: [],
    data: { marker },
  };
  const draft: DataBundleManifestDraftV1 = {
    schemaVersion: 1,
    engineDataSchemaVersion: 1,
    createdAt,
    provenance: {
      official: {
        authority: "games-workshop",
        version: marker,
        contentSha256: digest("1"),
        downloadsUrl:
          "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
        checkedAt: createdAt,
      },
      rules: {
        provider: "40kdc-data",
        package: "@alpaca-software/40kdc-data",
        version: marker,
        sourceSha256: digest("2"),
        edition: "11",
        dataslate: marker,
      },
      newRecruit: {
        provider: "bsdata",
        repository: "BSData/wh40k-11e",
        branch: "main",
        commit: marker.repeat(40).slice(0, 40),
      },
    },
    semanticHashes: {
      globalHash: digest(marker),
      methodologyHash: digest("3"),
      factions: {},
    },
    shards: [
      {
        shardId: "global",
        kind: "global",
        factionIds: [],
        dependencyShardIds: [],
        path: "shards/global.json",
        contentSha256: await sha256Hex(canonicalJson(shard)),
        semanticHash: await semanticHash(shard.data),
        byteLength: new TextEncoder().encode(
          canonicalJson(shard),
        ).byteLength,
        mediaType:
          "application/vnd.rosterpilot.data-shard+json",
      },
    ],
  };
  return {
    manifest: await createSignedDataBundleManifest(
      draft,
      signer,
    ),
    shard,
  };
}

async function writeBundle(
  root: string,
  bundle: Awaited<ReturnType<typeof signedBundle>>,
): Promise<void> {
  const directory = path.join(
    root,
    "bundles",
    bundle.manifest.bundleId,
  );
  await mkdir(path.join(directory, "shards"), {
    recursive: true,
  });
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(bundle.manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, "shards", "global.json"),
    `${JSON.stringify(bundle.shard, null, 2)}\n`,
  );
}

async function writeV2Publication(
  root: string,
  signer: DataBundleSigner,
  previousBundleId: string,
  currentBundleId: string,
): Promise<{
  previousPointer: Awaited<
    ReturnType<typeof createSignedDataBundleChannelPointer>
  >;
  currentPointer: Awaited<
    ReturnType<typeof createSignedDataBundleChannelPointer>
  >;
  currentPointerSha256: string;
}> {
  const baseUrl = "https://example.test/data";
  const previousPointer =
    await createSignedDataBundleChannelPointer(
      {
        schemaVersion: 2,
        channel: "stable",
        bundleId: previousBundleId,
        manifestUrl:
          `${baseUrl}/bundles/${previousBundleId}/manifest.json`,
        publishedAt: "2026-07-30T00:01:00.000Z",
        revision: 0,
        previous: null,
        transition: {
          kind: "publish",
          fromBundleId: null,
        },
      },
      signer,
    );
  const previousPointerSha256 =
    await dataBundleChannelPointerSha256(previousPointer);
  const currentPointer =
    await createSignedDataBundleChannelPointer(
      {
        schemaVersion: 2,
        channel: "stable",
        bundleId: currentBundleId,
        manifestUrl:
          `${baseUrl}/bundles/${currentBundleId}/manifest.json`,
        publishedAt: "2026-07-31T00:01:00.000Z",
        revision: 1,
        previous: {
          pointerSha256: previousPointerSha256,
          pointerUrl:
            `${baseUrl}/channels/stable/${previousPointerSha256}.json`,
        },
        transition: {
          kind: "publish",
          fromBundleId: previousBundleId,
        },
      },
      signer,
    );
  const currentPointerSha256 =
    await dataBundleChannelPointerSha256(currentPointer);
  const history = path.join(root, "channels", "stable");
  await mkdir(history, { recursive: true });
  await writeFile(
    path.join(history, `${previousPointerSha256}.json`),
    `${JSON.stringify(previousPointer, null, 2)}\n`,
  );
  await writeFile(
    path.join(history, `${currentPointerSha256}.json`),
    `${JSON.stringify(currentPointer, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "channels", "stable.json"),
    `${JSON.stringify(currentPointer, null, 2)}\n`,
  );
  return {
    previousPointer,
    currentPointer,
    currentPointerSha256,
  };
}

async function writeCanaryReports(
  directory: string,
  bundleId: string,
  failedCanary:
    | (typeof LIVE_CANARY_IDS)[number]
    | null,
  unavailableCanary:
    | (typeof LIVE_CANARY_IDS)[number]
    | null = null,
  releaseEvidenceKind: "bundle-bound" | "ad-hoc" =
    "bundle-bound",
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const canaryId of LIVE_CANARY_IDS) {
    const status =
      canaryId === unavailableCanary
        ? "unavailable"
        : canaryId === failedCanary
          ? "fail"
          : "pass";
    const report = {
      reportKind: "rosterpilot-rotating-live-canary",
      canary: { id: canaryId },
      status,
      livePass: status === "pass",
      evidenceKind:
        status === "unavailable" ? "none" : "live",
      releaseEvidence: {
        kind: releaseEvidenceKind,
        expectedBundleId:
          releaseEvidenceKind === "bundle-bound"
            ? bundleId
            : null,
      },
      dataBundle: { bundleId },
    };
    const filename = path.join(
      directory,
      `live-canary-${canaryId}.json`,
    );
    const content = `${JSON.stringify(report, null, 2)}\n`;
    const checksum = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");
    await writeFile(filename, content);
    await writeFile(
      `${filename}.sha256`,
      `${checksum}  ${path.basename(filename)}\n`,
    );
  }
}

test("failed bundle-bound live canary evidence uses signed v2 ancestry and ignores a tampered update receipt", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-canary-rollback-"),
  );
  try {
    const { signer, trustedKeys } = await keyFixture();
    const previous = await signedBundle(
      signer,
      "a",
      "2026-07-30T00:00:00.000Z",
    );
    const failed = await signedBundle(
      signer,
      "b",
      "2026-07-31T00:00:00.000Z",
    );
    await writeBundle(root, previous);
    await writeBundle(root, failed);
    await writeV2Publication(
      root,
      signer,
      previous.manifest.bundleId,
      failed.manifest.bundleId,
    );
    await writeFile(
      path.join(root, "channels", "stable.update.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          previousBundleId: digest("f"),
          candidateBundleId: failed.manifest.bundleId,
        },
        null,
        2,
      )}\n`,
    );
    const reports = path.join(root, "reports");
    await writeCanaryReports(
      reports,
      failed.manifest.bundleId,
      "death-guard-vs-orks-exact-1000",
    );

    const result = await rollbackDataBundleAfterCanary({
      channelRoot: root,
      reportsRoot: reports,
      channel: "stable",
      failedBundleId: failed.manifest.bundleId,
      manifestBaseUrl: "https://example.test/data",
      signer,
      trustedKeys,
      now: () => new Date("2026-07-31T02:00:00.000Z"),
    });
    assert.equal(result.action, "rolled-back");
    assert.equal(
      result.rollbackBundleId,
      previous.manifest.bundleId,
    );
    assert.equal(
      result.quarantineRelativePath,
      `quarantines/${failed.manifest.bundleId}.json`,
    );
    assert.match(
      result.quarantineRecordSha256 ?? "",
      /^[a-f0-9]{64}$/,
    );

    const rolledBackPointer =
      await verifyDataBundleChannelPointer(
        JSON.parse(
          await readFile(
            path.join(root, "channels", "stable.json"),
            "utf8",
          ),
        ),
        trustedKeys,
      );
    assert.equal(rolledBackPointer.ok, true);
    if (!rolledBackPointer.ok) return;
    assert.equal(
      rolledBackPointer.data.bundleId,
      previous.manifest.bundleId,
    );
    assert.equal(rolledBackPointer.data.schemaVersion, 2);
    if (rolledBackPointer.data.schemaVersion === 2) {
      assert.equal(rolledBackPointer.data.revision, 2);
      assert.equal(
        rolledBackPointer.data.transition.kind,
        "rollback",
      );
      assert.equal(
        rolledBackPointer.data.transition.kind === "rollback"
          ? rolledBackPointer.data.transition.fromBundleId
          : null,
        failed.manifest.bundleId,
      );
    }

    const quarantine =
      await verifyDataBundleQuarantineRecord(
        JSON.parse(
          await readFile(result.quarantinePath!, "utf8"),
        ),
        trustedKeys,
      );
    assert.equal(quarantine.ok, true);
    if (!quarantine.ok) return;
    assert.equal(
      quarantine.data.semanticIdentitySha256,
      await dataBundleSemanticIdentitySha256(
        failed.manifest,
      ),
    );
    assert.deepEqual(
      quarantine.data.evidence
        .filter((entry) => entry.status === "fail")
        .map((entry) => entry.canaryId),
      ["death-guard-vs-orks-exact-1000"],
    );
    assert.equal(
      result.quarantineRecordSha256,
      await sha256Hex(canonicalJson(quarantine.data)),
    );

    const retried = await rollbackDataBundleAfterCanary({
      channelRoot: root,
      reportsRoot: reports,
      channel: "stable",
      failedBundleId: failed.manifest.bundleId,
      manifestBaseUrl: "https://example.test/data",
      signer,
      trustedKeys,
    });
    assert.equal(retried.action, "already-rolled-back");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered signed ancestry and legacy receipt-only rollback fail closed", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-canary-ancestry-tamper-"),
  );
  try {
    const { signer, trustedKeys } = await keyFixture();
    const previous = await signedBundle(
      signer,
      "a",
      "2026-07-30T00:00:00.000Z",
    );
    const failed = await signedBundle(
      signer,
      "b",
      "2026-07-31T00:00:00.000Z",
    );
    await writeBundle(root, previous);
    await writeBundle(root, failed);
    const { previousPointer, currentPointer } =
      await writeV2Publication(
        root,
        signer,
        previous.manifest.bundleId,
        failed.manifest.bundleId,
      );
    assert.equal(currentPointer.schemaVersion, 2);
    if (
      currentPointer.schemaVersion !== 2 ||
      !currentPointer.previous
    ) {
      return;
    }
    const pointerPath = path.join(
      root,
      "channels",
      "stable.json",
    );
    const pointerBefore = await readFile(pointerPath, "utf8");
    const predecessorPath = path.join(
      root,
      "channels",
      "stable",
      `${currentPointer.previous.pointerSha256}.json`,
    );
    const tamperedPredecessor = JSON.parse(
      await readFile(predecessorPath, "utf8"),
    );
    tamperedPredecessor.publishedAt =
      "2026-07-29T00:01:00.000Z";
    await writeFile(
      predecessorPath,
      `${JSON.stringify(tamperedPredecessor, null, 2)}\n`,
    );
    await writeFile(
      path.join(root, "channels", "stable.update.json"),
      `${JSON.stringify({
        previousBundleId: previous.manifest.bundleId,
        candidateBundleId: failed.manifest.bundleId,
      })}\n`,
    );
    const reports = path.join(root, "reports");
    await writeCanaryReports(
      reports,
      failed.manifest.bundleId,
      "death-guard-vs-orks-exact-1000",
    );
    await assert.rejects(
      rollbackDataBundleAfterCanary({
        channelRoot: root,
        reportsRoot: reports,
        channel: "stable",
        failedBundleId: failed.manifest.bundleId,
        manifestBaseUrl: "https://example.test/data",
        signer,
        trustedKeys,
      }),
      /predecessor verification failed/,
    );
    assert.equal(await readFile(pointerPath, "utf8"), pointerBefore);

    const legacyPointer =
      await createSignedDataBundleChannelPointer(
        {
          schemaVersion: 1,
          channel: "stable",
          bundleId: failed.manifest.bundleId,
          manifestUrl:
            `https://example.test/data/bundles/${failed.manifest.bundleId}/manifest.json`,
          publishedAt: "2026-07-31T00:01:00.000Z",
        },
        signer,
      );
    const legacyContent =
      `${JSON.stringify(legacyPointer, null, 2)}\n`;
    await writeFile(pointerPath, legacyContent);
    await assert.rejects(
      rollbackDataBundleAfterCanary({
        channelRoot: root,
        reportsRoot: reports,
        channel: "stable",
        failedBundleId: failed.manifest.bundleId,
        manifestBaseUrl: "https://example.test/data",
        signer,
        trustedKeys,
      }),
      /signed v2 channel transition.*unsigned update receipts/,
    );
    assert.equal(await readFile(pointerPath, "utf8"), legacyContent);

    const previousPointerSha256 =
      await dataBundleChannelPointerSha256(previousPointer);
    await writeFile(
      path.join(
        root,
        "channels",
        "stable",
        `${previousPointerSha256}.json`,
      ),
      `${JSON.stringify(previousPointer, null, 2)}\n`,
    );
    const failedRollbackPointer =
      await createSignedDataBundleChannelPointer(
        {
          schemaVersion: 2,
          channel: "stable",
          bundleId: failed.manifest.bundleId,
          manifestUrl:
            `https://example.test/data/bundles/${failed.manifest.bundleId}/manifest.json`,
          publishedAt: "2026-07-31T00:01:00.000Z",
          revision: 1,
          previous: {
            pointerSha256: previousPointerSha256,
            pointerUrl:
              `https://example.test/data/channels/stable/${previousPointerSha256}.json`,
          },
          transition: {
            kind: "rollback",
            fromBundleId: previous.manifest.bundleId,
            reasonCode: "LIVE_CANARY_FAILED",
            quarantineRecordSha256: digest("e"),
          },
        },
        signer,
      );
    const failedRollbackContent =
      `${JSON.stringify(failedRollbackPointer, null, 2)}\n`;
    await writeFile(pointerPath, failedRollbackContent);
    await assert.rejects(
      rollbackDataBundleAfterCanary({
        channelRoot: root,
        reportsRoot: reports,
        channel: "stable",
        failedBundleId: failed.manifest.bundleId,
        manifestBaseUrl: "https://example.test/data",
        signer,
        trustedKeys,
      }),
      /failed bundle.*publication transition.*operator intervention/,
    );
    assert.equal(
      await readFile(pointerPath, "utf8"),
      failedRollbackContent,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passing canaries and tampered evidence cannot move a signed channel", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-canary-no-rollback-"),
  );
  try {
    const { signer, trustedKeys } = await keyFixture();
    const previous = await signedBundle(
      signer,
      "a",
      "2026-07-30T00:00:00.000Z",
    );
    const current = await signedBundle(
      signer,
      "b",
      "2026-07-31T00:00:00.000Z",
    );
    await writeBundle(root, previous);
    await writeBundle(root, current);
    const { currentPointer: pointer } =
      await writeV2Publication(
        root,
        signer,
        previous.manifest.bundleId,
        current.manifest.bundleId,
      );
    const pointerPath = path.join(
      root,
      "channels",
      "stable.json",
    );
    const pointerContent = `${JSON.stringify(pointer, null, 2)}\n`;
    await writeFile(
      path.join(root, "channels", "stable.update.json"),
      `${JSON.stringify({
        previousBundleId: previous.manifest.bundleId,
        candidateBundleId: current.manifest.bundleId,
      })}\n`,
    );
    const reports = path.join(root, "reports");
    await writeCanaryReports(
      reports,
      current.manifest.bundleId,
      null,
    );
    const noChange = await rollbackDataBundleAfterCanary({
      channelRoot: root,
      reportsRoot: reports,
      channel: "stable",
      failedBundleId: current.manifest.bundleId,
      manifestBaseUrl: "https://example.test/data",
      signer,
      trustedKeys,
    });
    assert.equal(noChange.action, "none");
    assert.equal(await readFile(pointerPath, "utf8"), pointerContent);

    await writeCanaryReports(
      reports,
      current.manifest.bundleId,
      "death-guard-vs-orks-exact-1000",
      "uploaded-multiprofile-exact-paired-revision",
    );
    await assert.rejects(
      rollbackDataBundleAfterCanary({
        channelRoot: root,
        reportsRoot: reports,
        channel: "stable",
        failedBundleId: current.manifest.bundleId,
        manifestBaseUrl: "https://example.test/data",
        signer,
        trustedKeys,
      }),
      /automatic release rollback requires complete live evidence/,
    );
    assert.equal(await readFile(pointerPath, "utf8"), pointerContent);

    await writeCanaryReports(
      reports,
      current.manifest.bundleId,
      "death-guard-vs-orks-exact-1000",
      null,
      "ad-hoc",
    );
    await assert.rejects(
      rollbackDataBundleAfterCanary({
        channelRoot: root,
        reportsRoot: reports,
        channel: "stable",
        failedBundleId: current.manifest.bundleId,
        manifestBaseUrl: "https://example.test/data",
        signer,
        trustedKeys,
      }),
      /ad-hoc evidence.*exact bundle binding/,
    );
    assert.equal(await readFile(pointerPath, "utf8"), pointerContent);

    await writeCanaryReports(
      reports,
      current.manifest.bundleId,
      null,
    );

    const tampered = path.join(
      reports,
      `live-canary-${LIVE_CANARY_IDS[0]}.json`,
    );
    await writeFile(
      tampered,
      `${await readFile(tampered, "utf8")} `,
    );
    await assert.rejects(
      rollbackDataBundleAfterCanary({
        channelRoot: root,
        reportsRoot: reports,
        channel: "stable",
        failedBundleId: current.manifest.bundleId,
        manifestBaseUrl: "https://example.test/data",
        signer,
        trustedKeys,
      }),
      /checksum verification failed/,
    );
    assert.equal(await readFile(pointerPath, "utf8"), pointerContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
