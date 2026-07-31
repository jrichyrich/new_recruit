import type {
  DataStatus,
  ExportArtifact,
  FactionSummary,
  NewRecruitCapability,
  ResultEnvelope,
  RosterDataChangedScope,
  RosterDraftV1,
  UnitSummary,
  HostedDataBundleProviderInitializationResult,
} from "@/lib/rosterpilot";

export type BrowserDetachment = {
  id: string;
  name: string;
  detachmentPoints: number | null | undefined;
  forceDispositions: Array<{ id: string; name: string }>;
};

export type BrowserRosterWorkspace = {
  roster: RosterDraftV1;
  dataCompatibility: {
    status: "current" | "compatible-rebased" | "review-required";
    fromBundleId: string;
    toBundleId: string;
    provenanceChanged: boolean;
    changedScopes: RosterDataChangedScope[];
  };
  validation: ResultEnvelope<{
    legal: boolean;
    totalPoints: number;
  }>;
  detachments: BrowserDetachment[];
  newRecruitCapability: NewRecruitCapability;
  modelCountsByUnitId: Record<string, number[]>;
  migrated: boolean;
};

export type BrowserEngineBootstrap = {
  dataStatus: DataStatus;
  runtimeData: HostedDataBundleProviderInitializationResult;
  factions: FactionSummary[];
  units: UnitSummary[];
  selectedFaction: FactionSummary | null;
  workspace: BrowserRosterWorkspace;
};

export type BrowserEngineSearch = {
  factions: FactionSummary[];
  units: UnitSummary[];
  selectedFaction: FactionSummary | null;
};

export type SerializedBrowserArtifact = Omit<
  ExportArtifact,
  "content"
> & {
  content: string;
  transferEncoding: "utf8" | "base64";
};

export type BrowserEngineEnvelope<T> = ResultEnvelope<T>;
