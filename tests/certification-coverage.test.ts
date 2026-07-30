import assert from "node:assert/strict";
import test from "node:test";

import manifestDocument from "../data/certification-manifest.json" with {
  type: "json",
};
import {
  certificationExpertReviewBinding,
  CertificationManifestSchema,
  type CertificationCaseResult,
} from "../lib/rosterpilot/certification";
import {
  deriveCertificationCoverageDimensions,
} from "../lib/rosterpilot/certification-coverage";

const manifest =
  CertificationManifestSchema.parse(manifestDocument);

function certificationCase(
  input: Partial<CertificationCaseResult> &
    Pick<
      CertificationCaseResult,
      "caseId" | "factionId" | "stage" | "status"
    >,
): CertificationCaseResult {
  return {
    workflow: "roster-correctness",
    code: null,
    message: input.caseId,
    retryable: false,
    startedAt: "2026-07-29T00:00:00.000Z",
    completedAt: "2026-07-29T00:00:00.001Z",
    durationMs: 1,
    evidence: {},
    artifacts: [],
    connectorEvents: [],
    ...input,
  };
}

test("coverage dimensions retain missing detachments and specialist gaps instead of implying completion", () => {
  const dimensions = deriveCertificationCoverageDimensions({
    manifest,
    selectedFactionIds: ["adeptus-custodes"],
    cases: [
      certificationCase({
        caseId: "custodes:build",
        factionId: "adeptus-custodes",
        stage: "build-and-validate",
        status: "pass",
        evidence: {
          detachmentId: "shield-host",
          unitRoles: ["Character", "Infantry"],
        },
      }),
      certificationCase({
        caseId: "custodes:constraints",
        factionId: "adeptus-custodes",
        stage: "hard-constraint-preservation",
        status: "pass",
      }),
      certificationCase({
        caseId: "custodes:determinism",
        factionId: "adeptus-custodes",
        stage: "metamorphic-round-trip",
        status: "pass",
      }),
      certificationCase({
        caseId: "custodes:pending",
        factionId: "adeptus-custodes",
        workflow: "oracle",
        stage: "manual-verification",
        status: "degraded",
        code: "CERTIFICATION_EXPERT_REVIEW_PENDING",
      }),
      certificationCase({
        caseId: "custodes:mapping-baseline",
        factionId: "adeptus-custodes",
        workflow: "oracle",
        stage: "capability-baseline",
        status: "pass",
        evidence: {
          detachmentIds: [
            "auric-champions",
            "shield-host",
          ],
        },
      }),
    ],
  });

  assert.ok(
    dimensions.detachments.intended.some((value) =>
      value.startsWith("adeptus-custodes:"),
    ),
  );
  assert.deepEqual(dimensions.unitCategories.exercised, [
    "Character",
    "Infantry",
  ]);
  assert.deepEqual(dimensions.detachments.exercised, [
    "adeptus-custodes:shield-host",
  ]);
  assert.ok(
    dimensions.detachments.missing.includes(
      "adeptus-custodes:auric-champions",
    ),
    "listing legal detachments as metadata must not count as executing them",
  );
  assert.ok(
    dimensions.specialistCases.exercised.includes(
      "adeptus-custodes:authoritative-warlord",
    ),
  );
  assert.ok(
    dimensions.specialistCases.exercised.includes(
      "adeptus-custodes:collection-only",
    ),
  );
  assert.ok(
    dimensions.specialistCases.exercised.includes(
      "adeptus-custodes:prompt-metamorphism",
    ),
  );
  assert.ok(
    dimensions.specialistCases.missing.includes(
      "adeptus-custodes:transport-parity",
    ),
  );
  assert.deepEqual(dimensions.failureModes, [
    {
      code: "CERTIFICATION_EXPERT_REVIEW_PENDING",
      count: 1,
      statuses: ["degraded"],
      retryableCount: 0,
      caseIds: ["custodes:pending"],
    },
  ]);
});

test("specialist evidence is faction-scoped and reviewed not-applicable requirements do not create false gaps", () => {
  const reviewedManifest = structuredClone(manifest);
  const chaosKnights = reviewedManifest.factions.find(
    (faction) => faction.id === "chaos-knights",
  );
  assert.ok(chaosKnights);
  chaosKnights.expertReview = {
    status: "reviewed",
    reviewedAt: "2026-07-30",
    assertions: [
      "Named-character specialist coverage is not applicable.",
    ],
    binding: certificationExpertReviewBinding(
      reviewedManifest,
      chaosKnights,
    ),
  };
  const dimensions = deriveCertificationCoverageDimensions({
    manifest: reviewedManifest,
    selectedFactionIds: [
      "aeldari",
      "death-guard",
      "chaos-knights",
      "grey-knights",
    ],
    cases: [
      certificationCase({
        caseId: "aeldari:constraints",
        factionId: "aeldari",
        stage: "hard-constraint-preservation",
        status: "pass",
      }),
      certificationCase({
        caseId: "chaos-knights:named-not-applicable",
        factionId: "chaos-knights",
        workflow: "tessera-preparation",
        stage: "named-character-specialist",
        status: "skipped",
        code: "CERTIFICATION_NAMED_SPECIALIST_NOT_APPLICABLE",
      }),
    ],
  });

  assert.ok(
    dimensions.specialistCases.exercised.includes(
      "aeldari:required-unit",
    ),
  );
  assert.ok(
    dimensions.specialistCases.missing.includes(
      "death-guard:required-unit",
    ),
    "Aeldari evidence must not satisfy Death Guard's independent requirement.",
  );
  assert.equal(
    dimensions.specialistCases.intended.includes(
      "chaos-knights:named-character-specialist",
    ),
    false,
    "an expert-reviewed not-applicable specialist is not a required gap",
  );
  assert.ok(
    dimensions.specialistCases.missing.includes(
      "grey-knights:named-character-specialist",
    ),
    "a reviewed required specialist remains required",
  );
});

test("ordered-pair nested evidence contributes detachment and role coverage", () => {
  const dimensions = deriveCertificationCoverageDimensions({
    manifest,
    selectedFactionIds: ["aeldari"],
    cases: [
      certificationCase({
        caseId: "aeldari:against:orks",
        factionId: "aeldari",
        workflow: "tessera-preparation",
        stage: "ordered-local-opponent-matrix",
        status: "pass",
        evidence: {
          playerBuild: {
            roster: {
              detachmentId: "warhost",
              unitRoles: ["Character", "Mounted"],
            },
          },
        },
      }),
    ],
  });

  assert.ok(
    dimensions.detachments.exercised.includes(
      "aeldari:warhost",
    ),
  );
  assert.deepEqual(dimensions.unitCategories.exercised, [
    "Character",
    "Mounted",
  ]);
});
