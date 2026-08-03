import assert from "node:assert/strict";
import crypto from "node:crypto";
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

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  buildRoster,
  exportRoster,
  inspectEnrichedRosz,
  type ConnectorEvent,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import {
  beginNewRecruitMutationReceipt,
  newRecruitRoszMutationSubject,
  readNewRecruitRoszMutationReceipt,
  newRecruitCacheKey,
  readNewRecruitMutationReceipt,
  readNewRecruitRunInventory,
  reconcileNewRecruitMutationReceipt,
  reconcileNewRecruitRoszMutationReceipt,
  recordNewRecruitReuseReceipt,
  restoreNewRecruitMutationArtifactFromTesseraRun,
  storeNewRecruitCache,
  storeNewRecruitProvisionalArtifact,
} from "../local/new-recruit/cache";
import {
  deliverRosterToNewRecruit,
  enrichRoszThroughNewRecruit,
} from "../local/new-recruit/companion";
import { prepareRosterForTessera } from "../local/tessera/companion";
import {
  createWorkflowReliabilityEventStore,
  resolveWorkflowReliabilityIdentity,
} from "../local/reliability";

function roster(
  faction = "adeptus-custodes",
): RosterDraftV1 {
  const built = buildRoster({
    faction,
    pointsLimit: 500,
    name: `Mutation receipt ${faction}`,
  });
  assert.ok(built.data);
  return built.data;
}

function connectorEvent(input: {
  id: string;
  origin: ConnectorEvent["origin"];
  outcome: ConnectorEvent["outcome"];
  remoteId?: string | null;
}): ConnectorEvent {
  return {
    schemaVersion: 1,
    eventId: input.id,
    recordedAt: new Date().toISOString(),
    provider: "new-recruit",
    action: "prepare",
    origin: input.origin,
    outcome: input.outcome,
    remoteId: input.remoteId ?? null,
    contentSha256: "a".repeat(64),
  };
}

function delivery(input: {
  roster: RosterDraftV1;
  event: ConnectorEvent;
  imported: boolean;
  cacheReused?: boolean;
}): ResultEnvelope<NewRecruitDelivery> {
  return {
    ok: true,
    data: {
      rosterId: input.roster.id,
      rosterName: input.roster.name,
      listUrl: input.event.remoteId,
      imported: input.imported,
      sessionReused: input.imported === false,
      cacheReused: input.cacheReused,
      connectorEvents: [input.event],
      verification: null,
      enrichedSummary: null,
      artifacts: [],
    },
    violations: [],
    warnings: [],
  };
}

function enrichedRosz(
  source: Uint8Array,
  options: { gameSystemRevision?: number } = {},
): Uint8Array {
  const entries = unzipSync(source);
  const [filename, bytes] = Object.entries(entries)[0];
  const profiles =
    '<profiles><profile name="Fixture model" typeName="Unit"/><profile name="Fixture weapon" typeName="Ranged Weapons"/></profiles>';
  let selectionDepth = 0;
  let xml = strFromU8(bytes)
    .replace(
      'generatedBy="RosterPilot"',
      'generatedBy="https://newrecruit.eu"',
    )
    .replace(
      /<selection\b[^>]*>|<\/selection>/g,
      (token) => {
        if (token === "</selection>") {
          selectionDepth -= 1;
          return token;
        }
        const topLevelUnit =
          selectionDepth === 0 &&
          /\btype="(?:unit|model)"/.test(token);
        const selfClosing = token.endsWith("/>");
        if (selfClosing) {
          return topLevelUnit
            ? `${token.slice(0, -2)}>${profiles}</selection>`
            : token;
        }
        selectionDepth += 1;
        return topLevelUnit ? `${token}${profiles}` : token;
      },
    );
  if (options.gameSystemRevision !== undefined) {
    xml = xml.replace(
      /gameSystemRevision="\d+"/,
      `gameSystemRevision="${options.gameSystemRevision}"`,
    );
  }
  return zipSync({ [filename]: strToU8(xml) });
}

async function withSupportDirectory(
  label: string,
  run: (supportDirectory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `${label}-`),
  );
  const prior = process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
  process.env.ROSTERPILOT_SUPPORT_DIRECTORY = path.join(
    directory,
    "support",
  );
  try {
    await run(process.env.ROSTERPILOT_SUPPORT_DIRECTORY);
  } finally {
    if (prior === undefined) {
      delete process.env.ROSTERPILOT_SUPPORT_DIRECTORY;
    } else {
      process.env.ROSTERPILOT_SUPPORT_DIRECTORY = prior;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function receiptFilename(
  supportDirectory: string,
  candidate: RosterDraftV1,
): string {
  return path.join(
    supportDirectory,
    "cache",
    "new-recruit",
    "v1",
    "mutation-receipts",
    `${newRecruitCacheKey(candidate)}.json`,
  );
}

function receiptLockOwnerFilename(
  supportDirectory: string,
  candidate: RosterDraftV1,
): string {
  return path.join(
    supportDirectory,
    "cache",
    "new-recruit",
    "v1",
    "mutation-receipts",
    "locks",
    newRecruitCacheKey(candidate),
    "owner.json",
  );
}

async function seedLegacyStrictDriftMisclassification(input: {
  roster: RosterDraftV1;
  supportDirectory: string;
  uncertainContentSha256?: string;
}): Promise<{
  sourceSha256: string;
  enrichedSha256: string;
  verifiedEvent: ConnectorEvent;
}> {
  const exported = await exportRoster(input.roster, "rosz");
  assert.ok(exported.ok && exported.data);
  assert.notEqual(typeof exported.data.content, "string");
  const source = exported.data.content as Uint8Array;
  const enriched = enrichedRosz(source, {
    gameSystemRevision:
      input.roster.sourceData.newRecruit.gameSystemRevision + 1,
  });
  const sourceSha256 = crypto
    .createHash("sha256")
    .update(source)
    .digest("hex");
  const enrichedSha256 = crypto
    .createHash("sha256")
    .update(enriched)
    .digest("hex");
  const artifactDirectory = path.join(
    input.supportDirectory,
    "legacy-strict-drift",
  );
  await mkdir(artifactDirectory, { recursive: true });
  const sourcePath = path.join(artifactDirectory, "source.rosz");
  const enrichedPath = path.join(
    artifactDirectory,
    "enriched.rosz",
  );
  await Promise.all([
    writeFile(sourcePath, source),
    writeFile(enrichedPath, enriched),
  ]);
  const verifiedEvent: ConnectorEvent = {
    schemaVersion: 1,
    eventId: "legacy-strict-drift-event",
    recordedAt: new Date().toISOString(),
    provider: "new-recruit",
    action: "prepare",
    origin: "new-remote",
    outcome: "verified",
    remoteId:
      "https://www.newrecruit.eu/app/Lists/legacy-strict-drift",
    contentSha256: enrichedSha256,
  };
  const transaction = await beginNewRecruitMutationReceipt({
    roster: input.roster,
    runId: "legacy-strict-drift-run",
  });
  const strictDelivery: ResultEnvelope<NewRecruitDelivery> = {
    ok: false,
    data: {
      rosterId: input.roster.id,
      rosterName: input.roster.name,
      listUrl: verifiedEvent.remoteId,
      imported: true,
      sessionReused: false,
      cacheReused: false,
      connectorEvents: [verifiedEvent],
      verification: null,
      enrichedSummary: inspectEnrichedRosz(enriched),
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: "source.rosz",
          mimeType: "application/zip",
          written: sourcePath,
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: "enriched.rosz",
          mimeType: "application/zip",
          written: enrichedPath,
        },
      ],
    },
    violations: [
      {
        code: "NEW_RECRUIT_CATALOGUE_DRIFT",
        message:
          "The verified upload used the next game-system revision.",
        severity: "error",
      },
    ],
    warnings: [],
  };
  await storeNewRecruitProvisionalArtifact(
    input.roster,
    strictDelivery,
  );
  await transaction.finalize({
    outcome: "uncertain",
    connectorEvent: {
      ...verifiedEvent,
      outcome: "uncertain",
      contentSha256:
        input.uncertainContentSha256 ?? enrichedSha256,
    },
    message:
      "A legacy Tessera wrapper downgraded the verified upload after strict catalogue drift.",
  });
  return { sourceSha256, enrichedSha256, verifiedEvent };
}

test("New Recruit writes a sealed pending receipt before browser activity", async () => {
  await withSupportDirectory(
    "new-recruit-pending-receipt",
    async (supportDirectory) => {
      const candidate = roster();
      const transaction =
        await beginNewRecruitMutationReceipt({
          roster: candidate,
          runId: "pending-run",
          expectedSourceRoszSha256: "b".repeat(64),
        });
      const receipt = JSON.parse(
        await readFile(
          receiptFilename(supportDirectory, candidate),
          "utf8",
        ),
      ) as {
        integritySha256: string;
        attempts: Array<{
          runId: string;
          outcome: string;
          expectedSourceRoszSha256: string;
        }>;
      };
      assert.match(receipt.integritySha256, /^[0-9a-f]{64}$/);
      assert.equal(receipt.attempts.length, 1);
      assert.equal(receipt.attempts[0].runId, "pending-run");
      assert.equal(receipt.attempts[0].outcome, "pending");
      assert.equal(
        receipt.attempts[0].expectedSourceRoszSha256,
        "b".repeat(64),
      );

      const ownerFilename = receiptLockOwnerFilename(
        supportDirectory,
        candidate,
      );
      const owner = JSON.parse(
        await readFile(ownerFilename, "utf8"),
      ) as Record<string, unknown>;
      owner.pid = 2_147_483_647;
      await writeFile(
        ownerFilename,
        `${JSON.stringify(owner, null, 2)}\n`,
      );
      await reconcileNewRecruitMutationReceipt({
        roster: candidate,
        runId: "pending-run",
        attemptId: transaction.attemptId,
        resolution: {
          outcome: "not-created",
          connectorEvent: null,
          message:
            "Recovery inspection proved the interrupted browser never created a list.",
        },
      });
      assert.equal(
        (await readNewRecruitMutationReceipt(candidate))
          ?.attempts[0].outcome,
        "not-created",
      );
    },
  );
});

test("created-artifact retention failure seals evidence and releases its lease", async () => {
  await withSupportDirectory(
    "new-recruit-retention-failure",
    async (supportDirectory) => {
      const candidate = roster();
      const exported = await exportRoster(candidate, "rosz");
      assert.ok(exported.ok && exported.data);
      const source = Buffer.from(exported.data.content);
      const enriched = enrichedRosz(source);
      const sourcePath = path.join(supportDirectory, "source.rosz");
      await mkdir(supportDirectory, { recursive: true });
      await writeFile(sourcePath, source);
      const sourceSha256 = crypto
        .createHash("sha256")
        .update(source)
        .digest("hex");
      const event = connectorEvent({
        id: "retention-failure-event",
        origin: "new-remote",
        outcome: "verified",
        remoteId:
          "https://www.newrecruit.eu/app/Lists/retention-failure",
      });
      event.contentSha256 = crypto
        .createHash("sha256")
        .update(enriched)
        .digest("hex");
      const transaction =
        await beginNewRecruitMutationReceipt({
          roster: candidate,
          runId: "retention-failure-run",
          expectedSourceRoszSha256: sourceSha256,
        });
      const result = delivery({
        roster: candidate,
        event,
        imported: true,
      });
      assert.ok(result.data);
      result.data.enrichedSummary = inspectEnrichedRosz(enriched);
      result.data.artifacts = [
        {
          format: "rosterpilot-source-rosz",
          filename: "source.rosz",
          mimeType: "application/zip",
          written: sourcePath,
        },
      ];
      await assert.rejects(
        transaction.finalizeDelivery(result),
        (error: unknown) =>
          Boolean(
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code ===
                "NEW_RECRUIT_MUTATION_ARTIFACT_REQUIRED",
          ),
      );
      const receipt =
        await readNewRecruitMutationReceipt(candidate);
      assert.equal(receipt?.attempts[0]?.outcome, "created");
      assert.equal(
        receipt?.attempts[0]?.recoveryArtifact,
        null,
      );
      await assert.rejects(
        readFile(
          receiptLockOwnerFilename(
            supportDirectory,
            candidate,
          ),
          "utf8",
        ),
        (error: unknown) =>
          Boolean(
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT",
          ),
      );
      await assert.rejects(
        beginNewRecruitMutationReceipt({
          roster: candidate,
          runId: "must-not-redeliver",
        }),
        (error: unknown) =>
          Boolean(
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code ===
                "NEW_RECRUIT_MUTATION_ALREADY_CREATED",
          ),
      );
    },
  );
});

test("public delivery owns the durable mutation boundary and records no-import reuse", async () => {
  await withSupportDirectory(
    "new-recruit-direct-boundary",
    async () => {
      const candidate = roster();
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "new-recruit-direct-boundary-out-"),
      );
      try {
        const result = await deliverRosterToNewRecruit(
          candidate,
          {
            outputDirectory: directory,
            allowOutsideRoot: true,
            downloadEnrichedRosz: false,
            downloadPrettyHtml: false,
            mutationRunId: "direct-boundary-run",
          },
          {
            platform: "darwin",
            browserAvailable: true,
            agentDeliver: async () => {
              const pending =
                await readNewRecruitMutationReceipt(candidate);
              assert.equal(
                pending?.attempts.at(-1)?.runId,
                "direct-boundary-run",
              );
              assert.equal(
                pending?.attempts.at(-1)?.outcome,
                "pending",
              );
              return {
                worker: {
                  ok: true,
                  uiIdentity: "c".repeat(64),
                  imported: false,
                  sessionReused: true,
                  listUrl:
                    "https://www.newrecruit.eu/app/Lists/existing",
                  verification: {
                    name: true,
                    faction: true,
                    points: true,
                    units: [],
                    mismatches: [],
                  },
                },
              };
            },
          },
        );
        assert.equal(result.ok, true);
        assert.equal(
          result.data?.connectorEvents?.at(-1)?.outcome,
          "reused",
        );
        assert.equal(
          (await readNewRecruitMutationReceipt(candidate))
            ?.attempts.at(-1)?.outcome,
          "reused",
        );
        assert.ok(
          (await readNewRecruitRunInventory()).entries.some(
            (entry) =>
              entry.runId === "direct-boundary-run" &&
              entry.outcome === "reused",
          ),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test("cache persistence reuses the authoritative receipt inventory attempt", async () => {
  await withSupportDirectory(
    "new-recruit-authoritative-attempt",
    async () => {
      const candidate = roster("chaos-space-marines");
      const exported = await exportRoster(candidate, "rosz");
      assert.ok(exported.ok && exported.data);
      assert.notEqual(typeof exported.data.content, "string");
      const source = exported.data.content as Uint8Array;
      const enriched = enrichedRosz(source);
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "new-recruit-authoritative-out-"),
      );
      try {
        const sourcePath = path.join(directory, "source.rosz");
        const enrichedPath = path.join(
          directory,
          "enriched.rosz",
        );
        await Promise.all([
          writeFile(sourcePath, source),
          writeFile(enrichedPath, enriched),
        ]);
        const event = connectorEvent({
          id: "authoritative-created-event",
          origin: "new-remote",
          outcome: "verified",
          remoteId:
            "https://www.newrecruit.eu/app/Lists/authoritative",
        });
        event.contentSha256 = crypto
          .createHash("sha256")
          .update(enriched)
          .digest("hex");
        const result: ResultEnvelope<NewRecruitDelivery> = {
          ok: true,
          data: {
            rosterId: candidate.id,
            rosterName: candidate.name,
            listUrl: event.remoteId,
            imported: true,
            sessionReused: false,
            connectorEvents: [event],
            verification: null,
            enrichedSummary: inspectEnrichedRosz(enriched),
            artifacts: [
              {
                format: "rosterpilot-source-rosz",
                filename: "source.rosz",
                mimeType: "application/zip",
                written: sourcePath,
              },
              {
                format: "new-recruit-enriched-rosz",
                filename: "enriched.rosz",
                mimeType: "application/zip",
                written: enrichedPath,
              },
            ],
          },
          violations: [],
          warnings: [],
        };
        const transaction =
          await beginNewRecruitMutationReceipt({
            roster: candidate,
            runId: "authoritative-attempt-run",
          });
        await transaction.finalizeDelivery(result);
        await storeNewRecruitCache(candidate, result, {
          runId: "authoritative-attempt-run",
          mutationAttemptId: null,
        });
        const entries = (
          await readNewRecruitRunInventory()
        ).entries.filter(
          (entry) =>
            entry.connectorEventId === event.eventId,
        );
        assert.equal(entries.length, 1);
        assert.equal(
          entries[0].attemptId,
          transaction.attemptId,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test("safe direct-delivery preflight failures create no mutation receipt", async () => {
  await withSupportDirectory(
    "new-recruit-safe-preflight",
    async () => {
      const candidate = roster("aeldari");
      let agentCalls = 0;
      const result = await deliverRosterToNewRecruit(
        candidate,
        {
          outputDirectory: path.join(
            os.tmpdir(),
            "new-recruit-safe-preflight-unused",
          ),
          allowOutsideRoot: true,
          downloadEnrichedRosz: false,
          downloadPrettyHtml: false,
          mutationRunId: "safe-preflight-run",
        },
        {
          platform: "darwin",
          browserAvailable: false,
          agentDeliver: async () => {
            agentCalls += 1;
            throw new Error("must not dispatch");
          },
        },
      );
      assert.equal(result.ok, false);
      assert.equal(
        result.violations[0]?.code,
        "COMPANION_UNAVAILABLE",
      );
      assert.equal(agentCalls, 0);
      assert.equal(
        await readNewRecruitMutationReceipt(candidate),
        null,
      );
      assert.equal(
        (await readNewRecruitRunInventory()).entries.length,
        0,
      );

      const collisionCandidate = roster("space-marines");
      const exported = await exportRoster(
        collisionCandidate,
        "rosz",
      );
      assert.ok(exported.ok && exported.data);
      const collisionDirectory = await mkdtemp(
        path.join(
          os.tmpdir(),
          "new-recruit-safe-collision-out-",
        ),
      );
      try {
        await writeFile(
          path.join(
            collisionDirectory,
            exported.data.filename,
          ),
          "existing",
        );
        const collision =
          await deliverRosterToNewRecruit(
            collisionCandidate,
            {
              outputDirectory: collisionDirectory,
              allowOutsideRoot: true,
              downloadEnrichedRosz: false,
              downloadPrettyHtml: false,
              mutationRunId: "safe-collision-run",
            },
            {
              platform: "darwin",
              browserAvailable: true,
              agentDeliver: async () => {
                agentCalls += 1;
                throw new Error("must not dispatch");
              },
            },
          );
        assert.equal(collision.ok, false);
        assert.equal(
          collision.violations[0]?.code,
          "FILE_COLLISION",
        );
        assert.equal(agentCalls, 0);
        assert.equal(
          await readNewRecruitMutationReceipt(
            collisionCandidate,
          ),
          null,
        );
      } finally {
        await rm(collisionDirectory, {
          recursive: true,
          force: true,
        });
      }
    },
  );
});

test("uploaded profileless ROSZ uses a content-addressed durable mutation subject", async () => {
  await withSupportDirectory(
    "new-recruit-uploaded-rosz-subject",
    async () => {
      const candidate = roster("orks");
      const exported = await exportRoster(candidate, "rosz");
      assert.ok(exported.ok && exported.data);
      assert.notEqual(typeof exported.data.content, "string");
      const source = exported.data.content as Uint8Array;
      assert.equal(inspectEnrichedRosz(source).profileCount, 0);
      const subject = newRecruitRoszMutationSubject({
        content: source,
        rosterName: candidate.name,
      });
      const enriched = enrichedRosz(source);
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "new-recruit-uploaded-rosz-out-"),
      );
      const sourcePath = path.join(directory, "uploaded.rosz");
      await writeFile(sourcePath, source);
      let agentCalls = 0;
      try {
        const result = await enrichRoszThroughNewRecruit(
          sourcePath,
          {
            outputDirectory: path.join(directory, "enriched"),
            allowOutsideRoot: true,
            mutationRunId: "uploaded-rosz-run",
          },
          {
            platform: "darwin",
            browserAvailable: true,
            agentDeliver: async () => {
              agentCalls += 1;
              const pending =
                await readNewRecruitRoszMutationReceipt(
                  subject,
                );
              assert.equal(
                pending?.attempts.at(-1)?.runId,
                "uploaded-rosz-run",
              );
              assert.equal(
                pending?.attempts.at(-1)?.outcome,
                "pending",
              );
              return {
                worker: {
                  ok: true,
                  uiIdentity: "d".repeat(64),
                  imported: true,
                  sessionReused: false,
                  listUrl:
                    "https://www.newrecruit.eu/app/Lists/uploaded",
                  verification: {
                    name: true,
                    faction: true,
                    points: true,
                    units: [],
                    mismatches: [],
                  },
                },
                enrichedRoszBase64:
                  Buffer.from(enriched).toString("base64"),
              };
            },
          },
        );
        assert.equal(
          result.ok,
          true,
          result.violations
            .map((issue) => issue.message)
            .join("\n"),
        );
        const receipt =
          await readNewRecruitRoszMutationReceipt(subject);
        assert.equal(receipt?.schemaVersion, 2);
        assert.equal(
          receipt?.attempts.at(-1)?.outcome,
          "created",
        );
        assert.ok(
          receipt?.attempts.at(-1)?.recoveryArtifact,
        );
        assert.ok(
          (await readNewRecruitRunInventory()).entries.some(
            (entry) =>
              entry.runId === "uploaded-rosz-run" &&
              entry.cacheKey === subject.cacheKey &&
              entry.executionFingerprint === null &&
              entry.outcome === "created",
          ),
        );
        await rm(result.data!.enrichedRoszPath, { force: true });
        const reused = await enrichRoszThroughNewRecruit(
          sourcePath,
          {
            outputDirectory: path.join(directory, "enriched"),
            allowOutsideRoot: true,
            mutationRunId: "uploaded-rosz-reuse",
          },
          {
            platform: "linux",
            browserAvailable: false,
            agentDeliver: async () => {
              agentCalls += 1;
              throw new Error(
                "uploaded ROSZ recovery must not redeliver",
              );
            },
          },
        );
        assert.equal(reused.ok, true);
        assert.ok(
          reused.warnings.some(
            (warning) =>
              warning.code ===
              "NEW_RECRUIT_MUTATION_ARTIFACT_REUSED",
          ),
        );
        assert.equal(agentCalls, 1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test("worker evidence is sealed before uploaded ROSZ verification can fail", async () => {
  await withSupportDirectory(
    "new-recruit-uploaded-evidence",
    async () => {
      const candidate = roster("tyranids");
      const exported = await exportRoster(candidate, "rosz");
      assert.ok(exported.ok && exported.data);
      assert.notEqual(typeof exported.data.content, "string");
      const source = exported.data.content as Uint8Array;
      const subject = newRecruitRoszMutationSubject({
        content: source,
        rosterName: candidate.name,
      });
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "new-recruit-uploaded-evidence-out-"),
      );
      const sourcePath = path.join(directory, "uploaded.rosz");
      await writeFile(sourcePath, source);
      try {
        const result = await enrichRoszThroughNewRecruit(
          sourcePath,
          {
            outputDirectory: path.join(directory, "enriched"),
            allowOutsideRoot: true,
            mutationRunId: "uploaded-evidence-run",
          },
          {
            platform: "darwin",
            browserAvailable: true,
            agentDeliver: async () => ({
              worker: {
                ok: true,
                uiIdentity: "e".repeat(64),
                imported: true,
                sessionReused: false,
                listUrl:
                  "https://www.newrecruit.eu/app/Lists/observed",
                verification: {
                  name: true,
                  faction: true,
                  points: true,
                  units: [],
                  mismatches: [],
                },
              },
              enrichedRoszBase64:
                Buffer.from("invalid-enriched-rosz").toString(
                  "base64",
                ),
            }),
          },
        );
        assert.equal(result.ok, false);
        const attempt = (
          await readNewRecruitRoszMutationReceipt(subject)
        )?.attempts.at(-1);
        assert.equal(attempt?.outcome, "uncertain");
        assert.equal(
          attempt?.connectorEvent?.remoteId,
          "https://www.newrecruit.eu/app/Lists/observed",
        );
        assert.equal(
          attempt?.connectorEvent?.outcome,
          "uncertain",
        );
        await reconcileNewRecruitRoszMutationReceipt({
          subject,
          runId: "uploaded-evidence-run",
          attemptId: attempt?.attemptId,
          resolution: {
            outcome: "not-created",
            connectorEvent: null,
            message:
              "Guided saved-list inspection proved the observed import was not retained.",
          },
        });
        assert.equal(
          (
            await readNewRecruitRoszMutationReceipt(
              subject,
            )
          )?.attempts.at(-1)?.outcome,
          "not-created",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test("Tessera preparation seals mutation receipts before delivery and records cache reuse by run", async () => {
  await withSupportDirectory(
    "new-recruit-tessera-transaction",
    async () => {
      const candidate = roster();
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "new-recruit-tessera-delivery-"),
      );
      let deliveryCalls = 0;
      const deliver = async (
        deliveredRoster: RosterDraftV1,
        options: NewRecruitDeliveryOptions = {},
      ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
        deliveryCalls += 1;
        const pending =
          await readNewRecruitMutationReceipt(deliveredRoster);
        assert.equal(
          pending?.attempts.at(-1)?.runId,
          "tessera-transaction-run",
        );
        assert.equal(
          pending?.attempts.at(-1)?.outcome,
          "pending",
          "the durable pending receipt must exist before the delivery adapter runs",
        );
        const exported = await exportRoster(
          deliveredRoster,
          "rosz",
        );
        assert.ok(exported.ok && exported.data);
        assert.notEqual(typeof exported.data.content, "string");
        const source = exported.data.content as Uint8Array;
        const enriched = enrichedRosz(source);
        const outputDirectory =
          options.outputDirectory ?? directory;
        await mkdir(outputDirectory, { recursive: true });
        const sourcePath = path.join(
          outputDirectory,
          "source.rosz",
        );
        const enrichedPath = path.join(
          outputDirectory,
          "enriched.rosz",
        );
        await Promise.all([
          writeFile(sourcePath, source),
          writeFile(enrichedPath, enriched),
        ]);
        const event: ConnectorEvent = {
          schemaVersion: 1,
          eventId: "tessera-created-event",
          recordedAt: new Date().toISOString(),
          provider: "new-recruit",
          action: "prepare",
          origin: "new-remote",
          outcome: "verified",
          remoteId:
            "https://www.newrecruit.eu/app/Lists/tessera-created",
          contentSha256: crypto
            .createHash("sha256")
            .update(enriched)
            .digest("hex"),
        };
        return {
          ok: true,
          data: {
            rosterId: deliveredRoster.id,
            rosterName: deliveredRoster.name,
            listUrl: event.remoteId,
            imported: true,
            sessionReused: false,
            connectorEvents: [event],
            verification: null,
            enrichedSummary: inspectEnrichedRosz(enriched),
            artifacts: [
              {
                format: "rosterpilot-source-rosz",
                filename: "source.rosz",
                mimeType: "application/zip",
                written: sourcePath,
              },
              {
                format: "new-recruit-enriched-rosz",
                filename: "enriched.rosz",
                mimeType: "application/zip",
                written: enrichedPath,
              },
            ],
          },
          violations: [],
          warnings: [],
        };
      };
      try {
        const first = await prepareRosterForTessera(
          candidate,
          {
            outputDirectory: path.join(directory, "first"),
            allowOutsideRoot: true,
            mutationRunId: "tessera-transaction-run",
          },
          {
            deliver,
            persistentCacheDelivery: true,
          },
        );
        assert.equal(
          first.ok,
          true,
          first.violations.map((issue) => issue.message).join("\n"),
        );
        assert.equal(deliveryCalls, 1);
        assert.equal(
          (await readNewRecruitMutationReceipt(candidate))
            ?.attempts.at(-1)?.outcome,
          "created",
        );
        assert.ok(
          (await readNewRecruitRunInventory())
            .entries.some(
              (event) =>
                event.runId === "tessera-transaction-run" &&
                event.outcome === "created",
            ),
        );

        const reused = await prepareRosterForTessera(
          candidate,
          {
            outputDirectory: path.join(directory, "second"),
            allowOutsideRoot: true,
            mutationRunId: "tessera-reuse-run",
          },
          {
            deliver,
            persistentCacheDelivery: true,
          },
        );
        assert.equal(reused.ok, true);
        assert.equal(reused.data?.cacheReused, true);
        assert.equal(deliveryCalls, 1);
        assert.ok(
          (await readNewRecruitRunInventory())
            .entries.some(
              (event) =>
                event.runId === "tessera-reuse-run" &&
                event.outcome === "reused",
            ),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test("a sealed provisional artifact repairs the legacy strict-drift misclassification before diagnostic reuse", async () => {
  await withSupportDirectory(
    "new-recruit-legacy-strict-drift-repair",
    async (supportDirectory) => {
      const candidate = roster();
      const seeded = await seedLegacyStrictDriftMisclassification({
        roster: candidate,
        supportDirectory,
      });
      assert.equal(
        (await readNewRecruitMutationReceipt(candidate))
          ?.attempts[0]?.outcome,
        "uncertain",
      );
      let deliveryCalls = 0;
      const dependencies = {
        runtimeIssue: () => null,
        persistentCacheDelivery: true,
        deliver: async () => {
          deliveryCalls += 1;
          throw new Error(
            "the sealed provisional artifact must prevent redelivery",
          );
        },
      };
      const strict = await prepareRosterForTessera(
        candidate,
        {
          outputDirectory: path.join(
            supportDirectory,
            "strict-recheck",
          ),
          allowOutsideRoot: true,
          mutationRunId: "legacy-strict-drift-recheck-run",
        },
        dependencies,
      );
      assert.equal(strict.ok, false);
      assert.equal(
        strict.violations[0]?.code,
        "NEW_RECRUIT_CATALOGUE_DRIFT",
      );
      assert.equal(strict.data?.cacheReused, true);
      assert.equal(deliveryCalls, 0);

      const prepared = await prepareRosterForTessera(
        candidate,
        {
          outputDirectory: path.join(
            supportDirectory,
            "diagnostic-reuse",
          ),
          allowOutsideRoot: true,
          mutationRunId: "legacy-strict-drift-diagnostic-run",
          catalogueDriftMode: "diagnostic",
        },
        dependencies,
      );
      assert.equal(
        prepared.ok,
        true,
        prepared.violations.map((issue) => issue.message).join("\n"),
      );
      assert.equal(prepared.data?.cacheReused, true);
      assert.equal(deliveryCalls, 0);
      assert.ok(
        prepared.warnings.some(
          (warning) =>
            warning.code ===
            "NEW_RECRUIT_PROVISIONAL_CACHE_REUSED",
        ),
      );

      const repaired = await readNewRecruitMutationReceipt(candidate);
      assert.equal(repaired?.attempts.length, 3);
      assert.equal(repaired?.attempts[0]?.outcome, "created");
      assert.equal(
        repaired?.attempts[0]?.connectorEvent?.outcome,
        "verified",
      );
      assert.equal(
        repaired?.attempts[0]?.connectorEvent?.eventId,
        seeded.verifiedEvent.eventId,
      );
      assert.equal(
        repaired?.attempts[0]?.expectedSourceRoszSha256,
        seeded.sourceSha256,
      );
      assert.equal(
        repaired?.attempts[0]?.recoveryArtifact
          ?.enrichedRoszSha256,
        seeded.enrichedSha256,
      );
      assert.equal(repaired?.attempts[1]?.outcome, "reused");
      assert.equal(
        repaired?.attempts[1]?.runId,
        "legacy-strict-drift-recheck-run",
      );
      assert.equal(repaired?.attempts[2]?.outcome, "reused");
      assert.equal(
        repaired?.attempts[2]?.runId,
        "legacy-strict-drift-diagnostic-run",
      );
      assert.deepEqual(
        (await readNewRecruitRunInventory()).entries.map(
          (entry) => ({
            runId: entry.runId,
            outcome: entry.outcome,
          }),
        ),
        [
          {
            runId: "legacy-strict-drift-run",
            outcome: "created",
          },
          {
            runId: "legacy-strict-drift-recheck-run",
            outcome: "reused",
          },
          {
            runId: "legacy-strict-drift-diagnostic-run",
            outcome: "reused",
          },
        ],
      );
    },
  );
});

test("provisional recovery leaves nonmatching uncertain mutations blocked", async () => {
  await withSupportDirectory(
    "new-recruit-legacy-strict-drift-conflict",
    async (supportDirectory) => {
      const candidate = roster();
      await seedLegacyStrictDriftMisclassification({
        roster: candidate,
        supportDirectory,
        uncertainContentSha256: "f".repeat(64),
      });
      let deliveryCalls = 0;
      const prepared = await prepareRosterForTessera(
        candidate,
        {
          outputDirectory: path.join(
            supportDirectory,
            "blocked-diagnostic",
          ),
          allowOutsideRoot: true,
          mutationRunId: "blocked-diagnostic-run",
          catalogueDriftMode: "diagnostic",
        },
        {
          runtimeIssue: () => null,
          persistentCacheDelivery: true,
          deliver: async () => {
            deliveryCalls += 1;
            throw new Error("a conflicted receipt must not redeliver");
          },
        },
      );
      assert.equal(prepared.ok, false);
      assert.equal(
        prepared.violations[0]?.code,
        "NEW_RECRUIT_MUTATION_RECONCILIATION_REQUIRED",
      );
      assert.equal(deliveryCalls, 0);
      const receipt = await readNewRecruitMutationReceipt(candidate);
      assert.equal(receipt?.attempts.length, 1);
      assert.equal(receipt?.attempts[0]?.outcome, "uncertain");
      assert.equal(
        (await readNewRecruitRunInventory()).entries.length,
        0,
      );
    },
  );
});

test("uncertain receipts block redelivery until guided reconciliation", async () => {
  await withSupportDirectory(
    "new-recruit-reconcile-receipt",
    async (supportDirectory) => {
      const candidate = roster("aeldari");
      const first = await beginNewRecruitMutationReceipt({
        roster: candidate,
        runId: "uncertain-run",
      });
      await first.finalize({
        outcome: "uncertain",
        connectorEvent: connectorEvent({
          id: "uncertain-event",
          origin: "new-remote",
          outcome: "uncertain",
          remoteId:
            "https://www.newrecruit.eu/app/Lists/uncertain",
        }),
        message: "The browser response was lost.",
      });
      const reliabilityRoot = path.join(supportDirectory, "reliability");
      const reliabilityStore = createWorkflowReliabilityEventStore({
        rootDirectory: reliabilityRoot,
      });
      const uncertainHistory = await reliabilityStore.history({
        workflowId: "uncertain-run",
        workflowKind: "new-recruit-mutation",
      });
      assert.equal(uncertainHistory.verification.ok, true);
      assert.equal(uncertainHistory.events.length, 1);
      assert.equal(uncertainHistory.events[0]?.outcome, "inconclusive");
      assert.deepEqual(
        await resolveWorkflowReliabilityIdentity(
          { kind: "new-recruit-run-id", value: "uncertain-run" },
          { rootDirectory: reliabilityRoot },
        ),
        {
          workflowId: "uncertain-run",
          workflowKind: "new-recruit-mutation",
        },
      );

      await assert.rejects(
        beginNewRecruitMutationReceipt({
          roster: candidate,
          runId: "blocked-run",
        }),
        (error: unknown) =>
          Boolean(
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code ===
                "NEW_RECRUIT_MUTATION_RECONCILIATION_REQUIRED",
          ),
      );

      await reconcileNewRecruitMutationReceipt({
        roster: candidate,
        runId: "uncertain-run",
        attemptId: first.attemptId,
        resolution: {
          outcome: "not-created",
          connectorEvent: null,
          message:
            "A guided saved-list inspection proved no list was created.",
        },
      });
      const reconciledHistory = await reliabilityStore.history({
        workflowId: "uncertain-run",
        workflowKind: "new-recruit-mutation",
      });
      assert.equal(reconciledHistory.verification.ok, true);
      assert.equal(reconciledHistory.events.length, 2);
      assert.equal(reconciledHistory.events[1]?.outcome, "recovered");
      const retry = await beginNewRecruitMutationReceipt({
        roster: candidate,
        runId: "retry-run",
      });
      const exported = await exportRoster(candidate, "rosz");
      assert.ok(exported.ok && exported.data);
      const source = Buffer.from(exported.data.content);
      const enriched = enrichedRosz(source);
      const sourcePath = path.join(supportDirectory, "source.rosz");
      const enrichedPath = path.join(
        supportDirectory,
        "enriched.rosz",
      );
      await Promise.all([
        writeFile(sourcePath, source),
        writeFile(enrichedPath, enriched),
      ]);
      const createdEvent = connectorEvent({
        id: "created-event",
        origin: "new-remote",
        outcome: "verified",
        remoteId:
          "https://www.newrecruit.eu/app/Lists/created",
      });
      createdEvent.contentSha256 = crypto
        .createHash("sha256")
        .update(enriched)
        .digest("hex");
      const createdDelivery = delivery({
        roster: candidate,
        event: createdEvent,
        imported: true,
      });
      assert.ok(createdDelivery.data);
      createdDelivery.data.enrichedSummary =
        inspectEnrichedRosz(enriched);
      createdDelivery.data.artifacts = [
        {
          format: "rosterpilot-source-rosz",
          filename: "source.rosz",
          mimeType: "application/zip",
          written: sourcePath,
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: "enriched.rosz",
          mimeType: "application/zip",
          written: enrichedPath,
        },
      ];
      await retry.finalizeDelivery(
        createdDelivery,
      );

      const inventory = await readNewRecruitRunInventory();
      assert.deepEqual(
        inventory.entries.map((entry) => ({
          runId: entry.runId,
          outcome: entry.outcome,
          connectorEventId: entry.connectorEventId,
        })),
        [
          {
            runId: "retry-run",
            outcome: "created",
            connectorEventId: "created-event",
          },
        ],
      );
      await assert.rejects(
        beginNewRecruitMutationReceipt({
          roster: candidate,
          runId: "duplicate-run",
        }),
        (error: unknown) =>
          Boolean(
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code ===
                "NEW_RECRUIT_MUTATION_ALREADY_CREATED",
          ),
      );
    },
  );
});

test("a legacy created receipt restores its exact retained Tessera artifact without redelivery", async () => {
  await withSupportDirectory(
    "new-recruit-legacy-artifact-restore",
    async (supportDirectory) => {
      const candidate = roster();
      const exported = await exportRoster(candidate, "rosz");
      assert.ok(exported.ok && exported.data);
      const source = exported.data.content as Uint8Array;
      const enrichedEntries = unzipSync(enrichedRosz(source));
      const [enrichedName, enrichedBytes] = Object.entries(enrichedEntries)[0];
      const enriched = zipSync({
        [enrichedName]: strToU8(
          strFromU8(enrichedBytes).replace(
            /gameSystemRevision="\d+"/,
            `gameSystemRevision="${candidate.sourceData.newRecruit.gameSystemRevision + 1}"`,
          ),
        ),
      });
      const sourceSha256 = crypto
        .createHash("sha256")
        .update(source)
        .digest("hex");
      const enrichedSha256 = crypto
        .createHash("sha256")
        .update(enriched)
        .digest("hex");
      const runId = "legacy-created-run";
      const transaction = await beginNewRecruitMutationReceipt({
        roster: candidate,
        runId,
        expectedSourceRoszSha256: sourceSha256,
      });
      const event: ConnectorEvent = {
        schemaVersion: 1,
        eventId: "legacy-created-event",
        recordedAt: new Date().toISOString(),
        provider: "new-recruit",
        action: "prepare",
        origin: "new-remote",
        outcome: "verified",
        remoteId: "https://www.newrecruit.eu/app/Lists/legacy-created",
        contentSha256: enrichedSha256,
      };
      await transaction.finalize({
        outcome: "created",
        connectorEvent: event,
        message: "Legacy release created and verified the list.",
      });
      const before = await readNewRecruitMutationReceipt(candidate);
      assert.equal(before?.attempts[0]?.recoveryArtifact, null);

      const jobRoot = path.join(supportDirectory, "legacy-job");
      const artifacts = path.join(jobRoot, "artifacts", "attempt-1", "player");
      await mkdir(artifacts, { recursive: true });
      const sourcePath = path.join(artifacts, "source.rosz");
      const enrichedPath = path.join(artifacts, "enriched.rosz");
      const jobPath = path.join(jobRoot, "tessera-run.json");
      await Promise.all([
        writeFile(sourcePath, source),
        writeFile(enrichedPath, enriched),
        writeFile(
          jobPath,
          `${JSON.stringify({
            schemaVersion: 1,
            jobKind: "rosterpilot-tessera-run",
            runId,
            jobDirectory: jobRoot,
            requestPath: jobPath,
          }, null, 2)}\n`,
        ),
      ]);

      const restored =
        await restoreNewRecruitMutationArtifactFromTesseraRun({
          roster: candidate,
          jobPath,
        });
      assert.equal(restored.ok, true);
      assert.ok(
        restored.warnings.some(
          (warning) =>
            warning.code === "NEW_RECRUIT_LEGACY_ARTIFACT_RESTORED",
        ),
      );
      const after = await readNewRecruitMutationReceipt(candidate);
      assert.equal(
        after?.attempts[0]?.recoveryArtifact?.sourceRoszSha256,
        sourceSha256,
      );
      assert.equal(
        after?.attempts[0]?.recoveryArtifact?.enrichedRoszSha256,
        enrichedSha256,
      );
      await rm(
        after!.attempts[0]!.recoveryArtifact!.enrichedRoszPath,
        { force: true },
      );
      const rebound =
        await restoreNewRecruitMutationArtifactFromTesseraRun({
          roster: candidate,
          jobPath,
        });
      assert.equal(rebound.ok, true);
      assert.ok(
        rebound.warnings.some(
          (warning) =>
            warning.code ===
            "NEW_RECRUIT_LEGACY_ARTIFACT_RESTORED",
        ),
      );

      let redeliveryCalls = 0;
      const prepared = await prepareRosterForTessera(
        { ...candidate, name: "Renamed legacy recovery" },
        {
          outputDirectory: path.join(supportDirectory, "prepared"),
          allowOutsideRoot: true,
          mutationRunId: "legacy-restored-diagnostic",
          catalogueDriftMode: "diagnostic",
        },
        {
          runtimeIssue: () => null,
          persistentCacheDelivery: true,
          deliver: async () => {
            redeliveryCalls += 1;
            throw new Error("legacy restore must prevent redelivery");
          },
        },
      );
      assert.equal(prepared.ok, true, JSON.stringify(prepared.violations));
      assert.equal(prepared.data?.cacheReused, true);
      assert.equal(redeliveryCalls, 0);
    },
  );
});

test("every cache reuse is appended with its own run ID", async () => {
  await withSupportDirectory(
    "new-recruit-reuse-inventory",
    async () => {
      const candidate = roster("orks");
      const firstEvent = connectorEvent({
        id: "reuse-one",
        origin: "persistent-cache",
        outcome: "reused",
        remoteId:
          "https://www.newrecruit.eu/app/Lists/reused",
      });
      const secondEvent = connectorEvent({
        id: "reuse-two",
        origin: "manifest-reuse",
        outcome: "reused",
        remoteId:
          "https://www.newrecruit.eu/app/Lists/reused",
      });
      await recordNewRecruitReuseReceipt({
        roster: candidate,
        runId: "reuse-run-one",
        delivery: delivery({
          roster: candidate,
          event: firstEvent,
          imported: true,
          cacheReused: true,
        }),
      });
      await recordNewRecruitReuseReceipt({
        roster: candidate,
        runId: "reuse-run-two",
        delivery: delivery({
          roster: candidate,
          event: secondEvent,
          imported: false,
          cacheReused: true,
        }),
      });
      // An idempotent retry of the same connector receipt must not append a
      // duplicate, while a distinct reuse of the same URL must be retained.
      await recordNewRecruitReuseReceipt({
        roster: candidate,
        runId: "reuse-run-two",
        delivery: delivery({
          roster: candidate,
          event: secondEvent,
          imported: false,
          cacheReused: true,
        }),
      });
      const inventory = await readNewRecruitRunInventory();
      assert.deepEqual(
        inventory.entries.map((entry) => [
          entry.runId,
          entry.outcome,
          entry.listUrl,
        ]),
        [
          [
            "reuse-run-one",
            "reused",
            "https://www.newrecruit.eu/app/Lists/reused",
          ],
          [
            "reuse-run-two",
            "reused",
            "https://www.newrecruit.eu/app/Lists/reused",
          ],
        ],
      );
    },
  );
});

test("tampered receipts and inventories fail closed", async () => {
  await withSupportDirectory(
    "new-recruit-tamper-receipt",
    async (supportDirectory) => {
      const candidate = roster("death-guard");
      const first = await beginNewRecruitMutationReceipt({
        roster: candidate,
        runId: "tamper-receipt-run",
      });
      await first.finalize({
        outcome: "not-created",
        connectorEvent: null,
        message: "No browser activity.",
      });
      const filename = receiptFilename(
        supportDirectory,
        candidate,
      );
      const tampered = JSON.parse(
        await readFile(filename, "utf8"),
      ) as {
        attempts: Array<{ message: string }>;
      };
      tampered.attempts[0].message = "tampered";
      await writeFile(
        filename,
        `${JSON.stringify(tampered, null, 2)}\n`,
      );
      await assert.rejects(
        beginNewRecruitMutationReceipt({
          roster: candidate,
          runId: "after-receipt-tamper",
        }),
        (error: unknown) =>
          Boolean(
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code ===
                "NEW_RECRUIT_MUTATION_RECEIPT_INVALID",
          ),
      );

      const other = roster("tyranids");
      await recordNewRecruitReuseReceipt({
        roster: other,
        runId: "tamper-inventory-run",
        delivery: delivery({
          roster: other,
          event: connectorEvent({
            id: "inventory-before-tamper",
            origin: "persistent-cache",
            outcome: "reused",
          }),
          imported: true,
          cacheReused: true,
        }),
      });
      const inventoryFilename = path.join(
        supportDirectory,
        "new-recruit-run-inventory.json",
      );
      const inventory = JSON.parse(
        await readFile(inventoryFilename, "utf8"),
      ) as {
        entries: Array<{ runId: string }>;
      };
      inventory.entries[0].runId = "tampered";
      await writeFile(
        inventoryFilename,
        `${JSON.stringify(inventory, null, 2)}\n`,
      );
      await assert.rejects(
        recordNewRecruitReuseReceipt({
          roster: other,
          runId: "after-inventory-tamper",
          delivery: delivery({
            roster: other,
            event: connectorEvent({
              id: "inventory-after-tamper",
              origin: "persistent-cache",
              outcome: "reused",
            }),
            imported: true,
            cacheReused: true,
          }),
        }),
        (error: unknown) =>
          Boolean(
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "NEW_RECRUIT_INVENTORY_INVALID",
          ),
      );
    },
  );
});

test("legacy inventory remains readable and migrates on append", async () => {
  await withSupportDirectory(
    "new-recruit-legacy-inventory",
    async (supportDirectory) => {
      const candidate = roster("space-marines");
      const filename = path.join(
        supportDirectory,
        "new-recruit-run-inventory.json",
      );
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(
        filename,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            inventoryKind: "new-recruit-remote-lists",
            entries: [
              {
                cacheKey: newRecruitCacheKey(candidate),
                rosterName: candidate.name,
                listUrl:
                  "https://www.newrecruit.eu/app/Lists/legacy",
                recordedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const migrated = await readNewRecruitRunInventory();
      assert.equal(migrated.schemaVersion, 2);
      assert.equal(migrated.entries[0].runId, "legacy-unscoped");

      await recordNewRecruitReuseReceipt({
        roster: candidate,
        runId: "current-run",
        delivery: delivery({
          roster: candidate,
          event: connectorEvent({
            id: "current-reuse",
            origin: "persistent-cache",
            outcome: "reused",
          }),
          imported: true,
          cacheReused: true,
        }),
      });
      const persisted = JSON.parse(
        await readFile(filename, "utf8"),
      ) as {
        schemaVersion: number;
        integritySha256: string;
        entries: Array<{ runId: string }>;
      };
      assert.equal(persisted.schemaVersion, 2);
      assert.match(persisted.integritySha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(
        persisted.entries.map((entry) => entry.runId),
        ["legacy-unscoped", "current-run"],
      );
    },
  );
});
