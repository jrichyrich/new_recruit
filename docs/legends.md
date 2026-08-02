# Legends classification and roster policy

RosterPilot treats two questions separately:

1. **Is this datasheet a current Legends option?** Games Workshop's current
   faction-pack publication is the classification authority.
2. **Can RosterPilot build and validate it?** The active structured-rules
   bundle must also contain a complete unit, points, loadout, and rules profile.

A Games Workshop entry without matching structured rules remains searchable as
`inventory-only`. It is never converted into a playable unit from BSData or
from a PDF title alone.

## Updating the inventory

Use the Warhammer Community [Warhammer 40,000 downloads
page](https://www.warhammer-community.com/en-gb/downloads/warhammer-40000/)
to obtain each current faction pack. Its file cards are hydrated in the
browser, so a raw page fetch can expose the filters and Munitorum Field Manual
without exposing the faction-pack links. Produce an unsigned inventory from
the same official endpoint used by the page:

```bash
npm run data:legends:discover -- \
  --out /absolute/path/gw-faction-pack-candidate.json
```

The command fails closed on an empty, partial, paginated, identity-duplicated,
or cross-origin faction-pack inventory. A duplicated CMS display slug is
retained with a review warning because it is not a stable publication
identity. The command only discovers current official asset
URLs. The candidate retains the exact API response byte length and SHA-256,
plus a deterministic hash of the normalized faction-pack inventory, but it
does not classify a unit or authorize publication. Keep the prior
verified bundle active when the endpoint or response schema is unavailable,
and compare the complete candidate with the expected supported-faction
inventory before downloading any PDF. The Munitorum Field Manual remains the
primary points artifact; it is not sufficient evidence that a datasheet is or
is not Legends.

For every supported faction:

1. Save the exact faction-pack PDF and its official URL.
2. Produce an unsigned review candidate:

   ```bash
   npm run data:legends:extract -- \
     --pdf /absolute/path/aeldari-faction-pack.pdf \
     --faction-id aeldari \
     --game-edition 11th \
     --source-url https://assets.warhammer-community.com/...pdf \
     --out /absolute/path/aeldari-legends-candidate.json
   ```

3. Inspect every extracted title and PDF page. For a reviewed pack with no
   Legends datasheets, rerun with `--allow-empty`; absence is otherwise an
   error.
4. Resolve exact title-to-unit identities only where the structured rules have
   a complete matching unit. Keep all other official titles with `unitId:
   null`.
5. Have the independently reviewed extractor produce the schema-v2 official
   overlay and signed schema-v2 receipt. The candidate extractor does not sign
   or grant publication authority. Each retained Legends source and its signed
   receipt must bind `documentKind: "faction-pack"`, the source faction name,
   the exact game edition, the pack version, an ISO `legalFrom` date, the
   official HTTPS asset URL, and the artifact SHA-256. The overlay edition must
   match the active structured-rules edition; standalone Legends cards and old
   Legends Field Manuals cannot satisfy this contract.
6. Check the evidence while supplying every exact pack artifact:

   ```bash
   npm run data:official-overlay -- check \
     --file /absolute/path/official-overlay-v2.json \
     --source-artifact /absolute/path/munitorum-field-manual.pdf \
     --legend-source-artifact aeldari-pack-2026=/absolute/path/aeldari-faction-pack.pdf \
     --receipt /absolute/path/official-receipt-v2.json
   ```

   Repeat `--legend-source-artifact <source-id=path>` once for every
   `legendSources` entry in the overlay. Missing, extra, duplicated, or
   byte-mismatched artifacts fail closed.
7. Pass the same repeated options to `data:bundle:build`,
   `data:bundle:prepare-release`, or `data:prepare-update`. A signed runtime
   schema-v2 faction shard freezes the exact inventory, coverage state, source
   hashes, classification authority, and build-support status. Runtime schema
   v1 remains readable and reports Legends coverage as unavailable.

BSData can provide non-authoritative classification signals and the exact New
Recruit `Show/Hide Options -> Legends are visible` selection path. It cannot
turn a unit into Legends or supply missing gameplay rules. Catalogue refreshes
retain unmatched signals as review evidence and never silently change runtime
classification.

## Policy at build time

Roster construction accepts `legendsPolicy: "auto" | "allow" | "exclude"`
plus a play context. The compatibility field `allowLegends` remains readable,
but new callers should use the policy field.

- No prompt or context defaults to exclusion; RosterPilot does not ask an
  unnecessary question.
- Explicit casual, narrative, or open-play permission can allow Legends when
  classification is verified and complete build data exists.
- A named event requires an `event-pack` or `organizer-ruling` evidence record
  that explicitly permits Legends. An explicit `allow` without that evidence
  still fails closed.
- A verified event denial cannot be overridden.
- Unverified or unavailable faction classification never enables Legends.
- Requiring an inventory-only unit returns
  `LEGENDS_BUILD_SUPPORT_UNAVAILABLE` rather than inventing a profile.

The resolved decision is stored in the roster. Validation checks it again,
text and printable HTML label selected Legends, and all exports return a
`LEGENDS_INCLUDED` warning. ROS/ROSZ exports additionally select the exact
New Recruit Legends visibility branch; if that mapping is missing, export
returns `NEW_RECRUIT_LEGENDS_CONFIGURATION_UNAVAILABLE`.

`get_data_status` reports coverage, authority, inventory, build-supported, and
inventory-only counts. `search_units` can include both buildable and
inventory-only Legends; inventory-only results are visibly marked and cannot
be passed off as build candidates. A verified result also includes
`legendProvenance` with the exact Games Workshop source id, version, SHA-256,
publication URL, and optional datasheet URL. That field is deliberately absent
for unverified or community-only classifications; callers must preserve the
classification warning rather than presenting those records as official.
