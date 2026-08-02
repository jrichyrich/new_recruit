import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTRACTOR_ID = "rosterpilot-gw-faction-pack-legends";
const EXTRACTOR_VERSION = "1";

export type GwLegendsFactionPackUnitV1 = {
  name: string;
  pdfPages: number[];
};

export type GwLegendsFactionPackExtractionV1 = {
  schemaVersion: 1;
  documentKind: "faction-pack";
  gameEdition: string;
  factionId: string;
  factionName: string;
  packVersion: string;
  legalFrom: string;
  coverage: "complete";
  legendUnits: GwLegendsFactionPackUnitV1[];
  source: {
    url: string;
    byteLength: number;
    contentSha256: string;
  };
  extraction: {
    extractor: typeof EXTRACTOR_ID;
    extractorVersion: typeof EXTRACTOR_VERSION;
    extractedAt: string;
    method: "pdftotext-layout-title-marker-v1";
  };
};

const usage = `Usage:
  node --import tsx scripts/extract-gw-legends-faction-pack.ts \\
    --pdf <faction-pack.pdf> --faction-id <id> --game-edition <edition> \\
    --source-url <url> \\
    [--out <candidate.json>] [--allow-empty] [--extracted-at <ISO instant>]

Extracts only faction-pack metadata and datasheet titles whose pages carry the
WARHAMMER LEGENDS marker. The result is an unsigned review candidate, not
trusted Games Workshop evidence. Publication still requires independent
review, a signed extraction receipt, and a registered extractor key.
`;

const legendsMarker =
  /W\s*A\s*R\s*H\s*A\s*M\s*M\s*E\s*R\s+L\s*E\s*G\s*E\s*N\s*D\s*S/i;
const monthNumbers: Readonly<Record<string, string>> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

function requiredValue(
  argv: readonly string[],
  option: string,
): string {
  const index = argv.indexOf(option);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
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

function normalizedTitle(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function officialAssetUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    ![
      "assets.warhammer-community.com",
      "www.warhammer-community.com",
      "warhammer-community.com",
    ].includes(url.hostname)
  ) {
    throw new Error(
      "--source-url must be an official Warhammer Community HTTPS asset URL.",
    );
  }
  return url.toString();
}

function isoLegalFrom(value: string): string {
  const match = normalizedTitle(value).match(
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/,
  );
  const month = match ? monthNumbers[match[2].toLowerCase()] : null;
  if (!match || !month) {
    throw new Error(
      `The Faction Pack matched-play date could not be parsed: ${value}.`,
    );
  }
  const day = match[1].padStart(2, "0");
  const result = `${match[3]}-${month}-${day}`;
  if (
    !new Date(`${result}T00:00:00.000Z`)
      .toISOString()
      .startsWith(result)
  ) {
    throw new Error(
      `The Faction Pack matched-play date is invalid: ${value}.`,
    );
  }
  return result;
}

function factionPackMetadata(firstPage: string): {
  factionName: string;
  packVersion: string;
  legalFrom: string;
} {
  const lines = firstPage
    .split(/\r?\n/)
    .map(normalizedTitle)
    .filter(Boolean);
  const packLine = lines.findIndex((line) =>
    /FACTION\s+PACK:\s*VERSION/i.test(line),
  );
  if (packLine <= 0) {
    throw new Error(
      "The PDF text does not contain a faction name followed by a Faction Pack version.",
    );
  }
  const factionName = lines[packLine - 1];
  const version = lines[packLine].match(
    /FACTION\s+PACK:\s*VERSION\s+([^\s]+)/i,
  )?.[1];
  if (!version) {
    throw new Error("The Faction Pack version could not be parsed.");
  }
  const legalFrom = firstPage.match(
    /Legal\s+for\s+matched\s+play\s+from\s+([^\r\n]+)/i,
  )?.[1];
  if (!legalFrom) {
    throw new Error(
      "The PDF text does not contain a Faction Pack matched-play effective date.",
    );
  }
  return {
    factionName,
    packVersion: normalizedTitle(version),
    legalFrom: isoLegalFrom(legalFrom),
  };
}

export function extractGwLegendsFactionPackText(input: {
  text: string;
  factionId: string;
  gameEdition: string;
  sourceUrl: string;
  sourceBytes: Uint8Array;
  extractedAt: string;
  allowEmpty?: boolean;
}): GwLegendsFactionPackExtractionV1 {
  const pages = input.text.split("\f");
  if (pages.length < 2) {
    throw new Error(
      "The extracted text has no PDF page boundaries; run pdftotext without -nopgbrk.",
    );
  }
  const metadata = factionPackMetadata(pages[0]);
  const contentsDeclareLegends = /Legends\s+Datasheets/i.test(
    pages[0],
  );
  const found = new Map<string, Set<number>>();
  for (const [pageIndex, page] of pages.entries()) {
    // The first page of every datasheet carries the six characteristic
    // headings. Restricting title extraction to that page avoids treating a
    // Legends armoury card or a prose mention of "Warhammer Legends" as a
    // unit, and it avoids singular/plural heading drift on continuation pages.
    if (!/\bM\s+T\s+SV\s+W\s+LD\s+OC\b/.test(page)) continue;
    for (const line of page.split(/\r?\n/)) {
      const marker = legendsMarker.exec(line);
      if (!marker) continue;
      const title = normalizedTitle(line.slice(0, marker.index));
      if (!title) {
        throw new Error(
          `A WARHAMMER LEGENDS marker on PDF page ${pageIndex + 1} has no datasheet title.`,
        );
      }
      if (found.has(title)) {
        throw new Error(
          `Datasheet title ${title} appears on more than one characteristic page.`,
        );
      }
      found.set(title, new Set([pageIndex + 1]));
    }
  }
  if (contentsDeclareLegends && found.size === 0) {
    throw new Error(
      "The contents declare Legends Datasheets, but no marked datasheet title was extracted.",
    );
  }
  if (!input.allowEmpty && found.size === 0) {
    throw new Error(
      "No Legends datasheets were found. Pass --allow-empty only after reviewing a faction pack that publishes none.",
    );
  }
  const sourceBytes = Buffer.from(input.sourceBytes);
  return {
    schemaVersion: 1,
    documentKind: "faction-pack",
    gameEdition: normalizedTitle(input.gameEdition),
    factionId: input.factionId,
    ...metadata,
    coverage: "complete",
    legendUnits: [...found.entries()]
      .map(([name, pdfPages]) => ({
        name,
        pdfPages: [...pdfPages].sort((left, right) => left - right),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    source: {
      url: officialAssetUrl(input.sourceUrl),
      byteLength: sourceBytes.byteLength,
      contentSha256: createHash("sha256")
        .update(sourceBytes)
        .digest("hex"),
    },
    extraction: {
      extractor: EXTRACTOR_ID,
      extractorVersion: EXTRACTOR_VERSION,
      extractedAt: new Date(input.extractedAt).toISOString(),
      method: "pdftotext-layout-title-marker-v1",
    },
  };
}

export function runGwLegendsFactionPackExtractor(
  argv: readonly string[] = process.argv.slice(2),
  options: {
    writeOutput?: (value: string) => void;
    convertPdf?: (filename: string) => string;
  } = {},
): GwLegendsFactionPackExtractionV1 | null {
  const writeOutput =
    options.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (argv.includes("--help") || argv.includes("-h")) {
    writeOutput(usage);
    return null;
  }
  const pdf = path.resolve(requiredValue(argv, "--pdf"));
  const factionId = requiredValue(argv, "--faction-id");
  const gameEdition = requiredValue(argv, "--game-edition");
  const sourceUrl = requiredValue(argv, "--source-url");
  const output = optionalValue(argv, "--out");
  const extractedAt =
    optionalValue(argv, "--extracted-at") ?? new Date().toISOString();
  const sourceBytes = readFileSync(pdf);
  const text = options.convertPdf
    ? options.convertPdf(pdf)
    : execFileSync("pdftotext", ["-layout", pdf, "-"], {
        encoding: "utf8",
      });
  const result = extractGwLegendsFactionPackText({
    text,
    factionId,
    gameEdition,
    sourceUrl,
    sourceBytes,
    extractedAt,
    allowEmpty: argv.includes("--allow-empty"),
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (!output) {
    writeOutput(serialized);
    return result;
  }
  const filename = path.resolve(output);
  if (existsSync(filename)) {
    throw new Error(`Extraction candidate already exists: ${filename}.`);
  }
  writeFileSync(filename, serialized, { flag: "wx", mode: 0o600 });
  writeOutput(
    `${JSON.stringify({
      ok: true,
      trusted: false,
      filename,
      factionId: result.factionId,
      legendUnitCount: result.legendUnits.length,
      sourceArtifactSha256: result.source.contentSha256,
    }, null, 2)}\n`,
  );
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runGwLegendsFactionPackExtractor();
}
