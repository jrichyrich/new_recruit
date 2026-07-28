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
import {
  getLocalAgentLifecycleStatus,
  installLocalAgent,
  restartLocalAgent,
  uninstallLocalAgent,
} from "../local/agent/lifecycle";
import {
  analyzeRosterMatchup,
  compareRosterRevision,
  configureTesseraCredentials,
  forgetTesseraCredentials,
  getTesseraConnectionStatus,
  prepareRosterForTessera,
  type TesseraOpponentInput,
} from "../local/tessera/companion";

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
  rosterpilot agent install
  rosterpilot agent status
  rosterpilot agent restart
  rosterpilot agent uninstall
  rosterpilot new-recruit configure
  rosterpilot new-recruit status
  rosterpilot new-recruit coverage --faction adeptus-custodes
  rosterpilot new-recruit forget
  rosterpilot new-recruit deliver --file roster.json [--out-dir exports/new-recruit] [--no-pretty] [--enriched]
  rosterpilot tessera status
  rosterpilot tessera configure
  rosterpilot tessera forget
  rosterpilot tessera prepare --file roster.json [--out-dir exports/tessera]
  rosterpilot tessera analyze --file roster.json (--opponent-file army.rosz | --opponent-roster enemy.json | --opponent-faction necrons) [--archetypes balanced-control,ranged-pressure,assault-pressure] [--analysis-mode quick|full] [--phases shooting,fight] [--metrics wipe-probability,half-wipe-probability,mean-kills,mean-damage] [--allow-point-mismatch] [--no-change-candidates] [--experimental]
  rosterpilot tessera compare-revision --baseline-report matchup.json --revised-roster revised.json [--out-dir exports/tessera] [--overwrite] [--experimental]
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
  if (command === "agent") {
    const action = positionals[0] ?? "status";
    const result =
      action === "install"
        ? await installLocalAgent()
        : action === "status"
          ? await getLocalAgentLifecycleStatus()
          : action === "restart"
            ? await restartLocalAgent()
            : action === "uninstall"
              ? await uninstallLocalAgent()
              : null;
    if (!result) {
      throw new Error(`Unknown agent command "${action}".`);
    }
    print(result);
    if (!result.ok) process.exitCode = 2;
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
        downloadEnrichedRosz: flag(args, "enriched"),
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
  if (command === "tessera") {
    const action = positionals[0] ?? "status";
    if (action === "configure") {
      const result = await configureTesseraCredentials();
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "status") {
      print(await getTesseraConnectionStatus());
      return;
    }
    if (action === "forget") {
      const result = await forgetTesseraCredentials();
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "compare-revision") {
      const baselineReport = value(args, "baseline-report");
      const revisedRosterFile = value(args, "revised-roster");
      if (!baselineReport || !revisedRosterFile) {
        throw new Error(
          "Tessera compare-revision requires --baseline-report and --revised-roster.",
        );
      }
      const revisedRoster = await readRosterDraft(
        path.resolve(revisedRosterFile),
      );
      const result = await compareRosterRevision(
        path.resolve(baselineReport),
        revisedRoster,
        {
          outputDirectory: value(args, "out-dir") ?? "exports/tessera",
          overwrite: flag(args, "overwrite"),
          allowOutsideRoot: flag(args, "allow-outside-root"),
          experimental: flag(args, "experimental"),
        },
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    const inputFile = value(args, "file");
    if (!inputFile) {
      throw new Error(`The tessera ${action} command requires --file.`);
    }
    const roster = await readRosterDraft(path.resolve(inputFile));
    const outputDirectory = value(args, "out-dir") ?? "exports/tessera";
    if (action === "prepare") {
      const result = await prepareRosterForTessera(roster, {
        outputDirectory,
        overwrite: flag(args, "overwrite"),
        allowOutsideRoot: flag(args, "allow-outside-root"),
      });
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "analyze") {
      const opponentFile = value(args, "opponent-file");
      const opponentRosterFile = value(args, "opponent-roster");
      const opponentFaction = value(args, "opponent-faction");
      const selected = [
        Boolean(opponentFile),
        Boolean(opponentRosterFile),
        Boolean(opponentFaction),
      ].filter(Boolean).length;
      if (selected !== 1) {
        throw new Error(
          "Tessera analyze requires exactly one of --opponent-file, --opponent-roster, or --opponent-faction.",
        );
      }
      let opponent: TesseraOpponentInput;
      if (opponentFile) {
        opponent = { kind: "rosz", path: path.resolve(opponentFile) };
      } else if (opponentRosterFile) {
        opponent = {
          kind: "roster",
          roster: await readRosterDraft(path.resolve(opponentRosterFile)),
        };
      } else {
        const allowedArchetypes = [
          "balanced-control",
          "ranged-pressure",
          "assault-pressure",
        ] as const;
        const requestedArchetypes = list(args, "archetypes");
        const invalidArchetypes = requestedArchetypes.filter(
          (item) =>
            !allowedArchetypes.includes(
              item as (typeof allowedArchetypes)[number],
            ),
        );
        if (invalidArchetypes.length) {
          throw new Error(
            `Unknown Tessera archetype: ${invalidArchetypes.join(", ")}.`,
          );
        }
        opponent = {
          kind: "faction-archetypes",
          factionId: opponentFaction!,
          archetypes: requestedArchetypes.length
            ? (requestedArchetypes as Array<
                "balanced-control" | "ranged-pressure" | "assault-pressure"
              >)
            : undefined,
        };
      }
      const analysisMode = value(args, "analysis-mode") ?? "full";
      if (analysisMode !== "quick" && analysisMode !== "full") {
        throw new Error(
          `Unknown Tessera analysis mode "${analysisMode}". Expected quick or full.`,
        );
      }
      const allowedPhases = ["shooting", "fight"] as const;
      const phases = list(args, "phases");
      const invalidPhases = phases.filter(
        (phase) =>
          !allowedPhases.includes(phase as (typeof allowedPhases)[number]),
      );
      if (invalidPhases.length) {
        throw new Error(
          `Unknown Tessera phase: ${invalidPhases.join(", ")}.`,
        );
      }
      const allowedMetrics = [
        "wipe-probability",
        "half-wipe-probability",
        "mean-kills",
        "mean-damage",
      ] as const;
      const metrics = list(args, "metrics");
      const invalidMetrics = metrics.filter(
        (metric) =>
          !allowedMetrics.includes(metric as (typeof allowedMetrics)[number]),
      );
      if (invalidMetrics.length) {
        throw new Error(
          `Unknown Tessera metric: ${invalidMetrics.join(", ")}.`,
        );
      }
      const result = await analyzeRosterMatchup(roster, opponent, {
        outputDirectory,
        overwrite: flag(args, "overwrite"),
        allowOutsideRoot: flag(args, "allow-outside-root"),
        experimental: flag(args, "experimental"),
        analysisMode,
        phases: phases.length
          ? (phases as Array<"shooting" | "fight">)
          : undefined,
        metrics: metrics.length
          ? (metrics as Array<
              | "wipe-probability"
              | "half-wipe-probability"
              | "mean-kills"
              | "mean-damage"
            >)
          : undefined,
        allowPointMismatch: flag(args, "allow-point-mismatch"),
        includeChangeCandidates: !flag(args, "no-change-candidates"),
      });
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    throw new Error(`Unknown tessera command "${action}".`);
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
