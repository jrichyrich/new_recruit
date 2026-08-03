import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoster,
  type DataUpdateStatus,
  type TesseraPreparedRoster,
  type TesseraSimulationProviderIdentity,
  type TesseraWebsiteProviderEvidence,
  type VerifiedDataBundleManifestV1,
} from "../lib/rosterpilot";
import {
  buildProviderCompatibilityBundleTrustIdentity,
  buildProviderCompatibilityEnvelope,
  compareProviderCompatibilityEnvelopes,
  effectiveProviderCompatibilityMode,
} from "../local/tessera/provider-compatibility";
import {
  aggregateWebsiteProviderEvidence,
} from "../local/tessera/companion";
import {
  tesseraImportSemanticEvidenceFromSnapshots,
} from "../local/tessera/browser";
import {
  createTesseraImportedArmySimulationStateBinding,
} from "../local/tessera/website-semantic-evidence";

const SHA = "a".repeat(64);
const CONTRACT_SHA = "b".repeat(64);
const POLICY_SHA = "c".repeat(64);

test("the durable runtime latch overrides an observational request", () => {
  assert.equal(
    effectiveProviderCompatibilityMode("observe", {
      ROSTERPILOT_PROVIDER_COMPATIBILITY_ENFORCED: "true",
    }),
    "enforce",
  );
  assert.equal(effectiveProviderCompatibilityMode(undefined, {}), "observe");
});

function sourceRoster() {
  const built = buildRoster({
    faction: "adeptus-custodes",
    pointsLimit: 1_000,
  });
  assert.ok(built.ok && built.data);
  return built.data;
}

function trustedBundle(sourceData: ReturnType<typeof sourceRoster>["sourceData"]) {
  const manifest = {
    bundleId: sourceData.bundleId,
    signature: { keyId: "fixture-signing-key" },
    semanticHashes: {
      rosterRulesHash: sourceData.rosterRulesHash,
      factionRulesHash: sourceData.factionRulesHash,
      mappingHash: sourceData.mappingHash,
    },
  } as unknown as VerifiedDataBundleManifestV1;
  const status: DataUpdateStatus = {
    providerConfigured: true,
    providerMode: "signed-channel",
    state: "ready",
    activeBundleId: sourceData.bundleId,
    latestVerifiedBundleId: sourceData.bundleId,
    latestUpstreamBundleId: sourceData.bundleId,
    candidate: null,
    quarantinedScopes: [],
    lastSuccessfulCheckAt: "2026-08-02T00:00:00.000Z",
    officialAuthority: {
      status: "verified",
      sourceArtifactSha256: "1".repeat(64),
      overlaySha256: "2".repeat(64),
      receiptSha256: "3".repeat(64),
      extractorId: "fixture-extractor",
      extractorKeyId: "fixture-extractor-key",
    },
    rollbackHold: null,
    dataTrust: "signed-verified",
    durability: {
      mode: "persistent",
      state: "ready",
      reason: null,
    },
  };
  return buildProviderCompatibilityBundleTrustIdentity({
    manifest,
    status,
  });
}

function prepared(
  provider: "local-engine" | "website",
): TesseraPreparedRoster {
  return {
    rosterId: "fixture-roster",
    rosterName: "Fixture roster",
    factionId: "adeptus-custodes",
    listUrl: null,
    sourceRoszPath: "/fixture/source.rosz",
    enrichedRoszPath: "/fixture/enriched.rosz",
    enrichedRoszSha256: SHA,
    simulationInput:
      provider === "website"
        ? {
            kind: "new-recruit-enriched-rosz",
            sha256: SHA,
          }
        : {
            kind: "rosterpilot-local-engine-input",
            path: "/fixture/local.json",
            sha256: SHA,
            bundleId: SHA,
            compilerVersion: "fixture-v1",
          },
    summary: {
      rosterName: "Fixture roster",
      factionName: "Adeptus Custodes",
      totalPoints: 1_000,
      generatedBy: "fixture",
      profileCount: 0,
      weaponProfileCount: 0,
      units: [],
    },
    fingerprint: "fixture-roster-fingerprint",
    catalogueProvenance:
      provider === "website"
        ? {
            status: "matched",
            pinned: {
              releaseId: "fixture-release",
              gameSystem: {
                id: "fixture-system",
                name: "Warhammer 40,000 11th Edition",
                revision: 8,
              },
              catalogue: {
                id: "fixture-custodes",
                name: "Adeptus Custodes",
                revision: 7,
              },
            },
            observed: {
              source: "new-recruit-enriched-rosz",
              gameSystem: {
                id: "fixture-system",
                name: "Warhammer 40,000 11th Edition",
                revision: 8,
              },
              catalogues: [
                {
                  id: "fixture-custodes",
                  name: "Adeptus Custodes",
                  revision: 7,
                },
              ],
            },
            mismatches: [],
            missing: [],
          }
        : undefined,
  } as unknown as TesseraPreparedRoster;
}

const localIdentity: TesseraSimulationProviderIdentity = {
  schemaVersion: 1,
  provider: "local-engine",
  engine: "tessera-engine",
  repository: "Tessera-cmd/tessera-engine",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  sourceSha256: "3".repeat(64),
  adapterVersion: "fixture-adapter-v1",
  compilerVersion: "fixture-compiler-v1",
  inputSchemaVersion: 1,
  capabilityManifestSha256: "4".repeat(64),
  promotion: "candidate",
  licenseState: "evaluation-only",
};

const websiteIdentity: TesseraSimulationProviderIdentity = {
  schemaVersion: 1,
  provider: "website",
  engine: "tessera-ui",
  uiIdentity: "5".repeat(64),
  adapterVersion: "website-browser-v1",
};

function semanticSnapshot(side: "player" | "opponent") {
  return {
    schemaVersion: 1 as const,
    side,
    armyName: `${side} army`,
    reportedUnitCount: 1,
    units: [
      {
        occurrence: 1,
        name: `${side} unit`,
        modelCount: 1,
        included: true,
        weapons: [{
          occurrence: 1,
          name: `${side} weapon`,
          profile: null,
          count: 1,
          visibleCharacteristics: [
            { name: "phase", value: "shooting" },
            { name: "attacks", value: "1" },
            { name: "ballistic skill", value: "3+" },
            { name: "strength", value: "4" },
            { name: "AP", value: "0" },
            { name: "damage", value: "1" },
            { name: "keywords", value: "none" },
            { name: "effects", value: "none" },
          ],
          effectToggles: [],
        }],
        visibleCharacteristics: [
          { name: "toughness", value: "4" },
          { name: "save", value: "3+" },
          { name: "wounds", value: "2" },
          { name: "invulnerable save", value: "none" },
          { name: "effects", value: "none" },
        ],
        effectToggles: [],
      },
    ],
    warningCodes: [],
    alternateProfileResolutions: [],
    completeness: "complete" as const,
    incompleteReasons: [],
  };
}

const playerSemanticSnapshot = semanticSnapshot("player");
const opponentSemanticSnapshot = semanticSnapshot("opponent");
const semanticBinding = (
  snapshot: ReturnType<typeof semanticSnapshot>,
) => createTesseraImportedArmySimulationStateBinding(snapshot, {
  side: snapshot.side,
  savedListName: `${snapshot.side}-fixture-list`,
  selectedUnitCount: 1,
  selectorValue: `list:${snapshot.side}-fixture-list`,
  selectorLabel: `${snapshot.side}-fixture-list · 1 units`,
});

const websiteEvidence: TesseraWebsiteProviderEvidence = {
  schemaVersion: 1,
  deployment: {
    identitySha256: "6".repeat(64),
    declaredVersion: null,
    assets: [
      {
        url: "https://playtessera.gg/assets/index-fixture.js",
        sameOrigin: true,
        sha256: "7".repeat(64),
      },
      {
        url: "https://analytics.example/telemetry.js",
        sameOrigin: false,
        sha256: null,
      },
    ],
    complete: true,
    completeness: "complete",
    declarationSha256: "e".repeat(64),
    incompleteReasons: [],
  },
  importSemantics: tesseraImportSemanticEvidenceFromSnapshots(
    playerSemanticSnapshot,
    opponentSemanticSnapshot,
    {
      player: semanticBinding(playerSemanticSnapshot),
      opponent: semanticBinding(opponentSemanticSnapshot),
    },
  ),
};

test("provider compatibility binds signed data, New Recruit observations, and Tessera semantics", () => {
  const roster = sourceRoster();
  const localPrepared = prepared("local-engine");
  const websitePrepared = prepared("website");
  const local = buildProviderCompatibilityEnvelope({
    sourceData: roster.sourceData,
    bundleTrust: trustedBundle(roster.sourceData),
    player: localPrepared,
    opponents: [],
    providerIdentity: localIdentity,
    profilePolicyHash: POLICY_SHA,
    scenarioContractSha256: CONTRACT_SHA,
  });
  const website = buildProviderCompatibilityEnvelope({
    sourceData: roster.sourceData,
    bundleTrust: trustedBundle(roster.sourceData),
    player: websitePrepared,
    opponents: [],
    providerIdentity: websiteIdentity,
    websiteEvidence,
    profilePolicyHash: POLICY_SHA,
    scenarioContractSha256: CONTRACT_SHA,
  });

  assert.equal(local.complete, true, JSON.stringify(local.issues));
  assert.equal(website.complete, true, JSON.stringify(website.issues));
  assert.equal(local.data.bsData.commit, roster.sourceData.newRecruit.commit);
  assert.equal(
    website.rosters[0].newRecruit.observed?.gameSystem.revision,
    8,
  );
  assert.equal(
    website.tessera.website?.importSemantics.combinedSha256,
    websiteEvidence.importSemantics.combinedSha256,
  );
  assert.deepEqual(
    compareProviderCompatibilityEnvelopes(local, website),
    { comparable: true, issues: [] },
  );
});

test("multi-opponent website evidence retains exact captures without claiming one aggregate snapshot is complete", () => {
  const aggregate = aggregateWebsiteProviderEvidence([
    { opponentName: "Aeldari alpha", evidence: websiteEvidence },
    {
      opponentName: "Aeldari beta",
      evidence: {
        ...websiteEvidence,
        importSemantics: {
          ...websiteEvidence.importSemantics,
          combinedSha256: "1".repeat(64),
          opponentSha256: "2".repeat(64),
          opponentSnapshot: {
            ...semanticSnapshot("opponent"),
            armyName: "Aeldari beta",
          },
        },
      },
    },
  ]);
  assert.ok(aggregate);
  assert.equal(aggregate.deployment.complete, true);
  assert.equal(aggregate.importSemantics.complete, false);
  assert.equal(aggregate.importSemantics.completeness, "partial");
  assert.equal(aggregate.importSemantics.opponentSnapshot, null);
  assert.ok(
    aggregate.importSemantics.incompleteReasons.includes(
      "multi-opponent-semantic-snapshots-retained-in-provider-evidence-captures",
    ),
  );
});

test("provider compatibility fails closed on catalogue drift and incomplete web semantics", () => {
  const roster = sourceRoster();
  const websitePrepared = prepared("website");
  assert.ok(websitePrepared.catalogueProvenance);
  websitePrepared.catalogueProvenance.status = "drift";
  websitePrepared.catalogueProvenance.mismatches = [
    {
      field: "catalogue-revision",
      expected: 7,
      observed: 8,
    },
  ];
  const envelope = buildProviderCompatibilityEnvelope({
    sourceData: roster.sourceData,
    bundleTrust: trustedBundle(roster.sourceData),
    player: websitePrepared,
    opponents: [],
    providerIdentity: websiteIdentity,
    websiteEvidence: {
      ...websiteEvidence,
      importSemantics: {
        ...websiteEvidence.importSemantics,
        complete: false,
        unresolvedEffectCount: 1,
      },
    },
    profilePolicyHash: POLICY_SHA,
    scenarioContractSha256: CONTRACT_SHA,
  });

  assert.equal(envelope.complete, false);
  assert.deepEqual(
    new Set(envelope.issues.map((issue) => issue.code)),
    new Set([
      "NEW_RECRUIT_CATALOGUE_DRIFT",
      "TESSERA_IMPORT_SEMANTICS_INCOMPLETE",
      "TESSERA_IMPORT_EFFECTS_UNRESOLVED",
    ]),
  );
});

test("provider compatibility rejects syntax-only roster hashes without verified bundle trust", () => {
  const roster = sourceRoster();
  const envelope = buildProviderCompatibilityEnvelope({
    sourceData: roster.sourceData,
    player: prepared("local-engine"),
    opponents: [],
    providerIdentity: localIdentity,
    profilePolicyHash: POLICY_SHA,
    scenarioContractSha256: CONTRACT_SHA,
  });
  assert.equal(envelope.complete, false);
  assert.ok(
    envelope.issues.some(
      (issue) => issue.code === "DATA_BUNDLE_TRUST_UNVERIFIED",
    ),
  );
  assert.ok(
    envelope.issues.some(
      (issue) =>
        issue.code === "DATA_BUNDLE_UPDATE_IDENTITY_INCOMPLETE",
    ),
  );
});

test("provider compatibility detects envelope tampering and shared-contract drift", () => {
  const roster = sourceRoster();
  const local = buildProviderCompatibilityEnvelope({
    sourceData: roster.sourceData,
    bundleTrust: trustedBundle(roster.sourceData),
    player: prepared("local-engine"),
    opponents: [],
    providerIdentity: localIdentity,
    profilePolicyHash: POLICY_SHA,
    scenarioContractSha256: CONTRACT_SHA,
  });
  const website = buildProviderCompatibilityEnvelope({
    sourceData: roster.sourceData,
    bundleTrust: trustedBundle(roster.sourceData),
    player: prepared("website"),
    opponents: [],
    providerIdentity: websiteIdentity,
    websiteEvidence,
    profilePolicyHash: POLICY_SHA,
    scenarioContractSha256: CONTRACT_SHA,
  });
  website.scenarioContractSha256 = "e".repeat(64);

  const comparison = compareProviderCompatibilityEnvelopes(local, website);
  assert.equal(comparison.comparable, false);
  assert.deepEqual(
    new Set(comparison.issues.map((issue) => issue.code)),
    new Set([
      "ENVELOPE_DIGEST_INVALID",
      "SCENARIO_CONTRACT_MISMATCH",
    ]),
  );
});
