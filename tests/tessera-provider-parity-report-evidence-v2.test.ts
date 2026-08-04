import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraCombatBridgeEvidenceV2,
  TesseraMatchupReport,
  TesseraScenarioResult,
} from "../lib/rosterpilot";
import type { CombatBridgeV3 } from "../lib/rosterpilot/combat-bridge-v3";
import {
  buildTesseraParityCoveringSuiteV2,
} from "../local/tessera/provider-parity-covering-suite-v2";
import {
  assertCombatBridgeCoveredByTesseraParitySuiteV2,
  buildTesseraProviderParityReportEvidenceV2,
  TesseraProviderParityReportEvidenceV2Error,
} from "../local/tessera/provider-parity-report-evidence-v2";
import type {
  CombatCorpusTranslationLedgerEntryV1,
} from "../local/tessera/combat-bridge-input-v3";
import {
  selectedBaselineTesseraScenarioPolicyContractV3,
  tesseraScenarioPolicyContractV3Sha256,
} from "../local/tessera/scenario-contract-v3";

const inventorySha256 = "1".repeat(64);
const playerFingerprint = "2".repeat(64);
const opponentFingerprint = "3".repeat(64);

function scenarios(): TesseraScenarioResult[] {
  return [
    {
      direction: "player-to-opponent" as const,
      attacker: {
        instanceId: "player-selection",
        selectionId: "player-selection",
        side: "player" as const,
        name: "Custodian Guard",
        label: "Custodian Guard",
        ordinal: 1,
        modelCount: 4,
        points: 180,
        tags: [],
      },
      target: {
        instanceId: "opponent-selection",
        selectionId: "opponent-selection",
        side: "opponent" as const,
        name: "Khorne Berzerkers",
        label: "Khorne Berzerkers",
        ordinal: 1,
        modelCount: 5,
        points: 90,
        tags: [],
      },
    },
    {
      direction: "opponent-to-player" as const,
      attacker: {
        instanceId: "opponent-selection",
        selectionId: "opponent-selection",
        side: "opponent" as const,
        name: "Khorne Berzerkers",
        label: "Khorne Berzerkers",
        ordinal: 1,
        modelCount: 5,
        points: 90,
        tags: [],
      },
      target: {
        instanceId: "player-selection",
        selectionId: "player-selection",
        side: "player" as const,
        name: "Custodian Guard",
        label: "Custodian Guard",
        ordinal: 1,
        modelCount: 4,
        points: 180,
        tags: [],
      },
    },
  ].map(({ direction, attacker, target }) => ({
    scenarioId: `shooting:${direction}`,
    opponentName: "World Eaters",
    phase: "shooting" as const,
    direction,
    metrics: ["mean-damage" as const],
    iterations: 10_000,
    settings: {},
    cells: [{
      attacker,
      target,
      values: {
        wipeProbability: null,
        halfWipeProbability: null,
        meanKills: null,
        meanDamage: 2,
        damagePer100Points: 1,
      },
      confidence: "high" as const,
      warningRefs: [],
    }],
    status: "complete" as const,
    warnings: [],
  }));
}

function report(
  provider: "local-engine" | "website",
  scenarioPolicyContractV3: ReturnType<
    typeof selectedBaselineTesseraScenarioPolicyContractV3
  >,
): TesseraMatchupReport {
  return {
    schemaVersion: 3,
    runId: `${provider}-run`,
    generatedAt: "2026-08-04T00:00:00.000Z",
    source: provider === "local-engine"
      ? "tessera-local-engine"
      : "tessera-ui",
    status: "complete",
    opponents: [{}],
    scenarioPolicyContractV3,
    scenarioPolicyContractV3Sha256:
      tesseraScenarioPolicyContractV3Sha256(
        scenarioPolicyContractV3,
      ),
    simulation: {
      requested: true,
      experimental: true,
      status: "complete",
      selectedBackend: provider,
      settings: {},
      matrices: [],
      scenarios: scenarios(),
    },
  } as unknown as TesseraMatchupReport;
}

function bridgeEvidence(): TesseraCombatBridgeEvidenceV2 {
  return {
    schemaVersion: 2,
    combatBridgeV3Sha256: "4".repeat(64),
    corpusConformanceReportSha256: "5".repeat(64),
    corpusSourceInventorySha256: inventorySha256,
    coverage: {
      status: "complete",
      claimEligibility: "decision-grade",
    },
  } as unknown as TesseraCombatBridgeEvidenceV2;
}

function bridge(): CombatBridgeV3 {
  const participant = (
    side: "player" | "opponent",
  ) => ({
    rosterId: `${side}-roster`,
    selectionId: `${side}-selection`,
    unitId: `${side}-unit`,
    factionId: side === "player"
      ? "adeptus-custodes"
      : "world-eaters",
    keywords: [],
  });
  return {
    schemaVersion: 3,
    bridgeSha256: "4".repeat(64),
    cells: [
      {
        cellId: "player-to-opponent",
        attacker: participant("player"),
        target: participant("opponent"),
      },
      {
        cellId: "opponent-to-player",
        attacker: participant("opponent"),
        target: participant("player"),
      },
    ],
    exactness: {
      corpus: {
        reportSha256: "5".repeat(64),
        sourceInventorySha256: inventorySha256,
        relevantLeaves: [],
        ruleBindings: [],
      },
    },
  } as unknown as CombatBridgeV3;
}

function bridgeWithMechanic(): {
  bridge: CombatBridgeV3;
  translationLedger: CombatCorpusTranslationLedgerEntryV1[];
} {
  const value = bridge();
  value.exactness.corpus.relevantLeaves = [{
    leafId: "custodes-extra-leaf",
    sourceId: "custodes-extra-source",
    disposition: "modeled",
    accountingSha256: "6".repeat(64),
  }];
  value.exactness.corpus.ruleBindings = [{
    cellId: "player-to-opponent",
    attachmentPlanId: "base",
    perspective: "attacker",
    abilityId: "custodes-extra-ability",
    corpusSourceId: "custodes-extra-source",
    entitySha256: "7".repeat(64),
    effectSha256: "8".repeat(64),
    ruleSourceSha256: "9".repeat(64),
  }];
  return {
    bridge: value,
    translationLedger: [{
      leafId: "custodes-extra-leaf",
      sourceId: "custodes-extra-source",
      reviewEntryId: "exact",
      matcher: "exact-leaf",
      phases: ["shooting"],
      stateKeys: [],
      mechanicIds: ["undeclared-mechanic"],
      disposition: "modeled",
    }],
  };
}

test("local and Web reports seal the same physical-state parity binding", () => {
  const contract = selectedBaselineTesseraScenarioPolicyContractV3(
    10_000,
    {
      playerSelectionIds: ["player-selection"],
      opponentSelectionIds: ["opponent-selection"],
    },
    ["shooting"],
    ["mean-damage"],
  );
  const suite = buildTesseraParityCoveringSuiteV2({
    corpusInventorySha256: inventorySha256,
    factions: [
      {
        factionId: "adeptus-custodes",
        attackerMechanicIds: [],
        defenderMechanicIds: [],
      },
      {
        factionId: "world-eaters",
        attackerMechanicIds: [],
        defenderMechanicIds: [],
      },
    ],
  });
  const coveringCaseId = suite.cases[0].caseId;
  const build = (provider: "local-engine" | "website") =>
    buildTesseraProviderParityReportEvidenceV2({
      report: report(provider, contract),
      scenarioPolicyContractV3: contract,
      bridgeEvidence: bridgeEvidence(),
      bridge: bridge(),
      translationLedger: [],
      coveringSuite: suite,
      coveringCaseId,
      playerFactionId: "adeptus-custodes",
      opponentFactionId: "world-eaters",
      playerRosterFingerprint: playerFingerprint,
      opponentRosterFingerprint: opponentFingerprint,
    });
  const local = build("local-engine");
  const website = build("website");

  assert.deepEqual(local.contractBinding, website.contractBinding);
  assert.deepEqual(local.combatStates, website.combatStates);
  assert.notEqual(
    local.providerStateEvidenceSha256,
    website.providerStateEvidenceSha256,
  );
  assert.match(local.evidenceSha256, /^[0-9a-f]{64}$/);
});

test("provider-parity report evidence rejects an unwitnessed roster mechanic", () => {
  const contract = selectedBaselineTesseraScenarioPolicyContractV3(
    10_000,
    {
      playerSelectionIds: ["player-selection"],
      opponentSelectionIds: ["opponent-selection"],
    },
    ["shooting"],
    ["mean-damage"],
  );
  const suite = buildTesseraParityCoveringSuiteV2({
    corpusInventorySha256: "9".repeat(64),
    factions: [
      {
        factionId: "adeptus-custodes",
        attackerMechanicIds: ["unseen-mechanic"],
        defenderMechanicIds: [],
      },
      {
        factionId: "world-eaters",
        attackerMechanicIds: [],
        defenderMechanicIds: [],
      },
    ],
  });
  assert.throws(
    () => buildTesseraProviderParityReportEvidenceV2({
      report: report("local-engine", contract),
      scenarioPolicyContractV3: contract,
      bridgeEvidence: bridgeEvidence(),
      bridge: bridge(),
      translationLedger: [],
      coveringSuite: suite,
      coveringCaseId: suite.cases[0].caseId,
      playerFactionId: "adeptus-custodes",
      opponentFactionId: "world-eaters",
      playerRosterFingerprint: playerFingerprint,
      opponentRosterFingerprint: opponentFingerprint,
    }),
    TesseraProviderParityReportEvidenceV2Error,
  );
});

test("provider parity and active coverage reject bridge mechanics omitted by the suite", () => {
  const contract = selectedBaselineTesseraScenarioPolicyContractV3(
    10_000,
    {
      playerSelectionIds: ["player-selection"],
      opponentSelectionIds: ["opponent-selection"],
    },
    ["shooting"],
    ["mean-damage"],
  );
  const suite = buildTesseraParityCoveringSuiteV2({
    corpusInventorySha256: inventorySha256,
    factions: [
      {
        factionId: "adeptus-custodes",
        attackerMechanicIds: [],
        defenderMechanicIds: [],
      },
      {
        factionId: "world-eaters",
        attackerMechanicIds: [],
        defenderMechanicIds: [],
      },
    ],
  });
  const exact = bridgeWithMechanic();

  assert.throws(
    () => assertCombatBridgeCoveredByTesseraParitySuiteV2({
      bridge: exact.bridge,
      translationLedger: exact.translationLedger,
      coveringSuite: suite,
    }),
    /outside the attested covering suite/,
  );
  assert.throws(
    () => buildTesseraProviderParityReportEvidenceV2({
      report: report("local-engine", contract),
      scenarioPolicyContractV3: contract,
      bridgeEvidence: bridgeEvidence(),
      bridge: exact.bridge,
      translationLedger: exact.translationLedger,
      coveringSuite: suite,
      coveringCaseId: suite.cases[0].caseId,
      playerFactionId: "adeptus-custodes",
      opponentFactionId: "world-eaters",
      playerRosterFingerprint: playerFingerprint,
      opponentRosterFingerprint: opponentFingerprint,
    }),
    /undeclared covering requirement/,
  );
  assert.throws(
    () => assertCombatBridgeCoveredByTesseraParitySuiteV2({
      bridge: exact.bridge,
      translationLedger: [],
      coveringSuite: suite,
    }),
    /no exact mechanic-bearing translation-ledger entry/,
  );
});
