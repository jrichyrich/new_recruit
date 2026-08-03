import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright-core";
import type {
  TesseraImportedArmySemanticSnapshot,
} from "../lib/rosterpilot";

import {
  collectImportedSemanticSurfaceInBrowser,
  invalidatesCachedTesseraLicenseKey,
  parseTesseraCellUncertainty,
  runTesseraBrowserMatchup,
  tesseraDeploymentEvidenceFromObservations,
  tesseraImportSemanticEvidenceFromSnapshots,
  TESSERA_DIRECTIONS,
  TESSERA_METRICS,
  TESSERA_PHASES,
} from "../local/tessera/browser";
import {
  deterministicTesseraSavedListName,
  scopedTesseraProfilePolicySha256,
  type TesseraSavedListReuse,
} from "../local/tessera/saved-list-reuse";
import {
  createTesseraImportedArmySimulationStateBinding,
} from "../local/tessera/website-semantic-evidence";

test("website deployment evidence hashes same-origin script bytes and fails closed on fallbacks", () => {
  const complete = tesseraDeploymentEvidenceFromObservations({
    origin: "https://tessera.example",
    declaredVersion: "2026.8.2",
    declarations: ["/assets/b.js", "/assets/a.js"],
    assets: [
      {
        url: "https://tessera.example/assets/b.js",
        sameOrigin: true,
        sha256: "b".repeat(64),
        byteLength: 200,
        failureCode: null,
      },
      {
        url: "https://tessera.example/assets/a.js",
        sameOrigin: true,
        sha256: "a".repeat(64),
        byteLength: 100,
        failureCode: null,
      },
    ],
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.completeness, "complete");
  assert.match(complete.identitySha256 ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(complete.identitySha256, complete.declarationSha256);
  assert.deepEqual(
    complete.assets.map((asset) => asset.url),
    [
      "https://tessera.example/assets/a.js",
      "https://tessera.example/assets/b.js",
    ],
  );

  const crossOriginBound = tesseraDeploymentEvidenceFromObservations({
    origin: "https://tessera.example",
    declaredVersion: null,
    declarations: ["/assets/a.js", "https://cdn.example/b.js"],
    assets: [
      {
        url: "https://tessera.example/assets/a.js",
        sameOrigin: true,
        sha256: "a".repeat(64),
        byteLength: 100,
        failureCode: null,
      },
      {
        url: "https://cdn.example/b.js",
        sameOrigin: false,
        sha256: null,
        byteLength: null,
        failureCode: "cross-origin",
      },
    ],
  });
  assert.equal(crossOriginBound.complete, true);
  assert.equal(crossOriginBound.completeness, "complete");
  assert.deepEqual(
    crossOriginBound.assets.map((asset) => ({
      url: asset.url,
      sameOrigin: asset.sameOrigin,
      sha256: asset.sha256,
    })),
    [
      {
        url: "https://cdn.example/b.js",
        sameOrigin: false,
        sha256: null,
      },
      {
        url: "https://tessera.example/assets/a.js",
        sameOrigin: true,
        sha256: "a".repeat(64),
      },
    ],
  );

  const partial = tesseraDeploymentEvidenceFromObservations({
    origin: "https://tessera.example",
    declaredVersion: null,
    declarations: [
      "/assets/a.js",
      "/assets/missing.js",
      "https://cdn.example/b.js",
    ],
    assets: [
      ...crossOriginBound.assets.map((asset) => ({
        ...asset,
        byteLength: asset.byteLength ?? null,
        failureCode: asset.sameOrigin ? null : "cross-origin",
      })),
      {
        url: "https://tessera.example/assets/missing.js",
        sameOrigin: true,
        sha256: null,
        byteLength: null,
        failureCode: "fetch-failed",
      },
    ],
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.completeness, "partial");
  assert.ok(
    partial.incompleteReasons.includes(
      "same-origin-script-bytes-unavailable",
    ),
  );

  const fallback = tesseraDeploymentEvidenceFromObservations({
    origin: "file://",
    declaredVersion: null,
    declarations: [],
    assets: [],
  });
  assert.equal(fallback.complete, false);
  assert.equal(fallback.completeness, "fallback");
  assert.equal(fallback.identitySha256, fallback.declarationSha256);
});

test("website matrix uncertainty is preserved only when visibly reported", () => {
  assert.deepEqual(
    parseTesseraCellUncertainty(
      "42% (n=2,000; SD=5%; standard error: 1.2%)",
    ),
    {
      sampleCount: 2_000,
      standardDeviation: 0.05,
      standardError: 0.012,
      completeness: "complete",
    },
  );
  assert.deepEqual(parseTesseraCellUncertainty("n=1,000"), {
    sampleCount: 1_000,
    standardDeviation: null,
    standardError: null,
    completeness: "partial",
  });
  assert.deepEqual(parseTesseraCellUncertainty("42%"), {
    sampleCount: null,
    standardDeviation: null,
    standardError: null,
    completeness: "unavailable",
  });
});

function importedSnapshot(
  side: "player" | "opponent",
  count = 2,
): TesseraImportedArmySemanticSnapshot {
  return {
    schemaVersion: 1,
    side,
    armyName: side === "player" ? "Custodes" : "Aeldari",
    reportedUnitCount: 1,
    units: [{
      occurrence: 1,
      name: side === "player" ? "Custodian Guard" : "Windriders",
      modelCount: count,
      included: true,
      weapons: [{
        occurrence: 1,
        name: side === "player" ? "Guardian spear" : "Shuriken cannon",
        profile: null,
        count,
        visibleCharacteristics: [
          { name: "phase", value: "shooting" },
          { name: "attacks", value: "2" },
          { name: "ballistic skill", value: "2+" },
          { name: "strength", value: "6" },
          { name: "AP", value: "-1" },
          { name: "damage", value: "2" },
          { name: "keywords", value: "none" },
        ],
        effectToggles: [{ name: "lethal hits", state: false }],
      }],
      visibleCharacteristics: [
        { name: "toughness", value: "6" },
        { name: "save", value: "2+" },
        { name: "wounds", value: "3" },
        { name: "invulnerable save", value: "4+" },
      ],
      effectToggles: [{ name: "cover", state: false }],
    }],
    warningCodes: [],
    alternateProfileResolutions: [],
    completeness: "complete",
    incompleteReasons: [],
  };
}

function semanticBindings(
  player: TesseraImportedArmySemanticSnapshot,
  opponent: TesseraImportedArmySemanticSnapshot,
) {
  const bind = (snapshot: TesseraImportedArmySemanticSnapshot) =>
    createTesseraImportedArmySimulationStateBinding(snapshot, {
      side: snapshot.side,
      savedListName: `RP-${snapshot.side}`,
      selectedUnitCount: snapshot.reportedUnitCount ?? 0,
      selectorValue: `list:RP-${snapshot.side}`,
      selectorLabel: `RP-${snapshot.side} · ${snapshot.reportedUnitCount} units`,
    });
  return { player: bind(player), opponent: bind(opponent) };
}

test("import semantic evidence changes with normalized army meaning and never verifies partial capture", () => {
  const completePlayer = importedSnapshot("player");
  const completeOpponent = importedSnapshot("opponent");
  const complete = tesseraImportSemanticEvidenceFromSnapshots(
    completePlayer,
    completeOpponent,
    semanticBindings(completePlayer, completeOpponent),
  );
  assert.equal(complete.complete, true);
  assert.equal(complete.completeness, "complete");
  assert.match(complete.combinedSha256 ?? "", /^[0-9a-f]{64}$/);

  const changedPlayer = importedSnapshot("player", 3);
  const changedOpponent = importedSnapshot("opponent");
  const changed = tesseraImportSemanticEvidenceFromSnapshots(
    changedPlayer,
    changedOpponent,
    semanticBindings(changedPlayer, changedOpponent),
  );
  assert.notEqual(changed.playerSha256, complete.playerSha256);
  assert.notEqual(changed.combinedSha256, complete.combinedSha256);

  const partialPlayer = importedSnapshot("player");
  partialPlayer.completeness = "partial";
  partialPlayer.incompleteReasons = ["unit-editor-coverage:0/1"];
  partialPlayer.units[0].effectToggles[0].state = null;
  const partialOpponent = importedSnapshot("opponent");
  const partial = tesseraImportSemanticEvidenceFromSnapshots(
    partialPlayer,
    partialOpponent,
    semanticBindings(partialPlayer, partialOpponent),
  );
  assert.equal(partial.complete, false);
  assert.equal(partial.completeness, "partial");
  assert.equal(partial.unresolvedEffectCount, 1);
  assert.ok(
    partial.incompleteReasons.includes(
      "player:unit-editor-coverage:0/1",
    ),
  );
});

test("credential failures invalidate a persistent Tessera worker's cached key", () => {
  assert.equal(
    invalidatesCachedTesseraLicenseKey("TESSERA_PREMIUM_KEY_REJECTED"),
    true,
  );
  assert.equal(
    invalidatesCachedTesseraLicenseKey("KEYCHAIN_READ_FAILED"),
    true,
  );
  assert.equal(
    invalidatesCachedTesseraLicenseKey("TESSERA_BROWSER_TIMEOUT"),
    false,
  );
});

test("imported semantic surface callback has no Node-only build helpers", () => {
  const source = Function.prototype.toString.call(
    collectImportedSemanticSurfaceInBrowser,
  );
  assert.doesNotMatch(source, /\b__name\b/);
  assert.doesNotMatch(source, /\b__defProp\b/);
});

const chrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const runBrowserTests =
  process.env.ROSTERPILOT_BROWSER_TESTS === "1" &&
  (await access(chrome).then(
    () => true,
    () => false,
  ));

type FixtureOptions = {
  staleMeanKills?: boolean;
  staleMeanKillsOnce?: boolean;
  delayedPremium?: boolean;
  alternateProfile?:
    | "select"
    | "editor"
    | "duplicate-editor"
    | "split-editor";
  alternateProfileSide?: "Player" | "Opponent";
  profileEditorMismatch?: boolean;
  rejectPremium?: boolean;
  equalAcrossPhases?: boolean;
  equalProbabilityMetrics?: boolean;
  allZeroMatrices?: boolean;
  reuseMatrixNode?: boolean;
  compareDisabled?: boolean;
  sideUnitLimit?: boolean;
  wrongUnitCount?: boolean;
  missingRoszInput?: boolean;
  frozenIterations?: number;
  delayedSelectorHydration?: boolean;
  staleFirstMatrixOpen?: boolean;
  duplicateSavedList?: boolean;
  truncatedSavedLabels?: boolean;
  unrelatedSelectsFirst?: boolean;
  batchScenarioRefresh?: boolean;
  savedNamesOnlyInMatrix?: boolean;
  wrongStableValue?: boolean;
  phaseRequiresCompare?: boolean;
  phaseCompareDoesNotRefresh?: boolean;
  nonRectangularMatrix?: boolean;
  dimensionDrift?: boolean;
  requestedPhases?: readonly ("shooting" | "fight")[];
  requestedMetrics?: readonly (
    | "wipe-probability"
    | "half-wipe-probability"
    | "mean-kills"
    | "mean-damage"
  )[];
  inspectFinalDom?: boolean;
  savedListReuse?: boolean;
  preexistingReuseSides?: readonly ("player" | "opponent")[];
  savedListCapacity?: number;
  initialSavedLists?: Array<{
    name: string;
    unitCount: number;
  }>;
};

function fixturePage(options: FixtureOptions = {}): string {
  return `<!doctype html><html><body><main></main>
<script>
let imports = 0;
const initialSavedLists = ${JSON.stringify(options.initialSavedLists ?? [])};
const savedLists = JSON.parse(
  localStorage.getItem("savedLists") ||
  JSON.stringify(initialSavedLists.map((entry) => entry.name))
);
const savedListUnitCounts = JSON.parse(
  localStorage.getItem("savedListUnitCounts") ||
  JSON.stringify(Object.fromEntries(
    initialSavedLists.map((entry) => [entry.name, entry.unitCount])
  ))
);
const savedListCapacity = ${JSON.stringify(options.savedListCapacity ?? null)};
let matrixOpenCount = Number(sessionStorage.getItem("matrixOpenCount") || "0");
let profileEditorApplied = false;
const duplicateProfileEditorApplied = {};
const staleMeanKills = ${JSON.stringify(options.staleMeanKills ?? false)};
const staleMeanKillsOnce = ${JSON.stringify(options.staleMeanKillsOnce ?? false)};
let staleMeanKillsRefreshesRemaining =
  staleMeanKills ? 3 : staleMeanKillsOnce ? 2 : 0;
const delayedPremium = ${JSON.stringify(options.delayedPremium ?? false)};
const alternateProfile = ${JSON.stringify(options.alternateProfile ?? null)};
const alternateProfileSide = ${JSON.stringify(options.alternateProfileSide ?? "Player")};
const profileEditorMismatch = ${JSON.stringify(options.profileEditorMismatch ?? false)};
const rejectPremium = ${JSON.stringify(options.rejectPremium ?? false)};
const equalAcrossPhases = ${JSON.stringify(options.equalAcrossPhases ?? false)};
const equalProbabilityMetrics = ${JSON.stringify(options.equalProbabilityMetrics ?? false)};
const allZeroMatrices = ${JSON.stringify(options.allZeroMatrices ?? false)};
const reuseMatrixNode = ${JSON.stringify(options.reuseMatrixNode ?? false)};
const compareDisabled = ${JSON.stringify(options.compareDisabled ?? false)};
const sideUnitLimit = ${JSON.stringify(options.sideUnitLimit ?? false)};
const wrongUnitCount = ${JSON.stringify(options.wrongUnitCount ?? false)};
const missingRoszInput = ${JSON.stringify(options.missingRoszInput ?? false)};
const delayedSelectorHydration = ${JSON.stringify(options.delayedSelectorHydration ?? false)};
const staleFirstMatrixOpen = ${JSON.stringify(options.staleFirstMatrixOpen ?? false)};
const duplicateSavedList = ${JSON.stringify(options.duplicateSavedList ?? false)};
const truncatedSavedLabels = ${JSON.stringify(options.truncatedSavedLabels ?? false)};
const unrelatedSelectsFirst = ${JSON.stringify(options.unrelatedSelectsFirst ?? false)};
const batchScenarioRefresh = ${JSON.stringify(options.batchScenarioRefresh ?? false)};
const savedNamesOnlyInMatrix = ${JSON.stringify(options.savedNamesOnlyInMatrix ?? false)};
const wrongStableValue = ${JSON.stringify(options.wrongStableValue ?? false)};
const phaseRequiresCompare = ${JSON.stringify(options.phaseRequiresCompare ?? false)};
const phaseCompareDoesNotRefresh = ${JSON.stringify(options.phaseCompareDoesNotRefresh ?? false)};
const nonRectangularMatrix = ${JSON.stringify(options.nonRectangularMatrix ?? false)};
const dimensionDrift = ${JSON.stringify(options.dimensionDrift ?? false)};
let premiumUnlocked = !delayedPremium;
function showRoster() {
  const rosterInput = missingRoszInput
    ? '<input id="file" hidden type="file" accept=".zip">'
    : '<input id="file" hidden type="file" accept=".rosz,application/zip">';
  const savedEntries = savedNamesOnlyInMatrix
    ? ""
    : savedLists.map((name, index) =>
      '<article><span class="saved-list-name">' + name + '</span><span>' +
      (wrongUnitCount && index === 0
        ? 3
        : (savedListUnitCounts[name] || 2)) +
      ' units</span></article>'
    ).join("");
  document.querySelector("main").innerHTML =
    '<h1>Roster</h1><button id="import">Import .rosz</button>' +
    '<input id="avatar" hidden type="file" accept="image/*">' +
    rosterInput +
    '<section aria-label="Saved lists">' + savedEntries + '</section>' +
    '<button id="tactica">Tactica</button>';
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
    alternateProfile === "select" && side === alternateProfileSide
      ? '<p>Warning: alternate profile "Vaultswords"; unit Blade Champion; profiles: Behemor, Hurricanis; melee</p>' +
        '<label>Blade Champion Vaultswords<select><option>Behemor</option><option>Hurricanis</option></select></label>'
      : alternateProfile === "editor" && side === alternateProfileSide
        ? '<p>Warning: alternate profile "Prism cannon - Dispersed pulse" for Fire Prism; profiles: Dispersed pulse, Focused lances; ranged</p>' +
          '<div class="unit-row"><label><input type="checkbox" aria-label="Include Fire Prism" checked>Fire Prism</label><button id="edit-unit">Edit</button></div>'
      : alternateProfile === "split-editor" && side === alternateProfileSide
        ? '<p>Warning: alternate profile "Manreaper - Strike" for Deathshroud Terminators; profiles: Strike, Sweep; melee</p>' +
          '<div class="unit-row"><label><input type="checkbox" aria-label="Include Deathshroud Terminators, 6 models" checked>Deathshroud Terminators — 6 models</label><button id="edit-unit">Edit</button></div>'
      : alternateProfile === "duplicate-editor" && side === alternateProfileSide
        ? '<p>Warning: alternate profile "Gork’s klaw - Strike" for Gork’s Ladz; profiles: Strike, Sweep; melee</p>' +
          '<div class="unit-row"><label><input type="checkbox" aria-label="Include Gork’s Ladz, 10 models" checked>Gork’s Ladz — 10 models</label><button data-profile-models="10">Edit</button></div>' +
          '<div class="unit-row"><label><input type="checkbox" aria-label="Include Gork’s Ladz, 20 models" checked>Gork’s Ladz — 20 models</label><button data-profile-models="20">Edit</button></div>'
      : '<p>Warning: ' + side + ' import metadata is unverified</p>';
  document.querySelector("main").innerHTML =
    '<h1>Review import</h1>' + warning +
    '<label>Save to list (army name)<input aria-label="Save to list (army name)" value="' + side + '"></label>' +
    '<button id="add">Add 2</button>';
  if (document.querySelector("#edit-unit")) {
    document.querySelector("#edit-unit").onclick = showProfileEditor;
  }
  document.querySelectorAll("[data-profile-models]").forEach((button) => {
    button.onclick = () => showProfileEditor(Number(button.dataset.profileModels));
  });
  document.querySelector("#add").onclick = () => {
    if (
      (alternateProfile === "editor" || alternateProfile === "split-editor") &&
      side === alternateProfileSide &&
      !profileEditorApplied
    ) return;
    if (
      alternateProfile === "duplicate-editor" &&
      side === alternateProfileSide &&
      (!duplicateProfileEditorApplied[10] || !duplicateProfileEditorApplied[20])
    ) return;
    const savedName =
      document.querySelector('input[aria-label="Save to list (army name)"]').value;
    savedLists.push(savedName);
    savedListUnitCounts[savedName] = 2;
    if (
      Number.isSafeInteger(savedListCapacity) &&
      savedListCapacity > 0
    ) {
      while (savedLists.length > savedListCapacity) {
        const removed = savedLists.shift();
        if (removed && !savedLists.includes(removed)) {
          delete savedListUnitCounts[removed];
        }
      }
    }
    localStorage.setItem("savedLists", JSON.stringify(savedLists));
    localStorage.setItem(
      "savedListUnitCounts",
      JSON.stringify(savedListUnitCounts)
    );
    sessionStorage.setItem(
      "importCount",
      String(Number(sessionStorage.getItem("importCount") || "0") + 1)
    );
    imports += 1;
    showRoster();
  };
}
function showProfileEditor(models) {
  if (alternateProfile === "duplicate-editor") {
    document.querySelector("main").innerHTML =
      '<h2>Edit imported unit</h2>' +
      '<div class="weapon-row"><input placeholder="Weapon name" value="Gork’s klaw - Strike"><input type="number" aria-label="Count" value="' + models + '"></div>' +
      '<div class="weapon-row"><input placeholder="Weapon name" value="Gork’s klaw - Sweep"><input type="number" aria-label="Count" value="0"></div>' +
      '<button id="cancel-unit">Cancel</button>' +
      '<button id="save-unit">Save</button>';
    document.querySelector("#cancel-unit").onclick = showReview;
    document.querySelector("#save-unit").onclick = () => {
      const rows = [...document.querySelectorAll(".weapon-row")];
      const counts = Object.fromEntries(rows.map((row) => [
        row.querySelector('[placeholder="Weapon name"]').value,
        row.querySelector('[aria-label="Count"]').value,
      ]));
      const valid =
        models === 10
          ? counts["Gork’s klaw - Strike"] === "0" &&
            counts["Gork’s klaw - Sweep"] === "10"
          : counts["Gork’s klaw - Strike"] === "20" &&
            counts["Gork’s klaw - Sweep"] === "0";
      if (valid) {
        duplicateProfileEditorApplied[models] = true;
        showReview();
      }
    };
    return;
  }
  if (alternateProfile === "split-editor") {
    document.querySelector("main").innerHTML =
      '<h2>Edit imported unit</h2>' +
      '<div class="weapon-row"><input placeholder="Weapon name" value="Manreaper - Strike"><input type="number" aria-label="Count" value="1"></div>' +
      '<div class="weapon-row"><input placeholder="Weapon name" value="Manreaper - Sweep"><input type="number" aria-label="Count" value="0"></div>' +
      '<div class="weapon-row"><input placeholder="Weapon name" value="Manreaper - Strike"><input type="number" aria-label="Count" value="5"></div>' +
      '<div class="weapon-row"><input placeholder="Weapon name" value="Manreaper - Sweep"><input type="number" aria-label="Count" value="0"></div>' +
      '<button id="cancel-unit">Cancel</button>' +
      '<button id="save-unit">Save</button>';
    document.querySelector("#cancel-unit").onclick = showReview;
    document.querySelector("#save-unit").onclick = () => {
      const rows = [...document.querySelectorAll(".weapon-row")];
      const values = rows.map((row) => ({
        name: row.querySelector('[placeholder="Weapon name"]').value,
        count: row.querySelector('[aria-label="Count"]').value,
      }));
      if (
        JSON.stringify(values) === JSON.stringify([
          { name: "Manreaper - Strike", count: "0" },
          { name: "Manreaper - Sweep", count: "1" },
          { name: "Manreaper - Strike", count: "0" },
          { name: "Manreaper - Sweep", count: "5" },
        ])
      ) {
        profileEditorApplied = true;
        showReview();
      }
    };
    return;
  }
  document.querySelector("main").innerHTML =
    '<h2>Edit imported unit</h2>' +
    '<div class="weapon-row"><input placeholder="Weapon name" value="Prism cannon - Dispersed pulse"><input type="number" aria-label="Count" value="1"></div>' +
    (profileEditorMismatch ? '' : '<div class="weapon-row"><input placeholder="Weapon name" value="Prism cannon - Focused lances"><input type="number" aria-label="Count" value="0"></div>') +
    '<button id="cancel-unit">Cancel</button>' +
    '<button id="save-unit">Save</button>';
  document.querySelector("#cancel-unit").onclick = showReview;
  document.querySelector("#save-unit").onclick = () => {
    const rows = [...document.querySelectorAll(".weapon-row")];
    const counts = Object.fromEntries(rows.map((row) => [
      row.querySelector('[placeholder="Weapon name"]').value,
      row.querySelector('[aria-label="Count"]').value,
    ]));
    if (
      counts["Prism cannon - Dispersed pulse"] === "0" &&
      counts["Prism cannon - Focused lances"] === "1"
    ) {
      profileEditorApplied = true;
      showReview();
    }
  };
}
function showArmySelection() {
  matrixOpenCount += 1;
  sessionStorage.setItem("matrixOpenCount", String(matrixOpenCount));
  const optionLabel = (name, index) =>
    "☰ " +
    (truncatedSavedLabels ? name.slice(0, 8) + "…" : name) +
    " (" +
    (wrongUnitCount && index === 0
      ? 3
      : (savedListUnitCounts[name] || 2)) +
    ")";
  const savedOptions = savedLists.flatMap((name, index) => {
    const value =
      wrongStableValue && index === 0 ? "saved-" + index : "list:" + name;
    const option =
      '<option value="' + value + '">' + optionLabel(name, index) + '</option>';
    return duplicateSavedList && index === 0
      ? [option, '<option value="' + value + '">' + optionLabel(name, index) + '</option>']
      : [option];
  }).join("");
  const options =
    staleFirstMatrixOpen && matrixOpenCount === 1
      ? ""
      : delayedSelectorHydration
        ? ""
        : savedOptions;
  const disabled = compareDisabled || sideUnitLimit ? " disabled" : "";
  const limitWarning = sideUnitLimit ? "<p>Too many units: maximum 12 units per side.</p>" : "";
  const unrelated = unrelatedSelectsFirst
    ? '<label for="unrelated-filter">Unrelated filter</label><select id="unrelated-filter"><option>Ignore me</option></select>'
    : "";
  document.querySelector("main").innerHTML =
    '<h1>Army vs Army</h1>' +
    unrelated +
    '<label for="army-a">Army A</label><select id="army-a"><option>Choose…</option><option value="old-player">Player (99)</option>' + options + '</select>' +
    '<label for="army-b">Army B</label><select id="army-b"><option>Choose…</option><option value="old-opponent">Opponent (99)</option>' + options + '</select>' +
    limitWarning +
    '<button id="compare"' + disabled + '>Compare lists</button>';
  if (delayedSelectorHydration && !(staleFirstMatrixOpen && matrixOpenCount === 1)) {
    setTimeout(() => {
      document.querySelectorAll('#army-a, #army-b').forEach((select) => {
        select.insertAdjacentHTML("beforeend", savedOptions);
      });
    }, 250);
  }
  if (!disabled) {
    document.querySelector("#compare").onclick = () => {
      setTimeout(() => {
        if (!document.querySelector("#matrix-result table")) {
          showMatrix();
          return;
        }
        if (
          !(phaseCompareDoesNotRefresh && state.phase === "fight") &&
          !suppressScenarioRefresh()
        ) {
          renderTable();
        }
      }, 80);
    };
  }
}
const state = {
  phase: "shooting",
  metric: "wipe-probability",
  direction: "player-to-opponent",
};
function suppressScenarioRefresh() {
  if (
    state.metric !== "mean-kills" ||
    staleMeanKillsRefreshesRemaining <= 0
  ) return false;
  staleMeanKillsRefreshesRemaining -= 1;
  return true;
}
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
      const deferredCompositeTransition =
        batchScenarioRefresh &&
        group === "phase" &&
        state.direction === "opponent-to-player";
      if (
        !(phaseRequiresCompare && group === "phase") &&
        !deferredCompositeTransition &&
        !suppressScenarioRefresh()
      ) {
        setTimeout(renderTable, 40);
      }
    };
  });
  renderTable();
}
function renderedValue(row, column) {
  if (allZeroMatrices) return "—";
  const effectiveMetric =
    equalProbabilityMetrics && state.metric === "half-wipe-probability"
      ? "wipe-probability"
      : state.metric;
  const phaseOffset = !equalAcrossPhases && state.phase === "fight" ? 30 : 0;
  const directionOffset = state.direction === "opponent-to-player" ? 10 : 0;
  const metricOffset = {
    "wipe-probability": 0,
    "half-wipe-probability": 4,
    "mean-kills": 8,
    "mean-damage": 12,
  }[effectiveMetric];
  const value = phaseOffset + directionOffset + metricOffset + row * 2 + column + 1;
  if (effectiveMetric === "wipe-probability" || effectiveMetric === "half-wipe-probability") {
    return value + "%";
  }
  if (effectiveMetric === "mean-kills") return (value / 10).toFixed(1) + " kills";
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
  const drift =
    dimensionDrift && state.metric === "half-wipe-probability";
  const rows =
    '<tr><th>Attacker</th><th>' + targets[0] + '</th><th>' + targets[1] + '</th>' +
      (drift ? '<th>Unexpected target</th>' : '') + '</tr>' +
    '<tr><th>' + attackers[0] + '</th><td>' + renderedValue(0, 0) + '</td><td>' + renderedValue(0, 1) + '</td>' +
      (drift ? '<td>' + renderedValue(0, 2) + '</td>' : '') + '</tr>' +
    '<tr><th>' + attackers[1] + '</th><td>' + renderedValue(1, 0) + '</td>' +
      (nonRectangularMatrix ? '' : '<td>' + renderedValue(1, 1) + '</td>') +
      (drift ? '<td>' + renderedValue(1, 2) + '</td>' : '') + '</tr>';
  const existing = document.querySelector("#matrix-result table");
  if (reuseMatrixNode && existing) {
    existing.innerHTML = rows;
  } else {
    document.querySelector("#matrix-result").innerHTML = '<table>' + rows + '</table>';
  }
}
showRoster();
</script></body></html>`;
}

async function runFixture(
  options: FixtureOptions = {},
  runtime: {
    directory?: string;
    preserveDirectory?: boolean;
    semanticSnapshotCacheDirectory?: string;
  } = {},
) {
  const directory =
    runtime.directory ??
    (await mkdtemp(
      path.join(os.tmpdir(), "tessera-browser-v2-"),
    ));
  const player = path.join(directory, "player.rosz");
  const opponent = path.join(directory, "opponent.rosz");
  const playerContent = Buffer.from("player");
  const opponentContent = Buffer.from("opponent");
  await writeFile(player, playerContent);
  await writeFile(opponent, opponentContent);
  const scopedProfilePolicySha256 =
    scopedTesseraProfilePolicySha256(null);
  const savedListReuse: TesseraSavedListReuse | undefined =
    options.savedListReuse
      ? {
          schemaVersion: 1,
          player: {
            runId: "browser-fixture-run",
            enrichedRoszSha256: createHash("sha256")
              .update(playerContent)
              .digest("hex"),
            scopedProfilePolicySha256,
            profilePolicyEntryKeys: [],
            rosterExecutionFingerprint: "c".repeat(64),
            expectedUnitCount: 2,
          },
          opponent: {
            runId: "browser-fixture-run",
            enrichedRoszSha256: createHash("sha256")
              .update(opponentContent)
              .digest("hex"),
            scopedProfilePolicySha256,
            profilePolicyEntryKeys: [],
            rosterExecutionFingerprint: "d".repeat(64),
            expectedUnitCount: 2,
          },
        }
      : undefined;
  const preexistingReuseSides =
    options.preexistingReuseSides ?? [];
  const fixtureOptions: FixtureOptions = savedListReuse
    ? {
        ...options,
        initialSavedLists: [
          ...preexistingReuseSides.map((side) => ({
            name: deterministicTesseraSavedListName(
              side,
              savedListReuse[side],
            ),
            unitCount: 2,
          })),
          ...(options.initialSavedLists ?? []),
        ],
      }
    : options;
  let browserContext: BrowserContext | undefined;
  try {
    const result = await runTesseraBrowserMatchup(
      {
        profileDirectory: path.join(directory, "profile"),
        playerRoszPath: player,
        playerName: "Player",
        opponentRoszPath: opponent,
        opponentName: "Opponent",
        analysisMode: "full",
        phases: options.requestedPhases,
        metrics: options.requestedMetrics,
        licenseKey: options.delayedPremium
          ? "fixture-premium-key"
          : undefined,
        profilePolicy: options.alternateProfile
          ? {
              schemaVersion: 1,
              policyKind: "tessera-profile-policy",
              entries: [
                options.alternateProfile === "select"
                  ? {
                      faction: "adeptus-custodes",
                      unit: "Blade Champion",
                      weaponGroup: "Vaultswords",
                      phase: "fight" as const,
                      selectedProfile: "Hurricanis",
                      activeCount: 1,
                    }
                  : options.alternateProfile === "duplicate-editor"
                    ? {
                        faction: "orks",
                        unit: "Gork's Ladz",
                        unitOccurrence: 1,
                        modelCount: 10,
                        weaponGroup: "Gork's klaw",
                        phase: "fight" as const,
                        selectedProfile: "Sweep",
                        activeCount: 10,
                      }
                    : options.alternateProfile === "split-editor"
                      ? {
                          faction: "death-guard",
                          unit: "Deathshroud Terminators",
                          unitOccurrence: 1,
                          modelCount: 6,
                          weaponGroup: "Manreaper",
                          phase: "fight" as const,
                          selectedProfile: "Sweep",
                          activeCount: 6,
                        }
                    : {
                      faction: "aeldari",
                      unit: "Fire Prism",
                      weaponGroup: "Prism cannon",
                      phase: "shooting" as const,
                      selectedProfile: "Focused lances",
                      activeCount: 1,
                    },
                ...(options.alternateProfile === "duplicate-editor"
                  ? [{
                      faction: "orks",
                      unit: "Gork's Ladz",
                      unitOccurrence: 1,
                      modelCount: 20,
                      weaponGroup: "Gork's klaw",
                      phase: "fight" as const,
                      selectedProfile: "Strike",
                      activeCount: 20,
                    }]
                  : []),
              ],
            }
          : undefined,
        savedListReuse,
        semanticSnapshotCacheDirectory:
          runtime.semanticSnapshotCacheDirectory,
        frozenScenarioContract:
          options.frozenIterations === undefined
            ? undefined
            : TESSERA_PHASES.flatMap((phase) =>
                TESSERA_METRICS.flatMap((metric) =>
                  TESSERA_DIRECTIONS.map((direction) => ({
                    phase,
                    metric,
                    direction,
                    settings: {},
                    iterations: options.frozenIterations ?? null,
                  })),
                ),
              ),
      },
      {
        baseUrl: "https://tessera-v2.test/",
        headless: true,
        timeoutMs: 1_000,
        keepContextOpen: options.inspectFinalDom,
        onContext: (context) => {
          browserContext = context;
        },
        prepareContext: async (context) => {
          await context.route("https://tessera-v2.test/**", async (route) => {
            await route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: fixturePage(fixtureOptions),
            });
          });
        },
      },
    );
    const fixtureDiagnostics =
      options.inspectFinalDom && browserContext
        ? {
            controlSections: await browserContext
              .pages()[0]
              .locator("#controls")
              .count(),
            matrixTables: await browserContext
              .pages()[0]
              .locator("#matrix-result table")
              .count(),
            importCount: await browserContext
              .pages()[0]
              .evaluate(() =>
                Number(sessionStorage.getItem("importCount") ?? "0")
              ),
          }
        : undefined;
    return {
      ...result,
      fixtureDiagnostics,
    };
  } finally {
    if (options.inspectFinalDom) {
      await browserContext?.close();
    }
    if (!runtime.preserveDirectory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

test(
  "captures delayed full-mode phase, metric, and direction scenarios with duplicate names",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture();
    assert.equal(
      result.scenarios.length,
      16,
      result.warnings.join("\n"),
    );
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
      assert.ok(scenario.matrixSha256);
      assert.match(scenario.matrixSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(scenario.integrity, {
        status: "trusted",
        issueCodes: [],
        aliasedScenarioIds: [],
      });
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
    assert.deepEqual(result.legacyProjection, {
      status: "derived",
      phase: "shooting",
      metric: "wipe-probability",
      scenarioIds: [
        "shooting:player-to-opponent:wipe-probability",
        "shooting:opponent-to-player:wipe-probability",
      ],
    });
    assert.equal(result.settings.phase, "Shooting");
    assert.equal(result.settings.metric, "P(wiped)");
    assert.equal(result.integrityIssues?.length, 0);
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
    const result = await runFixture({ delayedPremium: true });
    assert.equal(result.scenarios.length, 16);
    assert.ok(Date.now() - startedAt >= 1_000);
  },
);

test(
  "reopens one stale matrix and waits for semantically labeled selectors to hydrate",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      staleFirstMatrixOpen: true,
      delayedSelectorHydration: true,
      unrelatedSelectsFirst: true,
    });
    assert.equal(result.scenarios.length, 16);
  },
);

test(
  "accepts saved identities exposed only by authoritative matrix selectors",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      savedNamesOnlyInMatrix: true,
      unrelatedSelectsFirst: true,
    });
    assert.equal(result.scenarios.length, 16);
  },
);

test(
  "reuses both deterministic certification lists without importing",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      savedListReuse: true,
      preexistingReuseSides: ["player", "opponent"],
      savedNamesOnlyInMatrix: true,
      inspectFinalDom: true,
      requestedPhases: ["shooting"],
      requestedMetrics: ["wipe-probability"],
    });
    assert.equal(result.savedListReuse?.player.action, "reused");
    assert.equal(result.savedListReuse?.opponent.action, "reused");
    assert.equal(result.fixtureDiagnostics?.importCount, 0);
    assert.deepEqual(result.importWarnings, {
      player: [],
      opponent: [],
    });
  },
);

test(
  "reuses deterministic certification lists after the browser context restarts on the same profile",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(
        os.tmpdir(),
        "tessera-browser-restart-v2-",
      ),
    );
    try {
      const first = await runFixture(
        {
          savedListReuse: true,
          savedNamesOnlyInMatrix: true,
          requestedPhases: ["shooting"],
          requestedMetrics: ["wipe-probability"],
        },
        { directory, preserveDirectory: true },
      );
      assert.equal(
        first.savedListReuse?.player.action,
        "imported",
      );
      assert.equal(
        first.savedListReuse?.opponent.action,
        "imported",
      );

      const resumed = await runFixture(
        {
          savedListReuse: true,
          savedNamesOnlyInMatrix: true,
          requestedPhases: ["shooting"],
          requestedMetrics: ["wipe-probability"],
        },
        { directory, preserveDirectory: true },
      );
      assert.equal(
        resumed.savedListReuse?.player.action,
        "reused",
      );
      assert.equal(
        resumed.savedListReuse?.opponent.action,
        "reused",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "reuses only fully verified local semantic snapshot receipts after saved-list identity validation",
  { skip: !runBrowserTests },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "tessera-browser-semantic-receipt-v2-"),
    );
    const semanticSnapshotCacheDirectory = path.join(
      directory,
      "semantic-snapshots",
    );
    try {
      const first = await runFixture(
        {
          savedListReuse: true,
          savedNamesOnlyInMatrix: true,
          requestedPhases: ["shooting"],
          requestedMetrics: ["wipe-probability"],
        },
        {
          directory,
          preserveDirectory: true,
          semanticSnapshotCacheDirectory,
        },
      );
      assert.equal(first.savedListReuse?.player.action, "imported");
      assert.equal(
        first.savedListReuse?.player.semanticSnapshotSource,
        "fresh-import",
      );
      assert.match(
        first.savedListReuse?.player
          .semanticSnapshotReceiptSha256 ?? "",
        /^[0-9a-f]{64}$/,
      );
      assert.equal(first.providerEvidence?.importSemantics.completeness, "partial");

      const resumed = await runFixture(
        {
          savedListReuse: true,
          savedNamesOnlyInMatrix: true,
          requestedPhases: ["shooting"],
          requestedMetrics: ["wipe-probability"],
        },
        {
          directory,
          preserveDirectory: true,
          semanticSnapshotCacheDirectory,
        },
      );
      assert.equal(resumed.savedListReuse?.player.action, "reused");
      assert.equal(resumed.savedListReuse?.opponent.action, "reused");
      assert.equal(
        resumed.savedListReuse?.player.semanticSnapshotSource,
        "verified-cache",
      );
      assert.equal(
        resumed.savedListReuse?.opponent.semanticSnapshotSource,
        "verified-cache",
      );
      assert.equal(
        resumed.providerEvidence?.importSemantics.playerSha256,
        first.providerEvidence?.importSemantics.playerSha256,
      );
      assert.equal(
        resumed.providerEvidence?.importSemantics.opponentSha256,
        first.providerEvidence?.importSemantics.opponentSha256,
      );
      assert.equal(
        resumed.providerEvidence?.importSemantics.completeness,
        "partial",
      );
      assert.doesNotMatch(
        JSON.stringify(
          resumed.providerEvidence?.importSemantics.incompleteReasons,
        ),
        /saved-list-reused-without-import-review|snapshot-receipt-(?:missing|invalid)/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "imports one missing deterministic certification list exactly once",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      savedListReuse: true,
      preexistingReuseSides: ["player"],
      savedNamesOnlyInMatrix: true,
      inspectFinalDom: true,
      requestedPhases: ["shooting"],
      requestedMetrics: ["wipe-probability"],
    });
    assert.equal(result.savedListReuse?.player.action, "reused");
    assert.equal(result.savedListReuse?.opponent.action, "imported");
    assert.equal(result.fixtureDiagnostics?.importCount, 1);
  },
);

test(
  "reimports a deterministic player evicted while adding its opponent",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      savedListReuse: true,
      preexistingReuseSides: ["player"],
      initialSavedLists: [
        {
          name: "Older unrelated fixture",
          unitCount: 2,
        },
      ],
      savedListCapacity: 2,
      savedNamesOnlyInMatrix: true,
      inspectFinalDom: true,
      requestedPhases: ["shooting"],
      requestedMetrics: ["wipe-probability"],
    });
    assert.equal(result.savedListReuse?.player.action, "imported");
    assert.equal(result.savedListReuse?.opponent.action, "imported");
    assert.equal(result.fixtureDiagnostics?.importCount, 2);
  },
);

test(
  "fails closed before import when a deterministic saved identity is duplicated",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () =>
        runFixture({
          savedListReuse: true,
          preexistingReuseSides: ["player", "opponent"],
          duplicateSavedList: true,
          savedNamesOnlyInMatrix: true,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_LIST_SELECTION_MISMATCH" &&
        /refused to import or choose between duplicates/i.test(
          error.message,
        ),
    );
  },
);

test(
  "fails closed before import when a deterministic identity has the wrong unit count",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () =>
        runFixture({
          savedListReuse: true,
          preexistingReuseSides: ["player", "opponent"],
          wrongUnitCount: true,
          savedNamesOnlyInMatrix: true,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_LIST_SELECTION_MISMATCH" &&
        /refused to import over the mismatched identity/i.test(
          error.message,
        ),
    );
  },
);

test(
  "rejects duplicate, glyph-bearing, and truncated saved-list labels without using unrelated selectors",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () =>
        runFixture({
          duplicateSavedList: true,
          savedNamesOnlyInMatrix: true,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_LIST_SELECTION_MISMATCH" &&
        error.message.startsWith("[TESSERA_IMPORT_SIDE=player] "),
    );
    await assert.rejects(
      () =>
        runFixture({
          truncatedSavedLabels: true,
          unrelatedSelectsFirst: true,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_LIST_SELECTION_MISMATCH",
    );
  },
);

test(
  "replays and verifies a frozen settings and iteration contract",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({ frozenIterations: 1_000 });
    assert.equal(result.scenarios.length, 16);
    assert.ok(
      result.scenarios.every(
        (scenario) => scenario.iterations === 1_000,
      ),
    );
    await assert.rejects(
      () => runFixture({ frozenIterations: 999 }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_SETTINGS_REPLAY_FAILED",
    );
  },
);

test(
  "returns a distinct error when Tessera rejects the premium key",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () =>
        runFixture({
          delayedPremium: true,
          rejectPremium: true,
        }),
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
    const result = await runFixture({ alternateProfile: "select" });
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
    assert.equal(playerIssue?.selectedProfile, "Hurricanis");
    assert.match(
      result.importWarnings.player.join("\n"),
      /TESSERA_PROFILE_POLICY_APPLIED.*Hurricanis/,
    );
  },
);

test(
  "applies an appended weapon profile through imported-unit count rows",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      alternateProfile: "editor",
      requestedPhases: ["shooting"],
      requestedMetrics: ["wipe-probability"],
    });
    const playerIssue = result.importIssues?.find(
      (issue) => issue.side === "player",
    );
    assert.equal(playerIssue?.code, "alternate-profile");
    assert.equal(playerIssue?.unit, "Fire Prism");
    assert.equal(
      playerIssue?.weaponGroup,
      "Prism cannon - Dispersed pulse",
    );
    assert.equal(playerIssue?.phase, "shooting");
    assert.equal(playerIssue?.resolvedByPolicy, true);
    assert.equal(playerIssue?.selectedProfile, "Focused lances");
    assert.match(
      result.importWarnings.player.join("\n"),
      /TESSERA_PROFILE_POLICY_APPLIED.*Focused lances/,
    );
  },
);

test(
  "preserves player and opponent side on serialized profile editor failures",
  { skip: !runBrowserTests },
  async () => {
    for (const side of ["Player", "Opponent"] as const) {
      await assert.rejects(
        () =>
          runFixture({
            alternateProfile: "editor",
            alternateProfileSide: side,
            profileEditorMismatch: true,
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "TESSERA_PROFILE_EDITOR_MISMATCH" &&
          error.message.startsWith(
            `[TESSERA_IMPORT_SIDE=${side.toLocaleLowerCase()}] `,
          ),
      );
    }
  },
);

test(
  "applies occurrence-specific counts to duplicate same-name unit sizes",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      alternateProfile: "duplicate-editor",
    });
    const playerIssue = result.importIssues?.find(
      (issue) => issue.side === "player",
    );
    assert.equal(playerIssue?.code, "alternate-profile");
    assert.equal(playerIssue?.unit, "Gork’s Ladz");
    assert.equal(playerIssue?.resolvedByPolicy, true);
    assert.match(
      playerIssue?.selectedProfile ?? "",
      /10 models #1: Sweep; 20 models #1: Strike/,
    );
  },
);

test(
  "preserves split model-subgroup counts for one alternate weapon",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      alternateProfile: "split-editor",
    });
    const playerIssue = result.importIssues?.find(
      (issue) => issue.side === "player",
    );
    assert.equal(playerIssue?.code, "alternate-profile");
    assert.equal(playerIssue?.unit, "Deathshroud Terminators");
    assert.equal(playerIssue?.weaponGroup, "Manreaper - Strike");
    assert.equal(playerIssue?.resolvedByPolicy, true);
    assert.equal(playerIssue?.selectedProfile, "Sweep");
  },
);

test(
  "retries one transient stale scenario in the same browser session",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({ staleMeanKillsOnce: true });
    assert.equal(
      result.scenarios.length,
      16,
      result.warnings.join("\n"),
    );
    const retried = result.scenarioAttempts?.filter(
      (attempt) =>
        attempt.scenarioId ===
        "shooting:player-to-opponent:mean-kills",
    );
    assert.deepEqual(
      retried?.map((attempt) => ({
        attempt: attempt.attempt,
        status: attempt.status,
        code: attempt.code,
        retryable: attempt.retryable,
        willRetry: attempt.willRetry,
      })),
      [
        {
          attempt: 1,
          status: "failed",
          code: "TESSERA_STALE_MATRIX",
          retryable: true,
          willRetry: true,
        },
        {
          attempt: 2,
          status: "success",
          code: null,
          retryable: false,
          willRetry: false,
        },
      ],
    );
    assert.match(
      result.warnings.join("\n"),
      /TESSERA_SCENARIO_RETRY.*same browser session.*without re-importing/i,
    );
    assert.doesNotMatch(
      result.warnings.join("\n"),
      /was not captured after 2 attempts/i,
    );
  },
);

test(
  "preserves successful scenarios and records a bounded terminal stale failure",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({ staleMeanKills: true });
    assert.equal(result.scenarios.length, 15);
    assert.equal(
      result.scenarios.some(
        (scenario) =>
          scenario.id ===
          "shooting:player-to-opponent:mean-kills",
      ),
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
    assert.match(
      result.warnings.join("\n"),
      /was not captured after 2 attempts/i,
    );
    const terminal = result.scenarioAttempts?.filter(
      (attempt) =>
        attempt.scenarioId ===
        "shooting:player-to-opponent:mean-kills",
    );
    assert.deepEqual(
      terminal?.map((attempt) => [
        attempt.attempt,
        attempt.status,
        attempt.code,
        attempt.retryable,
        attempt.willRetry,
      ]),
      [
        [1, "failed", "TESSERA_STALE_MATRIX", true, true],
        [2, "failed", "TESSERA_STALE_MATRIX", true, false],
      ],
    );
  },
);

test(
  "does not treat control-only DOM mutations as a matrix refresh",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({ staleMeanKills: true });
    const staleWarnings = result.warnings.filter((warning) =>
      warning.includes("TESSERA_STALE_MATRIX")
    );
    assert.ok(staleWarnings.length > 0);
    assert.equal(
      result.scenarios.some(
        (scenario) =>
          scenario.id ===
          "shooting:player-to-opponent:mean-kills",
      ),
      false,
    );
  },
);

test(
  "accepts equal-valued matrix node replacements across phases and metrics",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      equalAcrossPhases: true,
      equalProbabilityMetrics: true,
    });
    assert.equal(result.scenarios.length, 16);
    assert.equal(result.integrityIssues?.length, 0);
    assert.ok(
      result.scenarios.every(
        (scenario) => scenario.integrity?.status === "trusted",
      ),
    );
    const scenarioSha = (
      phase: "shooting" | "fight",
      metric: "wipe-probability" | "half-wipe-probability",
    ) =>
      result.scenarios.find(
        (scenario) =>
          scenario.phase === phase &&
          scenario.metric === metric &&
          scenario.direction === "player-to-opponent",
      )?.matrixSha256;
    assert.equal(
      scenarioSha("shooting", "wipe-probability"),
      scenarioSha("fight", "wipe-probability"),
    );
    assert.equal(
      scenarioSha("shooting", "wipe-probability"),
      scenarioSha("shooting", "half-wipe-probability"),
    );
    assert.doesNotMatch(result.warnings.join("\n"), /MATRIX_ALIAS/);
  },
);

test(
  "waits for one matrix refresh after a composite scenario transition",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({ batchScenarioRefresh: true });
    assert.equal(result.scenarios.length, 16, result.warnings.join("\n"));
    assert.equal(result.integrityIssues?.length, 0);
    assert.doesNotMatch(result.warnings.join("\n"), /STALE_MATRIX/);
  },
);

test(
  "recomputes a phase-only change through Compare lists before accepting the matrix",
  { skip: !runBrowserTests },
  async () => {
    const shooting = await runFixture({
      phaseRequiresCompare: true,
      requestedPhases: ["shooting"],
      requestedMetrics: ["wipe-probability"],
    });
    const fight = await runFixture({
      phaseRequiresCompare: true,
      requestedPhases: ["fight"],
      requestedMetrics: ["wipe-probability"],
    });
    assert.equal(shooting.scenarios.length, 2, shooting.warnings.join("\n"));
    assert.equal(fight.scenarios.length, 2, fight.warnings.join("\n"));

    const shootingScenario = shooting.scenarios.find(
      (scenario) => scenario.direction === "player-to-opponent",
    );
    const fightScenario = fight.scenarios.find(
      (scenario) => scenario.direction === "player-to-opponent",
    );
    assert.ok(shootingScenario);
    assert.ok(fightScenario);
    assert.notEqual(
      shootingScenario.matrixSha256,
      fightScenario.matrixSha256,
    );
    assert.notEqual(
      shootingScenario.cells[0]?.metricValue,
      fightScenario.cells[0]?.metricValue,
    );
    assert.equal(shootingScenario.cells[0]?.metricValue, 0.01);
    assert.equal(fightScenario.cells[0]?.metricValue, 0.31);
    assert.equal(fight.legacyProjection?.phase, "fight");
    assert.equal(fight.cells.length, 8);
  },
);

test(
  "derives the legacy matrix only from the canonical requested probability scenarios",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      requestedPhases: ["fight"],
      requestedMetrics: ["half-wipe-probability"],
    });
    assert.equal(result.scenarios.length, 2);
    assert.equal(result.cells.length, 8);
    assert.deepEqual(result.legacyProjection, {
      status: "derived",
      phase: "fight",
      metric: "half-wipe-probability",
      scenarioIds: [
        "fight:player-to-opponent:half-wipe-probability",
        "fight:opponent-to-player:half-wipe-probability",
      ],
    });
  },
);

test(
  "rejects a non-rectangular matrix",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () => runFixture({ nonRectangularMatrix: true }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_INCOMPLETE_MATRIX" &&
        /non-rectangular/.test(error.message),
    );
  },
);

test(
  "rejects matrix dimension drift after retaining prior scenarios",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({ dimensionDrift: true });
    assert.ok(result.scenarios.length > 0);
    assert.ok(result.scenarios.length < 16);
    assert.match(result.warnings.join("\n"), /changed.*dimensions/i);
    assert.equal(
      result.scenarios.some(
        (scenario) =>
          scenario.metric === "half-wipe-probability",
      ),
      false,
    );
    const structuralFailures = result.scenarioAttempts?.filter(
      (attempt) =>
        attempt.status === "failed" &&
        attempt.code === "TESSERA_INCOMPLETE_MATRIX",
    );
    assert.ok((structuralFailures?.length ?? 0) > 0);
    assert.ok(
      structuralFailures?.every(
        (attempt) =>
          attempt.attempt === 1 &&
          attempt.retryable === false &&
          attempt.willRetry === false,
      ),
    );
    assert.doesNotMatch(
      result.warnings.join("\n"),
      /TESSERA_SCENARIO_RETRY/,
    );
  },
);

test(
  "recomputes shooting and fight in one session without accumulating matrix UI",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      phaseRequiresCompare: true,
      requestedPhases: ["shooting", "fight"],
      requestedMetrics: ["wipe-probability"],
      inspectFinalDom: true,
    });
    assert.equal(result.scenarios.length, 4, result.warnings.join("\n"));
    assert.deepEqual(result.fixtureDiagnostics, {
      controlSections: 1,
      matrixTables: 1,
    });

    const scenario = (phase: "shooting" | "fight") =>
      result.scenarios.find(
        (entry) =>
          entry.phase === phase &&
          entry.direction === "player-to-opponent",
      );
    assert.ok(scenario("shooting"));
    assert.ok(scenario("fight"));
    assert.notEqual(
      scenario("shooting")?.matrixSha256,
      scenario("fight")?.matrixSha256,
    );
  },
);

test(
  "rejects every scenario in a phase when Compare lists does not refresh it",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      runFixture({
        phaseRequiresCompare: true,
        phaseCompareDoesNotRefresh: true,
        requestedPhases: ["fight"],
        requestedMetrics: ["wipe-probability"],
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_STALE_MATRIX",
    );
  },
);

test(
  "accepts in-place all-zero matrix rerenders",
  { skip: !runBrowserTests },
  async () => {
    const result = await runFixture({
      allZeroMatrices: true,
      reuseMatrixNode: true,
    });
    assert.equal(result.scenarios.length, 16);
    assert.equal(result.integrityIssues?.length, 0);
    assert.ok(
      result.scenarios.every((scenario) =>
        scenario.cells.every((cell) => cell.metricValue === 0)
      ),
    );
    assert.ok(
      result.scenarios.every(
        (scenario) => scenario.integrity?.status === "trusted",
      ),
    );
    assert.doesNotMatch(result.warnings.join("\n"), /MATRIX_ALIAS|STALE_MATRIX/);
  },
);

test(
  "fails with a distinct error when the explicit .rosz input is absent",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () => runFixture({ missingRoszInput: true }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_ROSTER_INPUT_UNAVAILABLE",
    );
  },
);

test(
  "rejects a wrong unit count in the authoritative matrix selector",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () =>
        runFixture({
          wrongUnitCount: true,
          savedNamesOnlyInMatrix: true,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_LIST_SELECTION_MISMATCH" &&
        error.message.startsWith("[TESSERA_IMPORT_SIDE=player] ") &&
        /exposed 0 exact entries/.test(error.message),
    );
  },
);

test(
  "rejects a saved-list label whose stable selector value is wrong",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () =>
        runFixture({
          wrongStableValue: true,
          savedNamesOnlyInMatrix: true,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_LIST_SELECTION_MISMATCH" &&
        error.message.startsWith("[TESSERA_IMPORT_SIDE=player] ") &&
        /exposed 0 exact entries/.test(error.message),
    );
  },
);

test(
  "distinguishes a side unit cap from a generic disabled comparison",
  { skip: !runBrowserTests },
  async () => {
    await assert.rejects(
      () => runFixture({ sideUnitLimit: true }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_SIDE_UNIT_LIMIT",
    );
    await assert.rejects(
      () => runFixture({ compareDisabled: true }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TESSERA_COMPARE_DISABLED",
    );
  },
);
