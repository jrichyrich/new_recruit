import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "fflate";

import {
  buildRoster,
  exportRoster,
  getNewRecruitFactionSummary,
  newRecruitCatalogue,
  previewFactionStressPortfolio,
  rosterExecutionFingerprint,
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
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import type {
  TesseraBrowserInput,
  TesseraBrowserResult,
  TesseraScenario,
} from "../local/tessera/browser";
import { aggregateProfileRequirements } from "../local/tessera/profile-policy";
import {
  compareRosterStressRevision,
  runRosterStressTest,
} from "../local/tessera/stress";

function buildFixtureRoster(
  faction: string,
  pointsLimit: number,
  name: string,
): RosterDraftV1 {
  const result = buildRoster({ faction, pointsLimit, name });
  assert.equal(
    result.ok,
    true,
    result.violations.map((violation) => violation.message).join("\n"),
  );
  assert.ok(result.data);
  return result.data;
}

function enrichedSummary(roster: RosterDraftV1): EnrichedRoszSummary {
  const faction = getNewRecruitFactionSummary(roster.factionId);
  assert.ok(faction);
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
    profileCount: 2,
    weaponProfileCount: 1,
    units: roster.units.map((unit) => ({
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

async function enrichedRosz(
  roster: RosterDraftV1,
): Promise<Uint8Array> {
  const requirements = rosterProfileRequirements(roster);
  const exported = await exportRoster(roster, "rosz");
  assert.ok(exported.ok && exported.data);
  assert.notEqual(typeof exported.data.content, "string");
  const entries = unzipSync(exported.data.content as Uint8Array);
  const [, content] = Object.entries(entries)[0];
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
      const candidateIndex = roster.units.findIndex(
        (unit, index) =>
          index >= nextUnitIndex &&
          xmlAttribute(unit.name) === name,
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
      for (const requirement of requirements.filter(
        (candidate) =>
          candidate.selectionId ===
            roster.units[unitIndex!].selectionId &&
          xmlAttribute(candidate.weaponGroup) === name,
      )) {
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
  for (const [unitIndex, unit] of roster.units.entries()) {
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
  return zipSync({ "fixture.ros": strToU8(xml) });
}

function occurrenceAt(roster: RosterDraftV1, index: number): number {
  const name = roster.units[index].name;
  return roster.units
    .slice(0, index + 1)
    .filter((unit) => unit.name === name).length;
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

function scenario(
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
  return {
    id: `${phase}:${metric}:${direction}`,
    phase,
    metric,
    direction,
    settings: { phase, metric, direction },
    iterations: 1_000,
    matrixSha256: createHash("sha256")
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
      .digest("hex"),
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
        scenario(player, opponent, phase, metric, direction),
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function contentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

async function fileHash(filename: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

function policyFor(requirements: TesseraProfileRequirement[]) {
  return {
    schemaVersion: 1 as const,
    policyKind: "tessera-profile-policy" as const,
    entries: requirements.map((requirement) => ({
      faction: requirement.faction,
      unit: requirement.unit,
      unitOccurrence: requirement.unitOccurrence,
      modelCount: requirement.modelCount,
      weaponGroup: requirement.weaponGroup,
      phase: requirement.phase,
      selectedProfile: requirement.availableProfiles[0],
      activeCount: requirement.activeCount,
    })),
  };
}

test(
  "release acceptance: Custodes resume an interrupted adaptive-nine Aeldari run without redelivery",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "rosterpilot-release-acceptance-"),
    );
    const outputDirectory = path.join(root, "baseline");
    const player = buildFixtureRoster(
      "adeptus-custodes",
      2_000,
      "Release Acceptance Custodes",
    );
    const preview = await previewFactionStressPortfolio({
      faction: "aeldari",
      pointsLimit: 2_000,
      suite: "diverse-9",
    });
    assert.equal(
      preview.ok,
      true,
      preview.violations
        .map((violation) => violation.message)
        .join("\n"),
    );
    assert.ok(preview.data);

    const readyItems = preview.data.portfolio.items.filter(
      (item) => item.status === "ready" && item.roster !== null,
    );
    const executionFingerprints = readyItems.map((item) =>
      rosterExecutionFingerprint(item.roster!),
    );
    assert.equal(readyItems.length, 9);
    assert.equal(new Set(executionFingerprints).size, 9);
    assert.deepEqual(
      new Set(readyItems.map((item) => item.posture)),
      new Set([
        "balanced-control",
        "ranged-pressure",
        "assault-pressure",
      ]),
    );
    assert.equal(preview.data.gates.accepted, true);
    assert.equal(
      preview.data.gates.maximumResultStatus,
      "complete",
    );

    const frozenPortfolioHash = contentHash(
      preview.data.portfolio,
    );
    assert.match(frozenPortfolioHash, /^[0-9a-f]{64}$/);

    const profileRequirements = aggregateProfileRequirements([
      player,
      ...readyItems.map((item) => item.roster!),
    ]);
    const profilePolicyPath = path.join(root, "profile-policy.json");
    await writeFile(
      profilePolicyPath,
      `${JSON.stringify(policyFor(profileRequirements), null, 2)}\n`,
    );

    const rostersByName = new Map<string, RosterDraftV1>([
      [player.name, player],
      ...readyItems.map(
        (item) => [item.roster!.name, item.roster!] as const,
      ),
    ]);
    const deliveredFingerprints: string[] = [];
    const browserInputs: TesseraBrowserInput[] = [];
    let firstBrowserRun = true;
    let notifyBrowserStarted: () => void = () => {};
    const browserStarted = new Promise<void>((resolve) => {
      notifyBrowserStarted = resolve;
    });
    let releaseBrowserRun: () => void = () => {};
    const browserRelease = new Promise<void>((resolve) => {
      releaseBrowserRun = resolve;
    });

    const deliver = async (
      roster: RosterDraftV1,
      options: NewRecruitDeliveryOptions = {},
    ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
      deliveredFingerprints.push(
        rosterExecutionFingerprint(roster),
      );
      rostersByName.set(roster.name, roster);
      const directory = options.outputDirectory ?? root;
      await mkdir(directory, { recursive: true });
      const source = path.join(directory, "source.rosz");
      const enriched = path.join(directory, "enriched.rosz");
      const content = await enrichedRosz(roster);
      await Promise.all([
        writeFile(source, content),
        writeFile(enriched, content),
      ]);
      return {
        ok: true,
        data: {
          rosterId: roster.id,
          rosterName: roster.name,
          listUrl:
            "https://www.newrecruit.eu/app/Lists/release-acceptance-fixture",
          imported: true,
          sessionReused: true,
          verification: null,
          enrichedSummary: enrichedSummary(roster),
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
      if (firstBrowserRun) {
        firstBrowserRun = false;
        notifyBrowserStarted();
        await browserRelease;
      }
      const playerRoster = rostersByName.get(input.playerName);
      const opponentRoster = rostersByName.get(input.opponentName);
      assert.ok(playerRoster, input.playerName);
      assert.ok(opponentRoster, input.opponentName);
      return browserResult(input, playerRoster, opponentRoster);
    };

    try {
      setCachedDataFreshness({
        ok: true,
        data: {
          checkedAt: "2026-07-30T00:00:00.000Z",
          state: "current",
          rules: {
            pinnedVersion: "fixture",
            latestVersion: "fixture",
            updateAvailable: false,
          },
          newRecruit: {
            pinnedCommit: "a".repeat(40),
            latestCommit: "a".repeat(40),
            updateAvailable: false,
          },
          official: {
            pinnedVersion: "fixture",
            latestVersion: "fixture",
            pinnedContentSha256: "b".repeat(64),
            latestContentSha256: "b".repeat(64),
            updateAvailable: false,
          },
        },
        violations: [],
        warnings: [],
      });

      const durableRun = runRosterStressTest(
        player,
        { kind: "faction", factionId: "aeldari" },
        {
          suite: "diverse-9",
          analysisStrategy: "staged",
          executionMode: "simulate",
          profilePolicyPath,
          portfolioPreview: preview.data,
          outputDirectory,
          rootDir: root,
        },
        {
          deliver,
          runBrowser,
          wait: async () => {},
        },
      );
      await browserStarted;
      const clientView = await Promise.race([
        durableRun.then(() => "completed" as const),
        Promise.resolve("client-timeout" as const),
      ]);
      assert.equal(
        clientView,
        "client-timeout",
        "the client must lose its response while the durable run remains active",
      );
      releaseBrowserRun();
      const completedInBackground = await durableRun;
      assert.equal(
        completedInBackground.ok,
        true,
        JSON.stringify(
          {
            status: completedInBackground.data?.status,
            violations: completedInBackground.violations,
            warnings: completedInBackground.warnings,
          },
          null,
          2,
        ),
      );
      assert.equal(completedInBackground.data?.status, "complete");

      const manifestPath = path.join(
        outputDirectory,
        "stress-manifest.json",
      );
      const durableManifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      );
      assert.equal(
        contentHash(durableManifest.portfolio),
        frozenPortfolioHash,
      );
      assert.equal(
        durableManifest.portfolioSha256,
        frozenPortfolioHash,
      );
      assert.equal(
        completedInBackground.data?.portfolioSha256,
        frozenPortfolioHash,
      );
      assert.equal(
        Object.values(durableManifest.screening).filter(
          (entry) =>
            (entry as { status: string }).status === "complete",
        ).length,
        9,
      );
      assert.equal(deliveredFingerprints.length, 10);
      assert.equal(new Set(deliveredFingerprints).size, 10);
      assert.equal(
        durableManifest.profilePolicyHash,
        durableManifest.configuration.profilePolicyHash,
      );
      assert.match(
        durableManifest.profilePolicyHash,
        /^[0-9a-f]{64}$/,
      );
      assert.ok(
        durableManifest.profilePolicy.entries.every(
          (entry: { selectedProfile?: string }) =>
            typeof entry.selectedProfile === "string" &&
            entry.selectedProfile.length > 0,
        ),
      );

      const deliveryCountBeforeResume =
        deliveredFingerprints.length;
      const resumed = await runRosterStressTest(
        player,
        { kind: "faction", factionId: "aeldari" },
        {
          resumeManifestPath: manifestPath,
          rootDir: root,
        },
        {
          deliver,
          runBrowser,
          wait: async () => {},
        },
      );
      assert.equal(
        resumed.ok,
        true,
        JSON.stringify(
          {
            status: resumed.data?.status,
            violations: resumed.violations,
            warnings: resumed.warnings,
          },
          null,
          2,
        ),
      );
      assert.ok(resumed.data);
      assert.equal(resumed.data.status, "complete");
      assert.equal(
        deliveredFingerprints.length,
        deliveryCountBeforeResume,
        "resuming a frozen manifest must not redeliver the player or any proxy",
      );
      assert.equal(resumed.data.portfolio.coverage.ready, 9);
      assert.equal(
        new Set(
          resumed.data.portfolio.items
            .filter((item) => item.roster !== null)
            .map((item) =>
              rosterExecutionFingerprint(item.roster!),
            ),
        ).size,
        9,
      );
      assert.equal(resumed.data.representatives.length, 3);
      assert.equal(
        new Set(
          resumed.data.representatives.map(
            (representative) => representative.templateId,
          ),
        ).size,
        3,
      );
      assert.equal(
        resumed.data.profilePolicyHash,
        durableManifest.profilePolicyHash,
      );
      assert.equal(
        resumed.data.stageProvenance.screening.profilePolicyHash,
        resumed.data.profilePolicyHash,
      );
      assert.equal(
        resumed.data.stageProvenance.deepDive?.profilePolicyHash,
        resumed.data.profilePolicyHash,
      );
      assert.deepEqual(
        new Set(resumed.data.tesseraUiIdentity?.split("|")),
        new Set(["fixture-tessera-ui-v1"]),
      );

      const completedManifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      );
      assert.equal(
        contentHash(completedManifest.portfolio),
        frozenPortfolioHash,
      );
      assert.match(
        completedManifest.finalArtifacts.jsonSha256,
        /^[0-9a-f]{64}$/,
      );
      assert.match(
        completedManifest.finalArtifacts.htmlSha256,
        /^[0-9a-f]{64}$/,
      );
      assert.equal(
        await fileHash(
          path.resolve(
            outputDirectory,
            completedManifest.finalArtifacts.json,
          ),
        ),
        completedManifest.finalArtifacts.jsonSha256,
      );
      assert.equal(
        await fileHash(
          path.resolve(
            outputDirectory,
            completedManifest.finalArtifacts.html,
          ),
        ),
        completedManifest.finalArtifacts.htmlSha256,
      );

      const reportArtifact = resumed.data.artifacts.find(
        (artifact) => artifact.format === "stress-json",
      );
      assert.ok(reportArtifact);
      const reportPath = path.resolve(
        outputDirectory,
        reportArtifact.written,
      );
      const portableReport = JSON.parse(
        await readFile(reportPath, "utf8"),
      );
      assert.equal(
        contentHash(portableReport.portfolio),
        frozenPortfolioHash,
      );
      assert.equal(
        portableReport.profilePolicyHash,
        durableManifest.profilePolicyHash,
      );
      assert.ok(
        portableReport.artifacts.every(
          (artifact: { written: string }) =>
            !path.isAbsolute(artifact.written) &&
            !artifact.written.startsWith(".."),
        ),
      );
      assert.ok(
        !path.isAbsolute(portableReport.player.sourceRoszPath) &&
          !path.isAbsolute(portableReport.player.enrichedRoszPath),
      );
      const playerSourceArtifact = portableReport.artifacts.find(
        (artifact: { format: string }) =>
          artifact.format === "player-source-rosz",
      );
      const playerEnrichedArtifact = portableReport.artifacts.find(
        (artifact: { format: string }) =>
          artifact.format === "player-enriched-rosz",
      );
      assert.ok(playerSourceArtifact);
      assert.ok(playerEnrichedArtifact);
      assert.match(playerSourceArtifact.sha256, /^[0-9a-f]{64}$/);
      assert.match(playerEnrichedArtifact.sha256, /^[0-9a-f]{64}$/);
      assert.equal(
        await fileHash(
          path.resolve(
            outputDirectory,
            portableReport.player.sourceRoszPath,
          ),
        ),
        playerSourceArtifact.sha256,
      );
      assert.equal(
        await fileHash(
          path.resolve(
            outputDirectory,
            portableReport.player.enrichedRoszPath,
          ),
        ),
        playerEnrichedArtifact.sha256,
      );
      assert.equal(portableReport.frozenOpponentArtifacts.length, 9);
      for (const artifact of portableReport.frozenOpponentArtifacts) {
        assert.equal(path.isAbsolute(artifact.enrichedRoszPath), false);
        assert.equal(
          await fileHash(
            path.resolve(
              outputDirectory,
              artifact.enrichedRoszPath,
            ),
          ),
          artifact.sha256,
        );
      }
      const policyArtifact = portableReport.artifacts.find(
        (artifact: { format: string }) =>
          artifact.format === "profile-policy",
      );
      assert.ok(policyArtifact);
      assert.match(policyArtifact.sha256, /^[0-9a-f]{64}$/);
      assert.equal(
        await fileHash(
          path.resolve(outputDirectory, policyArtifact.written),
        ),
        policyArtifact.sha256,
      );

      const deliveryCountBeforeRevision =
        deliveredFingerprints.length;
      const browserCountBeforeRevision = browserInputs.length;
      const revised: RosterDraftV1 = {
        ...player,
        name: "Release Acceptance Custodes Revised",
        updatedAt: new Date().toISOString(),
      };
      rostersByName.set(revised.name, revised);
      const compared = await compareRosterStressRevision(
        reportPath,
        revised,
        {
          executionMode: "simulate",
          outputDirectory: "revision",
          rootDir: root,
        },
        {
          deliver,
          runBrowser,
          wait: async () => {},
        },
      );
      assert.equal(
        compared.ok,
        true,
        compared.violations
          .map((violation) => violation.message)
          .join("\n"),
      );
      assert.ok(compared.data);
      assert.equal(compared.data.summary.conclusion, "unchanged");
      assert.equal(compared.data.sampleDeltas.length, 9);
      assert.equal(compared.data.summary.unchanged, 9);
      assert.equal(
        compared.data.revised.recovery.verifiedPreparedOpponents,
        9,
      );
      assert.equal(
        deliveredFingerprints.length,
        deliveryCountBeforeRevision + 1,
        "paired revision may deliver the revised player once but must reuse all nine frozen opponents",
      );
      assert.equal(
        browserInputs.length,
        browserCountBeforeRevision + 12,
        "paired revision must rerun nine screening proxies and three frozen deep dives",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
