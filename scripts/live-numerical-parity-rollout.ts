import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  liveNumericalParityRolloutExitCode,
  runLiveNumericalParityRollout,
} from "../local/certification/live-numerical-parity-rollout-artifact";
import {
  LIVE_NUMERICAL_PARITY_ENFORCEMENT_ENV,
  LIVE_NUMERICAL_PARITY_ENFORCEMENT_TAG,
} from "../local/certification/live-numerical-parity-rollout";

type Arguments = {
  reportsRoot: string;
  outputPath: string;
  enforcementLatchActive: boolean;
  currentRotationId: string | null;
  help: boolean;
};

export function liveNumericalParityRolloutHelp(): string {
  return `RosterPilot live numerical parity observe-then-enforce rollout

Usage:
  npm run certify:provider-parity-rollout -- [options]

Options:
  --reports-root <path>  Recursively verify live parity certificates and retained rollout artifacts.
  --out <path>           Write the canonical rollout JSON and detached checksum.
  --enforcement-latch <observe|enforce>
                         Pass enforce whenever the durable repository tag exists.
  --current-rotation-id <id>
                         Require a certificate from this exact workflow rotation.
  --help                 Show this help.

Defaults:
  --reports-root .certification/provider-parity
  --out .certification/provider-parity/live-numerical-parity-rollout.json

Three consecutive checksum-verified live pass certificates activate
enforcement. Unavailable evidence does not advance or reset the observation
streak; an available fail, incomplete, or ineligible certificate resets it.
Before activation, observe and pass return exit code 0. Once enforcement is
active, missing or current non-pass evidence returns exit code 2 and blocks a
release. Invalid or conflicting artifacts are operational errors (exit 1).

Durable tag: ${LIVE_NUMERICAL_PARITY_ENFORCEMENT_TAG}
Runtime env: ${LIVE_NUMERICAL_PARITY_ENFORCEMENT_ENV}=true
`;
}

export function parseLiveNumericalParityRolloutArguments(
  argv: readonly string[],
): Arguments {
  let reportsRoot = path.resolve(
    ".certification",
    "provider-parity",
  );
  let outputPath = path.resolve(
    ".certification",
    "provider-parity",
    "live-numerical-parity-rollout.json",
  );
  let enforcementLatchActive = false;
  let currentRotationId: string | null = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (
      token !== "--reports-root" &&
      token !== "--out" &&
      token !== "--enforcement-latch" &&
      token !== "--current-rotation-id"
    ) {
      throw new Error(
        `Unknown live numerical parity rollout option: ${token}.`,
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} requires a value.`);
    }
    if (token === "--reports-root") {
      reportsRoot = path.resolve(value);
    } else if (token === "--out") {
      outputPath = path.resolve(value);
    } else if (token === "--current-rotation-id") {
      currentRotationId = value.trim();
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
    currentRotationId,
    help,
  };
}

export async function runLiveNumericalParityRolloutCli(
  argv: readonly string[],
): Promise<number> {
  const args = parseLiveNumericalParityRolloutArguments(argv);
  if (args.help) {
    process.stdout.write(liveNumericalParityRolloutHelp());
    return 0;
  }
  const written = await runLiveNumericalParityRollout({
    reportsRoot: args.reportsRoot,
    outputPath: args.outputPath,
    enforcementLatchActive: args.enforcementLatchActive,
    currentRotationId: args.currentRotationId,
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
        requiredCurrentRotationId:
          written.artifact.evaluation.requiredCurrentRotationId,
        latestRotationId:
          written.artifact.evaluation.latestRotationId,
        latestStatus: written.artifact.evaluation.latestStatus,
        releaseGate: written.artifact.evaluation.releaseGate,
        reasons: written.artifact.evaluation.reasons,
      },
      null,
      2,
    )}\n`,
  );
  return liveNumericalParityRolloutExitCode(
    written.artifact.evaluation,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  try {
    process.exitCode = await runLiveNumericalParityRolloutCli(
      process.argv.slice(2),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
