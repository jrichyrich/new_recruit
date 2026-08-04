import { z } from "zod";

import {
  SEMANTIC_SHA256_PATTERN,
  canonicalJson,
  sha256Hex,
} from "./semantic-hash";

export const COMBAT_SEMANTICS_OVERLAY_SCHEMA_VERSION = 1 as const;
export const COMBAT_SOURCE_LEAF_INVENTORY_SCHEMA_VERSION = 1 as const;
export const COMBAT_CORPUS_CONFORMANCE_REPORT_SCHEMA_VERSION = 1 as const;

const sha256Schema = z
  .string()
  .regex(SEMANTIC_SHA256_PATTERN, "Expected a lowercase SHA-256 digest.");
const identifierSchema = z.string().trim().min(1).max(256);
const rationaleSchema = z.string().trim().min(1).max(8_000);

function isJsonPointer(value: string): boolean {
  return /^(?:\/(?:[^~]|~[01])*)*$/.test(value);
}

const jsonPointerSchema = z
  .string()
  .max(4_096)
  .refine(isJsonPointer, "Expected an RFC 6901 JSON pointer.");

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function addDuplicateIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message,
    });
  }
}

export const CombatRulesPhaseV1Schema = z.enum([
  "command",
  "movement",
  "shooting",
  "charge",
  "fight",
]);
export type CombatRulesPhaseV1 = z.infer<
  typeof CombatRulesPhaseV1Schema
>;

const phaseOrder = new Map<CombatRulesPhaseV1, number>([
  ["command", 0],
  ["movement", 1],
  ["shooting", 2],
  ["charge", 3],
  ["fight", 4],
]);

function normalizedPhases(
  phases: readonly CombatRulesPhaseV1[],
): CombatRulesPhaseV1[] {
  return [...new Set(phases)].sort(
    (left, right) =>
      (phaseOrder.get(left) ?? 99) - (phaseOrder.get(right) ?? 99),
  );
}

export const CombatCorpusEntityKindV1Schema = z.enum([
  "ability",
  "stratagem",
  "enhancement",
  "detachment-rule",
  "faction-rule",
  "unit",
  "wargear",
]);
export type CombatCorpusEntityKindV1 = z.infer<
  typeof CombatCorpusEntityKindV1Schema
>;

export const CombatCorpusBundleBindingV1Schema = z
  .object({
    bundleId: sha256Schema,
    engineDataSchemaVersion: z.number().int().nonnegative(),
    rulesSemanticSha256: sha256Schema,
  })
  .strict();
export type CombatCorpusBundleBindingV1 = z.infer<
  typeof CombatCorpusBundleBindingV1Schema
>;

export const CombatCorpusSourceV1Schema = z
  .object({
    sourceId: identifierSchema,
    entityKind: CombatCorpusEntityKindV1Schema,
    factionId: identifierSchema.nullable(),
    entityId: identifierSchema,
    entitySha256: sha256Schema,
    effectJsonPointer: jsonPointerSchema,
    effectSha256: sha256Schema,
  })
  .strict();
export type CombatCorpusSourceV1 = z.infer<
  typeof CombatCorpusSourceV1Schema
>;

export type CombatCorpusSourceEntityInputV1 = Omit<
  CombatCorpusSourceV1,
  "effectSha256"
> & {
  effect: unknown;
};

export const CombatCorpusEffectFragmentV1Schema = z
  .object({
    fragmentId: sha256Schema,
    sourceId: identifierSchema,
    jsonPointer: jsonPointerSchema,
    fragmentSha256: sha256Schema,
    effectType: z.string().min(1).max(160).nullable(),
    role: z.enum(["container", "leaf", "untraversable"]),
  })
  .strict();
export type CombatCorpusEffectFragmentV1 = z.infer<
  typeof CombatCorpusEffectFragmentV1Schema
>;

export const CombatCorpusSourceLeafV1Schema = z
  .object({
    leafId: sha256Schema,
    fragmentId: sha256Schema,
    sourceId: identifierSchema,
    ancestorFragmentIds: z.array(sha256Schema),
  })
  .strict();
export type CombatCorpusSourceLeafV1 = z.infer<
  typeof CombatCorpusSourceLeafV1Schema
>;

export const CombatCorpusTraversalIssueV1Schema = z
  .object({
    code: z.enum([
      "INVALID_EFFECT_NODE",
      "UNKNOWN_EFFECT_NODE_TYPE",
      "MALFORMED_EFFECT_CONTAINER",
      "EMPTY_EFFECT_CONTAINER",
    ]),
    sourceId: identifierSchema,
    fragmentId: sha256Schema,
    jsonPointer: jsonPointerSchema,
    message: z.string().min(1).max(4_000),
  })
  .strict();
export type CombatCorpusTraversalIssueV1 = z.infer<
  typeof CombatCorpusTraversalIssueV1Schema
>;

const CombatSourceLeafInventoryV1DraftObject = z
  .object({
    schemaVersion: z.literal(COMBAT_SOURCE_LEAF_INVENTORY_SCHEMA_VERSION),
    kind: z.literal("rosterpilot-combat-source-leaf-inventory"),
    bundle: CombatCorpusBundleBindingV1Schema,
    sources: z.array(CombatCorpusSourceV1Schema).min(1),
    fragments: z.array(CombatCorpusEffectFragmentV1Schema).min(1),
    leaves: z.array(CombatCorpusSourceLeafV1Schema).min(1),
    traversalIssues: z.array(CombatCorpusTraversalIssueV1Schema),
  })
  .strict();

type CombatSourceLeafInventoryShape = z.infer<
  typeof CombatSourceLeafInventoryV1DraftObject
>;

function validateCombatSourceLeafInventoryShape(
  inventory: CombatSourceLeafInventoryShape,
  context: z.RefinementCtx,
): void {
  addDuplicateIssue(
    inventory.sources.map((source) => source.sourceId),
    context,
    ["sources"],
    "Corpus source ids must be unique.",
  );
  addDuplicateIssue(
    inventory.fragments.map((fragment) => fragment.fragmentId),
    context,
    ["fragments"],
    "Corpus fragment ids must be unique.",
  );
  addDuplicateIssue(
    inventory.fragments.map(
      (fragment) => `${fragment.sourceId}\u0000${fragment.jsonPointer}`,
    ),
    context,
    ["fragments"],
    "A source JSON pointer may identify only one effect fragment.",
  );
  addDuplicateIssue(
    inventory.leaves.map((leaf) => leaf.leafId),
    context,
    ["leaves"],
    "Corpus leaf ids must be unique.",
  );

  const sources = new Map(
    inventory.sources.map((source) => [source.sourceId, source]),
  );
  const fragments = new Map(
    inventory.fragments.map((fragment) => [
      fragment.fragmentId,
      fragment,
    ]),
  );
  const leavesByFragment = new Map<string, number>();
  const referencedContainers = new Set<string>();

  for (const [index, fragment] of inventory.fragments.entries()) {
    if (!sources.has(fragment.sourceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fragments", index, "sourceId"],
        message: "The effect fragment references an unknown corpus source.",
      });
    }
  }

  for (const [index, leaf] of inventory.leaves.entries()) {
    const fragment = fragments.get(leaf.fragmentId);
    if (
      !fragment ||
      (fragment.role !== "leaf" && fragment.role !== "untraversable")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["leaves", index, "fragmentId"],
        message:
          "A corpus leaf must reference a terminal or untraversable fragment.",
      });
    } else if (
      fragment.sourceId !== leaf.sourceId ||
      !sources.has(leaf.sourceId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["leaves", index, "sourceId"],
        message: "The leaf source does not match its effect fragment.",
      });
    }
    leavesByFragment.set(
      leaf.fragmentId,
      (leavesByFragment.get(leaf.fragmentId) ?? 0) + 1,
    );
    addDuplicateIssue(
      leaf.ancestorFragmentIds,
      context,
      ["leaves", index, "ancestorFragmentIds"],
      "A leaf execution path cannot repeat a container fragment.",
    );
    for (const ancestorId of leaf.ancestorFragmentIds) {
      const ancestor = fragments.get(ancestorId);
      if (
        !ancestor ||
        ancestor.role !== "container" ||
        ancestor.sourceId !== leaf.sourceId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["leaves", index, "ancestorFragmentIds"],
          message:
            "Every leaf ancestor must be a container from the same source.",
        });
      } else {
        referencedContainers.add(ancestorId);
      }
    }
  }

  for (const [index, fragment] of inventory.fragments.entries()) {
    if (
      fragment.role === "container" &&
      !referencedContainers.has(fragment.fragmentId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fragments", index, "role"],
        message: "Every container must lead to at least one inventoried leaf.",
      });
    }
    if (
      fragment.role !== "container" &&
      leavesByFragment.get(fragment.fragmentId) !== 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fragments", index, "role"],
        message:
          "Every terminal or untraversable fragment must produce exactly one leaf.",
      });
    }
  }

  const untraversableIds = new Set(
    inventory.fragments
      .filter((fragment) => fragment.role === "untraversable")
      .map((fragment) => fragment.fragmentId),
  );
  const issueCounts = new Map<string, number>();
  for (const [index, issue] of inventory.traversalIssues.entries()) {
    const fragment = fragments.get(issue.fragmentId);
    if (
      !fragment ||
      fragment.role !== "untraversable" ||
      fragment.sourceId !== issue.sourceId ||
      fragment.jsonPointer !== issue.jsonPointer
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["traversalIssues", index],
        message:
          "A traversal issue must identify its exact untraversable fragment.",
      });
    }
    issueCounts.set(
      issue.fragmentId,
      (issueCounts.get(issue.fragmentId) ?? 0) + 1,
    );
  }
  for (const fragmentId of untraversableIds) {
    if (issueCounts.get(fragmentId) !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["traversalIssues"],
        message:
          "Every untraversable fragment must have exactly one traversal issue.",
      });
    }
  }

  for (const [index, source] of inventory.sources.entries()) {
    const root = inventory.fragments.find(
      (fragment) =>
        fragment.sourceId === source.sourceId &&
        fragment.jsonPointer === source.effectJsonPointer,
    );
    if (!root || root.fragmentSha256 !== source.effectSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources", index, "effectSha256"],
        message:
          "The declared effect root must exist and match its fragment digest.",
      });
    }
  }
}

export const CombatSourceLeafInventoryV1DraftSchema =
  CombatSourceLeafInventoryV1DraftObject.superRefine(
    validateCombatSourceLeafInventoryShape,
  );

export const CombatSourceLeafInventoryV1Schema =
  CombatSourceLeafInventoryV1DraftObject.extend({
    inventorySha256: sha256Schema,
  }).superRefine(validateCombatSourceLeafInventoryShape);

export type CombatSourceLeafInventoryV1 = z.infer<
  typeof CombatSourceLeafInventoryV1Schema
>;

const knownLeafEffectTypes = new Set([
  "stat-modifier",
  "roll-modifier",
  "re-roll",
  "mortal-wounds",
  "feel-no-pain",
  "invulnerable-save",
  "ward",
  "keyword-grant",
  "unit-keyword",
  "deep-strike",
  "fallback-and-act",
  "fight-first",
  "fight-last",
  "shoot-on-death",
  "fight-on-death",
  "objective-control-modifier",
  "leadership-modifier",
  "damage-reduction",
  "attack-restriction",
  "ability-grant",
  "cp-gain",
  "cp-refund",
  "model-destruction",
  "resurrection",
  "resource-gain",
  "resource-spend",
  "charge-roll-modifier",
  "terrain-area-tag",
  "objective-tag",
  "unit-tag",
  "bs-modifier",
  "engagement-passthrough",
  "strategic-reserves-arrival",
  "remove-battle-shock",
  "unit-keyword-grant",
  "auto-result",
  "firing-deck",
  "disembark-after-move",
  "disembark",
  "rule-state",
  "pool-add-die",
  "replace-roll-from-pool",
  "flyover",
  "cp-on-destroy",
  "battle-shock-test",
  "modifier-immunity",
  "stratagem-cost-modifier",
  "targeting-permission",
  "stratagem-targeting-permission",
  "unit-attachment",
  "fight-eligibility-extension",
  "recovery-pool",
  "movement-modifier",
]);

type TraversalChild = {
  value: unknown;
  pointerSegments: (string | number)[];
};

type TraversalClassification =
  | { role: "leaf" }
  | { role: "container"; children: TraversalChild[] }
  | {
      role: "untraversable";
      code: CombatCorpusTraversalIssueV1["code"];
      message: string;
    };

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function hasOwn(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function malformedContainer(
  type: string,
  detail: string,
): TraversalClassification {
  return {
    role: "untraversable",
    code: "MALFORMED_EFFECT_CONTAINER",
    message: `Effect container ${JSON.stringify(type)} ${detail}`,
  };
}

function arrayChildren(
  node: Record<string, unknown>,
  input: {
    type: string;
    field: string;
    minimum: number;
    nestedEffectField?: string;
  },
): TraversalClassification {
  const values = node[input.field];
  if (!Array.isArray(values)) {
    return malformedContainer(
      input.type,
      `requires an array at ${JSON.stringify(input.field)}.`,
    );
  }
  if (values.length < input.minimum) {
    return {
      role: "untraversable",
      code: "EMPTY_EFFECT_CONTAINER",
      message: `Effect container ${JSON.stringify(input.type)} requires at least ${input.minimum} effect ${input.minimum === 1 ? "branch" : "branches"}.`,
    };
  }
  if (input.nestedEffectField) {
    const children: TraversalChild[] = [];
    for (const [index, option] of values.entries()) {
      const record = objectRecord(option);
      if (!record || !hasOwn(record, input.nestedEffectField)) {
        return malformedContainer(
          input.type,
          `requires every ${JSON.stringify(input.field)} entry to contain ${JSON.stringify(input.nestedEffectField)}.`,
        );
      }
      children.push({
        value: record[input.nestedEffectField],
        pointerSegments: [input.field, index, input.nestedEffectField],
      });
    }
    return { role: "container", children };
  }
  return {
    role: "container",
    children: values.map((value, index) => ({
      value,
      pointerSegments: [input.field, index],
    })),
  };
}

function singleChild(
  node: Record<string, unknown>,
  type: string,
  pointerSegments: (string | number)[],
): TraversalClassification {
  let current: unknown = node;
  for (const segment of pointerSegments) {
    const record = objectRecord(current);
    if (!record || typeof segment !== "string" || !hasOwn(record, segment)) {
      return malformedContainer(
        type,
        `requires a nested effect at ${JSON.stringify(pointerSegments.join("."))}.`,
      );
    }
    current = record[segment];
  }
  return {
    role: "container",
    children: [{ value: current, pointerSegments }],
  };
}

function classifyEffectNode(value: unknown): TraversalClassification {
  const node = objectRecord(value);
  if (!node) {
    return {
      role: "untraversable",
      code: "INVALID_EFFECT_NODE",
      message: "An effect node must be a plain JSON object.",
    };
  }
  const type = node.type;
  if (typeof type !== "string" || type.length === 0) {
    return {
      role: "untraversable",
      code: "INVALID_EFFECT_NODE",
      message: "An effect node must declare a non-empty string type.",
    };
  }
  if (knownLeafEffectTypes.has(type)) return { role: "leaf" };

  switch (type) {
    case "sequence":
      return arrayChildren(node, {
        type,
        field: "steps",
        minimum: 1,
      });
    case "choice":
      return arrayChildren(node, {
        type,
        field: "options",
        minimum: 2,
      });
    case "stance-select":
      return arrayChildren(node, {
        type,
        field: "options",
        minimum: 2,
        nestedEffectField: "effect",
      });
    case "dice-pool-allocation":
      return arrayChildren(node, {
        type,
        field: "options",
        minimum: 1,
        nestedEffectField: "effect",
      });
    case "issue-orders":
      return arrayChildren(node, {
        type,
        field: "options",
        minimum: 1,
        nestedEffectField: "effect",
      });
    case "conditional":
    case "select-units":
    case "for-each-unit":
      return singleChild(node, type, ["effect"]);
    case "designate-target":
      return singleChild(node, type, ["applies", "effect"]);
    case "risk-reward": {
      const reward = singleChild(node, type, ["reward"]);
      const risk = singleChild(node, type, ["risk", "on_fail"]);
      if (reward.role !== "container") return reward;
      if (risk.role !== "container") return risk;
      return {
        role: "container",
        children: [...reward.children, ...risk.children],
      };
    }
    case "dice-gated": {
      const children: TraversalChild[] = [];
      for (const field of ["on_success", "on_fail"] as const) {
        if (hasOwn(node, field) && node[field] !== null) {
          if (node[field] === undefined) {
            return malformedContainer(
              type,
              `contains undefined at ${JSON.stringify(field)}.`,
            );
          }
          children.push({ value: node[field], pointerSegments: [field] });
        }
      }
      return children.length > 0
        ? { role: "container", children }
        : {
            role: "untraversable",
            code: "EMPTY_EFFECT_CONTAINER",
            message:
              "Effect container \"dice-gated\" has no success or failure effect branch.",
          };
    }
    case "aura": {
      const modifier = objectRecord(node.modifier);
      if (!modifier) {
        return malformedContainer(type, "requires a modifier object.");
      }
      if (!hasOwn(modifier, "effect")) return { role: "leaf" };
      if (modifier.effect === undefined || modifier.effect === null) {
        return malformedContainer(
          type,
          "contains a null or undefined modifier.effect.",
        );
      }
      return {
        role: "container",
        children: [
          {
            value: modifier.effect,
            pointerSegments: ["modifier", "effect"],
          },
        ],
      };
    }
    default:
      return {
        role: "untraversable",
        code: "UNKNOWN_EFFECT_NODE_TYPE",
        message: `Unknown effect type ${JSON.stringify(type)} cannot safely be treated as a leaf because a future DSL node may contain nested effects.`,
      };
  }
}

function escapeJsonPointerToken(value: string | number): string {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function appendJsonPointer(
  base: string,
  segments: readonly (string | number)[],
): string {
  return `${base}${segments
    .map((segment) => `/${escapeJsonPointerToken(segment)}`)
    .join("")}`;
}

function normalizeInventoryDraft(
  inventory: CombatSourceLeafInventoryShape,
): CombatSourceLeafInventoryShape {
  return {
    ...inventory,
    sources: [...inventory.sources].sort((left, right) =>
      compareStrings(left.sourceId, right.sourceId),
    ),
    fragments: [...inventory.fragments].sort((left, right) =>
      compareStrings(left.fragmentId, right.fragmentId),
    ),
    leaves: [...inventory.leaves].sort((left, right) =>
      compareStrings(left.leafId, right.leafId),
    ),
    traversalIssues: [...inventory.traversalIssues].sort(
      (left, right) =>
        compareStrings(left.sourceId, right.sourceId) ||
        compareStrings(left.jsonPointer, right.jsonPointer) ||
        compareStrings(left.code, right.code),
    ),
  };
}

export async function combatSourceLeafInventoryV1CanonicalSha256(
  input: z.input<typeof CombatSourceLeafInventoryV1DraftSchema>,
): Promise<string> {
  const parsed = CombatSourceLeafInventoryV1DraftSchema.parse(input);
  return sha256Hex(canonicalJson(normalizeInventoryDraft(parsed)));
}

export async function buildCombatSourceLeafInventoryV1(input: {
  bundle: CombatCorpusBundleBindingV1;
  sources: readonly CombatCorpusSourceEntityInputV1[];
}): Promise<CombatSourceLeafInventoryV1> {
  const bundle = CombatCorpusBundleBindingV1Schema.parse(input.bundle);
  if (input.sources.length === 0) {
    throw new TypeError("Combat corpus inventory requires at least one source.");
  }

  const sourceIds = input.sources.map((source) => source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError("Combat corpus source ids must be unique.");
  }

  const sources: CombatCorpusSourceV1[] = [];
  const fragments: CombatCorpusEffectFragmentV1[] = [];
  const leaves: CombatCorpusSourceLeafV1[] = [];
  const traversalIssues: CombatCorpusTraversalIssueV1[] = [];

  for (const rawSource of input.sources) {
    const sourceMetadata = CombatCorpusSourceV1Schema.omit({
      effectSha256: true,
    }).parse({
      sourceId: rawSource.sourceId,
      entityKind: rawSource.entityKind,
      factionId: rawSource.factionId,
      entityId: rawSource.entityId,
      entitySha256: rawSource.entitySha256,
      effectJsonPointer: rawSource.effectJsonPointer,
    });
    const effectSha256 = await sha256Hex(canonicalJson(rawSource.effect));
    const source: CombatCorpusSourceV1 = {
      ...sourceMetadata,
      effectSha256,
    };
    sources.push(source);

    const visit = async (
      value: unknown,
      jsonPointer: string,
      ancestorFragmentIds: readonly string[],
    ): Promise<void> => {
      const fragmentSha256 = await sha256Hex(canonicalJson(value));
      const node = objectRecord(value);
      const effectType =
        typeof node?.type === "string" && node.type.length > 0
          ? node.type
          : null;
      const classification = classifyEffectNode(value);
      const fragmentId = await sha256Hex(
        canonicalJson({
          sourceId: source.sourceId,
          entitySha256: source.entitySha256,
          jsonPointer,
          fragmentSha256,
        }),
      );
      fragments.push({
        fragmentId,
        sourceId: source.sourceId,
        jsonPointer,
        fragmentSha256,
        effectType,
        role: classification.role,
      });

      if (classification.role === "container") {
        for (const child of classification.children) {
          await visit(
            child.value,
            appendJsonPointer(jsonPointer, child.pointerSegments),
            [...ancestorFragmentIds, fragmentId],
          );
        }
        return;
      }

      const leafId = await sha256Hex(
        canonicalJson({ fragmentId, ancestorFragmentIds }),
      );
      leaves.push({
        leafId,
        fragmentId,
        sourceId: source.sourceId,
        ancestorFragmentIds: [...ancestorFragmentIds],
      });
      if (classification.role === "untraversable") {
        traversalIssues.push({
          code: classification.code,
          sourceId: source.sourceId,
          fragmentId,
          jsonPointer,
          message: classification.message,
        });
      }
    };

    await visit(rawSource.effect, source.effectJsonPointer, []);
  }

  const draft = CombatSourceLeafInventoryV1DraftSchema.parse(
    normalizeInventoryDraft({
      schemaVersion: COMBAT_SOURCE_LEAF_INVENTORY_SCHEMA_VERSION,
      kind: "rosterpilot-combat-source-leaf-inventory",
      bundle,
      sources,
      fragments,
      leaves,
      traversalIssues,
    }),
  );
  const inventorySha256 =
    await combatSourceLeafInventoryV1CanonicalSha256(draft);
  return CombatSourceLeafInventoryV1Schema.parse({
    ...draft,
    inventorySha256,
  });
}

export async function verifyCombatSourceLeafInventoryV1Hash(
  input: unknown,
): Promise<boolean> {
  const parsed = CombatSourceLeafInventoryV1Schema.safeParse(input);
  if (!parsed.success) return false;
  const { inventorySha256, ...draft } = parsed.data;
  return (
    inventorySha256 ===
    (await combatSourceLeafInventoryV1CanonicalSha256(draft))
  );
}

export const CombatOverlaySourceBindingV1Schema = z
  .object({
    sourceId: identifierSchema,
    entitySha256: sha256Schema,
    jsonPointer: jsonPointerSchema,
    fragmentSha256: sha256Schema,
  })
  .strict();
export type CombatOverlaySourceBindingV1 = z.infer<
  typeof CombatOverlaySourceBindingV1Schema
>;

const reviewedEvidenceSchema = z
  .object({
    reviewedBy: identifierSchema,
    reviewedAt: z.string().datetime(),
    rationale: rationaleSchema,
    reference: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();

const overlayEntryBase = {
  entryId: identifierSchema,
  source: CombatOverlaySourceBindingV1Schema,
  evidence: reviewedEvidenceSchema,
};

export const CombatOverlayAbilityBindingSubjectV1Schema =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("faction"),
        factionId: identifierSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("unit"),
        factionId: identifierSchema,
        unitId: identifierSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("equipment"),
        factionId: identifierSchema,
        unitId: identifierSchema,
        equipmentId: identifierSchema,
      })
      .strict(),
  ]);

const CombatOverlayPhaseMappingEntryV1Schema = z
  .object({
    ...overlayEntryBase,
    kind: z.literal("phase-mapping"),
    phases: z.array(CombatRulesPhaseV1Schema).min(1),
  })
  .strict();

const CombatOverlayAbilityBindingEntryV1Schema = z
  .object({
    ...overlayEntryBase,
    kind: z.literal("ability-binding"),
    bindingClass: z.literal("non-weapon-wargear"),
    subject: CombatOverlayAbilityBindingSubjectV1Schema,
    abilityIds: z.array(identifierSchema).min(1),
  })
  .strict();

const CombatOverlayCalculatorScopeEntryV1Schema = z
  .object({
    ...overlayEntryBase,
    kind: z.literal("calculator-scope"),
    classification: z.enum([
      "in-calculator-scope",
      "out-of-calculator-scope",
      "not-applicable",
    ]),
  })
  .strict();

export const CombatSemanticsOverlayEntryV1Schema =
  z.discriminatedUnion("kind", [
    CombatOverlayPhaseMappingEntryV1Schema,
    CombatOverlayAbilityBindingEntryV1Schema,
    CombatOverlayCalculatorScopeEntryV1Schema,
  ]).superRefine((entry, context) => {
    if (entry.kind === "phase-mapping") {
      addDuplicateIssue(
        entry.phases,
        context,
        ["phases"],
        "A phase mapping cannot repeat a phase.",
      );
    }
    if (entry.kind === "ability-binding") {
      addDuplicateIssue(
        entry.abilityIds,
        context,
        ["abilityIds"],
        "An ability binding cannot repeat an ability id.",
      );
    }
  });
export type CombatSemanticsOverlayEntryV1 = z.infer<
  typeof CombatSemanticsOverlayEntryV1Schema
>;

const CombatSemanticsOverlayV1DraftObject = z
  .object({
    schemaVersion: z.literal(COMBAT_SEMANTICS_OVERLAY_SCHEMA_VERSION),
    kind: z.literal("rosterpilot-combat-semantics-overlay"),
    bundle: CombatCorpusBundleBindingV1Schema,
    sourceInventorySha256: sha256Schema,
    entries: z.array(CombatSemanticsOverlayEntryV1Schema),
  })
  .strict();

function validateCombatSemanticsOverlayDraft(
  overlay: z.infer<typeof CombatSemanticsOverlayV1DraftObject>,
  context: z.RefinementCtx,
): void {
  addDuplicateIssue(
    overlay.entries.map((entry) => entry.entryId),
    context,
    ["entries"],
    "Combat semantics overlay entry ids must be unique.",
  );
  const singletonKeys = overlay.entries
    .filter(
      (entry) =>
        entry.kind === "phase-mapping" ||
        entry.kind === "calculator-scope",
    )
    .map(
      (entry) =>
        `${entry.kind}\u0000${entry.source.sourceId}\u0000${entry.source.jsonPointer}`,
    );
  addDuplicateIssue(
    singletonKeys,
    context,
    ["entries"],
    "A source fragment may have only one phase mapping and one calculator-scope classification.",
  );
}

export const CombatSemanticsOverlayV1DraftSchema =
  CombatSemanticsOverlayV1DraftObject.superRefine(
    validateCombatSemanticsOverlayDraft,
  );

export const CombatSemanticsOverlayV1Schema =
  CombatSemanticsOverlayV1DraftObject.extend({
    overlaySha256: sha256Schema,
  }).superRefine(validateCombatSemanticsOverlayDraft);

export type CombatSemanticsOverlayV1 = z.infer<
  typeof CombatSemanticsOverlayV1Schema
>;

function normalizeOverlayEntry(
  entry: CombatSemanticsOverlayEntryV1,
): CombatSemanticsOverlayEntryV1 {
  if (entry.kind === "phase-mapping") {
    return { ...entry, phases: normalizedPhases(entry.phases) };
  }
  if (entry.kind === "ability-binding") {
    return { ...entry, abilityIds: sortedUnique(entry.abilityIds) };
  }
  return entry;
}

function normalizeOverlayDraft(
  overlay: z.infer<typeof CombatSemanticsOverlayV1DraftSchema>,
): z.infer<typeof CombatSemanticsOverlayV1DraftSchema> {
  return {
    ...overlay,
    entries: overlay.entries
      .map(normalizeOverlayEntry)
      .sort((left, right) => compareStrings(left.entryId, right.entryId)),
  };
}

export async function combatSemanticsOverlayV1CanonicalSha256(
  input: z.input<typeof CombatSemanticsOverlayV1DraftSchema>,
): Promise<string> {
  const parsed = CombatSemanticsOverlayV1DraftSchema.parse(input);
  return sha256Hex(canonicalJson(normalizeOverlayDraft(parsed)));
}

export async function createCombatSemanticsOverlayV1(
  input: z.input<typeof CombatSemanticsOverlayV1DraftSchema>,
): Promise<CombatSemanticsOverlayV1> {
  const draft = normalizeOverlayDraft(
    CombatSemanticsOverlayV1DraftSchema.parse(input),
  );
  const overlaySha256 =
    await combatSemanticsOverlayV1CanonicalSha256(draft);
  return CombatSemanticsOverlayV1Schema.parse({
    ...draft,
    overlaySha256,
  });
}

export async function verifyCombatSemanticsOverlayV1Hash(
  input: unknown,
): Promise<boolean> {
  const parsed = CombatSemanticsOverlayV1Schema.safeParse(input);
  if (!parsed.success) return false;
  const { overlaySha256, ...draft } = parsed.data;
  return (
    overlaySha256 ===
    (await combatSemanticsOverlayV1CanonicalSha256(draft))
  );
}

export type CombatOverlayBindingValidationIssueV1 = {
  code:
    | "OVERLAY_HASH_MISMATCH"
    | "INVENTORY_HASH_MISMATCH"
    | "OVERLAY_INVENTORY_MISMATCH"
    | "OVERLAY_BUNDLE_MISMATCH"
    | "OVERLAY_SOURCE_MISSING"
    | "OVERLAY_ENTITY_STALE"
    | "OVERLAY_FRAGMENT_MISSING"
    | "OVERLAY_FRAGMENT_STALE";
  entryId: string | null;
  message: string;
};

export type CombatOverlayBindingValidationV1 = {
  valid: boolean;
  staleEntryIds: string[];
  issues: CombatOverlayBindingValidationIssueV1[];
};

function bundleBindingsEqual(
  left: CombatCorpusBundleBindingV1,
  right: CombatCorpusBundleBindingV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function validateCombatSemanticsOverlayBindingsV1(input: {
  overlay: CombatSemanticsOverlayV1;
  inventory: CombatSourceLeafInventoryV1;
}): Promise<CombatOverlayBindingValidationV1> {
  const overlay = CombatSemanticsOverlayV1Schema.parse(input.overlay);
  const inventory = CombatSourceLeafInventoryV1Schema.parse(input.inventory);
  const issues: CombatOverlayBindingValidationIssueV1[] = [];
  if (!(await verifyCombatSemanticsOverlayV1Hash(overlay))) {
    issues.push({
      code: "OVERLAY_HASH_MISMATCH",
      entryId: null,
      message: "The combat semantics overlay canonical hash is invalid.",
    });
  }
  if (!(await verifyCombatSourceLeafInventoryV1Hash(inventory))) {
    issues.push({
      code: "INVENTORY_HASH_MISMATCH",
      entryId: null,
      message: "The combat source-leaf inventory canonical hash is invalid.",
    });
  }
  if (overlay.sourceInventorySha256 !== inventory.inventorySha256) {
    issues.push({
      code: "OVERLAY_INVENTORY_MISMATCH",
      entryId: null,
      message:
        "The combat semantics overlay is bound to a different source-leaf inventory.",
    });
  }
  if (!bundleBindingsEqual(overlay.bundle, inventory.bundle)) {
    issues.push({
      code: "OVERLAY_BUNDLE_MISMATCH",
      entryId: null,
      message:
        "The combat semantics overlay and source-leaf inventory bind different bundles.",
    });
  }

  const sources = new Map(
    inventory.sources.map((source) => [source.sourceId, source]),
  );
  const fragments = new Map(
    inventory.fragments.map((fragment) => [
      `${fragment.sourceId}\u0000${fragment.jsonPointer}`,
      fragment,
    ]),
  );
  for (const entry of overlay.entries) {
    const source = sources.get(entry.source.sourceId);
    if (!source) {
      issues.push({
        code: "OVERLAY_SOURCE_MISSING",
        entryId: entry.entryId,
        message: `Overlay entry ${JSON.stringify(entry.entryId)} references a source that is absent from the current corpus.`,
      });
      continue;
    }
    if (source.entitySha256 !== entry.source.entitySha256) {
      issues.push({
        code: "OVERLAY_ENTITY_STALE",
        entryId: entry.entryId,
        message: `Overlay entry ${JSON.stringify(entry.entryId)} is bound to a stale source entity digest.`,
      });
    }
    const fragment = fragments.get(
      `${entry.source.sourceId}\u0000${entry.source.jsonPointer}`,
    );
    if (!fragment) {
      issues.push({
        code: "OVERLAY_FRAGMENT_MISSING",
        entryId: entry.entryId,
        message: `Overlay entry ${JSON.stringify(entry.entryId)} references a fragment absent from the current effect tree.`,
      });
    } else if (
      fragment.fragmentSha256 !== entry.source.fragmentSha256
    ) {
      issues.push({
        code: "OVERLAY_FRAGMENT_STALE",
        entryId: entry.entryId,
        message: `Overlay entry ${JSON.stringify(entry.entryId)} is bound to a stale effect-fragment digest.`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    staleEntryIds: sortedUnique(
      issues.flatMap((issue) =>
        issue.entryId === null ? [] : [issue.entryId],
      ),
    ),
    issues,
  };
}

export const CombatStateKeyV1Schema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "State keys cannot contain control characters.",
  );
export type CombatStateKeyV1 = z.infer<typeof CombatStateKeyV1Schema>;

const phasesSchema = z
  .array(CombatRulesPhaseV1Schema)
  .min(1)
  .superRefine((phases, context) => {
    addDuplicateIssue(
      phases,
      context,
      [],
      "Phase evidence cannot repeat a phase.",
    );
  });

const sourcePhaseEvidenceShape = {
  phases: phasesSchema,
  evidenceJsonPointer: jsonPointerSchema,
  evidenceFragmentSha256: sha256Schema,
};

export const CombatPhaseEvidenceV1Schema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("explicit-community-mapping"),
        ...sourcePhaseEvidenceShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal("structured-trigger"),
        ...sourcePhaseEvidenceShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal("structured-attack-semantics"),
        ...sourcePhaseEvidenceShape,
      })
      .strict(),
    z
      .object({
        kind: z.literal("reviewed-overlay"),
        phases: phasesSchema,
        overlayEntryId: identifierSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("not-required"),
        reason: rationaleSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("unresolved"),
        reason: rationaleSchema,
      })
      .strict(),
  ],
);
export type CombatPhaseEvidenceV1 = z.infer<
  typeof CombatPhaseEvidenceV1Schema
>;

const mechanicIdsSchema = z
  .array(identifierSchema)
  .min(1)
  .superRefine((mechanicIds, context) => {
    addDuplicateIssue(
      mechanicIds,
      context,
      [],
      "Modeled mechanic ids must be unique.",
    );
  });

export const CombatLeafDispositionV1Schema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("modeled"),
        exactness: z.literal("exact"),
        mechanicIds: mechanicIdsSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("state-required"),
        exactness: z.literal("exact-when-state-selected"),
        mechanicIds: mechanicIdsSchema,
        reason: rationaleSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("out-of-calculator-scope"),
        overlayEntryId: identifierSchema,
        reason: rationaleSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("not-applicable"),
        reason: rationaleSchema,
        overlayEntryId: identifierSchema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("unsupported"),
        reason: rationaleSchema,
      })
      .strict(),
  ],
);
export type CombatLeafDispositionV1 = z.infer<
  typeof CombatLeafDispositionV1Schema
>;

export const CombatLeafAccountingV1Schema = z
  .object({
    leafId: sha256Schema,
    phaseEvidence: CombatPhaseEvidenceV1Schema,
    stateKeys: z.array(CombatStateKeyV1Schema),
    disposition: CombatLeafDispositionV1Schema,
  })
  .strict()
  .superRefine((account, context) => {
    addDuplicateIssue(
      account.stateKeys,
      context,
      ["stateKeys"],
      "A leaf account cannot repeat a state key.",
    );
    if (
      account.disposition.kind === "state-required"
        ? account.stateKeys.length === 0
        : account.stateKeys.length !== 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stateKeys"],
        message:
          account.disposition.kind === "state-required"
            ? "A state-required leaf must reference at least one scenario state key."
            : "Only a state-required leaf may reference scenario state keys.",
      });
    }
    if (
      account.phaseEvidence.kind === "unresolved" &&
      account.disposition.kind !== "unsupported"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phaseEvidence"],
        message:
          "Unresolved phase evidence must be classified as unsupported.",
      });
    }
    if (
      account.phaseEvidence.kind === "not-required" &&
      account.disposition.kind !== "out-of-calculator-scope" &&
      account.disposition.kind !== "not-applicable"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phaseEvidence"],
        message:
          "Phase evidence is required for modeled and state-required combat leaves.",
      });
    }
  });
export type CombatLeafAccountingV1 = z.infer<
  typeof CombatLeafAccountingV1Schema
>;

export const CombatCorpusComponentIdentityV1Schema = z
  .object({
    componentId: identifierSchema,
    version: identifierSchema,
    contentSha256: sha256Schema,
  })
  .strict();
export type CombatCorpusComponentIdentityV1 = z.infer<
  typeof CombatCorpusComponentIdentityV1Schema
>;

export const CombatCorpusCommunityIdentityV1Schema = z
  .object({
    package: identifierSchema,
    version: identifierSchema,
    contentSha256: sha256Schema,
  })
  .strict();
export type CombatCorpusCommunityIdentityV1 = z.infer<
  typeof CombatCorpusCommunityIdentityV1Schema
>;

const CombatCorpusConformanceSummaryV1Schema = z
  .object({
    sourceEntityCount: z.number().int().nonnegative(),
    effectFragmentCount: z.number().int().nonnegative(),
    leafCount: z.number().int().nonnegative(),
    accountedLeafCount: z.number().int().nonnegative(),
    modeled: z.number().int().nonnegative(),
    stateRequired: z.number().int().nonnegative(),
    outOfCalculatorScope: z.number().int().nonnegative(),
    notApplicable: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    traversalIssueCount: z.number().int().nonnegative(),
  })
  .strict();

const CombatCorpusConformanceReportV1DraftObject = z
  .object({
    schemaVersion: z.literal(
      COMBAT_CORPUS_CONFORMANCE_REPORT_SCHEMA_VERSION,
    ),
    kind: z.literal("rosterpilot-combat-corpus-conformance-report"),
    binding: z
      .object({
        bundle: CombatCorpusBundleBindingV1Schema,
        sourceInventorySha256: sha256Schema,
        overlaySha256: sha256Schema,
        community: CombatCorpusCommunityIdentityV1Schema,
        compiler: CombatCorpusComponentIdentityV1Schema,
        adapter: CombatCorpusComponentIdentityV1Schema,
        engine: CombatCorpusComponentIdentityV1Schema,
      })
      .strict(),
    inventory: CombatSourceLeafInventoryV1Schema,
    supportedStateKeys: z.array(CombatStateKeyV1Schema),
    leafAccounting: z.array(CombatLeafAccountingV1Schema),
    summary: CombatCorpusConformanceSummaryV1Schema,
  })
  .strict();

type CombatCorpusConformanceReportDraft = z.infer<
  typeof CombatCorpusConformanceReportV1DraftObject
>;

function dispositionCounts(
  accounts: readonly CombatLeafAccountingV1[],
): Pick<
  CombatCorpusConformanceReportDraft["summary"],
  | "modeled"
  | "stateRequired"
  | "outOfCalculatorScope"
  | "notApplicable"
  | "unsupported"
> {
  const counts = {
    modeled: 0,
    stateRequired: 0,
    outOfCalculatorScope: 0,
    notApplicable: 0,
    unsupported: 0,
  };
  for (const account of accounts) {
    switch (account.disposition.kind) {
      case "modeled":
        counts.modeled += 1;
        break;
      case "state-required":
        counts.stateRequired += 1;
        break;
      case "out-of-calculator-scope":
        counts.outOfCalculatorScope += 1;
        break;
      case "not-applicable":
        counts.notApplicable += 1;
        break;
      case "unsupported":
        counts.unsupported += 1;
        break;
    }
  }
  return counts;
}

function expectedSummary(
  report: Pick<
    CombatCorpusConformanceReportDraft,
    "inventory" | "leafAccounting"
  >,
): CombatCorpusConformanceReportDraft["summary"] {
  return {
    sourceEntityCount: report.inventory.sources.length,
    effectFragmentCount: report.inventory.fragments.length,
    leafCount: report.inventory.leaves.length,
    accountedLeafCount: report.leafAccounting.length,
    ...dispositionCounts(report.leafAccounting),
    traversalIssueCount: report.inventory.traversalIssues.length,
  };
}

function validateCombatCorpusConformanceReportDraft(
  report: CombatCorpusConformanceReportDraft,
  context: z.RefinementCtx,
): void {
  addDuplicateIssue(
    report.supportedStateKeys,
    context,
    ["supportedStateKeys"],
    "Supported combat state keys must be unique.",
  );
  addDuplicateIssue(
    report.leafAccounting.map((account) => account.leafId),
    context,
    ["leafAccounting"],
    "Every corpus leaf must have exactly one disposition account.",
  );

  const leafIds = new Set(
    report.inventory.leaves.map((leaf) => leaf.leafId),
  );
  const accountedIds = new Set(
    report.leafAccounting.map((account) => account.leafId),
  );
  const missing = [...leafIds].filter((leafId) => !accountedIds.has(leafId));
  const extra = [...accountedIds].filter((leafId) => !leafIds.has(leafId));
  if (missing.length > 0 || extra.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["leafAccounting"],
      message: `Leaf accounting must be exact (missing ${missing.length}, extra ${extra.length}).`,
    });
  }

  const supportedStateKeys = new Set(report.supportedStateKeys);
  for (const [index, account] of report.leafAccounting.entries()) {
    for (const stateKey of account.stateKeys) {
      if (!supportedStateKeys.has(stateKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["leafAccounting", index, "stateKeys"],
          message: `State key ${JSON.stringify(stateKey)} is not declared by the report's supported state contract.`,
        });
      }
    }
  }

  if (
    report.binding.sourceInventorySha256 !==
      report.inventory.inventorySha256 ||
    !bundleBindingsEqual(report.binding.bundle, report.inventory.bundle)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["binding"],
      message:
        "The conformance report binding must match its embedded source inventory.",
    });
  }

  if (
    canonicalJson(report.summary) !==
    canonicalJson(expectedSummary(report))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary"],
      message:
        "The conformance summary must exactly match the source inventory and leaf dispositions.",
    });
  }
}

export const CombatCorpusConformanceReportV1DraftSchema =
  CombatCorpusConformanceReportV1DraftObject.superRefine(
    validateCombatCorpusConformanceReportDraft,
  );

export const CombatCorpusConformanceReportV1Schema =
  CombatCorpusConformanceReportV1DraftObject.extend({
    reportSha256: sha256Schema,
  }).superRefine(validateCombatCorpusConformanceReportDraft);

export type CombatCorpusConformanceReportV1 = z.infer<
  typeof CombatCorpusConformanceReportV1Schema
>;

function normalizePhaseEvidence(
  evidence: CombatPhaseEvidenceV1,
): CombatPhaseEvidenceV1 {
  return "phases" in evidence
    ? { ...evidence, phases: normalizedPhases(evidence.phases) }
    : evidence;
}

function normalizeLeafAccount(
  account: CombatLeafAccountingV1,
): CombatLeafAccountingV1 {
  const disposition =
    account.disposition.kind === "modeled" ||
    account.disposition.kind === "state-required"
      ? {
          ...account.disposition,
          mechanicIds: sortedUnique(account.disposition.mechanicIds),
        }
      : account.disposition;
  return {
    ...account,
    phaseEvidence: normalizePhaseEvidence(account.phaseEvidence),
    stateKeys: sortedUnique(account.stateKeys),
    disposition,
  };
}

function normalizeReportDraft(
  report: CombatCorpusConformanceReportDraft,
): CombatCorpusConformanceReportDraft {
  return {
    ...report,
    inventory: {
      ...normalizeInventoryDraft(report.inventory),
      inventorySha256: report.inventory.inventorySha256,
    },
    supportedStateKeys: sortedUnique(report.supportedStateKeys),
    leafAccounting: report.leafAccounting
      .map(normalizeLeafAccount)
      .sort((left, right) => compareStrings(left.leafId, right.leafId)),
  };
}

export async function combatCorpusConformanceReportV1CanonicalSha256(
  input: z.input<typeof CombatCorpusConformanceReportV1DraftSchema>,
): Promise<string> {
  const parsed = CombatCorpusConformanceReportV1DraftSchema.parse(input);
  return sha256Hex(canonicalJson(normalizeReportDraft(parsed)));
}

export type CreateCombatCorpusConformanceReportV1Input = {
  inventory: CombatSourceLeafInventoryV1;
  overlay: CombatSemanticsOverlayV1;
  community: CombatCorpusCommunityIdentityV1;
  compiler: CombatCorpusComponentIdentityV1;
  adapter: CombatCorpusComponentIdentityV1;
  engine: CombatCorpusComponentIdentityV1;
  supportedStateKeys: readonly CombatStateKeyV1[];
  leafAccounting: readonly CombatLeafAccountingV1[];
};

export async function createCombatCorpusConformanceReportV1(
  input: CreateCombatCorpusConformanceReportV1Input,
): Promise<CombatCorpusConformanceReportV1> {
  const inventory = CombatSourceLeafInventoryV1Schema.parse(input.inventory);
  const overlay = CombatSemanticsOverlayV1Schema.parse(input.overlay);
  if (!(await verifyCombatSourceLeafInventoryV1Hash(inventory))) {
    throw new TypeError("Cannot report on an inventory with an invalid canonical hash.");
  }
  const overlayValidation =
    await validateCombatSemanticsOverlayBindingsV1({ overlay, inventory });
  if (!overlayValidation.valid) {
    throw new TypeError(
      `Cannot report on a stale combat semantics overlay: ${overlayValidation.issues
        .map((issue) => issue.code)
        .join(", ")}.`,
    );
  }
  const leafAccounting = input.leafAccounting.map((account) =>
    CombatLeafAccountingV1Schema.parse(account),
  );
  const reportWithoutSummary = {
    schemaVersion: COMBAT_CORPUS_CONFORMANCE_REPORT_SCHEMA_VERSION,
    kind: "rosterpilot-combat-corpus-conformance-report" as const,
    binding: {
      bundle: inventory.bundle,
      sourceInventorySha256: inventory.inventorySha256,
      overlaySha256: overlay.overlaySha256,
      community: CombatCorpusCommunityIdentityV1Schema.parse(
        input.community,
      ),
      compiler: CombatCorpusComponentIdentityV1Schema.parse(input.compiler),
      adapter: CombatCorpusComponentIdentityV1Schema.parse(input.adapter),
      engine: CombatCorpusComponentIdentityV1Schema.parse(input.engine),
    },
    inventory,
    supportedStateKeys: [...input.supportedStateKeys],
    leafAccounting,
  };
  const draft = normalizeReportDraft(
    CombatCorpusConformanceReportV1DraftSchema.parse({
      ...reportWithoutSummary,
      summary: expectedSummary(reportWithoutSummary),
    }),
  );
  const reportSha256 =
    await combatCorpusConformanceReportV1CanonicalSha256(draft);
  return CombatCorpusConformanceReportV1Schema.parse({
    ...draft,
    reportSha256,
  });
}

export async function verifyCombatCorpusConformanceReportV1Hash(
  input: unknown,
): Promise<boolean> {
  const parsed = CombatCorpusConformanceReportV1Schema.safeParse(input);
  if (!parsed.success) return false;
  const { reportSha256, ...draft } = parsed.data;
  return (
    reportSha256 ===
    (await combatCorpusConformanceReportV1CanonicalSha256(draft))
  );
}

export type CombatCorpusStrictAdmissionIssueV1 = {
  code:
    | "REPORT_SCHEMA_INVALID"
    | "OVERLAY_SCHEMA_INVALID"
    | "REPORT_HASH_MISMATCH"
    | "INVENTORY_HASH_MISMATCH"
    | "REPORT_OVERLAY_MISMATCH"
    | "RUNTIME_IDENTITY_MISMATCH"
    | "STATE_CONTRACT_MISMATCH"
    | "OVERLAY_BINDING_INVALID"
    | "TRAVERSAL_INCOMPLETE"
    | "UNSUPPORTED_LEAF"
    | "UNRESOLVED_PHASE"
    | "NON_COMBAT_MODELED_PHASE"
    | "PHASE_EVIDENCE_STALE"
    | "PHASE_OVERLAY_INVALID"
    | "SCOPE_OVERLAY_INVALID";
  leafId: string | null;
  message: string;
};

export type CombatCorpusStrictAdmissionV1 = {
  admitted: boolean;
  issues: CombatCorpusStrictAdmissionIssueV1[];
};

export const CombatCorpusStrictAdmissionExpectationV1Schema = z
  .object({
    bundle: CombatCorpusBundleBindingV1Schema,
    community: CombatCorpusCommunityIdentityV1Schema,
    compiler: CombatCorpusComponentIdentityV1Schema,
    adapter: CombatCorpusComponentIdentityV1Schema,
    engine: CombatCorpusComponentIdentityV1Schema,
    supportedStateKeys: z.array(CombatStateKeyV1Schema),
  })
  .strict()
  .superRefine((expectation, context) => {
    addDuplicateIssue(
      expectation.supportedStateKeys,
      context,
      ["supportedStateKeys"],
      "Expected combat state keys must be unique.",
    );
  });
export type CombatCorpusStrictAdmissionExpectationV1 = z.infer<
  typeof CombatCorpusStrictAdmissionExpectationV1Schema
>;

function leafFragmentPath(
  inventory: CombatSourceLeafInventoryV1,
  leafId: string,
): CombatCorpusEffectFragmentV1[] {
  const fragments = new Map(
    inventory.fragments.map((fragment) => [fragment.fragmentId, fragment]),
  );
  const leaf = inventory.leaves.find(
    (candidate) => candidate.leafId === leafId,
  );
  if (!leaf) return [];
  return [...leaf.ancestorFragmentIds, leaf.fragmentId].flatMap(
    (fragmentId) => {
      const fragment = fragments.get(fragmentId);
      return fragment ? [fragment] : [];
    },
  );
}

function sourceBindingMatchesLeafPath(
  source: CombatOverlaySourceBindingV1,
  path: readonly CombatCorpusEffectFragmentV1[],
  inventory: CombatSourceLeafInventoryV1,
): boolean {
  const corpusSource = inventory.sources.find(
    (candidate) => candidate.sourceId === source.sourceId,
  );
  return (
    corpusSource?.entitySha256 === source.entitySha256 &&
    path.some(
      (fragment) =>
        fragment.sourceId === source.sourceId &&
        fragment.jsonPointer === source.jsonPointer &&
        fragment.fragmentSha256 === source.fragmentSha256,
    )
  );
}

function phasesEqual(
  left: readonly CombatRulesPhaseV1[],
  right: readonly CombatRulesPhaseV1[],
): boolean {
  return (
    canonicalJson(normalizedPhases(left)) ===
    canonicalJson(normalizedPhases(right))
  );
}

export async function evaluateCombatCorpusStrictAdmissionV1(input: {
  report: unknown;
  overlay: unknown;
  expected: CombatCorpusStrictAdmissionExpectationV1;
}): Promise<CombatCorpusStrictAdmissionV1> {
  const issues: CombatCorpusStrictAdmissionIssueV1[] = [];
  const parsedReport = CombatCorpusConformanceReportV1Schema.safeParse(
    input.report,
  );
  if (!parsedReport.success) {
    return {
      admitted: false,
      issues: [
        {
          code: "REPORT_SCHEMA_INVALID",
          leafId: null,
          message: parsedReport.error.issues[0]?.message ??
            "The combat corpus conformance report is invalid.",
        },
      ],
    };
  }
  const parsedOverlay = CombatSemanticsOverlayV1Schema.safeParse(
    input.overlay,
  );
  if (!parsedOverlay.success) {
    return {
      admitted: false,
      issues: [
        {
          code: "OVERLAY_SCHEMA_INVALID",
          leafId: null,
          message: parsedOverlay.error.issues[0]?.message ??
            "The combat semantics overlay is invalid.",
        },
      ],
    };
  }

  const report = parsedReport.data;
  const overlay = parsedOverlay.data;
  const expected =
    CombatCorpusStrictAdmissionExpectationV1Schema.parse(input.expected);
  if (!(await verifyCombatCorpusConformanceReportV1Hash(report))) {
    issues.push({
      code: "REPORT_HASH_MISMATCH",
      leafId: null,
      message: "The conformance report canonical hash is invalid.",
    });
  }
  if (!(await verifyCombatSourceLeafInventoryV1Hash(report.inventory))) {
    issues.push({
      code: "INVENTORY_HASH_MISMATCH",
      leafId: null,
      message: "The embedded source-leaf inventory canonical hash is invalid.",
    });
  }
  if (report.binding.overlaySha256 !== overlay.overlaySha256) {
    issues.push({
      code: "REPORT_OVERLAY_MISMATCH",
      leafId: null,
      message: "The report is bound to a different combat semantics overlay.",
    });
  }
  const reportRuntimeIdentity = {
    bundle: report.binding.bundle,
    community: report.binding.community,
    compiler: report.binding.compiler,
    adapter: report.binding.adapter,
    engine: report.binding.engine,
  };
  const expectedRuntimeIdentity = {
    bundle: expected.bundle,
    community: expected.community,
    compiler: expected.compiler,
    adapter: expected.adapter,
    engine: expected.engine,
  };
  if (
    canonicalJson(reportRuntimeIdentity) !==
    canonicalJson(expectedRuntimeIdentity)
  ) {
    issues.push({
      code: "RUNTIME_IDENTITY_MISMATCH",
      leafId: null,
      message:
        "The report does not bind the current bundle, community package, compiler, adapter, and engine identities.",
    });
  }
  if (
    canonicalJson(sortedUnique(report.supportedStateKeys)) !==
    canonicalJson(sortedUnique(expected.supportedStateKeys))
  ) {
    issues.push({
      code: "STATE_CONTRACT_MISMATCH",
      leafId: null,
      message:
        "The report's supported state-key registry does not match the current scenario contract.",
    });
  }
  const overlayValidation =
    await validateCombatSemanticsOverlayBindingsV1({
      overlay,
      inventory: report.inventory,
    });
  if (!overlayValidation.valid) {
    issues.push({
      code: "OVERLAY_BINDING_INVALID",
      leafId: null,
      message: `The overlay binding is stale or invalid: ${overlayValidation.issues
        .map((issue) => issue.code)
        .join(", ")}.`,
    });
  }
  if (
    report.inventory.traversalIssues.length > 0 ||
    report.inventory.fragments.some(
      (fragment) => fragment.role === "untraversable",
    )
  ) {
    issues.push({
      code: "TRAVERSAL_INCOMPLETE",
      leafId: null,
      message:
        "Strict corpus admission requires every source effect tree to be safely traversable.",
    });
  }

  const overlayEntries = new Map(
    overlay.entries.map((entry) => [entry.entryId, entry]),
  );
  for (const account of report.leafAccounting) {
    const path = leafFragmentPath(
      report.inventory,
      account.leafId,
    );
    if (account.disposition.kind === "unsupported") {
      issues.push({
        code: "UNSUPPORTED_LEAF",
        leafId: account.leafId,
        message:
          "Strict corpus admission prohibits unsupported source leaves.",
      });
    }
    if (account.phaseEvidence.kind === "unresolved") {
      issues.push({
        code: "UNRESOLVED_PHASE",
        leafId: account.leafId,
        message:
          "Strict corpus admission requires resolved or explicitly unnecessary phase evidence.",
      });
    }
    if (
      (account.disposition.kind === "modeled" ||
        account.disposition.kind === "state-required") &&
      "phases" in account.phaseEvidence &&
      !account.phaseEvidence.phases.some(
        (phase) => phase === "shooting" || phase === "fight",
      )
    ) {
      issues.push({
        code: "NON_COMBAT_MODELED_PHASE",
        leafId: account.leafId,
        message:
          "A modeled combat leaf must apply in the shooting or fight phase.",
      });
    }

    if (
      account.phaseEvidence.kind === "explicit-community-mapping" ||
      account.phaseEvidence.kind === "structured-trigger" ||
      account.phaseEvidence.kind === "structured-attack-semantics"
    ) {
      const evidence = account.phaseEvidence;
      if (
        !path.some(
          (fragment) =>
            fragment.jsonPointer === evidence.evidenceJsonPointer &&
            fragment.fragmentSha256 ===
              evidence.evidenceFragmentSha256,
        )
      ) {
        issues.push({
          code: "PHASE_EVIDENCE_STALE",
          leafId: account.leafId,
          message:
            "Structured phase evidence must bind the leaf or one of its containing fragments.",
        });
      }
    } else if (account.phaseEvidence.kind === "reviewed-overlay") {
      const entry = overlayEntries.get(
        account.phaseEvidence.overlayEntryId,
      );
      if (
        !entry ||
        entry.kind !== "phase-mapping" ||
        !phasesEqual(entry.phases, account.phaseEvidence.phases) ||
        !sourceBindingMatchesLeafPath(
          entry.source,
          path,
          report.inventory,
        )
      ) {
        issues.push({
          code: "PHASE_OVERLAY_INVALID",
          leafId: account.leafId,
          message:
            "Reviewed phase evidence must reference a current phase-mapping overlay entry on the leaf execution path.",
        });
      }
    }

    if (account.disposition.kind === "out-of-calculator-scope") {
      const entry = overlayEntries.get(
        account.disposition.overlayEntryId,
      );
      if (
        !entry ||
        entry.kind !== "calculator-scope" ||
        entry.classification !== "out-of-calculator-scope" ||
        !sourceBindingMatchesLeafPath(
          entry.source,
          path,
          report.inventory,
        )
      ) {
        issues.push({
          code: "SCOPE_OVERLAY_INVALID",
          leafId: account.leafId,
          message:
            "An out-of-scope disposition requires a current reviewed overlay classification on the leaf execution path.",
        });
      }
    }
    if (
      account.disposition.kind === "not-applicable" &&
      account.disposition.overlayEntryId !== null
    ) {
      const entry = overlayEntries.get(
        account.disposition.overlayEntryId,
      );
      if (
        !entry ||
        entry.kind !== "calculator-scope" ||
        entry.classification !== "not-applicable" ||
        !sourceBindingMatchesLeafPath(
          entry.source,
          path,
          report.inventory,
        )
      ) {
        issues.push({
          code: "SCOPE_OVERLAY_INVALID",
          leafId: account.leafId,
          message:
            "A reviewed not-applicable disposition must reference its current overlay classification.",
        });
      }
    }
  }

  return { admitted: issues.length === 0, issues };
}
