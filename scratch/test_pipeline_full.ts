import { buildRoster, validateRoster, type PreferenceTag } from "../lib/rosterpilot/index.ts";
import { deliverRosterToNewRecruit } from "../local/new-recruit/companion.ts";
import { analyzeRosterMatchup } from "../local/tessera/companion.ts";

const CUSTODES_KEY_UNITS = [
  "caladius-grav-tank",
  "custodian-wardens",
  "vertus-praetors",
  "contemptor-galatus-dreadnought",
  "trajann-valoris",
];

const AELDARI_KEY_UNITS = [
  "autarch",
  "falcon",
  "night-spinner",
  "dark-reapers",
  "windriders",
  "wraithguard",
  "wraithblades",
  "avatar-of-khaine",
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
  console.log("=========================================================================");
  console.log(` 1000PT RANDOM MATCHUP PIPELINE (RUN #${runId}): CUSTODES VS AELDARI     `);
  console.log(" (TARGETING PLAYTESSERA.ORG / PLAYTESSERA.GG WEB UPLOADER)              ");
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

  console.log("\n=== STEP 3: Uploading Custodes Roster to New Recruit ===");
  const custodesDelivery = await deliverRosterToNewRecruit(custodesRoster, {
    outputDirectory: "exports/new-recruit",
    overwrite: true,
    downloadEnrichedRosz: false,
  });
  console.log("Custodes Upload Result OK:", custodesDelivery.ok || Boolean(custodesDelivery.data?.listUrl));
  if (custodesDelivery.data?.listUrl) {
    console.log(" New Recruit List URL:", custodesDelivery.data.listUrl);
    console.log(" Roster ID:", custodesDelivery.data.rosterId);
    if (custodesDelivery.data.artifacts?.length) {
      console.log(" Downloaded Artifacts:", custodesDelivery.data.artifacts.map(a => a.filename).join(", "));
    }
  } else {
    console.error(" Custodes Delivery Violations:", custodesDelivery.violations);
    process.exit(1);
  }

  console.log("\n=== STEP 4: Uploading Aeldari Roster to New Recruit ===");
  const aeldariDelivery = await deliverRosterToNewRecruit(aeldariRoster, {
    outputDirectory: "exports/new-recruit",
    overwrite: true,
    downloadEnrichedRosz: false,
  });
  console.log("Aeldari Upload Result OK:", aeldariDelivery.ok || Boolean(aeldariDelivery.data?.listUrl));
  if (aeldariDelivery.data?.listUrl) {
    console.log(" New Recruit List URL:", aeldariDelivery.data.listUrl);
    console.log(" Roster ID:", aeldariDelivery.data.rosterId);
    if (aeldariDelivery.data.artifacts?.length) {
      console.log(" Downloaded Artifacts:", aeldariDelivery.data.artifacts.map(a => a.filename).join(", "));
    }
  } else {
    console.error(" Aeldari Delivery Violations:", aeldariDelivery.violations);
    process.exit(1);
  }

  console.log("\n=== STEP 5: Simulating Matchup on playtessera.org / playtessera.gg (Web Backend) ===");
  const simResult = await analyzeRosterMatchup(
    custodesRoster,
    { kind: "roster", roster: aeldariRoster },
    {
      simulationBackend: "website",
      profilePolicyPath: "profiles.json",
      catalogueDriftMode: "diagnostic",
    }
  );

  console.log("Simulation Result Success:", simResult.ok);
  if (!simResult.ok) {
    console.error("Simulation Violations:", simResult.violations);
    console.error("Simulation Warnings:", simResult.warnings);
  }

  const metrics = simResult.data?.metrics;
  console.log("\n=========================================================================");
  console.log(" MATCHUP SIMULATION SUMMARY (PLAYTESSERA WEB BACKEND)                    ");
  console.log("=========================================================================");
  console.log(`Player Roster (Custodes)   : ${custodesRoster.name} (${custodesRoster.totalPoints} pts)`);
  console.log(`Opponent Roster (Aeldari)  : ${aeldariRoster.name} (${aeldariRoster.totalPoints} pts)`);
  console.log(`Custodes New Recruit List  : ${custodesDelivery.data?.listUrl}`);
  console.log(`Aeldari New Recruit List   : ${aeldariDelivery.data?.listUrl}`);
  if (metrics) {
    console.log(`Custodes Expected Win Rate : ${(metrics.expectedWinRate * 100).toFixed(1)}%`);
    console.log(`Expected Custodes VP       : ${metrics.expectedPlayerVp.toFixed(1)}`);
    console.log(`Expected Aeldari VP        : ${metrics.expectedOpponentVp.toFixed(1)}`);
  } else if (simResult.data) {
    console.log("Simulation Data keys:", Object.keys(simResult.data));
  }
  console.log("=========================================================================\n");
}

main().catch(console.error);
