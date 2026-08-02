import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  buildRoster,
  checkDataFreshness,
  CollectionProfileSchema,
  compactBuildAndAnalyzeResult,
  compactBuildAndStressResult,
  compactStressResult,
  compareFactions,
  explainRoster,
  exportRoster,
  getNewRecruitCapability,
  getDataStatus,
  getDataUpdateStatus,
  GeneralThreatArchetypeIds,
  listDataConflicts,
  modifyRoster,
  prepareRosterWorkflow,
  previewFactionStressPortfolio,
  rebaseRosterWithProvider,
  refreshDataNow,
  rollbackDataBundle,
  searchFactions,
  searchUnits,
  validateRoster,
  withDataBundleSnapshotLease,
  type ExportFormat,
  type GeneralThreatArchetype,
  type LegendsPlayContext,
  type LegendsPolicy,
  type ModifyRosterOperation,
  type PreferenceTag,
  type RosterArtifactRequirement,
  type RosterCoachingMode,
  type RosterOptimizerMode,
  type RosterWorkflowResult,
  type RosterWorkflowIntent,
  type TesseraStressAnalysisStrategy,
  type TesseraStressPortfolioPreview,
  type TesseraStressSuite,
} from "../lib/rosterpilot/index";
import {
  readRosterDraft,
  writeExportArtifact,
  writeExportArtifacts,
  writeRosterDraft,
} from "../lib/rosterpilot/io";
import {
  configureNewRecruitCredentials,
  deliverRosterToNewRecruit,
  forgetNewRecruitCredentials,
  getNewRecruitConnectionStatus,
} from "../local/new-recruit/companion";
import {
  ensureCurrentLocalAgent,
  getLocalAgentLifecycleStatus,
  installLocalAgent,
  restartLocalAgent,
  uninstallLocalAgent,
} from "../local/agent/lifecycle";
import {
  analyzeRosterMatchup,
  configureTesseraCredentials,
  forgetTesseraCredentials,
  getTesseraConnectionStatus,
  prepareRosterForTessera,
  type TesseraOpponentInput,
} from "../local/tessera/companion";
import { runRosterStressTest } from "../local/tessera/stress";
import {
  buildAndStressRosterAgainstFaction,
} from "../local/tessera/full-loop";
import {
  buildAndAnalyzeRosterMatchup,
} from "../local/tessera/exact-full-loop";
import {
  cancelTesseraRun,
  getTesseraRunStatus,
  resolveTesseraRunProfiles,
  resumeTesseraRun,
  startTesseraRun,
  type TesseraRunRequest,
} from "../local/tessera/jobs";
import { ProfilePolicySchema } from "../local/tessera/profile-policy";
import {
  approveAndMaterializeTesseraOptimizerCandidates,
  approveStoredTesseraOptimizerWinner,
  finalizeStoredTesseraOptimizer,
  getTesseraOptimizerStatus,
  recordStoredTesseraOptimizerComparison,
  retainStoredTesseraOptimizerBaseline,
  startTesseraOptimizer,
} from "../local/tessera/optimizer-store";
import {
  approveAndMaterializeTesseraGeneralOptimizerCandidates,
  approveStoredTesseraGeneralOptimizerWinner,
  finalizeStoredTesseraGeneralOptimizer,
  getTesseraGeneralOptimizerStatus,
  recordStoredTesseraGeneralOptimizerComparison,
  retainStoredTesseraGeneralOptimizerBaseline,
  startTesseraGeneralOptimizer,
} from "../local/tessera/general-optimizer-store";
import {
  initializeLocalDataBundleProvider,
} from "../local/data-bundles/configure";

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

function requiredInteger(
  args: Args,
  key: string,
  label = `--${key}`,
): number {
  const raw = value(args, key);
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} requires a non-negative integer.`);
  }
  return parsed;
}

function optimizerStatePath(args: Args): string {
  const requested = value(args, "optimizer") ?? value(args, "state");
  if (!requested) {
    throw new Error(
      "This optimizer command requires --optimizer <tessera-optimizer.json>.",
    );
  }
  return path.resolve(requested);
}

function generalOptimizerStatePath(args: Args): string {
  const requested = value(args, "optimizer") ?? value(args, "state");
  if (!requested) {
    throw new Error(
      "This general optimizer command requires --optimizer <tessera-general-optimizer.json>.",
    );
  }
  return path.resolve(requested);
}

function isGeneralThreatArchetype(
  value: string,
): value is GeneralThreatArchetype {
  return (GeneralThreatArchetypeIds as readonly string[]).includes(value);
}

function generalArchetypeMappings(
  args: Args,
  key: "baseline" | "profile-policy",
  required: boolean,
): Map<GeneralThreatArchetype, string> {
  const mappings = new Map<GeneralThreatArchetype, string>();
  for (const entry of list(args, key)) {
    const separator = entry.indexOf("=");
    const archetypeId = separator > 0
      ? entry.slice(0, separator).trim()
      : "";
    const filename = separator > 0
      ? entry.slice(separator + 1).trim()
      : "";
    if (!isGeneralThreatArchetype(archetypeId) || !filename) {
      throw new Error(
        `--${key} requires archetype=path using one of: ${
          GeneralThreatArchetypeIds.join(", ")
        }.`,
      );
    }
    if (mappings.has(archetypeId)) {
      throw new Error(
        `--${key} contains duplicate mapping for ${archetypeId}.`,
      );
    }
    mappings.set(archetypeId, filename);
  }
  if (required) {
    const missing = GeneralThreatArchetypeIds.filter(
      (archetypeId) => !mappings.has(archetypeId),
    );
    if (missing.length > 0) {
      throw new Error(
        `--${key} requires exactly one mapping for all six archetypes; missing: ${
          missing.join(", ")
        }.`,
      );
    }
  }
  return mappings;
}

function requestedCatalogueDriftMode(
  args: Args,
  inheritFrozenPolicy = false,
): "reject" | "diagnostic" | undefined {
  if (
    args["verified-catalogue-drift-diagnostic"] ===
    undefined
  ) {
    return inheritFrozenPolicy ? undefined : "reject";
  }
  if (flag(
    args,
    "verified-catalogue-drift-diagnostic",
  )) {
    return "diagnostic";
  }
  return inheritFrozenPolicy ? undefined : "reject";
}

function list(args: Args, key: string): string[] {
  const found = args[key];
  if (!found || found === true) return [];
  const values = Array.isArray(found) ? found : [found];
  return values.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);
}

function requestedLegendsPolicy(
  args: Args,
): LegendsPolicy | undefined {
  if (args["legends-policy"] === undefined) return undefined;
  const requested = value(args, "legends-policy");
  if (
    requested !== "auto" &&
    requested !== "allow" &&
    requested !== "exclude"
  ) {
    throw new Error(
      "--legends-policy requires auto, allow, or exclude.",
    );
  }
  return requested;
}

type CliPlayContextKind = Exclude<
  LegendsPlayContext["kind"],
  "event"
>;

function requestedPlayContext(
  args: Args,
): LegendsPlayContext | undefined {
  if (args["play-context"] === undefined) return undefined;
  const requested = value(args, "play-context") as
    | CliPlayContextKind
    | undefined;
  if (
    requested !== "unspecified" &&
    requested !== "open-play" &&
    requested !== "casual" &&
    requested !== "narrative" &&
    requested !== "matched-play"
  ) {
    throw new Error(
      "--play-context requires unspecified, open-play, casual, narrative, or matched-play.",
    );
  }
  return { kind: requested };
}

function print(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function progress(message: string): void {
  process.stderr.write(`[RosterPilot] ${message}\n`);
}

function shouldStartDurableTesseraRun(
  executionMode: string | undefined,
  experimental: boolean,
  recoveryRequested = false,
): boolean {
  return (
    recoveryRequested ||
    executionMode === "simulate" ||
    (executionMode === undefined && experimental)
  );
}

function printStartedTesseraRun(
  job: Awaited<ReturnType<typeof startTesseraRun>>,
): void {
  print({
    status: "in-progress",
    runId: job.runId,
    manifestPath: job.manifestPath,
    job,
  });
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

function compactRosterWorkflowData(
  workflow: RosterWorkflowResult,
): Record<string, unknown> {
  const roster = workflow.roster;
  const coaching = workflow.coaching;
  const target = workflow.optimization?.target;
  return {
    schemaVersion: workflow.schemaVersion,
    workflowKind: workflow.workflowKind,
    status: workflow.status,
    intent: workflow.intent,
    faction: workflow.faction,
    roster: roster
      ? {
          id: roster.id,
          name: roster.name,
          factionId: roster.factionId,
          factionName: roster.factionName,
          points: `${roster.totalPoints}/${roster.pointsLimit}`,
          detachment: roster.detachmentName,
          forceDisposition: roster.forceDispositionName,
          units: roster.units.map((unit) => ({
            selectionId: unit.selectionId,
            name: unit.name,
            modelCount: unit.modelCount,
            points: unit.points,
            warlord: unit.isWarlord,
          })),
          bundleId: roster.sourceData.bundleId,
        }
      : null,
    validation: workflow.validation,
    explanation: workflow.explanation
      ? {
          summary: workflow.explanation.summary,
          choices: workflow.explanation.choices,
          cautions: workflow.explanation.cautions,
        }
      : null,
    coaching: coaching
      ? {
          mode: coaching.mode,
          heuristicPack: coaching.heuristicPack,
          summary: coaching.summary,
          advice: coaching.advice,
          units: coaching.mode === "full" ? coaching.units : undefined,
          disclaimer: coaching.disclaimer,
        }
      : null,
    newRecruit: {
      capability: workflow.newRecruit.capability,
      handoff: workflow.newRecruit.handoff
        ? {
            rosterName: workflow.newRecruit.handoff.rosterName,
            totalPoints: workflow.newRecruit.handoff.totalPoints,
            importUrl: workflow.newRecruit.handoff.importUrl,
            artifacts:
              workflow.newRecruit.handoff.artifacts.map(
                ({ content, ...artifact }) => {
                  void content;
                  return artifact;
                },
              ),
            instructions:
              workflow.newRecruit.handoff.instructions,
          }
        : null,
      delivery: workflow.newRecruit.delivery,
    },
    optimization: workflow.optimization
      ? {
          mode: workflow.optimization.mode,
          status: workflow.optimization.status,
          pairedTestRequired:
            workflow.optimization.pairedTestRequired,
          deliveryAfterWinnerApproval:
            workflow.optimization.deliveryAfterWinnerApproval,
          target:
            target?.kind === "general-six-archetype"
              ? {
                  kind: target.kind,
                  portfolioHash: target.portfolio.portfolioHash,
                  pointsLimit: target.portfolio.pointsLimit,
                  items: target.portfolio.items.map((item) => ({
                    archetypeId: item.archetypeId,
                    label: item.label,
                    representativeFaction:
                      item.representativeFactionName,
                    simulationFingerprint:
                      item.simulationFingerprint,
                    evidence: item.selectionEvidence,
                  })),
                  limitations: target.portfolio.limitations,
                }
              : target?.kind === "exact-opponent"
                ? {
                    kind: target.kind,
                    factionId: target.factionId,
                    rosterId: target.roster.id,
                  }
                : target,
        }
      : null,
  };
}

type WorkflowTesseraBaselineJobSummary = {
  targetId: string;
  targetLabel: string;
  ok: boolean;
  runId: string | null;
  runKind: string;
  status: string;
  requestPath: string | null;
  manifestPath: string | null;
  jobDirectory: string | null;
  error: { code: string; message: string } | null;
};

async function startWorkflowTesseraBaselines(
  workflow: RosterWorkflowResult,
  args: Args,
): Promise<WorkflowTesseraBaselineJobSummary[]> {
  if (!workflow.roster || !workflow.optimization) return [];
  const target = workflow.optimization.target;
  const requests: Array<{
    targetId: string;
    targetLabel: string;
    request: TesseraRunRequest;
  }> = [];
  if (target.kind === "exact-opponent") {
    requests.push({
      targetId: target.roster.id,
      targetLabel: target.roster.name,
      request: {
        kind: "exact",
        playerRoster: workflow.roster,
        opponent: { kind: "roster", roster: target.roster },
        options: {
          executionMode: "simulate",
          experimental: false,
          analysisMode: "full",
          includeChangeCandidates: true,
        },
      },
    });
  } else if (target.kind === "known-faction") {
    requests.push({
      targetId: target.factionId,
      targetLabel: target.portfolioPreview.portfolio.factionName,
      request: {
        kind: "stress",
        playerRoster: workflow.roster,
        factionId: target.factionId,
        options: {
          suite: "diverse-9",
          analysisStrategy: "staged",
          executionMode: "simulate",
          experimental: false,
          portfolioPreview: target.portfolioPreview,
        },
      },
    });
  } else {
    for (const item of target.portfolio.items) {
      requests.push({
        targetId: item.archetypeId,
        targetLabel: `${item.label} (${item.representativeFactionName})`,
        request: {
          kind: "exact",
          playerRoster: workflow.roster,
          opponent: { kind: "roster", roster: item.roster },
          options: {
            executionMode: "simulate",
            experimental: false,
            analysisMode: "full",
            includeChangeCandidates: true,
          },
        },
      });
    }
  }
  const outputDirectory =
    value(args, "tessera-out-dir") ?? "exports/tessera";
  return Promise.all(
    requests.map(async ({ targetId, targetLabel, request }) => {
      try {
        const job = await startTesseraRun(request, {
          outputDirectory,
          allowOutsideRoot: flag(args, "allow-outside-root"),
        });
        return {
          targetId,
          targetLabel,
          ok: true,
          runId: job.runId,
          runKind: job.runKind,
          status: job.status,
          requestPath: job.requestPath,
          manifestPath: job.manifestPath,
          jobDirectory: job.jobDirectory,
          error: null,
        };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "TESSERA_BASELINE_START_FAILED";
        return {
          targetId,
          targetLabel,
          ok: false,
          runId: null,
          runKind: request.kind,
          status: "failed-to-start",
          requestPath: null,
          manifestPath: null,
          jobDirectory: null,
          error: {
            code,
            message:
              error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );
}

async function readPortfolioPreview(
  filename: string,
): Promise<TesseraStressPortfolioPreview> {
  const parsed = JSON.parse(
    await readFile(path.resolve(filename), "utf8"),
  ) as unknown;
  const candidate =
    parsed &&
    typeof parsed === "object" &&
    "data" in parsed &&
    parsed.data &&
    typeof parsed.data === "object"
      ? parsed.data
      : parsed;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("previewKind" in candidate) ||
    candidate.previewKind !== "tessera-stress-portfolio"
  ) {
    throw new Error(
      "The portfolio preview file must contain the full successful preview payload produced by preview-portfolio --full-json.",
    );
  }
  return candidate as TesseraStressPortfolioPreview;
}

function help(): void {
  process.stdout.write(`RosterPilot deterministic army builder

Choose only the workflow you need. Building, exporting, New Recruit delivery,
and Tessera analysis are separate actions; none runs automatically after another.

Usage:
  rosterpilot workflows
  rosterpilot status
  rosterpilot freshness
  rosterpilot data update-status
  rosterpilot data refresh [--force]
  rosterpilot data rollback --bundle <bundle-id>
  rosterpilot rebase --file roster.json [--out rebased.json]
  rosterpilot conflicts [--faction adeptus-custodes] [--blocking true]
  rosterpilot search [query] [--faction adeptus-custodes] [--tags mobility,objective] [--include-legends]
  rosterpilot compare <faction> <faction>
  rosterpilot workflow --prompt "Build a 1,000 point Custodes army and upload it to New Recruit" [--intent build|prepare-new-recruit|deliver-new-recruit|optimize] [--coaching none|concise|full] [--optimizer-mode guided|recommend-only] [--opponent-faction aeldari | --opponent-roster enemy.json] [--out roster.json] [--portfolio-out general-threat-portfolio.json] [--out-dir exports/new-recruit] [--tessera-out-dir exports/tessera]
  rosterpilot build --prompt "Build a fast 1,000 point Aeldari army" [--legends-policy auto|allow|exclude] [--play-context unspecified|open-play|casual|narrative|matched-play] [--include-legends] [--out roster.json]
  rosterpilot modify --file roster.json --operation '{"type":"remove","selectionId":"..."}' [--out next.json]
  rosterpilot validate --file roster.json
  rosterpilot explain --file roster.json
  rosterpilot export --file roster.json --format rosz --out roster.rosz [--overwrite]
  rosterpilot agent install
  rosterpilot agent status
  rosterpilot agent ensure-current
  rosterpilot agent restart
  rosterpilot agent uninstall
  rosterpilot new-recruit configure
  rosterpilot new-recruit status
  rosterpilot new-recruit coverage --faction adeptus-custodes
  rosterpilot new-recruit forget
  rosterpilot new-recruit deliver --file roster.json [--out-dir exports/new-recruit] [--no-pretty]
  rosterpilot tessera status
  rosterpilot tessera configure
  rosterpilot tessera forget
  rosterpilot tessera prepare --file roster.json [--out-dir exports/tessera] [--verified-catalogue-drift-diagnostic]
  rosterpilot tessera analyze --file roster.json (--opponent-file army.rosz [--opponent-context enemy.json] | --opponent-roster enemy.json) [--execution-mode prepare-only|simulate] [--fallback none|baseline-damage-v1] [--profile-policy profiles.json] [--analysis-mode quick|full] [--phases shooting,fight] [--metrics wipe-probability,half-wipe-probability,mean-kills,mean-damage] [--allow-point-mismatch] [--verified-catalogue-drift-diagnostic] [--no-change-candidates]
  rosterpilot tessera stress-test --file roster.json --against-faction aeldari [--suite core-3|diverse-9] [--execution-mode prepare-only|simulate] [--analysis staged|full-all] [--profile-policy profiles.json] [--verified-catalogue-drift-diagnostic] [--resume [manifest.json] | --restart-from manifest.json] [--force-retry] [--full-json] [--out-dir exports/tessera] [--overwrite]
  rosterpilot tessera preview-portfolio --against-faction aeldari [--points 1000] [--suite core-3|diverse-9] [--full-json]
  rosterpilot tessera build-and-stress --prompt "Build a mobile, durable 1,000 point Custodes army" --player-faction adeptus-custodes --against-faction aeldari [--legends-policy auto|allow|exclude] [--play-context unspecified|open-play|casual|narrative|matched-play] [--include-legends] [--required-unit farseer] [--exclude-unit warlock-skyrunners] [--required-warlord farseer-skyrunner] [--suite diverse-9] [--execution-mode prepare-only|simulate] [--analysis staged] [--profile-policy profiles.json] [--verified-catalogue-drift-diagnostic] [--resume [manifest.json] | --restart-from manifest.json] [--allow-readiness-warnings] [--full-json]
  rosterpilot tessera build-and-analyze --prompt "Build a counter-roster" --player-faction adeptus-custodes --opponent-roster enemy.json [--legends-policy auto|allow|exclude] [--play-context unspecified|open-play|casual|narrative|matched-play] [--include-legends] [--collection collection.json] [--execution-mode prepare-only|simulate] [--profile-policy profiles.json] [--verified-catalogue-drift-diagnostic] [--allow-readiness-warnings] [--full-json]
  rosterpilot tessera start-run --run-kind exact|stress|build-and-stress|build-and-analyze [workflow options] [--legends-policy auto|allow|exclude] [--play-context unspecified|open-play|casual|narrative|matched-play] [--include-legends] [--portfolio-preview preview.json] [--verified-catalogue-drift-diagnostic]
  rosterpilot tessera run-status --job exports/tessera/runs/run-.../tessera-run.json [--full-json]
  rosterpilot tessera run-resume --job exports/tessera/runs/run-.../tessera-run.json [--restart-from] [--out-dir exports/tessera]
  rosterpilot tessera resolve-profiles --job ... --profile-policy profiles.json
  rosterpilot tessera run-cancel --job exports/tessera/runs/run-.../tessera-run.json
  rosterpilot tessera compare-revision --baseline-report matchup.json --revised-roster revised.json [--profile-policy profiles.json] [--verified-catalogue-drift-diagnostic] [--out-dir exports/tessera]
  rosterpilot tessera compare-stress-revision --baseline-report stress-test.json --revised-roster revised.json [--verified-catalogue-drift-diagnostic] [--out-dir exports/tessera] [--overwrite]
  rosterpilot tessera optimizer-start --baseline-report matchup.json --file roster.json [--mode guided|recommend-only] [--profile-policy profiles.json] [--out-dir exports/tessera/optimizers]
  rosterpilot tessera optimizer-status --optimizer exports/tessera/optimizers/optimizer-.../tessera-optimizer.json
  rosterpilot tessera optimizer-approve-candidates --optimizer ... --expected-revision 0 --candidate candidate-id [--candidate another-id] --approval-id approval-id --approved-by name
  rosterpilot tessera optimizer-record-comparison --optimizer ... --expected-revision 2 --candidate candidate-id --report comparison.json
  rosterpilot tessera optimizer-approve-winner --optimizer ... --expected-revision 3 --candidate candidate-id --approval-id approval-id --approved-by name
  rosterpilot tessera optimizer-retain-baseline --optimizer ... --expected-revision 3 --approval-id approval-id --approved-by name
  rosterpilot tessera optimizer-finalize --optimizer ... --expected-revision 4 [--delivery-intent none|prepare-handoff|deliver-new-recruit] [--intent-id intent-id --recorded-by name]
  rosterpilot tessera general-optimizer-start --file roster.json --portfolio general-threat-portfolio.json --baseline horde=horde.json --baseline elite=elite.json --baseline ranged-pressure=ranged.json --baseline armour-monster=armour.json --baseline fast-scoring-msu=msu.json --baseline melee-pressure=melee.json [--profile-policy horde=horde-profiles.json] [--mode guided|recommend-only] [--out-dir exports/tessera/general-optimizers]
  rosterpilot tessera general-optimizer-status --optimizer exports/tessera/general-optimizers/general-optimizer-.../tessera-general-optimizer.json
  rosterpilot tessera general-optimizer-approve-candidates --optimizer ... --expected-revision 0 --candidate candidate-id [--candidate another-id] --approval-id approval-id --approved-by name
  rosterpilot tessera general-optimizer-record-comparison --optimizer ... --expected-revision 2 --candidate candidate-id --archetype horde --request-sha256 <sha256> --report comparison.json
  rosterpilot tessera general-optimizer-approve-winner --optimizer ... --expected-revision 8 --candidate candidate-id --approval-id approval-id --approved-by name
  rosterpilot tessera general-optimizer-retain-baseline --optimizer ... --expected-revision 8 --approval-id approval-id --approved-by name
  rosterpilot tessera general-optimizer-finalize --optimizer ... --expected-revision 9 [--delivery-intent none|prepare-handoff|deliver-new-recruit] [--intent-id intent-id --recorded-by name]
  rosterpilot mcp

Writes are restricted to the current directory unless --allow-outside-root is supplied.
Existing files are never replaced unless --overwrite is supplied.
For stress tests, bare --resume reads <out-dir>/stress-manifest.json.
Use --restart-from with a different --out-dir after a five-attempt budget is
exhausted; verified prepared artifacts are reused, but simulation stages start fresh.
Stress tests default to the diverse-9 suite and staged analysis; results are
directional robustness ranges, not game win probabilities.
Optimizer candidate and winner approvals are separate durable gates. Finalize
records delivery intent only; it does not upload a roster to New Recruit.
General optimizer baselines are keyed by archetype, never array position. Supply
exactly one repeatable --baseline archetype=path mapping for each of the six
general-threat archetypes; profile policies use the same keyed form.
--verified-catalogue-drift-diagnostic is not a general drift override. It
accepts only a newer game-system revision with exact faction-catalogue identity
and complete per-unit profiles. Set it when starting a durable run; resume
cannot enable it, and retained artifacts remain provisional.
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
              'rosterpilot build --prompt "Build a 1,000 point Custodes army" --out roster.json',
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
              "rosterpilot new-recruit deliver --file roster.json",
          },
          {
            id: "tessera",
            label: "Compare known armies in Tessera",
            available: tessera.data?.available ?? false,
            setupProfile: "tessera",
            requires: [
              "validated player roster",
              "one exact opponent roster or .rosz",
              "New Recruit-enriched profiles",
              "macOS local automation and a Tessera licence key",
            ],
            produces: [
              "directional scenario matrices",
              "interactive HTML report",
              "machine-readable JSON report",
            ],
            nextCommand:
              "rosterpilot tessera analyze --file roster.json --opponent-roster enemy.json --execution-mode simulate",
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
              "rosterpilot tessera stress-test --file roster.json --against-faction necrons --execution-mode simulate",
          },
          {
            id: "tessera-optimizer",
            label:
              "Approval-gated paired Tessera roster optimization",
            available: tessera.data?.available ?? false,
            setupProfile: "tessera",
            requires: [
              "one complete exact/stress baseline or six keyed general exact baselines",
              "the exact canonical baseline roster",
              "the frozen six-archetype portfolio for general optimization",
              "explicit candidate-batch and exact-winner approvals",
            ],
            produces: [
              "durable frozen optimizer state",
              "paired revision requests and evidence receipts",
              "single-baseline or aggregate no-regression Pareto frontier",
              "final canonical roster artifact",
            ],
            nextCommand:
              "rosterpilot tessera optimizer-start --baseline-report result.json --file roster.json --mode guided",
          },
        ],
      },
      violations: [],
      warnings: workflowWarnings,
    });
    return;
  }
  if (
    command === "data" ||
    command === "data-update-status" ||
    command === "refresh-data-now" ||
    command === "rollback-data-bundle"
  ) {
    const action =
      command === "data"
        ? (positionals[0] ?? "update-status")
        : command === "data-update-status"
          ? "update-status"
          : command === "refresh-data-now"
            ? "refresh"
            : "rollback";
    const result =
      action === "update-status" || action === "status"
        ? await getDataUpdateStatus()
        : action === "refresh"
          ? await refreshDataNow({
              force:
                args.force === undefined
                  ? true
                  : flag(args, "force"),
            })
          : action === "rollback"
            ? await rollbackDataBundle(
                value(args, "bundle") ??
                  value(args, "bundle-id") ??
                  positionals[1] ??
                  "",
              )
            : null;
    if (!result) {
      throw new Error(`Unknown data command "${action}".`);
    }
    print(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === "agent") {
    const action = positionals[0] ?? "status";
    const result =
      action === "install"
        ? await installLocalAgent()
        : action === "status"
          ? await getLocalAgentLifecycleStatus()
          : action === "ensure-current"
            ? await ensureCurrentLocalAgent()
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
        // A verified enriched archive is required to detect a lagging or
        // advanced New Recruit catalogue before accepting the delivery.
        downloadEnrichedRosz: true,
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
    if (action === "general-optimizer-start") {
      const rosterPath = value(args, "file");
      const portfolioPath = value(args, "portfolio");
      const mode = value(args, "mode") ?? "guided";
      if (!rosterPath || !portfolioPath) {
        throw new Error(
          "Tessera general-optimizer-start requires --file and --portfolio.",
        );
      }
      if (mode !== "guided" && mode !== "recommend-only") {
        throw new Error(
          "Tessera general-optimizer-start --mode requires guided or recommend-only.",
        );
      }
      const baselinePaths = generalArchetypeMappings(
        args,
        "baseline",
        true,
      );
      const profilePolicyPaths = generalArchetypeMappings(
        args,
        "profile-policy",
        false,
      );
      const result = await startTesseraGeneralOptimizer({
        baselineRoster: await readRosterDraft(path.resolve(rosterPath)),
        portfolioPath: path.resolve(portfolioPath),
        baselines: GeneralThreatArchetypeIds.map((archetypeId) => ({
          archetypeId,
          reportPath: path.resolve(baselinePaths.get(archetypeId)!),
          ...(profilePolicyPaths.has(archetypeId)
            ? {
                profilePolicyPath: path.resolve(
                  profilePolicyPaths.get(archetypeId)!,
                ),
              }
            : {}),
        })),
        mode,
        outputDirectory:
          value(args, "out-dir") ??
          "exports/tessera/general-optimizers",
        allowOutsideRoot: flag(args, "allow-outside-root"),
      });
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "general-optimizer-status") {
      const result = await getTesseraGeneralOptimizerStatus(
        generalOptimizerStatePath(args),
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "general-optimizer-approve-candidates") {
      const candidateIds = list(args, "candidate");
      const approvalId = value(args, "approval-id");
      const approvedBy = value(args, "approved-by");
      if (!candidateIds.length || !approvalId || !approvedBy) {
        throw new Error(
          "Tessera general-optimizer-approve-candidates requires one or more --candidate values, --approval-id, and --approved-by.",
        );
      }
      const result =
        await approveAndMaterializeTesseraGeneralOptimizerCandidates(
          generalOptimizerStatePath(args),
          {
            expectedStateRevision: requiredInteger(
              args,
              "expected-revision",
            ),
            candidateIds,
            approvalId,
            approvedBy,
            approvedAt: value(args, "approved-at"),
          },
        );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "general-optimizer-record-comparison") {
      const candidateId = value(args, "candidate");
      const archetypeId = value(args, "archetype");
      const requestSha256 = value(args, "request-sha256");
      const reportPath = value(args, "report");
      if (
        !candidateId ||
        !archetypeId ||
        !requestSha256 ||
        !reportPath
      ) {
        throw new Error(
          "Tessera general-optimizer-record-comparison requires --candidate, --archetype, --request-sha256, and --report.",
        );
      }
      if (!isGeneralThreatArchetype(archetypeId)) {
        throw new Error(
          `--archetype requires one of: ${
            GeneralThreatArchetypeIds.join(", ")
          }.`,
        );
      }
      if (!/^[0-9a-f]{64}$/.test(requestSha256)) {
        throw new Error(
          "--request-sha256 requires a lowercase SHA-256 value.",
        );
      }
      const result =
        await recordStoredTesseraGeneralOptimizerComparison(
          generalOptimizerStatePath(args),
          {
            expectedStateRevision: requiredInteger(
              args,
              "expected-revision",
            ),
            candidateId,
            archetypeId,
            requestSha256,
            reportPath: path.resolve(reportPath),
            recordedAt: value(args, "recorded-at"),
          },
        );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "general-optimizer-approve-winner") {
      const candidateId = value(args, "candidate");
      const approvalId = value(args, "approval-id");
      const approvedBy = value(args, "approved-by");
      if (!candidateId || !approvalId || !approvedBy) {
        throw new Error(
          "Tessera general-optimizer-approve-winner requires --candidate, --approval-id, and --approved-by.",
        );
      }
      const result = await approveStoredTesseraGeneralOptimizerWinner(
        generalOptimizerStatePath(args),
        {
          expectedStateRevision: requiredInteger(
            args,
            "expected-revision",
          ),
          candidateId,
          approvalId,
          approvedBy,
          approvedAt: value(args, "approved-at"),
        },
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "general-optimizer-retain-baseline") {
      const approvalId = value(args, "approval-id");
      const approvedBy = value(args, "approved-by");
      if (!approvalId || !approvedBy) {
        throw new Error(
          "Tessera general-optimizer-retain-baseline requires --approval-id and --approved-by.",
        );
      }
      const result = await retainStoredTesseraGeneralOptimizerBaseline(
        generalOptimizerStatePath(args),
        {
          expectedStateRevision: requiredInteger(
            args,
            "expected-revision",
          ),
          approvalId,
          approvedBy,
          approvedAt: value(args, "approved-at"),
        },
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "general-optimizer-finalize") {
      const deliveryKind = value(args, "delivery-intent") ?? "none";
      if (
        deliveryKind !== "none" &&
        deliveryKind !== "prepare-handoff" &&
        deliveryKind !== "deliver-new-recruit"
      ) {
        throw new Error(
          "Tessera general-optimizer-finalize --delivery-intent requires none, prepare-handoff, or deliver-new-recruit.",
        );
      }
      const finalizedAt =
        value(args, "finalized-at") ?? new Date().toISOString();
      const intentId = value(args, "intent-id");
      const recordedBy = value(args, "recorded-by");
      if (deliveryKind !== "none" && (!intentId || !recordedBy)) {
        throw new Error(
          "A non-empty general optimizer delivery intent requires --intent-id and --recorded-by.",
        );
      }
      const result = await finalizeStoredTesseraGeneralOptimizer(
        generalOptimizerStatePath(args),
        {
          expectedStateRevision: requiredInteger(
            args,
            "expected-revision",
          ),
          deliveryIntent:
            deliveryKind === "none"
              ? {
                  kind: "none",
                  intentId: null,
                  recordedBy: null,
                  recordedAt: finalizedAt,
                }
              : {
                  kind: deliveryKind,
                  intentId: intentId!,
                  recordedBy: recordedBy!,
                  recordedAt: finalizedAt,
                },
          finalizedAt,
        },
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "optimizer-start") {
      const baselineReportPath = value(args, "baseline-report");
      const rosterPath = value(args, "file");
      const mode = value(args, "mode") ?? "guided";
      if (!baselineReportPath || !rosterPath) {
        throw new Error(
          "Tessera optimizer-start requires --baseline-report and --file.",
        );
      }
      if (mode !== "guided" && mode !== "recommend-only") {
        throw new Error(
          "Tessera optimizer-start --mode requires guided or recommend-only.",
        );
      }
      const result = await startTesseraOptimizer({
        baselineReportPath: path.resolve(baselineReportPath),
        baselineRoster: await readRosterDraft(path.resolve(rosterPath)),
        mode,
        profilePolicyPath: value(args, "profile-policy"),
        outputDirectory:
          value(args, "out-dir") ??
          "exports/tessera/optimizers",
        allowOutsideRoot: flag(args, "allow-outside-root"),
      });
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "optimizer-status") {
      const result = await getTesseraOptimizerStatus(
        optimizerStatePath(args),
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "optimizer-approve-candidates") {
      const candidateIds = list(args, "candidate");
      const approvalId = value(args, "approval-id");
      const approvedBy = value(args, "approved-by");
      if (!candidateIds.length || !approvalId || !approvedBy) {
        throw new Error(
          "Tessera optimizer-approve-candidates requires one or more --candidate values, --approval-id, and --approved-by.",
        );
      }
      const result =
        await approveAndMaterializeTesseraOptimizerCandidates(
          optimizerStatePath(args),
          {
            expectedStateRevision: requiredInteger(
              args,
              "expected-revision",
            ),
            candidateIds,
            approvalId,
            approvedBy,
            approvedAt: value(args, "approved-at"),
          },
        );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "optimizer-record-comparison") {
      const candidateId = value(args, "candidate");
      const reportPath = value(args, "report");
      if (!candidateId || !reportPath) {
        throw new Error(
          "Tessera optimizer-record-comparison requires --candidate and --report.",
        );
      }
      const result = await recordStoredTesseraOptimizerComparison(
        optimizerStatePath(args),
        {
          expectedStateRevision: requiredInteger(
            args,
            "expected-revision",
          ),
          candidateId,
          reportPath: path.resolve(reportPath),
          recordedAt: value(args, "recorded-at"),
        },
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "optimizer-approve-winner") {
      const candidateId = value(args, "candidate");
      const approvalId = value(args, "approval-id");
      const approvedBy = value(args, "approved-by");
      if (!candidateId || !approvalId || !approvedBy) {
        throw new Error(
          "Tessera optimizer-approve-winner requires --candidate, --approval-id, and --approved-by.",
        );
      }
      const result = await approveStoredTesseraOptimizerWinner(
        optimizerStatePath(args),
        {
          expectedStateRevision: requiredInteger(
            args,
            "expected-revision",
          ),
          candidateId,
          approvalId,
          approvedBy,
          approvedAt: value(args, "approved-at"),
        },
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "optimizer-retain-baseline") {
      const approvalId = value(args, "approval-id");
      const approvedBy = value(args, "approved-by");
      if (!approvalId || !approvedBy) {
        throw new Error(
          "Tessera optimizer-retain-baseline requires --approval-id and --approved-by.",
        );
      }
      const result = await retainStoredTesseraOptimizerBaseline(
        optimizerStatePath(args),
        {
          expectedStateRevision: requiredInteger(
            args,
            "expected-revision",
          ),
          approvalId,
          approvedBy,
          approvedAt: value(args, "approved-at"),
        },
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "optimizer-finalize") {
      const deliveryKind = value(args, "delivery-intent") ?? "none";
      if (
        deliveryKind !== "none" &&
        deliveryKind !== "prepare-handoff" &&
        deliveryKind !== "deliver-new-recruit"
      ) {
        throw new Error(
          "Tessera optimizer-finalize --delivery-intent requires none, prepare-handoff, or deliver-new-recruit.",
        );
      }
      const finalizedAt =
        value(args, "finalized-at") ?? new Date().toISOString();
      const intentId = value(args, "intent-id");
      const recordedBy = value(args, "recorded-by");
      if (deliveryKind !== "none" && (!intentId || !recordedBy)) {
        throw new Error(
          "A non-empty optimizer delivery intent requires --intent-id and --recorded-by.",
        );
      }
      const result = await finalizeStoredTesseraOptimizer(
        optimizerStatePath(args),
        {
          expectedStateRevision: requiredInteger(
            args,
            "expected-revision",
          ),
          deliveryIntent:
            deliveryKind === "none"
              ? {
                  kind: "none",
                  intentId: null,
                  recordedBy: null,
                  recordedAt: finalizedAt,
                }
              : {
                  kind: deliveryKind,
                  intentId: intentId!,
                  recordedBy: recordedBy!,
                  recordedAt: finalizedAt,
                },
          finalizedAt,
        },
      );
      print(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (action === "run-status") {
      const jobPath = value(args, "job");
      if (!jobPath) {
        throw new Error("Tessera run-status requires --job.");
      }
      print(
        await getTesseraRunStatus(
          path.resolve(jobPath),
          flag(args, "full-json"),
        ),
      );
      return;
    }
    if (action === "run-resume") {
      const jobPath = value(args, "job");
      if (!jobPath) {
        throw new Error("Tessera run-resume requires --job.");
      }
      print(
        await resumeTesseraRun(path.resolve(jobPath), {
          restartFrom: flag(args, "restart-from"),
          outputDirectory: value(args, "out-dir"),
          allowOutsideRoot: flag(args, "allow-outside-root"),
        }),
      );
      return;
    }
    if (action === "run-cancel") {
      const jobPath = value(args, "job");
      if (!jobPath) {
        throw new Error("Tessera run-cancel requires --job.");
      }
      print(await cancelTesseraRun(path.resolve(jobPath)));
      return;
    }
    if (action === "resolve-profiles") {
      const jobPath = value(args, "job");
      const policyPath = value(args, "profile-policy");
      if (!jobPath || !policyPath) {
        throw new Error(
          "Tessera resolve-profiles requires --job and --profile-policy.",
        );
      }
      const policy = ProfilePolicySchema.parse(
        JSON.parse(await readFile(path.resolve(policyPath), "utf8")),
      );
      print(
        await resolveTesseraRunProfiles(
          path.resolve(jobPath),
          policy,
        ),
      );
      return;
    }
    if (action === "start-run") {
      const runKind = value(args, "run-kind");
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
      const suite = value(args, "suite") as
        | TesseraStressSuite
        | undefined;
      if (
        suite &&
        suite !== "core-3" &&
        suite !== "diverse-9"
      ) {
        throw new Error(`Unknown Tessera suite "${suite}".`);
      }
      const analysisStrategy = value(args, "analysis") as
        | TesseraStressAnalysisStrategy
        | undefined;
      if (
        analysisStrategy &&
        analysisStrategy !== "staged" &&
        analysisStrategy !== "full-all"
      ) {
        throw new Error(
          `Unknown Tessera analysis strategy "${analysisStrategy}".`,
        );
      }
      let request: TesseraRunRequest;
      if (runKind === "exact") {
        const playerFile = value(args, "file");
        const opponentRosterFile = value(args, "opponent-roster");
        const opponentRoszFile = value(args, "opponent-file");
        const opponentContextFile = value(
          args,
          "opponent-context",
        );
        if (!playerFile) {
          throw new Error(
            "An exact start-run requires --file.",
          );
        }
        const selectedOpponents =
          Number(Boolean(opponentRosterFile)) +
          Number(Boolean(opponentRoszFile));
        if (selectedOpponents === 0) {
          throw Object.assign(
            new Error(
              "OPPONENT_SCOPE_REQUIRED: provide --opponent-roster or --opponent-file, or use a stress run when only the opponent faction is known.",
            ),
            { code: "OPPONENT_SCOPE_REQUIRED" },
          );
        }
        if (selectedOpponents > 1) {
          throw new Error(
            "An exact start-run accepts exactly one of --opponent-roster or --opponent-file.",
          );
        }
        if (opponentContextFile && !opponentRoszFile) {
          throw new Error(
            "An exact start-run accepts --opponent-context only with --opponent-file.",
          );
        }
        request = {
          kind: "exact",
          playerRoster: await readRosterDraft(
            path.resolve(playerFile),
          ),
          opponent: opponentRosterFile
            ? {
                kind: "roster",
                roster: await readRosterDraft(
                  path.resolve(opponentRosterFile),
                ),
              }
            : {
                kind: "rosz",
                path: path.resolve(opponentRoszFile!),
              },
          options: {
            executionMode: executionMode as
              | "prepare-only"
              | "simulate"
              | undefined,
            profilePolicyPath: value(args, "profile-policy"),
            opponentRosterContext: opponentContextFile
              ? await readRosterDraft(
                  path.resolve(opponentContextFile),
                )
              : undefined,
            catalogueDriftMode: flag(
              args,
              "verified-catalogue-drift-diagnostic",
            )
              ? "diagnostic"
              : "reject",
          },
        };
      } else if (runKind === "stress") {
        const playerFile = value(args, "file");
        const factionId =
          value(args, "against-faction") ??
          value(args, "opponent-faction");
        if (!playerFile || !factionId) {
          throw new Error(
            "A stress start-run requires --file and --against-faction.",
          );
        }
        const portfolioPreviewPath = value(
          args,
          "portfolio-preview",
        );
        request = {
          kind: "stress",
          playerRoster: await readRosterDraft(
            path.resolve(playerFile),
          ),
          factionId,
          options: {
            suite,
            analysisStrategy,
            executionMode: executionMode as
              | "prepare-only"
              | "simulate"
              | undefined,
            profilePolicyPath: value(args, "profile-policy"),
            portfolioPreview: portfolioPreviewPath
              ? await readPortfolioPreview(
                  portfolioPreviewPath,
                )
              : undefined,
            catalogueDriftMode: flag(
              args,
              "verified-catalogue-drift-diagnostic",
            )
              ? "diagnostic"
              : "reject",
          },
        };
      } else if (runKind === "build-and-stress") {
        const prompt = value(args, "prompt");
        const againstFaction = value(args, "against-faction");
        if (!prompt || !againstFaction) {
          throw new Error(
            "A build-and-stress start-run requires --prompt and --against-faction.",
          );
        }
        request = {
          kind: "build-and-stress",
          input: {
            prompt,
            playerFaction: value(args, "player-faction"),
            againstFaction,
            pointsLimit: value(args, "points")
              ? Number(value(args, "points"))
              : undefined,
            legendsPolicy: requestedLegendsPolicy(args),
            allowLegends: flag(args, "include-legends")
              ? true
              : undefined,
            playContext: requestedPlayContext(args),
            requiredUnitIds: list(args, "required-unit"),
            excludedUnitIds: list(args, "exclude-unit"),
            requiredWarlordUnitId:
              value(args, "required-warlord"),
            suite,
            analysisStrategy,
            executionMode: executionMode as
              | "prepare-only"
              | "simulate"
              | undefined,
            profilePolicyPath: value(args, "profile-policy"),
            allowReadinessWarnings: flag(
              args,
              "allow-readiness-warnings",
            ),
          },
          options: {
            catalogueDriftMode: flag(
              args,
              "verified-catalogue-drift-diagnostic",
            )
              ? "diagnostic"
              : "reject",
          },
        };
      } else if (runKind === "build-and-analyze") {
        const prompt = value(args, "prompt");
        const opponentRosterFile = value(args, "opponent-roster");
        if (!prompt || !opponentRosterFile) {
          throw new Error(
            "A build-and-analyze start-run requires --prompt and --opponent-roster.",
          );
        }
        const collectionPath = value(args, "collection");
        request = {
          kind: "build-and-analyze",
          input: {
            prompt,
            playerFaction: value(args, "player-faction"),
            pointsLimit: value(args, "points")
              ? Number(value(args, "points"))
              : undefined,
            opponentRoster: await readRosterDraft(
              path.resolve(opponentRosterFile),
            ),
            legendsPolicy: requestedLegendsPolicy(args),
            allowLegends: flag(args, "include-legends")
              ? true
              : undefined,
            playContext: requestedPlayContext(args),
            collectionProfile: collectionPath
              ? CollectionProfileSchema.parse(
                  JSON.parse(
                    await readFile(
                      path.resolve(collectionPath),
                      "utf8",
                    ),
                  ),
                )
              : undefined,
            requiredUnitIds: list(args, "required-unit"),
            excludedUnitIds: list(args, "exclude-unit"),
            requiredWarlordUnitId:
              value(args, "required-warlord"),
            executionMode: executionMode as
              | "prepare-only"
              | "simulate"
              | undefined,
            profilePolicyPath: value(args, "profile-policy"),
            allowReadinessWarnings: flag(
              args,
              "allow-readiness-warnings",
            ),
          },
          options: {
            catalogueDriftMode: flag(
              args,
              "verified-catalogue-drift-diagnostic",
            )
              ? "diagnostic"
              : "reject",
          },
        };
      } else {
        throw new Error(
          "Tessera start-run requires --run-kind exact, stress, build-and-stress, or build-and-analyze.",
        );
      }
      print(
        await startTesseraRun(request, {
          outputDirectory: value(args, "out-dir"),
          allowOutsideRoot: flag(args, "allow-outside-root"),
        }),
      );
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
      const suite = value(args, "suite") as
        | TesseraStressSuite
        | undefined;
      if (
        suite &&
        suite !== "core-3" &&
        suite !== "diverse-9"
      ) {
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
      const suite = value(args, "suite") as
        | TesseraStressSuite
        | undefined;
      if (
        suite &&
        suite !== "core-3" &&
        suite !== "diverse-9"
      ) {
        throw new Error(`Unknown Tessera portfolio suite "${suite}".`);
      }
      const analysisStrategy = value(args, "analysis") as
        | TesseraStressAnalysisStrategy
        | undefined;
      if (
        analysisStrategy &&
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
      if (
        shouldStartDurableTesseraRun(
          executionMode,
          flag(args, "experimental"),
          Boolean(resumeManifestPath || restartManifest),
        )
      ) {
        const job = await startTesseraRun(
          {
            kind: "build-and-stress",
            input: {
              prompt,
              playerFaction: value(args, "player-faction"),
              againstFaction,
              pointsLimit: value(args, "points")
                ? Number(value(args, "points"))
                : undefined,
              legendsPolicy: requestedLegendsPolicy(args),
              allowLegends: flag(args, "include-legends")
                ? true
                : undefined,
              playContext: requestedPlayContext(args),
              requiredUnitIds: list(args, "required-unit"),
              excludedUnitIds: list(args, "exclude-unit"),
              requiredWarlordUnitId:
                value(args, "required-warlord"),
              suite,
              analysisStrategy,
              profilePolicyPath:
                value(args, "profile-policy"),
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
              executionMode: "simulate",
              experimental: false,
            },
            options: {
              outputDirectory,
              executionMode: "simulate",
              experimental: false,
              catalogueDriftMode:
                requestedCatalogueDriftMode(
                  args,
                  Boolean(
                    resumeManifestPath || restartManifest,
                  ),
                ),
            },
          },
          {
            outputDirectory,
            allowOutsideRoot: flag(args, "allow-outside-root"),
          },
        );
        printStartedTesseraRun(job);
        return;
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
          legendsPolicy: requestedLegendsPolicy(args),
          allowLegends: flag(args, "include-legends")
            ? true
            : undefined,
          playContext: requestedPlayContext(args),
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
          catalogueDriftMode:
            requestedCatalogueDriftMode(
              args,
              Boolean(
                resumeManifestPath || restartManifest,
              ),
            ),
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
    if (action === "build-and-analyze") {
      const prompt = value(args, "prompt");
      const opponentRosterFile = value(args, "opponent-roster");
      if (!prompt || !opponentRosterFile) {
        throw new Error(
          "Tessera build-and-analyze requires --prompt and --opponent-roster.",
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
      const collectionPath = value(args, "collection");
      const outputDirectory =
        value(args, "out-dir") ?? "exports/tessera";
      const opponentRoster = await readRosterDraft(
        path.resolve(opponentRosterFile),
      );
      const collectionProfile = collectionPath
        ? CollectionProfileSchema.parse(
            JSON.parse(
              await readFile(
                path.resolve(collectionPath),
                "utf8",
              ),
            ),
          )
        : undefined;
      const buildInput = {
        prompt,
        playerFaction: value(args, "player-faction"),
        pointsLimit: value(args, "points")
          ? Number(value(args, "points"))
          : undefined,
        opponentRoster,
        legendsPolicy: requestedLegendsPolicy(args),
        allowLegends: flag(args, "include-legends")
          ? true
          : undefined,
        playContext: requestedPlayContext(args),
        collectionProfile,
        requiredUnitIds: list(args, "required-unit"),
        excludedUnitIds: list(args, "exclude-unit"),
        requiredWarlordUnitId:
          value(args, "required-warlord"),
        allowReadinessWarnings: flag(
          args,
          "allow-readiness-warnings",
        ),
        profilePolicyPath: value(args, "profile-policy"),
        outputDirectory,
        executionMode: executionMode as
          | "prepare-only"
          | "simulate"
          | undefined,
        experimental: flag(args, "experimental"),
      };
      if (
        shouldStartDurableTesseraRun(
          executionMode,
          flag(args, "experimental"),
        )
      ) {
        const job = await startTesseraRun(
          {
            kind: "build-and-analyze",
            input: {
              ...buildInput,
              executionMode: "simulate",
              experimental: false,
            },
            options: {
              outputDirectory,
              executionMode: "simulate",
              experimental: false,
              catalogueDriftMode: flag(
                args,
                "verified-catalogue-drift-diagnostic",
              )
                ? "diagnostic"
                : "reject",
            },
          },
          {
            outputDirectory,
            allowOutsideRoot: flag(args, "allow-outside-root"),
          },
        );
        printStartedTesseraRun(job);
        return;
      }
      const result = await buildAndAnalyzeRosterMatchup(
        buildInput,
        {
          outputDirectory,
          overwrite: flag(args, "overwrite"),
          allowOutsideRoot: flag(args, "allow-outside-root"),
          catalogueDriftMode: flag(
            args,
            "verified-catalogue-drift-diagnostic",
          )
            ? "diagnostic"
            : "reject",
        },
      );
      print(
        flag(args, "full-json")
          ? result
          : compactBuildAndAnalyzeResult(result),
      );
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
      const outputDirectory =
        value(args, "out-dir") ?? "exports/tessera";
      const job = await startTesseraRun(
        {
          kind: "exact-revision",
          baselineReportPath: path.resolve(baselineReport),
          revisedRoster,
          options: {
            outputDirectory,
            profilePolicyPath:
              value(args, "profile-policy"),
            executionMode: "simulate",
            experimental: false,
            catalogueDriftMode:
              requestedCatalogueDriftMode(args),
          },
        },
        {
          outputDirectory,
          allowOutsideRoot: flag(args, "allow-outside-root"),
        },
      );
      printStartedTesseraRun(job);
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
      const outputDirectory =
        value(args, "out-dir") ?? "exports/tessera";
      const job = await startTesseraRun(
        {
          kind: "stress-revision",
          baselineReportPath: path.resolve(baselineReport),
          revisedRoster,
          options: {
            outputDirectory,
            executionMode: "simulate",
            experimental: false,
            catalogueDriftMode:
              requestedCatalogueDriftMode(args, true),
          },
        },
        {
          outputDirectory,
          allowOutsideRoot: flag(args, "allow-outside-root"),
        },
      );
      printStartedTesseraRun(job);
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
        catalogueDriftMode: flag(
          args,
          "verified-catalogue-drift-diagnostic",
        )
          ? "diagnostic"
          : "reject",
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
      const suite = value(args, "suite") as
        | TesseraStressSuite
        | undefined;
      if (
        suite !== undefined &&
        suite !== "core-3" &&
        suite !== "diverse-9"
      ) {
        throw new Error(
          `Unknown Tessera stress-test suite "${suite}". Expected core-3 or diverse-9.`,
        );
      }
      const analysisStrategy = value(args, "analysis") as
        | TesseraStressAnalysisStrategy
        | undefined;
      if (
        analysisStrategy &&
        analysisStrategy !== "staged" &&
        analysisStrategy !== "full-all"
      ) {
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
      if (
        shouldStartDurableTesseraRun(
          executionMode,
          flag(args, "experimental"),
          Boolean(resumeManifestPath || restartManifest),
        )
      ) {
        const job = await startTesseraRun(
          {
            kind: "stress",
            playerRoster: roster,
            factionId: opponentFaction,
            options: {
              suite,
              analysisStrategy,
              resumeManifestPath,
              restartManifestPath: restartManifest
                ? path.resolve(restartManifest)
                : undefined,
              profilePolicyPath: value(args, "profile-policy"),
              forceRetry: flag(args, "force-retry"),
              outputDirectory,
              executionMode: "simulate",
              experimental: false,
              catalogueDriftMode:
                requestedCatalogueDriftMode(
                  args,
                  Boolean(
                    resumeManifestPath || restartManifest,
                  ),
                ),
            },
          },
          {
            outputDirectory,
            allowOutsideRoot: flag(args, "allow-outside-root"),
          },
        );
        printStartedTesseraRun(job);
        return;
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
          catalogueDriftMode:
            requestedCatalogueDriftMode(
              args,
              Boolean(
                resumeManifestPath || restartManifest,
              ),
            ),
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
      const opponentContextFile = value(args, "opponent-context");
      if (opponentContextFile && !opponentFile) {
        throw new Error(
          "Tessera --opponent-context is valid only with --opponent-file.",
        );
      }
      const opponentFaction = value(args, "opponent-faction");
      if (opponentFaction) {
        throw Object.assign(
          new Error(
            "OPPONENT_SCOPE_REQUIRED: use tessera stress-test --against-faction for a known faction with an unknown list.",
          ),
          { code: "OPPONENT_SCOPE_REQUIRED" },
        );
      }
      const selected = [
        Boolean(opponentFile),
        Boolean(opponentRosterFile),
      ].filter(Boolean).length;
      if (selected === 0) {
        throw Object.assign(
          new Error(
            "OPPONENT_SCOPE_REQUIRED: provide --opponent-file or --opponent-roster, or use tessera stress-test when only the faction is known.",
          ),
          { code: "OPPONENT_SCOPE_REQUIRED" },
        );
      }
      if (selected > 1) {
        throw new Error(
          "Tessera analyze accepts exactly one of --opponent-file or --opponent-roster.",
        );
      }
      let opponent: Exclude<
        TesseraOpponentInput,
        { kind: "faction-archetypes" }
      >;
      if (opponentFile) {
        opponent = { kind: "rosz", path: path.resolve(opponentFile) };
      } else if (opponentRosterFile) {
        opponent = {
          kind: "roster",
          roster: await readRosterDraft(path.resolve(opponentRosterFile)),
        };
      } else {
        throw new Error("An exact opponent is required.");
      }
      const analysisMode = (
        value(args, "analysis-mode") ?? "full"
      ) as "quick" | "full";
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
      const fallbackMode = (
        value(args, "fallback") ?? "none"
      ) as "none" | "baseline-damage-v1";
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
      const opponentRosterContext = opponentContextFile
        ? await readRosterDraft(path.resolve(opponentContextFile))
        : undefined;
      const analysisOptions = {
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
        opponentRosterContext,
        catalogueDriftMode: flag(
          args,
          "verified-catalogue-drift-diagnostic",
        )
          ? ("diagnostic" as const)
          : ("reject" as const),
      };
      if (
        shouldStartDurableTesseraRun(
          executionMode,
          flag(args, "experimental"),
        )
      ) {
        const job = await startTesseraRun(
          {
            kind: "exact",
            playerRoster: roster,
            opponent,
            options: {
              ...analysisOptions,
              executionMode: "simulate",
              experimental: false,
            },
          },
          {
            outputDirectory,
            allowOutsideRoot: flag(args, "allow-outside-root"),
          },
        );
        printStartedTesseraRun(job);
        return;
      }
      const result = await analyzeRosterMatchup(
        roster,
        opponent,
        analysisOptions,
      );
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
  if (command === "workflow") {
    const prompt = value(args, "prompt") ?? positionals.join(" ");
    const requestedIntent = value(args, "intent");
    if (
      requestedIntent &&
      ![
        "build",
        "prepare-new-recruit",
        "deliver-new-recruit",
        "optimize",
      ].includes(requestedIntent)
    ) {
      throw new Error(
        "--intent requires build, prepare-new-recruit, deliver-new-recruit, or optimize.",
      );
    }
    const requestedArtifact = value(args, "artifact");
    if (
      requestedArtifact &&
      ![
        "none",
        "new-recruit-rosz",
        "tessera-profile-rich",
      ].includes(requestedArtifact)
    ) {
      throw new Error(
        "--artifact requires none, new-recruit-rosz, or tessera-profile-rich.",
      );
    }
    const requestedCoaching = value(args, "coaching");
    if (
      requestedCoaching &&
      !["none", "concise", "full"].includes(requestedCoaching)
    ) {
      throw new Error(
        "--coaching requires none, concise, or full.",
      );
    }
    const requestedOptimizerMode = value(args, "optimizer-mode");
    if (
      requestedOptimizerMode &&
      !["guided", "recommend-only"].includes(
        requestedOptimizerMode,
      )
    ) {
      throw new Error(
        "--optimizer-mode requires guided or recommend-only.",
      );
    }
    const preferences = list(
      args,
      "preferences",
    ) as PreferenceTag[];
    const collectionUnitIds = list(args, "collection");
    const requiredUnitIds = list(args, "required-unit");
    const excludedUnitIds = list(args, "exclude-unit");
    const opponentRosterPath = value(args, "opponent-roster");
    const opponentRoster = opponentRosterPath
      ? await readRosterDraft(path.resolve(opponentRosterPath))
      : undefined;
    const result = await prepareRosterWorkflow({
      prompt: prompt || undefined,
      intent:
        requestedIntent as RosterWorkflowIntent | undefined,
      artifactRequirement:
        requestedArtifact as
          | RosterArtifactRequirement
          | undefined,
      coachingMode:
        requestedCoaching as RosterCoachingMode | undefined,
      optimizerMode:
        requestedOptimizerMode as
          | RosterOptimizerMode
          | undefined,
      playerFaction:
        value(args, "player-faction") ?? value(args, "faction"),
      opponentFaction: value(args, "opponent-faction"),
      opponentContext: opponentRoster
        ? { kind: "known-roster", roster: opponentRoster }
        : undefined,
      pointsLimit: value(args, "points")
        ? Number(value(args, "points"))
        : undefined,
      name: value(args, "name"),
      preferences: preferences.length
        ? preferences
        : undefined,
      allowNamedCharacters: flag(args, "no-named")
        ? false
        : undefined,
      legendsPolicy: requestedLegendsPolicy(args),
      allowLegends: flag(args, "include-legends")
        ? true
        : undefined,
      playContext: requestedPlayContext(args),
      collectionUnitIds: collectionUnitIds.length
        ? collectionUnitIds
        : undefined,
      requiredUnitIds: requiredUnitIds.length
        ? requiredUnitIds
        : undefined,
      excludedUnitIds: excludedUnitIds.length
        ? excludedUnitIds
        : undefined,
      requiredWarlordUnitId: value(args, "required-warlord"),
      detachmentId: value(args, "detachment"),
      forceDispositionId: value(args, "disposition"),
    });
    const writtenRoster =
      result.data?.roster && value(args, "out")
        ? await writeRosterDraft(
            result.data.roster,
            value(args, "out")!,
            {
              overwrite: flag(args, "overwrite"),
              allowOutsideRoot: flag(
                args,
                "allow-outside-root",
              ),
            },
          )
        : null;
    const portfolioOutput = value(args, "portfolio-out");
    const generalPortfolio =
      result.data?.optimization?.target.kind ===
        "general-six-archetype"
        ? result.data.optimization.target.portfolio
        : null;
    if (result.ok && portfolioOutput && !generalPortfolio) {
      throw new Error(
        "--portfolio-out is available only for an optimize workflow with the general six-archetype target.",
      );
    }
    const writtenGeneralPortfolio =
      result.ok && portfolioOutput && generalPortfolio
        ? await writeExportArtifact(
            {
              format: "roster-json",
              filename: path.basename(portfolioOutput),
              mimeType: "application/json",
              encoding: "utf8",
              content:
                `${JSON.stringify(generalPortfolio, null, 2)}\n`,
            },
            portfolioOutput,
            {
              overwrite: flag(args, "overwrite"),
              allowOutsideRoot: flag(
                args,
                "allow-outside-root",
              ),
            },
          )
        : null;
    let writtenHandoff: string[] = [];
    let delivery: unknown = null;
    const workflowIntent = result.data?.intent?.intent;
    const handoff = result.data?.newRecruit.handoff;
    const tesseraBaselineJobs =
      result.ok &&
      result.data &&
      workflowIntent === "optimize"
        ? await startWorkflowTesseraBaselines(result.data, args)
        : [];
    if (
      result.ok &&
      handoff &&
      workflowIntent === "prepare-new-recruit"
    ) {
      writtenHandoff = await writeExportArtifacts(
        handoff.artifacts,
        value(args, "out-dir") ?? "exports/new-recruit",
        {
          overwrite: flag(args, "overwrite"),
          allowOutsideRoot: flag(args, "allow-outside-root"),
        },
      );
    }
    if (
      result.ok &&
      result.data?.newRecruit.delivery.authorized &&
      result.data.roster
    ) {
      const connection = await getNewRecruitConnectionStatus();
      if (connection.ok && connection.data?.available) {
        delivery = await deliverRosterToNewRecruit(
          result.data.roster,
          {
            downloadEnrichedRosz: true,
            downloadPrettyHtml: !flag(args, "no-pretty"),
            outputDirectory:
              value(args, "out-dir") ??
              "exports/new-recruit",
            overwrite: flag(args, "overwrite"),
            allowOutsideRoot: flag(
              args,
              "allow-outside-root",
            ),
          },
        );
      } else {
        delivery = {
          ok: false,
          data: null,
          violations:
            connection.violations.length > 0
              ? connection.violations
              : [
                  {
                    code: "NEW_RECRUIT_CONNECTION_UNAVAILABLE",
                    message:
                      "Direct delivery is unavailable; use the prepared .rosz handoff.",
                    severity: "error",
                  },
                ],
          warnings: connection.warnings,
        };
      }
    }
    const printableData = result.data
      ? flag(args, "full-json")
        ? {
            ...result.data,
            newRecruit: {
              ...result.data.newRecruit,
              handoff: handoff
                ? {
                    ...handoff,
                    artifacts: handoff.artifacts.map(
                      ({ content, ...artifact }) => {
                        void content;
                        return artifact;
                      },
                    ),
                  }
                : null,
            },
          }
        : compactRosterWorkflowData(result.data)
      : null;
    print({
      ...result,
      data: printableData,
      writtenRoster,
      writtenGeneralPortfolio,
      writtenHandoff,
      delivery,
      tesseraBaselineJobs,
    });
    if (
      !result.ok ||
      tesseraBaselineJobs.some((job) => !job.ok) ||
      (
        delivery &&
        typeof delivery === "object" &&
        "ok" in delivery &&
        delivery.ok === false
      )
    ) {
      process.exitCode = 2;
    }
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
      legendsPolicy: requestedLegendsPolicy(args),
      allowLegends: flag(args, "include-legends") ? true : undefined,
      playContext: requestedPlayContext(args),
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

  const fileCommands = new Set([
    "validate",
    "explain",
    "modify",
    "export",
    "rebase",
    "rebase-roster",
  ]);
  if (!fileCommands.has(command)) {
    throw new Error(`Unknown command "${command}". Run "rosterpilot --help".`);
  }
  const file = value(args, "file");
  if (!file) throw new Error(`The ${command} command requires --file.`);
  const draft = await readRosterDraft(path.resolve(file));
  if (command === "rebase" || command === "rebase-roster") {
    const result = await rebaseRosterWithProvider(draft);
    const output = value(args, "out");
    if (
      result.data &&
      result.data.status !== "review-required" &&
      output
    ) {
      const written = await writeRosterDraft(
        result.data.roster,
        output,
        {
          overwrite: flag(args, "overwrite"),
          allowOutsideRoot: flag(args, "allow-outside-root"),
        },
      );
      print({ ...result, written });
    } else {
      print(result);
    }
    if (!result.ok) process.exitCode = 2;
    return;
  }
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

async function runMainWithDataSnapshot(): Promise<void> {
  const rawCommand = process.argv[2] ?? "status";
  const providerOnlyCommands = new Set([
    "mcp",
    "data",
    "data-update-status",
    "refresh-data-now",
    "rollback-data-bundle",
  ]);
  if (
    process.argv.includes("--help") ||
    process.argv.includes("-h") ||
    providerOnlyCommands.has(rawCommand)
  ) {
    await main();
    return;
  }
  await withDataBundleSnapshotLease(main);
}

initializeLocalDataBundleProvider().then(runMainWithDataSnapshot).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
