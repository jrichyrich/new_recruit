import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import {
  RosterDraftV1Schema,
  type ExportArtifact,
  type RosterDraftV1,
} from "./types";

export type WriteOptions = {
  rootDir?: string;
  overwrite?: boolean;
  allowOutsideRoot?: boolean;
};

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function pathExists(filename: string): Promise<boolean> {
  try {
    await access(filename, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeExportArtifact(
  artifact: ExportArtifact,
  outputPath: string,
  options: WriteOptions = {},
): Promise<string> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const resolved = path.resolve(rootDir, outputPath);
  if (!options.allowOutsideRoot && !pathInside(rootDir, resolved)) {
    throw new Error(`Refusing to write outside ${rootDir}.`);
  }
  if (resolved === rootDir || path.dirname(resolved) === path.parse(resolved).root) {
    throw new Error("Refusing to use a workspace or filesystem root as an output file.");
  }
  if (!options.overwrite && (await pathExists(resolved))) {
    throw new Error(`Refusing to overwrite existing file: ${resolved}`);
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, artifact.content);
  return resolved;
}

export async function writeRosterDraft(
  draft: RosterDraftV1,
  outputPath: string,
  options: WriteOptions = {},
): Promise<string> {
  return writeExportArtifact(
    {
      format: "roster-json",
      filename: path.basename(outputPath),
      mimeType: "application/json",
      encoding: "utf8",
      content: `${JSON.stringify(draft, null, 2)}\n`,
    },
    outputPath,
    options,
  );
}

export async function readRosterDraft(filename: string): Promise<RosterDraftV1> {
  const content = await readFile(filename, "utf8");
  const parsed: unknown = JSON.parse(content);
  const result = RosterDraftV1Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${filename} is not a valid RosterDraftV1: ${result.error.issues[0]?.message ?? "schema mismatch"}`,
    );
  }
  return result.data;
}
