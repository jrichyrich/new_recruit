import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectRosterPilotSkill,
  installRosterPilotSkill,
} from "../scripts/manage-rosterpilot-skill.mjs";
import {
  inspectRosterPilotPlugin,
} from "../scripts/sync-rosterpilot-plugin.mjs";

async function fixture(): Promise<{
  root: string;
  projectRoot: string;
  codexRoot: string;
  target: string;
}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-managed-skill-"),
  );
  const projectRoot = path.join(root, "project");
  const codexRoot = path.join(root, "codex");
  const target = path.join(codexRoot, "skills", "rosterpilot");
  await mkdir(path.join(projectRoot, "skills", "rosterpilot"), {
    recursive: true,
  });
  await writeFile(
    path.join(projectRoot, "package.json"),
    '{"name":"fixture","version":"9.8.7"}\n',
  );
  await writeFile(
    path.join(projectRoot, "skills", "rosterpilot", "SKILL.md"),
    "# RosterPilot fixture\n\nVersion one.\n",
  );
  return { root, projectRoot, codexRoot, target };
}

test("managed skill install is idempotent and updates only its marked target", async () => {
  const found = await fixture();
  try {
    const installed = await installRosterPilotSkill({
      projectRoot: found.projectRoot,
      codexRoot: found.codexRoot,
      target: found.target,
    });
    assert.equal(installed.status, "current");
    assert.equal(installed.action, "installed");
    assert.equal(installed.version, "9.8.7");
    assert.equal(installed.pluginCache.status, "absent");

    const marker = JSON.parse(
      await readFile(
        path.join(found.target, ".rosterpilot-managed.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(marker.managedBy, "rosterpilot-setup");
    assert.equal(marker.sourceHash, installed.sourceHash);

    const unchanged = await installRosterPilotSkill({
      projectRoot: found.projectRoot,
      codexRoot: found.codexRoot,
      target: found.target,
    });
    assert.equal(unchanged.action, "unchanged");

    await writeFile(
      path.join(
        found.projectRoot,
        "skills",
        "rosterpilot",
        "SKILL.md",
      ),
      "# RosterPilot fixture\n\nVersion two.\n",
    );
    const stale = await inspectRosterPilotSkill({
      projectRoot: found.projectRoot,
      codexRoot: found.codexRoot,
      target: found.target,
    });
    assert.equal(stale.status, "stale");
    const updated = await installRosterPilotSkill({
      projectRoot: found.projectRoot,
      codexRoot: found.codexRoot,
      target: found.target,
    });
    assert.equal(updated.status, "current");
    assert.equal(updated.action, "updated");
    assert.match(
      await readFile(path.join(found.target, "SKILL.md"), "utf8"),
      /Version two/,
    );
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("managed skill install refuses to replace an unrelated user directory", async () => {
  const found = await fixture();
  try {
    await mkdir(found.target, { recursive: true });
    const userContent = "# My unrelated skill\n";
    await writeFile(
      path.join(found.target, "SKILL.md"),
      userContent,
    );
    await assert.rejects(
      installRosterPilotSkill({
        projectRoot: found.projectRoot,
        codexRoot: found.codexRoot,
        target: found.target,
      }),
      /Refusing to replace unmanaged skill directory/,
    );
    assert.equal(
      await readFile(path.join(found.target, "SKILL.md"), "utf8"),
      userContent,
    );
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("plugin-cache copies are visible but remain outside setup control", async () => {
  const found = await fixture();
  try {
    await mkdir(
      path.join(
        found.codexRoot,
        "plugins",
        "cache",
        "personal",
        "rosterpilot",
        "0.1.0",
      ),
      { recursive: true },
    );
    const inspected = await inspectRosterPilotSkill({
      projectRoot: found.projectRoot,
      codexRoot: found.codexRoot,
      target: found.target,
    });
    assert.deepEqual(inspected.pluginCache, {
      status: "outside-setup-control",
      path: path.join(
        found.codexRoot,
        "plugins",
        "cache",
        "personal",
        "rosterpilot",
      ),
      versions: ["0.1.0"],
    });
  } finally {
    await rm(found.root, { recursive: true, force: true });
  }
});

test("the repository plugin packages the exact canonical skill and application version", async () => {
  const inspected = await inspectRosterPilotPlugin(
    path.resolve(import.meta.dirname, ".."),
  );
  assert.equal(inspected.status, "current");
  assert.equal(inspected.versionMatches, true);
  assert.equal(inspected.targetHash, inspected.sourceHash);
});
