import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
  },
});

const transport = new StdioServerTransport();
await server.connect(transport);
