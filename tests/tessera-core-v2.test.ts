import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  buildRoster,
  modifyRoster,
  validateRoster,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
  type TesseraDirection,
  type TesseraMetric,
  type TesseraPhase,
} from "../lib/rosterpilot";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import type {
  TesseraBrowserInput,
  TesseraBrowserResult,
  TesseraScenario,
} from "../local/tessera/browser";
import {
  analyzeRosterMatchup,
  compareRosterRevision,
} from "../local/tessera/companion";

function roster(
  faction: string,
  pointsLimit: number,
  name: string,
  preferences: RosterDraftV1["preferences"] = [],
): RosterDraftV1 {
  const built = buildRoster({
    faction,
    pointsLimit,
    name,
    preferences,
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("\n"),
  );
  assert.ok(built.data);
  return built.data;
}

function summaryFor(roster: RosterDraftV1): EnrichedRoszSummary {
  return {
    rosterName: roster.name,
    factionName: roster.factionName,
    totalPoints: roster.totalPoints,
    generatedBy: "https://newrecruit.eu",
    profileCount: 12,
    weaponProfileCount: 8,
    units: roster.units.map((unit) => ({
      selectionId: unit.selectionId,
      name: unit.name,
      modelCount: unit.modelCount,
      ordinal: unit.ordinal,
      points: unit.points,
    })),
  };
}

function deliveryFor(
  roster: RosterDraftV1,
  outputDirectory: string,
): ResultEnvelope<NewRecruitDelivery> {
  return {
    ok: true,
    data: {
      rosterId: roster.id,
      rosterName: roster.name,
      listUrl: "https://www.newrecruit.eu/app/Lists/core-v2-fixture",
      imported: true,
      sessionReused: true,
      verification: {
        name: true,
        faction: true,
        points: true,
        units: roster.units.map((unit) => ({
          name: unit.name,
          modelCount: unit.modelCount,
          matched: true,
        })),
        mismatches: [],
      },
      enrichedSummary: summaryFor(roster),
      artifacts: [
        {
          format: "rosterpilot-source-rosz",
          filename: "source.rosz",
          mimeType: "application/zip",
          written: path.join(outputDirectory, "source.rosz"),
        },
        {
          format: "new-recruit-enriched-rosz",
          filename: "enriched.rosz",
          mimeType: "application/zip",
          written: path.join(outputDirectory, "enriched.rosz"),
        },
      ],
    },
    violations: [],
    warnings: [],
  };
}

function deliveryDependency(
  fallbackDirectory: string,
): (
  roster: RosterDraftV1,
  options?: NewRecruitDeliveryOptions,
) => Promise<ResultEnvelope<NewRecruitDelivery>> {
  return async (candidate, options = {}) =>
    deliveryFor(
      candidate,
      options.outputDirectory ?? fallbackDirectory,
    );
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function enrichedFixture(roster: RosterDraftV1): Uint8Array {
  const selections = roster.units
    .map(
      (unit) => `
      <selection id="${xmlAttribute(unit.selectionId)}" name="${xmlAttribute(
        unit.name,
      )}" number="1" type="unit">
        <cost name="pts" value="${unit.points}"/>
        <selections>
          <selection name="${xmlAttribute(
            unit.name,
          )}" number="${unit.modelCount}" type="model"/>
        </selections>
      </selection>`,
    )
    .join("");
  const xml = `<?xml version="1.0"?>
<roster name="${xmlAttribute(
    roster.name,
  )}" generatedBy="https://newrecruit.eu">
  <cost name="pts" value="${roster.totalPoints}"/>
  <forces>
    <force name="${xmlAttribute(
      roster.factionName,
    )}" catalogueName="${xmlAttribute(roster.factionName)}">
      <selections>${selections}
      </selections>
    </force>
  </forces>
  <profiles>
    <profile name="Fixture model" typeName="Unit"/>
    <profile name="Fixture weapon" typeName="Ranged Weapons"/>
  </profiles>
</roster>`;
  return zipSync({ "fixture.ros": strToU8(xml) });
}

function artifactDeliveryDependency(
  fallbackDirectory: string,
): (
  roster: RosterDraftV1,
  options?: NewRecruitDeliveryOptions,
) => Promise<ResultEnvelope<NewRecruitDelivery>> {
  return async (candidate, options = {}) => {
    const outputDirectory = options.outputDirectory ?? fallbackDirectory;
    await mkdir(outputDirectory, { recursive: true });
    const delivery = deliveryFor(candidate, outputDirectory);
    const content = enrichedFixture(candidate);
    await Promise.all(
      delivery.data!.artifacts.map((artifact) =>
        writeFile(artifact.written, content),
      ),
    );
    return delivery;
  };
}

function metricValue(
  metric: TesseraMetric,
  direction: TesseraDirection,
): number {
  if (metric === "wipe-probability") {
    return direction === "player-to-opponent" ? 0.7 : 0.55;
  }
  if (metric === "half-wipe-probability") {
    return direction === "player-to-opponent" ? 0.4 : 0.65;
  }
  if (metric === "mean-kills") {
    return direction === "player-to-opponent" ? 2.5 : 1.5;
  }
  return direction === "player-to-opponent" ? 0.5 : 3;
}

function occurrenceAt(
  roster: RosterDraftV1,
  index: number,
): number {
  const name = roster.units[index].name;
  return (
    roster.units
      .slice(0, index + 1)
      .filter((unit) => unit.name === name).length - 1
  );
}

function rawScenario(
  player: RosterDraftV1,
  opponent: RosterDraftV1,
  phase: TesseraPhase,
  metric: TesseraMetric,
  direction: TesseraDirection,
): TesseraScenario {
  const attackers =
    direction === "player-to-opponent" ? player : opponent;
  const targets =
    direction === "player-to-opponent" ? opponent : player;
  const value = metricValue(metric, direction);
  return {
    id: `${phase}:${direction}:${metric}`,
    phase,
    metric,
    direction,
    settings: {
      Phase: phase,
      Metric: metric,
      Direction: direction,
    },
    iterations: 1_000,
    cells: attackers.units.flatMap((attacker, attackerIndex) =>
      targets.units.map((target, targetIndex) => ({
        attacker: attacker.name,
        target: target.name,
        direction,
        attackerIndex,
        targetIndex,
        attackerOccurrence: occurrenceAt(attackers, attackerIndex),
        targetOccurrence: occurrenceAt(targets, targetIndex),
        metricValue: value,
        killProbability:
          metric === "wipe-probability" ? value : null,
        expectedDamage: metric === "mean-damage" ? value : null,
        damagePer100Points: null,
      })),
    ),
  };
}

function fullBrowserResult(
  player: RosterDraftV1,
  opponent: RosterDraftV1,
): TesseraBrowserResult {
  const phases: TesseraPhase[] = ["shooting", "fight"];
  const metrics: TesseraMetric[] = [
    "wipe-probability",
    "half-wipe-probability",
    "mean-kills",
    "mean-damage",
  ];
  const directions: TesseraDirection[] = [
    "player-to-opponent",
    "opponent-to-player",
  ];
  const scenarios = phases.flatMap((phase) =>
    metrics.flatMap((metric) =>
      directions.map((direction) =>
        rawScenario(player, opponent, phase, metric, direction),
      ),
    ),
  );
  return {
    settings: {
      iterations: "1000",
      rules: "baseline",
    },
    cells: scenarios[0].cells,
    scenarios,
    importWarnings: {
      player: [],
      opponent: [],
    },
    warnings: [],
  };
}

test("consolidates a full 16-matrix run into four complete scenarios with stable duplicate labels", async () => {
  const player = roster(
    "adeptus-custodes",
    2_000,
    "Duplicate Unit Player",
    ["objective"],
  );
  const opponent = roster("necrons", 2_000, "Core V2 Opponent", [
    "objective",
  ]);
  assert.equal(
    player.units.filter((unit) => unit.name === "Prosecutors").length,
    2,
    "fixture must contain duplicate Prosecutors units",
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-core-v2-"),
  );
  const browserInputs: TesseraBrowserInput[] = [];
  try {
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        experimental: true,
        analysisMode: "full",
        outputDirectory: path.join(directory, "report"),
        allowOutsideRoot: true,
      },
      {
        deliver: deliveryDependency(directory),
        runBrowser: async (input) => {
          browserInputs.push(input);
          return fullBrowserResult(player, opponent);
        },
      },
    );

    assert.equal(analyzed.ok, true);
    assert.ok(analyzed.data);
    assert.equal(analyzed.data.schemaVersion, 2);
    assert.equal(analyzed.data.status, "complete");
    assert.equal(analyzed.data.comparisonClass, "matched");
    assert.deepEqual(analyzed.data.configuration?.phases, [
      "shooting",
      "fight",
    ]);
    assert.deepEqual(analyzed.data.configuration?.metrics, [
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ]);
    assert.equal(browserInputs.length, 1);
    assert.deepEqual(browserInputs[0]?.phases, ["shooting", "fight"]);
    assert.deepEqual(browserInputs[0]?.metrics, [
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ]);

    const scenarios = analyzed.data.simulation.scenarios ?? [];
    assert.equal(scenarios.length, 4);
    assert.ok(scenarios.every((scenario) => scenario.status === "complete"));
    assert.ok(
      scenarios.every(
        (scenario) =>
          scenario.metrics.length === 4 &&
          scenario.iterations === 1_000,
      ),
    );

    const playerAttack = scenarios.find(
      (scenario) =>
        scenario.phase === "shooting" &&
        scenario.direction === "player-to-opponent",
    );
    assert.ok(playerAttack);
    const firstCell = playerAttack.cells[0];
    assert.deepEqual(firstCell.values, {
      wipeProbability: 0.7,
      halfWipeProbability: 0.4,
      meanKills: 2.5,
      meanDamage: 0.5,
      damagePer100Points: (0.5 / firstCell.attacker.points!) * 100,
    });

    const duplicateInstances = [
      ...new Map(
        playerAttack.cells
          .filter((cell) => cell.attacker.name === "Prosecutors")
          .map((cell) => [cell.attacker.instanceId, cell.attacker]),
      ).values(),
    ];
    assert.equal(duplicateInstances.length, 2);
    assert.equal(new Set(duplicateInstances.map((unit) => unit.label)).size, 2);
    assert.deepEqual(
      duplicateInstances.map((unit) => unit.label),
      [
        "Prosecutors — 6 models — 75 pts — Unit 1",
        "Prosecutors — 10 models — 85 pts — Unit 2",
      ],
    );

    const findingKinds = new Set(
      (analyzed.data.findings ?? []).map((finding) => finding.kind),
    );
    assert.ok(findingKinds.has("reliable-coverage"));
    assert.ok(findingKinds.has("enemy-threat"));
    assert.ok(findingKinds.has("coverage-gap"));
    assert.ok(findingKinds.has("poor-efficiency"));
    assert.ok((analyzed.data.findings ?? []).every((finding) => finding.findingId));

    const candidates = analyzed.data.changeCandidates ?? [];
    assert.ok(candidates.length > 0);
    assert.ok(candidates.length <= 3);
    for (const candidate of candidates) {
      const modified = modifyRoster(player, candidate.operation);
      assert.equal(modified.ok, true, candidate.title);
      assert.ok(modified.data);
      assert.equal(validateRoster(modified.data).ok, true, candidate.title);
      assert.equal(candidate.beforePoints, player.totalPoints);
      assert.equal(candidate.afterPoints, modified.data.totalPoints);
      assert.ok(
        candidate.evidenceFindingIds.every((findingId) =>
          (analyzed.data?.findings ?? []).some(
            (finding) => finding.findingId === findingId,
          ),
        ),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps alternate-profile warnings visible and out of confident findings", async () => {
  const player = roster("adeptus-custodes", 1_000, "Ambiguous Player");
  const opponent = roster("necrons", 1_000, "Clear Opponent");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-ambiguity-v2-"),
  );
  try {
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        experimental: true,
        analysisMode: "full",
        outputDirectory: path.join(directory, "report"),
        allowOutsideRoot: true,
      },
      {
        deliver: deliveryDependency(directory),
        runBrowser: async () => {
          const result = fullBrowserResult(player, opponent);
          result.importWarnings.player = [
            '"Vaultswords" has alternate profiles.',
          ];
          result.warnings = [...result.importWarnings.player];
          return result;
        },
      },
    );

    assert.equal(analyzed.ok, true);
    assert.ok(analyzed.data);
    const scenarios = analyzed.data.simulation.scenarios ?? [];
    assert.ok(
      scenarios
        .filter(
          (scenario) =>
            scenario.direction === "player-to-opponent",
        )
        .every((scenario) =>
          scenario.cells.every(
            (cell) =>
              cell.confidence === "ambiguous" &&
              cell.warningRefs.some((warning) =>
                /alternate profiles/i.test(warning),
              ),
          ),
        ),
    );
    assert.ok(
      scenarios
        .filter(
          (scenario) =>
            scenario.direction === "opponent-to-player",
        )
        .every((scenario) =>
          scenario.cells.every((cell) => cell.confidence === "high"),
        ),
    );
    assert.equal(
      analyzed.data.findings?.some(
        (finding) => finding.kind === "reliable-coverage",
      ),
      false,
    );
    assert.ok(
      (analyzed.data.changeCandidates ?? []).every((candidate) =>
        candidate.evidenceFindingIds.every((findingId) =>
          analyzed.data?.findings?.some(
            (finding) =>
              finding.findingId === findingId &&
              finding.confidence !== "ambiguous",
          ),
        ),
      ),
    );
    assert.match(analyzed.data.warnings.join("\n"), /Vaultswords/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks an unmatched roster unless the mismatch is explicitly allowed", async () => {
  const player = roster("adeptus-custodes", 1_000, "Mismatch Player");
  const opponent = roster("necrons", 2_000, "Mismatch Opponent");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-points-v2-"),
  );
  let deliveryCalls = 0;
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ) => {
    deliveryCalls += 1;
    return deliveryFor(
      candidate,
      options.outputDirectory ?? directory,
    );
  };
  try {
    const blocked = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        outputDirectory: path.join(directory, "blocked"),
        allowOutsideRoot: true,
      },
      { deliver },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.data, null);
    assert.equal(
      blocked.violations[0]?.code,
      "TESSERA_POINTS_MISMATCH",
    );
    assert.equal(deliveryCalls, 0);

    const overridden = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        outputDirectory: path.join(directory, "overridden"),
        allowOutsideRoot: true,
        allowPointMismatch: true,
      },
      { deliver },
    );
    assert.equal(overridden.ok, true);
    assert.ok(overridden.data);
    assert.equal(overridden.data.comparisonClass, "unmatched");
    assert.equal(overridden.data.pointsComparisons?.[0].matched, false);
    assert.equal(
      overridden.data.pointsComparisons?.[0].classification,
      "unmatched",
    );
    assert.deepEqual(overridden.data.changeCandidates, []);
    assert.equal(deliveryCalls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an incompatible baseline before attempting a revision run", async () => {
  const revised = roster("adeptus-custodes", 1_000, "Revised Player");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-revision-v2-"),
  );
  const baselinePath = path.join(directory, "legacy-baseline.json");
  await writeFile(
    baselinePath,
    JSON.stringify({
      runId: "legacy-run",
      simulation: { matrices: [], settings: {} },
    }),
  );
  let deliveryCalls = 0;
  try {
    const compared = await compareRosterRevision(
      baselinePath,
      revised,
      {
        outputDirectory: path.join(directory, "comparison"),
        allowOutsideRoot: true,
      },
      {
        deliver: async (candidate, options = {}) => {
          deliveryCalls += 1;
          return deliveryFor(
            candidate,
            options.outputDirectory ?? directory,
          );
        },
      },
    );
    assert.equal(compared.ok, false);
    assert.equal(compared.data, null);
    assert.equal(
      compared.violations[0]?.code,
      "TESSERA_BASELINE_INCOMPATIBLE",
    );
    assert.equal(deliveryCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reruns an approved same-faction revision against the baseline scenarios", async () => {
  const player = roster(
    "adeptus-custodes",
    2_000,
    "Revision Baseline",
    ["objective"],
  );
  const opponent = roster(
    "necrons",
    2_000,
    "Revision Opponent",
    ["objective"],
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-revision-happy-v2-"),
  );
  try {
    const deliver = artifactDeliveryDependency(directory);
    const baseline = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        experimental: true,
        analysisMode: "full",
        outputDirectory: path.join(directory, "baseline"),
        allowOutsideRoot: true,
      },
      {
        deliver,
        runBrowser: async () => fullBrowserResult(player, opponent),
      },
    );
    assert.equal(baseline.ok, true);
    assert.ok(baseline.data);
    const candidate = baseline.data.changeCandidates?.[0];
    assert.ok(candidate);
    const modified = modifyRoster(player, candidate.operation);
    assert.equal(modified.ok, true);
    assert.ok(modified.data);

    const handoffOnly = await compareRosterRevision(
      baseline.data.artifacts[0].written,
      modified.data,
      {
        outputDirectory: path.join(directory, "handoff-only"),
        allowOutsideRoot: true,
      },
      {
        deliver: async () => {
          throw new Error("Revision delivery must not run without opt-in.");
        },
      },
    );
    assert.equal(handoffOnly.ok, false);
    assert.equal(
      handoffOnly.violations[0]?.code,
      "TESSERA_REVISION_SIMULATION_REQUIRED",
    );

    const compared = await compareRosterRevision(
      baseline.data.artifacts[0].written,
      modified.data,
      {
        experimental: true,
        outputDirectory: path.join(directory, "revision"),
        allowOutsideRoot: true,
      },
      {
        deliver,
        runBrowser: async () =>
          fullBrowserResult(modified.data!, opponent),
      },
    );

    assert.equal(compared.ok, true);
    assert.ok(compared.data);
    assert.equal(compared.data.baselineRunId, baseline.data.runId);
    assert.equal(compared.data.revisedReports.length, 1);
    assert.equal(compared.data.revisedReports[0].status, "complete");
    assert.ok(compared.data.deltas.length > 0);
    assert.equal(
      compared.data.summary.improved +
        compared.data.summary.worsened +
        compared.data.summary.unchanged +
        compared.data.summary.ambiguous,
      compared.data.deltas.length,
    );
    assert.match(
      await readFile(compared.data.artifacts[1].written, "utf8"),
      /revision comparison/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
