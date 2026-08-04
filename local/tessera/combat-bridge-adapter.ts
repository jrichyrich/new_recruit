import { createHash } from "node:crypto";

import type { BuffContribution, WeaponKeywordRef } from "@alpaca-software/40kdc-data";

import {
  tesseraAdapterSupportForContribution,
  type CombatBridgeEffectV2,
  type CombatBridgeCellV2,
  type CombatBridgeVariantV2,
  type CombatClaimEligibility,
  type CombatCoverageV2,
  type CombatCoverageStatus,
  type CombatPhaseV2,
} from "../../lib/rosterpilot/combat-bridge";
import type { CombatBridgeV3 } from "../../lib/rosterpilot/combat-bridge-v3";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import type {
  TesseraDefenderUnitPatchV2,
} from "./tessera-adapter-v2";

export const TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION =
  "combat-bridge-v2-v3-to-tessera-effects-v2" as const;

type TesseraReroll = "ones" | "failed" | "all";

export type TesseraEngineEffectModsV1 = {
  hitModifier?: number;
  woundModifier?: number;
  apBonus?: number;
  damageBonus?: number;
  strengthBonus?: number;
  attackBonus?: number;
  reroll?: {
    hit?: TesseraReroll;
    wound?: TesseraReroll;
  };
  grantKeywords?: string[];
  fnp?: number;
  damageReduction?: number;
  invuln?: number;
  saveReroll?: TesseraReroll;
  toughBonus?: number;
};

export type TesseraEngineEffectV1 = {
  id: string;
  name: string;
  source: "ability";
  side: "attacker" | "defender";
  phase: CombatPhaseV2;
  mods: TesseraEngineEffectModsV1;
};

export type TesseraEngineOptionsPatchV1 = {
  /** Present only when a resolved bridge contribution grants cover. */
  targetInCover?: true;
};

export type TesseraAdapterOmissionV1 = {
  effectId: string;
  abilityId: string;
  abilityName: string;
  origin: "bridge" | "adapter";
  code: string;
  contributionType: BuffContribution["type"] | null;
  reason: string;
  /** True when executing without the mechanic would produce false evidence. */
  blocking: boolean;
};

export type TesseraAdapterCoverageV1 = {
  status: CombatCoverageStatus;
  claimEligibility: CombatClaimEligibility;
  bridgeStatus: CombatCoverageStatus;
  projectedBridgeEffects: number;
  approximatedBridgeEffects: number;
  adapterOmissions: number;
  reasons: string[];
};

export type TesseraCombatBridgeProjectionV2 = {
  schemaVersion: 2;
  adapterVersion: typeof TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION;
  bridgeVariantId: string;
  bridgeVariantSha256: string;
  phase: CombatPhaseV2;
  projectedBridgeEffectIds: string[];
  engineEffects: TesseraEngineEffectV1[];
  unitPatches: TesseraDefenderUnitPatchV2[];
  optionsPatch: TesseraEngineOptionsPatchV1;
  omissions: TesseraAdapterOmissionV1[];
  coverage: TesseraAdapterCoverageV1;
  /** Hash of only the mechanics consumed by Tessera, excluding provenance. */
  executionSha256: string;
  projectionSha256: string;
};

/** @deprecated Projection v2 supersedes the ephemeral v1 adapter shape. */
export type TesseraCombatBridgeProjectionV1 =
  TesseraCombatBridgeProjectionV2;

export type TesseraCombatBridgeCellProjectionV2 = {
  schemaVersion: 2;
  adapterVersion: typeof TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION;
  bridgeCellId: string;
  bridgeCellSha256: string;
  phase: CombatPhaseV2;
  variants: TesseraCombatBridgeProjectionV2[];
  /** Number of distinct Tessera executions after mechanics deduplication. */
  uniqueExecutionCount: number;
  coverage: TesseraAdapterCoverageV1;
  projectionSha256: string;
};

/**
 * Bridge v3 intentionally retains the exact executable v2 cell shape while
 * adding corpus and replay admission evidence around the bridge as a whole.
 */
export type TesseraCompatibleCombatBridgeCell =
  | CombatBridgeCellV2
  | CombatBridgeV3["cells"][number];

/** @deprecated Projection v2 supersedes the ephemeral v1 adapter shape. */
export type TesseraCombatBridgeCellProjectionV1 =
  TesseraCombatBridgeCellProjectionV2;

export type TesseraVariantOutcomeV1 = {
  variantId: string;
  value: number;
};

export type TesseraVariantOutcomePointV1 = {
  value: number;
  variantIds: string[];
};

export type TesseraVariantOutcomeSummaryV1 = {
  count: number;
  medianMethod: "lower-nearest-rank";
  min: TesseraVariantOutcomePointV1;
  median: TesseraVariantOutcomePointV1;
  max: TesseraVariantOutcomePointV1;
};

const SIMPLE_KEYWORDS = new Set([
  "ASSAULT",
  "BLAST",
  "CLEAVE",
  "DEVASTATING WOUNDS",
  "EXTRA ATTACKS",
  "HEAVY",
  "IGNORES COVER",
  "INDIRECT FIRE",
  "LANCE",
  "LETHAL HITS",
  "ONE SHOT",
  "PISTOL",
  "PRECISION",
  "PSYCHIC",
  "TORRENT",
  "TWIN-LINKED",
]);
const VALUE_KEYWORDS = new Set([
  "BLAST",
  "CLEAVE",
  "MELTA",
  "RAPID FIRE",
  "SUSTAINED HITS",
]);

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function contentSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function keywordBase(keywordId: string): string {
  const normalized = keywordId
    .trim()
    .replaceAll("_", "-")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .toLocaleUpperCase();
  return normalized === "TWIN LINKED" ? "TWIN-LINKED" : normalized;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : null;
}

/** Converts a 40kdc keyword reference into the pinned Tessera spelling. */
export function tesseraKeywordFromRef(
  keywordRef: WeaponKeywordRef,
): string | null {
  const base = keywordBase(keywordRef.keyword_id);
  const parameters = keywordRef.parameters ?? {};
  if (base === "ANTI") {
    const target =
      typeof parameters.target_keyword === "string"
        ? parameters.target_keyword
        : typeof parameters.targetKeyword === "string"
          ? parameters.targetKeyword
          : null;
    const threshold = finiteInteger(parameters.threshold);
    if (!target || threshold === null || threshold < 2 || threshold > 6) {
      return null;
    }
    return `ANTI-${target.trim().toLocaleUpperCase()} ${threshold}+`;
  }
  if (VALUE_KEYWORDS.has(base)) {
    const value = finiteInteger(parameters.value);
    if (value === null) {
      return SIMPLE_KEYWORDS.has(base) ? base : null;
    }
    if (value < 1) return null;
    return `${base} ${value}`;
  }
  if (Object.keys(parameters).length > 0 || !SIMPLE_KEYWORDS.has(base)) {
    return null;
  }
  return base;
}

function rerollSubset(
  subset: "ones" | "all-failures",
): TesseraReroll {
  return subset === "ones" ? "ones" : "failed";
}

function sourceIsBearerScoped(effect: CombatBridgeEffectV2): boolean {
  return (
    effect.provenance.source.kind === "enhancement" ||
    effect.provenance.source.kind === "wargear"
  );
}

function omission(
  effect: CombatBridgeEffectV2,
  origin: TesseraAdapterOmissionV1["origin"],
  code: string,
  reason: string,
  blocking = false,
): TesseraAdapterOmissionV1 {
  return {
    effectId: effect.effectId,
    abilityId: effect.provenance.abilityId,
    abilityName: effect.provenance.abilityName,
    origin,
    code,
    contributionType: effect.contribution?.type ?? null,
    reason,
    blocking,
  };
}

function adapterOmissionFor(
  effect: CombatBridgeEffectV2,
): TesseraAdapterOmissionV1 | null {
  if (effect.status === "omitted") {
    return omission(
      effect,
      "bridge",
      "TESSERA_BRIDGE_EFFECT_OMITTED",
      effect.reason ?? "The bundle rules bridge could not model this effect.",
    );
  }
  if (effect.status === "not-applicable") return null;
  const contribution = effect.contribution;
  if (!contribution) {
    return omission(
      effect,
      "adapter",
      "TESSERA_BRIDGE_CONTRIBUTION_MISSING",
      "An active bridge effect has no typed contribution.",
    );
  }
  if (
    (contribution.type === "save-mod" ||
      contribution.type === "toughness-mod") &&
    effect.provenance.perspective !== "target"
  ) {
    return omission(
      effect,
      "adapter",
      "TESSERA_DEFENSIVE_STAT_PERSPECTIVE_INVALID",
      `A ${contribution.type} contribution did not resolve under the target perspective.`,
      true,
    );
  }
  if (
    (contribution.type === "save-mod" ||
      contribution.type === "toughness-mod") &&
    !Number.isFinite(contribution.value)
  ) {
    return omission(
      effect,
      "adapter",
      "TESSERA_DEFENSIVE_STAT_MODIFIER_INVALID",
      `A ${contribution.type} contribution has a non-finite modifier.`,
      true,
    );
  }
  if (contribution.type === "reroll" && contribution.roll === "damage") {
    return omission(
      effect,
      "adapter",
      "TESSERA_DAMAGE_REROLL_UNSUPPORTED",
      "The pinned Tessera engine cannot reroll weapon Damage rolls.",
      true,
    );
  }
  if (
    contribution.type === "feel-no-pain" &&
    contribution.scope === "mortal"
  ) {
    return omission(
      effect,
      "adapter",
      "TESSERA_MORTAL_FNP_UNSUPPORTED",
      "The pinned Tessera engine has no mortal-only Feel No Pain channel.",
      true,
    );
  }
  if (contribution.type === "extra-keyword") {
    if (!tesseraKeywordFromRef(contribution.keywordRef)) {
      return omission(
        effect,
        "adapter",
        "TESSERA_GRANTED_KEYWORD_UNSUPPORTED",
        `The pinned Tessera engine cannot represent granted keyword ${JSON.stringify(contribution.keywordRef.keyword_id)} with these parameters.`,
      );
    }
    return null;
  }
  return tesseraAdapterSupportForContribution(contribution) === "deferred"
    ? omission(
        effect,
        "adapter",
        "TESSERA_CONTRIBUTION_DEFERRED",
        `Contribution ${contribution.type} has no conformance-approved Tessera mapping.`,
      )
    : null;
}

function activeEffects(
  variant: CombatBridgeVariantV2,
): CombatBridgeEffectV2[] {
  return variant.effects.filter(
    (effect) =>
      effect.status === "modeled" || effect.status === "approximated",
  );
}

function effectHasProjectedContribution(
  effect: CombatBridgeEffectV2,
  omissions: ReadonlySet<string>,
): boolean {
  return (
    (effect.status === "modeled" || effect.status === "approximated") &&
    effect.contribution !== null &&
    !omissions.has(effect.effectId)
  );
}

function attackerMods(
  variant: CombatBridgeVariantV2,
  keywords: readonly string[],
): TesseraEngineEffectModsV1 {
  const resolved = variant.resolvedByPerspective.attacker;
  const mods: TesseraEngineEffectModsV1 = {};
  // Hit and wound modifiers cap only after offensive bonuses and incoming
  // defensive penalties are combined. The bridge-wide resolver performs that
  // final +/-1 cap; adding the independently capped perspectives can yield 2.
  const hitModifier = variant.resolved.hitMod.value;
  const woundModifier = variant.resolved.woundMod.value;
  if (hitModifier) mods.hitModifier = hitModifier;
  if (woundModifier) mods.woundModifier = woundModifier;
  if (resolved.apMod.value) mods.apBonus = -resolved.apMod.value;
  if (resolved.damageMod.value) mods.damageBonus = resolved.damageMod.value;
  if (resolved.strengthMod.value) {
    mods.strengthBonus = resolved.strengthMod.value;
  }
  if (resolved.attacksMod.value) mods.attackBonus = resolved.attacksMod.value;
  const hitReroll = resolved.rerolls.hit;
  const woundReroll = resolved.rerolls.wound;
  if (hitReroll || woundReroll) {
    mods.reroll = {
      ...(hitReroll
        ? { hit: rerollSubset(hitReroll.subset) }
        : {}),
      ...(woundReroll
        ? { wound: rerollSubset(woundReroll.subset) }
        : {}),
    };
  }
  if (keywords.length > 0) mods.grantKeywords = [...keywords];
  return mods;
}

function defenderMods(
  variant: CombatBridgeVariantV2,
): TesseraEngineEffectModsV1 {
  const resolved = variant.resolvedByPerspective.target;
  const mods: TesseraEngineEffectModsV1 = {};
  if (resolved.feelNoPain) mods.fnp = resolved.feelNoPain.threshold;
  if (resolved.damageReduction.value) {
    // 40kdc has already applied highest-wins precedence. Emit one aggregate
    // value because Tessera's effect resolver otherwise adds multiple sources.
    mods.damageReduction = resolved.damageReduction.value;
  }
  if (resolved.invulnerable) {
    mods.invuln = resolved.invulnerable.threshold;
  }
  const saveReroll = resolved.rerolls.save;
  if (saveReroll) mods.saveReroll = rerollSubset(saveReroll.subset);
  return mods;
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function projectedKeywords(
  variant: CombatBridgeVariantV2,
  omittedEffectIds: ReadonlySet<string>,
): string[] {
  const allowedRefs = activeEffects(variant)
    .filter(
      (effect) =>
        effect.contribution?.type === "extra-keyword" &&
        !omittedEffectIds.has(effect.effectId),
    )
    .map(
      (effect) =>
        (effect.contribution as Extract<
          BuffContribution,
          { type: "extra-keyword" }
        >).keywordRef,
    );
  const allowedKeys = new Set(allowedRefs.map((ref) => canonicalJson(ref)));
  return sortedUnique(
    variant.resolved.extraKeywords.flatMap(({ keywordRef }) => {
      if (!allowedKeys.has(canonicalJson(keywordRef))) return [];
      const keyword = tesseraKeywordFromRef(keywordRef);
      return keyword ? [keyword] : [];
    }),
  );
}

function projectedDefenderStatPatches(
  variant: CombatBridgeVariantV2,
  omittedEffectIds: ReadonlySet<string>,
): TesseraDefenderUnitPatchV2[] {
  type PatchAccumulator = {
    scope: TesseraDefenderUnitPatchV2["scope"];
    bearerSelectionId: string | null;
    saveModifier: number;
    toughnessModifier: number;
    effectIds: string[];
  };
  const patches = new Map<string, PatchAccumulator>();
  for (const effect of activeEffects(variant)) {
    if (
      omittedEffectIds.has(effect.effectId) ||
      effect.provenance.perspective !== "target" ||
      (
        effect.contribution?.type !== "save-mod" &&
        effect.contribution?.type !== "toughness-mod"
      )
    ) {
      continue;
    }
    const bearerScoped = sourceIsBearerScoped(effect);
    const bearerSelectionId = bearerScoped &&
      (
        effect.provenance.source.kind === "enhancement" ||
        effect.provenance.source.kind === "wargear"
      )
      ? effect.provenance.source.bearerSelectionId
      : null;
    const scope = bearerScoped ? "bearer" : "unit-wide";
    const key = `${scope}\u0000${bearerSelectionId ?? ""}`;
    const patch = patches.get(key) ?? {
      scope,
      bearerSelectionId,
      saveModifier: 0,
      toughnessModifier: 0,
      effectIds: [],
    };
    if (effect.contribution.type === "save-mod") {
      patch.saveModifier += effect.contribution.value;
    } else {
      patch.toughnessModifier += effect.contribution.value;
    }
    patch.effectIds.push(effect.effectId);
    patches.set(key, patch);
  }
  return [...patches.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .flatMap(([key, patch]) => {
      const effectIds = sortedUnique(patch.effectIds);
      if (!patch.saveModifier && !patch.toughnessModifier) return [];
      return [{
        id: contentSha256({
          adapterVersion: TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION,
          variantId: variant.variantId,
          key,
          effectIds,
        }),
        side: "defender" as const,
        scope: patch.scope,
        bearerSelectionId: patch.bearerSelectionId,
        ...(patch.saveModifier
          ? { saveModifier: patch.saveModifier }
          : {}),
        ...(patch.toughnessModifier
          ? { toughnessModifier: patch.toughnessModifier }
          : {}),
        effectIds,
      }];
    });
}

function coverageFor(
  variant: CombatBridgeVariantV2,
  omissions: readonly TesseraAdapterOmissionV1[],
  projectedBridgeEffects: number,
  parentCoverage: CombatCoverageV2 = variant.coverage,
): TesseraAdapterCoverageV1 {
  const approximatedBridgeEffects = variant.effects.filter(
    (effect) => effect.status === "approximated",
  ).length;
  const blockingOmission = omissions.some((entry) => entry.blocking);
  const status: CombatCoverageStatus =
    blockingOmission ||
    parentCoverage.status === "unusable" ||
    variant.coverage.status === "unusable"
      ? "unusable"
      : omissions.length > 0 ||
          approximatedBridgeEffects > 0 ||
          parentCoverage.status === "partial" ||
          variant.coverage.status === "partial"
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
    bridgeStatus: parentCoverage.status,
    projectedBridgeEffects,
    approximatedBridgeEffects,
    adapterOmissions: omissions.length,
    reasons: sortedUnique([
      ...parentCoverage.reasons,
      ...variant.coverage.reasons,
      ...omissions.map((entry) => entry.reason),
      ...variant.effects.flatMap((effect) =>
        effect.status === "approximated" && effect.reason
          ? [effect.reason]
          : [],
      ),
    ]),
  };
}

/**
 * Projects one already-resolved bridge variant. The aggregate engine effects
 * deliberately use `variant.resolved` so 40kdc precedence (notably highest-
 * wins damage reduction) is not changed by Tessera's additive effect gatherer.
 * Apply `engineEffects` through Tessera's resolveEffects/applyToSim path and
 * merge `optionsPatch` into the scenario options; do not apply both a second
 * per-source effect list and this resolved aggregate.
 */
export function projectCombatBridgeVariantToTessera(input: {
  variant: CombatBridgeVariantV2;
  phase: CombatPhaseV2;
  /** Pass cell/bridge coverage so envelope truncation cannot be hidden. */
  parentCoverage?: CombatCoverageV2;
}): TesseraCombatBridgeProjectionV2 {
  const { variant, phase } = input;
  const omissions = variant.effects
    .map(adapterOmissionFor)
    .filter((entry): entry is TesseraAdapterOmissionV1 => entry !== null)
    .sort(
      (left, right) =>
        compareStrings(left.effectId, right.effectId) ||
        compareStrings(left.code, right.code),
    );
  const omittedEffectIds = new Set(omissions.map((entry) => entry.effectId));
  const projectedBridgeEffectIds = variant.effects
    .filter((effect) =>
      effectHasProjectedContribution(effect, omittedEffectIds),
    )
    .map((effect) => effect.effectId)
    .sort(compareStrings);
  const keywords = projectedKeywords(variant, omittedEffectIds);
  const unitPatches = projectedDefenderStatPatches(
    variant,
    omittedEffectIds,
  );
  const attacker = attackerMods(variant, keywords);
  const defender = defenderMods(variant);
  const engineEffects: TesseraEngineEffectV1[] = [
    ...(hasKeys(attacker)
      ? [
          {
            id: `${variant.variantId}:attacker`,
            name: "RosterPilot resolved attacker effects",
            source: "ability" as const,
            side: "attacker" as const,
            phase,
            mods: attacker,
          },
        ]
      : []),
    ...(hasKeys(defender)
      ? [
          {
            id: `${variant.variantId}:defender`,
            name: "RosterPilot resolved defender effects",
            source: "ability" as const,
            side: "defender" as const,
            phase,
            mods: defender,
          },
        ]
      : []),
  ];
  const hasProjectedCover = variant.effects.some(
    (effect) =>
      effect.provenance.perspective === "target" &&
      effectHasProjectedContribution(effect, omittedEffectIds) &&
      effect.contribution?.type === "cover",
  );
  const optionsPatch: TesseraEngineOptionsPatchV1 = hasProjectedCover
    ? { targetInCover: true }
    : {};
  const coverage = coverageFor(
    variant,
    omissions,
    projectedBridgeEffectIds.length,
    input.parentCoverage,
  );
  const executionSha256 = contentSha256({
    adapterVersion: TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION,
    phase,
    engineEffects: engineEffects.map((effect) => ({
      side: effect.side,
      phase: effect.phase,
      mods: effect.mods,
    })),
    optionsPatch,
    unitPatches: unitPatches.map((patch) => ({
      side: patch.side,
      scope: patch.scope,
      bearerSelectionId: patch.bearerSelectionId,
      saveModifier: patch.saveModifier ?? 0,
      toughnessModifier: patch.toughnessModifier ?? 0,
    })),
  });
  const core = {
    schemaVersion: 2 as const,
    adapterVersion: TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION,
    bridgeVariantId: variant.variantId,
    bridgeVariantSha256: variant.variantSha256,
    phase,
    projectedBridgeEffectIds,
    engineEffects,
    unitPatches,
    optionsPatch,
    omissions,
    coverage,
    executionSha256,
  };
  return { ...core, projectionSha256: contentSha256(core) };
}

function aggregateProjectionCoverage(
  cell: TesseraCompatibleCombatBridgeCell,
  variants: readonly TesseraCombatBridgeProjectionV1[],
): TesseraAdapterCoverageV1 {
  const status: CombatCoverageStatus =
    cell.coverage.status === "unusable" ||
    variants.some((variant) => variant.coverage.status === "unusable")
      ? "unusable"
      : cell.coverage.status === "partial" ||
          variants.some((variant) => variant.coverage.status === "partial")
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
    bridgeStatus: cell.coverage.status,
    projectedBridgeEffects: variants.reduce(
      (total, variant) =>
        total + variant.coverage.projectedBridgeEffects,
      0,
    ),
    approximatedBridgeEffects: variants.reduce(
      (total, variant) =>
        total + variant.coverage.approximatedBridgeEffects,
      0,
    ),
    adapterOmissions: variants.reduce(
      (total, variant) => total + variant.coverage.adapterOmissions,
      0,
    ),
    reasons: sortedUnique([
      ...cell.coverage.reasons,
      ...variants.flatMap((variant) => variant.coverage.reasons),
    ]),
  };
}

export function projectCombatBridgeCellToTessera(
  cell: TesseraCompatibleCombatBridgeCell,
): TesseraCombatBridgeCellProjectionV2 {
  const variants = cell.variants.map((variant) =>
    projectCombatBridgeVariantToTessera({
      variant,
      phase: cell.scenario.phase,
      parentCoverage: cell.coverage,
    }),
  );
  const coverage = aggregateProjectionCoverage(cell, variants);
  const core = {
    schemaVersion: 2 as const,
    adapterVersion: TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION,
    bridgeCellId: cell.cellId,
    bridgeCellSha256: cell.cellSha256,
    phase: cell.scenario.phase,
    variants,
    uniqueExecutionCount: new Set(
      variants.map((variant) => variant.executionSha256),
    ).size,
    coverage,
  };
  return { ...core, projectionSha256: contentSha256(core) };
}

/**
 * Returns actual variant points rather than averaging two middle variants.
 * For an even count the lower nearest-rank outcome is the deterministic median.
 */
export function summarizeTesseraVariantOutcomes(
  outcomes: readonly TesseraVariantOutcomeV1[],
): TesseraVariantOutcomeSummaryV1 | null {
  if (outcomes.length === 0) return null;
  const byId = new Map<string, number>();
  for (const outcome of outcomes) {
    if (!outcome.variantId) {
      throw new TypeError("A Tessera variant outcome must have a non-empty id.");
    }
    if (!Number.isFinite(outcome.value)) {
      throw new TypeError(
        `Tessera variant ${JSON.stringify(outcome.variantId)} has a non-finite outcome.`,
      );
    }
    const prior = byId.get(outcome.variantId);
    if (prior !== undefined && prior !== outcome.value) {
      throw new TypeError(
        `Tessera variant ${JSON.stringify(outcome.variantId)} has conflicting outcomes.`,
      );
    }
    byId.set(outcome.variantId, outcome.value);
  }
  const ordered = [...byId].map(([variantId, value]) => ({
    variantId,
    value,
  })).sort(
    (left, right) =>
      left.value - right.value ||
      compareStrings(left.variantId, right.variantId),
  );
  const point = (value: number): TesseraVariantOutcomePointV1 => ({
    value,
    variantIds: ordered
      .filter((outcome) => Object.is(outcome.value, value))
      .map((outcome) => outcome.variantId)
      .sort(compareStrings),
  });
  const medianIndex = Math.floor((ordered.length - 1) / 2);
  return {
    count: ordered.length,
    medianMethod: "lower-nearest-rank",
    min: point(ordered[0].value),
    median: point(ordered[medianIndex].value),
    max: point(ordered[ordered.length - 1].value),
  };
}
