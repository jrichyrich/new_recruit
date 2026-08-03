import crypto from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  exportRoster,
  rosterExecutionFingerprint,
  rosterStructuralFingerprint,
  validateRoster,
  type NewRecruitDelivery,
  type ProfilePolicyV1,
  type ResultEnvelope,
  type RosterDraftV1,
  type TesseraProfileRequirement,
} from "../../lib/rosterpilot";
import {
  inspectNewRecruitMutationReceipt,
  loadNewRecruitCache,
  loadNewRecruitMutationRecoveryArtifact,
  loadNewRecruitProvisionalArtifact,
  newRecruitCacheKey,
} from "../new-recruit/cache";
import {
  aggregateProfileRequirements,
  profilePolicyHash,
  profilePolicyIdentityKey,
  validateProfilePolicy,
} from "./profile-policy";
import {
  inspectRoszGameplaySnapshot,
  roszGameplaySnapshotSha256,
} from "./rosz-integrity";

const sha256Pattern = /^[0-9a-f]{64}$/;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function sha256(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(JSON.stringify(canonicalValue(value)));
}

export type TesseraBatchPreflightRosterV1 = {
  role: "player" | "opponent";
  templateId: string | null;
  rosterId: string;
  rosterName: string;
  factionId: string;
  totalPoints: number;
  pointsLimit: number;
  executionFingerprint: string;
  structuralFingerprint: string;
  sourceDataSha256: string;
  sourceRoszSha256: string | null;
  roszGameplaySha256: string | null;
  gameSystem: {
    id: string | null;
    revision: number | null;
  } | null;
  catalogues: Array<{
    id: string | null;
    revision: number | null;
  }>;
  checks: {
    legal: boolean;
    pointsMatch: boolean;
    exactMapping: boolean;
    roszRoundTripReadable: boolean;
    modelCountsResolved: boolean;
    loadoutParentsResolved: boolean;
    leaderAllocationsResolved: boolean;
    catalogueIdentityPresent: boolean;
  };
  violationCodes: string[];
  warningCodes: string[];
  profileRequirementKeys: string[];
  cache: {
    cacheKey: string;
    verifiedHit: boolean;
    receiptFound: boolean;
    latestOutcome: string | null;
    safeToRetry: boolean;
    requiredAction: string;
  };
};

export type TesseraBatchPreflightManifestV1 = {
  schemaVersion: 1;
  manifestKind: "tessera-batch-preflight";
  workflowId: string;
  createdAt: string;
  status: "passed" | "needs-input" | "failed";
  requireNewRecruit: boolean;
  rosterCount: number;
  rosters: TesseraBatchPreflightRosterV1[];
  profilePolicy: {
    sha256: string | null;
    valid: boolean;
    requirementCount: number;
    unresolvedRequirementKeys: string[];
    errors: string[];
  };
  inventory: {
    verifiedCacheHits: number;
    deliveryMisses: number;
    mutationReceipts: number;
    uncertainMutationReceipts: number;
  };
  failureCodes: string[];
  manifestSha256: string;
};

export type TesseraBatchPreflightRosterInput = {
  role: "player" | "opponent";
  templateId?: string | null;
  roster: RosterDraftV1;
};

export type TesseraBatchPreflightResult = {
  manifest: TesseraBatchPreflightManifestV1;
  manifestPath: string;
  cacheHits: Map<string, ResultEnvelope<NewRecruitDelivery>>;
};

type InspectedRoster = {
  record: Omit<TesseraBatchPreflightRosterV1, "cache">;
  cacheKey: string;
};

function roszBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? Buffer.from(content, "utf8")
    : content;
}

async function inspectRoster(
  input: TesseraBatchPreflightRosterInput,
  requirements: TesseraProfileRequirement[],
  requireNewRecruit: boolean,
): Promise<InspectedRoster> {
  const validation = validateRoster(input.roster);
  const exported = requireNewRecruit
    ? await exportRoster(input.roster, "rosz")
    : null;
  const violationCodes = [
    ...validation.violations.map((entry) => entry.code),
    ...(exported?.violations.map((entry) => entry.code) ?? []),
  ];
  const warningCodes = [
    ...validation.warnings.map((entry) => entry.code),
    ...(exported?.warnings.map((entry) => entry.code) ?? []),
  ];
  let sourceRoszSha256: string | null = null;
  let roszGameplaySha256: string | null = null;
  let gameSystem: TesseraBatchPreflightRosterV1["gameSystem"] = null;
  let catalogues: TesseraBatchPreflightRosterV1["catalogues"] = [];
  let roszRoundTripReadable = !requireNewRecruit;
  if (exported?.ok && exported.data) {
    try {
      const bytes = roszBytes(exported.data.content);
      const snapshot = inspectRoszGameplaySnapshot(bytes);
      sourceRoszSha256 = sha256(bytes);
      roszGameplaySha256 = roszGameplaySnapshotSha256(snapshot);
      gameSystem = snapshot.gameSystem;
      catalogues = snapshot.catalogues;
      roszRoundTripReadable = true;
    } catch {
      violationCodes.push("TESSERA_PREFLIGHT_ROSZ_ROUND_TRIP_FAILED");
    }
  }
  const exactMapping =
    !requireNewRecruit || Boolean(exported?.ok && exported.data);
  const catalogueIdentityPresent =
    !requireNewRecruit ||
    Boolean(
      gameSystem?.id &&
      Number.isInteger(gameSystem.revision) &&
      catalogues.length > 0 &&
      catalogues.every(
        (catalogue) =>
          Boolean(catalogue.id) &&
          Number.isInteger(catalogue.revision),
      ),
    );
  if (!catalogueIdentityPresent) {
    violationCodes.push("TESSERA_PREFLIGHT_CATALOGUE_IDENTITY_MISSING");
  }
  const pointsMatch = input.roster.totalPoints <= input.roster.pointsLimit;
  const resolvedByCanonicalExporter = exactMapping && roszRoundTripReadable;
  return {
    cacheKey: newRecruitCacheKey(input.roster),
    record: {
      role: input.role,
      templateId: input.templateId ?? null,
      rosterId: input.roster.id,
      rosterName: input.roster.name,
      factionId: input.roster.factionId,
      totalPoints: input.roster.totalPoints,
      pointsLimit: input.roster.pointsLimit,
      executionFingerprint: rosterExecutionFingerprint(input.roster),
      structuralFingerprint: rosterStructuralFingerprint(input.roster),
      sourceDataSha256: canonicalSha256(input.roster.sourceData),
      sourceRoszSha256,
      roszGameplaySha256,
      gameSystem,
      catalogues,
      checks: {
        legal: validation.ok,
        pointsMatch,
        exactMapping,
        roszRoundTripReadable,
        modelCountsResolved: resolvedByCanonicalExporter,
        loadoutParentsResolved: resolvedByCanonicalExporter,
        leaderAllocationsResolved: resolvedByCanonicalExporter,
        catalogueIdentityPresent,
      },
      violationCodes: [...new Set(violationCodes)].sort(),
      warningCodes: [...new Set(warningCodes)].sort(),
      profileRequirementKeys: requirements
        .filter(
          (requirement) =>
            requirement.faction === input.roster.factionName ||
            requirement.faction === input.roster.factionId,
        )
        .map(profilePolicyIdentityKey)
        .sort(),
    },
  };
}

async function writeAtomic(
  filename: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sealManifest(
  manifest: Omit<TesseraBatchPreflightManifestV1, "manifestSha256">,
): TesseraBatchPreflightManifestV1 {
  return {
    ...manifest,
    manifestSha256: canonicalSha256(manifest),
  };
}

export async function verifyTesseraBatchPreflightManifest(
  filename: string,
): Promise<TesseraBatchPreflightManifestV1> {
  const value = JSON.parse(
    await readFile(path.resolve(filename), "utf8"),
  ) as TesseraBatchPreflightManifestV1;
  const { manifestSha256, ...unsigned } = value;
  if (
    value.schemaVersion !== 1 ||
    value.manifestKind !== "tessera-batch-preflight" ||
    !sha256Pattern.test(manifestSha256) ||
    canonicalSha256(unsigned) !== manifestSha256
  ) {
    throw Object.assign(
      new Error("The Tessera batch preflight manifest failed verification."),
      { code: "TESSERA_PREFLIGHT_MANIFEST_INVALID" },
    );
  }
  return value;
}

/**
 * Performs every read-only roster, ROSZ, profile-policy, cache, and mutation
 * receipt check before the first external New Recruit mutation is allowed.
 */
export async function runTesseraBatchPreflight(input: {
  workflowId: string;
  rosters: TesseraBatchPreflightRosterInput[];
  profilePolicy: ProfilePolicyV1 | null;
  requireNewRecruit: boolean;
  /**
   * Production delivery paths inspect the durable cache and mutation ledger.
   * Injected, non-persistent adapters have no authoritative local ledger and
   * must remain isolated from unrelated machine-local evidence.
   */
  inspectPersistentDeliveryEvidence?: boolean;
  outputDirectory: string;
  filename?: string;
}): Promise<TesseraBatchPreflightResult> {
  if (input.rosters.length === 0) {
    throw new Error("Tessera batch preflight requires at least one roster.");
  }
  const requirements = aggregateProfileRequirements(
    input.rosters.map((entry) => entry.roster),
  );
  const policy = validateProfilePolicy(requirements, input.profilePolicy);
  const inspected = await Promise.all(
    input.rosters.map((entry) =>
      inspectRoster(
        entry,
        requirements,
        input.requireNewRecruit,
      ),
    ),
  );

  // Both operations are read-only and intentionally execute concurrently.
  const inspectPersistentDeliveryEvidence =
    input.requireNewRecruit &&
    input.inspectPersistentDeliveryEvidence !== false;
  const inventories = await Promise.all(
    input.rosters.map(async (entry) => {
      const [deliveryEvidence, receipt] = await Promise.all([
        inspectPersistentDeliveryEvidence
          ? (async () => {
              try {
                const cached = await loadNewRecruitCache(entry.roster);
                return {
                  delivery:
                    cached ??
                    (await loadNewRecruitProvisionalArtifact(entry.roster, {
                      repairMutationReceipt: false,
                    })) ??
                    (await loadNewRecruitMutationRecoveryArtifact(
                      entry.roster,
                    )),
                  error: null,
                };
              } catch (error) {
                return {
                  delivery: null,
                  error:
                    error instanceof Error
                      ? error.message
                      : "The retained New Recruit artifact could not be verified.",
                };
              }
            })()
          : Promise.resolve({ delivery: null, error: null }),
        inspectPersistentDeliveryEvidence
          ? inspectNewRecruitMutationReceipt(entry.roster).catch((error) => ({
              error:
                error instanceof Error
                  ? error.message
                  : "The mutation receipt could not be verified.",
            }))
          : Promise.resolve(null),
      ]);
      return {
        entry,
        cached: deliveryEvidence.delivery,
        deliveryEvidenceError: deliveryEvidence.error,
        receipt,
      };
    }),
  );

  const cacheHits = new Map<string, ResultEnvelope<NewRecruitDelivery>>();
  const rosters = inspected.map((entry, index) => {
    const inventory = inventories[index];
    if (inventory.cached) {
      cacheHits.set(entry.cacheKey, inventory.cached);
    }
    const receipt = inventory.receipt;
    const receiptError = Boolean(
      inventory.deliveryEvidenceError ||
      (receipt && "error" in receipt),
    );
    if (receiptError) {
      entry.record.violationCodes.push(
        "NEW_RECRUIT_MUTATION_RECEIPT_INVALID",
      );
    }
    const inspectedReceipt =
      receipt && !("error" in receipt) ? receipt : null;
    const latestOutcome = inspectedReceipt?.latestAttempt?.outcome ?? null;
    if (
      !receiptError &&
      !inventory.cached &&
      (latestOutcome === "created" || latestOutcome === "reused")
    ) {
      entry.record.violationCodes.push(
        "NEW_RECRUIT_MUTATION_ARTIFACT_UNAVAILABLE",
      );
    }
    return {
      ...entry.record,
      violationCodes: [...new Set(entry.record.violationCodes)].sort(),
      cache: {
        cacheKey: entry.cacheKey,
        verifiedHit: inventory.cached !== null,
        receiptFound: inspectedReceipt?.receiptFound ?? receiptError,
        latestOutcome:
          inspectedReceipt?.latestAttempt?.outcome ?? null,
        safeToRetry: inspectedReceipt?.safeToRetry ?? !receiptError,
        requiredAction:
          inspectedReceipt?.requiredAction ??
          (receiptError
            ? "reconcile-from-observed-evidence"
            : "none"),
      },
    } satisfies TesseraBatchPreflightRosterV1;
  });

  const uncertainMutationReceipts = rosters.filter(
    (entry) =>
      !entry.cache.verifiedHit &&
      (entry.cache.latestOutcome === "pending" ||
        entry.cache.latestOutcome === "uncertain"),
  ).length;
  const failureCodes = [
    ...new Set(
      rosters.flatMap((entry) => entry.violationCodes),
    ),
  ].sort();
  if (uncertainMutationReceipts > 0) {
    failureCodes.push("NEW_RECRUIT_MUTATION_OUTCOME_UNCERTAIN");
  }
  if (!policy.valid) {
    failureCodes.push("TESSERA_PROFILE_POLICY_REQUIRED");
  }
  const manifest = sealManifest({
    schemaVersion: 1,
    manifestKind: "tessera-batch-preflight",
    workflowId: input.workflowId,
    createdAt: new Date().toISOString(),
    status: !policy.valid
      ? "needs-input"
      : failureCodes.length > 0
        ? "failed"
        : "passed",
    requireNewRecruit: input.requireNewRecruit,
    rosterCount: rosters.length,
    rosters,
    profilePolicy: {
      sha256:
        input.profilePolicy === null
          ? null
          : profilePolicyHash(input.profilePolicy),
      valid: policy.valid,
      requirementCount: requirements.length,
      unresolvedRequirementKeys: policy.unresolved
        .map(profilePolicyIdentityKey)
        .sort(),
      errors: [...policy.errors].sort(),
    },
    inventory: {
      verifiedCacheHits: cacheHits.size,
      deliveryMisses: input.requireNewRecruit
        ? rosters.length - cacheHits.size
        : 0,
      mutationReceipts: rosters.filter(
        (entry) => entry.cache.receiptFound,
      ).length,
      uncertainMutationReceipts,
    },
    failureCodes: [...new Set(failureCodes)].sort(),
  });
  const manifestPath = path.resolve(
    input.outputDirectory,
    input.filename ?? "batch-preflight.json",
  );
  await writeAtomic(manifestPath, manifest);
  await verifyTesseraBatchPreflightManifest(manifestPath);
  return { manifest, manifestPath, cacheHits };
}
