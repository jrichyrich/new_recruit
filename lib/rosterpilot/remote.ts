import type { ResultEnvelope } from "./types";

export function authorizeRemoteRequest(request: Request): Response | null {
  const configuredToken = process.env.ROSTERPILOT_API_TOKEN;
  if (!configuredToken) {
    return Response.json(
      {
        ok: false,
        data: null,
        violations: [
          {
            code: "REMOTE_API_DISABLED",
            message:
              "Set ROSTERPILOT_API_TOKEN in the hosted environment to enable remote agent access.",
            severity: "error",
          },
        ],
        warnings: [],
      },
      { status: 503 },
    );
  }
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${configuredToken}`) {
    return Response.json(
      {
        ok: false,
        data: null,
        violations: [
          {
            code: "UNAUTHORIZED",
            message: "A valid bearer token is required.",
            severity: "error",
          },
        ],
        warnings: [],
      },
      {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      },
    );
  }

  const origin = request.headers.get("origin");
  if (origin) {
    const requestOrigin = new URL(request.url).origin;
    const configured = (process.env.ROSTERPILOT_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const allowed = new Set([requestOrigin, ...configured]);
    if (!allowed.has(origin)) {
      return Response.json(
        {
          ok: false,
          data: null,
          violations: [
            {
              code: "ORIGIN_NOT_ALLOWED",
              message: `Origin ${origin} is not allowed.`,
              severity: "error",
            },
          ],
          warnings: [],
        },
        { status: 403 },
      );
    }
  }
  return null;
}

export function withRemoteCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, mcp-session-id, mcp-protocol-version, Last-Event-ID",
  );
  headers.set(
    "Access-Control-Expose-Headers",
    "mcp-session-id, mcp-protocol-version",
  );
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function remoteOptions(request: Request): Response {
  return withRemoteCors(new Response(null, { status: 204 }), request);
}

export function errorEnvelope(
  code: string,
  message: string,
): ResultEnvelope<null> {
  return {
    ok: false,
    data: null,
    violations: [{ code, message, severity: "error" }],
    warnings: [],
  };
}
