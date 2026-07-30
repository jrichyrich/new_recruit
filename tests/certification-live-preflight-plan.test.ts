import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type {
  NewRecruitConnectionStatus,
  ResultEnvelope,
  RuntimeProvenance,
  TesseraConnectionStatus,
} from "../lib/rosterpilot";
import {
  CertificationManifestSchema,
} from "../lib/rosterpilot/certification";
import {
  runLiveCertificationPreflightGate,
  type LiveCertificationPreflightDependencies,
} from "../local/certification/live-preflight-plan";

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

const runtime: RuntimeProvenance = {
  rosterPilotVersion: "test",
  rulesPackageVersion: "test",
  stressGeneratorVersion: "test",
  processStartedAt: "2026-07-30T00:00:00.000Z",
  gitHead: "a".repeat(40),
  sourceFingerprintAtStart: "b".repeat(64),
  sourceFingerprintNow: "b".repeat(64),
  buildId: "test-build",
  stale: false,
};

function newRecruitStatus(
  available = true,
): ResultEnvelope<NewRecruitConnectionStatus> {
  return {
    ok: true,
    data: {
      available,
      platform: "darwin",
      browserAvailable: true,
      brokerAvailable: true,
      credentialsConfigured: true,
      profileDirectory: "/tmp/fixture",
      agentAvailable: true,
      agentVersion: "test",
      protocolCompatible: true,
      installationCurrent: true,
      runtimeCompatible: true,
      runtimeBuildId: runtime.buildId,
      agentRuntimeBuildId: runtime.buildId,
      credentialState: "ready",
      browserState: "ready",
    },
    violations: [],
    warnings: available
      ? []
      : [
          {
            code: "NEW_RECRUIT_COMPANION_UNAVAILABLE",
            message: "New Recruit fixture unavailable.",
            severity: "warn",
          },
        ],
  };
}

function tesseraStatus(
  available = true,
): ResultEnvelope<TesseraConnectionStatus> {
  return {
    ok: true,
    data: {
      available,
      platform: "darwin",
      browserAvailable: true,
      brokerAvailable: true,
      credentialsConfigured: true,
      agentAvailable: true,
      agentVersion: "test",
      protocolCompatible: true,
      installationCurrent: true,
      runtimeCompatible: true,
      runtimeBuildId: runtime.buildId,
      agentRuntimeBuildId: runtime.buildId,
      credentialState: "ready",
      experimental: true,
      url: "https://playtessera.gg/",
    },
    violations: [],
    warnings: available
      ? []
      : [
          {
            code: "TESSERA_COMPANION_UNAVAILABLE",
            message: "Tessera fixture unavailable.",
            severity: "warn",
          },
        ],
  };
}

async function fixtureManifest() {
  const manifest = CertificationManifestSchema.parse(
    JSON.parse(
      await readFile(
        path.join(
          projectRoot,
          "data",
          "certification-manifest.json",
        ),
        "utf8",
      ),
    ),
  );
  return {
    ...manifest,
    factions: manifest.factions.filter((faction) =>
      ["death-guard", "orks"].includes(faction.id),
    ),
  };
}

function dependencies(
  input: {
    invalidPolicyFactionId?: string;
    tesseraAvailable?: boolean;
    outputPreparations: string[];
  },
): Partial<LiveCertificationPreflightDependencies> {
  return {
    runtime: () => runtime,
    newRecruitStatus: async () => newRecruitStatus(),
    tesseraStatus: async () =>
      tesseraStatus(input.tesseraAvailable ?? true),
    profilePolicyPreflight: ({ roster }) => ({
      valid:
        roster.factionId !== input.invalidPolicyFactionId,
      code:
        roster.factionId === input.invalidPolicyFactionId
          ? "TESSERA_PROFILE_POLICY_INVALID"
          : null,
      policy: null,
      policyHash: null,
      requirements: [],
      unresolved: [],
      errors:
        roster.factionId === input.invalidPolicyFactionId
          ? ["fixture invalid policy"]
          : [],
      scaffold: null,
    }),
    prepareOutputDirectory: async (directory) => {
      input.outputPreparations.push(directory);
    },
  };
}

test(
  "a later faction policy failure prevents every live delivery",
  { timeout: 120_000 },
  async () => {
    const manifest = await fixtureManifest();
    let deliveries = 0;
    const outputPreparations: string[] = [];
    const result = await runLiveCertificationPreflightGate(
      {
        manifest,
        selectedFactionIds: ["death-guard", "orks"],
        runId: "valid-first-invalid-second",
        outputDirectory: "/tmp/rosterpilot-live-plan-fixture",
        profilePolicySource: null,
        dependencies: dependencies({
          invalidPolicyFactionId: "orks",
          outputPreparations,
        }),
      },
      async (plan) => {
        deliveries += plan.entries.length;
        return deliveries;
      },
    );

    assert.equal(result.preflight.ok, false);
    assert.equal(result.execution, null);
    assert.equal(deliveries, 0);
    assert.deepEqual(outputPreparations, []);
    assert.equal(
      result.preflight.failures.some(
        (failure) =>
          failure.factionId === "orks" &&
          failure.stage === "profile-policy" &&
          failure.code === "TESSERA_PROFILE_POLICY_INVALID",
      ),
      true,
    );
  },
);

test(
  "unavailable Tessera prevents New Recruit delivery before output preparation",
  { timeout: 120_000 },
  async () => {
    const manifest = await fixtureManifest();
    let deliveries = 0;
    const outputPreparations: string[] = [];
    const result = await runLiveCertificationPreflightGate(
      {
        manifest,
        selectedFactionIds: ["death-guard"],
        runId: "tessera-unavailable",
        outputDirectory: "/tmp/rosterpilot-live-plan-fixture",
        profilePolicySource: null,
        dependencies: dependencies({
          tesseraAvailable: false,
          outputPreparations,
        }),
      },
      async (plan) => {
        deliveries += plan.entries.length;
        return deliveries;
      },
    );

    assert.equal(result.preflight.ok, false);
    assert.equal(result.execution, null);
    assert.equal(deliveries, 0);
    assert.deepEqual(outputPreparations, []);
    assert.equal(
      result.preflight.failures.some(
        (failure) =>
          failure.stage === "tessera-readiness" &&
          failure.code === "TESSERA_COMPANION_UNAVAILABLE",
      ),
      true,
    );
  },
);
