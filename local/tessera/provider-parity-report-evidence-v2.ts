import type {
  TesseraCombatBridgeEvidenceV2,
  TesseraMatchupReport,
} from "../../lib/rosterpilot";
import type { CombatBridgeV3 } from "../../lib/rosterpilot/combat-bridge-v3";
import {
  tesseraScenarioPolicyContractV3ConclusionStatus,
  tesseraScenarioPolicyContractV3Sha256,
  type TesseraScenarioPolicyContractV3,
  type TesseraScenarioSide,
} from "./scenario-contract-v3";
import {
  tesseraScenarioV3CombatStateSha256,
} from "./scenario-v3-execution";
import {
  verifyTesseraParityCoveringSuiteV2,
  type TesseraParityFactionMechanicsV2,
  type TesseraParityCoveringSuiteV2,
} from "./provider-parity-covering-suite-v2";
import {
  sealTesseraProviderParityReportEvidenceV2,
  tesseraProviderParityCombatStateEvidenceSha256V2,
  tesseraProviderParityCoveringCaseEvidenceSha256V2,
  tesseraProviderParityProviderStateEvidenceSha256V2,
  type TesseraProviderParityCombatStateCellV2,
  type TesseraProviderParityCoverageWitnessV2,
  type TesseraProviderParityReportEvidenceV2,
} from "./provider-parity-workflow";
import type {
  CombatCorpusTranslationLedgerEntryV1,
} from "./combat-bridge-input-v3";

export class TesseraProviderParityReportEvidenceV2Error extends Error {
  readonly code = "TESSERA_PROVIDER_PARITY_REPORT_EVIDENCE_V2_INVALID";
}

function invalid(message: string): never {
  throw new TesseraProviderParityReportEvidenceV2Error(message);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function membersForSelection(input: {
  contract: TesseraScenarioPolicyContractV3;
  side: TesseraScenarioSide;
  selectionId: string;
}): string[] {
  const binding = input.contract.policy.attachments.bindings.find(
    (candidate) =>
      candidate.side === input.side &&
      candidate.bodyguardSelectionId === input.selectionId,
  );
  if (!binding) return [input.selectionId];
  return [
    binding.bodyguardSelectionId,
    binding.leaderSelectionId,
    ...binding.supportingSelectionIds,
  ];
}

function sideForDirection(
  direction: "player-to-opponent" | "opponent-to-player",
): { attacker: TesseraScenarioSide; target: TesseraScenarioSide } {
  return direction === "player-to-opponent"
    ? { attacker: "player", target: "opponent" }
    : { attacker: "opponent", target: "player" };
}

function caseMatches(input: {
  suite: TesseraParityCoveringSuiteV2;
  caseId: string;
  playerFactionId: string;
  opponentFactionId: string;
}): boolean {
  const selected = input.suite.cases.find(
    (candidate) => candidate.caseId === input.caseId,
  );
  if (!selected) return false;
  return (
    (selected.attackerFactionId === input.playerFactionId &&
      selected.defenderFactionId === input.opponentFactionId) ||
    (selected.attackerFactionId === input.opponentFactionId &&
      selected.defenderFactionId === input.playerFactionId)
  );
}

function relevantTranslationLedgerEntries(input: {
  bridge: CombatBridgeV3;
  translationLedger: readonly CombatCorpusTranslationLedgerEntryV1[];
}): CombatCorpusTranslationLedgerEntryV1[] {
  const byLeafId = new Map<string, CombatCorpusTranslationLedgerEntryV1>();
  for (const entry of input.translationLedger) {
    if (byLeafId.has(entry.leafId)) {
      return invalid(
        `The combat-corpus translation ledger repeats leaf ${entry.leafId}.`,
      );
    }
    byLeafId.set(entry.leafId, entry);
  }
  return input.bridge.exactness.corpus.relevantLeaves.map((leaf) => {
    const entry = byLeafId.get(leaf.leafId);
    if (
      !entry ||
      entry.sourceId !== leaf.sourceId ||
      entry.disposition !== leaf.disposition ||
      entry.mechanicIds.length === 0
    ) {
      return invalid(
        `Relevant bridge leaf ${leaf.leafId} has no exact mechanic-bearing translation-ledger entry.`,
      );
    }
    return entry;
  });
}

function coveringWitnesses(input: {
  bridge: CombatBridgeV3;
  translationLedger: readonly CombatCorpusTranslationLedgerEntryV1[];
  suite: TesseraParityCoveringSuiteV2;
  coveringCaseId: string;
}): TesseraProviderParityCoverageWitnessV2[] {
  const coveringCase = input.suite.cases.find(
    (candidate) => candidate.caseId === input.coveringCaseId,
  );
  if (!coveringCase) {
    return invalid("The selected covering case does not exist.");
  }
  const expected = new Map(
    coveringCase.coveredRequirementIds.map((requirementId) => [
      requirementId,
      new Set<string>(),
    ]),
  );
  for (const cell of input.bridge.cells) {
    for (const requirementId of [
      `role:attacker:${cell.attacker.factionId}`,
      `role:defender:${cell.target.factionId}`,
    ]) {
      if (!expected.has(requirementId)) {
        return invalid(
          `The exact bridge executes undeclared covering requirement ${requirementId}.`,
        );
      }
    }
  }
  const relevantEntries = relevantTranslationLedgerEntries(input);
  const cells = new Map(
    input.bridge.cells.map((cell) => [cell.cellId, cell]),
  );
  const bindingsBySource = new Map<string, typeof input.bridge.exactness.corpus.ruleBindings>();
  for (const binding of input.bridge.exactness.corpus.ruleBindings) {
    const retained = bindingsBySource.get(binding.corpusSourceId) ?? [];
    retained.push(binding);
    bindingsBySource.set(binding.corpusSourceId, retained);
  }
  for (const entry of relevantEntries) {
    for (const binding of bindingsBySource.get(entry.sourceId) ?? []) {
      const cell = cells.get(binding.cellId);
      if (!cell) {
        return invalid(
          `Bridge rule binding ${binding.cellId} has no executable cell.`,
        );
      }
      const role = binding.perspective === "attacker"
        ? "attacker"
        : "defender";
      const factionId = binding.perspective === "attacker"
        ? cell.attacker.factionId
        : cell.target.factionId;
      for (const mechanicId of entry.mechanicIds) {
        const requirementId =
          `mechanic:${role}:${factionId}:${mechanicId}`;
        const leaves = expected.get(requirementId);
        if (!leaves) {
          return invalid(
            `The exact bridge executes undeclared covering requirement ${requirementId}.`,
          );
        }
        leaves.add(entry.leafId);
      }
    }
  }
  for (const requirementId of expected.keys()) {
    if (!requirementId.startsWith("role:")) continue;
    const [, role, factionId] = requirementId.split(":");
    const witnessed = input.bridge.cells.some((cell) =>
      role === "attacker"
        ? cell.attacker.factionId === factionId
        : role === "defender" &&
          cell.target.factionId === factionId
    );
    if (!witnessed) {
      return invalid(
        `The exact bridge has no ${role} cell for ${factionId}.`,
      );
    }
  }
  const witnesses = [...expected.entries()].map(
    ([requirementId, leaves]) => ({
      requirementId,
      relevantLeafIds: [...leaves].sort(compare),
    }),
  ).sort((left, right) =>
    compare(left.requirementId, right.requirementId)
  );
  const missing = witnesses.filter(
    (witness) =>
      witness.requirementId.startsWith("mechanic:") &&
      witness.relevantLeafIds.length === 0,
  );
  if (missing.length > 0) {
    return invalid(
      `The exact roster/bridge does not exercise declared covering requirement(s): ${missing.map((entry) => entry.requirementId).join(", ")}.`,
    );
  }
  return witnesses;
}

/** Derives a suite-builder manifest from mechanics the exact bridge executes. */
export function deriveTesseraParityFactionMechanicsV2(input: {
  bridge: CombatBridgeV3;
  translationLedger: readonly CombatCorpusTranslationLedgerEntryV1[];
}): TesseraParityFactionMechanicsV2[] {
  const mechanics = new Map<
    string,
    { attacker: Set<string>; defender: Set<string> }
  >();
  for (const cell of input.bridge.cells) {
    for (const factionId of [
      cell.attacker.factionId,
      cell.target.factionId,
    ]) {
      if (!mechanics.has(factionId)) {
        mechanics.set(factionId, {
          attacker: new Set<string>(),
          defender: new Set<string>(),
        });
      }
    }
  }
  const relevantEntries = relevantTranslationLedgerEntries(input);
  const cells = new Map(
    input.bridge.cells.map((cell) => [cell.cellId, cell]),
  );
  const bindingsBySource = new Map<string, typeof input.bridge.exactness.corpus.ruleBindings>();
  for (const binding of input.bridge.exactness.corpus.ruleBindings) {
    const retained = bindingsBySource.get(binding.corpusSourceId) ?? [];
    retained.push(binding);
    bindingsBySource.set(binding.corpusSourceId, retained);
  }
  for (const entry of relevantEntries) {
    for (const binding of bindingsBySource.get(entry.sourceId) ?? []) {
      const cell = cells.get(binding.cellId);
      if (!cell) continue;
      const role = binding.perspective === "attacker"
        ? "attacker"
        : "defender";
      const factionId = binding.perspective === "attacker"
        ? cell.attacker.factionId
        : cell.target.factionId;
      const faction = mechanics.get(factionId);
      if (!faction) continue;
      for (const mechanicId of entry.mechanicIds) {
        faction[role].add(mechanicId);
      }
    }
  }
  return [...mechanics.entries()].map(([factionId, roles]) => ({
    factionId,
    attackerMechanicIds: [...roles.attacker].sort(compare),
    defenderMechanicIds: [...roles.defender].sort(compare),
  })).sort((left, right) => compare(left.factionId, right.factionId));
}

/**
 * Proves that a current exact bridge is inside an attested suite's declared
 * role/mechanic envelope. This is intentionally the reverse of witness
 * checking: a suite may not silently omit mechanics executed by a later
 * roster while retaining machine-local promotion.
 */
export function assertCombatBridgeCoveredByTesseraParitySuiteV2(input: {
  bridge: CombatBridgeV3;
  translationLedger: readonly CombatCorpusTranslationLedgerEntryV1[];
  coveringSuite: TesseraParityCoveringSuiteV2;
}): void {
  if (!verifyTesseraParityCoveringSuiteV2(input.coveringSuite)) {
    return invalid(
      "The personal parity covering suite is invalid or its hash is stale.",
    );
  }
  const declared = new Set(input.coveringSuite.requirements);
  const executed = new Set<string>();
  for (const cell of input.bridge.cells) {
    executed.add(`role:attacker:${cell.attacker.factionId}`);
    executed.add(`role:defender:${cell.target.factionId}`);
  }
  for (const faction of deriveTesseraParityFactionMechanicsV2({
    bridge: input.bridge,
    translationLedger: input.translationLedger,
  })) {
    for (const mechanicId of faction.attackerMechanicIds) {
      executed.add(
        `mechanic:attacker:${faction.factionId}:${mechanicId}`,
      );
    }
    for (const mechanicId of faction.defenderMechanicIds) {
      executed.add(
        `mechanic:defender:${faction.factionId}:${mechanicId}`,
      );
    }
  }
  const missing = [...executed].filter(
    (requirementId) => !declared.has(requirementId),
  ).sort(compare);
  if (missing.length > 0) {
    return invalid(
      `The exact bridge executes requirement(s) outside the attested covering suite: ${missing.join(", ")}.`,
    );
  }
}

function combatStates(input: {
  report: TesseraMatchupReport;
  contract: TesseraScenarioPolicyContractV3;
  scenarioPolicyContractV3Sha256: string;
}): TesseraProviderParityCombatStateCellV2[] {
  const result: TesseraProviderParityCombatStateCellV2[] = [];
  const scenarios = input.report.simulation.scenarios ?? [];
  if (scenarios.length === 0) {
    return invalid(
      "Provider-parity v2 requires a complete retained scenario inventory.",
    );
  }
  for (const scenario of scenarios) {
    if (scenario.status !== "complete") {
      return invalid(
        `Scenario ${scenario.scenarioId} is not complete.`,
      );
    }
    const sides = sideForDirection(scenario.direction);
    for (const metric of scenario.metrics) {
      const selectedState = input.contract.scenarios.find(
        (candidate) =>
          candidate.phase === scenario.phase &&
          candidate.direction === scenario.direction &&
          candidate.metric === metric,
      );
      if (!selectedState) {
        return invalid(
          `The v3 contract has no ${scenario.phase}/${scenario.direction}/${metric} state.`,
        );
      }
      for (const cell of scenario.cells) {
        const attackerSelectionId = cell.attacker.selectionId;
        const targetSelectionId = cell.target.selectionId;
        if (!attackerSelectionId || !targetSelectionId) {
          return invalid(
            `Scenario ${scenario.scenarioId} has a cell without exact roster selection identities.`,
          );
        }
        const combatStateSha256 =
          tesseraScenarioV3CombatStateSha256({
            scenario: selectedState,
            attackerSelectionIds: membersForSelection({
              contract: input.contract,
              side: sides.attacker,
              selectionId: attackerSelectionId,
            }),
            targetSelectionIds: membersForSelection({
              contract: input.contract,
              side: sides.target,
              selectionId: targetSelectionId,
            }),
          });
        const retainedConclusion =
          cell.combatEnvelope?.[metric]?.conclusionEligibility;
        if (
          retainedConclusion &&
          (retainedConclusion.scalarClaimsAllowed !== true ||
            retainedConclusion.mode !== "selected" ||
            retainedConclusion.scenarioPolicyContractV3Sha256 !==
              input.scenarioPolicyContractV3Sha256 ||
            retainedConclusion.combatStateSha256 !== combatStateSha256)
        ) {
          return invalid(
            `Scenario ${scenario.scenarioId} has local scalar provenance that disagrees with the provider-neutral physical state.`,
          );
        }
        result.push({
          scenarioId: scenario.scenarioId,
          attackerInstanceId: cell.attacker.instanceId,
          targetInstanceId: cell.target.instanceId,
          metric,
          combatStateSha256,
        });
      }
    }
  }
  return result.sort((left, right) =>
    compare(
      [
        left.scenarioId,
        left.metric,
        left.attackerInstanceId,
        left.targetInstanceId,
      ].join("\u0000"),
      [
        right.scenarioId,
        right.metric,
        right.attackerInstanceId,
        right.targetInstanceId,
      ].join("\u0000"),
    ),
  );
}

/**
 * Seals the exact parity-v2 evidence inside a finished provider report before
 * its exact receipt is created. Web and local reports intentionally use the
 * same offline bridge-v3 and selected physical-state identities.
 */
export function buildTesseraProviderParityReportEvidenceV2(input: {
  report: TesseraMatchupReport;
  scenarioPolicyContractV3: TesseraScenarioPolicyContractV3;
  bridgeEvidence: TesseraCombatBridgeEvidenceV2;
  bridge: CombatBridgeV3;
  translationLedger: readonly CombatCorpusTranslationLedgerEntryV1[];
  coveringSuite: TesseraParityCoveringSuiteV2;
  coveringCaseId: string;
  playerFactionId: string;
  opponentFactionId: string;
  playerRosterFingerprint: string;
  opponentRosterFingerprint: string;
}): TesseraProviderParityReportEvidenceV2 {
  if (
    !verifyTesseraParityCoveringSuiteV2(input.coveringSuite) ||
    !caseMatches({
      suite: input.coveringSuite,
      caseId: input.coveringCaseId,
      playerFactionId: input.playerFactionId,
      opponentFactionId: input.opponentFactionId,
    })
  ) {
    return invalid(
      "The provider-parity covering suite or selected faction case is invalid.",
    );
  }
  if (
    input.bridge.bridgeSha256 !==
      input.bridgeEvidence.combatBridgeV3Sha256 ||
    input.bridge.exactness.corpus.reportSha256 !==
      input.bridgeEvidence.corpusConformanceReportSha256 ||
    input.bridge.exactness.corpus.sourceInventorySha256 !==
      input.bridgeEvidence.corpusSourceInventorySha256
  ) {
    return invalid(
      "The full bridge v3 does not match its compact receipt evidence.",
    );
  }
  if (
    input.bridgeEvidence.coverage.status !== "complete" ||
    input.bridgeEvidence.coverage.claimEligibility !== "decision-grade"
  ) {
    return invalid(
      "Provider-parity v2 requires complete decision-grade bridge-v3 coverage.",
    );
  }
  const conclusion =
    tesseraScenarioPolicyContractV3ConclusionStatus(
      input.scenarioPolicyContractV3,
    );
  if (!conclusion.scalarClaimsAllowed) {
    return invalid(
      "Provider-parity v2 requires a fully selected physical-state contract.",
    );
  }
  if (
    input.report.status !== "complete" ||
    input.report.simulation.status !== "complete" ||
    input.report.opponents.length !== 1
  ) {
    return invalid(
      "Provider-parity v2 requires one complete provider report and one opponent.",
    );
  }
  const scenarioPolicyContractV3Sha256 =
    tesseraScenarioPolicyContractV3Sha256(
      input.scenarioPolicyContractV3,
    );
  if (
    input.report.scenarioPolicyContractV3Sha256 !==
      scenarioPolicyContractV3Sha256
  ) {
    return invalid(
      "The report does not retain the exact provider-parity scenario-v3 contract.",
    );
  }
  const states = combatStates({
    report: input.report,
    contract: input.scenarioPolicyContractV3,
    scenarioPolicyContractV3Sha256,
  });
  const coverageWitnesses = coveringWitnesses({
    bridge: input.bridge,
    translationLedger: input.translationLedger,
    suite: input.coveringSuite,
    coveringCaseId: input.coveringCaseId,
  });
  const contractBinding = {
    scenarioPolicyContractV3Sha256,
    combatBridgeV3Sha256:
      input.bridgeEvidence.combatBridgeV3Sha256,
    corpusConformanceReportSha256:
      input.bridgeEvidence.corpusConformanceReportSha256,
    coveringSuiteSha256: input.coveringSuite.suiteSha256,
    coveringCaseId: input.coveringCaseId,
    coveringCaseEvidenceSha256:
      tesseraProviderParityCoveringCaseEvidenceSha256V2({
        coveringCaseId: input.coveringCaseId,
        combatBridgeV3Sha256:
          input.bridgeEvidence.combatBridgeV3Sha256,
        corpusConformanceReportSha256:
          input.bridgeEvidence.corpusConformanceReportSha256,
        coverageWitnesses,
      }),
    combatStateSha256:
      tesseraProviderParityCombatStateEvidenceSha256V2(states),
    playerRosterFingerprint: input.playerRosterFingerprint,
    opponentRosterFingerprint: input.opponentRosterFingerprint,
  };
  return sealTesseraProviderParityReportEvidenceV2({
    schemaVersion: 2,
    kind: "rosterpilot-provider-parity-report-evidence",
    contractBinding,
    coveringSuite: input.coveringSuite,
    coverageWitnesses,
    combatStates: states,
    providerStateEvidenceSha256:
      tesseraProviderParityProviderStateEvidenceSha256V2(
        input.report,
      ),
  });
}
