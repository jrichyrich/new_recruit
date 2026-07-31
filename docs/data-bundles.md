# Signed semantic data bundles

RosterPilot updates runtime data independently from application releases.
Games Workshop publications are authoritative where they can be verified
directly, 40kdc-data supplies structured game content, and BSData supplies New
Recruit catalogue identities and selection paths. A bundle records all three
provenance sources, but compatibility is decided by semantic hashes rather
than release labels or Git commits.

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

## Release pipeline

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
provenance-only by assumption. The candidate must include a schema-v1 official
rules overlay, exact downloaded source artifact, and independently signed
extraction receipt whose source version and SHA-256 match the candidate Games
Workshop publication:

```bash
npm run data:prepare-update -- \
  --official-reconciliation-evidence /absolute/path/official-overlay.json \
  --official-source-artifact /absolute/path/official-source \
  --official-extraction-receipt /absolute/path/official-receipt.json
```

The release verifier hashes the actual source bytes, recomputes normalized
payload hashes and stable entity keys for every scope, requires exact
one-to-one inventory coverage, binds the exact overlay bytes, and verifies the
receipt's Ed25519 signature against
`data/official-extractor-trusted-keys.json`. Merely setting an overlay count
equal to an array length cannot authorize publication. The overlay is then
parsed by the engine, applies official points, leader links,
Detachment Points/Force Dispositions, and enhancement points over community
data, and records conflicts as explicit official overrides. Missing,
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
<downloaded-source> --receipt <signed-receipt>` before passing all three files
to the release command. The check verifies the exact source bytes, normalized
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

The external extractor emits the schema-v1 overlay plus a separate schema-v1
receipt. Its unsigned receipt payload contains the official version, URL,
source byte length and SHA-256; extractor ID and version; the exact overlay
SHA-256; issue time; and, for each of `unitPoints`, `leaderLinks`,
`detachments`, and `enhancementPoints`, a status, sorted
`sourceEntityKeys`, and normalized payload SHA-256. Entity keys are
`<factionId>:<unitId>`, `<factionId>:<leaderId>`,
`<factionId>:<detachmentId>`, or `<factionId>:<enhancementId>` as appropriate.
Duplicate keys are invalid. The payload is signed as canonical JSON with
Ed25519 and the receipt adds `{algorithm, keyId, value}` under `signature`.

Extractor implementations should use
`createOfficialExtractionReceiptDraft` from
`lib/rosterpilot/official-data.ts` to produce the canonical unsigned payload,
then sign that exact canonical JSON in the separately controlled extractor
environment. The helper neither grants trust nor accesses a private key;
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

Every surface uses the same provider contract. It checks the signed stable
channel on startup. Long-lived runtimes schedule a check every 15 minutes;
request-driven runtimes also check when that interval is due on the next data
operation. Stable-channel refresh does not block a build after bootstrap
initialization. A first hosted request may still load same-origin release
assets, or an explicitly configured external bootstrap, before it can lease a
snapshot. The provider downloads a candidate,
verifies the stable pointer, manifest signature, schema, and every payload
hash, then moves the local active pointer atomically only after validation.

Use the same sequence through MCP, CLI, REST, or the local agent:

1. Read engine provenance with `get_data_status`, then call
   `get_data_update_status` to distinguish `activeBundleId`,
   `latestVerifiedBundleId`, `latestUpstreamBundleId`, the candidate
   classification, quarantined scopes, and `officialAuthority`. The latter is
   `verified` with source/overlay/receipt hashes and extractor IDs, or is
   explicitly `unavailable`/`unverified-overlay` with a reason.
2. Use `refresh_data_now` only when an immediate signed-channel check is
   requested. The CLI equivalent is `rosterpilot data refresh`.
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

If no runtime provider, trusted key, channel, or network is available,
construction continues from compiled application-release data. Status reports
that fallback instead of claiming that an unsigned or unverified payload is a
verified bootstrap. When a signed bootstrap was successfully verified before
the channel became unavailable, status retains that exact verified identity.

Each data-consuming request acquires one immutable snapshot lease. Status,
refresh, and rollback are control-plane operations and intentionally do not
acquire a roster-data lease. Activation still waits for existing leases and
therefore affects only data-consuming requests that begin afterward. Durable Tessera jobs
record their exact `bundleId` and reacquire that archived snapshot on resume;
they never mix simulation evidence across bundles. Moving a job to current
data requires a new run or an explicit compatible roster rebase.

The local store retains the active bundle, the previous three bundles, every
bundle with a registered roster or durable-job reference, and unreferenced
bundles for at least 30 days. Integrity failures block garbage collection
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

## Compatibility and certification

Raw provenance determines which immutable bundle can reproduce a run.
`globalHash`, per-faction rules/entity hashes, mapping hashes, portfolio
hashes, and conflict hashes determine which rosters, exports, caches, and
expert reviews remain compatible.

- `provenance-only`: publish without roster or certification invalidation.
- `mapping-only`: recheck affected export scopes without rerunning stress
  portfolios. A shared New Recruit game-system revision is recorded in each
  faction's mapping identity, so it may affect every export scope without
  becoming a gameplay or methodology change.
- `rules`: rebuild and certify affected factions and dependants.
- `methodology/global`: run all faction certification.
- `ambiguous/regressive`: quarantine the affected scope and retain its last
  verified shard. Unaffected scopes may advance only in a dependency-consistent
  bundle signed by the publisher; clients never synthesize or trust an
  unsigned mixture.

The replay from BSData
`419a80d35346cd9bf26d32f69b4a5df404beb95d` to
`21b4efa69d7212cb206fdcbf98aa606ee49f78a2` is a regression fixture. When its
semantic inventories match, it must classify as `provenance-only`, retain all
faction contracts, and leave the application checkout unchanged.

## Application deployment prerequisites

Every production surface needs these common inputs before runtime refresh is
advertised:

- one signed bootstrap bundle compatible with the application's engine-data
  schema;
- at least one pinned Ed25519 public verification key and key ID;
- `ROSTERPILOT_DATA_CHANNEL_URL` pointing to the signed stable-channel
  document;
- immutable HTTPS bundle hosting in production.

Local CLI, MCP, agent, and worker surfaces additionally need:

- the public registry in `data/data-bundle-trusted-keys.json`, or an equivalent
  file selected with `ROSTERPILOT_DATA_TRUSTED_KEYS_FILE`;
- a bootstrap directory selected with
  `ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_DIRECTORY`, unless the application-release
  default is present;
- a writable application-support bundle store. Setup persists these non-secret
  paths and the channel URL for the local MCP and agent runtime.

Hosted Next.js and Cloudflare surfaces instead need:

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
