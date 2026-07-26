import path from "node:path";

import {
  buildRoster,
  checkDataFreshness,
  compareFactions,
  explainRoster,
  exportRoster,
  getNewRecruitCapability,
  getDataStatus,
  listDataConflicts,
  modifyRoster,
  searchFactions,
  searchUnits,
  validateRoster,
  type ExportFormat,
  type ModifyRosterOperation,
  type PreferenceTag,
} from "../lib/rosterpilot/index";
import {
  readRosterDraft,
  writeExportArtifact,
  writeRosterDraft,
} from "../lib/rosterpilot/io";
import {
  configureNewRecruitCredentials,
  deliverRosterToNewRecruit,
  forgetNewRecruitCredentials,
  getNewRecruitConnectionStatus,
} from "../local/new-recruit/companion";

type Args = Record<string, string | boolean | string[]>;

function parseArgs(argv: string[]): { command: string; positionals: string[]; args: Args } {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const args: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    const value = next && !next.startsWith("--") ? rest[++index] : true;
    const current = args[key];
    if (current === undefined) args[key] = value;
    else args[key] = Array.isArray(current) ? [...current, String(value)] : [String(current), String(value)];
  }
  return { command, positionals, args };
}

function value(args: Args, key: string): string | undefined {
  const found = args[key];
  if (found === undefined || found === false || found === true) return undefined;
  return Array.isArray(found) ? found.at(-1) : found;
}

function flag(args: Args, key: string): boolean {
  return args[key] === true || value(args, key) === "true";
}

function list(args: Args, key: string): string[] {
  const found = args[key];
  if (!found || found === true) return [];
  const values = Array.isArray(found) ? found : [found];
  return values.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);
}

function print(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function help(): void {
  process.stdout.write(`RosterPilot deterministic army builder

Usage:
  rosterpilot status
  rosterpilot freshness
  rosterpilot conflicts [--faction adeptus-custodes] [--blocking true]
  rosterpilot search [query] [--faction adeptus-custodes] [--tags mobility,objective]
  rosterpilot compare <faction> <faction>
  rosterpilot build --prompt "Build a fast 1,000 point Aeldari army" [--out roster.json]
  rosterpilot modify --file roster.json --operation '{"type":"remove","selectionId":"..."}' [--out next.json]
  rosterpilot validate --file roster.json
  rosterpilot explain --file roster.json
  rosterpilot export --file roster.json --format rosz --out roster.rosz [--overwrite]
  rosterpilot new-recruit configure
  rosterpilot new-recruit status
  rosterpilot new-recruit coverage --faction adeptus-custodes
  rosterpilot new-recruit forget
  rosterpilot new-recruit deliver --file roster.json [--out-dir exports/new-recruit] [--no-pretty]
  rosterpilot mcp

Writes are restricted to the current directory unless --allow-outside-root is supplied.
Existing files are never replaced unless --overwrite is supplied.
`);
}

async function main(): Promise<void> {
  const { command, positionals, args } = parseArgs(process.argv.slice(2));
  if (command === "help" || flag(args, "help")) {
    help();
    return;
  }
  if (command === "mcp") {
    await import("../mcp/stdio");
    return;
  }
  if (command === "new-recruit") {
    const action = positionals[0] ?? "status";
    if (action === "configure") {
      const result = await configureNewRecruitCredentials();
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "status") {
      print(await getNewRecruitConnectionStatus());
      return;
    }
    if (action === "coverage") {
      print({
        ok: true,
        data: getNewRecruitCapability(
          value(args, "faction") ?? "adeptus-custodes",
        ),
        violations: [],
        warnings: [],
      });
      return;
    }
    if (action === "forget") {
      const result = await forgetNewRecruitCredentials();
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "deliver") {
      const inputFile = value(args, "file");
      if (!inputFile) {
        throw new Error("The new-recruit deliver command requires --file.");
      }
      const roster = await readRosterDraft(path.resolve(inputFile));
      const result = await deliverRosterToNewRecruit(roster, {
        downloadPrettyHtml: !flag(args, "no-pretty"),
        outputDirectory: value(args, "out-dir") ?? "exports/new-recruit",
        overwrite: flag(args, "overwrite"),
        allowOutsideRoot: flag(args, "allow-outside-root"),
      });
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    throw new Error(`Unknown new-recruit command "${action}".`);
  }
  if (command === "status") {
    print(getDataStatus());
    return;
  }
  if (command === "freshness") {
    print(await checkDataFreshness());
    return;
  }
  if (command === "conflicts") {
    print({
      ok: true,
      data: listDataConflicts({
        factionId: value(args, "faction"),
        blocking: value(args, "blocking")
          ? flag(args, "blocking")
          : undefined,
        limit: Number(value(args, "limit") ?? 50),
        offset: Number(value(args, "offset") ?? 0),
      }),
      violations: [],
      warnings: [],
    });
    return;
  }
  if (command === "search") {
    const faction = value(args, "faction");
    const query = positionals.join(" ");
    if (faction) {
      print(
        searchUnits({
          faction,
          query,
          tags: list(args, "tags") as PreferenceTag[],
          includeLegends: flag(args, "include-legends"),
          limit: Number(value(args, "limit") ?? 30),
        }),
      );
    } else {
      print(searchFactions(query, Number(value(args, "limit") ?? 30)));
    }
    return;
  }
  if (command === "compare") {
    print(compareFactions(positionals));
    return;
  }
  if (command === "build") {
    const preferences = list(args, "preferences") as PreferenceTag[];
    const collectionUnitIds = list(args, "collection");
    const result = buildRoster({
      prompt: value(args, "prompt") ?? positionals.join(" "),
      faction: value(args, "faction"),
      pointsLimit: value(args, "points") ? Number(value(args, "points")) : undefined,
      name: value(args, "name"),
      preferences: preferences.length ? preferences : undefined,
      allowNamedCharacters: flag(args, "no-named") ? false : undefined,
      allowLegends: flag(args, "include-legends") ? true : undefined,
      collectionUnitIds: collectionUnitIds.length ? collectionUnitIds : undefined,
      detachmentId: value(args, "detachment"),
      forceDispositionId: value(args, "disposition"),
    });
    const output = value(args, "out");
    if (result.data && output) {
      const written = await writeRosterDraft(result.data, output, {
        overwrite: flag(args, "overwrite"),
        allowOutsideRoot: flag(args, "allow-outside-root"),
      });
      print({ ...result, written });
    } else print(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }

  const file = value(args, "file");
  if (!file) throw new Error(`The ${command} command requires --file.`);
  const draft = await readRosterDraft(path.resolve(file));
  if (command === "validate") {
    const result = validateRoster(draft);
    print(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === "explain") {
    const result = explainRoster(draft);
    print(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === "modify") {
    const operationJson = value(args, "operation");
    if (!operationJson) throw new Error("The modify command requires --operation JSON.");
    const operation = JSON.parse(operationJson) as ModifyRosterOperation;
    const result = modifyRoster(draft, operation);
    const output = value(args, "out");
    if (result.data && output) {
      const written = await writeRosterDraft(result.data, output, {
        overwrite: flag(args, "overwrite"),
        allowOutsideRoot: flag(args, "allow-outside-root"),
      });
      print({ ...result, written });
    } else print(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === "export") {
    const format = (value(args, "format") ?? "rosz") as ExportFormat;
    const result = await exportRoster(draft, format);
    if (!result.data) {
      print(result);
      process.exitCode = 2;
      return;
    }
    const output = value(args, "out") ?? result.data.filename;
    const written = await writeExportArtifact(result.data, output, {
      overwrite: flag(args, "overwrite"),
      allowOutsideRoot: flag(args, "allow-outside-root"),
    });
    print({
      ok: true,
      data: {
        format: result.data.format,
        filename: result.data.filename,
        mimeType: result.data.mimeType,
        written,
      },
      violations: result.violations,
      warnings: result.warnings,
    });
    return;
  }

  throw new Error(`Unknown command "${command}".`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
