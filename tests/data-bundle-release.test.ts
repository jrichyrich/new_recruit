import assert from "node:assert/strict";
import {
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
  verifyRuntimeDataBundle,
  buildRuntimeDataBundle,
  type RuntimeDataBundleBuild,
} from "../lib/rosterpilot/runtime-data-bundle";
import type {
  DataBundleSigner,
} from "../lib/rosterpilot/data-bundle";
import {
  DATA_BUNDLE_RELEASE_USAGE,
  deriveVerifiedEd25519PublicJwk,
  parseTrustedDataBundleKeyRegistry,
  prepareSignedBootstrapDataBundle,
  recoverInterruptedDataBundleRelease,
  runPrepareDataBundleReleaseCli,
} from "../scripts/prepare-data-bundle-release";
import {
  verifyDataBundleRelease,
} from "../scripts/verify-data-bundle-release";

async function signingFixture(
  keyId: string,
): Promise<{
  pair: CryptoKeyPair;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
  signer: DataBundleSigner;
}> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const [privateJwk, publicJwk] = await Promise.all([
    globalThis.crypto.subtle.exportKey("jwk", pair.privateKey),
    globalThis.crypto.subtle.exportKey("jwk", pair.publicKey),
  ]);
  return {
    pair,
    privateJwk,
    publicJwk,
    signer: {
      keyId,
      privateKey: privateJwk,
    },
  };
}

let runtimeBuild: Promise<RuntimeDataBundleBuild> | null = null;

function releaseBuild(): Promise<RuntimeDataBundleBuild> {
  runtimeBuild ??= buildRuntimeDataBundle({
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
    createdAt: "2026-07-31T06:00:00.000Z",
  });
  return runtimeBuild;
}

function readBootstrap(directory: string): {
  manifest: unknown;
  shards: unknown[];
} {
  const manifest = JSON.parse(
    readFileSync(path.join(directory, "manifest.json"), "utf8"),
  ) as {
    shards: Array<{ path: string }>;
  };
  return {
    manifest,
    shards: manifest.shards.map((descriptor) =>
      JSON.parse(
        readFileSync(
          path.join(
            directory,
            ...descriptor.path.split("/"),
          ),
          "utf8",
        ),
      ),
    ),
  };
}

function allFileContents(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory()
        ? allFileContents(filename)
        : readFileSync(filename, "utf8");
    })
    .join("\n");
}

test("release key derivation proves the public key matches without exposing private material", async () => {
  const first = await signingFixture("release-2026");
  const publicKey = await deriveVerifiedEd25519PublicJwk(
    first.signer,
  );
  assert.equal(publicKey.kty, "OKP");
  assert.equal(publicKey.crv, "Ed25519");
  assert.equal(publicKey.x, first.publicJwk.x);
  assert.equal("d" in publicKey, false);
  assert.deepEqual(publicKey.key_ops, ["verify"]);

  const second = await signingFixture("release-2026");
  await assert.rejects(
    deriveVerifiedEd25519PublicJwk({
      keyId: "release-2026",
      privateKey: {
        ...first.privateJwk,
        x: second.publicJwk.x,
      },
    }),
    /do not match|not an importable Ed25519 private JWK/,
  );
});

test("release preparation writes a verified bootstrap and additive rotation registry", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-release-bootstrap-"),
  );
  try {
    const previous = await signingFixture("release-2025");
    const current = await signingFixture("release-2026");
    const registryFile = path.join(
      root,
      "data",
      "data-bundle-trusted-keys.json",
    );
    mkdirSync(path.dirname(registryFile), { recursive: true });
    writeFileSync(
      registryFile,
      `${JSON.stringify({
        schemaVersion: 1,
        keys: [
          {
            keyId: "release-2025",
            publicKey: {
              kty: "OKP",
              crv: "Ed25519",
              x: previous.publicJwk.x,
              key_ops: ["verify"],
              ext: true,
            },
          },
        ],
      })}\n`,
    );
    const outputDirectory = path.join(
      root,
      "data",
      "bootstrap-data-bundle",
    );

    const prepared = await prepareSignedBootstrapDataBundle(
      await releaseBuild(),
      {
        root,
        outputDirectory,
        trustedKeysFile: registryFile,
        signer: current.signer,
        officialAuthorityUnavailableReason:
          "No reviewed official extraction evidence was supplied.",
      },
    );
    const registry = parseTrustedDataBundleKeyRegistry(
      JSON.parse(readFileSync(registryFile, "utf8")),
    );
    assert.deepEqual(
      registry.keys.map((entry) => entry.keyId),
      ["release-2025", "release-2026"],
    );
    assert.equal(
      registry.keys[0].publicKey.x,
      previous.publicJwk.x,
    );
    assert.equal(
      registry.keys[1].publicKey.x,
      current.publicJwk.x,
    );
    assert.equal(
      registry.keys.some((entry) => "d" in entry.publicKey),
      false,
    );

    const bootstrap = readBootstrap(outputDirectory);
    const verified = await verifyRuntimeDataBundle({
      ...bootstrap,
      trustedKeys: Object.fromEntries(
        registry.keys.map((entry) => [
          entry.keyId,
          entry.publicKey,
        ]),
      ),
    });
    if (!verified.ok) assert.fail(verified.message);
    assert.equal(verified.ok, true);
    assert.equal(verified.data.bundleId, prepared.bundleId);
    assert.equal(
      verified.data.manifest.signature.keyId,
      "release-2026",
    );
    const releaseVerification = await verifyDataBundleRelease({
      root,
    });
    assert.equal(
      releaseVerification.bundleId,
      prepared.bundleId,
    );
    assert.equal(
      releaseVerification.signingKeyId,
      "release-2026",
    );
    assert.equal(
      existsSync(
        path.join(
          root,
          "public",
          "data-bundles",
          "bootstrap",
          "manifest.json",
        ),
      ),
      true,
    );

    const serializedOutput = allFileContents(root);
    assert.equal(
      serializedOutput.includes(current.privateJwk.d!),
      false,
    );
    assert.equal(
      JSON.stringify(prepared).includes(current.privateJwk.d!),
      false,
    );

    const repeated = await prepareSignedBootstrapDataBundle(
      await releaseBuild(),
      {
        root,
        outputDirectory,
        trustedKeysFile: registryFile,
        signer: current.signer,
        officialAuthorityUnavailableReason:
          "No reviewed official extraction evidence was supplied.",
      },
    );
    assert.equal(repeated.bundleId, prepared.bundleId);
    assert.deepEqual(repeated.trustedKeyIds, [
      "release-2025",
      "release-2026",
    ]);

    const hostedManifest = path.join(
      root,
      "public",
      "data-bundles",
      "bootstrap",
      "manifest.json",
    );
    const tampered = JSON.parse(
      readFileSync(hostedManifest, "utf8"),
    ) as Record<string, unknown>;
    tampered.createdAt = "2027-01-01T00:00:00.000Z";
    writeFileSync(hostedManifest, `${JSON.stringify(tampered)}\n`);
    await assert.rejects(
      verifyDataBundleRelease({ root }),
      /local and hosted signed bootstrap bundles differ/,
    );
    (
      tampered.shards as Array<{ path: string }>
    )[0].path = "../../outside.json";
    writeFileSync(hostedManifest, `${JSON.stringify(tampered)}\n`);
    await assert.rejects(
      verifyDataBundleRelease({ root }),
      /shard path escapes its directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release preparation cannot sign official overrides without reviewed source evidence", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-release-official-gate-"),
  );
  try {
    const release = await signingFixture("release-official-gate");
    const registryFile = path.join(
      root,
      "data",
      "data-bundle-trusted-keys.json",
    );
    mkdirSync(path.dirname(registryFile), { recursive: true });
    writeFileSync(
      registryFile,
      '{"schemaVersion":1,"keys":[]}\n',
    );
    const build = structuredClone(await releaseBuild());
    build.officialReconciliation = {
      overlayHash: "a".repeat(64),
      affectedFactions: ["adeptus-custodes"],
      conflicts: [],
    };
    await assert.rejects(
      prepareSignedBootstrapDataBundle(build, {
        root,
        outputDirectory: path.join(root, "bootstrap"),
        trustedKeysFile: registryFile,
        hostedAssetsDirectory: path.join(root, "hosted"),
        signer: release.signer,
      }),
      /official overrides requires the exact source artifact.*reviewed extractor/i,
    );
    assert.equal(existsSync(path.join(root, "bootstrap")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an initial trusted bootstrap cannot silently claim official provenance", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-release-initial-authority-"),
  );
  try {
    const release = await signingFixture("release-initial-authority");
    const registryFile = path.join(root, "trusted-keys.json");
    writeFileSync(
      registryFile,
      '{"schemaVersion":1,"keys":[]}\n',
    );
    await assert.rejects(
      prepareSignedBootstrapDataBundle(await releaseBuild(), {
        root,
        outputDirectory: path.join(root, "bootstrap"),
        trustedKeysFile: registryFile,
        hostedAssetsDirectory: path.join(root, "hosted"),
        signer: release.signer,
      }),
      /first trusted application bootstrap requires reviewed official extraction evidence/i,
    );
    assert.equal(existsSync(path.join(root, "bootstrap")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release transaction recovery completes a staged directory swap after interruption", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-release-recovery-"),
  );
  try {
    const destination = path.join(root, "data", "bootstrap");
    const staged = path.join(
      root,
      "data",
      ".bootstrap.next-fixture",
    );
    const backup = `${destination}.previous-release-0`;
    mkdirSync(destination, { recursive: true });
    mkdirSync(staged, { recursive: true });
    writeFileSync(path.join(destination, "identity"), "old\n");
    writeFileSync(path.join(staged, "identity"), "new\n");
    writeFileSync(
      path.join(
        root,
        ".rosterpilot-data-bundle-release-transaction.json",
      ),
      `${JSON.stringify({
        schemaVersion: 1,
        transactionKind: "rosterpilot-data-bundle-release",
        targets: [{ destination, staged, backup }],
      })}\n`,
    );

    assert.equal(
      recoverInterruptedDataBundleRelease(root),
      true,
    );
    assert.equal(
      readFileSync(path.join(destination, "identity"), "utf8"),
      "new\n",
    );
    assert.equal(existsSync(staged), false);
    assert.equal(existsSync(backup), false);
    assert.equal(
      existsSync(
        path.join(
          root,
          ".rosterpilot-data-bundle-release-transaction.json",
        ),
      ),
      false,
    );
    assert.equal(
      recoverInterruptedDataBundleRelease(root),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release recovery rejects a forged journal before touching unrelated paths", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-release-forged-journal-"),
  );
  try {
    const destination = path.join(root, "data", "bootstrap");
    const staged = path.join(
      root,
      "data",
      ".bootstrap.next-fixture",
    );
    const unrelated = path.join(root, "unrelated-user-data");
    mkdirSync(destination, { recursive: true });
    mkdirSync(staged, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(path.join(unrelated, "keep"), "keep\n");
    writeFileSync(
      path.join(
        root,
        ".rosterpilot-data-bundle-release-transaction.json",
      ),
      `${JSON.stringify({
        schemaVersion: 1,
        transactionKind: "rosterpilot-data-bundle-release",
        targets: [
          { destination, staged, backup: unrelated },
        ],
      })}\n`,
    );

    assert.throws(
      () => recoverInterruptedDataBundleRelease(root),
      /unsafe target paths/,
    );
    assert.equal(
      readFileSync(path.join(unrelated, "keep"), "utf8"),
      "keep\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release preparation refuses to replace public material under an existing key id", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-release-conflict-"),
  );
  try {
    const previous = await signingFixture("release-2026");
    const replacement = await signingFixture("release-2026");
    const registryFile = path.join(root, "trusted-keys.json");
    const original = `${JSON.stringify({
      schemaVersion: 1,
      keys: [
        {
          keyId: "release-2026",
          publicKey: {
            kty: "OKP",
            crv: "Ed25519",
            x: previous.publicJwk.x,
            key_ops: ["verify"],
            ext: true,
          },
        },
      ],
    })}\n`;
    writeFileSync(registryFile, original);
    const outputDirectory = path.join(root, "bootstrap");

    await assert.rejects(
      prepareSignedBootstrapDataBundle(
        await releaseBuild(),
        {
          root,
          outputDirectory,
          trustedKeysFile: registryFile,
          signer: replacement.signer,
          officialAuthorityUnavailableReason:
            "No reviewed official extraction evidence was supplied.",
        },
      ),
      /already identifies different public key material/,
    );
    assert.equal(readFileSync(registryFile, "utf8"), original);
    assert.equal(existsSync(outputDirectory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release CLI help is secret-free and a CI-env run emits only public identifiers", async () => {
  let help = "";
  await runPrepareDataBundleReleaseCli(["--help"], {
    root: "/definitely/not/a/project",
    environment: { NODE_ENV: "test" },
    writeOutput: (value) => {
      help += value;
    },
  });
  assert.equal(help, DATA_BUNDLE_RELEASE_USAGE);

  const root = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-release-cli-"),
  );
  try {
    const release = await signingFixture("release-2027");
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(
      path.join(root, "data", "certification-manifest.json"),
      readFileSync(
        path.join(
          process.cwd(),
          "data",
          "certification-manifest.json",
        ),
        "utf8",
      ),
    );
    writeFileSync(
      path.join(root, "data", "data-bundle-trusted-keys.json"),
      '{"schemaVersion":1,"keys":[]}\n',
    );
    let output = "";
    await runPrepareDataBundleReleaseCli(
      [
        "--created-at",
        "2026-07-31T06:00:00.000Z",
        "--official-authority-unavailable",
        "No reviewed official extraction evidence was supplied.",
      ],
      {
        root,
        environment: {
          NODE_ENV: "test",
          ROSTERPILOT_DATA_SIGNING_KEY_ID: "release-2027",
          ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK:
            JSON.stringify(release.privateJwk),
        },
        buildRuntimeBundle: async () => releaseBuild(),
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    const summary = JSON.parse(output) as {
      keyId: string;
      trustedKeyIds: string[];
    };
    assert.equal(summary.keyId, "release-2027");
    assert.deepEqual(summary.trustedKeyIds, ["release-2027"]);
    assert.equal(output.includes(release.privateJwk.d!), false);
    assert.equal(
      allFileContents(root).includes(release.privateJwk.d!),
      false,
    );
    assert.equal(
      existsSync(
        path.join(
          root,
          ".rosterpilot-data-bundle-release.lock",
        ),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
