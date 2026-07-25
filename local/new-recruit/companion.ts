import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareNewRecruitHandoff,
  validateRoster,
  type ExportArtifact,
  type NewRecruitConnectionStatus,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../../lib/rosterpilot";
import {
  resolveExportArtifactTargets,
  writeExportArtifacts,
  type WriteOptions,
} from "../../lib/rosterpilot/io";
import type { WorkerRequest, WorkerResult } from "./contracts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const defaultBrokerPath = path.join(
  projectRoot,
  "native",
  ".build",
  "rosterpilot-keychain",
);
const workerPath = path.join(projectRoot, "local", "new-recruit", "worker.ts");
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export type NewRecruitDeliveryOptions = WriteOptions & {
  downloadPrettyHtml?: boolean;
  outputDirectory?: string;
};

type BrokerResponse = {
  ok: boolean;
  configured?: boolean;
  code?: string;
  message?: string;
};

function brokerPath(): string {
  return process.env.ROSTERPILOT_KEYCHAIN_BROKER ?? defaultBrokerPath;
}

function profileDirectory(): string {
  return (
    process.env.ROSTERPILOT_NEW_RECRUIT_PROFILE ??
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "RosterPilot",
      "NewRecruitChrome",
    )
  );
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
  if (configured !== defaultBrokerPath) {
    throw new Error(`The configured Keychain broker does not exist: ${configured}`);
  }
  const built = await runProcess(process.execPath, [
    path.join(projectRoot, "scripts", "build-new-recruit-companion.mjs"),
  ]);
  if (built.code !== 0 || !(await exists(defaultBrokerPath))) {
    throw new Error(built.stderr || "The Keychain broker could not be built.");
  }
  return defaultBrokerPath;
}

async function runBroker(command: "configure" | "status" | "forget") {
  const executable = command === "status" ? brokerPath() : await ensureBroker();
  if (!(await exists(executable))) {
    return {
      ok: false,
      configured: false,
      code: "COMPANION_UNAVAILABLE",
      message: "The Keychain broker has not been built.",
    } satisfies BrokerResponse;
  }
  const result = await runProcess(executable, [command]);
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
  const brokerAvailable = await exists(brokerPath());
  const status = brokerAvailable ? await runBroker("status") : null;
  const available =
    process.platform === "darwin" &&
    browserAvailable &&
    brokerAvailable &&
    status?.ok === true;
  const statusWarning =
    status && !status.ok
      ? {
          code: status.code ?? "COMPANION_UNAVAILABLE",
          message: status.message ?? "The Keychain broker is unavailable.",
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
      credentialsConfigured: status?.ok === true && status.configured === true,
      profileDirectory: process.platform === "darwin" ? profileDirectory() : null,
    },
    violations: [],
    warnings: statusWarning
      ? [statusWarning]
      : available
        ? []
        : [
          {
            code: "COMPANION_UNAVAILABLE",
            message:
              "Build the macOS companion and install Google Chrome before using automated delivery.",
            severity: "warn",
          },
        ],
  };
}

export async function configureNewRecruitCredentials(): Promise<BrokerResponse> {
  return runBroker("configure");
}

export async function forgetNewRecruitCredentials(): Promise<BrokerResponse> {
  return runBroker("forget");
}

async function runWorker(input: WorkerRequest): Promise<WorkerResult> {
  const result = await runProcess(
    process.execPath,
    ["--import", "tsx", workerPath],
    JSON.stringify(input),
  );
  try {
    return JSON.parse(result.stdout) as WorkerResult;
  } catch {
    return {
      ok: false,
      code: "COMPANION_FAILED",
      message: result.stderr || "The New Recruit worker returned an invalid response.",
      imported: false,
      sessionReused: false,
      listUrl: null,
      prettyHtmlPath: null,
      verification: null,
    };
  }
}

function htmlFilename(roszFilename: string): string {
  return roszFilename.replace(/\.rosz$/i, "-new-recruit.html");
}

export async function deliverRosterToNewRecruit(
  draft: RosterDraftV1,
  options: NewRecruitDeliveryOptions = {},
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
  if (process.platform !== "darwin") {
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
  if (!(await exists(chromePath))) {
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

  let executable: string;
  try {
    executable = await ensureBroker();
  } catch (error) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "COMPANION_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Companion unavailable.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  const credentialStatus = await runBroker("status");
  if (!credentialStatus.ok) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: credentialStatus.code ?? "COMPANION_UNAVAILABLE",
          message:
            credentialStatus.message ?? "The Keychain broker is unavailable.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }
  if (!credentialStatus.configured) {
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "CREDENTIALS_NOT_CONFIGURED",
          message:
            "Run `rosterpilot new-recruit configure` before automated delivery.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  }

  const handoff = prepareNewRecruitHandoff(draft, false);
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
  const outputDirectory = options.outputDirectory ?? "exports/new-recruit";
  const planned: ExportArtifact[] = [
    rosz,
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

  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-new-recruit-"),
  );
  try {
    const roszPath = path.join(temporary, rosz.filename);
    const prettyPath = includePretty
      ? path.join(temporary, htmlFilename(rosz.filename))
      : null;
    await writeFile(roszPath, rosz.content, { flag: "wx" });
    const worker = await runWorker({
      action: "deliver",
      brokerPath: executable,
      profileDirectory: profileDirectory(),
      roszPath,
      prettyHtmlPath: prettyPath,
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
    const delivery: NewRecruitDelivery = {
      rosterId: draft.id,
      rosterName: draft.name,
      listUrl: worker.listUrl,
      imported: worker.imported,
      sessionReused: worker.sessionReused,
      verification: worker.verification,
      artifacts: [],
    };
    if (!worker.ok) {
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
    if (includePretty && prettyPath) {
      artifacts.push({
        format: "html",
        filename: htmlFilename(rosz.filename),
        mimeType: "text/html; charset=utf-8",
        encoding: "binary",
        content: await readFile(prettyPath),
      });
    }
    const written = await writeExportArtifacts(
      artifacts,
      outputDirectory,
      options,
    );
    delivery.artifacts = artifacts.map((artifact, index) => ({
      format:
        artifact.format === "rosz" ? "rosz" : "new-recruit-pretty-html",
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
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "COMPANION_FAILED",
          message: error instanceof Error ? error.message : "Delivery failed.",
          severity: "error",
        },
      ],
      warnings: validation.warnings,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
