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
  rosterHasNamedCharacter,
  rosterProfileRequirements,
  validateRoster,
} from "../../lib/rosterpilot/engine";
import {
  evaluateTesseraStressPortfolioContract,
  inspectStressPortfolioTraits,
  rosterSimulationDistance,
  rosterSimulationFingerprint,
  rosterStructuralFingerprint,
  tesseraStressPortfolioContractFingerprint,
} from "../../lib/rosterpilot/stress-portfolio";
import { generalThreatPortfolioHash } from "../../lib/rosterpilot/general-threat-portfolio";
import {
  projectCompatibilityRepairRecovery,
  projectWorkflowRecovery,
  type RecoveryActionId,
  type RecoveryStateV1,
} from "../../lib/rosterpilot/workflow-recovery";
import {
  retainDataBundleReference,
  rebaseRosterWithProvider,
} from "../../lib/rosterpilot/data-operations";
import { writeExportArtifacts } from "../../lib/rosterpilot/io";
import { prepareNewRecruitHandoff } from "../../lib/rosterpilot/handoff";
import {
  adoptNewRecruitMutationArtifactAcrossRosterRevision,
  inspectNewRecruitMutationReceipt,
} from "../new-recruit/cache";
import {
  getTesseraRunStatus,
  startTesseraRun,
  type TesseraRunJob,
  type TesseraRunRequest,
} from "../tessera/jobs";
import {
  ensureLocalServiceCompatibility,
  type LocalServiceCompatibilityResult as LocalServiceCompatibilityResolution,
} from "../data-bundles/configure";
import type {
  RosterDataChangedScope,
  RosterDraftV1,
} from "../../lib/rosterpilot/types";

export type RosterJourneyStatus =
  | "in-progress"
  | "action-required"
  | "updating-local-data"
  | "waiting-for-compatible-source"
  | "waiting-for-verified-data"
  | "needs-data-review"
  | "ready-for-web"
  | "running-successor"
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
  compatibilityRepair?: {
    status:
      | "updating-local-data"
      | "waiting-for-compatible-source"
      | "waiting-for-verified-data"
      | "needs-data-review"
      | "ready-for-web"
      | "running-successor";
    requestedAt: string;
    observedNewRecruitIdentity: {
      gameSystemRevision: number;
      catalogueRevision: number;
    } | null;
    previousBundleId: string;
    activeBundleId: string | null;
    predecessorRunId: string | null;
    changedScopes: Array<{
      kind: string;
      entityId: string;
      change: string;
    }>;
    priorMutation: Awaited<
      ReturnType<typeof inspectNewRecruitMutationReceipt>
    > | null;
    artifactReuse:
      | "verified-reused"
      | "not-found"
      | "blocked-by-receipt";
    proposedWorkflow: RosterWorkflowResult | null;
    successorJobRefs: string[];
    localUpdateJobId?: string | null;
    compatibleBundleId?: string | null;
    message: string;
  };
  workflow: RosterWorkflowResult;
  recovery: RecoveryStateV1;
  stateSha256: string;
};

export type RosterJourneyStoreOptions = {
  rootDir?: string;
  dependencies?: Partial<{
    ensureLocalServiceCompatibility:
      typeof ensureLocalServiceCompatibility;
    rebaseRosterWithProvider: typeof rebaseRosterWithProvider;
    validateRoster: typeof validateRoster;
    retainDataBundleReference: typeof retainDataBundleReference;
    inspectNewRecruitMutationReceipt:
      typeof inspectNewRecruitMutationReceipt;
    adoptNewRecruitMutationArtifactAcrossRosterRevision:
      typeof adoptNewRecruitMutationArtifactAcrossRosterRevision;
    getTesseraRunStatus: typeof getTesseraRunStatus;
    startTesseraRun: typeof startTesseraRun;
  }>;
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
    compatibilityRepair: undefined,
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

export type RepairTesseraWebCompatibilityInput = {
  observedNewRecruitIdentity?: {
    gameSystemRevision: number;
    catalogueRevision: number;
  } | null;
  predecessorJobPath?: string | null;
};

function assertExpectedRevision(
  current: RosterJourneyV1,
  expectedRevision: number,
): void {
  if (current.stateRevision !== expectedRevision) {
    throw Object.assign(
      new Error(
        `Roster journey revision ${expectedRevision} is stale; current revision is ${current.stateRevision}.`,
      ),
      { code: "ROSTER_JOURNEY_REVISION_CONFLICT" },
    );
  }
}

function targetStructuralFingerprints(
  workflow: RosterWorkflowResult,
): string[] {
  const target = workflow.optimization?.target ?? workflow.analysis?.target;
  if (!target) return [];
  if (target.kind === "exact-opponent") {
    return [rosterStructuralFingerprint(target.roster)];
  }
  if (target.kind === "known-faction") {
    return target.portfolioPreview.portfolio.items
      .flatMap((item) =>
        item.roster ? [rosterStructuralFingerprint(item.roster)] : [],
      )
      .sort();
  }
  return target.portfolio.items
    .map((item) => rosterStructuralFingerprint(item.roster))
    .sort();
}

function workflowStructureMatches(
  previous: RosterWorkflowResult,
  next: RosterWorkflowResult,
): boolean {
  return Boolean(
    previous.roster &&
      next.roster &&
      rosterStructuralFingerprint(previous.roster) ===
        rosterStructuralFingerprint(next.roster) &&
      JSON.stringify(targetStructuralFingerprints(previous)) ===
        JSON.stringify(targetStructuralFingerprints(next)),
  );
}

type MutationInspection = Awaited<
  ReturnType<typeof inspectNewRecruitMutationReceipt>
>;

type ArtifactReuseState = NonNullable<
  RosterJourneyV1["compatibilityRepair"]
>["artifactReuse"];

function mutationReceiptBlocksRetry(
  inspection: MutationInspection | null,
): boolean {
  return Boolean(
    inspection?.latestAttempt && !inspection.safeToRetry,
  );
}

function unresolvedArtifactReuseState(input: {
  inspection: MutationInspection | null;
  previous?: ArtifactReuseState;
}): ArtifactReuseState {
  const conclusivelyNotCreated = Boolean(
    input.inspection?.latestAttempt && input.inspection.safeToRetry,
  );
  return mutationReceiptBlocksRetry(input.inspection) ||
      (
        input.previous === "blocked-by-receipt" &&
        !conclusivelyNotCreated
      )
    ? "blocked-by-receipt"
    : "not-found";
}

async function reconcileNewRecruitArtifactAcrossMigration(input: {
  previousRoster: RosterDraftV1;
  nextRoster: RosterDraftV1;
  recordedInspection: MutationInspection | null;
  recordedReuse?: ArtifactReuseState;
  dependencies: NonNullable<RosterJourneyStoreOptions["dependencies"]>;
}): Promise<{
  inspection: MutationInspection | null;
  artifactReuse: ArtifactReuseState;
}> {
  let inspection = input.recordedInspection;
  try {
    const refreshed = await (
      input.dependencies.inspectNewRecruitMutationReceipt ??
      inspectNewRecruitMutationReceipt
    )(input.previousRoster);
    inspection =
      !refreshed.receiptFound && input.recordedInspection?.receiptFound
        ? input.recordedInspection
        : refreshed;
  } catch {
    return {
      inspection,
      artifactReuse: "blocked-by-receipt",
    };
  }
  try {
    const adopted = await (
      input.dependencies.adoptNewRecruitMutationArtifactAcrossRosterRevision ??
      adoptNewRecruitMutationArtifactAcrossRosterRevision
    )(input.previousRoster, input.nextRoster);
    if (adopted?.ok) {
      return {
        inspection,
        artifactReuse: "verified-reused",
      };
    }
  } catch {
    return {
      inspection,
      artifactReuse: "blocked-by-receipt",
    };
  }
  return {
    inspection,
    artifactReuse: unresolvedArtifactReuseState({
      inspection,
      previous: input.recordedReuse,
    }),
  };
}

type TargetRosterMigration = {
  ok: boolean;
  roster: RosterDraftV1 | null;
  changedScopes: RosterDataChangedScope[];
  reviewRequired: boolean;
  failureCode: string | null;
};

async function migrateTargetRoster(input: {
  roster: RosterDraftV1;
  targetBundleId: string;
  dependencies: NonNullable<RosterJourneyStoreOptions["dependencies"]>;
}): Promise<TargetRosterMigration> {
  const rebased = await (
    input.dependencies.rebaseRosterWithProvider ??
    rebaseRosterWithProvider
  )(input.roster, undefined, input.targetBundleId);
  const roster =
    rebased.data?.candidateRoster ?? rebased.data?.roster ?? null;
  if (
    !rebased.ok ||
    !rebased.data ||
    !roster ||
    roster.sourceData.bundleId !== input.targetBundleId
  ) {
    return {
      ok: false,
      roster: null,
      changedScopes: rebased.data?.changedScopes ?? [],
      reviewRequired: false,
      failureCode:
        rebased.violations[0]?.code ??
        "COMPATIBLE_TARGET_REBASE_FAILED",
    };
  }
  const validation = (
    input.dependencies.validateRoster ?? validateRoster
  )(roster);
  return {
    ok: validation.ok,
    roster: validation.ok ? roster : null,
    changedScopes: rebased.data.changedScopes,
    reviewRequired:
      rebased.data.status === "review-required" ||
      rosterStructuralFingerprint(input.roster) !==
        rosterStructuralFingerprint(roster),
    failureCode: validation.ok
      ? null
      : validation.violations[0]?.code ?? "TARGET_ROSTER_INVALID",
  };
}

type WorkflowTargetMigration = {
  ok: boolean;
  workflow: RosterWorkflowResult;
  changedScopes: RosterDataChangedScope[];
  reviewRequired: boolean;
  failureCode: string | null;
};

async function migrateWorkflowTargets(input: {
  workflow: RosterWorkflowResult;
  targetBundleId: string;
  dependencies: NonNullable<RosterJourneyStoreOptions["dependencies"]>;
}): Promise<WorkflowTargetMigration> {
  const target =
    input.workflow.optimization?.target ?? input.workflow.analysis?.target;
  if (!target) {
    return {
      ok: true,
      workflow: input.workflow,
      changedScopes: [],
      reviewRequired: false,
      failureCode: null,
    };
  }
  const applyTarget = (
    nextTarget: typeof target,
  ): RosterWorkflowResult => input.workflow.optimization
    ? {
        ...input.workflow,
        optimization: {
          ...input.workflow.optimization,
          target: nextTarget,
        },
      }
    : {
        ...input.workflow,
        analysis: input.workflow.analysis
          ? {
              ...input.workflow.analysis,
              target: nextTarget,
            }
          : null,
      };

  if (target.kind === "exact-opponent") {
    const migrated = await migrateTargetRoster({
      roster: target.roster,
      targetBundleId: input.targetBundleId,
      dependencies: input.dependencies,
    });
    if (!migrated.ok || !migrated.roster) {
      return {
        ok: false,
        workflow: input.workflow,
        changedScopes: migrated.changedScopes,
        reviewRequired: false,
        failureCode: migrated.failureCode,
      };
    }
    return {
      ok: true,
      workflow: applyTarget({ ...target, roster: migrated.roster }),
      changedScopes: migrated.changedScopes,
      reviewRequired: migrated.reviewRequired,
      failureCode: migrated.failureCode,
    };
  }

  if (target.kind === "general-six-archetype") {
    const changedScopes: RosterDataChangedScope[] = [];
    let reviewRequired = false;
    let failureCode: string | null = null;
    const items = [] as typeof target.portfolio.items;
    for (const item of target.portfolio.items) {
      const migrated = await migrateTargetRoster({
        roster: item.roster,
        targetBundleId: input.targetBundleId,
        dependencies: input.dependencies,
      });
      changedScopes.push(...migrated.changedScopes);
      reviewRequired ||= migrated.reviewRequired;
      failureCode ??= migrated.failureCode;
      if (!migrated.ok || !migrated.roster) {
        return {
          ok: false,
          workflow: input.workflow,
          changedScopes,
          reviewRequired: false,
          failureCode,
        };
      }
      items.push({
        ...item,
        roster: migrated.roster,
        simulationFingerprint:
          rosterSimulationFingerprint(migrated.roster),
        traits: inspectStressPortfolioTraits(migrated.roster),
      });
    }
    const portfolio = {
      ...target.portfolio,
      items,
      portfolioHash: generalThreatPortfolioHash(
        target.portfolio.pointsLimit,
        items,
      ),
    };
    return {
      ok: true,
      workflow: applyTarget({ ...target, portfolio }),
      changedScopes,
      reviewRequired,
      failureCode,
    };
  }

  const changedScopes: RosterDataChangedScope[] = [];
  let reviewRequired = false;
  let failureCode: string | null = null;
  const portfolioItems = [] as typeof target.portfolioPreview.portfolio.items;
  for (const item of target.portfolioPreview.portfolio.items) {
    if (!item.roster) {
      portfolioItems.push(item);
      continue;
    }
    const migrated = await migrateTargetRoster({
      roster: item.roster,
      targetBundleId: input.targetBundleId,
      dependencies: input.dependencies,
    });
    changedScopes.push(...migrated.changedScopes);
    reviewRequired ||= migrated.reviewRequired;
    failureCode ??= migrated.failureCode;
    if (!migrated.ok || !migrated.roster) {
      return {
        ok: false,
        workflow: input.workflow,
        changedScopes,
        reviewRequired: false,
        failureCode,
      };
    }
    const validation = (
      input.dependencies.validateRoster ?? validateRoster
    )(migrated.roster);
    portfolioItems.push({
      ...item,
      roster: migrated.roster,
      fingerprint: rosterStructuralFingerprint(migrated.roster),
      simulationFingerprint:
        rosterSimulationFingerprint(migrated.roster),
      traits: inspectStressPortfolioTraits(migrated.roster),
      containsNamedCharacter:
        rosterHasNamedCharacter(migrated.roster),
      warnings: validation.warnings.map((warning) => ({
        ...warning,
        message: `[${item.templateId}] ${warning.message}`,
      })),
    });
  }
  const firstRoster = portfolioItems.find(
    (item) => item.roster !== null,
  )?.roster;
  let contract = target.portfolioPreview.portfolio.contract;
  if (contract && firstRoster) {
    const { fingerprint: _fingerprint, ...binding } = contract;
    void _fingerprint;
    const nextBinding = {
      ...binding,
      sourceReleaseId: firstRoster.sourceData.releaseId,
    };
    contract = {
      ...nextBinding,
      fingerprint:
        tesseraStressPortfolioContractFingerprint(nextBinding),
    };
  }
  const portfolio = {
    ...target.portfolioPreview.portfolio,
    ...(firstRoster ? { sourceData: firstRoster.sourceData } : {}),
    ...(contract ? { contract } : {}),
    items: portfolioItems,
  };
  const readyRosters = portfolioItems.flatMap((item) =>
    item.roster ? [{ templateId: item.templateId, roster: item.roster }] : [],
  );
  const previewItems = target.portfolioPreview.items.map((item) => {
    const match = readyRosters.find(
      (candidate) => candidate.templateId === item.templateId,
    );
    if (!match) return item;
    const others = readyRosters.filter(
      (candidate) => candidate.templateId !== item.templateId,
    );
    return {
      ...item,
      structuralFingerprint:
        rosterStructuralFingerprint(match.roster),
      simulationFingerprint:
        rosterSimulationFingerprint(match.roster),
      minimumPairwiseDiversity: others.length === 0
        ? null
        : Math.min(
            ...others.map((candidate) =>
              rosterSimulationDistance(
                match.roster,
                candidate.roster,
              ),
            ),
          ),
      profileRequirements: rosterProfileRequirements(match.roster),
      containsNamedCharacter: rosterHasNamedCharacter(match.roster),
    };
  });
  const evaluation = evaluateTesseraStressPortfolioContract(portfolio);
  portfolio.coverage.uniqueSimulationPayloads =
    evaluation.uniqueSimulationPayloads;
  portfolio.coverage.maximumResultStatus =
    evaluation.maximumResultStatus ?? "degraded";
  portfolio.coverage.representedPostures =
    evaluation.representedPostures;
  portfolio.coverage.missingPostures = evaluation.missingPostures;
  const portfolioPreview = {
    ...target.portfolioPreview,
    portfolio,
    items: previewItems,
    gates: {
      ...target.portfolioPreview.gates,
      minimumUniqueRequired: evaluation.minimumUniqueRequired,
      uniqueSimulationPayloads:
        evaluation.uniqueSimulationPayloads,
      executionViable: evaluation.executionViable,
      completeCoverage: evaluation.completeCoverage,
      allPosturesRepresented:
        evaluation.allPosturesRepresented,
      representedPostures: evaluation.representedPostures,
      missingPostures: evaluation.missingPostures,
      maximumResultStatus:
        evaluation.maximumResultStatus ?? "degraded",
      accepted: evaluation.accepted,
    },
  };
  return {
    ok: true,
    workflow: applyTarget({ ...target, portfolioPreview }),
    changedScopes,
    reviewRequired: reviewRequired || !evaluation.accepted,
    failureCode:
      failureCode ?? evaluation.violation?.code ?? null,
  };
}

function webRequestsForWorkflow(
  workflow: RosterWorkflowResult,
): TesseraRunRequest[] {
  if (!workflow.roster) return [];
  const target = workflow.optimization?.target ?? workflow.analysis?.target;
  if (!target) return [];
  if (target.kind === "exact-opponent") {
    return [{
      kind: "exact",
      playerRoster: workflow.roster,
      opponent: { kind: "roster", roster: target.roster },
      options: {
        simulationBackend: "website",
        executionMode: "simulate",
        experimental: false,
        analysisMode: "full",
        includeChangeCandidates: true,
      },
    }];
  }
  if (target.kind === "known-faction") {
    return [{
      kind: "stress",
      playerRoster: workflow.roster,
      factionId: target.factionId,
      options: {
        suite: "diverse-9",
        analysisStrategy: "staged",
        simulationBackend: "website",
        executionMode: "simulate",
        experimental: false,
        portfolioPreview: target.portfolioPreview,
      },
    }];
  }
  return target.portfolio.items.map((item) => ({
    kind: "exact" as const,
    playerRoster: workflow.roster!,
    opponent: { kind: "roster" as const, roster: item.roster },
    options: {
      simulationBackend: "website" as const,
      executionMode: "simulate" as const,
      experimental: false,
      analysisMode: "full" as const,
      includeChangeCandidates: true,
    },
  }));
}

export async function repairRosterJourneyTesseraWebCompatibility(
  journeyId: string,
  expectedRevision: number,
  input: RepairTesseraWebCompatibilityInput,
  options: RosterJourneyStoreOptions = {},
): Promise<RosterJourneyV1> {
  return withJourneyLock(journeyId, options, async () => {
    const current = await getRosterJourney(journeyId, options);
    assertExpectedRevision(current, expectedRevision);
    if (!current.workflow.roster) {
      throw Object.assign(new Error("The journey has no retained roster."), {
        code: "ROSTER_JOURNEY_ROSTER_REQUIRED",
      });
    }
    const now = new Date().toISOString();
    const previousRoster = current.workflow.roster;
    const dependencies = options.dependencies ?? {};
    const priorMutation = await (
      dependencies.inspectNewRecruitMutationReceipt ??
      inspectNewRecruitMutationReceipt
    )(previousRoster);
    const recordedArtifactReuse =
      current.compatibilityRepair?.artifactReuse;
    const predecessor = input.predecessorJobPath
      ? await (
          dependencies.getTesseraRunStatus ?? getTesseraRunStatus
        )(input.predecessorJobPath)
      : null;
    if (
      predecessor &&
      !["failed", "degraded", "inconclusive", "cancelled"].includes(
        predecessor.job.status,
      )
    ) {
      throw Object.assign(
        new Error("Only a terminal Tessera job can be superseded."),
        { code: "TESSERA_PREDECESSOR_NOT_TERMINAL" },
      );
    }
    const resolution: LocalServiceCompatibilityResolution = await (
      dependencies.ensureLocalServiceCompatibility ??
      ensureLocalServiceCompatibility
    )({
      factionId: previousRoster.factionId,
      ...(input.observedNewRecruitIdentity
        ? { observedRevisionHint: input.observedNewRecruitIdentity }
        : {}),
    });
    const nextRevision = current.stateRevision + 1;
    const { stateSha256: _stateSha256, ...payload } = current;
    void _stateSha256;
    const observedNewRecruitIdentity = resolution.observedIdentity
      ? {
          gameSystemRevision:
            resolution.observedIdentity.gameSystem.revision,
          catalogueRevision:
            resolution.observedIdentity.factionCatalogue.revision,
        }
      : null;
    if (resolution.status !== "ready") {
      const recovery = projectCompatibilityRepairRecovery(current.workflow, {
        journeyId,
        journeyRevision: nextRevision,
        status: resolution.status,
      });
      const waiting = seal({
        ...payload,
        stateRevision: nextRevision,
        status: resolution.status,
        updatedAt: now,
        recovery,
        actions: [
          ...current.actions,
          {
            attemptId: randomUUID(),
            actionId:
              resolution.status === "updating-local-data"
                ? "data.follow-local-update"
                : "workflow.wait-for-compatible-source",
            status: "blocked",
            recordedAt: now,
            details:
              resolution.jobId ??
              (resolution.status === "updating-local-data"
                ? "LOCAL_DATA_UPDATE_IN_PROGRESS"
                : "NO_COMPATIBLE_HISTORICAL_SOURCE"),
          },
        ],
        compatibilityRepair: {
          status: resolution.status,
          requestedAt: now,
          observedNewRecruitIdentity,
          previousBundleId: previousRoster.sourceData.bundleId,
          activeBundleId: null,
          predecessorRunId: predecessor?.job.runId ?? null,
          changedScopes: [],
          priorMutation,
          artifactReuse: unresolvedArtifactReuseState({
            inspection: priorMutation,
            previous: recordedArtifactReuse,
          }),
          proposedWorkflow: null,
          successorJobRefs: [],
          localUpdateJobId: resolution.jobId,
          compatibleBundleId: null,
          message: resolution.message,
        },
      });
      await persist(waiting, options);
      return waiting;
    }

    const rebased = await (
      dependencies.rebaseRosterWithProvider ?? rebaseRosterWithProvider
    )(
      previousRoster,
      undefined,
      resolution.compatibleBundleId,
    );
    const candidateRoster =
      rebased.data?.candidateRoster ?? rebased.data?.roster ?? null;
    const identityMatches = Boolean(
      candidateRoster &&
        candidateRoster.sourceData.newRecruit.gameSystemRevision ===
          resolution.observedIdentity.gameSystem.revision &&
        candidateRoster.sourceData.newRecruit.catalogueRevision ===
          resolution.observedIdentity.factionCatalogue.revision,
    );
    if (!rebased.ok || !rebased.data || !candidateRoster || !identityMatches) {
      const recovery = projectCompatibilityRepairRecovery(current.workflow, {
        journeyId,
        journeyRevision: nextRevision,
        status: "waiting-for-compatible-source",
      });
      const waiting = seal({
        ...payload,
        stateRevision: nextRevision,
        status: "waiting-for-compatible-source",
        updatedAt: now,
        recovery,
        actions: [
          ...current.actions,
          {
            attemptId: randomUUID(),
            actionId: "workflow.wait-for-compatible-source",
            status: "blocked",
            recordedAt: now,
            details:
              rebased.violations[0]?.code ??
              "COMPATIBLE_SNAPSHOT_REBASE_FAILED",
          },
        ],
        compatibilityRepair: {
          status: "waiting-for-compatible-source",
          requestedAt: now,
          observedNewRecruitIdentity,
          previousBundleId: previousRoster.sourceData.bundleId,
          activeBundleId: null,
          predecessorRunId: predecessor?.job.runId ?? null,
          changedScopes: rebased.data?.changedScopes ?? [],
          priorMutation,
          artifactReuse: unresolvedArtifactReuseState({
            inspection: priorMutation,
            previous: recordedArtifactReuse,
          }),
          proposedWorkflow: null,
          successorJobRefs: [],
          localUpdateJobId: null,
          compatibleBundleId: resolution.compatibleBundleId,
          message:
            "The retained compatibility snapshot could not be opened and verified. The roster and mutation receipts remain saved; retry after the local data repair finishes.",
        },
      });
      await persist(waiting, options);
      return waiting;
    }

    const targetMigration = await migrateWorkflowTargets({
      workflow: current.workflow,
      targetBundleId: resolution.compatibleBundleId,
      dependencies,
    });
    if (!targetMigration.ok) {
      const recovery = projectCompatibilityRepairRecovery(current.workflow, {
        journeyId,
        journeyRevision: nextRevision,
        status: "waiting-for-compatible-source",
      });
      const waiting = seal({
        ...payload,
        stateRevision: nextRevision,
        status: "waiting-for-compatible-source",
        updatedAt: now,
        recovery,
        actions: [
          ...current.actions,
          {
            attemptId: randomUUID(),
            actionId: "workflow.wait-for-compatible-source",
            status: "blocked",
            recordedAt: now,
            details:
              targetMigration.failureCode ??
              "COMPATIBLE_TARGET_REBASE_FAILED",
          },
        ],
        compatibilityRepair: {
          status: "waiting-for-compatible-source",
          requestedAt: now,
          observedNewRecruitIdentity,
          previousBundleId: previousRoster.sourceData.bundleId,
          activeBundleId: null,
          predecessorRunId: predecessor?.job.runId ?? null,
          changedScopes: [
            ...rebased.data.changedScopes,
            ...targetMigration.changedScopes,
          ],
          priorMutation,
          artifactReuse: unresolvedArtifactReuseState({
            inspection: priorMutation,
            previous: recordedArtifactReuse,
          }),
          proposedWorkflow: null,
          successorJobRefs: [],
          localUpdateJobId: null,
          compatibleBundleId: resolution.compatibleBundleId,
          message:
            "The player roster matched the compatibility snapshot, but at least one frozen opponent could not be opened and revalidated from that same snapshot. The retained workflow and mutation receipts were preserved.",
        },
      });
      await persist(waiting, options);
      return waiting;
    }

    const validation = (
      dependencies.validateRoster ?? validateRoster
    )(candidateRoster);
    const candidate: RosterWorkflowResult = {
      ...targetMigration.workflow,
      roster: candidateRoster,
      validation: {
        ok: validation.ok,
        violations: validation.violations,
        warnings: validation.warnings,
      },
      newRecruit: {
        ...targetMigration.workflow.newRecruit,
        handoff:
          candidateRoster.sourceData.bundleId ===
          previousRoster.sourceData.bundleId
            ? current.workflow.newRecruit.handoff
            : null,
      },
    };
    const structureMatches = workflowStructureMatches(
      current.workflow,
      candidate,
    );
    if (
      rebased.data.status === "review-required" ||
      targetMigration.reviewRequired ||
      !structureMatches ||
      !validation.ok
    ) {
      const recovery = projectCompatibilityRepairRecovery(candidate, {
        journeyId,
        journeyRevision: nextRevision,
        status: "needs-data-review",
      });
      const review = seal({
        ...payload,
        stateRevision: nextRevision,
        status: "needs-data-review",
        updatedAt: now,
        recovery,
        actions: [
          ...current.actions,
          {
            attemptId: randomUUID(),
            actionId: "roster.review-data-migration",
            status: "blocked",
            recordedAt: now,
            details: "ROSTER_DATA_REVIEW_REQUIRED",
          },
        ],
        compatibilityRepair: {
          status: "needs-data-review",
          requestedAt: now,
          observedNewRecruitIdentity,
          previousBundleId: previousRoster.sourceData.bundleId,
          activeBundleId: resolution.compatibleBundleId,
          predecessorRunId: predecessor?.job.runId ?? null,
          changedScopes: [
            ...rebased.data.changedScopes,
            ...targetMigration.changedScopes,
          ],
          priorMutation,
          artifactReuse: unresolvedArtifactReuseState({
            inspection: priorMutation,
            previous: recordedArtifactReuse,
          }),
          proposedWorkflow: candidate,
          successorJobRefs: [],
          localUpdateJobId: null,
          compatibleBundleId: resolution.compatibleBundleId,
          message: validation.ok
            ? "Locally verified compatible data is available, but its roster semantics require review. Review the proposed workflow before approval."
            : "Locally verified compatible data is available, but the migrated roster did not revalidate cleanly. Review the legality findings before approving any change.",
        },
      });
      await persist(review, options);
      return review;
    }

    const artifactReconciliation =
      await reconcileNewRecruitArtifactAcrossMigration({
        previousRoster,
        nextRoster: candidateRoster,
        recordedInspection: priorMutation,
        recordedReuse: recordedArtifactReuse,
        dependencies,
      });
    const rosterRevisionId = randomUUID();
    const recovery = projectCompatibilityRepairRecovery(candidate, {
      journeyId,
      journeyRevision: nextRevision,
      status: "ready-for-web",
    });
    const ready = seal({
      ...payload,
      stateRevision: nextRevision,
      status: "ready-for-web",
      updatedAt: now,
      workflow: candidate,
      recovery,
      activeRosterRevisionId: rosterRevisionId,
      rosterRevisions: [
        ...current.rosterRevisions,
        {
          revisionId: rosterRevisionId,
          parentRevisionId: current.activeRosterRevisionId,
          rosterId: candidateRoster.id,
          bundleId: candidateRoster.sourceData.bundleId,
          reason: "compatible-rebase",
          approvalReference: null,
        },
      ],
      compatibilityAssessments: [
        ...current.compatibilityAssessments,
        {
          recordedAt: now,
          bundleId: candidateRoster.sourceData.bundleId,
          status: "compatible-rebased",
        },
      ],
      actions: [
        ...current.actions,
        {
          attemptId: randomUUID(),
          actionId: "data.refresh-compatible",
          status: "succeeded",
          recordedAt: now,
          details: candidateRoster.sourceData.bundleId,
        },
      ],
      compatibilityRepair: {
        status: "ready-for-web",
        requestedAt: now,
        observedNewRecruitIdentity,
        previousBundleId: previousRoster.sourceData.bundleId,
        activeBundleId: resolution.compatibleBundleId,
        predecessorRunId: predecessor?.job.runId ?? null,
        changedScopes: [
          ...rebased.data.changedScopes,
          ...targetMigration.changedScopes,
        ],
        priorMutation: artifactReconciliation.inspection,
        artifactReuse: artifactReconciliation.artifactReuse,
        proposedWorkflow: null,
        successorJobRefs: [],
        localUpdateJobId: null,
        compatibleBundleId: resolution.compatibleBundleId,
        message:
          "A locally verified, service-compatible snapshot was selected and every unchanged player and opponent roster was revalidated from it. A separate approval is required to start Tessera Web.",
      },
    });
    await (
      dependencies.retainDataBundleReference ?? retainDataBundleReference
    )(
      `roster-journey:${journeyId}`,
      candidateRoster.sourceData.bundleId,
    );
    await persist(ready, options);
    return ready;
  });
}

export async function approveRosterJourneyDataMigration(
  journeyId: string,
  expectedRevision: number,
  approval: { approvalId: string; approvedBy: string },
  options: RosterJourneyStoreOptions = {},
): Promise<RosterJourneyV1> {
  return withJourneyLock(journeyId, options, async () => {
    const current = await getRosterJourney(journeyId, options);
    assertExpectedRevision(current, expectedRevision);
    const proposed = current.compatibilityRepair?.proposedWorkflow;
    if (
      current.status !== "needs-data-review" ||
      !proposed?.roster ||
      !proposed.validation?.ok
    ) {
      throw Object.assign(
        new Error("This journey has no valid data migration awaiting approval."),
        { code: "ROSTER_DATA_MIGRATION_NOT_PENDING" },
      );
    }
    if (!approval.approvalId.trim() || !approval.approvedBy.trim()) {
      throw Object.assign(new Error("Migration approval must identify the approval and approver."), {
        code: "ROSTER_DATA_MIGRATION_APPROVAL_INVALID",
      });
    }
    const previousRoster = current.workflow.roster;
    if (!previousRoster) {
      throw Object.assign(
        new Error("The retained pre-migration roster is unavailable."),
        { code: "ROSTER_JOURNEY_ROSTER_REQUIRED" },
      );
    }
    const dependencies = options.dependencies ?? {};
    const artifactReconciliation =
      await reconcileNewRecruitArtifactAcrossMigration({
        previousRoster,
        nextRoster: proposed.roster,
        recordedInspection:
          current.compatibilityRepair?.priorMutation ?? null,
        recordedReuse:
          current.compatibilityRepair?.artifactReuse,
        dependencies,
      });
    const now = new Date().toISOString();
    const revisionId = randomUUID();
    const nextRevision = current.stateRevision + 1;
    const recovery = projectCompatibilityRepairRecovery(proposed, {
      journeyId,
      journeyRevision: nextRevision,
      status: "ready-for-web",
    });
    const { stateSha256: _stateSha256, ...payload } = current;
    void _stateSha256;
    const next = seal({
      ...payload,
      stateRevision: nextRevision,
      status: "ready-for-web",
      updatedAt: now,
      workflow: proposed,
      recovery,
      activeRosterRevisionId: revisionId,
      rosterRevisions: [
        ...current.rosterRevisions,
        {
          revisionId,
          parentRevisionId: current.activeRosterRevisionId,
          rosterId: proposed.roster.id,
          bundleId: proposed.roster.sourceData.bundleId,
          reason: "approved-change",
          approvalReference: approval.approvalId,
        },
      ],
      actions: [
        ...current.actions,
        {
          attemptId: randomUUID(),
          actionId: "roster.review-data-migration",
          status: "succeeded",
          recordedAt: now,
          details: `Approved by ${approval.approvedBy}`,
        },
      ],
      compatibilityRepair: {
        ...current.compatibilityRepair!,
        status: "ready-for-web",
        activeBundleId: proposed.roster.sourceData.bundleId,
        priorMutation: artifactReconciliation.inspection,
        artifactReuse: artifactReconciliation.artifactReuse,
        proposedWorkflow: null,
        message:
          artifactReconciliation.artifactReuse === "blocked-by-receipt"
            ? "The reviewed roster migration was approved and revalidated, but an uncertain prior New Recruit mutation still blocks Web preparation until its retained receipt is reconciled."
            : artifactReconciliation.artifactReuse === "verified-reused"
              ? "The reviewed roster migration was approved and revalidated, and its hash-verified New Recruit artifact was safely adopted without creating another list. A separate approval is required to start Tessera Web."
              : "The reviewed roster migration was approved and revalidated. A separate approval is required to start Tessera Web.",
      },
    });
    await (
      options.dependencies?.retainDataBundleReference ??
      retainDataBundleReference
    )(
      `roster-journey:${journeyId}`,
      proposed.roster.sourceData.bundleId,
    );
    await persist(next, options);
    return next;
  });
}

export async function startRosterJourneyRepairedTesseraWebRun(
  journeyId: string,
  expectedRevision: number,
  input: {
    confirmExternalPreparation: true;
    outputDirectory?: string;
  },
  options: RosterJourneyStoreOptions = {},
): Promise<RosterJourneyV1> {
  return withJourneyLock(journeyId, options, async () => {
    const current = await getRosterJourney(journeyId, options);
    assertExpectedRevision(current, expectedRevision);
    if (
      current.status !== "ready-for-web" ||
      current.compatibilityRepair?.status !== "ready-for-web" ||
      input.confirmExternalPreparation !== true
    ) {
      throw Object.assign(
        new Error("The repaired Web run requires a ready journey and fresh explicit confirmation."),
        { code: "TESSERA_REPAIRED_WEB_APPROVAL_REQUIRED" },
      );
    }
    if (current.compatibilityRepair.artifactReuse === "blocked-by-receipt") {
      throw Object.assign(
        new Error("A prior New Recruit outcome requires reconciliation; another list will not be created."),
        { code: "NEW_RECRUIT_MUTATION_RECONCILIATION_REQUIRED" },
      );
    }
    const requests = webRequestsForWorkflow(current.workflow);
    if (requests.length === 0) {
      throw Object.assign(new Error("The journey has no Tessera analysis target."), {
        code: "TESSERA_TARGET_REQUIRED",
      });
    }
    const jobs: TesseraRunJob[] = [];
    for (const request of requests) {
      jobs.push(
        await (
          options.dependencies?.startTesseraRun ?? startTesseraRun
        )(request, {
          outputDirectory:
            input.outputDirectory ??
            path.join(process.cwd(), "exports", "tessera", "runs"),
          supersedesRunId:
            current.compatibilityRepair.predecessorRunId,
        }),
      );
    }
    const now = new Date().toISOString();
    const nextRevision = current.stateRevision + 1;
    const recovery = projectCompatibilityRepairRecovery(current.workflow, {
      journeyId,
      journeyRevision: nextRevision,
      status: "running-successor",
    });
    const { stateSha256: _stateSha256, ...payload } = current;
    void _stateSha256;
    const next = seal({
      ...payload,
      stateRevision: nextRevision,
      status: "running-successor",
      updatedAt: now,
      recovery,
      tesseraJobRefs: [
        ...new Set([
          ...current.tesseraJobRefs,
          ...jobs.map((job) => job.requestPath),
        ]),
      ],
      actions: [
        ...current.actions,
        {
          attemptId: randomUUID(),
          actionId: "tessera.start-successor",
          status: "succeeded",
          recordedAt: now,
          details: `${jobs.length} successor Web job(s) started`,
        },
      ],
      compatibilityRepair: {
        ...current.compatibilityRepair,
        status: "running-successor",
        successorJobRefs: jobs.map((job) => job.requestPath),
        message:
          "A new Tessera Web job was started against the repaired bundle. The blocked predecessor remains unchanged.",
      },
    });
    await persist(next, options);
    return next;
  });
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
