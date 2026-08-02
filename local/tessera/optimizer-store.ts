import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  ProfilePolicyV1,
  RosterDraftV1,
  RuntimeProvenance,
  TesseraMatchupReport,
  TesseraRevisionComparisonReport,
  TesseraStressRevisionReport,
  TesseraStressTestReport,
} from "../../lib/rosterpilot/types";
import { stampRosterDataIdentity } from "../../lib/rosterpilot/draft";
import { getRuntimeProvenance } from "../runtime-provenance";
import {
  approveTesseraOptimizerCandidateBatch,
  approvedTesseraOptimizerComparisonRequests,
  approveTesseraOptimizerWinner,
  createTesseraOptimizerState,
  deriveTesseraOptimizerFrozenIdentities,
  finalizeTesseraOptimizer,
  materializeApprovedTesseraOptimizerCandidates,
  recordTesseraOptimizerComparison,
  retainTesseraOptimizerBaseline,
  tesseraOptimizerCanonicalSha256,
  verifyTesseraOptimizerState,
  type TesseraOptimizerCandidateQualifier,
  type TesseraOptimizerComparisonRequest,
  type TesseraOptimizerDeliveryIntent,
  type TesseraOptimizerIssue,
  type TesseraOptimizerMode,
  type TesseraOptimizerResult,
  type TesseraOptimizerState,
} from "./optimizer";
import { ProfilePolicySchema } from "./profile-policy";

const optimizerStoreSchemaVersion = 1;
const optimizerLockStaleMs = 30_000;
const optimizerLockWaitMs = 5_000;
const optimizerIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type TesseraOptimizerStoredArtifact = {
  kind:
    | "baseline-report"
    | "profile-policy"
    | "candidate-roster"
    | "comparison-report"
    | "final-roster";
  candidateId: string | null;
  path: string;
  sha256: string;
};

export type TesseraOptimizerStoreDocument = {
  schemaVersion: 1;
  documentKind: "rosterpilot-tessera-optimizer-store";
  optimizerRunId: string;
  optimizerDirectory: string;
  rootDirectory: string;
  statePath: string;
  baselineReportArtifact: TesseraOptimizerStoredArtifact;
  profilePolicyArtifact: TesseraOptimizerStoredArtifact | null;
  candidateRosterArtifacts: TesseraOptimizerStoredArtifact[];
  comparisonArtifacts: TesseraOptimizerStoredArtifact[];
  finalRosterArtifact: TesseraOptimizerStoredArtifact | null;
  state: TesseraOptimizerState;
  documentSha256: string;
};

export type TesseraOptimizerStoreSnapshot = {
  statePath: string;
  optimizerDirectory: string;
  state: TesseraOptimizerState;
  comparisonRequests: TesseraOptimizerComparisonRequest[];
  baselineReportArtifact: TesseraOptimizerStoredArtifact;
  profilePolicyArtifact: TesseraOptimizerStoredArtifact | null;
  candidateRosterArtifacts: TesseraOptimizerStoredArtifact[];
  comparisonArtifacts: TesseraOptimizerStoredArtifact[];
  finalRosterArtifact: TesseraOptimizerStoredArtifact | null;
};

export type TesseraOptimizerStoreResult = TesseraOptimizerResult<
  TesseraOptimizerStoreSnapshot
>;

export type TesseraOptimizerStoreAccessOptions = {
  evaluationRuntime?: RuntimeProvenance;
};

export type StartTesseraOptimizerInput = {
  baselineReportPath?: string;
  baselineReport?: TesseraMatchupReport | TesseraStressTestReport;
  baselineRosterPath?: string;
  baselineRoster?: RosterDraftV1;
  mode?: TesseraOptimizerMode;
  profilePolicyPath?: string;
  profilePolicy?: ProfilePolicyV1;
  evaluationRuntime?: RuntimeProvenance;
  outputDirectory?: string;
  rootDir?: string;
  allowOutsideRoot?: boolean;
  optimizerRunId?: string;
  createdAt?: string;
};

function issue(code: string, message: string): TesseraOptimizerIssue {
  return { code, message, severity: "error" };
}

function failure(
  violation: TesseraOptimizerIssue,
  data: TesseraOptimizerStoreSnapshot | null = null,
): TesseraOptimizerStoreResult {
  return {
    ok: false,
    data,
    violations: [violation],
    warnings: [],
  };
}

function contentSha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function documentHash(
  document: Omit<TesseraOptimizerStoreDocument, "documentSha256"> & {
    documentSha256?: string;
  },
): string {
  return tesseraOptimizerCanonicalSha256({
    ...document,
    documentSha256: undefined,
  });
}

function sealDocument(
  document: Omit<TesseraOptimizerStoreDocument, "documentSha256"> & {
    documentSha256?: string;
  },
): TesseraOptimizerStoreDocument {
  const pending = {
    ...document,
    documentSha256: "",
  } as TesseraOptimizerStoreDocument;
  return {
    ...pending,
    documentSha256: documentHash(pending),
  };
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

function filesystemErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

async function filesystemPathInside(
  root: string,
  candidate: string,
): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const physicalRoot = await realpath(resolvedRoot);
  let existingAncestor = resolvedCandidate;
  for (;;) {
    try {
      const physicalAncestor = await realpath(existingAncestor);
      const unresolvedSuffix = path.relative(
        existingAncestor,
        resolvedCandidate,
      );
      return pathInside(
        physicalRoot,
        path.resolve(physicalAncestor, unresolvedSuffix),
      );
    } catch (error) {
      if (
        filesystemErrorCode(error) !== "ENOENT" &&
        filesystemErrorCode(error) !== "ENOTDIR"
      ) {
        throw error;
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return false;
      existingAncestor = parent;
    }
  }
}

function safeArtifactSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || contentSha256(value).slice(0, 16);
}

async function writeJsonAtomic(
  filename: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeFrozenArtifact(
  filename: string,
  content: Buffer | string,
): Promise<string> {
  const expected = contentSha256(content);
  try {
    await writeFile(filename, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : null;
    if (code !== "EEXIST") throw error;
    const observed = await readFile(filename);
    if (contentSha256(observed) !== expected) {
      throw Object.assign(
        new Error("A frozen optimizer artifact already exists with different content."),
        { code: "TESSERA_OPTIMIZER_ARTIFACT_CONFLICT" },
      );
    }
  }
  return expected;
}

async function assertWritableBase(
  rootDirectory: string,
  baseDirectory: string,
  allowOutsideRoot: boolean,
): Promise<void> {
  if (!allowOutsideRoot && !pathInside(rootDirectory, baseDirectory)) {
    throw Object.assign(
      new Error("The optimizer output directory is outside the allowed write root."),
      { code: "TESSERA_OPTIMIZER_OUTPUT_OUTSIDE_ROOT" },
    );
  }
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  if (
    !allowOutsideRoot &&
    !(await filesystemPathInside(rootDirectory, baseDirectory))
  ) {
    throw Object.assign(
      new Error("The optimizer output directory resolves outside the allowed write root."),
      { code: "TESSERA_OPTIMIZER_OUTPUT_OUTSIDE_ROOT" },
    );
  }
  await mkdir(baseDirectory, { recursive: true, mode: 0o700 });
  if (!allowOutsideRoot) {
    const [realRoot, realBase] = await Promise.all([
      realpath(rootDirectory),
      realpath(baseDirectory),
    ]);
    if (!pathInside(realRoot, realBase)) {
      throw Object.assign(
        new Error("The optimizer output directory resolves outside the allowed write root."),
        { code: "TESSERA_OPTIMIZER_OUTPUT_OUTSIDE_ROOT" },
      );
    }
  }
}

function allArtifacts(
  document: TesseraOptimizerStoreDocument,
): TesseraOptimizerStoredArtifact[] {
  return [
    document.baselineReportArtifact,
    ...(document.profilePolicyArtifact
      ? [document.profilePolicyArtifact]
      : []),
    ...document.candidateRosterArtifacts,
    ...document.comparisonArtifacts,
    ...(document.finalRosterArtifact
      ? [document.finalRosterArtifact]
      : []),
  ];
}

async function validateDocument(
  document: TesseraOptimizerStoreDocument,
  resolvedStatePath: string,
): Promise<TesseraOptimizerIssue | null> {
  if (
    document.schemaVersion !== optimizerStoreSchemaVersion ||
    document.documentKind !== "rosterpilot-tessera-optimizer-store" ||
    document.optimizerRunId !== document.state.optimizerRunId ||
    document.statePath !== resolvedStatePath ||
    document.optimizerDirectory !== path.dirname(resolvedStatePath) ||
    document.documentSha256 !== documentHash(document)
  ) {
    return issue(
      "TESSERA_OPTIMIZER_STORE_TAMPERED",
      "The optimizer store document or its storage identity is invalid.",
    );
  }
  const stateVerification = verifyTesseraOptimizerState(document.state);
  if (!stateVerification.ok) {
    return stateVerification.violations[0] ?? issue(
      "TESSERA_OPTIMIZER_STATE_INVALID",
      "The stored optimizer state failed integrity verification.",
    );
  }
  if (
    !pathInside(document.optimizerDirectory, document.statePath) ||
    allArtifacts(document).some(
      (artifact) =>
        !pathInside(document.optimizerDirectory, artifact.path) ||
        artifact.sha256.length !== 64,
    )
  ) {
    return issue(
      "TESSERA_OPTIMIZER_STORE_PATH_INVALID",
      "An optimizer artifact path escapes its frozen optimizer directory.",
    );
  }
  for (const artifact of allArtifacts(document)) {
    try {
      const metadata = await lstat(artifact.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return issue(
          "TESSERA_OPTIMIZER_ARTIFACT_INVALID",
          `The frozen ${artifact.kind} artifact is not a regular file.`,
        );
      }
      if (contentSha256(await readFile(artifact.path)) !== artifact.sha256) {
        return issue(
          "TESSERA_OPTIMIZER_ARTIFACT_CHANGED",
          `The frozen ${artifact.kind} artifact no longer matches its receipt.`,
        );
      }
    } catch (error) {
      return issue(
        "TESSERA_OPTIMIZER_ARTIFACT_UNAVAILABLE",
        `The frozen ${artifact.kind} artifact could not be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return null;
}

async function readDocument(
  statePath: string,
): Promise<TesseraOptimizerStoreDocument> {
  const resolved = path.resolve(statePath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw Object.assign(
      new Error("The optimizer state path is not a regular file."),
      { code: "TESSERA_OPTIMIZER_STORE_PATH_INVALID" },
    );
  }
  const parsed = JSON.parse(
    await readFile(resolved, "utf8"),
  ) as TesseraOptimizerStoreDocument;
  const invalid = await validateDocument(parsed, resolved);
  if (invalid) {
    throw Object.assign(new Error(invalid.message), { code: invalid.code });
  }
  return parsed;
}

function errorIssue(error: unknown): TesseraOptimizerIssue {
  const code =
    error && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "TESSERA_OPTIMIZER_STORE_FAILED";
  return issue(
    code,
    error instanceof Error ? error.message : String(error),
  );
}

async function acquireLock(statePath: string): Promise<() => Promise<void>> {
  const lockPath = `${statePath}.lock`;
  const startedAt = Date.now();
  const token = randomUUID();
  for (;;) {
    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return async () => {
        const observed = await readFile(lockPath, "utf8")
          .then((content) => JSON.parse(content) as { token?: string })
          .catch(() => null);
        if (observed?.token === token) {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;
      if (code !== "EEXIST") throw error;
      const metadata = await stat(lockPath).catch(() => null);
      const ownerPid = await readFile(lockPath, "utf8")
        .then((content) => {
          const parsed = JSON.parse(content) as { pid?: unknown };
          return typeof parsed.pid === "number" ? parsed.pid : null;
        })
        .catch(() => null);
      let ownerIsAlive = false;
      if (ownerPid !== null) {
        try {
          process.kill(ownerPid, 0);
          ownerIsAlive = true;
        } catch (ownerError) {
          ownerIsAlive = filesystemErrorCode(ownerError) === "EPERM";
        }
      }
      if (
        metadata &&
        !ownerIsAlive &&
        Date.now() - metadata.mtimeMs > optimizerLockStaleMs
      ) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= optimizerLockWaitMs) {
        throw Object.assign(
          new Error("Another optimizer transition still holds the state lock."),
          { code: "TESSERA_OPTIMIZER_STORE_BUSY" },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function profilePolicyFor(
  document: TesseraOptimizerStoreDocument,
): Promise<ProfilePolicyV1 | null> {
  if (!document.profilePolicyArtifact) return null;
  const content = await readFile(document.profilePolicyArtifact.path);
  if (contentSha256(content) !== document.profilePolicyArtifact.sha256) {
    throw Object.assign(
      new Error("The frozen optimizer profile policy changed."),
      { code: "TESSERA_OPTIMIZER_PROFILE_ARTIFACT_CHANGED" },
    );
  }
  return ProfilePolicySchema.parse(JSON.parse(content.toString("utf8")));
}

function activeBundleIdentity(
  roster: RosterDraftV1,
): TesseraOptimizerState["frozenIdentities"]["bundle"] {
  const activeSource = stampRosterDataIdentity(
    structuredClone(roster),
  ).sourceData;
  const activeSemanticSource = {
    bundleId: activeSource.bundleId,
    engineDataSchemaVersion: activeSource.engineDataSchemaVersion,
    rosterRulesHash: activeSource.rosterRulesHash,
    factionRulesHash: activeSource.factionRulesHash,
    mappingHash: activeSource.mappingHash,
    entityHashesSha256: tesseraOptimizerCanonicalSha256(
      activeSource.entityHashes,
    ),
  };
  return {
    ...activeSemanticSource,
    semanticIdentitySha256: tesseraOptimizerCanonicalSha256(
      activeSemanticSource,
    ),
    provenanceSha256: tesseraOptimizerCanonicalSha256({
      package: activeSource.package,
      version: activeSource.version,
      edition: activeSource.edition,
      dataslate: activeSource.dataslate,
      releaseId: activeSource.releaseId,
      newRecruit: activeSource.newRecruit,
      official: activeSource.official,
    }),
  };
}

async function currentIdentities(
  document: TesseraOptimizerStoreDocument,
  evaluationRuntime: RuntimeProvenance,
) {
  const reportContent = await readFile(
    document.baselineReportArtifact.path,
  );
  if (contentSha256(reportContent) !== document.baselineReportArtifact.sha256) {
    throw Object.assign(
      new Error("The frozen optimizer baseline report changed."),
      { code: "TESSERA_OPTIMIZER_BASELINE_ARTIFACT_CHANGED" },
    );
  }
  const baselineReport = JSON.parse(
    reportContent.toString("utf8"),
  ) as TesseraMatchupReport | TesseraStressTestReport;
  const policy = await profilePolicyFor(document);
  const derived = deriveTesseraOptimizerFrozenIdentities({
    mode: document.state.mode,
    optimizerRunId: document.optimizerRunId,
    createdAt: document.state.createdAt,
    baselineReportPath: document.baselineReportArtifact.path,
    baselineReport,
    baselineReportArtifactSha256:
      document.baselineReportArtifact.sha256,
    baselineEvidenceArtifactSha256:
      document.state.frozenIdentities.baseline.evidenceArtifactSha256,
    baselineRoster: document.state.baseline.roster,
    evaluationRuntime,
    profilePolicy: policy,
    profilePolicyPath: document.profilePolicyArtifact?.path ?? null,
    profilePolicyArtifactSha256:
      document.profilePolicyArtifact?.sha256 ?? null,
    heuristicParameters: document.state.heuristicParameters,
  });
  if (!derived.ok || !derived.data) {
    throw Object.assign(
      new Error(
        derived.violations[0]?.message ??
          "The current optimizer identities could not be derived.",
      ),
      {
        code:
          derived.violations[0]?.code ??
          "TESSERA_OPTIMIZER_IDENTITY_INVALID",
      },
    );
  }
  const activeBundle = activeBundleIdentity(
    document.state.baseline.roster,
  );
  const withoutContext = {
    ...derived.data,
    bundle: activeBundle,
    contextSha256: undefined,
  };
  return {
    ...withoutContext,
    contextSha256: tesseraOptimizerCanonicalSha256(withoutContext),
  };
}

function comparisonRequestsFor(
  state: TesseraOptimizerState,
  identities: TesseraOptimizerState["frozenIdentities"],
): TesseraOptimizerComparisonRequest[] {
  const requests = approvedTesseraOptimizerComparisonRequests(
    state,
    identities,
  );
  return requests.ok && requests.data ? requests.data : [];
}

function snapshot(
  document: TesseraOptimizerStoreDocument,
  identities = document.state.frozenIdentities,
): TesseraOptimizerStoreSnapshot {
  return {
    statePath: document.statePath,
    optimizerDirectory: document.optimizerDirectory,
    state: structuredClone(document.state),
    comparisonRequests: comparisonRequestsFor(document.state, identities),
    baselineReportArtifact: structuredClone(
      document.baselineReportArtifact,
    ),
    profilePolicyArtifact: structuredClone(
      document.profilePolicyArtifact,
    ),
    candidateRosterArtifacts: structuredClone(
      document.candidateRosterArtifacts,
    ),
    comparisonArtifacts: structuredClone(
      document.comparisonArtifacts,
    ),
    finalRosterArtifact: structuredClone(
      document.finalRosterArtifact,
    ),
  };
}

function resultFromCore(
  core: TesseraOptimizerResult<TesseraOptimizerState>,
  document: TesseraOptimizerStoreDocument,
  identities: TesseraOptimizerState["frozenIdentities"],
): TesseraOptimizerStoreResult {
  return {
    ok: core.ok,
    data: snapshot(document, identities),
    violations: core.violations,
    warnings: core.warnings,
  };
}

async function rawReportInput(
  input: StartTesseraOptimizerInput,
): Promise<{
  report: TesseraMatchupReport | TesseraStressTestReport;
  content: Buffer;
}> {
  if (input.baselineReport) {
    const content = Buffer.from(
      `${JSON.stringify(input.baselineReport, null, 2)}\n`,
      "utf8",
    );
    return {
      report: structuredClone(input.baselineReport),
      content,
    };
  }
  if (!input.baselineReportPath) {
    throw Object.assign(
      new Error("Starting an optimizer requires a baseline report path or object."),
      { code: "TESSERA_OPTIMIZER_BASELINE_REQUIRED" },
    );
  }
  const content = await readFile(path.resolve(input.baselineReportPath));
  return {
    report: JSON.parse(
      content.toString("utf8"),
    ) as TesseraMatchupReport | TesseraStressTestReport,
    content,
  };
}

async function rawPolicyInput(
  input: StartTesseraOptimizerInput,
): Promise<{ policy: ProfilePolicyV1; content: Buffer } | null> {
  if (input.profilePolicy) {
    const policy = ProfilePolicySchema.parse(input.profilePolicy);
    return {
      policy,
      content: Buffer.from(`${JSON.stringify(policy, null, 2)}\n`, "utf8"),
    };
  }
  if (!input.profilePolicyPath) return null;
  const content = await readFile(path.resolve(input.profilePolicyPath));
  return {
    policy: ProfilePolicySchema.parse(
      JSON.parse(content.toString("utf8")),
    ),
    content,
  };
}

async function baselineRosterInput(
  input: StartTesseraOptimizerInput,
): Promise<RosterDraftV1> {
  if (input.baselineRoster) return structuredClone(input.baselineRoster);
  if (!input.baselineRosterPath) {
    throw Object.assign(
      new Error("Starting an optimizer requires a baseline roster path or object."),
      { code: "TESSERA_OPTIMIZER_BASELINE_ROSTER_REQUIRED" },
    );
  }
  return JSON.parse(
    await readFile(path.resolve(input.baselineRosterPath), "utf8"),
  ) as RosterDraftV1;
}

export async function startTesseraOptimizer(
  input: StartTesseraOptimizerInput,
): Promise<TesseraOptimizerStoreResult> {
  const optimizerRunId = input.optimizerRunId ?? randomUUID();
  if (!optimizerIdPattern.test(optimizerRunId)) {
    return failure(issue(
      "TESSERA_OPTIMIZER_RUN_ID_INVALID",
      "The optimizer run ID contains unsupported path characters.",
    ));
  }
  const rootDirectory = path.resolve(input.rootDir ?? process.cwd());
  const baseDirectory = path.resolve(
    input.outputDirectory ??
      path.join(rootDirectory, "exports", "tessera", "optimizers"),
  );
  const optimizerDirectory = path.join(
    baseDirectory,
    `optimizer-${optimizerRunId}`,
  );
  const temporaryDirectory = `${optimizerDirectory}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await assertWritableBase(
      rootDirectory,
      baseDirectory,
      input.allowOutsideRoot === true,
    );
    await mkdir(temporaryDirectory, { recursive: false, mode: 0o700 });
    const [reportInput, policyInput, baselineRoster] = await Promise.all([
      rawReportInput(input),
      rawPolicyInput(input),
      baselineRosterInput(input),
    ]);
    const baselineReportPath = path.join(
      optimizerDirectory,
      "baseline-report.json",
    );
    const temporaryBaselineReportPath = path.join(
      temporaryDirectory,
      "baseline-report.json",
    );
    const baselineReportSha256 = await writeFrozenArtifact(
      temporaryBaselineReportPath,
      reportInput.content,
    );
    const profilePolicyPath = policyInput
      ? path.join(optimizerDirectory, "profile-policy.json")
      : null;
    const profilePolicySha256 = policyInput
      ? await writeFrozenArtifact(
          path.join(temporaryDirectory, "profile-policy.json"),
          policyInput.content,
        )
      : null;
    const statePath = path.join(
      optimizerDirectory,
      "tessera-optimizer.json",
    );
    const created = createTesseraOptimizerState({
      mode: input.mode,
      optimizerRunId,
      createdAt: input.createdAt,
      baselineReportPath,
      baselineReport: reportInput.report,
      baselineReportArtifactSha256: baselineReportSha256,
      baselineRoster,
      evaluationRuntime:
        input.evaluationRuntime ?? getRuntimeProvenance(),
      profilePolicy: policyInput?.policy ?? null,
      profilePolicyPath,
      profilePolicyArtifactSha256: profilePolicySha256,
    });
    if (!created.ok || !created.data) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      return {
        ok: false,
        data: null,
        violations: created.violations,
        warnings: created.warnings,
      };
    }
    if (
      tesseraOptimizerCanonicalSha256(
        activeBundleIdentity(baselineRoster),
      ) !==
      tesseraOptimizerCanonicalSha256(
        created.data.frozenIdentities.bundle,
      )
    ) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      return failure(issue(
        "TESSERA_OPTIMIZER_IDENTITY_INVALIDATED",
        "The completed baseline roster does not match the active leased data-bundle identity.",
      ));
    }
    const baselineArtifact: TesseraOptimizerStoredArtifact = {
      kind: "baseline-report",
      candidateId: null,
      path: baselineReportPath,
      sha256: baselineReportSha256,
    };
    const profileArtifact: TesseraOptimizerStoredArtifact | null =
      profilePolicyPath && profilePolicySha256
        ? {
            kind: "profile-policy",
            candidateId: null,
            path: profilePolicyPath,
            sha256: profilePolicySha256,
          }
        : null;
    const document = sealDocument({
      schemaVersion: 1,
      documentKind: "rosterpilot-tessera-optimizer-store",
      optimizerRunId,
      optimizerDirectory,
      rootDirectory,
      statePath,
      baselineReportArtifact: baselineArtifact,
      profilePolicyArtifact: profileArtifact,
      candidateRosterArtifacts: [],
      comparisonArtifacts: [],
      finalRosterArtifact: null,
      state: created.data,
    });
    await writeFile(
      path.join(temporaryDirectory, "tessera-optimizer.json"),
      `${JSON.stringify(document, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporaryDirectory, optimizerDirectory);
    return {
      ok: true,
      data: snapshot(document),
      violations: [],
      warnings: created.warnings,
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    return failure(errorIssue(error));
  }
}

export async function getTesseraOptimizerStatus(
  statePath: string,
  options: TesseraOptimizerStoreAccessOptions = {},
): Promise<TesseraOptimizerStoreResult> {
  try {
    const document = await readDocument(statePath);
    const identities = await currentIdentities(
      document,
      options.evaluationRuntime ?? getRuntimeProvenance(),
    );
    const verified = verifyTesseraOptimizerState(
      document.state,
      identities,
    );
    return resultFromCore(verified, document, identities);
  } catch (error) {
    return failure(errorIssue(error));
  }
}

async function withTransition(
  statePath: string,
  expectedStateRevision: number,
  evaluationRuntime: RuntimeProvenance | undefined,
  transition: (
    document: TesseraOptimizerStoreDocument,
    identities: TesseraOptimizerState["frozenIdentities"],
  ) => Promise<{
    core: TesseraOptimizerResult<TesseraOptimizerState>;
    document?: TesseraOptimizerStoreDocument;
  }>,
): Promise<TesseraOptimizerStoreResult> {
  const resolved = path.resolve(statePath);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(resolved);
    const original = await readDocument(resolved);
    if (original.state.stateRevision !== expectedStateRevision) {
      return failure(
        issue(
          "TESSERA_OPTIMIZER_STALE_STATE_REVISION",
          `Expected optimizer revision ${expectedStateRevision}, but the durable state is revision ${original.state.stateRevision}.`,
        ),
        snapshot(original),
      );
    }
    const identities = await currentIdentities(
      original,
      evaluationRuntime ?? getRuntimeProvenance(),
    );
    const transitioned = await transition(original, identities);
    let nextDocument = transitioned.document ?? original;
    if (
      transitioned.core.data &&
      transitioned.core.data.integritySha256 !==
        nextDocument.state.integritySha256
    ) {
      nextDocument = sealDocument({
        ...nextDocument,
        state: transitioned.core.data,
        documentSha256: undefined,
      });
    }
    if (nextDocument.documentSha256 !== original.documentSha256) {
      await writeJsonAtomic(resolved, nextDocument);
    }
    return resultFromCore(
      transitioned.core,
      nextDocument,
      identities,
    );
  } catch (error) {
    return failure(errorIssue(error));
  } finally {
    if (release) await release().catch(() => undefined);
  }
}

async function freezeCandidateRosters(
  document: TesseraOptimizerStoreDocument,
  state: TesseraOptimizerState,
): Promise<TesseraOptimizerStoredArtifact[]> {
  const artifacts = [...document.candidateRosterArtifacts];
  for (const candidate of state.candidates) {
    if (!candidate.revisedRoster || !candidate.revisedRosterSha256) continue;
    if (
      artifacts.some(
        (artifact) =>
          artifact.candidateId === candidate.candidate.candidateId,
      )
    ) {
      continue;
    }
    const filename = path.join(
      document.optimizerDirectory,
      `candidate-${safeArtifactSlug(candidate.candidate.candidateId)}.json`,
    );
    const content = `${JSON.stringify(candidate.revisedRoster, null, 2)}\n`;
    const sha256 = await writeFrozenArtifact(filename, content);
    if (sha256 !== contentSha256(content)) {
      throw Object.assign(
        new Error("The frozen candidate roster hash is inconsistent."),
        { code: "TESSERA_OPTIMIZER_CANDIDATE_ARTIFACT_INVALID" },
      );
    }
    artifacts.push({
      kind: "candidate-roster",
      candidateId: candidate.candidate.candidateId,
      path: filename,
      sha256,
    });
  }
  return artifacts.sort((left, right) =>
    (left.candidateId ?? "").localeCompare(right.candidateId ?? ""),
  );
}

export async function approveAndMaterializeTesseraOptimizerCandidates(
  statePath: string,
  input: {
    expectedStateRevision: number;
    candidateIds: string[];
    approvalId: string;
    approvedBy: string;
    approvedAt?: string;
    evaluationRuntime?: RuntimeProvenance;
    qualifyCandidate?: TesseraOptimizerCandidateQualifier;
  },
): Promise<TesseraOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => {
      const approvedAt = input.approvedAt ?? new Date().toISOString();
      const approved = approveTesseraOptimizerCandidateBatch(
        document.state,
        {
          currentIdentities: identities,
          expectedStateRevision: input.expectedStateRevision,
          candidateIds: input.candidateIds,
          approvalId: input.approvalId,
          approvedBy: input.approvedBy,
          approvedAt,
        },
      );
      if (!approved.ok || !approved.data) return { core: approved };
      const materialized =
        await materializeApprovedTesseraOptimizerCandidates(
          approved.data,
          {
            currentIdentities: identities,
            materializedAt: approvedAt,
            qualifyCandidate: input.qualifyCandidate,
          },
        );
      if (!materialized.data) return { core: materialized };
      const candidateRosterArtifacts = await freezeCandidateRosters(
        document,
        materialized.data,
      );
      return {
        core: materialized,
        document: sealDocument({
          ...document,
          candidateRosterArtifacts,
          state: materialized.data,
          documentSha256: undefined,
        }),
      };
    },
  );
}

export async function recordStoredTesseraOptimizerComparison(
  statePath: string,
  input: {
    expectedStateRevision: number;
    candidateId: string;
    reportPath?: string;
    report?: TesseraRevisionComparisonReport | TesseraStressRevisionReport;
    recordedAt?: string;
    evaluationRuntime?: RuntimeProvenance;
  },
): Promise<TesseraOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => {
      let report: TesseraRevisionComparisonReport | TesseraStressRevisionReport;
      let content: Buffer;
      if (input.report) {
        report = structuredClone(input.report);
        content = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
      } else if (input.reportPath) {
        content = await readFile(path.resolve(input.reportPath));
        report = JSON.parse(content.toString("utf8")) as
          | TesseraRevisionComparisonReport
          | TesseraStressRevisionReport;
      } else {
        return {
          core: {
            ok: false,
            data: document.state,
            violations: [issue(
              "TESSERA_OPTIMIZER_COMPARISON_REPORT_REQUIRED",
              "Recording a comparison requires a report path or object.",
            )],
            warnings: [],
          },
        };
      }
      const artifactPath = path.join(
        document.optimizerDirectory,
        `comparison-${safeArtifactSlug(input.candidateId)}-r${input.expectedStateRevision}.json`,
      );
      const artifactSha256 = contentSha256(content);
      const recorded = recordTesseraOptimizerComparison(
        document.state,
        {
          currentIdentities: identities,
          candidateId: input.candidateId,
          report,
          reportArtifactSha256: artifactSha256,
          recordedAt: input.recordedAt,
        },
      );
      const changed =
        recorded.data &&
        recorded.data.integritySha256 !== document.state.integritySha256;
      if (!changed || !recorded.data) return { core: recorded };
      await writeFrozenArtifact(artifactPath, content);
      const comparisonArtifact: TesseraOptimizerStoredArtifact = {
        kind: "comparison-report",
        candidateId: input.candidateId,
        path: artifactPath,
        sha256: artifactSha256,
      };
      return {
        core: recorded,
        document: sealDocument({
          ...document,
          comparisonArtifacts: [
            ...document.comparisonArtifacts.filter(
              (artifact) => artifact.candidateId !== input.candidateId,
            ),
            comparisonArtifact,
          ].sort((left, right) =>
            (left.candidateId ?? "").localeCompare(
              right.candidateId ?? "",
            ),
          ),
          state: recorded.data,
          documentSha256: undefined,
        }),
      };
    },
  );
}

export async function approveStoredTesseraOptimizerWinner(
  statePath: string,
  input: {
    expectedStateRevision: number;
    candidateId: string;
    approvalId: string;
    approvedBy: string;
    approvedAt?: string;
    evaluationRuntime?: RuntimeProvenance;
  },
): Promise<TesseraOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => ({
      core: approveTesseraOptimizerWinner(document.state, {
        currentIdentities: identities,
        expectedStateRevision: input.expectedStateRevision,
        candidateId: input.candidateId,
        approvalId: input.approvalId,
        approvedBy: input.approvedBy,
        approvedAt: input.approvedAt ?? new Date().toISOString(),
      }),
    }),
  );
}

export async function retainStoredTesseraOptimizerBaseline(
  statePath: string,
  input: {
    expectedStateRevision: number;
    approvalId: string;
    approvedBy: string;
    approvedAt?: string;
    evaluationRuntime?: RuntimeProvenance;
  },
): Promise<TesseraOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => ({
      core: retainTesseraOptimizerBaseline(document.state, {
        currentIdentities: identities,
        expectedStateRevision: input.expectedStateRevision,
        approvalId: input.approvalId,
        approvedBy: input.approvedBy,
        approvedAt: input.approvedAt ?? new Date().toISOString(),
      }),
    }),
  );
}

export async function finalizeStoredTesseraOptimizer(
  statePath: string,
  input: {
    expectedStateRevision: number;
    deliveryIntent: TesseraOptimizerDeliveryIntent;
    finalizedAt?: string;
    evaluationRuntime?: RuntimeProvenance;
  },
): Promise<TesseraOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => {
      const finalized = finalizeTesseraOptimizer(document.state, {
        currentIdentities: identities,
        deliveryIntent: input.deliveryIntent,
        finalizedAt: input.finalizedAt,
      });
      if (!finalized.ok || !finalized.data?.finalization) {
        return { core: finalized };
      }
      const artifactPath = path.join(
        document.optimizerDirectory,
        "final-roster.json",
      );
      const content = `${JSON.stringify(
        finalized.data.finalization.roster,
        null,
        2,
      )}\n`;
      const artifactSha256 = await writeFrozenArtifact(
        artifactPath,
        content,
      );
      return {
        core: finalized,
        document: sealDocument({
          ...document,
          finalRosterArtifact: {
            kind: "final-roster",
            candidateId: finalized.data.finalization.candidateId,
            path: artifactPath,
            sha256: artifactSha256,
          },
          state: finalized.data,
          documentSha256: undefined,
        }),
      };
    },
  );
}
