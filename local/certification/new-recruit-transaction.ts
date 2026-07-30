import crypto from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  rosterExecutionFingerprint,
  type ConnectorEvent,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../../lib/rosterpilot";
import { rosterPilotSupportDirectory } from "../agent/paths";
import { newRecruitCacheKey } from "../new-recruit/cache";

type CertificationNewRecruitAttempt = {
  attemptId: string;
  runId: string;
  state:
    | "in-progress"
    | "uncertain"
    | "verified"
    | "safe-failed";
  startedAt: string;
  updatedAt: string;
  connectorEvent: ConnectorEvent | null;
  message: string | null;
};

type CertificationNewRecruitJournal = {
  schemaVersion: 1;
  journalKind: "certification-new-recruit-transaction";
  cacheKey: string;
  executionFingerprint: string;
  rosterId: string;
  rosterName: string;
  attempts: CertificationNewRecruitAttempt[];
};

type LockOwner = {
  schemaVersion: 1;
  ownerKind: "certification-new-recruit-lock";
  token: string;
  pid: number;
  acquiredAt: string;
};

export type CertificationNewRecruitTransaction = {
  cacheKey: string;
  attemptId: string;
  markVerified: (
    connectorEvent: ConnectorEvent,
    message?: string,
  ) => Promise<void>;
  markUncertain: (
    connectorEvent: ConnectorEvent | null,
    message: string,
  ) => Promise<void>;
  markSafeFailure: (
    connectorEvent: ConnectorEvent | null,
    message: string,
  ) => Promise<void>;
};

export type CertificationNewRecruitMutationFinalization<T> = {
  transactionState: "verified" | "uncertain";
  connectorEvent: ConnectorEvent;
  message: string;
  data: T;
};

export type CertificationNewRecruitMutationResult<T> = {
  transactionState:
    | "verified"
    | "uncertain"
    | "safe-failed";
  delivery: ResultEnvelope<NewRecruitDelivery>;
  finalization: T | null;
};

export function certificationNewRecruitFinalizationOutcome(
  origin:
    | "new-remote"
    | "persistent-cache"
    | "manifest-reuse",
  catalogueMatched: boolean,
): "verified" | "uncertain" | "reused" {
  if (origin !== "new-remote") return "reused";
  return catalogueMatched ? "verified" : "uncertain";
}

function codedError(
  code: string,
  message: string,
): Error & { code: string; retryable: false } {
  return Object.assign(new Error(message), {
    code,
    retryable: false as const,
  });
}

function transactionRoot(override?: string): string {
  return (
    override ??
    path.join(
      rosterPilotSupportDirectory(),
      "certification",
      "new-recruit-transactions",
      "v1",
    )
  );
}

function validConnectorEvent(value: unknown): value is ConnectorEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "eventId" in value &&
    typeof value.eventId === "string" &&
    value.eventId.length > 0 &&
    "provider" in value &&
    value.provider === "new-recruit" &&
    "action" in value &&
    value.action === "prepare" &&
    "outcome" in value &&
    ["verified", "reused", "failed", "uncertain"].includes(
      String(value.outcome),
    )
  );
}

function validAttempt(value: unknown): value is CertificationNewRecruitAttempt {
  return (
    value !== null &&
    typeof value === "object" &&
    "attemptId" in value &&
    typeof value.attemptId === "string" &&
    value.attemptId.length > 0 &&
    "runId" in value &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    "state" in value &&
    ["in-progress", "uncertain", "verified", "safe-failed"].includes(
      String(value.state),
    ) &&
    "startedAt" in value &&
    typeof value.startedAt === "string" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string" &&
    "connectorEvent" in value &&
    (value.connectorEvent === null ||
      validConnectorEvent(value.connectorEvent)) &&
    "message" in value &&
    (value.message === null || typeof value.message === "string")
  );
}

function validJournal(
  value: unknown,
): value is CertificationNewRecruitJournal {
  return (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "journalKind" in value &&
    value.journalKind ===
      "certification-new-recruit-transaction" &&
    "cacheKey" in value &&
    typeof value.cacheKey === "string" &&
    /^[0-9a-f]{64}$/.test(value.cacheKey) &&
    "executionFingerprint" in value &&
    typeof value.executionFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(value.executionFingerprint) &&
    "rosterId" in value &&
    typeof value.rosterId === "string" &&
    "rosterName" in value &&
    typeof value.rosterName === "string" &&
    "attempts" in value &&
    Array.isArray(value.attempts) &&
    value.attempts.every(validAttempt)
  );
}

async function readJournal(
  filename: string,
): Promise<CertificationNewRecruitJournal | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(filename, "utf8"),
    );
    if (!validJournal(parsed)) {
      throw codedError(
        "CERTIFICATION_NEW_RECRUIT_JOURNAL_INVALID",
        "The durable New Recruit transaction journal is invalid. No external retry was attempted.",
      );
    }
    return parsed;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code ===
        "CERTIFICATION_NEW_RECRUIT_JOURNAL_INVALID"
    ) {
      throw error;
    }
    throw codedError(
      "CERTIFICATION_NEW_RECRUIT_JOURNAL_INVALID",
      "The durable New Recruit transaction journal could not be read. No external retry was attempted.",
    );
  }
}

async function atomicWriteJson(
  filename: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(value, null, 2)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  await rename(temporary, filename);
}

async function releaseOwnedLock(
  lockPath: string,
  token: string,
): Promise<void> {
  let owner: LockOwner;
  try {
    owner = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8"),
    ) as LockOwner;
  } catch {
    throw codedError(
      "CERTIFICATION_NEW_RECRUIT_LOCK_OWNERSHIP_LOST",
      "The New Recruit transaction lock owner could not be verified, so it was not removed.",
    );
  }
  if (
    owner.schemaVersion !== 1 ||
    owner.ownerKind !== "certification-new-recruit-lock" ||
    owner.token !== token
  ) {
    throw codedError(
      "CERTIFICATION_NEW_RECRUIT_LOCK_OWNERSHIP_LOST",
      "The New Recruit transaction lock changed owners, so it was not removed.",
    );
  }
  await rm(lockPath, { recursive: true, force: true });
}

export async function beginCertificationNewRecruitTransaction(input: {
  roster: RosterDraftV1;
  runId: string;
  rootDirectory?: string;
}): Promise<CertificationNewRecruitTransaction> {
  const root = transactionRoot(input.rootDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const cacheKey = newRecruitCacheKey(input.roster);
  const journalPath = path.join(root, `${cacheKey}.json`);
  const lockPath = path.join(root, `${cacheKey}.lock`);
  const token = crypto.randomUUID();
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw codedError(
        "CERTIFICATION_NEW_RECRUIT_TRANSACTION_ACTIVE",
        "Another process owns the New Recruit transaction for this exact roster, or an earlier process stopped before recording a safe outcome. No external retry was attempted.",
      );
    }
    throw error;
  }
  const owner: LockOwner = {
    schemaVersion: 1,
    ownerKind: "certification-new-recruit-lock",
    token,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  try {
    await atomicWriteJson(path.join(lockPath, "owner.json"), owner);
    const executionFingerprint =
      rosterExecutionFingerprint(input.roster);
    const prior = await readJournal(journalPath);
    if (
      prior &&
      (prior.cacheKey !== cacheKey ||
        prior.executionFingerprint !== executionFingerprint ||
        prior.rosterId !== input.roster.id)
    ) {
      throw codedError(
        "CERTIFICATION_NEW_RECRUIT_JOURNAL_MISMATCH",
        "The durable New Recruit transaction journal does not match this exact roster. No external retry was attempted.",
      );
    }
    const latest = prior?.attempts.at(-1);
    if (
      latest?.state === "in-progress" ||
      latest?.state === "uncertain"
    ) {
      throw codedError(
        "CERTIFICATION_NEW_RECRUIT_OUTCOME_UNKNOWN",
        "A prior New Recruit transaction has no safely retryable outcome. Reconcile the run-scoped remote list before another delivery.",
      );
    }
    if (latest?.state === "verified") {
      throw codedError(
        "CERTIFICATION_NEW_RECRUIT_ALREADY_MUTATED",
        "This exact roster already has a verified New Recruit transaction, but its hash-verified cache was unavailable. No duplicate list was created.",
      );
    }
    const now = new Date().toISOString();
    const attempt: CertificationNewRecruitAttempt = {
      attemptId: crypto.randomUUID(),
      runId: input.runId,
      state: "in-progress",
      startedAt: now,
      updatedAt: now,
      connectorEvent: null,
      message: null,
    };
    const journal: CertificationNewRecruitJournal = prior ?? {
      schemaVersion: 1,
      journalKind:
        "certification-new-recruit-transaction",
      cacheKey,
      executionFingerprint,
      rosterId: input.roster.id,
      rosterName: input.roster.name,
      attempts: [],
    };
    journal.attempts.push(attempt);
    await atomicWriteJson(journalPath, journal);

    let completed = false;
    const finish = async (
      state: Exclude<
        CertificationNewRecruitAttempt["state"],
        "in-progress"
      >,
      connectorEvent: ConnectorEvent | null,
      message: string | null,
    ): Promise<void> => {
      if (completed) {
        throw codedError(
          "CERTIFICATION_NEW_RECRUIT_TRANSACTION_ALREADY_FINISHED",
          "The New Recruit transaction was already finalized.",
        );
      }
      const current = await readJournal(journalPath);
      const currentAttempt = current?.attempts.find(
        (candidate) => candidate.attemptId === attempt.attemptId,
      );
      if (
        !current ||
        !currentAttempt ||
        currentAttempt.state !== "in-progress"
      ) {
        throw codedError(
          "CERTIFICATION_NEW_RECRUIT_JOURNAL_MISMATCH",
          "The durable New Recruit transaction changed before it could be finalized.",
        );
      }
      currentAttempt.state = state;
      currentAttempt.updatedAt = new Date().toISOString();
      currentAttempt.connectorEvent = connectorEvent;
      currentAttempt.message = message;
      await atomicWriteJson(journalPath, current);
      await releaseOwnedLock(lockPath, token);
      completed = true;
    };
    return {
      cacheKey,
      attemptId: attempt.attemptId,
      markVerified: (event, message = "Verified New Recruit preparation.") =>
        finish("verified", event, message),
      markUncertain: (event, message) =>
        finish("uncertain", event, message),
      markSafeFailure: (event, message) =>
        finish("safe-failed", event, message),
    };
  } catch (error) {
    await releaseOwnedLock(lockPath, token).catch(() => {
      // Preserve an unverifiable lock rather than risking a second mutation.
    });
    throw error;
  }
}

function latestNewRecruitEvent(
  delivery: ResultEnvelope<NewRecruitDelivery> | null,
): ConnectorEvent | null {
  return (
    delivery?.data?.connectorEvents
      ?.filter(
        (event) =>
          event.provider === "new-recruit" &&
          event.action === "prepare",
      )
      .at(-1) ?? null
  );
}

function uncertainEvent(
  event: ConnectorEvent | null,
): ConnectorEvent | null {
  return event
    ? {
        ...event,
        outcome: "uncertain",
      }
    : null;
}

function deliveryFailureMessage(
  delivery: ResultEnvelope<NewRecruitDelivery>,
): string {
  return (
    delivery.violations
      .map((violation) => violation.message)
      .join(" ") ||
    "New Recruit delivery did not complete."
  );
}

function deliveryProvesNoImport(
  delivery: ResultEnvelope<NewRecruitDelivery>,
): boolean {
  if (delivery.data === null) return false;
  const events = delivery.data?.connectorEvents ?? [];
  const preparationEvents = events.filter(
    (event) =>
      event.provider === "new-recruit" &&
      event.action === "prepare",
  );
  return (
    delivery.data?.imported === false &&
    preparationEvents.length > 0 &&
    preparationEvents.every(
      (event) =>
        (event.origin !== "new-remote" &&
          event.outcome === "failed"),
    )
  );
}

/**
 * Owns the durable mutation boundary for one new-remote preparation.
 * Resume and cache callers must bypass this helper because they perform no
 * remote mutation.
 */
export async function runCertificationNewRecruitMutation<T>(
  input: {
    roster: RosterDraftV1;
    runId: string;
    rootDirectory?: string;
    deliver: () => Promise<
      ResultEnvelope<NewRecruitDelivery>
    >;
    finalize: (
      delivery: ResultEnvelope<NewRecruitDelivery>,
    ) => Promise<
      CertificationNewRecruitMutationFinalization<T>
    >;
    beginTransaction?: typeof beginCertificationNewRecruitTransaction;
  },
): Promise<CertificationNewRecruitMutationResult<T>> {
  const begin =
    input.beginTransaction ??
    beginCertificationNewRecruitTransaction;
  const transaction = await begin({
    roster: input.roster,
    runId: input.runId,
    ...(input.rootDirectory
      ? { rootDirectory: input.rootDirectory }
      : {}),
  });
  let delivery: ResultEnvelope<NewRecruitDelivery> | null =
    null;
  let completed = false;
  try {
    delivery = await input.deliver();
    if (!delivery.ok) {
      const event = latestNewRecruitEvent(delivery);
      const message = deliveryFailureMessage(delivery);
      if (deliveryProvesNoImport(delivery)) {
        await transaction.markSafeFailure(event, message);
        completed = true;
        return {
          transactionState: "safe-failed",
          delivery,
          finalization: null,
        };
      }
      await transaction.markUncertain(
        uncertainEvent(event),
        message,
      );
      completed = true;
      return {
        transactionState: "uncertain",
        delivery,
        finalization: null,
      };
    }

    const finalization = await input.finalize(delivery);
    if (finalization.transactionState === "verified") {
      await transaction.markVerified(
        finalization.connectorEvent,
        finalization.message,
      );
    } else {
      await transaction.markUncertain(
        uncertainEvent(finalization.connectorEvent),
        finalization.message,
      );
    }
    completed = true;
    return {
      transactionState: finalization.transactionState,
      delivery,
      finalization: finalization.data,
    };
  } catch (error) {
    if (!completed) {
      await transaction
        .markUncertain(
          uncertainEvent(latestNewRecruitEvent(delivery)),
          error instanceof Error
            ? error.message
            : "New Recruit preparation stopped after its external outcome became unknown.",
        )
        .catch(() => {
          // A journal or lock finalization failure already blocks a retry.
        });
    }
    throw error;
  }
}
