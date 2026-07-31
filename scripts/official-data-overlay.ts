import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OfficialExtractorTrustRegistryV1Schema,
  OfficialExtractionReceiptV1Schema,
  verifyOfficialPublicationEvidence,
  verifyOfficialRulesOverlayCoverage,
} from "../lib/rosterpilot/official-data";
import {
  semanticHash,
} from "../lib/rosterpilot/semantic-hash";

const usage = `Usage:
  npm run data:official-overlay -- template --out <path>
  npm run data:official-overlay -- check --file <path> \\
    --source-artifact <path> --receipt <path> \\
    [--trusted-extractors <path>]

"template" writes a source-bound but deliberately non-publishable schema-v1
overlay skeleton. Populate it from a reviewed machine-verifiable extractor,
including complete coverage receipts. Publication additionally requires the
exact downloaded source artifact and a signed inventory receipt from a key in
data/official-extractor-trusted-keys.json (or --trusted-extractors).
`;

function value(
  argv: readonly string[],
  option: string,
): string | null {
  const index = argv.indexOf(option);
  if (index === -1) return null;
  const found = argv[index + 1];
  if (!found || found.startsWith("--")) {
    throw new Error(`${option} requires a path.`);
  }
  return found;
}

function resolved(root: string, filename: string): string {
  return path.isAbsolute(filename)
    ? path.normalize(filename)
    : path.resolve(root, filename);
}

export async function officialOverlayTemplate(root: string) {
  const sources = JSON.parse(
    readFileSync(path.join(root, "data", "sources.json"), "utf8"),
  ) as {
    official?: {
      mfmVersion?: string;
      contentSha256?: string;
      mfmUrl?: string;
    };
  };
  const official = sources.official;
  if (
    !official?.mfmVersion ||
    !official.contentSha256 ||
    !official.mfmUrl
  ) {
    throw new Error(
      "data/sources.json has no complete official MFM provenance.",
    );
  }
  const emptyHash = await semanticHash([]);
  const emptyCoverage = {
    status: "not-published" as const,
    sourceEntityCount: 0,
    extractedEntityCount: 0,
    payloadSha256: emptyHash,
  };
  return {
    schemaVersion: 1 as const,
    authority: "games-workshop" as const,
    source: {
      version: official.mfmVersion,
      contentSha256: official.contentSha256,
      url: official.mfmUrl,
      extractedAt: new Date().toISOString(),
      extractor: "REPLACE_WITH_REVIEWED_EXTRACTOR_ID",
      extractorVersion: "REPLACE_WITH_EXTRACTOR_VERSION",
    },
    coverage: {
      // MFM unitPoints must become complete and non-empty before check passes.
      unitPoints: emptyCoverage,
      leaderLinks: emptyCoverage,
      detachments: emptyCoverage,
      enhancementPoints: emptyCoverage,
    },
    unitPoints: [],
    leaderLinks: [],
    detachments: [],
    enhancementPoints: [],
  };
}

export async function runOfficialDataOverlayCli(
  argv: readonly string[] = process.argv.slice(2),
  options: { root?: string; writeOutput?: (value: string) => void } = {},
): Promise<void> {
  const root = path.resolve(options.root ?? process.cwd());
  const writeOutput =
    options.writeOutput ?? ((text: string) => process.stdout.write(text));
  if (argv.includes("--help") || argv.includes("-h")) {
    writeOutput(usage);
    return;
  }
  const command = argv[0];
  if (command === "template") {
    const output = value(argv, "--out");
    if (!output) throw new Error("template requires --out <path>.");
    const filename = resolved(root, output);
    if (existsSync(filename)) {
      throw new Error(
        `Official overlay template already exists: ${filename}.`,
      );
    }
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(
      filename,
      `${JSON.stringify(await officialOverlayTemplate(root), null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    writeOutput(
      `${JSON.stringify({
        ok: true,
        publishable: false,
        filename,
        nextCommand:
          `npm run data:official-overlay -- check --file ${filename} ` +
          "--source-artifact <downloaded-source> --receipt <signed-receipt>",
      }, null, 2)}\n`,
    );
    return;
  }
  if (command === "check") {
    const input = value(argv, "--file");
    if (!input) throw new Error("check requires --file <path>.");
    const filename = resolved(root, input);
    const sourceArtifactInput = value(argv, "--source-artifact");
    const receiptInput = value(argv, "--receipt");
    if (!sourceArtifactInput || !receiptInput) {
      throw new Error(
        "check requires --source-artifact <path> and --receipt <path>; self-declared overlay counts cannot authorize publication.",
      );
    }
    const trustedExtractorsInput =
      value(argv, "--trusted-extractors") ??
      "data/official-extractor-trusted-keys.json";
    const overlayInput = JSON.parse(readFileSync(filename, "utf8"));
    const overlay = await verifyOfficialRulesOverlayCoverage(overlayInput);
    const receipt = OfficialExtractionReceiptV1Schema.parse(
      JSON.parse(
        readFileSync(resolved(root, receiptInput), "utf8"),
      ),
    );
    const trustedExtractors =
      OfficialExtractorTrustRegistryV1Schema.parse(
        JSON.parse(
          readFileSync(
            resolved(root, trustedExtractorsInput),
            "utf8",
          ),
        ),
      );
    const verified = await verifyOfficialPublicationEvidence({
      overlay,
      sourceArtifact: readFileSync(
        resolved(root, sourceArtifactInput),
      ),
      extractionReceipt: receipt,
      trustedExtractors,
    });
    writeOutput(
      `${JSON.stringify({
        ok: true,
        publishable: true,
        filename,
        overlayHash: await semanticHash(overlay),
        exactOverlaySha256: verified.overlaySha256,
        sourceArtifactSha256: verified.sourceArtifactSha256,
        extractorId: verified.extractorId,
        extractorKeyId: verified.extractorKeyId,
        source: overlay.source,
        affectedFactions: [
          ...new Set([
            ...overlay.unitPoints.map((entry) => entry.factionId),
            ...overlay.leaderLinks.map((entry) => entry.factionId),
            ...overlay.detachments.map((entry) => entry.factionId),
            ...overlay.enhancementPoints.map(
              (entry) => entry.factionId,
            ),
          ]),
        ].sort(),
      }, null, 2)}\n`,
    );
    return;
  }
  throw new Error("Expected official overlay command template or check.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runOfficialDataOverlayCli();
}
