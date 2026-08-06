import { buildRoster } from "../lib/rosterpilot/index.ts";
import { deliverRosterToNewRecruit } from "../local/new-recruit/companion.ts";
import { prepareRosterForTessera } from "../local/tessera/companion.ts";

async function main() {
  const factions = ["necrons", "tau", "orks"];
  let successCount = 0;

  for (const faction of factions) {
    console.log(`\n===========================================`);
    console.log(`Testing E2E Upload for Faction: ${faction}`);
    console.log(`===========================================`);
    try {
      console.log(`Building random 2000 point list (${faction})...`);
      const draft = buildRoster({
        faction: faction,
        pointsLimit: 2000,
        name: `Random ${faction} Army ` + Math.floor(Math.random() * 10000),
        preferences: ["mobility", "shooting"],
        allowLegends: false,
      });
      
      if (!draft.ok || !draft.data) {
        throw new Error("Failed to build roster: " + JSON.stringify(draft.violations));
      }
      
      console.log("Roster successfully built:", draft.data.name, "with", draft.data.totalPoints, "points.");
      
      console.log("\nDelivering to New Recruit (Upload)...");
      const delivery = await deliverRosterToNewRecruit(draft.data, {
        downloadPrettyHtml: false,
        downloadEnrichedRosz: true,
        catalogueDriftMode: "diagnostic",
      });
      
      let enrichedRoszPath = delivery.data?.enrichedRoszPath;
      const listUrl = delivery.data?.listUrl;

      if (!delivery.ok || !delivery.data) {
        const driftViolation = delivery.violations?.find(v => v.code === "NEW_RECRUIT_CATALOGUE_DRIFT" || v.code === "TESSERA_VERIFIED_CATALOGUE_DRIFT_DIAGNOSTIC");
        if (driftViolation) {
          console.log("Catalogue drift detected, using diagnostic output...");
          const match = driftViolation.message.match(/retained at (\/.*?\.rosz)/);
          if (match) {
            enrichedRoszPath = match[1];
            console.log("Found diagnostic artifact:", enrichedRoszPath);
          } else {
            throw new Error("New Recruit upload failed with drift, but no diagnostic artifact path found: " + JSON.stringify(delivery.violations));
          }
        } else {
          throw new Error("New Recruit upload failed: " + JSON.stringify(delivery.violations));
        }
      }
      
      if (listUrl) {
        console.log("Upload succeeded! New Recruit List URL:", listUrl);
      }
      if (enrichedRoszPath) {
         console.log("Downloaded Enriched ROSZ from New Recruit to:", enrichedRoszPath);
      }
      
      console.log("\nPreparing Roster for PlayTessera...");
      const tessera = await prepareRosterForTessera(draft.data, {
         enrichedRoszPath: enrichedRoszPath,
         newRecruitListUrl: listUrl,
      });
      
      console.log("PlayTessera preparation completed successfully!");
      if (tessera.warnings && tessera.warnings.length > 0) {
        console.log("PlayTessera Warnings:", tessera.warnings.map(w => w.code).join(", "));
      }
      successCount++;
    } catch (e) {
      console.error(`\n[!] Test failed for ${faction}:`, e);
    }
  }

  console.log(`\nCompleted tests. ${successCount}/${factions.length} uploads succeeded.`);
  if (successCount !== factions.length) {
    process.exit(1);
  }
}

main();
