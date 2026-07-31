import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  rosterPilotSkillHash,
} from "./manage-rosterpilot-skill.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

const usage = `Usage:
  npm run plugin:check
  npm run plugin:sync

Check or atomically synchronize the repository's installable RosterPilot
plugin skill from the canonical skills/rosterpilot source. This command never
changes a personal marketplace or an installed plugin cache.
`;

async function json(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function baseVersion(version) {
  return String(version).split("+")[0];
}

export async function inspectRosterPilotPlugin(
  root = projectRoot,
) {
  const resolvedRoot = path.resolve(root);
  const source = path.join(resolvedRoot, "skills", "rosterpilot");
  const target = path.join(
    resolvedRoot,
    "plugins",
    "rosterpilot",
    "skills",
    "rosterpilot",
  );
  const packageManifest = await json(
    path.join(resolvedRoot, "package.json"),
  );
  const pluginManifest = await json(
    path.join(
      resolvedRoot,
      "plugins",
      "rosterpilot",
      ".codex-plugin",
      "plugin.json",
    ),
  );
  const sourceHash = await rosterPilotSkillHash(source);
  const targetHash = await rosterPilotSkillHash(target).catch(
    () => null,
  );
  const versionMatches =
    baseVersion(pluginManifest.version) ===
    baseVersion(packageManifest.version);
  return {
    source,
    target,
    sourceHash,
    targetHash,
    packageVersion: packageManifest.version,
    pluginVersion: pluginManifest.version,
    versionMatches,
    status:
      sourceHash === targetHash && versionMatches
        ? "current"
        : "stale",
  };
}

export async function syncRosterPilotPlugin(
  root = projectRoot,
) {
  const before = await inspectRosterPilotPlugin(root);
  if (!before.versionMatches) {
    throw new Error(
      `Plugin version ${before.pluginVersion} does not match package version ${before.packageVersion}.`,
    );
  }
  if (before.status === "current") {
    return { ...before, action: "unchanged" };
  }

  const parent = path.dirname(before.target);
  const staged = `${before.target}.syncing-${process.pid}`;
  const backup = `${before.target}.previous-${process.pid}`;
  await mkdir(parent, { recursive: true });
  await rm(staged, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await cp(before.source, staged, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  if (
    (await rosterPilotSkillHash(staged)) !== before.sourceHash
  ) {
    await rm(staged, { recursive: true, force: true });
    throw new Error("Staged plugin skill does not match its source.");
  }
  await rename(before.target, backup);
  try {
    await rename(staged, before.target);
  } catch (error) {
    await rename(backup, before.target);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
  return {
    ...(await inspectRosterPilotPlugin(root)),
    action: "updated",
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage);
    return;
  }
  if (argv.length > 0) {
    throw new Error(`Unknown plugin synchronization option: ${argv[0]}`);
  }
  const check = process.env.npm_lifecycle_event === "plugin:check";
  const result = check
    ? await inspectRosterPilotPlugin()
    : await syncRosterPilotPlugin();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  if (check && result.status !== "current") process.exitCode = 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === scriptPath
) {
  await main();
}
