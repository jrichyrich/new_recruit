import {
  buildRoster,
  bytesToBase64,
  exportRoster,
  getDataStatus,
  getNewRecruitCapability,
  listDetachments,
  modifyRoster,
  parseRosterDraft,
  prepareNewRecruitHandoff,
  rebaseRosterData,
  searchFactions,
  searchUnits,
  validateRoster,
  withDataBundleSnapshotLease,
  type BuildRosterInput,
  type ExportArtifact,
  type ExportFormat,
  type ModifyRosterOperation,
  type ResultEnvelope,
  type RosterDraftV1,
} from "@/lib/rosterpilot";
import {
  initializeHostedDataForRequest,
} from "@/app/hosted-data-bundles";
import type {
  BrowserEngineBootstrap,
  BrowserEngineSearch,
  BrowserRosterWorkspace,
  SerializedBrowserArtifact,
} from "@/app/browser-engine-contract";

function issue(code: string, message: string) {
  return {
    code,
    message,
    severity: "error" as const,
  };
}

function failure<T>(code: string, message: string): ResultEnvelope<T> {
  return {
    ok: false,
    data: null,
    violations: [issue(code, message)],
    warnings: [],
  };
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const expectedOrigin = new URL(request.url).origin;

  // This route is the credential-free browser UI transport, not a public
  // machine-to-machine API. Modern browsers attach Sec-Fetch-Site even when a
  // safe-method request omits Origin. Requiring one of those browser signals
  // keeps headerless scripts on the authenticated /api/v1 surface instead.
  if (origin) {
    return (
      origin === expectedOrigin &&
      (fetchSite === null || fetchSite === "same-origin")
    );
  }
  return fetchSite === "same-origin";
}

function serializedArtifact(
  artifact: ExportArtifact,
): SerializedBrowserArtifact {
  return {
    format: artifact.format,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    encoding: artifact.encoding,
    content:
      typeof artifact.content === "string"
        ? artifact.content
        : bytesToBase64(artifact.content),
    transferEncoding:
      typeof artifact.content === "string" ? "utf8" : "base64",
  };
}

function workspace(
  roster: unknown,
): ResultEnvelope<BrowserRosterWorkspace> {
  const parsed = parseRosterDraft(roster);
  if (!parsed.success) {
    return failure(
      "ROSTER_SCHEMA_INVALID",
      parsed.error.message,
    );
  }
  const compatibility = rebaseRosterData(parsed.data);
  if (!compatibility.ok || !compatibility.data) {
    return {
      ok: false,
      data: null,
      violations: compatibility.violations,
      warnings: compatibility.warnings,
    };
  }
  const effectiveRoster =
    compatibility.data.status === "review-required"
      ? parsed.data
      : compatibility.data.roster;
  const validation = validateRoster(effectiveRoster);
  return {
    ok: validation.ok,
    data: {
      roster: effectiveRoster,
      dataCompatibility: {
        status: compatibility.data.status,
        fromBundleId: compatibility.data.fromBundleId,
        toBundleId: compatibility.data.toBundleId,
        provenanceChanged: compatibility.data.provenanceChanged,
        changedScopes: compatibility.data.changedScopes,
      },
      validation,
      detachments: listDetachments(effectiveRoster.factionId),
      newRecruitCapability: getNewRecruitCapability(
        effectiveRoster.factionId,
      ),
      modelCountsByUnitId: Object.fromEntries(
        effectiveRoster.units.map((selection) => {
          const summary = searchUnits({
            faction: effectiveRoster.factionId,
            query: selection.name,
            includeLegends: true,
            limit: 3,
          }).data?.find((unit) => unit.id === selection.unitId);
          return [
            selection.unitId,
            summary?.modelCounts ?? [selection.modelCount],
          ];
        }),
      ),
      migrated:
        parsed.migrated ||
        compatibility.data.status === "compatible-rebased",
    },
    violations: validation.violations,
    warnings: [
      ...compatibility.warnings,
      ...validation.warnings,
    ],
  };
}

async function guarded<T>(
  request: Request,
  operation: (
    initialization: Awaited<
      ReturnType<typeof initializeHostedDataForRequest>
    >,
  ) => T | Promise<T>,
): Promise<Response> {
  if (!sameOrigin(request)) {
    return Response.json(
      failure("ORIGIN_NOT_ALLOWED", "Browser engine requests must be same-origin."),
      { status: 403 },
    );
  }
  const initialization = await initializeHostedDataForRequest(request);
  try {
    return await withDataBundleSnapshotLease(async () =>
      Response.json(await operation(initialization)),
    );
  } catch (error) {
    return Response.json(
      failure(
        "BROWSER_ENGINE_REQUEST_FAILED",
        error instanceof Error ? error.message : "Browser engine request failed.",
      ),
      { status: 400 },
    );
  }
}

function searchPayload(url: URL): BrowserEngineSearch {
  const selectedFactionId =
    url.searchParams.get("selectedFaction") ?? "adeptus-custodes";
  const factions =
    searchFactions(url.searchParams.get("factionQuery") ?? "", 40)
      .data ?? [];
  const units =
    searchUnits({
      faction: selectedFactionId,
      query: url.searchParams.get("unitQuery") ?? "",
      includeLegends: false,
      limit: 12,
    }).data ?? [];
  const selectedFaction =
    searchFactions(selectedFactionId, 5).data?.find(
      (faction) => faction.id === selectedFactionId,
    ) ?? null;
  return { factions, units, selectedFaction };
}

export function GET(request: Request): Promise<Response> {
  return guarded(request, (initialization) => {
    const url = new URL(request.url);
    const search = searchPayload(url);
    if (url.searchParams.get("bootstrap") !== "true") {
      return {
        ok: true,
        data: search,
        violations: [],
        warnings: [],
      } satisfies ResultEnvelope<BrowserEngineSearch>;
    }
    const built = buildRoster({
      prompt:
        "Build a 1,000 point fast Custodes army with no named characters",
      name: "Golden Vanguard",
    });
    if (!built.data) return built;
    const currentWorkspace = workspace(built.data);
    if (!currentWorkspace.data) return currentWorkspace;
    const dataStatus = getDataStatus();
    if (!dataStatus.data) return dataStatus;
    return {
      ok: built.ok && currentWorkspace.ok && dataStatus.ok,
      data: {
        dataStatus: dataStatus.data,
        runtimeData: initialization,
        ...search,
        workspace: currentWorkspace.data,
      },
      violations: [
        ...built.violations,
        ...currentWorkspace.violations,
        ...dataStatus.violations,
      ],
      warnings: [
        ...built.warnings,
        ...currentWorkspace.warnings,
        ...dataStatus.warnings,
      ],
    } satisfies ResultEnvelope<BrowserEngineBootstrap>;
  });
}

export function POST(request: Request): Promise<Response> {
  return guarded(request, async () => {
    const text = await request.text();
    const body = (text ? JSON.parse(text) : {}) as Record<
      string,
      unknown
    >;
    if (body.action === "build") {
      const result = buildRoster(body.input as BuildRosterInput);
      if (!result.data) return result;
      return workspace(result.data);
    }
    if (body.action === "modify") {
      const result = modifyRoster(
        body.roster as RosterDraftV1,
        body.operation as ModifyRosterOperation,
      );
      if (!result.data) return result;
      return workspace(result.data);
    }
    if (body.action === "inspect") {
      return workspace(body.roster);
    }
    if (body.action === "export") {
      const result = await exportRoster(
        body.roster as RosterDraftV1,
        body.format as ExportFormat,
      );
      return {
        ...result,
        data: result.data ? serializedArtifact(result.data) : null,
      };
    }
    if (body.action === "handoff") {
      const result = await prepareNewRecruitHandoff(
        body.roster as RosterDraftV1,
      );
      return {
        ...result,
        data: result.data
          ? {
              ...result.data,
              artifacts: result.data.artifacts.map(serializedArtifact),
            }
          : null,
      };
    }
    return failure(
      "BROWSER_ENGINE_ACTION_INVALID",
      "Unknown browser engine action.",
    );
  });
}
