import { z } from "zod";

import type {
  RuntimeRulesData,
} from "./runtime-dataset";
import {
  canonicalJson,
  semanticHash,
  sha256Hex,
} from "./semantic-hash";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      new Date(`${value}T00:00:00.000Z`)
        .toISOString()
        .startsWith(value),
    "Expected a valid ISO calendar date.",
  );
const officialWarhammerAssetUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      [
        "assets.warhammer-community.com",
        "www.warhammer-community.com",
        "warhammer-community.com",
      ].includes(url.hostname)
    );
  }, "Expected an official Warhammer Community HTTPS asset URL.");
const gameVersionSchema = z
  .object({
    edition: z.string().min(1),
    dataslate: z.string().min(1),
  })
  .strict();

const pointsTierSchema = z
  .object({
    models: z.number().int().positive(),
    cost: z.number().int().nonnegative(),
    unit_count_min: z.number().int().positive(),
    unit_count_max: z.number().int().positive().nullable(),
  })
  .strict();

const officialExtractionCoverageSchema = z
  .object({
    status: z.enum(["complete", "not-published"]),
    sourceEntityCount: z.number().int().nonnegative(),
    extractedEntityCount: z.number().int().nonnegative(),
    payloadSha256: sha256Schema,
  })
  .strict();

const legendSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    factionId: z.string().min(1),
    factionName: z.string().min(1),
    documentKind: z.literal("faction-pack"),
    gameEdition: z.string().min(1),
    version: z.string().min(1),
    legalFrom: isoDateSchema,
    contentSha256: sha256Schema,
    url: officialWarhammerAssetUrlSchema,
    extractedAt: z.string().datetime(),
  })
  .strict();

const legendUnitSchema = z
  .object({
    legendId: z.string().min(1).max(256),
    factionId: z.string().min(1),
    name: z.string().min(1),
    /** Null keeps an official entry inventory-only until 40kdc supplies it. */
    unitId: z.string().min(1).nullable(),
    sourceId: z.string().min(1).max(160),
    datasheetUrl: z.string().url().optional(),
    gameVersion: gameVersionSchema.optional(),
  })
  .strict();

const legendFactionCoverageSchema = z
  .object({
    factionId: z.string().min(1),
    sourceIds: z.array(z.string().min(1).max(160)).min(1),
    status: z.enum(["complete", "not-published"]),
    sourceEntityCount: z.number().int().nonnegative(),
    extractedEntityCount: z.number().int().nonnegative(),
    payloadSha256: sha256Schema,
  })
  .strict();

export const OfficialRulesOverlayV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    authority: z.literal("games-workshop"),
    source: z
      .object({
        version: z.string().min(1),
        contentSha256: sha256Schema,
        url: z.string().url(),
        extractedAt: z.string().datetime(),
        extractor: z.string().min(1),
        extractorVersion: z.string().min(1),
      })
      .strict(),
    coverage: z
      .object({
        unitPoints: officialExtractionCoverageSchema,
        leaderLinks: officialExtractionCoverageSchema,
        detachments: officialExtractionCoverageSchema,
        enhancementPoints: officialExtractionCoverageSchema,
      })
      .strict(),
    unitPoints: z
      .array(
        z
          .object({
            factionId: z.string().min(1),
            unitId: z.string().min(1),
            tiers: z.array(pointsTierSchema).min(1),
            gameVersion: gameVersionSchema.optional(),
          })
          .strict(),
      )
      .default([]),
    leaderLinks: z
      .array(
        z
          .object({
            factionId: z.string().min(1),
            leaderId: z.string().min(1),
            eligibleBodyguardIds: z.array(z.string().min(1)),
            eligibleBodyguardKeywords: z
              .array(z.string().min(1))
              .default([]),
            gameVersion: gameVersionSchema.optional(),
          })
          .strict(),
      )
      .default([]),
    detachments: z
      .array(
        z
          .object({
            factionId: z.string().min(1),
            detachmentId: z.string().min(1),
            detachmentPoints: z.number().int().nonnegative(),
            forceDispositionIds: z.array(z.string().min(1)),
            gameVersion: gameVersionSchema.optional(),
          })
          .strict(),
      )
      .default([]),
    enhancementPoints: z
      .array(
        z
          .object({
            factionId: z.string().min(1),
            enhancementId: z.string().min(1),
            cost: z.number().int().nonnegative(),
            gameVersion: gameVersionSchema.optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

/**
 * V2 retains the MFM as the primary points source and independently binds
 * every faction-pack PDF used to classify Legends. The per-faction coverage
 * records make an inspected zero-Legends faction distinguishable from a
 * faction whose official pack was never checked.
 */
export const OfficialRulesOverlayV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    authority: z.literal("games-workshop"),
    gameEdition: z.string().min(1),
    source: OfficialRulesOverlayV1Schema.shape.source,
    legendSources: z.array(legendSourceSchema),
    coverage: OfficialRulesOverlayV1Schema.shape.coverage.extend({
      legendUnits: officialExtractionCoverageSchema,
      legendFactionCoverage: officialExtractionCoverageSchema,
    }),
    unitPoints: OfficialRulesOverlayV1Schema.shape.unitPoints,
    leaderLinks: OfficialRulesOverlayV1Schema.shape.leaderLinks,
    detachments: OfficialRulesOverlayV1Schema.shape.detachments,
    enhancementPoints:
      OfficialRulesOverlayV1Schema.shape.enhancementPoints,
    legendFactionCoverage: z.array(
      legendFactionCoverageSchema,
    ),
    legendUnits: z.array(legendUnitSchema),
  })
  .strict();

export const OfficialRulesOverlaySchema = z.discriminatedUnion(
  "schemaVersion",
  [OfficialRulesOverlayV1Schema, OfficialRulesOverlayV2Schema],
);

export type OfficialRulesOverlayV1 = z.infer<
  typeof OfficialRulesOverlayV1Schema
>;
export type OfficialRulesOverlayV2 = z.infer<
  typeof OfficialRulesOverlayV2Schema
>;
export type OfficialRulesOverlay = z.infer<
  typeof OfficialRulesOverlaySchema
>;

export type OfficialCommunityConflict = {
  scope:
    | "unit-points"
    | "leader-links"
    | "detachment"
    | "enhancement-points"
    | "legends-classification";
  factionId: string;
  entityId: string;
  resolution: "official-override";
  communityHash: string;
  officialHash: string;
};

export type OfficialRulesOverlayResult = {
  rulesData: RuntimeRulesData;
  overlayHash: string;
  conflicts: OfficialCommunityConflict[];
  affectedFactions: string[];
  legendInventory: OfficialRulesOverlayV2["legendUnits"];
};

const officialScopeV1Schema = z.enum([
  "unitPoints",
  "leaderLinks",
  "detachments",
  "enhancementPoints",
]);

const officialScopeV2Schema = z.enum([
  ...officialScopeV1Schema.options,
  "legendUnits",
  "legendFactionCoverage",
]);

const publicEd25519JwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().min(1),
    alg: z.enum(["EdDSA", "Ed25519"]).optional(),
    key_ops: z.tuple([z.literal("verify")]).optional(),
    ext: z.literal(true).optional(),
  })
  .strict();

export const OfficialExtractorTrustRegistryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    extractors: z
      .array(
        z
          .object({
            extractorId: z.string().min(1).max(160),
            keyId: z.string().min(1).max(128),
            publicKey: publicEd25519JwkSchema,
            status: z.literal("trusted"),
            reviewedAt: z.string().datetime(),
            reviewReference: z.string().min(1).max(1_024),
          })
          .strict(),
      )
      .superRefine((entries, context) => {
        const identities = new Set<string>();
        for (const [index, entry] of entries.entries()) {
          const identity = `${entry.extractorId}\u0000${entry.keyId}`;
          if (identities.has(identity)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index],
              message: "Extractor trust entries must be unique.",
            });
          }
          identities.add(identity);
        }
      }),
  })
  .strict();

const officialExtractionScopeReceiptSchema = z
  .object({
    status: z.enum(["complete", "not-published"]),
    sourceEntityKeys: z.array(z.string().min(1).max(512)),
    payloadSha256: sha256Schema,
  })
  .strict();

const officialExtractionReceiptDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    authority: z.literal("games-workshop"),
    source: z
      .object({
        version: z.string().min(1),
        contentSha256: sha256Schema,
        url: z.string().url(),
        byteLength: z.number().int().positive(),
      })
      .strict(),
    extractor: z
      .object({
        id: z.string().min(1).max(160),
        version: z.string().min(1).max(160),
      })
      .strict(),
    overlaySha256: sha256Schema,
    coverage: z.record(
      officialScopeV1Schema,
      officialExtractionScopeReceiptSchema,
    ),
    issuedAt: z.string().datetime(),
  })
  .strict();

const officialLegendSourceReceiptSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    factionId: z.string().min(1),
    factionName: z.string().min(1),
    documentKind: z.literal("faction-pack"),
    gameEdition: z.string().min(1),
    version: z.string().min(1),
    legalFrom: isoDateSchema,
    contentSha256: sha256Schema,
    url: officialWarhammerAssetUrlSchema,
    byteLength: z.number().int().positive(),
  })
  .strict();

const officialExtractionReceiptDraftV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    authority: z.literal("games-workshop"),
    source: officialExtractionReceiptDraftSchema.shape.source,
    legendSources: z.array(officialLegendSourceReceiptSchema),
    extractor: officialExtractionReceiptDraftSchema.shape.extractor,
    overlaySha256: sha256Schema,
    coverage: z.record(
      officialScopeV2Schema,
      officialExtractionScopeReceiptSchema,
    ),
    issuedAt: z.string().datetime(),
  })
  .strict();

export const OfficialExtractionReceiptV1Schema =
  officialExtractionReceiptDraftSchema.extend({
    signature: z
      .object({
        algorithm: z.literal("Ed25519"),
        keyId: z.string().min(1).max(128),
        value: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
      })
      .strict(),
  });

export const OfficialExtractionReceiptV2Schema =
  officialExtractionReceiptDraftV2Schema.extend({
    signature: OfficialExtractionReceiptV1Schema.shape.signature,
  });

export const OfficialExtractionReceiptSchema =
  z.discriminatedUnion("schemaVersion", [
    OfficialExtractionReceiptV1Schema,
    OfficialExtractionReceiptV2Schema,
  ]);

export type OfficialExtractorTrustRegistryV1 = z.infer<
  typeof OfficialExtractorTrustRegistryV1Schema
>;
export type OfficialExtractionReceiptV1 = z.infer<
  typeof OfficialExtractionReceiptV1Schema
>;
export type OfficialExtractionReceiptDraftV1 = z.infer<
  typeof officialExtractionReceiptDraftSchema
>;
export type OfficialExtractionReceiptV2 = z.infer<
  typeof OfficialExtractionReceiptV2Schema
>;
export type OfficialExtractionReceiptDraftV2 = z.infer<
  typeof officialExtractionReceiptDraftV2Schema
>;
export type OfficialExtractionReceipt = z.infer<
  typeof OfficialExtractionReceiptSchema
>;
export type OfficialExtractionReceiptDraft =
  | OfficialExtractionReceiptDraftV1
  | OfficialExtractionReceiptDraftV2;

export type OfficialPublicationEvidenceInput = {
  overlay: unknown;
  sourceArtifact: Uint8Array;
  /** Exact faction-pack bytes keyed by the overlay's legend source id. */
  legendSourceArtifacts?: Readonly<Record<string, Uint8Array>>;
  extractionReceipt: unknown;
  trustedExtractors: unknown;
};

export type VerifiedOfficialPublicationEvidence = {
  overlay: OfficialRulesOverlay;
  receipt: OfficialExtractionReceipt;
  overlaySha256: string;
  sourceArtifactSha256: string;
  legendSourceArtifactSha256: Record<string, string>;
  receiptSha256: string;
  extractorId: string;
  extractorKeyId: string;
};

type OfficialScope = z.infer<typeof officialScopeV2Schema>;

function exactEntityKey(scope: OfficialScope, value: unknown): string {
  const entry = value as Record<string, unknown>;
  const factionId = entry.factionId;
  const entityId =
    scope === "unitPoints"
      ? entry.unitId
      : scope === "leaderLinks"
        ? entry.leaderId
        : scope === "detachments"
          ? entry.detachmentId
          : scope === "enhancementPoints"
            ? entry.enhancementId
            : scope === "legendUnits"
              ? entry.legendId
              : entry.factionId;
  if (typeof factionId !== "string" || typeof entityId !== "string") {
    throw new Error(
      `Official ${scope} payload has no stable faction/entity identity.`,
    );
  }
  return `${factionId}:${entityId}`;
}

async function normalizedScopeEvidence(
  scope: OfficialScope,
  payload: readonly unknown[],
): Promise<{ entityKeys: string[]; payloadSha256: string }> {
  const keyed = payload
    .map((entry) => ({ key: exactEntityKey(scope, entry), entry }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const entityKeys = keyed.map(({ key }) => key);
  if (new Set(entityKeys).size !== entityKeys.length) {
    throw new Error(
      `Official ${scope} extraction repeats a source entity.`,
    );
  }
  return {
    entityKeys,
    payloadSha256: await sha256Hex(
      canonicalJson(keyed.map(({ entry }) => entry)),
    ),
  };
}

function decodeBase64Url(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(
    value.replace(/-/g, "+").replace(/_/g, "/") + padding,
  );
  return Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
}

/** Canonical unsigned payload emitted and signed by a reviewed extractor. */
export async function createOfficialExtractionReceiptDraft(
  overlayInput: unknown,
  sourceArtifact: Uint8Array,
  issuedAt: string,
): Promise<OfficialExtractionReceiptDraftV1> {
  const overlay = await verifyOfficialRulesOverlayV1Coverage(
    overlayInput,
  );
  const sourceArtifactSha256 = await sha256Hex(sourceArtifact);
  if (sourceArtifactSha256 !== overlay.source.contentSha256) {
    throw new Error(
      "The official overlay does not bind the source artifact supplied to its extractor.",
    );
  }
  const coverage = Object.fromEntries(
    await Promise.all(
      officialScopeV1Schema.options.map(async (scope) => {
        const normalized = await normalizedScopeEvidence(
          scope,
          overlay[scope],
        );
        return [
          scope,
          {
            status: overlay.coverage[scope].status,
            sourceEntityKeys: normalized.entityKeys,
            payloadSha256: normalized.payloadSha256,
          },
        ];
      }),
    ),
  ) as OfficialExtractionReceiptDraftV1["coverage"];
  return officialExtractionReceiptDraftSchema.parse({
    schemaVersion: 1,
    authority: "games-workshop",
    source: {
      version: overlay.source.version,
      contentSha256: sourceArtifactSha256,
      url: overlay.source.url,
      byteLength: sourceArtifact.byteLength,
    },
    extractor: {
      id: overlay.source.extractor,
      version: overlay.source.extractorVersion,
    },
    overlaySha256: await sha256Hex(canonicalJson(overlay)),
    coverage,
    issuedAt,
  });
}

/**
 * Creates the unsigned receipt for a V2 overlay. Both the primary MFM bytes
 * and every faction-pack artifact are required; omitted or extra artifact
 * keys fail closed before a receipt can be signed.
 */
export async function createOfficialExtractionReceiptDraftV2(
  overlayInput: unknown,
  sourceArtifact: Uint8Array,
  legendSourceArtifacts: Readonly<Record<string, Uint8Array>>,
  issuedAt: string,
): Promise<OfficialExtractionReceiptDraftV2> {
  const overlay = await verifyOfficialRulesOverlayV2Coverage(
    overlayInput,
  );
  const sourceArtifactSha256 = await sha256Hex(sourceArtifact);
  if (sourceArtifactSha256 !== overlay.source.contentSha256) {
    throw new Error(
      "The official overlay does not bind the primary source artifact supplied to its extractor.",
    );
  }
  const expectedSourceIds = overlay.legendSources
    .map((source) => source.sourceId)
    .sort();
  const suppliedSourceIds = Object.keys(legendSourceArtifacts).sort();
  if (
    canonicalJson(expectedSourceIds) !==
    canonicalJson(suppliedSourceIds)
  ) {
    throw new Error(
      "The official V2 receipt requires the exact declared faction-pack artifact inventory.",
    );
  }
  const legendSources = await Promise.all(
    [...overlay.legendSources]
      .sort((left, right) =>
        left.sourceId.localeCompare(right.sourceId),
      )
      .map(async (source) => {
        const artifact = legendSourceArtifacts[source.sourceId];
        const contentSha256 = await sha256Hex(artifact);
        if (contentSha256 !== source.contentSha256) {
          throw new Error(
            `The official overlay does not bind faction-pack artifact ${source.sourceId}.`,
          );
        }
        return {
          sourceId: source.sourceId,
          factionId: source.factionId,
          factionName: source.factionName,
          documentKind: source.documentKind,
          gameEdition: source.gameEdition,
          version: source.version,
          legalFrom: source.legalFrom,
          contentSha256,
          url: source.url,
          byteLength: artifact.byteLength,
        };
      }),
  );
  const coverage = Object.fromEntries(
    await Promise.all(
      officialScopeV2Schema.options.map(async (scope) => {
        const normalized = await normalizedScopeEvidence(
          scope,
          overlay[scope],
        );
        return [
          scope,
          {
            status: overlay.coverage[scope].status,
            sourceEntityKeys: normalized.entityKeys,
            payloadSha256: normalized.payloadSha256,
          },
        ];
      }),
    ),
  ) as OfficialExtractionReceiptDraftV2["coverage"];
  return officialExtractionReceiptDraftV2Schema.parse({
    schemaVersion: 2,
    authority: "games-workshop",
    source: {
      version: overlay.source.version,
      contentSha256: sourceArtifactSha256,
      url: overlay.source.url,
      byteLength: sourceArtifact.byteLength,
    },
    legendSources,
    extractor: {
      id: overlay.source.extractor,
      version: overlay.source.extractorVersion,
    },
    overlaySha256: await sha256Hex(canonicalJson(overlay)),
    coverage,
    issuedAt,
  });
}

/**
 * Release-only trust boundary for official rules. Runtime overlay application
 * remains ergonomic, but no publisher may sign an official change from the
 * overlay's self-declared counts alone. The exact source bytes, normalized
 * one-to-one inventory, and overlay are covered by a reviewed extractor's
 * Ed25519 receipt.
 */
export async function verifyOfficialPublicationEvidence(
  input: OfficialPublicationEvidenceInput,
): Promise<VerifiedOfficialPublicationEvidence> {
  const overlay = await verifyOfficialRulesOverlayCoverage(input.overlay);
  const receipt = OfficialExtractionReceiptSchema.parse(
    input.extractionReceipt,
  );
  if (receipt.schemaVersion !== overlay.schemaVersion) {
    throw new Error(
      "Official extraction receipt and overlay schema versions do not match.",
    );
  }
  const registry = OfficialExtractorTrustRegistryV1Schema.parse(
    input.trustedExtractors,
  );
  const sourceArtifactSha256 = await sha256Hex(input.sourceArtifact);
  if (
    receipt.source.contentSha256 !== sourceArtifactSha256 ||
    receipt.source.byteLength !== input.sourceArtifact.byteLength ||
    overlay.source.contentSha256 !== sourceArtifactSha256
  ) {
    throw new Error(
      "Official extraction evidence does not bind the exact source artifact bytes.",
    );
  }
  const legendSourceArtifactSha256 = Object.create(
    null,
  ) as Record<string, string>;
  if (overlay.schemaVersion === 2 && receipt.schemaVersion === 2) {
    const suppliedArtifacts = input.legendSourceArtifacts ?? {};
    const expectedSourceIds = overlay.legendSources
      .map((source) => source.sourceId)
      .sort();
    if (
      canonicalJson(Object.keys(suppliedArtifacts).sort()) !==
      canonicalJson(expectedSourceIds)
    ) {
      throw new Error(
        "Official extraction evidence does not supply the exact faction-pack artifact inventory.",
      );
    }
    const receiptSources = new Map(
      receipt.legendSources.map((source) => [
        source.sourceId,
        source,
      ]),
    );
    if (
      receiptSources.size !== receipt.legendSources.length ||
      receiptSources.size !== overlay.legendSources.length
    ) {
      throw new Error(
        "Official extraction receipt repeats a faction-pack artifact.",
      );
    }
    for (const source of overlay.legendSources) {
      const artifact = suppliedArtifacts[source.sourceId];
      const attested = receiptSources.get(source.sourceId);
      const contentSha256 = await sha256Hex(artifact);
      Object.defineProperty(
        legendSourceArtifactSha256,
        source.sourceId,
        {
          value: contentSha256,
          enumerable: true,
          configurable: false,
          writable: false,
        },
      );
      if (
        !attested ||
        attested.factionId !== source.factionId ||
        attested.factionName !== source.factionName ||
        attested.documentKind !== source.documentKind ||
        attested.gameEdition !== source.gameEdition ||
        attested.version !== source.version ||
        attested.legalFrom !== source.legalFrom ||
        attested.url !== source.url ||
        attested.contentSha256 !== source.contentSha256 ||
        contentSha256 !== source.contentSha256 ||
        attested.byteLength !== artifact.byteLength
      ) {
        throw new Error(
          `Official extraction evidence does not bind exact faction-pack artifact ${source.sourceId}.`,
        );
      }
    }
  } else if (
    Object.keys(input.legendSourceArtifacts ?? {}).length > 0
  ) {
    throw new Error(
      "A V1 official overlay cannot attest faction-pack artifacts.",
    );
  }
  if (
    receipt.source.version !== overlay.source.version ||
    receipt.source.url !== overlay.source.url ||
    receipt.extractor.id !== overlay.source.extractor ||
    receipt.extractor.version !== overlay.source.extractorVersion
  ) {
    throw new Error(
      "Official extraction receipt provenance does not match its overlay.",
    );
  }

  const overlaySha256 = await sha256Hex(canonicalJson(overlay));
  if (receipt.overlaySha256 !== overlaySha256) {
    throw new Error(
      "Official extraction receipt does not bind the exact normalized overlay.",
    );
  }

  const scopes =
    overlay.schemaVersion === 2
      ? officialScopeV2Schema.options
      : officialScopeV1Schema.options;
  for (const scope of scopes) {
    const derived = await normalizedScopeEvidence(
      scope,
      (overlay as unknown as Record<string, readonly unknown[]>)[
        scope
      ],
    );
    const attested = (
      receipt.coverage as unknown as Record<
        string,
        z.infer<typeof officialExtractionScopeReceiptSchema>
      >
    )[scope];
    if (!attested) {
      throw new Error(
        `Official extraction receipt omits ${scope} coverage.`,
      );
    }
    if (
      attested.status !==
        (
          overlay.coverage as unknown as Record<
            string,
            z.infer<typeof officialExtractionCoverageSchema>
          >
        )[scope].status ||
      canonicalJson(attested.sourceEntityKeys) !==
        canonicalJson(derived.entityKeys) ||
      attested.payloadSha256 !== derived.payloadSha256
    ) {
      throw new Error(
        `Official ${scope} extraction receipt does not provide one-to-one source inventory and normalized payload coverage.`,
      );
    }
    if (
      attested.status === "not-published" &&
      attested.sourceEntityKeys.length !== 0
    ) {
      throw new Error(
        `Official ${scope} not-published evidence must have an empty source inventory.`,
      );
    }
  }

  const trusted = registry.extractors.find(
    (entry) =>
      entry.extractorId === receipt.extractor.id &&
      entry.keyId === receipt.signature.keyId,
  );
  if (!trusted) {
    throw new Error(
      `No reviewed official extractor key is configured for ${receipt.extractor.id}:${receipt.signature.keyId}.`,
    );
  }
  let key: CryptoKey;
  try {
    key = await globalThis.crypto.subtle.importKey(
      "jwk",
      trusted.publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    throw new Error(
      `The reviewed official extractor key ${receipt.signature.keyId} is not a valid Ed25519 public key.`,
    );
  }
  const { signature, ...draft } = receipt;
  const signatureBytes = decodeBase64Url(signature.value);
  const signatureValid =
    signatureBytes.byteLength === 64 &&
    (await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      Uint8Array.from(signatureBytes),
      new TextEncoder().encode(canonicalJson(draft)),
    ));
  if (!signatureValid) {
    throw new Error(
      "Official extraction receipt signature is invalid or has been tampered with.",
    );
  }
  return {
    overlay,
    receipt,
    overlaySha256,
    sourceArtifactSha256,
    legendSourceArtifactSha256,
    receiptSha256: await sha256Hex(canonicalJson(receipt)),
    extractorId: receipt.extractor.id,
    extractorKeyId: receipt.signature.keyId,
  };
}

async function verifyOfficialScopeCoverage(
  overlay: OfficialRulesOverlay,
  scopes: readonly OfficialScope[],
): Promise<void> {
  for (const scope of scopes) {
    const payload = (
      overlay as unknown as Record<string, readonly unknown[]>
    )[scope];
    const receipt = (
      overlay.coverage as unknown as Record<
        string,
        z.infer<typeof officialExtractionCoverageSchema>
      >
    )[scope];
    if (
      receipt.extractedEntityCount !== payload.length ||
      receipt.payloadSha256 !== (await semanticHash(payload))
    ) {
      throw new Error(
        `Official ${scope} extraction coverage does not match its normalized payload.`,
      );
    }
    if (
      receipt.status === "complete"
        ? receipt.sourceEntityCount !==
          receipt.extractedEntityCount
        : receipt.sourceEntityCount !== 0 ||
          receipt.extractedEntityCount !== 0
    ) {
      throw new Error(
        `Official ${scope} extraction is not complete for the source inventory it declares.`,
      );
    }
  }
  if (
    overlay.coverage.unitPoints.status !== "complete" ||
    overlay.coverage.unitPoints.sourceEntityCount === 0
  ) {
    throw new Error(
      "The Munitorum Field Manual overlay must contain a complete, non-empty unit-points extraction.",
    );
  }
}

export async function verifyOfficialRulesOverlayV1Coverage(
  input: unknown,
): Promise<OfficialRulesOverlayV1> {
  const overlay = OfficialRulesOverlayV1Schema.parse(input);
  await verifyOfficialScopeCoverage(
    overlay,
    officialScopeV1Schema.options,
  );
  return overlay;
}

export async function verifyOfficialRulesOverlayV2Coverage(
  input: unknown,
): Promise<OfficialRulesOverlayV2> {
  const overlay = OfficialRulesOverlayV2Schema.parse(input);
  await verifyOfficialScopeCoverage(
    overlay,
    officialScopeV2Schema.options,
  );
  if (
    overlay.coverage.legendUnits.status !== "complete" ||
    overlay.coverage.legendFactionCoverage.status !== "complete" ||
    overlay.legendFactionCoverage.length === 0
  ) {
    throw new Error(
      "Official Legends classification requires complete, explicit per-faction coverage.",
    );
  }

  const sources = new Map(
    overlay.legendSources.map((source) => [source.sourceId, source]),
  );
  if (sources.size !== overlay.legendSources.length) {
    throw new Error("Official Legends source ids must be unique.");
  }
  for (const source of overlay.legendSources) {
    if (source.gameEdition !== overlay.gameEdition) {
      throw new Error(
        `Official Legends source ${source.sourceId} targets ${source.gameEdition}, not overlay edition ${overlay.gameEdition}.`,
      );
    }
  }
  const coverageByFaction = new Map(
    overlay.legendFactionCoverage.map((coverage) => [
      coverage.factionId,
      coverage,
    ]),
  );
  if (
    coverageByFaction.size !== overlay.legendFactionCoverage.length
  ) {
    throw new Error(
      "Official Legends faction coverage must declare each faction exactly once.",
    );
  }
  const referencedSources = new Set<string>();
  for (const coverage of overlay.legendFactionCoverage) {
    if (new Set(coverage.sourceIds).size !== coverage.sourceIds.length) {
      throw new Error(
        `Official Legends coverage for ${coverage.factionId} repeats a source artifact.`,
      );
    }
    for (const sourceId of coverage.sourceIds) {
      const source = sources.get(sourceId);
      if (!source || source.factionId !== coverage.factionId) {
        throw new Error(
          `Official Legends coverage for ${coverage.factionId} references an unknown or cross-faction source artifact.`,
        );
      }
      referencedSources.add(sourceId);
    }
    const units = overlay.legendUnits.filter(
      (unit) => unit.factionId === coverage.factionId,
    );
    if (
      coverage.extractedEntityCount !== units.length ||
      coverage.payloadSha256 !== (await semanticHash(units)) ||
      (coverage.status === "complete"
        ? coverage.sourceEntityCount !== units.length
        : coverage.sourceEntityCount !== 0 || units.length !== 0)
    ) {
      throw new Error(
        `Official Legends coverage for ${coverage.factionId} does not match its normalized inventory.`,
      );
    }
  }
  if (
    referencedSources.size !== sources.size ||
    [...sources.keys()].some(
      (sourceId) => !referencedSources.has(sourceId),
    )
  ) {
    throw new Error(
      "Every official faction-pack artifact must be assigned to explicit faction coverage.",
    );
  }

  const legendKeys = new Set<string>();
  const resolvedUnitKeys = new Set<string>();
  for (const unit of overlay.legendUnits) {
    const source = sources.get(unit.sourceId);
    const factionCoverage = coverageByFaction.get(unit.factionId);
    if (
      !source ||
      source.factionId !== unit.factionId ||
      !factionCoverage?.sourceIds.includes(unit.sourceId)
    ) {
      throw new Error(
        `Official Legend ${unit.factionId}:${unit.legendId} is not bound to its declared faction-pack artifact.`,
      );
    }
    const legendKey = `${unit.factionId}:${unit.legendId}`;
    if (legendKeys.has(legendKey)) {
      throw new Error(
        `Official Legends inventory repeats ${legendKey}.`,
      );
    }
    legendKeys.add(legendKey);
    if (
      unit.gameVersion &&
      unit.gameVersion.edition !== overlay.gameEdition
    ) {
      throw new Error(
        `Official Legend ${legendKey} targets ${unit.gameVersion.edition}, not overlay edition ${overlay.gameEdition}.`,
      );
    }
    if (unit.unitId !== null) {
      const resolvedKey = `${unit.factionId}:${unit.unitId}`;
      if (resolvedUnitKeys.has(resolvedKey)) {
        throw new Error(
          `Official Legends inventory resolves ${resolvedKey} more than once.`,
        );
      }
      resolvedUnitKeys.add(resolvedKey);
    }
  }
  return overlay;
}

export async function verifyOfficialRulesOverlayCoverage(
  input: unknown,
): Promise<OfficialRulesOverlay> {
  const version = objectRecord(input)?.schemaVersion;
  return version === 2
    ? verifyOfficialRulesOverlayV2Coverage(input)
    : verifyOfficialRulesOverlayV1Coverage(input);
}

function objectRecord(
  value: unknown,
): Record<string, unknown> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function factionOf(
  value: unknown,
): string | null {
  const factionId = objectRecord(value)?.faction_id;
  return typeof factionId === "string" ? factionId : null;
}

function entityId(
  value: unknown,
  field = "id",
): string | null {
  const id = objectRecord(value)?.[field];
  return typeof id === "string" ? id : null;
}

function requireEntity<T>(
  collection: readonly T[],
  expected: {
    factionId: string;
    entityId: string;
    idField?: string;
    owner?: (entry: T) => string | null;
  },
): T {
  const match = collection.find(
    (entry) =>
      entityId(entry, expected.idField) === expected.entityId &&
      (expected.owner?.(entry) ?? factionOf(entry)) ===
        expected.factionId,
  );
  if (!match) {
    throw new Error(
      `Official overlay references unknown ${expected.factionId}:${expected.entityId}.`,
    );
  }
  return match;
}

async function conflict(
  scope: OfficialCommunityConflict["scope"],
  factionId: string,
  id: string,
  community: unknown,
  official: unknown,
): Promise<OfficialCommunityConflict | null> {
  const [communityHash, officialHash] = await Promise.all([
    semanticHash(community),
    semanticHash(official),
  ]);
  return communityHash === officialHash
    ? null
    : {
        scope,
        factionId,
        entityId: id,
        resolution: "official-override",
        communityHash,
        officialHash,
      };
}

/**
 * Applies a complete, source-bound official extraction over structured
 * community data. Missing entities fail closed; differing community values
 * are retained as explicit provenance conflicts while the official value wins.
 */
export async function applyOfficialRulesOverlay(
  source: RuntimeRulesData,
  input: unknown,
): Promise<OfficialRulesOverlayResult> {
  const overlay = await verifyOfficialRulesOverlayCoverage(input);
  const rulesData = structuredClone(source);
  const conflicts: OfficialCommunityConflict[] = [];
  const affectedFactions = new Set<string>();
  const legendInventory =
    overlay.schemaVersion === 2
      ? structuredClone(overlay.legendUnits)
      : [];

  if (overlay.schemaVersion === 2) {
    for (const coverage of overlay.legendFactionCoverage) {
      affectedFactions.add(coverage.factionId);
      const officialLegendUnitIds = new Set(
        overlay.legendUnits
          .filter(
            (legend) =>
              legend.factionId === coverage.factionId &&
              legend.unitId !== null,
          )
          .map((legend) => legend.unitId as string),
      );
      for (const candidate of rulesData.units as readonly unknown[]) {
        if (factionOf(candidate) !== coverage.factionId) continue;
        const unit = candidate as Record<string, unknown>;
        const id = entityId(unit);
        const officialClassification =
          id !== null && officialLegendUnitIds.has(id);
        if (
          id &&
          unit.is_legend !== officialClassification &&
          (typeof unit.is_legend === "boolean" ||
            officialClassification)
        ) {
            const found = await conflict(
              "legends-classification",
              coverage.factionId,
              id,
              unit.is_legend ?? null,
              officialClassification,
            );
            if (found) conflicts.push(found);
        }
        unit.is_legend = officialClassification;
      }
    }
    for (const legend of overlay.legendUnits) {
      if (legend.unitId === null) continue;
      const unit = requireEntity(rulesData.units, {
        factionId: legend.factionId,
        entityId: legend.unitId,
      }) as unknown as Record<string, unknown>;
      if (legend.gameVersion) {
        unit.game_version = structuredClone(legend.gameVersion);
      }
    }
  }

  for (const override of overlay.unitPoints) {
    const unit = requireEntity(rulesData.units, {
      factionId: override.factionId,
      entityId: override.unitId,
    }) as unknown as Record<string, unknown>;
    const found = await conflict(
      "unit-points",
      override.factionId,
      override.unitId,
      unit.points,
      override.tiers,
    );
    if (found) conflicts.push(found);
    unit.points = structuredClone(override.tiers);
    unit.points_provisional = false;
    if (override.gameVersion) {
      unit.game_version = structuredClone(override.gameVersion);
    }
    affectedFactions.add(override.factionId);
  }

  const unitOwners = new Map(
    (rulesData.units as readonly unknown[]).flatMap((entry) => {
      const id = entityId(entry);
      const factionId = factionOf(entry);
      return id && factionId ? [[id, factionId] as const] : [];
    }),
  );
  const knownUnitIds = new Set(unitOwners.keys());
  for (const override of overlay.leaderLinks) {
    const attachment = requireEntity(rulesData.leaderAttachments, {
      factionId: override.factionId,
      entityId: override.leaderId,
      idField: "leader_id",
      owner: (entry) =>
        unitOwners.get(entityId(entry, "leader_id") ?? "") ?? null,
    }) as unknown as Record<string, unknown>;
    for (const bodyguardId of override.eligibleBodyguardIds) {
      if (!knownUnitIds.has(bodyguardId)) {
        throw new Error(
          `Official leader overlay references unknown bodyguard unit ${bodyguardId}.`,
        );
      }
    }
    const official = {
      eligible_bodyguard_ids: override.eligibleBodyguardIds,
      eligible_bodyguard_keywords:
        override.eligibleBodyguardKeywords,
    };
    const found = await conflict(
      "leader-links",
      override.factionId,
      override.leaderId,
      {
        eligible_bodyguard_ids:
          attachment.eligible_bodyguard_ids ?? [],
        eligible_bodyguard_keywords:
          attachment.eligible_bodyguard_keywords ?? [],
      },
      official,
    );
    if (found) conflicts.push(found);
    attachment.eligible_bodyguard_ids = structuredClone(
      override.eligibleBodyguardIds,
    );
    attachment.eligible_bodyguard_keywords = structuredClone(
      override.eligibleBodyguardKeywords,
    );
    if (override.gameVersion) {
      attachment.game_version = structuredClone(
        override.gameVersion,
      );
    }
    affectedFactions.add(override.factionId);
  }

  const detachmentOwners = new Map(
    (rulesData.detachments as readonly unknown[]).flatMap((entry) => {
      const id = entityId(entry);
      const factionId = factionOf(entry);
      return id && factionId ? [[id, factionId] as const] : [];
    }),
  );
  const knownForceDispositionIds = new Set(
    (rulesData.forceDispositions as readonly unknown[])
      .map((entry) => entityId(entry))
      .filter((id): id is string => id !== null),
  );
  for (const override of overlay.detachments) {
    const detachment = requireEntity(rulesData.detachments, {
      factionId: override.factionId,
      entityId: override.detachmentId,
    }) as unknown as Record<string, unknown>;
    for (const dispositionId of override.forceDispositionIds) {
      if (!knownForceDispositionIds.has(dispositionId)) {
        throw new Error(
          `Official detachment overlay references unknown force disposition ${dispositionId}.`,
        );
      }
    }
    const official = {
      detachment_points: override.detachmentPoints,
      force_dispositions: override.forceDispositionIds,
    };
    const found = await conflict(
      "detachment",
      override.factionId,
      override.detachmentId,
      {
        detachment_points: detachment.detachment_points,
        force_dispositions: detachment.force_dispositions ?? [],
      },
      official,
    );
    if (found) conflicts.push(found);
    detachment.detachment_points = override.detachmentPoints;
    detachment.force_dispositions = structuredClone(
      override.forceDispositionIds,
    );
    if (override.gameVersion) {
      detachment.game_version = structuredClone(
        override.gameVersion,
      );
    }
    affectedFactions.add(override.factionId);
  }

  for (const override of overlay.enhancementPoints) {
    const enhancement = requireEntity(rulesData.enhancements, {
      factionId: override.factionId,
      entityId: override.enhancementId,
      owner: (entry) =>
        detachmentOwners.get(
          entityId(entry, "detachment_id") ?? "",
        ) ?? null,
    }) as unknown as Record<string, unknown>;
    const found = await conflict(
      "enhancement-points",
      override.factionId,
      override.enhancementId,
      enhancement.cost,
      override.cost,
    );
    if (found) conflicts.push(found);
    enhancement.cost = override.cost;
    enhancement.points_provisional = false;
    if (override.gameVersion) {
      enhancement.game_version = structuredClone(
        override.gameVersion,
      );
    }
    affectedFactions.add(override.factionId);
  }

  return {
    rulesData,
    overlayHash: await semanticHash(overlay),
    conflicts,
    affectedFactions: [...affectedFactions].sort(),
    legendInventory,
  };
}
