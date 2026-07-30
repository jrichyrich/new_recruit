import { strFromU8, unzipSync } from "fflate";

import type {
  EnrichedRoszSummary,
  NewRecruitCataloguePin,
  NewRecruitCatalogueProvenanceComparison,
  NewRecruitObservedCatalogueIdentity,
  RosterDraftV1,
  TesseraPhase,
  TesseraProfileRequirement,
} from "./types";

export type EnrichedRoszExpectation = {
  name: string;
  factionName: string;
  totalPoints: number;
  units: Array<{
    name: string;
    modelCount: number;
    points?: number;
  }>;
};

export type EnrichedRoszValidationOptions = {
  /**
   * Run-scoped roster names are presentation state, not gameplay identity.
   * Direct New Recruit delivery remains exact by default. Hash-verified cache
   * and resume paths may accept an observed presentation alias while every
   * rule-bearing field is still checked.
   */
  rosterNamePolicy?: "exact" | "presentation-alias";
};

export type EnrichedRoszGameplayIdentity = {
  summary: EnrichedRoszSummary;
  requestedRosterName: string;
  observedRosterName: string;
  presentationNameMatched: boolean;
  presentationAliasAccepted: boolean;
};

export type EnrichedUnitProfileCoverage = {
  selectionId: string | null;
  name: string;
  modelCount: number;
  unitProfileCount: number;
  weaponProfileCount: number;
  complete: boolean;
};

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [
      match[1],
      decodeXml(match[2]),
    ]),
  );
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’‛`´]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function optionalAttribute(
  attrs: Record<string, string>,
  name: string,
): string | null {
  const value = attrs[name]?.trim();
  return value ? value : null;
}

function optionalRevision(
  attrs: Record<string, string>,
  name: string,
): number | null {
  const value = optionalAttribute(attrs, name);
  if (value === null) return null;
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : null;
}

function observedCatalogueIdentity(
  xml: string,
  roster: Record<string, string>,
): NewRecruitObservedCatalogueIdentity | undefined {
  if (!/newrecruit\.eu/i.test(roster.generatedBy ?? "")) return undefined;
  const catalogues = (
    xml.match(/<force\b[^>]*>/g) ?? []
  ).map((tag) => {
    const force = attributes(tag);
    return {
      id: optionalAttribute(force, "catalogueId"),
      name: optionalAttribute(force, "catalogueName"),
      revision: optionalRevision(force, "catalogueRevision"),
    };
  });
  const uniqueCatalogues = [
    ...new Map(
      catalogues.map((catalogue) => [
        [
          catalogue.id ?? "",
          normalized(catalogue.name ?? ""),
          catalogue.revision ?? "",
        ].join("|"),
        catalogue,
      ]),
    ).values(),
  ];
  return {
    source: "new-recruit-enriched-rosz",
    gameSystem: {
      id: optionalAttribute(roster, "gameSystemId"),
      name: optionalAttribute(roster, "gameSystemName"),
      revision: optionalRevision(roster, "gameSystemRevision"),
    },
    catalogues: uniqueCatalogues,
  };
}

function rosterXml(content: Uint8Array): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(content);
  } catch {
    throw new Error("The New Recruit export is not a readable .rosz archive.");
  }
  const rosterEntries = Object.entries(entries).filter(([name]) =>
    name.toLocaleLowerCase().endsWith(".ros"),
  );
  if (rosterEntries.length !== 1) {
    throw new Error(
      `The New Recruit export must contain exactly one .ros file; found ${rosterEntries.length}.`,
    );
  }
  return strFromU8(rosterEntries[0][1]);
}

function topLevelUnits(xml: string): EnrichedRoszSummary["units"] {
  const tokens =
    xml.match(/<selection\b[^>]*>|<\/selection>|<cost\b[^>]*\/?>/g) ?? [];
  const stack: Array<{
    selectionId: string;
    name: string;
    type: string;
    number: number;
    modelCount: number;
    directPoints: number | null;
    immediateChildPoints: number;
    hasImmediateChildPoints: boolean;
    topLevel: boolean;
  }> = [];
  const units: EnrichedRoszSummary["units"] = [];
  const ordinals = new Map<string, number>();

  const finish = (node: (typeof stack)[number]) => {
    const points =
      node.directPoints ??
      (
        node.hasImmediateChildPoints
          ? node.immediateChildPoints
          : null
      );
    if (node.topLevel && (node.type === "unit" || node.type === "model")) {
      const key = normalized(node.name);
      const ordinal = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, ordinal);
      units.push({
        name: node.name,
        modelCount:
          node.type === "model"
            ? node.number
            : Math.max(node.modelCount, node.number),
        ...(node.selectionId || points !== null
          ? {
            selectionId: node.selectionId || undefined,
            ordinal,
            points: points ?? undefined,
          }
          : {}),
      });
    }
  };

  for (const token of tokens) {
    if (token.startsWith("<cost")) {
      const current = stack.at(-1);
      if (current) {
        const attrs = attributes(token);
        if (normalized(attrs.name ?? "") === "pts") {
          const value = Number(attrs.value ?? Number.NaN);
          if (Number.isFinite(value)) current.directPoints = value;
        }
      }
      continue;
    }
    if (token === "</selection>") {
      const node = stack.pop();
      if (node) {
        const parent = stack.at(-1);
        if (
          parent?.topLevel &&
          (node.type === "unit" || node.type === "model") &&
          node.directPoints !== null
        ) {
          parent.immediateChildPoints += node.directPoints;
          parent.hasImmediateChildPoints = true;
        }
        finish(node);
      }
      continue;
    }
    const attrs = attributes(token);
    const node = {
      selectionId: attrs.id ?? "",
      name: attrs.name ?? "",
      type: attrs.type ?? "",
      number: Number(attrs.number ?? 0),
      modelCount: 0,
      directPoints: null,
      immediateChildPoints: 0,
      hasImmediateChildPoints: false,
      topLevel: stack.length === 0,
    };
    if (!node.topLevel && node.type === "model") {
      stack[0].modelCount += node.number;
    }
    if (token.endsWith("/>")) {
      const parent = stack.at(-1);
      if (
        parent?.topLevel &&
        (node.type === "unit" || node.type === "model") &&
        node.directPoints !== null
      ) {
        parent.immediateChildPoints += node.directPoints;
        parent.hasImmediateChildPoints = true;
      }
      finish(node);
    } else {
      stack.push(node);
    }
  }
  return units.filter((unit) => unit.name && unit.modelCount > 0);
}

/**
 * Reports whether every top-level unit has its own embedded model and weapon
 * profiles. Aggregate archive counts are insufficient: one profiled unit must
 * not make an otherwise partial upload appear simulation-ready.
 */
export function inspectEnrichedUnitProfileCoverage(
  content: Uint8Array,
): EnrichedUnitProfileCoverage[] {
  const xml = rosterXml(content);
  const units = topLevelUnits(xml);
  const coverage: Array<{
    unitProfileCount: number;
    weaponProfileCount: number;
  }> = [];
  const stack: Array<{
    type: string;
    coverageIndex: number | null;
  }> = [];
  const tokens =
    xml.match(
      /<selection\b[^>]*>|<\/selection>|<profile\b[^>]*>|<\/profile>/g,
    ) ?? [];

  for (const token of tokens) {
    if (token === "</selection>") {
      stack.pop();
      continue;
    }
    if (token === "</profile>") continue;
    if (token.startsWith("<selection")) {
      const attrs = attributes(token);
      const isTopLevelUnit =
        stack.length === 0 &&
        (attrs.type === "unit" || attrs.type === "model");
      const coverageIndex = isTopLevelUnit
        ? coverage.push({
            unitProfileCount: 0,
            weaponProfileCount: 0,
          }) - 1
        : (stack[0]?.coverageIndex ?? null);
      stack.push({
        type: attrs.type ?? "",
        coverageIndex,
      });
      if (token.endsWith("/>")) stack.pop();
      continue;
    }
    if (!token.startsWith("<profile")) continue;
    const coverageIndex = stack[0]?.coverageIndex ?? null;
    if (coverageIndex === null) continue;
    const profile = attributes(token);
    if (profile.typeName === "Unit") {
      coverage[coverageIndex].unitProfileCount += 1;
    } else if (
      profile.typeName === "Ranged Weapons" ||
      profile.typeName === "Melee Weapons"
    ) {
      coverage[coverageIndex].weaponProfileCount += 1;
    }
  }

  return units.map((unit, index) => {
    const observed = coverage[index] ?? {
      unitProfileCount: 0,
      weaponProfileCount: 0,
    };
    return {
      selectionId: unit.selectionId ?? null,
      name: unit.name,
      modelCount: unit.modelCount,
      ...observed,
      complete:
        observed.unitProfileCount > 0 &&
        observed.weaponProfileCount > 0,
    };
  });
}

function multiset(
  units: Array<{
    name: string;
    modelCount: number;
    points?: number;
  }>,
  includePoints = false,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const unit of units) {
    const key = [
      normalized(unit.name),
      unit.modelCount,
      ...(includePoints ? [unit.points ?? "missing"] : []),
    ].join("|");
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function factionMatches(observed: string, expected: string): boolean {
  const actual = normalized(observed);
  const requested = normalized(expected);
  return (
    actual === requested ||
    actual.endsWith(` - ${requested}`) ||
    requested.endsWith(` - ${actual}`)
  );
}

function describeUnitKey(
  key: string,
  count: number,
  label: "expected" | "observed",
): string {
  const [name, models, points] = key.split("|");
  return `${label} ${count}x ${models}-model ${name}${
    points === undefined ? "" : ` at ${points} points`
  }`;
}

function exactMultisetMismatches(
  actual: Map<string, number>,
  expected: Map<string, number>,
): string[] {
  const mismatches: string[] = [];
  const keys = [...new Set([...actual.keys(), ...expected.keys()])].sort();
  for (const key of keys) {
    const actualCount = actual.get(key) ?? 0;
    const expectedCount = expected.get(key) ?? 0;
    if (actualCount === expectedCount) continue;
    if (expectedCount > 0) {
      mismatches.push(describeUnitKey(key, expectedCount, "expected"));
    }
    if (actualCount > 0) {
      mismatches.push(describeUnitKey(key, actualCount, "observed"));
    }
  }
  return mismatches;
}

export function inspectEnrichedRosz(
  content: Uint8Array,
): EnrichedRoszSummary {
  const xml = rosterXml(content);
  const rosterTag = xml.match(/<roster\b[^>]*>/)?.[0];
  const forceTag = xml.match(/<force\b[^>]*>/)?.[0];
  if (!rosterTag || !forceTag) {
    throw new Error("The New Recruit export does not contain a roster and force.");
  }
  const roster = attributes(rosterTag);
  const force = attributes(forceTag);
  const rootCost = xml.match(
    /<cost\b(?=[^>]*\bname="pts")(?=[^>]*\bvalue="[^"]+")[^>]*>/,
  )?.[0];
  const totalPoints = rootCost
    ? Number(attributes(rootCost).value ?? Number.NaN)
    : Number.NaN;
  const profileCount = (xml.match(/<profile\b/g) ?? []).length;
  const weaponProfileCount = (
    xml.match(/<profile\b[^>]*\btypeName="(?:Melee|Ranged) Weapons"[^>]*>/g) ??
    []
  ).length;
  const observedNewRecruitCatalogue = observedCatalogueIdentity(xml, roster);
  return {
    rosterName: roster.name ?? "",
    factionName: force.catalogueName ?? force.name ?? "",
    totalPoints,
    generatedBy: roster.generatedBy ?? "",
    ...(observedNewRecruitCatalogue
      ? { observedNewRecruitCatalogue }
      : {}),
    profileCount,
    weaponProfileCount,
    units: topLevelUnits(xml),
  };
}

/**
 * Compares only identity fields that New Recruit exposes in its own enriched
 * ROSZ. The pinned BSData commit remains separate provenance because an
 * enriched archive cannot prove which backend commit New Recruit deployed.
 */
export function compareNewRecruitCatalogueProvenance(
  summary: EnrichedRoszSummary,
  pinned: NewRecruitCataloguePin,
): NewRecruitCatalogueProvenanceComparison {
  const observed = summary.observedNewRecruitCatalogue ?? null;
  const mismatches: NewRecruitCatalogueProvenanceComparison["mismatches"] = [];
  const missing: NewRecruitCatalogueProvenanceComparison["missing"] = [];
  if (!observed) {
    missing.push("new-recruit-enriched-identity");
    return {
      status: "unverifiable",
      pinned,
      observed: null,
      mismatches,
      missing,
    };
  }

  if (observed.gameSystem.id === null) {
    missing.push("game-system-id");
  } else if (observed.gameSystem.id !== pinned.gameSystem.id) {
    mismatches.push({
      field: "game-system-id",
      expected: pinned.gameSystem.id,
      observed: observed.gameSystem.id,
    });
  }
  if (observed.gameSystem.revision === null) {
    missing.push("game-system-revision");
  } else if (
    observed.gameSystem.revision !== pinned.gameSystem.revision
  ) {
    mismatches.push({
      field: "game-system-revision",
      expected: pinned.gameSystem.revision,
      observed: observed.gameSystem.revision,
    });
  }

  const cataloguesWithIds = observed.catalogues.filter(
    (catalogue) => catalogue.id !== null,
  );
  const matchingCatalogues = cataloguesWithIds.filter(
    (catalogue) => catalogue.id === pinned.catalogue.id,
  );
  let fallbackCatalogue:
    NewRecruitObservedCatalogueIdentity["catalogues"][number] | undefined;
  if (cataloguesWithIds.length === 0) {
    missing.push("catalogue-id");
    fallbackCatalogue =
      observed.catalogues.find(
        (catalogue) =>
          catalogue.name !== null &&
          normalized(catalogue.name) === normalized(pinned.catalogue.name),
      ) ??
      (observed.catalogues.length === 1
        ? observed.catalogues[0]
        : undefined);
  } else if (matchingCatalogues.length === 0) {
    mismatches.push({
      field: "catalogue-id",
      expected: pinned.catalogue.id,
      observed: cataloguesWithIds.map((catalogue) => catalogue.id).join(","),
    });
  }

  const revisionCandidates =
    matchingCatalogues.length > 0
      ? matchingCatalogues
      : fallbackCatalogue
        ? [fallbackCatalogue]
        : [];
  if (
    pinned.catalogue.revision !== null &&
    revisionCandidates.length > 0
  ) {
    if (revisionCandidates.some((catalogue) => catalogue.revision === null)) {
      missing.push("catalogue-revision");
    }
    const observedRevisions = [
      ...new Set(
        revisionCandidates
          .map((catalogue) => catalogue.revision)
          .filter((revision): revision is number => revision !== null),
      ),
    ];
    if (
      observedRevisions.some(
        (revision) => revision !== pinned.catalogue.revision,
      )
    ) {
      mismatches.push({
        field: "catalogue-revision",
        expected: pinned.catalogue.revision,
        observed:
          observedRevisions.length === 1
            ? observedRevisions[0]
            : observedRevisions.join(","),
      });
    }
  } else if (
    pinned.catalogue.revision !== null &&
    cataloguesWithIds.length === 0 &&
    observed.catalogues.length === 0
  ) {
    missing.push("catalogue-revision");
  }

  return {
    status:
      mismatches.length > 0
        ? "drift"
        : missing.length > 0
          ? "unverifiable"
          : "matched",
    pinned,
    observed,
    mismatches,
    missing: [...new Set(missing)],
  };
}

/**
 * Reads the alternate weapon-profile inventory that New Recruit actually
 * embedded in an enriched archive. The result is intentionally limited to
 * explicit multi-profile weapon groups (for example, "Prism Cannon -
 * focused lances") so ordinary weapon names containing a hyphen are not
 * mistaken for a user-selectable profile decision.
 */
export function inspectEnrichedProfileRequirements(
  content: Uint8Array,
  faction: string,
): TesseraProfileRequirement[] {
  const xml = rosterXml(content);
  const unitOccurrenceBySize = new Map<string, number>();
  const unitIdentityBySelectionId = new Map<
    string,
    { modelCount: number; unitOccurrence: number }
  >();
  for (const unit of topLevelUnits(xml)) {
    const sizeKey = [normalized(unit.name), unit.modelCount].join("|");
    const unitOccurrence =
      (unitOccurrenceBySize.get(sizeKey) ?? 0) + 1;
    unitOccurrenceBySize.set(sizeKey, unitOccurrence);
    if (unit.selectionId) {
      unitIdentityBySelectionId.set(unit.selectionId, {
        modelCount: unit.modelCount,
        unitOccurrence,
      });
    }
  }
  const tokens =
    xml.match(
      /<selection\b[^>]*>|<\/selection>|<profile\b[^>]*>|<\/profile>/g,
    ) ?? [];
  type SelectionFrame = {
    id: string;
    name: string;
    type: string;
    number: number;
    instanceKey: string;
  };
  type InventoryEntry = {
    faction: string;
    unit: string;
    selectionId: string | null;
    unitOccurrence?: number;
    modelCount?: number;
    weaponGroup: string;
    phase: TesseraPhase;
    profiles: Map<string, string>;
    activeByUnit: Map<string, Map<string, number>>;
  };
  const stack: SelectionFrame[] = [];
  const inventory = new Map<string, InventoryEntry>();
  let selectionSerial = 0;

  for (const token of tokens) {
    if (token === "</selection>") {
      stack.pop();
      continue;
    }
    if (token === "</profile>") continue;
    if (token.startsWith("<selection")) {
      const attrs = attributes(token);
      selectionSerial += 1;
      stack.push({
        id: attrs.id ?? "",
        name: attrs.name ?? "",
        type: attrs.type ?? "",
        number: Number(attrs.number ?? 1),
        instanceKey: attrs.id || `selection-${selectionSerial}`,
      });
      if (token.endsWith("/>")) stack.pop();
      continue;
    }
    if (!token.startsWith("<profile") || stack.length === 0) continue;
    const profile = attributes(token);
    const phase: TesseraPhase | null =
      profile.typeName === "Ranged Weapons"
        ? "shooting"
        : profile.typeName === "Melee Weapons"
          ? "fight"
          : null;
    if (!phase) continue;
    const profileNameValue = profile.name ?? "";
    const prefixedAlternate = profileNameValue.match(
      /^\s*[➤▶►]\s*(.+?)\s+-\s+(.+?)\s*$/,
    );
    let weaponGroup: string | null =
      prefixedAlternate?.[1].trim() ?? null;
    let profileName: string | null =
      prefixedAlternate?.[2].trim() ?? null;
    let weaponFrame: SelectionFrame | null = null;
    if (!prefixedAlternate) {
      for (const frame of [...stack].reverse()) {
        for (const delimiter of profileNameValue.matchAll(/\s+-\s+/g)) {
          const index = delimiter.index ?? -1;
          if (index < 0) continue;
          const candidateGroup = profileNameValue.slice(0, index).trim();
          const candidateProfile = profileNameValue
            .slice(index + delimiter[0].length)
            .trim();
          if (
            candidateProfile.length > 0 &&
            normalized(candidateGroup) === normalized(frame.name)
          ) {
            weaponGroup = frame.name.trim();
            profileName = candidateProfile;
            weaponFrame = frame;
            break;
          }
        }
        if (weaponFrame) break;
      }
    }
    if (!weaponGroup || !profileName) continue;
    const unitFrame = stack[0];
    if (
      !unitFrame ||
      (unitFrame.type !== "unit" && unitFrame.type !== "model")
    ) {
      continue;
    }
    const unitIdentity = unitIdentityBySelectionId.get(unitFrame.id);
    weaponFrame ??=
      [...stack]
        .reverse()
        .find(
          (frame) =>
            normalized(frame.name) === normalized(weaponGroup),
        ) ?? stack[stack.length - 1];
    const key = [
      normalized(faction),
      normalized(unitFrame.name),
      unitIdentity?.modelCount ?? "legacy",
      unitIdentity?.unitOccurrence ?? "legacy",
      normalized(weaponGroup),
      phase,
    ].join("|");
    const entry =
      inventory.get(key) ?? {
        faction,
        unit: unitFrame.name,
        selectionId: unitFrame.id || null,
        ...(unitIdentity ?? {}),
        weaponGroup,
        phase,
        profiles: new Map<string, string>(),
        activeByUnit: new Map<string, Map<string, number>>(),
      };
    entry.profiles.set(normalized(profileName), profileName);
    const unitWeapons =
      entry.activeByUnit.get(unitFrame.instanceKey) ??
      new Map<string, number>();
    unitWeapons.set(
      weaponFrame.instanceKey,
      Number.isFinite(weaponFrame.number) && weaponFrame.number > 0
        ? weaponFrame.number
        : 1,
    );
    entry.activeByUnit.set(unitFrame.instanceKey, unitWeapons);
    inventory.set(key, entry);
  }

  return [...inventory.values()]
    .filter((entry) => entry.profiles.size > 1)
    .map((entry) => ({
      faction: entry.faction,
      unit: entry.unit,
      selectionId: entry.selectionId,
      ...(entry.unitOccurrence === undefined
        ? {}
        : { unitOccurrence: entry.unitOccurrence }),
      ...(entry.modelCount === undefined
        ? {}
        : { modelCount: entry.modelCount }),
      weaponGroup: entry.weaponGroup,
      phase: entry.phase,
      availableProfiles: [...entry.profiles.values()].sort((left, right) =>
        normalized(left).localeCompare(normalized(right)),
      ),
      activeCount: Math.max(
        1,
        ...[...entry.activeByUnit.values()].map((weapons) =>
          [...weapons.values()].reduce((sum, count) => sum + count, 0),
        ),
      ),
      selectedProfile: null,
    }))
    .sort(
      (left, right) =>
        normalized(left.faction).localeCompare(normalized(right.faction)) ||
        normalized(left.unit).localeCompare(normalized(right.unit)) ||
        (left.modelCount ?? 0) - (right.modelCount ?? 0) ||
        (left.unitOccurrence ?? 0) - (right.unitOccurrence ?? 0) ||
        normalized(left.weaponGroup).localeCompare(
          normalized(right.weaponGroup),
        ) ||
        left.phase.localeCompare(right.phase),
    );
}

export function validateEnrichedRosz(
  content: Uint8Array,
  expected: EnrichedRoszExpectation,
  options: EnrichedRoszValidationOptions = {},
): EnrichedRoszSummary {
  const summary = inspectEnrichedRosz(content);
  const mismatches: string[] = [];
  if (
    (options.rosterNamePolicy ?? "exact") === "exact" &&
    normalized(summary.rosterName) !== normalized(expected.name)
  ) {
    mismatches.push(`roster name "${summary.rosterName}"`);
  }
  if (!factionMatches(summary.factionName, expected.factionName)) {
    mismatches.push(`faction "${summary.factionName}"`);
  }
  if (summary.totalPoints !== expected.totalPoints) {
    mismatches.push(`total ${summary.totalPoints} points`);
  }
  if (!/newrecruit\.eu/i.test(summary.generatedBy)) {
    mismatches.push(`generator "${summary.generatedBy}"`);
  }
  if (summary.profileCount === 0 || summary.weaponProfileCount === 0) {
    mismatches.push("embedded model/weapon profiles");
  }
  const includePoints = expected.units.every(
    (unit) => unit.points !== undefined,
  );
  mismatches.push(
    ...exactMultisetMismatches(
      multiset(summary.units, includePoints),
      multiset(expected.units, includePoints),
    ),
  );
  if (mismatches.length) {
    throw new Error(
      `The New Recruit enriched export failed verification: ${mismatches.join(", ")}.`,
    );
  }
  return summary;
}

/**
 * Verifies the rule-bearing identity used by both persistent-cache acceptance
 * and certification resume. The observed roster name is deliberately retained
 * as evidence because a cache entry may have been created by an earlier
 * run-scoped name.
 */
export function validateEnrichedRoszGameplayIdentity(
  content: Uint8Array,
  roster: RosterDraftV1,
): EnrichedRoszGameplayIdentity {
  const summary = validateEnrichedRosz(
    content,
    {
      name: roster.name,
      factionName: roster.factionName,
      totalPoints: roster.totalPoints,
      units: roster.units.map((unit) => ({
        name: unit.name,
        modelCount: unit.modelCount,
        points: unit.points,
      })),
    },
    { rosterNamePolicy: "presentation-alias" },
  );
  const presentationNameMatched =
    normalized(summary.rosterName) === normalized(roster.name);
  return {
    summary,
    requestedRosterName: roster.name,
    observedRosterName: summary.rosterName,
    presentationNameMatched,
    presentationAliasAccepted: !presentationNameMatched,
  };
}
