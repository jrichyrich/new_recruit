const DEFAULT_NON_SEMANTIC_KEYS = new Set([
  "bundleId",
  "checkedAt",
  "commit",
  "createdAt",
  "fetchedAt",
  "generatedAt",
  "publishedAt",
  "releaseId",
  "signature",
  "signatures",
  "sourceCommit",
  "updatedAt",
]);

export const SEMANTIC_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type JsonPath = readonly (string | number)[];

export type CanonicalSemanticOptions = {
  /**
   * Extra metadata keys to omit wherever they occur. The built-in omissions
   * are deliberately limited to provenance and timestamp fields.
   */
  additionalOmitKeys?: readonly string[];
  /**
   * Arrays are ordered by default because order can carry rules meaning.
   * Callers may identify set-like arrays explicitly; entries at those paths
   * are sorted by their canonical representation before hashing.
   */
  unorderedArrayPaths?: readonly JsonPath[];
};

export type FactionSemanticHashesV1 = {
  factionRulesHash: string;
  mappingHash: string;
  portfolioHash: string;
  conflictHash: string;
  entityHashes: Record<string, string>;
};

export type DataBundleSemanticHashesV1 = {
  globalHash: string;
  methodologyHash: string;
  factions: Record<string, FactionSemanticHashesV1>;
};

export type DataBundleDeltaClassification =
  | "provenance-only"
  | "mapping-only"
  | "rules"
  | "methodology/global"
  | "ambiguous/regressive";

export type DataBundleComparableIdentity = {
  engineDataSchemaVersion: number;
  semanticHashes: DataBundleSemanticHashesV1;
};

export type ClassifyDataBundleDeltaInput = {
  current: DataBundleComparableIdentity;
  candidate: DataBundleComparableIdentity;
  candidateAssessment?: "verified" | "ambiguous" | "regressive";
  ambiguousScopes?: readonly string[];
  /**
   * A dependency entry means the key imports or otherwise depends on each
   * listed faction. A changed dependency therefore affects the key too.
   */
  factionDependencies?: Readonly<Record<string, readonly string[]>>;
};

export type DataBundleDeltaResult = {
  classification: DataBundleDeltaClassification;
  directlyChangedFactions: string[];
  affectedFactions: string[];
  changedEntities: Record<string, string[]>;
  changedScopes: string[];
  requiresFullCertification: boolean;
  quarantine: boolean;
  reasons: string[];
};

class CanonicalJsonError extends TypeError {
  constructor(message: string, path: JsonPath) {
    const displayPath =
      path.length === 0
        ? "$"
        : `$${path
            .map((part) =>
              typeof part === "number"
                ? `[${part}]`
                : `[${JSON.stringify(part)}]`,
            )
            .join("")}`;
    super(`${message} at ${displayPath}.`);
    this.name = "CanonicalJsonError";
  }
}

function isPlainObject(
  value: object,
): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pathsEqual(left: JsonPath, right: JsonPath): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializeCanonical(
  value: unknown,
  path: JsonPath,
  active: Set<object>,
  transform?: {
    omitKeys: ReadonlySet<string>;
    unorderedArrayPaths: readonly JsonPath[];
  },
): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(
        "Canonical JSON does not support non-finite numbers",
        path,
      );
    }
    return JSON.stringify(value);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new CanonicalJsonError(
      `Canonical JSON does not support ${typeof value} values`,
      path,
    );
  }
  if (active.has(value)) {
    throw new CanonicalJsonError(
      "Canonical JSON does not support cyclic values",
      path,
    );
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = value.map((entry, index) => {
        if (!(index in value)) {
          throw new CanonicalJsonError(
            "Canonical JSON does not support sparse arrays",
            [...path, index],
          );
        }
        return serializeCanonical(
          entry,
          [...path, index],
          active,
          transform,
        );
      });
      if (
        transform?.unorderedArrayPaths.some((candidate) =>
          pathsEqual(candidate, path),
        )
      ) {
        entries.sort(compareStrings);
      }
      return `[${entries.join(",")}]`;
    }

    if (!isPlainObject(value)) {
      throw new CanonicalJsonError(
        "Canonical JSON supports only plain objects and arrays",
        path,
      );
    }
    const entries = Object.keys(value)
      .filter((key) => !transform?.omitKeys.has(key))
      .sort(compareStrings)
      .map((key) => {
        const entry = value[key];
        if (entry === undefined) {
          throw new CanonicalJsonError(
            "Canonical JSON does not support undefined object properties",
            [...path, key],
          );
        }
        return `${JSON.stringify(key)}:${serializeCanonical(
          entry,
          [...path, key],
          active,
          transform,
        )}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

/**
 * Produces a strict, deterministic JSON representation. Object keys are
 * sorted; array order is retained; unsupported JSON values fail closed.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, [], new Set());
}

/**
 * Produces a semantic projection that ignores only known provenance metadata.
 * Set-like array sorting remains explicit so a rule-bearing list cannot be
 * reordered accidentally.
 */
export function canonicalSemanticJson(
  value: unknown,
  options: CanonicalSemanticOptions = {},
): string {
  return serializeCanonical(value, [], new Set(), {
    omitKeys: new Set([
      ...DEFAULT_NON_SEMANTIC_KEYS,
      ...(options.additionalOmitKeys ?? []),
    ]),
    unorderedArrayPaths: options.unorderedArrayPaths ?? [],
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(
  value: string | Uint8Array,
): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes),
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function semanticHash(
  value: unknown,
  options: CanonicalSemanticOptions = {},
): Promise<string> {
  return sha256Hex(canonicalSemanticJson(value, options));
}

function differingKeys(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => left[key] !== right[key])
    .sort(compareStrings);
}

function expandAffectedFactions(
  directlyChanged: ReadonlySet<string>,
  dependencies: Readonly<Record<string, readonly string[]>>,
): string[] {
  const affected = new Set(directlyChanged);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [factionId, importedFactions] of Object.entries(
      dependencies,
    )) {
      if (
        !affected.has(factionId) &&
        importedFactions.some((dependency) => affected.has(dependency))
      ) {
        affected.add(factionId);
        changed = true;
      }
    }
  }
  return [...affected].sort(compareStrings);
}

/**
 * Classifies only semantic compatibility. Raw versions, source commits, and
 * release labels belong to provenance and intentionally do not participate.
 */
export function classifyDataBundleDelta(
  input: ClassifyDataBundleDeltaInput,
): DataBundleDeltaResult {
  const assessment = input.candidateAssessment ?? "verified";
  if (assessment !== "verified") {
    return {
      classification: "ambiguous/regressive",
      directlyChangedFactions: [],
      affectedFactions: [],
      changedEntities: {},
      changedScopes: [...(input.ambiguousScopes ?? [])].sort(
        compareStrings,
      ),
      requiresFullCertification: false,
      quarantine: true,
      reasons: [
        assessment === "regressive"
          ? "The candidate bundle was marked regressive."
          : "The candidate bundle contains unresolved semantic ambiguity.",
      ],
    };
  }

  const current = input.current;
  const candidate = input.candidate;
  if (
    candidate.engineDataSchemaVersion <
    current.engineDataSchemaVersion
  ) {
    return {
      classification: "ambiguous/regressive",
      directlyChangedFactions: [],
      affectedFactions: [],
      changedEntities: {},
      changedScopes: ["engine-data-schema"],
      requiresFullCertification: false,
      quarantine: true,
      reasons: [
        `The engine data schema regressed from ${current.engineDataSchemaVersion} to ${candidate.engineDataSchemaVersion}.`,
      ],
    };
  }

  const currentFactions = current.semanticHashes.factions;
  const candidateFactions = candidate.semanticHashes.factions;
  const factionIds = [
    ...new Set([
      ...Object.keys(currentFactions),
      ...Object.keys(candidateFactions),
    ]),
  ].sort(compareStrings);
  const directlyChanged = new Set<string>();
  const changedEntities: Record<string, string[]> = {};
  const changedScopes: string[] = [];
  const reasons: string[] = [];
  let rulesChanged = false;
  let mappingsChanged = false;
  const globalMethodologyChanged =
    current.engineDataSchemaVersion !==
      candidate.engineDataSchemaVersion ||
    current.semanticHashes.globalHash !==
      candidate.semanticHashes.globalHash ||
    current.semanticHashes.methodologyHash !==
      candidate.semanticHashes.methodologyHash;
  let factionPortfolioChanged = false;

  if (
    current.engineDataSchemaVersion !==
    candidate.engineDataSchemaVersion
  ) {
    changedScopes.push("engine-data-schema");
    reasons.push("The engine data schema changed.");
  }
  if (
    current.semanticHashes.globalHash !==
    candidate.semanticHashes.globalHash
  ) {
    changedScopes.push("global");
    reasons.push("Global semantic data changed.");
  }
  if (
    current.semanticHashes.methodologyHash !==
    candidate.semanticHashes.methodologyHash
  ) {
    changedScopes.push("methodology");
    reasons.push("Portfolio or certification methodology changed.");
  }

  for (const factionId of factionIds) {
    const previous = currentFactions[factionId];
    const next = candidateFactions[factionId];
    if (!previous || !next) {
      directlyChanged.add(factionId);
      rulesChanged = true;
      changedScopes.push(`faction:${factionId}:rules`);
      reasons.push(
        `${factionId} was ${previous ? "removed from" : "added to"} the semantic inventory.`,
      );
      continue;
    }
    const entityChanges = differingKeys(
      previous.entityHashes,
      next.entityHashes,
    );
    if (entityChanges.length > 0) {
      changedEntities[factionId] = entityChanges;
      directlyChanged.add(factionId);
      const ruleEntityChanges = entityChanges.filter(
        (key) => !key.startsWith("mapping:"),
      );
      const mappingEntityChanges = entityChanges.filter((key) =>
        key.startsWith("mapping:"),
      );
      if (ruleEntityChanges.length > 0) {
        rulesChanged = true;
        changedScopes.push(`faction:${factionId}:entities`);
      }
      if (mappingEntityChanges.length > 0) {
        mappingsChanged = true;
        changedScopes.push(
          `faction:${factionId}:mapping-entities`,
        );
      }
    }
    if (previous.factionRulesHash !== next.factionRulesHash) {
      directlyChanged.add(factionId);
      rulesChanged = true;
      changedScopes.push(`faction:${factionId}:rules`);
    }
    if (previous.mappingHash !== next.mappingHash) {
      directlyChanged.add(factionId);
      mappingsChanged = true;
      changedScopes.push(`faction:${factionId}:mapping`);
    }
    if (previous.conflictHash !== next.conflictHash) {
      directlyChanged.add(factionId);
      mappingsChanged = true;
      changedScopes.push(`faction:${factionId}:conflicts`);
    }
    if (previous.portfolioHash !== next.portfolioHash) {
      directlyChanged.add(factionId);
      factionPortfolioChanged = true;
      changedScopes.push(`faction:${factionId}:portfolio`);
      reasons.push(`${factionId}'s portfolio contract changed.`);
    }
  }

  const directlyChangedFactions = [...directlyChanged].sort(
    compareStrings,
  );
  const affectedFactions = globalMethodologyChanged
    ? factionIds
    : expandAffectedFactions(
        directlyChanged,
        input.factionDependencies ?? {},
      );
  const classification: DataBundleDeltaClassification =
    globalMethodologyChanged
      ? "methodology/global"
      : rulesChanged || factionPortfolioChanged
        ? "rules"
        : mappingsChanged
          ? "mapping-only"
          : "provenance-only";

  if (classification === "provenance-only") {
    reasons.push(
      "No gameplay, mapping, conflict, or methodology semantics changed.",
    );
  } else if (classification === "mapping-only") {
    reasons.push(
      "Only New Recruit mapping or mapping-conflict semantics changed.",
    );
  } else if (classification === "rules") {
    reasons.push(
      factionPortfolioChanged && !rulesChanged
        ? "Faction-scoped portfolio semantics changed."
        : "Faction rules, referenced entities, or faction-scoped portfolio semantics changed.",
    );
  }

  return {
    classification,
    directlyChangedFactions,
    affectedFactions,
    changedEntities,
    changedScopes: [...new Set(changedScopes)].sort(compareStrings),
    requiresFullCertification: classification === "methodology/global",
    quarantine: false,
    reasons,
  };
}
