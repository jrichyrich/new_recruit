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

function guarded(request: Request, handler: () => Promise<Response> | Response) {
  const denied = authorizeRemoteRequest(request);
  if (denied) return withRemoteCors(denied, request);
  return Promise.resolve(handler())
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
  return guarded(request, () => {
    const url = new URL(request.url);
    const path = routePath(request);
    if (path === "data-status") return json(getDataStatus());
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
  });
}

export function POST(request: Request) {
  return guarded(request, async () => {
    const path = routePath(request);
    const body = (await request.json()) as Record<string, unknown>;
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
      const result = exportRoster(
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
      const result = prepareNewRecruitHandoff(
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
  });
}
