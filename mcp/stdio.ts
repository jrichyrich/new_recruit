import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  writeExportArtifact,
  writeExportArtifacts,
} from "../lib/rosterpilot/io";
import {
  deliverRosterToNewRecruit,
  getNewRecruitConnectionStatus,
} from "../local/new-recruit/companion";
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
});

const transport = new StdioServerTransport();
await server.connect(transport);
