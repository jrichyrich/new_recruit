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
  await writeFile(resolved, artifact.content, {
    flag: options.overwrite ? "w" : "wx",
  });
  return resolved;
}

export async function writeExportArtifacts(
  artifacts: ExportArtifact[],
  outputDirectory: string,
  options: WriteOptions = {},
): Promise<string[]> {
  const targets = await resolveExportArtifactTargets(
    artifacts,
    outputDirectory,
    options,
  );
  const directory = path.dirname(targets[0]);
  await mkdir(directory, { recursive: true });
  await Promise.all(
    artifacts.map((artifact, index) =>
      writeFile(targets[index], artifact.content, {
        flag: options.overwrite ? "w" : "wx",
      }),
    ),
  );
  return targets;
}

export async function resolveExportArtifactTargets(
  artifacts: ExportArtifact[],
  outputDirectory: string,
  options: WriteOptions = {},
): Promise<string[]> {
  if (artifacts.length === 0) {
    throw new Error("At least one export artifact is required.");
  }
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const directory = path.resolve(rootDir, outputDirectory);
  if (!options.allowOutsideRoot && !pathInside(rootDir, directory)) {
    throw new Error(`Refusing to write outside ${rootDir}.`);
  }
  if (directory === path.parse(directory).root) {
    throw new Error("Refusing to use a filesystem root as an output directory.");
  }

  const filenames = artifacts.map((artifact) => artifact.filename);
  if (new Set(filenames).size !== filenames.length) {
    throw new Error("Refusing to write handoff artifacts with duplicate filenames.");
  }
  const targets = filenames.map((filename) => path.resolve(directory, filename));
  for (const target of targets) {
    if (
      !pathInside(directory, target) ||
      (!options.allowOutsideRoot && !pathInside(rootDir, target))
    ) {
      throw new Error(`Refusing to write outside ${directory}.`);
    }
  }
  if (!options.overwrite) {
    const collisions = (
      await Promise.all(
        targets.map(async (target) => ((await pathExists(target)) ? target : null)),
      )
    ).filter((target): target is string => target !== null);
    if (collisions.length) {
      throw new Error(
        `Refusing to overwrite existing file${collisions.length === 1 ? "" : "s"}: ${collisions.join(", ")}`,
      );
    }
  }
  return targets;
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
