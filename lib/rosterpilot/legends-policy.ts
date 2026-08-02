import { z } from "zod";

export const LegendsPolicySchema = z.enum(["auto", "allow", "exclude"]);
export type LegendsPolicy = z.infer<typeof LegendsPolicySchema>;

export const LegendsPermissionSchema = z.enum([
  "allowed",
  "disallowed",
  "unknown",
]);
export type LegendsPermission = z.infer<typeof LegendsPermissionSchema>;

export const LegendsClassificationAuthoritySchema = z.enum([
  "verified",
  "unavailable",
  "unverified-overlay",
  "unknown",
]);
export type LegendsClassificationAuthority = z.infer<
  typeof LegendsClassificationAuthoritySchema
>;

export const LegendsPolicyEvidenceSchema = z
  .object({
    source: z.enum([
      "event-pack",
      "organizer-ruling",
      "user-declaration",
      "prompt",
      "legacy-allow-legends",
    ]),
    title: z.string().min(1).optional(),
    reference: z.string().min(1).optional(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    checkedAt: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.source !== "event-pack" &&
      evidence.source !== "organizer-ruling"
    ) {
      return;
    }
    if (!evidence.title) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message:
          "Event permission evidence requires a source title.",
      });
    }
    if (!evidence.reference && !evidence.contentSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference"],
        message:
          "Event permission evidence requires a section/reference or exact content hash.",
      });
    }
  });
export type LegendsPolicyEvidence = z.infer<
  typeof LegendsPolicyEvidenceSchema
>;

export const LegendsPlayContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unspecified") }).strict(),
  z.object({ kind: z.literal("open-play") }).strict(),
  z.object({ kind: z.literal("casual") }).strict(),
  z.object({ kind: z.literal("narrative") }).strict(),
  z.object({ kind: z.literal("matched-play") }).strict(),
  z
    .object({
      kind: z.literal("event"),
      eventName: z.string().min(1),
      legendsPermission: LegendsPermissionSchema,
      evidence: LegendsPolicyEvidenceSchema.optional(),
    })
    .strict(),
]);
export type LegendsPlayContext = z.infer<
  typeof LegendsPlayContextSchema
>;

export const LegendsPromptIntentSchema = z.enum([
  "silent",
  "allow",
  "exclude",
  "conflict",
]);
export type LegendsPromptIntent = z.infer<
  typeof LegendsPromptIntentSchema
>;

export const LegendsPolicyDecisionSchema = z
  .object({
    requestedPolicy: LegendsPolicySchema,
    promptIntent: LegendsPromptIntentSchema,
    contextPermission: LegendsPermissionSchema,
    effectiveAllowLegends: z.boolean(),
    resolution: z.enum(["allowed", "excluded", "blocked"]),
    source: z.enum([
      "structured-policy",
      "legacy-allow-legends",
      "prompt",
      "play-context",
      "default",
    ]),
    reason: z.string().min(1),
    classificationAuthority: LegendsClassificationAuthoritySchema,
    playContextKind: z.enum([
      "unspecified",
      "open-play",
      "casual",
      "narrative",
      "matched-play",
      "event",
    ]),
    eventName: z.string().min(1).optional(),
    evidence: LegendsPolicyEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (
      decision.playContextKind === "event" &&
      !decision.eventName
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventName"],
        message:
          "An event Legends decision must retain the event name.",
      });
    }
    if (
      decision.playContextKind !== "event" &&
      decision.eventName !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventName"],
        message:
          "A non-event Legends decision cannot claim an event name.",
      });
    }
    if (
      decision.playContextKind !== "event" &&
      decision.evidence !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message:
          "Only an event Legends decision may retain event evidence.",
      });
    }
    const expectedNonEventPermission =
      decision.playContextKind === "open-play" ||
      decision.playContextKind === "casual" ||
      decision.playContextKind === "narrative"
        ? "allowed"
        : "unknown";
    if (
      decision.playContextKind !== "event" &&
      decision.contextPermission !== expectedNonEventPermission
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contextPermission"],
        message:
          "The stored Legends permission does not match its play context.",
      });
    }
    if (
      decision.playContextKind === "event" &&
      decision.contextPermission !== "unknown" &&
      decision.evidence?.source !== "event-pack" &&
      decision.evidence?.source !== "organizer-ruling"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message:
          "A known event Legends permission requires source-backed evidence.",
      });
    }
    if (
      decision.effectiveAllowLegends &&
      decision.requestedPolicy !== "allow" &&
      decision.promptIntent !== "allow" &&
      decision.contextPermission !== "allowed"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveAllowLegends"],
        message:
          "An enabled Legends decision requires an explicit opt-in or an allowed play context.",
      });
    }
    if (
      decision.promptIntent === "conflict" &&
      decision.resolution !== "blocked"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message:
          "Conflicting Legends prompt instructions must block the decision.",
      });
    }
    if (
      decision.source === "prompt" &&
      !(
        (
          decision.promptIntent === "allow" &&
          decision.requestedPolicy === "allow"
        ) ||
        (
          decision.promptIntent === "exclude" &&
          decision.requestedPolicy === "exclude"
        ) ||
        (
          decision.promptIntent === "conflict" &&
          decision.requestedPolicy === "auto"
        )
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message:
          "A prompt-sourced Legends decision must match the prompt intent.",
      });
    }
    if (
      decision.source === "legacy-allow-legends" &&
      decision.requestedPolicy === "auto"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedPolicy"],
        message:
          "The legacy Legends boolean cannot produce an automatic policy.",
      });
    }
    if (
      decision.source === "default" &&
      (
        decision.requestedPolicy !== "auto" ||
        decision.promptIntent !== "silent" ||
        decision.playContextKind !== "unspecified"
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message:
          "A default Legends decision must be an unspecified, silent automatic policy.",
      });
    }
    if (
      decision.source === "play-context" &&
      (
        decision.requestedPolicy !== "auto" ||
        decision.promptIntent !== "silent" ||
        decision.playContextKind === "unspecified"
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message:
          "A play-context Legends decision must be a silent automatic policy with a specified context.",
      });
    }
    if (
      (decision.resolution === "allowed") !==
      decision.effectiveAllowLegends
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveAllowLegends"],
        message:
          "Only an allowed Legends decision may enable Legends.",
      });
    }
    if (
      decision.effectiveAllowLegends &&
      decision.classificationAuthority !== "verified"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["classificationAuthority"],
        message:
          "An enabled Legends decision requires verified classification authority.",
      });
    }
    if (
      decision.effectiveAllowLegends &&
      (
        decision.requestedPolicy === "exclude" ||
        decision.contextPermission === "disallowed"
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message:
          "A Legends exclusion or denial cannot resolve as allowed.",
      });
    }
    if (
      decision.playContextKind === "event" &&
      decision.effectiveAllowLegends &&
      (
        decision.contextPermission !== "allowed" ||
        (
          decision.evidence?.source !== "event-pack" &&
          decision.evidence?.source !== "organizer-ruling"
        )
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message:
          "An enabled event roster requires source-backed permission.",
      });
    }
  });
export type LegendsPolicyDecision = z.infer<
  typeof LegendsPolicyDecisionSchema
>;

export type ResolveLegendsPolicyInput = {
  legendsPolicy?: LegendsPolicy;
  /** Compatibility input for callers that predate `legendsPolicy`. */
  legacyAllowLegends?: boolean;
  playContext?: LegendsPlayContext;
  prompt?: string;
  classificationAuthority?: LegendsClassificationAuthority;
};

/**
 * Extract only explicit roster instructions. Questions such as "are Legends
 * allowed?" intentionally remain silent so they cannot opt a roster in.
 */
export function detectLegendsPromptIntent(
  prompt?: string,
): LegendsPromptIntent {
  if (!prompt) return "silent";
  const directiveText = prompt
    .replace(
      /\b(?:can|could|may|should|would)\s+(?:i|we|you)\b[^.!?]*\b(?:include|allow|use|take|bring|add)\b[^.!?]*\blegends?\b[^.!?]*(?:\?|$)/gi,
      " ",
    )
    .replace(
      /\b(?:are|is)\b[^.!?]*\blegends?\b[^.!?]*(?:\?|$)/gi,
      " ",
    )
    .replace(
      /\b(?:do|does|did)\s+(?!not\b)[^.!?]*\b(?:allow|permit|include|use)\b[^.!?]*\blegends?\b[^.!?]*(?:\?|$)/gi,
      " ",
    )
    .replace(
      /\bwhat\s+about\b[^.!?]*\blegends?\b[^.!?]*(?:\?|$)/gi,
      " ",
    );
  const negatedInstruction =
    /\b(?:(?:do\s+not|don't|dont|never|must\s+not)\s+(?:(?:want|plan|intend)\s+to\s+)?(?:include|allow|use|take|bring|add)|(?:i|we)\s+(?:do\s+not|don't|dont)\s+(?:want|plan|intend)\s+to\s+(?:include|allow|use|take|bring|add))\s+(?:the\s+)?legends?(?:\s+units?)?\b/i;
  const positivePrompt = directiveText.replace(
    new RegExp(negatedInstruction.source, "gi"),
    " ",
  );
  const positive =
    /(?:^|[.!;:]\s*)(?:please\s+)?(?:include|allow|use|take|bring|add)\s+(?:the\s+)?legends?(?:\s+units?)?\b/i.test(
      positivePrompt,
    ) ||
    /\b(?:i|we)\s+(?:want|would\s+like|plan|intend)\s+to\s+(?:include|allow|use|take|bring|add)\s+(?:the\s+)?legends?(?:\s+units?)?\b/i.test(
      positivePrompt,
    ) ||
    /\b(?:and|then)\s+(?:please\s+)?(?:include|allow|use|take|bring|add)\s+(?:the\s+)?legends?(?:\s+units?)?\b/i.test(
      positivePrompt,
    ) ||
    /\bwith\s+(?:the\s+)?legends?(?:\s+units?)?\b/i.test(
      positivePrompt,
    );
  const negative =
    negatedInstruction.test(directiveText) ||
    /\b(?:no|without|exclude|excluding|disallow|avoid|ban)\s+(?:the\s+)?legends?(?:\s+units?)?\b/i.test(
      directiveText,
    ) ||
    /\blegends?(?:\s+units?)?\s+(?:are\s+)?(?:banned|excluded|not\s+allowed)\b/i.test(
      directiveText,
    );
  if (positive && negative) return "conflict";
  if (positive) return "allow";
  if (negative) return "exclude";
  return "silent";
}

function contextPermission(
  context: LegendsPlayContext,
): LegendsPermission {
  if (
    context.kind === "open-play" ||
    context.kind === "casual" ||
    context.kind === "narrative"
  ) {
    return "allowed";
  }
  if (context.kind === "event") {
    const hasRulingEvidence =
      context.evidence?.source === "event-pack" ||
      context.evidence?.source === "organizer-ruling";
    return hasRulingEvidence ? context.legendsPermission : "unknown";
  }
  return "unknown";
}

function contextEvidence(
  context: LegendsPlayContext,
): LegendsPolicyEvidence | undefined {
  return context.kind === "event" ? context.evidence : undefined;
}

/**
 * Resolve Legends permission without I/O. Callers must pass event findings and
 * the classification authority from the same leased data bundle as the build.
 */
export function resolveLegendsPolicy(
  input: ResolveLegendsPolicyInput,
): LegendsPolicyDecision {
  const promptIntent = detectLegendsPromptIntent(input.prompt);
  const playContext = input.playContext ?? { kind: "unspecified" as const };
  const permission = contextPermission(playContext);
  const classificationAuthority =
    input.classificationAuthority ?? "unknown";
  const evidence = contextEvidence(playContext);
  const structuredAliasConflict =
    input.legendsPolicy !== undefined &&
    input.legendsPolicy !== "auto" &&
    input.legacyAllowLegends !== undefined &&
    (input.legendsPolicy === "allow") !== input.legacyAllowLegends;

  let requestedPolicy: LegendsPolicy;
  let source: LegendsPolicyDecision["source"];
  if (
    input.legendsPolicy !== undefined &&
    input.legendsPolicy !== "auto"
  ) {
    requestedPolicy = input.legendsPolicy;
    source = "structured-policy";
  } else if (input.legacyAllowLegends !== undefined) {
    requestedPolicy = input.legacyAllowLegends ? "allow" : "exclude";
    source = "legacy-allow-legends";
  } else if (promptIntent === "allow" || promptIntent === "exclude") {
    requestedPolicy = promptIntent;
    source = "prompt";
  } else if (promptIntent === "conflict") {
    requestedPolicy = "auto";
    source = "prompt";
  } else if (input.legendsPolicy === "auto") {
    requestedPolicy = "auto";
    source = "structured-policy";
  } else {
    requestedPolicy = "auto";
    source = playContext.kind === "unspecified" ? "default" : "play-context";
  }

  const decision = (
    resolution: LegendsPolicyDecision["resolution"],
    effectiveAllowLegends: boolean,
    reason: string,
  ): LegendsPolicyDecision => ({
    requestedPolicy,
    promptIntent,
    contextPermission: permission,
    effectiveAllowLegends,
    resolution,
    source,
    reason,
    classificationAuthority,
    playContextKind: playContext.kind,
    ...(playContext.kind === "event"
      ? { eventName: playContext.eventName }
      : {}),
    ...(evidence ? { evidence } : {}),
  });

  if (promptIntent === "conflict") {
    return decision(
      "blocked",
      false,
      "The prompt both includes and excludes Legends units.",
    );
  }
  if (
    (
      promptIntent === "allow" &&
      requestedPolicy === "exclude"
    ) ||
    (
      promptIntent === "exclude" &&
      requestedPolicy === "allow"
    )
  ) {
    return decision(
      "blocked",
      false,
      "The structured Legends policy conflicts with the roster prompt.",
    );
  }
  if (structuredAliasConflict) {
    return decision(
      "blocked",
      false,
      "legendsPolicy and the legacy allowLegends field disagree.",
    );
  }
  if (
    playContext.kind === "event" &&
    permission === "unknown" &&
    requestedPolicy === "allow"
  ) {
    return decision(
      "excluded",
      false,
      `${playContext.eventName} has no source-backed Legends ruling, so an explicit opt-in cannot be applied to this event roster.`,
    );
  }
  if (
    playContext.kind === "event" &&
    permission === "disallowed" &&
    requestedPolicy === "allow"
  ) {
    return decision(
      "blocked",
      false,
      `${playContext.eventName} is recorded as disallowing Legends units.`,
    );
  }
  if (requestedPolicy === "exclude" || permission === "disallowed") {
    return decision(
      "excluded",
      false,
      requestedPolicy === "exclude"
        ? "Legends units were explicitly excluded."
        : `${playContext.kind === "event" ? playContext.eventName : "This play context"} disallows Legends units.`,
    );
  }

  const contextAllows = permission === "allowed";
  const policyAllows = requestedPolicy === "allow" || contextAllows;
  if (!policyAllows) {
    return decision(
      "excluded",
      false,
      playContext.kind === "event"
        ? `${playContext.eventName} has no verified Legends ruling, so Legends units are excluded.`
        : "Legends permission is unknown, so Legends units are excluded.",
    );
  }
  if (classificationAuthority !== "verified") {
    return decision(
      "excluded",
      false,
      "The active data bundle does not contain verified official Legends classification evidence.",
    );
  }
  return decision(
    "allowed",
    true,
    requestedPolicy === "allow"
      ? "Legends units were explicitly allowed."
      : `Legends units are allowed for ${playContext.kind} play.`,
  );
}
