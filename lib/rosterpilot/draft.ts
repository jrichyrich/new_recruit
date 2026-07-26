import type { z } from "zod";

import {
  getNewRecruitFactionSummary,
  newRecruitCatalogue,
} from "./catalogue-summary";
import {
  ROSTER_SCHEMA_VERSION,
  RosterDraftV1Schema,
  RosterDraftV2Schema,
  type LegacyRosterDraftV1,
  type RosterDraftV2,
} from "./types";

export type ParsedRosterDraft =
  | {
      success: true;
      data: RosterDraftV2;
      migrated: boolean;
    }
  | {
      success: false;
      error: z.ZodError;
    };

export function currentRosterSourceData(
  factionId: string,
  migratedFrom?: 1,
): RosterDraftV2["sourceData"] {
  const manifest = newRecruitCatalogue;
  const faction = getNewRecruitFactionSummary(factionId);
  return {
    package: manifest.sources.rules.package,
    version: manifest.sources.rules.version,
    edition: manifest.sources.rules.edition,
    dataslate: manifest.sources.rules.dataslate,
    releaseId: manifest.releaseId,
    newRecruit: {
      repository: manifest.sources.newRecruit.repository,
      commit: manifest.sources.newRecruit.commit,
      gameSystemRevision: manifest.gameSystem.revision,
      catalogueRevision: faction?.catalogue.revision ?? null,
    },
    official: {
      mfmVersion: manifest.sources.official.mfmVersion,
      updatedAt: manifest.sources.official.updatedAt,
      contentSha256: manifest.sources.official.contentSha256,
    },
    ...(migratedFrom ? { migratedFrom } : {}),
  };
}

export function migrateRosterDraftV1(
  draft: LegacyRosterDraftV1,
): RosterDraftV2 {
  return {
    ...draft,
    schemaVersion: ROSTER_SCHEMA_VERSION,
    sourceData: currentRosterSourceData(draft.factionId, 1),
  };
}

export function parseRosterDraft(value: unknown): ParsedRosterDraft {
  const current = RosterDraftV2Schema.safeParse(value);
  if (current.success) {
    return { success: true, data: current.data, migrated: false };
  }
  const legacy = RosterDraftV1Schema.safeParse(value);
  if (legacy.success) {
    return {
      success: true,
      data: migrateRosterDraftV1(legacy.data),
      migrated: true,
    };
  }
  return { success: false, error: current.error };
}
