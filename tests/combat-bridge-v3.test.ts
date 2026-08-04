import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCombatBridgeV2,
  defaultCombatPolicyV1,
  type CombatBundleBindingV2,
  type CombatScenarioContextV2,
} from "../lib/rosterpilot/combat-bridge";
import {
  CombatBridgeV3AdmissionError,
  compileCombatBridgeV3,
  verifyCombatBridgeV3Hash,
  type BundleCombatRuleRecordV3,
  type CompileCombatBridgeInputV3,
} from "../lib/rosterpilot/combat-bridge-v3";
import {
  buildCombatSourceLeafInventoryV1,
  createCombatCorpusConformanceReportV1,
  createCombatSemanticsOverlayV1,
  type CombatCorpusComponentIdentityV1,
  type CombatLeafAccountingV1,
  type CombatSemanticsOverlayEntryV1,
} from "../lib/rosterpilot/combat-corpus-conformance";

const corpusBundle = {
  bundleId: "a".repeat(64),
  engineDataSchemaVersion: 3,
  rulesSemanticSha256: "b".repeat(64),
};

const bundle: CombatBundleBindingV2 = {
  bundleId: corpusBundle.bundleId,
  engineDataSchemaVersion: corpusBundle.engineDataSchemaVersion,
  semanticAuthority: "bundle-manifest-verified",
  playerRosterId: "custodes",
  opponentRosterId: "world-eaters",
  playerRosterFingerprint: "9".repeat(64),
  opponentRosterFingerprint: "8".repeat(64),
  playerFactionId: "adeptus-custodes",
  opponentFactionId: "world-eaters",
  playerRosterRulesHash: corpusBundle.rulesSemanticSha256,
  opponentRosterRulesHash: "1".repeat(64),
  playerFactionRulesHash: "2".repeat(64),
  opponentFactionRulesHash: "3".repeat(64),
  playerMappingHash: "4".repeat(64),
  opponentMappingHash: "5".repeat(64),
  portfolioHash: null,
};

const sourceId = "ability:adeptus-custodes:exact-rule";
const entitySha256 = "c".repeat(64);

function component(
  componentId: string,
  character: string,
): CombatCorpusComponentIdentityV1 {
  return {
    componentId,
    version: "1.0.0",
    contentSha256: character.repeat(64),
  };
}

const runtime = {
  community: {
    package: "@alpaca-software/40kdc-data",
    version: "1.2.1",
    contentSha256: "d".repeat(64),
  },
  compiler: component("combat-corpus-compiler", "e"),
  adapter: component("tessera-adapter", "f"),
  engine: component("tessera-engine", "6"),
};

function scenario(
  overrides: Partial<CombatScenarioContextV2> = {},
): CombatScenarioContextV2 {
  return {
    schemaVersion: 2,
    phase: "fight",
    distanceInches: 1,
    withinHalfRange: true,
    attackerStationary: false,
    attackerCharged: true,
    attackerAttached: false,
    targetAttached: false,
    attackerInCover: false,
    targetInCover: false,
    timing: "start-of-phase",
    objectiveState: "unknown",
    attackerStrengthState: "starting",
    targetStrengthState: "starting",
    attackerDamageState: "healthy",
    targetDamageState: "healthy",
    armyAbilityState: "unknown",
    targetConditionState: "unknown",
    ...overrides,
  };
}

type DispositionFixture =
  | { kind: "modeled" }
  | { kind: "state-required"; stateKey: string }
  | { kind: "out-of-calculator-scope" };

async function exactFixture(
  effect: unknown,
  disposition: DispositionFixture = { kind: "modeled" },
): Promise<CompileCombatBridgeInputV3> {
  const inventory = await buildCombatSourceLeafInventoryV1({
    bundle: corpusBundle,
    sources: [
      {
        sourceId,
        entityKind: "ability",
        factionId: "adeptus-custodes",
        entityId: "exact-rule",
        entitySha256,
        effectJsonPointer: "/effect",
        effect,
      },
    ],
  });
  assert.equal(inventory.traversalIssues.length, 0);
  assert.equal(inventory.leaves.length, 1);
  const leaf = inventory.leaves[0];
  const fragment = inventory.fragments.find(
    (candidate) => candidate.fragmentId === leaf.fragmentId,
  );
  assert.ok(fragment);
  const overlayEntries: CombatSemanticsOverlayEntryV1[] =
    disposition.kind === "out-of-calculator-scope"
      ? [
          {
            entryId: "scope:exact-rule",
            kind: "calculator-scope",
            source: {
              sourceId,
              entitySha256,
              jsonPointer: fragment.jsonPointer,
              fragmentSha256: fragment.fragmentSha256,
            },
            classification: "out-of-calculator-scope",
            evidence: {
              reviewedBy: "personal-review",
              reviewedAt: "2026-08-04T12:00:00.000Z",
              rationale: "This movement rule cannot alter attack damage.",
              reference: null,
            },
          },
        ]
      : [];
  const overlay = await createCombatSemanticsOverlayV1({
    schemaVersion: 1,
    kind: "rosterpilot-combat-semantics-overlay",
    bundle: corpusBundle,
    sourceInventorySha256: inventory.inventorySha256,
    entries: overlayEntries,
  });
  const phaseEvidence =
    disposition.kind === "out-of-calculator-scope"
      ? {
          kind: "not-required" as const,
          reason: "Movement is outside the combat calculator.",
        }
      : {
          kind: "structured-attack-semantics" as const,
          phases: ["fight" as const],
          evidenceJsonPointer: fragment.jsonPointer,
          evidenceFragmentSha256: fragment.fragmentSha256,
        };
  const account: CombatLeafAccountingV1 = {
    leafId: leaf.leafId,
    phaseEvidence,
    stateKeys:
      disposition.kind === "state-required"
        ? [disposition.stateKey]
        : [],
    disposition:
      disposition.kind === "modeled"
        ? {
            kind: "modeled",
            exactness: "exact",
            mechanicIds: ["exact-test-mechanic"],
          }
        : disposition.kind === "state-required"
          ? {
              kind: "state-required",
              exactness: "exact-when-state-selected",
              mechanicIds: ["exact-test-mechanic"],
              reason: "The scenario must select the required state.",
            }
          : {
              kind: "out-of-calculator-scope",
              overlayEntryId: "scope:exact-rule",
              reason: "Movement cannot alter attack damage.",
            },
  };
  const supportedStateKeys =
    disposition.kind === "state-required"
      ? [disposition.stateKey]
      : [];
  const report = await createCombatCorpusConformanceReportV1({
    inventory,
    overlay,
    ...runtime,
    supportedStateKeys,
    leafAccounting: [account],
  });
  const rule: BundleCombatRuleRecordV3 = {
    abilityId: "exact-rule",
    abilityName: "Exact Rule",
    entityHash: entitySha256,
    effect,
    source: { kind: "unit", unitId: "custodian-guard" },
    phases: ["fight"],
    phaseMappingStatus: "verified",
    activation: { kind: "always" },
    unsupportedRelevance: "combat",
    corpusSourceId: sourceId,
  };
  return {
    bundle,
    policy: defaultCombatPolicyV1(),
    cells: [
      {
        cellId: "custodes-into-world-eaters:fight:damage",
        direction: "player-to-opponent",
        metric: "mean-damage",
        attacker: {
          rosterId: "custodes",
          selectionId: "guard-1",
          unitId: "custodian-guard",
          factionId: "adeptus-custodes",
          keywords: ["Infantry", "Adeptus Custodes"],
        },
        target: {
          rosterId: "world-eaters",
          selectionId: "berzerkers-1",
          unitId: "khorne-berzerkers",
          factionId: "world-eaters",
          keywords: ["Infantry", "World Eaters"],
        },
        scenario: scenario(),
        ruleVariants: [
          {
            attachmentPlan: {
              id: "unattached",
              attacker: [],
              target: [],
            },
            attackerRules: [rule],
            targetRules: [],
          },
        ],
      },
    ],
    corpus: {
      report,
      overlay,
      expected: {
        bundle: corpusBundle,
        ...runtime,
        supportedStateKeys,
      },
    },
  };
}

const attacksEffect = {
  type: "stat-modifier",
  target: "unit",
  modifier: { stat: "A", operation: "add", value: 1 },
};

test("exact bridge v3 binds corpus and optional replay identities while preserving v2 cells", async () => {
  const input = await exactFixture(attacksEffect);
  input.replay = {
    scenarioContractV3Sha256: "7".repeat(64),
    localInputV2Sha256s: {
      player: "8".repeat(64),
      opponent: "9".repeat(64),
    },
  };
  const bridge = await compileCombatBridgeV3(input);
  const v2 = await compileCombatBridgeV2({
    bundle: input.bundle,
    policy: input.policy,
    cells: input.cells,
  });

  assert.equal(bridge.schemaVersion, 3);
  assert.equal(bridge.coverage.status, "complete");
  assert.equal(bridge.exactness.status, "decision-grade");
  assert.equal(
    bridge.exactness.corpus.reportSha256,
    input.corpus.report.reportSha256,
  );
  assert.equal(bridge.exactness.corpus.relevantLeaves.length, 1);
  assert.equal(bridge.exactness.corpus.ruleBindings.length, 1);
  assert.equal(bridge.exactness.legacyBridgeV2Sha256, v2.bridgeSha256);
  assert.deepEqual(bridge.cells, v2.cells);
  assert.deepEqual(bridge.exactness.replay, {
    scenarioContractV3Sha256: "7".repeat(64),
    localInputV2Sha256s: {
      player: "8".repeat(64),
      opponent: "9".repeat(64),
    },
  });
  assert.equal(await verifyCombatBridgeV3Hash(bridge), true);

  const tampered = structuredClone(bridge);
  tampered.exactness.replay.scenarioContractV3Sha256 = "0".repeat(64);
  assert.equal(await verifyCombatBridgeV3Hash(tampered), false);
});

test("bridge v3 rejects stale and unbound rule-to-corpus identities", async () => {
  const stale = await exactFixture(attacksEffect);
  stale.cells[0].ruleVariants[0].attackerRules[0].entityHash =
    "0".repeat(64);
  await assert.rejects(
    compileCombatBridgeV3(stale),
    (error: unknown) => {
      assert.ok(error instanceof CombatBridgeV3AdmissionError);
      assert.ok(
        error.issues.some(
          (issue) => issue.code === "COMBAT_BRIDGE_V3_RULE_ENTITY_STALE",
        ),
      );
      return true;
    },
  );

  const unbound = await exactFixture(attacksEffect);
  unbound.cells[0].ruleVariants[0].attackerRules[0].corpusSourceId =
    "ability:unknown:missing";
  await assert.rejects(
    compileCombatBridgeV3(unbound),
    (error: unknown) => {
      assert.ok(error instanceof CombatBridgeV3AdmissionError);
      assert.ok(
        error.issues.some(
          (issue) => issue.code === "COMBAT_BRIDGE_V3_RULE_SOURCE_UNBOUND",
        ),
      );
      return true;
    },
  );
});

test("bridge v3 fails closed when an unresolved state-required leaf is omitted", async () => {
  const input = await exactFixture(
    {
      type: "aura",
      target: "friendly-within-aura",
      modifier: {
        range: 6,
        effect: attacksEffect,
      },
    },
    { kind: "state-required", stateKey: "pair.distanceInches" },
  );
  input.cells[0].scenario = scenario({ distanceInches: "unknown" });

  await assert.rejects(
    compileCombatBridgeV3(input),
    (error: unknown) => {
      assert.ok(error instanceof CombatBridgeV3AdmissionError);
      assert.ok(
        error.issues.some(
          (issue) =>
            issue.code === "COMBAT_BRIDGE_V3_LEAF_OMITTED" &&
            issue.leafIds.length === 1,
        ),
      );
      assert.ok(
        error.issues.some(
          (issue) => issue.code === "COMBAT_BRIDGE_V3_COVERAGE_NONEXACT",
        ),
      );
      return true;
    },
  );
});

test("bridge v3 fails closed when a purportedly modeled leaf is omitted", async () => {
  const input = await exactFixture({
    type: "ability-grant",
    target: "unit",
    modifier: { ability: "unmodeled-stance" },
  });

  await assert.rejects(
    compileCombatBridgeV3(input),
    (error: unknown) => {
      assert.ok(error instanceof CombatBridgeV3AdmissionError);
      assert.ok(
        error.issues.some(
          (issue) =>
            issue.code === "COMBAT_BRIDGE_V3_LEAF_OMITTED" &&
            issue.leafIds.length === 1,
        ),
      );
      return true;
    },
  );
});

test("reviewed non-combat leaves are excluded exactly, while missing leaf accounts are rejected", async () => {
  const input = await exactFixture(
    {
      type: "movement-modifier",
      target: "unit",
      modifier: { move_type: "normal", distance: 2 },
    },
    { kind: "out-of-calculator-scope" },
  );
  const bridge = await compileCombatBridgeV3(input);
  assert.equal(bridge.coverage.status, "complete");
  assert.equal(bridge.coverage.notApplicableEffects, 1);
  assert.deepEqual(bridge.exactness.corpus.relevantLeaves, []);
  assert.equal(await verifyCombatBridgeV3Hash(bridge), true);

  const unaccounted = structuredClone(input);
  unaccounted.corpus.report.leafAccounting = [];
  await assert.rejects(
    compileCombatBridgeV3(unaccounted),
    (error: unknown) => {
      assert.ok(error instanceof CombatBridgeV3AdmissionError);
      assert.ok(
        error.issues.some(
          (issue) =>
            issue.code === "COMBAT_BRIDGE_V3_CORPUS_ADMISSION_FAILED",
        ),
      );
      return true;
    },
  );
});
