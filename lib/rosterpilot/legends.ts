import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const LegendSourceArtifactSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    version: z.string().min(1),
    contentSha256: sha256Schema,
    url: z.string().url(),
  })
  .strict();

export const RuntimeLegendUnitSchema = z
  .object({
    legendId: z.string().min(1).max(256),
    factionId: z.string().min(1),
    name: z.string().min(1),
    /**
     * The structured-rules unit identity when 40kdc supplies a complete
     * profile. A null value keeps the official unit browsable without
     * synthesizing rules from the interoperability catalogue.
     */
    unitId: z.string().min(1).nullable(),
    sourceId: z.string().min(1).max(160),
    datasheetUrl: z.string().url().optional(),
    buildSupported: z.boolean(),
  })
  .strict();

export const RuntimeFactionLegendsStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    factionId: z.string().min(1),
    coverageStatus: z.enum([
      "complete",
      "not-published",
      "unavailable",
    ]),
    classificationAuthority: z
      .enum([
        "games-workshop-verified",
        "games-workshop-unverified-overlay",
        "unavailable",
      ]),
    sourceArtifacts: z.array(LegendSourceArtifactSchema),
    units: z.array(RuntimeLegendUnitSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const sourceIds = state.sourceArtifacts.map(
      (source) => source.sourceId,
    );
    if (new Set(sourceIds).size !== sourceIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceArtifacts"],
        message: "Legends source artifact ids must be unique.",
      });
    }
    const legendIds = state.units.map((unit) => unit.legendId);
    if (new Set(legendIds).size !== legendIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["units"],
        message: "Legends inventory identities must be unique.",
      });
    }
    const unitIds = state.units
      .map((unit) => unit.unitId)
      .filter((unitId): unitId is string => unitId !== null);
    if (new Set(unitIds).size !== unitIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["units"],
        message:
          "A structured-rules unit cannot resolve more than one Legends inventory entry.",
      });
    }
    for (const [index, unit] of state.units.entries()) {
      if (unit.factionId !== state.factionId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["units", index, "factionId"],
          message: "A Legends unit must belong to its faction shard.",
        });
      }
      if (!sourceIds.includes(unit.sourceId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["units", index, "sourceId"],
          message:
            "A Legends unit must reference a retained faction-pack artifact.",
        });
      }
      if (unit.buildSupported && unit.unitId === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["units", index, "buildSupported"],
          message:
            "Legends build support requires a resolved structured-rules unit.",
        });
      }
    }
    if (
      state.coverageStatus === "unavailable" &&
      (state.sourceArtifacts.length > 0 || state.units.length > 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverageStatus"],
        message:
          "Unavailable Legends coverage cannot claim source artifacts or units.",
      });
    }
    if (
      state.coverageStatus !== "unavailable" &&
      state.sourceArtifacts.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceArtifacts"],
        message:
          "Published Legends coverage must retain its faction-pack artifact.",
      });
    }
    if (
      state.coverageStatus === "not-published" &&
      state.units.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["units"],
        message:
          "Not-published Legends coverage must have an empty inventory.",
      });
    }
  });

export type LegendSourceArtifact = z.infer<
  typeof LegendSourceArtifactSchema
>;
export type RuntimeLegendUnit = z.infer<
  typeof RuntimeLegendUnitSchema
>;
export type RuntimeFactionLegendsState = z.infer<
  typeof RuntimeFactionLegendsStateSchema
>;

export function unavailableFactionLegendsState(
  factionId: string,
): RuntimeFactionLegendsState {
  return {
    schemaVersion: 1,
    factionId,
    coverageStatus: "unavailable",
    classificationAuthority: "unavailable",
    sourceArtifacts: [],
    units: [],
  };
}

let activeFactionLegends = new Map<
  string,
  RuntimeFactionLegendsState
>();

export function activeFactionLegendsState(
  factionId: string,
): RuntimeFactionLegendsState {
  return structuredClone(
    activeFactionLegends.get(factionId) ??
      unavailableFactionLegendsState(factionId),
  );
}

export function activeLegendsInventory(): Record<
  string,
  RuntimeFactionLegendsState
> {
  return Object.fromEntries(
    [...activeFactionLegends.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([factionId, state]) => [
        factionId,
        structuredClone(state),
      ]),
  );
}

export function activateLegendsInventory(
  states: ReadonlyMap<string, RuntimeFactionLegendsState>,
): void {
  activeFactionLegends = new Map(
    [...states.entries()].map(([factionId, state]) => [
      factionId,
      RuntimeFactionLegendsStateSchema.parse(
        structuredClone(state),
      ),
    ]),
  );
}

export function resetActiveLegendsInventoryForTests(): void {
  activeFactionLegends = new Map();
}
