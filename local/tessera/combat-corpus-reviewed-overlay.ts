import { createHash } from "node:crypto";

import { z } from "zod";

import {
  CombatOverlaySourceBindingV1Schema,
  CombatRulesPhaseV1Schema,
  CombatStateKeyV1Schema,
  type CombatOverlaySourceBindingV1,
  type CombatRulesPhaseV1,
  type CombatStateKeyV1,
} from "../../lib/rosterpilot/combat-corpus-conformance";
import { canonicalJson } from "../../lib/rosterpilot/semantic-hash";

export const COMBAT_CORPUS_REVIEW_STORE_SCHEMA_VERSION = 1 as const;
export const COMBAT_CORPUS_CONSERVATIVE_SEED_VERSION =
  "structured-exact-seed-v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z.string().trim().min(1).max(256);
const rationaleSchema = z.string().trim().min(1).max(8_000);

export const CombatCorpusReviewedMatcherV1Schema = z.enum([
  "simple-additive-stat-modifier-v1",
  "simple-additive-roll-modifier-v1",
  "simple-reroll-v1",
  "simple-feel-no-pain-v1",
  "simple-flat-damage-reduction-v1",
  "simple-invulnerable-save-v1",
  "simple-keyword-grant-v1",
  "simple-bs-modifier-v1",
  "noncombat-movement-v1",
  "dice-substitution-v1",
  "stance-selection-v1",
  "leader-buff-grant-v1",
  "objective-proximity-v1",
  "threshold-modifier-v1",
]);
export type CombatCorpusReviewedMatcherV1 = z.infer<
  typeof CombatCorpusReviewedMatcherV1Schema
>;

export const CombatCorpusReviewEvidenceV1Schema = z
  .object({
    reviewedBy: identifierSchema,
    reviewedAt: z.string().datetime(),
    rationale: rationaleSchema,
    reference: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();
export type CombatCorpusReviewEvidenceV1 = z.infer<
  typeof CombatCorpusReviewEvidenceV1Schema
>;

const reviewedMatcherEntrySchema = z
  .object({
    entryId: identifierSchema,
    kind: z.literal("reviewed-matcher"),
    matcher: CombatCorpusReviewedMatcherV1Schema,
    evidence: CombatCorpusReviewEvidenceV1Schema,
  })
  .strict();

const wargearAbilityBindingEntrySchema = z
  .object({
    entryId: identifierSchema,
    kind: z.literal("wargear-ability-binding"),
    subject: z
      .object({
        factionId: identifierSchema,
        unitId: identifierSchema,
        equipmentId: identifierSchema,
      })
      .strict(),
    abilityId: identifierSchema,
    evidence: CombatCorpusReviewEvidenceV1Schema,
  })
  .strict();

const exactLeafDispositionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("modeled"),
      mechanicIds: z.array(identifierSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("out-of-calculator-scope"),
      reason: rationaleSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("not-applicable"),
      reason: rationaleSchema,
    })
    .strict(),
]);

const exactLeafEntrySchema = z
  .object({
    entryId: identifierSchema,
    kind: z.literal("exact-leaf"),
    source: CombatOverlaySourceBindingV1Schema,
    phases: z.array(CombatRulesPhaseV1Schema).min(1),
    stateKeys: z.array(CombatStateKeyV1Schema),
    disposition: exactLeafDispositionSchema,
    evidence: CombatCorpusReviewEvidenceV1Schema,
  })
  .strict();

export const CombatCorpusReviewedEntryV1Schema = z.discriminatedUnion(
  "kind",
  [
    reviewedMatcherEntrySchema,
    exactLeafEntrySchema,
    wargearAbilityBindingEntrySchema,
  ],
);
export type CombatCorpusReviewedEntryV1 = z.infer<
  typeof CombatCorpusReviewedEntryV1Schema
>;

const storeObjectSchema = z
  .object({
    schemaVersion: z.literal(COMBAT_CORPUS_REVIEW_STORE_SCHEMA_VERSION),
    kind: z.literal("rosterpilot-combat-corpus-review-store"),
    seedVersion: identifierSchema,
    entries: z.array(CombatCorpusReviewedEntryV1Schema),
  })
  .strict();

type CombatCorpusReviewedStoreDraftShape = z.infer<
  typeof storeObjectSchema
>;

function validateStoreEntries(
  store: CombatCorpusReviewedStoreDraftShape,
  context: z.RefinementCtx,
): void {
  const entryIds = new Set<string>();
  const matchers = new Set<string>();
  const exactBindings = new Set<string>();
  const wargearBindings = new Set<string>();
  for (const [index, entry] of store.entries.entries()) {
    if (entryIds.has(entry.entryId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "entryId"],
        message: "Review-store entry ids must be unique.",
      });
    }
    entryIds.add(entry.entryId);
    if (entry.kind === "reviewed-matcher") {
      if (matchers.has(entry.matcher)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "matcher"],
          message: "A review store cannot repeat a matcher.",
        });
      }
      matchers.add(entry.matcher);
    } else if (entry.kind === "exact-leaf") {
      const key = canonicalJson(entry.source);
      if (exactBindings.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "source"],
          message: "A review store cannot repeat an exact leaf binding.",
        });
      }
      exactBindings.add(key);
    } else {
      const key = canonicalJson({
        subject: entry.subject,
        abilityId: entry.abilityId,
      });
      if (wargearBindings.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index],
          message: "A review store cannot repeat a wargear ability binding.",
        });
      }
      wargearBindings.add(key);
    }
  }
}

const storeDraftSchema = storeObjectSchema.superRefine(
  validateStoreEntries,
);

export const CombatCorpusReviewedStoreV1Schema = storeObjectSchema
  .extend({ storeSha256: sha256Schema })
  .superRefine(validateStoreEntries);
export type CombatCorpusReviewedStoreV1 = z.infer<
  typeof CombatCorpusReviewedStoreV1Schema
>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function normalizeEntry(
  entry: CombatCorpusReviewedEntryV1,
): CombatCorpusReviewedEntryV1 {
  if (entry.kind !== "exact-leaf") return entry;
  return {
    ...entry,
    phases: sortedUnique(entry.phases) as CombatRulesPhaseV1[],
    stateKeys: sortedUnique(entry.stateKeys) as CombatStateKeyV1[],
    disposition:
      entry.disposition.kind === "modeled"
        ? {
            ...entry.disposition,
            mechanicIds: sortedUnique(entry.disposition.mechanicIds),
          }
        : entry.disposition,
  };
}

function normalizeStoreDraft(
  store: z.infer<typeof storeDraftSchema>,
): z.infer<typeof storeDraftSchema> {
  return {
    ...store,
    entries: store.entries.map(normalizeEntry).sort((left, right) =>
      compareStrings(left.entryId, right.entryId)
    ),
  };
}

function storeSha256(
  store: z.infer<typeof storeDraftSchema>,
): string {
  return createHash("sha256")
    .update(canonicalJson(normalizeStoreDraft(store)))
    .digest("hex");
}

export function createCombatCorpusReviewedStoreV1(input: {
  seedVersion: string;
  entries: readonly CombatCorpusReviewedEntryV1[];
}): CombatCorpusReviewedStoreV1 {
  const draft = normalizeStoreDraft(storeDraftSchema.parse({
    schemaVersion: COMBAT_CORPUS_REVIEW_STORE_SCHEMA_VERSION,
    kind: "rosterpilot-combat-corpus-review-store",
    seedVersion: input.seedVersion,
    entries: input.entries,
  }));
  return CombatCorpusReviewedStoreV1Schema.parse({
    ...draft,
    storeSha256: storeSha256(draft),
  });
}

export function verifyCombatCorpusReviewedStoreV1(
  value: unknown,
): value is CombatCorpusReviewedStoreV1 {
  const parsed = CombatCorpusReviewedStoreV1Schema.safeParse(value);
  if (!parsed.success) return false;
  const { storeSha256: observed, ...draft } = parsed.data;
  return observed === storeSha256(draft);
}

export function exactCombatCorpusReviewEntryV1(input: {
  entryId: string;
  source: CombatOverlaySourceBindingV1;
  phases: readonly CombatRulesPhaseV1[];
  stateKeys?: readonly CombatStateKeyV1[];
  disposition: z.infer<typeof exactLeafDispositionSchema>;
  evidence: CombatCorpusReviewEvidenceV1;
}): CombatCorpusReviewedEntryV1 {
  return CombatCorpusReviewedEntryV1Schema.parse({
    entryId: input.entryId,
    kind: "exact-leaf",
    source: input.source,
    phases: input.phases,
    stateKeys: input.stateKeys ?? [],
    disposition: input.disposition,
    evidence: input.evidence,
  });
}

export function wargearCombatCorpusAbilityBindingV1(input: {
  entryId: string;
  factionId: string;
  unitId: string;
  equipmentId: string;
  abilityId: string;
  evidence: CombatCorpusReviewEvidenceV1;
}): CombatCorpusReviewedEntryV1 {
  return CombatCorpusReviewedEntryV1Schema.parse({
    entryId: input.entryId,
    kind: "wargear-ability-binding",
    subject: {
      factionId: input.factionId,
      unitId: input.unitId,
      equipmentId: input.equipmentId,
    },
    abilityId: input.abilityId,
    evidence: input.evidence,
  });
}

const seedEvidence = (
  matcher: CombatCorpusReviewedMatcherV1,
  rationale: string,
): CombatCorpusReviewEvidenceV1 => ({
  reviewedBy: "rosterpilot-conservative-seed",
  reviewedAt: "2026-08-04T00:00:00.000Z",
  rationale,
  reference: `rosterpilot:${COMBAT_CORPUS_CONSERVATIVE_SEED_VERSION}:${matcher}`,
});

export const CONSERVATIVE_COMBAT_CORPUS_REVIEWED_STORE_V1 =
  createCombatCorpusReviewedStoreV1({
    seedVersion: COMBAT_CORPUS_CONSERVATIVE_SEED_VERSION,
    entries: [
      {
        entryId: "seed:simple-additive-stat-modifier-v1",
        kind: "reviewed-matcher",
        matcher: "simple-additive-stat-modifier-v1",
        evidence: seedEvidence(
          "simple-additive-stat-modifier-v1",
          "Admits only finite additive damage-path characteristics with exact targets and no weapon/model narrowing.",
        ),
      },
      {
        entryId: "seed:simple-additive-roll-modifier-v1",
        kind: "reviewed-matcher",
        matcher: "simple-additive-roll-modifier-v1",
        evidence: seedEvidence(
          "simple-additive-roll-modifier-v1",
          "Admits only finite additive hit, wound, save, or damage roll modifiers with exact targets.",
        ),
      },
      {
        entryId: "seed:simple-reroll-v1",
        kind: "reviewed-matcher",
        matcher: "simple-reroll-v1",
        evidence: seedEvidence(
          "simple-reroll-v1",
          "Admits exact hit, wound, and save rerolls; damage rerolls remain unreviewed because the tracked adapter blocks them.",
        ),
      },
      {
        entryId: "seed:simple-feel-no-pain-v1",
        kind: "reviewed-matcher",
        matcher: "simple-feel-no-pain-v1",
        evidence: seedEvidence(
          "simple-feel-no-pain-v1",
          "Admits numeric all-damage Feel No Pain effects; scoped mortal or psychic channels remain unreviewed.",
        ),
      },
      {
        entryId: "seed:simple-flat-damage-reduction-v1",
        kind: "reviewed-matcher",
        matcher: "simple-flat-damage-reduction-v1",
        evidence: seedEvidence(
          "simple-flat-damage-reduction-v1",
          "Admits only positive finite flat damage reduction on the defending unit.",
        ),
      },
      {
        entryId: "seed:simple-invulnerable-save-v1",
        kind: "reviewed-matcher",
        matcher: "simple-invulnerable-save-v1",
        evidence: seedEvidence(
          "simple-invulnerable-save-v1",
          "Admits only a numeric 2+ through 7+ invulnerable save on the defending unit.",
        ),
      },
      {
        entryId: "seed:simple-keyword-grant-v1",
        kind: "reviewed-matcher",
        matcher: "simple-keyword-grant-v1",
        evidence: seedEvidence(
          "simple-keyword-grant-v1",
          "Admits only weapon keyword grants that both the pinned parser and tracked Tessera adapter represent exactly.",
        ),
      },
      {
        entryId: "seed:simple-bs-modifier-v1",
        kind: "reviewed-matcher",
        matcher: "simple-bs-modifier-v1",
        evidence: seedEvidence(
          "simple-bs-modifier-v1",
          "Admits only finite additive incoming hit modifiers on the attacker target.",
        ),
      },
      {
        entryId: "seed:noncombat-movement-v1",
        kind: "reviewed-matcher",
        matcher: "noncombat-movement-v1",
        evidence: seedEvidence(
          "noncombat-movement-v1",
          "Classifies movement-only leaves outside the directional attack calculator without claiming their battlefield effect is modeled.",
        ),
      },
    ],
  });
