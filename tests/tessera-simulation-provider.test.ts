import assert from "node:assert/strict";
import test from "node:test";

import type {
  TesseraSimulationProviderIdentity,
} from "../lib/rosterpilot";
import type {
  TesseraBrowserInput,
  TesseraBrowserResult,
} from "../local/tessera/browser";
import { TESSERA_WEBSITE_ADAPTER_VERSION } from "../local/tessera/browser";
import {
  createWebsiteTesseraProvider,
  routeTesseraSimulation,
  TesseraSimulationProviderError,
  type TesseraSimulationPreflight,
  type TesseraSimulationProviderAdapter,
  type TesseraSimulationProviderStatus,
} from "../local/tessera/simulation-provider";

const localIdentity: Extract<
  TesseraSimulationProviderIdentity,
  { provider: "local-engine" }
> = {
  schemaVersion: 1,
  provider: "local-engine",
  engine: "tessera-engine",
  repository: "Tessera-cmd/tessera-engine",
  commit: "16ab4365bbd97ef592b061c5a9babe5e44f00e80",
  tree: "8842756e6b805018f7c186b34521e3931e79e4d8",
  sourceSha256:
    "a1288b50b5d100ea07428e15b6df6cf3c95d6ee379c8c0f5fc7039ca53438da9",
  adapterVersion: "test-adapter-v1",
  compilerVersion: "test-compiler-v1",
  inputSchemaVersion: 1,
  capabilityManifestSha256: "capability-fixture",
  promotion: "candidate",
  licenseState: "evaluation-only",
};

function localProvider(options: {
  available?: boolean;
  promoted?: boolean;
  preflight?: TesseraSimulationPreflight;
  run?: (input: string) => string | Promise<string>;
} = {}): TesseraSimulationProviderAdapter<string, string> & {
  calls: { preflight: number; run: number };
} {
  const calls = { preflight: 0, run: 0 };
  const promoted = options.promoted ?? false;
  const identity: typeof localIdentity = {
    ...localIdentity,
    promotion: promoted ? "promoted" : "candidate",
    licenseState: promoted ? "approved" : "evaluation-only",
  };
  const status: TesseraSimulationProviderStatus = {
    backend: "local-engine",
    available: options.available ?? true,
    promoted,
    evaluationOnly: !promoted,
    identity,
    reasonCodes: [],
  };
  return {
    backend: "local-engine",
    calls,
    getStatus: () => structuredClone(status),
    preflight: () => {
      calls.preflight += 1;
      return (
        options.preflight ?? {
          ok: true,
          reasonCodes: [],
          warnings: [],
        }
      );
    },
    async run(input) {
      calls.run += 1;
      return {
        identity,
        data: options.run ? await options.run(input) : `local:${input}`,
      };
    },
  };
}

const browserInput: TesseraBrowserInput = {
  profileDirectory: "/tmp/tessera-profile",
  playerRoszPath: "/tmp/player.rosz",
  playerName: "Player",
  opponentRoszPath: "/tmp/opponent.rosz",
  opponentName: "Opponent",
};

const frozenRequestSha256 = "a".repeat(64);
const fallbackAuthorization = {
  action: "new-recruit-import-and-tessera-web" as const,
  requestSha256: frozenRequestSha256,
  source: "confirmed-fallback" as const,
};

function browserResult(uiIdentity = "website-ui-fixture"): TesseraBrowserResult {
  return {
    uiIdentity,
    settings: {},
    cells: [],
    scenarios: [],
    importWarnings: { player: [], opponent: [] },
    warnings: [],
  };
}

function websiteRoute(options: {
  run?: () => Promise<TesseraBrowserResult>;
  available?: boolean;
} = {}) {
  let calls = 0;
  const provider = createWebsiteTesseraProvider(
    async () => {
      calls += 1;
      return options.run ? options.run() : browserResult();
    },
    { available: options.available },
  );
  return {
    route: { provider, input: browserInput },
    calls: () => calls,
  };
}

test("website provider preserves the browser contract and records UI identity", async () => {
  const website = websiteRoute();
  const routed = await routeTesseraSimulation<
    string,
    string,
    TesseraBrowserInput,
    TesseraBrowserResult
  >({
    requestedBackend: "website",
    website: website.route,
  });

  assert.equal(routed.selection.selectedBackend, "website");
  assert.equal(routed.selection.reason, "explicit-website");
  assert.equal(routed.identity.provider, "website");
  assert.equal(
    routed.identity.adapterVersion,
    TESSERA_WEBSITE_ADAPTER_VERSION,
  );
  assert.equal(routed.selection.selectedBackend, "website");
  assert.equal(routed.identity.uiIdentity, "website-ui-fixture");
  if (routed.selection.selectedBackend !== "website") {
    assert.fail("Expected the website provider result.");
  }
  assert.equal(
    (routed.data as TesseraBrowserResult).uiIdentity,
    "website-ui-fixture",
  );
  assert.equal(routed.fallback, null);
  assert.equal(website.calls(), 1);
});

test("auto never selects an available evaluation-only local provider", async () => {
  const local = localProvider({ available: true, promoted: false });
  const website = websiteRoute();
  const routed = await routeTesseraSimulation({
    requestedBackend: "auto",
    local: { provider: local, input: "candidate" },
    website: website.route,
  });

  assert.equal(routed.selection.selectedBackend, "website");
  assert.equal(routed.selection.reason, "local-not-promoted");
  assert.equal(local.calls.preflight, 0);
  assert.equal(local.calls.run, 0);
  assert.equal(website.calls(), 1);
});

test("explicit local evaluation is permitted without promoting it as the default", async () => {
  const local = localProvider({ available: true, promoted: false });
  const website = websiteRoute();
  const routed = await routeTesseraSimulation({
    requestedBackend: "local-engine",
    local: { provider: local, input: "evaluation" },
    website: website.route,
  });

  assert.equal(routed.selection.selectedBackend, "local-engine");
  assert.equal(routed.selection.reason, "explicit-local-engine");
  assert.equal(routed.data, "local:evaluation");
  assert.equal(routed.providerStatus.evaluationOnly, true);
  assert.equal(local.calls.preflight, 1);
  assert.equal(local.calls.run, 1);
  assert.equal(website.calls(), 0);
});

test("auto selects local only after promotion and a complete preflight", async () => {
  const local = localProvider({ available: true, promoted: true });
  const website = websiteRoute();
  const routed = await routeTesseraSimulation({
    requestedBackend: "auto",
    local: { provider: local, input: "promoted" },
    website: website.route,
  });

  assert.equal(routed.selection.selectedBackend, "local-engine");
  assert.equal(routed.selection.reason, "promoted-local-engine");
  assert.equal(routed.data, "local:promoted");
  assert.equal(local.calls.preflight, 1);
  assert.equal(local.calls.run, 1);
  assert.equal(website.calls(), 0);
});

test("auto offers but does not start Web when local rejects the complete input", async () => {
  const local = localProvider({
    promoted: true,
    preflight: {
      ok: false,
      reasonCodes: ["TESSERA_LOCAL_UNSUPPORTED_RULES"],
      warnings: [],
    },
  });
  const website = websiteRoute();
  await assert.rejects(
    routeTesseraSimulation({
      requestedBackend: "auto",
      local: { provider: local, input: "unsupported" },
      website: website.route,
      requestSha256: frozenRequestSha256,
    }),
    (error: unknown) =>
      error instanceof TesseraSimulationProviderError &&
      error.code === "TESSERA_WEBSITE_FALLBACK_REQUIRES_CONFIRMATION" &&
      error.fallbackOffer?.requestSha256 === frozenRequestSha256,
  );
  assert.equal(local.calls.preflight, 1);
  assert.equal(local.calls.run, 0);
  assert.equal(website.calls(), 0);
});

test("authorized auto fallback starts Web after local preflight rejection", async () => {
  const local = localProvider({
    promoted: true,
    preflight: {
      ok: false,
      reasonCodes: ["TESSERA_LOCAL_UNSUPPORTED_RULES"],
      warnings: [],
    },
  });
  const website = websiteRoute();
  const routed = await routeTesseraSimulation({
    requestedBackend: "auto",
    local: { provider: local, input: "unsupported" },
    website: website.route,
    requestSha256: frozenRequestSha256,
    websiteFallbackAuthorization: fallbackAuthorization,
  });

  assert.equal(routed.selection.selectedBackend, "website");
  assert.equal(routed.selection.reason, "local-preflight-failed");
  assert.equal(routed.fallback?.requestSha256, frozenRequestSha256);
  assert.equal(local.calls.run, 0);
  assert.equal(website.calls(), 1);
});

test("auto offers but does not start Web after a failed local execution", async () => {
  const local = localProvider({
    promoted: true,
    run: () => {
      throw new TesseraSimulationProviderError(
        "TESSERA_LOCAL_SELF_CHECK_FAILED",
        "Local output did not pass its integrity check.",
        { backend: "local-engine" },
      );
    },
  });
  const website = websiteRoute();
  await assert.rejects(
    routeTesseraSimulation({
      requestedBackend: "auto",
      local: { provider: local, input: "atomic-run" },
      website: website.route,
      requestSha256: frozenRequestSha256,
    }),
    (error: unknown) =>
      error instanceof TesseraSimulationProviderError &&
      error.code === "TESSERA_WEBSITE_FALLBACK_REQUIRES_CONFIRMATION" &&
      error.fallbackOffer?.code === "TESSERA_LOCAL_SELF_CHECK_FAILED",
  );
  assert.equal(local.calls.run, 1);
  assert.equal(website.calls(), 0);
});

test("authorized auto fallback discards local evidence and starts Web", async () => {
  const local = localProvider({
    promoted: true,
    run: () => {
      throw new TesseraSimulationProviderError(
        "TESSERA_LOCAL_SELF_CHECK_FAILED",
        "Local output did not pass its integrity check.",
        { backend: "local-engine" },
      );
    },
  });
  const website = websiteRoute();
  const routed = await routeTesseraSimulation({
    requestedBackend: "auto",
    local: { provider: local, input: "atomic-run" },
    website: website.route,
    requestSha256: frozenRequestSha256,
    websiteFallbackAuthorization: fallbackAuthorization,
  });

  assert.equal(routed.selection.selectedBackend, "website");
  assert.equal(routed.selection.reason, "local-runtime-fallback");
  assert.deepEqual(routed.fallback, {
    from: "local-engine",
    to: "website",
    code: "TESSERA_LOCAL_SELF_CHECK_FAILED",
    message: "Local output did not pass its integrity check.",
    discardedLocalEvidence: true,
    requestSha256: frozenRequestSha256,
  });
  assert.equal(local.calls.run, 1);
  assert.equal(website.calls(), 1);
});

test("explicit local failure never silently falls back to the website", async () => {
  const local = localProvider({
    run: () => {
      throw new TesseraSimulationProviderError(
        "TESSERA_LOCAL_ENGINE_FAILED",
        "Local engine failed.",
        { backend: "local-engine" },
      );
    },
  });
  const website = websiteRoute();

  await assert.rejects(
    routeTesseraSimulation({
      requestedBackend: "local-engine",
      local: { provider: local, input: "explicit" },
      website: website.route,
    }),
    (error: unknown) =>
      error instanceof TesseraSimulationProviderError &&
      error.code === "TESSERA_LOCAL_ENGINE_FAILED",
  );
  assert.equal(local.calls.run, 1);
  assert.equal(website.calls(), 0);
});
