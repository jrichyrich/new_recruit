import { readFile } from "node:fs/promises";

import {
  type ActRequest,
  type InspectRequest,
  type RunAction,
  type RunRequest,
} from "../lib/rosterpilot/service";
import type { ExportFormat } from "../lib/rosterpilot/types";
import { createLocalRosterPilotService } from "../local/service";

const ACTIONS = new Set<RunAction>([
  "research",
  "build",
  "modify",
  "export",
  "matchup",
  "stress",
  "sync",
]);
const FORMATS = new Set<ExportFormat>([
  "ros",
  "rosz",
  "newrecruit-json",
  "roster-json",
  "text",
  "html",
]);

type Arguments = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

function parseArguments(values: string[]): Arguments {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positionals, flags };
}

function stringFlag(args: Arguments, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFlag(args: Arguments, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number.`);
  return parsed;
}

function booleanFlag(args: Arguments, name: string): boolean | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false.`);
}

function comparisonDepthFlag(
  args: Arguments,
): "standard" | "expanded" | undefined {
  const value = args.flags.get("comparison-depth");
  if (value === undefined) return undefined;
  if (value === "standard" || value === "expanded") return value;
  throw new Error("--comparison-depth must be standard or expanded.");
}

function jsonObjectFlag(
  args: Arguments,
  name: string,
): Record<string, unknown> {
  const value = stringFlag(args, name);
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${name} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function buildOptions(args: Arguments): Record<string, unknown> | undefined {
  const options = jsonObjectFlag(args, "options");
  const values: Array<[string, unknown]> = [
    ["playerFaction", stringFlag(args, "player-faction")],
    ["faction", stringFlag(args, "faction")],
    ["name", stringFlag(args, "name")],
    ["pointsLimit", numberFlag(args, "points")],
    ["detachmentId", stringFlag(args, "detachment")],
    ["forceDispositionId", stringFlag(args, "force-disposition")],
    [
      "compareOpponentOptions",
      booleanFlag(args, "compare-opponent-options"),
    ],
    ["comparisonDepth", comparisonDepthFlag(args)],
    ["limit", numberFlag(args, "limit")],
    ["includeLegends", booleanFlag(args, "include-legends")],
    ["allowLegends", booleanFlag(args, "allow-legends")],
    ["allowNamedCharacters", booleanFlag(args, "allow-named-characters")],
    ["allowPointMismatch", booleanFlag(args, "allow-point-mismatch")],
    ["overwrite", booleanFlag(args, "overwrite")],
    ["force", booleanFlag(args, "force")],
    ["outputPath", stringFlag(args, "output")],
    ["opponentFaction", stringFlag(args, "opponent-faction")],
    ["backend", stringFlag(args, "backend")],
    ["suite", stringFlag(args, "suite")],
    ["strategy", stringFlag(args, "strategy")],
    ["resumeManifestPath", stringFlag(args, "resume-manifest")],
    ["profilePolicyPath", stringFlag(args, "profile-policy")],
    ["forceRetry", booleanFlag(args, "force-retry")],
  ];
  for (const [key, value] of values) {
    if (value !== undefined) options[key] = value;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function runRequest(args: Arguments, directAction?: string): RunRequest {
  const actionValue = directAction ?? args.positionals.shift() ??
    stringFlag(args, "action");
  if (!actionValue || !ACTIONS.has(actionValue as RunAction)) {
    throw new Error(
      "run requires one of: research, build, modify, export, matchup, stress, sync.",
    );
  }
  const formatValue = stringFlag(args, "format");
  if (formatValue && !FORMATS.has(formatValue as ExportFormat)) {
    throw new Error(`Unsupported export format: ${formatValue}.`);
  }
  return {
    action: actionValue as RunAction,
    request: stringFlag(args, "request") ??
      (args.positionals.length > 0 ? args.positionals.join(" ") : undefined),
    rosterRef: stringFlag(args, "roster"),
    opponentRef: stringFlag(args, "opponent"),
    format: formatValue as ExportFormat | undefined,
    options: buildOptions(args),
  };
}

function usage(): string {
  return `RosterPilot — lean local roster engine

Usage:
  rosterpilot run <research|build|modify|export|matchup|stress|sync> [request] [flags]
  rosterpilot inspect <data|new-recruit|operation-id|resource-uri> [--view details]
  rosterpilot act <operation-id> <action-id> --revision <n> --confirm
  rosterpilot import <roster.json>
  rosterpilot status
  rosterpilot mcp

Common run flags:
  --player-faction <id> --faction <id> --points <n>
  --detachment <id> --force-disposition <id>
  --compare-opponent-options[=true|false] --comparison-depth <standard|expanded>
  --roster <ref> --opponent <ref> --opponent-faction <id>
  --format <ros|rosz|newrecruit-json|roster-json|text|html>
  --output <path> --overwrite --options '<json>'
  --backend <local-engine|website>
  --suite <core-3|diverse-9> --strategy <staged|full-all>

Results are compact JSON. Full rosters and artifacts are returned as rosterpilot:// refs.`;
}

function print(value: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  const command = raw.shift() ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "mcp") {
    await import("../mcp/stdio");
    return;
  }

  const args = parseArguments(raw);
  const service = await createLocalRosterPilotService();
  let result: unknown;

  if (command === "run" || ACTIONS.has(command as RunAction)) {
    result = await service.run(runRequest(args, command === "run" ? undefined : command));
  } else if (command === "sync") {
    result = await service.run({ action: "sync", options: buildOptions(args) });
  } else if (command === "inspect") {
    const request: InspectRequest = {
      ref: args.positionals[0] ?? stringFlag(args, "ref") ?? "data",
      view: stringFlag(args, "view") as InspectRequest["view"],
    };
    result = await service.inspect(request);
  } else if (command === "status") {
    const [data, newRecruit] = await Promise.all([
      service.inspect({ ref: "data" }),
      service.inspect({ ref: "new-recruit" }),
    ]);
    result = { data, newRecruit };
  } else if (command === "act") {
    const operationId = args.positionals[0] ?? stringFlag(args, "operation");
    const actionId = args.positionals[1] ?? stringFlag(args, "action");
    const expectedRevision = numberFlag(args, "revision");
    if (!operationId || !actionId || expectedRevision === undefined) {
      throw new Error("act requires operation-id, action-id, and --revision.");
    }
    const request: ActRequest = {
      operationId,
      actionId,
      expectedRevision,
      choice: stringFlag(args, "choice"),
      confirm: booleanFlag(args, "confirm"),
    };
    result = await service.act(request);
  } else if (command === "import") {
    const filename = args.positionals[0];
    if (!filename) throw new Error("import requires a roster JSON file.");
    result = await service.importRoster(JSON.parse(await readFile(filename, "utf8")));
  } else {
    throw new Error(`Unknown command: ${command}. Run rosterpilot help.`);
  }

  print(result, args.flags.has("pretty"));
  if (
    result &&
    typeof result === "object" &&
    "state" in result &&
    (result as { state?: unknown }).state === "failed"
  ) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
