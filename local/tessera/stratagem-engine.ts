import { z } from "zod";

export const STRATAGEM_ENGINE_SCHEMA_VERSION = 1 as const;

export const StratagemIdSchema = z.enum([
  "fire-overwatch",
  "armor-of-contempt",
  "fight-first",
  "command-reroll",
  "fight-on-death",
]);
export type StratagemId = z.infer<typeof StratagemIdSchema>;

export interface PlayerCpState {
  factionId: string;
  currentCp: number;
  totalCpEarned: number;
}

export interface StratagemDefinition {
  id: StratagemId;
  name: string;
  cpCost: number;
  phase: "command" | "movement" | "shooting" | "charge" | "fight";
  triggerCondition: "on-move" | "on-targeted" | "on-charge" | "on-attack-roll" | "on-model-destroyed";
  effectType: "torrent-overwatch" | "ap-reduction" | "fight-first-grant" | "single-reroll" | "death-retaliation";
}

export const CORE_STRATAGEMS: Record<StratagemId, StratagemDefinition> = {
  "fire-overwatch": {
    id: "fire-overwatch",
    name: "Fire Overwatch",
    cpCost: 1,
    phase: "movement",
    triggerCondition: "on-move",
    effectType: "torrent-overwatch",
  },
  "armor-of-contempt": {
    id: "armor-of-contempt",
    name: "Armor of Contempt",
    cpCost: 1,
    phase: "shooting",
    triggerCondition: "on-targeted",
    effectType: "ap-reduction",
  },
  "fight-first": {
    id: "fight-first",
    name: "Counter-Offensive / Fight First",
    cpCost: 2,
    phase: "fight",
    triggerCondition: "on-charge",
    effectType: "fight-first-grant",
  },
  "command-reroll": {
    id: "command-reroll",
    name: "Command Re-roll",
    cpCost: 1,
    phase: "shooting",
    triggerCondition: "on-attack-roll",
    effectType: "single-reroll",
  },
  "fight-on-death": {
    id: "fight-on-death",
    name: "Fight on Death",
    cpCost: 1,
    phase: "fight",
    triggerCondition: "on-model-destroyed",
    effectType: "death-retaliation",
  },
};

export function createInitialCpState(factionId: string, startingCp = 1): PlayerCpState {
  return {
    factionId,
    currentCp: startingCp,
    totalCpEarned: startingCp,
  };
}

export function advanceCommandPhaseCp(state: PlayerCpState): PlayerCpState {
  return {
    ...state,
    currentCp: state.currentCp + 1,
    totalCpEarned: state.totalCpEarned + 1,
  };
}

export function canSpendCp(state: PlayerCpState, cost: number): boolean {
  return state.currentCp >= cost;
}

export function spendCp(state: PlayerCpState, cost: number): PlayerCpState {
  if (!canSpendCp(state, cost)) {
    throw new Error(`Insufficient CP: Player has ${state.currentCp} CP, but ${cost} CP is required.`);
  }
  return {
    ...state,
    currentCp: state.currentCp - cost,
  };
}

export function evaluateStratagemTrigger(
  state: PlayerCpState,
  stratagemId: StratagemId,
  context: {
    hasTorrentWeapons?: boolean;
    incomingAp?: number;
    isHighValueTarget?: boolean;
  }
): { triggered: boolean; newState: PlayerCpState; modifiedAp?: number } {
  const strat = CORE_STRATAGEMS[stratagemId];
  if (!canSpendCp(state, strat.cpCost)) {
    return { triggered: false, newState: state };
  }

  if (stratagemId === "fire-overwatch" && context.hasTorrentWeapons) {
    return {
      triggered: true,
      newState: spendCp(state, strat.cpCost),
    };
  }

  if (stratagemId === "armor-of-contempt" && (context.incomingAp ?? 0) >= 2 && context.isHighValueTarget) {
    return {
      triggered: true,
      newState: spendCp(state, strat.cpCost),
      modifiedAp: Math.max(0, (context.incomingAp ?? 0) - 1),
    };
  }

  if (stratagemId === "command-reroll" && context.isHighValueTarget) {
    return {
      triggered: true,
      newState: spendCp(state, strat.cpCost),
    };
  }

  return { triggered: false, newState: state };
}
