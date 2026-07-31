import crypto from "node:crypto";
import {
  access,
  constants,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  RosterDraftV2Schema,
  buildRoster,
  inspectEnrichedProfileRequirements,
  inspectEnrichedRosz,
  previewFactionStressPortfolio,
  rosterExecutionFingerprint,
  validateRoster,
  type ProfilePolicyV1,
  type ResultEnvelope,
  type RosterDraftV1,
  type RuntimeProvenance,
  type TesseraMatchupReport,
  type TesseraProfileRequirement,
  type TesseraRevisionComparisonReport,
  type TesseraStressTestReport,
} from "../../lib/rosterpilot";
import { getLocalAgentStatus } from "../agent/client";
import type { LocalAgentStatus } from "../agent/contracts";
import { projectRoot } from "../agent/paths";
import { getRuntimeProvenance } from "../runtime-provenance";
import {
  compareRosterRevision,
} from "../tessera/companion";
import {
  getTesseraRunStatus,
  resumeTesseraRun,
  startTesseraRun,
  type TesseraRunJob,
  type TesseraRunResult,
  type TesseraRunStatus,
} from "../tessera/jobs";
import {
  aggregateProfileRequirements,
  ProfilePolicySchema,
  profilePolicyHash,
  profilePolicyIdentityKey,
  profilePolicyIdentityMatches,
  validateProfilePolicy,
} from "../tessera/profile-policy";
import {
  LIVE_CANARY_FIXTURE_ENV,
  LIVE_CANARY_PROFILE_POLICY_ENV,
  createLiveCanaryRunRequest,
  evaluateLiveCanaryReadiness,
  liveCanaryDefinition,
  type LiveCanaryDefinition,
  type LiveCanaryId,
  type LiveCanaryPathReadiness,
  type LiveCanaryReadiness,
  type LiveCanaryUnavailableReason,
} from "./live-canaries";

const terminalStatuses = new Set<TesseraRunStatus>([
  "needs-input",
  "complete",
  "degraded",
  "inconclusive",
  "failed",
  "cancelled",
]);

export type LiveCanaryAssertionResult = {
  id: string;
  description: string;
  status: "pass" | "fail" | "not-run";
  evidence: Record<string, unknown> | null;
};

export type LiveCanaryRunReference = {
  runId: string;
  jobPath: string;
  initialAttempt: number;
  finalAttempt: number | null;
  finalStatus: TesseraRunStatus | null;
  manifestPath: string | null;
};

export type RotatingLiveCanaryReport = {
  schemaVersion: 1;
  reportKind: "rosterpilot-rotating-live-canary";
  reportId: string;
  canary: LiveCanaryDefinition;
  startedAt: string;
  completedAt: string;
  status: "pass" | "fail" | "unavailable";
  livePass: boolean;
  evidenceKind: "live" | "none";
  readiness: LiveCanaryReadiness;
  runtime: RuntimeProvenance;
  localAgent: {
    available: boolean;
    version: string | null;
    protocolVersion: number | null;
    browserAvailable: boolean;
    brokerAvailable: boolean;
    providers: Array<{
      providerId: "new-recruit" | "tessera";
      credentialState: string;
      ready: boolean;
    }>;
  };
  profilePolicy: {
    basename: string | null;
    sha256: string | null;
  };
  fixtureInputs: Array<{
    requirement: string;
    basename: string | null;
  }>;
  assertions: LiveCanaryAssertionResult[];
  run: LiveCanaryRunReference | null;
  revision: {
    baselineRunId: string;
    revisionRunId: string;
    conclusion: string | null;
    artifactPaths: string[];
  } | null;
  failure: {
    code: string;
    message: string;
  } | null;
  limitations: string[];
};

export type RunRotatingLiveCanaryInput = {
  canaryId: LiveCanaryId;
  outputDirectory: string;
  environment?: NodeJS.ProcessEnv;
  profilePolicyPath?: string;
  maxWaitMs?: number;
  pollMs?: number;
  forcedClientTimeoutMs?: number;
};

type TerminalTesseraRun = {
  job: TesseraRunJob;
  result: TesseraRunResult | null;
};

export type LiveCanaryRunnerDependencies = {
  getAgentStatus: typeof getLocalAgentStatus;
  getRuntime: typeof getRuntimeProvenance;
  build: typeof buildRoster;
  validate: typeof validateRoster;
  preview: typeof previewFactionStressPortfolio;
  startRun: typeof startTesseraRun;
  getRunStatus: typeof getTesseraRunStatus;
  resumeRun: typeof resumeTesseraRun;
  compareRevision: typeof compareRosterRevision;
  wait: (milliseconds: number) => Promise<void>;
};

const defaultDependencies: LiveCanaryRunnerDependencies = {
  getAgentStatus: getLocalAgentStatus,
  getRuntime: getRuntimeProvenance,
  build: buildRoster,
  validate: validateRoster,
  preview: previewFactionStressPortfolio,
  startRun: startTesseraRun,
  getRunStatus: getTesseraRunStatus,
  resumeRun: resumeTesseraRun,
  compareRevision: compareRosterRevision,
  wait: async (milliseconds) => {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, milliseconds),
    );
  },
};

function codedError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown, fallback: string): string {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : fallback;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function sha256(content: string | Uint8Array): string {
  return crypto
    .createHash("sha256")
    .update(content)
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return sha256(JSON.stringify(canonicalValue(value)));
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function factionNamesCompatible(
  left: string,
  right: string,
): boolean {
  const normalizedLeft = normalized(left);
  const normalizedRight = normalized(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

export function sourcePinsCompatible(
  left: RosterDraftV1,
  right: RosterDraftV1,
): boolean {
  if (left.factionId === right.factionId) {
    return canonicalSha256(left.sourceData) ===
      canonicalSha256(right.sourceData);
  }
  const sharedReleaseIdentity = (roster: RosterDraftV1) => ({
    package: roster.sourceData.package,
    version: roster.sourceData.version,
    edition: roster.sourceData.edition,
    dataslate: roster.sourceData.dataslate,
    releaseId: roster.sourceData.releaseId,
    newRecruit: {
      repository: roster.sourceData.newRecruit.repository,
      commit: roster.sourceData.newRecruit.commit,
      gameSystemRevision:
        roster.sourceData.newRecruit.gameSystemRevision,
    },
    official: roster.sourceData.official,
  });
  return (
    canonicalSha256(sharedReleaseIdentity(left)) ===
    canonicalSha256(sharedReleaseIdentity(right))
  );
}

function matchedPoints(rosters: RosterDraftV1[]): boolean {
  if (rosters.length === 0) return false;
  const pointsLimit = rosters[0].pointsLimit;
  return rosters.every(
    (roster) =>
      roster.pointsLimit === pointsLimit &&
      Math.abs(roster.totalPoints - pointsLimit) /
        Math.max(1, pointsLimit) <=
        0.05,
  );
}

function assertionResults(
  definition: LiveCanaryDefinition,
): LiveCanaryAssertionResult[] {
  return definition.assertions.map((assertion) => ({
    ...assertion,
    status: "not-run",
    evidence: null,
  }));
}

function recordAssertion(
  assertions: LiveCanaryAssertionResult[],
  id: string,
  passed: boolean,
  evidence: Record<string, unknown>,
): void {
  const assertion = assertions.find((entry) => entry.id === id);
  if (!assertion) {
    throw codedError(
      "LIVE_CANARY_ASSERTION_UNKNOWN",
      `The canary tried to record unknown assertion "${id}".`,
    );
  }
  assertion.status = passed ? "pass" : "fail";
  assertion.evidence = evidence;
}

function safeAgentSummary(
  status: LocalAgentStatus | null,
): RotatingLiveCanaryReport["localAgent"] {
  return {
    available: status?.available === true,
    version: status?.version ?? null,
    protocolVersion: status?.protocolVersion ?? null,
    browserAvailable: status?.browserAvailable === true,
    brokerAvailable: status?.brokerAvailable === true,
    providers: (status?.providers ?? []).map((provider) => ({
      providerId: provider.providerId,
      credentialState: provider.credentialState,
      ready: provider.ready,
    })),
  };
}

async function pathReadiness(
  requestedPath: string | undefined,
): Promise<LiveCanaryPathReadiness> {
  if (!requestedPath) {
    return {
      configured: false,
      readable: false,
      basename: null,
    };
  }
  try {
    await access(requestedPath, constants.R_OK);
    const metadata = await lstat(requestedPath);
    return {
      configured: true,
      readable:
        metadata.isFile() && !metadata.isSymbolicLink(),
      basename: path.basename(requestedPath),
    };
  } catch {
    return {
      configured: true,
      readable: false,
      basename: path.basename(requestedPath),
    };
  }
}

async function collectReadiness(input: {
  definition: LiveCanaryDefinition;
  environment: NodeJS.ProcessEnv;
  profilePolicyPath?: string;
  dependencies: LiveCanaryRunnerDependencies;
}): Promise<{
  readiness: LiveCanaryReadiness;
  runtime: RuntimeProvenance;
  agentStatus: LocalAgentStatus | null;
  resolvedPaths: Record<string, string | undefined>;
}> {
  const resolvedPaths = Object.fromEntries(
    input.definition.requiredPathEnvironment.map((environmentName) => [
      environmentName,
      environmentName === LIVE_CANARY_PROFILE_POLICY_ENV
        ? input.profilePolicyPath ??
          input.environment[environmentName]
        : input.environment[environmentName],
    ]),
  );
  const requiredPaths = Object.fromEntries(
    await Promise.all(
      Object.entries(resolvedPaths).map(
        async ([environmentName, requestedPath]) => [
          environmentName,
          await pathReadiness(requestedPath),
        ],
      ),
    ),
  );
  const runtime = input.dependencies.getRuntime();
  let agentStatus: LocalAgentStatus | null = null;
  let agentError: string | null = null;
  try {
    agentStatus = await input.dependencies.getAgentStatus({
      timeoutMs: 5_000,
    });
  } catch (error) {
    agentError = errorMessage(
      error,
      "The RosterPilot local agent could not be reached.",
    );
  }
  return {
    readiness: evaluateLiveCanaryReadiness({
      definition: input.definition,
      liveOptIn:
        input.environment.ROSTERPILOT_CERTIFICATION_LIVE ===
        "1",
      platform: process.platform,
      expectedProjectDirectory: projectRoot,
      runtime,
      agentStatus,
      agentError,
      requiredPaths,
    }),
    runtime,
    agentStatus,
    resolvedPaths,
  };
}

function requireRoster(
  result: ResultEnvelope<RosterDraftV1>,
  label: string,
  dependencies: LiveCanaryRunnerDependencies,
): RosterDraftV1 {
  if (!result.ok || !result.data) {
    throw codedError(
      "LIVE_CANARY_ROSTER_BUILD_FAILED",
      `${label} could not be built: ${result.violations
        .map((violation) => violation.message)
        .join("; ")}`,
    );
  }
  const validation = dependencies.validate(result.data);
  if (!validation.ok || !validation.data?.legal) {
    throw codedError(
      "LIVE_CANARY_ROSTER_INVALID",
      `${label} did not pass canonical roster validation: ${validation.violations
        .map((violation) => violation.message)
        .join("; ")}`,
    );
  }
  return result.data;
}

async function readCanonicalRoster(
  filename: string,
  label: string,
  dependencies: LiveCanaryRunnerDependencies,
): Promise<RosterDraftV1> {
  try {
    const roster = RosterDraftV2Schema.parse(
      JSON.parse(await readFile(filename, "utf8")),
    );
    const validation = dependencies.validate(roster);
    if (!validation.ok || !validation.data?.legal) {
      throw new Error(
        validation.violations
          .map((violation) => violation.message)
          .join("; "),
      );
    }
    return roster;
  } catch (error) {
    throw codedError(
      "LIVE_FIXTURE_INVALID",
      `${label} is not a valid current canonical roster: ${errorMessage(
        error,
        "unknown fixture error",
      )}`,
    );
  }
}

function mergedRequirements(
  groups: TesseraProfileRequirement[][],
): TesseraProfileRequirement[] {
  const merged = new Map<string, TesseraProfileRequirement>();
  for (const requirement of groups.flat()) {
    const key = profilePolicyIdentityKey(requirement);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, structuredClone(requirement));
      continue;
    }
    current.activeCount = Math.max(
      current.activeCount,
      requirement.activeCount,
    );
    current.selectionId = null;
    const profiles = new Map(
      current.availableProfiles.map((profile) => [
        normalized(profile),
        profile,
      ]),
    );
    for (const profile of requirement.availableProfiles) {
      profiles.set(normalized(profile), profile);
    }
    current.availableProfiles = [...profiles.values()].sort(
      (left, right) =>
        normalized(left).localeCompare(normalized(right)),
    );
  }
  return [...merged.values()].sort((left, right) =>
    profilePolicyIdentityKey(left).localeCompare(
      profilePolicyIdentityKey(right),
    ),
  );
}

async function readValidatedPolicy(
  filename: string,
  requirementGroups: TesseraProfileRequirement[][],
  outputDirectory: string,
): Promise<{
  policy: ProfilePolicyV1;
  sha256: string;
  path: string;
}> {
  let sourcePolicy: ProfilePolicyV1;
  try {
    sourcePolicy = ProfilePolicySchema.parse(
      JSON.parse(await readFile(filename, "utf8")),
    );
  } catch (error) {
    throw codedError(
      "LIVE_PROFILE_POLICY_INVALID",
      `The live canary profile policy is invalid: ${errorMessage(
        error,
        "unknown policy error",
      )}`,
    );
  }
  const requirements = mergedRequirements(requirementGroups);
  const policy: ProfilePolicyV1 = {
    schemaVersion: 1,
    policyKind: "tessera-profile-policy",
    entries: sourcePolicy.entries.filter((entry) =>
      requirements.some((requirement) =>
        profilePolicyIdentityMatches(entry, requirement),
      ),
    ),
  };
  const validation = validateProfilePolicy(
    requirements,
    policy,
  );
  if (!validation.valid) {
    throw codedError(
      "LIVE_PROFILE_POLICY_INVALID",
      [
        "The live canary profile policy does not exactly resolve its known roster requirements.",
        ...validation.errors,
        ...validation.unresolved.map(
          (requirement) =>
            `${requirement.faction} / ${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase}`,
        ),
      ].join(" "),
    );
  }
  const policySha256 = profilePolicyHash(policy);
  const policyDirectory = path.join(
    outputDirectory,
    "preflight",
  );
  await mkdir(policyDirectory, {
    recursive: true,
    mode: 0o700,
  });
  const scopedPath = path.join(
    policyDirectory,
    `profile-policy-${policySha256}.json`,
  );
  const content = `${JSON.stringify(policy, null, 2)}\n`;
  try {
    await writeFile(scopedPath, content, {
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
      ) ||
      await readFile(scopedPath, "utf8") !== content
    ) {
      throw error;
    }
  }
  return {
    policy,
    sha256: policySha256,
    path: scopedPath,
  };
}

async function waitForTerminalRun(
  jobPath: string,
  input: {
    maxWaitMs: number;
    pollMs: number;
    dependencies: LiveCanaryRunnerDependencies;
  },
): Promise<TerminalTesseraRun> {
  const deadline = Date.now() + input.maxWaitMs;
  while (Date.now() <= deadline) {
    const current = await input.dependencies.getRunStatus(
      jobPath,
      true,
    );
    if (terminalStatuses.has(current.job.status)) {
      return current;
    }
    await input.dependencies.wait(input.pollMs);
  }
  throw codedError(
    "LIVE_CANARY_WAIT_TIMEOUT",
    "The live canary exceeded its wait budget. Its durable job was left intact for status inspection or resume.",
  );
}

function requireCompleteJob(
  terminal: TerminalTesseraRun,
): TesseraRunResult {
  if (
    terminal.job.status !== "complete" ||
    !terminal.result ||
    !terminal.result.ok ||
    !terminal.result.data
  ) {
    const issue =
      terminal.result?.violations[0] ??
      terminal.result?.warnings[0];
    throw codedError(
      terminal.job.error?.code ??
        issue?.code ??
        "LIVE_CANARY_RUN_INCOMPLETE",
      terminal.job.error?.message ??
        issue?.message ??
        `The durable Tessera run ended as ${terminal.job.status}.`,
    );
  }
  return terminal.result;
}

function stressReport(
  result: TesseraRunResult,
): TesseraStressTestReport {
  const data = result.data;
  if (
    !data ||
    !("reportKind" in data) ||
    data.reportKind !== "tessera-stress-test"
  ) {
    throw codedError(
      "LIVE_CANARY_RESULT_KIND_MISMATCH",
      "The adaptive-nine canary did not return a stress-test report.",
    );
  }
  return data;
}

function matchupReport(
  result: TesseraRunResult,
): TesseraMatchupReport {
  const data = result.data;
  if (
    !data ||
    !("schemaVersion" in data) ||
    data.schemaVersion !== 3 ||
    !("configuration" in data) ||
    !("opponents" in data)
  ) {
    throw codedError(
      "LIVE_CANARY_RESULT_KIND_MISMATCH",
      "The exact canary did not return a schema-v3 matchup report.",
    );
  }
  return data as TesseraMatchupReport;
}

function reportArtifactPath(
  job: TesseraRunJob,
  report:
    | TesseraStressTestReport
    | TesseraMatchupReport,
  format: "stress-json" | "matchup-json",
): string {
  const artifact = report.artifacts.find(
    (entry) => entry.format === format,
  );
  if (!artifact) {
    throw codedError(
      "LIVE_CANARY_REPORT_ARTIFACT_MISSING",
      `The ${format} artifact is missing from the live result.`,
    );
  }
  if (path.isAbsolute(artifact.written)) {
    return artifact.written;
  }
  const base =
    format === "stress-json"
      ? path.join(job.jobDirectory, "artifacts")
      : path.join(
          job.jobDirectory,
          "artifacts",
          `attempt-${job.attempt}`,
        );
  return path.resolve(base, artifact.written);
}

function portableRunPath(
  outputDirectory: string,
  filename: string | null,
): string | null {
  if (!filename) return null;
  const relative = path.relative(
    path.resolve(outputDirectory),
    path.resolve(filename),
  );
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw codedError(
      "LIVE_CANARY_ARTIFACT_OUTSIDE_BUNDLE",
      "A durable run artifact resolved outside the live-canary bundle.",
    );
  }
  return relative;
}

async function fileSha256(filename: string): Promise<string> {
  return sha256(await readFile(filename));
}

async function portableStressEvidence(
  job: TesseraRunJob,
  report: TesseraStressTestReport,
): Promise<{
  portable: boolean;
  verifiedHashes: number;
  reportPath: string;
}> {
  const reportPath = reportArtifactPath(
    job,
    report,
    "stress-json",
  );
  const portable = JSON.parse(
    await readFile(reportPath, "utf8"),
  ) as TesseraStressTestReport;
  const relative = (value: string): boolean =>
    !path.isAbsolute(value) &&
    value !== ".." &&
    !value.startsWith(`..${path.sep}`);
  let verifiedHashes = 0;
  for (const artifact of portable.artifacts) {
    if (!relative(artifact.written)) {
      return { portable: false, verifiedHashes, reportPath };
    }
    if (artifact.sha256) {
      const artifactPath = path.resolve(
        path.dirname(reportPath),
        artifact.written,
      );
      if (
        await fileSha256(artifactPath) !== artifact.sha256
      ) {
        return { portable: false, verifiedHashes, reportPath };
      }
      verifiedHashes += 1;
    }
  }
  const preparedPaths = [
    portable.player.sourceRoszPath,
    portable.player.enrichedRoszPath,
    ...portable.frozenOpponentArtifacts.map(
      (artifact) => artifact.enrichedRoszPath,
    ),
  ];
  if (!preparedPaths.every(relative)) {
    return { portable: false, verifiedHashes, reportPath };
  }
  for (const artifact of portable.frozenOpponentArtifacts) {
    if (
      await fileSha256(
        path.resolve(
          path.dirname(reportPath),
          artifact.enrichedRoszPath,
        ),
      ) !== artifact.sha256
    ) {
      return { portable: false, verifiedHashes, reportPath };
    }
    verifiedHashes += 1;
  }
  return { portable: true, verifiedHashes, reportPath };
}

function baseReport(input: {
  definition: LiveCanaryDefinition;
  startedAt: string;
  readiness: LiveCanaryReadiness;
  runtime: RuntimeProvenance;
  agentStatus: LocalAgentStatus | null;
  resolvedPaths: Record<string, string | undefined>;
}): RotatingLiveCanaryReport {
  return {
    schemaVersion: 1,
    reportKind: "rosterpilot-rotating-live-canary",
    reportId: crypto.randomUUID(),
    canary: input.definition,
    startedAt: input.startedAt,
    completedAt: input.startedAt,
    status: "unavailable",
    livePass: false,
    evidenceKind: "none",
    readiness: input.readiness,
    runtime: input.runtime,
    localAgent: safeAgentSummary(input.agentStatus),
    profilePolicy: {
      basename:
        input.readiness.requiredPaths[
          LIVE_CANARY_PROFILE_POLICY_ENV
        ]?.basename ?? null,
      sha256: null,
    },
    fixtureInputs: Object.entries(input.resolvedPaths)
      .filter(
        ([requirement]) =>
          requirement !== LIVE_CANARY_PROFILE_POLICY_ENV,
      )
      .map(([requirement, filename]) => ({
        requirement,
        basename: filename ? path.basename(filename) : null,
      })),
    assertions: assertionResults(input.definition),
    run: null,
    revision: null,
    failure: null,
    limitations: [
      "A deterministic or recorded-fixture pass is not a live certification pass.",
      "Tessera results are directional combat math, not game win probability.",
      "RosterPilot never deletes the New Recruit lists created or reused by a canary.",
    ],
  };
}

function liveUnavailableReason(
  code:
    | "LIVE_PROFILE_POLICY_INVALID"
    | "LIVE_FIXTURE_INVALID",
  message: string,
): LiveCanaryUnavailableReason {
  return {
    code,
    message,
    requirement:
      code === "LIVE_PROFILE_POLICY_INVALID"
        ? LIVE_CANARY_PROFILE_POLICY_ENV
        : null,
  };
}

function finalizeReport(
  report: RotatingLiveCanaryReport,
): RotatingLiveCanaryReport {
  report.completedAt = new Date().toISOString();
  if (report.status === "unavailable") {
    report.livePass = false;
    report.evidenceKind = "none";
    return report;
  }
  const allPassed = report.assertions.every(
    (assertion) => assertion.status === "pass",
  );
  report.status = allPassed ? "pass" : "fail";
  report.livePass = allPassed;
  report.evidenceKind = "live";
  if (!allPassed && !report.failure) {
    report.failure = {
      code: "LIVE_CANARY_ASSERTION_FAILED",
      message:
        "One or more required live canary assertions did not pass.",
    };
  }
  return report;
}

async function runAdaptiveNineCanary(input: {
  report: RotatingLiveCanaryReport;
  outputDirectory: string;
  profilePolicyPath: string;
  maxWaitMs: number;
  pollMs: number;
  forcedClientTimeoutMs: number;
  dependencies: LiveCanaryRunnerDependencies;
}): Promise<void> {
  const player = requireRoster(
    input.dependencies.build({
      faction: "adeptus-custodes",
      pointsLimit: 2_000,
      name: "Live Canary Custodes 2000",
    }),
    "The Custodes live-canary player roster",
    input.dependencies,
  );
  const preview = await input.dependencies.preview({
    faction: "aeldari",
    pointsLimit: 2_000,
    suite: "diverse-9",
  });
  if (!preview.ok || !preview.data) {
    throw codedError(
      "PORTFOLIO_CONTRACT_UNMET",
      `The Aeldari adaptive-nine preview failed: ${preview.violations
        .map((violation) => violation.message)
        .join("; ")}`,
    );
  }
  const ready = preview.data.portfolio.items.filter(
    (
      item,
    ): item is (typeof item) & {
      roster: RosterDraftV1;
    } => item.status === "ready" && item.roster !== null,
  );
  const executionFingerprints = ready.map((item) =>
    rosterExecutionFingerprint(item.roster),
  );
  const nineDistinct =
    ready.length === 9 &&
    preview.data.gates.exportable === 9 &&
    preview.data.gates.accepted &&
    preview.data.gates.maximumResultStatus === "complete" &&
    new Set(executionFingerprints).size === 9;
  recordAssertion(
    input.report.assertions,
    "portfolio-nine-distinct",
    nineDistinct,
    {
      ready: ready.length,
      exportable: preview.data.gates.exportable,
      uniqueExecutionFingerprints:
        new Set(executionFingerprints).size,
      portfolioSha256: canonicalSha256(
        preview.data.portfolio,
      ),
    },
  );
  const postures = new Set(
    ready.map((item) => item.posture),
  );
  const threePostures = ([
    "balanced-control",
    "ranged-pressure",
    "assault-pressure",
  ] as const).every((posture) => postures.has(posture));
  recordAssertion(
    input.report.assertions,
    "portfolio-three-postures",
    threePostures,
    { postures: [...postures].sort() },
  );
  if (!nineDistinct || !threePostures) {
    throw codedError(
      "PORTFOLIO_CONTRACT_UNMET",
      "The live canary requires a complete frozen nine-list Aeldari portfolio before external mutation.",
    );
  }
  const policy = await readValidatedPolicy(
    input.profilePolicyPath,
    [
      aggregateProfileRequirements([
        player,
        ...ready.map((item) => item.roster),
      ]),
    ],
    input.outputDirectory,
  );
  input.report.profilePolicy.sha256 = policy.sha256;
  const request = createLiveCanaryRunRequest({
    id: "custodes-vs-adaptive-nine-aeldari-2000",
    playerRoster: player,
    portfolioPreview: preview.data,
    profilePolicyPath: policy.path,
  });
  const job = await input.dependencies.startRun(request, {
    outputDirectory: path.join(
      input.outputDirectory,
      "runs",
    ),
    rootDir: input.outputDirectory,
  });
  input.report.run = {
    runId: job.runId,
    jobPath: portableRunPath(
      input.outputDirectory,
      job.requestPath,
    )!,
    initialAttempt: job.attempt,
    finalAttempt: null,
    finalStatus: null,
    manifestPath: portableRunPath(
      input.outputDirectory,
      job.manifestPath,
    ),
  };
  const completion = waitForTerminalRun(job.requestPath, {
    maxWaitMs: input.maxWaitMs,
    pollMs: input.pollMs,
    dependencies: input.dependencies,
  });
  const clientBoundary = await Promise.race([
    completion.then((terminal) => ({
      kind: "terminal" as const,
      terminal,
    })),
    input.dependencies
      .wait(input.forcedClientTimeoutMs)
      .then(() => ({ kind: "timeout" as const })),
  ]);
  const forcedTimeoutObserved =
    clientBoundary.kind === "timeout";
  recordAssertion(
    input.report.assertions,
    "forced-client-timeout",
    forcedTimeoutObserved,
    {
      timeoutMs: input.forcedClientTimeoutMs,
      durableJobPath: path.relative(
        input.outputDirectory,
        job.requestPath,
      ),
    },
  );
  let terminal: TerminalTesseraRun;
  if (clientBoundary.kind === "timeout") {
    const afterTimeout =
      await input.dependencies.getRunStatus(
        job.requestPath,
        false,
      );
    const active =
      afterTimeout.job.status === "queued" ||
      afterTimeout.job.status === "running";
    const resumed = active
      ? await input.dependencies.resumeRun(job.requestPath)
      : afterTimeout.job;
    const sameRun =
      active &&
      resumed.runId === job.runId &&
      resumed.requestPath === job.requestPath &&
      resumed.attempt === job.attempt;
    recordAssertion(
      input.report.assertions,
      "resume-same-run",
      sameRun,
      {
        statusAtClientBoundary: afterTimeout.job.status,
        originalRunId: job.runId,
        resumedRunId: resumed.runId,
        originalAttempt: job.attempt,
        resumedAttempt: resumed.attempt,
      },
    );
    terminal = await completion;
  } else {
    recordAssertion(
      input.report.assertions,
      "resume-same-run",
      false,
      {
        reason:
          "The live run ended before the forced client-timeout boundary.",
      },
    );
    terminal = clientBoundary.terminal;
  }
  input.report.run.finalAttempt = terminal.job.attempt;
  input.report.run.finalStatus = terminal.job.status;
  input.report.run.manifestPath = portableRunPath(
    input.outputDirectory,
    terminal.job.manifestPath,
  );
  const result = requireCompleteJob(terminal);
  const report = stressReport(result);
  const preparationEvents =
    report.preparation?.connectorEvents ?? [];
  const newRemoteEvents = preparationEvents.filter(
    (event) =>
      event.provider === "new-recruit" &&
      event.action === "prepare" &&
      event.origin === "new-remote" &&
      event.outcome === "verified",
  );
  const remoteIdentities = newRemoteEvents.map(
    (event) =>
      event.remoteId ??
      event.contentSha256 ??
      `missing-${event.eventId}`,
  );
  const deliveryAccounting =
    report.preparation?.uniqueRosters === 10 &&
    (report.preparation.remoteMutations ?? 0) +
      (report.preparation.cacheReuses ?? 0) ===
      10 &&
    new Set(remoteIdentities).size ===
      remoteIdentities.length;
  recordAssertion(
    input.report.assertions,
    "zero-duplicate-delivery",
    deliveryAccounting,
    {
      uniqueRosters:
        report.preparation?.uniqueRosters ?? null,
      remoteMutations:
        report.preparation?.remoteMutations ?? null,
      cacheReuses:
        report.preparation?.cacheReuses ?? null,
      uniqueNewRemoteReceipts:
        new Set(remoteIdentities).size,
      newRemoteReceipts: newRemoteEvents.length,
    },
  );
  const screeningRuns =
    report.stageProvenance.screening.proxyRuns.length;
  const deepDiveRuns =
    report.stageProvenance.deepDive?.proxyRuns.length ?? 0;
  const representativeIds = report.representatives.map(
    (representative) => representative.templateId,
  );
  const stagedComplete =
    report.status === "complete" &&
    report.integrity.status === "verified" &&
    report.configuration.suite === "diverse-9" &&
    report.configuration.analysisStrategy === "staged" &&
    screeningRuns === 9 &&
    deepDiveRuns === 3 &&
    representativeIds.length === 3 &&
    new Set(representativeIds).size === 3 &&
    report.portfolioSha256 ===
      canonicalSha256(preview.data.portfolio);
  recordAssertion(
    input.report.assertions,
    "staged-nine-plus-three",
    stagedComplete,
    {
      reportStatus: report.status,
      integrity: report.integrity.status,
      screeningRuns,
      deepDiveRuns,
      representativeIds,
      frozenPortfolioSha256: report.portfolioSha256,
    },
  );
  const portable = await portableStressEvidence(
    terminal.job,
    report,
  );
  recordAssertion(
    input.report.assertions,
    "portable-artifacts",
    portable.portable,
    {
      reportPath: path.relative(
        input.outputDirectory,
        portable.reportPath,
      ),
      verifiedHashes: portable.verifiedHashes,
    },
  );
}

async function runDistinctFactionCanary(input: {
  report: RotatingLiveCanaryReport;
  outputDirectory: string;
  profilePolicyPath: string;
  maxWaitMs: number;
  pollMs: number;
  dependencies: LiveCanaryRunnerDependencies;
}): Promise<void> {
  const player = requireRoster(
    input.dependencies.build({
      faction: "death-guard",
      pointsLimit: 1_000,
      name: "Live Canary Death Guard 1000",
      // The pinned Death Guard catalogue has several live-observed
      // non-round-tripping optional vehicle loadouts, and Mortarion forces a
      // different Warlord during enrichment. Keep this exact-route canary on
      // a reviewed selection pool whose New Recruit choices are explicit,
      // while those wider faction limitations remain certification findings.
      allowNamedCharacters: false,
      collectionUnitIds: [
        "daemon-prince-of-nurgle-with-wings",
        "daemon-prince-of-nurgle",
        "icon-bearer",
        "plague-surgeon",
        "biologus-putrifier",
        "malignant-plaguecaster",
        "noxious-blightbringer",
        "tallyman",
        "foul-blightspawn",
        "lord-of-poxes",
        "chaos-spawn",
        "poxwalkers",
        "lord-of-virulence",
        "lord-of-contagion",
      ],
    }),
    "The Death Guard live-canary roster",
    input.dependencies,
  );
  const opponent = requireRoster(
    input.dependencies.build({
      faction: "orks",
      pointsLimit: 1_000,
      name: "Live Canary Orks 1000",
    }),
    "The Orks live-canary roster",
    input.dependencies,
  );
  const playerFingerprint =
    rosterExecutionFingerprint(player);
  const opponentFingerprint =
    rosterExecutionFingerprint(opponent);
  const distinct =
    player.factionId !== opponent.factionId &&
    playerFingerprint !== opponentFingerprint;
  recordAssertion(
    input.report.assertions,
    "distinct-factions",
    distinct,
    {
      playerFactionId: player.factionId,
      opponentFactionId: opponent.factionId,
      playerFingerprint,
      opponentFingerprint,
    },
  );
  const pointsContract =
    matchedPoints([player, opponent]) &&
    sourcePinsCompatible(player, opponent);
  recordAssertion(
    input.report.assertions,
    "matched-points-contract",
    pointsContract,
    {
      playerPointsLimit: player.pointsLimit,
      playerTotalPoints: player.totalPoints,
      opponentPointsLimit: opponent.pointsLimit,
      opponentTotalPoints: opponent.totalPoints,
      sourcePinMatched: sourcePinsCompatible(player, opponent),
    },
  );
  const policy = await readValidatedPolicy(
    input.profilePolicyPath,
    [aggregateProfileRequirements([player, opponent])],
    input.outputDirectory,
  );
  input.report.profilePolicy.sha256 = policy.sha256;
  const request = createLiveCanaryRunRequest({
    id: "death-guard-vs-orks-exact-1000",
    playerRoster: player,
    opponentRoster: opponent,
    profilePolicyPath: policy.path,
  });
  const exactRoute =
    request.kind === "exact" &&
    request.opponent.kind === "roster" &&
    request.opponent.roster.factionId === "orks";
  recordAssertion(
    input.report.assertions,
    "exact-route",
    exactRoute,
    {
      runKind: request.kind,
      opponentKind:
        request.kind === "exact"
          ? request.opponent.kind
          : null,
      renamedMirror: false,
    },
  );
  if (!distinct || !pointsContract || !exactRoute) {
    throw codedError(
      "LIVE_CANARY_EXACT_PREFLIGHT_FAILED",
      "The distinct-faction exact canary failed its local roster contract.",
    );
  }
  const job = await input.dependencies.startRun(request, {
    outputDirectory: path.join(
      input.outputDirectory,
      "runs",
    ),
    rootDir: input.outputDirectory,
  });
  input.report.run = {
    runId: job.runId,
    jobPath: portableRunPath(
      input.outputDirectory,
      job.requestPath,
    )!,
    initialAttempt: job.attempt,
    finalAttempt: null,
    finalStatus: null,
    manifestPath: portableRunPath(
      input.outputDirectory,
      job.manifestPath,
    ),
  };
  const terminal = await waitForTerminalRun(job.requestPath, {
    maxWaitMs: input.maxWaitMs,
    pollMs: input.pollMs,
    dependencies: input.dependencies,
  });
  input.report.run.finalAttempt = terminal.job.attempt;
  input.report.run.finalStatus = terminal.job.status;
  input.report.run.manifestPath = portableRunPath(
    input.outputDirectory,
    terminal.job.manifestPath,
  );
  const report = matchupReport(requireCompleteJob(terminal));
  if (!report.configuration) {
    throw codedError(
      "LIVE_CANARY_CONFIGURATION_MISSING",
      "The exact matchup report omitted its frozen configuration.",
    );
  }
  const expectedScenarios =
    report.opponents.length *
    report.configuration.phases.length *
    report.configuration.directions.length;
  const scenarios = report.simulation?.scenarios ?? [];
  const completeEvidence =
    report.status === "complete" &&
    report.source === "tessera-ui" &&
    report.comparisonClass === "matched" &&
    report.opponents.length === 1 &&
    scenarios.length === expectedScenarios &&
    scenarios.every(
      (scenario) => scenario.status === "complete",
    );
  recordAssertion(
    input.report.assertions,
    "complete-exact-evidence",
    completeEvidence,
    {
      reportStatus: report.status,
      source: report.source,
      comparisonClass: report.comparisonClass,
      expectedScenarios,
      completedScenarios: scenarios.filter(
        (scenario) => scenario.status === "complete",
      ).length,
    },
  );
  const connectorEvents = report.connectorEvents ?? [];
  const provenance =
    typeof report.tesseraUiIdentity === "string" &&
    report.tesseraUiIdentity.length > 0 &&
    connectorEvents.some(
      (event) =>
        event.provider === "new-recruit" &&
        event.action === "prepare" &&
        (event.outcome === "verified" ||
          event.outcome === "reused"),
    ) &&
    connectorEvents.some(
      (event) =>
        event.provider === "tessera" &&
        event.action === "simulate" &&
        event.outcome === "verified",
    );
  recordAssertion(
    input.report.assertions,
    "tessera-ui-provenance",
    provenance,
    {
      tesseraUiIdentity: report.tesseraUiIdentity,
      connectorEventCount: connectorEvents.length,
    },
  );
}

function uploadedUnitMultisetMatches(
  context: RosterDraftV1,
  summary: ReturnType<typeof inspectEnrichedRosz>,
): boolean {
  const canonical = context.units
    .map((unit) =>
      [
        normalized(unit.name),
        unit.modelCount,
        unit.points,
      ].join(":"),
    )
    .sort();
  const uploaded = summary.units
    .map((unit) =>
      [
        normalized(unit.name),
        unit.modelCount,
        unit.points ?? "",
      ].join(":"),
    )
    .sort();
  return JSON.stringify(canonical) === JSON.stringify(uploaded);
}

async function runUploadedRevisionCanary(input: {
  report: RotatingLiveCanaryReport;
  outputDirectory: string;
  profilePolicyPath: string;
  opponentRoszPath: string;
  opponentContextPath: string;
  playerRosterPath: string;
  revisedRosterPath: string;
  maxWaitMs: number;
  pollMs: number;
  dependencies: LiveCanaryRunnerDependencies;
}): Promise<void> {
  const [player, opponentContext, revised, opponentRosz] =
    await Promise.all([
      readCanonicalRoster(
        input.playerRosterPath,
        "The live-canary player fixture",
        input.dependencies,
      ),
      readCanonicalRoster(
        input.opponentContextPath,
        "The uploaded opponent context fixture",
        input.dependencies,
      ),
      readCanonicalRoster(
        input.revisedRosterPath,
        "The paired-revision roster fixture",
        input.dependencies,
      ),
      readFile(input.opponentRoszPath),
    ]);
  let uploadedSummary: ReturnType<
    typeof inspectEnrichedRosz
  >;
  let uploadedRequirements: TesseraProfileRequirement[];
  try {
    uploadedSummary = inspectEnrichedRosz(opponentRosz);
    uploadedRequirements =
      inspectEnrichedProfileRequirements(
        opponentRosz,
        opponentContext.factionId,
      );
  } catch (error) {
    throw codedError(
      "LIVE_FIXTURE_INVALID",
      `The uploaded ROSZ fixture could not be inspected: ${errorMessage(
        error,
        "unknown archive error",
      )}`,
    );
  }
  const multiProfile = uploadedRequirements.length > 0;
  recordAssertion(
    input.report.assertions,
    "uploaded-multiprofile-observed",
    multiProfile,
    {
      profileRequirementCount:
        uploadedRequirements.length,
      weaponGroups: uploadedRequirements.map(
        (requirement) =>
          `${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase}`,
      ),
    },
  );
  if (!multiProfile) {
    throw codedError(
      "LIVE_FIXTURE_INVALID",
      "The configured uploaded ROSZ exposes no explicit alternate weapon-profile decision.",
    );
  }
  const baselineFingerprint =
    rosterExecutionFingerprint(player);
  const revisedFingerprint =
    rosterExecutionFingerprint(revised);
  const contextVerified =
    player.factionId === revised.factionId &&
    baselineFingerprint !== revisedFingerprint &&
    sourcePinsCompatible(player, revised) &&
    sourcePinsCompatible(player, opponentContext) &&
    matchedPoints([player, opponentContext, revised]) &&
    uploadedSummary.totalPoints ===
      opponentContext.totalPoints &&
    factionNamesCompatible(
      uploadedSummary.factionName,
      opponentContext.factionName,
    ) &&
    uploadedUnitMultisetMatches(
      opponentContext,
      uploadedSummary,
    );
  if (!contextVerified) {
    throw codedError(
      "LIVE_FIXTURE_INVALID",
      "The uploaded archive, canonical opponent context, baseline roster, and revised roster do not share the required faction, points, unit, revision, and source-pin contract.",
    );
  }
  const baselineRequirements = mergedRequirements([
    aggregateProfileRequirements([
      player,
      opponentContext,
    ]),
    uploadedRequirements,
  ]);
  const revisedRequirements = mergedRequirements([
    aggregateProfileRequirements([
      revised,
      opponentContext,
    ]),
    uploadedRequirements,
  ]);
  const policy = await readValidatedPolicy(
    input.profilePolicyPath,
    [baselineRequirements],
    input.outputDirectory,
  );
  const revisedPolicyValidation = validateProfilePolicy(
    revisedRequirements,
    policy.policy,
  );
  if (!revisedPolicyValidation.valid) {
    throw codedError(
      "LIVE_PROFILE_POLICY_INVALID",
      "The same frozen profile policy must exactly resolve both the baseline and revised matchup inventories.",
    );
  }
  input.report.profilePolicy.sha256 = policy.sha256;
  const request = createLiveCanaryRunRequest({
    id: "uploaded-multiprofile-exact-paired-revision",
    playerRoster: player,
    opponentRosterContext: opponentContext,
    opponentRoszPath: input.opponentRoszPath,
    profilePolicyPath: policy.path,
  });
  const job = await input.dependencies.startRun(request, {
    outputDirectory: path.join(
      input.outputDirectory,
      "runs",
    ),
    rootDir: input.outputDirectory,
  });
  input.report.run = {
    runId: job.runId,
    jobPath: portableRunPath(
      input.outputDirectory,
      job.requestPath,
    )!,
    initialAttempt: job.attempt,
    finalAttempt: null,
    finalStatus: null,
    manifestPath: portableRunPath(
      input.outputDirectory,
      job.manifestPath,
    ),
  };
  const terminal = await waitForTerminalRun(job.requestPath, {
    maxWaitMs: input.maxWaitMs,
    pollMs: input.pollMs,
    dependencies: input.dependencies,
  });
  input.report.run.finalAttempt = terminal.job.attempt;
  input.report.run.finalStatus = terminal.job.status;
  input.report.run.manifestPath = portableRunPath(
    input.outputDirectory,
    terminal.job.manifestPath,
  );
  const baseline = matchupReport(requireCompleteJob(terminal));
  const baselineComplete =
    baseline.status === "complete" &&
    baseline.source === "tessera-ui" &&
    baseline.opponents.length === 1 &&
    baseline.profilePolicyHash === policy.sha256 &&
    typeof baseline.tesseraUiIdentity === "string" &&
    baseline.tesseraUiIdentity.length > 0;
  recordAssertion(
    input.report.assertions,
    "uploaded-context-verified",
    contextVerified && baselineComplete,
    {
      opponentFactionId: opponentContext.factionId,
      uploadedPoints: uploadedSummary.totalPoints,
      canonicalPoints: opponentContext.totalPoints,
      sourcePinMatched: sourcePinsCompatible(
        player,
        opponentContext,
      ),
    },
  );
  recordAssertion(
    input.report.assertions,
    "baseline-exact-complete",
    baselineComplete,
    {
      baselineRunId: baseline.runId,
      status: baseline.status,
      profilePolicyHash: baseline.profilePolicyHash,
      tesseraUiIdentity: baseline.tesseraUiIdentity,
    },
  );
  if (!baselineComplete) {
    throw codedError(
      "LIVE_CANARY_BASELINE_INCOMPLETE",
      "The uploaded-roster exact baseline did not produce complete trusted evidence.",
    );
  }
  const baselineReportPath = reportArtifactPath(
    terminal.job,
    baseline,
    "matchup-json",
  );
  const compared = await input.dependencies.compareRevision(
    baselineReportPath,
    revised,
    {
      executionMode: "simulate",
      experimental: false,
      profilePolicyPath:
        terminal.job.profilePolicyPath ??
        policy.path,
      outputDirectory: path.join(
        input.outputDirectory,
        "revision",
      ),
      rootDir: input.outputDirectory,
    },
  );
  const revisionComplete =
    compared.ok &&
    compared.data !== null &&
    compared.data.revisedReports.length ===
      baseline.opponents.length &&
    compared.data.revisedReports.every(
      (report) =>
        report.status === "complete" &&
        report.source === "tessera-ui",
    );
  recordAssertion(
    input.report.assertions,
    "paired-revision-complete",
    revisionComplete,
    {
      violationCodes: compared.violations.map(
        (violation) => violation.code,
      ),
      revisedReportCount:
        compared.data?.revisedReports.length ?? 0,
    },
  );
  if (!compared.ok || !compared.data) {
    throw codedError(
      compared.violations[0]?.code ??
        "LIVE_CANARY_REVISION_FAILED",
      compared.violations[0]?.message ??
        "The paired revision did not complete.",
    );
  }
  const revision: TesseraRevisionComparisonReport =
    compared.data;
  const frozenEvidence =
    revision.baselineRunId === baseline.runId &&
    revision.revisedRosterFingerprint ===
      revisedFingerprint &&
    revision.revisedReports.every(
      (report) =>
        report.profilePolicyHash ===
          baseline.profilePolicyHash &&
        report.tesseraUiIdentity ===
          baseline.tesseraUiIdentity &&
        report.opponents.length ===
          baseline.opponents.length &&
        report.opponents.every((opponent, index) => {
          const frozen = baseline.opponents[index];
          return (
            frozen !== undefined &&
            opponent.enrichedRoszSha256 ===
              frozen.enrichedRoszSha256 &&
            opponent.fingerprint === frozen.fingerprint
          );
        }),
    ) &&
    revision.summary.conclusionBasis ===
      "trusted-roster-aggregates" &&
    typeof revision.summary.conclusion === "string";
  recordAssertion(
    input.report.assertions,
    "paired-evidence-frozen",
    frozenEvidence,
    {
      baselineRunId: baseline.runId,
      revisionBaselineRunId: revision.baselineRunId,
      conclusionBasis:
        revision.summary.conclusionBasis ?? null,
      conclusion: revision.summary.conclusion ?? null,
    },
  );
  input.report.revision = {
    baselineRunId: baseline.runId,
    revisionRunId: revision.runId,
    conclusion: revision.summary.conclusion ?? null,
    artifactPaths: revision.artifacts.map((artifact) =>
      path.relative(
        input.outputDirectory,
        artifact.written,
      ),
    ),
  };
}

export async function runRotatingLiveCanary(
  input: RunRotatingLiveCanaryInput,
  injectedDependencies: Partial<LiveCanaryRunnerDependencies> = {},
): Promise<RotatingLiveCanaryReport> {
  const dependencies = {
    ...defaultDependencies,
    ...injectedDependencies,
  };
  const environment = input.environment ?? process.env;
  const definition = liveCanaryDefinition(input.canaryId);
  const startedAt = new Date().toISOString();
  const collected = await collectReadiness({
    definition,
    environment,
    profilePolicyPath: input.profilePolicyPath,
    dependencies,
  });
  const report = baseReport({
    definition,
    startedAt,
    readiness: collected.readiness,
    runtime: collected.runtime,
    agentStatus: collected.agentStatus,
    resolvedPaths: collected.resolvedPaths,
  });
  if (collected.readiness.status === "unavailable") {
    return finalizeReport(report);
  }
  const profilePolicyPath =
    collected.resolvedPaths[
      LIVE_CANARY_PROFILE_POLICY_ENV
    ];
  if (!profilePolicyPath) {
    return finalizeReport(report);
  }
  report.status = "fail";
  report.evidenceKind = "live";
  const maxWaitMs = input.maxWaitMs ?? 90 * 60_000;
  const pollMs = input.pollMs ?? 2_000;
  const forcedClientTimeoutMs =
    input.forcedClientTimeoutMs ?? 100;
  try {
    if (
      definition.id ===
      "custodes-vs-adaptive-nine-aeldari-2000"
    ) {
      await runAdaptiveNineCanary({
        report,
        outputDirectory: input.outputDirectory,
        profilePolicyPath,
        maxWaitMs,
        pollMs,
        forcedClientTimeoutMs,
        dependencies,
      });
    } else if (
      definition.id ===
      "death-guard-vs-orks-exact-1000"
    ) {
      await runDistinctFactionCanary({
        report,
        outputDirectory: input.outputDirectory,
        profilePolicyPath,
        maxWaitMs,
        pollMs,
        dependencies,
      });
    } else {
      const opponentRoszPath =
        collected.resolvedPaths[
          LIVE_CANARY_FIXTURE_ENV.opponentRosz
        ];
      const opponentContextPath =
        collected.resolvedPaths[
          LIVE_CANARY_FIXTURE_ENV.opponentContext
        ];
      const playerRosterPath =
        collected.resolvedPaths[
          LIVE_CANARY_FIXTURE_ENV.playerRoster
        ];
      const revisedRosterPath =
        collected.resolvedPaths[
          LIVE_CANARY_FIXTURE_ENV.revisedRoster
        ];
      if (
        !opponentRoszPath ||
        !opponentContextPath ||
        !playerRosterPath ||
        !revisedRosterPath
      ) {
        return finalizeReport(report);
      }
      await runUploadedRevisionCanary({
        report,
        outputDirectory: input.outputDirectory,
        profilePolicyPath,
        opponentRoszPath,
        opponentContextPath,
        playerRosterPath,
        revisedRosterPath,
        maxWaitMs,
        pollMs,
        dependencies,
      });
    }
  } catch (error) {
    const code = errorCode(
      error,
      "LIVE_CANARY_EXECUTION_FAILED",
    );
    const message = errorMessage(
      error,
      "The rotating live canary failed.",
    );
    if (
      code === "LIVE_PROFILE_POLICY_INVALID" ||
      code === "LIVE_FIXTURE_INVALID"
    ) {
      report.status = "unavailable";
      report.evidenceKind = "none";
      report.readiness = {
        ...report.readiness,
        status: "unavailable",
        reasons: [
          ...report.readiness.reasons,
          liveUnavailableReason(code, message),
        ],
      };
    } else {
      report.failure = { code, message };
      report.status = "fail";
    }
  }
  return finalizeReport(report);
}

export async function writeRotatingLiveCanaryReport(
  report: RotatingLiveCanaryReport,
  outputDirectory: string,
): Promise<{
  reportPath: string;
  checksumPath: string;
  sha256: string;
}> {
  await mkdir(outputDirectory, {
    recursive: true,
    mode: 0o700,
  });
  const filename = [
    "live-canary",
    report.canary.id,
    report.reportId,
  ].join("-");
  const reportPath = path.join(
    outputDirectory,
    `${filename}.json`,
  );
  const checksumPath = `${reportPath}.sha256`;
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const contentHash = sha256(content);
  const temporaryReport = `${reportPath}.${process.pid}.tmp`;
  const temporaryChecksum = `${checksumPath}.${process.pid}.tmp`;
  await writeFile(temporaryReport, content, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    temporaryChecksum,
    `${contentHash}  ${path.basename(reportPath)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await rename(temporaryReport, reportPath);
  await rename(temporaryChecksum, checksumPath);
  return { reportPath, checksumPath, sha256: contentHash };
}
