import catalogueJson from "../../data/generated/new-recruit-catalogues.json";

import type {
  NewRecruitCatalogueManifest,
  NewRecruitFactionCatalogue,
} from "./catalogue-types";

export const newRecruitCatalogueMappings =
  catalogueJson as NewRecruitCatalogueManifest;

export function getNewRecruitFactionCatalogue(
  factionId: string,
): NewRecruitFactionCatalogue | null {
  return newRecruitCatalogueMappings.factions[factionId] ?? null;
}
