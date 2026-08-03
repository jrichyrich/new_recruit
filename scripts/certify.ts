import crypto from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { strToU8 } from "fflate";

import {
  CERTIFICATION_CAPABILITY_BOUNDARY_CODES,
  CERTIFICATION_CAPABILITY_DEPENDENCY_CODES,
  CertificationManifestSchema,
  CertificationReportSchema,
  classifyNamedCharacterSpecialistCapability,
  classifyTesseraPreparationCapability,
  type CertificationCaseResult,
  type CertificationManifest,
  type CertificationReport,
  type CertificationResultStatus,
  type CertificationTier,
  certificationManifestSha256,
  runDeterministicCertification,
} from "../lib/rosterpilot/certification";
import {
  buildRoster,
  compareNewRecruitCatalogueProvenance,
  getNewRecruitCapability,
  getNewRecruitFactionSummary,
  newRecruitCatalogue,
  previewFactionStressPortfolio,
  rosterExecutionFingerprint,
  type ConnectorEvent,
  type NewRecruitDelivery,
  type ResultEnvelope,
  type RosterDraftV1,
  validateEnrichedRoszGameplayIdentity,
} from "../lib/rosterpilot";
import { getLocalAgentStatus } from "../local/agent/client";
import { runTesseraThroughLocalAgent } from "../local/agent/client";
import {
  deduplicateCertificationArtifacts,
} from "../local/certification/artifact-inventory";
import {
  BrowserFixtureRegistrySchema,
  executeBrowserFixtureRegistry,
} from "../local/certification/browser-fixture-execution";
import {
  certificationRelevantChanges,
} from "../local/certification/changed-files";
import {
  loadNewRecruitCache,
  storeNewRecruitCache,
} from "../local/new-recruit/cache";
import {
  loadLiveCertificationProfilePolicy,
  preflightLiveCertificationProfilePolicy,
  resolveLiveProfilePolicyArgument,
  type LiveCertificationProfilePolicySource,
} from "../local/certification/live-profile-policy";
import {
  assertLiveCertificationPlanEntry,
  createLiveCertificationPreflightPlan,
} from "../local/certification/live-preflight-plan";
import {
  deterministicRenamedMirrorRosz,
} from "../local/certification/mirror-rosz";
import {
  certificationResumePolicyIsCompatible,
  loadVerifiedCertificationResumeReport,
  loadVerifiedCertificationResumeArtifact,
  mergeResumedLiveConnectorHistory,
  migrateLegacyTesseraSavedListConnectorEvents,
  preserveCertificationResumeAttempt,
  relocateCertificationResumeArtifactClosure,
} from "../local/certification/live-resume";
import {
  captureLiveTesseraCertificationResult,
} from "../local/certification/live-tessera-evidence";
import {
  certificationNewRecruitFinalizationOutcome,
  runCertificationNewRecruitMutation,
  type CertificationNewRecruitMutationFinalization,
} from "../local/certification/new-recruit-transaction";
import {
  buildOrderedOpponentMatrixPlayer,
} from "../local/certification/ordered-opponent-matrix";
import {
  deriveCertificationCoverageDimensions,
} from "../lib/rosterpilot/certification-coverage";
import {
  deliverRosterToNewRecruit,
  probeNewRecruitLiveUi,
} from "../local/new-recruit/companion";
import { safeNewRecruitUiIdentity } from "../local/new-recruit/ui-identity";
import { getRuntimeProvenance } from "../local/runtime-provenance";
import {
  profilePolicyIdentityKey,
} from "../local/tessera/profile-policy";
import {
  scopedTesseraProfilePolicySha256,
} from "../local/tessera/saved-list-reuse";

type Args = Record<string, string | boolean>;

type LiveNewRecruitFinalization = {
  enrichedPath: string;
  enrichedHash: string;
  bundledEnrichedPath: string;
  uiIdentity: string | null;
  rosterIdentity: ReturnType<
    typeof validateEnrichedRoszGameplayIdentity
  >;
  catalogueProvenance: ReturnType<
    typeof compareNewRecruitCatalogueProvenance
  >;
  event: ConnectorEvent;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected certification argument "${token}".`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    args[key] =
      next && !next.startsWith("--") ? argv[++index] : true;
  }
  return args;
}

function value(args: Args, key: string): string | undefined {
  const found = args[key];
  return typeof found === "string" ? found : undefined;
}

function flag(args: Args, key: string): boolean {
  return args[key] === true || value(args, key) === "true";
}

function certificationHelp(): string {
  return `RosterPilot faction certification

Usage:
  npm run certify -- --tier deterministic|connector|live [options]

Options:
  --faction <id>             Certify one faction.
  --shard <index/total>      Certify one deterministic faction shard.
  --changed-only             Skip when no certification surface changed.
  --portfolio                Add core-3 and 1,000/2,000-point diverse-9 checks.
  --opponent-matrix          Add the ordered local opponent matrix.
  --resume <report.json>     Reuse completed verified stages.
  --profile-policy <path>    Live tier only: canonical v1 Tessera profile policy.
  --require-status <status>  Require pass or degraded.
  --out-dir <path>           Certification bundle directory.
  --overwrite                Replace the report for this run.
  --help                     Show this help.
`;
}

function parseShard(raw: string | undefined) {
  if (!raw) return undefined;
  const match = raw.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid --shard "${raw}". Use a one-based value such as 1/4.`,
    );
  }
  return {
    index: Number(match[1]),
    total: Number(match[2]),
  };
}

function expectedCertificationSelection(
  manifest: CertificationManifest,
  input: {
    requestedFaction: string | null;
    shard: { index: number; total: number } | null;
    changedOnly: boolean;
    skipAll: boolean;
  },
): CertificationReport["selection"] {
  let selected = manifest.factions;
  if (input.requestedFaction) {
    selected = selected.filter(
      (faction) => faction.id === input.requestedFaction,
    );
    requireCondition(
      selected.length === 1,
      "CERTIFICATION_FACTION_NOT_FOUND",
      `Certification manifest has no faction "${input.requestedFaction}".`,
    );
  }
  if (input.shard) {
    requireCondition(
      input.shard.total > 0 &&
        input.shard.index > 0 &&
        input.shard.index <= input.shard.total,
      "CERTIFICATION_SHARD_INVALID",
      `Shard must use a one-based index within its total; received ${input.shard.index}/${input.shard.total}.`,
    );
    selected = selected.filter(
      (_, index) =>
        index % input.shard!.total ===
        input.shard!.index - 1,
    );
  }
  return {
    requestedFaction: input.requestedFaction,
    shard: input.shard,
    changedOnly: input.changedOnly,
    selectedFactionIds: input.skipAll
      ? []
      : selected.map((faction) => faction.id),
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function mergeCertificationNewRecruitUiIdentity(
  report: CertificationReport,
  candidate: unknown,
): string | null {
  const identity = safeNewRecruitUiIdentity(candidate);
  if (!identity) return null;
  const prior = report.provenance.newRecruitUi.identity;
  report.provenance.newRecruitUi.identity =
    prior === null || prior === identity
      ? identity
      : sha256([prior, identity].sort().join("|"));
  return identity;
}

async function fileSha256(filename: string): Promise<string> {
  return sha256(await readFile(filename));
}

function startCase() {
  return { at: timestamp(), ms: Date.now() };
}

function finishCase(
  input: Omit<
    CertificationCaseResult,
    "startedAt" | "completedAt" | "durationMs"
  >,
  started: ReturnType<typeof startCase>,
): CertificationCaseResult {
  return {
    ...input,
    startedAt: started.at,
    completedAt: timestamp(),
    durationMs: Math.max(0, Date.now() - started.ms),
  };
}

function failureCase(
  caseId: string,
  factionId: string | null,
  workflow: CertificationCaseResult["workflow"],
  stage: string,
  error: unknown,
  started: ReturnType<typeof startCase>,
): CertificationCaseResult {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "CERTIFICATION_STAGE_FAILED";
  return finishCase(
    {
      caseId,
      factionId,
      workflow,
      stage,
      status: "fail",
      code,
      message:
        error instanceof Error
          ? error.message
          : "The certification stage failed.",
      retryable: false,
      evidence: {},
      artifacts: [],
      connectorEvents: [],
    },
    started,
  );
}

function requireCondition(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (condition) return;
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

function blankStatuses(): Record<CertificationResultStatus, number> {
  return {
    pass: 0,
    fail: 0,
    unsupported: 0,
    degraded: 0,
    skipped: 0,
  };
}

function deterministicCaseIds(
  manifest: CertificationManifest,
  factionId: string,
): Set<string> {
  const faction = manifest.factions.find(
    (candidate) => candidate.id === factionId,
  );
  if (!faction) return new Set();
  return new Set([
    ...(faction.expertReview.status === "pending"
      ? [`${factionId}:expert-review:pending`]
      : faction.expertReview.assertions.map(
          (_, assertionIndex) =>
            `${factionId}:expert-review:${String(assertionIndex + 1).padStart(2, "0")}`,
        )),
    `${factionId}:mapping-baseline`,
    ...faction.representativeRosters
      .filter((roster) =>
        roster.capabilities.includes("roster-correctness"),
      )
      .map(
        (roster) =>
          `${factionId}:build:${roster.pointsLimit}`,
      ),
    `${factionId}:determinism`,
    `${factionId}:hard-constraints`,
    ...faction.representativeRosters
      .filter((roster) =>
        roster.capabilities.includes("new-recruit-export"),
      )
      .map(
        (roster) =>
          `${factionId}:canonical-rosz:${roster.id}`,
      ),
  ]);
}

function completedDeterministicFactionIds(
  previous: CertificationReport | null,
  manifest: CertificationManifest,
): Set<string> {
  if (!previous) return new Set();
  return new Set(
    previous.selection.selectedFactionIds.filter((factionId) => {
      const expected = deterministicCaseIds(manifest, factionId);
      return (
        expected.size > 0 &&
        [...expected].every((caseId) =>
          previous.cases.some(
            (result) =>
              result.caseId === caseId &&
              result.status !== "fail" &&
              result.status !== "skipped",
          ),
        )
      );
    }),
  );
}

function isBundleRelativeArtifactPath(filename: string): boolean {
  const normalized = path.normalize(filename);
  return (
    !path.isAbsolute(normalized) &&
    normalized !== ".." &&
    !normalized.startsWith(`..${path.sep}`)
  );
}

async function verifyBundleRelativeArtifacts(
  results: CertificationCaseResult[],
  bundleDirectory: string,
): Promise<boolean> {
  for (const result of results) {
    for (const artifact of result.artifacts) {
      if (
        !artifact.sha256 ||
        !isBundleRelativeArtifactPath(artifact.path)
      ) {
        return false;
      }
      const candidate = path.resolve(
        bundleDirectory,
        artifact.path,
      );
      const relative = path.relative(
        path.resolve(bundleDirectory),
        candidate,
      );
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return false;
      }
      try {
        if ((await fileSha256(candidate)) !== artifact.sha256) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }
  return true;
}

function recomputeCoverage(
  report: CertificationReport,
  manifest: CertificationManifest,
): void {
  const workflowNames = [
    "oracle",
    "roster-correctness",
    "new-recruit-export",
    "new-recruit-delivery",
    "tessera-preparation",
    "tessera-simulation",
    "browser-fixture",
  ] as const;
  report.coverage.workflows = Object.fromEntries(
    workflowNames.map((workflow) => [workflow, blankStatuses()]),
  ) as CertificationReport["coverage"]["workflows"];
  for (const result of report.cases) {
    report.coverage.workflows[result.workflow][result.status] += 1;
  }
  const selected = report.selection.selectedFactionIds;
  const factionCases = (factionId: string) =>
    report.cases.filter((result) => result.factionId === factionId);
  report.coverage.factions = {
    intended: selected.length,
    exercised: selected.filter(
      (factionId) => factionCases(factionId).length > 0,
    ).length,
    passed: selected.filter((factionId) => {
      const results = factionCases(factionId);
      const factionCoverage =
        deriveCertificationCoverageDimensions({
          manifest,
          selectedFactionIds: [factionId],
          cases: results,
        });
      return (
        results.some((result) => result.status === "pass") &&
        factionCoverage.specialistCases.missing.length === 0 &&
        factionCoverage.detachments.missing.length === 0 &&
        !results.some((result) =>
          ["fail", "unsupported", "degraded"].includes(
            result.status,
          ),
        )
      );
    }).length,
    failed: selected.filter((factionId) =>
      factionCases(factionId).some((result) => result.status === "fail"),
    ).length,
    unsupported: selected.filter((factionId) =>
      factionCases(factionId).some(
        (result) =>
          result.status === "unsupported" &&
          result.stage !== "ordered-local-opponent-matrix",
      ),
    ).length,
    pendingExpertReview: manifest.factions.filter(
      (faction) =>
        selected.includes(faction.id) &&
        faction.expertReview.status !== "reviewed",
    ).length,
  };
  report.coverage.browserFixtures.exercised = new Set(
    report.cases
      .filter(
        (result) =>
          result.workflow === "browser-fixture" &&
          result.status === "pass",
      )
      .map((result) => result.caseId),
  ).size;
  report.coverage.dimensions =
    deriveCertificationCoverageDimensions({
      manifest,
      selectedFactionIds: selected,
      cases: report.cases,
    });
  report.limitations = report.limitations.filter(
    (limitation) =>
      !limitation.startsWith(
        "Missing specialist certification evidence:",
      ) &&
      !limitation.startsWith(
        "Missing detachment certification evidence:",
      ),
  );
  if (
    report.coverage.dimensions.specialistCases.missing.length >
    0
  ) {
    report.limitations.push(
      `Missing specialist certification evidence: ${report.coverage.dimensions.specialistCases.missing.join(", ")}.`,
    );
  }
  if (
    report.coverage.dimensions.detachments.missing.length > 0
  ) {
    report.limitations.push(
      `Missing detachment certification evidence: ${report.coverage.dimensions.detachments.missing.join(", ")}.`,
    );
  }
  report.connectorEvents = report.cases.flatMap(
    (result) => result.connectorEvents,
  );
  const failed = report.cases.some((result) => result.status === "fail");
  report.ok = !failed;
  report.status = failed
    ? "fail"
    : report.coverage.factions.pendingExpertReview > 0 ||
        report.coverage.dimensions.specialistCases.missing.length >
          0 ||
        report.coverage.dimensions.detachments.missing.length > 0 ||
        report.coverage.factions.passed <
          report.coverage.factions.intended ||
        report.cases.some((result) =>
          ["unsupported", "degraded"].includes(result.status),
        )
      ? "degraded"
      : "pass";
}

async function addBrowserFixtureCertification(
  report: CertificationReport,
  manifest: CertificationManifest,
  projectRoot: string,
  outputDirectory: string,
  progress: (message: string) => void,
): Promise<void> {
  const registryPath = path.join(
    projectRoot,
    "data",
    "certification-browser-fixtures.json",
  );
  const registry = BrowserFixtureRegistrySchema.parse(
    JSON.parse(await readFile(registryPath, "utf8")),
  );
  const registryIds = new Set(
    registry.fixtures.map((fixture) => fixture.id),
  );
  const unregistered = manifest.browserFixtures.filter(
    (fixtureId) => !registryIds.has(fixtureId),
  );
  requireCondition(
    unregistered.length === 0,
    "CERTIFICATION_BROWSER_FIXTURE_MANIFEST_DRIFT",
    `Certification manifest fixtures are not registered: ${unregistered.join(", ")}.`,
  );
  const fixtureIds = registry.fixtures.map((fixture) => fixture.id);
  report.coverage.browserFixtures.intended = fixtureIds.length;
  progress(
    `Executing ${fixtureIds.length} registered local browser fixtures.`,
  );
  const execution = await executeBrowserFixtureRegistry({
    projectRoot,
    registryPath,
    fixtureIds,
  });
  const executionContent = strToU8(
    `${JSON.stringify(execution, null, 2)}\n`,
  );
  const executionSha256 = sha256(executionContent);
  const executionPath = await writeCertificationArtifact(
    outputDirectory,
    `browser-fixture-evidence-${execution.executionId.slice(0, 12)}.json`,
    executionContent,
  );
  const executionArtifact = {
    kind: "browser-fixture-evidence" as const,
    path: executionPath,
    sha256: executionSha256,
  };
  for (const fixtureResult of execution.results) {
    const started = startCase();
    const passed = fixtureResult.status === "pass";
    report.cases.push(
      finishCase(
        {
          caseId: fixtureResult.id,
          factionId: null,
          workflow: "browser-fixture",
          stage: "recorded-execution",
          status: passed ? "pass" : "fail",
          code: fixtureResult.code,
          message: passed
            ? "The registered local browser fixture executed successfully."
            : fixtureResult.detail ??
              "The registered local browser fixture did not execute successfully.",
          retryable: false,
          evidence: {
            automatedBy: fixtureResult.automatedBy,
            testName: fixtureResult.testName,
            executionId: execution.executionId,
            executionEvidenceSha256: executionSha256,
            durationMs: fixtureResult.durationMs,
            observedStatus: fixtureResult.status,
            requiredByManifest: manifest.browserFixtures.includes(
              fixtureResult.id,
            ),
            nodeVersion: execution.runner.nodeVersion,
            platform: execution.runner.platform,
          },
          artifacts: [executionArtifact],
          connectorEvents: [],
        },
        started,
      ),
    );
  }
}

async function addFactionPortfolioCertification(
  report: CertificationReport,
  manifest: CertificationManifest,
  progress: (message: string) => void,
): Promise<void> {
  for (const factionId of report.selection.selectedFactionIds) {
    const faction = manifest.factions.find(
      (candidate) => candidate.id === factionId,
    );
    if (!faction) continue;
    const started = startCase();
    progress(`Certifying ${faction.name} core-3 portfolio.`);
    try {
      const preview = await previewFactionStressPortfolio({
        faction: faction.id,
        pointsLimit: 1000,
        suite: "core-3",
        pointsTolerancePercent: 5,
        allowLegends: false,
      });
      const gates = preview.data?.gates ?? null;
      const mappingCapability =
        getNewRecruitCapability(faction.id);
      const classification =
        classifyTesseraPreparationCapability(
          faction.tesseraPreparation,
          {
            mappingAvailable: mappingCapability.available,
            available: Boolean(preview.data),
            executionViable: Boolean(
              gates?.executionViable && gates.accepted,
            ),
            maximumResultStatus:
              gates?.maximumResultStatus ?? null,
          },
        );
      report.cases.push(
        finishCase(
          {
            caseId: `${faction.id}:portfolio:core-3`,
            factionId: faction.id,
            workflow: "tessera-preparation",
            stage: "faction-core-3",
            status: classification.status,
            code: classification.code,
            message:
              classification.status === "pass"
                ? `${faction.name} produced three unique, exportable balanced, ranged, and assault proxies.`
                : `${faction.name} did not satisfy its declared core-3 portfolio capability.`,
            retryable: false,
            evidence: {
              expectedCapability: faction.tesseraPreparation,
              mappingCapability,
              portfolioPolicy:
                faction.portfolioPolicy ??
                manifest.defaults.portfolioPolicy,
              gates,
              violations: preview.violations,
              warnings: preview.data?.warnings ?? [],
            },
            artifacts: [],
            connectorEvents: [],
          },
          started,
        ),
      );
      for (const pointsLimit of [1000, 2000]) {
        const diverseStarted = startCase();
        progress(
          `Certifying ${faction.name} diverse-9 portfolio at ${pointsLimit} points.`,
        );
        try {
          const diverse =
            await previewFactionStressPortfolio({
              faction: faction.id,
              pointsLimit,
              suite: "diverse-9",
              pointsTolerancePercent: 5,
              allowLegends: false,
            });
          const diverseGates = diverse.data?.gates ?? null;
          const diverseClassification =
            classifyTesseraPreparationCapability(
              faction.tesseraPreparation,
              {
                mappingAvailable: mappingCapability.available,
                available: Boolean(diverse.data),
                executionViable: Boolean(
                  diverseGates?.executionViable &&
                    diverseGates.accepted,
                ),
                maximumResultStatus:
                  diverseGates?.maximumResultStatus ?? null,
              },
            );
          report.cases.push(
            finishCase(
              {
                caseId:
                  `${faction.id}:portfolio:diverse-9:${pointsLimit}`,
                factionId: faction.id,
                workflow: "tessera-preparation",
                stage: "faction-diverse-9",
                status: diverseClassification.status,
                code: diverseClassification.code,
                message:
                  diverseClassification.status === "pass"
                    ? `${faction.name} produced an accepted adaptive nine-list portfolio at ${pointsLimit} points.`
                    : `${faction.name} did not satisfy its declared diverse-9 portfolio capability at ${pointsLimit} points.`,
                retryable: false,
                evidence: {
                  expectedCapability:
                    faction.tesseraPreparation,
                  mappingCapability,
                  portfolioPolicy:
                    faction.portfolioPolicy ??
                    manifest.defaults.portfolioPolicy,
                  pointsLimit,
                  gates: diverseGates,
                  violations: diverse.violations,
                  warnings: diverse.data?.warnings ?? [],
                },
                artifacts: [],
                connectorEvents: [],
              },
              diverseStarted,
            ),
          );
        } catch (error) {
          report.cases.push(
            failureCase(
              `${faction.id}:portfolio:diverse-9:${pointsLimit}`,
              faction.id,
              "tessera-preparation",
              "faction-diverse-9",
              error,
              diverseStarted,
            ),
          );
        }
      }
      if (!mappingCapability.available) continue;
      const specialistStarted = startCase();
      const policy =
        faction.portfolioPolicy ??
        manifest.defaults.portfolioPolicy;
      const observed =
        gates?.namedCharacterCoverageStatus ??
        "unavailable-after-evaluation";
      const specialist =
        classifyNamedCharacterSpecialistCapability(
          policy.namedCharacterSpecialist,
          observed,
        );
      report.cases.push(
        finishCase(
          {
            caseId: `${faction.id}:specialist:named-character`,
            factionId: faction.id,
            workflow: "tessera-preparation",
            stage: "named-character-specialist",
            status: specialist.status,
            code: specialist.code,
            message:
              specialist.status === "pass"
                ? `${faction.name} produced a separately auditable named-character specialist proxy.`
                : `${faction.name} reported ${observed} for its named-character specialist capability.`,
            retryable: false,
            evidence: {
              expectation: policy.namedCharacterSpecialist,
              observed,
              reason:
                gates?.namedCharacterCoverageReason ?? null,
              structuralFingerprint:
                gates?.namedCharacterSpecialistStructuralFingerprint ??
                null,
              simulationFingerprint:
                gates?.namedCharacterSpecialistSimulationFingerprint ??
                null,
              coreMaximumResultStatus:
                gates?.maximumResultStatus ?? null,
            },
            artifacts: [],
            connectorEvents: [],
          },
          specialistStarted,
        ),
      );
    } catch (error) {
      report.cases.push(
        failureCase(
          `${faction.id}:portfolio:core-3`,
          faction.id,
          "tessera-preparation",
          "faction-core-3",
          error,
          started,
        ),
      );
    }
  }
}

async function addOpponentMatrixCertification(
  report: CertificationReport,
  manifest: CertificationManifest,
  progress: (message: string) => void,
): Promise<void> {
  const previews = new Map<
    string,
    Awaited<ReturnType<typeof previewFactionStressPortfolio>>
  >();
  for (const [index, opponent] of manifest.factions.entries()) {
    const previewStartedAt = Date.now();
    progress(
      `Preparing opponent portfolio ${index + 1}/${manifest.factions.length}: ${opponent.name}.`,
    );
    const preview = await previewFactionStressPortfolio({
      faction: opponent.id,
      pointsLimit: 1000,
      suite: "core-3",
      pointsTolerancePercent: 5,
      allowLegends: false,
    });
    previews.set(opponent.id, preview);
    progress(
      `Prepared ${opponent.name} in ${Date.now() - previewStartedAt}ms (${preview.data?.gates.maximumResultStatus ?? preview.violations[0]?.code ?? "unavailable"}).`,
    );
  }
  for (const opponent of manifest.factions) {
    const started = startCase();
    const preview = previews.get(opponent.id);
    const capability = getNewRecruitCapability(opponent.id);
    const policy =
      opponent.portfolioPolicy ??
      manifest.defaults.portfolioPolicy;
    if (!capability.available) {
      report.cases.push(
        finishCase(
          {
            caseId: `${opponent.id}:specialist:named-character`,
            factionId: opponent.id,
            workflow: "tessera-preparation",
            stage: "named-character-specialist",
            status: "unsupported",
            code: "NEW_RECRUIT_MAPPING_UNAVAILABLE",
            message:
              "Named-character specialist preparation stopped at the declared New Recruit mapping boundary.",
            retryable: false,
            evidence: {
              expectation: policy.namedCharacterSpecialist,
              capability,
            },
            artifacts: [],
            connectorEvents: [],
          },
          started,
        ),
      );
      continue;
    }
    const observed =
      preview?.data?.gates.namedCharacterCoverageStatus ??
      "unavailable-after-evaluation";
    const classification =
      classifyNamedCharacterSpecialistCapability(
        policy.namedCharacterSpecialist,
        observed,
      );
    const reason =
      preview?.data?.gates.namedCharacterCoverageReason;
    report.cases.push(
      finishCase(
        {
          caseId: `${opponent.id}:specialist:named-character`,
          factionId: opponent.id,
          workflow: "tessera-preparation",
          stage: "named-character-specialist",
          status: classification.status,
          code: classification.code,
          message:
            classification.status === "pass"
              ? `${opponent.name} produced a legal, exportable named-character specialist proxy.`
              : classification.status === "skipped"
                ? policy.namedCharacterSpecialist === "not-applicable"
                  ? `${opponent.name} has an expert-reviewed named-character not-applicable result. ${reason ?? ""}`.trim()
                  : `${opponent.name} requires expert review of its named-character not-applicable result. ${reason ?? ""}`.trim()
                : `${opponent.name} did not produce the declared named-character specialist capability. ${reason ?? ""}`.trim(),
          retryable: false,
          evidence: {
            expectation: policy.namedCharacterSpecialist,
            observed,
            reason: reason ?? null,
            structuralFingerprint:
              preview?.data?.gates
                .namedCharacterSpecialistStructuralFingerprint ??
              null,
            simulationFingerprint:
              preview?.data?.gates
                .namedCharacterSpecialistSimulationFingerprint ??
              null,
            coreMaximumResultStatus:
              preview?.data?.gates.maximumResultStatus ?? null,
          },
          artifacts: [],
          connectorEvents: [],
        },
        started,
      ),
    );
  }
  for (const playerId of report.selection.selectedFactionIds) {
    const player = manifest.factions.find(
      (candidate) => candidate.id === playerId,
    );
    requireCondition(
      player,
      "CERTIFICATION_FACTION_NOT_FOUND",
      `No manifest entry exists for ordered-matrix player ${playerId}.`,
    );
    for (const opponent of manifest.factions) {
      const started = startCase();
      const caseId = `${playerId}:against:${opponent.id}:core-3`;
      try {
        const playerEvidence =
          buildOrderedOpponentMatrixPlayer({
            playerFactionId: player.id,
            playerFactionName: player.name,
            opponentFactionId: opponent.id,
            opponentFactionName: opponent.name,
            pointsLimit: 1000,
            preferences: manifest.defaults.preferences,
            allowNamedCharacters:
              manifest.defaults.allowNamedCharacters,
            allowLegends: false,
          });
        const preview = previews.get(opponent.id);
        const gates = preview?.data?.gates ?? null;
        const mappingCapability =
          getNewRecruitCapability(opponent.id);
        const classification =
          classifyTesseraPreparationCapability(
            opponent.tesseraPreparation,
            {
              mappingAvailable: mappingCapability.available,
              available: Boolean(preview?.data),
              executionViable: Boolean(
                gates?.executionViable && gates.accepted,
              ),
              maximumResultStatus:
                gates?.maximumResultStatus ?? null,
            },
          );
        const limitations = [
          ...(preview?.violations.map((issue) => issue.message) ?? []),
          ...(preview?.data?.warnings ?? []),
        ];
        const statusDescription =
          classification.status === "unsupported"
            ? "is an expected capability boundary"
            : classification.status === "fail"
              ? "does not match its declared capability"
              : `produced a ${gates?.maximumResultStatus} core-3 portfolio`;
        report.cases.push(
          finishCase(
            {
              caseId,
              factionId: playerId,
              workflow: "tessera-preparation",
              stage: "ordered-local-opponent-matrix",
              status: classification.status,
              code: classification.code,
              message: `${player.name} built and validated against ${opponent.name}; its opponent portfolio ${statusDescription}.${limitations.length > 0 ? ` ${limitations.join(" ")}` : ""}`,
              retryable: false,
              evidence: {
                orderedPair: {
                  playerFactionId: player.id,
                  opponentFactionId: opponent.id,
                },
                playerBuild: playerEvidence,
                opponentFactionId: opponent.id,
                expectedCapability:
                  opponent.tesseraPreparation,
                mappingCapability,
                portfolioPolicy:
                  opponent.portfolioPolicy ??
                  manifest.defaults.portfolioPolicy,
                gates,
                violations: preview?.violations ?? [],
                warnings: preview?.data?.warnings ?? [],
                simulationFingerprints:
                  preview?.data?.items.map(
                    (item) => item.simulationFingerprint,
                  ) ?? [],
              },
              artifacts: [],
              connectorEvents: [],
            },
            started,
          ),
        );
      } catch (error) {
        report.cases.push(
          failureCase(
            caseId,
            playerId,
            "tessera-preparation",
            "ordered-local-opponent-matrix",
            error,
            started,
          ),
        );
      }
    }
  }
}

function buildLiveRoster(
  manifest: CertificationManifest,
  factionId: string,
  runId: string,
): RosterDraftV1 {
  const faction = manifest.factions.find((entry) => entry.id === factionId);
  requireCondition(
    faction,
    "CERTIFICATION_FACTION_NOT_FOUND",
    `No manifest entry exists for ${factionId}.`,
  );
  const result = buildRoster({
    playerFaction: faction.id,
    pointsLimit: manifest.defaults.pointBands[0],
    name: `RP Certification ${faction.name} ${runId.slice(0, 8)}`,
    preferences: manifest.defaults.preferences,
    allowNamedCharacters: manifest.defaults.allowNamedCharacters,
    allowLegends: false,
  });
  requireCondition(
    result.ok && result.data,
    result.violations[0]?.code ?? "CERTIFICATION_LIVE_BUILD_FAILED",
    result.violations.map((issue) => issue.message).join(" ") ||
      `No live roster was built for ${faction.name}.`,
  );
  return result.data;
}

async function addLiveCertification(
  report: CertificationReport,
  manifest: CertificationManifest,
  outputDirectory: string,
  profilePolicySource: LiveCertificationProfilePolicySource | null,
  previous: CertificationReport | null,
  resumeBundleDirectory: string | null,
): Promise<void> {
  if (process.env.ROSTERPILOT_CERTIFICATION_LIVE !== "1") {
    const started = startCase();
    report.cases.push(
      finishCase(
        {
          caseId: "live:authorization",
          factionId: null,
          workflow: "new-recruit-delivery",
          stage: "live-authorization",
          status: "fail",
          code: "LIVE_CERTIFICATION_NOT_ENABLED",
          message:
            "Live certification requires ROSTERPILOT_CERTIFICATION_LIVE=1 because it creates run-scoped New Recruit and Tessera lists.",
          retryable: false,
          evidence: {},
          artifacts: [],
          connectorEvents: [],
        },
        started,
      ),
    );
    return;
  }
  const preflightStarted = startCase();
  const preflight =
    await createLiveCertificationPreflightPlan({
      manifest,
      selectedFactionIds:
        report.selection.selectedFactionIds,
      runId: report.runId,
      outputDirectory,
      profilePolicySource,
    });
  if (!preflight.ok || !preflight.plan) {
    const firstFailure = preflight.failures[0];
    report.cases.push(
      finishCase(
        {
          caseId: "live:immutable-preflight-plan",
          factionId: null,
          workflow: "oracle",
          stage: "live-preflight",
          status: "fail",
          code:
            firstFailure?.code ??
            "CERTIFICATION_LIVE_PREFLIGHT_FAILED",
          message:
            "The all-faction live execution plan failed before connector mutation. No New Recruit list was delivered and Tessera was not opened.",
          retryable: preflight.failures.some(
            (failure) => failure.retryable,
          ),
          evidence: {
            failures: preflight.failures,
            selectedFactionIds:
              report.selection.selectedFactionIds,
            newRecruitMutationStarted: false,
            tesseraMutationStarted: false,
            partialPreparationRetained: false,
          },
          artifacts: [],
          connectorEvents: [],
        },
        preflightStarted,
      ),
    );
    return;
  }
  const livePlan = preflight.plan;
  report.cases.push(
    finishCase(
      {
        caseId: "live:immutable-preflight-plan",
        factionId: null,
        workflow: "oracle",
        stage: "live-preflight",
        status: "pass",
        code: null,
        message:
          "Validated and froze every selected live roster, output path, profile policy, runtime, and required connector before external mutation.",
        retryable: false,
        evidence: {
          planSha256: livePlan.planSha256,
          selectedFactionIds:
            livePlan.selectedFactionIds,
          plannedFactionIds: livePlan.entries.map(
            (entry) => entry.factionId,
          ),
          skippedFactionIds:
            livePlan.skippedFactionIds,
          requiresNewRecruit:
            livePlan.requiresNewRecruit,
          requiresTessera: livePlan.requiresTessera,
          runtimeBuildId: livePlan.runtimeBuildId,
          newRecruitRuntimeBuildId:
            livePlan.newRecruitRuntimeBuildId,
          tesseraRuntimeBuildId:
            livePlan.tesseraRuntimeBuildId,
          newRecruitMutationStarted: false,
          tesseraMutationStarted: false,
        },
        artifacts: [],
        connectorEvents: [],
      },
      preflightStarted,
    ),
  );
  for (const factionId of report.selection.selectedFactionIds) {
    const faction = manifest.factions.find(
      (candidate) => candidate.id === factionId,
    )!;
    if (faction.rosterCorrectness === "unsupported") {
      const started = startCase();
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-build`,
            factionId,
            workflow: "roster-correctness",
            stage: "live-preflight",
            status: "unsupported",
            code:
              CERTIFICATION_CAPABILITY_BOUNDARY_CODES.rosterCorrectness,
            message:
              "Live certification stopped before connector activity at the manifest-declared roster-correctness boundary.",
            retryable: false,
            evidence: {
              capability: faction.rosterCorrectness,
              expectedLimitations: faction.expectedLimitations,
              newRecruitMutationStarted: false,
              tesseraMutationStarted: false,
            },
            artifacts: [],
            connectorEvents: [],
          },
          started,
        ),
      );
      continue;
    }
    if (faction.newRecruitExport === "unsupported") {
      const preparationStarted = startCase();
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-new-recruit`,
            factionId,
            workflow: "new-recruit-delivery",
            stage: "live-preflight",
            status: "unsupported",
            code:
              CERTIFICATION_CAPABILITY_BOUNDARY_CODES.newRecruitExport,
            message:
              "Live delivery stopped before connector activity at the manifest-declared canonical-export mapping boundary.",
            retryable: false,
            evidence: {
              capability: faction.newRecruitExport,
              expectedLimitations: faction.expectedLimitations,
              newRecruitMutationStarted: false,
            },
            artifacts: [],
            connectorEvents: [],
          },
          preparationStarted,
        ),
      );
      const simulationStarted = startCase();
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-tessera`,
            factionId,
            workflow: "tessera-simulation",
            stage: "live-preflight",
            status: "unsupported",
            code:
              CERTIFICATION_CAPABILITY_DEPENDENCY_CODES.trustedSimulationBlockedByExport,
            message:
              "Trusted Tessera simulation stopped before connector activity because no canonical New Recruit archive can be exported for this faction.",
            retryable: false,
            evidence: {
              dependency: "new-recruit-export",
              dependencyCapability: faction.newRecruitExport,
              tesseraMutationStarted: false,
            },
            artifacts: [],
            connectorEvents: [],
          },
          simulationStarted,
        ),
      );
      continue;
    }
    if (faction.newRecruitDelivery === "unsupported") {
      const preparationStarted = startCase();
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-new-recruit`,
            factionId,
            workflow: "new-recruit-delivery",
            stage: "live-preflight",
            status: "unsupported",
            code:
              CERTIFICATION_CAPABILITY_BOUNDARY_CODES.newRecruitDelivery,
            message:
              "Credential-backed New Recruit delivery stopped before connector activity at the manifest-declared delivery boundary.",
            retryable: false,
            evidence: {
              capability: faction.newRecruitDelivery,
              expectedLimitations: faction.expectedLimitations,
              newRecruitMutationStarted: false,
            },
            artifacts: [],
            connectorEvents: [],
          },
          preparationStarted,
        ),
      );
      const simulationStarted = startCase();
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-tessera`,
            factionId,
            workflow: "tessera-simulation",
            stage: "live-preflight",
            status: "unsupported",
            code:
              CERTIFICATION_CAPABILITY_DEPENDENCY_CODES.trustedSimulationBlockedByDelivery,
            message:
              "Trusted Tessera simulation stopped before connector activity because verified New Recruit delivery is outside this faction's declared capability.",
            retryable: false,
            evidence: {
              dependency: "new-recruit-delivery",
              dependencyCapability: faction.newRecruitDelivery,
              tesseraMutationStarted: false,
            },
            artifacts: [],
            connectorEvents: [],
          },
          simulationStarted,
        ),
      );
      continue;
    }

    let roster: RosterDraftV1;
    let factionDirectory: string;
    try {
      const planned =
        assertLiveCertificationPlanEntry(
          livePlan,
          factionId,
        );
      roster = planned.roster as RosterDraftV1;
      factionDirectory = planned.factionDirectory;
    } catch (error) {
      const started = startCase();
      report.cases.push(
        failureCase(
          `${factionId}:live-build`,
          factionId,
          "new-recruit-delivery",
          "live-preflight",
          error,
          started,
        ),
      );
      continue;
    }

    const preparationStarted = startCase();
    let enrichedPath: string | null = null;
    let newRecruitMutationStarted = false;
    let mutationCandidate:
      | ResultEnvelope<NewRecruitDelivery>
      | null = null;
    const retainedMutationCandidate = ():
      | ResultEnvelope<NewRecruitDelivery>
      | null => mutationCandidate;
    try {
      const resumedArtifact =
        previous && resumeBundleDirectory
          ? await loadVerifiedCertificationResumeArtifact({
              previous,
              resumeBundleDirectory,
              factionId,
              roster,
            })
          : null;
      const cached = resumedArtifact
        ? null
        : await loadNewRecruitCache(roster);
      let preparationOrigin:
        | "manifest-reuse"
        | "persistent-cache"
        | "new-remote";
      let delivered: ResultEnvelope<NewRecruitDelivery>;
      let mutationTransactionState:
        | "verified"
        | "uncertain"
        | "safe-failed"
        | null = null;
      let finalization: LiveNewRecruitFinalization | null =
        null;
      let currentLiveProbe:
        | {
            attempted: boolean;
            ok: boolean;
            sessionReused: boolean | null;
            importControlVisible: boolean | null;
            uiIdentity: string | null;
            satisfiedBy:
              | "authenticated-probe"
              | "fresh-new-remote-delivery";
          }
        | null = null;
      let probeEvent: ConnectorEvent | null = null;
      const finalizePreparation = async (
        candidate: ResultEnvelope<NewRecruitDelivery>,
        origin: typeof preparationOrigin,
      ): Promise<
        CertificationNewRecruitMutationFinalization<LiveNewRecruitFinalization>
      > => {
        requireCondition(
          candidate.data?.enrichedSummary,
          candidate.violations[0]?.code ??
            "CERTIFICATION_NEW_RECRUIT_DELIVERY_FAILED",
          candidate.violations
            .map((issue) => issue.message)
            .join(" ") ||
            "New Recruit did not return a verified enriched roster.",
        );
        requireCondition(
          origin !== "new-remote" ||
            candidate.data.imported,
          "CERTIFICATION_NEW_RECRUIT_IMPORT_UNCONFIRMED",
          "New Recruit returned a successful preparation without confirming that the run-scoped list was imported.",
        );
        const uiIdentity = safeNewRecruitUiIdentity(
          candidate.data.uiIdentity,
        );
        requireCondition(
          origin !== "new-remote" || uiIdentity,
          "NEW_RECRUIT_UI_IDENTITY_MISSING",
          "The imported list has no authenticated New Recruit UI identity. Its artifacts are retained, but the remote outcome cannot be certified or retried automatically.",
        );
        const deliveredEnrichedPath =
          candidate.data.artifacts.find(
            (artifact) =>
              artifact.format ===
              "new-recruit-enriched-rosz",
          )?.written ?? null;
        requireCondition(
          deliveredEnrichedPath,
          "CERTIFICATION_ENRICHED_ROSZ_MISSING",
          "The verified New Recruit delivery has no enriched ROSZ path.",
        );
        const enrichedContent = await readFile(
          deliveredEnrichedPath,
        );
        const rosterIdentity =
          validateEnrichedRoszGameplayIdentity(
            enrichedContent,
            roster,
          );
        requireCondition(
          origin !== "new-remote" ||
            rosterIdentity.presentationNameMatched,
          "NEW_RECRUIT_ROSTER_NAME_MISMATCH",
          `New Recruit returned roster name "${rosterIdentity.observedRosterName}" instead of the requested run-scoped name "${rosterIdentity.requestedRosterName}".`,
        );
        const enrichedHash = sha256(enrichedContent);
        const pinnedFaction =
          getNewRecruitFactionSummary(factionId);
        requireCondition(
          pinnedFaction?.catalogue.id,
          "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNAVAILABLE",
          `The pinned ${faction.name} catalogue identity is unavailable.`,
        );
        const catalogueProvenance =
          compareNewRecruitCatalogueProvenance(
            rosterIdentity.summary,
            {
              releaseId: roster.sourceData.releaseId,
              gameSystem: {
                id: newRecruitCatalogue.gameSystem.id,
                name: newRecruitCatalogue.gameSystem.name,
                revision:
                  roster.sourceData.newRecruit
                    .gameSystemRevision,
              },
              catalogue: {
                id: pinnedFaction.catalogue.id,
                name: pinnedFaction.catalogue.name,
                revision:
                  roster.sourceData.newRecruit
                    .catalogueRevision,
              },
            },
          );
        const event: ConnectorEvent = {
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          recordedAt: timestamp(),
          provider: "new-recruit",
          action: "prepare",
          origin,
          outcome:
            certificationNewRecruitFinalizationOutcome(
              origin,
              catalogueProvenance.status === "matched",
            ),
          remoteId: candidate.data.listUrl
            ? sha256(candidate.data.listUrl)
            : null,
          contentSha256: enrichedHash,
        };
        if (
          origin === "new-remote" &&
          catalogueProvenance.status === "matched"
        ) {
          await storeNewRecruitCache(roster, candidate);
          const verifiedCache =
            await loadNewRecruitCache(roster);
          requireCondition(
            verifiedCache?.ok &&
              verifiedCache.data?.enrichedSummary,
            "CERTIFICATION_NEW_RECRUIT_CACHE_VERIFICATION_FAILED",
            "The verified New Recruit preparation was not durably recoverable from its hash-verified cache.",
          );
        }
        const bundledEnrichedPath =
          await writeCertificationArtifact(
            outputDirectory,
            `${factionId}-${enrichedHash.slice(0, 12)}-new-recruit-enriched.rosz`,
            enrichedContent,
          );
        const transactionState =
          catalogueProvenance.status === "matched"
            ? ("verified" as const)
            : ("uncertain" as const);
        return {
          transactionState,
          connectorEvent: event,
          message:
            transactionState === "verified"
              ? "Verified New Recruit identity, catalogue provenance, and persistent cache."
              : "New Recruit imported a roster whose catalogue provenance could not be fully verified.",
          data: {
            enrichedPath: path.join(
              outputDirectory,
              bundledEnrichedPath,
            ),
            enrichedHash,
            bundledEnrichedPath,
            uiIdentity,
            rosterIdentity,
            catalogueProvenance,
            event,
          },
        };
      };
      if (resumedArtifact) {
        preparationOrigin = "manifest-reuse";
        delivered = {
          ok: true,
          data: {
            rosterId: roster.id,
            rosterName:
              resumedArtifact.rosterIdentity.observedRosterName,
            uiIdentity:
              previous?.provenance.newRecruitUi.identity ??
              null,
            listUrl: null,
            imported: true,
            sessionReused: true,
            cacheReused: true,
            verification: null,
            enrichedSummary: resumedArtifact.summary,
            connectorEvents: [],
            artifacts: [
              {
                format: "new-recruit-enriched-rosz",
                filename: path.basename(
                  resumedArtifact.bundleRelativePath,
                ),
                mimeType: "application/zip",
                written: resumedArtifact.absolutePath,
              },
            ],
          },
          violations: [],
          warnings: [],
        };
      } else if (cached) {
        preparationOrigin = "persistent-cache";
        delivered = cached;
      } else {
        requireCondition(
          previous === null,
          "CERTIFICATION_RESUME_PREPARATION_UNAVAILABLE",
          "The resumed run has no verified prior enriched artifact or hash-verified persistent cache. Live delivery was not retried.",
        );
        assertLiveCertificationPlanEntry(
          livePlan,
          factionId,
        );
        preparationOrigin = "new-remote";
        newRecruitMutationStarted = true;
        const mutation =
          await runCertificationNewRecruitMutation({
            roster,
            runId: report.runId,
            deliver: () =>
              deliverRosterToNewRecruit(roster, {
                downloadEnrichedRosz: true,
                downloadPrettyHtml: false,
                outputDirectory: factionDirectory,
                allowOutsideRoot: true,
                overwrite: false,
              }),
            finalize: (candidate) => {
              mutationCandidate = candidate;
              return finalizePreparation(
                candidate,
                "new-remote",
              );
            },
          });
        delivered = mutation.delivery;
        mutationTransactionState =
          mutation.transactionState;
        finalization = mutation.finalization;
      }
      if (preparationOrigin !== "new-remote") {
        const probe = await probeNewRecruitLiveUi();
        const probeUiIdentity = safeNewRecruitUiIdentity(
          probe.data?.uiIdentity,
        );
        const probeSucceeded =
          probe.ok &&
          probe.data?.importControlVisible === true &&
          probeUiIdentity !== null;
        probeEvent = {
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          recordedAt: timestamp(),
          provider: "new-recruit",
          action: "probe",
          origin: "new-remote",
          outcome: probeSucceeded ? "verified" : "failed",
          remoteId: null,
          contentSha256: probeUiIdentity,
        };
        currentLiveProbe = {
          attempted: true,
          ok: probeSucceeded,
          sessionReused:
            probe.data?.sessionReused ?? null,
          importControlVisible:
            probe.data?.importControlVisible ?? null,
          uiIdentity: probeUiIdentity,
          satisfiedBy: "authenticated-probe",
        };
        if (!probeSucceeded) {
          const issue =
            probe.violations[0] ?? probe.warnings[0];
          report.cases.push(
            finishCase(
              {
                caseId: `${factionId}:live-new-recruit`,
                factionId,
                workflow: "new-recruit-delivery",
                stage: "authenticated-reuse-probe",
                status: "fail",
                code:
                  issue?.code ??
                  "NEW_RECRUIT_LIVE_UI_PROBE_FAILED",
                message:
                  issue?.message ??
                  "The cached New Recruit artifact could not be paired with a current authenticated UI probe. No list was delivered.",
                retryable: true,
                evidence: {
                  preparationOrigin,
                  cacheReused: true,
                  currentAttemptRemoteMutations: 0,
                  currentLiveProbe,
                  preflightPlanSha256:
                    livePlan.planSha256,
                  partialPreparationRetained: false,
                },
                artifacts: [],
                connectorEvents: [probeEvent],
              },
              preparationStarted,
            ),
          );
          continue;
        }
        requireCondition(
          delivered.data,
          "CERTIFICATION_NEW_RECRUIT_DELIVERY_FAILED",
          "The reused New Recruit preparation has no delivery payload.",
        );
        delivered = {
          ...delivered,
          data: {
            ...delivered.data,
            uiIdentity: probeUiIdentity,
            connectorEvents: [
              ...(delivered.data.connectorEvents ?? []),
              probeEvent,
            ],
          },
        };
      } else {
        currentLiveProbe = {
          attempted: false,
          ok: delivered.ok,
          sessionReused:
            delivered.data?.sessionReused ?? null,
          importControlVisible: null,
          uiIdentity: safeNewRecruitUiIdentity(
            delivered.data?.uiIdentity,
          ),
          satisfiedBy: "fresh-new-remote-delivery",
        };
      }
      const deliveryUiIdentity =
        mergeCertificationNewRecruitUiIdentity(
          report,
          delivered.data?.uiIdentity,
        );
      if (!delivered.ok) {
        const uncertain =
          mutationTransactionState === "uncertain" ||
          (delivered.data?.connectorEvents?.some(
            (event) => event.outcome === "uncertain",
          ) ??
            false);
        report.cases.push(
          finishCase(
            {
              caseId: `${factionId}:live-new-recruit`,
              factionId,
              workflow: "new-recruit-delivery",
              stage: "verified-enrichment",
              status: "fail",
              code:
                delivered.violations[0]?.code ??
                "CERTIFICATION_NEW_RECRUIT_DELIVERY_FAILED",
              message:
                delivered.violations
                  .map((issue) => issue.message)
                  .join(" ") ||
                "New Recruit delivery did not complete.",
              retryable: !uncertain,
              evidence: {
                imported: delivered.data?.imported ?? false,
                uncertainExternalOutcome: uncertain,
                verification:
                  delivered.data?.verification ?? null,
                newRecruitUiIdentity:
                  deliveryUiIdentity,
                currentLiveProbe,
                preflightPlanSha256:
                  livePlan.planSha256,
              },
              artifacts: [],
              connectorEvents:
                delivered.data?.connectorEvents ?? [],
            },
            preparationStarted,
          ),
        );
        continue;
      }
      requireCondition(
        delivered.data,
        "CERTIFICATION_NEW_RECRUIT_DELIVERY_FAILED",
        "New Recruit reported success without a delivery payload.",
      );
      if (!finalization) {
        finalization = (
          await finalizePreparation(
            delivered,
            preparationOrigin,
          )
        ).data;
      }
      enrichedPath = finalization.enrichedPath;
      const {
        enrichedHash,
        bundledEnrichedPath,
        rosterIdentity,
        catalogueProvenance,
        event,
        uiIdentity,
      } = finalization;
      const preparationConnectorEvents = [
        ...(probeEvent ? [probeEvent] : []),
        event,
      ];
      mergeCertificationNewRecruitUiIdentity(
        report,
        uiIdentity,
      );
      if (catalogueProvenance.status !== "matched") {
        const code =
          catalogueProvenance.status === "drift"
            ? "NEW_RECRUIT_CATALOGUE_DRIFT"
            : "NEW_RECRUIT_CATALOGUE_PROVENANCE_UNVERIFIABLE";
        report.cases.push(
          finishCase(
            {
              caseId: `${factionId}:live-new-recruit`,
              factionId,
              workflow: "new-recruit-delivery",
              stage: "verified-enrichment",
              status: "fail",
              code,
              message:
                catalogueProvenance.status === "drift"
                  ? `The catalogue ID or revision observed in New Recruit's enriched ROSZ differs from frozen bundle ${roster.sourceData.bundleId} (source release ${roster.sourceData.releaseId}). Tessera was not started.`
                  : `New Recruit's enriched ROSZ omitted ${catalogueProvenance.missing.join(", ")}. Tessera was not started because the live catalogue identity could not be verified.`,
              retryable: false,
              evidence: {
                cacheReused:
                  preparationOrigin !== "new-remote",
                preparationOrigin,
                executionFingerprint:
                  rosterExecutionFingerprint(roster),
                currentAttemptRemoteMutations:
                  preparationOrigin === "new-remote" ? 1 : 0,
                imported: delivered.data.imported,
                verification: delivered.data.verification,
                newRecruitUiIdentity: uiIdentity,
                rosterIdentity: {
                  requestedRosterName:
                    rosterIdentity.requestedRosterName,
                  observedRosterName:
                    rosterIdentity.observedRosterName,
                  presentationNameMatched:
                    rosterIdentity.presentationNameMatched,
                  presentationAliasAccepted:
                    rosterIdentity.presentationAliasAccepted,
                },
                enrichedSummary: rosterIdentity.summary,
                catalogueProvenance,
                currentLiveProbe,
                preflightPlanSha256:
                  livePlan.planSha256,
              },
              artifacts: [
                {
                  kind: "enriched-rosz",
                  path: bundledEnrichedPath,
                  sha256: enrichedHash,
                },
              ],
              connectorEvents:
                preparationConnectorEvents,
            },
            preparationStarted,
          ),
        );
        continue;
      }
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-new-recruit`,
            factionId,
            workflow: "new-recruit-delivery",
            stage: "verified-enrichment",
            status: "pass",
            code: null,
            message: cached
              ? "Reused one hash-verified enriched roster from the persistent cache without a remote mutation."
              : preparationOrigin === "manifest-reuse"
                ? "Reused the prior report's hash-verified enriched roster without a remote mutation."
                : "Created and verified exactly one run-scoped New Recruit list.",
            retryable: false,
            evidence: {
              cacheReused:
                preparationOrigin !== "new-remote",
              preparationOrigin,
              executionFingerprint:
                rosterExecutionFingerprint(roster),
              currentAttemptRemoteMutations:
                preparationOrigin === "new-remote" ? 1 : 0,
              currentAttemptCacheReuses:
                preparationOrigin === "new-remote" ? 0 : 1,
              imported: delivered.data.imported,
              verification: delivered.data.verification,
              newRecruitUiIdentity: uiIdentity,
              rosterIdentity: {
                requestedRosterName:
                  rosterIdentity.requestedRosterName,
                observedRosterName:
                  rosterIdentity.observedRosterName,
                presentationNameMatched:
                  rosterIdentity.presentationNameMatched,
                presentationAliasAccepted:
                  rosterIdentity.presentationAliasAccepted,
              },
              enrichedSummary: rosterIdentity.summary,
              catalogueProvenance,
              currentLiveProbe,
              preflightPlanSha256:
                livePlan.planSha256,
            },
            artifacts: [
              {
                kind: "enriched-rosz",
                path: bundledEnrichedPath,
                sha256: enrichedHash,
              },
            ],
            connectorEvents:
              preparationConnectorEvents,
          },
          preparationStarted,
        ),
      );
    } catch (error) {
      const failedMutationCandidate =
        retainedMutationCandidate();
      const failureCode =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "CERTIFICATION_STAGE_FAILED";
      const partialArtifacts:
        CertificationCaseResult["artifacts"] = [];
      if (
        newRecruitMutationStarted &&
        failedMutationCandidate?.data
      ) {
        for (const artifact of failedMutationCandidate.data.artifacts) {
          if (
            artifact.format !==
              "new-recruit-enriched-rosz" ||
            !artifact.written
          ) {
            continue;
          }
          const resolved = path.resolve(artifact.written);
          const relative = path.relative(
            path.resolve(outputDirectory),
            resolved,
          );
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            continue;
          }
          try {
            partialArtifacts.push({
              kind: "enriched-rosz",
              path: relative,
              sha256: sha256(await readFile(resolved)),
            });
          } catch {
            // A missing or unreadable partial artifact is not advertised.
          }
        }
      }
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-new-recruit`,
            factionId,
            workflow: "new-recruit-delivery",
            stage: "verified-enrichment",
            status: "fail",
            code: failureCode,
            message:
              error instanceof Error
                ? error.message
                : "New Recruit preparation failed.",
            retryable: !newRecruitMutationStarted,
            evidence: {
              newRecruitMutationStarted,
              uncertainExternalOutcome:
                newRecruitMutationStarted,
              partialPreparationRetained:
                partialArtifacts.length > 0,
              preflightPlanSha256:
                livePlan.planSha256,
              newRecruitUiIdentity:
                safeNewRecruitUiIdentity(
                  failedMutationCandidate?.data?.uiIdentity,
                ),
            },
            artifacts: partialArtifacts,
            connectorEvents:
              failedMutationCandidate?.data?.connectorEvents ??
              [],
          },
          preparationStarted,
        ),
      );
      continue;
    }

    if (
      report.cases.some(
        (result) =>
          result.caseId === `${factionId}:live-tessera` &&
          result.status === "pass",
      )
    ) {
      continue;
    }
    if (faction.trustedTesseraSimulation === "unsupported") {
      const simulationStarted = startCase();
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-tessera`,
            factionId,
            workflow: "tessera-simulation",
            stage: "trusted-full-matrix",
            status: "unsupported",
            code:
              CERTIFICATION_CAPABILITY_BOUNDARY_CODES.trustedTesseraSimulation,
            message:
              "New Recruit preparation completed, but Tessera was not opened because trusted simulation is outside this faction's declared capability.",
            retryable: false,
            evidence: {
              capability: faction.trustedTesseraSimulation,
              preparationRetained: true,
              tesseraMutationStarted: false,
            },
            artifacts: [],
            connectorEvents: [],
          },
          simulationStarted,
        ),
      );
      continue;
    }

    const simulationStarted = startCase();
    const enriched = await readFile(enrichedPath!);
    const profilePolicyPreflight =
      preflightLiveCertificationProfilePolicy({
        enrichedRosz: enriched,
        roster,
        source: profilePolicySource,
      });
    const policyEvidence = {
      source: report.provenance.profilePolicy.source,
      requestedBasename:
        report.provenance.profilePolicy.requestedBasename,
      sourceArtifactPath:
        report.provenance.profilePolicy.artifactPath,
      sourceSha256:
        report.provenance.profilePolicy.sourceSha256,
      sourceCanonicalSha256:
        report.provenance.profilePolicy.canonicalSha256,
      appliedCanonicalSha256:
        profilePolicyPreflight.policyHash,
      requirements: profilePolicyPreflight.requirements,
      unresolved: profilePolicyPreflight.unresolved,
      errors: profilePolicyPreflight.errors,
      inventory: profilePolicyPreflight.inventory,
    };
    if (!profilePolicyPreflight.valid) {
      let scaffoldArtifact:
        | CertificationReport["artifacts"][number]
        | null = null;
      if (profilePolicyPreflight.scaffold) {
        try {
          const scaffoldContent = strToU8(
            `${JSON.stringify(profilePolicyPreflight.scaffold, null, 2)}\n`,
          );
          const scaffoldSha256 = sha256(scaffoldContent);
          const scaffoldPath = await writeCertificationArtifact(
            outputDirectory,
            `${factionId}-${scaffoldSha256.slice(0, 12)}-profile-policy-scaffold.json`,
            scaffoldContent,
          );
          scaffoldArtifact = {
            kind: "profile-policy-scaffold",
            path: scaffoldPath,
            sha256: scaffoldSha256,
          };
        } catch {
          // The safe structured requirements remain actionable when the
          // convenience scaffold cannot be written.
        }
      }
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-tessera`,
            factionId,
            workflow: "tessera-simulation",
            stage: "profile-policy-preflight",
            status: "fail",
            code:
              profilePolicyPreflight.code ??
              "TESSERA_PROFILE_POLICY_REQUIRED",
            message:
              profilePolicyPreflight.code ===
              "TESSERA_ENRICHED_PROFILE_INVENTORY_MISMATCH"
                ? "The verified New Recruit archive is missing required alternate-profile data from the pinned roster. Tessera was not started, and no profile choice was invented."
                : profilePolicyPreflight.code ===
              "TESSERA_PROFILE_POLICY_INVALID"
                ? "The supplied profile policy does not validly resolve every alternate weapon profile in the verified enriched roster. Tessera was not started."
                : "An explicit profile policy is required for every alternate weapon profile in the verified enriched roster. Complete the generated scaffold and rerun; Tessera was not started.",
            retryable: false,
            evidence: {
              profilePolicy: policyEvidence,
              tesseraMutationStarted: false,
            },
            artifacts: scaffoldArtifact ? [scaffoldArtifact] : [],
            connectorEvents: [],
          },
          simulationStarted,
        ),
      );
      continue;
    }
    let tesseraMutationStarted = false;
    try {
      assertLiveCertificationPlanEntry(
        livePlan,
        factionId,
      );
      const opponentName = `${roster.name} Mirror`;
      const opponent = deterministicRenamedMirrorRosz(
        enriched,
        opponentName,
      );
      const scopedPolicySha256 =
        scopedTesseraProfilePolicySha256(
          profilePolicyPreflight.policy,
        );
      const executionFingerprint =
        rosterExecutionFingerprint(roster);
      tesseraMutationStarted = true;
      const result = await runTesseraThroughLocalAgent({
        playerFilename: `${factionId}-certification.rosz`,
        playerRoszBase64: enriched.toString("base64"),
        playerName: roster.name,
        opponentFilename: `${factionId}-certification-mirror.rosz`,
        opponentRoszBase64: Buffer.from(opponent).toString("base64"),
        opponentName,
        analysisMode: "full",
        phases: ["shooting", "fight"],
        metrics: [
          "wipe-probability",
          "half-wipe-probability",
          "mean-kills",
          "mean-damage",
        ],
        profilePolicy: profilePolicyPreflight.policy,
        savedListReuse: {
          schemaVersion: 1,
          player: {
            runId: report.runId,
            enrichedRoszSha256: sha256(enriched),
            scopedProfilePolicySha256: scopedPolicySha256,
            profilePolicyEntryKeys:
              profilePolicyPreflight.policy?.entries
                .map((entry) => profilePolicyIdentityKey(entry))
                .sort((left, right) => left.localeCompare(right)) ??
              [],
            rosterExecutionFingerprint: executionFingerprint,
            expectedUnitCount: roster.units.length,
          },
          opponent: {
            runId: report.runId,
            enrichedRoszSha256: sha256(opponent),
            scopedProfilePolicySha256: scopedPolicySha256,
            profilePolicyEntryKeys:
              profilePolicyPreflight.policy?.entries
                .map((entry) => profilePolicyIdentityKey(entry))
                .sort((left, right) => left.localeCompare(right)) ??
              [],
            rosterExecutionFingerprint: executionFingerprint,
            expectedUnitCount: roster.units.length,
          },
        },
        sessionId: `${report.runId}-${factionId}`,
      });
      const captured =
        await captureLiveTesseraCertificationResult({
          factionId,
          playerName: roster.name,
          opponentName,
          expectedPlayerUnitCount: roster.units.length,
          expectedOpponentUnitCount: roster.units.length,
          result,
          profilePolicyEvidence: policyEvidence,
          writeArtifact: (filename, content) =>
            writeCertificationArtifact(
              outputDirectory,
              filename,
              content,
            ),
        });
      if (captured.uiIdentity) {
        report.provenance.tesseraUi.identity =
          report.provenance.tesseraUi.identity === null
            ? captured.uiIdentity
            : sha256(
                [
                  report.provenance.tesseraUi.identity,
                  captured.uiIdentity,
                ]
                  .sort()
                  .join("|"),
              );
      }
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-tessera`,
            factionId,
            workflow: "tessera-simulation",
            stage: "trusted-full-matrix",
            status: captured.status,
            code: captured.code,
            message: captured.message,
            retryable: captured.retryable,
            evidence: {
              ...captured.evidence,
              preflightPlanSha256:
                livePlan.planSha256,
              matchupKind: "renamed-mirror-canary",
              opponentPortfolioEvidence: false,
              corePortfolioCaseIds: report.cases
                .filter(
                  (candidate) =>
                    candidate.factionId === factionId &&
                    (candidate.caseId ===
                      `${factionId}:portfolio:core-3` ||
                      candidate.stage ===
                        "ordered-local-opponent-matrix"),
                )
                .map((candidate) => candidate.caseId)
                .sort(),
              interpretation:
                "This full 16-scenario matrix certifies Tessera controls, refresh, parsing, and serialization. The separate core-3 preparation case certifies opponent-posture breadth.",
            },
            artifacts: [captured.artifact],
            connectorEvents: captured.connectorEvents,
          },
          simulationStarted,
        ),
      );
    } catch (error) {
      const failureCode =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "CERTIFICATION_STAGE_FAILED";
      const retryable =
        /TIMEOUT|SESSION|NAVIGATION|STALE|MATRIX_MISSING|LIST_SELECTION/.test(
          failureCode,
        );
      report.cases.push(
        finishCase(
          {
            caseId: `${factionId}:live-tessera`,
            factionId,
            workflow: "tessera-simulation",
            stage: "trusted-full-matrix",
            status: "fail",
            code: failureCode,
            message:
              error instanceof Error
                ? error.message
                : "The trusted Tessera simulation failed.",
            retryable,
            evidence: {
              profilePolicy: policyEvidence,
              tesseraMutationStarted,
              preflightPlanSha256:
                livePlan.planSha256,
            },
            artifacts: [],
            connectorEvents: tesseraMutationStarted
              ? [
                  {
                    schemaVersion: 1,
                    eventId: crypto.randomUUID(),
                    recordedAt: timestamp(),
                    provider: "tessera",
                    action: "simulate",
                    origin: "new-remote",
                    outcome: "uncertain",
                    remoteId: null,
                    contentSha256: null,
                  },
                ]
              : [],
          },
          simulationStarted,
        ),
      );
    }
  }
}

async function atomicWrite(
  filename: string,
  content: string,
  overwrite: boolean,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  if (!overwrite) {
    try {
      await stat(filename);
      throw new Error(`Certification output already exists: ${filename}`);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, filename);
}

async function writeCertificationArtifact(
  outputDirectory: string,
  filename: string,
  content: Uint8Array,
): Promise<string> {
  const target = path.join(
    outputDirectory,
    "artifacts",
    "canonical",
    path.basename(filename),
  );
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const existing = await readFile(target);
    requireCondition(
      sha256(existing) === sha256(content),
      "CERTIFICATION_ARTIFACT_COLLISION",
      `Certification artifact "${path.basename(filename)}" already exists with different content.`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, content, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
  }
  const verified = await readFile(target);
  requireCondition(
    sha256(verified) === sha256(content),
    "CERTIFICATION_ARTIFACT_VERIFICATION_FAILED",
    `Certification artifact "${path.basename(filename)}" did not match its expected content hash after writing.`,
  );
  return path.relative(outputDirectory, target);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (flag(args, "help")) {
    process.stdout.write(certificationHelp());
    return;
  }
  const tier = (value(args, "tier") ?? "deterministic") as CertificationTier;
  requireCondition(
    ["deterministic", "connector", "live"].includes(tier),
    "CERTIFICATION_TIER_INVALID",
    `Unknown certification tier "${tier}".`,
  );
  const profilePolicyRequestedPath =
    resolveLiveProfilePolicyArgument(
      tier,
      args["profile-policy"],
    );
  const profilePolicySource = profilePolicyRequestedPath
    ? await loadLiveCertificationProfilePolicy(
        profilePolicyRequestedPath,
      )
    : null;
  const requiredStatus = value(args, "require-status");
  requireCondition(
    requiredStatus === undefined ||
      ["pass", "degraded"].includes(requiredStatus),
    "CERTIFICATION_REQUIRED_STATUS_INVALID",
    `Unknown required status "${requiredStatus}". Use pass or degraded.`,
  );
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const manifestPath = path.resolve(
    value(args, "manifest") ??
      path.join(projectRoot, "data", "certification-manifest.json"),
  );
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = CertificationManifestSchema.parse(
    JSON.parse(manifestText),
  );
  const requestedFaction = value(args, "faction") ?? null;
  const requestedShard =
    parseShard(value(args, "shard")) ?? null;
  const changedOnly = flag(args, "changed-only");
  const relevantChanges = changedOnly
    ? certificationRelevantChanges({ cwd: projectRoot })
    : [];
  const skipAll =
    changedOnly && relevantChanges.length === 0;
  const expectedSelection = expectedCertificationSelection(
    manifest,
    {
      requestedFaction,
      shard: requestedShard,
      changedOnly,
      skipAll,
    },
  );
  const resumePath = value(args, "resume");
  let previous: CertificationReport | null = null;
  let previousReportContent: Uint8Array | null = null;
  if (resumePath) {
    const verifiedResume =
      await loadVerifiedCertificationResumeReport({
        resumePath,
        expectedTier: tier,
        expectedManifestSha256:
          certificationManifestSha256(manifest),
        expectedSelection,
      });
    previousReportContent =
      verifiedResume.reportContent;
    previous = verifiedResume.report;
    migrateLegacyTesseraSavedListConnectorEvents(previous);
  }
  const completedFactionIds =
    completedDeterministicFactionIds(
      previous,
      manifest,
    );
  const completedLiveFactionIds = new Set<string>();
  const resumeBundleDirectory = resumePath
    ? path.dirname(path.resolve(resumePath))
    : null;
  const outputDirectory = path.resolve(
    value(args, "out-dir") ?? path.join(projectRoot, ".certification"),
  );
  const relocatedResumeArtifacts =
    previous && resumeBundleDirectory
      ? await relocateCertificationResumeArtifactClosure({
          previous,
          previousReportContent: previousReportContent!,
          resumeBundleDirectory,
          outputBundleDirectory: outputDirectory,
        })
      : [];
  if (
    previous &&
    resumeBundleDirectory &&
    certificationResumePolicyIsCompatible(
      previous,
      profilePolicySource?.policy ?? null,
    )
  ) {
    for (const factionId of previous.selection.selectedFactionIds) {
      try {
        const currentRoster = buildLiveRoster(
          manifest,
          factionId,
          previous.runId,
        );
        const priorBuild = previous.cases.find(
          (result) =>
            result.caseId ===
              `${factionId}:build:${currentRoster.pointsLimit}` &&
            result.status === "pass",
        );
        if (
          priorBuild?.evidence.executionFingerprint !==
          rosterExecutionFingerprint(currentRoster)
        ) {
          continue;
        }
        const liveCases = previous.cases.filter((result) =>
          [
            `${factionId}:live-new-recruit`,
            `${factionId}:live-tessera`,
          ].includes(result.caseId),
        );
        if (
          liveCases.length !== 2 ||
          !liveCases.every((result) => result.status === "pass")
        ) {
          continue;
        }
        await loadVerifiedCertificationResumeArtifact({
          previous,
          resumeBundleDirectory,
          factionId,
          roster: currentRoster,
        });
        if (
          !(await verifyBundleRelativeArtifacts(
            liveCases,
            resumeBundleDirectory,
          ))
        ) {
          continue;
        }
        completedLiveFactionIds.add(factionId);
      } catch {
        // Any missing, changed, or unverifiable evidence is rerun through
        // manifest/cache reuse instead of being treated as completed.
      }
    }
  }
  const progress = (message: string) =>
    process.stderr.write(`[certify] ${message}\n`);
  const resumeAttemptArtifact = previousReportContent
    ? await preserveCertificationResumeAttempt({
        content: previousReportContent,
        writeArtifact: (filename, content) =>
          writeCertificationArtifact(
            outputDirectory,
            filename,
            content,
          ),
      })
    : null;
  const report = await runDeterministicCertification(manifest, {
    factionId: requestedFaction ?? undefined,
    shard: requestedShard ?? undefined,
    changedOnly,
    skipAll,
    resumedCaseIds: new Set(
      [...completedFactionIds].map((id) => `${id}:completed`),
    ),
    artifactWriter: (filename, content) =>
      writeCertificationArtifact(
        outputDirectory,
        filename,
        content,
      ),
    progress,
  });
  let profilePolicyArtifact:
    | CertificationReport["artifacts"][number]
    | null = null;
  if (profilePolicySource) {
    const content = strToU8(
      `${JSON.stringify(profilePolicySource.policy, null, 2)}\n`,
    );
    const artifactSha256 = sha256(content);
    const artifactPath = await writeCertificationArtifact(
      outputDirectory,
      `live-profile-policy-${profilePolicySource.canonicalSha256.slice(0, 12)}.json`,
      content,
    );
    profilePolicyArtifact = {
      kind: "profile-policy",
      path: artifactPath,
      sha256: artifactSha256,
    };
    report.provenance.profilePolicy = {
      source: "cli",
      requestedBasename:
        profilePolicySource.requestedBasename,
      artifactPath,
      sourceSha256: profilePolicySource.sourceSha256,
      canonicalSha256:
        profilePolicySource.canonicalSha256,
    };
  }
  if (previous) {
    report.runId = previous.runId;
    report.resumedFrom = path.basename(path.resolve(resumePath!));
    report.provenance.newRecruitUi = {
      ...previous.provenance.newRecruitUi,
    };
    report.provenance.tesseraUi = {
      ...previous.provenance.tesseraUi,
    };
    const reusableDeterministicCaseIds = new Map(
      [...completedFactionIds].map((factionId) => [
        factionId,
        deterministicCaseIds(manifest, factionId),
      ]),
    );
    report.cases = [
      ...previous.cases.filter(
        (result) =>
          result.factionId !== null &&
          completedFactionIds.has(result.factionId) &&
          (reusableDeterministicCaseIds
            .get(result.factionId)
            ?.has(result.caseId) ||
            (completedLiveFactionIds.has(result.factionId) &&
              result.status === "pass" &&
              result.caseId ===
                `${result.factionId}:live-tessera`)),
      ),
      ...report.cases.filter(
        (result) => !result.caseId.endsWith(":resume"),
      ),
    ];
  }
  report.tier = tier;
  report.provenance.runtime = getRuntimeProvenance();
  try {
    const agent = await getLocalAgentStatus({ timeoutMs: 2_000 });
    report.provenance.localAgent = {
      version: agent.version,
      protocolVersion: agent.protocolVersion,
      runtime: agent.runtime ?? null,
      buildId: agent.runtime?.buildId ?? null,
      stale: agent.runtime?.stale ?? null,
    };
  } catch {
    // Deterministic and recorded-connector certification do not require a
    // running local agent. The absent identity remains explicit in the report.
  }
  if (skipAll) {
    const now = timestamp();
    report.cases.push({
      caseId: "changed-only:no-relevant-changes",
      factionId: null,
      workflow: "oracle",
      stage: "changed-only-selection",
      status: "skipped",
      code: "CERTIFICATION_NO_RELEVANT_CHANGES",
      message:
        "No changed file intersects a roster, data, connector, transport, test, or workflow surface.",
      retryable: false,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      evidence: { changedFiles: relevantChanges },
      artifacts: [],
      connectorEvents: [],
    });
  }
  if (tier === "connector") {
    await addBrowserFixtureCertification(
      report,
      manifest,
      projectRoot,
      outputDirectory,
      progress,
    );
  }
  const opponentMatrix = flag(args, "opponent-matrix");
  const portfolio =
    flag(args, "portfolio") ||
    (tier === "live" && !opponentMatrix);
  if (portfolio && !opponentMatrix) {
    progress(
      "Certifying selected faction core-3 and 1,000/2,000-point diverse-9 portfolios.",
    );
    await addFactionPortfolioCertification(
      report,
      manifest,
      progress,
    );
  }
  if (opponentMatrix) {
    progress("Certifying the ordered local player/opponent faction matrix.");
    await addOpponentMatrixCertification(report, manifest, progress);
  }
  if (tier === "live") {
    const blockingPreflights = report.cases.filter(
      (result) => result.status === "fail",
    );
    if (blockingPreflights.length > 0) {
      const started = startCase();
      report.cases.push(
        finishCase(
          {
            caseId: "live:preflight-gate",
            factionId: null,
            workflow: "new-recruit-delivery",
            stage: "live-preflight",
            status: "skipped",
            code: "CERTIFICATION_LIVE_PREFLIGHT_FAILED",
            message:
              "Live connector activity was skipped because a deterministic or recorded-connector preflight failed.",
            retryable: false,
            evidence: {
              blockingCases: blockingPreflights.map((result) => ({
                caseId: result.caseId,
                code: result.code,
              })),
            },
            artifacts: [],
            connectorEvents: [],
          },
          started,
        ),
      );
      progress(
        `Skipped live connector activity after ${blockingPreflights.length} blocking preflight failure${blockingPreflights.length === 1 ? "" : "s"}.`,
      );
    } else {
      await addLiveCertification(
        report,
        manifest,
        outputDirectory,
        profilePolicySource,
        previous,
        resumeBundleDirectory,
      );
      if (previous) {
        mergeResumedLiveConnectorHistory(report, previous, {
          carriedCaseIds: new Set(
            [...completedLiveFactionIds].map(
              (factionId) =>
                `${factionId}:live-tessera`,
            ),
          ),
        });
      }
    }
  }
  recomputeCoverage(report, manifest);
  const statusRank = {
    fail: 0,
    degraded: 1,
    pass: 2,
  } as const;
  const statusGatePassed =
    requiredStatus === undefined ||
    statusRank[report.status] >=
      statusRank[requiredStatus as "pass" | "degraded"];

  const manifestHash = certificationManifestSha256(manifest);
  const frozenManifestName = `certification-manifest-${manifestHash.slice(0, 12)}.json`;
  const frozenManifestPath = path.join(
    outputDirectory,
    frozenManifestName,
  );
  try {
    const existing = await readFile(frozenManifestPath, "utf8");
    requireCondition(
      sha256(existing) === sha256(`${JSON.stringify(manifest, null, 2)}\n`),
      "CERTIFICATION_MANIFEST_ARTIFACT_MISMATCH",
      "The output directory contains a different frozen manifest with the same name.",
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    await atomicWrite(
      frozenManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      false,
    );
  }
  const reportName = `certification-report-${report.runId}.json`;
  const reportPath = path.join(outputDirectory, reportName);
  const checksumName = `${reportName}.sha256`;
  const checksumPath = path.join(outputDirectory, checksumName);
  report.artifacts = deduplicateCertificationArtifacts([
    {
      kind: "manifest",
      path: frozenManifestName,
      sha256: await fileSha256(frozenManifestPath),
    },
    ...relocatedResumeArtifacts,
    ...(resumeAttemptArtifact ? [resumeAttemptArtifact] : []),
    ...(profilePolicyArtifact ? [profilePolicyArtifact] : []),
    ...report.cases.flatMap((result) => result.artifacts),
    {
      kind: "report",
      path: reportName,
      sha256: null,
    },
    {
      kind: "report-checksum",
      path: checksumName,
      sha256: null,
    },
  ]);
  CertificationReportSchema.parse(report);
  const reportContent = `${JSON.stringify(report, null, 2)}\n`;
  await atomicWrite(
    reportPath,
    reportContent,
    Boolean(previous) || flag(args, "overwrite"),
  );
  await atomicWrite(
    checksumPath,
    `${sha256(reportContent)}  ${reportName}\n`,
    Boolean(previous) || flag(args, "overwrite"),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: report.ok,
        status: report.status,
        requiredStatus: requiredStatus ?? null,
        statusGatePassed,
        tier: report.tier,
        runId: report.runId,
        reportPath,
        factions: report.coverage.factions,
        browserFixtures: report.coverage.browserFixtures,
        failures: report.cases
          .filter((result) => result.status === "fail")
          .map((result) => ({
            caseId: result.caseId,
            factionId: result.factionId,
            code: result.code,
            message: result.message,
          })),
      },
      null,
      2,
    )}\n`,
  );
  if (!report.ok || !statusGatePassed) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(
    `[certify] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
