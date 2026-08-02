import { createHash } from "node:crypto";

import type { RosterWorkflowResult } from "./roster-workflow";
import { rosterExecutionFingerprint } from "./stress-portfolio";

export type WorkflowOutcomeClass =
  | "succeeded"
  | "action-required"
  | "blocked"
  | "inconclusive"
  | "failed";

export const RecoveryActionIds = [
  "data.inspect",
  "roster.rebase-compatible",
  "artifact.export-fallback",
  "new-recruit.inspect-mutation",
  "new-recruit.reconcile-outcome",
  "new-recruit.deliver",
  "tessera.start-baseline",
  "tessera.resume",
  "tessera.resolve-profiles",
  "provider.start-local-sibling",
  "provider.start-web-sibling",
  "optimizer.approve-candidates",
  "optimizer.approve-result",
  "workflow.park",
] as const;

export type RecoveryActionId = (typeof RecoveryActionIds)[number];

export type RecoveryAuthority =
  | { kind: "automatic" }
  | { kind: "policy"; grant: string }
  | { kind: "fresh-approval"; challengeId: string }
  | { kind: "forbidden"; reasonCode: string };

export type RecoveryActionOffer = {
  actionId: RecoveryActionId;
  eligibility: "ready" | "needs-approval" | "blocked" | "unavailable";
  authority: RecoveryAuthority;
  binding: {
    journeyId: string | null;
    journeyRevision: number | null;
    rosterFingerprint: string | null;
    bundleId: string | null;
  };
  consequence: {
    localWrite: boolean;
    externalRead: boolean;
    externalMutation: boolean;
    rosterSelectionChange: boolean;
    providerChange: boolean;
    credentialChange: boolean;
  };
  reasonCodes: string[];
  command?: string;
  mcpTool?: string;
};

export type RecoveryStateV1 = {
  schemaVersion: 1;
  status: "completed" | "action-required" | "parked" | "blocked";
  outcomeClass: WorkflowOutcomeClass;
  whatSucceeded: string[];
  blockedStep: string | null;
  rosterStillLegal: boolean | null;
  preservedArtifacts: Array<{
    filename: string;
    format: string;
    sha256: string;
  }>;
  remoteMutationOutcome:
    | "none"
    | "pending"
    | "created"
    | "reused"
    | "uncertain"
    | "not-created";
  recommendedActionId: RecoveryActionId | null;
  actions: RecoveryActionOffer[];
};

const noConsequences = {
  localWrite: false,
  externalRead: false,
  externalMutation: false,
  rosterSelectionChange: false,
  providerChange: false,
  credentialChange: false,
} as const;

function artifactSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function offer(
  actionId: RecoveryActionId,
  input: {
    journeyId?: string;
    journeyRevision?: number;
    workflow: RosterWorkflowResult;
    eligibility?: RecoveryActionOffer["eligibility"];
    authority?: RecoveryAuthority;
    reasonCodes?: string[];
    consequence?: Partial<RecoveryActionOffer["consequence"]>;
    command?: string;
    mcpTool?: string;
  },
): RecoveryActionOffer {
  return {
    actionId,
    eligibility: input.eligibility ?? "ready",
    authority: input.authority ?? { kind: "automatic" },
    binding: {
      journeyId: input.journeyId ?? null,
      journeyRevision: input.journeyRevision ?? null,
      rosterFingerprint: input.workflow.roster
        ? rosterExecutionFingerprint(input.workflow.roster)
        : null,
      bundleId: input.workflow.roster?.sourceData.bundleId ?? null,
    },
    consequence: {
      ...noConsequences,
      ...input.consequence,
    },
    reasonCodes: input.reasonCodes ?? [],
    command: input.command,
    mcpTool: input.mcpTool,
  };
}

export function projectWorkflowRecovery(
  workflow: RosterWorkflowResult,
  input: { journeyId?: string; journeyRevision?: number } = {},
): RecoveryStateV1 {
  const whatSucceeded = [
    ...(workflow.roster ? ["roster-built"] : []),
    ...(workflow.validation?.ok ? ["roster-validated"] : []),
    ...(workflow.explanation ? ["roster-explained"] : []),
    ...(workflow.newRecruit.handoff?.artifacts.length
      ? ["fallback-artifacts-prepared"]
      : []),
  ];
  const preservedArtifacts =
    workflow.newRecruit.handoff?.artifacts.map((artifact) => ({
      filename: artifact.filename,
      format: artifact.format,
      sha256: artifactSha256(artifact.content),
    })) ?? [];
  const binding = { ...input, workflow };

  if (workflow.status === "complete") {
    return {
      schemaVersion: 1,
      status: "completed",
      outcomeClass: "succeeded",
      whatSucceeded,
      blockedStep: null,
      rosterStillLegal: workflow.validation?.ok ?? null,
      preservedArtifacts,
      remoteMutationOutcome: "none",
      recommendedActionId: null,
      actions: [],
    };
  }

  const actions: RecoveryActionOffer[] = [];
  if (preservedArtifacts.length > 0) {
    actions.push(
      offer("artifact.export-fallback", {
        ...binding,
        reasonCodes: ["FALLBACK_ARTIFACTS_AVAILABLE"],
        consequence: { localWrite: true },
      }),
    );
  }
  if (workflow.status === "ready-for-tessera-baseline") {
    actions.unshift(
      offer("tessera.start-baseline", {
        ...binding,
        eligibility: "needs-approval",
        authority: {
          kind: "fresh-approval",
          challengeId: `start-tessera:${workflow.roster?.id ?? "unknown"}`,
        },
        reasonCodes: ["TESSERA_BASELINE_PENDING"],
        consequence: { externalRead: true, externalMutation: true },
        mcpTool: "start_tessera_run",
      }),
    );
  }
  actions.push(
    offer("data.inspect", {
      ...binding,
      reasonCodes: ["VERIFY_COMPATIBILITY"],
      mcpTool: "get_data_update_status",
    }),
    offer("workflow.park", {
      ...binding,
      reasonCodes: ["PRESERVE_FOR_LATER"],
    }),
  );

  const actionRequired =
    workflow.status === "action-required" ||
    workflow.status === "ready-for-tessera-baseline";
  return {
    schemaVersion: 1,
    status: actionRequired ? "action-required" : "blocked",
    outcomeClass: actionRequired ? "action-required" : "blocked",
    whatSucceeded,
    blockedStep:
      workflow.status === "ready-for-tessera-baseline"
        ? "tessera-baseline"
        : workflow.status === "needs-input"
          ? "request-resolution"
          : "requested-action",
    rosterStillLegal: workflow.validation?.ok ?? null,
    preservedArtifacts,
    remoteMutationOutcome: "none",
    recommendedActionId: actions[0]?.actionId ?? "workflow.park",
    actions,
  };
}
