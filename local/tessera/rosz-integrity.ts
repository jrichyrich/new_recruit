import crypto from "node:crypto";

import { strFromU8, unzipSync } from "fflate";

export type RoszGameplaySnapshot = {
  schemaVersion: 1;
  totalPoints: number | null;
  gameSystem: {
    id: string | null;
    revision: number | null;
  };
  catalogues: Array<{
    id: string | null;
    revision: number | null;
  }>;
  selections: string[];
};

type ParsedSelection = {
  ancestry: string[];
  entryId: string;
  entryGroupId: string;
  name: string;
  type: string;
  group: string;
  from: string;
  number: number | null;
  costs: string[];
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

function normalized(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[‘’‛`´]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function normalizedSelectionName(value: string): string {
  return normalized(value).replace(/^\d+\.\s+/, "");
}

function semanticAncestryIdentity(value: string): string {
  const [entryId = "", name = "", type = ""] = value.split("|");
  return [
    entryId,
    normalizedSelectionName(name),
    normalized(type),
  ].join("|");
}

function semanticCosts(costs: string[]): string[] {
  return costs
    .map((cost) => JSON.parse(cost) as {
      typeId: string;
      name: string;
      value: number | null;
    })
    .filter((cost) => cost.value !== 0)
    .map((cost) => JSON.stringify(cost))
    .sort();
}

function semanticSelections(snapshot: RoszGameplaySnapshot): string[] {
  return snapshot.selections
    .map((serialized) => {
      const selection = JSON.parse(serialized) as ParsedSelection;
      return JSON.stringify({
        ancestry: selection.ancestry.map(semanticAncestryIdentity),
        entryId: selection.entryId,
        name: normalizedSelectionName(selection.name),
        type: selection.type,
        number: selection.number,
        costs: semanticCosts(selection.costs),
      });
    })
    .sort();
}

function optionalInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function optionalNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rosterXml(content: Uint8Array): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(content);
  } catch {
    throw new Error("The ROSZ is not a readable ZIP archive.");
  }
  const rosterEntries = Object.entries(entries).filter(([name]) =>
    name.toLocaleLowerCase().endsWith(".ros"),
  );
  if (rosterEntries.length !== 1) {
    throw new Error(
      `The ROSZ must contain exactly one .ros document; found ${rosterEntries.length}.`,
    );
  }
  return strFromU8(rosterEntries[0][1]);
}

type SelectionFrame = {
  pathIdentity: string;
  value: {
    ancestry: string[];
    entryId: string;
    entryGroupId: string;
    name: string;
    type: string;
    group: string;
    from: string;
    number: number | null;
    costs: string[];
  };
};

/**
 * Captures rule-bearing ROSZ selection state while deliberately excluding
 * presentation IDs, embedded profiles, rules text, and roster names.
 *
 * New Recruit may reserialize an archive and add profile/rule payloads, but it
 * must not change the selected units, model quantities, equipment, Warlord,
 * enhancements, points, game-system identity, or catalogue identity.
 */
export function inspectRoszGameplaySnapshot(
  content: Uint8Array,
): RoszGameplaySnapshot {
  const xml = rosterXml(content);
  const rosterTag = xml.match(/<roster\b[^>]*>/)?.[0];
  if (!rosterTag) {
    throw new Error("The ROSZ does not contain a roster root.");
  }
  const roster = attributes(rosterTag);
  const catalogues = (xml.match(/<force\b[^>]*>/g) ?? [])
    .map((tag) => {
      const force = attributes(tag);
      return {
        id: force.catalogueId?.trim() || null,
        revision: optionalInteger(force.catalogueRevision),
      };
    })
    .sort(
      (left, right) =>
        (left.id ?? "").localeCompare(right.id ?? "") ||
        (left.revision ?? -1) - (right.revision ?? -1),
    );

  const selections: string[] = [];
  const stack: SelectionFrame[] = [];
  const tokens =
    xml.match(
      /<selection\b[^>]*>|<\/selection>|<cost\b[^>]*\/?>/g,
    ) ?? [];
  const finish = (frame: SelectionFrame) => {
    frame.value.costs.sort();
    selections.push(JSON.stringify(frame.value));
  };
  for (const token of tokens) {
    if (token.startsWith("<cost")) {
      const current = stack.at(-1);
      if (!current) continue;
      const cost = attributes(token);
      current.value.costs.push(
        JSON.stringify({
          typeId: cost.typeId?.trim() ?? "",
          name: normalized(cost.name),
          value: optionalNumber(cost.value),
        }),
      );
      continue;
    }
    if (token === "</selection>") {
      const frame = stack.pop();
      if (frame) finish(frame);
      continue;
    }
    const selection = attributes(token);
    const pathIdentity = [
      selection.entryId?.trim() ?? "",
      normalized(selection.name),
      normalized(selection.type),
      normalized(selection.group),
    ].join("|");
    const frame: SelectionFrame = {
      pathIdentity,
      value: {
        ancestry: stack.map((ancestor) => ancestor.pathIdentity),
        entryId: selection.entryId?.trim() ?? "",
        entryGroupId: selection.entryGroupId?.trim() ?? "",
        name: normalized(selection.name),
        type: normalized(selection.type),
        group: normalized(selection.group),
        from: normalized(selection.from),
        number: optionalNumber(selection.number),
        costs: [],
      },
    };
    if (token.endsWith("/>")) {
      finish(frame);
    } else {
      stack.push(frame);
    }
  }
  while (stack.length > 0) {
    finish(stack.pop()!);
  }

  const rootPointsTag = xml
    .slice(0, xml.search(/<forces?\b/i))
    .match(
      /<cost\b(?=[^>]*\bname="pts")(?=[^>]*\bvalue="[^"]+")[^>]*>/,
    )?.[0];
  return {
    schemaVersion: 1,
    totalPoints: rootPointsTag
      ? optionalNumber(attributes(rootPointsTag).value)
      : null,
    gameSystem: {
      id: roster.gameSystemId?.trim() || null,
      revision: optionalInteger(roster.gameSystemRevision),
    },
    catalogues,
    selections: selections.sort(),
  };
}

export function roszGameplaySnapshotSha256(
  snapshot: RoszGameplaySnapshot,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}

export function compareRoszGameplaySnapshots(
  expected: RoszGameplaySnapshot,
  observed: RoszGameplaySnapshot,
): string[] {
  const mismatches: string[] = [];
  if (expected.totalPoints !== observed.totalPoints) {
    mismatches.push("points");
  }
  if (
    expected.gameSystem.id !== observed.gameSystem.id ||
    expected.gameSystem.revision !== observed.gameSystem.revision
  ) {
    mismatches.push("game-system");
  }
  if (JSON.stringify(expected.catalogues) !== JSON.stringify(observed.catalogues)) {
    mismatches.push("catalogue");
  }
  if (
    JSON.stringify(semanticSelections(expected)) !==
    JSON.stringify(semanticSelections(observed))
  ) {
    mismatches.push("selection-tree");
  }
  return mismatches;
}
