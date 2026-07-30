import type {
  CertificationCaseResult,
  CertificationManifest,
  CertificationResultStatus,
} from "./certification";

export type CertificationCoverageDimensions = {
  detachments: {
    intended: string[];
    exercised: string[];
    missing: string[];
  };
  unitCategories: {
    exercised: string[];
    caseCountByCategory: Record<string, number>;
  };
  specialistCases: {
    intended: string[];
    exercised: string[];
    missing: string[];
    evidenceCaseIds: Record<string, string[]>;
  };
  failureModes: Array<{
    code: string;
    count: number;
    statuses: CertificationResultStatus[];
    retryableCount: number;
    caseIds: string[];
  }>;
};

const stageSpecialistCoverage: Record<string, string[]> = {
  "build-and-validate": ["authoritative-warlord"],
  "hard-constraint-preservation": [
    "no-named-characters",
    "required-unit",
    "excluded-unit",
    "collection-only",
  ],
  "metamorphic-round-trip": [
    "stable-repeat",
    "serialization-round-trip",
    "prompt-metamorphism",
  ],
  "named-character-specialist": [
    "named-character-specialist",
  ],
  "transport-parity": ["transport-parity"],
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
}

function evidenceDetachmentIds(
  result: CertificationCaseResult,
): string[] {
  const direct =
    typeof result.evidence.detachmentId === "string"
      ? [result.evidence.detachmentId]
      : [];
  const playerBuild =
    result.evidence.playerBuild &&
    typeof result.evidence.playerBuild === "object"
      ? (result.evidence.playerBuild as Record<string, unknown>)
      : null;
  const roster =
    playerBuild?.roster &&
    typeof playerBuild.roster === "object"
      ? (playerBuild.roster as Record<string, unknown>)
      : null;
  const pairDetachment =
    typeof roster?.detachmentId === "string"
      ? [roster.detachmentId]
      : [];
  return [...direct, ...pairDetachment];
}

function evidenceUnitCategories(
  result: CertificationCaseResult,
): string[] {
  const direct = [
    ...strings(result.evidence.unitCategories),
    ...strings(result.evidence.unitRoles),
  ];
  const playerBuild =
    result.evidence.playerBuild &&
    typeof result.evidence.playerBuild === "object"
      ? (result.evidence.playerBuild as Record<string, unknown>)
      : null;
  const roster =
    playerBuild?.roster &&
    typeof playerBuild.roster === "object"
      ? (playerBuild.roster as Record<string, unknown>)
      : null;
  return [...direct, ...strings(roster?.unitRoles)];
}

function evidenceSpecialistCases(
  result: CertificationCaseResult,
): string[] {
  const explicit = strings(result.evidence.specialistCases);
  const inferred =
    result.status === "pass"
      ? (stageSpecialistCoverage[result.stage] ?? [])
      : [];
  const multiProfile =
    result.status === "pass" &&
    result.evidence.profilePolicy &&
    typeof result.evidence.profilePolicy === "object" &&
    Array.isArray(
      (result.evidence.profilePolicy as Record<string, unknown>)
        .requirements,
    )
      ? ["multi-profile-when-present"]
      : [];
  return [...explicit, ...inferred, ...multiProfile];
}

function specialistCoverageId(
  factionId: string,
  specialistCase: string,
): string {
  return `${factionId}:${specialistCase}`;
}

function intendedSpecialistCasesForFaction(
  manifest: CertificationManifest,
  factionId: string,
): string[] {
  const faction = manifest.factions.find(
    (candidate) => candidate.id === factionId,
  );
  if (!faction) return [];
  const policy =
    faction.portfolioPolicy ??
    manifest.defaults.portfolioPolicy;
  return manifest.defaults.specialistCases.filter(
    (specialistCase) =>
      !(
        specialistCase === "named-character-specialist" &&
        faction.expertReview.status === "reviewed" &&
        policy.namedCharacterSpecialist === "not-applicable"
      ),
  );
}

export function deriveCertificationCoverageDimensions(input: {
  manifest: CertificationManifest;
  selectedFactionIds: string[];
  cases: CertificationCaseResult[];
}): CertificationCoverageDimensions {
  const selected = new Set(input.selectedFactionIds);
  const intendedDetachments = input.manifest.factions
    .filter((faction) => selected.has(faction.id))
    .flatMap((faction) =>
      faction.detachmentIds.map(
        (detachmentId) => `${faction.id}:${detachmentId}`,
      ),
    )
    .sort();
  const exercisedDetachments = new Set<string>();
  const categoryCounts = new Map<string, number>();
  const specialistEvidence = new Map<string, Set<string>>();
  const failures = new Map<
    string,
    {
      statuses: Set<CertificationResultStatus>;
      retryableCount: number;
      caseIds: Set<string>;
      count: number;
    }
  >();

  for (const result of input.cases) {
    if (result.factionId && selected.has(result.factionId)) {
      for (const detachmentId of evidenceDetachmentIds(result)) {
        exercisedDetachments.add(
          `${result.factionId}:${detachmentId}`,
        );
      }
    }
    for (const category of new Set(
      evidenceUnitCategories(result),
    )) {
      categoryCounts.set(
        category,
        (categoryCounts.get(category) ?? 0) + 1,
      );
    }
    for (const specialistCase of new Set(
      evidenceSpecialistCases(result),
    )) {
      if (!result.factionId || !selected.has(result.factionId)) {
        continue;
      }
      const coverageId = specialistCoverageId(
        result.factionId,
        specialistCase,
      );
      const caseIds =
        specialistEvidence.get(coverageId) ??
        new Set<string>();
      caseIds.add(result.caseId);
      specialistEvidence.set(coverageId, caseIds);
    }
    if (result.code) {
      const failure = failures.get(result.code) ?? {
        statuses: new Set<CertificationResultStatus>(),
        retryableCount: 0,
        caseIds: new Set<string>(),
        count: 0,
      };
      failure.count += 1;
      failure.statuses.add(result.status);
      if (result.retryable) failure.retryableCount += 1;
      failure.caseIds.add(result.caseId);
      failures.set(result.code, failure);
    }
  }

  const intendedSpecialistCases = [...selected]
    .flatMap((factionId) =>
      intendedSpecialistCasesForFaction(
        input.manifest,
        factionId,
      ).map((specialistCase) =>
        specialistCoverageId(factionId, specialistCase),
      ),
    )
    .sort();
  const exercisedSpecialistCases = [
    ...specialistEvidence.keys(),
  ]
    .filter((specialistCase) =>
      intendedSpecialistCases.includes(specialistCase),
    )
    .sort();
  const exercisedDetachmentIds = [
    ...exercisedDetachments,
  ]
    .filter((detachment) =>
      intendedDetachments.includes(detachment),
    )
    .sort();

  return {
    detachments: {
      intended: intendedDetachments,
      exercised: exercisedDetachmentIds,
      missing: intendedDetachments.filter(
        (detachment) =>
          !exercisedDetachments.has(detachment),
      ),
    },
    unitCategories: {
      exercised: [...categoryCounts.keys()].sort(),
      caseCountByCategory: Object.fromEntries(
        [...categoryCounts.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    },
    specialistCases: {
      intended: intendedSpecialistCases,
      exercised: exercisedSpecialistCases,
      missing: intendedSpecialistCases.filter(
        (specialistCase) =>
          !specialistEvidence.has(specialistCase),
      ),
      evidenceCaseIds: Object.fromEntries(
        [...specialistEvidence.entries()]
          .filter(([specialistCase]) =>
            intendedSpecialistCases.includes(specialistCase),
          )
          .sort(([left], [right]) =>
            left.localeCompare(right),
          )
          .map(([specialistCase, caseIds]) => [
            specialistCase,
            [...caseIds].sort(),
          ]),
      ),
    },
    failureModes: [...failures.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, failure]) => ({
        code,
        count: failure.count,
        statuses: [...failure.statuses].sort(),
        retryableCount: failure.retryableCount,
        caseIds: [...failure.caseIds].sort(),
      })),
  };
}
