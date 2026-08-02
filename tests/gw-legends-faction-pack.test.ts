import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractGwLegendsFactionPackText,
} from "../scripts/extract-gw-legends-faction-pack";

const firstPage = `
                       AELDARI
              FACTION PACK: VERSION 1.0
          Legal for matched play from 20th June 2026

CONTENTS
Imperial Armour ........................................ 22
Legends Datasheets ..................................... 29
`;

test("extracts only pages explicitly marked Warhammer Legends", () => {
  const result = extractGwLegendsFactionPackText({
    text: [
      firstPage,
      "WRAITHSEER                         IMPERIAL ARMOUR\n",
      "ILLIC NIGHTSPEAR             WA R HA M M E R  L E G E N D S\nM   T   SV   W   LD   OC\n",
      "ILLIC NIGHTSPEAR             WA R HA M M E R  L E G E N D S\n",
      "AUTARCH SKYRUNNER            W A R H A M M E R   L E G E N D S\nM   T   SV   W   LD   OC\n",
      "AUTARCH SKYRUNNER            W A R H A M M E R   L E G E N D S\n",
    ].join("\f"),
    factionId: "aeldari",
    gameEdition: "11th",
    sourceUrl: "https://assets.warhammer-community.com/aeldari.pdf",
    sourceBytes: new TextEncoder().encode("fixture-pdf"),
    extractedAt: "2026-08-01T12:00:00.000Z",
  });

  assert.equal(result.factionName, "AELDARI");
  assert.equal(result.documentKind, "faction-pack");
  assert.equal(result.gameEdition, "11th");
  assert.equal(result.packVersion, "1.0");
  assert.equal(result.legalFrom, "2026-06-20");
  assert.deepEqual(result.legendUnits, [
    { name: "AUTARCH SKYRUNNER", pdfPages: [5] },
    { name: "ILLIC NIGHTSPEAR", pdfPages: [3] },
  ]);
  assert.equal(
    result.legendUnits.some((unit) => unit.name === "WRAITHSEER"),
    false,
  );
  assert.match(result.source.contentSha256, /^[a-f0-9]{64}$/);
});

test("fails closed when a declared Legends section cannot be extracted", () => {
  assert.throws(
    () =>
      extractGwLegendsFactionPackText({
        text: `${firstPage}\fNO MARKED DATASHEET\n`,
        factionId: "aeldari",
        gameEdition: "11th",
        sourceUrl: "https://assets.warhammer-community.com/aeldari.pdf",
        sourceBytes: new Uint8Array(),
        extractedAt: "2026-08-01T12:00:00.000Z",
      }),
    /contents declare Legends Datasheets/,
  );
});

test("requires explicit review before accepting an empty faction pack", () => {
  const custodesPage = `
                    ADEPTUS CUSTODES
                 FACTION PACK: VERSION 1.0
             Legal for matched play from 20th June 2026

CONTENTS
Imperial Armour ........................................ 12
`;
  const input = {
    text: `${custodesPage}\fIMPERIAL ARMOUR\n`,
    factionId: "adeptus-custodes",
    gameEdition: "11th",
    sourceUrl: "https://assets.warhammer-community.com/custodes.pdf",
    sourceBytes: new Uint8Array(),
    extractedAt: "2026-08-01T12:00:00.000Z",
  };
  assert.throws(
    () => extractGwLegendsFactionPackText(input),
    /Pass --allow-empty/,
  );
  assert.deepEqual(
    extractGwLegendsFactionPackText({ ...input, allowEmpty: true })
      .legendUnits,
    [],
  );
});

test("rejects standalone Legends documents and non-official source URLs", () => {
  const standalone = `
                 WARHAMMER LEGENDS
              LEGENDS FIELD MANUAL
                   VERSION 1.9
`;
  const base = {
    text: `${standalone}\fWEBWAY GATE WARHAMMER LEGENDS\nM T SV W LD OC\n`,
    factionId: "aeldari",
    gameEdition: "10th",
    sourceUrl:
      "https://assets.warhammer-community.com/old-legends.pdf",
    sourceBytes: new Uint8Array(),
    extractedAt: "2026-08-01T12:00:00.000Z",
  };
  assert.throws(
    () => extractGwLegendsFactionPackText(base),
    /Faction Pack version/,
  );
  assert.throws(
    () =>
      extractGwLegendsFactionPackText({
        ...base,
        text: [
          firstPage,
          "WEBWAY GATE WARHAMMER LEGENDS\nM T SV W LD OC\n",
        ].join("\f"),
        gameEdition: "11th",
        sourceUrl: "https://example.com/aeldari.pdf",
      }),
    /official Warhammer Community HTTPS asset URL/,
  );
});
