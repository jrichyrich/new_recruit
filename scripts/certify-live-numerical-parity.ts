import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createLiveNumericalParityCertification,
  writeLiveNumericalParityCertification,
} from "../local/certification/live-numerical-parity";

type Arguments = {
  comparisonPath: string | null;
  reportsRoot: string | null;
  rotationId: string | null;
  expectedBundleId: string | null;
  expectedGitHead: string | null;
  outputPath: string;
  overwrite: boolean;
  help: boolean;
};

export function liveNumericalParityHelp(): string {
  return `RosterPilot live local-engine / Tessera Web numerical parity gate

Usage:
  npm run certify:provider-parity -- \\
    --comparison exports/tessera/parity/tessera-provider-parity.json \\
    --reports-root .certification/downloaded-paired-reports \\
    [--rotation-id <workflow-rotation-id>] \\
    [--expected-bundle-id <64-character-bundle-id>] \\
    [--expected-git-head <40-character-commit>] \\
    [--out .certification/provider-parity/live-numerical-parity.json] \\
    [--overwrite]

The comparison JSON must have its detached SHA-256 checksum and must
reference both exact matchup reports and their receipts. Use --reports-root
after downloading CI artifacts; reports are relocated by their bound SHA-256,
run ID, and provider, and duplicate matches are rejected. A pass requires real
production execution from both providers, a verified signed data bundle,
complete Web deployment/import/state evidence, all four canonical metrics at
98% or better, no cell beyond twice tolerance, and canonical-winner agreement
outside uncertainty. Fixture-only evidence is ineligible, never live.
`;
}

function value(argv: string[], index: number, option: string): string {
  const result = argv[index + 1];
  if (!result || result.startsWith("--")) {
    throw new Error(`${option} requires a path.`);
  }
  return result;
}

export function parseLiveNumericalParityArguments(
  argv: string[],
): Arguments {
  const result: Arguments = {
    comparisonPath: null,
    reportsRoot: null,
    rotationId: null,
    expectedBundleId: null,
    expectedGitHead: null,
    outputPath: path.join(
      ".certification",
      "provider-parity",
      "live-numerical-parity.json",
    ),
    overwrite: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else if (argument === "--comparison") {
      result.comparisonPath = value(argv, index, argument);
      index += 1;
    } else if (argument === "--out") {
      result.outputPath = value(argv, index, argument);
      index += 1;
    } else if (argument === "--reports-root") {
      result.reportsRoot = value(argv, index, argument);
      index += 1;
    } else if (argument === "--expected-bundle-id") {
      result.expectedBundleId = value(argv, index, argument);
      index += 1;
    } else if (argument === "--rotation-id") {
      result.rotationId = value(argv, index, argument);
      index += 1;
    } else if (argument === "--expected-git-head") {
      result.expectedGitHead = value(argv, index, argument);
      index += 1;
    } else if (argument === "--overwrite") {
      result.overwrite = true;
    } else {
      throw new Error(`Unknown live numerical parity option "${argument}".`);
    }
  }
  return result;
}

export async function runLiveNumericalParityCli(
  argv = process.argv.slice(2),
): Promise<number> {
  const args = parseLiveNumericalParityArguments(argv);
  if (args.help) {
    process.stdout.write(liveNumericalParityHelp());
    return 0;
  }
  if (!args.comparisonPath) {
    throw new Error("Live numerical parity requires --comparison <path>.");
  }
  if (!args.reportsRoot) {
    throw new Error("Live numerical parity requires --reports-root <path>.");
  }
  const artifact = await createLiveNumericalParityCertification({
    comparisonPath: args.comparisonPath,
    reportsRoot: args.reportsRoot,
    ...(args.rotationId ? { rotationId: args.rotationId } : {}),
    ...(args.expectedBundleId
      ? { expectedBundleId: args.expectedBundleId }
      : {}),
    ...(args.expectedGitHead
      ? { expectedGitHead: args.expectedGitHead }
      : {}),
  });
  const written = await writeLiveNumericalParityCertification(
    artifact,
    args.outputPath,
    { overwrite: args.overwrite },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        status: artifact.evaluation.status,
        rotationId: artifact.rotationId,
        eligible: artifact.evaluation.eligible,
        complete: artifact.evaluation.complete,
        liveEvidence: artifact.evaluation.liveEvidence,
        parityOutcome: artifact.evaluation.parityOutcome,
        releaseBinding: artifact.releaseBinding,
        everyMetricAtLeast98Percent:
          artifact.evaluation.everyMetricAtLeast98Percent,
        beyondDoubleToleranceCellCount:
          artifact.evaluation.beyondDoubleToleranceCellCount,
        canonicalWinnerAgreementOutsideUncertainty:
          artifact.evaluation
            .canonicalWinnerAgreementOutsideUncertainty,
        reportPath: written.reportPath,
        checksumPath: written.checksumPath,
        sha256: written.sha256,
        reasons: artifact.evaluation.reasons,
      },
      null,
      2,
    )}\n`,
  );
  return artifact.evaluation.status === "pass" ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runLiveNumericalParityCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
