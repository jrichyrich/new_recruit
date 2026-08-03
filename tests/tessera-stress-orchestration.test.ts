import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "fflate";

import {
  buildRoster,
  exportRoster,
  generateFactionStressPortfolio,
  getNewRecruitFactionSummary,
  newRecruitCatalogue,
  previewFactionStressPortfolio,
  repairRosterDeterministically,
  rosterProfileRequirements,
  setCachedDataFreshness,
  type EnrichedRoszSummary,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
  type TesseraDirection,
  type TesseraMetric,
  type TesseraPhase,
  type TesseraProfileRequirement,
} from "../lib/rosterpilot";
import {
  aggregateProfileRequirements,
} from "../local/tessera/profile-policy";
import { TesseraAutomationError } from "../local/tessera/browser";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import type {
  TesseraBrowserInput,
  TesseraBrowserResult,
  TesseraScenario,
} from "../local/tessera/browser";
import {
  combineTesseraUiIdentities,
  compareRosterStressRevision,
  runRosterStressTest,
  verifyAndMigrateTesseraStressManifest,
} from "../local/tessera/stress";
import {
  buildAndStressRosterAgainstFaction,
} from "../local/tessera/full-loop";
import {
  startTesseraRun,
  type TesseraRunRequest,
} from "../local/tessera/jobs";

function roster(
  faction: string,
  pointsLimit: number,
  name: string,
): RosterDraftV1 {
  const built = buildRoster({ faction, pointsLimit, name });
  assert.equal(
    built.ok,
    true,
    built.violations.map((violation) => violation.message).join("\n"),
  );
  assert.ok(built.data);
  return built.data;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function portfolioContentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function summaryFor(candidate: RosterDraftV1): EnrichedRoszSummary {
  const faction = getNewRecruitFactionSummary(candidate.factionId)!;
  return {
    rosterName: candidate.name,
    factionName: candidate.factionName,
    totalPoints: candidate.totalPoints,
    generatedBy: "https://newrecruit.eu",
    observedNewRecruitCatalogue: {
      source: "new-recruit-enriched-rosz",
      gameSystem: {
        id: newRecruitCatalogue.gameSystem.id,
        name: newRecruitCatalogue.gameSystem.name,
        revision: candidate.sourceData.newRecruit.gameSystemRevision,
      },
      catalogues: [
        {
          id: faction.catalogue.id,
          name: faction.catalogue.name,
          revision: candidate.sourceData.newRecruit.catalogueRevision,
        },
      ],
    },
    profileCount: 2,
    weaponProfileCount: 1,
    units: candidate.units.map((unit) => ({
      selectionId: unit.selectionId,
      name: unit.name,
      modelCount: unit.modelCount,
      ordinal: unit.ordinal,
      points: unit.points,
    })),
  };
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function enrichedFixture(
  candidate: RosterDraftV1,
  additionalRequirements: TesseraProfileRequirement[] = [],
): Promise<Uint8Array> {
  const requirements = [
    ...rosterProfileRequirements(candidate),
    ...additionalRequirements,
  ];
  const exported = await exportRoster(candidate, "rosz");
  assert.ok(exported.ok && exported.data);
  assert.notEqual(typeof exported.data.content, "string");
  const entries = unzipSync(exported.data.content as Uint8Array);
  const [filename, content] = Object.entries(entries)[0];
  let xml = strFromU8(content).replace(
    'generatedBy="RosterPilot"',
    'generatedBy="https://newrecruit.eu"',
  );
  const insertions = new Map<number, string[]>();
  const selectionTokens = [
    ...xml.matchAll(/<selection\b[^>]*>|<\/selection>/g),
  ];
  const stack: Array<{ unitIndex: number | null }> = [];
  const unitRootInsertion = new Map<number, number>();
  let nextUnitIndex = 0;
  const matchedRequirements = new Set<TesseraProfileRequirement>();
  for (const tokenMatch of selectionTokens) {
    const token = tokenMatch[0];
    if (token === "</selection>") {
      stack.pop();
      continue;
    }
    const name = token.match(/\bname="([^"]*)"/)?.[1] ?? "";
    const type = token.match(/\btype="([^"]*)"/)?.[1] ?? "";
    let unitIndex = stack[0]?.unitIndex ?? null;
    if (
      stack.length === 0 &&
      (type === "unit" || type === "model")
    ) {
      const candidateIndex = candidate.units.findIndex(
        (unit, index) =>
          index >= nextUnitIndex &&
          xmlAttribute(unit.name).toLocaleLowerCase() ===
            name.toLocaleLowerCase(),
      );
      if (candidateIndex >= 0) {
        unitIndex = candidateIndex;
        nextUnitIndex = candidateIndex + 1;
      }
    }
    const insertionIndex =
      (tokenMatch.index ?? 0) + token.length;
    if (stack.length === 0 && unitIndex !== null) {
      unitRootInsertion.set(unitIndex, insertionIndex);
      insertions.set(insertionIndex, [
        ...(insertions.get(insertionIndex) ?? []),
        '<profiles><profile name="Fixture model" typeName="Unit"/><profile name="Fixture weapon" typeName="Ranged Weapons"/></profiles>',
      ]);
    }
    if (unitIndex !== null) {
      const matching = requirements.filter(
        (requirement) =>
          requirement.selectionId ===
            candidate.units[unitIndex!].selectionId &&
          xmlAttribute(requirement.weaponGroup) === name,
      );
      for (const requirement of matching) {
        matchedRequirements.add(requirement);
        insertions.set(insertionIndex, [
          ...(insertions.get(insertionIndex) ?? []),
          `<profiles>${requirement.availableProfiles
            .map(
              (profile) =>
                `<profile name="${xmlAttribute(
                  `➤ ${requirement.weaponGroup} - ${profile}`,
                )}" typeName="${
                  requirement.phase === "shooting"
                    ? "Ranged Weapons"
                    : "Melee Weapons"
                }"/>`,
            )
            .join("")}</profiles>`,
        ]);
      }
    }
    if (!token.endsWith("/>")) stack.push({ unitIndex });
  }
  for (const [unitIndex, unit] of candidate.units.entries()) {
    const unmatched = requirements.filter(
      (requirement) =>
        requirement.selectionId === unit.selectionId &&
        !matchedRequirements.has(requirement),
    );
    if (unmatched.length === 0) continue;
    const insertionIndex = unitRootInsertion.get(unitIndex);
    if (insertionIndex === undefined) continue;
    insertions.set(insertionIndex, [
      ...(insertions.get(insertionIndex) ?? []),
      ...unmatched.map(
        (requirement) =>
          `<profiles>${requirement.availableProfiles
            .map(
              (profile) =>
                `<profile name="${xmlAttribute(
                  `➤ ${requirement.weaponGroup} - ${profile}`,
                )}" typeName="${
                  requirement.phase === "shooting"
                    ? "Ranged Weapons"
                    : "Melee Weapons"
                }"/>`,
            )
            .join("")}</profiles>`,
      ),
    ]);
  }
  for (const [index, additions] of [...insertions.entries()].sort(
    ([left], [right]) => right - left,
  )) {
    xml = `${xml.slice(0, index)}${additions.join("")}${xml.slice(index)}`;
  }
  return zipSync({ [filename]: strToU8(xml) });
}

function occurrenceAt(
  candidate: RosterDraftV1,
  index: number,
): number {
  const name = candidate.units[index].name;
  return (
    candidate.units
      .slice(0, index + 1)
      .filter((unit) => unit.name === name).length
  );
}

function metricValue(
  metric: TesseraMetric,
  direction: TesseraDirection,
  opponent: RosterDraftV1,
): number {
  const variant = createHash("sha256")
    .update(opponent.id)
    .digest()
    .readUInt32BE(0);
  const offset = (variant / 0xffffffff) * 0.01;
  if (metric === "half-wipe-probability") {
    return direction === "player-to-opponent"
      ? 0.75 + offset
      : 0.25 + offset;
  }
  if (metric === "wipe-probability") {
    return direction === "player-to-opponent"
      ? 0.55 + offset
      : 0.2 + offset;
  }
  if (metric === "mean-kills") {
    return direction === "player-to-opponent"
      ? 3 + offset
      : 1 + offset;
  }
  return direction === "player-to-opponent"
    ? 5 + offset
    : 2 + offset;
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
  const value = metricValue(metric, direction, opponent);
  const matrixSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        opponentId: opponent.id,
        phase,
        metric,
        direction,
        attackerCount: attackers.units.length,
        targetCount: targets.units.length,
        value,
      }),
    )
    .digest("hex");
  return {
    id: `${phase}:${metric}:${direction}`,
    phase,
    metric,
    direction,
    settings: { phase, metric, direction },
    iterations: 1_000,
    matrixSha256,
    integrity: {
      status: "trusted",
      issueCodes: [],
      aliasedScenarioIds: [],
    },
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

function browserResult(
  input: TesseraBrowserInput,
  player: RosterDraftV1,
  opponent: RosterDraftV1,
): TesseraBrowserResult {
  const phases = [...(input.phases ?? ["shooting", "fight"])];
  const metrics = [
    ...(input.metrics ?? [
      "wipe-probability",
      "half-wipe-probability",
      "mean-kills",
      "mean-damage",
    ]),
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
    settings: { iterations: "1000" },
    cells: scenarios[0]?.cells ?? [],
    scenarios,
    importWarnings: { player: [], opponent: [] },
    warnings: [],
  };
}

test("stress reports deduplicate identical stage UI identities", () => {
  assert.equal(
    combineTesseraUiIdentities([
      "fixture-tessera-ui-v1",
      "fixture-tessera-ui-v1",
    ]),
    "fixture-tessera-ui-v1",
  );
  assert.equal(
    combineTesseraUiIdentities([
      "fixture-tessera-ui-v2",
      null,
      "fixture-tessera-ui-v1",
    ]),
    "fixture-tessera-ui-v1|fixture-tessera-ui-v2",
    "distinct identities remain visible for provenance-drift rejection",
  );
  assert.equal(
    combineTesseraUiIdentities([null, undefined]),
    null,
  );
});

test("default stress outputs are unique and recovery paths fail closed", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-output-contract-"),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Custodes output contract",
  );
  let deliveryAttempts = 0;
  const failDelivery = async (): Promise<
    ResultEnvelope<NewRecruitDelivery>
  > => {
    deliveryAttempts += 1;
    return {
      ok: false,
      data: null,
      violations: [
        {
          code: "FIXTURE_DELIVERY_STOP",
          message:
            "Fixture stops after the manifest is reserved.",
          severity: "error",
        },
      ],
      warnings: [],
    };
  };
  const scaffoldPath = (
    result: Awaited<ReturnType<typeof runRosterStressTest>>,
  ): string => {
    const match =
      result.violations[0]?.message.match(
        /Complete the scaffold at (.+)\.$/,
      );
    assert.ok(match, result.violations[0]?.message);
    return match[1];
  };

  try {
    const outside = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "aeldari",
      },
      {
        outputDirectory: "../outside",
        rootDir: directory,
      },
      { deliver: failDelivery },
    );
    assert.equal(outside.ok, false);
    assert.equal(
      outside.violations[0]?.code,
      "TESSERA_OUTPUT_OUTSIDE_ROOT",
    );
    assert.equal(deliveryAttempts, 0);

    const firstDefault = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "aeldari",
      },
      { suite: "core-3", rootDir: directory },
      { deliver: failDelivery },
    );
    const secondDefault = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "aeldari",
      },
      { suite: "core-3", rootDir: directory },
      { deliver: failDelivery },
    );
    assert.equal(
      firstDefault.violations[0]?.code,
      "TESSERA_PROFILE_POLICY_REQUIRED",
    );
    assert.equal(
      secondDefault.violations[0]?.code,
      "TESSERA_PROFILE_POLICY_REQUIRED",
    );
    const firstScaffold = scaffoldPath(firstDefault);
    const secondScaffold = scaffoldPath(secondDefault);
    assert.notEqual(
      path.dirname(firstScaffold),
      path.dirname(secondScaffold),
    );
    const defaultRoot = path.join(
      directory,
      "exports",
      "tessera",
    );
    assert.equal(
      path
        .relative(defaultRoot, firstScaffold)
        .startsWith(".."),
      false,
    );
    assert.equal(
      path
        .relative(defaultRoot, secondScaffold)
        .startsWith(".."),
      false,
    );

    const scaffold = JSON.parse(
      await readFile(firstScaffold, "utf8"),
    ) as {
      entries: Array<{ selectedProfile: string }>;
    };
    for (const entry of scaffold.entries) {
      entry.selectedProfile = entry.selectedProfile
        .replace(/^SELECT_ONE_OF:\s*/, "")
        .split(" | ")[0];
    }
    const policyPath = path.join(directory, "policy.json");
    await writeFile(
      policyPath,
      `${JSON.stringify(scaffold, null, 2)}\n`,
    );
    const reservedDirectory =
      path.dirname(firstScaffold);
    const seeded = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "aeldari",
      },
      {
        suite: "core-3",
        executionMode: "prepare-only",
        catalogueDriftMode: "diagnostic",
        providerCompatibilityMode: "enforce",
        profilePolicyPath: policyPath,
        outputDirectory: path.relative(
          directory,
          reservedDirectory,
        ),
        rootDir: directory,
      },
      { deliver: failDelivery },
    );
    assert.ok(seeded.data);
    assert.equal(
      seeded.data.configuration.analysisStrategy,
      "full-all",
      "core-3 defaults to one full pass because every proxy is a representative",
    );
    const seededRunId = seeded.data.runId;
    const manifestPath = path.join(
      reservedDirectory,
      "stress-manifest.json",
    );
    const seededManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as {
      schemaVersion: number;
      simulationBackend?: "auto" | "local-engine" | "website";
      selectedSimulationBackend?: "local-engine" | "website";
      portfolioSha256: string;
      configuration: {
        catalogueDriftMode?: "reject" | "diagnostic";
        providerCompatibilityMode?: "observe" | "enforce";
      };
      playerPreparationStartedAt?: string | null;
      portfolio: {
        sourceData: RosterDraftV1["sourceData"];
        items: Array<{
          roster: { name: string } | null;
        }>;
      };
    };
    assert.equal(seededManifest.schemaVersion, 7);
    assert.equal(seededManifest.simulationBackend, "auto");
    assert.equal(
      seededManifest.selectedSimulationBackend,
      "website",
    );
    assert.equal(
      seeded.data.configuration.catalogueDriftMode,
      "diagnostic",
    );
    assert.equal(
      seededManifest.configuration.catalogueDriftMode,
      "diagnostic",
    );
    assert.equal(
      seeded.data.configuration.providerCompatibilityMode,
      "enforce",
    );
    assert.equal(
      seededManifest.configuration.providerCompatibilityMode,
      "enforce",
    );
    assert.match(seededManifest.portfolioSha256, /^[0-9a-f]{64}$/);
    assert.equal(
      seededManifest.portfolioSha256,
      portfolioContentHash(seededManifest.portfolio),
    );
    assert.equal(
      seeded.data.portfolioSha256,
      seededManifest.portfolioSha256,
    );
    assert.deepEqual(
      seededManifest.portfolio.sourceData.official.authority,
      player.sourceData.official.authority,
      "manifest round trips must retain official-authority provenance before resume",
    );

    const incompleteV5Path = path.join(
      reservedDirectory,
      "incomplete-v5-provider-manifest.json",
    );
    const incompleteV5 = structuredClone(seededManifest);
    delete incompleteV5.selectedSimulationBackend;
    await writeFile(
      incompleteV5Path,
      `${JSON.stringify(incompleteV5, null, 2)}\n`,
    );
    await assert.rejects(
      verifyAndMigrateTesseraStressManifest(incompleteV5Path),
      /must freeze both simulationBackend and selectedSimulationBackend/,
    );

    const mismatchedV5Path = path.join(
      reservedDirectory,
      "mismatched-v5-provider-manifest.json",
    );
    const mismatchedV5 = structuredClone(seededManifest);
    mismatchedV5.selectedSimulationBackend = "local-engine";
    await writeFile(
      mismatchedV5Path,
      `${JSON.stringify(mismatchedV5, null, 2)}\n`,
    );
    await assert.rejects(
      verifyAndMigrateTesseraStressManifest(mismatchedV5Path),
      /selected simulation provider does not match/,
    );

    const legacyLocalPath = path.join(
      reservedDirectory,
      "legacy-local-provider-manifest.json",
    );
    const legacyLocal = structuredClone(seededManifest);
    legacyLocal.schemaVersion = 4;
    legacyLocal.simulationBackend = "local-engine";
    delete legacyLocal.selectedSimulationBackend;
    await writeFile(
      legacyLocalPath,
      `${JSON.stringify(legacyLocal, null, 2)}\n`,
    );
    await verifyAndMigrateTesseraStressManifest(legacyLocalPath);
    const migratedLocal = JSON.parse(
      await readFile(legacyLocalPath, "utf8"),
    );
    assert.equal(migratedLocal.schemaVersion, 7);
    assert.equal(migratedLocal.simulationBackend, "local-engine");
    assert.equal(
      migratedLocal.selectedSimulationBackend,
      "local-engine",
    );

    const attemptsBeforePolicyChange = deliveryAttempts;
    const changedPolicy = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "aeldari",
      },
      {
        suite: "core-3",
        executionMode: "prepare-only",
        catalogueDriftMode: "reject",
        profilePolicyPath: policyPath,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver: failDelivery },
    );
    assert.equal(changedPolicy.ok, false);
    assert.equal(
      changedPolicy.violations[0]?.code,
      "TESSERA_STRESS_RESUME_MISMATCH",
    );
    assert.equal(deliveryAttempts, attemptsBeforePolicyChange);

    const legacyPolicyManifest = structuredClone(seededManifest);
    delete legacyPolicyManifest.configuration.catalogueDriftMode;
    const legacyPolicyManifestPath = path.join(
      reservedDirectory,
      "legacy-policy-stress-manifest.json",
    );
    await writeFile(
      legacyPolicyManifestPath,
      `${JSON.stringify(legacyPolicyManifest, null, 2)}\n`,
    );
    const widenedLegacyPolicy = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        executionMode: "prepare-only",
        catalogueDriftMode: "diagnostic",
        profilePolicyPath: policyPath,
        resumeManifestPath: legacyPolicyManifestPath,
        rootDir: directory,
      },
      { deliver: failDelivery },
    );
    assert.equal(widenedLegacyPolicy.ok, false);
    assert.equal(
      widenedLegacyPolicy.violations[0]?.code,
      "TESSERA_STRESS_RESUME_MISMATCH",
    );
    assert.equal(deliveryAttempts, attemptsBeforePolicyChange);

    const inheritedPolicyManifest = structuredClone(seededManifest);
    inheritedPolicyManifest.playerPreparationStartedAt = null;
    const inheritedPolicyManifestPath = path.join(
      reservedDirectory,
      "inherited-policy-stress-manifest.json",
    );
    await writeFile(
      inheritedPolicyManifestPath,
      `${JSON.stringify(inheritedPolicyManifest, null, 2)}\n`,
    );
    const deliveredPolicyModes: Array<
      NewRecruitDeliveryOptions["catalogueDriftMode"]
    > = [];
    const captureInheritedPolicy = async (
      _roster: RosterDraftV1,
      options?: NewRecruitDeliveryOptions,
    ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
      deliveredPolicyModes.push(options?.catalogueDriftMode);
      return {
        ok: false,
        data: null,
        violations: [
          {
            code: "FIXTURE_DELIVERY_STOP",
            message:
              "Fixture records the recovered policy before stopping.",
            severity: "error",
          },
        ],
        warnings: [],
      };
    };
    const inheritedPolicy = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        executionMode: "prepare-only",
        profilePolicyPath: policyPath,
        resumeManifestPath: inheritedPolicyManifestPath,
        rootDir: directory,
      },
      { deliver: captureInheritedPolicy },
    );
    assert.equal(inheritedPolicy.ok, false);
    assert.deepEqual(deliveredPolicyModes, ["diagnostic"]);

    const attemptsBeforeCollision = deliveryAttempts;
    const collision = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "aeldari",
      },
      {
        suite: "core-3",
        executionMode: "prepare-only",
        profilePolicyPath: policyPath,
        outputDirectory: path.relative(
          directory,
          reservedDirectory,
        ),
        rootDir: directory,
      },
      { deliver: failDelivery },
    );
    assert.equal(collision.ok, false);
    assert.equal(
      collision.violations[0]?.code,
      "TESSERA_OUTPUT_ALREADY_EXISTS",
    );
    assert.equal(
      deliveryAttempts,
      attemptsBeforeCollision,
      "an existing explicit output must fail before delivery",
    );

    const resumed = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "aeldari",
      },
      {
        suite: "core-3",
        executionMode: "prepare-only",
        profilePolicyPath: policyPath,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver: failDelivery },
    );
    assert.equal(resumed.data?.runId, seededRunId);
    assert.equal(
      resumed.data?.configuration.catalogueDriftMode,
      "diagnostic",
    );
    assert.equal(
      resumed.data?.configuration.providerCompatibilityMode,
      "enforce",
    );
    const manifestsAfterResume = (
      await readdir(
        path.join(directory, "exports", "tessera"),
        { recursive: true },
      )
    ).filter(
      (filename) =>
        path.basename(filename) ===
        "stress-manifest.json",
    );
    assert.equal(manifestsAfterResume.length, 1);

    const tamperedManifestPath = path.join(
      reservedDirectory,
      "tampered-stress-manifest.json",
    );
    const tamperedManifest = structuredClone(seededManifest) as {
      portfolio: {
        items: Array<{
          roster: { name: string } | null;
        }>;
      };
    };
    const tamperedRoster = tamperedManifest.portfolio.items.find(
      (item) => item.roster !== null,
    )?.roster;
    assert.ok(tamperedRoster);
    tamperedRoster.name = `${tamperedRoster.name} tampered`;
    await writeFile(
      tamperedManifestPath,
      `${JSON.stringify(tamperedManifest, null, 2)}\n`,
    );
    const attemptsBeforeTamperedResume = deliveryAttempts;
    const tamperedResume = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "aeldari",
      },
      {
        profilePolicyPath: policyPath,
        resumeManifestPath: tamperedManifestPath,
        rootDir: directory,
      },
      { deliver: failDelivery },
    );
    assert.equal(tamperedResume.ok, false);
    assert.equal(
      tamperedResume.violations[0]?.code,
      "TESSERA_STRESS_RESUME_UNREADABLE",
    );
    assert.match(
      tamperedResume.violations[0]?.message ?? "",
      /portfolioSha256/,
    );
    assert.equal(
      deliveryAttempts,
      attemptsBeforeTamperedResume,
      "portfolio hash drift must stop before delivery",
    );

    const restarted = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "aeldari",
      },
      {
        suite: "core-3",
        executionMode: "prepare-only",
        profilePolicyPath: policyPath,
        restartManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver: failDelivery },
    );
    assert.ok(restarted.data);
    assert.notEqual(restarted.data.runId, seededRunId);
    assert.equal(
      restarted.data.configuration.catalogueDriftMode,
      "diagnostic",
    );
    const manifestsAfterRestart = (
      await readdir(
        path.join(directory, "exports", "tessera"),
        { recursive: true },
      )
    ).filter(
      (filename) =>
        path.basename(filename) ===
        "stress-manifest.json",
    );
    assert.equal(manifestsAfterRestart.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unreviewed diverse portfolio gaps stop before New Recruit delivery", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-portfolio-contract-"),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Portfolio Contract Player",
  );
  let deliveryCalls = 0;
  try {
    const generated = await previewFactionStressPortfolio({
      faction: "adeptus-custodes",
      pointsLimit: 1_000,
      suite: "diverse-9",
    });
    assert.ok(generated.data);
    const incompletePreview = structuredClone(generated.data);
    const missing = incompletePreview.portfolio.items.find(
      (item) => item.templateId === "ranged-pressure:mass",
    );
    assert.ok(missing);
    missing.status = "unavailable";
    missing.roster = null;
    missing.fingerprint = null;
    missing.simulationFingerprint = null;
    missing.omissionReason =
      "Synthetic unreviewed portfolio gap.";
    missing.warnings = [
      {
        code: "STRESS_TEMPLATE_UNREVIEWED",
        message:
          "This synthetic missing cell has not been reviewed.",
        severity: "warn",
      },
    ];
    const result = await runRosterStressTest(
      player,
      {
        kind: "faction",
        factionId: "adeptus-custodes",
      },
      {
        suite: "diverse-9",
        rootDir: directory,
        portfolioPreview: incompletePreview,
      },
      {
        deliver: async () => {
          deliveryCalls += 1;
          throw new Error(
            "Delivery must not run for an invalid portfolio.",
          );
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(
      result.violations[0]?.code,
      "PORTFOLIO_CONTRACT_UNMET",
    );
    assert.equal(deliveryCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable jobs adopt verified stress manifests v1 through v4", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-stress-job-adoption-"),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Durable adoption player",
  );
  const rostersByName = new Map<string, RosterDraftV1>([
    [player.name, player],
  ]);
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    rostersByName.set(candidate.name, candidate);
    const outputDirectory =
      options.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const source = path.join(outputDirectory, "source.rosz");
    const enriched = path.join(
      outputDirectory,
      "enriched.rosz",
    );
    const content = await enrichedFixture(candidate);
    await Promise.all([
      writeFile(source, content),
      writeFile(enriched, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl: null,
        imported: true,
        sessionReused: true,
        verification: null,
        enrichedSummary: summaryFor(candidate),
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: source,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enriched,
          },
        ],
      },
      violations: [],
      warnings: [],
    };
  };
  const runBrowser = async (
    input: TesseraBrowserInput,
  ): Promise<TesseraBrowserResult> => {
    const playerRoster = rostersByName.get(input.playerName);
    const opponentRoster = rostersByName.get(
      input.opponentName,
    );
    assert.ok(playerRoster);
    assert.ok(opponentRoster);
    return browserResult(
      input,
      playerRoster,
      opponentRoster,
    );
  };
  const portfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1_000,
    suite: "core-3",
  });
  assert.ok(portfolio.data);
  const requirements = aggregateProfileRequirements([
    player,
    ...portfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const policyPath = path.join(directory, "profiles.json");
  await writeFile(
    policyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: requirements.map((requirement) => ({
        faction: requirement.faction,
        unit: requirement.unit,
        weaponGroup: requirement.weaponGroup,
        phase: requirement.phase,
        selectedProfile: requirement.availableProfiles[0],
        activeCount: requirement.activeCount,
      })),
    }, null, 2)}\n`,
  );
  const baseline = await runRosterStressTest(
    player,
    { kind: "faction", factionId: "aeldari" },
    {
      suite: "core-3",
      analysisStrategy: "staged",
      executionMode: "simulate",
      profilePolicyPath: policyPath,
      outputDirectory: "baseline",
      rootDir: directory,
    },
    { deliver, runBrowser },
  );
  assert.ok(baseline.ok && baseline.data);
  const manifestArtifact = baseline.data.artifacts.find(
    (artifact) => artifact.format === "stress-manifest",
  );
  assert.ok(manifestArtifact);
  const baselineDirectory = path.join(directory, "baseline");
  const manifestPath = path.resolve(
    baselineDirectory,
    manifestArtifact.written,
  );
  const current = JSON.parse(
    await readFile(manifestPath, "utf8"),
  );
  for (const version of [1, 2, 3, 4] as const) {
    const legacy = structuredClone(current);
    legacy.schemaVersion = version;
    if (version < 4) {
      delete legacy.configuration.catalogueDriftMode;
      legacy.stageContracts = {
        screening:
          Object.values(current.stageContracts.screening)[0] ??
          null,
        deepDive:
          Object.values(current.stageContracts.deepDive)[0] ??
          null,
      };
    }
    delete legacy.configuration.providerCompatibilityMode;
    if (version < 3) delete legacy.portfolioSha256;
    const candidatePath = path.join(
      baselineDirectory,
      `stress-manifest-v${version}.json`,
    );
    await writeFile(
      candidatePath,
      `${JSON.stringify(legacy, null, 2)}\n`,
    );
    const job = await startTesseraRun(
      {
        kind: "stress",
        playerRoster: player,
        factionId: "aeldari",
        options: {
          resumeManifestPath: candidatePath,
          executionMode: "simulate",
          rootDir: directory,
        },
      },
      {
        outputDirectory: path.join(directory, "runs"),
        rootDir: directory,
        launch: false,
      },
    );
    const document = JSON.parse(
      await readFile(job.requestPath, "utf8"),
    ) as { request: TesseraRunRequest };
    assert.equal(document.request.kind, "stress");
    if (document.request.kind !== "stress") {
      throw new Error("Expected an adopted stress job.");
    }
    const adopted =
      document.request.options?.resumeManifestPath;
    assert.ok(adopted);
    const migrated = JSON.parse(
      await readFile(adopted, "utf8"),
    );
    assert.equal(migrated.schemaVersion, 7);
    assert.equal(
      migrated.configuration.catalogueDriftMode,
      "reject",
    );
    assert.equal(
      migrated.configuration.providerCompatibilityMode,
      "observe",
    );
    assert.match(migrated.portfolioSha256, /^[0-9a-f]{64}$/);
  }
  const baselineReportArtifact = baseline.data.artifacts.find(
    (artifact) => artifact.format === "stress-json",
  );
  assert.ok(baselineReportArtifact);
  const baselineReportPath = path.resolve(
    baselineDirectory,
    baselineReportArtifact.written,
  );
  const revisionJob = await startTesseraRun(
    {
      kind: "stress-revision",
      baselineReportPath,
      revisedRoster: {
        ...player,
        name: "Durable adoption revision",
      },
      options: { executionMode: "simulate" },
    },
    {
      outputDirectory: path.join(directory, "runs"),
      rootDir: directory,
      launch: false,
    },
  );
  const revisionDocument = JSON.parse(
    await readFile(revisionJob.requestPath, "utf8"),
  ) as { request: TesseraRunRequest };
  assert.equal(
    revisionDocument.request.kind,
    "stress-revision",
  );
  if (revisionDocument.request.kind !== "stress-revision") {
    throw new Error("Expected a stress-revision job.");
  }
  assert.ok(
    revisionDocument.request.baselineReportPath.startsWith(
      path.join(revisionJob.jobDirectory, "inputs"),
    ),
  );
  const frozenBaseline = JSON.parse(
    await readFile(
      revisionDocument.request.baselineReportPath,
      "utf8",
    ),
  ) as {
    artifacts: Array<{ format: string; written: string }>;
  };
  const frozenManifest = frozenBaseline.artifacts.find(
    (artifact) => artifact.format === "stress-manifest",
  )?.written;
  assert.ok(frozenManifest);
  assert.ok(frozenManifest.startsWith(revisionJob.jobDirectory));
});

test("runs, resumes, and pairs a staged faction stress test without duplicate list delivery", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-stress-orchestration-"),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Stress Player",
  );
  const rostersByName = new Map<string, RosterDraftV1>([
    [player.name, player],
  ]);
  const delivered: string[] = [];
  const deliveredPolicyModes: Array<
    NewRecruitDeliveryOptions["catalogueDriftMode"]
  > = [];
  const browserInputs: TesseraBrowserInput[] = [];
  let driftMeanDamageScenario = false;
  let omitFightBrowserRuns = 0;
  let terminalRevisionFailure = false;
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    delivered.push(candidate.name);
    deliveredPolicyModes.push(options.catalogueDriftMode);
    rostersByName.set(candidate.name, candidate);
    const outputDirectory =
      options.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const source = path.join(outputDirectory, "source.rosz");
    const enriched = path.join(outputDirectory, "enriched.rosz");
    const content = await enrichedFixture(candidate);
    await Promise.all([
      writeFile(source, content),
      writeFile(enriched, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl: "https://www.newrecruit.eu/app/Lists/stress-fixture",
        imported: true,
        sessionReused: true,
        verification: null,
        enrichedSummary: summaryFor(candidate),
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: source,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enriched,
          },
        ],
      },
      violations: [],
      warnings: [],
    };
  };
  const runBrowser = async (
    input: TesseraBrowserInput,
  ): Promise<TesseraBrowserResult> => {
    browserInputs.push(input);
    const playerRoster = rostersByName.get(input.playerName);
    const opponentRoster = rostersByName.get(input.opponentName);
    assert.ok(playerRoster, input.playerName);
    assert.ok(opponentRoster, input.opponentName);
    if (terminalRevisionFailure) {
      throw new TesseraAutomationError(
        "TESSERA_UI_CHANGED",
        "Synthetic terminal revision UI mismatch.",
      );
    }
    const result = browserResult(
      input,
      playerRoster,
      opponentRoster,
    );
    if (driftMeanDamageScenario) {
      const metricScenario = result.scenarios.find(
        (scenario) => scenario.metric === "mean-damage",
      );
      if (metricScenario) {
        metricScenario.iterations = 999;
        metricScenario.settings.iterations = "999";
        driftMeanDamageScenario = false;
      }
    }
    if (omitFightBrowserRuns > 0) {
      omitFightBrowserRuns -= 1;
      result.scenarios = result.scenarios?.filter(
        (scenario) => scenario.phase !== "fight",
      );
    }
    return result;
  };
  const policyPortfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1_000,
    suite: "core-3",
  });
  assert.ok(policyPortfolio.data);
  const profileRequirements = aggregateProfileRequirements([
    player,
    ...policyPortfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const profilePolicyPath = path.join(directory, "profiles.json");
  await writeFile(
    profilePolicyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: profileRequirements.map((requirement) => ({
        faction: requirement.faction,
        unit: requirement.unit,
        weaponGroup: requirement.weaponGroup,
        phase: requirement.phase,
        selectedProfile: requirement.availableProfiles[0],
        activeCount: requirement.activeCount,
      })),
    }, null, 2)}\n`,
  );

  try {
    setCachedDataFreshness({
      ok: true,
      data: {
        checkedAt: "2026-07-30T00:00:00.000Z",
        state: "update-available",
        rules: {
          pinnedVersion: "fixture",
          latestVersion: "fixture-next",
          updateAvailable: true,
        },
        newRecruit: {
          pinnedCommit: "a".repeat(40),
          latestCommit: "b".repeat(40),
          updateAvailable: true,
        },
        official: {
          pinnedVersion: "fixture",
          latestVersion: "fixture",
          pinnedContentSha256: "c".repeat(64),
          latestContentSha256: "c".repeat(64),
          updateAvailable: false,
        },
      },
      violations: [],
      warnings: [
        {
          code: "DATA_UPDATE_AVAILABLE",
          message:
            "A newer data release is available; the run remains pinned.",
          severity: "warn",
        },
      ],
    });
    const baseline = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        catalogueDriftMode: "diagnostic",
        profilePolicyPath,
        outputDirectory: "baseline",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      baseline.ok,
      true,
      baseline.violations.map((violation) => violation.message).join("\n"),
    );
    assert.ok(baseline.data);
    assert.equal(
      baseline.data.status,
      "complete",
      JSON.stringify(
        {
          warnings: baseline.data.warnings,
          manifest: baseline.data.recovery,
        },
        null,
        2,
      ),
    );
    assert.equal(baseline.data.portfolio.coverage.ready, 3);
    assert.equal(
      baseline.data.portfolio.coverage.maximumResultStatus,
      "complete",
    );
    assert.equal(
      baseline.data.portfolio.coverage
        .namedCharacterCoverageStatus,
      "buildable-not-simulated",
    );
    assert.equal(
      baseline.data.portfolio.items.some(
        (item) => item.containsNamedCharacter === true,
      ),
      false,
      "named specialist evidence must remain separate from core-3 payloads",
    );
    assert.equal(baseline.data.representatives.length, 3);
    assert.equal(
      baseline.data.robustness?.samples.filter(
        (sample) => sample.status === "confident",
      ).length,
      3,
    );
    assert.equal(delivered.length, 4);
    assert.deepEqual(
      deliveredPolicyModes,
      Array(4).fill("diagnostic"),
    );
    assert.equal(new Set(delivered).size, 4);
    assert.equal(browserInputs.length, 6);
    assert.ok(
      browserInputs.every(
        (input) => input.frozenScenarioContract === null,
      ),
      "each template freezes its own first screening and deep-dive capture",
    );
    assert.ok(
      browserInputs.slice(0, 3).every(
        (input) =>
          input.analysisMode === "quick" &&
          input.metrics?.join(",") === "half-wipe-probability",
      ),
    );
    assert.ok(
      browserInputs.slice(3).every(
        (input) =>
          input.analysisMode === "full" &&
          input.metrics?.join(",") ===
            "wipe-probability,mean-kills,mean-damage",
      ),
    );
    const baselineOutputDirectory = path.join(directory, "baseline");
    const baselineJsonArtifact = baseline.data.artifacts.find(
      (artifact) => artifact.format === "stress-json",
    )?.written;
    const baselineHtmlArtifact = baseline.data.artifacts.find(
      (artifact) => artifact.format === "stress-html",
    )?.written;
    const manifestArtifact = baseline.data.artifacts.find(
      (artifact) => artifact.format === "stress-manifest",
    )?.written;
    assert.ok(baselineJsonArtifact);
    assert.ok(baselineHtmlArtifact);
    assert.ok(manifestArtifact);
    const baselineJson = path.resolve(
      baselineOutputDirectory,
      baselineJsonArtifact,
    );
    const baselineHtml = path.resolve(
      baselineOutputDirectory,
      baselineHtmlArtifact,
    );
    const manifestPath = path.resolve(
      baselineOutputDirectory,
      manifestArtifact,
    );
    const frozenExecutionManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    assert.equal(
      frozenExecutionManifest.cachedLiveUpdateCheck.state,
      "update-available",
    );
    assert.ok(
      frozenExecutionManifest.warnings.some(
        (warning: string) =>
          warning.startsWith("DATA_UPDATE_AVAILABLE:"),
      ),
    );
    setCachedDataFreshness(
      {
        ok: true,
        data: frozenExecutionManifest.cachedLiveUpdateCheck,
        violations: [],
        warnings: [],
      },
      0,
    );
    assert.equal(
      Object.keys(
        frozenExecutionManifest.stageContracts.screening,
      ).length,
      3,
    );
    assert.ok(
      Object.values(
        frozenExecutionManifest.stageContracts.screening,
      ).every(
        (contract) =>
          Array.isArray(contract) && contract.length === 4,
      ),
    );
    assert.equal(
      Object.keys(
        frozenExecutionManifest.stageContracts.deepDive,
      ).length,
      3,
    );
    assert.ok(
      Object.values(
        frozenExecutionManifest.stageContracts.deepDive,
      ).every(
        (contract) =>
          Array.isArray(contract) && contract.length === 12,
      ),
    );
    assert.match(
      frozenExecutionManifest.preparedPlayer.listUrl,
      /newrecruit\.eu\/app\/Lists\//,
    );
    const shareableBaseline = JSON.parse(
      await readFile(baselineJson, "utf8"),
    );
    assert.doesNotMatch(
      JSON.stringify(shareableBaseline),
      new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(
      JSON.stringify(shareableBaseline),
      /newrecruit\.eu\/app\/Lists\//,
    );
    assert.ok(
      shareableBaseline.artifacts.every(
        (artifact: { written: string }) =>
          !path.isAbsolute(artifact.written),
      ),
    );
    const portablePreparedPaths = [
      shareableBaseline.player.sourceRoszPath,
      shareableBaseline.player.enrichedRoszPath,
      ...shareableBaseline.frozenOpponentArtifacts.map(
        (artifact: { enrichedRoszPath: string }) =>
          artifact.enrichedRoszPath,
      ),
    ];
    assert.ok(
      portablePreparedPaths.every(
        (filename: string) =>
          !path.isAbsolute(filename) &&
          !filename.startsWith(".."),
      ),
    );
    await Promise.all(
      portablePreparedPaths.map((filename: string) =>
        readFile(path.resolve(baselineOutputDirectory, filename)),
      ),
    );
    const relocatedDirectory = path.join(directory, "relocated-bundle");
    await mkdir(relocatedDirectory);
    await Promise.all([
      copyFile(
        baselineJson,
        path.join(relocatedDirectory, path.basename(baselineJson)),
      ),
      copyFile(
        baselineHtml,
        path.join(relocatedDirectory, path.basename(baselineHtml)),
      ),
    ]);
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(relocatedDirectory, path.basename(baselineJson)),
          "utf8",
        ),
      ).runId,
      baseline.data.runId,
    );

    const completedResume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      completedResume.ok,
      true,
      completedResume.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.equal(completedResume.data?.runId, baseline.data.runId);
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 6);

    const legacyBaselinePath = path.join(
      directory,
      "legacy-stress-baseline.json",
    );
    const legacyBaseline = structuredClone(shareableBaseline);
    legacyBaseline.schemaVersion = 1;
    delete legacyBaseline.configuration.profilePolicyHash;
    delete legacyBaseline.stageProvenance.screening.profilePolicyHash;
    if (legacyBaseline.stageProvenance.deepDive) {
      delete legacyBaseline.stageProvenance.deepDive.profilePolicyHash;
    }
    await writeFile(
      legacyBaselinePath,
      `${JSON.stringify(legacyBaseline, null, 2)}\n`,
    );
    const legacyComparison = await compareRosterStressRevision(
      legacyBaselinePath,
      {
        ...player,
        name: "Legacy Profile Provenance Revision",
      },
      {
        experimental: true,
        outputDirectory: "legacy-revision",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(legacyComparison.ok, false);
    assert.equal(
      legacyComparison.violations[0]?.code,
      "TESSERA_STRESS_BASELINE_PROFILE_PROVENANCE_REQUIRED",
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 6);

    const legacyManifestPath = path.join(
      path.dirname(manifestPath),
      "legacy-stress-manifest.json",
    );
    const legacyManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    legacyManifest.stageContracts = {
      screening:
        Object.values(
          legacyManifest.stageContracts.screening,
        )[0] ?? null,
      deepDive:
        Object.values(
          legacyManifest.stageContracts.deepDive,
        )[0] ?? null,
    };
    legacyManifest.schemaVersion = 1;
    delete legacyManifest.portfolioSha256;
    delete legacyManifest.profilePolicy;
    delete legacyManifest.profilePolicyHash;
    delete legacyManifest.configuration.profilePolicyHash;
    delete legacyManifest.portfolio.coverage.namedCharacterCoverageStatus;
    delete legacyManifest.portfolio.coverage.namedCharacterCoverageReason;
    delete legacyManifest.portfolio.coverage.maximumResultStatus;
    delete legacyManifest.portfolio.coverage.representedCells;
    delete legacyManifest.portfolio.coverage.missingCells;
    delete legacyManifest.portfolio.coverage.missingPostures;
    delete legacyManifest.portfolio.coverage.missingCompositions;
    for (const group of [
      legacyManifest.screening,
      legacyManifest.deepDive,
    ]) {
      for (const entry of Object.values(group) as Array<
        Record<string, unknown>
      >) {
        entry.error =
          entry.error && typeof entry.error === "object"
            ? (entry.error as { message?: string }).message ?? null
            : entry.error ?? null;
        delete entry.attemptCount;
        delete entry.attemptHistory;
        delete entry.firstAttemptAt;
        delete entry.lastAttemptAt;
        delete entry.nextAction;
      }
    }
    await writeFile(
      legacyManifestPath,
      `${JSON.stringify(legacyManifest, null, 2)}\n`,
    );
    const adoptedLegacyJob = await startTesseraRun(
      {
        kind: "stress",
        playerRoster: player,
        factionId: "aeldari",
        options: {
          resumeManifestPath: legacyManifestPath,
          executionMode: "simulate",
          rootDir: directory,
        },
      },
      {
        outputDirectory: path.join(
          directory,
          "durable-adoption-runs",
        ),
        rootDir: directory,
        launch: false,
      },
    );
    const adoptedLegacyDocument = JSON.parse(
      await readFile(adoptedLegacyJob.requestPath, "utf8"),
    ) as { request: TesseraRunRequest };
    assert.equal(adoptedLegacyDocument.request.kind, "stress");
    if (adoptedLegacyDocument.request.kind !== "stress") {
      throw new Error("Expected a durable stress adoption.");
    }
    const adoptedLegacyManifest =
      adoptedLegacyDocument.request.options
        ?.resumeManifestPath;
    assert.ok(adoptedLegacyManifest);
    assert.ok(
      adoptedLegacyManifest.startsWith(
        adoptedLegacyJob.jobDirectory,
      ),
    );
    const adoptedLegacyManifestJson = JSON.parse(
      await readFile(adoptedLegacyManifest, "utf8"),
    );
    assert.equal(adoptedLegacyManifestJson.schemaVersion, 7);
    assert.match(
      adoptedLegacyManifestJson.portfolioSha256,
      /^[0-9a-f]{64}$/,
    );
    assert.equal(
      JSON.parse(await readFile(legacyManifestPath, "utf8"))
        .schemaVersion,
      1,
    );
    const migratedResume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        resumeManifestPath: legacyManifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      migratedResume.ok,
      true,
      JSON.stringify(migratedResume.violations, null, 2),
    );
    const rewrittenManifest = JSON.parse(
      await readFile(legacyManifestPath, "utf8"),
    );
    assert.equal(rewrittenManifest.schemaVersion, 7);
    assert.equal(
      rewrittenManifest.portfolioSha256,
      portfolioContentHash(rewrittenManifest.portfolio),
    );
    assert.match(
      rewrittenManifest.profilePolicyHash,
      /^[0-9a-f]{64}$/,
    );
    assert.equal(
      rewrittenManifest.portfolio.coverage
        .namedCharacterCoverageStatus,
      "buildable-not-simulated",
    );
    assert.ok(
      Array.isArray(
        rewrittenManifest.portfolio.coverage.representedCells,
      ),
    );
    assert.ok(
      Array.isArray(
        rewrittenManifest.portfolio.coverage.missingCells,
      ),
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 6);

    const legacyV2ManifestPath = path.join(
      path.dirname(manifestPath),
      "legacy-v2-stress-manifest.json",
    );
    const legacyV2Manifest = structuredClone(
      frozenExecutionManifest,
    );
    legacyV2Manifest.stageContracts = {
      screening:
        Object.values(
          legacyV2Manifest.stageContracts.screening,
        )[0] ?? null,
      deepDive:
        Object.values(
          legacyV2Manifest.stageContracts.deepDive,
        )[0] ?? null,
    };
    legacyV2Manifest.schemaVersion = 2;
    delete legacyV2Manifest.portfolioSha256;
    await writeFile(
      legacyV2ManifestPath,
      `${JSON.stringify(legacyV2Manifest, null, 2)}\n`,
    );
    const adoptedV2Job = await startTesseraRun(
      {
        kind: "stress",
        playerRoster: player,
        factionId: "aeldari",
        options: {
          restartManifestPath: legacyV2ManifestPath,
          executionMode: "simulate",
          rootDir: directory,
        },
      },
      {
        outputDirectory: path.join(
          directory,
          "durable-adoption-runs",
        ),
        rootDir: directory,
        launch: false,
      },
    );
    const adoptedV2Document = JSON.parse(
      await readFile(adoptedV2Job.requestPath, "utf8"),
    ) as { request: TesseraRunRequest };
    assert.equal(adoptedV2Document.request.kind, "stress");
    if (adoptedV2Document.request.kind !== "stress") {
      throw new Error("Expected a durable v2 stress adoption.");
    }
    const adoptedV2Manifest =
      adoptedV2Document.request.options
        ?.restartManifestPath;
    assert.ok(adoptedV2Manifest);
    assert.equal(
      JSON.parse(await readFile(adoptedV2Manifest, "utf8"))
        .schemaVersion,
      7,
    );
    const migratedV2Resume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: legacyV2ManifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      migratedV2Resume.ok,
      true,
      JSON.stringify(migratedV2Resume.violations, null, 2),
    );
    const rewrittenV2Manifest = JSON.parse(
      await readFile(legacyV2ManifestPath, "utf8"),
    );
    assert.equal(rewrittenV2Manifest.schemaVersion, 7);
    assert.equal(
      rewrittenV2Manifest.portfolioSha256,
      portfolioContentHash(rewrittenV2Manifest.portfolio),
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 6);

    await Promise.all([unlink(baselineJson), unlink(baselineHtml)]);

    const resumed = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      resumed.ok,
      true,
      resumed.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.equal(resumed.data?.status, "complete");
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 6);

    const retryManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    const retryTemplateId = Object.keys(
      retryManifest.screening,
    )[0];
    assert.ok(retryTemplateId);
    retryManifest.screening[retryTemplateId].status = "partial";
    retryManifest.screening[retryTemplateId].error =
      "Synthetic interrupted screen for resume coverage.";
    await writeFile(
      manifestPath,
      `${JSON.stringify(retryManifest, null, 2)}\n`,
    );
    const retriedPartial = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(retriedPartial.ok, true);
    assert.equal(retriedPartial.data?.status, "complete");
    assert.deepEqual(
      retriedPartial.data?.representatives,
      resumed.data?.representatives,
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 7);

    const interruptedFinalManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    interruptedFinalManifest.finalArtifacts.jsonSha256 = null;
    interruptedFinalManifest.finalArtifacts.htmlSha256 = null;
    interruptedFinalManifest.completedAt = null;
    await writeFile(
      manifestPath,
      `${JSON.stringify(interruptedFinalManifest, null, 2)}\n`,
    );
    const recoveredFinalWrite = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(recoveredFinalWrite.ok, true);
    assert.equal(recoveredFinalWrite.data?.status, "complete");
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 7);

    const revised: RosterDraftV1 = {
      ...player,
      name: "Stress Player Revised",
      updatedAt: new Date().toISOString(),
    };
    rostersByName.set(revised.name, revised);
    const revisedBaselineArtifact =
      recoveredFinalWrite.data?.artifacts.find(
      (artifact) => artifact.format === "stress-json",
    )?.written;
    assert.ok(revisedBaselineArtifact);
    const revisedBaselinePath = path.resolve(
      baselineOutputDirectory,
      revisedBaselineArtifact,
    );

    const baselineContent = await readFile(revisedBaselinePath);
    const changedBaseline = JSON.parse(
      baselineContent.toString("utf8"),
    );
    changedBaseline.warnings.push("tampered baseline");
    await writeFile(
      revisedBaselinePath,
      `${JSON.stringify(changedBaseline, null, 2)}\n`,
    );
    const changedBaselineComparison =
      await compareRosterStressRevision(
        revisedBaselinePath,
        revised,
        {
          experimental: true,
          outputDirectory: "changed-baseline-revision",
          rootDir: directory,
        },
        { deliver, runBrowser },
      );
    assert.equal(changedBaselineComparison.ok, false);
    assert.equal(
      changedBaselineComparison.violations[0]?.code,
      "TESSERA_STRESS_BASELINE_PROVENANCE_INVALID",
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 7);
    await writeFile(revisedBaselinePath, baselineContent);

    const policyMismatchComparison =
      await compareRosterStressRevision(
        revisedBaselinePath,
        revised,
        {
          experimental: true,
          catalogueDriftMode: "reject",
          outputDirectory: "policy-mismatch-revision",
          rootDir: directory,
        },
        { deliver, runBrowser },
      );
    assert.equal(policyMismatchComparison.ok, false);
    assert.equal(
      policyMismatchComparison.violations[0]?.code,
      "TESSERA_STRESS_REVISION_CONFIGURATION_CHANGED",
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 7);

    const frozenArtifact =
      resumed.data?.frozenOpponentArtifacts[0];
    assert.ok(frozenArtifact);
    const frozenManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    const frozenArtifactReference =
      frozenManifest.preparedOpponents[frozenArtifact.templateId]
        ?.prepared.enrichedRoszPath;
    assert.ok(frozenArtifactReference);
    const frozenArtifactPath = path.resolve(
      path.dirname(manifestPath),
      frozenArtifactReference,
    );
    const frozenContent = await readFile(
      frozenArtifactPath,
    );
    await writeFile(
      frozenArtifactPath,
      "tampered frozen proxy",
    );
    const tamperedComparison =
      await compareRosterStressRevision(
        revisedBaselinePath,
        revised,
        {
          experimental: true,
          outputDirectory: "tampered-revision",
          rootDir: directory,
        },
        { deliver, runBrowser },
      );
    assert.equal(tamperedComparison.ok, false);
    assert.equal(
      tamperedComparison.violations[0]?.code,
      "TESSERA_STRESS_BASELINE_ARTIFACTS_CHANGED",
    );
    assert.equal(delivered.length, 4);
    assert.equal(browserInputs.length, 7);
    await writeFile(
      frozenArtifactPath,
      frozenContent,
    );

    omitFightBrowserRuns = 3;
    const incompleteRevision =
      await compareRosterStressRevision(
        revisedBaselinePath,
        revised,
        {
          experimental: true,
          outputDirectory: "incomplete-revision",
          rootDir: directory,
        },
        { deliver, runBrowser },
      );
    assert.equal(incompleteRevision.ok, false);
    assert.equal(
      incompleteRevision.violations[0]?.code,
      "TESSERA_STRESS_REVISION_INCOMPLETE",
      JSON.stringify(incompleteRevision.violations, null, 2),
    );
    assert.equal(delivered.length, 5);
    // Incomplete per-proxy evidence does not masquerade as a global
    // readiness outage; each frozen proxy gets its bounded attempt.
    assert.equal(
      browserInputs.length,
      12,
      JSON.stringify(incompleteRevision, null, 2),
    );

    driftMeanDamageScenario = true;
    const settingsMismatch = await compareRosterStressRevision(
      revisedBaselinePath,
      revised,
      {
        experimental: true,
        outputDirectory: "settings-mismatch-revision",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      settingsMismatch.ok,
      false,
      JSON.stringify(
        {
          violations: settingsMismatch.violations,
          browserInputCount: browserInputs.length,
          recentBrowserInputs: browserInputs.slice(-6).map((input) => ({
            analysisMode: input.analysisMode,
            metrics: input.metrics,
            frozenScenarioContract: input.frozenScenarioContract,
          })),
        },
        null,
        2,
      ),
    );
    assert.equal(
      settingsMismatch.violations[0]?.code,
      "TESSERA_STRESS_SETTINGS_CHANGED",
    );
    assert.equal(delivered.length, 6);
    // Screening still completes against the frozen quick-mode contract. The
    // settings drift is first observable in the initial deep dive, which stops
    // the other two deep-dive captures in this invocation.
    assert.equal(browserInputs.length, 16);

    assert.equal(driftMeanDamageScenario, false);
    const compared = await compareRosterStressRevision(
      revisedBaselinePath,
      revised,
      {
        experimental: true,
        outputDirectory: "revision",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      compared.ok,
      true,
      compared.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.ok(compared.data);
    assert.deepEqual(
      compared.data.revised.representatives,
      recoveredFinalWrite.data?.representatives,
    );
    assert.equal(compared.data.sampleDeltas.length, 3);
    assert.equal(compared.data.summary.unchanged, 3);
    assert.equal(
      compared.data.revised.recovery.verifiedPreparedOpponents,
      3,
      "paired recovery reports the hash-verified frozen opponents",
    );
    assert.equal(
      compared.data.revised.preparation?.uniqueRosters,
      1,
      "paired preparation still counts only the newly prepared player",
    );
    assert.equal(delivered.length, 7);
    assert.ok(
      deliveredPolicyModes.every(
        (mode) => mode === "diagnostic",
      ),
      JSON.stringify(deliveredPolicyModes),
    );
    assert.equal(browserInputs.length, 22);
    const revisionJsonArtifact = compared.data.artifacts.find(
      (artifact) => artifact.format === "stress-revision-json",
    )?.written;
    const revisionHtmlArtifact = compared.data.artifacts.find(
      (artifact) => artifact.format === "stress-revision-html",
    )?.written;
    assert.ok(revisionJsonArtifact);
    assert.ok(revisionHtmlArtifact);
    const revisionJsonPath = path.resolve(
      directory,
      "revision",
      revisionJsonArtifact,
    );
    const revisionHtmlPath = path.resolve(
      directory,
      "revision",
      revisionHtmlArtifact,
    );
    const portableRevision = await readFile(
      revisionJsonPath,
      "utf8",
    );
    assert.doesNotMatch(
      portableRevision,
      new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    const relocatedRevisionDirectory = path.join(
      directory,
      "relocated-revision",
    );
    await mkdir(relocatedRevisionDirectory);
    await Promise.all([
      copyFile(
        revisionJsonPath,
        path.join(
          relocatedRevisionDirectory,
          path.basename(revisionJsonPath),
        ),
      ),
      copyFile(
        revisionHtmlPath,
        path.join(
          relocatedRevisionDirectory,
          path.basename(revisionHtmlPath),
        ),
      ),
    ]);
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(
            relocatedRevisionDirectory,
            path.basename(revisionJsonPath),
          ),
          "utf8",
        ),
      ).reportKind,
      "tessera-stress-revision",
    );
    assert.match(
      await readFile(
        revisionHtmlPath,
        "utf8",
      ),
      /faction stress-test revision comparison/i,
    );

    const stableManifestContent = await readFile(manifestPath);
    const changedPortfolioManifest = JSON.parse(
      stableManifestContent.toString("utf8"),
    );
    const changedPortfolioItem =
      changedPortfolioManifest.portfolio.items.find(
        (item: { status: string }) => item.status === "ready",
      );
    assert.ok(changedPortfolioItem?.roster?.units?.[0]);
    changedPortfolioItem.roster.units[0].unitId =
      "unmapped-fixture-unit";
    changedPortfolioManifest.screening[
      changedPortfolioItem.templateId
    ].status = "pending";
    await writeFile(
      manifestPath,
      `${JSON.stringify(changedPortfolioManifest, null, 2)}\n`,
    );
    const changedPortfolioResume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(changedPortfolioResume.ok, false);
    assert.equal(
      changedPortfolioResume.violations[0]?.code,
      "TESSERA_STRESS_RESUME_UNREADABLE",
    );
    assert.match(
      changedPortfolioResume.violations[0]?.message ?? "",
      /portfolioSha256/,
    );
    assert.equal(delivered.length, 7);
    assert.equal(browserInputs.length, 22);
    await writeFile(manifestPath, stableManifestContent);

    const unknownOutcomeManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    delete unknownOutcomeManifest.preparedOpponents[
      retryTemplateId
    ];
    unknownOutcomeManifest.opponentPreparationStartedAt[
      retryTemplateId
    ] = "2026-07-28T20:00:00.000Z";
    unknownOutcomeManifest.screening[retryTemplateId].status =
      "pending";
    await writeFile(
      manifestPath,
      `${JSON.stringify(unknownOutcomeManifest, null, 2)}\n`,
    );
    const unknownOutcomeResume = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(unknownOutcomeResume.ok, false);
    assert.equal(
      unknownOutcomeResume.violations[0]?.code,
      "TESSERA_STRESS_DELIVERY_OUTCOME_UNKNOWN",
    );
    assert.equal(delivered.length, 7);
    assert.equal(browserInputs.length, 22);

    await writeFile(manifestPath, stableManifestContent);
    terminalRevisionFailure = true;
    const terminalRevision = await compareRosterStressRevision(
      revisedBaselinePath,
      revised,
      {
        experimental: true,
        outputDirectory: "terminal-revision",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(terminalRevision.ok, false);
    assert.equal(
      terminalRevision.violations[0]?.code,
      "TESSERA_UI_CHANGED",
      JSON.stringify(terminalRevision.violations, null, 2),
    );
    assert.match(
      terminalRevision.violations[0]?.message ?? "",
      /Revised screening failed.*Synthetic terminal revision UI mismatch/,
    );
    assert.equal(
      terminalRevision.violations.some(
        (violation) =>
          violation.code ===
          "TESSERA_STRESS_REVISION_INCOMPLETE",
      ),
      false,
    );
    assert.equal(delivered.length, 8);
    assert.equal(browserInputs.length, 23);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("freezes Tessera iteration contracts per stress template", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-template-settings-"),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Per-template settings player",
  );
  const rostersByName = new Map<string, RosterDraftV1>([
    [player.name, player],
  ]);
  const browserInputs: TesseraBrowserInput[] = [];
  const iterationsByOpponent = new Map<string, number>();

  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    rostersByName.set(candidate.name, candidate);
    const outputDirectory = options.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const source = path.join(outputDirectory, "source.rosz");
    const enriched = path.join(outputDirectory, "enriched.rosz");
    const content = await enrichedFixture(candidate);
    await Promise.all([
      writeFile(source, content),
      writeFile(enriched, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl:
          "https://www.newrecruit.eu/app/Lists/template-settings-fixture",
        imported: true,
        sessionReused: true,
        verification: null,
        enrichedSummary: summaryFor(candidate),
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: source,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enriched,
          },
        ],
      },
      violations: [],
      warnings: [],
    };
  };

  const runBrowser = async (
    input: TesseraBrowserInput,
  ): Promise<TesseraBrowserResult> => {
    browserInputs.push(input);
    const playerRoster = rostersByName.get(input.playerName);
    const opponentRoster = rostersByName.get(input.opponentName);
    assert.ok(playerRoster, input.playerName);
    assert.ok(opponentRoster, input.opponentName);
    if (!iterationsByOpponent.has(input.opponentName)) {
      iterationsByOpponent.set(
        input.opponentName,
        iterationsByOpponent.size === 0 ? 1_000 : 2_000,
      );
    }
    const iterations = iterationsByOpponent.get(input.opponentName)!;
    const frozenIterations = [
      ...new Set(
        (input.frozenScenarioContract ?? [])
          .map((entry) => entry.iterations)
          .filter((value): value is number => value !== null),
      ),
    ];
    if (
      frozenIterations.length > 0 &&
      (
        frozenIterations.length !== 1 ||
        frozenIterations[0] !== iterations
      )
    ) {
      throw new TesseraAutomationError(
        "TESSERA_SETTINGS_REPLAY_FAILED",
        `Tessera is using ${iterations} iterations and did not expose one control for the frozen value ${frozenIterations[0]}.`,
      );
    }
    const result = browserResult(
      input,
      playerRoster,
      opponentRoster,
    );
    result.settings.iterations = String(iterations);
    for (const scenario of result.scenarios) {
      scenario.iterations = iterations;
      scenario.settings.iterations = String(iterations);
    }
    return result;
  };

  const portfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1_000,
    suite: "core-3",
  });
  assert.ok(portfolio.data);
  const profileRequirements = aggregateProfileRequirements([
    player,
    ...portfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const profilePolicyPath = path.join(
    directory,
    "profiles.json",
  );
  await writeFile(
    profilePolicyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: profileRequirements.map((requirement) => ({
        faction: requirement.faction,
        unit: requirement.unit,
        weaponGroup: requirement.weaponGroup,
        phase: requirement.phase,
        selectedProfile: requirement.availableProfiles[0],
        activeCount: requirement.activeCount,
      })),
    }, null, 2)}\n`,
  );

  try {
    const baseline = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        outputDirectory: "baseline",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      baseline.ok,
      true,
      JSON.stringify(baseline.violations, null, 2),
    );
    assert.ok(baseline.data);
    assert.equal(
      baseline.data.status,
      "complete",
      JSON.stringify(baseline.data.warnings, null, 2),
    );
    assert.equal(browserInputs.length, 6);
    assert.ok(
      browserInputs.every(
        (input) => input.frozenScenarioContract === null,
      ),
      "each template's first screening and deep-dive capture starts without another template's contract",
    );
    assert.deepEqual(
      new Set(iterationsByOpponent.values()),
      new Set([1_000, 2_000]),
    );

    const outputDirectory = path.join(directory, "baseline");
    const manifestArtifact = baseline.data.artifacts.find(
      (artifact) => artifact.format === "stress-manifest",
    )?.written;
    const baselineArtifact = baseline.data.artifacts.find(
      (artifact) => artifact.format === "stress-json",
    )?.written;
    assert.ok(manifestArtifact);
    assert.ok(baselineArtifact);
    const manifestPath = path.resolve(
      outputDirectory,
      manifestArtifact,
    );
    const baselinePath = path.resolve(
      outputDirectory,
      baselineArtifact,
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    assert.equal(manifest.schemaVersion, 7);

    const expectedIterationsByTemplate = new Map<string, number>();
    for (const item of baseline.data.portfolio.items) {
      if (!item.roster || item.status !== "ready") continue;
      const iterations = iterationsByOpponent.get(item.roster.name);
      assert.ok(iterations, item.roster.name);
      expectedIterationsByTemplate.set(
        item.templateId,
        iterations,
      );
    }
    const readyTemplateIds = [
      ...expectedIterationsByTemplate.keys(),
    ].sort();
    for (const stage of ["screening", "deepDive"] as const) {
      assert.deepEqual(
        Object.keys(manifest.stageContracts[stage]).sort(),
        readyTemplateIds,
      );
      for (const templateId of readyTemplateIds) {
        const contract = manifest.stageContracts[stage][templateId];
        assert.ok(Array.isArray(contract));
        assert.deepEqual(
          new Set(
            contract.map(
              (entry: { iterations: number | null }) =>
                entry.iterations,
            ),
          ),
          new Set([
            expectedIterationsByTemplate.get(templateId),
          ]),
        );
      }
    }
    const completedManifest = structuredClone(manifest);
    const firstTemplateId = readyTemplateIds.find(
      (templateId) =>
        expectedIterationsByTemplate.get(templateId) === 1_000,
    );
    assert.ok(firstTemplateId);

    const retryTemplateId = readyTemplateIds.find(
      (templateId) =>
        expectedIterationsByTemplate.get(templateId) === 2_000,
    );
    assert.ok(retryTemplateId);
    const retryItem = baseline.data.portfolio.items.find(
      (item) => item.templateId === retryTemplateId,
    );
    assert.ok(retryItem?.roster);
    const retryOpponentName = retryItem.roster.name;
    manifest.screening[retryTemplateId].status = "partial";
    manifest.screening[retryTemplateId].error = {
      code: "TESSERA_STALE_MATRIX",
      message: "Synthetic interrupted template capture.",
      retryable: true,
    };
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const beforeRetry = browserInputs.length;
    const retried = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      retried.ok,
      true,
      JSON.stringify(retried.violations, null, 2),
    );
    assert.equal(retried.data?.status, "complete");
    assert.equal(browserInputs.length, beforeRetry + 1);
    const retryInput = browserInputs.at(-1)!;
    assert.equal(retryInput.opponentName, retryOpponentName);
    assert.deepEqual(
      new Set(
        retryInput.frozenScenarioContract?.map(
          (entry) => entry.iterations,
        ),
      ),
      new Set([2_000]),
    );

    const revised: RosterDraftV1 = {
      ...player,
      name: "Per-template settings player revised",
      updatedAt: new Date().toISOString(),
    };
    rostersByName.set(revised.name, revised);
    const beforeRevision = browserInputs.length;
    const compared = await compareRosterStressRevision(
      baselinePath,
      revised,
      {
        experimental: true,
        outputDirectory: "revision",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      compared.ok,
      true,
      JSON.stringify(compared.violations, null, 2),
    );
    const revisionInputs = browserInputs.slice(beforeRevision);
    const revisedTemplateInput = revisionInputs.find(
      (input) =>
        input.analysisMode === "quick" &&
        input.opponentName === retryOpponentName,
    );
    assert.ok(revisedTemplateInput);
    assert.deepEqual(
      new Set(
        revisedTemplateInput.frozenScenarioContract?.map(
          (entry) => entry.iterations,
        ),
      ),
      new Set([2_000]),
    );

    const legacyReplayFailure = structuredClone(
      completedManifest,
    );
    legacyReplayFailure.schemaVersion = 3;
    legacyReplayFailure.stageContracts = {
      screening: structuredClone(
        completedManifest.stageContracts.screening[
          firstTemplateId
        ],
      ),
      deepDive: null,
    };
    legacyReplayFailure.completedAt = null;
    if (legacyReplayFailure.finalArtifacts) {
      legacyReplayFailure.finalArtifacts.jsonSha256 = null;
      legacyReplayFailure.finalArtifacts.htmlSha256 = null;
    }
    for (const templateId of readyTemplateIds) {
      if (
        templateId === firstTemplateId ||
        templateId === retryTemplateId
      ) {
        continue;
      }
      Object.assign(
        legacyReplayFailure.screening[templateId],
        {
          status: "pending",
          reportPath: null,
          reportSha256: null,
          error: null,
          attemptCount: 0,
          attemptHistory: [],
          firstAttemptAt: null,
          lastAttemptAt: null,
          nextAction: null,
        },
      );
    }
    Object.assign(
      legacyReplayFailure.screening[retryTemplateId],
      {
        status: "failed",
        reportPath: null,
        reportSha256: null,
        error: {
          code: "TESSERA_SETTINGS_REPLAY_FAILED",
          message:
            "Tessera is using 2000 iterations and did not expose one control for the frozen value 1000.",
          retryable: false,
        },
        attemptCount: 1,
        attemptHistory: [],
        firstAttemptAt: "2026-08-01T06:01:35.000Z",
        lastAttemptAt: "2026-08-01T06:01:55.000Z",
        nextAction:
          "Resolve the terminal error, then resume with --force-retry.",
      },
    );
    const genericReplayFailure = structuredClone(
      legacyReplayFailure,
    );
    genericReplayFailure.screening[
      retryTemplateId
    ].error.message =
      "Tessera settings replay failed for an unrelated terminal reason.";
    const legacyReplayPath = path.join(
      outputDirectory,
      "legacy-v3-iteration-replay.json",
    );
    const genericReplayPath = path.join(
      outputDirectory,
      "legacy-v3-generic-replay.json",
    );
    await Promise.all([
      writeFile(
        legacyReplayPath,
        `${JSON.stringify(legacyReplayFailure, null, 2)}\n`,
      ),
      writeFile(
        genericReplayPath,
        `${JSON.stringify(genericReplayFailure, null, 2)}\n`,
      ),
    ]);

    const beforeLegacyReplay = browserInputs.length;
    const migratedReplay = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: legacyReplayPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      migratedReplay.ok,
      true,
      JSON.stringify(migratedReplay.violations, null, 2),
    );
    assert.equal(migratedReplay.data?.status, "complete");
    const migratedReplayInputs = browserInputs.slice(
      beforeLegacyReplay,
    );
    const migratedTemplateInput = migratedReplayInputs.find(
      (input) => input.opponentName === retryOpponentName,
    );
    assert.ok(migratedTemplateInput);
    assert.equal(
      migratedTemplateInput.frozenScenarioContract,
      null,
      "the one recognized legacy cross-template replay failure must start a fresh template contract",
    );
    const migratedReplayManifest = JSON.parse(
      await readFile(legacyReplayPath, "utf8"),
    );
    assert.equal(migratedReplayManifest.schemaVersion, 7);
    assert.deepEqual(
      new Set(
        migratedReplayManifest.stageContracts.screening[
          retryTemplateId
        ].map(
          (entry: { iterations: number | null }) =>
            entry.iterations,
        ),
      ),
      new Set([2_000]),
    );

    const beforeGenericReplay = browserInputs.length;
    const genericReplay = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: genericReplayPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.ok(
      genericReplay.data?.status !== "complete",
      "an unrelated terminal replay failure must not be silently reopened",
    );
    assert.equal(
      browserInputs
        .slice(beforeGenericReplay)
        .some(
          (input) =>
            input.opponentName === retryOpponentName,
        ),
      false,
    );
    const migratedGenericManifest = JSON.parse(
      await readFile(genericReplayPath, "utf8"),
    );
    assert.equal(migratedGenericManifest.schemaVersion, 7);
    assert.deepEqual(
      migratedGenericManifest.screening[retryTemplateId].error,
      genericReplayFailure.screening[retryTemplateId].error,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest-seeded child reports count New Recruit reuse without remote mutations", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-manifest-reuse-accounting-"),
  );
  const player = roster(
    "adeptus-custodes",
    250,
    "Manifest Reuse Player",
  );
  const portfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 250,
    suite: "core-3",
  });
  assert.ok(portfolio.data);
  const requirements = aggregateProfileRequirements([
    player,
    ...portfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const profilePolicyPath = path.join(directory, "profiles.json");
  await writeFile(
    profilePolicyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: requirements.map((requirement) => ({
        faction: requirement.faction,
        unit: requirement.unit,
        weaponGroup: requirement.weaponGroup,
        phase: requirement.phase,
        selectedProfile: requirement.availableProfiles[0],
        activeCount: requirement.activeCount,
      })),
    }, null, 2)}\n`,
  );

  const rostersByName = new Map<string, RosterDraftV1>([
    [player.name, player],
  ]);
  let deliveryCalls = 0;
  let browserCalls = 0;
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    deliveryCalls += 1;
    rostersByName.set(candidate.name, candidate);
    const outputDirectory = options.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const source = path.join(outputDirectory, "source.rosz");
    const enriched = path.join(outputDirectory, "enriched.rosz");
    const content = await enrichedFixture(candidate);
    await Promise.all([
      writeFile(source, content),
      writeFile(enriched, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl: "https://www.newrecruit.eu/app/Lists/manifest-reuse",
        imported: true,
        sessionReused: true,
        verification: null,
        enrichedSummary: summaryFor(candidate),
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: source,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enriched,
          },
        ],
      },
      violations: [],
      warnings: [],
    };
  };
  const runBrowser = async (
    input: TesseraBrowserInput,
  ): Promise<TesseraBrowserResult> => {
    browserCalls += 1;
    const playerRoster = rostersByName.get(input.playerName);
    const opponentRoster = rostersByName.get(input.opponentName);
    assert.ok(playerRoster);
    assert.ok(opponentRoster);
    return browserResult(input, playerRoster, opponentRoster);
  };

  try {
    const initial = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        executionMode: "simulate",
        profilePolicyPath,
        outputDirectory: "initial",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      initial.ok,
      true,
      initial.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.equal(initial.data?.status, "complete");
    assert.equal(deliveryCalls, 4);
    assert.equal(browserCalls, 6);

    const manifestPath = path.join(
      directory,
      "initial",
      "stress-manifest.json",
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    const pendingEntry = () => ({
      status: "pending",
      reportPath: null,
      reportSha256: null,
      error: null,
      attemptCount: 0,
      attemptHistory: [],
      firstAttemptAt: null,
      lastAttemptAt: null,
      nextAction: null,
    });
    for (const stage of ["screening", "deepDive"] as const) {
      manifest[stage] = Object.fromEntries(
        Object.keys(manifest[stage]).map((templateId) => [
          templateId,
          pendingEntry(),
        ]),
      );
    }
    manifest.completedAt = null;
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const resumed = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        executionMode: "simulate",
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      resumed.ok,
      true,
      resumed.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.equal(resumed.data?.status, "complete");
    assert.ok(resumed.data?.preparation);
    assert.equal(resumed.data.preparation.remoteMutations, 0);
    assert.equal(resumed.data.preparation.cacheReuses, 4);
    assert.equal(deliveryCalls, 4);
    assert.equal(browserCalls, 12);

    const resumedManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    for (const stage of ["screening", "deepDive"] as const) {
      const entries = Object.values(resumedManifest[stage]) as Array<{
        reportPath: string;
      }>;
      assert.equal(entries.length, 3);
      for (const entry of entries) {
        const child = JSON.parse(
          await readFile(
            path.resolve(path.dirname(manifestPath), entry.reportPath),
            "utf8",
          ),
        );
        assert.deepEqual(child.preparation, {
          status: "complete",
          source: "new-recruit",
          uniqueRosters: 2,
          remoteMutations: 0,
          cacheReuses: 2,
          connectorEvents: [],
        });
        assert.equal(child.player.cacheReused, true);
        assert.equal(child.opponents[0]?.cacheReused, true);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enriched-only profile decisions stop before Tessera and resume without redelivery", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-enriched-profile-policy-"),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Enriched Profile Player",
  );
  const portfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1_000,
    suite: "core-3",
  });
  assert.ok(portfolio.data);
  const pinnedRequirements = aggregateProfileRequirements([
    player,
    ...portfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const extraRequirement: TesseraProfileRequirement = {
    faction: player.factionId,
    unit: player.units[0].name,
    selectionId: player.units[0].selectionId,
    weaponGroup: "Enriched-only stance",
    phase: "shooting",
    availableProfiles: ["Dispersed", "Focused"],
    activeCount: 1,
    selectedProfile: null,
  };
  const policy = (requirements: TesseraProfileRequirement[]) => ({
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
  });
  const initialPolicyPath = path.join(
    directory,
    "initial-policy.json",
  );
  await writeFile(
    initialPolicyPath,
    `${JSON.stringify(policy(pinnedRequirements), null, 2)}\n`,
  );
  const rostersByName = new Map<string, RosterDraftV1>([
    [player.name, player],
  ]);
  let deliveryCalls = 0;
  let browserCalls = 0;
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    deliveryCalls += 1;
    rostersByName.set(candidate.name, candidate);
    const outputDirectory = options.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const source = path.join(outputDirectory, "source.rosz");
    const enriched = path.join(outputDirectory, "enriched.rosz");
    const content = await enrichedFixture(
      candidate,
      candidate.id === player.id ? [extraRequirement] : [],
    );
    await Promise.all([
      writeFile(source, content),
      writeFile(enriched, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl: "https://www.newrecruit.eu/app/Lists/enriched-policy",
        imported: true,
        sessionReused: true,
        verification: null,
        enrichedSummary: summaryFor(candidate),
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: source,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enriched,
          },
        ],
      },
      violations: [],
      warnings: [],
    };
  };
  const runBrowser = async (
    input: TesseraBrowserInput,
  ): Promise<TesseraBrowserResult> => {
    browserCalls += 1;
    const playerRoster = rostersByName.get(input.playerName);
    const opponentRoster = rostersByName.get(input.opponentName);
    assert.ok(playerRoster);
    assert.ok(opponentRoster);
    return browserResult(input, playerRoster, opponentRoster);
  };

  try {
    const first = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath: initialPolicyPath,
        outputDirectory: "enriched-policy",
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(first.ok, false);
    assert.equal(
      first.violations[0]?.code,
      "TESSERA_PROFILE_POLICY_REQUIRED",
    );
    assert.equal(deliveryCalls, 4);
    assert.equal(browserCalls, 0);
    const manifestPath = path.join(
      directory,
      "enriched-policy",
      "stress-manifest.json",
    );
    const firstManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    assert.equal(
      firstManifest.enrichedProfileRequirements.some(
        (requirement: TesseraProfileRequirement) =>
          requirement.weaponGroup ===
          extraRequirement.weaponGroup,
      ),
      true,
    );
    const scaffold = JSON.parse(
      await readFile(
        path.join(
          directory,
          "enriched-policy",
          "tessera-profile-policy.scaffold.json",
        ),
        "utf8",
      ),
    );
    assert.equal(
      scaffold.entries.some(
        (entry: { weaponGroup: string }) =>
          entry.weaponGroup === extraRequirement.weaponGroup,
      ),
      true,
    );
    const completedPolicyPath = path.join(
      directory,
      "completed-policy.json",
    );
    await writeFile(
      completedPolicyPath,
      `${JSON.stringify(policy([
        ...pinnedRequirements,
        extraRequirement,
      ]), null, 2)}\n`,
    );
    const resumed = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath: completedPolicyPath,
        resumeManifestPath: manifestPath,
        rootDir: directory,
      },
      { deliver, runBrowser },
    );
    assert.equal(
      resumed.ok,
      true,
      resumed.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.equal(resumed.data?.status, "complete");
    assert.equal(deliveryCalls, 4);
    assert.equal(browserCalls, 6);
    const resumedManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );
    assert.match(resumedManifest.profilePolicyHash, /^[0-9a-f]{64}$/);
    assert.equal(
      resumedManifest.configuration.profilePolicyHash,
      resumedManifest.profilePolicyHash,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("build-and-stress keeps roster creation independent and returns a prepare-only full loop", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-build-and-stress-"),
  );
  const prompt =
    "Build a mobile, durable 1,000 point Custodes army";
  const seed = buildRoster({ prompt, pointsLimit: 1_000 });
  const opponentSeed = buildRoster({
    faction: "aeldari",
    pointsLimit: 1_000,
  });
  assert.ok(seed.data);
  assert.ok(opponentSeed.data);
  const repaired = await repairRosterDeterministically({
    prompt,
    faction: seed.data.factionId,
    pointsLimit: 1_000,
    name: "Adeptus Custodes 1000 vs Aeldari",
    preferences: seed.data.preferences,
    allowNamedCharacters:
      seed.data.constraints.allowNamedCharacters,
    allowLegends: seed.data.constraints.allowLegends,
    opponentContext: {
      kind: "known-faction",
      factionId: opponentSeed.data.factionId,
    },
    mixedThreatIntent: true,
  });
  assert.ok(repaired.data);
  const portfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1_000,
    suite: "core-3",
  });
  assert.ok(portfolio.data);
  const requirements = aggregateProfileRequirements([
    repaired.data.roster,
    ...portfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const profilePolicyPath = path.join(
    directory,
    "profiles.json",
  );
  await writeFile(
    profilePolicyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: requirements.map((requirement) => ({
        faction: requirement.faction,
        unit: requirement.unit,
        weaponGroup: requirement.weaponGroup,
        phase: requirement.phase,
        selectedProfile: requirement.availableProfiles[0],
        activeCount: requirement.activeCount,
      })),
    }, null, 2)}\n`,
  );
  let deliveries = 0;
  const deliver = async (
    candidate: RosterDraftV1,
    deliveryOptions: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    deliveries += 1;
    const outputDirectory =
      deliveryOptions.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const source = path.join(outputDirectory, "source.rosz");
    const enriched = path.join(
      outputDirectory,
      "enriched.rosz",
    );
    const content = await enrichedFixture(candidate);
    await Promise.all([
      writeFile(source, content),
      writeFile(enriched, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl:
          "https://www.newrecruit.eu/app/Lists/full-loop-fixture",
        imported: true,
        sessionReused: true,
        verification: null,
        enrichedSummary: summaryFor(candidate),
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: source,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enriched,
          },
        ],
      },
      violations: [],
      warnings: [],
    };
  };
  try {
    const result = await buildAndStressRosterAgainstFaction(
      {
        prompt,
        againstFaction: "aeldari",
        pointsLimit: 1_000,
        suite: "core-3",
        analysisStrategy: "staged",
        profilePolicyPath,
        outputDirectory: "full-loop",
        experimental: false,
      },
      { rootDir: directory },
      { deliver },
    );
    assert.equal(
      result.ok,
      true,
      result.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.equal(
      result.data?.rosterRepair.roster.name,
      "Adeptus Custodes 1000 vs Aeldari",
    );
    assert.ok(
      (result.data?.rosterRepair.roster.totalPoints ?? 0) >=
        980,
    );
    assert.equal(
      result.data?.portfolioPreview?.gates.accepted,
      true,
    );
    assert.equal(result.data?.stressReport?.source, "prepare-only");
    assert.equal(result.data?.stressReport?.status, "prepared");
    assert.equal(
      result.data?.stressReport?.simulation?.status,
      "not-requested",
    );
    assert.equal(result.data?.automaticRevisionApplied, false);
    assert.equal(
      result.data?.revisionCandidatesRequireAuthorization,
      true,
    );
    assert.equal(deliveries, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds transient retries and does not loop terminal failures", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-stress-retries-"),
  );
  const player = roster(
    "adeptus-custodes",
    1_000,
    "Retry Player",
  );
  const retryRostersByName = new Map<string, RosterDraftV1>([
    [player.name, player],
  ]);
  const portfolio = generateFactionStressPortfolio({
    faction: "aeldari",
    pointsLimit: 1_000,
    suite: "core-3",
  });
  assert.ok(portfolio.data);
  const requirements = aggregateProfileRequirements([
    player,
    ...portfolio.data.items.flatMap((item) =>
      item.roster ? [item.roster] : [],
    ),
  ]);
  const profilePolicyPath = path.join(directory, "profiles.json");
  await writeFile(
    profilePolicyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: requirements.map((requirement) => ({
        faction: requirement.faction,
        unit: requirement.unit,
        weaponGroup: requirement.weaponGroup,
        phase: requirement.phase,
        selectedProfile: requirement.availableProfiles[0],
        activeCount: requirement.activeCount,
      })),
    }, null, 2)}\n`,
  );
  let deliveryCalls = 0;
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    deliveryCalls += 1;
    retryRostersByName.set(candidate.name, candidate);
    const outputDirectory = options.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const source = path.join(outputDirectory, "source.rosz");
    const enriched = path.join(outputDirectory, "enriched.rosz");
    const content = await enrichedFixture(candidate);
    await Promise.all([
      writeFile(source, content),
      writeFile(enriched, content),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl: "https://www.newrecruit.eu/app/Lists/retry-fixture",
        imported: true,
        sessionReused: true,
        verification: null,
        enrichedSummary: summaryFor(candidate),
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: source,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enriched,
          },
        ],
      },
      violations: [],
      warnings: [],
    };
  };
  try {
    let durableCalls = 0;
    const durableAttempt = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        executionMode: "simulate",
        profilePolicyPath,
        outputDirectory: "durable-attempt-one",
        rootDir: directory,
        retryOwner: "durable-job",
        durableAttemptNumber: 1,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          durableCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
            "Synthetic durable-attempt timeout.",
          );
        },
      },
    );
    assert.equal(durableAttempt.ok, false);
    assert.equal(durableCalls, 1);
    deliveryCalls = 0;

    let transientCalls = 0;
    const transient = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        outputDirectory: "transient",
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          transientCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
            "Synthetic transient unlock timeout.",
          );
        },
      },
    );
    assert.equal(transient.ok, false);
    assert.equal(transient.data?.status, "failed");
    assert.equal(transient.data?.simulation?.status, "failed");
    assert.equal(transientCalls, 3);
    assert.equal(deliveryCalls, 4);
    const transientManifestPath = path.join(
      directory,
      "transient",
      "stress-manifest.json",
    );
    const transientManifest = JSON.parse(
      await readFile(transientManifestPath, "utf8"),
    );
    const transientEntries = Object.values(
      transientManifest.screening,
    ) as Array<{
      attemptCount: number;
      attemptHistory: unknown[];
      error: { retryable: boolean } | null;
    }>;
    assert.equal(
      transientEntries.filter(
        (entry) =>
          entry.attemptCount === 3 &&
          entry.attemptHistory.length === 3 &&
          entry.error?.retryable === true,
      ).length,
      1,
    );
    assert.equal(
      transientEntries.filter(
        (entry) => entry.attemptCount === 0,
      ).length,
      2,
    );

    const resumed = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: transientManifestPath,
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          transientCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
            "Synthetic transient unlock timeout.",
          );
        },
      },
    );
    assert.equal(resumed.ok, false);
    assert.equal(transientCalls, 5);
    const resumedManifest = JSON.parse(
      await readFile(transientManifestPath, "utf8"),
    );
    const resumedEntries = Object.values(
      resumedManifest.screening,
    ) as Array<{
      attemptCount: number;
      attemptHistory: unknown[];
    }>;
    assert.equal(
      resumedEntries.filter(
        (entry) =>
          entry.attemptCount === 5 &&
          entry.attemptHistory.length === 5,
      ).length,
      1,
    );
    assert.equal(
      resumedEntries.filter(
        (entry) => entry.attemptCount === 0,
      ).length,
      2,
    );
    const exhausted = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: transientManifestPath,
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          transientCalls += 1;
          throw new Error("Retry budget should prevent this call.");
        },
      },
    );
    assert.equal(exhausted.ok, false);
    assert.equal(transientCalls, 5);
    assert.ok(
      exhausted.data?.recovery.exhaustedTemplates.length,
    );
    assert.ok(
      exhausted.data?.recovery.nextActions.some((action) =>
        action.includes("--restart-from"),
      ),
    );

    const exhaustedWithForce = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: transientManifestPath,
        forceRetry: true,
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          transientCalls += 1;
          throw new Error("The five-attempt cap must be absolute.");
        },
      },
    );
    assert.equal(exhaustedWithForce.ok, false);
    assert.equal(transientCalls, 5);

    const restarted = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        restartManifestPath: transientManifestPath,
        outputDirectory: "restarted",
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          transientCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
            "Synthetic transient unlock timeout after restart.",
          );
        },
      },
    );
    assert.equal(restarted.ok, false);
    assert.equal(restarted.data?.status, "failed");
    assert.equal(transientCalls, 8);
    assert.equal(deliveryCalls, 4);
    const restartedManifestPath = path.join(
      directory,
      "restarted",
      "stress-manifest.json",
    );
    const restartedManifest = JSON.parse(
      await readFile(restartedManifestPath, "utf8"),
    );
    assert.notEqual(
      restartedManifest.runId,
      resumedManifest.runId,
    );
    assert.equal(
      restartedManifest.preparedPlayer.enrichedRoszPath,
      resumedManifest.preparedPlayer.enrichedRoszPath,
    );
    const restartedPreparedPaths = [
      restartedManifest.preparedPlayer.sourceRoszPath,
      restartedManifest.preparedPlayer.enrichedRoszPath,
      ...Object.values(
        restartedManifest.preparedOpponents,
      ).flatMap((value) => {
        const receipt = value as {
          prepared: {
            sourceRoszPath: string;
            enrichedRoszPath: string;
          };
        };
        return [
          receipt.prepared.sourceRoszPath,
          receipt.prepared.enrichedRoszPath,
        ];
      }),
    ];
    assert.ok(
      restartedPreparedPaths.every(
        (filename: string) =>
          !path.isAbsolute(filename) &&
          !filename.startsWith("..") &&
          filename.split(path.sep).slice(0, 2).join("/") ===
            "artifacts/sha256",
      ),
    );
    await Promise.all(
      restartedPreparedPaths.map((filename: string) =>
        readFile(path.resolve(path.dirname(restartedManifestPath), filename)),
      ),
    );
    await Promise.all(
      restartedPreparedPaths.map(async (filename: string) => {
        const resolved = path.resolve(
          path.dirname(restartedManifestPath),
          filename,
        );
        const digest = createHash("sha256")
          .update(await readFile(resolved))
          .digest("hex");
        assert.equal(path.basename(path.dirname(filename)), digest);
      }),
    );
    assert.ok(restartedManifest.finalArtifacts?.json);
    const restartedReport = JSON.parse(
      await readFile(
        path.resolve(
          path.dirname(restartedManifestPath),
          restartedManifest.finalArtifacts.json,
        ),
        "utf8",
      ),
    );
    const reportRoszPaths: string[] = [];
    const collectReportRoszPaths = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collectReportRoszPaths);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (
          typeof entry === "string" &&
          (key === "sourceRoszPath" ||
            key === "enrichedRoszPath")
        ) {
          reportRoszPaths.push(entry);
        } else {
          collectReportRoszPaths(entry);
        }
      }
    };
    collectReportRoszPaths(restartedReport);
    assert.ok(reportRoszPaths.length > 0);
    assert.ok(
      reportRoszPaths.every(
        (filename) =>
          !path.isAbsolute(filename) &&
          filename.startsWith("artifacts/sha256/"),
      ),
      JSON.stringify(reportRoszPaths, null, 2),
    );
    await Promise.all(
      reportRoszPaths.map((filename) =>
        readFile(path.join(directory, "restarted", filename)),
      ),
    );
    assert.deepEqual(
      Object.values(restartedManifest.screening)
        .map(
          (entry) =>
            (entry as { attemptCount: number }).attemptCount,
        )
        .sort((left, right) => right - left),
      [3, 0, 0],
    );
    await rm(path.join(directory, "transient"), {
      recursive: true,
      force: true,
    });
    const restartedRoundTrip = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        resumeManifestPath: restartedManifestPath,
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          transientCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PREMIUM_UNLOCK_TIMEOUT",
            "Synthetic transient unlock timeout after source removal.",
          );
        },
      },
    );
    assert.equal(restartedRoundTrip.ok, false);
    assert.equal(transientCalls, 10);
    assert.equal(deliveryCalls, 4);
    assert.ok(
      restartedRoundTrip.violations.every(
        (violation) =>
          !violation.code.includes("PREPARED") &&
          !violation.code.includes("BUNDLE_ARTIFACT"),
      ),
    );

    let terminalCalls = 0;
    const terminal = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        outputDirectory: "terminal",
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          terminalCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_UI_CHANGED",
            "Synthetic shared Tessera UI mismatch.",
          );
        },
      },
    );
    assert.equal(terminal.ok, false);
    assert.equal(terminal.data?.status, "failed");
    assert.equal(terminalCalls, 1);
    const terminalManifest = JSON.parse(
      await readFile(
        path.join(directory, "terminal", "stress-manifest.json"),
        "utf8",
      ),
    );
    const terminalEntries = Object.values(
      terminalManifest.screening,
    ) as Array<{
      attemptCount: number;
      error: { code: string; retryable: boolean } | null;
    }>;
    assert.equal(
      terminalEntries.filter(
        (entry) =>
          entry.attemptCount === 1 &&
          entry.error?.code === "TESSERA_UI_CHANGED" &&
          entry.error?.retryable === false,
      ).length,
      1,
    );
    assert.equal(
      terminalEntries.filter(
        (entry) => entry.attemptCount === 0,
      ).length,
      2,
    );

    let playerProfileCalls = 0;
    const playerProfileFailure = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        outputDirectory: "player-profile-terminal",
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          playerProfileCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PROFILE_EDITOR_MISMATCH",
            "[TESSERA_IMPORT_SIDE=player] Synthetic player profile mismatch.",
          );
        },
      },
    );
    assert.equal(playerProfileFailure.ok, false);
    assert.equal(playerProfileCalls, 1);

    let opponentProfileCalls = 0;
    const opponentProfileFailure = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        outputDirectory: "opponent-profile-terminal",
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async () => {
          opponentProfileCalls += 1;
          throw new TesseraAutomationError(
            "TESSERA_PROFILE_EDITOR_MISMATCH",
            "[TESSERA_IMPORT_SIDE=opponent] Synthetic opponent profile mismatch.",
          );
        },
      },
    );
    assert.equal(opponentProfileFailure.ok, false);
    assert.equal(
      opponentProfileCalls,
      opponentProfileFailure.data?.portfolio.coverage.ready,
      "Opponent-scoped profile failures must not suppress distinct proxies.",
    );

    let orderedWarningCalls = 0;
    const orderedWarnings = await runRosterStressTest(
      player,
      { kind: "faction", factionId: "aeldari" },
      {
        suite: "core-3",
        analysisStrategy: "staged",
        experimental: true,
        profilePolicyPath,
        outputDirectory: "ordered-warnings",
        rootDir: directory,
      },
      {
        deliver,
        wait: async () => undefined,
        runBrowser: async (input) => {
          orderedWarningCalls += 1;
          const playerRoster = retryRostersByName.get(
            input.playerName,
          );
          const opponentRoster = retryRostersByName.get(
            input.opponentName,
          );
          assert.ok(playerRoster);
          assert.ok(opponentRoster);
          const result = browserResult(
            input,
            playerRoster,
            opponentRoster,
          );
          result.scenarios = result.scenarios.filter(
            (scenario) => scenario.phase === "shooting",
          );
          result.warnings = [
            "[TESSERA_PROFILE_POLICY_APPLIED] Synthetic informational profile message.",
            "[TESSERA_MATRIX_STALE] Synthetic transient matrix failure.",
          ];
          return result;
        },
      },
    );
    assert.equal(orderedWarnings.ok, false);
    assert.equal(orderedWarnings.data?.status, "inconclusive");
    assert.equal(orderedWarningCalls, 9);
    const orderedWarningsManifest = JSON.parse(
      await readFile(
        path.join(
          directory,
          "ordered-warnings",
          "stress-manifest.json",
        ),
        "utf8",
      ),
    );
    const orderedWarningEntries = Object.values(
      orderedWarningsManifest.screening,
    ) as Array<{
      attemptCount: number;
      error: { code: string } | null;
    }>;
    assert.ok(
      orderedWarningEntries.every(
        (entry) =>
          entry.error?.code ===
            "TESSERA_MATRIX_STALE" &&
          entry.attemptCount === 3,
      ),
    );
    assert.equal(
      orderedWarningEntries.filter(
        (entry) => entry.attemptCount === 0,
      ).length,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
