import assert from "node:assert/strict";
import test from "node:test";

import {
  CombatCorpusConformanceReportV1DraftSchema,
  buildCombatSourceLeafInventoryV1,
  createCombatCorpusConformanceReportV1,
  createCombatSemanticsOverlayV1,
  evaluateCombatCorpusStrictAdmissionV1,
  validateCombatSemanticsOverlayBindingsV1,
  verifyCombatCorpusConformanceReportV1Hash,
  verifyCombatSemanticsOverlayV1Hash,
  verifyCombatSourceLeafInventoryV1Hash,
  type CombatCorpusComponentIdentityV1,
  type CombatCorpusSourceEntityInputV1,
  type CombatLeafAccountingV1,
  type CombatOverlaySourceBindingV1,
  type CombatSemanticsOverlayEntryV1,
  type CombatSourceLeafInventoryV1,
} from "../lib/rosterpilot/combat-corpus-conformance";

const bundle = {
  bundleId: "a".repeat(64),
  engineDataSchemaVersion: 3,
  rulesSemanticSha256: "b".repeat(64),
};

function source(
  effect: unknown,
  overrides: Partial<CombatCorpusSourceEntityInputV1> = {},
): CombatCorpusSourceEntityInputV1 {
  return {
    sourceId: "ability:world-eaters:test-rule",
    entityKind: "ability",
    factionId: "world-eaters",
    entityId: "test-rule",
    entitySha256: "c".repeat(64),
    effectJsonPointer: "/effect",
    effect,
    ...overrides,
  };
}

function component(
  componentId: string,
  digestCharacter: string,
): CombatCorpusComponentIdentityV1 {
  return {
    componentId,
    version: "1.0.0",
    contentSha256: digestCharacter.repeat(64),
  };
}

function fragmentBinding(
  inventory: CombatSourceLeafInventoryV1,
  jsonPointer: string,
): CombatOverlaySourceBindingV1 {
  const fragment = inventory.fragments.find(
    (candidate) => candidate.jsonPointer === jsonPointer,
  );
  assert.ok(fragment, `Missing fragment ${jsonPointer}`);
  const corpusSource = inventory.sources.find(
    (candidate) => candidate.sourceId === fragment.sourceId,
  );
  assert.ok(corpusSource);
  return {
    sourceId: corpusSource.sourceId,
    entitySha256: corpusSource.entitySha256,
    jsonPointer: fragment.jsonPointer,
    fragmentSha256: fragment.fragmentSha256,
  };
}

function leafAt(
  inventory: CombatSourceLeafInventoryV1,
  jsonPointer: string,
) {
  const fragment = inventory.fragments.find(
    (candidate) => candidate.jsonPointer === jsonPointer,
  );
  assert.ok(fragment, `Missing fragment ${jsonPointer}`);
  const leaf = inventory.leaves.find(
    (candidate) => candidate.fragmentId === fragment.fragmentId,
  );
  assert.ok(leaf, `Missing leaf ${jsonPointer}`);
  return { fragment, leaf };
}

const reviewedEvidence = {
  reviewedBy: "personal-review",
  reviewedAt: "2026-08-04T12:00:00.000Z",
  rationale: "Reviewed against the structured source fragment.",
  reference: null,
};

test("source-leaf inventory traverses every current structured effect container and retains execution ancestry", async () => {
  const effect = {
    type: "sequence",
    steps: [
      {
        type: "conditional",
        condition: {
          type: "charged-this-turn",
          parameters: {},
        },
        effect: {
          type: "stat-modifier",
          target: "unit",
          modifier: { stat: "A", operation: "add", value: 1 },
        },
      },
      {
        type: "stance-select",
        mode: "re-selectable",
        options: [
          {
            name: "Accuracy",
            effect: {
              type: "re-roll",
              target: "unit",
              modifier: { roll: "hit", subset: "ones" },
            },
          },
          {
            name: "Resilience",
            effect: {
              type: "aura",
              target: "friendly-within-aura",
              modifier: {
                range: 6,
                effect: {
                  type: "damage-reduction",
                  target: "unit",
                  modifier: { amount: 1 },
                },
              },
            },
          },
        ],
      },
      {
        type: "risk-reward",
        reward: {
          type: "movement-modifier",
          target: "unit",
          modifier: { move_type: "normal", distance: 2 },
        },
        risk: {
          test: "hazardous",
          on_fail: {
            type: "mortal-wounds",
            target: "self",
            modifier: { count: 3 },
          },
        },
      },
    ],
  };

  const first = await buildCombatSourceLeafInventoryV1({
    bundle,
    sources: [source(effect)],
  });
  const second = await buildCombatSourceLeafInventoryV1({
    bundle,
    sources: [source(effect)],
  });

  assert.equal(first.inventorySha256, second.inventorySha256);
  assert.equal(await verifyCombatSourceLeafInventoryV1Hash(first), true);
  assert.equal(first.traversalIssues.length, 0);
  assert.equal(first.fragments.length, 10);
  assert.equal(first.leaves.length, 5);

  const damageReduction = leafAt(
    first,
    "/effect/steps/1/options/1/effect/modifier/effect",
  ).leaf;
  const ancestors = damageReduction.ancestorFragmentIds.map(
    (fragmentId) =>
      first.fragments.find(
        (fragment) => fragment.fragmentId === fragmentId,
      )?.effectType,
  );
  assert.deepEqual(ancestors, ["sequence", "stance-select", "aura"]);
});

test("unknown and malformed effect containers become accounted untraversable leaves instead of guessed nodes", async () => {
  const inventory = await buildCombatSourceLeafInventoryV1({
    bundle,
    sources: [
      source({
        type: "sequence",
        steps: [
          {
            type: "future-wrapper",
            effect: {
              type: "stat-modifier",
              target: "unit",
              modifier: { stat: "A", value: 1 },
            },
          },
          { type: "choice", options: [] },
        ],
      }),
    ],
  });

  assert.equal(inventory.leaves.length, 2);
  assert.deepEqual(
    inventory.traversalIssues.map((issue) => issue.code).sort(),
    ["EMPTY_EFFECT_CONTAINER", "UNKNOWN_EFFECT_NODE_TYPE"],
  );
  assert.equal(
    inventory.fragments.filter(
      (fragment) => fragment.role === "untraversable",
    ).length,
    2,
  );
  assert.equal(await verifyCombatSourceLeafInventoryV1Hash(inventory), true);
});

test("overlay hashes are canonical and stale entity or fragment bindings fail closed", async () => {
  const original = await buildCombatSourceLeafInventoryV1({
    bundle,
    sources: [
      source({
        type: "sequence",
        steps: [
          {
            type: "stat-modifier",
            target: "unit",
            modifier: { stat: "A", operation: "add", value: 1 },
          },
          {
            type: "movement-modifier",
            target: "unit",
            modifier: { move_type: "normal", distance: 2 },
          },
        ],
      }),
    ],
  });
  const entries: CombatSemanticsOverlayEntryV1[] = [
    {
      entryId: "phase:test-rule",
      kind: "phase-mapping",
      source: fragmentBinding(original, "/effect/steps/0"),
      phases: ["fight", "shooting"],
      evidence: reviewedEvidence,
    },
    {
      entryId: "scope:movement",
      kind: "calculator-scope",
      source: fragmentBinding(original, "/effect/steps/1"),
      classification: "out-of-calculator-scope",
      evidence: reviewedEvidence,
    },
    {
      entryId: "binding:test-wargear",
      kind: "ability-binding",
      source: fragmentBinding(original, "/effect/steps/1"),
      bindingClass: "non-weapon-wargear",
      subject: {
        kind: "equipment",
        factionId: "world-eaters",
        unitId: "test-unit",
        equipmentId: "test-wargear",
      },
      abilityIds: ["movement-aura", "movement-boost"],
      evidence: reviewedEvidence,
    },
  ];
  const first = await createCombatSemanticsOverlayV1({
    schemaVersion: 1,
    kind: "rosterpilot-combat-semantics-overlay",
    bundle,
    sourceInventorySha256: original.inventorySha256,
    entries,
  });
  const phaseEntry = entries[0];
  assert.equal(phaseEntry.kind, "phase-mapping");
  if (phaseEntry.kind !== "phase-mapping") {
    throw new Error("Expected the phase-mapping fixture entry.");
  }
  const abilityEntry = entries[2];
  assert.equal(abilityEntry.kind, "ability-binding");
  if (abilityEntry.kind !== "ability-binding") {
    throw new Error("Expected the ability-binding fixture entry.");
  }
  const second = await createCombatSemanticsOverlayV1({
    schemaVersion: 1,
    kind: "rosterpilot-combat-semantics-overlay",
    bundle,
    sourceInventorySha256: original.inventorySha256,
    entries: [
      entries[1],
      {
        ...abilityEntry,
        abilityIds: [...abilityEntry.abilityIds].reverse(),
      },
      { ...phaseEntry, phases: ["shooting", "fight"] },
    ],
  });

  assert.equal(first.overlaySha256, second.overlaySha256);
  assert.equal(await verifyCombatSemanticsOverlayV1Hash(first), true);
  assert.equal(
    (
      await validateCombatSemanticsOverlayBindingsV1({
        overlay: first,
        inventory: original,
      })
    ).valid,
    true,
  );

  const changed = await buildCombatSourceLeafInventoryV1({
    bundle,
    sources: [
      source(
        {
          type: "sequence",
          steps: [
            {
              type: "stat-modifier",
              target: "unit",
              modifier: { stat: "A", operation: "add", value: 2 },
            },
            {
              type: "movement-modifier",
              target: "unit",
              modifier: { move_type: "normal", distance: 2 },
            },
          ],
        },
        { entitySha256: "d".repeat(64) },
      ),
    ],
  });
  const stale = await validateCombatSemanticsOverlayBindingsV1({
    overlay: first,
    inventory: changed,
  });
  assert.equal(stale.valid, false);
  assert.deepEqual(stale.staleEntryIds, [
    "binding:test-wargear",
    "phase:test-rule",
    "scope:movement",
  ]);
  assert.ok(
    stale.issues.some((issue) => issue.code === "OVERLAY_ENTITY_STALE"),
  );
  assert.ok(
    stale.issues.some(
      (issue) => issue.code === "OVERLAY_FRAGMENT_STALE",
    ),
  );
});

async function conformingFixture() {
  const inventory = await buildCombatSourceLeafInventoryV1({
    bundle,
    sources: [
      source({
        type: "sequence",
        steps: [
          {
            type: "stat-modifier",
            target: "unit",
            modifier: { stat: "A", operation: "add", value: 1 },
          },
          {
            type: "conditional",
            condition: { type: "charged-this-turn", parameters: {} },
            effect: {
              type: "re-roll",
              target: "unit",
              modifier: { roll: "wound", subset: "ones" },
            },
          },
          {
            type: "movement-modifier",
            target: "unit",
            modifier: { move_type: "normal", distance: 2 },
          },
          {
            type: "cp-gain",
            target: "self",
            modifier: { amount: 1 },
          },
        ],
      }),
    ],
  });
  const entries: CombatSemanticsOverlayEntryV1[] = [
    {
      entryId: "phase:attacks",
      kind: "phase-mapping",
      source: fragmentBinding(inventory, "/effect/steps/0"),
      phases: ["fight"],
      evidence: reviewedEvidence,
    },
    {
      entryId: "scope:movement",
      kind: "calculator-scope",
      source: fragmentBinding(inventory, "/effect/steps/2"),
      classification: "out-of-calculator-scope",
      evidence: reviewedEvidence,
    },
    {
      entryId: "scope:cp",
      kind: "calculator-scope",
      source: fragmentBinding(inventory, "/effect/steps/3"),
      classification: "not-applicable",
      evidence: reviewedEvidence,
    },
  ];
  const overlay = await createCombatSemanticsOverlayV1({
    schemaVersion: 1,
    kind: "rosterpilot-combat-semantics-overlay",
    bundle,
    sourceInventorySha256: inventory.inventorySha256,
    entries,
  });
  const attacks = leafAt(inventory, "/effect/steps/0");
  const reroll = leafAt(inventory, "/effect/steps/1/effect");
  const movement = leafAt(inventory, "/effect/steps/2");
  const cp = leafAt(inventory, "/effect/steps/3");
  const conditional = inventory.fragments.find(
    (fragment) => fragment.jsonPointer === "/effect/steps/1",
  );
  assert.ok(conditional);
  const leafAccounting: CombatLeafAccountingV1[] = [
    {
      leafId: attacks.leaf.leafId,
      phaseEvidence: {
        kind: "reviewed-overlay",
        phases: ["fight"],
        overlayEntryId: "phase:attacks",
      },
      stateKeys: [],
      disposition: {
        kind: "modeled",
        exactness: "exact",
        mechanicIds: ["attacks-mod"],
      },
    },
    {
      leafId: reroll.leaf.leafId,
      phaseEvidence: {
        kind: "structured-trigger",
        phases: ["fight"],
        evidenceJsonPointer: conditional.jsonPointer,
        evidenceFragmentSha256: conditional.fragmentSha256,
      },
      stateKeys: ["unit.chargedThisTurn"],
      disposition: {
        kind: "state-required",
        exactness: "exact-when-state-selected",
        mechanicIds: ["wound-reroll"],
        reason: "The charged state must be selected.",
      },
    },
    {
      leafId: movement.leaf.leafId,
      phaseEvidence: {
        kind: "not-required",
        reason: "Movement is outside directional combat calculation.",
      },
      stateKeys: [],
      disposition: {
        kind: "out-of-calculator-scope",
        overlayEntryId: "scope:movement",
        reason: "Movement does not alter a shooting or fight damage path.",
      },
    },
    {
      leafId: cp.leaf.leafId,
      phaseEvidence: {
        kind: "not-required",
        reason: "Resource gain does not execute in a directional attack.",
      },
      stateKeys: [],
      disposition: {
        kind: "not-applicable",
        reason: "The leaf grants CP rather than modifying this attack.",
        overlayEntryId: "scope:cp",
      },
    },
  ];
  return { inventory, overlay, leafAccounting };
}

test("strict conformance admits exact accounting, reviewed scope, phase evidence, and supported state keys", async () => {
  const fixture = await conformingFixture();
  const common = {
    inventory: fixture.inventory,
    overlay: fixture.overlay,
    community: {
      package: "@alpaca-software/40kdc-data",
      version: "1.2.1",
      contentSha256: "e".repeat(64),
    },
    compiler: component("combat-corpus-compiler", "f"),
    adapter: component("tessera-adapter", "1"),
    engine: component("tessera-engine", "2"),
    supportedStateKeys: ["unit.chargedThisTurn"],
  };
  const first = await createCombatCorpusConformanceReportV1({
    ...common,
    leafAccounting: fixture.leafAccounting,
  });
  const second = await createCombatCorpusConformanceReportV1({
    ...common,
    leafAccounting: [...fixture.leafAccounting].reverse(),
  });

  assert.equal(first.reportSha256, second.reportSha256);
  assert.equal(await verifyCombatCorpusConformanceReportV1Hash(first), true);
  assert.deepEqual(first.summary, {
    sourceEntityCount: 1,
    effectFragmentCount: 6,
    leafCount: 4,
    accountedLeafCount: 4,
    modeled: 1,
    stateRequired: 1,
    outOfCalculatorScope: 1,
    notApplicable: 1,
    unsupported: 0,
    traversalIssueCount: 0,
  });
  assert.deepEqual(
    await evaluateCombatCorpusStrictAdmissionV1({
      report: first,
      overlay: fixture.overlay,
      expected: {
        bundle,
        community: common.community,
        compiler: common.compiler,
        adapter: common.adapter,
        engine: common.engine,
        supportedStateKeys: common.supportedStateKeys,
      },
    }),
    { admitted: true, issues: [] },
  );
});

test("report schema and strict admission reject missing accounts, unknown state keys, and unsupported leaves", async () => {
  const fixture = await conformingFixture();
  const common = {
    inventory: fixture.inventory,
    overlay: fixture.overlay,
    community: {
      package: "@alpaca-software/40kdc-data",
      version: "1.2.1",
      contentSha256: "e".repeat(64),
    },
    compiler: component("combat-corpus-compiler", "f"),
    adapter: component("tessera-adapter", "1"),
    engine: component("tessera-engine", "2"),
  };

  await assert.rejects(
    createCombatCorpusConformanceReportV1({
      ...common,
      supportedStateKeys: ["unit.chargedThisTurn"],
      leafAccounting: fixture.leafAccounting.slice(1),
    }),
    /Leaf accounting must be exact/,
  );
  await assert.rejects(
    createCombatCorpusConformanceReportV1({
      ...common,
      supportedStateKeys: [],
      leafAccounting: fixture.leafAccounting,
    }),
    /not declared by the report's supported state contract/,
  );

  const unsupportedAccounts = fixture.leafAccounting.map((account, index) =>
    index === 0
      ? {
          ...account,
          phaseEvidence: {
            kind: "unresolved" as const,
            reason: "No exact phase mapping exists.",
          },
          disposition: {
            kind: "unsupported" as const,
            reason: "No exact compiler route exists.",
          },
        }
      : account,
  );
  const unsupported = await createCombatCorpusConformanceReportV1({
    ...common,
    supportedStateKeys: ["unit.chargedThisTurn"],
    leafAccounting: unsupportedAccounts,
  });
  const admission = await evaluateCombatCorpusStrictAdmissionV1({
    report: unsupported,
    overlay: fixture.overlay,
    expected: {
      bundle,
      community: common.community,
      compiler: common.compiler,
      adapter: common.adapter,
      engine: common.engine,
      supportedStateKeys: ["unit.chargedThisTurn"],
    },
  });
  assert.equal(admission.admitted, false);
  assert.ok(
    admission.issues.some((issue) => issue.code === "UNSUPPORTED_LEAF"),
  );
  assert.ok(
    admission.issues.some((issue) => issue.code === "UNRESOLVED_PHASE"),
  );

  const staleRuntime = await evaluateCombatCorpusStrictAdmissionV1({
    report: unsupported,
    overlay: fixture.overlay,
    expected: {
      bundle,
      community: common.community,
      compiler: component("new-corpus-compiler", "3"),
      adapter: common.adapter,
      engine: common.engine,
      supportedStateKeys: [
        "unit.chargedThisTurn",
        "pair.distanceInches",
      ],
    },
  });
  assert.ok(
    staleRuntime.issues.some(
      (issue) => issue.code === "RUNTIME_IDENTITY_MISMATCH",
    ),
  );
  assert.ok(
    staleRuntime.issues.some(
      (issue) => issue.code === "STATE_CONTRACT_MISMATCH",
    ),
  );

  const draft = Object.fromEntries(
    Object.entries(unsupported).filter(
      ([key]) => key !== "reportSha256",
    ),
  ) as Omit<typeof unsupported, "reportSha256">;
  assert.equal(
    CombatCorpusConformanceReportV1DraftSchema.safeParse({
      ...draft,
      leafAccounting: [
        ...draft.leafAccounting,
        draft.leafAccounting[0],
      ],
      summary: {
        ...draft.summary,
        accountedLeafCount: draft.summary.accountedLeafCount + 1,
        unsupported: draft.summary.unsupported + 1,
      },
    }).success,
    false,
  );
});
