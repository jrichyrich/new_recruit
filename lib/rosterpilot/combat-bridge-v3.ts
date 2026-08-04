import {
  COMBAT_BRIDGE_COMPILER_VERSION,
  COMBAT_EFFECT_VOCABULARY_VERSION,
  COMBAT_RULES_COMPILER,
  combatBridgeSha256,
  compileCombatBridgeV2,
  verifyCombatBridgeV2Hash,
  type BundleCombatRuleRecordV1,
  type CombatBridgeCellInputV2,
  type CombatBridgeDiagnosticV2,
  type CombatBridgeV2,
  type CombatBundleBindingV2,
  type CombatCellRuleVariantInputV2,
  type CombatPhaseV2,
  type CombatPolicyV1,
} from "./combat-bridge";
import {
  COMBAT_CORPUS_CONFORMANCE_REPORT_SCHEMA_VERSION,
  COMBAT_SEMANTICS_OVERLAY_SCHEMA_VERSION,
  evaluateCombatCorpusStrictAdmissionV1,
  type CombatCorpusConformanceReportV1,
  type CombatCorpusEffectFragmentV1,
  type CombatCorpusStrictAdmissionExpectationV1,
  type CombatLeafAccountingV1,
  type CombatSemanticsOverlayV1,
} from "./combat-corpus-conformance";
import { canonicalJson, sha256Hex } from "./semantic-hash";

export const COMBAT_BRIDGE_V3_SCHEMA_VERSION = 3 as const;
export const COMBAT_BRIDGE_V3_COMPILER_VERSION =
  "corpus-conformance-v3" as const;
export const COMBAT_BRIDGE_V3_HASH_CONTRACT_VERSION =
  "merkle-corpus-v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type BundleCombatRuleRecordV3 = BundleCombatRuleRecordV1 & {
  /** Exact source entry in the retained combat corpus inventory. */
  corpusSourceId: string;
};

export type CombatCellRuleVariantInputV3 = Omit<
  CombatCellRuleVariantInputV2,
  "attackerRules" | "targetRules"
> & {
  attackerRules: BundleCombatRuleRecordV3[];
  targetRules: BundleCombatRuleRecordV3[];
};

export type CombatBridgeCellInputV3 = Omit<
  CombatBridgeCellInputV2,
  "ruleVariants"
> & {
  ruleVariants: CombatCellRuleVariantInputV3[];
};

export type CombatBridgeV3ReplayBindings = {
  /** Canonical TesseraScenarioPolicyContractV3 digest, when retained. */
  scenarioContractV3Sha256?: string | null;
  /** Canonical serialized LocalTesseraEngineInputV2 digests, when retained. */
  localInputV2Sha256s?: {
    player: string;
    opponent: string;
  } | null;
};

export type CompileCombatBridgeInputV3 = {
  bundle: CombatBundleBindingV2;
  policy: CombatPolicyV1;
  cells: CombatBridgeCellInputV3[];
  corpus: {
    report: CombatCorpusConformanceReportV1;
    overlay: CombatSemanticsOverlayV1;
    expected: CombatCorpusStrictAdmissionExpectationV1;
  };
  replay?: CombatBridgeV3ReplayBindings;
};

export type CombatBridgeV3RuleBinding = {
  cellId: string;
  attachmentPlanId: string;
  perspective: "attacker" | "target";
  abilityId: string;
  corpusSourceId: string;
  entitySha256: string;
  effectSha256: string;
  ruleSourceSha256: string;
};

export type CombatBridgeV3RelevantLeafIndexEntry = {
  leafId: string;
  sourceId: string;
  disposition: "modeled" | "state-required";
  accountingSha256: string;
};

export type CombatBridgeV3ExactnessBinding = {
  status: "decision-grade";
  corpus: {
    reportSha256: string;
    sourceInventorySha256: string;
    overlaySha256: string;
    ruleBindings: CombatBridgeV3RuleBinding[];
    ruleBindingSha256: string;
    relevantLeaves: CombatBridgeV3RelevantLeafIndexEntry[];
    relevantLeafIndexSha256: string;
  };
  replay: {
    scenarioContractV3Sha256: string | null;
    localInputV2Sha256s: {
      player: string;
      opponent: string;
    } | null;
  };
  legacyBridgeV2Sha256: string;
};

export type CombatBridgeV3 = {
  schemaVersion: 3;
  kind: "rosterpilot-combat-bridge";
  compiler: {
    version: typeof COMBAT_BRIDGE_V3_COMPILER_VERSION;
    effectVocabularyVersion: typeof COMBAT_EFFECT_VOCABULARY_VERSION;
    hashContractVersion: typeof COMBAT_BRIDGE_V3_HASH_CONTRACT_VERSION;
    rulesCompiler: typeof COMBAT_RULES_COMPILER;
    cellCompiler: CombatBridgeV2["compiler"];
    corpusReportSchemaVersion:
      typeof COMBAT_CORPUS_CONFORMANCE_REPORT_SCHEMA_VERSION;
    semanticsOverlaySchemaVersion:
      typeof COMBAT_SEMANTICS_OVERLAY_SCHEMA_VERSION;
  };
  bundle: CombatBundleBindingV2;
  policy: CombatPolicyV1;
  policySha256: string;
  cells: CombatBridgeV2["cells"];
  coverage: CombatBridgeV2["coverage"];
  coverageUnit: "unique-mechanics-cell";
  diagnostics: CombatBridgeDiagnosticV2[];
  cellIndexSha256: string;
  exactness: CombatBridgeV3ExactnessBinding;
  bridgeSha256: string;
};

export type CombatBridgeV3AdmissionIssue = {
  code:
    | "COMBAT_BRIDGE_V3_CORPUS_ADMISSION_FAILED"
    | "COMBAT_BRIDGE_V3_BUNDLE_MISMATCH"
    | "COMBAT_BRIDGE_V3_REPLAY_BINDING_INVALID"
    | "COMBAT_BRIDGE_V3_RULE_SOURCE_UNBOUND"
    | "COMBAT_BRIDGE_V3_RULE_ENTITY_STALE"
    | "COMBAT_BRIDGE_V3_RULE_EFFECT_STALE"
    | "COMBAT_BRIDGE_V3_LEAF_APPROXIMATED"
    | "COMBAT_BRIDGE_V3_LEAF_OMITTED"
    | "COMBAT_BRIDGE_V3_COVERAGE_NONEXACT";
  cellId: string | null;
  abilityId: string | null;
  corpusSourceId: string | null;
  leafIds: string[];
  message: string;
};

export class CombatBridgeV3AdmissionError extends Error {
  readonly code = "COMBAT_BRIDGE_V3_ADMISSION_REQUIRED" as const;
  readonly issues: CombatBridgeV3AdmissionIssue[];

  constructor(issues: CombatBridgeV3AdmissionIssue[]) {
    super(
      issues[0]?.message ??
        "The exact combat bridge v3 admission contract was not satisfied.",
    );
    this.name = "CombatBridgeV3AdmissionError";
    this.issues = issues;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRuleBindings(
  left: CombatBridgeV3RuleBinding,
  right: CombatBridgeV3RuleBinding,
): number {
  return (
    compareStrings(left.cellId, right.cellId) ||
    compareStrings(left.attachmentPlanId, right.attachmentPlanId) ||
    compareStrings(left.perspective, right.perspective) ||
    compareStrings(left.abilityId, right.abilityId) ||
    compareStrings(left.corpusSourceId, right.corpusSourceId) ||
    compareStrings(left.entitySha256, right.entitySha256) ||
    compareStrings(left.effectSha256, right.effectSha256) ||
    compareStrings(left.ruleSourceSha256, right.ruleSourceSha256)
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function phaseEvidencePhases(
  account: CombatLeafAccountingV1,
): CombatPhaseV2[] {
  if (!("phases" in account.phaseEvidence)) return [];
  return account.phaseEvidence.phases.filter(
    (phase): phase is CombatPhaseV2 =>
      phase === "shooting" || phase === "fight",
  );
}

function isCombatDisposition(
  account: CombatLeafAccountingV1,
): account is CombatLeafAccountingV1 & {
  disposition: {
    kind: "modeled" | "state-required";
  };
} {
  return (
    account.disposition.kind === "modeled" ||
    account.disposition.kind === "state-required"
  );
}

function accountByLeaf(
  report: CombatCorpusConformanceReportV1,
): Map<string, CombatLeafAccountingV1> {
  return new Map(
    report.leafAccounting.map((account) => [account.leafId, account]),
  );
}

function leavesByFragment(
  report: CombatCorpusConformanceReportV1,
): Map<string, string[]> {
  const output = new Map<string, Set<string>>();
  for (const leaf of report.inventory.leaves) {
    for (const fragmentId of [
      ...leaf.ancestorFragmentIds,
      leaf.fragmentId,
    ]) {
      const leaves = output.get(fragmentId) ?? new Set<string>();
      leaves.add(leaf.leafId);
      output.set(fragmentId, leaves);
    }
  }
  return new Map(
    [...output.entries()].map(([fragmentId, leafIds]) => [
      fragmentId,
      [...leafIds].sort(compareStrings),
    ]),
  );
}

function sourceFragments(
  report: CombatCorpusConformanceReportV1,
  sourceId: string,
): CombatCorpusEffectFragmentV1[] {
  return report.inventory.fragments.filter(
    (fragment) => fragment.sourceId === sourceId,
  );
}

function sourceLeafAccounts(
  report: CombatCorpusConformanceReportV1,
  sourceId: string,
): CombatLeafAccountingV1[] {
  const accounts = accountByLeaf(report);
  return report.inventory.leaves.flatMap((leaf) => {
    if (leaf.sourceId !== sourceId) return [];
    const account = accounts.get(leaf.leafId);
    return account ? [account] : [];
  });
}

function corpusPhasesForSource(
  report: CombatCorpusConformanceReportV1,
  sourceId: string,
): CombatPhaseV2[] {
  return sortedUnique(
    sourceLeafAccounts(report, sourceId).flatMap(phaseEvidencePhases),
  ) as CombatPhaseV2[];
}

function corpusNonCombatFragmentHashes(
  report: CombatCorpusConformanceReportV1,
  sourceId: string,
): string[] {
  const accounts = accountByLeaf(report);
  const descendants = leavesByFragment(report);
  return sourceFragments(report, sourceId).flatMap((fragment) => {
    const leafIds = descendants.get(fragment.fragmentId) ?? [];
    return leafIds.length > 0 &&
      leafIds.every((leafId) => {
        const disposition = accounts.get(leafId)?.disposition.kind;
        return (
          disposition === "out-of-calculator-scope" ||
          disposition === "not-applicable"
        );
      })
      ? [fragment.fragmentSha256]
      : [];
  });
}

function exactRuleForV2(
  rule: BundleCombatRuleRecordV3,
  report: CombatCorpusConformanceReportV1,
): BundleCombatRuleRecordV1 {
  const sourceAccounts = sourceLeafAccounts(report, rule.corpusSourceId);
  const hasCombatLeaves = sourceAccounts.some(isCombatDisposition);
  const unsupportedFragmentRelevance = Object.fromEntries(
    corpusNonCombatFragmentHashes(report, rule.corpusSourceId).map(
      (fragmentSha256) => [fragmentSha256, "non-combat" as const],
    ),
  );
  return {
    abilityId: rule.abilityId,
    abilityName: rule.abilityName,
    entityHash: rule.entityHash,
    effect: rule.effect,
    source: rule.source,
    phases: corpusPhasesForSource(report, rule.corpusSourceId),
    phaseMappingStatus: "verified",
    activation: rule.activation,
    unsupportedRelevance: hasCombatLeaves ? "combat" : "non-combat",
    ...(Object.keys(unsupportedFragmentRelevance).length > 0
      ? { unsupportedFragmentRelevance }
      : {}),
  };
}

function inputV2FromV3(
  input: CompileCombatBridgeInputV3,
): {
  bundle: CombatBundleBindingV2;
  policy: CombatPolicyV1;
  cells: CombatBridgeCellInputV2[];
} {
  return {
    bundle: input.bundle,
    policy: input.policy,
    cells: input.cells.map((cell) => ({
      cellId: cell.cellId,
      direction: cell.direction,
      metric: cell.metric,
      attacker: cell.attacker,
      target: cell.target,
      scenario: cell.scenario,
      ruleVariants: cell.ruleVariants.map((variant) => ({
        attachmentPlan: variant.attachmentPlan,
        attackerRules: variant.attackerRules.map((rule) =>
          exactRuleForV2(rule, input.corpus.report),
        ),
        targetRules: variant.targetRules.map((rule) =>
          exactRuleForV2(rule, input.corpus.report),
        ),
      })),
    })),
  };
}

function normalizedReplayBindings(
  replay: CombatBridgeV3ReplayBindings | undefined,
): CombatBridgeV3ExactnessBinding["replay"] {
  return {
    scenarioContractV3Sha256:
      replay?.scenarioContractV3Sha256 ?? null,
    localInputV2Sha256s: replay?.localInputV2Sha256s ?? null,
  };
}

function replayBindingIssues(
  replay: CombatBridgeV3ReplayBindings | undefined,
): CombatBridgeV3AdmissionIssue[] {
  const normalized = normalizedReplayBindings(replay);
  const digests = [
    ...(normalized.scenarioContractV3Sha256
      ? [normalized.scenarioContractV3Sha256]
      : []),
    ...(normalized.localInputV2Sha256s
      ? [
          normalized.localInputV2Sha256s.player,
          normalized.localInputV2Sha256s.opponent,
        ]
      : []),
  ];
  return digests.every((digest) => SHA256_PATTERN.test(digest))
    ? []
    : [
        {
          code: "COMBAT_BRIDGE_V3_REPLAY_BINDING_INVALID",
          cellId: null,
          abilityId: null,
          corpusSourceId: null,
          leafIds: [],
          message:
            "Scenario-v3 and local-input-v2 replay bindings must be lowercase SHA-256 digests.",
        },
      ];
}

async function corpusAdmissionIssues(
  input: CompileCombatBridgeInputV3,
): Promise<CombatBridgeV3AdmissionIssue[]> {
  let admission: Awaited<
    ReturnType<typeof evaluateCombatCorpusStrictAdmissionV1>
  >;
  try {
    admission = await evaluateCombatCorpusStrictAdmissionV1({
      report: input.corpus.report,
      overlay: input.corpus.overlay,
      expected: input.corpus.expected,
    });
  } catch (error) {
    return [
      {
        code: "COMBAT_BRIDGE_V3_CORPUS_ADMISSION_FAILED",
        cellId: null,
        abilityId: null,
        corpusSourceId: null,
        leafIds: [],
        message: `The combat corpus admission contract is malformed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  return admission.admitted
    ? []
    : [
        {
          code: "COMBAT_BRIDGE_V3_CORPUS_ADMISSION_FAILED",
          cellId: null,
          abilityId: null,
          corpusSourceId: null,
          leafIds: [],
          message: `The combat corpus is not strictly admissible: ${admission.issues
            .map((issue) => issue.code)
            .join(", ")}.`,
        },
      ];
}

async function ruleBindingResult(
  input: CompileCombatBridgeInputV3,
): Promise<{
  bindings: CombatBridgeV3RuleBinding[];
  issues: CombatBridgeV3AdmissionIssue[];
}> {
  const sources = new Map(
    input.corpus.report.inventory.sources.map((source) => [
      source.sourceId,
      source,
    ]),
  );
  const bindings: CombatBridgeV3RuleBinding[] = [];
  const issues: CombatBridgeV3AdmissionIssue[] = [];
  for (const cell of input.cells) {
    for (const variant of cell.ruleVariants) {
      for (const [perspective, rules] of [
        ["attacker", variant.attackerRules],
        ["target", variant.targetRules],
      ] as const) {
        for (const rule of rules) {
          const source = sources.get(rule.corpusSourceId);
          const effectSha256 = await sha256Hex(canonicalJson(rule.effect));
          if (!source) {
            issues.push({
              code: "COMBAT_BRIDGE_V3_RULE_SOURCE_UNBOUND",
              cellId: cell.cellId,
              abilityId: rule.abilityId,
              corpusSourceId: rule.corpusSourceId || null,
              leafIds: [],
              message: `Rule ${JSON.stringify(rule.abilityId)} does not bind a current corpus source.`,
            });
            continue;
          }
          if (rule.entityHash !== source.entitySha256) {
            issues.push({
              code: "COMBAT_BRIDGE_V3_RULE_ENTITY_STALE",
              cellId: cell.cellId,
              abilityId: rule.abilityId,
              corpusSourceId: rule.corpusSourceId,
              leafIds: [],
              message: `Rule ${JSON.stringify(rule.abilityId)} is bound to a stale corpus entity digest.`,
            });
          }
          if (effectSha256 !== source.effectSha256) {
            issues.push({
              code: "COMBAT_BRIDGE_V3_RULE_EFFECT_STALE",
              cellId: cell.cellId,
              abilityId: rule.abilityId,
              corpusSourceId: rule.corpusSourceId,
              leafIds: [],
              message: `Rule ${JSON.stringify(rule.abilityId)} is bound to a stale corpus effect digest.`,
            });
          }
          bindings.push({
            cellId: cell.cellId,
            attachmentPlanId: variant.attachmentPlan.id,
            perspective,
            abilityId: rule.abilityId,
            corpusSourceId: rule.corpusSourceId,
            entitySha256: rule.entityHash,
            effectSha256,
            ruleSourceSha256: await sha256Hex(canonicalJson(rule.source)),
          });
        }
      }
    }
  }
  const unique = new Map(
    bindings.map((binding) => [canonicalJson(binding), binding]),
  );
  return {
    bindings: [...unique.values()].sort(compareRuleBindings),
    issues,
  };
}

function relevantLeafIdsForSourcePhase(
  report: CombatCorpusConformanceReportV1,
  sourceId: string,
  phase: CombatPhaseV2,
): string[] {
  const accounts = accountByLeaf(report);
  return report.inventory.leaves.flatMap((leaf) => {
    if (leaf.sourceId !== sourceId) return [];
    const account = accounts.get(leaf.leafId);
    return account &&
      isCombatDisposition(account) &&
      phaseEvidencePhases(account).includes(phase)
      ? [leaf.leafId]
      : [];
  });
}

function relevantLeafIdsForInput(
  input: CompileCombatBridgeInputV3,
): string[] {
  const relevant = new Set<string>();
  for (const cell of input.cells) {
    for (const variant of cell.ruleVariants) {
      for (const rule of [
        ...variant.attackerRules,
        ...variant.targetRules,
      ]) {
        for (const leafId of relevantLeafIdsForSourcePhase(
          input.corpus.report,
          rule.corpusSourceId,
          cell.scenario.phase,
        )) {
          relevant.add(leafId);
        }
      }
    }
  }
  return [...relevant].sort(compareStrings);
}

async function relevantLeafIndex(
  report: CombatCorpusConformanceReportV1,
  leafIds: readonly string[],
): Promise<CombatBridgeV3RelevantLeafIndexEntry[]> {
  const accounts = accountByLeaf(report);
  const leaves = new Map(
    report.inventory.leaves.map((leaf) => [leaf.leafId, leaf]),
  );
  return Promise.all(
    leafIds.map(async (leafId) => {
      const account = accounts.get(leafId);
      const leaf = leaves.get(leafId);
      if (!account || !leaf || !isCombatDisposition(account)) {
        throw new CombatBridgeV3AdmissionError([
          {
            code: "COMBAT_BRIDGE_V3_CORPUS_ADMISSION_FAILED",
            cellId: null,
            abilityId: null,
            corpusSourceId: leaf?.sourceId ?? null,
            leafIds: [leafId],
            message:
              "A bridge-relevant leaf has no exact corpus disposition account.",
          },
        ]);
      }
      return {
        leafId,
        sourceId: leaf.sourceId,
        disposition: account.disposition.kind,
        accountingSha256: await sha256Hex(canonicalJson(account)),
      };
    }),
  );
}

function fragmentsByHashForSource(
  report: CombatCorpusConformanceReportV1,
  sourceId: string,
  fragmentSha256: string,
): CombatCorpusEffectFragmentV1[] {
  return report.inventory.fragments.filter(
    (fragment) =>
      fragment.sourceId === sourceId &&
      fragment.fragmentSha256 === fragmentSha256,
  );
}

function relevantLeavesImpactedByEffect(input: {
  report: CombatCorpusConformanceReportV1;
  sourceId: string;
  phase: CombatPhaseV2;
  fragmentSha256: string;
}): string[] {
  const phaseRelevant = new Set(
    relevantLeafIdsForSourcePhase(
      input.report,
      input.sourceId,
      input.phase,
    ),
  );
  if (phaseRelevant.size === 0) return [];
  const descendants = leavesByFragment(input.report);
  const matchingFragments = fragmentsByHashForSource(
    input.report,
    input.sourceId,
    input.fragmentSha256,
  );
  if (matchingFragments.length === 0) {
    // Mapped buffs retain a contribution digest rather than a source-fragment
    // digest. In that case, conservatively bind the non-exact result to every
    // phase-relevant leaf from the same exact source.
    return [...phaseRelevant].sort(compareStrings);
  }
  return sortedUnique(
    matchingFragments.flatMap((fragment) =>
      (descendants.get(fragment.fragmentId) ?? []).filter((leafId) =>
        phaseRelevant.has(leafId),
      ),
    ),
  );
}

async function nonExactCompilationIssues(input: {
  source: CompileCombatBridgeInputV3;
  bridge: CombatBridgeV2;
  ruleBindings: readonly CombatBridgeV3RuleBinding[];
}): Promise<CombatBridgeV3AdmissionIssue[]> {
  const bindings = new Map<string, Set<string>>();
  for (const binding of input.ruleBindings) {
    const key = canonicalJson({
      cellId: binding.cellId,
      abilityId: binding.abilityId,
      entitySha256: binding.entitySha256,
      effectSha256: binding.effectSha256,
      ruleSourceSha256: binding.ruleSourceSha256,
    });
    const sourceIds = bindings.get(key) ?? new Set<string>();
    sourceIds.add(binding.corpusSourceId);
    bindings.set(key, sourceIds);
  }

  const issues: CombatBridgeV3AdmissionIssue[] = [];
  const issueKeys = new Set<string>();
  for (const cell of input.bridge.cells) {
    for (const variant of cell.variants) {
      for (const effect of variant.effects) {
        if (
          effect.status !== "approximated" &&
          effect.status !== "omitted"
        ) {
          continue;
        }
        const key = canonicalJson({
          cellId: cell.cellId,
          abilityId: effect.provenance.abilityId,
          entitySha256: effect.provenance.entityHash,
          effectSha256: effect.provenance.ruleEffectSha256,
          ruleSourceSha256: await sha256Hex(
            canonicalJson(effect.provenance.source),
          ),
        });
        const sourceIds = [...(bindings.get(key) ?? [])];
        for (const sourceId of sourceIds) {
          const leafIds = relevantLeavesImpactedByEffect({
            report: input.source.corpus.report,
            sourceId,
            phase: cell.scenario.phase,
            fragmentSha256: effect.provenance.fragmentSha256,
          });
          if (leafIds.length === 0) continue;
          const issueKey = canonicalJson({
            cellId: cell.cellId,
            abilityId: effect.provenance.abilityId,
            sourceId,
            status: effect.status,
            leafIds,
          });
          if (issueKeys.has(issueKey)) continue;
          issueKeys.add(issueKey);
          issues.push({
            code:
              effect.status === "approximated"
                ? "COMBAT_BRIDGE_V3_LEAF_APPROXIMATED"
                : "COMBAT_BRIDGE_V3_LEAF_OMITTED",
            cellId: cell.cellId,
            abilityId: effect.provenance.abilityId,
            corpusSourceId: sourceId,
            leafIds,
            message: `Exact bridge v3 cannot admit a ${effect.status} result for ${leafIds.length} combat-relevant corpus leaf${leafIds.length === 1 ? "" : "s"}.`,
          });
        }
      }
    }
  }
  if (
    input.bridge.coverage.status !== "complete" ||
    input.bridge.coverage.claimEligibility !== "decision-grade" ||
    input.bridge.coverage.approximatedEffects !== 0 ||
    input.bridge.coverage.omittedEffects !== 0
  ) {
    issues.push({
      code: "COMBAT_BRIDGE_V3_COVERAGE_NONEXACT",
      cellId: null,
      abilityId: null,
      corpusSourceId: null,
      leafIds: [],
      message:
        "Exact bridge v3 requires complete, decision-grade v2 cell compilation with no approximated or omitted effects.",
    });
  }
  return issues;
}

type CombatBridgeV3HashFields = Omit<CombatBridgeV3, "bridgeSha256">;

export async function combatBridgeV3Sha256(
  bridge: CombatBridgeV3HashFields,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      hashContractVersion: COMBAT_BRIDGE_V3_HASH_CONTRACT_VERSION,
      schemaVersion: bridge.schemaVersion,
      kind: bridge.kind,
      compiler: bridge.compiler,
      bundle: bridge.bundle,
      policySha256: bridge.policySha256,
      cellCount: bridge.cells.length,
      cellIndexSha256: bridge.cellIndexSha256,
      coverage: bridge.coverage,
      coverageUnit: bridge.coverageUnit,
      diagnostics: bridge.diagnostics,
      exactness: bridge.exactness,
    }),
  );
}

export async function compileCombatBridgeV3(
  input: CompileCombatBridgeInputV3,
): Promise<CombatBridgeV3> {
  const preflightIssues = [
    ...(await corpusAdmissionIssues(input)),
    ...replayBindingIssues(input.replay),
  ];
  if (
    input.bundle.bundleId !== input.corpus.report.inventory.bundle.bundleId ||
    input.bundle.engineDataSchemaVersion !==
      input.corpus.report.inventory.bundle.engineDataSchemaVersion
  ) {
    preflightIssues.push({
      code: "COMBAT_BRIDGE_V3_BUNDLE_MISMATCH",
      cellId: null,
      abilityId: null,
      corpusSourceId: null,
      leafIds: [],
      message:
        "The combat bridge bundle does not match the admitted corpus inventory bundle.",
    });
  }
  if (preflightIssues.length > 0) {
    throw new CombatBridgeV3AdmissionError(preflightIssues);
  }

  const ruleBinding = await ruleBindingResult(input);
  if (ruleBinding.issues.length > 0) {
    throw new CombatBridgeV3AdmissionError(ruleBinding.issues);
  }

  const bridgeV2 = await compileCombatBridgeV2(inputV2FromV3(input));
  const postflightIssues = await nonExactCompilationIssues({
    source: input,
    bridge: bridgeV2,
    ruleBindings: ruleBinding.bindings,
  });
  if (postflightIssues.length > 0) {
    throw new CombatBridgeV3AdmissionError(postflightIssues);
  }

  const relevantLeafIds = relevantLeafIdsForInput(input);
  const relevantLeaves = await relevantLeafIndex(
    input.corpus.report,
    relevantLeafIds,
  );
  const ruleBindingSha256 = await sha256Hex(
    canonicalJson(ruleBinding.bindings),
  );
  const relevantLeafIndexSha256 = await sha256Hex(
    canonicalJson(relevantLeaves),
  );
  const exactness: CombatBridgeV3ExactnessBinding = {
    status: "decision-grade",
    corpus: {
      reportSha256: input.corpus.report.reportSha256,
      sourceInventorySha256:
        input.corpus.report.inventory.inventorySha256,
      overlaySha256: input.corpus.overlay.overlaySha256,
      ruleBindings: ruleBinding.bindings,
      ruleBindingSha256,
      relevantLeaves,
      relevantLeafIndexSha256,
    },
    replay: normalizedReplayBindings(input.replay),
    legacyBridgeV2Sha256: bridgeV2.bridgeSha256,
  };
  const bridgeCore: CombatBridgeV3HashFields = {
    schemaVersion: COMBAT_BRIDGE_V3_SCHEMA_VERSION,
    kind: "rosterpilot-combat-bridge",
    compiler: {
      version: COMBAT_BRIDGE_V3_COMPILER_VERSION,
      effectVocabularyVersion: COMBAT_EFFECT_VOCABULARY_VERSION,
      hashContractVersion: COMBAT_BRIDGE_V3_HASH_CONTRACT_VERSION,
      rulesCompiler: COMBAT_RULES_COMPILER,
      cellCompiler: bridgeV2.compiler,
      corpusReportSchemaVersion:
        COMBAT_CORPUS_CONFORMANCE_REPORT_SCHEMA_VERSION,
      semanticsOverlaySchemaVersion:
        COMBAT_SEMANTICS_OVERLAY_SCHEMA_VERSION,
    },
    bundle: bridgeV2.bundle,
    policy: bridgeV2.policy,
    policySha256: bridgeV2.policySha256,
    cells: bridgeV2.cells,
    coverage: bridgeV2.coverage,
    coverageUnit: bridgeV2.coverageUnit,
    diagnostics: bridgeV2.diagnostics,
    cellIndexSha256: bridgeV2.cellIndexSha256,
    exactness,
  };
  return {
    ...bridgeCore,
    bridgeSha256: await combatBridgeV3Sha256(bridgeCore),
  };
}

export async function verifyCombatBridgeV3Hash(
  bridge: CombatBridgeV3,
): Promise<boolean> {
  if (
    bridge.schemaVersion !== COMBAT_BRIDGE_V3_SCHEMA_VERSION ||
    bridge.kind !== "rosterpilot-combat-bridge" ||
    bridge.compiler.version !== COMBAT_BRIDGE_V3_COMPILER_VERSION ||
    bridge.compiler.effectVocabularyVersion !==
      COMBAT_EFFECT_VOCABULARY_VERSION ||
    bridge.compiler.hashContractVersion !==
      COMBAT_BRIDGE_V3_HASH_CONTRACT_VERSION ||
    bridge.compiler.rulesCompiler !== COMBAT_RULES_COMPILER ||
    bridge.compiler.cellCompiler.version !==
      COMBAT_BRIDGE_COMPILER_VERSION ||
    bridge.compiler.corpusReportSchemaVersion !==
      COMBAT_CORPUS_CONFORMANCE_REPORT_SCHEMA_VERSION ||
    bridge.compiler.semanticsOverlaySchemaVersion !==
      COMBAT_SEMANTICS_OVERLAY_SCHEMA_VERSION ||
    bridge.exactness.status !== "decision-grade" ||
    bridge.coverageUnit !== "unique-mechanics-cell" ||
    bridge.coverage.status !== "complete" ||
    bridge.coverage.claimEligibility !== "decision-grade" ||
    bridge.coverage.approximatedEffects !== 0 ||
    bridge.coverage.omittedEffects !== 0 ||
    await sha256Hex(canonicalJson(bridge.policy)) !== bridge.policySha256 ||
    bridge.exactness.corpus.ruleBindingSha256 !==
      await sha256Hex(
        canonicalJson(bridge.exactness.corpus.ruleBindings),
      ) ||
    bridge.exactness.corpus.relevantLeafIndexSha256 !==
      await sha256Hex(
        canonicalJson(bridge.exactness.corpus.relevantLeaves),
      )
  ) {
    return false;
  }
  const exactnessDigests = [
    bridge.bridgeSha256,
    bridge.policySha256,
    bridge.cellIndexSha256,
    bridge.exactness.legacyBridgeV2Sha256,
    bridge.exactness.corpus.reportSha256,
    bridge.exactness.corpus.sourceInventorySha256,
    bridge.exactness.corpus.overlaySha256,
    bridge.exactness.corpus.ruleBindingSha256,
    bridge.exactness.corpus.relevantLeafIndexSha256,
    ...bridge.exactness.corpus.ruleBindings.flatMap((binding) => [
      binding.entitySha256,
      binding.effectSha256,
      binding.ruleSourceSha256,
    ]),
    ...bridge.exactness.corpus.relevantLeaves.flatMap((entry) => [
      entry.leafId,
      entry.accountingSha256,
    ]),
  ];
  if (
    exactnessDigests.some((digest) => !SHA256_PATTERN.test(digest)) ||
    bridge.exactness.corpus.ruleBindings.some(
      (binding) =>
        !binding.cellId ||
        !binding.attachmentPlanId ||
        !binding.abilityId ||
        !binding.corpusSourceId,
    ) ||
    bridge.exactness.corpus.relevantLeaves.some(
      (entry) => !entry.sourceId,
    )
  ) {
    return false;
  }
  if (
    bridge.exactness.corpus.ruleBindings.some(
      (binding, index, bindings) =>
        index > 0 &&
        compareRuleBindings(bindings[index - 1], binding) >= 0,
    ) ||
    bridge.exactness.corpus.relevantLeaves.some(
      (entry, index, entries) =>
        index > 0 && entries[index - 1].leafId >= entry.leafId,
    )
  ) {
    return false;
  }
  const replayDigests = [
    ...(bridge.exactness.replay.scenarioContractV3Sha256
      ? [bridge.exactness.replay.scenarioContractV3Sha256]
      : []),
    ...(bridge.exactness.replay.localInputV2Sha256s
      ? [
          bridge.exactness.replay.localInputV2Sha256s.player,
          bridge.exactness.replay.localInputV2Sha256s.opponent,
        ]
      : []),
  ];
  if (replayDigests.some((digest) => !SHA256_PATTERN.test(digest))) {
    return false;
  }

  const legacyBridge: CombatBridgeV2 = {
    schemaVersion: 2,
    kind: bridge.kind,
    compiler: bridge.compiler.cellCompiler,
    bundle: bridge.bundle,
    policy: bridge.policy,
    policySha256: bridge.policySha256,
    cells: bridge.cells,
    coverage: bridge.coverage,
    coverageUnit: bridge.coverageUnit,
    diagnostics: bridge.diagnostics,
    cellIndexSha256: bridge.cellIndexSha256,
    bridgeSha256: bridge.exactness.legacyBridgeV2Sha256,
  };
  if (
    !(await verifyCombatBridgeV2Hash(legacyBridge)) ||
    legacyBridge.bridgeSha256 !==
      await combatBridgeSha256({
        ...legacyBridge,
        cellIndexSha256: legacyBridge.cellIndexSha256,
      })
  ) {
    return false;
  }
  const { bridgeSha256, ...core } = bridge;
  return bridgeSha256 === await combatBridgeV3Sha256(core);
}
