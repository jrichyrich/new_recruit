import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

import { strFromU8, unzipSync } from "fflate";

import {
  currentRosterSourceData,
  validateTesseraReadyRosz,
  type ProfilePolicyV1,
  type TesseraSimulationProviderIdentity,
} from "../../lib/rosterpilot";
import type {
  TesseraBrowserInput,
  TesseraBrowserResult,
  TesseraDirection,
  TesseraMetric,
  TesseraPhase,
  TesseraScenario,
  TesseraScenarioCell,
} from "./browser";
import type {
  TesseraSimulationProviderAdapter,
} from "./simulation-provider";
import {
  LOCAL_TESSERA_COMPILER_VERSION,
  verifyLocalTesseraEngineInput,
  type LocalEngineUnit as EngineUnit,
  type LocalEngineValue as EngineValue,
  type LocalEngineWeapon as EngineWeapon,
  type LocalTesseraEngineInput,
  type LocalTesseraEngineUnit,
} from "./local-engine-input";
import {
  profilePolicyHash,
  profilePolicyIdentityMatches,
} from "./profile-policy";
import { localTesseraBaselineSettings } from "./scenario-contract";

export { LOCAL_TESSERA_COMPILER_VERSION } from "./local-engine-input";

type EngineDistributionBucket = {
  value: number;
  count: number;
  pct: number;
};

type EngineSimulationResult = {
  kills: {
    mean: number;
    stdDev: number;
    distribution: EngineDistributionBucket[];
  };
  woundsDealt: {
    mean: number;
    stdDev: number;
    distribution: EngineDistributionBucket[];
  };
  iterations: number;
  seed: number;
};

type TesseraEngineModule = {
  runSimulation: (
    attacker: EngineUnit,
    defender: EngineUnit,
    options: Record<string, unknown>,
  ) => EngineSimulationResult;
};

type XmlProfile = {
  name: string;
  typeName: string;
  characteristics: Record<string, string>;
};

type XmlRule = {
  name: string;
  description: string;
};

type XmlSelection = {
  id: string | null;
  name: string;
  type: string;
  number: number;
  points: number | null;
  categories: string[];
  profiles: XmlProfile[];
  rules: XmlRule[];
  children: XmlSelection[];
};

export type LocalTesseraEngineRoster = {
  schemaVersion: 1;
  compilerVersion: string;
  sourceSha256: string;
  rosterName: string;
  factionName: string;
  units: LocalTesseraEngineUnit[];
  bundleId?: string;
  evaluationMode?: "base-profile-evaluation";
  limitations?: LocalTesseraEngineInput["limitations"];
};

const LEGACY_ENRICHED_ROSZ_COMPILER_VERSION =
  "enriched-rosz-v1" as const;
export const LOCAL_TESSERA_ADAPTER_VERSION =
  "tessera-engine-browser-contract-v1" as const;
export const LOCAL_TESSERA_ENGINE_ITERATIONS = 10_000;

const CAPABILITY_MANIFEST = {
  schemaVersion: 1,
  phases: ["shooting", "fight"],
  metrics: [
    "wipe-probability",
    "half-wipe-probability",
    "mean-kills",
    "mean-damage",
  ],
  unitCharacteristics: [
    "T",
    "SV",
    "W",
    "Invulnerable Save",
    "phase-specific Invulnerable Save",
    "mixed defensive profiles",
  ],
  weaponCharacteristics: [
    "A",
    "BS",
    "WS",
    "S",
    "AP",
    "D",
    "Keywords",
  ],
  unsupported: [
    "attached-units",
    "combat-relevant-datasheet-abilities",
    "army-and-detachment-rules",
    "enhancements",
    "non-weapon-wargear-effects",
    "range-and-distance-dependent-effects",
    "stratagems",
  ],
} as const;

const capabilityManifestSha256 = crypto
  .createHash("sha256")
  .update(JSON.stringify(CAPABILITY_MANIFEST))
  .digest("hex");

export const LOCAL_TESSERA_ENGINE_IDENTITY: Extract<
  TesseraSimulationProviderIdentity,
  { provider: "local-engine" }
> = {
  schemaVersion: 1,
  provider: "local-engine",
  engine: "tessera-engine",
  repository: "Tessera-cmd/tessera-engine",
  commit: "16ab4365bbd97ef592b061c5a9babe5e44f00e80",
  tree: "8842756e6b805018f7c186b34521e3931e79e4d8",
  sourceSha256:
    "a1288b50b5d100ea07428e15b6df6cf3c95d6ee379c8c0f5fc7039ca53438da9",
  adapterVersion: LOCAL_TESSERA_ADAPTER_VERSION,
  compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
  inputSchemaVersion: 1,
  capabilityManifestSha256,
  promotion: "candidate",
  licenseState: "evaluation-only",
};

export const LOCAL_TESSERA_ENGINE_STATUS = {
  available: true,
  simulationReady: true,
  endToEndReady: true,
  promotion: "candidate" as const,
  licenseState: "evaluation-only" as const,
  identity: LOCAL_TESSERA_ENGINE_IDENTITY,
  reason:
    "The pinned AGPL engine is available for explicit evaluation, but written-license and parity promotion gates are not satisfied.",
};

export function localTesseraEngineIsAutoSelectable(): boolean {
  return (
    LOCAL_TESSERA_ENGINE_STATUS.available &&
    LOCAL_TESSERA_ENGINE_STATUS.simulationReady &&
    LOCAL_TESSERA_ENGINE_STATUS.endToEndReady &&
    LOCAL_TESSERA_ENGINE_IDENTITY.promotion === "promoted" &&
    LOCAL_TESSERA_ENGINE_IDENTITY.licenseState === "approved"
  );
}

const DEFAULT_PHASES: TesseraPhase[] = ["shooting", "fight"];
const DEFAULT_METRICS: TesseraMetric[] = [
  "wipe-probability",
  "half-wipe-probability",
  "mean-kills",
  "mean-damage",
];
const DIRECTIONS: TesseraDirection[] = [
  "player-to-opponent",
  "opponent-to-player",
];

const SUPPORTED_KEYWORDS = new Set([
  "ASSAULT",
  "BLAST",
  "CLEAVE",
  "DEVASTATING WOUNDS",
  "EXTRA ATTACKS",
  "HEAVY",
  "IGNORES COVER",
  "INDIRECT FIRE",
  "LANCE",
  "LETHAL HITS",
  "ONE SHOT",
  "PISTOL",
  "PRECISION",
  "PSYCHIC",
  "TORRENT",
  "TWIN-LINKED",
]);
const PARAMETER_KEYWORDS = [
  "BLAST",
  "CLEAVE",
  "MELTA",
  "RAPID FIRE",
  "SUSTAINED HITS",
] as const;
const COMBAT_ABILITY_PATTERN =
  /(?:re-?roll|change|modify|add|subtract|worsen|improve|ignore)[^.<]{0,80}(?:hit|wound|save|damage|attack|ballistic skill|weapon skill)|(?:critical hits?|critical wounds?|devastating wounds|lethal hits|sustained hits|feel no pain|invulnerable save|armour penetration)/i;

function localEngineError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attrs(tag: string): Record<string, string> {
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
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function rosXml(content: Uint8Array): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(content);
  } catch {
    throw localEngineError(
      "TESSERA_LOCAL_INPUT_INVALID",
      "The local engine input is not a readable ROSZ archive.",
    );
  }
  const rosterEntries = Object.entries(entries).filter(([name]) =>
    name.toLocaleLowerCase().endsWith(".ros"),
  );
  if (rosterEntries.length !== 1) {
    throw localEngineError(
      "TESSERA_LOCAL_INPUT_INVALID",
      `The local engine requires exactly one .ros entry; found ${rosterEntries.length}.`,
    );
  }
  return strFromU8(rosterEntries[0][1]);
}

function parseSelections(xml: string): XmlSelection[] {
  const roots: XmlSelection[] = [];
  const selections: XmlSelection[] = [];
  const profiles: XmlProfile[] = [];
  const tokens =
    xml.match(
      /<selection\b[^>]*>|<\/selection>|<profile\b[^>]*>|<\/profile>|<characteristic\b[^>]*>[\s\S]*?<\/characteristic>|<rule\b[^>]*>[\s\S]*?<\/rule>|<category\b[^>]*\/?\s*>|<cost\b[^>]*\/?\s*>/g,
    ) ?? [];

  for (const token of tokens) {
    if (token === "</selection>") {
      selections.pop();
      continue;
    }
    if (token === "</profile>") {
      profiles.pop();
      continue;
    }
    if (token.startsWith("<selection")) {
      const value = attrs(token);
      const node: XmlSelection = {
        id: value.id?.trim() || null,
        name: value.name?.trim() ?? "",
        type: value.type?.trim() ?? "",
        number: Number(value.number ?? 0),
        points: null,
        categories: [],
        profiles: [],
        rules: [],
        children: [],
      };
      const parent = selections.at(-1);
      if (parent) parent.children.push(node);
      else roots.push(node);
      if (!token.endsWith("/>")) selections.push(node);
      continue;
    }
    if (token.startsWith("<profile")) {
      const selection = selections.at(-1);
      if (!selection) continue;
      const value = attrs(token);
      const profile: XmlProfile = {
        name: value.name?.trim() ?? "",
        typeName: value.typeName?.trim() ?? "",
        characteristics: {},
      };
      selection.profiles.push(profile);
      if (!token.endsWith("/>")) profiles.push(profile);
      continue;
    }
    if (token.startsWith("<characteristic")) {
      const profile = profiles.at(-1);
      if (!profile) continue;
      const opening = token.match(/^<characteristic\b[^>]*>/)?.[0];
      if (!opening) continue;
      const name = attrs(opening).name?.trim();
      if (!name) continue;
      const raw = token.slice(opening.length, token.lastIndexOf("</"));
      profile.characteristics[name] = decodeXml(raw).replace(/<[^>]+>/g, "").trim();
      continue;
    }
    const selection = selections.at(-1);
    if (!selection) continue;
    if (token.startsWith("<rule")) {
      const opening = token.match(/^<rule\b[^>]*>/)?.[0];
      if (!opening) continue;
      const ruleAttrs = attrs(opening);
      const descriptions = [
        ...token.matchAll(/<description\b[^>]*>([\s\S]*?)<\/description>/g),
      ].map((match) =>
        decodeXml(match[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      );
      selection.rules.push({
        name: ruleAttrs.name?.trim() ?? "",
        description: descriptions.join(" "),
      });
      continue;
    }
    if (token.startsWith("<category")) {
      const name = attrs(token).name?.trim();
      if (name) selection.categories.push(name);
      continue;
    }
    if (token.startsWith("<cost")) {
      const value = attrs(token);
      if (normalized(value.name ?? "") === "pts") {
        const points = Number(value.value);
        if (Number.isFinite(points)) selection.points = points;
      }
    }
  }
  return roots;
}

function descendants(selection: XmlSelection): XmlSelection[] {
  return [selection, ...selection.children.flatMap(descendants)];
}

function requiredInteger(
  value: string | undefined,
  subject: string,
): number {
  if (!value || !/^-?\d+\+?$/.test(value.trim())) {
    throw localEngineError(
      "TESSERA_LOCAL_CHARACTERISTIC_UNSUPPORTED",
      `${subject} must be a fixed integer characteristic; observed ${JSON.stringify(value ?? null)}.`,
    );
  }
  return Number(value.replace("+", ""));
}

function optionalSave(value: string | undefined, subject: string): number | null {
  if (!value || value.trim() === "-") return null;
  return requiredInteger(value, subject);
}

function diceValue(value: string | undefined, subject: string): EngineValue {
  const candidate = value?.trim().toLocaleUpperCase();
  if (!candidate || !/^(?:\d+|\d*D\d+(?:[+-]\d+)?)$/.test(candidate)) {
    throw localEngineError(
      "TESSERA_LOCAL_CHARACTERISTIC_UNSUPPORTED",
      `${subject} must be a fixed integer or supported dice expression; observed ${JSON.stringify(value ?? null)}.`,
    );
  }
  return /^\d+$/.test(candidate) ? Number(candidate) : candidate;
}

function canonicalKeyword(raw: string): string {
  return raw
    .trim()
    .toLocaleUpperCase()
    .replace(/^TWIN[ -]LINKED$/, "TWIN-LINKED")
    .replace(/\s+/g, " ");
}

function weaponKeywords(value: string | undefined, subject: string): string[] {
  if (!value || value.trim() === "-") return [];
  return value.split(",").map((entry) => {
    const keyword = canonicalKeyword(entry);
    if (/^ANTI-[A-Z][A-Z /-]* [2-6]\+$/.test(keyword)) return keyword;
    if (SUPPORTED_KEYWORDS.has(keyword)) return keyword;
    for (const base of PARAMETER_KEYWORDS) {
      if (new RegExp(`^${base} [1-9]\\d*$`).test(keyword)) return keyword;
    }
    throw localEngineError(
      "TESSERA_LOCAL_KEYWORD_UNSUPPORTED",
      `${subject} uses unsupported keyword ${JSON.stringify(entry.trim())}.`,
    );
  });
}

function characteristic(
  profile: XmlProfile,
  name: string,
): string | undefined {
  const target = normalized(name);
  return Object.entries(profile.characteristics).find(
    ([candidate]) => normalized(candidate) === target,
  )?.[1];
}

function alternateProfileName(
  profileName: string,
  weaponGroup: string,
): string {
  const prefixed = profileName.match(
    /^\s*[➤▶►]\s*(.+?)\s+-\s+(.+?)\s*$/,
  );
  if (
    prefixed &&
    normalized(prefixed[1]) === normalized(weaponGroup)
  ) {
    return prefixed[2].trim();
  }
  for (const delimiter of profileName.matchAll(/\s+-\s+/g)) {
    const index = delimiter.index ?? -1;
    if (index < 0) continue;
    const group = profileName.slice(0, index).trim();
    if (normalized(group) === normalized(weaponGroup)) {
      return profileName
        .slice(index + delimiter[0].length)
        .trim();
    }
  }
  return profileName.trim();
}

function invulnerableSaveFromAbility(
  profile: XmlProfile,
): number | null {
  if (normalized(profile.name) !== "invulnerable save") return null;
  const description = characteristic(profile, "Description")?.trim() ?? "";
  const match = description.match(/^(\d)\+\s+invulnerable save\.?$/i);
  return match ? Number(match[1]) : null;
}

function invulnerableSaveFromRule(rule: XmlRule): number | null {
  const nameMatch = rule.name.match(/^Invulnerable Save\s*\((\d)\+\)$/i);
  if (nameMatch) return Number(nameMatch[1]);
  if (normalized(rule.name) !== "invulnerable save") return null;
  const descriptionMatch = rule.description.match(
    /^(\d)\+\s+invulnerable save\.?$/i,
  );
  return descriptionMatch ? Number(descriptionMatch[1]) : null;
}

function weaponRuleIsRepresented(node: XmlSelection, rule: XmlRule): boolean {
  const weaponProfiles = node.profiles.filter(
    (profile) =>
      profile.typeName === "Ranged Weapons" ||
      profile.typeName === "Melee Weapons",
  );
  if (weaponProfiles.length === 0) return false;
  const ruleName = canonicalKeyword(rule.name);
  return weaponProfiles.some((profile) => {
    try {
      return weaponKeywords(
        characteristic(profile, "Keywords"),
        `${node.name} / ${profile.name}`,
      ).some(
        (keyword) =>
          keyword === ruleName ||
          keyword.startsWith(`${ruleName} `) ||
          ruleName.startsWith(`${keyword} `),
      );
    } catch {
      return false;
    }
  });
}

function profilePolicyChoice(input: {
  policy: ProfilePolicyV1 | null | undefined;
  faction: string;
  unit: string;
  occurrence: number;
  modelCount: number;
  weaponGroup: string;
  phase: TesseraPhase;
  profiles: XmlProfile[];
  activeCount: number;
}): XmlProfile {
  if (input.profiles.length === 1) return input.profiles[0];
  const entries = input.policy?.entries.filter(
    (entry) =>
      normalized(entry.faction) === normalized(input.faction) &&
      normalized(entry.unit) === normalized(input.unit) &&
      normalized(entry.weaponGroup) === normalized(input.weaponGroup) &&
      entry.phase === input.phase &&
      (entry.unitOccurrence === undefined ||
        entry.unitOccurrence === input.occurrence) &&
      (entry.modelCount === undefined || entry.modelCount === input.modelCount),
  ) ?? [];
  if (entries.length !== 1 || entries[0].activeCount !== input.activeCount) {
    throw localEngineError(
      "TESSERA_LOCAL_PROFILE_POLICY_REQUIRED",
      `${input.unit} / ${input.weaponGroup} / ${input.phase} has ${input.profiles.length} profiles and requires one exact frozen profile-policy entry.`,
    );
  }
  const selected = input.profiles.filter(
    (profile) =>
      normalized(profile.name) === normalized(entries[0].selectedProfile) ||
      normalized(
        alternateProfileName(profile.name, input.weaponGroup),
      ) === normalized(entries[0].selectedProfile),
  );
  if (selected.length !== 1) {
    throw localEngineError(
      "TESSERA_LOCAL_PROFILE_POLICY_INVALID",
      `${input.unit} / ${input.weaponGroup} / ${input.phase} does not contain the selected profile ${entries[0].selectedProfile}.`,
    );
  }
  return selected[0];
}

function modelCount(selection: XmlSelection): number {
  if (selection.type === "model") return selection.number;
  const models = descendants(selection)
    .slice(1)
    .filter((node) => node.type === "model")
    .reduce((sum, node) => sum + node.number, 0);
  return models > 0 ? models : selection.number;
}

function compileUnit(
  selection: XmlSelection,
  faction: string,
  occurrence: number,
  policy: ProfilePolicyV1 | null | undefined,
): LocalTesseraEngineUnit {
  const nodes = descendants(selection);
  const count = modelCount(selection);
  if (!Number.isInteger(count) || count <= 0) {
    throw localEngineError(
      "TESSERA_LOCAL_UNIT_INVALID",
      `${selection.name} has an invalid selected model count.`,
    );
  }
  const unitProfiles = nodes.flatMap((node) =>
    node.profiles.filter((profile) => profile.typeName === "Unit"),
  );
  const distinctUnitProfiles = new Map(
    unitProfiles.map((profile) => [
      JSON.stringify(profile.characteristics),
      profile,
    ]),
  );
  if (distinctUnitProfiles.size !== 1) {
    throw localEngineError(
      "TESSERA_LOCAL_MIXED_DEFENSIVE_PROFILE_UNSUPPORTED",
      `${selection.name} exposes ${distinctUnitProfiles.size} distinct defensive profiles; the candidate adapter requires one.`,
    );
  }
  const unitProfile = [...distinctUnitProfiles.values()][0];
  const invulnerableSaves = [
    optionalSave(
      characteristic(unitProfile, "InSv") ??
        characteristic(unitProfile, "Invulnerable Save"),
      `${selection.name} Invulnerable Save`,
    ),
    ...nodes.flatMap((node) => [
      ...node.profiles.map(invulnerableSaveFromAbility),
      ...node.rules.map(invulnerableSaveFromRule),
    ]),
  ].filter((value): value is number => value !== null);
  const distinctInvulnerableSaves = [...new Set(invulnerableSaves)];
  if (distinctInvulnerableSaves.length > 1) {
    throw localEngineError(
      "TESSERA_LOCAL_MIXED_DEFENSIVE_PROFILE_UNSUPPORTED",
      `${selection.name} exposes multiple invulnerable-save values: ${distinctInvulnerableSaves.join(", ")}.`,
    );
  }
  const combatAbilities = nodes
    .flatMap((node) =>
      node.profiles.filter((profile) => profile.typeName === "Abilities"),
    )
    .filter(
      (profile) =>
        invulnerableSaveFromAbility(profile) === null &&
        COMBAT_ABILITY_PATTERN.test(
          characteristic(profile, "Description") ?? "",
        ),
    );
  if (combatAbilities.length > 0) {
    throw localEngineError(
      "TESSERA_LOCAL_ACTIVE_ABILITY_UNSUPPORTED",
      `${selection.name} has combat-relevant abilities outside the pinned engine capability: ${combatAbilities.map((profile) => profile.name).join(", ")}.`,
    );
  }
  const unsupportedRules = nodes.flatMap((node) =>
    node.rules
      .filter(
        (rule) =>
          COMBAT_ABILITY_PATTERN.test(rule.description) &&
          invulnerableSaveFromRule(rule) === null &&
          !weaponRuleIsRepresented(node, rule),
      )
      .map((rule) => rule.name || "unnamed rule"),
  );
  if (unsupportedRules.length > 0) {
    throw localEngineError(
      "TESSERA_LOCAL_ACTIVE_RULE_UNSUPPORTED",
      `${selection.name} has combat-relevant selected rules outside the pinned engine capability: ${unsupportedRules.join(", ")}.`,
    );
  }
  const weaponGroups = nodes.flatMap((node) => {
    const ranged = node.profiles.filter(
      (profile) => profile.typeName === "Ranged Weapons",
    );
    const melee = node.profiles.filter(
      (profile) => profile.typeName === "Melee Weapons",
    );
    return [
      ...(ranged.length > 0
        ? [{ node, phase: "shooting" as const, profiles: ranged }]
        : []),
      ...(melee.length > 0
        ? [{ node, phase: "fight" as const, profiles: melee }]
        : []),
    ];
  });
  const compiledWeapons: EngineWeapon[] = [];
  for (const group of weaponGroups) {
    const activeCount = group.node.number;
    if (!Number.isInteger(activeCount) || activeCount <= 0) {
      throw localEngineError(
        "TESSERA_LOCAL_WEAPON_COUNT_INVALID",
        `${selection.name} / ${group.node.name} has an invalid active weapon count.`,
      );
    }
    const selected = profilePolicyChoice({
      policy,
      faction,
      unit: selection.name,
      occurrence,
      modelCount: count,
      weaponGroup: group.node.name || group.profiles[0].name,
      phase: group.phase,
      profiles: group.profiles,
      activeCount,
    });
    const characteristics = selected.characteristics;
    const allowed = new Set([
      "Range",
      "A",
      group.phase === "shooting" ? "BS" : "WS",
      "S",
      "AP",
      "D",
      "Keywords",
    ]);
    const unknown = Object.keys(characteristics).filter(
      (name) =>
        ![...allowed].some(
          (allowedName) => normalized(allowedName) === normalized(name),
        ),
    );
    if (unknown.length > 0) {
      throw localEngineError(
        "TESSERA_LOCAL_CHARACTERISTIC_UNSUPPORTED",
        `${selection.name} / ${selected.name} has unsupported characteristics: ${unknown.join(", ")}.`,
      );
    }
    compiledWeapons.push({
      name: selected.name,
      type: group.phase === "shooting" ? "ranged" : "melee",
      count: activeCount,
      A: diceValue(characteristic(selected, "A"), `${selection.name} / ${selected.name} A`),
      ...(group.phase === "shooting"
        ? {
            BS: requiredInteger(
              characteristic(selected, "BS"),
              `${selection.name} / ${selected.name} BS`,
            ),
          }
        : {
            WS: requiredInteger(
              characteristic(selected, "WS"),
              `${selection.name} / ${selected.name} WS`,
            ),
          }),
      S: requiredInteger(characteristic(selected, "S"), `${selection.name} / ${selected.name} S`),
      AP: requiredInteger(characteristic(selected, "AP"), `${selection.name} / ${selected.name} AP`),
      D: diceValue(characteristic(selected, "D"), `${selection.name} / ${selected.name} D`),
      keywords: weaponKeywords(
        characteristic(selected, "Keywords"),
        `${selection.name} / ${selected.name}`,
      ),
    });
  }
  if (compiledWeapons.length === 0) {
    throw localEngineError(
      "TESSERA_LOCAL_WEAPON_PROFILE_MISSING",
      `${selection.name} has no supported active weapon profile.`,
    );
  }
  const weapons = [
    ...new Map(
      compiledWeapons.map((weapon) => {
        const key = JSON.stringify({ ...weapon, count: undefined });
        return [key, weapon] as const;
      }),
    ).values(),
  ];
  for (const weapon of weapons) {
    weapon.count = compiledWeapons
      .filter(
        (candidate) =>
          JSON.stringify({ ...candidate, count: undefined }) ===
          JSON.stringify({ ...weapon, count: undefined }),
      )
      .reduce((sum, candidate) => sum + candidate.count, 0);
  }
  const rangedWeapons = weapons.filter((weapon) => weapon.type === "ranged");
  if (
    rangedWeapons.some((weapon) => weapon.keywords.includes("PISTOL")) &&
    rangedWeapons.some((weapon) => !weapon.keywords.includes("PISTOL"))
  ) {
    throw localEngineError(
      "TESSERA_LOCAL_WEAPON_CHOICE_UNSUPPORTED",
      `${selection.name} has both PISTOL and non-PISTOL ranged weapons; the aggregate compiler cannot prove which models may fire each option.`,
    );
  }
  const ordinaryMeleeWeaponCount = weapons
    .filter(
      (weapon) =>
        weapon.type === "melee" &&
        !weapon.keywords.includes("EXTRA ATTACKS"),
    )
    .reduce((sum, weapon) => sum + weapon.count, 0);
  if (ordinaryMeleeWeaponCount > count) {
    throw localEngineError(
      "TESSERA_LOCAL_WEAPON_CHOICE_UNSUPPORTED",
      `${selection.name} has ${ordinaryMeleeWeaponCount} ordinary melee weapon selections across ${count} models; the aggregate compiler cannot prove the one-weapon-per-model choice.`,
    );
  }
  const categories = [
    ...new Set(
      nodes
        .flatMap((node) => node.categories)
        .map((category) => category.replace(/^Faction:\s*/i, "").toLocaleUpperCase()),
    ),
  ];
  const points =
    selection.points ??
    selection.children.reduce(
      (sum, node) => sum + (node.points ?? 0),
      0,
    );
  const instanceId = crypto
    .createHash("sha256")
    .update(
      [selection.id ?? selection.name, normalized(selection.name), count, occurrence].join("|"),
    )
    .digest("hex")
    .slice(0, 24);
  return {
    instanceId,
    selectionId: selection.id ?? instanceId,
    occurrence,
    label: selection.name,
    name: selection.name,
    models: count,
    T: requiredInteger(characteristic(unitProfile, "T"), `${selection.name} T`),
    SV: requiredInteger(characteristic(unitProfile, "SV"), `${selection.name} SV`),
    W: requiredInteger(characteristic(unitProfile, "W"), `${selection.name} W`),
    INV: distinctInvulnerableSaves[0] ?? null,
    FNP: null,
    ...(points > 0 ? { points } : {}),
    keywords: categories,
    weapons,
  };
}

export function compileEnrichedRoszForLocalEngine(
  content: Uint8Array,
  profilePolicy?: ProfilePolicyV1 | null,
): LocalTesseraEngineRoster {
  validateTesseraReadyRosz(content);
  const xml = rosXml(content);
  const rosterTag = xml.match(/<roster\b[^>]*>/)?.[0];
  const forceTag = xml.match(/<force\b[^>]*>/)?.[0];
  if (!rosterTag || !forceTag) {
    throw localEngineError(
      "TESSERA_LOCAL_INPUT_INVALID",
      "The enriched ROSZ has no roster or force identity.",
    );
  }
  const rosterName = attrs(rosterTag).name?.trim() ?? "";
  const force = attrs(forceTag);
  const factionName = force.catalogueName?.trim() || force.name?.trim() || "";
  const roots = parseSelections(xml).filter(
    (selection) => selection.type === "unit" || selection.type === "model",
  );
  if (roots.length === 0) {
    throw localEngineError(
      "TESSERA_LOCAL_UNIT_PROFILE_MISSING",
      "The enriched ROSZ has no top-level unit selections.",
    );
  }
  const occurrenceByIdentity = new Map<string, number>();
  const units = roots.map((selection) => {
    const key = `${normalized(selection.name)}|${modelCount(selection)}`;
    const occurrence = (occurrenceByIdentity.get(key) ?? 0) + 1;
    occurrenceByIdentity.set(key, occurrence);
    return compileUnit(selection, factionName, occurrence, profilePolicy);
  });
  return {
    schemaVersion: 1,
    compilerVersion: LEGACY_ENRICHED_ROSZ_COMPILER_VERSION,
    sourceSha256: crypto.createHash("sha256").update(content).digest("hex"),
    rosterName,
    factionName,
    units,
  };
}

function rosterFromLocalInput(
  content: Uint8Array,
  expected: Extract<
    NonNullable<TesseraBrowserInput["playerSimulationInput"]>,
    { kind: "rosterpilot-local-engine-input" }
  >,
  profilePolicy: ProfilePolicyV1 | null | undefined,
): LocalTesseraEngineRoster {
  const parsed = verifyLocalTesseraEngineInput({
    content,
    expectedSha256: expected.sha256,
    expectedBundleId: expected.bundleId,
  });
  if (parsed.compilerVersion !== expected.compilerVersion) {
    throw localEngineError(
      "TESSERA_LOCAL_COMPILER_VERSION_CHANGED",
      `The frozen local input was compiled by ${parsed.compilerVersion}, not ${expected.compilerVersion}.`,
    );
  }
  const scopedProfilePolicy = profilePolicy
    ? {
        ...profilePolicy,
        entries: profilePolicy.entries.filter((entry) =>
          parsed.profileRequirements.some((requirement) =>
            profilePolicyIdentityMatches(entry, requirement),
          ),
        ),
      }
    : null;
  const expectedProfilePolicySha256 = scopedProfilePolicy
    ? profilePolicyHash(scopedProfilePolicy)
    : null;
  if (parsed.profilePolicySha256 !== expectedProfilePolicySha256) {
    throw localEngineError(
      "TESSERA_LOCAL_PROFILE_POLICY_CHANGED",
      "The local input was not compiled with the roster-scoped profile policy frozen for this run.",
    );
  }
  const activeBundleId = currentRosterSourceData(
    parsed.factionId,
  ).bundleId;
  if (activeBundleId !== parsed.bundleId) {
    throw localEngineError(
      "TESSERA_LOCAL_BUNDLE_MISMATCH",
      `The local input is pinned to bundle ${parsed.bundleId}, but bundle ${activeBundleId} is active.`,
    );
  }
  return {
    schemaVersion: 1,
    compilerVersion: parsed.compilerVersion,
    sourceSha256: expected.sha256,
    rosterName: parsed.rosterName,
    factionName: parsed.factionName,
    units: parsed.units,
    bundleId: parsed.bundleId,
    evaluationMode: parsed.evaluationMode,
    limitations: parsed.limitations,
  };
}

async function loadRosterForLocalEngine(
  filename: string,
  simulationInput: TesseraBrowserInput["playerSimulationInput"],
  profilePolicy?: ProfilePolicyV1 | null,
): Promise<LocalTesseraEngineRoster> {
  const content = await readFile(filename);
  return simulationInput?.kind === "rosterpilot-local-engine-input"
    ? rosterFromLocalInput(content, simulationInput, profilePolicy)
    : compileEnrichedRoszForLocalEngine(content, profilePolicy);
}

function phaseDefender(
  unit: LocalTesseraEngineUnit,
  phase: TesseraPhase,
): LocalTesseraEngineUnit {
  const scopedInvulnerable =
    phase === "shooting" ? unit.rangedINV : unit.meleeINV;
  const profiles = unit.profiles?.map((profile) => {
    const scoped =
      phase === "shooting"
        ? profile.rangedINV
        : profile.meleeINV;
    return { ...profile, INV: scoped ?? profile.INV };
  });
  return {
    ...unit,
    INV: scopedInvulnerable ?? unit.INV,
    ...(profiles ? { profiles } : {}),
  };
}

function localInputWarnings(
  side: "player" | "opponent",
  roster: LocalTesseraEngineRoster,
): string[] {
  if (!roster.limitations) return [];
  const abilities = roster.limitations.omittedDatasheetAbilities.reduce(
    (count, item) => count + item.abilityNames.length,
    0,
  );
  const wargear = roster.limitations.omittedWargear.length;
  const enhancements = roster.limitations.omittedEnhancements.length;
  const keywords = roster.limitations.unsupportedWeaponKeywords.length;
  const choices = roster.limitations.frozenChoices.length;
  return [
    `The ${side} roster was compiled from frozen bundle ${roster.bundleId ?? "unknown"} in base-profile-evaluation mode. Unmodeled systems: ${roster.limitations.unmodeledSystems.join(", ")}.`,
    ...(abilities > 0
      ? [`The ${side} local input records ${abilities} omitted datasheet ability reference${abilities === 1 ? "" : "s"}.`]
      : []),
    ...(wargear > 0
      ? [`The ${side} local input records ${wargear} selected non-weapon wargear effect${wargear === 1 ? "" : "s"} that the engine did not apply.`]
      : []),
    ...(enhancements > 0
      ? [`The ${side} local input records ${enhancements} selected enhancement${enhancements === 1 ? "" : "s"} that the engine did not apply.`]
      : []),
    ...(keywords > 0
      ? [`The ${side} local input records ${keywords} intrinsic weapon keyword${keywords === 1 ? "" : "s"} outside the pinned adapter capability; they were not applied.`]
      : []),
    ...(choices > 0
      ? [`The ${side} local input freezes ${choices} explicit profile, attack-set, or mixed-defence choice${choices === 1 ? "" : "s"}; inspect the hashed input for details.`]
      : []),
  ];
}

function probabilityAtLeast(
  distribution: EngineDistributionBucket[],
  threshold: number,
): number {
  const total = distribution.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total <= 0) return 0;
  return (
    distribution
      .filter((bucket) => bucket.value >= threshold)
      .reduce((sum, bucket) => sum + bucket.count, 0) / total
  );
}

function seedFor(...values: string[]): number {
  return Number.parseInt(
    crypto.createHash("sha256").update(values.join("|")).digest("hex").slice(0, 8),
    16,
  ) >>> 0;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function engineOptions(
  phase: TesseraPhase,
  settings: Record<string, string>,
  iterations: number,
  seed: number,
): Record<string, unknown> {
  const supportedSettings = new Set([
    "provider",
    "phase",
    "targetInCover",
    "charging",
    "withinRapidFireRange",
    "withinMeltaRange",
    "remainedStationary",
    "indirectFire",
  ]);
  const unknownSettings = Object.keys(settings).filter(
    (name) => !supportedSettings.has(name),
  );
  if (unknownSettings.length > 0) {
    throw localEngineError(
      "TESSERA_LOCAL_SETTING_UNSUPPORTED",
      `The local engine does not support frozen setting(s): ${unknownSettings.join(", ")}.`,
    );
  }
  if (settings.provider !== undefined && settings.provider !== "local-engine") {
    throw localEngineError(
      "TESSERA_LOCAL_SETTING_UNSUPPORTED",
      `The frozen provider setting must be local-engine; observed ${JSON.stringify(settings.provider)}.`,
    );
  }
  if (settings.phase !== undefined && settings.phase !== phase) {
    throw localEngineError(
      "TESSERA_LOCAL_SETTING_UNSUPPORTED",
      `The frozen phase setting must be ${phase}; observed ${JSON.stringify(settings.phase)}.`,
    );
  }
  const boolean = (name: string, fallback: boolean) => {
    const value = settings[name];
    if (value === undefined) return fallback;
    if (value !== "true" && value !== "false") {
      throw localEngineError(
        "TESSERA_LOCAL_SETTING_UNSUPPORTED",
        `Local engine setting ${name} must be true or false.`,
      );
    }
    return value === "true";
  };
  return {
    phase: phase === "shooting" ? "ranged" : "melee",
    iterations,
    seed,
    targetInCover: boolean("targetInCover", false),
    charging: boolean("charging", phase === "fight"),
    withinRapidFireRange: boolean("withinRapidFireRange", false),
    withinMeltaRange: boolean("withinMeltaRange", false),
    remainedStationary: boolean("remainedStationary", false),
    indirectFire: boolean("indirectFire", false),
  };
}

function metricValue(
  metric: TesseraMetric,
  result: EngineSimulationResult,
  defender: LocalTesseraEngineUnit,
): number {
  if (metric === "wipe-probability") {
    return probabilityAtLeast(result.kills.distribution, defender.models);
  }
  if (metric === "half-wipe-probability") {
    return probabilityAtLeast(
      result.kills.distribution,
      Math.ceil(defender.models / 2),
    );
  }
  if (metric === "mean-kills") return result.kills.mean;
  return result.woundsDealt.mean;
}

function metricUncertainty(
  metric: TesseraMetric,
  value: number,
  result: EngineSimulationResult,
): NonNullable<TesseraScenarioCell["uncertainty"]> {
  const standardDeviation =
    metric === "mean-kills"
      ? result.kills.stdDev
      : metric === "mean-damage"
        ? result.woundsDealt.stdDev
        : Math.sqrt(Math.max(0, value * (1 - value)));
  return {
    sampleCount: result.iterations,
    standardDeviation,
    standardError: standardDeviation / Math.sqrt(result.iterations),
    completeness: "complete",
  };
}

function scenarioCell(
  metric: TesseraMetric,
  value: number,
  result: EngineSimulationResult,
  attacker: LocalTesseraEngineUnit,
  target: LocalTesseraEngineUnit,
  attackerIndex: number,
  targetIndex: number,
  direction: TesseraDirection,
): TesseraScenarioCell {
  return {
    attacker: attacker.label,
    target: target.label,
    direction,
    killProbability:
      metric === "wipe-probability" ? value : null,
    expectedDamage: metric === "mean-damage" ? value : null,
    damagePer100Points:
      metric === "mean-damage" && attacker.points
        ? (value / attacker.points) * 100
        : null,
    attackerIndex,
    targetIndex,
    attackerOccurrence: attacker.occurrence,
    targetOccurrence: target.occurrence,
    metricValue: value,
    uncertainty: metricUncertainty(metric, value, result),
    seed: result.seed,
    executionSha256: crypto
      .createHash("sha256")
      .update(
        stable({
          attacker: attacker.instanceId,
          target: target.instanceId,
          iterations: result.iterations,
          seed: result.seed,
        }),
      )
      .digest("hex"),
  };
}

export async function runLocalTesseraEngineMatchup(
  input: TesseraBrowserInput,
): Promise<TesseraBrowserResult> {
  const [engine, player, opponent] = await Promise.all([
    import("tessera-engine") as Promise<TesseraEngineModule>,
    loadRosterForLocalEngine(
      input.playerSimulationInput?.kind ===
        "rosterpilot-local-engine-input"
        ? input.playerSimulationInput.path
        : input.playerRoszPath,
      input.playerSimulationInput,
      input.profilePolicy,
    ),
    loadRosterForLocalEngine(
      input.opponentSimulationInput?.kind ===
        "rosterpilot-local-engine-input"
        ? input.opponentSimulationInput.path
        : input.opponentRoszPath,
      input.opponentSimulationInput,
      input.profilePolicy,
    ),
  ]);
  const phases = (input.phases ? [...input.phases] : DEFAULT_PHASES) as TesseraPhase[];
  const metrics = (input.metrics ? [...input.metrics] : DEFAULT_METRICS) as TesseraMetric[];
  const sourceIdentity = `${player.sourceSha256}|${opponent.sourceSha256}`;
  const scenarios: TesseraScenario[] = [];
  const legacyCells = new Map<string, TesseraBrowserResult["cells"][number]>();
  const simulationCache = new Map<string, EngineSimulationResult>();

  for (const phase of phases) {
    for (const direction of DIRECTIONS) {
      const attackers =
        direction === "player-to-opponent" ? player.units : opponent.units;
      const targets =
        direction === "player-to-opponent" ? opponent.units : player.units;
      for (const metric of metrics) {
        const frozen = input.frozenScenarioContract?.find(
          (contract) =>
            contract.phase === phase &&
            contract.direction === direction &&
            contract.metric === metric,
        );
        if (input.frozenScenarioContract && !frozen) {
          throw localEngineError(
            "TESSERA_SETTINGS_CHANGED",
            `The frozen run has no local-engine contract for ${phase}/${direction}/${metric}.`,
          );
        }
        const iterations = frozen?.iterations ?? LOCAL_TESSERA_ENGINE_ITERATIONS;
        if (!Number.isInteger(iterations) || iterations <= 0) {
          throw localEngineError(
            "TESSERA_LOCAL_ITERATIONS_INVALID",
            `The local engine requires a positive iteration count for ${phase}/${direction}/${metric}.`,
          );
        }
        const settings = frozen
          ? { ...frozen.settings }
          : localTesseraBaselineSettings(phase);
        const cells: TesseraScenarioCell[] = [];
        for (const [attackerIndex, attacker] of attackers.entries()) {
          for (const [targetIndex, target] of targets.entries()) {
            const cacheKey = stable({
              phase,
              direction,
              attacker: attacker.instanceId,
              target: target.instanceId,
              settings,
              iterations,
            });
            let result = simulationCache.get(cacheKey);
            if (!result) {
              const seed = seedFor(sourceIdentity, cacheKey);
              result = engine.runSimulation(
                attacker,
                phaseDefender(target, phase),
                engineOptions(phase, settings, iterations, seed),
              );
              simulationCache.set(cacheKey, result);
            }
            const value = metricValue(metric, result, target);
            const cell = scenarioCell(
              metric,
              value,
              result,
              attacker,
              target,
              attackerIndex,
              targetIndex,
              direction,
            );
            cells.push(cell);
            const legacyKey = `${direction}|${attackerIndex}|${targetIndex}`;
            const prior = legacyCells.get(legacyKey) ?? {
              attacker: attacker.label,
              target: target.label,
              direction,
              killProbability: null,
              expectedDamage: null,
              damagePer100Points: null,
            };
            if (metric === "wipe-probability") prior.killProbability = value;
            if (metric === "mean-damage") {
              prior.expectedDamage = value;
              prior.damagePer100Points = attacker.points
                ? (value / attacker.points) * 100
                : null;
            }
            legacyCells.set(legacyKey, prior);
          }
        }
        const matrixSha256 = crypto
          .createHash("sha256")
          .update(stable({ phase, direction, metric, settings, iterations, cells }))
          .digest("hex");
        const scenarioSeed = seedFor(
          sourceIdentity,
          phase,
          direction,
          stable(settings),
          String(iterations),
        );
        const executionSha256 = crypto
          .createHash("sha256")
          .update(
            stable(
              cells.map((cell) =>
                (cell as TesseraScenarioCell & { executionSha256?: string })
                  .executionSha256,
              ),
            ),
          )
          .digest("hex");
        scenarios.push({
          id: `${phase}:${direction}:${metric}`,
          phase,
          direction,
          metric,
          settings,
          iterations,
          seed: scenarioSeed,
          executionSha256,
          projectionSha256: matrixSha256,
          cells,
          matrixSha256,
          integrity: {
            status: "trusted",
            issueCodes: [],
            aliasedScenarioIds: [],
          },
        });
      }
    }
  }
  return {
    uiIdentity: null,
    legacyProjection: {
      status:
        metrics.includes("wipe-probability") || metrics.includes("mean-damage")
          ? "derived"
          : "unavailable",
      phase: phases[0] ?? null,
      metric: metrics[0] ?? null,
      scenarioIds: scenarios.map((scenario) => scenario.id),
    },
    settings: {
      provider: "local-engine",
      engineCommit: LOCAL_TESSERA_ENGINE_IDENTITY.commit,
      compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
      inputMode:
        player.evaluationMode === "base-profile-evaluation" &&
        opponent.evaluationMode === "base-profile-evaluation"
          ? "base-profile-evaluation"
          : "legacy-enriched-rosz",
      iterations: String(LOCAL_TESSERA_ENGINE_ITERATIONS),
    },
    cells: [...legacyCells.values()],
    scenarios,
    importWarnings: { player: [], opponent: [] },
    importIssues: [],
    integrityIssues: [],
    warnings: [
      "The local tessera-engine route is evaluation-only and models only its declared capability manifest; it is not eligible for automatic coaching or production promotion.",
      ...localInputWarnings("player", player),
      ...localInputWarnings("opponent", opponent),
    ],
  };
}

export function createLocalTesseraEngineProvider(
  run: typeof runLocalTesseraEngineMatchup = runLocalTesseraEngineMatchup,
): TesseraSimulationProviderAdapter<
  TesseraBrowserInput,
  TesseraBrowserResult
> {
  return {
    backend: "local-engine",
    async getStatus() {
      let available = true;
      try {
        await import("tessera-engine");
      } catch {
        available = false;
      }
      return {
        backend: "local-engine",
        available,
        promoted: LOCAL_TESSERA_ENGINE_IDENTITY.promotion === "promoted",
        evaluationOnly:
          LOCAL_TESSERA_ENGINE_IDENTITY.licenseState !== "approved",
        identity: LOCAL_TESSERA_ENGINE_IDENTITY,
        reasonCodes: [
          ...(!available ? ["TESSERA_LOCAL_ENGINE_UNAVAILABLE"] : []),
          "TESSERA_LOCAL_ENGINE_EVALUATION_ONLY",
          "TESSERA_LOCAL_ENGINE_LICENSE_GRANT_REQUIRED",
        ],
      };
    },
    async preflight(input) {
      try {
        await Promise.all([
          loadRosterForLocalEngine(
            input.playerSimulationInput?.kind ===
              "rosterpilot-local-engine-input"
              ? input.playerSimulationInput.path
              : input.playerRoszPath,
            input.playerSimulationInput,
            input.profilePolicy,
          ),
          loadRosterForLocalEngine(
            input.opponentSimulationInput?.kind ===
              "rosterpilot-local-engine-input"
              ? input.opponentSimulationInput.path
              : input.opponentRoszPath,
            input.opponentSimulationInput,
            input.profilePolicy,
          ),
        ]);
        return {
          ok: true,
          reasonCodes: [],
          warnings: [
            "The local engine is an explicit evaluation candidate and is not auto-promoted.",
          ],
        };
      } catch (error) {
        return {
          ok: false,
          reasonCodes: [
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : "TESSERA_LOCAL_ENGINE_PREFLIGHT_FAILED",
          ],
          warnings: [
            error instanceof Error
              ? error.message
              : "The local engine could not compile the complete matchup input.",
          ],
        };
      }
    },
    async run(input) {
      return {
        identity: LOCAL_TESSERA_ENGINE_IDENTITY,
        data: await run(input),
      };
    },
  };
}
