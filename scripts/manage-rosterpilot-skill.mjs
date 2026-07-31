import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const markerName = ".rosterpilot-managed.json";
const usage = `Usage: npm run skill:install -- [--check] [--target <absolute-path>]

Install or verify the repository RosterPilot skill in the managed Codex skill
directory. An existing directory is replaced only when it contains a valid
RosterPilot managed marker. Plugin-cache copies are reported but never changed.
`;

function parseArgs(argv) {
  const parsed = { check: false, help: false, target: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") parsed.check = true;
    else if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--target") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--target requires an absolute path.");
      }
      parsed.target = value;
      index += 1;
    } else {
      throw new Error(`Unknown skill-management option: ${argument}`);
    }
  }
  return parsed;
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function skillFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`RosterPilot skill cannot contain a symbolic link: ${child}.`);
    }
    if (entry.isDirectory()) files.push(...(await skillFiles(directory, child)));
    else if (entry.isFile() && child !== markerName) files.push(child);
    else if (!entry.isFile()) {
      throw new Error(`RosterPilot skill contains a non-regular entry: ${child}.`);
    }
  }
  return files;
}

export async function rosterPilotSkillHash(directory) {
  const digest = createHash("sha256");
  for (const relative of await skillFiles(directory)) {
    const content = await readFile(path.join(directory, relative));
    digest.update(relative);
    digest.update("\0");
    digest.update(String(content.byteLength));
    digest.update("\0");
    digest.update(content);
  }
  return digest.digest("hex");
}

async function packageVersion(root) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("RosterPilot package version is unavailable.");
  }
  return manifest.version;
}

async function managedMarker(target) {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(target, markerName), "utf8"),
    );
    return parsed?.schemaVersion === 1 &&
      parsed?.managedBy === "rosterpilot-setup" &&
      typeof parsed?.sourceHash === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function pluginCacheStatus(codexRoot) {
  const pluginRoot = path.join(
    codexRoot,
    "plugins",
    "cache",
    "personal",
    "rosterpilot",
  );
  if (!(await exists(pluginRoot))) {
    return { status: "absent", path: pluginRoot, versions: [] };
  }
  const versions = (await readdir(pluginRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return {
    status: "outside-setup-control",
    path: pluginRoot,
    versions,
  };
}

export async function inspectRosterPilotSkill(options = {}) {
  const root = path.resolve(options.projectRoot ?? projectRoot);
  const source = path.join(root, "skills", "rosterpilot");
  const codexRoot = path.resolve(
    options.codexRoot ??
      process.env.CODEX_HOME ??
      path.join(os.homedir(), ".codex"),
  );
  const target = path.resolve(
    options.target ?? path.join(codexRoot, "skills", "rosterpilot"),
  );
  const sourceHash = await rosterPilotSkillHash(source);
  const version = await packageVersion(root);
  const targetExists = await exists(target);
  const marker = targetExists ? await managedMarker(target) : null;
  const targetHash = marker
    ? await rosterPilotSkillHash(target).catch(() => null)
    : null;
  return {
    source,
    target,
    version,
    sourceHash,
    targetHash,
    status: !targetExists
      ? "missing"
      : !marker
        ? "unmanaged"
        : marker.sourceHash === sourceHash && targetHash === sourceHash
          ? "current"
          : "stale",
    marker,
    pluginCache: await pluginCacheStatus(codexRoot),
  };
}

export async function installRosterPilotSkill(options = {}) {
  const inspected = await inspectRosterPilotSkill(options);
  if (inspected.status === "current") {
    return { ...inspected, action: "unchanged" };
  }
  if (inspected.status === "unmanaged") {
    throw new Error(
      `Refusing to replace unmanaged skill directory: ${inspected.target}. Move it aside or select another --target.`,
    );
  }
  const parent = path.dirname(inspected.target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staged = `${inspected.target}.installing-${process.pid}`;
  const backup = `${inspected.target}.previous-${process.pid}`;
  await rm(staged, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await cp(inspected.source, staged, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await writeFile(
    path.join(staged, markerName),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        managedBy: "rosterpilot-setup",
        version: inspected.version,
        sourceHash: inspected.sourceHash,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  if ((await rosterPilotSkillHash(staged)) !== inspected.sourceHash) {
    await rm(staged, { recursive: true, force: true });
    throw new Error("The staged managed skill does not match its source hash.");
  }
  const targetExists = await exists(inspected.target);
  if (targetExists) await rename(inspected.target, backup);
  try {
    await rename(staged, inspected.target);
  } catch (error) {
    if (targetExists) await rename(backup, inspected.target);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
  return {
    ...(await inspectRosterPilotSkill(options)),
    action: targetExists ? "updated" : "installed",
  };
}

export async function runSkillManagerCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage);
    return;
  }
  if (args.target && !path.isAbsolute(args.target)) {
    throw new Error("--target must be an absolute path.");
  }
  const result = args.check
    ? await inspectRosterPilotSkill({ target: args.target ?? undefined })
    : await installRosterPilotSkill({ target: args.target ?? undefined });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  if (args.check && result.status !== "current") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await runSkillManagerCli();
}
