import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  analyzeMissionReadiness,
  assessMissionReadinessRevisionGuardrail,
  buildRoster,
  exportRoster,
  getNewRecruitFactionSummary,
  inspectEnrichedProfileRequirements,
  modifyRoster,
  newRecruitCatalogue,
  validateRoster,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
  type TesseraDirection,
  type TesseraFinding,
  type TesseraMetric,
  type TesseraPhase,
} from "../lib/rosterpilot";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import type {
  TesseraBrowserInput,
  TesseraBrowserResult,
  TesseraScenario,
} from "../local/tessera/browser";
import { TesseraAutomationError } from "../local/tessera/browser";
import { missionReadinessIsNoWorse } from "../local/tessera/candidate-quality";
import {
  analyzeRosterMatchup,
  compareRosterRevision,
} from "../local/tessera/companion";
import {
  aggregateProfileRequirements,
  ProfilePolicySchema,
  profilePolicyScaffold,
  validateProfilePolicy,
} from "../local/tessera/profile-policy";

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

test("profile policies preserve duplicate unit sizes and migrate unambiguous legacy entries", () => {
  const requirements = [
    {
      faction: "orks",
      unit: "Gork’s Ladz",
      selectionId: "unit-10",
      unitOccurrence: 1,
      modelCount: 10,
      weaponGroup: "Gork’s klaw",
      phase: "fight" as const,
      availableProfiles: ["Strike", "Sweep"],
      activeCount: 10,
      selectedProfile: null,
    },
    {
      faction: "orks",
      unit: "Gork’s Ladz",
      selectionId: "unit-20",
      unitOccurrence: 1,
      modelCount: 20,
      weaponGroup: "Gork’s klaw",
      phase: "fight" as const,
      availableProfiles: ["Strike", "Sweep"],
      activeCount: 20,
      selectedProfile: null,
    },
  ];
  const scaffold = profilePolicyScaffold(requirements);
  assert.deepEqual(
    scaffold.entries.map((entry) => [
      entry.modelCount,
      entry.unitOccurrence,
      entry.activeCount,
    ]),
    [
      [10, 1, 10],
      [20, 1, 20],
    ],
  );
  const policy = {
    ...scaffold,
    entries: scaffold.entries.map((entry) => ({
      ...entry,
      unit: "Gork's Ladz",
      weaponGroup: "Gork's klaw",
      selectedProfile: entry.modelCount === 10 ? "Sweep" : "Strike",
    })),
  };
  assert.equal(validateProfilePolicy(requirements, policy).valid, true);

  const legacy = ProfilePolicySchema.parse({
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: [
      {
        faction: "orks",
        unit: "Gork's Ladz",
        weaponGroup: "Gork's klaw",
        phase: "fight",
        selectedProfile: "Sweep",
        activeCount: 10,
      },
    ],
  });
  assert.equal(
    validateProfilePolicy([requirements[0]], legacy).valid,
    true,
  );
  assert.equal(
    validateProfilePolicy(requirements, legacy).valid,
    false,
  );
});

test("enriched profile inventory distinguishes same-name unit sizes and occurrences", () => {
  const alternateUnit = (
    id: string,
    models: number,
    apostrophe: "'" | "’",
  ) => `
    <selection id="${id}" name="Gork${apostrophe}s Ladz" number="1" type="unit">
      <selections>
        <selection id="${id}-models" name="Ladz" number="${models}" type="model"/>
        <selection id="${id}-weapon" name="Gork${apostrophe}s klaw" number="${models}" type="upgrade">
          <profiles>
            <profile name="➤ Gork${apostrophe}s klaw - Strike" typeName="Melee Weapons"/>
            <profile name="➤ Gork${apostrophe}s klaw - Sweep" typeName="Melee Weapons"/>
          </profiles>
        </selection>
      </selections>
    </selection>`;
  const xml = `<?xml version="1.0"?>
    <roster name="Duplicate Orks" generatedBy="https://newrecruit.eu">
      <cost name="pts" value="1000"/>
      <forces>
        <force name="Orks" catalogueName="Orks">
          <selections>
            ${alternateUnit("unit-10", 10, "’")}
            ${alternateUnit("unit-20", 20, "'")}
            ${alternateUnit("unit-10b", 10, "'")}
          </selections>
        </force>
      </forces>
    </roster>`;
  const requirements = inspectEnrichedProfileRequirements(
    zipSync({ "duplicate-orks.ros": strToU8(xml) }),
    "orks",
  );
  assert.deepEqual(
    requirements.map((requirement) => [
      requirement.modelCount,
      requirement.unitOccurrence,
      requirement.activeCount,
    ]),
    [
      [10, 1, 10],
      [10, 2, 10],
      [20, 1, 20],
    ],
  );
});

test("enriched profile inventory accepts no-arrow sibling variants without treating ordinary hyphenated names as alternates", () => {
  const xml = `<?xml version="1.0"?>
    <roster name="No-arrow profiles" generatedBy="https://newrecruit.eu">
      <cost name="pts" value="1000"/>
      <forces>
        <force name="Death Guard" catalogueName="Death Guard">
          <selections>
            <selection id="defiler-1" name="Defiler" number="1" type="unit">
              <selections>
                <selection id="models-1" name="Defiler" number="1" type="model"/>
                <selection id="claws-1" name="Shearing claws" number="1" type="upgrade">
                  <profiles>
                    <profile name="Shearing claws - strike" typeName="Melee Weapons"/>
                    <profile name="Shearing claws - sweep" typeName="Melee Weapons"/>
                  </profiles>
                </selection>
                <selection id="ordinary-1" name="Star engines - port" number="1" type="upgrade">
                  <profiles>
                    <profile name="Star engines - port" typeName="Ranged Weapons"/>
                  </profiles>
                </selection>
                <selection id="single-1" name="One-mode weapon" number="1" type="upgrade">
                  <profiles>
                    <profile name="One-mode weapon - standard" typeName="Ranged Weapons"/>
                  </profiles>
                </selection>
              </selections>
            </selection>
          </selections>
        </force>
      </forces>
    </roster>`;
  const requirements = inspectEnrichedProfileRequirements(
    zipSync({ "no-arrow.ros": strToU8(xml) }),
    "death-guard",
  );
  assert.deepEqual(
    requirements.map((requirement) => ({
      unit: requirement.unit,
      weaponGroup: requirement.weaponGroup,
      phase: requirement.phase,
      profiles: requirement.availableProfiles,
      activeCount: requirement.activeCount,
    })),
    [
      {
        unit: "Defiler",
        weaponGroup: "Shearing claws",
        phase: "fight",
        profiles: ["strike", "sweep"],
        activeCount: 1,
      },
    ],
  );
});

function summaryFor(roster: RosterDraftV1): EnrichedRoszSummary {
  const faction = getNewRecruitFactionSummary(roster.factionId)!;
  return {
    rosterName: roster.name,
    factionName: roster.factionName,
    totalPoints: roster.totalPoints,
    generatedBy: "https://newrecruit.eu",
    observedNewRecruitCatalogue: {
      source: "new-recruit-enriched-rosz",
      gameSystem: {
        id: newRecruitCatalogue.gameSystem.id,
        name: newRecruitCatalogue.gameSystem.name,
        revision: roster.sourceData.newRecruit.gameSystemRevision,
      },
      catalogues: [
        {
          id: faction.catalogue.id,
          name: faction.catalogue.name,
          revision: roster.sourceData.newRecruit.catalogueRevision,
        },
      ],
    },
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
      .filter((unit) => unit.name === name).length
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
  const cells = attackers.units.flatMap((attacker, attackerIndex) =>
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
  );
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
    cells,
    matrixSha256: crypto
      .createHash("sha256")
      .update(JSON.stringify({ phase, metric, direction, cells }))
      .digest("hex"),
    integrity: {
      status: "trusted",
      issueCodes: [],
      aliasedScenarioIds: [],
    },
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
  let player = roster(
    "adeptus-custodes",
    2_000,
    "Duplicate Unit Player",
    ["objective"],
  );
  const removable = [...player.units]
    .filter((unit) => !unit.isWarlord && unit.points >= 90)
    .sort((left, right) => left.points - right.points)[0];
  assert.ok(removable);
  const removed = modifyRoster(player, {
    type: "remove",
    selectionId: removable.selectionId,
  });
  assert.ok(removed.data);
  player = removed.data;
  const existingProsecutors = player.units.filter(
    (unit) => unit.name === "Prosecutors",
  ).length;
  for (
    let duplicate = existingProsecutors;
    duplicate < 2;
    duplicate += 1
  ) {
    const added = modifyRoster(player, {
      type: "add",
      unitId: "prosecutors",
    });
    assert.ok(added.data);
    player = added.data;
  }
  const toppedUp = modifyRoster(player, {
    type: "add",
    unitId: "vigilators",
  });
  assert.ok(toppedUp.data);
  player = toppedUp.data;
  const opponent = roster("necrons", 2_000, "Core V2 Opponent", [
    "objective",
  ]);
  assert.ok(
    player.units.filter((unit) => unit.name === "Prosecutors")
      .length >= 2,
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
          const result = fullBrowserResult(player, opponent);
          for (const scenario of result.scenarios) {
            for (const cell of scenario.cells) {
              // Tessera may reorder its rendered matrix. Canonical unit
              // identity must come from the captured labels and occurrence,
              // never these presentation indexes.
              cell.attackerIndex += 100;
              cell.targetIndex += 100;
            }
          }
          return result;
        },
      },
    );

    assert.equal(
      analyzed.ok,
      true,
      analyzed.violations
        .map((violation) => `${violation.code}: ${violation.message}`)
        .join("\n"),
    );
    assert.ok(analyzed.data);
    assert.equal(analyzed.data.schemaVersion, 3);
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
    const expectedDuplicateUnits = player.units.filter(
      (unit) => unit.name === "Prosecutors",
    );
    assert.equal(
      duplicateInstances.length,
      expectedDuplicateUnits.length,
    );
    assert.equal(
      new Set(duplicateInstances.map((unit) => unit.label)).size,
      expectedDuplicateUnits.length,
    );
    assert.deepEqual(
      duplicateInstances.map((unit) => unit.label),
      expectedDuplicateUnits
        .map(
          (unit, index) =>
            `Prosecutors — ${unit.modelCount} models — ${unit.points} pts — Unit ${index + 1}`,
        ),
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
    const baselineReadiness = analyzeMissionReadiness(player);
    assert.ok(baselineReadiness.data);
    for (const candidate of candidates) {
      const modified = modifyRoster(player, candidate.operation);
      assert.equal(modified.ok, true, candidate.title);
      assert.ok(modified.data);
      assert.equal(validateRoster(modified.data).ok, true, candidate.title);
      assert.ok(
        modified.data.totalPoints / modified.data.pointsLimit >= 0.98,
        `${candidate.title} must use at least 98% of the points limit`,
      );
      const exported = await exportRoster(modified.data, "rosz");
      assert.equal(exported.ok, true, candidate.title);
      const revisedReadiness = analyzeMissionReadiness(modified.data);
      assert.ok(revisedReadiness.data);
      assert.equal(
        assessMissionReadinessRevisionGuardrail(
          baselineReadiness.data,
          revisedReadiness.data,
        ).accepted,
        true,
        candidate.title,
      );
      assert.equal(
        missionReadinessIsNoWorse(
          baselineReadiness.data,
          revisedReadiness.data,
        ),
        true,
        candidate.title,
      );
      assert.equal(candidate.beforePoints, player.totalPoints);
      assert.equal(candidate.afterPoints, modified.data.totalPoints);
      assert.ok(
        candidate.evidenceFindingIds.every((findingId) =>
          (analyzed.data?.findings ?? []).some(
            (finding) => finding.findingId === findingId,
          ),
        ),
      );
      for (const findingId of candidate.evidenceFindingIds) {
        const citedFinding: TesseraFinding | undefined =
          analyzed.data.findings?.find(
          (entry) => entry.findingId === findingId,
        );
        assert.ok(citedFinding);
        assert.equal(citedFinding.severity, "warn");
        assert.notEqual(citedFinding.confidence, "ambiguous");
        const selectionId =
          "selectionId" in candidate.operation
            ? candidate.operation.selectionId
            : null;
        assert.ok(
          citedFinding.kind === "role-gap" ||
            (selectionId !== null &&
              (citedFinding.unitInstanceIds.includes(selectionId) ||
                citedFinding.evidence.some((entry) => {
                  const affectedPlayerId =
                    entry.direction === "player-to-opponent"
                      ? entry.attackerInstanceId
                      : entry.targetInstanceId;
                  return affectedPlayerId === selectionId;
                }))),
          `${candidate.title} must cite an affected unit or role gap`,
        );
      }
      if (candidate.operation.type === "replace") {
        const replacedSelectionId =
          candidate.operation.selectionId;
        assert.equal(
          analyzed.data.findings?.some(
            (finding) =>
              finding.kind === "reliable-coverage" &&
              finding.evidence.some(
                (entry) =>
                  entry.direction === "player-to-opponent" &&
                  entry.attackerInstanceId ===
                    replacedSelectionId,
              ),
          ),
          false,
          `${candidate.title} must not replace a reliable answer`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("suppresses standalone findings and roster changes when captured evidence is aliased", async () => {
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Aliased Evidence Player",
  );
  const opponent = roster(
    "aeldari",
    1_000,
    "Aliased Evidence Opponent",
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-aliased-evidence-v2-"),
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
          const aliased = result.scenarios.find(
            (scenario) =>
              scenario.phase === "shooting" &&
              scenario.direction === "player-to-opponent" &&
              scenario.metric === "wipe-probability",
          );
          assert.ok(aliased?.matrixSha256);
          aliased.integrity = {
            status: "aliased",
            issueCodes: ["TESSERA_PHASE_MATRIX_ALIAS"],
            aliasedScenarioIds: [
              "fight:player-to-opponent:wipe-probability",
            ],
          };
          result.integrityIssues = [
            {
              code: "TESSERA_PHASE_MATRIX_ALIAS",
              scenarioIds: [
                aliased.id,
                "fight:player-to-opponent:wipe-probability",
              ],
              matrixSha256: aliased.matrixSha256,
              message:
                "Synthetic alias proves that partial standalone evidence must not produce claims.",
            },
          ];
          result.warnings.push(
            "[TESSERA_PHASE_MATRIX_ALIAS] Synthetic aliased matrix.",
          );
          return result;
        },
      },
    );

    assert.equal(analyzed.ok, false);
    assert.ok(analyzed.data);
    assert.equal(analyzed.data.status, "inconclusive");
    assert.ok(
      analyzed.data.simulation.scenarios?.some(
        (scenario) => scenario.status === "partial",
      ),
    );
    assert.deepEqual(analyzed.data.findings, []);
    assert.deepEqual(analyzed.data.changeCandidates, []);
    assert.deepEqual(analyzed.data.strengths, []);
    assert.deepEqual(analyzed.data.weaknesses, []);
    assert.deepEqual(analyzed.data.suggestions, []);
    assert.match(
      analyzed.data.warnings.join("\n"),
      /findings and roster-change candidates were suppressed/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requested simulation with zero matrices fails with retained preparation data", async () => {
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Strict Simulation Player",
  );
  const opponent = roster(
    "necrons",
    1_000,
    "Strict Simulation Opponent",
  );
  const requirements = aggregateProfileRequirements([player, opponent]);
  const profilePolicy = {
    schemaVersion: 1 as const,
    policyKind: "tessera-profile-policy" as const,
    entries: requirements.map((requirement) => ({
      faction: requirement.faction,
      unit: requirement.unit,
      weaponGroup: requirement.weaponGroup,
      phase: requirement.phase,
      selectedProfile: requirement.availableProfiles[0],
      activeCount: requirement.activeCount,
    })),
  };
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-strict-failure-"),
  );
  const deliverFixture = deliveryDependency(directory);
  let deliveryCalls = 0;
  const deliver = async (
    roster: RosterDraftV1,
    options?: NewRecruitDeliveryOptions,
  ) => {
    deliveryCalls += 1;
    return deliverFixture(roster, options);
  };
  const runBrowser = async () => {
    throw new TesseraAutomationError(
      "TESSERA_LIST_SELECTION_MISMATCH",
      "The imported list did not hydrate in the selector.",
    );
  };
  try {
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "simulate",
        fallbackMode: "baseline-damage-v1",
        profilePolicy,
        outputDirectory: directory,
        allowOutsideRoot: true,
      },
      {
        deliver,
        runBrowser,
      },
    );
    assert.equal(analyzed.ok, false);
    assert.ok(analyzed.data);
    assert.equal(analyzed.data.status, "failed");
    assert.equal(analyzed.data.source, "tessera-ui-failed");
    assert.equal(analyzed.data.preparation?.status, "complete");
    assert.equal(analyzed.data.simulation.status, "failed");
    assert.equal(analyzed.data.simulation.matrices.length, 0);
    assert.ok(
      analyzed.data.failures?.some(
        (failure) =>
          failure.code === "TESSERA_LIST_SELECTION_MISMATCH",
      ),
    );
    assert.equal(analyzed.data.artifacts.length, 3);
    assert.equal(
      analyzed.data.supplementalAnalyses?.[0]?.engine,
      "baseline-damage-v1",
    );
    assert.equal(analyzed.data.status, "failed");
    const serialized = JSON.parse(
      await readFile(analyzed.data.artifacts[0].written, "utf8"),
    ) as {
      artifacts: unknown[];
      status: string;
      runtime: { buildId: string };
      profilePolicyHash: string;
      pinnedData: { releaseId: string };
      failures: Array<{
        stage: string;
        code: string;
        opponentName: string | null;
        retryable: boolean;
      }>;
    };
    assert.equal(serialized.status, "failed");
    assert.equal(serialized.artifacts.length, 3);
    assert.ok(serialized.runtime.buildId);
    assert.match(serialized.profilePolicyHash, /^[0-9a-f]{64}$/);
    assert.equal(
      serialized.pinnedData.releaseId,
      player.sourceData.releaseId,
    );
    assert.ok(
      serialized.failures.some(
        (failure) =>
          failure.stage === "simulation" &&
          failure.code === "TESSERA_LIST_SELECTION_MISMATCH" &&
          failure.retryable,
      ),
    );
    const deliveryCallsAfterFirstAttempt = deliveryCalls;
    const retried = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "simulate",
        fallbackMode: "baseline-damage-v1",
        profilePolicy,
        outputDirectory: directory,
        allowOutsideRoot: true,
        overwrite: true,
      },
      { deliver, runBrowser },
    );
    assert.equal(retried.ok, false);
    assert.equal(retried.data?.status, "failed");
    assert.equal(deliveryCalls, deliveryCallsAfterFirstAttempt);
    assert.equal(retried.data?.preparation?.cacheReuses, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict direct simulation requires profile policy before delivery", async () => {
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Policy Preflight Player",
  );
  const opponent = roster(
    "necrons",
    1_000,
    "Policy Preflight Opponent",
  );
  assert.ok(
    aggregateProfileRequirements([player, opponent]).length > 0,
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-policy-preflight-"),
  );
  let deliveries = 0;
  try {
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "simulate",
        outputDirectory: directory,
        allowOutsideRoot: true,
      },
      {
        deliver: async () => {
          deliveries += 1;
          throw new Error("Delivery must not run before profile preflight.");
        },
      },
    );
    assert.equal(analyzed.ok, false);
    assert.equal(analyzed.data, null);
    assert.equal(
      analyzed.violations[0]?.code,
      "TESSERA_PROFILE_POLICY_REQUIRED",
    );
    assert.equal(deliveries, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale runtime identity blocks direct preparation before mutation", async () => {
  const player = roster("adeptus-custodes", 1_000, "Runtime Player");
  const opponent = roster("aeldari", 1_000, "Runtime Opponent");
  let deliveries = 0;
  const result = await analyzeRosterMatchup(
    player,
    { kind: "roster", roster: opponent },
    {
      executionMode: "prepare-only",
      outputDirectory: "unused-runtime-test",
    },
    {
      runtimeIssue: () => ({
        code: "RUNTIME_RESTART_REQUIRED",
        message: "Synthetic stale runtime.",
      }),
      deliver: async () => {
        deliveries += 1;
        throw new Error("Delivery must not start.");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.code, "RUNTIME_RESTART_REQUIRED");
  assert.equal(deliveries, 0);
});

test("rejects underfilled anti-Aeldari change candidates from the live roster shape", async () => {
  const builtPlayer = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Adeptus Custodes 1000 vs Aeldari",
    preferences: [
      "mobility",
      "durability",
      "objective",
      "shooting",
      "melee",
    ],
    requiredUnitIds: ["agamatus-custodians"],
  });
  assert.ok(builtPlayer.data);
  const player: RosterDraftV1 = {
    ...builtPlayer.data,
    constraints: {
      ...builtPlayer.data.constraints,
      requiredUnitIds: [],
    },
  };
  assert.equal(validateRoster(player).ok, true);
  assert.ok(
    player.units.some(
      (unit) => unit.unitId === "agamatus-custodians",
    ),
  );
  assert.ok(player.totalPoints >= 950);
  const opponent = roster("aeldari", 1_000, "Unknown Aeldari Proxy");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-candidate-quality-v2-"),
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
          for (const scenario of result.scenarios ?? []) {
            if (scenario.direction !== "player-to-opponent") continue;
            if (scenario.metric === "wipe-probability") {
              for (const cell of scenario.cells) {
                cell.metricValue = 0.1;
                cell.killProbability = 0.1;
              }
            }
            if (scenario.metric === "half-wipe-probability") {
              for (const cell of scenario.cells) {
                cell.metricValue = 0.2;
              }
            }
          }
          return result;
        },
      },
    );
    assert.equal(
      analyzed.ok,
      true,
      analyzed.violations
        .map((violation) => `${violation.code}: ${violation.message}`)
        .join("\n"),
    );
    assert.ok(analyzed.data);
    for (const candidate of analyzed.data.changeCandidates ?? []) {
      assert.ok(
        candidate.afterPoints >= 980,
        `${candidate.title} returned an underfilled ${candidate.afterPoints}-point roster`,
      );
      assert.doesNotMatch(
        candidate.title,
        /Replace Agamatus Custodians with (Prosecutors|Witchseekers|Knight-Centura)/,
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
          result.importIssues = [
            {
              code: "alternate-profile",
              side: "player",
              unit: player.units[0].name,
              weaponGroup: "Vaultswords",
              availableProfiles: ["Behemor", "Hurricanis"],
              phase: "fight",
              message: '"Vaultswords" has alternate profiles.',
              resolvedByPolicy: false,
            },
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
        .filter((scenario) => scenario.phase === "fight")
        .every((scenario) =>
          scenario.cells
            .filter((cell) => cell.attacker.name === player.units[0].name)
            .every(
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
            scenario.direction === "player-to-opponent" &&
            scenario.phase === "fight",
        )
        .every((scenario) =>
          scenario.cells
            .filter((cell) => cell.attacker.name !== player.units[0].name)
            .every((cell) => cell.confidence !== "ambiguous"),
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
        (finding) =>
          finding.kind === "reliable-coverage" &&
          finding.evidence.some(
            (entry) =>
              entry.phase === "fight" &&
              entry.attackerInstanceId ===
                analyzed.data?.player.units?.[0].instanceId,
          ),
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
    const modified = buildRoster({
      faction: "adeptus-custodes",
      pointsLimit: 2_000,
      name: "Approved Revision",
      preferences: ["objective"],
      excludedUnitIds: ["custodian-guard"],
    });
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
