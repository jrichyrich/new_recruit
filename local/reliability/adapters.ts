import type {
  AppendWorkflowReliabilityEventInput,
  ReliabilityJsonObject,
  WorkflowReliabilityAppendResult,
  WorkflowReliabilityAggregateSummaryV1,
  WorkflowReliabilityHistory,
  WorkflowReliabilityReconciliationResult,
  WorkflowReliabilityRefV1,
  WorkflowReliabilitySummaryV1,
  WorkflowReliabilityVerification,
} from "./types";
import {
  WorkflowReliabilityStoreError,
  type WorkflowReliabilityEventStore,
} from "./store";
import {
  readWorkflowReliabilityAggregateSummary,
  readWorkflowReliabilitySummary,
} from "./summary";
import { sanitizeReliabilityText } from "./sanitize";

export type WorkflowReliabilityAdapterError = {
  code: string;
  message: string;
};

export type WorkflowReliabilityAdapterResult<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: WorkflowReliabilityAdapterError };

function adapterFailure(error: unknown): WorkflowReliabilityAdapterResult<never> {
  return {
    ok: false,
    data: null,
    error: {
      code:
        error instanceof WorkflowReliabilityStoreError
          ? error.code
          : "RELIABILITY_ADAPTER_FAILED",
      message:
        error instanceof Error
          ? sanitizeReliabilityText(error.message)
          : "The reliability operation failed.",
    },
  };
}

async function nonThrowing<T>(
  operation: () => Promise<T>,
): Promise<WorkflowReliabilityAdapterResult<T>> {
  try {
    return { ok: true, data: await operation(), error: null };
  } catch (error) {
    return adapterFailure(error);
  }
}

export function appendWorkflowReliabilityEventSafely(
  store: WorkflowReliabilityEventStore,
  input: AppendWorkflowReliabilityEventInput,
): Promise<WorkflowReliabilityAdapterResult<WorkflowReliabilityAppendResult>> {
  return nonThrowing(() => store.append(input));
}

export function verifyWorkflowReliabilitySafely(
  store: WorkflowReliabilityEventStore,
  workflow: WorkflowReliabilityRefV1,
): Promise<WorkflowReliabilityAdapterResult<WorkflowReliabilityVerification>> {
  return nonThrowing(() => store.verify(workflow));
}

export function reconcileWorkflowReliabilitySafely(
  store: WorkflowReliabilityEventStore,
  workflow: WorkflowReliabilityRefV1,
): Promise<
  WorkflowReliabilityAdapterResult<WorkflowReliabilityReconciliationResult>
> {
  return nonThrowing(() => store.reconcile(workflow));
}

export function readWorkflowReliabilityHistorySafely(
  store: WorkflowReliabilityEventStore,
  workflow: WorkflowReliabilityRefV1,
): Promise<WorkflowReliabilityAdapterResult<WorkflowReliabilityHistory>> {
  return nonThrowing(() => store.history(workflow));
}

export function readWorkflowReliabilitySummarySafely(
  store: WorkflowReliabilityEventStore,
  workflow: WorkflowReliabilityRefV1,
): Promise<WorkflowReliabilityAdapterResult<WorkflowReliabilitySummaryV1>> {
  return nonThrowing(() => readWorkflowReliabilitySummary(store, workflow));
}

export function readWorkflowReliabilityAggregateSummarySafely(
  store: WorkflowReliabilityEventStore,
  options: { workflowKind?: string } = {},
): Promise<
  WorkflowReliabilityAdapterResult<WorkflowReliabilityAggregateSummaryV1>
> {
  return nonThrowing(() =>
    readWorkflowReliabilityAggregateSummary(store, options),
  );
}

export type WorkflowReliabilityRecorderDefaults = {
  workflow: WorkflowReliabilityRefV1;
  provider?: string | null;
  attributes?: ReliabilityJsonObject;
};

export type WorkflowReliabilityRecorder = {
  record(
    input: Omit<AppendWorkflowReliabilityEventInput, "workflow">,
  ): Promise<WorkflowReliabilityAdapterResult<WorkflowReliabilityAppendResult>>;
  verify(): Promise<
    WorkflowReliabilityAdapterResult<WorkflowReliabilityVerification>
  >;
  reconcile(): Promise<
    WorkflowReliabilityAdapterResult<WorkflowReliabilityReconciliationResult>
  >;
  history(): Promise<
    WorkflowReliabilityAdapterResult<WorkflowReliabilityHistory>
  >;
  summary(): Promise<
    WorkflowReliabilityAdapterResult<WorkflowReliabilitySummaryV1>
  >;
};

/** Stable, non-throwing facade for durable jobs and stress runners. */
export function createWorkflowReliabilityRecorder(
  store: WorkflowReliabilityEventStore,
  defaults: WorkflowReliabilityRecorderDefaults,
): WorkflowReliabilityRecorder {
  return {
    record(input) {
      const attributes = defaults.attributes
        ? {
            ...defaults.attributes,
            ...(input.attributes &&
            typeof input.attributes === "object" &&
            !Array.isArray(input.attributes)
              ? input.attributes
              : input.attributes === undefined
                ? {}
                : { eventAttributes: input.attributes }),
          }
        : input.attributes;
      return appendWorkflowReliabilityEventSafely(store, {
        ...input,
        workflow: defaults.workflow,
        provider: input.provider ?? defaults.provider ?? null,
        attributes,
      });
    },
    verify() {
      return verifyWorkflowReliabilitySafely(store, defaults.workflow);
    },
    reconcile() {
      return reconcileWorkflowReliabilitySafely(store, defaults.workflow);
    },
    history() {
      return readWorkflowReliabilityHistorySafely(store, defaults.workflow);
    },
    summary() {
      return readWorkflowReliabilitySummarySafely(store, defaults.workflow);
    },
  };
}
