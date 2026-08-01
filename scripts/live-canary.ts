import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LIVE_CANARY_IDS,
  liveCanaryDefinition,
  type LiveCanaryId,
  type LiveCanaryCatalogueDriftMode,
} from "../local/certification/live-canaries";
import {
  runRotatingLiveCanary,
  writeRotatingLiveCanaryReport,
} from "../local/certification/live-canary-runner";
import {
  getConfiguredDataBundleProvider,
} from "../lib/rosterpilot";
import {
  initializeLocalDataBundleProvider,
} from "../local/data-bundles/configure";

type ParsedArguments = {
  canaryId: LiveCanaryId | null;
  outputDirectory: string;
  profilePolicyPath: string | undefined;
  maxWaitMs: number | undefined;
  pollMs: number | undefined;
  forcedClientTimeoutMs: number | undefined;
  expectedBundleId: string | undefined;
  catalogueDriftMode: LiveCanaryCatalogueDriftMode;
  requireLive: boolean;
  help: boolean;
};

type ReleaseEvidenceBinding =
  | {
      kind: "bundle-bound";
      expectedBundleId: string;
    }
  | {
      kind: "ad-hoc";
      expectedBundleId: null;
    };

type LiveCanaryReport = Awaited<
  ReturnType<typeof runRotatingLiveCanary>
> & {
  releaseEvidence: ReleaseEvidenceBinding;
};

type DataBundlePreflightFailure = {
  code:
    | "LIVE_CANARY_RELEASE_BUNDLE_REQUIRED"
    | "LIVE_CANARY_DATA_PROVIDER_UNAVAILABLE"
    | "LIVE_CANARY_DATA_BUNDLE_REFRESH_FAILED"
    | "LIVE_CANARY_DATA_BUNDLE_MISMATCH"
    | "LIVE_CANARY_DATA_BUNDLE_LEASE_FAILED";
  message: string;
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
  --expected-bundle-id <sha256>     Require and freeze this activated bundle.
  --verified-catalogue-drift-diagnostic
                                      Explicitly allow only verified forward game-system-revision drift.
  --require-live                    Require bundle-bound live release evidence.
  --help                            Show this help.

The runner also accepts ROSTERPILOT_CERTIFICATION_PROFILE_POLICY_PATH.
The uploaded multi-profile canary additionally requires:
  ROSTERPILOT_CANARY_MULTIPROFILE_ROSZ_PATH
  ROSTERPILOT_CANARY_MULTIPROFILE_CONTEXT_PATH
  ROSTERPILOT_CANARY_PLAYER_ROSTER_PATH
  ROSTERPILOT_CANARY_REVISED_ROSTER_PATH
`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unknown data-bundle preflight failure.";
}

function releaseEvidenceBinding(
  args: ParsedArguments,
): ReleaseEvidenceBinding {
  return args.requireLive && args.expectedBundleId
    ? {
        kind: "bundle-bound",
        expectedBundleId: args.expectedBundleId,
      }
    : {
        kind: "ad-hoc",
        expectedBundleId: null,
      };
}

function bindReleaseEvidence(
  report: Awaited<
    ReturnType<typeof runRotatingLiveCanary>
  >,
  args: ParsedArguments,
): LiveCanaryReport {
  return Object.assign(report, {
    releaseEvidence: releaseEvidenceBinding(args),
  });
}

async function unavailablePreflightReport(input: {
  args: ParsedArguments;
  canaryOutput: string;
  failure: DataBundlePreflightFailure;
}): Promise<LiveCanaryReport> {
  const report = await runRotatingLiveCanary({
    canaryId: input.args.canaryId!,
    outputDirectory: input.canaryOutput,
    profilePolicyPath: input.args.profilePolicyPath,
    maxWaitMs: input.args.maxWaitMs,
    pollMs: input.args.pollMs,
    forcedClientTimeoutMs:
      input.args.forcedClientTimeoutMs,
    catalogueDriftMode: input.args.catalogueDriftMode,
    // Force readiness to stop before any external connector mutation. The
    // report is then specialized with the exact data preflight failure below.
    environment: {
      ...process.env,
      ROSTERPILOT_CERTIFICATION_LIVE: "0",
    },
  });
  report.status = "unavailable";
  report.livePass = false;
  report.evidenceKind = "none";
  report.failure = input.failure;
  report.assertions = report.assertions.map((assertion) => ({
    ...assertion,
    status: "not-run",
    evidence: null,
  }));
  report.run = null;
  report.revision = null;
  report.limitations = [
    ...report.limitations,
    "Release evidence was not captured because exact signed data-bundle preflight did not complete.",
  ];
  return bindReleaseEvidence(report, input.args);
}

async function writeReportAndSummary(input: {
  report: LiveCanaryReport;
  canaryOutput: string;
}): Promise<void> {
  const written = await writeRotatingLiveCanaryReport(
    input.report,
    input.canaryOutput,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        canaryId: input.report.canary.id,
        status: input.report.status,
        livePass: input.report.livePass,
        releaseEvidence: input.report.releaseEvidence,
        unavailableReasons:
          input.report.readiness.reasons.map(
            (reason) => reason.code,
          ),
        failure: input.report.failure,
        runId: input.report.run?.runId ?? null,
        reportPath: written.reportPath,
        checksumPath: written.checksumPath,
        reportSha256: written.sha256,
      },
      null,
      2,
    )}\n`,
  );
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
  let expectedBundleId: string | undefined;
  let catalogueDriftMode: LiveCanaryCatalogueDriftMode =
    "reject";
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
    } else if (token === "--expected-bundle-id") {
      const value = next();
      if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(
          "--expected-bundle-id requires a lowercase SHA-256 bundle ID.",
        );
      }
      expectedBundleId = value;
    } else if (token === "--require-live") {
      requireLive = true;
    } else if (
      token ===
      "--verified-catalogue-drift-diagnostic"
    ) {
      catalogueDriftMode = "diagnostic";
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
    expectedBundleId,
    catalogueDriftMode,
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
  if (args.requireLive && !args.expectedBundleId) {
    const report = await unavailablePreflightReport({
      args,
      canaryOutput,
      failure: {
        code: "LIVE_CANARY_RELEASE_BUNDLE_REQUIRED",
        message:
          "--require-live requires --expected-bundle-id so release evidence is bound to one exact signed bundle.",
      },
    });
    await writeReportAndSummary({ report, canaryOutput });
    process.exitCode = 2;
    return;
  }
  const initialization =
    await initializeLocalDataBundleProvider();
  const provider = getConfiguredDataBundleProvider();
  let preflightFailure: DataBundlePreflightFailure | null =
    null;
  if (args.expectedBundleId && !provider) {
    preflightFailure = {
      code: "LIVE_CANARY_DATA_PROVIDER_UNAVAILABLE",
      message:
        initialization.reason ??
        "The expected signed data bundle cannot be activated because no trusted local data-bundle provider is configured.",
    };
  }
  if (args.expectedBundleId && provider) {
    try {
      await provider.refresh({ force: true });
    } catch (error) {
      preflightFailure = {
        code: "LIVE_CANARY_DATA_BUNDLE_REFRESH_FAILED",
        message: errorMessage(error),
      };
    }
    if (!preflightFailure) {
      try {
        const status = await provider.getStatus();
        if (status.activeBundleId !== args.expectedBundleId) {
          preflightFailure = {
            code: "LIVE_CANARY_DATA_BUNDLE_MISMATCH",
            message:
              `Expected activated data bundle ${args.expectedBundleId}, ` +
              `but the provider is using ${status.activeBundleId}.`,
          };
        }
      } catch (error) {
        preflightFailure = {
          code: "LIVE_CANARY_DATA_PROVIDER_UNAVAILABLE",
          message: errorMessage(error),
        };
      }
    }
  }
  let lease: Awaited<
    ReturnType<NonNullable<typeof provider>["acquireSnapshot"]>
  > | null = null;
  if (provider && !preflightFailure) {
    try {
      lease = await provider.acquireSnapshot({
        ...(args.expectedBundleId
          ? { bundleId: args.expectedBundleId }
          : {}),
      });
    } catch (error) {
      preflightFailure = {
        code: "LIVE_CANARY_DATA_BUNDLE_LEASE_FAILED",
        message: errorMessage(error),
      };
    }
  }
  if (preflightFailure) {
    const report = await unavailablePreflightReport({
      args,
      canaryOutput,
      failure: preflightFailure,
    });
    await writeReportAndSummary({ report, canaryOutput });
    process.exitCode = 2;
    return;
  }
  let report: LiveCanaryReport;
  try {
    report = bindReleaseEvidence(
      await runRotatingLiveCanary({
        canaryId: args.canaryId,
        outputDirectory: canaryOutput,
        profilePolicyPath: args.profilePolicyPath,
        maxWaitMs: args.maxWaitMs,
        pollMs: args.pollMs,
        forcedClientTimeoutMs:
          args.forcedClientTimeoutMs,
        expectedBundleId: args.expectedBundleId,
        catalogueDriftMode: args.catalogueDriftMode,
      }),
      args,
    );
  } finally {
    await lease?.release();
  }
  await writeReportAndSummary({ report, canaryOutput });
  if (
    report.status === "fail" ||
    (report.status === "unavailable" &&
      args.requireLive)
  ) {
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
