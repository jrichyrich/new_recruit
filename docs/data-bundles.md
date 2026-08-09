# Data bundles

RosterPilot treats roster rules as immutable operation inputs.

A `DataBundleProvider` owns the active snapshot. Every data-consuming service call acquires one lease before research, building, modification, export, matchup, or stress work. The lease is released after the operation finishes. Refresh and rollback change only the snapshot offered to future leases.

## Identity

Keep these identities separate:

- raw source provenance for Games Workshop, 40kdc, and BSData;
- semantic roster rules;
- faction rules;
- New Recruit mappings;
- stress-portfolio inputs.

A provenance-only source change may preserve semantic identities. A rule or mapping change must alter the relevant semantic hash. Do not use global release-ID equality as a compatibility shortcut.

Stored roster V4 envelopes retain the roster's bundle ID and semantic identities. Legacy V1–V3 roster documents are accepted only at import boundaries and migrated before storage.

## Updates

Local installations support daily checks and explicit `run sync`. The updater builds and verifies a candidate outside the active snapshot, then atomically activates it. Failed or quarantined candidates do not mutate the current checkout or active lease.

A durable Tessera or upload workflow uses the exact roster and bundle reference it started with. If the current snapshot is incompatible, the workflow fails closed and requires a new operation or an explicit reviewed rebase.

Generated source material is runtime state, not routine tracked application output. Never rewrite tracked generated data during normal refresh. Never put credentials, browser profiles, signing material, or transient exports in the repository.
