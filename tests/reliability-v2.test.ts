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

import { strToU8, zipSync } from "fflate";

import {
  buildRoster,
  inspectEnrichedRosz,
  parseRosterPrompt,
  repairRosterDeterministically,
  rosterProfileRequirements,
  rosterSimulationFingerprint,
} from "../lib/rosterpilot";
import {
  loadNewRecruitCache,
  storeNewRecruitCache,
} from "../local/new-recruit/cache";
import {
  profilePolicyHash,
  validateProfilePolicy,
} from "../local/tessera/profile-policy";

test("canonical intent terms and mixed-threat context survive roster building", async () => {
  const parsed = parseRosterPrompt(
    "Build a 1,000 point Custodes roster with mobility, durability, and mixed threat coverage.",
  );
  assert.deepEqual(
    new Set(parsed.preferences),
    new Set(["mobility", "durability", "shooting", "melee"]),
  );

  const repaired = await repairRosterDeterministically({
    prompt:
      "Build a 1,000 point Custodes roster with mobility and durability.",
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Adeptus Custodes 1000 vs Aeldari",
    opponentContext: {
      kind: "known-faction",
      factionId: "aeldari",
    },
    mixedThreatIntent: true,
  });
  assert.equal(repaired.ok, true);
  assert.ok(repaired.data);
  assert.ok(repaired.data.roster.totalPoints >= 980);
  assert.notEqual(repaired.data.missionReadiness.overallBand, "red");
  assert.ok(repaired.data.roster.preferences.includes("shooting"));
  assert.ok(repaired.data.roster.preferences.includes("melee"));
});

test("simulation fingerprints ignore detachment-only changes", () => {
  const built = buildRoster({
    faction: "aeldari",
    pointsLimit: 1_000,
    name: "Fingerprint fixture",
  });
  assert.ok(built.data);
  const changed = {
    ...structuredClone(built.data),
    detachmentId: `${built.data.detachmentId}-presentation-only`,
    detachmentName: "Different detachment label",
  };
  assert.equal(
    rosterSimulationFingerprint(built.data),
    rosterSimulationFingerprint(changed),
  );
  changed.units[0].modelCount += 1;
  assert.notEqual(
    rosterSimulationFingerprint(built.data),
    rosterSimulationFingerprint(changed),
  );
});

test("profile policies validate exact choices and hash canonically", () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    preferences: ["melee"],
    allowNamedCharacters: false,
  });
  assert.ok(built.data);
  const requirements = rosterProfileRequirements(built.data);
  assert.ok(requirements.length > 0);
  const entries = requirements.map((requirement) => ({
    faction: requirement.faction,
    unit: requirement.unit,
    weaponGroup: requirement.weaponGroup,
    phase: requirement.phase,
    selectedProfile: requirement.availableProfiles[0],
    activeCount: requirement.activeCount,
  }));
  const policy = {
    schemaVersion: 1 as const,
    policyKind: "tessera-profile-policy" as const,
    entries,
  };
  assert.equal(validateProfilePolicy(requirements, policy).valid, true);
  assert.equal(
    profilePolicyHash(policy),
    profilePolicyHash({
      ...policy,
      entries: [...policy.entries].reverse(),
    }),
  );
  const invalid = structuredClone(policy);
  invalid.entries[0].selectedProfile = "not-a-real-profile";
  assert.equal(validateProfilePolicy(requirements, invalid).valid, false);
});

test("New Recruit cache verifies hashes and exact enriched summaries", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-cache-v2-"),
  );
  const previousSupport = process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
  process.env.ROSTERPILOT_SUPPORT_DIRECTORY = path.join(
    directory,
    "support",
  );
  try {
    const built = buildRoster({
      faction: "adeptus-custodes",
      pointsLimit: 500,
      name: "Cache Fixture",
    });
    assert.ok(built.data);
    const sourcePath = path.join(directory, "source.rosz");
    const enrichedPath = path.join(directory, "enriched.rosz");
    const xml = `<?xml version="1.0"?><roster name="${built.data.name}" generatedBy="https://newrecruit.eu"><cost name="pts" value="${built.data.totalPoints}"/><forces><force name="${built.data.factionName}" catalogueName="${built.data.factionName}"><selections>${built.data.units
      .map(
        (unit) =>
          `<selection id="${unit.selectionId}" name="${unit.name}" number="${unit.modelCount}" type="model"><cost name="pts" value="${unit.points}"/></selection>`,
      )
      .join("")}</selections></force></forces><profiles><profile name="Fixture weapon" typeName="Melee Weapons"/></profiles></roster>`;
    const archive = zipSync({
      "fixture.ros": strToU8(xml),
    });
    await Promise.all([
      writeFile(sourcePath, archive),
      writeFile(enrichedPath, archive),
    ]);
    const summary = inspectEnrichedRosz(archive);
    await storeNewRecruitCache(built.data, {
      ok: true,
      data: {
        rosterId: built.data.id,
        rosterName: built.data.name,
        listUrl: "https://www.newrecruit.eu/app/Lists/cache-fixture",
        imported: true,
        sessionReused: false,
        verification: null,
        enrichedSummary: summary,
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: sourcePath,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enrichedPath,
          },
        ],
      },
      violations: [],
      warnings: [],
    });
    const cached = await loadNewRecruitCache(built.data);
    assert.equal(cached?.ok, true);
    assert.equal(cached?.data?.sessionReused, true);
    const cachedEnriched = cached?.data?.artifacts.find(
      (artifact) => artifact.format === "new-recruit-enriched-rosz",
    )?.written;
    assert.ok(cachedEnriched);
    await writeFile(cachedEnriched, "tampered");
    assert.equal(await loadNewRecruitCache(built.data), null);
    const inventory = await readFile(
      path.join(
        process.env.ROSTERPILOT_SUPPORT_DIRECTORY,
        "new-recruit-run-inventory.json",
      ),
      "utf8",
    );
    assert.match(inventory, /cache-fixture/);
  } finally {
    if (previousSupport === undefined) {
      delete process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
    } else {
      process.env.ROSTERPILOT_SUPPORT_DIRECTORY = previousSupport;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
