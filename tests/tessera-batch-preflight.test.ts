import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRoster } from "../lib/rosterpilot";
import {
  runTesseraBatchPreflight,
  verifyTesseraBatchPreflightManifest,
} from "../local/tessera/batch-preflight";
import { resolvedProfilePolicy } from "./helpers/tessera-local-bundle";

test("batch preflight seals the complete roster set and rejects manifest tampering", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-batch-preflight-"),
  );
  try {
    const player = buildRoster({
      faction: "adeptus-custodes",
      pointsLimit: 1_000,
      name: "Batch player",
    });
    const opponent = buildRoster({
      faction: "aeldari",
      pointsLimit: 1_000,
      name: "Batch opponent",
    });
    assert.ok(player.ok && player.data);
    assert.ok(opponent.ok && opponent.data);
    const policy = resolvedProfilePolicy(player.data, opponent.data);
    const result = await runTesseraBatchPreflight({
      workflowId: "preflight-test",
      rosters: [
        { role: "player", roster: player.data },
        {
          role: "opponent",
          templateId: "balanced-control-mixed",
          roster: opponent.data,
        },
      ],
      profilePolicy: policy,
      requireNewRecruit: false,
      outputDirectory: directory,
    });

    assert.equal(result.manifest.status, "passed");
    assert.equal(result.manifest.rosterCount, 2);
    assert.equal(result.manifest.inventory.deliveryMisses, 0);
    assert.equal(result.cacheHits.size, 0);
    assert.deepEqual(
      await verifyTesseraBatchPreflightManifest(result.manifestPath),
      result.manifest,
    );

    const changed = JSON.parse(
      await readFile(result.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    changed.status = "failed";
    await writeFile(
      result.manifestPath,
      `${JSON.stringify(changed, null, 2)}\n`,
    );
    await assert.rejects(
      verifyTesseraBatchPreflightManifest(result.manifestPath),
      /failed verification/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch preflight returns needs-input before external preparation when profile choices are unresolved", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-batch-policy-"),
  );
  try {
    const player = buildRoster({
      faction: "adeptus-custodes",
      pointsLimit: 1_000,
    });
    assert.ok(player.ok && player.data);
    const requirements = resolvedProfilePolicy(player.data);
    if (requirements.entries.length === 0) return;
    const result = await runTesseraBatchPreflight({
      workflowId: "policy-test",
      rosters: [{ role: "player", roster: player.data }],
      profilePolicy: null,
      requireNewRecruit: false,
      outputDirectory: directory,
    });
    assert.equal(result.manifest.status, "needs-input");
    assert.ok(
      result.manifest.failureCodes.includes(
        "TESSERA_PROFILE_POLICY_REQUIRED",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
