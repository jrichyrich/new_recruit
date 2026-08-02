import {
  analyzeCompetitiveCoaching,
  type CompetitiveCoachingOptions,
  type CompetitiveCoachingReport,
} from "./competitive-coaching";
import {
  resolveExactFactionReference,
  resolveFactionIntent,
  type FactionIntentResolution,
} from "./faction-intent";
import {
  buildGeneralThreatPortfolio,
  type GeneralThreatPortfolio,
} from "./general-threat-portfolio";
import {
  buildRoster,
  explainRoster,
  searchUnits,
  validateRoster,
} from "./engine";
import { prepareNewRecruitHandoff } from "./handoff";
import {
  getNewRecruitCapability,
  type NewRecruitCapability,
} from "./catalogue-summary";
import { getNewRecruitFactionCatalogue } from "./catalogue";
import {
  buildExportableRosterCandidate,
  previewFactionStressPortfolio,
} from "./stress-portfolio";
import type {
  BuildRosterInput,
  NewRecruitHandoff,
  ResultEnvelope,
  RosterDraftV1,
  RosterIssue,
  TesseraStressPortfolioPreview,
} from "./types";
import {
  resolveRosterWorkflowIntent,
  type ResolvedRosterWorkflowIntent,
  type ResolveRosterWorkflowIntentInput,
  type RosterArtifactRequirement,
} from "./workflow-intent";

export type PrepareRosterWorkflowInput = BuildRosterInput &
  ResolveRosterWorkflowIntentInput & {
    /** Explicit opponent selector for prompt surfaces. */
    opponentFaction?: string;
    missionContext?: CompetitiveCoachingOptions["missionContext"];
    terrainContext?: CompetitiveCoachingOptions["terrainContext"];
  };

type RosterWorkflowValidation = Pick<
  ResultEnvelope<RosterDraftV1>,
  "ok" | "violations" | "warnings"
>;

type RosterWorkflowExplanation = NonNullable<
  ReturnType<typeof explainRoster>["data"]
>;

export type RosterWorkflowOptimizationTarget =
  | {
      kind: "exact-opponent";
      factionId: string;
      roster: RosterDraftV1;
    }
  | {
      kind: "known-faction";
      factionId: string;
      portfolioPreview: TesseraStressPortfolioPreview;
    }
  | {
      kind: "general-six-archetype";
      portfolio: GeneralThreatPortfolio;
    };

export type RosterWorkflowResult = {
  schemaVersion: 1;
  workflowKind: "roster-workflow";
  status:
    | "complete"
    | "needs-input"
    | "failed"
    | "ready-for-tessera-baseline";
  intent: ResolvedRosterWorkflowIntent | null;
  faction: FactionIntentResolution | null;
  roster: RosterDraftV1 | null;
  validation: RosterWorkflowValidation | null;
  explanation: RosterWorkflowExplanation | null;
  coaching: CompetitiveCoachingReport | null;
  newRecruit: {
    capability: NewRecruitCapability | null;
    handoff: NewRecruitHandoff | null;
    delivery: {
      authorized: boolean;
      status:
        | "not-requested"
        | "prepared"
        | "authorized-pending-transport";
    };
  };
  optimization: {
    mode: "guided" | "recommend-only";
    status: "baseline-pending";
    preparation: {
      sourceRosz: "prepared";
      profileRichRosz: "pending-new-recruit-enrichment";
      pairedBaseline: "pending-tessera";
    };
    target: RosterWorkflowOptimizationTarget;
    pairedTestRequired: boolean;
    deliveryAfterWinnerApproval:
      | "none"
      | "deliver-new-recruit";
  } | null;
};

function issue(
  code: string,
  message: string,
  severity: RosterIssue["severity"] = "error",
): RosterIssue {
  return { code, message, severity };
}

function uniqueIssues(issues: RosterIssue[]): RosterIssue[] {
  const seen = new Set<string>();
  return issues.filter((candidate) => {
    const key = [
      candidate.code,
      candidate.message,
      candidate.selectionId ?? "",
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyResult(
  overrides: Partial<RosterWorkflowResult> = {},
): RosterWorkflowResult {
  return {
    schemaVersion: 1,
    workflowKind: "roster-workflow",
    status: "failed",
    intent: null,
    faction: null,
    roster: null,
    validation: null,
    explanation: null,
    coaching: null,
    newRecruit: {
      capability: null,
      handoff: null,
      delivery: {
        authorized: false,
        status: "not-requested",
      },
    },
    optimization: null,
    ...overrides,
  };
}

function requiredUnitLabels(
  factionId: string,
  unitIds: string[],
): string[] {
  const summaries = searchUnits({
    faction: factionId,
    includeLegends: true,
    limit: 100,
  }).data ?? [];
  const names = new Map(
    summaries.map((unit) => [unit.id, unit.name]),
  );
  return unitIds.map((unitId) => names.get(unitId) ?? unitId);
}

function exportFailure(
  factionId: string,
  input: BuildRosterInput,
): RosterIssue {
  const catalogue = getNewRecruitFactionCatalogue(factionId);
  const unmappedRequired = (input.requiredUnitIds ?? []).filter(
    (unitId) => !catalogue?.units[unitId],
  );
  if (unmappedRequired.length > 0) {
    return issue(
      "REQUIRED_SELECTION_UNMAPPED",
      `The required selection${
        unmappedRequired.length === 1 ? "" : "s"
      } ${requiredUnitLabels(factionId, unmappedRequired).join(", ")} cannot be represented by the active New Recruit catalogue mapping.`,
    );
  }
  return issue(
    "EXPORTABLE_ROSTER_UNAVAILABLE",
    "RosterPilot could not build a legal, conflict-free roster whose selected detachment, units, model counts, and loadouts all export through the active New Recruit catalogue mapping.",
  );
}

function opponentFromInput(
  input: PrepareRosterWorkflowInput,
  faction: FactionIntentResolution,
): ResultEnvelope<BuildRosterInput["opponentContext"]> {
  if (input.opponentContext?.kind === "known-roster") {
    const exactRoster = input.opponentContext.roster;
    const structured = input.opponentFaction
      ? resolveExactFactionReference(input.opponentFaction)
      : null;
    if (input.opponentFaction && !structured) {
      return {
        ok: false,
        data: null,
        violations: [
          issue(
            "OPPONENT_FACTION_UNSUPPORTED",
            `No supported opponent faction exactly matches "${input.opponentFaction}".`,
          ),
        ],
        warnings: [],
      };
    }
    const identifiedFactionIds = [
      ...new Set([
        exactRoster.factionId,
        ...(structured ? [structured.factionId] : []),
        ...faction.opponentFactionIds,
      ]),
    ];
    if (identifiedFactionIds.length > 1) {
      return {
        ok: false,
        data: null,
        violations: [
          issue(
            "OPPONENT_FACTION_CONFLICT",
            `The exact opponent roster is ${exactRoster.factionName}, but the request also identifies ${identifiedFactionIds.filter((factionId) => factionId !== exactRoster.factionId).join(", ")}.`,
          ),
        ],
        warnings: [],
      };
    }
    return {
      ok: true,
      data: input.opponentContext,
      violations: [],
      warnings: [],
    };
  }
  const structuredQuery =
    input.opponentFaction ??
    (
      input.opponentContext?.kind === "known-faction"
        ? input.opponentContext.factionId
        : undefined
    );
  const structured = structuredQuery
    ? resolveExactFactionReference(structuredQuery)
    : null;
  if (structuredQuery && !structured) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "OPPONENT_FACTION_UNSUPPORTED",
          `No supported opponent faction exactly matches "${structuredQuery}".`,
        ),
      ],
      warnings: [],
    };
  }
  const promptOpponentIds = faction.opponentFactionIds;
  const opponentIds = [
    ...new Set([
      ...(structured ? [structured.factionId] : []),
      ...promptOpponentIds,
    ]),
  ];
  if (opponentIds.length > 1) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "OPPONENT_FACTION_CONFLICT",
          `The request identifies multiple opponent factions (${opponentIds.join(", ")}). Supply one opponentFaction or an exact opponent roster.`,
        ),
      ],
      warnings: [],
    };
  }
  return {
    ok: true,
    data:
      opponentIds.length === 1
        ? { kind: "known-faction", factionId: opponentIds[0] }
        : undefined,
    violations: [],
    warnings: [],
  };
}

function buildInputForWorkflow(
  input: PrepareRosterWorkflowInput,
  factionId: string,
  opponentContext: BuildRosterInput["opponentContext"],
): BuildRosterInput {
  return {
    prompt: input.prompt,
    playerFaction: factionId,
    pointsLimit: input.pointsLimit,
    name: input.name,
    preferences: input.preferences,
    allowNamedCharacters: input.allowNamedCharacters,
    legendsPolicy: input.legendsPolicy,
    allowLegends: input.allowLegends,
    playContext: input.playContext,
    collectionUnitIds: input.collectionUnitIds,
    collectionProfile:
      input.collectionProfile ?? { mode: "open-catalog" },
    requiredUnitIds: input.requiredUnitIds,
    excludedUnitIds: input.excludedUnitIds,
    requiredWarlordUnitId: input.requiredWarlordUnitId,
    detachmentId: input.detachmentId,
    forceDispositionId: input.forceDispositionId,
    opponentContext,
    mixedThreatIntent: input.mixedThreatIntent,
    internalSelectionExclusions:
      input.internalSelectionExclusions,
  };
}

function buildForArtifact(
  requirement: RosterArtifactRequirement,
  input: BuildRosterInput,
): ResultEnvelope<RosterDraftV1> {
  const canonical = buildRoster(input);
  if (requirement === "none") {
    return canonical;
  }
  if (!canonical.ok || !canonical.data) {
    const artifactIssue = exportFailure(
      input.playerFaction ?? "",
      input,
    );
    return artifactIssue.code === "REQUIRED_SELECTION_UNMAPPED"
      ? {
          ...canonical,
          violations: [artifactIssue],
        }
      : canonical;
  }
  const roster = buildExportableRosterCandidate(input);
  if (!roster) {
    return {
      ok: false,
      data: canonical.data,
      violations: [
        exportFailure(input.playerFaction ?? "", input),
      ],
      warnings: canonical.warnings,
    };
  }
  if (roster.totalPoints / Math.max(1, roster.pointsLimit) < 0.98) {
    return {
      ok: false,
      data: null,
      violations: [
        issue(
          "ROSTER_POINTS_UTILIZATION_TOO_LOW",
          `Artifact-backed workflows require at least 98% points utilization; this candidate uses ${roster.totalPoints} of ${roster.pointsLimit} points.`,
        ),
      ],
      warnings: [],
    };
  }
  return {
    ok: true,
    data: roster,
    violations: [],
    warnings: [],
  };
}

async function optimizationTarget(
  roster: RosterDraftV1,
  opponentContext: BuildRosterInput["opponentContext"],
): Promise<ResultEnvelope<RosterWorkflowOptimizationTarget>> {
  if (opponentContext?.kind === "known-roster") {
    return {
      ok: true,
      data: {
        kind: "exact-opponent",
        factionId: opponentContext.roster.factionId,
        roster: opponentContext.roster,
      },
      violations: [],
      warnings: [],
    };
  }
  if (opponentContext?.kind === "known-faction") {
    const preview = await previewFactionStressPortfolio({
      faction: opponentContext.factionId,
      pointsLimit: roster.pointsLimit,
      suite: "diverse-9",
      pointsTolerancePercent: 5,
      allowLegends: roster.constraints.allowLegends,
    });
    if (!preview.ok || !preview.data) {
      return {
        ok: false,
        data: null,
        violations: preview.violations,
        warnings: preview.warnings,
      };
    }
    return {
      ok: true,
      data: {
        kind: "known-faction",
        factionId: opponentContext.factionId,
        portfolioPreview: preview.data,
      },
      violations: [],
      warnings: preview.warnings,
    };
  }
  const portfolio = buildGeneralThreatPortfolio({
    pointsLimit: roster.pointsLimit,
  });
  if (!portfolio.ok || !portfolio.data) {
    return {
      ok: false,
      data: null,
      violations: portfolio.violations,
      warnings: portfolio.warnings,
    };
  }
  return {
    ok: true,
    data: {
      kind: "general-six-archetype",
      portfolio: portfolio.data,
    },
    violations: [],
    warnings: portfolio.warnings,
  };
}

/**
 * Pure orchestration boundary for natural-language roster work. The caller
 * receives an exportable handoff and explicit side-effect authorization, but
 * only a transport adapter may probe or mutate New Recruit/Tessera.
 */
export async function prepareRosterWorkflow(
  input: PrepareRosterWorkflowInput,
): Promise<ResultEnvelope<RosterWorkflowResult>> {
  const intentResult = resolveRosterWorkflowIntent(input);
  if (!intentResult.ok || !intentResult.data) {
    return {
      ok: false,
      data: emptyResult(),
      violations: intentResult.violations,
      warnings: intentResult.warnings,
    };
  }
  const intent = intentResult.data;
  const faction = resolveFactionIntent({
    prompt: input.prompt,
    playerFaction: input.playerFaction,
    faction: input.faction,
    opponentFaction: input.opponentFaction,
  });
  if (faction.status !== "resolved") {
    return {
      ok: false,
      data: emptyResult({
        status: "needs-input",
        intent,
        faction,
      }),
      violations: [
        issue(faction.code, faction.message),
      ],
      warnings: [],
    };
  }
  const opponent = opponentFromInput(input, faction);
  if (!opponent.ok) {
    return {
      ok: false,
      data: emptyResult({
        status: "needs-input",
        intent,
        faction,
      }),
      violations: opponent.violations,
      warnings: opponent.warnings,
    };
  }
  const buildInput = buildInputForWorkflow(
    input,
    faction.factionId,
    opponent.data ?? undefined,
  );
  const built = buildForArtifact(
    intent.artifactRequirement,
    buildInput,
  );
  if (!built.data) {
    return {
      ok: false,
      data: emptyResult({ intent, faction }),
      violations: built.violations,
      warnings: built.warnings,
    };
  }
  if (!built.ok) {
    const fallbackRoster = built.data;
    const fallbackValidation = validateRoster(fallbackRoster);
    const fallbackExplanation = explainRoster(fallbackRoster);
    const fallbackCoaching =
      intent.coachingMode === "none"
        ? null
        : analyzeCompetitiveCoaching(fallbackRoster, {
            mode: intent.coachingMode,
            missionContext: input.missionContext,
            terrainContext: input.terrainContext,
          });
    return {
      ok: false,
      data: emptyResult({
        status: "failed",
        intent,
        faction,
        roster: fallbackRoster,
        validation: {
          ok: fallbackValidation.ok,
          violations: fallbackValidation.violations,
          warnings: fallbackValidation.warnings,
        },
        explanation: fallbackExplanation.data ?? null,
        coaching: fallbackCoaching?.data ?? null,
        newRecruit: {
          capability: getNewRecruitCapability(
            fallbackRoster.factionId,
          ),
          handoff: null,
          delivery: {
            authorized: false,
            status: "not-requested",
          },
        },
      }),
      violations: built.violations,
      warnings: uniqueIssues([
        ...built.warnings,
        ...fallbackValidation.warnings,
        ...fallbackExplanation.warnings,
        ...(fallbackCoaching?.warnings ?? []),
        issue(
          "CANONICAL_ROSTER_FALLBACK_AVAILABLE",
          "A legal canonical roster is included for JSON/text review, but no New Recruit or Tessera artifact was prepared.",
          "warn",
        ),
      ]),
    };
  }
  const roster = built.data;
  const validation = validateRoster(roster);
  const validationSummary: RosterWorkflowValidation = {
    ok: validation.ok,
    violations: validation.violations,
    warnings: validation.warnings,
  };
  if (!validation.ok) {
    return {
      ok: false,
      data: emptyResult({
        intent,
        faction,
        roster,
        validation: validationSummary,
      }),
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }
  const explained = explainRoster(roster);
  if (!explained.ok || !explained.data) {
    return {
      ok: false,
      data: emptyResult({
        intent,
        faction,
        roster,
        validation: validationSummary,
      }),
      violations: explained.violations,
      warnings: explained.warnings,
    };
  }
  const coaching =
    intent.coachingMode === "none"
      ? null
      : analyzeCompetitiveCoaching(roster, {
          mode: intent.coachingMode,
          missionContext: input.missionContext,
          terrainContext: input.terrainContext,
        });
  if (coaching && (!coaching.ok || !coaching.data)) {
    return {
      ok: false,
      data: emptyResult({
        intent,
        faction,
        roster,
        validation: validationSummary,
        explanation: explained.data,
      }),
      violations: coaching.violations,
      warnings: coaching.warnings,
    };
  }
  const capability = getNewRecruitCapability(roster.factionId);
  const needsHandoff = intent.artifactRequirement !== "none";
  const handoff = needsHandoff
    ? await prepareNewRecruitHandoff(roster, true)
    : null;
  if (handoff && (!handoff.ok || !handoff.data)) {
    return {
      ok: false,
      data: emptyResult({
        intent,
        faction,
        roster,
        validation: validationSummary,
        explanation: explained.data,
        coaching: coaching?.data ?? null,
        newRecruit: {
          capability,
          handoff: null,
          delivery: {
            authorized: intent.deliveryAuthorized,
            status: intent.deliveryAuthorized
              ? "authorized-pending-transport"
              : "not-requested",
          },
        },
      }),
      violations: handoff.violations,
      warnings: handoff.warnings,
    };
  }
  const target =
    intent.intent === "optimize"
      ? await optimizationTarget(
          roster,
          opponent.data ?? undefined,
        )
      : null;
  if (target && (!target.ok || !target.data)) {
    return {
      ok: false,
      data: emptyResult({
        status: "needs-input",
        intent,
        faction,
        roster,
        validation: validationSummary,
        explanation: explained.data,
        coaching: coaching?.data ?? null,
        newRecruit: {
          capability,
          handoff: handoff?.data ?? null,
          delivery: {
            authorized: false,
            status: handoff?.data ? "prepared" : "not-requested",
          },
        },
      }),
      violations: target.violations,
      warnings: target.warnings,
    };
  }
  const optimization =
    target?.data && intent.optimizerMode
      ? {
          mode: intent.optimizerMode,
          status: "baseline-pending" as const,
          preparation: {
            sourceRosz: "prepared" as const,
            profileRichRosz:
              "pending-new-recruit-enrichment" as const,
            pairedBaseline: "pending-tessera" as const,
          },
          target: target.data,
          pairedTestRequired:
            intent.optimizerMode === "guided",
          deliveryAfterWinnerApproval:
            intent.postOptimizationDeliveryRequested
              ? ("deliver-new-recruit" as const)
              : ("none" as const),
        }
      : null;
  const warnings = uniqueIssues([
    ...built.warnings,
    ...validation.warnings,
    ...explained.warnings,
    ...(coaching?.warnings ?? []),
    ...(handoff?.warnings ?? []),
    ...(target?.warnings ?? []),
    ...(intent.intent === "optimize" &&
    intent.optimizerMode === "recommend-only"
      ? [
          issue(
            "OPTIMIZER_RECOMMENDATIONS_UNPAIRED",
            "Recommend-only findings are not paired-tested and cannot authorize automatic roster changes.",
            "warn",
          ),
        ]
      : []),
  ]);
  return {
    ok: true,
    data: emptyResult({
      status: optimization
        ? "ready-for-tessera-baseline"
        : "complete",
      intent,
      faction,
      roster,
      validation: validationSummary,
      explanation: explained.data,
      coaching: coaching?.data ?? null,
      newRecruit: {
        capability,
        handoff: handoff?.data ?? null,
        delivery: {
          authorized: intent.deliveryAuthorized,
          status: intent.deliveryAuthorized
            ? "authorized-pending-transport"
            : handoff?.data
              ? "prepared"
              : "not-requested",
        },
      },
      optimization,
    }),
    violations: [],
    warnings,
  };
}
