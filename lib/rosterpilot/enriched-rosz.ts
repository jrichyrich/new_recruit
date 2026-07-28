import { strFromU8, unzipSync } from "fflate";

import type { EnrichedRoszSummary } from "./types";

export type EnrichedRoszExpectation = {
  name: string;
  factionName: string;
  totalPoints: number;
  units: Array<{ name: string; modelCount: number }>;
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
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
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
    points: number | null;
    topLevel: boolean;
  }> = [];
  const units: EnrichedRoszSummary["units"] = [];
  const ordinals = new Map<string, number>();

  const finish = (node: (typeof stack)[number]) => {
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
        ...(node.selectionId || node.points !== null
          ? {
            selectionId: node.selectionId || undefined,
            ordinal,
            points: node.points ?? undefined,
          }
          : {}),
      });
    }
  };

  for (const token of tokens) {
    if (token.startsWith("<cost")) {
      if (stack.length === 1) {
        const attrs = attributes(token);
        if (normalized(attrs.name ?? "") === "pts") {
          const value = Number(attrs.value ?? Number.NaN);
          if (Number.isFinite(value)) stack[0].points = value;
        }
      }
      continue;
    }
    if (token === "</selection>") {
      const node = stack.pop();
      if (node) finish(node);
      continue;
    }
    const attrs = attributes(token);
    const node = {
      selectionId: attrs.id ?? "",
      name: attrs.name ?? "",
      type: attrs.type ?? "",
      number: Number(attrs.number ?? 0),
      modelCount: 0,
      points: null,
      topLevel: stack.length === 0,
    };
    if (!node.topLevel && node.type === "model") {
      stack[0].modelCount += node.number;
    }
    if (token.endsWith("/>")) finish(node);
    else stack.push(node);
  }
  return units.filter((unit) => unit.name && unit.modelCount > 0);
}

function multiset(
  units: Array<{ name: string; modelCount: number }>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const unit of units) {
    const key = `${normalized(unit.name)}|${unit.modelCount}`;
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

export function inspectEnrichedRosz(
  content: Uint8Array,
): EnrichedRoszSummary {
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
  const xml = strFromU8(rosterEntries[0][1]);
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
  return {
    rosterName: roster.name ?? "",
    factionName: force.catalogueName ?? force.name ?? "",
    totalPoints,
    generatedBy: roster.generatedBy ?? "",
    profileCount,
    weaponProfileCount,
    units: topLevelUnits(xml),
  };
}

export function validateEnrichedRosz(
  content: Uint8Array,
  expected: EnrichedRoszExpectation,
): EnrichedRoszSummary {
  const summary = inspectEnrichedRosz(content);
  const mismatches: string[] = [];
  if (normalized(summary.rosterName) !== normalized(expected.name)) {
    mismatches.push(`roster name "${summary.rosterName}"`);
  }
  if (!normalized(summary.factionName).includes(normalized(expected.factionName))) {
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
  const actualUnits = multiset(summary.units);
  const expectedUnits = multiset(expected.units);
  for (const [key, count] of expectedUnits) {
    if ((actualUnits.get(key) ?? 0) !== count) {
      const [name, models] = key.split("|");
      mismatches.push(`${count}x ${models}-model ${name}`);
    }
  }
  if (mismatches.length) {
    throw new Error(
      `The New Recruit enriched export failed verification: ${mismatches.join(", ")}.`,
    );
  }
  return summary;
}
