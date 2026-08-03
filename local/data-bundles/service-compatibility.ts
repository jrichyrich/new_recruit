import crypto from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  DataBundleSnapshot,
} from "../../lib/rosterpilot/data-bundle";
import type {
  NewRecruitObservedCatalogueIdentity,
} from "../../lib/rosterpilot/types";
import type {
  RuntimeDataBundleShardData,
} from "../../lib/rosterpilot/runtime-data-bundle";
import {
  canonicalJson,
  sha256Hex,
} from "../../lib/rosterpilot/semantic-hash";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATE_FILENAME = "service-compatibility.json";
const LOCK_DIRECTORY = "service-compatibility.lock";
const MAX_STATE_BYTES = 16 * 1_024 * 1_024;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const MAX_LOCK_OWNER_BYTES = 4_096;

const sha256Schema = z
  .string()
  .regex(SHA256_PATTERN, "Expected a lowercase SHA-256 digest.");

const lockOwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    pid: z.number().int().positive(),
    token: z.string().uuid(),
    acquiredAt: z.string().datetime(),
  })
  .strict();

const serviceIdentitySchema = z
  .object({
    factionId: z.string().min(1).max(160),
    gameSystem: z
      .object({
        id: z.string().min(1).max(256),
        name: z.string().min(1).max(512).nullable(),
        revision: z.number().int().nonnegative(),
      })
      .strict(),
    factionCatalogue: z
      .object({
        id: z.string().min(1).max(256),
        name: z.string().min(1).max(512).nullable(),
        revision: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const tesseraMetadataSchema = z
  .object({
    observedAt: z.string().datetime(),
    deploymentAssetSha256: sha256Schema.nullable(),
    importedSemanticsSha256: sha256Schema.nullable(),
    jobReceiptSha256: sha256Schema.nullable(),
  })
  .strict()
  .refine(
    (metadata) =>
      metadata.deploymentAssetSha256 !== null ||
      metadata.importedSemanticsSha256 !== null ||
      metadata.jobReceiptSha256 !== null,
    "Tessera metadata must contain at least one evidence digest.",
  );

const observationDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    observationKind: z.literal(
      "rosterpilot-new-recruit-service-observation",
    ),
    observationId: sha256Schema,
    compatibilityKey: sha256Schema,
    identity: serviceIdentitySchema,
    observedAt: z.string().datetime(),
    recordedAt: z.string().datetime(),
    evidence: z
      .object({
        receiptKind: z.enum([
          "new-recruit-mutation-receipt",
          "new-recruit-enriched-cache-receipt",
          "tessera-preparation-receipt",
        ]),
        receiptSha256: sha256Schema,
        enrichedRoszSha256: sha256Schema,
      })
      .strict(),
    /**
     * Tessera identifies the deployed simulator and retained evidence only.
     * It is deliberately excluded from the compatibility key used to select
     * a roster-data snapshot.
     */
    tessera: tesseraMetadataSchema.nullable(),
  })
  .strict();

const observationSchema = observationDraftSchema
  .extend({
    integritySha256: sha256Schema,
  })
  .strict();

const snapshotReferenceDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    referenceKind: z.literal(
      "rosterpilot-service-compatible-data-bundle",
    ),
    referenceId: z.string().min(1).max(512),
    compatibilityKey: sha256Schema,
    bundleId: sha256Schema,
    identity: serviceIdentitySchema,
    snapshotCreatedAt: z.string().datetime(),
    retainedAt: z.string().datetime(),
    dataTrust: z.enum(["locally-verified", "signed-verified"]),
    bsDataCommit: z
      .string()
      .regex(/^[a-f0-9]{7,64}$/)
      .nullable(),
  })
  .strict();

const snapshotReferenceSchema = snapshotReferenceDraftSchema
  .extend({
    integritySha256: sha256Schema,
  })
  .strict();

const registryStateDraftObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    stateKind: z.literal(
      "rosterpilot-service-compatibility-registry",
    ),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    observations: z.array(observationSchema),
    snapshotReferences: z.array(snapshotReferenceSchema),
  })
  .strict();

function refineRegistryCollections(
  state: z.infer<typeof registryStateDraftObjectSchema>,
  context: z.RefinementCtx,
): void {
    const observationIds = state.observations.map(
      (observation) => observation.observationId,
    );
    if (new Set(observationIds).size !== observationIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observations"],
        message: "Service observations must have unique ids.",
      });
    }
    const referenceIds = state.snapshotReferences.map(
      (reference) => reference.referenceId,
    );
    if (new Set(referenceIds).size !== referenceIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshotReferences"],
        message: "Compatibility references must have unique ids.",
      });
    }
}

const registryStateDraftSchema =
  registryStateDraftObjectSchema.superRefine(
    refineRegistryCollections,
  );

const registryStateSchema = registryStateDraftObjectSchema
  .extend({
    integritySha256: sha256Schema,
  })
  .strict()
  .superRefine(refineRegistryCollections);

export type NewRecruitServiceIdentityV1 = z.infer<
  typeof serviceIdentitySchema
>;

export type NewRecruitServiceObservationV1 = z.infer<
  typeof observationSchema
>;

export type ServiceCompatibleSnapshotReferenceV1 = z.infer<
  typeof snapshotReferenceSchema
>;

export type ServiceCompatibilityRegistryStateV1 = z.infer<
  typeof registryStateSchema
>;

export type ServiceCompatibilityStoreErrorCode =
  | "SERVICE_COMPATIBILITY_IDENTITY_INCOMPLETE"
  | "SERVICE_COMPATIBILITY_STATE_INVALID"
  | "SERVICE_COMPATIBILITY_STATE_TOO_LARGE"
  | "SERVICE_COMPATIBILITY_STATE_UNSAFE"
  | "SERVICE_COMPATIBILITY_LOCKED";

export class ServiceCompatibilityStoreError extends Error {
  readonly code: ServiceCompatibilityStoreErrorCode;
  override readonly cause?: unknown;

  constructor(
    code: ServiceCompatibilityStoreErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ServiceCompatibilityStoreError";
    this.code = code;
    this.cause = options.cause;
  }
}

export type RecordNewRecruitServiceObservationInput = {
  identity: NewRecruitServiceIdentityV1;
  observedAt: string;
  evidence: {
    receiptKind:
      | "new-recruit-mutation-receipt"
      | "new-recruit-enriched-cache-receipt"
      | "tessera-preparation-receipt";
    receiptSha256: string;
    enrichedRoszSha256: string;
  };
  tessera?: {
    observedAt: string;
    deploymentAssetSha256?: string | null;
    importedSemanticsSha256?: string | null;
    jobReceiptSha256?: string | null;
  } | null;
};

export type RecordTesseraServiceEvidenceInput = {
  factionId: string;
  enrichedRoszSha256: string;
  observedAt: string;
  deploymentAssetSha256?: string | null;
  importedSemanticsSha256?: string | null;
  jobReceiptSha256?: string | null;
};

export type RetainServiceCompatibleSnapshotInput = {
  bundleId: string;
  identity: NewRecruitServiceIdentityV1;
  snapshotCreatedAt: string;
  dataTrust: "locally-verified" | "signed-verified";
  bsDataCommit?: string | null;
};

export type FindNewestServiceCompatibleSnapshotInput = {
  factionId: string;
  identity?: NewRecruitServiceIdentityV1;
  /**
   * When supplied, references whose immutable bundle is no longer installed
   * are ignored. The registry itself never claims that a bundle still exists.
   */
  retainedBundleIds?: ReadonlySet<string> | readonly string[];
};

export type CreateServiceCompatibilityStoreOptions = {
  rootDirectory: string;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  lockTimeoutMs?: number;
  staleLockMs?: number;
};

type RegistryStateDraft = z.infer<
  typeof registryStateDraftSchema
>;
type ObservationDraft = z.infer<typeof observationDraftSchema>;
type SnapshotReferenceDraft = z.infer<
  typeof snapshotReferenceDraftSchema
>;

function withoutIntegrity<T extends { integritySha256: string }>(
  value: T,
): Omit<T, "integritySha256"> {
  const draft = { ...value } as Partial<T>;
  delete draft.integritySha256;
  return draft as Omit<T, "integritySha256">;
}

function identityProjection(
  identity: NewRecruitServiceIdentityV1,
): unknown {
  return {
    factionId: identity.factionId,
    gameSystem: {
      id: identity.gameSystem.id,
      revision: identity.gameSystem.revision,
    },
    factionCatalogue: {
      id: identity.factionCatalogue.id,
      revision: identity.factionCatalogue.revision,
    },
  };
}

export async function newRecruitServiceCompatibilityKey(
  identity: NewRecruitServiceIdentityV1,
): Promise<string> {
  const parsed = serviceIdentitySchema.parse(identity);
  return sha256Hex(canonicalJson(identityProjection(parsed)));
}

export function sameNewRecruitServiceIdentity(
  left: NewRecruitServiceIdentityV1,
  right: NewRecruitServiceIdentityV1,
): boolean {
  return (
    left.factionId === right.factionId &&
    left.gameSystem.id === right.gameSystem.id &&
    left.gameSystem.revision === right.gameSystem.revision &&
    left.factionCatalogue.id === right.factionCatalogue.id &&
    left.factionCatalogue.revision ===
      right.factionCatalogue.revision
  );
}

/**
 * Converts receipt-bound New Recruit archive evidence into one exact faction
 * identity. Multi-force archives must name the expected faction catalogue;
 * the function never guesses which catalogue should drive compatibility.
 */
export function deriveNewRecruitServiceIdentity(input: {
  factionId: string;
  expectedFactionCatalogueId: string;
  observed: NewRecruitObservedCatalogueIdentity;
}): NewRecruitServiceIdentityV1 {
  const gameSystem = input.observed.gameSystem;
  const catalogue = input.observed.catalogues.find(
    (candidate) =>
      candidate.id === input.expectedFactionCatalogueId,
  );
  if (
    !input.factionId.trim() ||
    !gameSystem.id ||
    gameSystem.revision === null ||
    !catalogue?.id ||
    catalogue.revision === null
  ) {
    throw new ServiceCompatibilityStoreError(
      "SERVICE_COMPATIBILITY_IDENTITY_INCOMPLETE",
      "The receipt-backed New Recruit observation does not contain the exact game-system and faction-catalogue ids and revisions required for compatibility selection.",
    );
  }
  return serviceIdentitySchema.parse({
    factionId: input.factionId,
    gameSystem: {
      id: gameSystem.id,
      name: gameSystem.name,
      revision: gameSystem.revision,
    },
    factionCatalogue: {
      id: catalogue.id,
      name: catalogue.name,
      revision: catalogue.revision,
    },
  });
}

/** Derives the comparable New Recruit identity from an immutable snapshot. */
export function deriveSnapshotServiceIdentity(
  snapshot: DataBundleSnapshot<RuntimeDataBundleShardData>,
  factionId: string,
): NewRecruitServiceIdentityV1 {
  const global = [...snapshot.shards.values()].find(
    (shard) =>
      shard.data.payloadKind === "rosterpilot-runtime-global",
  )?.data;
  const faction = snapshot.getFactionShard(factionId)?.data;
  if (
    !global ||
    global.payloadKind !== "rosterpilot-runtime-global" ||
    !faction ||
    faction.payloadKind !== "rosterpilot-runtime-faction" ||
    faction.factionId !== factionId
  ) {
    throw new ServiceCompatibilityStoreError(
      "SERVICE_COMPATIBILITY_IDENTITY_INCOMPLETE",
      `Bundle ${snapshot.bundleId} does not contain a complete New Recruit identity for ${factionId}.`,
    );
  }
  return serviceIdentitySchema.parse({
    factionId,
    gameSystem: {
      id: global.catalogueBase.gameSystem.id,
      name: global.catalogueBase.gameSystem.name,
      revision: global.catalogueBase.gameSystem.revision,
    },
    factionCatalogue: {
      id: faction.catalogue.catalogue.id,
      name: faction.catalogue.catalogue.name,
      revision: faction.catalogue.catalogue.revision,
    },
  });
}

async function sealObservation(
  draft: ObservationDraft,
): Promise<NewRecruitServiceObservationV1> {
  const parsed = observationDraftSchema.parse(draft);
  return observationSchema.parse({
    ...parsed,
    integritySha256: await sha256Hex(canonicalJson(parsed)),
  });
}

async function sealSnapshotReference(
  draft: SnapshotReferenceDraft,
): Promise<ServiceCompatibleSnapshotReferenceV1> {
  const parsed = snapshotReferenceDraftSchema.parse(draft);
  return snapshotReferenceSchema.parse({
    ...parsed,
    integritySha256: await sha256Hex(canonicalJson(parsed)),
  });
}

async function sealState(
  draft: RegistryStateDraft,
): Promise<ServiceCompatibilityRegistryStateV1> {
  const parsed = registryStateDraftSchema.parse(draft);
  return registryStateSchema.parse({
    ...parsed,
    integritySha256: await sha256Hex(canonicalJson(parsed)),
  });
}

async function assertRecordIntegrity(
  record:
    | NewRecruitServiceObservationV1
    | ServiceCompatibleSnapshotReferenceV1,
): Promise<void> {
  const expected = await sha256Hex(
    canonicalJson(withoutIntegrity(record)),
  );
  if (record.integritySha256 !== expected) {
    throw new ServiceCompatibilityStoreError(
      "SERVICE_COMPATIBILITY_STATE_INVALID",
      "A service-compatibility record does not match its integrity digest.",
    );
  }
}

async function verifyState(
  input: unknown,
): Promise<ServiceCompatibilityRegistryStateV1> {
  const parsed = registryStateSchema.safeParse(input);
  if (!parsed.success) {
    throw new ServiceCompatibilityStoreError(
      "SERVICE_COMPATIBILITY_STATE_INVALID",
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  const state = parsed.data;
  const expected = await sha256Hex(
    canonicalJson(withoutIntegrity(state)),
  );
  if (state.integritySha256 !== expected) {
    throw new ServiceCompatibilityStoreError(
      "SERVICE_COMPATIBILITY_STATE_INVALID",
      "The service-compatibility registry does not match its integrity digest.",
    );
  }
  for (const observation of state.observations) {
    await assertRecordIntegrity(observation);
    if (
      observation.compatibilityKey !==
      (await newRecruitServiceCompatibilityKey(observation.identity))
    ) {
      throw new ServiceCompatibilityStoreError(
        "SERVICE_COMPATIBILITY_STATE_INVALID",
        "A New Recruit observation has an invalid compatibility key.",
      );
    }
  }
  for (const reference of state.snapshotReferences) {
    await assertRecordIntegrity(reference);
    if (
      reference.compatibilityKey !==
      (await newRecruitServiceCompatibilityKey(reference.identity)) ||
      reference.referenceId !==
        `service-compatibility:${reference.compatibilityKey}:${reference.bundleId}`
    ) {
      throw new ServiceCompatibilityStoreError(
        "SERVICE_COMPATIBILITY_STATE_INVALID",
        "A data-bundle compatibility reference has invalid identity bindings.",
      );
    }
  }
  return state;
}

function orderObservations(
  observations: NewRecruitServiceObservationV1[],
): NewRecruitServiceObservationV1[] {
  return observations.sort((left, right) =>
    left.observedAt.localeCompare(right.observedAt) ||
    left.recordedAt.localeCompare(right.recordedAt) ||
    left.observationId.localeCompare(right.observationId),
  );
}

function orderReferences(
  references: ServiceCompatibleSnapshotReferenceV1[],
): ServiceCompatibleSnapshotReferenceV1[] {
  return references.sort((left, right) =>
    left.snapshotCreatedAt.localeCompare(right.snapshotCreatedAt) ||
    left.retainedAt.localeCompare(right.retainedAt) ||
    left.referenceId.localeCompare(right.referenceId),
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function readLockOwner(
  lockDirectory: string,
): Promise<z.infer<typeof lockOwnerSchema> | null> {
  const ownerPath = path.join(lockDirectory, "owner.json");
  try {
    const metadata = await lstat(ownerPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_LOCK_OWNER_BYTES
    ) {
      return null;
    }
    return lockOwnerSchema.parse(
      JSON.parse(await readFile(ownerPath, "utf8")),
    );
  } catch {
    return null;
  }
}

export class ServiceCompatibilityStore {
  readonly rootDirectory: string;
  readonly #now: () => Date;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;

  constructor(options: CreateServiceCompatibilityStoreOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.#now = options.now ?? (() => new Date());
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.#staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
  }

  async readState(): Promise<ServiceCompatibilityRegistryStateV1> {
    await mkdir(this.rootDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const filename = path.join(this.rootDirectory, STATE_FILENAME);
    let metadata;
    try {
      metadata = await lstat(filename);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return sealState({
          schemaVersion: 1,
          stateKind: "rosterpilot-service-compatibility-registry",
          revision: 0,
          updatedAt: this.#now().toISOString(),
          observations: [],
          snapshotReferences: [],
        });
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ServiceCompatibilityStoreError(
        "SERVICE_COMPATIBILITY_STATE_UNSAFE",
        "The service-compatibility registry must be a regular file.",
      );
    }
    if (metadata.size > MAX_STATE_BYTES) {
      throw new ServiceCompatibilityStoreError(
        "SERVICE_COMPATIBILITY_STATE_TOO_LARGE",
        "The service-compatibility registry exceeds its bounded size limit.",
      );
    }
    try {
      return await verifyState(
        JSON.parse(await readFile(filename, "utf8")),
      );
    } catch (error) {
      if (error instanceof ServiceCompatibilityStoreError) {
        throw error;
      }
      throw new ServiceCompatibilityStoreError(
        "SERVICE_COMPATIBILITY_STATE_INVALID",
        "The service-compatibility registry is not readable JSON.",
        { cause: error },
      );
    }
  }

  async recordNewRecruitObservation(
    input: RecordNewRecruitServiceObservationInput,
  ): Promise<NewRecruitServiceObservationV1> {
    return this.#withLock(async () => {
      const state = await this.readState();
      const identity = serviceIdentitySchema.parse(input.identity);
      const compatibilityKey =
        await newRecruitServiceCompatibilityKey(identity);
      const observedAt = z.string().datetime().parse(input.observedAt);
      const recordedAt = this.#now().toISOString();
      const evidence = {
        ...input.evidence,
      };
      const tessera = input.tessera
        ? {
            observedAt: input.tessera.observedAt,
            deploymentAssetSha256:
              input.tessera.deploymentAssetSha256 ?? null,
            importedSemanticsSha256:
              input.tessera.importedSemanticsSha256 ?? null,
            jobReceiptSha256:
              input.tessera.jobReceiptSha256 ?? null,
          }
        : null;
      const observationId = await sha256Hex(
        canonicalJson({
          compatibilityKey,
          identity,
          observedAt,
          evidence,
          tessera,
        }),
      );
      const existing = state.observations.find(
        (observation) => observation.observationId === observationId,
      );
      if (existing) return existing;
      const observation = await sealObservation({
        schemaVersion: 1,
        observationKind:
          "rosterpilot-new-recruit-service-observation",
        observationId,
        compatibilityKey,
        identity,
        observedAt,
        recordedAt,
        evidence,
        tessera,
      });
      await this.#writeState(
        await sealState({
          ...withoutIntegrity(state),
          revision: state.revision + 1,
          updatedAt: recordedAt,
          observations: orderObservations([
            ...state.observations,
            observation,
          ]),
        }),
      );
      return observation;
    });
  }

  /**
   * Adds Tessera deployment/import evidence to the exact receipt-backed New
   * Recruit observation used for the player archive. The catalogue identity
   * remains the compatibility key; website deployment identity is evidence
   * metadata only.
   */
  async recordTesseraEvidence(
    input: RecordTesseraServiceEvidenceInput,
  ): Promise<NewRecruitServiceObservationV1 | null> {
    const factionId = z.string().min(1).max(160).parse(input.factionId);
    const enrichedRoszSha256 = sha256Schema.parse(
      input.enrichedRoszSha256,
    );
    const state = await this.readState();
    const source =
      state.observations
        .filter(
          (observation) =>
            observation.identity.factionId === factionId &&
            observation.evidence.enrichedRoszSha256 ===
              enrichedRoszSha256,
        )
        .sort((left, right) =>
          right.observedAt.localeCompare(left.observedAt) ||
          right.recordedAt.localeCompare(left.recordedAt),
        )[0] ?? null;
    if (!source) return null;
    return this.recordNewRecruitObservation({
      identity: source.identity,
      observedAt: source.observedAt,
      evidence: source.evidence,
      tessera: {
        observedAt: input.observedAt,
        deploymentAssetSha256:
          input.deploymentAssetSha256 ?? null,
        importedSemanticsSha256:
          input.importedSemanticsSha256 ?? null,
        jobReceiptSha256: input.jobReceiptSha256 ?? null,
      },
    });
  }

  async retainCompatibleSnapshot(
    input: RetainServiceCompatibleSnapshotInput,
  ): Promise<ServiceCompatibleSnapshotReferenceV1> {
    return this.#withLock(async () => {
      const state = await this.readState();
      const identity = serviceIdentitySchema.parse(input.identity);
      const compatibilityKey =
        await newRecruitServiceCompatibilityKey(identity);
      const bundleId = sha256Schema.parse(input.bundleId);
      const referenceId =
        `service-compatibility:${compatibilityKey}:${bundleId}`;
      const existing = state.snapshotReferences.find(
        (reference) => reference.referenceId === referenceId,
      );
      if (existing) return existing;
      const retainedAt = this.#now().toISOString();
      const reference = await sealSnapshotReference({
        schemaVersion: 1,
        referenceKind:
          "rosterpilot-service-compatible-data-bundle",
        referenceId,
        compatibilityKey,
        bundleId,
        identity,
        snapshotCreatedAt: input.snapshotCreatedAt,
        retainedAt,
        dataTrust: input.dataTrust,
        bsDataCommit: input.bsDataCommit ?? null,
      });
      await this.#writeState(
        await sealState({
          ...withoutIntegrity(state),
          revision: state.revision + 1,
          updatedAt: retainedAt,
          snapshotReferences: orderReferences([
            ...state.snapshotReferences,
            reference,
          ]),
        }),
      );
      return reference;
    });
  }

  async releaseCompatibleSnapshot(
    referenceId: string,
  ): Promise<boolean> {
    return this.#withLock(async () => {
      const state = await this.readState();
      const remaining = state.snapshotReferences.filter(
        (reference) => reference.referenceId !== referenceId,
      );
      if (remaining.length === state.snapshotReferences.length) {
        return false;
      }
      const updatedAt = this.#now().toISOString();
      await this.#writeState(
        await sealState({
          ...withoutIntegrity(state),
          revision: state.revision + 1,
          updatedAt,
          snapshotReferences: remaining,
        }),
      );
      return true;
    });
  }

  async latestNewRecruitObservation(
    factionId: string,
  ): Promise<NewRecruitServiceObservationV1 | null> {
    const state = await this.readState();
    return (
      state.observations
        .filter(
          (observation) =>
            observation.identity.factionId === factionId,
        )
        .sort((left, right) =>
          right.observedAt.localeCompare(left.observedAt) ||
          right.recordedAt.localeCompare(left.recordedAt),
        )[0] ?? null
    );
  }

  async findNewestCompatibleSnapshot(
    input: FindNewestServiceCompatibleSnapshotInput,
  ): Promise<ServiceCompatibleSnapshotReferenceV1 | null> {
    const state = await this.readState();
    const identity =
      input.identity ??
      (
        await this.latestNewRecruitObservation(input.factionId)
      )?.identity;
    if (!identity || identity.factionId !== input.factionId) {
      return null;
    }
    const retained = input.retainedBundleIds
      ? new Set(input.retainedBundleIds)
      : null;
    return (
      state.snapshotReferences
        .filter(
          (reference) =>
            sameNewRecruitServiceIdentity(
              reference.identity,
              identity,
            ) &&
            (!retained || retained.has(reference.bundleId)),
        )
        .sort((left, right) =>
          right.snapshotCreatedAt.localeCompare(
            left.snapshotCreatedAt,
          ) || right.retainedAt.localeCompare(left.retainedAt),
        )[0] ?? null
    );
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.rootDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const lockDirectory = path.join(
      this.rootDirectory,
      LOCK_DIRECTORY,
    );
    let owner: z.infer<typeof lockOwnerSchema> | null = null;
    const deadline = Date.now() + this.#lockTimeoutMs;
    while (true) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        owner = {
          schemaVersion: 1,
          pid: process.pid,
          token: crypto.randomUUID(),
          acquiredAt: this.#now().toISOString(),
        };
        try {
          await writeFile(
            path.join(lockDirectory, "owner.json"),
            `${JSON.stringify(owner, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600, flag: "wx" },
          );
        } catch (error) {
          await rm(lockDirectory, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        const lockStat = await lstat(lockDirectory).catch(() => null);
        if (!lockStat) continue;
        if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
          throw new ServiceCompatibilityStoreError(
            "SERVICE_COMPATIBILITY_STATE_UNSAFE",
            "The service-compatibility lock must be a regular directory.",
          );
        }
        const existing = await readLockOwner(lockDirectory);
        const lockAge = existing
          ? this.#now().getTime() -
            new Date(existing.acquiredAt).getTime()
          : this.#now().getTime() - lockStat.mtimeMs;
        if (
          lockAge > this.#staleLockMs &&
          (!existing || !this.#isProcessAlive(existing.pid))
        ) {
          const abandoned = `${lockDirectory}.abandoned-${crypto.randomUUID()}`;
          try {
            await rename(lockDirectory, abandoned);
          } catch (renameError) {
            if (
              renameError &&
              typeof renameError === "object" &&
              "code" in renameError &&
              renameError.code === "ENOENT"
            ) {
              continue;
            }
            throw renameError;
          }
          const movedOwner = await readLockOwner(abandoned);
          if (
            (existing && movedOwner?.token !== existing.token) ||
            (!existing &&
              movedOwner &&
              (this.#isProcessAlive(movedOwner.pid) ||
                this.#now().getTime() -
                  new Date(movedOwner.acquiredAt).getTime() <=
                  this.#staleLockMs))
          ) {
            await rename(abandoned, lockDirectory).catch(() => undefined);
            throw new ServiceCompatibilityStoreError(
              "SERVICE_COMPATIBILITY_LOCKED",
              "The service-compatibility lock owner changed during recovery.",
            );
          }
          await rm(abandoned, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new ServiceCompatibilityStoreError(
            "SERVICE_COMPATIBILITY_LOCKED",
            "Timed out waiting for the service-compatibility registry lock.",
          );
        }
        await sleep(20);
      }
    }
    if (!owner) {
      throw new ServiceCompatibilityStoreError(
        "SERVICE_COMPATIBILITY_LOCKED",
        "The service-compatibility lock was not acquired.",
      );
    }
    const acquiredOwner = owner;
    try {
      return await operation();
    } finally {
      const current = await readLockOwner(lockDirectory);
      if (current?.token !== acquiredOwner.token) {
        throw new ServiceCompatibilityStoreError(
          "SERVICE_COMPATIBILITY_LOCKED",
          "The service-compatibility lock owner changed before release.",
        );
      }
      const released = `${lockDirectory}.released-${acquiredOwner.token}`;
      await rename(lockDirectory, released);
      await rm(released, { recursive: true, force: true });
    }
  }

  async #writeState(
    state: ServiceCompatibilityRegistryStateV1,
  ): Promise<void> {
    await verifyState(state);
    const content = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_STATE_BYTES) {
      throw new ServiceCompatibilityStoreError(
        "SERVICE_COMPATIBILITY_STATE_TOO_LARGE",
        "The service-compatibility registry exceeds its bounded size limit.",
      );
    }
    const filename = path.join(this.rootDirectory, STATE_FILENAME);
    const temporary = path.join(
      this.rootDirectory,
      `.${STATE_FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function createServiceCompatibilityStore(
  options: CreateServiceCompatibilityStoreOptions,
): ServiceCompatibilityStore {
  return new ServiceCompatibilityStore(options);
}
