import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  TesseraImportedArmySemanticSnapshot,
} from "../lib/rosterpilot";
import type {
  TesseraSavedListReuseSide,
} from "../local/tessera/saved-list-reuse";
import {
  createTesseraImportSemanticSnapshotCacheKey,
  loadTesseraImportSemanticSnapshot,
  storeTesseraImportSemanticSnapshot,
  tesseraImportSemanticSnapshotCachePaths,
} from "../local/tessera/semantic-snapshot-cache";

const reuseIdentity: TesseraSavedListReuseSide = {
  runId: "semantic-cache-fixture",
  enrichedRoszSha256: "a".repeat(64),
  scopedProfilePolicySha256: "b".repeat(64),
  profilePolicyEntryKeys: [],
  rosterExecutionFingerprint: "c".repeat(64),
  expectedUnitCount: 2,
};

function semanticSnapshot(
  side: "player" | "opponent" = "player",
): TesseraImportedArmySemanticSnapshot {
  return {
    schemaVersion: 1,
    side,
    armyName: "Fixture army",
    reportedUnitCount: 2,
    units: [
      {
        occurrence: 1,
        name: "Fixture unit",
        modelCount: 5,
        included: true,
        weapons: [
          {
            occurrence: 1,
            name: "Fixture weapon",
            profile: "Focused",
            count: 5,
            visibleCharacteristics: [
              { name: "Strength", value: "6" },
            ],
            effectToggles: [
              { name: "Lethal Hits", state: false },
            ],
          },
        ],
        visibleCharacteristics: [
          { name: "Toughness", value: "5" },
        ],
        effectToggles: [],
      },
    ],
    warningCodes: [],
    alternateProfileResolutions: [],
    completeness: "partial",
    incompleteReasons: ["unit-editor-coverage:1/2"],
  };
}

test("Tessera semantic snapshot receipts round-trip through content-addressed local storage", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-semantic-cache-"),
  );
  try {
    const key = createTesseraImportSemanticSnapshotCacheKey(
      "player",
      reuseIdentity,
    );
    const stored = await storeTesseraImportSemanticSnapshot(
      directory,
      key,
      semanticSnapshot(),
    );
    assert.match(stored.keySha256, /^[0-9a-f]{64}$/);
    assert.match(stored.snapshotSha256, /^[0-9a-f]{64}$/);
    assert.match(stored.receiptSha256, /^[0-9a-f]{64}$/);

    const paths = tesseraImportSemanticSnapshotCachePaths(
      directory,
      key,
      stored.receiptSha256,
    );
    assert.ok(paths.receiptPath?.endsWith(`${stored.receiptSha256}.json`));
    assert.equal(
      JSON.parse(await readFile(paths.pointerPath, "utf8")).receiptSha256,
      stored.receiptSha256,
    );

    const loaded = await loadTesseraImportSemanticSnapshot(
      directory,
      key,
    );
    assert.equal(loaded.status, "hit");
    if (loaded.status === "hit") {
      assert.deepEqual(loaded.snapshot, semanticSnapshot());
      assert.equal(loaded.receiptSha256, stored.receiptSha256);
      assert.equal(loaded.snapshotSha256, stored.snapshotSha256);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Tessera semantic snapshot cache rejects a tampered receipt without returning its snapshot", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-semantic-cache-tamper-"),
  );
  try {
    const key = createTesseraImportSemanticSnapshotCacheKey(
      "player",
      reuseIdentity,
    );
    const stored = await storeTesseraImportSemanticSnapshot(
      directory,
      key,
      semanticSnapshot(),
    );
    const receiptPath = tesseraImportSemanticSnapshotCachePaths(
      directory,
      key,
      stored.receiptSha256,
    ).receiptPath;
    assert.ok(receiptPath);
    const tampered = JSON.parse(await readFile(receiptPath, "utf8"));
    tampered.snapshot.armyName = "Tampered army";
    await writeFile(receiptPath, JSON.stringify(tampered));

    const loaded = await loadTesseraImportSemanticSnapshot(
      directory,
      key,
    );
    assert.deepEqual(loaded, {
      status: "invalid",
      reason: "receipt-integrity-mismatch",
      keySha256: stored.keySha256,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Tessera semantic snapshot cache rejects a valid receipt pointer copied under a mismatched full key", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-semantic-cache-key-"),
  );
  try {
    const originalKey = createTesseraImportSemanticSnapshotCacheKey(
      "player",
      reuseIdentity,
    );
    await storeTesseraImportSemanticSnapshot(
      directory,
      originalKey,
      semanticSnapshot(),
    );
    const mismatchedKey = createTesseraImportSemanticSnapshotCacheKey(
      "player",
      {
        ...reuseIdentity,
        rosterExecutionFingerprint: "d".repeat(64),
      },
    );
    const originalPaths = tesseraImportSemanticSnapshotCachePaths(
      directory,
      originalKey,
    );
    const mismatchedPaths = tesseraImportSemanticSnapshotCachePaths(
      directory,
      mismatchedKey,
    );
    await mkdir(path.dirname(mismatchedPaths.pointerPath), {
      recursive: true,
    });
    await copyFile(
      originalPaths.pointerPath,
      mismatchedPaths.pointerPath,
    );

    const loaded = await loadTesseraImportSemanticSnapshot(
      directory,
      mismatchedKey,
    );
    assert.deepEqual(loaded, {
      status: "invalid",
      reason: "pointer-key-mismatch",
      keySha256: mismatchedPaths.keySha256,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Tessera semantic snapshot cache refuses a snapshot from the other side", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-semantic-cache-side-"),
  );
  try {
    const key = createTesseraImportSemanticSnapshotCacheKey(
      "player",
      reuseIdentity,
    );
    await assert.rejects(
      storeTesseraImportSemanticSnapshot(
        directory,
        key,
        semanticSnapshot("opponent"),
      ),
      /snapshot side does not match/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Tessera semantic snapshot cache rejects a symlinked shard boundary", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-semantic-cache-symlink-"),
  );
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "tessera-semantic-cache-outside-"),
  );
  try {
    const key = createTesseraImportSemanticSnapshotCacheKey(
      "player",
      reuseIdentity,
    );
    const paths = tesseraImportSemanticSnapshotCachePaths(directory, key);
    await mkdir(path.dirname(path.dirname(paths.pointerPath)), {
      recursive: true,
    });
    await symlink(outside, path.dirname(paths.pointerPath));

    await assert.rejects(
      storeTesseraImportSemanticSnapshot(
        directory,
        key,
        semanticSnapshot(),
      ),
      /unsafe directory boundary/i,
    );
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
