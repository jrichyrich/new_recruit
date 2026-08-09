import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
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
import { ModifyRosterOperationSchema } from "./types";
import {
  analyzeExactRosterMatchup,
  type LocalMatchupReport,
} from "./matchup";
import type {
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
    const operation = await this.#readOperation(input.operationId);
    if (operation.revision !== input.expectedRevision) {
      return this.#failedRevision(operation, input.expectedRevision);
    }
    if (input.actionId === "tessera.stress.run") {
      if (!input.confirm) {
        const next = this.#nextRevision(operation, {
          state: "action-required",
          message: "Tessera website upload and stress execution require explicit confirmation.",
          nextActions: [this.#stressAction()],
        });
        await this.#writeOperation(next);
        return this.#publicSummary(next);
      }
      if (operation.request?.action !== "stress") {
        return this.#updateFailure(
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
      return this.#updateFailure(
        operation,
        "ACTION_NOT_SUPPORTED",
        `Action ${input.actionId} is not available.`,
      );
    }
    if (!input.confirm) {
      const next = this.#nextRevision(operation, {
        state: "action-required",
        message: "New Recruit upload requires explicit confirmation.",
        nextActions: [this.#uploadAction()],
      });
      await this.#writeOperation(next);
      return this.#publicSummary(next);
    }
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
    const completed = this.#nextRevision(operation, {
      state: validation.ok ? "completed" : "failed",
      message: validation.ok
        ? "Roster imported into the V4 store."
        : "Roster migrated but failed current validation.",
      rosterRef: stored,
      roster: this.#summarizeRoster(parsed.data),
      violations: compactIssues(validation.violations),
      warnings: compactIssues(validation.warnings),
      nextActions: validation.ok ? [this.#uploadAction()] : [],
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
      : searchFactions(query, number(options.limit) ?? 20);
    const units = faction
      ? searchUnits({
          faction,
          query,
          includeLegends: boolean(options.includeLegends),
          limit: number(options.limit) ?? 30,
        })
      : null;
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
    const options = record(input.options);
    const result = buildRoster({
      prompt: input.request,
      playerFaction: text(options.faction),
      pointsLimit: number(options.pointsLimit),
      name: text(options.name),
      allowLegends: boolean(options.allowLegends),
      allowNamedCharacters:
        typeof options.allowNamedCharacters === "boolean"
          ? options.allowNamedCharacters
          : undefined,
      collectionUnitIds: Array.isArray(options.collectionUnitIds)
        ? options.collectionUnitIds.filter((value): value is string =>
            typeof value === "string")
        : undefined,
    });
    if (!result.ok || !result.data) {
      const failed = this.#nextRevision(operation, {
        state: "failed",
        message: "Roster construction failed.",
        violations: compactIssues(result.violations),
        warnings: compactIssues(result.warnings),
      });
      await this.#writeOperation(failed);
      return this.#publicSummary(failed);
    }
    const stored = await this.#storeRoster(result.data, null);
    const explanation = explainRoster(result.data);
    const next = this.#nextRevision(operation, {
      state: "completed",
      message: `Built and validated ${result.data.name}.`,
      rosterRef: stored,
      roster: this.#summarizeRoster(result.data),
      result: explanation.data
        ? {
            summary: explanation.data.summary,
            choices: explanation.data.choices.slice(0, 8),
            cautions: explanation.data.cautions.slice(0, 8),
          }
        : null,
      warnings: compactIssues([
        ...result.warnings,
        ...explanation.warnings,
      ]),
      nextActions: [this.#uploadAction()],
      bundleId: result.data.sourceData.bundleId,
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
    const next = this.#nextRevision(operation, {
      state: "completed",
      message: `Modified and validated ${result.data.name}.`,
      rosterRef: stored,
      roster: this.#summarizeRoster(result.data),
      warnings: compactIssues(result.warnings),
      nextActions: [this.#uploadAction()],
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
    const next = this.#nextRevision(operation, {
      state: "completed",
      message: `Exported ${roster.name} as ${input.format}.`,
      rosterRef: input.rosterRef,
      roster: this.#summarizeRoster(roster),
      artifacts: [reference],
      warnings: compactIssues(result.warnings),
      nextActions: [this.#uploadAction()],
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
    const options = record(input.options);
    const backend = text(options.backend) ?? "local-engine";
    if (backend !== "local-engine" && backend !== "website") {
      return this.#updateFailure(
        operation,
        "STRESS_BACKEND_INVALID",
        "Tessera stress backend must be local-engine or website.",
      );
    }
    const opponentFactionId = text(options.opponentFaction);
    if (input.opponentRef && opponentFactionId) {
      return this.#updateFailure(
        operation,
        "OPPONENT_SCOPE_CONFLICT",
        "Choose either opponentRef for an exact roster or options.opponentFaction for a faction portfolio, not both.",
      );
    }
    if (backend === "website") {
      if (!input.rosterRef) {
        return this.#updateFailure(
          operation,
          "ROSTER_REFERENCE_REQUIRED",
          "Tessera stress testing requires a rosterRef.",
        );
      }
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
    const options = record(input.options);
    const backend = text(options.backend) ?? "local-engine";
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
    const opponentFactionId = text(options.opponentFaction);
    const exactOpponent = Boolean(input.opponentRef);
    if (exactOpponent && opponentFactionId) {
      return this.#updateFailure(
        operation,
        "OPPONENT_SCOPE_CONFLICT",
        "Choose either opponentRef for an exact roster or options.opponentFaction for a faction portfolio, not both.",
      );
    }
    if (!exactOpponent && !opponentFactionId) {
      return this.#updateFailure(
        operation,
        "OPPONENT_FACTION_REQUIRED",
        "Tessera stress testing requires opponentRef or options.opponentFaction.",
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
    const suite = text(options.suite) ?? "core-3";
    const strategy = text(options.strategy) ?? "staged";
    if (!exactOpponent && suite !== "core-3" && suite !== "diverse-9") {
      return this.#updateFailure(
        operation,
        "STRESS_SUITE_INVALID",
        "Tessera stress suite must be core-3 or diverse-9.",
      );
    }
    if (!exactOpponent && strategy !== "staged" && strategy !== "full-all") {
      return this.#updateFailure(
        operation,
        "STRESS_STRATEGY_INVALID",
        "Tessera stress strategy must be staged or full-all.",
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
    const result = opponent
      ? await this.#runExactStress!(roster, opponent, {
          outputDirectory,
          overwrite: boolean(options.overwrite),
          backend,
          profilePolicyPath: text(options.profilePolicyPath),
          baselineReportPath: text(options.baselineReportPath),
          allowPointMismatch: boolean(options.allowPointMismatch),
        })
      : await this.#runStress!(roster, opponentFactionId!, {
          outputDirectory,
          overwrite: boolean(options.overwrite),
          backend,
          suite: suite as "core-3" | "diverse-9",
          strategy: strategy as "staged" | "full-all",
          resumeManifestPath: text(options.resumeManifestPath),
          profilePolicyPath: text(options.profilePolicyPath),
          forceRetry: boolean(options.forceRetry),
        });
    const report = result.data;
    const artifact = report
      ? await this.#storeJsonArtifact(
          opponent
            ? `${safeFilename(roster.name)}-vs-${safeFilename(opponent.name)}-${backend}-exact-stress.json`
            : `${safeFilename(roster.name)}-${backend}-stress.json`,
          report,
        )
      : null;
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
      artifacts: artifact ? [artifact] : [],
      violations: compactIssues(result.violations),
      warnings: compactIssues(result.warnings),
      nextActions: [],
    });
    await this.#writeOperation(next);
    return this.#publicSummary(next);
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
        "Use add, remove, or make … warlord, or provide a structured operation.",
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
      message: operation.message || operationMessage(operation),
      roster: operation.roster,
      opponent: operation.opponent,
      result: operation.result,
      artifacts: operation.artifacts,
      nextActions: operation.nextActions,
      violations: compactIssues(operation.violations),
      warnings: compactIssues(operation.warnings),
    };
  }

  #summarizeRoster(roster: RosterDraftV1): RosterSummary {
    const validation = validateRoster(roster);
    return {
      rosterId: roster.id,
      rosterRef: rosterRef(roster.id),
      name: roster.name,
      factionId: roster.factionId,
      factionName: roster.factionName,
      points: `${roster.totalPoints}/${roster.pointsLimit}`,
      detachment: roster.detachmentName,
      disposition: roster.forceDispositionName,
      legal: validation.ok,
      unitCount: roster.units.length,
      units: roster.units.slice(0, 12).map((unit) => ({
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
    const filename = path.join(this.#directories.rosters, `${roster.id}.json`);
    const document: StoredRosterDocumentV4 = {
      schemaVersion: STORED_ROSTER_SCHEMA_VERSION,
      storedAt: this.#timestamp(),
      importedFromSchemaVersion,
      roster,
    };
    await writeAtomic(filename, `${JSON.stringify(document, null, 2)}\n`);
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
