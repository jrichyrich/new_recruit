import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  analyzeMissionReadiness,
  assessMissionReadinessRevisionGuardrail,
  buildRoster,
  exportRoster,
  getNewRecruitFactionSummary,
  inspectEnrichedProfileRequirements,
  modifyRoster,
  newRecruitCatalogue,
  rosterExecutionFingerprint,
  validateRoster,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
  type TesseraDirection,
  type TesseraFinding,
  type TesseraMatchupReport,
  type TesseraMetric,
  type TesseraPhase,
  type TesseraPreparedRoster,
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

function profilePolicyFor(...rosters: RosterDraftV1[]) {
  const requirements = aggregateProfileRequirements(rosters);
  const scaffold = profilePolicyScaffold(requirements);
  return {
    ...scaffold,
    entries: scaffold.entries.map((entry, index) => ({
      ...entry,
      selectedProfile: requirements[index].availableProfiles[0],
    })),
  };
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
  return artifactDeliveryDependency(fallbackDirectory);
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function enrichedFixture(
  roster: RosterDraftV1,
  enrichedOnlyAlternate = false,
): Uint8Array {
  const faction = getNewRecruitFactionSummary(roster.factionId)!;
  const canonicalRequirements = aggregateProfileRequirements([roster]);
  const selections = roster.units
    .map((unit, index) => {
      const canonicalProfiles = canonicalRequirements
        .filter(
          (requirement) =>
            requirement.selectionId === unit.selectionId,
        )
        .map(
          (requirement, requirementIndex) =>
            `<selection id="${xmlAttribute(
              unit.selectionId,
            )}-weapon-${requirementIndex}" name="${xmlAttribute(
              requirement.weaponGroup,
            )}" number="${requirement.activeCount}" type="upgrade">
              <profiles>
                ${requirement.availableProfiles
                  .map(
                    (profile) =>
                      `<profile name="➤ ${xmlAttribute(
                        requirement.weaponGroup,
                      )} - ${xmlAttribute(
                        profile,
                      )}" typeName="${
                        requirement.phase === "shooting"
                          ? "Ranged Weapons"
                          : "Melee Weapons"
                      }"/>`,
                  )
                  .join("")}
              </profiles>
            </selection>`,
        )
        .join("");
      return `
      <selection id="${xmlAttribute(unit.selectionId)}" name="${xmlAttribute(
        unit.name,
      )}" number="1" type="unit">
        <cost name="pts" value="${unit.points}"/>
        <profiles>
          <profile name="${xmlAttribute(
            unit.name,
          )} model" typeName="Unit"/>
          <profile name="${xmlAttribute(
            unit.name,
          )} weapon" typeName="Ranged Weapons"/>
        </profiles>
        <selections>
          <selection name="${xmlAttribute(
            unit.name,
          )}" number="${unit.modelCount}" type="model"/>
          ${canonicalProfiles}
          ${
            enrichedOnlyAlternate && index === 0
              ? `<selection id="${xmlAttribute(
                  unit.selectionId,
                )}-enriched-weapon" name="Synthetic bifurcator" number="1" type="upgrade">
            <profiles>
              <profile name="➤ Synthetic bifurcator - focused" typeName="Ranged Weapons"/>
              <profile name="➤ Synthetic bifurcator - dispersed" typeName="Ranged Weapons"/>
            </profiles>
          </selection>`
              : ""
          }
        </selections>
      </selection>`;
    })
    .join("");
  const xml = `<?xml version="1.0"?>
<roster name="${xmlAttribute(
    roster.name,
  )}" generatedBy="https://newrecruit.eu" gameSystemId="${xmlAttribute(
    newRecruitCatalogue.gameSystem.id,
  )}" gameSystemName="${xmlAttribute(
    newRecruitCatalogue.gameSystem.name,
  )}" gameSystemRevision="${roster.sourceData.newRecruit.gameSystemRevision}">
  <cost name="pts" value="${roster.totalPoints}"/>
  <forces>
    <force name="${xmlAttribute(
      roster.factionName,
    )}" catalogueId="${xmlAttribute(
      faction.catalogue.id,
    )}" catalogueName="${xmlAttribute(
      faction.catalogue.name,
    )}" catalogueRevision="${
      roster.sourceData.newRecruit.catalogueRevision ?? 0
    }">
      <selections>${selections}
      </selections>
    </force>
  </forces>
</roster>`;
  return zipSync({ "fixture.ros": strToU8(xml) });
}

async function canonicalEnrichedRoszFixture(
  roster: RosterDraftV1,
  gameSystemRevisionOffset = 0,
): Promise<Uint8Array> {
  const exported = await exportRoster(roster, "rosz");
  assert.equal(exported.ok, true);
  assert.ok(exported.data);
  assert.notEqual(typeof exported.data.content, "string");
  const files = unzipSync(exported.data.content as Uint8Array);
  const entry = Object.keys(files).find((name) => /\.ros$/i.test(name));
  assert.ok(entry);
  let xml = strFromU8(files[entry!])
    .replace(
      /generatedBy="[^"]*"/,
      'generatedBy="https://newrecruit.eu"',
    )
    .replace(
      /gameSystemRevision="\d+"/,
      `gameSystemRevision="${
        roster.sourceData.newRecruit.gameSystemRevision +
        gameSystemRevisionOffset
      }"`,
    );
  const profiles =
    '<profiles><profile name="Fixture model" typeName="Unit"/><profile name="Fixture weapon" typeName="Ranged Weapons"/></profiles>';
  let selectionDepth = 0;
  xml = xml.replace(
    /<selection\b[^>]*>|<\/selection>/g,
    (token) => {
      if (token === "</selection>") {
        selectionDepth -= 1;
        return token;
      }
      const topLevelRosterUnit =
        selectionDepth === 0 &&
        /\btype="(?:unit|model)"/.test(token);
      const selfClosing = token.endsWith("/>");
      if (!selfClosing) selectionDepth += 1;
      if (!topLevelRosterUnit) return token;
      return selfClosing
        ? `${token.slice(0, -2)}>${profiles}</selection>`
        : `${token}${profiles}`;
    },
  );
  files[entry!] = strToU8(xml);
  return zipSync(files);
}

function uploadedRoszFixture(
  roster: RosterDraftV1,
  options: {
    concreteCatalogue: boolean;
    profiledUnitCount: number;
    gameSystemRevisionOffset?: number;
    catalogueRevisionOffset?: number;
  },
): Uint8Array {
  const faction = getNewRecruitFactionSummary(roster.factionId)!;
  const selections = roster.units
    .map(
      (unit, index) => `
      <selection id="${xmlAttribute(unit.selectionId)}" name="${xmlAttribute(
        unit.name,
      )}" number="1" type="unit">
        <cost name="pts" value="${unit.points}"/>
        <selections>
          <selection name="${xmlAttribute(
            unit.name,
          )}" number="${unit.modelCount}" type="model"/>
        </selections>
        ${
          index < options.profiledUnitCount
            ? `<profiles>
          <profile name="${xmlAttribute(
            unit.name,
          )} model" typeName="Unit"/>
          <profile name="${xmlAttribute(
            unit.name,
          )} weapon" typeName="Ranged Weapons"/>
        </profiles>`
            : ""
        }
      </selection>`,
    )
    .join("");
  const gameSystemIdentity = options.concreteCatalogue
    ? ` gameSystemId="${xmlAttribute(
        newRecruitCatalogue.gameSystem.id,
      )}" gameSystemName="${xmlAttribute(
        newRecruitCatalogue.gameSystem.name,
      )}" gameSystemRevision="${
        roster.sourceData.newRecruit.gameSystemRevision +
        (options.gameSystemRevisionOffset ?? 0)
      }"`
    : "";
  const catalogueIdentity = options.concreteCatalogue
    ? ` catalogueId="${xmlAttribute(
        faction.catalogue.id,
      )}" catalogueRevision="${
        (roster.sourceData.newRecruit.catalogueRevision ?? 0) +
        (options.catalogueRevisionOffset ?? 0)
      }"`
    : "";
  const xml = `<?xml version="1.0"?>
<roster name="${xmlAttribute(
    roster.name,
  )}" generatedBy="https://newrecruit.eu"${gameSystemIdentity}>
  <cost name="pts" value="${roster.totalPoints}"/>
  <forces>
    <force name="${xmlAttribute(
      roster.factionName,
    )}" catalogueName="${xmlAttribute(
      faction.catalogue.name,
    )}"${catalogueIdentity}>
      <selections>${selections}</selections>
    </force>
  </forces>
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

function absolutePreparedRoster(
  prepared: TesseraPreparedRoster,
  outputDirectory: string,
): TesseraPreparedRoster {
  return {
    ...prepared,
    sourceRoszPath: path.isAbsolute(prepared.sourceRoszPath)
      ? prepared.sourceRoszPath
      : path.resolve(outputDirectory, prepared.sourceRoszPath),
    enrichedRoszPath: path.isAbsolute(
      prepared.enrichedRoszPath,
    )
      ? prepared.enrichedRoszPath
      : path.resolve(outputDirectory, prepared.enrichedRoszPath),
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
    uiIdentity: "fixture-tessera-ui-v1",
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
        profilePolicy: profilePolicyFor(player, opponent),
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
    assert.equal(
      analyzed.data.player.fingerprint,
      rosterExecutionFingerprint(player),
    );
    assert.equal(
      analyzed.data.opponents[0].fingerprint,
      rosterExecutionFingerprint(opponent),
    );
    assert.match(
      analyzed.data.player.enrichedRoszSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      analyzed.data.opponents[0].enrichedRoszSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
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
    assert.equal(
      browserInputs[0]?.savedListReuse?.player
        .rosterExecutionFingerprint,
      rosterExecutionFingerprint(player),
    );
    assert.equal(
      browserInputs[0]?.savedListReuse?.opponent
        .rosterExecutionFingerprint,
      rosterExecutionFingerprint(opponent),
    );
    assert.equal(
      browserInputs[0]?.savedListReuse?.player.runId,
      browserInputs[0]?.savedListReuse?.opponent.runId,
    );

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
    const persisted = JSON.parse(
      await readFile(analyzed.data.artifacts[0].written, "utf8"),
    ) as TesseraMatchupReport;
    assert.equal(
      path.isAbsolute(persisted.player.enrichedRoszPath),
      false,
    );
    assert.equal(
      path.isAbsolute(persisted.opponents[0].enrichedRoszPath),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exact analysis reserves report paths before New Recruit delivery", async () => {
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Output Collision Player",
  );
  const opponent = roster(
    "aeldari",
    1_000,
    "Output Collision Opponent",
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-output-collision-v2-"),
  );
  let deliveryCalls = 0;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "Output-Collision-Player-matchup.json"),
      "{}\n",
    );
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      { outputDirectory: directory, allowOutsideRoot: true },
      {
        deliver: async () => {
          deliveryCalls += 1;
          throw new Error("delivery must not run");
        },
      },
    );
    assert.equal(analyzed.ok, false);
    assert.equal(
      analyzed.violations[0]?.code,
      "TESSERA_OUTPUT_RESERVATION_FAILED",
    );
    assert.equal(deliveryCalls, 0);
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
        profilePolicy: profilePolicyFor(player, opponent),
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
    assert.equal(analyzed.data.artifacts.length, 4);
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
    assert.equal(serialized.artifacts.length, 4);
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
        experimental: true,
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

test("enriched-only alternate profiles stop before Tessera", async () => {
  const player = roster("adeptus-custodes", 1_000, "Enriched Player");
  const opponent = roster("necrons", 1_000, "Enriched Opponent");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-enriched-policy-"),
  );
  let browserCalls = 0;
  try {
    const deliver = async (
      candidate: RosterDraftV1,
      options: NewRecruitDeliveryOptions = {},
    ) => {
      const outputDirectory = options.outputDirectory ?? directory;
      await mkdir(outputDirectory, { recursive: true });
      const delivery = deliveryFor(candidate, outputDirectory);
      const content = enrichedFixture(
        candidate,
        candidate.id === opponent.id,
      );
      await Promise.all(
        delivery.data!.artifacts.map((artifact) =>
          writeFile(artifact.written, content),
        ),
      );
      return delivery;
    };
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        experimental: true,
        profilePolicy: profilePolicyFor(player, opponent),
        outputDirectory: directory,
        allowOutsideRoot: true,
      },
      {
        deliver,
        runBrowser: async () => {
          browserCalls += 1;
          return fullBrowserResult(player, opponent);
        },
      },
    );
    assert.equal(analyzed.ok, false);
    assert.ok(analyzed.data);
    assert.equal(
      analyzed.violations[0]?.code,
      "TESSERA_PROFILE_POLICY_REQUIRED_AFTER_ENRICHMENT",
    );
    assert.equal(browserCalls, 0);
    assert.equal(analyzed.data.simulation.matrices.length, 0);
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
        profilePolicy: profilePolicyFor(player, opponent),
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
        profilePolicy: profilePolicyFor(player, opponent),
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

    assert.equal(analyzed.ok, false);
    assert.ok(analyzed.data);
    assert.equal(analyzed.data.status, "inconclusive");
    assert.ok(
      analyzed.violations.some(
        (violation) =>
          violation.code === "TESSERA_PROFILE_POLICY_NOT_APPLIED",
      ),
    );
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
    assert.deepEqual(analyzed.data.findings, []);
    assert.deepEqual(analyzed.data.changeCandidates, []);
    assert.match(analyzed.data.warnings.join("\n"), /Vaultswords/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical exact matchups include the 5% points boundary and reject the next buildable total outside it", async () => {
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Tolerance Player",
  );
  const boundaryBuilt = roster(
    "necrons",
    950,
    "Boundary Opponent",
  );
  const outsideBuilt = roster(
    "necrons",
    949,
    "Outside Opponent",
  );
  const boundaryOpponent: RosterDraftV1 = {
    ...boundaryBuilt,
    pointsLimit: player.pointsLimit,
  };
  const outsideOpponent: RosterDraftV1 = {
    ...outsideBuilt,
    pointsLimit: player.pointsLimit,
  };
  assert.equal(boundaryOpponent.totalPoints, 950);
  assert.equal(outsideOpponent.totalPoints, 945);
  assert.equal(validateRoster(boundaryOpponent).ok, true);
  assert.equal(validateRoster(outsideOpponent).ok, true);

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-points-boundary-v2-"),
  );
  let deliveryCalls = 0;
  const artifactDelivery = artifactDeliveryDependency(directory);
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ) => {
    deliveryCalls += 1;
    return artifactDelivery(candidate, options);
  };
  try {
    const boundary = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: boundaryOpponent },
      {
        outputDirectory: path.join(directory, "boundary"),
        allowOutsideRoot: true,
      },
      { deliver },
    );
    assert.equal(
      boundary.ok,
      true,
      boundary.violations
        .map((violation) => `${violation.code}: ${violation.message}`)
        .join("\n"),
    );
    assert.equal(boundary.data?.pointsComparisons?.[0].difference, 50);
    assert.equal(
      boundary.data?.pointsComparisons?.[0].differencePercent,
      5,
    );
    assert.equal(boundary.data?.pointsComparisons?.[0].matched, true);
    assert.equal(boundary.data?.comparisonClass, "matched");
    assert.equal(deliveryCalls, 2);

    const outside = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: outsideOpponent },
      {
        outputDirectory: path.join(directory, "outside"),
        allowOutsideRoot: true,
      },
      { deliver },
    );
    assert.equal(outside.ok, false);
    assert.equal(outside.data, null);
    assert.equal(
      outside.violations[0]?.code,
      "TESSERA_POINTS_MISMATCH",
    );
    assert.match(outside.violations[0]?.message ?? "", /5\.5%/);
    assert.equal(deliveryCalls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks an unmatched roster unless the mismatch is explicitly allowed", async () => {
  const player = roster("adeptus-custodes", 1_000, "Mismatch Player");
  const fullOpponent = roster("necrons", 1_000, "Mismatch Opponent");
  const removable = [...fullOpponent.units]
    .filter((unit) => !unit.isWarlord)
    .sort((left, right) => right.points - left.points)[0];
  assert.ok(removable);
  const reduced = modifyRoster(fullOpponent, {
    type: "remove",
    selectionId: removable.selectionId,
  });
  assert.ok(reduced.data);
  const opponent = reduced.data;
  assert.ok(Math.abs(player.totalPoints - opponent.totalPoints) > 50);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-points-v2-"),
  );
  let deliveryCalls = 0;
  const artifactDelivery = artifactDeliveryDependency(directory);
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ) => {
    deliveryCalls += 1;
    return artifactDelivery(candidate, options);
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

test("canonical point-limit and source-pin mismatches stop before delivery", async () => {
  const player = roster("adeptus-custodes", 1_000, "Pinned Player");
  const differentLimit = roster("necrons", 2_000, "Different Limit");
  const samePinOpponent = roster("necrons", 1_000, "Different Pin");
  const differentPin: RosterDraftV1 = {
    ...samePinOpponent,
    sourceData: {
      ...samePinOpponent.sourceData,
      bundleId: "f".repeat(64),
      releaseId: `${samePinOpponent.sourceData.releaseId}-different`,
    },
  };
  const wrongEdition = {
    ...samePinOpponent,
    sourceData: {
      ...samePinOpponent.sourceData,
      edition: "10th",
    },
  } as unknown as RosterDraftV1;
  let deliveries = 0;
  const dependencies = {
    deliver: async () => {
      deliveries += 1;
      throw new Error("Preflight must stop before delivery.");
    },
  };

  const limitResult = await analyzeRosterMatchup(
    player,
    { kind: "roster", roster: differentLimit },
    { allowPointMismatch: true },
    dependencies,
  );
  assert.equal(limitResult.ok, false);
  assert.equal(
    limitResult.violations[0]?.code,
    "TESSERA_POINTS_LIMIT_MISMATCH",
  );

  const pinResult = await analyzeRosterMatchup(
    player,
    { kind: "roster", roster: differentPin },
    {},
    dependencies,
  );
  assert.equal(pinResult.ok, false);
  assert.equal(
    pinResult.violations[0]?.code,
    "TESSERA_DATA_PIN_MISMATCH",
  );

  const editionResult = await analyzeRosterMatchup(
    player,
    { kind: "roster", roster: wrongEdition },
    {},
    dependencies,
  );
  assert.equal(editionResult.ok, false);
  assert.equal(editionResult.data, null);
  assert.equal(
    editionResult.violations[0]?.code,
    "MALFORMED_ROSTER",
  );
  assert.match(
    editionResult.violations[0]?.message ?? "",
    /sourceData\.edition/,
  );
  assert.equal(deliveries, 0);
});

test("uploaded ROSZ points are preflighted before external mutation", async () => {
  const player = roster("adeptus-custodes", 1_000, "Upload Player");
  const uploadedOpponent = roster("necrons", 2_000, "Uploaded Opponent");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-upload-preflight-"),
  );
  const uploadedPath = path.join(directory, "opponent.rosz");
  await writeFile(
    uploadedPath,
    uploadedRoszFixture(uploadedOpponent, {
      concreteCatalogue: true,
      profiledUnitCount: uploadedOpponent.units.length,
    }),
  );
  let deliveries = 0;
  let enrichments = 0;
  try {
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "rosz", path: uploadedPath },
      {
        outputDirectory: path.join(directory, "report"),
        allowOutsideRoot: true,
      },
      {
        deliver: async () => {
          deliveries += 1;
          throw new Error("Player delivery must not start.");
        },
        enrich: async () => {
          enrichments += 1;
          throw new Error("Opponent enrichment must not start.");
        },
      },
    );
    assert.equal(analyzed.ok, false);
    assert.equal(analyzed.data, null);
    assert.equal(
      analyzed.violations[0]?.code,
      "TESSERA_POINTS_MISMATCH",
    );
    assert.equal(deliveries, 0);
    assert.equal(enrichments, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "uploaded ROSZ accepts only explicit forward game-system revision diagnostics without canonical context",
  async () => {
    const player = roster(
      "adeptus-custodes",
      1_000,
      "Revision Diagnostic Player",
    );
    const opponent = roster(
      "necrons",
      1_000,
      "Revision Diagnostic Opponent",
    );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "tessera-upload-revision-diagnostic-"),
    );
    const forwardPath = path.join(directory, "forward-opponent.rosz");
    const backwardPath = path.join(directory, "backward-opponent.rosz");
    await Promise.all([
      writeFile(
        forwardPath,
        uploadedRoszFixture(opponent, {
          concreteCatalogue: true,
          profiledUnitCount: opponent.units.length,
          gameSystemRevisionOffset: 1,
        }),
      ),
      writeFile(
        backwardPath,
        uploadedRoszFixture(opponent, {
          concreteCatalogue: true,
          profiledUnitCount: opponent.units.length,
          gameSystemRevisionOffset: -1,
        }),
      ),
    ]);
    let deliveryCalls = 0;
    const artifactDelivery = artifactDeliveryDependency(directory);
    const dependencies = {
      deliver: async (
        candidate: RosterDraftV1,
        options: NewRecruitDeliveryOptions = {},
      ) => {
        deliveryCalls += 1;
        return artifactDelivery(candidate, options);
      },
    };
    try {
      const strict = await analyzeRosterMatchup(
        player,
        { kind: "rosz", path: forwardPath },
        {
          outputDirectory: path.join(directory, "strict"),
          allowOutsideRoot: true,
        },
        dependencies,
      );
      assert.equal(strict.ok, false);
      assert.equal(
        strict.violations[0]?.code,
        "TESSERA_ROSZ_GAME_SYSTEM_MISMATCH",
      );
      assert.equal(deliveryCalls, 0);

      const backward = await analyzeRosterMatchup(
        player,
        { kind: "rosz", path: backwardPath },
        {
          catalogueDriftMode: "diagnostic",
          outputDirectory: path.join(directory, "backward"),
          allowOutsideRoot: true,
        },
        dependencies,
      );
      assert.equal(backward.ok, false);
      assert.equal(
        backward.violations[0]?.code,
        "TESSERA_ROSZ_GAME_SYSTEM_MISMATCH",
      );
      assert.equal(deliveryCalls, 0);

      const diagnostic = await analyzeRosterMatchup(
        player,
        { kind: "rosz", path: forwardPath },
        {
          catalogueDriftMode: "diagnostic",
          outputDirectory: path.join(directory, "diagnostic"),
          allowOutsideRoot: true,
        },
        dependencies,
      );
      assert.equal(
        diagnostic.ok,
        true,
        JSON.stringify(diagnostic.violations),
      );
      assert.equal(diagnostic.data?.status, "prepared");
      assert.equal(deliveryCalls, 1);
      assert.equal(
        diagnostic.data?.opponents[0]?.catalogueProvenance?.status,
        "drift",
      );
      assert.deepEqual(
        diagnostic.data?.opponents[0]?.catalogueProvenance?.mismatches.map(
          (mismatch) => mismatch.field,
        ),
        ["game-system-revision"],
      );
      assert.ok(
        diagnostic.data?.warnings.some((warning) =>
          warning.includes(
            "Diagnostic mode accepted the identity-verified, profile-complete uploaded opponent despite a newer game-system revision",
          ),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "canonical uploaded ROSZ diagnostic accepts frozen revision 7 versus enriched revision 8 through preflight",
  async () => {
    const player = roster(
      "adeptus-custodes",
      1_000,
      "Context Revision Player",
    );
    const opponent = roster(
      "necrons",
      1_000,
      "Context Revision Opponent",
    );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "tessera-context-revision-diagnostic-"),
    );
    const uploadedPath = path.join(directory, "enriched-revision-8.rosz");
    await writeFile(
      uploadedPath,
      await canonicalEnrichedRoszFixture(opponent, 1),
    );
    let deliveryCalls = 0;
    const artifactDelivery = artifactDeliveryDependency(directory);
    const dependencies = {
      deliver: async (
        candidate: RosterDraftV1,
        options: NewRecruitDeliveryOptions = {},
      ) => {
        deliveryCalls += 1;
        return artifactDelivery(candidate, options);
      },
    };
    try {
      const strict = await analyzeRosterMatchup(
        player,
        { kind: "rosz", path: uploadedPath },
        {
          opponentRosterContext: opponent,
          outputDirectory: path.join(directory, "strict"),
          allowOutsideRoot: true,
        },
        dependencies,
      );
      assert.equal(strict.ok, false);
      assert.equal(
        strict.violations[0]?.code,
        "TESSERA_ROSZ_GAME_SYSTEM_MISMATCH",
      );
      assert.equal(deliveryCalls, 0);

      const diagnostic = await analyzeRosterMatchup(
        player,
        { kind: "rosz", path: uploadedPath },
        {
          opponentRosterContext: opponent,
          catalogueDriftMode: "diagnostic",
          outputDirectory: path.join(directory, "diagnostic"),
          allowOutsideRoot: true,
        },
        dependencies,
      );
      assert.equal(
        diagnostic.ok,
        true,
        JSON.stringify(diagnostic.violations),
      );
      assert.equal(diagnostic.data?.status, "prepared");
      assert.equal(deliveryCalls, 1);
      assert.equal(
        diagnostic.data?.opponents[0]?.fingerprint,
        rosterExecutionFingerprint(opponent),
      );
      assert.equal(
        diagnostic.data?.opponents[0]?.catalogueProvenance?.status,
        "drift",
      );
      assert.deepEqual(
        diagnostic.data?.opponents[0]?.catalogueProvenance?.mismatches.map(
          (mismatch) => mismatch.field,
        ),
        ["game-system-revision"],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "raw uploaded ROSZ without verifiable provenance stops before player delivery",
  async () => {
    const player = roster(
      "adeptus-custodes",
      1_000,
      "Raw Upload Player",
    );
    const opponent = roster(
      "necrons",
      1_000,
      "Raw Upload Opponent",
    );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "tessera-raw-unverified-v2-"),
    );
    const uploadedPath = path.join(directory, "raw-opponent.rosz");
    await writeFile(
      uploadedPath,
      uploadedRoszFixture(opponent, {
        concreteCatalogue: false,
        profiledUnitCount: opponent.units.length,
      }),
    );
    let deliveryCalls = 0;
    let browserCalls = 0;
    const artifactDelivery = artifactDeliveryDependency(directory);
    try {
      const analyzed = await analyzeRosterMatchup(
        player,
        { kind: "rosz", path: uploadedPath },
        {
          executionMode: "simulate",
          catalogueDriftMode: "diagnostic",
          profilePolicy: profilePolicyFor(player),
          outputDirectory: path.join(directory, "report"),
          allowOutsideRoot: true,
        },
        {
          deliver: async (candidate, options = {}) => {
            deliveryCalls += 1;
            return artifactDelivery(candidate, options);
          },
          runBrowser: async () => {
            browserCalls += 1;
            throw new Error("Browser must not run.");
          },
        },
      );
      assert.equal(analyzed.ok, false);
      assert.equal(
        analyzed.violations[0]?.code,
        "TESSERA_ROSZ_PROVENANCE_UNVERIFIABLE",
      );
      assert.equal(deliveryCalls, 0);
      assert.equal(analyzed.data, null);
      assert.equal(browserCalls, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "raw uploaded ROSZ with a stale catalogue revision stops before player delivery",
  async () => {
    const player = roster(
      "adeptus-custodes",
      1_000,
      "Stale Upload Player",
    );
    const opponent = roster(
      "necrons",
      1_000,
      "Stale Upload Opponent",
    );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "tessera-raw-stale-v2-"),
    );
    const uploadedPath = path.join(directory, "stale-opponent.rosz");
    await writeFile(
      uploadedPath,
      uploadedRoszFixture(opponent, {
        concreteCatalogue: true,
        profiledUnitCount: opponent.units.length,
        catalogueRevisionOffset: 1,
      }),
    );
    let deliveryCalls = 0;
    try {
      const analyzed = await analyzeRosterMatchup(
        player,
        { kind: "rosz", path: uploadedPath },
        {
          executionMode: "simulate",
          catalogueDriftMode: "diagnostic",
          profilePolicy: profilePolicyFor(player),
          outputDirectory: path.join(directory, "report"),
          allowOutsideRoot: true,
        },
        {
          deliver: async () => {
            deliveryCalls += 1;
            throw new Error("Player delivery must not start.");
          },
          runBrowser: async () => {
            throw new Error("Tessera must not start.");
          },
        },
      );
      assert.equal(analyzed.ok, false);
      assert.equal(analyzed.data, null);
      assert.equal(
        analyzed.violations[0]?.code,
        "TESSERA_ROSZ_DATA_PIN_MISMATCH",
      );
      assert.equal(deliveryCalls, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "uploaded ROSZ profile completeness is checked for every canonical opponent unit",
  async () => {
    const player = roster(
      "adeptus-custodes",
      1_000,
      "Partial Profile Player",
    );
    const opponent = roster(
      "necrons",
      1_000,
      "Partial Profile Opponent",
    );
    assert.ok(opponent.units.length > 1);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "tessera-partial-profiles-v2-"),
    );
    const uploadedPath = path.join(directory, "partial-opponent.rosz");
    await writeFile(
      uploadedPath,
      uploadedRoszFixture(opponent, {
        concreteCatalogue: true,
        profiledUnitCount: 1,
        gameSystemRevisionOffset: 1,
      }),
    );
    let deliveryCalls = 0;
    const artifactDelivery = artifactDeliveryDependency(directory);
    try {
      const analyzed = await analyzeRosterMatchup(
        player,
        { kind: "rosz", path: uploadedPath },
        {
          opponentRosterContext: opponent,
          catalogueDriftMode: "diagnostic",
          outputDirectory: path.join(directory, "report"),
          allowOutsideRoot: true,
        },
        {
          deliver: async (candidate, options = {}) => {
            deliveryCalls += 1;
            return artifactDelivery(candidate, options);
          },
        },
      );
      assert.equal(analyzed.ok, false);
      assert.equal(analyzed.data, null);
      assert.equal(
        analyzed.violations[0]?.code,
        "TESSERA_ROSZ_PROFILES_INCOMPLETE",
      );
      assert.equal(deliveryCalls, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
  const frozenProfilePolicy = profilePolicyFor(player, opponent);
  try {
    const deliver = artifactDeliveryDependency(directory);
    const baseline = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        experimental: true,
        profilePolicy: frozenProfilePolicy,
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
        profilePolicy: frozenProfilePolicy,
        outputDirectory: path.join(directory, "revision"),
        allowOutsideRoot: true,
      },
      {
        deliver,
        runBrowser: async () =>
          fullBrowserResult(modified.data!, opponent),
      },
    );

    assert.equal(
      compared.ok,
      true,
      compared.violations
        .map((violation) => `${violation.code}: ${violation.message}`)
        .join("\n"),
    );
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
    assert.equal(compared.data.aggregates?.length, 8);
    assert.ok(
      compared.data.aggregates?.every(
        (aggregate) =>
          aggregate.expectedScenarios === 2 &&
          aggregate.applicableScenarios === 2 &&
          aggregate.classification === "unchanged",
      ),
    );
    assert.deepEqual(compared.data.summary.aggregateCounts, {
      improved: 0,
      worsened: 0,
      unchanged: 8,
      ambiguous: 0,
      applicable: 8,
      total: 8,
    });
    assert.equal(compared.data.summary.conclusion, "unchanged");
    assert.match(
      await readFile(compared.data.artifacts[1].written, "utf8"),
      /trusted roster aggregates/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relocated exact reports resolve relative artifacts and reject content-addressed opponent tampering", async () => {
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Portable Baseline Player",
  );
  const opponent = roster(
    "necrons",
    1_000,
    "Portable Baseline Opponent",
  );
  const profilePolicy = profilePolicyFor(player, opponent);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-portable-baseline-v2-"),
  );
  let revisionDeliveryCalls = 0;
  try {
    const deliver = artifactDeliveryDependency(directory);
    const baselineDirectory = path.join(directory, "baseline");
    const baseline = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "simulate",
        profilePolicy,
        outputDirectory: baselineDirectory,
        allowOutsideRoot: true,
      },
      {
        deliver,
        runBrowser: async () => fullBrowserResult(player, opponent),
      },
    );
    assert.equal(
      baseline.ok,
      true,
      baseline.violations
        .map((violation) => `${violation.code}: ${violation.message}`)
        .join("\n"),
    );
    assert.ok(baseline.data);

    const relocatedDirectory = path.join(directory, "relocated");
    await cp(baselineDirectory, relocatedDirectory, {
      recursive: true,
    });
    const relocatedReportPath = path.join(
      relocatedDirectory,
      path.basename(baseline.data.artifacts[0].written),
    );
    const portable = JSON.parse(
      await readFile(relocatedReportPath, "utf8"),
    ) as TesseraMatchupReport;
    assert.equal(path.isAbsolute(portable.player.sourceRoszPath), false);
    assert.equal(path.isAbsolute(portable.player.enrichedRoszPath), false);
    assert.equal(
      path.isAbsolute(portable.opponents[0].enrichedRoszPath),
      false,
    );

    const revisionDeliver = async (
      candidate: RosterDraftV1,
      options: NewRecruitDeliveryOptions = {},
    ) => {
      revisionDeliveryCalls += 1;
      return deliver(candidate, options);
    };
    const relocated = await compareRosterRevision(
      relocatedReportPath,
      player,
      {
        executionMode: "simulate",
        profilePolicy,
        outputDirectory: path.join(directory, "relocated-revision"),
        allowOutsideRoot: true,
      },
      {
        deliver: revisionDeliver,
        runBrowser: async () => fullBrowserResult(player, opponent),
      },
    );
    assert.equal(
      relocated.ok,
      true,
      relocated.violations
        .map((violation) => `${violation.code}: ${violation.message}`)
        .join("\n"),
    );
    assert.ok(revisionDeliveryCalls > 0);

    const opponentArtifactPath = path.resolve(
      path.dirname(relocatedReportPath),
      portable.opponents[0].enrichedRoszPath,
    );
    await writeFile(opponentArtifactPath, "tampered archive");
    const deliveriesBeforeTamperCheck = revisionDeliveryCalls;
    const tampered = await compareRosterRevision(
      relocatedReportPath,
      player,
      {
        executionMode: "simulate",
        profilePolicy,
        outputDirectory: path.join(directory, "tampered-revision"),
        allowOutsideRoot: true,
      },
      {
        deliver: revisionDeliver,
        runBrowser: async () => {
          throw new Error("Browser must not run for a tampered baseline.");
        },
      },
    );
    assert.equal(tampered.ok, false);
    assert.equal(tampered.data, null);
    assert.equal(
      tampered.violations[0]?.code,
      "TESSERA_BASELINE_OPPONENT_ARTIFACT_CHANGED",
    );
    assert.equal(revisionDeliveryCalls, deliveriesBeforeTamperCheck);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revision deltas apply metric-specific materiality thresholds", async () => {
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Materiality Baseline",
  );
  const opponent = roster(
    "necrons",
    1_000,
    "Materiality Opponent",
  );
  const profilePolicy = profilePolicyFor(player, opponent);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-materiality-"),
  );
  try {
    const deliver = artifactDeliveryDependency(directory);
    const baseline = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        experimental: true,
        profilePolicy,
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

    const compared = await compareRosterRevision(
      baseline.data.artifacts[0].written,
      player,
      {
        experimental: true,
        profilePolicy,
        outputDirectory: path.join(directory, "revision"),
        allowOutsideRoot: true,
      },
      {
        deliver,
        runBrowser: async () => {
          const result = fullBrowserResult(player, opponent);
          for (const scenario of result.scenarios) {
            const beneficialSign =
              scenario.direction === "player-to-opponent" ? 1 : -1;
            const delta =
              scenario.metric === "wipe-probability"
                ? 0.05
                : scenario.metric === "half-wipe-probability"
                  ? 0.04
                  : scenario.metric === "mean-kills"
                    ? 0.5
                    : 1;
            for (const cell of scenario.cells) {
              cell.metricValue += beneficialSign * delta;
            }
          }
          return result;
        },
      },
    );
    assert.equal(
      compared.ok,
      true,
      compared.violations
        .map((violation) => `${violation.code}: ${violation.message}`)
        .join("\n"),
    );
    assert.ok(compared.data);
    const classifications = (metric: TesseraMetric) =>
      new Set(
        compared.data!.deltas
          .filter((delta) => delta.metric === metric)
          .map((delta) => delta.classification),
      );
    assert.deepEqual(classifications("wipe-probability"), new Set(["improved"]));
    assert.deepEqual(classifications("half-wipe-probability"), new Set(["unchanged"]));
    assert.deepEqual(classifications("mean-kills"), new Set(["improved"]));
    assert.deepEqual(classifications("mean-damage"), new Set(["improved"]));
    const aggregateClassifications = (metric: TesseraMetric) =>
      new Set(
        compared.data!.aggregates
          ?.filter((aggregate) => aggregate.metric === metric)
          .map((aggregate) => aggregate.classification),
      );
    assert.deepEqual(
      aggregateClassifications("wipe-probability"),
      new Set(["improved"]),
    );
    assert.deepEqual(
      aggregateClassifications("half-wipe-probability"),
      new Set(["unchanged"]),
    );
    assert.deepEqual(
      aggregateClassifications("mean-kills"),
      new Set(["improved"]),
    );
    assert.deepEqual(
      aggregateClassifications("mean-damage"),
      new Set(["improved"]),
    );
    assert.equal(
      compared.data.aggregates?.find(
        (aggregate) => aggregate.metric === "wipe-probability",
      )?.materialityThreshold,
      0.05,
    );
    assert.equal(
      compared.data.aggregates?.find(
        (aggregate) => aggregate.metric === "mean-kills",
      )?.materialityThreshold,
      0.5,
    );
    assert.equal(
      compared.data.aggregates?.find(
        (aggregate) => aggregate.metric === "mean-damage",
      )?.materialityThreshold,
      1,
    );
    assert.equal(compared.data.summary.conclusion, "improved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revision conclusion uses roster aggregates instead of cell votes", async () => {
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Aggregate Baseline",
  );
  const opponent = roster(
    "necrons",
    1_000,
    "Aggregate Opponent",
  );
  const profilePolicy = profilePolicyFor(player, opponent);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-aggregate-conclusion-"),
  );
  try {
    const deliver = artifactDeliveryDependency(directory);
    const baseline = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        experimental: true,
        profilePolicy,
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

    const compared = await compareRosterRevision(
      baseline.data.artifacts[0].written,
      player,
      {
        experimental: true,
        profilePolicy,
        outputDirectory: path.join(directory, "revision"),
        allowOutsideRoot: true,
      },
      {
        deliver,
        runBrowser: async () => {
          const result = fullBrowserResult(player, opponent);
          for (const scenario of result.scenarios) {
            if (
              scenario.metric !== "mean-damage" ||
              scenario.direction !== "opponent-to-player"
            ) {
              continue;
            }
            const lastCell = scenario.cells.length - 1;
            for (const [index, cell] of scenario.cells.entries()) {
              cell.metricValue =
                index === lastCell
                  ? cell.metricValue + scenario.cells.length * 3
                  : Math.max(0, cell.metricValue - 1.1);
              cell.expectedDamage = cell.metricValue;
            }
            scenario.matrixSha256 = crypto
              .createHash("sha256")
              .update(
                JSON.stringify({
                  phase: scenario.phase,
                  metric: scenario.metric,
                  direction: scenario.direction,
                  cells: scenario.cells,
                }),
              )
              .digest("hex");
          }
          return result;
        },
      },
    );
    assert.equal(
      compared.ok,
      true,
      compared.violations
        .map((violation) => `${violation.code}: ${violation.message}`)
        .join("\n"),
    );
    assert.ok(compared.data);
    assert.ok(
      compared.data.summary.improved > 0 &&
        compared.data.summary.worsened > 0,
      "cell votes are deliberately mixed in this fixture",
    );
    assert.deepEqual(compared.data.summary.aggregateCounts, {
      improved: 0,
      worsened: 1,
      unchanged: 7,
      ambiguous: 0,
      applicable: 8,
      total: 8,
    });
    assert.equal(compared.data.summary.conclusion, "worsened");
    const defensiveDamage = compared.data.aggregates?.find(
      (aggregate) =>
        aggregate.metric === "mean-damage" &&
        aggregate.direction === "opponent-to-player",
    );
    assert.equal(defensiveDamage?.classification, "worsened");
    assert.ok((defensiveDamage?.directionalChange ?? 0) < -1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exact retries reuse hash-verified prepared archives without New Recruit redelivery", async () => {
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Prepared checkpoint player",
  );
  const opponent = roster(
    "aeldari",
    1_000,
    "Prepared checkpoint opponent",
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-prepared-checkpoint-"),
  );
  const firstOutput = path.join(directory, "attempt-1");
  let deliveries = 0;
  const deliver = artifactDeliveryDependency(directory);
  try {
    const first = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "prepare-only",
        outputDirectory: firstOutput,
        allowOutsideRoot: true,
      },
      {
        deliver: async (candidate, deliveryOptions) => {
          deliveries += 1;
          return deliver(candidate, deliveryOptions);
        },
      },
    );
    assert.equal(first.ok, true);
    assert.ok(first.data);
    assert.equal(deliveries, 2);
    const frozenOpponent = first.data.opponents[0];
    assert.ok(frozenOpponent.sourceRoszPath);
    assert.ok(frozenOpponent.sourceRoszSha256);
    assert.ok(frozenOpponent.enrichedRoszSha256);
    assert.ok(frozenOpponent.fingerprint);
    const checkpoint = {
      player: absolutePreparedRoster(
        first.data.player,
        firstOutput,
      ),
      opponent: absolutePreparedRoster(
        {
          rosterId: frozenOpponent.fingerprint,
          rosterName: frozenOpponent.rosterName,
          factionId: opponent.factionId,
          listUrl: null,
          sourceRoszPath: frozenOpponent.sourceRoszPath,
          enrichedRoszPath:
            frozenOpponent.enrichedRoszPath,
          sourceRoszSha256:
            frozenOpponent.sourceRoszSha256,
          enrichedRoszSha256:
            frozenOpponent.enrichedRoszSha256,
          summary: frozenOpponent.summary,
          fingerprint: frozenOpponent.fingerprint,
          units: frozenOpponent.units,
          catalogueProvenance:
            frozenOpponent.catalogueProvenance,
        },
        firstOutput,
      ),
      sourceAttempt: 1,
    };

    const second = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "prepare-only",
        outputDirectory: path.join(directory, "attempt-2"),
        allowOutsideRoot: true,
        preparedReuse: checkpoint,
      },
      {
        deliver: async () => {
          deliveries += 1;
          throw new Error(
            "New Recruit must not be called for a verified checkpoint.",
          );
        },
      },
    );
    assert.equal(
      second.ok,
      true,
      second.violations.map((issue) => issue.message).join("\n"),
    );
    assert.ok(second.data);
    assert.ok(second.data.preparation);
    assert.equal(deliveries, 2);
    assert.equal(second.data.preparation.remoteMutations, 0);
    assert.equal(second.data.preparation.cacheReuses, 2);

    await writeFile(
      checkpoint.opponent.enrichedRoszPath,
      "tampered checkpoint",
    );
    const tampered = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "prepare-only",
        outputDirectory: path.join(directory, "attempt-3"),
        allowOutsideRoot: true,
        preparedReuse: checkpoint,
      },
      {
        deliver: async () => {
          deliveries += 1;
          throw new Error("Tampered checkpoints must fail closed.");
        },
      },
    );
    assert.equal(tampered.ok, false);
    assert.equal(
      tampered.violations[0]?.code,
      "TESSERA_PREPARED_ARTIFACT_DRIFT",
    );
    assert.equal(deliveries, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
