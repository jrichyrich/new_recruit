# RosterPilot certification

RosterPilot certifies roster correctness and external interoperability as
separate capabilities. A faction can pass deterministic construction while
truthfully reporting that a selected New Recruit mapping is unavailable.

The reviewed contract is
[`data/certification-manifest.json`](../data/certification-manifest.json). It
pins all build-supported factions, point bands, connector capabilities,
mapping-conflict baselines, specialist cases, opponent postures, browser
fixtures, and faction-specific expert assertions. Routine bundle refreshes
carry capability-scoped evidence in the signed faction shards and do not
rewrite this reviewed bootstrap policy. A semantic rules, mapping, portfolio,
or connector change invalidates only its bound capability scope.
Each faction declares roster correctness, canonical New Recruit export,
credential-backed New Recruit delivery, Tessera preparation, and trusted
Tessera simulation independently. The bootstrap manifest still records raw
BSData, game-system, and official MFM provenance for audit and exact replay,
but raw provenance is not expert-review equivalence.

Reviewed `expertReview` entries use a schema-v2 semantic binding for one or
more capabilities: `roster-rules`, `mapping`, `portfolio`, and `connector`.
The checked-in bootstrap policy records pending scopes and human assertions;
it does not churn by serializing generated current-data bindings. Signed
bundle shards carry the current capability evidence, and a reviewer-approved
entry binds to those actual runtime faction/entity hashes. Each capability
hash covers only its executable faction contract and relevant policy. Set-like
arrays are normalized before hashing, so formatting, harmless ordering, or
provenance-only source movement does not discard an approval. A semantic
change outside the entry's declared `capabilityScopes` does not invalidate it.
If any included capability hash changes, that review entry returns to pending
so the reviewer cannot accidentally carry its assertions across changed
semantics.

A `reviewed` entry is valid only when that binding matches the current
manifest. Manifest synchronization changes a stale approval to `pending`,
records `binding-mismatch`, and retains its assertions as drafts for a new
expert review. Legacy reviewed entries without a binding are likewise
`pending` with `unbound-legacy`; they are never grandfathered into a pass.
Pending bindings are deliberately not serialized into the reviewed policy
manifest. Run deterministic certification for the faction and take the exact
current `reviewBinding` and `semanticEvidence` from the
`CERTIFICATION_EXPERT_REVIEW_PENDING` case. After checking that evidence and
the draft assertions, a Warhammer reviewer copies that binding into the
faction's `expertReview`, sets a new `reviewedAt`, explicitly changes the status
to `reviewed`, and removes any `invalidationReason`. Then run
`npm run certify:manifest:check` and deterministic certification again. Only a
completed reviewed attestation remains serialized; generated pending evidence
continues to live in the signed faction shard and certification report.

Representative roster contracts are golden, not point-band smoke tests. Each
1,000- and 2,000-point entry pins its detachment, Warlord unit ID, canonical
unit/model multiset, structural fingerprint, and execution fingerprint to the
declared semantic roster and export identities. Raw BSData/MFM provenance is
retained alongside that evidence but does not independently invalidate it.
Export-capable entries also pin the exact canonical ROSZ SHA-256. A legal
roster that changes selection still fails with a
structured `CERTIFICATION_GOLDEN_*_DRIFT` code; a changed archive fails with
`CERTIFICATION_GOLDEN_ROSZ_SHA256_DRIFT`. Legacy entries without complete
golden evidence remain readable but report
`CERTIFICATION_GOLDEN_CONTRACT_PENDING` as degraded and can never pass.
`npm run certify:manifest:sync` deliberately regenerates this evidence, so its
diff must be reviewed as a data or roster-policy change rather than accepted
as formatting churn.

## Certification tiers

Run the deterministic tier without browsers or external mutations:

```bash
npm run certify -- --tier deterministic
```

Use `--faction aeldari` for one faction or `--shard 1/4` through `4/4` for
parallel coverage. `--changed-only` emits an explicit skipped result when no
roster, data, connector, transport, workflow, or test surface changed.
`--portfolio` adds the selected factions' browser-free `core-3` preparation
contracts without expanding to every ordered matchup.
`--opponent-matrix` adds every ordered selected-player/opponent faction
combination using local `core-3` portfolio previews.
`--portfolio` runs the same core and named-specialist gates once per selected
faction without expanding to the ordered opponent matrix; data-update staging
uses this deterministic, browser-free gate.

`core-3` always means three unique, exportable payloads representing balanced,
ranged, and assault postures. The `mixed`, `mass`, and `elite-heavy` wire
labels are evaluated with faction-relative ranges bound to the portfolio
methodology hash over model density, points per model, unit-type share,
selected-weapon pressure, mobility, and concentration. Generated ranges are
explicitly pending until expert review is rebound to the current faction and
portfolio semantic hashes. The manifest separately
records expert-reviewed not-applicable exceptions; pending assertions never
authorize degraded coverage.

Named-character coverage is a separate specialist case. An unavailable named
specialist may degrade that specialist result, but it cannot reduce a complete
three-posture core portfolio. A reviewed `not-applicable` result remains
explicit in the report.

The connector tier executes the complete registered browser-fixture contract
on a macOS Chrome worker. It does not contact New Recruit or Tessera: the
browser routes are fulfilled by the local recorded fixture pages.

```bash
npm run certify -- --tier connector
```

Certification selects the exact `node:test` names registered in
`data/certification-browser-fixtures.json`, runs each unique test once, and
writes a hash-verifiable execution-evidence artifact containing the frozen
registry entries, source hashes, normalized JUnit observations, runner
identity, and output hashes. A skipped, missing, ambiguous, failed, timed-out,
or interrupted fixture fails the connector report. Merely naming a fixture in
test source is not evidence that it ran.

The live tier reports real delivery and simulation evidence separately; it
does not rerun the recorded fixture suite for every daily or weekly faction
shard.

The live tier creates run-scoped external lists and therefore needs both an
explicit tier and an environment guard:

```bash
ROSTERPILOT_CERTIFICATION_LIVE=1 \
  npm run certify -- \
  --tier live \
  --faction adeptus-custodes \
  --profile-policy profiles.json \
  --out-dir .certification/live/adeptus-custodes
```

Live certification builds and validates first, prepares the selected faction's
browser-free core-3 posture portfolio, obtains one verified enriched New
Recruit archive or reuses its hash-verified cache, and then requires all 16
full-mode Tessera scenarios. That matrix is explicitly a renamed-mirror
browser/control canary; it is not opponent-posture evidence. Unsupported
export, delivery, and trusted-simulation capabilities have distinct codes and
stop before their respective external mutation. An imported-but-unverified New
Recruit outcome is marked uncertain and is not considered retryable.

The renamed-mirror tier remains useful for broad connector certification, but
it does not satisfy any of the source-backed matchup canaries below. In
particular, renaming a copy of the player archive is never evidence for a
distinct-faction exact matchup.

`--profile-policy <path>` accepts the canonical v1 Tessera policy format. The
source and canonical hashes are frozen into the report, while the policy
artifact itself is copied into the bundle. After New Recruit enrichment,
certification compares the complete pinned and enriched profile inventories,
scopes the policy to the exact roster, and validates it before Tessera opens.
Missing decisions return `TESSERA_PROFILE_POLICY_REQUIRED` with a safe
run-scoped scaffold. Pinned/enriched disagreement returns
`TESSERA_ENRICHED_PROFILE_INVENTORY_MISMATCH`; it cannot be repaired by
inventing a weapon choice.

Use `--resume <certification-report.json>` to retain completed faction stages.
Resume requires the same tier and manifest hash. A resume verifies the prior
build fingerprint and bundle-relative enriched artifact before reuse, then
falls back only to the hash-verified persistent cache. It never redelivers to
New Recruit. Missing or corrupt prior evidence fails closed. The original
mutation, the new reuse event, and earlier failed profile-policy attempts
remain in durable history. A changed policy invalidates prior live Tessera
completion and requires a new simulation against the verified prepared
artifact. Reports use bundle-relative paths, include a detached SHA-256
checksum, and retain runtime, local-agent, data-pin, UI, policy, artifact,
failure, and connector-event provenance.

Coverage remains separate by faction, workflow, detachment, observed unit
role/category, specialist contract, structured failure mode, and recorded
browser fixture. Listing a legal detachment as metadata does not count as
executing it. Specialist requirement and evidence keys are faction-qualified,
so one faction cannot satisfy another faction's contract. A named-character
specialist is removed from the required set only for an expert-reviewed
`not-applicable` judgment; `required` and `review-pending` remain visible
requirements. Missing intended detachment or specialist evidence caps the
result at degraded, as does any report where fewer factions pass than were
intended.

Live certification also opts into deterministic Tessera saved-list identities.
Each visible name is a safe digest of the run, side, exact enriched archive,
scoped profile policy, and roster execution fingerprint. Before importing,
RosterPilot checks only the semantically labeled army selectors and reuses a
list only when exactly one matching identity has the expected unit count and
stable option value. A missing side is imported at most once; duplicate,
truncated, or unit-count-mismatched identities fail closed. The chosen
reuse/import action is retained in Tessera evidence, and the browser session
is isolated by run and faction.

Certification mirror archives use sorted ZIP entries and a fixed ZIP timestamp,
so the same verified player archive and run name produce identical opponent
bytes and a stable content hash across processes. Run-scoped Tessera browser
profiles use `0700` permissions and survive graceful local-agent restarts for
up to seven days. Restart closes the credential-bearing worker and context but
does not delete saved-list state; explicit session close and expiry still
remove the profile. Browser state is never copied into certification artifacts.

Self-hosted live workflows can set the repository variable
`ROSTERPILOT_CERTIFICATION_PROFILE_POLICY_PATH` to a runner-readable policy
file. Leaving it unset is intentionally fail-closed for a roster that exposes
alternate profiles; the resulting bundle contains the scaffold needed for a
reviewed rerun.

## Rotating source-backed live canaries

After the daily data-freshness workflow completes successfully, one
post-activation workflow routes three named canaries through the durable
Tessera job coordinator. The independent weekly schedule runs only the broader
rotation, so the named daily canaries are not duplicated. These are separate
from deterministic fixture acceptance and from
the renamed-mirror faction certification tier:

| Canary | Required live evidence |
| --- | --- |
| `custodes-vs-adaptive-nine-aeldari-2000` | One frozen, complete adaptive-nine Aeldari portfolio; nine execution-distinct proxies across all three postures; a forced client-timeout boundary; same-run resume; nine screening runs; three representative deep dives; no duplicate New Recruit delivery; portable hash-verified artifacts |
| `death-guard-vs-orks-exact-1000` | Two independently built, points-matched canonical rosters from different factions and a complete exact Tessera scenario contract; a renamed mirror cannot satisfy this canary |
| `uploaded-multiprofile-exact-paired-revision` | A locally inspected uploaded ROSZ with at least one explicit alternate weapon-profile decision, matching canonical opponent context, a complete exact baseline, and a paired revision that preserves opponent, policy, scenario, source-pin, and Tessera UI evidence |

### Provider-compatibility observe-then-enforce rollout

The core live rotation is the three named canaries above. Each report retains
`providerCompatibility` separately from its legacy live result: the fixed
`observe-then-enforce-v1` policy, the required streak of three rotations, a
pass/fail/unavailable status, and the content hash, provider, completeness,
and issue codes for every compatibility envelope it observed. This keeps
missing provider identity visible without retrospectively turning an otherwise
honest pre-rollout simulation report into a claimed compatibility pass.

A rotation qualifies only when all required canary IDs appear exactly once,
each canary itself passes, every required provider-compatibility envelope is
complete, and every envelope has a valid SHA-256. A complete envelope includes
the verified signed-manifest hash and signing-key ID, the active/latest
verified update-provider identities, the signed bundle semantics, canonical
roster and prepared-input hashes,
New Recruit pinned/observed catalogue evidence where applicable, exact
provider identity, Tessera Web script-byte and import-semantic evidence,
profile-policy identity, and deterministic scenario-contract identity.
Unresolved website effect toggles, a missing semantic snapshot, or a declared
version without the underlying asset bytes is incomplete evidence.

Rollout begins in observation mode. A successful rotation advances the
consecutive streak; a failed rotation resets it. An unavailable rotation does
not pretend to be a pass and does not advance the streak, but before
enforcement it also does not erase already observed passes. Duplicate rotation
IDs are rejected. After three consecutive complete passing rotations, the
workflow creates the one-way repository tag
`rosterpilot-provider-compatibility-enforced-v1`. That tag is the durable latch;
it does not depend on expiring Actions artifacts and no workflow removes it.
Every subsequent canary freezes `providerCompatibilityMode=enforce`, and the
application-release gate reads the tag independently. Once latched, missing
history, a latest observation-mode rotation, a failure, or an unavailable
rotation blocks a new release. The first enforced rotation is therefore
required after activation before another release can pass. An outage does not
silently disable enforcement and, by itself, cannot authorize rollback of the
active bundle.

The envelope's bundle-trust digest is computed from the activated
`VerifiedDataBundleManifestV1` and current `DataBundleProvider` status. It
includes the manifest/signature identity, active and latest verified bundle
IDs, upstream/candidate/quarantine/rollback state, official-authority identity,
and durability state. Roster source hashes without that verified runtime proof
remain incomplete evidence; compiled-unverified data cannot satisfy this gate.

Local-versus-website numerical parity is a second gate after compatibility.
Both reports are adapted to one normalized combat contract and must agree on
the bundle, roster input, profile policy, scenario contract, model-capability
envelope, and provider-neutral unit/weapon/effect snapshot. Per-cell sample
count, variance, and standard error are retained so tolerances include Monte
Carlo uncertainty. Each metric still requires at least 98% of comparable cells
within tolerance, no cell may exceed twice its tolerance, and the shared
probability-pressure winner must agree outside its uncertainty boundary.
Deterministic fixtures include effect- and profile-sensitive Witchseekers,
Troupes, Farseers, and Shroud Runners, but fixture success is not live parity or
promotion evidence.

### Live numerical parity gate

After producing the paired comparison, certify it with the original exact
reports available under one portable reports root:

```bash
npm run certify:provider-parity -- \
  --comparison paired/comparison/tessera-provider-parity.json \
  --reports-root paired/reports \
  --rotation-id <workflow-run-id> \
  --expected-bundle-id <64-character-bundle-id> \
  --expected-git-head <40-character-commit> \
  --out paired/certification/live-numerical-parity.json
```

The comparison directory must contain
`tessera-provider-parity.json.sha256`. The reports root may have nested
directories, but it must contain exactly one copy of each bound exact report
and that report's adjacent `*.receipt.json`. Discovery ignores the portable
filename as authority: it selects by the comparison's report SHA-256, run ID,
and provider, and rejects missing, duplicated, symlinked, oversized, or
receipt-mismatched evidence. The gate then independently rebuilds both parity
runs and the comparison result.

The command writes a strict schema-v1 certification JSON and adjacent
`.sha256`. Its result is one of `pass`, `fail`, `incomplete`, `ineligible`, or
`unavailable`; eligible-but-incomplete sampling evidence is not collapsed into
data/input drift. A pass requires real production runtime evidence from both
providers, verified signed-bundle trust, complete Tessera Web deployment,
import semantics and selected-state bindings, all four canonical metrics at
98% or better, zero cells beyond twice tolerance, and canonical-winner
agreement outside uncertainty. Recorded or fixture-shaped evidence is always
ineligible.

The distinct-faction `death-guard-vs-orks-exact-1000` live canary is the paired
producer. It runs the frozen exact scenario once through each provider,
preserves the comparison JSON/checksum and both exact reports/receipts, and
binds the certificate to the workflow rotation, expected signed bundle, and
checked-out git commit. A stale bundle or commit is `ineligible`, even when the
numeric cells would otherwise pass.

Numerical parity has its own observation history and one-way latch, separate
from provider compatibility:

```bash
npm run certify:provider-parity-rollout -- \
  --reports-root .certification/provider-parity-input \
  --enforcement-latch observe \
  --current-rotation-id <workflow-run-id> \
  --out .certification/provider-parity-output/live-numerical-parity-rollout.json
```

Three consecutive checksum-verified live pass certificates activate the
durable `rosterpilot-live-numerical-parity-enforced-v1` tag. Before activation,
the rollout is observational. `unavailable` neither advances nor resets the
streak; an available `fail`, `incomplete`, or `ineligible` certificate resets
it. After activation, callers pass `--enforcement-latch enforce` (and live
runtimes use `ROSTERPILOT_LIVE_NUMERICAL_PARITY_ENFORCED=true`); missing or
current non-pass evidence blocks release. The workflow always supplies
`--current-rotation-id` so a retained historical pass cannot stand in for the
current certificate. A detached checksum establishes integrity but not live
provenance, so every claimed passing certificate is also freshly rebuilt from
the comparison, exact source reports, and receipts under `--reports-root`
before it enters history. Duplicate rotation IDs and invalid certificate or
rollout checksums fail closed.

Every observed rotation uploads the raw paired bundle and certificate as
`live-numerical-parity-evidence-<run-id>`, plus the independently checksummed
history as `live-numerical-parity-rollout-<run-id>`. Observation-mode failures
remain downloadable instead of failing the workflow solely because parity has
not passed. Once the latch exists, application release accepts only the
explicit `live_numerical_parity_run_id` dispatch input. It verifies that this
is a successful `certification-live.yml` run on the default branch at the
exact release commit, resolves exactly one unexpired evidence and rollout
artifact from that run, derives the prepared release bundle ID itself, and
reruns both the raw numerical gate and enforced rollout gate against that
bundle and commit. Operators do not supply a checksum, bundle ID, or commit
claim by hand.

Use the classification in the compatibility report when triaging a failure.
A changed or incomplete bundle/catalogue/import/profile/scenario identity is
data or input drift. Changed website script bytes or a changed pinned local
engine are provider-deployment drift. Only a tolerance or winner disagreement
between otherwise compatible normalized runs is model drift. Do not repair
model drift by adopting New Recruit or Tessera observations as canonical rules
data; update the signed bundle only through the normal reviewed data pipeline.

Run one canary directly with:

```bash
ROSTERPILOT_CERTIFICATION_LIVE=1 \
ROSTERPILOT_CERTIFICATION_PROFILE_POLICY_PATH=/path/to/canary-policy.json \
ROSTERPILOT_DATA_CHANNEL_URL=https://data.example.test/channels/stable.json \
  npm run certify:canary -- \
  --canary custodes-vs-adaptive-nine-aeldari-2000 \
  --expected-bundle-id <64-character-bundle-id> \
  --out-dir .certification/live-canaries \
  --require-live
```

Live canaries reject catalogue drift by default. An operator may add
`--verified-catalogue-drift-diagnostic` only for an explicitly authorized
diagnostic through a newer game-system revision. The durable request freezes
that choice and still requires complete provenance, exact faction-catalogue
identity, and complete per-unit Unit and weapon profiles; it is not a general
catalogue-drift override.

The uploaded-roster canary also requires four runner-local fixture paths:

```text
ROSTERPILOT_CANARY_MULTIPROFILE_ROSZ_PATH
ROSTERPILOT_CANARY_MULTIPROFILE_CONTEXT_PATH
ROSTERPILOT_CANARY_PLAYER_ROSTER_PATH
ROSTERPILOT_CANARY_REVISED_ROSTER_PATH
```

The context, player, and revised files are current canonical roster JSON. The
baseline and revised player rosters must have distinct execution fingerprints,
while all three canonical rosters must share the edition, release, and points
contract. The ROSZ must match the opponent context's faction, units, models,
points, and embedded catalogue identity. The same canary-specific profile
policy must exactly resolve both the baseline and revision inventories.
The configured source policy may cover the whole rotation; before mutation the
runner writes and hashes an exact canary-scoped subset, then freezes that file
inside the durable job.

Readiness is local-first and performs no New Recruit or Tessera mutation. A
bundle-bound release canary may verify and activate its expected signed bundle
before acquiring the immutable snapshot lease. The runner then checks the live opt-in,
macOS runtime, current local-agent build and protocol, Chrome, Keychain broker,
New Recruit readiness, Tessera licence readiness, profile policy, and required
fixtures before starting a durable job. An absent credential, policy, browser,
or fixture produces a structured `unavailable` report with `livePass: false`.
`--require-live` makes that outcome fail the workflow. A configured but invalid
fixture or policy is also unavailable; a portfolio, execution, provenance, or
analytical assertion failure is a failed canary. Neither outcome is reported as
a live pass.

Every attempt writes a JSON report and detached SHA-256 file. A live pass
requires every definition assertion to pass from real connector receipts.
Reports retain the durable run ID and manifest path so an interrupted external
client can inspect or resume the job. The Custodes/Aeldari canary deliberately
stops its own client wait briefly, verifies that `resume` returns the same
active run and attempt, and only then follows the background job to completion.
The canary never deletes the New Recruit lists it creates or reuses.

Release and post-activation runs must pass `--expected-bundle-id`; an ad-hoc
diagnostic without it cannot count as release evidence. The runner refreshes
and activates that exact signed bundle, holds one snapshot lease for the whole
canary, and records the bundle ID, signing-key ID, manifest hash, and semantic
identity in its report. A missing, different, or mid-run-changing bundle stops
the canary before it can count as evidence for that release.

After all three reports are uploaded, the workflow runs
`data:rollback-after-canary`. The publisher requires all three detached
checksums, exact bundle bindings, the current signed stable pointer, both the
failed and predecessor signed manifests, and every shard hash. Only an actual
live `fail` can authorize rollback; missing, unavailable, duplicated,
tampered, stale, or concurrently superseded evidence fails closed. A rollback
signs an immutable quarantine receipt containing the exact report hashes,
then writes the informational update receipt, and moves the newly signed
stable pointer last. The immutable receipt is published at
`quarantines/<failedBundleId>.json`. Later refreshes verify that receipt and
reject the same quarantined semantic identity. An `unavailable` canary cannot
authorize rollback and cannot be combined with a different failure to make an
incomplete rotation sufficient. No part of this operation replaces or deletes
a New Recruit list.

`tests/release-acceptance-custodes-aeldari.test.ts` and
`tests/live-canaries.test.ts` remain deterministic fixture acceptance. They
prove portfolio, routing, timeout/resume, report, and unavailable-state
behavior without credentials. Their success is not a live certification pass
and must never be presented as one.

## Fixture recording

Connector recordings must be sanitized before they enter `tests/fixtures/`:

```bash
npm run fixtures:record-connector -- \
  private-recording.json \
  tests/fixtures/connector/sanitized-recording.json
```

The recorder hashes roster identities and remote URLs, redacts credential-like
fields, removes home-directory identities, and rejects login-page captures.
Never record credentials, cookies, browser storage, premium keys, or login
screens. New Recruit UI provenance is only a SHA-256 over the authenticated
origin, declared version, and normalized script sources; those raw browser
values are not stored in reports.

## Release gates and cadence

- Pull requests run the full deterministic faction set in four shards and the
  recorded browser suite on macOS.
- A daily self-hosted serial rotation runs the three source-backed canaries
  above when `ROSTERPILOT_LIVE_RUNNER_ENABLED` is configured. Missing
  credentials or fixtures remain explicit unavailable failures under
  `--require-live`.
- The weekly self-hosted rotation shards all factions; declared unsupported
  capabilities remain visible and create no remote list.
- The release workflow adds the complete ordered local opponent matrix and
  first runs `npm run verify`, then runs the inexpensive distinct-faction exact
  Tessera canary against the exact signed bundle on the credential-bearing
  self-hosted Mac. That release smoke uses the explicitly frozen forward-only
  catalogue diagnostic and writes its report under ignored `.certification/`
  storage for upload as a workflow artifact. Only after both gates pass does
  the workflow run the matrix with `--require-status pass`; pending expert
  review or any other degraded result therefore blocks release even when no
  product assertion failed.
- `npm run certify:trend -- --input <reports> --out <trend.md>` aggregates pass
  rate, latest faction state, mapping conflicts, mutation/reuse counts, and
  uncertain outcomes.

Trend ingestion is fail-closed: every discovered report must pass the complete
strict report schema and match its detached `.sha256` file. Missing, malformed,
schema-invalid, or hash-mismatched inputs stop aggregation instead of silently
disappearing. The trend renders roster correctness, New Recruit export, New
Recruit delivery, Tessera preparation, and trusted Tessera simulation as five
independent states. A mixed pass/unsupported live result is a capability
boundary, never a successful live check. Case pass rates include pass, fail,
degraded, and unsupported outcomes in the denominator; only explicit skipped
cases are excluded.

A report is failed by any product assertion failure. Expected upstream
capability boundaries and pending expert review make the report degraded
rather than successful-looking. An uncertain external mutation, mapping
regression, stale runtime, incomplete Tessera scenario set, or misleading
status is release-blocking.

New Recruit mapping support and portfolio breadth are classified separately.
Only a missing New Recruit configuration is `unsupported`; an export-capable
faction that cannot produce enough distinct posture proxies is a portfolio
coverage failure or degradation. Manifest synchronization converts a newly
export-capable faction to provisional `degraded` until its posture contract is
reviewed, rather than preserving a stale `unsupported` declaration.
