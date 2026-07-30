# Live-run postmortem: Death Guard vs unknown Orks

Date: 2026-07-29  
Pinned rules release: `2026-07-28.1`  
Verified run: `f23c81be-7e3d-437d-9743-f99028b764d9`  
Final status: **COMPLETE WITH REVIEW-GRADE EVIDENCE**

## Outcome

RosterPilot built a legal, exportable 1,000-point Death Guard roster, prepared
three deterministic Ork coverage proxies, and completed screening plus
deep-dive analysis in Tessera.

The verified report records:

- `status: complete`
- `preparation: complete`
- four unique New Recruit receipts, zero new remote mutations, and four reuses
- 48 trusted Tessera metric matrices
- 24/24 comparable Shooting/Fight hash pairs with distinct content
- verified report and content-addressed ROSZ hashes
- complete quantitative coverage across all three proxies
- `evidenceConfidence: review`, because retained Tessera import warnings cap
  the evidence below high confidence

This is directional unit-to-unit combat evidence, not a game win probability.
Terrain, movement, mission scoring, deployment, sequencing, player decisions,
and unmodeled rules remain outside the result.

## Frozen Death Guard roster

Detachment: Paragons of Putrescence  
Force disposition: Priority Assets

- Daemon Prince of Nurgle with Wings — 170 points — Warlord
- Deathshroud Terminators, 6 models — 305 points
- Chaos Spawn, 2 models — 80 points
- Chaos Spawn, 2 models — 80 points
- Chaos Land Raider — 220 points
- Chaos Predator Destructor — 145 points

Total: **1,000/1,000 points**

Deathshroud Terminators remained a required selection throughout repair.
Defiler and the other frozen exclusions remained excluded. No automatic
post-simulation roster change was applied.

## Frozen Ork proxy portfolio

The proxy lists are deterministic coverage cases, not claims about the current
Ork metagame.

1. `balanced-control:elite-heavy` — 1,000 points, 10 models:
   Ghazghkull Thraka (2/235), Killa Kans (6/240), Gargantuan Squiggoth
   (1/440), and Rukkatrukk Squigbuggy (1/85).
2. `ranged-pressure:mass` — 985 points, 42 models:
   Beastboss on Squigosaur (1/95), three Beast Snagga Boyz units (11/170
   each), Killa Kans (4/240), and Deffkoptas (4/140).
3. `assault-pressure:mass` — 1,000 points, 76 models:
   Beastboss on Squigosaur (1/95), three Beast Snagga Boyz units (20/170
   each), Deffkoptas (4/140), Stormboyz (10/130), and Hunta Rig (1/125).

## What the Tessera evidence says

Equal proxy weights were used for coverage, not as estimates of list
frequency.

| Ork proxy | Death Guard offensive coverage | Threat exposure | Coverage margin |
| --- | ---: | ---: | ---: |
| Balanced elite-heavy | 8.5% | 69.5% | -61.0% |
| Ranged mass | 75.6% | 16.0% | +59.6% |
| Assault mass | 87.5% | 16.0% | +71.5% |

The roster is therefore much better into mass Ork bodies than into the
Ghazghkull/Killa Kan/Gargantuan Squiggoth elite package.

Notable unit findings:

- Deathshroud Terminators supplied meaningful half-wipe coverage across all
  three proxies and were the broadest reliable answer.
- The Land Raider was a narrower answer. In the deep dive it had a 61%
  modeled full-wipe chance into the Rukkatrukk Squigbuggy in Shooting.
- The Daemon Prince had a 61% modeled full-wipe chance into the Squigbuggy in
  Fight.
- Both Chaos Spawn units were materially exposed in all three proxies.
- Ghazghkull, the Gargantuan Squiggoth, Killa Kans, and Beast Snagga Boyz all
  produced serious Fight-phase threats. The Squiggoth also threatened the
  Land Raider and Predator.

Two legal, non-automatic follow-up candidates were retained:

- Replace the Predator Destructor with a Foetid Bloat-Drone with Heavy Blight
  Launcher, producing a 980-point roster.
- Replace it with a Predator Annihilator, producing a 990-point roster.

Both candidates preserve the required Deathshroud selection and every
exclusion. They are hypotheses for another paired test, not recommendations
proven by this run.

## Failure chronology and repairs

### 1. Profile decisions failed closed before mutation

The first simulate request omitted an explicit alternate-profile policy and
stopped with `TESSERA_PROFILE_POLICY_REQUIRED`. This was correct: the workflow
did not guess Strike/Sweep choices.

### 2. Enriched New Recruit data contradicted the pinned Defiler inventory

The first prepared run stopped at
`TESSERA_ENRICHED_PROFILE_INVENTORY_MISMATCH`: New Recruit did not expose the
Defiler Shearing claws choice expected by the local profile inventory.
Defiler was removed from this acceptance roster rather than inventing data.

### 3. Deathshroud split subgroups broke the Tessera profile editor

The next run reached Tessera but failed because the automation assumed one
flat Manreaper group. Occurrence-aware policy identity and model-subgroup
counts were implemented so the six-model Deathshroud unit could select the
frozen profile without flattening its editor structure.

### 4. New Recruit artifacts were recreated across runs

The early delivery cache was not recovered across output directories, so the
first two prepared attempts created eight remote New Recruit lists in total:
two Death Guard revisions and two sets of three unchanged Ork proxies.

The cache was changed to use execution/data identity and persistent verified
receipts. Manifest-seeded and persistent reuse now carry an explicit
`cacheReused` signal. Every child and aggregate report in the verified run
shows zero mutations; the final acceptance reruns created no additional New
Recruit lists.

Existing remote copies were not deleted.

### 5. The browser trusted the wrong saved-list surface

The automation initially required a run-scoped saved name on Tessera's Roster
page even though the authoritative identities were present only in the Army
Matrix selectors. That false gate was removed.

The live selector labels also include a leading `☰` glyph and use stable
values shaped as `list:<name>`. Exact-name matching originally rejected these
valid options. Selector normalization now removes only Tessera's presentation
glyph/count suffix, verifies exact run-scoped name plus unit count, and checks
the stable selected value.

### 6. A complete-looking run reused Shooting matrices for Fight

This was the most serious defect. Tessera's phase button changes UI state, but
the matrix is recomputed only after `Compare lists`. Metric/direction changes
were mutating the table and falsely satisfying the old generic DOM watch, so
every Fight hash matched its Shooting counterpart while the run reported
complete.

Phase changes now:

1. select and verify the phase;
2. require one visible, enabled `Compare lists` action;
3. arm a fresh matrix-scoped watch;
4. click Compare and require a matrix refresh;
5. only then change metric or direction.

The verified run has 24 comparable phase pairs and all 24 are distinct. A
melee-only Chaos Spawn correctly changes from zero Shooting damage to nonzero
Fight damage.

The tainted complete-looking artifact was preserved as failure evidence and is
not the acceptance report.

### 7. A change candidate violated hard constraints

An intermediate report proposed replacing required Deathshroud Terminators
with excluded Defiler. Candidate construction and qualification now preserve
the complete frozen constraint object, required/excluded units, named and
Legends restrictions, collection scope, and required Warlord. Reports also
serialize those constraints for audit.

### 8. Report metadata overstated or contradicted the evidence

The report audit found and repaired several independent defects:

- manifestation reuse was counted as a remote mutation in first-stage child
  reports;
- archetype-risk findings listed every proxy instead of only exposing proxies;
- every contributing cell was `review`, while reader-facing text called the
  aggregate evidence confident;
- exact warning references and combined finding/candidate IDs were duplicated;
- the report serialized only the deprecated `experimental` flag;
- combined stage reports omitted preparation, failure, runtime, pinned-data,
  and full profile-policy provenance;
- a restarted report converted external ROSZ paths to nonexistent basenames.

The verified schema-v3 report now separates quantitative
`coverageCompleteness` from `evidenceConfidence`, includes
`executionMode: simulate`, deduplicates IDs/warnings, carries stage metadata,
and records the frozen full policy hash. Restarted runs copy and verify source
and enriched ROSZ files under `artifacts/sha256/<digest>/` before writing the
new manifest or report.

The portability regression deletes the source run and then resumes from the
restarted bundle with no redelivery. A later full-suite resume check also
exposed an outer in-memory delivery memo that still held pre-bundle paths.
That memo is now cleared immediately after materialization, so fresh runs and
resumed runs write the same verified receipt paths.

## Verified artifacts

The authoritative acceptance bundle is:

`exports/death-guard-vs-unknown-orks-acceptance-2026-07-29-verified/`

Key files:

- `Death-Guard-1000-vs-Orks-vs-orks-stress-test.html`
- `Death-Guard-1000-vs-Orks-vs-orks-stress-test.json`
- `stress-manifest.json`
- `artifacts/sha256/` containing eight verified source/enriched ROSZ files

Final hashes:

- JSON:
  `13ba7c5024ae98693909debd8804f5142fb44388813736b0af4aa9ee383b445e`
- HTML:
  `bdb666e38539152d328d01ecabf2e253a5cfdf950bc1b6b2d6926895f665e7d0`
- Frozen full profile policy:
  `82e1bf62ed40babb348dc928407cd954722e7e91aee389dd0bbc2ed7f74cdf4b`

All serialized ROSZ references resolve. Every content-addressed file hash and
both final report hashes were independently recomputed and matched.

## Remaining issue ledger

### P1 — Runtime provenance is not yet end-to-end in the report

The run preflight verified local agent `1.6.0`, protocol `7`, matching build
identity, and no source drift. The written report records the CLI runtime
fingerprint but still omits the separate local-agent protocol/build identity
and Tessera UI version. These should be frozen into the manifest/report, not
left only in command output.

### P1 — Live freshness provenance is still null

Pinned package, BSData commit, catalogue revisions, official MFM version, and
content hash are frozen. `cachedLiveUpdateCheck` remains `null`. The data check
passes for the acceptance roster, but the broader catalogue reports 2,155
blocking mapping conflicts. Successful selected-unit export must not be
misread as complete catalogue coverage.

### P1 — Legacy and scenario matrix surfaces disagree

Quick screening child reports retain populated trusted `simulation.scenarios`
while the legacy `simulation.matrices[*].cells` arrays are empty. Current
stress analysis uses the scenario evidence correctly, but consumers can read
the empty legacy surface and draw the wrong conclusion. The field should be
deprecated explicitly or populated from a defined canonical scenario.

### P2 — Bundle relocation is only partially portable

The top JSON uses relative content-addressed references and the bundle is
self-contained after its source run is deleted. Manifest and child-report
receipts remain absolute paths within the bundle, so moving the entire folder
can break resume even though inspection still works. A future schema should
resolve all paths relative to the manifest.

### P2 — Artifact inventory is incomplete

The report references the materialized rosters, but its top artifact array
lists only final JSON, HTML, and manifest. Child reports, profile policy, and
content-addressed ROSZ files should also have explicit descriptors and hashes.

### P2 — Mutation history is invocation-level

Current counters truthfully describe the invocation, but receipts do not yet
carry a durable mutation event ID/time and origin such as
`new-remote`, `persistent-cache`, `manifest-reuse`, or `in-memory`. The eight
early remote mutations therefore remain a postmortem reconstruction rather
than machine-auditable cumulative history.

### P2 — Tessera saved-list cleanup remains manual

Repeated browser attempts can leave saved Tessera imports. The connector does
not inventory these with stable IDs or provide a reviewed cleanup workflow.
No remote New Recruit or Tessera list was automatically deleted.

### P2 — Analytical heuristics need faction calibration

Mission readiness treats deep strike, Scouts, Fly, and movement speed as one
broad reach signal, which can make slow-but-projectable units appear “fast.”
The Ork proxy tags and Death Guard reach labels should be calibrated before
they influence automatic changes. They remain separate from Tessera evidence
in this run.

## Acceptance checkpoint

The live workflow is accepted for this frozen Death Guard-versus-Orks case:

- legal 1,000-point player roster;
- three distinct, exportable Ork proxy postures;
- no new New Recruit mutations on the final retries;
- exact Tessera selector and phase recomputation checks;
- 48 trusted matrices and 24/24 distinct phase pairs;
- hard-constraint-safe candidates only;
- truthful review-grade evidence labeling;
- self-contained, hash-verified ROSZ/report bundle.

The remaining items above are tracked limitations, not reasons to reinterpret
this result as a simulated game winner.
