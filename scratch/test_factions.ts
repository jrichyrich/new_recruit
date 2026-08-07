import { searchFactions, buildRoster, validateRoster } from "../lib/rosterpilot/index.ts";
import { deliverRosterToNewRecruit } from "../local/new-recruit/companion.ts";
import { analyzeRosterMatchup } from "../local/tessera/companion.ts";

console.log("Searching factions for 'custodes':");
console.log(JSON.stringify(searchFactions("custodes"), null, 2));

console.log("\nSearching factions for 'aeldari':");
console.log(JSON.stringify(searchFactions("aeldari"), null, 2));

console.log("\nBuilding Custodes 1000pt roster:");
const custodesResult = buildRoster({
  faction: "adeptus-custodes",
  pointsLimit: 1000,
  prompt: "Build a random legal 1000pt Adeptus Custodes army",
});
console.log("Custodes build status:", custodesResult.ok);
if (!custodesResult.ok || !custodesResult.data) {
  console.error("Custodes violations:", custodesResult.violations);
  process.exit(1);
}
console.log("Custodes Name:", custodesResult.data.name);
console.log("Custodes Points:", custodesResult.data.totalPoints);
console.log("Custodes Units:", custodesResult.data.units.map(u => `${u.name} (${u.points}pts)`));
const val1 = validateRoster(custodesResult.data);
console.log("Custodes Validation ok:", val1.ok, "violations:", val1.violations);

console.log("\nBuilding Aeldari 1000pt roster:");
const aeldariResult = buildRoster({
  faction: "aeldari",
  pointsLimit: 1000,
  prompt: "Build a random legal 1000pt Aeldari army",
});
console.log("Aeldari build status:", aeldariResult.ok);
if (!aeldariResult.ok || !aeldariResult.data) {
  console.error("Aeldari violations:", aeldariResult.violations);
  process.exit(1);
}
console.log("Aeldari Name:", aeldariResult.data.name);
console.log("Aeldari Points:", aeldariResult.data.totalPoints);
console.log("Aeldari Units:", aeldariResult.data.units.map(u => `${u.name} (${u.points}pts)`));
const val2 = validateRoster(aeldariResult.data);
console.log("Aeldari Validation ok:", val2.ok, "violations:", val2.violations);
