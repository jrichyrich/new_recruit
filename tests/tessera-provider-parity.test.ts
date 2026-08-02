import assert from "node:assert/strict";
import test from "node:test";

import type { TesseraMetric } from "../lib/rosterpilot/types";
import {
  adaptCanonicalTesseraProviderParityWinner,
  compareTesseraProviderParityCombatSnapshots,
  compareTesseraProviderParity,
  TESSERA_PROVIDER_PARITY_CANONICAL_WINNER_ID,
  TESSERA_PROVIDER_PARITY_POLICY,
  tesseraProviderParityCombatSnapshotSha256,
  tesseraProviderParityContractSha256,
  tesseraProviderParityModelCapabilityEnvelopeSha256,
  tesseraProviderParityTolerance,
  type TesseraParityProvider,
  type TesseraProviderParityCell,
  type TesseraProviderParityModelCapabilityEnvelope,
  type TesseraProviderParityNormalizedCombatSnapshot,
  type TesseraProviderParityRun,
  type TesseraProviderParityScenarioContract,
  type TesseraProviderParityWinnerClassification,
} from "../local/tessera/provider-parity";
import {
  providerParityModelCapabilityFixture,
  providerParityNamedCombatSnapshotFixture,
} from "./fixtures/tessera-provider-parity-combat";

const NORMALIZED_INPUT_SHA256 = "a".repeat(64);
const PROFILE_POLICY_HASH = "profile-policy-v1";

function scenarioContract(
  metric: TesseraMetric,
  scenarioId = `shooting:player-to-opponent:${metric}`,
): TesseraProviderParityScenarioContract {
  return {
    scenarioId,
    phase: "shooting",
    direction: "player-to-opponent",
    metric,
    settings: {
      iterations: "10000",
      rules: "matched-play",
    },
    iterations: 10_000,
  };
}

function cell(
  contract: TesseraProviderParityScenarioContract,
  index: number,
  value: number,
  standardError: number | null = null,
): TesseraProviderParityCell {
  return {
    scenarioId: contract.scenarioId,
    attackerInstanceId: `attacker-${index}`,
    targetInstanceId: `target-${index}`,
    metric: contract.metric,
    value,
    iterations: contract.iterations,
    ...(contract.metric === "mean-kills" || contract.metric === "mean-damage"
      ? { standardError }
      : {}),
  };
}

function genericCombatSnapshot(
  contract: TesseraProviderParityScenarioContract[],
  cells: TesseraProviderParityCell[],
): TesseraProviderParityNormalizedCombatSnapshot {
  const contracts = new Map(
    contract.map((entry) => [
      `${entry.scenarioId}\u0000${entry.metric}`,
      entry,
    ]),
  );
  const sides = new Map<string, "player" | "opponent">();
  for (const entry of cells) {
    const scenario = contracts.get(`${entry.scenarioId}\u0000${entry.metric}`);
    const attackerSide =
      scenario?.direction === "opponent-to-player" ? "opponent" : "player";
    const targetSide = attackerSide === "player" ? "opponent" : "player";
    sides.set(entry.attackerInstanceId, attackerSide);
    sides.set(entry.targetInstanceId, targetSide);
  }
  return {
    schemaVersion: 1,
    kind: "tessera-provider-neutral-combat-snapshot",
    units: Array.from(sides, ([instanceId, side]) => ({
      instanceId,
      side,
      normalizedName: instanceId,
      modelCount: 1,
      points: 100,
      defense: {
        toughness: 4,
        save: 3,
        woundsPerModel: 2,
        invulnerableSave: { shooting: null, fight: null },
      },
      attackProfiles: [
        {
          profileId: `${instanceId}-profile`,
          name: "Fixture weapon",
          phase: "shooting" as const,
          equippedModelCount: 1,
          attacks: "1",
          skill: 3,
          strength: 4,
          armorPenetration: 0,
          damage: "1",
          keywords: [],
        },
      ],
      modeledEffects: [],
      omittedEffects: [],
      evidence: {
        status: "complete" as const,
        sourceRefs: [`fixture:${instanceId}`],
        warningCodes: [],
      },
    })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
  };
}

function parityRun(options: {
  provider: TesseraParityProvider;
  contract: TesseraProviderParityScenarioContract[];
  cells: TesseraProviderParityCell[];
  winners?: TesseraProviderParityWinnerClassification[];
  dataBundleId?: string;
  inputSha256?: string;
  profilePolicyHash?: string | null;
  contractSha256?: string;
  modelCapabilityEnvelope?: TesseraProviderParityModelCapabilityEnvelope;
  combatSnapshot?: TesseraProviderParityNormalizedCombatSnapshot;
  includeSemanticEvidence?: boolean;
}): TesseraProviderParityRun {
  const includeSemanticEvidence = options.includeSemanticEvidence ?? true;
  const modelCapabilityEnvelope =
    options.modelCapabilityEnvelope ?? providerParityModelCapabilityFixture();
  const combatSnapshot =
    options.combatSnapshot ?? genericCombatSnapshot(options.contract, options.cells);
  return {
    identity: {
      provider: options.provider,
      providerIdentity:
        options.provider === "local-engine"
          ? "commit:16ab4365"
          : "tessera-ui:fixture",
      dataBundleId: options.dataBundleId ?? "bundle-verified-fixture",
      normalizedInputSha256:
        options.inputSha256 ?? NORMALIZED_INPUT_SHA256,
      scenarioContractSha256:
        options.contractSha256 ??
        tesseraProviderParityContractSha256(options.contract),
      profilePolicyHash: options.profilePolicyHash ?? PROFILE_POLICY_HASH,
      ...(includeSemanticEvidence
        ? {
            modelCapabilityEnvelopeSha256:
              tesseraProviderParityModelCapabilityEnvelopeSha256(
                modelCapabilityEnvelope,
              ),
            combatSnapshotSha256:
              tesseraProviderParityCombatSnapshotSha256(combatSnapshot),
          }
        : {}),
    },
    ...(includeSemanticEvidence
      ? { modelCapabilityEnvelope, combatSnapshot }
      : {}),
    scenarioContract: options.contract,
    cells: options.cells,
    winnerClassifications: options.winners ?? [],
  };
}

function pair(options: {
  contract: TesseraProviderParityScenarioContract[];
  localCells: TesseraProviderParityCell[];
  websiteCells: TesseraProviderParityCell[];
  localWinners?: TesseraProviderParityWinnerClassification[];
  websiteWinners?: TesseraProviderParityWinnerClassification[];
}): [TesseraProviderParityRun, TesseraProviderParityRun] {
  const sharedSnapshot = genericCombatSnapshot(options.contract, [
    ...options.localCells,
    ...options.websiteCells,
  ]);
  return [
    parityRun({
      provider: "local-engine",
      contract: options.contract,
      cells: options.localCells,
      winners: options.localWinners,
      combatSnapshot: sharedSnapshot,
    }),
    parityRun({
      provider: "website",
      contract: options.contract,
      cells: options.websiteCells,
      winners: options.websiteWinners,
      combatSnapshot: sharedSnapshot,
    }),
  ];
}

test("provider parity passes complete deterministic evidence for all metrics", () => {
  const contracts = [
    scenarioContract("wipe-probability"),
    scenarioContract("half-wipe-probability"),
    scenarioContract("mean-kills"),
    scenarioContract("mean-damage"),
  ];
  const localCells = [
    cell(contracts[0], 0, 0.51),
    cell(contracts[1], 0, 0.72),
    cell(contracts[2], 0, 3.2, 0.02),
    cell(contracts[3], 0, 7.4, 0.04),
  ];
  const websiteCells = [
    cell(contracts[0], 0, 0.505),
    cell(contracts[1], 0, 0.715),
    cell(contracts[2], 0, 3.24, 0.025),
    cell(contracts[3], 0, 7.5, 0.045),
  ];
  const winners = [
    {
      classificationId: "aggregate-player-pressure",
      winner: "player" as const,
      withinUncertainty: false,
    },
  ];

  const result = compareTesseraProviderParity(
    ...pair({
      contract: contracts,
      localCells,
      websiteCells,
      localWinners: winners,
      websiteWinners: winners,
    }),
  );

  assert.equal(result.outcome, "pass");
  assert.equal(result.eligible, true);
  assert.equal(result.complete, true);
  assert.equal(result.metricSummaries.length, 4);
  assert.ok(result.metricSummaries.every((summary) => summary.status === "pass"));
  assert.ok(result.cells.every((entry) => entry.status === "pass"));
  assert.deepEqual(result.issues, []);
});

test("probability tolerance uses pooled binomial standard error and floors", () => {
  const result = tesseraProviderParityTolerance(
    "wipe-probability",
    0.5,
    0.5,
    10_000,
    10_000,
  );
  assert.ok(result);
  const expectedStandardError = Math.sqrt(0.5 * 0.5 * (1 / 10_000 + 1 / 10_000));
  assert.equal(result.pooledStandardError, expectedStandardError);
  assert.equal(
    result.monteCarloComponent,
    4 * expectedStandardError + 0.005,
  );
  assert.equal(result.value, result.monteCarloComponent);

  const floor = tesseraProviderParityTolerance(
    "half-wipe-probability",
    0,
    0,
    100_000,
    100_000,
  );
  assert.equal(floor?.value, 0.02);
});

test("mean tolerances use combined standard error, relative scale, and metric floors", () => {
  const monteCarlo = tesseraProviderParityTolerance(
    "mean-kills",
    3,
    3.1,
    10_000,
    10_000,
    0.03,
    0.04,
  );
  assert.ok(monteCarlo);
  assert.equal(monteCarlo.pooledStandardError, 0.05);
  assert.equal(monteCarlo.monteCarloComponent, 0.25);
  assert.equal(monteCarlo.value, 0.25);

  const relative = tesseraProviderParityTolerance(
    "mean-damage",
    20,
    21,
    10_000,
    10_000,
    0,
    0,
  );
  assert.equal(relative?.relativeComponent, 0.42);
  assert.equal(relative?.value, 0.42);

  const floor = tesseraProviderParityTolerance(
    "mean-damage",
    1,
    1,
    10_000,
    10_000,
    0,
    0,
  );
  assert.equal(floor?.value, 0.25);
});

test("exact tolerance and twice-tolerance boundaries are inclusive", () => {
  const contract = scenarioContract("wipe-probability");
  const tolerance = tesseraProviderParityTolerance(
    contract.metric,
    0,
    0.02,
    contract.iterations,
    contract.iterations,
  );
  assert.ok(tolerance);
  assert.equal(tolerance.value, 0.02);

  const atTolerance = compareTesseraProviderParity(
    ...pair({
      contract: [contract],
      localCells: [cell(contract, 0, 0)],
      websiteCells: [cell(contract, 0, 0.02)],
    }),
  );
  assert.equal(atTolerance.cells[0].status, "pass");
  assert.equal(atTolerance.outcome, "pass");

  const atDoubleTolerance = compareTesseraProviderParity(
    ...pair({
      contract: [contract],
      localCells: Array.from({ length: 50 }, (_, index) => cell(contract, index, 0)),
      websiteCells: Array.from({ length: 50 }, (_, index) =>
        cell(contract, index, index === 0 ? 0.04 : 0),
      ),
    }),
  );
  assert.equal(atDoubleTolerance.cells[0].tolerance?.value, 0.02);
  assert.equal(atDoubleTolerance.cells[0].toleranceMultiple, 2);
  assert.equal(atDoubleTolerance.metricSummaries[0].withinToleranceRate, 0.98);
  assert.equal(atDoubleTolerance.metricSummaries[0].status, "pass");
  assert.equal(atDoubleTolerance.outcome, "pass");
  assert.equal(
    atDoubleTolerance.issues.some(
      (entry) => entry.code === "CELL_BEYOND_DOUBLE_TOLERANCE",
    ),
    false,
  );
});

test("98 percent is accepted per metric and lower coverage is rejected", () => {
  const contract = scenarioContract("mean-kills");
  const localCells = Array.from({ length: 100 }, (_, index) =>
    cell(contract, index, 1, 0),
  );
  const websiteAtBoundary = Array.from({ length: 100 }, (_, index) =>
    cell(contract, index, index < 2 ? 1.11 : 1, 0),
  );
  const accepted = compareTesseraProviderParity(
    ...pair({
      contract: [contract],
      localCells,
      websiteCells: websiteAtBoundary,
    }),
  );
  assert.equal(accepted.metricSummaries[0].withinToleranceRate, 0.98);
  assert.equal(accepted.metricSummaries[0].status, "pass");
  assert.equal(accepted.outcome, "pass");

  const websiteBelowBoundary = websiteAtBoundary.map((entry, index) =>
    index === 2 ? { ...entry, value: 1.11 } : entry,
  );
  const rejected = compareTesseraProviderParity(
    ...pair({
      contract: [contract],
      localCells,
      websiteCells: websiteBelowBoundary,
    }),
  );
  assert.equal(rejected.metricSummaries[0].withinToleranceRate, 0.97);
  assert.equal(rejected.metricSummaries[0].status, "fail");
  assert.equal(rejected.outcome, "fail");
  assert.ok(
    rejected.issues.some(
      (entry) => entry.code === "METRIC_COVERAGE_BELOW_THRESHOLD",
    ),
  );
});

test("one cell beyond twice tolerance fails even when metric coverage is 99 percent", () => {
  const contract = scenarioContract("mean-damage");
  const localCells = Array.from({ length: 100 }, (_, index) =>
    cell(contract, index, 1, 0),
  );
  const websiteCells = localCells.map((entry, index) =>
    index === 0 ? { ...entry, value: 1.51 } : entry,
  );
  const result = compareTesseraProviderParity(
    ...pair({ contract: [contract], localCells, websiteCells }),
  );

  assert.equal(result.metricSummaries[0].withinToleranceRate, 0.99);
  assert.equal(result.metricSummaries[0].beyondDoubleToleranceCount, 1);
  assert.equal(result.metricSummaries[0].status, "fail");
  assert.equal(result.outcome, "fail");
  assert.ok(
    result.issues.some(
      (entry) => entry.code === "CELL_BEYOND_DOUBLE_TOLERANCE",
    ),
  );
});

test("missing, null, duplicate, and uncertainty-free mean cells are incomplete", () => {
  const contract = scenarioContract("mean-kills");
  const validLocal = cell(contract, 0, 2, 0.02);
  const missingStandardError = cell(contract, 0, 2, null);
  const local = parityRun({
    provider: "local-engine",
    contract: [contract],
    cells: [validLocal, validLocal],
  });
  const website = parityRun({
    provider: "website",
    contract: [contract],
    cells: [missingStandardError],
  });
  const result = compareTesseraProviderParity(local, website);

  assert.equal(result.outcome, "incomplete");
  assert.equal(result.eligible, true);
  assert.equal(result.complete, false);
  assert.equal(result.cells[0].status, "incomplete");
  assert.ok(result.issues.some((entry) => entry.code === "CELL_DUPLICATE"));
  assert.ok(
    result.issues.some(
      (entry) => entry.code === "CELL_STANDARD_ERROR_MISSING",
    ),
  );

  const nullWebsiteCell = { ...validLocal, value: null };
  const nullResult = compareTesseraProviderParity(
    parityRun({
      provider: "local-engine",
      contract: [contract],
      cells: [validLocal],
    }),
    parityRun({
      provider: "website",
      contract: [contract],
      cells: [nullWebsiteCell],
    }),
  );
  assert.equal(nullResult.outcome, "incomplete");
  assert.ok(
    nullResult.issues.some((entry) => entry.code === "CELL_VALUE_INVALID"),
  );

  const probability = scenarioContract("wipe-probability");
  const missingCellResult = compareTesseraProviderParity(
    ...pair({
      contract: [probability],
      localCells: [cell(probability, 0, 0.5)],
      websiteCells: [],
    }),
  );
  assert.equal(missingCellResult.outcome, "incomplete");
  assert.ok(
    missingCellResult.issues.some((entry) => entry.code === "CELL_MISSING"),
  );
  assert.ok(
    missingCellResult.issues.some(
      (entry) => entry.code === "CONTRACT_WITHOUT_CELLS",
    ),
  );
});

test("input, bundle, profile, and contract mismatches make parity ineligible", () => {
  const localContract = [scenarioContract("wipe-probability")];
  const websiteContract = [
    {
      ...localContract[0],
      settings: { ...localContract[0].settings, rules: "different-rules" },
    },
  ];
  const local = parityRun({
    provider: "local-engine",
    contract: localContract,
    cells: [cell(localContract[0], 0, 0.5)],
    dataBundleId: "bundle-local",
    profilePolicyHash: "profile-local",
  });
  const website = parityRun({
    provider: "website",
    contract: websiteContract,
    cells: [cell(websiteContract[0], 0, 0.5)],
    dataBundleId: "bundle-website",
    inputSha256: "b".repeat(64),
    profilePolicyHash: "profile-website",
  });

  const result = compareTesseraProviderParity(local, website);
  assert.equal(result.outcome, "ineligible");
  assert.equal(result.eligible, false);
  assert.deepEqual(
    new Set(result.issues.map((entry) => entry.code)),
    new Set([
      "DATA_BUNDLE_MISMATCH",
      "NORMALIZED_INPUT_MISMATCH",
      "PROFILE_POLICY_MISMATCH",
      "CONTRACT_MISMATCH",
    ]),
  );
});

test("a contract digest that does not bind the supplied settings is ineligible", () => {
  const contract = [scenarioContract("wipe-probability")];
  const [local, website] = pair({
    contract,
    localCells: [cell(contract[0], 0, 0.5)],
    websiteCells: [cell(contract[0], 0, 0.5)],
  });
  local.identity.scenarioContractSha256 = "f".repeat(64);
  website.identity.scenarioContractSha256 = "f".repeat(64);

  const result = compareTesseraProviderParity(local, website);
  assert.equal(result.outcome, "ineligible");
  assert.equal(
    result.issues.filter((entry) => entry.code === "CONTRACT_DIGEST_INVALID")
      .length,
    2,
  );
});

test("winner mismatches fail outside uncertainty and pass at a boundary", () => {
  const contract = scenarioContract("wipe-probability");
  const cells = [cell(contract, 0, 0.5)];
  const localWinner = [
    {
      classificationId: "aggregate",
      winner: "player" as const,
      withinUncertainty: false,
    },
  ];
  const websiteWinner = [
    {
      classificationId: "aggregate",
      winner: "opponent" as const,
      withinUncertainty: false,
    },
  ];
  const failed = compareTesseraProviderParity(
    ...pair({
      contract: [contract],
      localCells: cells,
      websiteCells: cells,
      localWinners: localWinner,
      websiteWinners: websiteWinner,
    }),
  );
  assert.equal(failed.outcome, "fail");
  assert.equal(failed.winnerClassifications[0].status, "fail");

  websiteWinner[0].withinUncertainty = true;
  const boundary = compareTesseraProviderParity(
    ...pair({
      contract: [contract],
      localCells: cells,
      websiteCells: cells,
      localWinners: localWinner,
      websiteWinners: websiteWinner,
    }),
  );
  assert.equal(boundary.outcome, "pass");
  assert.equal(boundary.winnerClassifications[0].uncertaintyBoundary, true);
  assert.equal(boundary.winnerClassifications[0].status, "pass");
});

test("provider ordering, contract ordering, and cell ordering do not affect output", () => {
  const contracts = [
    scenarioContract("wipe-probability"),
    scenarioContract("mean-damage"),
  ];
  const localCells = [cell(contracts[0], 0, 0.5), cell(contracts[1], 0, 5, 0.02)];
  const websiteCells = [
    cell(contracts[0], 0, 0.505),
    cell(contracts[1], 0, 5.1, 0.02),
  ];
  const [local, website] = pair({ contract: contracts, localCells, websiteCells });
  const normal = compareTesseraProviderParity(local, website);
  const reordered = compareTesseraProviderParity(
    {
      ...website,
      scenarioContract: [...website.scenarioContract].reverse(),
      cells: [...website.cells].reverse(),
    },
    {
      ...local,
      scenarioContract: [...local.scenarioContract].reverse(),
      cells: [...local.cells].reverse(),
    },
  );
  assert.deepEqual(reordered, normal);
});

test("legacy diagnostics remain readable but fail closed without semantic envelopes", () => {
  const contract = scenarioContract("wipe-probability");
  const local = parityRun({
    provider: "local-engine",
    contract: [contract],
    cells: [cell(contract, 0, 0.5)],
    includeSemanticEvidence: false,
  });
  const website = parityRun({
    provider: "website",
    contract: [contract],
    cells: [cell(contract, 0, 0.5)],
    includeSemanticEvidence: false,
  });

  const result = compareTesseraProviderParity(local, website);

  assert.equal(result.outcome, "ineligible");
  assert.equal(result.cells[0].status, "pass");
  assert.equal(result.modelCapabilityEnvelope.status, "incomplete");
  assert.equal(result.combatSnapshot.status, "incomplete");
  assert.equal(
    result.issues.filter(
      (entry) => entry.code === "MODEL_CAPABILITY_ENVELOPE_MISSING",
    ).length,
    2,
  );
  assert.equal(
    result.issues.filter((entry) => entry.code === "COMBAT_SNAPSHOT_MISSING")
      .length,
    2,
  );
});

test("model-capability mismatch is an ineligible semantic comparison", () => {
  const contract = scenarioContract("wipe-probability");
  const [local, website] = pair({
    contract: [contract],
    localCells: [cell(contract, 0, 0.5)],
    websiteCells: [cell(contract, 0, 0.5)],
  });
  assert.ok(website.modelCapabilityEnvelope);
  website.modelCapabilityEnvelope = {
    ...website.modelCapabilityEnvelope,
    combatModelVersion: "base-profile-monte-carlo-v2",
  };
  website.identity.modelCapabilityEnvelopeSha256 =
    tesseraProviderParityModelCapabilityEnvelopeSha256(
      website.modelCapabilityEnvelope,
    );

  const result = compareTesseraProviderParity(local, website);

  assert.equal(result.outcome, "ineligible");
  assert.equal(result.modelCapabilityEnvelope.status, "mismatch");
  assert.ok(
    result.issues.some(
      (entry) => entry.code === "MODEL_CAPABILITY_ENVELOPE_MISMATCH",
    ),
  );
});

test("combat snapshot diffs classify named unit-profile regressions", () => {
  const local = providerParityNamedCombatSnapshotFixture();

  const witchseekers = structuredClone(local);
  witchseekers.units.find(
    (unit) => unit.instanceId === "custodes-witchseekers-1",
  )!.defense.toughness = 4;
  assert.equal(
    compareTesseraProviderParityCombatSnapshots(local, witchseekers).diffs[0]
      .classification,
    "defense-profile-mismatch",
  );

  const troupe = structuredClone(local);
  troupe.units.find(
    (unit) => unit.instanceId === "aeldari-troupe-1",
  )!.attackProfiles[0].damage = "2";
  assert.equal(
    compareTesseraProviderParityCombatSnapshots(local, troupe).diffs[0]
      .classification,
    "attack-profile-mismatch",
  );

  const farseer = structuredClone(local);
  farseer.units.find(
    (unit) => unit.instanceId === "aeldari-farseer-1",
  )!.modeledEffects.push("fate-dice");
  assert.equal(
    compareTesseraProviderParityCombatSnapshots(local, farseer).diffs[0]
      .classification,
    "modeled-effects-mismatch",
  );

  const shroudRunners = structuredClone(local);
  shroudRunners.units.find(
    (unit) => unit.instanceId === "aeldari-shroud-runners-1",
  )!.evidence.status = "incomplete";
  const shroudComparison = compareTesseraProviderParityCombatSnapshots(
    local,
    shroudRunners,
  );
  assert.equal(shroudComparison.status, "incomplete");
  assert.equal(
    shroudComparison.diffs[0].classification,
    "semantic-evidence-incomplete",
  );
});

test("incomplete combat semantics fail closed even when compared cells match", () => {
  const contract = scenarioContract("wipe-probability");
  const localSnapshot = providerParityNamedCombatSnapshotFixture();
  const websiteSnapshot = structuredClone(localSnapshot);
  websiteSnapshot.units.find(
    (unit) => unit.instanceId === "aeldari-shroud-runners-1",
  )!.evidence.status = "incomplete";
  const comparedCell: TesseraProviderParityCell = {
    scenarioId: contract.scenarioId,
    attackerInstanceId: "custodes-witchseekers-1",
    targetInstanceId: "aeldari-troupe-1",
    metric: contract.metric,
    value: 0.5,
    iterations: contract.iterations,
  };
  const result = compareTesseraProviderParity(
    parityRun({
      provider: "local-engine",
      contract: [contract],
      cells: [comparedCell],
      combatSnapshot: localSnapshot,
    }),
    parityRun({
      provider: "website",
      contract: [contract],
      cells: [comparedCell],
      combatSnapshot: websiteSnapshot,
    }),
  );

  assert.equal(result.outcome, "ineligible");
  assert.equal(result.cells[0].status, "pass");
  assert.ok(
    result.issues.some(
      (entry) => entry.code === "SEMANTIC_EVIDENCE_INCOMPLETE",
    ),
  );
});

test("per-cell sample variance and standard error are retained and normalized", () => {
  const contract = scenarioContract("mean-damage");
  const localCell = {
    ...cell(contract, 0, 5, null),
    sampleCount: 10_000,
    sampleVariance: 4,
  };
  delete localCell.standardError;
  const websiteCell = {
    ...cell(contract, 0, 5.01, 0.02),
    sampleCount: 10_000,
  };
  const result = compareTesseraProviderParity(
    ...pair({
      contract: [contract],
      localCells: [localCell],
      websiteCells: [websiteCell],
    }),
  );

  assert.equal(result.outcome, "pass");
  assert.deepEqual(result.cells[0].localSamplingEvidence, {
    sampleCount: 10_000,
    sampleVariance: 4,
    standardError: 0.02,
    standardErrorSource: "derived-from-variance",
  });
  assert.deepEqual(result.cells[0].websiteSamplingEvidence, {
    sampleCount: 10_000,
    sampleVariance: null,
    standardError: 0.02,
    standardErrorSource: "reported",
  });

  const inconsistent = {
    ...websiteCell,
    sampleVariance: 4,
    standardError: 0.03,
  };
  const rejected = compareTesseraProviderParity(
    ...pair({
      contract: [contract],
      localCells: [localCell],
      websiteCells: [inconsistent],
    }),
  );
  assert.equal(rejected.outcome, "incomplete");
  assert.ok(
    rejected.issues.some(
      (entry) => entry.code === "CELL_SAMPLING_EVIDENCE_INCONSISTENT",
    ),
  );
});

test("sample counts must bind the reported iteration evidence", () => {
  const contract = scenarioContract("wipe-probability");
  const mismatched = {
    ...cell(contract, 0, 0.5),
    sampleCount: contract.iterations - 1,
  };
  const result = compareTesseraProviderParity(
    ...pair({
      contract: [contract],
      localCells: [cell(contract, 0, 0.5)],
      websiteCells: [mismatched],
    }),
  );

  assert.equal(result.outcome, "incomplete");
  assert.equal(result.cells[0].websiteSamplingEvidence?.sampleCount, 9_999);
  assert.ok(
    result.issues.some(
      (entry) => entry.code === "CELL_SAMPLE_COUNT_MISMATCH",
    ),
  );
});

test("canonical winner adapter uses bidirectional probability pressure", () => {
  const playerContract = scenarioContract(
    "half-wipe-probability",
    "shooting:player-to-opponent:half-wipe-probability",
  );
  const opponentContract = {
    ...scenarioContract(
      "half-wipe-probability",
      "shooting:opponent-to-player:half-wipe-probability",
    ),
    direction: "opponent-to-player" as const,
  };
  const cells = [
    {
      ...cell(playerContract, 0, 0.75),
      attackerInstanceId: "player-unit",
      targetInstanceId: "opponent-unit",
    },
    {
      ...cell(opponentContract, 0, 0.3),
      attackerInstanceId: "opponent-unit",
      targetInstanceId: "player-unit",
    },
  ];
  const run = parityRun({
    provider: "local-engine",
    contract: [playerContract, opponentContract],
    cells,
  });
  const classification = adaptCanonicalTesseraProviderParityWinner(run);

  assert.equal(
    classification?.classificationId,
    TESSERA_PROVIDER_PARITY_CANONICAL_WINNER_ID,
  );
  assert.equal(classification?.winner, "player");
  assert.equal(classification?.withinUncertainty, false);
  assert.equal(classification?.evidence?.sampleCount, 20_000);

  const result = compareTesseraProviderParity(
    ...pair({
      contract: [playerContract, opponentContract],
      localCells: cells,
      websiteCells: cells,
    }),
  );
  assert.equal(result.outcome, "pass");
  assert.deepEqual(result.winnerClassifications, [
    {
      classificationId: TESSERA_PROVIDER_PARITY_CANONICAL_WINNER_ID,
      localWinner: "player",
      websiteWinner: "player",
      uncertaintyBoundary: false,
      status: "pass",
    },
  ]);
});

test("the policy constants encode the agreed promotion thresholds", () => {
  assert.equal(TESSERA_PROVIDER_PARITY_POLICY.minimumMetricPassRate, 0.98);
  assert.equal(TESSERA_PROVIDER_PARITY_POLICY.maximumToleranceMultiple, 2);
  assert.deepEqual(TESSERA_PROVIDER_PARITY_POLICY.probability, {
    absoluteFloor: 0.02,
    monteCarloMultiplier: 4,
    roundingAllowance: 0.005,
  });
  assert.equal(TESSERA_PROVIDER_PARITY_POLICY.meanKills.absoluteFloor, 0.1);
  assert.equal(TESSERA_PROVIDER_PARITY_POLICY.meanDamage.absoluteFloor, 0.25);
});
