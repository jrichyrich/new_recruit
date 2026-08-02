import { z } from "zod";

import type { ResultEnvelope, RosterIssue } from "./types";

export const RosterWorkflowIntentSchema = z.enum([
  "build",
  "prepare-new-recruit",
  "deliver-new-recruit",
  "optimize",
]);

export type RosterWorkflowIntent = z.infer<
  typeof RosterWorkflowIntentSchema
>;

export const RosterArtifactRequirementSchema = z.enum([
  "none",
  "new-recruit-rosz",
  "tessera-profile-rich",
]);

export type RosterArtifactRequirement = z.infer<
  typeof RosterArtifactRequirementSchema
>;

export const RosterCoachingModeSchema = z.enum([
  "none",
  "concise",
  "full",
]);

export type RosterCoachingMode = z.infer<
  typeof RosterCoachingModeSchema
>;

export const RosterOptimizerModeSchema = z.enum([
  "guided",
  "recommend-only",
]);

export type RosterOptimizerMode = z.infer<
  typeof RosterOptimizerModeSchema
>;

export type ResolveRosterWorkflowIntentInput = {
  prompt?: string;
  intent?: RosterWorkflowIntent;
  artifactRequirement?: RosterArtifactRequirement;
  coachingMode?: RosterCoachingMode;
  optimizerMode?: RosterOptimizerMode;
};

export type ResolvedRosterWorkflowIntent = {
  intent: RosterWorkflowIntent;
  artifactRequirement: RosterArtifactRequirement;
  coachingMode: RosterCoachingMode;
  optimizerMode: RosterOptimizerMode | null;
  deliveryAuthorized: boolean;
  deliveryTarget: "new-recruit" | null;
  postOptimizationDeliveryRequested: boolean;
  detectedFromPrompt: {
    newRecruitMentioned: boolean;
    deliveryRequested: boolean;
    optimizationRequested: boolean;
    recommendOnlyRequested: boolean;
    question: boolean;
  };
};

function issue(code: string, message: string): RosterIssue {
  return {
    code,
    message,
    severity: "error",
  };
}

function isQuestion(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  return (
    normalized.includes("?") ||
    /^(?:can|could|would|will|do|does|did|is|are|was|were|should|may|might|how|what|why|where|when|which)\b/.test(
      normalized,
    )
  );
}

function promptSignals(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  const question = isQuestion(normalized);
  const newRecruitMentioned = /\bnew\s*recruit\b/.test(normalized);
  const deliveryVerb =
    /\b(?:upload|import|deliver|push|publish|add)\b[^.!?]{0,80}\b(?:to|into)\s+new\s*recruit\b/.test(
      normalized,
    ) ||
    /\bsend\s+(?:(?:this|the)\s+)?(?:roster|list|army|force|rosz|\.rosz|it)\b[^.!?]{0,40}\bto\s+new\s*recruit\b/.test(
      normalized,
    );
  const deliveryRequested =
    !question && newRecruitMentioned && deliveryVerb;
  const optimizationRequested =
    /\b(?:optimi[sz]e|optimization|math[ -]?hammer|tessera|paired test|stress test)\b/.test(
      normalized,
    );
  const recommendOnlyRequested =
    /\b(?:recommend(?:ations?)? only|suggest(?:ions?)? only|do not (?:change|modify|apply)|don['’]t (?:change|modify|apply)|without (?:changing|modifying|applying))\b/.test(
      normalized,
    );
  const prepareRequested =
    newRecruitMentioned &&
    /\b(?:prepare|export|download|\.rosz|rosz|handoff)\b/.test(
      normalized,
    );
  const noCoaching =
    /\b(?:no coaching|without coaching|skip (?:the )?(?:advice|coaching))\b/.test(
      normalized,
    );
  const fullCoaching =
    /\b(?:full|detailed|deep|comprehensive)\s+(?:advice|analysis|coaching|breakdown)\b/.test(
      normalized,
    );
  return {
    question,
    newRecruitMentioned,
    deliveryRequested,
    optimizationRequested,
    recommendOnlyRequested,
    prepareRequested,
    noCoaching,
    fullCoaching,
  };
}

function inferredIntent(
  signals: ReturnType<typeof promptSignals>,
): RosterWorkflowIntent {
  if (signals.optimizationRequested) return "optimize";
  if (signals.deliveryRequested) return "deliver-new-recruit";
  if (signals.prepareRequested) return "prepare-new-recruit";
  return "build";
}

function requiredArtifact(
  intent: RosterWorkflowIntent,
): RosterArtifactRequirement {
  if (intent === "optimize") return "tessera-profile-rich";
  if (
    intent === "prepare-new-recruit" ||
    intent === "deliver-new-recruit"
  ) {
    return "new-recruit-rosz";
  }
  return "none";
}

function compatibleArtifact(
  intent: RosterWorkflowIntent,
  artifact: RosterArtifactRequirement,
): boolean {
  if (intent === "build") return artifact === "none";
  if (intent === "optimize") {
    return artifact === "tessera-profile-rich";
  }
  return artifact === "new-recruit-rosz";
}

/**
 * Resolves the requested workflow without granting side-effect authority from
 * a capability question. Direct New Recruit delivery is authorized only by a
 * structured delivery intent or an unambiguous imperative in the same prompt.
 */
export function resolveRosterWorkflowIntent(
  input: ResolveRosterWorkflowIntentInput,
): ResultEnvelope<ResolvedRosterWorkflowIntent> {
  const signals = promptSignals(input.prompt ?? "");
  if (
    input.intent === "deliver-new-recruit" &&
    signals.question
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "WORKFLOW_DELIVERY_QUESTION_CONFLICT",
          "A capability question cannot authorize New Recruit delivery. Remove the question and issue an explicit upload/import instruction, or omit the delivery intent.",
        ),
      ],
      warnings: [],
    };
  }
  const detectedIntent = inferredIntent(signals);
  if (
    input.intent &&
    detectedIntent !== "build" &&
    input.intent !== detectedIntent &&
    !(
      input.intent === "optimize" &&
      detectedIntent === "deliver-new-recruit"
    )
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "WORKFLOW_INTENT_CONFLICT",
          `Structured intent "${input.intent}" conflicts with prompt intent "${detectedIntent}".`,
        ),
      ],
      warnings: [],
    };
  }

  const intent = input.intent ?? detectedIntent;
  const artifactRequirement =
    input.artifactRequirement ?? requiredArtifact(intent);
  if (!compatibleArtifact(intent, artifactRequirement)) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "WORKFLOW_ARTIFACT_CONFLICT",
          `Workflow "${intent}" requires ${requiredArtifact(intent)}, not ${artifactRequirement}.`,
        ),
      ],
      warnings: [],
    };
  }

  const optimizerMode =
    intent === "optimize"
      ? input.optimizerMode ??
        (signals.recommendOnlyRequested
          ? "recommend-only"
          : "guided")
      : null;
  if (intent !== "optimize" && input.optimizerMode) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "WORKFLOW_OPTIMIZER_MODE_CONFLICT",
          "optimizerMode is valid only for an optimize workflow.",
        ),
      ],
      warnings: [],
    };
  }
  if (
    intent === "optimize" &&
    optimizerMode === "recommend-only" &&
    signals.deliveryRequested
  ) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "WORKFLOW_RECOMMEND_ONLY_DELIVERY_CONFLICT",
          "Recommend-only optimization has no paired-tested winner to deliver. Choose guided mode or remove the winner-delivery request.",
        ),
      ],
      warnings: [],
    };
  }

  const coachingMode =
    input.coachingMode ??
    (signals.noCoaching
      ? "none"
      : signals.fullCoaching
        ? "full"
        : "concise");
  const structuredDelivery = input.intent === "deliver-new-recruit";
  const deliveryAuthorized =
    intent === "deliver-new-recruit" &&
    (structuredDelivery || signals.deliveryRequested);
  const postOptimizationDeliveryRequested =
    intent === "optimize" && signals.deliveryRequested;

  return {
    ok: true,
    data: {
      intent,
      artifactRequirement,
      coachingMode,
      optimizerMode,
      deliveryAuthorized,
      deliveryTarget:
        deliveryAuthorized || postOptimizationDeliveryRequested
          ? "new-recruit"
          : null,
      postOptimizationDeliveryRequested,
      detectedFromPrompt: {
        newRecruitMentioned: signals.newRecruitMentioned,
        deliveryRequested: signals.deliveryRequested,
        optimizationRequested: signals.optimizationRequested,
        recommendOnlyRequested: signals.recommendOnlyRequested,
        question: signals.question,
      },
    },
    violations: [],
    warnings: [],
  };
}
