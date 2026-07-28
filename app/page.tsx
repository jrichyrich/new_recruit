"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";

import {
  buildRoster,
  exportRoster,
  getDataStatus,
  getNewRecruitCapability,
  listDetachments,
  modifyRoster,
  parseRosterDraft,
  prepareNewRecruitHandoff,
  searchFactions,
  searchUnits,
  validateRoster,
  type ExportArtifact,
  type ExportFormat,
  type FactionSummary,
  type NewRecruitHandoff,
  type LiveDataFreshness,
  type PreferenceTag,
  type RosterDraftV1,
  type UnitSummary,
} from "@/lib/rosterpilot";

const STORAGE_KEY = "rosterpilot.drafts.v2";
const LEGACY_STORAGE_KEY = "rosterpilot.drafts.v1";
const DEFAULT_RESULT = buildRoster({
  prompt: "Build a 1,000 point fast Custodes army with no named characters",
  name: "Golden Vanguard",
});
const DEFAULT_DRAFT = DEFAULT_RESULT.data as RosterDraftV1;
const DATA_STATUS = getDataStatus().data;

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

type DraftStore = {
  version: 2;
  drafts: RosterDraftV1[];
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
    const drafts = parsed.drafts.flatMap((value) => {
      const result = parseRosterDraft(value);
      return result.success ? [result.data] : [];
    });
    return drafts.length ? { version: 2, drafts } : null;
  } catch {
    return null;
  }
}

function freshnessMessage(freshness: LiveDataFreshness): string {
  if (freshness.state === "current") {
    return "Live source check: the pinned release is current.";
  }
  if (freshness.state === "official-update-pending") {
    return "Live source check: the official points source changed and is pending reconciliation.";
  }
  if (freshness.state === "update-available") {
    return "Live source check: newer rules or New Recruit data is available for review.";
  }
  return "Live source check was incomplete; this roster remains reproducible from its pinned release.";
}

export default function Home() {
  const [draft, setDraft] = useState<RosterDraftV1>(DEFAULT_DRAFT);
  const [history, setHistory] = useState<RosterDraftV1[]>([DEFAULT_DRAFT]);
  const [factionQuery, setFactionQuery] = useState("");
  const [unitQuery, setUnitQuery] = useState("");
  const [selectedFaction, setSelectedFaction] = useState("adeptus-custodes");
  const [prompt, setPrompt] = useState(PROMPT_IDEAS[0]);
  const [target, setTarget] = useState(1000);
  const [preferences, setPreferences] = useState<PreferenceTag[]>(["mobility"]);
  const [allowNamed, setAllowNamed] = useState(false);
  const [agentNote, setAgentNote] = useState(
    "A legal 1,000-point Custodes draft is ready. The engine calculated every point and loadout from pinned community data.",
  );
  const [copied, setCopied] = useState(false);
  const [newRecruitHandoff, setNewRecruitHandoff] =
    useState<NewRecruitHandoff | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      const stored = parseStoredDrafts();
      if (stored?.drafts.length) {
        setHistory(stored.drafts);
        setDraft(stored.drafts[0]);
        setTarget(stored.drafts[0].pointsLimit);
        setPreferences(stored.drafts[0].preferences);
        setSelectedFaction(stored.drafts[0].factionId);
      }
    }, 0);
    return () => window.clearTimeout(restore);
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

  const factionResult = useMemo(
    () => searchFactions(factionQuery, 40).data ?? [],
    [factionQuery],
  );
  const selectedFactionSummary = useMemo(
    () =>
      searchFactions(selectedFaction, 5).data?.find(
        (faction) => faction.id === selectedFaction,
      ),
    [selectedFaction],
  );
  const unitResult = useMemo(
    () =>
      searchUnits({
        faction: selectedFaction,
        query: unitQuery,
        includeLegends: false,
        limit: 12,
      }).data ?? [],
    [selectedFaction, unitQuery],
  );
  const validation = useMemo(() => validateRoster(draft), [draft]);
  const detachments = useMemo(() => listDetachments(draft.factionId), [draft.factionId]);
  const selectedDetachment = detachments.find(
    (detachment) => detachment.id === draft.detachmentId,
  );

  function commitDraft(next: RosterDraftV1, note?: string): void {
    setDraft(next);
    setNewRecruitHandoff(null);
    setHistory((current) => {
      const deduped = [next, ...current.filter((item) => item.id !== next.id)].slice(
        0,
        12,
      );
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

  function generateDraft(): void {
    const result = buildRoster({
      prompt,
      faction: selectedFaction,
      pointsLimit: target,
      preferences,
      allowNamedCharacters: allowNamed,
      name: `${target.toLocaleString()}pt ${
        selectedFactionSummary?.name ?? "Army"
      } Draft`,
    });
    if (!result.data) {
      setAgentNote(
        result.violations[0]?.message ??
          "The engine could not build that roster with the supplied constraints.",
      );
      return;
    }
    const buildNote = `${result.data.name} built at ${result.data.totalPoints}/${result.data.pointsLimit} points. ${
        result.ok
          ? "Deterministic validation passed."
          : "Review the validation issues before exporting."
      }`;
    commitDraft(result.data, `${buildNote} Checking live data sources…`);
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

  function applyModification(
    operation: Parameters<typeof modifyRoster>[1],
    successMessage: string,
  ): void {
    const result = modifyRoster(draft, operation);
    if (!result.data) {
      setAgentNote(result.violations[0]?.message ?? "That change could not be applied.");
      return;
    }
    commitDraft(
      result.data,
      `${successMessage} ${
        result.ok ? "The roster remains legal." : "The roster now needs attention."
      }`,
    );
  }

  function addUnit(unit: UnitSummary): void {
    if (selectedFaction !== draft.factionId) {
      setAgentNote(
        `${unit.name} belongs to the selected faction, but the active roster is ${draft.factionName}. Build the selected faction before adding units.`,
      );
      return;
    }
    applyModification(
      { type: "add", unitId: unit.id, modelCount: unit.modelCounts[0] },
      `${unit.name} added.`,
    );
  }

  function removeUnit(selectionId: string, name: string): void {
    applyModification({ type: "remove", selectionId }, `${name} removed.`);
  }

  function setModelCount(selectionId: string, modelCount: number): void {
    applyModification(
      { type: "set-model-count", selectionId, modelCount },
      "Model count updated.",
    );
  }

  function setDetachment(detachmentId: string): void {
    applyModification(
      { type: "set-detachment", detachmentId },
      "Detachment and compatible disposition updated.",
    );
  }

  function setDisposition(forceDispositionId: string): void {
    applyModification(
      { type: "set-disposition", forceDispositionId },
      "Force disposition updated.",
    );
  }

  async function handleExport(format: ExportFormat): Promise<void> {
    const result = await exportRoster(draft, format);
    if (!result.data) {
      setAgentNote(
        `Export blocked: ${result.violations.map((item) => item.message).join(" ")}`,
      );
      return;
    }
    downloadArtifact(result.data);
    setAgentNote(`${result.data.filename} downloaded and ready for handoff.`);
  }

  async function prepareNewRecruit(): Promise<void> {
    const result = await prepareNewRecruitHandoff(draft);
    if (!result.data) {
      setAgentNote(
        `New Recruit handoff blocked: ${result.violations.map((item) => item.message).join(" ")}`,
      );
      return;
    }
    const rosz = result.data.artifacts.find((artifact) => artifact.format === "rosz");
    if (!rosz) {
      setAgentNote("New Recruit handoff failed to produce a .rosz artifact.");
      return;
    }
    downloadArtifact(rosz);
    setNewRecruitHandoff(result.data);
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
      const parsed = parseRosterDraft(JSON.parse(await file.text()));
      if (!parsed.success) {
        throw new Error("Roster schema mismatch.");
      }
      const imported = parsed.data;
      const result = validateRoster(imported);
      commitDraft(
        imported,
        result.ok
          ? `${file.name} imported and validated${parsed.migrated ? " after upgrading its V1 provenance" : ""}.`
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

  const ready = validation.ok;
  const newRecruitCapability = getNewRecruitCapability(draft.factionId);
  const newRecruitMapped = newRecruitCapability.available;
  const remaining = draft.pointsLimit - draft.totalPoints;
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
          Release {DATA_STATUS?.sources.releaseId ?? "pinned"} · local engine
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
                  generateDraft();
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
            <div className="agent-actions">
              <div className="prompt-chips" aria-label="Prompt examples">
                {PROMPT_IDEAS.map((idea) => (
                  <button key={idea} type="button" onClick={() => setPrompt(idea)}>
                    {idea.split(" ").slice(0, 5).join(" ")}…
                  </button>
                ))}
              </div>
              <button className="primary-button" type="button" onClick={generateDraft}>
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
                const summary = searchUnits({
                  faction: draft.factionId,
                  query: selection.name,
                  includeLegends: true,
                  limit: 3,
                }).data?.find((unit) => unit.id === selection.unitId);
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
                        {(summary?.modelCounts ?? [selection.modelCount]).map(
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
            <div className="unit-grid">
              {unitResult.map((unit) => (
                <article className="unit-card" key={unit.id}>
                  <div className="unit-card-top">
                    <span>{unit.role}</span>
                    <strong>{unit.pointsFrom} pts+</strong>
                  </div>
                  <h3>{unit.name}</h3>
                  <p>
                    {unit.modelCounts.join(", ")} model options ·{" "}
                    {unit.isNamedCharacter ? "Epic Hero" : "standard datasheet"}
                  </p>
                  <div className="tag-row">
                    {unit.tags.slice(0, 5).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <button type="button" onClick={() => addUnit(unit)}>
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
                onClick={() => {
                  setDraft(item);
                  setNewRecruitHandoff(null);
                  setTarget(item.pointsLimit);
                  setPreferences(item.preferences);
                  setSelectedFaction(item.factionId);
                  setAgentNote(`${item.name} restored from local history.`);
                }}
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
            Rules {DATA_STATUS?.packageVersion} · BSData{" "}
            {DATA_STATUS?.sources.newRecruit.commit.slice(0, 8)} · MFM v
            {DATA_STATUS?.sources.official.mfmVersion}. Verify event-specific
            rulings before play.
          </p>
        </aside>
      </section>
    </main>
  );
}
