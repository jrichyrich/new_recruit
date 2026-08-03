# Runtime semantic data snapshots

RosterPilot updates runtime data independently from application releases.
Games Workshop publications are authoritative where they can be verified
directly, 40kdc-data supplies structured game content, and BSData supplies New
Recruit catalogue identities and selection paths. A bundle records all three
provenance sources, but compatibility is decided by semantic hashes rather
than release labels or Git commits.

There are three provider modes:

- `local-source` is the default for CLI, stdio MCP, the local agent, and
  writable self-hosted Node installations. It builds from allowlisted upstream
  sources on the user's machine and needs no signing key, trust registry, or
  central RosterPilot publication.
- `signed-channel` is an explicitly configured hosted/operator mode. It
  authenticates publisher-issued snapshots for stateless deployments, release
  canaries, and promotion evidence.
- `compiled` is the startup and failure fallback. It keeps roster work usable
  while a first local build runs or when no configured update provider can
  produce a verified snapshot.

Local mode never automatically falls back to the signed channel. Existing
signed archives remain readable so old rosters and durable jobs can reacquire
their exact snapshot during migration.

## Authority and conflict policy

The inputs have deliberately different responsibilities:

- Games Workshop's published downloads are authoritative for
  machine-verifiable points, leader links, Detachment Points, Force
  Dispositions, errata, and dataslates.
- 40kdc-data is the structured operational source for units, weapons, stats,
  loadouts, and community-authored mechanics.
- BSData is the interoperability source for New Recruit catalogue identities,
  selection paths, constraints, and export structure.

An official value overrides a conflicting community value only when the
publication and extracted value have exact, verifiable provenance. Otherwise
the affected entity or faction is quarantined; the engine never silently
chooses between community interpretations. BSData does not become the roster
rules authority merely because New Recruit consumes it.

The accepted `DataBundleProvider` snapshot is the canonical runtime rules
source. Its `dataTrust` is `locally-verified`, `signed-verified`, or
`compiled-unverified`. New Recruit catalogue IDs and revisions observed after an import
show whether the live service accepted the bundle's pinned BSData mapping;
they are compatibility evidence only. They do not update points, profiles,
abilities, legality, or any semantic hash in the leased bundle. The same rule
applies to characteristics or effects rendered by Tessera Web: observations
are retained beside the bundle, never merged back into it as rules data.

Provider-compatibility evidence binds those observations to the accepted
manifest and current provider state: provider mode, trust origin, manifest and
semantic hashes, active/latest/upstream/candidate bundle IDs, quarantines,
rollback hold, official-authority identity, and durability. A
`compiled-unverified` fallback is retained as incomplete evidence and cannot
pass the live compatibility gate. Ordinary roster, New Recruit, Tessera, and
local-versus-Web analysis may use `locally-verified`; maintainer release
canaries and promotion evidence continue to require `signed-verified`.

## Local build receipts and trust

A local snapshot is unsigned. Its build receipt binds:

- the exact manifest, bundle ID, and every shard path and SHA-256;
- the 40kdc package version, tarball integrity, and exact BSData commit;
- the builder source hash and engine-data schema;
- the validation plan, certification evidence inventory, delta classification,
  and affected scopes; and
- the parent snapshot, when one exists.

The store re-verifies the receipt, manifest, and every shard whenever the
snapshot is loaded. This provides reproducibility and corruption detection; it
does not authenticate a publisher or protect against an attacker who can
modify both the application and its application-support directory. That is an
intentional local trust model: the user trusts the cloned RosterPilot code and
the explicitly allowlisted upstream sources.

## Local-source update pipeline

The local coordinator persists one single-flight job under the user
application-support directory. Its states are `queued`, `checking`,
`fetching`, `building`, `certifying`, `installed`, `activated`, `quarantined`,
and `failed`. Ordinary roster work never waits for it.

- With no locally verified snapshot, startup queues a check immediately.
- Otherwise CLI/MCP startup queues only when the last attempt is more than 24
  hours old. The macOS companion wakes hourly and enqueues only when due.
- Automatic failures retry after one hour and then back off to a six-hour cap.
  An explicit refresh bypasses backoff.
- Fetching is limited to npm metadata and the integrity-addressed
  `@alpaca-software/40kdc-data` tarball, exact commits from
  `BSData/wh40k-11e` through a persistent bare Git cache, and Games Workshop
  pages for change detection.
- Candidate work runs in an isolated temporary project with a sanitized
  environment, no credentials, npm lifecycle scripts disabled, and bounded
  time and output. It never writes generated data into the checkout.
- Schema, mapping regressions, semantic delta, export smoke tests, and
  deterministic certification must pass before atomic activation. Scoped
  changes certify affected factions; global or methodology changes run the
  full plan. Failed or ambiguous scopes are quarantined and the active
  snapshot remains unchanged.

Games Workshop change detection does not automatically extract or interpret
new official material. Status reports `official-update-pending`, keeps the last
usable values, and exposes official-authority state separately until reviewed,
machine-verifiable reconciliation evidence exists.

## Hosted signed-channel release pipeline

This section is for hosted deployment and release operators. Local users do
not run it and do not need its signing variables.

`npm run data:prepare-update` performs the routine update:

1. Check the three upstream source classes.
2. Copy the application data tooling into a temporary directory.
3. Install and generate the candidate there. The working checkout is not
   rewritten.
4. Build the candidate's global and faction shards, compare their semantic
   inventory with the published manifest, and classify the delta.
5. Skip certification churn for `provenance-only`; certify affected faction
   and dependency scopes for `mapping-only` or `rules`; run the full matrix
   for `methodology/global`.
6. Sign the immutable manifest and every hash it references, copy the
   content-addressed bundle, and move the signed channel pointer last.

A repeated observation whose official version/content hash, 40kdc
version/source hash, and BSData commit are unchanged does not advance
`checkedAt`, the source release label, the bundle, or channel ancestry. A real
source-identity change is still published with its exact provenance even when
its semantic classification is `provenance-only`.

An ambiguous or regressive candidate is rejected before publication. The
legacy tracked-file transaction remains available only as
`npm run data:prepare-update:legacy-direct-sync`; it is not used by routine CI.

An official MFM version or content-hash change is never treated as
provenance-only by assumption. The candidate must include a supported official
rules overlay, exact downloaded source artifacts, and independently signed
extraction receipt whose source version and SHA-256 match the candidate Games
Workshop publication:

```bash
npm run data:prepare-update -- \
  --official-reconciliation-evidence /absolute/path/official-overlay.json \
  --official-source-artifact /absolute/path/official-source \
  --official-extraction-receipt /absolute/path/official-receipt.json
```

Schema v2 adds current Legends classification. It retains the MFM as the
primary artifact and binds every inspected faction-pack PDF separately:

```bash
npm run data:prepare-update -- \
  --official-reconciliation-evidence /absolute/path/official-overlay-v2.json \
  --official-source-artifact /absolute/path/munitorum-field-manual.pdf \
  --official-legend-source-artifact aeldari-pack-2026=/absolute/path/aeldari-faction-pack.pdf \
  --official-legend-source-artifact custodes-pack-2026=/absolute/path/custodes-faction-pack.pdf \
  --official-extraction-receipt /absolute/path/official-receipt-v2.json
```

The faction-pack option is repeatable and keyed by `legendSources.sourceId`.
The supplied set must match the overlay exactly. Runtime schema v1 remains
readable, but it has no Legends inventory and reports classification coverage
as unavailable. See [Legends classification and roster policy](legends.md).
The application-release, data-freshness, and certification-review workflows
accept the same inventory in `official_legend_source_artifacts` as a JSON array
of `source-id=HTTPS-or-checkout-relative-path` strings. Each workflow downloads
those artifacts, runs the overlay check against their exact bytes, and
forwards the resolved paths to the signing command.

The release verifier hashes the actual source bytes, recomputes normalized
payload hashes and stable entity keys for every scope, requires exact
one-to-one inventory coverage, binds the exact overlay bytes, and verifies the
receipt's Ed25519 signature against
`data/official-extractor-trusted-keys.json`. Merely setting an overlay count
equal to an array length cannot authorize publication. The overlay is then
parsed by the engine, applies official points, leader links,
Detachment Points/Force Dispositions, enhancement points, and schema-v2
Legends classification over community data, and records conflicts as explicit
official overrides. Missing,
malformed, stale, or entity-incomplete evidence classifies the official scope
as `ambiguous/regressive`; the stable pointer does not move.

The normal command writes to the ignored `dist/data-channel` directory. Use:

```bash
ROSTERPILOT_DATA_SIGNING_KEY_ID=release-2026 \
ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK='{"kty":"OKP",...}' \
ROSTERPILOT_DATA_BUNDLE_BASE_URL=https://data.example.test \
npm run data:prepare-update
```

The private Ed25519 JWK belongs in the CI secret store. It must never be
passed on the command line, written to output, or committed. The corresponding
public key and key ID are application configuration so old and new keys can
overlap during rotation.

`npm run data:bundle:build` signs the data already present in a checkout
without performing a live refresh. `--previous-manifest` enables semantic
classification, while `--no-refresh` on the routine command is useful for an
offline candidate/channel build. Use `data:bundle:prepare-release`, not the
routine publisher, to prepare an application's signed bootstrap assets.

## Published layout

The `data-bundles` branch contains:

```text
bundles/<bundleId>/manifest.json
bundles/<bundleId>/shards/global.json
bundles/<bundleId>/shards/<faction>.json
channels/stable.json
channels/stable/<pointerSha256>.json
channels/stable.update.json
quarantines/<failedBundleId>.json
```

The signed stable pointer references an HTTPS manifest URL in production.
Pointer schema v2 also carries a monotonic channel revision, the
content-addressed URL and SHA-256 of its immediate predecessor, and a signed
transition (`publish` or an explicitly authorized live-canary rollback).
Providers retain a durable compare-and-swap channel cursor and verify the
complete missing ancestry before accepting a newer revision. Replaying an
older but otherwise valid signature, skipping a revision, rewriting history,
or racing a stale isolate therefore fails closed across process restarts.
Legacy v1 pointers remain readable only as a migration genesis; subsequent
movement must enter the v2 chain.
Loopback HTTP is accepted only by local fixtures and development. The update report
is informational; clients recompute trust from the signed pointer, signed
manifest, and declared shard hashes. Existing bundle paths are immutable.
Automated live-canary rollback likewise obtains its immediate predecessor only
from the active pointer's verified signed-v2 transition and content-addressed
predecessor pointer. It never trusts `channels/<name>.update.json` to choose a
rollback target; missing, legacy-only, or tampered ancestry fails closed. Only
a failed `publish` transition is rolled back automatically. A bundle reached
through an earlier rollback requires operator review instead of automatically
cycling back to its quarantined predecessor.

The scheduled workflow publishes this branch only after certification and
also retains a 30-day workflow artifact. Application releases contain one
verified bootstrap bundle for offline startup; changing that bootstrap is a
release action, not a routine refresh.

### Expert-review packages

Semantic publication remains blocked when an affected faction has a pending
expert review, even if its deterministic roster, mapping-baseline, and ROSZ
checks pass. Run the manual `Certification review package` workflow in that
case. It executes the same isolated refresh, signed candidate build, manifest
synchronization, and affected-scope certification as the publisher, but it
never pushes the data channel. When review is the only remaining gate it
uploads a hash-inventoried artifact containing:

- the exact signed candidate manifest and update report;
- the synchronized pending certification manifest;
- every affected faction certification report and detached report hash; and
- a SHA-256 inventory plus reviewer instructions.

An authorized Warhammer reviewer must inspect the pending case's exact
`reviewBinding`, semantic evidence, assertions, mapping baseline,
representative builds, and canonical ROSZ evidence. The reviewer then copies
only accepted bindings into `data/certification-manifest.json` in a separate
pull request, changes those entries to `reviewed`, records `reviewedAt`, and
removes stale invalidation reasons. The review PR must pass
`npm run certify:manifest:check` and deterministic certification before the
normal `Roster data freshness` workflow is rerun. A review package is evidence,
not an approval, and the packaging workflow cannot publish a bundle.

## Application-release bootstrap and key rotation

Prepare the bootstrap and its public trust registry together only from the
application-release job:

```bash
ROSTERPILOT_DATA_SIGNING_KEY_ID=release-2027 \
ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK='{"kty":"OKP",...}' \
npm run data:bundle:prepare-release
npm run data:bundle:verify-release
npm run build:release
```

The command reads signing material only from those CI environment variables.
It derives the Ed25519 public JWK in memory, signs and verifies a fixed
challenge to prove that the public and private halves match, builds the
current runtime bundle, signs it, reads it back from its staged directory, and
verifies every manifest and shard before replacing
`data/bootstrap-data-bundle`. Its output contains the bundle ID, key ID, and
public-key SHA-256 fingerprint; it never prints or writes the private JWK.

`data/data-bundle-trusted-keys.json` is updated additively. Introducing
`release-2027` retains `release-2026` and every other installed public key.
Reusing an existing key ID with different public material fails closed. This
provides a reviewable rotation sequence:

1. Generate the new Ed25519 key in the CI secret manager. Do not generate it
   in the repository and do not paste it into a terminal history.
2. Run `data:bundle:prepare-release` with the new key ID in the application
   release job. Review the new public registry entry and signed bootstrap
   together.
3. Release the application with both old and new public keys installed.
4. Move signed-channel publication to the new key after the overlap release
   is deployed to every minimum-supported client. A client released before the
   new public key was installed cannot verify a pointer signed only by that new
   key and must fail closed until upgraded.
5. Retire an old public key only in a later, separately reviewed application
   release, after no retained bundle or supported client needs it. The
   preparation command intentionally has no automatic key-removal option.

Use the overlay, source-artifact, and extraction-receipt options together when
the application release contains verified Games Workshop overrides. `--out-dir`, `--trusted-keys`,
and `--created-at` exist for release staging and reproducibility. Both output
paths must remain inside the project root; symlinks and a key registry nested
inside the replaceable bootstrap directory are rejected.

When an official publication changed, create a deliberately non-publishable
review skeleton with
`npm run data:official-overlay -- template --out <path>`, populate it through a
reviewed machine-verifiable extractor, and require
`npm run data:official-overlay -- check --file <path> --source-artifact
<downloaded-source> --receipt <signed-receipt>` before passing the evidence
to the release command. A schema-v2 check also repeats
`--legend-source-artifact <source-id=path>` for every faction pack. The check
verifies the exact source bytes, normalized
payloads, one-to-one entity inventory, and reviewed-extractor signature; an
empty template or untrusted key cannot authorize publication.

The tracked extractor registry is intentionally empty until a real extractor
has been independently reviewed. Enabling official publication requires an
application release that adds a public Ed25519 key entry with the extractor
ID, key ID, review date, and durable review reference. The extractor's private
key must remain in the extractor environment and must not be shared with the
data-bundle signing job. Until that prerequisite is completed, official
changes fail closed; no code path treats the overlay's self-declared counts as
trusted evidence. For a routine update, the publisher hash-verifies the prior
signed snapshot. Its signed global shard retains the exact normalized official
overlay together with the receipt-bound authority hashes. If the official
version/content hash and structured-rules provenance are unchanged, the exact
effective snapshot is carried forward. A BSData-only refresh therefore needs
no manual evidence re-supply and remains provenance-only. If 40kdc changes but
the Games Workshop publication is unchanged, the publisher reapplies that
exact retained overlay to the new structured data, revalidates every referenced
entity and official value, and recomputes community conflicts. An entity
mismatch fails closed. A Games Workshop source change requires new reviewed
evidence, as does a 40kdc change when the prior legacy bundle did not retain
the overlay. An initial application bootstrap has no prior binding to inherit
and therefore fails closed unless reviewed evidence is supplied. A
deliberately degraded bootstrap is possible only with
`--official-authority-unavailable <reviewable-reason>`; its signed global shard
records `officialAuthority.status = unavailable` and does not claim official
reconciliation. The Application release workflow exposes the same explicit
reason input. It must never be used as shorthand for an unreviewed overlay.

### Reviewed official extractor contract

The external extractor emits a same-version overlay and receipt. Schema v1
covers the original official scopes. Schema v2 additionally carries exact
faction-pack provenance plus `legendUnits` and `legendFactionCoverage` scopes;
every supported faction has explicit complete or not-published coverage, and
an unresolved official title remains inventory-only with `unitId: null`.
The unsigned receipt payload contains the official version, URL,
source byte length and SHA-256; extractor ID and version; the exact overlay
SHA-256; issue time; and, for each of `unitPoints`, `leaderLinks`,
`detachments`, and `enhancementPoints`, a status, sorted
`sourceEntityKeys`, and normalized payload SHA-256. Entity keys are
`<factionId>:<unitId>`, `<factionId>:<leaderId>`,
`<factionId>:<detachmentId>`, or `<factionId>:<enhancementId>` as appropriate.
Schema v2 adds `<factionId>:<legendId>` and one
`<factionId>:<factionId>` coverage key per inspected faction.
Duplicate keys are invalid. The payload is signed as canonical JSON with
Ed25519 and the receipt adds `{algorithm, keyId, value}` under `signature`.

Schema-v2 extractor implementations use
`createOfficialExtractionReceiptDraftV2` and supply the exact faction-pack byte
map. Schema-v1 implementations continue to use
`createOfficialExtractionReceiptDraft`. Both helpers are exported from
`lib/rosterpilot/official-data.ts` and produce only the canonical unsigned
payload. They do not grant trust or access a private key. The extractor signs
that exact canonical JSON in its separately controlled environment;
publication succeeds only after the matching reviewed public key is installed:

```json
{
  "schemaVersion": 1,
  "extractors": [
    {
      "extractorId": "reviewed-gw-extractor",
      "keyId": "gw-extractor-2026-01",
      "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": "..." },
      "status": "trusted",
      "reviewedAt": "2026-08-01T00:00:00.000Z",
      "reviewReference": "https://example.invalid/reviews/gw-extractor-2026-01"
    }
  ]
}
```

The example is structural only; its placeholder URL and key are not trusted
configuration and must never be copied into a release.

`data:bundle:verify-release` rereads the installed public registry, local
bootstrap, and same-origin hosted bootstrap, verifies signatures and every
declared payload, and requires their canonical bytes to agree. `build:release`
runs that gate before the application build. The manual
`.github/workflows/application-release.yml` workflow is the supported CI path;
it keeps private signing material in secrets and uploads the verified public
assets for deployment. The repository's empty trust registry is an
intentional source-state placeholder, not a runnable production trust root.

The command holds `.rosterpilot-data-bundle-release.lock` while it runs. A
leftover lock signals an interrupted release and must be reviewed rather than
silently bypassed. Trust-registry activation is written before the bootstrap
directory moves, so an interruption can at worst leave an unused public key;
it cannot install a bootstrap whose signing key is absent from the registry.

## Runtime activation and recovery

Every surface uses the same provider contract and every data-consuming
operation leases one immutable snapshot. Local surfaces initialize immediately
from the newest verified local archive, or from compiled data when no local
snapshot exists yet. Their startup check is a non-blocking enqueue into the
durable local coordinator. Hosted `signed-channel` surfaces instead verify
their stable pointer, manifest signature, schema, and every payload hash before
moving the active pointer. Neither mode changes a lease already in use.

Use the same sequence through MCP, CLI, REST, or the local agent:

1. Read engine provenance with `get_data_status`, then call
   `get_data_update_status` to distinguish `activeBundleId`,
   `providerMode`, `dataTrust`, `latestVerifiedBundleId`,
   `latestUpstreamBundleId`, local job progress, service-compatible snapshots,
   candidate classification, quarantined scopes, and `officialAuthority`. The
   latter is `verified` with source/overlay/receipt hashes and extractor IDs,
   or is explicitly pending/unavailable with a reason.
2. Use `refresh_data_now` only when an immediate check is requested. In local
   mode it queues the durable job and returns promptly; in hosted mode it keeps
   the configured signed-channel behavior. The CLI equivalent is
   `rosterpilot data refresh`.
3. Open an existing roster with `rebase_roster` (CLI:
   `rosterpilot rebase --file roster.json`). A provenance-only change returns
   `compatible-rebased`; a relevant semantic change returns
   `review-required` with exact entity and mapping scopes. Rebase never changes
   unit selections.
4. Use `rollback_data_bundle` (CLI:
   `rosterpilot data rollback --bundle <bundle-id>`) only to select an exact,
   retained, verified bundle for future work. It is not a substitute for
   reviewing a roster whose relevant rules changed. Rollback persists a
   `rollbackHold` across agent and CLI restarts, so scheduled and request-driven
   refreshes cannot silently reactivate the channel head. Only an explicit
   forced refresh (`rosterpilot data refresh --force`) releases the hold.

If no locally verified snapshot exists yet, or if an update attempt cannot
reach an upstream source, construction continues from compiled
application-release data. Status reports `compiled-unverified` instead of
claiming that the fallback is verified. A later successful local build
activates without restarting current work. Hosted mode similarly retains an
already verified bootstrap when its signed channel becomes unavailable.

Each data-consuming request acquires one immutable snapshot lease. Status,
refresh, and rollback are control-plane operations and intentionally do not
acquire a roster-data lease. Activation still waits for existing leases and
therefore affects only data-consuming requests that begin afterward. Durable Tessera jobs
record their exact `bundleId` and reacquire that archived snapshot on resume;
they never mix simulation evidence across bundles. Moving a job to current
data requires a new run or an explicit compatible roster rebase.

Durable roster journeys follow the same rule per transition. A journey retains
the bundle referenced by each immutable roster revision and reacquires that
exact snapshot only while executing an action. A provenance-only compatible
rebase creates a new revision; a semantic change records `review-required` and
preserves the prior revision. Activating a newer snapshot never rewrites
an existing journey, Tessera job, or mutation receipt.

The local store retains the active bundle, the previous three bundles, every
bundle with a registered roster, service-compatibility, or durable-job
reference, and unreferenced candidate bundles for at least 30 days. Integrity failures block garbage collection
rather than risk deleting referenced evidence. Snapshot leases are separate
process-owned transient references with a bounded lifetime; retention recovers
them immediately after a confirmed owner exit or at expiry, so a crashed CLI
or agent cannot pin an archive forever. Roster and durable-job references stay
non-expiring until their owning workflow explicitly releases them.

Every schema-v3 roster freezes the same safe official-authority status inside
`sourceData.official.authority`. Construction and validation add
`OFFICIAL_AUTHORITY_UNAVAILABLE` whenever that status is not `verified`.
This warning does not block unrelated roster construction, but it prevents
community-only or legacy data from being mistaken for reviewed official
reconciliation after the roster leaves the originating machine.

## External-provider compatibility evidence

The immutable bundle answers “which rules and mappings did RosterPilot use?”
It cannot, by itself, answer “what did a live external provider actually load?”
Tessera reports therefore carry a separate, content-addressed compatibility
envelope. It references the bundle instead of copying or overriding it and
adds the canonical roster/input hashes, selected provider identity,
profile-policy hash, and deterministic scenario-contract hash.

For New Recruit, the envelope stores both the bundle-pinned game-system and
faction-catalogue identity and the identity observed in the enriched ROSZ.
Matching observations prove compatibility for that handoff; missing or
different observations are `unverifiable` or `drift` and block the ordinary
website route. A newer release label alone is neither proof of a gameplay-data
change nor permission to replace the bundle. The narrowly scoped forward-only
catalogue diagnostic remains diagnostic evidence and does not promote the
observation into canonical data.

Observed identities are stored as receipt-backed service evidence by
game-system ID/revision and faction-catalogue ID/revision. Before New Recruit
or Tessera Web preparation, RosterPilot chooses the newest retained snapshot
that exactly matches the latest observation for the affected faction. If no
retained snapshot matches, the repair coordinator searches up to 500 relevant
commits in the persistent BSData history and may build a compatibility snapshot
from that exact commit plus the newest certified 40kdc rules source. It never
tests the service by creating a list. If the bounded history has no exact
identity, it preserves the roster and reports
`waiting-for-compatible-source`.

The durable journey exposes the recovery states `updating-local-data`,
`waiting-for-compatible-source`, `needs-data-review`, and `ready-for-web`.
Unchanged compatible rebases may proceed automatically. Semantic roster
changes always require review, and starting a successor Tessera Web job always
requires a separate confirmation. Hash-verified New Recruit artifacts may be
reused; mutation receipts are never deleted and uncertain imports are never
duplicated.

For Tessera Web, there is no reliable public semantic-data version to pin.
RosterPilot records any declared version as advisory, fetches and hashes the
bytes of every required same-origin script asset, and hashes normalized
player/opponent import snapshots containing the visible unit, weapon, profile,
and effect state. The deployment identity and import-semantic identity are
separate: new script bytes may leave the normalized import unchanged, while
unchanged script URLs can still serve different bytes. Missing asset bytes,
missing army snapshots, or unresolved effect toggles make the evidence
incomplete rather than silently reusing a prior identity.

These layers classify mismatches without inventing a universal upstream
version number:

- a changed bundle semantic, catalogue observation, roster/input snapshot,
  imported semantic snapshot, profile policy, capability envelope, or scenario
  contract is data/input incompatibility;
- a changed website script-byte digest or pinned local-engine identity is
  provider-deployment drift and requires fresh observation;
- a numeric local-versus-website disagreement is model drift only after the
  data/input identities match and the difference exceeds the retained
  sampling uncertainty and parity tolerance.

Version skew is therefore an issue when it changes or obscures one of these
bound identities, not merely because two services display different release
labels. Provider observations are append-only execution evidence; refresh and
rollback continue to affect only future snapshot leases.

## Compatibility and certification

Raw provenance determines which immutable bundle can reproduce a run.
`globalHash`, per-faction rules/entity hashes, mapping hashes, portfolio
hashes, and conflict hashes determine which rosters, exports, caches, and
expert reviews remain compatible.

- `provenance-only`: install without roster or certification invalidation.
- `mapping-only`: recheck affected export scopes without rerunning stress
  portfolios. A shared New Recruit game-system revision is recorded in each
  faction's mapping identity, so it may affect every export scope without
  becoming a gameplay or methodology change.
- `rules`: rebuild and certify affected factions and dependants.
- `methodology/global`: run all faction certification.
- `ambiguous/regressive`: quarantine the affected scope and retain its last
  verified shard. Unaffected scopes may advance only in a dependency-consistent
  snapshot accepted under one trust mode; clients never synthesize or trust an
  unverified mixture.

The replay from BSData
`419a80d35346cd9bf26d32f69b4a5df404beb95d` to
`21b4efa69d7212cb206fdcbf98aa606ee49f78a2` is a regression fixture. When its
semantic inventories match, it must classify as `provenance-only`, retain all
faction contracts, and leave the application checkout unchanged.

## Deployment prerequisites

Local CLI, MCP, agent, personal-plugin, and writable self-hosted Node surfaces
need only:

- Node.js, npm, and Git;
- writable application-support storage for jobs, immutable snapshots, the bare
  BSData cache, and retention references; and
- connectivity to the allowlisted upstream sources when checking or building
  an update.

Signing keys, a public-key registry, a bootstrap bundle, and a signed channel
are not local readiness requirements. Generated standalone MCP,
personal-plugin MCP, and LaunchAgent environments identify `local-source` mode
and machine-local support storage; they do not carry publisher credentials or
require a public channel. An offline machine remains usable from compiled data
or its newest locally verified archive.

Hosted `signed-channel` Next.js and Cloudflare surfaces instead need:

- one signed bootstrap bundle compatible with the application's engine-data
  schema;
- `ROSTERPILOT_DATA_CHANNEL_URL` pointing to the signed stable-channel
  document and immutable HTTPS bundle hosting;
- a shipped bootstrap manifest at
  `/data-bundles/bootstrap/manifest.json` with its declared shard paths, or
  `ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_MANIFEST_URL` pointing to the same
  immutable asset;
- a public-key registry at `/data-bundles/trusted-keys.json`, or
  `ROSTERPILOT_DATA_TRUSTED_KEYS_URL` pointing to it. Cloudflare and other
  hosted environments may instead provide the same public document as
  `ROSTERPILOT_DATA_TRUSTED_KEYS_JSON`;
- a configured durable archive adapter before persistent rollback and
  cold-start quarantine recovery are advertised. An explicitly ephemeral
  deployment must report that limitation.

The publisher additionally needs CI publication permission for the immutable
`data-bundles` branch, `ROSTERPILOT_DATA_SIGNING_KEY_ID`,
`ROSTERPILOT_DATA_SIGNING_PRIVATE_JWK`, and
`ROSTERPILOT_DATA_BUNDLE_BASE_URL`. The private JWK exists only in the CI
secret store; clients receive public keys, never signing material. Key
rotation publishes overlapping key IDs so existing clients can verify the
transition.

### Hosted/operator one-time signed-channel bootstrap

Hosted and release operators use the manual **Bootstrap signed roster data**
GitHub workflow when the trust registry and application bootstrap have not
been published yet. Local users do not run this workflow. It validates
that the signing key ID, private JWK, and explicit degraded-authority reason
are configured; derives only public key material; creates matching local and
hosted signed bootstrap assets; verifies them; and opens a reviewable pull
request. It never prints or commits the private key. Merging that pull request
triggers the freshness workflow, whose genesis path publishes a signed-v2
stable pointer at revision zero even when upstream provenance is unchanged.

Routine publication runs `data:publisher:check` first. The job fails with a
specific bootstrap/rotation instruction if its signing key is absent from the
checked-in registry or maps to different public material. This prevents a
publisher from creating a channel that installed clients cannot verify.

Catalogue mismatch recovery remains a consumer operation. A durable roster
journey may refresh, rebase, revalidate, and prepare a lineage-linked successor
Tessera Web job, but it cannot mutate the old frozen job or bypass trust. A
semantic roster or opponent change creates a review-required candidate; an
unchanged structural roster can become ready automatically. Starting the new
external job is always a separate confirmation.

Hosted Next.js routes and the Cloudflare Worker use the same portable
initializer. It reads release assets through same-origin fetch or the
Cloudflare `ASSETS` binding, verifies the bootstrap manifest and every shard
before activation, and starts the signed-channel check in the request
background. Cloudflare extends that work with `waitUntil`; standalone Next.js
uses its configured scheduler and otherwise reports request-driven refresh.
It does not import filesystem APIs. A missing channel may leave a verified
signed bootstrap active without refresh. If the public keys, bootstrap
manifest, or a shard are absent or invalid, no provider is installed and the
compiled release data remains active. Private signing keys are never accepted
by this runtime path.

Data-bundle operations do not call New Recruit. Refresh, activation, rebase,
rollback, retention, and quarantine must never create, replace, or delete
remote lists. Catalogue deployment lag blocks only affected export or
delivery scopes; it does not disable roster construction or unrelated
factions.
