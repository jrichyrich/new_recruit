import fs from "node:fs";
import path from "node:path";
import {
  buildRoster,
  validateRoster,
  generateFactionStressPortfolio,
  rosterProfileRequirements,
  type PreferenceTag,
} from "../lib/rosterpilot/index.ts";
import { deliverRosterToNewRecruit } from "../local/new-recruit/companion.ts";
import { analyzeRosterMatchup } from "../local/tessera/companion.ts";
import { profilePolicyScaffold } from "../local/tessera/profile-policy.ts";

const CUSTODES_KEY_UNITS = [
  "contemptor-galatus-dreadnought",
  "sagittarum-custodians",
  "vertus-praetors",
  "custodian-wardens",
  "pallas-grav-attack",
];

const CUSTODES_EXCLUSIONS = ["venatari-custodians", "shield-captain-in-allarus-terminator-armour"];
const PREFERENCES: PreferenceTag[] = ["mobility", "durability", "objective", "shooting", "melee", "elite"];

function getRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomPreferences(count = 2): PreferenceTag[] {
  const shuffled = [...PREFERENCES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

async function main() {
  const runId = Math.floor(Math.random() * 1000000);
  console.log("=========================================================================");
  console.log(` BROAD 9-TEST-CASE MATCHUP PIPELINE (RUN #${runId})                     `);
  console.log(" CUSTODES VS AELDARI (DIVERSE-9 SUITE ON PLAYTESSERA WEB UPLOADER)       ");
  console.log("=========================================================================\n");

  const requiredCustodesUnit = getRandom(CUSTODES_KEY_UNITS);
  const custodesPrefs = getRandomPreferences(2);
  const custodesName = `Custodes Strike Force #${runId}`;
  console.log(`=== STEP 1: Building Random 1000pt Adeptus Custodes Player Roster ===`);
  console.log(` Required Unit: ${requiredCustodesUnit} | Preferences: ${custodesPrefs.join(", ")}`);

  const custodesBuild = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1000,
    name: custodesName,
    prompt: `Build a random legal 1000pt Adeptus Custodes army featuring ${requiredCustodesUnit}`,
    requiredUnitIds: [requiredCustodesUnit],
    excludedUnitIds: CUSTODES_EXCLUSIONS,
    preferences: custodesPrefs,
    legendsPolicy: "exclude",
  });

  if (!custodesBuild.ok || !custodesBuild.data) {
    console.error("Failed to build Custodes roster:", custodesBuild.violations);
    process.exit(1);
  }
  const custodesRoster = custodesBuild.data;
  console.log(`\nCustodes Player Roster: ${custodesRoster.name} (${custodesRoster.totalPoints} pts)`);
  custodesRoster.units.forEach(u => console.log(` - ${u.name} (${u.points} pts)`));

  const custodesValidation = validateRoster(custodesRoster);
  console.log("Custodes Validation:", custodesValidation.ok ? "PASS" : "FAIL");
  if (!custodesValidation.ok) {
    console.error("Custodes Violations:", custodesValidation.violations);
    process.exit(1);
  }

  console.log("\n=== STEP 2: Uploading Custodes Player Roster to New Recruit ===");
  const custodesDelivery = await deliverRosterToNewRecruit(custodesRoster, {
    outputDirectory: "exports/new-recruit",
    overwrite: true,
    downloadEnrichedRosz: false,
  });
  console.log("Custodes Upload Result OK:", custodesDelivery.ok || Boolean(custodesDelivery.data?.listUrl));
  if (custodesDelivery.data?.listUrl) {
    console.log(" Custodes New Recruit List URL:", custodesDelivery.data.listUrl);
  }

  console.log("\n=== STEP 3: Generating 9-Matchup Aeldari Stress Portfolio (diverse-9) ===");
  const portfolioBuild = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1000,
    suite: "diverse-9",
    pointsTolerancePercent: 5,
    allowLegends: false,
  });

  if (!portfolioBuild.ok || !portfolioBuild.data) {
    console.error("Failed to generate Aeldari portfolio:", portfolioBuild.violations);
    process.exit(1);
  }

  const readyItems = portfolioBuild.data.items.filter(item => item.status === "ready" && item.roster);
  console.log(`Generated ${readyItems.length} ready portfolio test cases for Aeldari.`);

  const testResults: Array<{
    index: number;
    templateId: string;
    posture: string;
    composition: string;
    opponentName: string;
    points: number;
    newRecruitUrl?: string;
    simOk: boolean;
  }> = [];

  console.log("\n=== STEP 4: Simulating 9 Test Cases on PlayTessera Website (playtessera.org) ===");

  for (let i = 0; i < readyItems.length; i++) {
    const item = readyItems[i];
    const opponentRoster = item.roster!;
    console.log(`\n-------------------------------------------------------------------------`);
    console.log(` TEST CASE ${i + 1}/${readyItems.length}: [${item.templateId}] ${item.posture} / ${item.composition}`);
    console.log(` Opponent Roster: ${opponentRoster.name} (${opponentRoster.totalPoints} pts)`);
    console.log(`-------------------------------------------------------------------------`);

    const opponentValidation = validateRoster(opponentRoster);
    console.log(` Validation: ${opponentValidation.ok ? "PASS" : "FAIL"}`);

    const opponentDelivery = await deliverRosterToNewRecruit(opponentRoster, {
      outputDirectory: "exports/new-recruit",
      overwrite: true,
      downloadEnrichedRosz: false,
    });
    const newRecruitUrl = opponentDelivery.data?.listUrl;
    console.log(` New Recruit Upload: ${opponentDelivery.ok ? "PASS" : "FAIL"}${newRecruitUrl ? ` (${newRecruitUrl})` : ""}`);

    const reqs = [
      ...rosterProfileRequirements(custodesRoster),
      ...rosterProfileRequirements(opponentRoster),
    ];
    const dynamicPolicy = profilePolicyScaffold(reqs);
    const policyPath = path.resolve(`exports/tessera/profile_policy_case_${i + 1}.json`);
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, JSON.stringify(dynamicPolicy, null, 2), "utf8");

    const simResult = await analyzeRosterMatchup(
      custodesRoster,
      { kind: "roster", roster: opponentRoster },
      {
        outputDirectory: `exports/tessera/case_${i + 1}`,
        simulationBackend: "website",
        executionMode: "simulate",
        profilePolicyPath: policyPath,
        catalogueDriftMode: "force",
      },
      { runtimeIssue: () => null }
    );

    console.log(` PlayTessera Web Simulation Envelope OK: ${simResult.ok}`);
    if (simResult.data) {
      console.log(` Simulation Status: ${simResult.data.status} | Backend: ${simResult.data.simulation.selectedBackend}`);
    }

    testResults.push({
      index: i + 1,
      templateId: item.templateId,
      posture: item.posture,
      composition: item.composition,
      opponentName: opponentRoster.name,
      points: opponentRoster.totalPoints,
      newRecruitUrl,
      simOk: simResult.ok,
    });
  }

  console.log("\n=========================================================================");
  console.log(" BROAD 9-TEST-CASE SIMULATION SUMMARY (PLAYTESSERA WEB UPLOADER)         ");
  console.log("=========================================================================");
  console.log(`Player Roster: ${custodesRoster.name} (${custodesRoster.totalPoints} pts)`);
  console.log(`Player New Recruit List: ${custodesDelivery.data?.listUrl}\n`);
  console.table(testResults.map(r => ({
    "#": r.index,
    "Template": r.templateId,
    "Posture": r.posture,
    "Composition": r.composition,
    "Points": r.points,
    "New Recruit Upload": r.newRecruitUrl ? "Uploaded" : "Pending",
    "Simulation Envelope": r.simOk ? "PASS" : "DIAGNOSTIC",
  })));
  console.log("=========================================================================\n");
}

main().catch(console.error);
