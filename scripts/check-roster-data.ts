import { factions } from "@alpaca-software/40kdc-data";
import {
  buildRoster,
  checkDataFreshness,
  exportRoster,
  getDataStatus,
  newRecruitCatalogue,
  validateRoster,
} from "../lib/rosterpilot";

const status = getDataStatus();
if (!status.ok || !status.data) throw new Error("Roster data status failed.");
if (status.data.packageVersion !== newRecruitCatalogue.sources.rules.version) {
  throw new Error("The engine and generated catalogue use different rules pins.");
}
if (
  status.data.factionCount !== newRecruitCatalogue.summary.factionCount ||
  status.data.conflicts.total !== newRecruitCatalogue.summary.conflicts ||
  status.data.conflicts.unique !==
    (newRecruitCatalogue.summary.uniqueConflicts ??
      newRecruitCatalogue.summary.conflicts)
) {
  throw new Error("Generated catalogue summary does not match runtime status.");
}
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
  const result = await exportRoster(fixture.data, format);
  if (!result.ok || !result.data) {
    throw new Error(`${format} export failed.`);
  }
}

const crossFactionFixture = buildRoster({
  faction: "necrons",
  pointsLimit: 1000,
  allowNamedCharacters: false,
});
if (!crossFactionFixture.ok || !crossFactionFixture.data) {
  throw new Error("Cross-faction New Recruit acceptance roster failed.");
}
const crossFactionExport = await exportRoster(crossFactionFixture.data, "rosz");
if (!crossFactionExport.ok || !crossFactionExport.data) {
  throw new Error(
    `Cross-faction ROSZ export failed: ${crossFactionExport.violations
      .map((item) => item.message)
      .join("; ")}`,
  );
}

const freshness = process.argv.includes("--latest")
  ? await checkDataFreshness()
  : null;
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      releaseId: status.data.sources.releaseId,
      pinnedVersion: status.data.packageVersion,
      liveFreshness: freshness?.data ?? null,
      custodesUnits: status.data.custodesUnitCount,
      buildableFactions: factionCoverage.length,
      totalUnits: status.data.unitCount,
      provisionalPoints: status.data.provisionalPoints,
      newRecruitCoverage: status.data.newRecruitCoverage,
      conflicts: status.data.conflicts,
      acceptanceRosterPoints: fixture.data.totalPoints,
      exports: ["ros", "rosz", "newrecruit-json", "roster-json"],
      crossFactionRosz: crossFactionFixture.data.factionName,
    },
    null,
    2,
  )}\n`,
);
