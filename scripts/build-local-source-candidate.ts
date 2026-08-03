import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CertificationManifestSchema,
} from "../lib/rosterpilot/certification";
import {
  buildRuntimeDataBundle,
} from "../lib/rosterpilot/runtime-data-bundle";
import {
  writeLocalSourceBundleArtifacts,
} from "../local/data-bundles/local-source-candidate";

export const BUILD_LOCAL_SOURCE_CANDIDATE_USAGE = `Usage: node --import tsx scripts/build-local-source-candidate.ts --out-dir <path> [options]

Build an unsigned, content-addressed runtime candidate from the exact sources
installed in this isolated staging project. The durable local build receipt is
added only after the caller completes validation and certification.

Options:
  --out-dir <path>       Empty candidate artifact directory.
  --created-at <instant> Override the manifest creation time.
  -h, --help             Show this help.
`;

export type BuildLocalSourceCandidateArgs = {
  help: boolean;
  outDirectory: string | null;
  createdAt: string | null;
};

export class BuildLocalSourceCandidateUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildLocalSourceCandidateUsageError";
  }
}

function requiredValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new BuildLocalSourceCandidateUsageError(
      `${option} requires a value.`,
    );
  }
  return value;
}

export function parseBuildLocalSourceCandidateArgs(
  argv: readonly string[],
): BuildLocalSourceCandidateArgs {
  const parsed: BuildLocalSourceCandidateArgs = {
    help: false,
    outDirectory: null,
    createdAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--out-dir") {
      parsed.outDirectory = requiredValue(argv, index, argument);
      index += 1;
    } else if (argument === "--created-at") {
      parsed.createdAt = requiredValue(argv, index, argument);
      index += 1;
    } else {
      throw new BuildLocalSourceCandidateUsageError(
        `Unknown local-source candidate option: ${argument}.`,
      );
    }
  }
  if (!parsed.help && !parsed.outDirectory) {
    throw new BuildLocalSourceCandidateUsageError(
      "--out-dir is required.",
    );
  }
  if (
    parsed.createdAt &&
    Number.isNaN(new Date(parsed.createdAt).getTime())
  ) {
    throw new BuildLocalSourceCandidateUsageError(
      "--created-at must be an ISO date-time.",
    );
  }
  return parsed;
}

export async function runBuildLocalSourceCandidateCli(
  argv: readonly string[],
  options: {
    root?: string;
    writeOutput?: (value: string) => void;
  } = {},
): Promise<void> {
  const args = parseBuildLocalSourceCandidateArgs(argv);
  const writeOutput =
    options.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (args.help) {
    writeOutput(BUILD_LOCAL_SOURCE_CANDIDATE_USAGE);
    return;
  }
  const root = options.root ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const certification = CertificationManifestSchema.parse(
    JSON.parse(
      await readFile(
        path.join(root, "data", "certification-manifest.json"),
        "utf8",
      ),
    ) as unknown,
  );
  const build = await buildRuntimeDataBundle({
    certification,
    createdAt: args.createdAt ?? new Date().toISOString(),
  });
  const result = await writeLocalSourceBundleArtifacts(
    build,
    path.resolve(root, args.outDirectory!),
  );
  writeOutput(
    `${JSON.stringify({
      ok: true,
      bundleId: result.bundleId,
      manifestPath: result.manifestPath,
    })}\n`,
  );
}

async function main(): Promise<void> {
  try {
    await runBuildLocalSourceCandidateCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof BuildLocalSourceCandidateUsageError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write(BUILD_LOCAL_SOURCE_CANDIDATE_USAGE);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
