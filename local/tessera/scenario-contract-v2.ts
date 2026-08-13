import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  TesseraDirection,
  TesseraMetric,
  TesseraPhase,
} from "../../lib/rosterpilot";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  canonicalTesseraScenarioContract,
  TESSERA_SCENARIO_DIRECTIONS,
  TESSERA_SCENARIO_METRICS,
  TESSERA_SCENARIO_PHASES,
} from "./scenario-contract";

export const TESSERA_SCENARIO_POLICY_CONTRACT_V2_KIND =
  "tessera-scenario-policy-contract" as const;
export const TESSERA_SCENARIO_POLICY_CONTRACT_V2_SCHEMA_VERSION = 2;
export const TESSERA_MAX_ATTACHMENT_PLANS_DEFAULT = 16;
export const TESSERA_MAX_JOINT_VARIANTS_DEFAULT = 64;

export const TESSERA_ENGAGEMENT_STATES = [
  false,
  true,
  "unknown",
] as const;

const safePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "Expected a safe integer");

const safeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Expected a safe integer");

const stableIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value.trim() === value,
    "Identifiers must not have leading or trailing whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "Identifiers must not contain control characters",
  );

const EngagementStateSchema = z.union([
  z.boolean(),
  z.literal("unknown"),
]);

const DistanceInchesSchema = z.union([
  z.number().finite().nonnegative(),
  z.literal("unknown"),
]);

const TimingSchema = z.union([
  z.literal("unknown"),
  stableIdSchema,
]);

export const TesseraEngagementContextV2Schema = z.object({
  targetInCover: EngagementStateSchema,
  charging: EngagementStateSchema,
  withinRapidFireRange: EngagementStateSchema,
  withinMeltaRange: EngagementStateSchema,
  remainedStationary: EngagementStateSchema,
  indirectFire: EngagementStateSchema,
  distanceInches: DistanceInchesSchema,
  timing: TimingSchema,
  objectiveControl: EngagementStateSchema,
  armyAbilityActive: EngagementStateSchema,
  targetCondition: EngagementStateSchema,
  belowStrength: EngagementStateSchema,
  damaged: EngagementStateSchema,
}).strict();

const TesseraScenarioEntryV2Schema = z.object({
  phase: z.enum(TESSERA_SCENARIO_PHASES),
  direction: z.enum(TESSERA_SCENARIO_DIRECTIONS),
  metric: z.enum(TESSERA_SCENARIO_METRICS),
  engagement: TesseraEngagementContextV2Schema,
  iterations: safePositiveIntegerSchema,
}).strict();

const ActivationOptionSchema = z.object({
  id: stableIdSchema,
  groupId: stableIdSchema.nullable().default(null),
  resourceCost: safeNonnegativeIntegerSchema.default(0),
}).strict();

const ActivationGroupSchema = z.object({
  id: stableIdSchema,
  maximumActive: safePositiveIntegerSchema,
}).strict();

const activationPolicyBase = {
  options: z.array(ActivationOptionSchema).default([]),
  groups: z.array(ActivationGroupSchema).default([]),
  resourceBudget: safeNonnegativeIntegerSchema.nullable().default(null),
};

const SelectedActivationPolicySchema = z.object({
  mode: z.literal("selected"),
  ...activationPolicyBase,
  selectedIds: z.array(stableIdSchema).default([]),
}).strict();

const EnvelopeActivationPolicySchema = z.object({
  mode: z.literal("envelope"),
  ...activationPolicyBase,
  includeNoOptionsBaseline: z.literal(true).default(true),
}).strict();

const TesseraActivationPolicyV2Schema = z
  .discriminatedUnion("mode", [
    SelectedActivationPolicySchema,
    EnvelopeActivationPolicySchema,
  ])
  .superRefine((policy, context) => {
    const optionIds = policy.options.map((option) => option.id);
    const groupIds = policy.groups.map((group) => group.id);
    addDuplicateIssues(
      context,
      optionIds,
      "activation option",
      ["options"],
    );
    addDuplicateIssues(
      context,
      groupIds,
      "activation group",
      ["groups"],
    );

    const optionIdSet = new Set(optionIds);
    const groupsById = new Map(
      policy.groups.map((group) => [group.id, group]),
    );
    for (const option of policy.options) {
      if (option.groupId !== null && !groupsById.has(option.groupId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Activation ${JSON.stringify(option.id)} references unknown group ${JSON.stringify(option.groupId)}.`,
          path: ["options", optionIds.indexOf(option.id), "groupId"],
        });
      }
    }

    for (const [groupIndex, group] of policy.groups.entries()) {
      const memberCount = policy.options.filter(
        (option) => option.groupId === group.id,
      ).length;
      if (memberCount === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Activation group ${JSON.stringify(group.id)} has no options.`,
          path: ["groups", groupIndex],
        });
      } else if (group.maximumActive > memberCount) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Activation group ${JSON.stringify(group.id)} allows more active options than it contains.`,
          path: ["groups", groupIndex, "maximumActive"],
        });
      }
    }

    if (policy.mode !== "selected") return;
    addDuplicateIssues(
      context,
      policy.selectedIds,
      "selected activation",
      ["selectedIds"],
    );
    for (const [selectedIndex, selectedId] of policy.selectedIds.entries()) {
      if (!optionIdSet.has(selectedId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Selected activation ${JSON.stringify(selectedId)} is not declared in options.`,
          path: ["selectedIds", selectedIndex],
        });
      }
    }

    const selectedIdSet = new Set(policy.selectedIds);
    for (const [groupIndex, group] of policy.groups.entries()) {
      const selectedCount = policy.options.filter(
        (option) =>
          option.groupId === group.id && selectedIdSet.has(option.id),
      ).length;
      if (selectedCount > group.maximumActive) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Selected activations exceed the ${group.maximumActive} option limit for group ${JSON.stringify(group.id)}.`,
          path: ["groups", groupIndex],
        });
      }
    }

    if (policy.resourceBudget !== null) {
      const selectedCost = policy.options
        .filter((option) => selectedIdSet.has(option.id))
        .reduce((sum, option) => sum + option.resourceCost, 0);
      if (selectedCost > policy.resourceBudget) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Selected activations cost ${selectedCost}, exceeding the resource budget of ${policy.resourceBudget}.`,
          path: ["resourceBudget"],
        });
      }
    }
  });

const AttachmentBindingSchema = z.object({
  leaderSelectionId: stableIdSchema,
  bodyguardSelectionId: stableIdSchema,
  supportingSelectionIds: z.array(stableIdSchema).default([]),
}).strict().superRefine((binding, context) => {
  if (binding.leaderSelectionId === binding.bodyguardSelectionId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A leader cannot be attached to itself.",
      path: ["bodyguardSelectionId"],
    });
  }
  addDuplicateIssues(
    context,
    binding.supportingSelectionIds,
    "supporting selection",
    ["supportingSelectionIds"],
  );
  for (
    let supportIndex = 0;
    supportIndex < binding.supportingSelectionIds.length;
    supportIndex += 1
  ) {
    const supportId = binding.supportingSelectionIds[supportIndex];
    if (
      supportId === binding.leaderSelectionId ||
      supportId === binding.bodyguardSelectionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A supporting selection must be distinct from the leader and bodyguard.",
        path: ["supportingSelectionIds", supportIndex],
      });
    }
  }
});

const TesseraAttachmentPolicyV2Schema = z.object({
  mode: z.enum(["selected", "enumerate"]),
  bindings: z.array(AttachmentBindingSchema).default([]),
}).strict().superRefine((policy, context) => {
  const bindingKeys = policy.bindings.map(attachmentBindingKey);
  addDuplicateIssues(
    context,
    bindingKeys,
    "attachment binding",
    ["bindings"],
  );

  const leaders = policy.bindings.map(
    (binding) => binding.leaderSelectionId,
  );
  addDuplicateIssues(
    context,
    leaders,
    "attached leader",
    ["bindings"],
  );
});

const TesseraCombatPolicyV2Schema = z.object({
  modelingMode: z.enum(["rules-aware", "base-profile"]),
  activations: TesseraActivationPolicyV2Schema,
  attachments: TesseraAttachmentPolicyV2Schema,
  limits: z.object({
    maxAttachmentPlans: z
      .number()
      .int()
      .min(1)
      .max(TESSERA_MAX_ATTACHMENT_PLANS_DEFAULT)
      .default(TESSERA_MAX_ATTACHMENT_PLANS_DEFAULT),
    maxJointVariants: z
      .number()
      .int()
      .min(1)
      .max(TESSERA_MAX_JOINT_VARIANTS_DEFAULT)
      .default(TESSERA_MAX_JOINT_VARIANTS_DEFAULT),
  }).strict(),
}).strict().superRefine((policy, context) => {
  if (
    policy.modelingMode === "base-profile" &&
    (
      policy.activations.options.length > 0 ||
      (
        policy.activations.mode === "selected" &&
        policy.activations.selectedIds.length > 0
      ) ||
      policy.attachments.bindings.length > 0
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Base-profile policy cannot declare optional activations or attachment bindings.",
    });
  }
});

export const TesseraScenarioPolicyContractV2Schema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal(TESSERA_SCENARIO_POLICY_CONTRACT_V2_KIND),
  scenarios: z.array(TesseraScenarioEntryV2Schema).min(1),
  policy: TesseraCombatPolicyV2Schema,
}).strict().superRefine((contract, context) => {
  const keys = contract.scenarios.map(scenarioKey);
  addDuplicateIssues(context, keys, "scenario tuple", ["scenarios"]);
});

export type TesseraEngagementState = z.infer<
  typeof EngagementStateSchema
>;
export type TesseraDistanceInches = z.infer<
  typeof DistanceInchesSchema
>;
export type TesseraTiming = "unknown" | string;
export type TesseraEngagementContextV2 = z.infer<
  typeof TesseraEngagementContextV2Schema
>;
export type TesseraScenarioEntryV2 = z.infer<
  typeof TesseraScenarioEntryV2Schema
>;
export type TesseraActivationPolicyV2 = z.infer<
  typeof TesseraActivationPolicyV2Schema
>;
export type TesseraAttachmentPolicyV2 = z.infer<
  typeof TesseraAttachmentPolicyV2Schema
>;
export type TesseraCombatPolicyV2 = z.infer<
  typeof TesseraCombatPolicyV2Schema
>;
export type TesseraScenarioPolicyContractV2 = z.infer<
  typeof TesseraScenarioPolicyContractV2Schema
>;

export class TesseraScenarioPolicyContractV2Error extends Error {
  readonly code = "TESSERA_SCENARIO_POLICY_CONTRACT_V2_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "TesseraScenarioPolicyContractV2Error";
  }
}

function addDuplicateIssues(
  context: z.RefinementCtx,
  values: readonly string[],
  label: string,
  pathPrefix: readonly (string | number)[] = [],
): void {
  const firstIndexByValue = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const firstIndex = firstIndexByValue.get(value);
    if (firstIndex !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Duplicate ${label} ${JSON.stringify(value)}; first declared at index ${firstIndex}.`,
        path: [...pathPrefix, index],
      });
    } else {
      firstIndexByValue.set(value, index);
    }
  }
}

function scenarioKey(
  scenario: Pick<
    TesseraScenarioEntryV2,
    "phase" | "direction" | "metric"
  >,
): string {
  return `${scenario.phase}:${scenario.direction}:${scenario.metric}`;
}

function attachmentBindingKey(
  binding: z.infer<typeof AttachmentBindingSchema>,
): string {
  return [
    binding.leaderSelectionId,
    binding.bodyguardSelectionId,
    [...binding.supportingSelectionIds].sort().join("\u0000"),
  ].join("\u0001");
}

function canonicalPolicy(
  policy: TesseraCombatPolicyV2,
): TesseraCombatPolicyV2 {
  const activations = policy.activations.mode === "selected"
    ? {
        ...policy.activations,
        options: [...policy.activations.options].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
        groups: [...policy.activations.groups].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
        selectedIds: [...policy.activations.selectedIds].sort(),
      }
    : {
        ...policy.activations,
        options: [...policy.activations.options].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
        groups: [...policy.activations.groups].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      };
  return {
    ...policy,
    activations,
    attachments: {
      ...policy.attachments,
      bindings: policy.attachments.bindings
        .map((binding) => ({
          ...binding,
          supportingSelectionIds: [
            ...binding.supportingSelectionIds,
          ].sort(),
        }))
        .sort((left, right) =>
          attachmentBindingKey(left).localeCompare(
            attachmentBindingKey(right),
          ),
        ),
    },
  };
}

export function canonicalTesseraScenarioPolicyContractV2(
  value: unknown,
): TesseraScenarioPolicyContractV2 {
  const parsed = TesseraScenarioPolicyContractV2Schema.safeParse(value);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const path = firstIssue?.path.length
      ? ` at ${firstIssue.path.join(".")}`
      : "";
    throw new TesseraScenarioPolicyContractV2Error(
      `The Tessera scenario/policy v2 contract is invalid${path}: ${firstIssue?.message ?? "schema validation failed"}.`,
    );
  }
  return {
    schemaVersion: 2,
    kind: TESSERA_SCENARIO_POLICY_CONTRACT_V2_KIND,
    scenarios: [...parsed.data.scenarios].sort((left, right) =>
      scenarioKey(left).localeCompare(scenarioKey(right)),
    ),
    policy: canonicalPolicy(parsed.data.policy),
  };
}

export function tesseraScenarioPolicyContractV2Sha256(
  value: unknown,
): string {
  const canonical = canonicalTesseraScenarioPolicyContractV2(value);
  return createHash("sha256")
    .update(canonicalJson(canonical))
    .digest("hex");
}

export function assertTesseraScenarioPolicyContractV2Scope(
  value: unknown,
  phases: readonly TesseraPhase[],
  metrics: readonly TesseraMetric[],
): TesseraScenarioPolicyContractV2 {
  const contract = canonicalTesseraScenarioPolicyContractV2(value);
  const expected = [...new Set(phases)].flatMap((phase) =>
    TESSERA_SCENARIO_DIRECTIONS.flatMap((direction) =>
      [...new Set(metrics)].map((metric) =>
        `${phase}:${direction}:${metric}`,
      ),
    ),
  ).sort();
  const observed = contract.scenarios.map(scenarioKey).sort();
  if (
    expected.length !== observed.length ||
    expected.some((entry, index) => entry !== observed[index])
  ) {
    throw new TesseraScenarioPolicyContractV2Error(
      `The Tessera scenario/policy v2 scope must contain exactly ${expected.join(", ")}; observed ${observed.join(", ")}.`,
    );
  }
  return contract;
}

export function localTesseraEngagementContextV2(
  phase: TesseraPhase,
): TesseraEngagementContextV2 {
  return {
    targetInCover: false,
    charging: phase === "fight",
    withinRapidFireRange: false,
    withinMeltaRange: false,
    remainedStationary: false,
    indirectFire: false,
    distanceInches: "unknown",
    timing: "unknown",
    objectiveControl: "unknown",
    armyAbilityActive: "unknown",
    targetCondition: "unknown",
    belowStrength: "unknown",
    damaged: "unknown",
  };
}

export function defaultTesseraCombatPolicyV2(): TesseraCombatPolicyV2 {
  return canonicalPolicy(TesseraCombatPolicyV2Schema.parse({
    modelingMode: "rules-aware",
    activations: {
      mode: "envelope",
      includeNoOptionsBaseline: true,
    },
    attachments: {
      mode: "enumerate",
    },
    limits: {},
  }));
}

/** Explicit no-option, unattached baseline used when scalar execution is requested. */
export function selectedBaselineTesseraCombatPolicyV2(): TesseraCombatPolicyV2 {
  return canonicalPolicy(TesseraCombatPolicyV2Schema.parse({
    modelingMode: "rules-aware",
    activations: {
      mode: "selected",
      options: [],
      groups: [],
      resourceBudget: 0,
      selectedIds: [],
    },
    attachments: {
      mode: "selected",
      bindings: [],
    },
    limits: {},
  }));
}

/**
 * Exact point-blank baseline used by fresh selected-state local executions.
 * Keeping the engagement and choice policy in one constructor prevents the
 * v2 rules compiler from seeing different half-range state than scenario v3.
 */
export function selectedBaselineTesseraScenarioPolicyContractV2(
  iterations: number,
  phases: readonly TesseraPhase[] = TESSERA_SCENARIO_PHASES,
  metrics: readonly TesseraMetric[] = TESSERA_SCENARIO_METRICS,
): TesseraScenarioPolicyContractV2 {
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new TesseraScenarioPolicyContractV2Error(
      "Tessera iterations must be a positive safe integer.",
    );
  }
  return canonicalTesseraScenarioPolicyContractV2({
    schemaVersion: 2,
    kind: TESSERA_SCENARIO_POLICY_CONTRACT_V2_KIND,
    scenarios: [...new Set(phases)].flatMap((phase) =>
      TESSERA_SCENARIO_DIRECTIONS.flatMap((direction) =>
        [...new Set(metrics)].map((metric) => ({
          phase,
          direction,
          metric,
          engagement: {
            ...localTesseraEngagementContextV2(phase),
            withinRapidFireRange: true,
            withinMeltaRange: true,
            distanceInches: 0,
            timing: "baseline-no-options",
            objectiveControl: false,
            armyAbilityActive: false,
            targetCondition: false,
            belowStrength: false,
            damaged: false,
          },
          iterations,
        })),
      ),
    ),
    policy: selectedBaselineTesseraCombatPolicyV2(),
  });
}

export function selectedAbilitiesTesseraScenarioPolicyContractV2(
  iterations: number,
  abilityIds: readonly string[],
  phases: readonly TesseraPhase[] = TESSERA_SCENARIO_PHASES,
  metrics: readonly TesseraMetric[] = TESSERA_SCENARIO_METRICS,
  resolvedActivationIds?: readonly string[],
): TesseraScenarioPolicyContractV2 {
  const baseline = selectedBaselineTesseraScenarioPolicyContractV2(
    iterations,
    phases,
    metrics,
  );
  const activationIds = resolvedActivationIds
    ? [...new Set(resolvedActivationIds)]
    : [...new Set(abilityIds)].flatMap((abilityId) =>
      (["attacker", "target"] as const).map((perspective) =>
        `${perspective}:${abilityId}:${abilityId}`
      )
    );
  const options = activationIds.map((id) => ({
      id,
      groupId: null,
      resourceCost: 0,
    }));
  return canonicalTesseraScenarioPolicyContractV2({
    ...baseline,
    scenarios: baseline.scenarios.map((scenario) => ({
      ...scenario,
      engagement: {
        ...scenario.engagement,
        timing: "selected-abilities",
        armyAbilityActive: true,
      },
    })),
    policy: {
      ...baseline.policy,
      activations: {
        mode: "selected",
        options,
        groups: [],
        resourceBudget: 0,
        selectedIds: options.map((option) => option.id),
      },
    },
  });
}

export function activationEnvelopeTesseraScenarioPolicyContractV2(
  iterations: number,
  phases: readonly TesseraPhase[] = TESSERA_SCENARIO_PHASES,
  metrics: readonly TesseraMetric[] = TESSERA_SCENARIO_METRICS,
): TesseraScenarioPolicyContractV2 {
  const baseline = selectedBaselineTesseraScenarioPolicyContractV2(
    iterations,
    phases,
    metrics,
  );
  return canonicalTesseraScenarioPolicyContractV2({
    ...baseline,
    scenarios: baseline.scenarios.map((scenario) => ({
      ...scenario,
      engagement: {
        ...scenario.engagement,
        timing: "activation-envelope",
        armyAbilityActive: "unknown",
      },
    })),
    policy: {
      ...baseline.policy,
      activations: {
        mode: "envelope",
        options: [],
        groups: [],
        resourceBudget: null,
        includeNoOptionsBaseline: true,
      },
    },
  });
}

export function localTesseraScenarioPolicyContractV2(
  iterations: number,
  phases: readonly TesseraPhase[] = TESSERA_SCENARIO_PHASES,
  metrics: readonly TesseraMetric[] = TESSERA_SCENARIO_METRICS,
  policy: TesseraCombatPolicyV2 = defaultTesseraCombatPolicyV2(),
): TesseraScenarioPolicyContractV2 {
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new TesseraScenarioPolicyContractV2Error(
      "Tessera iterations must be a positive safe integer.",
    );
  }
  return canonicalTesseraScenarioPolicyContractV2({
    schemaVersion: 2,
    kind: TESSERA_SCENARIO_POLICY_CONTRACT_V2_KIND,
    scenarios: [...new Set(phases)].flatMap((phase) =>
      TESSERA_SCENARIO_DIRECTIONS.flatMap((direction) =>
        [...new Set(metrics)].map((metric) => ({
          phase,
          direction,
          metric,
          engagement: localTesseraEngagementContextV2(phase),
          iterations,
        })),
      ),
    ),
    policy,
  });
}

const V1_METADATA_SETTING_KEYS = new Set([
  "provider",
  "phase",
  "metric",
  "direction",
  "iterations",
  "iteration",
  "simulations",
  "simulation",
  "trials",
  "runs",
]);

const V1_ENGAGEMENT_SETTING_KEYS = new Set([
  "targetInCover",
  "charging",
  "withinRapidFireRange",
  "withinMeltaRange",
  "remainedStationary",
  "indirectFire",
  "distanceInches",
  "timing",
  "objectiveControl",
  "armyAbilityActive",
  "targetCondition",
  "belowStrength",
  "damaged",
]);

function v1BooleanSetting(
  settings: Readonly<Record<string, string>>,
  key: keyof TesseraEngagementContextV2,
  fallback: boolean,
): boolean {
  const value = settings[key];
  if (value === undefined) return fallback;
  const normalized = value.trim().toLocaleLowerCase();
  if (["true", "yes", "on", "1", "enabled"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off", "0", "disabled", "none"].includes(normalized)) {
    return false;
  }
  throw new TesseraScenarioPolicyContractV2Error(
    `V1 setting ${key}=${JSON.stringify(value)} is not a recognized boolean.`,
  );
}

function v1TriStateSetting(
  settings: Readonly<Record<string, string>>,
  key:
    | "objectiveControl"
    | "armyAbilityActive"
    | "targetCondition"
    | "belowStrength"
    | "damaged",
): TesseraEngagementState {
  const value = settings[key];
  if (value === undefined || value.trim().toLocaleLowerCase() === "unknown") {
    return "unknown";
  }
  return v1BooleanSetting(settings, key, false);
}

function v1DistanceInches(
  settings: Readonly<Record<string, string>>,
): TesseraDistanceInches {
  const value = settings.distanceInches;
  if (value === undefined || value.trim().toLocaleLowerCase() === "unknown") {
    return "unknown";
  }
  if (value.trim() !== value) {
    throw new TesseraScenarioPolicyContractV2Error(
      "V1 distanceInches must not have leading or trailing whitespace.",
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TesseraScenarioPolicyContractV2Error(
      `V1 distanceInches=${JSON.stringify(value)} must be a nonnegative finite number or unknown.`,
    );
  }
  return parsed;
}

function v1Timing(
  settings: Readonly<Record<string, string>>,
): TesseraTiming {
  const value = settings.timing;
  if (value === undefined || value === "unknown") return "unknown";
  const parsed = stableIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new TesseraScenarioPolicyContractV2Error(
      `V1 timing=${JSON.stringify(value)} is not a valid timing identifier.`,
    );
  }
  return parsed.data;
}

function migrateV1Engagement(
  phase: TesseraPhase,
  settings: Readonly<Record<string, string>>,
): TesseraEngagementContextV2 {
  const unknownSettings = Object.keys(settings).filter(
    (key) =>
      !V1_METADATA_SETTING_KEYS.has(key) &&
      !V1_ENGAGEMENT_SETTING_KEYS.has(key),
  );
  if (unknownSettings.length > 0) {
    throw new TesseraScenarioPolicyContractV2Error(
      `V1 settings cannot be migrated without semantic loss: ${unknownSettings.join(", ")}.`,
    );
  }
  if (settings.phase !== undefined && settings.phase !== phase) {
    throw new TesseraScenarioPolicyContractV2Error(
      `V1 phase setting ${JSON.stringify(settings.phase)} does not match ${phase}.`,
    );
  }
  const defaults = localTesseraEngagementContextV2(phase);
  return {
    targetInCover: v1BooleanSetting(
      settings,
      "targetInCover",
      defaults.targetInCover as boolean,
    ),
    charging: v1BooleanSetting(
      settings,
      "charging",
      defaults.charging as boolean,
    ),
    withinRapidFireRange: v1BooleanSetting(
      settings,
      "withinRapidFireRange",
      defaults.withinRapidFireRange as boolean,
    ),
    withinMeltaRange: v1BooleanSetting(
      settings,
      "withinMeltaRange",
      defaults.withinMeltaRange as boolean,
    ),
    remainedStationary: v1BooleanSetting(
      settings,
      "remainedStationary",
      defaults.remainedStationary as boolean,
    ),
    indirectFire: v1BooleanSetting(
      settings,
      "indirectFire",
      defaults.indirectFire as boolean,
    ),
    distanceInches: v1DistanceInches(settings),
    timing: v1Timing(settings),
    objectiveControl: v1TriStateSetting(settings, "objectiveControl"),
    armyAbilityActive: v1TriStateSetting(
      settings,
      "armyAbilityActive",
    ),
    targetCondition: v1TriStateSetting(settings, "targetCondition"),
    belowStrength: v1TriStateSetting(settings, "belowStrength"),
    damaged: v1TriStateSetting(settings, "damaged"),
  };
}

export function migrateTesseraScenarioContractV1ToV2(
  value: unknown,
): TesseraScenarioPolicyContractV2 {
  let legacy;
  try {
    legacy = canonicalTesseraScenarioContract(value);
  } catch (error) {
    throw new TesseraScenarioPolicyContractV2Error(
      `The v1 Tessera scenario contract cannot be migrated: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return canonicalTesseraScenarioPolicyContractV2({
    schemaVersion: 2,
    kind: TESSERA_SCENARIO_POLICY_CONTRACT_V2_KIND,
    scenarios: legacy.map((scenario) => ({
      phase: scenario.phase,
      direction: scenario.direction,
      metric: scenario.metric,
      engagement: migrateV1Engagement(
        scenario.phase,
        scenario.settings,
      ),
      iterations: scenario.iterations,
    })),
    policy: {
      modelingMode: "base-profile",
      activations: {
        mode: "selected",
        options: [],
        groups: [],
        resourceBudget: null,
        selectedIds: [],
      },
      attachments: {
        mode: "selected",
        bindings: [],
      },
      limits: {
        maxAttachmentPlans: TESSERA_MAX_ATTACHMENT_PLANS_DEFAULT,
        maxJointVariants: TESSERA_MAX_JOINT_VARIANTS_DEFAULT,
      },
    },
  });
}

export function tesseraScenarioPolicyContractV2Scope(
  contract: TesseraScenarioPolicyContractV2,
): {
  phases: TesseraPhase[];
  directions: TesseraDirection[];
  metrics: TesseraMetric[];
} {
  const canonical = canonicalTesseraScenarioPolicyContractV2(contract);
  return {
    phases: [...new Set(canonical.scenarios.map((entry) => entry.phase))]
      .sort(),
    directions: [
      ...new Set(canonical.scenarios.map((entry) => entry.direction)),
    ].sort(),
    metrics: [...new Set(canonical.scenarios.map((entry) => entry.metric))]
      .sort(),
  };
}
