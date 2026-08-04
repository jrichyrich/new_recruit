import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "../lib/rosterpilot";
import {
  evaluatePersonalLocalParityAttestationV1,
  type PersonalLocalParityRotationV1,
} from "../local/tessera/personal-local-attestation";
import {
  createStoredPersonalLocalParityAttestationV1,
  inspectPersonalLocalParityAttestationStoreV1,
  loadPersonalLocalParityAttestationContextV1,
  personalLocalMachineIdSha256V1,
  personalLocalParityStorePathsV1,
  PersonalLocalParityStoreError,
  readStoredPersonalLocalParityAttestationV1,
  readVerifiedPersonalLocalParityRotationRecordV1,
  sealPersonalLocalParityRotationRecordV1,
  writePersonalLocalParityRotationRecordV1,
  type PersonalLocalParityRotationRecordV1,
} from "../local/tessera/personal-local-attestation-store";
import {
  buildTesseraParityCoveringSuiteV2,
} from "../local/tessera/provider-parity-covering-suite-v2";

const providerIdentitySha256 = "2".repeat(64);
const bundleId = "3".repeat(64);
const coveringSuite = buildTesseraParityCoveringSuiteV2({
  corpusInventorySha256: "4".repeat(64),
  factions: [
    {
      factionId: "adeptus-custodes",
      attackerMechanicIds: ["critical-hits"],
      defenderMechanicIds: ["feel-no-pain"],
    },
    {
      factionId: "world-eaters",
      attackerMechanicIds: ["sustained-melee"],
      defenderMechanicIds: ["invulnerable-save"],
    },
  ],
});
const coverageSuiteSha256 = coveringSuite.suiteSha256;

type Fixture = {
  root: string;
  storeDirectory: string;
  machineIdSha256: string;
  records: PersonalLocalParityRotationRecordV1[];
  recordPaths: string[];
};

function rotation(index: number): PersonalLocalParityRotationV1 {
  return {
    rotationId: `rotation-${index + 1}`,
    mode: index === 3 ? "enforce" : "observe",
    outcome: "pass",
    exactReceiptSha256: String(index + 5).repeat(64),
    coverageSuiteSha256,
    completedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
  };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-personal-parity-"),
  );
  const storeDirectory = path.join(root, "store");
  const machineIdSha256 = await personalLocalMachineIdSha256V1({
    directory: storeDirectory,
    create: true,
  });
  assert.ok(machineIdSha256);
  const records = [0, 1, 2, 3].map((index) =>
    sealPersonalLocalParityRotationRecordV1({
      machineIdSha256,
      providerIdentitySha256,
      bundleId,
      rotation: rotation(index),
      parityResultSha256: String.fromCharCode(97 + index).repeat(64),
      verifiedAt: new Date(
        Date.UTC(2026, 7, index + 1, 1),
      ).toISOString(),
    }),
  );
  const recordDirectory = path.join(root, "records");
  await mkdir(recordDirectory, { mode: 0o700 });
  const recordPaths = await Promise.all(
    records.map((record, index) =>
      writePersonalLocalParityRotationRecordV1({
        record,
        filename: path.join(
          recordDirectory,
          `rotation-${index + 1}.json`,
        ),
      }),
    ),
  );
  return {
    root,
    storeDirectory,
    machineIdSha256,
    records,
    recordPaths,
  };
}

test("personal parity store uses a private pseudonymous machine binding", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const paths = personalLocalParityStorePathsV1(item.storeDirectory);
  const secret = await readFile(paths.machineBindingPath, "utf8");
  const metadata = await lstat(paths.machineBindingPath);

  assert.match(secret, /^[0-9a-f]{64}\n$/);
  assert.match(item.machineIdSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(secret.trim(), item.machineIdSha256);
  assert.equal(metadata.mode & 0o077, 0);
  assert.doesNotMatch(
    secret,
    new RegExp(os.hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("four verified rotations atomically create and load an active attestation", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  await assert.rejects(
    createStoredPersonalLocalParityAttestationV1({
      rotationRecordPaths: item.recordPaths,
      coveringSuite,
      directory: item.storeDirectory,
      expectedBindings: {
        providerIdentitySha256: "9".repeat(64),
        bundleId,
        coverageSuiteSha256,
      },
    }),
    (error: unknown) =>
      error instanceof PersonalLocalParityStoreError &&
      error.code ===
        "PERSONAL_LOCAL_PARITY_CURRENT_BINDING_MISMATCH",
  );
  const created = await createStoredPersonalLocalParityAttestationV1({
    rotationRecordPaths: [...item.recordPaths].reverse(),
    coveringSuite,
    directory: item.storeDirectory,
    createdAt: new Date(Date.UTC(2026, 7, 5)).toISOString(),
  });
  assert.equal(created.evaluation.active, true);
  assert.deepEqual(
    created.attestation.rotations.map((entry) => entry.mode),
    ["observe", "observe", "observe", "enforce"],
  );

  const contextValue =
    await loadPersonalLocalParityAttestationContextV1({
      directory: item.storeDirectory,
      providerIdentitySha256,
      bundleId,
      coverageSuiteSha256,
    });
  assert.ok(contextValue);
  assert.equal(
    evaluatePersonalLocalParityAttestationV1(contextValue).active,
    true,
  );
  const status = await inspectPersonalLocalParityAttestationStoreV1({
    directory: item.storeDirectory,
  });
  assert.equal(status.present, true);
  assert.equal(status.selfVerified, true);
  assert.equal(status.machineBindingMatches, true);
  assert.equal(status.coveringSuiteVerified, true);
  assert.equal(status.coveringSuiteIssueCode, null);
  assert.equal(status.coveringSuitePath, created.coveringSuitePath);
  assert.equal("machineIdSha256" in status, false);

  const text = await readFile(created.path, "utf8");
  assert.equal(text, `${canonicalJson(created.attestation)}\n`);
  assert.equal(
    await readFile(created.coveringSuitePath, "utf8"),
    `${canonicalJson(coveringSuite)}\n`,
  );
  assert.equal(
    (await lstat(created.coveringSuitePath)).mode & 0o077,
    0,
  );
  assert.doesNotMatch(
    text,
    new RegExp(
      (await readFile(
        personalLocalParityStorePathsV1(item.storeDirectory)
          .machineBindingPath,
        "utf8",
      )).trim(),
    ),
  );
});

test("personal parity store rejects replay, tampering, unsafe permissions, and machine drift", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const replayed = structuredClone(item.records);
  replayed[1] = sealPersonalLocalParityRotationRecordV1({
    machineIdSha256: item.machineIdSha256,
    providerIdentitySha256,
    bundleId,
    rotation: {
      ...rotation(1),
      exactReceiptSha256: replayed[0].rotation.exactReceiptSha256,
    },
    parityResultSha256: "b".repeat(64),
    verifiedAt: new Date(Date.UTC(2026, 7, 2, 1)).toISOString(),
  });
  const replayPath = await writePersonalLocalParityRotationRecordV1({
    record: replayed[1],
    filename: path.join(item.root, "records", "replay.json"),
  });
  await assert.rejects(
    createStoredPersonalLocalParityAttestationV1({
      rotationRecordPaths: [
        item.recordPaths[0],
        replayPath,
        item.recordPaths[2],
        item.recordPaths[3],
      ],
      coveringSuite,
      directory: item.storeDirectory,
    }),
    (error: unknown) =>
      error instanceof PersonalLocalParityStoreError &&
      error.code === "PERSONAL_LOCAL_PARITY_REPLAY_REJECTED",
  );

  const created = await createStoredPersonalLocalParityAttestationV1({
    rotationRecordPaths: item.recordPaths,
    coveringSuite,
    directory: item.storeDirectory,
    createdAt: new Date(Date.UTC(2026, 7, 5)).toISOString(),
  });
  const changed = structuredClone(created.attestation);
  changed.bundleId = "9".repeat(64);
  await writeFile(created.path, `${canonicalJson(changed)}\n`);
  await assert.rejects(
    readStoredPersonalLocalParityAttestationV1({
      directory: item.storeDirectory,
    }),
    (error: unknown) =>
      error instanceof PersonalLocalParityStoreError &&
      error.code === "PERSONAL_LOCAL_PARITY_INTEGRITY_INVALID",
  );

  await writeFile(
    created.path,
    `${canonicalJson(created.attestation)}\n`,
  );
  await chmod(created.path, 0o644);
  await assert.rejects(
    readStoredPersonalLocalParityAttestationV1({
      directory: item.storeDirectory,
    }),
    (error: unknown) =>
      error instanceof PersonalLocalParityStoreError &&
      error.code === "PERSONAL_LOCAL_PARITY_PERMISSIONS_UNSAFE",
  );

  await chmod(created.path, 0o600);
  const machineBindingPath = personalLocalParityStorePathsV1(
    item.storeDirectory,
  ).machineBindingPath;
  await writeFile(machineBindingPath, `${"f".repeat(64)}\n`);
  const drifted = await loadPersonalLocalParityAttestationContextV1({
    directory: item.storeDirectory,
    providerIdentitySha256,
    bundleId,
    coverageSuiteSha256,
  });
  assert.ok(drifted);
  const evaluation = evaluatePersonalLocalParityAttestationV1(drifted);
  assert.equal(evaluation.active, false);
  assert.ok(
    evaluation.reasonCodes.includes(
      "PERSONAL_LOCAL_ATTESTATION_MACHINE_MISMATCH",
    ),
  );
});

test("legacy hash-only stores remain readable but cannot activate", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const created = await createStoredPersonalLocalParityAttestationV1({
    rotationRecordPaths: item.recordPaths,
    coveringSuite,
    directory: item.storeDirectory,
    createdAt: new Date(Date.UTC(2026, 7, 5)).toISOString(),
  });
  await rm(created.coveringSuitePath);

  const stored = await readStoredPersonalLocalParityAttestationV1({
    directory: item.storeDirectory,
  });
  assert.ok(stored);
  assert.equal(stored.coveringSuite, null);
  assert.equal(
    stored.coveringSuiteIssueCode,
    "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISSING",
  );
  const loaded = await loadPersonalLocalParityAttestationContextV1({
    directory: item.storeDirectory,
    providerIdentitySha256,
    bundleId,
    coverageSuiteSha256,
  });
  assert.ok(loaded);
  const evaluation = evaluatePersonalLocalParityAttestationV1(loaded);
  assert.equal(evaluation.active, false);
  assert.ok(
    evaluation.reasonCodes.includes(
      "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_MISSING",
    ),
  );
});

test("tampered or mismatched covering suites fail closed", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const mismatchedSuite = buildTesseraParityCoveringSuiteV2({
    corpusInventorySha256: "9".repeat(64),
    factions: coveringSuite.factions,
  });
  await assert.rejects(
    createStoredPersonalLocalParityAttestationV1({
      rotationRecordPaths: item.recordPaths,
      coveringSuite: mismatchedSuite,
      directory: item.storeDirectory,
    }),
    (error: unknown) =>
      error instanceof PersonalLocalParityStoreError &&
      error.code ===
        "PERSONAL_LOCAL_PARITY_COVERING_SUITE_MISMATCH",
  );
  const created = await createStoredPersonalLocalParityAttestationV1({
    rotationRecordPaths: item.recordPaths,
    coveringSuite,
    directory: item.storeDirectory,
    createdAt: new Date(Date.UTC(2026, 7, 5)).toISOString(),
  });
  await writeFile(created.coveringSuitePath, "{}\n");

  const loaded = await loadPersonalLocalParityAttestationContextV1({
    directory: item.storeDirectory,
    providerIdentitySha256,
    bundleId,
    coverageSuiteSha256,
  });
  assert.ok(loaded);
  const evaluation = evaluatePersonalLocalParityAttestationV1(loaded);
  assert.equal(evaluation.active, false);
  assert.ok(
    evaluation.reasonCodes.includes(
      "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_INVALID",
    ),
  );
  const status = await inspectPersonalLocalParityAttestationStoreV1({
    directory: item.storeDirectory,
  });
  assert.equal(status.coveringSuiteVerified, false);
  assert.equal(
    status.coveringSuiteIssueCode,
    "PERSONAL_LOCAL_ATTESTATION_COVERING_SUITE_INVALID",
  );
});

test("rotation readers refuse symbolic links", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const link = path.join(item.root, "records", "linked.json");
  await symlink(item.recordPaths[0], link);
  await assert.rejects(
    readVerifiedPersonalLocalParityRotationRecordV1(link),
  );
});

test("CLI advertises the explicit create and status operations", async () => {
  const source = await readFile(
    path.join(process.cwd(), "cli", "rosterpilot.ts"),
    "utf8",
  );
  assert.match(
    source,
    /tessera personal-attestation create --rotation[^\n]+--covering-suite/,
  );
  assert.match(
    source,
    /tessera personal-attestation status \[--covering-suite/,
  );
  assert.match(
    source,
    /createStoredPersonalLocalParityAttestationV1/,
  );
  assert.doesNotMatch(
    source,
    /tessera personal-attestation[^\n]+--coverage-suite-sha256/,
  );
});
