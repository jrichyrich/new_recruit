import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRoster,
  type ConnectorEvent,
  type NewRecruitDelivery,
  type ResultEnvelope,
} from "../lib/rosterpilot";
import {
  beginCertificationNewRecruitTransaction,
  certificationNewRecruitFinalizationOutcome,
  runCertificationNewRecruitMutation,
  type CertificationNewRecruitTransaction,
} from "../local/certification/new-recruit-transaction";
import { LocalAgentError } from "../local/agent/client";
import { deliverRosterToNewRecruit } from "../local/new-recruit/companion";

function roster() {
  const built = buildRoster({
    playerFaction: "death-guard",
    pointsLimit: 1000,
    name: "Certification transaction fixture",
  });
  assert.equal(built.ok, true);
  assert.ok(built.data);
  return built.data;
}

function event(
  outcome: ConnectorEvent["outcome"],
  origin: ConnectorEvent["origin"] = "new-remote",
): ConnectorEvent {
  return {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
    provider: "new-recruit",
    action: "prepare",
    origin,
    outcome,
    remoteId: "remote-fixture",
    contentSha256: "a".repeat(64),
  };
}

function delivery(input: {
  ok: boolean;
  imported?: boolean;
  outcome?: ConnectorEvent["outcome"];
  origin?: ConnectorEvent["origin"];
}): ResultEnvelope<NewRecruitDelivery> {
  const data =
    input.imported === undefined
      ? null
      : {
          rosterId: "fixture",
          rosterName: "Fixture",
          listUrl: null,
          imported: input.imported,
          sessionReused: false,
          connectorEvents: input.outcome
            ? [event(input.outcome, input.origin)]
            : [],
          verification: null,
          enrichedSummary: null,
          artifacts: [],
        };
  return {
    ok: input.ok,
    data,
    violations: input.ok
      ? []
      : [
          {
            code: "FIXTURE_FAILURE",
            message: "Fixture delivery failed.",
            severity: "error",
          },
        ],
    warnings: [],
  };
}

function recordedTransaction() {
  const states: string[] = [];
  const transaction: CertificationNewRecruitTransaction = {
    cacheKey: "a".repeat(64),
    attemptId: "fixture-attempt",
    markVerified: async () => {
      states.push("verified");
    },
    markUncertain: async () => {
      states.push("uncertain");
    },
    markSafeFailure: async () => {
      states.push("safe-failed");
    },
  };
  return {
    states,
    begin: async () => transaction,
  };
}

test("New Recruit finalization events expose uncertain new-remote provenance failures", () => {
  assert.equal(
    certificationNewRecruitFinalizationOutcome(
      "new-remote",
      true,
    ),
    "verified",
  );
  assert.equal(
    certificationNewRecruitFinalizationOutcome(
      "new-remote",
      false,
    ),
    "uncertain",
  );
  assert.equal(
    certificationNewRecruitFinalizationOutcome(
      "persistent-cache",
      false,
    ),
    "reused",
  );
  assert.equal(
    certificationNewRecruitFinalizationOutcome(
      "manifest-reuse",
      false,
    ),
    "reused",
  );
});

test("New Recruit certification transaction permits only one concurrent mutation owner", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-certification-transaction-"),
  );
  try {
    const input = {
      roster: roster(),
      runId: "concurrent-fixture",
      rootDirectory: directory,
    };
    const attempts = await Promise.allSettled([
      beginCertificationNewRecruitTransaction(input),
      beginCertificationNewRecruitTransaction(input),
    ]);
    const fulfilled = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<
        Awaited<
          ReturnType<
            typeof beginCertificationNewRecruitTransaction
          >
        >
      > => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (
        attempt,
      ): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      (rejected[0].reason as Error & { code?: string }).code,
      "CERTIFICATION_NEW_RECRUIT_TRANSACTION_ACTIVE",
    );

    await fulfilled[0].value.markSafeFailure(
      event("failed"),
      "The connector proved that no import occurred.",
    );
    const retry =
      await beginCertificationNewRecruitTransaction(input);
    await retry.markVerified(event("verified"));
    await assert.rejects(
      beginCertificationNewRecruitTransaction(input),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_NEW_RECRUIT_ALREADY_MUTATED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted or uncertain New Recruit transaction fails closed", async () => {
  const interruptedDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-certification-interrupted-"),
  );
  const uncertainDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-certification-uncertain-"),
  );
  try {
    const interruptedInput = {
      roster: roster(),
      runId: "interrupted-fixture",
      rootDirectory: interruptedDirectory,
    };
    await beginCertificationNewRecruitTransaction(
      interruptedInput,
    );
    await assert.rejects(
      beginCertificationNewRecruitTransaction(
        interruptedInput,
      ),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_NEW_RECRUIT_TRANSACTION_ACTIVE",
    );

    const uncertainInput = {
      roster: roster(),
      runId: "uncertain-fixture",
      rootDirectory: uncertainDirectory,
    };
    const transaction =
      await beginCertificationNewRecruitTransaction(
        uncertainInput,
      );
    await transaction.markUncertain(
      event("uncertain"),
      "The process could not prove whether the imported list was verified.",
    );
    await assert.rejects(
      beginCertificationNewRecruitTransaction(
        uncertainInput,
      ),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_NEW_RECRUIT_OUTCOME_UNKNOWN",
    );
  } finally {
    await Promise.all([
      rm(interruptedDirectory, {
        recursive: true,
        force: true,
      }),
      rm(uncertainDirectory, {
        recursive: true,
        force: true,
      }),
    ]);
  }
});

test("New Recruit mutation orchestration distinguishes pre-mutation failures from imported failures", async () => {
  const safe = recordedTransaction();
  const safeResult =
    await runCertificationNewRecruitMutation({
      roster: roster(),
      runId: "safe-failure",
      beginTransaction: safe.begin,
      deliver: async () =>
        delivery({
          ok: false,
          imported: false,
          outcome: "failed",
          origin: "in-memory",
        }),
      finalize: async () => {
        throw new Error("must not finalize a failed delivery");
      },
    });
  assert.equal(safeResult.transactionState, "safe-failed");
  assert.deepEqual(safe.states, ["safe-failed"]);

  const preflight = recordedTransaction();
  const preflightResult =
    await runCertificationNewRecruitMutation({
      roster: roster(),
      runId: "preflight-failure",
      beginTransaction: preflight.begin,
      deliver: async () => delivery({ ok: false }),
      finalize: async () => {
        throw new Error("must not finalize a failed delivery");
      },
    });
  assert.equal(
    preflightResult.transactionState,
    "uncertain",
  );
  assert.deepEqual(preflight.states, ["uncertain"]);

  const imported = recordedTransaction();
  const importedResult =
    await runCertificationNewRecruitMutation({
      roster: roster(),
      runId: "imported-failure",
      beginTransaction: imported.begin,
      deliver: async () =>
        delivery({
          ok: false,
          imported: true,
          outcome: "uncertain",
        }),
      finalize: async () => {
        throw new Error("must not finalize a failed delivery");
      },
    });
  assert.equal(importedResult.transactionState, "uncertain");
  assert.deepEqual(imported.states, ["uncertain"]);
});

test("a lost local-agent response after dispatch is uncertain and durably blocks duplicate retry", async () => {
  const directory = await mkdtemp(
    path.join(
      os.tmpdir(),
      "rosterpilot-certification-lost-agent-response-",
    ),
  );
  const fixtureRoster = roster();
  const transactionInput = {
    roster: fixtureRoster,
    runId: "lost-agent-response",
    rootDirectory: directory,
  };
  try {
    const result =
      await runCertificationNewRecruitMutation({
        ...transactionInput,
        deliver: () =>
          deliverRosterToNewRecruit(
            fixtureRoster,
            {
              outputDirectory: path.join(
                directory,
                "artifacts",
              ),
              allowOutsideRoot: true,
              downloadEnrichedRosz: true,
              downloadPrettyHtml: false,
              mutationReceiptMode: "external",
            },
            {
              platform: "darwin",
              browserAvailable: true,
              agentDeliver: async () => {
                throw new LocalAgentError(
                  "LOCAL_AGENT_TIMEOUT",
                  "The response was lost after dispatch.",
                );
              },
            },
          ),
        finalize: async () => {
          throw new Error(
            "must not finalize an uncertain delivery",
          );
        },
      });
    assert.equal(result.transactionState, "uncertain");
    assert.equal(
      result.delivery.data?.connectorEvents?.[0]
        ?.origin,
      "new-remote",
    );
    assert.equal(
      result.delivery.data?.connectorEvents?.[0]
        ?.outcome,
      "uncertain",
    );
    await assert.rejects(
      beginCertificationNewRecruitTransaction(
        transactionInput,
      ),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_NEW_RECRUIT_OUTCOME_UNKNOWN",
    );
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("New Recruit mutation orchestration verifies only after finalization and makes thrown outcomes uncertain", async () => {
  const verified = recordedTransaction();
  const order: string[] = [];
  verified.begin = async () => ({
    cacheKey: "a".repeat(64),
    attemptId: "verified-attempt",
    markVerified: async () => {
      order.push("journal-verified");
    },
    markUncertain: async () => {
      order.push("journal-uncertain");
    },
    markSafeFailure: async () => {
      order.push("journal-safe-failed");
    },
  });
  const verifiedResult =
    await runCertificationNewRecruitMutation({
      roster: roster(),
      runId: "verified-finalization",
      beginTransaction: verified.begin,
      deliver: async () => {
        order.push("delivered");
        return delivery({
          ok: true,
          imported: true,
          outcome: "verified",
        });
      },
      finalize: async () => {
        order.push("identity-catalogue-cache-verified");
        return {
          transactionState: "verified",
          connectorEvent: event("verified"),
          message: "Verified after cache persistence.",
          data: "finalized",
        };
      },
    });
  assert.equal(verifiedResult.transactionState, "verified");
  assert.equal(verifiedResult.finalization, "finalized");
  assert.deepEqual(order, [
    "delivered",
    "identity-catalogue-cache-verified",
    "journal-verified",
  ]);

  const thrown = recordedTransaction();
  await assert.rejects(
    runCertificationNewRecruitMutation({
      roster: roster(),
      runId: "thrown-finalization",
      beginTransaction: thrown.begin,
      deliver: async () =>
        delivery({
          ok: true,
          imported: true,
          outcome: "verified",
        }),
      finalize: async () => {
        throw new Error("cache verification failed");
      },
    }),
    /cache verification failed/,
  );
  assert.deepEqual(thrown.states, ["uncertain"]);
});
