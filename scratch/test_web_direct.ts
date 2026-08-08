import fs from "node:fs";
import path from "node:path";
import { buildRoster, validateRoster, rosterProfileRequirements, type PreferenceTag } from "../lib/rosterpilot/index.ts";
import { analyzeRosterMatchup } from "../local/tessera/companion.ts";
import { runTesseraBrowserMatchup } from "../local/tessera/browser.ts";
import { resolveProfilePolicyScaffold } from "../local/tessera/profile-policy.ts";

const CUSTODES_KEY_UNITS = [
  "contemptor-galatus-dreadnought",
  "sagittarum-custodians",
  "vertus-praetors",
  "custodian-wardens",
  "pallas-grav-attack",
];

const AELDARI_KEY_UNITS = [
  "falcon",
  "dark-reapers",
  "windriders",
  "wraithblades",
  "night-spinner",
];

const CUSTODES_EXCLUSIONS = ["venatari-custodians", "shield-captain-in-allarus-terminator-armour"];
const AELDARI_EXCLUSIONS = [
  "vyper",
  "guardian-defenders",
  "howling-banshees",
  "striking-scorpions",
  "war-walkers",
  "hemlock-wraithfighter",
  "jain-zar",
  "prince-yriel",
  "yvraine",
];

const PREFERENCES: PreferenceTag[] = [
  "mobility",
  "durability",
  "objective",
  "shooting",
  "melee",
  "elite",
  "horde",
];

function getRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomPreferences(count = 2): PreferenceTag[] {
  const shuffled = [...PREFERENCES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

async function main() {
  const runId = Math.floor(Math.random() * 1000000);
  const outDir = path.resolve("exports/tessera");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("=========================================================================");
  console.log(` DIRECT PLAYTESSERA WEB CERTIFIED SIMULATION (RUN #${runId})             `);
  console.log("=========================================================================\n");

  const requiredCustodesUnit = getRandom(CUSTODES_KEY_UNITS);
  const custodesPrefs = getRandomPreferences(2);
  const custodesName = `Custodes Strike Force #${runId}`;
  console.log(`=== STEP 1: Building Random 1000pt Adeptus Custodes Roster ===`);
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
  console.log(`\nCustodes Roster: ${custodesRoster.name} (${custodesRoster.totalPoints} pts)`);
  custodesRoster.units.forEach(u => console.log(` - ${u.name} (${u.points} pts)`));

  const custodesValidation = validateRoster(custodesRoster);
  console.log("Custodes Validation:", custodesValidation.ok ? "PASS" : "FAIL");
  if (!custodesValidation.ok) {
    console.error("Custodes Violations:", custodesValidation.violations);
    process.exit(1);
  }

  const requiredAeldariUnit = getRandom(AELDARI_KEY_UNITS);
  const aeldariPrefs = getRandomPreferences(2);
  const aeldariName = `Aeldari Host #${runId}`;
  console.log(`\n=== STEP 2: Building Random 1000pt Aeldari Roster ===`);
  console.log(` Required Unit: ${requiredAeldariUnit} | Preferences: ${aeldariPrefs.join(", ")}`);

  const aeldariBuild = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    name: aeldariName,
    prompt: `Build a random legal 1000pt Aeldari army featuring ${requiredAeldariUnit}`,
    requiredUnitIds: [requiredAeldariUnit],
    excludedUnitIds: AELDARI_EXCLUSIONS,
    preferences: aeldariPrefs,
    legendsPolicy: "exclude",
  });

  if (!aeldariBuild.ok || !aeldariBuild.data) {
    console.error("Failed to build Aeldari roster:", aeldariBuild.violations);
    process.exit(1);
  }
  const aeldariRoster = aeldariBuild.data;
  console.log(`\nAeldari Roster: ${aeldariRoster.name} (${aeldariRoster.totalPoints} pts)`);
  aeldariRoster.units.forEach(u => console.log(` - ${u.name} (${u.points} pts)`));

  const aeldariValidation = validateRoster(aeldariRoster);
  console.log("Aeldari Validation:", aeldariValidation.ok ? "PASS" : "FAIL");
  if (!aeldariValidation.ok) {
    console.error("Aeldari Violations:", aeldariValidation.violations);
    process.exit(1);
  }

  console.log("\n=== STEP 3: Dynamically Resolving Weapon Profiles for Matchup ===");
  const reqs = [
    ...rosterProfileRequirements(custodesRoster),
    ...rosterProfileRequirements(aeldariRoster),
  ];
  const dynamicPolicy = resolveProfilePolicyScaffold(reqs);
  const policyPath = path.join(outDir, "active_profile_policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(dynamicPolicy, null, 2), "utf8");
  console.log(` Dynamic Profile Policy written to: ${policyPath}`);
  console.log(` Resolved Profile Entries: ${dynamicPolicy.entries.length}`);

  console.log("\n=== STEP 4: Executing FULL SIMULATION on PlayTessera Website (playtessera.org) ===");
  const simResult = await analyzeRosterMatchup(
    custodesRoster,
    { kind: "roster", roster: aeldariRoster },
    {
      outputDirectory: outDir,
      simulationBackend: "website",
      executionMode: "simulate",
      profilePolicyPath: policyPath,
      catalogueDriftMode: "force",
      overwrite: true,
    },
    {
      runBrowser: runTesseraBrowserMatchup,
      runtimeIssue: () => null,
    }
  );

  console.log("\nSimulation Result Envelope OK:", simResult.ok);
  if (!simResult.ok) {
    console.log("Simulation Envelope Violations:", simResult.violations);
    console.log("Simulation Envelope Warnings:", simResult.warnings);
  }

  const data = simResult.data;
  console.log("\n=========================================================================");
  console.log(" PLAYTESSERA WEB CERTIFIED SIMULATION SUMMARY                           ");
  console.log("=========================================================================");
  if (data) {
    console.log(`Simulation Status          : ${data.status}`);
    console.log(`Execution Mode             : ${data.simulation.executionMode}`);
    console.log(`Requested Backend          : ${data.simulation.requestedBackend}`);
    console.log(`Selected Backend           : ${data.simulation.selectedBackend}`);
    console.log(`Envelope OK                : ${simResult.ok}`);
  }
  console.log("=========================================================================\n");
}

main().catch(console.error);
