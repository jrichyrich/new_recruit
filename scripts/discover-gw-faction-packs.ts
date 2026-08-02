import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOWNLOADS_PAGE_URL =
  "https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/";
const DOWNLOADS_API_URL =
  "https://www.warhammer-community.com/api/search/downloads/";
const ASSET_ORIGIN = "https://assets.warhammer-community.com/";
const requestBody = {
  index: "downloads_v2",
  searchTerm: "",
  gameSystem: "warhammer-40000",
  language: "english",
} as const;

export type GwFactionPackDiscoveryV1 = {
  schemaVersion: 1;
  discoveredAt: string;
  source: {
    pageUrl: typeof DOWNLOADS_PAGE_URL;
    apiUrl: typeof DOWNLOADS_API_URL;
    request: typeof requestBody;
    totalHits: number;
    response: {
      byteLength: number;
      contentSha256: string;
    };
    inventorySha256: string;
  };
  factionPacks: Array<{
    title: string;
    slug: string;
    objectId: string;
    lastUpdated: string;
    assetUrl: string;
  }>;
  warnings: Array<{
    code: "DUPLICATE_SOURCE_SLUG";
    slug: string;
    titles: string[];
  }>;
};

const usage = `Usage:
  node --import tsx scripts/discover-gw-faction-packs.ts \\
    [--response <downloads-api.json>] [--out <candidate.json>] \\
    [--discovered-at <ISO instant>]

Queries the same official Games Workshop endpoint used by the Warhammer 40,000
Downloads page, or parses a saved response for review. The output is an unsigned
discovery candidate. It does not classify units or authorize publication.
`;

function requiredRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  context: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, context: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${context} must be an array of strings.`);
  }
  return value;
}

function optionalValue(
  argv: readonly string[],
  option: string,
): string | null {
  const index = argv.indexOf(option);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function officialAssetUrl(file: unknown, context: string): string {
  const filename = requiredString(file, `${context}.file`);
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    !filename.toLowerCase().endsWith(".pdf")
  ) {
    throw new Error(`${context}.file must be a PDF filename, not a path.`);
  }
  const url = new URL(filename, ASSET_ORIGIN);
  if (url.origin !== new URL(ASSET_ORIGIN).origin) {
    throw new Error(`${context}.file does not resolve to the official asset origin.`);
  }
  return url.toString();
}

export function parseGwFactionPackDiscovery(
  value: unknown,
  discoveredAt: string,
  responseBytes: Uint8Array = new TextEncoder().encode(JSON.stringify(value)),
): GwFactionPackDiscoveryV1 {
  const root = requiredRecord(value, "Downloads API response");
  if (!Array.isArray(root.hits)) {
    throw new Error("Downloads API response.hits must be an array.");
  }
  const totalHits = root.totalHits;
  const totalPages = root.totalPages;
  if (!Number.isInteger(totalHits) || (totalHits as number) < 0) {
    throw new Error("Downloads API response.totalHits must be a non-negative integer.");
  }
  if (totalPages !== 1 || totalHits !== root.hits.length) {
    throw new Error(
      "The Downloads API response is incomplete or paginated; refusing a partial faction-pack inventory.",
    );
  }

  const factionPacks = root.hits.flatMap((rawHit, index) => {
    const hit = requiredRecord(rawHit, `hits[${index}]`);
    const categories = stringArray(
      hit.download_categories,
      `hits[${index}].download_categories`,
    );
    if (!categories.includes("faction-packs")) return [];
    if (
      hit.locale !== "en-gb" ||
      hit.download_languages !== "english" ||
      hit.game_systems !== "warhammer-40000"
    ) {
      throw new Error(
        `hits[${index}] is a faction pack outside the requested English Warhammer 40,000 scope.`,
      );
    }
    const id = requiredRecord(hit.id, `hits[${index}].id`);
    const title = requiredString(hit.title, `hits[${index}].title`);
    const idTitle = requiredString(id.title, `hits[${index}].id.title`);
    if (title !== idTitle || !title.startsWith("Faction Pack: ")) {
      throw new Error(`hits[${index}] has inconsistent faction-pack titles.`);
    }
    const slug = requiredString(id.slug, `hits[${index}].id.slug`);
    if (!slug.startsWith("faction-pack-")) {
      throw new Error(`hits[${index}].id.slug is not a faction-pack slug.`);
    }
    const idCategories = id.download_categories;
    if (
      !Array.isArray(idCategories) ||
      !idCategories.some((category) => {
        const candidate = requiredRecord(
          category,
          `hits[${index}].id.download_categories[]`,
        );
        return candidate.slug === "faction-packs";
      })
    ) {
      throw new Error(
        `hits[${index}].id does not retain the Faction Packs category.`,
      );
    }
    return [{
      title,
      slug,
      objectId: requiredString(hit.objectID, `hits[${index}].objectID`),
      lastUpdated: requiredString(
        id.last_updated,
        `hits[${index}].id.last_updated`,
      ),
      assetUrl: officialAssetUrl(id.file, `hits[${index}].id`),
    }];
  });

  if (factionPacks.length === 0) {
    throw new Error("The official response contains no English faction packs.");
  }
  const slugs = new Map<string, string[]>();
  const titles = new Set<string>();
  const objectIds = new Set<string>();
  const assetUrls = new Set<string>();
  for (const pack of factionPacks) {
    if (
      titles.has(pack.title) ||
      objectIds.has(pack.objectId) ||
      assetUrls.has(pack.assetUrl)
    ) {
      throw new Error(
        `The official response contains a duplicate faction pack: ${pack.title}.`,
      );
    }
    slugs.set(pack.slug, [...(slugs.get(pack.slug) ?? []), pack.title]);
    titles.add(pack.title);
    objectIds.add(pack.objectId);
    assetUrls.add(pack.assetUrl);
  }

  const sortedFactionPacks = factionPacks.sort((left, right) =>
    left.title.localeCompare(right.title));
  const warnings: GwFactionPackDiscoveryV1["warnings"] = [];
  for (const [slug, sourceTitles] of slugs) {
    if (sourceTitles.length > 1) {
      warnings.push({
        code: "DUPLICATE_SOURCE_SLUG",
        slug,
        titles: [...sourceTitles].sort((left, right) =>
          left.localeCompare(right)),
      });
    }
  }
  const sourceBytes = Buffer.from(responseBytes);
  return {
    schemaVersion: 1,
    discoveredAt: new Date(discoveredAt).toISOString(),
    source: {
      pageUrl: DOWNLOADS_PAGE_URL,
      apiUrl: DOWNLOADS_API_URL,
      request: requestBody,
      totalHits: totalHits as number,
      response: {
        byteLength: sourceBytes.byteLength,
        contentSha256: createHash("sha256")
          .update(sourceBytes)
          .digest("hex"),
      },
      inventorySha256: createHash("sha256")
        .update(JSON.stringify(sortedFactionPacks))
        .digest("hex"),
    },
    factionPacks: sortedFactionPacks,
    warnings: warnings.sort((left, right) =>
      left.slug.localeCompare(right.slug)),
  };
}

type OfficialDownloadsResponse = {
  value: unknown;
  bytes: Uint8Array;
};

async function fetchOfficialDownloads(): Promise<OfficialDownloadsResponse> {
  const response = await fetch(DOWNLOADS_API_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `Games Workshop Downloads discovery returned HTTP ${response.status}.`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(
      `Games Workshop Downloads discovery returned ${contentType || "no content type"}, not JSON.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    bytes,
  };
}

export async function runGwFactionPackDiscovery(
  argv: readonly string[] = process.argv.slice(2),
  options: {
    writeOutput?: (value: string) => void;
    fetchResponse?: () => Promise<OfficialDownloadsResponse>;
  } = {},
): Promise<GwFactionPackDiscoveryV1 | null> {
  const writeOutput =
    options.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (argv.includes("--help") || argv.includes("-h")) {
    writeOutput(usage);
    return null;
  }
  const responseFile = optionalValue(argv, "--response");
  const output = optionalValue(argv, "--out");
  const discoveredAt =
    optionalValue(argv, "--discovered-at") ?? new Date().toISOString();
  const response = responseFile
    ? (() => {
        const bytes = readFileSync(path.resolve(responseFile));
        return {
          value: JSON.parse(bytes.toString("utf8")),
          bytes,
        };
      })()
    : await (options.fetchResponse ?? fetchOfficialDownloads)();
  const result = parseGwFactionPackDiscovery(
    response.value,
    discoveredAt,
    response.bytes,
  );
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (!output) {
    writeOutput(serialized);
    return result;
  }
  const filename = path.resolve(output);
  if (existsSync(filename)) {
    throw new Error(`Discovery candidate already exists: ${filename}.`);
  }
  writeFileSync(filename, serialized, { flag: "wx", mode: 0o600 });
  writeOutput(
    `${JSON.stringify({
      ok: true,
      trusted: false,
      filename,
      factionPackCount: result.factionPacks.length,
    }, null, 2)}\n`,
  );
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runGwFactionPackDiscovery();
}
