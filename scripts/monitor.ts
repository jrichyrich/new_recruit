import { buildRoster } from "../lib/rosterpilot/index.ts";
import { deliverRosterToNewRecruit } from "../local/new-recruit/companion.ts";
import { analyzeRosterMatchup } from "../local/tessera/companion.ts";
import fs from "fs/promises";

async function main() {
  console.log("Generating Player 1: Chaos Space Marines");
  const p1 = buildRoster({
    faction: "chaos-space-marines",
    pointsLimit: 1000,
    name: "Visual Test CSM " + Math.floor(Math.random() * 10000),
    preferences: ["shooting", "durability"],
    allowLegends: false,
  });

  console.log("Generating Player 2: Aeldari");
  const p2 = buildRoster({
    faction: "aeldari",
    pointsLimit: 1000,
    name: "Visual Test Aeldari " + Math.floor(Math.random() * 10000),
    preferences: ["mobility", "shooting"],
    allowLegends: false,
  });

  if (!p1.ok || !p2.ok || !p1.data || !p2.data) {
    console.error("Failed to build rosters.");
    process.exit(1);
  }

  console.log(`Matchup: ${p1.data.name} (${p1.data.totalPoints}pts) vs ${p2.data.name} (${p2.data.totalPoints}pts)`);
  
  console.log("Uploading P1 to New Recruit (visibly)...");
  const p1Delivery = await deliverRosterToNewRecruit(p1.data, {
    enrichOnly: false,
    catalogueDriftMode: "force",
    downloadEnrichedRosz: true,
  });
  if (!p1Delivery.ok) {
    console.error("New Recruit upload failed for P1:", p1Delivery.violations);
    process.exit(1);
  }

  console.log("Uploading P2 to New Recruit (visibly)...");
  const p2Delivery = await deliverRosterToNewRecruit(p2.data, {
    enrichOnly: false,
    catalogueDriftMode: "force",
    downloadEnrichedRosz: true,
  });
  if (!p2Delivery.ok) {
    console.error("New Recruit upload failed for P2:", p2Delivery.violations);
    process.exit(1);
  }
  
  console.log("Submitting to PlayTessera for visual simulation...");
  const result = await analyzeRosterMatchup(
    p1.data,
    { kind: "roster", roster: p2.data },
    { 
      catalogueDriftMode: "force",
      simulationBackend: "website",
      outputDirectory: "exports/tessera/visual-monitor-test"
    }
  );

  if (!result.ok) {
    console.error("Simulation failed:", result.violations);
    process.exit(1);
  }

  console.log("Simulation complete!");
  const reportPath = "./visual_simulation_report.json";
  await fs.writeFile(reportPath, JSON.stringify(result.data, null, 2));
  console.log(`Detailed report written to ${reportPath}`);
}

main().catch(console.error);
