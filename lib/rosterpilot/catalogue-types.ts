export type CatalogueSelectionReference = {
  name: string;
  normalizedName: string;
  type: "model" | "unit" | "upgrade";
  entryId: string;
  entryGroupId?: string;
  group?: string;
};

export type CatalogueCategoryReference = {
  name: string;
  entryId: string;
  primary: boolean;
};

export type CatalogueModelReference = CatalogueSelectionReference & {
  type: "model";
  equipment: CatalogueSelectionReference[];
};

export type CatalogueUnitReference = CatalogueSelectionReference & {
  categories: CatalogueCategoryReference[];
  directEquipment: CatalogueSelectionReference[];
  models: CatalogueModelReference[];
  warlord?: CatalogueSelectionReference;
  enhancements: Record<string, CatalogueSelectionReference>;
  pointsByModelCount: Record<string, number>;
};

export type NewRecruitConfiguration = {
  category: CatalogueCategoryReference;
  battleSize: {
    reference: CatalogueSelectionReference;
    choices: Record<
      "incursion" | "strike-force",
      CatalogueSelectionReference
    >;
  };
  detachment: {
    reference: CatalogueSelectionReference;
    choices: Record<
      string,
      CatalogueSelectionReference & { detachmentPoints: number }
    >;
  };
  forceDisposition: {
    reference: CatalogueSelectionReference;
    choices: Record<string, CatalogueSelectionReference>;
  };
};

export type DataConflict = {
  id: string;
  factionId: string;
  entityType:
    | "catalogue"
    | "unit"
    | "points"
    | "equipment"
    | "detachment"
    | "enhancement";
  entityId: string;
  entityName: string;
  code:
    | "MISSING_CATALOGUE"
    | "UNMAPPED"
    | "AMBIGUOUS"
    | "POINTS_MISMATCH"
    | "UNSUPPORTED";
  blocking: boolean;
  message: string;
  rulesValue?: string | number;
  newRecruitValue?: string | number;
};

export type NewRecruitFactionCatalogue = {
  factionId: string;
  factionName: string;
  sourceFile: string;
  catalogue: {
    id: string;
    name: string;
    revision: number;
  };
  configuration: NewRecruitConfiguration | null;
  units: Record<string, CatalogueUnitReference>;
  coverage: {
    engineUnits: number;
    mappedUnits: number;
    mappedBaseLoadouts: number;
    engineDetachments: number;
    mappedDetachments: number;
    complete: boolean;
  };
  conflicts: DataConflict[];
};

export type NewRecruitCatalogueManifest = {
  schemaVersion: 1;
  releaseId: string;
  generatedAt: string;
  sources: {
    rules: {
      package: "@alpaca-software/40kdc-data";
      version: string;
      edition: "11th";
      dataslate: string;
    };
    newRecruit: {
      repository: "BSData/wh40k-11e";
      branch: string;
      commit: string;
    };
    official: {
      downloadsUrl: string;
      mfmUrl: string;
      mfmVersion: string;
      updatedAt: string;
      contentSha256: string;
      checkedAt: string;
    };
  };
  gameSystem: {
    id: string;
    name: string;
    revision: number;
    battleScribeVersion: string;
    forceEntryId: string;
    pointsTypeId: string;
    detachmentPointsTypeId: string;
    xmlns: string;
  };
  factions: Record<string, NewRecruitFactionCatalogue>;
  summary: {
    factionCount: number;
    exportCapableFactions: number;
    completeFactions: number;
    engineUnits: number;
    mappedUnits: number;
    mappedBaseLoadouts: number;
    conflicts: number;
    blockingConflicts: number;
  };
};

export type NewRecruitFactionSummary = Omit<
  NewRecruitFactionCatalogue,
  "configuration" | "units"
> & {
  configurationAvailable: boolean;
};

export type NewRecruitCatalogueSummaryManifest = Omit<
  NewRecruitCatalogueManifest,
  "factions"
> & {
  factions: Record<string, NewRecruitFactionSummary>;
};
