import { z } from "zod";

export const ROSTER_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_GAME = "warhammer-40000-11e" as const;
export const DEFAULT_FACTION_ID = "adeptus-custodes" as const;
/** @deprecated Use DEFAULT_FACTION_ID. Kept for persisted clients. */
export const SUPPORTED_FACTION_ID = DEFAULT_FACTION_ID;

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

const RosterDraftBodySchema = z.object({
  gameSystem: z.literal(SUPPORTED_GAME),
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
});

export const RosterDraftV1Schema = RosterDraftBodySchema.extend({
  schemaVersion: z.literal(1),
  sourceData: z
    .object({
      package: z.literal("@alpaca-software/40kdc-data"),
      version: z.string().min(1),
      edition: z.literal("11th"),
      dataslate: z.string().min(1),
    })
    .strict(),
}).strict();

export const RosterDraftV2Schema = RosterDraftBodySchema.extend({
  schemaVersion: z.literal(ROSTER_SCHEMA_VERSION),
  sourceData: z
    .object({
      package: z.literal("@alpaca-software/40kdc-data"),
      version: z.string().min(1),
      edition: z.literal("11th"),
      dataslate: z.string().min(1),
      releaseId: z.string().min(1),
      newRecruit: z
        .object({
          repository: z.literal("BSData/wh40k-11e"),
          commit: z.string().regex(/^[0-9a-f]{40}$/),
          gameSystemRevision: z.number().int().nonnegative(),
          catalogueRevision: z.number().int().nonnegative().nullable(),
        })
        .strict(),
      official: z
        .object({
          mfmVersion: z.string().min(1),
          updatedAt: z.string().min(1),
          contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
      migratedFrom: z.literal(1).optional(),
    })
    .strict(),
}).strict();

export const RosterDraftSchema = z.union([
  RosterDraftV2Schema,
  RosterDraftV1Schema,
]);

export type LegacyRosterDraftV1 = z.infer<typeof RosterDraftV1Schema>;
export type RosterDraftV2 = z.infer<typeof RosterDraftV2Schema>;
/** @deprecated Name retained for transport compatibility; new drafts are V2. */
export type RosterDraftV1 = RosterDraftV2;

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

export type NewRecruitHandoff = {
  rosterId: string;
  rosterName: string;
  totalPoints: number;
  pointsLimit: number;
  importUrl: "https://www.newrecruit.eu/app/MyLists";
  artifacts: ExportArtifact[];
  instructions: string[];
};

export type NewRecruitConnectionStatus = {
  available: boolean;
  platform: NodeJS.Platform;
  browserAvailable: boolean;
  brokerAvailable: boolean;
  credentialsConfigured: boolean;
  profileDirectory: string | null;
};

export type NewRecruitVerification = {
  name: boolean;
  faction: boolean;
  points: boolean;
  units: Array<{
    name: string;
    modelCount: number;
    matched: boolean;
  }>;
  mismatches: string[];
};

export type NewRecruitDelivery = {
  rosterId: string;
  rosterName: string;
  listUrl: string | null;
  imported: boolean;
  sessionReused: boolean;
  verification: NewRecruitVerification | null;
  artifacts: Array<{
    format: "rosz" | "new-recruit-pretty-html";
    filename: string;
    mimeType: string;
    written: string;
  }>;
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
  buildableFactionCount: number;
  unitCount: number;
  provisionalPoints: number;
  custodesUnitCount: number;
  provisionalCustodesPoints: number;
  attribution: {
    text: "Powered by 40kdc-data";
    url: "https://40kdc.alpacasoft.dev";
  };
  sources: {
    releaseId: string;
    rules: {
      package: "@alpaca-software/40kdc-data";
      version: string;
      edition: "11th";
      dataslate: string;
    };
    newRecruit: {
      repository: "BSData/wh40k-11e";
      commit: string;
      gameSystemRevision: number;
      generatedAt: string;
    };
    official: {
      mfmVersion: string;
      updatedAt: string;
      contentSha256: string;
      checkedAt: string;
    };
  };
  freshness: {
    state: "pinned" | "update-available" | "official-update-pending" | "unknown";
    checkedAt: string;
  };
  newRecruitCoverage: {
    factionCount: number;
    exportCapableFactions: number;
    completeFactions: number;
    engineUnits: number;
    mappedUnits: number;
    mappedBaseLoadouts: number;
  };
  conflicts: {
    total: number;
    blocking: number;
  };
};

export type LiveDataFreshness = {
  checkedAt: string;
  state: "current" | "update-available" | "official-update-pending" | "unknown";
  rules: {
    pinnedVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean | null;
  };
  newRecruit: {
    pinnedCommit: string;
    latestCommit: string | null;
    updateAvailable: boolean | null;
  };
  official: {
    pinnedVersion: string;
    latestVersion: string | null;
    pinnedContentSha256: string;
    latestContentSha256: string | null;
    updateAvailable: boolean | null;
  };
};
