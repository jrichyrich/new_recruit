import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { inspectEnrichedRosz } from "../lib/rosterpilot";
import { runTesseraThroughLocalAgent } from "../local/agent/client";

const enabled = process.env.ROSTERPILOT_TESSERA_LIVE_TESTS === "1";
const playerRoszPath = process.env.ROSTERPILOT_TESSERA_PLAYER_ROSZ;

function renamedMirror(
  content: Uint8Array,
  rosterName: string,
): Uint8Array {
  const entries = unzipSync(content);
  const rosterEntries = Object.entries(entries).filter(([filename]) =>
    filename.toLocaleLowerCase().endsWith(".ros"),
  );
  assert.equal(rosterEntries.length, 1);
  const [filename, rosterContent] = rosterEntries[0];
  const xml = strFromU8(rosterContent);
  const escapedName = rosterName
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const renamed = xml.replace(
    /(<roster\b[^>]*\bname=")[^"]*(")/,
    `$1${escapedName}$2`,
  );
  assert.notEqual(renamed, xml, "The mirror roster name was not replaced.");
  return zipSync({
    ...entries,
    [filename]: strToU8(renamed),
  });
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
      const opponentName = `${playerSummary.rosterName} Live Mirror`;
      const opponent = renamedMirror(player, opponentName);
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
