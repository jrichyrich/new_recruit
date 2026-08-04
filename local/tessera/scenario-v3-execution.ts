import crypto from "node:crypto";

import { canonicalJson } from "../../lib/rosterpilot";
import type {
  LocalEngineWeapon,
  LocalTesseraEngineUnit,
} from "./local-engine-input";
import type { LocalTesseraCombatFormation } from "./local-engine-formation";
import type {
  TesseraPairPhysicalStateV3,
  TesseraScenarioEntryV3,
  TesseraScenarioSide,
  TesseraUnitPhysicalStateV3,
} from "./scenario-contract-v3";

export type LocalTesseraExecutableUnit =
  | LocalTesseraEngineUnit
  | LocalTesseraCombatFormation;

export type LocalTesseraScenarioV3CellProjection = {
  attacker: LocalTesseraExecutableUnit;
  settings: Record<string, string>;
  attackEligible: boolean;
  combatStateSha256: string;
};

export class LocalTesseraScenarioV3ExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalTesseraScenarioV3ExecutionError";
  }
}

function executionError(code: string, message: string): never {
  throw new LocalTesseraScenarioV3ExecutionError(code, message);
}

function attackerSide(
  direction: TesseraScenarioEntryV3["direction"],
): TesseraScenarioSide {
  return direction === "player-to-opponent" ? "player" : "opponent";
}

function memberSelectionIds(unit: LocalTesseraExecutableUnit): string[] {
  const candidate = unit as Partial<LocalTesseraCombatFormation>;
  return candidate.memberSelectionIds?.length
    ? [...candidate.memberSelectionIds]
    : [unit.selectionId];
}

function unitState(
  scenario: TesseraScenarioEntryV3,
  side: TesseraScenarioSide,
  selectionId: string,
): TesseraUnitPhysicalStateV3 {
  const found = scenario.state[side].units.find(
    (unit) => unit.selectionId === selectionId,
  );
  return found ?? executionError(
    "TESSERA_SCENARIO_POLICY_CONTRACT_V3_SCOPE_MISMATCH",
    `The v3 physical state has no ${side} unit selection ${JSON.stringify(selectionId)}.`,
  );
}

function pairState(
  scenario: TesseraScenarioEntryV3,
  attacker: TesseraScenarioSide,
  attackerSelectionId: string,
  targetSelectionId: string,
): TesseraPairPhysicalStateV3 {
  const target = attacker === "player" ? "opponent" : "player";
  const found = scenario.state.pairs.find(
    (pair) =>
      pair.attackerSide === attacker &&
      pair.attackerSelectionId === attackerSelectionId &&
      pair.targetSide === target &&
      pair.targetSelectionId === targetSelectionId,
  );
  return found ?? executionError(
    "TESSERA_SCENARIO_POLICY_CONTRACT_V3_SCOPE_MISMATCH",
    `The v3 physical state has no pair ${attackerSelectionId}->${targetSelectionId}.`,
  );
}

function oneFormationValue<T>(
  values: readonly T[],
  label: string,
): T {
  const first = values[0];
  if (
    first === undefined ||
    values.some((value) => canonicalJson(value) !== canonicalJson(first))
  ) {
    return executionError(
      "TESSERA_LOCAL_FORMATION_STATE_INCONSISTENT",
      `An attached formation has inconsistent ${label}; select one physical state for every attached member.`,
    );
  }
  return first;
}

function keywordMatches(keyword: string, name: string): boolean {
  const normalized = keyword.trim().toLocaleUpperCase();
  return normalized === name || normalized.startsWith(`${name} `);
}

function hasKeyword(weapon: LocalEngineWeapon, name: string): boolean {
  return weapon.keywords.some((keyword) => keywordMatches(keyword, name));
}

function withoutKeyword(
  weapon: LocalEngineWeapon,
  name: string,
): LocalEngineWeapon {
  return {
    ...weapon,
    keywords: weapon.keywords.filter(
      (keyword) => !keywordMatches(keyword, name),
    ),
  };
}

function rangedWeapons(
  unit: LocalTesseraExecutableUnit,
): LocalEngineWeapon[] {
  const attached = (
    unit as LocalTesseraExecutableUnit & {
      attached?: LocalTesseraEngineUnit[];
    }
  ).attached ?? [];
  return [unit, ...attached].flatMap((member) =>
    member.weapons.filter((weapon) => weapon.type === "ranged"),
  );
}

function rangeFor(weapon: LocalEngineWeapon): number {
  if (
    typeof weapon.rangeInches !== "number" ||
    !Number.isFinite(weapon.rangeInches) ||
    weapon.rangeInches <= 0
  ) {
    return executionError(
      "TESSERA_LOCAL_WEAPON_RANGE_MISSING",
      `Selected-state execution requires a numeric range for ranged profile ${JSON.stringify(weapon.name)}.`,
    );
  }
  return weapon.rangeInches;
}

function relevantRangeCondition(
  weapons: readonly LocalEngineWeapon[],
  keyword: string,
  distanceInches: number,
  condition: "within-half" | "conversion",
): boolean | null {
  const matching = weapons.filter((weapon) => hasKeyword(weapon, keyword));
  if (matching.length === 0) return null;
  return matching.some((weapon) => {
    const range = rangeFor(weapon);
    if (distanceInches > range) return false;
    return condition === "within-half"
      ? distanceInches <= range / 2
      : distanceInches >= range / 2;
  });
}

function assertPairBoolean(
  declared: boolean,
  computed: boolean | null,
  label: string,
): void {
  if (computed !== null && declared !== computed) {
    executionError(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_STATE_CONTRADICTION",
      `The selected ${label} state contradicts the exact weapon ranges and pair distance.`,
    );
  }
}

function projectWeapon(
  weapon: LocalEngineWeapon,
  input: {
    distanceInches: number;
    targetVisible: boolean;
    indirectFire: boolean;
  },
): LocalEngineWeapon | null {
  if (weapon.type !== "ranged") return weapon;
  const range = rangeFor(weapon);
  if (input.distanceInches > range) return null;
  if (!input.targetVisible && !hasKeyword(weapon, "INDIRECT FIRE")) {
    return null;
  }
  let projected = weapon;
  if (
    hasKeyword(projected, "RAPID FIRE") &&
    input.distanceInches > range / 2
  ) {
    projected = withoutKeyword(projected, "RAPID FIRE");
  }
  if (
    hasKeyword(projected, "MELTA") &&
    input.distanceInches > range / 2
  ) {
    projected = withoutKeyword(projected, "MELTA");
  }
  if (
    hasKeyword(projected, "CONVERSION") &&
    input.distanceInches < range / 2
  ) {
    projected = withoutKeyword(projected, "CONVERSION");
  }
  return projected;
}

function projectAttackerWeapons(
  unit: LocalTesseraExecutableUnit,
  input: {
    distanceInches: number;
    targetVisible: boolean;
    indirectFire: boolean;
  },
): LocalTesseraExecutableUnit {
  const project = (member: LocalTesseraEngineUnit) => ({
    ...member,
    weapons: member.weapons.flatMap((weapon) => {
      const projected = projectWeapon(weapon, input);
      return projected ? [projected] : [];
    }),
  });
  const attached = (
    unit as LocalTesseraExecutableUnit & {
      attached?: LocalTesseraEngineUnit[];
    }
  ).attached;
  return {
    ...project(unit),
    ...(attached ? { attached: attached.map(project) } : {}),
  } as LocalTesseraExecutableUnit;
}

function hasPhaseWeapon(
  unit: LocalTesseraExecutableUnit,
  phase: TesseraScenarioEntryV3["phase"],
): boolean {
  const type = phase === "shooting" ? "ranged" : "melee";
  const attached = (
    unit as LocalTesseraExecutableUnit & {
      attached?: LocalTesseraEngineUnit[];
    }
  ).attached ?? [];
  return [unit, ...attached].some((member) =>
    member.weapons.some((weapon) => weapon.type === type),
  );
}

function selectedBoolean(value: boolean | "unknown", label: string): boolean {
  return value === "unknown"
    ? executionError(
        "TESSERA_LOCAL_ENGAGEMENT_UNRESOLVED",
        `Selected-state execution requires an explicit ${label}.`,
      )
    : value;
}

export function localTesseraScenarioV3CellStateSha256(input: {
  scenario: TesseraScenarioEntryV3;
  attacker: LocalTesseraExecutableUnit;
  target: LocalTesseraExecutableUnit;
}): string {
  return tesseraScenarioV3CombatStateSha256({
    scenario: input.scenario,
    attackerSelectionIds: memberSelectionIds(input.attacker),
    targetSelectionIds: memberSelectionIds(input.target),
  });
}

/**
 * Provider-neutral selected-state identity. Both the local simulator and the
 * Web evidence adapter use this exact projection, so provider-specific cell
 * labels cannot silently change the physical combat state being compared.
 */
export function tesseraScenarioV3CombatStateSha256(input: {
  scenario: TesseraScenarioEntryV3;
  attackerSelectionIds: readonly string[];
  targetSelectionIds: readonly string[];
}): string {
  const side = attackerSide(input.scenario.direction);
  const targetSide = side === "player" ? "opponent" : "player";
  const attackerSelectionIds = [...input.attackerSelectionIds];
  const targetSelectionIds = [...input.targetSelectionIds];
  if (
    attackerSelectionIds.length === 0 ||
    targetSelectionIds.length === 0 ||
    new Set(attackerSelectionIds).size !== attackerSelectionIds.length ||
    new Set(targetSelectionIds).size !== targetSelectionIds.length
  ) {
    executionError(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_SCOPE_MISMATCH",
      "A provider-parity combat state requires non-empty, unique attacker and target selection identities.",
    );
  }
  const combatState = {
    schemaVersion: 1,
    phase: input.scenario.phase,
    direction: input.scenario.direction,
    battleRound: input.scenario.state.battleRound,
    timing: input.scenario.state.timing,
    attackerSelectionIds,
    targetSelectionIds,
    attackerStates: attackerSelectionIds.map((selectionId) =>
      unitState(input.scenario, side, selectionId),
    ),
    targetStates: targetSelectionIds.map((selectionId) =>
      unitState(input.scenario, targetSide, selectionId),
    ),
    pairStates: attackerSelectionIds.flatMap((attackerSelectionId) =>
      targetSelectionIds.map((targetSelectionId) =>
        pairState(
          input.scenario,
          side,
          attackerSelectionId,
          targetSelectionId,
        ),
      ),
    ),
    playerResources: input.scenario.state.player.resources,
    opponentResources: input.scenario.state.opponent.resources,
    playerArmyAbilities: input.scenario.state.player.armyAbilities,
    opponentArmyAbilities: input.scenario.state.opponent.armyAbilities,
    playerOncePerBattle: input.scenario.state.player.oncePerBattle,
    opponentOncePerBattle: input.scenario.state.opponent.oncePerBattle,
  };
  return crypto
    .createHash("sha256")
    .update(canonicalJson(combatState))
    .digest("hex");
}

/**
 * Projects one selected v3 physical state onto one executable local-engine
 * cell. Formation members must agree because the upstream simulator consumes
 * an attached unit as one physical attacker/target.
 */
export function projectLocalTesseraScenarioV3Cell(input: {
  scenario: TesseraScenarioEntryV3;
  attacker: LocalTesseraExecutableUnit;
  target: LocalTesseraExecutableUnit;
}): LocalTesseraScenarioV3CellProjection {
  const side = attackerSide(input.scenario.direction);
  const targetSide = side === "player" ? "opponent" : "player";
  const attackerIds = memberSelectionIds(input.attacker);
  const targetIds = memberSelectionIds(input.target);
  const attackerStates = attackerIds.map((selectionId) =>
    unitState(input.scenario, side, selectionId),
  );
  const targetStates = targetIds.map((selectionId) =>
    unitState(input.scenario, targetSide, selectionId),
  );
  const pairStates = attackerIds.flatMap((attackerSelectionId) =>
    targetIds.map((targetSelectionId) =>
      pairState(
        input.scenario,
        side,
        attackerSelectionId,
        targetSelectionId,
      ),
    ),
  );
  const pair = oneFormationValue(pairStates, "attacker/target pair state");
  if (typeof pair.distanceInches !== "number") {
    executionError(
      "TESSERA_LOCAL_ENGAGEMENT_UNRESOLVED",
      "Selected-state execution requires an exact attacker/target distance.",
    );
  }
  const distanceInches = pair.distanceInches;
  const targetVisible = selectedBoolean(pair.targetVisible, "target visibility");
  const indirectFire = selectedBoolean(pair.indirectFire, "indirect-fire state");
  const withinRapidFireRange = selectedBoolean(
    pair.withinRapidFireRange,
    "Rapid Fire range state",
  );
  const withinMeltaRange = selectedBoolean(
    pair.withinMeltaRange,
    "Melta range state",
  );
  if (targetVisible && indirectFire) {
    executionError(
      "TESSERA_SCENARIO_POLICY_CONTRACT_V3_STATE_CONTRADICTION",
      "A visible target cannot simultaneously use the selected indirect-fire state.",
    );
  }
  if (!targetVisible && !indirectFire) {
    // This is a valid physical state; it simply yields no eligible shooting.
  }

  let attacker = input.attacker;
  let attackEligible = true;
  if (input.scenario.phase === "shooting") {
    const weapons = rangedWeapons(input.attacker);
    const anyInRange = weapons.length > 0
      ? weapons.some((weapon) => distanceInches <= rangeFor(weapon))
      : null;
    assertPairBoolean(
      selectedBoolean(pair.withinRange, "within-range state"),
      anyInRange,
      "within-range",
    );
    assertPairBoolean(
      withinRapidFireRange,
      relevantRangeCondition(
        weapons,
        "RAPID FIRE",
        distanceInches,
        "within-half",
      ),
      "Rapid Fire range",
    );
    assertPairBoolean(
      withinMeltaRange,
      relevantRangeCondition(
        weapons,
        "MELTA",
        distanceInches,
        "within-half",
      ),
      "Melta range",
    );
    assertPairBoolean(
      selectedBoolean(
        pair.withinConversionRange,
        "Conversion range state",
      ),
      relevantRangeCondition(
        weapons,
        "CONVERSION",
        distanceInches,
        "conversion",
      ),
      "Conversion range",
    );
    attacker = projectAttackerWeapons(input.attacker, {
      distanceInches,
      targetVisible,
      indirectFire,
    });
    attackEligible =
      selectedBoolean(pair.withinRange, "within-range state") &&
      (targetVisible || indirectFire) &&
      hasPhaseWeapon(attacker, input.scenario.phase);
  } else {
    const eligibleToFight = oneFormationValue(
      attackerStates.map((state) =>
        selectedBoolean(state.eligibleToFight, "fight eligibility"),
      ),
      "fight eligibility",
    );
    const hasFought = oneFormationValue(
      attackerStates.map((state) =>
        selectedBoolean(state.hasFought, "has-fought state"),
      ),
      "has-fought state",
    );
    attackEligible =
      eligibleToFight && !hasFought && hasPhaseWeapon(attacker, "fight");
  }

  const movement = oneFormationValue(
    attackerStates.map((state) => state.movement),
    "movement state",
  );
  const charging = oneFormationValue(
    attackerStates.map((state) =>
      selectedBoolean(state.chargedThisTurn, "charge state"),
    ),
    "charge state",
  );
  const targetInCover = oneFormationValue(
    targetStates.map((state) =>
      selectedBoolean(state.inCover, "cover state"),
    ),
    "cover state",
  );
  return {
    attacker,
    attackEligible,
    combatStateSha256: localTesseraScenarioV3CellStateSha256(input),
    settings: {
      provider: "local-engine",
      phase: input.scenario.phase,
      targetInCover: String(targetInCover),
      charging: String(charging),
      withinRapidFireRange: String(withinRapidFireRange),
      withinMeltaRange: String(withinMeltaRange),
      atHalfRange: "true",
      remainedStationary: String(movement === "stationary"),
      indirectFire: String(!targetVisible && indirectFire),
    },
  };
}
