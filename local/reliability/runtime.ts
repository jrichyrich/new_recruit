import crypto from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import { rosterPilotSupportDirectory } from "../agent/paths";
import {
  readWorkflowReliabilityHistorySafely,
  readWorkflowReliabilityAggregateSummarySafely,
  readWorkflowReliabilitySummarySafely,
} from "./adapters";
import {
  createWorkflowReliabilityEventStore,
  type WorkflowReliabilityEventStore,
} from "./store";
import type {
  WorkflowReliabilityAdapterResult,
} from "./adapters";
import type {
  WorkflowReliabilityHistory,
  WorkflowReliabilityAggregateSummaryV1,
  WorkflowReliabilityRefV1,
  WorkflowReliabilitySummaryV1,
} from "./types";

export type WorkflowReliabilityIdentityKind =
  | "journey-id"
  | "tessera-run-id"
  | "successor-run-id"
  | "data-update-job-id"
  | "new-recruit-run-id";

export type WorkflowReliabilityIdentityV1 = {
  kind: WorkflowReliabilityIdentityKind;
  value: string;
};

type WorkflowReliabilityIdentityRegistryV1 = {
  schemaVersion: 1;
  registryKind: "workflow-reliability-identities";
  entries: Array<{
    identity: WorkflowReliabilityIdentityV1;
    workflow: WorkflowReliabilityRefV1;
    associatedAt: string;
    predecessorWorkflowId: string | null;
  }>;
  integritySha256: string;
};

function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function reliabilityRoot(rootDirectory?: string): string {
  return path.resolve(
    rootDirectory ??
      path.join(rosterPilotSupportDirectory(), "reliability"),
  );
}

let defaultStore: WorkflowReliabilityEventStore | null = null;

export function getWorkflowReliabilityEventStore(): WorkflowReliabilityEventStore {
  defaultStore ??= createWorkflowReliabilityEventStore({
    rootDirectory: reliabilityRoot(),
  });
  return defaultStore;
}

export function workflowReliabilityRef(input: {
  workflowId: string;
  workflowKind?: string;
}): WorkflowReliabilityRefV1 {
  return {
    workflowId: input.workflowId,
    workflowKind: input.workflowKind ?? "tessera-run",
  };
}

function registryPath(rootDirectory?: string): string {
  return path.join(
    reliabilityRoot(rootDirectory),
    "v1",
    "identity-registry.json",
  );
}

function registryLock(rootDirectory?: string): string {
  return path.join(
    reliabilityRoot(rootDirectory),
    "v1",
    ".identity-registry.lock",
  );
}

function emptyRegistry(): WorkflowReliabilityIdentityRegistryV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    registryKind: "workflow-reliability-identities" as const,
    entries: [],
  };
  return { ...unsigned, integritySha256: digest(unsigned) };
}

function verifyRegistry(
  value: WorkflowReliabilityIdentityRegistryV1,
): WorkflowReliabilityIdentityRegistryV1 {
  const { integritySha256, ...unsigned } = value;
  if (
    value.schemaVersion !== 1 ||
    value.registryKind !== "workflow-reliability-identities" ||
    digest(unsigned) !== integritySha256
  ) {
    throw new Error("The workflow reliability identity registry is invalid.");
  }
  return value;
}

async function readRegistry(
  rootDirectory?: string,
): Promise<WorkflowReliabilityIdentityRegistryV1> {
  try {
    return verifyRegistry(
      JSON.parse(
        await readFile(registryPath(rootDirectory), "utf8"),
      ) as WorkflowReliabilityIdentityRegistryV1,
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return emptyRegistry();
    }
    throw error;
  }
}

async function writeRegistry(
  value: WorkflowReliabilityIdentityRegistryV1,
  rootDirectory?: string,
): Promise<void> {
  const filename = registryPath(rootDirectory);
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${canonicalJson(value)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withRegistryLock<T>(
  operation: () => Promise<T>,
  rootDirectory?: string,
): Promise<T> {
  const lockDirectory = registryLock(rootDirectory);
  await mkdir(path.dirname(lockDirectory), {
    recursive: true,
    mode: 0o700,
  });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST" ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

export async function associateWorkflowReliabilityIdentities(input: {
  workflow: WorkflowReliabilityRefV1;
  identities: WorkflowReliabilityIdentityV1[];
  predecessorWorkflowId?: string | null;
}, options: {
  rootDirectory?: string;
} = {}): Promise<{ ok: boolean; warning: string | null }> {
  try {
    await withRegistryLock(async () => {
      const registry = await readRegistry(options.rootDirectory);
      const existing = new Map(
        registry.entries.map((entry) => [
          `${entry.identity.kind}:${entry.identity.value}`,
          entry,
        ]),
      );
      for (const identity of input.identities) {
        if (!identity.value.trim()) continue;
        const key = `${identity.kind}:${identity.value}`;
        const prior = existing.get(key);
        if (
          prior &&
          (
            prior.workflow.workflowId !== input.workflow.workflowId ||
            prior.workflow.workflowKind !== input.workflow.workflowKind
          )
        ) {
          throw new Error(
            `Reliability identity ${key} is already bound to another workflow.`,
          );
        }
        if (!prior) {
          const entry = {
            identity,
            workflow: input.workflow,
            associatedAt: new Date().toISOString(),
            predecessorWorkflowId:
              input.predecessorWorkflowId ?? null,
          };
          registry.entries.push(entry);
          existing.set(key, entry);
        }
      }
      registry.entries.sort((left, right) =>
        `${left.identity.kind}:${left.identity.value}`.localeCompare(
          `${right.identity.kind}:${right.identity.value}`,
        ),
      );
      const unsigned = {
        schemaVersion: 1 as const,
        registryKind: "workflow-reliability-identities" as const,
        entries: registry.entries,
      };
      await writeRegistry(
        {
          ...unsigned,
          integritySha256: digest(unsigned),
        },
        options.rootDirectory,
      );
    }, options.rootDirectory);
    return { ok: true, warning: null };
  } catch (error) {
    return {
      ok: false,
      warning:
        error instanceof Error
          ? error.message
          : "The reliability identity association failed.",
    };
  }
}

export async function resolveWorkflowReliabilityIdentity(
  identity: WorkflowReliabilityIdentityV1,
  options: { rootDirectory?: string } = {},
): Promise<WorkflowReliabilityRefV1 | null> {
  const registry = await readRegistry(options.rootDirectory);
  return registry.entries.find(
    (entry) =>
      entry.identity.kind === identity.kind &&
      entry.identity.value === identity.value,
  )?.workflow ?? null;
}

export function getWorkflowRepairHistory(input: {
  workflowId: string;
  workflowKind?: string;
}): Promise<WorkflowReliabilityAdapterResult<WorkflowReliabilityHistory>> {
  return readWorkflowReliabilityHistorySafely(
    getWorkflowReliabilityEventStore(),
    workflowReliabilityRef(input),
  );
}

export function getReliabilitySummary(input: {
  workflowId: string;
  workflowKind?: string;
}): Promise<
  WorkflowReliabilityAdapterResult<WorkflowReliabilitySummaryV1>
>;
export function getReliabilitySummary(input?: {
  workflowId?: undefined;
  workflowKind?: string;
}): Promise<
  WorkflowReliabilityAdapterResult<WorkflowReliabilityAggregateSummaryV1>
>;
export function getReliabilitySummary(input: {
  workflowId?: string;
  workflowKind?: string;
} = {}): Promise<
  WorkflowReliabilityAdapterResult<
    WorkflowReliabilitySummaryV1 | WorkflowReliabilityAggregateSummaryV1
  >
> {
  const workflowId = input.workflowId;
  if (!workflowId) {
    return readWorkflowReliabilityAggregateSummarySafely(
      getWorkflowReliabilityEventStore(),
      { workflowKind: input.workflowKind },
    );
  }
  return readWorkflowReliabilitySummarySafely(
    getWorkflowReliabilityEventStore(),
    workflowReliabilityRef({
      workflowId,
      workflowKind: input.workflowKind,
    }),
  );
}
