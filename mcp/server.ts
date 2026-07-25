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
  prepareNewRecruitHandoff,
  searchFactions,
  searchUnits,
  validateRoster,
  type ExportArtifact,
  type ExportFormat,
  type ModifyRosterOperation,
  type NewRecruitConnectionStatus,
  type NewRecruitDelivery,
  type NewRecruitHandoff,
  type PreferenceTag,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../lib/rosterpilot/index";

type ArtifactWriter = (
  artifact: ExportArtifact,
  outputPath: string,
  overwrite: boolean,
) => Promise<string>;

type HandoffWriter = (
  artifacts: ExportArtifact[],
  outputDirectory: string,
  overwrite: boolean,
) => Promise<string[]>;

type ServerOptions = {
  artifactWriter?: ArtifactWriter;
  handoffWriter?: HandoffWriter;
  newRecruitCompanion?: {
    status: () => Promise<ResultEnvelope<NewRecruitConnectionStatus>>;
    deliver: (
      roster: RosterDraftV1,
      options: {
        downloadPrettyHtml: boolean;
        outputDirectory: string;
        overwrite: boolean;
      },
    ) => Promise<ResultEnvelope<NewRecruitDelivery>>;
  };
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
  const data = serializableArtifact(artifact);
  return resultContent({
    ok: result.ok,
    data,
    violations: result.violations,
    warnings: result.warnings,
  });
}

function serializableArtifact(artifact: ExportArtifact) {
  return {
    format: artifact.format,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    encoding: artifact.encoding === "binary" ? "base64" : "utf8",
    content:
      typeof artifact.content === "string"
        ? artifact.content
        : bytesToBase64(artifact.content),
  };
}

function inlineHandoff(result: ResultEnvelope<NewRecruitHandoff>) {
  if (!result.data) return resultContent(result);
  const data = {
    ...result.data,
    artifacts: result.data.artifacts.map(serializableArtifact),
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

  server.registerTool(
    "prepare_new_recruit_handoff",
    {
      title: "Prepare a New Recruit handoff",
      description:
        "Validate a roster and prepare an editable .rosz plus optional printable HTML. Local stdio may write both files to a directory; remote transports return inline content.",
      inputSchema: {
        roster: z.unknown(),
        includeHtml: z.boolean().default(true),
        outputDirectory: z.string().optional(),
        overwrite: z.boolean().default(false),
      },
    },
    async ({ roster, includeHtml, outputDirectory, overwrite }) => {
      const result = prepareNewRecruitHandoff(
        roster as RosterDraftV1,
        includeHtml,
      );
      if (!result.data || !outputDirectory) return inlineHandoff(result);
      if (!options.handoffWriter) {
        return resultContent({
          ok: false,
          data: null,
          violations: [
            {
              code: "FILE_WRITES_DISABLED",
              message:
                "This MCP transport does not permit filesystem writes; omit outputDirectory to receive inline content.",
              severity: "error",
            },
          ],
          warnings: result.warnings,
        });
      }
      try {
        const written = await options.handoffWriter(
          result.data.artifacts,
          outputDirectory,
          overwrite,
        );
        return resultContent({
          ok: true,
          data: {
            rosterId: result.data.rosterId,
            rosterName: result.data.rosterName,
            totalPoints: result.data.totalPoints,
            pointsLimit: result.data.pointsLimit,
            importUrl: result.data.importUrl,
            instructions: result.data.instructions,
            artifacts: result.data.artifacts.map((artifact, index) => ({
              format: artifact.format,
              filename: artifact.filename,
              mimeType: artifact.mimeType,
              written: written[index],
            })),
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

  if (options.newRecruitCompanion) {
    server.registerTool(
      "get_new_recruit_connection_status",
      {
        title: "Get local New Recruit connection status",
        description:
          "Check whether the macOS-only New Recruit companion, dedicated Chrome profile, and login-Keychain credential are ready. Never returns credentials or browser storage.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => resultContent(await options.newRecruitCompanion!.status()),
    );

    server.registerTool(
      "deliver_roster_to_new_recruit",
      {
        title: "Deliver a roster to New Recruit",
        description:
          "After an explicit user request, validate a roster, import it into New Recruit as a new list, verify the result, and optionally download Pretty HTML. This is a non-idempotent external action.",
        inputSchema: {
          roster: z.unknown(),
          downloadPrettyHtml: z.boolean().default(true),
          outputDirectory: z.string().default("exports/new-recruit"),
          overwrite: z.boolean().default(false),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        roster,
        downloadPrettyHtml,
        outputDirectory,
        overwrite,
      }) =>
        resultContent(
          await options.newRecruitCompanion!.deliver(
            roster as RosterDraftV1,
            {
              downloadPrettyHtml,
              outputDirectory,
              overwrite,
            },
          ),
        ),
    );
  }

  return server;
}
