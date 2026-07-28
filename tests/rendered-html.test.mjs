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
  assert.equal(openapi.components.securitySchemes.bearerAuth.scheme, "bearer");

  const response = await render("/api/v1/data-status", {
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.violations[0].code, "REMOTE_API_DISABLED");
});
