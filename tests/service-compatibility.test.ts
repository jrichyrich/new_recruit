import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createServiceCompatibilityStore,
  deriveNewRecruitServiceIdentity,
  newRecruitServiceCompatibilityKey,
  ServiceCompatibilityStoreError,
  type NewRecruitServiceIdentityV1,
} from "../local/data-bundles/service-compatibility";

const digest = (character: string): string => character.repeat(64);

function identity(
  gameSystemRevision: number,
  catalogueRevision: number,
): NewRecruitServiceIdentityV1 {
  return {
    factionId: "adeptus-custodes",
    gameSystem: {
      id: "sys-352e-adc2-7639-d610",
      name: "Warhammer 40,000 11th Edition",
      revision: gameSystemRevision,
    },
    factionCatalogue: {
      id: "1f19-6509-d906-ca10",
      name: "Imperium - Adeptus Custodes",
      revision: catalogueRevision,
    },
  };
}

async function withDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-service-compatibility-"),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("receipt-backed observations and compatible snapshot refs survive restart", async () => {
  await withDirectory(async (directory) => {
    let now = new Date("2026-08-02T12:00:00.000Z");
    const store = createServiceCompatibilityStore({
      rootDirectory: directory,
      now: () => now,
    });
    const observed = identity(8, 7);
    const [first, duplicate] = await Promise.all([
      store.recordNewRecruitObservation({
        identity: observed,
        observedAt: "2026-08-02T11:59:00.000Z",
        evidence: {
          receiptKind: "tessera-preparation-receipt",
          receiptSha256: digest("a"),
          enrichedRoszSha256: digest("b"),
        },
        tessera: {
          observedAt: "2026-08-02T11:59:30.000Z",
          deploymentAssetSha256: digest("c"),
        },
      }),
      store.recordNewRecruitObservation({
        identity: observed,
        observedAt: "2026-08-02T11:59:00.000Z",
        evidence: {
          receiptKind: "tessera-preparation-receipt",
          receiptSha256: digest("a"),
          enrichedRoszSha256: digest("b"),
        },
        tessera: {
          observedAt: "2026-08-02T11:59:30.000Z",
          deploymentAssetSha256: digest("c"),
        },
      }),
    ]);
    assert.equal(first.observationId, duplicate.observationId);
    assert.equal(
      first.compatibilityKey,
      await newRecruitServiceCompatibilityKey(observed),
    );

    now = new Date("2026-08-02T12:01:00.000Z");
    const older = await store.retainCompatibleSnapshot({
      bundleId: digest("1"),
      identity: observed,
      snapshotCreatedAt: "2026-08-01T00:00:00.000Z",
      dataTrust: "signed-verified",
      bsDataCommit: "a".repeat(40),
    });
    now = new Date("2026-08-02T12:02:00.000Z");
    const newer = await store.retainCompatibleSnapshot({
      bundleId: digest("2"),
      identity: observed,
      snapshotCreatedAt: "2026-08-02T00:00:00.000Z",
      dataTrust: "locally-verified",
      bsDataCommit: "b".repeat(40),
    });
    await store.retainCompatibleSnapshot({
      bundleId: digest("3"),
      identity: identity(7, 6),
      snapshotCreatedAt: "2026-08-03T00:00:00.000Z",
      dataTrust: "locally-verified",
      bsDataCommit: "c".repeat(40),
    });

    const restarted = createServiceCompatibilityStore({
      rootDirectory: directory,
    });
    assert.equal(
      (await restarted.latestNewRecruitObservation(
        "adeptus-custodes",
      ))?.observationId,
      first.observationId,
    );
    assert.equal(
      (await restarted.findNewestCompatibleSnapshot({
        factionId: "adeptus-custodes",
      }))?.referenceId,
      newer.referenceId,
    );
    assert.equal(
      (await restarted.findNewestCompatibleSnapshot({
        factionId: "adeptus-custodes",
        retainedBundleIds: [older.bundleId],
      }))?.referenceId,
      older.referenceId,
    );
    assert.equal(
      await restarted.findNewestCompatibleSnapshot({
        factionId: "adeptus-custodes",
        retainedBundleIds: [],
      }),
      null,
    );
    assert.equal(
      await restarted.releaseCompatibleSnapshot(newer.referenceId),
      true,
    );
    assert.equal(
      await restarted.releaseCompatibleSnapshot(newer.referenceId),
      false,
    );
  });
});

test("Tessera metadata cannot change the New Recruit compatibility key", async () => {
  const observed = identity(8, 7);
  const key = await newRecruitServiceCompatibilityKey(observed);
  const renamed: NewRecruitServiceIdentityV1 = {
    ...observed,
    gameSystem: {
      ...observed.gameSystem,
      name: "Presentation-only rename",
    },
    factionCatalogue: {
      ...observed.factionCatalogue,
      name: null,
    },
  };
  assert.equal(
    await newRecruitServiceCompatibilityKey(renamed),
    key,
  );
  assert.notEqual(
    await newRecruitServiceCompatibilityKey(identity(9, 7)),
    key,
  );
});

test("observed archives must contain exact game-system and faction catalogue identity", () => {
  assert.deepEqual(
    deriveNewRecruitServiceIdentity({
      factionId: "adeptus-custodes",
      expectedFactionCatalogueId: "custodes",
      observed: {
        source: "new-recruit-enriched-rosz",
        gameSystem: {
          id: "system",
          name: "Warhammer 40,000",
          revision: 8,
        },
        catalogues: [
          {
            id: "custodes",
            name: "Adeptus Custodes",
            revision: 7,
          },
        ],
      },
    }),
    {
      factionId: "adeptus-custodes",
      gameSystem: {
        id: "system",
        name: "Warhammer 40,000",
        revision: 8,
      },
      factionCatalogue: {
        id: "custodes",
        name: "Adeptus Custodes",
        revision: 7,
      },
    },
  );
  assert.throws(
    () =>
      deriveNewRecruitServiceIdentity({
        factionId: "adeptus-custodes",
        expectedFactionCatalogueId: "custodes",
        observed: {
          source: "new-recruit-enriched-rosz",
          gameSystem: {
            id: "system",
            name: null,
            revision: null,
          },
          catalogues: [],
        },
      }),
    (error: unknown) =>
      error instanceof ServiceCompatibilityStoreError &&
      error.code ===
        "SERVICE_COMPATIBILITY_IDENTITY_INCOMPLETE",
  );
});

test("tampered compatibility state fails closed", async () => {
  await withDirectory(async (directory) => {
    const store = createServiceCompatibilityStore({
      rootDirectory: directory,
    });
    await store.recordNewRecruitObservation({
      identity: identity(8, 7),
      observedAt: "2026-08-02T11:59:00.000Z",
      evidence: {
        receiptKind: "new-recruit-mutation-receipt",
        receiptSha256: digest("a"),
        enrichedRoszSha256: digest("b"),
      },
    });
    const statePath = path.join(
      directory,
      "service-compatibility.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.observations[0].identity.gameSystem.revision = 999;
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(
      store.readState(),
      (error: unknown) =>
        error instanceof ServiceCompatibilityStoreError &&
        error.code === "SERVICE_COMPATIBILITY_STATE_INVALID",
    );
  });
});

test("Tessera evidence augments the matching receipt-backed catalogue observation", async () => {
  await withDirectory(async (directory) => {
    const store = createServiceCompatibilityStore({
      rootDirectory: directory,
    });
    await store.recordNewRecruitObservation({
      identity: identity(8, 7),
      observedAt: "2026-08-02T11:59:00.000Z",
      evidence: {
        receiptKind: "new-recruit-mutation-receipt",
        receiptSha256: digest("a"),
        enrichedRoszSha256: digest("b"),
      },
    });

    assert.equal(
      await store.recordTesseraEvidence({
        factionId: "adeptus-custodes",
        enrichedRoszSha256: digest("c"),
        observedAt: "2026-08-02T12:00:00.000Z",
        deploymentAssetSha256: digest("d"),
      }),
      null,
    );
    const augmented = await store.recordTesseraEvidence({
      factionId: "adeptus-custodes",
      enrichedRoszSha256: digest("b"),
      observedAt: "2026-08-02T12:00:00.000Z",
      deploymentAssetSha256: digest("d"),
      importedSemanticsSha256: digest("e"),
      jobReceiptSha256: digest("f"),
    });
    assert.equal(augmented?.tessera?.deploymentAssetSha256, digest("d"));
    assert.equal(augmented?.tessera?.importedSemanticsSha256, digest("e"));
    assert.equal(
      (await store.latestNewRecruitObservation("adeptus-custodes"))
        ?.tessera?.jobReceiptSha256,
      digest("f"),
    );
  });
});

test("stale compatibility locks are recovered only when their recorded owner is dead", async () => {
  await withDirectory(async (directory) => {
    const lockDirectory = path.join(
      directory,
      "service-compatibility.lock",
    );
    const owner = {
      schemaVersion: 1,
      pid: 424_242,
      token: "83b39b74-d771-48df-bc02-9f69df29d452",
      acquiredAt: "2026-08-02T10:00:00.000Z",
    };
    await mkdir(lockDirectory);
    await writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify(owner)}\n`,
    );

    const liveOwnerStore = createServiceCompatibilityStore({
      rootDirectory: directory,
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      isProcessAlive: (pid) => pid === owner.pid,
      lockTimeoutMs: 30,
      staleLockMs: 1,
    });
    await assert.rejects(
      liveOwnerStore.recordNewRecruitObservation({
        identity: identity(8, 7),
        observedAt: "2026-08-02T11:59:00.000Z",
        evidence: {
          receiptKind: "new-recruit-mutation-receipt",
          receiptSha256: digest("a"),
          enrichedRoszSha256: digest("b"),
        },
      }),
      (error: unknown) =>
        error instanceof ServiceCompatibilityStoreError &&
        error.code === "SERVICE_COMPATIBILITY_LOCKED",
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(lockDirectory, "owner.json"), "utf8"),
      ),
      owner,
    );

    const deadOwnerStore = createServiceCompatibilityStore({
      rootDirectory: directory,
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      isProcessAlive: () => false,
      lockTimeoutMs: 100,
      staleLockMs: 1,
    });
    const observation = await deadOwnerStore.recordNewRecruitObservation({
      identity: identity(8, 7),
      observedAt: "2026-08-02T11:59:00.000Z",
      evidence: {
        receiptKind: "new-recruit-mutation-receipt",
        receiptSha256: digest("a"),
        enrichedRoszSha256: digest("b"),
      },
    });
    assert.equal(observation.identity.gameSystem.revision, 8);
    await assert.rejects(
      readFile(path.join(lockDirectory, "owner.json"), "utf8"),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT",
        ),
    );
  });
});
