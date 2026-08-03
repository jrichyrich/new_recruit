import assert from "node:assert/strict";
import test from "node:test";

import { websiteDataReadiness } from "../app/page";

type Bundle = Parameters<typeof websiteDataReadiness>[0];

function bundleFixture(overrides: Partial<Bundle> = {}): Bundle {
  return {
    providerConfigured: true,
    providerMode: "local-source",
    state: "ready",
    activeBundleId: "a".repeat(64),
    latestVerifiedBundleId: "a".repeat(64),
    latestUpstreamBundleId: "a".repeat(64),
    candidate: null,
    quarantinedScopes: [],
    lastSuccessfulCheckAt: "2026-08-02T00:00:00.000Z",
    officialAuthority: {
      status: "unavailable",
      reason: "fixture",
    },
    dataTrust: "locally-verified",
    localUpdate: {
      jobId: "local-update-fixture",
      status: "activated",
      progress: "Local snapshot activated.",
      startedAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:01:00.000Z",
      completedAt: "2026-08-02T00:01:00.000Z",
      retryAt: null,
    },
    sourceStatus: {
      latestUpstream: {
        rulesVersion: "1.2.1",
        newRecruitCommit: "b".repeat(40),
        officialContentSha256: "c".repeat(64),
      },
      latestLocallyCertified: {
        bundleId: "a".repeat(64),
        rulesVersion: "1.2.1",
        newRecruitCommit: "b".repeat(40),
        certifiedAt: "2026-08-02T00:01:00.000Z",
      },
      officialReconciliation: "verified",
    },
    serviceCompatibility: [],
    durability: {
      mode: "persistent",
      state: "ready",
      reason: null,
    },
    ...overrides,
  };
}

test("website separates trust, upstream, service, and official data state", () => {
  const bundle = bundleFixture({
    sourceStatus: {
      latestUpstream: {
        rulesVersion: "1.2.2",
        newRecruitCommit: "b".repeat(40),
        officialContentSha256: "d".repeat(64),
      },
      latestLocallyCertified: {
        bundleId: "a".repeat(64),
        rulesVersion: "1.2.1",
        newRecruitCommit: "b".repeat(40),
        certifiedAt: "2026-08-02T00:01:00.000Z",
      },
      officialReconciliation: "pending",
    },
    serviceCompatibility: [
      {
        service: "tessera-web",
        factionId: "adeptus-custodes",
        observedAt: "2026-08-02T00:02:00.000Z",
        gameSystemId: "system-fixture",
        gameSystemRevision: 8,
        catalogueId: "catalogue-fixture",
        catalogueRevision: 7,
        compatibleBundleId: null,
      },
    ],
  });
  const items = websiteDataReadiness(bundle);

  assert.deepEqual(
    items.map((item) => item.id),
    [
      "snapshot",
      "update-job",
      "upstream",
      "service-compatibility",
      "official-reconciliation",
    ],
  );
  assert.equal(items.find((item) => item.id === "snapshot")?.title, "Locally verified");
  assert.equal(items.find((item) => item.id === "upstream")?.title, "Upstream is newer");
  assert.equal(
    items.find((item) => item.id === "service-compatibility")?.title,
    "Compatibility repair needed",
  );
  assert.equal(
    items.find((item) => item.id === "official-reconciliation")?.title,
    "Official reconciliation pending",
  );
});

test("website never presents a queued local update as activated", () => {
  const items = websiteDataReadiness(
    bundleFixture({
      dataTrust: "compiled-unverified",
      activeBundleId: "c".repeat(64),
      localUpdate: {
        jobId: "local-update-queued",
        status: "queued",
        progress: "Waiting for the worker.",
        startedAt: null,
        updatedAt: "2026-08-02T00:03:00.000Z",
        completedAt: null,
        retryAt: null,
      },
      sourceStatus: {
        latestUpstream: {
          rulesVersion: "1.2.2",
          newRecruitCommit: "e".repeat(40),
          officialContentSha256: null,
        },
        latestLocallyCertified: null,
        officialReconciliation: "unavailable",
      },
    }),
  );
  const job = items.find((item) => item.id === "update-job");

  assert.equal(job?.title, "Update queued");
  assert.equal(job?.tone, "warning");
  assert.match(job?.detail ?? "", /Snapshot cccccccccccc… remains active/);
  assert.doesNotMatch(job?.detail ?? "", /activated/);
});
