import { spawn } from "node:child_process";

import {
  type BrokerCredentials,
  type WorkerRequest,
  type WorkerResult,
} from "./contracts";
import {
  NewRecruitAutomationError,
  runNewRecruitBrowserDelivery,
} from "./browser";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function retrieveCredentials(brokerPath: string): Promise<BrokerCredentials> {
  const payload = await new Promise<string>((resolve, reject) => {
    const child = spawn(brokerPath, ["retrieve"], {
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
    username?: string;
    password?: string;
    code?: string;
    message?: string;
  };
  if (!parsed.ok || !parsed.username || !parsed.password) {
    throw new NewRecruitAutomationError(
      parsed.code ?? "KEYCHAIN_READ_FAILED",
      parsed.message ?? "The Keychain broker did not return a credential.",
    );
  }
  return { username: parsed.username, password: parsed.password };
}

function failure(error: unknown): WorkerResult {
  return {
    ok: false,
    code:
      error instanceof NewRecruitAutomationError
        ? error.code
        : "COMPANION_FAILED",
    message: error instanceof Error ? error.message : "Companion failed.",
    imported: false,
    sessionReused: false,
    listUrl: null,
    enrichedRoszPath: null,
    prettyHtmlPath: null,
    verification: null,
  };
}

try {
  const input = JSON.parse(await readStdin()) as WorkerRequest;
  const result = await runNewRecruitBrowserDelivery(input, {
    getCredentials: () => retrieveCredentials(input.brokerPath),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(failure(error))}\n`);
  process.exitCode = 2;
}
