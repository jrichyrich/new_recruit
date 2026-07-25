import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { writeExportArtifact } from "../lib/rosterpilot/io";
import { createRosterPilotMcpServer } from "./server";

const server = createRosterPilotMcpServer({
  artifactWriter: (artifact, outputPath, overwrite) =>
    writeExportArtifact(artifact, outputPath, { overwrite }),
});

const transport = new StdioServerTransport();
await server.connect(transport);
