import { buildRoster } from "../lib/rosterpilot/index.ts";
import { analyzeRosterMatchup } from "../local/tessera/companion.ts";
import fs from "fs/promises";

async function main() {
  console.log("Generating Player 1: Space Marines");
  const p1 = buildRoster({
    faction: "space-marines",
    pointsLimit: 2000,
    name: "SM Task Force " + Math.floor(Math.random() * 10000),
    preferences: ["shooting", "durability"],
    allowLegends: false,
  });

  console.log("Generating Player 2: Tyranids");
  const p2 = buildRoster({
    faction: "tyranids",
    pointsLimit: 2000,
    name: "Hive Fleet " + Math.floor(Math.random() * 10000),
    preferences: ["melee", "horde"],
    allowLegends: false,
  });

  if (!p1.ok || !p2.ok || !p1.data || !p2.data) {
    console.error("Failed to build rosters.");
    process.exit(1);
  }

  console.log(`Matchup: ${p1.data.name} (${p1.data.totalPoints}pts) vs ${p2.data.name} (${p2.data.totalPoints}pts)`);
  console.log("Submitting to PlayTessera for simulation...");

  const result = await analyzeRosterMatchup(
    p1.data,
    { kind: "roster", roster: p2.data },
    { catalogueDriftMode: "diagnostic" }
  );

  if (!result.ok) {
    console.error("Simulation failed:", result.violations);
    process.exit(1);
  }

  console.log("Simulation complete!");
  const reportPath = "./simulation_report.json";
  await fs.writeFile(reportPath, JSON.stringify(result.data, null, 2));
  console.log(`Detailed report written to ${reportPath}`);
  
  // Extract and print some high-level metrics if available
  const report = result.data;
  console.log(`\n--- SIMULATION RESULTS ---`);
  if (report.metrics) {
      console.log(`Player 1 Expected Win Rate: ${report.metrics.expectedWinRate ? report.metrics.expectedWinRate * 100 + "%" : "N/A"}`);
      console.log(`Expected Player VP: ${report.metrics.expectedPlayerVp} | Expected Opponent VP: ${report.metrics.expectedOpponentVp}`);
  }
}

main().catch(console.error);
