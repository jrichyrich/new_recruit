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
  readVerifiedLiveNumericalParityCertification,
  verifyLiveNumericalParityCertificationEvidence,
  type LiveNumericalParityCertificationArtifact,
} from "./live-numerical-parity";
import {
  evaluateLiveNumericalParityRollout,
  LIVE_NUMERICAL_PARITY_REQUIRED_CONSECUTIVE_PASSES,
  type LiveNumericalParityRolloutEvaluation,
  type LiveNumericalParityRolloutObservation,
} from "./live-numerical-parity-rollout";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_ARTIFACT_BYTES = 8 * 1_024 * 1_024;
const MAX_CHECKSUM_BYTES = 512;

const TimestampSchema = z.string().refine(
  (value) => value.length > 0 && !Number.isNaN(Date.parse(value)),
  "Expected an ISO-compatible timestamp.",
);

const ObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    observationKind: z.literal("live-numerical-parity-rotation"),
    rotationId: z.string().trim().min(1),
    observedAt: TimestampSchema,
    certificateReportId: z.string().regex(SHA256_PATTERN),
    certificateSha256: z.string().regex(SHA256_PATTERN),
    expectedBundleId: z.string().regex(SHA256_PATTERN),
    expectedGitHead: z.string().regex(GIT_SHA_PATTERN),
    status: z.enum([
      "pass",
      "fail",
      "incomplete",
      "ineligible",
      "unavailable",
    ]),
    eligible: z.boolean(),
    complete: z.boolean(),
    liveEvidence: z.boolean(),
  })
  .strict();

const EvaluationSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluationKind: z.literal("live-numerical-parity-rollout"),
    requiredConsecutivePasses: z.literal(3),
    acceptedObservationCount: z.number().int().nonnegative(),
    consecutivePasses: z.number().int().nonnegative(),
    enforcementLatchActive: z.boolean(),
    requiredCurrentRotationId: z.string().trim().min(1).nullable(),
    enforcementActivatedAtRotationId: z.string().min(1).nullable(),
    enforcementActive: z.boolean(),
    latestRotationId: z.string().min(1).nullable(),
    latestStatus: z.enum([
      "pass",
      "fail",
      "incomplete",
      "ineligible",
      "unavailable",
      "missing",
    ]),
    releaseGate: z.enum(["observe", "pass", "block"]),
    reasons: z.array(z.string()),
  })
  .strict();

const ArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    reportKind: z.literal(
      "rosterpilot-live-numerical-parity-rollout",
    ),
    reportId: z.string().regex(SHA256_PATTERN),
    generatedAt: TimestampSchema,
    observations: z.array(ObservationSchema),
    evaluation: EvaluationSchema,
  })
  .strict();

export type LiveNumericalParityRolloutArtifact = {
  schemaVersion: 1;
  reportKind: "rosterpilot-live-numerical-parity-rollout";
  reportId: string;
  generatedAt: string;
  observations: LiveNumericalParityRolloutObservation[];
  evaluation: LiveNumericalParityRolloutEvaluation;
};

export type WrittenLiveNumericalParityRolloutArtifact = {
  artifact: LiveNumericalParityRolloutArtifact;
  reportPath: string;
  checksumPath: string;
  sha256: string;
};

function digest(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function artifactReportId(input: {
  observations: LiveNumericalParityRolloutObservation[];
  evaluation: LiveNumericalParityRolloutEvaluation;
}): string {
  return digest(canonicalJson(input));
}

function observationOrder(
  left: LiveNumericalParityRolloutObservation,
  right: LiveNumericalParityRolloutObservation,
): number {
  return (
    Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
    left.rotationId.localeCompare(right.rotationId)
  );
}

function sortedObservations(
  observations: readonly LiveNumericalParityRolloutObservation[],
): LiveNumericalParityRolloutObservation[] {
  return [...observations].sort(observationOrder);
}

function assertCanonicalArtifact(
  artifact: LiveNumericalParityRolloutArtifact,
  filename: string,
): void {
  const rotationIds = new Set(
    artifact.observations.map((observation) => observation.rotationId),
  );
  if (rotationIds.size !== artifact.observations.length) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": retained observations repeat a rotation identity.`,
    );
  }
  if (
    canonicalJson(sortedObservations(artifact.observations)) !==
    canonicalJson(artifact.observations)
  ) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": observations are not in canonical chronological order.`,
    );
  }
  const expectedEvaluation = evaluateLiveNumericalParityRollout({
    observations: artifact.observations,
    enforcementLatchActive:
      artifact.evaluation.enforcementLatchActive,
    currentRotationId:
      artifact.evaluation.requiredCurrentRotationId,
  });
  if (
    canonicalJson(expectedEvaluation) !==
    canonicalJson(artifact.evaluation)
  ) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": evaluation does not match retained observations.`,
    );
  }
  if (
    artifact.reportId !==
    artifactReportId({
      observations: artifact.observations,
      evaluation: artifact.evaluation,
    })
  ) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": reportId does not match retained state.`,
    );
  }
}

async function evidenceFiles(directory: string): Promise<string[]> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Live numerical parity rollout reports root must be a real directory: ${directory}.`,
    );
  }
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Live numerical parity rollout evidence cannot contain a symbolic link: ${filename}.`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await evidenceFiles(filename)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      (entry.name.startsWith("live-numerical-parity") ||
        entry.name.startsWith("provider-parity-certification"))
    ) {
      files.push(filename);
    }
  }
  return files.sort();
}

async function verifiedBytes(filename: string): Promise<{
  bytes: Buffer;
  sha256: string;
  value: unknown;
}> {
  const checksumFilename = `${filename}.sha256`;
  const [metadata, checksumMetadata] = await Promise.all([
    lstat(filename),
    lstat(checksumFilename),
  ]);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_ARTIFACT_BYTES ||
    !checksumMetadata.isFile() ||
    checksumMetadata.isSymbolicLink() ||
    checksumMetadata.size > MAX_CHECKSUM_BYTES
  ) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": artifact or checksum is not a bounded regular file.`,
    );
  }
  const [bytes, checksumText] = await Promise.all([
    readFile(filename),
    readFile(checksumFilename, "utf8"),
  ]);
  const checksum = checksumText.match(
    /^([a-f0-9]{64})  ([^/\\\r\n]+)\n$/,
  );
  const sha256 = digest(bytes);
  if (
    !checksum ||
    checksum[1] !== sha256 ||
    checksum[2] !== path.basename(filename)
  ) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": detached checksum is invalid.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": checksum-verified artifact is not JSON.`,
      { cause: error },
    );
  }
  return { bytes, sha256, value };
}

async function observationFromCertificate(
  certificate: LiveNumericalParityCertificationArtifact,
  certificateSha256: string,
  filename: string,
  reportsRoot: string,
): Promise<LiveNumericalParityRolloutObservation> {
  if (!certificate.rotationId) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": certificate has no rotationId.`,
    );
  }
  const binding = certificate.releaseBinding;
  if (
    !binding.expectedBundleId ||
    !binding.expectedGitHead
  ) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": certificate does not declare explicit release bundle and git expectations.`,
    );
  }
  if (
    certificate.evaluation.status === "pass" &&
    (!binding.matched ||
      binding.observedBundleIds.length !== 1 ||
      binding.observedBundleIds[0] !== binding.expectedBundleId ||
      binding.observedGitHeads.length !== 1 ||
      binding.observedGitHeads[0] !== binding.expectedGitHead)
  ) {
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": passing certificate is not bound to matching release bundle and git observations.`,
    );
  }
  await verifyLiveNumericalParityCertificationEvidence({
    artifact: certificate,
    reportsRoot,
  });
  return {
    schemaVersion: 1,
    observationKind: "live-numerical-parity-rotation",
    rotationId: certificate.rotationId,
    observedAt: certificate.generatedAt,
    certificateReportId: certificate.reportId,
    certificateSha256,
    expectedBundleId: binding.expectedBundleId,
    expectedGitHead: binding.expectedGitHead,
    status: certificate.evaluation.status,
    eligible: certificate.evaluation.eligible,
    complete: certificate.evaluation.complete,
    liveEvidence: certificate.evaluation.liveEvidence,
  };
}

function mergeObservations(
  observations: readonly LiveNumericalParityRolloutObservation[],
): LiveNumericalParityRolloutObservation[] {
  const byRotation = new Map<
    string,
    LiveNumericalParityRolloutObservation
  >();
  for (const observation of observations) {
    if (byRotation.has(observation.rotationId)) {
      throw new Error(
        `Live numerical parity rollout rejected duplicate retained evidence for rotation "${observation.rotationId}".`,
      );
    }
    byRotation.set(observation.rotationId, observation);
  }
  return sortedObservations([...byRotation.values()]);
}

export async function readVerifiedLiveNumericalParityRolloutArtifact(
  filename: string,
): Promise<LiveNumericalParityRolloutArtifact> {
  const verified = await verifiedBytes(path.resolve(filename));
  const parsed = ArtifactSchema.safeParse(verified.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Live numerical parity rollout rejected "${filename}": schema validation failed at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid artifact"}.`,
    );
  }
  const artifact = parsed.data as LiveNumericalParityRolloutArtifact;
  assertCanonicalArtifact(artifact, filename);
  return artifact;
}

export async function buildLiveNumericalParityRolloutArtifact(input: {
  reportsRoot: string;
  generatedAt?: string;
  enforcementLatchActive?: boolean;
  currentRotationId?: string | null;
}): Promise<LiveNumericalParityRolloutArtifact> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(
      "Live numerical parity rollout requires a valid generation timestamp.",
    );
  }
  const certificates: LiveNumericalParityRolloutObservation[] = [];
  const retained: LiveNumericalParityRolloutObservation[] = [];
  const currentRotationIds = new Set<string>();
  for (const filename of await evidenceFiles(path.resolve(input.reportsRoot))) {
    const verified = await verifiedBytes(filename);
    const candidate = verified.value as {
      reportKind?: unknown;
    };
    if (
      candidate.reportKind ===
      "rosterpilot-live-numerical-parity-certification"
    ) {
      const certificate =
        await readVerifiedLiveNumericalParityCertification(filename);
      const observation = await observationFromCertificate(
        certificate,
        verified.sha256,
        filename,
        path.resolve(input.reportsRoot),
      );
      if (currentRotationIds.has(observation.rotationId)) {
        throw new Error(
          `Live numerical parity rollout rejected duplicate certificate rotationId "${observation.rotationId}".`,
        );
      }
      currentRotationIds.add(observation.rotationId);
      certificates.push(observation);
      continue;
    }
    const artifact =
      await readVerifiedLiveNumericalParityRolloutArtifact(filename);
    retained.push(...artifact.observations);
  }
  const observations = mergeObservations([...retained, ...certificates]);
  const evaluation = evaluateLiveNumericalParityRollout({
    observations,
    enforcementLatchActive: input.enforcementLatchActive,
    currentRotationId: input.currentRotationId,
  });
  return {
    schemaVersion: 1,
    reportKind: "rosterpilot-live-numerical-parity-rollout",
    reportId: artifactReportId({ observations, evaluation }),
    generatedAt,
    observations,
    evaluation,
  };
}

async function rejectUnsafeOutput(filename: string): Promise<void> {
  try {
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `Live numerical parity rollout output must be a regular file: ${filename}.`,
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

export async function writeLiveNumericalParityRolloutArtifact(input: {
  artifact: LiveNumericalParityRolloutArtifact;
  outputPath: string;
}): Promise<WrittenLiveNumericalParityRolloutArtifact> {
  if (
    !path.basename(input.outputPath).startsWith(
      "live-numerical-parity-rollout",
    ) ||
    !input.outputPath.endsWith(".json")
  ) {
    throw new Error(
      "Live numerical parity rollout output must use a live-numerical-parity-rollout*.json filename.",
    );
  }
  const parsed = ArtifactSchema.parse(input.artifact) as
    LiveNumericalParityRolloutArtifact;
  assertCanonicalArtifact(parsed, input.outputPath);
  const outputPath = path.resolve(input.outputPath);
  const checksumPath = `${outputPath}.sha256`;
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await Promise.all([
    rejectUnsafeOutput(outputPath),
    rejectUnsafeOutput(checksumPath),
  ]);
  const content = `${canonicalJson(parsed)}\n`;
  const sha256 = digest(content);
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
      `${sha256}  ${path.basename(outputPath)}\n`,
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
    artifact: parsed,
    reportPath: outputPath,
    checksumPath,
    sha256,
  };
}

export async function runLiveNumericalParityRollout(input: {
  reportsRoot: string;
  outputPath: string;
  generatedAt?: string;
  enforcementLatchActive?: boolean;
  currentRotationId?: string | null;
}): Promise<WrittenLiveNumericalParityRolloutArtifact> {
  const artifact = await buildLiveNumericalParityRolloutArtifact(input);
  return writeLiveNumericalParityRolloutArtifact({
    artifact,
    outputPath: input.outputPath,
  });
}

export function liveNumericalParityRolloutExitCode(
  evaluation: LiveNumericalParityRolloutEvaluation,
): 0 | 2 {
  return evaluation.releaseGate === "block" ? 2 : 0;
}

export {
  LIVE_NUMERICAL_PARITY_REQUIRED_CONSECUTIVE_PASSES,
};
