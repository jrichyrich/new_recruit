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

import {
  dataset,
  units,
} from "@alpaca-software/40kdc-data";
import { strToU8, zipSync } from "fflate";

import {
  buildRoster,
  exportRoster,
  inspectEnrichedProfileRequirements,
  inspectEnrichedRosz,
  parseRosterPrompt,
  repairRosterDeterministically,
  rosterExecutionFingerprint,
  rosterProfileRequirements,
  rosterSimulationFingerprint,
  type ProfilePolicyV1,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import {
  loadNewRecruitCache,
  newRecruitCacheKey,
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

test("opponent target language does not become a player composition preference", () => {
  const parsed = parseRosterPrompt(
    "Build a durable Death Guard army with anti-horde shooting and answers to elite vehicles.",
    {
      playerFaction: "death-guard",
      opponentFaction: "orks",
    },
  );
  const preferences = parsed.preferences ?? [];
  assert.equal(preferences.includes("horde"), false);
  assert.equal(preferences.includes("elite"), false);
  assert.equal(preferences.includes("durability"), true);
  assert.equal(preferences.includes("shooting"), true);
});

test("an exact known-opponent request receives mission-safe defaults", async () => {
  const repaired = await repairRosterDeterministically({
    prompt:
      "Create a Death Guard army to battle against a known Ork faction but unknown list.",
    playerFaction: "death-guard",
    pointsLimit: 1_000,
    opponentContext: {
      kind: "known-faction",
      factionId: "orks",
    },
    mixedThreatIntent: true,
  });
  assert.equal(repaired.ok, true);
  assert.ok(repaired.data);
  for (const preference of [
    "objective",
    "durability",
    "shooting",
    "melee",
  ] as const) {
    assert.ok(
      repaired.data.roster.preferences.includes(preference),
    );
  }
  assert.ok(repaired.data.roster.totalPoints >= 980);
  assert.notEqual(repaired.data.missionReadiness.overallBand, "red");
});

test("beam diversity preserves mission pieces for a detailed Death Guard request", async () => {
  const prompt =
    "Build a balanced 1,000 point Death Guard army to battle an unknown Orks list. Prioritize durability, objective control, anti-horde shooting, melee counterpunch, and answers to elite vehicles and monsters.";
  const repaired = await repairRosterDeterministically({
    prompt,
    playerFaction: "death-guard",
    pointsLimit: 1_000,
    opponentContext: {
      kind: "known-faction",
      factionId: "orks",
    },
    mixedThreatIntent: true,
  });
  assert.equal(
    repaired.ok,
    true,
    repaired.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(repaired.data);
  const roster = repaired.data.roster;
  assert.ok(roster.totalPoints >= 980);
  assert.notEqual(repaired.data.missionReadiness.overallBand, "red");
  const selectedIds = new Set(roster.units.map((unit) => unit.unitId));
  for (const selection of roster.units) {
    const unit = units.getInFaction(selection.unitId, roster.factionId);
    if (!unit || unit.raw.attachment_role !== "leader") continue;
    const bodyguards = dataset.bodyguardsAttachableFrom(unit.id);
    assert.ok(
      bodyguards.length === 0 ||
        bodyguards.some((bodyguard) => selectedIds.has(bodyguard.id)),
      `${selection.name} has no compatible bodyguard in the roster`,
    );
  }
  const exported = await exportRoster(roster, "rosz");
  assert.equal(
    exported.ok,
    true,
    exported.violations.map((violation) => violation.message).join("; "),
  );
});

test("deterministic repair preserves every hard roster constraint", async () => {
  const repaired = await repairRosterDeterministically({
    prompt:
      "Build a 1,000 point Aeldari roster. Must include Farseer Skyrunner. Do not select Warlock Skyrunners.",
    playerFaction: "aeldari",
    pointsLimit: 1_000,
    allowNamedCharacters: false,
    requiredUnitIds: ["farseer-skyrunner"],
    excludedUnitIds: ["warlock-skyrunners"],
    requiredWarlordUnitId: "farseer-skyrunner",
    opponentContext: {
      kind: "known-faction",
      factionId: "adeptus-custodes",
    },
  });
  assert.equal(
    repaired.ok,
    true,
    repaired.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(repaired.data);
  const roster = repaired.data.roster;
  assert.equal(roster.constraints.allowNamedCharacters, false);
  assert.deepEqual(roster.constraints.requiredUnitIds, [
    "farseer-skyrunner",
  ]);
  assert.deepEqual(roster.constraints.excludedUnitIds, [
    "warlock-skyrunners",
  ]);
  assert.equal(
    roster.units.find((unit) => unit.isWarlord)?.unitId,
    "farseer-skyrunner",
  );
  assert.equal(
    roster.units.some((unit) => unit.unitId === "warlock-skyrunners"),
    false,
  );
  assert.ok(roster.totalPoints >= 980);
  const exported = await exportRoster(roster, "rosz");
  assert.equal(
    exported.ok,
    true,
    exported.violations.map((violation) => violation.message).join("; "),
  );
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

test("New Recruit enriched archives expose exact alternate-profile inventory", () => {
  const xml = `<?xml version="1.0"?>
<roster name="Profile Inventory" generatedBy="https://newrecruit.eu">
  <cost name="pts" value="1000"/>
  <forces>
    <force name="Aeldari" catalogueName="Aeldari">
      <selections>
        <selection id="unit-1" name="Fire Prism" number="1" type="unit">
          <selections>
            <selection id="weapon-1" name="Prism Cannon" number="1" type="upgrade">
              <profiles>
                <profile name="➤ Prism Cannon - dispersed pulse" typeName="Ranged Weapons"/>
                <profile name="➤ Prism Cannon - focused lances" typeName="Ranged Weapons"/>
              </profiles>
            </selection>
            <selection id="ordinary-1" name="Star engines - port" number="1" type="upgrade">
              <profiles>
                <profile name="Star engines - port" typeName="Ranged Weapons"/>
              </profiles>
            </selection>
          </selections>
        </selection>
      </selections>
    </force>
  </forces>
</roster>`;
  const requirements = inspectEnrichedProfileRequirements(
    zipSync({ "fixture.ros": strToU8(xml) }),
    "aeldari",
  );
  assert.deepEqual(requirements, [
    {
      faction: "aeldari",
      unit: "Fire Prism",
      selectionId: "unit-1",
      unitOccurrence: 1,
      modelCount: 1,
      weaponGroup: "Prism Cannon",
      phase: "shooting",
      availableProfiles: [
        "dispersed pulse",
        "focused lances",
      ],
      activeCount: 1,
      selectedProfile: null,
    },
  ]);
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
        uiIdentity: "c".repeat(64),
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
    const renamed = buildRoster({
      faction: "adeptus-custodes",
      pointsLimit: 500,
      name: "Cache Fixture Current Run",
    });
    assert.ok(renamed.data);
    assert.equal(
      rosterExecutionFingerprint(renamed.data),
      rosterExecutionFingerprint(built.data),
      "run-scoped presentation names must share a cache identity",
    );
    const cached = await loadNewRecruitCache(renamed.data);
    assert.equal(cached?.ok, true);
    assert.equal(cached?.data?.sessionReused, true);
    assert.equal(cached?.data?.uiIdentity, "c".repeat(64));
    assert.equal(
      cached?.data?.enrichedSummary?.rosterName,
      built.data.name,
      "cache evidence must retain the observed historical name",
    );
    assert.equal(
      cached?.data?.rosterName,
      built.data.name,
      "cache delivery must not rewrite the historical requested name",
    );
    const receiptPath = path.join(
      process.env.ROSTERPILOT_SUPPORT_DIRECTORY,
      "cache",
      "new-recruit",
      "v1",
      newRecruitCacheKey(renamed.data),
      "receipt.json",
    );
    const legacyReceipt = JSON.parse(
      await readFile(receiptPath, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(legacyReceipt.schemaVersion, 3);
    assert.match(
      String(legacyReceipt.integritySha256),
      /^[0-9a-f]{64}$/,
    );
    const sealedReceipt = structuredClone(legacyReceipt);
    legacyReceipt.listUrl =
      "https://www.newrecruit.eu/app/Lists/tampered";
    await writeFile(
      receiptPath,
      `${JSON.stringify(legacyReceipt, null, 2)}\n`,
    );
    assert.equal(
      await loadNewRecruitCache(renamed.data),
      null,
      "a changed v3 receipt must fail its integrity seal",
    );
    Object.assign(legacyReceipt, sealedReceipt);
    legacyReceipt.schemaVersion = 2;
    delete legacyReceipt.uiIdentity;
    delete legacyReceipt.integritySha256;
    await writeFile(
      receiptPath,
      `${JSON.stringify(legacyReceipt, null, 2)}\n`,
    );
    assert.equal(
      (await loadNewRecruitCache(renamed.data))?.data?.uiIdentity,
      null,
      "legacy cache receipts must remain reusable without inventing a UI identity",
    );
    const cachedEnriched = cached?.data?.artifacts.find(
      (artifact) => artifact.format === "new-recruit-enriched-rosz",
    )?.written;
    assert.ok(cachedEnriched);
    await writeFile(cachedEnriched, "tampered");
    assert.equal(await loadNewRecruitCache(renamed.data), null);
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

test("New Recruit cache ignores Tessera policy but scopes roster changes to one artifact", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-cache-policy-scope-"),
  );
  const previousSupport = process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
  process.env.ROSTERPILOT_SUPPORT_DIRECTORY = path.join(
    directory,
    "support",
  );
  const player = buildRoster({
    faction: "death-guard",
    pointsLimit: 1_000,
    name: "Policy-scoped player",
  }).data;
  const opponent = buildRoster({
    faction: "orks",
    pointsLimit: 1_000,
    name: "Policy-scoped opponent",
  }).data;
  assert.ok(player);
  assert.ok(opponent);
  const requirements = [
    ...rosterProfileRequirements(player),
    ...rosterProfileRequirements(opponent),
  ];
  const policyA: ProfilePolicyV1 = {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: requirements.map((requirement) => ({
      faction: requirement.faction,
      unit: requirement.unit,
      weaponGroup: requirement.weaponGroup,
      phase: requirement.phase,
      selectedProfile: requirement.availableProfiles[0],
      activeCount: requirement.activeCount,
    })),
  };
  const changedPlayerEntry = policyA.entries.findIndex(
    (entry) =>
      entry.faction === player.factionId &&
      requirements.find(
        (requirement) =>
          requirement.faction === entry.faction &&
          requirement.unit === entry.unit &&
          requirement.weaponGroup === entry.weaponGroup &&
          requirement.phase === entry.phase,
      )!.availableProfiles.length > 1,
  );
  assert.ok(changedPlayerEntry >= 0);
  const policyB = structuredClone(policyA);
  const changedRequirement = requirements.find(
    (requirement) =>
      requirement.faction ===
        policyB.entries[changedPlayerEntry].faction &&
      requirement.unit ===
        policyB.entries[changedPlayerEntry].unit &&
      requirement.weaponGroup ===
        policyB.entries[changedPlayerEntry].weaponGroup &&
      requirement.phase ===
        policyB.entries[changedPlayerEntry].phase,
  );
  assert.ok(changedRequirement);
  policyB.entries[changedPlayerEntry].selectedProfile =
    changedRequirement.availableProfiles[1];

  const storeFixture = async (
    candidate: RosterDraftV1,
    label: string,
  ): Promise<void> => {
    const sourcePath = path.join(directory, `${label}-source.rosz`);
    const enrichedPath = path.join(
      directory,
      `${label}-enriched.rosz`,
    );
    const xml = `<?xml version="1.0"?><roster name="${candidate.name}" generatedBy="https://newrecruit.eu"><cost name="pts" value="${candidate.totalPoints}"/><forces><force name="${candidate.factionName}" catalogueName="${candidate.factionName}"><selections>${candidate.units
      .map(
        (unit) =>
          `<selection id="${unit.selectionId}" name="${unit.name}" number="${unit.modelCount}" type="model"><cost name="pts" value="${unit.points}"/></selection>`,
      )
      .join("")}</selections></force></forces><profiles><profile name="Fixture weapon" typeName="Melee Weapons"/></profiles></roster>`;
    const archive = zipSync({ "fixture.ros": strToU8(xml) });
    await Promise.all([
      writeFile(sourcePath, archive),
      writeFile(enrichedPath, archive),
    ]);
    await storeNewRecruitCache(
      candidate,
      {
        ok: true,
        data: {
          rosterId: candidate.id,
          rosterName: candidate.name,
          listUrl: `https://www.newrecruit.eu/app/Lists/${label}`,
          imported: true,
          sessionReused: false,
          verification: null,
          enrichedSummary: inspectEnrichedRosz(archive),
          artifacts: [
            {
              // This is the format emitted by the real New Recruit
              // companion before it enters the persistent cache.
              format: "rosz",
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
      },
    );
  };

  try {
    assert.notEqual(profilePolicyHash(policyA), profilePolicyHash(policyB));
    await storeFixture(player, "player");
    await storeFixture(opponent, "opponent");
    const cachedPlayer = await loadNewRecruitCache(player);
    const cachedOpponent = await loadNewRecruitCache(opponent);
    assert.equal(cachedPlayer?.ok, true);
    assert.equal(cachedPlayer?.data?.sessionReused, true);
    assert.equal(cachedOpponent?.ok, true);
    assert.equal(cachedOpponent?.data?.sessionReused, true);

    const changedPlayer: RosterDraftV1 = {
      ...player,
      forceDispositionId: `${player.forceDispositionId}-changed`,
    };
    assert.notEqual(
      newRecruitCacheKey(changedPlayer),
      newRecruitCacheKey(player),
    );
    assert.equal(await loadNewRecruitCache(changedPlayer), null);
    assert.equal((await loadNewRecruitCache(opponent))?.ok, true);
  } finally {
    if (previousSupport === undefined) {
      delete process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
    } else {
      process.env.ROSTERPILOT_SUPPORT_DIRECTORY = previousSupport;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("sanitized live-run fixture covers the observed reliability failures", async () => {
  const filename = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "tessera-v2",
    "unknown-aeldari-live-run.sanitized.json",
  );
  const text = await readFile(filename, "utf8");
  const fixture = JSON.parse(text) as {
    sanitized: boolean;
    alternateProfiles: unknown[];
    premiumFailures: Array<{ code: string }>;
    duplicatePayloads: { sameSimulationFingerprint: boolean };
    zeroConfidentEvidence: {
      offensiveCoverage: number | null;
      provisional: { offensivePointCoverage: number };
    };
    retryState: {
      attemptCount: number;
      attemptHistory: unknown[];
    };
  };
  assert.equal(fixture.sanitized, true);
  assert.equal(fixture.alternateProfiles.length, 2);
  assert.deepEqual(
    fixture.premiumFailures.map((failure) => failure.code),
    [
      "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
      "TESSERA_PREMIUM_STILL_LOCKED",
    ],
  );
  assert.equal(
    fixture.duplicatePayloads.sameSimulationFingerprint,
    true,
  );
  assert.equal(fixture.zeroConfidentEvidence.offensiveCoverage, null);
  assert.ok(
    fixture.zeroConfidentEvidence.provisional
      .offensivePointCoverage > 0,
  );
  assert.equal(fixture.retryState.attemptCount, 3);
  assert.equal(fixture.retryState.attemptHistory.length, 3);
  assert.doesNotMatch(
    text,
    /(?:license[_ -]?key|\/Users\/|newrecruit\.eu\/app\/Lists\/)/i,
  );
});
