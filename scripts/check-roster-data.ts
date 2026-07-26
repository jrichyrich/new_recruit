import { factions } from "@alpaca-software/40kdc-data";
import {
  buildRoster,
  exportRoster,
  getDataStatus,
  validateRoster,
} from "../lib/rosterpilot";

async function latestPublishedVersion(): Promise<string | null> {
  if (!process.argv.includes("--latest")) return null;
  const response = await fetch(
    "https://registry.npmjs.org/@alpaca-software%2F40kdc-data/latest",
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) {
    throw new Error(`Registry check failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as { version?: string };
  return payload.version ?? null;
}

const status = getDataStatus();
if (!status.ok || !status.data) throw new Error("Roster data status failed.");
if (status.data.provisionalCustodesPoints > 0) {
  throw new Error(
    `${status.data.provisionalCustodesPoints} Custodes datasheets still have provisional points.`,
  );
}

const factionCoverage = factions.all.map((faction) => {
  const result = buildRoster({
    faction: faction.id,
    pointsLimit: 1000,
    name: `${faction.name} coverage check`,
    preferences: ["mobility", "objective", "shooting"],
    allowLegends: false,
  });
  if (!result.ok || !result.data) {
    throw new Error(
      `${faction.name} coverage failed: ${result.violations
        .map((item) => item.message)
        .join("; ")}`,
    );
  }
  return faction.id;
});

const fixture = buildRoster({
  prompt: "Build a 1,000 point fast Custodes army with no named characters",
});
if (!fixture.ok || !fixture.data) {
  throw new Error(
    `Acceptance roster failed: ${fixture.violations.map((item) => item.message).join("; ")}`,
  );
}
const validation = validateRoster(fixture.data);
if (!validation.ok) {
  throw new Error(
    `Acceptance roster is illegal: ${validation.violations.map((item) => item.message).join("; ")}`,
  );
}
for (const format of ["ros", "rosz", "newrecruit-json", "roster-json"] as const) {
  const result = exportRoster(fixture.data, format);
  if (!result.ok || !result.data) {
    throw new Error(`${format} export failed.`);
  }
}

const latest = await latestPublishedVersion();
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      pinnedVersion: status.data.packageVersion,
      latestPublishedVersion: latest,
      updateAvailable:
        latest !== null && latest !== status.data.packageVersion,
      custodesUnits: status.data.custodesUnitCount,
      buildableFactions: factionCoverage.length,
      totalUnits: status.data.unitCount,
      provisionalPoints: status.data.provisionalPoints,
      acceptanceRosterPoints: fixture.data.totalPoints,
      exports: ["ros", "rosz", "newrecruit-json", "roster-json"],
    },
    null,
    2,
  )}\n`,
);
