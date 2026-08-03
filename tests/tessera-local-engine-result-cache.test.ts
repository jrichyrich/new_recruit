import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalEngineResultCacheKey,
  loadLocalEngineResult,
  LocalEngineResultCacheError,
  localEngineResultCacheKeySha256,
  localEngineResultCachePaths,
  storeLocalEngineResult,
  type LocalEngineResultCacheKeyInput,
} from "../local/tessera/local-engine-result-cache";

const baseKeyInput: LocalEngineResultCacheKeyInput = {
  providerIdentitySha256: "a".repeat(64),
  bundleId: "bundle-fixture-v1",
  bundleManifestSha256: "b".repeat(64),
  playerRosterSha256: "c".repeat(64),
  opponentRosterSha256: "d".repeat(64),
  playerEntityHashesSha256: "6".repeat(64),
  opponentEntityHashesSha256: "7".repeat(64),
  profilePolicySha256: "e".repeat(64),
  scenarioContractSha256: "f".repeat(64),
  iterations: 10_000,
  seed: 42,
  compilerVersion: "fixture-compiler-v1",
  adapterVersion: "fixture-adapter-v1",
};

function cacheKey(overrides: Partial<LocalEngineResultCacheKeyInput> = {}) {
  return createLocalEngineResultCacheKey({
    ...baseKeyInput,
    ...overrides,
  });
}

test("local-engine result cache binds every deterministic execution identity", () => {
  const variants = [
    cacheKey(),
    cacheKey({ providerIdentitySha256: "1".repeat(64) }),
    cacheKey({ bundleId: "bundle-fixture-v2" }),
    cacheKey({ bundleManifestSha256: "2".repeat(64) }),
    cacheKey({ playerRosterSha256: "3".repeat(64) }),
    cacheKey({ opponentRosterSha256: "4".repeat(64) }),
    cacheKey({ playerEntityHashesSha256: "8".repeat(64) }),
    cacheKey({ opponentEntityHashesSha256: "9".repeat(64) }),
    cacheKey({ profilePolicySha256: null }),
    cacheKey({ scenarioContractSha256: "5".repeat(64) }),
    cacheKey({ iterations: 20_000 }),
    cacheKey({ seed: 43 }),
    cacheKey({ compilerVersion: "fixture-compiler-v2" }),
    cacheKey({ adapterVersion: "fixture-adapter-v2" }),
  ];
  assert.equal(
    new Set(variants.map(localEngineResultCacheKeySha256)).size,
    variants.length,
  );
  assert.equal(Object.isFrozen(variants[0]), true);
});

test("local-engine result cache round-trips and reuses verified immutable content", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-local-result-cache-"),
  );
  try {
    const key = cacheKey();
    const result = {
      scenarios: [{ id: "shooting:player-to-opponent", mean: 4.25 }],
      warnings: [],
    };
    const installed = await storeLocalEngineResult(directory, key, result);
    assert.equal(installed.status, "installed");
    assert.match(installed.keySha256, /^[0-9a-f]{64}$/);
    assert.match(installed.receiptSha256, /^[0-9a-f]{64}$/);
    assert.match(installed.resultSha256, /^[0-9a-f]{64}$/);

    const loaded = await loadLocalEngineResult<typeof result>(directory, key);
    assert.equal(loaded.status, "hit");
    if (loaded.status === "hit") {
      assert.deepEqual(loaded.result, result);
      assert.equal(Object.isFrozen(loaded.result), true);
      assert.equal(Object.isFrozen(loaded.result.scenarios), true);
      assert.equal(loaded.resultSha256, installed.resultSha256);
    }

    const reused = await storeLocalEngineResult(directory, key, result);
    assert.equal(reused.status, "reused");
    assert.deepEqual(
      {
        keySha256: reused.keySha256,
        receiptSha256: reused.receiptSha256,
        resultSha256: reused.resultSha256,
      },
      {
        keySha256: installed.keySha256,
        receiptSha256: installed.receiptSha256,
        resultSha256: installed.resultSha256,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-engine result cache rejects tampered result bytes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-local-result-tamper-"),
  );
  try {
    const key = cacheKey();
    const stored = await storeLocalEngineResult(directory, key, {
      value: 1,
    });
    const paths = localEngineResultCachePaths(directory, key, {
      receiptSha256: stored.receiptSha256,
      resultSha256: stored.resultSha256,
    });
    assert.ok(paths.resultPath);
    await chmod(paths.resultPath, 0o600);
    await writeFile(paths.resultPath, '{"value":2}');

    const loaded = await loadLocalEngineResult(directory, key);
    assert.deepEqual(loaded, {
      status: "invalid",
      reason: "result-integrity-mismatch",
      keySha256: stored.keySha256,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-engine result cache rejects a receipt whose bound key was changed", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-local-receipt-tamper-"),
  );
  try {
    const key = cacheKey();
    const stored = await storeLocalEngineResult(directory, key, {
      value: 1,
    });
    const paths = localEngineResultCachePaths(directory, key, {
      receiptSha256: stored.receiptSha256,
    });
    assert.ok(paths.receiptPath);
    const receipt = JSON.parse(await readFile(paths.receiptPath, "utf8"));
    receipt.key.compilerVersion = "tampered-compiler";
    await chmod(paths.receiptPath, 0o600);
    await writeFile(paths.receiptPath, JSON.stringify(receipt));

    const loaded = await loadLocalEngineResult(directory, key);
    assert.deepEqual(loaded, {
      status: "invalid",
      reason: "receipt-integrity-mismatch",
      keySha256: stored.keySha256,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-engine result cache rejects a tampered key pointer", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-local-pointer-tamper-"),
  );
  try {
    const key = cacheKey();
    const stored = await storeLocalEngineResult(directory, key, {
      value: 1,
    });
    const paths = localEngineResultCachePaths(directory, key);
    const pointer = JSON.parse(await readFile(paths.pointerPath, "utf8"));
    pointer.receiptSha256 = "9".repeat(64);
    await chmod(paths.pointerPath, 0o600);
    await writeFile(paths.pointerPath, JSON.stringify(pointer));

    const loaded = await loadLocalEngineResult(directory, key);
    assert.deepEqual(loaded, {
      status: "invalid",
      reason: "pointer-integrity-mismatch",
      keySha256: stored.keySha256,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-engine result cache rejects an incomplete receipt chain", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-local-receipt-missing-"),
  );
  try {
    const key = cacheKey();
    const stored = await storeLocalEngineResult(directory, key, {
      value: 1,
    });
    const paths = localEngineResultCachePaths(directory, key, {
      receiptSha256: stored.receiptSha256,
    });
    assert.ok(paths.receiptPath);
    await rm(paths.receiptPath);

    const loaded = await loadLocalEngineResult(directory, key);
    assert.deepEqual(loaded, {
      status: "invalid",
      reason: "receipt-missing",
      keySha256: stored.keySha256,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-engine result cache refuses conflicting output for one deterministic key", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-local-result-conflict-"),
  );
  try {
    const key = cacheKey();
    await storeLocalEngineResult(directory, key, { value: 1 });
    await assert.rejects(
      storeLocalEngineResult(directory, key, { value: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof LocalEngineResultCacheError);
        assert.equal(error.code, "LOCAL_ENGINE_RESULT_CACHE_CONFLICT");
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-engine result cache serializes concurrent publishers for the same key", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-local-result-concurrent-"),
  );
  try {
    const key = cacheKey();
    const stores = await Promise.all([
      storeLocalEngineResult(directory, key, { value: 1 }),
      storeLocalEngineResult(directory, key, { value: 1 }),
    ]);
    assert.deepEqual(
      stores.map((entry) => entry.status).sort(),
      ["installed", "reused"],
    );
    assert.equal(stores[0].resultSha256, stores[1].resultSha256);
    const loaded = await loadLocalEngineResult(directory, key);
    assert.equal(loaded.status, "hit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
