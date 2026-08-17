import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  ROSTERPILOT_SERVICE_VERSION,
  RosterPilotService,
  type ActRequest,
  type InspectRequest,
  type OperationSummary,
  type RunRequest,
} from "../lib/rosterpilot/service";

export type RosterPilotMcpServerOptions = {
  service: RosterPilotService;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function resultText(value: Record<string, unknown>): string {
  const message = typeof value.message === "string"
    ? value.message
    : "RosterPilot returned a result.";
  const operationId = typeof value.operationId === "string"
    ? ` Operation: ${value.operationId}.`
    : "";
  return `${message}${operationId}`;
}

const MCP_RESULT_BUDGET = 4_096;

function compactStructured(value: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(value);
  if (Array.isArray(next.artifacts)) {
    next.artifacts = next.artifacts.map((candidate) => {
      const artifact = object(candidate);
      return {
        uri: artifact.uri,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes,
      };
    });
  }
  const result = next.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const comparison = (result as {
      opponentComparison?: Record<string, unknown>;
    }).opponentComparison;
    if (comparison) {
      const portfolio = comparison.portfolio;
      if (portfolio && typeof portfolio === "object" && !Array.isArray(portfolio)) {
        delete (portfolio as { hash?: unknown }).hash;
      }
      if (Array.isArray(comparison.alternatives)) {
        comparison.alternatives = comparison.alternatives.map((entry) => {
          const alternative = object(entry);
          return {
            contrast: alternative.contrast,
            floor: alternative.floor,
          };
        });
      }
      const recommended = comparison.recommended;
      const roster = next.roster;
      if (
        recommended &&
        typeof recommended === "object" &&
        roster &&
        typeof roster === "object" &&
        (recommended as { rosterRef?: unknown }).rosterRef ===
          (roster as { rosterRef?: unknown }).rosterRef
      ) {
        delete (recommended as { rosterRef?: unknown }).rosterRef;
      }
    }
  }
  return next;
}

function resultEnvelope(
  structured: Record<string, unknown>,
  isError: boolean,
) {
  const resources = Array.isArray(structured.artifacts)
    ? structured.artifacts.flatMap((candidate) => {
        const artifact = object(candidate);
        return typeof artifact.uri === "string" &&
          typeof artifact.filename === "string"
          ? [{
              type: "resource_link" as const,
              uri: artifact.uri,
              name: artifact.filename,
              mimeType:
                typeof artifact.mimeType === "string"
                  ? artifact.mimeType
                  : undefined,
              description: "Full artifact.",
            }]
          : [];
      })
    : [];
  return {
    content: [
      { type: "text" as const, text: resultText(structured) },
      ...resources,
    ],
    structuredContent: structured,
    isError,
  };
}

function resultContent(value: unknown, isError = false) {
  const structured = compactStructured(object(value));
  const envelope = resultEnvelope(structured, isError);
  if (Buffer.byteLength(JSON.stringify(envelope)) <= MCP_RESULT_BUDGET) {
    return envelope;
  }
  const roster = structured.roster;
  if (roster && typeof roster === "object" && !Array.isArray(roster)) {
    const units = (roster as { units?: unknown[] }).units;
    if (Array.isArray(units) && units.length > 4) {
      (roster as { units: unknown[] }).units = units.slice(0, 4);
    }
  }
  return resultEnvelope(structured, isError);
}

function operationResult(operation: OperationSummary) {
  return resultContent(operation, operation.state === "failed");
}

export function createRosterPilotMcpServer(
  options: RosterPilotMcpServerOptions,
): McpServer {
  const { service } = options;
  const server = new McpServer({
    name: "rosterpilot",
    version: ROSTERPILOT_SERVICE_VERSION,
  });

  server.registerTool(
    "run",
    {
      title: "Run a RosterPilot workflow",
      description:
        "Research, build, modify, export, sync, compare exact rosters, or run Tessera stress tests locally or on the website. Build options use pointsLimit (not pointLimit) and include playerFaction, opponentFaction, preferences, legendsPolicy, collectionProfile, opponentAssumptions, detachmentId, forceDispositionId, compareOpponentOptions, and comparisonDepth. Fresh exact local stress can select optional player abilities with selectedPlayerAbilityIds, inspect all optional activations with activationMode=envelope, and bind explicit leader/bodyguard selection IDs with selectedAttachmentBindings. Stress catalogueDriftMode defaults to reject and permits only reject or diagnostic. Pass references instead of full roster documents.",
      inputSchema: {
        action: z.enum([
          "research",
          "build",
          "modify",
          "export",
          "matchup",
          "stress",
          "sync",
        ]),
        request: z.string().max(4_000).optional(),
        rosterRef: z.string().max(256).optional(),
        opponentRef: z.string().max(256).optional(),
        format: z.enum([
          "ros",
          "rosz",
          "newrecruit-json",
          "roster-json",
          "text",
          "html",
        ]).optional(),
        options: z.record(z.unknown()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => operationResult(
      await service.run(input as RunRequest),
    ),
  );

  server.registerTool(
    "inspect",
    {
      title: "Inspect RosterPilot state",
      description:
        "Read a compact operation, roster, artifact, data, or New Recruit status by reference. Use MCP resources for full content.",
      inputSchema: {
        ref: z.string().min(1).max(256),
        view: z.enum(["summary", "details", "artifact"]).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const value = await service.inspect(input as InspectRequest);
      return resultContent(value, value.ok === false);
    },
  );

  server.registerTool(
    "act",
    {
      title: "Continue or approve an operation",
      description:
        "Apply one typed next action. Authenticated New Recruit upload and Tessera Website execution require confirm=true and the current operation revision.",
      inputSchema: {
        operationId: z.string().min(1).max(160),
        expectedRevision: z.number().int().nonnegative(),
        actionId: z.string().min(1).max(160),
        choice: z.string().max(512).optional(),
        confirm: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => operationResult(
      await service.act(input as ActRequest),
    ),
  );

  for (const kind of ["operations", "rosters", "artifacts"] as const) {
    server.registerResource(
      `rosterpilot-${kind}`,
      new ResourceTemplate(`rosterpilot://${kind}/{id}`, {
        list: undefined,
      }),
      {
        title: `RosterPilot ${kind}`,
        description: `Full persisted RosterPilot ${kind} content.`,
      },
      async (uri) => ({
        contents: [await service.readResource(uri.href)],
      }),
    );
  }

  return server;
}
