import crypto from "node:crypto";

import { groupLoadout } from "@alpaca-software/40kdc-data";
import { z } from "zod";

import {
  currentRosterSourceData,
  resolveFactionUnit,
  rosterExecutionFingerprint,
  type ProfilePolicyV1,
  type RosterDraftV1,
  type TesseraPhase,
  type TesseraProfileRequirement,
} from "../../lib/rosterpilot";
import { dataset } from "../../lib/rosterpilot/runtime-dataset";
import {
  aggregateProfileRequirements,
  normalizeProfileIdentity,
  profilePolicyHash,
  profilePolicyIdentityMatches,
  validateProfilePolicy,
} from "./profile-policy";

export const LOCAL_TESSERA_COMPILER_VERSION =
  "base-profile-evaluation-v1" as const;

export type LocalEngineValue = number | string;

export type LocalEngineWeapon = {
  name: string;
  type: "ranged" | "melee";
  count: number;
  A: LocalEngineValue;
  BS?: number;
  WS?: number;
  S: number;
  AP: number;
  D: LocalEngineValue;
  keywords: string[];
};

export type LocalEngineDefensiveProfile = {
  name?: string;
  count: number;
  T: number;
  SV: number;
  W: number;
  INV: number | null;
  FNP: number | null;
  rangedINV?: number | null;
  meleeINV?: number | null;
};

export type LocalEngineUnit = {
  name: string;
  models: number;
  T: number;
  SV: number;
  W: number;
  INV: number | null;
  FNP: number | null;
  rangedINV?: number | null;
  meleeINV?: number | null;
  points?: number;
  keywords: string[];
  weapons: LocalEngineWeapon[];
  profiles?: LocalEngineDefensiveProfile[];
};

export type LocalTesseraEngineUnit = LocalEngineUnit & {
  instanceId: string;
  selectionId: string;
  occurrence: number;
  label: string;
};

export type LocalTesseraEngineInput = {
  schemaVersion: 1;
  kind: "rosterpilot-local-engine-input";
  compilerVersion: typeof LOCAL_TESSERA_COMPILER_VERSION;
  evaluationMode: "base-profile-evaluation";
  bundleId: string;
  rosterId: string;
  rosterFingerprint: string;
  rosterName: string;
  factionId: string;
  factionName: string;
  totalPoints: number;
  profilePolicySha256: string | null;
  profileRequirements: TesseraProfileRequirement[];
  units: LocalTesseraEngineUnit[];
  limitations: {
    unmodeledSystems: string[];
    omittedDatasheetAbilities: Array<{
      selectionId: string;
      unitName: string;
      abilityNames: string[];
    }>;
    omittedWargear: Array<{
      selectionId: string;
      unitName: string;
      itemId: string;
      itemName: string;
      count: number;
    }>;
    omittedEnhancements: Array<{
      selectionId: string;
      unitName: string;
      enhancementId: string;
      enhancementName: string;
    }>;
    unsupportedWeaponKeywords: Array<{
      selectionId: string;
      unitName: string;
      weaponName: string;
      keyword: string;
    }>;
    frozenChoices: Array<{
      selectionId: string;
      unitName: string;
      phase: TesseraPhase | "defence";
      kind:
        | "alternate-profile"
        | "pistol-or-other"
        | "ordinary-melee"
        | "mixed-defensive-profile";
      selected: string[];
      omitted: string[];
      reason: string;
    }>;
  };
};

const SHA256 = /^[0-9a-f]{64}$/;
const EngineValueSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d*D\d+(?:[+-]\d+)?$/i),
]);
const EngineWeaponSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["ranged", "melee"]),
  count: z.number().int().positive(),
  A: EngineValueSchema,
  BS: z.number().int().positive().optional(),
  WS: z.number().int().positive().optional(),
  S: z.number().int().nonnegative(),
  AP: z.number().int(),
  D: EngineValueSchema,
  keywords: z.array(z.string().min(1)),
}).strict().superRefine((weapon, context) => {
  const torrent = weapon.keywords.includes("TORRENT");
  if (weapon.type === "ranged") {
    if (weapon.WS !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["WS"],
        message: "A ranged weapon cannot declare Weapon Skill.",
      });
    }
    if (weapon.BS === undefined && !torrent) {
      context.addIssue({
        code: "custom",
        path: ["BS"],
        message:
          "A ranged weapon requires Ballistic Skill unless it has TORRENT.",
      });
    }
  } else {
    if (weapon.BS !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["BS"],
        message: "A melee weapon cannot declare Ballistic Skill.",
      });
    }
    if (weapon.WS === undefined) {
      context.addIssue({
        code: "custom",
        path: ["WS"],
        message: "A melee weapon requires Weapon Skill.",
      });
    }
  }
  const seenKeywords = new Set<string>();
  for (const [index, keyword] of weapon.keywords.entries()) {
    const canonical = keyword.trim().toLocaleUpperCase();
    if (!supportedKeyword(canonical)) {
      context.addIssue({
        code: "custom",
        path: ["keywords", index],
        message: `Unsupported local-engine weapon keyword ${keyword}.`,
      });
    }
    if (seenKeywords.has(canonical)) {
      context.addIssue({
        code: "custom",
        path: ["keywords", index],
        message: `Duplicate local-engine weapon keyword ${keyword}.`,
      });
    }
    seenKeywords.add(canonical);
  }
});
const DefensiveProfileSchema = z.object({
  name: z.string().min(1).optional(),
  count: z.number().int().positive(),
  T: z.number().int().positive(),
  SV: z.number().int().positive(),
  W: z.number().int().positive(),
  INV: z.number().int().positive().nullable(),
  FNP: z.number().int().positive().nullable(),
  rangedINV: z.number().int().positive().nullable().optional(),
  meleeINV: z.number().int().positive().nullable().optional(),
}).strict();
const EngineUnitSchema = z.object({
  instanceId: z.string().regex(/^[0-9a-f]{24}$/),
  selectionId: z.string().min(1),
  occurrence: z.number().int().positive(),
  label: z.string().min(1),
  name: z.string().min(1),
  models: z.number().int().positive(),
  T: z.number().int().positive(),
  SV: z.number().int().positive(),
  W: z.number().int().positive(),
  INV: z.number().int().positive().nullable(),
  FNP: z.number().int().positive().nullable(),
  rangedINV: z.number().int().positive().nullable().optional(),
  meleeINV: z.number().int().positive().nullable().optional(),
  points: z.number().int().nonnegative().optional(),
  keywords: z.array(z.string().min(1)),
  weapons: z.array(EngineWeaponSchema).min(1),
  profiles: z.array(DefensiveProfileSchema).optional(),
}).strict().superRefine((unit, context) => {
  const extraProfileCount = (unit.profiles ?? []).reduce(
    (count, profile) => count + profile.count,
    0,
  );
  if (extraProfileCount >= unit.models) {
    context.addIssue({
      code: "custom",
      path: ["profiles"],
      message:
        "Mixed defensive sub-profile counts must leave at least one model represented by the unit's base profile.",
    });
  }
});
const ProfileRequirementSchema = z.object({
  faction: z.string().min(1),
  unit: z.string().min(1),
  selectionId: z.string().min(1).nullable(),
  unitOccurrence: z.number().int().positive().optional(),
  modelCount: z.number().int().positive().optional(),
  weaponGroup: z.string().min(1),
  phase: z.enum(["shooting", "fight"]),
  availableProfiles: z.array(z.string().min(1)).min(2),
  activeCount: z.number().int().positive(),
  selectedProfile: z.string().min(1).nullable(),
}).strict();
const FrozenChoiceSchema = z.object({
  selectionId: z.string().min(1),
  unitName: z.string().min(1),
  phase: z.enum(["shooting", "fight", "defence"]),
  kind: z.enum([
    "alternate-profile",
    "pistol-or-other",
    "ordinary-melee",
    "mixed-defensive-profile",
  ]),
  selected: z.array(z.string().min(1)),
  omitted: z.array(z.string().min(1)),
  reason: z.string().min(1),
}).strict();
const LocalInputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("rosterpilot-local-engine-input"),
  compilerVersion: z.literal(LOCAL_TESSERA_COMPILER_VERSION),
  evaluationMode: z.literal("base-profile-evaluation"),
  bundleId: z.string().regex(SHA256),
  rosterId: z.string().min(1),
  rosterFingerprint: z.string().min(1),
  rosterName: z.string().min(1),
  factionId: z.string().min(1),
  factionName: z.string().min(1),
  totalPoints: z.number().int().nonnegative(),
  profilePolicySha256: z.string().regex(SHA256).nullable(),
  profileRequirements: z.array(ProfileRequirementSchema),
  units: z.array(EngineUnitSchema).min(1),
  limitations: z.object({
    unmodeledSystems: z.array(z.string().min(1)).min(1),
    omittedDatasheetAbilities: z.array(z.object({
      selectionId: z.string().min(1),
      unitName: z.string().min(1),
      abilityNames: z.array(z.string().min(1)).min(1),
    }).strict()),
    omittedWargear: z.array(z.object({
      selectionId: z.string().min(1),
      unitName: z.string().min(1),
      itemId: z.string().min(1),
      itemName: z.string().min(1),
      count: z.number().int().positive(),
    }).strict()),
    omittedEnhancements: z.array(z.object({
      selectionId: z.string().min(1),
      unitName: z.string().min(1),
      enhancementId: z.string().min(1),
      enhancementName: z.string().min(1),
    }).strict()),
    unsupportedWeaponKeywords: z.array(z.object({
      selectionId: z.string().min(1),
      unitName: z.string().min(1),
      weaponName: z.string().min(1),
      keyword: z.string().min(1),
    }).strict()),
    frozenChoices: z.array(FrozenChoiceSchema),
  }).strict(),
}).strict().superRefine((input, context) => {
  const instanceIds = new Set<string>();
  const selectionIds = new Set<string>();
  const scenarioIdentities = new Set<string>();
  for (const [index, unit] of input.units.entries()) {
    if (instanceIds.has(unit.instanceId)) {
      context.addIssue({
        code: "custom",
        path: ["units", index, "instanceId"],
        message: `Duplicate local-engine instanceId ${unit.instanceId}.`,
      });
    }
    instanceIds.add(unit.instanceId);
    if (selectionIds.has(unit.selectionId)) {
      context.addIssue({
        code: "custom",
        path: ["units", index, "selectionId"],
        message: `Duplicate local-engine selectionId ${unit.selectionId}.`,
      });
    }
    selectionIds.add(unit.selectionId);
    const scenarioIdentity = `${normalized(unit.label)}|${unit.occurrence}`;
    if (scenarioIdentities.has(scenarioIdentity)) {
      context.addIssue({
        code: "custom",
        path: ["units", index, "occurrence"],
        message:
          `Duplicate local-engine scenario identity ${unit.label} occurrence ${unit.occurrence}.`,
      });
    }
    scenarioIdentities.add(scenarioIdentity);
  }
});

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
  "MELTA",
  "ONE SHOT",
  "PISTOL",
  "PRECISION",
  "PSYCHIC",
  "RAPID FIRE",
  "SUSTAINED HITS",
  "TORRENT",
  "TWIN-LINKED",
]);

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function normalized(value: string): string {
  return normalizeProfileIdentity(value);
}

function canonicalKeyword(input: {
  keywordId: string;
  name: string;
  parameters?: {
    value?: number | string;
    target_keyword?: string;
    threshold?: number;
  };
}): string {
  if (input.keywordId === "anti") {
    const target = input.parameters?.target_keyword;
    const threshold = input.parameters?.threshold;
    if (!target || !Number.isInteger(threshold)) {
      throw codedError(
        "TESSERA_LOCAL_KEYWORD_INVALID",
        `Weapon keyword ${input.name} is missing its target or threshold.`,
      );
    }
    return `ANTI-${target.toLocaleUpperCase()} ${threshold}+`;
  }
  const name = input.name
    .trim()
    .toLocaleUpperCase()
    .replace(/^TWIN[ -]LINKED$/, "TWIN-LINKED")
    .replace(/\s+/g, " ");
  const parameter = input.parameters?.value;
  return parameter === undefined ? name : `${name} ${parameter}`;
}

function supportedKeyword(keyword: string): boolean {
  if (/^ANTI-[A-Z][A-Z /-]* [2-6]\+$/.test(keyword)) return true;
  const base = keyword.replace(/ \d+$/, "");
  return SUPPORTED_KEYWORDS.has(base);
}

function engineValue(
  value: unknown,
  subject: string,
): LocalEngineValue {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (
    typeof value === "string" &&
    /^(?:\d+|\d*D\d+(?:[+-]\d+)?)$/i.test(value.trim())
  ) {
    return /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value.trim().toLocaleUpperCase();
  }
  throw codedError(
    "TESSERA_LOCAL_CHARACTERISTIC_UNSUPPORTED",
    `${subject} is not a supported fixed or dice characteristic.`,
  );
}

function fixedInteger(
  value: unknown,
  subject: string,
  allowNegative = false,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (
    !Number.isInteger(numeric) ||
    (!allowNegative && numeric < 0)
  ) {
    throw codedError(
      "TESSERA_LOCAL_CHARACTERISTIC_UNSUPPORTED",
      `${subject} is not a supported fixed integer characteristic.`,
    );
  }
  return numeric;
}

function selectedAlternateProfile(input: {
  roster: RosterDraftV1;
  selection: RosterDraftV1["units"][number];
  unitOccurrence: number;
  weaponGroup: string;
  phase: TesseraPhase;
  profiles: Array<{ name: string }>;
  activeCount: number;
  policy: ProfilePolicyV1 | null;
}): string | null {
  if (input.profiles.length <= 1) return input.profiles[0]?.name ?? null;
  const matches = input.policy?.entries.filter((entry) =>
    profilePolicyIdentityMatches(entry, {
      faction: input.roster.factionId,
      unit: input.selection.name,
      unitOccurrence: input.unitOccurrence,
      modelCount: input.selection.modelCount,
      weaponGroup: input.weaponGroup,
      phase: input.phase,
    }),
  ) ?? [];
  if (matches.length !== 1 || matches[0].activeCount !== input.activeCount) {
    throw codedError(
      "TESSERA_LOCAL_PROFILE_POLICY_REQUIRED",
      `${input.selection.name} / ${input.weaponGroup} / ${input.phase} requires one exact frozen profile-policy entry.`,
    );
  }
  const selected = input.profiles.filter(
    (profile) =>
      normalized(profile.name) === normalized(matches[0].selectedProfile),
  );
  if (selected.length !== 1) {
    throw codedError(
      "TESSERA_LOCAL_PROFILE_POLICY_INVALID",
      `${input.selection.name} / ${input.weaponGroup} / ${input.phase} does not contain frozen profile ${matches[0].selectedProfile}.`,
    );
  }
  return selected[0].name;
}

function defensiveProfiles(input: {
  roster: RosterDraftV1;
  selection: RosterDraftV1["units"][number];
  unit: NonNullable<ReturnType<typeof resolveFactionUnit>>;
  choices: LocalTesseraEngineInput["limitations"]["frozenChoices"];
}): {
  base: Omit<LocalEngineDefensiveProfile, "count" | "name">;
  extras: LocalEngineDefensiveProfile[];
} {
  const profiles = input.unit.raw.profiles;
  const toEngine = (profile: (typeof profiles)[number]) => ({
    ...(profile.name ? { name: profile.name } : {}),
    T: fixedInteger(profile.T, `${input.selection.name} T`),
    SV: fixedInteger(profile.Sv, `${input.selection.name} Sv`),
    W: fixedInteger(profile.W, `${input.selection.name} W`),
    INV: profile.invuln_sv ?? null,
    FNP: null,
    ...(profile.invuln_sv_ranged === undefined
      ? {}
      : { rangedINV: profile.invuln_sv_ranged }),
    ...(profile.invuln_sv_melee === undefined
      ? {}
      : { meleeINV: profile.invuln_sv_melee }),
  });
  const toBaseEngine = (profile: (typeof profiles)[number]) => {
    const base = toEngine(profile);
    delete base.name;
    return base;
  };
  if (profiles.length === 1) {
    return { base: toBaseEngine(profiles[0]), extras: [] };
  }

  const composition = dataset.unitCompositionOf(input.unit.raw);
  if (!composition) {
    throw codedError(
      "TESSERA_LOCAL_MIXED_DEFENSIVE_PROFILE_UNRESOLVED",
      `${input.selection.name} has multiple defensive profiles but no unit-composition record in the active bundle.`,
    );
  }
  const modelRules = composition.models;
  const profileIndexByName = new Map<string, number>();
  for (const [index, profile] of profiles.entries()) {
    const key = normalized(profile.name ?? "");
    if (!key || profileIndexByName.has(key)) {
      throw codedError(
        "TESSERA_LOCAL_MIXED_DEFENSIVE_PROFILE_UNRESOLVED",
        `${input.selection.name} has missing or duplicate defensive-profile names.`,
      );
    }
    profileIndexByName.set(key, index);
  }
  const profileIndexForModel = (
    model: (typeof modelRules)[number],
  ): number => {
    const profileName = model.profile_name ?? model.name;
    const index = profileIndexByName.get(normalized(profileName));
    if (index === undefined) {
      throw codedError(
        "TESSERA_LOCAL_MIXED_DEFENSIVE_PROFILE_UNRESOLVED",
        `${input.selection.name} composition model ${model.name} maps to unknown defensive profile ${profileName}.`,
      );
    }
    return index;
  };
  const leaderOnly = profiles.map(() => true);
  for (const model of modelRules) {
    const index = profileIndexForModel(model);
    if (!model.is_leader_model) leaderOnly[index] = false;
  }
  const ruleSets = composition.tiers?.length
    ? composition.tiers.map((tier) =>
        tier.models.map((tierModel) => {
          const matches = modelRules.filter(
            (model) => normalized(model.name) === normalized(tierModel.name),
          );
          if (matches.length !== 1) {
            throw codedError(
              "TESSERA_LOCAL_MIXED_DEFENSIVE_PROFILE_UNRESOLVED",
              `${input.selection.name} tier model ${tierModel.name} does not map uniquely to its composition envelope.`,
            );
          }
          return {
            profileIndex: profileIndexForModel(matches[0]),
            min: tierModel.min,
            max: tierModel.max,
          };
        }),
      )
    : [
        modelRules.map((model) => ({
          profileIndex: profileIndexForModel(model),
          min: model.min,
          max: model.max,
        })),
      ];
  const resolvedCounts = new Map<string, number[]>();
  for (const rules of ruleSets) {
    let states = new Map<string, { total: number; counts: number[] }>([
      [
        `0|${profiles.map(() => 0).join(",")}`,
        { total: 0, counts: profiles.map(() => 0) },
      ],
    ]);
    for (const rule of rules) {
      if (
        !Number.isInteger(rule.min) ||
        !Number.isInteger(rule.max) ||
        rule.min < 0 ||
        rule.max < rule.min
      ) {
        throw codedError(
          "TESSERA_LOCAL_MIXED_DEFENSIVE_PROFILE_UNRESOLVED",
          `${input.selection.name} has an invalid unit-composition count range.`,
        );
      }
      const next = new Map<string, { total: number; counts: number[] }>();
      for (const state of states.values()) {
        const maximum = Math.min(
          rule.max,
          input.selection.modelCount - state.total,
        );
        for (let count = rule.min; count <= maximum; count += 1) {
          const counts = [...state.counts];
          counts[rule.profileIndex] += count;
          const total = state.total + count;
          next.set(`${total}|${counts.join(",")}`, { total, counts });
        }
      }
      states = next;
    }
    for (const state of states.values()) {
      if (state.total !== input.selection.modelCount) continue;
      resolvedCounts.set(state.counts.join(","), state.counts);
    }
  }
  if (resolvedCounts.size !== 1) {
    throw codedError(
      "TESSERA_LOCAL_MIXED_DEFENSIVE_PROFILE_UNRESOLVED",
      `${input.selection.name} has ${resolvedCounts.size === 0 ? "no" : "multiple"} unit-composition profile allocations for ${input.selection.modelCount} selected models.`,
    );
  }
  const counts = [...resolvedCounts.values()][0];
  const activeProfiles = counts
    .map((count, index) => ({ count, index, profile: profiles[index] }))
    .filter((entry) => entry.count > 0)
    .sort(
      (left, right) =>
        right.count - left.count ||
        Number(leaderOnly[left.index]) - Number(leaderOnly[right.index]) ||
        left.index - right.index,
    );
  const baseEntry = activeProfiles[0];
  if (!baseEntry) {
    throw codedError(
      "TESSERA_LOCAL_MIXED_DEFENSIVE_PROFILE_UNRESOLVED",
      `${input.selection.name} resolved to no active defensive profile.`,
    );
  }
  const extras = activeProfiles
    .slice(1)
    .map((entry) => ({ ...toEngine(entry.profile), count: entry.count }));
  input.choices.push({
    selectionId: input.selection.selectionId,
    unitName: input.selection.name,
    phase: "defence",
    kind: "mixed-defensive-profile",
    selected: activeProfiles.map(
      (entry) => `${entry.profile.name} x${entry.count}`,
    ),
    omitted: counts.flatMap((count, index) =>
      count === 0 ? [`${profiles[index].name} x0`] : [],
    ),
    reason:
      "Model-profile counts were uniquely resolved from the active bundle's explicit profile_name mappings and buildable composition tier.",
  });
  return { base: toBaseEngine(baseEntry.profile), extras };
}

function weaponPriority(
  left: LocalEngineWeapon,
  right: LocalEngineWeapon,
): number {
  return (
    left.AP - right.AP ||
    right.S - left.S ||
    String(right.D).localeCompare(String(left.D)) ||
    String(right.A).localeCompare(String(left.A)) ||
    left.name.localeCompare(right.name)
  );
}

function contentSha256(content: Uint8Array): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function compileRosterForLocalTesseraEngine(
  roster: RosterDraftV1,
  policy: ProfilePolicyV1 | null = null,
): LocalTesseraEngineInput {
  const active = currentRosterSourceData(roster.factionId);
  if (active.bundleId !== roster.sourceData.bundleId) {
    throw codedError(
      "TESSERA_LOCAL_BUNDLE_MISMATCH",
      `Roster ${roster.name} is pinned to bundle ${roster.sourceData.bundleId}, but bundle ${active.bundleId} is active. Rebase or restore the frozen bundle before local compilation.`,
    );
  }
  const profileRequirements = aggregateProfileRequirements([roster]);
  const scopedPolicy: ProfilePolicyV1 | null = policy
    ? {
        ...policy,
        entries: policy.entries.filter((entry) =>
          profileRequirements.some((requirement) =>
            profilePolicyIdentityMatches(entry, requirement),
          ),
        ),
      }
    : null;
  const policyValidation = validateProfilePolicy(
    profileRequirements,
    scopedPolicy,
  );
  if (!policyValidation.valid) {
    throw codedError(
      "TESSERA_LOCAL_PROFILE_POLICY_REQUIRED",
      [
        ...policyValidation.errors,
        ...policyValidation.unresolved.map(
          (requirement) =>
            `${requirement.unit} / ${requirement.weaponGroup} / ${requirement.phase}`,
        ),
      ].join(" "),
    );
  }

  const omittedDatasheetAbilities:
    LocalTesseraEngineInput["limitations"]["omittedDatasheetAbilities"] = [];
  const omittedWargear:
    LocalTesseraEngineInput["limitations"]["omittedWargear"] = [];
  const omittedEnhancements:
    LocalTesseraEngineInput["limitations"]["omittedEnhancements"] = [];
  const unsupportedWeaponKeywords:
    LocalTesseraEngineInput["limitations"]["unsupportedWeaponKeywords"] = [];
  const frozenChoices:
    LocalTesseraEngineInput["limitations"]["frozenChoices"] = [];
  const occurrenceByUnitSize = new Map<string, number>();

  const units = roster.units.map((selection) => {
    const unit = resolveFactionUnit(selection.unitId, roster.factionId);
    if (!unit) {
      throw codedError(
        "TESSERA_LOCAL_UNIT_PROFILE_MISSING",
        `${selection.name} is missing from active bundle ${active.bundleId}.`,
      );
    }
    const occurrenceKey = `${normalized(selection.name)}|${selection.modelCount}`;
    const profilePolicyOccurrence =
      (occurrenceByUnitSize.get(occurrenceKey) ?? 0) + 1;
    occurrenceByUnitSize.set(occurrenceKey, profilePolicyOccurrence);
    // Scenario cells are reconciled with canonical roster instances by the
    // unit's roster ordinal. Profile-policy occurrence is deliberately scoped
    // by model count, so it cannot also identify differently sized copies.
    const occurrence = selection.ordinal;
    const defence = defensiveProfiles({
      roster,
      selection,
      unit,
      choices: frozenChoices,
    });
    const resolvedAbilityIds = new Set(
      unit.abilities.map((ability) => ability.raw.ability_id),
    );
    const missingAbilityIds = (unit.raw.ability_ids ?? []).filter(
      (abilityId) => !resolvedAbilityIds.has(abilityId),
    );
    if (missingAbilityIds.length > 0) {
      throw codedError(
        "TESSERA_LOCAL_ABILITY_PROFILE_MISSING",
        `${selection.name} references missing abilit${missingAbilityIds.length === 1 ? "y" : "ies"}: ${missingAbilityIds.join(", ")}.`,
      );
    }
    const abilityNames = [...new Set(unit.abilities.map((ability) => ability.name))]
      .sort((left, right) => left.localeCompare(right));
    if (abilityNames.length > 0) {
      omittedDatasheetAbilities.push({
        selectionId: selection.selectionId,
        unitName: selection.name,
        abilityNames,
      });
    }
    if (selection.enhancementId) {
      omittedEnhancements.push({
        selectionId: selection.selectionId,
        unitName: selection.name,
        enhancementId: selection.enhancementId,
        enhancementName:
          selection.enhancementName ?? selection.enhancementId,
      });
    }

    let weapons: LocalEngineWeapon[] = [];
    const equipmentItemIdByWeapon = new Map<LocalEngineWeapon, string>();
    for (const equipment of selection.equipment) {
      if (equipment.count <= 0) continue;
      const weapon =
        unit.weapons.find((candidate) => candidate.id === equipment.itemId) ??
        dataset.weapons.getInFaction(equipment.itemId, unit.raw.faction_id) ??
        dataset.weapons.getAny(equipment.itemId);
      if (!weapon) {
        const wargear =
          dataset.wargear.getInFaction(equipment.itemId, unit.raw.faction_id) ??
          dataset.wargear.getAny(equipment.itemId);
        if (!wargear) {
          throw codedError(
            "TESSERA_LOCAL_WEAPON_PROFILE_MISSING",
            `${selection.name} / ${equipment.name} is missing from active bundle ${active.bundleId}.`,
          );
        }
        omittedWargear.push({
          selectionId: selection.selectionId,
          unitName: selection.name,
          itemId: equipment.itemId,
          itemName: equipment.name,
          count: equipment.count,
        });
        continue;
      }
      const profilesByPhase = new Map<
        TesseraPhase,
        Array<(typeof weapon.raw.profiles)[number]>
      >();
      for (const profile of weapon.raw.profiles) {
        const phase: TesseraPhase =
          typeof profile.range === "string" &&
          normalized(profile.range) === "melee"
            ? "fight"
            : "shooting";
        const grouped = profilesByPhase.get(phase) ?? [];
        grouped.push(profile);
        profilesByPhase.set(phase, grouped);
      }
      for (const [phase, phaseProfiles] of profilesByPhase) {
        const selectedName = selectedAlternateProfile({
          roster,
          selection,
          unitOccurrence: profilePolicyOccurrence,
          weaponGroup: equipment.name,
          phase,
          profiles: phaseProfiles,
          activeCount: equipment.count,
          policy: scopedPolicy,
        });
        const selectedProfiles = phaseProfiles.filter(
          (profile) =>
            selectedName === null ||
            normalized(profile.name) === normalized(selectedName),
        );
        if (phaseProfiles.length > 1) {
          frozenChoices.push({
            selectionId: selection.selectionId,
            unitName: selection.name,
            phase,
            kind: "alternate-profile",
            selected: selectedProfiles.map((profile) => profile.name),
            omitted: phaseProfiles
              .filter((profile) => !selectedProfiles.includes(profile))
              .map((profile) => profile.name),
            reason: "The selected profile came from the frozen Tessera profile policy.",
          });
        }
        for (const profile of selectedProfiles) {
        const keywords: string[] = [];
        for (const reference of profile.keywords ?? []) {
          const definition = dataset.weaponKeywords.get(reference.keyword_id);
          if (!definition) {
            throw codedError(
              "TESSERA_LOCAL_KEYWORD_MISSING",
              `${selection.name} / ${weapon.name} references missing keyword ${reference.keyword_id}.`,
            );
          }
          const keyword = canonicalKeyword({
            keywordId: reference.keyword_id,
            name: definition.name,
            parameters: reference.parameters,
          });
          if (supportedKeyword(keyword)) {
            keywords.push(keyword);
          } else {
            unsupportedWeaponKeywords.push({
              selectionId: selection.selectionId,
              unitName: selection.name,
              weaponName: weapon.name,
              keyword,
            });
          }
        }
        const melee = phase === "fight";
        const ballisticSkill = profile.stats.BS;
        if (
          !melee &&
          ballisticSkill == null &&
          !keywords.includes("TORRENT")
        ) {
          throw codedError(
            "TESSERA_LOCAL_CHARACTERISTIC_UNSUPPORTED",
            `${selection.name} / ${profile.name} has no Ballistic Skill and is not TORRENT.`,
          );
        }
        const engineWeapon: LocalEngineWeapon = {
          name:
            weapon.raw.profiles.length > 1
              ? `${weapon.name} — ${
                  new Set(
                    weapon.raw.profiles.map((candidate) =>
                      normalized(candidate.name),
                    ),
                  ).size === 1
                    ? melee
                      ? "Melee"
                      : "Ranged"
                    : profile.name
                }`
              : weapon.name,
          type: melee ? "melee" : "ranged",
          count: equipment.count,
          A: engineValue(profile.stats.A, `${selection.name} / ${profile.name} A`),
          ...(melee
            ? {
                WS: fixedInteger(
                  profile.stats.WS,
                  `${selection.name} / ${profile.name} WS`,
                ),
              }
            : ballisticSkill == null
              ? {}
              : {
                  BS: fixedInteger(
                    ballisticSkill,
                    `${selection.name} / ${profile.name} BS`,
                  ),
                }),
          S: fixedInteger(profile.stats.S, `${selection.name} / ${profile.name} S`),
          AP: fixedInteger(
            profile.stats.AP,
            `${selection.name} / ${profile.name} AP`,
            true,
          ),
          D: engineValue(profile.stats.D, `${selection.name} / ${profile.name} D`),
          keywords: [...new Set(keywords)].sort(),
        };
        weapons.push(engineWeapon);
        equipmentItemIdByWeapon.set(engineWeapon, equipment.itemId);
        }
      }
    }

    const ranged = weapons.filter((weapon) => weapon.type === "ranged");
    const nonPistols = ranged.filter(
      (weapon) => !weapon.keywords.includes("PISTOL"),
    );
    const pistols = ranged.filter((weapon) => weapon.keywords.includes("PISTOL"));
    if (pistols.length > 0 && nonPistols.length > 0) {
      const retainedPistolCounts = new Map(
        pistols.map((weapon) => [weapon, 0]),
      );
      let reason: string;
      if (selection.modelCount === 1) {
        reason =
          "The single model used all of its non-PISTOL ranged weapons, so the base-profile firing-set policy omitted its PISTOL attacks.";
      } else {
        const equipmentCounts = new Map<string, number>();
        for (const equipment of selection.equipment) {
          if (equipment.count <= 0) continue;
          equipmentCounts.set(
            equipment.itemId,
            (equipmentCounts.get(equipment.itemId) ?? 0) + equipment.count,
          );
        }
        const loadoutGroups = groupLoadout(
          unit.raw,
          selection.modelCount,
          dataset.wargearOptionsOf(unit.raw),
          dataset.unitCompositionOf(unit.raw)?.models,
          equipmentCounts,
        );
        if (
          !loadoutGroups ||
          loadoutGroups.reduce((sum, group) => sum + group.count, 0) !==
            selection.modelCount
        ) {
          throw codedError(
            "TESSERA_LOCAL_WEAPON_CHOICE_UNSUPPORTED",
            `${selection.name} has both PISTOL and non-PISTOL ranged weapons, but the active bundle could not resolve its aggregate equipment into exact per-model loadout groups.`,
          );
        }
        const itemId = (weapon: LocalEngineWeapon): string => {
          const resolved = equipmentItemIdByWeapon.get(weapon);
          if (!resolved) {
            throw codedError(
              "TESSERA_LOCAL_WEAPON_CHOICE_UNSUPPORTED",
              `${selection.name} has a compiled weapon profile with no source-equipment identity.`,
            );
          }
          return resolved;
        };
        const nonPistolItemIds = new Set(nonPistols.map(itemId));
        const pistolItemIds = new Set(pistols.map(itemId));
        const selectedPistolCountByItem = new Map<string, number>();
        for (const group of loadoutGroups) {
          const usesNonPistol = group.weapons.some(
            (weapon) =>
              weapon.count > 0 && nonPistolItemIds.has(weapon.id),
          );
          if (usesNonPistol) continue;
          for (const weapon of group.weapons) {
            if (weapon.count <= 0 || !pistolItemIds.has(weapon.id)) continue;
            selectedPistolCountByItem.set(
              weapon.id,
              (selectedPistolCountByItem.get(weapon.id) ?? 0) +
                group.count * weapon.count,
            );
          }
        }
        for (const pistol of pistols) {
          const retained = selectedPistolCountByItem.get(itemId(pistol)) ?? 0;
          if (retained > pistol.count) {
            throw codedError(
              "TESSERA_LOCAL_WEAPON_CHOICE_UNSUPPORTED",
              `${selection.name} resolved more ${pistol.name} profiles than its frozen equipment count.`,
            );
          }
          retainedPistolCounts.set(pistol, retained);
        }
        reason =
          "The active bundle resolved the aggregate equipment into exact per-model loadout groups. Models with non-PISTOL ranged weapons used all of those weapons; only pistol-only models retained their PISTOL attacks.";
      }
      weapons = weapons.flatMap((weapon) => {
        if (!pistols.includes(weapon)) return [weapon];
        const count = retainedPistolCounts.get(weapon) ?? 0;
        return count > 0 ? [{ ...weapon, count }] : [];
      });
      frozenChoices.push({
        selectionId: selection.selectionId,
        unitName: selection.name,
        phase: "shooting",
        kind: "pistol-or-other",
        selected: [
          ...nonPistols.map((weapon) => `${weapon.name} x${weapon.count}`),
          ...pistols.flatMap((weapon) => {
            const count = retainedPistolCounts.get(weapon) ?? 0;
            return count > 0 ? [`${weapon.name} x${count}`] : [];
          }),
        ],
        omitted: pistols.flatMap((weapon) => {
          const count = weapon.count - (retainedPistolCounts.get(weapon) ?? 0);
          return count > 0 ? [`${weapon.name} x${count}`] : [];
        }),
        reason,
      });
    }

    const ordinaryMelee = weapons.filter(
      (weapon) =>
        weapon.type === "melee" &&
        !weapon.keywords.includes("EXTRA ATTACKS"),
    );
    if (
      ordinaryMelee.reduce((sum, weapon) => sum + weapon.count, 0) >
      selection.modelCount
    ) {
      let remainingModels = selection.modelCount;
      const allocatedCounts = new Map<LocalEngineWeapon, number>();
      for (const weapon of [...ordinaryMelee].sort(weaponPriority)) {
        const count = Math.min(weapon.count, remainingModels);
        if (count > 0) allocatedCounts.set(weapon, count);
        remainingModels -= count;
      }
      const selected = ordinaryMelee.flatMap((weapon) => {
        const count = allocatedCounts.get(weapon) ?? 0;
        return count > 0 ? [`${weapon.name} x${count}`] : [];
      });
      const omitted = ordinaryMelee.flatMap((weapon) => {
        const count = weapon.count - (allocatedCounts.get(weapon) ?? 0);
        return count > 0 ? [`${weapon.name} x${count}`] : [];
      });
      weapons = weapons.flatMap((weapon) => {
        if (!ordinaryMelee.includes(weapon)) return [weapon];
        const count = allocatedCounts.get(weapon) ?? 0;
        return count > 0 ? [{ ...weapon, count }] : [];
      });
      frozenChoices.push({
        selectionId: selection.selectionId,
        unitName: selection.name,
        phase: "fight",
        kind: "ordinary-melee",
        selected,
        omitted,
        reason:
          "Aggregate weapon selections exceeded the model count, so the base-profile attack-set policy filled model slots by best AP then highest Strength while preserving each retained weapon count; EXTRA ATTACKS weapons remain additive.",
      });
    }
    if (weapons.length === 0) {
      throw codedError(
        "TESSERA_LOCAL_WEAPON_PROFILE_MISSING",
        `${selection.name} has no selected weapon profile supported by the local engine.`,
      );
    }
    const instanceId = crypto
      .createHash("sha256")
      .update(
        [
          roster.id,
          selection.selectionId,
          selection.unitId,
          selection.modelCount,
          occurrence,
        ].join("|"),
      )
      .digest("hex")
      .slice(0, 24);
    return {
      instanceId,
      selectionId: selection.selectionId,
      occurrence,
      label: selection.name,
      name: selection.name,
      models: selection.modelCount,
      ...defence.base,
      points: selection.points,
      keywords: [
        ...new Set([
          ...(unit.raw.keywords ?? []),
          ...(unit.raw.faction_keywords ?? []),
        ].map((keyword) => keyword.toLocaleUpperCase())),
      ].sort(),
      weapons,
      ...(defence.extras.length > 0
        ? { profiles: defence.extras }
        : {}),
    } satisfies LocalTesseraEngineUnit;
  });

  return {
    schemaVersion: 1,
    kind: "rosterpilot-local-engine-input",
    compilerVersion: LOCAL_TESSERA_COMPILER_VERSION,
    evaluationMode: "base-profile-evaluation",
    bundleId: active.bundleId,
    rosterId: roster.id,
    rosterFingerprint: rosterExecutionFingerprint(roster),
    rosterName: roster.name,
    factionId: roster.factionId,
    factionName: roster.factionName,
    totalPoints: roster.totalPoints,
    profilePolicySha256: scopedPolicy
      ? profilePolicyHash(scopedPolicy)
      : null,
    profileRequirements: structuredClone(profileRequirements),
    units,
    limitations: {
      unmodeledSystems: [
        "army rules",
        "detachment rules",
        "datasheet abilities",
        "enhancements",
        "non-weapon wargear effects",
        "range and distance-dependent effects",
        "stratagems",
        "attached-unit interactions",
      ],
      omittedDatasheetAbilities,
      omittedWargear,
      omittedEnhancements,
      unsupportedWeaponKeywords,
      frozenChoices,
    },
  };
}

export function serializeLocalTesseraEngineInput(
  input: LocalTesseraEngineInput,
): Uint8Array {
  const parsed = LocalInputSchema.parse(input);
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export function parseLocalTesseraEngineInput(
  content: Uint8Array,
): LocalTesseraEngineInput {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8"));
  } catch {
    throw codedError(
      "TESSERA_LOCAL_INPUT_INVALID",
      "The RosterPilot local-engine input is not valid JSON.",
    );
  }
  const parsed = LocalInputSchema.safeParse(value);
  if (!parsed.success) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_INVALID",
      `The RosterPilot local-engine input failed schema validation: ${parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data as LocalTesseraEngineInput;
}

export function verifyLocalTesseraEngineInput(input: {
  content: Uint8Array;
  expectedSha256?: string;
  expectedBundleId?: string;
  expectedRosterFingerprint?: string;
}): LocalTesseraEngineInput {
  if (
    input.expectedSha256 &&
    contentSha256(input.content) !== input.expectedSha256
  ) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_CHANGED",
      "The RosterPilot local-engine input changed after its hash was frozen.",
    );
  }
  const parsed = parseLocalTesseraEngineInput(input.content);
  if (
    input.expectedBundleId &&
    parsed.bundleId !== input.expectedBundleId
  ) {
    throw codedError(
      "TESSERA_LOCAL_BUNDLE_MISMATCH",
      `The local input names bundle ${parsed.bundleId}, not frozen bundle ${input.expectedBundleId}.`,
    );
  }
  if (
    input.expectedRosterFingerprint &&
    parsed.rosterFingerprint !== input.expectedRosterFingerprint
  ) {
    throw codedError(
      "TESSERA_LOCAL_INPUT_CHANGED",
      "The local input does not match the frozen roster execution fingerprint.",
    );
  }
  return parsed;
}

export function localInputSha256(content: Uint8Array): string {
  return contentSha256(content);
}
