import {
  effectToBuffs,
  resolveBuffs,
  type Buff,
  type BuffApplicability,
  type BuffContribution,
  type BuffSource,
  type EngineContext,
  type ResolvedModifiers,
  type TranslationPerspective,
} from "@alpaca-software/40kdc-data";

import { canonicalJson, sha256Hex } from "./semantic-hash";

export const COMBAT_BRIDGE_SCHEMA_VERSION = 2 as const;
export const COMBAT_BRIDGE_COMPILER_VERSION =
  "bundle-rules-effects-v2" as const;
export const COMBAT_POLICY_SCHEMA_VERSION = 1 as const;
export const COMBAT_EFFECT_VOCABULARY_VERSION =
  "40kdc-buffs-v1" as const;
export const COMBAT_BRIDGE_HASH_CONTRACT_VERSION =
  "merkle-index-v1" as const;
export const COMBAT_RULES_COMPILER = {
  package: "@alpaca-software/40kdc-data",
  version: "1.2.1",
  translator: "effectToBuffs",
  resolver: "resolveBuffs",
} as const;
export const MAX_COMBAT_ATTACHMENT_PLANS = 16 as const;
export const MAX_COMBAT_JOINT_VARIANTS = 64 as const;

export type CombatEffectStatus =
  | "modeled"
  | "approximated"
  | "omitted"
  | "not-applicable";
export type CombatCoverageStatus = "complete" | "partial" | "unusable";
export type CombatClaimEligibility =
  | "decision-grade"
  | "provisional"
  | "none";
export type CombatPhaseV2 = "shooting" | "fight";
export type CombatDirectionV2 =
  | "player-to-opponent"
  | "opponent-to-player";
export type CombatMetricV2 =
  | "wipe-probability"
  | "half-wipe-probability"
  | "mean-kills"
  | "mean-damage";
export type KnownOrUnknown<T> = T | "unknown";

export type CombatEffectVocabularyEntryV1 = {
  contributionType: BuffContribution["type"];
  bridgeSupport: "exact";
  tesseraAdapterSupport: "exact" | "conditional" | "deferred";
  tesseraField: string | null;
  note: string;
};

/**
 * The neutral bridge retains every contribution the 40kdc buff resolver can
 * express. Adapter support is separate so a provider can fail closed without
 * corrupting or weakening the canonical bridge artifact.
 */
export const COMBAT_EFFECT_VOCABULARY_V1: readonly CombatEffectVocabularyEntryV1[] =
  [
    {
      contributionType: "hit-mod",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "attacker.hitModifier/defender.hitPenalty",
      note: "The engine applies the normal +/-1 roll-modifier cap.",
    },
    {
      contributionType: "wound-mod",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "attacker.woundModifier",
      note: "The engine applies the normal +/-1 roll-modifier cap.",
    },
    {
      contributionType: "save-mod",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "defender.unitPatches.saveModifier",
      note: "The tracked adapter-v2 applies the additive save modifier unit-wide or to the exact bearer selection before AP is resolved.",
    },
    {
      contributionType: "cover",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "defender.cover",
      note: "Maps to the defender-side cover state.",
    },
    {
      contributionType: "reroll",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "conditional",
      tesseraField: "attacker.reroll/defender.saveReroll",
      note: "Hit, wound, and save rerolls are exact; damage rerolls remain adapter-deferred.",
    },
    {
      contributionType: "extra-keyword",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "conditional",
      tesseraField: "attacker.grantKeywords",
      note: "Exact only when the target adapter supports the granted keyword and parameters.",
    },
    {
      contributionType: "feel-no-pain",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "conditional",
      tesseraField: "defender.fnp",
      note: "All-damage FNP is exact; mortal-only FNP remains adapter-deferred.",
    },
    {
      contributionType: "damage-mod",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "attacker.damageBonus",
      note: "Maps additive weapon Damage modifiers.",
    },
    {
      contributionType: "attacks-mod",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "attacker.attackBonus",
      note: "Maps additive weapon Attacks modifiers.",
    },
    {
      contributionType: "strength-mod",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "attacker.strengthBonus",
      note: "Maps additive weapon Strength modifiers.",
    },
    {
      contributionType: "toughness-mod",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "defender.unitPatches.toughnessModifier",
      note: "The tracked adapter-v2 applies additive Toughness unit-wide or to the exact bearer selection.",
    },
    {
      contributionType: "ap-mod",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "attacker.apBonus",
      note: "The Tessera adapter must negate signed 40kdc AP: apBonus = -apMod.",
    },
    {
      contributionType: "damage-reduction",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "defender.damageReduction",
      note: "Flat reduction only; half/to-zero effects remain unsupported DSL fragments.",
    },
    {
      contributionType: "invulnerable-save",
      bridgeSupport: "exact",
      tesseraAdapterSupport: "exact",
      tesseraField: "defender.invuln",
      note: "The best (lowest) threshold wins.",
    },
  ] as const;

export function tesseraAdapterSupportForContribution(
  contribution: BuffContribution,
): CombatEffectVocabularyEntryV1["tesseraAdapterSupport"] {
  if (contribution.type === "reroll" && contribution.roll === "damage") {
    return "deferred";
  }
  if (
    contribution.type === "feel-no-pain" &&
    contribution.scope === "mortal"
  ) {
    return "deferred";
  }
  if (contribution.type === "extra-keyword") return "conditional";
  return "exact";
}

export type CombatBundleBindingV2 = {
  bundleId: string;
  engineDataSchemaVersion: number;
  /**
   * Whether the semantic hashes below were recomputed from an immutable
   * bundle manifest or merely retained from the two canonical rosters.
   * Roster-asserted bindings are replayable, but never decision-grade.
   */
  semanticAuthority: "bundle-manifest-verified" | "roster-asserted";
  playerRosterId: string;
  opponentRosterId: string;
  playerRosterFingerprint: string;
  opponentRosterFingerprint: string;
  playerFactionId: string;
  opponentFactionId: string;
  playerRosterRulesHash: string;
  opponentRosterRulesHash: string;
  playerFactionRulesHash: string;
  opponentFactionRulesHash: string;
  playerMappingHash: string;
  opponentMappingHash: string;
  portfolioHash: string | null;
};

export type CombatScenarioContextV2 = {
  schemaVersion: 2;
  phase: CombatPhaseV2;
  distanceInches: KnownOrUnknown<number>;
  withinHalfRange: KnownOrUnknown<boolean>;
  attackerStationary: KnownOrUnknown<boolean>;
  attackerCharged: KnownOrUnknown<boolean>;
  attackerAttached: KnownOrUnknown<boolean>;
  targetAttached: KnownOrUnknown<boolean>;
  attackerInCover: KnownOrUnknown<boolean>;
  targetInCover: KnownOrUnknown<boolean>;
  timing: string | "unknown";
  objectiveState: "controlled" | "not-controlled" | "unknown";
  attackerStrengthState:
    | "starting"
    | "below-starting"
    | "below-half"
    | "unknown";
  targetStrengthState:
    | "starting"
    | "below-starting"
    | "below-half"
    | "unknown";
  attackerDamageState: "healthy" | "damaged" | "unknown";
  targetDamageState: "healthy" | "damaged" | "unknown";
  armyAbilityState: "active" | "inactive" | "unknown";
  targetConditionState: "met" | "not-met" | "unknown";
};

export type CombatAttachmentBindingV1 = {
  leaderSelectionId: string;
  bodyguardSelectionId: string;
  supportSelectionIds: string[];
};

export type CombatAttachmentSelectionV1 = {
  attacker: CombatAttachmentBindingV1[];
  target: CombatAttachmentBindingV1[];
};

export type CombatAttachmentPlanV1 = CombatAttachmentSelectionV1 & {
  id: string;
};

export type CombatPolicyV1 = {
  schemaVersion: 1;
  activationMode: "selected" | "envelope";
  selectedActivationIds: string[];
  resourceBudget: { cp: number } | null;
  /**
   * Optional explicit activation catalogue. When present, only these exact
   * bundle-discovered lever ids are eligible; group limits and resource costs
   * come from this frozen policy instead of implicit translator metadata.
   */
  activationConstraints?: {
    options: Array<{
      id: string;
      groupId: string | null;
      cpCost: number;
    }>;
    groups: Array<{
      id: string;
      maxActivations: number;
    }>;
  };
  attachmentMode: "selected" | "enumerate";
  attachments: CombatAttachmentSelectionV1;
  limits?: {
    maxAttachmentPlans: number;
    maxJointVariants: number;
  };
};

export function defaultCombatPolicyV1(): CombatPolicyV1 {
  return {
    schemaVersion: COMBAT_POLICY_SCHEMA_VERSION,
    activationMode: "envelope",
    selectedActivationIds: [],
    resourceBudget: null,
    attachmentMode: "enumerate",
    attachments: { attacker: [], target: [] },
    limits: {
      maxAttachmentPlans: MAX_COMBAT_ATTACHMENT_PLANS,
      maxJointVariants: MAX_COMBAT_JOINT_VARIANTS,
    },
  };
}

export type CombatRuleSourceV1 =
  | { kind: "army"; factionId: string }
  | { kind: "detachment"; detachmentId: string }
  | {
      kind: "detachment-stratagem";
      detachmentId: string;
      stratagemId: string;
    }
  | { kind: "unit"; unitId: string }
  | { kind: "attached"; sourceUnitId: string }
  | { kind: "support"; sourceUnitId: string }
  | {
      kind: "enhancement";
      enhancementId: string;
      bearerUnitId: string;
      bearerSelectionId: string;
    }
  | {
      kind: "wargear";
      wargearId: string;
      bearerUnitId: string;
      bearerSelectionId: string;
    };

export type CombatActivationGroupV1 = {
  id: string;
  maxActivations: number;
};

export type CombatRuleActivationV1 =
  | { kind: "always" }
  | {
      kind: "optional" | "stratagem";
      id: string;
      label: string;
      group: CombatActivationGroupV1 | null;
      cpCost: number;
    };

/**
 * A rule record must come from the operation's leased bundle. The bridge never
 * imports an embedded/package-global Dataset, which keeps durable jobs bound to
 * the exact snapshot their caller leased.
 */
export type BundleCombatRuleRecordV1 = {
  abilityId: string;
  abilityName: string;
  entityHash: string;
  effect: unknown;
  source: CombatRuleSourceV1;
  phases: CombatPhaseV2[];
  /** Missing mappings are applied best-effort and make evidence provisional. */
  phaseMappingStatus?: "verified" | "missing";
  activation: CombatRuleActivationV1;
  /** Default for untranslated fragments from this rule. */
  unsupportedRelevance: "combat" | "non-combat";
  /** Optional fragment-hash overrides for mixed combat/non-combat rules. */
  unsupportedFragmentRelevance?: Readonly<
    Record<string, "combat" | "non-combat">
  >;
};

export type CombatParticipantV2 = {
  rosterId: string;
  selectionId: string;
  unitId: string;
  factionId: string;
  keywords: string[];
};

export type CombatCellRuleVariantInputV2 = {
  attachmentPlan: CombatAttachmentPlanV1;
  attackerRules: BundleCombatRuleRecordV1[];
  targetRules: BundleCombatRuleRecordV1[];
};

export type CombatBridgeCellInputV2 = {
  cellId: string;
  direction: CombatDirectionV2;
  metric: CombatMetricV2;
  attacker: CombatParticipantV2;
  target: CombatParticipantV2;
  scenario: CombatScenarioContextV2;
  ruleVariants: CombatCellRuleVariantInputV2[];
};

export type CompileCombatBridgeInputV2 = {
  bundle: CombatBundleBindingV2;
  policy: CombatPolicyV1;
  cells: CombatBridgeCellInputV2[];
};

export type CombatEffectProvenanceV2 = {
  abilityId: string;
  abilityName: string;
  entityHash: string;
  source: CombatRuleSourceV1;
  perspective: TranslationPerspective;
  ruleEffectSha256: string;
  fragmentSha256: string;
};

export type CombatBridgeEffectV2 = {
  effectId: string;
  status: CombatEffectStatus;
  reason: string | null;
  contribution: BuffContribution | null;
  applicableWhen: BuffApplicability | null;
  provenance: CombatEffectProvenanceV2;
};

export type CombatCoverageV2 = {
  status: CombatCoverageStatus;
  claimEligibility: CombatClaimEligibility;
  modeledEffects: number;
  approximatedEffects: number;
  omittedEffects: number;
  notApplicableEffects: number;
  reasons: string[];
};

export type CombatBridgeDiagnosticV2 = {
  code: string;
  severity: "partial" | "unusable";
  message: string;
};

export type CombatActivationLeverV1 = {
  id: string;
  label: string;
  group: CombatActivationGroupV1 | null;
  cpCost: number;
};

export type CombatActivationVariantV1 = {
  id: string;
  activeIds: string[];
  cpSpent: number;
};

export type CombatEnvelopeResult<T> = {
  items: T[];
  truncated: boolean;
  valid: boolean;
  diagnostics: CombatBridgeDiagnosticV2[];
};

export type CombatBridgeVariantV2 = {
  variantId: string;
  variantSha256: string;
  attachmentPlan: CombatAttachmentPlanV1;
  activation: CombatActivationVariantV1;
  effects: CombatBridgeEffectV2[];
  /** Perspective-preserving resolution used by provider adapters. */
  resolvedByPerspective: {
    attacker: ResolvedModifiers;
    target: ResolvedModifiers;
  };
  /** Combined compatibility view; adapters should prefer the split form. */
  resolved: ResolvedModifiers;
  coverage: CombatCoverageV2;
};

export type CombatBridgeCellV2 = {
  cellId: string;
  direction: CombatDirectionV2;
  metric: CombatMetricV2;
  mechanicsSha256: string;
  scenarioSha256: string;
  attacker: CombatParticipantV2;
  target: CombatParticipantV2;
  scenario: CombatScenarioContextV2;
  variants: CombatBridgeVariantV2[];
  availableActivationIds: string[];
  coverage: CombatCoverageV2;
  diagnostics: CombatBridgeDiagnosticV2[];
  /** Ordered variant-id/hash index; excludes repeated effect payloads. */
  variantIndexSha256: string;
  cellSha256: string;
};

export type CombatBridgeV2 = {
  schemaVersion: 2;
  kind: "rosterpilot-combat-bridge";
  compiler: {
    version: typeof COMBAT_BRIDGE_COMPILER_VERSION;
    effectVocabularyVersion: typeof COMBAT_EFFECT_VOCABULARY_VERSION;
    hashContractVersion: typeof COMBAT_BRIDGE_HASH_CONTRACT_VERSION;
    rulesCompiler: typeof COMBAT_RULES_COMPILER;
  };
  bundle: CombatBundleBindingV2;
  policy: CombatPolicyV1;
  policySha256: string;
  cells: CombatBridgeCellV2[];
  coverage: CombatCoverageV2;
  coverageUnit: "unique-mechanics-cell";
  diagnostics: CombatBridgeDiagnosticV2[];
  /** Ordered cell-id/hash index; excludes repeated variant/effect payloads. */
  cellIndexSha256: string;
  bridgeSha256: string;
};

type SourcedBuff = {
  buff: Buff;
  rule: BundleCombatRuleRecordV1;
  perspective: TranslationPerspective;
  ruleEffectSha256: string;
  slot: string;
  phaseMappingApproximated: boolean;
};

type InternalLever = {
  lever: CombatActivationLeverV1;
  buffs: SourcedBuff[];
};

type TranslationResult = {
  baseBuffs: SourcedBuff[];
  levers: InternalLever[];
  fixedEffects: CombatBridgeEffectV2[];
  diagnostics: CombatBridgeDiagnosticV2[];
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function normalizedKeywords(values: readonly string[]): string[] {
  return sortedUnique(
    values
      .map((value) => value.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
}

function normalizeBinding(
  binding: CombatAttachmentBindingV1,
): CombatAttachmentBindingV1 {
  return {
    leaderSelectionId: binding.leaderSelectionId,
    bodyguardSelectionId: binding.bodyguardSelectionId,
    supportSelectionIds: sortedUnique(binding.supportSelectionIds),
  };
}

function compareBindings(
  left: CombatAttachmentBindingV1,
  right: CombatAttachmentBindingV1,
): number {
  return (
    compareStrings(left.leaderSelectionId, right.leaderSelectionId) ||
    compareStrings(left.bodyguardSelectionId, right.bodyguardSelectionId) ||
    compareStrings(
      left.supportSelectionIds.join("\u0000"),
      right.supportSelectionIds.join("\u0000"),
    )
  );
}

function normalizeSelection(
  selection: CombatAttachmentSelectionV1,
): CombatAttachmentSelectionV1 {
  return {
    attacker: selection.attacker.map(normalizeBinding).sort(compareBindings),
    target: selection.target.map(normalizeBinding).sort(compareBindings),
  };
}

function normalizePlan(plan: CombatAttachmentPlanV1): CombatAttachmentPlanV1 {
  return { id: plan.id, ...normalizeSelection(plan) };
}

function attachmentSelectionKey(
  selection: CombatAttachmentSelectionV1,
): string {
  return canonicalJson(normalizeSelection(selection));
}

function planHasDuplicateMembers(plan: CombatAttachmentPlanV1): boolean {
  for (const bindings of [plan.attacker, plan.target]) {
    const seen = new Set<string>();
    for (const binding of bindings) {
      for (const id of [
        binding.leaderSelectionId,
        binding.bodyguardSelectionId,
        ...binding.supportSelectionIds,
      ]) {
        if (seen.has(id)) return true;
        seen.add(id);
      }
    }
  }
  return false;
}

function isEmptyPlan(plan: CombatAttachmentPlanV1): boolean {
  return plan.attacker.length === 0 && plan.target.length === 0;
}

export function enumerateAttachmentEnvelope<
  T extends { attachmentPlan: CombatAttachmentPlanV1 },
>(
  candidates: readonly T[],
  policy: CombatPolicyV1,
): CombatEnvelopeResult<T> {
  const maximum = Math.max(
    1,
    Math.min(
      MAX_COMBAT_ATTACHMENT_PLANS,
      policy.limits?.maxAttachmentPlans ?? MAX_COMBAT_ATTACHMENT_PLANS,
    ),
  );
  const diagnostics: CombatBridgeDiagnosticV2[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  const validCandidates = candidates
    .filter((candidate) => {
      const plan = normalizePlan(candidate.attachmentPlan);
      const key = attachmentSelectionKey(plan);
      if (planHasDuplicateMembers(candidate.attachmentPlan)) {
        diagnostics.push({
          code: "COMBAT_ATTACHMENT_PLAN_OVERLAP",
          severity: "unusable",
          message: `Attachment plan ${JSON.stringify(plan.id)} assigns a selection more than once on the same side.`,
        });
        return false;
      }
      if (ids.has(plan.id) || keys.has(key)) {
        diagnostics.push({
          code: "COMBAT_ATTACHMENT_PLAN_DUPLICATE",
          severity: "unusable",
          message: `Attachment plan ${JSON.stringify(plan.id)} duplicates another candidate.`,
        });
        return false;
      }
      ids.add(plan.id);
      keys.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        Number(isEmptyPlan(left.attachmentPlan)) * -1 -
          Number(isEmptyPlan(right.attachmentPlan)) * -1 ||
        compareStrings(left.attachmentPlan.id, right.attachmentPlan.id),
    );

  if (validCandidates.length === 0) {
    diagnostics.push({
      code: "COMBAT_ATTACHMENT_PLAN_MISSING",
      severity: "unusable",
      message: "No valid bundle-derived attachment plan was supplied for the combat cell.",
    });
    return { items: [], truncated: false, valid: false, diagnostics };
  }

  if (policy.attachmentMode === "selected") {
    if (
      planHasDuplicateMembers({
        id: "selected-policy",
        ...policy.attachments,
      })
    ) {
      diagnostics.push({
        code: "COMBAT_ATTACHMENT_SELECTION_OVERLAP",
        severity: "unusable",
        message: "The selected attachment policy assigns a selection more than once on the same side.",
      });
      return { items: [], truncated: false, valid: false, diagnostics };
    }
    const selectedKey = attachmentSelectionKey(policy.attachments);
    const selected = validCandidates.find(
      (candidate) => attachmentSelectionKey(candidate.attachmentPlan) === selectedKey,
    );
    if (!selected) {
      diagnostics.push({
        code: "COMBAT_ATTACHMENT_SELECTION_UNRESOLVED",
        severity: "unusable",
        message: "The selected attachment bindings do not match a supplied legal attachment plan.",
      });
      return { items: [], truncated: false, valid: false, diagnostics };
    }
    return {
      items: [selected],
      truncated: false,
      valid: diagnostics.length === 0,
      diagnostics,
    };
  }

  const truncated = validCandidates.length > maximum;
  if (truncated) {
    diagnostics.push({
      code: "COMBAT_ATTACHMENT_ENVELOPE_TRUNCATED",
      severity: "partial",
      message: `Attachment enumeration was capped at ${maximum} plans.`,
    });
  }
  return {
    items: validCandidates.slice(0, maximum),
    truncated,
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "unusable"),
    diagnostics,
  };
}

function activationConstraintIssue(
  activeIds: readonly string[],
  levers: ReadonlyMap<string, CombatActivationLeverV1>,
  policy: CombatPolicyV1,
): string | null {
  const groupCounts = new Map<string, number>();
  let cpSpent = 0;
  for (const id of activeIds) {
    const lever = levers.get(id);
    if (!lever) return `Unknown activation ${JSON.stringify(id)}.`;
    cpSpent += lever.cpCost;
    if (lever.group) {
      const count = (groupCounts.get(lever.group.id) ?? 0) + 1;
      groupCounts.set(lever.group.id, count);
      if (count > lever.group.maxActivations) {
        return `Activation group ${JSON.stringify(lever.group.id)} permits at most ${lever.group.maxActivations}.`;
      }
    }
  }
  if (policy.resourceBudget && cpSpent > policy.resourceBudget.cp) {
    return `The activation set spends ${cpSpent} CP but the policy budget is ${policy.resourceBudget.cp}.`;
  }
  return null;
}

function activationVariant(
  activeIds: readonly string[],
  levers: ReadonlyMap<string, CombatActivationLeverV1>,
): CombatActivationVariantV1 {
  const ids = sortedUnique(activeIds);
  return {
    id: ids.length === 0 ? "baseline" : `active:${ids.join("+")}`,
    activeIds: ids,
    cpSpent: ids.reduce(
      (total, id) => total + (levers.get(id)?.cpCost ?? 0),
      0,
    ),
  };
}

export function enumerateActivationEnvelope(
  inputs: readonly CombatActivationLeverV1[],
  policy: CombatPolicyV1,
  maximum: number = MAX_COMBAT_JOINT_VARIANTS,
): CombatEnvelopeResult<CombatActivationVariantV1> {
  const limit = Math.max(
    1,
    Math.min(
      MAX_COMBAT_JOINT_VARIANTS,
      Number.isFinite(maximum) ? Math.floor(maximum) : 1,
    ),
  );
  const diagnostics: CombatBridgeDiagnosticV2[] = [];
  const ordered = [...inputs].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  let levers = new Map<string, CombatActivationLeverV1>();
  const groupLimits = new Map<string, number>();
  for (const lever of ordered) {
    if (levers.has(lever.id)) {
      diagnostics.push({
        code: "COMBAT_ACTIVATION_ID_DUPLICATE",
        severity: "unusable",
        message: `Activation id ${JSON.stringify(lever.id)} is not unique.`,
      });
      continue;
    }
    if (
      lever.cpCost < 0 ||
      !Number.isInteger(lever.cpCost) ||
      (lever.group &&
        (!Number.isInteger(lever.group.maxActivations) ||
          lever.group.maxActivations < 1))
    ) {
      diagnostics.push({
        code: "COMBAT_ACTIVATION_CONSTRAINT_INVALID",
        severity: "unusable",
        message: `Activation ${JSON.stringify(lever.id)} has an invalid resource cost or group limit.`,
      });
      continue;
    }
    if (lever.group) {
      const existingLimit = groupLimits.get(lever.group.id);
      if (
        existingLimit !== undefined &&
        existingLimit !== lever.group.maxActivations
      ) {
        diagnostics.push({
          code: "COMBAT_ACTIVATION_GROUP_INCONSISTENT",
          severity: "unusable",
          message: `Activation group ${JSON.stringify(lever.group.id)} has conflicting maximums ${existingLimit} and ${lever.group.maxActivations}.`,
        });
        continue;
      }
      groupLimits.set(lever.group.id, lever.group.maxActivations);
    }
    levers.set(lever.id, lever);
  }

  if (policy.activationConstraints) {
    const constrained = new Map<string, CombatActivationLeverV1>();
    const declaredGroups = new Map<string, number>();
    for (const group of policy.activationConstraints.groups) {
      if (
        declaredGroups.has(group.id) ||
        !group.id ||
        !Number.isInteger(group.maxActivations) ||
        group.maxActivations < 1
      ) {
        diagnostics.push({
          code: "COMBAT_ACTIVATION_POLICY_GROUP_INVALID",
          severity: "unusable",
          message: `Activation policy group ${JSON.stringify(group.id)} is duplicated or invalid.`,
        });
        continue;
      }
      declaredGroups.set(group.id, group.maxActivations);
    }
    for (const option of [...policy.activationConstraints.options].sort(
      (left, right) => compareStrings(left.id, right.id),
    )) {
      if (
        constrained.has(option.id) ||
        !option.id ||
        !Number.isInteger(option.cpCost) ||
        option.cpCost < 0 ||
        (option.groupId !== null &&
          !declaredGroups.has(option.groupId))
      ) {
        diagnostics.push({
          code: "COMBAT_ACTIVATION_POLICY_OPTION_INVALID",
          severity: "unusable",
          message: `Activation policy option ${JSON.stringify(option.id)} is duplicated or has invalid group/resource metadata.`,
        });
        continue;
      }
      const discovered = levers.get(option.id);
      // Absence can be legitimate for a directional participant. The bridge
      // performs one global exact-id check after all cells are compiled.
      if (!discovered) continue;
      const discoveredGroupId = discovered.group?.id ?? null;
      const declaredMaximum = option.groupId === null
        ? null
        : declaredGroups.get(option.groupId)!;
      const discoveredMaximum = discovered.group?.maxActivations ?? null;
      if (
        option.cpCost !== discovered.cpCost ||
        option.groupId !== discoveredGroupId ||
        declaredMaximum !== discoveredMaximum
      ) {
        diagnostics.push({
          code: "COMBAT_ACTIVATION_POLICY_METADATA_MISMATCH",
          severity: "unusable",
          message: `Activation policy option ${JSON.stringify(option.id)} declares CP/group metadata that does not exactly match the bundle-discovered lever.`,
        });
        continue;
      }
      // Explicit constraints are an allowlist and an integrity assertion. The
      // bundle-discovered metadata remains authoritative; policy input never
      // rewrites resource costs or mutual-exclusion groups.
      constrained.set(option.id, discovered);
    }
    levers = constrained;
  }

  const baseline = activationVariant([], levers);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "unusable")) {
    return {
      items: [baseline],
      truncated: false,
      valid: false,
      diagnostics,
    };
  }

  if (policy.activationMode === "selected") {
    const selected = sortedUnique(policy.selectedActivationIds).filter(
      (id) =>
        !policy.activationConstraints || levers.has(id),
    );
    const issue = activationConstraintIssue(selected, levers, policy);
    if (issue) {
      diagnostics.push({
        code: "COMBAT_ACTIVATION_SELECTION_INVALID",
        severity: "unusable",
        message: issue,
      });
      return {
        items: [baseline],
        truncated: false,
        valid: false,
        diagnostics,
      };
    }
    return {
      items: [
        selected.length === 0
          ? baseline
          : activationVariant(selected, levers),
      ],
      truncated: false,
      valid: true,
      diagnostics,
    };
  }

  const ids = [...levers.keys()];
  const variants: CombatActivationVariantV1[] = [baseline];
  let truncated = false;
  const addCombination = (selected: string[]): boolean => {
    if (activationConstraintIssue(selected, levers, policy)) return true;
    if (variants.length >= limit) {
      truncated = true;
      return false;
    }
    variants.push(activationVariant(selected, levers));
    return true;
  };
  const walk = (
    size: number,
    start: number,
    selected: string[],
  ): boolean => {
    if (selected.length === size) return addCombination(selected);
    for (let index = start; index < ids.length; index += 1) {
      selected.push(ids[index]);
      if (!walk(size, index + 1, selected)) return false;
      selected.pop();
    }
    return true;
  };
  for (let size = 1; size <= ids.length; size += 1) {
    if (!walk(size, 0, [])) break;
  }
  if (truncated) {
    diagnostics.push({
      code: "COMBAT_ACTIVATION_ENVELOPE_TRUNCATED",
      severity: "partial",
      message: `Activation enumeration was capped at ${limit} variants.`,
    });
  }
  return {
    items: variants,
    truncated,
    valid: true,
    diagnostics,
  };
}

function ruleSourceKey(source: CombatRuleSourceV1): string {
  return canonicalJson(source);
}

function compareRules(
  left: BundleCombatRuleRecordV1,
  right: BundleCombatRuleRecordV1,
): number {
  return (
    compareStrings(left.abilityId, right.abilityId) ||
    compareStrings(ruleSourceKey(left.source), ruleSourceKey(right.source)) ||
    compareStrings(left.entityHash, right.entityHash)
  );
}

function buffSource(
  rule: BundleCombatRuleRecordV1,
  participantSelectionId: string,
): BuffSource {
  const source = rule.source;
  switch (source.kind) {
    case "army":
      return {
        kind: "ability",
        abilityId: rule.abilityId,
        abilityKind: "army",
      };
    case "detachment":
      return {
        kind: "ability",
        abilityId: rule.abilityId,
        abilityKind: "detachment",
      };
    case "detachment-stratagem":
      return {
        kind: "ability",
        abilityId: rule.abilityId,
        abilityKind: "detachment-stratagem",
      };
    case "attached":
      return {
        kind: "ability",
        abilityId: rule.abilityId,
        abilityKind: "attached",
        sourceUnitId: source.sourceUnitId,
      };
    case "support":
      return {
        kind: "ability",
        abilityId: rule.abilityId,
        abilityKind: "support",
        sourceUnitId: source.sourceUnitId,
      };
    case "unit":
      return {
        kind: "ability",
        abilityId: rule.abilityId,
        abilityKind: "unit",
      };
    case "enhancement":
      return source.bearerSelectionId === participantSelectionId
        ? {
            kind: "ability",
            abilityId: rule.abilityId,
            abilityKind: "unit",
          }
        : {
            kind: "ability",
            abilityId: rule.abilityId,
            abilityKind: "attached",
            sourceUnitId: source.bearerUnitId,
          };
    case "wargear":
      return source.bearerSelectionId === participantSelectionId
        ? {
            kind: "ability",
            abilityId: rule.abilityId,
            abilityKind: "unit",
          }
        : {
            kind: "ability",
            abilityId: rule.abilityId,
            abilityKind: "attached",
            sourceUnitId: source.bearerUnitId,
          };
  }
}

function planAttachesSelection(
  plan: CombatAttachmentPlanV1,
  side: "attacker" | "target",
  selectionId: string,
): boolean {
  return plan[side].some((binding) =>
    [
      binding.leaderSelectionId,
      binding.bodyguardSelectionId,
      ...binding.supportSelectionIds,
    ].includes(selectionId),
  );
}

function knownBoolean(value: KnownOrUnknown<boolean>): boolean | undefined {
  return value === "unknown" ? undefined : value;
}

function knownNumber(value: KnownOrUnknown<number>): number | undefined {
  return value === "unknown" ? undefined : value;
}

function contextFor(
  cell: CombatBridgeCellInputV2,
  plan: CombatAttachmentPlanV1,
  perspective: TranslationPerspective,
): EngineContext {
  const scenario = cell.scenario;
  const explicitAttached =
    perspective === "attacker"
      ? scenario.attackerAttached
      : scenario.targetAttached;
  const participant =
    perspective === "attacker" ? cell.attacker : cell.target;
  const inferredAttached = planAttachesSelection(
    plan,
    perspective === "attacker" ? "attacker" : "target",
    participant.selectionId,
  );
  const attackerPerspective = perspective === "attacker";
  return {
    phase: scenario.phase,
    // EngineContext describes the unit whose rule is being translated as the
    // "attacker". The v2 scenario does not carry the defender's movement or
    // charge history, so target-side rules must leave those gates unknown.
    attackerStationary: attackerPerspective
      ? knownBoolean(scenario.attackerStationary)
      : undefined,
    attackerCharged: attackerPerspective
      ? knownBoolean(scenario.attackerCharged)
      : undefined,
    withinHalfRange: knownBoolean(scenario.withinHalfRange),
    distanceInches: knownNumber(scenario.distanceInches),
    attackerInCover: knownBoolean(
      attackerPerspective
        ? scenario.attackerInCover
        : scenario.targetInCover,
    ),
    targetInCover: knownBoolean(
      attackerPerspective
        ? scenario.targetInCover
        : scenario.attackerInCover,
    ),
    attackerKeywords: normalizedKeywords(
      attackerPerspective ? cell.attacker.keywords : cell.target.keywords,
    ),
    targetKeywords: normalizedKeywords(
      attackerPerspective ? cell.target.keywords : cell.attacker.keywords,
    ),
    timing: scenario.timing === "unknown" ? undefined : scenario.timing,
    attackerAttached:
      explicitAttached === "unknown" ? inferredAttached : explicitAttached,
  };
}

async function provenanceFor(
  rule: BundleCombatRuleRecordV1,
  perspective: TranslationPerspective,
  fragment: unknown,
): Promise<CombatEffectProvenanceV2> {
  return {
    abilityId: rule.abilityId,
    abilityName: rule.abilityName,
    entityHash: rule.entityHash,
    source: rule.source,
    perspective,
    ruleEffectSha256: await sha256Hex(canonicalJson(rule.effect)),
    fragmentSha256: await sha256Hex(canonicalJson(fragment)),
  };
}

async function fixedEffect(
  input: {
    rule: BundleCombatRuleRecordV1;
    perspective: TranslationPerspective;
    fragment: unknown;
    slot: string;
    status: CombatEffectStatus;
    reason: string;
  },
): Promise<CombatBridgeEffectV2> {
  const provenance = await provenanceFor(
    input.rule,
    input.perspective,
    input.fragment,
  );
  const effectId = await sha256Hex(
    canonicalJson({ provenance, slot: input.slot }),
  );
  return {
    effectId,
    status: input.status,
    reason: input.reason,
    contribution: null,
    applicableWhen: null,
    provenance,
  };
}

async function fixedContributionEffect(input: {
  rule: BundleCombatRuleRecordV1;
  perspective: TranslationPerspective;
  fragment: unknown;
  slot: string;
  status: CombatEffectStatus;
  reason: string | null;
  contribution: BuffContribution;
}): Promise<CombatBridgeEffectV2> {
  const provenance = await provenanceFor(
    input.rule,
    input.perspective,
    input.fragment,
  );
  const effectId = await sha256Hex(
    canonicalJson({ provenance, slot: input.slot }),
  );
  return {
    effectId,
    status: input.status,
    reason: input.reason,
    contribution: input.contribution,
    applicableWhen: null,
    provenance,
  };
}

function namespacedActivationId(
  perspective: TranslationPerspective,
  abilityId: string,
  activationId: string,
): string {
  return `${perspective}:${abilityId}:${activationId}`;
}

function namespacedActivationGroup(
  perspective: TranslationPerspective,
  group: { id: string; maxActivations: number } | undefined | null,
): CombatActivationGroupV1 | null {
  return group
    ? {
        id: `${perspective}:${group.id}`,
        maxActivations: group.maxActivations,
      }
    : null;
}

type TranslatorConformanceGap = {
  fragment: unknown;
  reason: string;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const TRACKED_BEARER_PATCH_NARROWING_KEYS = [
  "weapon_name",
  "weapon_profile",
  "weapon_keyword",
  "weapon_filter",
  "model_filter",
  "model_scope",
] as const;

function signedAdditiveModifier(
  modifier: Record<string, unknown>,
): number | null {
  const value = modifier.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  switch (modifier.operation) {
    case "add":
    case "improve":
      return value;
    case "subtract":
    case "worsen":
      return -value;
    default:
      return null;
  }
}

function effectContainsUnconditionalFragment(
  effect: unknown,
  fragment: unknown,
): boolean {
  if (effect === fragment) return true;
  const node = objectValue(effect);
  if (node?.type !== "sequence" || !Array.isArray(node.steps)) {
    return false;
  }
  return node.steps.some((step) =>
    effectContainsUnconditionalFragment(step, fragment),
  );
}

function phaseMatchesBearerPatch(
  modifier: Record<string, unknown>,
  phase: CombatPhaseV2,
): boolean | null {
  const attackType = modifier.attack_type ?? modifier.weapon_type;
  if (attackType === undefined) return true;
  if (attackType === "melee") return phase === "fight";
  if (attackType === "ranged") return phase === "shooting";
  return null;
}

/**
 * Pinned 40kdc correctly refuses to apply an attached member's model-scoped
 * effect to the combined unit. The tracked local adapter can, however, apply
 * additive Save/Toughness changes to that exact bearer selection. Recover
 * only that narrow, unconditional leaf here; all other model-scoped effects
 * remain omitted and therefore fail closed.
 */
function trackedBearerPatchContribution(input: {
  rule: BundleCombatRuleRecordV1;
  perspective: TranslationPerspective;
  ruleEffect: unknown;
  fragment: unknown;
  unsupportedReason: string;
  phase: CombatPhaseV2;
}): {
  contribution: Extract<
    BuffContribution,
    { type: "save-mod" | "toughness-mod" }
  >;
  applicable: boolean;
} | null {
  if (
    input.perspective !== "target" ||
    input.rule.activation.kind !== "always" ||
    (
      input.rule.source.kind !== "enhancement" &&
      input.rule.source.kind !== "wargear"
    ) ||
    !input.unsupportedReason.includes(
      "model-scoped effect from an attached model",
    ) ||
    !effectContainsUnconditionalFragment(
      input.ruleEffect,
      input.fragment,
    )
  ) {
    return null;
  }
  const fragment = objectValue(input.fragment);
  const modifier = objectValue(fragment?.modifier);
  if (
    !fragment ||
    !modifier ||
    (fragment.target !== "self" && fragment.target !== "bearer") ||
    TRACKED_BEARER_PATCH_NARROWING_KEYS.some(
      (key) => modifier[key] !== undefined && modifier[key] !== null,
    )
  ) {
    return null;
  }
  const applicable = phaseMatchesBearerPatch(modifier, input.phase);
  const value = signedAdditiveModifier(modifier);
  if (applicable === null || value === null) return null;
  if (
    fragment.type === "roll-modifier" &&
    modifier.roll === "save"
  ) {
    return {
      contribution: { type: "save-mod", value },
      applicable,
    };
  }
  if (fragment.type !== "stat-modifier") return null;
  if (modifier.stat === "T") {
    return {
      contribution: { type: "toughness-mod", value },
      applicable,
    };
  }
  if (modifier.stat === "Sv") {
    return {
      contribution: { type: "save-mod", value: -value },
      applicable,
    };
  }
  return null;
}

/**
 * Pinned 40kdc 1.2.1 evaluates a compound condition's operands without
 * honoring operand-level `negated: true`. That can silently remove a valid
 * buff or apply it to the exact target the operand excludes. Detect the shape
 * anywhere in the effect tree before translation so it can never receive
 * complete coverage by accident.
 */
function translatorConformanceGaps(
  effect: unknown,
): TranslatorConformanceGap[] {
  const gaps: TranslatorConformanceGap[] = [];
  const inspectCondition = (
    value: unknown,
    operandOfCompound: boolean,
  ): void => {
    const condition = objectValue(value);
    if (!condition) return;
    if (operandOfCompound && condition.negated === true) {
      gaps.push({
        fragment: condition,
        reason:
          "Pinned 40kdc 1.2.1 does not preserve negation on a nested compound-condition operand.",
      });
    }
    if (
      typeof condition.operator === "string" &&
      Array.isArray(condition.operands)
    ) {
      for (const operand of condition.operands) {
        inspectCondition(operand, true);
      }
    }
  };
  const visitEffect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visitEffect);
      return;
    }
    const node = objectValue(value);
    if (!node) return;
    if (node.condition !== undefined) {
      inspectCondition(node.condition, false);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "condition") visitEffect(child);
    }
  };
  visitEffect(effect);
  return gaps;
}

function composeOuterActivationLevers(
  input: {
    rule: BundleCombatRuleRecordV1;
    perspective: TranslationPerspective;
    applied: SourcedBuff[];
    activatable: ReturnType<typeof effectToBuffs>["activatable"];
    ruleEffectSha256: string;
    phaseMappingApproximated: boolean;
  },
): { levers: InternalLever[]; unsafeReason: string | null } {
  if (input.rule.activation.kind === "always") {
    return { levers: [], unsafeReason: null };
  }
  const outer = input.rule.activation;
  const outerGroup = namespacedActivationGroup(
    input.perspective,
    outer.group,
  );
  const inner = input.activatable.map((activation, activationIndex) => ({
    activation,
    group: namespacedActivationGroup(
      input.perspective,
      activation.group,
    ),
    buffs: activation.buffs.map((buff, buffIndex) => ({
      buff,
      rule: input.rule,
      perspective: input.perspective,
      ruleEffectSha256: input.ruleEffectSha256,
      slot: `activation:${activationIndex}:${buffIndex}`,
      phaseMappingApproximated: input.phaseMappingApproximated,
    })),
  }));
  if (inner.length === 0) {
    return {
      levers: input.applied.length === 0
        ? []
        : [{
            lever: {
              id: namespacedActivationId(
                input.perspective,
                input.rule.abilityId,
                outer.id,
              ),
              label: outer.label,
              group: outerGroup,
              cpCost: outer.cpCost,
            },
            buffs: input.applied,
          }],
      unsafeReason: null,
    };
  }

  const innerGroupKeys = new Set(
    inner.map(({ group }) =>
      group ? `${group.id}\u0000${group.maxActivations}` : "none",
    ),
  );
  const commonInnerGroup = innerGroupKeys.size === 1
    ? inner[0].group
    : null;
  let effectiveOuterGroup: CombatActivationGroupV1 | null = null;
  if (outerGroup) {
    if (inner.length === 1 || innerGroupKeys.size === 1) {
      if (
        inner.length > 1 &&
        commonInnerGroup &&
        outerGroup.maxActivations > commonInnerGroup.maxActivations
      ) {
        return {
          levers: [],
          unsafeReason:
            "The outer activation and inner choices require two independent group limits that the bridge cannot preserve atomically.",
        };
      }
      effectiveOuterGroup = outerGroup;
    } else {
      return {
        levers: [],
        unsafeReason:
          "The outer activation and inner choices require multiple independent activation groups that the bridge cannot preserve atomically.",
      };
    }
  }
  const maximumSelected = inner.length === 1
    ? 1
    : effectiveOuterGroup
      ? Math.min(inner.length, effectiveOuterGroup.maxActivations)
      : commonInnerGroup
        ? Math.min(inner.length, commonInnerGroup.maxActivations)
        : inner.length;
  if (outer.cpCost > 0 && maximumSelected > 1) {
    return {
      levers: [],
      unsafeReason:
        "The outer activation cost would be charged once per independently selectable inner option.",
    };
  }
  if (input.applied.length > 0 && maximumSelected > 1) {
    return {
      levers: [],
      unsafeReason:
        "The outer activation effects would be duplicated across independently selectable inner options.",
    };
  }
  return {
    levers: inner.map(({ activation, group, buffs }) => ({
      lever: {
        id: namespacedActivationId(
          input.perspective,
          input.rule.abilityId,
          activation.id,
        ),
        label: `${outer.label}: ${activation.label}`,
        group: effectiveOuterGroup ?? group,
        cpCost: outer.cpCost,
      },
      buffs: [...input.applied, ...buffs],
    })),
    unsafeReason: null,
  };
}

async function translateRules(
  rules: readonly BundleCombatRuleRecordV1[],
  perspective: TranslationPerspective,
  participantSelectionId: string,
  context: EngineContext,
  phase: CombatPhaseV2,
): Promise<TranslationResult> {
  const baseBuffs: SourcedBuff[] = [];
  const levers: InternalLever[] = [];
  const fixedEffects: CombatBridgeEffectV2[] = [];
  const diagnostics: CombatBridgeDiagnosticV2[] = [];

  for (const rule of [...rules].sort(compareRules)) {
    const ruleEffectSha256 = await sha256Hex(canonicalJson(rule.effect));
    const phaseMappingApproximated = rule.phaseMappingStatus === "missing";
    if (phaseMappingApproximated) {
      diagnostics.push({
        code: "COMBAT_RULE_PHASE_MAPPING_MISSING",
        severity: "partial",
        message: `Rule ${rule.abilityId} has no verified phase mapping; it was applied best-effort in the ${phase} cell.`,
      });
    }
    if (!phaseMappingApproximated && !rule.phases.includes(phase)) {
      fixedEffects.push(
        await fixedEffect({
          rule,
          perspective,
          fragment: rule.effect,
          slot: "phase-not-applicable",
          status: "not-applicable",
          reason: `The rule is not eligible in the ${phase} phase.`,
        }),
      );
      continue;
    }

    const conformanceGaps = translatorConformanceGaps(rule.effect);
    if (conformanceGaps.length > 0) {
      for (let index = 0; index < conformanceGaps.length; index += 1) {
        const gap = conformanceGaps[index];
        fixedEffects.push(
          await fixedEffect({
            rule,
            perspective,
            fragment: gap.fragment,
            slot: `translator-conformance:${index}`,
            status: "omitted",
            reason: gap.reason,
          }),
        );
      }
      diagnostics.push({
        code: "COMBAT_RULE_TRANSLATOR_CONFORMANCE_GAP",
        severity: "partial",
        message: `Rule ${rule.abilityId} contains ${conformanceGaps.length} DSL fragment(s) that pinned 40kdc 1.2.1 can silently mis-translate.`,
      });
      continue;
    }

    try {
      const translation = effectToBuffs(
        rule.effect,
        buffSource(rule, participantSelectionId),
        context,
        perspective,
      );
      const applied = translation.applied.map((buff, index) => ({
        buff,
        rule,
        perspective,
        ruleEffectSha256,
        slot: `applied:${index}`,
        phaseMappingApproximated,
      }));
      if (rule.activation.kind === "always") {
        baseBuffs.push(...applied);
      }

      if (rule.activation.kind === "always") {
        translation.activatable.forEach((activation, activationIndex) => {
          levers.push({
            lever: {
              id: namespacedActivationId(
                perspective,
                rule.abilityId,
                activation.id,
              ),
              label: activation.label,
              group: namespacedActivationGroup(
                perspective,
                activation.group,
              ),
              cpCost: 0,
            },
            buffs: activation.buffs.map((buff, buffIndex) => ({
              buff,
              rule,
              perspective,
              ruleEffectSha256,
              slot: `activation:${activationIndex}:${buffIndex}`,
              phaseMappingApproximated,
            })),
          });
        });
      } else {
        const composed = composeOuterActivationLevers({
          rule,
          perspective,
          applied,
          activatable: translation.activatable,
          ruleEffectSha256,
          phaseMappingApproximated,
        });
        if (composed.unsafeReason) {
          fixedEffects.push(
            await fixedEffect({
              rule,
              perspective,
              fragment: rule.effect,
              slot: "activation-composition",
              status: "omitted",
              reason: composed.unsafeReason,
            }),
          );
          diagnostics.push({
            code: "COMBAT_RULE_ACTIVATION_COMPOSITION_UNSUPPORTED",
            severity: "partial",
            message: `Rule ${rule.abilityId} cannot compose its outer activation with inner choices without changing costs or group limits.`,
          });
        } else {
          levers.push(...composed.levers);
        }
      }

      for (
        let index = 0;
        index < translation.unsupported.length;
        index += 1
      ) {
        const unsupported = translation.unsupported[index];
        const bearerPatch = trackedBearerPatchContribution({
          rule,
          perspective,
          ruleEffect: rule.effect,
          fragment: unsupported.effectFragment,
          unsupportedReason: unsupported.reason,
          phase,
        });
        if (bearerPatch) {
          fixedEffects.push(
            await fixedContributionEffect({
              rule,
              perspective,
              fragment: unsupported.effectFragment,
              slot: `tracked-bearer-patch:${index}`,
              status: bearerPatch.applicable
                ? phaseMappingApproximated
                  ? "approximated"
                  : "modeled"
                : "not-applicable",
              reason: bearerPatch.applicable
                ? phaseMappingApproximated
                  ? "The bearer patch was applied best-effort because its bundle phase mapping is missing."
                  : null
                : `The bearer patch does not apply in the ${phase} phase.`,
              contribution: bearerPatch.contribution,
            }),
          );
          continue;
        }
        const fragmentSha256 = await sha256Hex(
          canonicalJson(unsupported.effectFragment),
        );
        const relevance =
          rule.unsupportedFragmentRelevance?.[fragmentSha256] ??
          rule.unsupportedRelevance;
        fixedEffects.push(
          await fixedEffect({
            rule,
            perspective,
            fragment: unsupported.effectFragment,
            slot: `unsupported:${index}`,
            status:
              relevance === "non-combat"
                ? "not-applicable"
                : "omitted",
            reason: unsupported.reason,
          }),
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown translator failure.";
      fixedEffects.push(
        await fixedEffect({
          rule,
          perspective,
          fragment: rule.effect,
          slot: "translation-error",
          status: "omitted",
          reason: `The structured rule translator failed: ${message}`,
        }),
      );
      diagnostics.push({
        code: "COMBAT_RULE_TRANSLATION_FAILED",
        severity: "partial",
        message: `Rule ${rule.abilityId} could not be translated from the leased bundle: ${message}`,
      });
    }
  }
  return { baseBuffs, levers, fixedEffects, diagnostics };
}

function applicabilityStatus(
  applicableWhen: BuffApplicability | undefined,
  context: EngineContext,
): { status: "modeled" | "approximated" | "not-applicable"; reason: string | null } {
  if (!applicableWhen) return { status: "modeled", reason: null };
  if (
    applicableWhen.phases &&
    !applicableWhen.phases.includes(context.phase)
  ) {
    return {
      status: "not-applicable",
      reason: `The effect does not apply in the ${context.phase} phase.`,
    };
  }
  const attackerKeywords = new Set(
    normalizedKeywords(context.attackerKeywords ?? []),
  );
  const targetKeywords = new Set(
    normalizedKeywords(context.targetKeywords ?? []),
  );
  if (
    applicableWhen.requiresAttackerKeyword &&
    !attackerKeywords.has(
      applicableWhen.requiresAttackerKeyword.toLocaleLowerCase(),
    )
  ) {
    return {
      status: "not-applicable",
      reason: `The attacker lacks required keyword ${applicableWhen.requiresAttackerKeyword}.`,
    };
  }
  if (
    applicableWhen.requiresTargetKeyword &&
    !targetKeywords.has(
      applicableWhen.requiresTargetKeyword.toLocaleLowerCase(),
    )
  ) {
    return {
      status: "not-applicable",
      reason: `The target lacks required keyword ${applicableWhen.requiresTargetKeyword}.`,
    };
  }
  if (applicableWhen.maxRangeInches !== undefined) {
    if (context.distanceInches === undefined) {
      return {
        status: "approximated",
        reason: `Distance is unknown; upstream permissive range semantics include this <=${applicableWhen.maxRangeInches}-inch effect.`,
      };
    }
    if (context.distanceInches > applicableWhen.maxRangeInches) {
      return {
        status: "not-applicable",
        reason: `The target is outside the effect's ${applicableWhen.maxRangeInches}-inch range.`,
      };
    }
  }
  return { status: "modeled", reason: null };
}

async function effectFromBuff(
  sourced: SourcedBuff,
  context: EngineContext,
  active: boolean,
): Promise<{ effect: CombatBridgeEffectV2; include: boolean }> {
  const provenance: CombatEffectProvenanceV2 = {
    abilityId: sourced.rule.abilityId,
    abilityName: sourced.rule.abilityName,
    entityHash: sourced.rule.entityHash,
    source: sourced.rule.source,
    perspective: sourced.perspective,
    ruleEffectSha256: sourced.ruleEffectSha256,
    fragmentSha256: await sha256Hex(
      canonicalJson(sourced.buff.contribution),
    ),
  };
  const effectId = await sha256Hex(
    canonicalJson({
      provenance,
      slot: sourced.slot,
      applicableWhen: sourced.buff.applicableWhen ?? null,
    }),
  );
  if (!active) {
    return {
      include: false,
      effect: {
        effectId,
        status: "not-applicable",
        reason: "The optional activation is not enabled in this variant.",
        contribution: sourced.buff.contribution,
        applicableWhen: sourced.buff.applicableWhen ?? null,
        provenance,
      },
    };
  }
  if (
    sourced.buff.applicableWhen?.rollType &&
    sourced.buff.contribution.type === "reroll" &&
    sourced.buff.contribution.roll !==
      sourced.buff.applicableWhen.rollType
  ) {
    return {
      include: false,
      effect: {
        effectId,
        status: "not-applicable",
        reason: `The effect applies only to ${sourced.buff.applicableWhen.rollType} rolls.`,
        contribution: sourced.buff.contribution,
        applicableWhen: sourced.buff.applicableWhen,
        provenance,
      },
    };
  }
  const applicability = applicabilityStatus(
    sourced.buff.applicableWhen,
    context,
  );
  const status =
    sourced.phaseMappingApproximated && applicability.status === "modeled"
      ? "approximated"
      : applicability.status;
  const reason =
    sourced.phaseMappingApproximated && applicability.status === "modeled"
      ? "The rule was applied best-effort because its bundle phase mapping is missing."
      : applicability.reason;
  return {
    include: status !== "not-applicable",
    effect: {
      effectId,
      status,
      reason,
      contribution: sourced.buff.contribution,
      applicableWhen: sourced.buff.applicableWhen ?? null,
      provenance,
    },
  };
}

function resolvedBuff(buff: Buff): Buff {
  if (!buff.applicableWhen) return buff;
  const resolved = { ...buff };
  delete resolved.applicableWhen;
  return resolved;
}

function coverageFrom(
  effects: readonly CombatBridgeEffectV2[],
  diagnostics: readonly CombatBridgeDiagnosticV2[] = [],
): CombatCoverageV2 {
  const modeledEffects = effects.filter(
    (effect) => effect.status === "modeled",
  ).length;
  const approximatedEffects = effects.filter(
    (effect) => effect.status === "approximated",
  ).length;
  const omittedEffects = effects.filter(
    (effect) => effect.status === "omitted",
  ).length;
  const notApplicableEffects = effects.filter(
    (effect) => effect.status === "not-applicable",
  ).length;
  const unusable = diagnostics.some(
    (diagnostic) => diagnostic.severity === "unusable",
  );
  const partial =
    !unusable &&
    (approximatedEffects > 0 ||
      omittedEffects > 0 ||
      diagnostics.some((diagnostic) => diagnostic.severity === "partial"));
  return {
    status: unusable ? "unusable" : partial ? "partial" : "complete",
    claimEligibility: unusable
      ? "none"
      : partial
        ? "provisional"
        : "decision-grade",
    modeledEffects,
    approximatedEffects,
    omittedEffects,
    notApplicableEffects,
    reasons: sortedUnique([
      ...effects.flatMap((effect) =>
        effect.status === "approximated" || effect.status === "omitted"
          ? [effect.reason ?? effect.status]
          : [],
      ),
      ...diagnostics.map((diagnostic) => diagnostic.message),
    ]),
  };
}

function aggregateCoverage(
  coverages: readonly CombatCoverageV2[],
  diagnostics: readonly CombatBridgeDiagnosticV2[] = [],
): CombatCoverageV2 {
  const status = diagnostics.some(
    (diagnostic) => diagnostic.severity === "unusable",
  ) || coverages.some((coverage) => coverage.status === "unusable")
    ? "unusable"
    : diagnostics.some((diagnostic) => diagnostic.severity === "partial") ||
        coverages.some((coverage) => coverage.status === "partial")
      ? "partial"
      : "complete";
  return {
    status,
    claimEligibility:
      status === "unusable"
        ? "none"
        : status === "partial"
          ? "provisional"
          : "decision-grade",
    modeledEffects: coverages.reduce(
      (total, coverage) => total + coverage.modeledEffects,
      0,
    ),
    approximatedEffects: coverages.reduce(
      (total, coverage) => total + coverage.approximatedEffects,
      0,
    ),
    omittedEffects: coverages.reduce(
      (total, coverage) => total + coverage.omittedEffects,
      0,
    ),
    notApplicableEffects: coverages.reduce(
      (total, coverage) => total + coverage.notApplicableEffects,
      0,
    ),
    reasons: sortedUnique([
      ...coverages.flatMap((coverage) => coverage.reasons),
      ...diagnostics.map((diagnostic) => diagnostic.message),
    ]).filter(Boolean),
  };
}

type CombatBridgeVariantHashFields = Pick<
  CombatBridgeVariantV2,
  | "attachmentPlan"
  | "activation"
  | "effects"
  | "resolvedByPerspective"
  | "resolved"
  | "coverage"
>;

export async function combatBridgeVariantSha256(
  variant: CombatBridgeVariantHashFields,
): Promise<string> {
  return sha256Hex(canonicalJson({
    attachmentPlan: variant.attachmentPlan,
    activation: variant.activation,
    effects: variant.effects,
    resolvedByPerspective: variant.resolvedByPerspective,
    resolved: variant.resolved,
    coverage: variant.coverage,
  }));
}

async function combatBridgeVariantIndexSha256(
  variants: readonly CombatBridgeVariantV2[],
): Promise<string> {
  return sha256Hex(canonicalJson(
    variants.map((variant) => ({
      variantId: variant.variantId,
      variantSha256: variant.variantSha256,
    })),
  ));
}

type CombatBridgeCellHashFields = Pick<
  CombatBridgeCellV2,
  | "cellId"
  | "direction"
  | "metric"
  | "mechanicsSha256"
  | "scenarioSha256"
  | "attacker"
  | "target"
  | "coverage"
  | "diagnostics"
  | "variantIndexSha256"
  | "availableActivationIds"
> & { variants: readonly CombatBridgeVariantV2[] };

async function combatBridgeMechanicsSha256(
  cell: Omit<
    CombatBridgeCellHashFields,
    "cellId" | "direction" | "metric" | "mechanicsSha256"
  >,
): Promise<string> {
  return sha256Hex(canonicalJson({
    hashContractVersion: COMBAT_BRIDGE_HASH_CONTRACT_VERSION,
    scenarioSha256: cell.scenarioSha256,
    attacker: cell.attacker,
    target: cell.target,
    variantCount: cell.variants.length,
    variantIndexSha256: cell.variantIndexSha256,
    availableActivationIds: cell.availableActivationIds,
    coverage: cell.coverage,
    diagnostics: cell.diagnostics,
  }));
}

export async function combatBridgeCellSha256(
  cell: CombatBridgeCellHashFields,
): Promise<string> {
  return sha256Hex(canonicalJson({
    hashContractVersion: COMBAT_BRIDGE_HASH_CONTRACT_VERSION,
    cellId: cell.cellId,
    direction: cell.direction,
    metric: cell.metric,
    mechanicsSha256: cell.mechanicsSha256,
    scenarioSha256: cell.scenarioSha256,
    attacker: cell.attacker,
    target: cell.target,
    variantCount: cell.variants.length,
    variantIndexSha256: cell.variantIndexSha256,
    availableActivationIds: cell.availableActivationIds,
    coverage: cell.coverage,
    diagnostics: cell.diagnostics,
  }));
}

async function combatBridgeCellIndexSha256(
  cells: readonly CombatBridgeCellV2[],
): Promise<string> {
  return sha256Hex(canonicalJson(
    cells.map((cell) => ({
      cellId: cell.cellId,
      cellSha256: cell.cellSha256,
    })),
  ));
}

type CombatBridgeHashFields = Pick<
  CombatBridgeV2,
  | "schemaVersion"
  | "kind"
  | "compiler"
  | "bundle"
  | "policySha256"
  | "coverage"
  | "coverageUnit"
  | "diagnostics"
  | "cellIndexSha256"
> & { cells: readonly CombatBridgeCellV2[] };

export async function combatBridgeSha256(
  bridge: CombatBridgeHashFields,
): Promise<string> {
  return sha256Hex(canonicalJson({
    hashContractVersion: COMBAT_BRIDGE_HASH_CONTRACT_VERSION,
    schemaVersion: bridge.schemaVersion,
    kind: bridge.kind,
    compiler: bridge.compiler,
    bundle: bridge.bundle,
    policySha256: bridge.policySha256,
    cellCount: bridge.cells.length,
    cellIndexSha256: bridge.cellIndexSha256,
    coverage: bridge.coverage,
    coverageUnit: bridge.coverageUnit,
    diagnostics: bridge.diagnostics,
  }));
}

async function compileVariant(
  input: {
    cell: CombatBridgeCellInputV2;
    ruleVariant: CombatCellRuleVariantInputV2;
    activation: CombatActivationVariantV1;
    attackerTranslation: TranslationResult;
    targetTranslation: TranslationResult;
    diagnostics: CombatBridgeDiagnosticV2[];
  },
): Promise<CombatBridgeVariantV2> {
  const attackerContext = contextFor(
    input.cell,
    input.ruleVariant.attachmentPlan,
    "attacker",
  );
  const targetContext = contextFor(
    input.cell,
    input.ruleVariant.attachmentPlan,
    "target",
  );
  const translations = [
    input.attackerTranslation,
    input.targetTranslation,
  ];
  const fixedEffects = translations.flatMap(
    (translation) => translation.fixedEffects,
  );
  const activeIds = new Set(input.activation.activeIds);
  const buffEntries = translations.flatMap((translation) => [
    ...translation.baseBuffs.map((buff) => ({ buff, active: true })),
    ...translation.levers.flatMap((lever) =>
      lever.buffs.map((buff) => ({
        buff,
        active: activeIds.has(lever.lever.id),
      })),
    ),
  ]);
  const mapped = await Promise.all(
    buffEntries.map(({ buff, active }) =>
      effectFromBuff(
        buff,
        buff.perspective === "attacker"
          ? attackerContext
          : targetContext,
        active,
      ),
    ),
  );
  const includedBuffs = buffEntries.flatMap((entry, index) =>
    mapped[index].include ? [resolvedBuff(entry.buff.buff)] : [],
  );
  const includedAttackerBuffs = buffEntries.flatMap((entry, index) =>
    mapped[index].include && entry.buff.perspective === "attacker"
      ? [resolvedBuff(entry.buff.buff)]
      : [],
  );
  const includedTargetBuffs = buffEntries.flatMap((entry, index) =>
    mapped[index].include && entry.buff.perspective === "target"
      ? [resolvedBuff(entry.buff.buff)]
      : [],
  );
  const effects = [
    ...fixedEffects,
    ...mapped.map((entry) => entry.effect),
  ].sort((left, right) => compareStrings(left.effectId, right.effectId));
  const diagnostics = [
    ...input.diagnostics,
    ...translations.flatMap((translation) => translation.diagnostics),
  ];
  const coverage = coverageFrom(effects, diagnostics);
  const resolvedByPerspective = {
    attacker: resolveBuffs(includedAttackerBuffs, attackerContext),
    target: resolveBuffs(includedTargetBuffs, targetContext),
  };
  const resolved = resolveBuffs(includedBuffs, attackerContext);
  const variantCore = {
    attachmentPlan: normalizePlan(input.ruleVariant.attachmentPlan),
    activation: input.activation,
    effects,
    resolvedByPerspective,
    resolved,
    coverage,
  };
  const variantSha256 = await combatBridgeVariantSha256(variantCore);
  return {
    variantId: variantSha256.slice(0, 24),
    variantSha256,
    ...variantCore,
  };
}

async function compileCell(
  cell: CombatBridgeCellInputV2,
  policy: CombatPolicyV1,
): Promise<CombatBridgeCellV2> {
  const maximumJointVariants = Math.max(
    1,
    Math.min(
      MAX_COMBAT_JOINT_VARIANTS,
      policy.limits?.maxJointVariants ?? MAX_COMBAT_JOINT_VARIANTS,
    ),
  );
  const scenarioSha256 = await sha256Hex(canonicalJson(cell.scenario));
  const attachmentEnvelope = enumerateAttachmentEnvelope(
    cell.ruleVariants,
    policy,
  );
  const diagnostics = [...attachmentEnvelope.diagnostics];
  const availableActivationIds = new Set<string>();
  const joint: Array<{
    ruleVariant: CombatCellRuleVariantInputV2;
    activation: CombatActivationVariantV1;
    attackerTranslation: TranslationResult;
    targetTranslation: TranslationResult;
    diagnostics: CombatBridgeDiagnosticV2[];
  }> = [];

  for (
    const ruleVariant of attachmentEnvelope.valid
      ? attachmentEnvelope.items
      : []
  ) {
    const attackerContext = contextFor(
      cell,
      ruleVariant.attachmentPlan,
      "attacker",
    );
    const targetContext = contextFor(
      cell,
      ruleVariant.attachmentPlan,
      "target",
    );
    const [attackerTranslation, targetTranslation] = await Promise.all([
      translateRules(
        ruleVariant.attackerRules,
        "attacker",
        cell.attacker.selectionId,
        attackerContext,
        cell.scenario.phase,
      ),
      translateRules(
        ruleVariant.targetRules,
        "target",
        cell.target.selectionId,
        targetContext,
        cell.scenario.phase,
      ),
    ]);
    const levers = [
      ...attackerTranslation.levers,
      ...targetTranslation.levers,
    ];
    for (const lever of levers) {
      availableActivationIds.add(lever.lever.id);
    }
    const activationEnvelope = enumerateActivationEnvelope(
      levers.map((lever) => lever.lever),
      policy,
      maximumJointVariants,
    );
    diagnostics.push(...activationEnvelope.diagnostics);
    if (!activationEnvelope.valid) continue;
    for (const activation of activationEnvelope.items) {
      joint.push({
        ruleVariant,
        activation,
        attackerTranslation,
        targetTranslation,
        diagnostics: activationEnvelope.diagnostics,
      });
    }
  }

  joint.sort(
    (left, right) =>
      left.activation.activeIds.length - right.activation.activeIds.length ||
      Number(isEmptyPlan(right.ruleVariant.attachmentPlan)) -
        Number(isEmptyPlan(left.ruleVariant.attachmentPlan)) ||
      compareStrings(
        left.ruleVariant.attachmentPlan.id,
        right.ruleVariant.attachmentPlan.id,
      ) ||
      compareStrings(left.activation.id, right.activation.id),
  );
  if (joint.length > maximumJointVariants) {
    diagnostics.push({
      code: "COMBAT_JOINT_ENVELOPE_TRUNCATED",
      severity: "partial",
      message: `The joint attachment/effect envelope was capped at ${maximumJointVariants} variants.`,
    });
  }
  const variants = await Promise.all(
    joint
      .slice(0, maximumJointVariants)
      .map((entry) => compileVariant({ cell, ...entry })),
  );
  const coverage = aggregateCoverage(
    variants.map((variant) => variant.coverage),
    diagnostics,
  );
  const mechanicsCore = {
    scenarioSha256,
    attacker: {
      ...cell.attacker,
      keywords: normalizedKeywords(cell.attacker.keywords),
    },
    target: {
      ...cell.target,
      keywords: normalizedKeywords(cell.target.keywords),
    },
    scenario: cell.scenario,
    variants,
    availableActivationIds: sortedUnique([
      ...availableActivationIds,
    ]),
    coverage,
    diagnostics,
  };
  const variantIndexSha256 = await combatBridgeVariantIndexSha256(
    variants,
  );
  const mechanicsSha256 = await combatBridgeMechanicsSha256({
    ...mechanicsCore,
    variantIndexSha256,
  });
  const hashableCell = {
    cellId: cell.cellId,
    direction: cell.direction,
    metric: cell.metric,
    mechanicsSha256,
    ...mechanicsCore,
    variantIndexSha256,
  };
  const cellSha256 = await combatBridgeCellSha256(hashableCell);
  return { ...hashableCell, cellSha256 };
}

async function combatCellCompileCacheSha256(
  cell: CombatBridgeCellInputV2,
): Promise<string> {
  return sha256Hex(canonicalJson({
    attacker: cell.attacker,
    target: cell.target,
    scenario: cell.scenario,
    ruleVariants: cell.ruleVariants,
  }));
}

async function aliasCompiledCombatCell(
  cell: CombatBridgeCellInputV2,
  compiled: CombatBridgeCellV2,
): Promise<CombatBridgeCellV2> {
  if (
    cell.cellId === compiled.cellId &&
    cell.direction === compiled.direction &&
    cell.metric === compiled.metric
  ) {
    return compiled;
  }
  const { cellSha256: _cellSha256, ...compiledCore } = compiled;
  void _cellSha256;
  const aliasedCore = {
    ...compiledCore,
    cellId: cell.cellId,
    direction: cell.direction,
    metric: cell.metric,
  };
  return {
    ...aliasedCore,
    cellSha256: await combatBridgeCellSha256(aliasedCore),
  };
}

/**
 * Metric projections may describe identical combat mechanics. Compile those
 * mechanics once and share their immutable variant/effect arrays while still
 * retaining a distinct cell id and cell hash for every requested projection.
 */
async function compileCells(
  input: CompileCombatBridgeInputV2,
): Promise<CombatBridgeCellV2[]> {
  const sortedCells = [...input.cells].sort((left, right) =>
    compareStrings(left.cellId, right.cellId),
  );
  const compiledByMechanics = new Map<
    string,
    Promise<CombatBridgeCellV2>
  >();
  const compiled: Array<Promise<CombatBridgeCellV2>> = [];
  for (const cell of sortedCells) {
    const compileCacheSha256 = await combatCellCompileCacheSha256(cell);
    let shared = compiledByMechanics.get(compileCacheSha256);
    if (!shared) {
      shared = compileCell(cell, input.policy);
      compiledByMechanics.set(compileCacheSha256, shared);
    }
    compiled.push(
      shared.then((compiledCell) =>
        aliasCompiledCombatCell(cell, compiledCell),
      ),
    );
  }
  return Promise.all(compiled);
}

function validateCompileInput(
  input: CompileCombatBridgeInputV2,
): CombatBridgeDiagnosticV2[] {
  const diagnostics: CombatBridgeDiagnosticV2[] = [];
  if (
    !input.bundle.bundleId ||
    !input.bundle.playerRosterId ||
    !input.bundle.opponentRosterId ||
    !input.bundle.playerRosterFingerprint ||
    !input.bundle.opponentRosterFingerprint ||
    !input.bundle.playerFactionId ||
    !input.bundle.opponentFactionId ||
    !input.bundle.playerRosterRulesHash ||
    !input.bundle.opponentRosterRulesHash ||
    !input.bundle.playerFactionRulesHash ||
    !input.bundle.opponentFactionRulesHash ||
    !input.bundle.playerMappingHash ||
    !input.bundle.opponentMappingHash
  ) {
    diagnostics.push({
      code: "COMBAT_BUNDLE_IDENTITY_INCOMPLETE",
      severity: "unusable",
      message: "The combat bridge requires complete bundle and semantic rules identities.",
    });
  }
  if (input.bundle.semanticAuthority === "roster-asserted") {
    diagnostics.push({
      code: "COMBAT_BUNDLE_SEMANTIC_BINDING_UNVERIFIED",
      severity: "partial",
      message:
        "The combat bridge was compiled from a captured Dataset without a bundle manifest; its retained semantic hashes are roster assertions and cannot support decision-grade claims.",
    });
  } else if (
    input.bundle.semanticAuthority !== "bundle-manifest-verified"
  ) {
    diagnostics.push({
      code: "COMBAT_BUNDLE_SEMANTIC_AUTHORITY_INVALID",
      severity: "unusable",
      message: "The combat bridge semantic-authority binding is invalid.",
    });
  }
  if (
    !Number.isInteger(input.bundle.engineDataSchemaVersion) ||
    input.bundle.engineDataSchemaVersion < 1
  ) {
    diagnostics.push({
      code: "COMBAT_BUNDLE_SCHEMA_INVALID",
      severity: "unusable",
      message: "The bundle engine-data schema version is invalid.",
    });
  }
  if (input.policy.schemaVersion !== COMBAT_POLICY_SCHEMA_VERSION) {
    diagnostics.push({
      code: "COMBAT_POLICY_SCHEMA_UNSUPPORTED",
      severity: "unusable",
      message: `Combat policy schema ${input.policy.schemaVersion} is unsupported.`,
    });
  }
  if (
    input.policy.limits &&
    (
      !Number.isInteger(input.policy.limits.maxAttachmentPlans) ||
      input.policy.limits.maxAttachmentPlans < 1 ||
      input.policy.limits.maxAttachmentPlans >
        MAX_COMBAT_ATTACHMENT_PLANS ||
      !Number.isInteger(input.policy.limits.maxJointVariants) ||
      input.policy.limits.maxJointVariants < 1 ||
      input.policy.limits.maxJointVariants > MAX_COMBAT_JOINT_VARIANTS
    )
  ) {
    diagnostics.push({
      code: "COMBAT_POLICY_LIMITS_INVALID",
      severity: "unusable",
      message:
        `Combat policy limits must be within 1-${MAX_COMBAT_ATTACHMENT_PLANS} attachment plans and 1-${MAX_COMBAT_JOINT_VARIANTS} joint variants.`,
    });
  }
  if (
    input.policy.resourceBudget &&
    (!Number.isInteger(input.policy.resourceBudget.cp) ||
      input.policy.resourceBudget.cp < 0)
  ) {
    diagnostics.push({
      code: "COMBAT_RESOURCE_BUDGET_INVALID",
      severity: "unusable",
      message: "The combat policy CP budget must be a non-negative integer.",
    });
  }
  if (input.cells.length === 0) {
    diagnostics.push({
      code: "COMBAT_CELLS_MISSING",
      severity: "unusable",
      message: "At least one directional combat cell is required.",
    });
  }
  const cellIds = new Set<string>();
  for (const cell of input.cells) {
    if (!cell.cellId || cellIds.has(cell.cellId)) {
      diagnostics.push({
        code: "COMBAT_CELL_ID_INVALID",
        severity: "unusable",
        message: `Combat cell id ${JSON.stringify(cell.cellId)} is empty or duplicated.`,
      });
    }
    cellIds.add(cell.cellId);
  }
  return diagnostics;
}

function activationPolicyDiagnostics(
  policy: CombatPolicyV1,
  cells: readonly CombatBridgeCellV2[],
): CombatBridgeDiagnosticV2[] {
  if (!policy.activationConstraints) return [];
  const available = new Set(
    cells.flatMap((cell) => cell.availableActivationIds),
  );
  const declared = new Set(
    policy.activationConstraints.options.map((option) => option.id),
  );
  return [
    ...policy.activationConstraints.options.flatMap((option) =>
      available.has(option.id)
        ? []
        : [{
            code: "COMBAT_ACTIVATION_POLICY_OPTION_UNRESOLVED",
            severity: "unusable" as const,
            message: `Activation policy option ${JSON.stringify(option.id)} does not match any bundle-discovered activation lever in this bridge.`,
          }],
    ),
    ...policy.selectedActivationIds.flatMap((id) =>
      declared.has(id)
        ? []
        : [{
            code: "COMBAT_ACTIVATION_POLICY_SELECTION_UNDECLARED",
            severity: "unusable" as const,
            message: `Selected activation ${JSON.stringify(id)} is absent from the frozen activation option catalogue.`,
          }],
    ),
  ];
}

export async function compileCombatBridgeV2(
  input: CompileCombatBridgeInputV2,
): Promise<CombatBridgeV2> {
  const diagnostics = validateCompileInput(input);
  const policySha256 = await sha256Hex(canonicalJson(input.policy));
  const cells = await compileCells(input);
  diagnostics.push(...activationPolicyDiagnostics(input.policy, cells));
  const coverageCells = [
    ...new Map(
      cells.map((cell) => [cell.mechanicsSha256, cell]),
    ).values(),
  ];
  const coverage = aggregateCoverage(
    coverageCells.map((cell) => cell.coverage),
    diagnostics,
  );
  const bridgeCore = {
    schemaVersion: COMBAT_BRIDGE_SCHEMA_VERSION,
    kind: "rosterpilot-combat-bridge" as const,
    compiler: {
      version: COMBAT_BRIDGE_COMPILER_VERSION,
      effectVocabularyVersion: COMBAT_EFFECT_VOCABULARY_VERSION,
      hashContractVersion: COMBAT_BRIDGE_HASH_CONTRACT_VERSION,
      rulesCompiler: COMBAT_RULES_COMPILER,
    },
    bundle: input.bundle,
    policy: input.policy,
    policySha256,
    cells,
    coverage,
    coverageUnit: "unique-mechanics-cell" as const,
    diagnostics,
  };
  const cellIndexSha256 = await combatBridgeCellIndexSha256(cells);
  const hashableBridge = { ...bridgeCore, cellIndexSha256 };
  const bridgeSha256 = await combatBridgeSha256(hashableBridge);
  return { ...hashableBridge, bridgeSha256 };
}

/**
 * Verifies the Merkle-style bridge identity without serializing the complete
 * bridge. Every effect remains bound by its variant hash, then by the ordered
 * variant, cell, and bridge index hashes.
 */
export async function verifyCombatBridgeV2Hash(
  bridge: CombatBridgeV2,
): Promise<boolean> {
  if (
    bridge.schemaVersion !== COMBAT_BRIDGE_SCHEMA_VERSION ||
    bridge.kind !== "rosterpilot-combat-bridge" ||
    bridge.coverageUnit !== "unique-mechanics-cell" ||
    bridge.compiler.hashContractVersion !==
      COMBAT_BRIDGE_HASH_CONTRACT_VERSION ||
    await sha256Hex(canonicalJson(bridge.policy)) !==
      bridge.policySha256
  ) {
    return false;
  }
  for (const cell of bridge.cells) {
    if (
      await sha256Hex(canonicalJson(cell.scenario)) !==
        cell.scenarioSha256
    ) {
      return false;
    }
    for (const variant of cell.variants) {
      const variantSha256 = await combatBridgeVariantSha256(variant);
      if (
        variant.variantSha256 !== variantSha256 ||
        variant.variantId !== variantSha256.slice(0, 24)
      ) {
        return false;
      }
    }
    const variantIndexSha256 =
      await combatBridgeVariantIndexSha256(cell.variants);
    const mechanicsSha256 = await combatBridgeMechanicsSha256({
      ...cell,
      variantIndexSha256,
    });
    if (
      cell.variantIndexSha256 !== variantIndexSha256 ||
      cell.mechanicsSha256 !== mechanicsSha256 ||
      cell.cellSha256 !== await combatBridgeCellSha256({
        ...cell,
        mechanicsSha256,
        variantIndexSha256,
      })
    ) {
      return false;
    }
  }
  const cellIndexSha256 = await combatBridgeCellIndexSha256(
    bridge.cells,
  );
  return (
    bridge.cellIndexSha256 === cellIndexSha256 &&
    bridge.bridgeSha256 === await combatBridgeSha256({
      ...bridge,
      cellIndexSha256,
    })
  );
}
