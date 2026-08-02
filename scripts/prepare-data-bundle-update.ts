import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkDataFreshness,
  type LiveDataFreshness,
} from "../lib/rosterpilot";
import {
  canonicalJson,
  type DataBundleDeltaClassification,
  type DataBundleDeltaResult,
} from "../lib/rosterpilot/semantic-hash";
import {
  DataBundleManifestV1Schema,
  dataBundleSemanticIdentitySha256,
  verifyDataBundleQuarantineRecord,
} from "../lib/rosterpilot/data-bundle";
import {
  dataBundleSignerFromEnvironment,
  trustedPublisherKeys,
} from "./build-data-bundle";
import {
  nextSourceManifest,
  type SourceManifest,
} from "./prepare-data-update";

type CommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
) => void;

type PrepareArgs = {
  help: boolean;
  outDir: string;
  channel: string;
  publicBaseUrl: string | null;
  previousManifest: string | null;
  officialReconciliationEvidence: string | null;
  officialSourceArtifact: string | null;
  officialLegendSourceArtifacts: Record<string, string>;
  officialExtractionReceipt: string | null;
  officialExtractorTrustedKeys: string;
  officialAuthorityUnavailableReason: string | null;
  reviewPackageDir: string | null;
  skipRefresh: boolean;
};

type CandidateBuildSummary = {
  bundleId: string;
  manifestPath: string;
  channelPath: string;
  classification:
    | DataBundleDeltaClassification
    | "bootstrap";
  affectedFactions: string[];
  retainedFactions: string[];
};

type UpdateReport = {
  schemaVersion: 1;
  candidateBundleId: string;
  delta: DataBundleDeltaResult | null;
  composition?: {
    retainedShards: Array<{
      shardId: string;
    }>;
  } | null;
};

type PublishedBundleIdentity = {
  schemaVersion: number;
  engineDataSchemaVersion: number;
  bundleId: string;
  provenance: unknown;
  semanticHashes: unknown;
  shards: Array<{
    shardId: string;
    [key: string]: unknown;
  }>;
  composition?: {
    retainedShards: Array<{
      shardId: string;
    }>;
  } | null;
};

export type DataBundleValidationPlan = {
  runDataCheck: boolean;
  syncCertificationManifest: boolean;
  certificationFactions: string[];
  fullCertification: boolean;
  includePortfolio: boolean;
};

export const PREPARE_DATA_BUNDLE_USAGE = `Usage: npm run data:prepare-update -- [options]

Stage the latest source data outside the checkout, classify semantic changes,
certify only the affected scope, and publish a signed immutable data bundle.
No package pin, generated catalogue, source manifest, or certification policy
file in the checkout is rewritten.

Options:
  --out-dir <path>             Output root (default: dist/data-channel).
  --channel <name>             Signed channel name (default: stable).
  --manifest-base-url <url>    Public root containing bundles/ and channels/.
  --previous-manifest <path>   Currently published manifest for comparison.
  --official-reconciliation-evidence <path>
                               Official rules overlay for a changed MFM.
  --official-source-artifact <path>
                               Exact source bytes covered by that overlay.
  --official-legend-source-artifact <source-id=path>
                               Exact faction-pack bytes for a schema-v2
                               Legends source. Repeat once per source id.
  --official-extraction-receipt <path>
                               Reviewed extractor's signed inventory receipt.
  --official-extractor-trusted-keys <path>
                               Reviewed extractor public-key registry (default:
                               data/official-extractor-trusted-keys.json).
  --official-authority-unavailable <reason>
                               Explicit degraded authority for a genesis
                               channel with no prior verified binding.
  --review-package-dir <path>  Preserve a hash-inventoried certification review
                               package when expert review blocks publication.
  --no-refresh                 Bundle the current checkout without live checks.
  -h, --help                   Show help without checking or changing data.

Signing is accepted only through ROSTERPILOT_DATA_SIGNING_KEY_ID and
ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK. The private key is never written to the
staging tree or output bundle.
`;

export class PrepareDataBundleCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrepareDataBundleCliUsageError";
  }
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson<T>(filename: string): T {
  return JSON.parse(readFileSync(filename, "utf8")) as T;
}

/**
 * Manifest creation time, bundle ID, and signature do not change the effective
 * runtime bundle. Exact upstream provenance, semantic inventory, full shard
 * descriptors, and partial-roll-forward evidence do: retaining byte-level
 * content hashes prevents equal gameplay hashes from hiding newly verified
 * official authority or certification evidence. The source updater avoids
 * changing checkedAt/releaseId for a repeated observation, so this exact
 * projection still suppresses daily no-op channel churn.
 */
function sameEffectiveBundle(
  left: PublishedBundleIdentity,
  right: PublishedBundleIdentity,
): boolean {
  const projection = (manifest: PublishedBundleIdentity) => ({
    schemaVersion: manifest.schemaVersion,
    engineDataSchemaVersion: manifest.engineDataSchemaVersion,
    provenance: manifest.provenance,
    semanticHashes: manifest.semanticHashes,
    composition: manifest.composition ?? null,
    shards: [...manifest.shards].sort((first, second) =>
      first.shardId.localeCompare(second.shardId),
    ),
  });
  return (
    canonicalJson(projection(left)) ===
    canonicalJson(projection(right))
  );
}

function retainedFactionIds(
  manifest: PublishedBundleIdentity,
): string[] {
  return [
    ...new Set(
      (manifest.composition?.retainedShards ?? []).map((entry) =>
        entry.shardId.replace(/^faction:/, ""),
      ),
    ),
  ].sort();
}

function requiredValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new PrepareDataBundleCliUsageError(
      `${option} requires a value.`,
    );
  }
  return value;
}

function assignKeyedPath(
  target: Record<string, string>,
  raw: string,
  option: string,
): void {
  const separator = raw.indexOf("=");
  const sourceId = raw.slice(0, separator).trim();
  const filename = raw.slice(separator + 1).trim();
  if (separator <= 0 || !sourceId || !filename) {
    throw new PrepareDataBundleCliUsageError(
      `${option} requires <source-id=path>.`,
    );
  }
  if (Object.hasOwn(target, sourceId)) {
    throw new PrepareDataBundleCliUsageError(
      `${option} repeats source id ${sourceId}.`,
    );
  }
  Object.defineProperty(target, sourceId, {
    configurable: true,
    enumerable: true,
    value: filename,
    writable: true,
  });
}

export function parsePrepareDataBundleArgs(
  argv: readonly string[],
): PrepareArgs {
  const parsed: PrepareArgs = {
    help: false,
    outDir: "dist/data-channel",
    channel: "stable",
    publicBaseUrl: null,
    previousManifest: null,
    officialReconciliationEvidence: null,
    officialSourceArtifact: null,
    officialLegendSourceArtifacts: {},
    officialExtractionReceipt: null,
    officialExtractorTrustedKeys:
      "data/official-extractor-trusted-keys.json",
    officialAuthorityUnavailableReason: null,
    reviewPackageDir: null,
    skipRefresh: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--out-dir") {
      parsed.outDir = requiredValue(argv, index, argument);
      index += 1;
    } else if (argument === "--channel") {
      parsed.channel = requiredValue(argv, index, argument);
      index += 1;
    } else if (argument === "--manifest-base-url") {
      parsed.publicBaseUrl = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--previous-manifest") {
      parsed.previousManifest = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (
      argument === "--official-reconciliation-evidence"
    ) {
      parsed.officialReconciliationEvidence = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--official-source-artifact") {
      parsed.officialSourceArtifact = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (
      argument === "--official-legend-source-artifact"
    ) {
      assignKeyedPath(
        parsed.officialLegendSourceArtifacts,
        requiredValue(argv, index, argument),
        argument,
      );
      index += 1;
    } else if (argument === "--official-extraction-receipt") {
      parsed.officialExtractionReceipt = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (
      argument === "--official-extractor-trusted-keys"
    ) {
      parsed.officialExtractorTrustedKeys = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--official-authority-unavailable") {
      parsed.officialAuthorityUnavailableReason = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--review-package-dir") {
      parsed.reviewPackageDir = requiredValue(
        argv,
        index,
        argument,
      );
      index += 1;
    } else if (argument === "--no-refresh") {
      parsed.skipRefresh = true;
    } else {
      throw new PrepareDataBundleCliUsageError(
        `Unknown data-bundle update option: ${argument}`,
      );
    }
  }
  return parsed;
}

function resolvedPath(root: string, candidate: string): string {
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(root, candidate);
}

function defaultCommandRunner(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): void {
  execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
}

function environmentWithoutSigningKey(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const safe = { ...environment };
  delete safe.ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK;
  delete safe.ROSTERPILOT_DATA_SIGNING_KEY_ID;
  return safe;
}

async function assertCandidateIsNotLiveQuarantined(input: {
  root: string;
  outputRoot: string;
  manifestPath: string;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  const quarantineDirectory = path.join(
    input.outputRoot,
    "quarantines",
  );
  if (!existsSync(quarantineDirectory)) return;
  const candidate = DataBundleManifestV1Schema.parse(
    readJson<unknown>(input.manifestPath),
  );
  const candidateSemanticIdentity =
    await dataBundleSemanticIdentitySha256(candidate);
  const signer = dataBundleSignerFromEnvironment(
    input.environment,
  );
  const trustedKeys = trustedPublisherKeys(
    input.root,
    null,
    signer,
  );
  for (const entry of readdirSync(quarantineDirectory, {
    withFileTypes: true,
  })) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !entry.name.endsWith(".json")
    ) {
      throw new Error(
        `The signed data-channel quarantine directory contains an unexpected entry: ${entry.name}.`,
      );
    }
    const filename = path.join(
      quarantineDirectory,
      entry.name,
    );
    const quarantine =
      await verifyDataBundleQuarantineRecord(
        readJson<unknown>(filename),
        trustedKeys,
      );
    if (!quarantine.ok) {
      throw new Error(
        `Signed data-channel quarantine verification failed for ${filename}: ${quarantine.message}`,
      );
    }
    if (
      quarantine.data.semanticIdentitySha256 ===
      candidateSemanticIdentity
    ) {
      throw new Error(
        `Candidate bundle semantics remain quarantined by failed post-activation live canary evidence for ${quarantine.data.bundleId}.`,
      );
    }
  }
}

function copyStagingProject(
  sourceRoot: string,
  stagingRoot: string,
): void {
  for (const directory of ["data", "lib", "local", "scripts"]) {
    cpSync(
      path.join(sourceRoot, directory),
      path.join(stagingRoot, directory),
      { recursive: true },
    );
  }
  for (const filename of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]) {
    copyFileSync(
      path.join(sourceRoot, filename),
      path.join(stagingRoot, filename),
    );
  }
}

function stageCandidateSources(
  root: string,
  stagingRoot: string,
  next: SourceManifest,
  run: CommandRunner,
  environment: NodeJS.ProcessEnv,
): void {
  mkdirSync(stagingRoot, { recursive: true });
  copyStagingProject(root, stagingRoot);
  run(
    "npm",
    [
      "install",
      `${next.rules.package}@${next.rules.version}`,
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: stagingRoot, env: environment },
  );
  writeFileSync(
    path.join(stagingRoot, "data", "sources.json"),
    stableJson(next),
  );
  run(
    process.execPath,
    ["--import", "tsx", "scripts/sync-bsdata.ts", "--write"],
    { cwd: stagingRoot, env: environment },
  );
}

export function validationPlanForDelta(
  delta: DataBundleDeltaResult | null,
): DataBundleValidationPlan {
  if (!delta) {
    return {
      runDataCheck: true,
      syncCertificationManifest: true,
      certificationFactions: [],
      fullCertification: true,
      includePortfolio: true,
    };
  }
  if (delta.quarantine) {
    throw new Error(
      `A quarantined data bundle cannot be certified: ${delta.reasons.join(" ")}`,
    );
  }
  if (delta.classification === "provenance-only") {
    return {
      runDataCheck: false,
      syncCertificationManifest: false,
      certificationFactions: [],
      fullCertification: false,
      includePortfolio: false,
    };
  }
  if (delta.classification === "methodology/global") {
    return {
      runDataCheck: true,
      syncCertificationManifest: true,
      certificationFactions: [],
      fullCertification: true,
      includePortfolio: true,
    };
  }
  return {
    runDataCheck: true,
    syncCertificationManifest: true,
    certificationFactions: [...delta.affectedFactions],
    fullCertification: false,
    includePortfolio: delta.classification === "rules",
  };
}

function buildCandidate(
  root: string,
  outputRoot: string,
  options: {
    channel: string;
    publicBaseUrl: string;
    previousManifest: string | null;
    officialReconciliationEvidence: string | null;
    officialSourceArtifact?: string | null;
    officialLegendSourceArtifacts?: Readonly<Record<string, string>>;
    officialExtractionReceipt?: string | null;
    officialExtractorTrustedKeys?: string | null;
    officialAuthorityUnavailableReason?: string | null;
    createdAt: string;
    environment: NodeJS.ProcessEnv;
    run: CommandRunner;
    retainFactions?: readonly string[];
    previousBundleDirectory?: string | null;
    quarantineReason?: string | null;
    trustedKeys?: string | null;
  },
): CandidateBuildSummary {
  const args = [
    "--import",
    "tsx",
    "scripts/build-data-bundle.ts",
    "--out-dir",
    outputRoot,
    "--channel",
    options.channel,
    "--manifest-base-url",
    options.publicBaseUrl,
    "--created-at",
    options.createdAt,
  ];
  if (options.previousManifest) {
    args.push(
      "--previous-manifest",
      options.previousManifest,
    );
    const previousChannelPointer = path.resolve(
      path.dirname(options.previousManifest),
      "..",
      "..",
      "channels",
      `${options.channel}.json`,
    );
    if (existsSync(previousChannelPointer)) {
      args.push(
        "--previous-channel-pointer",
        previousChannelPointer,
      );
    }
  }
  if (options.retainFactions?.length) {
    args.push(
      "--retain-factions",
      [...options.retainFactions].sort().join(","),
    );
    if (options.previousBundleDirectory) {
      args.push(
        "--previous-bundle-dir",
        options.previousBundleDirectory,
      );
    }
    if (options.quarantineReason) {
      args.push(
        "--quarantine-reason",
        options.quarantineReason,
      );
    }
    if (options.trustedKeys) {
      args.push("--trusted-keys", options.trustedKeys);
    }
  }
  if (options.officialReconciliationEvidence) {
    args.push(
      "--official-reconciliation-evidence",
      options.officialReconciliationEvidence,
    );
    if (
      !options.officialSourceArtifact ||
      !options.officialExtractionReceipt ||
      !options.officialExtractorTrustedKeys
    ) {
      throw new Error(
        "Official publication requires a source artifact, signed extraction receipt, and reviewed extractor trust registry.",
      );
    }
    args.push(
      "--official-source-artifact",
      options.officialSourceArtifact,
      "--official-extraction-receipt",
      options.officialExtractionReceipt,
      "--official-extractor-trusted-keys",
      options.officialExtractorTrustedKeys,
    );
    for (const [sourceId, artifactPath] of Object.entries(
      options.officialLegendSourceArtifacts ?? {},
    ).sort(([left], [right]) => left.localeCompare(right))) {
      args.push(
        "--official-legend-source-artifact",
        `${sourceId}=${artifactPath}`,
      );
    }
  }
  if (options.officialAuthorityUnavailableReason) {
    args.push(
      "--official-authority-unavailable",
      options.officialAuthorityUnavailableReason,
    );
  }
  const summaryPath = path.join(
    outputRoot,
    "channels",
    `${options.channel}.update.json`,
  );
  options.run(process.execPath, args, {
    cwd: root,
    env: options.environment,
  });
  const report = readJson<UpdateReport>(summaryPath);
  const manifestPath = path.join(
    outputRoot,
    "bundles",
    report.candidateBundleId,
    "manifest.json",
  );
  const manifest = readJson<{
    shards: Array<{
      shardId: string;
      factionIds: string[];
    }>;
    composition?: {
      retainedShards: Array<{ shardId: string }>;
    };
  }>(manifestPath);
  const retainedShardIds = new Set(
    manifest.composition?.retainedShards.map(
      (entry) => entry.shardId,
    ) ?? [],
  );
  return {
    bundleId: report.candidateBundleId,
    manifestPath,
    channelPath: path.join(
      outputRoot,
      "channels",
      `${options.channel}.json`,
    ),
    classification:
      report.delta?.classification ?? "bootstrap",
    affectedFactions:
      report.delta?.affectedFactions ?? [],
    retainedFactions: manifest.shards
      .filter((entry) =>
        retainedShardIds.has(entry.shardId),
      )
      .flatMap((entry) => entry.factionIds)
      .sort(),
  };
}

type CandidateCertificationResult = {
  failedFactions: Array<{
    factionId: string;
    reason: string;
  }>;
};

type PartialRollForwardIdentity = {
  engineDataSchemaVersion: number;
  semanticHashes: {
    globalHash: string;
    methodologyHash: string;
  };
};

export function partialRollForwardBlockReason(
  previous: PartialRollForwardIdentity,
  candidate: PartialRollForwardIdentity,
): string | null {
  if (
    previous.engineDataSchemaVersion !==
    candidate.engineDataSchemaVersion
  ) {
    return "the engine data schema changed";
  }
  if (
    previous.semanticHashes.globalHash !==
    candidate.semanticHashes.globalHash
  ) {
    return "the global shard semantics changed";
  }
  if (
    previous.semanticHashes.methodologyHash !==
    candidate.semanticHashes.methodologyHash
  ) {
    return "the certification methodology changed";
  }
  return null;
}

function sha256File(filename: string): string {
  return createHash("sha256")
    .update(readFileSync(filename))
    .digest("hex");
}

function packageFileInventory(
  root: string,
  directory: string = root,
): Array<{ path: string; sha256: string }> {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return packageFileInventory(root, filename);
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `Certification review package contains an unsupported entry: ${filename}.`,
        );
      }
      return [{
        path: path.relative(root, filename).split(path.sep).join("/"),
        sha256: sha256File(filename),
      }];
    });
}

export type CertificationReviewPackageInput = {
  outputDirectory: string;
  candidateRoot: string;
  candidateManifestPath: string;
  candidateUpdateReportPath: string;
  candidate: CandidateBuildSummary;
  certification: CandidateCertificationResult;
  createdAt: string;
};

export function writeCertificationReviewPackage(
  input: CertificationReviewPackageInput,
): string {
  if (
    existsSync(input.outputDirectory) &&
    readdirSync(input.outputDirectory).length > 0
  ) {
    throw new Error(
      `Certification review package directory is not empty: ${input.outputDirectory}.`,
    );
  }
  mkdirSync(input.outputDirectory, { recursive: true });
  const candidateDirectory = path.join(
    input.outputDirectory,
    "candidate",
  );
  mkdirSync(candidateDirectory, { recursive: true });
  copyFileSync(
    input.candidateManifestPath,
    path.join(candidateDirectory, "manifest.json"),
  );
  copyFileSync(
    input.candidateUpdateReportPath,
    path.join(candidateDirectory, "update-report.json"),
  );
  copyFileSync(
    path.join(
      input.candidateRoot,
      "data",
      "certification-manifest.json",
    ),
    path.join(
      input.outputDirectory,
      "certification-manifest.pending.json",
    ),
  );
  const reportsDirectory = path.join(
    input.candidateRoot,
    ".certification-data-bundle",
  );
  if (!existsSync(reportsDirectory)) {
    throw new Error(
      "Certification review was requested, but no certification reports were produced.",
    );
  }
  cpSync(
    reportsDirectory,
    path.join(input.outputDirectory, "reports"),
    { recursive: true },
  );
  const failedFactions = input.certification.failedFactions
    .map((entry) => entry.factionId)
    .sort();
  writeFileSync(
    path.join(input.outputDirectory, "README.md"),
    [
      "# RosterPilot certification review package",
      "",
      `Candidate bundle: \`${input.candidate.bundleId}\``,
      `Classification: \`${input.candidate.classification}\``,
      `Generated: \`${input.createdAt}\``,
      "",
      "This package is evidence for human review. It is not an approval and cannot publish a data channel.",
      "",
      "Review each affected faction report, especially the `CERTIFICATION_EXPERT_REVIEW_PENDING` case, its exact `reviewBinding`, semantic evidence, draft assertions, mapping baseline, representative builds, and canonical ROSZ results. An authorized Warhammer reviewer may then copy the accepted binding into the reviewed certification manifest in a separate pull request, set `status` to `reviewed`, update `reviewedAt`, and remove any invalidation reason.",
      "",
      "After that review PR passes `npm run certify:manifest:check` and deterministic certification, rerun the normal Roster data freshness workflow. Never edit this package to make it look approved.",
      "",
      `Review-blocked factions (${failedFactions.length}):`,
      "",
      ...failedFactions.map((factionId) => `- \`${factionId}\``),
      "",
    ].join("\n"),
  );
  const files = packageFileInventory(input.outputDirectory);
  const packagePath = path.join(
    input.outputDirectory,
    "review-package.json",
  );
  writeFileSync(
    packagePath,
    stableJson({
      schemaVersion: 1,
      packageKind: "rosterpilot-certification-review",
      createdAt: input.createdAt,
      status: "review-required",
      candidate: {
        bundleId: input.candidate.bundleId,
        classification: input.candidate.classification,
        affectedFactions: [...input.candidate.affectedFactions].sort(),
      },
      failedFactions: input.certification.failedFactions
        .map((entry) => ({
          factionId: entry.factionId,
          reason: entry.reason.split(input.candidateRoot).join("<candidate>"),
        }))
        .sort((left, right) =>
          left.factionId.localeCompare(right.factionId),
        ),
      files,
    }),
  );
  return packagePath;
}

function certifyCandidate(
  root: string,
  plan: DataBundleValidationPlan,
  run: CommandRunner,
  environment: NodeJS.ProcessEnv,
): CandidateCertificationResult {
  run("npm", ["run", "data:sync-check"], {
    cwd: root,
    env: environment,
  });
  const failedFactions:
    CandidateCertificationResult["failedFactions"] = [];
  if (plan.runDataCheck) {
    try {
      run("npm", ["run", "data:check"], {
        cwd: root,
        env: environment,
      });
    } catch (error) {
      if (plan.fullCertification) throw error;
      const reason =
        error instanceof Error
          ? error.message
          : String(error);
      for (const factionId of plan.certificationFactions) {
        failedFactions.push({
          factionId,
          reason:
            `Affected-scope data acceptance failed: ${reason}`,
        });
      }
    }
  }
  if (plan.syncCertificationManifest) {
    run("npm", ["run", "certify:manifest:sync"], {
      cwd: root,
      env: environment,
    });
    run("npm", ["run", "certify:manifest:check"], {
      cwd: root,
      env: environment,
    });
  }
  const outDir = path.join(
    root,
    ".certification-data-bundle",
  );
  if (plan.fullCertification) {
    try {
      run(
        "npm",
        [
          "run",
          "certify",
          "--",
          "--tier",
          "deterministic",
          "--portfolio",
          "--require-status",
          "pass",
          "--out-dir",
          outDir,
        ],
        { cwd: root, env: environment },
      );
      return { failedFactions: [] };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      const manifest = readJson<{
        factions: Array<{ id: string }>;
      }>(path.join(root, "data", "certification-manifest.json"));
      return {
        failedFactions: manifest.factions
          .map((faction) => ({
            factionId: faction.id,
            reason,
          }))
          .sort((left, right) =>
            left.factionId.localeCompare(right.factionId),
          ),
      };
    }
  }
  for (const factionId of plan.certificationFactions) {
    try {
      const certificationArguments = [
        "run",
        "certify",
        "--",
        "--tier",
        "deterministic",
        ...(plan.includePortfolio ? ["--portfolio"] : []),
        "--require-status",
        "pass",
        "--faction",
        factionId,
        "--out-dir",
        path.join(outDir, factionId),
      ];
      run(
        "npm",
        certificationArguments,
        { cwd: root, env: environment },
      );
    } catch (error) {
      if (
        !failedFactions.some(
          (entry) => entry.factionId === factionId,
        )
      ) {
        failedFactions.push({
          factionId,
          reason:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    }
  }
  return { failedFactions };
}

function copyImmutableTree(
  source: string,
  destination: string,
): void {
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source, {
    withFileTypes: true,
  })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyImmutableTree(from, to);
      continue;
    }
    mkdirSync(path.dirname(to), { recursive: true });
    if (existsSync(to)) {
      if (
        readFileSync(from, "utf8") !== readFileSync(to, "utf8")
      ) {
        throw new Error(
          `Content-addressed bundle collision at ${to}.`,
        );
      }
      continue;
    }
    copyFileSync(from, to);
  }
}

function replaceFileAtomically(
  source: string,
  destination: string,
): void {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.next-${process.pid}`;
  copyFileSync(source, temporary);
  renameSync(temporary, destination);
}

export function promoteDataChannelAtomically(
  candidateOutputRoot: string,
  destinationOutputRoot: string,
  channel: string,
): void {
  copyImmutableTree(
    path.join(candidateOutputRoot, "bundles"),
    path.join(destinationOutputRoot, "bundles"),
  );
  const candidateChannels = path.join(
    candidateOutputRoot,
    "channels",
  );
  const destinationChannels = path.join(
    destinationOutputRoot,
    "channels",
  );
  copyImmutableTree(
    path.join(candidateChannels, channel),
    path.join(destinationChannels, channel),
  );
  replaceFileAtomically(
    path.join(candidateChannels, `${channel}.update.json`),
    path.join(destinationChannels, `${channel}.update.json`),
  );
  // Channel pointer is the commit record and therefore moves last.
  replaceFileAtomically(
    path.join(candidateChannels, `${channel}.json`),
    path.join(destinationChannels, `${channel}.json`),
  );
}

async function resolveFreshness(
  supplied: LiveDataFreshness | undefined,
): Promise<LiveDataFreshness> {
  if (supplied) return supplied;
  const result = await checkDataFreshness({
    timeoutMs: 15_000,
  });
  if (!result.data || result.data.state === "unknown") {
    throw new Error(
      `Cannot prepare a partial data bundle: ${
        result.warnings
          .map((warning) => warning.message)
          .join(" ") || "live source freshness is unknown"
      }`,
    );
  }
  return result.data;
}

export async function prepareDataBundleUpdate(
  options: {
    root?: string;
    outputRoot: string;
    channel: string;
    publicBaseUrl: string;
    previousManifest?: string | null;
    officialReconciliationEvidence?: string | null;
    officialSourceArtifact?: string | null;
    officialLegendSourceArtifacts?: Readonly<Record<string, string>>;
    officialExtractionReceipt?: string | null;
    officialExtractorTrustedKeys?: string | null;
    officialAuthorityUnavailableReason?: string | null;
    reviewPackageDirectory?: string | null;
    skipRefresh?: boolean;
    freshness?: LiveDataFreshness;
    environment?: NodeJS.ProcessEnv;
    run?: CommandRunner;
    now?: () => string;
  },
): Promise<{
  changed: boolean;
  sourceChanged: boolean;
  previousReleaseId: string;
  releaseId: string;
  bundleId: string;
  classification:
    | DataBundleDeltaClassification
    | "bootstrap";
  affectedFactions: string[];
  quarantinedFactions: string[];
  outputRoot: string;
}> {
  const root = options.root ?? projectRoot;
  const run = options.run ?? defaultCommandRunner;
  const environment = options.environment ?? process.env;
  const validationEnvironment =
    environmentWithoutSigningKey(environment);
  const hasAnyOfficialEvidence = Boolean(
    options.officialReconciliationEvidence ||
      options.officialSourceArtifact ||
      options.officialExtractionReceipt ||
      Object.keys(options.officialLegendSourceArtifacts ?? {})
        .length > 0,
  );
  const hasCompleteOfficialEvidence = Boolean(
    options.officialReconciliationEvidence &&
      options.officialSourceArtifact &&
      options.officialExtractionReceipt,
  );
  if (hasAnyOfficialEvidence && !hasCompleteOfficialEvidence) {
    throw new Error(
      "Official publication requires an overlay, the exact source artifact, and a signed reviewed-extractor receipt together.",
    );
  }
  if (
    hasAnyOfficialEvidence &&
    options.officialAuthorityUnavailableReason
  ) {
    throw new Error(
      "Official extraction evidence and an unavailable-authority reason are mutually exclusive.",
    );
  }
  if (
    !options.previousManifest &&
    !hasCompleteOfficialEvidence &&
    !options.officialAuthorityUnavailableReason
  ) {
    throw new Error(
      "The first stable-channel publication requires reviewed official evidence or --official-authority-unavailable with a reviewable reason.",
    );
  }
  const createdAt =
    options.now?.() ?? new Date().toISOString();
  const source = readJson<SourceManifest>(
    path.join(root, "data", "sources.json"),
  );
  const freshness = options.skipRefresh
    ? null
    : await resolveFreshness(options.freshness);
  const refreshedSource = freshness
    ? nextSourceManifest(source, freshness)
    : source;
  const sourceChanged =
    canonicalJson(refreshedSource) !== canonicalJson(source);
  const next = sourceChanged ? refreshedSource : source;
  const stagingParent = mkdtempSync(
    path.join(os.tmpdir(), "rosterpilot-bundle-update-"),
  );
  const stagingRoot = path.join(stagingParent, "candidate");
  const preflightOutput = path.join(
    stagingParent,
    "preflight-output",
  );
  const finalOutput = path.join(stagingParent, "final-output");
  const baselineOutput = path.join(
    stagingParent,
    "baseline-output",
  );
  try {
    const candidateRoot = sourceChanged ? stagingRoot : root;
    const officialSourceArtifact = options.officialSourceArtifact
      ? resolvedPath(root, options.officialSourceArtifact)
      : null;
    const officialLegendSourceArtifacts = Object.fromEntries(
      Object.entries(
        options.officialLegendSourceArtifacts ?? {},
      ).map(([sourceId, artifactPath]) => [
        sourceId,
        resolvedPath(root, artifactPath),
      ]),
    );
    const officialExtractionReceipt = options.officialExtractionReceipt
      ? resolvedPath(root, options.officialExtractionReceipt)
      : null;
    const officialExtractorTrustedKeys = resolvedPath(
      root,
      options.officialExtractorTrustedKeys ??
        "data/official-extractor-trusted-keys.json",
    );
    if (sourceChanged) {
      stageCandidateSources(
        root,
        stagingRoot,
        next,
        run,
        validationEnvironment,
      );
    }

    let previousManifest = options.previousManifest
      ? resolvedPath(root, options.previousManifest)
      : null;
    if (!previousManifest) {
      const baseline = buildCandidate(root, baselineOutput, {
        channel: options.channel,
        publicBaseUrl: options.publicBaseUrl,
        previousManifest: null,
        officialReconciliationEvidence: null,
        officialAuthorityUnavailableReason:
          options.officialAuthorityUnavailableReason ??
          "Internal comparison baseline; not a published authority root.",
        createdAt,
        environment,
        run,
      });
      previousManifest = baseline.manifestPath;
    }

    const preflightCandidate = buildCandidate(
      candidateRoot,
      preflightOutput,
      {
        channel: options.channel,
        publicBaseUrl: options.publicBaseUrl,
        previousManifest,
        officialReconciliationEvidence:
          options.officialReconciliationEvidence
            ? resolvedPath(
                root,
                options.officialReconciliationEvidence,
              )
            : null,
        officialSourceArtifact,
        officialLegendSourceArtifacts,
        officialExtractionReceipt,
        officialExtractorTrustedKeys,
        officialAuthorityUnavailableReason:
          options.officialAuthorityUnavailableReason,
        createdAt,
        environment,
        run,
      },
    );
    const previousPublished =
      readJson<PublishedBundleIdentity>(previousManifest);
    const preflightPublished =
      readJson<PublishedBundleIdentity>(
        preflightCandidate.manifestPath,
      );
    const preflightReport = readJson<UpdateReport>(
      path.join(
        preflightOutput,
        "channels",
        `${options.channel}.update.json`,
      ),
    );
    await assertCandidateIsNotLiveQuarantined({
      root,
      outputRoot: options.outputRoot,
      manifestPath: preflightCandidate.manifestPath,
      environment,
    });
    if (
      sameEffectiveBundle(
        previousPublished,
        preflightPublished,
      )
    ) {
      return {
        changed: false,
        sourceChanged,
        previousReleaseId: source.releaseId,
        releaseId: next.releaseId,
        bundleId: previousPublished.bundleId,
        classification:
          preflightReport.delta?.classification ??
          "provenance-only",
        affectedFactions:
          preflightReport.delta?.affectedFactions ?? [],
        quarantinedFactions:
          retainedFactionIds(previousPublished),
        outputRoot: options.outputRoot,
      };
    }
    const initialPlan = validationPlanForDelta(
      preflightReport.delta,
    );

    // Semantic identity is known before any certification policy file is
    // synchronized. Provenance-only candidates intentionally skip that churn.
    if (initialPlan.syncCertificationManifest) {
      run("npm", ["run", "certify:manifest:sync"], {
        cwd: candidateRoot,
        env: validationEnvironment,
      });
      run("npm", ["run", "certify:manifest:check"], {
        cwd: candidateRoot,
        env: validationEnvironment,
      });
    }
    let finalCandidate = buildCandidate(
      candidateRoot,
      finalOutput,
      {
        channel: options.channel,
        publicBaseUrl: options.publicBaseUrl,
        previousManifest,
        officialReconciliationEvidence:
          options.officialReconciliationEvidence
            ? resolvedPath(
                root,
                options.officialReconciliationEvidence,
              )
            : null,
        officialSourceArtifact,
        officialLegendSourceArtifacts,
        officialExtractionReceipt,
        officialExtractorTrustedKeys,
        officialAuthorityUnavailableReason:
          options.officialAuthorityUnavailableReason,
        createdAt,
        environment,
        run,
      },
    );
    const finalReport = readJson<UpdateReport>(
      path.join(
        finalOutput,
        "channels",
        `${options.channel}.update.json`,
      ),
    );
    const finalPlan = validationPlanForDelta(finalReport.delta);
    const certification = certifyCandidate(
      candidateRoot,
      {
        ...finalPlan,
        // The stage was already synchronized before its final signed build.
        syncCertificationManifest: false,
      },
      run,
      validationEnvironment,
    );
    let promotionOutput = finalOutput;
    if (certification.failedFactions.length > 0) {
      const reviewPackagePath = options.reviewPackageDirectory
        ? writeCertificationReviewPackage({
            outputDirectory: options.reviewPackageDirectory,
            candidateRoot,
            candidateManifestPath: finalCandidate.manifestPath,
            candidateUpdateReportPath: path.join(
              finalOutput,
              "channels",
              `${options.channel}.update.json`,
            ),
            candidate: finalCandidate,
            certification,
            createdAt,
          })
        : null;
      const partialBlockReason = partialRollForwardBlockReason(
        readJson<PartialRollForwardIdentity>(previousManifest),
        readJson<PartialRollForwardIdentity>(
          finalCandidate.manifestPath,
        ),
      );
      if (partialBlockReason) {
        throw new Error(
          `Certification review is required and partial roll-forward is unsafe because ${partialBlockReason}. No signed channel was promoted.${
            reviewPackagePath
              ? ` Review package: ${reviewPackagePath}.`
              : " Run again with --review-package-dir to preserve the exact review evidence."
          }`,
        );
      }
      const partialOutput = path.join(
        stagingParent,
        "partial-output",
      );
      const failedFactionIds = certification.failedFactions
        .map((entry) => entry.factionId)
        .sort();
      const quarantineReason = (
        "Affected-scope deterministic certification failed: " +
        certification.failedFactions
          .map(
            (entry) =>
              `${entry.factionId}: ${entry.reason}`,
          )
          .join("; ")
      ).slice(0, 3_900);
      finalCandidate = buildCandidate(
        candidateRoot,
        partialOutput,
        {
          channel: options.channel,
          publicBaseUrl: options.publicBaseUrl,
          previousManifest,
          previousBundleDirectory:
            path.dirname(previousManifest),
          retainFactions: failedFactionIds,
          quarantineReason,
          trustedKeys: path.join(
            root,
            "data",
            "data-bundle-trusted-keys.json",
          ),
          officialReconciliationEvidence:
            options.officialReconciliationEvidence
              ? resolvedPath(
                  root,
                  options.officialReconciliationEvidence,
                )
              : null,
          officialSourceArtifact,
          officialLegendSourceArtifacts,
          officialExtractionReceipt,
          officialExtractorTrustedKeys,
          officialAuthorityUnavailableReason:
            options.officialAuthorityUnavailableReason,
          createdAt,
          environment,
          run,
        },
      );
      if (finalCandidate.retainedFactions.length === 0) {
        throw new Error(
          "The partial data-bundle publisher did not produce signed retained-shard lineage.",
        );
      }
      promotionOutput = partialOutput;
    }
    promoteDataChannelAtomically(
      promotionOutput,
      options.outputRoot,
      options.channel,
    );
    return {
      changed:
        finalCandidate.bundleId !==
        readJson<{ bundleId: string }>(previousManifest).bundleId,
      sourceChanged,
      previousReleaseId: source.releaseId,
      releaseId: next.releaseId,
      bundleId: finalCandidate.bundleId,
      classification: finalCandidate.classification,
      affectedFactions: finalCandidate.affectedFactions,
      quarantinedFactions:
        finalCandidate.retainedFactions,
      outputRoot: options.outputRoot,
    };
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

export async function runPrepareDataBundleCli(
  argv: readonly string[],
  options: {
    root?: string;
    environment?: NodeJS.ProcessEnv;
    freshness?: LiveDataFreshness;
    run?: CommandRunner;
    writeOutput?: (value: string) => void;
    now?: () => string;
  } = {},
): Promise<void> {
  const args = parsePrepareDataBundleArgs(argv);
  const writeOutput =
    options.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (args.help) {
    writeOutput(PREPARE_DATA_BUNDLE_USAGE);
    return;
  }
  const root = options.root ?? projectRoot;
  const environment = options.environment ?? process.env;
  const publicBaseUrl =
    args.publicBaseUrl ??
    environment.ROSTERPILOT_DATA_BUNDLE_BASE_URL;
  if (!publicBaseUrl) {
    throw new Error(
      "Set --manifest-base-url or ROSTERPILOT_DATA_BUNDLE_BASE_URL before publishing a signed data bundle.",
    );
  }
  const result = await prepareDataBundleUpdate({
    root,
    outputRoot: resolvedPath(root, args.outDir),
    channel: args.channel,
    publicBaseUrl,
    previousManifest: args.previousManifest,
    officialReconciliationEvidence:
      args.officialReconciliationEvidence,
    officialSourceArtifact: args.officialSourceArtifact,
    officialLegendSourceArtifacts:
      args.officialLegendSourceArtifacts,
    officialExtractionReceipt: args.officialExtractionReceipt,
    officialExtractorTrustedKeys:
      args.officialExtractorTrustedKeys,
    officialAuthorityUnavailableReason:
      args.officialAuthorityUnavailableReason,
    reviewPackageDirectory: args.reviewPackageDir
      ? resolvedPath(root, args.reviewPackageDir)
      : null,
    skipRefresh: args.skipRefresh,
    freshness: options.freshness,
    environment,
    run: options.run,
    now: options.now,
  });
  writeOutput(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

async function main(): Promise<void> {
  try {
    await runPrepareDataBundleCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof PrepareDataBundleCliUsageError) {
      process.stderr.write(
        `${error.message}\nRun with --help for usage.\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
