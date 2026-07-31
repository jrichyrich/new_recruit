import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html", ...(init.headers ?? {}) },
      ...init,
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the RosterPilot product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>RosterPilot — Agentic Army Builder<\/title>/i);
  assert.match(html, /Build the army you mean to play\./);
  assert.match(html, /Adeptus Custodes/);
  assert.match(html, /Powered by 40kdc-data/);
  assert.match(html, /New Recruit/);
  assert.match(html, /One roster, three independent paths/);
  assert.match(html, /Compare in Tessera/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
  assert.doesNotMatch(html, /codex-preview/);
});

test("publishes an authenticated OpenAPI surface without enabling secrets", async () => {
  const openapi = JSON.parse(
    await readFile(new URL("../public/openapi.json", import.meta.url), "utf8"),
  );
  assert.equal(openapi.openapi, "3.1.0");
  assert.ok(openapi.paths["/api/v1/rosters/build"]);
  assert.ok(openapi.paths["/api/v1/rosters/export"]);
  assert.ok(openapi.paths["/api/v1/rosters/new-recruit-handoff"]);
  assert.ok(openapi.paths["/api/v1/rosters/rebase"]);
  assert.ok(openapi.paths["/api/v1/factions/compare"]);
  assert.ok(openapi.paths["/api/v1/data-update-status"]);
  assert.ok(openapi.paths["/api/v1/data-refresh"]);
  assert.ok(openapi.paths["/api/v1/data-rollback"]);
  assert.equal(openapi.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.match(openapi.info.description, /snapshot leases/);
  assert.equal(
    openapi.components.schemas.RosterDraft.properties.schemaVersion.const,
    3,
  );
  assert.ok(
    openapi.components.schemas.RosterSourceDataV3.properties.rosterRulesHash,
  );
  assert.ok(
    openapi.components.schemas.BuildRosterRequest.properties.collectionProfile,
  );
  assert.ok(
    openapi.components.schemas.BuildRosterRequest.properties.opponentContext,
  );
  const parameterNames = (path, method = "get") =>
    openapi.paths[path][method].parameters.map((parameter) => parameter.name);
  assert.deepEqual(
    parameterNames("/api/v1/data-conflicts"),
    ["factionId", "entityType", "blocking", "limit", "offset"],
  );
  assert.deepEqual(
    parameterNames("/api/v1/factions"),
    ["query", "limit"],
  );
  assert.deepEqual(
    parameterNames("/api/v1/units"),
    ["faction", "query", "tags", "includeLegends", "limit"],
  );
  assert.equal(
    openapi.components.schemas.FactionSummary.properties.supported.type,
    "boolean",
  );
  assert.equal(
    openapi.components.schemas.UnitSummary.properties.supported.type,
    "boolean",
  );
  assert.deepEqual(
    openapi.components.schemas.RosterDraft.required,
    [
      "schemaVersion",
      "gameSystem",
      "id",
      "name",
      "factionId",
      "factionName",
      "pointsLimit",
      "totalPoints",
      "battleSize",
      "detachmentId",
      "detachmentName",
      "forceDispositionId",
      "forceDispositionName",
      "preferences",
      "constraints",
      "units",
      "createdAt",
      "updatedAt",
      "sourceData",
    ],
  );
  assert.deepEqual(
    openapi.components.schemas.ModifyRosterOperation.oneOf.map(
      (operation) => operation.properties.type.const,
    ),
    [
      "add",
      "remove",
      "replace",
      "set-model-count",
      "set-warlord",
      "set-equipment",
      "set-enhancement",
      "set-detachment",
      "set-disposition",
    ],
  );
  const rosterResponseRefs = new Map([
    ["/api/v1/rosters/build", "#/components/schemas/RosterDraftEnvelope"],
    ["/api/v1/rosters/modify", "#/components/schemas/RosterDraftEnvelope"],
    ["/api/v1/rosters/validate", "#/components/schemas/RosterValidationEnvelope"],
    ["/api/v1/rosters/explain", "#/components/schemas/RosterExplanationEnvelope"],
    ["/api/v1/rosters/export", "#/components/schemas/InlineExportArtifactEnvelope"],
    ["/api/v1/rosters/new-recruit-handoff", "#/components/schemas/NewRecruitHandoffEnvelope"],
  ]);
  for (const [path, expectedRef] of rosterResponseRefs) {
    assert.equal(
      openapi.paths[path].post.responses["200"].content["application/json"]
        .schema.$ref,
      expectedRef,
    );
  }
  assert.equal(
    openapi.paths["/api/v1/data-update-status"].get.responses["200"].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/DataUpdateStatusEnvelope",
  );

  const response = await render("/api/v1/data-status", {
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.violations[0].code, "REMOTE_API_DISABLED");
});
