import { getActiveDataBundleManifest } from "./active-data-context";

export const TESSERA_STRESS_GENERATOR_VERSION = "faction-stress-v6";

export function stablePortfolioFingerprint(value: string): string {
  const seeds = [
    0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35,
    0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5,
  ];
  return seeds
    .map((seed, seedIndex) => {
      let hash = seed;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index) + seedIndex;
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

/**
 * Binds a faction stress portfolio to the active signed semantic capability,
 * or to the deterministic compiled methodology when no signed bundle exists.
 */
export function portfolioCapabilityHash(factionId: string): string {
  const activeHash =
    getActiveDataBundleManifest()?.semanticHashes.factions[
      factionId
    ]?.portfolioHash;
  if (activeHash) return activeHash;
  return stablePortfolioFingerprint(JSON.stringify({
    schemaVersion: 1,
    factionId,
    methodology: "adaptive-threat-lenses-v1",
    generatorVersion: TESSERA_STRESS_GENERATOR_VERSION,
  }));
}
