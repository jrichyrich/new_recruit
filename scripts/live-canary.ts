import path from "node:path";

import {
  LIVE_CANARY_IDS,
  liveCanaryDefinition,
  type LiveCanaryId,
} from "../local/certification/live-canaries";
import {
  runRotatingLiveCanary,
  writeRotatingLiveCanaryReport,
} from "../local/certification/live-canary-runner";

type ParsedArguments = {
  canaryId: LiveCanaryId | null;
  outputDirectory: string;
  profilePolicyPath: string | undefined;
  maxWaitMs: number | undefined;
  pollMs: number | undefined;
  forcedClientTimeoutMs: number | undefined;
  requireLive: boolean;
  help: boolean;
};

function help(): string {
  return `RosterPilot rotating live canaries

Usage:
  npm run certify:canary -- --canary <id> [options]

Canaries:
  ${LIVE_CANARY_IDS.join("\n  ")}

Options:
  --out-dir <path>                  Report and durable-run bundle directory.
  --profile-policy <path>           Canary-specific v1 Tessera profile policy.
  --max-wait-ms <milliseconds>      Overall durable-job wait budget.
  --poll-ms <milliseconds>          Durable-job status polling interval.
  --forced-client-timeout-ms <ms>   Custodes/Aeldari client timeout boundary.
  --require-live                    Treat a structured unavailable result as failure.
  --help                            Show this help.

The runner also accepts ROSTERPILOT_CERTIFICATION_PROFILE_POLICY_PATH.
The uploaded multi-profile canary additionally requires:
  ROSTERPILOT_CANARY_MULTIPROFILE_ROSZ_PATH
  ROSTERPILOT_CANARY_MULTIPROFILE_CONTEXT_PATH
  ROSTERPILOT_CANARY_PLAYER_ROSTER_PATH
  ROSTERPILOT_CANARY_REVISED_ROSTER_PATH
`;
}

function positiveInteger(
  value: string | undefined,
  option: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(`${option} requires a positive integer.`);
  }
  return Number(value);
}

function parseArguments(argv: string[]): ParsedArguments {
  let canaryId: LiveCanaryId | null = null;
  let outputDirectory = path.resolve(
    ".certification",
    "live-canaries",
  );
  let profilePolicyPath: string | undefined;
  let maxWaitMs: number | undefined;
  let pollMs: number | undefined;
  let forcedClientTimeoutMs: number | undefined;
  let requireLive = false;
  let showHelp = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${token} requires a value.`);
      }
      index += 1;
      return value;
    };
    if (token === "--canary") {
      const value = next();
      liveCanaryDefinition(value);
      canaryId = value as LiveCanaryId;
    } else if (token === "--out-dir") {
      outputDirectory = path.resolve(next());
    } else if (token === "--profile-policy") {
      profilePolicyPath = path.resolve(next());
    } else if (token === "--max-wait-ms") {
      maxWaitMs = positiveInteger(next(), token);
    } else if (token === "--poll-ms") {
      pollMs = positiveInteger(next(), token);
    } else if (token === "--forced-client-timeout-ms") {
      forcedClientTimeoutMs = positiveInteger(next(), token);
    } else if (token === "--require-live") {
      requireLive = true;
    } else if (token === "--help" || token === "-h") {
      showHelp = true;
    } else {
      throw new Error(`Unexpected live-canary argument "${token}".`);
    }
  }
  return {
    canaryId,
    outputDirectory,
    profilePolicyPath,
    maxWaitMs,
    pollMs,
    forcedClientTimeoutMs,
    requireLive,
    help: showHelp,
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(help());
    return;
  }
  if (!args.canaryId) {
    throw new Error("--canary is required.");
  }
  const canaryOutput = path.join(
    args.outputDirectory,
    args.canaryId,
  );
  const report = await runRotatingLiveCanary({
    canaryId: args.canaryId,
    outputDirectory: canaryOutput,
    profilePolicyPath: args.profilePolicyPath,
    maxWaitMs: args.maxWaitMs,
    pollMs: args.pollMs,
    forcedClientTimeoutMs:
      args.forcedClientTimeoutMs,
  });
  const written = await writeRotatingLiveCanaryReport(
    report,
    canaryOutput,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        canaryId: report.canary.id,
        status: report.status,
        livePass: report.livePass,
        unavailableReasons:
          report.readiness.reasons.map(
            (reason) => reason.code,
          ),
        runId: report.run?.runId ?? null,
        reportPath: written.reportPath,
        reportSha256: written.sha256,
      },
      null,
      2,
    )}\n`,
  );
  if (
    report.status === "fail" ||
    (report.status === "unavailable" &&
      args.requireLive)
  ) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
