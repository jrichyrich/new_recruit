import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
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
  type LocalAgentNewRecruitProbeResult,
  type LocalAgentTesseraPayload,
  type LocalAgentTesseraResult,
  type LocalAgentTesseraRunStartPayload,
  type LocalAgentTesseraRunStartResult,
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
import type {
  WorkerProbeResult,
  WorkerRequest,
  WorkerResult,
} from "../new-recruit/contracts";
import { safeNewRecruitUiIdentity } from "../new-recruit/ui-identity";
import { getRuntimeProvenance } from "../runtime-provenance";

const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workerPath = path.join(projectRoot, "local", "new-recruit", "worker.ts");
const tesseraWorkerPath = path.join(
  projectRoot,
  "local",
  "tessera",
  "worker.ts",
);
const tesseraJobWorkerPath = path.join(
  projectRoot,
  "local",
  "tessera",
  "job-worker.ts",
);
const maximumQueuedJobs = 4;
const transientTesseraSessionCodes = new Set([
  "TESSERA_BROWSER_TIMEOUT",
  "TESSERA_BROWSER_SESSION_CLOSED",
  "TESSERA_BROWSER_UNAVAILABLE",
  "TESSERA_BROWSER_NAVIGATION_FAILED",
  "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
  "TESSERA_PREMIUM_STILL_LOCKED",
  "TESSERA_MATRIX_MISSING",
  "TESSERA_MATRIX_STALE",
  "TESSERA_STALE_MATRIX",
  "TESSERA_INCOMPLETE_MATRIX",
  "TESSERA_SCENARIOS_INCOMPLETE",
  "TESSERA_PHASE_MATRIX_ALIAS",
  "TESSERA_METRIC_MATRIX_ALIAS",
  "TESSERA_PROXY_MATRIX_ALIAS",
  "TESSERA_MATRIX_FINGERPRINT_MISSING",
]);

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
  tesseraPersistentWorkerPath?: string;
  tesseraJobWorkerPath?: string;
  tesseraSessionTtlMs?: number;
  tesseraSessionCleanupIntervalMs?: number;
};

type TesseraWorkerResult =
  | { ok: true; data: LocalAgentTesseraResult }
  | { ok: false; code: string; message: string };

type PersistentTesseraWorker = {
  analyze: (request: Record<string, unknown>) => Promise<TesseraWorkerResult>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
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

function startPersistentTesseraWorker(
  command: string,
  args: string[],
): PersistentTesseraWorker {
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closed = false;
  let pending:
    | {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | null = null;

  const failPending = (error: Error) => {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.reject(error);
  };
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += Buffer.from(chunk).toString("utf8");
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line && pending) {
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        try {
          current.resolve(JSON.parse(line));
        } catch {
          current.reject(
            Object.assign(
              new Error(
                "The persistent Tessera worker returned an invalid response.",
              ),
              { code: "TESSERA_COMPANION_FAILED" },
            ),
          );
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBuffer = (
      stderrBuffer + Buffer.from(chunk).toString("utf8")
    ).slice(-8_192);
  });
  child.on("error", (error) => {
    closed = true;
    failPending(error);
  });
  child.on("close", () => {
    closed = true;
    failPending(
      Object.assign(
        new Error(
          stderrBuffer ||
            "The persistent Tessera worker closed unexpectedly.",
        ),
        { code: "TESSERA_BROWSER_SESSION_CLOSED" },
      ),
    );
  });

  const send = <T>(
    message: Record<string, unknown>,
    timeoutMs = 5 * 60_000,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed || child.stdin.destroyed) {
        reject(
          Object.assign(
            new Error("The persistent Tessera worker is not running."),
            { code: "TESSERA_BROWSER_SESSION_CLOSED" },
          ),
        );
        return;
      }
      if (pending) {
        reject(
          Object.assign(
            new Error("The persistent Tessera worker already has a request."),
            { code: "BROWSER_PROFILE_BUSY" },
          ),
        );
        return;
      }
      const timer = setTimeout(() => {
        if (!pending) return;
        pending = null;
        child.kill("SIGTERM");
        reject(
          Object.assign(
            new Error("The persistent Tessera worker timed out."),
            { code: "TESSERA_BROWSER_TIMEOUT" },
          ),
        );
      }, timeoutMs);
      pending = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      };
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) failPending(error);
      });
    });

  return {
    analyze: (request) =>
      send<TesseraWorkerResult>({ action: "analyze", request }),
    reset: async () => {
      const response = await send<{ ok: boolean; action?: string }>(
        { action: "reset" },
        30_000,
      );
      if (!response.ok || response.action !== "reset") {
        throw Object.assign(
          new Error("The persistent Tessera worker did not reset cleanly."),
          { code: "TESSERA_BROWSER_SESSION_CLOSED" },
        );
      }
    },
    close: async () => {
      if (closed) return;
      await send<{ ok: boolean; action?: string }>(
        { action: "close" },
        10_000,
      ).catch(() => undefined);
      if (!closed) child.kill("SIGTERM");
    },
  };
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
    remoteOutcomeUnknown:
      worker.remoteOutcomeUnknown === true,
    uiIdentity: safeNewRecruitUiIdentity(worker.uiIdentity),
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

function transientCodesInTesseraResult(
  result: LocalAgentTesseraResult,
): string[] {
  const codes = new Set<string>();
  for (const warning of result.warnings ?? []) {
    for (const match of warning.matchAll(/\[([A-Z0-9_]+)\]/g)) {
      if (transientTesseraSessionCodes.has(match[1])) {
        codes.add(match[1]);
      }
    }
  }
  for (const issue of result.integrityIssues ?? []) {
    if (transientTesseraSessionCodes.has(issue.code)) {
      codes.add(issue.code);
    }
  }
  return [...codes];
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
  const tesseraSessionsDirectory = path.join(
    spoolDirectory,
    "tessera-sessions",
  );
  const brokerPath = options.brokerPath ?? installedBrokerPath();
  const profileDirectory =
    options.profileDirectory ?? newRecruitProfileDirectory();
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const configuredWorkerPath = options.workerPath ?? workerPath;
  const configuredTesseraWorkerPath =
    options.tesseraWorkerPath ?? tesseraWorkerPath;
  const configuredPersistentTesseraWorkerPath =
    options.tesseraPersistentWorkerPath ?? tesseraWorkerPath;
  const configuredTesseraJobWorkerPath =
    options.tesseraJobWorkerPath ?? tesseraJobWorkerPath;
  const useInjectedOneShotTesseraWorker =
    options.tesseraWorkerPath !== undefined;
  let activeJob = false;
  let queuedJobs = 0;
  let queue = Promise.resolve();
  const tesseraSessionTtlMs =
    options.tesseraSessionTtlMs ?? 7 * 24 * 60 * 60_000;
  const tesseraSessionCleanupIntervalMs =
    options.tesseraSessionCleanupIntervalMs ?? 10 * 60_000;
  const tesseraSessions = new Map<
    string,
    {
      directory: string;
      lastUsedAt: number;
      active: boolean;
      worker: PersistentTesseraWorker | null;
    }
  >();

  function validatedSessionId(sessionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
      throw Object.assign(
        new Error("The Tessera session id is invalid."),
        { code: "LOCAL_AGENT_PROTOCOL_ERROR" },
      );
    }
    return sessionId;
  }

  async function cleanupExpiredTesseraSessions(): Promise<void> {
    const cutoff = Date.now() - tesseraSessionTtlMs;
    for (const [sessionId, session] of tesseraSessions) {
      if (session.active || session.lastUsedAt >= cutoff) continue;
      tesseraSessions.delete(sessionId);
      await session.worker?.close().catch(() => undefined);
      await rm(session.directory, { recursive: true, force: true });
    }
    const directories = await readdir(tesseraSessionsDirectory).catch(
      () => [],
    );
    await Promise.all(
      directories.map(async (directory) => {
        if (tesseraSessions.has(directory)) return;
        const target = path.join(tesseraSessionsDirectory, directory);
        const metadata = await stat(target).catch(() => null);
        if (metadata?.isDirectory() && metadata.mtimeMs < cutoff) {
          await rm(target, { recursive: true, force: true });
        }
      }),
    );
  }

  async function tesseraSession(
    sessionId: string,
  ): Promise<{
    directory: string;
    lastUsedAt: number;
    active: boolean;
    worker: PersistentTesseraWorker | null;
  }> {
    const id = validatedSessionId(sessionId);
    await cleanupExpiredTesseraSessions();
    const existing = tesseraSessions.get(id);
    if (existing) {
      const now = new Date();
      existing.lastUsedAt = now.getTime();
      await mkdir(existing.directory, {
        recursive: true,
        mode: 0o700,
      });
      await chmod(existing.directory, 0o700);
      await utimes(existing.directory, now, now);
      return existing;
    }
    const directory = path.join(tesseraSessionsDirectory, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const now = new Date();
    await utimes(directory, now, now);
    const created = {
      directory,
      lastUsedAt: now.getTime(),
      active: false,
      worker: null,
    };
    tesseraSessions.set(id, created);
    return created;
  }

  async function tesseraProfileDirectory(
    sessionId: string | undefined,
    fallbackRoot: string,
  ): Promise<string> {
    if (!sessionId) return path.join(fallbackRoot, "profile");
    return (await tesseraSession(sessionId)).directory;
  }

  async function closeTesseraSession(
    sessionId: string,
  ): Promise<{ closed: boolean }> {
    const id = validatedSessionId(sessionId);
    const session = tesseraSessions.get(id);
    tesseraSessions.delete(id);
    const directory =
      session?.directory ?? path.join(tesseraSessionsDirectory, id);
    const present = Boolean(session) || (await exists(directory));
    await session?.worker?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    return { closed: present };
  }

  async function closeAllTesseraSessionWorkers(): Promise<void> {
    const sessions = [...tesseraSessions.values()];
    tesseraSessions.clear();
    await Promise.all(
      sessions.map((session) =>
        session.worker?.close().catch(() => undefined),
      ),
    );
  }

  async function resetTesseraSessionWorker(
    session: {
      directory: string;
      worker: PersistentTesseraWorker | null;
    },
  ): Promise<void> {
    if (!session.worker) return;
    try {
      await session.worker.reset();
    } catch {
      await session.worker.close().catch(() => undefined);
      session.worker = null;
      await mkdir(session.directory, {
        recursive: true,
        mode: 0o700,
      });
      await chmod(session.directory, 0o700);
    }
  }

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
      runtime: getRuntimeProvenance(),
      platform: process.platform,
      projectDirectory: projectRoot,
      nodeExecutable: options.nodeExecutable ?? process.execPath,
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
          remoteOutcomeUnknown: true,
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

  async function performNewRecruitProbe(): Promise<LocalAgentNewRecruitProbeResult> {
    const request: WorkerRequest = {
      action: "probe",
      brokerPath,
      profileDirectory,
    };
    const result = await runProcess(
      nodeExecutable,
      ["--import", "tsx", configuredWorkerPath],
      JSON.stringify(request),
    );
    let worker: WorkerProbeResult;
    try {
      worker = JSON.parse(result.stdout) as WorkerProbeResult;
    } catch {
      return {
        ok: false,
        code: "COMPANION_FAILED",
        message:
          result.stderr ||
          "The New Recruit probe returned an invalid response.",
        uiIdentity: null,
        sessionReused: false,
        importControlVisible: false,
      };
    }
    const uiIdentity = safeNewRecruitUiIdentity(
      worker.uiIdentity,
    );
    if (
      worker.ok &&
      (!uiIdentity || !worker.importControlVisible)
    ) {
      return {
        ok: false,
        code: !uiIdentity
          ? "NEW_RECRUIT_UI_IDENTITY_MISSING"
          : "NEW_RECRUIT_UI_CHANGED",
        message: !uiIdentity
          ? "The authenticated New Recruit probe returned no valid UI identity."
          : "The authenticated New Recruit probe did not verify the import control.",
        uiIdentity,
        sessionReused: worker.sessionReused,
        importControlVisible:
          worker.importControlVisible === true,
      };
    }
    return {
      ok: worker.ok,
      code: worker.code,
      message: worker.message,
      uiIdentity,
      sessionReused: worker.sessionReused === true,
      importControlVisible:
        worker.importControlVisible === true,
    };
  }

  async function performTessera(
    payload: LocalAgentTesseraPayload,
  ): Promise<LocalAgentTesseraResult> {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-agent-tessera-"),
    );
    const session = payload.sessionId
      ? await tesseraSession(payload.sessionId)
      : null;
    if (session) session.active = true;
    try {
      const playerPath = path.join(temporary, "player.rosz");
      const opponentPath = path.join(temporary, "opponent.rosz");
      const profilePath =
        session?.directory ??
        (await tesseraProfileDirectory(undefined, temporary));
      try {
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
      } catch {
        throw Object.assign(
          new Error(
            "The local agent could not materialize the Tessera roster inputs.",
          ),
          { code: "TESSERA_INPUT_MATERIALIZATION_FAILED" },
        );
      }
      const request = {
        brokerPath,
        profileDirectory: profilePath,
        playerRoszPath: playerPath,
        playerName: payload.playerName,
        opponentRoszPath: opponentPath,
        opponentName: payload.opponentName,
        analysisMode: payload.analysisMode,
        phases: payload.phases,
        metrics: payload.metrics,
        profilePolicy: payload.profilePolicy,
        frozenScenarioContract: payload.frozenScenarioContract,
        savedListReuse: payload.savedListReuse,
      };
      let worker: TesseraWorkerResult;
      if (
        session &&
        !useInjectedOneShotTesseraWorker
      ) {
        session.worker ??= startPersistentTesseraWorker(
          nodeExecutable,
          [
            "--import",
            "tsx",
            configuredPersistentTesseraWorkerPath,
            "--persistent",
          ],
        );
        try {
          worker = await session.worker.analyze(request);
        } catch (error) {
          const code =
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : "TESSERA_BROWSER_SESSION_CLOSED";
          if (transientTesseraSessionCodes.has(code)) {
            await resetTesseraSessionWorker(session);
          }
          throw Object.assign(
            error instanceof Error
              ? error
              : new Error("The persistent Tessera worker failed."),
            { code },
          );
        }
      } else {
        const result = await runProcess(
          nodeExecutable,
          ["--import", "tsx", configuredTesseraWorkerPath],
          JSON.stringify(request),
        );
        worker = JSON.parse(result.stdout) as TesseraWorkerResult;
      }
      if (!worker.ok) {
        if (
          session?.worker &&
          transientTesseraSessionCodes.has(worker.code)
        ) {
          await resetTesseraSessionWorker(session);
        }
        throw Object.assign(new Error(worker.message), {
          code: worker.code,
        });
      }
      if (
        session?.worker &&
        transientCodesInTesseraResult(worker.data).length > 0
      ) {
        await resetTesseraSessionWorker(session);
      }
      return worker.data;
    } finally {
      if (session) {
        session.active = false;
        session.lastUsedAt = Date.now();
      }
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

  async function queuedNewRecruitProbe(): Promise<LocalAgentNewRecruitProbeResult> {
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
        return await performNewRecruitProbe();
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

  async function queuedTesseraSessionClose(
    sessionId: string,
  ): Promise<{ closed: boolean }> {
    const task = queue.then(async () => {
      activeJob = true;
      try {
        return await closeTesseraSession(sessionId);
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

  async function startTesseraRunWorker(
    payload: LocalAgentTesseraRunStartPayload,
  ): Promise<LocalAgentTesseraRunStartResult> {
    if (
      !path.isAbsolute(payload.jobPath) ||
      path.basename(payload.jobPath) !== "tessera-run.json"
    ) {
      throw Object.assign(
        new Error(
          "The Tessera run manifest must be an absolute tessera-run.json path.",
        ),
        { code: "TESSERA_JOB_PATH_INVALID" },
      );
    }
    const metadata = await lstat(payload.jobPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw Object.assign(
        new Error(
          "The Tessera run manifest must be a regular, non-symlink file.",
        ),
        { code: "TESSERA_JOB_PATH_INVALID" },
      );
    }
    const document = JSON.parse(
      await readFile(payload.jobPath, "utf8"),
    ) as {
      jobKind?: unknown;
      requestPath?: unknown;
      workerTokenSha256?: unknown;
    };
    const tokenSha256 = createHash("sha256")
      .update(payload.workerToken)
      .digest("hex");
    if (
      document.jobKind !== "rosterpilot-tessera-run" ||
      typeof document.requestPath !== "string" ||
      path.resolve(document.requestPath) !==
        path.resolve(payload.jobPath) ||
      document.workerTokenSha256 !== tokenSha256
    ) {
      throw Object.assign(
        new Error(
          "The Tessera run manifest does not match this launch request.",
        ),
        { code: "TESSERA_WORKER_IDENTITY_MISMATCH" },
      );
    }
    const worker = spawn(
      nodeExecutable,
      [
        "--import",
        "tsx",
        configuredTesseraJobWorkerPath,
        payload.jobPath,
        payload.workerToken,
      ],
      {
        cwd: projectRoot,
        detached: true,
        stdio: "ignore",
      },
    );
    await new Promise<void>((resolve, reject) => {
      worker.once("spawn", resolve);
      worker.once("error", reject);
    });
    if (!worker.pid) {
      throw Object.assign(
        new Error(
          "The local agent could not assign a process identity to the Tessera run worker.",
        ),
        { code: "TESSERA_RUN_SPAWN_FAILED" },
      );
    }
    worker.unref();
    return {
      accepted: true,
      workerPid: worker.pid,
    };
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
            : request.operation === "new-recruit.probe"
              ? await queuedNewRecruitProbe()
            : request.operation === "tessera.analyze"
                ? await queuedTessera(request.payload)
                : request.operation === "tessera.session.close"
                  ? await queuedTesseraSessionClose(
                      request.payload.sessionId,
                    )
                  : await startTesseraRunWorker(request.payload);
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
  await mkdir(tesseraSessionsDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    chmod(spoolDirectory, 0o700),
    chmod(requestsDirectory, 0o700),
    chmod(responsesDirectory, 0o700),
    chmod(tesseraSessionsDirectory, 0o700),
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
    void Promise.all([
      cleanStaleSpool(),
      cleanupExpiredTesseraSessions(),
    ]);
  }, tesseraSessionCleanupIntervalMs);
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
      await closeAllTesseraSessionWorkers();
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
      await queue;
      await closeAllTesseraSessionWorkers();
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
