import { z } from "zod";

import {
  DataBundleChannelCursorV1Schema,
  DataBundleManifestV1Schema,
  type DataBundleChannelCursorV1,
  type DataBundleSnapshot,
} from "./data-bundle";
import type {
  RuntimeDataBundleShardDataV1,
} from "./runtime-data-bundle";
import { canonicalJson } from "./semantic-hash";

export type HostedStoredDataBundle = {
  manifest: unknown;
  shards: unknown[];
};

export type HostedDataBundleRetentionResult = {
  prunedBundleIds: string[];
  retainedBundleIds: string[];
  protectedBundleIds: string[];
};

export type HostedDataBundleQuarantine = {
  quarantineId: string;
  bundleId: string;
  scopes: string[];
  reason: string;
  recordedAt: string;
};

export interface HostedDataBundlePersistence {
  getActiveBundleId(): Promise<string | null>;
  loadActiveBundle(): Promise<HostedStoredDataBundle | null>;
  loadBundle(bundleId: string): Promise<HostedStoredDataBundle | null>;
  persistBundle(
    snapshot: DataBundleSnapshot<RuntimeDataBundleShardDataV1>,
  ): Promise<void>;
  activateBundle(bundleId: string): Promise<void>;
  recordQuarantine(input: {
    bundleId: string;
    scopes: readonly string[];
    reason: string;
  }): Promise<void>;
  clearQuarantine(input: {
    bundleId: string;
    reason: string;
  }): Promise<void>;
  loadQuarantines(): Promise<HostedDataBundleQuarantine[]>;
  loadRollbackHold(): Promise<HostedDataBundleRollbackHold | null>;
  persistRollbackHold(hold: HostedDataBundleRollbackHold): Promise<void>;
  clearRollbackHold(): Promise<void>;
  loadChannelCursor(): Promise<DataBundleChannelCursorV1 | null>;
  compareAndSetChannelCursor(input: {
    expectedPointerSha256: string | null;
    cursor: DataBundleChannelCursorV1;
  }): Promise<{
    committed: boolean;
    cursor: DataBundleChannelCursorV1;
  }>;
  retainReference(referenceId: string, bundleId: string): Promise<void>;
  releaseReference(referenceId: string, bundleId?: string): Promise<void>;
  enforceRetention(input: {
    verifyBundle(bundle: HostedStoredDataBundle): Promise<void>;
  }): Promise<HostedDataBundleRetentionResult>;
}

export type HostedDataBundleObjectMetadata = {
  key: string;
  uploadedAt: string | null;
  size?: number;
};

export interface HostedDataBundleObjectStore {
  get(key: string): Promise<{
    value: string;
    version: string;
    uploadedAt: string | null;
  } | null>;
  put(key: string, value: string): Promise<void>;
  compareAndSwap(
    key: string,
    expectedVersion: string | null,
    value: string,
  ): Promise<boolean>;
  delete(keys: readonly string[]): Promise<void>;
  list(input: {
    prefix: string;
    cursor?: string;
  }): Promise<{
    objects: HostedDataBundleObjectMetadata[];
    cursor?: string | null;
  }>;
}

export type HostedDataBundlePersistenceOptions = {
  now?: () => Date;
};

export type HostedDataBundleRollbackHold = {
  bundleId: string;
  engagedAt: string;
  release: "force-refresh";
};

const STORAGE_PREFIX = "rosterpilot-data/v1/";
const ACTIVE_KEY = `${STORAGE_PREFIX}active.json`;
const BUNDLE_PREFIX = `${STORAGE_PREFIX}bundles/`;
const REFERENCE_PREFIX = `${STORAGE_PREFIX}references/`;
const QUARANTINE_PREFIX = `${STORAGE_PREFIX}quarantines/`;
const QUARANTINE_CLEAR_PREFIX = `${STORAGE_PREFIX}quarantine-clears/`;
const LIFECYCLE_LEASE_KEY = `${STORAGE_PREFIX}lifecycle-lease.json`;
const CHANNEL_CURSOR_KEY = `${STORAGE_PREFIX}channel-cursor.json`;
const PREVIOUS_BUNDLE_RETENTION = 3;
const RETENTION_DAYS = 30;
const LIFECYCLE_LEASE_MS = 30 * 60_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const rollbackHoldSchema = z
  .object({
    bundleId: sha256Schema,
    engagedAt: z.string().datetime(),
    release: z.literal("force-refresh"),
  })
  .strict();
const activePointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    bundleId: sha256Schema,
    previousBundleIds: z.array(sha256Schema).max(
      PREVIOUS_BUNDLE_RETENTION,
    ),
    updatedAt: z.string().datetime(),
    rollbackHold: rollbackHoldSchema.nullable().default(null),
  })
  .strict()
  .superRefine((pointer, context) => {
    if (
      pointer.previousBundleIds.includes(pointer.bundleId) ||
      new Set(pointer.previousBundleIds).size !==
        pointer.previousBundleIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousBundleIds"],
        message: "Hosted rollback history must be unique and exclude the active bundle.",
      });
    }
  });
const legacyActivePointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    bundleId: sha256Schema,
  })
  .strict();
const referenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    referenceId: z.string().min(1).max(512),
    bundleId: sha256Schema,
  })
  .strict();
const quarantineSchema = z
  .object({
    schemaVersion: z.literal(1),
    quarantineId: z.string().uuid(),
    bundleId: sha256Schema,
    scopes: z.array(z.string().min(1).max(160)),
    reason: z.string().min(1).max(4_000),
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((quarantine, context) => {
    if (new Set(quarantine.scopes).size !== quarantine.scopes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopes"],
        message: "Hosted quarantine scopes must be unique.",
      });
    }
  });
const lifecycleLeaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z.string().uuid(),
    expiresAt: z.string().datetime(),
    released: z.boolean(),
  })
  .strict();
const quarantineClearSchema = z
  .object({
    schemaVersion: z.literal(1),
    clearId: z.string().uuid(),
    quarantineId: z.string().uuid(),
    bundleId: sha256Schema,
    clearedAt: z.string().datetime(),
    reason: z.string().min(1).max(4_000),
  })
  .strict();

type ActivePointer = z.infer<typeof activePointerSchema>;

function bundleKey(bundleId: string, suffix: string): string {
  return `${BUNDLE_PREFIX}${bundleId}/${suffix}`;
}

function safeReferenceId(referenceId: string): string {
  return encodeURIComponent(referenceId).replaceAll("%", "_");
}

async function parseStoredJson(
  store: HostedDataBundleObjectStore,
  key: string,
): Promise<unknown | null> {
  const object = await store.get(key);
  if (object === null) return null;
  try {
    return JSON.parse(object.value);
  } catch {
    throw new Error(`Hosted data-bundle object ${key} is not valid JSON.`);
  }
}

async function readActivePointer(
  store: HostedDataBundleObjectStore,
): Promise<{ pointer: ActivePointer; version: string } | null> {
  const object = await store.get(ACTIVE_KEY);
  if (object === null) return null;
  let input: unknown;
  try {
    input = JSON.parse(object.value);
  } catch {
    throw new Error("The hosted active data-bundle pointer is not valid JSON.");
  }
  const current = activePointerSchema.safeParse(input);
  if (current.success) {
    return { pointer: current.data, version: object.version };
  }
  const legacy = legacyActivePointerSchema.safeParse(input);
  if (legacy.success) {
    return {
      pointer: {
        ...legacy.data,
        previousBundleIds: [],
        updatedAt: new Date(0).toISOString(),
        rollbackHold: null,
      },
      version: object.version,
    };
  }
  throw new Error("The hosted active data-bundle pointer failed validation.");
}

async function readChannelCursor(
  store: HostedDataBundleObjectStore,
): Promise<{
  cursor: DataBundleChannelCursorV1;
  version: string;
} | null> {
  const object = await store.get(CHANNEL_CURSOR_KEY);
  if (object === null) return null;
  let input: unknown;
  try {
    input = JSON.parse(object.value);
  } catch {
    throw new Error(
      "The hosted data-bundle channel cursor is not valid JSON.",
    );
  }
  const cursor = DataBundleChannelCursorV1Schema.safeParse(input);
  if (!cursor.success) {
    throw new Error(
      "The hosted data-bundle channel cursor failed validation.",
    );
  }
  return { cursor: cursor.data, version: object.version };
}

async function writeImmutable(
  store: HostedDataBundleObjectStore,
  key: string,
  value: unknown,
): Promise<void> {
  const serialized = canonicalJson(value);
  const existing = await store.get(key);
  if (existing !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing.value);
    } catch {
      throw new Error(
        `Hosted immutable data-bundle object ${key} contains invalid JSON.`,
      );
    }
    if (canonicalJson(parsed) !== serialized) {
      throw new Error(
        `Hosted immutable data-bundle object ${key} already contains different content.`,
      );
    }
  }
  if (existing === null) {
    const created = await store.compareAndSwap(key, null, serialized);
    if (!created) {
      const raced = await store.get(key);
      if (!raced) {
        throw new Error(
          `Hosted immutable data-bundle object ${key} lost a concurrent create.`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raced.value);
      } catch {
        throw new Error(
          `Hosted immutable data-bundle object ${key} contains invalid JSON.`,
        );
      }
      if (canonicalJson(parsed) !== serialized) {
        throw new Error(
          `Hosted immutable data-bundle object ${key} was concurrently replaced with different content.`,
        );
      }
    }
  }
}

async function listAll(
  store: HostedDataBundleObjectStore,
  prefix: string,
): Promise<HostedDataBundleObjectMetadata[]> {
  const objects = new Map<string, HostedDataBundleObjectMetadata>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.objects)) {
      throw new Error(`Hosted object listing for ${prefix} was malformed.`);
    }
    for (const object of page.objects) {
      if (
        !object ||
        typeof object.key !== "string" ||
        !object.key.startsWith(prefix) ||
        (object.uploadedAt !== null &&
          (typeof object.uploadedAt !== "string" ||
            !Number.isFinite(Date.parse(object.uploadedAt)))) ||
        objects.has(object.key)
      ) {
        throw new Error(
          `Hosted object listing for ${prefix} contained invalid or duplicate metadata.`,
        );
      }
      objects.set(object.key, object);
    }
    const next = page.cursor ?? null;
    if (!next) break;
    if (typeof next !== "string" || cursors.has(next)) {
      throw new Error(
        `Hosted object listing for ${prefix} repeated an invalid cursor.`,
      );
    }
    cursors.add(next);
    cursor = next;
  }
  return [...objects.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

/**
 * Platform-neutral durable archive over an object store such as Cloudflare
 * R2. Bundle objects are immutable and the active pointer is written last.
 * Retention first validates the complete listing, every pointer/reference,
 * and every bundle through the caller's signature verifier; no object is
 * deleted when inventory integrity is uncertain.
 */
export function createHostedObjectStoreDataBundlePersistence(
  store: HostedDataBundleObjectStore,
  options: HostedDataBundlePersistenceOptions = {},
): HostedDataBundlePersistence {
  const now = options.now ?? (() => new Date());
  const loadBundle = async (
    bundleId: string,
  ): Promise<HostedStoredDataBundle | null> => {
    if (!SHA256_PATTERN.test(bundleId)) {
      throw new Error(`Hosted archived data bundle ${bundleId} has an invalid id.`);
    }
    const manifest = await parseStoredJson(
      store,
      bundleKey(bundleId, "manifest.json"),
    );
    if (manifest === null) return null;
    const shape = DataBundleManifestV1Schema.safeParse(manifest);
    if (!shape.success || shape.data.bundleId !== bundleId) {
      throw new Error(
        `Hosted archived data bundle ${bundleId} has an invalid manifest.`,
      );
    }
    const shards = await Promise.all(
      shape.data.shards.map(async (descriptor) => {
        const shard = await parseStoredJson(
          store,
          bundleKey(bundleId, descriptor.path),
        );
        if (shard === null) {
          throw new Error(
            `Hosted archived data bundle ${bundleId} is missing shard ${descriptor.shardId}.`,
          );
        }
        return shard;
      }),
    );
    return { manifest, shards };
  };

  const acquireLifecycleLease = async () => {
    const owner = crypto.randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await store.get(LIFECYCLE_LEASE_KEY);
      let expectedVersion: string | null = null;
      if (current) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(current.value);
        } catch {
          throw new Error(
            "The hosted data-bundle lifecycle lease is corrupt.",
          );
        }
        const lease = lifecycleLeaseSchema.safeParse(parsed);
        if (!lease.success) {
          throw new Error(
            "The hosted data-bundle lifecycle lease failed validation.",
          );
        }
        if (
          !lease.data.released &&
          Date.parse(lease.data.expiresAt) > now().getTime()
        ) {
          throw new Error(
            "Another hosted data-bundle lifecycle mutation is in progress.",
          );
        }
        expectedVersion = current.version;
      }
      const acquired = await store.compareAndSwap(
        LIFECYCLE_LEASE_KEY,
        expectedVersion,
        canonicalJson({
          schemaVersion: 1,
          owner,
          expiresAt: new Date(
            now().getTime() + LIFECYCLE_LEASE_MS,
          ).toISOString(),
          released: false,
        }),
      );
      if (!acquired) continue;
      const committed = await store.get(LIFECYCLE_LEASE_KEY);
      if (!committed) {
        throw new Error(
          "The hosted data-bundle lifecycle lease disappeared after acquisition.",
        );
      }
      const parsed = lifecycleLeaseSchema.safeParse(
        JSON.parse(committed.value),
      );
      if (!parsed.success || parsed.data.owner !== owner) {
        throw new Error(
          "The hosted data-bundle lifecycle lease changed after acquisition.",
        );
      }
      return { owner, version: committed.version };
    }
    throw new Error(
      "The hosted data-bundle lifecycle lease changed concurrently.",
    );
  };

  let localLifecycleTail: Promise<void> = Promise.resolve();
  const withLifecycleLease = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = localLifecycleTail;
    let releaseLocal!: () => void;
    localLifecycleTail = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    await previous;
    let lease: Awaited<ReturnType<typeof acquireLifecycleLease>> | null =
      null;
    try {
      lease = await acquireLifecycleLease();
      return await operation();
    } finally {
      try {
        if (lease) {
          await store.compareAndSwap(
            LIFECYCLE_LEASE_KEY,
            lease.version,
            canonicalJson({
              schemaVersion: 1,
              owner: lease.owner,
              expiresAt: new Date(0).toISOString(),
              released: true,
            }),
          );
        }
      } finally {
        releaseLocal();
      }
    }
  };

  const loadAuthoritativeQuarantines = async () => {
    const [objects, clearObjects] = await Promise.all([
      listAll(store, QUARANTINE_PREFIX),
      listAll(store, QUARANTINE_CLEAR_PREFIX),
    ]);
    const clearedQuarantineIds = new Set<string>();
    for (const object of clearObjects) {
      const parsed = quarantineClearSchema.safeParse(
        await parseStoredJson(store, object.key),
      );
      if (
        !parsed.success ||
        object.key !==
          `${QUARANTINE_CLEAR_PREFIX}${parsed.data.bundleId}/${parsed.data.clearId}.json`
      ) {
        throw new Error(
          `Hosted quarantine-clear object ${object.key} failed validation.`,
        );
      }
      clearedQuarantineIds.add(parsed.data.quarantineId);
    }
    const quarantines: HostedDataBundleQuarantine[] = [];
    for (const object of objects) {
      const parsed = quarantineSchema.safeParse(
        await parseStoredJson(store, object.key),
      );
      if (
        !parsed.success ||
        object.key !==
          `${QUARANTINE_PREFIX}${parsed.data.bundleId}.json`
      ) {
        throw new Error(
          `Hosted quarantine object ${object.key} failed validation.`,
        );
      }
      if (clearedQuarantineIds.has(parsed.data.quarantineId)) continue;
      quarantines.push({
        quarantineId: parsed.data.quarantineId,
        bundleId: parsed.data.bundleId,
        scopes: parsed.data.scopes,
        reason: parsed.data.reason,
        recordedAt: parsed.data.recordedAt,
      });
    }
    return quarantines.sort((left, right) =>
      left.recordedAt.localeCompare(right.recordedAt),
    );
  };

  return {
    async getActiveBundleId() {
      return (await readActivePointer(store))?.pointer.bundleId ?? null;
    },
    async loadActiveBundle() {
      const active = await readActivePointer(store);
      return active ? loadBundle(active.pointer.bundleId) : null;
    },
    loadBundle,
    async persistBundle(snapshot) {
      for (const descriptor of snapshot.manifest.shards) {
        const shard = snapshot.getShard(descriptor.shardId);
        if (!shard) {
          throw new Error(
            `Cannot persist data bundle ${snapshot.bundleId} without shard ${descriptor.shardId}.`,
          );
        }
        await writeImmutable(
          store,
          bundleKey(snapshot.bundleId, descriptor.path),
          shard,
        );
      }
      await writeImmutable(
        store,
        bundleKey(snapshot.bundleId, "manifest.json"),
        snapshot.manifest,
      );
    },
    async activateBundle(bundleId) {
      return withLifecycleLease(async () => {
        if (!(await loadBundle(bundleId))) {
        throw new Error(
          `Cannot activate missing hosted data bundle ${bundleId}.`,
        );
        }
        if (
          (await loadAuthoritativeQuarantines()).some(
            (quarantine) => quarantine.bundleId === bundleId,
          )
        ) {
          throw new Error(
            `Hosted data bundle ${bundleId} is quarantined and cannot be activated without an audited clear.`,
          );
        }
        const current = await readActivePointer(store);
        if (current) {
          for (const retainedBundleId of [
            current.pointer.bundleId,
            ...current.pointer.previousBundleIds,
            ...(current.pointer.rollbackHold
              ? [current.pointer.rollbackHold.bundleId]
              : []),
          ]) {
            if (!(await loadBundle(retainedBundleId))) {
              throw new Error(
                `Hosted active pointer retains missing bundle ${retainedBundleId}.`,
              );
            }
          }
        }
        if (
          current?.pointer.bundleId === bundleId &&
          current.pointer.updatedAt !== new Date(0).toISOString()
        ) {
          return;
        }
        const previousBundleIds = current
          ? [
              ...(current.pointer.bundleId === bundleId
                ? []
                : [current.pointer.bundleId]),
              ...current.pointer.previousBundleIds,
            ]
              .filter(
                (candidate, index, entries) =>
                  candidate !== bundleId && entries.indexOf(candidate) === index,
              )
              .slice(0, PREVIOUS_BUNDLE_RETENTION)
          : [];
        const replaced = await store.compareAndSwap(
          ACTIVE_KEY,
          current?.version ?? null,
          canonicalJson({
            schemaVersion: 1,
            bundleId,
            previousBundleIds,
            updatedAt: now().toISOString(),
            rollbackHold: current?.pointer.rollbackHold ?? null,
          } satisfies ActivePointer),
        );
        if (!replaced) {
          const raced = await readActivePointer(store);
          if (raced?.pointer.bundleId === bundleId) return;
          throw new Error(
            "The hosted active data-bundle pointer changed concurrently; activation was not committed.",
          );
        }
      });
    },
    async recordQuarantine(input) {
      return withLifecycleLease(async () => {
        const quarantine = quarantineSchema.parse({
          schemaVersion: 1,
          quarantineId: crypto.randomUUID(),
          ...input,
          recordedAt: now().toISOString(),
        });
        await store.put(
          `${QUARANTINE_PREFIX}${input.bundleId}.json`,
          canonicalJson(quarantine),
        );
      });
    },
    async clearQuarantine(input) {
      return withLifecycleLease(async () => {
        const bundleId = sha256Schema.parse(input.bundleId);
        const reason = z.string().min(1).max(4_000).parse(input.reason);
        const quarantine = (await loadAuthoritativeQuarantines()).find(
          (entry) => entry.bundleId === bundleId,
        );
        if (!quarantine) {
          throw new Error(
            `Hosted data bundle ${bundleId} has no authoritative quarantine to clear.`,
          );
        }
        const clear = quarantineClearSchema.parse({
          schemaVersion: 1,
          clearId: crypto.randomUUID(),
          quarantineId: quarantine.quarantineId,
          bundleId,
          clearedAt: now().toISOString(),
          reason,
        });
        await store.put(
          `${QUARANTINE_CLEAR_PREFIX}${bundleId}/${clear.clearId}.json`,
          canonicalJson(clear),
        );
      });
    },
    async loadQuarantines() {
      return loadAuthoritativeQuarantines();
    },
    async loadChannelCursor() {
      return (await readChannelCursor(store))?.cursor ?? null;
    },
    async compareAndSetChannelCursor(input) {
      const expectedPointerSha256 = input.expectedPointerSha256 === null
        ? null
        : sha256Schema.parse(input.expectedPointerSha256);
      const cursor = DataBundleChannelCursorV1Schema.parse(input.cursor);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await readChannelCursor(store);
        if (
          (current?.cursor.pointerSha256 ?? null) !==
          expectedPointerSha256
        ) {
          if (!current) {
            throw new Error(
              "The hosted data-bundle channel cursor was removed concurrently.",
            );
          }
          return { committed: false, cursor: current.cursor };
        }
        const committed = await store.compareAndSwap(
          CHANNEL_CURSOR_KEY,
          current?.version ?? null,
          canonicalJson(cursor),
        );
        if (committed) return { committed: true, cursor };
        const raced = await readChannelCursor(store);
        if (raced) {
          return { committed: false, cursor: raced.cursor };
        }
      }
      throw new Error(
        "The hosted data-bundle channel cursor changed concurrently.",
      );
    },
    async loadRollbackHold() {
      return (await readActivePointer(store))?.pointer.rollbackHold ?? null;
    },
    async persistRollbackHold(input) {
      return withLifecycleLease(async () => {
      const hold = rollbackHoldSchema.parse(input);
      if (!(await loadBundle(hold.bundleId))) {
        throw new Error(
          `Cannot retain a rollback hold for missing hosted bundle ${hold.bundleId}.`,
        );
      }
      if (
        (await loadAuthoritativeQuarantines()).some(
          (quarantine) => quarantine.bundleId === hold.bundleId,
        )
      ) {
        throw new Error(
          `Hosted data bundle ${hold.bundleId} is quarantined and cannot be held for rollback without an audited clear.`,
        );
      }
      const current = await readActivePointer(store);
      if (!current) {
        throw new Error(
          "Cannot persist a hosted rollback hold without an active pointer.",
        );
      }
      const replaced = await store.compareAndSwap(
        ACTIVE_KEY,
        current.version,
        canonicalJson({
          ...current.pointer,
          updatedAt: now().toISOString(),
          rollbackHold: hold,
        } satisfies ActivePointer),
      );
      if (!replaced) {
        const raced = await readActivePointer(store);
        if (
          raced &&
          canonicalJson(raced.pointer.rollbackHold) ===
            canonicalJson(hold)
        ) {
          return;
        }
        throw new Error(
          "The hosted active pointer changed while persisting a rollback hold.",
        );
      }
      });
    },
    async clearRollbackHold() {
      return withLifecycleLease(async () => {
      const current = await readActivePointer(store);
      if (!current?.pointer.rollbackHold) return;
      const replaced = await store.compareAndSwap(
        ACTIVE_KEY,
        current.version,
        canonicalJson({
          ...current.pointer,
          updatedAt: now().toISOString(),
          rollbackHold: null,
        } satisfies ActivePointer),
      );
      if (!replaced) {
        const raced = await readActivePointer(store);
        if (raced && !raced.pointer.rollbackHold) return;
        throw new Error(
          "The hosted active pointer changed while clearing its rollback hold.",
        );
      }
      });
    },
    async retainReference(referenceId, bundleId) {
      return withLifecycleLease(async () => {
      const reference = referenceSchema.parse({
        schemaVersion: 1,
        referenceId,
        bundleId,
      });
      if (!(await loadBundle(bundleId))) {
        throw new Error(
          `Cannot retain a reference to missing hosted data bundle ${bundleId}.`,
        );
      }
      await store.put(
        `${REFERENCE_PREFIX}${safeReferenceId(referenceId)}.json`,
        canonicalJson(reference),
      );
      });
    },
    async releaseReference(referenceId, bundleId) {
      return withLifecycleLease(async () => {
      const key =
        `${REFERENCE_PREFIX}${safeReferenceId(referenceId)}.json`;
      if (bundleId) {
        const input = await parseStoredJson(store, key);
        if (input === null) return;
        const existing = referenceSchema.parse(input);
        if (existing.bundleId !== bundleId) return;
      }
      await store.delete([key]);
      });
    },
    async enforceRetention(input) {
      return withLifecycleLease(async () => {
      const [active, bundleObjects, referenceObjects] = await Promise.all([
        readActivePointer(store),
        listAll(store, BUNDLE_PREFIX),
        listAll(store, REFERENCE_PREFIX),
      ]);
      if (!active) {
        throw new Error(
          "Hosted data-bundle retention requires a verified active pointer.",
        );
      }

      const objectsByBundle = new Map<
        string,
        HostedDataBundleObjectMetadata[]
      >();
      for (const object of bundleObjects) {
        const match = object.key.match(
          /^rosterpilot-data\/v1\/bundles\/([a-f0-9]{64})\/(.+)$/,
        );
        if (!match) {
          throw new Error(
            `Hosted bundle inventory contains unexpected object ${object.key}.`,
          );
        }
        const entries = objectsByBundle.get(match[1]) ?? [];
        entries.push(object);
        objectsByBundle.set(match[1], entries);
      }

      const inventories: Array<{
        bundleId: string;
        keys: string[];
        uploadedAt: number;
      }> = [];
      for (const [bundleId, objects] of objectsByBundle) {
        const bundle = await loadBundle(bundleId);
        if (!bundle) {
          throw new Error(
            `Hosted bundle inventory is missing manifest data for ${bundleId}.`,
          );
        }
        const manifest = DataBundleManifestV1Schema.parse(bundle.manifest);
        const expected = new Set([
          bundleKey(bundleId, "manifest.json"),
          ...manifest.shards.map((descriptor) =>
            bundleKey(bundleId, descriptor.path),
          ),
        ]);
        const actual = new Set(objects.map((object) => object.key));
        if (
          expected.size !== actual.size ||
          [...expected].some((key) => !actual.has(key))
        ) {
          throw new Error(
            `Hosted bundle ${bundleId} has an incomplete or unexpected object inventory.`,
          );
        }
        const manifestMetadata = objects.find(
          (object) => object.key === bundleKey(bundleId, "manifest.json"),
        );
        const uploadedAt = manifestMetadata?.uploadedAt
          ? Date.parse(manifestMetadata.uploadedAt)
          : Number.NaN;
        if (!Number.isFinite(uploadedAt)) {
          throw new Error(
            `Hosted bundle ${bundleId} has no trustworthy upload timestamp.`,
          );
        }
        await input.verifyBundle(bundle);
        inventories.push({
          bundleId,
          keys: [...actual].sort(),
          uploadedAt,
        });
      }

      const referencedBundleIds = new Set<string>();
      for (const object of referenceObjects) {
        const stored = referenceSchema.safeParse(
          await parseStoredJson(store, object.key),
        );
        if (!stored.success) {
          throw new Error(
            `Hosted data-bundle reference ${object.key} failed validation.`,
          );
        }
        const expectedKey =
          `${REFERENCE_PREFIX}${safeReferenceId(stored.data.referenceId)}.json`;
        if (object.key !== expectedKey) {
          throw new Error(
            `Hosted data-bundle reference ${object.key} is stored under the wrong identity.`,
          );
        }
        referencedBundleIds.add(stored.data.bundleId);
      }

      const available = new Set(
        inventories.map((inventory) => inventory.bundleId),
      );
      const protectedBundleIds = new Set([
        active.pointer.bundleId,
        ...active.pointer.previousBundleIds.slice(
          0,
          PREVIOUS_BUNDLE_RETENTION,
        ),
        ...(active.pointer.rollbackHold
          ? [active.pointer.rollbackHold.bundleId]
          : []),
        ...referencedBundleIds,
      ]);
      for (const bundleId of protectedBundleIds) {
        if (!available.has(bundleId)) {
          throw new Error(
            `Hosted retention pointer or reference targets missing bundle ${bundleId}.`,
          );
        }
      }

      const cutoff =
        now().getTime() - RETENTION_DAYS * 24 * 60 * 60_000;
      const prunable = inventories.filter(
        (inventory) =>
          !protectedBundleIds.has(inventory.bundleId) &&
          inventory.uploadedAt < cutoff,
      );
      const prunableIds = new Set(
        prunable.map((inventory) => inventory.bundleId),
      );
      for (const inventory of prunable) {
        await store.delete(inventory.keys);
      }
      return {
        prunedBundleIds: [...prunableIds].sort(),
        retainedBundleIds: inventories
          .map((inventory) => inventory.bundleId)
          .filter((bundleId) => !prunableIds.has(bundleId))
          .sort(),
        protectedBundleIds: [...protectedBundleIds].sort(),
      };
      });
    },
  };
}
