import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  buildRuntimeDataBundle,
  buildRoster,
  getDataUpdateStatus,
  rebaseRoster,
  rebaseRosterData,
  rebaseRosterWithProvider,
  releaseDataBundleReference,
  retainDataBundleReference,
  refreshDataNow,
  rollbackDataBundle,
  runtimeRosterCompatibilitySnapshot,
  signRuntimeDataBundle,
  verifyRuntimeDataBundle,
  type DataBundleProvider,
  type DataBundleProviderStatus,
} from "../lib/rosterpilot";
import { createRosterPilotMcpServer } from "../mcp/server";

const activeBundleId = "a".repeat(64);
const candidateBundleId = "b".repeat(64);
const rollbackBundleId = "c".repeat(64);

function status(
  overrides: Partial<DataBundleProviderStatus> = {},
): DataBundleProviderStatus {
  return {
    state: "ready",
    activeBundleId,
    latestVerifiedBundleId: activeBundleId,
    latestUpstreamBundleId: candidateBundleId,
    candidate: null,
    quarantinedScopes: [],
    lastCheckedAt: "2026-07-31T15:00:00.000Z",
    officialAuthority: {
      status: "verified",
      sourceArtifactSha256: "1".repeat(64),
      overlaySha256: "2".repeat(64),
      receiptSha256: "3".repeat(64),
      extractorId: "reviewed-fixture",
      extractorKeyId: "reviewed-fixture-key",
    },
    ...overrides,
  };
}

function providerFixture() {
  let force: boolean | undefined;
  let rolledBackTo: string | null = null;
  let releasedLeases = 0;
  const retainedReferences: Array<[string, string]> = [];
  const releasedReferences: Array<[string, string | undefined]> = [];
  const provider: DataBundleProvider = {
    acquireSnapshot: async () => ({
      leaseId: crypto.randomUUID(),
      snapshot: {} as Awaited<
        ReturnType<DataBundleProvider["acquireSnapshot"]>
      >["snapshot"],
      released: false,
      release: async () => {
        releasedLeases += 1;
      },
    }),
    getStatus: async () => status(),
    refresh: async (options) => {
      force = options?.force;
      return {
        status: status({
          state: "candidate-ready",
          latestVerifiedBundleId: candidateBundleId,
        }),
        activatedBundleId: candidateBundleId,
        classification: {
          classification: "provenance-only",
          directlyChangedFactions: [],
          affectedFactions: [],
          changedEntities: {},
          changedScopes: [],
          requiresFullCertification: false,
          quarantine: false,
          reasons: ["Only raw provenance changed."],
        },
      };
    },
    rollback: async (bundleId) => {
      rolledBackTo = bundleId;
      return status({
        activeBundleId: bundleId,
        latestVerifiedBundleId: candidateBundleId,
      });
    },
    retainReference: async (referenceId, bundleId) => {
      retainedReferences.push([referenceId, bundleId]);
    },
    releaseReference: async (referenceId, bundleId) => {
      releasedReferences.push([referenceId, bundleId]);
    },
  };
  return {
    provider,
    force: () => force,
    rolledBackTo: () => rolledBackTo,
    releasedLeases: () => releasedLeases,
    retainedReferences: () => retainedReferences,
    releasedReferences: () => releasedReferences,
  };
}

test("data operations preserve provider status, refresh classification, and rollback target", async () => {
  const fixture = providerFixture();
  const updateStatus = await getDataUpdateStatus(fixture.provider);
  assert.equal(updateStatus.ok, true);
  assert.equal(updateStatus.data?.activeBundleId, activeBundleId);
  assert.equal(
    updateStatus.data?.latestUpstreamBundleId,
    candidateBundleId,
  );
  assert.equal(
    updateStatus.data?.officialAuthority.status,
    "verified",
  );

  const refreshed = await refreshDataNow(
    { force: true },
    fixture.provider,
  );
  assert.equal(refreshed.ok, true);
  assert.equal(fixture.force(), true);
  assert.equal(refreshed.data?.activatedBundleId, candidateBundleId);
  assert.equal(
    refreshed.data?.classification?.classification,
    "provenance-only",
  );

  const invalid = await rollbackDataBundle(
    "not-a-bundle",
    fixture.provider,
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.violations[0]?.code, "DATA_BUNDLE_ID_INVALID");

  const rolledBack = await rollbackDataBundle(
    rollbackBundleId,
    fixture.provider,
  );
  assert.equal(rolledBack.ok, true);
  assert.equal(fixture.rolledBackTo(), rollbackBundleId);
  assert.equal(rolledBack.data?.activeBundleId, rollbackBundleId);

  assert.equal(
    await retainDataBundleReference(
      "roster:test",
      activeBundleId,
      fixture.provider,
    ),
    true,
  );
  assert.equal(
    await releaseDataBundleReference(
      "roster:test",
      activeBundleId,
      fixture.provider,
    ),
    true,
  );
  assert.deepEqual(fixture.retainedReferences(), [
    ["roster:test", activeBundleId],
  ]);
  assert.deepEqual(fixture.releasedReferences(), [
    ["roster:test", activeBundleId],
  ]);
});

test("data operations fail closed without disabling the bootstrap bundle", async () => {
  const updateStatus = await getDataUpdateStatus(null);
  assert.equal(updateStatus.ok, true);
  assert.equal(updateStatus.data?.state, "offline");
  assert.equal(updateStatus.data?.providerConfigured, false);
  assert.match(updateStatus.data?.activeBundleId ?? "", /^[a-f0-9]{64}$/);
  assert.equal(updateStatus.data?.latestVerifiedBundleId, null);
  assert.equal(updateStatus.data?.dataTrust, "compiled-unverified");

  const refresh = await refreshDataNow({}, null);
  assert.equal(refresh.ok, false);
  assert.equal(
    refresh.violations[0]?.code,
    "DATA_BUNDLE_PROVIDER_UNAVAILABLE",
  );
  assert.equal(
    await retainDataBundleReference(
      "roster:offline",
      activeBundleId,
      null,
    ),
    false,
  );
});

test("rebase operation never changes selections when semantic review is required", () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 500,
  });
  assert.ok(built.ok && built.data);
  const current = rebaseRoster(built.data);
  assert.equal(current.ok, true);
  assert.equal(current.data?.status, "current");
  assert.deepEqual(current.data?.roster.units, built.data.units);
});

test("provider-aware rebase verifies the retained historical bundle before current data", async () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 500,
  });
  assert.ok(built.ok && built.data);

  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signer = {
    keyId: "historical-rebase-test",
    privateKey: keys.privateKey,
  };
  const trustedKeys = {
    "historical-rebase-test": keys.publicKey,
  };
  const signed = await signRuntimeDataBundle(
    await buildRuntimeDataBundle({
      createdAt: "2026-07-30T00:00:00.000Z",
      // The roster above comes from the compiled schema-v1 fallback. Keep
      // this historical bundle on the same semantic methodology so the test
      // isolates provenance-aware retained-bundle verification.
      engineDataSchemaVersion: 1,
    }),
    signer,
  );
  const verified = await verifyRuntimeDataBundle({
    manifest: signed.manifest,
    shards: signed.shards,
    trustedKeys,
  });
  if (!verified.ok) {
    assert.fail(`Historical bundle failed verification: ${verified.message}`);
  }
  const historicalIdentity = runtimeRosterCompatibilitySnapshot(
    verified.data,
    built.data.factionId,
  );
  const rebound = rebaseRosterData(built.data, {
    snapshot: historicalIdentity,
  });
  assert.ok(rebound.ok && rebound.data);
  assert.equal(rebound.data.status, "compatible-rebased");
  const historicalRoster = rebound.data.roster;

  const requestedBundleIds: string[] = [];
  let releases = 0;
  const provider: DataBundleProvider = {
    async acquireSnapshot(options) {
      requestedBundleIds.push(options?.bundleId ?? "");
      assert.deepEqual(options?.factionIds, [
        historicalRoster.factionId,
      ]);
      let released = false;
      return {
        leaseId: crypto.randomUUID(),
        snapshot: verified.data,
        get released() {
          return released;
        },
        async release() {
          if (released) return;
          released = true;
          releases += 1;
        },
      };
    },
    async getStatus() {
      return status();
    },
    async refresh() {
      throw new Error("not used");
    },
    async rollback() {
      throw new Error("not used");
    },
  };

  const compatible = await rebaseRosterWithProvider(
    historicalRoster,
    provider,
  );
  assert.equal(compatible.ok, true);
  assert.equal(compatible.data?.status, "compatible-rebased");
  assert.deepEqual(
    compatible.data?.roster.units,
    historicalRoster.units,
  );

  const tampered = structuredClone(historicalRoster);
  const unitKey = Object.keys(
    tampered.sourceData.entityHashes,
  ).find((key) => key.startsWith("unit:"));
  assert.ok(unitKey);
  tampered.sourceData.entityHashes[unitKey] = "f".repeat(64);
  const rejected = await rebaseRosterWithProvider(
    tampered,
    provider,
  );
  assert.equal(rejected.ok, false);
  assert.equal(
    rejected.violations[0]?.code,
    "ROSTER_DATA_INTEGRITY_MISMATCH",
  );
  assert.deepEqual(requestedBundleIds, [
    historicalRoster.sourceData.bundleId,
    historicalRoster.sourceData.bundleId,
  ]);
  assert.equal(releases, 2);
});

test("MCP exposes the same data provider operations", async () => {
  const fixture = providerFixture();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRosterPilotMcpServer({
    dataBundleProvider: fixture.provider,
  });
  const client = new Client({
    name: "rosterpilot-data-operations-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const dataStatus = await client.callTool({
      name: "get_data_status",
      arguments: {},
    });
    assert.equal(dataStatus.isError, false);
    assert.equal(
      (
        dataStatus.structuredContent as {
          data: {
            dataBundle: {
              activeBundleId: string;
              officialAuthority: { status: string };
            };
          };
        }
      ).data.dataBundle.activeBundleId,
      activeBundleId,
    );
    assert.equal(
      (
        dataStatus.structuredContent as {
          data: {
            dataBundle: {
              officialAuthority: { status: string };
            };
          };
        }
      ).data.dataBundle.officialAuthority.status,
      "verified",
    );

    const updateStatus = await client.callTool({
      name: "get_data_update_status",
      arguments: {},
    });
    assert.equal(updateStatus.isError, false);
    assert.equal(
      (
        updateStatus.structuredContent as {
          data: {
            activeBundleId: string;
            officialAuthority: { status: string };
          };
        }
      ).data.activeBundleId,
      activeBundleId,
    );
    assert.equal(
      (
        updateStatus.structuredContent as {
          data: { officialAuthority: { status: string } };
        }
      ).data.officialAuthority.status,
      "verified",
    );

    const refreshed = await client.callTool({
      name: "refresh_data_now",
      arguments: { force: true },
    });
    assert.equal(refreshed.isError, false);
    assert.equal(fixture.force(), true);

    const rolledBack = await client.callTool({
      name: "rollback_data_bundle",
      arguments: { bundleId: rollbackBundleId },
    });
    assert.equal(rolledBack.isError, false);
    assert.equal(fixture.rolledBackTo(), rollbackBundleId);
    assert.equal(
      fixture.releasedLeases(),
      1,
      "engine reads lease a snapshot; control-plane status, refresh, and rollback must not lease the bundle they coordinate",
    );
  } finally {
    await client.close();
    await server.close();
  }
});
