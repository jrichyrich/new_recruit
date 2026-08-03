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

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  buildRoster,
  exportRoster,
  inspectEnrichedRosz,
  rosterExecutionFingerprint,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import type { NewRecruitDeliveryOptions } from "../local/new-recruit/companion";
import type {
  TesseraBrowserResult,
  TesseraScenario,
} from "../local/tessera/browser";
import {
  analyzeRosterMatchup,
  compareRosterRevision,
  prepareRosterForTessera,
} from "../local/tessera/companion";
import {
  exactReportReceiptPath,
  type ExactMatchupReportReceipt,
} from "../local/tessera/exact-report-integrity";
import {
  compareRoszGameplaySnapshots,
  inspectRoszGameplaySnapshot,
  roszGameplaySnapshotSha256,
} from "../local/tessera/rosz-integrity";
import {
  aggregateProfileRequirements,
  profilePolicyScaffold,
} from "../local/tessera/profile-policy";

function roster(
  faction: string,
  name: string,
): RosterDraftV1 {
  const result = buildRoster({
    faction,
    pointsLimit: 1_000,
    name,
  });
  assert.equal(
    result.ok,
    true,
    result.violations.map((issue) => issue.message).join("\n"),
  );
  assert.ok(result.data);
  return result.data;
}

function sourceContent(
  artifact: Awaited<ReturnType<typeof exportRoster>>,
): Uint8Array {
  assert.ok(artifact.ok);
  assert.ok(artifact.data);
  assert.notEqual(typeof artifact.data.content, "string");
  return artifact.data.content as Uint8Array;
}

function enrichedContent(
  source: Uint8Array,
  mutate: (xml: string) => string = (xml) => xml,
): Uint8Array {
  const entries = unzipSync(source);
  const [filename, content] = Object.entries(entries)[0];
  let xml = strFromU8(content)
    .replace('generatedBy="RosterPilot"', 'generatedBy="https://newrecruit.eu"');
  xml = mutate(xml);
  xml = xml.replace(
    "</roster>",
    '<profiles><profile name="Fixture" typeName="Unit"/><profile name="Fixture gun" typeName="Ranged Weapons"/></profiles></roster>',
  );
  return zipSync({ [filename]: strToU8(xml) });
}

function fullyEnrichedContent(
  source: Uint8Array,
  mutate: (xml: string) => string = (xml) => xml,
): Uint8Array {
  const entries = unzipSync(source);
  const [filename, content] = Object.entries(entries)[0];
  let xml = mutate(
    strFromU8(content).replace(
      'generatedBy="RosterPilot"',
      'generatedBy="https://newrecruit.eu"',
    ),
  );
  const insertions: number[] = [];
  let selectionDepth = 0;
  for (const match of xml.matchAll(
    /<selection\b[^>]*>|<\/selection>/g,
  )) {
    const token = match[0];
    if (token === "</selection>") {
      selectionDepth -= 1;
      continue;
    }
    const type = token.match(/\btype="([^"]*)"/)?.[1] ?? "";
    if (
      selectionDepth === 0 &&
      (type === "unit" || type === "model") &&
      !token.endsWith("/>")
    ) {
      insertions.push((match.index ?? 0) + token.length);
    }
    if (!token.endsWith("/>")) selectionDepth += 1;
  }
  const profiles =
    '<profiles><profile name="Fixture model" typeName="Unit"/><profile name="Fixture weapon" typeName="Ranged Weapons"/></profiles>';
  for (const index of insertions.sort((left, right) => right - left)) {
    xml = `${xml.slice(0, index)}${profiles}${xml.slice(index)}`;
  }
  return zipSync({ [filename]: strToU8(xml) });
}

function artifactDelivery(
  fallbackDirectory: string,
  mutateEnriched: (xml: string) => string = (xml) => xml,
) {
  return async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ): Promise<ResultEnvelope<NewRecruitDelivery>> => {
    const directory = options.outputDirectory ?? fallbackDirectory;
    await mkdir(directory, { recursive: true });
    const exported = await exportRoster(candidate, "rosz");
    const source = sourceContent(exported);
    const enriched = fullyEnrichedContent(
      source,
      mutateEnriched,
    );
    const sourcePath = path.join(directory, "source.rosz");
    const enrichedPath = path.join(directory, "enriched.rosz");
    await Promise.all([
      writeFile(sourcePath, source),
      writeFile(enrichedPath, enriched),
    ]);
    return {
      ok: true,
      data: {
        rosterId: candidate.id,
        rosterName: candidate.name,
        listUrl: "https://www.newrecruit.eu/app/Lists/integrity-fixture",
        imported: true,
        sessionReused: true,
        verification: {
          name: true,
          faction: true,
          points: true,
          units: candidate.units.map((unit) => ({
            name: unit.name,
            modelCount: unit.modelCount,
            matched: true,
          })),
          mismatches: [],
        },
        enrichedSummary: inspectEnrichedRosz(enriched),
        artifacts: [
          {
            format: "rosterpilot-source-rosz",
            filename: "source.rosz",
            mimeType: "application/zip",
            written: sourcePath,
          },
          {
            format: "new-recruit-enriched-rosz",
            filename: "enriched.rosz",
            mimeType: "application/zip",
            written: enrichedPath,
          },
        ],
      },
      violations: [],
      warnings: [],
    };
  };
}

function policyFor(...rosters: RosterDraftV1[]) {
  const requirements = aggregateProfileRequirements(rosters);
  const scaffold = profilePolicyScaffold(requirements);
  return {
    ...scaffold,
    entries: scaffold.entries.map((entry, index) => ({
      ...entry,
      selectedProfile:
        requirements[index].availableProfiles[0],
    })),
  };
}

function occurrence(
  units: RosterDraftV1["units"],
  index: number,
): number {
  const name = units[index].name;
  return (
    units
      .slice(0, index + 1)
      .filter((unit) => unit.name === name).length
  );
}

function browserResult(
  player: RosterDraftV1,
  opponent: RosterDraftV1,
): TesseraBrowserResult {
  const scenarios: TesseraScenario[] = [
    ["player-to-opponent", player, opponent],
    ["opponent-to-player", opponent, player],
  ].map(([directionValue, attackersValue, targetsValue]) => {
    const direction =
      directionValue as "player-to-opponent" | "opponent-to-player";
    const attackers = attackersValue as RosterDraftV1;
    const targets = targetsValue as RosterDraftV1;
    const cells = attackers.units.flatMap((attacker, attackerIndex) =>
      targets.units.map((target, targetIndex) => ({
        attacker: attacker.name,
        target: target.name,
        direction,
        attackerIndex,
        targetIndex,
        attackerOccurrence: occurrence(
          attackers.units,
          attackerIndex,
        ),
        targetOccurrence: occurrence(targets.units, targetIndex),
        metricValue: 0.5,
        killProbability: 0.5,
        expectedDamage: null,
        damagePer100Points: null,
      })),
    );
    return {
      id: `shooting:${direction}:wipe-probability`,
      phase: "shooting",
      metric: "wipe-probability",
      direction,
      settings: {
        Phase: "shooting",
        Metric: "wipe-probability",
        Direction: direction,
      },
      iterations: 1_000,
      cells,
      matrixSha256: crypto
        .createHash("sha256")
        .update(JSON.stringify(cells))
        .digest("hex"),
      integrity: {
        status: "trusted",
        issueCodes: [],
        aliasedScenarioIds: [],
      },
    };
  });
  return {
    uiIdentity: crypto
      .createHash("sha256")
      .update("integrity-fixture-ui")
      .digest("hex"),
    settings: { iterations: "1000" },
    cells: [],
    scenarios,
    importWarnings: { player: [], opponent: [] },
    importIssues: [],
    integrityIssues: [],
    warnings: [],
  };
}

test("ROSZ gameplay snapshots detect Warlord, enhancement, and equipment drift", async () => {
  const candidate = roster(
    "adeptus-custodes",
    "Gameplay Snapshot",
  );
  const exported = sourceContent(await exportRoster(candidate, "rosz"));
  const drifted = enrichedContent(exported, (xml) =>
    xml.replace(
      /name="Warlord" entryId="([^"]+)"/,
      'name="Warlord" entryId="$1-changed"',
    ),
  );
  const mismatches = compareRoszGameplaySnapshots(
    inspectRoszGameplaySnapshot(exported),
    inspectRoszGameplaySnapshot(drifted),
  );
  assert.deepEqual(mismatches, ["selection-tree"]);
});

test("ROSZ gameplay snapshots tolerate New Recruit selection metadata enrichment", async () => {
  const candidate = roster(
    "adeptus-custodes",
    "Gameplay Snapshot Metadata",
  );
  const exported = sourceContent(await exportRoster(candidate, "rosz"));
  const enriched = enrichedContent(exported, (xml) =>
    xml
      .replace(
        /name="\d+\.\s+([^"]*Point limit)"/,
        'name="$1"',
      )
      .replace(
        /name="Warlord" entryId="([^"]+)" from="entry"/,
        'name="Warlord" entryId="$1" entryGroupId="new-recruit-group" group="Wargear" from="group"',
      )
      .replace(
        /<cost name="pts" typeId="[^"]+" value="0"\s*\/>/,
        "",
      ),
  );
  assert.deepEqual(
    compareRoszGameplaySnapshots(
      inspectRoszGameplaySnapshot(exported),
      inspectRoszGameplaySnapshot(enriched),
    ),
    [],
  );
});

test("ROSZ gameplay snapshots tolerate New Recruit selection-cost redistribution", () => {
  const archive = (unitCost: boolean): Uint8Array => {
    const cost =
      '<cost name="pts" typeId="51b2-306e-1021-d207" value="140" />';
    const xml = [
      '<roster id="cost-placement" name="Cost Placement" gameSystemId="system" gameSystemRevision="7">',
      `<costs>${cost}</costs>`,
      '<forces><force id="force" catalogueId="catalogue" catalogueRevision="1"><selections>',
      '<selection id="unit" name="Starfangs" entryId="unit-entry" number="1" type="unit">',
      unitCost ? `<costs>${cost}</costs>` : "",
      '<selections><selection id="model" name="Starfang" entryId="model-entry" number="2" type="model">',
      unitCost ? "" : `<costs>${cost}</costs>`,
      "</selection></selections></selection>",
      "</selections></force></forces></roster>",
    ].join("");
    return zipSync({ "cost-placement.ros": strToU8(xml) });
  };
  assert.deepEqual(
    compareRoszGameplaySnapshots(
      inspectRoszGameplaySnapshot(archive(true)),
      inspectRoszGameplaySnapshot(archive(false)),
    ),
    [],
  );
});

test("New Recruit enrichment drift is rejected before persistent reuse", async () => {
  const candidate = roster(
    "adeptus-custodes",
    "Enrichment Drift",
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-enrichment-integrity-"),
  );
  try {
    const prepared = await prepareRosterForTessera(
      candidate,
      {
        outputDirectory: directory,
        allowOutsideRoot: true,
      },
      {
        deliver: artifactDelivery(directory, (xml) =>
          xml.replace(
            /name="Warlord" entryId="([^"]+)"/,
            'name="Warlord" entryId="$1-changed"',
          ),
        ),
      },
    );
    assert.equal(prepared.ok, false);
    assert.equal(
      prepared.violations[0]?.code,
      "TESSERA_ROSZ_ENRICHMENT_DRIFT",
    );
    assert.ok(prepared.data);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a concrete pinned no-context upload runs exact simulation with an explicit legality warning", async () => {
  const player = roster(
    "adeptus-custodes",
    "No Context Player",
  );
  const opponent = roster("aeldari", "No Context Upload");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-no-context-upload-"),
  );
  const uploadedPath = path.join(directory, "opponent.rosz");
  let deliveryCalls = 0;
  let browserCalls = 0;
  try {
    const exported = sourceContent(
      await exportRoster(opponent, "rosz"),
    );
    const uploaded = fullyEnrichedContent(exported);
    await writeFile(uploadedPath, uploaded);
    const deliverPlayer = artifactDelivery(directory);
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "rosz", path: uploadedPath },
      {
        executionMode: "simulate",
        analysisMode: "quick",
        profilePolicy: policyFor(player),
        outputDirectory: path.join(directory, "report"),
        allowOutsideRoot: true,
      },
      {
        deliver: async (candidate, options = {}) => {
          deliveryCalls += 1;
          return deliverPlayer(candidate, options);
        },
        runBrowser: async () => {
          browserCalls += 1;
          return browserResult(player, opponent);
        },
      },
    );
    assert.equal(
      analyzed.ok,
      true,
      analyzed.violations.map((issue) => issue.message).join("\n"),
    );
    assert.ok(analyzed.data);
    assert.equal(
      analyzed.data.opponents[0]?.fingerprint,
      roszGameplaySnapshotSha256(
        inspectRoszGameplaySnapshot(uploaded),
      ),
    );
    assert.equal(analyzed.data.status, "complete");
    assert.ok(
      analyzed.data.warnings.some((warning) =>
        /roster legality and exact source release remain unverified/i.test(
          warning,
        ),
      ),
    );
    assert.equal(deliveryCalls, 1);
    assert.equal(browserCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a context-verified uploaded ROSZ preserves its canonical identity across a paired player revision", async () => {
  const player = roster(
    "adeptus-custodes",
    "Raw Baseline Player",
  );
  const opponent = roster(
    "aeldari",
    "Raw Standalone Opponent",
  );
  const revised = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Raw Baseline Player Revision",
    excludedUnitIds: ["allarus-custodians"],
  });
  assert.equal(
    revised.ok,
    true,
    revised.violations.map((issue) => issue.message).join("\n"),
  );
  assert.ok(revised.data);
  assert.notDeepEqual(
    revised.data.units.map((unit) => unit.unitId),
    player.units.map((unit) => unit.unitId),
  );

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-raw-paired-revision-"),
  );
  const uploadedPath = path.join(
    directory,
    "standalone-opponent.rosz",
  );
  const rawUploaded = sourceContent(
    await exportRoster(opponent, "rosz"),
  );
  const profilePolicy = policyFor(player, opponent);
  const deliver = artifactDelivery(directory);
  let deliveryCalls = 0;
  let enrichmentCalls = 0;
  const enrich = async (
    sourcePath: string,
    options: {
      outputDirectory?: string;
    } = {},
  ) => {
    enrichmentCalls += 1;
    const source = await readFile(sourcePath);
    const enriched = fullyEnrichedContent(source);
    const outputDirectory =
      options.outputDirectory ?? directory;
    await mkdir(outputDirectory, { recursive: true });
    const enrichedPath = path.join(
      outputDirectory,
      "standalone-opponent-enriched.rosz",
    );
    await writeFile(enrichedPath, enriched);
    return {
      ok: true,
      data: {
        listUrl:
          "https://www.newrecruit.eu/app/Lists/raw-standalone-fixture",
        imported: true,
        sessionReused: true,
        connectorEvents: [
          {
            schemaVersion: 1 as const,
            eventId: `raw-standalone-enrichment-${enrichmentCalls}`,
            recordedAt: new Date().toISOString(),
            provider: "new-recruit" as const,
            action: "prepare" as const,
            origin: "new-remote" as const,
            outcome: "verified" as const,
            remoteId: "raw-standalone-fixture",
            contentSha256: crypto
              .createHash("sha256")
              .update(enriched)
              .digest("hex"),
          },
        ],
        enrichedRoszPath: enrichedPath,
        summary: inspectEnrichedRosz(enriched),
      },
      violations: [],
      warnings: [],
    };
  };
  try {
    await writeFile(uploadedPath, rawUploaded);
    const baseline = await analyzeRosterMatchup(
      player,
      { kind: "rosz", path: uploadedPath },
      {
        executionMode: "simulate",
        analysisMode: "quick",
        profilePolicy,
        opponentRosterContext: opponent,
        outputDirectory: path.join(directory, "baseline"),
        allowOutsideRoot: true,
      },
      {
        deliver: async (candidate, options = {}) => {
          deliveryCalls += 1;
          return deliver(candidate, options);
        },
        enrich,
        runBrowser: async () =>
          browserResult(player, opponent),
      },
    );
    assert.equal(
      baseline.ok,
      true,
      baseline.violations
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("\n"),
    );
    assert.ok(baseline.data);
    assert.equal(enrichmentCalls, 1);
    assert.equal(deliveryCalls, 1);

    const baselineReportPath =
      baseline.data.artifacts.find(
        (artifact) => artifact.format === "matchup-json",
      )?.written;
    assert.ok(baselineReportPath);
    const portableBaseline = JSON.parse(
      await readFile(baselineReportPath, "utf8"),
    ) as typeof baseline.data;
    const frozenOpponent = portableBaseline.opponents[0];
    assert.ok(frozenOpponent?.sourceRoszPath);
    const reportDirectory = path.dirname(baselineReportPath);
    const resolveReportArtifact = (filename: string): string =>
      path.isAbsolute(filename)
        ? filename
        : path.resolve(reportDirectory, filename);
    const frozenSourcePath = resolveReportArtifact(
      frozenOpponent.sourceRoszPath,
    );
    const frozenEnrichedPath = resolveReportArtifact(
      frozenOpponent.enrichedRoszPath,
    );
    const [frozenSource, frozenEnriched] = await Promise.all([
      readFile(frozenSourcePath),
      readFile(frozenEnrichedPath),
    ]);
    const digest = (content: Uint8Array): string =>
      crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");
    assert.equal(
      digest(frozenSource),
      frozenOpponent.sourceRoszSha256,
    );
    assert.equal(
      digest(frozenEnriched),
      frozenOpponent.enrichedRoszSha256,
    );
    assert.deepEqual(
      compareRoszGameplaySnapshots(
        inspectRoszGameplaySnapshot(frozenSource),
        inspectRoszGameplaySnapshot(frozenEnriched),
      ),
      [],
    );
    assert.equal(
      rosterExecutionFingerprint(opponent),
      frozenOpponent.fingerprint,
    );

    const compared = await compareRosterRevision(
      baselineReportPath,
      revised.data,
      {
        executionMode: "simulate",
        analysisMode: "quick",
        profilePolicy,
        outputDirectory: path.join(directory, "revision"),
        allowOutsideRoot: true,
      },
      {
        deliver: async (candidate, options = {}) => {
          deliveryCalls += 1;
          return deliver(candidate, options);
        },
        enrich,
        runBrowser: async () =>
          browserResult(revised.data!, opponent),
      },
    );
    assert.equal(
      compared.ok,
      true,
      compared.violations
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("\n"),
    );
    assert.ok(compared.data);
    assert.equal(compared.data.baselineRunId, baseline.data.runId);
    assert.equal(compared.data.revisedReports.length, 1);
    assert.equal(
      compared.data.revisedReports[0].opponents[0]?.fingerprint,
      frozenOpponent.fingerprint,
    );
    assert.equal(
      compared.data.revisedReports[0].opponents[0]
        ?.enrichedRoszSha256,
      frozenOpponent.enrichedRoszSha256,
    );
    assert.equal(
      compared.data.revisedReports[0].opponents[0]
        ?.sourceRoszSha256,
      frozenOpponent.sourceRoszSha256,
    );
    assert.equal(enrichmentCalls, 1);
    assert.equal(deliveryCalls, 2);
    assert.equal(
      digest(await readFile(frozenEnrichedPath)),
      frozenOpponent.enrichedRoszSha256,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uploaded ROSZ enrichment uses preflight-frozen bytes after the original path changes", async () => {
  const player = roster(
    "adeptus-custodes",
    "Frozen Upload Player",
  );
  const opponent = roster("aeldari", "Frozen Upload Opponent");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-frozen-upload-"),
  );
  const uploadedPath = path.join(directory, "opponent.rosz");
  const original = sourceContent(
    await exportRoster(opponent, "rosz"),
  );
  const replacement = enrichedContent(original, (xml) =>
    xml.replace('name="Warlord"', 'name="Replacement Warlord"'),
  );
  const deliverPlayer = artifactDelivery(directory);
  let frozenPath: string | null = null;
  try {
    await writeFile(uploadedPath, original);
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "rosz", path: uploadedPath },
      {
        executionMode: "prepare-only",
        opponentRosterContext: opponent,
        outputDirectory: path.join(directory, "report"),
        allowOutsideRoot: true,
      },
      {
        deliver: async (candidate, options = {}) => {
          await writeFile(uploadedPath, replacement);
          return deliverPlayer(candidate, options);
        },
        enrich: async (sourcePath, options = {}) => {
          frozenPath = sourcePath;
          assert.notEqual(sourcePath, uploadedPath);
          assert.deepEqual(
            await readFile(sourcePath),
            Buffer.from(original),
          );
          const enriched = fullyEnrichedContent(original);
          const outputDirectory =
            options.outputDirectory ?? directory;
          await mkdir(outputDirectory, { recursive: true });
          const enrichedPath = path.join(
            outputDirectory,
            "frozen-enriched.rosz",
          );
          await writeFile(enrichedPath, enriched);
          return {
            ok: true,
            data: {
              listUrl: null,
              imported: false,
              sessionReused: true,
              connectorEvents: [
                {
                  schemaVersion: 1,
                  eventId: "frozen-upload-reuse",
                  recordedAt: new Date().toISOString(),
                  provider: "new-recruit",
                  action: "prepare",
                  origin: "in-memory",
                  outcome: "reused",
                  remoteId: null,
                  contentSha256: crypto
                    .createHash("sha256")
                    .update(enriched)
                    .digest("hex"),
                },
              ],
              enrichedRoszPath: enrichedPath,
              summary: inspectEnrichedRosz(enriched),
            },
            violations: [],
            warnings: [],
          };
        },
      },
    );
    assert.equal(
      analyzed.ok,
      true,
      analyzed.violations.map((issue) => issue.message).join("\n"),
    );
    assert.match(
      frozenPath ?? "",
      /uploaded-source-[0-9a-f]{64}\.rosz$/,
    );
    assert.notEqual(
      Buffer.compare(
        await readFile(uploadedPath),
        Buffer.from(original),
      ),
      0,
    );
    assert.ok(analyzed.data && "preparation" in analyzed.data);
    assert.ok(analyzed.data.preparation);
    assert.equal(analyzed.data.preparation.remoteMutations, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a raw profileless upload is enriched but an incomplete enriched handoff is rejected", async () => {
  const player = roster(
    "adeptus-custodes",
    "Profile Boundary Player",
  );
  const opponent = roster(
    "aeldari",
    "Profile Boundary Opponent",
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-profile-boundary-"),
  );
  const uploadedPath = path.join(directory, "opponent.rosz");
  const rawUploaded = sourceContent(
    await exportRoster(opponent, "rosz"),
  );
  const deliverPlayer = artifactDelivery(directory);
  let enrichmentCalls = 0;
  try {
    await writeFile(uploadedPath, rawUploaded);
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "rosz", path: uploadedPath },
      {
        executionMode: "prepare-only",
        opponentRosterContext: opponent,
        outputDirectory: path.join(directory, "report"),
        allowOutsideRoot: true,
      },
      {
        deliver: deliverPlayer,
        enrich: async (_sourcePath, options = {}) => {
          enrichmentCalls += 1;
          const incomplete = enrichedContent(rawUploaded);
          const outputDirectory =
            options.outputDirectory ?? directory;
          await mkdir(outputDirectory, { recursive: true });
          const enrichedPath = path.join(
            outputDirectory,
            "incomplete-enriched.rosz",
          );
          await writeFile(enrichedPath, incomplete);
          return {
            ok: true,
            data: {
              listUrl: null,
              imported: true,
              sessionReused: true,
              connectorEvents: [],
              enrichedRoszPath: enrichedPath,
              summary: inspectEnrichedRosz(incomplete),
            },
            violations: [],
            warnings: [],
          };
        },
      },
    );
    assert.equal(analyzed.ok, false);
    assert.equal(
      analyzed.violations[0]?.code,
      "TESSERA_ROSZ_PROFILES_INCOMPLETE",
    );
    assert.equal(enrichmentCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uploaded ROSZ freeze failure stops before player delivery", async () => {
  const player = roster(
    "adeptus-custodes",
    "Freeze Failure Player",
  );
  const opponent = roster("aeldari", "Freeze Failure Opponent");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-freeze-failure-"),
  );
  const uploadedPath = path.join(directory, "opponent.rosz");
  const content = sourceContent(
    await exportRoster(opponent, "rosz"),
  );
  const outputDirectory = path.join(directory, "report");
  const frozenDirectory = path.join(
    outputDirectory,
    "opponent",
  );
  const frozenPath = path.join(
    frozenDirectory,
    `uploaded-source-${crypto
      .createHash("sha256")
      .update(content)
      .digest("hex")}.rosz`,
  );
  let deliveryCalls = 0;
  try {
    await Promise.all([
      writeFile(uploadedPath, content),
      mkdir(frozenDirectory, { recursive: true }),
    ]);
    await writeFile(frozenPath, "different bytes");
    const analyzed = await analyzeRosterMatchup(
      player,
      { kind: "rosz", path: uploadedPath },
      {
        executionMode: "prepare-only",
        opponentRosterContext: opponent,
        outputDirectory,
        allowOutsideRoot: true,
      },
      {
        deliver: async () => {
          deliveryCalls += 1;
          throw new Error("Player delivery must not start.");
        },
      },
    );
    assert.equal(analyzed.ok, false);
    assert.equal(
      analyzed.violations[0]?.code,
      "TESSERA_ROSZ_FREEZE_FAILED",
    );
    assert.equal(deliveryCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an exact output lease prevents concurrent New Recruit mutations", async () => {
  const player = roster("adeptus-custodes", "Lease Player");
  const opponent = roster("aeldari", "Lease Opponent");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-exact-lease-"),
  );
  let releaseFirstDelivery!: () => void;
  const firstDeliveryMayContinue = new Promise<void>((resolve) => {
    releaseFirstDelivery = resolve;
  });
  let deliveryCalls = 0;
  const deliverBase = artifactDelivery(directory);
  const deliver = async (
    candidate: RosterDraftV1,
    options: NewRecruitDeliveryOptions = {},
  ) => {
    deliveryCalls += 1;
    if (deliveryCalls === 1) await firstDeliveryMayContinue;
    return deliverBase(candidate, options);
  };
  try {
    const first = analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "prepare-only",
        outputDirectory: directory,
        allowOutsideRoot: true,
      },
      { deliver },
    );
    while (deliveryCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const second = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "prepare-only",
        outputDirectory: directory,
        allowOutsideRoot: true,
      },
      { deliver },
    );
    assert.equal(second.ok, false);
    assert.equal(
      second.violations[0]?.code,
      "TESSERA_OUTPUT_LEASED",
    );
    assert.equal(deliveryCalls, 1);
    releaseFirstDelivery();
    const completed = await first;
    assert.equal(completed.ok, true);
  } finally {
    releaseFirstDelivery?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired revisions reject edited cells even when retained matrix hashes and the byte receipt are rewritten", async () => {
  const player = roster(
    "adeptus-custodes",
    "Receipt Baseline Player",
  );
  const opponent = roster("aeldari", "Receipt Baseline Opponent");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tessera-baseline-receipt-"),
  );
  let revisionDeliveries = 0;
  try {
    const deliver = artifactDelivery(directory);
    const policy = policyFor(player, opponent);
    const baseline = await analyzeRosterMatchup(
      player,
      { kind: "roster", roster: opponent },
      {
        executionMode: "simulate",
        analysisMode: "quick",
        profilePolicy: policy,
        outputDirectory: path.join(directory, "baseline"),
        allowOutsideRoot: true,
      },
      {
        deliver,
        runBrowser: async () => browserResult(player, opponent),
      },
    );
    assert.equal(
      baseline.ok,
      true,
      baseline.violations.map((issue) => issue.message).join("\n"),
    );
    assert.ok(baseline.data);
    const reportPath = baseline.data.artifacts[0].written;
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.simulation.scenarios[0].cells[0].values.wipeProbability =
      0.99;
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, serialized);

    const receiptPath = exactReportReceiptPath(reportPath);
    const receipt = JSON.parse(
      await readFile(receiptPath, "utf8"),
    ) as ExactMatchupReportReceipt;
    receipt.reportSha256 = crypto
      .createHash("sha256")
      .update(serialized)
      .digest("hex");
    await writeFile(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );

    const compared = await compareRosterRevision(
      reportPath,
      player,
      {
        executionMode: "simulate",
        analysisMode: "quick",
        profilePolicy: policy,
        outputDirectory: path.join(directory, "revision"),
        allowOutsideRoot: true,
      },
      {
        deliver: async (candidate, options = {}) => {
          revisionDeliveries += 1;
          return deliver(candidate, options);
        },
        runBrowser: async () => {
          throw new Error("Tessera must not run for changed evidence.");
        },
      },
    );
    assert.equal(compared.ok, false);
    assert.equal(
      compared.violations[0]?.code,
      "TESSERA_BASELINE_INTEGRITY_CHANGED",
    );
    assert.match(
      compared.violations[0]?.message ?? "",
      /scenario or matrix evidence changed/i,
    );
    assert.equal(revisionDeliveries, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
