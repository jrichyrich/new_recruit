import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  TesseraDirection,
  TesseraMetric,
  TesseraPhase,
} from "../../lib/rosterpilot";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  TESSERA_SCENARIO_DIRECTIONS,
  TESSERA_SCENARIO_METRICS,
  TESSERA_SCENARIO_PHASES,
} from "./scenario-contract";
import {
  canonicalTesseraScenarioPolicyContractV2,
  migrateTesseraScenarioContractV1ToV2,
  TESSERA_MAX_ATTACHMENT_PLANS_DEFAULT,
  TESSERA_MAX_JOINT_VARIANTS_DEFAULT,
  type TesseraEngagementState,
  type TesseraScenarioEntryV2,
  type TesseraScenarioPolicyContractV2,
} from "./scenario-contract-v2";

export const TESSERA_SCENARIO_POLICY_CONTRACT_V3_KIND =
  "tessera-scenario-policy-contract" as const;
export const TESSERA_SCENARIO_POLICY_CONTRACT_V3_SCHEMA_VERSION = 3;

export const TESSERA_SCENARIO_SIDES = [
  "player",
  "opponent",
] as const;

/**
 * Stable semantic keys understood by the v3 scenario contract. Concrete side,
 * selection, resource, and ability identifiers are bindings, not new keys.
 */
export const TESSERA_SCENARIO_V3_STATE_KEYS = [
  "battleRound",
  "timing",
  "side.resources.commandPoints",
  "side.resources.factionResources.*.amount",
  "side.armyAbilities.*.active",
  "side.oncePerBattle.*.available",
  "unit.movement",
  "unit.chargedThisTurn",
  "unit.wasChargedThisTurn",
  "unit.inCover",
  "unit.onObjective",
  "unit.controlsObjective",
  "unit.strength",
  "unit.damage",
  "unit.battleShocked",
  "unit.eligibleToFight",
  "unit.hasFought",
  "pair.distanceInches",
  "pair.withinRange",
  "pair.withinRapidFireRange",
  "pair.withinMeltaRange",
  "pair.withinConversionRange",
  "pair.targetVisible",
  "pair.indirectFire",
  "pair.targetCondition",
] as const;

const LEGACY_V2_ARMY_ABILITY_ID = "legacy-v2-army-ability";

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

const SideSchema = z.enum(TESSERA_SCENARIO_SIDES);
const StateBooleanSchema = z.union([z.boolean(), z.literal("unknown")]);
const StateCountSchema = z.union([
  safeNonnegativeIntegerSchema,
  z.literal("unknown"),
]);
const DistanceInchesSchema = z.union([
  z.number().finite().nonnegative(),
  z.literal("unknown"),
]);
const TimingSchema = z.union([z.literal("unknown"), stableIdSchema]);
const BattleRoundSchema = z.union([
  z.number().int().min(1).max(5),
  z.literal("unknown"),
]);

const MovementStateSchema = z.enum([
  "stationary",
  "moved",
  "normal-move",
  "advanced",
  "fell-back",
  "unknown",
]);
const StrengthStateSchema = z.enum([
  "starting",
  "below-starting",
  "below-half",
  "unknown",
]);
const DamageStateSchema = z.enum([
  "healthy",
  "damaged",
  "unknown",
]);

const FactionResourceStateSchema = z.object({
  id: stableIdSchema,
  amount: StateCountSchema,
}).strict();

const ArmyAbilityStateSchema = z.object({
  id: stableIdSchema,
  active: StateBooleanSchema,
}).strict();

const OncePerBattleStateSchema = z.object({
  id: stableIdSchema,
  available: StateBooleanSchema,
}).strict();

const SideResourcesSchema = z.object({
  commandPoints: StateCountSchema,
  factionResources: z.array(FactionResourceStateSchema).default([]),
}).strict().superRefine((resources, context) => {
  addDuplicateIssues(
    context,
    resources.factionResources.map((entry) => entry.id),
    "faction resource",
    ["factionResources"],
  );
});

export const TesseraUnitPhysicalStateV3Schema = z.object({
  selectionId: stableIdSchema,
  movement: MovementStateSchema,
  chargedThisTurn: StateBooleanSchema,
  wasChargedThisTurn: StateBooleanSchema,
  inCover: StateBooleanSchema,
  onObjective: StateBooleanSchema,
  controlsObjective: StateBooleanSchema,
  strength: StrengthStateSchema,
  damage: DamageStateSchema,
  battleShocked: StateBooleanSchema,
  eligibleToFight: StateBooleanSchema,
  hasFought: StateBooleanSchema,
}).strict();

export const TesseraSidePhysicalStateV3Schema = z.object({
  resources: SideResourcesSchema,
  armyAbilities: z.array(ArmyAbilityStateSchema).default([]),
  oncePerBattle: z.array(OncePerBattleStateSchema).default([]),
  units: z.array(TesseraUnitPhysicalStateV3Schema).min(1),
}).strict().superRefine((side, context) => {
  addDuplicateIssues(
    context,
    side.armyAbilities.map((entry) => entry.id),
    "army ability",
    ["armyAbilities"],
  );
  addDuplicateIssues(
    context,
    side.oncePerBattle.map((entry) => entry.id),
    "once-per-battle ability",
    ["oncePerBattle"],
  );
  addDuplicateIssues(
    context,
    side.units.map((entry) => entry.selectionId),
    "unit selection",
    ["units"],
  );
});

export const TesseraPairPhysicalStateV3Schema = z.object({
  attackerSide: SideSchema,
  attackerSelectionId: stableIdSchema,
  targetSide: SideSchema,
  targetSelectionId: stableIdSchema,
  distanceInches: DistanceInchesSchema,
  withinRange: StateBooleanSchema,
  withinRapidFireRange: StateBooleanSchema,
  withinMeltaRange: StateBooleanSchema,
  withinConversionRange: StateBooleanSchema,
  targetVisible: StateBooleanSchema,
  indirectFire: StateBooleanSchema,
  targetCondition: StateBooleanSchema,
}).strict().superRefine((pair, context) => {
  if (pair.attackerSide === pair.targetSide) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A combat pair must cross the physical player/opponent sides.",
      path: ["targetSide"],
    });
  }
});

export const TesseraScenarioPhysicalStateV3Schema = z.object({
  battleRound: BattleRoundSchema,
  timing: TimingSchema,
  player: TesseraSidePhysicalStateV3Schema,
  opponent: TesseraSidePhysicalStateV3Schema,
  pairs: z.array(TesseraPairPhysicalStateV3Schema).min(1),
}).strict();

const TesseraScenarioEntryV3Schema = z.object({
  phase: z.enum(TESSERA_SCENARIO_PHASES),
  direction: z.enum(TESSERA_SCENARIO_DIRECTIONS),
  metric: z.enum(TESSERA_SCENARIO_METRICS),
  state: TesseraScenarioPhysicalStateV3Schema,
  iterations: safePositiveIntegerSchema,
}).strict().superRefine((scenario, context) => {
  const expectedAttacker = attackerSide(scenario.direction);
  const expectedTarget = otherSide(expectedAttacker);
  const playerIds = new Set(
    scenario.state.player.units.map((unit) => unit.selectionId),
  );
  const opponentIds = new Set(
    scenario.state.opponent.units.map((unit) => unit.selectionId),
  );
  const idsBySide = { player: playerIds, opponent: opponentIds };
  const keys = scenario.state.pairs.map(pairKey);
  addDuplicateIssues(context, keys, "combat pair", ["state", "pairs"]);

  for (const [pairIndex, pair] of scenario.state.pairs.entries()) {
    if (
      pair.attackerSide !== expectedAttacker ||
      pair.targetSide !== expectedTarget
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Pair ownership must follow direction ${scenario.direction}: ${expectedAttacker} attacks ${expectedTarget}.`,
        path: ["state", "pairs", pairIndex],
      });
    }
    if (!idsBySide[pair.attackerSide].has(pair.attackerSelectionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Pair attacker ${JSON.stringify(pair.attackerSelectionId)} is not declared on the ${pair.attackerSide} side.`,
        path: ["state", "pairs", pairIndex, "attackerSelectionId"],
      });
    }
    if (!idsBySide[pair.targetSide].has(pair.targetSelectionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Pair target ${JSON.stringify(pair.targetSelectionId)} is not declared on the ${pair.targetSide} side.`,
        path: ["state", "pairs", pairIndex, "targetSelectionId"],
      });
    }
  }

  const expectedPairs = [...idsBySide[expectedAttacker]].flatMap(
    (attackerSelectionId) =>
      [...idsBySide[expectedTarget]].map((targetSelectionId) =>
        pairKey({
          attackerSide: expectedAttacker,
          attackerSelectionId,
          targetSide: expectedTarget,
          targetSelectionId,
        }),
      ),
  ).sort();
  const observedPairs = [...keys].sort();
  if (!arraysEqual(expectedPairs, observedPairs)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Scenario pairs must contain exactly one entry for every attacker/target selection pair in the physical side state.",
      path: ["state", "pairs"],
    });
  }
});

const CommandPointCostSchema = z.object({
  kind: z.literal("command-points"),
  amount: safePositiveIntegerSchema,
}).strict();

const FactionResourceCostSchema = z.object({
  kind: z.literal("faction-resource"),
  resourceId: stableIdSchema,
  amount: safePositiveIntegerSchema,
}).strict();

const ActivationCostSchema = z.discriminatedUnion("kind", [
  CommandPointCostSchema,
  FactionResourceCostSchema,
]);

const UNIT_STATE_FIELDS = [
  "movement",
  "chargedThisTurn",
  "wasChargedThisTurn",
  "inCover",
  "onObjective",
  "controlsObjective",
  "strength",
  "damage",
  "battleShocked",
  "eligibleToFight",
  "hasFought",
] as const;

const UnitStateExpectedSchema = z.union([
  z.boolean(),
  MovementStateSchema.exclude(["unknown"]),
  StrengthStateSchema.exclude(["unknown"]),
  DamageStateSchema.exclude(["unknown"]),
]);

const UnitStatePrerequisiteSchema = z.object({
  kind: z.literal("unit-state"),
  side: SideSchema,
  selectionId: stableIdSchema,
  field: z.enum(UNIT_STATE_FIELDS),
  equals: UnitStateExpectedSchema,
}).strict().superRefine((prerequisite, context) => {
  const allowedStrings: Partial<Record<
    typeof prerequisite.field,
    ReadonlySet<string>
  >> = {
    movement: new Set(MovementStateSchema.options.filter(
      (value) => value !== "unknown",
    )),
    strength: new Set(StrengthStateSchema.options.filter(
      (value) => value !== "unknown",
    )),
    damage: new Set(DamageStateSchema.options.filter(
      (value) => value !== "unknown",
    )),
  };
  const allowed = allowedStrings[prerequisite.field];
  const valid = allowed
    ? typeof prerequisite.equals === "string" &&
      allowed.has(prerequisite.equals)
    : typeof prerequisite.equals === "boolean";
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `Unit-state prerequisite ${prerequisite.field} has an incompatible expected value.`,
      path: ["equals"],
    });
  }
});

const PAIR_STATE_FIELDS = [
  "withinRange",
  "withinRapidFireRange",
  "withinMeltaRange",
  "withinConversionRange",
  "targetVisible",
  "indirectFire",
  "targetCondition",
] as const;

const PairStatePrerequisiteSchema = z.object({
  kind: z.literal("pair-state"),
  attackerSide: SideSchema,
  attackerSelectionId: stableIdSchema,
  targetSide: SideSchema,
  targetSelectionId: stableIdSchema,
  field: z.enum(PAIR_STATE_FIELDS),
  equals: z.boolean(),
}).strict().superRefine((prerequisite, context) => {
  if (prerequisite.attackerSide === prerequisite.targetSide) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A pair-state prerequisite must cross physical sides.",
      path: ["targetSide"],
    });
  }
});

const BattleRoundPrerequisiteSchema = z.object({
  kind: z.literal("battle-round"),
  minimum: z.number().int().min(1).max(5).optional(),
  maximum: z.number().int().min(1).max(5).optional(),
}).strict().superRefine((prerequisite, context) => {
  if (
    prerequisite.minimum === undefined &&
    prerequisite.maximum === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A battle-round prerequisite needs a minimum or maximum.",
    });
  }
  if (
    prerequisite.minimum !== undefined &&
    prerequisite.maximum !== undefined &&
    prerequisite.minimum > prerequisite.maximum
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Battle-round prerequisite minimum exceeds maximum.",
      path: ["minimum"],
    });
  }
});

const TimingPrerequisiteSchema = z.object({
  kind: z.literal("timing"),
  equals: stableIdSchema,
}).strict();

const ArmyAbilityPrerequisiteSchema = z.object({
  kind: z.literal("army-ability-active"),
  abilityId: stableIdSchema,
}).strict();

const OncePerBattlePrerequisiteSchema = z.object({
  kind: z.literal("once-per-battle-available"),
  abilityId: stableIdSchema,
}).strict();

const ActivationPrerequisiteSchema = z.union([
  UnitStatePrerequisiteSchema,
  PairStatePrerequisiteSchema,
  BattleRoundPrerequisiteSchema,
  TimingPrerequisiteSchema,
  ArmyAbilityPrerequisiteSchema,
  OncePerBattlePrerequisiteSchema,
]);

const ActivationOptionSchema = z.object({
  id: stableIdSchema,
  ownerSide: SideSchema,
  groupId: stableIdSchema.nullable().default(null),
  phases: z.array(z.enum(TESSERA_SCENARIO_PHASES))
    .min(1)
    .default([...TESSERA_SCENARIO_PHASES]),
  directions: z.array(z.enum(TESSERA_SCENARIO_DIRECTIONS))
    .min(1)
    .default([...TESSERA_SCENARIO_DIRECTIONS]),
  costs: z.array(ActivationCostSchema).default([]),
  prerequisites: z.array(ActivationPrerequisiteSchema).default([]),
}).strict().superRefine((option, context) => {
  addDuplicateIssues(context, option.phases, "activation phase", ["phases"]);
  addDuplicateIssues(
    context,
    option.directions,
    "activation direction",
    ["directions"],
  );
  addDuplicateIssues(
    context,
    option.costs.map(costKey),
    "activation resource cost",
    ["costs"],
  );
  addDuplicateIssues(
    context,
    option.prerequisites.map((entry) => canonicalJson(entry)),
    "activation prerequisite",
    ["prerequisites"],
  );
});

const ActivationGroupSchema = z.object({
  id: stableIdSchema,
  ownerSide: SideSchema,
  maximumActive: safePositiveIntegerSchema,
}).strict();

const activationPolicyBase = {
  options: z.array(ActivationOptionSchema).default([]),
  groups: z.array(ActivationGroupSchema).default([]),
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

const TesseraActivationPolicyV3Schema = z.discriminatedUnion("mode", [
  SelectedActivationPolicySchema,
  EnvelopeActivationPolicySchema,
]).superRefine((policy, context) => {
  const optionIds = policy.options.map((option) => option.id);
  const groupIds = policy.groups.map((group) => group.id);
  addDuplicateIssues(context, optionIds, "activation option", ["options"]);
  addDuplicateIssues(context, groupIds, "activation group", ["groups"]);
  const optionsById = new Map(
    policy.options.map((option) => [option.id, option]),
  );
  const groupsById = new Map(
    policy.groups.map((group) => [group.id, group]),
  );

  for (const [optionIndex, option] of policy.options.entries()) {
    if (option.groupId === null) continue;
    const group = groupsById.get(option.groupId);
    if (!group) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Activation ${JSON.stringify(option.id)} references unknown group ${JSON.stringify(option.groupId)}.`,
        path: ["options", optionIndex, "groupId"],
      });
    } else if (group.ownerSide !== option.ownerSide) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Activation ${JSON.stringify(option.id)} and group ${JSON.stringify(group.id)} have different physical owners.`,
        path: ["options", optionIndex, "ownerSide"],
      });
    }
  }

  for (const [groupIndex, group] of policy.groups.entries()) {
    const members = policy.options.filter(
      (option) => option.groupId === group.id,
    );
    if (members.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Activation group ${JSON.stringify(group.id)} has no options.`,
        path: ["groups", groupIndex],
      });
    } else if (group.maximumActive > members.length) {
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
    if (!optionsById.has(selectedId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Selected activation ${JSON.stringify(selectedId)} is not declared in options.`,
        path: ["selectedIds", selectedIndex],
      });
    }
  }
  const selected = new Set(policy.selectedIds);
  for (const [groupIndex, group] of policy.groups.entries()) {
    const selectedCount = policy.options.filter(
      (option) => option.groupId === group.id && selected.has(option.id),
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
});

const AttachmentBindingSchema = z.object({
  side: SideSchema,
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
  for (const [supportIndex, supportId] of
    binding.supportingSelectionIds.entries()) {
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

const attachmentPolicyBase = {
  bindings: z.array(AttachmentBindingSchema).default([]),
};

const SelectedAttachmentPolicySchema = z.object({
  mode: z.literal("selected"),
  ...attachmentPolicyBase,
}).strict();

const EnvelopeAttachmentPolicySchema = z.object({
  mode: z.literal("envelope"),
  ...attachmentPolicyBase,
  includeUnattachedBaseline: z.literal(true).default(true),
}).strict();

const TesseraAttachmentPolicyV3Schema = z.discriminatedUnion("mode", [
  SelectedAttachmentPolicySchema,
  EnvelopeAttachmentPolicySchema,
]).superRefine((policy, context) => {
  addDuplicateIssues(
    context,
    policy.bindings.map(attachmentBindingKey),
    "attachment binding",
    ["bindings"],
  );
  if (policy.mode !== "selected") return;
  const participantBindings = new Map<string, number>();
  for (const [bindingIndex, binding] of policy.bindings.entries()) {
    for (const selectionId of [
      binding.leaderSelectionId,
      binding.bodyguardSelectionId,
      ...binding.supportingSelectionIds,
    ]) {
      const key = `${binding.side}:${selectionId}`;
      const prior = participantBindings.get(key);
      if (prior !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Selected attachment participant ${JSON.stringify(selectionId)} occurs in bindings ${prior} and ${bindingIndex}.`,
          path: ["bindings", bindingIndex],
        });
      } else {
        participantBindings.set(key, bindingIndex);
      }
    }
  }
});

const TesseraStateResolutionPolicyV3Schema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("selected"),
  }).strict(),
  z.object({
    mode: z.literal("envelope"),
    includeUnknownBaseline: z.literal(true).default(true),
  }).strict(),
]);

const TesseraCombatPolicyV3Schema = z.object({
  modelingMode: z.enum(["rules-aware", "base-profile"]),
  stateResolution: TesseraStateResolutionPolicyV3Schema,
  activations: TesseraActivationPolicyV3Schema,
  attachments: TesseraAttachmentPolicyV3Schema,
  limits: z.object({
    maxAttachmentPlans: z.number().int().min(1)
      .max(TESSERA_MAX_ATTACHMENT_PLANS_DEFAULT)
      .default(TESSERA_MAX_ATTACHMENT_PLANS_DEFAULT),
    maxJointVariants: z.number().int().min(1)
      .max(TESSERA_MAX_JOINT_VARIANTS_DEFAULT)
      .default(TESSERA_MAX_JOINT_VARIANTS_DEFAULT),
  }).strict(),
}).strict().superRefine((policy, context) => {
  if (
    policy.modelingMode === "base-profile" &&
    (
      policy.activations.options.length > 0 ||
      (policy.activations.mode === "selected" &&
        policy.activations.selectedIds.length > 0) ||
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

export const TesseraScenarioPolicyContractV3Schema = z.object({
  schemaVersion: z.literal(3),
  kind: z.literal(TESSERA_SCENARIO_POLICY_CONTRACT_V3_KIND),
  scenarios: z.array(TesseraScenarioEntryV3Schema).min(1),
  policy: TesseraCombatPolicyV3Schema,
}).strict().superRefine((contract, context) => {
  validateContractRelationships(contract, context);
});

export type TesseraScenarioSide = z.infer<typeof SideSchema>;
export type TesseraScenarioStateBoolean = z.infer<
  typeof StateBooleanSchema
>;
export type TesseraUnitPhysicalStateV3 = z.infer<
  typeof TesseraUnitPhysicalStateV3Schema
>;
export type TesseraSidePhysicalStateV3 = z.infer<
  typeof TesseraSidePhysicalStateV3Schema
>;
export type TesseraPairPhysicalStateV3 = z.infer<
  typeof TesseraPairPhysicalStateV3Schema
>;
export type TesseraScenarioPhysicalStateV3 = z.infer<
  typeof TesseraScenarioPhysicalStateV3Schema
>;
export type TesseraScenarioEntryV3 = z.infer<
  typeof TesseraScenarioEntryV3Schema
>;
export type TesseraActivationPolicyV3 = z.infer<
  typeof TesseraActivationPolicyV3Schema
>;
export type TesseraStateResolutionPolicyV3 = z.infer<
  typeof TesseraStateResolutionPolicyV3Schema
>;
export type TesseraAttachmentPolicyV3 = z.infer<
  typeof TesseraAttachmentPolicyV3Schema
>;
export type TesseraAttachmentBindingV3 =
  TesseraAttachmentPolicyV3["bindings"][number];
export type TesseraCombatPolicyV3 = z.infer<
  typeof TesseraCombatPolicyV3Schema
>;
export type TesseraScenarioPolicyContractV3 = z.infer<
  typeof TesseraScenarioPolicyContractV3Schema
>;

export class TesseraScenarioPolicyContractV3Error extends Error {
  readonly code:
    | "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID"
    | "TESSERA_SCENARIO_POLICY_CONTRACT_V3_SCOPE_MISMATCH"
    | "TESSERA_SCENARIO_POLICY_CONTRACT_V3_MIGRATION_NEEDS_INPUT";

  constructor(
    code: TesseraScenarioPolicyContractV3Error["code"],
    message: string,
  ) {
    super(message);
    this.name = "TesseraScenarioPolicyContractV3Error";
    this.code = code;
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

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
}

function otherSide(side: TesseraScenarioSide): TesseraScenarioSide {
  return side === "player" ? "opponent" : "player";
}

function attackerSide(direction: TesseraDirection): TesseraScenarioSide {
  return direction === "player-to-opponent" ? "player" : "opponent";
}

function scenarioKey(
  scenario: Pick<TesseraScenarioEntryV3, "phase" | "direction" | "metric">,
): string {
  return `${scenario.phase}:${scenario.direction}:${scenario.metric}`;
}

function phaseDirectionKey(
  scenario: Pick<TesseraScenarioEntryV3, "phase" | "direction">,
): string {
  return `${scenario.phase}:${scenario.direction}`;
}

function pairKey(pair: {
  attackerSide: TesseraScenarioSide;
  attackerSelectionId: string;
  targetSide: TesseraScenarioSide;
  targetSelectionId: string;
}): string {
  return [
    pair.attackerSide,
    pair.attackerSelectionId,
    pair.targetSide,
    pair.targetSelectionId,
  ].join("\u0001");
}

function undirectedPairKey(pair: {
  attackerSide: TesseraScenarioSide;
  attackerSelectionId: string;
  targetSide: TesseraScenarioSide;
  targetSelectionId: string;
}): string {
  const playerSelectionId = pair.attackerSide === "player"
    ? pair.attackerSelectionId
    : pair.targetSelectionId;
  const opponentSelectionId = pair.attackerSide === "opponent"
    ? pair.attackerSelectionId
    : pair.targetSelectionId;
  return `${playerSelectionId}\u0001${opponentSelectionId}`;
}

function costKey(cost: z.infer<typeof ActivationCostSchema>): string {
  return cost.kind === "command-points"
    ? cost.kind
    : `${cost.kind}:${cost.resourceId}`;
}

function attachmentBindingKey(
  binding: z.infer<typeof AttachmentBindingSchema>,
): string {
  return [
    binding.side,
    binding.leaderSelectionId,
    binding.bodyguardSelectionId,
    [...binding.supportingSelectionIds].sort().join("\u0000"),
  ].join("\u0001");
}

function physicalSideKey(
  state: TesseraScenarioPhysicalStateV3,
): string {
  return canonicalJson({
    battleRound: state.battleRound,
    timing: state.timing,
    player: canonicalSideState(state.player),
    opponent: canonicalSideState(state.opponent),
  });
}

function canonicalSideState(
  side: TesseraSidePhysicalStateV3,
): TesseraSidePhysicalStateV3 {
  return {
    resources: {
      commandPoints: side.resources.commandPoints,
      factionResources: [...side.resources.factionResources].sort(
        (left, right) => left.id.localeCompare(right.id),
      ),
    },
    armyAbilities: [...side.armyAbilities].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    oncePerBattle: [...side.oncePerBattle].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    units: [...side.units].sort((left, right) =>
      left.selectionId.localeCompare(right.selectionId),
    ),
  };
}

function canonicalState(
  state: TesseraScenarioPhysicalStateV3,
): TesseraScenarioPhysicalStateV3 {
  return {
    battleRound: state.battleRound,
    timing: state.timing,
    player: canonicalSideState(state.player),
    opponent: canonicalSideState(state.opponent),
    pairs: [...state.pairs].sort((left, right) =>
      pairKey(left).localeCompare(pairKey(right)),
    ),
  };
}

function canonicalActivationPolicy(
  policy: TesseraActivationPolicyV3,
): TesseraActivationPolicyV3 {
  const common = {
    options: policy.options.map((option) => ({
      ...option,
      phases: [...option.phases].sort(),
      directions: [...option.directions].sort(),
      costs: [...option.costs].sort((left, right) =>
        costKey(left).localeCompare(costKey(right)),
      ),
      prerequisites: [...option.prerequisites].sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      ),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    groups: [...policy.groups].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
  return policy.mode === "selected"
    ? {
        mode: "selected",
        ...common,
        selectedIds: [...policy.selectedIds].sort(),
      }
    : {
        mode: "envelope",
        ...common,
        includeNoOptionsBaseline: true,
      };
}

function canonicalAttachmentPolicy(
  policy: TesseraAttachmentPolicyV3,
): TesseraAttachmentPolicyV3 {
  const bindings = policy.bindings.map((binding) => ({
    ...binding,
    supportingSelectionIds: [...binding.supportingSelectionIds].sort(),
  })).sort((left, right) =>
    attachmentBindingKey(left).localeCompare(attachmentBindingKey(right)),
  );
  return policy.mode === "selected"
    ? { mode: "selected", bindings }
    : { mode: "envelope", bindings, includeUnattachedBaseline: true };
}

function canonicalPolicy(policy: TesseraCombatPolicyV3): TesseraCombatPolicyV3 {
  return {
    modelingMode: policy.modelingMode,
    stateResolution: policy.stateResolution.mode === "selected"
      ? { mode: "selected" }
      : { mode: "envelope", includeUnknownBaseline: true },
    activations: canonicalActivationPolicy(policy.activations),
    attachments: canonicalAttachmentPolicy(policy.attachments),
    limits: { ...policy.limits },
  };
}

function scenarioRosterIds(scenario: TesseraScenarioEntryV3): {
  player: string[];
  opponent: string[];
} {
  return {
    player: scenario.state.player.units.map((unit) => unit.selectionId).sort(),
    opponent: scenario.state.opponent.units
      .map((unit) => unit.selectionId)
      .sort(),
  };
}

function validateContractRelationships(
  contract: z.infer<typeof TesseraScenarioPolicyContractV3Schema>,
  context: z.RefinementCtx,
): void {
  addDuplicateIssues(
    context,
    contract.scenarios.map(scenarioKey),
    "scenario tuple",
    ["scenarios"],
  );
  const firstRosterIds = scenarioRosterIds(contract.scenarios[0]);
  const stateByPhaseDirection = new Map<string, string>();
  const physicalByPhase = new Map<string, string>();
  const distanceByPhasePair = new Map<string, TesseraPairPhysicalStateV3["distanceInches"]>();

  for (const [scenarioIndex, scenario] of contract.scenarios.entries()) {
    const rosterIds = scenarioRosterIds(scenario);
    if (
      !arraysEqual(firstRosterIds.player, rosterIds.player) ||
      !arraysEqual(firstRosterIds.opponent, rosterIds.opponent)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Every v3 scenario must bind the same physical player and opponent unit selections.",
        path: ["scenarios", scenarioIndex, "state"],
      });
    }

    const directionKey = phaseDirectionKey(scenario);
    const canonical = canonicalJson(canonicalState(scenario.state));
    const priorDirectionState = stateByPhaseDirection.get(directionKey);
    if (priorDirectionState !== undefined && priorDirectionState !== canonical) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Scenario physical state differs between metrics for ${directionKey}.`,
        path: ["scenarios", scenarioIndex, "state"],
      });
    } else {
      stateByPhaseDirection.set(directionKey, canonical);
    }

    const physical = physicalSideKey(scenario.state);
    const priorPhysical = physicalByPhase.get(scenario.phase);
    if (priorPhysical !== undefined && priorPhysical !== physical) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Player/opponent physical state differs by direction or metric in the ${scenario.phase} phase.`,
        path: ["scenarios", scenarioIndex, "state"],
      });
    } else {
      physicalByPhase.set(scenario.phase, physical);
    }

    for (const [pairIndex, pair] of scenario.state.pairs.entries()) {
      const distanceKey = `${scenario.phase}:${undirectedPairKey(pair)}`;
      const priorDistance = distanceByPhasePair.get(distanceKey);
      if (priorDistance !== undefined && priorDistance !== pair.distanceInches) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Exact pair distance cannot change when the attack direction or metric changes.",
          path: ["scenarios", scenarioIndex, "state", "pairs", pairIndex, "distanceInches"],
        });
      } else {
        distanceByPhasePair.set(distanceKey, pair.distanceInches);
      }
    }
  }

  const knownIds = {
    player: new Set(firstRosterIds.player),
    opponent: new Set(firstRosterIds.opponent),
  };
  for (const [bindingIndex, binding] of
    contract.policy.attachments.bindings.entries()) {
    for (const [field, selectionId] of [
      ["leaderSelectionId", binding.leaderSelectionId],
      ["bodyguardSelectionId", binding.bodyguardSelectionId],
      ...binding.supportingSelectionIds.map((selectionId) =>
        ["supportingSelectionIds", selectionId] as const
      ),
    ] as const) {
      if (!knownIds[binding.side].has(selectionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Attachment ${field} ${JSON.stringify(selectionId)} is not declared on the ${binding.side} side.`,
          path: ["policy", "attachments", "bindings", bindingIndex, field],
        });
      }
    }
  }

  validateActivationBindings(contract, context, knownIds);
  if (contract.policy.stateResolution.mode === "selected") {
    for (const [scenarioIndex, scenario] of contract.scenarios.entries()) {
      if (physicalStateHasUnknown(scenario.state)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Selected state resolution cannot contain unknown physical state; use envelope mode or resolve every state value.",
          path: ["scenarios", scenarioIndex, "state"],
        });
      }
    }
  }
}

function physicalStateHasUnknown(
  state: TesseraScenarioPhysicalStateV3,
): boolean {
  if (state.battleRound === "unknown" || state.timing === "unknown") {
    return true;
  }
  for (const sideName of TESSERA_SCENARIO_SIDES) {
    const side = state[sideName];
    if (side.resources.commandPoints === "unknown") return true;
    if (side.resources.factionResources.some(
      (resource) => resource.amount === "unknown",
    )) return true;
    if (side.armyAbilities.some((ability) => ability.active === "unknown")) {
      return true;
    }
    if (side.oncePerBattle.some(
      (ability) => ability.available === "unknown",
    )) return true;
    if (side.units.some((unit) =>
      unit.movement === "unknown" ||
      unit.chargedThisTurn === "unknown" ||
      unit.wasChargedThisTurn === "unknown" ||
      unit.inCover === "unknown" ||
      unit.onObjective === "unknown" ||
      unit.controlsObjective === "unknown" ||
      unit.strength === "unknown" ||
      unit.damage === "unknown" ||
      unit.battleShocked === "unknown" ||
      unit.eligibleToFight === "unknown" ||
      unit.hasFought === "unknown"
    )) return true;
  }
  return state.pairs.some((pair) =>
    pair.distanceInches === "unknown" ||
    pair.withinRange === "unknown" ||
    pair.withinRapidFireRange === "unknown" ||
    pair.withinMeltaRange === "unknown" ||
    pair.withinConversionRange === "unknown" ||
    pair.targetVisible === "unknown" ||
    pair.indirectFire === "unknown" ||
    pair.targetCondition === "unknown"
  );
}

function validateActivationBindings(
  contract: z.infer<typeof TesseraScenarioPolicyContractV3Schema>,
  context: z.RefinementCtx,
  knownIds: Record<TesseraScenarioSide, Set<string>>,
): void {
  const selectedIds = contract.policy.activations.mode === "selected"
    ? new Set(contract.policy.activations.selectedIds)
    : null;
  for (const [optionIndex, option] of
    contract.policy.activations.options.entries()) {
    for (const [prerequisiteIndex, prerequisite] of
      option.prerequisites.entries()) {
      if (
        prerequisite.kind === "unit-state" &&
        !knownIds[prerequisite.side].has(prerequisite.selectionId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Activation prerequisite selection ${JSON.stringify(prerequisite.selectionId)} is not declared on the ${prerequisite.side} side.`,
          path: ["policy", "activations", "options", optionIndex, "prerequisites", prerequisiteIndex],
        });
      }
      if (
        prerequisite.kind === "pair-state" &&
        (
          !knownIds[prerequisite.attackerSide].has(
            prerequisite.attackerSelectionId,
          ) ||
          !knownIds[prerequisite.targetSide].has(
            prerequisite.targetSelectionId,
          )
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Activation pair-state prerequisite references an unknown unit selection.",
          path: ["policy", "activations", "options", optionIndex, "prerequisites", prerequisiteIndex],
        });
      }
    }

    for (const scenario of contract.scenarios) {
      if (
        !option.phases.includes(scenario.phase) ||
        !option.directions.includes(scenario.direction)
      ) continue;
      const owner = scenario.state[option.ownerSide];
      for (const [costIndex, cost] of option.costs.entries()) {
        if (
          cost.kind === "faction-resource" &&
          !owner.resources.factionResources.some(
            (resource) => resource.id === cost.resourceId,
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `Activation ${JSON.stringify(option.id)} costs undeclared ${option.ownerSide} faction resource ${JSON.stringify(cost.resourceId)}.`,
            path: ["policy", "activations", "options", optionIndex, "costs", costIndex],
          });
        }
      }
      for (const [prerequisiteIndex, prerequisite] of
        option.prerequisites.entries()) {
        if (
          prerequisite.kind === "army-ability-active" &&
          !owner.armyAbilities.some(
            (ability) => ability.id === prerequisite.abilityId,
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `Activation ${JSON.stringify(option.id)} references undeclared ${option.ownerSide} army ability ${JSON.stringify(prerequisite.abilityId)}.`,
            path: ["policy", "activations", "options", optionIndex, "prerequisites", prerequisiteIndex],
          });
        }
        if (
          prerequisite.kind === "once-per-battle-available" &&
          !owner.oncePerBattle.some(
            (ability) => ability.id === prerequisite.abilityId,
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `Activation ${JSON.stringify(option.id)} references undeclared ${option.ownerSide} once-per-battle ability ${JSON.stringify(prerequisite.abilityId)}.`,
            path: ["policy", "activations", "options", optionIndex, "prerequisites", prerequisiteIndex],
          });
        }
      }
    }
  }

  if (selectedIds === null) return;
  for (const [scenarioIndex, scenario] of contract.scenarios.entries()) {
    const selected = contract.policy.activations.options.filter(
      (option) =>
        selectedIds.has(option.id) &&
        option.phases.includes(scenario.phase) &&
        option.directions.includes(scenario.direction),
    );
    for (const side of TESSERA_SCENARIO_SIDES) {
      const sideOptions = selected.filter((option) => option.ownerSide === side);
      const commandPointCost = sideOptions.flatMap((option) => option.costs)
        .filter((cost): cost is z.infer<typeof CommandPointCostSchema> =>
          cost.kind === "command-points"
        )
        .reduce((sum, cost) => sum + cost.amount, 0);
      const availableCp = scenario.state[side].resources.commandPoints;
      if (
        commandPointCost > 0 &&
        (availableCp === "unknown" || commandPointCost > availableCp)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Selected ${side} activations require ${commandPointCost} command points, but the physical state does not prove that budget.`,
          path: ["scenarios", scenarioIndex, "state", side, "resources", "commandPoints"],
        });
      }
      const resourceCosts = new Map<string, number>();
      for (const cost of sideOptions.flatMap((option) => option.costs)) {
        if (cost.kind !== "faction-resource") continue;
        resourceCosts.set(
          cost.resourceId,
          (resourceCosts.get(cost.resourceId) ?? 0) + cost.amount,
        );
      }
      for (const [resourceId, required] of resourceCosts) {
        const available = scenario.state[side].resources.factionResources
          .find((resource) => resource.id === resourceId)?.amount;
        if (
          available === undefined ||
          available === "unknown" ||
          available < required
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `Selected ${side} activations require ${required} ${JSON.stringify(resourceId)}, but the physical state does not prove that budget.`,
            path: ["scenarios", scenarioIndex, "state", side, "resources", "factionResources"],
          });
        }
      }
    }
    for (const option of selected) {
      for (const prerequisite of option.prerequisites) {
        const satisfied = activationPrerequisiteSatisfied(
          scenario,
          option,
          prerequisite,
        );
        if (satisfied !== true) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `Selected activation ${JSON.stringify(option.id)} has a ${satisfied === "unknown" ? "unresolved" : "failed"} ${prerequisite.kind} prerequisite.`,
            path: ["scenarios", scenarioIndex, "state"],
          });
        }
      }
    }
  }
}

function activationPrerequisiteSatisfied(
  scenario: TesseraScenarioEntryV3,
  option: z.infer<typeof ActivationOptionSchema>,
  prerequisite: z.infer<typeof ActivationPrerequisiteSchema>,
): boolean | "unknown" {
  switch (prerequisite.kind) {
    case "battle-round": {
      const round = scenario.state.battleRound;
      if (round === "unknown") return "unknown";
      return (
        (prerequisite.minimum === undefined || round >= prerequisite.minimum) &&
        (prerequisite.maximum === undefined || round <= prerequisite.maximum)
      );
    }
    case "timing":
      return scenario.state.timing === "unknown"
        ? "unknown"
        : scenario.state.timing === prerequisite.equals;
    case "army-ability-active": {
      const state = scenario.state[option.ownerSide].armyAbilities.find(
        (entry) => entry.id === prerequisite.abilityId,
      )?.active;
      return state ?? false;
    }
    case "once-per-battle-available": {
      const state = scenario.state[option.ownerSide].oncePerBattle.find(
        (entry) => entry.id === prerequisite.abilityId,
      )?.available;
      return state ?? false;
    }
    case "unit-state": {
      const unit = scenario.state[prerequisite.side].units.find(
        (entry) => entry.selectionId === prerequisite.selectionId,
      );
      if (!unit) return false;
      const state = unit[prerequisite.field];
      return state === "unknown" ? "unknown" : state === prerequisite.equals;
    }
    case "pair-state": {
      const pair = scenario.state.pairs.find((entry) =>
        entry.attackerSide === prerequisite.attackerSide &&
        entry.attackerSelectionId === prerequisite.attackerSelectionId &&
        entry.targetSide === prerequisite.targetSide &&
        entry.targetSelectionId === prerequisite.targetSelectionId
      );
      if (!pair) return false;
      const state = pair[prerequisite.field];
      return state === "unknown" ? "unknown" : state === prerequisite.equals;
    }
  }
}

export function canonicalTesseraScenarioPolicyContractV3(
  value: unknown,
): TesseraScenarioPolicyContractV3 {
  const parsed = TesseraScenarioPolicyContractV3Schema.safeParse(value);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const path = firstIssue?.path.length
      ? ` at ${firstIssue.path.join(".")}`
      : "";
    throw new TesseraScenarioPolicyContractV3Error(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID",
      `The Tessera scenario/policy v3 contract is invalid${path}: ${firstIssue?.message ?? "schema validation failed"}.`,
    );
  }
  return {
    schemaVersion: 3,
    kind: TESSERA_SCENARIO_POLICY_CONTRACT_V3_KIND,
    scenarios: parsed.data.scenarios.map((scenario) => ({
      ...scenario,
      state: canonicalState(scenario.state),
    })).sort((left, right) =>
      scenarioKey(left).localeCompare(scenarioKey(right)),
    ),
    policy: canonicalPolicy(parsed.data.policy),
  };
}

export function withSelectedTesseraAttachmentBindingsV3(
  value: TesseraScenarioPolicyContractV3,
  bindings: readonly TesseraAttachmentBindingV3[],
): TesseraScenarioPolicyContractV3 {
  const contract = canonicalTesseraScenarioPolicyContractV3(value);
  return canonicalTesseraScenarioPolicyContractV3({
    ...contract,
    policy: {
      ...contract.policy,
      modelingMode: "rules-aware",
      attachments: {
        mode: "selected",
        bindings: bindings.map((binding) => ({
          ...binding,
          supportingSelectionIds: [...binding.supportingSelectionIds],
        })),
      },
    },
  });
}

export function tesseraScenarioPolicyContractV3Sha256(
  value: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson(canonicalTesseraScenarioPolicyContractV3(value)))
    .digest("hex");
}

export type TesseraScenarioPolicyContractV3UnitScope = {
  playerSelectionIds: readonly string[];
  opponentSelectionIds: readonly string[];
};

export function assertTesseraScenarioPolicyContractV3Scope(
  value: unknown,
  phases: readonly TesseraPhase[],
  metrics: readonly TesseraMetric[],
  unitScope?: TesseraScenarioPolicyContractV3UnitScope,
): TesseraScenarioPolicyContractV3 {
  const contract = canonicalTesseraScenarioPolicyContractV3(value);
  const expected = [...new Set(phases)].flatMap((phase) =>
    TESSERA_SCENARIO_DIRECTIONS.flatMap((direction) =>
      [...new Set(metrics)].map((metric) =>
        `${phase}:${direction}:${metric}`,
      ),
    ),
  ).sort();
  const observed = contract.scenarios.map(scenarioKey).sort();
  if (!arraysEqual(expected, observed)) {
    throw new TesseraScenarioPolicyContractV3Error(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_SCOPE_MISMATCH",
      `The Tessera scenario/policy v3 scope must contain exactly ${expected.join(", ")}; observed ${observed.join(", ")}.`,
    );
  }
  if (unitScope) {
    const expectedPlayer = canonicalSelectionIds(
      unitScope.playerSelectionIds,
      "player",
    );
    const expectedOpponent = canonicalSelectionIds(
      unitScope.opponentSelectionIds,
      "opponent",
    );
    const observedUnits = scenarioRosterIds(contract.scenarios[0]);
    if (
      !arraysEqual(expectedPlayer, observedUnits.player) ||
      !arraysEqual(expectedOpponent, observedUnits.opponent)
    ) {
      throw new TesseraScenarioPolicyContractV3Error(
        "TESSERA_SCENARIO_POLICY_CONTRACT_V3_SCOPE_MISMATCH",
        "The Tessera scenario/policy v3 physical player/opponent unit scope does not match the requested selections.",
      );
    }
  }
  return contract;
}

export function tesseraScenarioPolicyContractV3Scope(
  value: unknown,
): {
  phases: TesseraPhase[];
  directions: TesseraDirection[];
  metrics: TesseraMetric[];
  playerSelectionIds: string[];
  opponentSelectionIds: string[];
} {
  const contract = canonicalTesseraScenarioPolicyContractV3(value);
  const rosterIds = scenarioRosterIds(contract.scenarios[0]);
  return {
    phases: [...new Set(contract.scenarios.map((entry) => entry.phase))]
      .sort(),
    directions: [
      ...new Set(contract.scenarios.map((entry) => entry.direction)),
    ].sort(),
    metrics: [...new Set(contract.scenarios.map((entry) => entry.metric))]
      .sort(),
    playerSelectionIds: rosterIds.player,
    opponentSelectionIds: rosterIds.opponent,
  };
}

function unknownUnitState(selectionId: string): TesseraUnitPhysicalStateV3 {
  return {
    selectionId,
    movement: "unknown",
    chargedThisTurn: "unknown",
    wasChargedThisTurn: "unknown",
    inCover: "unknown",
    onObjective: "unknown",
    controlsObjective: "unknown",
    strength: "unknown",
    damage: "unknown",
    battleShocked: "unknown",
    eligibleToFight: "unknown",
    hasFought: "unknown",
  };
}

function canonicalSelectionIds(
  values: readonly string[],
  label: string,
): string[] {
  const parsed = z.array(stableIdSchema).min(1).safeParse(values);
  if (!parsed.success) {
    throw new TesseraScenarioPolicyContractV3Error(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID",
      `The ${label} unit-selection scope is invalid: ${parsed.error.issues[0]?.message ?? "schema validation failed"}.`,
    );
  }
  if (new Set(parsed.data).size !== parsed.data.length) {
    throw new TesseraScenarioPolicyContractV3Error(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID",
      `The ${label} unit-selection scope contains a duplicate selection ID.`,
    );
  }
  return [...parsed.data].sort();
}

export function unknownTesseraScenarioPhysicalStateV3(input: {
  direction: TesseraDirection;
  playerSelectionIds: readonly string[];
  opponentSelectionIds: readonly string[];
}): TesseraScenarioPhysicalStateV3 {
  const playerSelectionIds = canonicalSelectionIds(
    input.playerSelectionIds,
    "player",
  );
  const opponentSelectionIds = canonicalSelectionIds(
    input.opponentSelectionIds,
    "opponent",
  );
  const attacker = attackerSide(input.direction);
  const target = otherSide(attacker);
  const ids = { player: playerSelectionIds, opponent: opponentSelectionIds };
  return canonicalState(TesseraScenarioPhysicalStateV3Schema.parse({
    battleRound: "unknown",
    timing: "unknown",
    player: {
      resources: { commandPoints: "unknown" },
      units: playerSelectionIds.map(unknownUnitState),
    },
    opponent: {
      resources: { commandPoints: "unknown" },
      units: opponentSelectionIds.map(unknownUnitState),
    },
    pairs: ids[attacker].flatMap((attackerSelectionId) =>
      ids[target].map((targetSelectionId) => ({
        attackerSide: attacker,
        attackerSelectionId,
        targetSide: target,
        targetSelectionId,
        distanceInches: "unknown",
        withinRange: "unknown",
        withinRapidFireRange: "unknown",
        withinMeltaRange: "unknown",
        withinConversionRange: "unknown",
        targetVisible: "unknown",
        indirectFire: "unknown",
        targetCondition: "unknown",
      })),
    ),
  }));
}

export function defaultTesseraCombatPolicyV3(): TesseraCombatPolicyV3 {
  return canonicalPolicy(TesseraCombatPolicyV3Schema.parse({
    modelingMode: "rules-aware",
    stateResolution: {
      mode: "envelope",
      includeUnknownBaseline: true,
    },
    activations: {
      mode: "envelope",
      includeNoOptionsBaseline: true,
    },
    attachments: {
      mode: "envelope",
      includeUnattachedBaseline: true,
    },
    limits: {},
  }));
}

/** Exact, deterministic math-hammer baseline: no optional spends or attachments. */
export function selectedBaselineTesseraCombatPolicyV3(): TesseraCombatPolicyV3 {
  return canonicalPolicy(TesseraCombatPolicyV3Schema.parse({
    modelingMode: "rules-aware",
    stateResolution: { mode: "selected" },
    activations: {
      mode: "selected",
      options: [],
      groups: [],
      selectedIds: [],
    },
    attachments: {
      mode: "selected",
      bindings: [],
    },
    limits: {},
  }));
}

function selectedBaselineUnitState(
  selectionId: string,
  phase: TesseraPhase,
): TesseraUnitPhysicalStateV3 {
  return {
    selectionId,
    movement: "stationary",
    chargedThisTurn: phase === "fight",
    wasChargedThisTurn: phase === "fight",
    inCover: false,
    onObjective: false,
    controlsObjective: false,
    strength: "starting",
    damage: "healthy",
    battleShocked: false,
    eligibleToFight: true,
    hasFought: false,
  };
}

export function selectedBaselineTesseraScenarioPolicyContractV3(
  iterations: number,
  unitScope: TesseraScenarioPolicyContractV3UnitScope,
  phases: readonly TesseraPhase[] = TESSERA_SCENARIO_PHASES,
  metrics: readonly TesseraMetric[] = TESSERA_SCENARIO_METRICS,
): TesseraScenarioPolicyContractV3 {
  const playerSelectionIds = canonicalSelectionIds(
    unitScope.playerSelectionIds,
    "player",
  );
  const opponentSelectionIds = canonicalSelectionIds(
    unitScope.opponentSelectionIds,
    "opponent",
  );
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new TesseraScenarioPolicyContractV3Error(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID",
      "Tessera iterations must be a positive safe integer.",
    );
  }
  return canonicalTesseraScenarioPolicyContractV3({
    schemaVersion: 3,
    kind: TESSERA_SCENARIO_POLICY_CONTRACT_V3_KIND,
    scenarios: [...new Set(phases)].flatMap((phase) =>
      TESSERA_SCENARIO_DIRECTIONS.flatMap((direction) => {
        const attacker = attackerSide(direction);
        const target = otherSide(attacker);
        const ids = {
          player: playerSelectionIds,
          opponent: opponentSelectionIds,
        };
        return [...new Set(metrics)].map((metric) => ({
          phase,
          direction,
          metric,
          iterations,
          state: {
            battleRound: 1,
            timing: "baseline-no-options",
            player: {
              resources: {
                commandPoints: 0,
                factionResources: [],
              },
              armyAbilities: [],
              oncePerBattle: [],
              units: playerSelectionIds.map((selectionId) =>
                selectedBaselineUnitState(selectionId, phase),
              ),
            },
            opponent: {
              resources: {
                commandPoints: 0,
                factionResources: [],
              },
              armyAbilities: [],
              oncePerBattle: [],
              units: opponentSelectionIds.map((selectionId) =>
                selectedBaselineUnitState(selectionId, phase),
              ),
            },
            pairs: ids[attacker].flatMap((attackerSelectionId) =>
              ids[target].map((targetSelectionId) => ({
                attackerSide: attacker,
                attackerSelectionId,
                targetSide: target,
                targetSelectionId,
                distanceInches: 0,
                withinRange: true,
                withinRapidFireRange: true,
                withinMeltaRange: true,
                withinConversionRange: false,
                targetVisible: true,
                indirectFire: false,
                targetCondition: false,
              })),
            ),
          },
        }));
      }),
    ),
    policy: selectedBaselineTesseraCombatPolicyV3(),
  });
}

export type TesseraSelectedAbilityActivationV3 = {
  ownerSide: TesseraScenarioSide;
  abilityId: string;
};

/**
 * Exact selected-state math-hammer with explicitly chosen optional abilities.
 * The bridge namespaces one outer activated ability for both rule
 * perspectives. Selecting both ids lets the same physical choice follow its
 * owner when that unit is attacking or defending; phase applicability remains
 * bundle-authoritative.
 */
export function selectedAbilitiesTesseraScenarioPolicyContractV3(
  iterations: number,
  unitScope: TesseraScenarioPolicyContractV3UnitScope,
  selections: readonly TesseraSelectedAbilityActivationV3[],
  phases: readonly TesseraPhase[] = TESSERA_SCENARIO_PHASES,
  metrics: readonly TesseraMetric[] = TESSERA_SCENARIO_METRICS,
  resolvedActivationIds?: readonly string[],
): TesseraScenarioPolicyContractV3 {
  const baseline = selectedBaselineTesseraScenarioPolicyContractV3(
    iterations,
    unitScope,
    phases,
    metrics,
  );
  const uniqueSelections = [
    ...new Map(
      selections.map((selection) => [
        `${selection.ownerSide}\u0000${selection.abilityId}`,
        selection,
      ]),
    ).values(),
  ];
  const ownerForActivationId = (activationId: string): TesseraScenarioSide => {
    const selection = uniqueSelections.find(({ abilityId }) =>
      activationId.startsWith(`attacker:${abilityId}:`) ||
      activationId.startsWith(`target:${abilityId}:`)
    );
    if (!selection) {
      throw new TesseraScenarioPolicyContractV3Error(
        "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID",
        `Resolved activation ${JSON.stringify(activationId)} does not match a selected ability.`,
      );
    }
    return selection.ownerSide;
  };
  const activationIds = resolvedActivationIds
    ? [...new Set(resolvedActivationIds)]
    : uniqueSelections.flatMap((selection) =>
      (["attacker", "target"] as const).map((perspective) =>
        `${perspective}:${selection.abilityId}:${selection.abilityId}`
      )
    );
  const options = activationIds.map((id) => ({
      id,
      ownerSide: ownerForActivationId(id),
      groupId: null,
      phases: [...new Set(phases)],
      directions: [...TESSERA_SCENARIO_DIRECTIONS],
      costs: [],
      prerequisites: [],
    }));
  return canonicalTesseraScenarioPolicyContractV3({
    ...baseline,
    scenarios: baseline.scenarios.map((scenario) => ({
      ...scenario,
      state: {
        ...scenario.state,
        timing: "selected-abilities",
      },
    })),
    policy: {
      ...baseline.policy,
      activations: {
        mode: "selected",
        options,
        groups: [],
        selectedIds: options.map((option) => option.id),
      },
    },
  });
}

/**
 * Selected physical state with a bounded envelope over every optional combat
 * activation discovered in the leased bundle.
 */
export function activationEnvelopeTesseraScenarioPolicyContractV3(
  iterations: number,
  unitScope: TesseraScenarioPolicyContractV3UnitScope,
  phases: readonly TesseraPhase[] = TESSERA_SCENARIO_PHASES,
  metrics: readonly TesseraMetric[] = TESSERA_SCENARIO_METRICS,
): TesseraScenarioPolicyContractV3 {
  const baseline = selectedBaselineTesseraScenarioPolicyContractV3(
    iterations,
    unitScope,
    phases,
    metrics,
  );
  return canonicalTesseraScenarioPolicyContractV3({
    ...baseline,
    scenarios: baseline.scenarios.map((scenario) => ({
      ...scenario,
      state: {
        ...scenario.state,
        timing: "activation-envelope",
      },
    })),
    policy: {
      ...baseline.policy,
      activations: {
        mode: "envelope",
        options: [],
        groups: [],
        includeNoOptionsBaseline: true,
      },
    },
  });
}

export function localTesseraScenarioPolicyContractV3(
  iterations: number,
  unitScope: TesseraScenarioPolicyContractV3UnitScope,
  phases: readonly TesseraPhase[] = TESSERA_SCENARIO_PHASES,
  metrics: readonly TesseraMetric[] = TESSERA_SCENARIO_METRICS,
  policy: TesseraCombatPolicyV3 = defaultTesseraCombatPolicyV3(),
): TesseraScenarioPolicyContractV3 {
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new TesseraScenarioPolicyContractV3Error(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID",
      "Tessera iterations must be a positive safe integer.",
    );
  }
  return canonicalTesseraScenarioPolicyContractV3({
    schemaVersion: 3,
    kind: TESSERA_SCENARIO_POLICY_CONTRACT_V3_KIND,
    scenarios: [...new Set(phases)].flatMap((phase) =>
      TESSERA_SCENARIO_DIRECTIONS.flatMap((direction) =>
        [...new Set(metrics)].map((metric) => ({
          phase,
          direction,
          metric,
          state: unknownTesseraScenarioPhysicalStateV3({
            direction,
            ...unitScope,
          }),
          iterations,
        })),
      ),
    ),
    policy,
  });
}

export type TesseraScenarioPolicyContractV3MigrationBindings =
  TesseraScenarioPolicyContractV3UnitScope & {
    activationOwners?: Readonly<Record<string, TesseraScenarioSide>>;
    attachmentOwners?: Readonly<Record<string, TesseraScenarioSide>>;
  };

function migrationNeedsInput(message: string): never {
  throw new TesseraScenarioPolicyContractV3Error(
    "TESSERA_SCENARIO_POLICY_CONTRACT_V3_MIGRATION_NEEDS_INPUT",
    message,
  );
}

function triStateValue<T>(
  value: TesseraEngagementState,
  whenTrue: T,
  whenFalse: T,
): T | "unknown" {
  return value === "unknown" ? "unknown" : value ? whenTrue : whenFalse;
}

function mergeKnown<T>(
  values: readonly (T | "unknown")[],
  label: string,
): T | "unknown" {
  const known = values.filter((value): value is T => value !== "unknown");
  if (known.length === 0) return "unknown";
  const first = canonicalJson(known[0]);
  if (known.some((value) => canonicalJson(value) !== first)) {
    migrationNeedsInput(
      `The v2 contract has contradictory directional ${label}; select one physical state before migration.`,
    );
  }
  return known[0];
}

function uniqueEngagementForDirection(
  scenarios: readonly TesseraScenarioEntryV2[],
  phase: TesseraPhase,
  direction: TesseraDirection,
): TesseraScenarioEntryV2["engagement"] | null {
  const matching = scenarios.filter(
    (scenario) =>
      scenario.phase === phase && scenario.direction === direction,
  );
  if (matching.length === 0) return null;
  const first = canonicalJson(matching[0].engagement);
  if (matching.some((scenario) => canonicalJson(scenario.engagement) !== first)) {
    migrationNeedsInput(
      `The v2 contract changes engagement state between metrics for ${phase}:${direction}.`,
    );
  }
  return matching[0].engagement;
}

function migratedPhysicalStateForPhase(input: {
  legacy: TesseraScenarioPolicyContractV2;
  phase: TesseraPhase;
  direction: TesseraDirection;
  playerSelectionIds: readonly string[];
  opponentSelectionIds: readonly string[];
  commandPoints: Partial<Record<TesseraScenarioSide, number | "unknown">>;
}): TesseraScenarioPhysicalStateV3 {
  const forward = uniqueEngagementForDirection(
    input.legacy.scenarios,
    input.phase,
    "player-to-opponent",
  );
  const reverse = uniqueEngagementForDirection(
    input.legacy.scenarios,
    input.phase,
    "opponent-to-player",
  );
  const physical = unknownTesseraScenarioPhysicalStateV3({
    direction: input.direction,
    playerSelectionIds: input.playerSelectionIds,
    opponentSelectionIds: input.opponentSelectionIds,
  });
  physical.timing = mergeKnown(
    [forward?.timing ?? "unknown", reverse?.timing ?? "unknown"],
    `${input.phase} timing`,
  );
  const distance = mergeKnown(
    [
      forward?.distanceInches ?? "unknown",
      reverse?.distanceInches ?? "unknown",
    ],
    `${input.phase} pair distance`,
  );

  const applySide = (
    side: TesseraScenarioSide,
    attackerEngagement: typeof forward,
    targetEngagement: typeof forward,
  ): void => {
    const sideState = physical[side];
    sideState.resources.commandPoints = input.commandPoints[side] ?? "unknown";
    sideState.armyAbilities = [{
      id: LEGACY_V2_ARMY_ABILITY_ID,
      active: attackerEngagement?.armyAbilityActive ?? "unknown",
    }];
    sideState.units = sideState.units.map((unit) => ({
      ...unit,
      movement: attackerEngagement
        ? triStateValue(
            attackerEngagement.remainedStationary,
            "stationary" as const,
            "moved" as const,
          )
        : "unknown",
      chargedThisTurn:
        attackerEngagement?.charging ?? "unknown",
      inCover: targetEngagement?.targetInCover ?? "unknown",
      controlsObjective:
        attackerEngagement?.objectiveControl ?? "unknown",
      strength: attackerEngagement
        ? triStateValue(
            attackerEngagement.belowStrength,
            "below-starting" as const,
            "starting" as const,
          )
        : "unknown",
      damage: attackerEngagement
        ? triStateValue(
            attackerEngagement.damaged,
            "damaged" as const,
            "healthy" as const,
          )
        : "unknown",
    }));
  };
  applySide("player", forward, reverse);
  applySide("opponent", reverse, forward);

  const directional = input.direction === "player-to-opponent"
    ? forward
    : reverse;
  physical.pairs = physical.pairs.map((pair) => ({
    ...pair,
    distanceInches: distance,
    withinRapidFireRange:
      directional?.withinRapidFireRange ?? "unknown",
    withinMeltaRange: directional?.withinMeltaRange ?? "unknown",
    indirectFire: directional?.indirectFire ?? "unknown",
    targetCondition: directional?.targetCondition ?? "unknown",
  }));
  return canonicalState(physical);
}

function selectionOwner(input: {
  selectionId: string;
  playerIds: Set<string>;
  opponentIds: Set<string>;
  explicit?: Readonly<Record<string, TesseraScenarioSide>>;
  label: string;
}): TesseraScenarioSide {
  const declared = input.explicit?.[input.selectionId];
  if (declared) return declared;
  const inPlayer = input.playerIds.has(input.selectionId);
  const inOpponent = input.opponentIds.has(input.selectionId);
  if (inPlayer !== inOpponent) return inPlayer ? "player" : "opponent";
  return migrationNeedsInput(
    `The v2 ${input.label} ${JSON.stringify(input.selectionId)} has no unique physical owner; provide an explicit owner binding.`,
  );
}

function migratePolicyV2ToV3(input: {
  legacy: TesseraScenarioPolicyContractV2;
  bindings: TesseraScenarioPolicyContractV3MigrationBindings;
}): {
  policy: TesseraCombatPolicyV3;
  commandPoints: Partial<Record<TesseraScenarioSide, number | "unknown">>;
} {
  const playerIds = new Set(input.bindings.playerSelectionIds);
  const opponentIds = new Set(input.bindings.opponentSelectionIds);
  const owners = new Map<string, TesseraScenarioSide>();
  for (const option of input.legacy.policy.activations.options) {
    const owner = input.bindings.activationOwners?.[option.id];
    if (!owner) {
      migrationNeedsInput(
        `The v2 activation ${JSON.stringify(option.id)} has no physical owner; bind it to player or opponent before migration.`,
      );
    }
    owners.set(option.id, owner);
  }
  const groups = input.legacy.policy.activations.groups.map((group) => {
    const memberOwners = new Set(
      input.legacy.policy.activations.options
        .filter((option) => option.groupId === group.id)
        .map((option) => owners.get(option.id)),
    );
    if (memberOwners.size !== 1 || memberOwners.has(undefined)) {
      migrationNeedsInput(
        `The v2 activation group ${JSON.stringify(group.id)} crosses physical owners and cannot be migrated losslessly.`,
      );
    }
    return {
      id: group.id,
      ownerSide: [...memberOwners][0] as TesseraScenarioSide,
      maximumActive: group.maximumActive,
    };
  });

  const costOwners = new Set(
    input.legacy.policy.activations.options
      .filter((option) => option.resourceCost > 0)
      .map((option) => owners.get(option.id)),
  );
  if (costOwners.size > 1) {
    migrationNeedsInput(
      "The v2 activation resource budget is shared across player and opponent options; provide a selected physical budget before migration.",
    );
  }
  const commandPoints: Partial<
    Record<TesseraScenarioSide, number | "unknown">
  > = {};
  const costOwner = [...costOwners][0];
  if (costOwner) {
    if (
      input.legacy.policy.activations.mode === "selected" &&
      input.legacy.policy.activations.resourceBudget === null &&
      input.legacy.policy.activations.selectedIds.some((selectedId) =>
        (input.legacy.policy.activations.options.find(
          (option) => option.id === selectedId,
        )?.resourceCost ?? 0) > 0
      )
    ) {
      migrationNeedsInput(
        "Selected v2 activations have a cost but no physical command-point budget.",
      );
    }
    commandPoints[costOwner] =
      input.legacy.policy.activations.resourceBudget ?? "unknown";
  }

  const activationBase = {
    options: input.legacy.policy.activations.options.map((option) => ({
      id: option.id,
      ownerSide: owners.get(option.id) as TesseraScenarioSide,
      groupId: option.groupId,
      phases: [...TESSERA_SCENARIO_PHASES],
      directions: [...TESSERA_SCENARIO_DIRECTIONS],
      costs: option.resourceCost > 0
        ? [{
            kind: "command-points" as const,
            amount: option.resourceCost,
          }]
        : [],
      prerequisites: [],
    })),
    groups,
  };
  const activations: TesseraActivationPolicyV3 =
    input.legacy.policy.activations.mode === "selected"
      ? {
          mode: "selected",
          ...activationBase,
          selectedIds: [...input.legacy.policy.activations.selectedIds],
        }
      : {
          mode: "envelope",
          ...activationBase,
          includeNoOptionsBaseline: true,
        };

  const attachmentBindings = input.legacy.policy.attachments.bindings.map(
    (binding) => {
      const side = selectionOwner({
        selectionId: binding.leaderSelectionId,
        playerIds,
        opponentIds,
        explicit: input.bindings.attachmentOwners,
        label: "attachment leader",
      });
      for (const selectionId of [
        binding.bodyguardSelectionId,
        ...binding.supportingSelectionIds,
      ]) {
        const memberOwner = selectionOwner({
          selectionId,
          playerIds,
          opponentIds,
          explicit: input.bindings.attachmentOwners,
          label: "attachment member",
        });
        if (memberOwner !== side) {
          migrationNeedsInput(
            `The v2 attachment led by ${JSON.stringify(binding.leaderSelectionId)} crosses physical sides.`,
          );
        }
      }
      return { side, ...binding };
    },
  );
  const attachments: TesseraAttachmentPolicyV3 =
    input.legacy.policy.attachments.mode === "selected"
      ? { mode: "selected", bindings: attachmentBindings }
      : {
          mode: "envelope",
          bindings: attachmentBindings,
          includeUnattachedBaseline: true,
        };

  return {
    commandPoints,
    policy: {
      modelingMode: input.legacy.policy.modelingMode,
      stateResolution: {
        mode: "envelope",
        includeUnknownBaseline: true,
      },
      activations,
      attachments,
      limits: { ...input.legacy.policy.limits },
    },
  };
}

export function migrateTesseraScenarioPolicyContractV2ToV3(
  value: unknown,
  bindings: TesseraScenarioPolicyContractV3MigrationBindings,
): TesseraScenarioPolicyContractV3 {
  let legacy: TesseraScenarioPolicyContractV2;
  try {
    legacy = canonicalTesseraScenarioPolicyContractV2(value);
  } catch (error) {
    throw new TesseraScenarioPolicyContractV3Error(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID",
      `The v2 Tessera scenario/policy contract cannot be migrated: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const playerSelectionIds = canonicalSelectionIds(
    bindings.playerSelectionIds,
    "player",
  );
  const opponentSelectionIds = canonicalSelectionIds(
    bindings.opponentSelectionIds,
    "opponent",
  );
  const migratedPolicy = migratePolicyV2ToV3({
    legacy,
    bindings: {
      ...bindings,
      playerSelectionIds,
      opponentSelectionIds,
    },
  });
  return canonicalTesseraScenarioPolicyContractV3({
    schemaVersion: 3,
    kind: TESSERA_SCENARIO_POLICY_CONTRACT_V3_KIND,
    scenarios: legacy.scenarios.map((scenario) => ({
      phase: scenario.phase,
      direction: scenario.direction,
      metric: scenario.metric,
      state: migratedPhysicalStateForPhase({
        legacy,
        phase: scenario.phase,
        direction: scenario.direction,
        playerSelectionIds,
        opponentSelectionIds,
        commandPoints: migratedPolicy.commandPoints,
      }),
      iterations: scenario.iterations,
    })),
    policy: migratedPolicy.policy,
  });
}

export function migrateTesseraScenarioContractV1ToV3(
  value: unknown,
  bindings: TesseraScenarioPolicyContractV3MigrationBindings,
): TesseraScenarioPolicyContractV3 {
  let v2: TesseraScenarioPolicyContractV2;
  try {
    v2 = migrateTesseraScenarioContractV1ToV2(value);
  } catch (error) {
    throw new TesseraScenarioPolicyContractV3Error(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_INVALID",
      `The v1 Tessera scenario contract cannot be migrated: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return migrateTesseraScenarioPolicyContractV2ToV3(v2, bindings);
}

export type TesseraScenarioPolicyContractV3ConclusionStatus = {
  mode: "selected" | "envelope-only";
  scalarClaimsAllowed: boolean;
  unresolvedDimensions: Array<"state" | "activations" | "attachments">;
};

/**
 * Scalar conclusions are admissible only when every choice dimension is
 * frozen. Envelope contracts remain valid diagnostic evidence, but callers
 * must report their min/median/max range rather than one decision-grade value.
 */
export function tesseraScenarioPolicyContractV3ConclusionStatus(
  value: unknown,
): TesseraScenarioPolicyContractV3ConclusionStatus {
  const contract = canonicalTesseraScenarioPolicyContractV3(value);
  const unresolvedDimensions: TesseraScenarioPolicyContractV3ConclusionStatus[
    "unresolvedDimensions"
  ] = [];
  if (contract.policy.stateResolution.mode !== "selected") {
    unresolvedDimensions.push("state");
  }
  if (contract.policy.activations.mode !== "selected") {
    unresolvedDimensions.push("activations");
  }
  if (contract.policy.attachments.mode !== "selected") {
    unresolvedDimensions.push("attachments");
  }
  return unresolvedDimensions.length === 0
    ? {
        mode: "selected",
        scalarClaimsAllowed: true,
        unresolvedDimensions,
      }
    : {
        mode: "envelope-only",
        scalarClaimsAllowed: false,
        unresolvedDimensions,
      };
}
