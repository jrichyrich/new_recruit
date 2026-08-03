import {
  createPrivateKey,
  createPublicKey,
  type JsonWebKey,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

type TrustedRegistry = {
  schemaVersion: 1;
  keys: Array<{ keyId: string; publicKey: JsonWebKey }>;
};

function stableJwk(value: JsonWebKey): string {
  return JSON.stringify({
    crv: value.crv,
    ext: value.ext,
    key_ops: value.key_ops,
    kty: value.kty,
    x: value.x,
  });
}

export async function checkDataPublisherConfig(
  registryPath = "data/data-bundle-trusted-keys.json",
): Promise<{ keyId: string; registryPath: string }> {
  const keyId = process.env.ROSTERPILOT_DATA_SIGNING_KEY_ID?.trim();
  const privateJwkText =
    process.env.ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK?.trim();
  if (!keyId || !privateJwkText) {
    throw new Error(
      "Signed data publishing is not configured. Set the ROSTERPILOT_DATA_SIGNING_KEY_ID repository variable and ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK Actions secret.",
    );
  }
  const privateJwk = JSON.parse(privateJwkText) as JsonWebKey;
  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  const derived = createPublicKey(privateKey).export({ format: "jwk" });
  if (
    derived.kty !== "OKP" ||
    derived.crv !== "Ed25519" ||
    typeof derived.x !== "string"
  ) {
    throw new Error("The configured signing key is not Ed25519.");
  }
  const publicJwk: JsonWebKey = {
    kty: "OKP",
    crv: "Ed25519",
    x: derived.x,
    key_ops: ["verify"],
    ext: true,
  };
  const resolvedRegistry = path.resolve(registryPath);
  const registry = JSON.parse(
    await readFile(resolvedRegistry, "utf8"),
  ) as TrustedRegistry;
  const trusted = registry.keys.find((entry) => entry.keyId === keyId);
  if (!trusted) {
    throw new Error(
      `Signing key ${keyId} is not in ${resolvedRegistry}. Run the one-time "Bootstrap signed roster data" workflow and merge its pull request first.`,
    );
  }
  if (stableJwk(trusted.publicKey) !== stableJwk(publicJwk)) {
    throw new Error(
      `Signing key ${keyId} does not match its checked-in public key. Rotate through a reviewed bootstrap pull request; do not overwrite the existing entry.`,
    );
  }
  return { keyId, registryPath: resolvedRegistry };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkDataPublisherConfig(process.argv[2])
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ ok: true, ...result })}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
