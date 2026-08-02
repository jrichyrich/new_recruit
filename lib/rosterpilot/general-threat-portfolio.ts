import { createHash } from "node:crypto";

import {
  searchFactions,
  searchUnits,
} from "./engine";
import {
  buildExportableRosterCandidate,
  inspectStressPortfolioTraits,
  rosterExecutionFingerprint,
  rosterSimulationFingerprint,
} from "./stress-portfolio";
import type {
  PreferenceTag,
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
  TesseraStressPortfolioTraits,
  UnitSummary,
} from "./types";

export const GENERAL_THREAT_PORTFOLIO_VERSION =
  "general-threat-portfolio-v1" as const;

export const GeneralThreatArchetypeIds = [
  "horde",
  "elite",
  "ranged-pressure",
  "armour-monster",
  "fast-scoring-msu",
  "melee-pressure",
] as const;

export type GeneralThreatArchetype =
  (typeof GeneralThreatArchetypeIds)[number];

type ArchetypeDefinition = {
  id: GeneralThreatArchetype;
  label: string;
  preferences: PreferenceTag[];
  purpose: string;
};

export const GENERAL_THREAT_ARCHETYPES: readonly ArchetypeDefinition[] = [
  {
    id: "horde",
    label: "Horde",
    preferences: ["horde", "objective"],
    purpose:
      "Tests volume, screening clearance, and the ability to remove many low-cost models.",
  },
  {
    id: "elite",
    label: "Elite infantry",
    preferences: ["elite", "durability"],
    purpose:
      "Tests efficient attacks into expensive, durable models and concentrated units.",
  },
  {
    id: "ranged-pressure",
    label: "Ranged pressure",
    preferences: ["shooting", "mobility"],
    purpose:
      "Tests exposure discipline and the roster's ability to trade into shooting threats.",
  },
  {
    id: "armour-monster",
    label: "Armour and monsters",
    preferences: ["durability", "shooting"],
    purpose:
      "Tests high-toughness target coverage and anti-armour pressure.",
  },
  {
    id: "fast-scoring-msu",
    label: "Fast scoring MSU",
    preferences: ["mobility", "objective"],
    purpose:
      "Tests reach, activation economy, screening, and removal of multiple small units.",
  },
  {
    id: "melee-pressure",
    label: "Melee pressure",
    preferences: ["melee", "durability"],
    purpose:
      "Tests screens, counter-charge capacity, and durable close-range trading.",
  },
] as const;

export type GeneralThreatPortfolioItem = {
  archetypeId: GeneralThreatArchetype;
  label: string;
  purpose: string;
  representativeFactionId: string;
  representativeFactionName: string;
  roster: RosterDraftV1;
  simulationFingerprint: string;
  traits: TesseraStressPortfolioTraits;
  score: number;
  selectionEvidence: string[];
};

export type GeneralThreatPortfolio = {
  schemaVersion: 1;
  portfolioKind: "general-threat-portfolio";
  version: typeof GENERAL_THREAT_PORTFOLIO_VERSION;
  pointsLimit: 1000 | 2000;
  generatedFrom: "active-data-bundle";
  portfolioHash: string;
  items: GeneralThreatPortfolioItem[];
  limitations: string[];
};

function issue(code: string, message: string): RosterIssue {
  return { code, message, severity: "error" };
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function keywordIncludes(unit: UnitSummary, pattern: RegExp): boolean {
  return pattern.test(
    [unit.role, ...unit.keywords].join(" ").toLowerCase(),
  );
}

function factionSignal(
  archetype: GeneralThreatArchetype,
  units: UnitSummary[],
): number {
  if (units.length === 0) return Number.NEGATIVE_INFINITY;
  const share = (predicate: (unit: UnitSummary) => boolean) =>
    units.filter(predicate).length / units.length;
  const averagePoints =
    units.reduce((total, unit) => total + unit.pointsFrom, 0) /
    units.length;
  if (archetype === "horde") {
    return (
      share((unit) => unit.tags.includes("horde")) * 3 +
      share((unit) => unit.tags.includes("objective")) +
      Math.max(0, 1 - averagePoints / 180)
    );
  }
  if (archetype === "elite") {
    return (
      share((unit) => unit.tags.includes("elite")) * 2 +
      share((unit) => unit.tags.includes("durability")) +
      Math.min(1, averagePoints / 220)
    );
  }
  if (archetype === "armour-monster") {
    return (
      share((unit) => keywordIncludes(unit, /\b(?:vehicle|monster)\b/)) *
        4 +
      share((unit) => unit.tags.includes("durability"))
    );
  }
  if (archetype === "fast-scoring-msu") {
    return (
      share((unit) => unit.tags.includes("mobility")) * 2 +
      share((unit) => unit.tags.includes("objective")) * 2 +
      Math.max(0, 1 - averagePoints / 180)
    );
  }
  if (archetype === "ranged-pressure") {
    return (
      share((unit) => unit.tags.includes("shooting")) * 3 +
      share((unit) => unit.tags.includes("mobility"))
    );
  }
  return (
    share((unit) => unit.tags.includes("melee")) * 3 +
    share((unit) => unit.tags.includes("durability"))
  );
}

function rosterScore(
  archetype: GeneralThreatArchetype,
  traits: TesseraStressPortfolioTraits,
): number {
  const ranged = traits.rangedPressurePercent ?? 0;
  const melee = traits.meleePressurePercent ?? 0;
  const mobility = traits.mobilityPressurePercent ?? 0;
  const armour =
    (traits.vehiclePointsPercent ?? 0) +
    (traits.monsterPointsPercent ?? 0);
  const pointsPerModel = traits.pointsPerModel ?? 0;
  if (archetype === "horde") {
    return (
      traits.modelCount / 100 +
      traits.hordePointsPercent * 2 +
      traits.unitCount / 20
    );
  }
  if (archetype === "elite") {
    return (
      Math.min(2, pointsPerModel / 100) +
      traits.eliteHeavyPointsPercent * 2 +
      (traits.unitConcentrationPercent ?? 0)
    );
  }
  if (archetype === "armour-monster") {
    return armour * 3 + traits.eliteHeavyPointsPercent;
  }
  if (archetype === "fast-scoring-msu") {
    return (
      mobility * 2 +
      traits.tagCounts.objective / Math.max(1, traits.unitCount) +
      traits.unitCount / 20
    );
  }
  if (archetype === "ranged-pressure") {
    return ranged * 3 + mobility * 0.5;
  }
  return melee * 3 + traits.eliteHeavyPointsPercent * 0.5;
}

function archetypeEligible(
  archetype: GeneralThreatArchetype,
  traits: TesseraStressPortfolioTraits,
  pointsLimit: number,
): boolean {
  const armour =
    (traits.vehiclePointsPercent ?? 0) +
    (traits.monsterPointsPercent ?? 0);
  if (archetype === "horde") {
    return (
      traits.modelCount >= pointsLimit / 40 ||
      traits.hordePointsPercent >= 0.35
    );
  }
  if (archetype === "elite") {
    return (
      (traits.infantryPointsPercent ?? 0) >= 0.55 &&
      armour <= 0.25 &&
      (traits.pointsPerModel ?? 0) >= 25
    );
  }
  if (archetype === "armour-monster") return armour >= 0.55;
  if (archetype === "fast-scoring-msu") {
    return (
      (traits.mobilityPressurePercent ?? 0) >= 0.35 &&
      traits.unitCount >= 6 &&
      traits.tagCounts.objective >= 2
    );
  }
  if (archetype === "ranged-pressure") {
    return (traits.rangedPressurePercent ?? 0) >= 0.5;
  }
  return (traits.meleePressurePercent ?? 0) >= 0.5;
}

function evidence(
  archetype: GeneralThreatArchetype,
  traits: TesseraStressPortfolioTraits,
): string[] {
  const armour =
    (traits.vehiclePointsPercent ?? 0) +
    (traits.monsterPointsPercent ?? 0);
  const common = [
    `${traits.modelCount} models across ${traits.unitCount} units`,
    `${Math.round(traits.pointsUtilization * 100)}% points utilization`,
  ];
  if (archetype === "horde") {
    return [
      ...common,
      `${Math.round(traits.hordePointsPercent * 100)}% horde-tagged points`,
    ];
  }
  if (archetype === "elite") {
    return [
      ...common,
      `${(traits.pointsPerModel ?? 0).toFixed(1)} points per model`,
      `${Math.round(traits.eliteHeavyPointsPercent * 100)}% elite-heavy points`,
    ];
  }
  if (archetype === "armour-monster") {
    return [
      ...common,
      `${Math.round(armour * 100)}% vehicle/monster points`,
    ];
  }
  if (archetype === "fast-scoring-msu") {
    return [
      ...common,
      `${Math.round((traits.mobilityPressurePercent ?? 0) * 100)}% mobility pressure`,
      `${traits.tagCounts.objective} objective-tagged selections`,
    ];
  }
  if (archetype === "ranged-pressure") {
    return [
      ...common,
      `${Math.round((traits.rangedPressurePercent ?? 0) * 100)}% ranged pressure`,
    ];
  }
  return [
    ...common,
    `${Math.round((traits.meleePressurePercent ?? 0) * 100)}% melee pressure`,
  ];
}

export function generalThreatPortfolioHash(
  pointsLimit: number,
  items: GeneralThreatPortfolioItem[],
): string {
  const canonical = JSON.stringify({
    version: GENERAL_THREAT_PORTFOLIO_VERSION,
    pointsLimit,
    items: items.map((item) => ({
      archetypeId: item.archetypeId,
      factionId: item.representativeFactionId,
      simulationFingerprint: item.simulationFingerprint,
      executionFingerprint: rosterExecutionFingerprint(item.roster),
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Builds six real, exportable opponent rosters from the active immutable data
 * snapshot. These are robustness lenses, not claims about meta prevalence or
 * game win probability.
 */
export function buildGeneralThreatPortfolio(input: {
  pointsLimit: number;
}): ResultEnvelope<GeneralThreatPortfolio> {
  if (input.pointsLimit !== 1000 && input.pointsLimit !== 2000) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "GENERAL_PORTFOLIO_POINTS_UNSUPPORTED",
          "The generic six-archetype portfolio supports 1,000 or 2,000 points. For another limit, provide a named opponent faction or an exact opponent roster.",
        ),
      ],
      warnings: [],
    };
  }
  const pointsLimit = input.pointsLimit;
  const factions = (searchFactions("", 100).data ?? []).filter(
    (faction) => faction.supported,
  );
  const unitInventory = new Map(
    factions.map((faction) => [
      faction.id,
      searchUnits({
        faction: faction.id,
        includeLegends: false,
        limit: 100,
      }).data ?? [],
    ]),
  );
  const items: GeneralThreatPortfolioItem[] = [];
  const usedSimulationFingerprints = new Set<string>();
  for (const definition of GENERAL_THREAT_ARCHETYPES) {
    const candidateFactions = [...factions]
      .sort(
        (left, right) =>
          factionSignal(
            definition.id,
            unitInventory.get(right.id) ?? [],
          ) -
            factionSignal(
              definition.id,
              unitInventory.get(left.id) ?? [],
            ) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, 8);
    const candidates = candidateFactions.flatMap((faction) => {
      const roster = buildExportableRosterCandidate({
        playerFaction: faction.id,
        pointsLimit,
        name: `${definition.label} ${pointsLimit}`,
        preferences: definition.preferences,
        allowLegends: false,
        collectionProfile: { mode: "open-catalog" },
      });
      if (!roster) return [];
      const traits = inspectStressPortfolioTraits(roster);
      if (
        traits.pointsUtilization < 0.98 ||
        !archetypeEligible(definition.id, traits, pointsLimit)
      ) {
        return [];
      }
      const simulationFingerprint =
        rosterSimulationFingerprint(roster);
      if (
        usedSimulationFingerprints.has(simulationFingerprint)
      ) {
        return [];
      }
      return [{
        faction,
        roster,
        traits,
        simulationFingerprint,
        score: rosterScore(definition.id, traits),
      }];
    });
    const selected = candidates.sort(
      (left, right) =>
        right.score - left.score ||
        left.faction.id.localeCompare(right.faction.id) ||
        rosterSimulationFingerprint(left.roster).localeCompare(
          rosterSimulationFingerprint(right.roster),
        ),
    )[0];
    if (!selected) {
      return {
        ok: false,
        data: null,
        violations: [
          issue(
            "GENERAL_PORTFOLIO_ARCHETYPE_UNAVAILABLE",
            `No legal, 98%-utilized, New Recruit-exportable representative could be built for ${definition.label}.`,
          ),
        ],
        warnings: [],
      };
    }
    items.push({
      archetypeId: definition.id,
      label: definition.label,
      purpose: definition.purpose,
      representativeFactionId: selected.faction.id,
      representativeFactionName: selected.faction.name,
      roster: selected.roster,
      simulationFingerprint: selected.simulationFingerprint,
      traits: selected.traits,
      score: round(selected.score),
      selectionEvidence: evidence(
        definition.id,
        selected.traits,
      ),
    });
    usedSimulationFingerprints.add(
      selected.simulationFingerprint,
    );
  }
  return {
    ok: true,
    data: {
      schemaVersion: 1,
      portfolioKind: "general-threat-portfolio",
      version: GENERAL_THREAT_PORTFOLIO_VERSION,
      pointsLimit,
      generatedFrom: "active-data-bundle",
      portfolioHash: generalThreatPortfolioHash(pointsLimit, items),
      items,
      limitations: [
        "Representatives are deterministic robustness lenses, not a forecast of tournament field frequency.",
        "Tessera and baseline damage results are directional combat evidence, not game win probabilities.",
        "Mission, terrain, deployment, player decisions, and five-round scoring remain outside isolated attack-sequence math.",
      ],
    },
    violations: [],
    warnings: [],
  };
}
