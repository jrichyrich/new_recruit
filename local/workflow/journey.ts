import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  prepareRosterWorkflow,
  type PrepareRosterWorkflowInput,
  type RosterWorkflowResult,
} from "../../lib/rosterpilot/roster-workflow";
import {
  projectWorkflowRecovery,
  type RecoveryActionId,
  type RecoveryStateV1,
} from "../../lib/rosterpilot/workflow-recovery";
import { retainDataBundleReference } from "../../lib/rosterpilot/data-operations";
import { rebaseRosterWithProvider } from "../../lib/rosterpilot/data-operations";
import { writeExportArtifacts } from "../../lib/rosterpilot/io";
import { prepareNewRecruitHandoff } from "../../lib/rosterpilot/handoff";

export type RosterJourneyStatus =
  | "in-progress"
  | "action-required"
  | "parked"
  | "complete"
  | "cancelled"
  | "invalidated";

export type RosterJourneyV1 = {
  schemaVersion: 1;
  journeyKind: "roster-journey";
  journeyId: string;
  stateRevision: number;
  status: RosterJourneyStatus;
  createdAt: string;
  updatedAt: string;
  request: PrepareRosterWorkflowInput;
  activeRosterRevisionId: string | null;
  rosterRevisions: Array<{
    revisionId: string;
    parentRevisionId: string | null;
    rosterId: string;
    bundleId: string;
    reason: "initial-build" | "compatible-rebase" | "approved-change";
    approvalReference: string | null;
  }>;
  actions: Array<{
    attemptId: string;
    actionId: RecoveryActionId | "workflow.start";
    status: "succeeded" | "blocked" | "parked";
    recordedAt: string;
    details: string;
  }>;
  tesseraJobRefs: string[];
  optimizerRefs: string[];
  newRecruitMutationRefs: string[];
  compatibilityAssessments: Array<{
    recordedAt: string;
    bundleId: string;
    status: "current" | "compatible-rebased" | "review-required";
  }>;
  workflow: RosterWorkflowResult;
  recovery: RecoveryStateV1;
  stateSha256: string;
};

export type RosterJourneyStoreOptions = {
  rootDir?: string;
};

function storeRoot(options: RosterJourneyStoreOptions): string {
  return path.resolve(
    options.rootDir ??
      path.join(process.cwd(), "exports", "rosterpilot-journeys"),
  );
}

function journeyPath(
  journeyId: string,
  options: RosterJourneyStoreOptions,
): string {
  if (!/^[0-9a-f-]{36}$/i.test(journeyId)) {
    throw Object.assign(new Error("Invalid roster journey ID."), {
      code: "ROSTER_JOURNEY_ID_INVALID",
    });
  }
  return path.join(storeRoot(options), journeyId, "journey.json");
}

function statePayload(
  state: Omit<RosterJourneyV1, "stateSha256">,
): string {
  return JSON.stringify(state);
}

function seal(
  state: Omit<RosterJourneyV1, "stateSha256">,
): RosterJourneyV1 {
  return {
    ...state,
    stateSha256: createHash("sha256")
      .update(statePayload(state))
      .digest("hex"),
  };
}

function verify(state: RosterJourneyV1): RosterJourneyV1 {
  const { stateSha256, ...payload } = state;
  const expected = createHash("sha256")
    .update(statePayload(payload))
    .digest("hex");
  if (stateSha256 !== expected) {
    throw Object.assign(
      new Error("The roster journey state hash does not match its content."),
      { code: "ROSTER_JOURNEY_INTEGRITY_FAILED" },
    );
  }
  return state;
}

async function withJourneyLock<T>(
  journeyId: string,
  options: RosterJourneyStoreOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const directory = path.dirname(journeyPath(journeyId, options));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, ".journey.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch {
    throw Object.assign(
      new Error("The roster journey is already being updated."),
      { code: "ROSTER_JOURNEY_BUSY" },
    );
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function persist(
  state: RosterJourneyV1,
  options: RosterJourneyStoreOptions,
): Promise<void> {
  const filename = journeyPath(state.journeyId, options);
  const temporary = `${filename}.next-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, filename);
}

function journeyStatus(
  workflow: RosterWorkflowResult,
  recovery: RecoveryStateV1,
): RosterJourneyStatus {
  if (recovery.status === "completed") return "complete";
  if (workflow.status === "failed") return "invalidated";
  return "action-required";
}

export async function startRosterJourney(
  request: PrepareRosterWorkflowInput,
  options: RosterJourneyStoreOptions = {},
): Promise<RosterJourneyV1> {
  const prepared = await prepareRosterWorkflow(request);
  if (!prepared.data) {
    throw Object.assign(
      new Error(
        prepared.violations[0]?.message ??
          "Roster workflow preparation returned no durable state.",
      ),
      {
        code:
          prepared.violations[0]?.code ??
          "ROSTER_JOURNEY_PREPARATION_FAILED",
      },
    );
  }
  const journeyId = randomUUID();
  const now = new Date().toISOString();
  const recovery = projectWorkflowRecovery(prepared.data, {
    journeyId,
    journeyRevision: 1,
  });
  const rosterRevisionId = prepared.data.roster
    ? randomUUID()
    : null;
  const state = seal({
    schemaVersion: 1,
    journeyKind: "roster-journey",
    journeyId,
    stateRevision: 1,
    status: journeyStatus(prepared.data, recovery),
    createdAt: now,
    updatedAt: now,
    request,
    activeRosterRevisionId: rosterRevisionId,
    rosterRevisions:
      prepared.data.roster && rosterRevisionId
        ? [
            {
              revisionId: rosterRevisionId,
              parentRevisionId: null,
              rosterId: prepared.data.roster.id,
              bundleId: prepared.data.roster.sourceData.bundleId,
              reason: "initial-build",
              approvalReference: null,
            },
          ]
        : [],
    actions: [
      {
        attemptId: randomUUID(),
        actionId: "workflow.start",
        status: prepared.ok ? "succeeded" : "blocked",
        recordedAt: now,
        details:
          prepared.violations[0]?.code ?? prepared.data.status,
      },
    ],
    tesseraJobRefs: [],
    optimizerRefs: [],
    newRecruitMutationRefs: [],
    compatibilityAssessments: prepared.data.roster
      ? [
          {
            recordedAt: now,
            bundleId: prepared.data.roster.sourceData.bundleId,
            status: "current",
          },
        ]
      : [],
    workflow: prepared.data,
    recovery,
  });
  await withJourneyLock(journeyId, options, () => persist(state, options));
  if (prepared.data.roster) {
    await retainDataBundleReference(
      `roster-journey:${journeyId}`,
      prepared.data.roster.sourceData.bundleId,
    );
  }
  return state;
}

export async function getRosterJourney(
  journeyId: string,
  options: RosterJourneyStoreOptions = {},
): Promise<RosterJourneyV1> {
  const content = await readFile(journeyPath(journeyId, options), "utf8");
  return verify(JSON.parse(content) as RosterJourneyV1);
}

export async function continueRosterJourneySafely(
  journeyId: string,
  expectedRevision: number,
  options: RosterJourneyStoreOptions = {},
): Promise<RosterJourneyV1> {
  return withJourneyLock(journeyId, options, async () => {
    const current = await getRosterJourney(journeyId, options);
    if (current.stateRevision !== expectedRevision) {
      throw Object.assign(
        new Error(
          `Roster journey revision ${expectedRevision} is stale; current revision is ${current.stateRevision}.`,
        ),
        { code: "ROSTER_JOURNEY_REVISION_CONFLICT" },
      );
    }
    const now = new Date().toISOString();
    const actions = [...current.actions];
    let workflow = current.workflow;
    let activeRosterRevisionId = current.activeRosterRevisionId;
    const rosterRevisions = [...current.rosterRevisions];
    const compatibilityAssessments = [
      ...current.compatibilityAssessments,
    ];
    if (
      workflow.roster &&
      !workflow.analysis &&
      !workflow.optimization
    ) {
      const rebased = await rebaseRosterWithProvider(workflow.roster);
      if (rebased.ok && rebased.data) {
        compatibilityAssessments.push({
          recordedAt: now,
          bundleId: rebased.data.toBundleId,
          status: rebased.data.status,
        });
        if (
          rebased.data.status === "compatible-rebased" &&
          rebased.data.toBundleId !== rebased.data.fromBundleId
        ) {
          const revisionId = randomUUID();
          const handoff = workflow.newRecruit.handoff
            ? await prepareNewRecruitHandoff(rebased.data.roster, true)
            : null;
          workflow = {
            ...workflow,
            roster: rebased.data.roster,
            newRecruit: {
              ...workflow.newRecruit,
              handoff: handoff?.data ?? workflow.newRecruit.handoff,
            },
          };
          rosterRevisions.push({
            revisionId,
            parentRevisionId: activeRosterRevisionId,
            rosterId: rebased.data.roster.id,
            bundleId: rebased.data.toBundleId,
            reason: "compatible-rebase",
            approvalReference: null,
          });
          activeRosterRevisionId = revisionId;
          await retainDataBundleReference(
            `roster-journey:${journeyId}`,
            rebased.data.toBundleId,
          );
          actions.push({
            attemptId: randomUUID(),
            actionId: "roster.rebase-compatible",
            status: "succeeded",
            recordedAt: now,
            details: `Compatible provenance rebase to ${rebased.data.toBundleId}`,
          });
        }
      }
    }
    const refreshedRecovery = projectWorkflowRecovery(workflow, {
      journeyId,
      journeyRevision: current.stateRevision,
    });
    const fallback = refreshedRecovery.actions.find(
      (action) =>
        action.actionId === "artifact.export-fallback" &&
        action.eligibility === "ready" &&
        action.authority.kind === "automatic",
    );
    if (fallback && workflow.newRecruit.handoff?.artifacts.length) {
      const universal = workflow.newRecruit.handoff.artifacts.filter(
        (artifact) => artifact.format !== "rosz",
      );
      if (universal.length > 0) {
        const directory = path.join(
          path.dirname(journeyPath(journeyId, options)),
          "artifacts",
        );
        await writeExportArtifacts(universal, directory, {
          rootDir: storeRoot(options),
          overwrite: false,
          allowOutsideRoot: false,
        });
        actions.push({
          attemptId: randomUUID(),
          actionId: "artifact.export-fallback",
          status: "succeeded",
          recordedAt: now,
          details: `${universal.length} universal artifact(s) written`,
        });
      }
    }
    const nextRevision = current.stateRevision + 1;
    const recovery = projectWorkflowRecovery(workflow, {
      journeyId,
      journeyRevision: nextRevision,
    });
    const { stateSha256: _stateSha256, ...currentPayload } = current;
    void _stateSha256;
    const next = seal({
      ...currentPayload,
      stateRevision: nextRevision,
      updatedAt: now,
      actions,
      workflow,
      activeRosterRevisionId,
      rosterRevisions,
      compatibilityAssessments,
      recovery,
      status: journeyStatus(workflow, recovery),
    });
    await persist(next, options);
    return next;
  });
}

export async function chooseRosterJourneyAction(
  journeyId: string,
  expectedRevision: number,
  actionId: RecoveryActionId,
  options: RosterJourneyStoreOptions = {},
): Promise<RosterJourneyV1> {
  if (actionId !== "workflow.park") {
    throw Object.assign(
      new Error(
        `Action ${actionId} must be executed through its specialized, approval-aware tool.`,
      ),
      { code: "ROSTER_JOURNEY_SPECIALIZED_ACTION_REQUIRED" },
    );
  }
  return withJourneyLock(journeyId, options, async () => {
    const current = await getRosterJourney(journeyId, options);
    if (current.stateRevision !== expectedRevision) {
      throw Object.assign(new Error("The roster journey revision is stale."), {
        code: "ROSTER_JOURNEY_REVISION_CONFLICT",
      });
    }
    const now = new Date().toISOString();
    const { stateSha256: _stateSha256, ...currentPayload } = current;
    void _stateSha256;
    const next = seal({
      ...currentPayload,
      stateRevision: current.stateRevision + 1,
      status: "parked",
      updatedAt: now,
      actions: [
        ...current.actions,
        {
          attemptId: randomUUID(),
          actionId,
          status: "parked",
          recordedAt: now,
          details: "Journey parked without external action.",
        },
      ],
      recovery: {
        ...current.recovery,
        status: "parked",
      },
    });
    await persist(next, options);
    return next;
  });
}
