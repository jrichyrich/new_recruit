import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseGwFactionPackDiscovery,
} from "../scripts/discover-gw-faction-packs";

function hit(overrides: Record<string, unknown> = {}) {
  return {
    title: "Faction Pack: Aeldari",
    download_languages: "english",
    locale: "en-gb",
    id: {
      title: "Faction Pack: Aeldari",
      slug: "faction-pack-aeldari",
      last_updated: "22/07/2026",
      file: "eng_22-07_warhammer_40,000_faction_pack_aeldari.pdf",
      download_categories: [{
        title: "Faction Packs",
        slug: "faction-packs",
      }],
    },
    download_categories: ["faction-packs"],
    game_systems: "warhammer-40000",
    objectID: "entry::aeldari::english",
    ...overrides,
  };
}

test("discovers only current English Warhammer 40,000 faction packs", () => {
  const result = parseGwFactionPackDiscovery({
    hits: [
      hit(),
      {
        title: "Event Companion",
        download_categories: ["event-companions"],
      },
    ],
    totalHits: 2,
    totalPages: 1,
  }, "2026-08-01T12:00:00.000Z");

  assert.equal(result.factionPacks.length, 1);
  assert.deepEqual(result.factionPacks[0], {
    title: "Faction Pack: Aeldari",
    slug: "faction-pack-aeldari",
    objectId: "entry::aeldari::english",
    lastUpdated: "22/07/2026",
    assetUrl:
      "https://assets.warhammer-community.com/eng_22-07_warhammer_40,000_faction_pack_aeldari.pdf",
  });
  assert.equal(
    result.source.apiUrl,
    "https://www.warhammer-community.com/api/search/downloads/",
  );
  assert.match(result.source.response.contentSha256, /^[a-f0-9]{64}$/);
  assert.match(result.source.inventorySha256, /^[a-f0-9]{64}$/);
});

test("fails closed on partial or paginated discovery responses", () => {
  assert.throws(
    () => parseGwFactionPackDiscovery({
      hits: [hit()],
      totalHits: 2,
      totalPages: 2,
    }, "2026-08-01T12:00:00.000Z"),
    /incomplete or paginated/,
  );
});

test("rejects duplicate packs and non-filename asset references", () => {
  assert.throws(
    () => parseGwFactionPackDiscovery({
      hits: [hit(), hit({ objectID: "entry::duplicate::english" })],
      totalHits: 2,
      totalPages: 1,
    }, "2026-08-01T12:00:00.000Z"),
    /duplicate faction pack/,
  );

  assert.throws(
    () => parseGwFactionPackDiscovery({
      hits: [hit({
        id: {
          ...hit().id as Record<string, unknown>,
          file: "https://example.com/aeldari.pdf",
        },
      })],
      totalHits: 1,
      totalPages: 1,
    }, "2026-08-01T12:00:00.000Z"),
    /PDF filename, not a path/,
  );
});

test("retains and warns about a duplicated source slug", () => {
  const result = parseGwFactionPackDiscovery({
    hits: [
      hit(),
      hit({
        title: "Faction Pack: Drukhari",
        objectID: "entry::drukhari::english",
        id: {
          ...hit().id as Record<string, unknown>,
          title: "Faction Pack: Drukhari",
          file: "eng_22-07_warhammer_40,000_faction_pack_drukhari.pdf",
        },
      }),
    ],
    totalHits: 2,
    totalPages: 1,
  }, "2026-08-01T12:00:00.000Z");

  assert.equal(result.factionPacks.length, 2);
  assert.deepEqual(result.warnings, [{
    code: "DUPLICATE_SOURCE_SLUG",
    slug: "faction-pack-aeldari",
    titles: ["Faction Pack: Aeldari", "Faction Pack: Drukhari"],
  }]);
});
