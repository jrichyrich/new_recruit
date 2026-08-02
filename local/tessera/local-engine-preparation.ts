import crypto from "node:crypto";

import {
  validateRoster,
  type EnrichedRoszSummary,
  type ProfilePolicyV1,
  type ResultEnvelope,
  type RosterDraftV1,
  type RosterIssue,
  type TesseraPreparedRoster,
} from "../../lib/rosterpilot";
import {
  writeExportArtifacts,
  type WriteOptions,
} from "../../lib/rosterpilot/io";
import {
  compileRosterForLocalTesseraEngine,
  localInputSha256,
  serializeLocalTesseraEngineInput,
} from "./local-engine-input";

export type LocalEnginePreparationOptions = WriteOptions & {
  outputDirectory?: string;
};

function sha256(content: Uint8Array): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function failure(
  error: unknown,
  warnings: RosterIssue[],
  fallbackCode = "TESSERA_LOCAL_INPUT_COMPILATION_FAILED",
): ResultEnvelope<TesseraPreparedRoster> {
  const coded = error as { code?: unknown };
  return {
    ok: false,
    data: null,
    violations: [
      {
        code:
          typeof coded?.code === "string"
            ? coded.code
            : fallbackCode,
        message:
          error instanceof Error
            ? error.message
            : "The frozen roster could not be compiled for the local Tessera engine.",
        severity: "error",
      },
    ],
    warnings,
  };
}

export async function prepareRosterForLocalTesseraEngine(
  roster: RosterDraftV1,
  policy: ProfilePolicyV1 | null,
  options: LocalEnginePreparationOptions = {},
): Promise<ResultEnvelope<TesseraPreparedRoster>> {
  const validation = validateRoster(roster);
  if (!validation.ok) {
    return {
      ok: false,
      data: null,
      violations: validation.violations,
      warnings: validation.warnings,
    };
  }

  try {
    const localInput = compileRosterForLocalTesseraEngine(
      roster,
      policy,
    );
    const sourceContent = Buffer.from(
      `${JSON.stringify(roster, null, 2)}\n`,
      "utf8",
    );
    const inputContent = serializeLocalTesseraEngineInput(localInput);
    const sourceSha256 = sha256(sourceContent);
    const inputSha256 = localInputSha256(inputContent);
    const outputDirectory =
      options.outputDirectory ?? "exports/tessera/local-inputs";
    let written: string[];
    try {
      written = await writeExportArtifacts(
        [
          {
            format: "roster-json",
            filename: `source-${sourceSha256}.json`,
            mimeType: "application/json",
            encoding: "utf8",
            content: sourceContent,
          },
          {
            format: "roster-json",
            filename: `local-input-${inputSha256}.json`,
            mimeType:
              "application/vnd.rosterpilot.tessera-local-input+json",
            encoding: "utf8",
            content: inputContent,
          },
        ],
        outputDirectory,
        {
          ...options,
          // Local compilation is deterministic and has no external side effect.
          // Replacing the same content-addressed path makes crash recovery safe.
          overwrite: true,
        },
      );
    } catch (error) {
      return failure(
        error,
        validation.warnings,
        "TESSERA_LOCAL_ARTIFACT_WRITE_FAILED",
      );
    }
    const summary: EnrichedRoszSummary = {
      rosterName: roster.name,
      factionName: roster.factionName,
      totalPoints: roster.totalPoints,
      generatedBy: "RosterPilot local data-bundle compiler",
      profileCount: localInput.units.reduce(
        (count, unit) => count + 1 + (unit.profiles?.length ?? 0),
        0,
      ),
      weaponProfileCount: localInput.units.reduce(
        (count, unit) => count + unit.weapons.length,
        0,
      ),
      units: roster.units.map((unit) => ({
        selectionId: unit.selectionId,
        name: unit.name,
        modelCount: unit.modelCount,
        ordinal: unit.ordinal,
        points: unit.points,
      })),
    };
    const omittedAbilityCount =
      localInput.limitations.omittedDatasheetAbilities.reduce(
        (count, item) => count + item.abilityNames.length,
        0,
      );
    const warnings: RosterIssue[] = [
      ...validation.warnings,
      {
        code: "TESSERA_LOCAL_BASE_PROFILE_EVALUATION",
        message:
          `Compiled ${roster.name} directly from frozen bundle ${localInput.bundleId}. This evaluation models unit and weapon profiles plus supported intrinsic weapon keywords; army, detachment, datasheet, enhancement, non-weapon wargear, stratagem, and attachment effects are not applied.`,
        severity: "warn",
      },
      ...(omittedAbilityCount > 0
        ? [
            {
              code: "TESSERA_LOCAL_ABILITIES_OMITTED",
              message:
                `${omittedAbilityCount} selected datasheet ability reference${omittedAbilityCount === 1 ? " was" : "s were"} recorded but not applied by base-profile evaluation.`,
              severity: "warn" as const,
            },
          ]
        : []),
      ...(localInput.limitations.omittedEnhancements.length > 0
        ? [
            {
              code: "TESSERA_LOCAL_ENHANCEMENTS_OMITTED",
              message:
                `${localInput.limitations.omittedEnhancements.length} selected enhancement${localInput.limitations.omittedEnhancements.length === 1 ? " was" : "s were"} recorded but not applied by base-profile evaluation.`,
              severity: "warn" as const,
            },
          ]
        : []),
      ...(localInput.limitations.omittedWargear.length > 0
        ? [
            {
              code: "TESSERA_LOCAL_WARGEAR_EFFECTS_OMITTED",
              message:
                `${localInput.limitations.omittedWargear.length} selected non-weapon wargear effect${localInput.limitations.omittedWargear.length === 1 ? " was" : "s were"} recorded but not applied by base-profile evaluation.`,
              severity: "warn" as const,
            },
          ]
        : []),
      ...(localInput.limitations.unsupportedWeaponKeywords.length > 0
        ? [
            {
              code: "TESSERA_LOCAL_WEAPON_KEYWORDS_OMITTED",
              message:
                `${localInput.limitations.unsupportedWeaponKeywords.length} intrinsic weapon keyword${localInput.limitations.unsupportedWeaponKeywords.length === 1 ? " was" : "s were"} recorded but not applied because the pinned adapter does not support it.`,
              severity: "warn" as const,
            },
          ]
        : []),
      ...(localInput.limitations.frozenChoices.length > 0
        ? [
            {
              code: "TESSERA_LOCAL_CHOICES_FROZEN",
              message:
                `${localInput.limitations.frozenChoices.length} alternate-profile, firing-set, melee, or mixed-defence choice${localInput.limitations.frozenChoices.length === 1 ? " was" : "s were"} frozen in the hashed local input.`,
              severity: "warn" as const,
            },
          ]
        : []),
    ];
    return {
      ok: true,
      data: {
        rosterId: roster.id,
        rosterName: roster.name,
        factionId: roster.factionId,
        listUrl: null,
        // These legacy path fields remain for persisted-report compatibility.
        // Their .json filenames and simulationInput discriminator make the
        // local artifacts unambiguous; neither is a ROSZ archive.
        sourceRoszPath: written[0],
        enrichedRoszPath: written[1],
        sourceRoszSha256: sourceSha256,
        enrichedRoszSha256: inputSha256,
        simulationInput: {
          kind: "rosterpilot-local-engine-input",
          path: written[1],
          sha256: inputSha256,
          bundleId: localInput.bundleId,
          compilerVersion: localInput.compilerVersion,
        },
        summary,
        fingerprint: localInput.rosterFingerprint,
        cacheReused: false,
        connectorEvents: [],
        constraints: structuredClone(roster.constraints),
      },
      violations: [],
      warnings,
    };
  } catch (error) {
    return failure(error, validation.warnings);
  }
}
