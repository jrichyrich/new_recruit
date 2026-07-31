import {
  crunch,
  type Buff,
  type EngineContext,
} from "@alpaca-software/40kdc-data";

import {
  abilities,
  detachments,
  factions,
  units,
} from "./runtime-dataset";
import type {
  BaselineDamageCell,
  ProfilePolicyV1,
  RosterDraftV1,
  TesseraPhase,
} from "./types";

type BuffProvider = {
  id: string;
  affectsUnit?: (
    unit: NonNullable<ReturnType<typeof unitView>>,
  ) => boolean;
  getBuffs: (
    source: {
      kind: "ability";
      abilityId: string;
      abilityKind: "army" | "detachment" | "unit";
    },
    context: EngineContext,
    perspective: "attacker" | "target",
  ) => Buff[];
};

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function selectedProfileName(
  policy: ProfilePolicyV1 | null,
  roster: RosterDraftV1,
  unitName: string,
  weaponGroup: string,
  phase: TesseraPhase,
): string | null {
  const match = policy?.entries.find(
    (entry) =>
      normalized(entry.faction) === normalized(roster.factionId) &&
      normalized(entry.unit) === normalized(unitName) &&
      normalized(entry.weaponGroup) === normalized(weaponGroup) &&
      entry.phase === phase,
  );
  return match?.selectedProfile ?? null;
}

function abilityBuffs(
  ability: BuffProvider | undefined,
  kind: "army" | "detachment" | "unit",
  context: EngineContext,
  perspective: "attacker" | "target",
): Buff[] {
  if (!ability) return [];
  try {
    return ability.getBuffs(
      {
        kind: "ability",
        abilityId: ability.id,
        abilityKind: kind,
      },
      context,
      perspective,
    );
  } catch {
    return [];
  }
}

function unitView(roster: RosterDraftV1, unitId: string) {
  return units.getInFaction(unitId, roster.factionId);
}

function ruleBuffs(
  roster: RosterDraftV1,
  unit: NonNullable<ReturnType<typeof unitView>>,
  context: EngineContext,
  perspective: "attacker" | "target",
): Buff[] {
  const faction = factions.get(roster.factionId);
  const factionRule = abilities.get(
    faction?.raw.faction_rule_id ?? "",
  ) as BuffProvider | undefined;
  const detachment = detachments.get(roster.detachmentId);
  const detachmentRule = abilities.get(
    detachment?.detachment_rule_id ?? "",
  ) as BuffProvider | undefined;
  return [
    ...abilityBuffs(factionRule, "army", context, perspective),
    ...(
      !detachmentRule ||
      detachmentRule.affectsUnit?.(unit) !== false
        ? abilityBuffs(
            detachmentRule,
            "detachment",
            context,
            perspective,
          )
        : []
    ),
    ...unit.abilities.flatMap((ability) =>
      abilityBuffs(
        ability as BuffProvider,
        "unit",
        context,
        perspective,
      ),
    ),
  ];
}

function keywords(
  unit: NonNullable<ReturnType<typeof unitView>>,
): string[] {
  return [
    ...(unit.raw.keywords ?? []),
    ...(unit.raw.faction_keywords ?? []),
  ].map((keyword) => keyword.toLocaleLowerCase());
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function damageCell(
  attackerRoster: RosterDraftV1,
  attacker: RosterDraftV1["units"][number],
  targetRoster: RosterDraftV1,
  target: RosterDraftV1["units"][number],
  phase: TesseraPhase,
  profilePolicy: ProfilePolicyV1 | null,
): BaselineDamageCell | null {
  const attackerUnit = unitView(attackerRoster, attacker.unitId);
  const targetUnit = unitView(targetRoster, target.unitId);
  if (!attackerUnit || !targetUnit) return null;
  const context: EngineContext = {
    phase,
    attackerStationary: false,
    attackerCharged: phase === "fight",
    withinHalfRange: false,
    distanceInches: phase === "fight" ? 1 : 18,
    targetInCover: false,
    attackerKeywords: keywords(attackerUnit),
    targetKeywords: keywords(targetUnit),
    attackerAttached: false,
  };
  const buffs = [
    ...ruleBuffs(attackerRoster, attackerUnit, context, "attacker"),
    ...ruleBuffs(targetRoster, targetUnit, context, "target"),
  ];
  const weaponProfiles: BaselineDamageCell["weaponProfiles"] = [];
  for (const equipment of attacker.equipment) {
    if (equipment.count <= 0) continue;
    const weapon = attackerUnit.weapons.find(
      (candidate) => candidate.id === equipment.itemId,
    );
    if (!weapon) continue;
    const phaseProfiles = weapon.raw.profiles
      .map((profile, index) => ({ profile, index }))
      .filter(({ profile }) =>
        phase === "fight"
          ? profile.range === "Melee"
          : profile.range !== "Melee",
      );
    const selected = selectedProfileName(
      profilePolicy,
      attackerRoster,
      attacker.name,
      equipment.name,
      phase,
    );
    const activeProfiles = selected
      ? phaseProfiles.filter(
          ({ profile }) =>
            normalized(profile.name) === normalized(selected),
        )
      : phaseProfiles.length <= 1
        ? phaseProfiles
        : [];
    for (const { profile, index } of activeProfiles) {
      const output = crunch({
        attacker: {
          weapon: weapon.raw,
          profileIndex: index,
        },
        target: {
          unit: targetUnit.raw,
          profileIndex: 0,
          modelCount: target.modelCount,
        },
        modelsFiring: equipment.count,
        buffs,
        context,
      });
      weaponProfiles.push({
        weaponId: equipment.itemId,
        profile: profile.name,
        modelsFiring: equipment.count,
        expectedDamage: round(
          output.stages.find((stage) => stage.name === "after-fnp")
            ?.expected ?? 0,
        ),
        expectedModelsKilled: round(
          output.stages.find(
            (stage) => stage.name === "models-killed",
          )?.expected ?? 0,
        ),
      });
    }
  }
  return {
    attackerSelectionId: attacker.selectionId,
    attacker: attacker.name,
    targetSelectionId: target.selectionId,
    target: target.name,
    phase,
    expectedDamage: round(
      weaponProfiles.reduce(
        (total, profile) => total + profile.expectedDamage,
        0,
      ),
    ),
    expectedModelsKilled: round(
      Math.min(
        target.modelCount,
        weaponProfiles.reduce(
          (total, profile) =>
            total + profile.expectedModelsKilled,
          0,
        ),
      ),
    ),
    weaponProfiles,
  };
}

export function baselineDamageCells(
  player: RosterDraftV1,
  opponent: RosterDraftV1,
  profilePolicy: ProfilePolicyV1 | null = null,
): BaselineDamageCell[] {
  const cells: BaselineDamageCell[] = [];
  for (const phase of ["shooting", "fight"] as const) {
    for (const attacker of player.units) {
      for (const target of opponent.units) {
        const cell = damageCell(
          player,
          attacker,
          opponent,
          target,
          phase,
          profilePolicy,
        );
        if (cell) cells.push(cell);
      }
    }
    for (const attacker of opponent.units) {
      for (const target of player.units) {
        const cell = damageCell(
          opponent,
          attacker,
          player,
          target,
          phase,
          profilePolicy,
        );
        if (cell) cells.push(cell);
      }
    }
  }
  return cells;
}
