import {
  buildRoster,
  type ProfilePolicyV1,
  type RosterDraftV1,
} from "../../lib/rosterpilot";
import {
  aggregateProfileRequirements,
  profilePolicyScaffold,
} from "../../local/tessera/profile-policy";
import { dataset as activeRuntimeDataset } from "../../lib/rosterpilot/runtime-dataset";

function buildCustodesSmokeRoster(input: {
  opponentFactionId: string;
  name: string;
}): RosterDraftV1 {
  const result = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: input.name,
    preferences: ["objective", "mobility", "durability"],
    legendsPolicy: "exclude",
    playContext: { kind: "matched-play" },
    requiredUnitIds: [
      "agamatus-custodians",
      "custodian-guard-with-adrasite-and-pyrithite-spears",
      "shield-captain",
      "witchseekers",
    ],
    requiredWarlordUnitId: "shield-captain",
    detachmentId: "shield-host",
    opponentContext: {
      kind: "known-faction",
      factionId: input.opponentFactionId,
    },
    mixedThreatIntent: true,
  });
  if (!result.ok || !result.data) {
    throw new Error(
      `The frozen Custodes smoke roster could not be built: ${result.violations
        .map((issue) => issue.message)
        .join(" ")}`,
    );
  }
  return result.data;
}

export function buildCustodesVsAeldariSmokeRoster(): RosterDraftV1 {
  return buildCustodesSmokeRoster({
    opponentFactionId: "aeldari",
    name: "Golden Net vs Aeldari",
  });
}

export function buildCustodesVsWorldEatersSmokeRoster(): RosterDraftV1 {
  return buildCustodesSmokeRoster({
    opponentFactionId: "world-eaters",
    name: "Golden Net vs World Eaters",
  });
}

export function resolvedProfilePolicy(
  ...rosters: RosterDraftV1[]
): ProfilePolicyV1 {
  const requirements = aggregateProfileRequirements(
    rosters,
    activeRuntimeDataset,
  );
  const scaffold = profilePolicyScaffold(requirements);
  return {
    ...scaffold,
    entries: scaffold.entries.map((entry, index) => ({
      ...entry,
      selectedProfile: requirements[index].availableProfiles[0],
    })),
  };
}
