import crypto from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  createLocalDataBundleManifest,
  DataBundleManifestDraftV1Schema,
  DataBundleShardV1Schema,
  verifyLocalDataBundleManifest,
  type DataBundleManifestDraftV1,
  type LocalDataBundleManifestV1,
  type DataBundleShardV1,
} from "../../lib/rosterpilot/data-bundle";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
  type DataBundleDeltaClassification,
} from "../../lib/rosterpilot/semantic-hash";
import type {
  RuntimeDataBundleBuild,
  RuntimeDataBundleShardDataV1,
} from "../../lib/rosterpilot/runtime-data-bundle";
import {
  createLocalSourceDataBundleReceipt,
  verifyLocalSourceDataBundleReceipt,
  type LocalSourceDataBundleReceiptV1,
} from "./receipt";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BSDATA_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const sha256Schema = z.string().regex(SHA256_PATTERN);
const safeRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      value
        .split("/")
        .every(
          (part) => part !== "" && part !== "." && part !== "..",
        ),
    "Expected a safe relative path.",
  );

const classificationSchema = z.enum([
  "bootstrap",
  "provenance-only",
  "mapping-only",
  "rules",
  "methodology/global",
]);

const validationPlanSchema = z
  .object({
    runDataCheck: z.boolean(),
    syncCertificationManifest: z.boolean(),
    certificationFactions: z.array(z.string().min(1).max(160)),
    fullCertification: z.boolean(),
    includePortfolio: z.boolean(),
  })
  .strict();

export const LocalSourceObservationV1Schema = z
  .object({
    checkedAt: z.string().datetime(),
    rules: z
      .object({
        package: z.literal("@alpaca-software/40kdc-data"),
        version: z.string().min(1).max(128),
        registryUrl: z.literal(
          "https://registry.npmjs.org/@alpaca-software%2F40kdc-data/latest",
        ),
        distIntegrity: z
          .string()
          .regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
        tarballUrl: z.string().url(),
      })
      .strict(),
    newRecruit: z
      .object({
        repository: z.literal("BSData/wh40k-11e"),
        url: z.literal("https://github.com/BSData/wh40k-11e.git"),
        branch: z.literal("main"),
        commit: z.string().regex(BSDATA_COMMIT_PATTERN),
        latestCommit: z.string().regex(BSDATA_COMMIT_PATTERN),
      })
      .strict(),
    official: z
      .object({
        downloadsUrl: z.literal(
          "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/",
        ),
        mfmUrl: z.literal("https://mfm.warhammer-community.com/en"),
        observedVersion: z.string().min(1).max(128).nullable(),
        observedContentSha256: sha256Schema.nullable(),
        retainedVersion: z.string().min(1).max(128),
        retainedContentSha256: sha256Schema,
        disposition: z.enum([
          "current",
          "update-pending",
          "unknown",
        ]),
      })
      .strict(),
  })
  .strict();

const builderFileSchema = z
  .object({
    path: safeRelativePathSchema,
    sha256: sha256Schema,
  })
  .strict();

const evidenceSchema = z
  .object({
    stage: z.enum([
      "fetch",
      "build",
      "schema",
      "mapping",
      "export-smoke",
      "certification",
    ]),
    status: z.literal("passed"),
    path: safeRelativePathSchema,
    sha256: sha256Schema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

const shardReceiptSchema = z
  .object({
    shardId: z.string().min(1).max(160),
    path: safeRelativePathSchema,
    contentSha256: sha256Schema,
    semanticHash: sha256Schema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

const localSourceBuildEvidenceDraftObject = z
  .object({
    schemaVersion: z.literal(1),
    evidenceKind: z.literal("rosterpilot-local-source-build-evidence"),
    bundleId: sha256Schema,
    createdAt: z.string().datetime(),
    parentBundleId: sha256Schema.nullable(),
    manifestSha256: sha256Schema,
    engineDataSchemaVersion: z.number().int().positive(),
    sources: LocalSourceObservationV1Schema,
    builder: z
      .object({
        nodeVersion: z.string().min(1).max(128),
        sourceSha256: sha256Schema,
        files: z.array(builderFileSchema).min(1),
      })
      .strict(),
    validation: z
      .object({
        status: z.literal("passed"),
        classification: classificationSchema,
        affectedFactions: z.array(z.string().min(1).max(160)),
        plan: validationPlanSchema,
        evidenceSha256: sha256Schema,
        evidence: z.array(evidenceSchema).min(1),
      })
      .strict(),
    shards: z.array(shardReceiptSchema).min(1),
  })
  .strict();

function refineLocalSourceBuildReceipt(
  receipt: z.infer<typeof localSourceBuildEvidenceDraftObject>,
  context: z.RefinementCtx,
): void {
    const unique = <T>(items: readonly T[]) =>
      new Set(items).size === items.length;
    if (!unique(receipt.builder.files.map((entry) => entry.path))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["builder", "files"],
        message: "Builder source paths must be unique.",
      });
    }
    if (!unique(receipt.validation.affectedFactions)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validation", "affectedFactions"],
        message: "Affected factions must be unique.",
      });
    }
    if (!unique(receipt.validation.evidence.map((entry) => entry.path))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validation", "evidence"],
        message: "Validation evidence paths must be unique.",
      });
    }
    if (!unique(receipt.shards.map((entry) => entry.shardId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shards"],
        message: "Shard ids must be unique.",
      });
    }
}

const localSourceBuildEvidenceDraftSchema =
  localSourceBuildEvidenceDraftObject.superRefine(
    refineLocalSourceBuildReceipt,
  );

export const LocalSourceBuildEvidenceDocumentV1Schema =
  localSourceBuildEvidenceDraftObject
    .extend({ integritySha256: sha256Schema })
    .superRefine(
      (receipt, context) =>
        refineLocalSourceBuildReceipt(receipt, context),
  );

export type LocalSourceObservationV1 = z.infer<
  typeof LocalSourceObservationV1Schema
>;

export type LocalSourceValidationPlanV1 = z.infer<
  typeof validationPlanSchema
>;

export type LocalSourceBuildEvidenceV1 = z.infer<
  typeof evidenceSchema
>;

export type LocalSourceBuildEvidenceDocumentV1 = z.infer<
  typeof LocalSourceBuildEvidenceDocumentV1Schema
>;

export type LocalSourceBuildReceiptV1 =
  LocalSourceDataBundleReceiptV1;

export type LocalSourceDataBundleManifestV1 =
  LocalDataBundleManifestV1;

export type LocalSourceCandidateReference = {
  bundleId: string;
  directory: string;
  manifestPath: string;
  receiptPath: string;
  classification:
    | Exclude<DataBundleDeltaClassification, "ambiguous/regressive">
    | "bootstrap";
  affectedFactions: string[];
};

export type VerifiedLocalSourceCandidate = {
  reference: LocalSourceCandidateReference;
  manifest: LocalSourceDataBundleManifestV1;
  manifestDraft: DataBundleManifestDraftV1;
  shards: ReadonlyMap<
    string,
    DataBundleShardV1<RuntimeDataBundleShardDataV1>
  >;
  receipt: LocalSourceBuildReceiptV1;
  buildEvidence: LocalSourceBuildEvidenceDocumentV1;
};

export type LocalSourceEvidenceFile = {
  stage: LocalSourceBuildEvidenceV1["stage"];
  filename: string;
};

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, stableJson(value), { flag: "wx" });
}

async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(filename, "utf8")) as unknown;
}

function buildEvidenceDraft(
  evidence: LocalSourceBuildEvidenceDocumentV1,
): Omit<LocalSourceBuildEvidenceDocumentV1, "integritySha256"> {
  const { integritySha256: _integritySha256, ...draft } = evidence;
  void _integritySha256;
  return draft;
}

async function canonicalByteLength(value: unknown): Promise<number> {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

async function hashFile(filename: string): Promise<{
  sha256: string;
  byteLength: number;
}> {
  const bytes = await readFile(filename);
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

async function assertRegularFile(filename: string): Promise<void> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Local-source candidate evidence must be a regular file: ${filename}.`,
    );
  }
}

async function builderInventory(
  root: string,
  relativePaths: readonly string[],
): Promise<Array<{ path: string; sha256: string }>> {
  const uniquePaths = [...new Set(relativePaths)].sort();
  const files: Array<{ path: string; sha256: string }> = [];
  for (const relativePath of uniquePaths) {
    const safePath = safeRelativePathSchema.parse(
      relativePath.split(path.sep).join("/"),
    );
    const filename = path.join(root, ...safePath.split("/"));
    await assertRegularFile(filename);
    files.push({
      path: safePath,
      sha256: (await hashFile(filename)).sha256,
    });
  }
  return files;
}

async function verifyArtifacts(
  directory: string,
): Promise<{
  manifest: LocalSourceDataBundleManifestV1;
  manifestDraft: DataBundleManifestDraftV1;
  shards: Map<
    string,
    DataBundleShardV1<RuntimeDataBundleShardDataV1>
  >;
  shardReceipts: Array<z.infer<typeof shardReceiptSchema>>;
  manifestSha256: string;
}> {
  const manifestPath = path.join(directory, "manifest.json");
  await assertRegularFile(manifestPath);
  const manifestResult = await verifyLocalDataBundleManifest(
    await readJson(manifestPath),
  );
  if (!manifestResult.ok) {
    throw new Error(
      `The local-source manifest failed verification: ${manifestResult.message}`,
    );
  }
  const manifest = manifestResult.data;
  const { bundleId: _bundleId, ...manifestDraft } = manifest;
  void _bundleId;
  const shards = new Map<
    string,
    DataBundleShardV1<RuntimeDataBundleShardDataV1>
  >();
  const shardReceipts: Array<z.infer<typeof shardReceiptSchema>> = [];
  for (const descriptor of manifest.shards) {
    const filename = path.join(
      directory,
      ...descriptor.path.split("/"),
    );
    await assertRegularFile(filename);
    const shard = DataBundleShardV1Schema.parse(
      await readJson(filename),
    ) as DataBundleShardV1<RuntimeDataBundleShardDataV1>;
    if (
      shard.shardId !== descriptor.shardId ||
      shard.kind !== descriptor.kind ||
      canonicalJson(shard.factionIds) !==
        canonicalJson(descriptor.factionIds)
    ) {
      throw new Error(
        `Local-source shard ${descriptor.shardId} does not match its descriptor.`,
      );
    }
    const contentSha256 = await sha256Hex(canonicalJson(shard));
    const shardSemanticHash = await semanticHash(shard.data);
    const byteLength = await canonicalByteLength(shard);
    if (
      contentSha256 !== descriptor.contentSha256 ||
      shardSemanticHash !== descriptor.semanticHash ||
      byteLength !== descriptor.byteLength
    ) {
      throw new Error(
        `Local-source shard ${descriptor.shardId} failed content, semantic, or length verification.`,
      );
    }
    shards.set(descriptor.path, shard);
    shardReceipts.push({
      shardId: descriptor.shardId,
      path: descriptor.path,
      contentSha256,
      semanticHash: shardSemanticHash,
      byteLength,
    });
  }
  return {
    manifest,
    manifestDraft,
    shards,
    shardReceipts,
    manifestSha256: await sha256Hex(canonicalJson(manifest)),
  };
}

export async function writeLocalSourceBundleArtifacts(
  build: RuntimeDataBundleBuild,
  outputDirectory: string,
): Promise<LocalSourceCandidateReference> {
  const draft = DataBundleManifestDraftV1Schema.parse(build.draft);
  const manifest = await createLocalDataBundleManifest(draft);
  const bundleId = manifest.bundleId;
  await mkdir(outputDirectory, { recursive: true });
  const entries = await readdir(outputDirectory);
  if (entries.length > 0) {
    throw new Error(
      `Local-source artifact directory must be empty: ${outputDirectory}.`,
    );
  }
  for (const shard of build.shards) {
    const descriptor = draft.shards.find(
      (entry) => entry.shardId === shard.shardId,
    );
    if (!descriptor) {
      throw new Error(
        `Runtime build omitted a descriptor for ${shard.shardId}.`,
      );
    }
    await writeJson(
      path.join(outputDirectory, ...descriptor.path.split("/")),
      shard,
    );
  }
  await writeJson(path.join(outputDirectory, "manifest.json"), manifest);
  await verifyArtifacts(outputDirectory);
  return {
    bundleId,
    directory: outputDirectory,
    manifestPath: path.join(outputDirectory, "manifest.json"),
    receiptPath: path.join(outputDirectory, "local-build-receipt.json"),
    classification: "bootstrap",
    affectedFactions: [],
  };
}

export async function publishLocalSourceCandidate(input: {
  artifactsDirectory: string;
  destinationRoot: string;
  sources: LocalSourceObservationV1;
  builderRoot: string;
  builderFiles: readonly string[];
  validation: {
    classification:
      | Exclude<DataBundleDeltaClassification, "ambiguous/regressive">
      | "bootstrap";
    affectedFactions: readonly string[];
    plan: LocalSourceValidationPlanV1;
    evidenceFiles: readonly LocalSourceEvidenceFile[];
  };
  parentBundleId?: string | null;
  now?: () => Date;
}): Promise<LocalSourceCandidateReference> {
  const artifacts = await verifyArtifacts(input.artifactsDirectory);
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const builderFiles = await builderInventory(
    input.builderRoot,
    input.builderFiles,
  );
  const builderSourceSha256 = await sha256Hex(
    canonicalJson(builderFiles),
  );
  const destinationRoot = path.resolve(input.destinationRoot);
  await mkdir(destinationRoot, { recursive: true });
  const temporaryDirectory = path.join(
    destinationRoot,
    `.candidate-${artifacts.manifest.bundleId}-${crypto.randomUUID()}`,
  );
  const destinationDirectory = path.join(
    destinationRoot,
    artifacts.manifest.bundleId,
  );
  try {
    await cp(input.artifactsDirectory, temporaryDirectory, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const evidence: LocalSourceBuildEvidenceV1[] = [];
    const evidenceDirectory = path.join(temporaryDirectory, "evidence");
    await mkdir(evidenceDirectory, { recursive: true });
    for (const [index, entry] of input.validation.evidenceFiles.entries()) {
      await assertRegularFile(entry.filename);
      const basename = `${String(index + 1).padStart(3, "0")}-${path.basename(entry.filename)}`;
      const relativePath = `evidence/${basename}`;
      await cp(entry.filename, path.join(temporaryDirectory, relativePath), {
        errorOnExist: true,
        force: false,
      });
      const hashed = await hashFile(
        path.join(temporaryDirectory, relativePath),
      );
      evidence.push({
        stage: entry.stage,
        status: "passed",
        path: relativePath,
        sha256: hashed.sha256,
        byteLength: hashed.byteLength,
      });
    }
    const evidenceSha256 = await sha256Hex(canonicalJson(evidence));
    const buildEvidenceDraft = localSourceBuildEvidenceDraftSchema.parse({
      schemaVersion: 1,
      evidenceKind: "rosterpilot-local-source-build-evidence",
      bundleId: artifacts.manifest.bundleId,
      createdAt,
      parentBundleId: input.parentBundleId ?? null,
      manifestSha256: artifacts.manifestSha256,
      engineDataSchemaVersion:
        artifacts.manifest.engineDataSchemaVersion,
      sources: LocalSourceObservationV1Schema.parse(input.sources),
      builder: {
        nodeVersion: process.version,
        sourceSha256: builderSourceSha256,
        files: builderFiles,
      },
      validation: {
        status: "passed",
        classification: input.validation.classification,
        affectedFactions: [
          ...new Set(input.validation.affectedFactions),
        ].sort(),
        plan: input.validation.plan,
        evidenceSha256,
        evidence,
      },
      shards: artifacts.shardReceipts,
    });
    const buildEvidence = LocalSourceBuildEvidenceDocumentV1Schema.parse({
      ...buildEvidenceDraft,
      integritySha256: await sha256Hex(
        canonicalJson(buildEvidenceDraft),
      ),
    });
    await writeJson(
      path.join(temporaryDirectory, "local-build-evidence.json"),
      buildEvidence,
    );
    const validationScopes = [
      ...new Set(
        input.validation.affectedFactions.length > 0
          ? input.validation.affectedFactions.map(
              (factionId) => `faction:${factionId}`,
            )
          : ["global"],
      ),
    ].sort();
    const planSha256 = await sha256Hex(
      canonicalJson(input.validation.plan),
    );
    const receipt = await createLocalSourceDataBundleReceipt({
      schemaVersion: 1,
      receiptKind: "rosterpilot-local-source-data-bundle",
      trustOrigin: "locally-verified",
      bundleId: artifacts.manifest.bundleId,
      installedAt: createdAt,
      manifestSha256: artifacts.manifestSha256,
      parentBundleId: input.parentBundleId ?? null,
      engineDataSchemaVersion:
        artifacts.manifest.engineDataSchemaVersion,
      signing: {
        algorithm: "none",
        keyId: "local-source",
      },
      source: {
        channel: null,
        channelPointerSha256: null,
        provenance: artifacts.manifest.provenance,
        rulesPackageIntegrity: input.sources.rules.distIntegrity,
      },
      builder: {
        builderId: "rosterpilot-local-source-builder",
        builderVersion: "1",
        sourceSha256: builderSourceSha256,
      },
      acceptance: {
        classification:
          input.validation.classification === "bootstrap"
            ? "methodology/global"
            : input.validation.classification,
        certificationStatus: "passed",
        certificationEvidenceSha256: evidenceSha256,
      },
      validation: {
        planId: "local-source-validation-v1",
        planSha256,
        scopes: validationScopes,
        checks: evidence.map((entry, index) => ({
          checkId: `evidence-${index + 1}`,
          scope: `stage:${entry.stage}`,
          status: "passed" as const,
          evidenceSha256: entry.sha256,
        })),
      },
      shards: artifacts.shardReceipts,
    });
    await writeJson(
      path.join(temporaryDirectory, "local-build-receipt.json"),
      receipt,
    );
    await verifyLocalSourceCandidate(temporaryDirectory);
    try {
      await rename(temporaryDirectory, destinationDirectory);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error) ||
        !["EEXIST", "ENOTEMPTY"].includes(String(error.code))
      ) {
        throw error;
      }
      await verifyLocalSourceCandidate(destinationDirectory);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return (await verifyLocalSourceCandidate(destinationDirectory)).reference;
}

export async function verifyLocalSourceCandidate(
  directory: string,
  options: {
    expectedBuilderRoot?: string;
  } = {},
): Promise<VerifiedLocalSourceCandidate> {
  const artifacts = await verifyArtifacts(directory);
  const receiptPath = path.join(directory, "local-build-receipt.json");
  await assertRegularFile(receiptPath);
  const receiptResult = await verifyLocalSourceDataBundleReceipt(
    await readJson(receiptPath),
    {
      bundleId: artifacts.manifest.bundleId,
      manifestSha256: artifacts.manifestSha256,
      engineDataSchemaVersion:
        artifacts.manifest.engineDataSchemaVersion,
      provenance: artifacts.manifest.provenance,
      shards: artifacts.shardReceipts,
    },
  );
  if (!receiptResult.ok) {
    throw new Error(
      `The local-source build receipt failed verification: ${receiptResult.message}`,
    );
  }
  if (
    receiptResult.receipt.receiptKind !==
    "rosterpilot-local-source-data-bundle"
  ) {
    throw new Error(
      "The candidate receipt is not a local-source build receipt.",
    );
  }
  const receipt = receiptResult.receipt;
  const buildEvidencePath = path.join(
    directory,
    "local-build-evidence.json",
  );
  await assertRegularFile(buildEvidencePath);
  const buildEvidence = LocalSourceBuildEvidenceDocumentV1Schema.parse(
    await readJson(buildEvidencePath),
  );
  const expectedBuildEvidenceIntegrity = await sha256Hex(
    canonicalJson(buildEvidenceDraft(buildEvidence)),
  );
  if (buildEvidence.integritySha256 !== expectedBuildEvidenceIntegrity) {
    throw new Error(
      "The local-source detailed build evidence failed integrity verification.",
    );
  }
  if (
    buildEvidence.bundleId !== artifacts.manifest.bundleId ||
    buildEvidence.manifestSha256 !== artifacts.manifestSha256 ||
    buildEvidence.engineDataSchemaVersion !==
      artifacts.manifest.engineDataSchemaVersion ||
    canonicalJson(buildEvidence.shards) !==
      canonicalJson(artifacts.shardReceipts)
  ) {
    throw new Error(
      "The local-source detailed build evidence is not bound to its manifest and shard inventory.",
    );
  }
  const evidenceSources = buildEvidence.sources;
  const provenance = artifacts.manifest.provenance;
  if (
    evidenceSources.rules.package !== provenance.rules.package ||
    evidenceSources.rules.version !== provenance.rules.version ||
    evidenceSources.newRecruit.repository !==
      provenance.newRecruit.repository ||
    evidenceSources.newRecruit.branch !== provenance.newRecruit.branch ||
    evidenceSources.newRecruit.commit !== provenance.newRecruit.commit ||
    evidenceSources.official.retainedVersion !==
      provenance.official.version ||
    evidenceSources.official.retainedContentSha256 !==
      provenance.official.contentSha256 ||
    evidenceSources.official.downloadsUrl !==
      provenance.official.downloadsUrl ||
    evidenceSources.official.mfmUrl !== provenance.official.dataUrl ||
    receipt.source.rulesPackageIntegrity !==
      evidenceSources.rules.distIntegrity
  ) {
    throw new Error(
      "The local-source build evidence source identities are not bound to the verified manifest and receipt.",
    );
  }
  const expectedAcceptanceClassification =
    buildEvidence.validation.classification === "bootstrap"
      ? "methodology/global"
      : buildEvidence.validation.classification;
  const expectedValidationScopes = [
    ...new Set(
      buildEvidence.validation.affectedFactions.length > 0
        ? buildEvidence.validation.affectedFactions.map(
            (factionId) => `faction:${factionId}`,
          )
        : ["global"],
    ),
  ].sort();
  const expectedValidationChecks =
    buildEvidence.validation.evidence.map((entry, index) => ({
      checkId: `evidence-${index + 1}`,
      scope: `stage:${entry.stage}`,
      status: "passed" as const,
      evidenceSha256: entry.sha256,
    }));
  if (
    receipt.installedAt !== buildEvidence.createdAt ||
    receipt.parentBundleId !== buildEvidence.parentBundleId ||
    receipt.acceptance.classification !==
      expectedAcceptanceClassification ||
    receipt.validation.planSha256 !==
      (await sha256Hex(canonicalJson(buildEvidence.validation.plan))) ||
    canonicalJson(receipt.validation.scopes) !==
      canonicalJson(expectedValidationScopes) ||
    canonicalJson(receipt.validation.checks) !==
      canonicalJson(expectedValidationChecks)
  ) {
    throw new Error(
      "The local-source receipt is not bound to the detailed validation plan, evidence checks, classification, or parent snapshot.",
    );
  }
  const expectedEvidenceHash = await sha256Hex(
    canonicalJson(buildEvidence.validation.evidence),
  );
  if (
    buildEvidence.validation.evidenceSha256 !== expectedEvidenceHash ||
    receipt.acceptance.certificationEvidenceSha256 !== expectedEvidenceHash
  ) {
    throw new Error(
      "The local-source build receipt does not bind its validation evidence inventory.",
    );
  }
  for (const evidence of buildEvidence.validation.evidence) {
    const filename = path.join(
      directory,
      ...evidence.path.split("/"),
    );
    await assertRegularFile(filename);
    const hashed = await hashFile(filename);
    if (
      hashed.sha256 !== evidence.sha256 ||
      hashed.byteLength !== evidence.byteLength
    ) {
      throw new Error(
        `Local-source validation evidence ${evidence.path} failed verification.`,
      );
    }
  }
  const builderHash = await sha256Hex(
    canonicalJson(buildEvidence.builder.files),
  );
  if (
    buildEvidence.builder.sourceSha256 !== builderHash ||
    receipt.builder.sourceSha256 !== builderHash
  ) {
    throw new Error(
      "The local-source receipt builder inventory failed verification.",
    );
  }
  if (options.expectedBuilderRoot) {
    const currentInventory = await builderInventory(
      options.expectedBuilderRoot,
      buildEvidence.builder.files.map((entry) => entry.path),
    );
    if (
      canonicalJson(currentInventory) !==
      canonicalJson(buildEvidence.builder.files)
    ) {
      throw new Error(
        "The local-source candidate was built by different source code than the expected checkout.",
      );
    }
  }
  const reference: LocalSourceCandidateReference = {
    bundleId: artifacts.manifest.bundleId,
    directory,
    manifestPath: path.join(directory, "manifest.json"),
    receiptPath,
    classification: buildEvidence.validation.classification,
    affectedFactions: [...buildEvidence.validation.affectedFactions],
  };
  return {
    reference,
    manifest: artifacts.manifest,
    manifestDraft: artifacts.manifestDraft,
    shards: artifacts.shards,
    receipt,
    buildEvidence,
  };
}
