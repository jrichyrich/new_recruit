import { buildRoster } from "/Users/jasricha/Documents/Github_Personal/new_recruit/lib/rosterpilot/index.ts";
import { initializeLocalDataBundleProvider } from "/Users/jasricha/Documents/Github_Personal/new_recruit/local/data-bundles/configure.ts";
import { withDataBundleSnapshotLease } from "/Users/jasricha/Documents/Github_Personal/new_recruit/lib/rosterpilot/index.ts";

async function main() {
  await initializeLocalDataBundleProvider();
  await withDataBundleSnapshotLease(async () => {
    console.log("Starting buildRoster test...");
    const seed = buildRoster({
      prompt: "Build a strong Custodes army that can beat World Eaters",
      playerFaction: "adeptus-custodes",
      pointsLimit: 1000,
    });
    console.log("buildRoster completed:", seed.ok);
    if (!seed.ok) {
      console.error(JSON.stringify(seed.violations, null, 2));
    }
  });
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
