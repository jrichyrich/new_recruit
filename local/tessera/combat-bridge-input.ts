import type {
  Dataset,
  EligibleAbility,
  UnitView,
} from "@alpaca-software/40kdc-data";

import type {
  DataBundleProvider,
  DataBundleSnapshot,
} from "../../lib/rosterpilot/data-bundle";
import {
  stampRosterDataIdentity,
  type RosterCompatibilityFactionIdentity,
  type RosterCompatibilitySnapshot,
} from "../../lib/rosterpilot/draft";
import { rosterExecutionFingerprint } from "../../lib/rosterpilot/stress-portfolio";
import type {
  BundleCombatRuleRecordV1,
  CombatAttachmentBindingV1,
  CombatAttachmentPlanV1,
  CombatAttachmentSelectionV1,
  CombatBridgeCellInputV2,
  CombatScenarioContextV2,
  CombatPhaseV2,
  CombatPolicyV1,
  CombatRuleSourceV1,
  CompileCombatBridgeInputV2,
} from "../../lib/rosterpilot/combat-bridge";
import {
  createRuntimeDataset,
  mergeRuntimeRulesData,
} from "../../lib/rosterpilot/runtime-dataset";
import type {
  RuntimeDataBundleShardDataV1,
} from "../../lib/rosterpilot/runtime-data-bundle";
import {
  canonicalJson,
  sha256Hex,
} from "../../lib/rosterpilot/semantic-hash";
import {
  RosterDraftV3Schema,
  type RosterDraftV1,
} from "../../lib/rosterpilot/types";
import {
  canonicalTesseraScenarioPolicyContractV2,
  type TesseraCombatPolicyV2,
  type TesseraEngagementState,
  type TesseraScenarioEntryV2,
  type TesseraScenarioPolicyContractV2,
} from "./scenario-contract-v2";

const MAX_ATTACHMENT_CANDIDATES_FOR_TRUNCATION = 17;

export type CombatBridgeInputRosterPairV2 = {
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
  scenarioPolicy: TesseraScenarioPolicyContractV2;
};

export type CombatBridgeInputFromSnapshotV2 =
  CombatBridgeInputRosterPairV2 & {
    snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
  };

/**
 * Explicit captured-data entry point for callers that already hold the exact
 * Dataset for their operation. Semantic binding still comes from the two
 * canonical rosters; this path never consults the process-global dataset.
 */
export type CombatBridgeInputFromDatasetV2 =
  CombatBridgeInputRosterPairV2 & {
    dataset: Dataset;
  };

export type CombatBridgeInputFromProviderV2 =
  CombatBridgeInputRosterPairV2 & {
    provider: DataBundleProvider<RuntimeDataBundleShardDataV1>;
    signal?: AbortSignal;
  };

export class CombatBridgeInputError extends Error {
  readonly code:
    | "COMBAT_BRIDGE_ROSTER_INVALID"
    | "COMBAT_BRIDGE_BUNDLE_MISMATCH"
    | "COMBAT_BRIDGE_BUNDLE_FACTION_MISSING"
    | "COMBAT_BRIDGE_SNAPSHOT_INVALID"
    | "COMBAT_BRIDGE_ATTACHMENT_SELECTION_INVALID";

  constructor(
    code: CombatBridgeInputError["code"],
    message: string,
  ) {
    super(message);
    this.name = "CombatBridgeInputError";
    this.code = code;
  }
}

type RosterSide = "player" | "opponent";

type SideContext = {
  role: RosterSide;
  roster: RosterDraftV1;
  dataset: Dataset;
  unitsBySelectionId: Map<
    string,
    { selection: RosterDraftV1["units"][number]; view: UnitView | null }
  >;
  entityHashes: Readonly<Record<string, string>>;
};

type SideAttachmentPlan = CombatAttachmentBindingV1[];

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function normalizedKeywords(view: UnitView | null): string[] {
  if (!view) return [];
  return sortedUnique([
    ...(view.raw.keywords ?? []),
    ...(view.raw.faction_keywords ?? []),
  ].map((keyword) => keyword.trim().toLocaleLowerCase()).filter(Boolean));
}

function factionAncestry(dataset: Dataset, factionId: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current = dataset.factions.get(factionId);
  while (current && !seen.has(current.id)) {
    result.push(current.id);
    seen.add(current.id);
    current = current.raw.parent_faction_id
      ? dataset.factions.get(current.raw.parent_faction_id)
      : undefined;
  }
  return result;
}

function rosterUnitView(
  dataset: Dataset,
  roster: RosterDraftV1,
  unitId: string,
): UnitView | null {
  for (const factionId of factionAncestry(dataset, roster.factionId)) {
    const view = dataset.units.getInFaction(unitId, factionId);
    if (view) return view;
  }
  return null;
}

function rosterWeaponExists(
  dataset: Dataset,
  roster: RosterDraftV1,
  weaponId: string,
): boolean {
  for (const factionId of factionAncestry(dataset, roster.factionId)) {
    if (dataset.weapons.getInFaction(weaponId, factionId)) return true;
  }
  return false;
}

function unitReferencesEquipment(
  unit: UnitView,
  equipmentId: string,
): boolean {
  if ((unit.raw.weapon_ids ?? []).includes(equipmentId)) return true;
  return unit.wargearOptions.some((option) =>
    [
      ...(option.replaces ?? []),
      ...(option.replacement ?? []),
      ...(option.replacement_choice ?? []).flat(),
    ].includes(equipmentId),
  );
}

function rosterDetachment(
  dataset: Dataset,
  roster: RosterDraftV1,
) {
  for (const factionId of factionAncestry(dataset, roster.factionId)) {
    const detachment = dataset.detachments.getInFaction(
      roster.detachmentId,
      factionId,
    );
    if (detachment) return detachment;
  }
  return undefined;
}

function rosterFaction(dataset: Dataset, roster: RosterDraftV1) {
  return dataset.factions.get(roster.factionId);
}

export function runtimeDatasetFromSnapshot(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
): Dataset {
  const rules = [...snapshot.shards.values()]
    .sort((left, right) => compareStrings(left.shardId, right.shardId))
    .map((shard) => shard.data.rulesData);
  if (rules.length === 0) {
    throw new CombatBridgeInputError(
      "COMBAT_BRIDGE_SNAPSHOT_INVALID",
      `Bundle ${snapshot.bundleId} has no runtime rules shards.`,
    );
  }
  try {
    return createRuntimeDataset(mergeRuntimeRulesData(rules));
  } catch (error) {
    throw new CombatBridgeInputError(
      "COMBAT_BRIDGE_SNAPSHOT_INVALID",
      `Bundle ${snapshot.bundleId} cannot construct a deterministic runtime dataset: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalRoster(input: unknown, label: string): RosterDraftV1 {
  const parsed = RosterDraftV3Schema.safeParse(input);
  if (!parsed.success) {
    throw new CombatBridgeInputError(
      "COMBAT_BRIDGE_ROSTER_INVALID",
      `${label} is not a canonical roster v3: ${parsed.error.issues[0]?.message ?? "schema validation failed"}.`,
    );
  }
  return parsed.data;
}

function rosterSourceProvenance(
  sourceData: RosterDraftV1["sourceData"],
): RosterCompatibilitySnapshot["provenance"] {
  return {
    package: sourceData.package,
    version: sourceData.version,
    edition: sourceData.edition,
    dataslate: sourceData.dataslate,
    releaseId: sourceData.releaseId,
    newRecruit: sourceData.newRecruit,
    official: sourceData.official,
  };
}

function assertRosterSemanticIdentity(input: {
  label: string;
  roster: RosterDraftV1;
  bundleId: string;
  engineDataSchemaVersion: number;
  faction: RosterCompatibilityFactionIdentity;
}): void {
  const expected = stampRosterDataIdentity(input.roster, {
    bundleId: input.bundleId,
    engineDataSchemaVersion: input.engineDataSchemaVersion,
    provenance: rosterSourceProvenance(input.roster.sourceData),
    factions: {
      [input.roster.factionId]: input.faction,
    },
  }).sourceData;
  if (
    input.roster.sourceData.identityStatus !== "verified" ||
    input.roster.sourceData.rosterRulesHash !== expected.rosterRulesHash ||
    input.roster.sourceData.factionRulesHash !==
      expected.factionRulesHash ||
    input.roster.sourceData.mappingHash !== expected.mappingHash ||
    canonicalJson(input.roster.sourceData.entityHashes) !==
      canonicalJson(expected.entityHashes)
  ) {
    throw new CombatBridgeInputError(
      "COMBAT_BRIDGE_BUNDLE_MISMATCH",
      `The ${input.label} roster's selected rules, mapping, or entity hashes do not match bundle ${input.bundleId}.`,
    );
  }
}

function assertBundleBindings(input: {
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>;
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
}): void {
  for (const [label, roster] of [
    ["player", input.playerRoster],
    ["opponent", input.opponentRoster],
  ] as const) {
    if (
      roster.sourceData.bundleId !== input.snapshot.bundleId ||
      roster.sourceData.engineDataSchemaVersion !==
        input.snapshot.manifest.engineDataSchemaVersion
    ) {
      throw new CombatBridgeInputError(
        "COMBAT_BRIDGE_BUNDLE_MISMATCH",
        `The ${label} roster is bound to bundle ${roster.sourceData.bundleId} schema ${roster.sourceData.engineDataSchemaVersion}, not leased bundle ${input.snapshot.bundleId} schema ${input.snapshot.manifest.engineDataSchemaVersion}.`,
      );
    }
    const semantic =
      input.snapshot.manifest.semanticHashes.factions[roster.factionId];
    if (!semantic) {
      throw new CombatBridgeInputError(
        "COMBAT_BRIDGE_BUNDLE_FACTION_MISSING",
        `Leased bundle ${input.snapshot.bundleId} has no semantic identity for faction ${roster.factionId}.`,
      );
    }
    assertRosterSemanticIdentity({
      label,
      roster,
      bundleId: input.snapshot.bundleId,
      engineDataSchemaVersion:
        input.snapshot.manifest.engineDataSchemaVersion,
      faction: semantic,
    });
  }
}

function assertRosterPairBindings(input: {
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
}): void {
  if (
    input.playerRoster.sourceData.bundleId !==
      input.opponentRoster.sourceData.bundleId ||
    input.playerRoster.sourceData.engineDataSchemaVersion !==
      input.opponentRoster.sourceData.engineDataSchemaVersion
  ) {
    throw new CombatBridgeInputError(
      "COMBAT_BRIDGE_BUNDLE_MISMATCH",
      `Player bundle ${input.playerRoster.sourceData.bundleId} schema ${input.playerRoster.sourceData.engineDataSchemaVersion} and opponent bundle ${input.opponentRoster.sourceData.bundleId} schema ${input.opponentRoster.sourceData.engineDataSchemaVersion} differ.`,
    );
  }
  for (const [label, roster] of [
    ["player", input.playerRoster],
    ["opponent", input.opponentRoster],
  ] as const) {
    // A captured Dataset has no manifest, but the roster's selection-scoped
    // hashes can still be checked for internal consistency against its retained
    // entity hashes. Dataset references are checked separately while compiling.
    assertRosterSemanticIdentity({
      label,
      roster,
      bundleId: roster.sourceData.bundleId,
      engineDataSchemaVersion: roster.sourceData.engineDataSchemaVersion,
      faction: {
        factionRulesHash: roster.sourceData.factionRulesHash,
        mappingHash: roster.sourceData.mappingHash,
        entityHashes: roster.sourceData.entityHashes,
      },
    });
  }
}

function sideContext(input: {
  role: RosterSide;
  roster: RosterDraftV1;
  dataset: Dataset;
  entityHashes: Readonly<Record<string, string>>;
}): SideContext {
  return {
    role: input.role,
    roster: input.roster,
    dataset: input.dataset,
    unitsBySelectionId: new Map(
      input.roster.units.map((selection) => [
        selection.selectionId,
        {
          selection,
          view: rosterUnitView(
            input.dataset,
            input.roster,
            selection.unitId,
          ),
        },
      ]),
    ),
    entityHashes: input.entityHashes,
  };
}

function attachmentEligible(
  dataset: Dataset,
  leaderUnitId: string,
  bodyguard: UnitView,
): boolean {
  const bodyguardKeywords = new Set(normalizedKeywords(bodyguard));
  return dataset.leaderAttachments
    .filter((entry) => entry.leader_id === leaderUnitId)
    .some((entry) =>
      entry.eligible_bodyguard_ids.includes(bodyguard.id) ||
      (
        (entry.eligible_bodyguard_keywords?.length ?? 0) > 0 &&
        entry.eligible_bodyguard_keywords!.every((keyword) =>
          bodyguardKeywords.has(keyword.trim().toLocaleLowerCase()),
        )
      ),
    );
}

function canonicalBinding(
  binding: CombatAttachmentBindingV1,
): CombatAttachmentBindingV1 {
  return {
    leaderSelectionId: binding.leaderSelectionId,
    bodyguardSelectionId: binding.bodyguardSelectionId,
    supportSelectionIds: sortedUnique(binding.supportSelectionIds),
  };
}

function bindingKey(binding: CombatAttachmentBindingV1): string {
  return canonicalJson(canonicalBinding(binding));
}

function canonicalSidePlan(plan: SideAttachmentPlan): SideAttachmentPlan {
  return plan
    .map(canonicalBinding)
    .sort((left, right) => compareStrings(bindingKey(left), bindingKey(right)));
}

function sidePlanKey(plan: SideAttachmentPlan): string {
  return canonicalJson(canonicalSidePlan(plan));
}

function enumerateSideAttachmentPlans(
  context: SideContext,
  maximum: number,
): SideAttachmentPlan[] {
  const entries = [...context.unitsBySelectionId.values()].sort(
    (left, right) =>
      compareStrings(
        left.selection.selectionId,
        right.selection.selectionId,
      ),
  );
  const leaders = entries.filter(
    (entry) => entry.view?.raw.attachment_role === "leader",
  );
  const supports = entries.filter(
    (entry) => entry.view?.raw.attachment_role === "support",
  );
  const bodyguards = entries.filter(
    (entry) =>
      entry.view !== null &&
      entry.view.raw.attachment_role !== "leader" &&
      entry.view.raw.attachment_role !== "support",
  );
  const result = new Map<string, SideAttachmentPlan>();
  const collect = (plan: SideAttachmentPlan): void => {
    const canonical = canonicalSidePlan(plan);
    result.set(sidePlanKey(canonical), canonical);
  };
  collect([]);

  const addSupportPlans = (bindings: SideAttachmentPlan): void => {
    const walk = (index: number, current: SideAttachmentPlan): void => {
      if (result.size >= maximum) return;
      if (index === supports.length) {
        collect(current);
        return;
      }
      walk(index + 1, current);
      const support = supports[index];
      if (!support.view) return;
      for (let bindingIndex = 0; bindingIndex < current.length; bindingIndex += 1) {
        const bodyguard = context.unitsBySelectionId.get(
          current[bindingIndex].bodyguardSelectionId,
        )?.view;
        if (
          !bodyguard ||
          !attachmentEligible(context.dataset, support.view.id, bodyguard)
        ) {
          continue;
        }
        const next = current.map(canonicalBinding);
        next[bindingIndex] = canonicalBinding({
          ...next[bindingIndex],
          supportSelectionIds: [
            ...next[bindingIndex].supportSelectionIds,
            support.selection.selectionId,
          ],
        });
        walk(index + 1, next);
      }
    };
    walk(0, bindings);
  };

  const walkLeaders = (
    index: number,
    usedBodyguards: ReadonlySet<string>,
    bindings: SideAttachmentPlan,
  ): void => {
    if (result.size >= maximum) return;
    if (index === leaders.length) {
      addSupportPlans(bindings);
      return;
    }
    walkLeaders(index + 1, usedBodyguards, bindings);
    const leader = leaders[index];
    if (!leader.view) return;
    for (const bodyguard of bodyguards) {
      if (
        !bodyguard.view ||
        usedBodyguards.has(bodyguard.selection.selectionId) ||
        !attachmentEligible(context.dataset, leader.view.id, bodyguard.view)
      ) {
        continue;
      }
      walkLeaders(
        index + 1,
        new Set([...usedBodyguards, bodyguard.selection.selectionId]),
        [...bindings, {
          leaderSelectionId: leader.selection.selectionId,
          bodyguardSelectionId: bodyguard.selection.selectionId,
          supportSelectionIds: [],
        }],
      );
    }
  };
  walkLeaders(0, new Set(), []);

  return [...result.values()]
    .sort((left, right) =>
      left.length - right.length ||
      compareStrings(sidePlanKey(left), sidePlanKey(right)),
    )
    .slice(0, maximum);
}

function selectedSideBindings(
  policy: TesseraCombatPolicyV2,
  context: SideContext,
): SideAttachmentPlan {
  const selectionIds = new Set(context.unitsBySelectionId.keys());
  const matching = policy.attachments.bindings
    .filter((binding) =>
      attachmentPolicySelectionIds(binding).every((selectionId) =>
        selectionIds.has(selectionId)
      ),
    )
    .map((binding) => ({
      leaderSelectionId: binding.leaderSelectionId,
      bodyguardSelectionId: binding.bodyguardSelectionId,
      supportSelectionIds: binding.supportingSelectionIds,
    }));
  return canonicalSidePlan(matching);
}

function attachmentPolicySelectionIds(
  binding: TesseraCombatPolicyV2["attachments"]["bindings"][number],
): string[] {
  return sortedUnique([
    binding.leaderSelectionId,
    binding.bodyguardSelectionId,
    ...binding.supportingSelectionIds,
  ]);
}

function assertSelectedAttachmentBindingsResolveUniquely(
  policy: TesseraCombatPolicyV2,
  first: SideContext,
  second: SideContext,
): void {
  const bindings = [...policy.attachments.bindings].sort((left, right) =>
    compareStrings(canonicalJson(left), canonicalJson(right))
  );
  for (const binding of bindings) {
    let owner: RosterSide | null = null;
    for (const selectionId of attachmentPolicySelectionIds(binding)) {
      const inFirst = first.unitsBySelectionId.has(selectionId);
      const inSecond = second.unitsBySelectionId.has(selectionId);
      if (inFirst && inSecond) {
        throw new CombatBridgeInputError(
          "COMBAT_BRIDGE_ATTACHMENT_SELECTION_INVALID",
          `Attachment selection ${JSON.stringify(selectionId)} exists in both the player and opponent rosters; selected attachment ownership must be unique.`,
        );
      }
      if (!inFirst && !inSecond) {
        throw new CombatBridgeInputError(
          "COMBAT_BRIDGE_ATTACHMENT_SELECTION_INVALID",
          `Attachment selection ${JSON.stringify(selectionId)} does not exist in either roster.`,
        );
      }
      const selectionOwner = inFirst ? first.role : second.role;
      if (owner !== null && owner !== selectionOwner) {
        throw new CombatBridgeInputError(
          "COMBAT_BRIDGE_ATTACHMENT_SELECTION_INVALID",
          `Attachment binding ${JSON.stringify(binding.leaderSelectionId)} -> ${JSON.stringify(binding.bodyguardSelectionId)} crosses the player and opponent rosters; every selected binding must belong wholly to one roster.`,
        );
      }
      owner = selectionOwner;
    }
  }
}

function attachmentSelectionKey(
  selection: CombatAttachmentSelectionV1,
): string {
  return canonicalJson({
    attacker: canonicalSidePlan(selection.attacker),
    target: canonicalSidePlan(selection.target),
  });
}

async function attachmentPlan(
  selection: CombatAttachmentSelectionV1,
): Promise<CombatAttachmentPlanV1> {
  const canonical = {
    attacker: canonicalSidePlan(selection.attacker),
    target: canonicalSidePlan(selection.target),
  };
  if (canonical.attacker.length === 0 && canonical.target.length === 0) {
    return { id: "unattached", ...canonical };
  }
  const digest = await sha256Hex(canonicalJson(canonical));
  return { id: `attachment:${digest.slice(0, 20)}`, ...canonical };
}

async function combinedAttachmentPlans(input: {
  attacker: SideContext;
  target: SideContext;
  policy: TesseraCombatPolicyV2;
}): Promise<CombatAttachmentPlanV1[]> {
  const maximum = Math.min(
    MAX_ATTACHMENT_CANDIDATES_FOR_TRUNCATION,
    input.policy.limits.maxAttachmentPlans + 1,
  );
  let attackerPlans: SideAttachmentPlan[];
  let targetPlans: SideAttachmentPlan[];
  if (input.policy.attachments.mode === "selected") {
    assertSelectedAttachmentBindingsResolveUniquely(
      input.policy,
      input.attacker,
      input.target,
    );
    const selectedAttacker = selectedSideBindings(
      input.policy,
      input.attacker,
    );
    const selectedTarget = selectedSideBindings(input.policy, input.target);
    const legalAttacker = enumerateSideAttachmentPlans(
      input.attacker,
      MAX_ATTACHMENT_CANDIDATES_FOR_TRUNCATION,
    );
    const legalTarget = enumerateSideAttachmentPlans(
      input.target,
      MAX_ATTACHMENT_CANDIDATES_FOR_TRUNCATION,
    );
    if (!legalAttacker.some((plan) => sidePlanKey(plan) === sidePlanKey(selectedAttacker))) {
      throw new CombatBridgeInputError(
        "COMBAT_BRIDGE_ATTACHMENT_SELECTION_INVALID",
        "The selected attacker attachment bindings are not legal in the leased dataset.",
      );
    }
    if (!legalTarget.some((plan) => sidePlanKey(plan) === sidePlanKey(selectedTarget))) {
      throw new CombatBridgeInputError(
        "COMBAT_BRIDGE_ATTACHMENT_SELECTION_INVALID",
        "The selected target attachment bindings are not legal in the leased dataset.",
      );
    }
    attackerPlans = [selectedAttacker];
    targetPlans = [selectedTarget];
  } else {
    attackerPlans = enumerateSideAttachmentPlans(input.attacker, maximum);
    targetPlans = enumerateSideAttachmentPlans(input.target, maximum);
  }

  const selections = new Map<string, CombatAttachmentSelectionV1>();
  for (const attacker of attackerPlans) {
    for (const target of targetPlans) {
      const selection = { attacker, target };
      selections.set(attachmentSelectionKey(selection), selection);
      if (selections.size >= maximum) break;
    }
    if (selections.size >= maximum) break;
  }
  return Promise.all(
    [...selections.values()].map((selection) => attachmentPlan(selection)),
  );
}

type ParticipantAttachmentSelectionIds = {
  attachedSelectionIds: string[];
  supportingSelectionIds: string[];
};

function participantAttachmentSelectionIds(
  plan: CombatAttachmentPlanV1,
  side: "attacker" | "target",
  selectionId: string,
): ParticipantAttachmentSelectionIds {
  const binding = plan[side].find((candidate) =>
    [
      candidate.leaderSelectionId,
      candidate.bodyguardSelectionId,
      ...candidate.supportSelectionIds,
    ].includes(selectionId),
  );
  if (!binding) {
    return { attachedSelectionIds: [], supportingSelectionIds: [] };
  }
  return {
    attachedSelectionIds: sortedUnique([
      binding.leaderSelectionId,
      binding.bodyguardSelectionId,
    ].filter((candidate) => candidate !== selectionId)),
    supportingSelectionIds: sortedUnique(
      binding.supportSelectionIds.filter(
        (candidate) => candidate !== selectionId,
      ),
    ),
  };
}

function sourceForEligible(
  eligible: EligibleAbility,
  roster: RosterDraftV1,
): CombatRuleSourceV1 {
  switch (eligible.source.kind) {
    case "army":
      return { kind: "army", factionId: roster.factionId };
    case "detachment":
      return {
        kind: "detachment",
        detachmentId: eligible.source.detachmentId,
      };
    case "detachment-stratagem":
      return {
        kind: "detachment-stratagem",
        detachmentId: roster.detachmentId,
        stratagemId: eligible.source.stratagemId,
      };
    case "unit":
      return { kind: "unit", unitId: eligible.source.unitId };
    case "attached":
      return { kind: "attached", sourceUnitId: eligible.source.unitId };
    case "support":
      return {
        kind: "support",
        sourceUnitId: eligible.source.sourceUnitId,
      };
  }
}

function semanticKeyForSource(source: CombatRuleSourceV1): string {
  switch (source.kind) {
    case "army":
      return `faction:${source.factionId}`;
    case "detachment":
    case "detachment-stratagem":
      return `detachment:${source.detachmentId}`;
    case "unit":
      return `unit:${source.unitId}`;
    case "attached":
    case "support":
      return `unit:${source.sourceUnitId}`;
    case "enhancement":
      return `enhancement:${source.enhancementId}`;
    case "wargear":
      return `equipment:${source.bearerUnitId}:${source.wargearId}`;
  }
}

async function fallbackEntityHash(input: {
  bundleId: string;
  semanticKey: string;
}): Promise<string> {
  return sha256Hex(canonicalJson({
    kind: "missing-bundle-semantic-entity",
    ...input,
  }));
}

async function unresolvedRule(input: {
  code: string;
  message: string;
  referenceId: string;
  source: CombatRuleSourceV1;
  phase: CombatPhaseV2;
  bundleId: string;
  entityHash?: string;
}): Promise<BundleCombatRuleRecordV1> {
  return {
    abilityId: `rosterpilot-unresolved:${input.code}:${input.referenceId}`,
    abilityName: input.message,
    entityHash:
      input.entityHash ??
      await fallbackEntityHash({
        bundleId: input.bundleId,
        semanticKey: `${input.code}:${input.referenceId}`,
      }),
    effect: {
      type: "rosterpilot-unresolved-rule",
      code: input.code,
      reference_id: input.referenceId,
      message: input.message,
    },
    source: input.source,
    phases: [input.phase],
    phaseMappingStatus: "missing",
    activation: { kind: "always" },
    unsupportedRelevance: "combat",
  };
}

function activationForEligible(
  eligible: EligibleAbility,
): BundleCombatRuleRecordV1["activation"] {
  if (eligible.source.kind === "detachment-stratagem") {
    return {
      kind: "stratagem",
      id: eligible.source.stratagemId,
      label: eligible.ability.name,
      group: null,
      cpCost: eligible.source.cpCost,
    };
  }
  const trigger = eligible.ability.raw.trigger;
  const optionalTrigger = Array.isArray(trigger)
    ? trigger.some((entry) => entry.optional === true)
    : trigger?.optional === true;
  if (
    eligible.ability.raw.behavior === "activated" ||
    optionalTrigger
  ) {
    return {
      kind: "optional",
      id: eligible.ability.id,
      label: eligible.ability.name,
      group: null,
      cpCost: 0,
    };
  }
  return { kind: "always" };
}

async function ruleForEligible(input: {
  eligible: EligibleAbility;
  context: SideContext;
  phase: CombatPhaseV2;
  bundleId: string;
}): Promise<BundleCombatRuleRecordV1[]> {
  const source = sourceForEligible(input.eligible, input.context.roster);
  const semanticKey = semanticKeyForSource(source);
  const retainedHash = input.context.entityHashes[semanticKey];
  const entityHash = retainedHash ?? await fallbackEntityHash({
    bundleId: input.bundleId,
    semanticKey,
  });
  const verifiedPhases = input.eligible.ability.phases.filter(
    (phase): phase is CombatPhaseV2 =>
      phase === "shooting" || phase === "fight",
  );
  const phaseMappingStatus = verifiedPhases.length > 0
    ? "verified"
    : "missing";
  const rules: BundleCombatRuleRecordV1[] = [{
    abilityId: input.eligible.ability.id,
    abilityName: input.eligible.ability.name,
    entityHash,
    effect: input.eligible.ability.raw.effect,
    source,
    phases:
      phaseMappingStatus === "verified"
        ? verifiedPhases
        : [input.phase],
    phaseMappingStatus,
    activation: activationForEligible(input.eligible),
    unsupportedRelevance: "combat",
  }];
  if (!retainedHash) {
    rules.push(await unresolvedRule({
      code: "missing-semantic-hash",
      message: `The leased bundle has no semantic hash for ${semanticKey}.`,
      referenceId: semanticKey,
      source,
      phase: input.phase,
      bundleId: input.bundleId,
      entityHash,
    }));
  }
  return rules;
}

function abilityInFaction(
  dataset: Dataset,
  abilityId: string,
  factionId: string,
) {
  return dataset.abilities.getInFaction(abilityId, factionId) ??
    dataset.abilities.getAny(abilityId);
}

async function enhancementRules(input: {
  context: SideContext;
  bearerSelectionIds: readonly string[];
  phase: CombatPhaseV2;
  bundleId: string;
}): Promise<BundleCombatRuleRecordV1[]> {
  const output: BundleCombatRuleRecordV1[] = [];
  for (const bearerSelectionId of sortedUnique(input.bearerSelectionIds)) {
    const bearer = input.context.unitsBySelectionId.get(bearerSelectionId);
    if (!bearer?.selection.enhancementId) continue;
    const enhancementId = bearer.selection.enhancementId;
    const source: CombatRuleSourceV1 = {
      kind: "enhancement",
      enhancementId,
      bearerUnitId: bearer.selection.unitId,
      bearerSelectionId,
    };
    const entityHash = input.context.entityHashes[
      `enhancement:${enhancementId}`
    ];
    const enhancement = input.context.dataset.enhancements.get(enhancementId);
    if (!enhancement || enhancement.detachment_id !== input.context.roster.detachmentId) {
      output.push(await unresolvedRule({
        code: "enhancement-mapping-missing",
        message: `Selected enhancement ${enhancementId} does not resolve in detachment ${input.context.roster.detachmentId}.`,
        referenceId: enhancementId,
        source,
        phase: input.phase,
        bundleId: input.bundleId,
        entityHash,
      }));
      continue;
    }
    if (!enhancement.ability_id) {
      output.push(await unresolvedRule({
        code: "enhancement-ability-missing",
        message: `Selected enhancement ${enhancementId} has no structured ability mapping.`,
        referenceId: enhancementId,
        source,
        phase: input.phase,
        bundleId: input.bundleId,
        entityHash,
      }));
      continue;
    }
    const ability = abilityInFaction(
      input.context.dataset,
      enhancement.ability_id,
      input.context.roster.factionId,
    );
    if (!ability) {
      output.push(await unresolvedRule({
        code: "enhancement-ability-unresolved",
        message: `Enhancement ${enhancementId} references missing ability ${enhancement.ability_id}.`,
        referenceId: enhancement.ability_id,
        source,
        phase: input.phase,
        bundleId: input.bundleId,
        entityHash,
      }));
      continue;
    }
    const phases = ability.phases.filter(
      (phase): phase is CombatPhaseV2 =>
        phase === "shooting" || phase === "fight",
    );
    const phaseMappingStatus = phases.length > 0 ? "verified" : "missing";
    output.push({
      abilityId: ability.id,
      abilityName: ability.name,
      entityHash:
        entityHash ??
        await fallbackEntityHash({
          bundleId: input.bundleId,
          semanticKey: `enhancement:${enhancementId}`,
        }),
      effect: ability.raw.effect,
      source,
      // An absent phase mapping is uncertainty, not proof the rule is
      // inapplicable. Retain the actual rule in the requested cell and let the
      // bridge downgrade the resulting evidence to provisional.
      phases: phaseMappingStatus === "verified" ? phases : [input.phase],
      phaseMappingStatus,
      activation:
        ability.raw.behavior === "activated"
          ? {
              kind: "optional",
              id: ability.id,
              label: ability.name,
              group: null,
              cpCost: 0,
            }
          : { kind: "always" },
      unsupportedRelevance: "combat",
    });
    if (!entityHash) {
      output.push(await unresolvedRule({
        code: "missing-semantic-hash",
        message: `The leased bundle has no semantic hash for enhancement:${enhancementId}.`,
        referenceId: `enhancement:${enhancementId}`,
        source,
        phase: input.phase,
        bundleId: input.bundleId,
      }));
    }
  }
  return output;
}

async function missingReferenceRules(input: {
  context: SideContext;
  participantSelectionId: string;
  attachedSelectionIds: readonly string[];
  supportingSelectionIds: readonly string[];
  phase: CombatPhaseV2;
  bundleId: string;
}): Promise<BundleCombatRuleRecordV1[]> {
  const output: BundleCombatRuleRecordV1[] = [];
  const participant = input.context.unitsBySelectionId.get(
    input.participantSelectionId,
  );
  if (!participant?.view) {
    const unitId = participant?.selection.unitId ?? input.participantSelectionId;
    output.push(await unresolvedRule({
      code: "unit-mapping-missing",
      message: `Roster selection ${input.participantSelectionId} references unit ${unitId}, which is absent from the leased dataset.`,
      referenceId: unitId,
      source: { kind: "unit", unitId },
      phase: input.phase,
      bundleId: input.bundleId,
      entityHash: input.context.entityHashes[`unit:${unitId}`],
    }));
  } else {
    const members = [
      {
        selectionId: input.participantSelectionId,
        entry: participant,
        sourceKind: "unit" as const,
      },
      ...input.attachedSelectionIds.flatMap((selectionId) => {
        const entry = input.context.unitsBySelectionId.get(selectionId);
        return entry
          ? [{ selectionId, entry, sourceKind: "attached" as const }]
          : [];
      }),
      ...input.supportingSelectionIds.flatMap((selectionId) => {
        const entry = input.context.unitsBySelectionId.get(selectionId);
        return entry
          ? [{ selectionId, entry, sourceKind: "support" as const }]
          : [];
      }),
    ];
    for (const { selectionId, entry, sourceKind } of members) {
      if (!entry.view) continue;
      const resolvedIds = new Set(
        entry.view.abilities.map((ability) => ability.id),
      );
      for (const abilityId of entry.view.raw.ability_ids ?? []) {
        if (resolvedIds.has(abilityId)) continue;
        const source: CombatRuleSourceV1 =
          sourceKind === "unit"
            ? { kind: "unit", unitId: entry.selection.unitId }
            : sourceKind === "attached"
            ? { kind: "attached", sourceUnitId: entry.selection.unitId }
            : { kind: "support", sourceUnitId: entry.selection.unitId };
        output.push(await unresolvedRule({
          code: "unit-ability-mapping-missing",
          message: `Unit ${entry.selection.unitId} references missing ability ${abilityId}.`,
          referenceId: abilityId,
          source,
          phase: input.phase,
          bundleId: input.bundleId,
          entityHash: input.context.entityHashes[
            `unit:${entry.selection.unitId}`
          ],
        }));
      }
      for (const equipment of entry.selection.equipment) {
        if (equipment.count <= 0) continue;
        const source: CombatRuleSourceV1 = {
          kind: "wargear",
          wargearId: equipment.itemId,
          bearerUnitId: entry.selection.unitId,
          bearerSelectionId: selectionId,
        };
        const semanticKey =
          `equipment:${entry.selection.unitId}:${equipment.itemId}`;
        const entityHash = input.context.entityHashes[semanticKey];
        const weaponExists = rosterWeaponExists(
          input.context.dataset,
          input.context.roster,
          equipment.itemId,
        );
        const wargearExists = Boolean(
          input.context.dataset.wargear.get(equipment.itemId),
        );
        if (!weaponExists && !wargearExists) {
          output.push(await unresolvedRule({
            code: "equipment-mapping-missing",
            message:
              `Selected equipment ${equipment.name} (${equipment.itemId}) is absent from the captured dataset.`,
            referenceId: equipment.itemId,
            source,
            phase: input.phase,
            bundleId: input.bundleId,
            entityHash,
          }));
        } else if (!unitReferencesEquipment(entry.view, equipment.itemId)) {
          output.push(await unresolvedRule({
            code: "equipment-unit-mapping-missing",
            message:
              `Selected equipment ${equipment.name} (${equipment.itemId}) is not mapped to unit ${entry.selection.unitId} in the captured dataset.`,
            referenceId: equipment.itemId,
            source,
            phase: input.phase,
            bundleId: input.bundleId,
            entityHash,
          }));
        } else if (wargearExists && !weaponExists) {
          output.push(await unresolvedRule({
            code: "wargear-ability-mapping-missing",
            message:
              `Selected non-weapon wargear ${equipment.name} (${equipment.itemId}) has no structured combat ability mapping in the captured dataset.`,
            referenceId: equipment.itemId,
            source,
            phase: input.phase,
            bundleId: input.bundleId,
            entityHash,
          }));
        }
        if (!entityHash) {
          output.push(await unresolvedRule({
            code: "missing-semantic-hash",
            message: `The captured bundle has no semantic hash for ${semanticKey}.`,
            referenceId: semanticKey,
            source,
            phase: input.phase,
            bundleId: input.bundleId,
          }));
        }
      }
      if (
        (entry.view.raw.attachment_role === "leader" ||
          entry.view.raw.attachment_role === "support") &&
        !input.context.dataset.leaderAttachments.some(
          (attachment) => attachment.leader_id === entry.view!.id,
        )
      ) {
        output.push(await unresolvedRule({
          code: "attachment-mapping-missing",
          message: `Attachable unit ${entry.selection.unitId} has no leader/bodyguard mapping in the leased dataset.`,
          referenceId: entry.selection.unitId,
          source: {
            kind: "unit",
            unitId: entry.selection.unitId,
          },
          phase: input.phase,
          bundleId: input.bundleId,
          entityHash: input.context.entityHashes[
            `unit:${entry.selection.unitId}`
          ],
        }));
      }
    }
  }

  const faction = rosterFaction(input.context.dataset, input.context.roster);
  if (!faction) {
    output.push(await unresolvedRule({
      code: "faction-mapping-missing",
      message: `Roster faction ${input.context.roster.factionId} is absent from the captured dataset.`,
      referenceId: input.context.roster.factionId,
      source: {
        kind: "army",
        factionId: input.context.roster.factionId,
      },
      phase: input.phase,
      bundleId: input.bundleId,
      entityHash: input.context.entityHashes[
        `faction:${input.context.roster.factionId}`
      ],
    }));
  }
  if (
    faction?.raw.faction_rule_id &&
    !abilityInFaction(
      input.context.dataset,
      faction.raw.faction_rule_id,
      input.context.roster.factionId,
    )
  ) {
    output.push(await unresolvedRule({
      code: "army-ability-mapping-missing",
      message: `Faction ${input.context.roster.factionId} references missing army ability ${faction.raw.faction_rule_id}.`,
      referenceId: faction.raw.faction_rule_id,
      source: {
        kind: "army",
        factionId: input.context.roster.factionId,
      },
      phase: input.phase,
      bundleId: input.bundleId,
      entityHash: input.context.entityHashes[
        `faction:${input.context.roster.factionId}`
      ],
    }));
  }

  const detachment = rosterDetachment(
    input.context.dataset,
    input.context.roster,
  );
  if (!detachment) {
    output.push(await unresolvedRule({
      code: "detachment-mapping-missing",
      message: `Roster detachment ${input.context.roster.detachmentId} is absent from the leased dataset.`,
      referenceId: input.context.roster.detachmentId,
      source: {
        kind: "detachment",
        detachmentId: input.context.roster.detachmentId,
      },
      phase: input.phase,
      bundleId: input.bundleId,
      entityHash: input.context.entityHashes[
        `detachment:${input.context.roster.detachmentId}`
      ],
    }));
  } else {
    const ruleIds = sortedUnique([
      ...(detachment.detachment_rule_id
        ? [detachment.detachment_rule_id]
        : []),
      ...(detachment.detachment_rule_ids ?? []),
    ]);
    for (const abilityId of ruleIds) {
      if (
        abilityInFaction(
          input.context.dataset,
          abilityId,
          input.context.roster.factionId,
        )
      ) {
        continue;
      }
      output.push(await unresolvedRule({
        code: "detachment-ability-mapping-missing",
        message: `Detachment ${detachment.id} references missing ability ${abilityId}.`,
        referenceId: abilityId,
        source: { kind: "detachment", detachmentId: detachment.id },
        phase: input.phase,
        bundleId: input.bundleId,
        entityHash: input.context.entityHashes[`detachment:${detachment.id}`],
      }));
    }
    for (const stratagemId of detachment.stratagem_ids ?? []) {
      const stratagem = input.context.dataset.stratagems.get(stratagemId);
      if (stratagem?.ability_id && abilityInFaction(
        input.context.dataset,
        stratagem.ability_id,
        input.context.roster.factionId,
      )) {
        continue;
      }
      output.push(await unresolvedRule({
        code: "stratagem-ability-mapping-missing",
        message: `Detachment ${detachment.id} stratagem ${stratagemId} has no resolvable structured ability.`,
        referenceId: stratagemId,
        source: {
          kind: "detachment-stratagem",
          detachmentId: detachment.id,
          stratagemId,
        },
        phase: input.phase,
        bundleId: input.bundleId,
        entityHash: input.context.entityHashes[`detachment:${detachment.id}`],
      }));
    }
  }
  return output;
}

function compareRules(
  left: BundleCombatRuleRecordV1,
  right: BundleCombatRuleRecordV1,
): number {
  return (
    compareStrings(left.abilityId, right.abilityId) ||
    compareStrings(canonicalJson(left.source), canonicalJson(right.source)) ||
    compareStrings(left.entityHash, right.entityHash)
  );
}

async function rulesForParticipant(input: {
  context: SideContext;
  participantSelectionId: string;
  attachedSelectionIds: readonly string[];
  supportingSelectionIds: readonly string[];
  phase: CombatPhaseV2;
  bundleId: string;
  modelingMode: TesseraCombatPolicyV2["modelingMode"];
}): Promise<BundleCombatRuleRecordV1[]> {
  if (input.modelingMode === "base-profile") return [];
  const associatedSelectionIds = sortedUnique([
    ...input.attachedSelectionIds,
    ...input.supportingSelectionIds,
  ]);
  const participant = input.context.unitsBySelectionId.get(
    input.participantSelectionId,
  );
  if (!participant?.view) {
    const [missing, enhancements] = await Promise.all([
      missingReferenceRules(input),
      enhancementRules({
        context: input.context,
        bearerSelectionIds: [
          input.participantSelectionId,
          ...associatedSelectionIds,
        ],
        phase: input.phase,
        bundleId: input.bundleId,
      }),
    ]);
    return [...missing, ...enhancements].sort(compareRules);
  }
  const attachedUnitIds = input.attachedSelectionIds.flatMap(
    (selectionId) => {
      const unitId = input.context.unitsBySelectionId.get(selectionId)
        ?.selection.unitId;
      return unitId ? [unitId] : [];
    },
  );
  const supportingUnitIds = input.supportingSelectionIds.flatMap(
    (selectionId) => {
      const unitId = input.context.unitsBySelectionId.get(selectionId)
        ?.selection.unitId;
      return unitId ? [unitId] : [];
    },
  );
  const eligible = input.context.dataset.eligibleAbilities({
    unitId: participant.view.id,
    factionId: input.context.roster.factionId,
    detachmentId: input.context.roster.detachmentId,
    attachedUnitIds,
    supportingUnitIds,
  }, input.phase);
  const mapped = await Promise.all(
    eligible.map((entry) => ruleForEligible({
      eligible: entry,
      context: input.context,
      phase: input.phase,
      bundleId: input.bundleId,
    })),
  );
  const enhancements = await enhancementRules({
    context: input.context,
    bearerSelectionIds: [
      input.participantSelectionId,
      ...associatedSelectionIds,
    ],
    phase: input.phase,
    bundleId: input.bundleId,
  });
  const missing = await missingReferenceRules(input);
  const unique = new Map<string, BundleCombatRuleRecordV1>();
  for (const rule of [...mapped.flat(), ...enhancements, ...missing]) {
    const key = canonicalJson({
      abilityId: rule.abilityId,
      source: rule.source,
      entityHash: rule.entityHash,
      effect: rule.effect,
      activation: rule.activation,
    });
    unique.set(key, rule);
  }
  return [...unique.values()].sort(compareRules);
}

function triState<T, F>(
  value: TesseraEngagementState,
  whenTrue: T,
  whenFalse: F,
): T | F | "unknown" {
  return value === "unknown" ? "unknown" : value ? whenTrue : whenFalse;
}

function halfRangeState(
  scenario: TesseraScenarioEntryV2,
): boolean | "unknown" {
  const rapid = scenario.engagement.withinRapidFireRange;
  const melta = scenario.engagement.withinMeltaRange;
  if (rapid === "unknown" || melta === "unknown") return "unknown";
  return rapid === melta ? rapid : "unknown";
}

export function combatScenarioContextV2FromTesseraScenario(
  scenario: TesseraScenarioEntryV2,
): CombatScenarioContextV2 {
  return {
    schemaVersion: 2,
    phase: scenario.phase,
    distanceInches: scenario.engagement.distanceInches,
    withinHalfRange: halfRangeState(scenario),
    attackerStationary: scenario.engagement.remainedStationary,
    attackerCharged: scenario.engagement.charging,
    attackerAttached: "unknown",
    targetAttached: "unknown",
    attackerInCover: "unknown",
    targetInCover: scenario.engagement.targetInCover,
    timing: scenario.engagement.timing,
    objectiveState: triState(
      scenario.engagement.objectiveControl,
      "controlled",
      "not-controlled",
    ),
    attackerStrengthState: triState(
      scenario.engagement.belowStrength,
      "below-starting",
      "starting",
    ),
    targetStrengthState: "unknown",
    attackerDamageState: triState(
      scenario.engagement.damaged,
      "damaged",
      "healthy",
    ),
    targetDamageState: "unknown",
    armyAbilityState: triState(
      scenario.engagement.armyAbilityActive,
      "active",
      "inactive",
    ),
    targetConditionState: triState(
      scenario.engagement.targetCondition,
      "met",
      "not-met",
    ),
  };
}

export function combatPolicyV1FromTesseraCombatPolicyV2(
  policy: TesseraCombatPolicyV2,
): CombatPolicyV1 {
  const selectedActivationIds = policy.activations.mode === "selected"
    ? [...policy.activations.selectedIds]
    : [];
  return {
    schemaVersion: 1,
    activationMode: policy.activations.mode,
    selectedActivationIds: sortedUnique(selectedActivationIds),
    resourceBudget:
      policy.activations.resourceBudget === null
        ? null
        : { cp: policy.activations.resourceBudget },
    ...(policy.activations.options.length > 0
      ? {
          activationConstraints: {
            options: policy.activations.options.map((option) => ({
              id: option.id,
              groupId: option.groupId,
              cpCost: option.resourceCost,
            })),
            groups: policy.activations.groups.map((group) => ({
              id: group.id,
              maxActivations: group.maximumActive,
            })),
          },
        }
      : {}),
    // Selected bindings are reduced to one legal rule variant per cell. The
    // bridge's v1 policy is direction-global and cannot faithfully express a
    // player-owned binding after attacker/target direction reverses.
    attachmentMode: "enumerate",
    attachments: { attacker: [], target: [] },
    limits: {
      maxAttachmentPlans: policy.limits.maxAttachmentPlans,
      maxJointVariants: policy.limits.maxJointVariants,
    },
  };
}

function cellId(input: {
  scenario: TesseraScenarioEntryV2;
  attackerSelectionId: string;
  targetSelectionId: string;
}): string {
  return [
    input.scenario.direction,
    input.scenario.phase,
    input.scenario.metric,
    input.attackerSelectionId,
    input.targetSelectionId,
  ].join(":");
}

async function cellsForScenario(input: {
  scenario: TesseraScenarioEntryV2;
  policy: TesseraCombatPolicyV2;
  player: SideContext;
  opponent: SideContext;
  bundleId: string;
}): Promise<CombatBridgeCellInputV2[]> {
  const attacker = input.scenario.direction === "player-to-opponent"
    ? input.player
    : input.opponent;
  const target = input.scenario.direction === "player-to-opponent"
    ? input.opponent
    : input.player;
  const plans = await combinedAttachmentPlans({
    attacker,
    target,
    policy: input.policy,
  });
  const attackerSelections = [...attacker.unitsBySelectionId.values()].sort(
    (left, right) => compareStrings(
      left.selection.selectionId,
      right.selection.selectionId,
    ),
  );
  const targetSelections = [...target.unitsBySelectionId.values()].sort(
    (left, right) => compareStrings(
      left.selection.selectionId,
      right.selection.selectionId,
    ),
  );
  const cells: CombatBridgeCellInputV2[] = [];
  for (const attackerEntry of attackerSelections) {
    for (const targetEntry of targetSelections) {
      const ruleVariants = await Promise.all(plans.map(async (plan) => {
        const attackerAttachmentIds = participantAttachmentSelectionIds(
          plan,
          "attacker",
          attackerEntry.selection.selectionId,
        );
        const targetAttachmentIds = participantAttachmentSelectionIds(
          plan,
          "target",
          targetEntry.selection.selectionId,
        );
        return {
          attachmentPlan: plan,
          attackerRules: await rulesForParticipant({
            context: attacker,
            participantSelectionId: attackerEntry.selection.selectionId,
            ...attackerAttachmentIds,
            phase: input.scenario.phase,
            bundleId: input.bundleId,
            modelingMode: input.policy.modelingMode,
          }),
          targetRules: await rulesForParticipant({
            context: target,
            participantSelectionId: targetEntry.selection.selectionId,
            ...targetAttachmentIds,
            phase: input.scenario.phase,
            bundleId: input.bundleId,
            modelingMode: input.policy.modelingMode,
          }),
        };
      }));
      cells.push({
        cellId: cellId({
          scenario: input.scenario,
          attackerSelectionId: attackerEntry.selection.selectionId,
          targetSelectionId: targetEntry.selection.selectionId,
        }),
        direction: input.scenario.direction,
        metric: input.scenario.metric,
        attacker: {
          rosterId: attacker.roster.id,
          selectionId: attackerEntry.selection.selectionId,
          unitId: attackerEntry.selection.unitId,
          factionId: attacker.roster.factionId,
          keywords: normalizedKeywords(attackerEntry.view),
        },
        target: {
          rosterId: target.roster.id,
          selectionId: targetEntry.selection.selectionId,
          unitId: targetEntry.selection.unitId,
          factionId: target.roster.factionId,
          keywords: normalizedKeywords(targetEntry.view),
        },
        scenario: combatScenarioContextV2FromTesseraScenario(
          input.scenario,
        ),
        ruleVariants,
      });
    }
  }
  return cells;
}

type CapturedDatasetBinding = {
  bundleId: string;
  engineDataSchemaVersion: number;
  semanticAuthority: "bundle-manifest-verified" | "roster-asserted";
  playerFactionRulesHash: string;
  opponentFactionRulesHash: string;
  playerMappingHash: string;
  opponentMappingHash: string;
  playerEntityHashes: Readonly<Record<string, string>>;
  opponentEntityHashes: Readonly<Record<string, string>>;
  portfolioHash: string | null;
};

async function compileCapturedDatasetInput(input: {
  dataset: Dataset;
  playerRoster: RosterDraftV1;
  opponentRoster: RosterDraftV1;
  scenarioPolicy: TesseraScenarioPolicyContractV2;
  binding: CapturedDatasetBinding;
}): Promise<CompileCombatBridgeInputV2> {
  const scenarioPolicy = canonicalTesseraScenarioPolicyContractV2(
    input.scenarioPolicy,
  );
  const player = sideContext({
    role: "player",
    roster: input.playerRoster,
    dataset: input.dataset,
    entityHashes: input.binding.playerEntityHashes,
  });
  const opponent = sideContext({
    role: "opponent",
    roster: input.opponentRoster,
    dataset: input.dataset,
    entityHashes: input.binding.opponentEntityHashes,
  });
  const cellGroups = await Promise.all(
    scenarioPolicy.scenarios.map((scenario) => cellsForScenario({
      scenario,
      policy: scenarioPolicy.policy,
      player,
      opponent,
      bundleId: input.binding.bundleId,
    })),
  );
  return {
    bundle: {
      bundleId: input.binding.bundleId,
      engineDataSchemaVersion: input.binding.engineDataSchemaVersion,
      semanticAuthority: input.binding.semanticAuthority,
      playerRosterId: input.playerRoster.id,
      opponentRosterId: input.opponentRoster.id,
      playerRosterFingerprint:
        rosterExecutionFingerprint(input.playerRoster),
      opponentRosterFingerprint:
        rosterExecutionFingerprint(input.opponentRoster),
      playerFactionId: input.playerRoster.factionId,
      opponentFactionId: input.opponentRoster.factionId,
      playerRosterRulesHash:
        input.playerRoster.sourceData.rosterRulesHash,
      opponentRosterRulesHash:
        input.opponentRoster.sourceData.rosterRulesHash,
      playerFactionRulesHash: input.binding.playerFactionRulesHash,
      opponentFactionRulesHash: input.binding.opponentFactionRulesHash,
      playerMappingHash: input.binding.playerMappingHash,
      opponentMappingHash: input.binding.opponentMappingHash,
      portfolioHash: input.binding.portfolioHash,
    },
    policy: combatPolicyV1FromTesseraCombatPolicyV2(
      scenarioPolicy.policy,
    ),
    cells: cellGroups.flat().sort((left, right) =>
      compareStrings(left.cellId, right.cellId),
    ),
  };
}

/**
 * Compile from a captured Dataset without consulting any module-global data.
 *
 * A bare Dataset does not retain bundle semantic manifests or New Recruit
 * mapping payloads, so their hashes cannot be recomputed here. The canonical
 * roster identities are retained verbatim as the binding, while every faction,
 * detachment, unit, attachment, ability, stratagem, and enhancement reference
 * is resolved against the supplied Dataset. Missing references are emitted as
 * explicit unresolved bridge rules rather than silently substituted.
 */
export async function compileCombatBridgeInputV2FromDataset(
  input: CombatBridgeInputFromDatasetV2,
): Promise<CompileCombatBridgeInputV2> {
  const playerRoster = canonicalRoster(input.playerRoster, "Player roster");
  const opponentRoster = canonicalRoster(
    input.opponentRoster,
    "Opponent roster",
  );
  assertRosterPairBindings({ playerRoster, opponentRoster });
  return compileCapturedDatasetInput({
    dataset: input.dataset,
    playerRoster,
    opponentRoster,
    scenarioPolicy: input.scenarioPolicy,
    binding: {
      bundleId: playerRoster.sourceData.bundleId,
      engineDataSchemaVersion:
        playerRoster.sourceData.engineDataSchemaVersion,
      semanticAuthority: "roster-asserted",
      playerFactionRulesHash: playerRoster.sourceData.factionRulesHash,
      opponentFactionRulesHash: opponentRoster.sourceData.factionRulesHash,
      playerMappingHash: playerRoster.sourceData.mappingHash,
      opponentMappingHash: opponentRoster.sourceData.mappingHash,
      playerEntityHashes: playerRoster.sourceData.entityHashes,
      opponentEntityHashes: opponentRoster.sourceData.entityHashes,
      // Portfolio identity is a manifest-level artifact and is intentionally
      // unknown when only a captured Dataset and canonical rosters are held.
      portfolioHash: null,
    },
  });
}

export async function compileCombatBridgeInputV2FromSnapshot(
  input: CombatBridgeInputFromSnapshotV2,
): Promise<CompileCombatBridgeInputV2> {
  const playerRoster = canonicalRoster(input.playerRoster, "Player roster");
  const opponentRoster = canonicalRoster(
    input.opponentRoster,
    "Opponent roster",
  );
  assertBundleBindings({
    snapshot: input.snapshot,
    playerRoster,
    opponentRoster,
  });
  const playerSemantic =
    input.snapshot.manifest.semanticHashes.factions[playerRoster.factionId];
  const opponentSemantic =
    input.snapshot.manifest.semanticHashes.factions[opponentRoster.factionId];
  const portfolioHash = await sha256Hex(canonicalJson({
    player: playerSemantic.portfolioHash,
    opponent: opponentSemantic.portfolioHash,
  }));
  return compileCapturedDatasetInput({
    dataset: runtimeDatasetFromSnapshot(input.snapshot),
    playerRoster,
    opponentRoster,
    scenarioPolicy: input.scenarioPolicy,
    binding: {
      bundleId: input.snapshot.bundleId,
      engineDataSchemaVersion:
        input.snapshot.manifest.engineDataSchemaVersion,
      semanticAuthority: "bundle-manifest-verified",
      playerFactionRulesHash: playerSemantic.factionRulesHash,
      opponentFactionRulesHash: opponentSemantic.factionRulesHash,
      playerMappingHash: playerSemantic.mappingHash,
      opponentMappingHash: opponentSemantic.mappingHash,
      playerEntityHashes: playerSemantic.entityHashes,
      opponentEntityHashes: opponentSemantic.entityHashes,
      portfolioHash,
    },
  });
}

export async function compileCombatBridgeInputV2WithProvider(
  input: CombatBridgeInputFromProviderV2,
): Promise<CompileCombatBridgeInputV2> {
  const playerRoster = canonicalRoster(input.playerRoster, "Player roster");
  const opponentRoster = canonicalRoster(
    input.opponentRoster,
    "Opponent roster",
  );
  assertRosterPairBindings({ playerRoster, opponentRoster });
  const lease = await input.provider.acquireSnapshot({
    bundleId: playerRoster.sourceData.bundleId,
    factionIds: sortedUnique([
      playerRoster.factionId,
      opponentRoster.factionId,
    ]),
    signal: input.signal,
  });
  try {
    return await compileCombatBridgeInputV2FromSnapshot({
      snapshot: lease.snapshot,
      playerRoster,
      opponentRoster,
      scenarioPolicy: input.scenarioPolicy,
    });
  } finally {
    await lease.release();
  }
}
