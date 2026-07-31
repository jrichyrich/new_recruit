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

export type OfficialRulesOverlayV1 = z.infer<
  typeof OfficialRulesOverlayV1Schema
>;

export type OfficialCommunityConflict = {
  scope:
    | "unit-points"
    | "leader-links"
    | "detachment"
    | "enhancement-points";
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
};

const officialScopeSchema = z.enum([
  "unitPoints",
  "leaderLinks",
  "detachments",
  "enhancementPoints",
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
      officialScopeSchema,
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

export type OfficialExtractorTrustRegistryV1 = z.infer<
  typeof OfficialExtractorTrustRegistryV1Schema
>;
export type OfficialExtractionReceiptV1 = z.infer<
  typeof OfficialExtractionReceiptV1Schema
>;
export type OfficialExtractionReceiptDraftV1 = z.infer<
  typeof officialExtractionReceiptDraftSchema
>;

export type OfficialPublicationEvidenceInput = {
  overlay: unknown;
  sourceArtifact: Uint8Array;
  extractionReceipt: unknown;
  trustedExtractors: unknown;
};

export type VerifiedOfficialPublicationEvidence = {
  overlay: OfficialRulesOverlayV1;
  receipt: OfficialExtractionReceiptV1;
  overlaySha256: string;
  sourceArtifactSha256: string;
  receiptSha256: string;
  extractorId: string;
  extractorKeyId: string;
};

type OfficialScope = z.infer<typeof officialScopeSchema>;

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
          : entry.enhancementId;
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
  const overlay = await verifyOfficialRulesOverlayCoverage(overlayInput);
  const sourceArtifactSha256 = await sha256Hex(sourceArtifact);
  if (sourceArtifactSha256 !== overlay.source.contentSha256) {
    throw new Error(
      "The official overlay does not bind the source artifact supplied to its extractor.",
    );
  }
  const coverage = Object.fromEntries(
    await Promise.all(
      officialScopeSchema.options.map(async (scope) => {
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
  const receipt = OfficialExtractionReceiptV1Schema.parse(
    input.extractionReceipt,
  );
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

  for (const scope of officialScopeSchema.options) {
    const derived = await normalizedScopeEvidence(scope, overlay[scope]);
    const attested = receipt.coverage[scope];
    if (!attested) {
      throw new Error(
        `Official extraction receipt omits ${scope} coverage.`,
      );
    }
    if (
      attested.status !== overlay.coverage[scope].status ||
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
    receiptSha256: await sha256Hex(canonicalJson(receipt)),
    extractorId: receipt.extractor.id,
    extractorKeyId: receipt.signature.keyId,
  };
}

export async function verifyOfficialRulesOverlayCoverage(
  input: unknown,
): Promise<OfficialRulesOverlayV1> {
  const overlay = OfficialRulesOverlayV1Schema.parse(input);
  const scopes = [
    ["unitPoints", overlay.unitPoints],
    ["leaderLinks", overlay.leaderLinks],
    ["detachments", overlay.detachments],
    ["enhancementPoints", overlay.enhancementPoints],
  ] as const;
  for (const [scope, payload] of scopes) {
    const receipt = overlay.coverage[scope];
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
  return overlay;
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
  };
}
