import catalogueJson from "../../data/generated/new-recruit-catalogues.json";

import type {
  NewRecruitCatalogueManifest,
  NewRecruitFactionCatalogue,
} from "./catalogue-types";

export let newRecruitCatalogueMappings =
  catalogueJson as NewRecruitCatalogueManifest;

export function activateNewRecruitCatalogueMappings(
  manifest: NewRecruitCatalogueManifest,
): void {
  newRecruitCatalogueMappings = structuredClone(manifest);
}

export function getNewRecruitFactionCatalogue(
  factionId: string,
): NewRecruitFactionCatalogue | null {
  return newRecruitCatalogueMappings.factions[factionId] ?? null;
}
