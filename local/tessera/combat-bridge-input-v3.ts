import {
  parseKeywordGrant,
  type Dataset,
} from "@alpaca-software/40kdc-data";

import {
  COMBAT_RULES_COMPILER,
  type BundleCombatRuleRecordV1,
  type CombatPhaseV2,
  type CombatRuleSourceV1,
  type CompileCombatBridgeInputV2,
} from "../../lib/rosterpilot/combat-bridge";
import {
  COMBAT_BRIDGE_V3_COMPILER_VERSION,
  compileCombatBridgeV3,
  type BundleCombatRuleRecordV3,
  type CombatBridgeCellInputV3,
  type CompileCombatBridgeInputV3,
} from "../../lib/rosterpilot/combat-bridge-v3";
import {
  buildCombatSourceLeafInventoryV1,
  createCombatCorpusConformanceReportV1,
  createCombatSemanticsOverlayV1,
  evaluateCombatCorpusStrictAdmissionV1,
  type CombatCorpusComponentIdentityV1,
  type CombatCorpusCommunityIdentityV1,
  type CombatCorpusConformanceReportV1,
  type CombatCorpusEffectFragmentV1,
  type CombatCorpusEntityKindV1,
  type CombatCorpusSourceEntityInputV1,
  type CombatLeafAccountingV1,
  type CombatOverlaySourceBindingV1,
  type CombatSemanticsOverlayEntryV1,
  type CombatSemanticsOverlayV1,
  type CombatSourceLeafInventoryV1,
} from "../../lib/rosterpilot/combat-corpus-conformance";
import type {
  DataBundleSnapshot,
} from "../../lib/rosterpilot/data-bundle";
import type {
  RuntimeDataBundleShardDataV1,
} from "../../lib/rosterpilot/runtime-data-bundle";
import {
  canonicalJson,
  sha256Hex,
} from "../../lib/rosterpilot/semantic-hash";
import type {
  ProfilePolicyV1,
  RosterDraftV1,
} from "../../lib/rosterpilot/types";
import {
  compileCombatBridgeInputV2FromDataset,
  compileCombatBridgeInputV2FromSnapshot,
  runtimeDatasetFromSnapshot,
} from "./combat-bridge-input";
import {
  CONSERVATIVE_COMBAT_CORPUS_REVIEWED_STORE_V1,
  verifyCombatCorpusReviewedStoreV1,
  type CombatCorpusReviewEvidenceV1,
  type CombatCorpusReviewedEntryV1,
  type CombatCorpusReviewedMatcherV1,
  type CombatCorpusReviewedStoreV1,
} from "./combat-corpus-reviewed-overlay";
import {
  localInputSha256,
} from "./local-engine-input";
import {
  LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION,
  LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT,
  compileRosterForLocalTesseraEngineV2,
  serializeLocalTesseraEngineInputV2,
  type LocalTesseraEngineInputV2,
} from "./local-engine-input-v2";
import {
  canonicalTesseraScenarioPolicyContractV2,
  type TesseraCombatPolicyV2,
  type TesseraEngagementContextV2,
  type TesseraScenarioPolicyContractV2,
} from "./scenario-contract-v2";
import {
  canonicalTesseraScenarioPolicyContractV3,
  TESSERA_SCENARIO_V3_STATE_KEYS,
  tesseraScenarioPolicyContractV3Sha256,
  type TesseraCombatPolicyV3,
  type TesseraPairPhysicalStateV3,
  type TesseraScenarioEntryV3,
  type TesseraScenarioPolicyContractV3,
  type TesseraScenarioSide,
  type TesseraUnitPhysicalStateV3,
} from "./scenario-contract-v3";
import {
  TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION,
  tesseraKeywordFromRef,
} from "./combat-bridge-adapter";
import {
  TRACKED_TESSERA_ADAPTER_V2_VERSION,
} from "./tessera-adapter-v2";
import { normalizeProfileIdentity } from "./profile-policy";

export const COMBAT_CORPUS_PREPARER_VERSION =
  "runtime-corpus-to-bridge-v3-v1" as const;

type RuntimeComponents = {
  compiler: CombatCorpusComponentIdentityV1;
  adapter: CombatCorpusComponentIdentityV1;
  engine: CombatCorpusComponentIdentityV1;
};

export type CombatBridgeInputV3RuntimeIdentityOverrides = Partial<
  RuntimeComponents & { community: CombatCorpusCommunityIdentityV1 }
>;

export type CombatBridgeInputV3LocalInputs = {
  player: LocalTesseraEngineInputV2;
  opponent: LocalTesseraEngineInputV2;
};

type PreparationCommon = {
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
  scenarioPolicy: TesseraScenarioPolicyContractV3;
  localInputs: CombatBridgeInputV3LocalInputs;
  reviewedStore?: CombatCorpusReviewedStoreV1;
  runtimeIdentities?: CombatBridgeInputV3RuntimeIdentityOverrides;
};

export type PrepareCombatBridgeInputV3FromSnapshotInput =
  PreparationCommon & {
    snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
  };

export type PrepareCombatBridgeInputV3FromDatasetInput =
  PreparationCommon & {
    dataset: Dataset;
  };

export type CombatCorpusTranslationLedgerEntryV1 = {
  leafId: string;
  sourceId: string;
  reviewEntryId: string;
  matcher: CombatCorpusReviewedMatcherV1 | "exact-leaf";
  phases: CombatPhaseV2[];
  stateKeys: string[];
  mechanicIds: string[];
  disposition:
    | "modeled"
    | "state-required"
    | "out-of-calculator-scope"
    | "not-applicable";
};

export type PreparedCombatBridgeInputV3 = {
  input: CompileCombatBridgeInputV3;
  nativeInputV2: CompileCombatBridgeInputV2;
  inventory: CombatSourceLeafInventoryV1;
  overlay: CombatSemanticsOverlayV1;
  report: CombatCorpusConformanceReportV1;
  reviewedStore: CombatCorpusReviewedStoreV1;
  translationLedger: CombatCorpusTranslationLedgerEntryV1[];
  identities: {
    rulesSemanticSha256: string;
    sourceInventorySha256: string;
    reviewedStoreSha256: string;
    overlaySha256: string;
    reportSha256: string;
    community: CombatCorpusCommunityIdentityV1;
    compiler: CombatCorpusComponentIdentityV1;
    adapter: CombatCorpusComponentIdentityV1;
    engine: CombatCorpusComponentIdentityV1;
  };
  replayBindings: NonNullable<CompileCombatBridgeInputV3["replay"]>;
};

export type CombatBridgeInputV3PreparationArtifact = {
  inventory: CombatSourceLeafInventoryV1;
  overlay: CombatSemanticsOverlayV1;
  report: CombatCorpusConformanceReportV1;
};

export class CombatBridgeInputV3PreparationError extends Error {
  readonly code:
    | "COMBAT_CORPUS_REVIEW_STORE_INVALID"
    | "COMBAT_CORPUS_SCENARIO_POLICY_UNREPRESENTABLE"
    | "COMBAT_CORPUS_SCENARIO_SCOPE_MISMATCH"
    | "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH"
    | "COMBAT_CORPUS_RULE_SOURCE_CONFLICT"
    | "COMBAT_CORPUS_RULE_SOURCE_EMPTY"
    | "COMBAT_CORPUS_WARGEAR_BINDING_INVALID"
    | "COMBAT_CORPUS_REVIEW_REQUIRED"
    | "COMBAT_CORPUS_SNAPSHOT_REQUIRED";
  readonly artifact: CombatBridgeInputV3PreparationArtifact | null;

  constructor(
    code: CombatBridgeInputV3PreparationError["code"],
    message: string,
    artifact: CombatBridgeInputV3PreparationArtifact | null = null,
  ) {
    super(message);
    this.name = "CombatBridgeInputV3PreparationError";
    this.code = code;
    this.artifact = artifact;
  }
}

type SourceContext = {
  sourceId: string;
  factionId: string;
  rule: BundleCombatRuleRecordV1;
  phases: CombatPhaseV2[];
  wargearReviewEntry: Extract<
    CombatCorpusReviewedEntryV1,
    { kind: "wargear-ability-binding" }
  > | null;
};

type ReviewedLeafResolution = {
  reviewEntryId: string;
  matcher: CombatCorpusReviewedMatcherV1 | "exact-leaf";
  phases: CombatPhaseV2[];
  stateKeys: string[];
  mechanicIds: string[];
  disposition:
    | "modeled"
    | "out-of-calculator-scope"
    | "not-applicable";
  reason: string | null;
  evidence: CombatCorpusReviewEvidenceV1;
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasNarrowing(modifier: Record<string, unknown>): boolean {
  return [
    "weapon_name",
    "weapon_profile",
    "weapon_keyword",
    "weapon_filter",
    "model_filter",
    "model_scope",
  ].some((key) => modifier[key] !== undefined && modifier[key] !== null);
}

function hasUnreviewedLeafSemantics(node: Record<string, unknown>): boolean {
  return ["condition", "conditions", "scaling"].some(
    (key) => node[key] !== undefined && node[key] !== null,
  );
}

function additiveOperation(value: unknown): boolean {
  return value === "add" || value === "subtract" ||
    value === "improve" || value === "worsen";
}

function simpleUnitTarget(value: unknown): boolean {
  return value === "unit" || value === "attached-unit";
}

function mechanicForMatcher(input: {
  matcher: CombatCorpusReviewedMatcherV1;
  node: Record<string, unknown>;
  source: CombatRuleSourceV1;
}): string[] | null {
  const modifier = objectRecord(input.node.modifier);
  if (hasUnreviewedLeafSemantics(input.node)) return null;
  switch (input.matcher) {
    case "simple-additive-stat-modifier-v1": {
      if (
        input.node.type !== "stat-modifier" ||
        !modifier ||
        hasNarrowing(modifier) ||
        !additiveOperation(modifier.operation) ||
        finiteNumber(modifier.value) === null
      ) {
        return null;
      }
      const stat = modifier.stat;
      const ordinaryTarget = simpleUnitTarget(input.node.target);
      const exactBearerTarget =
        (input.node.target === "self" || input.node.target === "bearer") &&
        (input.source.kind === "enhancement" ||
          input.source.kind === "wargear") &&
        (stat === "T" || stat === "Sv");
      if (!ordinaryTarget && !exactBearerTarget) return null;
      switch (stat) {
        case "A":
          return ordinaryTarget ? ["attacks-mod"] : null;
        case "S":
          return ordinaryTarget ? ["strength-mod"] : null;
        case "AP":
          return ordinaryTarget ? ["ap-mod"] : null;
        case "T":
          return ["toughness-mod"];
        case "Sv":
          return ["save-mod"];
        default:
          return null;
      }
    }
    case "simple-additive-roll-modifier-v1": {
      if (
        input.node.type !== "roll-modifier" ||
        !modifier ||
        hasNarrowing(modifier) ||
        !additiveOperation(modifier.operation) ||
        finiteNumber(modifier.value) === null
      ) {
        return null;
      }
      const roll = modifier.roll;
      if (input.node.target === "attacker") {
        return roll === "hit" || roll === "wound"
          ? [`${roll}-mod`]
          : null;
      }
      if (!simpleUnitTarget(input.node.target)) return null;
      return roll === "hit" || roll === "wound" || roll === "save" ||
          roll === "damage"
        ? [`${roll}-mod`]
        : null;
    }
    case "simple-reroll-v1": {
      if (
        input.node.type !== "re-roll" ||
        !modifier ||
        hasNarrowing(modifier) ||
        !simpleUnitTarget(input.node.target)
      ) {
        return null;
      }
      const roll = modifier.roll;
      const subset = modifier.value === 1 ? "ones" : modifier.subset;
      return (roll === "hit" || roll === "wound" || roll === "save") &&
          (subset === "ones" || subset === "all-failures")
        ? [`${roll}-reroll`]
        : null;
    }
    case "simple-feel-no-pain-v1": {
      const threshold = modifier ? finiteNumber(modifier.threshold) : null;
      return input.node.type === "feel-no-pain" &&
          modifier !== null &&
          simpleUnitTarget(input.node.target) &&
          threshold !== null && threshold >= 2 && threshold <= 7 &&
          (modifier.scope === undefined || modifier.scope === "all")
        ? ["feel-no-pain"]
        : null;
    }
    case "simple-flat-damage-reduction-v1": {
      const reduction = modifier ? finiteNumber(modifier.reduction) : null;
      return input.node.type === "damage-reduction" &&
          modifier !== null &&
          simpleUnitTarget(input.node.target) &&
          reduction !== null && reduction > 0
        ? ["damage-reduction"]
        : null;
    }
    case "simple-invulnerable-save-v1": {
      const threshold = modifier ? finiteNumber(modifier.invuln_sv) : null;
      return input.node.type === "invulnerable-save" &&
          modifier !== null &&
          simpleUnitTarget(input.node.target) &&
          threshold !== null && threshold >= 2 && threshold <= 7
        ? ["invulnerable-save"]
        : null;
    }
    case "simple-keyword-grant-v1": {
      if (
        input.node.type !== "keyword-grant" ||
        !modifier ||
        hasNarrowing(modifier) ||
        !simpleUnitTarget(input.node.target) ||
        (modifier.weapon_type !== undefined &&
          modifier.weapon_type !== "melee" &&
          modifier.weapon_type !== "ranged")
      ) {
        return null;
      }
      const keywords = [
        ...(typeof modifier.keyword === "string" ? [modifier.keyword] : []),
        ...(Array.isArray(modifier.keywords)
          ? modifier.keywords.filter(
              (value): value is string => typeof value === "string",
            )
          : []),
      ];
      if (keywords.length === 0) return null;
      const exact = keywords.every((keyword) => {
        const parsed = parseKeywordGrant(keyword);
        return parsed !== null && tesseraKeywordFromRef(parsed) !== null;
      });
      return exact ? keywords.map((keyword) => `keyword:${keyword}`) : null;
    }
    case "simple-bs-modifier-v1":
      return input.node.type === "bs-modifier" &&
          input.node.target === "attacker" &&
          modifier !== null &&
          additiveOperation(modifier.operation) &&
          finiteNumber(modifier.value) !== null
        ? ["hit-mod"]
        : null;
    case "noncombat-movement-v1":
      return input.node.type === "movement-modifier"
        ? ["movement-only"]
        : null;
  }
}

function decodeJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map((token) =>
    token.replaceAll("~1", "/").replaceAll("~0", "~")
  );
}

function valueAtEffectPointer(effect: unknown, pointer: string): unknown {
  const tokens = decodeJsonPointer(pointer);
  if (tokens[0] !== "effect") return undefined;
  let current = effect;
  for (const token of tokens.slice(1)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) return undefined;
      current = current[Number(token)];
      continue;
    }
    const record = objectRecord(current);
    if (!record || !(token in record)) return undefined;
    current = record[token];
  }
  return current;
}

function stateKeysForCondition(condition: unknown): string[] | null {
  const node = objectRecord(condition);
  if (!node) return null;
  if (typeof node.operator === "string" && Array.isArray(node.operands)) {
    // The pinned translator has known nested-negation gaps. Compound review is
    // therefore explicit-only even if every individual predicate is known.
    return null;
  }
  switch (node.type) {
    case "phase-is":
    case "target-has-keyword":
    case "unit-has-keyword":
    case "attack-is-type":
    case "is-attached":
      return [];
    case "timing-is":
      return ["timing"];
    case "opponent-unit-within-range":
    case "unit-within-range-of":
      return ["pair.distanceInches", "pair.withinRange"];
    // CombatScenarioContextV2 retains these values, but the pinned structured
    // translator does not consume all of them and only exposes movement and
    // charge history for the attacking perspective. Every roster unit also
    // appears as a target in the reverse-direction cells, so admitting any of
    // these predicates would overstate exactness for part of the corpus.
    case "charged-this-turn":
    case "remained-stationary":
    case "advanced-this-turn":
    case "made-ingress-move-this-turn":
    case "unit-below-starting-strength":
    case "unit-below-half-strength":
    case "has-lost-wounds":
    case "wounds-remaining-at-or-below":
    case "is-battle-shocked":
    case "controls-objective":
      return null;
    default:
      return null;
  }
}

function stateKeysForAncestors(input: {
  source: SourceContext;
  inventory: CombatSourceLeafInventoryV1;
  ancestorFragmentIds: readonly string[];
}): string[] | null {
  const fragments = new Map(
    input.inventory.fragments.map((fragment) => [fragment.fragmentId, fragment]),
  );
  const stateKeys: string[] = [];
  for (const fragmentId of input.ancestorFragmentIds) {
    const fragment = fragments.get(fragmentId);
    if (!fragment) return null;
    const node = objectRecord(
      valueAtEffectPointer(input.source.rule.effect, fragment.jsonPointer),
    );
    if (!node) return null;
    if (node.type === "sequence") continue;
    if (node.type !== "conditional") return null;
    const keys = stateKeysForCondition(node.condition);
    if (keys === null) return null;
    stateKeys.push(...keys);
  }
  return sortedUnique(stateKeys);
}

function sourceBinding(input: {
  source: SourceContext;
  fragment: CombatCorpusEffectFragmentV1;
}): CombatOverlaySourceBindingV1 {
  return {
    sourceId: input.source.sourceId,
    entitySha256: input.source.rule.entityHash,
    jsonPointer: input.fragment.jsonPointer,
    fragmentSha256: input.fragment.fragmentSha256,
  };
}

function exactEntryMatches(
  entry: Extract<CombatCorpusReviewedEntryV1, { kind: "exact-leaf" }>,
  binding: CombatOverlaySourceBindingV1,
): boolean {
  return canonicalJson(entry.source) === canonicalJson(binding);
}

function resolveReviewedLeaf(input: {
  source: SourceContext;
  leafNode: Record<string, unknown>;
  leafBinding: CombatOverlaySourceBindingV1;
  ancestorFragmentIds: readonly string[];
  inventory: CombatSourceLeafInventoryV1;
  store: CombatCorpusReviewedStoreV1;
}): ReviewedLeafResolution | null {
  const exact = input.store.entries.filter(
    (entry): entry is Extract<
      CombatCorpusReviewedEntryV1,
      { kind: "exact-leaf" }
    > => entry.kind === "exact-leaf" &&
      exactEntryMatches(entry, input.leafBinding),
  );
  if (exact.length > 1) return null;
  if (exact.length === 1) {
    const entry = exact[0];
    if (
      entry.disposition.kind !== "modeled" && entry.stateKeys.length > 0
    ) {
      return null;
    }
    return {
      reviewEntryId: entry.entryId,
      matcher: "exact-leaf",
      phases: entry.phases.filter(
        (phase): phase is CombatPhaseV2 =>
          phase === "shooting" || phase === "fight",
      ),
      stateKeys: [...entry.stateKeys],
      mechanicIds:
        entry.disposition.kind === "modeled"
          ? [...entry.disposition.mechanicIds]
          : [],
      disposition: entry.disposition.kind,
      reason:
        entry.disposition.kind === "modeled"
          ? null
          : entry.disposition.reason,
      evidence: entry.evidence,
    };
  }
  if (
    input.source.rule.phaseMappingStatus !== "verified" ||
    input.source.phases.length === 0
  ) {
    return null;
  }
  const stateKeys = stateKeysForAncestors({
    source: input.source,
    inventory: input.inventory,
    ancestorFragmentIds: input.ancestorFragmentIds,
  });
  if (stateKeys === null) return null;
  for (const entry of input.store.entries) {
    if (entry.kind !== "reviewed-matcher") continue;
    const mechanicIds = mechanicForMatcher({
      matcher: entry.matcher,
      node: input.leafNode,
      source: input.source.rule.source,
    });
    if (!mechanicIds) continue;
    const movement = entry.matcher === "noncombat-movement-v1";
    return {
      reviewEntryId: entry.entryId,
      matcher: entry.matcher,
      phases: input.source.phases,
      stateKeys: movement ? [] : stateKeys,
      mechanicIds: movement ? [] : sortedUnique(mechanicIds),
      disposition: movement ? "out-of-calculator-scope" : "modeled",
      reason: movement
        ? "Movement changes battlefield position but is outside the directional attack calculator."
        : null,
      evidence: entry.evidence,
    };
  }
  return null;
}

function normalizeSourceForIdentity(source: CombatRuleSourceV1): unknown {
  if (source.kind === "enhancement") {
    return {
      kind: source.kind,
      enhancementId: source.enhancementId,
      bearerUnitId: source.bearerUnitId,
    };
  }
  if (source.kind === "wargear") {
    return {
      kind: source.kind,
      wargearId: source.wargearId,
      bearerUnitId: source.bearerUnitId,
    };
  }
  return source;
}

function entityKindForSource(
  source: CombatRuleSourceV1,
): CombatCorpusEntityKindV1 {
  switch (source.kind) {
    case "army":
      return "faction-rule";
    case "detachment":
      return "detachment-rule";
    case "detachment-stratagem":
      return "stratagem";
    case "unit":
    case "attached":
    case "support":
      return "unit";
    case "enhancement":
      return "enhancement";
    case "wargear":
      return "wargear";
  }
}

function entityIdForSource(
  source: CombatRuleSourceV1,
  abilityId: string,
): string {
  switch (source.kind) {
    case "army":
      return abilityId;
    case "detachment":
      return abilityId;
    case "detachment-stratagem":
      return source.stratagemId;
    case "unit":
      return source.unitId;
    case "attached":
    case "support":
      return source.sourceUnitId;
    case "enhancement":
      return source.enhancementId;
    case "wargear":
      return source.wargearId;
  }
}

function ruleLogicalKey(input: {
  factionId: string;
  rule: BundleCombatRuleRecordV1;
}): string {
  return canonicalJson({
    factionId: input.factionId,
    abilityId: input.rule.abilityId,
    source: normalizeSourceForIdentity(input.rule.source),
  });
}

async function rulePayloadKey(input: {
  factionId: string;
  rule: BundleCombatRuleRecordV1;
}): Promise<string> {
  return canonicalJson({
    logical: JSON.parse(ruleLogicalKey(input)),
    entitySha256: input.rule.entityHash,
    effectSha256: await sha256Hex(canonicalJson(input.rule.effect)),
  });
}

function ruleOccurrences(
  input: CompileCombatBridgeInputV2,
): Array<{ factionId: string; rule: BundleCombatRuleRecordV1 }> {
  const output: Array<{
    factionId: string;
    rule: BundleCombatRuleRecordV1;
  }> = [];
  for (const cell of input.cells) {
    for (const variant of cell.ruleVariants) {
      output.push(
        ...variant.attackerRules.map((rule) => ({
          factionId: cell.attacker.factionId,
          rule,
        })),
        ...variant.targetRules.map((rule) => ({
          factionId: cell.target.factionId,
          rule,
        })),
      );
    }
  }
  return output;
}

function resolveFactionAbility(
  dataset: Dataset,
  abilityId: string,
  factionId: string,
) {
  const scoped = dataset.abilities.getInFaction(abilityId, factionId);
  if (scoped) return scoped;
  const candidate = dataset.abilities.getAny(abilityId);
  return candidate?.raw.faction_id == null ? candidate : undefined;
}

function activationForAbility(
  ability: NonNullable<ReturnType<typeof resolveFactionAbility>>,
): BundleCombatRuleRecordV1["activation"] {
  const trigger = ability.raw.trigger;
  const optional = Array.isArray(trigger)
    ? trigger.some((entry) => entry.optional === true)
    : trigger?.optional === true;
  return ability.raw.behavior === "activated" || optional
    ? {
        kind: "optional",
        id: ability.id,
        label: ability.name,
        group: null,
        cpCost: 0,
      }
    : { kind: "always" };
}

function augmentReviewedWargearRules(input: {
  native: CompileCombatBridgeInputV2;
  dataset: Dataset;
  store: CombatCorpusReviewedStoreV1;
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
}): CompileCombatBridgeInputV2 {
  const bindings = input.store.entries.filter(
    (entry): entry is Extract<
      CombatCorpusReviewedEntryV1,
      { kind: "wargear-ability-binding" }
    > => entry.kind === "wargear-ability-binding",
  );
  const selected = new Set(
    [input.playerRoster, input.opponentRoster].flatMap((roster) =>
      roster.units.flatMap((unit) =>
        unit.equipment.flatMap((equipment) =>
          equipment.count > 0
            ? [canonicalJson({
                factionId: roster.factionId,
                unitId: unit.unitId,
                equipmentId: equipment.itemId,
              })]
            : []
        )
      )
    ),
  );
  for (const binding of bindings) {
    if (!selected.has(canonicalJson(binding.subject))) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_WARGEAR_BINDING_INVALID",
        `Reviewed wargear binding ${JSON.stringify(binding.entryId)} does not name selected positive-count equipment in either canonical roster.`,
      );
    }
  }
  const used = new Set<string>();
  const replaceRules = (
    rules: readonly BundleCombatRuleRecordV1[],
    factionId: string,
  ): BundleCombatRuleRecordV1[] => rules.flatMap((rule) => {
    const effect = objectRecord(rule.effect);
    if (
      !rule.abilityId.startsWith("rosterpilot-unresolved:") ||
      effect?.code !== "wargear-ability-mapping-missing" ||
      rule.source.kind !== "wargear"
    ) {
      return [rule];
    }
    const wargearSource = rule.source;
    const matching = bindings.filter((binding) =>
      binding.subject.factionId === factionId &&
      binding.subject.unitId === wargearSource.bearerUnitId &&
      binding.subject.equipmentId === wargearSource.wargearId
    );
    if (matching.length === 0) return [rule];
    const replacements: BundleCombatRuleRecordV1[] = [];
    for (const binding of matching) {
      const ability = resolveFactionAbility(
        input.dataset,
        binding.abilityId,
        factionId,
      );
      const phases = ability?.phases.filter(
        (phase): phase is CombatPhaseV2 =>
          phase === "shooting" || phase === "fight",
      ) ?? [];
      if (!ability || phases.length === 0) {
        throw new CombatBridgeInputV3PreparationError(
          "COMBAT_CORPUS_WARGEAR_BINDING_INVALID",
          `Reviewed wargear binding ${JSON.stringify(binding.entryId)} does not resolve one faction-correct ability with a verified combat phase mapping.`,
        );
      }
      used.add(binding.entryId);
      replacements.push({
        abilityId: ability.id,
        abilityName: ability.name,
        entityHash: rule.entityHash,
        effect: ability.raw.effect,
        source: rule.source,
        phases,
        phaseMappingStatus: "verified",
        activation: activationForAbility(ability),
        unsupportedRelevance: "combat",
      });
    }
    return replacements;
  });
  const cells = input.native.cells.map((cell) => ({
    ...cell,
    ruleVariants: cell.ruleVariants.map((variant) => ({
      ...variant,
      attackerRules: replaceRules(
        variant.attackerRules,
        cell.attacker.factionId,
      ),
      targetRules: replaceRules(
        variant.targetRules,
        cell.target.factionId,
      ),
    })),
  }));
  const unused = bindings.filter((binding) => !used.has(binding.entryId));
  if (unused.length > 0) {
    throw new CombatBridgeInputV3PreparationError(
      "COMBAT_CORPUS_WARGEAR_BINDING_INVALID",
      `Reviewed wargear bindings were not consumed by the canonical bridge rule inventory: ${unused.map((entry) => entry.entryId).join(", ")}.`,
    );
  }
  return { ...input.native, cells };
}

async function sourceContexts(input: {
  native: CompileCombatBridgeInputV2;
  store: CombatCorpusReviewedStoreV1;
}): Promise<{
  contexts: Map<string, SourceContext>;
  sources: CombatCorpusSourceEntityInputV1[];
  sourceIdByRulePayload: Map<string, string>;
}> {
  const occurrences = ruleOccurrences(input.native);
  if (occurrences.length === 0) {
    throw new CombatBridgeInputV3PreparationError(
      "COMBAT_CORPUS_RULE_SOURCE_EMPTY",
      "Rules-aware combat corpus preparation found no relevant structured rule effect entities.",
    );
  }
  const payloadByLogical = new Map<string, string>();
  const grouped = new Map<string, {
    occurrence: typeof occurrences[number];
    phases: Set<CombatPhaseV2>;
    payload: string;
  }>();
  for (const occurrence of occurrences) {
    const logical = ruleLogicalKey(occurrence);
    const payload = await rulePayloadKey(occurrence);
    const prior = payloadByLogical.get(logical);
    if (prior !== undefined && prior !== payload) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_RULE_SOURCE_CONFLICT",
        `One canonical combat rule source resolves multiple entity/effect payloads: ${logical}.`,
      );
    }
    payloadByLogical.set(logical, payload);
    const current = grouped.get(payload) ?? {
      occurrence,
      phases: new Set<CombatPhaseV2>(),
      payload,
    };
    for (const phase of occurrence.rule.phases) current.phases.add(phase);
    grouped.set(payload, current);
  }
  const contexts = new Map<string, SourceContext>();
  const sources: CombatCorpusSourceEntityInputV1[] = [];
  const sourceIdByRulePayload = new Map<string, string>();
  for (const group of [...grouped.values()].sort((left, right) =>
    compareStrings(left.payload, right.payload)
  )) {
    const sourceId = `combat-source-v1:${await sha256Hex(group.payload)}`;
    const { rule, factionId } = group.occurrence;
    const wargearSource = rule.source.kind === "wargear"
      ? rule.source
      : null;
    const wargearReviewEntry = wargearSource
      ? input.store.entries.find(
          (entry): entry is Extract<
            CombatCorpusReviewedEntryV1,
            { kind: "wargear-ability-binding" }
          > => entry.kind === "wargear-ability-binding" &&
            entry.subject.factionId === factionId &&
            entry.subject.unitId === wargearSource.bearerUnitId &&
            entry.subject.equipmentId === wargearSource.wargearId &&
            entry.abilityId === rule.abilityId,
        ) ?? null
      : null;
    const context: SourceContext = {
      sourceId,
      factionId,
      rule,
      phases: [...group.phases].sort(compareStrings),
      wargearReviewEntry,
    };
    contexts.set(sourceId, context);
    sourceIdByRulePayload.set(group.payload, sourceId);
    sources.push({
      sourceId,
      entityKind: entityKindForSource(rule.source),
      factionId,
      entityId: entityIdForSource(rule.source, rule.abilityId),
      entitySha256: rule.entityHash,
      effectJsonPointer: "/effect",
      effect: rule.effect,
    });
  }
  return { contexts, sources, sourceIdByRulePayload };
}

function unknownEngagement(): TesseraEngagementContextV2 {
  return {
    targetInCover: "unknown",
    charging: "unknown",
    withinRapidFireRange: "unknown",
    withinMeltaRange: "unknown",
    remainedStationary: "unknown",
    indirectFire: "unknown",
    distanceInches: "unknown",
    timing: "unknown",
    objectiveControl: "unknown",
    armyAbilityActive: "unknown",
    targetCondition: "unknown",
    belowStrength: "unknown",
    damaged: "unknown",
  };
}

function policyV2FromV3(
  policy: TesseraCombatPolicyV3,
  scenarios: readonly TesseraScenarioEntryV3[],
): TesseraCombatPolicyV2 {
  const phases = new Set(scenarios.map((scenario) => scenario.phase));
  const directions = new Set(scenarios.map((scenario) => scenario.direction));
  const options = policy.activations.options.map((option) => {
    if (
      option.prerequisites.length > 0 ||
      [...phases].some((phase) => !option.phases.includes(phase)) ||
      [...directions].some(
        (direction) => !option.directions.includes(direction),
      ) ||
      option.costs.some((cost) => cost.kind !== "command-points")
    ) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_SCENARIO_POLICY_UNREPRESENTABLE",
        `Activation ${JSON.stringify(option.id)} has side-specific scope, prerequisites, or resources that combat-policy v1 cannot preserve exactly.`,
      );
    }
    return {
      id: option.id,
      groupId: option.groupId,
      resourceCost: option.costs.reduce(
        (total, cost) => total +
          (cost.kind === "command-points" ? cost.amount : 0),
        0,
      ),
    };
  });
  const activationBase = {
    options,
    groups: policy.activations.groups.map((group) => ({
      id: group.id,
      maximumActive: group.maximumActive,
    })),
    resourceBudget: null,
  };
  return {
    modelingMode: policy.modelingMode,
    activations:
      policy.activations.mode === "selected"
        ? {
            mode: "selected",
            ...activationBase,
            selectedIds: [...policy.activations.selectedIds],
          }
        : {
            mode: "envelope",
            ...activationBase,
            includeNoOptionsBaseline: true,
          },
    attachments: {
      mode: policy.attachments.mode === "selected" ? "selected" : "enumerate",
      bindings: policy.attachments.bindings.map((binding) => ({
        leaderSelectionId: binding.leaderSelectionId,
        bodyguardSelectionId: binding.bodyguardSelectionId,
        supportingSelectionIds: [...binding.supportingSelectionIds],
      })),
    },
    limits: { ...policy.limits },
  };
}

function scenarioPolicyV2FromV3(
  contract: TesseraScenarioPolicyContractV3,
): TesseraScenarioPolicyContractV2 {
  return canonicalTesseraScenarioPolicyContractV2({
    schemaVersion: 2,
    kind: "tessera-scenario-policy-contract",
    scenarios: contract.scenarios.map((scenario) => ({
      phase: scenario.phase,
      direction: scenario.direction,
      metric: scenario.metric,
      engagement: unknownEngagement(),
      iterations: scenario.iterations,
    })),
    policy: policyV2FromV3(contract.policy, contract.scenarios),
  });
}

function sideForDirection(
  direction: TesseraScenarioEntryV3["direction"],
): { attacker: TesseraScenarioSide; target: TesseraScenarioSide } {
  return direction === "player-to-opponent"
    ? { attacker: "player", target: "opponent" }
    : { attacker: "opponent", target: "player" };
}

function unitState(
  scenario: TesseraScenarioEntryV3,
  side: TesseraScenarioSide,
  selectionId: string,
): TesseraUnitPhysicalStateV3 {
  const state = scenario.state[side].units.find(
    (entry) => entry.selectionId === selectionId,
  );
  if (!state) {
    throw new CombatBridgeInputV3PreparationError(
      "COMBAT_CORPUS_SCENARIO_SCOPE_MISMATCH",
      `Scenario ${scenario.phase}/${scenario.direction}/${scenario.metric} has no ${side} state for selection ${JSON.stringify(selectionId)}.`,
    );
  }
  return state;
}

function pairState(input: {
  scenario: TesseraScenarioEntryV3;
  attackerSide: TesseraScenarioSide;
  targetSide: TesseraScenarioSide;
  attackerSelectionId: string;
  targetSelectionId: string;
}): TesseraPairPhysicalStateV3 {
  const pair = input.scenario.state.pairs.find((entry) =>
    entry.attackerSide === input.attackerSide &&
    entry.targetSide === input.targetSide &&
    entry.attackerSelectionId === input.attackerSelectionId &&
    entry.targetSelectionId === input.targetSelectionId
  );
  if (!pair) {
    throw new CombatBridgeInputV3PreparationError(
      "COMBAT_CORPUS_SCENARIO_SCOPE_MISMATCH",
      `Scenario has no exact physical pair for ${JSON.stringify(input.attackerSelectionId)} into ${JSON.stringify(input.targetSelectionId)}.`,
    );
  }
  return pair;
}

function booleanState<T extends string>(
  value: boolean | "unknown",
  whenTrue: T,
  whenFalse: T,
): T | "unknown" {
  return value === "unknown" ? "unknown" : value ? whenTrue : whenFalse;
}

function halfRange(
  pair: TesseraPairPhysicalStateV3,
): boolean | "unknown" {
  return pair.withinRapidFireRange === pair.withinMeltaRange
    ? pair.withinRapidFireRange
    : "unknown";
}

function armyAbilityState(
  scenario: TesseraScenarioEntryV3,
  side: TesseraScenarioSide,
): "active" | "inactive" | "unknown" {
  const values = scenario.state[side].armyAbilities.map(
    (ability) => ability.active,
  );
  if (values.length === 0 || values.includes("unknown")) return "unknown";
  return values.every((value) => value === values[0])
    ? values[0] ? "active" : "inactive"
    : "unknown";
}

function participantAttachedState(
  cell: CompileCombatBridgeInputV2["cells"][number],
  perspective: "attacker" | "target",
): boolean | "unknown" {
  const selectionId = cell[perspective].selectionId;
  const values = cell.ruleVariants.map((variant) =>
    variant.attachmentPlan[perspective].some((binding) =>
      binding.leaderSelectionId === selectionId ||
      binding.bodyguardSelectionId === selectionId ||
      binding.supportSelectionIds.includes(selectionId)
    )
  );
  return values.length > 0 && values.every((value) => value === values[0])
    ? values[0]
    : "unknown";
}

function applyScenarioV3State(
  native: CompileCombatBridgeInputV2,
  contract: TesseraScenarioPolicyContractV3,
): CompileCombatBridgeInputV2 {
  const scenarios = new Map(
    contract.scenarios.map((scenario) => [
      `${scenario.phase}:${scenario.direction}:${scenario.metric}`,
      scenario,
    ]),
  );
  return {
    ...native,
    cells: native.cells.map((cell) => {
      const scenario = scenarios.get(
        `${cell.scenario.phase}:${cell.direction}:${cell.metric}`,
      );
      if (!scenario) {
        throw new CombatBridgeInputV3PreparationError(
          "COMBAT_CORPUS_SCENARIO_SCOPE_MISMATCH",
          `No scenario-v3 entry matches bridge cell ${JSON.stringify(cell.cellId)}.`,
        );
      }
      const sides = sideForDirection(cell.direction);
      const attacker = unitState(
        scenario,
        sides.attacker,
        cell.attacker.selectionId,
      );
      const target = unitState(
        scenario,
        sides.target,
        cell.target.selectionId,
      );
      const pair = pairState({
        scenario,
        attackerSide: sides.attacker,
        targetSide: sides.target,
        attackerSelectionId: cell.attacker.selectionId,
        targetSelectionId: cell.target.selectionId,
      });
      return {
        ...cell,
        scenario: {
          schemaVersion: 2,
          phase: scenario.phase,
          distanceInches: pair.distanceInches,
          withinHalfRange: halfRange(pair),
          attackerStationary:
            attacker.movement === "unknown"
              ? "unknown"
              : attacker.movement === "stationary",
          attackerCharged: attacker.chargedThisTurn,
          attackerAttached: participantAttachedState(cell, "attacker"),
          targetAttached: participantAttachedState(cell, "target"),
          attackerInCover: attacker.inCover,
          targetInCover: target.inCover,
          timing: scenario.state.timing,
          objectiveState: booleanState(
            attacker.controlsObjective,
            "controlled",
            "not-controlled",
          ),
          attackerStrengthState: attacker.strength,
          targetStrengthState: target.strength,
          attackerDamageState: attacker.damage,
          targetDamageState: target.damage,
          armyAbilityState: armyAbilityState(scenario, sides.attacker),
          targetConditionState: booleanState(
            pair.targetCondition,
            "met",
            "not-met",
          ),
        },
      };
    }),
  };
}

function profilePolicyFromLocalInput(input: {
  localInput: LocalTesseraEngineInputV2;
  roster: RosterDraftV1;
  dataset: Dataset;
}): ProfilePolicyV1 | null {
  if (input.localInput.profileRequirements.length === 0) {
    return input.localInput.profilePolicySha256 === null
      ? null
      : {
          schemaVersion: 1,
          policyKind: "tessera-profile-policy",
          entries: [],
        };
  }
  const selectionById = new Map(
    input.roster.units.map((selection) => [selection.selectionId, selection]),
  );
  const localUnitBySelection = new Map(
    input.localInput.units.map((unit) => [unit.selectionId, unit]),
  );
  const entries: ProfilePolicyV1["entries"] = [];
  for (const requirement of input.localInput.profileRequirements) {
    if (!requirement.selectionId) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH",
        "A decision-grade local-input-v2 profile requirement must retain its roster selection id.",
      );
    }
    const selection = selectionById.get(requirement.selectionId);
    const localUnit = localUnitBySelection.get(requirement.selectionId);
    if (!selection || !localUnit) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH",
        `Local profile requirement ${JSON.stringify(requirement.weaponGroup)} does not bind one canonical roster selection.`,
      );
    }
    const equipmentIds = new Set(
      selection.equipment.filter(
        (equipment) => equipment.count > 0 &&
          normalizeProfileIdentity(equipment.name) ===
            normalizeProfileIdentity(requirement.weaponGroup),
      ).map((equipment) => equipment.itemId),
    );
    const selectedNames = new Map<string, string>();
    for (const weapon of localUnit.weapons) {
      if (
        !equipmentIds.has(weapon.equipmentId) ||
        (requirement.phase === "fight") !== (weapon.type === "melee")
      ) {
        continue;
      }
      const source = input.dataset.weapons.getInFaction(
        weapon.weaponId,
        input.roster.factionId,
      ) ?? input.dataset.weapons.getAny(weapon.weaponId);
      const prefix = `${weapon.weaponId}:profile:`;
      const indexText = weapon.profileId.startsWith(prefix)
        ? weapon.profileId.slice(prefix.length)
        : "";
      const profileIndex = /^\d+$/.test(indexText)
        ? Number(indexText)
        : -1;
      const profile = source?.raw.profiles[profileIndex];
      if (!profile) {
        throw new CombatBridgeInputV3PreparationError(
          "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH",
          `Local weapon profile ${JSON.stringify(weapon.profileId)} is absent from the captured runtime Dataset.`,
        );
      }
      selectedNames.set(normalizeProfileIdentity(profile.name), profile.name);
    }
    if (selectedNames.size !== 1) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH",
        `Local profile requirement ${JSON.stringify(requirement.weaponGroup)} does not resolve one frozen bundle profile.`,
      );
    }
    const selectedProfile = [...selectedNames.values()][0];
    if (!requirement.availableProfiles.some(
      (profile) => normalizeProfileIdentity(profile) ===
        normalizeProfileIdentity(selectedProfile),
    )) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH",
        `Frozen profile ${JSON.stringify(selectedProfile)} is not declared by its retained local-input-v2 requirement.`,
      );
    }
    entries.push({
      faction: requirement.faction,
      unit: requirement.unit,
      ...(requirement.unitOccurrence === undefined
        ? {}
        : { unitOccurrence: requirement.unitOccurrence }),
      ...(requirement.modelCount === undefined
        ? {}
        : { modelCount: requirement.modelCount }),
      weaponGroup: requirement.weaponGroup,
      phase: requirement.phase,
      selectedProfile,
      activeCount: requirement.activeCount,
    });
  }
  return {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries,
  };
}

function verifyLocalInputs(input: {
  localInputs: CombatBridgeInputV3LocalInputs;
  native: CompileCombatBridgeInputV2;
  dataset: Dataset;
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
}): CompileCombatBridgeInputV3["replay"] {
  const verify = (
    side: "player" | "opponent",
    localInput: LocalTesseraEngineInputV2,
  ): string => {
    const rosterId = side === "player"
      ? input.native.bundle.playerRosterId
      : input.native.bundle.opponentRosterId;
    const fingerprint = side === "player"
      ? input.native.bundle.playerRosterFingerprint
      : input.native.bundle.opponentRosterFingerprint;
    const roster = side === "player"
      ? input.playerRoster
      : input.opponentRoster;
    if (
      localInput.bundleId !== input.native.bundle.bundleId ||
      localInput.rosterId !== rosterId ||
      localInput.rosterFingerprint !== fingerprint
    ) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH",
        `The ${side} local-input-v2 identity does not match the canonical bridge roster and bundle.`,
      );
    }
    const serialized = serializeLocalTesseraEngineInputV2(localInput);
    let expected: LocalTesseraEngineInputV2;
    try {
      expected = compileRosterForLocalTesseraEngineV2(
        roster,
        profilePolicyFromLocalInput({
          localInput,
          roster,
          dataset: input.dataset,
        }),
        {
          dataset: input.dataset,
          bundleId: input.native.bundle.bundleId,
          engineDataSchemaVersion:
            input.native.bundle.engineDataSchemaVersion,
        },
      );
    } catch (error) {
      if (error instanceof CombatBridgeInputV3PreparationError) throw error;
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH",
        `The ${side} local-input-v2 cannot be reproduced from the captured Dataset and canonical roster: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (canonicalJson(expected) !== canonicalJson(localInput)) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_LOCAL_INPUT_MISMATCH",
        `The ${side} local-input-v2 content differs from deterministic compilation of the captured Dataset, roster, and frozen profile selection.`,
      );
    }
    return localInputSha256(serialized);
  };
  return {
    localInputV2Sha256s: {
      player: verify("player", input.localInputs.player),
      opponent: verify("opponent", input.localInputs.opponent),
    },
  };
}

async function defaultRuntimeComponents(): Promise<RuntimeComponents> {
  const component = async (
    componentId: string,
    version: string,
    contract: unknown,
  ): Promise<CombatCorpusComponentIdentityV1> => ({
    componentId,
    version,
    contentSha256: await sha256Hex(canonicalJson(contract)),
  });
  return {
    compiler: await component(
      "combat-corpus-preparer",
      COMBAT_CORPUS_PREPARER_VERSION,
      {
        version: COMBAT_CORPUS_PREPARER_VERSION,
        bridgeCompiler: COMBAT_BRIDGE_V3_COMPILER_VERSION,
        rulesCompiler: COMBAT_RULES_COMPILER,
      },
    ),
    adapter: await component(
      "tessera-combat-bridge-adapter",
      TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION,
      {
        bridgeAdapter: TESSERA_COMBAT_BRIDGE_ADAPTER_VERSION,
        trackedAdapter: TRACKED_TESSERA_ADAPTER_V2_VERSION,
      },
    ),
    engine: await component(
      "local-tessera-execution-contract",
      LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION,
      {
        compiler: LOCAL_TESSERA_INPUT_V2_COMPILER_VERSION,
        identityContract: LOCAL_TESSERA_INPUT_V2_IDENTITY_CONTRACT,
      },
    ),
  };
}

async function rulesSemanticSha256(input: {
  native: CompileCombatBridgeInputV2;
  sources: readonly CombatCorpusSourceEntityInputV1[];
}): Promise<string> {
  return sha256Hex(canonicalJson({
    bundle: input.native.bundle,
    sourceRules: await Promise.all(input.sources.map(async (source) => ({
      sourceId: source.sourceId,
      entityKind: source.entityKind,
      factionId: source.factionId,
      entityId: source.entityId,
      entitySha256: source.entitySha256,
      effectSha256: await sha256Hex(canonicalJson(source.effect)),
    }))),
  }));
}

function communityIdentity(input: {
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
  rulesSemanticSha256: string;
  override?: CombatCorpusCommunityIdentityV1;
  snapshot?: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
}): CombatCorpusCommunityIdentityV1 {
  if (input.override) return input.override;
  const rules = input.snapshot?.manifest.provenance?.rules;
  if (rules) {
    return {
      package: rules.package,
      version: rules.version,
      contentSha256: rules.sourceSha256,
    };
  }
  if (
    input.playerRoster.sourceData.package !==
      input.opponentRoster.sourceData.package ||
    input.playerRoster.sourceData.version !==
      input.opponentRoster.sourceData.version
  ) {
    throw new CombatBridgeInputV3PreparationError(
      "COMBAT_CORPUS_RULE_SOURCE_CONFLICT",
      "The canonical roster pair names different structured community packages or versions.",
    );
  }
  return {
    package: input.playerRoster.sourceData.package,
    version: input.playerRoster.sourceData.version,
    contentSha256: input.rulesSemanticSha256,
  };
}

async function decorateCellsV3(input: {
  native: CompileCombatBridgeInputV2;
  sourceIdByRulePayload: Map<string, string>;
}): Promise<CombatBridgeCellInputV3[]> {
  const decorate = async (
    rule: BundleCombatRuleRecordV1,
    factionId: string,
  ): Promise<BundleCombatRuleRecordV3> => {
    const payload = await rulePayloadKey({ factionId, rule });
    const corpusSourceId = input.sourceIdByRulePayload.get(payload);
    if (!corpusSourceId) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_RULE_SOURCE_CONFLICT",
        `Bridge rule ${JSON.stringify(rule.abilityId)} has no canonical corpus source binding.`,
      );
    }
    return { ...rule, corpusSourceId };
  };
  return Promise.all(input.native.cells.map(async (cell) => ({
    ...cell,
    ruleVariants: await Promise.all(cell.ruleVariants.map(async (variant) => ({
      ...variant,
      attackerRules: await Promise.all(
        variant.attackerRules.map((rule) =>
          decorate(rule, cell.attacker.factionId)
        ),
      ),
      targetRules: await Promise.all(
        variant.targetRules.map((rule) =>
          decorate(rule, cell.target.factionId)
        ),
      ),
    }))),
  })));
}

async function reportArtifacts(input: {
  inventory: CombatSourceLeafInventoryV1;
  contexts: Map<string, SourceContext>;
  store: CombatCorpusReviewedStoreV1;
  community: CombatCorpusCommunityIdentityV1;
  components: RuntimeComponents;
}): Promise<{
  overlay: CombatSemanticsOverlayV1;
  report: CombatCorpusConformanceReportV1;
  ledger: CombatCorpusTranslationLedgerEntryV1[];
}> {
  const fragments = new Map(
    input.inventory.fragments.map((fragment) => [fragment.fragmentId, fragment]),
  );
  const overlayEntries: CombatSemanticsOverlayEntryV1[] = [];
  const accounts: CombatLeafAccountingV1[] = [];
  const ledger: CombatCorpusTranslationLedgerEntryV1[] = [];
  const usedExactEntries = new Set<string>();
  for (const leaf of input.inventory.leaves) {
    const source = input.contexts.get(leaf.sourceId);
    const fragment = fragments.get(leaf.fragmentId);
    if (!source || !fragment) {
      throw new CombatBridgeInputV3PreparationError(
        "COMBAT_CORPUS_RULE_SOURCE_CONFLICT",
        "The generated corpus inventory lost a source or leaf fragment binding.",
      );
    }
    const binding = sourceBinding({ source, fragment });
    const leafNode = objectRecord(
      valueAtEffectPointer(source.rule.effect, fragment.jsonPointer),
    );
    const reviewed = leafNode
      ? resolveReviewedLeaf({
          source,
          leafNode,
          leafBinding: binding,
          ancestorFragmentIds: leaf.ancestorFragmentIds,
          inventory: input.inventory,
          store: input.store,
        })
      : null;
    if (!reviewed) {
      accounts.push({
        leafId: leaf.leafId,
        phaseEvidence: {
          kind: "unresolved",
          reason: "No current exact reviewed mapping covers this structured effect leaf and its execution ancestry.",
        },
        stateKeys: [],
        disposition: {
          kind: "unsupported",
          reason: "The conservative production corpus preparer does not guess unreviewed translator or adapter semantics.",
        },
      });
      continue;
    }
    if (reviewed.matcher === "exact-leaf") {
      usedExactEntries.add(reviewed.reviewEntryId);
    }
    if (reviewed.disposition === "modeled") {
      const entryId = `phase:${leaf.leafId}`;
      overlayEntries.push({
        entryId,
        kind: "phase-mapping",
        source: binding,
        phases: reviewed.phases,
        evidence: reviewed.evidence,
      });
      const stateRequired = reviewed.stateKeys.length > 0;
      accounts.push({
        leafId: leaf.leafId,
        phaseEvidence: {
          kind: "reviewed-overlay",
          phases: reviewed.phases,
          overlayEntryId: entryId,
        },
        stateKeys: reviewed.stateKeys,
        disposition: stateRequired
          ? {
              kind: "state-required",
              exactness: "exact-when-state-selected",
              mechanicIds: reviewed.mechanicIds,
              reason: "The exact structured mechanic depends on selected scenario-v3 physical state.",
            }
          : {
              kind: "modeled",
              exactness: "exact",
              mechanicIds: reviewed.mechanicIds,
            },
      });
      ledger.push({
        leafId: leaf.leafId,
        sourceId: source.sourceId,
        reviewEntryId: reviewed.reviewEntryId,
        matcher: reviewed.matcher,
        phases: reviewed.phases,
        stateKeys: reviewed.stateKeys,
        mechanicIds: reviewed.mechanicIds,
        disposition: stateRequired ? "state-required" : "modeled",
      });
    } else {
      const entryId = `scope:${leaf.leafId}`;
      overlayEntries.push({
        entryId,
        kind: "calculator-scope",
        source: binding,
        classification: reviewed.disposition,
        evidence: reviewed.evidence,
      });
      const reason = reviewed.reason ??
        "The reviewed leaf does not execute in the directional attack calculator.";
      accounts.push({
        leafId: leaf.leafId,
        phaseEvidence: { kind: "not-required", reason },
        stateKeys: [],
        disposition:
          reviewed.disposition === "out-of-calculator-scope"
            ? {
                kind: "out-of-calculator-scope",
                overlayEntryId: entryId,
                reason,
              }
            : {
                kind: "not-applicable",
                overlayEntryId: entryId,
                reason,
              },
      });
      ledger.push({
        leafId: leaf.leafId,
        sourceId: source.sourceId,
        reviewEntryId: reviewed.reviewEntryId,
        matcher: reviewed.matcher,
        phases: reviewed.phases,
        stateKeys: [],
        mechanicIds: [],
        disposition: reviewed.disposition,
      });
    }
  }
  const unusedExact = input.store.entries.filter(
    (entry) => entry.kind === "exact-leaf" &&
      !usedExactEntries.has(entry.entryId),
  );
  if (unusedExact.length > 0) {
    throw new CombatBridgeInputV3PreparationError(
      "COMBAT_CORPUS_REVIEW_REQUIRED",
      `Exact reviewed leaf bindings are stale or outside the canonical roster corpus: ${unusedExact.map((entry) => entry.entryId).join(", ")}.`,
    );
  }
  for (const source of input.contexts.values()) {
    if (!source.wargearReviewEntry) continue;
    const root = input.inventory.fragments.find((fragment) =>
      fragment.sourceId === source.sourceId &&
      fragment.jsonPointer === "/effect"
    );
    if (!root || source.rule.source.kind !== "wargear") continue;
    overlayEntries.push({
      entryId: `ability-binding:${source.sourceId.slice(-64)}`,
      kind: "ability-binding",
      source: sourceBinding({ source, fragment: root }),
      bindingClass: "non-weapon-wargear",
      subject: {
        kind: "equipment",
        factionId: source.factionId,
        unitId: source.rule.source.bearerUnitId,
        equipmentId: source.rule.source.wargearId,
      },
      abilityIds: [source.rule.abilityId],
      evidence: source.wargearReviewEntry.evidence,
    });
  }
  const overlay = await createCombatSemanticsOverlayV1({
    schemaVersion: 1,
    kind: "rosterpilot-combat-semantics-overlay",
    bundle: input.inventory.bundle,
    sourceInventorySha256: input.inventory.inventorySha256,
    entries: overlayEntries,
  });
  const report = await createCombatCorpusConformanceReportV1({
    inventory: input.inventory,
    overlay,
    community: input.community,
    ...input.components,
    supportedStateKeys: [...TESSERA_SCENARIO_V3_STATE_KEYS],
    leafAccounting: accounts,
  });
  return {
    overlay,
    report,
    ledger: ledger.sort((left, right) => compareStrings(left.leafId, right.leafId)),
  };
}

async function prepareFromNative(input: {
  native: CompileCombatBridgeInputV2;
  dataset: Dataset;
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
  scenarioPolicy: TesseraScenarioPolicyContractV3;
  localInputs: CombatBridgeInputV3LocalInputs;
  reviewedStore: CombatCorpusReviewedStoreV1;
  runtimeIdentities?: CombatBridgeInputV3RuntimeIdentityOverrides;
  snapshot?: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
}): Promise<PreparedCombatBridgeInputV3> {
  if (!verifyCombatCorpusReviewedStoreV1(input.reviewedStore)) {
    throw new CombatBridgeInputV3PreparationError(
      "COMBAT_CORPUS_REVIEW_STORE_INVALID",
      "The combat corpus reviewed store is malformed or its canonical hash is stale.",
    );
  }
  let native = augmentReviewedWargearRules({
    native: input.native,
    dataset: input.dataset,
    store: input.reviewedStore,
    playerRoster: input.playerRoster,
    opponentRoster: input.opponentRoster,
  });
  native = applyScenarioV3State(native, input.scenarioPolicy);
  const discovered = await sourceContexts({
    native,
    store: input.reviewedStore,
  });
  const semanticSha256 = await rulesSemanticSha256({
    native,
    sources: discovered.sources,
  });
  const inventory = await buildCombatSourceLeafInventoryV1({
    bundle: {
      bundleId: native.bundle.bundleId,
      engineDataSchemaVersion: native.bundle.engineDataSchemaVersion,
      rulesSemanticSha256: semanticSha256,
    },
    sources: discovered.sources,
  });
  const defaults = await defaultRuntimeComponents();
  const components: RuntimeComponents = {
    compiler: input.runtimeIdentities?.compiler ?? defaults.compiler,
    adapter: input.runtimeIdentities?.adapter ?? defaults.adapter,
    engine: input.runtimeIdentities?.engine ?? defaults.engine,
  };
  const community = communityIdentity({
    playerRoster: input.playerRoster,
    opponentRoster: input.opponentRoster,
    rulesSemanticSha256: semanticSha256,
    override: input.runtimeIdentities?.community,
    snapshot: input.snapshot,
  });
  const artifacts = await reportArtifacts({
    inventory,
    contexts: discovered.contexts,
    store: input.reviewedStore,
    community,
    components,
  });
  const expected = {
    bundle: inventory.bundle,
    community,
    ...components,
    supportedStateKeys: [...TESSERA_SCENARIO_V3_STATE_KEYS],
  };
  const admission = await evaluateCombatCorpusStrictAdmissionV1({
    report: artifacts.report,
    overlay: artifacts.overlay,
    expected,
  });
  if (!admission.admitted) {
    throw new CombatBridgeInputV3PreparationError(
      "COMBAT_CORPUS_REVIEW_REQUIRED",
      `The canonical roster combat corpus requires reviewed exact mappings before bridge-v3 admission: ${admission.issues.map((issue) => `${issue.code}${issue.leafId ? `:${issue.leafId}` : ""}`).join(", ")}.`,
      {
        inventory,
        overlay: artifacts.overlay,
        report: artifacts.report,
      },
    );
  }
  const replay = {
    ...verifyLocalInputs({
      localInputs: input.localInputs,
      native,
      dataset: input.dataset,
      playerRoster: input.playerRoster,
      opponentRoster: input.opponentRoster,
    }),
    scenarioContractV3Sha256:
      tesseraScenarioPolicyContractV3Sha256(input.scenarioPolicy),
  };
  const cells = await decorateCellsV3({
    native,
    sourceIdByRulePayload: discovered.sourceIdByRulePayload,
  });
  const compileInput: CompileCombatBridgeInputV3 = {
    bundle: native.bundle,
    policy: native.policy,
    cells,
    corpus: {
      report: artifacts.report,
      overlay: artifacts.overlay,
      expected,
    },
    replay,
  };
  // Corpus admission proves the review evidence is complete. A full bridge
  // preflight additionally proves that the pinned translator can realize that
  // evidence against the exact per-cell v3 projection without approximation
  // or omission. This prevents an exact-leaf override from claiming support
  // the executable bridge does not actually possess.
  try {
    await compileCombatBridgeV3(compileInput);
  } catch (error) {
    throw new CombatBridgeInputV3PreparationError(
      "COMBAT_CORPUS_REVIEW_REQUIRED",
      `The reviewed corpus cannot compile as an exact bridge-v3 input: ${error instanceof Error ? error.message : String(error)}`,
      {
        inventory,
        overlay: artifacts.overlay,
        report: artifacts.report,
      },
    );
  }
  return {
    input: compileInput,
    nativeInputV2: native,
    inventory,
    overlay: artifacts.overlay,
    report: artifacts.report,
    reviewedStore: input.reviewedStore,
    translationLedger: artifacts.ledger,
    identities: {
      rulesSemanticSha256: semanticSha256,
      sourceInventorySha256: inventory.inventorySha256,
      reviewedStoreSha256: input.reviewedStore.storeSha256,
      overlaySha256: artifacts.overlay.overlaySha256,
      reportSha256: artifacts.report.reportSha256,
      community,
      ...components,
    },
    replayBindings: replay,
  };
}

export async function prepareCombatBridgeInputV3FromSnapshot(
  input: PrepareCombatBridgeInputV3FromSnapshotInput,
): Promise<PreparedCombatBridgeInputV3> {
  const scenarioPolicy = canonicalTesseraScenarioPolicyContractV3(
    input.scenarioPolicy,
  );
  const native = await compileCombatBridgeInputV2FromSnapshot({
    snapshot: input.snapshot,
    playerRoster: input.playerRoster,
    opponentRoster: input.opponentRoster,
    scenarioPolicy: scenarioPolicyV2FromV3(scenarioPolicy),
  });
  return prepareFromNative({
    native,
    dataset: runtimeDatasetFromSnapshot(input.snapshot),
    playerRoster: input.playerRoster,
    opponentRoster: input.opponentRoster,
    scenarioPolicy,
    localInputs: input.localInputs,
    reviewedStore:
      input.reviewedStore ??
      CONSERVATIVE_COMBAT_CORPUS_REVIEWED_STORE_V1,
    runtimeIdentities: input.runtimeIdentities,
    snapshot: input.snapshot,
  });
}

/**
 * A bare Dataset can discover the same selected rule corpus, but it cannot
 * prove the manifest semantic identities needed for decision-grade bridge-v3
 * evidence. Keep the boundary explicit instead of promoting roster assertions.
 */
export async function prepareCombatBridgeInputV3FromDataset(
  input: PrepareCombatBridgeInputV3FromDatasetInput,
): Promise<never> {
  const scenarioPolicy = canonicalTesseraScenarioPolicyContractV3(
    input.scenarioPolicy,
  );
  await compileCombatBridgeInputV2FromDataset({
    dataset: input.dataset,
    playerRoster: input.playerRoster,
    opponentRoster: input.opponentRoster,
    scenarioPolicy: scenarioPolicyV2FromV3(scenarioPolicy),
  });
  throw new CombatBridgeInputV3PreparationError(
    "COMBAT_CORPUS_SNAPSHOT_REQUIRED",
    "Exact combat corpus preparation requires the immutable verified DataBundleSnapshot; a captured Dataset alone retains only roster-asserted semantic hashes.",
  );
}
