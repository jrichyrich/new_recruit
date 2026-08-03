import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkDataPublisherConfig } from "../scripts/check-data-publisher-config";

test("publisher configuration requires the private key to match the reviewed public registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publisher-config-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const exportedPublic = publicKey.export({ format: "jwk" });
  const registryPath = path.join(root, "trusted-keys.json");
  await writeFile(
    registryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      keys: [
        {
          keyId: "release-fixture",
          publicKey: {
            kty: "OKP",
            crv: "Ed25519",
            x: exportedPublic.x,
            key_ops: ["verify"],
            ext: true,
          },
        },
      ],
    })}\n`,
  );
  const previousId = process.env.ROSTERPILOT_DATA_SIGNING_KEY_ID;
  const previousJwk = process.env.ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK;
  try {
    process.env.ROSTERPILOT_DATA_SIGNING_KEY_ID = "release-fixture";
    process.env.ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK =
      JSON.stringify(privateJwk);
    const result = await checkDataPublisherConfig(registryPath);
    assert.equal(result.keyId, "release-fixture");

    process.env.ROSTERPILOT_DATA_SIGNING_KEY_ID = "unreviewed-key";
    await assert.rejects(
      () => checkDataPublisherConfig(registryPath),
      /one-time "Bootstrap signed roster data" workflow/i,
    );
  } finally {
    if (previousId === undefined) {
      delete process.env.ROSTERPILOT_DATA_SIGNING_KEY_ID;
    } else {
      process.env.ROSTERPILOT_DATA_SIGNING_KEY_ID = previousId;
    }
    if (previousJwk === undefined) {
      delete process.env.ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK;
    } else {
      process.env.ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK = previousJwk;
    }
  }
});

test("GitHub workflows bootstrap trust once and preflight every routine publication", async () => {
  const bootstrap = await readFile(
    ".github/workflows/data-bundle-bootstrap.yml",
    "utf8",
  );
  const freshness = await readFile(
    ".github/workflows/data-freshness.yml",
    "utf8",
  );
  assert.match(bootstrap, /data:bundle:prepare-release/);
  assert.match(bootstrap, /data:bundle:verify-release/);
  assert.match(bootstrap, /gh pr create/);
  assert.match(
    bootstrap,
    /ROSTERPILOT_OFFICIAL_AUTHORITY_UNAVAILABLE_REASON/,
  );
  assert.match(freshness, /data:publisher:check/);
  assert.match(freshness, /data\/bootstrap-data-bundle\/\*\*/);
});
