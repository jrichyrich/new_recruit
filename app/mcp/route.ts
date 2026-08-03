import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  authorizeRemoteRequest,
  remoteOptions,
  withRemoteCors,
} from "@/lib/rosterpilot/remote";
import {
  getDataUpdateStatus,
  getConfiguredDataBundleProvider,
} from "@/lib/rosterpilot";
import { createRosterPilotMcpServer } from "@/mcp/server";
import {
  initializeHostedDataForRequest,
} from "@/app/hosted-data-bundles";

async function handle(request: Request): Promise<Response> {
  const denied = authorizeRemoteRequest(request);
  if (denied) return withRemoteCors(denied, request);
  await initializeHostedDataForRequest(request);
  const dataUpdateStatus = await getDataUpdateStatus();
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createRosterPilotMcpServer({
    localDataUpdates:
      dataUpdateStatus.data?.providerMode === "local-source",
    dataBundleProvider:
      getConfiguredDataBundleProvider() ?? undefined,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  return withRemoteCors(response, request);
}

export function OPTIONS(request: Request) {
  return remoteOptions(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
