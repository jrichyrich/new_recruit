import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { factions } from "@alpaca-software/40kdc-data";

import {
  CertificationManifestSchema,
  buildCertificationRepresentative,
  certificationExpertReviewBinding,
  generateRepresentativeGoldenEvidence,
  synchronizeCertificationExpertReview,
  synchronizedTesseraPreparationExpectation,
  type CertificationManifest,
} from "../lib/rosterpilot/certification";
import {
  getDataStatus,
  getNewRecruitCapability,
  listDetachments,
  newRecruitCatalogue,
} from "../lib/rosterpilot";
import {
  BrowserFixtureRegistrySchema,
} from "../local/certification/browser-fixture-execution";

const mode = process.argv.includes("--write") ? "write" : "check";
const filename = path.resolve(
  "data",
  "certification-manifest.json",
);
const sourceText = await readFile(filename, "utf8");
const sourceDocument: unknown = JSON.parse(sourceText);
const current = CertificationManifestSchema.parse(
  sourceDocument,
);
const browserFixtureRegistry =
  BrowserFixtureRegistrySchema.parse(
    JSON.parse(
      await readFile(
        path.resolve(
          "data",
          "certification-browser-fixtures.json",
        ),
        "utf8",
      ),
    ),
  );
const status = getDataStatus();
if (!status.data) {
  throw new Error("Roster data status could not be loaded.");
}
const existing = new Map(
  current.factions.map((faction) => [faction.id, faction]),
);
const uniqueBlockingConflicts =
  newRecruitCatalogue.summary.uniqueBlockingConflicts ??
  current.baselines.uniqueBlockingConflicts;
type RepresentativeRoster =
  CertificationManifest["factions"][number]["representativeRosters"][number];
const nextDataPin: CertificationManifest["dataPin"] = {
  releaseId: status.data.sources.releaseId,
  rulesPackageVersion: status.data.packageVersion,
  newRecruitRepository:
    status.data.sources.newRecruit.repository,
  newRecruitCommit: status.data.sources.newRecruit.commit,
  newRecruitGameSystemRevision:
    status.data.sources.newRecruit.gameSystemRevision,
  officialMfmVersion:
    status.data.sources.official.mfmVersion,
  officialMfmContentSha256:
    status.data.sources.official.contentSha256,
};

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        while (nextIndex < values.length) {
          const index = nextIndex;
          nextIndex += 1;
          output[index] = await operation(values[index]);
        }
      },
    ),
  );
  return output;
}

const nextFactions = await mapWithConcurrency(
  factions.all,
  // Golden roster construction touches shared rules-package caches. Keep the
  // oracle single-threaded so faction/export generation order cannot change
  // fingerprints between otherwise identical processes.
  1,
  async (faction): Promise<
    CertificationManifest["factions"][number]
  > => {
    const prior = existing.get(faction.id);
    const capability = getNewRecruitCapability(faction.id);
    const newlyExportCapable =
      capability.available &&
      prior?.newRecruitExport === "unsupported";
    const newRecruitExport = capability.available
      ? ("required" as const)
      : ("unsupported" as const);
    const tesseraPreparation =
      synchronizedTesseraPreparationExpectation({
        mappingAvailable: capability.available,
        priorNewRecruitExport: prior?.newRecruitExport,
        priorTesseraPreparation: prior?.tesseraPreparation,
      });
    const representativeRosters: RepresentativeRoster[] =
      prior?.representativeRosters.length
        ? prior.representativeRosters
        : current.defaults.pointBands.map<RepresentativeRoster>(
            (pointsLimit, index) => ({
              id: `core-${pointsLimit}`,
              pointsLimit,
              capabilities:
                index === 0
                  ? [
                      "roster-correctness",
                      "new-recruit-export",
                      "new-recruit-delivery",
                      "tessera-preparation",
                      "tessera-simulation",
                    ]
                  : ["roster-correctness"],
              minimumPointsUtilization:
                current.defaults.minimumPointsUtilization,
            }),
          );
    const nextFactionWithoutGolden: CertificationManifest["factions"][number] = {
      id: faction.id,
      name: faction.name,
      rosterCorrectness:
        prior?.rosterCorrectness ?? ("required" as const),
      newRecruitExport,
      newRecruitDelivery:
        prior?.newRecruitDelivery ?? newRecruitExport,
      tesseraPreparation,
      trustedTesseraSimulation:
        prior?.trustedTesseraSimulation ??
        (tesseraPreparation === "unsupported"
          ? ("unsupported" as const)
          : ("required" as const)),
      expectedBlockingConflicts: capability.blockingConflicts,
      detachmentIds: listDetachments(faction.id)
        .map((detachment) => detachment.id)
        .sort(),
      representativeRosters: representativeRosters.map((roster) => ({
        ...roster,
        capabilities:
          capability.available &&
          roster.capabilities.includes("roster-correctness")
            ? [
                ...new Set([
                  ...roster.capabilities,
                  "new-recruit-export" as const,
                ]),
              ]
            : roster.capabilities,
      })),
      expectedLimitations: capability.available
        ? newlyExportCapable
          ? [
              "New Recruit mapping became available under this pin; core-3 posture feasibility requires certification review before this capability can be declared complete.",
            ]
          : (prior?.expectedLimitations ?? [])
        : prior?.expectedLimitations.length
          ? prior.expectedLimitations
          : [
              capability.reason ??
                "The pinned catalogue does not expose a sufficiently mapped configuration and unit set.",
            ],
      ...(prior?.portfolioPolicy
        ? { portfolioPolicy: prior.portfolioPolicy }
        : {}),
      expertReview: prior?.expertReview ?? {
        status: "pending" as const,
        assertions: [],
      },
    };
    const nextFaction: CertificationManifest["factions"][number] = {
      ...nextFactionWithoutGolden,
      representativeRosters: [],
    };
    const preparedRepresentatives =
      nextFactionWithoutGolden.representativeRosters.map(
        (roster) => ({
          roster,
          representative: buildCertificationRepresentative({
            manifest: { defaults: current.defaults },
            faction: nextFactionWithoutGolden,
            contract: roster,
          }),
        }),
      );
    for (const {
      roster,
      representative,
    } of preparedRepresentatives) {
      nextFaction.representativeRosters.push({
        ...roster,
        goldenEvidence:
          await generateRepresentativeGoldenEvidence({
            manifest: { defaults: current.defaults },
            faction: nextFactionWithoutGolden,
            contract: roster,
            representative,
          }),
      });
    }
    return {
      ...nextFaction,
      expertReview: synchronizeCertificationExpertReview({
        review: nextFaction.expertReview,
        expectedBinding: certificationExpertReviewBinding(
          {
            dataPin: nextDataPin,
            defaults: current.defaults,
          },
          nextFaction,
        ),
      }),
    };
  },
);

const next: CertificationManifest = {
  ...current,
  dataPin: nextDataPin,
  baselines: {
    buildableFactions: status.data.buildableFactionCount,
    exportCapableFactions:
      status.data.newRecruitCoverage.exportCapableFactions,
    blockingConflicts: status.data.conflicts.blocking,
    ...(uniqueBlockingConflicts !== undefined
      ? {
          uniqueBlockingConflicts,
        }
      : {}),
  },
  browserFixtures: browserFixtureRegistry.fixtures.map(
    (fixture) => fixture.id,
  ),
  factions: nextFactions,
};
const nextText = `${JSON.stringify(next, null, 2)}\n`;
const changed = sourceText !== nextText;

if (mode === "write") {
  if (changed) {
    await writeFile(filename, nextText);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      changed,
      filename,
      factions: next.factions.length,
      blockingConflicts: next.baselines.blockingConflicts,
    })}\n`,
  );
} else if (changed) {
  process.stderr.write(
    "The certification manifest is out of sync with the pinned data. Run npm run certify:manifest:sync and review the capability changes.\n",
  );
  process.exitCode = 2;
} else {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      changed: false,
      filename,
      factions: next.factions.length,
      blockingConflicts: next.baselines.blockingConflicts,
    })}\n`,
  );
}
