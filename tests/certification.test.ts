import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "fflate";

import {
  CERTIFICATION_CAPABILITY_BOUNDARY_CODES,
  CERTIFICATION_CAPABILITY_DEPENDENCY_CODES,
  CERTIFICATION_GOLDEN_DRIFT_CODES,
  CertificationManifestSchema,
  CertificationReportSchema,
  FactionCertificationSchema,
  RepresentativeRosterGoldenEvidenceSchema,
  assertRepresentativeRosterMatchesGolden,
  buildCertificationRepresentative,
  certificationExpertReviewBinding,
  certificationExpertReviewCases,
  classifyNamedCharacterSpecialistCapability,
  classifyTesseraPreparationCapability,
  certificationManifestSha256,
  generateRepresentativeGoldenEvidence,
  legacyCertificationExpertReviewBinding,
  legacyCertificationExpertReviewBindingV2,
  runDeterministicCertification,
  synchronizedTesseraPreparationExpectation,
  validateCanonicalRoszArchive,
} from "../lib/rosterpilot/certification";
import {
  exportRoster,
  validateRoster,
} from "../lib/rosterpilot/engine";
import {
  buildExportableRosterCandidate,
  legacyProvenanceBoundRosterExecutionFingerprint,
  rosterExecutionFingerprint,
} from "../lib/rosterpilot/stress-portfolio";
import {
  stampRosterDataIdentity,
} from "../lib/rosterpilot/draft";
import type { RosterDraftV1 } from "../lib/rosterpilot/types";
import {
  sanitizeConnectorFixture,
  sanitizedFixtureSha256,
} from "../local/certification/sanitize";

const manifestDocument: unknown = JSON.parse(
  await readFile(
    new URL("../data/certification-manifest.json", import.meta.url),
    "utf8",
  ),
);
const manifest = CertificationManifestSchema.parse(manifestDocument);
const browserFixtureRegistry = JSON.parse(
  await readFile(
    new URL(
      "../data/certification-browser-fixtures.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { fixtures: Array<{ id: string }> };
const capabilityBoundaryFixtures = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/certification-capability-boundaries.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;

type CanonicalFixture = {
  roster: RosterDraftV1;
  content: Uint8Array;
  entryName: string;
  xml: string;
};

let canonicalFixturePromise: Promise<CanonicalFixture> | null = null;

function exportedFixture(
  roster: RosterDraftV1,
): Promise<CanonicalFixture> {
  return (async () => {
    const exported = await exportRoster(roster, "rosz");
    assert.equal(
      exported.ok,
      true,
      exported.violations.map((issue) => issue.message).join("; "),
    );
    assert.ok(exported.data?.content instanceof Uint8Array);
    const entries = unzipSync(exported.data.content);
    const entryNames = Object.keys(entries);
    assert.equal(entryNames.length, 1);
    return {
      roster,
      content: exported.data.content,
      entryName: entryNames[0],
      xml: strFromU8(entries[entryNames[0]]),
    };
  })();
}

function canonicalMutationFixture(): Promise<CanonicalFixture> {
  canonicalFixturePromise ??= (async () => {
    const roster = buildExportableRosterCandidate({
      playerFaction: "adeptus-custodes",
      pointsLimit: 1000,
      name: "Canonical certification mutation fixture",
      preferences: ["mobility", "durability", "objective"],
      allowNamedCharacters: false,
      allowLegends: false,
      detachmentId: "shield-host",
    });
    assert.ok(roster);
    assert.ok(
      roster.units.filter((unit) => unit.name === "Prosecutors")
        .length >= 2,
      "the mutation fixture must retain duplicate-name units",
    );
    return exportedFixture(roster);
  })();
  return canonicalFixturePromise;
}

let canonicalEnhancementFixturePromise:
  | Promise<CanonicalFixture>
  | null = null;

function canonicalEnhancementFixture(): Promise<CanonicalFixture> {
  canonicalEnhancementFixturePromise ??= (async () => {
    const base = await canonicalMutationFixture();
    const removed = base.roster.units.at(-1);
    const warlord = base.roster.units.find((unit) => unit.isWarlord);
    assert.ok(removed);
    assert.ok(warlord);
    const enhancementCost = 5;
    const roster = stampRosterDataIdentity({
      ...structuredClone(base.roster),
      name: "Canonical certification enhancement fixture",
      totalPoints:
        base.roster.totalPoints -
        removed.points +
        enhancementCost,
      units: base.roster.units
        .slice(0, -1)
        .map((unit) =>
          unit.selectionId === warlord.selectionId
            ? {
                ...unit,
                enhancementId: "panoptispex-shield-host",
                enhancementName: "Panoptispex",
                points: unit.points + enhancementCost,
              }
            : unit,
        ),
    });
    return exportedFixture(roster);
  })();
  return canonicalEnhancementFixturePromise;
}

function replaceExactlyOnce(
  value: string,
  from: string,
  to: string,
): string {
  const first = value.indexOf(from);
  assert.notEqual(first, -1, `missing mutation target: ${from}`);
  assert.equal(
    value.indexOf(from, first + from.length),
    -1,
    `mutation target is not unique: ${from}`,
  );
  return `${value.slice(0, first)}${to}${value.slice(first + from.length)}`;
}

function selectionTagsNamed(
  xml: string,
  name: string,
): RegExpMatchArray[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...xml.matchAll(
      new RegExp(
        `<selection\\b(?=[^>]*\\bname="${escaped}")[^>]*>`,
        "g",
      ),
    ),
  ];
}

function mutateNamedSelectionTag(
  xml: string,
  name: string,
  occurrence: number,
  mutate: (tag: string) => string,
): string {
  const match = selectionTagsNamed(xml, name)[occurrence - 1];
  assert.ok(match);
  const next = mutate(match[0]);
  assert.notEqual(next, match[0]);
  const index = match.index ?? -1;
  assert.ok(index >= 0);
  return `${xml.slice(0, index)}${next}${xml.slice(index + match[0].length)}`;
}

function namedSelectionBlock(
  xml: string,
  name: string,
  occurrence: number,
): { start: number; end: number; value: string } {
  const match = selectionTagsNamed(xml, name)[occurrence - 1];
  assert.ok(match);
  const start = match.index ?? -1;
  assert.ok(start >= 0);
  const tokens =
    xml
      .slice(start)
      .matchAll(/<selection\b[^>]*\/>|<selection\b[^>]*>|<\/selection>/g);
  let depth = 0;
  for (const token of tokens) {
    if (token[0] === "</selection>") {
      depth -= 1;
      if (depth === 0) {
        const end =
          start + (token.index ?? 0) + token[0].length;
        return { start, end, value: xml.slice(start, end) };
      }
    } else if (!token[0].endsWith("/>")) {
      depth += 1;
    }
  }
  assert.fail(`selection block for ${name} is unbalanced`);
}

function mutateRosz(
  fixture: CanonicalFixture,
  mutate: (xml: string) => string,
): Uint8Array {
  const xml = mutate(fixture.xml);
  assert.notEqual(xml, fixture.xml);
  return zipSync(
    { [fixture.entryName]: strToU8(xml) },
    { level: 6, mtime: new Date(1980, 0, 1) },
  );
}

function assertCertificationCode(
  action: () => unknown,
  expectedCode: string,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(
      (error as Error & { code?: string }).code,
      expectedCode,
    );
    return true;
  });
}

test("certification manifest covers every pinned faction and capability baseline", () => {
  assert.equal(manifest.factions.length, 35);
  assert.ok(
    manifest.factions.every(
      (faction) =>
        faction.detachmentIds.length > 0 &&
        faction.representativeRosters.some(
          (roster) =>
            roster.pointsLimit === 1_000 &&
            roster.capabilities.includes("new-recruit-export"),
        ) &&
        faction.representativeRosters.some(
          (roster) =>
            roster.pointsLimit === 2_000 &&
            roster.capabilities.includes("new-recruit-export"),
        ),
    ),
  );
  assert.equal(
    new Set(manifest.factions.map((faction) => faction.id)).size,
    35,
  );
  assert.deepEqual(
    manifest.defaults.portfolioPolicy.requiredCorePostures,
    [
      "balanced-control",
      "ranged-pressure",
      "assault-pressure",
    ],
  );
  for (const factionId of [
    "chaos-knights",
    "grey-knights",
    "imperial-knights",
  ]) {
    const policy = manifest.factions.find(
      (faction) => faction.id === factionId,
    )?.portfolioPolicy;
    assert.ok(policy);
    assert.ok(
      policy.notApplicableCompositions.some(
        (entry) => entry.composition === "mass" && entry.reason,
      ),
    );
  }
  assert.equal(
    manifest.factions.filter(
      (faction) => faction.newRecruitExport === "required",
    ).length,
    35,
  );
  assert.equal(
    manifest.factions.reduce(
      (sum, faction) => sum + faction.expectedBlockingConflicts,
      0,
    ),
    manifest.baselines.blockingConflicts,
  );
  assert.deepEqual(
    manifest.browserFixtures,
    browserFixtureRegistry.fixtures.map((fixture) => fixture.id),
  );
  assert.equal(
    manifest.dataPin.newRecruitRepository,
    "BSData/wh40k-11e",
  );
  assert.match(
    manifest.dataPin.officialMfmContentSha256 ?? "",
    /^[0-9a-f]{64}$/,
  );
  for (const faction of manifest.factions) {
    for (const roster of faction.representativeRosters) {
      assert.ok(
        roster.goldenEvidence,
        `${faction.id}:${roster.id} must pin deterministic golden evidence`,
      );
      assert.match(
        roster.goldenEvidence.structuralFingerprint,
        /^[0-9a-f]{64}$/,
      );
      assert.match(
        roster.goldenEvidence.executionFingerprint,
        /^[0-9a-f]{64}$/,
      );
      assert.ok(roster.goldenEvidence.unitModelMultiset.length > 0);
      if (
        faction.newRecruitExport === "required" &&
        roster.capabilities.includes("new-recruit-export")
      ) {
        assert.match(
          roster.goldenEvidence.canonicalRoszSha256 ?? "",
          /^[0-9a-f]{64}$/,
        );
      }
    }
    assert.deepEqual(
      faction.expertReview.binding,
      certificationExpertReviewBinding(manifest, faction),
      `${faction.id} expert review must be bound to current capability semantics`,
    );
    assert.equal(
      faction.expertReview.binding?.schemaVersion,
      2,
    );
    assert.deepEqual(
      faction.semanticEvidence,
      faction.expertReview.binding?.schemaVersion === 2
        ? faction.expertReview.binding.semanticEvidence
        : null,
    );
  }
  for (const faction of (
    manifestDocument as {
      factions: Array<{
        id: string;
        expertReview: Record<string, unknown>;
      }>;
    }
  ).factions) {
    assert.equal(
      Object.hasOwn(faction.expertReview, "binding"),
      faction.expertReview.status === "reviewed",
      `${faction.id} must persist bindings only for completed expert attestations`,
    );
  }
  assert.match(certificationManifestSha256(manifest), /^[0-9a-f]{64}$/);
});

test("faction capability contracts migrate legacy entries and preserve independent boundaries", () => {
  const legacy = FactionCertificationSchema.parse(
    capabilityBoundaryFixtures.legacyCoupled,
  );
  assert.deepEqual(
    {
      rosterCorrectness: legacy.rosterCorrectness,
      newRecruitExport: legacy.newRecruitExport,
      newRecruitDelivery: legacy.newRecruitDelivery,
      tesseraPreparation: legacy.tesseraPreparation,
      trustedTesseraSimulation:
        legacy.trustedTesseraSimulation,
    },
    {
      rosterCorrectness: "required",
      newRecruitExport: "required",
      newRecruitDelivery: "required",
      tesseraPreparation: "complete",
      trustedTesseraSimulation: "required",
    },
  );
  assert.ok(
    Object.hasOwn(
      JSON.parse(JSON.stringify(legacy)),
      "trustedTesseraSimulation",
    ),
    "migrated values must be explicit when serialized",
  );

  const deliveryUnsupported = FactionCertificationSchema.parse(
    capabilityBoundaryFixtures.deliveryUnsupported,
  );
  assert.equal(deliveryUnsupported.newRecruitExport, "required");
  assert.equal(
    deliveryUnsupported.newRecruitDelivery,
    "unsupported",
  );
  assert.equal(
    deliveryUnsupported.trustedTesseraSimulation,
    "required",
  );

  const simulationUnsupported = FactionCertificationSchema.parse(
    capabilityBoundaryFixtures.simulationUnsupported,
  );
  assert.equal(simulationUnsupported.newRecruitExport, "required");
  assert.equal(
    simulationUnsupported.tesseraPreparation,
    "complete",
  );
  assert.equal(
    simulationUnsupported.trustedTesseraSimulation,
    "unsupported",
  );
  assert.deepEqual(
    new Set([
      CERTIFICATION_CAPABILITY_BOUNDARY_CODES.newRecruitDelivery,
      CERTIFICATION_CAPABILITY_BOUNDARY_CODES.trustedTesseraSimulation,
      CERTIFICATION_CAPABILITY_DEPENDENCY_CODES.trustedSimulationBlockedByExport,
      CERTIFICATION_CAPABILITY_DEPENDENCY_CODES.trustedSimulationBlockedByDelivery,
    ]).size,
    4,
    "independent connector boundaries and blocked dependencies need distinct failure codes",
  );

  assert.ok(Array.isArray((manifestDocument as { factions?: unknown }).factions));
  for (const faction of (
    manifestDocument as {
      factions: Array<Record<string, unknown>>;
    }
  ).factions) {
    for (const field of [
      "rosterCorrectness",
      "newRecruitExport",
      "newRecruitDelivery",
      "tesseraPreparation",
      "trustedTesseraSimulation",
    ]) {
      assert.ok(
        Object.hasOwn(faction, field),
        `${String(faction.id)} must serialize ${field}`,
      );
    }
  }
});

test("expert review contracts emit manual evidence without treating it as automation", () => {
  const pending = FactionCertificationSchema.parse(
    capabilityBoundaryFixtures.deliveryUnsupported,
  );
  const binding = certificationExpertReviewBinding(
    manifest,
    pending,
  );
  assert.deepEqual(
    certificationExpertReviewCases(pending).map((result) => ({
      caseId: result.caseId,
      stage: result.stage,
      status: result.status,
      code: result.code,
      evidenceSource: result.evidence.evidenceSource,
      automated: result.evidence.automated,
    })),
    [
      {
        caseId:
          "fixture-delivery-unsupported:expert-review:pending",
        stage: "manual-verification",
        status: "degraded",
        code: "CERTIFICATION_EXPERT_REVIEW_PENDING",
        evidenceSource: "manual-expert-review",
        automated: false,
      },
    ],
  );

  const reviewed = FactionCertificationSchema.parse({
    ...pending,
    expertReview: {
      status: "reviewed",
      reviewedAt: "2026-07-30",
      binding,
      assertions: [
        "Export remains valid without delivery.",
        "Unsupported delivery performs no mutation.",
      ],
    },
  });
  assert.deepEqual(
    certificationExpertReviewCases(reviewed).map((result) => ({
      caseId: result.caseId,
      message: result.message,
      stage: result.stage,
      status: result.status,
      code: result.code,
      reviewedAt: result.evidence.reviewedAt,
      automated: result.evidence.automated,
    })),
    [
      {
        caseId:
          "fixture-delivery-unsupported:expert-review:01",
        message: "Export remains valid without delivery.",
        stage: "manual-verification",
        status: "pass",
        code: null,
        reviewedAt: "2026-07-30",
        automated: false,
      },
      {
        caseId:
          "fixture-delivery-unsupported:expert-review:02",
        message: "Unsupported delivery performs no mutation.",
        stage: "manual-verification",
        status: "pass",
        code: null,
        reviewedAt: "2026-07-30",
        automated: false,
      },
    ],
  );

  assert.throws(() =>
    FactionCertificationSchema.parse({
      ...pending,
      expertReview: {
        status: "reviewed",
        binding,
        assertions: ["Missing review date."],
      },
    }),
  );
  assert.throws(() =>
    FactionCertificationSchema.parse({
      ...pending,
      expertReview: {
        status: "reviewed",
        reviewedAt: "2026-07-30",
        binding,
        assertions: [],
      },
    }),
  );

  const legacyUnbound = FactionCertificationSchema.parse({
    ...pending,
    expertReview: {
      status: "reviewed",
      reviewedAt: "2026-07-30",
      assertions: ["Legacy assertion retained only as a draft."],
    },
  });
  assert.equal(legacyUnbound.expertReview.status, "pending");
  if (legacyUnbound.expertReview.status === "pending") {
    assert.equal(
      legacyUnbound.expertReview.invalidationReason,
      "unbound-legacy",
    );
    assert.deepEqual(legacyUnbound.expertReview.assertions, [
      "Legacy assertion retained only as a draft.",
    ]);
  }
});

test("expert review bindings ignore provenance churn and invalidate scoped semantic changes", () => {
  const source = structuredClone(manifest);
  const faction = source.factions[0];
  faction.expectedLimitations = [
    "Use verified connector output.",
  ];
  const binding = certificationExpertReviewBinding(source, faction);
  faction.expertReview = {
    status: "reviewed",
    reviewedAt: "2026-07-30",
    assertions: ["The current faction contract was reviewed."],
    binding,
  };

  const reviewed = CertificationManifestSchema.parse(source);
  assert.equal(
    reviewed.factions[0].expertReview.status,
    "reviewed",
  );

  const reordered = structuredClone(source);
  reordered.factions[0].detachmentIds.reverse();
  reordered.factions[0].expectedLimitations.reverse();
  reordered.factions[0].representativeRosters.reverse();
  for (const roster of reordered.factions[0].representativeRosters) {
    roster.capabilities.reverse();
  }
  assert.equal(
    CertificationManifestSchema.parse(reordered).factions[0]
      .expertReview.status,
    "reviewed",
    "set-like serialization order must not invalidate a review",
  );

  const reformattedPolicyText = structuredClone(source);
  reformattedPolicyText.factions[0].expectedLimitations = [
    "  USE verified connector output!!! ",
  ];
  assert.equal(
    CertificationManifestSchema.parse(
      reformattedPolicyText,
    ).factions[0].expertReview.status,
    "reviewed",
    "case, whitespace, and punctuation-only prose formatting must not invalidate semantic evidence",
  );

  const changedProvenance = structuredClone(source);
  changedProvenance.dataPin.releaseId =
    `${source.dataPin.releaseId}-next`;
  changedProvenance.dataPin.rulesPackageVersion = "99.0.0";
  changedProvenance.dataPin.newRecruitCommit =
    "0".repeat(40);
  changedProvenance.dataPin.officialMfmContentSha256 =
    "0".repeat(64);
  const carriedReview =
    CertificationManifestSchema.parse(
      changedProvenance,
    ).factions[0].expertReview;
  assert.equal(
    carriedReview.status,
    "reviewed",
    "release labels, package versions, commits, and raw source hashes are provenance rather than reviewed semantics",
  );

  const changedMapping = structuredClone(source);
  changedMapping.factions[0].expectedBlockingConflicts += 1;
  const invalidatedMapping =
    CertificationManifestSchema.parse(
      changedMapping,
    ).factions[0].expertReview;
  assert.equal(invalidatedMapping.status, "pending");
  if (invalidatedMapping.status === "pending") {
    assert.equal(
      invalidatedMapping.invalidationReason,
      "binding-mismatch",
    );
    assert.notEqual(
      invalidatedMapping.binding?.schemaVersion === 2
        ? invalidatedMapping.binding.semanticEvidence
            .mappingSha256
        : null,
      binding.semanticEvidence.mappingSha256,
    );
  }

  const changedRosterRules = structuredClone(source);
  changedRosterRules.factions[0].detachmentIds.push(
    "semantic-detachment-change",
  );
  const invalidatedRosterRules =
    CertificationManifestSchema.parse(
      changedRosterRules,
    ).factions[0].expertReview;
  assert.equal(invalidatedRosterRules.status, "pending");
  if (
    invalidatedRosterRules.status === "pending" &&
    invalidatedRosterRules.binding?.schemaVersion === 2
  ) {
    assert.notEqual(
      invalidatedRosterRules.binding.semanticEvidence
        .rosterRulesSha256,
      binding.semanticEvidence.rosterRulesSha256,
    );
  }
});

test("schema-v1 expert bindings remain readable and migrate without dropping reviewed evidence", () => {
  const legacy = structuredClone(
    manifestDocument,
  ) as {
    factions: Array<{
      expertReview: {
        status: "pending" | "reviewed";
        reviewedAt?: string;
        assertions: string[];
        binding?: { schemaVersion: number };
      };
    }>;
  };
  const review = legacy.factions[0].expertReview;
  review.binding = legacyCertificationExpertReviewBinding(
    manifest,
    manifest.factions[0],
  );
  assert.equal(review.binding.schemaVersion, 1);
  review.status = "reviewed";
  review.reviewedAt = "2026-07-30";
  review.assertions = [
    "The legacy review evidence remains attributable.",
  ];

  const migrated =
    CertificationManifestSchema.parse(legacy).factions[0]
      .expertReview;
  assert.equal(migrated.status, "reviewed");
  if (migrated.status === "reviewed") {
    assert.equal(migrated.binding.schemaVersion, 2);
    assert.deepEqual(migrated.assertions, [
      "The legacy review evidence remains attributable.",
    ]);
    assert.deepEqual(migrated.capabilityScopes, [
      "connector",
      "mapping",
      "portfolio",
      "roster-rules",
    ]);
  }
});

test("policy-only schema-v2 bindings migrate once on the matching compiled bootstrap", () => {
  const legacy = structuredClone(manifestDocument) as {
    factions: Array<{
      id: string;
      expertReview: Record<string, unknown>;
    }>;
  };
  const parsed = CertificationManifestSchema.parse(legacy);
  const parsedFaction = parsed.factions[0];
  legacy.factions[0].expertReview = {
    status: "reviewed",
    reviewedAt: "2026-07-30",
    assertions: [
      "The pre-runtime semantic review remains attributable.",
    ],
    capabilityScopes: ["roster-rules"],
    binding: legacyCertificationExpertReviewBindingV2(
      parsed,
      {
        ...parsedFaction,
        expertReview: {
          ...parsedFaction.expertReview,
          capabilityScopes: ["roster-rules"],
        },
      },
    ),
  };

  const migrated = CertificationManifestSchema.parse(legacy)
    .factions[0].expertReview;
  assert.equal(migrated.status, "reviewed");
  if (
    migrated.status === "reviewed" &&
    migrated.binding.schemaVersion === 2
  ) {
    assert.match(
      migrated.binding.semanticEvidence
        .runtimeFactionRulesSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.deepEqual(migrated.assertions, [
      "The pre-runtime semantic review remains attributable.",
    ]);
  }
});

test("deterministic certification accepts a provenance-only legacy pin advance", async () => {
  const changedProvenance = structuredClone(manifestDocument) as {
    dataPin: {
      releaseId: string;
      rulesPackageVersion: string;
      newRecruitCommit: string;
      officialMfmContentSha256?: string;
    };
  };
  changedProvenance.dataPin.releaseId = "provenance-only-next";
  changedProvenance.dataPin.rulesPackageVersion = "99.0.0";
  changedProvenance.dataPin.newRecruitCommit = "0".repeat(40);
  changedProvenance.dataPin.officialMfmContentSha256 =
    "0".repeat(64);
  const report = await runDeterministicCertification(
    changedProvenance,
    { skipAll: true },
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.coverage.factions, {
    intended: 0,
    exercised: 0,
    passed: 0,
    failed: 0,
    unsupported: 0,
    pendingExpertReview: 0,
  });
});

test("expert review capability scopes isolate unrelated semantic changes", () => {
  const source = structuredClone(manifest);
  const faction = source.factions[0];
  faction.expertReview.capabilityScopes = ["mapping"];
  const binding = certificationExpertReviewBinding(
    source,
    faction,
  );
  faction.expertReview = {
    status: "reviewed",
    reviewedAt: "2026-07-30",
    assertions: ["The mapping capability was reviewed."],
    capabilityScopes: ["mapping"],
    binding,
  };

  const unrelatedPortfolioChange = structuredClone(source);
  unrelatedPortfolioChange.defaults.portfolioPolicy =
    {
      ...unrelatedPortfolioChange.defaults.portfolioPolicy,
      namedCharacterSpecialist: "not-applicable",
    };
  const carried = CertificationManifestSchema.parse(
    unrelatedPortfolioChange,
  ).factions[0].expertReview;
  assert.equal(carried.status, "reviewed");
  if (
    carried.status === "reviewed" &&
    carried.binding.schemaVersion === 2
  ) {
    assert.notEqual(
      carried.binding.semanticEvidence.portfolioSha256,
      binding.semanticEvidence.portfolioSha256,
      "unscoped evidence is refreshed even though it does not invalidate the mapping review",
    );
    assert.equal(
      carried.binding.bindingSha256,
      binding.bindingSha256,
    );
  }

  const mappingChange = structuredClone(source);
  mappingChange.factions[0].expectedBlockingConflicts += 1;
  assert.equal(
    CertificationManifestSchema.parse(mappingChange)
      .factions[0].expertReview.status,
    "pending",
  );
});

test("deterministic certification validates a complete faction contract", async () => {
  const focused = structuredClone(manifest);
  focused.defaults.pointBands = [1000];
  const report = await runDeterministicCertification(focused, {
    factionId: "adeptus-custodes",
  });
  assert.deepEqual(
    CertificationReportSchema.parse(report),
    report,
  );
  assert.equal(report.ok, true, JSON.stringify(report.cases, null, 2));
  assert.equal(report.coverage.factions.intended, 1);
  assert.equal(report.coverage.factions.exercised, 1);
  assert.equal(
    report.coverage.factions.passed,
    0,
    "a faction with a required degraded review must not be counted as passed",
  );
  assert.equal(report.coverage.factions.failed, 0);
  assert.equal(
    report.status,
    "degraded",
    "missing intended coverage and passed < intended must never serialize as pass",
  );
  assert.ok(
    report.coverage.dimensions.detachments.missing.length > 0,
    "unexercised intended detachments must remain an explicit coverage gap",
  );
  assert.ok(
    report.coverage.dimensions.detachments.exercised.some(
      (detachment) =>
        detachment.startsWith("adeptus-custodes:"),
    ),
  );
  assert.ok(
    report.coverage.dimensions.unitCategories.exercised.length > 0,
  );
  assert.ok(
    report.coverage.dimensions.specialistCases.exercised.includes(
      "adeptus-custodes:authoritative-warlord",
    ),
  );
  assert.deepEqual(
    report.coverage.dimensions.failureModes.map(
      (failure) => failure.code,
    ),
    ["CERTIFICATION_EXPERT_REVIEW_PENDING"],
  );
  assert.equal(report.provenance.localAgent.runtime, null);
  assert.equal(report.provenance.newRecruitUi.identity, null);
  assert.ok(
    report.cases.some(
      (result) =>
        result.caseId ===
          "adeptus-custodes:expert-review:pending" &&
        result.stage === "manual-verification" &&
        result.status === "degraded" &&
        result.code === "CERTIFICATION_EXPERT_REVIEW_PENDING",
    ),
  );
  assert.ok(
    report.cases.some(
      (result) =>
        result.caseId === "adeptus-custodes:hard-constraints" &&
        result.status === "pass",
    ),
  );
  const exportCases = report.cases.filter((result) =>
    result.caseId.startsWith(
      "adeptus-custodes:canonical-rosz:",
    ),
  );
  assert.deepEqual(
    exportCases.map((result) => ({
      pointsLimit: result.evidence.pointsLimit,
      status: result.status,
      validHash:
        String(result.evidence.contentSha256).length === 64,
    })),
    [
      { pointsLimit: 1000, status: "pass", validHash: true },
      { pointsLimit: 2000, status: "pass", validHash: true },
    ],
  );
  const repeated = await runDeterministicCertification(focused, {
    factionId: "adeptus-custodes",
  });
  const canonicalCaseId =
    "adeptus-custodes:canonical-rosz:core-1000";
  assert.equal(
    repeated.cases.find(
      (result) => result.caseId === canonicalCaseId,
    )?.evidence.contentSha256,
    report.cases.find(
      (result) => result.caseId === canonicalCaseId,
    )?.evidence.contentSha256,
    "canonical ROSZ bytes must remain stable across repeated runs",
  );
});

test("keeps the 2,000-point T’au representative stable across repeated builds", () => {
  const faction = manifest.factions.find(
    (candidate) => candidate.id === "tau-empire",
  );
  assert.ok(faction);
  const contract = faction.representativeRosters.find(
    (candidate) => candidate.id === "core-2000",
  );
  assert.ok(contract?.goldenEvidence);

  const fingerprints = Array.from({ length: 16 }, () =>
    legacyProvenanceBoundRosterExecutionFingerprint(
      buildCertificationRepresentative({
        manifest,
        faction,
        contract,
      }).roster,
    ),
  );
  assert.deepEqual(
    [...new Set(fingerprints)],
    [contract.goldenEvidence.executionFingerprint],
  );
});

test("legacy goldens survive schema-v3 migration while new goldens use semantic identity", async () => {
  const faction = manifest.factions.find(
    (candidate) => candidate.id === "adeptus-custodes",
  );
  assert.ok(faction);
  const contract = faction.representativeRosters.find(
    (candidate) => candidate.id === "core-1000",
  );
  assert.ok(contract?.goldenEvidence);
  assert.equal(contract.goldenEvidence.schemaVersion, 1);

  const representative = buildCertificationRepresentative({
    manifest,
    faction,
    contract,
  });
  assert.equal(
    legacyProvenanceBoundRosterExecutionFingerprint(
      representative.roster,
    ),
    contract.goldenEvidence.executionFingerprint,
  );
  assert.doesNotThrow(() =>
    assertRepresentativeRosterMatchesGolden(
      representative.roster,
      contract.goldenEvidence!,
    ),
  );
  assert.deepEqual(
    await generateRepresentativeGoldenEvidence({
      manifest,
      faction,
      contract,
      representative,
    }),
    contract.goldenEvidence,
    "regenerating an existing schema-v1 golden must preserve its fingerprint and canonical ROSZ bytes",
  );

  const contractWithoutGolden = structuredClone(contract);
  Reflect.deleteProperty(
    contractWithoutGolden,
    "goldenEvidence",
  );
  const semanticContract = {
    ...contractWithoutGolden,
    capabilities: [
      "roster-correctness",
    ] as typeof contract.capabilities,
  };
  const semanticFaction = {
    ...faction,
    representativeRosters: [semanticContract],
  };
  const semanticGolden =
    await generateRepresentativeGoldenEvidence({
      manifest,
      faction: semanticFaction,
      contract: semanticContract,
      representative,
    });
  assert.equal(semanticGolden.schemaVersion, 2);
  assert.equal(
    semanticGolden.executionFingerprint,
    rosterExecutionFingerprint(representative.roster),
  );
  assert.equal(
    RepresentativeRosterGoldenEvidenceSchema.safeParse(
      semanticGolden,
    ).success,
    true,
  );

  const provenanceOnly = structuredClone(representative.roster);
  provenanceOnly.sourceData.version = "1.2.1+metadata-refresh";
  provenanceOnly.sourceData.releaseId = "metadata-refresh";
  provenanceOnly.sourceData.newRecruit.commit = "a".repeat(40);
  provenanceOnly.sourceData.official.updatedAt =
    "2099-01-01T00:00:00.000Z";
  provenanceOnly.sourceData.bundleId = "b".repeat(64);
  assert.notEqual(
    legacyProvenanceBoundRosterExecutionFingerprint(
      provenanceOnly,
    ),
    legacyProvenanceBoundRosterExecutionFingerprint(
      representative.roster,
    ),
  );
  assert.equal(
    rosterExecutionFingerprint(provenanceOnly),
    rosterExecutionFingerprint(representative.roster),
  );
  assert.doesNotThrow(() =>
    assertRepresentativeRosterMatchesGolden(
      provenanceOnly,
      semanticGolden,
    ),
  );

  const semanticChange = structuredClone(provenanceOnly);
  semanticChange.sourceData.rosterRulesHash = "f".repeat(64);
  assert.throws(
    () =>
      assertRepresentativeRosterMatchesGolden(
        semanticChange,
        semanticGolden,
      ),
    (error: unknown) =>
      (error as { code?: string }).code ===
      CERTIFICATION_GOLDEN_DRIFT_CODES.executionFingerprint,
  );
});

test("a legal representative selection change fails its pinned golden contract", async () => {
  const focused = structuredClone(manifest);
  const faction = focused.factions.find(
    (candidate) => candidate.id === "adeptus-custodes",
  );
  assert.ok(faction);
  const contract = faction.representativeRosters.find(
    (candidate) => candidate.id === "core-1000",
  );
  assert.ok(contract?.goldenEvidence);
  const current = buildCertificationRepresentative({
    manifest: focused,
    faction,
    contract,
  }).roster;
  assert.equal(validateRoster(current).ok, true);
  contract.goldenEvidence.unitModelMultiset[0].selectionCount += 1;

  const report = await runDeterministicCertification(focused, {
    factionId: faction.id,
  });
  const result = report.cases.find(
    (candidate) =>
      candidate.caseId === "adeptus-custodes:build:1000",
  );
  assert.equal(result?.status, "fail");
  assert.equal(
    result?.code,
    CERTIFICATION_GOLDEN_DRIFT_CODES.unitModelMultiset,
  );
  assert.ok(result?.evidence.expectedGoldenEvidence);
  assert.ok(result?.evidence.actualGoldenEvidence);
});

test("canonical ROSZ byte drift fails its pinned export contract", async () => {
  const focused = structuredClone(manifest);
  const faction = focused.factions.find(
    (candidate) => candidate.id === "adeptus-custodes",
  );
  assert.ok(faction);
  const contract = faction.representativeRosters.find(
    (candidate) => candidate.id === "core-1000",
  );
  assert.ok(contract?.goldenEvidence?.canonicalRoszSha256);
  contract.goldenEvidence.canonicalRoszSha256 = "0".repeat(64);

  const report = await runDeterministicCertification(focused, {
    factionId: faction.id,
  });
  const result = report.cases.find(
    (candidate) =>
      candidate.caseId ===
      "adeptus-custodes:canonical-rosz:core-1000",
  );
  assert.equal(result?.status, "fail");
  assert.equal(
    result?.code,
    CERTIFICATION_GOLDEN_DRIFT_CODES.canonicalRoszSha256,
  );
  assert.equal(
    result?.evidence.expectedCanonicalRoszSha256,
    "0".repeat(64),
  );
  assert.match(
    String(result?.evidence.actualCanonicalRoszSha256),
    /^[0-9a-f]{64}$/,
  );
});

test("unexercised intended detachments alone prevent a passing faction and report", async () => {
  const focused = structuredClone(manifest);
  focused.defaults.pointBands = [1000];
  focused.defaults.specialistCases = [];
  const faction = focused.factions.find(
    (candidate) => candidate.id === "adeptus-custodes",
  );
  assert.ok(faction);
  faction.expertReview = {
    status: "reviewed",
    reviewedAt: "2026-07-30",
    assertions: ["The focused detachment coverage contract was reviewed."],
    binding: certificationExpertReviewBinding(focused, faction),
  };

  const report = await runDeterministicCertification(focused, {
    factionId: faction.id,
  });
  assert.equal(report.ok, true);
  assert.equal(report.coverage.factions.pendingExpertReview, 0);
  assert.equal(
    report.cases.some((result) =>
      ["fail", "unsupported", "degraded"].includes(result.status),
    ),
    false,
  );
  assert.equal(
    report.coverage.dimensions.specialistCases.missing.length,
    0,
  );
  assert.ok(
    report.coverage.dimensions.detachments.missing.length > 0,
  );
  assert.equal(report.coverage.factions.intended, 1);
  assert.equal(report.coverage.factions.passed, 0);
  assert.equal(report.status, "degraded");
  assert.ok(
    report.limitations.some((limitation) =>
      limitation.startsWith(
        "Missing detachment certification evidence:",
      ),
    ),
  );
});

test("canonical ROSZ validation proves exact pinned roster identity", async () => {
  const fixture = await canonicalMutationFixture();
  const evidence = validateCanonicalRoszArchive(
    fixture.roster,
    fixture.content,
  );
  assert.equal(evidence.rosterName, fixture.roster.name);
  assert.equal(evidence.factionId, fixture.roster.factionId);
  assert.equal(evidence.totalPoints, fixture.roster.totalPoints);
  assert.equal(
    evidence.unitSelectionCount,
    fixture.roster.units.length,
  );
  assert.equal(
    evidence.modelCount,
    fixture.roster.units.reduce(
      (sum, unit) => sum + unit.modelCount,
      0,
    ),
  );
  assert.equal(evidence.warlordSelectionCount, 1);
  assert.ok(Number(evidence.equipmentSelectionCount) > 0);
  assert.ok(
    Number(evidence.selectionIdCount) >
      fixture.roster.units.length,
  );
  assert.equal(evidence.profileCount, 0);
  assert.equal(
    evidence.profileValidation,
    "not-emitted-by-canonical-exporter",
  );
  assert.ok(
    fixture.roster.units.filter(
      (unit) => unit.name === "Prosecutors",
    ).length >= 2,
  );
});

test("canonical ROSZ validation fails closed on identity mutations", async (context) => {
  const fixture = await canonicalMutationFixture();
  const enhancementFixture =
    await canonicalEnhancementFixture();
  assert.equal(
    validateCanonicalRoszArchive(
      enhancementFixture.roster,
      enhancementFixture.content,
    ).enhancementSelectionCount,
    1,
  );
  const extraEntry = zipSync(
    {
      [fixture.entryName]: strToU8(fixture.xml),
      "unexpected.txt": strToU8("unexpected"),
    },
    { level: 6, mtime: new Date(1980, 0, 1) },
  );
  const mutations: Array<{
    name: string;
    roster: RosterDraftV1;
    content: Uint8Array;
    code: string;
  }> = [
    {
      name: "archive entry inventory",
      roster: fixture.roster,
      content: extraEntry,
      code: "CERTIFICATION_ROSZ_STRUCTURE_INVALID",
    },
    {
      name: "game-system ID",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        replaceExactlyOnce(
          xml,
          'gameSystemId="sys-352e-adc2-7639-d610"',
          'gameSystemId="tampered-system"',
        ),
      ),
      code: "CERTIFICATION_ROSZ_CATALOGUE_IDENTITY_MISMATCH",
    },
    {
      name: "game-system revision",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        replaceExactlyOnce(
          xml,
          'gameSystemRevision="7"',
          'gameSystemRevision="999"',
        ),
      ),
      code: "CERTIFICATION_ROSZ_CATALOGUE_IDENTITY_MISMATCH",
    },
    {
      name: "faction catalogue ID",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        replaceExactlyOnce(
          xml,
          'catalogueId="1f19-6509-d906-ca10"',
          'catalogueId="tampered-catalogue"',
        ),
      ),
      code: "CERTIFICATION_ROSZ_CATALOGUE_IDENTITY_MISMATCH",
    },
    {
      name: "faction catalogue revision",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        replaceExactlyOnce(
          xml,
          'catalogueRevision="6"',
          'catalogueRevision="999"',
        ),
      ),
      code: "CERTIFICATION_ROSZ_CATALOGUE_IDENTITY_MISMATCH",
    },
    {
      name: "roster name",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        replaceExactlyOnce(
          xml,
          `name="${fixture.roster.name}"`,
          'name="Tampered roster"',
        ),
      ),
      code: "CERTIFICATION_ROSZ_ROSTER_NAME_MISMATCH",
    },
    {
      name: "faction catalogue name",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        replaceExactlyOnce(
          xml,
          'catalogueName="Imperium - Adeptus Custodes"',
          'catalogueName="Tampered faction"',
        ),
      ),
      code: "CERTIFICATION_ROSZ_FACTION_MISMATCH",
    },
    {
      name: "roster total points",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        replaceExactlyOnce(
          xml,
          'value="1000"',
          'value="999"',
        ),
      ),
      code: "CERTIFICATION_ROSZ_POINTS_MISMATCH",
    },
    {
      name: "unit points",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) => {
        const block = namedSelectionBlock(
          xml,
          "Blade Champion",
          1,
        );
        const next = replaceExactlyOnce(
          block.value,
          'value="110"',
          'value="109"',
        );
        return `${xml.slice(0, block.start)}${next}${xml.slice(block.end)}`;
      }),
      code: "CERTIFICATION_ROSZ_POINTS_MISMATCH",
    },
    {
      name: "duplicate-name unit multiplicity",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        mutateNamedSelectionTag(
          xml,
          "Prosecutors",
          2,
          (tag) =>
            tag.replace(
              /\bentryId="[^"]+"/,
              'entryId="tampered-unit"',
            ),
        ),
      ),
      code: "CERTIFICATION_ROSZ_UNIT_MULTIPLICITY_MISMATCH",
    },
    {
      name: "duplicate-name unit model count",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) => {
        const block = namedSelectionBlock(
          xml,
          "Prosecutors",
          2,
        );
        const next = mutateNamedSelectionTag(
          block.value,
          "Prosecutor",
          1,
          (tag) =>
            replaceExactlyOnce(
              tag,
              'number="3"',
              'number="2"',
            ),
        );
        return `${xml.slice(0, block.start)}${next}${xml.slice(block.end)}`;
      }),
      code: "CERTIFICATION_ROSZ_MODEL_COUNT_MISMATCH",
    },
    {
      name: "Warlord selection",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        mutateNamedSelectionTag(
          xml,
          "Warlord",
          1,
          (tag) =>
            tag.replace(
              /\bentryId="[^"]+"/,
              'entryId="tampered-warlord"',
            ),
        ),
      ),
      code: "CERTIFICATION_ROSZ_WARLORD_MISMATCH",
    },
    {
      name: "equipment loadout count",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        mutateNamedSelectionTag(
          xml,
          "Vaultswords",
          1,
          (tag) =>
            replaceExactlyOnce(
              tag,
              'number="1"',
              'number="2"',
            ),
        ),
      ),
      code: "CERTIFICATION_ROSZ_EQUIPMENT_MISMATCH",
    },
    {
      name: "enhancement selection",
      roster: enhancementFixture.roster,
      content: mutateRosz(enhancementFixture, (xml) =>
        mutateNamedSelectionTag(
          xml,
          "Panoptispex",
          1,
          (tag) =>
            tag.replace(
              /\bentryId="[^"]+"/,
              'entryId="tampered-enhancement"',
            ),
        ),
      ),
      code: "CERTIFICATION_ROSZ_ENHANCEMENT_MISMATCH",
    },
    {
      name: "per-occurrence selection ID",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        mutateNamedSelectionTag(
          xml,
          "Prosecutors",
          2,
          (tag) =>
            tag.replace(
              /\bid="[^"]+"/,
              'id="tampered-selection-id"',
            ),
        ),
      ),
      code: "CERTIFICATION_ROSZ_SELECTION_ID_MISMATCH",
    },
    {
      name: "unsupported injected profile",
      roster: fixture.roster,
      content: mutateRosz(fixture, (xml) =>
        replaceExactlyOnce(
          xml,
          "</roster>",
          '<profiles><profile id="tampered-profile" name="Injected" /></profiles></roster>',
        ),
      ),
      code: "CERTIFICATION_ROSZ_PROFILE_MISMATCH",
    },
  ];
  for (const mutation of mutations) {
    await context.test(mutation.name, () => {
      assertCertificationCode(
        () =>
          validateCanonicalRoszArchive(
            mutation.roster,
            mutation.content,
          ),
        mutation.code,
      );
    });
  }
});

test("newly reconciled faction mappings produce verified canonical exports", async () => {
  const focused = structuredClone(manifest);
  focused.defaults.pointBands = [1000];
  const report = await runDeterministicCertification(focused, {
    factionId: "crimson-fists",
  });
  assert.equal(report.ok, true, JSON.stringify(report.cases, null, 2));
  const exportCase = report.cases.find(
    (result) =>
      result.caseId ===
      "crimson-fists:canonical-rosz:core-1000",
  );
  assert.equal(exportCase?.status, "pass");
  assert.equal(exportCase?.code, null);
  assert.match(
    String(exportCase?.evidence.contentSha256),
    /^[0-9a-f]{64}$/,
  );
});

test("Tessera preparation capability boundaries are classified truthfully", () => {
  assert.deepEqual(
    classifyTesseraPreparationCapability("unsupported", {
      available: false,
      executionViable: false,
      maximumResultStatus: null,
    }),
    {
      status: "unsupported",
      code: "CERTIFICATION_TESSERA_MAPPING_UNSUPPORTED",
    },
  );
  assert.deepEqual(
    classifyTesseraPreparationCapability("degraded", {
      available: true,
      executionViable: true,
      maximumResultStatus: "degraded",
    }),
    {
      status: "degraded",
      code: "CERTIFICATION_PORTFOLIO_DEGRADED",
    },
  );
  assert.deepEqual(
    classifyTesseraPreparationCapability("complete", {
      available: true,
      executionViable: true,
      maximumResultStatus: "degraded",
    }),
    {
      status: "fail",
      code: "CERTIFICATION_PORTFOLIO_COVERAGE_REGRESSION",
    },
  );
  assert.deepEqual(
    classifyTesseraPreparationCapability("unsupported", {
      mappingAvailable: true,
      available: true,
      executionViable: true,
      maximumResultStatus: "complete",
    }),
    {
      status: "fail",
      code: "CERTIFICATION_TESSERA_CAPABILITY_DRIFT",
    },
  );
});

test("manifest synchronization never preserves unsupported after mapping becomes available", () => {
  assert.equal(
    synchronizedTesseraPreparationExpectation({
      mappingAvailable: true,
      priorNewRecruitExport: "unsupported",
      priorTesseraPreparation: "unsupported",
    }),
    "degraded",
  );
  assert.equal(
    synchronizedTesseraPreparationExpectation({
      mappingAvailable: true,
      priorNewRecruitExport: "required",
      priorTesseraPreparation: "complete",
    }),
    "complete",
  );
  assert.equal(
    synchronizedTesseraPreparationExpectation({
      mappingAvailable: false,
      priorNewRecruitExport: "required",
      priorTesseraPreparation: "complete",
    }),
    "unsupported",
  );
});

test("named-character specialist capability is reported separately from core posture coverage", () => {
  assert.deepEqual(
    classifyNamedCharacterSpecialistCapability(
      "required",
      "included",
    ),
    { status: "pass", code: null },
  );
  assert.deepEqual(
    classifyNamedCharacterSpecialistCapability(
      "required",
      "buildable-not-simulated",
    ),
    { status: "pass", code: null },
  );
  assert.deepEqual(
    classifyNamedCharacterSpecialistCapability(
      "review-pending",
      "buildable-not-simulated",
    ),
    {
      status: "degraded",
      code: "CERTIFICATION_NAMED_SPECIALIST_REVIEW_REQUIRED",
    },
  );
  assert.deepEqual(
    classifyNamedCharacterSpecialistCapability(
      "required",
      "unavailable-after-evaluation",
    ),
    {
      status: "degraded",
      code: "CERTIFICATION_NAMED_SPECIALIST_UNAVAILABLE",
    },
  );
  assert.deepEqual(
    classifyNamedCharacterSpecialistCapability(
      "not-applicable",
      "not-applicable",
    ),
    {
      status: "skipped",
      code: "CERTIFICATION_NAMED_SPECIALIST_NOT_APPLICABLE",
    },
  );
  assert.deepEqual(
    classifyTesseraPreparationCapability("complete", {
      mappingAvailable: true,
      available: true,
      executionViable: true,
      maximumResultStatus: "complete",
    }),
    { status: "pass", code: null },
    "named-specialist status is intentionally absent from core classification",
  );
});

test("connector fixture sanitization removes identities and secrets", () => {
  const source = {
    rosterName: "Private League Roster",
    listUrl: "https://www.newrecruit.eu/app/Lists/private-id",
    password: "fixture-secret-never-return",
    nested: {
      authorization: "Bearer private-token",
      apiKey: "private-api-key",
      xApiKey: "private-x-api-key",
      accessKeyId: "AKIA1234567890ABCDEF",
      headers: {
        "x-custom-secret": "private-header-value",
      },
      storageState: {
        cookies: [{ name: "session", value: "private-cookie" }],
      },
      unit: "Deathshroud Terminators",
      sourceRoszPath: "/Users/private-name/Downloads/private.rosz",
    },
  };
  const sanitized = sanitizeConnectorFixture(source) as typeof source;
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(
    serialized,
    /Private League|private-id|private-token|private-api-key|private-x-api-key|private-header-value|private-cookie|AKIA1234567890ABCDEF/,
  );
  assert.match(serialized, /Deathshroud Terminators/);
  assert.match(sanitized.rosterName, /^fixture-[0-9a-f]{16}$/);
  assert.match(sanitizedFixtureSha256(source), /^[0-9a-f]{64}$/);
  assert.throws(
    () =>
      sanitizeConnectorFixture(
        '<form><input name="password" type="password"></form>',
      ),
    /LOGIN_PAGE_REJECTED/,
  );
  assert.throws(
    () =>
      sanitizeConnectorFixture(
        '<main><input autocomplete="current-password"><button>Continue</button></main>',
      ),
    /LOGIN_PAGE_REJECTED/,
  );
  const inline = JSON.stringify(
    sanitizeConnectorFixture(
      "x-api-key: private-inline-key Authorization=Bearer private-bearer",
    ),
  );
  assert.doesNotMatch(
    inline,
    /private-inline-key|private-bearer/,
  );
});
