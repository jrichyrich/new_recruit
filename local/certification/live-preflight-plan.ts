import crypto from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  buildRoster,
  getNewRecruitCapability,
  prepareNewRecruitHandoff,
  rosterExecutionFingerprint,
  validateRoster,
  type NewRecruitConnectionStatus,
  type ResultEnvelope,
  type RosterDraftV1,
  type TesseraConnectionStatus,
} from "../../lib/rosterpilot";
import type {
  CertificationManifest,
} from "../../lib/rosterpilot/certification";
import {
  preflightPinnedLiveCertificationProfilePolicy,
  type LiveCertificationProfilePolicySource,
  type PinnedLiveCertificationProfilePolicyPreflight,
} from "./live-profile-policy";
import {
  getNewRecruitConnectionStatus,
} from "../new-recruit/companion";
import { getRuntimeProvenance } from "../runtime-provenance";
import { getTesseraConnectionStatus } from "../tessera/companion";

export type LiveCertificationPreflightStage =
  | "faction"
  | "roster"
  | "warlord"
  | "points"
  | "mapping"
  | "canonical-export"
  | "profile-policy"
  | "output-path"
  | "runtime"
  | "new-recruit-readiness"
  | "tessera-readiness";

export type LiveCertificationPreflightFailure = Readonly<{
  factionId: string | null;
  stage: LiveCertificationPreflightStage;
  code: string;
  message: string;
  retryable: boolean;
}>;

export type LiveCertificationPreflightEntry = Readonly<{
  factionId: string;
  roster: Readonly<RosterDraftV1>;
  factionDirectory: string;
  executionFingerprint: string;
  canonicalRoszSha256: string;
  profilePolicySha256: string | null;
}>;

export type LiveCertificationPreflightPlan = Readonly<{
  schemaVersion: 1;
  planKind: "rosterpilot-live-certification-preflight";
  runId: string;
  outputDirectory: string;
  selectedFactionIds: readonly string[];
  entries: readonly LiveCertificationPreflightEntry[];
  skippedFactionIds: readonly string[];
  requiresNewRecruit: boolean;
  requiresTessera: boolean;
  runtimeBuildId: string;
  newRecruitRuntimeBuildId: string | null;
  tesseraRuntimeBuildId: string | null;
  planSha256: string;
}>;

export type LiveCertificationPreflightResult = Readonly<{
  ok: boolean;
  plan: LiveCertificationPreflightPlan | null;
  failures: readonly LiveCertificationPreflightFailure[];
}>;

export type LiveCertificationPreflightDependencies = {
  build: typeof buildRoster;
  validate: typeof validateRoster;
  capability: typeof getNewRecruitCapability;
  prepareHandoff: typeof prepareNewRecruitHandoff;
  profilePolicyPreflight:
    typeof preflightPinnedLiveCertificationProfilePolicy;
  runtime: typeof getRuntimeProvenance;
  newRecruitStatus: typeof getNewRecruitConnectionStatus;
  tesseraStatus: typeof getTesseraConnectionStatus;
  prepareOutputDirectory: (directory: string) => Promise<void>;
};

const defaultDependencies: LiveCertificationPreflightDependencies = {
  build: buildRoster,
  validate: validateRoster,
  capability: getNewRecruitCapability,
  prepareHandoff: prepareNewRecruitHandoff,
  profilePolicyPreflight:
    preflightPinnedLiveCertificationProfilePolicy,
  runtime: getRuntimeProvenance,
  newRecruitStatus: getNewRecruitConnectionStatus,
  tesseraStatus: getTesseraConnectionStatus,
  prepareOutputDirectory: async (directory) => {
    await mkdir(directory, { recursive: true });
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) {
      throw codedError(
        "CERTIFICATION_OUTPUT_PATH_INVALID",
        `The live certification output path "${directory}" is not a directory.`,
      );
    }
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

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (
    value &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(
      value as Record<string, unknown>,
    )) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function outputPath(
  outputDirectory: string,
  runId: string,
  factionId: string,
): string {
  const root = path.resolve(outputDirectory);
  const target = path.resolve(
    root,
    "live",
    runId,
    factionId,
  );
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw codedError(
      "CERTIFICATION_OUTPUT_PATH_OUTSIDE_BUNDLE",
      `The live output path for ${factionId} escapes the certification bundle.`,
    );
  }
  return target;
}

function statusFailure(
  connector: "New Recruit" | "Tessera",
  stage:
    | "new-recruit-readiness"
    | "tessera-readiness",
  status:
    | ResultEnvelope<NewRecruitConnectionStatus>
    | ResultEnvelope<TesseraConnectionStatus>,
): LiveCertificationPreflightFailure {
  const issue = status.violations[0] ?? status.warnings[0];
  return Object.freeze({
    factionId: null,
    stage,
    code:
      issue?.code ??
      (connector === "New Recruit"
        ? "NEW_RECRUIT_COMPANION_UNAVAILABLE"
        : "TESSERA_COMPANION_UNAVAILABLE"),
    message:
      issue?.message ??
      `${connector} is not ready for live certification.`,
    retryable: true,
  });
}

function policyFailure(
  factionId: string,
  result: PinnedLiveCertificationProfilePolicyPreflight,
): LiveCertificationPreflightFailure {
  return Object.freeze({
    factionId,
    stage: "profile-policy" as const,
    code: result.code ?? "TESSERA_PROFILE_POLICY_REQUIRED",
    message:
      result.code === "TESSERA_PROFILE_POLICY_INVALID"
        ? `The profile policy does not validly resolve every alternate weapon profile already known for ${factionId}.`
        : `An explicit profile policy is required for every alternate weapon profile already known for ${factionId}.`,
    retryable: false,
  });
}

function planHash(
  input: Omit<LiveCertificationPreflightPlan, "planSha256">,
): string {
  return sha256(
    JSON.stringify({
      ...input,
      entries: input.entries.map((entry) => ({
        factionId: entry.factionId,
        factionDirectory: entry.factionDirectory,
        executionFingerprint: entry.executionFingerprint,
        canonicalRoszSha256: entry.canonicalRoszSha256,
        profilePolicySha256: entry.profilePolicySha256,
      })),
    }),
  );
}

/**
 * Builds and freezes the complete live execution plan before either browser
 * connector may mutate external state. All selected factions are checked
 * before connector readiness is accepted, so a later faction cannot fail a
 * known profile-policy or export gate after an earlier list was delivered.
 */
export async function createLiveCertificationPreflightPlan(input: {
  manifest: CertificationManifest;
  selectedFactionIds: readonly string[];
  runId: string;
  outputDirectory: string;
  profilePolicySource: LiveCertificationProfilePolicySource | null;
  dependencies?: Partial<LiveCertificationPreflightDependencies>;
}): Promise<LiveCertificationPreflightResult> {
  const dependencies = {
    ...defaultDependencies,
    ...input.dependencies,
  };
  const failures: LiveCertificationPreflightFailure[] = [];
  const entries: LiveCertificationPreflightEntry[] = [];
  const skippedFactionIds: string[] = [];
  const plannedOutputPaths = new Set<string>();

  for (const factionId of input.selectedFactionIds) {
    const faction = input.manifest.factions.find(
      (candidate) => candidate.id === factionId,
    );
    if (!faction) {
      failures.push(
        Object.freeze({
          factionId,
          stage: "faction",
          code: "CERTIFICATION_FACTION_NOT_FOUND",
          message: `No certification manifest entry exists for ${factionId}.`,
          retryable: false,
        }),
      );
      continue;
    }
    if (
      faction.rosterCorrectness === "unsupported" ||
      faction.newRecruitExport === "unsupported" ||
      faction.newRecruitDelivery === "unsupported"
    ) {
      skippedFactionIds.push(factionId);
      continue;
    }

    const built = dependencies.build({
      playerFaction: faction.id,
      pointsLimit: input.manifest.defaults.pointBands[0],
      name: `RP Certification ${faction.name} ${input.runId.slice(0, 8)}`,
      preferences: input.manifest.defaults.preferences,
      allowNamedCharacters:
        input.manifest.defaults.allowNamedCharacters,
      allowLegends: false,
    });
    if (!built.ok || !built.data) {
      const issue = built.violations[0];
      failures.push(
        Object.freeze({
          factionId,
          stage: "roster",
          code: issue?.code ?? "CERTIFICATION_LIVE_BUILD_FAILED",
          message:
            issue?.message ??
            `No legal live roster was built for ${faction.name}.`,
          retryable: false,
        }),
      );
      continue;
    }
    const roster = structuredClone(built.data);
    const validation = dependencies.validate(roster);
    if (
      !validation.ok ||
      validation.data?.legal !== true ||
      validation.violations.length > 0
    ) {
      const issue = validation.violations[0];
      failures.push(
        Object.freeze({
          factionId,
          stage: "roster",
          code:
            issue?.code ??
            "CERTIFICATION_LIVE_ROSTER_INVALID",
          message:
            issue?.message ??
            `${faction.name}'s live roster did not pass legality validation.`,
          retryable: false,
        }),
      );
      continue;
    }
    const warlords = roster.units.filter(
      (selection) => selection.isWarlord,
    );
    const warlordMappingWarning = validation.warnings.find(
      (issue) =>
        issue.code ===
        "NEW_RECRUIT_WARLORD_MAPPING_UNAVAILABLE",
    );
    if (warlords.length !== 1 || warlordMappingWarning) {
      failures.push(
        Object.freeze({
          factionId,
          stage: "warlord",
          code:
            warlordMappingWarning?.code ??
            "CERTIFICATION_LIVE_WARLORD_INVALID",
          message:
            warlordMappingWarning?.message ??
            `${faction.name}'s live roster must contain exactly one exportable Warlord.`,
          retryable: false,
        }),
      );
      continue;
    }
    if (
      roster.totalPoints <= 0 ||
      roster.totalPoints > roster.pointsLimit ||
      validation.data.totalPoints !== roster.totalPoints ||
      roster.pointsLimit !== input.manifest.defaults.pointBands[0]
    ) {
      failures.push(
        Object.freeze({
          factionId,
          stage: "points",
          code: "CERTIFICATION_LIVE_POINTS_INVALID",
          message: `${faction.name}'s live roster points or point limit did not match its validated total.`,
          retryable: false,
        }),
      );
      continue;
    }
    const capability = dependencies.capability(factionId);
    if (!capability.available) {
      failures.push(
        Object.freeze({
          factionId,
          stage: "mapping",
          code: "NEW_RECRUIT_MAPPING_UNAVAILABLE",
          message:
            capability.reason ??
            `${faction.name} has no New Recruit mapping.`,
          retryable: false,
        }),
      );
      continue;
    }
    const handoff = await dependencies.prepareHandoff(
      roster,
      false,
    );
    const canonicalRosz = handoff.data?.artifacts.find(
      (artifact) => artifact.format === "rosz",
    );
    if (!handoff.ok || !canonicalRosz) {
      const issue = handoff.violations[0];
      failures.push(
        Object.freeze({
          factionId,
          stage: "canonical-export",
          code:
            issue?.code ??
            "CERTIFICATION_CANONICAL_ROSZ_FAILED",
          message:
            issue?.message ??
            `${faction.name}'s canonical ROSZ export failed.`,
          retryable: false,
        }),
      );
      continue;
    }
    const pinnedPolicy =
      faction.trustedTesseraSimulation === "required"
        ? dependencies.profilePolicyPreflight({
            roster,
            source: input.profilePolicySource,
          })
        : null;
    if (pinnedPolicy && !pinnedPolicy.valid) {
      failures.push(policyFailure(factionId, pinnedPolicy));
      continue;
    }
    let factionDirectory: string;
    try {
      factionDirectory = outputPath(
        input.outputDirectory,
        input.runId,
        factionId,
      );
      if (plannedOutputPaths.has(factionDirectory)) {
        throw codedError(
          "CERTIFICATION_OUTPUT_PATH_COLLISION",
          `More than one selected faction resolves to "${factionDirectory}".`,
        );
      }
      plannedOutputPaths.add(factionDirectory);
    } catch (error) {
      failures.push(
        Object.freeze({
          factionId,
          stage: "output-path",
          code: errorCode(
            error,
            "CERTIFICATION_OUTPUT_PATH_INVALID",
          ),
          message: errorMessage(
            error,
            `The live output path for ${faction.name} is invalid.`,
          ),
          retryable: false,
        }),
      );
      continue;
    }
    entries.push(
      Object.freeze({
        factionId,
        roster: deepFreeze(roster),
        factionDirectory,
        executionFingerprint:
          rosterExecutionFingerprint(roster),
        canonicalRoszSha256: sha256(
          canonicalRosz.content,
        ),
        profilePolicySha256:
          pinnedPolicy?.policyHash ?? null,
      }),
    );
  }

  const runtime = dependencies.runtime();
  if (runtime.stale) {
    failures.push(
      Object.freeze({
        factionId: null,
        stage: "runtime",
        code: "RUNTIME_RESTART_REQUIRED",
        message:
          "RosterPilot source files changed after this process started. Restart before live certification.",
        retryable: true,
      }),
    );
  }

  const requiresNewRecruit = entries.length > 0;
  const requiresTessera = entries.some((entry) => {
    const faction = input.manifest.factions.find(
      (candidate) => candidate.id === entry.factionId,
    );
    return faction?.trustedTesseraSimulation === "required";
  });
  const [newRecruitStatus, tesseraStatus] = await Promise.all([
    requiresNewRecruit
      ? dependencies.newRecruitStatus()
      : Promise.resolve(null),
    requiresTessera
      ? dependencies.tesseraStatus()
      : Promise.resolve(null),
  ]);
  if (
    newRecruitStatus &&
    newRecruitStatus.data?.available !== true
  ) {
    failures.push(
      statusFailure(
        "New Recruit",
        "new-recruit-readiness",
        newRecruitStatus,
      ),
    );
  }
  if (
    tesseraStatus &&
    tesseraStatus.data?.available !== true
  ) {
    failures.push(
      statusFailure(
        "Tessera",
        "tessera-readiness",
        tesseraStatus,
      ),
    );
  }
  if (failures.length > 0) {
    return Object.freeze({
      ok: false,
      plan: null,
      failures: Object.freeze([...failures]),
    });
  }

  for (const entry of entries) {
    try {
      await dependencies.prepareOutputDirectory(
        entry.factionDirectory,
      );
    } catch (error) {
      failures.push(
        Object.freeze({
          factionId: entry.factionId,
          stage: "output-path",
          code: errorCode(
            error,
            "CERTIFICATION_OUTPUT_PATH_INVALID",
          ),
          message: errorMessage(
            error,
            `The live output directory for ${entry.factionId} could not be prepared.`,
          ),
          retryable: false,
        }),
      );
    }
  }
  if (failures.length > 0) {
    return Object.freeze({
      ok: false,
      plan: null,
      failures: Object.freeze([...failures]),
    });
  }

  const planWithoutHash = {
    schemaVersion: 1 as const,
    planKind:
      "rosterpilot-live-certification-preflight" as const,
    runId: input.runId,
    outputDirectory: path.resolve(input.outputDirectory),
    selectedFactionIds: Object.freeze([
      ...input.selectedFactionIds,
    ]),
    entries: Object.freeze([...entries]),
    skippedFactionIds: Object.freeze([
      ...skippedFactionIds,
    ]),
    requiresNewRecruit,
    requiresTessera,
    runtimeBuildId: runtime.buildId,
    newRecruitRuntimeBuildId:
      newRecruitStatus?.data?.agentRuntimeBuildId ?? null,
    tesseraRuntimeBuildId:
      tesseraStatus?.data?.agentRuntimeBuildId ?? null,
  };
  const plan = Object.freeze({
    ...planWithoutHash,
    planSha256: planHash(planWithoutHash),
  });
  return Object.freeze({
    ok: true,
    plan,
    failures: Object.freeze([]),
  });
}

export function assertLiveCertificationPlanEntry(
  plan: LiveCertificationPreflightPlan,
  factionId: string,
): LiveCertificationPreflightEntry {
  const entry = plan.entries.find(
    (candidate) => candidate.factionId === factionId,
  );
  if (!entry) {
    throw codedError(
      "CERTIFICATION_LIVE_PREFLIGHT_ENTRY_MISSING",
      `The immutable live preflight plan has no entry for ${factionId}.`,
    );
  }
  if (
    rosterExecutionFingerprint(
      entry.roster as RosterDraftV1,
    ) !== entry.executionFingerprint
  ) {
    throw codedError(
      "CERTIFICATION_LIVE_PREFLIGHT_CHANGED",
      `The planned ${factionId} roster changed after preflight. No external mutation is allowed.`,
    );
  }
  return entry;
}

export async function runLiveCertificationPreflightGate<T>(
  input: Parameters<
    typeof createLiveCertificationPreflightPlan
  >[0],
  execute: (
    plan: LiveCertificationPreflightPlan,
  ) => Promise<T>,
): Promise<
  Readonly<{
    preflight: LiveCertificationPreflightResult;
    execution: T | null;
  }>
> {
  const preflight =
    await createLiveCertificationPreflightPlan(input);
  if (!preflight.ok || !preflight.plan) {
    return Object.freeze({
      preflight,
      execution: null,
    });
  }
  return Object.freeze({
    preflight,
    execution: await execute(preflight.plan),
  });
}
