import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument near ${key ?? "end"}.`);
    values.set(key.slice(2), value);
  }
  return values;
}

async function jsonFile(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function sha256(filename) {
  return crypto.createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function verifyReport(reportPath, receiptPath) {
  const [report, receipt] = await Promise.all([jsonFile(reportPath), jsonFile(receiptPath)]);
  if (receipt.reportFilename !== path.basename(reportPath)) throw new Error("Receipt filename mismatch.");
  if (receipt.reportSha256 !== await sha256(reportPath)) throw new Error("Receipt SHA-256 mismatch.");
  if (receipt.runId !== report.runId) throw new Error("Receipt run ID mismatch.");
  if (report.status !== "complete") throw new Error("Exact report is not complete.");
  return report;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compactLabel(entity) {
  return `${entity.name} #${entity.ordinal ?? 1}`;
}

const metricDefinitions = [
  ["meanDamage", "Mean damage", "volume"],
  ["meanKills", "Mean kills", "volume"],
  ["wipeProbability", "Wipe probability", "probability"],
  ["halfWipeProbability", "Half-wipe probability", "probability"],
];

function heatmapRows(report, rosterLabel) {
  const rows = [];
  for (const scenario of report.simulation?.scenarios ?? []) {
    assert(scenario.integrity?.status !== "failed", "A scenario has failed integrity.");
    for (const cell of scenario.cells ?? []) {
      for (const [field, metric, family] of metricDefinitions) {
        const value = cell.values?.[field];
        if (typeof value !== "number") continue;
        rows.push({
          roster: rosterLabel,
          phase: scenario.phase === "fight" ? "Fight" : "Shooting",
          direction: scenario.direction,
          metric,
          family,
          attacker: compactLabel(cell.attacker),
          target: compactLabel(cell.target),
          value,
          confidence: cell.confidence ?? "unknown",
        });
      }
    }
  }
  return rows;
}

function aggregate(report, metric, direction) {
  const row = report.aggregates.find((value) => value.metric === metric && value.direction === direction);
  assert(row, `Missing aggregate ${metric}/${direction}.`);
  return row;
}

function displayMetric(metric, value) {
  if (value === null || value === undefined) return "—";
  return metric.includes("probability") ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);
}

function operationRosterRows(operation, listLabel) {
  return operation.roster.units.map((unit) => ({
    list: listLabel,
    unit: unit.name,
    models: unit.models,
    points: unit.points,
    role: unit.warlord ? "Warlord" : "Unit",
  }));
}

const args = argumentsFrom(process.argv.slice(2));
const required = [
  "baseline-operation",
  "revised-operation",
  "baseline-report",
  "baseline-receipt",
  "revised-report",
  "revised-receipt",
  "revision-report",
  "output",
];
for (const name of required) assert(args.has(name), `Missing --${name}.`);

const [baselineOperation, revisedOperation, baselineReport, revisedReport, revisionReport] = await Promise.all([
  jsonFile(args.get("baseline-operation")),
  jsonFile(args.get("revised-operation")),
  verifyReport(args.get("baseline-report"), args.get("baseline-receipt")),
  verifyReport(args.get("revised-report"), args.get("revised-receipt")),
  jsonFile(args.get("revision-report")),
]);

assert(baselineOperation.state === "completed", "Baseline operation is not complete.");
assert(revisedOperation.state === "completed", "Venatari operation is not complete.");
assert(baselineOperation.bundleId === revisedOperation.bundleId, "Operations use different data bundles.");
assert(revisionReport.baselineRunId === baselineReport.runId, "Revision report references a different baseline.");
assert(revisionReport.revisedReports.some((value) => value.runId === revisedReport.runId), "Revision report does not contain the revised exact run.");
assert(revisionReport.summary?.conclusion === "improved", "Revision report conclusion is not improved.");
assert(revisionReport.summary?.aggregateCounts?.applicable === 8, "Expected eight applicable aggregate metrics.");

const allHeatmapRows = [
  ...heatmapRows(baselineReport, "Baseline"),
  ...heatmapRows(revisedReport, "Venatari Lances"),
];
assert(allHeatmapRows.length > 0, "No heat-map cells were found.");

let datasets = {
  offense_volume: allHeatmapRows.filter((row) => row.direction === "player-to-opponent" && row.family === "volume"),
  offense_probability: allHeatmapRows.filter((row) => row.direction === "player-to-opponent" && row.family === "probability"),
  incoming_volume: allHeatmapRows.filter((row) => row.direction === "opponent-to-player" && row.family === "volume"),
  incoming_probability: allHeatmapRows.filter((row) => row.direction === "opponent-to-player" && row.family === "probability"),
};
for (const [name, rows] of Object.entries(datasets)) assert(rows.length > 0, `${name} is empty.`);

const offenseDamage = aggregate(revisionReport, "mean-damage", "player-to-opponent");
const offenseKills = aggregate(revisionReport, "mean-kills", "player-to-opponent");
const offenseWipe = aggregate(revisionReport, "wipe-probability", "player-to-opponent");
const incomingKills = aggregate(revisionReport, "mean-kills", "opponent-to-player");
const incomingHalfWipe = aggregate(revisionReport, "half-wipe-probability", "opponent-to-player");
const incomingDamage = aggregate(revisionReport, "mean-damage", "opponent-to-player");

const revisedFight = revisedReport.simulation.scenarios.find((scenario) =>
  scenario.phase === "fight" && scenario.direction === "opponent-to-player"
);
const kharnInto = (targetName) => revisedFight.cells.find((cell) =>
  cell.attacker.name === "Khârn the Betrayer" && cell.target.name === targetName
);
const kharnCaptain = kharnInto("Shield-Captain");
const kharnVenatari = kharnInto("Venatari Custodians");
assert(kharnCaptain && kharnVenatari, "Khârn threat cells are missing.");

const headlineMetrics = [{
  improved_metrics: revisionReport.summary.aggregateCounts.improved,
  unchanged_metrics: revisionReport.summary.aggregateCounts.unchanged,
  worsened_metrics: revisionReport.summary.aggregateCounts.worsened,
  offense_damage_after: offenseDamage.after,
  offense_damage_before: offenseDamage.before,
  offense_damage_change: offenseDamage.after - offenseDamage.before,
  incoming_kills_after: incomingKills.after,
  incoming_kills_before: incomingKills.before,
  incoming_kills_change: incomingKills.after - incomingKills.before,
  revised_points: revisedOperation.roster.points.split("/")[0] * 1,
  baseline_points: baselineOperation.roster.points.split("/")[0] * 1,
  opponent_points: revisedOperation.opponent.points.split("/")[0] * 1,
}];

const aggregateRows = revisionReport.aggregates.map((row) => ({
  metric: row.metric.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
  direction: row.direction === "player-to-opponent" ? "Custodes output" : "World Eaters output",
  before: displayMetric(row.metric, row.before),
  after: displayMetric(row.metric, row.after),
  raw_change: displayMetric(row.metric, row.after - row.before),
  classification: row.classification[0].toUpperCase() + row.classification.slice(1),
}));

const rosterRows = [
  ...operationRosterRows(baselineOperation, "Baseline"),
  ...operationRosterRows(revisedOperation, "Venatari Lances"),
];

const heatmapSql = "SELECT roster, phase, direction, metric, family, attacker, target, value, confidence FROM combat_cells ORDER BY roster, phase, direction, metric, attacker, target";
const aggregateSql = "SELECT metric, direction, before, after, raw_change, classification FROM aggregate_metrics ORDER BY direction, metric";
const headlineSql = "SELECT improved_metrics, unchanged_metrics, worsened_metrics, offense_damage_after, offense_damage_before, offense_damage_change, incoming_kills_after, incoming_kills_before, incoming_kills_change, revised_points, baseline_points, opponent_points FROM headline_metrics";
const rosterSql = "SELECT list, unit, models, points, role FROM roster_units ORDER BY list, points DESC, unit";

const database = new DatabaseSync(":memory:");
database.exec(`
  CREATE TABLE combat_cells (
    roster TEXT, phase TEXT, direction TEXT, metric TEXT, family TEXT,
    attacker TEXT, target TEXT, value REAL, confidence TEXT
  );
  CREATE TABLE aggregate_metrics (
    metric TEXT, direction TEXT, before TEXT, after TEXT,
    raw_change TEXT, classification TEXT
  );
  CREATE TABLE headline_metrics (
    improved_metrics INTEGER, unchanged_metrics INTEGER, worsened_metrics INTEGER,
    offense_damage_after REAL, offense_damage_before REAL, offense_damage_change REAL,
    incoming_kills_after REAL, incoming_kills_before REAL, incoming_kills_change REAL,
    revised_points INTEGER, baseline_points INTEGER, opponent_points INTEGER
  );
  CREATE TABLE roster_units (
    list TEXT, unit TEXT, models INTEGER, points INTEGER, role TEXT
  );
`);
const insertRows = (sql, rows, fields) => {
  const statement = database.prepare(sql);
  for (const row of rows) statement.run(...fields.map((field) => row[field]));
};
insertRows(
  "INSERT INTO combat_cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  allHeatmapRows,
  ["roster", "phase", "direction", "metric", "family", "attacker", "target", "value", "confidence"],
);
insertRows(
  "INSERT INTO aggregate_metrics VALUES (?, ?, ?, ?, ?, ?)",
  aggregateRows,
  ["metric", "direction", "before", "after", "raw_change", "classification"],
);
insertRows(
  "INSERT INTO headline_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  headlineMetrics,
  [
    "improved_metrics", "unchanged_metrics", "worsened_metrics",
    "offense_damage_after", "offense_damage_before", "offense_damage_change",
    "incoming_kills_after", "incoming_kills_before", "incoming_kills_change",
    "revised_points", "baseline_points", "opponent_points",
  ],
);
insertRows(
  "INSERT INTO roster_units VALUES (?, ?, ?, ?, ?)",
  rosterRows,
  ["list", "unit", "models", "points", "role"],
);
const queriedHeatmapRows = database.prepare(heatmapSql).all();
const queriedAggregateRows = database.prepare(aggregateSql).all();
const queriedHeadlineRows = database.prepare(headlineSql).all();
const queriedRosterRows = database.prepare(rosterSql).all();
assert(queriedHeatmapRows.length === allHeatmapRows.length, "SQL heat-map row count changed.");
assert(queriedAggregateRows.length === aggregateRows.length, "SQL aggregate row count changed.");
assert(queriedHeadlineRows.length === 1, "SQL headline row count changed.");
assert(queriedRosterRows.length === rosterRows.length, "SQL roster row count changed.");
datasets = {
  offense_volume: queriedHeatmapRows.filter((row) => row.direction === "player-to-opponent" && row.family === "volume"),
  offense_probability: queriedHeatmapRows.filter((row) => row.direction === "player-to-opponent" && row.family === "probability"),
  incoming_volume: queriedHeatmapRows.filter((row) => row.direction === "opponent-to-player" && row.family === "volume"),
  incoming_probability: queriedHeatmapRows.filter((row) => row.direction === "opponent-to-player" && row.family === "probability"),
};

const sourceComparison = "tessera_revision_comparison";
const sourceBaseline = "tessera_baseline_exact";
const sourceRevised = "tessera_venatari_exact";
const sourceHeatmaps = "reviewed_combat_cells";
const sourceHeadline = "reviewed_headline_metrics";
const sourceRoster = "reviewed_roster_units";
const sources = [
  { id: sourceBaseline, label: "Receipt-bound Tessera Website baseline exact report", path: "rosterpilot/baseline-exact-report.json" },
  { id: sourceRevised, label: "Receipt-bound Tessera Website Venatari exact report", path: "rosterpilot/venatari-exact-report.json" },
  {
    id: sourceHeatmaps,
    label: "Reviewed receipt-bound combat cells",
    query: {
      engine: "sqlite",
      sql: heatmapSql,
      description: "Reads the receipt-verified Tessera combat cells materialized for the report.",
      executed_at: revisionReport.generatedAt,
      tables_used: ["combat_cells"],
      metric_definitions: ["Each row is one exact attacker-target metric cell for one roster, phase, and direction."],
    },
  },
  {
    id: sourceComparison,
    label: "Reviewed aggregate comparison metrics",
    query: {
      engine: "sqlite",
      sql: aggregateSql,
      description: "Reads the eight aggregate metrics from the receipt-bound revision comparison.",
      executed_at: revisionReport.generatedAt,
      tables_used: ["aggregate_metrics"],
    },
  },
  {
    id: sourceHeadline,
    label: "Reviewed headline comparison metrics",
    query: {
      engine: "sqlite",
      sql: headlineSql,
      description: "Reads the report headline values derived from the validated aggregate comparison.",
      executed_at: revisionReport.generatedAt,
      tables_used: ["headline_metrics"],
    },
  },
  {
    id: sourceRoster,
    label: "Reviewed roster selections",
    query: {
      engine: "sqlite",
      sql: rosterSql,
      description: "Reads the player roster selections from the two completed RosterPilot operations.",
      executed_at: revisionReport.generatedAt,
      tables_used: ["roster_units"],
    },
  },
];

const filterTargets = (otherDatasets) => otherDatasets.map((dataset) => ({ dataset }));
const chart = (id, title, subtitle, dataset, sourceId, valueFormat) => ({
  id,
  title,
  subtitle,
  type: "heatmap",
  dataset,
  sourceId,
  valueFormat,
  layout: "full",
  encodings: {
    x: { field: "target", type: "ordinal", label: "Target" },
    y: { field: "value", type: "quantitative", label: "Modeled value", format: valueFormat },
    color: { field: "attacker", type: "nominal", label: "Attacker" },
    tooltip: [
      { field: "roster", type: "nominal", label: "Custodes roster" },
      { field: "phase", type: "nominal", label: "Phase" },
      { field: "metric", type: "nominal", label: "Metric" },
      { field: "confidence", type: "nominal", label: "Evidence confidence" },
    ],
  },
});

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title: "Custodes vs Khârn: Venatari Heatmap Report",
    description: "Interactive, receipt-bound Tessera Website comparison of the 500-point baseline and 490-point Venatari Lance roster against the same 575-point World Eaters list.",
    generatedAt: revisionReport.generatedAt,
    filters: [
      {
        id: "roster_filter",
        label: "Custodes roster",
        dataset: "offense_volume",
        field: "roster",
        defaultValue: "Venatari Lances",
        includeAll: false,
        targets: filterTargets(["offense_probability", "incoming_volume", "incoming_probability"]),
      },
      {
        id: "phase_filter",
        label: "Phase",
        dataset: "offense_volume",
        field: "phase",
        defaultValue: "Fight",
        includeAll: false,
        targets: filterTargets(["offense_probability", "incoming_volume", "incoming_probability"]),
      },
      {
        id: "volume_metric_filter",
        label: "Damage/kill metric",
        dataset: "offense_volume",
        field: "metric",
        defaultValue: "Mean damage",
        includeAll: false,
        targets: filterTargets(["incoming_volume"]),
      },
      {
        id: "probability_metric_filter",
        label: "Probability metric",
        dataset: "offense_probability",
        field: "metric",
        defaultValue: "Wipe probability",
        includeAll: false,
        targets: filterTargets(["incoming_probability"]),
      },
    ],
    cards: [
      {
        id: "comparison_outcome",
        description: "Aggregate metrics classified by the receipt-bound revision comparison.",
        dataset: "headline_metrics",
        sourceId: sourceHeadline,
        metrics: [
          { label: "Improved metrics", field: "improved_metrics", format: "number" },
          { label: "Unchanged", field: "unchanged_metrics", format: "number" },
          { label: "Worsened", field: "worsened_metrics", format: "number" },
        ],
      },
      {
        id: "offense_damage",
        description: "Equal-weight mean damage across modeled Custodes attacks into the World Eaters roster.",
        dataset: "headline_metrics",
        sourceId: sourceHeadline,
        metrics: [
          { label: "Venatari mean damage", field: "offense_damage_after", format: "number" },
          { label: "Baseline", field: "offense_damage_before", format: "number" },
          { label: "Change", field: "offense_damage_change", format: "number", signed: true },
        ],
      },
      {
        id: "incoming_kills",
        description: "Equal-weight mean model kills produced by World Eaters attacks into the selected Custodes roster.",
        dataset: "headline_metrics",
        sourceId: sourceHeadline,
        metrics: [
          { label: "Enemy mean kills", field: "incoming_kills_after", format: "number" },
          { label: "Baseline", field: "incoming_kills_before", format: "number" },
          { label: "Change", field: "incoming_kills_change", format: "number", signed: true },
        ],
      },
      {
        id: "points_used",
        description: "Roster points in the 575-point comparison envelope.",
        dataset: "headline_metrics",
        sourceId: sourceHeadline,
        metrics: [
          { label: "Venatari roster", field: "revised_points", format: "number" },
          { label: "Baseline", field: "baseline_points", format: "number" },
          { label: "World Eaters", field: "opponent_points", format: "number" },
        ],
      },
    ],
    charts: [
      chart("offense_volume_heatmap", "Custodes damage and kills", "Select the roster, phase, and damage/kill metric above.", "offense_volume", sourceHeatmaps, "number"),
      chart("offense_probability_heatmap", "Custodes wipe pressure", "Darker cells indicate a higher modeled wipe or half-wipe probability.", "offense_probability", sourceHeatmaps, "percent"),
      chart("incoming_volume_heatmap", "World Eaters damage and kills", "Use this view to identify which Custodes units absorb or avoid the most incoming output.", "incoming_volume", sourceHeatmaps, "number"),
      chart("incoming_probability_heatmap", "World Eaters wipe pressure", "Darker cells identify the most dangerous enemy-to-Custodes pairings.", "incoming_probability", sourceHeatmaps, "percent"),
    ],
    tables: [
      {
        id: "aggregate_table",
        title: "Aggregate comparison detail",
        subtitle: "Eight applicable roster-level metrics across shooting and fight phases.",
        dataset: "aggregate_metrics",
        sourceId: sourceComparison,
        density: "spacious",
        defaultSort: { field: "direction", direction: "asc" },
        columns: [
          { field: "direction", label: "Direction", type: "text" },
          { field: "metric", label: "Metric", type: "text" },
          { field: "before", label: "Baseline", type: "text", align: "right" },
          { field: "after", label: "Venatari", type: "text", align: "right" },
          { field: "raw_change", label: "Raw change", type: "text", align: "right" },
          { field: "classification", label: "Classification", type: "text" },
        ],
      },
      {
        id: "roster_table",
        title: "Custodes roster composition",
        subtitle: "Baseline and Venatari selections used in the exact Website comparison.",
        dataset: "roster_units",
        sourceId: sourceRoster,
        density: "spacious",
        defaultSort: { field: "list", direction: "asc" },
        columns: [
          { field: "list", label: "Roster", type: "text" },
          { field: "unit", label: "Unit", type: "text" },
          { field: "models", label: "Models", type: "number", align: "right" },
          { field: "points", label: "Points", type: "number", align: "right" },
          { field: "role", label: "Role", type: "text" },
        ],
      },
    ],
    sources,
    blocks: [
      {
        id: "executive_summary",
        type: "markdown",
        sourceId: sourceComparison,
        body: `## Executive Summary\n\n- **The Venatari roster is directionally stronger in this combat model.** Six of eight applicable aggregate metrics improved, two were unchanged, and none worsened.\n- **Custodes output increased materially.** Mean damage rose from ${offenseDamage.before.toFixed(2)} to ${offenseDamage.after.toFixed(2)}, mean kills from ${offenseKills.before.toFixed(2)} to ${offenseKills.after.toFixed(2)}, and wipe probability from ${(offenseWipe.before * 100).toFixed(1)}% to ${(offenseWipe.after * 100).toFixed(1)}%.\n- **Khârn remains the matchup's critical threat.** In the Venatari run he modeled an ${(kharnCaptain.values.wipeProbability * 100).toFixed(0)}% fight-phase wipe chance into the Shield-Captain and ${(kharnVenatari.values.wipeProbability * 100).toFixed(0)}% into the Venatari unit.\n- **Treat the conclusion as directional, not a win rate.** The rosters have different unit counts, the Venatari list leaves 85 points unused in the 575-point envelope, and missions, terrain, movement, and player decisions are outside the model.`,
      },
      { id: "headline_metrics", type: "metric-strip", cardIds: ["comparison_outcome", "offense_damage", "incoming_kills", "points_used"] },
      {
        id: "reading_guide",
        type: "markdown",
        body: "## How to read the heat maps\n\nUse the controls above to switch between the baseline and Venatari rosters, shooting and fight phases, and damage/kill or probability metrics. Rows are attackers, columns are targets, and darker cells mean a larger modeled value. Hover or focus a cell for its exact value and evidence confidence. Each heat map uses the same exact World Eaters roster: Khârn, two ten-model Berzerker units, and one Helbrute.",
      },
      {
        id: "offense_volume_story",
        type: "markdown",
        sourceId: sourceRevised,
        body: "## Venatari adds a second meaningful melee damage source\n\nThe Custodian Guard remains the primary Berzerker remover, while the Venatari create additional pressure without relying on the Shield-Captain's output. Use the damage view to identify favorable assignments; switching to the baseline shows how much of its meaningful melee output is concentrated in the Guard unit.",
      },
      { id: "offense_volume_chart", type: "chart", chartId: "offense_volume_heatmap" },
      {
        id: "offense_probability_story",
        type: "markdown",
        sourceId: sourceRevised,
        body: "## Wipe pressure improves, but target choice still matters\n\nThe Venatari are much better at pushing Berzerker units toward half strength than at removing all ten models in one activation. That makes them a useful follow-up or trading unit rather than the only answer to a full Berzerker block.",
      },
      { id: "offense_probability_chart", type: "chart", chartId: "offense_probability_heatmap" },
      {
        id: "incoming_volume_story",
        type: "markdown",
        sourceId: sourceRevised,
        body: `## Khârn is the piece that can collapse the Custodes plan\n\nThe Berzerkers' modeled output into elite Custodes is comparatively manageable, but Khârn remains capable of removing key units. Keep him screened, force him to charge the least valuable available target, and preserve the Guard for the counterpunch. Enemy mean kills fell from ${incomingKills.before.toFixed(2)} to ${incomingKills.after.toFixed(2)} at the roster-aggregate level, but that average does not erase the specific Khârn spike.`,
      },
      { id: "incoming_volume_chart", type: "chart", chartId: "incoming_volume_heatmap" },
      {
        id: "incoming_probability_story",
        type: "markdown",
        sourceId: sourceRevised,
        body: `## The revised roster reduces broad exposure, not Khârn's ceiling\n\nWorld Eaters half-wipe probability fell from ${(incomingHalfWipe.before * 100).toFixed(1)}% to ${(incomingHalfWipe.after * 100).toFixed(1)}% across the modeled roster cells. Incoming mean damage moved from ${incomingDamage.before.toFixed(2)} to ${incomingDamage.after.toFixed(2)} and remained below the comparison's materiality threshold, so it was classified unchanged.`,
      },
      { id: "incoming_probability_chart", type: "chart", chartId: "incoming_probability_heatmap" },
      {
        id: "aggregate_story",
        type: "markdown",
        sourceId: sourceComparison,
        body: "## The aggregate result favors Venatari, with a composition caveat\n\nThe comparison uses equal-weight trusted scenario means, but the baseline contributes 40 modeled cells per aggregate while the three-unit Venatari roster contributes 24. Removing vulnerable screening units changes the denominator as well as the army's combat profile. The table is therefore evidence that the revised roster is more combat-efficient in these matrices—not proof that it will score better across a full game.",
      },
      { id: "aggregate_table_block", type: "table", tableId: "aggregate_table" },
      {
        id: "roster_story",
        type: "markdown",
        body: "## The roster trades board coverage for concentrated elite output\n\nThe baseline carries three Sisters of Silence units for screening and board presence. The Venatari roster replaces all three with one mobile elite unit, reducing activations and disposable screens. That trade is favorable in the combat matrices but may be costly in mission play, especially when actions, objective control, or layered screening matter.",
      },
      { id: "roster_table_block", type: "table", tableId: "roster_table" },
      {
        id: "recommended_next_steps",
        type: "markdown",
        body: "## Recommended next steps\n\n1. **Use Custodian Guard as the main Berzerker answer.** Their modeled fight output is the roster's most reliable way to remove a full unit.\n2. **Use Venatari to pressure a second unit or finish damaged targets.** Their mobility and strong half-wipe pressure create sequencing flexibility.\n3. **Do not offer Khârn a clean charge into the Shield-Captain or Venatari.** Preserve a screen or force an unfavorable charge lane.\n4. **Test mission play before adopting the variant outright.** The combat result does not measure the loss of three screening and scoring units.",
      },
      {
        id: "further_questions",
        type: "markdown",
        body: "## Further questions\n\n- Can the remaining points add a legal screening or scoring unit without weakening the core?\n- Do Vertus Praetors or Wardens preserve more board control while matching the Venatari's combat gains?\n- How does each variant perform when deployment, terrain, objectives, and five-turn scoring are modeled?",
      },
      {
        id: "caveats",
        type: "markdown",
        body: "## Caveats and assumptions\n\n- Tessera results are directional combat math, not game win probability.\n- The baseline uses five units and the Venatari roster three, so cell counts and screening roles differ.\n- The comparison envelope is 575 points: the baseline uses 500, the Venatari roster 490, and the World Eaters roster 575.\n- Provider evidence for the imported World Eaters roster is incomplete; three effects remained unresolved.\n- Imported profile choices used the frozen policy for the supercharged plasma pistol and krak missile profile.\n- No reviewed official extraction evidence was supplied. Confirm event-specific rules and current points before play.",
      },
    ],
  },
  snapshot: {
    version: 1,
    generatedAt: revisionReport.generatedAt,
    status: "ready",
    datasets: {
      ...datasets,
      headline_metrics: queriedHeadlineRows,
      aggregate_metrics: queriedAggregateRows,
      roster_units: queriedRosterRows,
    },
    accessIssues: [],
  },
  sources,
  package_info: {
    originUrl: "rosterpilot://reports/custodes-vs-kharn-venatari-heatmaps",
  },
};

await writeFile(args.get("output"), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  output: args.get("output"),
  bundleId: revisedOperation.bundleId,
  baselineRunId: baselineReport.runId,
  revisedRunId: revisedReport.runId,
  heatmapRows: allHeatmapRows.length,
  aggregates: aggregateRows.length,
}, null, 2));
