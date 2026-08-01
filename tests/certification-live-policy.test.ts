import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  buildRoster,
  rosterExecutionFingerprint,
  type ConnectorEvent,
  type ProfilePolicyV1,
  type RosterDraftV1,
} from "../lib/rosterpilot";
import type {
  CertificationCaseResult,
  CertificationReport,
} from "../lib/rosterpilot/certification";
import {
  loadLiveCertificationProfilePolicy,
  preflightLiveCertificationProfilePolicy,
  preflightPinnedLiveCertificationProfilePolicy,
  resolveLiveProfilePolicyArgument,
} from "../local/certification/live-profile-policy";
import {
  certificationResumePolicyIsCompatible,
  loadVerifiedCertificationResumeArtifact,
  mergeResumedLiveConnectorHistory,
  migrateLegacyTesseraSavedListConnectorEvents,
} from "../local/certification/live-resume";
import {
  aggregateProfileRequirements,
  profilePolicyHash,
} from "../local/tessera/profile-policy";

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fixtureRoster(): RosterDraftV1 {
  const built = buildRoster({
    playerFaction: "death-guard",
    pointsLimit: 1_000,
    name: "Live policy fixture",
    preferences: ["objective", "durability"],
    allowNamedCharacters: true,
    allowLegends: false,
  });
  assert.equal(
    built.ok,
    true,
    built.violations.map((issue) => issue.message).join("\n"),
  );
  assert.ok(built.data);
  return built.data;
}

function enrichedArchive(roster: RosterDraftV1): Uint8Array {
  const requirements = aggregateProfileRequirements([roster]);
  assert.ok(
    requirements.length > 0,
    "the live-policy fixture must exercise alternate profiles",
  );
  const bySelection = new Map<
    string,
    typeof requirements
  >();
  for (const requirement of requirements) {
    if (!requirement.selectionId) continue;
    const entries = bySelection.get(requirement.selectionId) ?? [];
    entries.push(requirement);
    bySelection.set(requirement.selectionId, entries);
  }
  const selections = roster.units.map((unit) => {
    const requiredProfiles = `
        <profiles>
          <profile name="${xmlEscape(unit.name)}" typeName="Unit"/>
          <profile name="Fixture weapon" typeName="Melee Weapons"/>
        </profiles>`;
    const profiles = (bySelection.get(unit.selectionId) ?? [])
      .map(
        (requirement, index) => `
          <selection id="${xmlEscape(unit.selectionId)}-weapon-${index}" name="${xmlEscape(requirement.weaponGroup)}" number="${requirement.activeCount}" type="upgrade">
            <profiles>
              ${requirement.availableProfiles
                .map(
                  (profile) =>
                    `<profile name="➤ ${xmlEscape(requirement.weaponGroup)} - ${xmlEscape(profile)}" typeName="${requirement.phase === "shooting" ? "Ranged Weapons" : "Melee Weapons"}"/>`,
                )
                .join("")}
            </profiles>
          </selection>`,
      )
      .join("");
    return `
      <selection id="${xmlEscape(unit.selectionId)}" name="${xmlEscape(unit.name)}" number="1" type="unit">
        <cost name="pts" value="${unit.points}"/>
        ${requiredProfiles}
        <selections>
          <selection id="${xmlEscape(unit.selectionId)}-models" name="${xmlEscape(unit.name)}" number="${unit.modelCount}" type="model"/>
          ${profiles}
        </selections>
      </selection>`;
  });
  const xml = `<?xml version="1.0"?>
    <roster name="${xmlEscape(roster.name)}" generatedBy="https://newrecruit.eu">
      <cost name="pts" value="${roster.totalPoints}"/>
      <forces>
        <force name="${xmlEscape(roster.factionName)}" catalogueName="${xmlEscape(roster.factionName)}">
          <selections>${selections.join("")}</selections>
        </force>
      </forces>
    </roster>`;
  return zipSync({ "live-policy.ros": strToU8(xml) });
}

function completedCase(
  input: Partial<CertificationCaseResult> &
    Pick<
      CertificationCaseResult,
      "caseId" | "factionId" | "workflow" | "stage" | "status"
    >,
): CertificationCaseResult {
  return {
    code: null,
    message: "fixture",
    retryable: false,
    startedAt: "2026-07-29T00:00:00.000Z",
    completedAt: "2026-07-29T00:00:01.000Z",
    durationMs: 1_000,
    evidence: {},
    artifacts: [],
    connectorEvents: [],
    ...input,
  };
}

function report(
  runId: string,
  cases: CertificationCaseResult[],
  policyHash: string | null = null,
): CertificationReport {
  return {
    schemaVersion: 1,
    reportKind: "rosterpilot-certification",
    runId,
    tier: "live",
    generatedAt: "2026-07-29T00:00:00.000Z",
    ok: false,
    status: "fail",
    manifestSha256: "a".repeat(64),
    resumedFrom: null,
    selection: {
      requestedFaction: "death-guard",
      shard: null,
      changedOnly: false,
      selectedFactionIds: ["death-guard"],
    },
    provenance: {
      runtime: null,
      localAgent: {
        version: null,
        protocolVersion: null,
        runtime: null,
        buildId: null,
        stale: null,
      },
      newRecruitUi: { identity: null },
      tesseraUi: { identity: null },
      profilePolicy: {
        source: policyHash ? "cli" : "none",
        requestedBasename: policyHash ? "profiles.json" : null,
        artifactPath: policyHash ? "artifacts/profiles.json" : null,
        sourceSha256: policyHash,
        canonicalSha256: policyHash,
      },
      dataPin: {
        releaseId: "fixture",
        rulesPackageVersion: "fixture",
        newRecruitCommit: "a".repeat(40),
      },
      cachedLiveUpdateCheck: null,
    },
    baselines: {
      buildableFactions: 1,
      exportCapableFactions: 1,
      blockingConflicts: 0,
      actualBuildableFactions: 1,
      actualExportCapableFactions: 1,
      actualBlockingConflicts: 0,
      actualUniqueBlockingConflicts: 0,
    },
    coverage: {
      factions: {
        intended: 1,
        exercised: 1,
        passed: 0,
        failed: 1,
        unsupported: 0,
        pendingExpertReview: 0,
      },
      workflows: {} as CertificationReport["coverage"]["workflows"],
      browserFixtures: { intended: 0, exercised: 0 },
      dimensions: {
        detachments: {
          intended: [],
          exercised: [],
          missing: [],
        },
        unitCategories: {
          exercised: [],
          caseCountByCategory: {},
        },
        specialistCases: {
          intended: [],
          exercised: [],
          missing: [],
          evidenceCaseIds: {},
        },
        failureModes: [],
      },
    },
    cases,
    connectorEvents: cases.flatMap(
      (result) => result.connectorEvents,
    ),
    artifacts: [],
    limitations: [],
  };
}

test("live certification CLI profile-policy argument is live-only and requires a path", () => {
  assert.equal(
    resolveLiveProfilePolicyArgument(
      "live",
      "fixtures/profiles.json",
    ),
    path.resolve("fixtures/profiles.json"),
  );
  assert.equal(
    resolveLiveProfilePolicyArgument("live", undefined),
    null,
  );
  assert.throws(
    () =>
      resolveLiveProfilePolicyArgument(
        "deterministic",
        "profiles.json",
      ),
    (error: Error & { code?: string }) =>
      error.code ===
      "CERTIFICATION_PROFILE_POLICY_TIER_INVALID",
  );
  assert.throws(
    () => resolveLiveProfilePolicyArgument("live", true),
    (error: Error & { code?: string }) =>
      error.code ===
      "CERTIFICATION_PROFILE_POLICY_PATH_REQUIRED",
  );
});

test("live profile policy is canonically loaded, scoped, and fails closed when omitted", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-policy-"),
  );
  try {
    const roster = fixtureRoster();
    const archive = enrichedArchive(roster);
    const requirements = aggregateProfileRequirements([roster]);
    const policy: ProfilePolicyV1 = {
      schemaVersion: 1,
      policyKind: "tessera-profile-policy",
      entries: requirements.map((requirement) => ({
        faction: requirement.faction,
        unit: requirement.unit,
        ...(requirement.unitOccurrence === undefined
          ? {}
          : { unitOccurrence: requirement.unitOccurrence }),
        ...(requirement.modelCount === undefined
          ? {}
          : { modelCount: requirement.modelCount }),
        weaponGroup: requirement.weaponGroup,
        phase: requirement.phase,
        selectedProfile: requirement.availableProfiles[0],
        activeCount: requirement.activeCount,
      })),
    };
    const policyPath = path.join(directory, "profiles.json");
    await writeFile(
      policyPath,
      `${JSON.stringify(policy, null, 2)}\n`,
    );
    const source =
      await loadLiveCertificationProfilePolicy(policyPath);
    assert.equal(source.canonicalSha256, profilePolicyHash(policy));
    assert.match(source.sourceSha256, /^[0-9a-f]{64}$/);

    const pinnedMissing =
      preflightPinnedLiveCertificationProfilePolicy({
        roster,
        source: null,
      });
    assert.equal(pinnedMissing.valid, false);
    assert.equal(
      pinnedMissing.code,
      "TESSERA_PROFILE_POLICY_REQUIRED",
    );
    assert.equal(
      pinnedMissing.unresolved.length,
      requirements.length,
    );
    assert.ok(pinnedMissing.scaffold);

    const pinnedValid =
      preflightPinnedLiveCertificationProfilePolicy({
        roster,
        source,
      });
    assert.equal(
      pinnedValid.valid,
      true,
      pinnedValid.errors.join("\n"),
    );
    assert.equal(pinnedValid.code, null);
    assert.equal(
      pinnedValid.policyHash,
      profilePolicyHash(policy),
    );

    const missing = preflightLiveCertificationProfilePolicy({
      enrichedRosz: archive,
      roster,
      source: null,
    });
    assert.equal(missing.valid, false);
    assert.equal(
      missing.code,
      "TESSERA_PROFILE_POLICY_REQUIRED",
    );
    assert.equal(missing.inventory.blocking.length, 0);
    assert.equal(
      missing.unresolved.length,
      requirements.length,
    );
    assert.ok(missing.scaffold);

    const valid = preflightLiveCertificationProfilePolicy({
      enrichedRosz: archive,
      roster,
      source,
    });
    assert.equal(valid.valid, true, valid.errors.join("\n"));
    assert.equal(valid.code, null);
    assert.equal(valid.policy?.entries.length, requirements.length);
    assert.equal(valid.policyHash, profilePolicyHash(policy));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live profile preflight reports pinned/enriched inventory mismatch before policy validation", () => {
  const roster = fixtureRoster();
  const archive = enrichedArchive(roster);
  const requirements = aggregateProfileRequirements([roster]);
  assert.ok(requirements.length > 1);
  const full = zipSync({
    "fixture.ros": strToU8(
      "<?xml version=\"1.0\"?><roster name=\"fixture\" generatedBy=\"https://newrecruit.eu\"><cost name=\"pts\" value=\"1\"/><forces><force name=\"Death Guard\"><selections/></force></forces></roster>",
    ),
  });
  const mismatch = preflightLiveCertificationProfilePolicy({
    enrichedRosz: full,
    roster,
    source: null,
  });
  assert.equal(mismatch.valid, false);
  assert.equal(
    mismatch.code,
    "TESSERA_ENRICHED_PROFILE_INVENTORY_MISMATCH",
  );
  assert.equal(
    mismatch.inventory.blocking.length,
    requirements.length,
  );
  assert.equal(mismatch.scaffold, null);
  assert.ok(archive.length > 0);
});

test("live resume verifies the prior artifact and roster fingerprint before connector reuse", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-resume-"),
  );
  try {
    const roster = fixtureRoster();
    const content = enrichedArchive(roster);
    const artifactPath = path.join("artifacts", "enriched.rosz");
    await mkdir(path.dirname(path.join(directory, artifactPath)), {
      recursive: true,
    });
    await writeFile(path.join(directory, artifactPath), content);
    const hash = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");
    const event: ConnectorEvent = {
      schemaVersion: 1,
      eventId: "original-mutation",
      recordedAt: "2026-07-29T00:00:00.000Z",
      provider: "new-recruit",
      action: "prepare",
      origin: "new-remote",
      outcome: "verified",
      remoteId: null,
      contentSha256: hash,
    };
    const previous = report("same-run", [
      completedCase({
        caseId: `death-guard:build:${roster.pointsLimit}`,
        factionId: "death-guard",
        workflow: "roster-correctness",
        stage: "build-and-validate",
        status: "pass",
        evidence: {
          executionFingerprint:
            rosterExecutionFingerprint(roster),
        },
      }),
      completedCase({
        caseId: "death-guard:live-new-recruit",
        factionId: "death-guard",
        workflow: "new-recruit-delivery",
        stage: "verified-enrichment",
        status: "pass",
        artifacts: [
          {
            kind: "enriched-rosz",
            path: artifactPath,
            sha256: hash,
          },
        ],
        connectorEvents: [event],
      }),
    ]);
    const reused = await loadVerifiedCertificationResumeArtifact({
      previous,
      resumeBundleDirectory: directory,
      factionId: "death-guard",
      roster,
    });
    assert.equal(reused?.sha256, hash);
    assert.equal(reused?.summary.rosterName, roster.name);

    const fingerprintMismatch = structuredClone(previous);
    fingerprintMismatch.cases[0].evidence.executionFingerprint =
      "different";
    await assert.rejects(
      loadVerifiedCertificationResumeArtifact({
        previous: fingerprintMismatch,
        resumeBundleDirectory: directory,
        factionId: "death-guard",
        roster,
      }),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_ROSTER_FINGERPRINT_MISMATCH",
    );

    await writeFile(
      path.join(directory, artifactPath),
      Buffer.from("corrupt"),
    );
    await assert.rejects(
      loadVerifiedCertificationResumeArtifact({
        previous,
        resumeBundleDirectory: directory,
        factionId: "death-guard",
        roster,
      }),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_ARTIFACT_HASH_MISMATCH",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cached presentation aliases resume with zero remote mutations while exact unit drift fails", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rosterpilot-live-resume-alias-"),
  );
  try {
    const requestedRoster = fixtureRoster();
    requestedRoster.name =
      "RP Certification Death Guard current-run";
    const observedRoster = structuredClone(requestedRoster);
    observedRoster.name =
      "RP Certification Death Guard earlier-run";
    assert.equal(
      rosterExecutionFingerprint(observedRoster),
      rosterExecutionFingerprint(requestedRoster),
      "presentation names must not alter gameplay identity",
    );

    const content = enrichedArchive(observedRoster);
    const artifactPath = path.join(
      "artifacts",
      "cached-enriched.rosz",
    );
    await mkdir(path.dirname(path.join(directory, artifactPath)), {
      recursive: true,
    });
    await writeFile(path.join(directory, artifactPath), content);
    const hash = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");
    const cacheReuse: ConnectorEvent = {
      schemaVersion: 1,
      eventId: "fresh-cache-reuse",
      recordedAt: "2026-07-30T00:00:00.000Z",
      provider: "new-recruit",
      action: "prepare",
      origin: "persistent-cache",
      outcome: "reused",
      remoteId: null,
      contentSha256: hash,
    };
    const previous = report("same-run", [
      completedCase({
        caseId: `death-guard:build:${requestedRoster.pointsLimit}`,
        factionId: "death-guard",
        workflow: "roster-correctness",
        stage: "build-and-validate",
        status: "pass",
        evidence: {
          executionFingerprint:
            rosterExecutionFingerprint(requestedRoster),
        },
      }),
      completedCase({
        caseId: "death-guard:live-new-recruit",
        factionId: "death-guard",
        workflow: "new-recruit-delivery",
        stage: "verified-enrichment",
        status: "pass",
        artifacts: [
          {
            kind: "enriched-rosz",
            path: artifactPath,
            sha256: hash,
          },
        ],
        connectorEvents: [cacheReuse],
      }),
    ]);

    const reused = await loadVerifiedCertificationResumeArtifact({
      previous,
      resumeBundleDirectory: directory,
      factionId: "death-guard",
      roster: requestedRoster,
    });
    assert.equal(
      reused?.rosterIdentity.requestedRosterName,
      requestedRoster.name,
    );
    assert.equal(
      reused?.rosterIdentity.observedRosterName,
      observedRoster.name,
    );
    assert.equal(
      reused?.rosterIdentity.presentationAliasAccepted,
      true,
    );

    const manifestReuse: ConnectorEvent = {
      schemaVersion: 1,
      eventId: "manifest-reuse",
      recordedAt: "2026-07-30T00:01:00.000Z",
      provider: "new-recruit",
      action: "prepare",
      origin: "manifest-reuse",
      outcome: "reused",
      remoteId: null,
      contentSha256: hash,
    };
    const resumed = report("same-run", [
      completedCase({
        caseId: "death-guard:live-new-recruit",
        factionId: "death-guard",
        workflow: "new-recruit-delivery",
        stage: "verified-enrichment",
        status: "pass",
        evidence: {
          rosterIdentity: reused?.rosterIdentity,
        },
        connectorEvents: [manifestReuse],
      }),
    ]);
    mergeResumedLiveConnectorHistory(resumed, previous);
    assert.equal(
      (
        resumed.cases[0].evidence.resume as {
          currentAttemptRemoteMutations: number;
        }
      ).currentAttemptRemoteMutations,
      0,
    );
    assert.deepEqual(
      resumed.cases[0].connectorEvents.map(
        (event) => event.origin,
      ),
      ["persistent-cache", "manifest-reuse"],
    );

    const driftedRoster = structuredClone(observedRoster);
    driftedRoster.units.push(
      structuredClone(driftedRoster.units[0]),
    );
    const driftedContent = enrichedArchive(driftedRoster);
    const driftedHash = crypto
      .createHash("sha256")
      .update(driftedContent)
      .digest("hex");
    await writeFile(
      path.join(directory, artifactPath),
      driftedContent,
    );
    previous.cases[1].artifacts[0].sha256 = driftedHash;
    await assert.rejects(
      loadVerifiedCertificationResumeArtifact({
        previous,
        resumeBundleDirectory: directory,
        factionId: "death-guard",
        roster: requestedRoster,
      }),
      (error: Error & { code?: string }) =>
        error.code ===
        "CERTIFICATION_RESUME_ARTIFACT_VERIFICATION_FAILED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resumed connector history retains the original mutation and records zero new mutations", () => {
  const original: ConnectorEvent = {
    schemaVersion: 1,
    eventId: "new-remote",
    recordedAt: "2026-07-29T00:00:00.000Z",
    provider: "new-recruit",
    action: "prepare",
    origin: "new-remote",
    outcome: "verified",
    remoteId: null,
    contentSha256: "a".repeat(64),
  };
  const reuse: ConnectorEvent = {
    schemaVersion: 1,
    eventId: "manifest-reuse",
    recordedAt: "2026-07-29T00:05:00.000Z",
    provider: "new-recruit",
    action: "prepare",
    origin: "manifest-reuse",
    outcome: "reused",
    remoteId: null,
    contentSha256: "a".repeat(64),
  };
  const previous = report("same-run", [
    completedCase({
      caseId: "death-guard:live-new-recruit",
      factionId: "death-guard",
      workflow: "new-recruit-delivery",
      stage: "verified-enrichment",
      status: "pass",
      connectorEvents: [original],
    }),
  ]);
  const current = report("same-run", [
    completedCase({
      caseId: "death-guard:live-new-recruit",
      factionId: "death-guard",
      workflow: "new-recruit-delivery",
      stage: "verified-enrichment",
      status: "pass",
      connectorEvents: [reuse],
    }),
  ]);
  mergeResumedLiveConnectorHistory(current, previous);
  assert.deepEqual(
    current.cases[0].connectorEvents.map((event) => event.origin),
    ["new-remote", "manifest-reuse"],
  );
  assert.deepEqual(current.cases[0].evidence.resume, {
    runId: "same-run",
    priorEventsRetained: 1,
    currentAttemptRemoteMutations: 0,
    currentAttemptCacheReuses: 1,
    currentAttemptRemoteMutationsByProvider: {
      newRecruit: 0,
      tessera: 0,
    },
    currentAttemptCacheReusesByProvider: {
      newRecruit: 1,
      tessera: 0,
    },
    durableRemoteMutations: 1,
    durableCacheReuses: 1,
    durableEventCount: 2,
    priorAttempts: [
      {
        code: null,
        stage: "verified-enrichment",
        status: "pass",
        startedAt: "2026-07-29T00:00:00.000Z",
        completedAt: "2026-07-29T00:00:01.000Z",
      },
    ],
  });
});

test("legacy successful Tessera reports backfill deterministic imports once and resume without a mutation", () => {
  const simulation: ConnectorEvent = {
    schemaVersion: 1,
    eventId: "legacy-simulation",
    recordedAt: "2026-07-30T00:00:01.000Z",
    provider: "tessera",
    action: "simulate",
    origin: "new-remote",
    outcome: "verified",
    remoteId: null,
    contentSha256: "d".repeat(64),
  };
  const previous = report("same-run", [
    completedCase({
      caseId: "death-guard:live-new-recruit",
      factionId: "death-guard",
      workflow: "new-recruit-delivery",
      stage: "verified-enrichment",
      status: "pass",
      artifacts: [
        {
          kind: "enriched-rosz",
          path: "artifacts/enriched.rosz",
          sha256: "a".repeat(64),
        },
      ],
    }),
    completedCase({
      caseId: "death-guard:live-tessera",
      factionId: "death-guard",
      workflow: "tessera-simulation",
      stage: "trusted-full-matrix",
      status: "pass",
      evidence: {
        savedListReuse: {
          mode: "deterministic",
          player: {
            name: "RP-CERT-A-legacy",
            expectedUnitCount: 5,
            action: "imported",
          },
          opponent: {
            name: "RP-CERT-B-legacy",
            expectedUnitCount: 5,
            action: "imported",
          },
        },
      },
      connectorEvents: [simulation],
    }),
  ]);
  assert.equal(
    migrateLegacyTesseraSavedListConnectorEvents(previous),
    2,
  );
  assert.equal(
    migrateLegacyTesseraSavedListConnectorEvents(previous),
    0,
    "a repeated migration must not duplicate synthesized events",
  );
  const priorTessera = previous.cases.find(
    (candidate) =>
      candidate.caseId === "death-guard:live-tessera",
  )!;
  const savedListEvents = priorTessera.connectorEvents.filter(
    (event) => event.action === "prepare",
  );
  assert.equal(savedListEvents.length, 2);
  assert.equal(
    new Set(savedListEvents.map((event) => event.eventId)).size,
    2,
  );
  assert.ok(
    savedListEvents.every(
      (event) =>
        event.origin === "new-remote" &&
        event.outcome === "verified",
    ),
  );
  assert.equal(savedListEvents[0].contentSha256, "a".repeat(64));
  assert.equal(savedListEvents[1].contentSha256, null);

  const current = report("same-run", [...previous.cases]);
  mergeResumedLiveConnectorHistory(current, previous, {
    carriedCaseIds: new Set([
      "death-guard:live-new-recruit",
      "death-guard:live-tessera",
    ]),
  });
  const currentTessera = current.cases.find(
    (candidate) =>
      candidate.caseId === "death-guard:live-tessera",
  )!;
  assert.equal(
    (
      currentTessera.evidence.resume as {
        currentAttemptRemoteMutations: number;
      }
    ).currentAttemptRemoteMutations,
    0,
  );
  assert.equal(
    (
      currentTessera.evidence.resume as {
        durableRemoteMutations: number;
      }
    ).durableRemoteMutations,
    2,
  );
  assert.equal(currentTessera.connectorEvents.length, 3);
});

test("successful resume retains the prior profile-policy failure as inactive attempt evidence", () => {
  const previous = report("same-run", [
    completedCase({
      caseId: "death-guard:live-tessera",
      factionId: "death-guard",
      workflow: "tessera-simulation",
      stage: "profile-policy-preflight",
      status: "fail",
      code: "TESSERA_PROFILE_POLICY_REQUIRED",
    }),
  ]);
  const current = report("same-run", [
    completedCase({
      caseId: "death-guard:live-tessera",
      factionId: "death-guard",
      workflow: "tessera-simulation",
      stage: "trusted-full-matrix",
      status: "pass",
    }),
  ]);
  mergeResumedLiveConnectorHistory(current, previous);
  assert.equal(current.cases.length, 1);
  assert.equal(current.cases[0].status, "pass");
  assert.deepEqual(
    (
      current.cases[0].evidence.resume as {
        priorAttempts: unknown[];
      }
    ).priorAttempts,
    [
      {
        code: "TESSERA_PROFILE_POLICY_REQUIRED",
        stage: "profile-policy-preflight",
        status: "fail",
        startedAt: "2026-07-29T00:00:00.000Z",
        completedAt: "2026-07-29T00:00:01.000Z",
      },
    ],
  );
});

test("repeated resume retains the complete prior attempt chain", () => {
  const originalAttempt = {
    code: "TESSERA_PROFILE_POLICY_REQUIRED",
    stage: "profile-policy-preflight",
    status: "fail" as const,
    startedAt: "2026-07-29T00:00:00.000Z",
    completedAt: "2026-07-29T00:00:01.000Z",
  };
  const previous = report("same-run", [
    completedCase({
      caseId: "death-guard:live-tessera",
      factionId: "death-guard",
      workflow: "tessera-simulation",
      stage: "trusted-full-matrix",
      status: "fail",
      code: "CERTIFICATION_TESSERA_SCENARIOS_INCOMPLETE",
      startedAt: "2026-07-29T00:01:00.000Z",
      completedAt: "2026-07-29T00:02:00.000Z",
      evidence: {
        resume: {
          priorAttempts: [originalAttempt],
        },
      },
    }),
  ]);
  const current = report("same-run", [
    completedCase({
      caseId: "death-guard:live-tessera",
      factionId: "death-guard",
      workflow: "tessera-simulation",
      stage: "trusted-full-matrix",
      status: "pass",
    }),
  ]);
  mergeResumedLiveConnectorHistory(current, previous);
  assert.deepEqual(
    (
      current.cases[0].evidence.resume as {
        priorAttempts: unknown[];
      }
    ).priorAttempts,
    [
      originalAttempt,
      {
        code: "CERTIFICATION_TESSERA_SCENARIOS_INCOMPLETE",
        stage: "trusted-full-matrix",
        status: "fail",
        startedAt: "2026-07-29T00:01:00.000Z",
        completedAt: "2026-07-29T00:02:00.000Z",
      },
    ],
  );
});

test("passed live evidence is reusable only when the newly scoped policy hash matches the prior applied hash", () => {
  const policy: ProfilePolicyV1 = {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: [
      {
        faction: "death-guard",
        unit: "Defiler",
        unitOccurrence: 1,
        modelCount: 1,
        weaponGroup: "Heavy missile launcher",
        phase: "shooting",
        selectedProfile: "krak",
        activeCount: 1,
      },
    ],
  };
  const policyHash = profilePolicyHash(policy);
  const previous = report(
    "same-run",
    [
      completedCase({
        caseId: "death-guard:live-tessera",
        factionId: "death-guard",
        workflow: "tessera-simulation",
        stage: "trusted-full-matrix",
        status: "pass",
        evidence: {
          profilePolicy: {
            sourceCanonicalSha256: policyHash,
            appliedCanonicalSha256: policyHash,
            requirements: [
              {
                faction: "death-guard",
                unit: "Defiler",
                unitOccurrence: 1,
                modelCount: 1,
                weaponGroup: "Heavy missile launcher",
                phase: "shooting",
                availableProfiles: ["frag", "krak"],
                activeCount: 1,
              },
            ],
          },
        },
      }),
    ],
    policyHash,
  );
  assert.equal(
    certificationResumePolicyIsCompatible(previous, policy),
    true,
  );
  const changed = structuredClone(policy);
  changed.entries[0].selectedProfile = "frag";
  assert.equal(
    certificationResumePolicyIsCompatible(
      previous,
      changed,
    ),
    false,
  );
  assert.equal(
    certificationResumePolicyIsCompatible(previous, null),
    false,
  );
});
