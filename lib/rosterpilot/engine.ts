import {
  baseLoadout,
  baseUnitPoints,
  checkRoster,
  exportRoster as export40kRoster,
  normalizeName,
  optionCap,
  pointsTierMissing,
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
  type OpponentThreatProfile,
  type PreferenceTag,
  type ResultEnvelope,
  type RosterDraftV1,
  type RosterIssue,
  type TesseraProfileRequirement,
  type UnitSummary,
} from "./types";
import {
  conflictBlocksAllUnitConfigurations,
  conflictsForRoster,
  getNewRecruitCapability,
  newRecruitCatalogue,
} from "./catalogue-summary";
import { getNewRecruitFactionCatalogue } from "./catalogue";
import {
  currentRosterSourceData,
  parseRosterDraft,
  rebaseRosterData,
  stampRosterDataIdentity,
} from "./draft";
import {
  dataset,
  detachments,
  enhancements,
  factions,
  forceDispositions,
  units,
} from "./runtime-dataset";
import {
  newRecruitEquipmentSignature,
  resolveNewRecruitUnit,
} from "./new-recruit-resolver";
import {
  getDataUpdateStatusSnapshot,
} from "./data-operations";
import {
  detectLegendsPromptIntent,
  LegendsPlayContextSchema,
  LegendsPolicySchema,
  resolveLegendsPolicy,
  type LegendsClassificationAuthority,
  type LegendsPolicyDecision,
} from "./legends-policy";
import {
  activeFactionLegendsState,
} from "./legends";
import { resolveFactionIntent } from "./faction-intent";

export let DATA_PACKAGE_VERSION =
  newRecruitCatalogue.sources.rules.version;
export let DATA_EDITION = newRecruitCatalogue.sources.rules.edition;
export let DATA_DATASLATE =
  newRecruitCatalogue.sources.rules.dataslate;

export function refreshRuntimeDataConstants(): void {
  DATA_PACKAGE_VERSION = newRecruitCatalogue.sources.rules.version;
  DATA_EDITION = newRecruitCatalogue.sources.rules.edition;
  DATA_DATASLATE = newRecruitCatalogue.sources.rules.dataslate;
}

export const DEPRECATED_DATA_WARNING_CODE_ALIASES = {
  DATA_VERSION_CHANGED: "DATA_PROVENANCE_CHANGED",
  DATA_RELEASE_CHANGED: "DATA_PROVENANCE_CHANGED",
  CATALOGUE_VERSION_CHANGED: "DATA_PROVENANCE_CHANGED",
  OFFICIAL_UPDATE_PENDING: "DATA_SEMANTICS_CHANGED",
  DATA_UPDATE_AVAILABLE: "DATA_PROVENANCE_CHANGED",
} as const;

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
  mobility: [
    "mobility",
    "fast",
    "mobile",
    "speed",
    "rapid",
    "flank",
    "jetbike",
  ],
  durability: [
    "durability",
    "durable",
    "tough",
    "resilient",
    "forgiving",
    "tank",
    "survive",
  ],
  objective: ["objective", "scoring", "board control", "hold", "mission"],
  shooting: [
    "shooting",
    "ranged",
    "firepower",
    "guns",
    "mixed threat",
    "mixed-threat",
  ],
  melee: [
    "melee",
    "combat",
    "fight",
    "aggressive",
    "charge",
    "mixed threat",
    "mixed-threat",
  ],
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

function isWarlordEligible(unit: UnitView): boolean {
  return normalizedKeywords(unit).includes("character");
}

function isNamedCharacter(unit: UnitView): boolean {
  const keywords = normalizedKeywords(unit);
  return (
    keywords.includes("epic hero") ||
    keywords.includes("named character")
  );
}

export function rosterHasNamedCharacter(
  roster: RosterDraftV1,
): boolean {
  return roster.units.some((selection) => {
    const unit = resolveUnit(selection.unitId, roster.factionId);
    return unit ? isNamedCharacter(unit) : false;
  });
}

export function factionHasLegalNamedAnchor(
  factionId: string,
  pointsLimit: number,
  excludedUnitIds: ReadonlySet<string> = new Set(),
): boolean {
  return factionUnits(factionId).some(
    (unit) =>
      !excludedUnitIds.has(unit.id) &&
      isNamedCharacter(unit) &&
      unit.raw.attachment_role !== "support" &&
      availableModelCounts(unit, 1).some((modelCount) => {
        const equipment = getEquipment(unit, modelCount);
        return (
          equipmentLoadoutIsLegal(unit, modelCount, equipment) &&
          selectionPoints(unit, modelCount, 1, equipment, null) <=
            pointsLimit
        );
      }),
  );
}

export function namedAnchorCollectionVariants(
  factionId: string,
  pointsLimit: number,
): string[][] {
  const pool = factionUnits(factionId).filter(
    (unit) =>
      unit.raw.attachment_role !== "support" &&
      availableModelCounts(unit, 1).length > 0,
  );
  const nonCharacters = pool
    .filter((unit) => !isCharacterUnit(unit))
    .map((unit) => unit.id);
  return pool
    .filter(isNamedCharacter)
    .filter((unit) =>
      availableModelCounts(unit, 1).some((modelCount) => {
        const equipment = getEquipment(unit, modelCount);
        return (
          equipmentLoadoutIsLegal(unit, modelCount, equipment) &&
          selectionPoints(unit, modelCount, 1, equipment, null) <=
            pointsLimit
        );
      }),
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 4)
    .map((anchor) => [anchor.id, ...nonCharacters].sort());
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

function factionLegendsStates(factionId: string) {
  return factionAncestry(factionId).map((sourceFactionId) =>
    activeFactionLegendsState(sourceFactionId),
  );
}

function factionLegendsClassificationAuthority(
  factionId: string,
): LegendsClassificationAuthority {
  const states = factionLegendsStates(factionId);
  if (
    states.every(
      (state) =>
        state.classificationAuthority ===
          "games-workshop-verified" &&
        (
          state.coverageStatus === "complete" ||
          state.coverageStatus === "not-published"
        ),
    )
  ) {
    return "verified";
  }
  return states.some(
    (state) =>
      state.classificationAuthority ===
      "games-workshop-unverified-overlay",
  )
    ? "unverified-overlay"
    : "unavailable";
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
  let loadout: ReturnType<typeof baseLoadout>;
  try {
    loadout = baseLoadout(
      unit.raw,
      modelCount,
      dataset.wargearOptionsOf(unit.raw),
      composition?.models,
    );
  } catch {
    // Some upstream catalogue entries contain cyclic loadout allocation rules.
    // Keep roster generation fail-closed for that unit instead of allowing an
    // unbounded recursive allocator to terminate the entire build.
    return [{
      itemId: "__loadout-resolution-failed__",
      name: "Unresolved catalogue loadout",
      count: 1,
    }];
  }

  return equipmentFromCounts(unit, loadout.counts);
}

function equipmentFromCounts(
  unit: UnitView,
  counts: ReadonlyMap<string, number>,
): EquipmentSelection[] {
  return [...counts.entries()]
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

function equipmentSignature(
  equipment: EquipmentSelection[],
): string {
  return newRecruitEquipmentSignature(equipment);
}

function equipmentCandidates(
  unit: UnitView,
  modelCount: number,
  opponentProfile: OpponentBuildProfile | null,
): EquipmentSelection[][] {
  const base = getEquipment(unit, modelCount);
  if (!opponentProfile) return [base];
  const composition = dataset.unitCompositionOf(unit.raw);
  const candidates = new Map<string, EquipmentSelection[]>();
  const addCandidate = (equipment: EquipmentSelection[]) => {
    if (!equipmentLoadoutIsLegal(unit, modelCount, equipment)) {
      return;
    }
    candidates.set(equipmentSignature(equipment), equipment);
  };
  addCandidate(base);
  for (const option of dataset.wargearOptionsOf(unit.raw)) {
    const rawCap = optionCap(
      option,
      modelCount,
      composition?.models,
    );
    const cap =
      Number.isFinite(rawCap) && rawCap > 0
        ? Math.floor(rawCap)
        : 0;
    if (cap <= 0) continue;
    const branches =
      option.replacement_choice &&
      option.replacement_choice.length > 0
        ? option.replacement_choice
        : option.replacement &&
            option.replacement.length > 0
          ? [option.replacement]
          : [];
    for (const branch of branches) {
      const counts = new Map(
        base.map((entry) => [entry.itemId, entry.count]),
      );
      let applicable = true;
      for (const replaced of option.replaces ?? []) {
        const current = counts.get(replaced) ?? 0;
        if (current < cap) {
          applicable = false;
          break;
        }
        const next = current - cap;
        if (next > 0) counts.set(replaced, next);
        else counts.delete(replaced);
      }
      if (!applicable) continue;
      for (const replacement of branch) {
        counts.set(
          replacement,
          (counts.get(replacement) ?? 0) + cap,
        );
      }
      addCandidate(equipmentFromCounts(unit, counts));
    }
  }
  return [...candidates.values()]
    .sort(
      (left, right) =>
        equipmentContextScore(
          unit,
          right,
          opponentProfile,
        ) -
          equipmentContextScore(
            unit,
            left,
            opponentProfile,
          ) ||
        equipmentSignature(left).localeCompare(
          equipmentSignature(right),
        ),
    )
    .slice(0, 16);
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
  try {
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
  } catch {
    return false;
  }
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

function factionMentions(prompt: string): string[] {
  const mentionText = (value: string) =>
    normalizeName(value.replaceAll("-", " "))
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const normalized = mentionText(prompt);
  const aliasesByFaction = new Map<string, string[]>();
  for (const [alias, factionId] of Object.entries(FACTION_ALIASES)) {
    aliasesByFaction.set(factionId, [
      ...(aliasesByFaction.get(factionId) ?? []),
      alias,
    ]);
  }
  const phrases = factions.all
    .flatMap((faction) =>
      [
        faction.id,
        faction.name,
        ...(faction.raw.aliases ?? []),
        ...(aliasesByFaction.get(faction.id) ?? []),
      ].map((phrase) => ({
        factionId: faction.id,
        phrase: mentionText(phrase),
      })),
    )
    .filter((entry) => entry.phrase.length > 0)
    .sort(
      (left, right) =>
        right.phrase.length - left.phrase.length ||
        left.factionId.localeCompare(right.factionId),
    );
  const padded = ` ${normalized} `;
  const matches: Array<{
    factionId: string;
    start: number;
    end: number;
  }> = [];
  for (const entry of phrases) {
    const needle = ` ${entry.phrase} `;
    let offset = 0;
    while (offset < padded.length) {
      const index = padded.indexOf(needle, offset);
      if (index < 0) break;
      const start = index + 1;
      const end = start + entry.phrase.length;
      offset = end;
      const coveredByLongerFaction = matches.some(
        (match) =>
          match.factionId !== entry.factionId &&
          match.start <= start &&
          match.end >= end,
      );
      if (!coveredByLongerFaction) {
        matches.push({
          factionId: entry.factionId,
          start,
          end,
        });
      }
    }
  }
  return [...new Set(matches.map((match) => match.factionId))].sort();
}

function promptUnitConstraints(
  prompt: string,
  factionId: string,
): Pick<BuildRosterInput, "requiredUnitIds" | "excludedUnitIds"> {
  const normalized = normalizeName(prompt);
  const required = new Set<string>();
  const excluded = new Set<string>();
  const occupied: Array<{ start: number; end: number }> = [];
  const candidates = factionUnits(factionId)
    .map((unit) => ({
      unit,
      phrase: normalizeName(unit.name),
    }))
    .sort(
      (left, right) =>
        right.phrase.length - left.phrase.length ||
        left.unit.id.localeCompare(right.unit.id),
    );
  for (const candidate of candidates) {
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(candidate.phrase, offset);
      if (index < 0) break;
      offset = index + candidate.phrase.length;
      const end = index + candidate.phrase.length;
      if (
        occupied.some(
          (range) => index >= range.start && end <= range.end,
        )
      ) {
        continue;
      }
      const prefix = normalized.slice(Math.max(0, index - 48), index);
      const isExcluded =
        /(?:do not select|dont select|do not include|dont include|exclude|excluding|without|no)\s*$/.test(
          prefix,
        );
      const isRequired =
        /(?:must include|must take|required|include|including|take)\s*$/.test(
          prefix,
        );
      if (!isExcluded && !isRequired) continue;
      occupied.push({ start: index, end });
      if (isExcluded) excluded.add(candidate.unit.id);
      else required.add(candidate.unit.id);
    }
  }
  return {
    requiredUnitIds: [...required].sort(),
    excludedUnitIds: [...excluded].sort(),
  };
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

/**
 * Resolve a unit only within the selected faction and its declared parent
 * factions. Consumers that analyze an existing roster should use this helper
 * instead of a process-wide unit lookup: unit ids are not globally unique and
 * successor factions inherit their shared datasheets from a parent catalogue.
 */
export function resolveFactionUnit(
  unitId: string,
  factionId: string,
): UnitView | undefined {
  return resolveUnit(unitId, factionId);
}

/**
 * Returns only weapon groups that require an explicit same-phase profile
 * choice. A weapon with one shooting and one melee profile is not ambiguous.
 */
export function rosterProfileRequirements(
  roster: RosterDraftV1,
): TesseraProfileRequirement[] {
  const requirements: TesseraProfileRequirement[] = [];
  for (const selection of roster.units) {
    const unit = resolveUnit(selection.unitId, roster.factionId);
    if (!unit) continue;
    for (const equipment of selection.equipment) {
      if (equipment.count <= 0) continue;
      const weapon =
        unit.weapons.find((candidate) => candidate.id === equipment.itemId) ??
        dataset.weapons.all.find(
          (candidate) =>
            candidate.id === equipment.itemId &&
            candidate.raw.faction_id === unit.raw.faction_id,
        );
      if (!weapon) continue;
      const profilesByPhase = new Map<
        "shooting" | "fight",
        string[]
      >();
      for (const profile of weapon.raw.profiles) {
        const phase = profile.range === "Melee" ? "fight" : "shooting";
        const names = profilesByPhase.get(phase) ?? [];
        names.push(profile.name);
        profilesByPhase.set(phase, names);
      }
      for (const [phase, profileNames] of profilesByPhase) {
        const availableProfiles = [...new Set(profileNames)].sort();
        if (availableProfiles.length < 2) continue;
        requirements.push({
          faction: roster.factionId,
          unit: selection.name,
          selectionId: selection.selectionId,
          weaponGroup: equipment.name,
          phase,
          availableProfiles,
          activeCount: equipment.count,
          selectedProfile: null,
        });
      }
    }
  }
  return requirements.sort(
    (left, right) =>
      left.faction.localeCompare(right.faction) ||
      left.unit.localeCompare(right.unit) ||
      left.weaponGroup.localeCompare(right.weaponGroup) ||
      left.phase.localeCompare(right.phase) ||
      (left.selectionId ?? "").localeCompare(right.selectionId ?? ""),
  );
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

export function parseRosterPrompt(
  prompt: string,
  context: {
    playerFaction?: string;
    opponentFaction?: string;
  } = {},
): BuildRosterInput {
  const normalized = normalizeName(prompt);
  const pointsMatch = prompt.match(/\b(\d{3,4}|\d,\d{3})\s*(?:points?|pts?)?\b/i);
  const positivePreferenceMention = (alias: string): boolean => {
    const normalizedAlias = normalizeName(alias);
    let searchFrom = 0;
    while (searchFrom < normalized.length) {
      const index = normalized.indexOf(normalizedAlias, searchFrom);
      if (index < 0) return false;
      const prefix = normalized.slice(Math.max(0, index - 32), index);
      if (
        !/\b(?:anti|against|versus|vs|counter(?:s|ed|ing)?|answers?(?:\s+to)?|answering)\s*$/.test(
          prefix,
        )
      ) {
        return true;
      }
      searchFrom = index + normalizedAlias.length;
    }
    return false;
  };
  const preferences = (Object.entries(PREFERENCE_ALIASES) as Array<
    [PreferenceTag, string[]]
  >)
    .filter(([, aliases]) =>
      aliases.some((alias) => positivePreferenceMention(alias)),
    )
    .map(([preference]) => preference);
  const explicitPlayer = context.playerFaction
    ? resolveFaction(context.playerFaction)?.id
    : undefined;
  const opponent = context.opponentFaction
    ? resolveFaction(context.opponentFaction)?.id
    : undefined;
  const mentions = factionMentions(prompt).filter(
    (factionId) => factionId !== opponent,
  );
  const faction =
    explicitPlayer ??
    (mentions.length === 1 ? mentions[0] : undefined);
  const unitConstraints = faction
    ? promptUnitConstraints(prompt, faction)
    : { requiredUnitIds: [], excludedUnitIds: [] };
  const legendsIntent = detectLegendsPromptIntent(prompt);

  return {
    prompt,
    playerFaction: faction,
    faction,
    pointsLimit: pointsMatch
      ? Number(pointsMatch[1].replace(",", ""))
      : undefined,
    preferences,
    allowNamedCharacters: !/\b(no|without|exclude)\s+(named|epic)/i.test(prompt),
    ...(legendsIntent === "allow" || legendsIntent === "exclude"
      ? {
          legendsPolicy: legendsIntent,
          allowLegends: legendsIntent === "allow",
        }
      : {}),
    ...unitConstraints,
  };
}

export function getDataStatus(): ResultEnvelope<DataStatus> {
  const custodesUnits = units.byFaction(DEFAULT_FACTION_ID);
  const supportedFactionIds = factions.all
    .filter((faction) => isBuildableFaction(faction.id))
    .map((faction) => faction.id);
  const legendStates = factions.all.map((faction) =>
    activeFactionLegendsState(faction.id),
  );
  const legendUnits = legendStates.flatMap((state) => state.units);
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
    dataBundle: getDataUpdateStatusSnapshot(),
    legends: {
      factionCoverage: {
        complete: legendStates.filter(
          (state) => state.coverageStatus === "complete",
        ).length,
        notPublished: legendStates.filter(
          (state) => state.coverageStatus === "not-published",
        ).length,
        unavailable: legendStates.filter(
          (state) => state.coverageStatus === "unavailable",
        ).length,
      },
      classificationAuthority: {
        verified: legendStates.filter(
          (state) =>
            state.classificationAuthority ===
            "games-workshop-verified",
        ).length,
        unverifiedOverlay: legendStates.filter(
          (state) =>
            state.classificationAuthority ===
            "games-workshop-unverified-overlay",
        ).length,
        unavailable: legendStates.filter(
          (state) =>
            state.classificationAuthority === "unavailable",
        ).length,
      },
      inventoryUnits: legendUnits.length,
      buildSupportedUnits: legendUnits.filter(
        (unit) => unit.buildSupported,
      ).length,
      inventoryOnlyUnits: legendUnits.filter(
        (unit) => !unit.buildSupported,
      ).length,
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
      unique:
        newRecruitCatalogue.summary.uniqueConflicts ??
        newRecruitCatalogue.summary.conflicts,
      uniqueBlocking:
        newRecruitCatalogue.summary.uniqueBlockingConflicts ??
        newRecruitCatalogue.summary.blockingConflicts,
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

function legendBuildSupported(unit: UnitView): boolean {
  if (unit.raw.is_legend !== true) return true;
  return (
    activeFactionLegendsState(unit.raw.faction_id).units.find(
      (entry) => entry.unitId === unit.id,
    )?.buildSupported === true
  );
}

function verifiedLegendProvenance(
  state: ReturnType<typeof activeFactionLegendsState>,
  entry: ReturnType<typeof activeFactionLegendsState>["units"][number],
): UnitSummary["legendProvenance"] {
  if (
    state.classificationAuthority !== "games-workshop-verified"
  ) {
    return undefined;
  }
  const source = state.sourceArtifacts.find(
    (artifact) => artifact.sourceId === entry.sourceId,
  );
  if (!source) return undefined;
  return {
    classificationAuthority: "games-workshop-verified",
    sourceId: source.sourceId,
    version: source.version,
    contentSha256: source.contentSha256,
    url: source.url,
    ...(entry.datasheetUrl
      ? { datasheetUrl: entry.datasheetUrl }
      : {}),
  };
}

function summarizeUnit(unit: UnitView): UnitSummary {
  const modelCounts = availableModelCounts(unit, 1);
  const buildSupported = legendBuildSupported(unit);
  const legendState = activeFactionLegendsState(
    unit.raw.faction_id,
  );
  const legendEntry =
    unit.raw.is_legend === true
      ? legendState.units.find((entry) => entry.unitId === unit.id)
      : undefined;
  const legendProvenance = legendEntry
    ? verifiedLegendProvenance(legendState, legendEntry)
    : undefined;
  return {
    id: unit.id,
    name: unit.name,
    factionId: unit.raw.faction_id,
    role: unitRole(unit),
    pointsFrom: Math.min(
      ...modelCounts.map((modelCount) => baseUnitPoints(unit.raw, modelCount, 1)),
    ),
    pointsKnown: true,
    modelCounts,
    tags: unitTags(unit),
    keywords: [...(unit.raw.keywords ?? []), ...(unit.raw.faction_keywords ?? [])],
    isNamedCharacter: isNamedCharacter(unit),
    isLegend: unit.raw.is_legend === true,
    legendBuildSupported: buildSupported,
    ...(legendProvenance ? { legendProvenance } : {}),
    supported:
      isBuildableFaction(unit.raw.faction_id) && buildSupported,
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
  const runtimeSummaries = factionUnits(faction.id)
    .filter((unit) => input.includeLegends || unit.raw.is_legend !== true)
    .filter(
      (unit) =>
        unit.raw.is_legend !== true || legendBuildSupported(unit),
    )
    .map(summarizeUnit);
  const runtimeUnitIds = new Set(
    runtimeSummaries.map((unit) => unit.id),
  );
  const legendsStates = factionLegendsStates(faction.id);
  const seenInventoryEntries = new Set<string>();
  const inventorySummaries: UnitSummary[] = input.includeLegends
    ? legendsStates
        .flatMap((state) =>
          state.units.map((entry) => ({ entry, state })),
        )
        .filter(({ entry }) => {
          const key = `${entry.factionId}\u0000${entry.legendId}`;
          if (seenInventoryEntries.has(key)) return false;
          seenInventoryEntries.add(key);
          return true;
        })
        .filter(
          ({ entry }) =>
            !entry.buildSupported ||
            entry.unitId === null ||
            !runtimeUnitIds.has(entry.unitId),
        )
        .map(({ entry, state }) => {
          const legendProvenance = verifiedLegendProvenance(
            state,
            entry,
          );
          return {
            id: entry.unitId ?? entry.legendId,
            name: entry.name,
            factionId: entry.factionId,
            role: "Legends inventory",
            pointsFrom: 0,
            pointsKnown: false,
            modelCounts: [],
            tags: [],
            keywords: ["Legends", "inventory-only"],
            isNamedCharacter: false,
            isLegend: true,
            legendBuildSupported: false,
            ...(legendProvenance ? { legendProvenance } : {}),
            supported: false,
          };
        })
    : [];
  const matches = [...runtimeSummaries, ...inventorySummaries]
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
        Number(b.supported) - Number(a.supported) ||
        b.tags.filter((tag) => desiredTags.has(tag)).length -
          a.tags.filter((tag) => desiredTags.has(tag)).length ||
        a.pointsFrom - b.pointsFrom ||
        a.name.localeCompare(b.name),
    )
    .slice(0, Math.max(1, Math.min(input.limit ?? 30, 100)));
  const warnings =
    input.includeLegends &&
    factionLegendsClassificationAuthority(faction.id) !== "verified"
      ? [
          issue(
            "LEGENDS_CLASSIFICATION_UNVERIFIED",
            "The active faction bundle does not contain complete, verified Games Workshop Legends classification evidence.",
            "warn",
          ),
        ]
      : [];
  return envelope(matches, [], warnings);
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
  BuildRosterInput & {
    legendsPolicyDecision: LegendsPolicyDecision;
  } {
  const parsed = input.prompt
    ? parseRosterPrompt(input.prompt, {
        playerFaction: input.playerFaction ?? input.faction,
        opponentFaction: opponentContextFactionId(
          input.opponentContext,
        ),
      })
    : {};
  const factionQuery =
    input.playerFaction ??
    input.faction ??
    parsed.playerFaction ??
    parsed.faction ??
    DEFAULT_FACTION_ID;
  const factionId = resolveFaction(factionQuery)?.id ?? DEFAULT_FACTION_ID;
  const classificationAuthority =
    factionLegendsClassificationAuthority(factionId);
  const legendsPolicyDecision = resolveLegendsPolicy({
    legendsPolicy: input.legendsPolicy ?? parsed.legendsPolicy,
    legacyAllowLegends: input.allowLegends ?? parsed.allowLegends,
    playContext: input.playContext,
    prompt: input.prompt,
    classificationAuthority,
  });
  return {
    ...parsed,
    ...input,
    playerFaction:
      input.playerFaction ??
      input.faction ??
      parsed.playerFaction ??
      parsed.faction ??
      DEFAULT_FACTION_ID,
    faction:
      input.playerFaction ??
      input.faction ??
      parsed.playerFaction ??
      parsed.faction ??
      DEFAULT_FACTION_ID,
    pointsLimit: Math.max(
      100,
      Math.min(input.pointsLimit ?? parsed.pointsLimit ?? 1000, 5000),
    ),
    name: input.name ?? "RosterPilot Draft",
    preferences: [
      ...new Set<PreferenceTag>(
        [
          ...(
            input.preferences && input.preferences.length > 0
              ? input.preferences
              : parsed.preferences && parsed.preferences.length > 0
                ? parsed.preferences
                : ([
                    "objective",
                    "durability",
                  ] satisfies PreferenceTag[])
          ),
          ...(input.mixedThreatIntent
            ? (["shooting", "melee"] satisfies PreferenceTag[])
            : []),
        ],
      ),
    ],
    allowNamedCharacters:
      input.allowNamedCharacters ?? parsed.allowNamedCharacters ?? true,
    legendsPolicy: legendsPolicyDecision.requestedPolicy,
    allowLegends: legendsPolicyDecision.effectiveAllowLegends,
    legendsPolicyDecision,
    requiredUnitIds: [
      ...new Set([
        ...(parsed.requiredUnitIds ?? []),
        ...(input.requiredUnitIds ?? []),
        ...(input.requiredWarlordUnitId
          ? [input.requiredWarlordUnitId]
          : []),
      ]),
    ].sort(),
    excludedUnitIds: [
      ...new Set([
        ...(parsed.excludedUnitIds ?? []),
        ...(input.excludedUnitIds ?? []),
      ]),
    ].sort(),
  };
}

type OpponentBuildProfile = OpponentThreatProfile;

function opponentContextFactionId(
  context: BuildRosterInput["opponentContext"],
): string | undefined {
  if (!context) return undefined;
  return context.kind === "known-roster"
    ? context.roster.factionId
    : context.factionId;
}

function opponentRosterFingerprint(roster: RosterDraftV1): string {
  return deterministicId([
    roster.gameSystem,
    roster.factionId,
    roster.pointsLimit,
    roster.totalPoints,
    roster.detachmentId,
    roster.forceDispositionId,
    JSON.stringify(roster.sourceData),
    ...roster.units
      .map((unit) =>
        JSON.stringify({
          unitId: unit.unitId,
          modelCount: unit.modelCount,
          points: unit.points,
          isWarlord: unit.isWarlord,
          enhancementId: unit.enhancementId,
          equipment: unit.equipment
            .map((entry) => ({
              itemId: entry.itemId,
              count: entry.count,
            }))
            .sort((left, right) =>
              left.itemId.localeCompare(right.itemId),
            ),
        }),
      )
      .sort(),
  ]);
}

function opponentBuildProfile(
  context: BuildRosterInput["opponentContext"],
): OpponentBuildProfile | null {
  if (!context) return null;
  const factionId = opponentContextFactionId(context);
  const opponent = resolveFaction(factionId);
  if (!opponent) return null;
  if (context.kind === "known-roster") {
    const selected = context.roster.units.flatMap((selection) => {
      const unit = resolveUnit(selection.unitId, context.roster.factionId);
      return unit ? [{ selection, unit }] : [];
    });
    if (selected.length === 0) return null;
    const totalModels = selected.reduce(
      (sum, entry) => sum + entry.selection.modelCount,
      0,
    );
    const totalPoints = selected.reduce(
      (sum, entry) => sum + entry.selection.points,
      0,
    );
    const modelShare = (predicate: (unit: UnitView) => boolean) =>
      selected.reduce(
        (sum, entry) =>
          sum +
          (predicate(entry.unit) ? entry.selection.modelCount : 0),
        0,
      ) / Math.max(1, totalModels);
    const pointsShare = (predicate: (unit: UnitView) => boolean) =>
      selected.reduce(
        (sum, entry) =>
          sum +
          (predicate(entry.unit) ? entry.selection.points : 0),
        0,
      ) / Math.max(1, totalPoints);
    const durabilityBand = (
      unit: UnitView,
    ): "light" | "medium" | "heavy" => {
      const profile = unit.profileAt();
      const toughness = Number(profile?.T ?? 0);
      const wounds = Number(profile?.W ?? 0);
      const save = Number(profile?.Sv ?? 7);
      if (toughness >= 9 || wounds >= 7 || save <= 2) return "heavy";
      if (toughness >= 5 || wounds >= 3 || save <= 3) return "medium";
      return "light";
    };
    const keyTargetProfiles = [...selected]
      .sort(
        (left, right) =>
          right.selection.points - left.selection.points ||
          left.selection.name.localeCompare(right.selection.name),
      )
      .slice(0, 5)
      .map(({ selection, unit }) => {
        const profile = unit.profileAt();
        return {
          unitId: selection.unitId,
          name: selection.name,
          modelCount: selection.modelCount,
          points: selection.points,
          toughness: Number(profile?.T ?? 0),
          wounds: Number(profile?.W ?? 0),
          save: Number(profile?.Sv ?? 0),
        };
      });
    return {
      schemaVersion: 1,
      factionId: opponent.id,
      rosterFingerprint: opponentRosterFingerprint(context.roster),
      bodyCount: totalModels,
      averagePointsPerModel: totalPoints / Math.max(1, totalModels),
      eliteShare: pointsShare((unit) =>
        unitTags(unit).includes("elite"),
      ),
      hordeShare: modelShare((unit) =>
        unitTags(unit).includes("horde"),
      ),
      mobilityShare: pointsShare((unit) =>
        unitTags(unit).includes("mobility"),
      ),
      vehicleMonsterShare: pointsShare((unit) => {
        const keywords = normalizedKeywords(unit);
        return (
          keywords.includes("vehicle") ||
          keywords.includes("monster")
        );
      }),
      rangedShare: pointsShare((unit) =>
        unitTags(unit).includes("shooting"),
      ),
      meleeShare: pointsShare((unit) =>
        unitTags(unit).includes("melee"),
      ),
      objectiveShare: modelShare((unit) =>
        unitTags(unit).includes("objective"),
      ),
      durabilityShare: pointsShare((unit) =>
        unitTags(unit).includes("durability"),
      ),
      durabilityBands: {
        light: pointsShare(
          (unit) => durabilityBand(unit) === "light",
        ),
        medium: pointsShare(
          (unit) => durabilityBand(unit) === "medium",
        ),
        heavy: pointsShare(
          (unit) => durabilityBand(unit) === "heavy",
        ),
      },
      keyTargetProfiles,
    };
  }
  const pool = factionUnits(opponent.id);
  if (pool.length === 0) return null;
  const datasheetShare = (predicate: (unit: UnitView) => boolean) =>
    pool.filter(predicate).length / pool.length;
  const modelWeight = (unit: UnitView) =>
    Math.max(
      1,
      unit.raw.model_count?.min ??
        unit.raw.points?.[0]?.models ??
        1,
    );
  const totalModelWeight = pool.reduce(
    (sum, unit) => sum + modelWeight(unit),
    0,
  );
  const modelWeightedShare = (
    predicate: (unit: UnitView) => boolean,
  ) =>
    pool.reduce(
      (sum, unit) =>
        sum + (predicate(unit) ? modelWeight(unit) : 0),
      0,
    ) / Math.max(1, totalModelWeight);
  const durabilityBand = (
    unit: UnitView,
  ): "light" | "medium" | "heavy" => {
    const profile = unit.profileAt();
    const toughness = Number(profile?.T ?? 0);
    const wounds = Number(profile?.W ?? 0);
    const save = Number(profile?.Sv ?? 7);
    if (toughness >= 9 || wounds >= 7 || save <= 2) return "heavy";
    if (toughness >= 5 || wounds >= 3 || save <= 3) return "medium";
    return "light";
  };
  return {
    schemaVersion: 1,
    factionId: opponent.id,
    rosterFingerprint: null,
    bodyCount: null,
    averagePointsPerModel: null,
    // Model-density threats must be model-weighted. Counting each datasheet
    // equally makes character- and vehicle-rich catalogues look almost
    // entirely elite even when they support credible mass armies.
    eliteShare: modelWeightedShare((unit) =>
      unitTags(unit).includes("elite"),
    ),
    hordeShare: modelWeightedShare((unit) =>
      unitTags(unit).includes("horde"),
    ),
    mobilityShare: datasheetShare((unit) =>
      unitTags(unit).includes("mobility"),
    ),
    vehicleMonsterShare: datasheetShare((unit) => {
      const keywords = normalizedKeywords(unit);
      return keywords.includes("vehicle") || keywords.includes("monster");
    }),
    rangedShare: datasheetShare((unit) =>
      unitTags(unit).includes("shooting"),
    ),
    meleeShare: datasheetShare((unit) =>
      unitTags(unit).includes("melee"),
    ),
    objectiveShare: modelWeightedShare((unit) =>
      unitTags(unit).includes("objective"),
    ),
    durabilityShare: modelWeightedShare((unit) =>
      unitTags(unit).includes("durability"),
    ),
    durabilityBands: {
      light: datasheetShare(
        (unit) => durabilityBand(unit) === "light",
      ),
      medium: datasheetShare(
        (unit) => durabilityBand(unit) === "medium",
      ),
      heavy: datasheetShare(
        (unit) => durabilityBand(unit) === "heavy",
      ),
    },
    keyTargetProfiles: [...pool]
      .sort(
        (left, right) =>
          Math.max(
            ...availableModelCounts(right).map(
              (count) => baseUnitPoints(right.raw, count, 1),
            ),
          ) -
            Math.max(
              ...availableModelCounts(left).map(
                (count) => baseUnitPoints(left.raw, count, 1),
              ),
            ) ||
          left.name.localeCompare(right.name),
      )
      .slice(0, 5)
      .map((unit) => {
        const modelCount = availableModelCounts(unit)[0] ?? 1;
        const profile = unit.profileAt();
        return {
          unitId: unit.id,
          name: unit.name,
          modelCount,
          points: baseUnitPoints(unit.raw, modelCount, 1),
          toughness: Number(profile?.T ?? 0),
          wounds: Number(profile?.W ?? 0),
          save: Number(profile?.Sv ?? 0),
        };
      }),
  };
}

function opponentContextScore(
  unit: UnitView,
  profile: OpponentBuildProfile | null,
): number {
  if (!profile) return 0;
  const tags = unitTags(unit);
  let score = 0;
  if (profile.eliteShare >= 0.45) {
    if (tags.includes("shooting")) score += 18;
    if (tags.includes("elite")) score += 10;
    if (tags.includes("durability")) score += 8;
  }
  if (profile.hordeShare >= 0.25) {
    if (tags.includes("shooting")) score += 12;
    if (tags.includes("horde")) score += 8;
  }
  if (profile.mobilityShare >= 0.35) {
    if (tags.includes("mobility")) score += 10;
    if (tags.includes("objective")) score += 8;
  }
  if (profile.vehicleMonsterShare >= 0.25) {
    if (tags.includes("elite")) score += 12;
    if (tags.includes("shooting")) score += 8;
  }
  if (profile.rangedShare >= 0.5) {
    if (tags.includes("durability")) score += 12;
    if (tags.includes("mobility")) score += 8;
  }
  if (profile.meleeShare >= 0.45) {
    if (tags.includes("shooting")) score += 12;
    if (tags.includes("mobility")) score += 6;
  }
  if (profile.objectiveShare >= 0.45) {
    if (tags.includes("objective")) score += 10;
    if (tags.includes("horde")) score += 6;
  }
  if (profile.durabilityShare >= 0.45) {
    if (tags.includes("elite")) score += 8;
    if (tags.includes("shooting")) score += 8;
  }
  if (profile.durabilityBands.heavy >= 0.35) {
    if (tags.includes("elite")) score += 10;
    if (tags.includes("shooting")) score += 10;
  }
  if (profile.durabilityBands.light >= 0.45) {
    if (tags.includes("horde")) score += 6;
    if (tags.includes("shooting")) score += 8;
  }
  return score;
}

function expectedProfileValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const normalizedValue = value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  const numeric = Number(normalizedValue);
  if (Number.isFinite(numeric)) return numeric;
  const dice = normalizedValue.match(
    /^(\d*)D(\d+)([+-]\d+)?$/,
  );
  if (!dice) return 0;
  const count = dice[1] ? Number(dice[1]) : 1;
  const sides = Number(dice[2]);
  const modifier = dice[3] ? Number(dice[3]) : 0;
  return count * (sides + 1) / 2 + modifier;
}

function profileKeywords(profile: {
  keywords?: Array<
    | string
    | {
        keyword_id?: string;
        name?: string;
      }
  >;
}): Set<string> {
  return new Set(
    (profile.keywords ?? []).map((keyword) =>
      normalizeName(
        typeof keyword === "string"
          ? keyword
          : keyword.keyword_id ?? keyword.name ?? "",
      ),
    ),
  );
}

function selectedWeapons(
  unit: UnitView,
  equipment: EquipmentSelection[],
) {
  return equipment.flatMap((selection) => {
    if (selection.count <= 0) return [];
    const weapon =
      unit.weapons.find(
        (candidate) => candidate.id === selection.itemId,
      ) ??
      dataset.weapons.all.find(
        (candidate) =>
          candidate.id === selection.itemId &&
          candidate.raw.faction_id === unit.raw.faction_id,
      );
    return weapon
      ? [{ selection, weapon }]
      : [];
  });
}

export type RosterUnitThreatProperties = {
  infantry: boolean;
  vehicle: boolean;
  monster: boolean;
  movement: number;
  mobilityPressure: number;
  rangedPressure: number;
  meleePressure: number;
};

/**
 * Read the actual selected datasheet and weapon profiles behind one roster
 * entry. Stress portfolios use this instead of treating broad catalogue tags
 * as a substitute for ranged, melee, mobility, or unit-type pressure.
 */
export function inspectRosterUnitThreatProperties(
  factionId: string,
  unitId: string,
  equipment: EquipmentSelection[],
): RosterUnitThreatProperties | null {
  const unit = resolveUnit(unitId, factionId);
  if (!unit) return null;
  const keywords = new Set(normalizedKeywords(unit));
  const movement = expectedProfileValue(unit.profileAt()?.M);
  const mobilityPressure =
    movement +
    (keywords.has("fly") ? 3 : 0) +
    ((unit.raw.ability_ids ?? []).includes("deep-strike")
      ? 3
      : 0);
  const profileScore = (profile: {
    stats: Record<string, unknown>;
  }): number => {
    const attacks = Math.max(
      0,
      expectedProfileValue(profile.stats.A),
    );
    const strength = Math.max(
      0,
      expectedProfileValue(profile.stats.S),
    );
    const armourPenetration = Math.abs(
      Math.min(
        0,
        expectedProfileValue(profile.stats.AP),
      ),
    );
    const damage = Math.max(
      0,
      expectedProfileValue(profile.stats.D),
    );
    return (
      attacks *
      Math.max(1, damage) *
      (1 + strength / 10) *
      (1 + armourPenetration * 0.15)
    );
  };
  let rangedPressure = 0;
  let meleePressure = 0;
  for (const { selection, weapon } of selectedWeapons(
    unit,
    equipment,
  )) {
    const rangedProfiles = weapon.raw.profiles.filter(
      (profile) => profile.range !== "Melee",
    );
    const meleeProfiles = weapon.raw.profiles.filter(
      (profile) => profile.range === "Melee",
    );
    rangedPressure +=
      selection.count *
      Math.max(0, ...rangedProfiles.map(profileScore));
    meleePressure +=
      selection.count *
      Math.max(0, ...meleeProfiles.map(profileScore));
  }
  return {
    infantry: keywords.has("infantry"),
    vehicle: keywords.has("vehicle"),
    monster: keywords.has("monster"),
    movement,
    mobilityPressure,
    rangedPressure,
    meleePressure,
  };
}

function equipmentContextScore(
  unit: UnitView,
  equipment: EquipmentSelection[],
  profile: OpponentBuildProfile | null,
): number {
  if (!profile) return 0;
  const rawScore = selectedWeapons(unit, equipment).reduce(
    (total, { selection, weapon }) => {
      const bestProfileScore = weapon.raw.profiles.reduce(
        (best, weaponProfile) => {
          const attacks = expectedProfileValue(
            weaponProfile.stats.A,
          );
          const strength = expectedProfileValue(
            weaponProfile.stats.S,
          );
          const armourPenetration = expectedProfileValue(
            weaponProfile.stats.AP,
          );
          const damage = expectedProfileValue(
            weaponProfile.stats.D,
          );
          const keywords = profileKeywords(weaponProfile);
          let score = 0;
          if (profile.eliteShare >= 0.45) {
            if (armourPenetration <= -2) score += 6;
            if (damage >= 2) score += 6;
            if (strength >= 7) score += 4;
          }
          if (profile.vehicleMonsterShare >= 0.25) {
            if (strength >= 10) score += 8;
            if (armourPenetration <= -2) score += 5;
            if (damage >= 3) score += 7;
          }
          if (profile.hordeShare >= 0.25) {
            score += Math.min(8, attacks) * 1.5;
            if (keywords.has("blast")) score += 6;
            if (keywords.has("torrent")) score += 7;
          }
          if (keywords.has("one shot")) score *= 0.35;
          return Math.max(best, score);
        },
        0,
      );
      return total + bestProfileScore * selection.count;
    },
    0,
  );
  // Matchup loadouts should break ties and improve profile coverage without
  // making a large squad's repeated default weapons outweigh mission-safe
  // roster structure. The direct profile evidence remains complete; only its
  // optimizer contribution is bounded per selected unit.
  return rawScore <= 0
    ? 0
    : (24 * rawScore) / (rawScore + 24);
}

function selectedProfileEvidence(
  unit: UnitView,
  equipment: EquipmentSelection[],
): string[] {
  return selectedWeapons(unit, equipment).flatMap(
    ({ selection, weapon }) =>
      weapon.raw.profiles.map((profile) => {
        const keywords = [...profileKeywords(profile)];
        return `${selection.count}x ${weapon.name} / ${profile.name}: A ${String(profile.stats.A)}, S ${String(profile.stats.S)}, AP ${String(profile.stats.AP)}, D ${String(profile.stats.D)}${keywords.length > 0 ? ` (${keywords.join(", ")})` : ""}`;
      }),
  );
}

function candidateScoreComponents(
  unit: UnitView,
  modelCount: number,
  points: number,
  remaining: number,
  preferences: PreferenceTag[],
  currentCopies: number,
  hasWarlord: boolean,
  opponentProfile: OpponentBuildProfile | null = null,
  equipment: EquipmentSelection[] | null = null,
): {
  preference: number;
  pointsUtilization: number;
  missionReadiness: number;
  opponentCoverage: number;
  modelValue: number;
  duplicationPenalty: number;
  extraCharacterPenalty: number;
  pointsCostPenalty: number;
  total: number;
} {
  const tags = unitTags(unit);
  const preference =
    tags.filter((tag) => preferences.includes(tag)).length * 40;
  const pointsUtilization =
    Math.max(0, 24 - Math.floor((remaining - points) / 10));
  const modelValue = Math.min(12, modelCount * 2);
  const missionReadiness = tags.includes("objective") ? 8 : 0;
  const duplicationPenalty = currentCopies * 7;
  const extraCharacterPenalty =
    hasWarlord && isCharacterUnit(unit) ? 18 : 0;
  const pointsCostPenalty = points / 100;
  const opponentCoverage =
    opponentContextScore(unit, opponentProfile) +
    (
      equipment
        ? equipmentContextScore(
            unit,
            equipment,
            opponentProfile,
          )
        : 0
    );
  return {
    preference,
    pointsUtilization,
    missionReadiness,
    opponentCoverage,
    modelValue,
    duplicationPenalty,
    extraCharacterPenalty,
    pointsCostPenalty,
    total:
    preference +
    pointsUtilization +
    modelValue +
    missionReadiness -
    duplicationPenalty -
    extraCharacterPenalty -
    pointsCostPenalty +
    opponentCoverage,
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
  opponentProfile: OpponentBuildProfile | null = null,
  equipment: EquipmentSelection[] | null = null,
): number {
  return candidateScoreComponents(
    unit,
    modelCount,
    points,
    remaining,
    preferences,
    currentCopies,
    hasWarlord,
    opponentProfile,
    equipment,
  ).total;
}

export function buildRoster(
  rawInput: BuildRosterInput,
): ResultEnvelope<RosterDraftV1> {
  const legendsPolicy =
    rawInput.legendsPolicy === undefined
      ? null
      : LegendsPolicySchema.safeParse(rawInput.legendsPolicy);
  const playContext =
    rawInput.playContext === undefined
      ? null
      : LegendsPlayContextSchema.safeParse(rawInput.playContext);
  if (
    (legendsPolicy !== null && !legendsPolicy.success) ||
    (playContext !== null && !playContext.success) ||
    (rawInput.allowLegends !== undefined &&
      typeof rawInput.allowLegends !== "boolean")
  ) {
    const details = [
      ...(legendsPolicy && !legendsPolicy.success
        ? legendsPolicy.error.issues
        : []),
      ...(playContext && !playContext.success
        ? playContext.error.issues
        : []),
    ]
      .slice(0, 3)
      .map(
        (problem) =>
          `${problem.path.join(".") || "Legends policy"}: ${problem.message}`,
      );
    if (
      rawInput.allowLegends !== undefined &&
      typeof rawInput.allowLegends !== "boolean"
    ) {
      details.push("allowLegends: Expected a boolean.");
    }
    return envelope<RosterDraftV1>(null, [
      issue(
        "LEGENDS_POLICY_INVALID",
        `The Legends policy or play context is invalid. ${details.join(" ")}`,
      ),
    ]);
  }
  if (rawInput.opponentContext?.kind === "known-roster") {
    const opponentValidation = validateRoster(
      rawInput.opponentContext.roster,
    );
    if (!opponentValidation.ok) {
      return envelope<RosterDraftV1>(
        null,
        [
          issue(
            "OPPONENT_ROSTER_INVALID",
            "The known opponent roster must validate before it can influence roster construction.",
          ),
          ...opponentValidation.violations,
        ],
        opponentValidation.warnings,
      );
    }
    const opponentCompatibility = rebaseRosterData(
      rawInput.opponentContext.roster,
    );
    if (
      !opponentCompatibility.ok ||
      opponentCompatibility.data?.status === "review-required"
    ) {
      return envelope<RosterDraftV1>(null, [
        issue(
          "OPPONENT_DATA_SEMANTICS_CHANGED",
          "The known opponent roster references rules or mappings that differ from the active data bundle. Review and rebase it before constructing a counter-roster.",
        ),
      ]);
    }
  }
  const factionResolution = resolveFactionIntent({
    prompt: rawInput.prompt,
    playerFaction: rawInput.playerFaction,
    faction: rawInput.faction,
    opponentFaction: opponentContextFactionId(rawInput.opponentContext),
  });
  if (factionResolution.status !== "resolved") {
    const suggestionMessage =
      factionResolution.suggestions.length > 0
        ? ` Suggestions: ${factionResolution.suggestions
            .map(
              (suggestion) =>
                `${suggestion.factionName} (${suggestion.factionId})`,
            )
            .join(", ")}.`
        : "";
    return envelope<RosterDraftV1>(null, [
      issue(
        factionResolution.code,
        `${factionResolution.message}${suggestionMessage}`,
      ),
    ]);
  }
  const inferredOpponentFactionId =
    rawInput.opponentContext === undefined &&
    factionResolution.opponentFactionIds.length === 1
      ? factionResolution.opponentFactionIds[0]
      : null;
  const normalizedInput: BuildRosterInput = {
    ...rawInput,
    playerFaction: factionResolution.factionId,
    ...(inferredOpponentFactionId
      ? {
          opponentContext: {
            kind: "known-faction" as const,
            factionId: inferredOpponentFactionId,
          },
        }
      : {}),
  };
  const input = mergeBuildInput(normalizedInput);
  if (input.legendsPolicyDecision.resolution === "blocked") {
    return envelope<RosterDraftV1>(null, [
      issue(
        "LEGENDS_POLICY_CONFLICT",
        input.legendsPolicyDecision.reason,
      ),
    ]);
  }
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
  const requiredUnitIds = new Set(input.requiredUnitIds ?? []);
  const excludedUnitIds = new Set(input.excludedUnitIds ?? []);
  const ownedCollectionProfile =
    input.collectionProfile?.mode === "owned"
      ? input.collectionProfile
      : null;
  const ownedCollection =
    ownedCollectionProfile
      ? new Map(
          ownedCollectionProfile.units.map((entry) => [
            entry.unitId,
            entry,
          ]),
        )
      : null;
  if (
    ownedCollection &&
    ownedCollection.size !== ownedCollectionProfile!.units.length
  ) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "COLLECTION_PROFILE_DUPLICATE_UNIT",
        "Each owned collection unit must appear exactly once.",
      ),
    ]);
  }
  const legacyCollection = input.collectionUnitIds
    ? new Set(input.collectionUnitIds)
    : null;
  if (
    ownedCollection &&
    legacyCollection &&
    (
      ownedCollection.size !== legacyCollection.size ||
      [...ownedCollection.keys()].some(
        (unitId) => !legacyCollection.has(unitId),
      )
    )
  ) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "COLLECTION_PROFILE_CONFLICT",
        "collectionUnitIds and collectionProfile describe different available units.",
      ),
    ]);
  }
  const overlap = [...requiredUnitIds].filter((unitId) =>
    excludedUnitIds.has(unitId),
  );
  if (overlap.length > 0) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "UNIT_CONSTRAINT_CONFLICT",
        `The same units are both required and excluded: ${overlap.join(", ")}.`,
      ),
    ]);
  }
  const legendsInventoryUnits = factionLegendsStates(faction.id).flatMap(
    (state) => state.units,
  );
  const inventoryOnlyRequired = legendsInventoryUnits
    .filter(
      (entry) =>
        !entry.buildSupported &&
        requiredUnitIds.has(entry.unitId ?? entry.legendId),
    )
    .map((entry) => entry.unitId ?? entry.legendId);
  if (inventoryOnlyRequired.length > 0) {
    return envelope<RosterDraftV1>(null, [
      issue(
        input.allowLegends
          ? "LEGENDS_BUILD_SUPPORT_UNAVAILABLE"
          : "LEGENDS_REQUIRED_BUT_NOT_ALLOWED",
        input.allowLegends
          ? `These Legends inventory records do not have complete deterministic build data: ${inventoryOnlyRequired.join(", ")}.`
          : `Required Legends units cannot be selected under the resolved policy: ${inventoryOnlyRequired.join(", ")}. ${input.legendsPolicyDecision.reason}`,
      ),
    ]);
  }
  const allFactionUnitIds = new Set(
    [
      ...factionUnits(faction.id).map((unit) => unit.id),
      ...legendsInventoryUnits.flatMap((entry) => [
        entry.legendId,
        ...(entry.unitId ? [entry.unitId] : []),
      ]),
    ],
  );
  const unknownRequired = [...requiredUnitIds].filter(
    (unitId) => !allFactionUnitIds.has(unitId),
  );
  const unknownExcluded = [...excludedUnitIds].filter(
    (unitId) => !allFactionUnitIds.has(unitId),
  );
  if (unknownRequired.length > 0 || unknownExcluded.length > 0) {
    return envelope<RosterDraftV1>(null, [
      issue(
        unknownRequired.length > 0
          ? "REQUIRED_UNIT_NOT_FOUND"
          : "EXCLUDED_UNIT_NOT_FOUND",
        `The following unit constraints do not belong to ${faction.name}: ${[
          ...unknownRequired,
          ...unknownExcluded,
        ].join(", ")}.`,
      ),
    ]);
  }
  if (
    input.requiredWarlordUnitId &&
    excludedUnitIds.has(input.requiredWarlordUnitId)
  ) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "UNIT_CONSTRAINT_CONFLICT",
        `${input.requiredWarlordUnitId} cannot be both the required Warlord and excluded.`,
      ),
    ]);
  }
  const collectionUnitIds = ownedCollection
    ? new Set(ownedCollection.keys())
    : legacyCollection;
  if (
    collectionUnitIds &&
    [...requiredUnitIds].some(
      (unitId) => !collectionUnitIds.has(unitId),
    )
  ) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "REQUIRED_UNIT_OUTSIDE_COLLECTION",
        "Every required unit must also be present in collectionUnitIds.",
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

  const collection = collectionUnitIds;
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
    .filter(legendBuildSupported)
    .filter((unit) => input.allowNamedCharacters || !isNamedCharacter(unit))
    .filter((unit) => !collection || collection.has(unit.id))
    .filter((unit) => !excludedUnitIds.has(unit.id))
    .filter((unit) => unit.raw.attachment_role !== "support")
    .filter(unitAllowedByDetachment)
    .filter((unit) => availableModelCounts(unit, 1).length > 0);

  const selectionFitsCollection = (
    currentSelections: DraftUnit[],
    unitId: string,
    modelCount: number,
  ): boolean => {
    const limit = ownedCollection?.get(unitId);
    if (!limit) return ownedCollection === null;
    const selected = currentSelections.filter(
      (selection) => selection.unitId === unitId,
    );
    if (
      limit.maxUnits !== undefined &&
      selected.length + 1 > limit.maxUnits
    ) {
      return false;
    }
    if (
      limit.maxModels !== undefined &&
      selected.reduce(
        (sum, selection) => sum + selection.modelCount,
        0,
      ) +
        modelCount >
        limit.maxModels
    ) {
      return false;
    }
    return true;
  };

  const requiredLegendIds = [...requiredUnitIds].filter(
    (unitId) =>
      resolveUnit(unitId, faction.id)?.raw.is_legend === true,
  );
  if (!input.allowLegends && requiredLegendIds.length > 0) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "LEGENDS_REQUIRED_BUT_NOT_ALLOWED",
        `Required Legends units cannot be selected under the resolved policy: ${requiredLegendIds.join(", ")}. ${input.legendsPolicyDecision.reason}`,
      ),
    ]);
  }
  const unsupportedRequiredLegends = requiredLegendIds.filter(
    (unitId) => {
      const unit = resolveUnit(unitId, faction.id);
      return unit ? !legendBuildSupported(unit) : false;
    },
  );
  if (unsupportedRequiredLegends.length > 0) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "LEGENDS_BUILD_SUPPORT_UNAVAILABLE",
        `These Legends inventory records do not have complete deterministic build data: ${unsupportedRequiredLegends.join(", ")}.`,
      ),
    ]);
  }
  const unavailableRequired = [...requiredUnitIds].filter(
    (unitId) => !factionUnitPool.some((unit) => unit.id === unitId),
  );
  if (unavailableRequired.length > 0) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "REQUIRED_UNIT_UNAVAILABLE",
        `Required units are unavailable under the named-character, Legends, collection, or detachment constraints: ${unavailableRequired.join(", ")}.`,
      ),
    ]);
  }
  const opponentProfile = opponentBuildProfile(input.opponentContext);
  const equipmentCandidateCache = new Map<
    string,
    EquipmentSelection[][]
  >();
  const candidateEquipment = (
    unit: UnitView,
    modelCount: number,
  ): EquipmentSelection[][] => {
    const key = `${unit.id}:${modelCount}:${opponentProfile?.factionId ?? "generic"}`;
    const cached = equipmentCandidateCache.get(key);
    if (cached) return cached;
    const candidates = equipmentCandidates(
      unit,
      modelCount,
      opponentProfile,
    );
    equipmentCandidateCache.set(key, candidates);
    return candidates;
  };
  const newRecruitFaction = getNewRecruitFactionCatalogue(faction.id);
  const globallyBlockedUnitIds = new Set(
    (newRecruitCatalogue.factions[faction.id]?.conflicts ?? [])
      .filter(conflictBlocksAllUnitConfigurations)
      .flatMap((conflict) =>
        factionUnitPool
          .filter(
            (unit) =>
              conflict.entityId === unit.id ||
              conflict.entityId.startsWith(`${unit.id}:`),
          )
          .map((unit) => unit.id),
      ),
  );
  const buildUnitPool = factionUnitPool.filter(
    (unit) =>
      !globallyBlockedUnitIds.has(unit.id) ||
      requiredUnitIds.has(unit.id),
  );
  type ExportabilitySelection = Pick<
    DraftUnit,
    | "unitId"
    | "name"
    | "modelCount"
    | "isWarlord"
    | "enhancementId"
    | "equipment"
  >;
  const selectionExportabilityCache = new Map<string, boolean>();
  const selectionIsInternallyExcluded = (
    selection: ExportabilitySelection & { ordinal?: number },
  ): boolean =>
    (input.internalSelectionExclusions ?? []).some(
      (exclusion) =>
        exclusion.unitId === selection.unitId &&
        exclusion.modelCount === selection.modelCount &&
        (
          exclusion.unitOrdinalMin === undefined ||
          (selection.ordinal ?? 1) >=
            exclusion.unitOrdinalMin
        ) &&
        (
          exclusion.unitOrdinalMax === undefined ||
          exclusion.unitOrdinalMax === null ||
          (selection.ordinal ?? 1) <=
            exclusion.unitOrdinalMax
        ) &&
        (
          exclusion.equipmentSignature === undefined ||
          exclusion.equipmentSignature ===
            newRecruitEquipmentSignature(selection.equipment)
        ),
    );
  const selectionIsExportable = (
    selection: ExportabilitySelection & { ordinal?: number },
  ): boolean => {
    const key = [
      selection.unitId,
      selection.modelCount,
      selection.ordinal ?? 1,
      selection.isWarlord ? "warlord" : "unit",
      selection.enhancementId ?? "",
      selection.equipment
        .filter((entry) => entry.count > 0)
        .map((entry) => `${entry.itemId}:${entry.count}`)
        .sort()
        .join(","),
    ].join("|");
    const cached = selectionExportabilityCache.get(key);
    if (cached !== undefined) return cached;
    const mapping = newRecruitFaction?.units[selection.unitId];
    const exportable = Boolean(
      !selectionIsInternallyExcluded(selection) &&
      mapping &&
        !globallyBlockedUnitIds.has(selection.unitId) &&
        (!selection.isWarlord || mapping.warlord) &&
        (!selection.enhancementId ||
          mapping.enhancements[selection.enhancementId]) &&
        resolveNewRecruitUnit(mapping, selection).ok &&
        !conflictsForRoster({
          factionId: faction.id,
          detachmentId: selectedDetachment.id,
          units: [
            {
              unitId: selection.unitId,
              modelCount: selection.modelCount,
              ordinal: selection.ordinal,
              enhancementId: selection.enhancementId,
              equipment: selection.equipment,
            },
          ],
        }).some((conflict) => conflict.blocking),
    );
    selectionExportabilityCache.set(key, exportable);
    return exportable;
  };

  const characterCandidates = buildUnitPool
    .filter(isWarlordEligible)
    .flatMap((unit) =>
      availableModelCounts(unit, 1).flatMap((modelCount) =>
        candidateEquipment(unit, modelCount).map(
          (equipment) => {
            const points = selectionPoints(
              unit,
              modelCount,
              1,
              equipment,
              null,
            );
            return {
              unit,
              modelCount,
              equipment,
              points,
              exportable: selectionIsExportable(
                makeSelection(
                  unit,
                  modelCount,
                  1,
                  true,
                  null,
                  equipment,
                ),
              ),
            };
          },
        ),
      ),
    )
    .filter((candidate) =>
      selectionFitsCollection(
        [],
        candidate.unit.id,
        candidate.modelCount,
      ),
    )
    .filter((candidate) =>
      equipmentLoadoutIsLegal(
        candidate.unit,
        candidate.modelCount,
        candidate.equipment,
      ),
    )
    .filter(
      (candidate) =>
        !selectionIsInternallyExcluded(
          makeSelection(
            candidate.unit,
            candidate.modelCount,
            1,
            true,
            null,
            candidate.equipment,
          ),
        ),
    )
    .filter((candidate) => candidate.points <= input.pointsLimit)
    .filter(
      (candidate) =>
        !input.requiredWarlordUnitId ||
        candidate.unit.id === input.requiredWarlordUnitId,
    )
    .sort(
      (a, b) =>
        Number(requiredUnitIds.has(b.unit.id)) -
          Number(requiredUnitIds.has(a.unit.id)) ||
        Number(b.exportable) - Number(a.exportable) ||
        candidateScore(
          b.unit,
          b.modelCount,
          b.points,
          input.pointsLimit,
          input.preferences,
          0,
          false,
          opponentProfile,
          null,
        ) -
          candidateScore(
            a.unit,
            a.modelCount,
            a.points,
            input.pointsLimit,
            input.preferences,
          0,
          false,
          opponentProfile,
          null,
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

  let selections: DraftUnit[] = [
    makeSelection(warlord.unit, warlord.modelCount, 1, true, null, warlord.equipment),
  ];
  let totalPoints = selections[0].points;
  let copies = new Map<string, number>([[warlord.unit.id, 1]]);

  for (const requiredUnitId of [...requiredUnitIds].sort()) {
    if (requiredUnitId === warlord.unit.id) continue;
    const unit = buildUnitPool.find(
      (candidate) => candidate.id === requiredUnitId,
    )!;
    const ordinal = (copies.get(unit.id) ?? 0) + 1;
    const requiredCandidates = availableModelCounts(unit, ordinal)
      .flatMap((modelCount) =>
        candidateEquipment(unit, modelCount).map(
          (equipment) => {
            const points = selectionPoints(
              unit,
              modelCount,
              ordinal,
              equipment,
              null,
            );
            return {
              modelCount,
              equipment,
              points,
              exportable: selectionIsExportable(
                makeSelection(
                  unit,
                  modelCount,
                  ordinal,
                  false,
                  null,
                  equipment,
                ),
              ),
              score: candidateScore(
                unit,
                modelCount,
                points,
                input.pointsLimit - totalPoints,
                input.preferences,
                ordinal - 1,
                true,
                opponentProfile,
                equipment,
              ),
            };
          },
        ),
      )
      .filter(
        (candidate) =>
          selectionFitsCollection(
            selections,
            unit.id,
            candidate.modelCount,
          ) &&
          equipmentLoadoutIsLegal(
            unit,
            candidate.modelCount,
            candidate.equipment,
          ) &&
          !selectionIsInternallyExcluded(
            makeSelection(
              unit,
              candidate.modelCount,
              ordinal,
              false,
              null,
              candidate.equipment,
            ),
          ) &&
          totalPoints + candidate.points <= input.pointsLimit,
      )
      .sort(
        (left, right) =>
          Number(right.exportable) - Number(left.exportable) ||
          right.score - left.score ||
          right.points - left.points ||
          left.modelCount - right.modelCount,
      );
    const required = requiredCandidates[0];
    if (
      !required
    ) {
      return envelope<RosterDraftV1>(null, [
        issue(
          "REQUIRED_UNITS_DO_NOT_FIT",
          `Required unit ${unit.name} cannot be added legally within ${input.pointsLimit} points.`,
        ),
      ]);
    }
    selections.push(
      makeSelection(
        unit,
        required.modelCount,
        ordinal,
        false,
        null,
        required.equipment,
      ),
    );
    copies.set(unit.id, ordinal);
    totalPoints += required.points;
  }

  type BuildState = {
    selections: DraftUnit[];
    copies: Map<string, number>;
    totalPoints: number;
  };
  type BuildStateComponents = {
    exportable: number;
    pointsReady: number;
    pointsProgress: number;
    points: number;
    missionRedDimensions: number;
    missionGreenDimensions: number;
    unsupportedLeaders: number;
    missionReadiness: number;
    opponentCoverage: number;
    roleBreadth: number;
    duplicateCount: number;
    fingerprint: string;
  };
  const unitById = new Map(
    buildUnitPool.map((unit) => [unit.id, unit]),
  );
  const stateComponentCache =
    new WeakMap<BuildState, BuildStateComponents>();
  const stateComponents = (state: BuildState) => {
    const cached = stateComponentCache.get(state);
    if (cached) return cached;
    const selectedUnits = state.selections
      .map((selection) => unitById.get(selection.unitId))
      .filter((unit): unit is UnitView => Boolean(unit));
    const selectedUnitIds = new Set(
      state.selections.map((selection) => selection.unitId),
    );
    const unsupportedLeaderUnitIds = new Set(
      selectedUnits
        .filter((unit) => {
          if (unit.raw.attachment_role !== "leader") return false;
          const eligibleBodyguards =
            dataset.bodyguardsAttachableFrom(unit.id);
          return (
            eligibleBodyguards.length > 0 &&
            !eligibleBodyguards.some((bodyguard) =>
              selectedUnitIds.has(bodyguard.id),
            )
          );
        })
        .map((unit) => unit.id),
    );
    const readinessEntries = state.selections.flatMap((selection) => {
      const unit = unitById.get(selection.unitId);
      if (!unit || unsupportedLeaderUnitIds.has(unit.id)) return [];
      const profile = unit.profileAt();
      const movement = Number(profile?.M ?? 0);
      const toughness = Number(profile?.T ?? 0);
      const wounds = Number(profile?.W ?? 0);
      const save = Number(profile?.Sv ?? 7);
      const invulnerableSave =
        profile?.invuln_sv == null
          ? null
          : Number(profile.invuln_sv);
      const objectiveControl = Number(profile?.OC ?? 0);
      const keywords = normalizedKeywords(unit);
      const mobilityAbility = (unit.raw.ability_ids ?? []).some(
        (abilityId) => {
          const normalizedId = normalizeName(abilityId);
          return (
            normalizedId === "deep strike" ||
            normalizedId === "infiltrators" ||
            normalizedId.startsWith("scouts ")
          );
        },
      );
      const fast =
        movement >= 10 ||
        keywords.includes("fly") ||
        keywords.includes("mounted") ||
        mobilityAbility;
      const totalObjectiveControl =
        objectiveControl * selection.modelCount;
      return [{
        selection,
        toughness,
        totalWounds: wounds * selection.modelCount,
        save,
        invulnerableSave,
        totalObjectiveControl,
        fast,
        reachable: fast || movement >= 7,
      }];
    });
    const selectedTags = new Set(
      selectedUnits.flatMap((unit) => unitTags(unit)),
    );
    const exportableSelections = state.selections.filter(
      selectionIsExportable,
    ).length;
    const missionTagBreadth = [
      "objective",
      "mobility",
      "durability",
      "shooting",
      "melee",
      ...input.preferences,
    ].filter((tag) =>
      selectedTags.has(tag as PreferenceTag),
    ).length;
    const scale = Math.max(0.1, input.pointsLimit / 1000);
    const scoreable = readinessEntries.filter(
      (entry) => entry.totalObjectiveControl > 0,
    );
    const controlThree = readinessEntries.filter(
      (entry) => entry.totalObjectiveControl >= 3,
    );
    const fast = readinessEntries.filter((entry) => entry.fast);
    const reachable = readinessEntries.filter(
      (entry) => entry.reachable,
    );
    const cheap = readinessEntries.filter(
      (entry) =>
        entry.selection.points <= input.pointsLimit * 0.15 &&
        entry.reachable,
    );
    const cheapFast = cheap.filter((entry) => entry.fast);
    const durable = readinessEntries.filter(
      (entry) =>
        entry.totalObjectiveControl >= 3 &&
        (entry.toughness >= 7 ||
          entry.totalWounds >= 10 ||
          entry.save <= 2 ||
          (entry.invulnerableSave !== null &&
            entry.invulnerableSave <= 4) ||
          entry.selection.modelCount >= 10),
    );
    const budgetHolders = readinessEntries.filter(
      (entry) =>
        entry.totalObjectiveControl > 0 &&
        entry.selection.points <= input.pointsLimit * 0.1,
    );
    const readinessBands: Array<"red" | "amber" | "green"> = [
      scoreable.length / scale < 4
        ? "red"
        : scoreable.length / scale >= 6
          ? "green"
          : "amber",
      readinessEntries.reduce(
        (sum, entry) => sum + entry.totalObjectiveControl,
        0,
      ) /
          scale <
          14 ||
      controlThree.length / scale < 2
        ? "red"
        : readinessEntries.reduce(
              (sum, entry) => sum + entry.totalObjectiveControl,
              0,
            ) /
              scale >=
              24 &&
            controlThree.length / scale >= 3
          ? "green"
          : "amber",
      reachable.length / scale < 2 || fast.length / scale < 1
        ? "red"
        : reachable.length / scale >= 3 &&
            fast.length / scale >= 2
          ? "green"
          : "amber",
      cheap.length / scale < 2 || cheapFast.length / scale < 1
        ? "red"
        : cheap.length / scale >= 3 &&
            cheapFast.length / scale >= 2
          ? "green"
          : "amber",
      durable.length / scale < 1
        ? "red"
        : durable.length / scale >= 2
          ? "green"
          : "amber",
      budgetHolders.length === 0 || durable.length === 0
        ? "red"
        : new Set([
              ...budgetHolders.map(
                (entry) => entry.selection.selectionId,
              ),
              ...durable.map(
                (entry) => entry.selection.selectionId,
              ),
            ]).size >= 2
          ? "green"
          : "amber",
    ];
    const missionRedDimensions = readinessBands.filter(
      (band) => band === "red",
    ).length;
    const missionGreenDimensions = readinessBands.filter(
      (band) => band === "green",
    ).length;
    const missionReadiness =
      missionTagBreadth * 10 +
      Math.min(20, state.selections.length * 3) +
      Math.min(
        12,
        Math.floor(
          state.selections.reduce(
            (sum, selection) => sum + selection.modelCount,
            0,
          ) / 2,
        ),
      );
    const opponentCoverage = state.selections.reduce(
      (sum, selection) => {
        const unit = unitById.get(selection.unitId);
        return unit
          ? sum +
              opponentContextScore(unit, opponentProfile) +
              equipmentContextScore(
                unit,
                selection.equipment,
                opponentProfile,
              )
          : sum;
      },
      0,
    );
    const roleBreadth = new Set(
      selectedUnits.map((unit) => unitRole(unit)),
    ).size;
    const unsupportedLeaders = state.selections.filter((selection) =>
      unsupportedLeaderUnitIds.has(selection.unitId),
    ).length;
    const duplicateCount = [...state.copies.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    );
    const fingerprint = state.selections
      .map((selection) =>
        `${selection.unitId}:${selection.modelCount}:${selection.points}:${equipmentSignature(selection.equipment)}`,
      )
      .sort()
      .join("|");
    const result = {
      exportable:
        exportableSelections === state.selections.length ? 1 : 0,
      pointsReady:
        state.totalPoints >= Math.ceil(input.pointsLimit * 0.98)
          ? 1
          : 0,
      pointsProgress: Math.min(
        19,
        Math.floor(
          (state.totalPoints / Math.max(1, input.pointsLimit)) * 20,
        ),
      ),
      points: state.totalPoints,
      missionRedDimensions,
      missionGreenDimensions,
      unsupportedLeaders,
      missionReadiness,
      opponentCoverage,
      roleBreadth,
      duplicateCount,
      fingerprint,
    };
    stateComponentCache.set(state, result);
    return result;
  };
  const compareStates = (left: BuildState, right: BuildState) => {
    const a = stateComponents(left);
    const b = stateComponents(right);
    if (!opponentProfile) {
      return (
        b.exportable - a.exportable ||
        b.pointsReady - a.pointsReady ||
        b.pointsProgress - a.pointsProgress ||
        b.points - a.points ||
        a.missionRedDimensions - b.missionRedDimensions ||
        a.unsupportedLeaders - b.unsupportedLeaders ||
        b.missionGreenDimensions - a.missionGreenDimensions ||
        b.missionReadiness - a.missionReadiness ||
        b.roleBreadth - a.roleBreadth ||
        a.duplicateCount - b.duplicateCount ||
        a.fingerprint.localeCompare(b.fingerprint)
      );
    }
    return (
      b.exportable - a.exportable ||
      b.pointsReady - a.pointsReady ||
      a.unsupportedLeaders - b.unsupportedLeaders ||
      a.missionRedDimensions - b.missionRedDimensions ||
      b.pointsProgress - a.pointsProgress ||
      b.points - a.points ||
      b.missionGreenDimensions - a.missionGreenDimensions ||
      b.missionReadiness - a.missionReadiness ||
      b.opponentCoverage - a.opponentCoverage ||
      b.roleBreadth - a.roleBreadth ||
      a.duplicateCount - b.duplicateCount ||
      a.fingerprint.localeCompare(b.fingerprint)
    );
  };
  const compareSearchStates = (
    left: BuildState,
    right: BuildState,
  ) => {
    const a = stateComponents(left);
    const b = stateComponents(right);
    return (
      b.exportable - a.exportable ||
      a.unsupportedLeaders - b.unsupportedLeaders ||
      a.missionRedDimensions - b.missionRedDimensions ||
      b.missionGreenDimensions - a.missionGreenDimensions ||
      b.missionReadiness - a.missionReadiness ||
      b.opponentCoverage - a.opponentCoverage ||
      b.pointsProgress - a.pointsProgress ||
      b.roleBreadth - a.roleBreadth ||
      a.duplicateCount - b.duplicateCount ||
      b.points - a.points ||
      a.fingerprint.localeCompare(b.fingerprint)
    );
  };
  let beam: BuildState[] = [{
    selections,
    copies,
    totalPoints,
  }];
  const completed: BuildState[] = [];
  const beamWidth = 8;
  const branchWidth = 6;
  for (let depth = 0; depth < 24; depth += 1) {
    const expanded: BuildState[] = [];
    for (const state of beam) {
      const remaining = input.pointsLimit - state.totalPoints;
      const candidates: Array<{
        unit: UnitView;
        modelCount: number;
        equipment: EquipmentSelection[];
        points: number;
        ordinal: number;
        exportable: boolean;
        score: number;
      }> = [];
      for (const unit of buildUnitPool) {
        const currentCopies = state.copies.get(unit.id) ?? 0;
        const rulesMaximumCopies =
          isNamedCharacter(unit) || isCharacterUnit(unit) ? 1 : 3;
        const collectionMaximumCopies =
          ownedCollection?.get(unit.id)?.maxUnits ??
          rulesMaximumCopies;
        const maximumCopies = Math.min(
          rulesMaximumCopies,
          collectionMaximumCopies,
        );
        if (currentCopies >= maximumCopies) continue;
        const ordinal = currentCopies + 1;
        for (const modelCount of availableModelCounts(unit, ordinal)) {
          for (
            const equipment of
              candidateEquipment(unit, modelCount)
          ) {
            if (!equipmentLoadoutIsLegal(unit, modelCount, equipment)) {
              continue;
            }
            const points = selectionPoints(
              unit,
              modelCount,
              ordinal,
              equipment,
              null,
            );
            if (points <= 0 || points > remaining) continue;
            if (
              !selectionFitsCollection(
                state.selections,
                unit.id,
                modelCount,
              )
            ) {
              continue;
            }
            const selection = makeSelection(
              unit,
              modelCount,
              ordinal,
              false,
              null,
              equipment,
            );
            if (selectionIsInternallyExcluded(selection)) {
              continue;
            }
            candidates.push({
              unit,
              modelCount,
              equipment,
              points,
              ordinal,
              exportable: selectionIsExportable(
                selection,
              ),
              score: candidateScore(
                unit,
                modelCount,
                points,
                remaining,
                input.preferences,
                currentCopies,
                true,
                opponentProfile,
                equipment,
              ),
            });
          }
        }
      }
      candidates.sort(
        (a, b) =>
          Number(b.exportable) - Number(a.exportable) ||
          b.score - a.score ||
          b.points - a.points ||
          a.unit.name.localeCompare(b.unit.name) ||
          a.modelCount - b.modelCount,
      );
      if (candidates.length === 0) completed.push(state);
      const branchCandidates = new Map<
        string,
        (typeof candidates)[number]
      >();
      const addBranchCandidate = (
        candidate: (typeof candidates)[number],
      ) => {
        branchCandidates.set(
          [
            candidate.unit.id,
            candidate.modelCount,
            candidate.ordinal,
            candidate.points,
            candidate.equipment
              .map((entry) => `${entry.itemId}:${entry.count}`)
              .sort()
              .join(","),
          ].join("|"),
          candidate,
        );
      };
      const addDistinctUnitCandidates = (
        ordered: Array<(typeof candidates)[number]>,
        limit: number,
      ) => {
        const unitIds = new Set<string>();
        for (const candidate of ordered) {
          if (unitIds.has(candidate.unit.id)) continue;
          unitIds.add(candidate.unit.id);
          addBranchCandidate(candidate);
          if (unitIds.size >= limit) break;
        }
      };
      candidates
        .slice(0, branchWidth)
        .forEach(addBranchCandidate);
      // A unit can now contribute several legal loadout candidates. Preserve
      // unit diversity as a separate branch budget so one datasheet's weapon
      // variants cannot crowd mission pieces out of the beam.
      if (opponentProfile) {
        addDistinctUnitCandidates(candidates, branchWidth);
      }
      // Preference-heavy scoring can otherwise prune inexpensive action
      // pieces and model-rich board-control units before the beam has enough
      // selections to evaluate mission readiness. Keep a small deterministic
      // diversity reserve alongside the highest-scoring branches.
      const inexpensiveCandidates = [...candidates].sort(
          (a, b) =>
            a.points - b.points ||
            b.modelCount - a.modelCount ||
            a.unit.name.localeCompare(b.unit.name),
      );
      const modelRichCandidates = [...candidates].sort(
          (a, b) =>
            b.modelCount - a.modelCount ||
            a.points - b.points ||
            a.unit.name.localeCompare(b.unit.name),
      );
      if (opponentProfile) {
        addDistinctUnitCandidates(inexpensiveCandidates, 3);
        addDistinctUnitCandidates(modelRichCandidates, 3);
      } else {
        inexpensiveCandidates
          .slice(0, 3)
          .forEach(addBranchCandidate);
        modelRichCandidates
          .slice(0, 3)
          .forEach(addBranchCandidate);
      }
      for (const candidate of branchCandidates.values()) {
        const nextCopies = new Map(state.copies);
        nextCopies.set(candidate.unit.id, candidate.ordinal);
        expanded.push({
          selections: [
            ...state.selections,
            makeSelection(
              candidate.unit,
              candidate.modelCount,
              candidate.ordinal,
              false,
              null,
              candidate.equipment,
            ),
          ],
          copies: nextCopies,
          totalPoints: state.totalPoints + candidate.points,
        });
      }
    }
    if (expanded.length === 0) break;
    const distinct = new Map<string, BuildState>();
    const missionDiversity = opponentProfile
      ? [...expanded]
          .sort(compareSearchStates)
          .slice(0, Math.ceil(beamWidth / 2))
      : [...expanded]
          .sort(
            (a, b) =>
              a.totalPoints - b.totalPoints ||
              compareStates(a, b),
          )
          .slice(0, 2);
    for (const state of [
      ...missionDiversity,
      ...[...expanded].sort(compareStates),
    ]) {
      const key = stateComponents(state).fingerprint;
      if (!distinct.has(key)) distinct.set(key, state);
      if (distinct.size >= beamWidth) break;
    }
    beam = [...distinct.values()];
  }
  const selectedState = [...completed, ...beam].sort(compareStates)[0];
  if (selectedState) {
    selections = selectedState.selections;
    copies = selectedState.copies;
    totalPoints = selectedState.totalPoints;
  }

  const timestamp = nowIso();
  const draft = stampRosterDataIdentity({
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
      legendsPolicyDecision: input.legendsPolicyDecision,
      collectionUnitIds: input.collectionUnitIds ?? null,
      collectionProfile: input.collectionProfile ?? null,
      requiredUnitIds: [...requiredUnitIds].sort(),
      excludedUnitIds: [...excludedUnitIds].sort(),
      requiredWarlordUnitId: input.requiredWarlordUnitId ?? null,
      opponentFactionId: opponentProfile?.factionId ?? null,
      opponentRosterFingerprint:
        opponentProfile?.rosterFingerprint ?? null,
      opponentThreatProfile: opponentProfile,
    },
    units: selections,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
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
  if (draft.sourceData.official.authority?.status !== "verified") {
    warnings.push(
      issue(
        "OFFICIAL_AUTHORITY_UNAVAILABLE",
        draft.sourceData.official.authority?.reason ??
          "This roster predates explicit official-extractor authority provenance; its Games Workshop reconciliation status is unverified.",
        "warn",
      ),
    );
  }
  const legendsDecision = draft.constraints.legendsPolicyDecision;
  if (
    legendsDecision &&
    legendsDecision.effectiveAllowLegends !==
      draft.constraints.allowLegends
  ) {
    violations.push(
      issue(
        "LEGENDS_POLICY_STATE_MISMATCH",
        "The stored Legends policy decision disagrees with the roster's effective allowLegends constraint.",
      ),
    );
  }
  if (
    legendsDecision?.requestedPolicy === "auto" &&
    legendsDecision.contextPermission === "unknown"
  ) {
    warnings.push(
      issue(
        "LEGENDS_POLICY_UNKNOWN",
        legendsDecision.reason,
        "warn",
      ),
    );
  }
  if (
    legendsDecision?.requestedPolicy === "allow" &&
    legendsDecision.resolution === "excluded" &&
    legendsDecision.classificationAuthority === "verified"
  ) {
    warnings.push(
      issue(
        "LEGENDS_POLICY_EXCLUDED",
        legendsDecision.reason,
        "warn",
      ),
    );
  }
  if (
    legendsDecision &&
    legendsDecision.classificationAuthority !== "verified" &&
    (
      legendsDecision.requestedPolicy === "allow" ||
      legendsDecision.contextPermission === "allowed"
    )
  ) {
    warnings.push(
      issue(
        "LEGENDS_CLASSIFICATION_UNVERIFIED",
        legendsDecision.reason,
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
  } else {
    const selection = warlords[0];
    const unit = resolveUnit(selection.unitId, draft.factionId);
    if (unit && !isWarlordEligible(unit)) {
      violations.push(
        issue(
          "WARLORD_INELIGIBLE",
          `${selection.name} lacks the authoritative Character keyword and cannot be the Warlord.`,
          "error",
          selection.selectionId,
        ),
      );
    } else if (
      unit &&
      !getNewRecruitFactionCatalogue(draft.factionId)?.units[unit.id]?.warlord
    ) {
      warnings.push(
        issue(
          "NEW_RECRUIT_WARLORD_MAPPING_UNAVAILABLE",
          `${selection.name} is legal in the roster engine, but its New Recruit mapping cannot encode the Warlord selection.`,
          "warn",
          selection.selectionId,
        ),
      );
    }
  }
  const selectedUnitIds = new Set(
    draft.units.map((selection) => selection.unitId),
  );
  const collectionUnitIds = draft.constraints.collectionUnitIds
    ? new Set(draft.constraints.collectionUnitIds)
    : null;
  for (const requiredUnitId of draft.constraints.requiredUnitIds ?? []) {
    if (!selectedUnitIds.has(requiredUnitId)) {
      violations.push(
        issue(
          "REQUIRED_UNIT_CONSTRAINT_VIOLATED",
          `Required unit "${requiredUnitId}" is absent from the roster.`,
        ),
      );
    }
  }
  const selectedLegends: DraftUnit[] = [];
  for (const selection of draft.units) {
    const unit = resolveUnit(selection.unitId, draft.factionId);
    if (unit?.raw.is_legend === true) {
      selectedLegends.push(selection);
      if (!legendBuildSupported(unit)) {
        violations.push(
          issue(
            "LEGENDS_BUILD_SUPPORT_UNAVAILABLE",
            `${selection.name} is classified as Legends, but its active signed bundle does not contain complete deterministic build data.`,
            "error",
            selection.selectionId,
          ),
        );
      }
    }
    if (
      (draft.constraints.excludedUnitIds ?? []).includes(
        selection.unitId,
      )
    ) {
      violations.push(
        issue(
          "EXCLUDED_UNIT_CONSTRAINT_VIOLATED",
          `${selection.name} is selected despite the roster's hard exclusion.`,
          "error",
          selection.selectionId,
        ),
      );
    }
    if (
      collectionUnitIds &&
      !collectionUnitIds.has(selection.unitId)
    ) {
      violations.push(
        issue(
          "COLLECTION_CONSTRAINT_VIOLATED",
          `${selection.name} is outside the roster's collection constraint.`,
          "error",
          selection.selectionId,
        ),
      );
    }
    if (
      unit &&
      !draft.constraints.allowNamedCharacters &&
      isNamedCharacter(unit)
    ) {
      violations.push(
        issue(
          "NAMED_CHARACTER_CONSTRAINT_VIOLATED",
          `${selection.name} is a named character, but named characters are excluded by this roster's hard constraints.`,
          "error",
          selection.selectionId,
        ),
      );
    }
    if (
      unit?.raw.is_legend === true &&
      !draft.constraints.allowLegends
    ) {
      violations.push(
        issue(
          "LEGENDS_REQUIRED_BUT_NOT_ALLOWED",
          `${selection.name} is a Legends unit, but the resolved Legends policy excludes it.`,
          "error",
          selection.selectionId,
        ),
      );
    }
  }
  if (selectedLegends.length > 0) {
    const activeClassificationAuthority =
      factionLegendsClassificationAuthority(draft.factionId);
    if (
      activeClassificationAuthority !== "verified" ||
      legendsDecision?.classificationAuthority !== "verified"
    ) {
      violations.push(
        issue(
          "LEGENDS_CLASSIFICATION_UNVERIFIED",
          "Selected Legends require complete, verified Games Workshop classification for the faction and every inherited faction unit pool.",
        ),
      );
    }
    if (draft.constraints.allowLegends && !legendsDecision) {
      violations.push(
        issue(
          "LEGENDS_POLICY_STATE_MISSING",
          "This roster enables and selects Legends without a persisted resolved Legends policy decision.",
        ),
      );
    }
  }
  if (selectedLegends.length > 0 && draft.constraints.allowLegends) {
    warnings.push(
      issue(
        "LEGENDS_INCLUDED",
        `This roster includes Legends units: ${selectedLegends
          .map((selection) => selection.name)
          .join(", ")}. ${legendsDecision?.reason ?? "Legends were enabled by a legacy roster constraint."}`,
        "warn",
      ),
    );
  }
  if (
    draft.constraints.requiredWarlordUnitId &&
    (warlords.length !== 1 ||
      warlords[0].unitId !==
        draft.constraints.requiredWarlordUnitId)
  ) {
    violations.push(
      issue(
        "WARLORD_CONSTRAINT_VIOLATED",
        `The Warlord must be unit "${draft.constraints.requiredWarlordUnitId}".`,
        "error",
        warlords[0]?.selectionId,
      ),
    );
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
    try {
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
    } catch {
      violations.push(
        issue(
          "LOADOUT_VALIDATION_FAILED",
          "Pinned catalogue composition data could not be evaluated safely; this roster is blocked until the data conflict is resolved.",
        ),
      );
    }
  }

  const compatibility = rebaseRosterData(draft);
  if (compatibility.ok) {
    warnings.push(...compatibility.warnings);
    if (compatibility.data?.status === "review-required") {
      violations.push(
        issue(
          "ROSTER_DATA_REVIEW_REQUIRED",
          "This roster references changed rules or New Recruit mappings. Review and explicitly rebase it before validation, export, or external delivery.",
        ),
      );
    }
  } else {
    violations.push(...compatibility.violations);
    warnings.push(...compatibility.warnings);
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
    const selected = next.units.find(
      (selection) => selection.selectionId === operation.selectionId,
    );
    if (!selected) {
      return fail("SELECTION_NOT_FOUND", "Roster selection was not found.");
    }
    const unit = resolveUnit(selected.unitId, draft.factionId);
    if (!unit || !isWarlordEligible(unit)) {
      return fail(
        "WARLORD_INELIGIBLE",
        `${selected.name} lacks the authoritative Character keyword and cannot be the Warlord.`,
      );
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

  next = stampRosterDataIdentity(
    recalculateDraft(next, next.units),
  );
  const validation = validateRoster(next);
  return {
    ok: validation.ok,
    data: next,
    violations: validation.violations,
    warnings: validation.warnings,
  };
}

export function modifyRosterBatch(
  draft: RosterDraftV1,
  operations: ModifyRosterOperation[],
): ResultEnvelope<RosterDraftV1> {
  if (!Array.isArray(operations) || operations.length === 0) {
    return envelope<RosterDraftV1>(null, [
      issue(
        "MALFORMED_OPERATION_BATCH",
        "A roster modification batch must contain at least one operation.",
      ),
    ]);
  }
  let working = draft;
  const intermediateWarnings: RosterIssue[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const result = modifyRoster(working, operations[index]);
    intermediateWarnings.push(...result.warnings);
    if (!result.data) {
      return envelope<RosterDraftV1>(
        null,
        result.violations.map((violation) => ({
          ...violation,
          message: `Operation ${index + 1}: ${violation.message}`,
        })),
        intermediateWarnings,
      );
    }
    working = result.data;
  }
  const validation = validateRoster(working);
  return {
    ok: validation.ok,
    data: working,
    violations: validation.violations,
    warnings: [
      ...validation.warnings,
      ...intermediateWarnings.filter(
        (warning, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.code === warning.code &&
              candidate.message === warning.message &&
              candidate.selectionId === warning.selectionId,
          ) === index,
      ),
    ],
  };
}

type RosterExplanation = {
  summary: string;
  choices: string[];
  cautions: string[];
  optimizer: {
    generatorVersion: "beam-search-v1";
    scoreOrder: string[];
    selectedCandidates: Array<{
      selectionId: string;
      unitId: string;
      unitName: string;
      modelCount: number;
      points: number;
      equipmentSignature: string;
      selectedProfileEvidence: string[];
      components: ReturnType<typeof candidateScoreComponents>;
    }>;
    targetProfileCoverage: {
      opponentFactionId: string;
      opponentRosterFingerprint: string | null;
      bodyCount: number | null;
      averagePointsPerModel: number | null;
      eliteShare: number;
      hordeShare: number;
      mobilityShare: number;
      vehicleMonsterShare: number;
      rangedShare: number;
      meleeShare: number;
      objectiveShare: number;
      durabilityShare: number;
      durabilityBands: OpponentThreatProfile["durabilityBands"];
      keyTargetProfiles:
        OpponentThreatProfile["keyTargetProfiles"];
      selectedCoverageScore: number;
      selectedProfileEvidence: string[];
    } | null;
  };
};

export function explainRoster(
  draft: RosterDraftV1,
): ResultEnvelope<RosterExplanation> {
  const validation = validateRoster(draft);
  if (
    !validation.ok &&
    validation.violations.some((item) => item.code === "MALFORMED_ROSTER")
  ) {
    return envelope<RosterExplanation>(
      null,
      validation.violations,
      validation.warnings,
    );
  }
  const parsed = parseRosterDraft(draft);
  if (!parsed.success) {
    return envelope<RosterExplanation>(
      null,
      validation.violations,
      validation.warnings,
    );
  }
  draft = parsed.data;
  const preferenceText = draft.preferences.length
    ? draft.preferences.join(", ")
    : "general-purpose play";
  const opponentProfile =
    draft.constraints.opponentThreatProfile ??
    (
      draft.constraints.opponentFactionId
        ? opponentBuildProfile({
            kind: "known-faction",
            factionId: draft.constraints.opponentFactionId,
          })
        : null
    );
  const choices = draft.units.map((selection) => {
    const matching = selection.tags.filter((tag) => draft.preferences.includes(tag));
    const unit = resolveUnit(selection.unitId, draft.factionId);
    const profileEvidence =
      opponentProfile && unit
        ? selectedProfileEvidence(
            unit,
            selection.equipment,
          )
        : [];
    return `${selection.modelCount} ${selection.name} (${selection.points} pts)${
      matching.length ? ` supports ${matching.join(" and ")}` : " adds a complementary role"
    }.${
      profileEvidence.length > 0
        ? ` Selected matchup profiles: ${profileEvidence.join("; ")}.`
        : ""
    }`;
  });
  let allocatedPoints = 0;
  const copyCounts = new Map<string, number>();
  const selectedCandidates = draft.units.flatMap(
    (selection, index) => {
      const unit = resolveUnit(selection.unitId, draft.factionId);
      if (!unit) return [];
      const currentCopies = copyCounts.get(unit.id) ?? 0;
      const components = candidateScoreComponents(
        unit,
        selection.modelCount,
        selection.points,
        draft.pointsLimit - allocatedPoints,
        draft.preferences,
        currentCopies,
        index > 0,
        opponentProfile,
        selection.equipment,
      );
      allocatedPoints += selection.points;
      copyCounts.set(unit.id, currentCopies + 1);
      return [{
        selectionId: selection.selectionId,
        unitId: selection.unitId,
        unitName: selection.name,
        modelCount: selection.modelCount,
        points: selection.points,
        equipmentSignature:
          equipmentSignature(selection.equipment),
        selectedProfileEvidence:
          selectedProfileEvidence(
            unit,
            selection.equipment,
          ),
        components,
      }];
    },
  );
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
      optimizer: {
        generatorVersion: "beam-search-v1",
        scoreOrder: [
          "hard constraints and legality",
          "New Recruit exportability",
          "points utilization",
          "mission readiness",
          "opponent-profile coverage",
          "role breadth",
          "duplication",
          "stable fingerprint",
        ],
        selectedCandidates,
        targetProfileCoverage: opponentProfile
          ? {
              opponentFactionId: opponentProfile.factionId,
              opponentRosterFingerprint:
                opponentProfile.rosterFingerprint,
              bodyCount: opponentProfile.bodyCount,
              averagePointsPerModel:
                opponentProfile.averagePointsPerModel,
              eliteShare: opponentProfile.eliteShare,
              hordeShare: opponentProfile.hordeShare,
              mobilityShare: opponentProfile.mobilityShare,
              vehicleMonsterShare:
                opponentProfile.vehicleMonsterShare,
              rangedShare: opponentProfile.rangedShare,
              meleeShare: opponentProfile.meleeShare,
              objectiveShare: opponentProfile.objectiveShare,
              durabilityShare: opponentProfile.durabilityShare,
              durabilityBands: opponentProfile.durabilityBands,
              keyTargetProfiles:
                opponentProfile.keyTargetProfiles,
              selectedCoverageScore: selectedCandidates.reduce(
                (sum, candidate) =>
                  sum + candidate.components.opponentCoverage,
                0,
              ),
              selectedProfileEvidence:
                selectedCandidates.flatMap(
                  (candidate) =>
                    candidate.selectedProfileEvidence,
                ),
            }
          : null,
      },
    },
    violations: validation.violations,
    warnings: validation.warnings,
  };
}

function exportText(draft: RosterDraftV1): string {
  const includesLegends = draft.units.some(
    (selection) =>
      resolveUnit(selection.unitId, draft.factionId)?.raw.is_legend ===
      true,
  );
  const lines = [
    draft.name,
    `${draft.factionName} — ${draft.totalPoints}/${draft.pointsLimit} pts`,
    `${draft.detachmentName} · ${draft.forceDispositionName}`,
    "",
    ...draft.units.map(
      (selection) => {
        const isLegend =
          resolveUnit(selection.unitId, draft.factionId)?.raw
            .is_legend === true;
        return `${selection.isWarlord ? "★ " : ""}${selection.modelCount}× ${selection.name}${isLegend ? " [Legends]" : ""} — ${selection.points} pts`;
      },
    ),
    "",
    ...(includesLegends
      ? [
          "Legends included: confirm that this play context or event permits Legends units.",
          "",
        ]
      : []),
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
  const includesLegends = draft.units.some(
    (selection) =>
      resolveUnit(selection.unitId, draft.factionId)?.raw.is_legend ===
      true,
  );
  const rows = draft.units
    .map(
      (selection) => {
        const isLegend =
          resolveUnit(selection.unitId, draft.factionId)?.raw
            .is_legend === true;
        return `<article>
  <div><strong>${escapeHtml(selection.name)}${isLegend ? " <small>Legends</small>" : ""}</strong><span>${escapeHtml(selection.role)} · ${selection.modelCount} models${selection.isWarlord ? " · Warlord" : ""}</span></div>
  <b>${selection.points} pts</b>
</article>`;
      },
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
small{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#785f17}.caution{padding:10px 12px;border:1px solid #b18d27;background:#fff8dc;color:#5c480f}
@media print{body{margin:0;max-width:none}a{color:inherit;text-decoration:none}}
</style></head><body>
<header><h1>${escapeHtml(draft.name)}</h1><p>${escapeHtml(draft.factionName)} · ${draft.totalPoints}/${draft.pointsLimit} points</p>
<p>${escapeHtml(draft.detachmentName)} · ${escapeHtml(draft.forceDispositionName)}</p>${includesLegends ? '<p class="caution"><strong>Legends included.</strong> Confirm that this play context or event permits Legends units.</p>' : ""}</header>
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
        content: zipSync(
          { [`${basename}.ros`]: strToU8(ros) },
          { level: 6, mtime: new Date(1980, 0, 1) },
        ),
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
    const legendsConfigurationFailure =
      newRecruitMappingFailure &&
      message.startsWith(
        "New Recruit Legends visibility mapping",
      );
    return envelope<ExportArtifact>(null, [
      issue(
        legendsConfigurationFailure
          ? "NEW_RECRUIT_LEGENDS_CONFIGURATION_UNAVAILABLE"
          : newRecruitMappingFailure
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
