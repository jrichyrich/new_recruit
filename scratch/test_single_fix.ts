import fs from "node:fs";
import path from "node:path";
import {
  buildRoster,
  generateFactionStressPortfolio,
  rosterProfileRequirements,
  type ProfilePolicyV1,
} from "../lib/rosterpilot/index.ts";
import { analyzeRosterMatchup } from "../local/tessera/companion.ts";
import { profilePolicyScaffold } from "../local/tessera/profile-policy.ts";

function resolveProfilePolicy(policy: ProfilePolicyV1): ProfilePolicyV1 {
  return {
    ...policy,
    entries: policy.entries.map((entry) => {
      let selected = entry.selectedProfile;
      if (selected.startsWith("SELECT_ONE_OF:")) {
        const choices = selected.replace("SELECT_ONE_OF:", "").split("|").map((s) => s.trim());
        selected = choices[0] || selected;
      }
      return {
        ...entry,
        selectedProfile: selected,
      };
    }),
  };
}

async function testSingle() {
  const custodes = buildRoster({ faction: "adeptus-custodes", pointsLimit: 1000, name: "Custodes Test Roster" }).data!;
  const portfolio = generateFactionStressPortfolio({ faction: "aeldari", pointsLimit: 1000, suite: "diverse-9" }).data!;
  const aeldari = portfolio.items[0].roster!;

  const reqs = [
    ...rosterProfileRequirements(custodes),
    ...rosterProfileRequirements(aeldari),
  ];
  const rawPolicy = profilePolicyScaffold(reqs);
  const resolvedPolicy = resolveProfilePolicy(rawPolicy);

  const policyPath = path.resolve("exports/tessera/test_fixed_policy.json");
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify(resolvedPolicy, null, 2), "utf8");

  const res = await analyzeRosterMatchup(
    custodes,
    { kind: "roster", roster: aeldari },
    {
      outputDirectory: "exports/tessera/test_fix",
      simulationBackend: "website",
      executionMode: "simulate",
      profilePolicyPath: policyPath,
      catalogueDriftMode: "force",
    },
    { runtimeIssue: () => null }
  );

  console.log("SIM OK:", res.ok);
  console.log("SIM VIOLATIONS:", res.violations);
  console.log("SIM STATUS:", res.data?.status);
  console.log("SELECTED BACKEND:", res.data?.simulation?.selectedBackend);
}

testSingle().catch(console.error);
