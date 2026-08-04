import assert from "node:assert/strict";
import {
  cp,
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
  EXPECTED_TESSERA_ENGINE_PROVENANCE,
  verifyTesseraEngineProvenance,
} from "../scripts/verify-tessera-engine-provenance.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("the Tessera engine candidate is immutable, development-only, and reproducible", async () => {
  const result = await verifyTesseraEngineProvenance({
    root: projectRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "evaluation-only");
  assert.equal(
    result.promotionGate,
    "personal-machine-parity-attestation-required",
  );
  assert.equal(
    result.commit,
    EXPECTED_TESSERA_ENGINE_PROVENANCE.upstream.commit,
  );
  assert.equal(
    result.tree,
    EXPECTED_TESSERA_ENGINE_PROVENANCE.upstream.tree,
  );
  assert.equal(
    result.integrity,
    EXPECTED_TESSERA_ENGINE_PROVENANCE.upstream.archiveIntegrity,
  );
  assert.deepEqual(result.package, {
    name: "tessera-engine",
    version: "1.0.0",
    license: "AGPL-3.0-only",
    developmentOnly: true,
  });
  assert.deepEqual(result.smoke, {
    requiredExports: [
      "cumulativeAtLeast",
      "makeRng",
      "runSimulation",
    ],
    seed: 0x1234abcd,
    iterations: 64,
    killsMean: 2.08,
    woundsMean: 2.08,
    mortalWoundsMean: 0,
  });
});

test("the Tessera engine verifier rejects lockfile provenance drift", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-provenance-"),
  );
  try {
    await mkdir(path.join(fixtureRoot, "local", "tessera"), {
      recursive: true,
    });
    await mkdir(path.join(fixtureRoot, "node_modules"), {
      recursive: true,
    });
    await cp(
      path.join(
        projectRoot,
        "local",
        "tessera",
        "tessera-engine-provenance.json",
      ),
      path.join(
        fixtureRoot,
        "local",
        "tessera",
        "tessera-engine-provenance.json",
      ),
    );
    await cp(
      path.join(projectRoot, "package.json"),
      path.join(fixtureRoot, "package.json"),
    );
    await cp(
      path.join(projectRoot, "node_modules", "tessera-engine"),
      path.join(fixtureRoot, "node_modules", "tessera-engine"),
      { recursive: true },
    );

    const lock = JSON.parse(
      await readFile(
        path.join(projectRoot, "package-lock.json"),
        "utf8",
      ),
    ) as {
      packages: Record<string, Record<string, unknown>>;
    };
    lock.packages["node_modules/tessera-engine"].integrity =
      "sha512-tampered";
    await writeFile(
      path.join(fixtureRoot, "package-lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`,
    );

    await assert.rejects(
      verifyTesseraEngineProvenance({ root: fixtureRoot }),
      /lockfile integrity does not match the reviewed archive/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("the Tessera engine verifier rejects archive-byte drift", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-archive-"),
  );
  try {
    const archivePath = path.join(fixtureRoot, "candidate.tar.gz");
    await writeFile(archivePath, "not the reviewed archive");
    await assert.rejects(
      verifyTesseraEngineProvenance({
        root: projectRoot,
        archivePath,
      }),
      /archive SHA-256 does not match the reviewed codeload bytes/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
