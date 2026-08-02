import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

const codeloadUrl =
  "https://codeload.github.com/Tessera-cmd/tessera-engine/tar.gz/" +
  "16ab4365bbd97ef592b061c5a9babe5e44f00e80";

export const EXPECTED_TESSERA_ENGINE_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  kind: "rosterpilot-tessera-engine-candidate",
  status: "evaluation-only",
  promotionGate: "written-license-grant-required",
  upstream: {
    repository: "https://github.com/Tessera-cmd/tessera-engine",
    commit: "16ab4365bbd97ef592b061c5a9babe5e44f00e80",
    tree: "8842756e6b805018f7c186b34521e3931e79e4d8",
    codeloadUrl,
    archiveSha256:
      "a1288b50b5d100ea07428e15b6df6cf3c95d6ee379c8c0f5fc7039ca53438da9",
    archiveIntegrity:
      "sha512-okYYCvioiSMmNCCaZCTpA9ziuXIg++JusVvxm7bm23y76vMy0BYaJqdA4A/pFZL1y+6wBas5kMIrJqAvDTDYrA==",
  },
  package: {
    name: "tessera-engine",
    version: "1.0.0",
    type: "module",
    entrypoint: "src/index.js",
    license: "AGPL-3.0-only",
    repository:
      "git+https://github.com/Tessera-cmd/tessera-engine.git",
    homepage: "https://playtessera.gg",
  },
  integration: {
    dependencySection: "devDependencies",
    allowedUsage: "explicit-local-evaluation-and-contract-tests-only",
    explicitLocalRuntimeEnabled: true,
    productionRuntimeEnabled: false,
  },
});

const usage = `Usage:
  npm run tessera:engine:check
  npm run tessera:engine:check -- --archive /absolute/path/tessera-engine.tar.gz

Verify the exact evaluation-only Tessera engine dependency, its tracked
provenance and licence metadata, and a fixed-seed public-API smoke run. Passing
--archive additionally verifies the downloaded codeload archive bytes.
`;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Tessera engine provenance check failed: ${message}`);
  }
}

async function json(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha512Integrity(value) {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function repositoryFromCodeload(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(
    /^\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/,
  );
  invariant(
    parsed.protocol === "https:" &&
      parsed.hostname === "codeload.github.com" &&
      match,
    "the archive URL must be an exact HTTPS GitHub codeload commit URL",
  );
  return {
    repository: `https://github.com/${match[1]}/${match[2]}`,
    commit: match[3],
  };
}

function normalizeRepository(value) {
  return String(value)
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

async function smokeEngine(root, entrypoint) {
  const entryUrl = pathToFileURL(
    path.join(root, "node_modules", "tessera-engine", entrypoint),
  );
  entryUrl.searchParams.set("rosterpilot-provenance-check", "1");
  const engine = await import(entryUrl.href);
  const requiredExports = [
    "cumulativeAtLeast",
    "makeRng",
    "runSimulation",
  ];
  for (const name of requiredExports) {
    invariant(
      typeof engine[name] === "function",
      `the installed package does not export ${name}`,
    );
  }

  const seed = 0x1234abcd;
  const rng = engine.makeRng(seed);
  const rngSample = [rng(), rng(), rng()];
  invariant(
    isDeepStrictEqual(rngSample, [
      0.10277144517749548,
      0.5144855019170791,
      0.07858735416084528,
    ]),
    "the fixed-seed random-number sequence changed",
  );

  const simulation = engine.runSimulation(
    {
      name: "RosterPilot provenance smoke attacker",
      models: 4,
      points: 100,
      weapons: [
        {
          name: "Provenance smoke rifle",
          type: "ranged",
          count: 4,
          A: 2,
          BS: 3,
          S: 4,
          AP: -1,
          D: 1,
          keywords: [],
        },
      ],
    },
    {
      name: "RosterPilot provenance smoke target",
      models: 20,
      T: 4,
      SV: 4,
      W: 1,
      INV: null,
      FNP: null,
      damageReduction: null,
      halveDamage: false,
      keywords: ["INFANTRY"],
    },
    {
      phase: "ranged",
      iterations: 64,
      seed,
    },
  );
  invariant(simulation.seed === seed, "the smoke run did not retain its seed");
  invariant(
    simulation.iterations === 64,
    "the smoke run did not retain its iteration count",
  );
  invariant(
    simulation.kills?.mean === 2.08 &&
      simulation.woundsDealt?.mean === 2.08 &&
      simulation.mortalWounds?.mean === 0,
    "the fixed-seed smoke result changed",
  );
  const cumulative = engine.cumulativeAtLeast(
    simulation.kills.distribution,
  );
  invariant(
    cumulative.find((entry) => entry.value === 4)?.pct === 14.1,
    "the cumulative distribution projection changed",
  );

  return {
    requiredExports,
    seed,
    iterations: simulation.iterations,
    killsMean: simulation.kills.mean,
    woundsMean: simulation.woundsDealt.mean,
    mortalWoundsMean: simulation.mortalWounds.mean,
  };
}

export async function verifyTesseraEngineProvenance(options = {}) {
  const root = path.resolve(options.root ?? projectRoot);
  const manifestPath = path.join(
    root,
    "local",
    "tessera",
    "tessera-engine-provenance.json",
  );
  const rootPackagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const installedPackagePath = path.join(
    root,
    "node_modules",
    "tessera-engine",
    "package.json",
  );
  const installedLicensePath = path.join(
    root,
    "node_modules",
    "tessera-engine",
    "LICENSE",
  );

  const [manifest, rootPackage, lock, installedPackage, licenseText] =
    await Promise.all([
      json(manifestPath),
      json(rootPackagePath),
      json(lockPath),
      json(installedPackagePath),
      readFile(installedLicensePath, "utf8"),
    ]);

  invariant(
    isDeepStrictEqual(
      manifest,
      EXPECTED_TESSERA_ENGINE_PROVENANCE,
    ),
    "the tracked manifest differs from the reviewed candidate identity",
  );
  invariant(
    /^[0-9a-f]{40}$/.test(manifest.upstream.commit),
    "the upstream commit is not a full Git object ID",
  );
  invariant(
    /^[0-9a-f]{40}$/.test(manifest.upstream.tree),
    "the upstream tree is not a full Git object ID",
  );
  const archiveIdentity = repositoryFromCodeload(
    manifest.upstream.codeloadUrl,
  );
  invariant(
    archiveIdentity.repository === manifest.upstream.repository &&
      archiveIdentity.commit === manifest.upstream.commit,
    "the codeload URL does not match the reviewed repository and commit",
  );

  const dependencySpec =
    rootPackage.devDependencies?.[manifest.package.name];
  invariant(
    dependencySpec === manifest.upstream.codeloadUrl,
    "package.json does not pin the candidate in devDependencies",
  );
  invariant(
    rootPackage.dependencies?.[manifest.package.name] === undefined,
    "the evaluation candidate must not be a production dependency",
  );

  const rootLockPackage = lock.packages?.[""];
  const lockEntry =
    lock.packages?.[`node_modules/${manifest.package.name}`];
  invariant(
    rootLockPackage?.devDependencies?.[manifest.package.name] ===
      manifest.upstream.codeloadUrl,
    "the root lockfile dependency does not match the codeload URL",
  );
  invariant(Boolean(lockEntry), "the lockfile has no installed package entry");
  invariant(
    lockEntry.resolved === manifest.upstream.codeloadUrl,
    "the lockfile resolved URL does not match the reviewed archive",
  );
  invariant(
    lockEntry.integrity === manifest.upstream.archiveIntegrity,
    "the lockfile integrity does not match the reviewed archive",
  );
  invariant(
    lockEntry.version === manifest.package.version &&
      lockEntry.license === manifest.package.license &&
      lockEntry.dev === true,
    "the lockfile package, licence, or development-only metadata changed",
  );

  invariant(
    installedPackage.name === manifest.package.name &&
      installedPackage.version === manifest.package.version &&
      installedPackage.type === manifest.package.type &&
      installedPackage.main === manifest.package.entrypoint &&
      installedPackage.exports?.["."] ===
        `./${manifest.package.entrypoint}` &&
      installedPackage.license === manifest.package.license &&
      installedPackage.repository?.url ===
        manifest.package.repository &&
      installedPackage.homepage === manifest.package.homepage,
    "the installed upstream package metadata changed",
  );
  invariant(
    normalizeRepository(installedPackage.repository?.url) ===
      manifest.upstream.repository,
    "the installed package repository does not match the reviewed upstream",
  );
  invariant(
    licenseText.includes("GNU AFFERO GENERAL PUBLIC LICENSE") &&
      licenseText.includes("Version 3, 19 November 2007"),
    "the installed AGPL-3.0-only licence text is missing or changed",
  );

  let archive = null;
  if (options.archivePath) {
    const archiveBytes = await readFile(
      path.resolve(options.archivePath),
    );
    const archiveSha256 = sha256Hex(archiveBytes);
    const archiveIntegrity = sha512Integrity(archiveBytes);
    invariant(
      archiveSha256 === manifest.upstream.archiveSha256,
      "the supplied archive SHA-256 does not match the reviewed codeload bytes",
    );
    invariant(
      archiveIntegrity === manifest.upstream.archiveIntegrity,
      "the supplied archive SHA-512 integrity does not match the lockfile",
    );
    archive = {
      path: path.resolve(options.archivePath),
      sha256: archiveSha256,
      integrity: archiveIntegrity,
    };
  }

  const smoke = await smokeEngine(
    root,
    manifest.package.entrypoint,
  );
  return {
    ok: true,
    status: manifest.status,
    promotionGate: manifest.promotionGate,
    repository: manifest.upstream.repository,
    commit: manifest.upstream.commit,
    tree: manifest.upstream.tree,
    resolved: lockEntry.resolved,
    integrity: lockEntry.integrity,
    archive,
    package: {
      name: installedPackage.name,
      version: installedPackage.version,
      license: installedPackage.license,
      developmentOnly: lockEntry.dev,
    },
    smoke,
  };
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--archive") {
    return { archivePath: argv[1] };
  }
  throw new Error(`Unknown Tessera engine provenance option: ${argv[0]}`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  const result = await verifyTesseraEngineProvenance(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === scriptPath
) {
  await main();
}
