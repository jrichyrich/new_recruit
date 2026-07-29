import { spawn } from "node:child_process";

import type { ProfilePolicyV1 } from "../../lib/rosterpilot";
import {
  runTesseraBrowserMatchup,
  TesseraAutomationError,
  type TesseraAnalysisMode,
  type TesseraBrowserResult,
  type TesseraMetric,
  type TesseraPhase,
} from "./browser";

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
};

type WorkerResult =
  | { ok: true; data: TesseraBrowserResult }
  | { ok: false; code: string; message: string };

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

function failure(error: unknown): WorkerResult {
  return {
    ok: false,
    code:
      error instanceof TesseraAutomationError
        ? error.code
        : "TESSERA_COMPANION_FAILED",
    message:
      error instanceof Error ? error.message : "Tessera companion failed.",
  };
}

try {
  const input = JSON.parse(await readStdin()) as WorkerRequest;
  const licenseKey = await retrieveLicenseKey(input.brokerPath);
  const data = await runTesseraBrowserMatchup({
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
  });
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(failure(error))}\n`);
  process.exitCode = 2;
}
