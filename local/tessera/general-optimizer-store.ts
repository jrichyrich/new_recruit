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

import { stampRosterDataIdentity } from "../../lib/rosterpilot/draft";
import {
  GeneralThreatArchetypeIds,
  type GeneralThreatArchetype,
  type GeneralThreatPortfolio,
} from "../../lib/rosterpilot/general-threat-portfolio";
import type {
  ProfilePolicyV1,
  RosterDraftV1,
  RuntimeProvenance,
  TesseraMatchupReport,
  TesseraRevisionComparisonReport,
} from "../../lib/rosterpilot/types";
import { getRuntimeProvenance } from "../runtime-provenance";
import {
  approveTesseraGeneralOptimizerCandidateBatch,
  approvedTesseraGeneralOptimizerComparisonRequests,
  approveTesseraGeneralOptimizerWinner,
  createTesseraGeneralOptimizerState,
  finalizeTesseraGeneralOptimizer,
  materializeApprovedTesseraGeneralOptimizerCandidates,
  recordTesseraGeneralOptimizerComparison,
  retainTesseraGeneralOptimizerBaseline,
  verifyTesseraGeneralOptimizerState,
  type TesseraGeneralOptimizerComparisonRequest,
  type TesseraGeneralOptimizerFrozenIdentities,
  type TesseraGeneralOptimizerState,
} from "./general-optimizer";
import type {
  TesseraOptimizerCandidateQualifier,
  TesseraOptimizerDeliveryIntent,
  TesseraOptimizerIssue,
  TesseraOptimizerMode,
  TesseraOptimizerResult,
} from "./optimizer";
import {
  ProfilePolicySchema,
} from "./profile-policy";

const generalOptimizerStoreSchemaVersion = 1;
const generalOptimizerLockStaleMs = 30_000;
const generalOptimizerLockWaitMs = 5_000;
const optimizerIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type TesseraGeneralOptimizerStoredArtifact = {
  kind:
    | "portfolio"
    | "baseline-report"
    | "profile-policy"
    | "candidate-roster"
    | "comparison-report"
    | "final-roster";
  candidateId: string | null;
  archetypeId: GeneralThreatArchetype | null;
  path: string;
  sha256: string;
};

export type TesseraGeneralOptimizerStoreDocument = {
  schemaVersion: 1;
  documentKind: "rosterpilot-tessera-general-optimizer-store";
  optimizerRunId: string;
  optimizerDirectory: string;
  rootDirectory: string;
  statePath: string;
  portfolioArtifact: TesseraGeneralOptimizerStoredArtifact;
  baselineReportArtifacts: TesseraGeneralOptimizerStoredArtifact[];
  profilePolicyArtifacts: TesseraGeneralOptimizerStoredArtifact[];
  candidateRosterArtifacts: TesseraGeneralOptimizerStoredArtifact[];
  comparisonArtifacts: TesseraGeneralOptimizerStoredArtifact[];
  finalRosterArtifact: TesseraGeneralOptimizerStoredArtifact | null;
  state: TesseraGeneralOptimizerState;
  documentSha256: string;
};

export type TesseraGeneralOptimizerStoreSnapshot = {
  statePath: string;
  optimizerDirectory: string;
  state: TesseraGeneralOptimizerState;
  comparisonRequests: TesseraGeneralOptimizerComparisonRequest[];
  portfolioArtifact: TesseraGeneralOptimizerStoredArtifact;
  baselineReportArtifacts: TesseraGeneralOptimizerStoredArtifact[];
  profilePolicyArtifacts: TesseraGeneralOptimizerStoredArtifact[];
  candidateRosterArtifacts: TesseraGeneralOptimizerStoredArtifact[];
  comparisonArtifacts: TesseraGeneralOptimizerStoredArtifact[];
  finalRosterArtifact: TesseraGeneralOptimizerStoredArtifact | null;
};

export type TesseraGeneralOptimizerStoreResult = TesseraOptimizerResult<
  TesseraGeneralOptimizerStoreSnapshot
>;

export type TesseraGeneralOptimizerStoreAccessOptions = {
  evaluationRuntime?: RuntimeProvenance;
};

export type StartTesseraGeneralOptimizerBaselineInput = {
  archetypeId: GeneralThreatArchetype;
  reportPath?: string;
  report?: TesseraMatchupReport;
  profilePolicyPath?: string;
  profilePolicy?: ProfilePolicyV1;
};

export type StartTesseraGeneralOptimizerInput = {
  baselineRosterPath?: string;
  baselineRoster?: RosterDraftV1;
  portfolioPath?: string;
  portfolio?: GeneralThreatPortfolio;
  baselines: StartTesseraGeneralOptimizerBaselineInput[];
  mode?: TesseraOptimizerMode;
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
  data: TesseraGeneralOptimizerStoreSnapshot | null = null,
): TesseraGeneralOptimizerStoreResult {
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

function canonicalSha256(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return candidate;
  };
  return contentSha256(JSON.stringify(canonical(value)));
}

function documentHash(
  document: Omit<TesseraGeneralOptimizerStoreDocument, "documentSha256"> & {
    documentSha256?: string;
  },
): string {
  return canonicalSha256({
    ...document,
    documentSha256: undefined,
  });
}

function sealDocument(
  document: Omit<TesseraGeneralOptimizerStoreDocument, "documentSha256"> & {
    documentSha256?: string;
  },
): TesseraGeneralOptimizerStoreDocument {
  const pending = {
    ...document,
    documentSha256: "",
  } as TesseraGeneralOptimizerStoreDocument;
  return {
    ...pending,
    documentSha256: documentHash(pending),
  };
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
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
      const unresolvedSuffix = path.relative(existingAncestor, resolvedCandidate);
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
    if (filesystemErrorCode(error) !== "EEXIST") throw error;
    const observed = await readFile(filename);
    if (contentSha256(observed) !== expected) {
      throw Object.assign(
        new Error(
          "A frozen general optimizer artifact already exists with different content.",
        ),
        { code: "TESSERA_GENERAL_OPTIMIZER_ARTIFACT_CONFLICT" },
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
      new Error(
        "The general optimizer output directory is outside the allowed write root.",
      ),
      { code: "TESSERA_GENERAL_OPTIMIZER_OUTPUT_OUTSIDE_ROOT" },
    );
  }
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  if (
    !allowOutsideRoot &&
    !(await filesystemPathInside(rootDirectory, baseDirectory))
  ) {
    throw Object.assign(
      new Error(
        "The general optimizer output directory resolves outside the allowed write root.",
      ),
      { code: "TESSERA_GENERAL_OPTIMIZER_OUTPUT_OUTSIDE_ROOT" },
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
        new Error(
          "The general optimizer output directory resolves outside the allowed write root.",
        ),
        { code: "TESSERA_GENERAL_OPTIMIZER_OUTPUT_OUTSIDE_ROOT" },
      );
    }
  }
}

function allArtifacts(
  document: TesseraGeneralOptimizerStoreDocument,
): TesseraGeneralOptimizerStoredArtifact[] {
  return [
    document.portfolioArtifact,
    ...document.baselineReportArtifacts,
    ...document.profilePolicyArtifacts,
    ...document.candidateRosterArtifacts,
    ...document.comparisonArtifacts,
    ...(document.finalRosterArtifact ? [document.finalRosterArtifact] : []),
  ];
}

function artifactKey(artifact: TesseraGeneralOptimizerStoredArtifact): string {
  return [
    artifact.kind,
    artifact.candidateId ?? "",
    artifact.archetypeId ?? "",
  ].join(":");
}

function expectedArtifactShape(
  artifact: TesseraGeneralOptimizerStoredArtifact,
): boolean {
  switch (artifact.kind) {
    case "portfolio":
      return artifact.candidateId === null && artifact.archetypeId === null;
    case "baseline-report":
    case "profile-policy":
      return artifact.candidateId === null && artifact.archetypeId !== null;
    case "candidate-roster":
      return artifact.candidateId !== null && artifact.archetypeId === null;
    case "comparison-report":
      return artifact.candidateId !== null && artifact.archetypeId !== null;
    case "final-roster":
      return artifact.archetypeId === null;
  }
}

async function validateArtifactRelationships(
  document: TesseraGeneralOptimizerStoreDocument,
): Promise<TesseraOptimizerIssue | null> {
  const expectedArchetypes = new Set<string>(GeneralThreatArchetypeIds);
  const reportArchetypes = new Set(
    document.baselineReportArtifacts.map(({ archetypeId }) => archetypeId),
  );
  if (
    document.portfolioArtifact.kind !== "portfolio" ||
    document.baselineReportArtifacts.length !==
      GeneralThreatArchetypeIds.length ||
    reportArchetypes.size !== GeneralThreatArchetypeIds.length ||
    [...reportArchetypes].some((archetypeId) =>
      archetypeId === null || !expectedArchetypes.has(archetypeId)
    ) ||
    document.profilePolicyArtifacts.some(({ archetypeId }) =>
      archetypeId === null || !expectedArchetypes.has(archetypeId)
    )
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_STORE_ARTIFACT_SET_INVALID",
      "The durable store must retain one portfolio and exactly one baseline report for each general-threat archetype.",
    );
  }
  const portfolio = JSON.parse(
    await readFile(document.portfolioArtifact.path, "utf8"),
  ) as GeneralThreatPortfolio;
  if (
    document.portfolioArtifact.sha256 !==
      document.state.frozenIdentities.portfolio.artifactSha256 ||
    canonicalSha256(portfolio) !== canonicalSha256(document.state.portfolio)
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_PORTFOLIO_ARTIFACT_INVALID",
      "The frozen portfolio artifact no longer matches the optimizer identity.",
    );
  }
  for (const identity of document.state.frozenIdentities.baselines) {
    const reportArtifact = document.baselineReportArtifacts.find(
      (artifact) => artifact.archetypeId === identity.archetypeId,
    );
    const policyArtifact = document.profilePolicyArtifacts.find(
      (artifact) => artifact.archetypeId === identity.archetypeId,
    );
    if (
      !reportArtifact ||
      reportArtifact.path !== identity.reportPath ||
      reportArtifact.sha256 !== identity.reportArtifactSha256 ||
      (policyArtifact?.path ?? null) !== identity.profilePolicyPath ||
      (policyArtifact?.sha256 ?? null) !==
        identity.profilePolicyArtifactSha256
    ) {
      return issue(
        "TESSERA_GENERAL_OPTIMIZER_STORE_IDENTITY_MISMATCH",
        `The frozen ${identity.archetypeId} artifacts no longer match the optimizer identity.`,
      );
    }
  }
  for (const artifact of document.candidateRosterArtifacts) {
    const candidate = document.state.candidates.find(
      (entry) => entry.candidate.candidateId === artifact.candidateId,
    );
    if (!candidate?.revisedRoster || !candidate.revisedRosterSha256) {
      return issue(
        "TESSERA_GENERAL_OPTIMIZER_CANDIDATE_ARTIFACT_INVALID",
        "A frozen candidate roster does not belong to a materialized candidate.",
      );
    }
    const roster = JSON.parse(
      await readFile(artifact.path, "utf8"),
    ) as RosterDraftV1;
    if (canonicalSha256(roster) !== candidate.revisedRosterSha256) {
      return issue(
        "TESSERA_GENERAL_OPTIMIZER_CANDIDATE_ARTIFACT_CHANGED",
        `The frozen candidate ${artifact.candidateId} roster identity changed.`,
      );
    }
  }
  for (const artifact of document.comparisonArtifacts) {
    const evidence = document.state.candidates
      .find((entry) => entry.candidate.candidateId === artifact.candidateId)
      ?.comparisons.find(
        (entry) => entry.archetypeId === artifact.archetypeId,
      );
    if (!evidence || evidence.reportArtifactSha256 !== artifact.sha256) {
      return issue(
        "TESSERA_GENERAL_OPTIMIZER_COMPARISON_ARTIFACT_INVALID",
        "A frozen comparison report does not match its candidate/archetype evidence receipt.",
      );
    }
  }
  if (document.finalRosterArtifact) {
    if (!document.state.finalization) {
      return issue(
        "TESSERA_GENERAL_OPTIMIZER_FINAL_ARTIFACT_INVALID",
        "A final roster artifact exists without a finalization receipt.",
      );
    }
    const roster = JSON.parse(
      await readFile(document.finalRosterArtifact.path, "utf8"),
    ) as RosterDraftV1;
    if (
      canonicalSha256(roster) !==
        canonicalSha256(document.state.finalization.roster) ||
      document.finalRosterArtifact.candidateId !==
        document.state.finalization.candidateId
    ) {
      return issue(
        "TESSERA_GENERAL_OPTIMIZER_FINAL_ARTIFACT_CHANGED",
        "The final roster artifact no longer matches the finalization receipt.",
      );
    }
  }
  return null;
}

async function validateDocument(
  document: TesseraGeneralOptimizerStoreDocument,
  resolvedStatePath: string,
): Promise<TesseraOptimizerIssue | null> {
  if (
    document.schemaVersion !== generalOptimizerStoreSchemaVersion ||
    document.documentKind !==
      "rosterpilot-tessera-general-optimizer-store" ||
    document.optimizerRunId !== document.state.optimizerRunId ||
    document.statePath !== resolvedStatePath ||
    document.optimizerDirectory !== path.dirname(resolvedStatePath) ||
    document.documentSha256 !== documentHash(document)
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_STORE_TAMPERED",
      "The general optimizer store document or its storage identity is invalid.",
    );
  }
  const stateVerification = verifyTesseraGeneralOptimizerState(document.state);
  if (!stateVerification.ok) {
    return stateVerification.violations[0] ?? issue(
      "TESSERA_GENERAL_OPTIMIZER_STATE_INVALID",
      "The stored general optimizer state failed integrity verification.",
    );
  }
  const artifacts = allArtifacts(document);
  if (
    !pathInside(document.optimizerDirectory, document.statePath) ||
    artifacts.some(
      (artifact) =>
        !expectedArtifactShape(artifact) ||
        !pathInside(document.optimizerDirectory, artifact.path) ||
        !/^[0-9a-f]{64}$/.test(artifact.sha256),
    ) ||
    new Set(artifacts.map(artifactKey)).size !== artifacts.length ||
    new Set(artifacts.map(({ path: artifactPath }) => artifactPath)).size !==
      artifacts.length
  ) {
    return issue(
      "TESSERA_GENERAL_OPTIMIZER_STORE_PATH_INVALID",
      "A general optimizer artifact key or path is invalid or escapes its frozen directory.",
    );
  }
  for (const artifact of artifacts) {
    try {
      const metadata = await lstat(artifact.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return issue(
          "TESSERA_GENERAL_OPTIMIZER_ARTIFACT_INVALID",
          `The frozen ${artifact.kind} artifact is not a regular file.`,
        );
      }
      if (contentSha256(await readFile(artifact.path)) !== artifact.sha256) {
        return issue(
          "TESSERA_GENERAL_OPTIMIZER_ARTIFACT_CHANGED",
          `The frozen ${artifact.kind} artifact no longer matches its receipt.`,
        );
      }
    } catch (error) {
      return issue(
        "TESSERA_GENERAL_OPTIMIZER_ARTIFACT_UNAVAILABLE",
        `The frozen ${artifact.kind} artifact could not be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return validateArtifactRelationships(document);
}

async function readDocument(
  statePath: string,
): Promise<TesseraGeneralOptimizerStoreDocument> {
  const resolved = path.resolve(statePath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw Object.assign(
      new Error("The general optimizer state path is not a regular file."),
      { code: "TESSERA_GENERAL_OPTIMIZER_STORE_PATH_INVALID" },
    );
  }
  const parsed = JSON.parse(
    await readFile(resolved, "utf8"),
  ) as TesseraGeneralOptimizerStoreDocument;
  const invalid = await validateDocument(parsed, resolved);
  if (invalid) {
    throw Object.assign(new Error(invalid.message), { code: invalid.code });
  }
  return parsed;
}

function errorIssue(error: unknown): TesseraOptimizerIssue {
  const code = error && typeof error === "object" && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : "TESSERA_GENERAL_OPTIMIZER_STORE_FAILED";
  return issue(code, error instanceof Error ? error.message : String(error));
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
      if (filesystemErrorCode(error) !== "EEXIST") throw error;
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
        Date.now() - metadata.mtimeMs > generalOptimizerLockStaleMs
      ) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= generalOptimizerLockWaitMs) {
        throw Object.assign(
          new Error(
            "Another general optimizer transition still holds the state lock.",
          ),
          { code: "TESSERA_GENERAL_OPTIMIZER_STORE_BUSY" },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function activeBundleIdentity(
  roster: RosterDraftV1,
): TesseraGeneralOptimizerState["frozenIdentities"]["bundle"] {
  const activeSource = stampRosterDataIdentity(
    structuredClone(roster),
  ).sourceData;
  const activeSemanticSource = {
    bundleId: activeSource.bundleId,
    engineDataSchemaVersion: activeSource.engineDataSchemaVersion,
    rosterRulesHash: activeSource.rosterRulesHash,
    factionRulesHash: activeSource.factionRulesHash,
    mappingHash: activeSource.mappingHash,
    entityHashesSha256: canonicalSha256(activeSource.entityHashes),
  };
  return {
    ...activeSemanticSource,
    semanticIdentitySha256: canonicalSha256(activeSemanticSource),
    provenanceSha256: canonicalSha256({
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
  document: TesseraGeneralOptimizerStoreDocument,
  evaluationRuntime: RuntimeProvenance,
): Promise<TesseraGeneralOptimizerFrozenIdentities> {
  const portfolio = JSON.parse(
    await readFile(document.portfolioArtifact.path, "utf8"),
  ) as GeneralThreatPortfolio;
  const baselines = await Promise.all(
    GeneralThreatArchetypeIds.map(async (archetypeId) => {
      const reportArtifact = document.baselineReportArtifacts.find(
        (artifact) => artifact.archetypeId === archetypeId,
      );
      if (!reportArtifact) {
        throw Object.assign(
          new Error(`The frozen ${archetypeId} baseline report is missing.`),
          { code: "TESSERA_GENERAL_OPTIMIZER_BASELINE_ARTIFACT_MISSING" },
        );
      }
      const policyArtifact = document.profilePolicyArtifacts.find(
        (artifact) => artifact.archetypeId === archetypeId,
      );
      const report = JSON.parse(
        await readFile(reportArtifact.path, "utf8"),
      ) as TesseraMatchupReport;
      const policy = policyArtifact
        ? ProfilePolicySchema.parse(JSON.parse(
            await readFile(policyArtifact.path, "utf8"),
          ))
        : null;
      return {
        archetypeId,
        reportPath: reportArtifact.path,
        report,
        reportArtifactSha256: reportArtifact.sha256,
        profilePolicy: policy,
        profilePolicyPath: policyArtifact?.path ?? null,
        profilePolicyArtifactSha256: policyArtifact?.sha256 ?? null,
      };
    }),
  );
  const recreated = await createTesseraGeneralOptimizerState({
    mode: document.state.mode,
    optimizerRunId: document.optimizerRunId,
    createdAt: document.state.createdAt,
    baselineRoster: document.state.baselineRoster,
    portfolio,
    portfolioArtifactSha256: document.portfolioArtifact.sha256,
    baselines,
    evaluationRuntime,
  });
  if (!recreated.ok || !recreated.data) {
    throw Object.assign(
      new Error(
        recreated.violations[0]?.message ??
          "The frozen general optimizer identities could not be rederived.",
      ),
      {
        code: recreated.violations[0]?.code ??
          "TESSERA_GENERAL_OPTIMIZER_IDENTITY_INVALID",
      },
    );
  }
  if (
    canonicalSha256(activeBundleIdentity(document.state.baselineRoster)) !==
      canonicalSha256(recreated.data.frozenIdentities.bundle)
  ) {
    throw Object.assign(
      new Error(
        "The general optimizer no longer matches the active leased data-bundle identity.",
      ),
      { code: "TESSERA_GENERAL_OPTIMIZER_IDENTITY_INVALIDATED" },
    );
  }
  return recreated.data.frozenIdentities;
}

function comparisonRequestsFor(
  state: TesseraGeneralOptimizerState,
  identities: TesseraGeneralOptimizerFrozenIdentities,
): TesseraGeneralOptimizerComparisonRequest[] {
  const requests = approvedTesseraGeneralOptimizerComparisonRequests(
    state,
    identities,
  );
  return requests.ok && requests.data ? requests.data : [];
}

function snapshot(
  document: TesseraGeneralOptimizerStoreDocument,
  identities = document.state.frozenIdentities,
): TesseraGeneralOptimizerStoreSnapshot {
  return {
    statePath: document.statePath,
    optimizerDirectory: document.optimizerDirectory,
    state: structuredClone(document.state),
    comparisonRequests: comparisonRequestsFor(document.state, identities),
    portfolioArtifact: structuredClone(document.portfolioArtifact),
    baselineReportArtifacts: structuredClone(
      document.baselineReportArtifacts,
    ),
    profilePolicyArtifacts: structuredClone(
      document.profilePolicyArtifacts,
    ),
    candidateRosterArtifacts: structuredClone(
      document.candidateRosterArtifacts,
    ),
    comparisonArtifacts: structuredClone(document.comparisonArtifacts),
    finalRosterArtifact: structuredClone(document.finalRosterArtifact),
  };
}

function resultFromCore(
  core: TesseraOptimizerResult<TesseraGeneralOptimizerState>,
  document: TesseraGeneralOptimizerStoreDocument,
  identities: TesseraGeneralOptimizerFrozenIdentities,
): TesseraGeneralOptimizerStoreResult {
  return {
    ok: core.ok,
    data: snapshot(document, identities),
    violations: core.violations,
    warnings: core.warnings,
  };
}

async function rawJsonInput<T>(
  value: T | undefined,
  sourcePath: string | undefined,
  missingCode: string,
  missingMessage: string,
): Promise<{ value: T; content: Buffer }> {
  if (value !== undefined) {
    return {
      value: structuredClone(value),
      content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    };
  }
  if (!sourcePath) {
    throw Object.assign(new Error(missingMessage), { code: missingCode });
  }
  const content = await readFile(path.resolve(sourcePath));
  return {
    value: JSON.parse(content.toString("utf8")) as T,
    content,
  };
}

async function rawBaselineInput(
  input: StartTesseraGeneralOptimizerBaselineInput,
): Promise<{
  archetypeId: GeneralThreatArchetype;
  report: TesseraMatchupReport;
  reportContent: Buffer;
  profilePolicy: ProfilePolicyV1 | null;
  profilePolicyContent: Buffer | null;
}> {
  const report = await rawJsonInput(
    input.report,
    input.reportPath,
    "TESSERA_GENERAL_OPTIMIZER_BASELINE_REQUIRED",
    `The ${input.archetypeId} baseline requires a report path or object.`,
  );
  const policy = input.profilePolicy !== undefined || input.profilePolicyPath
    ? await rawJsonInput(
        input.profilePolicy,
        input.profilePolicyPath,
        "TESSERA_GENERAL_OPTIMIZER_PROFILE_REQUIRED",
        `The ${input.archetypeId} profile policy requires a path or object.`,
      )
    : null;
  return {
    archetypeId: input.archetypeId,
    report: report.value,
    reportContent: report.content,
    profilePolicy: policy
      ? ProfilePolicySchema.parse(policy.value)
      : null,
    profilePolicyContent: policy?.content ?? null,
  };
}

export async function startTesseraGeneralOptimizer(
  input: StartTesseraGeneralOptimizerInput,
): Promise<TesseraGeneralOptimizerStoreResult> {
  const optimizerRunId = input.optimizerRunId ?? randomUUID();
  if (!optimizerIdPattern.test(optimizerRunId)) {
    return failure(issue(
      "TESSERA_GENERAL_OPTIMIZER_RUN_ID_INVALID",
      "The general optimizer run ID contains unsupported path characters.",
    ));
  }
  const rootDirectory = path.resolve(input.rootDir ?? process.cwd());
  const baseDirectory = path.resolve(
    input.outputDirectory ??
      path.join(rootDirectory, "exports", "tessera", "general-optimizers"),
  );
  const optimizerDirectory = path.join(
    baseDirectory,
    `general-optimizer-${optimizerRunId}`,
  );
  const temporaryDirectory =
    `${optimizerDirectory}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await assertWritableBase(
      rootDirectory,
      baseDirectory,
      input.allowOutsideRoot === true,
    );
    await mkdir(temporaryDirectory, { recursive: false, mode: 0o700 });
    if (
      input.baselines.length !== GeneralThreatArchetypeIds.length ||
      new Set(input.baselines.map(({ archetypeId }) => archetypeId)).size !==
        GeneralThreatArchetypeIds.length
    ) {
      throw Object.assign(
        new Error(
          "Starting a general optimizer requires exactly one input for each of the six archetypes.",
        ),
        { code: "TESSERA_GENERAL_OPTIMIZER_BASELINES_REQUIRED" },
      );
    }
    const [baselineRosterInput, portfolioInput, rawBaselines] =
      await Promise.all([
        rawJsonInput(
          input.baselineRoster,
          input.baselineRosterPath,
          "TESSERA_GENERAL_OPTIMIZER_BASELINE_ROSTER_REQUIRED",
          "Starting a general optimizer requires a baseline roster path or object.",
        ),
        rawJsonInput(
          input.portfolio,
          input.portfolioPath,
          "TESSERA_GENERAL_OPTIMIZER_PORTFOLIO_REQUIRED",
          "Starting a general optimizer requires a portfolio path or object.",
        ),
        Promise.all(input.baselines.map(rawBaselineInput)),
      ]);
    const portfolioPath = path.join(optimizerDirectory, "portfolio.json");
    const portfolioSha256 = await writeFrozenArtifact(
      path.join(temporaryDirectory, "portfolio.json"),
      portfolioInput.content,
    );
    const portfolioArtifact: TesseraGeneralOptimizerStoredArtifact = {
      kind: "portfolio",
      candidateId: null,
      archetypeId: null,
      path: portfolioPath,
      sha256: portfolioSha256,
    };
    const baselineReportArtifacts: TesseraGeneralOptimizerStoredArtifact[] = [];
    const profilePolicyArtifacts: TesseraGeneralOptimizerStoredArtifact[] = [];
    const baselines = [] as Parameters<
      typeof createTesseraGeneralOptimizerState
    >[0]["baselines"];
    for (const archetypeId of GeneralThreatArchetypeIds) {
      const baseline = rawBaselines.find(
        (entry) => entry.archetypeId === archetypeId,
      )!;
      const slug = safeArtifactSlug(archetypeId);
      const reportFilename = `baseline-${slug}.json`;
      const reportPath = path.join(optimizerDirectory, reportFilename);
      const reportSha256 = await writeFrozenArtifact(
        path.join(temporaryDirectory, reportFilename),
        baseline.reportContent,
      );
      baselineReportArtifacts.push({
        kind: "baseline-report",
        candidateId: null,
        archetypeId,
        path: reportPath,
        sha256: reportSha256,
      });
      let profilePolicyPath: string | null = null;
      let profilePolicySha256: string | null = null;
      if (baseline.profilePolicy && baseline.profilePolicyContent) {
        const policyFilename = `profile-policy-${slug}.json`;
        profilePolicyPath = path.join(optimizerDirectory, policyFilename);
        profilePolicySha256 = await writeFrozenArtifact(
          path.join(temporaryDirectory, policyFilename),
          baseline.profilePolicyContent,
        );
        profilePolicyArtifacts.push({
          kind: "profile-policy",
          candidateId: null,
          archetypeId,
          path: profilePolicyPath,
          sha256: profilePolicySha256,
        });
      }
      baselines.push({
        archetypeId,
        reportPath,
        report: baseline.report,
        reportArtifactSha256: reportSha256,
        profilePolicy: baseline.profilePolicy,
        profilePolicyPath,
        profilePolicyArtifactSha256: profilePolicySha256,
      });
    }
    const created = await createTesseraGeneralOptimizerState({
      mode: input.mode,
      optimizerRunId,
      createdAt: input.createdAt,
      baselineRoster: baselineRosterInput.value,
      portfolio: portfolioInput.value,
      portfolioArtifactSha256: portfolioSha256,
      baselines,
      evaluationRuntime:
        input.evaluationRuntime ?? getRuntimeProvenance(),
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
      canonicalSha256(activeBundleIdentity(baselineRosterInput.value)) !==
        canonicalSha256(created.data.frozenIdentities.bundle)
    ) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      return failure(issue(
        "TESSERA_GENERAL_OPTIMIZER_IDENTITY_INVALIDATED",
        "The completed player roster does not match the active leased data-bundle identity.",
      ));
    }
    const statePath = path.join(
      optimizerDirectory,
      "tessera-general-optimizer.json",
    );
    const document = sealDocument({
      schemaVersion: 1,
      documentKind: "rosterpilot-tessera-general-optimizer-store",
      optimizerRunId,
      optimizerDirectory,
      rootDirectory,
      statePath,
      portfolioArtifact,
      baselineReportArtifacts,
      profilePolicyArtifacts,
      candidateRosterArtifacts: [],
      comparisonArtifacts: [],
      finalRosterArtifact: null,
      state: created.data,
    });
    await writeFile(
      path.join(temporaryDirectory, "tessera-general-optimizer.json"),
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

export async function getTesseraGeneralOptimizerStatus(
  statePath: string,
  options: TesseraGeneralOptimizerStoreAccessOptions = {},
): Promise<TesseraGeneralOptimizerStoreResult> {
  try {
    const document = await readDocument(statePath);
    const identities = await currentIdentities(
      document,
      options.evaluationRuntime ?? getRuntimeProvenance(),
    );
    const verified = verifyTesseraGeneralOptimizerState(
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
    document: TesseraGeneralOptimizerStoreDocument,
    identities: TesseraGeneralOptimizerFrozenIdentities,
  ) => Promise<{
    core: TesseraOptimizerResult<TesseraGeneralOptimizerState>;
    document?: TesseraGeneralOptimizerStoreDocument;
  }>,
): Promise<TesseraGeneralOptimizerStoreResult> {
  const resolved = path.resolve(statePath);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(resolved);
    const original = await readDocument(resolved);
    if (original.state.stateRevision !== expectedStateRevision) {
      return failure(
        issue(
          "TESSERA_GENERAL_OPTIMIZER_STALE_STATE_REVISION",
          `Expected general optimizer revision ${expectedStateRevision}, but the durable state is revision ${original.state.stateRevision}.`,
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
    return resultFromCore(transitioned.core, nextDocument, identities);
  } catch (error) {
    return failure(errorIssue(error));
  } finally {
    if (release) await release().catch(() => undefined);
  }
}

async function freezeCandidateRosters(
  document: TesseraGeneralOptimizerStoreDocument,
  state: TesseraGeneralOptimizerState,
): Promise<TesseraGeneralOptimizerStoredArtifact[]> {
  const artifacts = [...document.candidateRosterArtifacts];
  for (const candidate of state.candidates) {
    if (!candidate.revisedRoster || !candidate.revisedRosterSha256) continue;
    const candidateId = candidate.candidate.candidateId;
    if (artifacts.some((artifact) => artifact.candidateId === candidateId)) {
      continue;
    }
    const filename = path.join(
      document.optimizerDirectory,
      `candidate-${safeArtifactSlug(candidateId)}.json`,
    );
    const content = `${JSON.stringify(candidate.revisedRoster, null, 2)}\n`;
    const sha256 = await writeFrozenArtifact(filename, content);
    artifacts.push({
      kind: "candidate-roster",
      candidateId,
      archetypeId: null,
      path: filename,
      sha256,
    });
  }
  return artifacts.sort((left, right) =>
    (left.candidateId ?? "").localeCompare(right.candidateId ?? ""),
  );
}

export async function approveAndMaterializeTesseraGeneralOptimizerCandidates(
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
): Promise<TesseraGeneralOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => {
      const approvedAt = input.approvedAt ?? new Date().toISOString();
      const approved = approveTesseraGeneralOptimizerCandidateBatch(
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
        await materializeApprovedTesseraGeneralOptimizerCandidates(
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

export async function recordStoredTesseraGeneralOptimizerComparison(
  statePath: string,
  input: {
    expectedStateRevision: number;
    candidateId: string;
    archetypeId: GeneralThreatArchetype;
    requestSha256: string;
    reportPath?: string;
    report?: TesseraRevisionComparisonReport;
    recordedAt?: string;
    evaluationRuntime?: RuntimeProvenance;
  },
): Promise<TesseraGeneralOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => {
      const request = document.state.candidates
        .find((entry) => entry.candidate.candidateId === input.candidateId)
        ?.comparisonRequests.find(
          (entry) => entry.archetypeId === input.archetypeId,
        );
      if (!request || request.requestSha256 !== input.requestSha256) {
        return {
          core: {
            ok: false,
            data: document.state,
            violations: [issue(
              "TESSERA_GENERAL_OPTIMIZER_REQUEST_MISMATCH",
              "The comparison does not bind the frozen candidate/archetype request receipt.",
            )],
            warnings: [],
          },
        };
      }
      let report: TesseraRevisionComparisonReport;
      let content: Buffer;
      if (input.report) {
        report = structuredClone(input.report);
        content = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
      } else if (input.reportPath) {
        content = await readFile(path.resolve(input.reportPath));
        report = JSON.parse(content.toString("utf8")) as
          TesseraRevisionComparisonReport;
      } else {
        return {
          core: {
            ok: false,
            data: document.state,
            violations: [issue(
              "TESSERA_GENERAL_OPTIMIZER_COMPARISON_REPORT_REQUIRED",
              "Recording a comparison requires a report path or object.",
            )],
            warnings: [],
          },
        };
      }
      const artifactSha256 = contentSha256(content);
      const recorded = recordTesseraGeneralOptimizerComparison(
        document.state,
        {
          currentIdentities: identities,
          expectedStateRevision: input.expectedStateRevision,
          candidateId: input.candidateId,
          archetypeId: input.archetypeId,
          requestSha256: input.requestSha256,
          report,
          reportArtifactSha256: artifactSha256,
          recordedAt: input.recordedAt,
        },
      );
      const changed = recorded.data &&
        recorded.data.integritySha256 !== document.state.integritySha256;
      if (!changed || !recorded.data) return { core: recorded };
      const artifactPath = path.join(
        document.optimizerDirectory,
        `comparison-${safeArtifactSlug(input.candidateId)}-${
          safeArtifactSlug(input.archetypeId)
        }.json`,
      );
      await writeFrozenArtifact(artifactPath, content);
      const comparisonArtifact: TesseraGeneralOptimizerStoredArtifact = {
        kind: "comparison-report",
        candidateId: input.candidateId,
        archetypeId: input.archetypeId,
        path: artifactPath,
        sha256: artifactSha256,
      };
      return {
        core: recorded,
        document: sealDocument({
          ...document,
          comparisonArtifacts: [
            ...document.comparisonArtifacts,
            comparisonArtifact,
          ].sort((left, right) => artifactKey(left).localeCompare(
            artifactKey(right),
          )),
          state: recorded.data,
          documentSha256: undefined,
        }),
      };
    },
  );
}

export async function approveStoredTesseraGeneralOptimizerWinner(
  statePath: string,
  input: {
    expectedStateRevision: number;
    candidateId: string;
    approvalId: string;
    approvedBy: string;
    approvedAt?: string;
    evaluationRuntime?: RuntimeProvenance;
  },
): Promise<TesseraGeneralOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => ({
      core: approveTesseraGeneralOptimizerWinner(document.state, {
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

export async function retainStoredTesseraGeneralOptimizerBaseline(
  statePath: string,
  input: {
    expectedStateRevision: number;
    approvalId: string;
    approvedBy: string;
    approvedAt?: string;
    evaluationRuntime?: RuntimeProvenance;
  },
): Promise<TesseraGeneralOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => ({
      core: retainTesseraGeneralOptimizerBaseline(document.state, {
        currentIdentities: identities,
        expectedStateRevision: input.expectedStateRevision,
        approvalId: input.approvalId,
        approvedBy: input.approvedBy,
        approvedAt: input.approvedAt ?? new Date().toISOString(),
      }),
    }),
  );
}

export async function finalizeStoredTesseraGeneralOptimizer(
  statePath: string,
  input: {
    expectedStateRevision: number;
    deliveryIntent: TesseraOptimizerDeliveryIntent;
    finalizedAt?: string;
    evaluationRuntime?: RuntimeProvenance;
  },
): Promise<TesseraGeneralOptimizerStoreResult> {
  return withTransition(
    statePath,
    input.expectedStateRevision,
    input.evaluationRuntime,
    async (document, identities) => {
      const finalized = finalizeTesseraGeneralOptimizer(document.state, {
        currentIdentities: identities,
        expectedStateRevision: input.expectedStateRevision,
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
            archetypeId: null,
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
