import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import {
  GET,
  POST,
} from "../app/api/browser-engine/route";
import {
  activateLegendsInventory,
  resetActiveLegendsInventoryForTests,
  resetHostedDataBundleProviderInitializationForTests,
  type RosterDraftV1,
  type UnitSummary,
} from "../lib/rosterpilot";

afterEach(() => {
  resetActiveLegendsInventoryForTests();
  resetHostedDataBundleProviderInitializationForTests();
});

function sameOriginHeaders(): HeadersInit {
  return {
    origin: "http://localhost",
    "sec-fetch-site": "same-origin",
  };
}

test("browser search honors includeLegends and keeps inventory-only entries read-only", async () => {
  activateLegendsInventory(
    new Map([
      [
        "aeldari",
        {
          schemaVersion: 1 as const,
          factionId: "aeldari",
          coverageStatus: "complete" as const,
          classificationAuthority:
            "games-workshop-verified" as const,
          sourceArtifacts: [
            {
              sourceId: "browser-fixture-pack",
              version: "2026-08",
              contentSha256: "d".repeat(64),
              url: "https://example.com/browser-fixture.pdf",
            },
          ],
          units: [
            {
              legendId: "official:aeldari:browser-fixture",
              factionId: "aeldari",
              name: "Aeldari Browser Legends Fixture",
              unitId: null,
              sourceId: "browser-fixture-pack",
              datasheetUrl:
                "https://example.com/browser-fixture-datasheet.pdf",
              buildSupported: false,
            },
          ],
        },
      ],
    ]),
  );
  const hidden = await GET(
    new Request(
      "http://localhost/api/browser-engine?selectedFaction=aeldari&unitQuery=Aeldari+Browser+Legends+Fixture",
      { headers: sameOriginHeaders() },
    ),
  );
  const hiddenPayload = (await hidden.json()) as {
    data: { units: UnitSummary[] };
  };
  assert.deepEqual(hiddenPayload.data.units, []);

  const visible = await GET(
    new Request(
      "http://localhost/api/browser-engine?selectedFaction=aeldari&unitQuery=Aeldari+Browser+Legends+Fixture&includeLegends=true",
      { headers: sameOriginHeaders() },
    ),
  );
  const visiblePayload = (await visible.json()) as {
    data: { units: UnitSummary[] };
  };
  assert.equal(visiblePayload.data.units.length, 1);
  assert.equal(visiblePayload.data.units[0].isLegend, true);
  assert.equal(visiblePayload.data.units[0].supported, false);
  assert.deepEqual(
    visiblePayload.data.units[0].legendProvenance,
    {
      classificationAuthority: "games-workshop-verified",
      sourceId: "browser-fixture-pack",
      version: "2026-08",
      contentSha256: "d".repeat(64),
      url: "https://example.com/browser-fixture.pdf",
      datasheetUrl:
        "https://example.com/browser-fixture-datasheet.pdf",
    },
  );
});

test("browser search preserves Legends classification warnings", async () => {
  activateLegendsInventory(
    new Map([
      [
        "aeldari",
        {
          schemaVersion: 1 as const,
          factionId: "aeldari",
          coverageStatus: "unavailable" as const,
          classificationAuthority: "unavailable" as const,
          sourceArtifacts: [],
          units: [],
        },
      ],
    ]),
  );

  const hidden = await GET(
    new Request(
      "http://localhost/api/browser-engine?selectedFaction=aeldari",
      { headers: sameOriginHeaders() },
    ),
  );
  const hiddenPayload = (await hidden.json()) as {
    warnings: Array<{ code: string }>;
  };
  assert.deepEqual(hiddenPayload.warnings, []);

  const visible = await GET(
    new Request(
      "http://localhost/api/browser-engine?selectedFaction=aeldari&includeLegends=true",
      { headers: sameOriginHeaders() },
    ),
  );
  const visiblePayload = (await visible.json()) as {
    ok: boolean;
    data: { units: UnitSummary[] };
    warnings: Array<{
      code: string;
      message: string;
      severity: string;
    }>;
  };
  assert.equal(visiblePayload.ok, true);
  assert.ok(Array.isArray(visiblePayload.data.units));
  assert.deepEqual(
    visiblePayload.warnings.map((warning) => warning.code),
    ["LEGENDS_CLASSIFICATION_UNVERIFIED"],
  );
  assert.equal(visiblePayload.warnings[0].severity, "warn");
});

test("browser build forwards Legends policy and play context unchanged", async () => {
  const response = await POST(
    new Request("http://localhost/api/browser-engine", {
      method: "POST",
      headers: {
        ...sameOriginHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "build",
        input: {
          faction: "adeptus-custodes",
          pointsLimit: 1_000,
          legendsPolicy: "exclude",
          playContext: { kind: "open-play" },
        },
      }),
    }),
  );
  const payload = (await response.json()) as {
    ok: boolean;
    data: { roster: RosterDraftV1 };
  };
  assert.equal(payload.ok, true);
  assert.equal(
    payload.data.roster.constraints.legendsPolicyDecision
      ?.requestedPolicy,
    "exclude",
  );
  assert.equal(
    payload.data.roster.constraints.legendsPolicyDecision
      ?.playContextKind,
    "open-play",
  );
});

test("browser UI exposes Legends visibility, policy, and play-context controls", async () => {
  const source = await readFile("app/page.tsx", "utf8");
  assert.match(source, /Show Legends/);
  assert.match(source, /aria-label="Legends policy"/);
  assert.match(source, /aria-label="Play context"/);
  assert.match(source, /includeLegends: String\(showLegends\)/);
  assert.match(source, /legendsPolicy,/);
  assert.match(source, /playContext: \{ kind: playContext \}/);
  assert.match(source, /setUnitSearchWarnings\(result\.warnings\)/);
  assert.match(source, /aria-label="Unit search warnings"/);
  assert.match(source, /Verified Games Workshop source/);
  assert.match(source, /unit\.legendProvenance\.datasheetUrl/);
});
