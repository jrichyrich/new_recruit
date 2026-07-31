import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  GET,
  POST,
} from "../app/api/v1/[...path]/route";
import {
  GET as GET_DATA_FRESHNESS,
} from "../app/api/data-freshness/route";
import {
  GET as GET_BROWSER_ENGINE,
  POST as POST_BROWSER_ENGINE,
} from "../app/api/browser-engine/route";
import {
  buildRoster,
  configureDataBundleProvider,
  rosterExecutionFingerprint,
  setCachedDataFreshness,
  type BuildRosterInput,
  type DataBundleProvider,
  type RosterDraftV1,
} from "../lib/rosterpilot";

const bundleId = "a".repeat(64);

function trackingProvider(events: string[]): DataBundleProvider {
  return {
    async acquireSnapshot() {
      events.push("acquire");
      let released = false;
      return {
        leaseId: "hosted-http-test",
        snapshot: null as never,
        get released() {
          return released;
        },
        async release() {
          if (released) return;
          released = true;
          events.push("release");
        },
      };
    },
    async getStatus() {
      return {
        state: "ready",
        activeBundleId: bundleId,
        latestVerifiedBundleId: bundleId,
        latestUpstreamBundleId: bundleId,
        candidate: null,
        quarantinedScopes: [],
        lastCheckedAt: "2026-07-31T00:00:00.000Z",
      };
    },
    async refresh() {
      return {
        status: await this.getStatus(),
        activatedBundleId: null,
        classification: null,
      };
    },
    async rollback() {
      return this.getStatus();
    },
  };
}

afterEach(() => {
  configureDataBundleProvider(null);
});

test("HTTP roster construction matches the shared deterministic engine", async () => {
  const input: BuildRosterInput = {
    prompt:
      "Build a 1,000 point fast Custodes army with no named characters",
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    preferences: ["mobility", "objective"],
    allowNamedCharacters: false,
  };
  const direct = buildRoster(input);
  assert.ok(direct.data);
  const previousToken = process.env.ROSTERPILOT_API_TOKEN;
  process.env.ROSTERPILOT_API_TOKEN = "certification-parity-token";
  let response: Response;
  try {
    response = await POST(
      new Request("http://localhost/api/v1/rosters/build", {
        method: "POST",
        headers: {
          authorization: "Bearer certification-parity-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }),
    );
  } finally {
    if (previousToken === undefined) {
      delete process.env.ROSTERPILOT_API_TOKEN;
    } else {
      process.env.ROSTERPILOT_API_TOKEN = previousToken;
    }
  }
  assert.equal(response.status, 200);
  const transported = (await response.json()) as {
    ok: boolean;
    data: RosterDraftV1;
  };
  assert.equal(transported.ok, true);
  assert.equal(
    rosterExecutionFingerprint(transported.data),
    rosterExecutionFingerprint(direct.data),
  );
});

test("hosted REST holds and releases one configured data snapshot per request", async () => {
  const events: string[] = [];
  configureDataBundleProvider(trackingProvider(events));
  const previousToken = process.env.ROSTERPILOT_API_TOKEN;
  process.env.ROSTERPILOT_API_TOKEN = "snapshot-lease-token";
  try {
    const response = await GET(
      new Request("http://localhost/api/v1/factions", {
        headers: {
          authorization: "Bearer snapshot-lease-token",
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(events, ["acquire", "release"]);

    events.length = 0;
    const malformed = await POST(
      new Request("http://localhost/api/v1/rosters/build", {
        method: "POST",
        headers: {
          authorization: "Bearer snapshot-lease-token",
          "content-type": "application/json",
        },
        body: "{",
      }),
    );
    assert.equal(malformed.status, 400);
    assert.deepEqual(events, ["acquire", "release"]);
  } finally {
    if (previousToken === undefined) {
      delete process.env.ROSTERPILOT_API_TOKEN;
    } else {
      process.env.ROSTERPILOT_API_TOKEN = previousToken;
    }
  }
});

test("hosted data refresh and rollback do not self-lease the bundle they replace", async () => {
  const events: string[] = [];
  configureDataBundleProvider(trackingProvider(events));
  const previousToken = process.env.ROSTERPILOT_API_TOKEN;
  process.env.ROSTERPILOT_API_TOKEN = "data-control-token";
  try {
    const status = await GET(
      new Request("http://localhost/api/v1/data-update-status", {
        headers: {
          authorization: "Bearer data-control-token",
        },
      }),
    );
    assert.equal(status.status, 200);
    assert.deepEqual(
      events,
      [],
      "control-plane status must not acquire a roster-data lease",
    );

    const refreshed = await POST(
      new Request("http://localhost/api/v1/data-refresh", {
        method: "POST",
        headers: {
          authorization: "Bearer data-control-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: true }),
      }),
    );
    assert.equal(refreshed.status, 200);
    assert.deepEqual(events, []);

    const rolledBack = await POST(
      new Request("http://localhost/api/v1/data-rollback", {
        method: "POST",
        headers: {
          authorization: "Bearer data-control-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ bundleId }),
      }),
    );
    assert.equal(rolledBack.status, 200);
    assert.deepEqual(
      events,
      [],
      "control-plane operations must not hold the snapshot they are activating away from",
    );
  } finally {
    if (previousToken === undefined) {
      delete process.env.ROSTERPILOT_API_TOKEN;
    } else {
      process.env.ROSTERPILOT_API_TOKEN = previousToken;
    }
  }
});

test("the public freshness route reads within the hosted snapshot lease", async () => {
  const events: string[] = [];
  configureDataBundleProvider(trackingProvider(events));
  setCachedDataFreshness({
    ok: true,
    data: {
      checkedAt: "2026-07-31T00:00:00.000Z",
      state: "current",
      rules: {
        pinnedVersion: "1.2.1",
        latestVersion: "1.2.1",
        updateAvailable: false,
      },
      newRecruit: {
        pinnedCommit: bundleId,
        latestCommit: bundleId,
        updateAvailable: false,
      },
      official: {
        pinnedVersion: "3.4",
        latestVersion: "3.4",
        pinnedContentSha256: bundleId,
        latestContentSha256: bundleId,
        updateAvailable: false,
      },
    },
    violations: [],
    warnings: [],
  });

  const response = await GET_DATA_FRESHNESS();
  assert.equal(response.status, 200);
  assert.deepEqual(events, ["acquire", "release"]);
});

test("the browser builder executes search and roster construction under the hosted snapshot", async () => {
  const events: string[] = [];
  configureDataBundleProvider(trackingProvider(events));

  const bootstrap = await GET_BROWSER_ENGINE(
    new Request(
      "http://localhost/api/browser-engine?bootstrap=true&selectedFaction=adeptus-custodes",
      {
        headers: {
          "sec-fetch-site": "same-origin",
        },
      },
    ),
  );
  assert.equal(bootstrap.status, 200);
  const bootstrapPayload = (await bootstrap.json()) as {
    data?: { workspace?: { roster?: RosterDraftV1 } };
  };
  assert.equal(
    bootstrapPayload.data?.workspace?.roster?.factionId,
    "adeptus-custodes",
  );
  assert.deepEqual(events, ["acquire", "release"]);

  events.length = 0;
  const built = await POST_BROWSER_ENGINE(
    new Request("http://localhost/api/browser-engine", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "build",
        input: {
          prompt: "Build a 1,000 point fast Custodes army",
          playerFaction: "adeptus-custodes",
          pointsLimit: 1000,
        },
      }),
    }),
  );
  assert.equal(built.status, 200);
  assert.deepEqual(events, ["acquire", "release"]);

  events.length = 0;
  const crossOrigin = await POST_BROWSER_ENGINE(
    new Request("http://localhost/api/browser-engine", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "inspect", roster: {} }),
    }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(events, []);

  const headerless = await POST_BROWSER_ENGINE(
    new Request("http://localhost/api/browser-engine", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "inspect", roster: {} }),
    }),
  );
  assert.equal(headerless.status, 403);
  assert.deepEqual(events, []);
});

test("browser inspection automatically rebases provenance-compatible rosters", async () => {
  const built = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1_000,
  });
  assert.ok(built.data);
  const historical = structuredClone(built.data);
  historical.sourceData.bundleId = "b".repeat(64);
  historical.sourceData.releaseId = "historical-provenance-only";
  historical.sourceData.newRecruit.commit = "c".repeat(40);

  const response = await POST_BROWSER_ENGINE(
    new Request("http://localhost/api/browser-engine", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "inspect", roster: historical }),
    }),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    ok: boolean;
    data: {
      roster: RosterDraftV1;
      dataCompatibility: {
        status: string;
        fromBundleId: string;
        toBundleId: string;
        provenanceChanged: boolean;
      };
    };
    warnings: Array<{ code: string }>;
  };
  assert.equal(payload.ok, true);
  assert.equal(
    payload.data.dataCompatibility.status,
    "compatible-rebased",
  );
  assert.equal(
    payload.data.dataCompatibility.fromBundleId,
    historical.sourceData.bundleId,
  );
  assert.equal(
    payload.data.roster.sourceData.bundleId,
    built.data.sourceData.bundleId,
  );
  assert.equal(
    payload.data.dataCompatibility.provenanceChanged,
    true,
  );
  assert.equal(
    payload.warnings.some(
      (warning) => warning.code === "DATA_PROVENANCE_CHANGED",
    ),
    true,
  );
});
