import crypto from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";
import {
  LIVE_CANARY_IDS,
  type LiveCanaryId,
} from "./live-canaries";
import {
  evaluateProviderCompatibilityRollout,
  type ProviderCompatibilityCanaryObservation,
  type ProviderCompatibilityRolloutEvaluation,
  type ProviderCompatibilityRotationObservation,
} from "./provider-compatibility-rollout";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REPORT_BYTES = 16 * 1_024 * 1_024;
const MAX_CHECKSUM_BYTES = 512;
const REQUIRED_CONSECUTIVE_PASSES = 3;

const TimestampSchema = z.string().refine(
  (value) => value.length > 0 && !Number.isNaN(Date.parse(value)),
  "Expected an ISO-compatible timestamp.",
);

const ProviderEnvelopeSummarySchema = z
  .object({
    provider: z.enum(["local-engine", "website"]),
    envelopeSha256: z.string().regex(SHA256_PATTERN),
    bundleId: z.string().regex(SHA256_PATTERN),
    signingKeyId: z.string().min(1).nullable(),
    manifestSha256: z.string().regex(SHA256_PATTERN).nullable(),
    semanticIdentitySha256: z
      .string()
      .regex(SHA256_PATTERN)
      .nullable(),
    bundleTrustIdentitySha256: z.string().regex(SHA256_PATTERN),
    complete: z.boolean(),
    issueCodes: z.array(z.string().min(1)),
  })
  .strict();

const ProviderCompatibilitySummarySchema = z
  .object({
    policy: z.literal("observe-then-enforce-v1"),
    requiredConsecutivePasses: z.literal(3),
    mode: z.enum(["observe", "enforce"]),
    rotationId: z.string().trim().min(1),
    status: z.enum(["pass", "fail", "unavailable"]),
    complete: z.boolean(),
    envelopes: z.array(ProviderEnvelopeSummarySchema),
  })
  .strict();

const DataBundleSummarySchema = z
  .object({
    bundleId: z.string().regex(SHA256_PATTERN),
    signingKeyId: z.string().min(1),
    manifestSha256: z.string().regex(SHA256_PATTERN),
    semanticIdentitySha256: z.string().regex(SHA256_PATTERN),
    bundleTrustIdentitySha256: z
      .string()
      .regex(SHA256_PATTERN)
      .nullable(),
  })
  .strict();

/**
 * The live-canary report has a large independently validated payload. This
 * schema is strict at its boundary and fully validates every field consumed
 * by this rollout command; unrelated known fields remain opaque here.
 */
const RotatingLiveCanaryRolloutSchema = z
  .object({
    schemaVersion: z.literal(1),
    reportKind: z.literal("rosterpilot-rotating-live-canary"),
    reportId: z.string().min(1),
    canary: z
      .object({ id: z.enum(LIVE_CANARY_IDS) })
      .passthrough(),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
    status: z.enum(["pass", "fail", "unavailable"]),
    livePass: z.boolean(),
    evidenceKind: z.enum(["live", "none"]),
    readiness: z.unknown(),
    runtime: z.unknown(),
    dataBundle: DataBundleSummarySchema.nullable(),
    providerCompatibility: ProviderCompatibilitySummarySchema,
    localAgent: z.unknown(),
    profilePolicy: z.unknown(),
    fixtureInputs: z.unknown(),
    assertions: z.unknown(),
    run: z.unknown(),
    providerParity: z.unknown().nullable().optional(),
    revision: z.unknown(),
    failure: z.unknown(),
    limitations: z.unknown(),
    releaseEvidence: z.unknown().optional(),
  })
  .strict();

const CanaryObservationSchema = z
  .object({
    canaryId: z.string().min(1),
    status: z.enum(["pass", "fail", "unavailable"]),
    compatibilityComplete: z.boolean(),
    envelopeSha256: z
      .string()
      .regex(SHA256_PATTERN)
      .nullable(),
  })
  .strict();

const RotationObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    observationKind: z.literal(
      "provider-compatibility-rotation",
    ),
    rotationId: z.string().trim().min(1),
    observedAt: TimestampSchema,
    bundleId: z.string().regex(SHA256_PATTERN),
    bundleTrustIdentitySha256: z.string().regex(SHA256_PATTERN),
    providerCompatibilityMode: z.enum(["observe", "enforce"]),
    canaries: z.array(CanaryObservationSchema),
  })
  .strict();

const RolloutEvaluationSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluationKind: z.literal(
      "provider-compatibility-rollout",
    ),
    requiredConsecutivePasses: z.number().int().positive(),
    requiredCanaryIds: z.array(z.string().min(1)),
    acceptedObservationCount: z.number().int().nonnegative(),
    consecutivePasses: z.number().int().nonnegative(),
    enforcementLatchActive: z.boolean(),
    enforcementActivatedAtRotationId: z.string().min(1).nullable(),
    enforcementActive: z.boolean(),
    latestRotationId: z.string().min(1).nullable(),
    latestProviderCompatibilityMode: z
      .enum(["observe", "enforce"])
      .nullable(),
    latestStatus: z.enum([
      "pass",
      "fail",
      "unavailable",
      "missing",
    ]),
    releaseGate: z.enum(["observe", "pass", "block"]),
    reasons: z.array(z.string()),
  })
  .strict();

const ProviderCompatibilityRolloutArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    reportKind: z.literal(
      "rosterpilot-provider-compatibility-rollout",
    ),
    reportId: z.string().regex(SHA256_PATTERN),
    generatedAt: TimestampSchema,
    observations: z.array(RotationObservationSchema),
    evaluation: RolloutEvaluationSchema,
  })
  .strict();

type ParsedLiveCanary = z.infer<
  typeof RotatingLiveCanaryRolloutSchema
>;

export type ProviderCompatibilityRolloutArtifact = {
  schemaVersion: 1;
  reportKind: "rosterpilot-provider-compatibility-rollout";
  reportId: string;
  generatedAt: string;
  observations: ProviderCompatibilityRotationObservation[];
  evaluation: ProviderCompatibilityRolloutEvaluation;
};

export type WrittenProviderCompatibilityRolloutArtifact = {
  artifact: ProviderCompatibilityRolloutArtifact;
  reportPath: string;
  checksumPath: string;
  sha256: string;
};

type VerifiedArtifact = {
  filename: string;
  sha256: string;
  value: unknown;
};

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function artifactReportId(input: {
  observations: ProviderCompatibilityRotationObservation[];
  evaluation: ProviderCompatibilityRolloutEvaluation;
}): string {
  return sha256(canonicalJson(input));
}

function observationOrder(
  left: ProviderCompatibilityRotationObservation,
  right: ProviderCompatibilityRotationObservation,
): number {
  return (
    Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
    left.rotationId.localeCompare(right.rotationId)
  );
}

function sortedObservations(
  observations: readonly ProviderCompatibilityRotationObservation[],
): ProviderCompatibilityRotationObservation[] {
  return [...observations].sort(observationOrder);
}

function assertCanonicalArtifact(
  artifact: ProviderCompatibilityRolloutArtifact,
  filename: string,
): void {
  const rotationIds = new Set(
    artifact.observations.map(
      (observation) => observation.rotationId,
    ),
  );
  if (rotationIds.size !== artifact.observations.length) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": retained observations repeat a rotation identity.`,
    );
  }
  const expectedObservations = sortedObservations(
    artifact.observations,
  );
  if (
    canonicalJson(expectedObservations) !==
    canonicalJson(artifact.observations)
  ) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": observations are not in canonical chronological order.`,
    );
  }
  const expectedEvaluation =
    evaluateProviderCompatibilityRollout({
      observations: artifact.observations,
      requiredCanaryIds: LIVE_CANARY_IDS,
      requiredConsecutivePasses: REQUIRED_CONSECUTIVE_PASSES,
      enforcementLatchActive:
        artifact.evaluation.enforcementLatchActive,
    });
  if (
    canonicalJson(expectedEvaluation) !==
    canonicalJson(artifact.evaluation)
  ) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": its retained evaluation does not match its observations.`,
    );
  }
  const expectedReportId = artifactReportId({
    observations: artifact.observations,
    evaluation: artifact.evaluation,
  });
  if (artifact.reportId !== expectedReportId) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": its reportId does not match its canonical retained state.`,
    );
  }
}

async function regularArtifactFiles(
  directory: string,
): Promise<string[]> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Provider compatibility reports root must be a real directory: ${directory}.`,
    );
  }
  const files: string[] = [];
  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Provider compatibility evidence cannot contain a symbolic link: ${filename}.`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await regularArtifactFiles(filename)));
    } else if (
      entry.isFile() &&
      (entry.name.startsWith("live-canary-") ||
        entry.name.startsWith(
          "provider-compatibility-rollout",
        )) &&
      entry.name.endsWith(".json")
    ) {
      files.push(filename);
    }
  }
  return files.sort();
}

async function verifiedArtifact(
  filename: string,
): Promise<VerifiedArtifact> {
  const checksumFilename = `${filename}.sha256`;
  let reportMetadata;
  let checksumMetadata;
  try {
    [reportMetadata, checksumMetadata] = await Promise.all([
      lstat(filename),
      lstat(checksumFilename),
    ]);
  } catch (error) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": its detached checksum is missing or unreadable.`,
      { cause: error },
    );
  }
  if (
    !reportMetadata.isFile() ||
    reportMetadata.isSymbolicLink() ||
    reportMetadata.size > MAX_REPORT_BYTES
  ) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": the report is not a bounded regular file.`,
    );
  }
  if (
    !checksumMetadata.isFile() ||
    checksumMetadata.isSymbolicLink() ||
    checksumMetadata.size > MAX_CHECKSUM_BYTES
  ) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": its detached checksum is not a bounded regular file.`,
    );
  }
  const [content, checksumContent] = await Promise.all([
    readFile(filename),
    readFile(checksumFilename, "utf8"),
  ]);
  const checksum = checksumContent.match(
    /^([a-f0-9]{64})  ([^/\\\r\n]+)\n$/,
  );
  if (!checksum || checksum[2] !== path.basename(filename)) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": its detached checksum is malformed or names another file.`,
    );
  }
  const actualSha256 = sha256(content);
  if (actualSha256 !== checksum[1]) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": its bytes do not match the detached checksum.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": the checksum-verified report is not valid JSON.`,
      { cause: error },
    );
  }
  return { filename, sha256: actualSha256, value };
}

function combinedCanaryStatus(
  report: ParsedLiveCanary,
): ProviderCompatibilityCanaryObservation["status"] {
  if (
    report.status === "fail" ||
    report.providerCompatibility.status === "fail"
  ) {
    return "fail";
  }
  if (
    report.status === "unavailable" ||
    report.providerCompatibility.status === "unavailable"
  ) {
    return "unavailable";
  }
  return "pass";
}

function validateLiveCanaryConsistency(
  report: ParsedLiveCanary,
  filename: string,
): void {
  const compatibility = report.providerCompatibility;
  if (!report.dataBundle) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": provider compatibility evidence is not bound to a signed data bundle.`,
    );
  }
  const bundleTrustIdentity =
    report.dataBundle.bundleTrustIdentitySha256;
  const envelopeBundleBindingComplete =
    bundleTrustIdentity !== null &&
    compatibility.envelopes.length > 0 &&
    compatibility.envelopes.every(
      (envelope) =>
        envelope.bundleId === report.dataBundle!.bundleId &&
        envelope.signingKeyId === report.dataBundle!.signingKeyId &&
        envelope.manifestSha256 ===
          report.dataBundle!.manifestSha256 &&
        envelope.semanticIdentitySha256 ===
          report.dataBundle!.semanticIdentitySha256 &&
        envelope.bundleTrustIdentitySha256 === bundleTrustIdentity,
    );
  const envelopeComplete =
    compatibility.envelopes.length > 0 &&
    compatibility.envelopes.every((envelope) => envelope.complete) &&
    envelopeBundleBindingComplete;
  const expectedCompatibilityStatus =
    compatibility.envelopes.length === 0
      ? "unavailable"
      : envelopeComplete
        ? "pass"
        : "fail";
  if (
    compatibility.complete !== envelopeComplete ||
    compatibility.status !== expectedCompatibilityStatus
  ) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": provider compatibility status is inconsistent with its envelopes.`,
    );
  }
  if (
    report.status === "pass" &&
    (!report.livePass || report.evidenceKind !== "live")
  ) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": a passing live canary lacks live-pass evidence.`,
    );
  }
  if (
    report.status === "unavailable" &&
    (report.livePass || report.evidenceKind !== "none")
  ) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": unavailable canary evidence is internally inconsistent.`,
    );
  }
  if (
    compatibility.mode === "enforce" &&
    report.status === "pass" &&
    (!envelopeBundleBindingComplete || !compatibility.complete)
  ) {
    throw new Error(
      `Provider compatibility rollout rejected "${filename}": an enforced passing canary is not bound to complete verified signed-bundle trust and update evidence.`,
    );
  }
}

function canaryObservation(
  report: ParsedLiveCanary,
): ProviderCompatibilityCanaryObservation {
  const status = combinedCanaryStatus(report);
  const compatibilityComplete =
    status === "pass" &&
    report.livePass &&
    report.evidenceKind === "live" &&
    report.providerCompatibility.complete;
  const envelopes = [...report.providerCompatibility.envelopes].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.envelopeSha256.localeCompare(right.envelopeSha256),
  );
  return {
    canaryId: report.canary.id,
    status,
    compatibilityComplete,
    envelopeSha256: compatibilityComplete
      ? sha256(canonicalJson(envelopes))
      : null,
  };
}

function observationsFromCanaries(
  reports: Array<{
    filename: string;
    report: ParsedLiveCanary;
  }>,
): ProviderCompatibilityRotationObservation[] {
  const rotations = new Map<
    string,
    Array<{ filename: string; report: ParsedLiveCanary }>
  >();
  for (const entry of reports) {
    const rotationId =
      entry.report.providerCompatibility.rotationId;
    const grouped = rotations.get(rotationId) ?? [];
    grouped.push(entry);
    rotations.set(rotationId, grouped);
  }

  const observations: ProviderCompatibilityRotationObservation[] = [];
  for (const [rotationId, entries] of rotations) {
    const byCanary = new Map<LiveCanaryId, ParsedLiveCanary>();
    const bundleIds = new Set<string>();
    const bundleTrustIdentities = new Set<string>();
    const providerCompatibilityModes = new Set<"observe" | "enforce">();
    for (const { filename, report } of entries) {
      validateLiveCanaryConsistency(report, filename);
      if (byCanary.has(report.canary.id)) {
        throw new Error(
          `Provider compatibility rollout rejected rotation "${rotationId}": canary ${report.canary.id} appears more than once.`,
        );
      }
      byCanary.set(report.canary.id, report);
      bundleIds.add(report.dataBundle!.bundleId);
      providerCompatibilityModes.add(
        report.providerCompatibility.mode,
      );
      if (report.dataBundle!.bundleTrustIdentitySha256) {
        bundleTrustIdentities.add(
          report.dataBundle!.bundleTrustIdentitySha256,
        );
      }
    }
    if (bundleIds.size !== 1) {
      throw new Error(
        `Provider compatibility rollout rejected rotation "${rotationId}": its canaries are bound to different data bundles.`,
      );
    }
    if (bundleTrustIdentities.size !== 1) {
      throw new Error(
        `Provider compatibility rollout rejected rotation "${rotationId}": its canaries are not bound to one verified signed-bundle trust and update identity.`,
      );
    }
    if (providerCompatibilityModes.size !== 1) {
      throw new Error(
        `Provider compatibility rollout rejected rotation "${rotationId}": its canaries used different provider-compatibility runtime modes.`,
      );
    }
    const canaries = LIVE_CANARY_IDS.map((canaryId) => {
      const report = byCanary.get(canaryId);
      return report
        ? canaryObservation(report)
        : {
            canaryId,
            status: "unavailable" as const,
            compatibilityComplete: false,
            envelopeSha256: null,
          };
    });
    const observedAt = entries
      .map(({ report }) => report.completedAt)
      .sort(
        (left, right) => Date.parse(left) - Date.parse(right),
      )
      .at(-1)!;
    observations.push({
      schemaVersion: 1,
      observationKind: "provider-compatibility-rotation",
      rotationId,
      observedAt,
      bundleId: [...bundleIds][0],
      bundleTrustIdentitySha256: [...bundleTrustIdentities][0],
      providerCompatibilityMode:
        [...providerCompatibilityModes][0],
      canaries,
    });
  }
  return sortedObservations(observations);
}

function mergeObservations(
  observations: readonly ProviderCompatibilityRotationObservation[],
): ProviderCompatibilityRotationObservation[] {
  const byRotation = new Map<
    string,
    ProviderCompatibilityRotationObservation
  >();
  for (const observation of observations) {
    const existing = byRotation.get(observation.rotationId);
    if (
      existing &&
      canonicalJson(existing) !== canonicalJson(observation)
    ) {
      throw new Error(
        `Provider compatibility rollout rejected conflicting retained evidence for rotation "${observation.rotationId}".`,
      );
    }
    byRotation.set(observation.rotationId, observation);
  }
  return sortedObservations([...byRotation.values()]);
}

export async function buildProviderCompatibilityRolloutArtifact(input: {
  reportsRoot: string;
  generatedAt?: string;
  enforcementLatchActive?: boolean;
}): Promise<ProviderCompatibilityRolloutArtifact> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(
      "Provider compatibility rollout requires a valid generation timestamp.",
    );
  }
  const files = await regularArtifactFiles(input.reportsRoot);
  const liveCanaries: Array<{
    filename: string;
    report: ParsedLiveCanary;
  }> = [];
  const retained: ProviderCompatibilityRotationObservation[] = [];
  for (const filename of files) {
    const verified = await verifiedArtifact(filename);
    if (path.basename(filename).startsWith("live-canary-")) {
      const parsed = RotatingLiveCanaryRolloutSchema.safeParse(
        verified.value,
      );
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `Provider compatibility rollout rejected "${filename}": live-canary schema validation failed at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid report"}.`,
        );
      }
      liveCanaries.push({ filename, report: parsed.data });
      continue;
    }
    const parsed = ProviderCompatibilityRolloutArtifactSchema.safeParse(
      verified.value,
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `Provider compatibility rollout rejected "${filename}": retained rollout schema validation failed at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid report"}.`,
      );
    }
    const artifact = parsed.data as ProviderCompatibilityRolloutArtifact;
    assertCanonicalArtifact(artifact, filename);
    retained.push(...artifact.observations);
  }
  const observations = mergeObservations([
    ...retained,
    ...observationsFromCanaries(liveCanaries),
  ]);
  const evaluation = evaluateProviderCompatibilityRollout({
    observations,
    requiredCanaryIds: LIVE_CANARY_IDS,
    requiredConsecutivePasses: REQUIRED_CONSECUTIVE_PASSES,
    enforcementLatchActive:
      input.enforcementLatchActive === true,
  });
  return {
    schemaVersion: 1,
    reportKind: "rosterpilot-provider-compatibility-rollout",
    reportId: artifactReportId({ observations, evaluation }),
    generatedAt,
    observations,
    evaluation,
  };
}

async function rejectSymlinkIfPresent(filename: string): Promise<void> {
  try {
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `Provider compatibility rollout output must be a regular file: ${filename}.`,
      );
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function writeProviderCompatibilityRolloutArtifact(input: {
  artifact: ProviderCompatibilityRolloutArtifact;
  outputPath: string;
}): Promise<WrittenProviderCompatibilityRolloutArtifact> {
  if (
    !path
      .basename(input.outputPath)
      .startsWith("provider-compatibility-rollout") ||
    !input.outputPath.endsWith(".json")
  ) {
    throw new Error(
      "Provider compatibility rollout output must use a provider-compatibility-rollout*.json filename so future runs can retain it.",
    );
  }
  const outputPath = path.resolve(input.outputPath);
  const checksumPath = `${outputPath}.sha256`;
  await mkdir(path.dirname(outputPath), {
    recursive: true,
    mode: 0o700,
  });
  await Promise.all([
    rejectSymlinkIfPresent(outputPath),
    rejectSymlinkIfPresent(checksumPath),
  ]);
  const content = `${JSON.stringify(input.artifact, null, 2)}\n`;
  const contentSha256 = sha256(content);
  const nonce = `${process.pid}-${crypto.randomUUID()}`;
  const temporaryReport = `${outputPath}.${nonce}.tmp`;
  const temporaryChecksum = `${checksumPath}.${nonce}.tmp`;
  try {
    await writeFile(temporaryReport, content, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      temporaryChecksum,
      `${contentSha256}  ${path.basename(outputPath)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporaryReport, outputPath);
    await rename(temporaryChecksum, checksumPath);
  } catch (error) {
    await Promise.all([
      rm(temporaryReport, { force: true }),
      rm(temporaryChecksum, { force: true }),
    ]);
    throw error;
  }
  return {
    artifact: input.artifact,
    reportPath: outputPath,
    checksumPath,
    sha256: contentSha256,
  };
}

export async function runProviderCompatibilityRollout(input: {
  reportsRoot: string;
  outputPath: string;
  generatedAt?: string;
  enforcementLatchActive?: boolean;
}): Promise<WrittenProviderCompatibilityRolloutArtifact> {
  const artifact = await buildProviderCompatibilityRolloutArtifact({
    reportsRoot: path.resolve(input.reportsRoot),
    generatedAt: input.generatedAt,
    enforcementLatchActive: input.enforcementLatchActive,
  });
  return writeProviderCompatibilityRolloutArtifact({
    artifact,
    outputPath: input.outputPath,
  });
}

export function providerCompatibilityRolloutExitCode(
  evaluation: ProviderCompatibilityRolloutEvaluation,
): 0 | 2 {
  return evaluation.releaseGate === "block" ? 2 : 0;
}
