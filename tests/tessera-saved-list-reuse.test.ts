import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runTesseraBrowserMatchup } from "../local/tessera/browser";
import {
  createTesseraSavedListReuse,
  deterministicTesseraSavedListName,
  scopedTesseraProfilePolicySha256,
  tesseraSavedListReuseValidationError,
  type TesseraSavedListReuseSide,
} from "../local/tessera/saved-list-reuse";

const fixture: TesseraSavedListReuseSide = {
  runId: "certification-run-fixture",
  enrichedRoszSha256: "a".repeat(64),
  scopedProfilePolicySha256: "b".repeat(64),
  profilePolicyEntryKeys: [],
  rosterExecutionFingerprint: "c".repeat(64),
  expectedUnitCount: 9,
};

test("Tessera certification list names are deterministic and expose only a safe digest", () => {
  const player = deterministicTesseraSavedListName("player", fixture);
  assert.equal(
    player,
    deterministicTesseraSavedListName("player", { ...fixture }),
  );
  assert.match(player, /^RP-CERT-A-[0-9a-f]{24}$/);
  assert.doesNotMatch(
    player,
    /certification-run-fixture|a{8}|b{8}|c{8}/,
  );
  assert.notEqual(
    player,
    deterministicTesseraSavedListName("opponent", fixture),
  );
  assert.notEqual(
    player,
    deterministicTesseraSavedListName("player", {
      ...fixture,
      runId: "another-run",
    }),
  );
  assert.notEqual(
    player,
    deterministicTesseraSavedListName("player", {
      ...fixture,
      scopedProfilePolicySha256: "d".repeat(64),
    }),
  );
});

test("Tessera saved-list identities give an explicit policy-free scope a stable hash", () => {
  const noPolicy = scopedTesseraProfilePolicySha256(null);
  assert.match(noPolicy, /^[0-9a-f]{64}$/);
  assert.equal(noPolicy, scopedTesseraProfilePolicySha256(undefined));
  assert.notEqual(
    noPolicy,
    scopedTesseraProfilePolicySha256({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: [],
    }),
  );
});

test("Tessera exact children freeze one shared run and policy identity", () => {
  const reuse = createTesseraSavedListReuse({
    runId: "shared-stress-run",
    profilePolicy: null,
    player: {
      enrichedRoszSha256: "a".repeat(64),
      rosterExecutionFingerprint: "b".repeat(64),
      expectedUnitCount: 12,
    },
    opponent: {
      enrichedRoszSha256: "c".repeat(64),
      rosterExecutionFingerprint: "d".repeat(64),
      expectedUnitCount: 8,
    },
    playerProfileRequirements: [],
    opponentProfileRequirements: [],
  });
  assert.equal(reuse.player.runId, "shared-stress-run");
  assert.equal(reuse.opponent.runId, "shared-stress-run");
  assert.equal(
    reuse.player.scopedProfilePolicySha256,
    reuse.opponent.scopedProfilePolicySha256,
  );
  assert.equal(reuse.player.expectedUnitCount, 12);
  assert.equal(reuse.opponent.expectedUnitCount, 8);
});

test("Tessera saved-list identities scope profile choices to the roster side", () => {
  const playerRequirement = {
    faction: "adeptus-custodes",
    unit: "Blade Champion",
    selectionId: "blade-champion",
    weaponGroup: "Vaultswords",
    phase: "fight" as const,
    availableProfiles: ["Behemor", "Hurricanis"],
    activeCount: 1,
    selectedProfile: null,
  };
  const opponentRequirement = {
    faction: "aeldari",
    unit: "Fire Prism",
    selectionId: "fire-prism",
    weaponGroup: "Prism cannon",
    phase: "shooting" as const,
    availableProfiles: ["Dispersed", "Focused lances"],
    activeCount: 1,
    selectedProfile: null,
  };
  const playerPolicyEntry = {
    faction: playerRequirement.faction,
    unit: playerRequirement.unit,
    weaponGroup: playerRequirement.weaponGroup,
    phase: playerRequirement.phase,
    selectedProfile: "Hurricanis",
    activeCount: 1,
  };
  const create = (opponentProfile: string) =>
    createTesseraSavedListReuse({
      runId: "shared-stress-run",
      profilePolicy: {
        schemaVersion: 1,
        policyKind: "tessera-profile-policy",
        entries: [
          playerPolicyEntry,
          {
            faction: opponentRequirement.faction,
            unit: opponentRequirement.unit,
            weaponGroup: opponentRequirement.weaponGroup,
            phase: opponentRequirement.phase,
            selectedProfile: opponentProfile,
            activeCount: 1,
          },
        ],
      },
      player: {
        enrichedRoszSha256: "a".repeat(64),
        rosterExecutionFingerprint: "b".repeat(64),
        expectedUnitCount: 12,
      },
      opponent: {
        enrichedRoszSha256: "c".repeat(64),
        rosterExecutionFingerprint: "d".repeat(64),
        expectedUnitCount: 8,
      },
      playerProfileRequirements: [playerRequirement],
      opponentProfileRequirements: [opponentRequirement],
    });
  const focused = create("Focused lances");
  const dispersed = create("Dispersed");
  assert.equal(
    focused.player.scopedProfilePolicySha256,
    dispersed.player.scopedProfilePolicySha256,
  );
  assert.equal(
    deterministicTesseraSavedListName("player", focused.player),
    deterministicTesseraSavedListName("player", dispersed.player),
  );
  assert.notEqual(
    focused.opponent.scopedProfilePolicySha256,
    dispersed.opponent.scopedProfilePolicySha256,
  );
  assert.notEqual(
    deterministicTesseraSavedListName("opponent", focused.opponent),
    deterministicTesseraSavedListName("opponent", dispersed.opponent),
  );
});

test("Tessera saved-list reuse rejects incomplete identity inputs before browser work", () => {
  assert.equal(tesseraSavedListReuseValidationError(fixture), null);
  assert.match(
    tesseraSavedListReuseValidationError({
      ...fixture,
      enrichedRoszSha256: "not-a-hash",
    }) ?? "",
    /SHA-256/,
  );
  assert.match(
    tesseraSavedListReuseValidationError({
      ...fixture,
      expectedUnitCount: 0,
    }) ?? "",
    /positive integer/,
  );
  assert.match(
    tesseraSavedListReuseValidationError({
      ...fixture,
      profilePolicyEntryKeys: ["duplicate", "duplicate"],
    }) ?? "",
    /unique/,
  );
});

test("Tessera saved-list reuse verifies archive and policy hashes before launching a browser", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-reuse-preflight-"),
  );
  const player = path.join(directory, "player.rosz");
  const opponent = path.join(directory, "opponent.rosz");
  await writeFile(player, "player");
  await writeFile(opponent, "opponent");
  try {
    await assert.rejects(
      runTesseraBrowserMatchup({
        profileDirectory: path.join(directory, "profile"),
        playerRoszPath: player,
        playerName: "Player",
        opponentRoszPath: opponent,
        opponentName: "Opponent",
        savedListReuse: {
          schemaVersion: 1,
          player: {
            ...fixture,
            enrichedRoszSha256: "0".repeat(64),
          },
          opponent: {
            ...fixture,
            enrichedRoszSha256: "1".repeat(64),
          },
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_SAVED_LIST_REUSE_INVALID" &&
        /content hash/.test(error.message),
    );
    await assert.rejects(
      runTesseraBrowserMatchup({
        profileDirectory: path.join(directory, "profile"),
        playerRoszPath: player,
        playerName: "Player",
        opponentRoszPath: opponent,
        opponentName: "Opponent",
        savedListReuse: {
          schemaVersion: 1,
          player: {
            ...fixture,
            enrichedRoszSha256: createHash("sha256")
              .update("player")
              .digest("hex"),
            profilePolicyEntryKeys: ["missing|policy|entry"],
          },
          opponent: {
            ...fixture,
            enrichedRoszSha256: createHash("sha256")
              .update("opponent")
              .digest("hex"),
          },
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_SAVED_LIST_REUSE_INVALID" &&
        /not present/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
