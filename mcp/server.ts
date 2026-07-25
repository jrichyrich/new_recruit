import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildRoster,
  bytesToBase64,
  compareFactions,
  explainRoster,
  exportRoster,
  getDataStatus,
  modifyRoster,
  searchFactions,
  searchUnits,
  validateRoster,
  type ExportArtifact,
  type ExportFormat,
  type ModifyRosterOperation,
  type PreferenceTag,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../lib/rosterpilot/index";

type ArtifactWriter = (
  artifact: ExportArtifact,
  outputPath: string,
  overwrite: boolean,
) => Promise<string>;

type ServerOptions = {
  artifactWriter?: ArtifactWriter;
};

function serializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resultContent<T>(result: ResultEnvelope<T>) {
  const normalized = serializable(result) as unknown as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(normalized, null, 2) }],
    structuredContent: normalized,
    isError: !result.ok,
  };
}

function inlineArtifact(result: ResultEnvelope<ExportArtifact>) {
  if (!result.data) return resultContent(result);
  const artifact = result.data;
  const data = {
    format: artifact.format,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    encoding: artifact.encoding === "binary" ? "base64" : "utf8",
    content:
      typeof artifact.content === "string"
        ? artifact.content
        : bytesToBase64(artifact.content),
  };
  return resultContent({
    ok: result.ok,
    data,
    violations: result.violations,
    warnings: result.warnings,
  });
}

export function createRosterPilotMcpServer(
  options: ServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "rosterpilot",
    version: "0.2.0",
  });

  server.registerTool(
    "get_data_status",
    {
      title: "Get roster data status",
      description:
        "Return the pinned data version, supported faction gate, coverage, and attribution.",
      inputSchema: {},
    },
    async () => resultContent(getDataStatus()),
  );

  server.registerTool(
    "search_factions",
    {
      title: "Search factions",
      description:
        "Search all embedded 11th-edition factions. Building support is currently gated to Adeptus Custodes.",
      inputSchema: {
        query: z.string().default(""),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ query, limit }) => resultContent(searchFactions(query, limit)),
  );

  server.registerTool(
    "compare_factions",
    {
      title: "Compare factions",
      description: "Compare faction unit coverage and inferred play-style tags.",
      inputSchema: {
        factions: z.array(z.string()).min(2).max(8),
      },
    },
    async ({ factions: factionQueries }) =>
      resultContent(compareFactions(factionQueries)),
  );

  server.registerTool(
    "search_units",
    {
      title: "Search units",
      description:
        "Search units by faction, name, keyword, role, and structured preference tags.",
      inputSchema: {
        faction: z.string().default("adeptus-custodes"),
        query: z.string().default(""),
        tags: z
          .array(
            z.enum([
              "mobility",
              "durability",
              "objective",
              "shooting",
              "melee",
              "elite",
              "horde",
            ]),
          )
          .default([]),
        includeLegends: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(30),
      },
    },
    async (input) =>
      resultContent(
        searchUnits({
          ...input,
          tags: input.tags as PreferenceTag[],
        }),
      ),
  );

  server.registerTool(
    "build_roster",
    {
      title: "Build a deterministic roster",
      description:
        "Build a Custodes roster from natural language and/or structured constraints. Points and legality are calculated by the engine, never by the model.",
      inputSchema: {
        prompt: z.string().optional(),
        faction: z.string().optional(),
        pointsLimit: z.number().int().min(100).max(5000).optional(),
        name: z.string().optional(),
        preferences: z
          .array(
            z.enum([
              "mobility",
              "durability",
              "objective",
              "shooting",
              "melee",
              "elite",
              "horde",
            ]),
          )
          .optional(),
        allowNamedCharacters: z.boolean().optional(),
        allowLegends: z.boolean().optional(),
        collectionUnitIds: z.array(z.string()).optional(),
        detachmentId: z.string().optional(),
        forceDispositionId: z.string().optional(),
      },
    },
    async (input) =>
      resultContent(
        buildRoster({
          ...input,
          preferences: input.preferences as PreferenceTag[] | undefined,
        }),
      ),
  );

  server.registerTool(
    "modify_roster",
    {
      title: "Modify a roster",
      description:
        "Apply one explicit add, remove, replace, model-count, warlord, equipment, enhancement, detachment, or disposition operation and revalidate.",
      inputSchema: {
        roster: z.unknown(),
        operation: z.unknown(),
      },
    },
    async ({ roster, operation }) =>
      resultContent(
        modifyRoster(
          roster as RosterDraftV1,
          operation as ModifyRosterOperation,
        ),
      ),
  );

  server.registerTool(
    "validate_roster",
    {
      title: "Validate a roster",
      description:
        "Recalculate points and run the pinned loadout and army-construction legality checks.",
      inputSchema: { roster: z.unknown() },
    },
    async ({ roster }) => resultContent(validateRoster(roster as RosterDraftV1)),
  );

  server.registerTool(
    "explain_roster",
    {
      title: "Explain a roster",
      description:
        "Explain how each selection supports the requested preferences and include every validation caution.",
      inputSchema: { roster: z.unknown() },
    },
    async ({ roster }) => resultContent(explainRoster(roster as RosterDraftV1)),
  );

  server.registerTool(
    "export_roster",
    {
      title: "Export a roster",
      description:
        "Export a validated roster as .ros, .rosz, New Recruit JSON, canonical roster JSON, text, or printable HTML. Writing requires an explicit path and never overwrites by default.",
      inputSchema: {
        roster: z.unknown(),
        format: z.enum([
          "ros",
          "rosz",
          "newrecruit-json",
          "roster-json",
          "text",
          "html",
        ]),
        outputPath: z.string().optional(),
        overwrite: z.boolean().default(false),
      },
    },
    async ({ roster, format, outputPath, overwrite }) => {
      const result = exportRoster(
        roster as RosterDraftV1,
        format as ExportFormat,
      );
      if (!result.data || !outputPath) return inlineArtifact(result);
      if (!options.artifactWriter) {
        return resultContent({
          ok: false,
          data: null,
          violations: [
            {
              code: "FILE_WRITES_DISABLED",
              message:
                "This MCP transport does not permit filesystem writes; omit outputPath to receive inline content.",
              severity: "error",
            },
          ],
          warnings: result.warnings,
        });
      }
      try {
        const written = await options.artifactWriter(
          result.data,
          outputPath,
          overwrite,
        );
        return resultContent({
          ok: true,
          data: {
            format: result.data.format,
            filename: result.data.filename,
            mimeType: result.data.mimeType,
            written,
          },
          violations: [],
          warnings: result.warnings,
        });
      } catch (error) {
        return resultContent({
          ok: false,
          data: null,
          violations: [
            {
              code: "WRITE_FAILED",
              message: error instanceof Error ? error.message : "Write failed.",
              severity: "error",
            },
          ],
          warnings: result.warnings,
        });
      }
    },
  );

  return server;
}
