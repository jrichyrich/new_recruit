import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectEnrichedProfileRequirements,
  inspectEnrichedRosz,
  type ProfilePolicyV1,
} from "../lib/rosterpilot";
import { runTesseraThroughLocalAgent } from "../local/agent/client";
import {
  deterministicRenamedMirrorRosz,
} from "../local/certification/mirror-rosz";
import {
  ProfilePolicySchema,
  validateProfilePolicy,
} from "../local/tessera/profile-policy";

const enabled = process.env.ROSTERPILOT_TESSERA_LIVE_TESTS === "1";
const playerRoszPath = process.env.ROSTERPILOT_TESSERA_PLAYER_ROSZ;
const profilePolicyPath =
  process.env.ROSTERPILOT_TESSERA_PROFILE_POLICY_PATH;

async function loadProfilePolicy(): Promise<ProfilePolicyV1 | null> {
  if (!profilePolicyPath) return null;
  const content = await readFile(path.resolve(profilePolicyPath), "utf8");
  const parsed = ProfilePolicySchema.safeParse(JSON.parse(content));
  assert.equal(
    parsed.success,
    true,
    "ROSTERPILOT_TESSERA_PROFILE_POLICY_PATH must reference a canonical v1 Tessera profile policy.",
  );
  return parsed.data!;
}

test(
  "live Tessera local agent captures the complete full-mode scenario set",
  {
    skip: !enabled || !playerRoszPath,
    timeout: 10 * 60_000,
  },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-tessera-live-test-"),
    );
    try {
      const player = await readFile(path.resolve(playerRoszPath!));
      const playerSummary = inspectEnrichedRosz(player);
      assert.ok(playerSummary.profileCount > 0);
      assert.ok(playerSummary.weaponProfileCount > 0);
      const profilePolicy = await loadProfilePolicy();
      const policyFactions = new Set(
        profilePolicy?.entries.map((entry) => entry.faction) ?? [],
      );
      assert.ok(
        policyFactions.size <= 1,
        "The renamed-mirror live test accepts a profile policy for exactly one faction.",
      );
      const profileRequirements = inspectEnrichedProfileRequirements(
        player,
        [...policyFactions][0] ?? playerSummary.factionName,
      );
      const policyValidation = validateProfilePolicy(
        profileRequirements,
        profilePolicy,
      );
      assert.equal(
        policyValidation.valid,
        true,
        [
          profileRequirements.length > 0 && !profilePolicy
            ? "This enriched roster has alternate weapon profiles. Set ROSTERPILOT_TESSERA_PROFILE_POLICY_PATH to an explicit canonical v1 policy before running the live test."
            : "The supplied Tessera profile policy does not match the enriched roster.",
          ...policyValidation.errors,
          ...policyValidation.unresolved.map(
            (requirement) =>
              `Unresolved: ${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase} (${requirement.availableProfiles.join(", ")})`,
          ),
        ].join("\n"),
      );
      const opponentName = `${playerSummary.rosterName} Live Mirror`;
      const opponent = deterministicRenamedMirrorRosz(
        player,
        opponentName,
      );
      const opponentSummary = inspectEnrichedRosz(opponent);
      assert.equal(opponentSummary.totalPoints, playerSummary.totalPoints);

      const result = await runTesseraThroughLocalAgent({
        playerFilename: "player-live.rosz",
        playerRoszBase64: player.toString("base64"),
        playerName: playerSummary.rosterName,
        opponentFilename: "opponent-live.rosz",
        opponentRoszBase64: Buffer.from(opponent).toString("base64"),
        opponentName,
        analysisMode: "full",
        phases: ["shooting", "fight"],
        metrics: [
          "wipe-probability",
          "half-wipe-probability",
          "mean-kills",
          "mean-damage",
        ],
        profilePolicy,
      });

      assert.equal(
        result.scenarios.length,
        16,
        [
          `Captured: ${result.scenarios.map((scenario) => scenario.id).join(", ")}`,
          `Warnings: ${result.warnings.join(" | ")}`,
        ].join("\n"),
      );
      assert.equal(
        new Set(result.scenarios.map((scenario) => scenario.id)).size,
        16,
      );
      assert.ok(
        result.scenarios.every(
          (scenario) =>
            scenario.cells.length > 0 &&
            scenario.iterations !== null,
        ),
      );
      assert.deepEqual(
        new Set(result.scenarios.map((scenario) => scenario.phase)),
        new Set(["shooting", "fight"]),
      );
      assert.deepEqual(
        new Set(result.scenarios.map((scenario) => scenario.direction)),
        new Set(["player-to-opponent", "opponent-to-player"]),
      );
      assert.deepEqual(
        new Set(result.scenarios.map((scenario) => scenario.metric)),
        new Set([
          "wipe-probability",
          "half-wipe-probability",
          "mean-kills",
          "mean-damage",
        ]),
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /licenseKey|credential|profileDirectory|RoszPath|Base64/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
