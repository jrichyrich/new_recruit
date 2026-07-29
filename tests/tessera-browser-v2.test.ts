import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runTesseraBrowserMatchup,
  TESSERA_DIRECTIONS,
  TESSERA_METRICS,
  TESSERA_PHASES,
} from "../local/tessera/browser";

const chrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const runBrowserTests =
  process.env.ROSTERPILOT_BROWSER_TESTS === "1" &&
  (await access(chrome).then(
    () => true,
    () => false,
  ));

function fixturePage(
  staleMeanKills: boolean,
  delayedPremium = false,
  alternateProfile = false,
  rejectPremium = false,
): string {
  return `<!doctype html><html><body><main>
<h1>Roster</h1>
<button id="import">Import .rosz</button>
<input id="file" hidden type="file">
<button id="tactica">Tactica</button>
</main>
<script>
let imports = 0;
const staleMeanKills = ${JSON.stringify(staleMeanKills)};
const delayedPremium = ${JSON.stringify(delayedPremium)};
const alternateProfile = ${JSON.stringify(alternateProfile)};
const rejectPremium = ${JSON.stringify(rejectPremium)};
let premiumUnlocked = !delayedPremium;
function showRoster() {
  document.querySelector("main").innerHTML =
    '<h1>Roster</h1><button id="import">Import .rosz</button><input id="file" hidden type="file"><button id="tactica">Tactica</button>';
  document.querySelector("#import").onclick = () => document.querySelector("#file").click();
  document.querySelector("#file").onchange = showReview;
  document.querySelector("#tactica").onclick = () => {
    document.querySelector("main").insertAdjacentHTML("beforeend", '<button id="matrix">' + (premiumUnlocked ? 'Army vs Army' : '🔒 Army vs Army premium') + '</button>');
    document.querySelector("#matrix").onclick = premiumUnlocked ? showArmySelection : showUnlock;
  };
}
function showUnlock() {
  document.querySelector("main").innerHTML =
    '<label>License key<input aria-label="License key"></label><button id="unlock">Unlock</button>';
  document.querySelector("#unlock").onclick = () => {
    if (rejectPremium) {
      document.querySelector("main").innerHTML = "<p>Invalid license key</p>";
      return;
    }
    setTimeout(() => {
      premiumUnlocked = true;
      showRoster();
    }, 1200);
  };
}
function showReview() {
  const side = imports === 0 ? "Player" : "Opponent";
  const warning =
    alternateProfile && side === "Player"
      ? '<p>Warning: alternate profile "Vaultswords"; unit Blade Champion; profiles: Behemor, Hurricanis; melee</p>' +
        '<label>Blade Champion Vaultswords<select><option>Behemor</option><option>Hurricanis</option></select></label>'
      : '<p>Warning: ' + side + ' import metadata is unverified</p>';
  document.querySelector("main").innerHTML =
    '<h1>Review import</h1>' + warning + '<button id="add">Add 2</button>';
  document.querySelector("#add").onclick = () => {
    imports += 1;
    showRoster();
  };
}
function showArmySelection() {
  document.querySelector("main").innerHTML =
    '<h1>Army vs Army</h1>' +
    '<select aria-label="lista group"><option>Choose…</option><option value="player">Player (2)</option><option value="opponent">Opponent (2)</option></select>' +
    '<select aria-label="listb group"><option>Choose…</option><option value="player">Player (2)</option><option value="opponent">Opponent (2)</option></select>' +
    '<button id="compare">Compare lists</button>';
  document.querySelector("#compare").onclick = () => {
    setTimeout(showMatrix, 80);
  };
}
const state = {
  phase: "shooting",
  metric: "wipe-probability",
  direction: "player-to-opponent",
};
const labels = {
  shooting: "Shooting",
  fight: "Fight",
  "wipe-probability": "P(wiped)",
  "half-wipe-probability": "P(≥half wiped)",
  "mean-kills": "Mean kills",
  "mean-damage": "Mean damage",
  "player-to-opponent": "A → B",
  "opponent-to-player": "B → A",
};
function showMatrix() {
  document.querySelector("main").insertAdjacentHTML(
    "beforeend",
    '<section id="controls">' +
    '<button data-group="phase" data-value="shooting" aria-pressed="true">Shooting</button>' +
    '<button data-group="phase" data-value="fight" aria-pressed="false">Fight</button>' +
    '<button data-group="metric" data-value="wipe-probability" aria-pressed="true">P(wiped)</button>' +
    '<button data-group="metric" data-value="half-wipe-probability" aria-pressed="false">P(≥half wiped)</button>' +
    '<button data-group="metric" data-value="mean-kills" aria-pressed="false">Mean kills</button>' +
    '<button data-group="metric" data-value="mean-damage" aria-pressed="false">Mean damage</button>' +
    '<button data-group="direction" data-value="player-to-opponent" aria-pressed="true">A → B</button>' +
    '<button data-group="direction" data-value="opponent-to-player" aria-pressed="false">B → A</button>' +
    '<p>1,000 iterations</p></section><div id="matrix-result"></div>',
  );
  document.querySelectorAll("#controls button").forEach((button) => {
    button.onclick = () => {
      const group = button.dataset.group;
      document.querySelectorAll('#controls button[data-group="' + group + '"]').forEach((peer) => {
        peer.setAttribute("aria-pressed", peer === button ? "true" : "false");
      });
      state[group] = button.dataset.value;
      if (!(staleMeanKills && state.metric === "mean-kills")) {
        setTimeout(renderTable, 40);
      }
    };
  });
  renderTable();
}
function renderedValue(row, column) {
  const phaseOffset = state.phase === "fight" ? 30 : 0;
  const directionOffset = state.direction === "opponent-to-player" ? 10 : 0;
  const metricOffset = {
    "wipe-probability": 0,
    "half-wipe-probability": 4,
    "mean-kills": 8,
    "mean-damage": 12,
  }[state.metric];
  const value = phaseOffset + directionOffset + metricOffset + row * 2 + column + 1;
  if (state.metric === "wipe-probability" || state.metric === "half-wipe-probability") {
    return value + "%";
  }
  if (state.metric === "mean-kills") return (value / 10).toFixed(1) + " kills";
  return (value / 10).toFixed(1) + " damage";
}
function renderTable() {
  const attackers =
    state.direction === "player-to-opponent"
      ? ["Allarus Custodians", "Allarus Custodians"]
      : ["Warriors", "Warriors"];
  const targets =
    state.direction === "player-to-opponent"
      ? ["Warriors", "Warriors"]
      : ["Allarus Custodians", "Allarus Custodians"];
  document.querySelector("#matrix-result").innerHTML =
    '<table><tr><th>Attacker</th><th>' + targets[0] + '</th><th>' + targets[1] + '</th></tr>' +
    '<tr><th>' + attackers[0] + '</th><td>' + renderedValue(0, 0) + '</td><td>' + renderedValue(0, 1) + '</td></tr>' +
    '<tr><th>' + attackers[1] + '</th><td>' + renderedValue(1, 0) + '</td><td>' + renderedValue(1, 1) + '</td></tr></table>';
}
showRoster();
</script></body></html>`;
}

async function runFixture(
  staleMeanKills: boolean,
  delayedPremium = false,
  alternateProfile = false,
  rejectPremium = false,
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-browser-v2-"),
  );
  const player = path.join(directory, "player.rosz");
  const opponent = path.join(directory, "opponent.rosz");
  await writeFile(player, "player");
  await writeFile(opponent, "opponent");
  try {
    return await runTesseraBrowserMatchup(
      {
        profileDirectory: path.join(directory, "profile"),
        playerRoszPath: player,
        playerName: "Player",
        opponentRoszPath: opponent,
        opponentName: "Opponent",
        analysisMode: "full",
        licenseKey: delayedPremium ? "fixture-premium-key" : undefined,
        profilePolicy: alternateProfile
          ? {
              schemaVersion: 1,
              policyKind: "tessera-profile-policy",
              entries: [
                {
                  faction: "adeptus-custodes",
                  unit: "Blade Champion",
                  weaponGroup: "Vaultswords",
                  phase: "fight",
                  selectedProfile: "Hurricanis",
                  activeCount: 1,
                },
              ],
            }
          : undefined,
      },
      {
        baseUrl: "https://tessera-v2.test/",
        headless: true,
        timeoutMs: 1_000,
        prepareContext: async (context) => {
          await context.route("https://tessera-v2.test/**", async (route) => {
            await route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: fixturePage(
                staleMeanKills,
                delayedPremium,
                alternateProfile,
                rejectPremium,
              ),
            });
          });
        },
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test(
  "captures delayed full-mode phase, metric, and direction scenarios with duplicate names",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture(false);
    assert.equal(result.scenarios.length, 16);
    assert.equal(new Set(result.scenarios.map((scenario) => scenario.id)).size, 16);
    assert.deepEqual(
      new Set(result.scenarios.map((scenario) => scenario.phase)),
      new Set(TESSERA_PHASES),
    );
    assert.deepEqual(
      new Set(result.scenarios.map((scenario) => scenario.metric)),
      new Set(TESSERA_METRICS),
    );
    assert.deepEqual(
      new Set(result.scenarios.map((scenario) => scenario.direction)),
      new Set(TESSERA_DIRECTIONS),
    );
    for (const scenario of result.scenarios) {
      assert.equal(scenario.iterations, 1_000);
      assert.equal(scenario.settings.iterations, "1000");
      assert.equal(scenario.cells.length, 4);
      assert.deepEqual(
        scenario.cells.map((cell) => [
          cell.attackerIndex,
          cell.targetIndex,
        ]),
        [
          [0, 0],
          [0, 1],
          [1, 0],
          [1, 1],
        ],
      );
      assert.deepEqual(
        scenario.cells.map((cell) => cell.attackerOccurrence),
        [1, 1, 2, 2],
      );
      assert.deepEqual(
        scenario.cells.map((cell) => cell.targetOccurrence),
        [1, 2, 1, 2],
      );
    }
    assert.equal(result.cells.length, 8);
    assert.equal(result.settings.phase, "Shooting");
    assert.equal(result.settings.metric, "P(wiped)");
    assert.deepEqual(result.importWarnings, {
      player: ["Warning: Player import metadata is unverified"],
      opponent: ["Warning: Opponent import metadata is unverified"],
    });
    assert.deepEqual(result.warnings, [
      "Warning: Player import metadata is unverified",
      "Warning: Opponent import metadata is unverified",
    ]);
  },
);

test(
  "waits for a delayed positive premium unlock state",
  { skip: !runBrowserTests },
  async () => {
    const startedAt = Date.now();
    const result = await runFixture(false, true);
    assert.equal(result.scenarios.length, 16);
    assert.ok(Date.now() - startedAt >= 1_000);
  },
);

test(
  "returns a distinct error when Tessera rejects the premium key",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () => runFixture(false, true, false, true),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_PREMIUM_KEY_REJECTED",
    );
  },
);

test(
  "applies a frozen profile policy and returns structured import issues",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture(false, false, true);
    const playerIssue = result.importIssues?.find(
      (issue) => issue.side === "player",
    );
    assert.equal(playerIssue?.code, "alternate-profile");
    assert.equal(playerIssue?.unit, "Blade Champion");
    assert.equal(playerIssue?.weaponGroup, "Vaultswords");
    assert.equal(playerIssue?.phase, "fight");
    assert.deepEqual(playerIssue?.availableProfiles, [
      "Behemor",
      "Hurricanis",
    ]);
    assert.equal(playerIssue?.resolvedByPolicy, true);
  },
);

test(
  "preserves successful scenarios and warns when a selected metric leaves a stale matrix",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture(true);
    assert.equal(result.scenarios.length, 12);
    assert.equal(
      result.scenarios.some((scenario) => scenario.metric === "mean-kills"),
      false,
    );
    assert.equal(
      result.scenarios.some((scenario) => scenario.metric === "mean-damage"),
      true,
    );
    assert.equal(result.cells.length, 8);
    assert.deepEqual(result.importWarnings, {
      player: ["Warning: Player import metadata is unverified"],
      opponent: ["Warning: Opponent import metadata is unverified"],
    });
    assert.match(result.warnings.join("\n"), /stale|did not refresh/i);
    assert.match(result.warnings.join("\n"), /mean-kills/i);
  },
);
