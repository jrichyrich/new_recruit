import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runTesseraBrowserMatchup } from "../local/tessera/browser";
import {
  deterministicTesseraSavedListName,
  scopedTesseraProfilePolicySha256,
  tesseraSavedListReuseValidationError,
  type TesseraSavedListReuseSide,
} from "../local/tessera/saved-list-reuse";

const fixture: TesseraSavedListReuseSide = {
  runId: "certification-run-fixture",
  enrichedRoszSha256: "a".repeat(64),
  scopedProfilePolicySha256: "b".repeat(64),
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
