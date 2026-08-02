export type CatalogueSelectionReference = {
  name: string;
  normalizedName: string;
  type: "model" | "unit" | "upgrade";
  entryId: string;
  entryGroupId?: string;
  group?: string;
  /**
   * Identifies a mutually exclusive parent loadout choice when BSData repeats
   * the same equipment name beneath sibling choices. The resolver uses this
   * only to keep a selected equipment set on one coherent branch; it is not
   * serialized as a New Recruit selection attribute.
   */
  loadoutChoiceId?: string;
};

export type CatalogueCategoryReference = {
  name: string;
  entryId: string;
  primary: boolean;
};

/**
 * A catalogue-authored classification hint retained for reconciliation and
 * diagnostics. These signals never decide RosterPilot legality or whether a
 * unit is a Legend; the active runtime rules snapshot remains authoritative.
 */
export type CatalogueClassificationSignal = {
  source: "bsdata";
  classification: "legend";
  kind:
    | "entry-link-name"
    | "selection-entry-name"
    | "category"
    | "modifier-comment";
  value: string;
  entryPath: string;
};

/**
 * A BSData unit candidate retained even when no structured-rules unit maps to
 * it. This is non-authoritative cross-check evidence for reconciling the
 * official Legends inventory; deliberately no effective `isLegend` boolean is
 * stored here.
 */
export type CatalogueLegendCandidateEvidence = {
  source: "bsdata";
  name: string;
  normalizedName: string;
  catalogueId: string;
  catalogueRevision: number;
  targetId: string;
  entryPath: string;
  signals: CatalogueClassificationSignal[];
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
  classificationSignals?: CatalogueClassificationSignal[];
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
      CatalogueSelectionReference & {
        detachmentPoints: number;
        /**
         * Detachment choices can be contributed by different imported
         * catalogues. Older manifests used one global parent reference; v2
         * records the exact parent for each choice so the ROS hierarchy stays
         * on the path that was actually reconciled.
         */
        rootReference?: CatalogueSelectionReference;
      }
    >;
  };
  forceDisposition: {
    reference: CatalogueSelectionReference;
    choices: Record<string, CatalogueSelectionReference>;
  };
  /**
   * Optional because ordinary rosters do not need this branch. Export fails
   * closed if a runtime-classified Legends unit is selected and the exact
   * Show/Hide Options -> Legends are visible path was not reconciled.
   */
  legendsVisibility?: {
    parent: CatalogueSelectionReference;
    choice: CatalogueSelectionReference;
  };
};

export type DataConflict = {
  id: string;
  /**
   * Stable across factions when the same shared catalogue/rules mismatch is
   * encountered more than once. Schema-v1 manifests do not contain this.
   */
  rootCauseKey?: string;
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
    | "POINTS_EVALUATION_UNSUPPORTED"
    | "STALE_OVERRIDE"
    | "UNSUPPORTED";
  blocking: boolean;
  message: string;
  rulesValue?: string | number;
  newRecruitValue?: string | number;
  source?: "rules" | "bsdata" | "reconciler";
  scope?: {
    modelCount?: number;
    unitOrdinalMin?: number;
    unitOrdinalMax?: number | null;
    equipmentItemId?: string;
    equipmentSignature?: string;
    entryPath?: string;
    selectionScopes?: Array<{
      modelCount: number;
      unitOrdinalMin?: number;
      unitOrdinalMax?: number | null;
      equipmentSignature?: string;
    }>;
  };
  catalogue?: {
    id: string;
    revision: number;
    entryPath?: string;
  };
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
  classificationEvidence?: {
    legendCandidates: CatalogueLegendCandidateEvidence[];
  };
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
  schemaVersion: 1 | 2;
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
    /**
     * Available in schema v2. Compatibility readers derive the value from
     * conflict ids when reading schema-v1 data.
     */
    uniqueConflicts?: number;
    uniqueBlockingConflicts?: number;
  };
};

export type NewRecruitFactionSummary = Omit<
  NewRecruitFactionCatalogue,
  "configuration" | "units" | "classificationEvidence"
> & {
  configurationAvailable: boolean;
};

export type NewRecruitCatalogueSummaryManifest = Omit<
  NewRecruitCatalogueManifest,
  "factions"
> & {
  factions: Record<string, NewRecruitFactionSummary>;
};
