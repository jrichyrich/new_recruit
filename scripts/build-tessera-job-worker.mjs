import crypto from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, version as esbuildVersion } from "esbuild";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const entryPoint = path.join(
  projectRoot,
  "local",
  "tessera",
  "job-worker.ts",
);
const outputDirectory = path.join(projectRoot, "dist", "workers");
const outputPath = path.join(
  outputDirectory,
  "tessera-job-worker.mjs",
);
const receiptPath = path.join(
  outputDirectory,
  "tessera-job-worker.receipt.json",
);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function inputFingerprint(inputs) {
  const hash = crypto.createHash("sha256");
  for (const filename of [...inputs].sort()) {
    const absolute = path.resolve(projectRoot, filename);
    hash.update(path.relative(projectRoot, absolute));
    hash.update("\0");
    hash.update(await readFile(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const nonce = crypto.randomUUID();
const temporaryOutput = `${outputPath}.${nonce}.tmp`;
const temporaryReceipt = `${receiptPath}.${nonce}.tmp`;
try {
  const built = await build({
    entryPoints: [entryPoint],
    outfile: temporaryOutput,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.13",
    packages: "external",
    sourcemap: false,
    minify: false,
    metafile: true,
    logLevel: "warning",
    banner: {
      js: "// Precompiled RosterPilot durable Tessera worker. Generated; do not edit.",
    },
  });
  const output = await readFile(temporaryOutput);
  const workerSha256 = sha256(output);
  const sourceSha256 = await inputFingerprint(
    Object.keys(built.metafile.inputs),
  );
  const receipt = {
    schemaVersion: 1,
    receiptKind: "tessera-job-worker-build",
    builtAt: new Date().toISOString(),
    entryPoint: path.relative(projectRoot, entryPoint),
    output: path.relative(projectRoot, outputPath),
    workerSha256,
    sourceSha256,
    esbuildVersion,
    nodeTarget: "node22.13",
  };
  await writeFile(
    temporaryReceipt,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await rename(temporaryOutput, outputPath);
  await rename(temporaryReceipt, receiptPath);
  process.stdout.write(
    `${JSON.stringify({ ok: true, outputPath, workerSha256 })}\n`,
  );
} finally {
  await rm(temporaryOutput, { force: true });
  await rm(temporaryReceipt, { force: true });
}
