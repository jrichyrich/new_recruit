import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareRosterWorkflow,
} from "../lib/rosterpilot/roster-workflow";
import { buildRoster } from "../lib/rosterpilot/engine";

test("roster workflow fails closed on a voice-like faction name", async () => {
  const result = await prepareRosterWorkflow({
    prompt: "Make me a 1,000 point Coto del Darri army.",
  });

  assert.equal(result.ok, false);
  assert.equal(result.data?.status, "needs-input");
  assert.equal(result.data?.faction?.status, "unsupported");
  assert.equal(result.data?.roster, null);
});

test("roster workflow distinguishes player and opponent factions", async () => {
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,000 point Custodes army to battle against Aeldari.",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.roster?.factionId, "adeptus-custodes");
  assert.equal(
    result.data?.roster?.constraints.opponentFactionId,
    "aeldari",
  );
});

test("opponent play-style assumptions do not become player preferences", async () => {
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,000 point Custodes army against Aeldari; they play mobile and ranged.",
    opponentAssumptions: {
      styleTags: ["mobile", "ranged"],
      source: "user-stated",
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.opponentAssumptions?.styleTags, [
    "mobile",
    "ranged",
  ]);
  assert.equal(result.data?.roster?.preferences.includes("mobility"), false);
  assert.equal(result.data?.roster?.preferences.includes("shooting"), false);
});

test("local exact analysis uses canonical rosters without a New Recruit handoff", async () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  }).data;
  assert.ok(opponent);
  const result = await prepareRosterWorkflow({
    intent: "analyze",
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    simulationBackend: "local-engine",
    opponentContext: { kind: "known-roster", roster: opponent },
    coachingMode: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.analysis?.provider, "local-engine");
  assert.deepEqual(result.data?.analysis?.providerPlan, {
    requested: "local-engine",
    selected: "local-engine",
    reason: "explicit-local-engine",
    artifactIntent: "bundle-native",
    externalActionRequired: false,
    omissionsPolicy: "best-effort-explicit",
  });
  assert.equal(result.data?.analysis?.target.kind, "exact-opponent");
  assert.equal(result.data?.newRecruit.handoff, null);
});

test("auto analysis remains promotion-gated and provider-deferred", async () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  }).data;
  assert.ok(opponent);
  const result = await prepareRosterWorkflow({
    intent: "analyze",
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    simulationBackend: "auto",
    opponentContext: { kind: "known-roster", roster: opponent },
    coachingMode: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.analysis?.provider, "auto");
  assert.deepEqual(result.data?.analysis?.providerPlan, {
    requested: "auto",
    selected: "auto",
    reason: "promotion-gated-auto",
    artifactIntent: "provider-deferred",
    externalActionRequired: "provider-dependent",
    omissionsPolicy: "provider-dependent",
  });
  assert.equal(result.data?.newRecruit.handoff, null);
});

test("local known-faction analysis freezes a canonical portfolio", {
  timeout: 120_000,
}, async () => {
  const result = await prepareRosterWorkflow({
    intent: "analyze",
    playerFaction: "adeptus-custodes",
    opponentFaction: "agents-of-the-imperium",
    pointsLimit: 1000,
    simulationBackend: "local-engine",
    coachingMode: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.analysis?.target.kind, "known-faction");
  assert.equal(result.data?.newRecruit.handoff, null);
});

test("local general-threat analysis freezes six canonical opponents", {
  timeout: 120_000,
}, async () => {
  const result = await prepareRosterWorkflow({
    intent: "analyze",
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    simulationBackend: "local-engine",
    coachingMode: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.data?.analysis?.target.kind,
    "general-six-archetype",
  );
  if (result.data?.analysis?.target.kind === "general-six-archetype") {
    assert.equal(result.data.analysis.target.portfolio.items.length, 6);
  }
  assert.equal(result.data?.newRecruit.handoff, null);
});

test("roster workflow prepares an export-safe New Recruit handoff", async () => {
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,000 point Death Guard army and export it for New Recruit.",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.intent?.intent, "prepare-new-recruit");
  assert.equal(result.data?.newRecruit.delivery.authorized, false);
  assert.equal(result.data?.newRecruit.delivery.status, "prepared");
  assert.ok(
    result.data?.newRecruit.handoff?.artifacts.some(
      (artifact) => artifact.format === "rosz",
    ),
  );
  assert.ok(
    (result.data?.roster?.totalPoints ?? 0) >=
      (result.data?.roster?.pointsLimit ?? 1) * 0.98,
  );
});

test("roster workflow names an unmapped required selection", async () => {
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,000 point Custodes army and export it for New Recruit.",
    requiredUnitIds: ["gilded-blades-custodian-guard"],
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.violations[0]?.code,
    "REQUIRED_SELECTION_UNMAPPED",
  );
  assert.match(
    result.violations[0]?.message ?? "",
    /Gilded Blades Custodian Guard/,
  );
});

test("artifact failure retains the legal canonical roster fallback", async () => {
  const result = await prepareRosterWorkflow({
    intent: "prepare-new-recruit",
    playerFaction: "agents-of-the-imperium",
    pointsLimit: 1000,
    allowNamedCharacters: false,
    coachingMode: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.status, "action-required");
  assert.ok(
    result.warnings.some(
      (warning) => warning.code === "EXPORTABLE_ROSTER_UNAVAILABLE",
    ),
  );
  assert.equal(result.data?.validation?.ok, true);
  assert.equal(result.data?.roster?.totalPoints, 1000);
  assert.ok(result.data?.newRecruit.handoff);
  assert.equal(
    result.data?.newRecruit.handoff?.artifacts.some(
      (artifact) => artifact.format === "rosz",
    ),
    false,
  );
  assert.ok(
    result.data?.newRecruit.handoff?.artifacts.some(
      (artifact) => artifact.format === "html",
    ),
  );
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code ===
        "CANONICAL_ROSTER_FALLBACK_AVAILABLE",
    ),
  );
});

test("export-safe workflow preserves owned collection quantities", async () => {
  const result = await prepareRosterWorkflow({
    intent: "prepare-new-recruit",
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    coachingMode: "none",
    collectionProfile: {
      mode: "owned",
      units: [
        { unitId: "blade-champion", maxUnits: 1, maxModels: 1 },
        { unitId: "prosecutors", maxUnits: 3, maxModels: 12 },
        { unitId: "witchseekers", maxUnits: 3, maxModels: 12 },
        { unitId: "vigilators", maxUnits: 3, maxModels: 12 },
        {
          unitId: "allarus-custodians",
          maxUnits: 3,
          maxModels: 18,
        },
        {
          unitId: "sagittarum-custodians",
          maxUnits: 3,
          maxModels: 15,
        },
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.data?.roster?.constraints.collectionProfile?.mode,
    "owned",
  );
  assert.ok((result.data?.roster?.totalPoints ?? 0) >= 980);
});

test("roster workflow authorizes same-prompt delivery without performing it", async () => {
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,000 point Space Marines army and upload it to New Recruit.",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.newRecruit.delivery.authorized, true);
  assert.equal(
    result.data?.newRecruit.delivery.status,
    "authorized-pending-transport",
  );
});

test("roster workflow creates six archetype optimizer input", {
  timeout: 120_000,
}, async () => {
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,000 point Custodes army and Tessera optimize it.",
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.data?.status,
    "ready-for-tessera-baseline",
  );
  assert.deepEqual(result.data?.optimization?.preparation, {
    provider: "auto",
    artifactIntent: "provider-deferred",
    simulationInput: "pending-provider-selection",
    sourceRosz: "pending-provider-selection",
    profileRichRosz: "pending-provider-selection",
    omissionsPolicy: "provider-dependent",
    pairedBaseline: "pending-tessera",
  });
  assert.deepEqual(result.data?.optimization?.providerPlan, {
    requested: "auto",
    selected: "auto",
    reason: "promotion-gated-auto",
    artifactIntent: "provider-deferred",
    externalActionRequired: "provider-dependent",
    omissionsPolicy: "provider-dependent",
  });
  assert.equal(result.data?.optimization?.mode, "guided");
  assert.equal(
    result.data?.optimization?.target.kind,
    "general-six-archetype",
  );
  if (
    result.data?.optimization?.target.kind ===
    "general-six-archetype"
  ) {
    assert.equal(
      result.data.optimization.target.portfolio.items.length,
      6,
    );
  }
});

test("explicit local optimization uses bundle-native best-effort preparation", async () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  }).data;
  assert.ok(opponent);
  const result = await prepareRosterWorkflow({
    intent: "optimize",
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    simulationBackend: "local-engine",
    opponentContext: { kind: "known-roster", roster: opponent },
    coachingMode: "none",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.optimization?.preparation, {
    provider: "local-engine",
    artifactIntent: "bundle-native",
    simulationInput: "pending-bundle-native-compilation",
    sourceRosz: "not-required",
    profileRichRosz: "not-required",
    omissionsPolicy: "best-effort-explicit",
    pairedBaseline: "pending-tessera",
  });
});

test("explicit website optimization retains New Recruit-enriched artifact intent", async () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  }).data;
  assert.ok(opponent);
  const result = await prepareRosterWorkflow({
    intent: "optimize",
    playerFaction: "adeptus-custodes",
    pointsLimit: 1000,
    simulationBackend: "website",
    opponentContext: { kind: "known-roster", roster: opponent },
    coachingMode: "none",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.optimization?.providerPlan, {
    requested: "website",
    selected: "website",
    reason: "explicit-website",
    artifactIntent: "new-recruit-enriched",
    externalActionRequired: true,
    omissionsPolicy: "provider-verified",
  });
  assert.deepEqual(result.data?.optimization?.preparation, {
    provider: "website",
    artifactIntent: "new-recruit-enriched",
    simulationInput: "pending-new-recruit-enrichment",
    sourceRosz: "pending-provider-preparation",
    profileRichRosz: "pending-new-recruit-enrichment",
    omissionsPolicy: "provider-verified",
    pairedBaseline: "pending-tessera",
  });
});

test("roster workflow uses a named opponent faction instead of the generic portfolio", async () => {
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,000 point Custodes army against Aeldari and Tessera optimize it.",
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.data?.optimization?.target.kind,
    "known-faction",
  );
  if (result.data?.optimization?.target.kind === "known-faction") {
    assert.equal(
      result.data.optimization.target.factionId,
      "aeldari",
    );
    assert.equal(
      result.data.optimization.target.portfolioPreview.previewKind,
      "tessera-stress-portfolio",
    );
    assert.ok(
      (result.data.optimization.target.portfolioPreview.portfolio
        .contract?.portfolioHash?.length ?? 0) > 0,
    );
  }
});

test("exact opponent roster conflicts with a different prompt opponent", async () => {
  const opponent = buildRoster({
    playerFaction: "aeldari",
    pointsLimit: 1000,
  }).data;
  assert.ok(opponent);
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,000 point Custodes army against Orks and Tessera optimize it.",
    opponentContext: {
      kind: "known-roster",
      roster: opponent,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.violations[0]?.code,
    "OPPONENT_FACTION_CONFLICT",
  );
});

test("generic optimizer requires standard points when opponent scope is absent", async () => {
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,250 point Custodes army and Tessera optimize it.",
  });

  assert.equal(result.ok, false);
  assert.equal(result.data?.status, "needs-input");
  assert.equal(
    result.violations[0]?.code,
    "GENERAL_PORTFOLIO_POINTS_UNSUPPORTED",
  );
});

test("optimizer defers New Recruit delivery until the approved winner", {
  timeout: 120_000,
}, async () => {
  const result = await prepareRosterWorkflow({
    prompt:
      "Build a 1,000 point Custodes army, Tessera optimize it, then upload the winner to New Recruit.",
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.data?.newRecruit.delivery.authorized,
    false,
  );
  assert.equal(
    result.data?.optimization?.deliveryAfterWinnerApproval,
    "deliver-new-recruit",
  );
});
