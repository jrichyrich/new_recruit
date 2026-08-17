import crypto from "node:crypto";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

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
  return entryId
    ? [entryId, normalized(type)].join("|")
    : [normalizedSelectionName(name), normalized(type)].join("|");
}

function semanticSelections(snapshot: RoszGameplaySnapshot): string[] {
  return snapshot.selections
    .map((serialized) => {
      const selection = JSON.parse(serialized) as ParsedSelection;
      return JSON.stringify({
        ancestry: selection.ancestry.map(semanticAncestryIdentity),
        entryId: selection.entryId,
        ...(selection.entryId
          ? {}
          : { name: normalizedSelectionName(selection.name) }),
        type: selection.type,
        number: selection.number,
      });
    })
    .sort();
}

function oneEditApart(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  const [shorter, longer] = left.length <= right.length
    ? [left, right]
    : [right, left];
  let differences = 0;
  for (let short = 0, long = 0; long < longer.length; long += 1) {
    if (shorter[short] === longer[long]) {
      short += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) return false;
    if (shorter.length === longer.length) short += 1;
  }
  return true;
}

function nameTokens(value: string): string[] {
  return normalizedSelectionName(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/**
 * Catalogue identity pairs that New Recruit still emits after a specialist
 * kit was renamed. Token matching alone cannot treat "Servo-scribes" as the
 * same kit as "Alchemyk counteragents".
 */
const CATALOGUE_IDENTITY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["servo-scribes", "alchemyk"],
];

function expandedIdentityTokens(name: string): string[] {
  const tokens = nameTokens(name);
  const expanded = [...tokens];
  for (const [left, right] of CATALOGUE_IDENTITY_ALIASES) {
    const leftTokens = nameTokens(left);
    const rightTokens = nameTokens(right);
    const hasLeft = leftTokens.length > 0 &&
      leftTokens.every((token) =>
        tokens.some((candidate) => oneEditApart(token, candidate))
      );
    const hasRight = rightTokens.length > 0 &&
      rightTokens.every((token) =>
        tokens.some((candidate) => oneEditApart(token, candidate))
      );
    if (hasRight) expanded.push(...leftTokens);
    if (hasLeft) expanded.push(...rightTokens);
  }
  return expanded;
}

function looksLikeUnitCompositionName(name: string): boolean {
  return /^\d+\s+.+\band\b.+\d+\s+/.test(normalizedSelectionName(name));
}

function isCompositionWrapperSelection(selection: ParsedSelection): boolean {
  if (selection.type !== "upgrade") return false;
  const parentType = normalized(selection.ancestry.at(-1)?.split("|")[2]);
  if (parentType !== "unit") return false;
  if (selection.group === "unit composition") return true;
  return looksLikeUnitCompositionName(selection.name) &&
    selection.costs.length === 0;
}

function isCompositionAncestryFrame(frame: string): boolean {
  const [, name = "", type = "", group = ""] = frame.split("|");
  if (normalized(type) !== "upgrade") return false;
  return normalized(group) === "unit composition" ||
    looksLikeUnitCompositionName(name);
}

function hoistWarlordAncestry(selection: ParsedSelection): ParsedSelection {
  if (
    selection.type !== "upgrade" ||
    normalizedSelectionName(selection.name) !== "warlord"
  ) {
    return selection;
  }
  const unitIndex = selection.ancestry.findIndex(
    (frame) => normalized(frame.split("|")[2]) === "unit",
  );
  if (unitIndex < 0 || selection.ancestry.length === unitIndex + 1) {
    return selection;
  }
  return {
    ...selection,
    ancestry: selection.ancestry.slice(0, unitIndex + 1),
  };
}

function normalizeGameplaySnapshot(
  snapshot: RoszGameplaySnapshot,
): RoszGameplaySnapshot {
  const selections = snapshot.selections
    .map((entry) => JSON.parse(entry) as ParsedSelection)
    .filter((selection) => !isCompositionWrapperSelection(selection))
    .map((selection) => ({
      ...selection,
      ancestry: selection.ancestry.filter(
        (frame) => !isCompositionAncestryFrame(frame),
      ),
    }))
    .map(hoistWarlordAncestry)
    .map((selection) => JSON.stringify(selection))
    .sort();
  return { ...snapshot, selections };
}

function implicitCatalogueCompletions(
  expected: RoszGameplaySnapshot,
  observed: RoszGameplaySnapshot,
): Set<string> {
  const expectedSelections = expected.selections.map((entry) =>
    JSON.parse(entry) as ParsedSelection
  );
  const observedSelections = observed.selections.map((entry) =>
    JSON.parse(entry) as ParsedSelection
  );
  const expectedSemantic = new Set(semanticSelections(expected));
  const ignored = new Set<string>();
  for (const selection of observedSelections) {
    const serialized = JSON.stringify({
      ancestry: selection.ancestry.map(semanticAncestryIdentity),
      entryId: selection.entryId,
      ...(selection.entryId
        ? {}
        : { name: normalizedSelectionName(selection.name) }),
      type: selection.type,
      number: selection.number,
    });
    if (
      expectedSemantic.has(serialized) ||
      selection.type !== "upgrade" ||
      selection.costs.length > 0 ||
      selection.ancestry.length === 0
    ) {
      continue;
    }
    const [parentEntryId = "", parentName = "", parentType = ""] =
      selection.ancestry.at(-1)!.split("|");
    if (normalized(parentType) !== "model") continue;
    const observedParent = observedSelections.find(
      (candidate) =>
        candidate.entryId === parentEntryId &&
        candidate.type === "model" &&
        candidate.number === selection.number,
    );
    const expectedParent = expectedSelections.find(
      (candidate) =>
        candidate.entryId === parentEntryId &&
        candidate.type === "model" &&
        candidate.number === selection.number,
    );
    if (!observedParent || !expectedParent) continue;
    const parentTokens = expandedIdentityTokens(
      parentName || observedParent.name,
    );
    const childTokens = nameTokens(selection.name);
    if (
      childTokens.length > 0 &&
      childTokens.every((child) =>
        parentTokens.some((parent) => oneEditApart(child, parent))
      )
    ) {
      ignored.add(serialized);
    }
  }
  return ignored;
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
  const expectedTree = normalizeGameplaySnapshot(expected);
  const observedTree = normalizeGameplaySnapshot(observed);
  if (
    JSON.stringify(semanticSelections(expectedTree)) !==
    JSON.stringify(
      semanticSelections(observedTree).filter(
        (selection) =>
          !implicitCatalogueCompletions(expectedTree, observedTree).has(
            selection,
          ),
      ),
    )
  ) {
    mismatches.push("selection-tree");
  }
  return mismatches;
}

type CompositionFrame = {
  start: number;
  selfClosing: boolean;
  type: string;
  group: string;
  name: string;
  childTypes: string[];
};

function isUnitCompositionWrapper(
  frame: CompositionFrame,
  parentType: string | undefined,
): boolean {
  if (frame.type !== "upgrade" || parentType !== "unit") return false;
  if (frame.group === "unit composition") return true;
  if (
    frame.childTypes.length > 0 &&
    frame.childTypes.every((child) => child === "model")
  ) {
    return true;
  }
  return frame.selfClosing && looksLikeUnitCompositionName(frame.name);
}

function compositionChildSelections(wrapperXml: string): string {
  const openEnd = wrapperXml.indexOf(">") + 1;
  const closeStart = wrapperXml.lastIndexOf("</selection>");
  if (openEnd <= 0 || closeStart < openEnd) return "";
  const body = wrapperXml.slice(openEnd, closeStart).trim();
  const wrapped = body.match(/^<selections>([\s\S]*)<\/selections>$/i);
  return wrapped ? wrapped[1] : body;
}

/**
 * New Recruit often nests models under a costless "Unit Composition" upgrade.
 * Hoist those models onto the parent unit before Tessera import so weapon and
 * model counts stay on the datasheet Tessera actually compiles.
 */
export function flattenRosXmlUnitCompositionWrappers(xml: string): string {
  let current = xml;
  for (;;) {
    const hoisted = hoistFirstUnitCompositionWrapper(current);
    if (hoisted === null) return current;
    current = hoisted;
  }
}

type TesseraImportSelection = {
  type: string;
  hasUnitProfile: boolean;
  hasCharacter: boolean;
  children: TesseraImportSelection[];
};

function directElementXml(inner: string, tag: string): string | null {
  const tagName = tag.toLocaleLowerCase();
  for (const element of directElements(inner)) {
    if (element.tag.toLocaleLowerCase() === tagName) return element.xml;
  }
  return null;
}

function* directElements(
  inner: string,
): Generator<{ tag: string; xml: string }> {
  const tokenRe =
    /<\/([A-Za-z0-9:-]+)>|<([A-Za-z0-9:-]+)(\s[^>]*)?\/?>/g;
  const stack: string[] = [];
  let start = -1;
  let startTag = "";
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(inner))) {
    if (match[1]) {
      if (stack.length === 1 && start >= 0) {
        yield {
          tag: startTag,
          xml: inner.slice(start, match.index + match[0].length),
        };
        start = -1;
      }
      stack.pop();
      continue;
    }
    const tag = match[2] ?? "";
    const selfClosing = match[0].endsWith("/>");
    if (stack.length === 0) {
      if (selfClosing) {
        yield { tag, xml: match[0] };
        continue;
      }
      start = match.index;
      startTag = tag;
    }
    if (!selfClosing) stack.push(tag);
  }
}

function elementInner(xml: string): string {
  const openEnd = xml.indexOf(">") + 1;
  const closeStart = xml.lastIndexOf("</");
  if (openEnd <= 0 || closeStart < openEnd) return "";
  return xml.slice(openEnd, closeStart);
}

function parseTesseraImportSelection(xml: string): TesseraImportSelection {
  const open = xml.match(/^<selection\b[^>]*>/i)?.[0] ?? "";
  const attrs = attributes(open);
  const inner = elementInner(xml);
  const children: TesseraImportSelection[] = [];
  const selections = directElementXml(inner, "selections");
  if (selections) {
    for (const child of directElements(elementInner(selections))) {
      if (child.tag.toLocaleLowerCase() === "selection") {
        children.push(parseTesseraImportSelection(child.xml));
      }
    }
  }
  const profiles = directElementXml(inner, "profiles") ?? "";
  const categories = directElementXml(inner, "categories") ?? "";
  return {
    type: normalized(attrs.type),
    hasUnitProfile: /<profile\b[^>]*\btypeName="Unit"/i.test(profiles),
    hasCharacter: [...categories.matchAll(/<category\b[^>]*>/gi)].some(
      (tag) => /character/i.test(attributes(tag[0]).name ?? ""),
    ),
    children,
  };
}

function nestedTesseraCharacterUnits(
  node: TesseraImportSelection,
): TesseraImportSelection[] {
  const nested: TesseraImportSelection[] = [];
  const walk = (current: TesseraImportSelection) => {
    for (const child of current.children) {
      if (child.hasUnitProfile) {
        if (child.hasCharacter) nested.push(child);
        else walk(child);
        continue;
      }
      walk(child);
    }
  };
  walk(node);
  return nested;
}

function tesseraWebsiteExtraUnits(
  unit: TesseraImportSelection,
): TesseraImportSelection[] {
  const nestedUnits = nestedTesseraCharacterUnits(unit);
  const characters = nestedUnits.filter((node) => node.hasCharacter);
  if (characters.length === 1 && !unit.hasCharacter) {
    return nestedUnits.filter((node) => !node.hasCharacter);
  }
  return nestedUnits;
}

function tesseraForceSelectionXml(xml: string): string[] {
  const roots: string[] = [];
  const forceRe = /<force\b[^>]*>/gi;
  let forceMatch: RegExpExecArray | null;
  while ((forceMatch = forceRe.exec(xml))) {
    const start = forceMatch.index;
    const innerStart = start + forceMatch[0].length;
    let depth = 1;
    const tokenRe = /<force\b[^>]*>|<\/force>/gi;
    tokenRe.lastIndex = innerStart;
    let token: RegExpExecArray | null;
    let end = xml.length;
    while ((token = tokenRe.exec(xml))) {
      if (token[0].startsWith("</")) {
        depth -= 1;
        if (depth === 0) {
          end = token.index;
          break;
        }
        continue;
      }
      depth += 1;
    }
    const forceInner = xml.slice(innerStart, end);
    const selections = directElementXml(forceInner, "selections");
    const selectionParent = selections ? elementInner(selections) : forceInner;
    for (const child of directElements(selectionParent)) {
      if (child.tag.toLocaleLowerCase() === "selection") {
        roots.push(child.xml);
      }
    }
  }
  return roots;
}

/**
 * Counts units the way Tessera's website ROSZ importer does: each top-level
 * type="unit" or Unit-profile selection, plus nested Character models Tessera
 * splits off when the parent is also Character.
 */
export function countTesseraWebsiteImportUnits(xml: string): number {
  let count = 0;
  const visit = (node: TesseraImportSelection, insideUnit: boolean) => {
    const isUnit = node.type === "unit" || node.hasUnitProfile;
    if (isUnit && !insideUnit) {
      count += 1 + tesseraWebsiteExtraUnits(node).length;
      return;
    }
    for (const child of node.children) visit(child, insideUnit || isUnit);
  };
  for (const root of tesseraForceSelectionXml(xml)) {
    visit(parseTesseraImportSelection(root), false);
  }
  return count;
}

function withoutCharacterCategories(categoriesXml: string): string {
  const open = categoriesXml.match(/^<categories\b[^>]*>/i)?.[0];
  if (!open) return categoriesXml;
  const kept: string[] = [];
  for (const child of directElements(elementInner(categoriesXml))) {
    if (child.tag.toLocaleLowerCase() !== "category") {
      kept.push(child.xml);
      continue;
    }
    const tag = child.xml.match(/^<category\b[^>]*>/i)?.[0] ?? child.xml;
    if (/character/i.test(attributes(tag).name ?? "")) continue;
    kept.push(child.xml);
  }
  return `${open}${kept.join("")}</categories>`;
}

/**
 * Tessera attaches exactly one nested Character as a leader only when the
 * parent unit is not itself Character. New Recruit copies Character onto
 * Command Squad and its Lord Commissar, so Tessera splits the Commissar into
 * an extra imported unit. Drop Character from the parent so the nested model
 * stays attached.
 */
function stripParentCharacterForNestedLeaders(xml: string): string {
  let current = xml;
  for (;;) {
    const next = stripFirstParentCharacterForNestedLeader(current);
    if (next === null) return current;
    current = next;
  }
}

function stripFirstParentCharacterForNestedLeader(xml: string): string | null {
  const tokenRe = /<selection\b[^>]*\/>|<selection\b[^>]*>|<\/selection>/g;
  const stack: Array<{ start: number; type: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml))) {
    const token = match[0];
    if (token === "</selection>") {
      const frame = stack.pop();
      if (!frame || frame.type !== "unit") continue;
      const end = match.index + token.length;
      const unitXml = xml.slice(frame.start, end);
      const parsed = parseTesseraImportSelection(unitXml);
      if (
        !parsed.hasCharacter ||
        nestedTesseraCharacterUnits(parsed).length === 0
      ) {
        continue;
      }
      const inner = elementInner(unitXml);
      const categories = directElementXml(inner, "categories");
      if (!categories) continue;
      const stripped = withoutCharacterCategories(categories);
      if (stripped === categories) continue;
      const absolute = frame.start + unitXml.indexOf(categories);
      return xml.slice(0, absolute) + stripped + xml.slice(absolute + categories.length);
    }
    if (token.endsWith("/>")) continue;
    stack.push({
      start: match.index,
      type: normalized(attributes(token).type),
    });
  }
  return null;
}

export function prepareRosXmlForTesseraImport(xml: string): string {
  return stripParentCharacterForNestedLeaders(
    flattenRosXmlUnitCompositionWrappers(xml),
  );
}

function hoistFirstUnitCompositionWrapper(xml: string): string | null {
  const tokenRe = /<selection\b[^>]*\/>|<selection\b[^>]*>|<\/selection>/g;
  const stack: CompositionFrame[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml))) {
    const token = match[0];
    if (token === "</selection>") {
      const frame = stack.pop();
      if (!frame) continue;
      const parent = stack.at(-1);
      if (isUnitCompositionWrapper(frame, parent?.type)) {
        const end = match.index + token.length;
        return (
          xml.slice(0, frame.start) +
          compositionChildSelections(xml.slice(frame.start, end)) +
          xml.slice(end)
        );
      }
      parent?.childTypes.push(frame.type);
      continue;
    }
    const attrs = attributes(token);
    const frame: CompositionFrame = {
      start: match.index,
      selfClosing: token.endsWith("/>"),
      type: normalized(attrs.type),
      group: normalized(attrs.group),
      name: normalized(attrs.name),
      childTypes: [],
    };
    if (frame.selfClosing) {
      const parent = stack.at(-1);
      if (isUnitCompositionWrapper(frame, parent?.type)) {
        return xml.slice(0, frame.start) + xml.slice(match.index + token.length);
      }
      parent?.childTypes.push(frame.type);
      continue;
    }
    stack.push(frame);
  }
  return null;
}

function rewriteRoszXml(
  content: Uint8Array,
  rewrite: (xml: string) => string,
): Uint8Array {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(content);
  } catch {
    return content;
  }
  const rosterEntries = Object.entries(entries).filter(([name]) =>
    name.toLocaleLowerCase().endsWith(".ros"),
  );
  if (rosterEntries.length !== 1) return content;
  const [name, bytes] = rosterEntries[0];
  const xml = strFromU8(bytes);
  const rewritten = rewrite(xml);
  if (rewritten === xml) return content;
  return zipSync({
    ...entries,
    [name]: strToU8(rewritten),
  });
}

export function flattenRoszUnitCompositionWrappers(
  content: Uint8Array,
): Uint8Array {
  return rewriteRoszXml(content, flattenRosXmlUnitCompositionWrappers);
}

export function prepareRoszForTesseraImport(
  content: Uint8Array,
): Uint8Array {
  return rewriteRoszXml(content, prepareRosXmlForTesseraImport);
}
