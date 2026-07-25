"use client";

import { useMemo, useState } from "react";

type Unit = {
  name: string;
  role: "Character" | "Battleline" | "Infantry" | "Mounted" | "Vehicle";
  points: number;
  tags: string[];
  note: string;
};

type Faction = {
  name: string;
  alliance: "Imperium" | "Chaos" | "Xenos";
  mark: string;
  color: string;
  summary: string;
  styles: string[];
  units: Unit[];
};

type RosterEntry = Unit & { id: number; quantity: number };

const factions: Faction[] = [
  {
    name: "Adeptus Custodes",
    alliance: "Imperium",
    mark: "AC",
    color: "#e2b84b",
    summary: "A compact force of elite warriors that rewards deliberate movement.",
    styles: ["Elite", "Durable", "Melee"],
    units: [
      { name: "Blade Champion", role: "Character", points: 110, tags: ["melee", "leader"], note: "Aggressive duelist and unit leader." },
      { name: "Custodian Guard", role: "Battleline", points: 180, tags: ["durable", "objective"], note: "Reliable objective holders." },
      { name: "Allarus Custodians", role: "Infantry", points: 195, tags: ["elite", "deep strike"], note: "Flexible heavy infantry." },
      { name: "Vertus Praetors", role: "Mounted", points: 145, tags: ["fast", "pressure"], note: "Fast pressure and flanking unit." },
    ],
  },
  {
    name: "Space Marines",
    alliance: "Imperium",
    mark: "SM",
    color: "#5d8fd8",
    summary: "A flexible tool kit with answers for nearly every battlefield problem.",
    styles: ["Flexible", "Elite", "Combined arms"],
    units: [
      { name: "Captain", role: "Character", points: 80, tags: ["leader", "flexible"], note: "Efficient all-round leader." },
      { name: "Intercessor Squad", role: "Battleline", points: 80, tags: ["objective", "flexible"], note: "Dependable scoring infantry." },
      { name: "Inceptor Squad", role: "Infantry", points: 120, tags: ["fast", "deep strike"], note: "Mobile reserve threat." },
      { name: "Redemptor Dreadnought", role: "Vehicle", points: 210, tags: ["durable", "shooting"], note: "Heavy multi-role anchor." },
    ],
  },
  {
    name: "Astra Militarum",
    alliance: "Imperium",
    mark: "AM",
    color: "#7f9567",
    summary: "Massed soldiers, orders, and armored support working as one machine.",
    styles: ["Shooting", "Horde", "Combined arms"],
    units: [
      { name: "Cadian Command Squad", role: "Character", points: 65, tags: ["leader", "support"], note: "Issues orders and supports the line." },
      { name: "Infantry Squad", role: "Battleline", points: 60, tags: ["objective", "horde"], note: "Low-cost board control." },
      { name: "Kasrkin", role: "Infantry", points: 100, tags: ["elite", "shooting"], note: "Specialist infantry firepower." },
      { name: "Leman Russ", role: "Vehicle", points: 170, tags: ["durable", "shooting"], note: "Armored fire-support platform." },
    ],
  },
  {
    name: "Orks",
    alliance: "Xenos",
    mark: "OK",
    color: "#91bd58",
    summary: "A loud, direct army built around momentum, numbers, and glorious risk.",
    styles: ["Aggressive", "Horde", "Melee"],
    units: [
      { name: "Warboss", role: "Character", points: 75, tags: ["leader", "melee"], note: "Hard-hitting frontline leader." },
      { name: "Boyz", role: "Battleline", points: 80, tags: ["horde", "objective"], note: "Core mob for pressure and scoring." },
      { name: "Deffkoptas", role: "Mounted", points: 90, tags: ["fast", "pressure"], note: "Mobile harassment unit." },
      { name: "Trukk", role: "Vehicle", points: 65, tags: ["transport", "fast"], note: "Gets the mob where it needs to go." },
    ],
  },
  {
    name: "T'au Empire",
    alliance: "Xenos",
    mark: "TE",
    color: "#e8784a",
    summary: "A mobile ranged force that wins through positioning and focused fire.",
    styles: ["Shooting", "Mobile", "Technical"],
    units: [
      { name: "Commander", role: "Character", points: 95, tags: ["leader", "shooting"], note: "Mobile battlesuit leader." },
      { name: "Breacher Team", role: "Battleline", points: 100, tags: ["objective", "shooting"], note: "Close-range objective pressure." },
      { name: "Crisis Battlesuits", role: "Infantry", points: 150, tags: ["mobile", "shooting"], note: "Flexible mobile firepower." },
      { name: "Devilfish", role: "Vehicle", points: 85, tags: ["transport", "fast"], note: "Protected infantry delivery." },
    ],
  },
  {
    name: "Aeldari",
    alliance: "Xenos",
    mark: "AE",
    color: "#8d7bd1",
    summary: "Fast specialists that reward planning, precision, and careful trades.",
    styles: ["Fast", "Technical", "Specialists"],
    units: [
      { name: "Autarch", role: "Character", points: 80, tags: ["leader", "technical"], note: "Utility commander with flexible support." },
      { name: "Guardian Defenders", role: "Battleline", points: 100, tags: ["objective", "shooting"], note: "Scoring unit with ranged support." },
      { name: "Windriders", role: "Mounted", points: 80, tags: ["fast", "pressure"], note: "Rapid objective and flank play." },
      { name: "Fire Prism", role: "Vehicle", points: 170, tags: ["shooting", "specialist"], note: "Long-range anti-armor platform." },
    ],
  },
  {
    name: "Necrons",
    alliance: "Xenos",
    mark: "NE",
    color: "#4ec39b",
    summary: "Relentless formations that grind opponents down and refuse to disappear.",
    styles: ["Durable", "Attrition", "Shooting"],
    units: [
      { name: "Overlord", role: "Character", points: 85, tags: ["leader", "durable"], note: "Durable command piece." },
      { name: "Necron Warriors", role: "Battleline", points: 90, tags: ["objective", "attrition"], note: "Regenerating core infantry." },
      { name: "Immortals", role: "Infantry", points: 70, tags: ["shooting", "durable"], note: "Efficient armored infantry." },
      { name: "Doomsday Ark", role: "Vehicle", points: 200, tags: ["shooting", "durable"], note: "Heavy long-range fire support." },
    ],
  },
  {
    name: "Tyranids",
    alliance: "Xenos",
    mark: "TY",
    color: "#d35f9e",
    summary: "An adaptive swarm that mixes board-filling organisms with giant monsters.",
    styles: ["Swarm", "Adaptive", "Melee"],
    units: [
      { name: "Winged Tyranid Prime", role: "Character", points: 65, tags: ["leader", "fast"], note: "Mobile synapse leader." },
      { name: "Termagants", role: "Battleline", points: 60, tags: ["swarm", "objective"], note: "Numerous scoring bodies." },
      { name: "Zoanthropes", role: "Infantry", points: 100, tags: ["shooting", "support"], note: "Psychic ranged support." },
      { name: "Carnifexes", role: "Vehicle", points: 250, tags: ["durable", "melee"], note: "Heavy monster pressure." },
    ],
  },
  {
    name: "Chaos Space Marines",
    alliance: "Chaos",
    mark: "CS",
    color: "#b86565",
    summary: "Hard-hitting veterans combining dark pacts, armor, and close combat.",
    styles: ["Aggressive", "Flexible", "Elite"],
    units: [
      { name: "Chaos Lord", role: "Character", points: 85, tags: ["leader", "melee"], note: "Frontline melee commander." },
      { name: "Legionaries", role: "Battleline", points: 90, tags: ["objective", "flexible"], note: "Flexible core infantry." },
      { name: "Chaos Terminators", role: "Infantry", points: 185, tags: ["durable", "elite"], note: "Armored pressure unit." },
      { name: "Predator Destructor", role: "Vehicle", points: 140, tags: ["shooting", "vehicle"], note: "Efficient armored firepower." },
    ],
  },
  {
    name: "Death Guard",
    alliance: "Chaos",
    mark: "DG",
    color: "#8a9a54",
    summary: "Slow, resilient infantry and daemon engines that dominate close space.",
    styles: ["Durable", "Attrition", "Melee"],
    units: [
      { name: "Lord of Contagion", role: "Character", points: 80, tags: ["leader", "melee"], note: "Durable close-combat leader." },
      { name: "Plague Marines", role: "Battleline", points: 100, tags: ["objective", "durable"], note: "Tough, flexible core infantry." },
      { name: "Deathshroud Terminators", role: "Infantry", points: 160, tags: ["elite", "melee"], note: "Elite bodyguard unit." },
      { name: "Plagueburst Crawler", role: "Vehicle", points: 180, tags: ["durable", "shooting"], note: "Resilient indirect fire support." },
    ],
  },
];

const starterRoster: RosterEntry[] = [
  { ...factions[0].units[3], id: 1, quantity: 1 },
  { ...factions[0].units[3], id: 2, quantity: 1 },
  { ...factions[0].units[3], id: 3, quantity: 1 },
];

const promptIdeas = [
  "Build a 1,000 point Custodes list with fast objective play",
  "I want a durable army that is forgiving for a new player",
  "Make me a mobile T'au force focused on shooting",
];

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [factionQuery, setFactionQuery] = useState("");
  const [selectedFaction, setSelectedFaction] = useState(factions[0]);
  const [roster, setRoster] = useState<RosterEntry[]>(starterRoster);
  const [target, setTarget] = useState(1000);
  const [prompt, setPrompt] = useState("");
  const [agentNote, setAgentNote] = useState(
    "I loaded your Golden Boys list as a starting point. Add a Character and configuration choices in New Recruit before play."
  );
  const [copied, setCopied] = useState(false);

  const filteredFactions = useMemo(() => {
    const query = factionQuery.trim().toLowerCase();
    if (!query) return factions;
    return factions.filter((faction) =>
      [faction.name, faction.alliance, faction.summary, ...faction.styles]
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [factionQuery]);

  const totalPoints = roster.reduce(
    (sum, entry) => sum + entry.points * entry.quantity,
    0
  );
  const hasCharacter = roster.some((entry) => entry.role === "Character");
  const withinLimit = totalPoints <= target;
  const ready = hasCharacter && withinLimit && roster.length > 0;

  const rosterText = [
    `${selectedFaction.name} — ${totalPoints}/${target} pts`,
    "",
    ...roster.map(
      (entry) =>
        `${entry.quantity}× ${entry.name} (${entry.role}) — ${
          entry.points * entry.quantity
        } pts`
    ),
    "",
    `Validation: ${ready ? "Ready for review" : "Needs attention"}`,
    "Points are a planning snapshot. Confirm the current values and required configuration in New Recruit.",
  ].join("\n");

  const agentBrief = `In New Recruit, create a ${target}-point ${selectedFaction.name} roster named "RosterPilot Draft". Add: ${roster
    .map((entry) => `${entry.quantity}× ${entry.name}`)
    .join(", ")}. Then choose the required battle size, detachment, force disposition, and a Warlord. Stop before deleting or overwriting any existing list.`;

  function chooseFaction(faction: Faction) {
    setSelectedFaction(faction);
    setRoster([]);
    setAgentNote(
      `${faction.name} selected. Tell me a point limit and the kind of game you want to play, or add units from the field guide.`
    );
  }

  function addUnit(unit: Unit) {
    setRoster((current) => [
      ...current,
      { ...unit, id: Date.now() + Math.random(), quantity: 1 },
    ]);
  }

  function changeQuantity(id: number, amount: number) {
    setRoster((current) =>
      current
        .map((entry) =>
          entry.id === id
            ? { ...entry, quantity: Math.max(0, entry.quantity + amount) }
            : entry
        )
        .filter((entry) => entry.quantity > 0)
    );
  }

  function generateRoster() {
    const request = prompt.trim();
    if (!request) {
      setAgentNote("Give me a faction, point limit, or play style and I’ll shape a first draft.");
      return;
    }

    const lower = request.toLowerCase();
    const aliases: Record<string, string> = {
      custodes: "Adeptus Custodes",
      marines: "Space Marines",
      guard: "Astra Militarum",
      tau: "T'au Empire",
      "t'au": "T'au Empire",
      eldar: "Aeldari",
      chaos: "Chaos Space Marines",
      tyranid: "Tyranids",
      ork: "Orks",
      necron: "Necrons",
      "death guard": "Death Guard",
    };

    let faction =
      factions.find((item) => lower.includes(item.name.toLowerCase())) ??
      factions.find((item) =>
        Object.entries(aliases).some(
          ([alias, name]) => lower.includes(alias) && item.name === name
        )
      ) ??
      selectedFaction;

    const requestedPoints = lower.match(/\b(500|750|1000|1,000|1500|1,500|2000|2,000)\b/);
    const nextTarget = requestedPoints
      ? Number(requestedPoints[1].replace(",", ""))
      : target;

    if (
      lower.includes("durable") ||
      lower.includes("forgiving") ||
      lower.includes("new player")
    ) {
      faction =
        factions.find((item) => item.name === "Necrons") ?? faction;
    }

    const desiredTags = [
      "fast",
      "mobile",
      "shooting",
      "melee",
      "durable",
      "objective",
      "horde",
      "elite",
    ].filter((tag) => lower.includes(tag));

    const character =
      faction.units.find((unit) => unit.role === "Character") ?? faction.units[0];
    const battleline =
      faction.units.find((unit) => unit.role === "Battleline") ?? faction.units[1];
    const ranked = [...faction.units].sort((a, b) => {
      const aScore = a.tags.filter((tag) => desiredTags.includes(tag)).length;
      const bScore = b.tags.filter((tag) => desiredTags.includes(tag)).length;
      return bScore - aScore || a.points - b.points;
    });

    const draft: RosterEntry[] = [];
    let points = 0;
    let id = Date.now();
    for (const required of [character, battleline]) {
      if (points + required.points <= nextTarget) {
        draft.push({ ...required, id: id++, quantity: 1 });
        points += required.points;
      }
    }

    let safety = 0;
    while (safety < 24) {
      const candidate = ranked.find((unit) => unit.points + points <= nextTarget);
      if (!candidate) break;
      const existing = draft.find((entry) => entry.name === candidate.name);
      if (existing && existing.quantity < 3) {
        existing.quantity += 1;
      } else if (!existing) {
        draft.push({ ...candidate, id: id++, quantity: 1 });
      } else {
        const alternative = ranked.find(
          (unit) =>
            unit.name !== candidate.name &&
            unit.points + points <= nextTarget &&
            !draft.some((entry) => entry.name === unit.name && entry.quantity >= 3)
        );
        if (!alternative) break;
        const altExisting = draft.find((entry) => entry.name === alternative.name);
        if (altExisting) altExisting.quantity += 1;
        else draft.push({ ...alternative, id: id++, quantity: 1 });
        points += alternative.points;
        safety += 1;
        continue;
      }
      points += candidate.points;
      safety += 1;
    }

    setSelectedFaction(faction);
    setTarget(nextTarget);
    setRoster(draft);
    setAgentNote(
      `Drafted ${faction.name} at ${points}/${nextTarget} points${
        desiredTags.length ? ` around ${desiredTags.join(" and ")}` : ""
      }. I kept it under the limit and included a Character and Battleline unit.`
    );
  }

  async function copyAgentBrief() {
    await navigator.clipboard.writeText(agentBrief);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

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
          <a className="nav-link active" href="#builder">Builder</a>
          <a className="nav-link" href="#factions">Factions</a>
          <a className="nav-link" href="#exports">Exports</a>
        </nav>
        <div className="status-pill">
          <span className="status-dot" />
          Local agent ready
        </div>
      </header>

      <section className="workspace" id="builder">
        <aside className="faction-rail" id="factions">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Armory</span>
              <h2>Choose a faction</h2>
            </div>
            <span className="count-badge">{filteredFactions.length}</span>
          </div>
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search factions"
              placeholder="Name, style, alliance…"
              value={factionQuery}
              onChange={(event) => setFactionQuery(event.target.value)}
            />
          </label>
          <div className="faction-list">
            {filteredFactions.map((faction) => (
              <button
                className={`faction-card ${
                  faction.name === selectedFaction.name ? "selected" : ""
                }`}
                key={faction.name}
                onClick={() => chooseFaction(faction)}
                type="button"
              >
                <span
                  className="faction-mark"
                  style={{ "--faction-color": faction.color } as React.CSSProperties}
                >
                  {faction.mark}
                </span>
                <span className="faction-copy">
                  <strong>{faction.name}</strong>
                  <small>{faction.styles.slice(0, 2).join(" · ")}</small>
                </span>
                <span className="chevron" aria-hidden="true">›</span>
              </button>
            ))}
          </div>
          <p className="data-note">
            Starter catalog for planning. Confirm current points and rules in New Recruit.
          </p>
        </aside>

        <section className="command-column">
          <div className="hero-copy">
            <span className="eyebrow">Warhammer 40,000 · planning workspace</span>
            <h1>Build the army you mean to play.</h1>
            <p>
              Describe the feel, faction, and point limit. RosterPilot turns it into
              an editable draft, checks the basics, and prepares a clean New Recruit handoff.
            </p>
          </div>

          <div className="agent-card">
            <div className="agent-label">
              <span className="agent-avatar" aria-hidden="true">A</span>
              <div>
                <strong>Ask the roster agent</strong>
                <small>Natural-language drafting</small>
              </div>
              <kbd>⌘ ↵</kbd>
            </div>
            <textarea
              aria-label="Describe the army you want"
              placeholder="Build a 2,000 point army that is fast, forgiving, and strong at holding objectives…"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  generateRoster();
                }
              }}
            />
            <div className="agent-actions">
              <div className="prompt-chips" aria-label="Prompt examples">
                {promptIdeas.map((idea) => (
                  <button key={idea} type="button" onClick={() => setPrompt(idea)}>
                    {idea.split(" ").slice(0, 4).join(" ")}…
                  </button>
                ))}
              </div>
              <button className="primary-button" type="button" onClick={generateRoster}>
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
                <h2 id="roster-title">{selectedFaction.name}</h2>
              </div>
              <div className="points-target">
                <span>{totalPoints.toLocaleString()}</span>
                <small>/ {target.toLocaleString()} pts</small>
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

            <div className="roster-list">
              {roster.length === 0 ? (
                <div className="empty-roster">
                  <span aria-hidden="true">＋</span>
                  <strong>Your roster is clear</strong>
                  <p>Add a unit from the field guide or ask the agent for a draft.</p>
                </div>
              ) : (
                roster.map((entry) => (
                  <article className="roster-row" key={entry.id}>
                    <div className="role-token">{entry.role.slice(0, 2).toUpperCase()}</div>
                    <div className="unit-main">
                      <strong>{entry.name}</strong>
                      <span>{entry.role} · {entry.note}</span>
                    </div>
                    <div className="stepper" aria-label={`Quantity for ${entry.name}`}>
                      <button type="button" onClick={() => changeQuantity(entry.id, -1)} aria-label={`Remove one ${entry.name}`}>−</button>
                      <span>{entry.quantity}</span>
                      <button type="button" onClick={() => changeQuantity(entry.id, 1)} aria-label={`Add one ${entry.name}`}>+</button>
                    </div>
                    <strong className="unit-points">{entry.points * entry.quantity}</strong>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="catalog-panel" aria-labelledby="catalog-title">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Field guide</span>
                <h2 id="catalog-title">Recommended units</h2>
              </div>
              <span className="subtle-label">{selectedFaction.alliance}</span>
            </div>
            <div className="unit-grid">
              {selectedFaction.units.map((unit) => (
                <article className="unit-card" key={unit.name}>
                  <div className="unit-card-top">
                    <span>{unit.role}</span>
                    <strong>{unit.points} pts</strong>
                  </div>
                  <h3>{unit.name}</h3>
                  <p>{unit.note}</p>
                  <div className="tag-row">
                    {unit.tags.map((tag) => <span key={tag}>{tag}</span>)}
                  </div>
                  <button type="button" onClick={() => addUnit(unit)}>
                    Add to roster <span aria-hidden="true">＋</span>
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
              <div className="readiness-ring">
                {ready ? "✓" : totalPoints > target ? "!" : "…"}
              </div>
              <div>
                <strong>{ready ? "Draft ready" : "Draft incomplete"}</strong>
                <small>{ready ? "Ready for New Recruit review" : "Resolve the checks below"}</small>
              </div>
            </div>
            <div className="check-list">
              <div className={hasCharacter ? "pass" : "warn"}>
                <span>{hasCharacter ? "✓" : "!"}</span>
                <p><strong>Character</strong><small>{hasCharacter ? "Included" : "Add at least one"}</small></p>
              </div>
              <div className={withinLimit ? "pass" : "warn"}>
                <span>{withinLimit ? "✓" : "!"}</span>
                <p><strong>Point limit</strong><small>{withinLimit ? `${target - totalPoints} pts remain` : `${totalPoints - target} pts over`}</small></p>
              </div>
              <div className="neutral">
                <span>→</span>
                <p><strong>Game configuration</strong><small>Finish in New Recruit</small></p>
              </div>
            </div>
          </section>

          <section className="inspector-block export-block">
            <span className="eyebrow">Export desk</span>
            <h2>Take the list with you</h2>
            <p>Download a clean copy or hand the exact build instructions to your browser agent.</p>
            <div className="export-grid">
              <button type="button" onClick={() => downloadFile("rosterpilot-list.txt", rosterText, "text/plain")}>
                <span aria-hidden="true">TXT</span>
                Plain text
              </button>
              <button type="button" onClick={() => downloadFile("rosterpilot-list.json", JSON.stringify({ faction: selectedFaction.name, target, totalPoints, roster }, null, 2), "application/json")}>
                <span aria-hidden="true">{`{ }`}</span>
                JSON
              </button>
            </div>
          </section>

          <section className="handoff-card">
            <div className="handoff-heading">
              <span className="nr-mark" aria-hidden="true">NR</span>
              <div>
                <strong>New Recruit handoff</strong>
                <small>Agent-ready instructions</small>
              </div>
            </div>
            <p>{agentBrief}</p>
            <button className="copy-button" type="button" onClick={copyAgentBrief}>
              {copied ? "Copied" : "Copy agent command"}
            </button>
            <a href="https://www.newrecruit.eu/app/MyLists" target="_blank" rel="noreferrer">
              Open New Recruit <span aria-hidden="true">↗</span>
            </a>
          </section>

          <div className="privacy-note">
            <span aria-hidden="true">◉</span>
            <p><strong>Private by default</strong><small>This prototype keeps roster work in your browser.</small></p>
          </div>
        </aside>
      </section>
    </main>
  );
}
