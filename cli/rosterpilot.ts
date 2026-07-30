import path from "node:path";

import {
  buildRoster,
  checkDataFreshness,
  compactBuildAndStressResult,
  compactStressResult,
  compareFactions,
  explainRoster,
  exportRoster,
  getNewRecruitCapability,
  getDataStatus,
  listDataConflicts,
  modifyRoster,
  previewFactionStressPortfolio,
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
import {
  compareRosterStressRevision,
  runRosterStressTest,
} from "../local/tessera/stress";
import {
  buildAndStressRosterAgainstFaction,
} from "../local/tessera/full-loop";

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

function progress(message: string): void {
  process.stderr.write(`[RosterPilot] ${message}\n`);
}

function compactPortfolioPreview(
  result: Awaited<ReturnType<typeof previewFactionStressPortfolio>>,
): Record<string, unknown> {
  if (!result.data) {
    return {
      ok: result.ok,
      data: null,
      violations: result.violations,
      warnings: result.warnings.slice(0, 20),
    };
  }
  return {
    ok: result.ok,
    data: {
      schemaVersion: result.data.schemaVersion,
      previewKind: result.data.previewKind,
      generatedAt: result.data.generatedAt,
      faction: {
        id: result.data.portfolio.factionId,
        name: result.data.portfolio.factionName,
        pointsLimit: result.data.portfolio.pointsLimit,
      },
      suite: result.data.portfolio.suite,
      gates: result.data.gates,
      items: result.data.items.map((item) => ({
        templateId: item.templateId,
        structuralFingerprint: item.structuralFingerprint,
        simulationFingerprint: item.simulationFingerprint,
        minimumPairwiseDiversity: item.minimumPairwiseDiversity,
        compositionEvidence: item.compositionEvidence,
        profileRequirements: item.profileRequirements,
        containsNamedCharacter: item.containsNamedCharacter,
        exportable: item.exportable,
        exportError: item.exportError,
      })),
    },
    violations: result.violations,
    warnings: result.warnings.slice(0, 20),
  };
}

function help(): void {
  process.stdout.write(`RosterPilot deterministic army builder

Choose only the workflow you need. Building, exporting, New Recruit delivery,
and Tessera analysis are separate actions; none runs automatically after another.

Usage:
  rosterpilot workflows
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
  rosterpilot tessera analyze --file roster.json (--opponent-file army.rosz | --opponent-roster enemy.json | --opponent-faction necrons) [--archetypes balanced-control,ranged-pressure,assault-pressure] [--execution-mode prepare-only|simulate] [--fallback none|baseline-damage-v1] [--profile-policy profiles.json] [--analysis-mode quick|full] [--phases shooting,fight] [--metrics wipe-probability,half-wipe-probability,mean-kills,mean-damage] [--allow-point-mismatch] [--no-change-candidates] [--experimental]
  rosterpilot tessera stress-test --file roster.json --against-faction aeldari [--suite core-3|diverse-9] [--execution-mode prepare-only|simulate] [--analysis staged|full-all] [--profile-policy profiles.json] [--resume [manifest.json] | --restart-from manifest.json] [--force-retry] [--full-json] [--out-dir exports/tessera] [--overwrite] [--experimental]
  rosterpilot tessera preview-portfolio --against-faction aeldari [--points 1000] [--suite core-3|diverse-9] [--full-json]
  rosterpilot tessera build-and-stress --prompt "Build a mobile, durable 1,000 point Custodes army" --player-faction adeptus-custodes --against-faction aeldari [--required-unit farseer] [--exclude-unit warlock-skyrunners] [--required-warlord farseer-skyrunner] [--suite diverse-9] [--execution-mode prepare-only|simulate] [--analysis staged] [--profile-policy profiles.json] [--resume [manifest.json] | --restart-from manifest.json] [--allow-readiness-warnings] [--full-json] [--experimental]
  rosterpilot tessera compare-revision --baseline-report matchup.json --revised-roster revised.json [--out-dir exports/tessera] [--overwrite] [--experimental]
  rosterpilot tessera compare-stress-revision --baseline-report stress-test.json --revised-roster revised.json [--out-dir exports/tessera] [--overwrite] [--experimental]
  rosterpilot mcp

Writes are restricted to the current directory unless --allow-outside-root is supplied.
Existing files are never replaced unless --overwrite is supplied.
For stress tests, bare --resume reads <out-dir>/stress-manifest.json.
Use --restart-from with a different --out-dir after a five-attempt budget is
exhausted; verified prepared artifacts are reused, but simulation stages start fresh.
Stress tests default to the diverse-9 suite and staged analysis; results are
directional robustness ranges, not game win probabilities.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    help();
    return;
  }
  const { command, positionals, args } = parseArgs(argv);
  if (command === "help") {
    help();
    return;
  }
  if (command === "mcp") {
    await import("../mcp/stdio");
    return;
  }
  if (command === "workflows") {
    const [newRecruit, tessera] = await Promise.all([
      getNewRecruitConnectionStatus(),
      getTesseraConnectionStatus(),
    ]);
    const workflowWarnings = [
      ...newRecruit.warnings,
      ...tessera.warnings,
    ].filter(
      (warning, index, warnings) =>
        warnings.findIndex(
          (candidate) =>
            candidate.code === warning.code &&
            candidate.message === warning.message,
        ) === index,
    );
    print({
      ok: true,
      data: {
        principle:
          "Each workflow is opt-in. A validated roster is a complete result and no later workflow runs automatically.",
        workflows: [
          {
            id: "build",
            label: "Build and export",
            available: true,
            setupProfile: "core",
            requires: ["Node.js 22.13 or newer"],
            accepts: ["natural-language prompt", "structured constraints"],
            produces: [
              "validated RosterPilot JSON",
              "printable HTML",
              "plain text",
            ],
            nextCommand:
              'rosterpilot build --prompt "Build a 1,000 point army" --out roster.json',
          },
          {
            id: "new-recruit",
            label: "Deliver to New Recruit",
            available: newRecruit.data?.available ?? false,
            setupProfile: "new-recruit",
            requires: [
              "validated roster",
              "conflict-free catalogue mapping",
              "macOS local automation for direct upload",
            ],
            fallback:
              "Export .rosz on any supported core platform and import it manually.",
            nextCommand:
              "rosterpilot new-recruit deliver --file roster.json --enriched",
          },
          {
            id: "tessera",
            label: "Compare known armies in Tessera",
            available: tessera.data?.available ?? false,
            setupProfile: "tessera",
            requires: [
              "validated player roster",
              "one opponent roster, .rosz, or faction proxy",
              "New Recruit-enriched profiles",
              "macOS local automation and a Tessera licence key",
            ],
            produces: [
              "directional scenario matrices",
              "interactive HTML report",
              "machine-readable JSON report",
            ],
            nextCommand:
              "rosterpilot tessera analyze --file roster.json --opponent-roster enemy.json --experimental",
          },
          {
            id: "faction-stress",
            label:
              "Stress-test against an unknown list from a known faction",
            available: tessera.data?.available ?? false,
            setupProfile: "tessera",
            requires: [
              "validated player roster",
              "known opponent faction",
              "New Recruit-enriched profiles",
              "macOS local automation and a Tessera licence key",
            ],
            produces: [
              "deterministic frozen opponent portfolio",
              "directional robustness ranges and findings",
              "mission-readiness guardrail",
              "interactive HTML and machine-readable JSON reports",
            ],
            nextCommand:
              "rosterpilot tessera stress-test --file roster.json --against-faction necrons --experimental",
          },
        ],
      },
      violations: [],
      warnings: workflowWarnings,
    });
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
    if (action === "preview-portfolio") {
      const againstFaction =
        value(args, "against-faction") ??
        value(args, "opponent-faction");
      if (!againstFaction) {
        throw new Error(
          "Tessera preview-portfolio requires --against-faction.",
        );
      }
      const suite = value(args, "suite") ?? "diverse-9";
      if (suite !== "core-3" && suite !== "diverse-9") {
        throw new Error(`Unknown Tessera portfolio suite "${suite}".`);
      }
      progress("Building a local-only opponent portfolio preview.");
      const result = await previewFactionStressPortfolio({
        faction: againstFaction,
        pointsLimit: Number(value(args, "points") ?? 1000),
        suite,
        pointsTolerancePercent: 5,
        allowLegends: false,
      });
      print(
        flag(args, "full-json")
          ? result
          : compactPortfolioPreview(result),
      );
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "build-and-stress") {
      const prompt = value(args, "prompt") ?? "";
      const againstFaction =
        value(args, "against-faction") ??
        value(args, "opponent-faction");
      if (!prompt || !againstFaction) {
        throw new Error(
          "Tessera build-and-stress requires --prompt and --against-faction.",
        );
      }
      const suite = value(args, "suite") ?? "diverse-9";
      if (suite !== "core-3" && suite !== "diverse-9") {
        throw new Error(`Unknown Tessera portfolio suite "${suite}".`);
      }
      const analysisStrategy = value(args, "analysis") ?? "staged";
      if (
        analysisStrategy !== "staged" &&
        analysisStrategy !== "full-all"
      ) {
        throw new Error(
          `Unknown Tessera analysis strategy "${analysisStrategy}".`,
        );
      }
      const executionMode = value(args, "execution-mode");
      if (
        executionMode &&
        executionMode !== "prepare-only" &&
        executionMode !== "simulate"
      ) {
        throw new Error(
          `Unknown Tessera execution mode "${executionMode}".`,
        );
      }
      const outputDirectory =
        value(args, "out-dir") ?? "exports/tessera";
      const resumeManifest = value(args, "resume");
      const resumeManifestPath =
        args.resume === true
          ? path.resolve(outputDirectory, "stress-manifest.json")
          : resumeManifest
            ? path.resolve(resumeManifest)
            : undefined;
      const restartManifest = value(args, "restart-from");
      if (args["restart-from"] === true) {
        throw new Error(
          "Tessera build-and-stress --restart-from requires a manifest path.",
        );
      }
      if (resumeManifestPath && restartManifest) {
        throw new Error(
          "Choose either --resume or --restart-from, not both.",
        );
      }
      progress("Building and deterministically repairing the roster.");
      progress(
        "Previewing unique opponent payloads before any external activity.",
      );
      progress(
        restartManifest
          ? "Starting a clean stress run and reusing only verified prepared artifacts."
          : resumeManifestPath
            ? "Resuming incomplete simulation stages from the local manifest."
            : "Preparing verified artifacts, then screening before selecting deep dives.",
      );
      const result = await buildAndStressRosterAgainstFaction(
        {
          prompt,
          playerFaction: value(args, "player-faction"),
          againstFaction,
          pointsLimit: value(args, "points")
            ? Number(value(args, "points"))
            : undefined,
          requiredUnitIds: list(args, "required-unit"),
          excludedUnitIds: list(args, "exclude-unit"),
          requiredWarlordUnitId: value(args, "required-warlord"),
          suite,
          analysisStrategy,
          profilePolicyPath: value(args, "profile-policy"),
          outputDirectory,
          resumeManifestPath,
          restartManifestPath: restartManifest
            ? path.resolve(restartManifest)
            : undefined,
          allowReadinessWarnings: flag(
            args,
            "allow-readiness-warnings",
          ),
          forceRetry: flag(args, "force-retry"),
          executionMode: executionMode as
            | "prepare-only"
            | "simulate"
            | undefined,
          experimental: flag(args, "experimental"),
        },
        {
          overwrite: flag(args, "overwrite"),
          allowOutsideRoot: flag(args, "allow-outside-root"),
        },
      );
      if (flag(args, "full-json") || !result.data) {
        print(result);
      } else {
        print(
          compactBuildAndStressResult(
            result,
            resumeManifestPath
              ? path.dirname(resumeManifestPath)
              : outputDirectory,
          ),
        );
      }
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
    if (action === "compare-stress-revision") {
      const baselineReport = value(args, "baseline-report");
      const revisedRosterFile = value(args, "revised-roster");
      if (!baselineReport || !revisedRosterFile) {
        throw new Error(
          "Tessera compare-stress-revision requires --baseline-report and --revised-roster.",
        );
      }
      const revisedRoster = await readRosterDraft(
        path.resolve(revisedRosterFile),
      );
      const result = await compareRosterStressRevision(
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
    if (action === "stress-test") {
      const againstFaction = value(args, "against-faction");
      const opponentFactionAlias = value(args, "opponent-faction");
      if (
        againstFaction &&
        opponentFactionAlias &&
        againstFaction !== opponentFactionAlias
      ) {
        throw new Error(
          "Tessera stress-test received conflicting --against-faction and --opponent-faction values.",
        );
      }
      const opponentFaction = againstFaction ?? opponentFactionAlias;
      if (!opponentFaction) {
        throw new Error(
          "Tessera stress-test requires --against-faction.",
        );
      }
      const suite = value(args, "suite") ?? "diverse-9";
      if (suite !== "core-3" && suite !== "diverse-9") {
        throw new Error(
          `Unknown Tessera stress-test suite "${suite}". Expected core-3 or diverse-9.`,
        );
      }
      const analysisStrategy = value(args, "analysis") ?? "staged";
      if (analysisStrategy !== "staged" && analysisStrategy !== "full-all") {
        throw new Error(
          `Unknown Tessera stress-test analysis strategy "${analysisStrategy}". Expected staged or full-all.`,
        );
      }
      const executionMode = value(args, "execution-mode");
      if (
        executionMode &&
        executionMode !== "prepare-only" &&
        executionMode !== "simulate"
      ) {
        throw new Error(
          `Unknown Tessera execution mode "${executionMode}".`,
        );
      }
      const resumeManifest = value(args, "resume");
      const resumeManifestPath =
        args.resume === true
          ? path.resolve(outputDirectory, "stress-manifest.json")
          : resumeManifest
            ? path.resolve(resumeManifest)
            : undefined;
      const restartManifest = value(args, "restart-from");
      if (args["restart-from"] === true) {
        throw new Error(
          "Tessera stress-test --restart-from requires a manifest path.",
        );
      }
      if (resumeManifestPath && restartManifest) {
        throw new Error(
          "Choose either --resume or --restart-from, not both.",
        );
      }
      progress(
        restartManifest
          ? "Starting a clean stress run and reusing only verified prepared artifacts."
          : resumeManifestPath
            ? "Resuming incomplete simulation stages from the local manifest."
            : "Validating the frozen portfolio, then screening before selecting deep dives.",
      );
      const result = await runRosterStressTest(
        roster,
        { kind: "faction", factionId: opponentFaction },
        {
          suite,
          analysisStrategy,
          resumeManifestPath,
          restartManifestPath: restartManifest
            ? path.resolve(restartManifest)
            : undefined,
          profilePolicyPath: value(args, "profile-policy"),
          forceRetry: flag(args, "force-retry"),
          outputDirectory,
          overwrite: flag(args, "overwrite"),
          allowOutsideRoot: flag(args, "allow-outside-root"),
          executionMode: executionMode as
            | "prepare-only"
            | "simulate"
            | undefined,
          experimental: flag(args, "experimental"),
        },
      );
      print(
        flag(args, "full-json")
          ? result
          : compactStressResult(
              result,
              resumeManifestPath
                ? path.dirname(resumeManifestPath)
                : outputDirectory,
            ),
      );
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
      const executionMode = value(args, "execution-mode");
      if (
        executionMode &&
        executionMode !== "prepare-only" &&
        executionMode !== "simulate"
      ) {
        throw new Error(
          `Unknown Tessera execution mode "${executionMode}".`,
        );
      }
      const fallbackMode = value(args, "fallback") ?? "none";
      if (
        fallbackMode !== "none" &&
        fallbackMode !== "baseline-damage-v1"
      ) {
        throw new Error(
          `Unknown Tessera fallback mode "${fallbackMode}".`,
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
        executionMode: executionMode as
          | "prepare-only"
          | "simulate"
          | undefined,
        fallbackMode,
        profilePolicyPath: value(args, "profile-policy"),
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

  const fileCommands = new Set(["validate", "explain", "modify", "export"]);
  if (!fileCommands.has(command)) {
    throw new Error(`Unknown command "${command}". Run "rosterpilot --help".`);
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
