import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  certificationRelevantChanges,
} from "../local/certification/changed-files";

function git(directory: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: directory,
    stdio: "ignore",
  });
}

async function commit(
  directory: string,
  filename: string,
  content: string,
  message: string,
): Promise<void> {
  const target = path.join(directory, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  git(directory, "add", filename);
  git(directory, "commit", "-m", message);
}

test("changed-only sees committed certification changes in a clean checkout", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-changed-files-"),
  );
  try {
    git(directory, "init");
    git(directory, "config", "user.email", "fixture@example.invalid");
    git(directory, "config", "user.name", "RosterPilot Fixture");
    await commit(
      directory,
      "README.md",
      "initial\n",
      "Initial fixture",
    );
    await commit(
      directory,
      "lib/rosterpilot/example.ts",
      "export const fixture = true;\n",
      "Change certification surface",
    );

    assert.deepEqual(
      certificationRelevantChanges({
        cwd: directory,
        environment: { NODE_ENV: "test" },
      }),
      ["lib/rosterpilot/example.ts"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed-only skips an established clean commit with no relevant paths", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-unchanged-files-"),
  );
  try {
    git(directory, "init");
    git(directory, "config", "user.email", "fixture@example.invalid");
    git(directory, "config", "user.name", "RosterPilot Fixture");
    await commit(
      directory,
      "README.md",
      "initial\n",
      "Initial fixture",
    );
    await commit(
      directory,
      "docs/notes.md",
      "documentation only\n",
      "Documentation fixture",
    );
    assert.deepEqual(
      certificationRelevantChanges({
        cwd: directory,
        environment: { NODE_ENV: "test" },
      }),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed-only runs fail-safe when no Git comparison base is available", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-no-history-"),
  );
  try {
    assert.deepEqual(
      certificationRelevantChanges({
        cwd: directory,
        environment: { NODE_ENV: "test" },
      }),
      ["<change-base-unavailable>"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
