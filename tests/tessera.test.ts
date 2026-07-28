import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  buildRoster,
  inspectEnrichedRosz,
  validateEnrichedRosz,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import {
  analyzeRosterMatchup,
  prepareRosterForTessera,
} from "../local/tessera/companion";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import {
  parseTesseraMatrixTable,
  runTesseraBrowserMatchup,
} from "../local/tessera/browser";

const chrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const runBrowserTests =
  process.env.ROSTERPILOT_BROWSER_TESTS === "1" &&
  (await access(chrome).then(
    () => true,
    () => false,
  ));

function fixtureRosz(generatedBy = "https://newrecruit.eu"): Uint8Array {
  const xml = `<?xml version="1.0"?>
<roster name="Fixture Army" generatedBy="${generatedBy}">
  <cost name="pts" value="100"/>
  <forces><force name="Imperium - Adeptus Custodes" catalogueName="Imperium - Adeptus Custodes">
    <selections>
      <selection name="Blade Champion" number="1" type="model"/>
      <selection name="Custodian Guard" number="1" type="unit"><selections>
        <selection name="Custodian Guard (Guardian Spear)" number="5" type="model"/>
      </selections></selection>
    </selections>
  </force></forces>
  <profiles>
    <profile name="Blade Champion" typeName="Unit"/>
    <profile name="Vaultswords" typeName="Melee Weapons"/>
  </profiles>
</roster>`;
  return zipSync({ "fixture.ros": strToU8(xml) });
}

test("validates a New Recruit enriched roster and exact model multiset", () => {
  const summary = validateEnrichedRosz(fixtureRosz(), {
    name: "Fixture Army",
    factionName: "Adeptus Custodes",
    totalPoints: 100,
    units: [
      { name: "Blade Champion", modelCount: 1 },
      { name: "Custodian Guard", modelCount: 5 },
    ],
  });
  assert.equal(summary.profileCount, 2);
  assert.equal(summary.weaponProfileCount, 1);
  assert.deepEqual(summary.units, [
    { name: "Blade Champion", modelCount: 1 },
    { name: "Custodian Guard", modelCount: 5 },
  ]);
  assert.throws(
    () =>
      validateEnrichedRosz(fixtureRosz("RosterPilot"), {
        name: "Fixture Army",
        factionName: "Adeptus Custodes",
        totalPoints: 100,
        units: [{ name: "Blade Champion", modelCount: 1 }],
      }),
    /failed verification/i,
  );
});

test("parses directional Tessera matrix metrics without inventing missing values", () => {
  assert.deepEqual(
    parseTesseraMatrixTable([
      ["Attacker", "Target A", "Target B"],
      ["Unit One", "Kill 65% · 8.5 damage · 4.2 / 100", "3.1 dmg"],
    ]),
    [
      {
        attacker: "Unit One",
        target: "Target A",
        killProbability: 0.65,
        expectedDamage: 8.5,
        damagePer100Points: 4.2,
      },
      {
        attacker: "Unit One",
        target: "Target B",
        killProbability: null,
        expectedDamage: 3.1,
        damagePer100Points: null,
      },
    ],
  );
});

function fakeSummary(roster: RosterDraftV1): EnrichedRoszSummary {
  return {
    rosterName: roster.name,
    factionName: roster.factionName,
    totalPoints: roster.totalPoints,
    generatedBy: "https://newrecruit.eu",
    profileCount: 2,
    weaponProfileCount: 1,
    units: roster.units.map((unit) => ({
      name: unit.name,
      modelCount: unit.modelCount,
    })),
  };
}

function deliveryFor(
  roster: RosterDraftV1,
  outputDirectory: string,
): ResultEnvelope<NewRecruitDelivery> {
  return {
    ok: true,
    data: {
      rosterId: roster.id,
      rosterName: roster.name,
      listUrl: "https://www.newrecruit.eu/app/Lists/fixture",
      imported: true,
      sessionReused: true,
      verification: {
        name: true,
        faction: true,
        points: true,
        units: roster.units.map((unit) => ({ ...unit, matched: true })),
        mismatches: [],
      },
      enrichedSummary: fakeSummary(roster),
      artifacts: [
        {
          format: "rosz",
          filename: "source.rosz",
          mimeType: "application/zip",
          written: path.join(outputDirectory, "source.rosz"),
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: "enriched.rosz",
          mimeType: "application/zip",
          written: path.join(outputDirectory, "enriched.rosz"),
        },
      ],
    },
    violations: [],
    warnings: [],
  };
}

test("prepares enriched handoff and writes a handoff-only matchup report", async () => {
  const player = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: "Player",
  }).data!;
  const opponent = buildRoster({
    faction: "necrons",
    pointsLimit: 1000,
    name: "Opponent",
  }).data!;
  const directory = await mkdtemp(path.join(os.tmpdir(), "tessera-test-"));
  const deliver = async (
    roster: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ) => deliveryFor(roster, options.outputDirectory ?? directory);
  try {
    const prepared = await prepareRosterForTessera(
      player,
      { outputDirectory: path.join(directory, "prepare") },
      { deliver },
    );
    assert.equal(prepared.ok, true);
    assert.equal(prepared.data?.summary.generatedBy, "https://newrecruit.eu");

    const report = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        outputDirectory: path.join(directory, "report"),
        allowOutsideRoot: true,
      },
      { deliver },
    );
    assert.equal(report.ok, true);
    assert.equal(report.data?.status, "partial");
    assert.equal(report.data?.source, "handoff-only");
    assert.match(
      await readFile(report.data!.artifacts[0].written, "utf8"),
      /not a game win probability/i,
    );
    assert.equal(inspectEnrichedRosz(fixtureRosz()).weaponProfileCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "experimental Tessera browser adapter imports two rosters and extracts the matrix",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tessera-browser-"));
    const player = path.join(directory, "player.rosz");
    const opponent = path.join(directory, "opponent.rosz");
    await writeFile(player, fixtureRosz());
    await writeFile(opponent, fixtureRosz());
    try {
      const result = await runTesseraBrowserMatchup(
        {
          profileDirectory: path.join(directory, "profile"),
          playerRoszPath: player,
          playerName: "Player",
          opponentRoszPath: opponent,
          opponentName: "Opponent",
          licenseKey: "fixture-tessera-key-never-return",
        },
        {
          baseUrl: "https://tessera.test/",
          headless: true,
          prepareContext: async (context) => {
            await context.route("https://tessera.test/**", async (route) => {
              await route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: `<!doctype html><html><body><main></main>
<script>
let imports = 0;
let premium = false;
function roster() {
  document.querySelector("main").innerHTML =
    '<h1>Roster</h1><button id="import">Import .rosz</button><input id="file" hidden type="file"><button id="tactica">Tactica</button>';
  document.querySelector("#import").onclick = () => document.querySelector("#file").click();
  document.querySelector("#file").onchange = review;
  document.querySelector("#tactica").onclick = () => {
    document.querySelector("main").insertAdjacentHTML("beforeend", '<button id="matrix">' + (premium ? 'Army vs Army' : '🔒 Army vs Army') + '</button>');
    document.querySelector("#matrix").onclick = () => {
      if (!premium) {
        document.querySelector("main").innerHTML =
          '<h1>Unlock Premium</h1><input aria-label="Licence key"><button id="unlock" disabled>Unlock</button><button id="done">Done</button>';
        const key = document.querySelector('input[aria-label="Licence key"]');
        key.oninput = () => { document.querySelector("#unlock").disabled = !key.value; };
        document.querySelector("#unlock").onclick = () => { premium = true; };
        document.querySelector("#done").onclick = roster;
        return;
      }
      document.querySelector("main").innerHTML =
        '<h1>Army vs Army</h1>' +
        '<select aria-label="lista group"><option>Choose a list / faction…</option><option value="player">☰ Player (1)</option><option value="opponent">☰ Opponent (1)</option></select>' +
        '<select aria-label="listb group"><option>Choose a list / faction…</option><option value="player">☰ Player (1)</option><option value="opponent">☰ Opponent (1)</option></select>' +
        '<button id="compare">⚔ Compare lists</button>';
      document.querySelector("#compare").onclick = () => {
        document.querySelector("main").insertAdjacentHTML(
          "beforeend",
          '<button id="forward" aria-pressed="true">A → B</button><button id="reverse" aria-pressed="false">B → A</button>' +
          '<button aria-pressed="true">Shooting</button><button id="wiped" aria-pressed="false">P(wiped)</button>' +
          '<table><tr><th>Attacker</th><th>Target</th></tr><tr><th>Player Unit</th><td>Kill 65% · 8.5 damage · 4.2 / 100</td></tr></table>',
        );
        document.querySelector("#wiped").onclick = (event) => {
          event.currentTarget.setAttribute("aria-pressed", "true");
        };
        document.querySelector("#reverse").onclick = () => {
          document.querySelector("#forward").setAttribute("aria-pressed", "false");
          document.querySelector("#reverse").setAttribute("aria-pressed", "true");
          document.querySelector("table").outerHTML =
            '<table><tr><th>Attacker</th><th>Player Unit</th></tr><tr><th>Opponent Unit</th><td>Kill 55% · 7.5 damage · 3.2 / 100</td></tr></table>';
        };
      };
    };
  };
}
function review() {
  document.querySelector("main").innerHTML =
    '<h1>Review import</h1><p>1 warning</p><p>alternate profiles are unverified</p><button id="add">Add 1</button>';
  document.querySelector("#add").onclick = () => { imports += 1; roster(); };
}
function tactica() {
  document.querySelector("main").innerHTML =
    '<h1>Tactica</h1><button id="muster">Muster</button>';
  document.querySelector("#muster").onclick = roster;
}
document.querySelector("main").innerHTML =
  '<h1>Welcome to Tessera</h1><button id="welcome">GOT IT</button>';
document.querySelector("#welcome").onclick = tactica;
</script></body></html>`,
              });
            });
          },
        },
      );
      assert.equal(result.cells.length, 2);
      assert.equal(result.cells[0].killProbability, 0.65);
      assert.equal(result.cells[0].direction, "player-to-opponent");
      assert.equal(result.cells[1].killProbability, 0.55);
      assert.equal(result.cells[1].direction, "opponent-to-player");
      assert.equal(result.settings.phase, "Shooting");
      assert.equal(result.settings.metric, "P(wiped)");
      assert.match(result.warnings.join(" "), /alternate profiles/i);
      assert.doesNotMatch(
        JSON.stringify(result),
        /fixture-tessera-key-never-return/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
