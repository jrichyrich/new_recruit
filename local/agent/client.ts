import net from "node:net";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  LOCAL_AGENT_MAX_FRAME_BYTES,
  LOCAL_AGENT_PROTOCOL_VERSION,
  type LocalAgentDeliveryPayload,
  type LocalAgentDeliveryResult,
  type LocalAgentTesseraPayload,
  type LocalAgentTesseraResult,
  type LocalAgentRequest,
  type LocalAgentResponse,
  type LocalAgentStatus,
} from "./contracts";
import { FrameDecoder, encodeFrame } from "./framing";
import { localAgentSocketPath, localAgentSpoolDirectory } from "./paths";

export class LocalAgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transportCode?: string,
  ) {
    super(message);
  }
}

export type LocalAgentClientOptions = {
  socketPath?: string;
  spoolDirectory?: string;
  timeoutMs?: number;
};

function responseData<T>(
  request: LocalAgentRequest,
  response: LocalAgentResponse,
): T {
  if (response.id !== request.id) {
    throw new LocalAgentError(
      "LOCAL_AGENT_PROTOCOL_ERROR",
      "The RosterPilot local agent returned a mismatched response.",
    );
  }
  if (!response.ok) {
    throw new LocalAgentError(response.code, response.message);
  }
  return response.data as T;
}

async function socketRequest<T>(
  request: LocalAgentRequest,
  options: LocalAgentClientOptions = {},
): Promise<T> {
  const socketPath = options.socketPath ?? localAgentSocketPath();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const decoder = new FrameDecoder();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write(encodeFrame(request)));
    socket.on("timeout", () =>
      finish(() =>
        reject(
          new LocalAgentError(
            "LOCAL_AGENT_TIMEOUT",
            "The RosterPilot local agent did not respond in time.",
          ),
        ),
      ),
    );
    socket.on("error", (error) =>
      finish(() =>
        reject(
          new LocalAgentError(
            "LOCAL_AGENT_UNAVAILABLE",
            `The RosterPilot local agent is unavailable: ${error.message}`,
            (error as NodeJS.ErrnoException).code,
          ),
        ),
      ),
    );
    socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(Buffer.from(chunk))) {
          const data = responseData<T>(
            request,
            value as LocalAgentResponse,
          );
          finish(() => resolve(data));
          return;
        }
      } catch (error) {
        finish(() =>
          reject(
            error instanceof LocalAgentError
              ? error
              : new LocalAgentError(
                  "LOCAL_AGENT_PROTOCOL_ERROR",
                  error instanceof Error
                    ? error.message
                    : "The local-agent response was invalid.",
                ),
          ),
        );
      }
    });
  });
}

async function spoolRequest<T>(
  request: LocalAgentRequest,
  options: LocalAgentClientOptions,
): Promise<T> {
  const spoolDirectory =
    options.spoolDirectory ?? localAgentSpoolDirectory();
  const requestsDirectory = path.join(spoolDirectory, "requests");
  const responsesDirectory = path.join(spoolDirectory, "responses");
  try {
    await Promise.all([
      access(requestsDirectory),
      access(responsesDirectory),
    ]);
  } catch {
    throw new LocalAgentError(
      "LOCAL_AGENT_UNAVAILABLE",
      "The RosterPilot local-agent fallback transport is unavailable.",
    );
  }
  const requestPath = path.join(
    requestsDirectory,
    `${request.id}.request.json`,
  );
  const temporaryPath = `${requestPath}.${process.pid}.tmp`;
  const responsePath = path.join(
    responsesDirectory,
    `${request.id}.response.json`,
  );
  const payload = Buffer.from(JSON.stringify(request), "utf8");
  if (payload.length > LOCAL_AGENT_MAX_FRAME_BYTES) {
    throw new LocalAgentError(
      "LOCAL_AGENT_PAYLOAD_TOO_LARGE",
      "The RosterPilot local-agent request exceeds the maximum size.",
    );
  }
  await writeFile(temporaryPath, payload, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, requestPath);
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  try {
    while (Date.now() < deadline) {
      try {
        const responseBytes = await readFile(responsePath);
        if (responseBytes.length > LOCAL_AGENT_MAX_FRAME_BYTES) {
          throw new LocalAgentError(
            "LOCAL_AGENT_PROTOCOL_ERROR",
            "The RosterPilot local-agent response exceeds the maximum size.",
          );
        }
        return responseData<T>(
          request,
          JSON.parse(responseBytes.toString("utf8")) as LocalAgentResponse,
        );
      } catch (error) {
        if (
          error instanceof LocalAgentError ||
          !(error && typeof error === "object" && "code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new LocalAgentError(
      "LOCAL_AGENT_TIMEOUT",
      "The RosterPilot local agent did not respond in time.",
    );
  } finally {
    await Promise.all([
      rm(temporaryPath, { force: true }),
      rm(requestPath, { force: true }),
      rm(responsePath, { force: true }),
    ]);
  }
}

async function request<T>(
  request: LocalAgentRequest,
  options: LocalAgentClientOptions = {},
): Promise<T> {
  if (options.spoolDirectory) {
    return spoolRequest<T>(request, options);
  }
  try {
    return await socketRequest<T>(request, options);
  } catch (error) {
    if (
      error instanceof LocalAgentError &&
      (error.transportCode === "EPERM" ||
        error.transportCode === "EACCES")
    ) {
      return spoolRequest<T>(request, options);
    }
    throw error;
  }
}

export function getLocalAgentStatus(
  options?: LocalAgentClientOptions,
): Promise<LocalAgentStatus> {
  return request<LocalAgentStatus>(
    {
      id: randomUUID(),
      protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
      operation: "agent.status",
    },
    { ...options, timeoutMs: options?.timeoutMs ?? 5_000 },
  );
}

export function deliverThroughLocalAgent(
  payload: LocalAgentDeliveryPayload,
  options?: LocalAgentClientOptions,
): Promise<LocalAgentDeliveryResult> {
  return request<LocalAgentDeliveryResult>(
    {
      id: randomUUID(),
      protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
      operation: "new-recruit.deliver",
      payload,
    },
    options,
  );
}

export function runTesseraThroughLocalAgent(
  payload: LocalAgentTesseraPayload,
  options?: LocalAgentClientOptions,
): Promise<LocalAgentTesseraResult> {
  return request<LocalAgentTesseraResult>(
    {
      id: randomUUID(),
      protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
      operation: "tessera.analyze",
      payload,
    },
    options,
  );
}
