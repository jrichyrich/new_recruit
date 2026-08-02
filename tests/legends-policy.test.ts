import assert from "node:assert/strict";
import test from "node:test";

import {
  activateLegendsInventory,
  buildRoster,
  detectLegendsPromptIntent,
  LegendsPlayContextSchema,
  LegendsPolicyDecisionSchema,
  parseRosterPrompt,
  resetActiveLegendsInventoryForTests,
  resolveLegendsPolicy,
  type RuntimeFactionLegendsState,
  searchUnits,
  validateRoster,
} from "../lib/rosterpilot";

test("Legends prompt intent is explicit and questions remain silent", () => {
  assert.equal(
    detectLegendsPromptIntent("Are Legends allowed at this event?"),
    "silent",
  );
  assert.equal(
    detectLegendsPromptIntent("Can I include Legends?"),
    "silent",
  );
  assert.equal(
    detectLegendsPromptIntent("Should I use Legends?"),
    "silent",
  );
  assert.equal(
    detectLegendsPromptIntent(
      "Can I build an army and include Legends?",
    ),
    "silent",
  );
  assert.equal(
    detectLegendsPromptIntent("Build this army with Legends units"),
    "allow",
  );
  assert.equal(
    detectLegendsPromptIntent(
      "Build this army and include Legends units",
    ),
    "allow",
  );
  assert.equal(
    detectLegendsPromptIntent("Build this army without Legends"),
    "exclude",
  );
  assert.equal(
    detectLegendsPromptIntent("Do not include Legends units"),
    "exclude",
  );
  assert.equal(
    detectLegendsPromptIntent("I do not want to include Legends"),
    "exclude",
  );
  assert.equal(
    detectLegendsPromptIntent("Never include Legends"),
    "exclude",
  );
  assert.equal(
    detectLegendsPromptIntent(
      "Include Legends units, but exclude Legends from the final roster",
    ),
    "conflict",
  );

  const silent = parseRosterPrompt(
    "Build 1,000 points of Custodes. Are Legends allowed?",
  );
  assert.equal(silent.legendsPolicy, undefined);
  assert.equal(silent.allowLegends, undefined);
});

test("Legends policy resolves verified context and fails closed", () => {
  const explicit = resolveLegendsPolicy({
    legendsPolicy: "allow",
    classificationAuthority: "verified",
  });
  assert.equal(explicit.resolution, "allowed");
  assert.equal(explicit.effectiveAllowLegends, true);

  const casual = resolveLegendsPolicy({
    legendsPolicy: "auto",
    playContext: { kind: "casual" },
    classificationAuthority: "verified",
  });
  assert.equal(casual.resolution, "allowed");
  assert.equal(casual.contextPermission, "allowed");

  const openPlay = resolveLegendsPolicy({
    legendsPolicy: "auto",
    playContext: { kind: "open-play" },
    classificationAuthority: "verified",
  });
  assert.equal(openPlay.resolution, "allowed");

  const unknownEvent = resolveLegendsPolicy({
    legendsPolicy: "auto",
    playContext: {
      kind: "event",
      eventName: "Example Open",
      legendsPermission: "unknown",
    },
    classificationAuthority: "verified",
  });
  assert.equal(unknownEvent.resolution, "excluded");
  assert.equal(unknownEvent.effectiveAllowLegends, false);
  assert.equal(unknownEvent.eventName, "Example Open");
  assert.match(unknownEvent.reason, /no verified Legends ruling/i);
  assert.equal(
    LegendsPolicyDecisionSchema.safeParse({
      ...unknownEvent,
      eventName: undefined,
    }).success,
    false,
  );

  const unsupportedEventClaim = resolveLegendsPolicy({
    legendsPolicy: "allow",
    playContext: {
      kind: "event",
      eventName: "Example Open",
      legendsPermission: "allowed",
    },
    classificationAuthority: "verified",
  });
  assert.equal(unsupportedEventClaim.contextPermission, "unknown");
  assert.equal(unsupportedEventClaim.resolution, "excluded");
  assert.match(unsupportedEventClaim.reason, /no source-backed/i);

  const explicitAllowWithUnknownRuling = resolveLegendsPolicy({
    legendsPolicy: "allow",
    playContext: {
      kind: "event",
      eventName: "Example Open",
      legendsPermission: "unknown",
      evidence: {
        source: "event-pack",
        title: "Example Open Player Pack",
        contentSha256: "e".repeat(64),
      },
    },
    classificationAuthority: "verified",
  });
  assert.equal(explicitAllowWithUnknownRuling.resolution, "excluded");
  assert.equal(
    explicitAllowWithUnknownRuling.effectiveAllowLegends,
    false,
  );
  assert.match(explicitAllowWithUnknownRuling.reason, /no source-backed/i);

  const unverifiedClassification = resolveLegendsPolicy({
    legendsPolicy: "allow",
    classificationAuthority: "unverified-overlay",
  });
  assert.equal(unverifiedClassification.resolution, "excluded");
  assert.equal(unverifiedClassification.effectiveAllowLegends, false);
  assert.match(unverifiedClassification.reason, /verified official/i);
});

test("event permission requires identifiable source evidence", () => {
  assert.throws(
    () =>
      LegendsPlayContextSchema.parse({
        kind: "event",
        eventName: "Example Open",
        legendsPermission: "allowed",
        evidence: { source: "event-pack" },
      }),
    /source title|section\/reference|content hash/i,
  );
  const sourcedContext = LegendsPlayContextSchema.parse({
    kind: "event",
    eventName: "Example Open",
    legendsPermission: "allowed",
    evidence: {
      source: "organizer-ruling",
      title: "Example Open organizer ruling",
      reference: "Rules channel message 42",
    },
  });
  assert.equal(sourcedContext.kind, "event");
  assert.deepEqual(
    sourcedContext.kind === "event"
      ? sourcedContext.evidence
      : undefined,
    {
      source: "organizer-ruling",
      title: "Example Open organizer ruling",
      reference: "Rules channel message 42",
    },
  );
  const malformedBuild = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    legendsPolicy: "allow",
    playContext: {
      kind: "event",
      eventName: "Example Open",
      legendsPermission: "allowed",
      evidence: { source: "event-pack" },
    } as never,
  });
  assert.equal(malformedBuild.ok, false);
  assert.ok(
    malformedBuild.violations.some(
      (violation) => violation.code === "LEGENDS_POLICY_INVALID",
    ),
  );
  const validDecision = resolveLegendsPolicy({
    legendsPolicy: "allow",
    classificationAuthority: "verified",
  });
  assert.equal(
    LegendsPolicyDecisionSchema.safeParse({
      ...validDecision,
      classificationAuthority: "unavailable",
    }).success,
    false,
  );
});

test("a verified event denial cannot be overridden", () => {
  const decision = resolveLegendsPolicy({
    legendsPolicy: "allow",
    playContext: {
      kind: "event",
      eventName: "Example Open",
      legendsPermission: "disallowed",
      evidence: {
        source: "event-pack",
        title: "Example Open Player Pack",
        contentSha256: "a".repeat(64),
      },
    },
    classificationAuthority: "verified",
  });
  assert.equal(decision.resolution, "blocked");
  assert.equal(decision.effectiveAllowLegends, false);
  assert.equal(decision.evidence?.source, "event-pack");
});

test("builder rejects conflicting policy inputs", () => {
  const structuredConflict = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    legendsPolicy: "allow",
    allowLegends: false,
  });
  assert.equal(structuredConflict.ok, false);
  assert.equal(structuredConflict.data, null);
  assert.ok(
    structuredConflict.violations.some(
      (violation) => violation.code === "LEGENDS_POLICY_CONFLICT",
    ),
  );

  const promptConflict = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    prompt: "Include Legends, but also exclude Legends.",
  });
  assert.equal(promptConflict.ok, false);
  assert.ok(
    promptConflict.violations.some(
      (violation) => violation.code === "LEGENDS_POLICY_CONFLICT",
    ),
  );

  const promptAndStructuredConflict = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    legendsPolicy: "allow",
    prompt: "Exclude Legends from this roster.",
  });
  assert.equal(promptAndStructuredConflict.ok, false);
  assert.ok(
    promptAndStructuredConflict.violations.some(
      (violation) => violation.code === "LEGENDS_POLICY_CONFLICT",
    ),
  );
});

test("forged imported decisions cannot enable Legends without permission", () => {
  const forgedDecision = {
    requestedPolicy: "auto" as const,
    promptIntent: "silent" as const,
    contextPermission: "unknown" as const,
    effectiveAllowLegends: true,
    resolution: "allowed" as const,
    source: "default" as const,
    reason: "forged",
    classificationAuthority: "verified" as const,
    playContextKind: "unspecified" as const,
  };
  assert.equal(
    LegendsPolicyDecisionSchema.safeParse(forgedDecision).success,
    false,
  );

  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
  });
  assert.ok(built.data);
  const forgedDraft = structuredClone(built.data);
  forgedDraft.constraints.allowLegends = true;
  forgedDraft.constraints.legendsPolicyDecision = forgedDecision;
  const validation = validateRoster(forgedDraft);
  assert.equal(validation.ok, false);
  assert.ok(
    validation.violations.some(
      (violation) => violation.code === "MALFORMED_ROSTER",
    ),
  );
});

test("builder persists an evidence-backed fail-closed decision", () => {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    legendsPolicy: "auto",
    playContext: {
      kind: "event",
      eventName: "Example Open",
      legendsPermission: "unknown",
      evidence: {
        source: "event-pack",
        title: "Example Open Player Pack",
        reference: "section 4",
        contentSha256: "b".repeat(64),
      },
    },
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("; "),
  );
  assert.ok(built.data);
  assert.equal(built.data.constraints.allowLegends, false);
  assert.equal(
    built.data.constraints.legendsPolicyDecision?.playContextKind,
    "event",
  );
  assert.equal(
    built.data.constraints.legendsPolicyDecision?.eventName,
    "Example Open",
  );
  assert.equal(
    built.data.constraints.legendsPolicyDecision?.evidence
      ?.contentSha256,
    "b".repeat(64),
  );
  const validation = validateRoster(built.data);
  assert.ok(
    validation.warnings.some(
      (warning) => warning.code === "LEGENDS_POLICY_UNKNOWN",
    ),
  );
});

test("an explicit event opt-in warns when source-backed permission is unknown", () => {
  activateLegendsInventory(
    new Map([
      [
        "adeptus-custodes",
        {
          schemaVersion: 1 as const,
          factionId: "adeptus-custodes",
          coverageStatus: "not-published" as const,
          classificationAuthority:
            "games-workshop-verified" as const,
          sourceArtifacts: [
            {
              sourceId: "custodes-legends-status",
              version: "2026-08",
              contentSha256: "f".repeat(64),
              url: "https://example.com/custodes-legends.pdf",
            },
          ],
          units: [],
        },
      ],
    ]),
  );
  try {
    const built = buildRoster({
      faction: "adeptus-custodes",
      pointsLimit: 1_000,
      legendsPolicy: "allow",
      playContext: {
        kind: "event",
        eventName: "Example Open",
        legendsPermission: "unknown",
      },
    });
    assert.ok(built.data);
    assert.equal(built.data.constraints.allowLegends, false);
    assert.ok(
      validateRoster(built.data).warnings.some(
        (warning) => warning.code === "LEGENDS_POLICY_EXCLUDED",
      ),
    );
  } finally {
    resetActiveLegendsInventoryForTests();
  }
});

test("search exposes official inventory-only Legends without making them buildable", () => {
  activateLegendsInventory(
    new Map([
      [
        "aeldari",
        {
          schemaVersion: 1 as const,
          factionId: "aeldari",
          coverageStatus: "complete" as const,
          classificationAuthority:
            "games-workshop-verified" as const,
          sourceArtifacts: [
            {
              sourceId: "aeldari-legends-pack",
              version: "2026-08",
              contentSha256: "c".repeat(64),
              url: "https://example.com/aeldari-legends.pdf",
            },
          ],
          units: [
            {
              legendId: "official:aeldari:relic-engine",
              factionId: "aeldari",
              name: "Aeldari Legends Relic Engine",
              unitId: null,
              sourceId: "aeldari-legends-pack",
              buildSupported: false,
            },
          ],
        },
      ],
    ]),
  );
  try {
    const hidden = searchUnits({
      faction: "aeldari",
      query: "Aeldari Legends Relic Engine",
    });
    assert.deepEqual(hidden.data, []);

    const visible = searchUnits({
      faction: "aeldari",
      query: "Aeldari Legends Relic Engine",
      includeLegends: true,
    });
    assert.equal(visible.data?.length, 1);
    assert.equal(visible.data?.[0].isLegend, true);
    assert.equal(visible.data?.[0].pointsKnown, false);
    assert.equal(visible.data?.[0].legendBuildSupported, false);
    assert.equal(visible.data?.[0].supported, false);
    assert.deepEqual(visible.data?.[0].legendProvenance, {
      classificationAuthority: "games-workshop-verified",
      sourceId: "aeldari-legends-pack",
      version: "2026-08",
      contentSha256: "c".repeat(64),
      url: "https://example.com/aeldari-legends.pdf",
    });

    const blocked = buildRoster({
      faction: "aeldari",
      pointsLimit: 1_000,
      legendsPolicy: "allow",
      requiredUnitIds: ["official:aeldari:relic-engine"],
    });
    assert.equal(blocked.ok, false);
    assert.ok(
      blocked.violations.some(
        (violation) =>
          violation.code === "LEGENDS_BUILD_SUPPORT_UNAVAILABLE",
      ),
    );
  } finally {
    resetActiveLegendsInventoryForTests();
  }
});

test("search never promotes unverified Legends source evidence to verified provenance", () => {
  activateLegendsInventory(
    new Map([
      [
        "aeldari",
        {
          schemaVersion: 1 as const,
          factionId: "aeldari",
          coverageStatus: "complete" as const,
          classificationAuthority:
            "games-workshop-unverified-overlay" as const,
          sourceArtifacts: [
            {
              sourceId: "unverified-aeldari-pack",
              version: "2026-08",
              contentSha256: "e".repeat(64),
              url: "https://example.com/unverified-aeldari.pdf",
            },
          ],
          units: [
            {
              legendId: "official:aeldari:unverified-relic",
              factionId: "aeldari",
              name: "Unverified Aeldari Relic",
              unitId: null,
              sourceId: "unverified-aeldari-pack",
              buildSupported: false,
            },
          ],
        },
      ],
    ]),
  );
  try {
    const result = searchUnits({
      faction: "aeldari",
      query: "Unverified Aeldari Relic",
      includeLegends: true,
    });
    assert.equal(result.data?.length, 1);
    assert.equal(result.data?.[0].legendProvenance, undefined);
    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.code === "LEGENDS_CLASSIFICATION_UNVERIFIED",
      ),
    );
  } finally {
    resetActiveLegendsInventoryForTests();
  }
});

test("chapter policy and search include inherited faction Legends coverage", () => {
  const chapterState = {
    schemaVersion: 1 as const,
    factionId: "blood-angels",
    coverageStatus: "not-published" as const,
    classificationAuthority: "games-workshop-verified" as const,
    sourceArtifacts: [
      {
        sourceId: "blood-angels-pack",
        version: "2026-08",
        contentSha256: "d".repeat(64),
        url: "https://example.com/blood-angels.pdf",
      },
    ],
    units: [],
  };
  activateLegendsInventory(
    new Map([["blood-angels", chapterState]]),
  );
  try {
    const incompleteAncestry = buildRoster({
      faction: "blood-angels",
      pointsLimit: 1_000,
      legendsPolicy: "allow",
    });
    assert.ok(incompleteAncestry.data);
    assert.equal(
      incompleteAncestry.data.constraints.allowLegends,
      false,
    );
    assert.equal(
      incompleteAncestry.data.constraints.legendsPolicyDecision
        ?.classificationAuthority,
      "unavailable",
    );

    activateLegendsInventory(
      new Map<string, RuntimeFactionLegendsState>([
        ["blood-angels", chapterState],
        [
          "adeptus-astartes",
          {
            schemaVersion: 1 as const,
            factionId: "adeptus-astartes",
            coverageStatus: "complete" as const,
            classificationAuthority:
              "games-workshop-verified" as const,
            sourceArtifacts: [
              {
                sourceId: "adeptus-astartes-pack",
                version: "2026-08",
                contentSha256: "e".repeat(64),
                url: "https://example.com/adeptus-astartes.pdf",
              },
            ],
            units: [
              {
                legendId: "official:adeptus-astartes:relic",
                factionId: "adeptus-astartes",
                name: "Inherited Astartes Legends Relic",
                unitId: null,
                sourceId: "adeptus-astartes-pack",
                buildSupported: false,
              },
            ],
          },
        ],
      ]),
    );
    const inherited = searchUnits({
      faction: "blood-angels",
      query: "Inherited Astartes Legends Relic",
      includeLegends: true,
    });
    assert.equal(inherited.data?.length, 1);
    assert.equal(inherited.data?.[0].factionId, "adeptus-astartes");
    const requiredInherited = buildRoster({
      faction: "blood-angels",
      pointsLimit: 1_000,
      legendsPolicy: "allow",
      requiredUnitIds: ["official:adeptus-astartes:relic"],
    });
    assert.equal(requiredInherited.data, null);
    assert.equal(
      requiredInherited.violations[0]?.code,
      "LEGENDS_BUILD_SUPPORT_UNAVAILABLE",
    );
    const completeAncestry = buildRoster({
      faction: "blood-angels",
      pointsLimit: 1_000,
      legendsPolicy: "allow",
    });
    assert.ok(completeAncestry.data);
    assert.equal(completeAncestry.data.constraints.allowLegends, true);
  } finally {
    resetActiveLegendsInventoryForTests();
  }
});
