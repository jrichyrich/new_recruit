import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  type WorkerProbeResult,
  type BrokerCredentials,
  stopsNewRecruitBrowserSession,
  type WorkerDeliveryRequest,
  type WorkerProbeRequest,
  type WorkerRequest,
  type WorkerResult,
} from "./contracts";
import {
  createNewRecruitBrowserSession,
  NewRecruitAutomationError,
  runNewRecruitAuthenticationCheck,
  runNewRecruitBrowserDelivery,
} from "./browser";

type PersistentWorkerRequest =
  | { action: "deliver"; request: WorkerDeliveryRequest }
  | { action: "probe"; request: WorkerProbeRequest }
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
    uiIdentity: null,
    imported: false,
    sessionReused: false,
    listUrl: null,
    enrichedRoszPath: null,
    prettyHtmlPath: null,
    verification: null,
  };
}

function probeFailure(error: unknown): WorkerProbeResult {
  return {
    ok: false,
    code:
      error instanceof NewRecruitAutomationError
        ? error.code
        : "COMPANION_FAILED",
    message:
      error instanceof Error ? error.message : "Authentication probe failed.",
    uiIdentity: null,
    sessionReused: false,
    importControlVisible: false,
  };
}

function stoppedFailure(
  stopped: { code: string; message: string },
): WorkerResult {
  return {
    ok: false,
    code: "NEW_RECRUIT_SESSION_STOPPED",
    message:
      `The persistent New Recruit session stopped after ${stopped.code}: ` +
      `${stopped.message} Reset or close the session before another delivery.`,
    imported: false,
    sessionReused: false,
    listUrl: null,
    enrichedRoszPath: null,
    prettyHtmlPath: null,
    verification: null,
  };
}

async function runOneShotWorker(): Promise<void> {
  let workerAction: WorkerRequest["action"] = "deliver";
  try {
    const input = JSON.parse(await readStdin()) as WorkerRequest;
    workerAction = input.action;
    const result =
      input.action === "probe"
        ? await runNewRecruitAuthenticationCheck(
            input.profileDirectory,
            {
              getCredentials: () =>
                retrieveCredentials(input.brokerPath),
            },
          )
        : await runNewRecruitBrowserDelivery(input, {
            getCredentials: () =>
              retrieveCredentials(input.brokerPath),
          });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        workerAction === "probe"
          ? probeFailure(error)
          : failure(error),
      )}\n`,
    );
    process.exitCode = 2;
  }
}

async function runPersistentWorker(): Promise<void> {
  let session:
    | ReturnType<typeof createNewRecruitBrowserSession>
    | null = null;
  let brokerPath: string | null = null;
  let profileDirectory: string | null = null;
  let stopped: { code: string; message: string } | null = null;
  let closing = false;

  const close = async () => {
    if (closing) return;
    closing = true;
    await session?.close().catch(() => undefined);
    session = null;
  };
  const reset = async () => {
    const activeSession = session;
    if (activeSession) await activeSession.reset();
  };
  const shutdown = () => {
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const browserSession = (
    input: WorkerDeliveryRequest | WorkerProbeRequest,
  ) => {
    if (
      (brokerPath && brokerPath !== input.brokerPath) ||
      (profileDirectory &&
        profileDirectory !== input.profileDirectory)
    ) {
      throw new NewRecruitAutomationError(
        "NEW_RECRUIT_WORKER_SESSION_MISMATCH",
        "The persistent New Recruit worker refused a request for another broker or browser profile.",
      );
    }
    brokerPath = input.brokerPath;
    profileDirectory = input.profileDirectory;
    session ??= createNewRecruitBrowserSession(
      input.profileDirectory,
      {
        getCredentials: () =>
          retrieveCredentials(input.brokerPath),
      },
    );
    return session;
  };

  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response:
      | WorkerResult
      | WorkerProbeResult
      | PersistentWorkerControlResult;
    let shouldClose = false;
    try {
      const envelope = JSON.parse(line) as PersistentWorkerRequest;
      if (envelope.action === "close") {
        await close();
        response = { ok: true, action: "close" };
        shouldClose = true;
      } else if (envelope.action === "reset") {
        await reset();
        stopped = null;
        response = { ok: true, action: "reset" };
      } else if (envelope.action === "probe") {
        const result = await browserSession(envelope.request).probe();
        response = result;
        if (
          !result.ok &&
          stopsNewRecruitBrowserSession({ code: result.code })
        ) {
          stopped = {
            code: result.code ?? "NEW_RECRUIT_AUTHENTICATION_FAILED",
            message: result.message ?? "Authentication failed.",
          };
          await reset();
        }
      } else if (envelope.action === "deliver") {
        if (stopped) {
          response = stoppedFailure(stopped);
        } else {
          const result = await browserSession(envelope.request).deliver(
            envelope.request,
          );
          response = result;
          if (!result.ok && stopsNewRecruitBrowserSession(result)) {
            stopped = {
              code: result.code ?? "NEW_RECRUIT_DELIVERY_FAILED",
              message: result.message ?? "Delivery failed.",
            };
            await reset();
          }
        }
      } else {
        throw new NewRecruitAutomationError(
          "NEW_RECRUIT_WORKER_PROTOCOL_ERROR",
          "The persistent New Recruit worker received an unsupported action.",
        );
      }
    } catch (error) {
      response = failure(error);
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
