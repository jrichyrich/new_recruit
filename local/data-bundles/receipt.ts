import { z } from "zod";

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

export type LocalDataBundleReceiptShardV1 = z.infer<
  typeof LocalDataBundleReceiptShardV1Schema
>;

export type LocalDataBundleIntegrityReceiptV1 = z.infer<
  typeof LocalDataBundleIntegrityReceiptV1Schema
>;

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
