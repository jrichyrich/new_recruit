import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createLocalRosterPilotService } from "../local/service";
import { createRosterPilotMcpServer } from "./server";

const service = await createLocalRosterPilotService();
const server = createRosterPilotMcpServer({ service });
await server.connect(new StdioServerTransport());
