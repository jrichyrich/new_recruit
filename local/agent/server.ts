import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  LOCAL_AGENT_MAX_FRAME_BYTES,
  LOCAL_AGENT_PROTOCOL_VERSION,
  LOCAL_AGENT_VERSION,
  type CredentialState,
  type LocalAgentDeliveryPayload,
  type LocalAgentDeliveryResult,
  type LocalAgentTesseraPayload,
  type LocalAgentTesseraResult,
  type LocalAgentRequest,
  type LocalAgentResponse,
  type LocalAgentStatus,
} from "./contracts";
import { FrameDecoder, encodeFrame } from "./framing";
import {
  installedBrokerPath,
  localAgentSpoolDirectory,
  localAgentSocketPath,
  newRecruitProfileDirectory,
  projectRoot,
} from "./paths";
import type { WorkerRequest, WorkerResult } from "../new-recruit/contracts";

const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workerPath = path.join(projectRoot, "local", "new-recruit", "worker.ts");
const tesseraWorkerPath = path.join(
  projectRoot,
  "local",
  "tessera",
  "worker.ts",
);
const maximumQueuedJobs = 4;

type BrokerResponse = {
  ok: boolean;
  configured?: boolean;
  code?: string;
  message?: string;
};

type LocalAgentServerOptions = {
  socketEnabled?: boolean;
  socketPath?: string;
  spoolDirectory?: string;
  brokerPath?: string;
  profileDirectory?: string;
  nodeExecutable?: string;
  workerPath?: string;
  tesseraWorkerPath?: string;
};

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
  timeoutMs = 5 * 60_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The local-agent worker timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        code: code ?? 1,
      });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function credentialState(response: BrokerResponse | null): CredentialState {
  if (!response) return "unavailable";
  if (response.ok) return response.configured ? "ready" : "not-configured";
  if (response.code === "AUTHENTICATION_CANCELLED") {
    return "authorization-required";
  }
  if (
    response.code === "KEYCHAIN_LOCKED" ||
    response.code === "KEYCHAIN_READ_FAILED"
  ) {
    return "keychain-locked";
  }
  return "unavailable";
}

function sanitizeWorkerResult(
  worker: WorkerResult,
): LocalAgentDeliveryResult["worker"] {
  return {
    ok: worker.ok,
    code: worker.code,
    message: worker.message,
    imported: worker.imported,
    sessionReused: worker.sessionReused,
    listUrl: worker.listUrl,
    verification: worker.verification,
  };
}

function safeFilename(filename: string): string {
  const normalized = path.basename(filename).replace(/[^\p{L}\p{N}._-]+/gu, "-");
  return normalized.toLocaleLowerCase().endsWith(".rosz")
    ? normalized
    : `${normalized}.rosz`;
}

export async function startLocalAgent(
  options: LocalAgentServerOptions = {},
): Promise<{
  close: () => Promise<void>;
  spoolDirectory: string;
  socketPath: string;
}> {
  const socketPath = options.socketPath ?? localAgentSocketPath();
  const spoolDirectory =
    options.spoolDirectory ?? localAgentSpoolDirectory();
  const requestsDirectory = path.join(spoolDirectory, "requests");
  const responsesDirectory = path.join(spoolDirectory, "responses");
  const brokerPath = options.brokerPath ?? installedBrokerPath();
  const profileDirectory =
    options.profileDirectory ?? newRecruitProfileDirectory();
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const configuredWorkerPath = options.workerPath ?? workerPath;
  const configuredTesseraWorkerPath =
    options.tesseraWorkerPath ?? tesseraWorkerPath;
  let activeJob = false;
  let queuedJobs = 0;
  let queue = Promise.resolve();

  async function brokerStatus(provider: "new-recruit" | "tessera"): Promise<{
    available: boolean;
    response: BrokerResponse | null;
  }> {
    try {
      const result = await runProcess(
        brokerPath,
        ["status", provider],
        undefined,
        10_000,
      );
      try {
        return {
          available: true,
          response: JSON.parse(result.stdout) as BrokerResponse,
        };
      } catch {
        return {
          available: true,
          response: {
            ok: false,
            code: "BROKER_PROBE_FAILED",
            message:
              result.stderr ||
              "The Keychain broker returned an invalid status response.",
          },
        };
      }
    } catch (error) {
      return {
        available: !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ),
        response: {
          ok: false,
          code: "BROKER_PROBE_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "The Keychain broker status check failed.",
        },
      };
    }
  }

  async function status(): Promise<LocalAgentStatus> {
    const browserAvailable = await exists(chromePath);
    const [newRecruitBroker, tesseraBroker] = await Promise.all([
      brokerStatus("new-recruit"),
      brokerStatus("tessera"),
    ]);
    const brokerAvailable =
      newRecruitBroker.available && tesseraBroker.available;
    const newRecruitState = credentialState(newRecruitBroker.response);
    const tesseraState = credentialState(tesseraBroker.response);
    return {
      available: true,
      version: LOCAL_AGENT_VERSION,
      protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
      protocolCompatible: true,
      platform: process.platform,
      browserAvailable,
      brokerAvailable,
      brokerStatusCode:
        [newRecruitBroker.response, tesseraBroker.response].find(
          (response) => response && !response.ok,
        )?.code ?? null,
      activeJob,
      queuedJobs,
      providers: [
        {
          providerId: "new-recruit",
          credentialMode: "keychain",
          credentialState: newRecruitState,
          ready:
            browserAvailable &&
            brokerAvailable &&
            newRecruitState === "ready",
        },
        {
          providerId: "tessera",
          credentialMode: "keychain",
          credentialState: tesseraState,
          ready:
            browserAvailable && brokerAvailable && tesseraState === "ready",
        },
      ],
    };
  }

  async function performDelivery(
    payload: LocalAgentDeliveryPayload,
  ): Promise<LocalAgentDeliveryResult> {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-agent-delivery-"),
    );
    try {
      const sourcePath = path.join(
        temporary,
        safeFilename(payload.sourceFilename),
      );
      const enrichedPath = payload.downloadEnrichedRosz
        ? path.join(temporary, "new-recruit-enriched.rosz")
        : null;
      const prettyPath = payload.downloadPrettyHtml
        ? path.join(temporary, "new-recruit-pretty.html")
        : null;
      await writeFile(sourcePath, Buffer.from(payload.sourceRoszBase64, "base64"), {
        flag: "wx",
      });
      const request: WorkerRequest = {
        action: "deliver",
        brokerPath,
        profileDirectory,
        roszPath: sourcePath,
        enrichedRoszPath: enrichedPath,
        prettyHtmlPath: prettyPath,
        expected: payload.expected,
      };
      const result = await runProcess(
        nodeExecutable,
        ["--import", "tsx", configuredWorkerPath],
        JSON.stringify(request),
      );
      let worker: WorkerResult;
      try {
        worker = JSON.parse(result.stdout) as WorkerResult;
      } catch {
        worker = {
          ok: false,
          code: "COMPANION_FAILED",
          message:
            result.stderr || "The New Recruit worker returned an invalid response.",
          imported: false,
          sessionReused: false,
          listUrl: null,
          enrichedRoszPath: null,
          prettyHtmlPath: null,
          verification: null,
        };
      }
      const response: LocalAgentDeliveryResult = {
        worker: sanitizeWorkerResult(worker),
      };
      if (worker.ok && enrichedPath) {
        response.enrichedRoszBase64 = (
          await readFile(enrichedPath)
        ).toString("base64");
      }
      if (worker.ok && prettyPath) {
        response.prettyHtmlBase64 = (await readFile(prettyPath)).toString(
          "base64",
        );
      }
      return response;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function performTessera(
    payload: LocalAgentTesseraPayload,
  ): Promise<LocalAgentTesseraResult> {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-agent-tessera-"),
    );
    try {
      const playerPath = path.join(
        temporary,
        safeFilename(payload.playerFilename),
      );
      const opponentPath = path.join(
        temporary,
        safeFilename(payload.opponentFilename),
      );
      const profilePath = path.join(temporary, "profile");
      await Promise.all([
        writeFile(
          playerPath,
          Buffer.from(payload.playerRoszBase64, "base64"),
          { flag: "wx" },
        ),
        writeFile(
          opponentPath,
          Buffer.from(payload.opponentRoszBase64, "base64"),
          { flag: "wx" },
        ),
      ]);
      const result = await runProcess(
        nodeExecutable,
        ["--import", "tsx", configuredTesseraWorkerPath],
        JSON.stringify({
          brokerPath,
          profileDirectory: profilePath,
          playerRoszPath: playerPath,
          playerName: payload.playerName,
          opponentRoszPath: opponentPath,
          opponentName: payload.opponentName,
          analysisMode: payload.analysisMode,
          phases: payload.phases,
          metrics: payload.metrics,
        }),
      );
      const worker = JSON.parse(result.stdout) as
        | { ok: true; data: LocalAgentTesseraResult }
        | { ok: false; code: string; message: string };
      if (!worker.ok) {
        throw Object.assign(new Error(worker.message), {
          code: worker.code,
        });
      }
      return worker.data;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function queuedDelivery(
    payload: LocalAgentDeliveryPayload,
  ): Promise<LocalAgentDeliveryResult> {
    if (queuedJobs >= maximumQueuedJobs) {
      throw Object.assign(
        new Error("The RosterPilot browser queue is full."),
        { code: "BROWSER_PROFILE_BUSY" },
      );
    }
    queuedJobs += 1;
    const task = queue.then(async () => {
      queuedJobs -= 1;
      activeJob = true;
      try {
        return await performDelivery(payload);
      } finally {
        activeJob = false;
      }
    });
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function queuedTessera(
    payload: LocalAgentTesseraPayload,
  ): Promise<LocalAgentTesseraResult> {
    if (queuedJobs >= maximumQueuedJobs) {
      throw Object.assign(
        new Error("The RosterPilot browser queue is full."),
        { code: "BROWSER_PROFILE_BUSY" },
      );
    }
    queuedJobs += 1;
    const task = queue.then(async () => {
      queuedJobs -= 1;
      activeJob = true;
      try {
        return await performTessera(payload);
      } finally {
        activeJob = false;
      }
    });
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function handle(request: LocalAgentRequest): Promise<LocalAgentResponse> {
    if (request.protocolVersion !== LOCAL_AGENT_PROTOCOL_VERSION) {
      return {
        id: request.id,
        ok: false,
        protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
        code: "LOCAL_AGENT_VERSION_MISMATCH",
        message:
          `RosterPilot local-agent protocol ${LOCAL_AGENT_PROTOCOL_VERSION} ` +
          `cannot serve client protocol ${request.protocolVersion}.`,
      };
    }
    try {
      const data =
        request.operation === "agent.status"
          ? await status()
          : request.operation === "new-recruit.deliver"
            ? await queuedDelivery(request.payload)
            : await queuedTessera(request.payload);
      return {
        id: request.id,
        ok: true,
        protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
        data,
      };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
        code:
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "LOCAL_AGENT_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The RosterPilot local agent failed.",
      };
    }
  }

  await mkdir(requestsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(responsesDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    chmod(spoolDirectory, 0o700),
    chmod(requestsDirectory, 0o700),
    chmod(responsesDirectory, 0o700),
  ]);
  async function cleanStaleSpool() {
    const cutoff = Date.now() - 60 * 60_000;
    for (const directory of [requestsDirectory, responsesDirectory]) {
      const filenames = await readdir(directory).catch(() => []);
      await Promise.all(
        filenames.map(async (filename) => {
          const target = path.join(directory, filename);
          const metadata = await stat(target).catch(() => null);
          if (metadata?.isFile() && metadata.mtimeMs < cutoff) {
            await rm(target, { force: true });
          }
        }),
      );
    }
  }
  await cleanStaleSpool();
  const processingSpoolFiles = new Set<string>();
  let spoolClosed = false;
  async function writeSpoolResponse(
    id: string,
    response: LocalAgentResponse,
  ) {
    let payload = Buffer.from(JSON.stringify(response), "utf8");
    if (payload.length > LOCAL_AGENT_MAX_FRAME_BYTES) {
      payload = Buffer.from(
        JSON.stringify({
          id,
          ok: false,
          protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
          code: "LOCAL_AGENT_PAYLOAD_TOO_LARGE",
          message: "The local-agent response exceeds the maximum size.",
        } satisfies LocalAgentResponse),
        "utf8",
      );
    }
    const destination = path.join(
      responsesDirectory,
      `${id}.response.json`,
    );
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, payload, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  }
  async function processSpoolFile(filename: string) {
    if (
      spoolClosed ||
      processingSpoolFiles.has(filename) ||
      !filename.endsWith(".request.json")
    ) {
      return;
    }
    processingSpoolFiles.add(filename);
    const requestPath = path.join(requestsDirectory, filename);
    const id = filename.slice(0, -".request.json".length);
    try {
      const metadata = await stat(requestPath);
      const expectedUid =
        typeof process.getuid === "function" ? process.getuid() : metadata.uid;
      if (
        !metadata.isFile() ||
        metadata.uid !== expectedUid ||
        (metadata.mode & 0o077) !== 0
      ) {
        await rm(requestPath, { force: true });
        return;
      }
      let response: LocalAgentResponse;
      try {
        if (metadata.size > LOCAL_AGENT_MAX_FRAME_BYTES) {
          throw new Error("The local-agent request exceeds the maximum size.");
        }
        const request = JSON.parse(
          (await readFile(requestPath)).toString("utf8"),
        ) as LocalAgentRequest;
        response = await handle(request);
      } catch (error) {
        response = {
          id,
          ok: false,
          protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
          code: "LOCAL_AGENT_PROTOCOL_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "The local-agent request was invalid.",
        };
      }
      await writeSpoolResponse(id, response);
      await rm(requestPath, { force: true });
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        await rm(requestPath, { force: true });
      }
    } finally {
      processingSpoolFiles.delete(filename);
    }
  }
  async function scanSpool() {
    if (spoolClosed) return;
    const filenames = await readdir(requestsDirectory).catch(() => []);
    await Promise.all(
      filenames.map((filename) => processSpoolFile(filename)),
    );
  }
  const spoolTimer = setInterval(() => {
    void scanSpool();
  }, 100);
  const spoolCleanupTimer = setInterval(() => {
    void cleanStaleSpool();
  }, 10 * 60_000);
  await scanSpool();

  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    let handled = false;
    socket.on("data", async (chunk) => {
      if (handled) return;
      try {
        const values = decoder.push(Buffer.from(chunk));
        if (!values.length) return;
        handled = true;
        const response = await handle(values[0] as LocalAgentRequest);
        socket.end(encodeFrame(response));
      } catch {
        socket.destroy();
      }
    });
  });
  const socketEnabled = options.socketEnabled !== false;
  if (socketEnabled) {
    await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const previousUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      spoolClosed = true;
      clearInterval(spoolTimer);
      clearInterval(spoolCleanupTimer);
      throw error;
    } finally {
      process.umask(previousUmask);
    }
    await chmod(socketPath, 0o600);
  }
  return {
    spoolDirectory,
    socketPath,
    close: async () => {
      spoolClosed = true;
      clearInterval(spoolTimer);
      clearInterval(spoolCleanupTimer);
      if (socketEnabled) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

async function main() {
  const running = await startLocalAgent();
  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
