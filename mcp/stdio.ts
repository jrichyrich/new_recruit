import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  previewFactionStressPortfolio,
} from "../lib/rosterpilot";
import {
  writeExportArtifact,
  writeExportArtifacts,
} from "../lib/rosterpilot/io";
import {
  deliverRosterToNewRecruit,
  getNewRecruitConnectionStatus,
} from "../local/new-recruit/companion";
import {
  analyzeRosterMatchup,
  compareRosterRevision,
  getTesseraConnectionStatus,
  prepareRosterForTessera,
} from "../local/tessera/companion";
import {
  compareRosterStressRevision,
  runRosterStressTest,
} from "../local/tessera/stress";
import {
  buildAndStressRosterAgainstFaction,
} from "../local/tessera/full-loop";
import { createRosterPilotMcpServer } from "./server";

const server = createRosterPilotMcpServer({
  artifactWriter: (artifact, outputPath, overwrite) =>
    writeExportArtifact(artifact, outputPath, { overwrite }),
  handoffWriter: (artifacts, outputDirectory, overwrite) =>
    writeExportArtifacts(artifacts, outputDirectory, { overwrite }),
  newRecruitCompanion: {
    status: getNewRecruitConnectionStatus,
    deliver: (roster, options) =>
      deliverRosterToNewRecruit(roster, options),
  },
  tesseraCompanion: {
    status: getTesseraConnectionStatus,
    prepare: (roster, options) =>
      prepareRosterForTessera(roster, options),
    analyze: (playerRoster, opponent, options) =>
      analyzeRosterMatchup(playerRoster, opponent, options),
    compare: (baselineReportPath, revisedRoster, options) =>
      compareRosterRevision(baselineReportPath, revisedRoster, options),
    stressTest: (playerRoster, opponent, options) =>
      runRosterStressTest(playerRoster, opponent, options),
    previewPortfolio: (input) =>
      previewFactionStressPortfolio(input),
    buildAndStress: (input, options) =>
      buildAndStressRosterAgainstFaction(input, options),
    compareStressRevision: (baselineReportPath, revisedRoster, options) =>
      compareRosterStressRevision(
        baselineReportPath,
        revisedRoster,
        options,
      ),
  },
});

const transport = new StdioServerTransport();
await server.connect(transport);
