import {
  buildRoster,
  type ProfilePolicyV1,
  type RosterDraftV1,
} from "../../lib/rosterpilot";
import {
  aggregateProfileRequirements,
  profilePolicyScaffold,
} from "../../local/tessera/profile-policy";

export function buildCustodesVsAeldariSmokeRoster(): RosterDraftV1 {
  const result = buildRoster({
    playerFaction: "adeptus-custodes",
    pointsLimit: 1_000,
    name: "Golden Net vs Aeldari",
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
      factionId: "aeldari",
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

export function resolvedProfilePolicy(
  ...rosters: RosterDraftV1[]
): ProfilePolicyV1 {
  const requirements = aggregateProfileRequirements(rosters);
  const scaffold = profilePolicyScaffold(requirements);
  return {
    ...scaffold,
    entries: scaffold.entries.map((entry, index) => ({
      ...entry,
      selectedProfile: requirements[index].availableProfiles[0],
    })),
  };
}
