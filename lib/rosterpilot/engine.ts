import {
  baseLoadout,
  baseUnitPoints,
  checkRoster,
  dataset,
  detachments,
  enhancements,
  exportRoster as export40kRoster,
  factions,
  forceDispositions,
  normalizeName,
  pointsTierMissing,
  units,
  validateRosterCore,
  wargearPoints,
} from "@alpaca-software/40kdc-data";
import type {
  Roster,
  RosterUnit,
  UnitView,
} from "@alpaca-software/40kdc-data";
import { strToU8, zipSync } from "fflate";

import {
  ROSTER_SCHEMA_VERSION,
  DEFAULT_FACTION_ID,
  ModifyRosterOperationSchema,
  SUPPORTED_GAME,
  type BuildRosterInput,
  type DataStatus,
  type DraftUnit,
  type EquipmentSelection,
  type ExportArtifact,
  type ExportFormat,
  type FactionSummary,
  type ModifyRosterOperation,
  type PreferenceTag,
  type ResultEnvelope,
  type RosterDraftV1,
  type RosterIssue,
  type UnitSummary,
} from "./types";
import {
  conflictsForRoster,
  getNewRecruitCapability,
  newRecruitCatalogue,
} from "./catalogue-summary";
import { currentRosterSourceData, parseRosterDraft } from "./draft";

export const DATA_PACKAGE_VERSION =
  newRecruitCatalogue.sources.rules.version;
export const DATA_EDITION = newRecruitCatalogue.sources.rules.edition;
export const DATA_DATASLATE =
  newRecruitCatalogue.sources.rules.dataslate;

const FACTION_ALIASES: Record<string, string> = {
  custodes: "adeptus-custodes",
  "adeptus custodes": "adeptus-custodes",
  "golden boys": "adeptus-custodes",
  marines: "adeptus-astartes",
  "space marines": "adeptus-astartes",
  guard: "astra-militarum",
  "imperial guard": "astra-militarum",
  tau: "tau-empire",
  "t'au": "tau-empire",
  eldar: "aeldari",
};

const PREFERENCE_ALIASES: Record<PreferenceTag, string[]> = {
  mobility: ["fast", "mobile", "speed", "rapid", "flank", "jetbike"],
  durability: ["durable", "tough", "resilient", "forgiving", "tank", "survive"],
  objective: ["objective", "scoring", "board control", "hold", "mission"],
  shooting: ["shooting", "ranged", "firepower", "guns"],
  melee: ["melee", "combat", "fight", "aggressive", "charge"],
  elite: ["elite", "compact", "few models"],
  horde: ["horde", "many models", "swarm"],
};

const ROLE_LABELS: Record<string, string> = {
  character: "Character",
  battleline: "Battleline",
  "dedicated-transport": "Dedicated Transport",
  fortification: "Fortification",
  allied: "Allied",
  "epic-hero": "Epic Hero",
};

function issue(
  code: string,
  message: string,
  severity: "error" | "warn" = "error",
  selectionId?: string,
): RosterIssue {
  return { code, message, severity, ...(selectionId ? { selectionId } : {}) };
}

function envelope<T>(
  data: T | null,
  violations: RosterIssue[] = [],
  warnings: RosterIssue[] = [],
): ResultEnvelope<T> {
  return { ok: violations.length === 0, data, violations, warnings };
}

function slug(value: string): string {
  return normalizeName(value).replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function deterministicId(parts: Array<string | number>): string {
  let hash = 2166136261;
  for (const character of parts.join("|")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `rp-${(hash >>> 0).toString(36)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizedKeywords(unit: UnitView): string[] {
  return [...(unit.raw.keywords ?? []), ...(unit.raw.faction_keywords ?? [])].map((keyword) =>
    normalizeName(keyword),
  );
}

function unitRole(unit: UnitView): string {
  if (unit.raw.role) return ROLE_LABELS[unit.raw.role] ?? unit.raw.role;
  const keywords = normalizedKeywords(unit);
  if (keywords.includes("character")) return "Character";
  if (keywords.includes("vehicle")) return "Vehicle";
  if (keywords.includes("mounted")) return "Mounted";
  if (keywords.includes("infantry")) return "Infantry";
  return "Unit";
}

function isCharacterUnit(unit: UnitView): boolean {
  const keywords = normalizedKeywords(unit);
  return (
    unit.raw.role === "character" ||
    unit.raw.role === "epic-hero" ||
    keywords.includes("character")
  );
}

function isNamedCharacter(unit: UnitView): boolean {
  const keywords = normalizedKeywords(unit);
  return (
    keywords.includes("epic hero") ||
    keywords.includes("named character")
  );
}

function factionAncestry(factionId: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current = factions.get(factionId);
  while (current && !seen.has(current.id)) {
    ids.push(current.id);
    seen.add(current.id);
    const parentId = current.raw.parent_faction_id;
    current = parentId ? factions.get(parentId) : undefined;
  }
  return ids;
}

function factionUnits(factionId: string): UnitView[] {
  const seen = new Set<string>();
  const result: UnitView[] = [];
  for (const sourceFactionId of factionAncestry(factionId)) {
    for (const unit of units.byFaction(sourceFactionId)) {
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      result.push(unit);
    }
  }
  return result;
}

function matchedPlayDetachments(factionId: string) {
  const seen = new Set<string>();
  return factionAncestry(factionId).flatMap((sourceFactionId) =>
    detachments.byFaction(sourceFactionId).filter((detachment) => {
      if (seen.has(detachment.id)) return false;
      const matchedPlay =
        !detachment.game_modes ||
        detachment.game_modes.includes("matched-play");
      if (matchedPlay) seen.add(detachment.id);
      return matchedPlay;
    }),
  );
}

function resolveDetachment(detachmentId: string, factionId: string) {
  for (const sourceFactionId of factionAncestry(factionId)) {
    const found = detachments.getInFaction(detachmentId, sourceFactionId);
    if (found) return found;
  }
  return undefined;
}

function isBuildableFaction(factionId: string): boolean {
  return (
    factionUnits(factionId).some(
      (unit) =>
        (unit.raw.points ?? []).length > 0 &&
        unit.raw.attachment_role !== "support",
    ) && matchedPlayDetachments(factionId).length > 0
  );
}

function unitTags(unit: UnitView): PreferenceTag[] {
  const tags = new Set<PreferenceTag>();
  const profile = unit.profileAt();
  const keywords = normalizedKeywords(unit);
  const movement = Number(profile?.M ?? 0);
  const toughness = Number(profile?.T ?? 0);
  const wounds = Number(profile?.W ?? 0);
  const save = Number(profile?.Sv ?? 7);
  const objective = Number(profile?.OC ?? 0);
  const modelMinimum = unit.raw.model_count?.min ?? unit.raw.points?.[0]?.models ?? 1;
  const rangedProfiles = unit.weapons.flatMap((weapon) =>
    weapon.raw.profiles.filter((profileEntry) => profileEntry.range !== "Melee"),
  );
  const meleeProfiles = unit.weapons.flatMap((weapon) =>
    weapon.raw.profiles.filter((profileEntry) => profileEntry.range === "Melee"),
  );

  if (
    movement >= 10 ||
    keywords.includes("mounted") ||
    keywords.includes("fly") ||
    (unit.raw.ability_ids ?? []).includes("deep-strike")
  ) {
    tags.add("mobility");
  }
  if (toughness >= 7 || wounds >= 5 || save <= 2) tags.add("durability");
  if (objective >= 2 || unit.raw.role === "battleline") tags.add("objective");
  if (rangedProfiles.length > 0) tags.add("shooting");
  if (meleeProfiles.length > 0) tags.add("melee");
  if (baseUnitPoints(unit.raw, modelMinimum, 1) >= 100 || modelMinimum <= 3) {
    tags.add("elite");
  }
  if (modelMinimum >= 10) tags.add("horde");
  return [...tags];
}

function availableModelCounts(unit: UnitView, ordinal = 1): number[] {
  const values = new Set<number>();
  for (const tier of unit.raw.points ?? []) {
    const minOrdinal = tier.unit_count_min ?? 1;
    const maxOrdinal = tier.unit_count_max ?? Number.POSITIVE_INFINITY;
    if (ordinal < minOrdinal || ordinal > maxOrdinal) continue;
    values.add(tier.models);
    if (tier.models_max) values.add(tier.models_max);
  }
  if (values.size === 0) values.add(unit.raw.model_count?.min ?? 1);
  return [...values]
    .filter((count) => !pointsTierMissing(unit.raw, count, ordinal))
    .sort((a, b) => a - b);
}

function getEquipment(
  unit: UnitView,
  modelCount: number,
): EquipmentSelection[] {
  const composition = dataset.unitCompositionOf(unit.raw);
  const loadout = baseLoadout(
    unit.raw,
    modelCount,
    dataset.wargearOptionsOf(unit.raw),
    composition?.models,
  );

  return [...loadout.counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([itemId, count]) => {
      const weapon = unit.weapons.find((candidate) => candidate.id === itemId);
      const looseWeapon = dataset.weapons.all.find(
        (candidate) =>
          candidate.id === itemId &&
          candidate.raw.faction_id === unit.raw.faction_id,
      );
      const otherWargear = dataset.wargear.all.find(
        (candidate) => candidate.id === itemId,
      );
      return {
        itemId,
        name: weapon?.name ?? looseWeapon?.name ?? otherWargear?.name ?? itemId,
        count,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function validEquipmentIds(unit: UnitView): Set<string> {
  const ids = new Set(unit.raw.weapon_ids ?? []);
  for (const option of dataset.wargearOptionsOf(unit.raw)) {
    for (const id of option.replaces ?? []) ids.add(id);
    for (const id of option.replacement ?? []) ids.add(id);
    for (const branch of option.replacement_choice ?? []) {
      for (const id of branch) ids.add(id);
    }
  }
  for (const model of dataset.unitCompositionOf(unit.raw)?.models ?? []) {
    for (const id of model.default_weapon_ids ?? []) ids.add(id);
  }
  return ids;
}

function equipmentLoadoutIsLegal(
  unit: UnitView,
  modelCount: number,
  equipment: EquipmentSelection[],
): boolean {
  const counts = new Map(
    equipment.map((entry) => [entry.itemId, entry.count]),
  );
  const verdict = validateRosterCore(
    {
      factionId: unit.raw.faction_id,
      battleSize: null,
      forceDisposition: null,
      detachmentIds: [],
      units: [
        {
          unitId: unit.id,
          modelCount,
          isWarlord: true,
          enhancementId: null,
          leaderBodyguardId: null,
          counts,
        },
      ],
    },
    dataset,
  );
  return (
    verdict.units.find(
      (candidate) =>
        candidate.unitId === unit.id &&
        candidate.modelCount === modelCount,
    )?.violations.length === 0
  );
}

function enhancementDetails(enhancementId: string | null): {
  name: string | null;
  cost: number;
} {
  if (!enhancementId) return { name: null, cost: 0 };
  const enhancement = enhancements.all.find(
    (candidate) => candidate.id === enhancementId,
  );
  return {
    name: enhancement?.name ?? enhancementId,
    cost: enhancement?.cost ?? 0,
  };
}

function selectionPoints(
  unit: UnitView,
  modelCount: number,
  ordinal: number,
  equipment: EquipmentSelection[],
  enhancementId: string | null,
): number {
  const counts = new Map(equipment.map((entry) => [entry.itemId, entry.count]));
  return (
    baseUnitPoints(unit.raw, modelCount, ordinal) +
    wargearPoints(unit.raw, counts) +
    enhancementDetails(enhancementId).cost
  );
}

function makeSelection(
  unit: UnitView,
  modelCount: number,
  ordinal: number,
  isWarlord: boolean,
  enhancementId: string | null = null,
  equipment?: EquipmentSelection[],
): DraftUnit {
  const resolvedEquipment = equipment ?? getEquipment(unit, modelCount);
  const enhancement = enhancementDetails(enhancementId);
  return {
    selectionId: deterministicId([
      unit.raw.faction_id,
      unit.id,
      ordinal,
      modelCount,
      isWarlord ? "warlord" : "unit",
    ]),
    unitId: unit.id,
    name: unit.name,
    role: unitRole(unit),
    modelCount,
    ordinal,
    points: selectionPoints(
      unit,
      modelCount,
      ordinal,
      resolvedEquipment,
      enhancementId,
    ),
    isWarlord,
    enhancementId,
    enhancementName: enhancement.name,
    equipment: resolvedEquipment,
    tags: unitTags(unit),
  };
}

function resolveFaction(query?: string) {
  if (!query) return factions.get(DEFAULT_FACTION_ID);
  const normalized = normalizeName(query);
  const exact = factions.all.find(
    (faction) =>
      faction.id === query ||
      normalizeName(faction.id) === normalized ||
      normalizeName(faction.name) === normalized ||
      (faction.raw.aliases ?? []).some(
        (alias) => normalizeName(alias) === normalized,
      ),
  );
  if (exact) return exact;
  const aliasId = Object.entries(FACTION_ALIASES).find(([alias]) =>
    normalized.includes(normalizeName(alias)),
  )?.[1];
  if (aliasId) return factions.get(aliasId);
  return (
    factions.find(query) ??
    factions.all.find(
      (faction) =>
        normalizeName(faction.name).includes(normalized) ||
        normalized.includes(normalizeName(faction.name)),
    )
  );
}

function resolveUnit(unitId: string, factionId?: string): UnitView | undefined {
  if (factionId) {
    for (const sourceFactionId of factionAncestry(factionId)) {
      const factionUnit = units
        .byFaction(sourceFactionId)
        .find(
          (unit) =>
            unit.id === unitId ||
            normalizeName(unit.name) === normalizeName(unitId),
        );
      if (factionUnit) return factionUnit;
    }
    return undefined;
  }
  return units.getAny(unitId) ?? units.find(unitId);
}

function dispositionName(dispositionId: string): string {
  return forceDispositions.get(dispositionId)?.name ?? dispositionId;
}

function recalculateDraft(
  draft: RosterDraftV1,
  nextUnits: DraftUnit[],
): RosterDraftV1 {
  const ordinals = new Map<string, number>();
  const unitsWithPoints = nextUnits.map((selection) => {
    const unit = resolveUnit(selection.unitId, draft.factionId);
    if (!unit) return selection;
    const ordinal = (ordinals.get(unit.id) ?? 0) + 1;
    ordinals.set(unit.id, ordinal);
    const enhancement = enhancementDetails(selection.enhancementId);
    return {
      ...selection,
      ordinal,
      points: selectionPoints(
        unit,
        selection.modelCount,
        ordinal,
        selection.equipment,
        selection.enhancementId,
      ),
      enhancementName: enhancement.name,
      tags: unitTags(unit),
    };
  });
  return {
    ...draft,
    units: unitsWithPoints,
    totalPoints: unitsWithPoints.reduce((sum, selection) => sum + selection.points, 0),
    updatedAt: nowIso(),
  };
}

export function parseRosterPrompt(prompt: string): BuildRosterInput {
  const normalized = normalizeName(prompt);
  const pointsMatch = prompt.match(/\b(\d{3,4}|\d,\d{3})\s*(?:points?|pts?)?\b/i);
  const preferences = (Object.entries(PREFERENCE_ALIASES) as Array<
    [PreferenceTag, string[]]
  >)
    .filter(([, aliases]) =>
      aliases.some((alias) => normalized.includes(normalizeName(alias))),
    )
    .map(([preference]) => preference);
  const faction = resolveFaction(prompt)?.id;

  return {
    prompt,
    faction,
    pointsLimit: pointsMatch
      ? Number(pointsMatch[1].replace(",", ""))
      : undefined,
    preferences,
    allowNamedCharacters: !/\b(no|without|exclude)\s+(named|epic)/i.test(prompt),
    allowLegends: /\b(include|allow|with)\s+legends?\b/i.test(prompt),
  };
}

export function getDataStatus(): ResultEnvelope<DataStatus> {
  const custodesUnits = units.byFaction(DEFAULT_FACTION_ID);
  const supportedFactionIds = factions.all
    .filter((faction) => isBuildableFaction(faction.id))
    .map((faction) => faction.id);
  return envelope({
    package: "@alpaca-software/40kdc-data",
    packageVersion: DATA_PACKAGE_VERSION,
    edition: "11th",
    dataslate: DATA_DATASLATE,
    supportedFactionIds,
    factionCount: factions.all.length,
    buildableFactionCount: supportedFactionIds.length,
    unitCount: units.all.length,
    provisionalPoints: units.all.filter(
      (unit) => unit.raw.points_provisional === true,
    ).length,
    custodesUnitCount: custodesUnits.length,
    provisionalCustodesPoints: custodesUnits.filter(
      (unit) => unit.raw.points_provisional === true,
    ).length,
    attribution: {
      text: "Powered by 40kdc-data",
      url: "https://40kdc.alpacasoft.dev",
    },
    sources: {
      releaseId: newRecruitCatalogue.releaseId,
      rules: newRecruitCatalogue.sources.rules,
      newRecruit: {
        repository: newRecruitCatalogue.sources.newRecruit.repository,
        commit: newRecruitCatalogue.sources.newRecruit.commit,
        gameSystemRevision: newRecruitCatalogue.gameSystem.revision,
        generatedAt: newRecruitCatalogue.generatedAt,
      },
      official: {
        mfmVersion: newRecruitCatalogue.sources.official.mfmVersion,
        updatedAt: newRecruitCatalogue.sources.official.updatedAt,
        contentSha256:
          newRecruitCatalogue.sources.official.contentSha256,
        checkedAt: newRecruitCatalogue.sources.official.checkedAt,
      },
    },
    freshness: {
      state: "pinned",
      checkedAt: newRecruitCatalogue.sources.official.checkedAt,
    },
    newRecruitCoverage: {
      factionCount: newRecruitCatalogue.summary.factionCount,
      exportCapableFactions:
        newRecruitCatalogue.summary.exportCapableFactions,
      completeFactions: newRecruitCatalogue.summary.completeFactions,
      engineUnits: newRecruitCatalogue.summary.engineUnits,
      mappedUnits: newRecruitCatalogue.summary.mappedUnits,
      mappedBaseLoadouts:
        newRecruitCatalogue.summary.mappedBaseLoadouts,
    },
    conflicts: {
      total: newRecruitCatalogue.summary.conflicts,
      blocking: newRecruitCatalogue.summary.blockingConflicts,
    },
  });
}

function summarizeFaction(factionId: string): FactionSummary | null {
  const faction = factions.get(factionId);
  if (!faction) return null;
  const factionUnitPool = factionUnits(faction.id);
  const tagCounts = new Map<PreferenceTag, number>();
  for (const unit of factionUnitPool) {
    for (const tag of unitTags(unit)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const styles = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([tag]) => tag);
  return {
    id: faction.id,
    name: faction.name,
    unitCount: factionUnitPool.length,
    supported: isBuildableFaction(faction.id),
    keywords: faction.raw.keywords ?? [],
    styles,
  };
}

export function searchFactions(
  query = "",
  limit = 20,
): ResultEnvelope<FactionSummary[]> {
  const normalized = normalizeName(query);
  const matches = factions.all
    .filter((faction) => {
      if (!normalized) return true;
      return normalizeName(
        [
          faction.name,
          ...(faction.raw.keywords ?? []),
          ...(faction.raw.aliases ?? []),
        ].join(" "),
      ).includes(normalized);
    })
    .map((faction) => summarizeFaction(faction.id))
    .filter((faction): faction is FactionSummary => faction !== null)
    .sort(
      (a, b) =>
        Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name),
    )
    .slice(0, Math.max(1, Math.min(limit, 100)));
  return envelope(matches);
}

export function compareFactions(
  factionQueries: string[],
): ResultEnvelope<FactionSummary[]> {
  const violations: RosterIssue[] = [];
  const matches: FactionSummary[] = [];
  for (const query of factionQueries) {
    const faction = resolveFaction(query);
    if (!faction) {
      violations.push(issue("FACTION_NOT_FOUND", `No faction matched "${query}".`));
      continue;
    }
    const summary = summarizeFaction(faction.id);
    if (summary) matches.push(summary);
  }
  return envelope(matches, violations);
}

function summarizeUnit(unit: UnitView): UnitSummary {
  const modelCounts = availableModelCounts(unit, 1);
  return {
    id: unit.id,
    name: unit.name,
    factionId: unit.raw.faction_id,
    role: unitRole(unit),
    pointsFrom: Math.min(
      ...modelCounts.map((modelCount) => baseUnitPoints(unit.raw, modelCount, 1)),
    ),
    modelCounts,
    tags: unitTags(unit),
    keywords: [...(unit.raw.keywords ?? []), ...(unit.raw.faction_keywords ?? [])],
    isNamedCharacter: isNamedCharacter(unit),
    isLegend: unit.raw.is_legend === true,
    supported: isBuildableFaction(unit.raw.faction_id),
  };
}

export function searchUnits(input: {
  faction?: string;
  query?: string;
  tags?: PreferenceTag[];
  includeLegends?: boolean;
  limit?: number;
}): ResultEnvelope<UnitSummary[]> {
  const faction = resolveFaction(input.faction);
  if (!faction) {
    return envelope<UnitSummary[]>(null, [
      issue("FACTION_NOT_FOUND", `No faction matched "${input.faction ?? ""}".`),
    ]);
  }
  const normalized = normalizeName(input.query ?? "");
  const desiredTags = new Set(input.tags ?? []);
  const matches = factionUnits(faction.id)
    .filter((unit) => input.includeLegends || unit.raw.is_legend !== true)
    .map(summarizeUnit)
    .filter((unit) => {
      const textMatch =
        !normalized ||
        normalizeName(
          [unit.name, unit.role, ...unit.keywords, ...unit.tags].join(" "),
        ).includes(normalized);
      const tagMatch =
        desiredTags.size === 0 ||
        [...desiredTags].every((tag) => unit.tags.includes(tag));
      return textMatch && tagMatch;
    })
    .sort(
      (a, b) =>
        b.tags.filter((tag) => desiredTags.has(tag)).length -
          a.tags.filter((tag) => desiredTags.has(tag)).length ||
        a.pointsFrom - b.pointsFrom ||
        a.name.localeCompare(b.name),
    )
    .slice(0, Math.max(1, Math.min(input.limit ?? 30, 100)));
  return envelope(matches);
}

function mergeBuildInput(input: BuildRosterInput): Required<
  Pick<
    BuildRosterInput,
    | "faction"
    | "pointsLimit"
    | "name"
    | "preferences"
    | "allowNamedCharacters"
    | "allowLegends"
  >
> &
  BuildRosterInput {
  const parsed = input.prompt ? parseRosterPrompt(input.prompt) : {};
  return {
    ...parsed,
    ...input,
    faction: input.faction ?? parsed.faction ?? DEFAULT_FACTION_ID,
    pointsLimit: Math.max(
      100,
      Math.min(input.pointsLimit ?? parsed.pointsLimit ?? 1000, 5000),
    ),
    name: input.name ?? "RosterPilot Draft",
    preferences: [
      ...new Set<PreferenceTag>(
        input.preferences ??
          parsed.preferences ??
          (["objective", "durability"] satisfies PreferenceTag[]),
      ),
    ],
    allowNamedCharacters:
      input.allowNamedCharacters ?? parsed.allowNamedCharacters ?? true,
    allowLegends: input.allowLegends ?? parsed.allowLegends ?? false,
  };
}

function candidateScore(
  unit: UnitView,
  modelCount: number,
  points: number,
  remaining: number,
  preferences: PreferenceTag[],
  currentCopies: number,
  hasWarlord: boolean,
): number {
  const tags = unitTags(unit);
  const preferenceScore =
    tags.filter((tag) => preferences.includes(tag)).length * 40;
  const fillScore = Math.max(0, 24 - Math.floor((remaining - points) / 10));
  const modelValue = Math.min(12, modelCount * 2);
  const objectiveFloor = tags.includes("objective") ? 8 : 0;
  const duplicatePenalty = currentCopies * 7;
  const extraCharacterPenalty =
    hasWarlord && isCharacterUnit(unit) ? 18 : 0;
  return (
    preferenceScore +
    fillScore +
    modelValue +
    objectiveFloor -
    duplicatePenalty -
    extraCharacterPenalty -
    points / 100
  );
}

export function buildRoster(
  rawInput: BuildRosterInput,
): ResultEnvelope<RosterDraftV1> {
  const input = mergeBuildInput(rawInput);
  const faction = resolveFaction(input.faction);
  if (!faction) {
    return envelope<RosterDraftV1>(null, [
      issue("FACTION_NOT_FOUND", `No faction matched "${input.faction}".`),
    ]);
  }
  if (!isBuildableFaction(faction.id)) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "UNSUPPORTED_FACTION",
        `${faction.name} does not have the priced units and matched-play detachments required for deterministic roster building.`,
      ),
    ]);
  }

  const battleSize =
    input.pointsLimit <= 1000 ? ("incursion" as const) : ("strike-force" as const);
  const detachmentCap = battleSize === "incursion" ? 2 : 3;
  const matchedDetachments = matchedPlayDetachments(faction.id);
  const requestedDetachment = input.detachmentId
    ? matchedDetachments.find(
        (detachment) => detachment.id === input.detachmentId,
      )
    : undefined;
  if (input.detachmentId && !requestedDetachment) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "DETACHMENT_NOT_FOUND",
        `"${input.detachmentId}" is not a matched-play ${faction.name} detachment.`,
      ),
    ]);
  }
  if (
    requestedDetachment &&
    (requestedDetachment.detachment_points ?? 0) > detachmentCap
  ) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "DETACHMENT_POINTS_OVER",
        `${requestedDetachment.name} costs ${requestedDetachment.detachment_points} DP; ${battleSize} armies allow ${detachmentCap}.`,
      ),
    ]);
  }
  const factionDetachments = matchedDetachments.filter(
    (detachment) =>
      detachment.detachment_points == null ||
      detachment.detachment_points <= detachmentCap,
  );
  const selectedDetachment =
    requestedDetachment ??
    factionDetachments.find((detachment) => detachment.id === "shield-host") ??
    [...factionDetachments].sort(
      (a, b) =>
        Number(Boolean(a.unit_minimums?.length)) -
          Number(Boolean(b.unit_minimums?.length)) ||
        Number(Boolean(a.restrictions)) - Number(Boolean(b.restrictions)) ||
        (a.detachment_points ?? 0) - (b.detachment_points ?? 0) ||
        a.name.localeCompare(b.name),
    )[0];
  if (!selectedDetachment) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "DETACHMENT_NOT_FOUND",
        `No matched-play ${faction.name} detachment fits the ${detachmentCap} DP limit.`,
      ),
    ]);
  }
  if (
    input.forceDispositionId &&
    !(selectedDetachment.force_dispositions ?? []).includes(
      input.forceDispositionId,
    )
  ) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "DISPOSITION_INVALID",
        `${input.forceDispositionId} is not offered by ${selectedDetachment.name}.`,
      ),
    ]);
  }
  const selectedDisposition =
    input.forceDispositionId ??
    selectedDetachment.force_dispositions?.[0] ??
    "purge-the-foe";

  const collection = input.collectionUnitIds
    ? new Set(input.collectionUnitIds)
    : null;
  const factionKeywords = new Set(faction.raw.keywords ?? []);
  const detachmentRestrictions = selectedDetachment.restrictions;
  const unitAllowedByDetachment = (unit: UnitView) => {
    const keywords = new Set([
      ...(unit.raw.keywords ?? []),
      ...(unit.raw.faction_keywords ?? []),
    ]);
    if (
      (unit.raw.excluded_faction_keywords ?? []).some((keyword) =>
        factionKeywords.has(keyword),
      )
    ) {
      return false;
    }
    if (
      (detachmentRestrictions?.required_keywords ?? []).some(
        (keyword) => !keywords.has(keyword),
      )
    ) {
      return false;
    }
    if (
      (detachmentRestrictions?.excluded_keywords ?? []).some((keyword) =>
        keywords.has(keyword),
      )
    ) {
      return false;
    }
    return true;
  };
  const factionUnitPool = factionUnits(faction.id)
    .filter(
      (unit) =>
        !unit.raw.game_modes || unit.raw.game_modes.includes("matched-play"),
    )
    .filter((unit) => input.allowLegends || unit.raw.is_legend !== true)
    .filter((unit) => input.allowNamedCharacters || !isNamedCharacter(unit))
    .filter((unit) => !collection || collection.has(unit.id))
    .filter((unit) => unit.raw.attachment_role !== "support")
    .filter(unitAllowedByDetachment)
    .filter((unit) => availableModelCounts(unit, 1).length > 0);

  const characterCandidates = factionUnitPool
    .filter(isCharacterUnit)
    .map((unit) => {
      const modelCount = availableModelCounts(unit, 1)[0];
      const equipment = getEquipment(unit, modelCount);
      return {
        unit,
        modelCount,
        equipment,
        points: selectionPoints(unit, modelCount, 1, equipment, null),
      };
    })
    .filter((candidate) =>
      equipmentLoadoutIsLegal(
        candidate.unit,
        candidate.modelCount,
        candidate.equipment,
      ),
    )
    .filter((candidate) => candidate.points <= input.pointsLimit)
    .sort(
      (a, b) =>
        candidateScore(
          b.unit,
          b.modelCount,
          b.points,
          input.pointsLimit,
          input.preferences,
          0,
          false,
        ) -
          candidateScore(
            a.unit,
            a.modelCount,
            a.points,
            input.pointsLimit,
            input.preferences,
            0,
            false,
          ) ||
        a.points - b.points ||
        a.unit.name.localeCompare(b.unit.name),
    );
  const warlord = characterCandidates[0];
  if (!warlord) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "NO_WARLORD_CANDIDATE",
        `No eligible ${faction.name} Character fits the point limit, detachment, and collection constraints.`,
      ),
    ]);
  }

  const selections: DraftUnit[] = [
    makeSelection(warlord.unit, warlord.modelCount, 1, true, null, warlord.equipment),
  ];
  let totalPoints = selections[0].points;
  const copies = new Map<string, number>([[warlord.unit.id, 1]]);

  for (let iteration = 0; iteration < 32; iteration += 1) {
    const remaining = input.pointsLimit - totalPoints;
    const candidates: Array<{
      unit: UnitView;
      modelCount: number;
      equipment: EquipmentSelection[];
      points: number;
      ordinal: number;
      score: number;
    }> = [];

    for (const unit of factionUnitPool) {
      const currentCopies = copies.get(unit.id) ?? 0;
      const maximumCopies = isNamedCharacter(unit) ? 1 : 3;
      if (currentCopies >= maximumCopies) continue;
      const ordinal = currentCopies + 1;
      for (const modelCount of availableModelCounts(unit, ordinal)) {
        const equipment = getEquipment(unit, modelCount);
        if (!equipmentLoadoutIsLegal(unit, modelCount, equipment)) continue;
        const points = selectionPoints(unit, modelCount, ordinal, equipment, null);
        if (points <= 0 || points > remaining) continue;
        candidates.push({
          unit,
          modelCount,
          equipment,
          points,
          ordinal,
          score: candidateScore(
            unit,
            modelCount,
            points,
            remaining,
            input.preferences,
            currentCopies,
            true,
          ),
        });
      }
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        b.points - a.points ||
        a.unit.name.localeCompare(b.unit.name) ||
        a.modelCount - b.modelCount,
    );
    const next = candidates[0];
    if (!next) break;
    selections.push(
      makeSelection(
        next.unit,
        next.modelCount,
        next.ordinal,
        false,
        null,
        next.equipment,
      ),
    );
    copies.set(next.unit.id, next.ordinal);
    totalPoints += next.points;
  }

  const timestamp = nowIso();
  const draft: RosterDraftV1 = {
    schemaVersion: ROSTER_SCHEMA_VERSION,
    gameSystem: SUPPORTED_GAME,
    sourceData: {
      ...currentRosterSourceData(faction.id),
    },
    id: deterministicId([
      faction.id,
      input.name,
      input.pointsLimit,
      input.preferences.join(","),
      selections.map((selection) => selection.unitId).join(","),
    ]),
    name: input.name,
    factionId: faction.id,
    factionName: faction.name,
    pointsLimit: input.pointsLimit,
    totalPoints,
    battleSize,
    detachmentId: selectedDetachment.id,
    detachmentName: selectedDetachment.name,
    forceDispositionId: selectedDisposition,
    forceDispositionName: dispositionName(selectedDisposition),
    preferences: input.preferences,
    constraints: {
      allowNamedCharacters: input.allowNamedCharacters,
      allowLegends: input.allowLegends,
      collectionUnitIds: input.collectionUnitIds ?? null,
    },
    units: selections,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const validation = validateRoster(draft);
  return {
    ok: validation.ok,
    data: draft,
    violations: validation.violations,
    warnings: validation.warnings,
  };
}

function ref(id: string | null, rawName: string) {
  return {
    id,
    raw_name: rawName,
    resolved: id !== null,
    candidates: [],
  };
}

export function toCanonicalRoster(draft: RosterDraftV1): Roster {
  const rosterUnits: RosterUnit[] = draft.units.map((selection) => {
    const unit = resolveUnit(selection.unitId, draft.factionId);
    const enhancement = enhancementDetails(selection.enhancementId);
    return {
      ref: ref(unit?.id ?? null, selection.name),
      model_count: selection.modelCount,
      points: selection.points - enhancement.cost,
      is_warlord: selection.isWarlord,
      enhancement: selection.enhancementId
        ? ref(selection.enhancementId, enhancement.name ?? selection.enhancementId)
        : null,
      enhancement_points: selection.enhancementId ? enhancement.cost : null,
      wargear: selection.equipment.map((equipment) => ({
        ref: ref(equipment.itemId, equipment.name),
        count: equipment.count,
      })),
      leader_attachment: null,
    };
  });
  const detachment = resolveDetachment(draft.detachmentId, draft.factionId);
  const resolvedUnits = rosterUnits.filter((unit) => unit.ref.resolved).length;
  const resolvedWargear = rosterUnits.reduce(
    (sum, unit) =>
      sum + unit.wargear.filter((equipment) => equipment.ref.resolved).length,
    0,
  );

  return {
    name: draft.name,
    source: { format: "roster-json", generated_by: "RosterPilot" },
    faction_id: draft.factionId,
    detachments: [
      {
        ref: ref(detachment?.id ?? null, draft.detachmentName),
        dp_cost: detachment?.detachment_points ?? null,
      },
    ],
    battle_size: draft.battleSize,
    force_disposition: draft.forceDispositionId,
    points: {
      declared_limit: draft.pointsLimit,
      detachment_cap: draft.battleSize === "incursion" ? 2 : 3,
      total_reported: draft.totalPoints,
      total_computed: draft.totalPoints,
    },
    units: rosterUnits,
    game_version: { edition: DATA_EDITION, dataslate: DATA_DATASLATE },
    diagnostics: {
      resolved_units: resolvedUnits,
      unresolved_units: rosterUnits.length - resolvedUnits,
      resolved_weapons: resolvedWargear,
      unresolved_weapons: rosterUnits.reduce(
        (sum, unit) =>
          sum + unit.wargear.filter((equipment) => !equipment.ref.resolved).length,
        0,
      ),
      warnings: [],
    },
  };
}

export function validateRoster(
  draft: RosterDraftV1,
): ResultEnvelope<{ legal: boolean; totalPoints: number }> {
  const parsed = parseRosterDraft(draft);
  if (!parsed.success) {
    return envelope<{ legal: boolean; totalPoints: number }>(null, [
      issue(
        "MALFORMED_ROSTER",
        `Roster draft validation failed: ${parsed.error.issues
          .slice(0, 3)
          .map((problem) => `${problem.path.join(".") || "root"}: ${problem.message}`)
          .join("; ")}`,
      ),
    ]);
  }
  draft = parsed.data;
  const violations: RosterIssue[] = [];
  const warnings: RosterIssue[] = [];
  if (parsed.migrated) {
    warnings.push(
      issue(
        "DATA_PROVENANCE_INCOMPLETE",
        "This V1 roster was migrated to the current data release; rebuild it when historical source provenance matters.",
        "warn",
      ),
    );
  }
  if (draft.gameSystem !== SUPPORTED_GAME) {
    violations.push(issue("GAME_SYSTEM", `Unsupported game system "${draft.gameSystem}".`));
  }
  const configuredFaction = factions.get(draft.factionId);
  if (!configuredFaction || !isBuildableFaction(draft.factionId)) {
    violations.push(
      issue(
        "UNSUPPORTED_FACTION",
        `"${draft.factionName}" does not have complete deterministic build inputs in the pinned dataset.`,
      ),
    );
  }
  if (!Number.isInteger(draft.pointsLimit) || draft.pointsLimit <= 0) {
    violations.push(
      issue(
        "POINT_LIMIT_INVALID",
        "A roster must have a positive integer point limit.",
      ),
    );
  } else if (draft.totalPoints > draft.pointsLimit) {
    violations.push(
      issue(
        "POINTS_OVER_LIMIT",
        `Roster is ${draft.totalPoints - draft.pointsLimit} points over the limit.`,
      ),
    );
  }
  const warlords = draft.units.filter((selection) => selection.isWarlord);
  if (warlords.length === 0) {
    violations.push(issue("NO_WARLORD", "Army has no warlord."));
  } else if (warlords.length > 1) {
    violations.push(issue("MULTIPLE_WARLORDS", "Army has multiple warlords."));
  }
  const configuredDetachment = resolveDetachment(
    draft.detachmentId,
    draft.factionId,
  );
  if (
    !configuredDetachment ||
    configuredDetachment.faction_id !== draft.factionId
  ) {
    violations.push(
      issue(
        "DETACHMENT_NOT_FOUND",
        `"${draft.detachmentName}" is not a valid ${draft.factionName} detachment.`,
      ),
    );
  } else if (
    !(configuredDetachment.force_dispositions ?? []).includes(
      draft.forceDispositionId,
    )
  ) {
    violations.push(
      issue(
        "DISPOSITION_INVALID",
        `${draft.forceDispositionName} is not valid for ${draft.detachmentName}.`,
      ),
    );
  }

  const recalculated = recalculateDraft(draft, draft.units);
  if (recalculated.totalPoints !== draft.totalPoints) {
    violations.push(
      issue(
        "POINTS_MISMATCH",
        `Stored total is ${draft.totalPoints}; deterministic total is ${recalculated.totalPoints}.`,
      ),
    );
  }

  for (const selection of draft.units) {
    const unit = resolveUnit(selection.unitId, draft.factionId);
    if (!unit) {
      violations.push(
        issue(
          "UNIT_NOT_FOUND",
          `Unit "${selection.name}" is not present in the pinned dataset.`,
          "error",
          selection.selectionId,
        ),
      );
      continue;
    }
    const equipmentIds = validEquipmentIds(unit);
    for (const equipment of selection.equipment) {
      if (!equipmentIds.has(equipment.itemId)) {
        violations.push(
          issue(
            "EQUIPMENT_NOT_FOUND",
            `Equipment "${equipment.name}" is not valid for ${selection.name}.`,
            "error",
            selection.selectionId,
          ),
        );
      }
      if (!Number.isInteger(equipment.count) || equipment.count < 0) {
        violations.push(
          issue(
            "INVALID_EQUIPMENT_COUNT",
            `${equipment.name} must have a non-negative integer count.`,
            "error",
            selection.selectionId,
          ),
        );
      }
    }
  }

  if (violations.length === 0) {
    const verdict = checkRoster(toCanonicalRoster(recalculated), dataset);
    for (const armyIssue of verdict.army) {
      const mapped = issue(
        armyIssue.code.toUpperCase().replaceAll("-", "_"),
        armyIssue.message,
        armyIssue.severity,
        armyIssue.unitIndex === null
          ? undefined
          : recalculated.units[armyIssue.unitIndex]?.selectionId,
      );
      if (armyIssue.severity === "warn") warnings.push(mapped);
      else violations.push(mapped);
    }
    for (const unitVerdict of verdict.units) {
      for (const loadoutIssue of unitVerdict.violations) {
        violations.push(
          issue(
            `LOADOUT_${loadoutIssue.code.toUpperCase().replaceAll("-", "_")}`,
            loadoutIssue.message,
            "error",
            recalculated.units[unitVerdict.unitIndex]?.selectionId,
          ),
        );
      }
    }
  }

  if (draft.sourceData.version !== DATA_PACKAGE_VERSION) {
    warnings.push(
      issue(
        "DATA_VERSION_CHANGED",
        `This roster was created with data ${draft.sourceData.version}; the engine is pinned to ${DATA_PACKAGE_VERSION}.`,
        "warn",
      ),
    );
  }
  if (draft.sourceData.releaseId !== newRecruitCatalogue.releaseId) {
    warnings.push(
      issue(
        "DATA_RELEASE_CHANGED",
        `This roster was created with release ${draft.sourceData.releaseId}; the engine is pinned to ${newRecruitCatalogue.releaseId}.`,
        "warn",
      ),
    );
  }
  if (
    draft.sourceData.newRecruit.commit !==
    newRecruitCatalogue.sources.newRecruit.commit
  ) {
    warnings.push(
      issue(
        "CATALOGUE_VERSION_CHANGED",
        "The pinned New Recruit catalogue changed after this roster was created.",
        "warn",
      ),
    );
  }
  for (const sourceConflict of conflictsForRoster(draft)) {
    warnings.push(
      issue(
        "DATA_SOURCE_CONFLICT",
        sourceConflict.message,
        "warn",
        draft.units.find(
          (selection) =>
            sourceConflict.entityId === selection.unitId ||
            sourceConflict.entityId.startsWith(`${selection.unitId}:`),
        )?.selectionId,
      ),
    );
  }
  for (const selection of draft.units) {
    const unit = resolveUnit(selection.unitId, draft.factionId);
    if (unit?.raw.points_provisional === true) {
      warnings.push(
        issue(
          "PROVISIONAL_POINTS",
          `${selection.name} uses provisional community points.`,
          "warn",
          selection.selectionId,
        ),
      );
    }
  }
  if (draft.pointsLimit > 0 && draft.totalPoints < draft.pointsLimit) {
    warnings.push(
      issue(
        "POINTS_REMAIN",
        `${draft.pointsLimit - draft.totalPoints} points remain unused.`,
        "warn",
      ),
    );
  }

  return envelope(
    { legal: violations.length === 0, totalPoints: recalculated.totalPoints },
    violations,
    warnings,
  );
}

export function modifyRoster(
  draft: RosterDraftV1,
  operation: ModifyRosterOperation,
): ResultEnvelope<RosterDraftV1> {
  const parsed = parseRosterDraft(draft);
  if (!parsed.success) {
    return envelope<RosterDraftV1>(null, [
      issue("MALFORMED_ROSTER", "The supplied roster is not a valid roster draft."),
    ]);
  }
  const operationSchema = ModifyRosterOperationSchema.safeParse(operation);
  if (!operationSchema.success) {
    return envelope<RosterDraftV1>(null, [
      issue("MALFORMED_OPERATION", "The requested roster modification is invalid."),
    ]);
  }
  draft = parsed.data;
  operation = operationSchema.data;
  let next = structuredClone(draft);
  const fail = (code: string, message: string) => envelope<RosterDraftV1>(null, [
    issue(code, message),
  ]);

  if (operation.type === "add" || operation.type === "replace") {
    const unit = resolveUnit(operation.unitId, draft.factionId);
    if (!unit || unit.raw.faction_id !== draft.factionId) {
      return fail("UNIT_NOT_FOUND", `Unit "${operation.unitId}" is not in ${draft.factionName}.`);
    }
    const count =
      operation.modelCount ??
      availableModelCounts(unit, 1)[0] ??
      unit.raw.model_count?.min ??
      1;
    const ordinal =
      draft.units.filter((selection) => selection.unitId === unit.id).length + 1;
    const selection = makeSelection(unit, count, ordinal, false);
    if (operation.type === "add") next.units.push(selection);
    else {
      const index = next.units.findIndex(
        (candidate) => candidate.selectionId === operation.selectionId,
      );
      if (index < 0) return fail("SELECTION_NOT_FOUND", "Roster selection was not found.");
      selection.selectionId = next.units[index].selectionId;
      selection.isWarlord = next.units[index].isWarlord;
      next.units[index] = selection;
    }
  } else if (operation.type === "remove") {
    const before = next.units.length;
    next.units = next.units.filter(
      (selection) => selection.selectionId !== operation.selectionId,
    );
    if (next.units.length === before) {
      return fail("SELECTION_NOT_FOUND", "Roster selection was not found.");
    }
  } else if (operation.type === "set-model-count") {
    const selection = next.units.find(
      (candidate) => candidate.selectionId === operation.selectionId,
    );
    if (!selection) return fail("SELECTION_NOT_FOUND", "Roster selection was not found.");
    const unit = resolveUnit(selection.unitId, draft.factionId);
    if (!unit || pointsTierMissing(unit.raw, operation.modelCount, selection.ordinal)) {
      return fail(
        "INVALID_MODEL_COUNT",
        `${operation.modelCount} is not a priced model count for ${selection.name}.`,
      );
    }
    selection.modelCount = operation.modelCount;
    selection.equipment = getEquipment(unit, operation.modelCount);
  } else if (operation.type === "set-warlord") {
    if (!next.units.some((selection) => selection.selectionId === operation.selectionId)) {
      return fail("SELECTION_NOT_FOUND", "Roster selection was not found.");
    }
    next.units = next.units.map((selection) => ({
      ...selection,
      isWarlord: selection.selectionId === operation.selectionId,
    }));
  } else if (operation.type === "set-equipment") {
    const selection = next.units.find(
      (candidate) => candidate.selectionId === operation.selectionId,
    );
    if (!selection) return fail("SELECTION_NOT_FOUND", "Roster selection was not found.");
    const unit = resolveUnit(selection.unitId, draft.factionId);
    if (!unit) return fail("UNIT_NOT_FOUND", `Unit "${selection.unitId}" was not found.`);
    selection.equipment = operation.equipment.map(({ itemId, count }) => ({
      itemId,
      count,
      name:
        unit.weapons.find((weapon) => weapon.id === itemId)?.name ??
        dataset.wargear.all.find((item) => item.id === itemId)?.name ??
        itemId,
    }));
  } else if (operation.type === "set-enhancement") {
    const selection = next.units.find(
      (candidate) => candidate.selectionId === operation.selectionId,
    );
    if (!selection) return fail("SELECTION_NOT_FOUND", "Roster selection was not found.");
    selection.enhancementId = operation.enhancementId;
  } else if (operation.type === "set-detachment") {
    const detachment = resolveDetachment(
      operation.detachmentId,
      draft.factionId,
    );
    if (!detachment) {
      return fail("DETACHMENT_NOT_FOUND", "Detachment is not valid for this faction.");
    }
    next.detachmentId = detachment.id;
    next.detachmentName = detachment.name;
    next.forceDispositionId =
      operation.forceDispositionId &&
      (detachment.force_dispositions ?? []).includes(operation.forceDispositionId)
        ? operation.forceDispositionId
        : detachment.force_dispositions?.[0] ?? next.forceDispositionId;
    next.forceDispositionName = dispositionName(next.forceDispositionId);
  } else if (operation.type === "set-disposition") {
    next.forceDispositionId = operation.forceDispositionId;
    next.forceDispositionName = dispositionName(operation.forceDispositionId);
  }

  next = recalculateDraft(next, next.units);
  const validation = validateRoster(next);
  return {
    ok: validation.ok,
    data: next,
    violations: validation.violations,
    warnings: validation.warnings,
  };
}

export function explainRoster(draft: RosterDraftV1): ResultEnvelope<{
  summary: string;
  choices: string[];
  cautions: string[];
}> {
  const validation = validateRoster(draft);
  if (
    !validation.ok &&
    validation.violations.some((item) => item.code === "MALFORMED_ROSTER")
  ) {
    return envelope<{
      summary: string;
      choices: string[];
      cautions: string[];
    }>(null, validation.violations, validation.warnings);
  }
  const parsed = parseRosterDraft(draft);
  if (!parsed.success) {
    return envelope<{
      summary: string;
      choices: string[];
      cautions: string[];
    }>(null, validation.violations, validation.warnings);
  }
  draft = parsed.data;
  const preferenceText = draft.preferences.length
    ? draft.preferences.join(", ")
    : "general-purpose play";
  const choices = draft.units.map((selection) => {
    const matching = selection.tags.filter((tag) => draft.preferences.includes(tag));
    return `${selection.modelCount} ${selection.name} (${selection.points} pts)${
      matching.length ? ` supports ${matching.join(" and ")}` : " adds a complementary role"
    }.`;
  });
  return {
    ok: validation.ok,
    data: {
      summary: `${draft.name} is a ${draft.totalPoints}/${draft.pointsLimit}-point ${draft.factionName} roster built around ${preferenceText}. It uses ${draft.detachmentName} with ${draft.forceDispositionName}.`,
      choices,
      cautions: [
        ...validation.violations.map((item) => item.message),
        ...validation.warnings.map((item) => item.message),
        "Community data is pinned; confirm event-specific rulings before play.",
      ],
    },
    violations: validation.violations,
    warnings: validation.warnings,
  };
}

function exportText(draft: RosterDraftV1): string {
  const lines = [
    draft.name,
    `${draft.factionName} — ${draft.totalPoints}/${draft.pointsLimit} pts`,
    `${draft.detachmentName} · ${draft.forceDispositionName}`,
    "",
    ...draft.units.map(
      (selection) =>
        `${selection.isWarlord ? "★ " : ""}${selection.modelCount}× ${selection.name} — ${selection.points} pts`,
    ),
    "",
    `Data: 40kdc-data ${draft.sourceData.version} (${draft.sourceData.edition}, ${draft.sourceData.dataslate})`,
    "Validate against current event rules before play.",
  ];
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function exportHtml(draft: RosterDraftV1): string {
  const rows = draft.units
    .map(
      (selection) => `<article>
  <div><strong>${escapeHtml(selection.name)}</strong><span>${escapeHtml(selection.role)} · ${selection.modelCount} models${selection.isWarlord ? " · Warlord" : ""}</span></div>
  <b>${selection.points} pts</b>
</article>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(draft.name)}</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;color:#171912;max-width:760px;margin:40px auto;padding:0 24px}
header{border-bottom:3px solid #b18d27;padding-bottom:18px;margin-bottom:18px}h1{margin:0 0 6px}
p{margin:4px 0;color:#555}article{display:flex;justify-content:space-between;gap:24px;padding:13px 0;border-bottom:1px solid #ddd}
article div{display:flex;flex-direction:column}article span{font-size:12px;color:#666}footer{margin-top:30px;font-size:11px;color:#666}
@media print{body{margin:0;max-width:none}a{color:inherit;text-decoration:none}}
</style></head><body>
<header><h1>${escapeHtml(draft.name)}</h1><p>${escapeHtml(draft.factionName)} · ${draft.totalPoints}/${draft.pointsLimit} points</p>
<p>${escapeHtml(draft.detachmentName)} · ${escapeHtml(draft.forceDispositionName)}</p></header>
<main>${rows}</main>
<footer>Powered by 40kdc-data · ${escapeHtml(draft.sourceData.version)} · Community data; verify event rules.</footer>
</body></html>`;
}

export async function exportRoster(
  draft: RosterDraftV1,
  format: ExportFormat,
): Promise<ResultEnvelope<ExportArtifact>> {
  const validation = validateRoster(draft);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }
  const parsed = parseRosterDraft(draft);
  if (!parsed.success) {
    return envelope<ExportArtifact>(null, [
      issue("MALFORMED_ROSTER", "The supplied roster is not a valid roster draft."),
    ]);
  }
  draft = parsed.data;
  const canonical = toCanonicalRoster(draft);
  const basename = slug(draft.name) || "rosterpilot-draft";
  try {
    if (format === "text") {
      return envelope(
        {
          format,
          filename: `${basename}.txt`,
          mimeType: "text/plain;charset=utf-8",
          encoding: "utf8",
          content: exportText(draft),
        },
        [],
        validation.warnings,
      );
    }
    if (format === "html") {
      return envelope(
        {
          format,
          filename: `${basename}.html`,
          mimeType: "text/html;charset=utf-8",
          encoding: "utf8",
          content: exportHtml(draft),
        },
        [],
        validation.warnings,
      );
    }
    if (format === "roster-json" || format === "newrecruit-json") {
      return envelope(
        {
          format,
          filename: `${basename}.json`,
          mimeType: "application/json",
          encoding: "utf8",
          content: export40kRoster(canonical, format),
        },
        [],
        validation.warnings,
      );
    }
    const capability = getNewRecruitCapability(draft.factionId);
    if (!capability.available) {
      return envelope<ExportArtifact>(null, [
        issue(
          "NEW_RECRUIT_MAPPING_UNAVAILABLE",
          `New Recruit .ros/.rosz catalogue mappings are not available for ${draft.factionName}. ${capability.reason ?? "Export printable HTML or roster JSON instead."}`,
        ),
      ]);
    }
    const blockingConflicts = conflictsForRoster(draft).filter(
      (item) => item.blocking,
    );
    if (blockingConflicts.length > 0) {
      return envelope<ExportArtifact>(null, [
        issue(
          "NEW_RECRUIT_DATA_CONFLICT",
          `New Recruit export is blocked because ${blockingConflicts.length} selected mapping or source conflict${
            blockingConflicts.length === 1 ? "" : "s"
          } require review: ${blockingConflicts
            .slice(0, 3)
            .map((item) => item.message)
            .join(" ")}`,
        ),
      ]);
    }
    const { newRecruitRos } = await import("./new-recruit");
    const ros = newRecruitRos(draft);
    if (format === "ros") {
      return envelope(
        {
          format,
          filename: `${basename}.ros`,
          mimeType: "application/xml",
          encoding: "utf8",
          content: ros,
        },
        [],
        validation.warnings,
      );
    }
    return envelope(
      {
        format,
        filename: `${basename}.rosz`,
        mimeType: "application/zip",
        encoding: "binary",
        content: zipSync({ [`${basename}.ros`]: strToU8(ros) }, { level: 6 }),
      },
      [],
      validation.warnings,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Roster export failed.";
    const newRecruitMappingFailure =
      (format === "ros" || format === "rosz") &&
      message.startsWith("New Recruit");
    return envelope<ExportArtifact>(null, [
      issue(
        newRecruitMappingFailure
          ? "NEW_RECRUIT_MAPPING_UNAVAILABLE"
          : "EXPORT_FAILED",
        message,
      ),
    ]);
  }
}

export function listDetachments(factionId: string = DEFAULT_FACTION_ID) {
  return matchedPlayDetachments(factionId)
    .map((detachment) => ({
      id: detachment.id,
      name: detachment.name,
      detachmentPoints: detachment.detachment_points,
      forceDispositions: (detachment.force_dispositions ?? []).map((id) => ({
        id,
        name: dispositionName(id),
      })),
    }));
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triplet = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += alphabet[(triplet >> 18) & 63];
    result += alphabet[(triplet >> 12) & 63];
    result += second === undefined ? "=" : alphabet[(triplet >> 6) & 63];
    result += third === undefined ? "=" : alphabet[triplet & 63];
  }
  return result;
}
