import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "native", "NewRecruitKeychainBroker.swift");
const outputDirectory = path.join(root, "native", ".build");
const output = path.join(outputDirectory, "rosterpilot-keychain");
const moduleCache = path.join(outputDirectory, "module-cache");

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
mkdirSync(moduleCache, { recursive: true, mode: 0o700 });
const built = spawnSync(
  "/usr/bin/swiftc",
  [
    "-target",
    "arm64-apple-macosx26.0",
    "-module-cache-path",
    moduleCache,
    source,
    "-o",
    output,
    "-framework",
    "AppKit",
    "-framework",
    "Security",
  ],
  { cwd: root, encoding: "utf8" },
);
if (built.status !== 0) {
  process.stderr.write(built.stderr || built.stdout || "Swift compilation failed.\n");
  process.exit(built.status ?? 1);
}
process.stdout.write(`${output}\n`);
