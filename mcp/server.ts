import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  StartTesseraRunOptions,
  TesseraRunJob,
  TesseraRunRequest,
  TesseraRunResult,
} from "../local/tessera/jobs";

import {
  buildRoster,
  bytesToBase64,
  checkDataFreshness,
  compactBuildAndStressResult,
  compactBuildAndAnalyzeResult,
  compactStressResult,
  compactStressRevisionResult,
  compareFactions,
  explainRoster,
  exportRoster,
  getNewRecruitCapability,
  getDataStatus,
  getDataUpdateStatus,
  listDataConflicts,
  modifyRoster,
  modifyRosterBatch,
  prepareNewRecruitHandoff,
  rebaseRosterWithProvider,
  refreshDataNow,
  rollbackDataBundle,
  searchFactions,
  searchUnits,
  setCachedDataFreshness,
  validateRoster,
  withDataBundleSnapshotLease,
  CollectionProfileSchema,
  ModifyRosterOperationSchema,
  RosterDraftSchema,
  type ExportArtifact,
  type ExportFormat,
  type BuildAndStressRosterInput,
  type BuildAndStressRosterResult,
  type BuildAndAnalyzeRosterInput,
  type BuildAndAnalyzeRosterResult,
  type DataBundleProvider,
  type LiveDataFreshness,
  type ModifyRosterOperation,
  type NewRecruitConnectionStatus,
  type NewRecruitDelivery,
  type NewRecruitHandoff,
  type PreferenceTag,
  type ResultEnvelope,
  type RosterDraftV1,
  type RuntimeProvenance,
  type TesseraConnectionStatus,
  type TesseraMatchupReport,
  type TesseraMetric,
  type TesseraPhase,
  type TesseraPreparedRoster,
  type TesseraRevisionComparisonReport,
  type TesseraStressAnalysisStrategy,
  type TesseraStressPortfolioPreview,
  type TesseraStressRunReport,
  type TesseraStressRevisionReport,
  type TesseraStressSuite,
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
  runtimeProvenance?: () => RuntimeProvenance;
  artifactWriter?: ArtifactWriter;
  handoffWriter?: HandoffWriter;
  newRecruitCompanion?: {
    status: () => Promise<ResultEnvelope<NewRecruitConnectionStatus>>;
    deliver: (
      roster: RosterDraftV1,
      options: {
        downloadEnrichedRosz: boolean;
        downloadPrettyHtml: boolean;
        outputDirectory: string;
        overwrite: boolean;
      },
    ) => Promise<ResultEnvelope<NewRecruitDelivery>>;
  };
  tesseraCompanion?: {
    status: () => Promise<ResultEnvelope<TesseraConnectionStatus>>;
    prepare: (
      roster: RosterDraftV1,
      options: {
        outputDirectory: string;
        overwrite: boolean;
      },
    ) => Promise<ResultEnvelope<TesseraPreparedRoster>>;
    analyze: (
      playerRoster: RosterDraftV1,
      opponent:
        | { kind: "roster"; roster: RosterDraftV1 }
        | { kind: "rosz"; path: string },
      options: {
        outputDirectory: string;
        overwrite: boolean;
        executionMode?: "prepare-only" | "simulate";
        fallbackMode?: "none" | "baseline-damage-v1";
        profilePolicyPath?: string;
        experimental: boolean;
        analysisMode: "quick" | "full";
        phases?: TesseraPhase[];
        metrics?: TesseraMetric[];
        allowPointMismatch: boolean;
        includeChangeCandidates: boolean;
        opponentRosterContext?: RosterDraftV1;
      },
    ) => Promise<ResultEnvelope<TesseraMatchupReport>>;
    compare?: (
      baselineReportPath: string,
      revisedRoster: RosterDraftV1,
      options: {
        outputDirectory: string;
        overwrite: boolean;
        profilePolicyPath?: string;
        executionMode?: "simulate";
        experimental: boolean;
      },
    ) => Promise<ResultEnvelope<TesseraRevisionComparisonReport>>;
    buildAndAnalyze?: (
      input: BuildAndAnalyzeRosterInput,
      options: {
        outputDirectory?: string;
        overwrite: boolean;
      },
    ) => Promise<ResultEnvelope<BuildAndAnalyzeRosterResult>>;
    stressTest?: (
      playerRoster: RosterDraftV1,
      opponent: {
        kind: "faction";
        factionId: string;
      },
      options: {
        suite?: TesseraStressSuite;
        analysisStrategy?: TesseraStressAnalysisStrategy;
        resumeManifestPath?: string;
        restartManifestPath?: string;
        profilePolicyPath?: string;
        forceRetry?: boolean;
        executionMode?: "prepare-only" | "simulate";
        outputDirectory?: string;
        overwrite: boolean;
        experimental: boolean;
      },
    ) => Promise<ResultEnvelope<TesseraStressRunReport>>;
    previewPortfolio?: (input: {
      faction: string;
      pointsLimit: number;
      suite?: TesseraStressSuite;
      pointsTolerancePercent: number;
      allowLegends: boolean;
    }) => Promise<ResultEnvelope<TesseraStressPortfolioPreview>>;
    buildAndStress?: (
      input: BuildAndStressRosterInput,
      options: {
        outputDirectory?: string;
        overwrite: boolean;
      },
    ) => Promise<ResultEnvelope<BuildAndStressRosterResult>>;
    compareStressRevision?: (
      baselineReportPath: string,
      revisedRoster: RosterDraftV1,
      options: {
        outputDirectory?: string;
        overwrite: boolean;
        executionMode?: "simulate";
        experimental: boolean;
      },
    ) => Promise<ResultEnvelope<TesseraStressRevisionReport>>;
  };
  tesseraRunJobs?: {
    start: (
      request: TesseraRunRequest,
      options?: StartTesseraRunOptions,
    ) => Promise<TesseraRunJob>;
    status: (
      jobPath: string,
      includeResult?: boolean,
    ) => Promise<{
      job: TesseraRunJob;
      result: TesseraRunResult | null;
    }>;
    resume: (
      jobPath: string,
      options?: {
        restartFrom?: boolean;
        outputDirectory?: string;
      },
    ) => Promise<TesseraRunJob>;
    resolveProfiles: (
      jobPath: string,
      policy: {
        schemaVersion: 1;
        policyKind: "tessera-profile-policy";
        entries: Array<{
          faction: string;
          unit: string;
          unitOccurrence?: number;
          modelCount?: number;
          weaponGroup: string;
          phase: TesseraPhase;
          selectedProfile: string;
          activeCount: number;
        }>;
      },
    ) => Promise<TesseraRunJob>;
    cancel: (jobPath: string) => Promise<TesseraRunJob>;
  };
  freshnessChecker?: () => Promise<ResultEnvelope<LiveDataFreshness>>;
  freshnessCacheMs?: number;
  dataBundleProvider?: DataBundleProvider;
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

function opponentScopeRequired() {
  return {
    ok: false,
    data: null,
    violations: [
      {
        code: "OPPONENT_SCOPE_REQUIRED",
        message:
          "Provide an exact opponent roster or .rosz, or use the faction stress workflow when only the opponent faction is known.",
        severity: "error" as const,
      },
    ],
    warnings: [],
  };
}

function valueContent(value: unknown) {
  const normalized = serializable(value) as Record<string, unknown>;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(normalized, null, 2),
      },
    ],
    structuredContent: normalized,
  };
}

function shouldStartDurableTesseraRun(
  executionMode: "prepare-only" | "simulate" | undefined,
  experimental: boolean,
  recoveryRequested = false,
): boolean {
  return (
    recoveryRequested ||
    executionMode === "simulate" ||
    (executionMode === undefined && experimental)
  );
}

function inProgressJobContent(job: TesseraRunJob) {
  return valueContent({
    status: "in-progress",
    runId: job.runId,
    manifestPath: job.manifestPath,
    job,
  });
}

function detailedResultContent<T>(
  result: ResultEnvelope<T>,
  responseDetail: "compact" | "full",
  compact: (result: ResultEnvelope<T>) => Record<string, unknown>,
) {
  if (responseDetail === "full") return resultContent(result);
  const normalized = serializable(compact(result));
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(normalized, null, 2),
      },
    ],
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
  const registerTool = server.registerTool.bind(server);
  (
    server as unknown as {
      registerTool: (...args: unknown[]) => unknown;
    }
  ).registerTool = (...args: unknown[]) => {
    const toolName =
      typeof args[0] === "string" ? args[0] : "";
    const controlPlaneTool =
      toolName === "get_data_update_status" ||
      toolName === "refresh_data_now" ||
      toolName === "rollback_data_bundle";
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof handler === "function" && !controlPlaneTool) {
      args[handlerIndex] = (...handlerArgs: unknown[]) =>
        withDataBundleSnapshotLease(
          () => Reflect.apply(handler, undefined, handlerArgs),
          options.dataBundleProvider ?? null,
        );
    }
    return Reflect.apply(registerTool, server, args);
  };
  let freshnessCache:
    | {
        expiresAt: number;
        result: ResultEnvelope<LiveDataFreshness>;
      }
    | undefined;

  async function currentFreshness(
    force = false,
  ): Promise<ResultEnvelope<LiveDataFreshness>> {
    if (!force && freshnessCache && freshnessCache.expiresAt > Date.now()) {
      return freshnessCache.result;
    }
    const result = await (options.freshnessChecker ?? checkDataFreshness)();
    const cacheMs = options.freshnessCacheMs ?? 15 * 60_000;
    freshnessCache = {
      expiresAt: Date.now() + cacheMs,
      result,
    };
    setCachedDataFreshness(result, cacheMs);
    return result;
  }

  server.registerTool(
    "get_data_status",
    {
      title: "Get roster data status",
      description:
        "Return the active leased-data identity, exact source provenance, buildable factions, coverage, update-provider state, and attribution.",
      inputSchema: {},
    },
    async () => {
      const result = getDataStatus();
      const updateStatus = await getDataUpdateStatus(
        options.dataBundleProvider,
      );
      return resultContent({
        ...result,
        data:
          result.data
            ? {
                ...result.data,
                ...(updateStatus.data
                  ? { dataBundle: updateStatus.data }
                  : {}),
                ...(options.runtimeProvenance
                  ? { runtime: options.runtimeProvenance() }
                  : {}),
              }
            : result.data,
        warnings: [
          ...result.warnings,
          ...updateStatus.warnings,
          ...updateStatus.violations.map((violation) => ({
            ...violation,
            severity: "warn" as const,
          })),
        ],
      });
    },
  );

  server.registerTool(
    "check_data_freshness",
    {
      title: "Check live roster data freshness",
      description:
        "Compare the active bundle's exact source provenance with the current rules package, BSData commit, and official publication. This diagnostic is cached for 15 minutes unless force is true and never activates data.",
      inputSchema: {
        force: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ force }) => resultContent(await currentFreshness(force)),
  );

  server.registerTool(
    "get_data_update_status",
    {
      title: "Get signed data update status",
      description:
        "Distinguish the bundle currently in use from the latest verified bundle and latest upstream candidate, including scoped quarantines.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      resultContent(
        await getDataUpdateStatus(options.dataBundleProvider),
      ),
  );

  server.registerTool(
    "refresh_data_now",
    {
      title: "Refresh signed roster data",
      description:
        "Check the signed stable channel now, verify and classify a candidate, and atomically activate only safe scopes for future requests.",
      inputSchema: {
        force: z.boolean().default(true),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ force }) =>
      resultContent(
        await refreshDataNow(
          { force },
          options.dataBundleProvider,
        ),
      ),
  );

  server.registerTool(
    "rollback_data_bundle",
    {
      title: "Roll back roster data",
      description:
        "Atomically select an archived, verified bundle for future requests. Existing roster builds and durable jobs retain their leased bundle.",
      inputSchema: {
        bundleId: z.string().regex(/^[a-f0-9]{64}$/),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ bundleId }) =>
      resultContent(
        await rollbackDataBundle(
          bundleId,
          options.dataBundleProvider,
        ),
      ),
  );

  server.registerTool(
    "list_data_conflicts",
    {
      title: "List roster data conflicts",
      description:
        "List explicit unit, points, equipment, detachment, enhancement, or catalogue disagreements in the active leased bundle between official-first roster rules and the New Recruit interoperability source.",
      inputSchema: {
        factionId: z.string().optional(),
        entityType: z
          .enum([
            "catalogue",
            "unit",
            "points",
            "equipment",
            "detachment",
            "enhancement",
          ])
          .optional(),
        blocking: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().nonnegative().default(0),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => resultContent({
      ok: true,
      data: listDataConflicts(input),
      violations: [],
      warnings: [],
    }),
  );

  server.registerTool(
    "get_new_recruit_capability",
    {
      title: "Get New Recruit export coverage",
      description:
        "Report current catalogue, unit, loadout, detachment, and conflict coverage for one faction.",
      inputSchema: {
        factionId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ factionId }) => resultContent({
      ok: true,
      data: getNewRecruitCapability(factionId),
      violations: [],
      warnings: [],
    }),
  );

  server.registerTool(
    "search_factions",
    {
      title: "Search factions",
      description:
        "Search all embedded 11th-edition factions and report deterministic build support.",
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
        "Build any supported faction roster from natural language and/or structured constraints. Points and legality are calculated by the engine, never by the model.",
      inputSchema: {
        prompt: z.string().optional(),
        playerFaction: z.string().optional(),
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
        requiredUnitIds: z.array(z.string()).optional(),
        excludedUnitIds: z.array(z.string()).optional(),
        requiredWarlordUnitId: z.string().optional(),
        opponentFaction: z.string().optional(),
        detachmentId: z.string().optional(),
        forceDispositionId: z.string().optional(),
      },
    },
    async (input) => {
      const result = buildRoster({
          ...input,
          preferences: input.preferences as PreferenceTag[] | undefined,
          opponentContext: input.opponentFaction
            ? {
                kind: "known-faction",
                factionId: input.opponentFaction,
              }
            : undefined,
      });
      return resultContent(result);
    },
  );

  server.registerTool(
    "modify_roster",
    {
      title: "Modify a roster",
      description:
        "Apply one explicit add, remove, replace, model-count, warlord, equipment, enhancement, detachment, or disposition operation and revalidate.",
      inputSchema: {
        roster: RosterDraftSchema,
        operation: ModifyRosterOperationSchema,
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
    "modify_roster_batch",
    {
      title: "Modify a roster atomically",
      description:
        "Apply an ordered batch of roster operations to one working draft, then validate only the final roster. Structurally invalid operations still fail closed.",
      inputSchema: {
        roster: RosterDraftSchema,
        operations: z.array(ModifyRosterOperationSchema).min(1).max(32),
      },
    },
    async ({ roster, operations }) =>
      resultContent(
        modifyRosterBatch(
          roster as RosterDraftV1,
          operations as ModifyRosterOperation[],
        ),
      ),
  );

  server.registerTool(
    "validate_roster",
    {
      title: "Validate a roster",
      description:
        "Recalculate points and run loadout and army-construction legality checks under one immutable active-bundle lease.",
      inputSchema: { roster: RosterDraftSchema },
    },
    async ({ roster }) => resultContent(validateRoster(roster as RosterDraftV1)),
  );

  server.registerTool(
    "rebase_roster",
    {
      title: "Check or rebase roster data",
      description:
        "Compare a V1, V2, or V3 roster with the active semantic bundle. Provenance-only changes rebase automatically; relevant rule or mapping changes return exact review-required scopes without changing selections.",
      inputSchema: { roster: RosterDraftSchema },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ roster }) =>
      resultContent(
        await rebaseRosterWithProvider(
          roster,
          options.dataBundleProvider ?? null,
        ),
      ),
  );

  server.registerTool(
    "explain_roster",
    {
      title: "Explain a roster",
      description:
        "Explain how each selection supports the requested preferences and include every validation caution.",
      inputSchema: { roster: RosterDraftSchema },
    },
    async ({ roster }) => resultContent(explainRoster(roster as RosterDraftV1)),
  );

  server.registerTool(
    "export_roster",
    {
      title: "Export a roster",
      description:
        "Export a validated roster as New Recruit JSON, canonical roster JSON, text, or printable HTML. ROS/ROSZ is available when every selected New Recruit catalogue reference is mapped and conflict-free. Writing requires an explicit path and never overwrites by default.",
      inputSchema: {
        roster: RosterDraftSchema,
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
      const result = await exportRoster(
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
        roster: RosterDraftSchema,
        includeHtml: z.boolean().default(true),
        outputDirectory: z.string().optional(),
        overwrite: z.boolean().default(false),
      },
    },
    async ({ roster, includeHtml, outputDirectory, overwrite }) => {
      const result = await prepareNewRecruitHandoff(
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
          roster: RosterDraftSchema,
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
              downloadEnrichedRosz: true,
              downloadPrettyHtml,
              outputDirectory,
              overwrite,
            },
          ),
        ),
    );
  }

  if (options.tesseraCompanion) {
    server.registerTool(
      "get_tessera_connection_status",
      {
        title: "Get local Tessera connection status",
        description:
          "Check whether the experimental local Tessera browser adapter is available. Never reads premium keys, browser storage, or credentials.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => resultContent(await options.tesseraCompanion!.status()),
    );

    server.registerTool(
      "prepare_roster_for_tessera",
      {
        title: "Prepare a roster for Tessera",
        description:
          "After an explicit user request, import a validated roster into New Recruit, verify it, and download New Recruit's profile-rich .rosz for Tessera.",
        inputSchema: {
          roster: RosterDraftSchema,
          outputDirectory: z.string().default("exports/tessera"),
          overwrite: z.boolean().default(false),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ roster, outputDirectory, overwrite }) =>
        resultContent(
          await options.tesseraCompanion!.prepare(
            roster as RosterDraftV1,
            { outputDirectory, overwrite },
          ),
        ),
    );

    const tesseraPhaseSchema = z.enum(["shooting", "fight"]);
    const tesseraMetricSchema = z.enum([
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ]);
    server.registerTool(
      "analyze_roster_matchup",
      {
        title: "Prepare or analyze a roster matchup",
        description:
          "Prepare New Recruit-enriched player and opponent rosters and optionally run Tessera's experimental Army vs Army UI. Results are directional combat math, not game win probability.",
        inputSchema: {
          playerRoster: RosterDraftSchema,
          opponent: z
            .union([
              z.object({
                kind: z.literal("roster"),
                roster: RosterDraftSchema,
              }),
              z.object({
                kind: z.literal("rosz"),
                path: z.string().min(1),
                rosterContext: RosterDraftSchema.optional(),
              }),
            ])
            .optional(),
          outputDirectory: z.string().default("exports/tessera"),
          overwrite: z.boolean().default(false),
          executionMode: z
            .enum(["prepare-only", "simulate"])
            .optional(),
          fallbackMode: z
            .enum(["none", "baseline-damage-v1"])
            .default("none"),
          profilePolicyPath: z.string().min(1).optional(),
          experimental: z.boolean().default(false),
          analysisMode: z.enum(["quick", "full"]).default("full"),
          phases: z.array(tesseraPhaseSchema).min(1).max(2).optional(),
          metrics: z.array(tesseraMetricSchema).min(1).max(4).optional(),
          allowPointMismatch: z.boolean().default(false),
          includeChangeCandidates: z.boolean().default(true),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        playerRoster,
        opponent,
        outputDirectory,
        overwrite,
        executionMode,
        fallbackMode,
        profilePolicyPath,
        experimental,
        analysisMode,
        phases,
        metrics,
        allowPointMismatch,
        includeChangeCandidates,
      }) => {
        if (!opponent) {
          return resultContent(opponentScopeRequired());
        }
        const normalizedPlayer = playerRoster as RosterDraftV1;
        const normalizedOpponent = opponent as
          | { kind: "roster"; roster: RosterDraftV1 }
          | {
              kind: "rosz";
              path: string;
              rosterContext?: RosterDraftV1;
            };
        const opponentRosterContext =
          normalizedOpponent.kind === "rosz"
            ? normalizedOpponent.rosterContext
            : undefined;
        const executionOpponent =
          normalizedOpponent.kind === "rosz"
            ? {
                kind: "rosz" as const,
                path: normalizedOpponent.path,
              }
            : normalizedOpponent;
        if (
          options.tesseraRunJobs &&
          shouldStartDurableTesseraRun(
            executionMode,
            experimental,
          )
        ) {
          const job = await options.tesseraRunJobs.start(
            {
              kind: "exact",
              playerRoster: normalizedPlayer,
              opponent: executionOpponent,
              options: {
                outputDirectory,
                overwrite,
                executionMode: "simulate",
                fallbackMode,
                profilePolicyPath,
                experimental: false,
                analysisMode,
                phases,
                metrics,
                allowPointMismatch,
                includeChangeCandidates,
                opponentRosterContext,
              },
            },
            { outputDirectory },
          );
          return inProgressJobContent(job);
        }
        return resultContent(
          await options.tesseraCompanion!.analyze(
            normalizedPlayer,
            executionOpponent,
            {
              outputDirectory,
              overwrite,
              executionMode,
              fallbackMode,
              profilePolicyPath,
              experimental,
              analysisMode,
              phases,
              metrics,
              allowPointMismatch,
              includeChangeCandidates,
              ...(opponentRosterContext
                ? { opponentRosterContext }
                : {}),
            },
          ),
        );
      },
    );

    if (options.tesseraCompanion.buildAndAnalyze) {
      server.registerTool(
        "build_and_analyze_roster_matchup",
        {
          title: "Build and analyze against an exact roster",
          description:
            "Build and deterministically repair a player roster against the supplied validated opponent roster, enforce readiness, then run the exact Tessera workflow. It never applies suggested changes.",
          inputSchema: {
            prompt: z.string().min(1),
            playerFaction: z.string().min(1).optional(),
            pointsLimit: z.number().int().min(100).max(5000).optional(),
            opponentRoster: RosterDraftSchema,
            collectionProfile: CollectionProfileSchema.optional(),
            requiredUnitIds: z.array(z.string().min(1)).optional(),
            excludedUnitIds: z.array(z.string().min(1)).optional(),
            requiredWarlordUnitId: z.string().min(1).optional(),
            allowReadinessWarnings: z.boolean().default(false),
            profilePolicyPath: z.string().min(1).optional(),
            outputDirectory: z.string().min(1).optional(),
            executionMode: z
              .enum(["prepare-only", "simulate"])
              .optional(),
            responseDetail: z
              .enum(["compact", "full"])
              .default("compact"),
            overwrite: z.boolean().default(false),
            experimental: z.boolean().default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          prompt,
          playerFaction,
          pointsLimit,
          opponentRoster,
          collectionProfile,
          requiredUnitIds,
          excludedUnitIds,
          requiredWarlordUnitId,
          allowReadinessWarnings,
          profilePolicyPath,
          outputDirectory,
          executionMode,
          responseDetail,
          overwrite,
          experimental,
        }) => {
          if (
            options.tesseraRunJobs &&
            shouldStartDurableTesseraRun(
              executionMode,
              experimental,
            )
          ) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "build-and-analyze",
                input: {
                  prompt,
                  playerFaction,
                  pointsLimit,
                  opponentRoster:
                    opponentRoster as RosterDraftV1,
                  collectionProfile,
                  requiredUnitIds,
                  excludedUnitIds,
                  requiredWarlordUnitId,
                  allowReadinessWarnings,
                  profilePolicyPath,
                  outputDirectory,
                  executionMode: "simulate",
                  experimental: false,
                },
                options: {
                  outputDirectory,
                  overwrite,
                  executionMode: "simulate",
                  experimental: false,
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          const result =
            await options.tesseraCompanion!.buildAndAnalyze!(
              {
                prompt,
                playerFaction,
                pointsLimit,
                opponentRoster: opponentRoster as RosterDraftV1,
                collectionProfile,
                requiredUnitIds,
                excludedUnitIds,
                requiredWarlordUnitId,
                allowReadinessWarnings,
                profilePolicyPath,
                outputDirectory,
                executionMode,
                experimental,
              },
              { outputDirectory, overwrite },
            );
          return detailedResultContent(
            result,
            responseDetail,
            compactBuildAndAnalyzeResult,
          );
        },
      );
    }

    if (options.tesseraCompanion.compare) {
      server.registerTool(
        "compare_roster_revision",
        {
          title: "Compare an approved roster revision",
          description:
            "After explicit user approval, validate a revised roster, reuse the baseline opponent and Tessera settings, and produce a directional before-and-after comparison. This is not a game win probability.",
          inputSchema: {
            baselineReportPath: z.string().min(1),
            revisedRoster: RosterDraftSchema,
            outputDirectory: z.string().default("exports/tessera"),
            overwrite: z.boolean().default(false),
            profilePolicyPath: z.string().min(1).optional(),
            executionMode: z
              .enum(["simulate"])
              .optional(),
            experimental: z.boolean().default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          baselineReportPath,
          revisedRoster,
          outputDirectory,
          overwrite,
          profilePolicyPath,
          executionMode,
          experimental,
        }) => {
          if (options.tesseraRunJobs) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "exact-revision",
                baselineReportPath,
                revisedRoster:
                  revisedRoster as RosterDraftV1,
                options: {
                  outputDirectory,
                  profilePolicyPath,
                  executionMode: "simulate",
                  experimental: false,
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          return resultContent(
            await options.tesseraCompanion!.compare!(
              baselineReportPath,
              revisedRoster as RosterDraftV1,
              {
                outputDirectory,
                overwrite,
                ...(profilePolicyPath
                  ? { profilePolicyPath }
                  : {}),
                ...(executionMode
                  ? { executionMode }
                  : {}),
                experimental,
              },
            ),
          );
        },
      );
    }

    if (options.tesseraCompanion.previewPortfolio) {
      server.registerTool(
        "preview_faction_stress_portfolio",
        {
          title: "Preview a known-faction unknown-list portfolio",
          description:
            "Build and validate a local-only opponent portfolio preview with simulation fingerprints, pairwise diversity, composition evidence, profile requirements, named-character coverage, and New Recruit exportability. This performs no external mutation.",
          inputSchema: {
            factionId: z.string().min(1),
            pointsLimit: z.number().int().min(100).max(5000).default(1000),
            suite: z.enum(["core-3", "diverse-9"]).optional(),
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ factionId, pointsLimit, suite }) =>
          resultContent(
            await options.tesseraCompanion!.previewPortfolio!({
              faction: factionId,
              pointsLimit,
              suite,
              pointsTolerancePercent: 5,
              allowLegends: false,
            }),
          ),
      );
    }

    if (options.tesseraCompanion.buildAndStress) {
      server.registerTool(
        "build_and_stress_roster_against_faction",
        {
          title: "Build and stress-test against a known faction's unknown list",
          description:
            "Build and deterministically repair a roster, enforce mission-readiness and portfolio gates, prepare verified artifacts, then run the staged Tessera stress workflow. It never applies post-simulation roster changes.",
          inputSchema: {
            prompt: z.string().min(1),
            playerFaction: z.string().min(1).optional(),
            againstFaction: z.string().min(1),
            pointsLimit: z.number().int().min(100).max(5000).optional(),
            requiredUnitIds: z.array(z.string().min(1)).optional(),
            excludedUnitIds: z.array(z.string().min(1)).optional(),
            requiredWarlordUnitId: z.string().min(1).optional(),
            suite: z.enum(["core-3", "diverse-9"]).optional(),
            analysisStrategy: z
              .enum(["staged", "full-all"])
              .optional(),
            profilePolicyPath: z.string().min(1).optional(),
            resumeManifestPath: z.string().min(1).optional(),
            restartManifestPath: z.string().min(1).optional(),
            outputDirectory: z.string().min(1).optional(),
            responseDetail: z
              .enum(["compact", "full"])
              .default("compact"),
            allowReadinessWarnings: z.boolean().default(false),
            forceRetry: z.boolean().default(false),
            executionMode: z
              .enum(["prepare-only", "simulate"])
              .optional(),
            overwrite: z.boolean().default(false),
            experimental: z.boolean().default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          prompt,
          playerFaction,
          againstFaction,
          pointsLimit,
          requiredUnitIds,
          excludedUnitIds,
          requiredWarlordUnitId,
          suite,
          analysisStrategy,
          profilePolicyPath,
          resumeManifestPath,
          restartManifestPath,
          outputDirectory,
          responseDetail,
          allowReadinessWarnings,
          forceRetry,
          executionMode,
          overwrite,
          experimental,
        }) => {
          if (
            options.tesseraRunJobs &&
            shouldStartDurableTesseraRun(
              executionMode,
              experimental,
              Boolean(
                resumeManifestPath ||
                restartManifestPath,
              ),
            )
          ) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "build-and-stress",
                input: {
                  prompt,
                  playerFaction,
                  againstFaction,
                  pointsLimit,
                  requiredUnitIds,
                  excludedUnitIds,
                  requiredWarlordUnitId,
                  suite,
                  analysisStrategy,
                  profilePolicyPath,
                  resumeManifestPath,
                  restartManifestPath,
                  outputDirectory,
                  allowReadinessWarnings,
                  forceRetry,
                  executionMode: "simulate",
                  experimental: false,
                },
                options: {
                  outputDirectory,
                  overwrite,
                  executionMode: "simulate",
                  experimental: false,
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          const result =
            await options.tesseraCompanion!.buildAndStress!(
              {
                prompt,
                playerFaction,
                againstFaction,
                pointsLimit,
                requiredUnitIds,
                excludedUnitIds,
                requiredWarlordUnitId,
                suite,
                analysisStrategy,
                profilePolicyPath,
                resumeManifestPath,
                restartManifestPath,
                outputDirectory,
                allowReadinessWarnings,
                forceRetry,
                executionMode,
                experimental,
              },
              { outputDirectory, overwrite },
            );
          return detailedResultContent(
            result,
            responseDetail,
            (value) =>
              compactBuildAndStressResult(
                value,
                outputDirectory,
              ),
          );
        },
      );
    }

    if (options.tesseraCompanion.stressTest) {
      server.registerTool(
        "stress_test_roster_against_faction",
        {
          title: "Stress-test a roster against an opponent faction",
          description:
            "After an explicit user request, generate a deterministic faction portfolio, prepare it through New Recruit, and measure the roster's directional combat robustness in Tessera. This is not a game win probability.",
          inputSchema: {
            playerRoster: RosterDraftSchema,
            factionId: z.string().min(1),
            suite: z.enum(["core-3", "diverse-9"]).optional(),
            analysisStrategy: z
              .enum(["staged", "full-all"])
              .optional(),
            resumeManifestPath: z.string().min(1).optional(),
            restartManifestPath: z.string().min(1).optional(),
            profilePolicyPath: z.string().min(1).optional(),
            forceRetry: z.boolean().default(false),
            executionMode: z
              .enum(["prepare-only", "simulate"])
              .optional(),
            outputDirectory: z.string().min(1).optional(),
            responseDetail: z
              .enum(["compact", "full"])
              .default("compact"),
            overwrite: z.boolean().default(false),
            experimental: z.boolean().default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          playerRoster,
          factionId,
          suite,
          analysisStrategy,
          resumeManifestPath,
          restartManifestPath,
          profilePolicyPath,
          forceRetry,
          executionMode,
          outputDirectory,
          responseDetail,
          overwrite,
          experimental,
        }) => {
          if (
            options.tesseraRunJobs &&
            shouldStartDurableTesseraRun(
              executionMode,
              experimental,
              Boolean(
                resumeManifestPath ||
                restartManifestPath,
              ),
            )
          ) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "stress",
                playerRoster:
                  playerRoster as RosterDraftV1,
                factionId,
                options: {
                  suite,
                  analysisStrategy,
                  resumeManifestPath,
                  restartManifestPath,
                  profilePolicyPath,
                  forceRetry,
                  executionMode: "simulate",
                  outputDirectory,
                  overwrite,
                  experimental: false,
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          const result =
            await options.tesseraCompanion!.stressTest!(
              playerRoster as RosterDraftV1,
              { kind: "faction", factionId },
              {
                suite,
                analysisStrategy,
                resumeManifestPath,
                restartManifestPath,
                profilePolicyPath,
                forceRetry,
                executionMode,
                outputDirectory,
                overwrite,
                experimental,
              },
            );
          return detailedResultContent(
            result,
            responseDetail,
            (value) =>
              compactStressResult(value, outputDirectory),
          );
        },
      );
    }

    if (options.tesseraCompanion.compareStressRevision) {
      server.registerTool(
        "compare_stress_test_revision",
        {
          title: "Compare a roster revision against a stress-test portfolio",
          description:
            "After explicit user approval, validate a revised roster and compare it against the exact frozen opponents and settings from a baseline faction stress test. This is not a game win probability.",
          inputSchema: {
            baselineReportPath: z.string().min(1),
            revisedRoster: RosterDraftSchema,
            outputDirectory: z.string().min(1).optional(),
            responseDetail: z
              .enum(["compact", "full"])
              .default("compact"),
            overwrite: z.boolean().default(false),
            executionMode: z
              .enum(["simulate"])
              .optional(),
            experimental: z.boolean().default(false),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({
          baselineReportPath,
          revisedRoster,
          outputDirectory,
          responseDetail,
          overwrite,
          executionMode,
          experimental,
        }) => {
          if (options.tesseraRunJobs) {
            const job = await options.tesseraRunJobs.start(
              {
                kind: "stress-revision",
                baselineReportPath,
                revisedRoster:
                  revisedRoster as RosterDraftV1,
                options: {
                  outputDirectory,
                  executionMode: "simulate",
                  experimental: false,
                },
              },
              { outputDirectory },
            );
            return inProgressJobContent(job);
          }
          const result =
            await options.tesseraCompanion!.compareStressRevision!(
              baselineReportPath,
              revisedRoster as RosterDraftV1,
              {
                outputDirectory,
                overwrite,
                ...(executionMode
                  ? { executionMode }
                  : {}),
                experimental,
              },
            );
          return detailedResultContent(
            result,
            responseDetail,
            (value) =>
              compactStressRevisionResult(
                value,
                outputDirectory,
              ),
          );
        },
      );
    }
  }

  if (options.tesseraRunJobs) {
    const jobProfilePolicySchema = z.object({
      schemaVersion: z.literal(1),
      policyKind: z.literal("tessera-profile-policy"),
      entries: z.array(
        z.object({
          faction: z.string().min(1),
          unit: z.string().min(1),
          unitOccurrence: z.number().int().positive().optional(),
          modelCount: z.number().int().positive().optional(),
          weaponGroup: z.string().min(1),
          phase: z.enum(["shooting", "fight"]),
          selectedProfile: z.string().min(1),
          activeCount: z.number().int().positive(),
        }),
      ),
    });
    const jobExecutionModeSchema = z
      .enum(["prepare-only", "simulate"])
      .optional();
    const jobRequestSchema = z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("exact"),
        playerRoster: RosterDraftSchema,
        opponent: z
          .union([
            z.object({
              kind: z.literal("roster"),
              roster: RosterDraftSchema,
            }),
            z.object({
              kind: z.literal("rosz"),
              path: z.string().min(1),
              rosterContext: RosterDraftSchema.optional(),
            }),
          ])
          .optional(),
        executionMode: jobExecutionModeSchema,
        profilePolicyPath: z.string().min(1).optional(),
        analysisMode: z.enum(["quick", "full"]).default("full"),
        allowPointMismatch: z.boolean().default(false),
      }),
      z.object({
        kind: z.literal("stress"),
        playerRoster: RosterDraftSchema,
        factionId: z.string().min(1),
        suite: z.enum(["core-3", "diverse-9"]).optional(),
        analysisStrategy: z
          .enum(["staged", "full-all"])
          .optional(),
        portfolioPreview: z.unknown().optional(),
        executionMode: jobExecutionModeSchema,
        profilePolicyPath: z.string().min(1).optional(),
        resumeManifestPath: z.string().min(1).optional(),
        restartManifestPath: z.string().min(1).optional(),
      }),
      z.object({
        kind: z.literal("build-and-stress"),
        prompt: z.string().min(1),
        playerFaction: z.string().min(1).optional(),
        againstFaction: z.string().min(1),
        pointsLimit: z.number().int().min(100).max(5000).optional(),
        requiredUnitIds: z.array(z.string().min(1)).optional(),
        excludedUnitIds: z.array(z.string().min(1)).optional(),
        requiredWarlordUnitId: z.string().min(1).optional(),
        suite: z.enum(["core-3", "diverse-9"]).optional(),
        analysisStrategy: z
          .enum(["staged", "full-all"])
          .optional(),
        executionMode: jobExecutionModeSchema,
        profilePolicyPath: z.string().min(1).optional(),
        allowReadinessWarnings: z.boolean().default(false),
        resumeManifestPath: z.string().min(1).optional(),
        restartManifestPath: z.string().min(1).optional(),
      }),
      z.object({
        kind: z.literal("build-and-analyze"),
        prompt: z.string().min(1),
        playerFaction: z.string().min(1).optional(),
        pointsLimit: z.number().int().min(100).max(5000).optional(),
        opponentRoster: RosterDraftSchema,
        collectionProfile: CollectionProfileSchema.optional(),
        requiredUnitIds: z.array(z.string().min(1)).optional(),
        excludedUnitIds: z.array(z.string().min(1)).optional(),
        requiredWarlordUnitId: z.string().min(1).optional(),
        executionMode: jobExecutionModeSchema,
        profilePolicyPath: z.string().min(1).optional(),
        allowReadinessWarnings: z.boolean().default(false),
      }),
      z.object({
        kind: z.literal("exact-revision"),
        baselineReportPath: z.string().min(1),
        revisedRoster: RosterDraftSchema,
        profilePolicyPath: z.string().min(1).optional(),
      }),
      z.object({
        kind: z.literal("stress-revision"),
        baselineReportPath: z.string().min(1),
        revisedRoster: RosterDraftSchema,
      }),
    ]);

    server.registerTool(
      "start_tessera_run",
      {
        title: "Start a durable Tessera run",
        description:
          "Reserve a run bundle and start exact, stress, or build-and-analyze work in a background worker. Returns immediately with a durable job path.",
        inputSchema: {
          request: jobRequestSchema,
          outputDirectory: z.string().min(1).optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ request, outputDirectory }) => {
        let normalized: TesseraRunRequest;
        if (request.kind === "exact") {
          if (!request.opponent) {
            return resultContent(opponentScopeRequired());
          }
          normalized = {
            kind: "exact",
            playerRoster: request.playerRoster as RosterDraftV1,
            opponent:
              request.opponent.kind === "roster"
                ? {
                    kind: "roster",
                    roster:
                      request.opponent.roster as RosterDraftV1,
                  }
                : request.opponent,
            options: {
              executionMode: request.executionMode,
              profilePolicyPath: request.profilePolicyPath,
              analysisMode: request.analysisMode,
              allowPointMismatch: request.allowPointMismatch,
              opponentRosterContext:
                request.opponent.kind === "rosz"
                  ? (
                      request.opponent
                        .rosterContext as RosterDraftV1 | undefined
                    )
                  : undefined,
            },
          };
        } else if (request.kind === "stress") {
          normalized = {
            kind: "stress",
            playerRoster: request.playerRoster as RosterDraftV1,
            factionId: request.factionId,
            options: {
              suite: request.suite,
              analysisStrategy: request.analysisStrategy,
              portfolioPreview:
                request.portfolioPreview as
                  | TesseraStressPortfolioPreview
                  | undefined,
              executionMode: request.executionMode,
              profilePolicyPath: request.profilePolicyPath,
              resumeManifestPath: request.resumeManifestPath,
              restartManifestPath:
                request.restartManifestPath,
            },
          };
        } else if (request.kind === "build-and-stress") {
          normalized = {
            kind: "build-and-stress",
            input: {
              prompt: request.prompt,
              playerFaction: request.playerFaction,
              againstFaction: request.againstFaction,
              pointsLimit: request.pointsLimit,
              requiredUnitIds: request.requiredUnitIds,
              excludedUnitIds: request.excludedUnitIds,
              requiredWarlordUnitId:
                request.requiredWarlordUnitId,
              suite: request.suite,
              analysisStrategy: request.analysisStrategy,
              executionMode: request.executionMode,
              profilePolicyPath: request.profilePolicyPath,
              allowReadinessWarnings:
                request.allowReadinessWarnings,
              resumeManifestPath: request.resumeManifestPath,
              restartManifestPath:
                request.restartManifestPath,
            },
          };
        } else if (request.kind === "build-and-analyze") {
          normalized = {
            kind: "build-and-analyze",
            input: {
              prompt: request.prompt,
              playerFaction: request.playerFaction,
              pointsLimit: request.pointsLimit,
              opponentRoster:
                request.opponentRoster as RosterDraftV1,
              collectionProfile: request.collectionProfile,
              requiredUnitIds: request.requiredUnitIds,
              excludedUnitIds: request.excludedUnitIds,
              requiredWarlordUnitId:
                request.requiredWarlordUnitId,
              executionMode: request.executionMode,
              profilePolicyPath: request.profilePolicyPath,
              allowReadinessWarnings:
                request.allowReadinessWarnings,
            },
          };
        } else if (request.kind === "exact-revision") {
          normalized = {
            kind: "exact-revision",
            baselineReportPath: request.baselineReportPath,
            revisedRoster:
              request.revisedRoster as RosterDraftV1,
            options: {
              executionMode: "simulate",
              experimental: false,
              profilePolicyPath: request.profilePolicyPath,
            },
          };
        } else {
          normalized = {
            kind: "stress-revision",
            baselineReportPath: request.baselineReportPath,
            revisedRoster:
              request.revisedRoster as RosterDraftV1,
            options: {
              executionMode: "simulate",
              experimental: false,
            },
          };
        }
        return valueContent(
          await options.tesseraRunJobs!.start(normalized, {
            outputDirectory,
          }),
        );
      },
    );

    server.registerTool(
      "get_tessera_run_status",
      {
        title: "Get Tessera run status",
        description:
          "Read a durable background Tessera job without changing it.",
        inputSchema: {
          jobPath: z.string().min(1),
          includeResult: z.boolean().default(false),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ jobPath, includeResult }) =>
        valueContent(
          await options.tesseraRunJobs!.status(
            jobPath,
            includeResult,
          ),
        ),
    );

    server.registerTool(
      "resume_tessera_run",
      {
        title: "Resume a Tessera run",
        description:
          "Resume a stopped durable run using its frozen request, manifest, artifacts, and profile policy.",
        inputSchema: {
          jobPath: z.string().min(1),
          restartFrom: z.boolean().default(false),
          outputDirectory: z.string().min(1).optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ jobPath, restartFrom, outputDirectory }) =>
        valueContent(
          await options.tesseraRunJobs!.resume(jobPath, {
            restartFrom,
            outputDirectory,
          }),
        ),
    );

    server.registerTool(
      "resolve_tessera_profiles",
      {
        title: "Resolve Tessera profile choices",
        description:
          "Freeze explicit structured weapon-profile choices into a stopped durable run before resuming it.",
        inputSchema: {
          jobPath: z.string().min(1),
          policy: jobProfilePolicySchema,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ jobPath, policy }) =>
        valueContent(
          await options.tesseraRunJobs!.resolveProfiles(
            jobPath,
            policy,
          ),
        ),
    );

    server.registerTool(
      "cancel_tessera_run",
      {
        title: "Cancel a Tessera run",
        description:
          "Stop the local worker while retaining manifests, prepared artifacts, and the New Recruit inventory. It never deletes remote lists.",
        inputSchema: {
          jobPath: z.string().min(1),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ jobPath }) =>
        valueContent(
          await options.tesseraRunJobs!.cancel(jobPath),
        ),
    );
  }

  return server;
}
