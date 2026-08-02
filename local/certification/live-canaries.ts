import type {
  RosterDraftV1,
  RuntimeProvenance,
  TesseraFrozenScenarioContract,
  TesseraSimulationProvider,
  TesseraStressPortfolioPreview,
} from "../../lib/rosterpilot";
import type { LocalAgentStatus } from "../agent/contracts";
import type { TesseraRunRequest } from "../tessera/jobs";

export const LIVE_CANARY_PROFILE_POLICY_ENV =
  "ROSTERPILOT_CERTIFICATION_PROFILE_POLICY_PATH";

export const LIVE_CANARY_FIXTURE_ENV = {
  opponentRosz:
    "ROSTERPILOT_CANARY_MULTIPROFILE_ROSZ_PATH",
  opponentContext:
    "ROSTERPILOT_CANARY_MULTIPROFILE_CONTEXT_PATH",
  playerRoster:
    "ROSTERPILOT_CANARY_PLAYER_ROSTER_PATH",
  revisedRoster:
    "ROSTERPILOT_CANARY_REVISED_ROSTER_PATH",
} as const;

export const LIVE_CANARY_IDS = [
  "custodes-vs-adaptive-nine-aeldari-2000",
  "death-guard-vs-orks-exact-1000",
  "uploaded-multiprofile-exact-paired-revision",
] as const;

export type LiveCanaryId = (typeof LIVE_CANARY_IDS)[number];

export type LiveCanaryAssertionDefinition = Readonly<{
  id: string;
  description: string;
}>;

export type LiveCanaryDefinition = Readonly<{
  schemaVersion: 1;
  canaryKind: "rosterpilot-rotating-live-canary-definition";
  id: LiveCanaryId;
  title: string;
  route:
    | "adaptive-nine-stress"
    | "distinct-faction-exact"
    | "uploaded-multiprofile-paired-revision";
  playerFactionId: string | null;
  opponentFactionId: string | null;
  pointsLimit: number | null;
  requiredPathEnvironment: readonly string[];
  assertions: readonly LiveCanaryAssertionDefinition[];
}>;

const sharedPolicyRequirement = Object.freeze([
  LIVE_CANARY_PROFILE_POLICY_ENV,
] as const);

export const LIVE_CANARY_DEFINITIONS: Readonly<
  Record<LiveCanaryId, LiveCanaryDefinition>
> = Object.freeze({
  "custodes-vs-adaptive-nine-aeldari-2000": Object.freeze({
    schemaVersion: 1,
    canaryKind:
      "rosterpilot-rotating-live-canary-definition",
    id: "custodes-vs-adaptive-nine-aeldari-2000",
    title:
      "Adeptus Custodes versus adaptive-nine Aeldari at 2,000 points",
    route: "adaptive-nine-stress",
    playerFactionId: "adeptus-custodes",
    opponentFactionId: "aeldari",
    pointsLimit: 2_000,
    requiredPathEnvironment: sharedPolicyRequirement,
    assertions: Object.freeze([
      {
        id: "portfolio-nine-distinct",
        description:
          "The frozen Aeldari portfolio contains nine legal, exportable, execution-distinct proxies.",
      },
      {
        id: "portfolio-three-postures",
        description:
          "Balanced, ranged, and assault postures are all represented.",
      },
      {
        id: "forced-client-timeout",
        description:
          "The client stops waiting while the local-agent-backed job remains recoverable.",
      },
      {
        id: "resume-same-run",
        description:
          "Resume returns the same run and active attempt without starting a duplicate worker.",
      },
      {
        id: "zero-duplicate-delivery",
        description:
          "One player plus nine proxies account for all New Recruit preparation receipts, with no duplicate remote delivery.",
      },
      {
        id: "staged-nine-plus-three",
        description:
          "All nine proxies are screened and three distinct representatives receive deep dives.",
      },
      {
        id: "portable-artifacts",
        description:
          "The completed report uses bundle-relative, hash-verifiable artifacts.",
      },
    ]),
  }),
  "death-guard-vs-orks-exact-1000": Object.freeze({
    schemaVersion: 1,
    canaryKind:
      "rosterpilot-rotating-live-canary-definition",
    id: "death-guard-vs-orks-exact-1000",
    title:
      "Death Guard versus Orks exact matchup at 1,000 points",
    route: "distinct-faction-exact",
    playerFactionId: "death-guard",
    opponentFactionId: "orks",
    pointsLimit: 1_000,
    requiredPathEnvironment: sharedPolicyRequirement,
    assertions: Object.freeze([
      {
        id: "distinct-factions",
        description:
          "The canonical player and opponent use different faction and execution identities.",
      },
      {
        id: "exact-route",
        description:
          "The durable exact-roster route is used; no renamed mirror or faction archetype is substituted.",
      },
      {
        id: "matched-points-contract",
        description:
          "Both canonical rosters declare the same points limit and remain inside the inclusive five-percent tolerance.",
      },
      {
        id: "complete-exact-evidence",
        description:
          "Every frozen phase and direction completes against the real distinct-faction opponent.",
      },
      {
        id: "tessera-ui-provenance",
        description:
          "The result contains a concrete Tessera UI identity and connector receipts.",
      },
    ]),
  }),
  "uploaded-multiprofile-exact-paired-revision": Object.freeze({
    schemaVersion: 1,
    canaryKind:
      "rosterpilot-rotating-live-canary-definition",
    id: "uploaded-multiprofile-exact-paired-revision",
    title:
      "Uploaded multi-profile exact matchup and paired revision",
    route: "uploaded-multiprofile-paired-revision",
    playerFactionId: null,
    opponentFactionId: null,
    pointsLimit: null,
    requiredPathEnvironment: Object.freeze([
      ...sharedPolicyRequirement,
      LIVE_CANARY_FIXTURE_ENV.opponentRosz,
      LIVE_CANARY_FIXTURE_ENV.opponentContext,
      LIVE_CANARY_FIXTURE_ENV.playerRoster,
      LIVE_CANARY_FIXTURE_ENV.revisedRoster,
    ]),
    assertions: Object.freeze([
      {
        id: "uploaded-multiprofile-observed",
        description:
          "The configured uploaded ROSZ contains at least one explicit alternate weapon-profile choice.",
      },
      {
        id: "uploaded-context-verified",
        description:
          "The uploaded archive is analyzed only with its matching canonical opponent context and source pin.",
      },
      {
        id: "baseline-exact-complete",
        description:
          "The durable exact baseline completes with frozen profile and opponent evidence.",
      },
      {
        id: "paired-revision-complete",
        description:
          "The revised canonical roster is rerun through the paired-revision workflow.",
      },
      {
        id: "paired-evidence-frozen",
        description:
          "The paired result retains the baseline run, scenario, profile-policy, opponent-artifact, and Tessera UI identities.",
      },
    ]),
  }),
});

export function liveCanaryDefinition(
  id: string,
): LiveCanaryDefinition {
  if (!LIVE_CANARY_IDS.includes(id as LiveCanaryId)) {
    throw Object.assign(
      new Error(`Unknown rotating live canary "${id}".`),
      { code: "LIVE_CANARY_NOT_FOUND" },
    );
  }
  return LIVE_CANARY_DEFINITIONS[id as LiveCanaryId];
}

export type LiveCanaryPathReadiness = Readonly<{
  configured: boolean;
  readable: boolean;
  basename: string | null;
}>;

export type LiveCanaryUnavailableReason = Readonly<{
  code:
    | "LIVE_OPT_IN_REQUIRED"
    | "LIVE_MACOS_REQUIRED"
    | "LIVE_REQUIRED_PATH_UNSET"
    | "LIVE_REQUIRED_PATH_UNREADABLE"
    | "LIVE_LOCAL_AGENT_UNAVAILABLE"
    | "LIVE_LOCAL_AGENT_PROTOCOL_MISMATCH"
    | "LIVE_LOCAL_AGENT_INSTALLATION_STALE"
    | "LIVE_RUNTIME_STALE"
    | "LIVE_RUNTIME_MISMATCH"
    | "LIVE_BROWSER_UNAVAILABLE"
    | "LIVE_BROKER_UNAVAILABLE"
    | "LIVE_NEW_RECRUIT_UNAVAILABLE"
    | "LIVE_TESSERA_UNAVAILABLE"
    | "LIVE_PROFILE_POLICY_INVALID"
    | "LIVE_FIXTURE_INVALID";
  message: string;
  requirement: string | null;
}>;

export type LiveCanaryReadiness = Readonly<{
  status: "ready" | "unavailable";
  reasons: readonly LiveCanaryUnavailableReason[];
  requiredPaths: Readonly<
    Record<string, LiveCanaryPathReadiness>
  >;
}>;

function unavailableReason(
  code: LiveCanaryUnavailableReason["code"],
  message: string,
  requirement: string | null = null,
): LiveCanaryUnavailableReason {
  return Object.freeze({ code, message, requirement });
}

export function evaluateLiveCanaryReadiness(input: {
  definition: LiveCanaryDefinition;
  liveOptIn: boolean;
  platform: NodeJS.Platform;
  expectedProjectDirectory: string;
  runtime: RuntimeProvenance;
  agentStatus: LocalAgentStatus | null;
  agentError?: string | null;
  requiredPaths: Readonly<
    Record<string, LiveCanaryPathReadiness>
  >;
}): LiveCanaryReadiness {
  const reasons: LiveCanaryUnavailableReason[] = [];
  if (!input.liveOptIn) {
    reasons.push(
      unavailableReason(
        "LIVE_OPT_IN_REQUIRED",
        "Set ROSTERPILOT_CERTIFICATION_LIVE=1 to authorize live connector mutations.",
        "ROSTERPILOT_CERTIFICATION_LIVE",
      ),
    );
  }
  if (input.platform !== "darwin") {
    reasons.push(
      unavailableReason(
        "LIVE_MACOS_REQUIRED",
        "Rotating live canaries require the supported local macOS runtime.",
      ),
    );
  }
  for (const environmentName of
    input.definition.requiredPathEnvironment) {
    const state = input.requiredPaths[environmentName] ?? {
      configured: false,
      readable: false,
      basename: null,
    };
    if (!state.configured) {
      reasons.push(
        unavailableReason(
          "LIVE_REQUIRED_PATH_UNSET",
          `The required ${environmentName} path is not configured.`,
          environmentName,
        ),
      );
    } else if (!state.readable) {
      reasons.push(
        unavailableReason(
          "LIVE_REQUIRED_PATH_UNREADABLE",
          `The configured ${environmentName} file is not readable.`,
          environmentName,
        ),
      );
    }
  }
  const agent = input.agentStatus;
  if (!agent) {
    reasons.push(
      unavailableReason(
        "LIVE_LOCAL_AGENT_UNAVAILABLE",
        input.agentError ??
          "The RosterPilot local agent could not be reached.",
      ),
    );
  } else {
    if (!agent.available) {
      reasons.push(
        unavailableReason(
          "LIVE_LOCAL_AGENT_UNAVAILABLE",
          "The RosterPilot local agent is not available.",
        ),
      );
    }
    if (!agent.protocolCompatible) {
      reasons.push(
        unavailableReason(
          "LIVE_LOCAL_AGENT_PROTOCOL_MISMATCH",
          "The running local agent does not support this RosterPilot protocol.",
        ),
      );
    }
    if (
      agent.projectDirectory !== input.expectedProjectDirectory
    ) {
      reasons.push(
        unavailableReason(
          "LIVE_LOCAL_AGENT_INSTALLATION_STALE",
          "The running local agent belongs to a different checkout.",
        ),
      );
    }
    if (
      input.runtime.stale ||
      agent.runtime?.stale === true
    ) {
      reasons.push(
        unavailableReason(
          "LIVE_RUNTIME_STALE",
          "RosterPilot source changed after the active runtime was loaded.",
        ),
      );
    }
    if (
      !agent.runtime ||
      agent.runtime.buildId !== input.runtime.buildId
    ) {
      reasons.push(
        unavailableReason(
          "LIVE_RUNTIME_MISMATCH",
          "The CLI and local agent do not share the same frozen runtime build.",
        ),
      );
    }
    if (!agent.browserAvailable) {
      reasons.push(
        unavailableReason(
          "LIVE_BROWSER_UNAVAILABLE",
          "The supported Chrome runtime is unavailable.",
        ),
      );
    }
    if (!agent.brokerAvailable) {
      reasons.push(
        unavailableReason(
          "LIVE_BROKER_UNAVAILABLE",
          "The local Keychain broker is unavailable.",
        ),
      );
    }
    const newRecruit = agent.providers.find(
      (provider) => provider.providerId === "new-recruit",
    );
    if (!newRecruit?.ready) {
      reasons.push(
        unavailableReason(
          "LIVE_NEW_RECRUIT_UNAVAILABLE",
          `New Recruit is not ready (${newRecruit?.credentialState ?? "unavailable"}).`,
        ),
      );
    }
    const tessera = agent.providers.find(
      (provider) => provider.providerId === "tessera",
    );
    if (!tessera?.ready) {
      reasons.push(
        unavailableReason(
          "LIVE_TESSERA_UNAVAILABLE",
          `Tessera is not ready (${tessera?.credentialState ?? "unavailable"}).`,
        ),
      );
    }
  }
  return Object.freeze({
    status: reasons.length === 0 ? "ready" : "unavailable",
    reasons: Object.freeze(reasons),
    requiredPaths: input.requiredPaths,
  });
}

export type LiveCanaryCatalogueDriftMode =
  | "reject"
  | "diagnostic";

type LiveCanaryRouteInput = (
  | {
      id: "custodes-vs-adaptive-nine-aeldari-2000";
      playerRoster: RosterDraftV1;
      portfolioPreview: TesseraStressPortfolioPreview;
      profilePolicyPath: string;
    }
  | {
      id: "death-guard-vs-orks-exact-1000";
      playerRoster: RosterDraftV1;
      opponentRoster: RosterDraftV1;
      profilePolicyPath: string;
      simulationBackend?: TesseraSimulationProvider;
      scenarioContract?: TesseraFrozenScenarioContract[];
    }
  | {
      id: "uploaded-multiprofile-exact-paired-revision";
      playerRoster: RosterDraftV1;
      opponentRosterContext: RosterDraftV1;
      opponentRoszPath: string;
      profilePolicyPath: string;
    }
) & {
  catalogueDriftMode?: LiveCanaryCatalogueDriftMode;
  providerCompatibilityMode?: "observe" | "enforce";
};

/**
 * Produces the exact durable-run request represented by a canary definition.
 * Keeping this pure makes transport routing testable without credentials or
 * browser mutations.
 */
export function createLiveCanaryRunRequest(
  input: LiveCanaryRouteInput,
): TesseraRunRequest {
  const catalogueDriftMode =
    input.catalogueDriftMode ?? "reject";
  const providerCompatibilityMode =
    input.providerCompatibilityMode ?? "observe";
  if (
    input.id ===
    "custodes-vs-adaptive-nine-aeldari-2000"
  ) {
    return {
      kind: "stress",
      playerRoster: input.playerRoster,
      factionId: "aeldari",
      options: {
        suite: "diverse-9",
        analysisStrategy: "staged",
        executionMode: "simulate",
        experimental: false,
        catalogueDriftMode,
        providerCompatibilityMode,
        profilePolicyPath: input.profilePolicyPath,
        portfolioPreview: input.portfolioPreview,
      },
    };
  }
  if (input.id === "death-guard-vs-orks-exact-1000") {
    return {
      kind: "exact",
      playerRoster: input.playerRoster,
      opponent: {
        kind: "roster",
        roster: input.opponentRoster,
      },
      options: {
        executionMode: "simulate",
        experimental: false,
        analysisMode: "full",
        catalogueDriftMode,
        providerCompatibilityMode,
        profilePolicyPath: input.profilePolicyPath,
        ...(input.simulationBackend
          ? { simulationBackend: input.simulationBackend }
          : {}),
        ...(input.scenarioContract
          ? { scenarioContract: input.scenarioContract }
          : {}),
      },
    };
  }
  return {
    kind: "exact",
    playerRoster: input.playerRoster,
    opponent: {
      kind: "rosz",
      path: input.opponentRoszPath,
    },
    options: {
      executionMode: "simulate",
      experimental: false,
      analysisMode: "full",
      catalogueDriftMode,
      providerCompatibilityMode,
      profilePolicyPath: input.profilePolicyPath,
      opponentRosterContext: input.opponentRosterContext,
    },
  };
}
