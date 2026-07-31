import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareNewRecruitCatalogueProvenance,
  getNewRecruitFactionSummary,
  newRecruitCatalogue,
  prepareNewRecruitHandoff,
  inspectEnrichedRosz,
  validateEnrichedRosz,
  validateRoster,
  type ExportArtifact,
  type ConnectorEvent,
  type NewRecruitConnectionStatus,
  type NewRecruitCatalogueProvenanceComparison,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../../lib/rosterpilot";
import {
  resolveExportArtifactTargets,
  writeExportArtifact,
  writeExportArtifacts,
  type WriteOptions,
} from "../../lib/rosterpilot/io";
import {
  deliverThroughLocalAgent,
  getLocalAgentStatus,
  LocalAgentError,
  probeNewRecruitThroughLocalAgent,
} from "../agent/client";
import {
  installedBrokerPath,
  newRecruitProfileDirectory,
  stagedBrokerPath,
} from "../agent/paths";
import {
  getRuntimeProvenance,
  runtimeRestartIssue,
} from "../runtime-provenance";
import {
  beginNewRecruitMutationReceipt,
  beginNewRecruitRoszMutationReceipt,
  newRecruitRoszMutationSubject,
  type NewRecruitMutationFinalization,
  type NewRecruitMutationTransaction,
} from "./cache";
import { safeNewRecruitUiIdentity } from "./ui-identity";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export type NewRecruitDeliveryOptions = WriteOptions & {
  downloadEnrichedRosz?: boolean;
  downloadPrettyHtml?: boolean;
  outputDirectory?: string;
  /** Internal durable-run identity for mutation receipts and inventory. */
  mutationRunId?: string;
  /**
   * Exact/Tessera coordinators that already own a mutation transaction must
   * opt out so the public companion does not create a nested receipt.
   */
  mutationReceiptMode?: "managed" | "external";
  /**
   * When enriching an uploaded ROSZ for a canonical roster, bind the receipt
   * to that roster instead of the content-addressed uploaded-file subject.
   */
  mutationSubjectRoster?: RosterDraftV1;
};

export type NewRecruitCompanionDependencies = {
  platform?: NodeJS.Platform;
  browserAvailable?: boolean;
  agentDeliver?: typeof deliverThroughLocalAgent;
  runtimeIssue?: typeof runtimeRestartIssue;
};

export type NewRecruitProbeDependencies = {
  platform?: NodeJS.Platform;
  browserAvailable?: boolean;
  agentProbe?: typeof probeNewRecruitThroughLocalAgent;
  runtimeIssue?: typeof runtimeRestartIssue;
};

export type NewRecruitLiveProbe = {
  uiIdentity: string;
  sessionReused: boolean;
  importControlVisible: true;
};

type BrokerResponse = {
  ok: boolean;
  configured?: boolean;
  code?: string;
  message?: string;
};

function brokerPath(): string {
  return process.env.ROSTERPILOT_KEYCHAIN_BROKER ?? installedBrokerPath();
}

function profileDirectory(): string {
  return newRecruitProfileDirectory();
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(
  command: string,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        code: code ?? 1,
      }),
    );
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function ensureBroker(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("The New Recruit Keychain companion requires macOS.");
  }
  const configured = brokerPath();
  if (await exists(configured)) return configured;
  if (process.env.ROSTERPILOT_KEYCHAIN_BROKER) {
    throw new Error(`The configured Keychain broker does not exist: ${configured}`);
  }
  const staged = stagedBrokerPath();
  if (await exists(staged)) return staged;
  const built = await runProcess(process.execPath, [
    path.join(projectRoot, "scripts", "build-new-recruit-companion.mjs"),
  ]);
  if (built.code !== 0 || !(await exists(staged))) {
    throw new Error(built.stderr || "The Keychain broker could not be built.");
  }
  return staged;
}

export type KeychainProvider = "new-recruit" | "tessera";

async function runBroker(
  command: "configure" | "status" | "forget",
  provider: KeychainProvider,
) {
  const configured = brokerPath();
  const executable =
    command === "status" && (await exists(configured))
      ? configured
      : await ensureBroker();
  if (!(await exists(executable))) {
    return {
      ok: false,
      configured: false,
      code: "COMPANION_UNAVAILABLE",
      message: "The Keychain broker has not been built.",
    } satisfies BrokerResponse;
  }
  const result = await runProcess(executable, [command, provider]);
  try {
    return JSON.parse(result.stdout) as BrokerResponse;
  } catch {
    return {
      ok: false,
      code: "COMPANION_FAILED",
      message: result.stderr || "The Keychain broker returned an invalid response.",
    } satisfies BrokerResponse;
  }
}

export async function getNewRecruitConnectionStatus(): Promise<
  ResultEnvelope<NewRecruitConnectionStatus>
> {
  const browserAvailable = await exists(chromePath);
  const brokerAvailable =
    (await exists(brokerPath())) || (await exists(stagedBrokerPath()));
  let agentStatus: Awaited<ReturnType<typeof getLocalAgentStatus>> | null = null;
  let agentError: LocalAgentError | null = null;
  try {
    agentStatus = await getLocalAgentStatus({ timeoutMs: 2_000 });
  } catch (error) {
    agentError =
      error instanceof LocalAgentError
        ? error
        : new LocalAgentError(
            "LOCAL_AGENT_UNAVAILABLE",
            error instanceof Error
              ? error.message
              : "The RosterPilot local agent is unavailable.",
          );
  }
  const newRecruitProvider = agentStatus?.providers.find(
    (provider) => provider.providerId === "new-recruit",
  );
  const installationCurrent =
    agentStatus?.projectDirectory === projectRoot;
  const runtime = getRuntimeProvenance();
  const runtimeCompatible =
    agentStatus?.runtime?.buildId === runtime.buildId &&
    agentStatus.runtime.stale === false &&
    runtime.stale === false;
  const available =
    process.platform === "darwin" &&
    agentStatus?.available === true &&
    agentStatus.protocolCompatible &&
    installationCurrent &&
    runtimeCompatible &&
    agentStatus.browserAvailable &&
    agentStatus.brokerAvailable &&
    newRecruitProvider?.credentialState === "ready";
  const statusWarning = agentError
      ? {
          code: agentError.code,
          message: agentError.message,
          severity: "warn" as const,
        }
      : null;
  return {
    ok: true,
    data: {
      available,
      platform: process.platform,
      browserAvailable,
      brokerAvailable,
      credentialsConfigured:
        newRecruitProvider?.credentialState === "ready",
      profileDirectory: process.platform === "darwin" ? profileDirectory() : null,
      agentAvailable: agentStatus?.available === true,
      agentVersion: agentStatus?.version ?? null,
      protocolCompatible: agentStatus?.protocolCompatible === true,
      installationCurrent,
      runtimeCompatible,
      runtimeBuildId: runtime.buildId,
      agentRuntimeBuildId: agentStatus?.runtime?.buildId ?? null,
      credentialState:
        newRecruitProvider?.credentialState ??
        (brokerAvailable ? "unavailable" : "not-configured"),
      browserState: browserAvailable ? "ready" : "unavailable",
    },
    violations: [],
    warnings: statusWarning
      ? [statusWarning]
      : !runtimeCompatible && agentStatus?.available
        ? [
          {
            code: "RUNTIME_RESTART_REQUIRED",
            message:
              "The MCP process and local agent do not share the same current source fingerprint. Restart both before New Recruit delivery.",
            severity: "warn",
          },
        ]
      : !installationCurrent && agentStatus?.available
        ? [
          {
            code: "LOCAL_AGENT_CHECKOUT_MISMATCH",
            message:
              'The running local agent belongs to another checkout. Run "rosterpilot agent install" from this checkout before automated delivery.',
            severity: "warn",
          },
        ]
      : available
        ? []
        : [
          {
            code: "LOCAL_AGENT_UNAVAILABLE",
            message:
              "New Recruit automation requires macOS, Google Chrome, the current local agent, and configured New Recruit credentials.",
            severity: "warn",
          },
        ],
  };
}

export async function configureNewRecruitCredentials(): Promise<BrokerResponse> {
  return runBroker("configure", "new-recruit");
}

export async function forgetNewRecruitCredentials(): Promise<BrokerResponse> {
  return runBroker("forget", "new-recruit");
}

export async function configureKeychainProvider(
  provider: KeychainProvider,
): Promise<BrokerResponse> {
  return runBroker("configure", provider);
}

export async function forgetKeychainProvider(
  provider: KeychainProvider,
): Promise<BrokerResponse> {
  return runBroker("forget", provider);
}

export async function probeNewRecruitLiveUi(
  dependencies: NewRecruitProbeDependencies = {},
): Promise<ResultEnvelope<NewRecruitLiveProbe>> {
  const restartIssue = dependencies.runtimeIssue
    ? dependencies.runtimeIssue()
    : dependencies.agentProbe
      ? null
      : runtimeRestartIssue();
  if (restartIssue) {
    return {
      ok: false,
      data: null,
      violations: [{ ...restartIssue, severity: "error" }],
      warnings: [],
    };
  }
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "UNSUPPORTED_PLATFORM",
          message:
            "The authenticated New Recruit UI probe requires macOS.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const browserAvailable =
    dependencies.browserAvailable ?? (await exists(chromePath));
  if (!browserAvailable) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "COMPANION_UNAVAILABLE",
          message:
            "Google Chrome is unavailable for the authenticated New Recruit UI probe.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  try {
    const result = await (
      dependencies.agentProbe ??
      probeNewRecruitThroughLocalAgent
    )();
    const uiIdentity = safeNewRecruitUiIdentity(
      result.uiIdentity,
    );
    if (
      !result.ok ||
      !uiIdentity ||
      !result.importControlVisible
    ) {
      return {
        ok: false,
        data: null,
        violations: [
          {
            code:
              result.code ??
              (!uiIdentity
                ? "NEW_RECRUIT_UI_IDENTITY_MISSING"
                : "NEW_RECRUIT_UI_CHANGED"),
            message:
              result.message ??
              "The authenticated New Recruit UI probe did not verify the current import surface.",
            severity: "error",
          },
        ],
        warnings: [],
      };
    }
    return {
      ok: true,
      data: {
        uiIdentity,
        sessionReused: result.sessionReused,
        importControlVisible: true,
      },
      violations: [],
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code:
            error instanceof LocalAgentError
              ? error.code
              : "LOCAL_AGENT_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "The authenticated New Recruit UI probe failed.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
}

function htmlFilename(roszFilename: string): string {
  return roszFilename.replace(/\.rosz$/i, "-new-recruit.html");
}

function enrichedFilename(roszFilename: string): string {
  return roszFilename.replace(/\.rosz$/i, "-new-recruit-enriched.rosz");
}

function mutationRunId(
  options: NewRecruitDeliveryOptions,
  prefix: string,
): string {
  return (
    options.mutationRunId?.trim() ||
    `${prefix}-${crypto.randomUUID()}`
  );
}

function mutationEvent(input: {
  eventId: string;
  recordedAt: string;
  imported: boolean;
  remoteOutcomeUnknown?: boolean;
  workerOk: boolean;
  remoteId: string | null;
  contentSha256: string;
  verified?: boolean;
}): ConnectorEvent {
  const mayHaveCreated =
    input.imported || input.remoteOutcomeUnknown === true;
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    recordedAt: input.recordedAt,
    provider: "new-recruit",
    action: "prepare",
    origin: mayHaveCreated ? "new-remote" : "in-memory",
    outcome: input.verified
      ? input.imported
        ? "verified"
        : "reused"
      : input.workerOk && !mayHaveCreated
        ? "reused"
        : mayHaveCreated
          ? "uncertain"
          : "failed",
    remoteId: input.remoteId,
    contentSha256: input.contentSha256,
  };
}

function mutationFinalization(
  event: ConnectorEvent,
  message: string,
): NewRecruitMutationFinalization {
  if (
    event.origin === "new-remote" &&
    event.outcome === "verified"
  ) {
    return {
      outcome: "created",
      connectorEvent: event,
      message,
    };
  }
  if (
    event.outcome === "reused" ||
    (event.outcome === "verified" &&
      event.origin !== "new-remote")
  ) {
    return {
      outcome: "reused",
      connectorEvent: {
        ...event,
        outcome: "reused",
      },
      message,
    };
  }
  if (
    event.outcome === "failed" &&
    event.origin !== "new-remote"
  ) {
    return {
      outcome: "not-created",
      connectorEvent: event,
      message,
    };
  }
  return {
    outcome: "uncertain",
    connectorEvent: {
      ...event,
      outcome: "uncertain",
    },
    message,
  };
}

function mutationReceiptViolation(
  error: unknown,
): {
  code: string;
  message: string;
  severity: "error";
} {
  return {
    code:
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "NEW_RECRUIT_MUTATION_RECEIPT_FAILED",
    message:
      error instanceof Error
        ? error.message
        : "The durable New Recruit mutation receipt could not be written.",
    severity: "error",
  };
}

async function preserveRejectedEnrichedRosz(
  content: Uint8Array,
  sourceFilename: string,
  outputDirectory: string,
  options: WriteOptions,
): Promise<
  NonNullable<NewRecruitDelivery["diagnosticArtifacts"]>[number]
> {
  const sha256 = crypto
    .createHash("sha256")
    .update(content)
    .digest("hex");
  const basename = path
    .basename(sourceFilename)
    .replace(/\.rosz$/i, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "roster";
  const diagnosticDirectory = path.join(
    outputDirectory,
    "_diagnostics",
  );
  const filename =
    `${basename}-rejected-${sha256.slice(0, 12)}.rosz`;
  const artifact: ExportArtifact = {
    format: "rosz",
    filename,
    mimeType: "application/zip",
    encoding: "binary",
    content,
  };
  const [target] = await resolveExportArtifactTargets(
    [artifact],
    diagnosticDirectory,
    { ...options, overwrite: true },
  );
  if (await exists(target)) {
    const existing = await readFile(target);
    const existingSha256 = crypto
      .createHash("sha256")
      .update(existing)
      .digest("hex");
    if (existingSha256 !== sha256) {
      throw new Error(
        "The rejected enriched-roster diagnostic path already contains different content.",
      );
    }
  } else {
    await writeExportArtifact(
      artifact,
      target,
      { ...options, overwrite: false },
    );
  }
  return {
    kind: "rejected-new-recruit-enriched-rosz",
    path: target,
    sha256,
  };
}

export async function deliverRosterToNewRecruit(
  draft: RosterDraftV1,
  options: NewRecruitDeliveryOptions = {},
  dependencies: NewRecruitCompanionDependencies = {},
): Promise<ResultEnvelope<NewRecruitDelivery>> {
  const validation = validateRoster(draft);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }
  const staleDataWarnings = validation.warnings.filter((warning) =>
    [
      "DATA_VERSION_CHANGED",
      "DATA_RELEASE_CHANGED",
      "CATALOGUE_VERSION_CHANGED",
    ].includes(warning.code),
  );
  if (staleDataWarnings.length > 0) {
    return {
      ok: false,
      data: null,
      violations: staleDataWarnings.map((warning) => ({
        ...warning,
        severity: "error" as const,
      })),
      warnings: validation.warnings.filter(
        (warning) =>
          !staleDataWarnings.some(
            (stale) => stale.code === warning.code,
          ),
      ),
    };
  }
  const restartIssue = dependencies.runtimeIssue
    ? dependencies.runtimeIssue()
    : dependencies.agentDeliver
      ? null
      : runtimeRestartIssue();
  if (restartIssue) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          ...restartIssue,
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "UNSUPPORTED_PLATFORM",
          message: "Automated New Recruit delivery requires macOS.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  const browserAvailable =
    dependencies.browserAvailable ?? (await exists(chromePath));
  if (!browserAvailable) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "COMPANION_UNAVAILABLE",
          message: "Google Chrome is not installed in /Applications.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }

  const handoff = await prepareNewRecruitHandoff(draft, false);
  const rosz = handoff.data?.artifacts[0];
  if (!handoff.ok || !rosz) {
    return {
      ok: false,
      data: null,
      violations: handoff.violations,
      warnings: handoff.warnings,
    };
  }
  const includePretty = options.downloadPrettyHtml !== false;
  const includeEnriched = options.downloadEnrichedRosz === true;
  const outputDirectory = options.outputDirectory ?? "exports/new-recruit";
  const planned: ExportArtifact[] = [
    rosz,
    ...(includeEnriched
      ? [
          {
            format: "rosz" as const,
            filename: enrichedFilename(rosz.filename),
            mimeType: "application/zip",
            encoding: "binary" as const,
            content: new Uint8Array(),
          },
        ]
      : []),
    ...(includePretty
      ? [
          {
            format: "html" as const,
            filename: htmlFilename(rosz.filename),
            mimeType: "text/html; charset=utf-8",
            encoding: "utf8" as const,
            content: "",
          },
        ]
      : []),
  ];
  try {
    await resolveExportArtifactTargets(planned, outputDirectory, options);
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "FILE_COLLISION",
          message: error instanceof Error ? error.message : "Output path rejected.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }

  const delivery: NewRecruitDelivery = {
    rosterId: draft.id,
    rosterName: draft.name,
    uiIdentity: null,
    listUrl: null,
    imported: false,
    sessionReused: false,
    connectorEvents: [],
    verification: null,
    enrichedSummary: null,
    catalogueProvenance: null,
    diagnosticArtifacts: [],
    artifacts: [],
  };
  const connectorEventId = crypto.randomUUID();
  const connectorEventRecordedAt = new Date().toISOString();
  const sourceRoszSha256 = crypto
    .createHash("sha256")
    .update(rosz.content)
    .digest("hex");
  const publishSource = async () => {
    const [written] = await writeExportArtifacts(
      [rosz],
      outputDirectory,
      options,
    );
    delivery.artifacts = [
      {
        format: "rosterpilot-source-rosz",
        filename: rosz.filename,
        mimeType: rosz.mimeType,
        written,
      },
    ];
  };
  let mutationTransaction: NewRecruitMutationTransaction | null =
    null;
  if (options.mutationReceiptMode !== "external") {
    try {
      mutationTransaction =
        await beginNewRecruitMutationReceipt({
          roster: draft,
          runId: mutationRunId(
            options,
            "direct-new-recruit",
          ),
          expectedSourceRoszSha256: sourceRoszSha256,
        });
    } catch (error) {
      return {
        ok: false,
        data: null,
        violations: [mutationReceiptViolation(error)],
        warnings: validation.warnings,
      };
    }
  }
  let agentDispatchStarted = false;
  let workerResponseReceived = false;
  let mutationFinalizationAttempted = false;
  let observedMutationEvent: ConnectorEvent | null = null;
  const observeMutationEvent = async (
    event: ConnectorEvent,
  ): Promise<void> => {
    observedMutationEvent = event;
    delivery.connectorEvents = [event];
    await mutationTransaction?.observeConnectorEvidence(event);
  };
  const finalizeMutationEvent = async (
    event: ConnectorEvent,
    message: string,
  ): Promise<void> => {
    if (!mutationTransaction) return;
    mutationFinalizationAttempted = true;
    await mutationTransaction.finalize(
      mutationFinalization(event, message),
    );
  };
  try {
    agentDispatchStarted = true;
    const agent = await (
      dependencies.agentDeliver ?? deliverThroughLocalAgent
    )({
      sourceFilename: rosz.filename,
      sourceRoszBase64: Buffer.from(rosz.content).toString("base64"),
      downloadEnrichedRosz: includeEnriched,
      downloadPrettyHtml: includePretty,
      expected: {
        name: draft.name,
        factionName: draft.factionName,
        totalPoints: draft.totalPoints,
        units: draft.units.map((unit) => ({
          name: unit.name,
          modelCount: unit.modelCount,
        })),
      },
    });
    const worker = agent.worker;
    workerResponseReceived = true;
    delivery.uiIdentity =
      safeNewRecruitUiIdentity(worker.uiIdentity);
    delivery.listUrl = worker.listUrl;
    delivery.imported = worker.imported;
    delivery.sessionReused = worker.sessionReused;
    delivery.verification = worker.verification;
    const initialMutationEvent = mutationEvent({
      eventId: connectorEventId,
      recordedAt: connectorEventRecordedAt,
      imported: worker.imported,
      remoteOutcomeUnknown: worker.remoteOutcomeUnknown,
      workerOk: worker.ok,
      remoteId: worker.listUrl,
      contentSha256: sourceRoszSha256,
    });
    await observeMutationEvent(initialMutationEvent);
    if (!worker.ok) {
      await finalizeMutationEvent(
        initialMutationEvent,
        worker.message ??
          (worker.imported ||
          worker.remoteOutcomeUnknown === true
            ? "The New Recruit worker could not prove whether its remote import completed."
            : "The New Recruit worker proved that no remote import occurred."),
      );
      await publishSource();
      return {
        ok: false,
        data: delivery,
        violations: [
          {
            code: worker.code ?? "COMPANION_FAILED",
            message: worker.message ?? "New Recruit delivery failed.",
            severity: "error",
          },
        ],
        warnings: validation.warnings,
      };
    }

    const artifacts: ExportArtifact[] = [rosz];
    let catalogueProvenanceViolation: {
      code: string;
      message: string;
      severity: "error";
    } | null = null;
    if (includeEnriched) {
      if (!agent.enrichedRoszBase64) {
        throw new Error(
          "The local agent did not return the requested enriched .rosz.",
        );
      }
      const enrichedContent = Buffer.from(agent.enrichedRoszBase64, "base64");
      try {
        delivery.enrichedSummary = validateEnrichedRosz(enrichedContent, {
          name: draft.name,
          factionName: draft.factionName,
          totalPoints: draft.totalPoints,
          units: draft.units.map((unit) => ({
            name: unit.name,
            modelCount: unit.modelCount,
          })),
        });
        const factionCatalogue = getNewRecruitFactionSummary(
          draft.factionId,
        );
        if (!factionCatalogue?.catalogue.id) {
          catalogueProvenanceViolation = {
            code: "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNAVAILABLE",
            message:
              `The pinned ${draft.factionName} New Recruit catalogue identity is unavailable, so the delivered roster cannot be accepted as compatible with its data bundle.`,
            severity: "error",
          };
        } else {
          const catalogueProvenance: NewRecruitCatalogueProvenanceComparison =
            compareNewRecruitCatalogueProvenance(
              delivery.enrichedSummary,
              {
                releaseId: draft.sourceData.releaseId,
                gameSystem: {
                  id: newRecruitCatalogue.gameSystem.id,
                  name: newRecruitCatalogue.gameSystem.name,
                  revision:
                    draft.sourceData.newRecruit.gameSystemRevision,
                },
                catalogue: {
                  id: factionCatalogue.catalogue.id,
                  name: factionCatalogue.catalogue.name,
                  revision:
                    draft.sourceData.newRecruit.catalogueRevision,
                },
              },
            );
          delivery.catalogueProvenance = catalogueProvenance;
          if (catalogueProvenance.status === "drift") {
            const mismatchSummary = catalogueProvenance.mismatches
              .map(
                (mismatch) =>
                  `${mismatch.field} expected ${mismatch.expected}, observed ${
                    mismatch.observed ?? "missing"
                  }`,
              )
              .join("; ");
            catalogueProvenanceViolation = {
              code: "NEW_RECRUIT_CATALOGUE_DRIFT",
              message:
                `New Recruit created or reused the list, but its verified export does not match data bundle ${draft.sourceData.bundleId}: ${mismatchSummary}. The remote list was retained for inventory and was not accepted for downstream use.`,
              severity: "error",
            };
          } else if (catalogueProvenance.status === "unverifiable") {
            catalogueProvenanceViolation = {
              code: "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNVERIFIABLE",
              message:
                `New Recruit created or reused the list, but its verified export omitted ${catalogueProvenance.missing.join(", ")}. The remote list was retained for inventory and was not accepted for downstream use.`,
              severity: "error",
            };
          }
        }
      } catch (error) {
        const failedVerificationEvent = mutationEvent({
          eventId: connectorEventId,
          recordedAt: connectorEventRecordedAt,
          imported: worker.imported,
          remoteOutcomeUnknown: worker.remoteOutcomeUnknown,
          workerOk: worker.ok,
          remoteId: worker.listUrl,
          contentSha256: sourceRoszSha256,
        });
        delivery.connectorEvents = [failedVerificationEvent];
        await finalizeMutationEvent(
          failedVerificationEvent,
          worker.imported
            ? "New Recruit reported a remote import, but the enriched ROSZ failed gameplay-identity verification."
            : "New Recruit did not import a new list; the returned enriched ROSZ failed gameplay-identity verification.",
        );
        let diagnosticWarning: {
          code: string;
          message: string;
          severity: "warn";
        } | null = null;
        try {
          delivery.diagnosticArtifacts = [
            await preserveRejectedEnrichedRosz(
              enrichedContent,
              enrichedFilename(rosz.filename),
              outputDirectory,
              options,
            ),
          ];
        } catch {
          diagnosticWarning = {
            code: "DIAGNOSTIC_ARTIFACT_WRITE_FAILED",
            message:
              "The rejected enriched roster could not be retained in the run diagnostics directory.",
            severity: "warn",
          };
        }
        return {
          ok: false,
          data: delivery,
          violations: [
            {
              code: "ENRICHED_ROSZ_VERIFICATION_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : "The New Recruit enriched export failed verification.",
              severity: "error",
            },
          ],
          warnings: [
            ...validation.warnings,
            ...(diagnosticWarning ? [diagnosticWarning] : []),
          ],
        };
      }
      artifacts.push({
        format: "rosz",
        filename: enrichedFilename(rosz.filename),
        mimeType: "application/zip",
        encoding: "binary",
        content: enrichedContent,
      });
    }
    if (includePretty) {
      if (!agent.prettyHtmlBase64) {
        throw new Error(
          "The local agent did not return the requested Pretty HTML.",
        );
      }
      artifacts.push({
        format: "html",
        filename: htmlFilename(rosz.filename),
        mimeType: "text/html; charset=utf-8",
        encoding: "binary",
        content: Buffer.from(agent.prettyHtmlBase64, "base64"),
      });
    }
    const written = await writeExportArtifacts(
      artifacts,
      outputDirectory,
      options,
    );
    delivery.artifacts = artifacts.map((artifact, index) => ({
      format:
        index === 0
          ? "rosz"
          : includeEnriched && index === 1
            ? "new-recruit-enriched-rosz"
            : "new-recruit-pretty-html",
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      written: written[index],
    }));
    const verifiedContent =
      includeEnriched && artifacts[1]
        ? artifacts[1].content
        : rosz.content;
    const verifiedMutationEvent = mutationEvent({
      eventId: connectorEventId,
      recordedAt: connectorEventRecordedAt,
      imported: worker.imported,
      remoteOutcomeUnknown: worker.remoteOutcomeUnknown,
      workerOk: worker.ok,
      remoteId: worker.listUrl,
      contentSha256: crypto
        .createHash("sha256")
        .update(verifiedContent)
        .digest("hex"),
      verified: true,
    });
    delivery.connectorEvents = [verifiedMutationEvent];
    await finalizeMutationEvent(
      verifiedMutationEvent,
      catalogueProvenanceViolation
        ? worker.imported
          ? "New Recruit created and verified a remote roster list, but its observed catalogue identity was rejected."
          : "New Recruit reused an existing roster state, but its observed catalogue identity was rejected."
        : worker.imported
          ? "New Recruit created and verified a remote roster list."
          : "New Recruit reused an existing roster state; no import occurred.",
    );
    if (catalogueProvenanceViolation) {
      const retainedEnriched = delivery.artifacts.find(
        (artifact) => artifact.format === "new-recruit-enriched-rosz",
      );
      if (retainedEnriched?.written) {
        catalogueProvenanceViolation.message +=
          ` A profile-rich diagnostic copy was retained at ${retainedEnriched.written}. It may be manually reviewed or imported for an explicit diagnostic, but remains blocked from automatic downstream use.`;
      }
      return {
        ok: false,
        data: delivery,
        violations: [catalogueProvenanceViolation],
        warnings: validation.warnings,
      };
    }
    return {
      ok: true,
      data: delivery,
      violations: [],
      warnings: validation.warnings,
    };
  } catch (error) {
    let receiptFailure: unknown = null;
    if (!mutationFinalizationAttempted) {
      const fallbackEvent =
        observedMutationEvent ??
        mutationEvent({
          eventId: connectorEventId,
          recordedAt: connectorEventRecordedAt,
          imported: delivery.imported,
          remoteOutcomeUnknown:
            agentDispatchStarted && !workerResponseReceived,
          workerOk: false,
          remoteId: delivery.listUrl,
          contentSha256: sourceRoszSha256,
        });
      delivery.connectorEvents = [fallbackEvent];
      try {
        if (!observedMutationEvent) {
          await mutationTransaction?.observeConnectorEvidence(
            fallbackEvent,
          );
        }
        await finalizeMutationEvent(
          fallbackEvent,
          fallbackEvent.outcome === "reused"
            ? "New Recruit proved that no import occurred before the local delivery failed."
            : fallbackEvent.outcome === "failed"
              ? "The delivery failed before New Recruit could create a remote list."
              : "The delivery was dispatched, but its remote outcome could not be fully verified.",
        );
      } catch (finalizationError) {
        receiptFailure = finalizationError;
      }
    }
    let fallbackWarning = null;
    if (!delivery.artifacts.length) {
      try {
        await publishSource();
      } catch (writeError) {
        fallbackWarning = {
          code: "MANUAL_HANDOFF_WRITE_FAILED",
          message:
            writeError instanceof Error
              ? writeError.message
              : "The manual .rosz fallback could not be written.",
          severity: "warn" as const,
        };
      }
    }
    return {
      ok: false,
      data: delivery,
      violations: [
        {
          code:
            error instanceof LocalAgentError
              ? error.code
              : "COMPANION_FAILED",
          message: error instanceof Error ? error.message : "Delivery failed.",
          severity: "error",
        },
        ...(receiptFailure
          ? [mutationReceiptViolation(receiptFailure)]
          : []),
      ],
      warnings: fallbackWarning
        ? [...validation.warnings, fallbackWarning]
        : validation.warnings,
    };
  }
}

export async function enrichRoszThroughNewRecruit(
  sourcePath: string,
  options: NewRecruitDeliveryOptions = {},
  dependencies: NewRecruitCompanionDependencies = {},
): Promise<
  ResultEnvelope<{
    listUrl: string | null;
    imported: boolean;
    sessionReused: boolean;
    connectorEvents: ConnectorEvent[];
    enrichedRoszPath: string;
    summary: ReturnType<typeof inspectEnrichedRosz>;
  }>
> {
  const restartIssue = dependencies.runtimeIssue
    ? dependencies.runtimeIssue()
    : dependencies.agentDeliver
      ? null
      : runtimeRestartIssue();
  if (restartIssue) {
    return {
      ok: false,
      data: null,
      violations: [{ ...restartIssue, severity: "error" }],
      warnings: [],
    };
  }
  const platform = dependencies.platform ?? process.platform;
  const browserAvailable =
    dependencies.browserAvailable ?? (await exists(chromePath));
  if (platform !== "darwin" || !browserAvailable) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "COMPANION_UNAVAILABLE",
          message: "New Recruit roster enrichment requires macOS and Google Chrome.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const source = await readFile(sourcePath);
  let expected: ReturnType<typeof inspectEnrichedRosz>;
  try {
    expected = inspectEnrichedRosz(source);
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "INVALID_ROSZ",
          message: error instanceof Error ? error.message : "Invalid .rosz file.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
  const outputDirectory = options.outputDirectory ?? "exports/tessera";
  const basename = path
    .basename(sourcePath)
    .replace(/\.rosz$/i, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const filename = `${basename}-new-recruit-enriched.rosz`;
  try {
    await resolveExportArtifactTargets(
      [
        {
          format: "rosz",
          filename,
          mimeType: "application/zip",
          encoding: "binary",
          content: new Uint8Array(),
        },
      ],
      outputDirectory,
      options,
    );
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "FILE_COLLISION",
          message:
            error instanceof Error
              ? error.message
              : "Output path rejected.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }

  const sourceRoszSha256 = crypto
    .createHash("sha256")
    .update(source)
    .digest("hex");
  const eventId = crypto.randomUUID();
  const eventRecordedAt = new Date().toISOString();
  let transaction: NewRecruitMutationTransaction | null = null;
  if (options.mutationReceiptMode !== "external") {
    try {
      const runId = mutationRunId(
        options,
        "uploaded-rosz-new-recruit",
      );
      transaction = options.mutationSubjectRoster
        ? await beginNewRecruitMutationReceipt({
            roster: options.mutationSubjectRoster,
            runId,
            expectedSourceRoszSha256: sourceRoszSha256,
          })
        : await beginNewRecruitRoszMutationReceipt({
            subject: newRecruitRoszMutationSubject({
              content: source,
              rosterName: expected.rosterName,
            }),
            runId,
          });
    } catch (error) {
      return {
        ok: false,
        data: null,
        violations: [mutationReceiptViolation(error)],
        warnings: [],
      };
    }
  }

  let agentDispatchStarted = false;
  let workerResponse:
    | Awaited<
        ReturnType<typeof deliverThroughLocalAgent>
      >["worker"]
    | null = null;
  let observedEvent: ConnectorEvent | null = null;
  let finalizationAttempted = false;
  const observe = async (
    event: ConnectorEvent,
  ): Promise<void> => {
    observedEvent = event;
    await transaction?.observeConnectorEvidence(event);
  };
  const finalize = async (
    event: ConnectorEvent,
    message: string,
  ): Promise<void> => {
    if (!transaction) return;
    finalizationAttempted = true;
    await transaction.finalize(
      mutationFinalization(event, message),
    );
  };
  try {
    agentDispatchStarted = true;
    const agent = await (
      dependencies.agentDeliver ?? deliverThroughLocalAgent
    )({
      sourceFilename: path.basename(sourcePath),
      sourceRoszBase64: source.toString("base64"),
      downloadEnrichedRosz: true,
      downloadPrettyHtml: false,
      expected: {
        name: expected.rosterName,
        factionName: expected.factionName,
        totalPoints: expected.totalPoints,
        units: expected.units,
      },
    });
    const worker = agent.worker;
    workerResponse = worker;
    const initialEvent = mutationEvent({
      eventId,
      recordedAt: eventRecordedAt,
      imported: worker.imported,
      remoteOutcomeUnknown: worker.remoteOutcomeUnknown,
      workerOk: worker.ok,
      remoteId: worker.listUrl,
      contentSha256: sourceRoszSha256,
    });
    await observe(initialEvent);
    if (!worker.ok) {
      await finalize(
        initialEvent,
        worker.message ??
          (worker.imported ||
          worker.remoteOutcomeUnknown === true
            ? "The New Recruit worker could not prove whether uploaded-roster enrichment created a list."
            : "The New Recruit worker proved that uploaded-roster enrichment did not create a list."),
      );
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: worker.code ?? "COMPANION_FAILED",
            message: worker.message ?? "New Recruit enrichment failed.",
            severity: "error",
          },
        ],
        warnings: [],
      };
    }
    if (!agent.enrichedRoszBase64) {
      throw new Error(
        "The local agent did not return the requested enriched .rosz.",
      );
    }
    const content = Buffer.from(agent.enrichedRoszBase64, "base64");
    const summary = validateEnrichedRosz(content, {
      name: expected.rosterName,
      factionName: expected.factionName,
      totalPoints: expected.totalPoints,
      units: expected.units,
    });
    const written = await writeExportArtifact(
      {
        format: "rosz",
        filename,
        mimeType: "application/zip",
        encoding: "binary",
        content,
      },
      path.join(outputDirectory, filename),
      options,
    );
    const connectorEvent = mutationEvent({
      eventId,
      recordedAt: eventRecordedAt,
      imported: worker.imported,
      remoteOutcomeUnknown: worker.remoteOutcomeUnknown,
      workerOk: worker.ok,
      remoteId: worker.listUrl,
      contentSha256: crypto
        .createHash("sha256")
        .update(content)
        .digest("hex"),
      verified: true,
    });
    await finalize(
      connectorEvent,
      worker.imported
        ? "New Recruit created and verified a remote list while enriching the uploaded ROSZ."
        : "New Recruit reused an existing roster state while enriching the uploaded ROSZ; no import occurred.",
    );
    return {
      ok: true,
      data: {
        listUrl: worker.listUrl,
        imported: worker.imported,
        sessionReused: worker.sessionReused,
        connectorEvents: [connectorEvent],
        enrichedRoszPath: written,
        summary,
      },
      violations: [],
      warnings: [],
    };
  } catch (error) {
    let receiptFailure: unknown = null;
    if (!finalizationAttempted) {
      const fallbackEvent =
        observedEvent ??
        mutationEvent({
          eventId,
          recordedAt: eventRecordedAt,
          imported: workerResponse?.imported ?? false,
          remoteOutcomeUnknown:
            workerResponse?.remoteOutcomeUnknown ??
            agentDispatchStarted,
          workerOk: workerResponse?.ok ?? false,
          remoteId: workerResponse?.listUrl ?? null,
          contentSha256: sourceRoszSha256,
        });
      try {
        if (!observedEvent) {
          await transaction?.observeConnectorEvidence(
            fallbackEvent,
          );
        }
        await finalize(
          fallbackEvent,
          fallbackEvent.outcome === "reused"
            ? "New Recruit proved that no import occurred before uploaded-roster enrichment failed locally."
            : fallbackEvent.outcome === "failed"
              ? "Uploaded-roster enrichment failed before New Recruit could create a list."
              : "Uploaded-roster enrichment reached New Recruit, but its remote outcome could not be fully verified.",
        );
      } catch (finalizationError) {
        receiptFailure = finalizationError;
      }
    }
    return {
      ok: false,
      data: null,
      violations: [
        {
          code:
            error instanceof LocalAgentError
              ? error.code
              : "ENRICHED_ROSZ_VERIFICATION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "The enriched .rosz could not be verified.",
          severity: "error",
        },
        ...(receiptFailure
          ? [mutationReceiptViolation(receiptFailure)]
          : []),
      ],
      warnings: [],
    };
  }
}
