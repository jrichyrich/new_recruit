import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LIVE_CERTIFICATION_SCENARIO_IDS,
  captureLiveTesseraCertificationResult,
  parseCertificationTesseraBrowserResult,
  tesseraSavedListConnectorEvents,
} from "../local/certification/live-tessera-evidence";
import {
  preserveCertificationResumeAttempt,
  relocateCertificationResumeArtifactClosure,
} from "../local/certification/live-resume";
import type {
  CertificationArtifactDescriptor,
  CertificationReport,
} from "../lib/rosterpilot/certification";
import type {
  TesseraBrowserResult,
  TesseraDirection,
  TesseraMetric,
  TesseraPhase,
} from "../local/tessera/browser";

function fullResult(): TesseraBrowserResult {
  return {
    uiIdentity: "tessera-ui-fixture",
    settings: {
      range: "24",
      cover: "off",
      charge: "successful",
    },
    cells: [],
    scenarios: LIVE_CERTIFICATION_SCENARIO_IDS.map((id) => {
      const [phase, direction, metric] = id.split(":") as [
        TesseraPhase,
        TesseraDirection,
        TesseraMetric,
      ];
      return {
        id,
        phase,
        direction,
        metric,
        settings: {
          range: "24",
          cover: "off",
          charge: "successful",
          phase:
            phase === "shooting" ? "Shooting" : "Fight",
          metric:
            metric === "wipe-probability"
              ? "P(Wiped)"
              : metric === "half-wipe-probability"
                ? "P(≥ Half)"
                : metric === "mean-kills"
                  ? "Mean kills"
                  : "Mean damage",
          direction:
            direction === "player-to-opponent"
              ? "A → B"
              : "B → A",
          iterations: "10000",
        },
        iterations: 10_000,
        cells: [
          {
            attacker: "Fixture attacker",
            target: "Fixture target",
            direction,
            killProbability: 0.25,
            expectedDamage: 3,
            damagePer100Points: 1.5,
            attackerIndex: 0,
            targetIndex: 0,
            attackerOccurrence: 1,
            targetOccurrence: 1,
            metricValue: 0.25,
          },
        ],
        matrixSha256: crypto
          .createHash("sha256")
          .update(id)
          .digest("hex"),
        integrity: {
          status: "trusted" as const,
          issueCodes: [],
          aliasedScenarioIds: [],
        },
      };
    }),
    importWarnings: {
      player: ["Player import warning"],
      opponent: ["Opponent import warning"],
    },
    importIssues: [
      {
        code: "alternate-profile",
        side: "player",
        unit: "Fixture unit",
        weaponGroup: "Fixture weapon",
        availableProfiles: ["strike", "sweep"],
        phase: "fight",
        message: "The fixture policy selected strike.",
        resolvedByPolicy: true,
        selectedProfile: "strike",
      },
    ],
    integrityIssues: [],
    savedListReuse: {
      mode: "deterministic",
      player: {
        name: `RP-CERT-A-${"a".repeat(24)}`,
        expectedUnitCount: 1,
        action: "reused",
        contentSha256: "a".repeat(64),
      },
      opponent: {
        name: `RP-CERT-B-${"b".repeat(24)}`,
        expectedUnitCount: 1,
        action: "imported",
        contentSha256: "b".repeat(64),
      },
    },
    warnings: ["One scenario could not be captured."],
  };
}

test("live certification retains a returned partial Tessera result as failed hash-verifiable evidence", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-partial-tessera-"),
  );
  try {
    const result = fullResult();
    const missingScenarioId =
      "fight:opponent-to-player:mean-damage";
    result.scenarios = result.scenarios.filter(
      (scenario) => scenario.id !== missingScenarioId,
    );
    result.scenarioAttempts = [
      {
        scenarioId: missingScenarioId,
        attempt: 1,
        status: "failed",
        code: "TESSERA_STALE_MATRIX",
        message: "The fixture matrix stayed stale.",
        retryable: true,
        willRetry: true,
      },
      {
        scenarioId: missingScenarioId,
        attempt: 2,
        status: "failed",
        code: "TESSERA_STALE_MATRIX",
        message: "The fixture matrix stayed stale.",
        retryable: true,
        willRetry: false,
      },
    ];
    const profilePolicyEvidence = {
      sourceCanonicalSha256: "a".repeat(64),
      appliedCanonicalSha256: "b".repeat(64),
      requirements: [{ unit: "Fixture unit" }],
    };
    const captured =
      await captureLiveTesseraCertificationResult({
        factionId: "death-guard",
        playerName: "Death Guard certification",
        opponentName: "Death Guard certification Mirror",
        expectedPlayerUnitCount: 1,
        expectedOpponentUnitCount: 1,
        result,
        profilePolicyEvidence,
        eventId: "partial-simulation",
        recordedAt: "2026-07-29T00:00:00.000Z",
        writeArtifact: async (filename, content) => {
          const relative = path.join(
            "artifacts",
            "canonical",
            path.basename(filename),
          );
          const absolute = path.join(directory, relative);
          await mkdir(path.dirname(absolute), {
            recursive: true,
          });
          await writeFile(absolute, content);
          return relative;
        },
      });

    assert.equal(captured.complete, false);
    assert.equal(captured.status, "fail");
    assert.equal(
      captured.code,
      "CERTIFICATION_TESSERA_SCENARIOS_INCOMPLETE",
    );
    assert.equal(captured.retryable, true);
    assert.match(captured.message, /15\/16/);
    assert.equal(path.isAbsolute(captured.artifact.path), false);
    assert.match(
      captured.artifact.path,
      /tessera-partial-scenarios\.json$/,
    );

    const artifactContent = await readFile(
      path.join(directory, captured.artifact.path),
    );
    assert.equal(
      crypto
        .createHash("sha256")
        .update(artifactContent)
        .digest("hex"),
      captured.artifact.sha256,
    );
    const artifact = JSON.parse(
      artifactContent.toString("utf8"),
    ) as Record<string, unknown>;
    assert.equal(artifact.status, "partial");
    assert.equal(artifact.uiIdentity, result.uiIdentity);
    assert.deepEqual(artifact.settings, result.settings);
    assert.deepEqual(
      artifact.profilePolicy,
      profilePolicyEvidence,
    );
    assert.deepEqual(artifact.scenarios, result.scenarios);
    assert.deepEqual(
      artifact.scenarioAttempts,
      result.scenarioAttempts,
    );
    assert.deepEqual(
      artifact.importWarnings,
      result.importWarnings,
    );
    assert.deepEqual(artifact.importIssues, result.importIssues);
    assert.deepEqual(
      artifact.savedListReuse,
      result.savedListReuse,
    );
    assert.deepEqual(artifact.warnings, result.warnings);

    assert.equal(captured.evidence.expectedScenarioCount, 16);
    assert.equal(captured.evidence.returnedScenarioCount, 15);
    assert.equal(captured.evidence.trustedScenarioCount, 15);
    assert.deepEqual(
      captured.evidence.missingCanonicalScenarioIds,
      [missingScenarioId],
    );
    assert.deepEqual(
      captured.evidence.scenarioData,
      result.scenarios,
    );
    assert.deepEqual(
      captured.evidence.scenarioAttempts,
      result.scenarioAttempts,
    );
    assert.deepEqual(
      captured.evidence.importWarnings,
      result.importWarnings,
    );
    assert.deepEqual(
      captured.evidence.importIssues,
      result.importIssues,
    );
    assert.deepEqual(
      captured.evidence.savedListReuse,
      result.savedListReuse,
    );
    assert.deepEqual(
      captured.evidence.profilePolicy,
      profilePolicyEvidence,
    );
    assert.equal(
      captured.evidence.uiIdentity,
      result.uiIdentity,
    );
    assert.deepEqual(
      captured.evidence.settings,
      result.settings,
    );
    assert.deepEqual(
      captured.evidence.warnings,
      result.warnings,
    );

    assert.equal(captured.connectorEvent.provider, "tessera");
    assert.equal(captured.connectorEvent.action, "simulate");
    assert.equal(captured.connectorEvent.origin, "new-remote");
    assert.equal(captured.connectorEvent.outcome, "failed");
    assert.equal(captured.connectorEvent.remoteId, null);
    assert.equal(
      captured.connectorEvent.contentSha256,
      captured.evidence.scenarioFingerprint,
    );
    assert.equal(captured.connectorEvents.length, 3);
    assert.deepEqual(
      captured.connectorEvents
        .filter((event) => event.action === "prepare")
        .map((event) => ({
          origin: event.origin,
          outcome: event.outcome,
          contentSha256: event.contentSha256,
        })),
      [
        {
          origin: "manifest-reuse",
          outcome: "reused",
          contentSha256: "a".repeat(64),
        },
        {
          origin: "new-remote",
          outcome: "verified",
          contentSha256: "b".repeat(64),
        },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Tessera saved-list accounting records two first-run imports and zero repeat imports", () => {
  const firstRun = fullResult().savedListReuse!;
  firstRun.player.action = "imported";
  firstRun.opponent.action = "imported";
  const imported = tesseraSavedListConnectorEvents({
    savedListReuse: firstRun,
    recordedAt: "2026-07-30T00:00:00.000Z",
    eventIdSeed: "first-run",
  });
  assert.equal(
    imported.filter(
      (event) =>
        event.action === "prepare" &&
        event.origin === "new-remote" &&
        event.outcome === "verified",
    ).length,
    2,
  );
  assert.equal(
    new Set(imported.map((event) => event.remoteId)).size,
    2,
  );
  assert.ok(
    imported.every((event) => event.contentSha256 !== null),
  );

  const repeat = fullResult().savedListReuse!;
  repeat.player.action = "reused";
  repeat.opponent.action = "reused";
  const reused = tesseraSavedListConnectorEvents({
    savedListReuse: repeat,
    recordedAt: "2026-07-30T00:05:00.000Z",
    eventIdSeed: "repeat-run",
  });
  assert.equal(
    reused.filter(
      (event) =>
        event.action === "prepare" &&
        event.origin === "new-remote",
    ).length,
    0,
  );
  assert.equal(
    reused.filter(
      (event) =>
        event.action === "prepare" &&
        event.origin === "manifest-reuse" &&
        event.outcome === "reused",
    ).length,
    2,
  );
});

test("live certification passes only the exact trusted canonical set with UI identity and transposed dimensions", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-tessera-gates-"),
  );
  const writeArtifact = async (
    filename: string,
    content: Uint8Array,
  ) => {
    const relative = path.join(
      "artifacts",
      "canonical",
      path.basename(filename),
    );
    const absolute = path.join(directory, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    return relative;
  };
  const capture = (
    result: unknown,
    profilePolicyEvidence: Record<string, unknown> = {},
  ) =>
    captureLiveTesseraCertificationResult({
      factionId: "death-guard",
      playerName: "Player",
      opponentName: "Opponent",
      expectedPlayerUnitCount: 1,
      expectedOpponentUnitCount: 1,
      result,
      profilePolicyEvidence,
      writeArtifact,
    });
  try {
    const complete = await capture(fullResult());
    assert.equal(complete.status, "pass");

    const noncanonical = fullResult();
    const replaced =
      "fight:opponent-to-player:mean-damage";
    noncanonical.scenarios.at(-1)!.id =
      "fight:opponent-to-player:unexpected";
    const wrongIds = await capture(noncanonical);
    assert.equal(wrongIds.status, "fail");
    assert.deepEqual(
      wrongIds.evidence.missingCanonicalScenarioIds,
      [replaced],
    );
    assert.deepEqual(wrongIds.evidence.unexpectedScenarioIds, [
      "fight:opponent-to-player:unexpected",
    ]);

    const untrusted = fullResult();
    untrusted.scenarios[0].integrity = undefined;
    const untrustedCapture = await capture(untrusted);
    assert.equal(untrustedCapture.status, "fail");
    assert.deepEqual(
      untrustedCapture.evidence.untrustedScenarioIds,
      [untrusted.scenarios[0].id],
    );

    const unidentified = fullResult();
    unidentified.uiIdentity = null;
    const unidentifiedCapture = await capture(unidentified);
    assert.equal(unidentifiedCapture.status, "fail");
    assert.equal(
      unidentifiedCapture.evidence.uiIdentityPresent,
      false,
    );

    const dimensionMismatch = fullResult();
    for (const scenario of dimensionMismatch.scenarios.filter(
      (candidate) =>
        candidate.direction === "player-to-opponent",
    )) {
      scenario.cells.push({
        ...scenario.cells[0],
        target: "Second fixture target",
        targetIndex: 1,
        targetOccurrence: 1,
      });
    }
    const dimensionCapture = await capture(dimensionMismatch);
    assert.equal(dimensionCapture.status, "fail");
    assert.equal(
      (
        dimensionCapture.evidence.dimensions as {
          consistent: boolean;
        }
      ).consistent,
      false,
    );
    assert.match(
      (
        dimensionCapture.evidence.dimensions as {
          issues: string[];
        }
      ).issues.join("\n"),
      /not the transpose/,
    );
    assert.match(
      (
        dimensionCapture.evidence.dimensions as {
          issues: string[];
        }
      ).issues.join("\n"),
      /imported-unit counts/,
    );

    const tupleMismatch = fullResult();
    tupleMismatch.scenarios[0].phase = "fight";
    tupleMismatch.scenarios[0].settings.phase = "Fight";
    const tupleCapture = await capture(tupleMismatch);
    assert.equal(tupleCapture.status, "fail");
    assert.deepEqual(
      tupleCapture.evidence.invalidContractScenarioIds,
      [tupleMismatch.scenarios[0].id],
    );
    assert.deepEqual(
      tupleCapture.evidence.scenarioContractIssues,
      [
        {
          scenarioId: tupleMismatch.scenarios[0].id,
          codes: ["TESSERA_SCENARIO_ID_TUPLE_MISMATCH"],
        },
      ],
    );

    const zeroIterations = fullResult();
    zeroIterations.scenarios[0].iterations = 0;
    zeroIterations.scenarios[0].settings.iterations = "0";
    const zeroIterationsCapture =
      await capture(zeroIterations);
    assert.equal(zeroIterationsCapture.status, "fail");
    assert.deepEqual(
      zeroIterationsCapture.evidence.scenarioContractIssues,
      [
        {
          scenarioId: zeroIterations.scenarios[0].id,
          codes: ["TESSERA_SCENARIO_ITERATIONS_INVALID"],
        },
      ],
    );

    const invalidHash = fullResult();
    invalidHash.scenarios[0].matrixSha256 = "not-a-hash";
    const invalidHashCapture = await capture(invalidHash);
    assert.equal(invalidHashCapture.status, "fail");
    assert.deepEqual(
      invalidHashCapture.evidence.scenarioContractIssues,
      [
        {
          scenarioId: invalidHash.scenarios[0].id,
          codes: ["TESSERA_SCENARIO_MATRIX_HASH_INVALID"],
        },
      ],
    );

    const settingsMismatch = fullResult();
    settingsMismatch.scenarios[0].settings.range = "18";
    const settingsMismatchCapture =
      await capture(settingsMismatch);
    assert.equal(settingsMismatchCapture.status, "fail");
    assert.deepEqual(
      settingsMismatchCapture.evidence
        .scenarioContractIssues,
      [
        {
          scenarioId: settingsMismatch.scenarios[0].id,
          codes: ["TESSERA_SCENARIO_SETTINGS_MISMATCH"],
        },
      ],
    );

    const controlMismatch = fullResult();
    controlMismatch.scenarios[0].settings.phase = "Fight";
    controlMismatch.scenarios[0].settings.metric =
      "Mean damage";
    controlMismatch.scenarios[0].settings.direction = "B → A";
    controlMismatch.scenarios[0].settings.iterations = "1";
    const controlMismatchCapture =
      await capture(controlMismatch);
    assert.equal(controlMismatchCapture.status, "fail");
    assert.deepEqual(
      controlMismatchCapture.evidence.scenarioContractIssues,
      [
        {
          scenarioId: controlMismatch.scenarios[0].id,
          codes: ["TESSERA_SCENARIO_SETTINGS_MISMATCH"],
        },
      ],
    );

    const cellDirectionMismatch = fullResult();
    cellDirectionMismatch.scenarios[0].cells[0].direction =
      "opponent-to-player";
    const cellDirectionCapture =
      await capture(cellDirectionMismatch);
    assert.equal(cellDirectionCapture.status, "fail");
    assert.deepEqual(
      cellDirectionCapture.evidence.scenarioContractIssues,
      [
        {
          scenarioId: cellDirectionMismatch.scenarios[0].id,
          codes: [
            "TESSERA_SCENARIO_CELL_DIRECTION_MISMATCH",
          ],
        },
      ],
    );

    const baseFingerprint =
      complete.evidence.scenarioFingerprint;
    assert.match(String(baseFingerprint), /^[0-9a-f]{64}$/);

    const changedSettings = fullResult();
    changedSettings.settings.range = "18";
    for (const scenario of changedSettings.scenarios) {
      scenario.settings.range = "18";
    }
    const changedSettingsCapture =
      await capture(changedSettings);
    assert.equal(changedSettingsCapture.status, "pass");
    assert.notEqual(
      changedSettingsCapture.evidence.scenarioFingerprint,
      baseFingerprint,
    );

    const changedIterations = fullResult();
    for (const scenario of changedIterations.scenarios) {
      scenario.iterations = 20_000;
      scenario.settings.iterations = "20000";
    }
    const changedIterationsCapture =
      await capture(changedIterations);
    assert.equal(changedIterationsCapture.status, "pass");
    assert.notEqual(
      changedIterationsCapture.evidence.scenarioFingerprint,
      baseFingerprint,
    );

    const changedUi = fullResult();
    changedUi.uiIdentity = "tessera-ui-fixture-v2";
    const changedUiCapture = await capture(changedUi);
    assert.equal(changedUiCapture.status, "pass");
    assert.notEqual(
      changedUiCapture.evidence.scenarioFingerprint,
      baseFingerprint,
    );

    const changedPolicyCapture = await capture(fullResult(), {
      appliedCanonicalSha256: "f".repeat(64),
    });
    assert.equal(changedPolicyCapture.status, "pass");
    assert.notEqual(
      changedPolicyCapture.evidence.scenarioFingerprint,
      baseFingerprint,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the certification boundary rejects malformed local-agent Tessera responses before writing evidence", async () => {
  const malformed = {
    ...fullResult(),
    scenarios: "not-an-array",
  };
  assert.throws(
    () => parseCertificationTesseraBrowserResult(malformed),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { code?: string }).code,
        "CERTIFICATION_TESSERA_RESULT_INVALID",
      );
      return true;
    },
  );

  let writes = 0;
  await assert.rejects(
    () =>
      captureLiveTesseraCertificationResult({
        factionId: "death-guard",
        playerName: "Player",
        opponentName: "Opponent",
        expectedPlayerUnitCount: 1,
        expectedOpponentUnitCount: 1,
        result: malformed,
        profilePolicyEvidence: {},
        writeArtifact: async () => {
          writes += 1;
          return "must-not-be-written.json";
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { code?: string }).code,
        "CERTIFICATION_TESSERA_RESULT_INVALID",
      );
      return true;
    },
  );
  assert.equal(writes, 0);
});

test("live resume preserves the exact prior report as a content-addressed bundle artifact", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-report-attempt-"),
  );
  try {
    const content = Buffer.from(
      '{\n  "reportKind": "rosterpilot-certification",\n  "status": "fail"\n}\n',
      "utf8",
    );
    const descriptor =
      await preserveCertificationResumeAttempt({
        content,
        writeArtifact: async (filename, artifactContent) => {
          const relative = path.join(
            "artifacts",
            "canonical",
            path.basename(filename),
          );
          const absolute = path.join(directory, relative);
          await mkdir(path.dirname(absolute), {
            recursive: true,
          });
          await writeFile(absolute, artifactContent);
          return relative;
        },
      });
    assert.equal(descriptor.kind, "report-attempt");
    assert.equal(path.isAbsolute(descriptor.path), false);
    assert.match(
      descriptor.path,
      /certification-report-attempt-[0-9a-f]{64}\.json$/,
    );
    const preserved = await readFile(
      path.join(directory, descriptor.path),
    );
    assert.deepEqual(preserved, content);
    assert.equal(
      crypto.createHash("sha256").update(preserved).digest("hex"),
      descriptor.sha256,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cross-directory resume relocates and verifies the recursive report-attempt artifact closure", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-resume-closure-source-"),
  );
  const destinationDirectory = await mkdtemp(
    path.join(
      os.tmpdir(),
      "rosterpilot-resume-closure-destination-",
    ),
  );
  const digest = (content: Uint8Array) =>
    crypto.createHash("sha256").update(content).digest("hex");
  const put = async (
    kind: CertificationArtifactDescriptor["kind"],
    relativePath: string,
    content: Uint8Array,
  ): Promise<CertificationArtifactDescriptor> => {
    const absolutePath = path.join(
      sourceDirectory,
      relativePath,
    );
    await mkdir(path.dirname(absolutePath), {
      recursive: true,
    });
    await writeFile(absolutePath, content);
    return {
      kind,
      path: relativePath,
      sha256: digest(content),
    };
  };
  const selfArtifacts: CertificationArtifactDescriptor[] = [
    {
      kind: "report",
      path: "certification-report-fixture.json",
      sha256: null,
    },
    {
      kind: "report-checksum",
      path: "certification-report-fixture.json.sha256",
      sha256: null,
    },
  ];
  const lineage = {
    schemaVersion: 1 as const,
    reportKind: "rosterpilot-certification" as const,
    runId: "resume-closure-fixture",
    tier: "live" as const,
    manifestSha256: "a".repeat(64),
  };
  try {
    const canonical = await put(
      "canonical-rosz",
      "artifacts/canonical/core.rosz",
      Buffer.from("canonical"),
    );
    const enrichedContent = Buffer.from("enriched");
    const enriched = await put(
      "enriched-rosz",
      "artifacts/canonical/enriched.rosz",
      enrichedContent,
    );
    const scenarioContent = Buffer.from('{"scenarios":[]}\n');
    const scenario = await put(
      "scenario",
      "artifacts/canonical/scenario.json",
      scenarioContent,
    );
    const policy = await put(
      "profile-policy",
      "artifacts/canonical/profiles.json",
      Buffer.from('{"schemaVersion":1}\n'),
    );
    const manifest = await put(
      "manifest",
      "certification-manifest-fixture.json",
      Buffer.from('{"manifestKind":"fixture"}\n'),
    );

    const oldestReport = {
      ...lineage,
      artifacts: [policy, ...selfArtifacts],
      cases: [{ artifacts: [scenario] }],
    };
    const oldestContent = Buffer.from(
      `${JSON.stringify(oldestReport, null, 2)}\n`,
    );
    const oldestAttempt = await put(
      "report-attempt",
      `artifacts/canonical/certification-report-attempt-${digest(oldestContent)}.json`,
      oldestContent,
    );
    const earlierReport = {
      ...lineage,
      artifacts: [oldestAttempt, ...selfArtifacts],
      cases: [{ artifacts: [enriched] }],
    };
    const earlierContent = Buffer.from(
      `${JSON.stringify(earlierReport, null, 2)}\n`,
    );
    const earlierAttempt = await put(
      "report-attempt",
      `artifacts/canonical/certification-report-attempt-${digest(earlierContent)}.json`,
      earlierContent,
    );
    const previous = {
      ...lineage,
      artifacts: [
        manifest,
        earlierAttempt,
        ...selfArtifacts,
      ],
      cases: [
        { artifacts: [canonical] },
        { artifacts: [canonical] },
      ],
    } as unknown as CertificationReport;

    const relocated =
      await relocateCertificationResumeArtifactClosure({
        previous,
        resumeBundleDirectory: sourceDirectory,
        outputBundleDirectory: destinationDirectory,
      });
    assert.equal(relocated.length, 7);
    assert.ok(
      relocated.every(
        (artifact) =>
          !path.isAbsolute(artifact.path) &&
          artifact.sha256 !== null,
      ),
    );

    const verifiedAttempts = new Set<string>();
    const verifyReport = async (candidate: {
      artifacts: CertificationArtifactDescriptor[];
      cases: Array<{
        artifacts: CertificationArtifactDescriptor[];
      }>;
    }): Promise<void> => {
      for (const artifact of [
        ...candidate.artifacts,
        ...candidate.cases.flatMap(
          (result) => result.artifacts,
        ),
      ]) {
        if (
          artifact.kind === "report" ||
          artifact.kind === "report-checksum"
        ) {
          continue;
        }
        assert.ok(artifact.sha256);
        const content = await readFile(
          path.join(destinationDirectory, artifact.path),
        );
        assert.equal(digest(content), artifact.sha256);
        if (
          artifact.kind === "report-attempt" &&
          !verifiedAttempts.has(artifact.path)
        ) {
          verifiedAttempts.add(artifact.path);
          await verifyReport(JSON.parse(content.toString("utf8")));
        }
      }
    };
    await verifyReport(previous);
    assert.equal(verifiedAttempts.size, 2);
    await assert.rejects(
      readFile(
        path.join(
          destinationDirectory,
          selfArtifacts[0].path,
        ),
      ),
      (error: Error & { code?: string }) =>
        error.code === "ENOENT",
    );

    await writeFile(
      path.join(sourceDirectory, oldestAttempt.path),
      Buffer.from("corrupt attempt"),
    );
    await assert.rejects(
      relocateCertificationResumeArtifactClosure({
        previous,
        resumeBundleDirectory: sourceDirectory,
        outputBundleDirectory: destinationDirectory,
      }),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_HASH_MISMATCH",
    );
    await writeFile(
      path.join(sourceDirectory, oldestAttempt.path),
      oldestContent,
    );
    await rm(path.join(sourceDirectory, oldestAttempt.path));
    await assert.rejects(
      relocateCertificationResumeArtifactClosure({
        previous,
        resumeBundleDirectory: sourceDirectory,
        outputBundleDirectory: destinationDirectory,
      }),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_ARTIFACT_MISSING",
    );
    await writeFile(
      path.join(sourceDirectory, oldestAttempt.path),
      oldestContent,
    );

    await writeFile(
      path.join(sourceDirectory, scenario.path),
      Buffer.from("corrupt"),
    );
    await assert.rejects(
      relocateCertificationResumeArtifactClosure({
        previous,
        resumeBundleDirectory: sourceDirectory,
        outputBundleDirectory: destinationDirectory,
      }),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_HASH_MISMATCH",
    );

    await writeFile(
      path.join(sourceDirectory, scenario.path),
      scenarioContent,
    );
    await rm(path.join(sourceDirectory, enriched.path));
    await assert.rejects(
      relocateCertificationResumeArtifactClosure({
        previous,
        resumeBundleDirectory: sourceDirectory,
        outputBundleDirectory: destinationDirectory,
      }),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_ARTIFACT_MISSING",
    );
    await writeFile(
      path.join(sourceDirectory, enriched.path),
      enrichedContent,
    );

    const escaping = structuredClone(previous);
    escaping.cases.push({
      artifacts: [
        {
          kind: "scenario",
          path: "../outside.json",
          sha256: "a".repeat(64),
        },
      ],
    } as CertificationReport["cases"][number]);
    await assert.rejects(
      relocateCertificationResumeArtifactClosure({
        previous: escaping,
        resumeBundleDirectory: sourceDirectory,
        outputBundleDirectory: destinationDirectory,
      }),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_PATH_INVALID",
    );

    const previousContent = Buffer.from(
      `${JSON.stringify(previous, null, 2)}\n`,
    );
    const currentAttemptPath =
      `artifacts/canonical/certification-report-attempt-${digest(previousContent)}.json`;
    await writeFile(
      path.join(destinationDirectory, currentAttemptPath),
      previousContent,
    );
    const resumedReport = {
      ...lineage,
      artifacts: [
        {
          kind: "report-attempt",
          path: currentAttemptPath,
          sha256: digest(previousContent),
        },
        ...selfArtifacts,
      ],
      cases: [],
    } as unknown as CertificationReport;
    await rm(sourceDirectory, { recursive: true, force: true });
    const secondDestination = await mkdtemp(
      path.join(
        os.tmpdir(),
        "rosterpilot-resume-closure-second-",
      ),
    );
    try {
      const secondRelocation =
        await relocateCertificationResumeArtifactClosure({
          previous: resumedReport,
          resumeBundleDirectory: destinationDirectory,
          outputBundleDirectory: secondDestination,
        });
      assert.equal(secondRelocation.length, 8);
      for (const artifact of secondRelocation) {
        assert.ok(artifact.sha256);
        const content = await readFile(
          path.join(secondDestination, artifact.path),
        );
        assert.equal(digest(content), artifact.sha256);
      }
    } finally {
      await rm(secondDestination, {
        recursive: true,
        force: true,
      });
    }
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(destinationDirectory, {
      recursive: true,
      force: true,
    });
  }
});

test("resume artifact relocation fails closed on unsafe paths, files, reports, conflicts, and graph size", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-resume-hardening-source-"),
  );
  const destinationDirectory = await mkdtemp(
    path.join(
      os.tmpdir(),
      "rosterpilot-resume-hardening-destination-",
    ),
  );
  const outsideDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-resume-hardening-outside-"),
  );
  const digest = (content: Uint8Array) =>
    crypto.createHash("sha256").update(content).digest("hex");
  const lineage = {
    schemaVersion: 1 as const,
    reportKind: "rosterpilot-certification" as const,
    runId: "resume-hardening-fixture",
    tier: "live" as const,
    manifestSha256: "a".repeat(64),
  };
  const previous = (
    artifacts: CertificationArtifactDescriptor[],
  ) =>
    ({
      ...lineage,
      artifacts,
      cases: [],
    }) as unknown as CertificationReport;
  const relocate = (report: CertificationReport) =>
    relocateCertificationResumeArtifactClosure({
      previous: report,
      resumeBundleDirectory: sourceDirectory,
      outputBundleDirectory: destinationDirectory,
    });
  try {
    for (const unsafePath of [
      "../outside.json",
      "C:\\outside\\artifact.json",
      "\\\\server\\share\\artifact.json",
      "artifact\0.json",
    ]) {
      await assert.rejects(
        relocate(
          previous([
            {
              kind: "scenario",
              path: unsafePath,
              sha256: "a".repeat(64),
            },
          ]),
        ),
        (error: Error & { code?: string }) =>
          error.code ===
          "CERTIFICATION_RESUME_RELOCATION_PATH_INVALID",
      );
    }

    await assert.rejects(
      relocate(
        previous([
          {
            kind: "scenario",
            path: "artifacts/malformed-hash.json",
            sha256: "ABC",
          },
        ]),
      ),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_HASH_MISSING",
    );

    const directoryArtifactPath =
      "artifacts/canonical/not-a-file";
    await mkdir(
      path.join(sourceDirectory, directoryArtifactPath),
      { recursive: true },
    );
    await assert.rejects(
      relocate(
        previous([
          {
            kind: "scenario",
            path: directoryArtifactPath,
            sha256: "a".repeat(64),
          },
        ]),
      ),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_ARTIFACT_NOT_REGULAR",
    );

    if (process.platform !== "win32") {
      const outsideContent = Buffer.from("outside");
      const outsidePath = path.join(
        outsideDirectory,
        "outside.json",
      );
      await writeFile(outsidePath, outsideContent);
      const symlinkPath =
        "artifacts/canonical/symlink-escape.json";
      await mkdir(
        path.dirname(path.join(sourceDirectory, symlinkPath)),
        { recursive: true },
      );
      await symlink(
        outsidePath,
        path.join(sourceDirectory, symlinkPath),
      );
      await assert.rejects(
        relocate(
          previous([
            {
              kind: "scenario",
              path: symlinkPath,
              sha256: digest(outsideContent),
            },
          ]),
        ),
        (error: Error & { code?: string }) =>
          error.code ===
          "CERTIFICATION_RESUME_RELOCATION_PATH_INVALID",
      );
    }

    const invalidAttemptContent = Buffer.from(
      `${JSON.stringify({
        ...lineage,
        reportKind: "wrong",
        artifacts: [],
        cases: [],
      })}\n`,
    );
    const invalidAttemptPath =
      "artifacts/canonical/invalid-attempt.json";
    await writeFile(
      path.join(sourceDirectory, invalidAttemptPath),
      invalidAttemptContent,
    );
    await assert.rejects(
      relocate(
        previous([
          {
            kind: "report-attempt",
            path: invalidAttemptPath,
            sha256: digest(invalidAttemptContent),
          },
        ]),
      ),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_ATTEMPT_INVALID",
    );

    const conflictingContent = Buffer.from("conflict");
    const conflictingPath =
      "artifacts/canonical/conflicting.json";
    await writeFile(
      path.join(sourceDirectory, conflictingPath),
      conflictingContent,
    );
    await assert.rejects(
      relocate(
        previous([
          {
            kind: "scenario",
            path: conflictingPath,
            sha256: digest(conflictingContent),
          },
          {
            kind: "scenario",
            path: conflictingPath,
            sha256: "b".repeat(64),
          },
        ]),
      ),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_DESCRIPTOR_CONFLICT",
    );
    await assert.rejects(
      readFile(path.join(destinationDirectory, conflictingPath)),
      (error: Error & { code?: string }) =>
        error.code === "ENOENT",
    );

    await assert.rejects(
      relocate(
        previous(
          Array.from(
            { length: 10_001 },
            (_, index) => ({
              kind: "report",
              path: `report-${index}.json`,
              sha256: null,
            }),
          ),
        ),
      ),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_RELOCATION_LIMIT_EXCEEDED",
    );
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(destinationDirectory, {
      recursive: true,
      force: true,
    });
    await rm(outsideDirectory, {
      recursive: true,
      force: true,
    });
  }
});
