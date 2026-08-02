import { normalizeName } from "@alpaca-software/40kdc-data";

import { factions } from "./runtime-dataset";

export type FactionResolutionStatus =
  | "resolved"
  | "ambiguous"
  | "missing"
  | "unsupported";

export type FactionResolutionSuggestion = {
  factionId: string;
  factionName: string;
  matchedText: string;
  matchKind: "canonical-id" | "canonical-name" | "alias" | "fuzzy";
  confidence: number;
};

type FactionIntentResolutionBase = {
  status: FactionResolutionStatus;
  code:
    | null
    | "FACTION_REQUIRED"
    | "FACTION_UNSUPPORTED"
    | "AMBIGUOUS_PLAYER_FACTION"
    | "FACTION_CONFLICT";
  message: string;
  suggestions: FactionResolutionSuggestion[];
  opponentFactionIds: string[];
};

export type FactionIntentResolution =
  | (FactionIntentResolutionBase & {
      status: "resolved";
      code: null;
      factionId: string;
      factionName: string;
      source: "structured" | "prompt";
    })
  | (FactionIntentResolutionBase & {
      status: "ambiguous" | "missing" | "unsupported";
      code: Exclude<FactionIntentResolutionBase["code"], null>;
      factionId?: never;
      factionName?: never;
      source?: never;
    });

export type FactionMention = {
  factionId: string;
  factionName: string;
  matchedText: string;
  start: number;
  end: number;
  role: "player" | "opponent" | "unclassified";
};

export type ResolveFactionIntentInput = {
  prompt?: string;
  playerFaction?: string;
  /** Compatibility selector used by existing build inputs. */
  faction?: string;
  opponentFaction?: string;
};

type AliasDefinition = {
  text: string;
  promptSafe?: boolean;
};

/**
 * Deliberately small and reviewed. Catalogue-provided aliases are included
 * separately; this list must never grow from fuzzy matches or user prompts.
 */
const REVIEWED_FACTION_ALIASES: Readonly<
  Record<string, readonly (string | AliasDefinition)[]>
> = {
  "adepta-sororitas": ["Sororitas", "Sisters of Battle"],
  "adeptus-astartes": [
    "Space Marines",
    { text: "Marines", promptSafe: false },
  ],
  "adeptus-custodes": ["Custodes", "Golden Boys"],
  "adeptus-mechanicus": ["Mechanicus", "AdMech", "Ad Mech"],
  aeldari: ["Eldar", "Craftworld Eldar", "Craftworlds"],
  "agents-of-the-imperium": ["Imperial Agents"],
  "astra-militarum": ["Imperial Guard", "Guard"],
  "chaos-space-marines": ["Chaos Marines", "CSM"],
  drukhari: ["Dark Eldar"],
  "genestealer-cults": ["GSC"],
  "leagues-of-votann": ["Votann"],
  "tau-empire": ["Tau", "T'au", "T’au", "T Au"],
  tyranids: ["Nids"],
};

type FactionPhrase = {
  factionId: string;
  factionName: string;
  phrase: string;
  normalized: string;
  matchKind: Exclude<FactionResolutionSuggestion["matchKind"], "fuzzy">;
  promptSafe: boolean;
};

function normalizedText(value: string): string {
  return normalizeName(value.replaceAll("-", " "))
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phrasePriority(
  kind: Exclude<FactionResolutionSuggestion["matchKind"], "fuzzy">,
): number {
  if (kind === "canonical-id") return 3;
  if (kind === "canonical-name") return 2;
  return 1;
}

function factionPhrases(): FactionPhrase[] {
  const phrases: FactionPhrase[] = [];
  for (const faction of factions.all) {
    const add = (
      phrase: string,
      matchKind: FactionPhrase["matchKind"],
      promptSafe = true,
    ) => {
      const normalized = normalizedText(phrase);
      if (!normalized) return;
      phrases.push({
        factionId: faction.id,
        factionName: faction.name,
        phrase,
        normalized,
        matchKind,
        promptSafe,
      });
    };
    add(faction.id, "canonical-id");
    add(faction.name, "canonical-name");
    for (const alias of faction.raw.aliases ?? []) {
      add(alias, "alias");
    }
    for (const definition of REVIEWED_FACTION_ALIASES[faction.id] ?? []) {
      if (typeof definition === "string") {
        add(definition, "alias");
      } else {
        add(definition.text, "alias", definition.promptSafe !== false);
      }
    }
  }
  return phrases;
}

function uniqueSuggestions(
  suggestions: FactionResolutionSuggestion[],
): FactionResolutionSuggestion[] {
  const byFaction = new Map<string, FactionResolutionSuggestion>();
  for (const suggestion of suggestions) {
    const current = byFaction.get(suggestion.factionId);
    if (
      !current ||
      suggestion.confidence > current.confidence ||
      (suggestion.confidence === current.confidence &&
        suggestion.matchedText.length > current.matchedText.length)
    ) {
      byFaction.set(suggestion.factionId, suggestion);
    }
  }
  return [...byFaction.values()].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.factionName.localeCompare(right.factionName),
  );
}

export function resolveExactFactionReference(
  query: string | undefined,
): FactionResolutionSuggestion | null {
  const normalized = normalizedText(query ?? "");
  if (!normalized) return null;
  const matches = uniqueSuggestions(
    factionPhrases()
      .filter((entry) => entry.normalized === normalized)
      .map((entry) => ({
        factionId: entry.factionId,
        factionName: entry.factionName,
        matchedText: entry.phrase,
        matchKind: entry.matchKind,
        confidence: 1,
      })),
  );
  return matches.length === 1 ? matches[0] : null;
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function similarity(left: string, right: string): number {
  const distance = editDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length, 1);
}

function fuzzySimilarity(query: string, candidate: string): number {
  const direct = similarity(query, candidate);
  const queryTokens = query.split(" ").filter(Boolean);
  const candidateTokens = candidate.split(" ").filter(Boolean);
  const tokenScore = queryTokens.reduce((best, queryToken) => {
    return Math.max(
      best,
      ...candidateTokens.map((candidateToken) =>
        similarity(queryToken, candidateToken),
      ),
    );
  }, 0);
  return Math.max(direct, tokenScore * 0.9);
}

function candidateFactionText(prompt: string): string | null {
  const normalized = normalizedText(prompt);
  const match = normalized.match(
    /\b(?:build|make|create)\s+(.+?)\s+(?:army|roster|list|force)\b/,
  );
  const candidate = (match?.[1] ?? "")
    .replace(
      /\b(?:me|a|an|\d{3,4}|points?|pts?|fast|mobile|durable|tough|competitive|casual|balanced|shooting|ranged|melee|elite|horde|objective|scoring|legal|matched play)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (candidate) return candidate;
  if (
    normalized &&
    !/\b(?:build|make|create|army|roster|list|force|points?|pts?)\b/.test(
      normalized,
    ) &&
    normalized.split(" ").length <= 5
  ) {
    return normalized;
  }
  return null;
}

export function suggestFactions(
  query: string,
  limit = 3,
): FactionResolutionSuggestion[] {
  const normalized = normalizedText(query);
  if (!normalized) return [];
  return uniqueSuggestions(
    factionPhrases().map((entry) => ({
      factionId: entry.factionId,
      factionName: entry.factionName,
      matchedText: entry.phrase,
      matchKind: "fuzzy" as const,
      confidence: Number(
        fuzzySimilarity(normalized, entry.normalized).toFixed(3),
      ),
    })),
  )
    .filter((entry) => entry.confidence >= 0.42)
    .slice(0, Math.max(1, Math.min(limit, 10)));
}

function mentionRole(
  prompt: string,
  start: number,
  end: number,
): FactionMention["role"] {
  const prefix = prompt
    .slice(Math.max(0, start - 72), start)
    .trimEnd();
  const suffix = prompt
    .slice(end, Math.min(prompt.length, end + 32))
    .trimStart();
  if (
    /\b(?:against|versus|vs|facing|face|fight|fighting|battle|beat|counter(?:ing)?(?:\s+(?:to|against))?|into)(?:\s+(?:a|an|the|unknown|known))*$/.test(
      prefix,
    )
  ) {
    return "opponent";
  }
  if (/^(?:army|roster|list|force)\b/.test(suffix)) {
    return "player";
  }
  if (
    /\b(?:using|with|as|play)\s*(?:an?\s+)?$/.test(prefix) ||
    /\b(?:build|make|create)\b[^.;,:!?]{0,64}$/.test(prefix)
  ) {
    return "player";
  }
  return "unclassified";
}

export function findFactionMentions(prompt: string): FactionMention[] {
  const normalizedPrompt = normalizedText(prompt);
  if (!normalizedPrompt) return [];
  const candidates: Array<Omit<FactionMention, "role"> & { priority: number }> = [];
  for (const phrase of factionPhrases().filter((entry) => entry.promptSafe)) {
    const pattern = new RegExp(
      `(?:^| )${phrase.normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?= |$)`,
      "g",
    );
    for (const match of normalizedPrompt.matchAll(pattern)) {
      const leadingSpace = match[0].startsWith(" ") ? 1 : 0;
      const start = (match.index ?? 0) + leadingSpace;
      const end = start + phrase.normalized.length;
      candidates.push({
        factionId: phrase.factionId,
        factionName: phrase.factionName,
        matchedText: phrase.phrase,
        start,
        end,
        priority: phrasePriority(phrase.matchKind),
      });
    }
  }
  const selected: typeof candidates = [];
  for (const candidate of candidates.sort(
    (left, right) =>
      right.end - right.start - (left.end - left.start) ||
      right.priority - left.priority ||
      left.start - right.start,
  )) {
    if (
      selected.some(
        (existing) =>
          candidate.start < existing.end && candidate.end > existing.start,
      )
    ) {
      continue;
    }
    selected.push(candidate);
  }
  const ordered = selected.sort(
    (left, right) => left.start - right.start || left.factionId.localeCompare(right.factionId),
  );
  const versusConnector = /\b(?:against|versus|vs)\b/g;
  const connectorPositions = [
    ...normalizedPrompt.matchAll(versusConnector),
  ].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  return ordered.map((mention) => {
    let role = mentionRole(normalizedPrompt, mention.start, mention.end);
    if (role === "unclassified") {
      const connector = connectorPositions.find(
        (entry) =>
          ordered.some((other) => other.end <= entry.start) &&
          ordered.some((other) => other.start >= entry.end),
      );
      if (connector) {
        role = mention.end <= connector.start ? "player" : "opponent";
      }
    }
    return {
      factionId: mention.factionId,
      factionName: mention.factionName,
      matchedText: mention.matchedText,
      start: mention.start,
      end: mention.end,
      role,
    };
  });
}

function exactSuggestionsForIds(
  factionIds: Iterable<string>,
): FactionResolutionSuggestion[] {
  const ids = new Set(factionIds);
  return factions.all
    .filter((faction) => ids.has(faction.id))
    .map((faction) => ({
      factionId: faction.id,
      factionName: faction.name,
      matchedText: faction.name,
      matchKind: "canonical-name" as const,
      confidence: 1,
    }))
    .sort((left, right) => left.factionName.localeCompare(right.factionName));
}

export function resolveFactionIntent(
  input: ResolveFactionIntentInput,
): FactionIntentResolution {
  const structuredQueries = [input.playerFaction, input.faction].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  const unsupportedStructured = structuredQueries.find(
    (query) => resolveExactFactionReference(query) === null,
  );
  if (unsupportedStructured) {
    return {
      status: "unsupported",
      code: "FACTION_UNSUPPORTED",
      message: `No supported faction exactly matches "${unsupportedStructured}". Choose a canonical faction or one of the suggestions.`,
      suggestions: suggestFactions(unsupportedStructured),
      opponentFactionIds: [],
    };
  }
  const structuredMatches = uniqueSuggestions(
    structuredQueries.flatMap((query) => {
      const match = resolveExactFactionReference(query);
      return match ? [match] : [];
    }),
  );
  if (structuredMatches.length > 1) {
    return {
      status: "ambiguous",
      code: "FACTION_CONFLICT",
      message: "The structured player-faction fields resolve to different factions.",
      suggestions: structuredMatches,
      opponentFactionIds: [],
    };
  }

  const opponentMatch = input.opponentFaction
    ? resolveExactFactionReference(input.opponentFaction)
    : null;
  const mentions = input.prompt ? findFactionMentions(input.prompt) : [];
  const opponentFactionIds = [
    ...new Set([
      ...(opponentMatch ? [opponentMatch.factionId] : []),
      ...mentions
        .filter((mention) => mention.role === "opponent")
        .map((mention) => mention.factionId),
    ]),
  ].sort();
  let playerMentions = mentions.filter(
    (mention) => mention.role === "player",
  );
  const unclassified = mentions.filter(
    (mention) => mention.role === "unclassified",
  );
  if (playerMentions.length === 0) {
    const available = unclassified.filter(
      (mention) => !opponentFactionIds.includes(mention.factionId),
    );
    if (available.length === 1) playerMentions = available;
    else if (available.length > 1) playerMentions = available;
  }
  const playerIds = [...new Set(playerMentions.map((mention) => mention.factionId))];
  const structured = structuredMatches[0];
  if (
    structured &&
    playerIds.some((factionId) => factionId !== structured.factionId)
  ) {
    return {
      status: "ambiguous",
      code: "FACTION_CONFLICT",
      message: `The structured player faction (${structured.factionName}) conflicts with the player faction named in the prompt (${exactSuggestionsForIds(playerIds).map((entry) => entry.factionName).join(", ")}).`,
      suggestions: uniqueSuggestions([
        structured,
        ...exactSuggestionsForIds(playerIds),
      ]),
      opponentFactionIds,
    };
  }
  if (structured) {
    return {
      status: "resolved",
      code: null,
      message: `Resolved the player faction to ${structured.factionName} from the structured selector.`,
      factionId: structured.factionId,
      factionName: structured.factionName,
      source: "structured",
      suggestions: [structured],
      opponentFactionIds,
    };
  }
  if (playerIds.length > 1) {
    const suggestions = exactSuggestionsForIds(playerIds);
    return {
      status: "ambiguous",
      code: "AMBIGUOUS_PLAYER_FACTION",
      message: `The prompt names multiple possible player factions (${suggestions.map((entry) => entry.factionName).join(", ")}). Supply playerFaction explicitly.`,
      suggestions,
      opponentFactionIds,
    };
  }
  if (playerIds.length === 1) {
    const [suggestion] = exactSuggestionsForIds(playerIds);
    return {
      status: "resolved",
      code: null,
      message: `Resolved the player faction to ${suggestion.factionName} from the prompt.`,
      factionId: suggestion.factionId,
      factionName: suggestion.factionName,
      source: "prompt",
      suggestions: [suggestion],
      opponentFactionIds,
    };
  }

  const attemptedFaction = input.prompt
    ? candidateFactionText(input.prompt)
    : null;
  if (attemptedFaction) {
    return {
      status: "unsupported",
      code: "FACTION_UNSUPPORTED",
      message: `No supported faction exactly matches "${attemptedFaction}". Fuzzy or voice-like matches require confirmation.`,
      suggestions: suggestFactions(attemptedFaction),
      opponentFactionIds,
    };
  }
  return {
    status: "missing",
    code: "FACTION_REQUIRED",
    message: "A player faction is required before RosterPilot can build an army.",
    suggestions: [],
    opponentFactionIds,
  };
}
