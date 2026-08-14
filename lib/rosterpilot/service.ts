import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  buildRoster,
  compareFactions,
  explainRoster,
  exportRoster,
  getDataStatus,
  modifyRosterBatch,
  parseRosterPrompt,
  rosterSemanticFingerprint,
  searchFactions,
  searchUnits,
  validateRoster,
} from "./engine";
import {
  getDataUpdateStatus,
  rebaseRosterWithProvider,
  refreshDataNow,
  withDataBundleSnapshotLease,
} from "./data-operations";
import { parseRosterDraft } from "./draft";
import {
  compareOpponentRosterOptions,
  type OpponentComparisonRoster,
} from "./opponent-option-comparison";
import { generateFactionStressPortfolio } from "./stress-portfolio";
import {
  BuildRunOptionsSchema,
  ModifyRosterOperationSchema,
} from "./types";
import {
  analyzeExactRosterMatchup,
  type LocalMatchupReport,
} from "./matchup";
import type {
  BuildRosterInput,
  ExportArtifact,
  ExportFormat,
  ModifyRosterOperation,
  NewRecruitConnectionStatus,
  NewRecruitDelivery,
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
} from "./types";

export const ROSTERPILOT_SERVICE_VERSION = "1.0.0";
export const STORED_ROSTER_SCHEMA_VERSION = 4 as const;
export const OPERATION_SCHEMA_VERSION = 1 as const;

export type RunAction =
  | "research"
  | "build"
  | "modify"
  | "export"
  | "matchup"
  | "stress"
  | "sync";

export type RunRequest = {
  action: RunAction;
  request?: string;
  rosterRef?: string;
  opponentRef?: string;
  format?: ExportFormat;
  options?: Record<string, unknown>;
};

export type InspectRequest = {
  ref: string;
  view?: "summary" | "details" | "artifact";
};

export type ActRequest = {
  operationId: string;
  expectedRevision: number;
  actionId: string;
  choice?: string;
  confirm?: boolean;
};

export type OperationState =
  | "running"
  | "completed"
  | "action-required"
  | "failed";

export type NextAction = {
  actionId: string;
  label: string;
  requiresConfirmation: boolean;
  choices?: string[];
};

export type ArtifactReference = {
  artifactId: string;
  uri: string;
  filename: string;
  mimeType: string;
  encoding: "utf8" | "binary";
  bytes: number;
  written?: string;
};

export type RosterSummary = {
  rosterId: string;
  rosterRef: string;
  name: string;
  factionId: string;
  factionName: string;
  points: string;
  detachment: string;
  disposition: string;
  legal: boolean;
  unitCount: number;
  units: Array<{
    selectionId: string;
    unitId: string;
    name: string;
    models: number;
    points: number;
    warlord: boolean;
  }>;
};

export type OperationSummary = {
  schemaVersion: typeof OPERATION_SCHEMA_VERSION;
  operationId: string;
  revision: number;
  action: RunAction | "new-recruit-upload" | "import";
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  bundleId: string | null;
  message: string;
  roster: RosterSummary | null;
  opponent: RosterSummary | null;
  result: Record<string, unknown> | null;
  artifacts: ArtifactReference[];
  nextActions: NextAction[];
  violations: RosterIssue[];
  warnings: RosterIssue[];
};

type NewRecruitMutationState = {
  status:
    | "approved"
    | "started"
    | "verified"
    | "failed-before-mutation"
    | "uncertain";
  startedAt: string | null;
  completedAt: string | null;
  listUrl: string | null;
};

type OperationDocument = OperationSummary & {
  request: RunRequest | null;
  rosterRef: string | null;
  opponentRef: string | null;
  newRecruitMutation: NewRecruitMutationState | null;
};

type StoredRosterDocumentV4 = {
  schemaVersion: typeof STORED_ROSTER_SCHEMA_VERSION;
  storedAt: string;
  importedFromSchemaVersion: number | null;
  roster: RosterDraftV1;
};

type StoredArtifactDocument = ArtifactReference & {
  storedAt: string;
  path: string;
};

type ServiceDirectories = {
  operations: string;
  actionLocks: string;
  rosters: string;
  artifacts: string;
};

export type MatchupRunner = (
  playerRoster: RosterDraftV1,
  opponentRoster: RosterDraftV1,
  options: {
    outputDirectory: string;
    overwrite: boolean;
    allowPointMismatch: boolean;
  },
) => Promise<ResultEnvelope<LocalMatchupReport>>;

export type StressCatalogueDriftMode = "reject" | "diagnostic";

export type StressRunner = (
  playerRoster: RosterDraftV1,
  opponentFactionId: string,
  options: {
    outputDirectory: string;
    overwrite: boolean;
    backend: "local-engine" | "website";
    suite: "core-3" | "diverse-9";
    strategy: "staged" | "full-all";
    resumeManifestPath?: string;
    profilePolicyPath?: string;
    forceRetry: boolean;
    catalogueDriftMode: StressCatalogueDriftMode;
  },
) => Promise<ResultEnvelope<unknown>>;

export type ExactStressRunner = (
  playerRoster: RosterDraftV1,
  opponentRoster: RosterDraftV1,
  options: {
    outputDirectory: string;
    overwrite: boolean;
    backend: "local-engine" | "website";
    profilePolicyPath?: string;
    baselineReportPath?: string;
    allowPointMismatch: boolean;
    catalogueDriftMode: StressCatalogueDriftMode;
    selectedPlayerAbilityIds: string[];
    activationMode: "baseline" | "envelope";
  },
) => Promise<ResultEnvelope<unknown>>;

export type NewRecruitDeliverer = (
  roster: RosterDraftV1,
  options: {
    downloadEnrichedRosz: boolean;
    downloadPrettyHtml: boolean;
    outputDirectory: string;
    rootDir: string;
    overwrite: boolean;
  },
) => Promise<ResultEnvelope<NewRecruitDelivery>>;

export type RosterPilotServiceOptions = {
  rootDirectory: string;
  now?: () => Date;
  createId?: () => string;
  runMatchup?: MatchupRunner;
  runStress?: StressRunner;
  runExactStress?: ExactStressRunner;
  deliverToNewRecruit?: NewRecruitDeliverer;
  newRecruitStatus?: () => Promise<ResultEnvelope<NewRecruitConnectionStatus>>;
  lease?: <T>(operation: () => Promise<T> | T) => Promise<T>;
};

function issue(
  code: string,
  message: string,
  severity: "error" | "warn" = "error",
): RosterIssue {
  return { code, message, severity };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

type StressConfiguration = {
  options: Record<string, unknown>;
  backend: "local-engine" | "website";
  opponentFactionId: string | undefined;
  exactOpponent: boolean;
  suite: "core-3" | "diverse-9";
  strategy: "staged" | "full-all";
  catalogueDriftMode: StressCatalogueDriftMode;
  selectedPlayerAbilityIds: string[];
  activationMode: "baseline" | "envelope";
};

type StressConfigurationResult =
  | { ok: true; data: StressConfiguration }
  | { ok: false; code: string; message: string };

function parseStressConfiguration(
  input: RunRequest,
): StressConfigurationResult {
  const options = record(input.options);
  const backend = text(options.backend) ?? "local-engine";
  if (backend !== "local-engine" && backend !== "website") {
    return {
      ok: false,
      code: "STRESS_BACKEND_INVALID",
      message: "Tessera stress backend must be local-engine or website.",
    };
  }
  const opponentFactionId = text(options.opponentFaction);
  const exactOpponent = Boolean(input.opponentRef);
  if (exactOpponent && opponentFactionId) {
    return {
      ok: false,
      code: "OPPONENT_SCOPE_CONFLICT",
      message:
        "Choose either opponentRef for an exact roster or options.opponentFaction for a faction portfolio, not both.",
    };
  }
  if (!exactOpponent && !opponentFactionId) {
    return {
      ok: false,
      code: "OPPONENT_FACTION_REQUIRED",
      message:
        "Tessera stress testing requires opponentRef or options.opponentFaction.",
    };
  }
  const rawSelectedAbilityIds = options.selectedPlayerAbilityIds;
  if (
    rawSelectedAbilityIds !== undefined &&
    (
      !Array.isArray(rawSelectedAbilityIds) ||
      rawSelectedAbilityIds.some(
        (value) => typeof value !== "string" || !value.trim(),
      )
    )
  ) {
    return {
      ok: false,
      code: "STRESS_SELECTED_ABILITIES_INVALID",
      message:
        "options.selectedPlayerAbilityIds must be an array of ability ids.",
    };
  }
  const selectedPlayerAbilityIds = [
    ...new Set(
      (rawSelectedAbilityIds as string[] | undefined)?.map((value) =>
        value.trim()
      ) ?? [],
    ),
  ].sort();
  const requestedActivationMode = text(options.activationMode) ?? "baseline";
  if (
    requestedActivationMode !== "baseline" &&
    requestedActivationMode !== "envelope"
  ) {
    return {
      ok: false,
      code: "STRESS_ACTIVATION_MODE_INVALID",
      message: "options.activationMode must be baseline or envelope.",
    };
  }
  if (
    selectedPlayerAbilityIds.length > 0 &&
    requestedActivationMode === "envelope"
  ) {
    return {
      ok: false,
      code: "STRESS_ACTIVATION_SCOPE_CONFLICT",
      message:
        "Choose selectedPlayerAbilityIds for one exact choice or activationMode=envelope for all optional abilities.",
    };
  }
  if (
    (selectedPlayerAbilityIds.length > 0 ||
      requestedActivationMode === "envelope") &&
    (!exactOpponent || backend !== "local-engine")
  ) {
    return {
      ok: false,
      code: "STRESS_ACTIVATION_PROVIDER_UNSUPPORTED",
      message:
        "Optional ability policies currently require an exact local-engine matchup.",
    };
  }
  if (
    (selectedPlayerAbilityIds.length > 0 ||
      requestedActivationMode === "envelope") &&
    text(options.baselineReportPath)
  ) {
    return {
      ok: false,
      code: "STRESS_ACTIVATION_REVISION_UNSUPPORTED",
      message:
        "A paired revision reuses its baseline policy; start a fresh exact stress run to select abilities.",
    };
  }
  const suite = text(options.suite) ?? "core-3";
  if (!exactOpponent && suite !== "core-3" && suite !== "diverse-9") {
    return {
      ok: false,
      code: "STRESS_SUITE_INVALID",
      message: "Tessera stress suite must be core-3 or diverse-9.",
    };
  }
  const strategy = text(options.strategy) ?? "staged";
  if (!exactOpponent && strategy !== "staged" && strategy !== "full-all") {
    return {
      ok: false,
      code: "STRESS_STRATEGY_INVALID",
      message: "Tessera stress strategy must be staged or full-all.",
    };
  }
  const requestedDriftMode = options.catalogueDriftMode;
  const catalogueDriftMode = requestedDriftMode === undefined
    ? "reject"
    : requestedDriftMode;
  if (
    catalogueDriftMode !== "reject" &&
    catalogueDriftMode !== "diagnostic"
  ) {
    return {
      ok: false,
      code: "STRESS_CATALOGUE_DRIFT_MODE_INVALID",
      message:
        "Tessera catalogue drift mode must be reject or diagnostic; force is not supported.",
    };
  }
  return {
    ok: true,
    data: {
      options,
      backend,
      opponentFactionId,
      exactOpponent,
      suite: suite as "core-3" | "diverse-9",
      strategy: strategy as "staged" | "full-all",
      catalogueDriftMode,
      selectedPlayerAbilityIds,
      activationMode: requestedActivationMode,
    },
  };
}

function catalogueDriftWarnings(
  mode: StressCatalogueDriftMode,
): RosterIssue[] {
  return mode === "diagnostic"
    ? [issue(
        "CATALOGUE_DRIFT_DIAGNOSTIC_REQUESTED",
        "Verified catalogue drift may be accepted for this diagnostic run; treat its results as provisional.",
        "warn",
      )]
    : [];
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function compactIssues(values: RosterIssue[]): RosterIssue[] {
  return values.slice(0, 4).map((value) => ({
    code: value.code,
    message: value.message.length > 160
      ? `${value.message.slice(0, 157)}...`
      : value.message,
    severity: value.severity,
    ...(value.selectionId ? { selectionId: value.selectionId } : {}),
  }));
}

function listResearchQueries(query: string): string[] {
  if (!/[,;]/.test(query)) return [];
  const normalized = query
    .replace(/^\s*(?:find|research|list|show)\s+/i, "")
    .replace(/\s+and\s+/gi, ",");
  const leadingFaction = normalized.match(
    /^(.+?)\s+(?:aircraft|vehicles?|transports?|dreadnoughts?|units?|wardens?|allarus|vertus|epic heroes?)\b/i,
  )?.[1];
  return [...new Set(
    normalized
      .split(/[,;]/)
      .map((clause) => clause
        .replace(/^\s*(?:and|all)\s+/i, "")
        .replace(/^\s*(?:current\s+)?/i, "")
        .replace(/^(.+?\s+of\s+.+?)\s+units?$/i, "$1")
        .replace(/^(?!sisters?\s+of\s+silence$)(.+?)\s+units?$/i, "$1")
        .replace(/\boptions?\b.*$/i, "")
        .trim())
      .map((clause) =>
        leadingFaction && clause.startsWith(`${leadingFaction} `)
          ? clause.slice(leadingFaction.length).trim()
          : clause
      )
      .filter((clause) => clause.length >= 3 && clause.split(/\s+/).length <= 4),
  )].slice(0, 12);
}

function compactText(value: string, maximumBytes = 640): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "...";
  const contentBudget = Math.max(
    0,
    maximumBytes - Buffer.byteLength(suffix, "utf8"),
  );
  let compacted = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > contentBudget) break;
    compacted += character;
    bytes += characterBytes;
  }
  return `${compacted}${suffix}`;
}

function safeFilename(value: string): string {
  const safe = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || "artifact";
}

function contentSha256(content: string | Uint8Array): string {
  return crypto
    .createHash("sha256")
    .update(typeof content === "string" ? content : Buffer.from(content))
    .digest("hex");
}

function sourceSchemaVersion(value: unknown): number | null {
  const candidate = record(value).schemaVersion;
  return typeof candidate === "number" ? candidate : null;
}

function operationIdFromRef(ref: string): string {
  return ref.replace(/^rosterpilot:\/\/operations\//, "").trim();
}

function rosterIdFromRef(ref: string): string {
  return ref.replace(/^rosterpilot:\/\/rosters\//, "").trim();
}

function artifactIdFromRef(ref: string): string {
  return ref.replace(/^rosterpilot:\/\/artifacts\//, "").trim();
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,160}$/.test(value);
}

function rosterRef(rosterId: string): string {
  return `rosterpilot://rosters/${rosterId}`;
}

function operationRef(operationId: string): string {
  return `rosterpilot://operations/${operationId}`;
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(filename: string, content: string | Uint8Array) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.next-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, filename);
}

function operationMessage(summary: Pick<OperationSummary, "state" | "action">) {
  if (summary.state === "failed") return `${summary.action} failed.`;
  if (summary.state === "action-required") {
    return `${summary.action} needs a user action.`;
  }
  if (summary.state === "running") return `${summary.action} is running.`;
  return `${summary.action} completed.`;
}

export class RosterPilotService {
  readonly #rootDirectory: string;
  readonly #directories: ServiceDirectories;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #runMatchup?: MatchupRunner;
  readonly #runStress?: StressRunner;
  readonly #runExactStress?: ExactStressRunner;
  readonly #deliverToNewRecruit?: NewRecruitDeliverer;
  readonly #newRecruitStatus?: () => Promise<ResultEnvelope<NewRecruitConnectionStatus>>;
  readonly #lease: <T>(operation: () => Promise<T> | T) => Promise<T>;

  constructor(options: RosterPilotServiceOptions) {
    this.#rootDirectory = path.resolve(options.rootDirectory);
    this.#directories = {
      operations: path.join(this.#rootDirectory, "operations", "v1"),
      actionLocks: path.join(
        this.#rootDirectory,
        "operations",
        "action-locks",
      ),
      rosters: path.join(this.#rootDirectory, "rosters", "v4"),
      artifacts: path.join(this.#rootDirectory, "artifacts", "v1"),
    };
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? crypto.randomUUID;
    this.#runMatchup = options.runMatchup ?? analyzeExactRosterMatchup;
    this.#runStress = options.runStress;
    this.#runExactStress = options.runExactStress;
    this.#deliverToNewRecruit = options.deliverToNewRecruit;
    this.#newRecruitStatus = options.newRecruitStatus;
    this.#lease = options.lease ?? ((operation) =>
      withDataBundleSnapshotLease(operation));
  }

  async initialize(): Promise<void> {
    await Promise.all(
      Object.values(this.#directories).map((directory) =>
        mkdir(directory, { recursive: true, mode: 0o700 })),
    );
  }

  async run(input: RunRequest): Promise<OperationSummary> {
    await this.initialize();
    const operation = this.#newOperation(input.action, input);
    await this.#writeOperation(operation);
    if (input.action === "sync") {
      return this.#runSync(operation, input);
    }
    return this.#lease(() => this.#runLeased(operation, input));
  }

  async inspect(input: InspectRequest): Promise<Record<string, unknown>> {
    await this.initialize();
    const view = input.view ?? "summary";
    if (input.ref === "data" || input.ref === "rosterpilot://data") {
      return this.#inspectData();
    }
    if (
      input.ref === "new-recruit" ||
      input.ref === "rosterpilot://new-recruit"
    ) {
      return this.#inspectNewRecruit();
    }
    if (input.ref.startsWith("rosterpilot://operations/") || isSafeId(input.ref)) {
      const operationId = operationIdFromRef(input.ref);
      const operation = await this.#readOperation(operationId).catch(() => null);
      if (operation) {
        return view === "details" ? operation : this.#publicSummary(operation);
      }
    }
    if (input.ref.startsWith("rosterpilot://rosters/")) {
      const roster = await this.#readRoster(input.ref);
      return view === "details"
        ? roster
        : this.#summarizeRoster(roster);
    }
    if (input.ref.startsWith("rosterpilot://artifacts/")) {
      const artifact = await this.#readArtifactMetadata(input.ref);
      if (view !== "artifact") return artifact;
      return {
        ...artifact,
        content: await this.#readArtifactContent(artifact),
      };
    }
    return {
      ok: false,
      code: "REFERENCE_NOT_FOUND",
      message: `No RosterPilot resource matched ${input.ref}.`,
    };
  }

  async act(input: ActRequest): Promise<OperationSummary> {
    await this.initialize();
    if (!isSafeId(input.operationId)) {
      throw new Error("Operation ID is invalid.");
    }
    const actionLock = path.join(
      this.#directories.actionLocks,
      input.operationId,
    );
    try {
      await mkdir(actionLock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const operation = await this.#readOperation(input.operationId);
      return this.#actionFailure(
        operation,
        "OPERATION_ACTION_IN_PROGRESS",
        "Another process has already claimed this operation action.",
      );
    }
    try {
      return await this.#actLocked(input);
    } finally {
      await rmdir(actionLock).catch(() => undefined);
    }
  }

  async #actLocked(input: ActRequest): Promise<OperationSummary> {
    const operation = await this.#readOperation(input.operationId);
    if (operation.revision !== input.expectedRevision) {
      return this.#failedRevision(operation, input.expectedRevision);
    }
    if (input.actionId === "tessera.stress.run") {
      if (!operation.nextActions.some(
        (action) => action.actionId === "tessera.stress.run"
      )) {
        return this.#actionFailure(
          operation,
          "ACTION_NOT_AVAILABLE",
          "Tessera website stress is not available for this operation.",
        );
      }
      if (!input.confirm) {
        return this.#confirmationRequired(
          operation,
          "Tessera website upload and stress execution require explicit confirmation.",
        );
      }
      if (operation.request?.action !== "stress") {
        return this.#actionFailure(
          operation,
          "STRESS_REQUEST_MISSING",
          "This operation does not contain a Tessera stress request.",
        );
      }
      const stressRequest = input.choice
        ? {
            ...operation.request,
            options: {
              ...record(operation.request.options),
              profilePolicyPath: input.choice,
            },
          }
        : operation.request;
      return this.#lease(() =>
        this.#executeStress(operation, stressRequest, true)
      );
    }
    if (input.actionId !== "new-recruit.upload") {
      return this.#actionFailure(
        operation,
        "ACTION_NOT_SUPPORTED",
        `Action ${input.actionId} is not available.`,
      );
    }
    if (!operation.nextActions.some(
      (action) => action.actionId === "new-recruit.upload"
    )) {
      return this.#actionFailure(
        operation,
        "ACTION_NOT_AVAILABLE",
        "New Recruit upload is not available for this operation or roster.",
      );
    }
    if (!input.confirm) {
      return this.#confirmationRequired(
        operation,
        "New Recruit upload requires explicit confirmation.",
      );
    }
    return this.#lease(() => this.#executeNewRecruitUpload(operation));
  }

  async #executeNewRecruitUpload(
    operation: OperationDocument,
  ): Promise<OperationSummary> {
    if (!operation.rosterRef) {
      return this.#updateFailure(
        operation,
        "ROSTER_REFERENCE_REQUIRED",
        "This operation does not contain a roster to upload.",
      );
    }
    if (!this.#deliverToNewRecruit) {
      return this.#updateFailure(
        operation,
        "NEW_RECRUIT_UNAVAILABLE",
        "Authenticated New Recruit upload is not configured.",
      );
    }
    if (
      operation.newRecruitMutation?.status === "started" ||
      operation.newRecruitMutation?.status === "uncertain"
    ) {
      return this.#updateFailure(
        operation,
        "NEW_RECRUIT_RETRY_BLOCKED",
        "The prior upload outcome is uncertain and will not be retried automatically.",
      );
    }
    const roster = await this.#readRoster(operation.rosterRef);
    const validation = validateRoster(roster);
    if (!validation.ok) {
      const next = this.#nextRevision(operation, {
        state: "failed",
        message: "The roster is no longer valid and was not uploaded.",
        violations: compactIssues(validation.violations),
        warnings: compactIssues(validation.warnings),
        newRecruitMutation: {
          status: "failed-before-mutation",
          startedAt: null,
          completedAt: this.#timestamp(),
          listUrl: null,
        },
      });
      await this.#writeOperation(next);
      return this.#publicSummary(next);
    }
    const preflight = await exportRoster(roster, "rosz");
    if (!preflight.ok) {
      const next = this.#nextRevision(operation, {
        state: "failed",
        message:
          "The roster cannot be represented safely in the active New Recruit catalogue and was not uploaded.",
        violations: compactIssues(preflight.violations),
        warnings: compactIssues(preflight.warnings),
        nextActions: [],
        newRecruitMutation: {
          status: "failed-before-mutation",
          startedAt: null,
          completedAt: this.#timestamp(),
          listUrl: null,
        },
      });
      await this.#writeOperation(next);
      return this.#publicSummary(next);
    }
    let started = this.#nextRevision(operation, {
      action: "new-recruit-upload",
      state: "running",
      message: "Authenticated New Recruit upload started.",
      nextActions: [],
      newRecruitMutation: {
        status: "started",
        startedAt: this.#timestamp(),
        completedAt: null,
        listUrl: null,
      },
    });
    await this.#writeOperation(started);
    try {
      const result = await this.#deliverToNewRecruit(roster, {
        downloadEnrichedRosz: true,
        downloadPrettyHtml: false,
        outputDirectory: "new-recruit",
        rootDir: this.#rootDirectory,
        overwrite: false,
      });
      if (!result.ok || !result.data) {
        const failedBeforeMutation = result.violations.length > 0 &&
          result.violations.every((violation) =>
            violation.code === "FILE_COLLISION"
          );
        started = this.#nextRevision(started, {
          state: "failed",
          message: "New Recruit upload did not produce a verified result.",
          violations: compactIssues(result.violations),
          warnings: compactIssues(result.warnings),
          newRecruitMutation: {
            status: failedBeforeMutation
              ? "failed-before-mutation"
              : "uncertain",
            startedAt: started.newRecruitMutation?.startedAt ?? null,
            completedAt: this.#timestamp(),
            listUrl: null,
          },
        });
        await this.#writeOperation(started);
        return this.#publicSummary(started);
      }
      const next = this.#nextRevision(started, {
        state: "completed",
        message: "New Recruit created and verified the roster.",
        result: {
          imported: result.data.imported,
          listUrl: result.data.listUrl,
          sessionReused: result.data.sessionReused,
          verification: result.data.verification,
        },
        warnings: compactIssues(result.warnings),
        newRecruitMutation: {
          status: "verified",
          startedAt: started.newRecruitMutation?.startedAt ?? null,
          completedAt: this.#timestamp(),
          listUrl: result.data.listUrl,
        },
      });
      await this.#writeOperation(next);
      return this.#publicSummary(next);
    } catch (error) {
      const next = this.#nextRevision(started, {
        state: "failed",
        message: "New Recruit upload stopped with an uncertain external outcome.",
        violations: [issue(
          "NEW_RECRUIT_UPLOAD_UNCERTAIN",
          error instanceof Error ? error.message : "New Recruit upload failed.",
        )],
        newRecruitMutation: {
          status: "uncertain",
          startedAt: started.newRecruitMutation?.startedAt ?? null,
          completedAt: this.#timestamp(),
          listUrl: null,
        },
      });
      await this.#writeOperation(next);
      return this.#publicSummary(next);
    }
  }

  async importRoster(value: unknown): Promise<OperationSummary> {
    await this.initialize();
    const operation = this.#newOperation("import", null);
    return this.#lease(() => this.#executeImportRoster(operation, value));
  }

  async #executeImportRoster(
    operation: OperationDocument,
    value: unknown,
  ): Promise<OperationSummary> {
    const parsed = parseRosterDraft(value);
    if (!parsed.success) {
      const failed = this.#nextRevision(operation, {
        state: "failed",
        message: "The roster document could not be migrated.",
        violations: [issue(
          "ROSTER_IMPORT_FAILED",
          "The input is not a supported V1, V2, or V3 roster document.",
        )],
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
    const stored = await this.#storeRoster(parsed.data, sourceSchemaVersion(value));
    const validation = validateRoster(parsed.data);
    const handoff = validation.ok
      ? await this.#newRecruitHandoffAvailability(parsed.data)
      : { nextActions: [], warnings: [] };
    const completed = this.#nextRevision(operation, {
      state: validation.ok ? "completed" : "failed",
      message: validation.ok
        ? "Roster imported into the V4 store."
        : "Roster migrated but failed current validation.",
      rosterRef: stored,
      roster: this.#summarizeRoster(parsed.data),
      violations: compactIssues(validation.violations),
      warnings: compactIssues([
        ...validation.warnings,
        ...handoff.warnings,
      ]),
      nextActions: handoff.nextActions,
    });
    await this.#writeOperation(completed);
    return this.#publicSummary(completed);
  }

  async readResource(uri: string): Promise<
    | { uri: string; mimeType: string; text: string }
    | { uri: string; mimeType: string; blob: string }
  > {
    if (uri.startsWith("rosterpilot://operations/")) {
      const value = await this.#readOperation(operationIdFromRef(uri));
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      };
    }
    if (uri.startsWith("rosterpilot://rosters/")) {
      const value = await this.#readRoster(uri);
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      };
    }
    if (uri.startsWith("rosterpilot://artifacts/")) {
      const artifact = await this.#readArtifactMetadata(uri);
      const bytes = await readFile(artifact.path);
      return artifact.encoding === "binary"
        ? {
            uri,
            mimeType: artifact.mimeType,
            blob: bytes.toString("base64"),
          }
        : {
            uri,
            mimeType: artifact.mimeType,
            text: bytes.toString("utf8"),
          };
    }
    throw new Error(`Unsupported resource URI ${uri}.`);
  }

  async #runLeased(
    operation: OperationDocument,
    input: RunRequest,
  ): Promise<OperationSummary> {
    try {
      switch (input.action) {
        case "research":
          return await this.#runResearch(operation, input);
        case "build":
          return await this.#runBuild(operation, input);
        case "modify":
          return await this.#runModify(operation, input);
        case "export":
          return await this.#runExport(operation, input);
        case "matchup":
          return await this.#runMatchupAction(operation, input);
        case "stress":
          return await this.#runStressAction(operation, input);
        default:
          return this.#updateFailure(
            operation,
            "ACTION_NOT_SUPPORTED",
            `Action ${input.action} is not supported.`,
          );
      }
    } catch (error) {
      return this.#updateFailure(
        operation,
        "OPERATION_FAILED",
        error instanceof Error ? error.message : "RosterPilot operation failed.",
      );
    }
  }

  async #runResearch(
    operation: OperationDocument,
    input: RunRequest,
  ): Promise<OperationSummary> {
    const options = record(input.options);
    const faction = text(options.faction);
    const query = input.request ?? "";
    const factions = Array.isArray(options.factions)
      ? compareFactions(options.factions.filter((value): value is string =>
          typeof value === "string"))
      : faction
        ? compareFactions([faction])
        : searchFactions(query, number(options.limit) ?? 20);
    let units = faction
      ? searchUnits({
          faction,
          query,
          includeLegends: boolean(options.includeLegends),
          limit: number(options.limit) ?? 30,
        })
      : null;
    if (units?.ok && units.data?.length === 0) {
      const expandedQueries = listResearchQueries(query);
      if (expandedQueries.length > 1) {
        const expanded = expandedQueries.map((expandedQuery) =>
          searchUnits({
            faction,
            query: expandedQuery,
            includeLegends: boolean(options.includeLegends),
            limit: number(options.limit) ?? 30,
          })
        );
        units = {
          ok: expanded.every((result) => result.ok),
          data: [
            ...new Map(
              expanded
                .flatMap((result) => result.data ?? [])
                .map((unit) => [unit.id, unit]),
            ).values(),
          ].slice(0, Math.max(1, Math.min(number(options.limit) ?? 30, 100))),
          violations: expanded.flatMap((result) => result.violations),
          warnings: expanded.flatMap((result) => result.warnings),
        };
      }
    }
    const violations = [
      ...factions.violations,
      ...(units?.violations ?? []),
    ];
    const factionItems = (factions.data ?? []).slice(0, 12).map((item) => {
      const value = record(item);
      return {
        id: value.id ?? null,
        name: value.name ?? null,
        supported: value.supported ?? null,
      };
    });
    const unitItems = (units?.data ?? []).slice(0, 12).map((item) => ({
      id: item.id,
      name: item.name,
      role: item.role,
      pointsFrom: item.pointsFrom,
      modelCounts: item.modelCounts,
      tags: item.tags,
      isLegend: item.isLegend,
    }));
    const next = this.#nextRevision(operation, {
      state: violations.length > 0 ? "failed" : "completed",
      message: units
        ? `Found ${units.data?.length ?? 0} matching units.`
        : `Found ${factions.data?.length ?? 0} matching factions.`,
      result: units
        ? {
            factionMatchCount: factions.data?.length ?? 0,
            unitMatchCount: units.data?.length ?? 0,
            factions: factionItems,
            units: unitItems,
          }
        : {
            factionMatchCount: factions.data?.length ?? 0,
            factions: factionItems,
          },
      violations: compactIssues(violations),
      warnings: compactIssues([
        ...factions.warnings,
        ...(units?.warnings ?? []),
      ]),
    });
    await this.#writeOperation(next);
    return this.#publicSummary(next);
  }

  async #runBuild(
    operation: OperationDocument,
    input: RunRequest,
  ): Promise<OperationSummary> {
    const parsedOptions = BuildRunOptionsSchema.safeParse(input.options ?? {});
    if (!parsedOptions.success) {
      const details = parsedOptions.error.issues
        .slice(0, 4)
        .map((problem) =>
          `${problem.path.join(".") || "options"}: ${problem.message}`
        )
        .join(" ");
      return this.#updateFailure(
        operation,
        "BUILD_OPTIONS_INVALID",
        `Build options are invalid. ${details}`,
      );
    }
    const options = parsedOptions.data;
    if (
      options.comparisonBuildLimit !== undefined &&
      options.comparisonBuildLimit > 500
    ) {
      return this.#updateFailure(
        operation,
        "BUILD_OPTIONS_INVALID",
        "Build options are invalid. comparisonBuildLimit: Expected a value no greater than 500.",
      );
    }
    const comparisonBuildLimit = options.comparisonBuildLimit ??
      (options.comparisonDepth === "expanded" ? 500 : 48);
    const opponentFactionId = options.opponentFaction;
    if (input.opponentRef && opponentFactionId) {
      return this.#updateFailure(
        operation,
        "OPPONENT_SCOPE_CONFLICT",
        "Choose either opponentRef for an exact roster or options.opponentFaction for a known faction, not both.",
      );
    }

    let opponent: RosterDraftV1 | null = null;
    if (input.opponentRef) {
      const storedOpponent = await this.#readRoster(input.opponentRef);
      const rebased = await rebaseRosterWithProvider(storedOpponent);
      if (!rebased.ok || !rebased.data) {
        const message = rebased.violations[0]?.message ??
          "The exact opponent roster could not be rebased to the active data bundle.";
        const failed = this.#nextRevision(operation, {
          state: "failed",
          message,
          opponentRef: input.opponentRef,
          opponent: this.#summarizeRoster(storedOpponent),
          violations: [issue("OPPONENT_ROSTER_REBASE_FAILED", message)],
          warnings: compactIssues(rebased.warnings),
        });
        await this.#writeOperation(failed);
        return this.#publicSummary(failed);
      }
      if (rebased.data.status === "review-required") {
        const failed = this.#nextRevision(operation, {
          state: "failed",
          message:
            "The exact opponent roster requires data review before it can influence construction.",
          opponentRef: input.opponentRef,
          opponent: this.#summarizeRoster(storedOpponent),
          result: { changedScopes: rebased.data.changedScopes },
          violations: [issue(
            "OPPONENT_DATA_REVIEW_REQUIRED",
            "Review and rebase the exact opponent roster before constructing a counter-roster.",
          )],
          warnings: compactIssues(rebased.warnings),
        });
        await this.#writeOperation(failed);
        return this.#publicSummary(failed);
      }
      opponent = rebased.data.roster;
    }

    let knownFactionPortfolio:
      | NonNullable<ReturnType<typeof generateFactionStressPortfolio>["data"]>
      | null = null;
    let opponentPortfolioHash: string | null = null;
    const opponentScope: "exact-roster" | "faction-portfolio" | null =
      opponent
        ? "exact-roster"
        : opponentFactionId
          ? "faction-portfolio"
          : null;
    let opponentPortfolioCoverage = opponent
      ? { ready: 1, intended: 1, complete: true }
      : { ready: 0, intended: 9, complete: false };
    const comparisonWarnings: RosterIssue[] = [];
    if (
      !opponent &&
      opponentFactionId &&
      options.compareOpponentOptions !== false
    ) {
      const parsedRequest = parseRosterPrompt(input.request ?? "", {
        playerFaction: options.playerFaction ?? options.faction,
        opponentFaction: opponentFactionId,
      });
      const portfolio = generateFactionStressPortfolio({
        faction: opponentFactionId,
        pointsLimit:
          options.pointsLimit ?? parsedRequest.pointsLimit ?? 1000,
        suite: "diverse-9",
        pointsTolerancePercent: 5,
        allowLegends:
          options.allowLegends ?? parsedRequest.allowLegends ?? false,
        artifactMode: "canonical",
      });
      comparisonWarnings.push(...portfolio.warnings);
      if (portfolio.ok && portfolio.data) {
        knownFactionPortfolio = portfolio.data;
        opponentPortfolioHash =
          portfolio.data.contract?.portfolioHash ?? null;
        opponentPortfolioCoverage = {
          ready: portfolio.data.coverage.ready,
          intended: portfolio.data.coverage.intended,
          complete:
            portfolio.data.coverage.maximumResultStatus === "complete" &&
            portfolio.data.coverage.ready ===
              portfolio.data.coverage.intended &&
            portfolio.data.coverage.unavailable === 0 &&
            opponentPortfolioHash !== null,
        };
      } else {
        comparisonWarnings.push(...portfolio.violations.map(
          (violation) => ({
            ...violation,
            severity: "warn" as const,
          }),
        ));
      }
      if (!opponentPortfolioCoverage.complete) {
        comparisonWarnings.push(issue(
          "OPPONENT_PORTFOLIO_DEGRADED",
          knownFactionPortfolio
            ? `The diverse-nine opponent portfolio is incomplete (${opponentPortfolioCoverage.ready}/${opponentPortfolioCoverage.intended} ready); comparison is advisory and the baseline roster will be retained.`
            : "The diverse-nine opponent portfolio is unavailable; the baseline roster will be retained.",
          "warn",
        ));
      }
    }

    const frozenRepresentatives =
      knownFactionPortfolio && opponentPortfolioCoverage.complete
        ? knownFactionPortfolio.items.flatMap((item) =>
            item.status === "ready" && item.roster
              ? [item.roster]
              : []
          )
        : [];

    const buildInput: BuildRosterInput = {
      prompt: input.request,
      playerFaction: options.playerFaction ?? options.faction,
      faction: options.faction,
      pointsLimit: options.pointsLimit,
      name: options.name,
      preferences: options.preferences,
      allowNamedCharacters: options.allowNamedCharacters,
      legendsPolicy: options.legendsPolicy,
      allowLegends: options.allowLegends,
      playContext: options.playContext,
      collectionUnitIds: options.collectionUnitIds,
      collectionProfile: options.collectionProfile,
      requiredUnitIds: options.requiredUnitIds,
      excludedUnitIds: options.excludedUnitIds,
      requiredWarlordUnitId: options.requiredWarlordUnitId,
      detachmentId: options.detachmentId,
      forceDispositionId: options.forceDispositionId,
      opponentContext: opponent
        ? { kind: "known-roster", roster: opponent }
        : opponentFactionId
          ? {
              kind: "known-faction",
              factionId:
                knownFactionPortfolio?.factionId ?? opponentFactionId,
              ...(frozenRepresentatives.length > 0 && opponentPortfolioHash
                ? {
                    representativeRosters: frozenRepresentatives,
                    portfolioHash: opponentPortfolioHash,
                  }
                : {}),
            }
          : undefined,
      opponentAssumptions: options.opponentAssumptions,
      mixedThreatIntent: options.mixedThreatIntent,
    };
    const result = buildRoster(buildInput);
    if (!result.ok || !result.data) {
      const failed = this.#nextRevision(operation, {
        state: "failed",
        message: "Roster construction failed.",
        opponentRef: input.opponentRef ?? null,
        opponent: opponent ? this.#summarizeRoster(opponent) : null,
        violations: compactIssues(result.violations),
        warnings: compactIssues([
          ...result.warnings,
          ...comparisonWarnings,
        ]),
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
    let selectedRoster = result.data;
    let comparison:
      | NonNullable<ReturnType<typeof compareOpponentRosterOptions>["data"]>
      | null = null;
    let frozenComparisonOpponents: OpponentComparisonRoster[] = [];
    let recommendationApplied = false;
    if (
      options.compareOpponentOptions !== false &&
      result.data.constraints.opponentFactionId
    ) {
      frozenComparisonOpponents = opponent
        ? [{
            templateId: "exact-opponent",
            roster: opponent,
          }]
        : knownFactionPortfolio
          ? knownFactionPortfolio.items.flatMap((item) =>
              item.status === "ready" && item.roster
                ? [{
                    templateId: item.templateId,
                    posture: item.posture,
                    composition: item.composition,
                    roster: item.roster,
                  }]
                : []
            )
          : [];
      if (frozenComparisonOpponents.length > 0) {
        const compared = compareOpponentRosterOptions({
          buildInput,
          baselineRoster: result.data,
          opponents: frozenComparisonOpponents,
          opponentPortfolioHash,
          maximumBuilds: comparisonBuildLimit,
          maximumAlternatives: 3,
        });
        comparisonWarnings.push(...compared.warnings);
        if (compared.ok && compared.data) {
          comparison = compared.data;
          if (opponent || opponentPortfolioCoverage.complete) {
            selectedRoster = compared.data.recommended.roster;
            recommendationApplied = true;
          }
        } else {
          comparisonWarnings.push(...compared.violations.map(
            (violation) => ({
              ...violation,
              severity: "warn" as const,
            }),
          ));
        }
      }
    }

    const stored = await this.#storeRoster(selectedRoster, null);
    const candidateRefEntries = comparison
      ? await Promise.all(comparison.candidates.map(async (candidate) => ({
          structuralFingerprint: candidate.structuralFingerprint,
          rosterRef: await this.#storeRoster(candidate.roster, null),
        })))
      : [];
    const candidateRefs = new Map(
      candidateRefEntries.map((entry) => [
        entry.structuralFingerprint,
        entry.rosterRef,
      ]),
    );
    const opponentRefEntries = comparison
      ? await Promise.all(frozenComparisonOpponents.map(
          async (entry, index) => ({
            index,
            rosterRef: await this.#storeRoster(entry.roster, null),
          }),
        ))
      : [];
    const anchorNames = comparison
      ? new Map(
          comparison.audit.ledger.map((entry) => [
            entry.unitId,
            entry.unitName,
          ]),
        )
      : new Map<string, string>();
    const anchors = (unitIds: string[]) =>
      unitIds.map((unitId) => anchorNames.get(unitId) ?? unitId);
    const comparisonContract = comparison
      ? (() => {
          const coverage = comparison.audit.coverage;
          const eligibleDetachmentIds = coverage.detachments.eligibleIds;
          const evaluatedDetachmentIds = new Set(
            coverage.detachments.evaluatedIds,
          );
          const detachmentCoverageComplete = eligibleDetachmentIds.every(
            (detachmentId) => evaluatedDetachmentIds.has(detachmentId),
          );
          const status =
            !opponentPortfolioCoverage.complete ||
              coverage.catalogueMayBeTruncated
              ? ("degraded" as const)
              : coverage.allied.uniqueDatasheets > 0 &&
                  !coverage.allied.expansionSupported
                ? ("bounded" as const)
              : coverage.coverageMode === "complete" &&
                  detachmentCoverageComplete
                ? ("complete" as const)
                : ("bounded" as const);
          const recommendedRosterRef = candidateRefs.get(
            comparison.recommended.structuralFingerprint,
          ) ?? stored;
          return {
            status,
            scope: opponentScope ??
              (opponent ? "exact-roster" : "faction-portfolio"),
            portfolio: {
              ready: opponentPortfolioCoverage.ready,
              intended: opponentPortfolioCoverage.intended,
              complete: opponentPortfolioCoverage.complete,
              hash: opponentPortfolioHash,
            },
            coverage: {
              datasheets: {
                rows: coverage.catalogueRows,
                eligible: coverage.eligible,
                evaluated: coverage.attempted,
                omitted: coverage.notExpanded,
                truncated: coverage.catalogueMayBeTruncated,
              },
              allied: {
                rules: coverage.allied.rulesOffered,
                offered: coverage.allied.uniqueDatasheets,
                selectable: coverage.allied.selectable,
                status: "inventory-only" as const,
              },
              detachments: {
                mode: coverage.detachments.mode,
                eligible: eligibleDetachmentIds.length,
                evaluated: coverage.detachments.evaluatedIds.length,
                successful: coverage.detachments.successfulIds.length,
              },
              configurations: "bounded" as const,
            },
            recommended: {
              applied: recommendationApplied,
              rosterRef: recommendedRosterRef,
              anchors: anchors(comparison.recommended.anchorUnitIds),
              floor: comparison.recommended.worstArchetypeScore,
              median: comparison.recommended.medianArchetypeScore,
            },
          };
        })()
      : null;
    const alternativeRefs = comparison
      ? comparison.alternatives.map((alternative) => ({
          alternative,
          rosterRef: candidateRefs.get(
            alternative.candidate.structuralFingerprint,
          )!,
        }))
      : [];
    const comparisonArtifact = comparison
      ? await this.#storeJsonArtifact(
          `${safeFilename(selectedRoster.name)}-opponent-option-comparison.json`,
          {
            ...comparison.audit,
            opponents: comparison.audit.opponents.map(
              (entry, index) => ({
                ...entry,
                rosterRef:
                  opponentRefEntries.find(
                    (reference) => reference.index === index,
                  )?.rosterRef ?? null,
              }),
            ),
            serviceContract: {
              ...comparisonContract,
              selectedRosterRef: stored,
              portfolioEvidence: opponent
                ? {
                    suite: "exact-roster",
                    ready: 1,
                    intended: 1,
                    missingCells: [],
                  }
                : {
                    suite: knownFactionPortfolio?.suite ?? "diverse-9",
                    ready: knownFactionPortfolio?.coverage.ready ?? 0,
                    intended: knownFactionPortfolio?.coverage.intended ?? 9,
                    missingCells:
                      knownFactionPortfolio?.coverage.missingCells ?? [],
                    maximumResultStatus:
                      knownFactionPortfolio?.coverage.maximumResultStatus ??
                        "degraded",
                  },
            },
            recommendation: {
              ...comparison.audit.recommendation,
              applied: recommendationApplied,
              rosterRef: comparisonContract?.recommended.rosterRef ?? stored,
            },
            alternatives: comparison.audit.alternatives.map(
              (alternative) => ({
                ...alternative,
                rosterRef:
                  alternativeRefs.find(
                    (entry) =>
                      entry.alternative.candidate.structuralFingerprint ===
                        alternative.structuralFingerprint,
                  )?.rosterRef ?? null,
              }),
            ),
            candidates: comparison.audit.candidates.map((candidate) => ({
              ...candidate,
              rosterRef:
                candidateRefs.get(candidate.structuralFingerprint) ?? null,
            })),
          },
        )
      : null;
    const comparisonSummary = comparison && comparisonArtifact
      ? {
          ...comparisonContract,
          alternatives: alternativeRefs.map(({ alternative, rosterRef }) => ({
            contrast: alternative.contrast,
            rosterRef,
            floor: alternative.candidate.worstArchetypeScore,
          })),
          artifact: comparisonArtifact.uri,
        }
      : null;
    const explanation = explainRoster(selectedRoster);
    const handoff = await this.#newRecruitHandoffAvailability(selectedRoster);
    const completionMessage = comparison && comparisonContract
      ? !opponent && !opponentPortfolioCoverage.complete
        ? "Built and validated; incomplete opponent evidence was advisory, so the baseline roster was retained."
        : `Built and validated; ${comparisonContract.status} opponent comparison evaluated ${comparisonContract.coverage.datasheets.evaluated}/${comparisonContract.coverage.datasheets.eligible} faction-native datasheets.`
      : `Built and validated ${selectedRoster.name}.`;
    const next = this.#nextRevision(operation, {
      state: "completed",
      message: completionMessage,
      rosterRef: stored,
      roster: this.#summarizeRoster(selectedRoster, comparison ? 1 : 12),
      opponentRef: input.opponentRef ?? null,
      opponent: opponent ? this.#summarizeRoster(opponent, 0) : null,
      result: explanation.data
        ? comparisonSummary
          ? { opponentComparison: comparisonSummary }
          : {
              summary: explanation.data.summary,
              choices: explanation.data.choices.slice(0, 8),
              cautions: explanation.data.cautions.slice(0, 8),
            }
        : null,
      warnings: compactIssues([
        ...new Map(
          [
            ...result.warnings.filter(
              (warning) => warning.code !== "POINTS_REMAIN",
            ),
            ...comparisonWarnings.filter(
              (warning) => warning.code !== "POINTS_REMAIN",
            ),
            ...explanation.warnings,
            ...handoff.warnings,
          ].map((warning) => [warning.code, warning]),
        ).values(),
      ]),
      artifacts: comparisonArtifact ? [comparisonArtifact] : [],
      nextActions: handoff.nextActions,
      bundleId: selectedRoster.sourceData.bundleId,
    });
    await this.#writeOperation(next);
    return this.#publicSummary(next);
  }

  async #runModify(
    operation: OperationDocument,
    input: RunRequest,
  ): Promise<OperationSummary> {
    if (!input.rosterRef) {
      return this.#updateFailure(
        operation,
        "ROSTER_REFERENCE_REQUIRED",
        "Modify requires rosterRef.",
      );
    }
    const original = await this.#readRoster(input.rosterRef);
    const rebased = await rebaseRosterWithProvider(original);
    if (!rebased.ok || !rebased.data) {
      return this.#updateFailure(
        operation,
        "ROSTER_REBASE_FAILED",
        rebased.violations[0]?.message ?? "Roster rebase failed.",
      );
    }
    if (rebased.data.status === "review-required") {
      const next = this.#nextRevision(operation, {
        state: "action-required",
        message: "Roster data changed and requires review before modification.",
        rosterRef: input.rosterRef,
        roster: this.#summarizeRoster(original),
        result: { changedScopes: rebased.data.changedScopes },
        warnings: compactIssues(rebased.warnings),
      });
      await this.#writeOperation(next);
      return this.#publicSummary(next);
    }
    const operations = this.#modificationOperations(
      rebased.data.roster,
      input,
    );
    if (operations.violations.length > 0) {
      const failed = this.#nextRevision(operation, {
        state: operations.nextActions.length > 0
          ? "action-required"
          : "failed",
        message: operations.message,
        rosterRef: input.rosterRef,
        roster: this.#summarizeRoster(rebased.data.roster),
        violations: operations.violations,
        nextActions: operations.nextActions,
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
    const result = modifyRosterBatch(
      rebased.data.roster,
      operations.operations,
    );
    if (!result.ok || !result.data) {
      const failed = this.#nextRevision(operation, {
        state: "failed",
        message: "Roster modification failed validation.",
        rosterRef: input.rosterRef,
        roster: this.#summarizeRoster(rebased.data.roster),
        violations: compactIssues(result.violations),
        warnings: compactIssues(result.warnings),
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
    const stored = await this.#storeRoster(result.data, null);
    const handoff = await this.#newRecruitHandoffAvailability(result.data);
    const next = this.#nextRevision(operation, {
      state: "completed",
      message: `Modified and validated ${result.data.name}.`,
      rosterRef: stored,
      roster: this.#summarizeRoster(result.data),
      warnings: compactIssues([
        ...result.warnings,
        ...handoff.warnings,
      ]),
      nextActions: handoff.nextActions,
      bundleId: result.data.sourceData.bundleId,
    });
    await this.#writeOperation(next);
    return this.#publicSummary(next);
  }

  async #runExport(
    operation: OperationDocument,
    input: RunRequest,
  ): Promise<OperationSummary> {
    if (!input.rosterRef || !input.format) {
      return this.#updateFailure(
        operation,
        "EXPORT_INPUT_REQUIRED",
        "Export requires rosterRef and format.",
      );
    }
    const roster = await this.#readRoster(input.rosterRef);
    const validation = validateRoster(roster);
    if (!validation.ok) {
      const failed = this.#nextRevision(operation, {
        state: "failed",
        message: "Invalid rosters cannot be exported.",
        rosterRef: input.rosterRef,
        roster: this.#summarizeRoster(roster),
        violations: compactIssues(validation.violations),
        warnings: compactIssues(validation.warnings),
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
    const result = await exportRoster(roster, input.format);
    if (!result.ok || !result.data) {
      const failed = this.#nextRevision(operation, {
        state: "failed",
        message: "Roster export failed.",
        rosterRef: input.rosterRef,
        roster: this.#summarizeRoster(roster),
        violations: compactIssues(result.violations),
        warnings: compactIssues(result.warnings),
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
    const artifact = await this.#storeExportArtifact(result.data);
    const outputPath = text(record(input.options).outputPath);
    const written = outputPath
      ? await this.#publishArtifact(artifact, outputPath, boolean(record(input.options).overwrite))
      : undefined;
    const reference = written ? { ...artifact, written } : artifact;
    const handoff = await this.#newRecruitHandoffAvailability(roster);
    const next = this.#nextRevision(operation, {
      state: "completed",
      message: `Exported ${roster.name} as ${input.format}.`,
      rosterRef: input.rosterRef,
      roster: this.#summarizeRoster(roster),
      artifacts: [reference],
      warnings: compactIssues([
        ...result.warnings,
        ...handoff.warnings,
      ]),
      nextActions: handoff.nextActions,
      bundleId: roster.sourceData.bundleId,
    });
    await this.#writeOperation(next);
    return this.#publicSummary(next);
  }

  async #runMatchupAction(
    operation: OperationDocument,
    input: RunRequest,
  ): Promise<OperationSummary> {
    if (!input.rosterRef || !input.opponentRef) {
      return this.#updateFailure(
        operation,
        "EXACT_ROSTERS_REQUIRED",
        "Local matchup analysis requires rosterRef and opponentRef.",
      );
    }
    if (!this.#runMatchup) {
      return this.#updateFailure(
        operation,
        "LOCAL_MATCHUP_UNAVAILABLE",
        "Local exact matchup analysis is not configured.",
      );
    }
    const [player, opponent] = await Promise.all([
      this.#readRoster(input.rosterRef),
      this.#readRoster(input.opponentRef),
    ]);
    const playerValidation = validateRoster(player);
    const opponentValidation = validateRoster(opponent);
    if (!playerValidation.ok || !opponentValidation.ok) {
      const failed = this.#nextRevision(operation, {
        state: "failed",
        message: "Both exact rosters must be legal before analysis.",
        rosterRef: input.rosterRef,
        opponentRef: input.opponentRef,
        roster: this.#summarizeRoster(player),
        opponent: this.#summarizeRoster(opponent),
        violations: compactIssues([
          ...playerValidation.violations,
          ...opponentValidation.violations,
        ]),
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
    const options = record(input.options);
    const result = await this.#runMatchup(player, opponent, {
      outputDirectory: path.join(this.#rootDirectory, "matchups"),
      overwrite: boolean(options.overwrite),
      allowPointMismatch: boolean(options.allowPointMismatch),
    });
    if (!result.ok || !result.data) {
      const failed = this.#nextRevision(operation, {
        state: "failed",
        message: "Local exact matchup analysis failed.",
        rosterRef: input.rosterRef,
        opponentRef: input.opponentRef,
        roster: this.#summarizeRoster(player),
        opponent: this.#summarizeRoster(opponent),
        violations: compactIssues(result.violations),
        warnings: compactIssues(result.warnings),
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
    const artifact = await this.#storeJsonArtifact(
      `${safeFilename(player.name)}-vs-${safeFilename(opponent.name)}.json`,
      result.data,
    );
    const findings = Array.isArray(result.data.findings)
      ? result.data.findings.slice(0, 8).map((finding) => {
          const value = record(finding);
          return {
            title: text(value.title) ?? text(value.summary) ?? "Finding",
            direction: value.direction ?? null,
            confidence: value.confidence ?? null,
          };
        })
      : [];
    const next = this.#nextRevision(operation, {
      state: "completed",
      message: `Completed local exact matchup analysis for ${player.name} and ${opponent.name}.`,
      rosterRef: input.rosterRef,
      opponentRef: input.opponentRef,
      roster: this.#summarizeRoster(player),
      opponent: this.#summarizeRoster(opponent),
      result: {
        schemaVersion: result.data.schemaVersion ?? null,
        findings,
        limitation:
          "Directional math-hammer only; this is not a whole-game win probability.",
      },
      artifacts: [artifact],
      warnings: compactIssues(result.warnings),
      bundleId: player.sourceData.bundleId,
    });
    await this.#writeOperation(next);
    return this.#publicSummary(next);
  }

  async #runStressAction(
    operation: OperationDocument,
    input: RunRequest,
  ): Promise<OperationSummary> {
    if (!input.rosterRef) {
      return this.#updateFailure(
        operation,
        "ROSTER_REFERENCE_REQUIRED",
        "Tessera stress testing requires a rosterRef.",
      );
    }
    const parsed = parseStressConfiguration(input);
    if (!parsed.ok) {
      return this.#updateFailure(
        operation,
        parsed.code,
        parsed.message,
      );
    }
    const configuration = parsed.data;
    if (configuration.exactOpponent && !this.#runExactStress) {
      return this.#updateFailure(
        operation,
        "TESSERA_EXACT_STRESS_UNAVAILABLE",
        "Exact Tessera roster testing is not configured.",
      );
    }
    if (!configuration.exactOpponent && !this.#runStress) {
      return this.#updateFailure(
        operation,
        "TESSERA_STRESS_UNAVAILABLE",
        "Tessera faction stress testing is not configured.",
      );
    }
    if (configuration.backend === "website") {
      const roster = await this.#readRoster(input.rosterRef);
      const opponent = input.opponentRef
        ? await this.#readRoster(input.opponentRef)
        : null;
      const validation = validateRoster(roster);
      const opponentValidation = opponent ? validateRoster(opponent) : null;
      const ready = validation.ok && (opponentValidation?.ok ?? true);
      const next = this.#nextRevision(operation, {
        state: ready ? "action-required" : "failed",
        message: ready
          ? opponent
            ? `Exact Tessera website testing for ${roster.name} against ${opponent.name} is ready for confirmation.`
            : "Tessera website faction stress testing is ready for confirmation."
          : "One or more rosters are invalid and cannot be uploaded to Tessera.",
        rosterRef: input.rosterRef,
        opponentRef: input.opponentRef ?? null,
        roster: this.#summarizeRoster(roster),
        opponent: opponent ? this.#summarizeRoster(opponent) : null,
        bundleId: roster.sourceData.bundleId,
        violations: compactIssues([
          ...validation.violations,
          ...(opponentValidation?.violations ?? []),
        ]),
        warnings: compactIssues([
          ...catalogueDriftWarnings(configuration.catalogueDriftMode),
          ...validation.warnings,
          ...(opponentValidation?.warnings ?? []),
        ]),
        nextActions: ready ? [this.#stressAction()] : [],
      });
      await this.#writeOperation(next);
      return this.#publicSummary(next);
    }
    return this.#executeStress(operation, input, false);
  }

  async #executeStress(
    operation: OperationDocument,
    input: RunRequest,
    confirmedWebsite: boolean,
  ): Promise<OperationSummary> {
    if (!input.rosterRef) {
      return this.#updateFailure(
        operation,
        "ROSTER_REFERENCE_REQUIRED",
        "Tessera stress testing requires a rosterRef.",
      );
    }
    const parsed = parseStressConfiguration(input);
    if (!parsed.ok) {
      return this.#updateFailure(
        operation,
        parsed.code,
        parsed.message,
      );
    }
    const {
      options,
      backend,
      opponentFactionId,
      exactOpponent,
      suite,
      strategy,
      catalogueDriftMode,
      selectedPlayerAbilityIds,
      activationMode,
    } = parsed.data;
    if (
      backend !== "local-engine" &&
      !(backend === "website" && confirmedWebsite)
    ) {
      return this.#updateFailure(
        operation,
        "TESSERA_WEB_CONFIRMATION_REQUIRED",
        "Tessera website execution requires explicit confirmation through act.",
      );
    }
    if (exactOpponent && !this.#runExactStress) {
      return this.#updateFailure(
        operation,
        "TESSERA_EXACT_STRESS_UNAVAILABLE",
        "Exact Tessera roster testing is not configured.",
      );
    }
    if (!exactOpponent && !this.#runStress) {
      return this.#updateFailure(
        operation,
        "TESSERA_STRESS_UNAVAILABLE",
        "Tessera faction stress testing is not configured.",
      );
    }
    const roster = await this.#readRoster(input.rosterRef);
    const opponent = input.opponentRef
      ? await this.#readRoster(input.opponentRef)
      : null;
    let running = operation;
    if (operation.state === "action-required") {
      running = this.#nextRevision(operation, {
        state: "running",
        message: `Confirmed Tessera ${backend} stress test started.`,
        nextActions: [],
      });
      await this.#writeOperation(running);
    }
    const outputDirectory = path.join(
      this.#rootDirectory,
      "tessera-stress",
      operation.operationId,
    );
    try {
      const result = opponent
        ? await this.#runExactStress!(roster, opponent, {
            outputDirectory,
            overwrite: boolean(options.overwrite),
            backend,
            profilePolicyPath: text(options.profilePolicyPath),
            baselineReportPath: text(options.baselineReportPath),
            allowPointMismatch: boolean(options.allowPointMismatch),
            catalogueDriftMode,
            selectedPlayerAbilityIds,
            activationMode,
          })
        : await this.#runStress!(roster, opponentFactionId!, {
            outputDirectory,
            overwrite: boolean(options.overwrite),
            backend,
            suite,
            strategy,
            resumeManifestPath: text(options.resumeManifestPath),
            profilePolicyPath: text(options.profilePolicyPath),
            forceRetry: boolean(options.forceRetry),
            catalogueDriftMode,
          });
      const report = result.data;
      const artifacts = report
        ? await this.#storeStressArtifacts(
            outputDirectory,
            report,
            opponent
              ? `${safeFilename(roster.name)}-vs-${safeFilename(opponent.name)}-${backend}-exact-stress.json`
              : `${safeFilename(roster.name)}-${backend}-stress.json`,
            Array.isArray(record(report).revisedReports)
              ? `${safeFilename(roster.name)}-revision.html`
              : null,
          )
        : await this.#storeStressFailureArtifacts(
            outputDirectory,
            result.violations,
          );
      const reportRecord = record(report);
      const simulation = record(reportRecord.simulation);
      const comparisonSummary = record(reportRecord.summary);
      const findings = Array.isArray(reportRecord.findings)
        ? reportRecord.findings.slice(0, 8)
        : [];
      const next = this.#nextRevision(running, {
        state: result.ok ? "completed" : "failed",
        message: result.ok
          ? opponent
            ? `Completed exact Tessera ${backend} testing for ${roster.name} against ${opponent.name}.`
            : `Completed Tessera ${backend} stress testing against ${opponentFactionId}.`
          : `Tessera ${backend} stress testing did not complete.`,
        rosterRef: input.rosterRef,
        opponentRef: input.opponentRef ?? null,
        roster: this.#summarizeRoster(roster),
        opponent: opponent ? this.#summarizeRoster(opponent) : null,
        bundleId: roster.sourceData.bundleId,
        result: {
          backend,
          mode: opponent ? "exact" : "faction-portfolio",
          suite: opponent ? null : suite,
          strategy: opponent ? null : strategy,
          catalogueDriftMode,
          status: reportRecord.status ?? null,
          runId: reportRecord.runId ?? null,
          trustedMatrices: simulation.trustedMatrices ?? null,
          matrices: Array.isArray(simulation.matrices)
            ? simulation.matrices.length
            : null,
          scenarios: Array.isArray(simulation.scenarios)
            ? simulation.scenarios.length
            : null,
          conclusion: comparisonSummary.conclusion ?? null,
          aggregateCounts: comparisonSummary.aggregateCounts ?? null,
          findings,
        },
        artifacts,
        violations: compactIssues(result.violations),
        warnings: compactIssues([
          ...catalogueDriftWarnings(catalogueDriftMode),
          ...result.warnings,
        ]),
        nextActions: [],
      });
      await this.#writeOperation(next);
      return this.#publicSummary(next);
    } catch (error) {
      const website = backend === "website";
      const message = website
        ? "Tessera website execution stopped with an uncertain external outcome and will not be retried automatically."
        : "Local Tessera execution failed.";
      const failed = this.#nextRevision(running, {
        state: "failed",
        message,
        violations: [issue(
          website
            ? "TESSERA_WEB_EXECUTION_UNCERTAIN"
            : "TESSERA_LOCAL_EXECUTION_FAILED",
          error instanceof Error ? error.message : message,
        )],
        warnings: compactIssues(
          catalogueDriftWarnings(catalogueDriftMode),
        ),
        nextActions: [],
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
  }

  async #runSync(
    operation: OperationDocument,
    input: RunRequest,
  ): Promise<OperationSummary> {
    try {
      const result = await refreshDataNow({
        force: boolean(record(input.options).force, true),
      });
      const next = this.#nextRevision(operation, {
        state: result.ok ? "completed" : "failed",
        message: result.data?.localUpdateJobId
          ? `Data sync queued as ${result.data.localUpdateJobId}.`
          : result.ok
            ? "Data sources checked; the active verified snapshot remains available."
            : "Data sync could not be queued.",
        result: result.data
          ? {
              activeBundleId: result.data.status.activeBundleId,
              localUpdateJobId: result.data.localUpdateJobId ?? null,
              providerMode: result.data.status.providerMode,
              dataTrust: result.data.status.dataTrust,
            }
          : null,
        violations: compactIssues(result.violations),
        warnings: compactIssues(result.warnings),
        bundleId: result.data?.status.activeBundleId ?? null,
      });
      await this.#writeOperation(next);
      return this.#publicSummary(next);
    } catch (error) {
      return this.#updateFailure(
        operation,
        "DATA_SYNC_FAILED",
        error instanceof Error ? error.message : "Data sync failed.",
      );
    }
  }

  async #inspectData(): Promise<Record<string, unknown>> {
    const [status, update] = await Promise.all([
      Promise.resolve(getDataStatus()),
      getDataUpdateStatus(),
    ]);
    return {
      ok: status.ok && update.ok,
      active: status.data
        ? {
            edition: status.data.edition,
            rulesVersion: status.data.sources.rules.version,
            newRecruitCommit: status.data.sources.newRecruit.commit,
            officialVersion: status.data.sources.official.mfmVersion,
            officialCheckedAt: status.data.sources.official.checkedAt,
            factionCount: status.data.factionCount,
            buildableFactionCount: status.data.buildableFactionCount,
            bundleId: update.data?.activeBundleId ?? null,
          }
        : null,
      update: update.data
        ? {
            state: update.data.state,
            providerMode: update.data.providerMode,
            dataTrust: update.data.dataTrust,
            lastCheckedAt:
              update.data.localUpdate?.updatedAt ??
              status.data?.sources.official.checkedAt ??
              null,
            latestUpstream: update.data.sourceStatus?.latestUpstream ?? null,
            latestLocallyCertified:
              update.data.sourceStatus?.latestLocallyCertified ?? null,
            localUpdate: update.data.localUpdate
              ? {
                  jobId: update.data.localUpdate.jobId,
                  status: update.data.localUpdate.status,
                  progress: update.data.localUpdate.progress,
                  error: update.data.localUpdate.error ?? null,
                }
              : null,
            quarantinedScopes: update.data.quarantinedScopes,
          }
        : null,
      violations: compactIssues([...status.violations, ...update.violations]),
      warnings: compactIssues([...status.warnings, ...update.warnings]),
    };
  }

  async #inspectNewRecruit(): Promise<Record<string, unknown>> {
    if (!this.#newRecruitStatus) {
      return {
        ok: false,
        available: false,
        message: "Authenticated New Recruit upload is not configured.",
      };
    }
    const status = await this.#newRecruitStatus();
    return {
      ok: status.ok,
      available: status.data?.available ?? false,
      credentialState: status.data?.credentialState ?? "unavailable",
      browserState: status.data?.browserState ?? "unavailable",
      agentAvailable: status.data?.agentAvailable ?? false,
      installationCurrent: status.data?.installationCurrent ?? false,
      violations: compactIssues(status.violations),
      warnings: compactIssues(status.warnings),
    };
  }

  #modificationOperations(
    roster: RosterDraftV1,
    input: RunRequest,
  ): {
    operations: ModifyRosterOperation[];
    violations: RosterIssue[];
    nextActions: NextAction[];
    message: string;
  } {
    const options = record(input.options);
    const supplied = Array.isArray(options.operations)
      ? options.operations
      : options.operation
        ? [options.operation]
        : null;
    if (supplied) {
      const operations: ModifyRosterOperation[] = [];
      for (const value of supplied) {
        const parsed = ModifyRosterOperationSchema.safeParse(value);
        if (!parsed.success) {
          return {
            operations: [],
            violations: [issue(
              "MALFORMED_MODIFICATION",
              "A supplied roster modification is invalid.",
            )],
            nextActions: [],
            message: "The requested modification is invalid.",
          };
        }
        operations.push(parsed.data);
      }
      return {
        operations,
        violations: [],
        nextActions: [],
        message: "Structured modifications resolved.",
      };
    }
    const request = input.request?.trim() ?? "";
    const add = request.match(/^add\s+(?:(\d+)\s+models?\s+of\s+)?(.+)$/i);
    if (add) {
      const matches = searchUnits({
        faction: roster.factionId,
        query: add[2],
        includeLegends: roster.constraints.allowLegends,
        limit: 10,
      }).data ?? [];
      const exact = matches.filter((unit) =>
        unit.name.localeCompare(add[2].trim(), undefined, {
          sensitivity: "accent",
        }) === 0);
      const resolved = exact.length === 1
        ? exact[0]
        : matches.length === 1
          ? matches[0]
          : null;
      if (resolved) {
        return {
          operations: [{
            type: "add",
            unitId: resolved.id,
            ...(add[1] ? { modelCount: Number(add[1]) } : {}),
          }],
          violations: [],
          nextActions: [],
          message: `Resolved ${resolved.name}.`,
        };
      }
      return {
        operations: [],
        violations: [issue(
          "UNIT_AMBIGUOUS",
          `Could not resolve one unit from ${add[2].trim()}.`,
        )],
        nextActions: matches.length > 0
          ? [{
              actionId: "modify.choose-unit",
              label: "Choose the unit to add",
              requiresConfirmation: false,
              choices: matches.map((unit) => unit.id),
            }]
          : [],
        message: "The unit name is missing or ambiguous.",
      };
    }
    const remove = request.match(/^remove\s+(.+)$/i);
    if (remove) {
      const normalized = remove[1].trim().toLocaleLowerCase();
      const matches = roster.units.filter((unit) =>
        unit.selectionId === remove[1].trim() ||
        unit.name.toLocaleLowerCase().includes(normalized));
      if (matches.length === 1) {
        return {
          operations: [{ type: "remove", selectionId: matches[0].selectionId }],
          violations: [],
          nextActions: [],
          message: `Resolved ${matches[0].name}.`,
        };
      }
      return {
        operations: [],
        violations: [issue(
          "SELECTION_AMBIGUOUS",
          "The roster selection to remove is missing or ambiguous.",
        )],
        nextActions: matches.length > 0
          ? [{
              actionId: "modify.choose-selection",
              label: "Choose the selection to remove",
              requiresConfirmation: false,
              choices: matches.map((unit) => unit.selectionId),
            }]
          : [],
        message: "The roster selection is missing or ambiguous.",
      };
    }
    const modelCount = request.match(
      /^(?:set|change)\s+(?:the\s+)?(.+?)(?:\s+unit)?\s+to\s+(?:exactly\s+)?(\d+)\s+models?\.?$/i,
    );
    if (modelCount) {
      const selectionQuery = modelCount[1].trim();
      const normalized = selectionQuery.toLocaleLowerCase();
      const matches = roster.units.filter((unit) =>
        unit.selectionId === selectionQuery ||
        unit.name.toLocaleLowerCase().includes(normalized)
      );
      if (matches.length === 1) {
        return {
          operations: [{
            type: "set-model-count",
            selectionId: matches[0].selectionId,
            modelCount: Number(modelCount[2]),
          }],
          violations: [],
          nextActions: [],
          message: `Resolved ${matches[0].name}.`,
        };
      }
      return {
        operations: [],
        violations: [issue(
          "SELECTION_AMBIGUOUS",
          "The roster selection whose model count should change is missing or ambiguous.",
        )],
        nextActions: matches.length > 0
          ? [{
              actionId: "modify.choose-selection",
              label: "Choose the selection to resize",
              requiresConfirmation: false,
              choices: matches.map((unit) => unit.selectionId),
            }]
          : [],
        message: "The roster selection is missing or ambiguous.",
      };
    }
    const warlord = request.match(/^make\s+(.+?)\s+(?:the\s+)?warlord$/i);
    if (warlord) {
      const normalized = warlord[1].trim().toLocaleLowerCase();
      const matches = roster.units.filter((unit) =>
        unit.selectionId === warlord[1].trim() ||
        unit.name.toLocaleLowerCase().includes(normalized));
      if (matches.length === 1) {
        return {
          operations: [{
            type: "set-warlord",
            selectionId: matches[0].selectionId,
          }],
          violations: [],
          nextActions: [],
          message: `Resolved ${matches[0].name}.`,
        };
      }
    }
    return {
      operations: [],
      violations: [issue(
        "MODIFICATION_NOT_UNDERSTOOD",
        "Use add, remove, set … to N models, or make … warlord, or provide a structured operation.",
      )],
      nextActions: [],
      message: "The requested roster modification was not understood.",
    };
  }

  #newOperation(
    action: OperationDocument["action"],
    request: RunRequest | null,
  ): OperationDocument {
    const timestamp = this.#timestamp();
    return {
      schemaVersion: OPERATION_SCHEMA_VERSION,
      operationId: this.#createId(),
      revision: 0,
      action,
      state: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      bundleId: null,
      message: `${action} started.`,
      roster: null,
      opponent: null,
      result: null,
      artifacts: [],
      nextActions: [],
      violations: [],
      warnings: [],
      request,
      rosterRef: request?.rosterRef ?? null,
      opponentRef: request?.opponentRef ?? null,
      newRecruitMutation: null,
    };
  }

  #nextRevision(
    operation: OperationDocument,
    patch: Partial<OperationDocument>,
  ): OperationDocument {
    return {
      ...operation,
      ...patch,
      revision: operation.revision + 1,
      updatedAt: this.#timestamp(),
    };
  }

  #failedRevision(
    operation: OperationDocument,
    expectedRevision: number,
  ): OperationSummary {
    return {
      ...this.#publicSummary(operation),
      state: "failed",
      message:
        `Operation revision is ${operation.revision}; received ${expectedRevision}.`,
      violations: [issue(
        "OPERATION_REVISION_MISMATCH",
        "Reload the operation before attempting another action.",
      )],
    };
  }

  #actionFailure(
    operation: OperationDocument,
    code: string,
    message: string,
  ): OperationSummary {
    return {
      ...this.#publicSummary(operation),
      state: "failed",
      message,
      violations: [issue(code, message)],
    };
  }

  #confirmationRequired(
    operation: OperationDocument,
    message: string,
  ): OperationSummary {
    return {
      ...this.#publicSummary(operation),
      state: "action-required",
      message,
    };
  }

  async #updateFailure(
    operation: OperationDocument,
    code: string,
    message: string,
  ): Promise<OperationSummary> {
    const next = this.#nextRevision(operation, {
      state: "failed",
      message,
      violations: [issue(code, message)],
    });
    await this.#writeOperation(next);
    return this.#publicSummary(next);
  }

  #publicSummary(operation: OperationDocument): OperationSummary {
    return {
      schemaVersion: operation.schemaVersion,
      operationId: operation.operationId,
      revision: operation.revision,
      action: operation.action,
      state: operation.state,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      bundleId: operation.bundleId,
      message: compactText(operation.message || operationMessage(operation)),
      roster: operation.roster,
      opponent: operation.opponent,
      result: operation.result,
      artifacts: operation.artifacts,
      nextActions: operation.nextActions,
      violations: compactIssues(operation.violations),
      warnings: compactIssues(operation.warnings),
    };
  }

  #summarizeRoster(roster: RosterDraftV1, maximumUnits = 12): RosterSummary {
    const validation = validateRoster(roster);
    return {
      rosterId: roster.id,
      rosterRef: rosterRef(roster.id),
      name: compactText(roster.name, 160),
      factionId: roster.factionId,
      factionName: roster.factionName,
      points: `${roster.totalPoints}/${roster.pointsLimit}`,
      detachment: roster.detachmentName,
      disposition: roster.forceDispositionName,
      legal: validation.ok,
      unitCount: roster.units.length,
      units: roster.units.slice(0, maximumUnits).map((unit) => ({
        selectionId: unit.selectionId,
        unitId: unit.unitId,
        name: unit.name,
        models: unit.modelCount,
        points: unit.points,
        warlord: unit.isWarlord,
      })),
    };
  }

  #uploadAction(): NextAction {
    return {
      actionId: "new-recruit.upload",
      label: "Upload this roster to New Recruit",
      requiresConfirmation: true,
    };
  }

  async #newRecruitHandoffAvailability(
    roster: RosterDraftV1,
  ): Promise<{ nextActions: NextAction[]; warnings: RosterIssue[] }> {
    const preflight = await exportRoster(roster, "rosz");
    if (preflight.ok) {
      return { nextActions: [this.#uploadAction()], warnings: [] };
    }
    return {
      nextActions: [],
      warnings: [issue(
        "NEW_RECRUIT_HANDOFF_UNAVAILABLE",
        preflight.violations[0]?.message ??
          "This canonical roster is legal locally but cannot be represented safely in the active New Recruit catalogue.",
        "warn",
      )],
    };
  }

  #stressAction(): NextAction {
    return {
      actionId: "tessera.stress.run",
      label: "Run confirmed Tessera website stress test",
      requiresConfirmation: true,
    };
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  async #writeOperation(operation: OperationDocument): Promise<void> {
    if (!isSafeId(operation.operationId)) {
      throw new Error("Operation ID is unsafe.");
    }
    await writeAtomic(
      path.join(this.#directories.operations, `${operation.operationId}.json`),
      `${JSON.stringify(operation, null, 2)}\n`,
    );
  }

  async #readOperation(operationId: string): Promise<OperationDocument> {
    if (!isSafeId(operationId)) throw new Error("Operation ID is invalid.");
    return JSON.parse(await readFile(
      path.join(this.#directories.operations, `${operationId}.json`),
      "utf8",
    )) as OperationDocument;
  }

  async #storeRoster(
    roster: RosterDraftV1,
    importedFromSchemaVersion: number | null,
  ): Promise<string> {
    if (!isSafeId(roster.id)) {
      throw new Error(
        "ROSTER_REFERENCE_INVALID: The roster ID is not safe for durable storage.",
      );
    }
    const filename = path.join(this.#directories.rosters, `${roster.id}.json`);
    const document: StoredRosterDocumentV4 = {
      schemaVersion: STORED_ROSTER_SCHEMA_VERSION,
      storedAt: this.#timestamp(),
      importedFromSchemaVersion,
      roster,
    };
    const assertExistingMatches = async () => {
      let value: unknown;
      try {
        value = JSON.parse(await readFile(filename, "utf8")) as unknown;
      } catch {
        throw new Error(
          `ROSTER_REFERENCE_COLLISION: ${rosterRef(roster.id)} already exists but is not a readable stored roster.`,
        );
      }
      const existingDocument = record(value);
      const candidate =
        existingDocument.schemaVersion === STORED_ROSTER_SCHEMA_VERSION
          ? existingDocument.roster
          : value;
      const parsed = parseRosterDraft(candidate);
      if (
        !parsed.success ||
        parsed.data.id !== roster.id ||
        rosterSemanticFingerprint(parsed.data) !==
          rosterSemanticFingerprint(roster)
      ) {
        throw new Error(
          `ROSTER_REFERENCE_COLLISION: ${rosterRef(roster.id)} already contains different roster semantics.`,
        );
      }
    };
    const temporary = `${filename}.next-${process.pid}-${crypto.randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
    });
    try {
      await link(temporary, filename);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : null;
      if (code !== "EEXIST") throw error;
      await assertExistingMatches();
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return rosterRef(roster.id);
  }

  async #readRoster(ref: string): Promise<RosterDraftV1> {
    const rosterId = rosterIdFromRef(ref);
    if (!isSafeId(rosterId)) throw new Error("Roster reference is invalid.");
    const value = JSON.parse(await readFile(
      path.join(this.#directories.rosters, `${rosterId}.json`),
      "utf8",
    )) as unknown;
    const document = record(value);
    const candidate = document.schemaVersion === STORED_ROSTER_SCHEMA_VERSION
      ? document.roster
      : value;
    const parsed = parseRosterDraft(candidate);
    if (!parsed.success) throw new Error("Stored roster is invalid.");
    return parsed.data;
  }

  async #storeExportArtifact(
    artifact: ExportArtifact,
  ): Promise<ArtifactReference> {
    const content = typeof artifact.content === "string"
      ? artifact.content
      : artifact.content;
    return this.#storeArtifact({
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      encoding: artifact.encoding,
      content,
    });
  }

  async #storeJsonArtifact(
    filename: string,
    value: unknown,
  ): Promise<ArtifactReference> {
    return this.#storeArtifact({
      filename,
      mimeType: "application/json",
      encoding: "utf8",
      content: `${JSON.stringify(value, null, 2)}\n`,
    });
  }

  async #storeStressArtifacts(
    outputDirectory: string,
    report: unknown,
    fallbackFilename: string,
    fallbackHtmlFilename: string | null,
  ): Promise<ArtifactReference[]> {
    const reportArtifacts = Array.isArray(record(report).artifacts)
      ? record(report).artifacts as unknown[]
      : [];
    const writtenArtifact = (format: string): string | null => {
      const match = reportArtifacts
        .map((value) => record(value))
        .find((value) => value.format === format);
      return match ? text(match.written) ?? null : null;
    };
    const resolvedOutputDirectory = path.resolve(outputDirectory);
    const resolveWritten = (written: string | null): string | null => {
      if (!written) return null;
      const candidate = path.resolve(outputDirectory, written);
      const relative = path.relative(resolvedOutputDirectory, candidate);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? candidate
        : null;
    };
    const reportPath = resolveWritten(writtenArtifact("matchup-json"));
    const receiptPath = resolveWritten(writtenArtifact("matchup-receipt"));
    let jsonArtifact: ArtifactReference;
    if (
      reportPath &&
      receiptPath &&
      (await exists(reportPath)) &&
      (await exists(receiptPath))
    ) {
      jsonArtifact = await this.#storeArtifact({
        filename: path.basename(reportPath),
        mimeType: "application/json",
        encoding: "utf8",
        content: await readFile(reportPath),
      });
      const metadata = await this.#readArtifactMetadata(jsonArtifact.uri);
      const storedReceiptPath = path.join(
        path.dirname(metadata.path),
        path.basename(receiptPath),
      );
      if (!(await exists(storedReceiptPath))) {
        await writeAtomic(storedReceiptPath, await readFile(receiptPath));
      }
    } else {
      jsonArtifact = await this.#storeJsonArtifact(fallbackFilename, report);
    }
    const htmlWritten = reportArtifacts
      .map((value) => record(value))
      .find((value) => typeof value.format === "string" && value.format.endsWith("-html"));
    const htmlPath = resolveWritten(
      htmlWritten ? text(htmlWritten.written) ?? null : fallbackHtmlFilename,
    );
    if (!htmlPath || !(await exists(htmlPath))) return [jsonArtifact];
    const htmlArtifact = await this.#storeArtifact({
      filename: path.basename(htmlPath),
      mimeType: "text/html",
      encoding: "utf8",
      content: await readFile(htmlPath),
    });
    return [jsonArtifact, htmlArtifact];
  }

  async #storeStressFailureArtifacts(
    outputDirectory: string,
    violations: RosterIssue[],
  ): Promise<ArtifactReference[]> {
    const profilePolicyRequired = violations.some((violation) =>
      violation.code === "TESSERA_PROFILE_POLICY_REQUIRED" ||
      violation.code === "TESSERA_PROFILE_POLICY_REQUIRED_AFTER_ENRICHMENT"
    );
    if (!profilePolicyRequired) return [];
    const scaffoldPath = path.join(
      outputDirectory,
      "tessera-profile-policy.scaffold.json",
    );
    if (!(await exists(scaffoldPath))) return [];
    const content = await readFile(scaffoldPath);
    let scaffold: Record<string, unknown>;
    try {
      scaffold = record(JSON.parse(content.toString("utf8")));
    } catch {
      return [];
    }
    if (
      scaffold.schemaVersion !== 1 ||
      scaffold.policyKind !== "tessera-profile-policy" ||
      !Array.isArray(scaffold.entries)
    ) {
      return [];
    }
    return [await this.#storeArtifact({
      filename: path.basename(scaffoldPath),
      mimeType: "application/json",
      encoding: "utf8",
      content,
    })];
  }

  async #storeArtifact(input: {
    filename: string;
    mimeType: string;
    encoding: "utf8" | "binary";
    content: string | Uint8Array;
  }): Promise<ArtifactReference> {
    const artifactId = contentSha256(input.content);
    const directory = path.join(this.#directories.artifacts, artifactId);
    const filename = safeFilename(input.filename);
    const contentPath = path.join(directory, filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await exists(contentPath))) {
      await writeAtomic(contentPath, input.content);
    }
    const reference: ArtifactReference = {
      artifactId,
      uri: `rosterpilot://artifacts/${artifactId}`,
      filename,
      mimeType: input.mimeType,
      encoding: input.encoding,
      bytes: typeof input.content === "string"
        ? Buffer.byteLength(input.content)
        : input.content.byteLength,
    };
    const metadata: StoredArtifactDocument = {
      ...reference,
      storedAt: this.#timestamp(),
      path: contentPath,
    };
    await writeAtomic(
      path.join(directory, "artifact.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    return reference;
  }

  async #readArtifactMetadata(ref: string): Promise<StoredArtifactDocument> {
    const artifactId = artifactIdFromRef(ref);
    if (!/^[a-f0-9]{64}$/.test(artifactId)) {
      throw new Error("Artifact reference is invalid.");
    }
    return JSON.parse(await readFile(
      path.join(this.#directories.artifacts, artifactId, "artifact.json"),
      "utf8",
    )) as StoredArtifactDocument;
  }

  async #readArtifactContent(
    artifact: StoredArtifactDocument,
  ): Promise<string> {
    const bytes = await readFile(artifact.path);
    return artifact.encoding === "binary"
      ? bytes.toString("base64")
      : bytes.toString("utf8");
  }

  async #publishArtifact(
    artifact: ArtifactReference,
    outputPath: string,
    overwrite: boolean,
  ): Promise<string> {
    const metadata = await this.#readArtifactMetadata(artifact.uri);
    const resolved = path.resolve(outputPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await copyFile(
      metadata.path,
      resolved,
      overwrite ? 0 : fsConstants.COPYFILE_EXCL,
    );
    return resolved;
  }
}

export function defaultRosterPilotServiceLease<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  return withDataBundleSnapshotLease(operation);
}

export function operationResourceUri(operationId: string): string {
  return operationRef(operationId);
}
