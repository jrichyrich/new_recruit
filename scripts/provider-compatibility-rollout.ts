import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  providerCompatibilityRolloutExitCode,
  runProviderCompatibilityRollout,
} from "../local/certification/provider-compatibility-rollout-artifact";

type ParsedArguments = {
  reportsRoot: string;
  outputPath: string;
  enforcementLatchActive: boolean;
  help: boolean;
};

export function providerCompatibilityRolloutHelp(): string {
  return `RosterPilot provider compatibility rollout gate

Usage:
  npm run certify:provider-compatibility -- [options]

Options:
  --reports-root <path>  Recursively read live-canary and retained rollout artifacts.
  --out <path>           Atomically write the rollout JSON artifact and detached checksum.
  --enforcement-latch <observe|enforce>
                         Apply the durable repository latch. Once the repository
                         tag exists, callers must pass enforce.
  --help                 Show this help.

Defaults:
  --reports-root .certification/live-canaries
  --out .certification/provider-compatibility/provider-compatibility-rollout.json

The command remains observational until three consecutive complete rotations
pass across every rotating live canary. Once enforcement is active, exit code
2 blocks a release when the latest rotation fails or is unavailable. Invalid,
unverified, or conflicting evidence fails closed as an operational error. The
live workflow stores activation in the repository tag
rosterpilot-provider-compatibility-enforced-v1; pass --enforcement-latch
enforce whenever that tag exists, even if retained artifacts have expired.
`;
}

export function parseProviderCompatibilityRolloutArguments(
  argv: readonly string[],
): ParsedArguments {
  let reportsRoot = path.resolve(
    ".certification",
    "live-canaries",
  );
  let outputPath = path.resolve(
    ".certification",
    "provider-compatibility",
    "provider-compatibility-rollout.json",
  );
  let enforcementLatchActive = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") {
      help = true;
      continue;
    }
    if (
      token !== "--reports-root" &&
      token !== "--out" &&
      token !== "--enforcement-latch"
    ) {
      throw new Error(
        `Unknown provider compatibility rollout option: ${token}.`,
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} requires a path.`);
    }
    if (token === "--reports-root") {
      reportsRoot = path.resolve(value);
    } else if (token === "--out") {
      outputPath = path.resolve(value);
    } else if (value === "enforce") {
      enforcementLatchActive = true;
    } else if (value !== "observe") {
      throw new Error(
        "--enforcement-latch must be observe or enforce.",
      );
    }
    index += 1;
  }
  return {
    reportsRoot,
    outputPath,
    enforcementLatchActive,
    help,
  };
}

export async function runProviderCompatibilityRolloutCli(
  argv: readonly string[],
): Promise<number> {
  const args = parseProviderCompatibilityRolloutArguments(argv);
  if (args.help) {
    process.stdout.write(providerCompatibilityRolloutHelp());
    return 0;
  }
  const written = await runProviderCompatibilityRollout({
    reportsRoot: args.reportsRoot,
    outputPath: args.outputPath,
    enforcementLatchActive: args.enforcementLatchActive,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        reportPath: written.reportPath,
        checksumPath: written.checksumPath,
        reportSha256: written.sha256,
        reportId: written.artifact.reportId,
        observations:
          written.artifact.evaluation.acceptedObservationCount,
        consecutivePasses:
          written.artifact.evaluation.consecutivePasses,
        enforcementActive:
          written.artifact.evaluation.enforcementActive,
        enforcementLatchActive:
          written.artifact.evaluation.enforcementLatchActive,
        latestStatus:
          written.artifact.evaluation.latestStatus,
        releaseGate:
          written.artifact.evaluation.releaseGate,
        reasons: written.artifact.evaluation.reasons,
      },
      null,
      2,
    )}\n`,
  );
  return providerCompatibilityRolloutExitCode(
    written.artifact.evaluation,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  try {
    process.exitCode = await runProviderCompatibilityRolloutCli(
      process.argv.slice(2),
    );
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : "Unknown provider compatibility rollout failure."
      }\n`,
    );
    process.exitCode = 1;
  }
}
