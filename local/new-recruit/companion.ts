import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareNewRecruitHandoff,
  inspectEnrichedRosz,
  validateEnrichedRosz,
  validateRoster,
  type ExportArtifact,
  type NewRecruitConnectionStatus,
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
} from "../agent/client";
import {
  installedBrokerPath,
  newRecruitProfileDirectory,
  stagedBrokerPath,
} from "../agent/paths";

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
};

export type NewRecruitCompanionDependencies = {
  platform?: NodeJS.Platform;
  browserAvailable?: boolean;
  agentDeliver?: typeof deliverThroughLocalAgent;
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
  const available =
    process.platform === "darwin" &&
    agentStatus?.available === true &&
    agentStatus.protocolCompatible &&
    installationCurrent &&
    agentStatus.browserAvailable &&
    agentStatus.brokerAvailable;
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
      credentialState:
        newRecruitProvider?.credentialState ??
        (brokerAvailable ? "unavailable" : "not-configured"),
      browserState: browserAvailable ? "ready" : "unavailable",
    },
    violations: [],
    warnings: statusWarning
      ? [statusWarning]
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
              "Install the RosterPilot local agent and Google Chrome before using automated delivery.",
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

function htmlFilename(roszFilename: string): string {
  return roszFilename.replace(/\.rosz$/i, "-new-recruit.html");
}

function enrichedFilename(roszFilename: string): string {
  return roszFilename.replace(/\.rosz$/i, "-new-recruit-enriched.rosz");
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
    listUrl: null,
    imported: false,
    sessionReused: false,
    verification: null,
    enrichedSummary: null,
    artifacts: [],
  };
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
  try {
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
    delivery.listUrl = worker.listUrl;
    delivery.imported = worker.imported;
    delivery.sessionReused = worker.sessionReused;
    delivery.verification = worker.verification;
    if (!worker.ok) {
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
      } catch (error) {
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
          warnings: validation.warnings,
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
    return {
      ok: true,
      data: delivery,
      violations: [],
      warnings: validation.warnings,
    };
  } catch (error) {
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
): Promise<
  ResultEnvelope<{
    listUrl: string | null;
    enrichedRoszPath: string;
    summary: ReturnType<typeof inspectEnrichedRosz>;
  }>
> {
  if (process.platform !== "darwin" || !(await exists(chromePath))) {
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
    const agent = await deliverThroughLocalAgent({
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
    if (!worker.ok) {
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
    return {
      ok: true,
      data: {
        listUrl: worker.listUrl,
        enrichedRoszPath: written,
        summary,
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
              : "ENRICHED_ROSZ_VERIFICATION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "The enriched .rosz could not be verified.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }
}
