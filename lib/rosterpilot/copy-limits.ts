export type UnitCopyLimitUnit = {
  role?: string | null;
  keywords?: readonly string[];
  faction_keywords?: readonly string[];
};

export type UnitCopyLimitDetachment = {
  granted_keywords?: readonly {
    keyword: string;
    to_keywords: readonly string[];
    max_selected?: number;
  }[];
};

export type UnitCopyLimitResolution =
  | {
      status: "resolved";
      maximumCopies: number;
      basis:
        | "epic-hero"
        | "battleline"
        | "dedicated-transport"
        | "standard";
    }
  | {
      status: "unresolved";
      reason: string;
    };

const KNOWN_ROLES = new Set([
  "character",
  "battleline",
  "dedicated-transport",
  "fortification",
  "allied",
  "epic-hero",
]);

type CapClass =
  | "epic-hero"
  | "battleline"
  | "dedicated-transport";

const CAP_CLASS_BY_KEYWORD = new Map<string, CapClass>([
  ["epic hero", "epic-hero"],
  ["named character", "epic-hero"],
  ["battleline", "battleline"],
  ["dedicated transport", "dedicated-transport"],
]);

function normalizedKeyword(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, " ");
}

function unresolved(reason: string): UnitCopyLimitResolution {
  return { status: "unresolved", reason };
}

function resolvedLimit(
  capClasses: ReadonlySet<CapClass>,
  battleSize: "incursion" | "strike-force",
): Extract<UnitCopyLimitResolution, { status: "resolved" }> {
  if (capClasses.has("epic-hero")) {
    return {
      status: "resolved",
      maximumCopies: 1,
      basis: "epic-hero",
    };
  }
  if (capClasses.has("battleline")) {
    return {
      status: "resolved",
      maximumCopies: 6,
      basis: "battleline",
    };
  }
  if (capClasses.has("dedicated-transport")) {
    return {
      status: "resolved",
      maximumCopies: 6,
      basis: "dedicated-transport",
    };
  }
  return {
    status: "resolved",
    maximumCopies: battleSize === "incursion" ? 2 : 3,
    basis: "standard",
  };
}

/**
 * Resolve the matched-play datasheet-copy ceiling from immutable construction
 * classifications. Ordinal point bands are intentionally excluded: they
 * price later copies and never declare how many copies are legal.
 */
export function resolveUnitCopyLimit(
  unit: UnitCopyLimitUnit,
  battleSize: string,
  detachment: UnitCopyLimitDetachment | null | undefined,
): UnitCopyLimitResolution {
  if (battleSize !== "incursion" && battleSize !== "strike-force") {
    return unresolved(`Unsupported battle size "${battleSize}".`);
  }

  const role = unit.role;
  if (role === null || (role !== undefined && !KNOWN_ROLES.has(role))) {
    return unresolved(
      role === null
        ? "The datasheet role is null rather than absent or classified."
        : `Unknown datasheet role "${role}".`,
    );
  }
  if (role === "allied") {
    return unresolved(
      "Allied datasheet limits require an allied-rule selection context.",
    );
  }

  const keywords = new Set(
    [...(unit.keywords ?? []), ...(unit.faction_keywords ?? [])].map(
      normalizedKeyword,
    ),
  );
  const keywordCapClasses = new Set<CapClass>();
  for (const keyword of keywords) {
    const capClass = CAP_CLASS_BY_KEYWORD.get(keyword);
    if (capClass) keywordCapClasses.add(capClass);
  }

  const roleCapClass =
    role === "epic-hero" ||
    role === "battleline" ||
    role === "dedicated-transport"
      ? role
      : null;
  if (
    roleCapClass === null
      ? keywordCapClasses.size > 0
      : keywordCapClasses.size !== 1 ||
        !keywordCapClasses.has(roleCapClass)
  ) {
    return unresolved(
      "The datasheet role conflicts with its cap-affecting keywords.",
    );
  }

  const effectiveCapClasses = new Set(keywordCapClasses);
  const conditionalCapClasses: Array<{
    keyword: string;
    capClass: CapClass;
  }> = [];
  for (const grant of detachment?.granted_keywords ?? []) {
    const grantedKeyword = normalizedKeyword(grant.keyword);
    const grantedCapClass = CAP_CLASS_BY_KEYWORD.get(grantedKeyword);
    if (!grantedCapClass) continue;
    const targets = grant.to_keywords.map(normalizedKeyword);
    if (targets.length === 0) {
      return unresolved(
        `The ${grant.keyword} construction grant has no target keywords.`,
      );
    }
    if (!targets.some((target) => keywords.has(target))) continue;
    if (grant.max_selected !== undefined) {
      conditionalCapClasses.push({
        keyword: grant.keyword,
        capClass: grantedCapClass,
      });
      continue;
    }
    effectiveCapClasses.add(grantedCapClass);
  }

  const resolved = resolvedLimit(effectiveCapClasses, battleSize);
  for (const conditional of conditionalCapClasses) {
    const ifGranted = new Set(effectiveCapClasses);
    ifGranted.add(conditional.capClass);
    if (
      resolvedLimit(ifGranted, battleSize).maximumCopies !==
      resolved.maximumCopies
    ) {
      return unresolved(
        `The conditional ${conditional.keyword} construction grant is not assigned to specific roster selections.`,
      );
    }
  }
  return resolved;
}
