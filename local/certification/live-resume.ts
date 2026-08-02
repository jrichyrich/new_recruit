import crypto from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  rosterExecutionFingerprint,
  validateEnrichedRoszGameplayIdentity,
  type ConnectorEvent,
  type EnrichedRoszGameplayIdentity,
  type EnrichedRoszSummary,
  type ProfilePolicyV1,
  type RosterDraftV1,
  type TesseraProfileRequirement,
} from "../../lib/rosterpilot";
import {
  CertificationReportSchema,
  type CertificationArtifactDescriptor,
  type CertificationReport,
  type CertificationTier,
} from "../../lib/rosterpilot/certification";
import {
  profilePolicyIdentityMatches,
  validateProfilePolicy,
} from "../tessera/profile-policy";
import type { TesseraBrowserResult } from "../tessera/browser";
import {
  tesseraSavedListConnectorEvents,
} from "./live-tessera-evidence";
import {
  deduplicateCertificationArtifacts,
} from "./artifact-inventory";

export type VerifiedCertificationResumeArtifact = {
  absolutePath: string;
  bundleRelativePath: string;
  content: Uint8Array;
  sha256: string;
  summary: EnrichedRoszSummary;
  rosterIdentity: Omit<EnrichedRoszGameplayIdentity, "summary">;
  priorConnectorEvents: ConnectorEvent[];
};

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function contentSha256(content: Uint8Array): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

const certificationArtifactKinds = new Set<
  CertificationArtifactDescriptor["kind"]
>([
  "canonical-rosz",
  "enriched-rosz",
  "profile-policy",
  "profile-policy-scaffold",
  "browser-fixture-evidence",
  "scenario",
  "report",
  "report-attempt",
  "report-checksum",
  "manifest",
]);

const certificationSelfArtifactKinds = new Set<
  CertificationArtifactDescriptor["kind"]
>(["report", "report-checksum"]);

const maxResumeArtifactReferences = 10_000;
const maxResumeArtifactBytes = 256 * 1024 * 1024;
const maxResumeAttemptBytes = 64 * 1024 * 1024;
const maxResumeChecksumBytes = 4 * 1024;

export type VerifiedCertificationResumeReport = {
  report: CertificationReport;
  reportContent: Uint8Array;
  reportSha256: string;
  reportPath: string;
  checksumPath: string;
};

function sameShard(
  left: CertificationReport["selection"]["shard"],
  right: CertificationReport["selection"]["shard"],
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.index === right.index &&
      left.total === right.total)
  );
}

function sameFactionIds(
  left: string[],
  right: string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((factionId, index) => factionId === right[index])
  );
}

function migrateLegacyCertificationReportCaseFields(
  value: unknown,
): unknown {
  if (
    !value ||
    typeof value !== "object" ||
    !("cases" in value) ||
    !Array.isArray(value.cases)
  ) {
    return value;
  }
  for (const candidate of value.cases) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("startedMs" in candidate)
    ) {
      continue;
    }
    if (
      typeof candidate.startedMs !== "number" ||
      !Number.isFinite(candidate.startedMs) ||
      candidate.startedMs < 0
    ) {
      return value;
    }
    delete candidate.startedMs;
  }
  return value;
}

/**
 * Verifies the detached checksum and complete runtime report contract before
 * returning any parsed resume state. Callers must invoke this before artifact
 * relocation, local-agent inspection, or connector status checks.
 */
export async function loadVerifiedCertificationResumeReport(input: {
  resumePath: string;
  expectedTier: CertificationTier;
  expectedManifestSha256: string;
  expectedSelection: CertificationReport["selection"];
}): Promise<VerifiedCertificationResumeReport> {
  const reportPath = path.resolve(input.resumePath);
  const checksumPath = `${reportPath}.sha256`;
  let reportContent: Uint8Array;
  try {
    const metadata = await stat(reportPath);
    if (!metadata.isFile()) {
      throw codedError(
        "CERTIFICATION_RESUME_REPORT_UNREADABLE",
        "The requested certification resume report is not a regular file.",
      );
    }
    if (metadata.size > maxResumeAttemptBytes) {
      throw codedError(
        "CERTIFICATION_RESUME_REPORT_TOO_LARGE",
        `The requested certification resume report exceeds the ${maxResumeAttemptBytes}-byte safety limit.`,
      );
    }
    reportContent = await readFile(reportPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("CERTIFICATION_RESUME_")
    ) {
      throw error;
    }
    throw codedError(
      "CERTIFICATION_RESUME_REPORT_UNREADABLE",
      "The requested certification resume report is missing or unreadable.",
    );
  }

  let checksumContent: Uint8Array;
  try {
    const metadata = await stat(checksumPath);
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > maxResumeChecksumBytes
    ) {
      throw codedError(
        "CERTIFICATION_RESUME_CHECKSUM_MALFORMED",
        "The detached certification report checksum is not a small regular file.",
      );
    }
    checksumContent = await readFile(checksumPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "CERTIFICATION_RESUME_CHECKSUM_MALFORMED"
    ) {
      throw error;
    }
    throw codedError(
      "CERTIFICATION_RESUME_CHECKSUM_MISSING",
      `The detached checksum "${path.basename(checksumPath)}" is missing or unreadable.`,
    );
  }

  const checksumText = Buffer.from(checksumContent).toString(
    "utf8",
  );
  const checksumMatch = checksumText.match(
    /^([0-9a-f]{64})  ([^/\\\r\n]+)\n$/,
  );
  if (!checksumMatch) {
    throw codedError(
      "CERTIFICATION_RESUME_CHECKSUM_MALFORMED",
      "The detached certification report checksum must contain one lowercase SHA-256, two spaces, the report basename, and a trailing newline.",
    );
  }
  const expectedBasename = path.basename(reportPath);
  if (checksumMatch[2] !== expectedBasename) {
    throw codedError(
      "CERTIFICATION_RESUME_CHECKSUM_BASENAME_MISMATCH",
      `The detached checksum names "${checksumMatch[2]}" instead of "${expectedBasename}".`,
    );
  }
  const reportSha256 = contentSha256(reportContent);
  if (reportSha256 !== checksumMatch[1]) {
    throw codedError(
      "CERTIFICATION_RESUME_REPORT_HASH_MISMATCH",
      "The certification resume report bytes do not match the detached checksum.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(reportContent).toString("utf8"));
  } catch {
    throw codedError(
      "CERTIFICATION_RESUME_REPORT_INVALID",
      "The hash-verified certification resume report is not valid JSON.",
    );
  }
  const parsed = CertificationReportSchema.safeParse(
    migrateLegacyCertificationReportCaseFields(value),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw codedError(
      "CERTIFICATION_RESUME_REPORT_INVALID",
      `The hash-verified certification resume report failed schema validation at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid report"}.`,
    );
  }
  const report = parsed.data;
  if (report.tier !== input.expectedTier) {
    throw codedError(
      "CERTIFICATION_RESUME_TIER_MISMATCH",
      `The certification resume tier is "${report.tier}"; expected "${input.expectedTier}".`,
    );
  }
  if (report.manifestSha256 !== input.expectedManifestSha256) {
    throw codedError(
      "CERTIFICATION_RESUME_MANIFEST_MISMATCH",
      "The certification resume report does not match the requested certification manifest.",
    );
  }
  if (
    report.selection.requestedFaction !==
    input.expectedSelection.requestedFaction
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_REQUESTED_FACTION_MISMATCH",
      "The certification resume report was created for a different requested faction.",
    );
  }
  if (!sameShard(report.selection.shard, input.expectedSelection.shard)) {
    throw codedError(
      "CERTIFICATION_RESUME_SHARD_MISMATCH",
      "The certification resume report was created for a different shard.",
    );
  }
  if (
    report.selection.changedOnly !==
    input.expectedSelection.changedOnly
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_CHANGED_ONLY_MISMATCH",
      "The certification resume report used a different changed-only selection.",
    );
  }
  if (
    !sameFactionIds(
      report.selection.selectedFactionIds,
      input.expectedSelection.selectedFactionIds,
    )
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_SELECTED_FACTIONS_MISMATCH",
      "The certification resume report selected a different ordered faction set.",
    );
  }
  return {
    report,
    reportContent,
    reportSha256,
    reportPath,
    checksumPath,
  };
}

function isRelocationError(
  error: unknown,
): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith(
      "CERTIFICATION_RESUME_RELOCATION_",
    )
  );
}

function artifactDescriptor(
  value: unknown,
): CertificationArtifactDescriptor {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    typeof value.kind !== "string" ||
    !certificationArtifactKinds.has(
      value.kind as CertificationArtifactDescriptor["kind"],
    ) ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    !("sha256" in value) ||
    !(
      value.sha256 === null ||
      typeof value.sha256 === "string"
    )
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_DESCRIPTOR_INVALID",
      "A prior certification artifact descriptor is invalid, so its bundle cannot be relocated safely.",
    );
  }
  return value as CertificationArtifactDescriptor;
}

function reportArtifactDescriptors(
  value: unknown,
  expected: Pick<
    CertificationReport,
    | "schemaVersion"
    | "reportKind"
    | "runId"
    | "tier"
    | "manifestSha256"
  >,
): CertificationArtifactDescriptor[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== expected.schemaVersion ||
    !("reportKind" in value) ||
    value.reportKind !== expected.reportKind ||
    !("runId" in value) ||
    value.runId !== expected.runId ||
    !("tier" in value) ||
    value.tier !== expected.tier ||
    !("manifestSha256" in value) ||
    value.manifestSha256 !== expected.manifestSha256 ||
    !("artifacts" in value) ||
    !Array.isArray(value.artifacts) ||
    !("cases" in value) ||
    !Array.isArray(value.cases)
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_ATTEMPT_INVALID",
      "A prior report-attempt artifact is not a complete certification report from the active run and manifest, so its artifact closure cannot be relocated safely.",
    );
  }
  if (
    value.artifacts.length > maxResumeArtifactReferences ||
    value.cases.length > maxResumeArtifactReferences
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_LIMIT_EXCEEDED",
      `A prior certification report exceeds the ${maxResumeArtifactReferences} artifact-graph safety limit.`,
    );
  }
  const descriptors = value.artifacts.map(artifactDescriptor);
  for (const candidate of value.cases) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("artifacts" in candidate) ||
      !Array.isArray(candidate.artifacts)
    ) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_ATTEMPT_INVALID",
        "A prior report-attempt artifact contains an invalid case artifact inventory.",
      );
    }
    if (
      descriptors.length + candidate.artifacts.length >
      maxResumeArtifactReferences
    ) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_LIMIT_EXCEEDED",
        `A prior certification report exceeds the ${maxResumeArtifactReferences} artifact-graph safety limit.`,
      );
    }
    descriptors.push(
      ...candidate.artifacts.map(artifactDescriptor),
    );
  }
  return descriptors;
}

function relativeBundlePath(
  root: string,
  candidate: string,
): string {
  if (
    candidate.includes("\0") ||
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    /^[A-Za-z]:/.test(candidate) ||
    candidate
      .split(/[\\/]+/)
      .some((segment) => segment === "..")
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_PATH_INVALID",
      "A prior certification artifact path is not bundle-relative.",
    );
  }
  const normalized = path.normalize(candidate);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(path.resolve(root), resolved);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_PATH_INVALID",
      "A prior certification artifact path escapes its certification bundle.",
    );
  }
  return relative;
}

async function verifiedSourceArtifact(input: {
  sourceRoot: string;
  sourceRealRoot: string;
  artifact: CertificationArtifactDescriptor;
}): Promise<Uint8Array> {
  if (
    !input.artifact.sha256 ||
    !/^[0-9a-f]{64}$/.test(input.artifact.sha256)
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_HASH_MISSING",
      "A prior certification artifact has no valid content hash, so its bundle cannot be relocated safely.",
    );
  }
  const relative = relativeBundlePath(
    input.sourceRoot,
    input.artifact.path,
  );
  const absolute = path.resolve(input.sourceRoot, relative);
  let actualPath: string;
  let content: Uint8Array;
  try {
    actualPath = await realpath(absolute);
    const actualRelative = path.relative(
      input.sourceRealRoot,
      actualPath,
    );
    if (
      actualRelative === ".." ||
      actualRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(actualRelative)
    ) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_PATH_INVALID",
        "A prior certification artifact resolves outside its certification bundle.",
      );
    }
    const metadata = await stat(actualPath);
    if (!metadata.isFile()) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_ARTIFACT_NOT_REGULAR",
        `Prior certification artifact "${input.artifact.path}" is not a regular file.`,
      );
    }
    content = await readFile(actualPath);
  } catch (error) {
    if (isRelocationError(error)) {
      throw error;
    }
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_ARTIFACT_MISSING",
      `Prior certification artifact "${input.artifact.path}" is missing or unreadable, so resume stopped before connector activity.`,
    );
  }
  if (contentSha256(content) !== input.artifact.sha256) {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_HASH_MISMATCH",
      `Prior certification artifact "${input.artifact.path}" no longer matches its recorded hash, so resume stopped before connector activity.`,
    );
  }
  return content;
}

async function writeRelocatedArtifact(input: {
  destinationRoot: string;
  destinationRealRoot: string;
  artifact: CertificationArtifactDescriptor;
  content: Uint8Array;
}): Promise<void> {
  const relative = relativeBundlePath(
    input.destinationRoot,
    input.artifact.path,
  );
  const target = path.resolve(input.destinationRoot, relative);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const actualParent = await realpath(parent);
  const parentRelative = path.relative(
    input.destinationRealRoot,
    actualParent,
  );
  if (
    parentRelative === ".." ||
    parentRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(parentRelative)
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_PATH_INVALID",
      "A relocated certification artifact would resolve outside the destination bundle.",
    );
  }
  try {
    const existingPath = await realpath(target);
    const existingRelative = path.relative(
      input.destinationRealRoot,
      existingPath,
    );
    if (
      existingRelative === ".." ||
      existingRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(existingRelative)
    ) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_PATH_INVALID",
        "A destination certification artifact resolves outside the destination bundle.",
      );
    }
    const existing = await readFile(existingPath);
    if (contentSha256(existing) !== input.artifact.sha256) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_COLLISION",
        `Destination certification artifact "${input.artifact.path}" already exists with different content.`,
      );
    }
    return;
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }
  try {
    await writeFile(target, input.content, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      )
    ) {
      throw error;
    }
  }
  let written: Uint8Array;
  try {
    written = await readFile(target);
  } catch {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_WRITE_FAILED",
      `Relocated certification artifact "${input.artifact.path}" could not be read back from the destination bundle.`,
    );
  }
  if (contentSha256(written) !== input.artifact.sha256) {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_WRITE_FAILED",
      `Relocated certification artifact "${input.artifact.path}" did not match its expected hash in the destination bundle.`,
    );
  }
}

/**
 * Materializes every non-self artifact reachable from the active resume
 * report and its immutable report-attempt history. Exact relative paths are
 * preserved so each copied attempt remains a portable, hash-verifiable
 * snapshot without rewriting its content or hash.
 */
export async function relocateCertificationResumeArtifactClosure(
  input: {
    previous: CertificationReport;
    previousReportContent?: Uint8Array;
    resumeBundleDirectory: string;
    outputBundleDirectory: string;
  },
): Promise<CertificationArtifactDescriptor[]> {
  const sourceRoot = path.resolve(input.resumeBundleDirectory);
  const destinationRoot = path.resolve(
    input.outputBundleDirectory,
  );
  let sourceRealRoot: string;
  try {
    sourceRealRoot = await realpath(sourceRoot);
  } catch {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_BUNDLE_MISSING",
      "The source certification bundle is unavailable, so resume stopped before connector activity.",
    );
  }

  let rootReport: unknown = input.previous;
  if (input.previousReportContent) {
    if (
      input.previousReportContent.byteLength >
      maxResumeAttemptBytes
    ) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_LIMIT_EXCEEDED",
        `The active resume report exceeds the ${maxResumeAttemptBytes}-byte safety limit.`,
      );
    }
    try {
      rootReport = JSON.parse(
        Buffer.from(input.previousReportContent).toString(
          "utf8",
        ),
      );
    } catch {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_ATTEMPT_INVALID",
        "The active resume report is not valid JSON.",
      );
    }
  }
  const expectedLineage = {
    schemaVersion: input.previous.schemaVersion,
    reportKind: input.previous.reportKind,
    runId: input.previous.runId,
    tier: input.previous.tier,
    manifestSha256: input.previous.manifestSha256,
  };
  const pending = reportArtifactDescriptors(
    rootReport,
    expectedLineage,
  );
  const artifacts: CertificationArtifactDescriptor[] = [];
  const verifiedByPath = new Map<string, string>();
  const contentByPath = new Map<string, Uint8Array>();
  const descriptorByPath = new Map<
    string,
    CertificationArtifactDescriptor
  >();
  const expandedAttemptHashes = new Set<string>();
  let verifiedBytes = 0;
  for (let index = 0; index < pending.length; index += 1) {
    if (
      index >= maxResumeArtifactReferences ||
      pending.length > maxResumeArtifactReferences
    ) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_LIMIT_EXCEEDED",
        `The prior certification artifact graph exceeds the ${maxResumeArtifactReferences} reference safety limit.`,
      );
    }
    const artifact = pending[index];
    if (certificationSelfArtifactKinds.has(artifact.kind)) {
      continue;
    }
    if (
      !artifact.sha256 ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_HASH_MISSING",
        "A prior certification artifact has no valid content hash, so its bundle cannot be relocated safely.",
      );
    }
    const relative = relativeBundlePath(
      sourceRoot,
      artifact.path,
    );
    const priorHash = verifiedByPath.get(relative);
    if (priorHash && priorHash !== artifact.sha256) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_DESCRIPTOR_CONFLICT",
        `Prior certification reports assign conflicting hashes to artifact path "${artifact.path}".`,
      );
    }
    artifacts.push({
      ...artifact,
      path: relative,
    });
    let content: Uint8Array;
    if (priorHash) {
      content = contentByPath.get(relative)!;
    } else {
      content = await verifiedSourceArtifact({
        sourceRoot,
        sourceRealRoot,
        artifact: {
          ...artifact,
          path: relative,
        },
      });
      verifiedBytes += content.byteLength;
      if (verifiedBytes > maxResumeArtifactBytes) {
        throw codedError(
          "CERTIFICATION_RESUME_RELOCATION_LIMIT_EXCEEDED",
          `The prior certification artifact graph exceeds the ${maxResumeArtifactBytes}-byte safety limit.`,
        );
      }
      verifiedByPath.set(relative, artifact.sha256);
      contentByPath.set(relative, content);
      descriptorByPath.set(relative, {
        ...artifact,
        path: relative,
      });
    }
    if (artifact.kind !== "report-attempt") {
      continue;
    }
    if (content.byteLength > maxResumeAttemptBytes) {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_LIMIT_EXCEEDED",
        `Prior report-attempt artifact "${artifact.path}" exceeds the ${maxResumeAttemptBytes}-byte safety limit.`,
      );
    }
    if (expandedAttemptHashes.has(artifact.sha256)) {
      continue;
    }
    expandedAttemptHashes.add(artifact.sha256);
    let attempt: unknown;
    try {
      attempt = JSON.parse(
        Buffer.from(content).toString("utf8"),
      );
    } catch {
      throw codedError(
        "CERTIFICATION_RESUME_RELOCATION_ATTEMPT_INVALID",
        `Prior report-attempt artifact "${artifact.path}" is not valid JSON.`,
      );
    }
    pending.push(
      ...reportArtifactDescriptors(attempt, expectedLineage),
    );
  }

  await mkdir(destinationRoot, { recursive: true });
  let destinationRealRoot: string;
  try {
    destinationRealRoot = await realpath(destinationRoot);
  } catch {
    throw codedError(
      "CERTIFICATION_RESUME_RELOCATION_BUNDLE_MISSING",
      "The destination certification bundle is unavailable, so resume stopped before connector activity.",
    );
  }
  for (const [relative, content] of contentByPath) {
    await writeRelocatedArtifact({
      destinationRoot,
      destinationRealRoot,
      artifact: descriptorByPath.get(relative)!,
      content,
    });
  }
  return deduplicateCertificationArtifacts(artifacts);
}

export async function preserveCertificationResumeAttempt(input: {
  content: Uint8Array;
  writeArtifact: (
    filename: string,
    content: Uint8Array,
  ) => Promise<string>;
}): Promise<CertificationArtifactDescriptor> {
  const sha256 = contentSha256(input.content);
  const artifactPath = await input.writeArtifact(
    `certification-report-attempt-${sha256}.json`,
    input.content,
  );
  const normalized = path.normalize(artifactPath);
  if (
    path.isAbsolute(artifactPath) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_ATTEMPT_PATH_INVALID",
      "The preserved certification attempt path is not bundle-relative.",
    );
  }
  return {
    kind: "report-attempt",
    path: artifactPath,
    sha256,
  };
}

function bundlePath(root: string, candidate: string): string {
  if (path.isAbsolute(candidate)) {
    throw codedError(
      "CERTIFICATION_RESUME_ARTIFACT_PATH_INVALID",
      "The prior enriched roster artifact path is not bundle-relative.",
    );
  }
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(path.resolve(root), resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_ARTIFACT_PATH_INVALID",
      "The prior enriched roster artifact path escapes its certification bundle.",
    );
  }
  return resolved;
}

export async function loadVerifiedCertificationResumeArtifact(input: {
  previous: CertificationReport;
  resumeBundleDirectory: string;
  factionId: string;
  roster: RosterDraftV1;
}): Promise<VerifiedCertificationResumeArtifact | null> {
  const priorCase = input.previous.cases.find(
    (result) =>
      result.caseId === `${input.factionId}:live-new-recruit` &&
      result.status === "pass",
  );
  if (!priorCase) return null;
  const priorBuild = input.previous.cases.find(
    (result) =>
      result.caseId ===
        `${input.factionId}:build:${input.roster.pointsLimit}` &&
      result.status === "pass",
  );
  if (
    typeof priorBuild?.evidence.executionFingerprint !== "string" ||
    priorBuild.evidence.executionFingerprint !==
      rosterExecutionFingerprint(input.roster)
  ) {
    throw codedError(
      "CERTIFICATION_RESUME_ROSTER_FINGERPRINT_MISMATCH",
      "The prior certification build fingerprint does not match the resumed canonical roster. No connector artifact was reused and live delivery was not retried.",
    );
  }
  const artifact = priorCase.artifacts.find(
    (candidate) => candidate.kind === "enriched-rosz",
  );
  if (!artifact?.sha256) {
    throw codedError(
      "CERTIFICATION_RESUME_ARTIFACT_MISSING",
      "The prior verified New Recruit case does not declare a hash-verifiable enriched roster artifact. Live delivery was not retried.",
    );
  }
  const absolutePath = bundlePath(
    input.resumeBundleDirectory,
    artifact.path,
  );
  let content: Uint8Array;
  try {
    content = await readFile(absolutePath);
  } catch {
    throw codedError(
      "CERTIFICATION_RESUME_ARTIFACT_MISSING",
      "The prior verified enriched roster artifact is missing. Live delivery was not retried.",
    );
  }
  const actualSha256 = contentSha256(content);
  if (actualSha256 !== artifact.sha256) {
    throw codedError(
      "CERTIFICATION_RESUME_ARTIFACT_HASH_MISMATCH",
      "The prior verified enriched roster artifact no longer matches its recorded hash. Live delivery was not retried.",
    );
  }
  let identity: EnrichedRoszGameplayIdentity;
  try {
    identity = validateEnrichedRoszGameplayIdentity(
      content,
      input.roster,
    );
  } catch {
    throw codedError(
      "CERTIFICATION_RESUME_ARTIFACT_VERIFICATION_FAILED",
      "The prior enriched roster artifact does not match the resumed canonical roster. Live delivery was not retried.",
    );
  }
  return {
    absolutePath,
    bundleRelativePath: artifact.path,
    content,
    sha256: actualSha256,
    summary: identity.summary,
    rosterIdentity: {
      requestedRosterName: identity.requestedRosterName,
      observedRosterName: identity.observedRosterName,
      presentationNameMatched: identity.presentationNameMatched,
      presentationAliasAccepted:
        identity.presentationAliasAccepted,
    },
    priorConnectorEvents: priorCase.connectorEvents,
  };
}

function deduplicatedEvents(
  previous: ConnectorEvent[],
  current: ConnectorEvent[],
): ConnectorEvent[] {
  return [
    ...new Map(
      [...previous, ...current].map((event) => [
        event.eventId,
        event,
      ]),
    ).values(),
  ];
}

type SavedListReuseEvidence = NonNullable<
  TesseraBrowserResult["savedListReuse"]
>;

function savedListReuseEvidence(
  value: unknown,
): SavedListReuseEvidence | null {
  if (!value || typeof value !== "object") return null;
  if (
    !("mode" in value) ||
    value.mode !== "deterministic" ||
    !("player" in value) ||
    !("opponent" in value)
  ) {
    return null;
  }
  const side = (
    candidate: unknown,
  ): SavedListReuseEvidence["player"] | null => {
    if (!candidate || typeof candidate !== "object") return null;
    if (
      !("name" in candidate) ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0 ||
      !("expectedUnitCount" in candidate) ||
      !Number.isSafeInteger(candidate.expectedUnitCount) ||
      Number(candidate.expectedUnitCount) <= 0 ||
      !("action" in candidate) ||
      !["imported", "reused"].includes(String(candidate.action))
    ) {
      return null;
    }
    const contentSha256 =
      "contentSha256" in candidate &&
      typeof candidate.contentSha256 === "string"
        ? candidate.contentSha256
        : undefined;
    const semanticSnapshotSource =
      "semanticSnapshotSource" in candidate &&
      ["fresh-import", "verified-cache", "unavailable"].includes(
        String(candidate.semanticSnapshotSource),
      )
        ? candidate.semanticSnapshotSource as
          | "fresh-import"
          | "verified-cache"
          | "unavailable"
        : undefined;
    const semanticSnapshotSha256 =
      "semanticSnapshotSha256" in candidate &&
      typeof candidate.semanticSnapshotSha256 === "string" &&
      /^[0-9a-f]{64}$/i.test(candidate.semanticSnapshotSha256)
        ? candidate.semanticSnapshotSha256
        : undefined;
    const semanticSnapshotReceiptSha256 =
      "semanticSnapshotReceiptSha256" in candidate &&
      typeof candidate.semanticSnapshotReceiptSha256 === "string" &&
      /^[0-9a-f]{64}$/i.test(
        candidate.semanticSnapshotReceiptSha256,
      )
        ? candidate.semanticSnapshotReceiptSha256
        : undefined;
    return {
      name: candidate.name,
      expectedUnitCount: Number(candidate.expectedUnitCount),
      action: candidate.action as "imported" | "reused",
      ...(contentSha256 ? { contentSha256 } : {}),
      ...(semanticSnapshotSource
        ? { semanticSnapshotSource }
        : {}),
      ...(semanticSnapshotSha256
        ? { semanticSnapshotSha256 }
        : {}),
      ...(semanticSnapshotReceiptSha256
        ? { semanticSnapshotReceiptSha256 }
        : {}),
    };
  };
  const player = side(value.player);
  const opponent = side(value.opponent);
  return player && opponent
    ? { mode: "deterministic", player, opponent }
    : null;
}

/**
 * Reports created before per-list Tessera connector accounting retained the
 * browser's deterministic import/reuse decisions but only emitted one
 * simulation event. Backfill those decisions with stable event IDs so a
 * same-report resume can retain the historical mutations without performing
 * them again. Missing legacy archive hashes remain null rather than being
 * inferred.
 */
export function migrateLegacyTesseraSavedListConnectorEvents(
  report: CertificationReport,
): number {
  let added = 0;
  for (const result of report.cases) {
    if (
      result.workflow !== "tessera-simulation" ||
      result.factionId === null
    ) {
      continue;
    }
    const reuse = savedListReuseEvidence(
      result.evidence.savedListReuse,
    );
    if (!reuse) continue;
    const playerContentSha256 =
      report.cases
        .find(
          (candidate) =>
            candidate.caseId ===
            `${result.factionId}:live-new-recruit`,
        )
        ?.artifacts.find(
          (artifact) =>
            artifact.kind === "enriched-rosz" &&
            artifact.sha256 !== null,
        )?.sha256 ?? null;
    const generated = tesseraSavedListConnectorEvents({
      savedListReuse: reuse,
      recordedAt: result.completedAt,
      eventIdSeed: [
        "legacy-tessera-saved-list-accounting-v1",
        report.runId,
        result.caseId,
        result.startedAt,
        result.completedAt,
      ].join("|"),
      contentSha256: {
        player: playerContentSha256,
        opponent: null,
      },
    });
    const existingRemoteIds = new Set(
      result.connectorEvents
        .filter(
          (event) =>
            event.provider === "tessera" &&
            event.action === "prepare",
        )
        .map((event) => event.remoteId)
        .filter((remoteId): remoteId is string => remoteId !== null),
    );
    const missing = generated.filter(
      (event) =>
        event.remoteId !== null &&
        !existingRemoteIds.has(event.remoteId),
    );
    if (missing.length === 0) continue;
    result.connectorEvents = deduplicatedEvents(
      result.connectorEvents,
      missing,
    );
    const savedListImports = generated.filter(
      (event) =>
        event.origin === "new-remote" &&
        event.outcome === "verified",
    ).length;
    const savedListReuses = generated.filter(
      (event) =>
        event.origin === "manifest-reuse" &&
        event.outcome === "reused",
    ).length;
    result.evidence = {
      ...result.evidence,
      connectorAccounting: {
        schemaVersion: 1,
        savedListImports,
        savedListReuses,
        savedListEventCount: generated.length,
        synthesizedFromLegacyEvidence: true,
        synthesizedEventCount: missing.length,
        contentHashUnavailableSides: (
          ["player", "opponent"] as const
        ).filter(
          (side) =>
            generated[
              side === "player" ? 0 : 1
            ].contentSha256 === null,
        ),
      },
    };
    added += missing.length;
  }
  report.connectorEvents = report.cases.flatMap(
    (result) => result.connectorEvents,
  );
  return added;
}

type PriorLiveAttempt = {
  code: string | null;
  stage: string;
  status: CertificationReport["cases"][number]["status"];
  startedAt: string;
  completedAt: string;
};

function priorLiveAttempts(
  priorCases: CertificationReport["cases"],
): PriorLiveAttempt[] {
  const attempts: PriorLiveAttempt[] = [];
  for (const candidate of priorCases) {
    const resume =
      candidate.evidence.resume &&
      typeof candidate.evidence.resume === "object"
        ? candidate.evidence.resume
        : null;
    const inherited =
      resume &&
      "priorAttempts" in resume &&
      Array.isArray(resume.priorAttempts)
        ? resume.priorAttempts
        : [];
    for (const attempt of inherited) {
      if (
        !attempt ||
        typeof attempt !== "object" ||
        !("code" in attempt) ||
        !(
          attempt.code === null ||
          typeof attempt.code === "string"
        ) ||
        !("stage" in attempt) ||
        typeof attempt.stage !== "string" ||
        !("status" in attempt) ||
        ![
          "pass",
          "fail",
          "unsupported",
          "degraded",
          "skipped",
        ].includes(String(attempt.status)) ||
        !("startedAt" in attempt) ||
        typeof attempt.startedAt !== "string" ||
        !("completedAt" in attempt) ||
        typeof attempt.completedAt !== "string"
      ) {
        continue;
      }
      attempts.push({
        code: attempt.code,
        stage: attempt.stage,
        status: attempt.status as PriorLiveAttempt["status"],
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
      });
    }
    attempts.push({
      code: candidate.code,
      stage: candidate.stage,
      status: candidate.status,
      startedAt: candidate.startedAt,
      completedAt: candidate.completedAt,
    });
  }
  return [
    ...new Map(
      attempts.map((attempt) => [
        [
          attempt.code ?? "",
          attempt.stage,
          attempt.status,
          attempt.startedAt,
          attempt.completedAt,
        ].join("|"),
        attempt,
      ]),
    ).values(),
  ];
}

export function mergeResumedLiveConnectorHistory(
  report: CertificationReport,
  previous: CertificationReport,
  options: {
    carriedCaseIds?: ReadonlySet<string>;
  } = {},
): void {
  if (report.runId !== previous.runId) {
    throw codedError(
      "CERTIFICATION_RESUME_RUN_ID_MISMATCH",
      "Connector history cannot be merged across different certification runs.",
    );
  }
  for (const result of report.cases) {
    if (
      result.factionId === null ||
      ![
        `${result.factionId}:live-new-recruit`,
        `${result.factionId}:live-tessera`,
      ].includes(result.caseId)
    ) {
      continue;
    }
    const priorCases = previous.cases.filter(
      (candidate) => candidate.caseId === result.caseId,
    );
    if (priorCases.length === 0) continue;
    const priorEvents = priorCases.flatMap(
      (candidate) => candidate.connectorEvents,
    );
    const currentAttemptEvents =
      options.carriedCaseIds?.has(result.caseId)
        ? []
        : [...result.connectorEvents];
    result.connectorEvents = deduplicatedEvents(
      priorEvents,
      currentAttemptEvents,
    );
    const currentAttemptRemoteMutations =
      currentAttemptEvents.filter(
        (event) =>
          event.action === "prepare" &&
          event.origin === "new-remote" &&
          event.outcome === "verified",
      ).length;
    const currentAttemptCacheReuses =
      currentAttemptEvents.filter(
        (event) =>
          event.action === "prepare" &&
          ["persistent-cache", "manifest-reuse"].includes(
            event.origin,
          ) &&
          event.outcome === "reused",
      ).length;
    result.evidence = {
      ...result.evidence,
      resume: {
        runId: report.runId,
        priorEventsRetained: priorEvents.length,
        currentAttemptRemoteMutations,
        currentAttemptCacheReuses,
        currentAttemptRemoteMutationsByProvider: {
          newRecruit: currentAttemptEvents.filter(
            (event) =>
              event.provider === "new-recruit" &&
              event.action === "prepare" &&
              event.origin === "new-remote" &&
              event.outcome === "verified",
          ).length,
          tessera: currentAttemptEvents.filter(
            (event) =>
              event.provider === "tessera" &&
              event.action === "prepare" &&
              event.origin === "new-remote" &&
              event.outcome === "verified",
          ).length,
        },
        currentAttemptCacheReusesByProvider: {
          newRecruit: currentAttemptEvents.filter(
            (event) =>
              event.provider === "new-recruit" &&
              event.action === "prepare" &&
              ["persistent-cache", "manifest-reuse"].includes(
                event.origin,
              ) &&
              event.outcome === "reused",
          ).length,
          tessera: currentAttemptEvents.filter(
            (event) =>
              event.provider === "tessera" &&
              event.action === "prepare" &&
              ["persistent-cache", "manifest-reuse"].includes(
                event.origin,
              ) &&
              event.outcome === "reused",
          ).length,
        },
        durableRemoteMutations: result.connectorEvents.filter(
          (event) =>
            event.action === "prepare" &&
            event.origin === "new-remote" &&
            event.outcome === "verified",
        ).length,
        durableCacheReuses: result.connectorEvents.filter(
          (event) =>
            event.action === "prepare" &&
            ["persistent-cache", "manifest-reuse"].includes(
              event.origin,
            ) &&
            event.outcome === "reused",
        ).length,
        durableEventCount: result.connectorEvents.length,
        priorAttempts: priorLiveAttempts(priorCases),
      },
    };
  }
}

export function certificationResumePolicyIsCompatible(
  previous: CertificationReport,
  requestedPolicy: ProfilePolicyV1 | null,
): boolean {
  const priorPassedSimulations = previous.cases.filter(
    (result) =>
      result.caseId.endsWith(":live-tessera") &&
      result.status === "pass",
  );
  for (const priorPassedSimulation of priorPassedSimulations) {
    const policyEvidence =
      priorPassedSimulation.evidence.profilePolicy;
    if (!policyEvidence || typeof policyEvidence !== "object") {
      return false;
    }
    const rawRequirements =
      "requirements" in policyEvidence
        ? policyEvidence.requirements
        : null;
    const appliedHash =
      "appliedCanonicalSha256" in policyEvidence &&
      typeof policyEvidence.appliedCanonicalSha256 === "string"
        ? policyEvidence.appliedCanonicalSha256
        : null;
    if (!Array.isArray(rawRequirements)) return false;
    const requirements: TesseraProfileRequirement[] = [];
    for (const value of rawRequirements) {
      if (
        !value ||
        typeof value !== "object" ||
        !("faction" in value) ||
        typeof value.faction !== "string" ||
        !("unit" in value) ||
        typeof value.unit !== "string" ||
        !("weaponGroup" in value) ||
        typeof value.weaponGroup !== "string" ||
        !("phase" in value) ||
        !["shooting", "fight"].includes(String(value.phase)) ||
        !("availableProfiles" in value) ||
        !Array.isArray(value.availableProfiles) ||
        !value.availableProfiles.every(
          (profile: unknown) => typeof profile === "string",
        ) ||
        !("activeCount" in value) ||
        !Number.isSafeInteger(value.activeCount) ||
        Number(value.activeCount) <= 0
      ) {
        return false;
      }
      const unitOccurrence =
        "unitOccurrence" in value &&
        Number.isSafeInteger(value.unitOccurrence) &&
        Number(value.unitOccurrence) > 0
          ? Number(value.unitOccurrence)
          : undefined;
      const modelCount =
        "modelCount" in value &&
        Number.isSafeInteger(value.modelCount) &&
        Number(value.modelCount) > 0
          ? Number(value.modelCount)
          : undefined;
      requirements.push({
        faction: value.faction,
        unit: value.unit,
        selectionId: null,
        ...(unitOccurrence === undefined ? {} : { unitOccurrence }),
        ...(modelCount === undefined ? {} : { modelCount }),
        weaponGroup: value.weaponGroup,
        phase: value.phase as "shooting" | "fight",
        availableProfiles: value.availableProfiles as string[],
        activeCount: Number(value.activeCount),
        selectedProfile: null,
      });
    }
    const scopedPolicy = requestedPolicy
      ? {
          schemaVersion: 1 as const,
          policyKind: "tessera-profile-policy" as const,
          entries: requestedPolicy.entries.filter((entry) =>
            requirements.some((requirement) =>
              profilePolicyIdentityMatches(entry, requirement),
            ),
          ),
        }
      : null;
    const validation = validateProfilePolicy(
      requirements,
      scopedPolicy,
    );
    if (!validation.valid || validation.hash !== appliedHash) {
      return false;
    }
  }
  return true;
}
