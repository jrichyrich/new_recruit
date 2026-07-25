import { z } from "zod";

export const ROSTER_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_GAME = "warhammer-40000-11e" as const;
export const SUPPORTED_FACTION_ID = "adeptus-custodes" as const;

export const PreferenceTagSchema = z.enum([
  "mobility",
  "durability",
  "objective",
  "shooting",
  "melee",
  "elite",
  "horde",
]);

export type PreferenceTag = z.infer<typeof PreferenceTagSchema>;

export type ResultEnvelope<T> = {
  ok: boolean;
  data: T | null;
  violations: RosterIssue[];
  warnings: RosterIssue[];
};

export type RosterIssue = {
  code: string;
  message: string;
  severity: "error" | "warn";
  selectionId?: string;
};

export const EquipmentSelectionSchema = z
  .object({
    itemId: z.string().min(1),
    name: z.string().min(1),
    count: z.number().int().nonnegative(),
  })
  .strict();

export type EquipmentSelection = z.infer<typeof EquipmentSelectionSchema>;

export const DraftUnitSchema = z
  .object({
    selectionId: z.string().min(1),
    unitId: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    modelCount: z.number().int().positive(),
    ordinal: z.number().int().positive(),
    points: z.number().int().nonnegative(),
    isWarlord: z.boolean(),
    enhancementId: z.string().min(1).nullable(),
    enhancementName: z.string().min(1).nullable(),
    equipment: z.array(EquipmentSelectionSchema),
    tags: z.array(PreferenceTagSchema),
  })
  .strict();

export type DraftUnit = z.infer<typeof DraftUnitSchema>;

export const RosterDraftV1Schema = z
  .object({
    schemaVersion: z.literal(ROSTER_SCHEMA_VERSION),
    gameSystem: z.literal(SUPPORTED_GAME),
    sourceData: z
      .object({
        package: z.literal("@alpaca-software/40kdc-data"),
        version: z.string().min(1),
        edition: z.literal("11th"),
        dataslate: z.string().min(1),
      })
      .strict(),
    id: z.string().min(1),
    name: z.string().min(1),
    factionId: z.string().min(1),
    factionName: z.string().min(1),
    pointsLimit: z.number().int().nonnegative(),
    totalPoints: z.number().int().nonnegative(),
    battleSize: z.enum(["incursion", "strike-force"]),
    detachmentId: z.string().min(1),
    detachmentName: z.string().min(1),
    forceDispositionId: z.string().min(1),
    forceDispositionName: z.string().min(1),
    preferences: z.array(PreferenceTagSchema),
    constraints: z
      .object({
        allowNamedCharacters: z.boolean(),
        allowLegends: z.boolean(),
        collectionUnitIds: z.array(z.string().min(1)).nullable(),
      })
      .strict(),
    units: z.array(DraftUnitSchema),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type RosterDraftV1 = z.infer<typeof RosterDraftV1Schema>;

export type BuildRosterInput = {
  prompt?: string;
  faction?: string;
  pointsLimit?: number;
  name?: string;
  preferences?: PreferenceTag[];
  allowNamedCharacters?: boolean;
  allowLegends?: boolean;
  collectionUnitIds?: string[];
  detachmentId?: string;
  forceDispositionId?: string;
};

export const ModifyRosterOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    unitId: z.string().min(1),
    modelCount: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("remove"),
    selectionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("replace"),
    selectionId: z.string().min(1),
    unitId: z.string().min(1),
    modelCount: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("set-model-count"),
    selectionId: z.string().min(1),
    modelCount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("set-warlord"),
    selectionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("set-equipment"),
    selectionId: z.string().min(1),
    equipment: z.array(
      z.object({
        itemId: z.string().min(1),
        count: z.number().int().nonnegative(),
      }),
    ),
  }),
  z.object({
    type: z.literal("set-enhancement"),
    selectionId: z.string().min(1),
    enhancementId: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("set-detachment"),
    detachmentId: z.string().min(1),
    forceDispositionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("set-disposition"),
    forceDispositionId: z.string().min(1),
  }),
]);

export type ModifyRosterOperation = z.infer<typeof ModifyRosterOperationSchema>;

export type ExportFormat =
  | "ros"
  | "rosz"
  | "newrecruit-json"
  | "roster-json"
  | "text"
  | "html";

export type ExportArtifact = {
  format: ExportFormat;
  filename: string;
  mimeType: string;
  encoding: "utf8" | "binary";
  content: string | Uint8Array;
};

export type UnitSummary = {
  id: string;
  name: string;
  factionId: string;
  role: string;
  pointsFrom: number;
  modelCounts: number[];
  tags: PreferenceTag[];
  keywords: string[];
  isNamedCharacter: boolean;
  isLegend: boolean;
  supported: boolean;
};

export type FactionSummary = {
  id: string;
  name: string;
  unitCount: number;
  supported: boolean;
  keywords: string[];
  styles: PreferenceTag[];
};

export type DataStatus = {
  package: "@alpaca-software/40kdc-data";
  packageVersion: string;
  edition: "11th";
  dataslate: string;
  supportedFactionIds: string[];
  factionCount: number;
  custodesUnitCount: number;
  provisionalCustodesPoints: number;
  attribution: {
    text: "Powered by 40kdc-data";
    url: "https://40kdc.alpacasoft.dev";
  };
};
