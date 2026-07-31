import { z } from "zod";

import {
  SEMANTIC_SHA256_PATTERN,
  canonicalJson,
  semanticHash,
  sha256Hex,
  type DataBundleDeltaResult,
  type DataBundleSemanticHashesV1,
} from "./semantic-hash";

const sha256Schema = z
  .string()
  .regex(SEMANTIC_SHA256_PATTERN, "Expected a lowercase SHA-256 digest.");
const identifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const keyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const relativeBundlePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(
    /^[A-Za-z0-9._:/-]+$/,
    "Bundle paths may contain only safe URL-path characters.",
  )
  .refine(
    (value) =>
      !value.startsWith("/") &&
      value
        .split("/")
        .every(
          (part) => part !== "" && part !== "." && part !== "..",
        ),
    "Bundle paths must be safe, relative POSIX paths.",
  );

export const FactionSemanticHashesV1Schema = z
  .object({
    factionRulesHash: sha256Schema,
    mappingHash: sha256Schema,
    portfolioHash: sha256Schema,
    conflictHash: sha256Schema,
    entityHashes: z.record(z.string().min(1), sha256Schema),
  })
  .strict();

export const DataBundleSemanticHashesV1Schema: z.ZodType<DataBundleSemanticHashesV1> =
  z
    .object({
      globalHash: sha256Schema,
      methodologyHash: sha256Schema,
      factions: z.record(
        z.string().min(1),
        FactionSemanticHashesV1Schema,
      ),
    })
    .strict();

export const DataBundleProvenanceV1Schema = z
  .object({
    official: z
      .object({
        authority: z.literal("games-workshop"),
        version: z.string().min(1),
        contentSha256: sha256Schema,
        downloadsUrl: z.string().url(),
        dataUrl: z.string().url().optional(),
        publishedAt: z.string().datetime().optional(),
        checkedAt: z.string().datetime(),
      })
      .strict(),
    rules: z
      .object({
        provider: z.literal("40kdc-data"),
        package: z.string().min(1),
        version: z.string().min(1),
        sourceSha256: sha256Schema,
        edition: z.string().min(1),
        dataslate: z.string().min(1),
      })
      .strict(),
    newRecruit: z
      .object({
        provider: z.literal("bsdata"),
        repository: z.string().min(1),
        branch: z.string().min(1),
        commit: z.string().regex(/^[a-f0-9]{7,64}$/),
      })
      .strict(),
  })
  .strict();

export const DataBundleShardDescriptorV1Schema = z
  .object({
    shardId: identifierSchema,
    kind: z.enum(["global", "faction"]),
    factionIds: z.array(identifierSchema),
    dependencyShardIds: z.array(identifierSchema),
    path: relativeBundlePathSchema,
    contentSha256: sha256Schema,
    semanticHash: sha256Schema,
    byteLength: z.number().int().nonnegative(),
    mediaType: z.literal(
      "application/vnd.rosterpilot.data-shard+json",
    ),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      descriptor.kind === "global" &&
      descriptor.factionIds.length !== 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["factionIds"],
        message: "A global shard cannot own faction data.",
      });
    }
    if (
      descriptor.kind === "faction" &&
      descriptor.factionIds.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["factionIds"],
        message: "A faction shard must own at least one faction.",
      });
    }
    if (
      new Set(descriptor.factionIds).size !==
      descriptor.factionIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["factionIds"],
        message: "A shard cannot repeat a faction id.",
      });
    }
    if (
      new Set(descriptor.dependencyShardIds).size !==
      descriptor.dependencyShardIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependencyShardIds"],
        message: "A shard cannot repeat a dependency.",
      });
    }
  });

export const DataBundleRetainedShardV1Schema = z
  .object({
    shardId: identifierSchema,
    sourceBundleId: sha256Schema,
    sourceContentSha256: sha256Schema,
    sourceSemanticHash: sha256Schema,
    scopes: z.array(z.string().min(1).max(256)).min(1),
    reason: z.string().min(1).max(4_000),
  })
  .strict()
  .superRefine((retained, context) => {
    if (new Set(retained.scopes).size !== retained.scopes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopes"],
        message: "Retained-shard quarantine scopes must be unique.",
      });
    }
  });

/**
 * A partial roll-forward is created only by the trusted publisher. The new
 * manifest signature covers both the effective shard inventory and the exact
 * verified bundle each retained shard came from, so readers never synthesize
 * an unsigned mixed snapshot.
 */
export const DataBundleCompositionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    strategy: z.literal("retain-verified-shards"),
    baseBundleId: sha256Schema,
    candidateDraftSha256: sha256Schema,
    retainedShards: z
      .array(DataBundleRetainedShardV1Schema)
      .min(1),
  })
  .strict()
  .superRefine((composition, context) => {
    const shardIds = composition.retainedShards.map(
      (entry) => entry.shardId,
    );
    if (new Set(shardIds).size !== shardIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedShards"],
        message: "A partial roll-forward cannot retain a shard twice.",
      });
    }
  });

const dataBundleManifestDraftObject = z
  .object({
    schemaVersion: z.literal(1),
    engineDataSchemaVersion: z.number().int().positive(),
    createdAt: z.string().datetime(),
    provenance: DataBundleProvenanceV1Schema,
    semanticHashes: DataBundleSemanticHashesV1Schema,
    shards: z.array(DataBundleShardDescriptorV1Schema).min(1),
    composition: DataBundleCompositionV1Schema.optional(),
  })
  .strict();

function validateManifestGraph(
  manifest: z.infer<typeof dataBundleManifestDraftObject>,
  context: z.RefinementCtx,
): void {
  const descriptors = new Map(
    manifest.shards.map((shard) => [shard.shardId, shard]),
  );
  if (descriptors.size !== manifest.shards.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shards"],
      message: "Bundle shard ids must be unique.",
    });
  }
  const globalShards = manifest.shards.filter(
    (shard) => shard.kind === "global",
  );
  if (globalShards.length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shards"],
      message: "A bundle must contain exactly one global shard.",
    });
  }

  const factionOwners = new Map<string, string>();
  for (const [index, shard] of manifest.shards.entries()) {
    for (const dependency of shard.dependencyShardIds) {
      if (dependency === shard.shardId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shards", index, "dependencyShardIds"],
          message: "A shard cannot depend on itself.",
        });
      } else if (!descriptors.has(dependency)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shards", index, "dependencyShardIds"],
          message: `Unknown dependency shard "${dependency}".`,
        });
      }
    }
    for (const factionId of shard.factionIds) {
      const previousOwner = factionOwners.get(factionId);
      if (previousOwner) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shards", index, "factionIds"],
          message: `Faction "${factionId}" is already owned by shard "${previousOwner}".`,
        });
      } else {
        factionOwners.set(factionId, shard.shardId);
      }
    }
  }

  for (const factionId of Object.keys(
    manifest.semanticHashes.factions,
  )) {
    if (!factionOwners.has(factionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["semanticHashes", "factions", factionId],
        message: `Faction "${factionId}" has no owning data shard.`,
      });
    }
  }
  for (const factionId of factionOwners.keys()) {
    if (!manifest.semanticHashes.factions[factionId]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["semanticHashes", "factions"],
        message: `Shard-owned faction "${factionId}" has no semantic inventory.`,
      });
    }
  }

  if (manifest.composition) {
    for (const [index, retained] of
      manifest.composition.retainedShards.entries()) {
      const descriptor = descriptors.get(retained.shardId);
      if (!descriptor) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            "composition",
            "retainedShards",
            index,
            "shardId",
          ],
          message: `Retained shard "${retained.shardId}" is not declared by the composed bundle.`,
        });
        continue;
      }
      if (descriptor.kind !== "faction") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            "composition",
            "retainedShards",
            index,
            "shardId",
          ],
          message:
            "Partial roll-forward may retain only faction shards; global or methodology changes must fail closed.",
        });
      }
      if (
        descriptor.contentSha256 !==
        retained.sourceContentSha256
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            "composition",
            "retainedShards",
            index,
            "sourceContentSha256",
          ],
          message:
            "Retained-shard lineage must match the effective signed content hash.",
        });
      }
      if (
        descriptor.semanticHash !== retained.sourceSemanticHash
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            "composition",
            "retainedShards",
            index,
            "sourceSemanticHash",
          ],
          message:
            "Retained-shard lineage must match the effective signed semantic hash.",
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (shardId: string): boolean => {
    if (visiting.has(shardId)) return false;
    if (visited.has(shardId)) return true;
    visiting.add(shardId);
    const descriptor = descriptors.get(shardId);
    for (const dependency of descriptor?.dependencyShardIds ?? []) {
      if (descriptors.has(dependency) && !visit(dependency)) return false;
    }
    visiting.delete(shardId);
    visited.add(shardId);
    return true;
  };
  for (const shardId of descriptors.keys()) {
    if (!visit(shardId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shards"],
        message: "Bundle shard dependencies must be acyclic.",
      });
      break;
    }
  }
}

export const DataBundleManifestDraftV1Schema =
  dataBundleManifestDraftObject.superRefine(validateManifestGraph);

export const DataBundleSignatureV1Schema = z
  .object({
    algorithm: z.string().min(1),
    keyId: keyIdSchema,
    value: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const DataBundleManifestV1Schema =
  dataBundleManifestDraftObject
    .extend({
      bundleId: sha256Schema,
      signature: DataBundleSignatureV1Schema,
    })
    .superRefine(validateManifestGraph);

export const DataBundleShardV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    shardId: identifierSchema,
    kind: z.enum(["global", "faction"]),
    factionIds: z.array(identifierSchema),
    data: z.unknown(),
  })
  .strict();

export const DataBundleChannelPointerDraftV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    channel: identifierSchema,
    bundleId: sha256Schema,
    manifestUrl: z.string().url(),
    publishedAt: z.string().datetime(),
  })
  .strict();

export const DataBundleChannelPointerV1Schema =
  DataBundleChannelPointerDraftV1Schema.extend({
    signature: DataBundleSignatureV1Schema,
  });

const DataBundleChannelPointerPreviousV2Schema = z
  .object({
    pointerSha256: sha256Schema,
    pointerUrl: z.string().url(),
  })
  .strict();

const DataBundleChannelTransitionV2Schema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("publish"),
        fromBundleId: sha256Schema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("rollback"),
        fromBundleId: sha256Schema,
        reasonCode: z.literal("LIVE_CANARY_FAILED"),
        quarantineRecordSha256: sha256Schema,
      })
      .strict(),
  ],
);

const dataBundleChannelPointerDraftV2Object = z
  .object({
    schemaVersion: z.literal(2),
    channel: identifierSchema,
    bundleId: sha256Schema,
    manifestUrl: z.string().url(),
    publishedAt: z.string().datetime(),
    revision: z.number().int().nonnegative(),
    previous: DataBundleChannelPointerPreviousV2Schema.nullable(),
    transition: DataBundleChannelTransitionV2Schema,
  })
  .strict();

function validateDataBundleChannelPointerV2(
  pointer: z.infer<typeof dataBundleChannelPointerDraftV2Object>,
  context: z.RefinementCtx,
): void {
  if ((pointer.revision === 0) !== (pointer.previous === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["previous"],
      message:
        "Channel revision zero must be the genesis pointer; every later revision must identify its predecessor.",
    });
  }
  if (
    pointer.previous === null &&
    (pointer.transition.kind !== "publish" ||
      pointer.transition.fromBundleId !== null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transition"],
      message:
        "A genesis channel pointer must be a publication with no source bundle.",
    });
  }
  if (
    pointer.transition.kind === "rollback" &&
    pointer.previous === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transition"],
      message: "A rollback must identify a preceding channel pointer.",
    });
  }
}

export const DataBundleChannelPointerDraftV2Schema =
  dataBundleChannelPointerDraftV2Object.superRefine(
    validateDataBundleChannelPointerV2,
  );

export const DataBundleChannelPointerV2Schema =
  dataBundleChannelPointerDraftV2Object
    .extend({
      signature: DataBundleSignatureV1Schema,
    })
    .superRefine(validateDataBundleChannelPointerV2);

export const DataBundleChannelPointerSchema = z.union([
  DataBundleChannelPointerV2Schema,
  DataBundleChannelPointerV1Schema,
]);

export const DataBundleChannelCursorV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    channel: identifierSchema,
    pointerSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    revision: z.number().int().nonnegative().nullable(),
    pointerSha256: sha256Schema,
    bundleId: sha256Schema,
    acceptedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((cursor, context) => {
    if (
      (cursor.pointerSchemaVersion === 1) !==
      (cursor.revision === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revision"],
        message:
          "Legacy channel cursors have no revision; version-two cursors require one.",
      });
    }
  });

const DataBundleCanaryEvidenceV1Schema = z
  .object({
    canaryId: identifierSchema,
    reportSha256: sha256Schema,
    status: z.enum(["pass", "fail", "unavailable"]),
  })
  .strict();

const dataBundleQuarantineRecordDraftObject = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal(
      "rosterpilot-data-bundle-channel-quarantine",
    ),
    channel: identifierSchema,
    bundleId: sha256Schema,
    semanticIdentitySha256: sha256Schema,
    rollbackBundleId: sha256Schema,
    reasonCode: z.literal("LIVE_CANARY_FAILED"),
    reason: z.string().min(1).max(4_000),
    scopes: z.array(z.string().min(1).max(256)).min(1),
    createdAt: z.string().datetime(),
    evidence: z.array(DataBundleCanaryEvidenceV1Schema).min(1),
  })
  .strict();

function validateQuarantineRecord(
  record: z.infer<typeof dataBundleQuarantineRecordDraftObject>,
  context: z.RefinementCtx,
): void {
  if (record.bundleId === record.rollbackBundleId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rollbackBundleId"],
        message:
          "A quarantine rollback target must differ from the failed bundle.",
      });
  }
  if (new Set(record.scopes).size !== record.scopes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopes"],
        message: "Quarantine scopes must be unique.",
      });
  }
  const canaryIds = record.evidence.map(
    (entry) => entry.canaryId,
  );
  if (new Set(canaryIds).size !== canaryIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message:
          "A quarantine record cannot repeat live-canary evidence.",
      });
  }
  if (
    !record.evidence.some((entry) => entry.status === "fail")
  ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message:
          "A live-canary quarantine requires at least one failed report.",
      });
  }
}

export const DataBundleQuarantineRecordDraftV1Schema =
  dataBundleQuarantineRecordDraftObject.superRefine(
    validateQuarantineRecord,
  );

export const DataBundleQuarantineRecordV1Schema =
  dataBundleQuarantineRecordDraftObject
    .extend({
      signature: DataBundleSignatureV1Schema,
    })
    .superRefine(validateQuarantineRecord);

export type DataBundleProvenanceV1 = z.infer<
  typeof DataBundleProvenanceV1Schema
>;
export type DataBundleShardDescriptorV1 = z.infer<
  typeof DataBundleShardDescriptorV1Schema
>;
export type DataBundleRetainedShardV1 = z.infer<
  typeof DataBundleRetainedShardV1Schema
>;
export type DataBundleCompositionV1 = z.infer<
  typeof DataBundleCompositionV1Schema
>;
export type DataBundleManifestDraftV1 = z.infer<
  typeof DataBundleManifestDraftV1Schema
>;
export type DataBundleSignatureV1 = z.infer<
  typeof DataBundleSignatureV1Schema
>;
export type DataBundleManifestV1 = z.infer<
  typeof DataBundleManifestV1Schema
>;
type ParsedDataBundleShardV1 = z.infer<
  typeof DataBundleShardV1Schema
>;
export type DataBundleShardV1<TData = unknown> = Omit<
  ParsedDataBundleShardV1,
  "data"
> & {
  data: TData;
};
export type DataBundleChannelPointerDraftV1 = z.infer<
  typeof DataBundleChannelPointerDraftV1Schema
>;
export type DataBundleChannelPointerV1 = z.infer<
  typeof DataBundleChannelPointerV1Schema
>;
export type DataBundleChannelPointerDraftV2 = z.infer<
  typeof DataBundleChannelPointerDraftV2Schema
>;
export type DataBundleChannelPointerV2 = z.infer<
  typeof DataBundleChannelPointerV2Schema
>;
export type DataBundleChannelPointer =
  | DataBundleChannelPointerV1
  | DataBundleChannelPointerV2;
export type DataBundleChannelPointerDraft =
  | DataBundleChannelPointerDraftV1
  | DataBundleChannelPointerDraftV2;
export type DataBundleChannelCursorV1 = z.infer<
  typeof DataBundleChannelCursorV1Schema
>;
export type DataBundleQuarantineRecordDraftV1 = z.infer<
  typeof DataBundleQuarantineRecordDraftV1Schema
>;
export type DataBundleQuarantineRecordV1 = z.infer<
  typeof DataBundleQuarantineRecordV1Schema
>;

declare const verifiedManifestBrand: unique symbol;
declare const verifiedShardBrand: unique symbol;
declare const verifiedChannelBrand: unique symbol;
declare const verifiedQuarantineBrand: unique symbol;

export type VerifiedDataBundleManifestV1 = DataBundleManifestV1 & {
  readonly [verifiedManifestBrand]: true;
};
export type VerifiedDataBundleShardV1<TData = unknown> =
  DataBundleShardV1<TData> & {
    readonly [verifiedShardBrand]: true;
  };
export type VerifiedDataBundleChannelPointerV1 =
  DataBundleChannelPointerV1 & {
    readonly [verifiedChannelBrand]: true;
  };
export type VerifiedDataBundleChannelPointerV2 =
  DataBundleChannelPointerV2 & {
    readonly [verifiedChannelBrand]: true;
  };
export type VerifiedDataBundleChannelPointer =
  | VerifiedDataBundleChannelPointerV1
  | VerifiedDataBundleChannelPointerV2;
export type VerifiedDataBundleQuarantineRecordV1 =
  DataBundleQuarantineRecordV1 & {
    readonly [verifiedQuarantineBrand]: true;
  };

export type Ed25519PrivateKey = CryptoKey | JsonWebKey;
export type Ed25519PublicKey = CryptoKey | JsonWebKey;
export type Ed25519KeyRegistry =
  | ReadonlyMap<string, Ed25519PublicKey>
  | Readonly<Record<string, Ed25519PublicKey>>;

export type DataBundleSigner = {
  keyId: string;
  privateKey: Ed25519PrivateKey;
};

export type DataBundleVerificationFailureCode =
  | "INVALID_MANIFEST"
  | "INVALID_CHANNEL_POINTER"
  | "INVALID_QUARANTINE_RECORD"
  | "UNSUPPORTED_SIGNATURE_ALGORITHM"
  | "BUNDLE_ID_MISMATCH"
  | "UNKNOWN_KEY_ID"
  | "INVALID_SIGNING_KEY"
  | "SIGNATURE_INVALID"
  | "SHARD_NOT_DECLARED"
  | "SHARD_IDENTITY_MISMATCH"
  | "SHARD_HASH_MISMATCH"
  | "SHARD_SEMANTIC_HASH_MISMATCH"
  | "SHARD_LENGTH_MISMATCH"
  | "BUNDLE_SEMANTIC_HASH_MISMATCH"
  | "CRYPTO_UNAVAILABLE";

export type DataBundleVerificationResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      code: DataBundleVerificationFailureCode;
      message: string;
    };

function isCryptoKey(value: Ed25519PrivateKey): value is CryptoKey {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "algorithm" in value &&
    "usages" in value
  );
}

function getWebCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is unavailable.");
  }
  return globalThis.crypto;
}

async function importSigningKey(
  key: Ed25519PrivateKey,
): Promise<CryptoKey> {
  if (isCryptoKey(key)) {
    if (
      key.type !== "private" ||
      key.algorithm.name !== "Ed25519" ||
      !key.usages.includes("sign")
    ) {
      throw new Error(
        "The signing key must be an Ed25519 private key with sign usage.",
      );
    }
    return key;
  }
  return getWebCrypto().subtle.importKey(
    "jwk",
    key,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

async function importVerificationKey(
  key: Ed25519PublicKey,
): Promise<CryptoKey> {
  if (isCryptoKey(key)) {
    if (
      key.type !== "public" ||
      key.algorithm.name !== "Ed25519" ||
      !key.usages.includes("verify")
    ) {
      throw new Error(
        "The verification key must be an Ed25519 public key with verify usage.",
      );
    }
    return key;
  }
  return getWebCrypto().subtle.importKey(
    "jwk",
    key,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8_192));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(
    value.replace(/-/g, "+").replace(/_/g, "/") + padding,
  );
  return Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  ).buffer;
}

async function signCanonicalPayload(
  payload: unknown,
  signer: DataBundleSigner,
): Promise<DataBundleSignatureV1> {
  const keyId = keyIdSchema.parse(signer.keyId);
  const key = await importSigningKey(signer.privateKey);
  const signature = await getWebCrypto().subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(canonicalJson(payload)),
  );
  return {
    algorithm: "Ed25519",
    keyId,
    value: encodeBase64Url(signature),
  };
}

function registryKey(
  registry: Ed25519KeyRegistry,
  keyId: string,
): Ed25519PublicKey | undefined {
  if (
    "get" in registry &&
    typeof registry.get === "function"
  ) {
    return registry.get(keyId);
  }
  return (registry as Readonly<Record<string, Ed25519PublicKey>>)[
    keyId
  ];
}

async function verifyCanonicalPayload(
  payload: unknown,
  signature: DataBundleSignatureV1,
  registry: Ed25519KeyRegistry,
): Promise<DataBundleVerificationResult<true>> {
  if (signature.algorithm !== "Ed25519") {
    return {
      ok: false,
      code: "UNSUPPORTED_SIGNATURE_ALGORITHM",
      message: `Unsupported data-bundle signature algorithm "${signature.algorithm}".`,
    };
  }
  const configuredKey = registryKey(registry, signature.keyId);
  if (!configuredKey) {
    return {
      ok: false,
      code: "UNKNOWN_KEY_ID",
      message: `No trusted data-bundle key is configured for key id "${signature.keyId}".`,
    };
  }
  try {
    const key = await importVerificationKey(configuredKey);
    let signatureBytes: ArrayBuffer;
    try {
      signatureBytes = decodeBase64Url(signature.value);
      if (
        signatureBytes.byteLength !== 64 ||
        encodeBase64Url(signatureBytes) !== signature.value
      ) {
        return {
          ok: false,
          code: "SIGNATURE_INVALID",
          message:
            "The data-bundle signature is not canonical Ed25519 data.",
        };
      }
    } catch {
      return {
        ok: false,
        code: "SIGNATURE_INVALID",
        message: "The data-bundle signature is not valid base64url data.",
      };
    }
    const valid = await getWebCrypto().subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      new TextEncoder().encode(canonicalJson(payload)),
    );
    return valid
      ? { ok: true, data: true }
      : {
          ok: false,
          code: "SIGNATURE_INVALID",
          message: "The data-bundle signature does not match its payload.",
        };
  } catch (error) {
    if (!globalThis.crypto?.subtle) {
      return {
        ok: false,
        code: "CRYPTO_UNAVAILABLE",
        message: "Web Crypto is unavailable for bundle verification.",
      };
    }
    return {
      ok: false,
      code: "INVALID_SIGNING_KEY",
      message: `The configured verification key is invalid: ${String(error)}`,
    };
  }
}

function manifestDraft(
  manifest: DataBundleManifestV1,
): DataBundleManifestDraftV1 {
  return {
    schemaVersion: manifest.schemaVersion,
    engineDataSchemaVersion: manifest.engineDataSchemaVersion,
    createdAt: manifest.createdAt,
    provenance: manifest.provenance,
    semanticHashes: manifest.semanticHashes,
    shards: manifest.shards,
    ...(manifest.composition
      ? { composition: manifest.composition }
      : {}),
  };
}

function manifestSignedPayload(
  manifest: Omit<DataBundleManifestV1, "signature">,
): Omit<DataBundleManifestV1, "signature"> {
  return manifest;
}

export async function createSignedDataBundleManifest(
  input: DataBundleManifestDraftV1,
  signer: DataBundleSigner,
): Promise<DataBundleManifestV1> {
  const draft = DataBundleManifestDraftV1Schema.parse(input);
  const bundleId = await sha256Hex(canonicalJson(draft));
  const unsigned = manifestSignedPayload({ ...draft, bundleId });
  const signature = await signCanonicalPayload(unsigned, signer);
  return DataBundleManifestV1Schema.parse({
    ...unsigned,
    signature,
  });
}

export async function verifyDataBundleManifest(
  input: unknown,
  registry: Ed25519KeyRegistry,
): Promise<
  DataBundleVerificationResult<VerifiedDataBundleManifestV1>
> {
  const parsed = DataBundleManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_MANIFEST",
      message: parsed.error.issues
        .map((issue) => issue.message)
        .join("; "),
    };
  }
  const manifest = parsed.data;
  const expectedBundleId = await sha256Hex(
    canonicalJson(manifestDraft(manifest)),
  );
  if (manifest.bundleId !== expectedBundleId) {
    return {
      ok: false,
      code: "BUNDLE_ID_MISMATCH",
      message:
        "The data-bundle id does not match the canonical manifest payload.",
    };
  }
  const {
    signature,
    ...unsigned
  } = manifest;
  const signatureResult = await verifyCanonicalPayload(
    unsigned,
    signature,
    registry,
  );
  if (!signatureResult.ok) return signatureResult;
  return {
    ok: true,
    data: deepFreeze(
      manifest,
    ) as VerifiedDataBundleManifestV1,
  };
}

function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export async function verifyDataBundleShard<TData = unknown>(
  manifest: VerifiedDataBundleManifestV1,
  input: unknown,
): Promise<
  DataBundleVerificationResult<VerifiedDataBundleShardV1<TData>>
> {
  const parsed = DataBundleShardV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "SHARD_IDENTITY_MISMATCH",
      message: parsed.error.issues
        .map((issue) => issue.message)
        .join("; "),
    };
  }
  const shard = parsed.data as DataBundleShardV1<TData>;
  const descriptor = manifest.shards.find(
    (candidate) => candidate.shardId === shard.shardId,
  );
  if (!descriptor) {
    return {
      ok: false,
      code: "SHARD_NOT_DECLARED",
      message: `Shard "${shard.shardId}" is not declared by bundle "${manifest.bundleId}".`,
    };
  }
  if (
    descriptor.kind !== shard.kind ||
    !sameStrings(descriptor.factionIds, shard.factionIds)
  ) {
    return {
      ok: false,
      code: "SHARD_IDENTITY_MISMATCH",
      message: `Shard "${shard.shardId}" does not match its signed descriptor identity.`,
    };
  }
  const expectedHash = await sha256Hex(canonicalJson(shard));
  if (descriptor.contentSha256 !== expectedHash) {
    return {
      ok: false,
      code: "SHARD_HASH_MISMATCH",
      message: `Shard "${shard.shardId}" does not match its signed content hash.`,
    };
  }
  const expectedSemanticHash = await semanticHash(shard.data);
  if (descriptor.semanticHash !== expectedSemanticHash) {
    return {
      ok: false,
      code: "SHARD_SEMANTIC_HASH_MISMATCH",
      message: `Shard "${shard.shardId}" does not match its signed semantic hash.`,
    };
  }
  if (descriptor.byteLength !== canonicalByteLength(shard)) {
    return {
      ok: false,
      code: "SHARD_LENGTH_MISMATCH",
      message: `Shard "${shard.shardId}" does not match its signed canonical byte length.`,
    };
  }
  return {
    ok: true,
    data: deepFreeze(shard) as VerifiedDataBundleShardV1<TData>,
  };
}

export async function createSignedDataBundleChannelPointer(
  input: DataBundleChannelPointerDraftV1,
  signer: DataBundleSigner,
): Promise<DataBundleChannelPointerV1>;
export async function createSignedDataBundleChannelPointer(
  input: DataBundleChannelPointerDraftV2,
  signer: DataBundleSigner,
): Promise<DataBundleChannelPointerV2>;
export async function createSignedDataBundleChannelPointer(
  input: DataBundleChannelPointerDraft,
  signer: DataBundleSigner,
): Promise<DataBundleChannelPointer>;
export async function createSignedDataBundleChannelPointer(
  input: DataBundleChannelPointerDraft,
  signer: DataBundleSigner,
): Promise<DataBundleChannelPointer> {
  const draft = (
    input.schemaVersion === 2
      ? DataBundleChannelPointerDraftV2Schema
      : DataBundleChannelPointerDraftV1Schema
  ).parse(input);
  return DataBundleChannelPointerSchema.parse({
    ...draft,
    signature: await signCanonicalPayload(draft, signer),
  });
}

export async function verifyDataBundleChannelPointer(
  input: unknown,
  registry: Ed25519KeyRegistry,
): Promise<
  DataBundleVerificationResult<VerifiedDataBundleChannelPointer>
> {
  const parsed = DataBundleChannelPointerSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_CHANNEL_POINTER",
      message: parsed.error.issues
        .map((issue) => issue.message)
        .join("; "),
    };
  }
  const {
    signature,
    ...unsigned
  } = parsed.data;
  const result = await verifyCanonicalPayload(
    unsigned,
    signature,
    registry,
  );
  if (!result.ok) return result;
  return {
    ok: true,
    data: deepFreeze(
      parsed.data,
    ) as VerifiedDataBundleChannelPointer,
  };
}

export async function dataBundleChannelPointerSha256(
  pointer: DataBundleChannelPointer,
): Promise<string> {
  return sha256Hex(
    canonicalJson(DataBundleChannelPointerSchema.parse(pointer)),
  );
}

export async function dataBundleSemanticIdentitySha256(
  manifest: Pick<DataBundleManifestV1, "semanticHashes">,
): Promise<string> {
  return sha256Hex(canonicalJson(manifest.semanticHashes));
}

export async function createSignedDataBundleQuarantineRecord(
  input: DataBundleQuarantineRecordDraftV1,
  signer: DataBundleSigner,
): Promise<DataBundleQuarantineRecordV1> {
  const draft =
    DataBundleQuarantineRecordDraftV1Schema.parse(input);
  return DataBundleQuarantineRecordV1Schema.parse({
    ...draft,
    signature: await signCanonicalPayload(draft, signer),
  });
}

export async function verifyDataBundleQuarantineRecord(
  input: unknown,
  registry: Ed25519KeyRegistry,
): Promise<
  DataBundleVerificationResult<VerifiedDataBundleQuarantineRecordV1>
> {
  const parsed =
    DataBundleQuarantineRecordV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_QUARANTINE_RECORD",
      message: parsed.error.issues
        .map((issue) => issue.message)
        .join("; "),
    };
  }
  const { signature, ...unsigned } = parsed.data;
  const result = await verifyCanonicalPayload(
    unsigned,
    signature,
    registry,
  );
  if (!result.ok) return result;
  return {
    ok: true,
    data: deepFreeze(
      parsed.data,
    ) as VerifiedDataBundleQuarantineRecordV1,
  };
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

class ImmutableReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    this.#entries.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  values(): MapIterator<V> {
    return this.#entries.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

export type DataBundleSnapshot<TShardData = unknown> = {
  readonly bundleId: string;
  readonly manifest: VerifiedDataBundleManifestV1;
  readonly acquiredAt: string;
  readonly shards: ReadonlyMap<
    string,
    VerifiedDataBundleShardV1<TShardData>
  >;
  getShard(
    shardId: string,
  ): VerifiedDataBundleShardV1<TShardData> | null;
  getFactionShard(
    factionId: string,
  ): VerifiedDataBundleShardV1<TShardData> | null;
};

export function createDataBundleSnapshot<TShardData>(
  manifest: VerifiedDataBundleManifestV1,
  inputShards: Iterable<VerifiedDataBundleShardV1<TShardData>>,
  options: {
    acquiredAt?: string;
  } = {},
): DataBundleSnapshot<TShardData> {
  const acquiredAt = z
    .string()
    .datetime()
    .parse(options.acquiredAt ?? new Date().toISOString());
  const shards = new Map<
    string,
    VerifiedDataBundleShardV1<TShardData>
  >();
  for (const shard of inputShards) {
    if (shards.has(shard.shardId)) {
      throw new Error(`Snapshot repeats shard "${shard.shardId}".`);
    }
    shards.set(shard.shardId, shard);
  }
  const expectedIds = new Set(
    manifest.shards.map((descriptor) => descriptor.shardId),
  );
  for (const shardId of shards.keys()) {
    if (!expectedIds.has(shardId)) {
      throw new Error(
        `Snapshot contains undeclared shard "${shardId}".`,
      );
    }
  }
  for (const shardId of expectedIds) {
    if (!shards.has(shardId)) {
      throw new Error(
        `Snapshot is missing declared shard "${shardId}".`,
      );
    }
  }

  const readonlyShards = new ImmutableReadonlyMap(shards.entries());
  const factionOwners = new Map<string, string>();
  for (const descriptor of manifest.shards) {
    for (const factionId of descriptor.factionIds) {
      factionOwners.set(factionId, descriptor.shardId);
    }
  }
  const snapshot: DataBundleSnapshot<TShardData> = {
    bundleId: manifest.bundleId,
    manifest,
    acquiredAt,
    shards: readonlyShards,
    getShard(shardId) {
      return readonlyShards.get(shardId) ?? null;
    },
    getFactionShard(factionId) {
      const shardId = factionOwners.get(factionId);
      return shardId ? (readonlyShards.get(shardId) ?? null) : null;
    },
  };
  return Object.freeze(snapshot);
}

export type DataBundleRefreshMode =
  | "disabled"
  | "request-driven"
  | "request-driven-wait-until"
  | "periodic-unref";

export type DataBundleOfficialAuthorityStatus =
  | {
      status: "verified";
      sourceArtifactSha256: string;
      overlaySha256: string;
      receiptSha256: string;
      extractorId: string;
      extractorKeyId: string;
    }
  | {
      status: "unavailable";
      reason: string;
    }
  | {
      status: "unverified-overlay";
      reason: string;
    };

export type DataBundleProviderStatus = {
  state:
    | "ready"
    | "checking"
    | "candidate-ready"
    | "degraded"
    | "offline";
  activeBundleId: string;
  latestVerifiedBundleId: string;
  latestUpstreamBundleId: string | null;
  candidate:
    | {
        bundleId: string;
        classification: DataBundleDeltaResult;
      }
    | null;
  quarantinedScopes: Array<{
    scope: string;
    bundleId: string;
    reason: string;
  }>;
  lastCheckedAt: string | null;
  officialAuthority?: DataBundleOfficialAuthorityStatus;
  refreshMode?: DataBundleRefreshMode;
  rollbackHold?: {
    bundleId: string;
    engagedAt: string;
    release: "force-refresh";
  } | null;
  durability?: {
    mode: "memory" | "persistent";
    state: "ready" | "degraded";
    reason: string | null;
  };
};

export type DataBundleSnapshotLease<TShardData = unknown> = {
  readonly leaseId: string;
  readonly snapshot: DataBundleSnapshot<TShardData>;
  readonly released: boolean;
  release(): void | Promise<void>;
};

export type AcquireDataBundleSnapshotOptions = {
  bundleId?: string;
  factionIds?: readonly string[];
  signal?: AbortSignal;
};

export type RefreshDataBundleOptions = {
  force?: boolean;
  signal?: AbortSignal;
};

export type RefreshDataBundleResult = {
  status: DataBundleProviderStatus;
  activatedBundleId: string | null;
  classification: DataBundleDeltaResult | null;
};

/**
 * Every transport acquires one lease before reading roster data. Providers may
 * refresh in the background, but a lease always retains one exact snapshot.
 */
export interface DataBundleProvider<TShardData = unknown> {
  acquireSnapshot(
    options?: AcquireDataBundleSnapshotOptions,
  ): Promise<DataBundleSnapshotLease<TShardData>>;
  getStatus(): Promise<DataBundleProviderStatus>;
  refresh(
    options?: RefreshDataBundleOptions,
  ): Promise<RefreshDataBundleResult>;
  rollback(bundleId: string): Promise<DataBundleProviderStatus>;
  /**
   * Optional durable retention hooks for providers backed by an archive.
   * Snapshot leases protect in-flight work; references protect persisted
   * rosters and jobs until their owner explicitly releases them.
   */
  retainReference?(
    referenceId: string,
    bundleId: string,
  ): Promise<void>;
  releaseReference?(
    referenceId: string,
    bundleId?: string,
  ): Promise<void>;
}
