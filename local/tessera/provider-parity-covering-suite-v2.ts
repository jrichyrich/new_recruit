import crypto from "node:crypto";

import { canonicalJson } from "../../lib/rosterpilot";

export type TesseraParityFactionMechanicsV2 = {
  factionId: string;
  attackerMechanicIds: string[];
  defenderMechanicIds: string[];
};

export type TesseraParityCoveringCaseV2 = {
  caseId: string;
  attackerFactionId: string;
  defenderFactionId: string;
  coveredRequirementIds: string[];
};

export type TesseraParityCoveringSuiteV2 = {
  schemaVersion: 2;
  kind: "tessera-provider-parity-covering-suite";
  algorithm: "deterministic-greedy-bidirectional-set-cover-v2";
  mirrorPolicy: "allowed" | "distinct-factions-when-available";
  corpusInventorySha256: string;
  factions: TesseraParityFactionMechanicsV2[];
  requirements: string[];
  cases: TesseraParityCoveringCaseV2[];
  suiteSha256: string;
};

export class TesseraParityCoveringSuiteError extends Error {
  readonly code = "TESSERA_PARITY_COVERING_SUITE_INVALID";
}

function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function canonicalMechanicIds(
  value: unknown,
  factionId: string,
  role: "attacker" | "defender",
): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (mechanicId) =>
        typeof mechanicId !== "string" || !mechanicId.trim(),
    )
  ) {
    throw new TesseraParityCoveringSuiteError(
      `Faction "${factionId}" requires non-empty string ${role} mechanic IDs.`,
    );
  }
  return unique(value.map((mechanicId) => mechanicId.trim()));
}

function canonicalFactions(
  factions: readonly TesseraParityFactionMechanicsV2[],
): TesseraParityFactionMechanicsV2[] {
  if (!Array.isArray(factions)) {
    throw new TesseraParityCoveringSuiteError(
      "A covering suite requires a factions array.",
    );
  }
  const canonical = factions.map((faction) => {
    if (
      !faction ||
      typeof faction !== "object" ||
      typeof faction.factionId !== "string" ||
      !faction.factionId.trim()
    ) {
      throw new TesseraParityCoveringSuiteError(
        "A covering suite requires non-empty string faction IDs.",
      );
    }
    const factionId = faction.factionId.trim();
    return {
      factionId,
      attackerMechanicIds: canonicalMechanicIds(
        faction.attackerMechanicIds,
        factionId,
        "attacker",
      ),
      defenderMechanicIds: canonicalMechanicIds(
        faction.defenderMechanicIds,
        factionId,
        "defender",
      ),
    };
  }).sort((left, right) => compare(left.factionId, right.factionId));
  if (
    canonical.length === 0 ||
    canonical.some((faction) => !faction.factionId) ||
    new Set(canonical.map((faction) => faction.factionId)).size !==
      canonical.length
  ) {
    throw new TesseraParityCoveringSuiteError(
      "A covering suite requires one unique, non-empty faction record per supported faction.",
    );
  }
  return canonical;
}

function attackerRequirement(factionId: string): string {
  return `role:attacker:${factionId}`;
}

function defenderRequirement(factionId: string): string {
  return `role:defender:${factionId}`;
}

function attackerMechanicRequirement(
  factionId: string,
  mechanicId: string,
): string {
  return `mechanic:attacker:${factionId}:${mechanicId}`;
}

function defenderMechanicRequirement(
  factionId: string,
  mechanicId: string,
): string {
  return `mechanic:defender:${factionId}:${mechanicId}`;
}

function requirementsForFaction(
  faction: TesseraParityFactionMechanicsV2,
): string[] {
  return [
    attackerRequirement(faction.factionId),
    defenderRequirement(faction.factionId),
    ...faction.attackerMechanicIds.map((mechanicId) =>
      attackerMechanicRequirement(faction.factionId, mechanicId),
    ),
    ...faction.defenderMechanicIds.map((mechanicId) =>
      defenderMechanicRequirement(faction.factionId, mechanicId),
    ),
  ];
}

function caseRequirements(
  attacker: TesseraParityFactionMechanicsV2,
  defender: TesseraParityFactionMechanicsV2,
): string[] {
  // One exact matchup captures both attack directions, so each paired case
  // exercises both factions as attacker and defender.
  return unique([
    attackerRequirement(attacker.factionId),
    defenderRequirement(attacker.factionId),
    ...attacker.attackerMechanicIds.map((mechanicId) =>
      attackerMechanicRequirement(attacker.factionId, mechanicId),
    ),
    ...attacker.defenderMechanicIds.map((mechanicId) =>
      defenderMechanicRequirement(attacker.factionId, mechanicId),
    ),
    attackerRequirement(defender.factionId),
    defenderRequirement(defender.factionId),
    ...defender.attackerMechanicIds.map((mechanicId) =>
      attackerMechanicRequirement(defender.factionId, mechanicId),
    ),
    ...defender.defenderMechanicIds.map((mechanicId) =>
      defenderMechanicRequirement(defender.factionId, mechanicId),
    ),
  ]);
}

export function buildTesseraParityCoveringSuiteV2(input: {
  corpusInventorySha256: string;
  factions: readonly TesseraParityFactionMechanicsV2[];
  allowMirrorCases?: boolean;
}): TesseraParityCoveringSuiteV2 {
  if (!/^[0-9a-f]{64}$/.test(input.corpusInventorySha256)) {
    throw new TesseraParityCoveringSuiteError(
      "The covering suite must bind one exact corpus inventory SHA-256.",
    );
  }
  const factions = canonicalFactions(input.factions);
  const requirements = unique(
    factions.flatMap(requirementsForFaction),
  );
  const candidates = factions.flatMap((attacker) =>
    factions.flatMap((defender) =>
      !input.allowMirrorCases &&
        factions.length > 1 &&
        attacker.factionId === defender.factionId
        ? []
        : [{
            caseId: `${attacker.factionId}-into-${defender.factionId}`,
            attackerFactionId: attacker.factionId,
            defenderFactionId: defender.factionId,
            coveredRequirementIds: caseRequirements(attacker, defender),
          }],
    ),
  ).sort((left, right) => compare(left.caseId, right.caseId));
  const uncovered = new Set(requirements);
  const cases: TesseraParityCoveringCaseV2[] = [];
  const remaining = new Map(
    candidates.map((candidate) => [candidate.caseId, candidate]),
  );
  while (uncovered.size > 0) {
    const ranked = [...remaining.values()].map((candidate) => ({
      candidate,
      gain: candidate.coveredRequirementIds.filter((requirement) =>
        uncovered.has(requirement),
      ).length,
    })).sort(
      (left, right) =>
        right.gain - left.gain ||
        compare(left.candidate.caseId, right.candidate.caseId),
    );
    const selected = ranked[0];
    if (!selected || selected.gain === 0) {
      throw new TesseraParityCoveringSuiteError(
        `No legal faction pairing covers remaining requirement(s): ${[...uncovered].sort(compare).join(", ")}.`,
      );
    }
    cases.push(selected.candidate);
    remaining.delete(selected.candidate.caseId);
    for (const requirement of selected.candidate.coveredRequirementIds) {
      uncovered.delete(requirement);
    }
  }

  const core = {
    schemaVersion: 2 as const,
    kind: "tessera-provider-parity-covering-suite" as const,
    algorithm: "deterministic-greedy-bidirectional-set-cover-v2" as const,
    mirrorPolicy: input.allowMirrorCases
      ? "allowed" as const
      : "distinct-factions-when-available" as const,
    corpusInventorySha256: input.corpusInventorySha256,
    factions,
    requirements,
    cases,
  };
  return { ...core, suiteSha256: digest(core) };
}

export function verifyTesseraParityCoveringSuiteV2(
  suite: TesseraParityCoveringSuiteV2,
): boolean {
  if (
    !suite ||
    typeof suite !== "object" ||
    Array.isArray(suite) ||
    typeof suite.suiteSha256 !== "string"
  ) {
    return false;
  }
  const { suiteSha256, ...core } = suite;
  if (digest(core) !== suiteSha256) return false;
  try {
    const rebuilt = buildTesseraParityCoveringSuiteV2({
      corpusInventorySha256: suite.corpusInventorySha256,
      factions: suite.factions,
      allowMirrorCases: suite.mirrorPolicy === "allowed",
    });
    return canonicalJson(rebuilt) === canonicalJson(suite);
  } catch {
    return false;
  }
}
