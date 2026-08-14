import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const codeExtensions = new Set([".ts", ".mjs", ".js"]);
const sourceRoots = [
  "bin",
  "cli",
  "lib",
  "local",
  "mcp",
  "reports",
  "scripts",
  "tests",
  "types",
];
const retiredPaths = [
  "cloudflare-runtime.d.ts",
  "data/certification-browser-fixtures.json",
  "drizzle/meta/_journal.json",
  "drizzle.config.ts",
  "lib/rosterpilot/remote.ts",
  "local/tessera/game-loop-simulator.ts",
  "local/tessera/spatial-geometry-engine.ts",
  "local/tessera/stratagem-engine.ts",
  "postcss.config.mjs",
  "profiles.json",
  "scripts/record-connector-fixture.ts",
  "simulation_report.json",
];

async function filesUnder(root, directory) {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(root, relative) : [relative];
  }));
  return nested.flat();
}

function relativeImportCandidates(filename, specifier) {
  const base = path.resolve(path.dirname(filename), specifier);
  const extension = path.extname(base);
  if (extension) {
    return [
      base,
      ...(extension === ".js"
        ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".mjs")]
        : []),
    ];
  }
  return [
    base,
    `${base}.ts`,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.json`,
    path.join(base, "index.ts"),
    path.join(base, "index.mjs"),
    path.join(base, "index.js"),
  ];
}

function packageScriptEntrypoints(command) {
  return [...command.matchAll(
    /\bnode\s+(?:(?:--import|--loader)\s+\S+\s+)*([^\s&|;]+)/g,
  )].map((match) => match[1]).filter((value) => !value.startsWith("-"));
}

export async function checkRepositoryWiring(root = projectRoot) {
  const failures = [];
  const packageManifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  for (const [name, command] of Object.entries(packageManifest.scripts ?? {})) {
    for (const entrypoint of packageScriptEntrypoints(String(command))) {
      if (!existsSync(path.resolve(root, entrypoint))) {
        failures.push(`Package script ${name} references missing ${entrypoint}.`);
      }
    }
  }

  const relativeFiles = (
    await Promise.all(sourceRoots.map((directory) => filesUnder(root, directory)))
  ).flat();
  const codeFiles = relativeFiles.filter((filename) =>
    codeExtensions.has(path.extname(filename))
  );
  const importPatterns = [
    /(?:from\s+|import\s*\()(["'])(\.{1,2}\/[^"']+)\1/g,
    /import\s+(["'])(\.{1,2}\/[^"']+)\1/g,
  ];
  for (const relative of codeFiles) {
    const filename = path.join(root, relative);
    const source = await readFile(filename, "utf8");
    for (const importPattern of importPatterns) {
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[2];
        if (!relativeImportCandidates(filename, specifier).some(existsSync)) {
          failures.push(`${relative} imports missing ${specifier}.`);
        }
      }
    }
  }

  for (const relative of codeFiles.filter((filename) =>
    path.extname(filename) === ".mjs"
  )) {
    const checked = spawnSync(process.execPath, ["--check", relative], {
      cwd: root,
      encoding: "utf8",
    });
    if (checked.status !== 0) {
      failures.push(
        `${relative} failed node --check: ${(checked.stderr || checked.stdout).trim()}`,
      );
    }
  }

  const testFiles = relativeFiles.filter((filename) =>
    filename.startsWith(`tests${path.sep}`) && filename.endsWith(".test.ts")
  );
  if (testFiles.length > 18) {
    failures.push(`Found ${testFiles.length} test files; the repository limit is 18.`);
  }
  for (const retired of retiredPaths) {
    if (existsSync(path.join(root, retired))) {
      failures.push(`Retired path remains tracked: ${retired}.`);
    }
  }
  return {
    ok: failures.length === 0,
    checkedFiles: codeFiles.length,
    checkedPackageScripts: Object.keys(packageManifest.scripts ?? {}).length,
    testFiles: testFiles.length,
    failures,
  };
}

async function main() {
  const result = await checkRepositoryWiring();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
