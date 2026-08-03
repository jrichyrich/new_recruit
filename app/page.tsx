"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";

import {
  type BuildRosterInput,
  type ExportArtifact,
  type ExportFormat,
  type FactionSummary,
  type ModifyRosterOperation,
  type NewRecruitHandoff,
  type LiveDataFreshness,
  type LegendsPolicy,
  type PreferenceTag,
  type RosterIssue,
  type RosterDraftV1,
  type UnitSummary,
} from "@/lib/rosterpilot";
import type {
  BrowserEngineBootstrap,
  BrowserEngineEnvelope,
  BrowserEngineSearch,
  BrowserRosterWorkspace,
  SerializedBrowserArtifact,
} from "@/app/browser-engine-contract";

const STORAGE_KEY = "rosterpilot.drafts.v2";
const LEGACY_STORAGE_KEY = "rosterpilot.drafts.v1";
const PREFERENCES: Array<{ id: PreferenceTag; label: string }> = [
  { id: "mobility", label: "Mobility" },
  { id: "durability", label: "Durability" },
  { id: "objective", label: "Objectives" },
  { id: "shooting", label: "Shooting" },
  { id: "melee", label: "Melee" },
  { id: "elite", label: "Elite" },
];

const PROMPT_IDEAS = [
  "Build a 1,000 point fast Custodes army with no named characters",
  "Build a fast 1,000 point Aeldari army for objective play",
  "Build a durable 1,500 point Ork army with melee pressure",
];

type BrowserPlayContext =
  | "unspecified"
  | "open-play"
  | "casual"
  | "narrative"
  | "matched-play";

const LEGENDS_POLICIES: Array<{
  id: LegendsPolicy;
  label: string;
}> = [
  { id: "auto", label: "Check play context" },
  { id: "allow", label: "Allow Legends" },
  { id: "exclude", label: "Exclude Legends" },
];

const PLAY_CONTEXTS: Array<{
  id: BrowserPlayContext;
  label: string;
}> = [
  { id: "unspecified", label: "Unspecified" },
  { id: "open-play", label: "Open play" },
  { id: "casual", label: "Casual" },
  { id: "narrative", label: "Narrative" },
  { id: "matched-play", label: "Matched play" },
];

type DraftStore = {
  version: 2;
  drafts: RosterDraftV1[];
};

type SerializedBrowserHandoff = Omit<
  NewRecruitHandoff,
  "artifacts"
> & {
  artifacts: SerializedBrowserArtifact[];
};

function downloadArtifact(artifact: ExportArtifact): void {
  const blob = new Blob([artifact.content as BlobPart], {
    type: artifact.mimeType,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function decodedArtifact(
  artifact: SerializedBrowserArtifact,
): ExportArtifact {
  return {
    format: artifact.format,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    encoding: artifact.encoding,
    content:
      artifact.transferEncoding === "base64"
        ? Uint8Array.from(atob(artifact.content), (value) =>
            value.charCodeAt(0),
          )
        : artifact.content,
  };
}

async function browserEngineRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<BrowserEngineEnvelope<T>> {
  const response = await fetch(path, init);
  const result = (await response.json()) as BrowserEngineEnvelope<T>;
  if (!response.ok && result.violations.length === 0) {
    throw new Error(`Browser engine returned HTTP ${response.status}.`);
  }
  return result;
}

function factionMark(faction: FactionSummary): string {
  return faction.name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function factionColor(index: number): string {
  return ["#d9b84c", "#7ea5d8", "#8db56c", "#d47757", "#8c7bd1"][
    index % 5
  ];
}

function parseStoredDrafts(): DraftStore | null {
  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { drafts?: unknown[] };
    if (!Array.isArray(parsed.drafts)) return null;
    const drafts = parsed.drafts.filter(
      (value): value is RosterDraftV1 =>
        value !== null &&
        typeof value === "object" &&
        "id" in value &&
        "factionId" in value &&
        "pointsLimit" in value &&
        "selections" in value,
    );
    return drafts.length ? { version: 2, drafts } : null;
  } catch {
    return null;
  }
}

function freshnessMessage(freshness: LiveDataFreshness): string {
  if (freshness.state === "current") {
    return "Live source check: the active data bundle matches the latest checked sources.";
  }
  if (freshness.state === "official-update-pending") {
    return "Live source check: the official points source changed and is pending reconciliation.";
  }
  if (freshness.state === "update-available") {
    return "Live source check: newer rules or New Recruit data is available for review.";
  }
  return "Live source check was incomplete; this roster remains reproducible from its frozen data bundle.";
}

export type WebsiteDataReadinessItem = {
  id:
    | "snapshot"
    | "update-job"
    | "upstream"
    | "service-compatibility"
    | "official-reconciliation";
  label: string;
  title: string;
  detail: string;
  tone: "ready" | "warning";
};

function shortBrowserIdentity(value: string | null | undefined): string {
  if (!value) return "unknown";
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function websiteDataReadiness(
  bundle: BrowserEngineBootstrap["dataStatus"]["dataBundle"],
): WebsiteDataReadinessItem[] {
  const activeIdentity = shortBrowserIdentity(bundle.activeBundleId);
  const snapshot: WebsiteDataReadinessItem =
    bundle.dataTrust === "locally-verified"
      ? {
          id: "snapshot",
          label: "Roster snapshot",
          title: "Locally verified",
          detail: `Snapshot ${activeIdentity} is active for new roster work.`,
          tone: "ready",
        }
      : bundle.dataTrust === "signed-verified"
        ? {
            id: "snapshot",
            label: "Roster snapshot",
            title: "Signed verified",
            detail: `Hosted snapshot ${activeIdentity} is active for new roster work.`,
            tone: "ready",
          }
        : {
            id: "snapshot",
            label: "Roster snapshot",
            title: "Compiled data is ready",
            detail: `Snapshot ${activeIdentity} keeps roster building available while local data initializes.`,
            tone: "warning",
          };

  const localUpdate = bundle.localUpdate;
  let updateJob: WebsiteDataReadinessItem;
  if (!localUpdate) {
    updateJob = {
      id: "update-job",
      label: "Background update",
      title:
        bundle.providerMode === "signed-channel"
          ? "Hosted update channel"
          : "Waiting for the first check",
      detail:
        bundle.providerMode === "signed-channel"
          ? "This hosted deployment checks its configured signed channel without changing an open roster."
          : `No local update job is running. Snapshot ${activeIdentity} remains usable and the next due check can start in the background.`,
      tone: bundle.providerMode === "signed-channel" ? "ready" : "warning",
    };
  } else if (localUpdate.status === "activated") {
    updateJob = {
      id: "update-job",
      label: "Background update",
      title: "Update activated",
      detail: `Job ${localUpdate.jobId} finished. Snapshot ${activeIdentity} is the current snapshot.`,
      tone: "ready",
    };
  } else {
    updateJob = {
      id: "update-job",
      label: "Background update",
      title: `Update ${localUpdate.status}`,
      detail: `Job ${localUpdate.jobId}: ${localUpdate.progress} Snapshot ${activeIdentity} remains active until a candidate passes certification and activates.`,
      tone: "warning",
    };
  }

  const sourceStatus = bundle.sourceStatus;
  const upstream = sourceStatus?.latestUpstream;
  const certified = sourceStatus?.latestLocallyCertified;
  const upstreamObserved = Boolean(
    upstream &&
      (upstream.rulesVersion !== null ||
        upstream.newRecruitCommit !== null),
  );
  const upstreamCurrent = Boolean(
    upstream &&
      certified &&
      (upstream.rulesVersion === null ||
        upstream.rulesVersion === certified.rulesVersion) &&
      (upstream.newRecruitCommit === null ||
        upstream.newRecruitCommit === certified.newRecruitCommit),
  );
  const upstreamItem: WebsiteDataReadinessItem = upstreamCurrent
    ? {
        id: "upstream",
        label: "Upstream data",
        title: "Locally certified data is current",
        detail: "The latest checked 40kdc and BSData identities match the locally certified snapshot.",
        tone: "ready",
      }
    : upstreamObserved
      ? {
          id: "upstream",
          label: "Upstream data",
          title: "Upstream is newer",
          detail: "RosterPilot keeps the current snapshot active while the newer sources are built and certified in the background.",
          tone: "warning",
        }
      : {
          id: "upstream",
          label: "Upstream data",
          title: "Upstream check pending",
          detail: "The current snapshot remains usable even if the internet is unavailable or a source has not been checked yet.",
          tone: "warning",
        };

  const observations = bundle.serviceCompatibility ?? [];
  const missingCompatibility = observations.filter(
    (observation) => !observation.compatibleBundleId,
  );
  const serviceCompatibility: WebsiteDataReadinessItem =
    missingCompatibility.length === 0
      ? {
          id: "service-compatibility",
          label: "New Recruit and Tessera",
          title:
            observations.length === 0
              ? "No service mismatch observed"
              : "Service-compatible snapshot available",
          detail:
            observations.length === 0
              ? "RosterPilot records the exact catalogue identity when an external handoff is prepared; no mismatch has been observed yet."
              : `All ${observations.length} observed service ${observations.length === 1 ? "identity has" : "identities have"} an exact retained snapshot.`,
          tone: "ready",
        }
      : {
          id: "service-compatibility",
          label: "New Recruit and Tessera",
          title: "Compatibility repair needed",
          detail: `${missingCompatibility.length} observed service ${missingCompatibility.length === 1 ? "identity needs" : "identities need"} a matching snapshot. RosterPilot preserves the roster and receipts while it searches retained and historical sources.`,
          tone: "warning",
        };

  const officialState =
    sourceStatus?.officialReconciliation ?? "unavailable";
  const officialReconciliation: WebsiteDataReadinessItem =
    officialState === "verified"
      ? {
          id: "official-reconciliation",
          label: "Official source",
          title: "Official reconciliation verified",
          detail: "The active official-source overlay is verified separately from community and New Recruit data.",
          tone: "ready",
        }
      : officialState === "pending"
        ? {
            id: "official-reconciliation",
            label: "Official source",
            title: "Official reconciliation pending",
            detail: "A Games Workshop source changed. RosterPilot keeps the last usable values and does not claim the change is reconciled yet.",
            tone: "warning",
          }
        : {
            id: "official-reconciliation",
            label: "Official source",
            title: "Official reconciliation unavailable",
            detail: "Official-source authority could not be confirmed; this is reported separately from roster and service compatibility.",
            tone: "warning",
          };

  return [
    snapshot,
    updateJob,
    upstreamItem,
    serviceCompatibility,
    officialReconciliation,
  ];
}

export default function Home() {
  const [workspace, setWorkspace] =
    useState<BrowserRosterWorkspace | null>(null);
  const [dataStatus, setDataStatus] =
    useState<BrowserEngineBootstrap["dataStatus"] | null>(null);
  const [runtimeData, setRuntimeData] =
    useState<BrowserEngineBootstrap["runtimeData"] | null>(null);
  const [history, setHistory] = useState<RosterDraftV1[]>([]);
  const [factionResult, setFactionResult] = useState<FactionSummary[]>([]);
  const [unitResult, setUnitResult] = useState<UnitSummary[]>([]);
  const [unitSearchWarnings, setUnitSearchWarnings] = useState<
    RosterIssue[]
  >([]);
  const [selectedFactionSummary, setSelectedFactionSummary] =
    useState<FactionSummary | null>(null);
  const [factionQuery, setFactionQuery] = useState("");
  const [unitQuery, setUnitQuery] = useState("");
  const [selectedFaction, setSelectedFaction] = useState("adeptus-custodes");
  const [prompt, setPrompt] = useState(PROMPT_IDEAS[0]);
  const [target, setTarget] = useState(1000);
  const [preferences, setPreferences] = useState<PreferenceTag[]>(["mobility"]);
  const [allowNamed, setAllowNamed] = useState(false);
  const [legendsPolicy, setLegendsPolicy] =
    useState<LegendsPolicy>("auto");
  const [playContext, setPlayContext] =
    useState<BrowserPlayContext>("unspecified");
  const [showLegends, setShowLegends] = useState(false);
  const [agentNote, setAgentNote] = useState(
    "A legal 1,000-point Custodes draft is ready. The engine calculated every point and loadout from one frozen roster-data snapshot.",
  );
  const [copied, setCopied] = useState(false);
  const [newRecruitHandoff, setNewRecruitHandoff] =
    useState<NewRecruitHandoff | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void browserEngineRequest<BrowserEngineBootstrap>(
      "/api/browser-engine?bootstrap=true&selectedFaction=adeptus-custodes",
    )
      .then(async (result) => {
        if (cancelled || !result.data) {
          throw new Error(
            result.violations[0]?.message ??
              "The hosted roster engine did not return startup data.",
          );
        }
        let initialWorkspace = result.data.workspace;
        const stored = parseStoredDrafts();
        if (stored?.drafts.length) {
          setHistory(stored.drafts);
          const inspected = await browserEngineRequest<BrowserRosterWorkspace>(
            "/api/browser-engine",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "inspect",
                roster: stored.drafts[0],
              }),
            },
          );
          if (inspected.data) initialWorkspace = inspected.data;
        }
        if (cancelled) return;
        setDataStatus(result.data.dataStatus);
        setRuntimeData(result.data.runtimeData);
        setFactionResult(result.data.factions);
        setUnitResult(result.data.units);
        setSelectedFactionSummary(result.data.selectedFaction);
        setWorkspace(initialWorkspace);
        if (!stored?.drafts.length) {
          setHistory([initialWorkspace.roster]);
        }
        setTarget(initialWorkspace.roster.pointsLimit);
        setPreferences(initialWorkspace.roster.preferences);
        setSelectedFaction(initialWorkspace.roster.factionId);
      })
      .catch((error) => {
        if (!cancelled) {
          setAgentNote(
            error instanceof Error
              ? error.message
              : "The hosted roster engine is unavailable.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/data-freshness")
      .then((response) => response.json())
      .then((result: { data?: LiveDataFreshness | null }) => {
        if (!cancelled && result.data) {
          setAgentNote((current) => `${current} ${freshnessMessage(result.data!)}`);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgentNote(
            (current) =>
              `${current} Live source check was unavailable; the roster remains pinned.`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      const parameters = new URLSearchParams({
        factionQuery,
        selectedFaction,
        unitQuery,
        includeLegends: String(showLegends),
      });
      void browserEngineRequest<BrowserEngineSearch>(
        `/api/browser-engine?${parameters.toString()}`,
        { signal: controller.signal },
      )
        .then((result) => {
          setUnitSearchWarnings(result.warnings);
          if (!result.data) return;
          setFactionResult(result.data.factions);
          setUnitResult(result.data.units);
          setSelectedFactionSummary(result.data.selectedFaction);
        })
        .catch(() => {
          // Keep the last complete server snapshot while a search is retried.
        });
    }, 120);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    factionQuery,
    selectedFaction,
    showLegends,
    unitQuery,
    workspace,
  ]);

  const draft = workspace?.roster ?? null;
  const validation = workspace?.validation ?? null;
  const detachments = workspace?.detachments ?? [];
  const selectedDetachment = detachments.find(
    (detachment) => detachment.id === draft?.detachmentId,
  );

  function commitWorkspace(
    next: BrowserRosterWorkspace,
    note?: string,
  ): void {
    const roster = next.roster;
    setWorkspace(next);
    setNewRecruitHandoff(null);
    setHistory((current) => {
      const deduped = [
        roster,
        ...current.filter((item) => item.id !== roster.id),
      ].slice(0, 12);
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 2, drafts: deduped } satisfies DraftStore),
      );
      return deduped;
    });
    if (note) setAgentNote(note);
  }

  function togglePreference(preference: PreferenceTag): void {
    setPreferences((current) =>
      current.includes(preference)
        ? current.filter((item) => item !== preference)
        : [...current, preference],
    );
  }

  async function generateDraft(): Promise<void> {
    const input: BuildRosterInput = {
      prompt,
      faction: selectedFaction,
      pointsLimit: target,
      preferences,
      allowNamedCharacters: allowNamed,
      legendsPolicy,
      playContext: { kind: playContext },
      name: `${target.toLocaleString()}pt ${
        selectedFactionSummary?.name ?? "Army"
      } Draft`,
    };
    const result = await browserEngineRequest<BrowserRosterWorkspace>(
      "/api/browser-engine",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "build", input }),
      },
    );
    if (!result.data) {
      setAgentNote(
        result.violations[0]?.message ??
          "The engine could not build that roster with the supplied constraints.",
      );
      return;
    }
    const built = result.data.roster;
    const buildNote = `${built.name} built at ${built.totalPoints}/${built.pointsLimit} points. ${
      result.ok
          ? "Deterministic validation passed."
          : "Review the validation issues before exporting."
      }`;
    commitWorkspace(result.data, `${buildNote} Checking live data sources…`);
    void fetch("/api/data-freshness")
      .then((response) => response.json())
      .then((freshness: { data?: LiveDataFreshness | null }) => {
        setAgentNote(
          `${buildNote} ${
            freshness.data
              ? freshnessMessage(freshness.data)
              : "Live source check was unavailable; the roster remains pinned."
          }`,
        );
      })
      .catch(() => {
        setAgentNote(
          `${buildNote} Live source check was unavailable; the roster remains pinned.`,
        );
      });
  }

  async function applyModification(
    operation: ModifyRosterOperation,
    successMessage: string,
  ): Promise<void> {
    if (!draft) return;
    const result = await browserEngineRequest<BrowserRosterWorkspace>(
      "/api/browser-engine",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "modify", roster: draft, operation }),
      },
    );
    if (!result.data) {
      setAgentNote(result.violations[0]?.message ?? "That change could not be applied.");
      return;
    }
    commitWorkspace(
      result.data,
      `${successMessage} ${
        result.ok ? "The roster remains legal." : "The roster now needs attention."
      }`,
    );
  }

  function addUnit(unit: UnitSummary): void {
    if (!draft) return;
    if (!unit.supported || unit.modelCounts.length === 0) {
      setAgentNote(
        `${unit.name} is visible in the official Legends inventory, but complete deterministic build data is not available yet.`,
      );
      return;
    }
    if (selectedFaction !== draft.factionId) {
      setAgentNote(
        `${unit.name} belongs to the selected faction, but the active roster is ${draft.factionName}. Build the selected faction before adding units.`,
      );
      return;
    }
    void applyModification(
      { type: "add", unitId: unit.id, modelCount: unit.modelCounts[0] },
      `${unit.name} added.`,
    );
  }

  function removeUnit(selectionId: string, name: string): void {
    void applyModification({ type: "remove", selectionId }, `${name} removed.`);
  }

  function setModelCount(selectionId: string, modelCount: number): void {
    void applyModification(
      { type: "set-model-count", selectionId, modelCount },
      "Model count updated.",
    );
  }

  function setDetachment(detachmentId: string): void {
    void applyModification(
      { type: "set-detachment", detachmentId },
      "Detachment and compatible disposition updated.",
    );
  }

  function setDisposition(forceDispositionId: string): void {
    void applyModification(
      { type: "set-disposition", forceDispositionId },
      "Force disposition updated.",
    );
  }

  async function handleExport(format: ExportFormat): Promise<void> {
    if (!draft) return;
    const result = await browserEngineRequest<SerializedBrowserArtifact>(
      "/api/browser-engine",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "export", roster: draft, format }),
      },
    );
    if (!result.data) {
      setAgentNote(
        `Export blocked: ${result.violations.map((item) => item.message).join(" ")}`,
      );
      return;
    }
    const artifact = decodedArtifact(result.data);
    downloadArtifact(artifact);
    setAgentNote(`${result.data.filename} downloaded and ready for handoff.`);
  }

  async function prepareNewRecruit(): Promise<void> {
    if (!draft) return;
    const result = await browserEngineRequest<SerializedBrowserHandoff>(
      "/api/browser-engine",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "handoff", roster: draft }),
      },
    );
    if (!result.data) {
      setAgentNote(
        `New Recruit handoff blocked: ${result.violations.map((item) => item.message).join(" ")}`,
      );
      return;
    }
    const handoff: NewRecruitHandoff = {
      ...result.data,
      artifacts: result.data.artifacts.map(decodedArtifact),
    };
    const rosz = handoff.artifacts.find((artifact) => artifact.format === "rosz");
    if (!rosz) {
      setNewRecruitHandoff(handoff);
      setAgentNote(
        "New Recruit import is blocked for this data snapshot. Your legal roster was preserved; printable HTML, text, and canonical JSON remain available.",
      );
      return;
    }
    downloadArtifact(rosz);
    setNewRecruitHandoff(handoff);
    setAgentNote(
      `${rosz.filename} downloaded. Import it in New Recruit to create a new list copy.`,
    );
  }

  function downloadHandoffHtml(): void {
    const html = newRecruitHandoff?.artifacts.find(
      (artifact) => artifact.format === "html",
    );
    if (!html) {
      setAgentNote("No printable HTML artifact is available for this handoff.");
      return;
    }
    downloadArtifact(html);
    setAgentNote(`${html.filename} downloaded for printing.`);
  }

  async function copyRosterJson(): Promise<void> {
    await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function importDraft(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const result = await browserEngineRequest<BrowserRosterWorkspace>(
        "/api/browser-engine",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "inspect",
            roster: JSON.parse(await file.text()),
          }),
        },
      );
      if (!result.data) throw new Error("Roster schema mismatch.");
      const imported = result.data.roster;
      commitWorkspace(
        result.data,
        result.ok
          ? `${file.name} imported and validated${result.data.migrated ? " after upgrading its provenance" : ""}.`
          : `${file.name} imported with ${result.violations.length} issue(s).`,
      );
      setSelectedFaction(imported.factionId);
      setTarget(imported.pointsLimit);
      setPreferences(imported.preferences);
    } catch {
      setAgentNote(
        "Import failed. Choose a RosterPilot roster JSON file; New Recruit .ros/.rosz files are used as outbound handoffs in v1.",
      );
    } finally {
      event.target.value = "";
    }
  }

  async function restoreDraft(roster: RosterDraftV1): Promise<void> {
    const result = await browserEngineRequest<BrowserRosterWorkspace>(
      "/api/browser-engine",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect", roster }),
      },
    );
    if (!result.data) {
      setAgentNote(
        result.violations[0]?.message ??
          "That saved roster cannot be opened with the active data bundle.",
      );
      return;
    }
    setWorkspace(result.data);
    setNewRecruitHandoff(null);
    setTarget(result.data.roster.pointsLimit);
    setPreferences(result.data.roster.preferences);
    setSelectedFaction(result.data.roster.factionId);
    setAgentNote(`${result.data.roster.name} restored from local history.`);
  }

  if (!draft || !validation || !workspace || !dataStatus || !runtimeData) {
    return (
      <main className="app-shell">
        <section className="hero-copy">
          <span className="eyebrow">RosterPilot · active data snapshot</span>
          <h1>Build the army you mean to play.</h1>
          <p>
            Loading the current verified roster engine for Adeptus Custodes and
            every supported faction.
          </p>
          <p>
            One roster, three independent paths: build, New Recruit, and
            Compare in Tessera.
          </p>
          <p>Powered by 40kdc-data</p>
          <p>{agentNote}</p>
        </section>
      </main>
    );
  }

  const ready = validation.ok;
  const newRecruitCapability = workspace.newRecruitCapability;
  const newRecruitMapped = newRecruitCapability.available;
  const remaining = draft.pointsLimit - draft.totalPoints;
  const dataReadiness = websiteDataReadiness(dataStatus.dataBundle);
  const rosterCommand = `Build or review "${draft.name}" as a ${draft.pointsLimit}-point ${draft.factionName} roster. Validate it before making any legality claim, then ${
    newRecruitMapped
      ? "export .rosz for New Recruit"
      : "export printable HTML or roster JSON; New Recruit catalogue mapping is not yet available for this faction"
  }.`;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            RP
          </div>
          <div>
            <span className="eyebrow">Command desk</span>
            <strong>RosterPilot</strong>
          </div>
        </div>
        <nav aria-label="Primary navigation">
          <a className="nav-link active" href="#builder">
            Builder
          </a>
          <a className="nav-link" href="#workflows">
            Workflows
          </a>
          <a className="nav-link" href="#exports">
            Exports
          </a>
        </nav>
        <div className="status-pill">
          <span className="status-dot" />
          Release {dataStatus.sources.releaseId ?? "pinned"} ·{" "}
          {runtimeData.source !== "compiled-unverified"
            ? runtimeData.durability.mode === "persistent"
              ? runtimeData.source === "locally-verified"
                ? "locally verified durable data"
                : "verified durable server data"
              : runtimeData.source === "locally-verified"
                ? "locally verified data"
                : "verified server data"
            : "compiled data while updates initialize"}
        </div>
      </header>

      <section className="workspace" id="builder">
        <aside className="faction-rail" id="factions">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Armory</span>
              <h2>Explore factions</h2>
            </div>
            <span className="count-badge">{factionResult.length}</span>
          </div>
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search factions"
              placeholder="Name, keyword, alliance…"
              value={factionQuery}
              onChange={(event) => setFactionQuery(event.target.value)}
            />
          </label>
          <div className="faction-list">
            {factionResult.map((faction, index) => (
              <button
                className={`faction-card ${
                  faction.id === selectedFaction ? "selected" : ""
                }`}
                key={faction.id}
                onClick={() => {
                  setSelectedFaction(faction.id);
                  setUnitQuery("");
                  setAgentNote(
                    faction.supported
                      ? `${faction.name} deterministic roster building is enabled.`
                      : `${faction.name} is available for research, but its priced-unit or detachment coverage is incomplete.`,
                  );
                }}
                type="button"
              >
                <span
                  className="faction-mark"
                  style={
                    {
                      "--faction-color": factionColor(index),
                    } as CSSProperties
                  }
                >
                  {factionMark(faction)}
                </span>
                <span className="faction-copy">
                  <strong>{faction.name}</strong>
                  <small>
                    {faction.styles.slice(0, 2).join(" · ") || "research"} ·{" "}
                    {faction.unitCount} units
                  </small>
                </span>
                <span
                  className={faction.supported ? "support-dot supported" : "support-dot"}
                  title={faction.supported ? "Build supported" : "Research only"}
                />
              </button>
            ))}
          </div>
          <p className="data-note">
            Browse and build every faction whose priced units and matched-play
            detachments pass the deterministic coverage gate.
          </p>
        </aside>

        <section className="command-column">
          <div className="hero-copy">
            <span className="eyebrow">
              Warhammer 40,000 11th · deterministic planning
            </span>
            <h1>Build the army you mean to play.</h1>
            <p>
              Describe the feel, faction, and point limit. The shared engine turns
              it into an editable roster, calculates every point, validates the
              construction rules, and can optionally prepare a New Recruit
              handoff.
            </p>
          </div>

          <section
            className="workflow-map"
            id="workflows"
            aria-labelledby="workflow-title"
          >
            <div className="workflow-map-heading">
              <div>
                <span className="eyebrow">Choose your finish line</span>
                <h2 id="workflow-title">One roster, three independent paths</h2>
              </div>
              <span>Nothing continues automatically</span>
            </div>
            <div className="workflow-grid">
              <article>
                <span className="workflow-number">01</span>
                <strong>Build and keep</strong>
                <p>
                  Validate, print, or save RosterPilot JSON. No account or
                  external service is required.
                </p>
                <a href="#roster-title">Build a roster</a>
              </article>
              <article>
                <span className="workflow-number">02</span>
                <strong>Send to New Recruit</strong>
                <p>
                  Download a mapped `.rosz` here, or use the optional local
                  macOS companion for a verified upload.
                </p>
                <a href="#exports">Prepare a handoff</a>
              </article>
              <article>
                <span className="workflow-number">03</span>
                <strong>Compare in Tessera</strong>
                <p>
                  Use two armies through the local CLI or MCP to capture
                  directional simulations and an interactive report.
                </p>
                <span className="workflow-surface">Local CLI or MCP</span>
              </article>
            </div>
            <div
              aria-label="Roster data readiness"
              className="data-readiness-list"
            >
              {dataReadiness.map((item) => (
                <div
                  className={`data-recovery-status ${
                    item.tone === "ready" ? "ready" : ""
                  }`}
                  data-readiness={item.id}
                  key={item.id}
                >
                  <span aria-hidden="true">
                    {item.tone === "ready" ? "✓" : "!"}
                  </span>
                  <div>
                    <small>{item.label}</small>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="agent-card">
            <div className="agent-label">
              <span className="agent-avatar" aria-hidden="true">
                A
              </span>
              <div>
                <strong>Ask the roster agent</strong>
                <small>Natural language → structured constraints</small>
              </div>
              <kbd>⌘ ↵</kbd>
            </div>
            <textarea
              aria-label="Describe the army you want"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  void generateDraft();
                }
              }}
            />
            <div className="preference-grid" aria-label="Roster preferences">
              {PREFERENCES.map((preference) => (
                <button
                  className={
                    preferences.includes(preference.id) ? "selected" : ""
                  }
                  key={preference.id}
                  type="button"
                  aria-pressed={preferences.includes(preference.id)}
                  onClick={() => togglePreference(preference.id)}
                >
                  {preference.label}
                </button>
              ))}
              <label className="named-toggle">
                <input
                  type="checkbox"
                  checked={allowNamed}
                  onChange={(event) => setAllowNamed(event.target.checked)}
                />
                Named characters
              </label>
            </div>
            <div
              className="configuration-row legends-controls"
              aria-label="Legends roster policy"
            >
              <label>
                <span>Legends policy</span>
                <select
                  aria-label="Legends policy"
                  value={legendsPolicy}
                  onChange={(event) =>
                    setLegendsPolicy(event.target.value as LegendsPolicy)
                  }
                >
                  {LEGENDS_POLICIES.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Play context</span>
                <select
                  aria-label="Play context"
                  value={playContext}
                  onChange={(event) =>
                    setPlayContext(
                      event.target.value as BrowserPlayContext,
                    )
                  }
                >
                  {PLAY_CONTEXTS.map((context) => (
                    <option key={context.id} value={context.id}>
                      {context.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="agent-actions">
              <div className="prompt-chips" aria-label="Prompt examples">
                {PROMPT_IDEAS.map((idea) => (
                  <button key={idea} type="button" onClick={() => setPrompt(idea)}>
                    {idea.split(" ").slice(0, 5).join(" ")}…
                  </button>
                ))}
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={() => void generateDraft()}
              >
                Build draft <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>

          <div className="agent-response" role="status">
            <span className="response-kicker">Agent note</span>
            <p>{agentNote}</p>
          </div>

          <section className="roster-panel" aria-labelledby="roster-title">
            <div className="roster-header">
              <div>
                <span className="eyebrow">Active roster</span>
                <h2 id="roster-title">{draft.name}</h2>
                <p className="roster-subtitle">
                  {draft.detachmentName} · {draft.forceDispositionName}
                </p>
              </div>
              <div className="points-target">
                <span>{draft.totalPoints.toLocaleString()}</span>
                <small>/ {draft.pointsLimit.toLocaleString()} pts</small>
              </div>
            </div>

            <div className="target-row">
              <span>Game size</span>
              <div>
                {[500, 1000, 1500, 2000].map((size) => (
                  <button
                    className={target === size ? "active" : ""}
                    key={size}
                    onClick={() => setTarget(size)}
                    type="button"
                  >
                    {size.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            <div className="configuration-row">
              <label>
                <span>Detachment</span>
                <select
                  value={draft.detachmentId}
                  onChange={(event) => setDetachment(event.target.value)}
                >
                  {detachments.map((detachment) => (
                    <option key={detachment.id} value={detachment.id}>
                      {detachment.name} ({detachment.detachmentPoints} DP)
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Disposition</span>
                <select
                  value={draft.forceDispositionId}
                  onChange={(event) => setDisposition(event.target.value)}
                >
                  {(selectedDetachment?.forceDispositions ?? []).map(
                    (disposition) => (
                      <option key={disposition.id} value={disposition.id}>
                        {disposition.name}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>

            <div className="roster-list">
              {draft.units.map((selection) => {
                return (
                  <article className="roster-row" key={selection.selectionId}>
                    <div className="role-token">
                      {selection.isWarlord
                        ? "★"
                        : selection.role.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="unit-main">
                      <strong>{selection.name}</strong>
                      <span>
                        {selection.role} · {selection.equipment
                          .slice(0, 2)
                          .map((item) => item.name)
                          .join(", ")}
                      </span>
                    </div>
                    <label className="model-select">
                      <span className="sr-only">Models for {selection.name}</span>
                      <select
                        value={selection.modelCount}
                        onChange={(event) =>
                          setModelCount(
                            selection.selectionId,
                            Number(event.target.value),
                          )
                        }
                      >
                        {(workspace.modelCountsByUnitId[selection.unitId] ?? [selection.modelCount]).map(
                          (count) => (
                            <option key={count} value={count}>
                              {count} models
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <strong className="unit-points">{selection.points}</strong>
                    <button
                      className="remove-unit"
                      type="button"
                      aria-label={`Remove ${selection.name}`}
                      onClick={() =>
                        removeUnit(selection.selectionId, selection.name)
                      }
                    >
                      ×
                    </button>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="catalog-panel" aria-labelledby="catalog-title">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Field guide</span>
                <h2 id="catalog-title">Search real units</h2>
              </div>
              <span className="subtle-label">{unitResult.length} matches</span>
            </div>
            <label className="search-box unit-search">
              <span aria-hidden="true">⌕</span>
              <input
                aria-label="Search units"
                placeholder="Unit, role, keyword, style…"
                value={unitQuery}
                onChange={(event) => setUnitQuery(event.target.value)}
              />
            </label>
            <label className="named-toggle legends-visibility-toggle">
              <input
                type="checkbox"
                checked={showLegends}
                onChange={(event) =>
                  setShowLegends(event.target.checked)
                }
              />
              Show Legends
            </label>
            {unitSearchWarnings.length > 0 && (
              <div
                className="check-list catalog-warning-list"
                role="status"
                aria-live="polite"
                aria-label="Unit search warnings"
              >
                {unitSearchWarnings.map((warning) => (
                  <div className="neutral" key={warning.code}>
                    <span>→</span>
                    <p>
                      <strong>{warning.code.replaceAll("_", " ")}</strong>
                      <small>{warning.message}</small>
                    </p>
                  </div>
                ))}
              </div>
            )}
            <div className="unit-grid">
              {unitResult.map((unit) => (
                <article className="unit-card" key={unit.id}>
                  <div className="unit-card-top">
                    <span>{unit.role}</span>
                    <strong>
                      {unit.pointsKnown
                        ? `${unit.pointsFrom} pts+`
                        : "Official card"}
                    </strong>
                  </div>
                  <h3>{unit.name}</h3>
                  <p>
                    {unit.modelCounts.length > 0
                      ? `${unit.modelCounts.join(", ")} model options`
                      : "Inventory only"}{" "}
                    ·{" "}
                    {unit.isLegend
                      ? "Legends datasheet"
                      : unit.isNamedCharacter
                        ? "Epic Hero"
                        : "standard datasheet"}
                  </p>
                  {unit.legendProvenance && (
                    <p>
                      Verified Games Workshop source:{" "}
                      <a
                        href={
                          unit.legendProvenance.datasheetUrl ??
                          unit.legendProvenance.url
                        }
                        target="_blank"
                        rel="noreferrer"
                        title={`SHA-256 ${unit.legendProvenance.contentSha256}`}
                      >
                        {unit.legendProvenance.sourceId}
                      </a>{" "}
                      · {unit.legendProvenance.version}
                    </p>
                  )}
                  <div className="tag-row">
                    {unit.tags.slice(0, 5).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={!unit.supported}
                    onClick={() => addUnit(unit)}
                  >
                    {unit.supported ? "Add to roster" : "Research only"}{" "}
                    <span aria-hidden="true">＋</span>
                  </button>
                </article>
              ))}
            </div>
          </section>
        </section>

        <aside className="inspector" id="exports">
          <section className="inspector-block">
            <span className="eyebrow">Readiness</span>
            <div className={`readiness ${ready ? "ready" : ""}`}>
              <div className="readiness-ring">{ready ? "✓" : "!"}</div>
              <div>
                <strong>{ready ? "Roster legal" : "Needs attention"}</strong>
                <small>
                  {ready
                    ? `${remaining} points remain`
                    : `${validation.violations.length} blocking issue(s)`}
                </small>
              </div>
            </div>
            <div className="check-list">
              {validation.violations.map((item) => (
                <div className="warn" key={`${item.code}-${item.selectionId ?? ""}`}>
                  <span>!</span>
                  <p>
                    <strong>{item.code.replaceAll("_", " ")}</strong>
                    <small>{item.message}</small>
                  </p>
                </div>
              ))}
              {validation.warnings.map((item) => (
                <div className="neutral" key={item.code}>
                  <span>→</span>
                  <p>
                    <strong>{item.code.replaceAll("_", " ")}</strong>
                    <small>{item.message}</small>
                  </p>
                </div>
              ))}
              {ready && (
                <div className="pass">
                  <span>✓</span>
                  <p>
                    <strong>Deterministic validation</strong>
                    <small>Passed</small>
                  </p>
                </div>
              )}
            </div>
          </section>

          <section className="inspector-block export-block">
            <span className="eyebrow">Export desk</span>
            <h2>Take the list with you</h2>
            <p>
              Printable HTML, text, and JSON work for every validated faction.
              New Recruit `.ros/.rosz` currently requires a mapped catalogue.
            </p>
            <div className="export-grid">
              {(
                [
                  ["rosz", "ROSZ", "New Recruit"],
                  ["ros", "ROS", "BattleScribe"],
                  ["newrecruit-json", "{ }", "NR JSON"],
                  ["html", "HTML", "Print"],
                  ["text", "TXT", "Plain text"],
                  ["roster-json", "RP", "RosterPilot"],
                ] as Array<[ExportFormat, string, string]>
              ).map(([format, icon, label]) => (
                <button
                  key={format}
                  type="button"
                  disabled={
                    !ready ||
                    ((format === "ros" || format === "rosz") &&
                      !newRecruitMapped)
                  }
                  onClick={() => void handleExport(format)}
                >
                  <span aria-hidden="true">{icon}</span>
                  {label}
                </button>
              ))}
            </div>
            <div className="import-actions">
              <input
                ref={importRef}
                className="sr-only"
                type="file"
                accept=".json,application/json"
                onChange={importDraft}
              />
              <button type="button" onClick={() => importRef.current?.click()}>
                Import RosterPilot JSON
              </button>
              <button type="button" onClick={copyRosterJson}>
                {copied ? "Copied" : "Copy roster JSON"}
              </button>
            </div>
            <div className={`new-recruit-flow ${newRecruitHandoff ? "ready" : ""}`}>
              <div>
                <strong>New Recruit handoff</strong>
                <small>
                  {newRecruitMapped
                    ? newRecruitCapability.complete
                      ? "Complete catalogue mapping · creates a new list copy"
                      : "Selected rosters export when all references are conflict-free"
                    : newRecruitCapability.reason ??
                      "Catalogue mapping unavailable for this faction"}
                </small>
              </div>
              <button
                type="button"
                disabled={!ready || !newRecruitMapped}
                onClick={() => void prepareNewRecruit()}
              >
                Download &amp; prepare
              </button>
              {newRecruitHandoff && (
                <div className="new-recruit-flow-actions">
                  <a
                    href={newRecruitHandoff.importUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open My Lists <span aria-hidden="true">↗</span>
                  </a>
                  <button type="button" onClick={downloadHandoffHtml}>
                    Download printable HTML
                  </button>
                </div>
              )}
              <p>
                RosterPilot never reads New Recruit credentials or replaces an
                existing list.
              </p>
            </div>
          </section>

          <section className="handoff-card">
            <div className="handoff-heading">
              <span className="nr-mark" aria-hidden="true">
                AI
              </span>
              <div>
                <strong>Agent handoff</strong>
                <small>Codex · Claude · MCP clients</small>
              </div>
            </div>
            <p>{rosterCommand}</p>
            <button
              className="copy-button"
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(rosterCommand);
                setAgentNote("Agent command copied.");
              }}
            >
              Copy agent command
            </button>
            <a
              href="https://www.newrecruit.eu/app/MyLists"
              target="_blank"
              rel="noreferrer"
            >
              Open New Recruit <span aria-hidden="true">↗</span>
            </a>
          </section>

          <section className="history-card" aria-labelledby="history-title">
            <span className="eyebrow" id="history-title">
              Local draft history
            </span>
            {history.slice(0, 5).map((item) => (
              <button
                key={`${item.id}-${item.updatedAt}`}
                type="button"
                className={item.updatedAt === draft.updatedAt ? "active" : ""}
                onClick={() => void restoreDraft(item)}
              >
                <span>{item.name}</span>
                <small>
                  {item.totalPoints}/{item.pointsLimit} pts
                </small>
              </button>
            ))}
          </section>

          <div className="privacy-note">
            <span aria-hidden="true">◉</span>
            <p>
              <strong>Private by default</strong>
              <small>Drafts stay in this browser. No account or cloud roster DB.</small>
            </p>
          </div>
          <a
            className="attribution"
            href="https://40kdc.alpacasoft.dev"
            target="_blank"
            rel="noreferrer"
          >
            Powered by 40kdc-data
          </a>
          <p className="source-caveat">
            Rules {dataStatus.packageVersion} · BSData{" "}
            {dataStatus.sources.newRecruit.commit.slice(0, 8)} · MFM v
            {dataStatus.sources.official.mfmVersion}. Verify event-specific
            rulings before play.
          </p>
        </aside>
      </section>
    </main>
  );
}
