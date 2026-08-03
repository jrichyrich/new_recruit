import { z } from "zod";

import {
  DataBundleProvenanceV1Schema,
  type AcceptedDataBundleEvidenceIdentity,
  type DataBundleProvenanceV1,
} from "../../lib/rosterpilot/data-bundle";
import {
  canonicalJson,
  sha256Hex,
  type DataBundleDeltaClassification,
} from "../../lib/rosterpilot/semantic-hash";

const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest.");

const safeRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      value
        .split("/")
        .every(
          (part) => part !== "" && part !== "." && part !== "..",
        ),
    "Expected a safe relative bundle path.",
  );

const deltaClassificationSchema: z.ZodType<DataBundleDeltaClassification> =
  z.enum([
    "provenance-only",
    "mapping-only",
    "rules",
    "methodology/global",
    "ambiguous/regressive",
  ]);

export const LocalDataBundleReceiptShardV1Schema = z
  .object({
    shardId: z.string().min(1).max(160),
    path: safeRelativePathSchema,
    contentSha256: sha256Schema,
    semanticHash: sha256Schema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

const npmSha512IntegritySchema = z
  .string()
  .regex(
    /^sha512-[A-Za-z0-9+/]{86}==$/,
    "Expected one canonical npm SHA-512 integrity digest.",
  );

const localSourceValidationCheckV1Schema = z
  .object({
    checkId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    scope: z.string().min(1).max(256),
    status: z.literal("passed"),
    evidenceSha256: sha256Schema,
  })
  .strict();

const localDataBundleIntegrityReceiptDraftV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptKind: z.literal(
      "rosterpilot-local-data-bundle-integrity",
    ),
    bundleId: sha256Schema,
    installedAt: z.string().datetime(),
    manifestSha256: sha256Schema,
    signing: z
      .object({
        algorithm: z.literal("Ed25519"),
        keyId: z.string().min(1).max(128),
      })
      .strict(),
    source: z
      .object({
        channel: z.string().min(1).max(160).nullable(),
        channelPointerSha256: sha256Schema.nullable(),
      })
      .strict(),
    acceptance: z
      .object({
        classification: deltaClassificationSchema.nullable(),
        certificationStatus: z.enum([
          "not-required",
          "pending",
          "passed",
          "failed",
          "quarantined",
        ]),
        certificationEvidenceSha256: sha256Schema.nullable(),
      })
      .strict(),
    shards: z.array(LocalDataBundleReceiptShardV1Schema),
  })
  .strict();

export const LocalDataBundleIntegrityReceiptV1Schema =
  localDataBundleIntegrityReceiptDraftV1Schema
    .extend({
      integritySha256: sha256Schema,
    })
  .superRefine((receipt, context) => {
    const shardIds = receipt.shards.map((shard) => shard.shardId);
    if (new Set(shardIds).size !== shardIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shards"],
        message: "An integrity receipt cannot repeat a shard id.",
      });
    }
    const paths = receipt.shards.map((shard) => shard.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shards"],
        message: "An integrity receipt cannot repeat a shard path.",
      });
    }
  });

const localSourceDataBundleReceiptDraftV1Object = z
  .object({
    schemaVersion: z.literal(1),
    receiptKind: z.literal(
      "rosterpilot-local-source-data-bundle",
    ),
    trustOrigin: z.literal("locally-verified"),
    bundleId: sha256Schema,
    installedAt: z.string().datetime(),
    manifestSha256: sha256Schema,
    parentBundleId: sha256Schema.nullable(),
    engineDataSchemaVersion: z.number().int().positive(),
    signing: z
      .object({
        algorithm: z.literal("none"),
        keyId: z.literal("local-source"),
      })
      .strict(),
    source: z
      .object({
        channel: z.null(),
        channelPointerSha256: z.null(),
        provenance: DataBundleProvenanceV1Schema,
        rulesPackageIntegrity: npmSha512IntegritySchema,
      })
      .strict(),
    builder: z
      .object({
        builderId: z
          .string()
          .min(1)
          .max(160)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        builderVersion: z.string().min(1).max(160),
        sourceSha256: sha256Schema,
      })
      .strict(),
    acceptance: z
      .object({
        classification: deltaClassificationSchema,
        certificationStatus: z.literal("passed"),
        certificationEvidenceSha256: sha256Schema,
      })
      .strict(),
    validation: z
      .object({
        planId: z
          .string()
          .min(1)
          .max(160)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        planSha256: sha256Schema,
        scopes: z.array(z.string().min(1).max(256)).min(1),
        checks: z.array(localSourceValidationCheckV1Schema).min(1),
      })
      .strict(),
    shards: z.array(LocalDataBundleReceiptShardV1Schema).min(1),
  })
  .strict();

function validateLocalSourceReceipt(
  receipt: z.infer<
    typeof localSourceDataBundleReceiptDraftV1Object
  >,
  context: z.RefinementCtx,
): void {
  if (receipt.parentBundleId === receipt.bundleId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["parentBundleId"],
      message: "A local build cannot name itself as its parent snapshot.",
    });
  }
  const shardIds = receipt.shards.map((shard) => shard.shardId);
  if (new Set(shardIds).size !== shardIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shards"],
      message: "A local build receipt cannot repeat a shard id.",
    });
  }
  const paths = receipt.shards.map((shard) => shard.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shards"],
      message: "A local build receipt cannot repeat a shard path.",
    });
  }
  if (
    new Set(receipt.validation.scopes).size !==
    receipt.validation.scopes.length
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["validation", "scopes"],
      message: "Local validation scopes must be unique.",
    });
  }
  const checkIds = receipt.validation.checks.map(
    (check) => check.checkId,
  );
  if (new Set(checkIds).size !== checkIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["validation", "checks"],
      message: "A local validation plan cannot repeat a check id.",
    });
  }
}

const localSourceDataBundleReceiptDraftV1Schema =
  localSourceDataBundleReceiptDraftV1Object.superRefine(
    validateLocalSourceReceipt,
  );

export const LocalSourceDataBundleReceiptV1Schema =
  localSourceDataBundleReceiptDraftV1Object
    .extend({ integritySha256: sha256Schema })
    .superRefine(validateLocalSourceReceipt);

export type LocalDataBundleReceiptShardV1 = z.infer<
  typeof LocalDataBundleReceiptShardV1Schema
>;

export type LocalDataBundleIntegrityReceiptV1 = z.infer<
  typeof LocalDataBundleIntegrityReceiptV1Schema
>;

export type LocalSourceDataBundleReceiptV1 = z.infer<
  typeof LocalSourceDataBundleReceiptV1Schema
>;

export type LocalSourceDataBundleReceiptDraftV1 = Omit<
  LocalSourceDataBundleReceiptV1,
  "integritySha256"
>;

export type StoredLocalDataBundleReceiptV1 =
  | LocalDataBundleIntegrityReceiptV1
  | LocalSourceDataBundleReceiptV1;

export type LocalDataBundleIntegrityReceiptDraftV1 = Omit<
  LocalDataBundleIntegrityReceiptV1,
  "integritySha256"
>;

export type LocalDataBundleReceiptVerification =
  | {
      ok: true;
      receipt: LocalDataBundleIntegrityReceiptV1;
    }
  | {
      ok: false;
      code:
        | "INVALID_RECEIPT"
        | "RECEIPT_INTEGRITY_MISMATCH"
        | "RECEIPT_BINDING_MISMATCH";
      message: string;
    };

export type ExpectedLocalDataBundleReceiptIdentity = {
  bundleId: string;
  manifestSha256: string;
  signing: {
    algorithm: "Ed25519";
    keyId: string;
  };
  shards: readonly LocalDataBundleReceiptShardV1[];
};

export type ExpectedLocalSourceDataBundleReceiptIdentity = {
  bundleId: string;
  manifestSha256: string;
  engineDataSchemaVersion: number;
  provenance: DataBundleProvenanceV1;
  shards: readonly LocalDataBundleReceiptShardV1[];
};

function withoutIntegrity(
  receipt: LocalDataBundleIntegrityReceiptV1,
): LocalDataBundleIntegrityReceiptDraftV1 {
  const draft = {
    ...receipt,
  } as Partial<LocalDataBundleIntegrityReceiptV1>;
  delete draft.integritySha256;
  return draft as LocalDataBundleIntegrityReceiptDraftV1;
}

function sameShardReceipts(
  left: readonly LocalDataBundleReceiptShardV1[],
  right: readonly LocalDataBundleReceiptShardV1[],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function withoutLocalSourceIntegrity(
  receipt: LocalSourceDataBundleReceiptV1,
): LocalSourceDataBundleReceiptDraftV1 {
  const draft = {
    ...receipt,
  } as Partial<LocalSourceDataBundleReceiptV1>;
  delete draft.integritySha256;
  return draft as LocalSourceDataBundleReceiptDraftV1;
}

export async function createLocalDataBundleIntegrityReceipt(
  input: LocalDataBundleIntegrityReceiptDraftV1,
): Promise<LocalDataBundleIntegrityReceiptV1> {
  const draft =
    localDataBundleIntegrityReceiptDraftV1Schema.parse(input);
  return LocalDataBundleIntegrityReceiptV1Schema.parse({
    ...draft,
    integritySha256: await sha256Hex(canonicalJson(draft)),
  });
}

export async function verifyLocalDataBundleIntegrityReceipt(
  input: unknown,
  expected?: ExpectedLocalDataBundleReceiptIdentity,
): Promise<LocalDataBundleReceiptVerification> {
  const parsed =
    LocalDataBundleIntegrityReceiptV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_RECEIPT",
      message: parsed.error.issues
        .map((issue) => issue.message)
        .join("; "),
    };
  }
  const receipt = parsed.data;
  const actualIntegrity = await sha256Hex(
    canonicalJson(withoutIntegrity(receipt)),
  );
  if (receipt.integritySha256 !== actualIntegrity) {
    return {
      ok: false,
      code: "RECEIPT_INTEGRITY_MISMATCH",
      message:
        "The local data-bundle receipt does not match its integrity digest.",
    };
  }
  if (
    expected &&
    (receipt.bundleId !== expected.bundleId ||
      receipt.manifestSha256 !== expected.manifestSha256 ||
      receipt.signing.algorithm !== expected.signing.algorithm ||
      receipt.signing.keyId !== expected.signing.keyId ||
      !sameShardReceipts(receipt.shards, expected.shards))
  ) {
    return {
      ok: false,
      code: "RECEIPT_BINDING_MISMATCH",
      message:
        "The local data-bundle receipt is not bound to the verified manifest and shard inventory.",
    };
  }
  return {
    ok: true,
    receipt,
  };
}

export async function createLocalSourceDataBundleReceipt(
  input: LocalSourceDataBundleReceiptDraftV1,
): Promise<LocalSourceDataBundleReceiptV1> {
  const draft = localSourceDataBundleReceiptDraftV1Schema.parse(input);
  return LocalSourceDataBundleReceiptV1Schema.parse({
    ...draft,
    integritySha256: await sha256Hex(canonicalJson(draft)),
  });
}

export async function verifyLocalSourceDataBundleReceipt(
  input: unknown,
  expected: ExpectedLocalSourceDataBundleReceiptIdentity,
): Promise<
  | LocalDataBundleReceiptVerification
  | {
      ok: true;
      receipt: LocalSourceDataBundleReceiptV1;
    }
> {
  const parsed = LocalSourceDataBundleReceiptV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_RECEIPT",
      message: parsed.error.issues
        .map((issue) => issue.message)
        .join("; "),
    };
  }
  const receipt = parsed.data;
  const actualIntegrity = await sha256Hex(
    canonicalJson(withoutLocalSourceIntegrity(receipt)),
  );
  if (receipt.integritySha256 !== actualIntegrity) {
    return {
      ok: false,
      code: "RECEIPT_INTEGRITY_MISMATCH",
      message:
        "The local-source build receipt does not match its integrity digest.",
    };
  }
  if (
    receipt.bundleId !== expected.bundleId ||
    receipt.manifestSha256 !== expected.manifestSha256 ||
    receipt.engineDataSchemaVersion !==
      expected.engineDataSchemaVersion ||
    canonicalJson(receipt.source.provenance) !==
      canonicalJson(expected.provenance) ||
    !sameShardReceipts(receipt.shards, expected.shards)
  ) {
    return {
      ok: false,
      code: "RECEIPT_BINDING_MISMATCH",
      message:
        "The local-source build receipt is not bound to the exact manifest, source provenance, engine schema, and shard inventory.",
    };
  }
  return { ok: true, receipt };
}

export function storedReceiptTrustOrigin(
  receipt: StoredLocalDataBundleReceiptV1,
): "signed-verified" | "locally-verified" {
  return receipt.receiptKind ===
    "rosterpilot-local-source-data-bundle"
    ? "locally-verified"
    : "signed-verified";
}

export function acceptedDataBundleEvidenceIdentity(
  receipt: StoredLocalDataBundleReceiptV1,
): AcceptedDataBundleEvidenceIdentity {
  if (
    receipt.receiptKind ===
    "rosterpilot-local-source-data-bundle"
  ) {
    return {
      kind: "local-receipt",
      manifestSha256: receipt.manifestSha256,
      receiptIntegritySha256: receipt.integritySha256,
      builderId: receipt.builder.builderId,
      builderSourceSha256: receipt.builder.sourceSha256,
    };
  }
  return {
    kind: "signed",
    manifestSha256: receipt.manifestSha256,
    receiptIntegritySha256: receipt.integritySha256,
    signingKeyId: receipt.signing.keyId,
  };
}
