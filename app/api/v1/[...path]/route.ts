import {
  buildRoster,
  bytesToBase64,
  checkDataFreshnessCached,
  compareFactions,
  explainRoster,
  exportRoster,
  getNewRecruitCapability,
  getDataStatus,
  getDataUpdateStatus,
  listDataConflicts,
  modifyRoster,
  prepareNewRecruitHandoff,
  rebaseRosterWithProvider,
  refreshDataNow,
  rollbackDataBundle,
  searchFactions,
  searchUnits,
  validateRoster,
  withDataBundleSnapshotLease,
  type BuildRosterInput,
  type ExportFormat,
  type ModifyRosterOperation,
  type RosterDraftV1,
} from "@/lib/rosterpilot";
import {
  authorizeRemoteRequest,
  errorEnvelope,
  remoteOptions,
  withRemoteCors,
} from "@/lib/rosterpilot/remote";
import {
  initializeHostedDataForRequest,
} from "@/app/hosted-data-bundles";

function routePath(request: Request): string {
  return new URL(request.url).pathname.replace(/^\/api\/v1\/?/, "").replace(/\/$/, "");
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

function inlineExportArtifact(artifact: {
  format: ExportFormat;
  filename: string;
  mimeType: string;
  encoding: "utf8" | "binary";
  content: string | Uint8Array;
}) {
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

function guarded(
  request: Request,
  handler: () => Promise<Response> | Response,
  options: { lease?: boolean } = {},
) {
  const denied = authorizeRemoteRequest(request);
  if (denied) return withRemoteCors(denied, request);
  const response = initializeHostedDataForRequest(request).then(
    () =>
      options.lease === false
        ? Promise.resolve().then(handler)
        : withDataBundleSnapshotLease(handler),
  );
  return response
    .then((response) => withRemoteCors(response, request))
    .catch((error) =>
      withRemoteCors(
        json(
          errorEnvelope(
            "REQUEST_FAILED",
            error instanceof Error ? error.message : "Request failed.",
          ),
          400,
        ),
        request,
      ),
    );
}

export function OPTIONS(request: Request) {
  return remoteOptions(request);
}

export function GET(request: Request) {
  const path = routePath(request);
  return guarded(request, async () => {
    const url = new URL(request.url);
    if (path === "data-status") return json(getDataStatus());
    if (path === "data-update-status") {
      return json(await getDataUpdateStatus());
    }
    if (path === "data-freshness") {
      return json(
        await checkDataFreshnessCached({
          force: url.searchParams.get("force") === "true",
        }),
      );
    }
    if (path === "data-conflicts") {
      const entityType = url.searchParams.get("entityType");
      return json({
        ok: true,
        data: listDataConflicts({
          factionId: url.searchParams.get("factionId") ?? undefined,
          entityType:
            entityType === "catalogue" ||
            entityType === "unit" ||
            entityType === "points" ||
            entityType === "equipment" ||
            entityType === "detachment" ||
            entityType === "enhancement"
              ? entityType
              : undefined,
          blocking:
            url.searchParams.has("blocking")
              ? url.searchParams.get("blocking") === "true"
              : undefined,
          limit: Number(url.searchParams.get("limit") ?? 50),
          offset: Number(url.searchParams.get("offset") ?? 0),
        }),
        violations: [],
        warnings: [],
      });
    }
    if (path === "new-recruit-capability") {
      const factionId = url.searchParams.get("factionId");
      if (!factionId) {
        return json(
          errorEnvelope(
            "FACTION_REQUIRED",
            "The factionId query parameter is required.",
          ),
          400,
        );
      }
      return json({
        ok: true,
        data: getNewRecruitCapability(factionId),
        violations: [],
        warnings: [],
      });
    }
    if (path === "factions") {
      return json(
        searchFactions(
          url.searchParams.get("query") ?? "",
          Number(url.searchParams.get("limit") ?? 20),
        ),
      );
    }
    if (path === "units") {
      return json(
        searchUnits({
          faction: url.searchParams.get("faction") ?? "adeptus-custodes",
          query: url.searchParams.get("query") ?? "",
          tags: (url.searchParams.get("tags") ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean) as Parameters<typeof searchUnits>[0]["tags"],
          includeLegends: url.searchParams.get("includeLegends") === "true",
          limit: Number(url.searchParams.get("limit") ?? 30),
        }),
      );
    }
    if (path === "factions/compare") {
      return json(
        compareFactions(
          url.searchParams
            .getAll("faction")
            .flatMap((value) => value.split(","))
            .filter(Boolean),
        ),
      );
    }
    return json(errorEnvelope("NOT_FOUND", `Unknown API route "${path}".`), 404);
  }, {
    lease: path !== "data-update-status",
  });
}

export function POST(request: Request) {
  const path = routePath(request);
  return guarded(request, async () => {
    const content = await request.text();
    const body = (
      content.length > 0 ? JSON.parse(content) : {}
    ) as Record<string, unknown>;
    if (path === "data-refresh") {
      return json(
        await refreshDataNow({
          force:
            typeof body.force === "boolean" ? body.force : true,
        }),
      );
    }
    if (path === "data-rollback") {
      return json(
        await rollbackDataBundle(
          typeof body.bundleId === "string" ? body.bundleId : "",
        ),
      );
    }
    if (path === "rosters/rebase") {
      return json(await rebaseRosterWithProvider(body.roster));
    }
    if (path === "rosters/build") {
      return json(buildRoster(body as BuildRosterInput));
    }
    if (path === "rosters/modify") {
      return json(
        modifyRoster(
          body.roster as RosterDraftV1,
          body.operation as ModifyRosterOperation,
        ),
      );
    }
    if (path === "rosters/validate") {
      return json(validateRoster(body.roster as RosterDraftV1));
    }
    if (path === "rosters/explain") {
      return json(explainRoster(body.roster as RosterDraftV1));
    }
    if (path === "rosters/export") {
      const result = await exportRoster(
        body.roster as RosterDraftV1,
        body.format as ExportFormat,
      );
      if (!result.data) return json(result, 422);
      return json({
        ...result,
        data: inlineExportArtifact(result.data),
      });
    }
    if (path === "rosters/new-recruit-handoff") {
      const result = await prepareNewRecruitHandoff(
        body.roster as RosterDraftV1,
        body.includeHtml !== false,
      );
      if (!result.data) return json(result, 422);
      return json({
        ...result,
        data: {
          ...result.data,
          artifacts: result.data.artifacts.map(inlineExportArtifact),
        },
      });
    }
    return json(errorEnvelope("NOT_FOUND", `Unknown API route "${path}".`), 404);
  }, {
    lease:
      path !== "data-refresh" &&
      path !== "data-rollback",
  });
}
