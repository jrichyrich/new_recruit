import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { BrowserContext } from "playwright-core";

import type {
  ProfilePolicyV1,
  TesseraFrozenScenarioContract,
} from "../../lib/rosterpilot";
import { validateTesseraReadyRosz } from "../../lib/rosterpilot";
import {
  classifyTesseraAutomationFailure,
  invalidatesCachedTesseraLicenseKey,
  runTesseraBrowserMatchup,
  TesseraAutomationError,
  type TesseraAnalysisMode,
  type TesseraBrowserResult,
  type TesseraMetric,
  type TesseraPhase,
} from "./browser";
import type {
  TesseraSavedListReuse,
} from "./saved-list-reuse";

type WorkerRequest = {
  brokerPath: string;
  profileDirectory: string;
  playerRoszPath: string;
  playerName: string;
  opponentRoszPath: string;
  opponentName: string;
  analysisMode?: TesseraAnalysisMode;
  phases?: TesseraPhase[];
  metrics?: TesseraMetric[];
  profilePolicy?: ProfilePolicyV1 | null;
  frozenScenarioContract?: TesseraFrozenScenarioContract[] | null;
  savedListReuse?: TesseraSavedListReuse | null;
};

type WorkerResult =
  | { ok: true; data: TesseraBrowserResult }
  | { ok: false; code: string; message: string };

type WorkerFailure = Extract<WorkerResult, { ok: false }>;

type PersistentWorkerRequest =
  | { action: "analyze"; request: WorkerRequest }
  | { action: "reset" }
  | { action: "close" };

type PersistentWorkerControlResult = {
  ok: true;
  action: "reset" | "close";
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function retrieveLicenseKey(brokerPath: string): Promise<string> {
  const payload = await new Promise<string>((resolve, reject) => {
    const child = spawn(brokerPath, ["retrieve", "tessera"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", () => {
      const text = Buffer.concat(stdout).toString("utf8");
      if (!text) reject(new Error(Buffer.concat(stderr).toString("utf8")));
      else resolve(text);
    });
  });
  const parsed = JSON.parse(payload) as {
    ok: boolean;
    licenseKey?: string;
    code?: string;
    message?: string;
  };
  if (!parsed.ok || !parsed.licenseKey) {
    const absent = [
      "NOT_CONFIGURED",
      "KEY_NOT_CONFIGURED",
      "CREDENTIAL_NOT_CONFIGURED",
    ].includes(parsed.code ?? "");
    throw new TesseraAutomationError(
      absent
        ? "TESSERA_PREMIUM_KEY_ABSENT"
        : parsed.code ?? "KEYCHAIN_READ_FAILED",
      parsed.message ?? "The Keychain broker did not return a Tessera key.",
    );
  }
  return parsed.licenseKey;
}

function failure(error: unknown): WorkerFailure {
  const terminalInputCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    [
      "TESSERA_INPUT_NOT_PROFILE_RICH",
      "TESSERA_INPUT_PROFILES_INCOMPLETE",
    ].includes(error.code)
      ? error.code
      : null;
  if (terminalInputCode) {
    return {
      ok: false,
      code: terminalInputCode,
      message:
        error instanceof Error
          ? error.message
          : "A Tessera input failed profile-readiness validation.",
    };
  }
  const { code, message } = classifyTesseraAutomationFailure(error);
  return {
    ok: false,
    code,
    message,
  };
}

async function analyzeOnce(input: WorkerRequest): Promise<TesseraBrowserResult> {
  await validateWorkerInputs(input);
  const licenseKey = await retrieveLicenseKey(input.brokerPath);
  return runTesseraBrowserMatchup({
    profileDirectory: input.profileDirectory,
    playerRoszPath: input.playerRoszPath,
    playerName: input.playerName,
    opponentRoszPath: input.opponentRoszPath,
    opponentName: input.opponentName,
    licenseKey,
    analysisMode: input.analysisMode,
    phases: input.phases,
    metrics: input.metrics,
    profilePolicy: input.profilePolicy,
    frozenScenarioContract: input.frozenScenarioContract,
    savedListReuse: input.savedListReuse,
  });
}

async function validateWorkerInputs(
  input: WorkerRequest,
): Promise<void> {
  const [player, opponent] = await Promise.all([
    readFile(input.playerRoszPath),
    readFile(input.opponentRoszPath),
  ]);
  validateTesseraReadyRosz(player);
  validateTesseraReadyRosz(opponent);
}

async function runOneShotWorker(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin()) as WorkerRequest;
    const data = await analyzeOnce(input);
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failure(error))}\n`);
    process.exitCode = 2;
  }
}

async function runPersistentWorker(): Promise<void> {
  let context: BrowserContext | undefined;
  let licenseKey: string | undefined;
  let brokerPath: string | undefined;
  let profileDirectory: string | undefined;
  let closing = false;

  const closeContext = async () => {
    const active = context;
    context = undefined;
    await active?.close().catch(() => undefined);
  };
  const reset = async () => {
    await closeContext();
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    await closeContext();
    licenseKey = undefined;
  };
  const shutdown = () => {
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response: WorkerResult | PersistentWorkerControlResult;
    let shouldClose = false;
    try {
      const envelope = JSON.parse(line) as PersistentWorkerRequest;
      if (envelope.action === "close") {
        await close();
        response = { ok: true, action: "close" };
        shouldClose = true;
      } else if (envelope.action === "reset") {
        await reset();
        response = { ok: true, action: "reset" };
      } else if (envelope.action === "analyze") {
        const input = envelope.request;
        await validateWorkerInputs(input);
        if (
          (brokerPath && brokerPath !== input.brokerPath) ||
          (profileDirectory &&
            profileDirectory !== input.profileDirectory)
        ) {
          throw new TesseraAutomationError(
            "TESSERA_WORKER_SESSION_MISMATCH",
            "The persistent Tessera worker refused a request for another session.",
          );
        }
        brokerPath = input.brokerPath;
        profileDirectory = input.profileDirectory;
        licenseKey ??= await retrieveLicenseKey(input.brokerPath);
        const data = await runTesseraBrowserMatchup(
          {
            profileDirectory: input.profileDirectory,
            playerRoszPath: input.playerRoszPath,
            playerName: input.playerName,
            opponentRoszPath: input.opponentRoszPath,
            opponentName: input.opponentName,
            licenseKey,
            analysisMode: input.analysisMode,
            phases: input.phases,
            metrics: input.metrics,
            profilePolicy: input.profilePolicy,
            frozenScenarioContract: input.frozenScenarioContract,
            savedListReuse: input.savedListReuse,
          },
          {
            context,
            keepContextOpen: true,
            onContext: (created) => {
              context = created;
            },
          },
        );
        response = { ok: true, data };
      } else {
        throw new TesseraAutomationError(
          "TESSERA_WORKER_PROTOCOL_ERROR",
          "The persistent Tessera worker received an unsupported action.",
        );
      }
    } catch (error) {
      response = failure(error);
      if (invalidatesCachedTesseraLicenseKey(response.code)) {
        licenseKey = undefined;
        await closeContext();
      }
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (shouldClose) break;
  }
  await close();
}

if (process.argv.includes("--persistent")) {
  await runPersistentWorker();
} else {
  await runOneShotWorker();
}
