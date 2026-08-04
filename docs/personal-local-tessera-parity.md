# Personal local Tessera parity

This path allows one user on one machine to use the pinned local Tessera engine
for army-versus-army conclusions after it has repeatedly matched Tessera Web on
the same exact evidence contract. It is not a hosted, distributable, or
multi-user certification. A written-license record is not part of this
personal-only activation gate.

Until the attestation is active, Tessera Web remains the comparison authority:
`auto` chooses Web, while an explicit local run is diagnostic and cannot
produce coaching, optimizer decisions, or roster-change candidates. Offline
tests and verification never open New Recruit or Tessera Web. Collecting Web
evidence is a separate explicit operation, and an automatic fallback remains a
hash-bound offer until separately confirmed.

## Exact evidence chain

One decision-grade local result is the product of four immutable layers:

1. **Local input v2** binds each canonical roster to its active bundle,
   execution fingerprint, profile policy, unit selections, exact weapon,
   equipment, profile, bearer, loadout group, and numeric range.
2. **Physical scenario v3** binds actual selections and formations, resources,
   unit state, activations, attachments, and every cross-side combat pair.
   Distance and exact profile range determine ordinary, Rapid Fire, Melta, and
   Conversion eligibility. A contradictory selected state fails closed.
3. **Combat corpus and bridge v3** inventory every structured rule/effect leaf,
   apply the hash-sealed reviewed overlay, and bind exact rule sources and
   replay inputs. Approximate, omitted, unresolved, stale, or unreviewed combat
   semantics cannot be decision-grade.
4. **Provider parity v2** binds the local and Web reports to the same physical
   contract, combat states, covering case, profiles, ranges, bridge exactness,
   cells, uncertainty, and receipts before comparing numbers or winners.

The bridge keeps the community `40kdc-data` rules/effects compiler separate
from the local Tessera adapter. The compiler supplies structured semantics; the
review overlay states which shapes have been checked and how they map to the
directional calculator. A reviewed non-combat leaf can be outside calculator
scope. A combat-relevant leaf cannot be labeled non-combat or modeled merely to
avoid a review failure.

## Physical-state rules

Scenario v3 has two modes:

- `selected` freezes state, activations, and attachments. Only this mode can
  support one scalar roster conclusion.
- `envelope-only` retains one or more unresolved dimensions. Its deterministic
  minimum, median, and maximum remain useful for diagnosis, but its median is
  not a decision-grade scalar.

Attached leaders, bodyguards, and support selections are executed as one
physical formation. Shooting profiles execute only when their exact range and
the pair distance permit it. The same physical state must remain consistent
across metrics and both attack directions.

## Strict corpus review

Bridge v3 admission is intentionally conservative. The corpus report retains
the source inventory, fragments, leaves, ancestry, effect types, phase
evidence, review disposition, and translation result. Admission stops when it
finds any of the following:

- incomplete traversal or a previously unseen structured effect;
- an unresolved community rule or ability mapping;
- an approximate or omitted combat leaf;
- a stale exact leaf, entity, effect, or rule-source binding;
- a state-dependent mechanic without an exact scenario-v3 state key;
- a bridge or adapter projection that is not complete.

The failure is a review request, not permission to substitute a guessed zero.
After the reviewed store or community mapping changes, the corpus, bridge,
covering suite, and parity evidence receive new hashes and must be tested and
attested again.

An admitted run writes its inventory, overlay, conformance report, translation
ledger, and a `combat-corpus-admitted-<n>-<opponent>-parity-suite-manifest.json`
artifact. The manifest contains the admitted bridge and corpus hashes plus the
attacker/defender mechanics derived from the exact bridge. It can be used
directly as the input to `parity-suite build`; the builder reads its
`corpusInventorySha256` and `factions` fields.

## Bidirectional covering suite

The schema-v2 suite uses deterministic greedy bidirectional set cover. Its
requirements bind each faction in attacker and defender roles plus the
reviewed attacker/defender mechanic identifiers derived from one exact combat
corpus inventory. One exact matchup evaluates both directions, so a
Custodes-versus-World-Eaters case can cover both factions when that single case
contains the suite's complete requirements. A larger supported corpus may
produce several cases.

Build and verify the suite with the admitted-run manifest:

```bash
npm run rosterpilot -- tessera parity-suite build \
  --manifest combat-corpus-admitted-1-opponent-parity-suite-manifest.json \
  --out covering-suite.json

npm run rosterpilot -- tessera parity-suite verify \
  --suite covering-suite.json
```

The build manifest may also be a small JSON document with
`corpusInventorySha256`, a `factions` array containing `factionId`,
`attackerMechanicIds`, and `defenderMechanicIds`, and optional
`allowMirrorCases`. Verification recomputes the deterministic suite and its
self-hash and returns the exact `suiteSha256` and ordered case IDs.

The suite corpus identity and a case witness answer different questions. The
suite's `corpusInventorySha256` freezes the mechanic inventory from which the
set-cover requirements were planned. Each admitted exact run must separately
prove its selected case with `coverageWitnesses`: every mechanic requirement
needs at least one relevant bridge-v3 leaf, and every role requirement needs an
executable attacker or defender cell. The case-evidence hash binds those
witnesses to the case ID, exact bridge-v3 hash, and conformance-report hash. A
matching faction name or suite hash alone cannot claim that a roster exercised
the required mechanics.

## Run each parity case

Pass both parity flags to each local and Web exact analysis. They are a pair,
require simulate mode, and the case ID must exist in the verified suite:

```bash
npm run rosterpilot -- tessera analyze \
  --file player.json \
  --opponent-roster opponent.json \
  --simulation-backend local-engine \
  --execution-mode simulate \
  --provider-parity-suite covering-suite.json \
  --provider-parity-case adeptus-custodes-into-world-eaters \
  --out-dir exports/tessera/parity/local

npm run rosterpilot -- tessera analyze \
  --file player.json \
  --opponent-roster opponent.json \
  --simulation-backend website \
  --execution-mode simulate \
  --provider-parity-suite covering-suite.json \
  --provider-parity-case adeptus-custodes-into-world-eaters \
  --out-dir exports/tessera/parity/web
```

The Web command still performs the complete local parity preflight first. It
requires one canonical opponent, acquires the immutable bundle snapshot,
validates the physical scenario, compiles both local-input-v2 payloads, admits
the combat corpus, and compiles bridge v3 before any New Recruit mutation,
Tessera credential use, or Web navigation. After provider execution, report
sealing derives and verifies the selected case's mechanic witnesses. A
preflight failure returns the local review artifacts and explicitly records
that no external activity started.

After both reports finish, run `compare-providers`. Exact parity v2 requires
the same suite, case, scenario-v3 state, bridge and conformance identities,
case-witness evidence, roster fingerprints, combat-state hashes, provider-state
evidence, cells, uncertainty, and adjacent exact receipts.

## Four-rotation activation

Run and retain four fresh complete rotations for the same machine, provider
identity, active local-source bundle, corpus inventory, and covering suite.
Each rotation contains one exact local/Web comparison per suite case. The
required chronology is:

1. passing `observe` rotation;
2. passing `observe` rotation;
3. passing `observe` rotation;
4. passing `enforce` rotation.

For a one-case suite, preserve the direct convenience flow by requesting a
private rotation record from `compare-providers`:

```bash
npm run rosterpilot -- tessera compare-providers \
  --local-report exports/tessera/local/army-matchup.json \
  --website-report exports/tessera/web/army-matchup.json \
  --personal-rotation-id rotation-1 \
  --personal-rotation-mode observe \
  --personal-rotation-record exports/tessera/parity/rotation-1.json \
  --out-dir exports/tessera/parity
```

Use a distinct ID and output path for every rotation, and use `enforce` for the
fourth. The comparison revalidates both exact receipts and evidence hashes; a
numerical pass without complete exact bindings is ineligible and writes no
personal record. The direct writer is eligible only when this comparison covers
the suite's sole case.

For a multi-case suite, first create one passing
`tessera-provider-parity.json` comparison per case without the direct personal
rotation flags. Then aggregate the complete case set into one rotation:

```bash
npm run rosterpilot -- tessera personal-rotation aggregate \
  --covering-suite covering-suite.json \
  --comparison case-1/tessera-provider-parity.json \
  --comparison case-2/tessera-provider-parity.json \
  --rotation-id rotation-1 \
  --mode observe \
  --record exports/tessera/parity/rotation-1.json
```

Aggregation requires exactly one complete, passing, personal-eligible
comparison for every suite case; duplicate, missing, or extra cases fail. All
comparisons must bind the same suite, data bundle, local provider identity, and
Web provider identity. The resulting record hashes the sorted case IDs, paired
exact receipts, and parity results. The same command also accepts a one-case
suite, although direct `compare-providers` recording remains simpler.

Repeat the entire suite for each rotation: three fresh complete aggregates in
`observe` mode and a fourth complete aggregate in `enforce` mode. Do not mix
case comparisons from different rotations, bundles, or provider deployments.

Create the attestation from exactly those four records and the verified suite
artifact retained by the source reports:

```bash
npm run rosterpilot -- tessera personal-attestation create \
  --rotation exports/tessera/parity/rotation-1.json \
  --rotation exports/tessera/parity/rotation-2.json \
  --rotation exports/tessera/parity/rotation-3.json \
  --rotation exports/tessera/parity/rotation-4.json \
  --covering-suite covering-suite.json

npm run rosterpilot -- tessera personal-attestation status \
  --covering-suite covering-suite.json
```

The private store uses owner-only paths, rejects symbolic links and
non-canonical JSON, and verifies every self-hash. Attestation creation requires
the complete verified covering-suite-v2 artifact, checks that all four records
bind it, and retains a private copy under the personal store. A suite hash alone
cannot activate or inspect promotion. `personal-attestation status` uses the
current supplied suite and the retained copy to verify the binding.

The attestation is active only when its derived machine identity, provider
identity, bundle, and suite match the current run. Before every promoted local
matchup, preflight derives all attacker/defender roles and mechanics executed by
the current bridge and requires them to be a subset of the retained suite's
declared requirements. An undeclared mechanic fails local preflight and cannot
produce a promoted result. Build a replacement suite containing that mechanic,
then collect three new complete `observe` rotations and one new complete
`enforce` rotation. A new engine identity, bundle, corpus review, or suite
likewise returns `auto` to Tessera Web until four matching rotations are
recorded.

## What Web contributes

Tessera Web does not expose an authoritative rules version. Its parity evidence
therefore comes only from what was actually observed: same-origin deployment
bytes, imported army and selected-list bindings, unit/model counts, defensive
profiles, active weapon profiles and ranges, visible effects, settings, cells,
and sample uncertainty. Missing or ambiguous Web semantics fail closed; local
bundle values never fill the gap.

After personal attestation, the local engine may be selected automatically for
the bound machine and evidence identity. Web is still needed to create future
rotations after an identity changes or whenever the user explicitly wants a
fresh comparison. It is never needed for ordinary offline local execution.

## Primary implementation surfaces

- Physical state: `local/tessera/scenario-contract-v3.ts` and
  `local/tessera/scenario-v3-execution.ts`
- Exact local identities: `local/tessera/local-engine-input-v2.ts`
- Corpus admission: `lib/rosterpilot/combat-corpus-conformance.ts` and
  `local/tessera/combat-bridge-input-v3.ts`
- Reviewed overlay: `local/tessera/combat-corpus-reviewed-overlay.ts`
- Exact bridge: `lib/rosterpilot/combat-bridge-v3.ts`
- Covering suite and comparison: `local/tessera/provider-parity-covering-suite-v2.ts`,
  `local/tessera/provider-parity-v2.ts`, and
  `local/tessera/provider-parity-workflow.ts`
- Multi-case rotation aggregation:
  `local/tessera/personal-parity-rotation-aggregate.ts`
- Personal store: `local/tessera/personal-local-attestation.ts` and
  `local/tessera/personal-local-attestation-store.ts`
