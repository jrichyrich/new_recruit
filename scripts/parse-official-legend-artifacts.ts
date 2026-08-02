import path from "node:path";
import { fileURLToPath } from "node:url";

export type OfficialLegendArtifactInput = {
  sourceId: string;
  artifactInput: string;
};

/**
 * Parse the single-string GitHub workflow input into the repeatable keyed
 * artifact contract used by the release CLIs. A JSON array preserves duplicate
 * detection while remaining practical in workflow_dispatch's one-line field.
 */
export function parseOfficialLegendArtifactInput(
  raw: string,
): OfficialLegendArtifactInput[] {
  if (!raw.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "Official Legends artifacts must be a valid JSON array.",
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(
      "Official Legends artifacts must be a JSON array.",
    );
  }
  const seen = new Set<string>();
  return value.map((entry): OfficialLegendArtifactInput => {
    if (typeof entry !== "string") {
      throw new Error(
        "Each official Legends artifact entry must be a string.",
      );
    }
    const separator = entry.indexOf("=");
    const sourceId = entry.slice(0, separator).trim();
    const artifactInput = entry.slice(separator + 1).trim();
    if (
      separator <= 0 ||
      !sourceId ||
      !artifactInput ||
      /[\t\r\n]/.test(entry)
    ) {
      throw new Error(
        "Each official Legends artifact must use source-id=URL-or-checkout-path.",
      );
    }
    if (seen.has(sourceId)) {
      throw new Error(
        `Official Legends source id ${sourceId} is repeated.`,
      );
    }
    seen.add(sourceId);
    return { sourceId, artifactInput };
  });
}

export function officialLegendArtifactInputTsv(raw: string): string {
  return parseOfficialLegendArtifactInput(raw)
    .map(
      ({ sourceId, artifactInput }) =>
        `${sourceId}\t${artifactInput}\n`,
    )
    .join("");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(
    officialLegendArtifactInputTsv(process.argv[2] ?? ""),
  );
}
